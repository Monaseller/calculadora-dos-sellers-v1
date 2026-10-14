/**
 * CDS V2 — Vendas A2: leituras/escritas de vendas com escopo de LOJA explícito.
 *
 * Rotas e motores REAIS, Supabase em memória, Mercado Livre e Shopee FALSOS (nenhuma rede):
 *   ML     GET /api/ml/vendas — cache, frescor e páginas só da loja resolvida no servidor;
 *          sem loja resolvida → falha fechado; barreira MULTI_ML_VENDAS_NOT_READY intacta.
 *   Shopee syncShopeeForUserV2 — "já existe", leitura e UPDATE de status só da loja da execução;
 *          row existente de OUTRA loja do dono (mesmo id legado) nunca é sobrescrita.
 *   Agente criarLeiturasDeVendas — contrato OWNER_AGGREGATE: as lojas do dono entram de propósito,
 *          sem virar "uma loja" implícita.
 *   Guard  I12_SALES_STORE_SCOPE_IS_EXPLICIT.
 *
 * Uso: npx tsx scripts/testar-vendas-escopo-loja.ts
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

async function principal() {
  const silenciar = () => { console.log = () => {}; console.error = () => {}; console.warn = () => {}; };
  const restaurar = () => { console.log = imprimir; };
  silenciar();
  const auth = await import("../lib/autenticacao");
  const vendas = await import("../app/api/ml/vendas/route");
  const SS = await import("../lib/sync-shopee");
  const AG = await import("../lib/agentes/dados/vendas");
  const G2 = await import("./_guard-v2");
  const sessao = (await auth.emitirTokenSessao(U)).token;
  const req = (caminho: string, cookies: Record<string, string> = {}) =>
    new Request(`https://exemplo.test${caminho}`, { headers: { cookie: Object.entries({ cds_session: sessao, ...cookies }).map(([k, v]) => `${k}=${v}`).join("; ") } });
  const getVendas = async (q: string, cookies: Record<string, string> = {}) => {
    const r = await vendas.GET(req(`/api/ml/vendas?${q}`, cookies));
    return { status: r.status, corpo: await r.json() as any };
  };
  const pedidosLidos = () => leituras.filter((l) => l.tabela === "pedidos");
  const zera = () => { leituras = []; escritas = []; chamadasML = []; chamadasShopee = []; };
  restaurar();

  secao("\n[1. /api/ml/vendas — só a loja resolvida]");
  t("A2-M1. loja A (única ativa) lê SÓ pedidos de A; B (histórica, inativa) do mesmo dono nunca entra", async () => {
    db = { lojas: [lojaML(ML_A, true, TOKEN_A), lojaML(ML_B, false, TOKEN_B)], pedidos: [
      pedidoML(ML_A, "a1", DIA, PASSADO()), pedidoML(ML_A, "a2", DIA, PASSADO()), pedidoML(ML_B, "b1", DIA, PASSADO()),
    ] };
    zera(); silenciar();
    const r = await getVendas(`date_from=${DIA}&date_to=${DIA}`);
    restaurar();
    const orders = (r.corpo.rows ?? []).map((x: any) => x.orderId).sort().join(",");
    assert(r.status === 200 && orders === "a1,a2" && r.corpo.lojaId === ML_A, `${r.status} ${orders} ${JSON.stringify(r.corpo).slice(0, 200)}`);
    assert(pedidosLidos().length > 0 && pedidosLidos().every((l) => l.filtros.some(([k, c, v]) => k === "eq" && c === "loja_id" && v === ML_A)), "leitura de pedidos sem loja_id = A");
  });
  t("A2-M2. mesmo dono + mesmo item (MLB1) em A e em B: só as linhas de A, sem mistura", async () => {
    db = { lojas: [lojaML(ML_A, true, TOKEN_A), lojaML(ML_B, false, TOKEN_B)], pedidos: [
      pedidoML(ML_A, "x1", DIA, PASSADO(), "MLB1"), pedidoML(ML_B, "x2", DIA, PASSADO(), "MLB1"), pedidoML(ML_B, "x3", DIA, PASSADO(), "MLB1"),
    ] };
    zera(); silenciar();
    const r = await getVendas(`date_from=${DIA}&date_to=${DIA}`);
    restaurar();
    const rows = r.corpo.rows ?? [];
    assert(rows.length === 1 && rows[0].orderId === "x1" && rows[0].mlItemId === "MLB1", JSON.stringify(rows));
  });
  t("A2-M3. frescor de hoje de A ignora a linha MAIS RECENTE de B: A velha → sincroniza A (TOKEN_A)", async () => {
    const hoje = hojeBRT();
    db = { lojas: [lojaML(ML_A, true, TOKEN_A), lojaML(ML_B, false, TOKEN_B)], anuncios: [], pedidos: [
      pedidoML(ML_A, "h1", hoje, new Date(Date.now() - 2 * 3600_000).toISOString()), pedidoML(ML_B, "h2", hoje, new Date().toISOString()),
    ] };
    zera(); silenciar();
    const r = await getVendas(`date_from=${hoje}&date_to=${hoje}`);
    restaurar();
    const busca = chamadasML.filter((c) => c.url.includes("/orders/search"));
    assert(r.status === 200 && busca.length > 0 && busca.every((c) => c.token === TOKEN_A), `frescor de B mascarou A: ${busca.length} buscas ${busca.map((c) => c.token)}`);
  });
  t("A2-M4. loja inativa histórica B com dado MAIS NOVO não entra no read de A (nem no cache, nem no frescor)", async () => {
    const hoje = hojeBRT();
    db = { lojas: [lojaML(ML_A, true, TOKEN_A), lojaML(ML_B, false, TOKEN_B)], anuncios: [], pedidos: [
      pedidoML(ML_B, "velho-b", hoje, new Date().toISOString()),
    ] };
    zera(); silenciar();
    const r = await getVendas(`date_from=${hoje}&date_to=${hoje}`);
    restaurar();
    assert(r.status === 200 && (r.corpo.rows ?? []).length === 0, JSON.stringify(r.corpo.rows));
    assert(chamadasML.some((c) => c.url.includes("/orders/search") && c.token === TOKEN_A), "A sem cache próprio não sincronizou (cache de B contou como de A)");
  });
  t("A2-M5. barreira intacta: 2 lojas ML ATIVAS → 409 MULTI_ML_VENDAS_NOT_READY, 0 leitura de pedidos, 0 ML", async () => {
    db = { lojas: [lojaML(ML_A, true, TOKEN_A), lojaML(ML_B, true, TOKEN_B)], pedidos: [pedidoML(ML_A, "a1", DIA, PASSADO())] };
    zera(); silenciar();
    const r = await getVendas(`date_from=${DIA}&date_to=${DIA}`, { loja_ativa_id: ML_A });
    restaurar();
    assert(r.status === 409 && r.corpo.codigo === "MULTI_ML_VENDAS_NOT_READY", `${r.status} ${JSON.stringify(r.corpo)}`);
    assert(pedidosLidos().length === 0 && chamadasML.length === 0, `pedidos lidos=${pedidosLidos().length} ML=${chamadasML.length}`);
  });
  t("A2-M6. sem loja resolvida (contexto inválido / sem conta ativa) → falha fechado, 0 leitura; credencial vencida → cache SÓ dela, sem ML", async () => {
    db = { lojas: [lojaML(ML_A, true, TOKEN_A), lojaML(ML_B, false, TOKEN_B)], pedidos: [pedidoML(ML_A, "a1", DIA, PASSADO()), pedidoML(ML_B, "b1", DIA, PASSADO())] };
    zera(); silenciar();
    const inval = await getVendas(`date_from=${DIA}&date_to=${DIA}`, { loja_ativa_id: ML_B });
    restaurar();
    assert(inval.corpo.semConexao === true && pedidosLidos().length === 0, `contexto inválido leu ${pedidosLidos().length} / ${JSON.stringify(inval.corpo)}`);
    db = { lojas: [lojaML(ML_B, false, TOKEN_B)], pedidos: [pedidoML(ML_B, "b1", DIA, PASSADO())] };
    zera(); silenciar();
    const sem = await getVendas(`date_from=${DIA}&date_to=${DIA}`);
    restaurar();
    assert(sem.corpo.semConexao === true && pedidosLidos().length === 0, `sem conta ativa leu o cache do dono: ${JSON.stringify(sem.corpo)}`);
    db = { lojas: [lojaML(ML_A, true, TOKEN_A, PASSADO(), null), lojaML(ML_B, false, TOKEN_B)], pedidos: [pedidoML(ML_A, "a1", DIA, PASSADO()), pedidoML(ML_B, "b1", DIA, PASSADO())] };
    zera(); silenciar();
    const venc = await getVendas(`date_from=${DIA}&date_to=${DIA}`);
    restaurar();
    const orders = (venc.corpo.rows ?? []).map((x: any) => x.orderId).join(",");
    assert(orders === "a1" && chamadasML.length === 0, `credencial vencida: ${orders} ML=${chamadasML.length}`);
  });

  secao("\n[2. sync Shopee — a loja B nunca toca a loja A]");
  const lojaSP = (lojaId: string, shopId: number) => ({ lojaId, partnerId: "2000", partnerKey: "chave", accessToken: "tok", shopId, nickname: lojaId.slice(0, 4) });
  const linhaA = () => ({ id: `${U}_SHOPEE_SN1_1001_nv`, user_id: U, marketplace: "Shopee", loja_id: SP_A, order_id: "SN1", ml_item_id: "1001", variation_id: null, status: "shipped", status_shopee_raw: "SHIPPED", data: DIA, qtd: 1, faturamento: 10, financial_reconciled_at: null });
  const syncSP = async (loja: ReturnType<typeof lojaSP>) => {
    const dia = hojeBRT();
    silenciar();
    try { return await SS.syncShopeeForUserV2(U, dia, dia, false, loja); } finally { restaurar(); }
  };
  t("A2-S1. sync de B lista SN1 (que é de A) como COMPLETED: status de A NÃO muda; nenhuma escrita com filtro de A", async () => {
    db = { lojas: [], anuncios: [], pedidos: [linhaA()], dashboard_resumos_diarios: [] };
    pedidosShopee = { "901": [{ order_sn: "SN1", order_status: "COMPLETED", item_id: 1001 }, { order_sn: "SNB", order_status: "READY_TO_SHIP", item_id: 2002 }] };
    zera();
    await syncSP(lojaSP(SP_B, 901));
    const a = db.pedidos.find((r) => r.id === linhaA().id)!;
    assert(JSON.stringify(a) === JSON.stringify(linhaA()), `row de A mudou: ${JSON.stringify(a)}`);
    const upds = escritas.filter((e) => e.tabela === "pedidos" && e.op === "update");
    assert(upds.every((e) => e.filtros.some(([k, c, v]) => k === "eq" && c === "loja_id" && v === SP_B)), "UPDATE de pedidos sem loja_id = B");
    const lidas = leituras.filter((l) => l.tabela === "pedidos" && l.filtros.some(([k, c]) => k === "in" && c === "order_id"));
    assert(lidas.length > 0 && lidas.every((l) => l.filtros.some(([k, c, v]) => k === "eq" && c === "loja_id" && v === SP_B)), "leitura por order_id sem loja_id = B");
  });
  t("A2-S2. mesmo dono + mesmo provider id (SN1/1001) em A e B: o upsert de B não sobrescreve A; o pedido próprio de B é gravado em B", async () => {
    db = { lojas: [], anuncios: [], pedidos: [linhaA()], dashboard_resumos_diarios: [] };
    pedidosShopee = { "901": [{ order_sn: "SN1", order_status: "READY_TO_SHIP", item_id: 1001 }, { order_sn: "SNB", order_status: "READY_TO_SHIP", item_id: 2002 }] };
    zera();
    await syncSP(lojaSP(SP_B, 901));
    const a = db.pedidos.find((r) => r.id === linhaA().id)!;
    assert(a.loja_id === SP_A && JSON.stringify(a) === JSON.stringify(linhaA()), `row de A sobrescrita por B: ${JSON.stringify(a)}`);
    const upserts = escritas.filter((e) => e.tabela === "pedidos" && e.op === "upsert").flatMap((e) => e.payload as any[]);
    assert(!upserts.some((p) => p.id === linhaA().id), "id de A entrou no upsert de B");
    const deB = db.pedidos.filter((r) => r.order_id === "SNB");
    assert(deB.length === 1 && deB[0].loja_id === SP_B, `pedido de B: ${JSON.stringify(deB)}`);
    const cls = SS.classificarExistentesShopee([
      { id: "x", loja_id: SP_A, reconciliada: true }, { id: "y", loja_id: SP_B, reconciliada: true }, { id: "z", loja_id: null, reconciliada: true }, { id: "w", loja_id: SP_B, reconciliada: false },
    ], SP_B);
    assert([...cls.deOutraLoja].join() === "x" && [...cls.reconciliadas].sort().join() === "y,z", JSON.stringify({ o: [...cls.deOutraLoja], r: [...cls.reconciliadas] }));
  });
  t("A2-S3. loja única preservada: sync de A sobre o próprio SN1 corrige o status de A e não rebusca o que já existe", async () => {
    db = { lojas: [], anuncios: [], pedidos: [linhaA()], dashboard_resumos_diarios: [] };
    pedidosShopee = { "900": [{ order_sn: "SN1", order_status: "COMPLETED", item_id: 1001 }] };
    zera();
    await syncSP(lojaSP(SP_A, 900));
    const a = db.pedidos.find((r) => r.id === linhaA().id)!;
    assert(a.status_shopee_raw === "COMPLETED" && a.loja_id === SP_A, `status de A não corrigido: ${JSON.stringify(a)}`);
    const detalhes = chamadasShopee.filter((c) => c.path.endsWith("/get_order_detail"));
    assert(!detalhes.some((c) => c.sns.includes("SN1")), "SN1 (já existe em A) foi rebuscado");
  });
  t("A2-S4. \"já existe\" exige a loja: sem loja → erro; consulta real filtra loja_id", async () => {
    let lancou = false;
    try { await SS.filtrarOrderSnsAusentes(U, "", ["SN1"]); } catch { lancou = true; }
    assert(lancou, "sem loja não falhou");
    db = { pedidos: [linhaA()] }; zera();
    const ausentes = await SS.filtrarOrderSnsAusentes(U, SP_B, ["SN1"]);
    assert(ausentes.join() === "SN1", `pedido de A contou como existente em B: ${ausentes}`);
    assert(leituras.every((l) => l.filtros.some(([k, c, v]) => k === "eq" && c === "loja_id" && v === SP_B)), "consulta sem loja_id");
  });

  secao("\n[3. agente — contrato OWNER_AGGREGATE]");
  t("A2-G1. agregado do DONO: as duas lojas entram de propósito; filtro é dono + paid, nunca uma loja implícita", async () => {
    db = { pedidos: [
      { ...pedidoML(ML_A, "ga", DIA, PASSADO()), sku: "S1", anuncio: "p", item_subtotal: 10 },
      { ...pedidoML(ML_B, "gb", DIA, PASSADO()), sku: "S1", anuncio: "p", item_subtotal: 10 },
      { ...pedidoML(ML_A, "outro", DIA, PASSADO()), user_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", sku: "S1", anuncio: "p", item_subtotal: 10 },
    ] };
    zera();
    const r = await AG.criarLeiturasDeVendas(U)({ dataInicio: DIA, dataFim: DIA, marketplace: "ML" });
    assert(r.erro === null && r.linhas.map((l) => l.order_id).sort().join() === "ga,gb", JSON.stringify(r));
    const f = AG.filtrosVendas(U, "ML");
    assert(f.user_id === U && f.status === "paid" && !("loja_id" in f), JSON.stringify(f));
    assert(leituras.length > 0 && leituras.every((l) => !l.filtros.some(([, c]) => c === "loja_id") && l.filtros.some(([k, c, v]) => k === "eq" && c === "user_id" && v === U)), "agregado virou single-store ou perdeu o dono");
  });

  secao("\n[4. guard]");
  t("I12. Guard V2 limpo (I12_SALES_STORE_SCOPE_IS_EXPLICIT + I7 + I8 + demais)", () => {
    const i12 = G2.vendasSemEscopoDeLoja(), i7 = G2.credenciaisMLNaoEscopadasPorLoja(), v2 = G2.invariantesV2(undefined, { zonas: false });
    assert(i12.length === 0 && i7.length === 0 && v2.length === 0, [...i12, ...i7, ...v2].join(" | "));
  });

  await fila;
  imprimir(`\n${falhou === 0 ? "✓" : "✗"} VENDAS-ESCOPO-LOJA — ${ok} passaram, ${falhou} falharam`);
  process.exit(falhou === 0 ? 0 : 1);
}
principal().catch((e) => { imprimir("ERRO FATAL", e?.message ?? e); process.exit(1); });
