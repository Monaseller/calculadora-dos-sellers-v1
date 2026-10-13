/**
 * CDS V2 — Fase 2D: catálogo Mercado Livre ESCOPADO POR LOJA (runtime + Import ML V2), sem migration.
 *
 * Cenário central: o MESMO dono com ML-A (TOKEN_A) e ML-B (TOKEN_B), e rows com o MESMO ml_item_id,
 * a MESMA variation_id e o MESMO SKU nas duas lojas — com custos/dados diferentes. Prova, nos
 * motores/helpers e nas rotas (que seguem com a barreira multi-ML), que:
 *   • leitura de A vê só A; de B só B; escrita de A toca só A; de B só B (nenhuma escrita cruzada);
 *   • Import ML V2: loja obrigatória, credencial da loja (sem loja única no motor), cursor preso à
 *     loja (cursor A em B → recusado antes do provider), fatias retomáveis com orçamento, retry
 *     sequencial idempotente, INSERT com loja_id explícito e sem forçar imposto/margem, UPDATE por
 *     id + dono + ML + loja, campos do usuário preservados, erro de escrita fail-closed sem sucesso falso;
 *   • sync-precos / sync-skus (só { sku }) / mapa de custo / vendas-hoje: presos à loja da credencial;
 *   • POST manual ML (D2 = identidade): sem ml_item_id/variation_id e com loja do servidor; PATCH:
 *     identidade técnica imutável; Meus Produtos agrupa por marketplace|loja_id|item;
 *   • Fase 2F: barreira multi-ML do catálogo removida (2+ lojas sem escolha → ML_STORE_SELECTION_REQUIRED); I8 limpo.
 *
 * Concorrência: SEM garantia forte (sem UNIQUE ML até a 20261108, sem lease durável) — esta suíte
 * prova idempotência em retry SEQUENCIAL, e nada além disso.
 *
 * Sem rede, sem banco, sem OAuth, sem credencial real (segredo de sessão placeholder).
 * Uso: npx tsx scripts/testar-ml-catalogo-loja.ts
 */
import "./_server-only-inerte";
import Module from "node:module";
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

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder-de-teste.invalid";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "chave-de-teste-invalida";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "chave-de-teste-invalida";
process.env.ML_CLIENT_ID ??= "ficticio";
process.env.ML_CLIENT_SECRET ??= "ficticio";
process.env.SESSION_SECRET ??= "segredo-de-teste-com-mais-de-32-bytes-000000";

const RAIZ = join(__dirname, "..");
const U = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", OUTRO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LOJA_A = "11111111-1111-4111-8111-111111111111", LOJA_B = "22222222-2222-4222-8222-222222222222";
const LOJA_X = "33333333-3333-4333-8333-333333333333", LOJA_SP = "44444444-4444-4444-8444-444444444444";
const TOKEN_A = "<TOKEN_A>", TOKEN_B = "<TOKEN_B>", TOKEN_X = "<TOKEN_X>";
const SELLER: Record<string, string> = { [TOKEN_A]: "111", [TOKEN_B]: "222", [TOKEN_X]: "333" };

// ── Banco falso (PostgREST) ──────────────────────────────────────────
type Linha = Record<string, any>;
let BANCO: Record<string, Linha[]> = {};
let escritas: Array<{ tabela: string; op: string; payload: any; filtros: Array<[string, string, any]> }> = [];
let falharInsert = false;
let falharUpdateIds = new Set<string>();
let seq = 0;
const PAGINA = 1000;
function clienteFalso() {
  return { from(tabela: string) {
    const st: any = { op: "select", payload: null, filtros: [] as Array<[string, string, any]>, preds: [] as Array<(l: Linha) => boolean>, faixa: null as [number, number] | null, ordem: null as string | null, retornar: false };
    const exec = () => {
      const linhas = BANCO[tabela] ?? (BANCO[tabela] = []);
      const alvo = () => linhas.filter((l) => st.preds.every((p: any) => p(l)));
      if (st.op === "insert" || st.op === "upsert") {
        escritas.push({ tabela, op: st.op, payload: st.payload, filtros: [...st.filtros] });
        if (tabela === "anuncios" && falharInsert) return { data: null, error: { message: "falha simulada" } };
        const novos = (Array.isArray(st.payload) ? st.payload : [st.payload]).map((n: Linha) => ({ id: `novo-${++seq}`, ...n }));
        linhas.push(...novos);
        return { data: novos.map((n: Linha) => ({ id: n.id })), error: null };
      }
      if (st.op === "update") {
        escritas.push({ tabela, op: "update", payload: st.payload, filtros: [...st.filtros] });
        const a = alvo();
        if (tabela === "anuncios" && a.some((l) => falharUpdateIds.has(l.id))) return { data: null, error: { message: "falha simulada" } };
        for (const l of a) Object.assign(l, st.payload);
        return { data: a.map((l) => ({ id: l.id })), error: null };
      }
      let r = alvo().map((l) => ({ ...l }));
      if (st.ordem) r.sort((x, y) => (String(x[st.ordem]) < String(y[st.ordem]) ? -1 : String(x[st.ordem]) > String(y[st.ordem]) ? 1 : 0));
      if (st.faixa) r = r.slice(st.faixa[0], Math.min(st.faixa[1] + 1, st.faixa[0] + PAGINA));
      return { data: r, error: null };
    };
    const b: any = new Proxy({}, { get(_a, p: string) {
      if (p === "then") return (res: any, rej: any) => Promise.resolve().then(exec).then(res, rej);
      if (p === "maybeSingle" || p === "single") return async () => { const r = exec(); return { data: (r.data as any[] | null)?.[0] ?? null, error: r.error }; };
      return (...args: any[]) => {
        if (["insert", "update", "upsert", "delete"].includes(p)) { st.op = p; st.payload = args[0]; }
        else if (p === "eq") { st.filtros.push(["eq", String(args[0]), args[1]]); st.preds.push((l: Linha) => l[args[0]] === args[1]); }
        else if (p === "not") { if (args[1] === "is" && args[2] === null) st.preds.push((l: Linha) => l[args[0]] !== null && l[args[0]] !== undefined); }
        else if (p === "or") { if (args[0] === "sku.is.null,sku.eq.") { st.filtros.push(["or", "sku", "vazio"]); st.preds.push((l: Linha) => l.sku === null || l.sku === undefined || l.sku === ""); } }
        else if (p === "in") st.preds.push((l: Linha) => (args[1] as any[]).includes(l[args[0]]));
        else if (p === "range") st.faixa = [Number(args[0]), Number(args[1])];
        else if (p === "order") st.ordem = String(args[0]);
        return b;
      };
    } });
    return b;
  } };
}
const requireOriginal = (Module as any).prototype.require;
(Module as any).prototype.require = function (id: string) {
  if (id === "@supabase/supabase-js") return { createClient: () => clienteFalso() };
  return requireOriginal.apply(this, arguments as any);
};

