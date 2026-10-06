/**
 * Coordenador canonico de vendas (SALES-SYNC-A) — I/O.
 *
 *   avaliarNecessidadeDeSync: le lojas ATIVAS do dono (por marketplace,
 *     dinamicamente), os sync_jobs dessas lojas e os sinais de estado da
 *     Shopee (contagens), e devolve o plano puro (planejamento.ts).
 *   garantirProximosJobs: cria, por loja, NO MAXIMO o proximo job do
 *     plano. O banco ja impoe UM job ativo por loja
 *     (idx_sync_jobs_loja_ativo, UNIQUE loja_id WHERE pendente|rodando):
 *     cinco pedidos do mesmo periodo nao criam cinco jobs, e uma corrida
 *     entre dois pedidos vira 23505 (tratado como "ja existe").
 *
 * Respeita ENABLE_ASYNC_SYNC_JOBS (padrao OFF): desligado, so avalia.
 * Nao calcula valor e nao executa motor — quem executa e o worker.
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ASYNC_SYNC_JOBS_ENABLED } from "@/lib/feature-flags";
import { criarJobFechamentoML } from "@/lib/mercado-livre/ingestao/persistencia";
import { limitesDaJanela } from "@/lib/mercado-livre/ingestao/janelas";
import { contarEscrowPendenteShopee, contarNaoPagosSemObservacaoShopee, LIMITE_POLITICA_PAGAMENTO_MS } from "@/lib/vendas/canonico/shopee";
import { agregarEstados, planejarLoja } from "./planejamento";
import type { JobExistenteSync, JobPlanejado, LojaAtivaSync, MarketplaceSync, PoliticaSync, ResultadoSync, SinaisShopeeSync } from "./tipos";

export async function avaliarNecessidadeDeSync(
  cliente: SupabaseClient,
  args: { userId: string; marketplace: MarketplaceSync | "TODOS"; lojaId?: string; de: string; ate: string },
  opcoes: { agoraMs: number; politica: PoliticaSync },
): Promise<ResultadoSync> {
  const { userId } = args;
  if (!userId) throw new Error("user_id_ausente");
  let q = cliente.from("lojas").select("id, marketplace").eq("user_id", userId).eq("ativo", true);
  q = args.marketplace === "TODOS" ? q.in("marketplace", ["ML", "Shopee"]) : q.eq("marketplace", args.marketplace);
  if (args.lojaId) q = q.eq("id", args.lojaId);
  const { data: lojasRaw, error } = await q;
  if (error) throw new Error("leitura_falhou");
  const lojas = ((lojasRaw ?? []) as { id: string; marketplace: string }[])
    .filter((l) => l.marketplace === "ML" || l.marketplace === "Shopee") as LojaAtivaSync[];
  if (args.lojaId && !lojas.some((l) => l.id === args.lojaId)) throw new Error("loja_invalida");

  const jobs: JobExistenteSync[] = [];
  if (lojas.length) {
    const { data, error: e2 } = await cliente.from("sync_jobs")
      .select("id, loja_id, marketplace, campo_tempo, janela_inicio, janela_fim, status, listagem_completa, concluido_em, criado_em")
      .eq("user_id", userId).in("loja_id", lojas.map((l) => l.id));
    if (e2) throw new Error("leitura_falhou");
    for (const r of (data ?? []) as Record<string, any>[]) jobs.push({ id: r.id, lojaId: r.loja_id, marketplace: r.marketplace, campoTempo: r.campo_tempo ?? null,
      janelaInicio: r.janela_inicio ?? null, janelaFim: r.janela_fim ?? null, status: r.status, listagemCompleta: r.listagem_completa ?? null,
      concluidoEm: r.concluido_em ?? null, criadoEm: r.criado_em });
  }

  const resultados = [];
  for (const loja of lojas) {
    let sinaisShopee: SinaisShopeeSync | undefined;
    if (loja.marketplace === "Shopee") sinaisShopee = await sinaisShopeeDaLoja(cliente, userId, loja.id, args.de, args.ate);
    resultados.push(planejarLoja({ loja, de: args.de, ate: args.ate, agoraMs: opcoes.agoraMs, jobs, sinaisShopee, politica: opcoes.politica }));
  }
  return { estado: agregarEstados(resultados.map((r) => r.estado)), lojas: resultados };
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
 * Cria, por loja, o PROXIMO job do plano (o mais urgente). Lojas com job
 * ativo (de qualquer tipo, inclusive legado) ficam aguardando — o indice
 * unico por loja garante isso tambem no banco.
 */
export async function garantirProximosJobs(
  cliente: SupabaseClient, userId: string, plano: ResultadoSync, opcoes: { habilitado?: boolean } = {},
): Promise<{ desabilitado: boolean; criados: { lojaId: string; chave: string; jobId: string }[]; aguardando: string[] }> {
  if (!(opcoes.habilitado ?? ASYNC_SYNC_JOBS_ENABLED)) return { desabilitado: true, criados: [], aguardando: [] };
  const criados: { lojaId: string; chave: string; jobId: string }[] = []; const aguardando: string[] = [];
  for (const loja of plano.lojas) {
    const proximo = loja.jobsNecessarios[0];
    if (!proximo) continue;
    if (loja.jobsEmAndamento.length) { aguardando.push(loja.lojaId); continue; }
    const r = await criarJob(cliente, userId, proximo);
    if (r === null) aguardando.push(loja.lojaId); else criados.push({ lojaId: loja.lojaId, chave: proximo.chave, jobId: r });
  }
  return { desabilitado: false, criados, aguardando };
}

/** Insere o job (dono vem do chamador, nunca do plano). null = ja ha job ativo na loja (23505). */
async function criarJob(cliente: SupabaseClient, userId: string, j: JobPlanejado): Promise<string | null> {
  try {
    if (j.marketplace === "ML") return await criarJobFechamentoML(cliente, { userId, lojaId: j.lojaId, de: j.de, ate: j.ate });
    const linha: Record<string, unknown> = { user_id: userId, loja_id: j.lojaId, marketplace: "Shopee", status: "pendente", date_from: j.de, date_to: j.ate,
      tipo: j.proposito === "catchup_escrow" ? "incremental" : "backfill", campo_tempo: j.campoTempo, janela_inicio: j.inicio, janela_fim: j.fim,
      listagem_completa: j.campoTempo === null ? null : false };
    const { data, error } = await cliente.from("sync_jobs").insert(linha).select("id").single();
    if (error) { if ((error as { code?: string }).code === "23505") return null; throw new Error(`criar_job:${error.message}`); }
    return (data as { id: string }).id;
  } catch (e: any) {
    if (/23505|duplicate key|idx_sync_jobs_loja_ativo/.test(String(e?.message ?? e))) return null;
    throw e;
  }
}
