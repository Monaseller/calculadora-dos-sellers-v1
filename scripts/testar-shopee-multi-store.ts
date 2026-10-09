/**
 * Suite MULTI-LOJA Shopee (legado) — Shopee multi-store V1.
 *
 * Remove a premissa "uma Shopee por dono": nenhum fluxo legado escolhe loja
 * pela data de criacao. Executa as rotas REAIS (/api/shopee/vendas,
 * /api/shopee/importar-anuncios, /api/sync, /api/admin/shopee/status) e o
 * sync legado com:
 *   - sessao real (emitirTokenSessao);
 *   - Supabase em memoria (lojas, pedidos, anuncios — nada real);
 *   - Shopee FALSA que registra shop_id/partner_id de cada chamada (nenhum
 *     provider real: qualquer URL fora da Shopee falsa lanca).
 *
 * Cenario: dono X com loja A (antiga) e loja B (R.D.); dono Y com loja C.
 *
 *   npx tsx scripts/testar-shopee-multi-store.ts
 */
import "./_server-only-inerte";
import Module from "node:module";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// CDS GUARD V2 (Fase 0B): invariantes estruturais + zonas protegidas no lugar da cerca "arquivo nao mudou desde a base"
import { invariantesV2 } from "./_guard-v2";

const RAIZ = join(__dirname, "..");
const BASE = "5fdb51f";
let passou = 0, falhou = 0;
let fila: Promise<void> = Promise.resolve();
function t(nome: string, fn: () => void | Promise<void>) {
  fila = fila.then(async () => {
    try { await fn(); passou++; console.log(`  PASS  ${nome}`); }
    catch (e: any) { falhou++; console.log(`  FALHA ${nome} -> ${e?.message ?? e}`); }
  });
}
function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://placeholder-de-teste.invalid";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "chave-de-teste-invalida";
process.env.SUPABASE_SERVICE_ROLE_KEY = "chave-de-teste-invalida";
process.env.SESSION_SECRET = "segredo-de-teste-com-mais-de-32-bytes-000000";
process.env.SHOPEE_BASE_URL = "https://shopee.teste.invalid";
process.env.CRON_SECRET = "cron-de-teste";

const DONO_X = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", DONO_Y = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LOJA_A = "11111111-1111-4111-8111-111111111111", LOJA_B = "22222222-2222-4222-8222-222222222222", LOJA_C = "33333333-3333-4333-8333-333333333333";
const FUTURO = new Date(Date.now() + 6 * 3600e3).toISOString();
const loja = (id: string, dono: string, shop: string, partner: string, ativo: boolean, criada: string) => ({
  id, user_id: dono, marketplace: "Shopee", seller_id: shop, shop_id: shop, partner_id: partner, partner_key: `chave-ficticia-${partner}`,
  access_token: `<access-${shop}>`, refresh_token: `<refresh-${shop}>`, token_expires_at: FUTURO, ativo, nome: `Shopee ${shop}`, nickname: `Shopee ${shop}`,
  created_at: criada, shopee_sincronizado_ate: null,
});
const pedido = (lojaId: string, dono: string, sn: string) => ({
  id: `${dono}_SHOPEE_${sn}_1_nv`, user_id: dono, marketplace: "Shopee", loja_id: lojaId, order_id: sn, ml_item_id: "1", variation_id: null,
  anuncio: "Item", status: "paid", qtd: 1, valor_unit: 10, faturamento: 10, data: "2026-10-01", data_criacao: "2026-10-01", data_pagamento: "2026-10-01",
  synced_at: "2026-10-01T12:00:00.000Z",
});

