/**
 * TICK do coordenador canonico de vendas (SALES-SYNC-D1) — ORQUESTRA, nao decide.
 *
 * Uma invocacao percorre TODAS as lojas ativas ML/Shopee do sistema
 * (descobertas no banco, nada fixo) e, para cada uma, pergunta ao
 * coordenador existente "qual e o proximo trabalho canonico?":
 *
 *   manutencao  avaliarNecessidadeDeSync, origem "background", sobre a
 *               faixa de frescor da politica (hoje − maior faixa → ontem);
 *   bootstrap   avaliarBootstrap na FASE corrente da loja (7 dias → 30 dias
 *               → ano corrente). A fase e DERIVADA do que ja existe: a
 *               primeira opcao de OPCOES_BACKFILL_INICIAL cuja cobertura
 *               ainda nao e COMPLETE. Sem coluna nova, sem migration.
 *   e entrega as duas avaliacoes a garantirProximaAcao, que escolhe pela
 *   prioridade do planner e cria NO MAXIMO um job (23505 = outro tick ganhou).
 *
 * Coverage, frescor, prioridade, blocos, dedup, falhas/cooldown e dia
 * corrente sao do planner (planejamento.ts) — aqui nao ha regra nenhuma.
 * O tick NAO resolve credencial, NAO chama marketplace e NAO executa
 * motor/worker: so le o banco e, no maximo, insere um job por loja.
 *
 * Erro de UMA loja vira STORE_FAILED dessa loja e o tick segue; falha ao
 * LISTAR lojas (infra) sobe para a rota (500).
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";
import { ASYNC_SYNC_JOBS_ENABLED } from "@/lib/feature-flags";
import { diaEmSaoPaulo, somarDiasNoCalendario } from "@/lib/fuso-sao-paulo";
import { avaliarNecessidadeDeSync, garantirProximaAcao, lerJobsDasLojas } from "./coordenador";
import { agregar, avaliarBootstrap, OPCOES_BACKFILL_INICIAL, POLITICA_SYNC_PROPOSTA } from "./planejamento";
import type { AvaliacaoLojaSync, AvaliacaoSync, MarketplaceSync, PoliticaSync } from "./tipos";

/** Lojas lidas por pagina (o PostgREST corta em 1000). */
const PAGINA_LOJAS = 500;

export type FaseBootstrap = (typeof OPCOES_BACKFILL_INICIAL)[number]["id"] | "COMPLETO";
export type AcaoTick = "JOB_CREATED" | "WAIT_ACTIVE_JOB" | "WAIT_RETRY" | "NOOP" | "FAILED" | "STORE_FAILED" | "NAO_AVALIADA_ORCAMENTO";

export interface ResultadoLojaTick {
  lojaId: string;
  marketplace: MarketplaceSync;
  acao: AcaoTick;
  jobId?: string;
  /** Acao do coordenador que gerou o job (CREATE_DISCOVERY_JOB | CREATE_REFRESH_JOB). */
  tipoJob?: string;
  faseBootstrap?: FaseBootstrap;
  /** Estado da manutencao (dias fechados): cobertura/frescor/definitivo do coordenador. */
  estado?: { cobertura: string; frescor: string; definitivo: boolean };
  /** Codigo sanitizado — nunca mensagem crua do banco. */
  motivo?: string;
}

export interface RelatorioTick {
  resultado: "DESABILITADO" | "OK" | "ERRO";
  lojasAvaliadas: number;
  jobsCriados: number;
  aguardando: number;
  noop: number;
  /** Necessidade no limite de falhas do planner (FAILED): reportada, nunca recriada aqui. */
  esgotadas: number;
  /** Erro ao avaliar a loja (STORE_FAILED). */
  falhas: number;
  naoAvaliadas: number;
  duracaoMs: number;
  resultados: ResultadoLojaTick[];
}

export interface DepsTick {
  cliente: SupabaseClient;
  relogio: { agoraMs: () => number };
  politica?: PoliticaSync;
  log?: (evento: Record<string, unknown>) => void;
}

interface LojaTick { id: string; userId: string; marketplace: MarketplaceSync }

const logPadrao = (e: Record<string, unknown>) => console.log(JSON.stringify(e));

export function criarDepsTickReais(): DepsTick {
  return { cliente: getSupabaseServidor(), relogio: { agoraMs: () => Date.now() } };
}