// ── Mercado Livre falso: catálogo por seller, registra todo token usado ──
let CATALOGO: Record<string, any[]> = {};
let chamadas: Array<{ url: string; token: string | null }> = [];
let PEDIDOS_HOJE: any[] = [];
globalThis.fetch = (async (url: any, init?: any) => {
  const alvo = String(url);
  const h = init?.headers ?? {};
  const auth = typeof h.get === "function" ? h.get("Authorization") : (h.Authorization ?? h.authorization ?? null);
  const token = auth ? String(auth).replace(/^Bearer\s+/i, "") : null;
  chamadas.push({ url: alvo, token });
  if (!alvo.includes("api.mercadolibre.com")) throw new Error(`rede proibida: ${alvo}`);
  const json = (body: any, status = 200) => ({ ok: status < 400, status, json: async () => JSON.parse(JSON.stringify(body)), text: async () => JSON.stringify(body) }) as any;
  const seller = token ? SELLER[token] : undefined;
  if (alvo.includes("/users/me")) return seller ? json({ id: Number(seller) }) : json({}, 401);
  let m = /\/users\/(\d+)\/items\/search\?status=active&limit=(\d+)&offset=(\d+)/.exec(alvo);
  if (m) {
    if (m[1] !== seller) return json({}, 403);
    const ids = (CATALOGO[seller] ?? []).map((i) => i.id);
    return json({ results: ids.slice(Number(m[3]), Number(m[3]) + Number(m[2])) });
  }
  m = /\/items\?ids=([^&]*)/.exec(alvo);
  if (m) {
    const ids = decodeURIComponent(m[1]).split(",").filter(Boolean);
    const meus = new Map((CATALOGO[seller ?? ""] ?? []).map((i) => [i.id, i]));
    return json(ids.map((id) => meus.has(id) ? { code: 200, body: meus.get(id) } : { code: 404, body: null }));
  }
  if (alvo.includes("/seller-promotions/")) return json({}, 404);
  if (alvo.includes("/categories/")) return json({ name: "Categoria", path_from_root: [{ name: "Raiz" }, { name: "Categoria" }] });
  if (alvo.includes("/orders/search")) return json({ results: PEDIDOS_HOJE, paging: { total: PEDIDOS_HOJE.length } });
  m = /\/items\/([A-Z]+\d+)/.exec(alvo);
  if (m) { const it = (CATALOGO[seller ?? ""] ?? []).find((i) => i.id === m![1]); return it ? json(it) : json({}, 404); }
  return json({}, 404);
}) as any;