// ── Supabase em memoria ──────────────────────────────────────────────
type Linha = Record<string, any>;
let db: Record<string, Linha[]> = {};
/** Loja cuja leitura de credencial LANCA (teste de isolamento de falha no nightly). */
let falharLoja: string | null = null;
function cenario(bAtiva: boolean) {
  db = {
    lojas: [
      loja(LOJA_A, DONO_X, "419809235", "2038003", true, "2026-07-01T00:00:00Z"),
      loja(LOJA_B, DONO_X, "481902588", "2047853", bAtiva, "2026-10-08T18:40:00Z"),   // mais recente
      loja(LOJA_C, DONO_Y, "555000111", "2038003", true, "2026-08-01T00:00:00Z"),
    ],
    pedidos: [
      pedido(LOJA_A, DONO_X, "A0001"), pedido(LOJA_A, DONO_X, "A0002"),
      pedido(LOJA_B, DONO_X, "B0001"), pedido(LOJA_B, DONO_X, "B0002"), pedido(LOJA_B, DONO_X, "B0003"),
      pedido(LOJA_C, DONO_Y, "C0001"),
    ],
    anuncios: [],
  };
}
function clienteFalso() {
  return {
    rpc: async () => ({ data: null, error: { message: "rpc_indisponivel_no_teste" } }),
    from(tabela: string) {
      const st: any = { op: "select", payload: null, filtros: [] as any[], ini: 0, fim: Infinity, unico: false, ordens: [] as any[] };
      const casa = (r: Linha) => st.filtros.every(([k, c, v]: any) =>
        k === "eq" ? String(r[c]) === String(v) : k === "in" ? (v as any[]).map(String).includes(String(r[c])) : k === "is" ? (r[c] ?? null) === v
          : k === "gte" ? String(r[c] ?? "") >= String(v) : k === "lte" ? String(r[c] ?? "") <= String(v) : k === "lt" ? String(r[c] ?? "") < String(v) : true);
      const exec = () => {
        if (falharLoja && tabela === "lojas" && st.filtros.some(([k, c, v]: any) => k === "eq" && c === "id" && v === falharLoja)) throw new Error("falha-injetada-no-teste");
        const ls = (db[tabela] ??= []);
        if (st.op === "update") { const alvo = ls.filter(casa); for (const r of alvo) Object.assign(r, st.payload); return { data: alvo.map((r) => ({ ...r })), error: null }; }
        if (st.op === "insert" || st.op === "upsert") { const novos = Array.isArray(st.payload) ? st.payload : [st.payload]; for (const n of novos) ls.push({ ...n }); return { data: novos, error: null }; }
        let out = ls.filter(casa).map((r) => ({ ...r }));
        for (const [c, asc] of [...st.ordens].reverse()) out.sort((a, b) => (asc ? 1 : -1) * (String(a[c] ?? "") < String(b[c] ?? "") ? -1 : String(a[c] ?? "") > String(b[c] ?? "") ? 1 : 0));
        out = out.slice(st.ini, Math.min(out.length, st.fim));
        return st.unico ? { data: out[0] ?? null, error: null } : { data: out, error: null, count: out.length };
      };
      const b: any = new Proxy({}, { get(_a, p: string) {
        if (p === "then") return (ok: any, err: any) => Promise.resolve().then(exec).then(ok, err);
        if (p === "maybeSingle" || p === "single") return async () => { st.unico = true; return exec(); };
        return (...a: any[]) => {
          if (p === "update" || p === "insert" || p === "upsert") { st.op = p; st.payload = a[0]; }
          else if (["eq", "in", "is", "gte", "lte", "lt"].includes(p)) st.filtros.push([p, a[0], a[1]]);
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

// ── Shopee falsa (registra loja/app de cada chamada) ─────────────────
let chamadas: { path: string; shopId: string; partnerId: string }[] = [];
globalThis.fetch = (async (url: any) => {
  const u = new URL(String(url));
  if (u.hostname !== "shopee.teste.invalid") throw new Error(`teste tentou acessar a rede: ${u.hostname}`);
  chamadas.push({ path: u.pathname, shopId: u.searchParams.get("shop_id") ?? "", partnerId: u.searchParams.get("partner_id") ?? "" });
  const corpo = u.pathname.endsWith("/get_order_list") ? { response: { order_list: [], more: false } }
    : u.pathname.endsWith("/get_item_list") ? { response: { item: [], has_next_page: false, total_count: 0 } }
    : { response: {} };
  return { ok: true, status: 200, json: async () => corpo, text: async () => JSON.stringify(corpo) } as any;
}) as any;

async function principal() {
  const auth = await import("../lib/autenticacao");
  const SEL = await import("../lib/shopee-loja-selecao");
  const vendas = await import("../app/api/shopee/vendas/route");
  const importar = await import("../app/api/shopee/importar-anuncios/route");
  const cron = await import("../app/api/sync/route");
  const status = await import("../app/api/admin/shopee/status/route");
  const SS = await import("../lib/sync-shopee");
  const sessaoX = (await auth.emitirTokenSessao(DONO_X)).token;
  const H = "https://www.calculadoradossellers.com.br";
  const req = (caminho: string, cookies: Record<string, string> = {}, init: RequestInit = {}) =>
    new Request(`${H}${caminho}`, { ...init, headers: { ...(init.headers as any), cookie: Object.entries({ cds_session: sessaoX, ...cookies }).map(([k, v]) => `${k}=${v}`).join("; ") } });
  const idsVendas = async (r: Response) => { const d = await r.json(); return (d.rows ?? []).map((x: any) => x.orderId ?? x.order_id).sort().join(","); };
  const PERIODO = "date_from=2026-10-01&date_to=2026-10-02";

  console.log("\n[selecao pura]");
  t("G0. escolherLojaShopee: explicita valida; cookie so se ativo e do dono; unica; ambigua → STORE_SELECTION_REQUIRED; nunca a mais recente", () => {
    const ativas = [{ id: LOJA_A, rotulo: "A" }, { id: LOJA_B, rotulo: "B" }];
    assert(SEL.escolherLojaShopee(ativas, { lojaIdExplicito: LOJA_B, usarCookie: true }).ok, "explicita");
    const amb = SEL.escolherLojaShopee(ativas, { usarCookie: true });
    assert(!amb.ok && amb.motivo === "STORE_SELECTION_REQUIRED", "ambiguidade nao detectada (escolheu uma?)");
    assert(SEL.escolherLojaShopee(ativas, { lojaIdCookie: LOJA_B, usarCookie: true }).ok, "cookie valido");
    const ck = SEL.escolherLojaShopee(ativas, { lojaIdCookie: LOJA_B, usarCookie: false });
    assert(!ck.ok, "cookie decidiu onde nao podia");
    const fora = SEL.escolherLojaShopee([{ id: LOJA_A, rotulo: "A" }], { lojaIdCookie: LOJA_B, usarCookie: true });
    assert(fora.ok && fora.lojaId === LOJA_A && fora.origem === "unica", "cookie de loja inativa/alheia aceito");
    const inv = SEL.escolherLojaShopee(ativas, { lojaIdExplicito: LOJA_C, usarCookie: true });
    assert(!inv.ok && inv.motivo === "LOJA_INVALIDA", "explicita alheia aceita");
    assert(!SEL.escolherLojaShopee(ativas, { usarCookie: false, exigirExplicita: true }).ok, "exigirExplicita sem loja aceita");
  });

  console.log("\n[A-C. Vendas legado: leitura so da loja escolhida]");
  t("A. Vendas loja A → so pedidos de A (0 da B), sem nenhuma chamada a Shopee", async () => {
    cenario(true); chamadas = [];
    const ids = await idsVendas(await vendas.GET(req(`/api/shopee/vendas?${PERIODO}&loja_id=${LOJA_A}`)));
    assert(ids === "A0001,A0002" && chamadas.length === 0, `${ids} / ${chamadas.length}`);
  });
  t("B. Vendas loja B → so pedidos de B (0 da A)", async () => {
    cenario(true);
    const ids = await idsVendas(await vendas.GET(req(`/api/shopee/vendas?${PERIODO}&loja_id=${LOJA_B}`)));
    assert(ids === "B0001,B0002,B0003", ids);
  });
  t("C. sem loja_id: 2 ativas + cookie 'Usar esta' valido → a do cookie; sem cookie → 409 (nunca a mais recente, nunca a uniao)", async () => {
    cenario(true);
    assert(await idsVendas(await vendas.GET(req(`/api/shopee/vendas?${PERIODO}`, { shopee_loja_id: LOJA_A }))) === "A0001,A0002", "cookie A");
    const r = await vendas.GET(req(`/api/shopee/vendas?${PERIODO}`));
    const d = await r.json();
    assert(r.status === 409 && d.codigo === "STORE_SELECTION_REQUIRED" && d.lojas.length === 2 && !JSON.stringify(d).includes("chave-ficticia") && !JSON.stringify(d).includes("<access"), JSON.stringify(d));
  });
  t("K/V. ESTADO ATUAL (R.D. inativa): sem loja_id e mesmo com o cookie da R.D. → so a loja antiga; os rows da R.D. NAO aparecem; R.D. explicita → recusada", async () => {
    cenario(false);
    assert(await idsVendas(await vendas.GET(req(`/api/shopee/vendas?${PERIODO}`))) === "A0001,A0002", "R.D. vazou na loja antiga");
    assert(await idsVendas(await vendas.GET(req(`/api/shopee/vendas?${PERIODO}`, { shopee_loja_id: LOJA_B }))) === "A0001,A0002", "cookie da R.D. inativa aceito");
    const r = await vendas.GET(req(`/api/shopee/vendas?${PERIODO}&loja_id=${LOJA_B}`));
    assert(r.status === 404, `${r.status}`);
    assert(db.pedidos.filter((p) => p.loja_id === LOJA_B).length === 3, "dados da R.D. apagados");
  });
  t("H. loja de OUTRO dono (explicita ou cookie) → recusada / ignorada", async () => {
    cenario(true);
    assert((await vendas.GET(req(`/api/shopee/vendas?${PERIODO}&loja_id=${LOJA_C}`))).status === 404, "loja alheia explicita");
    assert((await vendas.GET(req(`/api/shopee/vendas?${PERIODO}`, { shopee_loja_id: LOJA_C }))).status === 409, "cookie de loja alheia decidiu");
  });
  t("V2. Sincronizar (?sync=1) na loja escolhida → Shopee chamada SO com shop_id/partner da loja (B), nunca da A", async () => {
    cenario(true); chamadas = [];
    await vendas.GET(req(`/api/shopee/vendas?${PERIODO}&loja_id=${LOJA_B}&sync=1`));
    assert(chamadas.length > 0 && chamadas.every((c) => c.shopId === "481902588" && c.partnerId === "2047853"), JSON.stringify(chamadas));
  });

  console.log("\n[D-E. importar anuncios]");
  t("D. importar loja A → Shopee chamada so com shop/app de A", async () => {
    cenario(true); chamadas = [];
    const r = await importar.POST(req("/api/shopee/importar-anuncios", {}, { method: "POST", body: JSON.stringify({ loja_id: LOJA_A }), headers: { "Content-Type": "application/json" } }));
    assert(r.status < 400 && chamadas.length > 0 && chamadas.every((c) => c.shopId === "419809235" && c.partnerId === "2038003"), `${r.status} ${JSON.stringify(chamadas)}`);
  });
  t("E. importar loja B → so B; 2 ativas sem loja_id → 409 STORE_SELECTION_REQUIRED (cookie nao decide); 1 ativa → direto", async () => {
    cenario(true); chamadas = [];
    await importar.POST(req("/api/shopee/importar-anuncios", {}, { method: "POST", body: JSON.stringify({ loja_id: LOJA_B }), headers: { "Content-Type": "application/json" } }));
    assert(chamadas.length > 0 && chamadas.every((c) => c.shopId === "481902588"), JSON.stringify(chamadas));
    chamadas = [];
    const r = await importar.POST(req("/api/shopee/importar-anuncios", { shopee_loja_id: LOJA_A }, { method: "POST" }));
    const d = await r.json();
    assert(r.status === 409 && d.codigo === "STORE_SELECTION_REQUIRED" && chamadas.length === 0, `${r.status} ${JSON.stringify(d)}`);
    cenario(false); chamadas = [];
    const r1 = await importar.POST(req("/api/shopee/importar-anuncios", {}, { method: "POST" }));
    assert(r1.status < 400 && chamadas.every((c) => c.shopId === "419809235"), `${r1.status}`);
  });

  console.log("\n[F-G. sync]");
  t("F. nightly /api/sync → sincroniza A E B explicitamente (cada uma com o proprio app); C do outro dono com o dela", async () => {
    cenario(true); chamadas = [];
    const r = await cron.GET(new Request(`${H}/api/sync`, { headers: { authorization: "Bearer cron-de-teste" } }));
    const d = await r.json();
    const shops = new Set(chamadas.map((c) => `${c.shopId}:${c.partnerId}`));
    assert(shops.has("419809235:2038003") && shops.has("481902588:2047853") && shops.has("555000111:2038003"), JSON.stringify([...shops]));
    assert(d.synced?.[DONO_X]?.shopee_lojas && Object.keys(d.synced[DONO_X].shopee_lojas).sort().join() === [LOJA_A, LOJA_B].sort().join(), JSON.stringify(d.synced?.[DONO_X]));
  });
  t("F3. nightly: falha em UMA loja nao pula a outra (falha em A → B sincroniza; falha em B → A sincroniza)", async () => {
    for (const [ruim, boa, shopBoa] of [[LOJA_A, LOJA_B, "481902588"], [LOJA_B, LOJA_A, "419809235"]] as const) {
      cenario(true); chamadas = []; falharLoja = ruim;
      try {
        const r = await cron.GET(new Request(`${H}/api/sync`, { headers: { authorization: "Bearer cron-de-teste" } }));
        const d = await r.json();
        const porLoja = d.synced?.[DONO_X]?.shopee_lojas ?? {};
        assert(chamadas.some((c) => c.shopId === shopBoa), `loja ${shopBoa} pulada apos falha na outra: ${JSON.stringify(d.synced?.[DONO_X])}`);
        assert(typeof porLoja[boa] === "number" && ruim in porLoja && typeof porLoja[ruim] === "string", JSON.stringify(porLoja));
      } finally { falharLoja = null; }
    }
  });
  t("F2/K. nightly com R.D. inativa → so a loja antiga do dono X", async () => {
    cenario(false); chamadas = [];
    await cron.GET(new Request(`${H}/api/sync?userId=${DONO_X}`, { headers: { authorization: "Bearer cron-de-teste" } }));
    assert(chamadas.length > 0 && chamadas.every((c) => c.shopId === "419809235"), JSON.stringify(chamadas));
  });
  t("G. funcao base sem loja → falha fechada (loja_obrigatoria), nenhuma chamada, nunca 'a mais recente'", async () => {
    cenario(true); chamadas = [];
    const r1 = await SS.syncShopeeForUserV2(DONO_X, "2026-10-01", "2026-10-02", false);
    const r2 = await SS.syncShopeeForUserV2(DONO_X, "2026-10-01", "2026-10-02", false, undefined, { modo: "incremental" });
    assert(r1.motivoFalha === "loja_obrigatoria" && r2.motivoFalha === "loja_obrigatoria" && chamadas.length === 0, JSON.stringify({ r1, r2, chamadas }));
    const usos = execFileSync("git", ["grep", "-n", "getShopeeLojaAtiva(", "--", "app", "lib"], { cwd: RAIZ, encoding: "utf8" }).trim().split(/\r?\n/)
      .filter((l) => !/export async function getShopeeLojaAtiva/.test(l));
    assert(usos.length === 0, usos.join(" | "));
  });

  console.log("\n[I-J. admin]");
  t("I. admin status sem loja_id → recusada (nenhuma chamada)", async () => {
    cenario(true); chamadas = [];
    const r = await status.POST(req("/api/admin/shopee/status", {}, { method: "POST", body: JSON.stringify({ dry_run: true }), headers: { "Content-Type": "application/json" } }));
    assert(r.status === 400 && chamadas.length === 0, `${r.status}`);
  });
  t("J. admin status com loja de outro dono → recusada; as 3 rotas admin exigem loja explicita e filtram pedidos por loja", async () => {
    cenario(true); chamadas = [];
    const r = await status.POST(req("/api/admin/shopee/status", {}, { method: "POST", body: JSON.stringify({ dry_run: true, loja_id: LOJA_C }), headers: { "Content-Type": "application/json" } }));
    assert(r.status === 404 && chamadas.length === 0, `${r.status}`);
    for (const f of ["backfill-pedidos-0707", "reconciliar-financeiro", "status"]) {
      const s = readFileSync(join(RAIZ, `app/api/admin/shopee/${f}/route.ts`), "utf8");
      assert(/exigirExplicita: true/.test(s) && !/getShopeeLojaAtiva/.test(s), `${f}: sem loja explicita`);
      const n = (s.match(/\.eq\("marketplace", "Shopee"\)/g) ?? []).length;
      assert(n > 0 && n === (s.match(/\.eq\("marketplace", "Shopee"\)\.eq\("loja_id", loja\.lojaId\)/g) ?? []).length, `${f}: leitura de pedidos sem filtro de loja`);
    }
  });

  console.log("\n[escopo]");
  t("S1. V2: sem selecao implicita nova (I3), canonico isolado do legado (I1/I2), zonas protegidas (Vendas/Dashboard/formulas/migrations); isolamento por loja provado pelos casos A-J", () => {
    const errosV2 = invariantesV2(RAIZ);
    assert(errosV2.length === 0, `S1: ${errosV2.join(" | ")}`);
  });

  await fila;
  console.log(`\n${falhou === 0 ? "✓" : "✗"} SHOPEE-MULTI-STORE — ${passou} passaram, ${falhou} falharam`);
  process.exit(falhou === 0 ? 0 : 1);
}
principal().catch((e) => { console.error("ERRO FATAL", e?.message ?? e); process.exit(1); });
