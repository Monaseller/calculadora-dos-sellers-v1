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
export type StatusFrete = "incluso_no_repasse" | "nao_incluido" | "pendente";

/**
 * Vendas A3.1 — qualidade do dado FINANCEIRO da venda (separada do status de custo do produto):
 *   ACTUAL    repasse REAL reconciliado (get_escrow_detail: "repasse FINAL ao vendedor");
 *   ESTIMATED repasse do sync legado (income_distribution, equivalência não provada) ou componentes
 *             estimados (ML: receita − tarifa por unidade × qtd; frete NÃO incluído);
 *   PENDING   sem base confiável (Shopee sem repasse: a tarifa estimada cobre ~15% e o repasse real
 *             desconta ~47% — estimar inflaria o lucro).
 */
export type QualidadeFinanceira = "ACTUAL" | "ESTIMATED" | "PENDING";
export type BaseFinanceira = "REPASSE_REAL" | "REPASSE_LEGADO" | "COMPONENTES_ESTIMADOS" | "SEM_BASE";

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
  lucro: number | null;              // null = PENDENTE (custo do produto e/ou base financeira)
  margemPct: number | null;
  roi: number | null;
  pendencias: Array<"custo" | "financeiro">;
}
