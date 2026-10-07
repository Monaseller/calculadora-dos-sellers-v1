/**
 * Coordenador canonico de sincronizacao de vendas — tipos (SALES-SYNC-A1).
 *
 * O coordenador NAO calcula faturamento e NAO tem motor proprio: decide
 * QUAIS janelas os motores existentes (lib/mercado-livre/ingestao,
 * lib/shopee/ingestao) precisam processar e em que estado um periodo
 * esta. As formulas ficam em lib/vendas/canonico/{ml,shopee}.ts.
 *
 * Duas dimensoes que NAO se colapsam:
 *   cobertura  — o corpus da janela foi descoberto por inteiro?
 *   frescor    — o estado guardado e recente o bastante para ser o valor
 *                ATUAL do marketplace? (cancel_detail/escrow mudam depois)
 * definitivo = cobertura COMPLETE && frescor FRESH. COMPLETE + STALE e um
 * snapshot valido, mas NAO o valor atual homologado.
 */

export type MarketplaceSync = "ML" | "Shopee";
export type Cobertura = "COMPLETE" | "PARTIAL" | "FAILED";
/** IN_PROGRESS = o periodo inclui o dia corrente (aberto). */
export type Frescor = "FRESH" | "STALE" | "IN_PROGRESS";
export type Sincronizacao = "IDLE" | "SYNCING" | "WAITING_RETRY";
/** Quem pediu a avaliacao — define prioridade e refresh sob demanda. */
export type OrigemPedido = "usuario" | "background" | "bootstrap";

export interface LojaAtivaSync { id: string; marketplace: MarketplaceSync }

/** Uma linha de sync_jobs, so com o que o coordenador precisa. */
export interface JobExistenteSync {
  id: string;
  lojaId: string;
  marketplace: string;
  campoTempo: string | null;
  janelaInicio: string | null;
  janelaFim: string | null;
  status: string;
  listagemCompleta: boolean | null;
  concluidoEm: string | null;
  criadoEm: string;
  /** Catch-up de escrow (checkpoint.modo = escrow_catchup) — distingue do job legado, que tambem tem campo/janela NULL. */
  catchup?: boolean;
  /** SALES-SYNC-D15B: tipo e dias date_from/date_to — so para classificar intraday (ehJobIntraday). */
  tipo?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
}

/** Sinais de estado da Shopee (contagens do servico canonico, sem valores). */
export interface SinaisShopeeSync {
  escrowPendentes: number;
  naoObservadosAposPeriodo: number;
}

/** intraday (D15B): observacao do dia corrente ate T — nunca cobertura de periodo fechado. */
export type PropositoJob = "descoberta" | "refresh" | "catchup_escrow" | "intraday";

export interface JobPlanejado {
  /** Chave logica: marketplace|loja|campo|inicio|fim|proposito. */
  chave: string;
  marketplace: MarketplaceSync;
  lojaId: string;
  /** null = catch-up de escrow (sem janela). */
  campoTempo: "date_closed" | "create_time" | null;
  inicio: string | null;
  fim: string | null;
  de: string;
  ate: string;
  proposito: PropositoJob;
}

/** Uma necessidade de trabalho, com prioridade da fila serial da loja (menor = antes). */
export interface Necessidade { job: JobPlanejado; tipo: "discovery" | "refresh"; prioridade: number }

/** A UNICA proxima acao da loja (fila serial: um job ativo por loja). */
export type ProximaAcao =
  | { acao: "NOOP" }
  | { acao: "CREATE_DISCOVERY_JOB"; job: JobPlanejado; prioridade: number }
  | { acao: "CREATE_REFRESH_JOB"; job: JobPlanejado; prioridade: number }
  | { acao: "WAIT_ACTIVE_JOB"; jobId: string }
  | { acao: "WAIT_RETRY"; ate: string }
  | { acao: "FAILED"; motivos: string[] };

export interface Intervalo { inicio: string; fim: string }

export interface AvaliacaoLojaSync {
  lojaId: string;
  marketplace: MarketplaceSync;
  cobertura: Cobertura;
  frescor: Frescor;
  definitivo: boolean;
  sincronizacao: Sincronizacao;
  motivos: string[];
  faltando: Intervalo[];
  desatualizado: Intervalo[];
  necessidades: Necessidade[];
  proximaAcao: ProximaAcao;
  jobsEmAndamento: string[];
}

export interface AvaliacaoSync {
  cobertura: Cobertura;
  frescor: Frescor;
  definitivo: boolean;
  sincronizacao: Sincronizacao;
  motivos: string[];
  lojas: AvaliacaoLojaSync[];
}

/**
 * Politica de frescor/retry — UM lugar (POLITICA_SYNC_PROPOSTA em
 * planejamento.ts), injetada explicitamente. Nao e regra financeira.
 */
export interface PoliticaSync {
  /** Por idade do dia (dias desde o fim do dia): intervalo maximo entre observacoes. */
  faixas: { idadeMaxDias: number; intervaloMs: number }[];
  /** Dia mais velho que as faixas, pedido EXPLICITAMENTE pelo usuario: idade maxima aceita da observacao. */
  intervaloSobDemandaMs: number;
  /** Falhas por NECESSIDADE (janela logica, nao por UUID) dentro da janela de contagem. */
  maxFalhasPorNecessidade: number;
  esperaAposFalhaMs: number;
  /** Falhas mais velhas que isto nao contam (no maximo N tentativas por janela de contagem: nunca infinito). */
  janelaContagemFalhasMs: number;
  maxDiasPorJobML: number;
  /** "Recente" para a prioridade da fila. */
  horizonteRecenteDias: number;
}
