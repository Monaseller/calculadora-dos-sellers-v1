/**
 * Coordenador canonico de vendas — I/O (SALES-SYNC-A1).
 *
 *   avaliarNecessidadeDeSync: le lojas ATIVAS do dono (por marketplace,
 *     dinamicamente), os sync_jobs dessas lojas e os sinais de estado da
 *     Shopee (contagens do servico canonico) e devolve a avaliacao pura:
 *     cobertura, frescor, definitivo e a proxima acao de cada loja.
 *   garantirProximaAcao: executa SO a proxima acao de cada loja (cria no
 *     maximo um job por loja). O banco impoe um job ativo por loja
 *     (idx_sync_jobs_loja_ativo): corrida = 23505 = "outro ja ganhou",
 *     nunca erro para o usuario.
 *
 * Respeita ENABLE_ASYNC_SYNC_JOBS (padrao OFF): desligado, so avalia.
 * Nao calcula valor e nao executa motor — quem executa e o worker.
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ASYNC_SYNC_JOBS_ENABLED } from "@/lib/feature-flags";
import { criarJobFechamentoML } from "@/lib/mercado-livre/ingestao/persistencia";
import { limitesDaJanela } from "@/lib/mercado-livre/ingestao/janelas";
import { checkpointCatchUpInicial } from "@/lib/shopee/ingestao/motor";
import { contarEscrowPendenteShopee, contarNaoPagosSemObservacaoShopee, LIMITE_POLITICA_PAGAMENTO_MS } from "@/lib/vendas/canonico/shopee";
import { ehJobIntraday } from "./intraday";
import { agregar, avaliarLoja, proximaAcaoCombinada } from "./planejamento";
import type {
  AvaliacaoLojaSync, AvaliacaoSync, JobExistenteSync, JobPlanejado, LojaAtivaSync, MarketplaceSync, OrigemPedido, PoliticaSync, ProximaAcao, SinaisShopeeSync,
} from "./tipos";
// P1: a MESMA leitura paginada de sync_jobs dos leitores canonicos (keyset por id, fim so na pagina vazia, falha fechada)
import { lerJanelasSyncJobs } from "@/lib/vendas/canonico/shopee";
// P1-B: as faixas dos nao pagos pendentes saem da MESMA populacao da contagem canonica (listagem do proprio canonico)
import { listarCandidatosNaoPagosPorPrazoShopee, listarNaoPagosSemObservacaoShopee } from "@/lib/vendas/canonico/shopee";
import { diaEmSaoPaulo } from "@/lib/fuso-sao-paulo";

export async function lerJobsDasLojas(cliente: SupabaseClient, userId: string, lojaIds: string[]): Promise<JobExistenteSync[]> {
  if (!lojaIds.length) return [];
  // P1: TODOS os jobs, paginados por id — a leitura unica era cortada em 1000 linhas pelo PostgREST (sem erro) e o
  // planejamento via buraco de cobertura onde nao havia. Pagina com erro → leitura_falhou: nenhuma decisao com conjunto parcial.
  const data = await lerJanelasSyncJobs<Record<string, any>>("coordenador_jobs", (apos, limite) => {
    let q = cliente.from("sync_jobs")
      .select("id, loja_id, marketplace, campo_tempo, janela_inicio, janela_fim, status, listagem_completa, concluido_em, criado_em, tipo, date_from, date_to, modo:checkpoint->>modo, listados:progresso->>listados, escrows:progresso->>escrow_necessarios")
      .eq("user_id", userId).in("loja_id", lojaIds);
    if (apos !== null) q = q.gt("id", apos);
    return q.order("id", { ascending: true }).limit(limite);
  });
  return data.map((r) => ({ id: r.id, lojaId: r.loja_id, marketplace: r.marketplace, campoTempo: r.campo_tempo ?? null,
    janelaInicio: r.janela_inicio ?? null, janelaFim: r.janela_fim ?? null, status: r.status, listagemCompleta: r.listagem_completa ?? null,
    concluidoEm: r.concluido_em ?? null, criadoEm: r.criado_em,
    catchup: r.campo_tempo == null && r.janela_inicio == null && r.modo === "escrow_catchup",
    // D15B: so para classificar intraday (ehJobIntraday)
    tipo: r.tipo ?? null, dateFrom: r.date_from ?? null, dateTo: r.date_to ?? null,
    // E2.1: contadores medidos do job (texto do ->>) — so estimativa de tamanho; invalido → null (desconhecido)
    listados: contador(r.listados), escrowsNecessarios: contador(r.escrows) }));
}

/** E2.1: inteiro >= 0 de um campo `progresso->>x`; qualquer outra coisa → null (desconhecido, nunca 0). */
function contador(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

export async function avaliarNecessidadeDeSync(
  cliente: SupabaseClient,
  args: { userId: string; marketplace: MarketplaceSync | "TODOS"; lojaId?: string; de: string; ate: string; origem: OrigemPedido },
  // listarPendentes (P1-B): ler as LINHAS dos nao pagos pendentes para mirar o refresh. Padrao: so fora de pedido do
  // usuario (o tick, que planeja). A frescura do Dashboard (usuario, so leitura) usa so a contagem canonica.
  opcoes: { agoraMs: number; politica: PoliticaSync; listarPendentes?: boolean },
): Promise<AvaliacaoSync> {
  const { userId } = args;
  if (!userId) throw new Error("user_id_ausente");
  let q = cliente.from("lojas").select("id, marketplace").eq("user_id", userId).eq("ativo", true);
  q = args.marketplace === "TODOS" ? q.in("marketplace", ["ML", "Shopee"]) : q.eq("marketplace", args.marketplace);
  if (args.lojaId) q = q.eq("id", args.lojaId);
  const { data: lojasRaw, error } = await q;
  if (error) throw new Error("leitura_falhou");
  const lojas = ((lojasRaw ?? []) as { id: string; marketplace: string }[]).filter((l) => l.marketplace === "ML" || l.marketplace === "Shopee") as LojaAtivaSync[];
  if (args.lojaId && !lojas.some((l) => l.id === args.lojaId)) throw new Error("loja_invalida");
  const jobs = await lerJobsDasLojas(cliente, userId, lojas.map((l) => l.id));
  const avaliacoes: AvaliacaoLojaSync[] = [];
  for (const loja of lojas) {
    const sinaisShopee = loja.marketplace === "Shopee"
      ? await sinaisShopeeDaLoja(cliente, userId, loja.id, args.de, args.ate, args.origem, opcoes.listarPendentes ?? args.origem !== "usuario") : undefined;
    avaliacoes.push(avaliarLoja({ loja, de: args.de, ate: args.ate, agoraMs: opcoes.agoraMs, jobs, sinaisShopee, politica: opcoes.politica, origem: args.origem }));
  }
  return agregar(avaliacoes);
}

/**
 * Sinais de estado da Shopee — escrow pela MESMA contagem do leitor canonico; nao pagos (P1-B) com as faixas de
 * criacao dos pendentes, que o planejador usa como ALVO do refresh.
 *   pedido do USUARIO  pendente = a definicao canonica (nunca detalhado OU detalhe antes do fim do periodo) e a
 *                      contagem e a propria contarNaoPagosSemObservacaoShopee — revalidacao explicita intacta.
 *   background/bootstrap (AGENDAMENTO) pendente = nunca detalhado OU detalhe antes de min(fim do periodo, criacao +
 *                      prazo publicado de pagamento). Os 10 dias sao criterio de agendamento, NAO prova de estado final:
 *                      um pedido visto depois do prazo deixa de motivar ESTE sinal, mas continua sendo relido pelo
 *                      frescor por idade (6 h / 24 h / 7 dias) enquanto estiver na janela de manutencao.
 * Leituras (desempenho, mesmo resultado):
 *   usuario            a contagem canonica (HEAD) — a MESMA de antes; linhas so com `listar` explicito (planejador).
 *   background         UMA consulta de candidatos (superconjunto exato do criterio do prazo; resposta cheia → a
 *                      listagem completa paginada) e o filtro exato aqui. Sem a contagem HEAD (o total sai das linhas).
 */
async function sinaisShopeeDaLoja(cliente: SupabaseClient, userId: string, lojaId: string, de: string, ate: string, origem: OrigemPedido, listar: boolean): Promise<SinaisShopeeSync> {
  const l = limitesDaJanela(de, ate);
  if (!l) throw new Error("periodo_invalido");
  const inicioIso = l.inicio.toISOString(), fimIso = l.fim.toISOString();
  const desdeIso = new Date(l.inicio.getTime() - LIMITE_POLITICA_PAGAMENTO_MS).toISOString();
  const a = { userId, lojaId, desdeIso, fimIso };
  let naoObservados: number, faixas: SinaisShopeeSync["faixasPendentes"];
  if (origem === "usuario") {
    naoObservados = await contarNaoPagosSemObservacaoShopee(cliente, a);
    faixas = listar && naoObservados > 0 ? (await naoPagosPendentesShopee(await listarNaoPagosSemObservacaoShopee(cliente, a), fimIso, false)).faixas : undefined;
  } else {
    const pend = listar
      ? await naoPagosPendentesShopee(await listarCandidatosNaoPagosPorPrazoShopee(cliente, { ...a, prazoMs: LIMITE_POLITICA_PAGAMENTO_MS }), fimIso, true)
      : null;
    // sem listar (chamador que so avalia): o criterio do prazo nao tem contagem propria → a canonica, que o contem
    naoObservados = pend ? pend.total : await contarNaoPagosSemObservacaoShopee(cliente, a);
    faixas = pend?.faixas;
  }
  return {
    escrowPendentes: await contarEscrowPendenteShopee(cliente, { userId, lojaId, inicioIso, fimIso }),
    naoObservadosAposPeriodo: naoObservados,
    faixasPendentes: faixas,
  };
}

/**
 * P1-B: os nao pagos pendentes (criterio exato) e as faixas de CRIACAO deles (dias civis de SP contiguos), a partir de
 * linhas da populacao canonica (listagem completa ou candidatos — ambos o contem). Erro de leitura ja lancou antes.
 */
function naoPagosPendentesShopee(linhas: { orderSn: string; createTime: string | null; detailFetchedAt: string | null }[], fimIso: string, prazo: boolean):
  { total: number; faixas: { inicio: string; fim: string; ultimaObservacao: string | null }[] } {
  const fim = Date.parse(fimIso);
  const pendentes = linhas.filter((r) => {
    if (r.detailFetchedAt === null) return true;                                                      // nunca observado
    const obs = Date.parse(r.detailFetchedAt), criado = r.createTime ? Date.parse(r.createTime) : NaN;
    if (!Number.isFinite(obs) || !Number.isFinite(criado)) return true;                               // sem prova → pendente
    return prazo ? obs < Math.min(fim, criado + LIMITE_POLITICA_PAGAMENTO_MS) : obs < fim;
  });
  // agrupa por dia civil de SP e junta dias contiguos
  const porDia = new Map<string, number>();
  for (const r of pendentes) {
    const dia = diaEmSaoPaulo(r.createTime); if (!dia) continue;
    const obs = r.detailFetchedAt ? Date.parse(r.detailFetchedAt) : -Infinity;
    porDia.set(dia, Math.max(porDia.get(dia) ?? -Infinity, Number.isFinite(obs) ? obs : -Infinity));
  }
  const dias = [...porDia.keys()].sort();
  const faixas: { inicio: string; fim: string; ultimaObservacao: string | null }[] = [];
  for (const dia of dias) {
    const lim = limitesDaJanela(dia, dia)!;
    const u = faixas[faixas.length - 1];
    const obs = porDia.get(dia)!;
    if (u && u.fim === lim.inicio.toISOString()) {
      u.fim = lim.fim.toISOString();
      const atual = u.ultimaObservacao ? Date.parse(u.ultimaObservacao) : -Infinity;
      if (obs > atual) u.ultimaObservacao = new Date(obs).toISOString();
    } else faixas.push({ inicio: lim.inicio.toISOString(), fim: lim.fim.toISOString(), ultimaObservacao: Number.isFinite(obs) ? new Date(obs).toISOString() : null });
  }
  return { total: pendentes.length, faixas };
}

/**
 * Executa a PROXIMA acao de cada loja combinando todas as avaliacoes
 * recebidas (ex.: pedido do usuario + backfill): cria no maximo UM job por
 * loja. Job ativo nunca e cancelado; 23505 = outro pedido ganhou a vaga.
 */
export async function garantirProximaAcao(
  cliente: SupabaseClient, userId: string, avaliacoes: AvaliacaoSync[], opcoes: { habilitado?: boolean } = {},
): Promise<{ desabilitado: boolean; criados: { lojaId: string; chave: string; jobId: string; acao: ProximaAcao["acao"] }[]; aguardando: { lojaId: string; acao: string }[] }> {
  if (!(opcoes.habilitado ?? ASYNC_SYNC_JOBS_ENABLED)) return { desabilitado: true, criados: [], aguardando: [] };
  const porLoja = new Map<string, AvaliacaoLojaSync[]>();
  for (const a of avaliacoes.flatMap((x) => x.lojas)) (porLoja.get(a.lojaId) ?? porLoja.set(a.lojaId, []).get(a.lojaId)!).push(a);
  const jobs = await lerJobsDasLojas(cliente, userId, [...porLoja.keys()]);
  const criados: { lojaId: string; chave: string; jobId: string; acao: ProximaAcao["acao"] }[] = []; const aguardando: { lojaId: string; acao: string }[] = [];
  for (const [lojaId, avs] of porLoja) {
    const acao = proximaAcaoCombinada(avs, jobs);
    if (acao.acao !== "CREATE_DISCOVERY_JOB" && acao.acao !== "CREATE_REFRESH_JOB") { if (acao.acao !== "NOOP") aguardando.push({ lojaId, acao: acao.acao }); continue; }
    const id = await criarJob(cliente, userId, acao.job);
    if (id === null) aguardando.push({ lojaId, acao: "WAIT_ACTIVE_JOB" });
    else criados.push({ lojaId, chave: acao.job.chave, jobId: id, acao: acao.acao });
  }
  return { desabilitado: false, criados, aguardando };
}

/** Insere o job (dono vem do chamador, nunca do plano). null = ja ha job ativo na loja (23505). */
async function criarJob(cliente: SupabaseClient, userId: string, j: JobPlanejado): Promise<string | null> {
  try {
    if (j.proposito === "intraday") {
      // D15B: tipo 'incremental' + janela de UM dia civil = intraday (ehJobIntraday). Fail-closed: so insere o que o classificador reconhece.
      const linha = { user_id: userId, loja_id: j.lojaId, marketplace: j.marketplace, status: "pendente", date_from: j.de, date_to: j.ate,
        tipo: "incremental", campo_tempo: j.campoTempo, janela_inicio: j.inicio, janela_fim: j.fim, listagem_completa: false };
      if (!ehJobIntraday({ tipo: linha.tipo, campoTempo: linha.campo_tempo, janelaInicio: linha.janela_inicio, janelaFim: linha.janela_fim, dateFrom: linha.date_from, dateTo: linha.date_to })) {
        throw new Error("criar_job:intraday_invalido");
      }
      const { data, error } = await cliente.from("sync_jobs").insert(linha).select("id").single();
      if (error) { if ((error as { code?: string }).code === "23505") return null; throw new Error(`criar_job:${error.message}`); }
      return (data as { id: string }).id;
    }
    if (j.marketplace === "ML") return await criarJobFechamentoML(cliente, { userId, lojaId: j.lojaId, de: j.de, ate: j.ate });
    const catchup = j.proposito === "catchup_escrow";
    const linha: Record<string, unknown> = { user_id: userId, loja_id: j.lojaId, marketplace: "Shopee", status: "pendente", date_from: j.de, date_to: j.ate,
      tipo: catchup ? "incremental" : "backfill", campo_tempo: j.campoTempo, janela_inicio: j.inicio, janela_fim: j.fim,
      listagem_completa: catchup ? null : false,
      // o catch-up nasce com o checkpoint do PROPRIO motor (modo escrow_catchup): e o que o
      // distingue de um job legado (campo/janela/checkpoint NULL) — ver worker-contrato.ts
      ...(catchup ? { checkpoint: checkpointCatchUpInicial() } : {}) };
    const { data, error } = await cliente.from("sync_jobs").insert(linha).select("id").single();
    if (error) { if ((error as { code?: string }).code === "23505") return null; throw new Error(`criar_job:${error.message}`); }
    return (data as { id: string }).id;
  } catch (e: any) {
    if (/23505|duplicate key|idx_sync_jobs_loja_ativo/.test(String(e?.message ?? e))) return null;
    throw e;
  }
}
