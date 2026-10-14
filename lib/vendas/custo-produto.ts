/**
 * Vendas A3 — custo do PRODUTO vem de Meus Produtos, AO VIVO (LIVE_PRODUCT_COST_LOOKUP).
 *
 * Fonte da verdade:
 *   - Meus Produtos (`anuncios`) é a ÚNICA fonte de `custo_produto`, `imposto` e `insumos`. O marketplace
 *     nunca fornece custo de produto; `pedidos.custo`/`lucro_liquido`/`margem_contrib` são LEGADOS
 *     (persistidos na sync, acoplados a `ativo` e ao frete do anúncio) — nunca autoridade aqui.
 *   - A venda fornece o que é DELA: receita (`faturamento`), quantidade, tarifa/comissão e o repasse real
 *     (`escrow_amount`, Shopee, quando há dado financeiro).
 *
 * Contrato do lookup (uma leitura em lote por loja — nada por venda):
 *   - chave EXATA `marketplace|loja_id|item|variação-ou-vazio`; nunca SKU, nunca outra loja/marketplace;
 *   - SEM filtro de `ativo`: anúncio soft-deleted com custo continua fonte de custo;
 *   - SEM fallback entre variações: variação vendida sem linha exata não herda custo do pai nem de irmã;
 *   - ML legado (pedido sem variação): só casa se o item tem UMA linha e ela é sem variação; item com
 *     variações → identidade incompleta (A4 corrige), nunca "a primeira"/"a ativa"/"a mais recente";
 *   - custo CADASTRADO = `custo_produto > 0` (regra do produto: o formulário recusa custo ≤ 0 e relê 0 como
 *     vazio; importadores gravam 0 como "ainda não cadastrado"). `imposto` e `insumos` 0 são válidos.
 *
 * Nenhum estado sem custo vira custo 0: a venda continua visível e o que depende de custo fica PENDENTE.
 * Nada aqui grava — não há snapshot, congelamento nem backfill: editar o custo em Meus Produtos muda a
 * próxima leitura de Vendas, de propósito.
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { lerTodasAsPaginas } from "@/lib/anuncios/leitura-paginada";
import { liquidoPedidoML, type EnvioFinanceiroML, type PedidoFinanceiroML } from "./ml-financeiro";
import type { BaseFinanceira, FinanceiroVendaLive, MarketplaceVenda, OrigemTarifa, QualidadeFinanceira, RefProdutoMeusProdutos, StatusCustoVenda, StatusFrete } from "./custo-produto-tipos";

export type { BaseFinanceira, FinanceiroVendaLive, MarketplaceVenda, OrigemTarifa, QualidadeFinanceira, RefProdutoMeusProdutos, StatusCustoVenda, StatusFrete } from "./custo-produto-tipos";

/** O que o lookup lê de Meus Produtos — só identidade e os campos do usuário. */
export const COLUNAS_CUSTO_PRODUTO = "id, marketplace, loja_id, ml_item_id, variation_id, custo_produto, imposto, insumos";

export interface ProdutoDeCusto {
  id: string;
  marketplace: string;
  loja_id: string | null;
  ml_item_id: string | null;
  variation_id: string | null;
  custo_produto: number | string | null;
  imposto: number | string | null;
  insumos: number | string | null;
}

export interface MapaCustoProduto {
  marketplace: MarketplaceVenda;
  lojaId: string;
  exatos: Map<string, ProdutoDeCusto>;
  porItem: Map<string, ProdutoDeCusto[]>;
}

export function chaveCustoProduto(marketplace: MarketplaceVenda, lojaId: string, itemId: string, variacaoId: string | null): string {
  return `${marketplace}|${lojaId}|${itemId}|${variacaoId ?? ""}`;
}