/** Todas as lojas ativas ML/Shopee, com o dono DA PROPRIA linha. So id/dono/marketplace — nunca colunas de credencial. */
export async function listarLojasElegiveis(cliente: SupabaseClient): Promise<LojaTick[]> {
  const out: LojaTick[] = [];
  for (let desde = 0; ; desde += PAGINA_LOJAS) {
    const { data, error } = await cliente.from("lojas").select("id, user_id, marketplace").eq("ativo", true).in("marketplace", ["ML", "Shopee"])
      .order("id", { ascending: true }).range(desde, desde + PAGINA_LOJAS - 1);
    if (error) throw new Error("leitura_lojas_falhou");
    const linhas = (data ?? []) as { id: string | null; user_id: string | null; marketplace: string }[];
    for (const l of linhas) if (l.id && l.user_id && (l.marketplace === "ML" || l.marketplace === "Shopee")) out.push({ id: l.id, userId: l.user_id, marketplace: l.marketplace });
    if (linhas.length < PAGINA_LOJAS) break;
  }
  return out;
}

/**
 * Fase do bootstrap progressivo, derivada do corpus (jobs completos): a
 * primeira opcao cuja cobertura nao e COMPLETE. ANO_CORRENTE vazio (1o de
 * janeiro: ainda nao ha dia fechado no ano) conta como coberto — a virada do
 * ano nao exige codigo; o ano anterior segue na janela de manutencao.
 */
function faseDoBootstrap(loja: LojaTick, jobs: Awaited<ReturnType<typeof lerJobsDasLojas>>, agoraMs: number, politica: PoliticaSync): { fase: FaseBootstrap; avaliacao: AvaliacaoLojaSync | null } {
  const hoje = diaEmSaoPaulo(new Date(agoraMs).toISOString())!;
  const anoSemDiaFechado = somarDiasNoCalendario(hoje, -1) < `${hoje.slice(0, 4)}-01-01`;
  for (const op of OPCOES_BACKFILL_INICIAL) {
    if (op.dias === null && anoSemDiaFechado) continue;
    if (op.dias !== null && op.dias > 30) continue; // 90 dias ja e a janela de manutencao
    const avaliacao = avaliarBootstrap({ loja: { id: loja.id, marketplace: loja.marketplace }, agoraMs, jobs, politica, horizonte: op.id });
    if (avaliacao.cobertura !== "COMPLETE") return { fase: op.id, avaliacao };
  }
  return { fase: "COMPLETO", avaliacao: null };
}

const CODIGOS_CONHECIDOS = /^(leitura_falhou|loja_invalida|periodo_invalido|user_id_ausente|janela_invalida|lojas_diferentes|criar_job|criar_job_ml)\b/;
function motivoSanitizado(e: unknown): string {
  const m = String((e as { message?: unknown })?.message ?? "");
  return CODIGOS_CONHECIDOS.exec(m)?.[1] ?? "erro_interno";
}

async function avaliarUmaLoja(deps: DepsTick, loja: LojaTick, agoraMs: number, politica: PoliticaSync): Promise<ResultadoLojaTick> {
  const { cliente } = deps;
  const hoje = diaEmSaoPaulo(new Date(agoraMs).toISOString())!;
  const maiorFaixa = Math.max(...politica.faixas.map((f) => f.idadeMaxDias));
  // dono, marketplace e loja vem da MESMA linha; o coordenador re-filtra lojas por (user_id, id)
  const manutencao = await avaliarNecessidadeDeSync(cliente,
    { userId: loja.userId, marketplace: loja.marketplace, lojaId: loja.id, de: somarDiasNoCalendario(hoje, -maiorFaixa), ate: somarDiasNoCalendario(hoje, -1), origem: "background" },
    { agoraMs, politica });
  const jobs = await lerJobsDasLojas(cliente, loja.userId, [loja.id]);
  const { fase, avaliacao: boot } = faseDoBootstrap(loja, jobs, agoraMs, politica);
  const avaliacoes: AvaliacaoSync[] = [manutencao, ...(boot ? [agregar([boot])] : [])];
  const lm = manutencao.lojas[0];
  const base = { lojaId: loja.id, marketplace: loja.marketplace, faseBootstrap: fase, estado: lm ? { cobertura: lm.cobertura, frescor: lm.frescor, definitivo: lm.definitivo } : undefined };
  const g = await garantirProximaAcao(cliente, loja.userId, avaliacoes, { habilitado: true });
  const criado = g.criados.find((c) => c.lojaId === loja.id);
  if (criado) return { ...base, acao: "JOB_CREATED", jobId: criado.jobId, tipoJob: criado.acao };
  const espera = g.aguardando.find((a) => a.lojaId === loja.id);
  if (!espera) return { ...base, acao: "NOOP" };
  if (espera.acao === "FAILED") return { ...base, acao: "FAILED" };
  if (espera.acao === "WAIT_RETRY") return { ...base, acao: "WAIT_RETRY" };
  return { ...base, acao: "WAIT_ACTIVE_JOB" };
}

