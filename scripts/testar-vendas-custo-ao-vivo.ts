/**
 * CDS V2 — Vendas A3: custo da venda vem AO VIVO de Meus Produtos (LIVE_PRODUCT_COST_LOOKUP).
 *
 * Serviço REAL (lib/vendas/custo-produto.ts), rotas REAIS (/api/ml/vendas, /api/shopee/vendas) e o
 * cálculo da tela (app/(app)/vendas/financeiro-live.ts), com Supabase em memória — sem rede, sem banco.
 * Prova: os 4 estados (com custo / sem custo / não encontrado / identidade incompleta), chave exata
 * marketplace|loja|item|variação (sem SKU, sem fallback), `ativo` fora do lookup, custo ausente ≠ 0,
 * frete do anúncio fora (pendente sem dado da venda), venda sempre visível, leitura ao vivo (editar o
 * custo muda a próxima leitura), leitura paginada >1000, uma carga por requisição (sem N+1), I13.
 *
 * Uso: npx tsx scripts/testar-vendas-custo-ao-vivo.ts
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
const perto = (a: number | null | undefined, b: number) => a !== null && a !== undefined && Math.abs(a - b) < 1e-9;

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://placeholder-de-teste.invalid";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "chave-de-teste-invalida";
process.env.SUPABASE_SERVICE_ROLE_KEY = "chave-de-teste-invalida";
process.env.SESSION_SECRET = "segredo-de-teste-com-mais-de-32-bytes-000000";
process.env.ML_CLIENT_ID = "ficticio";
process.env.ML_CLIENT_SECRET = "ficticio";
process.env.SHOPEE_BASE_URL = "https://shopee.teste.invalid";

const U = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ML_A = "11111111-1111-4111-8111-111111111111", ML_B = "22222222-2222-4222-8222-222222222222";
const SP_A = "33333333-3333-4333-8333-333333333333";
const FUTURO = () => new Date(Date.now() + 3600_000 * 24).toISOString();
const PASSADO = () => new Date(Date.now() - 3600_000).toISOString();
const DIA = "2026-10-01";

// ── Supabase em memória ──────────────────────────────────────────────
type Linha = Record<string, any>;
let db: Record<string, Linha[]> = {};
let leituras: { tabela: string; filtros: [string, string, any][] }[] = [];
function clienteFalso() {
  return {
    rpc: async () => ({ data: null, error: { message: "rpc_indisponivel_no_teste" } }),
    from(tabela: string) {
      const st: any = { op: "select", payload: null, filtros: [] as [string, string, any][], ini: 0, fim: Infinity, unico: false, ordens: [] as [string, boolean][] };
      const casa = (r: Linha) => st.filtros.every(([k, c, v]: [string, string, any]) =>
        k === "eq" ? String(r[c]) === String(v) : k === "in" ? (v as any[]).map(String).includes(String(r[c]))
          : k === "is" ? (r[c] ?? null) === v : k === "notis" ? (r[c] ?? null) !== v : k === "gte" ? String(r[c] ?? "") >= String(v) : k === "lte" ? String(r[c] ?? "") <= String(v) : true);
      const exec = () => {
        const ls = (db[tabela] ??= []);
        if (st.op !== "select") { if (st.op === "update") for (const r of ls.filter(casa)) Object.assign(r, st.payload); return { data: [], error: null }; }
        leituras.push({ tabela, filtros: [...st.filtros] });
        let out = ls.filter(casa).map((r) => ({ ...r }));
        for (const [c, asc] of [...st.ordens].reverse()) out.sort((a, b) => (asc ? 1 : -1) * (String(a[c] ?? "") < String(b[c] ?? "") ? -1 : String(a[c] ?? "") > String(b[c] ?? "") ? 1 : 0));
        // teto do PostgREST: nunca mais de 1000 por resposta
        out = out.slice(st.ini, Math.min(out.length, st.fim, st.ini + 1000));
        return st.unico ? { data: out[0] ?? null, error: null } : { data: out, error: null, count: out.length };
      };
      const b: any = new Proxy({}, { get(_a, p: string) {
        if (p === "then") return (res: any, rej: any) => Promise.resolve().then(exec).then(res, rej);
        if (p === "maybeSingle" || p === "single") return async () => { st.unico = true; return exec(); };
        return (...a: any[]) => {
          if (["update", "insert", "upsert"].includes(p)) { st.op = p; st.payload = a[0]; }
          else if (["eq", "in", "is", "gte", "lte"].includes(p)) st.filtros.push([p, a[0], a[1]]);
          else if (p === "not" && a[1] === "is") st.filtros.push(["notis", a[0], a[2]]);
          else if (p === "order") st.ordens.push([a[0], a[1]?.ascending !== false]);
          else if (p === "range") { st.ini = a[0]; st.fim = a[1] + 1; }
          else if (p === "limit") st.fim = st.ini + a[0];
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
globalThis.fetch = (async (url: any) => {
  const alvo = String(url);
  if (alvo.includes("mercadolibre.com")) return { ok: true, status: 200, json: async () => ({ results: [], paging: { total: 0 } }) } as any;
  throw new Error(`rede proibida no teste: ${alvo}`);
}) as any;

const anuncio = (id: string, marketplace: string, loja: string, item: string, variacao: string | null, custo: number, extra: Linha = {}) =>
  ({ id, user_id: U, marketplace, loja_id: loja, ml_item_id: item, variation_id: variacao, custo_produto: custo, imposto: 10, insumos: 1, ativo: true, sku: null, custo_frete: 99, frete_gratis: true, ...extra });
const venda = (marketplace: string, item: string | null, variacao: string | null, extra: Linha = {}) =>
  ({ marketplace, ml_item_id: item, variation_id: variacao, qtd: 1, faturamento: 100, tarifa_venda: 12, has_income_data: false, escrow_amount: 0, ...extra });

async function principal() {
  const silenciar = () => { console.log = () => {}; console.error = () => {}; console.warn = () => {}; };
  const restaurar = () => { console.log = imprimir; };
  silenciar();
  const CP = await import("../lib/vendas/custo-produto");
  const FL = await import("../app/(app)/vendas/financeiro-live");
  const auth = await import("../lib/autenticacao");
  const rotaML = await import("../app/api/ml/vendas/route");
  const rotaSP = await import("../app/api/shopee/vendas/route");
  const G2 = await import("./_guard-v2");
  const sessao = (await auth.emitirTokenSessao(U)).token;
  restaurar();
  const mapa = (mk: "ML" | "Shopee", loja: string, linhas: Linha[]) => CP.montarMapaCustoProduto(mk, loja, linhas as any);
  const resolve = (m: ReturnType<typeof mapa>, v: Linha) => CP.resolverCustoProduto(m, CP.identidadeDaVenda(v as any));
  const fin = (m: ReturnType<typeof mapa>, v: Linha) => CP.financeiroDaVenda(v as any, resolve(m, v));

  secao("\n[1. estados do lookup]");
  t("A3-C1. produto exato + custo cadastrado → WITH_COST; custo = (custo + insumos) × qtd, imposto % da receita", () => {
    const m = mapa("Shopee", SP_A, [anuncio("a1", "Shopee", SP_A, "10", null, 20)]);
    const f = fin(m, venda("Shopee", "10", null, { has_income_data: true, escrow_amount: 80 }));
    assert(f.custoStatus === "PRODUCT_FOUND_WITH_COST" && perto(f.custoProduto, 21) && perto(f.imposto, 10), JSON.stringify(f));
    assert(perto(f.lucro, 80 - 21 - 10) && f.freteStatus === "incluso_no_repasse" && f.tarifaOrigem === "real" && f.produto?.anuncioId === "a1" && f.produto.exata, JSON.stringify(f));
  });
  t("A3-C2. produto exato com custo 0 (não cadastrado) → WITHOUT_COST; custo e lucro null (nunca 0)", () => {
    const m = mapa("Shopee", SP_A, [anuncio("a1", "Shopee", SP_A, "10", null, 0)]);
    const f = fin(m, venda("Shopee", "10", null, { has_income_data: true, escrow_amount: 80 }));
    assert(f.custoStatus === "PRODUCT_FOUND_WITHOUT_COST" && f.custoProduto === null && f.lucro === null && f.roi === null && f.pendencias.includes("custo"), JSON.stringify(f));
    assert(f.produto?.anuncioId === "a1" && f.produto.exata && perto(f.imposto, 10), "sem custo perdeu a referência do produto / o imposto do produto");
  });
  t("A3-C3. produto inexistente → NOT_FOUND; custo, imposto e lucro null; sem referência", () => {
    const f = fin(mapa("ML", ML_A, []), venda("ML", "MLB9", null));
    assert(f.custoStatus === "PRODUCT_NOT_FOUND" && f.custoProduto === null && f.imposto === null && f.lucro === null && f.produto === null, JSON.stringify(f));
  });
  t("A3-C4. ativo=false + custo → WITH_COST (soft-deleted segue fonte de custo)", () => {
    const m = mapa("Shopee", SP_A, [anuncio("a1", "Shopee", SP_A, "10", null, 20, { ativo: false })]);
    assert(resolve(m, venda("Shopee", "10", null)).status === "PRODUCT_FOUND_WITH_COST", "soft-deleted perdeu o custo");
  });
  t("A3-C5. mesmo item em loja A e B: só a loja do mapa; outro marketplace nunca entra", () => {
    const linhas = [anuncio("a", "ML", ML_A, "MLB1", null, 10), anuncio("b", "ML", ML_B, "MLB1", null, 99), anuncio("s", "Shopee", ML_A, "MLB1", null, 77)];
    const r = resolve(mapa("ML", ML_A, linhas), venda("ML", "MLB1", null));
    assert(r.status === "PRODUCT_FOUND_WITH_COST" && r.produto?.id === "a", JSON.stringify(r));
    assert(resolve(mapa("ML", ML_B, linhas), venda("ML", "MLB1", null)).produto?.id === "b", "loja B");
    assert(CP.chaveCustoProduto("ML", ML_A, "MLB1", null) !== CP.chaveCustoProduto("Shopee", ML_A, "MLB1", null) && CP.chaveCustoProduto("ML", ML_A, "MLB1", null) !== CP.chaveCustoProduto("ML", ML_B, "MLB1", null), "chave sem marketplace/loja");
  });
  t("A3-C6. ML: item com 2 variações e venda sem variação → IDENTITY_INCOMPLETE (sem primeira/ativa/pai); item de 1 linha sem variação casa", () => {
    const m = mapa("ML", ML_A, [anuncio("v1", "ML", ML_A, "MLB2", "111", 10), anuncio("v2", "ML", ML_A, "MLB2", "222", 50, { ativo: false }), anuncio("s", "ML", ML_A, "MLB3", null, 5)]);
    const f = fin(m, venda("ML", "MLB2", null));
    assert(f.custoStatus === "PRODUCT_IDENTITY_INCOMPLETE" && f.custoProduto === null && f.imposto === null && f.lucro === null, JSON.stringify(f));
    assert(f.produto !== null && f.produto.anuncioId === null && f.produto.exata === false && f.produto.itemId === "MLB2", "referência fingiu exatidão");
    const um = mapa("ML", ML_A, [anuncio("v1", "ML", ML_A, "MLB4", "111", 10)]);
    assert(resolve(um, venda("ML", "MLB4", null)).status === "PRODUCT_IDENTITY_INCOMPLETE", "variação única escolhida sem a venda dizer qual");
    assert(resolve(m, venda("ML", "MLB3", null)).produto?.id === "s", "item sem variação não casou");
    assert(resolve(m, venda("ML", "MLB2", "222")).produto?.id === "v2", "venda COM variação (A4) não usou a linha exata");
  });
  t("A3-C7. Shopee: model exato usa o model exato", () => {
    const m = mapa("Shopee", SP_A, [anuncio("m1", "Shopee", SP_A, "20", "1", 10), anuncio("m2", "Shopee", SP_A, "20", "2", 30)]);
    assert(resolve(m, venda("Shopee", "20", "2")).produto?.id === "m2", "model errado");
  });
  t("A3-C8. Shopee: model vendido sem linha → NOT_FOUND (nunca o irmão nem o item); item sem model não pega model", () => {
    const m = mapa("Shopee", SP_A, [anuncio("m1", "Shopee", SP_A, "20", "1", 10), anuncio("p", "Shopee", SP_A, "21", null, 10)]);
    assert(resolve(m, venda("Shopee", "20", "3")).status === "PRODUCT_NOT_FOUND", "pegou irmão");
    assert(resolve(m, venda("Shopee", "20", null)).status === "PRODUCT_NOT_FOUND", "item sem model pegou model");
    assert(resolve(m, venda("Shopee", "21", "9")).status === "PRODUCT_NOT_FOUND", "model pegou a linha do item");
  });
  t("A3-C9. SKU igual em dois produtos não decide identidade", () => {
    const m = mapa("Shopee", SP_A, [anuncio("x", "Shopee", SP_A, "30", null, 10, { sku: "IGUAL" }), anuncio("y", "Shopee", SP_A, "31", null, 90, { sku: "IGUAL" })]);
    assert(resolve(m, venda("Shopee", "31", null, { sku: "IGUAL" })).produto?.id === "y" && resolve(m, venda("Shopee", "99", null, { sku: "IGUAL" })).status === "PRODUCT_NOT_FOUND", "SKU decidiu");
  });
  t("A3-C15. quantidade > 1: (custo + insumos) × qtd; imposto % da receita (semântica do CDS)", () => {
    const m = mapa("Shopee", SP_A, [anuncio("a1", "Shopee", SP_A, "10", null, 20)]);
    const f = fin(m, venda("Shopee", "10", null, { qtd: 3, faturamento: 300, has_income_data: true, escrow_amount: 240 }));
    assert(perto(f.custoProduto, 63) && perto(f.imposto, 30) && perto(f.lucro, 240 - 63 - 30) && perto(f.roi, (147 / 63) * 100), JSON.stringify(f));
  });
  t("A3-F. frete só da venda: ML (sem frete real) e Shopee sem repasse → pendente; frete do anúncio nunca entra; tarifa marcada", () => {
    const mML = mapa("ML", ML_A, [anuncio("a", "ML", ML_A, "MLB1", null, 10)]);
    const ml = fin(mML, venda("ML", "MLB1", null));
    assert(ml.custoStatus === "PRODUCT_FOUND_WITH_COST" && ml.freteStatus === "pendente" && ml.lucro === null && ml.pendencias.join() === "frete" && ml.tarifaOrigem === "legada", JSON.stringify(ml));
    const mSP = mapa("Shopee", SP_A, [anuncio("a", "Shopee", SP_A, "10", null, 10)]);
    const sp = fin(mSP, venda("Shopee", "10", null, { has_income_data: false }));
    assert(sp.freteStatus === "pendente" && sp.lucro === null && sp.tarifaOrigem === "estimada", JSON.stringify(sp));
  });

  secao("\n[2. carga em lote (paginação, sem ativo, sem N+1)]");
  t("A3-C14. >1000 anúncios: carga lê todas as páginas; linha 2400 resolve; filtros dono+marketplace+loja, sem ativo", async () => {
    const linhas = Array.from({ length: 2500 }, (_, i) => anuncio(`id-${String(i).padStart(5, "0")}`, "Shopee", SP_A, `I${i}`, null, i + 1, { ativo: i % 2 === 0 }));
    db = { anuncios: [...linhas, anuncio("outra", "Shopee", ML_B, "I2400", null, 777), anuncio("ml", "ML", SP_A, "I2400", null, 555)] };
    leituras = [];
    const r = await CP.carregarMapaCustoProduto(clienteFalso() as any, U, "Shopee", SP_A);
    assert(r.ok && r.mapa.exatos.size === 2500, `carregou ${r.ok ? r.mapa.exatos.size : r.motivo}`);
    assert(r.ok && CP.resolverCustoProduto(r.mapa, { itemId: "I2400", variacaoId: null, variacaoInformada: true }).produto?.id === "id-02400", "linha além de 1000 não resolveu / outra loja ou marketplace venceu");
    const f = leituras.filter((l) => l.tabela === "anuncios");
    assert(f.length === 4 && f.every((l) => l.filtros.some(([, c]) => c === "loja_id") && l.filtros.some(([, c]) => c === "marketplace") && l.filtros.some(([, c]) => c === "user_id") && !l.filtros.some(([, c]) => c === "ativo")), JSON.stringify(f.map((l) => l.filtros)));
  });

  secao("\n[3. rotas reais — venda sempre visível, custo ao vivo, uma carga por requisição]");
  const reqML = () => new Request(`https://exemplo.test/api/ml/vendas?date_from=${DIA}&date_to=${DIA}`, { headers: { cookie: `cds_session=${sessao}` } });
  const reqSP = () => new Request(`https://exemplo.test/api/shopee/vendas?date_from=${DIA}&date_to=${DIA}`, { headers: { cookie: `cds_session=${sessao}` } });
  const lojaML = { id: ML_A, user_id: U, marketplace: "ML", ativo: true, nickname: "a", nome: "a", seller_id: "1", access_token: "<T>", refresh_token: "<R>", token_expires_at: FUTURO(), created_at: "2026-01-01" };
  const lojaSP = { id: SP_A, user_id: U, marketplace: "Shopee", ativo: true, nickname: "s", nome: "s", seller_id: "900", shop_id: "900", partner_id: "2000", partner_key: "k", access_token: "<TS>", refresh_token: "<RS>", token_expires_at: FUTURO(), created_at: "2026-01-01" };
  const pedido = (mk: string, loja: string, order: string, item: string, variacao: string | null, extra: Linha = {}) =>
    ({ id: `${U}_${mk}_${order}_${item}`, user_id: U, marketplace: mk, loja_id: loja, order_id: order, ml_item_id: item, variation_id: variacao, data: DIA, data_pagamento: DIA, data_criacao: DIA, synced_at: PASSADO(), status: "paid", qtd: 1, faturamento: 100, item_subtotal: 100, tarifa_venda: 12, custo: 0, imposto: 0, margem_contrib: 88, cadastrado: false, has_income_data: true, escrow_amount: 80, ...extra });
  const chamar = async (rota: any, req: Request) => { silenciar(); try { const r = await rota.GET(req); return { status: r.status, corpo: await r.json() as any }; } finally { restaurar(); } };
  t("A3-C11/C12/C13. ML: com custo, sem custo, não vinculado e variação pendente — as 4 vendas visíveis, nenhuma com custo 0", async () => {
    db = { lojas: [lojaML], anuncios: [anuncio("c", "ML", ML_A, "MLB1", null, 10), anuncio("z", "ML", ML_A, "MLB2", null, 0), anuncio("v1", "ML", ML_A, "MLB4", "1", 10), anuncio("v2", "ML", ML_A, "MLB4", "2", 10)], pedidos: [
      pedido("ML", ML_A, "o1", "MLB1", null), pedido("ML", ML_A, "o2", "MLB2", null), pedido("ML", ML_A, "o3", "MLB3", null), pedido("ML", ML_A, "o4", "MLB4", null),
    ] };
    const r = await chamar(rotaML, reqML());
    const porOrder = Object.fromEntries((r.corpo.rows ?? []).map((x: any) => [x.orderId, x.financeiro]));
    assert(r.status === 200 && Object.keys(porOrder).sort().join() === "o1,o2,o3,o4" && r.corpo.custoLiveDisponivel === true, JSON.stringify(r.corpo).slice(0, 300));
    assert(porOrder.o1.custoStatus === "PRODUCT_FOUND_WITH_COST" && perto(porOrder.o1.custoProduto, 11), JSON.stringify(porOrder.o1));
    assert(porOrder.o2.custoStatus === "PRODUCT_FOUND_WITHOUT_COST" && porOrder.o3.custoStatus === "PRODUCT_NOT_FOUND" && porOrder.o4.custoStatus === "PRODUCT_IDENTITY_INCOMPLETE", JSON.stringify(porOrder));
    for (const o of ["o2", "o3", "o4"]) assert(porOrder[o].custoProduto === null && porOrder[o].lucro === null, `${o}: virou número`);
  });
  t("A3-C10. custo editado em Meus Produtos (10 → 12) → a PRÓXIMA leitura de Vendas usa 12; nada gravado em pedidos", async () => {
    db = { lojas: [lojaSP], anuncios: [anuncio("c", "Shopee", SP_A, "10", null, 10)], pedidos: [pedido("Shopee", SP_A, "s1", "10", null)] };
    const antes = JSON.stringify(db.pedidos);
    const r1 = await chamar(rotaSP, reqSP());
    db.anuncios[0].custo_produto = 12;
    const r2 = await chamar(rotaSP, reqSP());
    const f1 = r1.corpo.rows?.[0]?.financeiro, f2 = r2.corpo.rows?.[0]?.financeiro;
    assert(perto(f1?.custoProduto, 11) && perto(f2?.custoProduto, 13) && perto(f2?.lucro, 80 - 13 - 10), `${JSON.stringify(f1)} → ${JSON.stringify(f2)}`);
    assert(JSON.stringify(db.pedidos) === antes, "pedidos foi reescrito (snapshot/backfill)");
    assert(r2.corpo.rows[0].custo === 0 && r2.corpo.rows[0].cadastrado === false, "campos legados mudaram de semântica");
  });
  t("A3-N1. sem N+1: 300 vendas → UMA carga de anuncios (páginas fixas), não uma por venda", async () => {
    db = { lojas: [lojaSP], anuncios: [anuncio("c", "Shopee", SP_A, "10", null, 10)], pedidos: Array.from({ length: 300 }, (_, i) => pedido("Shopee", SP_A, `n${i}`, "10", null)) };
    leituras = [];
    const r = await chamar(rotaSP, reqSP());
    const anunciosLidos = leituras.filter((l) => l.tabela === "anuncios").length;
    assert(r.corpo.rows?.length === 300 && anunciosLidos === 2, `vendas=${r.corpo.rows?.length} leituras de anuncios=${anunciosLidos}`);
  });

  secao("\n[4. tela — só o cálculo ao vivo]");
  t("A3-U. totais: lucro só das linhas calculáveis, pendentes contadas (nunca somadas como 0); avisos e frete", () => {
    const m = mapa("Shopee", SP_A, [anuncio("c", "Shopee", SP_A, "10", null, 10)]);
    const comLucro = fin(m, venda("Shopee", "10", null, { has_income_data: true, escrow_amount: 80 }));
    const semCusto = fin(m, venda("Shopee", "99", null, { has_income_data: true, escrow_amount: 80 }));
    const tot = FL.totaisLive([{ faturamento: 100, financeiro: comLucro }, { faturamento: 100, financeiro: semCusto }, { faturamento: 100, financeiro: null }]);
    assert(perto(tot.lucro, 80 - 11 - 10) && tot.pendentes === 2 && perto(tot.faturamentoCalculado, 100) && perto(tot.custo, 11), JSON.stringify(tot));
    assert(FL.avisoCustoLive(comLucro) === null && FL.avisoCustoLive(semCusto)?.texto === "Produto não vinculado" && FL.avisoCustoLive(semCusto)?.href === null, "aviso");
    const semCad = fin(mapa("Shopee", SP_A, [anuncio("z", "Shopee", SP_A, "10", null, 0)]), venda("Shopee", "10", null));
    assert(FL.avisoCustoLive(semCad)?.texto === "Custo não cadastrado" && FL.avisoCustoLive(semCad)?.href === FL.ROTA_MEUS_PRODUTOS, "custo não cadastrado sem link");
    assert(FL.textoFreteLive(comLucro) === "no repasse" && FL.textoFreteLive(semCad) === "pendente" && FL.avisoCustoLive(null)?.texto === "Custo indisponível", "frete/indisponível");
  });

  secao("\n[5. guard]");
  t("I13. Guard V2 limpo (I13_SALES_COST_COMES_FROM_MEUS_PRODUTOS + I12 + demais)", () => {
    const i13 = G2.custoDeVendaForaDeMeusProdutos(), i12 = G2.vendasSemEscopoDeLoja(), v2 = G2.invariantesV2(undefined, { zonas: false });
    assert(i13.length === 0 && i12.length === 0 && v2.length === 0, [...i13, ...i12, ...v2].join(" | "));
  });

  await fila;
  imprimir(`\n${falhou === 0 ? "✓" : "✗"} VENDAS-CUSTO-AO-VIVO — ${ok} passaram, ${falhou} falharam`);
  process.exit(falhou === 0 ? 0 : 1);
}
principal().catch((e) => { imprimir("ERRO FATAL", e?.message ?? e); process.exit(1); });
