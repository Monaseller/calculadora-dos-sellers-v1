/**
 * CDS V2 — Fase 1B: credenciais do Mercado Livre escopadas por LOJA (fim do token em cookie).
 *
 * Prova, offline, com as rotas/capabilities REAIS, um banco em memória e um Mercado Livre falso que
 * registra o token de CADA chamada:
 *   • ML-A (TOKEN_A) e ML-B (TOKEN_B) do mesmo dono: A só usa TOKEN_A, B só TOKEN_B;
 *   • ambiguidade (2 lojas sem escolha) e loja única sem opt-in → falha fechada, 0 chamadas;
 *   • loja de outro dono / loja Shopee / sessão anônima → recusa ANTES do provider (0 chamadas);
 *   • cookie de token FALSO nunca vira credencial; nenhuma resposta grava/expõe token;
 *   • refresh de A (vencida) só altera A (CAS), B intacta;
 *   • catálogo e vendas legadas com 2+ contas ML → 409 estruturado, 0 provider, 0 escritas;
 *   • o sync ML sem loja explícita falha fechado sem falar com o ML.
 *
 * Uso: npx tsx scripts/testar-ml-credenciais-por-loja.ts
 */
import "./_server-only-inerte";
import Module from "node:module";
import { credenciaisMLNaoEscopadasPorLoja, invariantesV2 } from "./_guard-v2";

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

const U = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";      // dono com ML-A + ML-B + Shopee
const V = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";      // dono com UMA loja ML
const OUTRO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ML_A = "11111111-1111-4111-8111-111111111111";
const ML_B = "22222222-2222-4222-8222-222222222222";
const ML_V = "55555555-5555-4555-8555-555555555555";
const ML_OUTRO = "33333333-3333-4333-8333-333333333333";
const SHOPEE_U = "44444444-4444-4444-8444-444444444444";
const TOKEN_A = "<TOKEN_A>", TOKEN_B = "<TOKEN_B>", TOKEN_V = "<TOKEN_V>", TOKEN_OUTRO = "<TOKEN_OUTRO>";
const FUTURO = () => new Date(Date.now() + 3600_000).toISOString();
const PASSADO = () => new Date(Date.now() - 3600_000).toISOString();