const chaveItem = (marketplace: MarketplaceVenda, lojaId: string, itemId: string) => `${marketplace}|${lojaId}|${itemId}`;
const numero = (v: unknown): number | null => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/** Mapa EXATO da loja. Linha de outra loja/marketplace é ignorada (o loader já filtra; isto é defesa). */
export function montarMapaCustoProduto(marketplace: MarketplaceVenda, lojaId: string, linhas: readonly ProdutoDeCusto[]): MapaCustoProduto {
  const exatos = new Map<string, ProdutoDeCusto>(), porItem = new Map<string, ProdutoDeCusto[]>();
  for (const l of linhas) {
    if (l.marketplace !== marketplace || l.loja_id !== lojaId || !l.ml_item_id) continue;
    const variacao = l.variation_id ? String(l.variation_id) : null;
    exatos.set(chaveCustoProduto(marketplace, lojaId, String(l.ml_item_id), variacao), l);
    const k = chaveItem(marketplace, lojaId, String(l.ml_item_id));
    porItem.set(k, [...(porItem.get(k) ?? []), l]);
  }
  return { marketplace, lojaId, exatos, porItem };
}

/** Identidade da venda. `variacaoInformada=false` = a venda não diz qual variação (ML legado, até A4). */
export interface IdentidadeVendaCusto {
  itemId: string | null;
  variacaoId: string | null;
  variacaoInformada: boolean;
}

export interface ResultadoCustoProduto {
  status: StatusCustoVenda;
  produto: ProdutoDeCusto | null;
  ref: RefProdutoMeusProdutos | null;
}

export const custoCadastrado = (p: ProdutoDeCusto): boolean => (numero(p.custo_produto) ?? 0) > 0;

function encontrado(mapa: MapaCustoProduto, p: ProdutoDeCusto): ResultadoCustoProduto {
  return {
    status: custoCadastrado(p) ? "PRODUCT_FOUND_WITH_COST" : "PRODUCT_FOUND_WITHOUT_COST",
    produto: p,
    ref: { anuncioId: p.id, marketplace: mapa.marketplace, lojaId: mapa.lojaId, itemId: String(p.ml_item_id), variacaoId: p.variation_id ? String(p.variation_id) : null, exata: true },
  };
}

export function resolverCustoProduto(mapa: MapaCustoProduto, id: IdentidadeVendaCusto): ResultadoCustoProduto {
  if (!id.itemId) return { status: "PRODUCT_NOT_FOUND", produto: null, ref: null };
  const itemId = String(id.itemId);
  if (id.variacaoInformada) {
    const p = mapa.exatos.get(chaveCustoProduto(mapa.marketplace, mapa.lojaId, itemId, id.variacaoId ? String(id.variacaoId) : null));
    return p ? encontrado(mapa, p) : { status: "PRODUCT_NOT_FOUND", produto: null, ref: null };
  }
  const doItem = mapa.porItem.get(chaveItem(mapa.marketplace, mapa.lojaId, itemId)) ?? [];
  if (doItem.length === 0) return { status: "PRODUCT_NOT_FOUND", produto: null, ref: null };
  if (doItem.length === 1 && !doItem[0].variation_id) return encontrado(mapa, doItem[0]);
  // O item tem variações e a venda não diz qual: nada de primeira/ativa/mais recente/média.
  return {
    status: "PRODUCT_IDENTITY_INCOMPLETE",
    produto: null,
    ref: { anuncioId: null, marketplace: mapa.marketplace, lojaId: mapa.lojaId, itemId, variacaoId: null, exata: false },
  };
}

/** UMA leitura paginada (todas as páginas) por loja: dono + marketplace + loja + item não nulo, SEM `ativo`. */
export async function carregarMapaCustoProduto(
  cliente: SupabaseClient, userId: string, marketplace: MarketplaceVenda, lojaId: string
): Promise<{ ok: true; mapa: MapaCustoProduto } | { ok: false; motivo: string }> {
  if (!userId || !lojaId) return { ok: false, motivo: "loja_obrigatoria" };
  const leitura = await lerTodasAsPaginas<ProdutoDeCusto>(() => cliente
    .from("anuncios")
    .select(COLUNAS_CUSTO_PRODUTO)
    .eq("user_id", userId)
    .eq("marketplace", marketplace)
    .eq("loja_id", lojaId)
    .not("ml_item_id", "is", null) as any);
  if (!leitura.ok) return { ok: false, motivo: leitura.motivo };
  return { ok: true, mapa: montarMapaCustoProduto(marketplace, lojaId, leitura.linhas) };
}

// ── Financeiro da venda, calculado AO VIVO ───────────────────────────────