/**
 * Um tick: flag → lista lojas → avalia cada uma (isolada) → relatorio
 * sanitizado. `criarDeps` so e chamado com a flag LIGADA (desligada: nenhum
 * cliente, nenhuma leitura). Orcamento: lojas que nao couberem ficam para o
 * proximo tick (NAO_AVALIADA_ORCAMENTO), nunca cortadas no meio.
 */
export async function executarTickCoordenador(
  criarDeps: () => DepsTick, opcoes: { orcamentoMs: number; habilitado?: boolean },
): Promise<RelatorioTick> {
  const inicio = Date.now();
  const vazio = { lojasAvaliadas: 0, jobsCriados: 0, aguardando: 0, noop: 0, esgotadas: 0, falhas: 0, naoAvaliadas: 0, resultados: [] as ResultadoLojaTick[] };
  if (!(opcoes.habilitado ?? ASYNC_SYNC_JOBS_ENABLED)) return { resultado: "DESABILITADO", ...vazio, duracaoMs: Date.now() - inicio };
  const deps = criarDeps();
  const log = deps.log ?? logPadrao;
  const politica = deps.politica ?? POLITICA_SYNC_PROPOSTA;
  const agoraMs = deps.relogio.agoraMs();
  log({ evento: "COORDINATOR_TICK_START" });
  const lojas = await listarLojasElegiveis(deps.cliente);
  const resultados: ResultadoLojaTick[] = [];
  for (const loja of lojas) {
    if (Date.now() - inicio > opcoes.orcamentoMs) { resultados.push({ lojaId: loja.id, marketplace: loja.marketplace, acao: "NAO_AVALIADA_ORCAMENTO" }); continue; }
    let r: ResultadoLojaTick;
    try { r = await avaliarUmaLoja(deps, loja, agoraMs, politica); }
    catch (e) { r = { lojaId: loja.id, marketplace: loja.marketplace, acao: "STORE_FAILED", motivo: motivoSanitizado(e) }; }
    resultados.push(r);
    log({ evento: "STORE_EVALUATED", loja_id: r.lojaId, marketplace: r.marketplace, acao: r.acao, fase_bootstrap: r.faseBootstrap });
    if (r.acao === "JOB_CREATED") log({ evento: "JOB_CREATED", loja_id: r.lojaId, marketplace: r.marketplace, job_id: r.jobId, tipo: r.tipoJob });
    else if (r.acao === "WAIT_ACTIVE_JOB" || r.acao === "NOOP") log({ evento: r.acao, loja_id: r.lojaId, marketplace: r.marketplace });
    else if (r.acao === "STORE_FAILED") log({ evento: "STORE_FAILED", loja_id: r.lojaId, marketplace: r.marketplace, motivo: r.motivo });
  }
  const conta = (...a: AcaoTick[]) => resultados.filter((r) => a.includes(r.acao)).length;
  const falhas = conta("STORE_FAILED");
  const naoAvaliadas = conta("NAO_AVALIADA_ORCAMENTO");
  const lojasAvaliadas = resultados.length - naoAvaliadas;
  const rel: RelatorioTick = {
    // todas as lojas avaliadas falharam = provavelmente infra: nao mascarar como OK
    resultado: lojasAvaliadas > 0 && falhas === lojasAvaliadas ? "ERRO" : "OK",
    lojasAvaliadas, jobsCriados: conta("JOB_CREATED"), aguardando: conta("WAIT_ACTIVE_JOB", "WAIT_RETRY"), noop: conta("NOOP"),
    esgotadas: conta("FAILED"), falhas, naoAvaliadas, duracaoMs: Date.now() - inicio, resultados,
  };
  log({ evento: "COORDINATOR_TICK_DONE", resultado: rel.resultado, lojas_avaliadas: rel.lojasAvaliadas, jobs_criados: rel.jobsCriados, aguardando: rel.aguardando,
    noop: rel.noop, esgotadas: rel.esgotadas, falhas: rel.falhas, nao_avaliadas: rel.naoAvaliadas, duracao_ms: rel.duracaoMs });
  return rel;
}
