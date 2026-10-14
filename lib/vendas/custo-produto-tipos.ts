/**
 * Vendas A3 — TIPOS do custo ao vivo (sem banco, sem servidor): a tela de Vendas ("use client") importa
 * daqui, nunca de ./custo-produto (que lê `anuncios` e é server-only).
 */
export type MarketplaceVenda = "ML" | "Shopee";

export type StatusCustoVenda =
  | "PRODUCT_FOUND_WITH_COST"
  | "PRODUCT_FOUND_WITHOUT_COST"
  | "PRODUCT_NOT_FOUND"
  | "PRODUCT_IDENTITY_INCOMPLETE";

/** Referência EXATA ao produto em Meus Produtos (para "Custo não cadastrado" → produto). */
export interface RefProdutoMeusProdutos {
  anuncioId: string | null;          // null quando só o ITEM é conhecido (identidade incompleta)
  marketplace: MarketplaceVenda;
  lojaId: string;
  itemId: string;
  variacaoId: string | null;
  exata: boolean;
}

export type OrigemTarifa = "real" | "estimada" | "legada";
export type StatusFrete = "incluso_no_repasse" | "nao_incluido" | "pendente" | "no_liquido_ml";

/**
 * Vendas A3.1 — qualidade do dado FINANCEIRO da venda (separada do status de custo do produto):
 *   ACTUAL    repasse REAL reconciliado (get_escrow_detail: "repasse FINAL ao vendedor");
 *   ESTIMATED repasse do sync legado (income_distribution, equivalência não provada) ou componentes
 *             estimados (ML: receita − tarifa por unidade × qtd; frete NÃO incluído);
 *   PENDING   sem base confiável (Shopee sem repasse: a tarifa estimada cobre ~15% e o repasse real
 *             desconta ~47% — estimar inflaria o lucro).
 */
export type QualidadeFinanceira = "ACTUAL" | "ESTIMATED" | "PENDING";
export type BaseFinanceira = "REPASSE_REAL" | "REPASSE_LEGADO" | "COMPONENTES_ESTIMADOS" | "SEM_BASE" | "ML_RECONCILIADO";

/** Vendas A3.2-B — detalhe do financeiro REAL do ML (pedido + envio), só informativo na tela. */
export interface DetalheFinanceiroML {
  packId: string | null;
  freteComprador: number | null;   // receiver.cost — pago pelo comprador (NÃO é custo do vendedor)
  descontoVendedor: number | null; // já refletido no preço
  descontoMeli: number | null;     // rebate de campanha — já refletido na tarifa líquida
  billing: "CONFERIDO" | "DIVERGENTE" | "PENDENTE" | "SEM_PERMISSAO";
  motivo: "ok" | "tarifa" | "frete" | "frete_compartilhado" | "billing";
}

export interface FinanceiroVendaLive {
  origem: "LIVE_CALCULATED";
  custoStatus: StatusCustoVenda;
  produto: RefProdutoMeusProdutos | null;
  custoProduto: number | null;       // (custo_produto + insumos) × qtd — só com custo cadastrado
  imposto: number | null;            // faturamento × imposto% — produto encontrado
  qualidadeFinanceira: QualidadeFinanceira;
  baseFinanceira: BaseFinanceira;
  tarifa: number;                    // tarifa da LINHA (ML: por unidade × qtd); com base repasse é só informativa
  tarifaOrigem: OrigemTarifa;
  freteStatus: StatusFrete;
  freteVendedor?: number | null;     // ML reconciliado: Σ senders[].cost (custo LÍQUIDO do vendedor)
  liquidoMarketplace?: number | null; // ML reconciliado: receita − tarifa líquida − frete do vendedor
  detalheML?: DetalheFinanceiroML | null;
  lucro: number | null;              // null = PENDENTE (custo do produto e/ou base financeira)
  margemPct: number | null;
  roi: number | null;
  pendencias: Array<"custo" | "financeiro">;
}