// ── Cenário ─────────────────────────────────────────────────────────
const FUTURO = () => new Date(Date.now() + 3600_000).toISOString();
function lojaML(id: string, dono: string, token: string, ativo = true): Linha {
  return { id, user_id: dono, marketplace: "ML", ativo, nickname: id.slice(0, 4), nome: id.slice(0, 4), seller_id: SELLER[token], access_token: token,
    refresh_token: `<refresh-${id.slice(0, 4)}>`, token_expires_at: FUTURO(), created_at: "2026-01-01" };
}
function item(id: string, opts: { price?: number; sku?: string | null; variations?: Array<{ id: number; price?: number; sku?: string | null }> } = {}): any {
  return { id, title: `T ${id}`, price: opts.price ?? 100, listing_type_id: "gold_special", category_id: "MLB1234", thumbnail: `thumb-${id}`, permalink: `perm-${id}`,
    seller_custom_field: opts.sku ?? null, shipping: { logistic_type: "me2", free_shipping: false },
    variations: (opts.variations ?? []).map((v) => ({ id: v.id, price: v.price ?? opts.price ?? 100, seller_custom_field: v.sku ?? null, attribute_combinations: [{ value_name: `V${v.id}` }] })) };
}
function anuncio(id: string, loja: string | null, mlItem: string, variacao: string | null, extra: Linha = {}): Linha {
  return { id, user_id: U, marketplace: "ML", loja_id: loja, ml_item_id: mlItem, variation_id: variacao, nome: `T ${mlItem}`, preco_anuncio: 100,
    tipo_anuncio: "Clássico", logistic_type: "me2", frete_gratis: false, thumbnail: `thumb-${mlItem}`, permalink: `perm-${mlItem}`, peso_kg: null, custo_frete: 0,
    sku: "SKU-IGUAL", custo_produto: 10, insumos: 0, imposto: 8, margem_desejada: 20, preco_ideal: null, ativo: true, ...extra };
}
/** Mesmo dono, ML-A e ML-B, mesmo item/variação/SKU nas duas, custos diferentes. */
function semear(bAtiva = true) {
  BANCO = {
    lojas: [lojaML(LOJA_A, U, TOKEN_A), lojaML(LOJA_B, U, TOKEN_B, bAtiva), lojaML(LOJA_X, OUTRO, TOKEN_X),
      { id: LOJA_SP, user_id: U, marketplace: "Shopee", ativo: true, nickname: "sp", nome: "sp", seller_id: "9", shop_id: "9", created_at: "2026-01-01" }],
    anuncios: [
      anuncio("a-1", LOJA_A, "MLB1", null, { custo_produto: 10 }),
      anuncio("a-2", LOJA_A, "MLB2", "501", { custo_produto: 11 }),
      anuncio("b-1", LOJA_B, "MLB1", null, { custo_produto: 99 }),
      anuncio("b-2", LOJA_B, "MLB2", "501", { custo_produto: 98 }),
      { ...anuncio("s-1", LOJA_SP, "MLB1", null), marketplace: "Shopee" },
      { ...anuncio("x-1", LOJA_X, "MLB1", null), user_id: OUTRO },
    ],
    vendas_dia: [],
  };
  CATALOGO = {
    "111": [item("MLB1", { price: 120 }), item("MLB2", { variations: [{ id: 501, price: 51, sku: "SKU-A-501" }, { id: 502, price: 52, sku: "SKU-A-502" }] }), item("MLB3", { price: 33, sku: "SKU-A-3" })],
    "222": [item("MLB1", { price: 220 }), item("MLB2", { variations: [{ id: 501, price: 61, sku: "SKU-B-501" }] })],
    "333": [item("MLB1", { price: 999 })],
  };
  escritas = []; chamadas = []; falharInsert = false; falharUpdateIds = new Set(); PEDIDOS_HOJE = []; seq = 0;
}
const foto = (pred: (l: Linha) => boolean) => JSON.stringify(BANCO.anuncios.filter(pred).sort((x, y) => String(x.id).localeCompare(String(y.id))));
const escritasAnuncios = () => escritas.filter((w) => w.tabela === "anuncios");
const linhasDe = (loja: string) => BANCO.anuncios.filter((a) => a.loja_id === loja);

