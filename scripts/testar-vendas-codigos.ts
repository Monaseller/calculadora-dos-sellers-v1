/**
 * CDS V2 — Vendas A3.2: códigos ORIGINAIS do marketplace na tela de Vendas + contrato da venda golden ML.
 *
 *   SALE-ID   CÓD. VENDA = order_id (ML order.id; Shopee order_sn), CÓD. ANÚNCIO = ml_item_id (ML
 *             order_items[].item.id; Shopee item_id); pedidos.id interno nunca exposto; copiar = valor exato.
 *   GOLDEN    venda real 2000015516685373 (sem dados do comprador): o painel do ML fecha em 30,10; o modelo
 *             ATUAL do CDS não tem frete do vendedor nem rebate da tarifa — continua ESTIMATED, com frete
 *             "não incluído", e nunca afirma o líquido do painel (sem ACTUAL inventado).
 *
 * Uso: npx tsx scripts/testar-vendas-codigos.ts
 */
import "./_server-only-inerte";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let ok = 0, falhou = 0;
let fila: Promise<void> = Promise.resolve();
const imprimir = console.log.bind(console);
function t(nome: string, fn: () => void | Promise<void>) {
  fila = fila.then(async () => {
    try { await fn(); ok++; imprimir(`  PASS  ${nome}`); }
    catch (e: any) { falhou++; imprimir(`  FALHA ${nome} -> ${e?.message ?? e}`); }
  });
}
function secao(s: string) { fila = fila.then(() => { imprimir(s); }); }
function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }

const fonte = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n")
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
/** Corpo de `function nome(...) {` (a { que fecha a assinatura) por balanceamento de chaves. */
const corpoFn = (src: string, nome: string) => {
  const m = new RegExp(`function ${nome}\\([^)]*\\)[^\\n]*\\{\\n`).exec(src);
  if (!m) return "";
  let n = 1, i = m.index + m[0].length;
  for (; n > 0 && i < src.length; i++) { if (src[i] === "{") n++; else if (src[i] === "}") n--; }
  return src.slice(m.index + m[0].length, i - 1);
};

/** Venda golden (painel do ML, 14/10/2026) — só ids e valores; nenhum dado do comprador. */
const GOLDEN = {
  orderId: "2000015516685373", qtd: 1,
  precoProduto: 41.24, tarifaVenda: 4.95, freteComprador: 6.99, freteTarifaTotal: 13.94, freteLiquidoVendedor: 6.95,
  rebateTarifa: 0.76, liquidoPainel: 30.10,
};
const centavos = (v: number) => Math.round(v * 100);

