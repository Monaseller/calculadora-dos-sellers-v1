/**
 * CDS V2 — Vendas A4-B: identidade EXATA da linha de venda ML (item + variação), runtime.
 *
 * Sync REAL (lib/sync-ml.ts syncMLForUserV2) com Mercado Livre FALSO e Supabase em memória — sem rede,
 * sem banco. Prova: variação do provider gravada; id novo com loja e variação; legada reaproveitada (sem
 * variação) ou adotada (UMA variação), 2+ variações com legada → ambígua preservada (sem chute, sem
 * dupla contagem); loja B nunca adota a legada de A; resync idempotente; erro de gravação falha o sync;
 * histórico não é preenchido; quantidade é uma linha; receita = unit_price × qtd; A3 usa a variação
 * exata. I14.
 *
 * Uso: npx tsx scripts/testar-vendas-identidade-ml.ts
 */
import "./_server-only-inerte";
import Module from "node:module";

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

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://placeholder-de-teste.invalid";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "chave-de-teste-invalida";
process.env.SUPABASE_SERVICE_ROLE_KEY = "chave-de-teste-invalida";
process.env.ML_CLIENT_ID = "ficticio";
process.env.ML_CLIENT_SECRET = "ficticio";

const U = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LA = "11111111-1111-4111-8111-111111111111", LB = "22222222-2222-4222-8222-222222222222";
const DIA = "2026-10-01";

// ── Supabase em memória ──────────────────────────────────────────────
type Linha = Record<string, any>;
let db: Record<string, Linha[]> = {};
let falharUpsert = false, falharLeituraPedidos = false;
function clienteFalso() {
  return {
    from(tabela: string) {
      const st: any = { op: "select", payload: null, filtros: [] as [string, string, any][], ini: 0, fim: Infinity };
      const casa = (r: Linha) => st.filtros.every(([k, c, v]: [string, string, any]) =>
        k === "eq" ? String(r[c]) === String(v) : k === "in" ? (v as any[]).map(String).includes(String(r[c])) : k === "notis" ? (r[c] ?? null) !== v : true);
      const exec = () => {
        const ls = (db[tabela] ??= []);
        if (st.op === "upsert") {
          if (falharUpsert) return { data: null, error: { message: "falha simulada de gravação" } };
          for (const n of st.payload as Linha[]) { const i = ls.findIndex((r) => r.id === n.id); if (i >= 0) Object.assign(ls[i], n); else ls.push({ ...n }); }
          return { data: null, error: null };
        }
        if (tabela === "pedidos" && falharLeituraPedidos) return { data: null, error: { message: "leitura falhou" } };
        const out = ls.filter(casa).sort((a, b) => String(a.id).localeCompare(String(b.id))).slice(st.ini, st.fim).map((r) => ({ ...r }));
        return { data: out, error: null };
      };
      const b: any = new Proxy({}, { get(_a, p: string) {
        if (p === "then") return (res: any, rej: any) => Promise.resolve().then(exec).then(res, rej);
        return (...a: any[]) => {
          if (p === "upsert") { st.op = "upsert"; st.payload = Array.isArray(a[0]) ? a[0] : [a[0]]; }
          else if (p === "eq" || p === "in") st.filtros.push([p, a[0], a[1]]);
          else if (p === "not" && a[1] === "is") st.filtros.push(["notis", a[0], a[2]]);
          else if (p === "range") { st.ini = a[0]; st.fim = a[1] + 1; }
          return b;
        };
      } });
      return b;
    },
  };
}
const requireOriginal = (Module as any).prototype.require;
(Module as any).prototype.require = function (id: string) {
  if (id === "@supabase/supabase-js") return { createClient: () => clienteFalso() };
  return requireOriginal.apply(this, arguments as any);
};

// ── Mercado Livre falso: orders/search devolve os pedidos "pagos" do cenário ──
let PEDIDOS: any[] = [];
globalThis.fetch = (async (url: any) => {
  const alvo = String(url);
  if (!alvo.includes("mercadolibre.com")) throw new Error(`rede proibida: ${alvo}`);
  // como a API real: sem `order.status` a busca devolve TODOS os status (A3.4 — o sync não filtra mais)
  const pago = alvo.includes("order.status=paid") || !alvo.includes("order.status=");
  const corpo = alvo.includes("/orders/search") ? { results: pago ? PEDIDOS : [], paging: { total: pago ? PEDIDOS.length : 0 } } : {};
  return { ok: true, status: 200, json: async () => corpo, text: async () => JSON.stringify(corpo) } as any;
}) as any;

