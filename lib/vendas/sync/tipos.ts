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
  /**
   * E2.1: contadores do PROPRIO job (progresso.listados / progresso.escrow_necessarios) — so para estimar o tamanho
   * dos proximos jobs Shopee de manutencao (densidade de pedidos e fracao de escrow MEDIDAS). null = desconhecido.
   */
  listados?: number | null;
  escrowsNecessarios?: number | null;
}

/** Sinais de estado da Shopee (contagens do servico canonico, sem valores). */
export interface SinaisShopeeSync {
  escrowPendentes: number;
  naoObservadosAposPeriodo: number;
  /**
   * P1-B: faixas de CRIACAO (dias civis de SP, contiguos) dos nao pagos pendentes — o alvo do refresh. `ultimaObservacao`
   * = maior detail_fetched_at entre eles (null: nenhum foi detalhado). Ausente = chamador que so conta (janela toda).
   */
  faixasPendentes?: { inicio: string; fim: string; ultimaObservacao: string | null }[];
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
  /** E2.1: tamanho dos jobs Shopee de manutencao/bootstrap. Ausente = TAMANHO_JOB_SHOPEE (planejamento.ts). */
  tamanhoJobShopee?: TamanhoJobShopee;
}

/**
 * E2.1: como o planejador limita o TRABALHO estimado de cada job Shopee de manutencao/bootstrap (origem != usuario),
 * para que o intraday da loja (fila serial) volte a cada fronteira de job. Estimativa, nunca garantia de duracao.
 */
export interface TamanhoJobShopee {
  /** Trabalho-alvo por job, em fatias do worker (~40 s cada, um job por invocacao). */
  alvoFatias: number;
  /** Capacidade CONSERVADORA de uma fatia, por fase do motor (pedidos por fatia). */
  pedidosPorFatia: { listar: number; detalhe: number; escrow: number };
  /** Fracao de pedidos que exigem escrow quando nao ha medida (pedido ausente do banco: todos). */
  fracaoEscrowSemMedida: number;
  /** Menor fracao de escrow assumida, mesmo com medida menor. */
  pisoFracaoEscrow: number;
  /** Margem sobre a densidade MEDIA medida (pico dentro da janela de referencia). */
  fatorSeguranca: number;
  /** Janela sem nenhuma referencia medida por perto (densidade desconhecida). */
  sondaMs: number;
  minimoMs: number;
  /** Teto absoluto (abaixo do limite de 14 dias da get_order_list). */
  maximoMs: number;
  /** Inicio das janelas alinhado a esta grade (UTC; o fuso de SP tem offset de hora inteira). */
  gradeMs: number;
  /** Raio, em volta do trecho, onde jobs concluidos servem de referencia de densidade. */
  vizinhancaMs: number;
  /** Uma janela nunca passa deste multiplo da MAIOR janela de referencia (crescimento limitado a partir da sonda). */
  crescimentoMaximo: number;
}