async function principal() {
  const C = await import("../app/(app)/vendas/codigos-venda");
  const F = await import("../lib/vendas/custo-produto");
  const pagina = fonte("app/(app)/vendas/page.tsx");
  const rotaML = corpoFn(fonte("app/api/ml/vendas/route.ts"), "pedidoToRow");
  const rotaSP = corpoFn(fonte("app/api/shopee/vendas/route.ts"), "pedidoToRow");

  secao("\n[1. códigos da venda e do anúncio]");
  t("SALE-ID1. ML: CÓD. VENDA = order_id (order.id do provider), ex. golden 2000015516685373", () => {
    assert(/orderId:\s*p\.order_id,/.test(rotaML), "rota ML não expõe order_id como orderId");
    assert(/order_id:\s*String\(order\.id\),/.test(fonte("lib/sync-ml.ts")), "sync ML não grava order.id em order_id");
    assert(C.codigoVenda({ orderId: GOLDEN.orderId, mlItemId: "MLB1" }) === GOLDEN.orderId, "código da venda ≠ order_id");
  });
  t("SALE-ID2. Shopee: CÓD. VENDA = order_sn", () => {
    assert(/orderId:\s*p\.order_id,/.test(rotaSP), "rota Shopee não expõe order_id como orderId");
    const sync = fonte("lib/sync-shopee.ts"), ing = fonte("lib/shopee/ingestao/normalizar.ts");
    assert((sync.match(/order_id:\s*order\.order_sn,/g) ?? []).length >= 1 && /order_id: d\.orderSn,/.test(ing), "Shopee não grava order_sn em order_id");
    assert(C.codigoVenda({ orderId: "2410140ABCDEFG" }) === "2410140ABCDEFG", "código Shopee alterado");
  });
  t("SALE-ID3. pedidos.id interno nunca vira código da venda (rotas não o expõem; a tela usa só os helpers)", () => {
    for (const [nome, corpo] of [["ML", rotaML], ["Shopee", rotaSP]] as const) {
      assert(corpo.length > 0, `${nome}: pedidoToRow não encontrado (detector cego)`);
      assert(!/\bp\.id\b|^\s*id:/m.test(corpo), `${nome}: linha expõe pedidos.id`);
    }
    assert(/\{celulaCodigo\(codigoVenda\(r\), /.test(pagina) && /\{celulaCodigo\(codigoAnuncio\(r\), /.test(pagina), "tela não usa os helpers de código");
    assert(!/r\.id\b/.test(pagina), "tela lê r.id");
    assert(C.codigoVenda({ orderId: "" }) === null && C.codigoVenda({ orderId: null }) === null, "código vazio virou valor");
  });
  t("SALE-ID4. ML: CÓD. ANÚNCIO = ml_item_id (order_items[].item.id) — nunca SKU/título", () => {
    assert(/mlItemId:\s*p\.ml_item_id,/.test(rotaML) && /const mlItemId:\s*string = orderItem\.item\?\.id\s*\?\? "";/.test(fonte("lib/sync-ml.ts")), "ml_item_id fora de item.id");
    assert(C.codigoAnuncio({ orderId: "1", mlItemId: " MLB4567890123 " }) === "MLB4567890123", "código do anúncio alterado");
    assert(C.codigoAnuncio({ orderId: "1", mlItemId: "" }) === null, "linha sem item inventou código");
    const h = fonte("app/(app)/vendas/codigos-venda.ts");
    assert(!/\.(sku|anuncio|titulo|title|nome|id)\b/.test(h) && /return limpo\(r\.mlItemId\)/.test(h) && /return limpo\(r\.orderId\)/.test(h), "helper usa SKU/título/id interno");
  });
  t("SALE-ID5. copiar copia o código EXATO; sem área de transferência / falha → false (sem exceção)", async () => {
    const copiados: string[] = [];
    assert(await C.copiarCodigo(GOLDEN.orderId, { writeText: async (s) => { copiados.push(s); } }) === true, "copiar falhou");
    assert(copiados.length === 1 && copiados[0] === GOLDEN.orderId, `copiou ${JSON.stringify(copiados)}`);
    assert(await C.copiarCodigo("x", null) === false, "sem clipboard → true");
    assert(await C.copiarCodigo("x", { writeText: async () => { throw new Error("negado"); } }) === false, "falha → true");
    assert(/copiarCodigo\(codigo, typeof navigator !== "undefined" \? navigator\.clipboard : null\)/.test(pagina), "tela não copia o código exato");
  });

  secao("\n[2. venda golden ML — contrato atual honesto]");
  t("GOLDEN-1. o painel do ML fecha: 41,24 − 4,95 − 6,95 + 0,76 = 30,10 (frete líquido = 13,94 − 6,99)", () => {
    const g = GOLDEN;
    assert(centavos(g.freteTarifaTotal) - centavos(g.freteComprador) === centavos(g.freteLiquidoVendedor), "frete líquido do painel não fecha");
    assert(centavos(g.precoProduto) - centavos(g.tarifaVenda) - centavos(g.freteLiquidoVendedor) + centavos(g.rebateTarifa) === centavos(g.liquidoPainel), "painel não fecha");
  });
  t("GOLDEN-2 (FIN-ML6/7/8). modelo ATUAL: ESTIMATED, frete do vendedor 'não incluído', nunca ACTUAL nem o líquido do painel", () => {
    const venda = { marketplace: "ML", ml_item_id: "MLB1", variation_id: null, qtd: GOLDEN.qtd, faturamento: GOLDEN.precoProduto, tarifa_venda: GOLDEN.tarifaVenda };
    const ref = { anuncioId: "an", marketplace: "ML" as const, lojaId: "l", itemId: "MLB1", variacaoId: null, exata: true };
    const fin = F.financeiroDaVenda(venda, { status: "PRODUCT_FOUND_WITH_COST", produto: { id: "an", custo_produto: 10, imposto: 0, insumos: 0 } as any, ref });
    assert(fin.qualidadeFinanceira === "ESTIMATED" && fin.baseFinanceira === "COMPONENTES_ESTIMADOS", `qualidade ${fin.qualidadeFinanceira}/${fin.baseFinanceira}`);
    assert(fin.freteStatus === "nao_incluido" && fin.tarifaOrigem === "legada", `frete ${fin.freteStatus} tarifa ${fin.tarifaOrigem}`);
    const liquidoAtual = (fin.lucro ?? 0) + 10;
    assert(centavos(liquidoAtual) === centavos(GOLDEN.precoProduto - GOLDEN.tarifaVenda), `líquido atual ${liquidoAtual}`);
    assert(centavos(liquidoAtual) !== centavos(GOLDEN.liquidoPainel), "modelo atual afirmou o líquido do painel sem frete/rebate reais");
  });

  await fila;
  imprimir(`\n${falhou === 0 ? "✓" : "✗"} VENDAS-CODIGOS — ${ok} passaram, ${falhou} falharam`);
  process.exit(falhou === 0 ? 0 : 1);
}
principal().catch((e) => { imprimir("ERRO FATAL", e?.message ?? e); process.exit(1); });
