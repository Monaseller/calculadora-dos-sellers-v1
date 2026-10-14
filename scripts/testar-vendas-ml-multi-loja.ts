/**
 * CDS V2 — Vendas A5: Mercado Livre MULTI-LOJA SELECIONÁVEL (não agregado) em Vendas.
 *
 * Rotas e helpers REAIS, Supabase em memória, Mercado Livre e Shopee FALSOS (nenhuma rede):
 *   ML     GET /api/ml/vendas — `?loja_id` validada no servidor (dono + ML + ativa); sem loja_id: só a
 *          única, 2+ → 409 ML_STORE_SELECTION_REQUIRED; inválida → 404 LOJA_ML_INVALIDA; cookie ignorado;
 *          cache, custo e sync só da loja escolhida; vendas-hoje mantém a barreira.
 *   Sync   POST /api/sync/manual — `loja_id_ml` resolve SÓ a loja escolhida (sem única, sem cookie).
 *   Tela   app/(app)/vendas/loja-ml.ts — escolha inicial, lista, recusa e corpo do sync manual.
 *   Guard  I16_ML_VENDAS_STORE_IS_EXPLICIT.
 *
 * Uso: npx tsx scripts/testar-vendas-ml-multi-loja.ts
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
process.env.SESSION_SECRET = "segredo-de-teste-com-mais-de-32-bytes-000000";
process.env.ML_CLIENT_ID = "ficticio";
process.env.ML_CLIENT_SECRET = "ficticio";
process.env.SHOPEE_BASE_URL = "https://shopee.teste.invalid";

const U = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ML_A = "11111111-1111-4111-8111-111111111111", ML_B = "22222222-2222-4222-8222-222222222222";
const SP_A = "33333333-3333-4333-8333-333333333333", SP_B = "44444444-4444-4444-8444-444444444444";
const TOKEN_A = "<TOKEN_A>", TOKEN_B = "<TOKEN_B>";
const FUTURO = () => new Date(Date.now() + 3600_000).toISOString();
const PASSADO = () => new Date(Date.now() - 3600_000).toISOString();
const hojeBRT = () => new Date(Date.now() - 3 * 3600_000).toISOString().split("T")[0];
const DIA = "2026-10-01";

// ── Supabase em memória ──────────────────────────────────────────────
type Linha = Record<string, any>;
let db: Record<string, Linha[]> = {};
let leituras: { tabela: string; filtros: [string, string, any][] }[] = [];
let escritas: { tabela: string; op: string; payload: any; filtros: [string, string, any][] }[] = [];
function clienteFalso() {
  return {
    rpc: async () => ({ data: null, error: { message: "rpc_indisponivel_no_teste" } }),
    from(tabela: string) {
      const st: any = { op: "select", payload: null, filtros: [] as [string, string, any][], ini: 0, fim: Infinity, unico: false, ordens: [] as [string, boolean][] };
      const casa = (r: Linha) => st.filtros.every(([k, c, v]: [string, string, any]) =>
        k === "eq" ? String(r[c]) === String(v) : k === "neq" ? String(r[c]) !== String(v) : k === "in" ? (v as any[]).map(String).includes(String(r[c]))
          : k === "is" ? (r[c] ?? null) === v : k === "gte" ? String(r[c] ?? "") >= String(v) : k === "lte" ? String(r[c] ?? "") <= String(v)
          : k === "gt" ? String(r[c] ?? "") > String(v) : k === "lt" ? String(r[c] ?? "") < String(v) : true);
      const exec = () => {
        const ls = (db[tabela] ??= []);
        if (st.op === "update") {
          escritas.push({ tabela, op: "update", payload: st.payload, filtros: [...st.filtros] });
          const alvo = ls.filter(casa); for (const r of alvo) Object.assign(r, st.payload);
          return { data: alvo.map((r) => ({ ...r })), error: null };
        }
        if (st.op === "insert" || st.op === "upsert") {
          const novos = Array.isArray(st.payload) ? st.payload : [st.payload];
          escritas.push({ tabela, op: st.op, payload: novos, filtros: [] });
          for (const n of novos) {
            const i = n.id !== undefined ? ls.findIndex((r) => r.id === n.id) : -1;
            if (i >= 0) Object.assign(ls[i], n); else ls.push({ ...n });
          }
          return { data: novos, error: null };
        }
        leituras.push({ tabela, filtros: [...st.filtros] });
        let out = ls.filter(casa).map((r) => ({ ...r }));
        for (const [c, asc] of [...st.ordens].reverse()) out.sort((a, b) => (asc ? 1 : -1) * (String(a[c] ?? "") < String(b[c] ?? "") ? -1 : String(a[c] ?? "") > String(b[c] ?? "") ? 1 : 0));
        out = out.slice(st.ini, Math.min(out.length, st.fim));
        return st.unico ? { data: out[0] ?? null, error: null } : { data: out, error: null, count: out.length };
      };
      const b: any = new Proxy({}, { get(_a, p: string) {
        if (p === "then") return (res: any, rej: any) => Promise.resolve().then(exec).then(res, rej);
        if (p === "maybeSingle" || p === "single") return async () => { st.unico = true; return exec(); };
        return (...a: any[]) => {
          if (["update", "insert", "upsert"].includes(p)) { st.op = p; st.payload = a[0]; }
          else if (["eq", "neq", "in", "is", "gte", "lte", "gt", "lt"].includes(p)) st.filtros.push([p, a[0], a[1]]);
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

// ── Provedores falsos ────────────────────────────────────────────────
let chamadasML: { url: string; token: string | null }[] = [];
let chamadasShopee: { path: string; shopId: string; sns: string[] }[] = [];
/** shop_id → pedidos que a Shopee falsa lista/detalha para aquela loja. */
let pedidosShopee: Record<string, { order_sn: string; order_status: string; item_id: number }[]> = {};
globalThis.fetch = (async (url: any, init?: any) => {
  const alvo = String(url);
  if (alvo.includes("mercadolibre.com") || alvo.includes("mercadolivre.com")) {
    const h = init?.headers ?? {};
    const auth = typeof h.get === "function" ? h.get("Authorization") : (h.Authorization ?? h.authorization ?? null);
    chamadasML.push({ url: alvo, token: auth ? String(auth).replace(/^Bearer\s+/i, "") : null });
    if (alvo.includes("/users/me")) return { ok: true, status: 200, json: async () => ({ id: 111 }) } as any;
    if (alvo.includes("/orders/search")) return { ok: true, status: 200, json: async () => ({ results: [], paging: { total: 0 } }) } as any;
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" } as any;
  }
  const u = new URL(alvo);
  if (u.hostname !== "shopee.teste.invalid") throw new Error(`teste tentou acessar a rede: ${u.hostname}`);
  const shopId = u.searchParams.get("shop_id") ?? "";
  const lista = pedidosShopee[shopId] ?? [];
  const sns = (u.searchParams.get("order_sn_list") ?? "").split(",").filter(Boolean);
  chamadasShopee.push({ path: u.pathname, shopId, sns });
  const agora = Math.floor(Date.now() / 1000);
  const corpo = u.pathname.endsWith("/get_order_list")
    ? { response: { order_list: lista.map((p) => ({ order_sn: p.order_sn, order_status: p.order_status })), more: false, next_cursor: "" } }
    : u.pathname.endsWith("/get_order_detail")
    ? { response: { order_list: lista.filter((p) => sns.includes(p.order_sn)).map((p) => ({
        order_sn: p.order_sn, order_status: p.order_status, create_time: agora - 3600, update_time: agora - 60, pay_time: agora - 3000, total_amount: 10,
        item_list: [{ item_id: p.item_id, item_name: "produto", model_id: 0, model_quantity_purchased: 1, model_discounted_price: 10 }],
      })) } }
    : { response: {} };
  return { ok: true, status: 200, json: async () => corpo, text: async () => JSON.stringify(corpo) } as any;
}) as any;

