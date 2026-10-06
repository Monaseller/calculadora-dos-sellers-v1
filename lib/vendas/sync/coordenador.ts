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
import { agregar, avaliarLoja, proximaAcaoCombinada } from "./planejamento";
import type {
  AvaliacaoLojaSync, AvaliacaoSync, JobExistenteSync, JobPlanejado, LojaAtivaSync, MarketplaceSync, OrigemPedido, PoliticaSync, ProximaAcao, SinaisShopeeSync,
} from "./tipos";

export async function lerJobsDasLojas(cliente: SupabaseClient, userId: string, lojaIds: string[]): Promise<JobExistenteSync[]> {
  if (!lojaIds.length) return [];
  const { data, error } = await cliente.from("sync_jobs")
    .select("id, loja_id, marketplace, campo_tempo, janela_inicio, janela_fim, status, listagem_completa, concluido_em, criado_em, modo:checkpoint->>modo")
    .eq("user_id", userId).in("loja_id", lojaIds);
  if (error) throw new Error("leitura_falhou");
  return ((data ?? []) as Record<string, any>[]).map((r) => ({ id: r.id, lojaId: r.loja_id, marketplace: r.marketplace, campoTempo: r.campo_tempo ?? null,
    janelaInicio: r.janela_inicio ?? null, janelaFim: r.janela_fim ?? null, status: r.status, listagemCompleta: r.listagem_completa ?? null,
    concluidoEm: r.concluido_em ?? null, criadoEm: r.criado_em,
    catchup: r.campo_tempo == null && r.janela_inicio == null && r.modo === "escrow_catchup" }));
}

export async function avaliarNecessidadeDeSync(
  cliente: SupabaseClient,
  args: { userId: string; marketplace: MarketplaceSync | "TODOS"; lojaId?: string; de: string; ate: string; origem: OrigemPedido },
  opcoes: { agoraMs: number; politica: PoliticaSync },
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
    const sinaisShopee = loja.marketplace === "Shopee" ? await sinaisShopeeDaLoja(cliente, userId, loja.id, args.de, args.ate) : undefined;
    avaliacoes.push(avaliarLoja({ loja, de: args.de, ate: args.ate, agoraMs: opcoes.agoraMs, jobs, sinaisShopee, politica: opcoes.politica, origem: args.origem }));
  }
  return agregar(avaliacoes);
}

/** Sinais de estado da Shopee — as MESMAS contagens do leitor canonico (dimensoes B e C), sem valores. */
async function sinaisShopeeDaLoja(cliente: SupabaseClient, userId: string, lojaId: string, de: string, ate: string): Promise<SinaisShopeeSync> {
  const l = limitesDaJanela(de, ate);
  if (!l) throw new Error("periodo_invalido");
  const inicioIso = l.inicio.toISOString(), fimIso = l.fim.toISOString();
  const desdeIso = new Date(l.inicio.getTime() - LIMITE_POLITICA_PAGAMENTO_MS).toISOString();
  return {
    escrowPendentes: await contarEscrowPendenteShopee(cliente, { userId, lojaId, inicioIso, fimIso }),
    naoObservadosAposPeriodo: await contarNaoPagosSemObservacaoShopee(cliente, { userId, lojaId, desdeIso, fimIso }),
  };
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