/** O que a venda persistida fornece (dados da TRANSAÇÃO — nunca custo de produto). */
export interface VendaPersistidaParaCusto {
  marketplace: string;
  ml_item_id: string | null;
  variation_id: string | null;
  qtd: number | string | null;
  faturamento: number | string | null;
  tarifa_venda: number | string | null;
  has_income_data?: boolean | null;
  escrow_amount?: number | string | null;
  financial_reconciled_at?: string | null;
  /** Vendas A3.2-B: proveniência da tarifa das linhas ML NOVAS ('PROVIDER' | 'ESTIMATE'); NULL = legado. */
  tarifa_origem?: string | null;
}

/** Vendas A3.2-B: financeiro REAL do pedido ML (ml_financeiro_pedidos) + o envio dele (ml_financeiro_envios). */
export interface FinanceiroRealML { pedido: PedidoFinanceiroML; envio: EnvioFinanceiroML | null }

/**
 * Base financeira da venda, em ordem de preferência (Vendas A3.1 — decisão do dono do produto):
 *   1. REPASSE_REAL    Shopee reconciliada (`financial_reconciled_at`): `escrow_amount` é o repasse FINAL
 *                      (contrato da coluna) → ACTUAL;
 *   2. REPASSE_LEGADO  Shopee com repasse do sync legado (`has_income_data`, sem reconciliação) → ESTIMATED;
 *   3. COMPONENTES_ESTIMADOS  ML: receita − `tarifa_venda` × qtd (o `sale_fee` do ML é POR UNIDADE e o
 *                      legado o gravou sem × qtd); frete do vendedor NÃO incluído → ESTIMATED;
 *   4. SEM_BASE        Shopee sem repasse → PENDING (a tarifa estimada cobre só comissão+campanha).
 * Com base repasse o lucro é `repasse − custo − imposto`: tarifa, comissão, frete e descontos JÁ estão no
 * repasse e NÃO são subtraídos de novo (sem dupla contagem). Custo e insumos são POR UNIDADE (× qtd);
 * imposto é PERCENTUAL da receita (semântica já aprovada no CDS). Sem custo cadastrado → lucro pendente.
 */
export function financeiroDaVenda(venda: VendaPersistidaParaCusto, resultado: ResultadoCustoProduto, ml: FinanceiroRealML | null = null): FinanceiroVendaLive {
  const qtd = numero(venda.qtd) ?? 1;
  const faturamento = numero(venda.faturamento) ?? 0;
  const p = resultado.produto;
  const comCusto = resultado.status === "PRODUCT_FOUND_WITH_COST" && p !== null;
  const custoProduto = comCusto ? ((numero(p!.custo_produto) ?? 0) + (numero(p!.insumos) ?? 0)) * qtd : null;
  const imposto = p ? faturamento * ((numero(p.imposto) ?? 0) / 100) : null;

  const shopee = venda.marketplace === "Shopee";
  const base: BaseFinanceira = shopee
    ? (venda.has_income_data === true ? (venda.financial_reconciled_at ? "REPASSE_REAL" : "REPASSE_LEGADO") : "SEM_BASE")
    : "COMPONENTES_ESTIMADOS";
  const qualidadeFinanceira: QualidadeFinanceira = base === "REPASSE_REAL" ? "ACTUAL" : base === "SEM_BASE" ? "PENDING" : "ESTIMATED";
  const porRepasse = base === "REPASSE_REAL" || base === "REPASSE_LEGADO";
  const tarifa = shopee ? (numero(venda.tarifa_venda) ?? 0) : (numero(venda.tarifa_venda) ?? 0) * qtd;
  const tarifaOrigem: OrigemTarifa = shopee ? (porRepasse ? "real" : "estimada")
    : venda.tarifa_origem === "PROVIDER" ? "real" : venda.tarifa_origem === "ESTIMATE" ? "estimada" : "legada";
  const freteStatus: StatusFrete = porRepasse ? "incluso_no_repasse" : shopee ? "pendente" : "nao_incluido";

  const pendencias: Array<"custo" | "financeiro"> = [];
  if (!comCusto) pendencias.push("custo");
  if (qualidadeFinanceira === "PENDING") pendencias.push("financeiro");

  // Vendas A3.2-B: ML com financeiro REAL do pedido — só pedido de UMA linha cuja receita bate (o envio e a
  // tarifa são do pedido; sem rateio entre linhas). Sem registro → segue o modelo legado ESTIMATED acima.
  const real = !shopee && ml && ml.pedido.itens === 1 && Math.abs(ml.pedido.receita_produto - faturamento) <= 0.01 ? ml : null;
  if (real) return financeiroRealML(real, resultado, faturamento, custoProduto, imposto, comCusto);

  let lucro: number | null = null;
  if (pendencias.length === 0 && custoProduto !== null && imposto !== null) {
    // Base repasse: só os custos INTERNOS saem (o resto já está no repasse). Componentes: receita − tarifa.
    const liquidoDaVenda = porRepasse ? (numero(venda.escrow_amount) ?? 0) : faturamento - tarifa;
    lucro = liquidoDaVenda - custoProduto - imposto;
  }
  return {
    origem: "LIVE_CALCULATED",
    custoStatus: resultado.status,
    produto: resultado.ref,
    custoProduto,
    imposto,
    qualidadeFinanceira,
    baseFinanceira: base,
    tarifa,
    tarifaOrigem,
    freteStatus,
    lucro,
    margemPct: lucro !== null && faturamento > 0 ? (lucro / faturamento) * 100 : null,
    roi: lucro !== null && custoProduto !== null && custoProduto > 0 ? (lucro / custoProduto) * 100 : null,
    pendencias,
  };
}