let sessao = "";
function req(caminho: string, metodo = "POST", corpo?: unknown, cookies: Record<string, string> = {}) {
  const cookie = [`cds_session=${sessao}`, ...Object.entries(cookies).map(([k, v]) => `${k}=${v}`)].join("; ");
  return new Request(`https://exemplo.test${caminho}`, { method: metodo, headers: { cookie, "content-type": "application/json" }, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
}

async function principal() {
  console.log = () => {}; console.error = () => {}; console.warn = () => {};
  const MOT = await import("../lib/anuncios/importacao-ml");
  const SML = await import("../lib/sync-ml");
  const G2 = await import("./_guard-v2");
  const AGR = await import("../app/(app)/anuncios/agrupamento");
  const UI = await import("../app/(app)/anuncios/importacao-ml");
  const PAG = await import("../app/(app)/anuncios/paginacao");
  const rotaImport = (await import("../app/api/ml/importar-anuncios/route")).POST as (r: Request) => Promise<Response>;
  const rotaSkus = (await import("../app/api/ml/sync-skus/route")).POST as (r: Request) => Promise<Response>;
  const rotaPrecos = (await import("../app/api/ml/sync-precos/route")).POST as (r: Request) => Promise<Response>;
  const rotaVendasHoje = (await import("../app/api/ml/vendas-hoje/route")).GET as (r: Request) => Promise<Response>;
  const rotaAnuncios = (await import("../app/api/anuncios/route")).POST as (r: Request) => Promise<Response>;
  const rotaPatch = (await import("../app/api/anuncios/[id]/route")).PATCH as (r: Request, c: any) => Promise<Response>;
  const { getSupabaseServidor } = await import("../lib/estudio-anuncios/supabase-servidor");
  const banco = () => getSupabaseServidor();
  sessao = (await (await import("../lib/autenticacao")).emitirTokenSessao(U)).token;
  const importar = (lojaId: string, extra: Record<string, unknown> = {}) => MOT.importarCatalogoML({ banco: banco(), userId: U, lojaId, inicioMs: Date.now(), ...extra } as any);
  const tenta = async (fn: () => Promise<unknown>) => { try { await fn(); return null; } catch (e: any) { return e; } };

  secao("\n[1. Import ML V2 — motor por loja (ML-A x ML-B, mesmo item/variação/SKU)]");

  t("M1. import da loja A: existentes SÓ de A; INSERT com loja_id A explícito; UPDATE só em A; B, Shopee e outro dono intactos", async () => {
    semear();
    const antesB = foto((a) => a.loja_id !== LOJA_A);
    const r = await importar(LOJA_A);
    assert(r.parcial === false && r.lojaId === LOJA_A && r.total === 3, JSON.stringify(r));
    assert(foto((a) => a.loja_id !== LOJA_A) === antesB, "🔴 escrita cruzada: row de B/Shopee/outro dono mudou");
    const ins = escritasAnuncios().filter((w) => w.op === "insert");
    const novas = ins.flatMap((w) => w.payload as Linha[]);
    assert(novas.length === 2 && novas.every((n) => n.loja_id === LOJA_A && n.user_id === U && n.marketplace === "ML"), `inserts: ${JSON.stringify(novas)}`);
    assert(novas.some((n) => n.ml_item_id === "MLB2" && n.variation_id === "502") && novas.some((n) => n.ml_item_id === "MLB3"), "linhas novas erradas");
    for (const w of escritasAnuncios().filter((x) => x.op === "update")) {
      const f = Object.fromEntries(w.filtros.map(([, c, v]) => [c, v]));
      assert(f.id && f.user_id === U && f.marketplace === "ML" && f.loja_id === LOJA_A, `update fora de id+dono+ML+loja: ${JSON.stringify(w.filtros)}`);
    }
    assert(BANCO.anuncios.find((a) => a.id === "a-1")!.preco_anuncio === 120 && BANCO.anuncios.find((a) => a.id === "b-1")!.preco_anuncio === 100, "preço foi para a loja errada");
    assert(chamadas.filter((c) => c.token).every((c) => c.token === TOKEN_A), `token de outra loja: ${chamadas.map((c) => c.token)}`);
  });

  t("M2. import da loja B: só B muda (preço 220 em b-1, a-1 intocado); token só TOKEN_B", async () => {
    semear();
    const antesA = foto((a) => a.loja_id !== LOJA_B);
    await importar(LOJA_B);
    assert(foto((a) => a.loja_id !== LOJA_B) === antesA, "🔴 escrita cruzada em A");
    assert(BANCO.anuncios.find((a) => a.id === "b-1")!.preco_anuncio === 220, "B não atualizado");
    assert(chamadas.filter((c) => c.token).every((c) => c.token === TOKEN_B), "token de outra loja");
  });

  t("M3. campos do usuário preservados (custo/insumos/imposto/margem/preço ideal/ativo/SKU manual); linha nova não força imposto/margem", async () => {
    semear();
    Object.assign(BANCO.anuncios.find((a) => a.id === "a-1")!, { custo_produto: 7, insumos: 2, imposto: 6, margem_desejada: 33, preco_ideal: 77, ativo: false, sku: "MANUAL" });
    CATALOGO["111"][0].seller_custom_field = "DO-ML";
    await importar(LOJA_A);
    const a1 = BANCO.anuncios.find((a) => a.id === "a-1")!;
    assert(a1.custo_produto === 7 && a1.insumos === 2 && a1.imposto === 6 && a1.margem_desejada === 33 && a1.preco_ideal === 77 && a1.ativo === false && a1.sku === "MANUAL", JSON.stringify(a1));
    const novas = escritasAnuncios().filter((w) => w.op === "insert").flatMap((w) => w.payload as Linha[]);
    assert(novas.length > 0 && novas.every((n) => !("imposto" in n) && !("margem_desejada" in n) && n.ativo === true), `defaults forçados: ${JSON.stringify(novas[0])}`);
    for (const w of escritasAnuncios().filter((x) => x.op === "update")) {
      assert(!["ativo", "custo_produto", "insumos", "imposto", "margem_desejada", "preco_ideal", "loja_id", "user_id"].some((c) => c in w.payload), `update toca campo do usuário: ${Object.keys(w.payload)}`);
    }
  });

  t("M4. retry SEQUENCIAL idempotente: 2ª passada → 0 importados, 0 atualizados, tudo ignorado, nenhuma duplicata", async () => {
    semear();
    await importar(LOJA_A);
    const n = BANCO.anuncios.length;
    escritas = [];
    const r2 = await importar(LOJA_A);
    assert(r2.importados === 0 && r2.atualizados === 0 && r2.ignorados === 4 && BANCO.anuncios.length === n && escritasAnuncios().length === 0, JSON.stringify(r2));
    const k = linhasDe(LOJA_A).map((a) => `${a.ml_item_id}|${a.variation_id ?? ""}`);
    assert(new Set(k).size === k.length, `duplicata na loja A: ${k}`);
  });

  t("M5. fatias com orçamento: 45 itens → retoma pelo cursor até o fim; resultado = import único; cursor nunca volta", async () => {
    semear();
    CATALOGO["111"] = Array.from({ length: 45 }, (_, i) => item(`MLB${1000 + i}`, { price: 10 + i }));
    let relogio = 0;
    const agora = () => relogio;
    let cursor: string | null = null, fatias = 0, importados = 0;
    for (;;) {
      relogio = 0;
      const r: any = await importar(LOJA_A, { cursor, inicioMs: 0, orcamentoMs: 1, agora: () => (relogio += 1) });
      fatias++; importados += r.importados;
      if (!r.parcial) break;
      assert(typeof r.cursor === "string" && r.cursor !== cursor, "cursor parado");
      cursor = r.cursor;
      assert(fatias < 10, "laço");
    }
    void agora;
    assert(fatias === 3 && importados === 45 && linhasDe(LOJA_A).filter((a) => /^MLB10\d\d$/.test(a.ml_item_id)).length === 45, `fatias=${fatias} importados=${importados}`);
  });

  t("M6. cursor de A usado na loja B → CURSOR_DE_OUTRA_LOJA ANTES do provider; cursor inválido/de Shopee → CURSOR_INVALIDO", async () => {
    semear();
    const cursorA = MOT.codificarCursorML(LOJA_A, "MLB1");
    chamadas = []; escritas = [];
    const e: any = await tenta(() => importar(LOJA_B, { cursor: cursorA }));
    assert(e && e.codigo === "CURSOR" && e.motivo === "CURSOR_DE_OUTRA_LOJA" && chamadas.length === 0 && escritas.length === 0, `${e?.codigo}/${e?.motivo} chamadas=${chamadas.length}`);
    const shopee = Buffer.from(JSON.stringify({ v: 1, l: LOJA_B, i: "123" }), "utf8").toString("base64url");
    for (const c of [shopee, "lixo", 42]) {
      const e2: any = await tenta(() => importar(LOJA_B, { cursor: c }));
      assert(e2 && e2.motivo === "CURSOR_INVALIDO" && chamadas.length === 0, `cursor ${String(c).slice(0, 10)}: ${e2?.motivo}`);
    }
  });

  t("M7. erro de escrita fail-closed: INSERT recusado → BANCO, nada contado, cursor = último lote gravado; UPDATE recusado → BANCO", async () => {
    semear();
    CATALOGO["111"] = Array.from({ length: 25 }, (_, i) => item(`MLB${2000 + i}`));
    let lote = 0;
    const orig = (BANCO as any);
    void orig;
    falharInsert = false;
    // 1ª fatia completa os 20 primeiros; 2º lote falha no INSERT
    const r1: any = await importar(LOJA_A, { inicioMs: 0, orcamentoMs: 1, agora: () => (lote += 1) });
    assert(r1.parcial && r1.importados === 20, JSON.stringify(r1));
    falharInsert = true;
    const e: any = await tenta(() => importar(LOJA_A, { cursor: r1.cursor }));
    assert(e && e.codigo === "BANCO" && e.ultimoConcluido === "MLB2019", `${e?.codigo} ${e?.ultimoConcluido}`);
    falharInsert = false;
    semear();
    falharUpdateIds = new Set(["a-1"]);
    const e2: any = await tenta(() => importar(LOJA_A));
    assert(e2 && e2.codigo === "BANCO", `update recusado não falhou: ${e2?.codigo}`);
  });

  t("M8. motor: loja obrigatória; loja de outro dono / Shopee → recusada SEM provider; token de outra conta (seller ≠ loja) → recusado sem escrita", async () => {
    semear();
    for (const l of ["", "nao-uuid", LOJA_X, LOJA_SP]) {
      chamadas = []; escritas = [];
      const e: any = await tenta(() => importar(l));
      assert(e && e.codigo === "LOJA" && chamadas.length === 0 && escritas.length === 0, `${l}: ${e?.codigo} chamadas=${chamadas.length}`);
    }
    semear();
    BANCO.lojas.find((x) => x.id === LOJA_A)!.seller_id = "999";
    const e: any = await tenta(() => importar(LOJA_A));
    assert(e && e.codigo === "LOJA" && e.motivo === "CONTA_DIVERGENTE" && escritasAnuncios().length === 0, `${e?.codigo}/${e?.motivo}`);
  });

  t("M9. variações: 1 row por variação (sem row-pai); variação de A e de B com o mesmo id não se cruzam", async () => {
    semear();
    await importar(LOJA_A);
    const mlb2A = linhasDe(LOJA_A).filter((a) => a.ml_item_id === "MLB2");
    assert(mlb2A.length === 2 && mlb2A.every((a) => a.variation_id !== null), JSON.stringify(mlb2A.map((a) => a.variation_id)));
    assert(BANCO.anuncios.find((a) => a.id === "a-2")!.preco_anuncio === 51 && BANCO.anuncios.find((a) => a.id === "b-2")!.preco_anuncio === 100, "variação 501 cruzou de loja");
  });

  secao("\n[2. rotas com 1 conta ML ativa (barreira intacta) — ML-B inativa com rows históricas]");

  t("R1. POST /api/ml/importar-anuncios → loja única A resolvida na borda; resposta com loja_id A; B intocada; 2 ativas SEM escolha → 409 ML_STORE_SELECTION_REQUIRED sem provider", async () => {
    semear(false);
    const antesB = foto((a) => a.loja_id === LOJA_B);
    const res = await rotaImport(req("/api/ml/importar-anuncios", "POST", {}));
    const corpo: any = await res.json();
    assert(res.status === 200 && corpo.loja_id === LOJA_A && corpo.parcial === false, `${res.status} ${JSON.stringify(corpo)}`);
    assert(foto((a) => a.loja_id === LOJA_B) === antesB, "🔴 rota escreveu em B");
    semear(true); chamadas = [];
    const r2 = await rotaImport(req("/api/ml/importar-anuncios", "POST", {}));
    const c2: any = await r2.json();
    assert(r2.status === 409 && c2.codigo === "ML_STORE_SELECTION_REQUIRED" && chamadas.length === 0 && escritas.length === 0, `${r2.status} ${JSON.stringify(c2)}`);
  });

  t("R2. sync-skus: lê/escreve SÓ a loja A (mesmo item/variação/SKU vazio em B fica intocado); payload { sku }", async () => {
    semear(false);
    for (const a of BANCO.anuncios) if (a.marketplace === "ML") a.sku = null;
    CATALOGO["111"][0].seller_custom_field = "SKU-A";
    const antesB = foto((a) => a.loja_id === LOJA_B);
    const res = await rotaSkus(req("/api/ml/sync-skus"));
    assert(res.status === 200, `status ${res.status}`);
    assert(foto((a) => a.loja_id === LOJA_B) === antesB, "🔴 sync-skus escreveu em B");
    const ups = escritasAnuncios().filter((w) => w.op === "update");
    assert(ups.length > 0 && ups.every((w) => JSON.stringify(Object.keys(w.payload)) === '["sku"]' && w.filtros.some(([, c, v]) => c === "loja_id" && v === LOJA_A)), JSON.stringify(ups));
    assert(BANCO.anuncios.find((a) => a.id === "a-1")!.sku === "SKU-A", "A não recebeu o SKU");
  });

  t("R3. sync-precos: lê/escreve SÓ a loja A; B intocada; UPDATE com id + dono + ML + loja", async () => {
    semear(false);
    const antesB = foto((a) => a.loja_id === LOJA_B);
    const res = await rotaPrecos(req("/api/ml/sync-precos"));
    const corpo: any = await res.json();
    assert(res.status === 200 && corpo.erro === false, `${res.status} ${JSON.stringify(corpo)}`);
    assert(foto((a) => a.loja_id === LOJA_B) === antesB, "🔴 sync-precos escreveu em B");
    const ups = escritasAnuncios().filter((w) => w.op === "update");
    assert(ups.length > 0 && ups.every((w) => w.filtros.some(([, c, v]) => c === "loja_id" && v === LOJA_A) && w.filtros.some(([, c, v]) => c === "marketplace" && v === "ML")), JSON.stringify(ups.map((u) => u.filtros)));
    assert(chamadas.filter((c) => c.token).every((c) => c.token === TOKEN_A), "token de outra loja");
  });

  t("R4. vendas-hoje: lookup de catálogo SÓ da loja A (paginado, ML); vendas_dia só para o anúncio de A", async () => {
    semear(false);
    PEDIDOS_HOJE = [{ id: 1, order_items: [{ item: { id: "MLB1", title: "T" }, quantity: 2, unit_price: 10 }] }];
    const res = await rotaVendasHoje(req("/api/ml/vendas-hoje", "GET"));
    assert(res.status === 200, `status ${res.status}`);
    const ups = escritas.filter((w) => w.tabela === "vendas_dia");
    assert(ups.length === 1 && ups[0].payload.anuncio_id === "a-1", `vendas_dia: ${JSON.stringify(ups.map((u) => u.payload))}`);
  });

  secao("\n[3. mapa de custo, apresentação]");

  t("C1. mapa de custo: A e B com o MESMO item/variação/SKU e custos diferentes → mapas não se cruzam", async () => {
    semear();
    const mA = await SML.carregarMapaAnunciosML(U, LOJA_A), mB = await SML.carregarMapaAnunciosML(U, LOJA_B);
    assert(SML.buscarAnuncioML(mA, LOJA_A, "MLB1", null)?.custo_produto === 10 && SML.buscarAnuncioML(mB, LOJA_B, "MLB1", null)?.custo_produto === 99, "custo cruzado (item)");
    assert(SML.buscarAnuncioML(mA, LOJA_A, "MLB2", "501")?.custo_produto === 11 && SML.buscarAnuncioML(mB, LOJA_B, "MLB2", 501)?.custo_produto === 98, "custo cruzado (variação)");
    assert(SML.buscarAnuncioML(mA, LOJA_B, "MLB1", null) === undefined && SML.buscarAnuncioML(mB, LOJA_A, "MLB2", "501") === undefined, "mapa aceita chave de outra loja");
    assert(SML.buscarAnuncioML(mA, LOJA_A, "MLB2", "999") === undefined, "variação inexistente caiu em outra variação");
  });

  t("G1. Meus Produtos: chave = marketplace|loja_id|item com a loja REAL; A/B e ML/Shopee nunca se fundem; sem identidade paralela", () => {
    const k = AGR.chaveDeGrupoAnuncio;
    assert(k({ marketplace: "ML", loja_id: LOJA_A, ml_item_id: "MLB1" }) !== k({ marketplace: "ML", loja_id: LOJA_B, ml_item_id: "MLB1" }), "A e B fundidas");
    assert(k({ marketplace: "ML", loja_id: LOJA_A, ml_item_id: "MLB1" }) !== k({ marketplace: "Shopee", loja_id: LOJA_A, ml_item_id: "MLB1" }), "ML e Shopee fundidos");
    assert(k({ marketplace: "ML", loja_id: LOJA_A, ml_item_id: "MLB1" }) === `ML|${LOJA_A}|MLB1`, "chave não usa o loja_id real");
    assert(k({ marketplace: "ML", loja_id: LOJA_A, ml_item_id: null }) === null, "sem item agrupou");
    const tela = readFileSync(join(RAIZ, "app/(app)/anuncios/page.tsx"), "utf8");
    assert(!/loja_ref|lojaRef|createHash|sha256/.test(tela) && /idsDuplicadosAntigos\(anuncios\)/.test(tela) && /agruparVariacoes\(anunciosFiltrados\)/.test(tela),
      "tela usa identidade paralela ou não agrupa pelas funções da chave por loja");
  });

  t("G2. agrupamento real da tela: variações de A e de B (mesmo item/variação) viram 2 cards; mesmo item em A e B não é duplicado; em A, sim", () => {
    const linhas = [
      { id: "a-501", marketplace: "ML", loja_id: LOJA_A, ml_item_id: "MLB2", variation_id: "501" },
      { id: "a-502", marketplace: "ML", loja_id: LOJA_A, ml_item_id: "MLB2", variation_id: "502" },
      { id: "b-501", marketplace: "ML", loja_id: LOJA_B, ml_item_id: "MLB2", variation_id: "501" },
      { id: "a-1", marketplace: "ML", loja_id: LOJA_A, ml_item_id: "MLB1", variation_id: null },
      { id: "b-1", marketplace: "ML", loja_id: LOJA_B, ml_item_id: "MLB1", variation_id: null },
      { id: "s-1", marketplace: "Shopee", loja_id: LOJA_SP, ml_item_id: "MLB1", variation_id: null },
    ];
    const { solo, grupos } = AGR.agruparVariacoes(linhas);
    const porCard = grupos.map((g) => g.map((x) => x.id).sort().join(",")).sort();
    assert(JSON.stringify(porCard) === JSON.stringify(["a-501,a-502", "b-501"]), `cards: ${JSON.stringify(porCard)}`);
    assert(solo.length === 3, `solo: ${solo.map((x) => x.id)}`);
    assert(AGR.idsDuplicadosAntigos(linhas).size === 0, `duplicados entre lojas/marketplaces: ${[...AGR.idsDuplicadosAntigos(linhas)]}`);
    const dupA = AGR.idsDuplicadosAntigos([...linhas, { id: "a-1-velho", marketplace: "ML", loja_id: LOJA_A, ml_item_id: "MLB1", variation_id: null }]);
    assert(dupA.size === 1 && dupA.has("a-1-velho"), `duplicado real na mesma loja: ${[...dupA]}`);
  });

  secao("\n[4. POST manual (D2 = identidade) e PATCH (identidade imutável)]");

  t("P1. POST manual ML sem identidade → 201 com loja_id da loja ML única do dono (servidor); com ml_item_id/variation_id → 400 sem escrita", async () => {
    semear(false);
    const corpo = { nome: "Manual", marketplace: "ML", custo_produto: 5 };
    const r = await rotaAnuncios(req("/api/anuncios", "POST", corpo));
    assert(r.status === 201, `status ${r.status}`);
    const ins = escritasAnuncios().filter((w) => w.op === "insert");
    assert(ins.length === 1 && ins[0].payload.loja_id === LOJA_A && ins[0].payload.user_id === U && !("ml_item_id" in ins[0].payload), JSON.stringify(ins));
    for (const extra of [{ ml_item_id: "MLB5" }, { variation_id: "7" }]) {
      escritas = [];
      const rr = await rotaAnuncios(req("/api/anuncios", "POST", { ...corpo, ...extra }));
      const cc: any = await rr.json();
      assert(rr.status === 400 && cc.codigo === "ML_PROVIDER_IDENTITY_MANUAL_CREATE_NOT_ALLOWED" && escritas.length === 0, `${JSON.stringify(extra)}: ${rr.status}`);
    }
    // contexto loja_ativa_id = loja Shopee (não é ML) → não vira autoridade; continua a ML única
    escritas = [];
    const rs = await rotaAnuncios(req("/api/anuncios", "POST", corpo, { loja_ativa_id: LOJA_SP }));
    assert(rs.status === 201 && escritasAnuncios()[0].payload.loja_id === LOJA_A, "contexto não-ML virou loja do anúncio");
    // 2 ML ativas sem contexto válido → 409; com contexto B → B
    semear(true); escritas = [];
    const r2 = await rotaAnuncios(req("/api/anuncios", "POST", corpo));
    assert(r2.status === 409 && escritas.length === 0, `2 lojas sem contexto: ${r2.status}`);
    const r3 = await rotaAnuncios(req("/api/anuncios", "POST", corpo, { loja_ativa_id: LOJA_B }));
    assert(r3.status === 201 && escritasAnuncios()[0].payload.loja_id === LOJA_B, "contexto B validado não usado");
  });

  t("P2. PATCH row ML: loja_id / ml_item_id / variation_id / marketplace diferentes → 400 sem escrita; campos do usuário editáveis", async () => {
    semear();
    const patch = (corpo: unknown) => rotaPatch(req("/api/anuncios/a-2", "PATCH", corpo), { params: { id: "a-2" } });
    const antes = JSON.stringify(BANCO.anuncios.find((a) => a.id === "a-2"));
    for (const c of [{ loja_id: LOJA_B }, { ml_item_id: "MLB9" }, { variation_id: "502" }, { variation_id: null }, { marketplace: "Shopee" }, { ml_item_id: "MLB9", custo_produto: 1 }]) {
      escritas = [];
      const r = await patch(c);
      assert(r.status === 400 && escritasAnuncios().filter((w) => w.op === "update").length === 0, `${JSON.stringify(c)}: ${r.status}`);
      assert(JSON.stringify(BANCO.anuncios.find((a) => a.id === "a-2")) === antes, `${JSON.stringify(c)}: row mudou`);
    }
    const ok1 = await patch({ custo_produto: 3, imposto: 5 });
    assert(ok1.status === 200 && BANCO.anuncios.find((a) => a.id === "a-2")!.custo_produto === 3, `campo do usuário: ${ok1.status}`);
    const ok2 = await patch({ ml_item_id: "MLB2", variation_id: "501", marketplace: "ML", insumos: 4 });
    const a2 = BANCO.anuncios.find((a) => a.id === "a-2")!;
    assert(ok2.status === 200 && a2.insumos === 4 && a2.loja_id === LOJA_A && a2.ml_item_id === "MLB2", `mesma identidade + campo: ${ok2.status}`);
  });

  secao("\n[5. tela: laço de fatias do ML; guard I8]");

  t("U1. importarMLEmFatias: segue o cursor até parcial:false; cursor repetido ou troca de loja → erro (sem laço)", async () => {
    const classificar = (s: number, x: string) => PAG.classificarRespostaImportacao(s, x, "Mercado Livre");
    const fatia = (o: Record<string, unknown>) => ({ status: 200, texto: JSON.stringify({ importados: 1, atualizados: 0, ignorados: 0, itens_processados: 1, total: 3, loja_id: LOJA_A, ...o }) });
    const seqOk = [fatia({ parcial: true, cursor: "c1" }), fatia({ parcial: true, cursor: "c2" }), fatia({ parcial: false, cursor: null })];
    const corpos: any[] = [];
    const r = await UI.importarMLEmFatias(async (c) => { corpos.push(c); return seqOk.shift()!; }, classificar);
    // Fase 2F: a continuação leva a loja + cursor devolvidos pelo servidor
    assert(r.tipo === "ok" && r.progresso.importados === 3 && r.progresso.fatias === 3
      && JSON.stringify(corpos) === JSON.stringify([{}, { loja_id: LOJA_A, cursor: "c1" }, { loja_id: LOJA_A, cursor: "c2" }]), JSON.stringify(corpos));
    const repetido = [fatia({ parcial: true, cursor: "c1" }), fatia({ parcial: true, cursor: "c1" })];
    assert((await UI.importarMLEmFatias(async () => repetido.shift()!, classificar)).tipo === "erro", "cursor repetido não parou");
    const trocou = [fatia({ parcial: true, cursor: "c1" }), fatia({ parcial: true, cursor: "c2", loja_id: LOJA_B })];
    assert((await UI.importarMLEmFatias(async () => trocou.shift()!, classificar)).tipo === "erro", "troca de loja não parou");
  });

  t("I8. Guard V2 limpo: I5 (marketplace + loja em todo runtime que fala com o ML) e I8_ML_CATALOG_IS_STORE_SCOPED", () => {
    const i5 = G2.leitoresMLSemMarketplace(), i8 = G2.catalogoMLNaoEscopadoPorLoja(), v2 = G2.invariantesV2(undefined, { zonas: false });
    assert(i5.length === 0 && i8.length === 0 && v2.length === 0, [...i5, ...i8, ...v2].join(" | "));
  });

  await fila;
  imprimir(`\n${falhou === 0 ? "✓" : "✗"} ML-CATALOGO-LOJA — ${ok} passaram, ${falhou} falharam`);
  process.exit(falhou === 0 ? 0 : 1);
}
principal().catch((e) => { imprimir("ERRO", e?.message ?? e); process.exit(1); });