type Linha = Record<string, any>;
let BANCO: Record<string, Linha[]> = {};
let escritas: { tabela: string; op: string; payload: any; filtros: [string, any][] }[] = [];
function semear() {
  BANCO = {
    lojas: [
      { id: ML_A, user_id: U, marketplace: "ML", ativo: true, nickname: "ml_a", nome: "ml_a", seller_id: "111", access_token: TOKEN_A, refresh_token: "<REFRESH_A>", token_expires_at: FUTURO(), created_at: "2026-01-01" },
      { id: ML_B, user_id: U, marketplace: "ML", ativo: true, nickname: "ml_b", nome: "ml_b", seller_id: "222", access_token: TOKEN_B, refresh_token: "<REFRESH_B>", token_expires_at: FUTURO(), created_at: "2026-02-01" },
      { id: SHOPEE_U, user_id: U, marketplace: "Shopee", ativo: true, nickname: "S", nome: "S", seller_id: "999", shop_id: "999", access_token: "<TOKEN_SHOPEE>", refresh_token: null, token_expires_at: FUTURO(), created_at: "2026-03-01" },
      { id: ML_V, user_id: V, marketplace: "ML", ativo: true, nickname: "ml_v", nome: "ml_v", seller_id: "555", access_token: TOKEN_V, refresh_token: "<REFRESH_V>", token_expires_at: FUTURO(), created_at: "2026-01-05" },
      { id: ML_OUTRO, user_id: OUTRO, marketplace: "ML", ativo: true, nickname: "x", nome: "x", seller_id: "333", access_token: TOKEN_OUTRO, refresh_token: "<REFRESH_OUTRO>", token_expires_at: FUTURO(), created_at: "2026-01-03" },
    ],
    anuncios: [], pedidos: [], vendas_dia: [],
  };
  escritas = []; chamadas = [];
}
function clienteFalso() {
  return { from(tabela: string) {
    const st: any = { op: "select", payload: null, filtros: [] as [string, any][], faixa: null as [number, number] | null };
    const casa = (l: Linha) => st.filtros.every(([c, v]: [string, any]) => String(l[c]) === String(v));
    const exec = () => {
      if (st.op !== "select") {
        escritas.push({ tabela, op: st.op, payload: st.payload, filtros: [...st.filtros] });
        if (st.op === "update") { const alvo = (BANCO[tabela] ?? []).filter(casa); for (const l of alvo) Object.assign(l, st.payload); return { data: alvo.map((l) => ({ id: l.id })), error: null }; }
        return { data: [], error: null };
      }
      const linhas = (BANCO[tabela] ?? []).filter(casa).map((l) => ({ ...l }));
      return { data: st.faixa ? linhas.slice(st.faixa[0], st.faixa[1] + 1) : linhas, error: null };
    };
    const b: any = new Proxy({}, { get(_a, p: string) {
      if (p === "then") return (res: any, rej: any) => Promise.resolve().then(exec).then(res, rej);
      if (p === "maybeSingle" || p === "single") return async () => { const r = exec(); return { data: (r.data as any[])[0] ?? null, error: r.error }; };
      return (...args: any[]) => {
        if (["insert", "update", "upsert", "delete"].includes(p)) { st.op = p; st.payload = args[0]; }
        if (p === "eq") st.filtros.push([String(args[0]), args[1]]);
        if (p === "range") st.faixa = [Number(args[0]), Number(args[1])];
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

// ── Mercado Livre falso: registra o token de toda chamada ────────────
let chamadas: { url: string; token: string | null; refresh: string | null }[] = [];
globalThis.fetch = (async (url: any, init?: any) => {
  const alvo = String(url);
  const h = init?.headers ?? {};
  const auth = typeof h.get === "function" ? h.get("Authorization") : (h.Authorization ?? h.authorization ?? null);
  let refresh: string | null = null;
  if (alvo.includes("/oauth/token")) refresh = new URLSearchParams(String(init?.body ?? "")).get("refresh_token");
  chamadas.push({ url: alvo, token: auth ? String(auth).replace(/^Bearer\s+/i, "") : null, refresh });
  if (!alvo.includes("mercadolibre.com") && !alvo.includes("mercadolivre.com")) throw new Error(`rede proibida: ${alvo}`);
  if (alvo.includes("/oauth/token")) return { ok: true, status: 200, json: async () => ({ access_token: "<TOKEN_A_NOVO>", refresh_token: "<REFRESH_A_NOVO>", expires_in: 21600 }) } as any;
  if (alvo.includes("/users/me")) return { ok: true, status: 200, json: async () => ({ id: 111 }) } as any;
  const m = /\/items\?ids=([^&]*)/.exec(alvo);
  if (m) return { ok: true, status: 200, json: async () => decodeURIComponent(m[1]).split(",").map((id) => ({ code: 200, body: { id, thumbnail: `http://img/${id}.jpg` } })) } as any;
  if (alvo.includes("/orders/search")) return { ok: true, status: 200, json: async () => ({ results: [], paging: { total: 0 } }) } as any;
  return { ok: false, status: 404, json: async () => ({}), text: async () => "" } as any;
}) as any;

const tokensUsados = () => chamadas.filter((c) => c.token).map((c) => c.token!);

async function principal() {
  console.log = () => {}; console.error = () => {}; console.warn = () => {};
  semear();
  const C = await import("../lib/ml-conexao");
  const auth = await import("../lib/autenticacao");
  const sync = await import("../lib/sync-ml");
  const mw = await import("../lib/middleware-rotas");
  const thumbs = await import("../app/api/ml/item-thumbnails/route");
  const vendasHoje = await import("../app/api/ml/vendas-hoje/route");
  const vendas = await import("../app/api/ml/vendas/route");
  const catalogo: [string, (r: Request) => Promise<Response>][] = [
    ["importar-anuncios", (await import("../app/api/ml/importar-anuncios/route")).POST as any],
    ["sync-precos", (await import("../app/api/ml/sync-precos/route")).POST as any],
    ["sync-skus", (await import("../app/api/ml/sync-skus/route")).POST as any],
  ];
  const sessao = { U: (await auth.emitirTokenSessao(U)).token, V: (await auth.emitirTokenSessao(V)).token };
  const req = (caminho: string, cookies: Record<string, string>, metodo = "GET") =>
    new Request(`https://exemplo.test${caminho}`, { method: metodo, headers: Object.keys(cookies).length ? { cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ") } : {} });
  const setCookie = (r: Response) => ((r.headers as any).getSetCookie?.() ?? []).join("\n") || (r.headers.get("set-cookie") ?? "");

  secao("\n[1. ML-A / ML-B do mesmo dono — cada loja, só o seu token]");
  t("1. resolverContaML: A → TOKEN_A; B → TOKEN_B (nunca cruzado)", async () => {
    semear();
    const a = await C.resolverContaML(U, ML_A), b = await C.resolverContaML(U, ML_B);
    assert(a.ok && a.accessToken === TOKEN_A && a.lojaId === ML_A, JSON.stringify(a));
    assert(b.ok && b.accessToken === TOKEN_B && b.lojaId === ML_B, JSON.stringify(b));
  });
  t("2. provider real (item-thumbnails): loja A → só TOKEN_A; loja B → só TOKEN_B", async () => {
    semear();
    const ra = await thumbs.GET(req(`/api/ml/item-thumbnails?ids=MLB1&loja_id=${ML_A}`, { cds_session: sessao.U }));
    assert(ra.status === 200 && tokensUsados().length > 0 && tokensUsados().every((x) => x === TOKEN_A), `A usou ${tokensUsados()}`);
    chamadas = [];
    const rb = await thumbs.GET(req(`/api/ml/item-thumbnails?ids=MLB1&loja_id=${ML_B}`, { cds_session: sessao.U }));
    assert(rb.status === 200 && tokensUsados().length > 0 && tokensUsados().every((x) => x === TOKEN_B), `B usou ${tokensUsados()}`);
    chamadas = [];
    const rc = await thumbs.GET(req(`/api/ml/item-thumbnails?ids=MLB1`, { cds_session: sessao.U, loja_ativa_id: ML_B }));
    assert(rc.status === 200 && tokensUsados().every((x) => x === TOKEN_B) && tokensUsados().length > 0, `contexto B usou ${tokensUsados()}`);
  });

  secao("\n[2. ambiguidade e loja única]");
  t("3. 2 lojas ML sem loja/contexto → LOJA_NAO_DEFINIDA (com ou sem opt-in); rota → 409 e 0 chamadas", async () => {
    semear();
    for (const op of [{}, { permitirUnica: true }]) {
      const r = await C.resolverContaML(U, null, op);
      assert(!r.ok && r.motivo === "LOJA_NAO_DEFINIDA", JSON.stringify(r));
    }
    const res = await thumbs.GET(req(`/api/ml/item-thumbnails?ids=MLB1`, { cds_session: sessao.U }));
    assert(res.status === 409 && chamadas.length === 0, `${res.status} chamadas=${chamadas.length}`);
  });
  t("4. 1 loja ML: sem opt-in → falha fechada; com permitirUnica → resolve; lojaId inválido NUNCA cai para a única", async () => {
    semear();
    const sem = await C.resolverContaML(V, null);
    assert(!sem.ok && sem.motivo === "LOJA_NAO_DEFINIDA", JSON.stringify(sem));
    const com = await C.resolverContaML(V, null, { permitirUnica: true });
    assert(com.ok && com.lojaId === ML_V && com.accessToken === TOKEN_V, JSON.stringify(com));
    for (const ruim of ["99999999-9999-4999-8999-999999999999", ML_A, SHOPEE_U, "nao-uuid"]) {
      const r = await C.resolverContaML(V, ruim, { permitirUnica: true });
      assert(!r.ok && r.motivo === "LOJA_INVALIDA", `${ruim}: ${JSON.stringify(r)}`);
    }
    const res = await thumbs.GET(req(`/api/ml/item-thumbnails?ids=MLB1`, { cds_session: sessao.V }));
    assert(res.status === 200 && tokensUsados().every((x) => x === TOKEN_V) && tokensUsados().length > 0, "loja única não funcionou na rota");
  });

  secao("\n[3. recusas ANTES do provider]");
  t("5. loja de OUTRO dono → recusada, 0 chamadas ao ML", async () => {
    semear();
    const res = await thumbs.GET(req(`/api/ml/item-thumbnails?ids=MLB1&loja_id=${ML_OUTRO}`, { cds_session: sessao.U }));
    assert(res.status === 403 && chamadas.length === 0, `${res.status} chamadas=${chamadas.length}`);
  });
  t("6. loja SHOPEE em fluxo ML → recusada, 0 chamadas ao ML", async () => {
    semear();
    const res = await thumbs.GET(req(`/api/ml/item-thumbnails?ids=MLB1&loja_id=${SHOPEE_U}`, { cds_session: sessao.U }));
    assert(res.status === 403 && chamadas.length === 0, `${res.status} chamadas=${chamadas.length}`);
  });
  t("7. sessão ANÔNIMA → 401, 0 chamadas; e o middleware bloqueia item-thumbnails sem sessão", async () => {
    semear();
    const res = await thumbs.GET(req(`/api/ml/item-thumbnails?ids=MLB1&loja_id=${ML_A}`, { ml_access_token: TOKEN_A }));
    assert(res.status === 401 && chamadas.length === 0, `${res.status} chamadas=${chamadas.length}`);
    assert(mw.decidirAcesso("/api/ml/item-thumbnails", "GET", false) === "bloquear_api" && Object.keys(mw.EXCECOES_TEMPORARIAS_F0C).length === 0, "middleware ainda libera anônimo");
  });
  t("8. cookie de token FALSO é ignorado: o ML recebe só o token do servidor; nenhuma resposta grava/expõe token", async () => {
    semear();
    const res = await thumbs.GET(req(`/api/ml/item-thumbnails?ids=MLB1&loja_id=${ML_A}`, { cds_session: sessao.U, ml_access_token: "<TOKEN_FALSO>", ml_refresh_token: "<REFRESH_FALSO>" }));
    assert(tokensUsados().length > 0 && tokensUsados().every((x) => x === TOKEN_A), `usou ${tokensUsados()}`);
    const corpo = await res.text();
    assert(!/ml_(access|refresh)_token=/.test(setCookie(res)) && !corpo.includes(TOKEN_A), "token foi ao navegador");
  });

  secao("\n[4. refresh escopado por loja]");
  t("9. A vencida + B válida: refresh usa REFRESH_A, grava SÓ A (id+dono+CAS), B intacta, nenhum cookie", async () => {
    semear();
    Object.assign(BANCO.lojas.find((l) => l.id === ML_A)!, { token_expires_at: PASSADO() });
    const bAntes = JSON.stringify(BANCO.lojas.find((l) => l.id === ML_B));
    const res = await thumbs.GET(req(`/api/ml/item-thumbnails?ids=MLB1&loja_id=${ML_A}`, { cds_session: sessao.U }));
    const refreshes = chamadas.filter((c) => c.url.includes("/oauth/token"));
    assert(refreshes.length === 1 && refreshes[0].refresh === "<REFRESH_A>", `refresh: ${JSON.stringify(refreshes)}`);
    assert(tokensUsados().every((x) => x === "<TOKEN_A_NOVO>") && tokensUsados().length > 0, `provider usou ${tokensUsados()}`);
    const updLojas = escritas.filter((e) => e.tabela === "lojas" && e.op === "update");
    assert(updLojas.length >= 1 && updLojas.every((e) => e.filtros.some(([c, v]) => c === "id" && v === ML_A) && e.filtros.some(([c, v]) => c === "user_id" && v === U)), JSON.stringify(updLojas.map((e) => e.filtros)));
    assert(updLojas.some((e) => e.filtros.some(([c, v]) => c === "refresh_token" && v === "<REFRESH_A>")), "refresh sem CAS");
    assert(JSON.stringify(BANCO.lojas.find((l) => l.id === ML_B)) === bAntes, "🔴 B foi alterada pelo refresh de A");
    assert(!/ml_(access|refresh)_token=/.test(setCookie(res)), "refresh gravou cookie");
  });

  secao("\n[5. barreiras multi-ML (até a Fase 2 / Vendas store-scoped)]");
  t("10. catálogo (3 rotas) com 2 contas ML, COM e SEM contexto → 409 MULTI_ML_CATALOG_NOT_READY, 0 ML, 0 escritas", async () => {
    for (const ctx of [{ loja_ativa_id: ML_A }, {}] as Record<string, string>[]) {
      for (const [nome, rota] of catalogo) {
        semear();
        const res = await rota(req(`/api/ml/${nome}`, { cds_session: sessao.U, ...ctx }, "POST"));
        const corpo = await res.json();
        assert(res.status === 409 && corpo.codigo === "MULTI_ML_CATALOG_NOT_READY", `${nome}: ${res.status} ${JSON.stringify(corpo)}`);
        assert(chamadas.length === 0 && escritas.length === 0, `${nome}: ML=${chamadas.length} escritas=${escritas.length}`);
      }
    }
  });
  t("11. vendas e vendas-hoje com 2 contas ML → 409 MULTI_ML_VENDAS_NOT_READY, 0 ML, 0 escritas", async () => {
    for (const [nome, rota] of [["vendas", vendas.GET], ["vendas-hoje", vendasHoje.GET]] as const) {
      semear();
      const res = await (rota as any)(req(`/api/ml/${nome}?date_from=2026-10-01&date_to=2026-10-01`, { cds_session: sessao.U, loja_ativa_id: ML_A }));
      const corpo = await res.json();
      assert(res.status === 409 && corpo.codigo === "MULTI_ML_VENDAS_NOT_READY", `${nome}: ${res.status} ${JSON.stringify(corpo)}`);
      assert(chamadas.length === 0 && escritas.length === 0, `${nome}: ML=${chamadas.length} escritas=${escritas.length}`);
    }
  });
  t("12. catálogo com UMA conta ML segue funcionando pela loja única explícita (TOKEN_V)", async () => {
    semear();
    BANCO.anuncios.push({ id: "an-v", user_id: V, marketplace: "ML", ativo: true, ml_item_id: "MLB777", sku: null, nome: "produto v" });
    const [, rota] = catalogo.find(([n]) => n === "sync-skus")!;
    const res = await rota(req(`/api/ml/sync-skus`, { cds_session: sessao.V }, "POST"));
    assert(res.status === 200 && tokensUsados().length > 0 && tokensUsados().every((x) => x === TOKEN_V), `${res.status} tokens=${tokensUsados()}`);
  });

  secao("\n[6. sync ML exige loja explícita]");
  t("13. syncMLForUserV2 sem loja → falha fechada SEM falar com o ML; com loja B → só TOKEN_B", async () => {
    semear();
    let erro = "";
    try { await sync.syncMLForUserV2(U, "2026-10-01", "2026-10-01"); } catch (e: any) { erro = String(e?.message ?? e); }
    assert(/loja ML explicita obrigatoria/.test(erro) && chamadas.length === 0, `erro=${erro} chamadas=${chamadas.length}`);
    const b = await C.resolverContaML(U, ML_B);
    assert(b.ok, "B não resolveu");
    try { await sync.syncMLForUserV2(U, "2026-10-01", "2026-10-01", undefined, true, { lojaId: b.lojaId, accessToken: b.accessToken, sellerId: b.sellerId, nickname: b.nickname }); } catch { /* o duplo pode não cobrir o fluxo inteiro */ }
    assert(tokensUsados().length > 0 && tokensUsados().every((x) => x === TOKEN_B), `sync de B usou ${tokensUsados()}`);
  });

  secao("\n[7. Guard V2]");
  t("14. I7 I7_ML_CREDENTIALS_ARE_STORE_SCOPED e invariantes V2 limpos", () => {
    const i7 = credenciaisMLNaoEscopadasPorLoja();
    assert(i7.length === 0, i7.join(" | "));
    const v2 = invariantesV2();
    assert(v2.length === 0, v2.join(" | "));
  });

  await fila;
  imprimir(`\n${falhou === 0 ? "✓" : "✗"} ML-CREDENCIAIS-POR-LOJA — ${ok} passaram, ${falhou} falharam`);
  process.exit(falhou === 0 ? 0 : 1);
}
principal().catch((e) => { imprimir("ERRO", e?.stack ?? e); process.exit(1); });