function lojaML(id: string, ativo: boolean, token: string, expira = FUTURO(), refresh: string | null = "<REFRESH>") {
  return { id, user_id: U, marketplace: "ML", ativo, nickname: id.slice(0, 4), nome: id.slice(0, 4), seller_id: id.slice(0, 3), access_token: token, refresh_token: refresh, token_expires_at: expira, created_at: "2026-01-01" };
}
function pedidoML(loja: string, order: string, data: string, synced: string, item = "MLB1") {
  return { id: `${U}_ML_${order}_${item}`, user_id: U, marketplace: "ML", loja_id: loja, order_id: order, ml_item_id: item, data, data_pagamento: data, data_criacao: data, synced_at: synced, status: "paid", qtd: 1, faturamento: 10, custo: 0, conta: loja.slice(0, 4) };
}


const OUTRO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ML_X = "55555555-5555-4555-8555-555555555555";   // loja ML de OUTRO dono

async function principal() {
  const silenciar = () => { console.log = () => {}; console.error = () => {}; console.warn = () => {}; };
  const restaurar = () => { console.log = imprimir; };
  silenciar();
  const auth = await import("../lib/autenticacao");
  const vendas = await import("../app/api/ml/vendas/route");
  const vendasHoje = await import("../app/api/ml/vendas-hoje/route");
  const manual = await import("../app/api/sync/manual/route");
  const H = await import("../app/(app)/vendas/loja-ml");
  const G2 = await import("./_guard-v2");
  const sessao = (await auth.emitirTokenSessao(U)).token;
  const cab = (cookies: Record<string, string>) => ({ cookie: Object.entries({ cds_session: sessao, ...cookies }).map(([k, v]) => `${k}=${v}`).join("; ") });
  const getVendas = async (q: string, cookies: Record<string, string> = {}) => {
    const r = await vendas.GET(new Request(`https://exemplo.test/api/ml/vendas?${q}`, { headers: cab(cookies) }));
    return { status: r.status, corpo: await r.json() as any };
  };
  const postManual = async (corpo: Record<string, unknown>, cookies: Record<string, string> = {}) => {
    const r = await manual.POST(new Request("https://exemplo.test/api/sync/manual", { method: "POST", headers: { ...cab(cookies), "content-type": "application/json" }, body: JSON.stringify(corpo) }));
    return { status: r.status, corpo: await r.json() as any };
  };
  const pedidosLidos = () => leituras.filter((l) => l.tabela === "pedidos");
  const soLoja = (tabela: string, loja: string) => leituras.filter((l) => l.tabela === tabela).every((l) => l.filtros.some(([k, c, v]) => k === "eq" && c === "loja_id" && v === loja));
  const zera = () => { leituras = []; escritas = []; chamadasML = []; chamadasShopee = []; };
  const ordens = (r: { corpo: any }) => (r.corpo.rows ?? []).map((x: any) => x.orderId).sort().join(",");
  const duas = () => ({
    lojas: [lojaML(ML_A, true, TOKEN_A), lojaML(ML_B, true, TOKEN_B), { ...lojaML(ML_X, true, "<TOKEN_X>"), user_id: OUTRO }],
    anuncios: [] as Linha[],
    pedidos: [pedidoML(ML_A, "a1", DIA, PASSADO()), pedidoML(ML_A, "a2", DIA, PASSADO()), pedidoML(ML_B, "b1", DIA, PASSADO())],
  });
  restaurar();

  secao("\n[1. /api/ml/vendas — loja ML EXPLÍCITA (seleção, não agregação)]");
  t("A5-B1. 2 lojas ativas, sem loja_id → 409 ML_STORE_SELECTION_REQUIRED com SÓ as lojas do dono; 0 pedidos, 0 ML, 0 escritas", async () => {
    db = duas(); zera(); silenciar();
    const r = await getVendas(`date_from=${DIA}&date_to=${DIA}`);
    restaurar();
    const ids = (r.corpo.lojas ?? []).map((l: any) => l.id).sort().join(",");
    assert(r.status === 409 && r.corpo.codigo === "ML_STORE_SELECTION_REQUIRED" && ids === [ML_A, ML_B].sort().join(","), `${r.status} ${JSON.stringify(r.corpo)}`);
    assert(pedidosLidos().length === 0 && chamadasML.length === 0 && escritas.length === 0, `pedidos=${pedidosLidos().length} ML=${chamadasML.length} escritas=${escritas.length}`);
    assert(!JSON.stringify(r.corpo).includes("<TOKEN"), "recusa expôs token");
  });
  t("A5-B2. loja_id=A → SÓ A (cache/frescor/página com loja_id = A), lojaId da resposta = A", async () => {
    db = duas(); zera(); silenciar();
    const r = await getVendas(`date_from=${DIA}&date_to=${DIA}&loja_id=${ML_A}`);
    restaurar();
    assert(r.status === 200 && ordens(r) === "a1,a2" && r.corpo.lojaId === ML_A, `${r.status} ${ordens(r)} ${r.corpo.lojaId}`);
    assert(pedidosLidos().length > 0 && soLoja("pedidos", ML_A), "leitura de pedidos fora de A");
  });
  t("A5-B3. loja_id=B → SÓ B; nenhuma linha de A", async () => {
    db = duas(); zera(); silenciar();
    const r = await getVendas(`date_from=${DIA}&date_to=${DIA}&loja_id=${ML_B}`);
    restaurar();
    assert(r.status === 200 && ordens(r) === "b1" && r.corpo.lojaId === ML_B, `${r.status} ${ordens(r)}`);
    assert(soLoja("pedidos", ML_B), "leitura de pedidos fora de B");
  });
  t("A5-B4. cookie loja_ativa_id=A + loja_id=B → B (o cookie não é a identidade da rota)", async () => {
    db = duas(); zera(); silenciar();
    const r = await getVendas(`date_from=${DIA}&date_to=${DIA}&loja_id=${ML_B}`, { loja_ativa_id: ML_A });
    restaurar();
    assert(r.status === 200 && ordens(r) === "b1", `${r.status} ${ordens(r)}`);
  });
  t("A5-B5. loja_id INATIVA → 404 LOJA_ML_INVALIDA; nunca cai para a outra; 0 pedidos, 0 ML", async () => {
    db = duas(); db.lojas[1].ativo = false; zera(); silenciar();
    const r = await getVendas(`date_from=${DIA}&date_to=${DIA}&loja_id=${ML_B}`);
    restaurar();
    assert(r.status === 404 && r.corpo.codigo === "LOJA_ML_INVALIDA" && !r.corpo.rows, `${r.status} ${JSON.stringify(r.corpo)}`);
    assert(pedidosLidos().length === 0 && chamadasML.length === 0, `pedidos=${pedidosLidos().length} ML=${chamadasML.length}`);
  });
  t("A5-B6. loja_id de OUTRO dono → 404 LOJA_ML_INVALIDA; 0 pedidos, token alheio nunca usado", async () => {
    db = duas(); zera(); silenciar();
    const r = await getVendas(`date_from=${DIA}&date_to=${DIA}&loja_id=${ML_X}`);
    restaurar();
    assert(r.status === 404 && r.corpo.codigo === "LOJA_ML_INVALIDA", `${r.status} ${JSON.stringify(r.corpo)}`);
    assert(pedidosLidos().length === 0 && chamadasML.length === 0, `pedidos=${pedidosLidos().length} ML=${chamadasML.length}`);
  });
  t("A5-B7. loja_id malformado ou de loja Shopee → 404 LOJA_ML_INVALIDA; 0 pedidos", async () => {
    for (const id of ["nao-e-uuid", "' or 1=1 --", SP_A]) {
      db = duas(); db.lojas.push({ ...lojaML(SP_A, true, "<TOKEN_SP>"), marketplace: "Shopee" }); zera(); silenciar();
      const r = await getVendas(`date_from=${DIA}&date_to=${DIA}&loja_id=${encodeURIComponent(id)}`);
      restaurar();
      assert(r.status === 404 && r.corpo.codigo === "LOJA_ML_INVALIDA" && pedidosLidos().length === 0, `${id}: ${r.status} pedidos=${pedidosLidos().length}`);
    }
  });
  t("A5-B8. UMA loja ativa, sem loja_id → segue funcionando por ela (compatibilidade)", async () => {
    db = duas(); db.lojas[1].ativo = false; zera(); silenciar();
    const r = await getVendas(`date_from=${DIA}&date_to=${DIA}`);
    restaurar();
    assert(r.status === 200 && ordens(r) === "a1,a2" && soLoja("pedidos", ML_A), `${r.status} ${ordens(r)}`);
  });
  t("A5-B9. nenhuma loja ativa → semConexao, 0 pedidos (sem cache do dono)", async () => {
    db = duas(); db.lojas[0].ativo = false; db.lojas[1].ativo = false; zera(); silenciar();
    const r = await getVendas(`date_from=${DIA}&date_to=${DIA}`);
    restaurar();
    assert(r.corpo.semConexao === true && pedidosLidos().length === 0, `${r.status} ${JSON.stringify(r.corpo).slice(0, 160)}`);
  });
  t("A5-B10. mesmo pedido + item em A e em B → loja_id=A devolve só a linha de A (sem mistura, sem dupla contagem)", async () => {
    db = duas(); db.pedidos = [{ ...pedidoML(ML_A, "o1", DIA, PASSADO()), id: "pa" }, { ...pedidoML(ML_B, "o1", DIA, PASSADO()), id: "pb", faturamento: 99 }];
    zera(); silenciar();
    const r = await getVendas(`date_from=${DIA}&date_to=${DIA}&loja_id=${ML_A}`);
    restaurar();
    const rows = r.corpo.rows ?? [];
    assert(rows.length === 1 && rows[0].orderId === "o1" && r.corpo.totalPedidos === 1, `${JSON.stringify(rows).slice(0, 200)} total=${r.corpo.totalPedidos}`);
  });
  t("A5-B11. sync=1 com loja_id=B → o ML recebe SÓ TOKEN_B; nenhuma escrita com loja ≠ B", async () => {
    db = duas(); zera(); silenciar();
    await getVendas(`date_from=${DIA}&date_to=${DIA}&loja_id=${ML_B}&sync=1`);
    restaurar();
    assert(chamadasML.length > 0 && chamadasML.every((c) => c.token === TOKEN_B), `tokens=${chamadasML.map((c) => c.token)}`);
    assert(!escritas.some((e) => (e.payload ?? []).some?.((p: any) => p?.loja_id && p.loja_id !== ML_B)), "🔴 escreveu linha de outra loja");
  });
  t("A5-B12. custo ao vivo da loja escolhida: Meus Produtos lido SÓ com loja_id = B", async () => {
    db = duas(); db.anuncios = [{ id: "an-a", user_id: U, marketplace: "ML", loja_id: ML_A, ml_item_id: "MLB1", variation_id: null, custo_produto: 50 }];
    zera(); silenciar();
    await getVendas(`date_from=${DIA}&date_to=${DIA}&loja_id=${ML_B}`);
    restaurar();
    const lidos = leituras.filter((l) => l.tabela === "anuncios");
    assert(lidos.length > 0 && soLoja("anuncios", ML_B), `custo lido fora de B: ${JSON.stringify(lidos.map((l) => l.filtros))}`);
  });
  t("A5-B13. vendas-hoje continua com a barreira: 2 lojas ativas → 409 MULTI_ML_VENDAS_NOT_READY, 0 pedidos", async () => {
    db = duas(); zera(); silenciar();
    const r = await (vendasHoje.GET as any)(new Request(`https://exemplo.test/api/ml/vendas-hoje?loja_id=${ML_A}`, { headers: cab({ loja_ativa_id: ML_A }) }));
    const corpo = await r.json();
    restaurar();
    assert(r.status === 409 && corpo.codigo === "MULTI_ML_VENDAS_NOT_READY" && pedidosLidos().length === 0, `${r.status} ${JSON.stringify(corpo)}`);
  });

  secao("\n[2. sync manual — a loja ML escolhida, só ela]");
  t("A5-B14. loja_id_ml=B (cookie A) → o ML recebe SÓ TOKEN_B", async () => {
    db = duas(); zera(); silenciar();
    const r = await postManual({ dateFrom: DIA, dateTo: DIA, marketplace: "ML", loja_id_ml: ML_B, noBuffer: true }, { loja_ativa_id: ML_A });
    restaurar();
    assert(r.status === 200 && chamadasML.length > 0 && chamadasML.every((c) => c.token === TOKEN_B), `${r.status} ${JSON.stringify(r.corpo)} tokens=${chamadasML.map((c) => c.token)}`);
  });
  t("A5-B15. loja_id_ml INATIVA com UMA outra ativa → mlErro, 0 ML (nunca cai para a única nem para o cookie)", async () => {
    db = duas(); db.lojas[1].ativo = false; zera(); silenciar();
    const r = await postManual({ dateFrom: DIA, dateTo: DIA, marketplace: "ML", loja_id_ml: ML_B, noBuffer: true }, { loja_ativa_id: ML_A });
    restaurar();
    assert(!!r.corpo.mlErro && r.corpo.ml === undefined && chamadasML.length === 0, `${JSON.stringify(r.corpo)} ML=${chamadasML.length}`);
  });

  secao("\n[3. tela — seleção pura (helper)]");
  t("A5-B16. escolha inicial: 0 → nenhuma; 1 → a única; 2+ → a salva SÓ se está na lista, senão escolha (salva obsoleta descartada)", () => {
    const A = { id: ML_A, nome: "A" }, B = { id: ML_B, nome: "B" };
    const j = (x: unknown) => JSON.stringify(x);
    assert(j(H.escolherLojaMLInicial([], null)) === j({ lojaId: null, exigeEscolha: false, descartarSalva: false }), "0 lojas");
    assert(j(H.escolherLojaMLInicial([A], ML_B)) === j({ lojaId: ML_A, exigeEscolha: false, descartarSalva: true }), "1 loja");
    assert(j(H.escolherLojaMLInicial([A, B], ML_B)) === j({ lojaId: ML_B, exigeEscolha: false, descartarSalva: false }), "2 + salva válida");
    assert(j(H.escolherLojaMLInicial([B, A], null)) === j({ lojaId: null, exigeEscolha: true, descartarSalva: false }), "2 sem salva → escolha (nunca a primeira)");
    assert(j(H.escolherLojaMLInicial([A, B], ML_X)) === j({ lojaId: null, exigeEscolha: true, descartarSalva: true }), "2 + salva obsoleta");
  });
  t("A5-B17. lista de lojas: só ML (nome de exibição → nickname → fallback); recusa 409 → {id, rótulo}", () => {
    const l = H.lojasMLDaLista([{ id: ML_A, marketplace: "ML", nome_exibicao: "Loja A" }, { id: ML_B, marketplace: "ML", nickname: "nickb" }, { id: SP_A, marketplace: "Shopee", nome_exibicao: "S" }, { id: "x", marketplace: "ML" }, null]);
    assert(JSON.stringify(l) === JSON.stringify([{ id: ML_A, nome: "Loja A" }, { id: ML_B, nome: "nickb" }, { id: "x", nome: "Conta do Mercado Livre" }]), JSON.stringify(l));
    assert(H.lojasMLDaLista({ erro: true }).length === 0, "não-lista");
    const r = H.lojasMLDaRecusa([{ id: ML_A, rotulo: "a" }, { rotulo: "sem id" }]);
    assert(JSON.stringify(r) === JSON.stringify([{ id: ML_A, nome: "a" }]), JSON.stringify(r));
  });
  t("A5-B18. corpo do sync manual: escolhida → loja_id_ml; 2+ sem escolha → só Shopee; 0/1 → todos", () => {
    const A = { id: ML_A, nome: "A" }, B = { id: ML_B, nome: "B" };
    const j = (x: unknown) => JSON.stringify(x);
    assert(j(H.corpoMarketplaceSyncManual(ML_B, [A, B])) === j({ marketplace: "todos", loja_id_ml: ML_B }), "escolhida");
    assert(j(H.corpoMarketplaceSyncManual(null, [A, B])) === j({ marketplace: "Shopee" }), "2+ sem escolha");
    assert(j(H.corpoMarketplaceSyncManual(null, [A])) === j({ marketplace: "todos" }), "1");
    assert(j(H.corpoMarketplaceSyncManual(null, null)) === j({ marketplace: "todos" }), "lista indisponível");
  });

  secao("\n[4. guard]");
  t("A5-B19. I16 I16_ML_VENDAS_STORE_IS_EXPLICIT limpo", () => {
    const v = G2.lojaMLVendasNaoExplicita();
    assert(v.length === 0, v.join(" | "));
  });
  t("A5-B20. invariantes V2 limpos (I1–I16)", () => {
    const v = G2.invariantesV2(undefined, { zonas: false });
    assert(v.length === 0, v.join(" | "));
  });

  await fila;
  imprimir(`\n${falhou === 0 ? "✓" : "✗"} VENDAS-ML-MULTI-LOJA — ${ok} passaram, ${falhou} falharam`);
  process.exit(falhou === 0 ? 0 : 1);
}

principal().catch((e) => { imprimir("ERRO FATAL", e?.message ?? e); process.exit(1); });