const item = (id: string, variacao: string | null, qtd = 1, preco = 50, extra: Linha = {}) =>
  ({ item: { id, title: `T ${id}`, seller_sku: `SKU-${id}`, ...(variacao !== null ? { variation_id: Number(variacao) } : {}) }, quantity: qtd, unit_price: preco, sale_fee: 5, ...extra });
const pedido = (id: number, itens: any[]) => ({ id, status: "paid", date_created: `${DIA}T12:00:00.000-03:00`, date_closed: `${DIA}T12:00:00.000-03:00`, total_amount: 0, order_items: itens, payments: [{ status: "approved", date_approved: `${DIA}T12:00:00.000-03:00` }] });
const loja = (lojaId: string) => ({ lojaId, accessToken: `<T_${lojaId.slice(0, 4)}>`, sellerId: "1", nickname: "n" });
const legada = (lojaId: string, order: string, itemId: string, extra: Linha = {}) =>
  ({ id: `${U}_ML_${order}_${itemId}`, user_id: U, marketplace: "ML", loja_id: lojaId, order_id: order, ml_item_id: itemId, variation_id: null, qtd: 1, faturamento: 1, data: "2026-09-01", ...extra });
const pedidosML = () => (db.pedidos ?? []).filter((r) => r.marketplace === "ML");

