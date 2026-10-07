/**
 * WORKER canonico de vendas (SALES-SYNC-B1) — executa jobs EXISTENTES.
 *
 * Uma invocacao = no maximo UM job e UMA fatia:
 *
 *   flag?  → recupera canonicos presos (lease vencido) → claim otimista
 *   → relê a linha → valida dono/loja/marketplace/janela/checkpoint
 *   → roteia (worker-contrato.ts) → UMA fatia do motor oficial
 *   → pausado: rodando → pendente (checkpoint intacto, retomavel)
 *     concluido/falhou: o PROPRIO motor ja gravou o status
 *     excecao: rodando → erro (mensagem sanitizada) → sai.
 *
 * O worker NAO decide: nao cria job, nao escolhe periodo/prioridade, nao
 * conta falhas (isso e do coordenador — planejamento.ts), nao calcula
 * valor (servico canonico). Nunca toca job legado: o claim so enxerga o
 * que `classificarJobParaWorker` reconhece como canonico, e toda transicao
 * e condicional (id + status esperado).
 *
 * Lease: `heartbeat_em` (ja existe — 20260711_sync_jobs.sql) e renovado
 * pelo claim e por TODA gravacao dos motores. Job canonico `rodando` com
 * batimento mais velho que LEASE_MS e de um processo morto (a funcao
 * serverless e cortada em maxDuration, muito antes): volta para
 * `pendente` com o checkpoint intacto; `tentativas` conta o abandono e,
 * esgotado `max_tentativas`, o job vira `erro` (nunca preso para sempre,
 * nunca reabandonado sem fim).
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ASYNC_SYNC_JOBS_ENABLED } from "@/lib/feature-flags";
import { limitesDaJanela } from "@/lib/mercado-livre/ingestao/janelas";
import { executarFatiaML } from "@/lib/mercado-livre/ingestao/motor";
import type { CheckpointML, ProgressoML, RepositorioML, TransporteML } from "@/lib/mercado-livre/ingestao/tipos";
import { executarFatiaCatchUpEscrow, executarFatiaShopee } from "@/lib/shopee/ingestao/motor";
import type { CheckpointCatchUpEscrow, CheckpointShopee, ProgressoShopee, Repositorio, ShopeeApi } from "@/lib/shopee/ingestao/tipos";
import { classificarJobParaWorker, type TipoTrabalhoCanonico } from "./worker-contrato";

/** Batimento mais velho que isto = processo morto. Muito maior que qualquer maxDuration (60–300 s). */
export const LEASE_MS = 10 * 60 * 1000;
/** Candidatos lidos por consulta e tentativas de claim por invocacao (corrida perdida → proximo). */
const CANDIDATOS = 10;
const TENTATIVAS_CLAIM = 3;
const RECUPERACOES_POR_INVOCACAO = 5;

const COLUNAS_CANDIDATO = "id, marketplace, campo_tempo, janela_inicio, janela_fim, criado_em, modo:checkpoint->>modo";
const COLUNAS_JOB = "id, user_id, loja_id, marketplace, campo_tempo, janela_inicio, janela_fim, date_from, date_to, checkpoint, progresso, status, tentativas, max_tentativas, heartbeat_em, iniciado_em";

/** ADIADO = auth Shopee TRANSITORIA (refresh em andamento / lease indisponivel): job de volta a pendente, sem erro. */
export type ResultadoWorker = "DESABILITADO" | "NO_JOB" | "CLAIM_PERDIDO" | "EXECUTADO" | "RECUSADO" | "ADIADO" | "ERRO";

/** Auth Shopee transitoria (SALES-SYNC-C6): contencao/infra, NUNCA falha de credencial. */
export interface AuthShopeeTransitoria { transitorio: "refresh_em_andamento" | "lease_indisponivel"; retryAfterMs?: number }

