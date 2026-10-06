/**
 * Motor de ingestao Mercado Livre — DESCOBERTA por `date_closed`, por FATIA.
 *
 *   para cada dia civil (Sao Paulo) da janela FECHADA ainda nao concluido:
 *     varredura homologada do dia (transporte) → recorte do dia + dedup
 *     (normalizar.ts, regra do servico canonico) → upsert ml_pedidos →
 *     checkpoint (dia concluido) em sync_jobs
 *   todos os dias concluidos → status concluido + listagem_completa=true
 *
 * Resumivel: o checkpoint guarda os dias concluidos; a proxima fatia so le
 * os que faltam. Idempotente: upsert pela PK (loja_id, order_id).
 * Dia incompleto ou erro transitorio NUNCA vira "fim": a fatia pausa e o
 * dia e relido depois (ate `maxTentativasPorDia`, entao erro). Erro de
 * conta/credencial e permanente → job em erro.
 *
 * DESCOBERTA ≠ REFRESH. `date_closed` define QUEM pertence a janela
 * (populacao imutavel apos o fechamento — provada empiricamente no
 * ML-CORPUS-C2). Manter cancel_detail/status atuais e REFRESH: hoje, so
 * relendo a propria janela fechada (este mesmo motor, upsert do mesmo
 * order_id). Filtro por last_updated NAO existe no repo e nao foi provado
 * live — nao e usado aqui.
 *
 * Fica atras de ENABLE_ASYNC_SYNC_JOBS (padrao OFF), como o motor Shopee.
 */
import { ASYNC_SYNC_JOBS_ENABLED } from "@/lib/feature-flags";
import type { ErroVendasML } from "@/lib/mercado-livre-vendas";
import { CANCELAMENTO_DE_PACOTE_REFEITO } from "@/lib/vendas/canonico/ml";
import { diasDaJanela, limitesDaJanela } from "./janelas";
import { linhasDoDia } from "./normalizar";
import type { CheckpointML, JobML, ProgressoML, RelogioML, RepositorioML, TransporteML } from "./tipos";

export interface OpcoesMotorML {
  /** Instante (epoch ms) ate o qual a fatia pode trabalhar. */
  prazoMs: number;
  margemMs?: number;
  /** Fatias em que um dia pode falhar (incompleto/transitorio) antes de virar erro. */
  maxTentativasPorDia?: number;
  /** Sobrescreve a feature flag (testes / execucao controlada). */
  habilitado?: boolean;
}

export const PADROES_ML = { margemMs: 8_000, maxTentativasPorDia: 3 };

export type ResultadoFatiaML =
  | { estado: "desabilitado" }
  | { estado: "pausado" | "concluido" | "falhou"; motivo?: string; checkpoint: CheckpointML; progresso: ProgressoML };

/** Erros de conta/credencial/entrada: reler nao resolve. */
const PERMANENTES: ReadonlySet<ErroVendasML> = new Set(["credencial_ausente", "nao_autorizado", "resposta_invalida", "periodo_nao_entendido"]);

export function checkpointInicialML(): CheckpointML { return { versao: 1, diasConcluidos: [], tentativas: {}, iniciadoEm: null }; }
export function progressoInicialML(dias: number): ProgressoML {
  return { dias, diasConcluidos: 0, paginas: 0, recebidos: 0, listados: 0, gravados: 0, pack_splitted: 0, ultimo_erro: null };
}

export async function executarFatiaML(
  job: JobML,
  deps: { transporte: TransporteML; repo: RepositorioML; relogio: RelogioML },
  opcoes: OpcoesMotorML,
): Promise<ResultadoFatiaML> {
  if (!(opcoes.habilitado ?? ASYNC_SYNC_JOBS_ENABLED)) return { estado: "desabilitado" };
  const o = { ...PADROES_ML, ...opcoes };
  const { transporte, repo, relogio } = deps;
  const dias = diasDaJanela(job.de, job.ate);
  const ck: CheckpointML = job.checkpoint ? structuredClone(job.checkpoint) : checkpointInicialML();
  const pr: ProgressoML = job.progresso ? structuredClone(job.progresso) : progressoInicialML(dias.length);
  const dono = { id: job.id, userId: job.userId, lojaId: job.lojaId };
  const salvar = (extra: { status?: "rodando" | "concluido" | "erro"; listagemCompleta?: boolean; erroMensagem?: string | null } = {}) =>
    repo.salvarJob(dono, { checkpoint: ck, progresso: pr, ...extra });
  const falhar = async (motivo: string) => {
    pr.ultimo_erro = motivo;
    await salvar({ status: "erro", listagemCompleta: false, erroMensagem: motivo });
    return { estado: "falhou" as const, motivo, checkpoint: ck, progresso: pr };
  };
  const pausar = async (motivo: string) => {
    await salvar({ status: "rodando", listagemCompleta: false });
    return { estado: "pausado" as const, motivo, checkpoint: ck, progresso: pr };
  };
  const cabe = () => relogio.agoraMs() + o.margemMs < o.prazoMs;

  // ── dono, janela valida e FECHADA ──
  if (!(await repo.lojaDoDono(job.userId, job.lojaId))) return falhar("loja_invalida");
  const lim = limitesDaJanela(job.de, job.ate);
  if (!lim || dias.length === 0) return falhar("janela_invalida");
  if (lim.fim.getTime() > relogio.agoraMs()) return falhar("janela_nao_fechada");
  if (ck.iniciadoEm === null) { ck.iniciadoEm = new Date(relogio.agoraMs()).toISOString(); await salvar({ status: "rodando", listagemCompleta: false }); }

  for (const dia of dias) {
    if (ck.diasConcluidos.includes(dia)) continue;
    if (!cabe()) return pausar("prazo");
    const r = await transporte.listarDiaFechado({ userId: job.userId, lojaId: job.lojaId, dia });
    if (r.erro !== null && PERMANENTES.has(r.erro)) return falhar(`listagem:${dia}:${r.erro}`);
    if (r.erro !== null || !r.completa) {
      const motivo = `listagem:${dia}:${r.erro ?? "dia_incompleto"}`;
      ck.tentativas[dia] = (ck.tentativas[dia] ?? 0) + 1;
      pr.ultimo_erro = motivo;
      if (ck.tentativas[dia] >= o.maxTentativasPorDia) return falhar(motivo);
      return pausar(motivo);
    }
    const agoraIso = new Date(relogio.agoraMs()).toISOString();
    const { linhas } = linhasDoDia(r.brutos, { userId: job.userId, lojaId: job.lojaId, dia, agoraIso });
    const { novas } = await repo.gravarPedidos(job.userId, job.lojaId, linhas);
    ck.diasConcluidos.push(dia); delete ck.tentativas[dia];
    pr.diasConcluidos = ck.diasConcluidos.length; pr.paginas += r.paginas; pr.recebidos += r.brutos.length;
    pr.listados += linhas.length; pr.gravados += novas;
    pr.pack_splitted += linhas.filter((l) => l.cancel_detail_code === CANCELAMENTO_DE_PACOTE_REFEITO).length;
    await salvar({ status: "rodando", listagemCompleta: false });
  }
  pr.ultimo_erro = null;
  await salvar({ status: "concluido", listagemCompleta: true, erroMensagem: null });
  return { estado: "concluido", checkpoint: ck, progresso: pr };
}
