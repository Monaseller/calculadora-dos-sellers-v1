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
export type StatusFrete = "incluso_no_repasse" | "pendente";

export interface FinanceiroVendaLive {
  origem: "LIVE_CALCULATED";
  custoStatus: StatusCustoVenda;
  produto: RefProdutoMeusProdutos | null;
  custoProduto: number | null;       // (custo_produto + insumos) × qtd — só com custo cadastrado
  imposto: number | null;            // faturamento × imposto% — produto encontrado
  tarifa: number;
  tarifaOrigem: OrigemTarifa;
  freteStatus: StatusFrete;
  lucro: number | null;              // null = PENDENTE (custo e/ou frete)
  margemPct: number | null;
  roi: number | null;
  pendencias: Array<"custo" | "frete">;
}