export interface RelatorioWorker {
  resultado: ResultadoWorker;
  job_id?: string;
  marketplace?: string;
  tipo?: TipoTrabalhoCanonico;
  loja_id?: string;
  status_anterior?: string;
  status_posterior?: string;
  /** Estado da fatia devolvido pelo motor (pausado/concluido/falhou) ou motivo da recusa. */
  fatia?: string;
  motivo?: string;
  /** So contadores numericos — nunca order_sn, comprador ou mensagem crua. */
  progresso?: Record<string, number>;
  duracao_ms: number;
  recuperados: number;
}

export interface MotoresCanonicos {
  ml: typeof executarFatiaML;
  shopee: typeof executarFatiaShopee;
  catchup: typeof executarFatiaCatchUpEscrow;
}

export interface JobReivindicado {
  id: string; userId: string; lojaId: string; marketplace: "ML" | "Shopee"; tipo: TipoTrabalhoCanonico;
}

export interface DepsWorker {
  /** service_role — o worker roda sem sessao; o dono vem da LINHA do job, conferido contra `lojas`. */
  cliente: SupabaseClient;
  relogio: { agoraMs(): number };
  /** Portas do motor ML para um job JA validado. */
  portasML(job: JobReivindicado): Promise<{ transporte: TransporteML; repo: RepositorioML }>;
  /**
   * Portas Shopee. null = credencial REALMENTE indisponivel (job vira erro auth);
   * { transitorio } = outra execucao renovando / lease indisponivel → job ADIADO
   * (volta a pendente, checkpoint intacto, nada conta como falha).
   */
  portasShopee(job: JobReivindicado): Promise<{ api: ShopeeApi; repo: Repositorio } | AuthShopeeTransitoria | null>;
  motores?: MotoresCanonicos;
}

export interface OpcoesWorker {
  /** Orcamento da invocacao (ms) — menor que o maxDuration da rota. */
  orcamentoMs: number;
  leaseMs?: number;
  /** Sobrescreve ENABLE_ASYNC_SYNC_JOBS (testes / execucao controlada). */
  habilitado?: boolean;
}

const MOTORES_REAIS: MotoresCanonicos = { ml: executarFatiaML, shopee: executarFatiaShopee, catchup: executarFatiaCatchUpEscrow };