async function principal() {
  const silenciar = () => { console.log = () => {}; console.error = () => {}; console.warn = () => {}; };
  const restaurar = () => { console.log = imprimir; };
  silenciar();
  const SML = await import("../lib/sync-ml");
  const CP = await import("../lib/vendas/custo-produto");
  const G2 = await import("./_guard-v2");
  restaurar();
  const sync = async (lojaId: string, pedidos: any[]) => {
    PEDIDOS = pedidos; silenciar();
    try { return await SML.syncMLForUserV2(U, DIA, DIA, undefined, true, loja(lojaId)); } finally { restaurar(); }
  };
  const novo = () => { db = { pedidos: [], anuncios: [] }; falharUpsert = false; falharLeituraPedidos = false; };

  secao("\n[1. linhas novas — loja e variação na identidade]");
  t("A4-B1. venda nova SEM variação: variation_id null, id novo com loja (\"nv\")", async () => {
    novo();
    const r = await sync(LA, [pedido(1, [item("MLB1", null)])]);
    const l = pedidosML();
    assert(r.inserted === 1 && l.length === 1 && l[0].id === SML.idPedidoML(U, LA, "1", "MLB1", null) && l[0].id.endsWith(`_${LA}_1_MLB1_nv`) && l[0].variation_id === null && l[0].loja_id === LA, JSON.stringify(l));
  });
  t("A4-B2. venda nova COM variação V: variation_id = V exato; id com loja + variação", async () => {
    novo();
    await sync(LA, [pedido(2, [item("MLB2", "777")])]);
    const l = pedidosML();
    assert(l.length === 1 && l[0].variation_id === "777" && l[0].id === `${U}_ML_${LA}_2_MLB2_777`, JSON.stringify(l));
  });
  t("A4-B3. mesmo pedido/item com variações A e B: duas identidades distintas", async () => {
    novo();
    await sync(LA, [pedido(3, [item("MLB3", "10"), item("MLB3", "20")])]);
    const ids = pedidosML().map((r) => `${r.variation_id}:${r.id}`).sort();
    assert(ids.length === 2 && ids[0].startsWith("10:") && ids[1].startsWith("20:") && new Set(pedidosML().map((r) => r.id)).size === 2, JSON.stringify(ids));
  });
  t("A4-B4. resync do mesmo pedido/variação: não duplica (mesmo PK, atualizado)", async () => {
    novo();
    await sync(LA, [pedido(4, [item("MLB4", "9")])]);
    await sync(LA, [pedido(4, [item("MLB4", "9", 2, 60)])]);
    const l = pedidosML();
    assert(l.length === 1 && l[0].qtd === 2 && l[0].faturamento === 120, JSON.stringify(l));
  });

  secao("\n[2. linhas legadas — reaproveitar, adotar, ou preservar ambígua]");
  t("A4-B5. legada sem variação + provider sem variação → reaproveita o PK legado (sem duplicata)", async () => {
    novo(); db.pedidos.push(legada(LA, "5", "MLB5"));
    await sync(LA, [pedido(5, [item("MLB5", null, 1, 80)])]);
    const l = pedidosML();
    assert(l.length === 1 && l[0].id === `${U}_ML_5_MLB5` && l[0].faturamento === 80 && l[0].variation_id === null, JSON.stringify(l));
  });
  t("A4-B6. legada sem variação + UMA variação na resposta → adota: mesmo PK, variation_id = V, sem duplicata; resync estável", async () => {
    novo(); db.pedidos.push(legada(LA, "6", "MLB6"));
    await sync(LA, [pedido(6, [item("MLB6", "61")])]);
    await sync(LA, [pedido(6, [item("MLB6", "61")])]);
    const l = pedidosML();
    assert(l.length === 1 && l[0].id === `${U}_ML_6_MLB6` && l[0].variation_id === "61", JSON.stringify(l));
  });
  t("A4-B7. legada sem variação + DUAS variações → ambígua: legada intacta, nenhuma linha nova do item, sem chute; outros itens seguem", async () => {
    novo(); const antes = legada(LA, "7", "MLB7"); db.pedidos.push({ ...antes });
    const r = await sync(LA, [pedido(7, [item("MLB7", "71"), item("MLB7", "72"), item("MLB8", null)])]);
    const doItem = pedidosML().filter((x) => x.order_id === "7" && x.ml_item_id === "MLB7");
    assert(doItem.length === 1 && JSON.stringify(doItem[0]) === JSON.stringify(antes), `item ambíguo gravado/alterado: ${JSON.stringify(doItem)}`);
    assert(r.legadoVariacaoAmbigua === 1 && pedidosML().some((x) => x.ml_item_id === "MLB8" && x.loja_id === LA), JSON.stringify(r));
  });
  t("A4-B8. legada da loja A NÃO é adotada pela loja B (mesmo dono/pedido/item)", async () => {
    novo(); const antes = legada(LA, "8", "MLB9"); db.pedidos.push({ ...antes });
    await sync(LB, [pedido(8, [item("MLB9", "91")])]);
    const deA = pedidosML().find((x) => x.id === antes.id)!, deB = pedidosML().filter((x) => x.loja_id === LB);
    assert(JSON.stringify(deA) === JSON.stringify(antes) && deB.length === 1 && deB[0].id === `${U}_ML_${LB}_8_MLB9_91` && deB[0].variation_id === "91", JSON.stringify(pedidosML()));
  });
  t("A4-B9. mesmo dono/pedido/item/variação em A e B → identidades independentes (sem colisão)", async () => {
    novo();
    await sync(LA, [pedido(9, [item("MLB10", "5")])]);
    await sync(LB, [pedido(9, [item("MLB10", "5")])]);
    const l = pedidosML();
    assert(l.length === 2 && new Set(l.map((r) => r.id)).size === 2 && l.map((r) => r.loja_id).sort().join() === [LA, LB].sort().join(), JSON.stringify(l));
  });
  t("A4-B12. histórico NULL permanece NULL: sync de outros pedidos não toca legada nem preenche variação", async () => {
    novo(); const antes = legada(LA, "12", "MLB12"); db.pedidos.push({ ...antes });
    db.anuncios.push({ id: "an", user_id: U, marketplace: "ML", loja_id: LA, ml_item_id: "MLB12", variation_id: "1", ativo: true, custo_produto: 9, nome: "p" });
    await sync(LA, [pedido(120, [item("MLB13", null)]), pedido(121, [item("MLB12", null)])]);
    assert(JSON.stringify(pedidosML().find((x) => x.id === antes.id)) === JSON.stringify(antes), "legada histórica alterada");
    const nova = pedidosML().find((x) => x.order_id === "121")!;
    assert(nova && nova.variation_id === null, `variação inferida de Meus Produtos/SKU: ${JSON.stringify(nova)}`);
  });

  secao("\n[3. erro de gravação falha o sync]");
  t("A4-B10/B11. upsert com erro → sync REJEITA (ErroGravacaoPedidosML) e não devolve sucesso; leitura de existentes com erro também", async () => {
    novo(); falharUpsert = true;
    let erro: any = null, resultado: any = "nada";
    try { resultado = await sync(LA, [pedido(10, [item("MLB1", null)])]); } catch (e) { erro = e; }
    assert(erro instanceof SML.ErroGravacaoPedidosML && resultado === "nada", `sucesso falso: ${JSON.stringify(resultado)} ${erro}`);
    novo(); falharLeituraPedidos = true; erro = null;
    try { await sync(LA, [pedido(11, [item("MLB1", null)])]); } catch (e) { erro = e; }
    assert(erro instanceof SML.ErroGravacaoPedidosML && pedidosML().length === 0, "leitura falha não interrompeu antes de gravar");
  });

  secao("\n[4. quantidade, receita e A3]");
  t("A4-B15/B16. quantidade 3 = UMA linha com qtd 3; receita = unit_price × qtd; item_subtotal não gravado", async () => {
    novo();
    const r = await sync(LA, [pedido(15, [item("MLB15", "3", 3, 40)])]);
    const l = pedidosML();
    assert(r.inserted === 1 && l.length === 1 && l[0].qtd === 3 && l[0].faturamento === 120 && !("item_subtotal" in l[0]), JSON.stringify(l));
  });
  t("A4-B13. A3: venda ML com variação exata → produto exato (WITH_COST), não mais identidade incompleta", async () => {
    novo();
    await sync(LA, [pedido(13, [item("MLB20", "2")])]);
    const venda = pedidosML()[0];
    const mapa = CP.montarMapaCustoProduto("ML", LA, [
      { id: "v1", marketplace: "ML", loja_id: LA, ml_item_id: "MLB20", variation_id: "1", custo_produto: 10, imposto: 0, insumos: 0 },
      { id: "v2", marketplace: "ML", loja_id: LA, ml_item_id: "MLB20", variation_id: "2", custo_produto: 20, imposto: 0, insumos: 0 },
    ]);
    const r = CP.resolverCustoProduto(mapa, CP.identidadeDaVenda(venda as any));
    assert(r.status === "PRODUCT_FOUND_WITH_COST" && r.produto?.id === "v2", JSON.stringify(r));
  });
  t("A4-B14. A3: venda histórica sem variação em item com variações → continua IDENTITY_INCOMPLETE", () => {
    const mapa = CP.montarMapaCustoProduto("ML", LA, [
      { id: "v1", marketplace: "ML", loja_id: LA, ml_item_id: "MLB20", variation_id: "1", custo_produto: 10, imposto: 0, insumos: 0 },
      { id: "v2", marketplace: "ML", loja_id: LA, ml_item_id: "MLB20", variation_id: "2", custo_produto: 20, imposto: 0, insumos: 0 },
    ]);
    const r = CP.resolverCustoProduto(mapa, CP.identidadeDaVenda(legada(LA, "1", "MLB20") as any));
    assert(r.status === "PRODUCT_IDENTITY_INCOMPLETE", JSON.stringify(r));
  });
  t("A4-R. resolução pura: existente de outra loja ignorado; adoção só com UMA variação e UMA legada", () => {
    const linhas = [{ id: "novo", order_id: "1", ml_item_id: "I", variation_id: "V" }];
    const r1 = SML.resolverIdsPedidosML(LB, linhas, [{ id: "leg", order_id: "1", ml_item_id: "I", variation_id: null, loja_id: LA }]);
    assert(r1.linhas[0].id === "novo" && r1.ambiguas.length === 0, JSON.stringify(r1));
    const r2 = SML.resolverIdsPedidosML(LA, linhas, [{ id: "leg", order_id: "1", ml_item_id: "I", variation_id: null, loja_id: LA }]);
    assert(r2.linhas[0].id === "leg", JSON.stringify(r2));
    const duas = [...linhas, { id: "novo2", order_id: "1", ml_item_id: "I", variation_id: "W" }];
    const r3 = SML.resolverIdsPedidosML(LA, duas, [{ id: "leg", order_id: "1", ml_item_id: "I", variation_id: null, loja_id: LA }]);
    assert(r3.linhas.length === 0 && r3.ambiguas.length === 1 && r3.ambiguas[0].variacoes.join() === "V,W", JSON.stringify(r3));
  });

  secao("\n[5. guard]");
  t("I14. Guard V2 limpo (I14_ML_SALE_ITEM_IDENTITY_IS_EXACT + I12 + I13 + demais)", () => {
    const i14 = G2.identidadeVendaMLNaoExata(), v2 = G2.invariantesV2(undefined, { zonas: false });
    assert(i14.length === 0 && v2.length === 0, [...i14, ...v2].join(" | "));
  });

  await fila;
  imprimir(`\n${falhou === 0 ? "✓" : "✗"} VENDAS-IDENTIDADE-ML — ${ok} passaram, ${falhou} falharam`);
  process.exit(falhou === 0 ? 0 : 1);
}
principal().catch((e) => { imprimir("ERRO FATAL", e?.message ?? e); process.exit(1); });
