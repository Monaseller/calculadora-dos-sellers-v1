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