/**
 * Linha ML com financeiro REAL: líquido = receita − tarifa LÍQUIDA − frete do vendedor (ml-financeiro.ts);
 * lucro = líquido − custo − imposto. ACTUAL só com o pedido reconciliado; billing não conferido → ESTIMATED;
 * tarifa/frete ausente ou envio compartilhado → PENDING (sem número inventado).
 */
function financeiroRealML(ml: FinanceiroRealML, resultado: ResultadoCustoProduto, faturamento: number, custoProduto: number | null, imposto: number | null, comCusto: boolean): FinanceiroVendaLive {
  const liq = liquidoPedidoML(ml.pedido, ml.envio);
  const pendencias: Array<"custo" | "financeiro"> = [];
  if (!comCusto) pendencias.push("custo");
  if (liq.qualidade === "PENDING") pendencias.push("financeiro");
  const lucro = pendencias.length === 0 && liq.liquido !== null && custoProduto !== null && imposto !== null ? liq.liquido - custoProduto - imposto : null;
  return {
    origem: "LIVE_CALCULATED",
    custoStatus: resultado.status,
    produto: resultado.ref,
    custoProduto,
    imposto,
    qualidadeFinanceira: liq.qualidade,
    baseFinanceira: "ML_RECONCILIADO",
    tarifa: ml.pedido.tarifa_venda ?? 0,
    tarifaOrigem: ml.pedido.tarifa_origem === "PROVIDER" ? "real" : "legada",
    freteStatus: liq.freteVendedor !== null ? "no_liquido_ml" : "pendente",
    freteVendedor: liq.freteVendedor,
    liquidoMarketplace: liq.liquido,
    detalheML: {
      packId: ml.pedido.pack_id,
      freteComprador: ml.envio?.frete_comprador ?? null,
      descontoVendedor: ml.pedido.desconto_vendedor,
      descontoMeli: ml.pedido.desconto_meli,
      billing: ml.pedido.billing_status,
      motivo: liq.motivo,
    },
    lucro,
    margemPct: lucro !== null && faturamento > 0 ? (lucro / faturamento) * 100 : null,
    roi: lucro !== null && custoProduto !== null && custoProduto > 0 ? (lucro / custoProduto) * 100 : null,
    pendencias,
  };
}

/** Identidade da venda persistida: Shopee informa o model (null = item sem model); ML legado não informa. */
export function identidadeDaVenda(venda: VendaPersistidaParaCusto): IdentidadeVendaCusto {
  return venda.marketplace === "Shopee"
    ? { itemId: venda.ml_item_id, variacaoId: venda.variation_id, variacaoInformada: true }
    : { itemId: venda.ml_item_id, variacaoId: venda.variation_id, variacaoInformada: venda.variation_id !== null && venda.variation_id !== undefined && venda.variation_id !== "" };
}
