/**
 * Contrato compartilhado dos servicos canonicos de vendas (CDS-STABILIZATION).
 *
 * Um servico por marketplace calcula as metricas OFICIAIS a partir de
 * componentes armazenados; Dashboard, agentes e relatorios so consomem este
 * contrato — nenhum deles reimplementa formula.
 *
 * Regra de ouro: `metricas` so vem preenchido quando `completude` e
 * COMPLETE. Periodo parcial ou falho devolve `null`, nunca um numero que
 * pareca confiavel.
 */

export type Completude = "COMPLETE" | "PARTIAL" | "FAILED";

/** As metricas que o Seller Center mostra para "Produto Pago". */
export interface MetricasVendas {
  /** Pedidos distintos pagos no periodo, em QUALQUER status atual. */
  pedidos: number;
  /** Dentre eles, os cancelados depois do pagamento. */
  cancelados: number;
  /** Soma das quantidades dos itens desses pedidos. */
  unidades: number;
  /** "Vendas" (R$). */
  vendas: number;
  /** "Vendas sem os descontos da plataforma" (R$). */
  vendasSemDescontosPlataforma: number;
}

/** Componentes da formula, em R$ — para auditoria e reprocessamento. */
export interface ComponentesVendasShopee {
  itens: number;
  voucherVendedor: number;
  voucherShopee: number;
  moedas: number;
  subsidioShopee: number;
  descontoPix: number;
}

export interface ResultadoVendasLoja {
  lojaId: string;
  completude: Completude;
  /** Por que nao esta COMPLETE (vazio quando esta). */
  motivos: string[];
  metricas: MetricasVendas | null;
  componentes: ComponentesVendasShopee | null;
  /** A (descoberta por create_time), B (estado), C (financeiro) — S2-D3-B2.1. */
  dimensoes?: { descoberta: boolean; estado: boolean; financeiro: boolean };
  /** Detail mais antigo usado: as metricas valem "na data de estadoEm". */
  estadoEm?: string | null;
  /** ANCORA (prova absoluta) ou POLITICA_PRAZO_PAGAMENTO (politica publicada + sentinela). */
  baseDescoberta?: "ANCORA" | "POLITICA_PRAZO_PAGAMENTO";
  /** Inicio exigido do corpus por create_time para este periodo. */
  descobertaDesde?: string;
  /** SALES-CANONICAL-D14: so quando o chamador pede `parcial: true`. */
  parcial?: ParcialObservadoLoja<MetricasVendas>;
  /** ETAPA 2A: as MESMAS metricas por dia de pagamento em Sao Paulo (so quando pedido e so com `metricas`). */
  porDia?: Record<string, MetricasVendas>;
  /** ETAPA 3 (so com `observado: true`): cada dia civil do periodo avaliado SOZINHO pelas mesmas funcoes. */
  observadoPorDia?: Record<string, DiaObservadoLoja<MetricasVendas>>;
}

/**
 * ETAPA 3 — um dia civil de Sao Paulo de UMA loja, avaliado pelas MESMAS funcoes de completude e de metricas do
 * leitor, com o dia como periodo. Nenhuma regra nova e nenhuma regra relaxada:
 *
 *   CONFIRMADO  a completude do dia e COMPLETE (a mesma prova de uma consulta daquele dia sozinho).
 *   PROVISORIO  a DESCOBERTA do dia esta provada (todo pedido do dia esta no corpus) e os valores existem, mas o
 *               estado ainda nao foi provado final (ex.: observado antes do fim do dia). Valor observado, pode mudar.
 *   SEM_DADOS   descoberta nao provada ou valor ausente: nenhum numero (nunca zero).
 */
export type EstadoDiaObservado = "CONFIRMADO" | "PROVISORIO" | "SEM_DADOS";
export interface DiaObservadoLoja<M> { estado: EstadoDiaObservado; metricas: M | null; motivos: string[] }

/**
 * SALES-CANONICAL-D14 — o prefixo OBSERVADO [inicio, observadoAte) de um
 * periodo ainda aberto, avaliado com as MESMAS funcoes puras de completude
 * e de metricas do leitor. `observadoAte` vem SO da cadeia de janelas de
 * descoberta completas (nunca do relogio, nunca da existencia de linhas).
 *
 *   SEM_OBSERVACAO  a cadeia nao passa do inicio: nada provado no periodo.
 *   OBSERVADO_ATE   inicio < observadoAte < fim: prefixo avaliavel.
 *   DIA_FECHADO     a cadeia ja alcanca o fim: vale a semantica normal.
 */
export interface ParcialObservadoLoja<M> {
  estado: "SEM_OBSERVACAO" | "OBSERVADO_ATE" | "DIA_FECHADO";
  observadoAte: string | null;
  /** Completude do PREFIXO (null fora de OBSERVADO_ATE). */
  completude: Completude | null;
  motivos: string[];
  /** So quando o prefixo e COMPLETE. */
  metricas: M | null;
  /** ETAPA 2A: as MESMAS metricas por dia civil de Sao Paulo (so quando pedido e so com `metricas`). */
  porDia?: Record<string, M>;
  /**
   * ETAPA 3 (so com `observado: true`, so em OBSERVADO_ATE): as MESMAS metricas do prefixo quando a descoberta esta
   * provada e os valores existem, mesmo sem a prova de estado. Valor PROVISORIO — nunca usado como `metricas`.
   */
  observadas?: M | null;
}

export interface ResultadoVendas {
  marketplace: "Shopee";
  periodo: { de: string; ate: string; fuso: "America/Sao_Paulo" };
  /** COMPLETE so se TODAS as lojas estiverem COMPLETE. */
  completude: Completude;
  lojas: ResultadoVendasLoja[];
  /** Soma das lojas — `null` se qualquer uma nao estiver COMPLETE. */
  total: MetricasVendas | null;
}