/** Mensagem de erro gravavel: curta, sem segredo, sem identificador longo. */
export function sanitizarErro(e: unknown): string {
  const bruto = e instanceof Error ? `${e.name === "Error" ? "" : `${e.name}:`}${e.message}` : String(e);
  return bruto
    .replace(/(access_token|refresh_token|partner_key|authorization|bearer|apikey|secret)[\s:="']*\S*/gi, "[redigido]")
    .replace(/[A-Za-z0-9_\-+/=.]{32,}/g, "[redigido]")
    .replace(/\d{10,}/g, "***")
    .slice(0, 200);
}

function soNumeros(p: unknown): Record<string, number> | undefined {
  if (!p || typeof p !== "object") return undefined;
  return Object.fromEntries(Object.entries(p as Record<string, unknown>).filter(([, v]) => typeof v === "number")) as Record<string, number>;
}

const falhaDb = (op: string, error: { message?: string } | null) => { if (error) throw new Error(`worker_db:${op}:${error.message ?? "erro"}`); };

/**
 * Recupera jobs CANONICOS `rodando` com lease vencido. Condicional ao
 * batimento observado: se o dono vivo bateu entre a leitura e o UPDATE,
 * 0 linhas — nada e roubado. Job legado nunca e tocado.
 */
export async function recuperarJobsPresos(cliente: SupabaseClient, agoraMs: number, leaseMs = LEASE_MS): Promise<number> {
  const limite = new Date(agoraMs - leaseMs).toISOString();
  const { data, error } = await cliente.from("sync_jobs").select(`${COLUNAS_CANDIDATO}, heartbeat_em, iniciado_em, tentativas, max_tentativas`)
    .eq("status", "rodando").order("heartbeat_em", { ascending: true }).limit(CANDIDATOS * 2);
  falhaDb("presos", error);
  let n = 0;
  for (const r of (data ?? []) as Record<string, any>[]) {
    if (n >= RECUPERACOES_POR_INVOCACAO) break;
    if (classificarJobParaWorker({ ...r, checkpoint: { modo: r.modo } } as any) === "NAO_CANONICO") continue;
    const batimento: string | null = r.heartbeat_em ?? null;
    const referencia = batimento ?? r.iniciado_em ?? null;
    if (referencia !== null && referencia >= limite) continue;   // vivo
    const tentativas = (r.tentativas ?? 0) + 1, esgotou = tentativas >= (r.max_tentativas ?? 3);
    const agoraIso = new Date(agoraMs).toISOString();
    let q = cliente.from("sync_jobs").update(esgotou
      ? { status: "erro", tentativas, erro_mensagem: "lease_vencido:tentativas_esgotadas", erro_tipo: "transient", concluido_em: agoraIso, heartbeat_em: null }
      : { status: "pendente", tentativas, heartbeat_em: null })
      .eq("id", r.id).eq("status", "rodando");
    q = batimento === null ? q.is("heartbeat_em", null) : q.eq("heartbeat_em", batimento);
    const { data: up, error: e2 } = await q.select("id");
    falhaDb("recuperar", e2);
    if ((up ?? []).length === 1) n++;
  }
  return n;
}

/** Candidatos CANONICOS pendentes, mais antigos primeiro. Filtro no banco E de novo no codigo. */
async function candidatos(cliente: SupabaseClient): Promise<{ id: string; tipo: TipoTrabalhoCanonico }[]> {
  const janelas = await cliente.from("sync_jobs").select(COLUNAS_CANDIDATO)
    .eq("status", "pendente").in("campo_tempo", ["date_closed", "create_time"]).order("criado_em", { ascending: true }).limit(CANDIDATOS);
  falhaDb("candidatos", janelas.error);
  const catchup = await cliente.from("sync_jobs").select(COLUNAS_CANDIDATO)
    .eq("status", "pendente").is("campo_tempo", null).eq("checkpoint->>modo", "escrow_catchup").order("criado_em", { ascending: true }).limit(CANDIDATOS);
  falhaDb("candidatos_catchup", catchup.error);
  return ([...(janelas.data ?? []), ...(catchup.data ?? [])] as Record<string, any>[])
    .sort((a, b) => String(a.criado_em).localeCompare(String(b.criado_em)))
    .map((r) => ({ id: r.id as string, tipo: classificarJobParaWorker({ ...r, checkpoint: { modo: r.modo } } as any) }))
    .filter((c) => c.tipo !== "NAO_CANONICO");
}

/** Claim otimista: so quem muda pendente → rodando na MESMA linha ganha. */
async function reivindicar(cliente: SupabaseClient, id: string, agoraMs: number): Promise<boolean> {
  const agoraIso = new Date(agoraMs).toISOString();
  const { data, error } = await cliente.from("sync_jobs").update({ status: "rodando", iniciado_em: agoraIso, heartbeat_em: agoraIso })
    .eq("id", id).eq("status", "pendente").select("id");
  falhaDb("claim", error);
  return (data ?? []).length === 1;
}

/** Transicao condicional a partir de `rodando` (nunca toca checkpoint/progresso). */
async function transicionar(cliente: SupabaseClient, id: string, patch: Record<string, unknown>): Promise<boolean> {
  const { data, error } = await cliente.from("sync_jobs").update(patch).eq("id", id).eq("status", "rodando").select("id");
  falhaDb("transicao", error);
  return (data ?? []).length === 1;
}

function checkpointCompativel(tipo: TipoTrabalhoCanonico, ck: unknown): boolean {
  if (ck === null || ck === undefined) return tipo !== "SHOPEE_ESCROW_CATCHUP";
  if (typeof ck !== "object") return false;
  const c = ck as Record<string, unknown>;
  if (tipo === "ML_DATE_CLOSED") return c.versao === 1 && Array.isArray(c.diasConcluidos) && !("modo" in c) && !("fase" in c);
  if (tipo === "SHOPEE_CREATE_TIME") return c.versao === 1 && typeof c.fase === "string" && !("modo" in c);
  if (tipo === "SHOPEE_ESCROW_CATCHUP") return c.versao === 1 && c.modo === "escrow_catchup";
  return false;
}

export async function executarWorkerCanonico(depsOuFabrica: DepsWorker | (() => DepsWorker), opcoes: OpcoesWorker): Promise<RelatorioWorker> {
  const habilitado = opcoes.habilitado ?? ASYNC_SYNC_JOBS_ENABLED;
  const t0 = Date.now();
  const fim = (r: Omit<RelatorioWorker, "duracao_ms">): RelatorioWorker => ({ ...r, duracao_ms: Date.now() - t0 });
  // Flag OFF: nada e lido nem escrito (nem o cliente e construido).
  if (!habilitado) return fim({ resultado: "DESABILITADO", recuperados: 0 });

  const deps = typeof depsOuFabrica === "function" ? depsOuFabrica() : depsOuFabrica;
  const { cliente, relogio } = deps;
  const motores = deps.motores ?? MOTORES_REAIS;
  const inicioMs = relogio.agoraMs();
  const prazoMs = inicioMs + opcoes.orcamentoMs;

  const recuperados = await recuperarJobsPresos(cliente, inicioMs, opcoes.leaseMs ?? LEASE_MS);

  // ── claim (no maximo UM job) ──
  const lista = await candidatos(cliente);
  if (!lista.length) return fim({ resultado: "NO_JOB", recuperados });
  let ganho: { id: string; tipo: TipoTrabalhoCanonico } | null = null;
  for (const c of lista.slice(0, TENTATIVAS_CLAIM)) if (await reivindicar(cliente, c.id, relogio.agoraMs())) { ganho = c; break; }
  if (!ganho) return fim({ resultado: "CLAIM_PERDIDO", recuperados });

  // ── a linha reivindicada, relida ──
  const { data: linha, error } = await cliente.from("sync_jobs").select(COLUNAS_JOB).eq("id", ganho.id).single();
  falhaDb("job", error);
  const r = linha as Record<string, any>;
  const base = { job_id: r.id as string, marketplace: r.marketplace as string, loja_id: r.loja_id as string, status_anterior: "pendente", recuperados };
  const tipo = classificarJobParaWorker(r as any);
  const recusar = async (motivo: string, erroTipo: "loja" | "validation" | "auth") => {
    const ok = await transicionar(cliente, r.id, { status: "erro", erro_mensagem: motivo, erro_tipo: erroTipo, concluido_em: new Date(relogio.agoraMs()).toISOString() });
    return fim({ ...base, tipo, resultado: "RECUSADO", motivo, status_posterior: ok ? "erro" : "desconhecido" });
  };
  if (tipo === "NAO_CANONICO" || tipo !== ganho.tipo) return recusar("tipo_mudou_apos_claim", "validation");

  // ── dono, loja e marketplace vem do BANCO (lojas), nunca do checkpoint ──
  const { data: loja, error: eLoja } = await cliente.from("lojas").select("id, user_id, marketplace, ativo")
    .eq("id", r.loja_id).eq("user_id", r.user_id).maybeSingle();
  falhaDb("loja", eLoja);
  if (!loja) return recusar("loja_invalida", "loja");
  if ((loja as any).marketplace !== r.marketplace) return recusar("marketplace_divergente", "loja");
  if ((loja as any).ativo !== true) return recusar("loja_inativa", "loja");
  if (!checkpointCompativel(tipo, r.checkpoint)) return recusar("checkpoint_incompativel", "validation");
  if (tipo === "ML_DATE_CLOSED") {
    const l = limitesDaJanela(String(r.date_from), String(r.date_to));
    if (!l || l.inicio.getTime() !== Date.parse(r.janela_inicio) || l.fim.getTime() !== Date.parse(r.janela_fim)) return recusar("janela_inconsistente", "validation");
  }

  const job: JobReivindicado = { id: r.id, userId: r.user_id, lojaId: r.loja_id, marketplace: r.marketplace, tipo };
  const opMotor = { prazoMs, habilitado: true as const };
  let res: { estado: string; motivo?: string; progresso?: unknown };
  try {
    if (tipo === "ML_DATE_CLOSED") {
      const p = await deps.portasML(job);
      res = await motores.ml({ id: job.id, userId: job.userId, lojaId: job.lojaId, de: String(r.date_from), ate: String(r.date_to),
        checkpoint: (r.checkpoint ?? null) as CheckpointML | null, progresso: (r.progresso ?? null) as ProgressoML | null }, { ...p, relogio }, opMotor);
    } else {
      const p = await deps.portasShopee(job);
      if (!p) return recusar("credencial_indisponivel", "auth");
      if ("transitorio" in p) {
        // Contencao normal (outro processo renovando o token) ou infra do lease:
        // NAO e erro do job. rodando → pendente; checkpoint/progresso/tentativas
        // e erro_mensagem intocados (o coordenador so conta jobs em erro). Uma
        // resolucao de auth por fatia: o proximo tick tenta de novo.
        const ok = await transicionar(cliente, job.id, { status: "pendente", heartbeat_em: new Date(relogio.agoraMs()).toISOString() });
        return fim({ ...base, tipo, resultado: "ADIADO", fatia: "auth_transitoria", motivo: `auth_transitoria:${p.transitorio}`, status_posterior: ok ? "pendente" : "desconhecido" });
      }
      res = tipo === "SHOPEE_CREATE_TIME"
        ? await motores.shopee({ id: job.id, userId: job.userId, lojaId: job.lojaId, campoTempo: "create_time", janelaInicio: r.janela_inicio, janelaFim: r.janela_fim,
          checkpoint: (r.checkpoint ?? null) as CheckpointShopee | null, progresso: (r.progresso ?? null) as ProgressoShopee | null }, { ...p, relogio }, opMotor)
        : await motores.catchup({ id: job.id, userId: job.userId, lojaId: job.lojaId,
          checkpoint: r.checkpoint as CheckpointCatchUpEscrow, progresso: (r.progresso ?? null) as ProgressoShopee | null }, { ...p, relogio }, opMotor);
    }
  } catch (e) {
    // Excecao do motor/porta: o job NUNCA fica rodando por isso. O checkpoint
    // salvo ate aqui fica intacto; quem decide nova tentativa e o coordenador.
    const motivo = `excecao:${sanitizarErro(e)}`;
    const ok = await transicionar(cliente, job.id, { status: "erro", erro_mensagem: motivo, erro_tipo: "unknown", concluido_em: new Date(relogio.agoraMs()).toISOString() });
    return fim({ ...base, tipo, resultado: "ERRO", fatia: "excecao", motivo, status_posterior: ok ? "erro" : "desconhecido" });
  }

  // ── depois da fatia ──
  let posterior: string;
  if (res.estado === "pausado" || res.estado === "desabilitado") {
    // O motor deixa `rodando` ao pausar: devolver a fila, checkpoint intacto.
    posterior = (await transicionar(cliente, job.id, { status: "pendente", heartbeat_em: new Date(relogio.agoraMs()).toISOString() })) ? "pendente" : "desconhecido";
  } else {
    const { data: depois, error: e3 } = await cliente.from("sync_jobs").select("status").eq("id", job.id).single();
    falhaDb("status_final", e3);
    posterior = String((depois as any)?.status);
  }
  return fim({ ...base, tipo, resultado: "EXECUTADO", fatia: res.estado, motivo: res.motivo ? sanitizarErro(res.motivo) : undefined,
    status_posterior: posterior, progresso: soNumeros(res.progresso) });
}
