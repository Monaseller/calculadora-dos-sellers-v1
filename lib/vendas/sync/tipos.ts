/**
 * Coordenador canonico de sincronizacao de vendas (SALES-SYNC-A) — tipos.
 *
 * O coordenador NAO calcula faturamento e NAO tem motor proprio: ele so
 * decide QUAIS janelas os motores existentes precisam processar
 * (lib/mercado-livre/ingestao, lib/shopee/ingestao) e em que estado um
 * periodo esta. As formulas ficam em lib/vendas/canonico/{ml,shopee}.ts.
 */

export type MarketplaceSync = "ML" | "Shopee";

/** Contrato de estado que Dashboard/Vendas vao consumir (sem UI aqui). */
export type EstadoSync =
  | { estado: "COMPLETE" }
  /** Ha job do periodo em andamento; nao servir valor como definitivo. */
  | { estado: "SYNCING"; progresso: { cobertos: number; total: number } }
  /** Falta cobertura/frescor e ainda nao ha job rodando para ela. */
  | { estado: "PARTIAL"; motivos: string[] }
  /** Falha repetida alem da politica de retry. */
  | { estado: "FAILED"; motivos: string[] }
  /** O periodo inclui o dia corrente (ainda aberto): nunca COMPLETE. */
  | { estado: "IN_PROGRESS"; motivos: string[] };

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
}

/** Sinais de estado da Shopee que o corpus ja expoe (contagens, sem valores). */
export interface SinaisShopeeSync {
  /** Pagos no periodo com escrow pendente (coluna gerada escrow_pendente). */
  escrowPendentes: number;
  /** Corpus relevante nao pago, sem observacao depois do fim do periodo. */
  naoObservadosAposPeriodo: number;
}

export type PropositoJob = "descoberta" | "refresh" | "catchup_escrow";

export interface JobPlanejado {
  /** Chave logica de dedup: marketplace|loja|campo|inicio|fim|proposito. */
  chave: string;
  marketplace: MarketplaceSync;
  lojaId: string;
  /** null = catch-up de escrow (sem janela). */
  campoTempo: "date_closed" | "create_time" | null;
  inicio: string | null;
  fim: string | null;
  /** Dias civis de SP (date_from/date_to do job). */
  de: string;
  ate: string;
  proposito: PropositoJob;
}

export interface Intervalo { inicio: string; fim: string }

export interface ResultadoLojaSync {
  lojaId: string;
  marketplace: MarketplaceSync;
  estado: EstadoSync;
  /** Cobertura de descoberta que falta (instantes). */
  faltando: Intervalo[];
  /** Coberto, mas mais velho que a politica de refresh pede. */
  desatualizado: Intervalo[];
  jobsNecessarios: JobPlanejado[];
  jobsEmAndamento: string[];
}

export interface ResultadoSync {
  estado: EstadoSync;
  lojas: ResultadoLojaSync[];
}

/**
 * Politica de frescor/retry. NAO ha valor "oficial" ainda: o coordenador
 * recebe a politica explicitamente; POLITICA_REFRESH_PROPOSTA e so a
 * proposta documentada (ver planejamento.ts).
 */
export interface PoliticaSync {
  /** Faixas por idade do dia (dias desde o fim do dia): intervalo maximo entre releituras. Fora das faixas: sem refresh automatico. */
  faixas: { idadeMaxDias: number; intervaloMs: number }[];
  maxFalhasPorJanela: number;
  esperaAposFalhaMs: number;
  maxDiasPorJobML: number;
}
