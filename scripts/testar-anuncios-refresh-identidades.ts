/**
 * CDS V2 — Fase 2H-D: refresh de IDENTIDADES CONHECIDAS por id (ML + Shopee), por loja, on-demand.
 *
 * Motores REAIS (lib/anuncios/refresh-identidades-ml.ts / -shopee.ts) e rotas REAIS
 * (/api/ml/refresh-identidades, /api/shopee/refresh-identidades), com o helper de observação da 2H-C.
 * Prova: fonte = dono + marketplace + loja (sem filtro de ativo), credencial da loja, positivo só com o
 * MESMO id pedido (ML code 200), 404/outro code/id divergente/ausente = nada escrito (só diagnóstico),
 * variação/model só se voltou, status RAW (ML) / só visto_em (Shopee, nunca NORMAL), id inválido nunca vai
 * ao provider, cursor preso a marketplace + loja + "refresh" validado antes do provider, checkpoint depois
 * da escrita, falha → fatia falha e retry converge, A nunca toca B.
 *
 * Duplos de PostgREST, ML e Shopee. Sem rede, sem banco, sem credencial real.
 * Uso: npx tsx scripts/testar-anuncios-refresh-identidades.ts
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

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder-de-teste.invalid";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "chave-de-teste-invalida";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "chave-de-teste-invalida";
process.env.ML_CLIENT_ID ??= "ficticio";
process.env.ML_CLIENT_SECRET ??= "ficticio";
process.env.SESSION_SECRET ??= "segredo-de-teste-com-mais-de-32-bytes-000000";
process.env.SHOPEE_BASE_URL = "https://shopee.teste.invalid";

const U = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", OUTRO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LOJA_A = "11111111-1111-4111-8111-111111111111", LOJA_B = "22222222-2222-4222-8222-222222222222", LOJA_X = "55555555-5555-4555-8555-555555555555";
const SP_A = "33333333-3333-4333-8333-333333333333", SP_B = "44444444-4444-4444-8444-444444444444";
const TOKEN_A = "<TOKEN_A>", TOKEN_B = "<TOKEN_B>", TOKEN_X = "<TOKEN_X>";
const SELLER: Record<string, string> = { [TOKEN_A]: "111", [TOKEN_B]: "222", [TOKEN_X]: "333" };
const SHOP: Record<string, string> = { [SP_A]: "900", [SP_B]: "901" };
const T1 = new Date("2026-10-01T10:00:00.000Z"), T2 = new Date("2026-10-13T12:00:00.000Z");

// ── PostgREST falso ──────────────────────────────────────────────────
type Linha = Record<string, any>;
let BANCO: Record<string, Linha[]> = {};
let escritas: Array<{ tabela: string; op: string; payload: any; filtros: Array<[string, string, any]> }> = [];
let falharObservacao = false;
const ehObservacao = (p: any) => p && typeof p === "object" && !Array.isArray(p) && Object.keys(p).length > 0 && Object.keys(p).every((k) => k === "visto_em" || k === "status_marketplace");
function clienteFalso() {
  return { from(tabela: string) {
    const st: any = { op: "select", payload: null, filtros: [] as Array<[string, string, any]>, preds: [] as Array<(l: Linha) => boolean>, faixa: null, retornar: false };
    const exec = () => {
      const linhas = BANCO[tabela] ?? (BANCO[tabela] = []);
      const alvo = () => linhas.filter((l) => st.preds.every((p: any) => p(l)));
      if (st.op === "update") {
        escritas.push({ tabela, op: "update", payload: st.payload, filtros: [...st.filtros] });
        if (ehObservacao(st.payload) && falharObservacao) return { data: null, error: { message: "falha simulada" } };
        const a = alvo(); for (const l of a) Object.assign(l, st.payload);
        return { data: st.retornar ? a.map((l) => ({ id: l.id })) : null, error: null };
      }
      if (st.op !== "select") { escritas.push({ tabela, op: st.op, payload: st.payload, filtros: [...st.filtros] }); return { data: null, error: { message: "escrita inesperada" } }; }
      let r = alvo().map((l) => ({ ...l }));
      if (st.faixa) r = r.slice(st.faixa[0], st.faixa[1] + 1);
      return { data: r, error: null };
    };
    const b: any = new Proxy({}, { get(_a, p: string) {
      if (p === "then") return (res: any, rej: any) => Promise.resolve().then(exec).then(res, rej);
      if (p === "maybeSingle" || p === "single") return async () => { const r = exec(); return { data: (r.data as any[] | null)?.[0] ?? null, error: r.error }; };
      return (...args: any[]) => {
        if (["insert", "update", "upsert", "delete"].includes(p)) { st.op = p; st.payload = args[0]; }
        else if (p === "eq") { st.filtros.push(["eq", String(args[0]), args[1]]); st.preds.push((l: Linha) => l[args[0]] === args[1]); }
        else if (p === "in") { st.filtros.push(["in", String(args[0]), [...args[1]]]); st.preds.push((l: Linha) => (args[1] as any[]).includes(l[args[0]])); }
        else if (p === "not") { if (args[1] === "is" && args[2] === null) { st.filtros.push(["notnull", String(args[0]), null]); st.preds.push((l: Linha) => l[args[0]] != null); } }
        else if (p === "range") st.faixa = [Number(args[0]), Number(args[1])];
        else if (p === "select" && st.op !== "select") st.retornar = true;
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

// ── Provedores falsos ────────────────────────────────────────────────
/** ML: por seller, id → resposta do multiget ({code, body}); id sem entrada = OMITIDO da resposta. */
let ML: Record<string, Record<string, any>> = {};
let SP: Record<string, { itens: Record<string, { modelos: string[]; extra?: Linha }>; erro?: boolean }> = {};
let chamadas: Array<{ alvo: string; token?: string | null; ids?: string[]; shop?: string }> = [];
globalThis.fetch = (async (url: any, init?: any) => {
  const alvo = String(url);
  const json = (body: any, status = 200) => ({ ok: status < 400, status, json: async () => JSON.parse(JSON.stringify(body)), text: async () => JSON.stringify(body) }) as any;
  if (alvo.includes("shopee.teste.invalid")) {
    const u = new URL(alvo); const shop = u.searchParams.get("shop_id") ?? ""; const loja = SP[shop] ?? { itens: {} };
    if (u.pathname.endsWith("/product/get_item_base_info")) {
      const ids = String(u.searchParams.get("item_id_list") ?? "").split(",");
      chamadas.push({ alvo: "base_info", ids, shop });
      if (loja.erro) return json({ error: "error_server", message: "falha simulada" });
      return json({ response: { item_list: ids.filter((id) => id in loja.itens).map((id) => ({ item_id: Number(id), item_name: `S ${id}`, has_model: loja.itens[id].modelos.length > 0, ...(loja.itens[id].extra ?? {}) })) } });
    }
    if (u.pathname.endsWith("/product/get_model_list")) {
      const id = u.searchParams.get("item_id") ?? ""; chamadas.push({ alvo: "model_list", ids: [id], shop });
      return json({ response: { model: (loja.itens[id]?.modelos ?? []).map((m) => ({ model_id: Number(m), model_name: `M${m}` })) } });
    }
    return json({ response: {} });
  }
  if (!alvo.includes("api.mercadolibre.com")) throw new Error(`rede proibida: ${alvo}`);
  const h = init?.headers ?? {}; const auth = h.Authorization ?? h.authorization ?? null; const token = auth ? String(auth).replace(/^Bearer\s+/i, "") : null;
  const seller = token ? SELLER[token] : undefined;
  if (alvo.includes("/users/me")) { chamadas.push({ alvo: "me", token }); return seller ? json({ id: Number(seller) }) : json({}, 401); }
  const m = /\/items\?ids=([^&]*)/.exec(alvo);
  if (m) {
    const ids = decodeURIComponent(m[1]).split(","); chamadas.push({ alvo: "multiget", token, ids });
    const dele = ML[seller ?? ""] ?? {};
    return json(ids.filter((id) => id in dele).map((id) => dele[id]));
  }
  return json({}, 404);
}) as any;

// ── Cenário ─────────────────────────────────────────────────────────
const FUTURO = () => new Date(Date.now() + 3600_000).toISOString();
const lojaML = (id: string, dono: string, token: string) => ({ id, user_id: dono, marketplace: "ML", ativo: true, nickname: id.slice(0, 4), nome: id.slice(0, 4), seller_id: SELLER[token],
  access_token: token, refresh_token: "<r>", token_expires_at: FUTURO(), created_at: "2026-01-01" });
const ok200 = (id: string, extra: Linha = {}) => ({ code: 200, body: { id, title: `T ${id}`, ...extra } });
const row = (id: string, mkt: "ML" | "Shopee", loja: string, item: string, variacao: string | null, extra: Linha = {}): Linha =>
  ({ id, user_id: U, marketplace: mkt, loja_id: loja, ml_item_id: item, variation_id: variacao, nome: `n ${item}`, ativo: true, custo_produto: 9, status_marketplace: null, visto_em: null, ...extra });
function semearML() {
  BANCO = {
    lojas: [lojaML(LOJA_A, U, TOKEN_A), lojaML(LOJA_B, U, TOKEN_B), lojaML(LOJA_X, OUTRO, TOKEN_X),
      { id: SP_A, user_id: U, marketplace: "Shopee", ativo: true, nickname: "spa", nome: "spa", shop_id: "900", created_at: "2026-01-01" }],
    anuncios: [
      row("a-act", "ML", LOJA_A, "MLB1", null),
      row("a-raw", "ML", LOJA_A, "MLB2", null),
      row("a-sem", "ML", LOJA_A, "MLB3", null, { status_marketplace: "paused", visto_em: T1.toISOString() }),
      row("a-404", "ML", LOJA_A, "MLB4", null),
      row("a-403", "ML", LOJA_A, "MLB5", null),
      row("a-div", "ML", LOJA_A, "MLB6", null),
      row("a-omit", "ML", LOJA_A, "MLB7", null),
      row("a-del", "ML", LOJA_A, "MLB8", null, { ativo: false }),
      row("a-v501", "ML", LOJA_A, "MLB9", "501"), row("a-v502", "ML", LOJA_A, "MLB9", "502"), row("a-v-null", "ML", LOJA_A, "MLB9", null),
      row("a-inv", "ML", LOJA_A, "12345678901", null, { ativo: false }),
      row("b-act", "ML", LOJA_B, "MLB1", null),
      row("s-x", "Shopee", SP_A, "MLB1", null),
    ],
  };
  ML = {
    "111": {
      MLB1: ok200("MLB1", { status: "active" }), MLB2: ok200("MLB2", { status: "SOME_PROVIDER_RAW_VALUE" }), MLB3: ok200("MLB3"),
      MLB4: { code: 404, body: { id: "MLB4", message: "item not found" } }, MLB5: { code: 403, body: { id: "MLB5", message: "forbidden" } },
      MLB6: ok200("MLB99", { status: "active" }), MLB8: ok200("MLB8", { status: "active" }),
      MLB9: ok200("MLB9", { status: "active", variations: [{ id: 501 }] }),
    },
    "222": { MLB1: ok200("MLB1", { status: "b_raw" }) },
  };
  escritas = []; chamadas = []; falharObservacao = false;
}
function semearShopee() {
  BANCO = {
    lojas: [{ id: SP_A, user_id: U, marketplace: "Shopee", ativo: true, nickname: "spa", nome: "spa", shop_id: "900", created_at: "2026-01-01" },
      { id: SP_B, user_id: U, marketplace: "Shopee", ativo: true, nickname: "spb", nome: "spb", shop_id: "901", created_at: "2026-01-01" }],
    anuncios: [
      row("s-1", "Shopee", SP_A, "1001", null), row("s-miss", "Shopee", SP_A, "1002", null),
      row("s-m71", "Shopee", SP_A, "1003", "71"), row("s-m72", "Shopee", SP_A, "1003", "72"), row("s-m-null", "Shopee", SP_A, "1003", null),
      row("s-del", "Shopee", SP_A, "1004", null, { ativo: false }),
      row("sb-1", "Shopee", SP_B, "1001", null),
    ],
  };
  SP = { "900": { itens: { "1001": { modelos: [], extra: { item_status: "NORMAL" } }, "1003": { modelos: ["71"] }, "1004": { modelos: [] } } },
    "901": { itens: { "1001": { modelos: [] } } } };
  escritas = []; chamadas = []; falharObservacao = false;
}
const linha = (id: string) => BANCO.anuncios.find((a) => a.id === id)!;
const intacta = (id: string, antes: string) => JSON.stringify(linha(id)) === antes;

async function principal() {
  console.log = () => {}; console.error = () => {}; console.warn = () => {};
  const RC = await import("../lib/anuncios/refresh-identidades");
  const RML = await import("../lib/anuncios/refresh-identidades-ml");
  const RSP = await import("../lib/anuncios/refresh-identidades-shopee");
  const IML = await import("../lib/anuncios/importacao-ml");
  const G2 = await import("./_guard-v2");
  const AUT = await import("../lib/autenticacao");
  const rotaML = (await import("../app/api/ml/refresh-identidades/route")).POST as (r: Request) => Promise<Response>;
  const rotaSP = (await import("../app/api/shopee/refresh-identidades/route")).POST as (r: Request) => Promise<Response>;
  const { getSupabaseServidor } = await import("../lib/estudio-anuncios/supabase-servidor");
  const banco = () => getSupabaseServidor();
  const sessao = (await AUT.emitirTokenSessao(U)).token;
  const refML = (lojaId: string, extra: Linha = {}) => RML.refrescarIdentidadesML({ banco: banco(), userId: U, lojaId, inicioMs: Date.now(), observadoEm: () => T2, ...extra } as any);
  const refSP = (lojaId: string, extra: Linha = {}) => RSP.refrescarIdentidadesShopee({ banco: banco(), userId: U, lojaId, inicioMs: Date.now(), observadoEm: () => T2,
    cred: { partnerId: "1", partnerKey: "k", accessToken: "t", shopId: SHOP[lojaId] }, ...extra } as any);
  const tenta = async (fn: () => Promise<unknown>) => { try { await fn(); return null; } catch (e: any) { return e; } };
  const req = (rota: string, corpo: unknown) => new Request(`https://exemplo.test${rota}`, { method: "POST", headers: { cookie: `cds_session=${sessao}`, "content-type": "application/json" }, body: JSON.stringify(corpo) });

  secao("\n[ML — refresh por id]");
  t("D1/D2. positivo com status: 'active' e RAW arbitrário gravados byte a byte + visto_em = instante da observação", async () => {
    semearML();
    const r = await refML(LOJA_A);
    assert(r.parcial === false && linha("a-act").status_marketplace === "active" && linha("a-act").visto_em === T2.toISOString(), JSON.stringify(linha("a-act")));
    assert(linha("a-raw").status_marketplace === "SOME_PROVIDER_RAW_VALUE", linha("a-raw").status_marketplace);
  });
  t("D3. resposta positiva SEM status: visto_em avança, status antigo 'paused' preservado", async () => {
    semearML(); await refML(LOJA_A);
    const s = linha("a-sem");
    assert(s.status_marketplace === "paused" && s.visto_em === T2.toISOString(), JSON.stringify(s));
  });
  t("D4/D5/D6/D7. 404, 403, id divergente e item omitido do multiget → NENHUMA escrita; só diagnóstico por motivo", async () => {
    semearML();
    const antes = Object.fromEntries(["a-404", "a-403", "a-div", "a-omit"].map((id) => [id, JSON.stringify(linha(id))]));
    const r = await refML(LOJA_A);
    for (const [id, a] of Object.entries(antes)) assert(intacta(id, a), `${id} foi escrita: ${JSON.stringify(linha(id))}`);
    const alvos = escritas.flatMap((w) => (w.filtros.find(([k]) => k === "in")?.[2] as string[]) ?? []);
    assert(!alvos.some((id) => id in antes), `escrita alcançou não-observado: ${alvos}`);
    const mot = r.naoObservadosPorMotivo;
    assert(mot.code_404 === 1 && mot.code_403 === 1 && mot.sem_resposta_positiva === 2, JSON.stringify(mot));
    assert(!JSON.stringify(escritas.map((w) => w.payload)).match(/deleted|closed|inactive/), "status inferido");
  });
  t("D8. row soft-deleted (ativo=false) é refrescada: ativo continua false; status/visto atualizam", async () => {
    semearML(); await refML(LOJA_A);
    const d = linha("a-del");
    assert(d.ativo === false && d.status_marketplace === "active" && d.visto_em === T2.toISOString(), JSON.stringify(d));
    assert(escritas.every((w) => !("ativo" in (w.payload ?? {}))), "escrita de ativo");
  });
  t("D9. A/B (mesmo item MLB1): refresh de A só consulta ids de A com TOKEN_A e só escreve A; B intocada; Shopee intocada", async () => {
    semearML();
    const b0 = JSON.stringify(linha("b-act")), s0 = JSON.stringify(linha("s-x"));
    await refML(LOJA_A);
    assert(intacta("b-act", b0) && intacta("s-x", s0), "🔴 A tocou B/Shopee");
    const mg = chamadas.filter((c) => c.alvo === "multiget");
    assert(mg.length > 0 && mg.every((c) => c.token === TOKEN_A), `token: ${mg.map((c) => c.token)}`);
    const idsA = new Set(BANCO.anuncios.filter((a) => a.loja_id === LOJA_A).map((a) => a.ml_item_id));
    assert(mg.every((c) => c.ids!.every((id) => idsA.has(id))), "consultou id de fora da loja A");
    for (const w of escritas) {
      const eq = Object.fromEntries(w.filtros.filter(([k]) => k === "eq").map(([, c, v]) => [c, v]));
      assert(eq.user_id === U && eq.marketplace === "ML" && eq.loja_id === LOJA_A, JSON.stringify(w.filtros));
    }
    const a0 = JSON.stringify(linha("a-act")); escritas = []; chamadas = [];
    await refML(LOJA_B);
    assert(intacta("a-act", a0) && linha("b-act").status_marketplace === "b_raw", "🔴 B tocou A");
  });
  t("D10. variações: só a variação que VOLTOU (501) é observada; 502 e a row sem variação do item ficam intactas", async () => {
    semearML();
    const v502 = JSON.stringify(linha("a-v502")), vNull = JSON.stringify(linha("a-v-null"));
    await refML(LOJA_A);
    assert(linha("a-v501").visto_em === T2.toISOString() && linha("a-v501").status_marketplace === "active", JSON.stringify(linha("a-v501")));
    assert(intacta("a-v502", v502) && intacta("a-v-null", vNull), "variação ausente observada");
  });
  t("D11. id histórico inválido: nunca vai ao provider; conta em ids_invalidos (1ª fatia); a row fica intacta", async () => {
    semearML();
    const inv = JSON.stringify(linha("a-inv"));
    const r = await refML(LOJA_A);
    assert(r.idsInvalidos === 1 && !chamadas.some((c) => (c.ids ?? []).includes("12345678901")) && intacta("a-inv", inv), JSON.stringify(r));
  });
  t("D12/D13. escrita falha → fatia falha (BANCO) com checkpoint parado; retry converge", async () => {
    semearML(); falharObservacao = true;
    const e = await tenta(() => refML(LOJA_A));
    assert(e && e.codigo === "BANCO" && e.ultimoConcluido === null && linha("a-act").visto_em === null, `${e?.codigo} ${e?.ultimoConcluido}`);
    falharObservacao = false;
    const r = await refML(LOJA_A);
    assert(r.parcial === false && linha("a-act").visto_em === T2.toISOString() && r.observados === 5, JSON.stringify(r));
  });
  t("D14. cursor de outra loja / de outro marketplace / de import / malformado → recusado ANTES do provider", async () => {
    for (const cursor of [RC.codificarCursorRefresh("ML", LOJA_B, "MLB1"), RC.codificarCursorRefresh("Shopee", LOJA_A, "1001"), IML.codificarCursorML(LOJA_A, "MLB1"), "nao-base64!!"]) {
      semearML();
      const e = await tenta(() => refML(LOJA_A, { cursor }));
      assert(e && e.codigo === "CURSOR" && chamadas.length === 0 && escritas.length === 0, `${cursor}: ${e?.codigo} chamadas=${chamadas.length}`);
    }
  });
  t("CUR-ML. fatias: orçamento estourado → 1 lote por fatia, cursor do refresh retoma até o fim; ninguém observado 2x além do necessário", async () => {
    semearML();
    ML["111"] = Object.fromEntries(Array.from({ length: 45 }, (_, i) => [`MLB${100 + i}`, ok200(`MLB${100 + i}`, { status: "active" })]));
    BANCO.anuncios.push(...Array.from({ length: 45 }, (_, i) => row(`n-${i}`, "ML", LOJA_A, `MLB${100 + i}`, null)));
    let cursor: unknown = undefined, fatias = 0;
    for (; fatias < 10; fatias++) {
      const r = await refML(LOJA_A, { cursor, agora: () => Date.now() + 10 * 60_000 });
      if (!r.parcial) break;
      cursor = r.cursor;
    }
    assert(fatias >= 2 && BANCO.anuncios.filter((a) => a.id.startsWith("n-")).every((a) => a.visto_em === T2.toISOString()), `fatias=${fatias}`);
  });
  t("CAP. teto de 60 chamadas por fatia: catálogo com 1300 ids → fatia para com cursor sem passar do teto", async () => {
    semearML();
    ML["111"] = Object.fromEntries(Array.from({ length: 1300 }, (_, i) => [`MLB${1000 + i}`, ok200(`MLB${1000 + i}`)]));
    BANCO.anuncios = BANCO.anuncios.concat(Array.from({ length: 1300 }, (_, i) => row(`c-${i}`, "ML", LOJA_A, `MLB${1000 + i}`, null)));
    const r = await refML(LOJA_A);
    assert(r.parcial === true && r.chamadasProvider <= 60 && chamadas.length <= 60 && r.cursor, `${r.chamadasProvider} ${chamadas.length}`);
  });
  t("ROTA-ML. rota: loja de outro dono → 404 LOJA_ML_INVALIDA antes do provider; loja A → contadores próprios (não importados/atualizados)", async () => {
    semearML();
    const r1 = await rotaML(req("/api/ml/refresh-identidades", { loja_id: LOJA_X }));
    assert(r1.status === 404 && chamadas.length === 0 && escritas.length === 0, `${r1.status}`);
    const r2 = await rotaML(req("/api/ml/refresh-identidades", { loja_id: LOJA_A }));
    const c = await r2.json() as any;
    assert(r2.status === 200 && c.loja_id === LOJA_A && typeof c.observados === "number" && !("importados" in c) && !("atualizados" in c), JSON.stringify(c));
  });

  secao("\n[Shopee — refresh por id (só visto_em)]");
  t("D15/D18/D19. item devolvido → só visto_em; status_marketplace NUNCA gravado (nem NORMAL, nem item_status da resposta)", async () => {
    semearShopee();
    await refSP(SP_A);
    assert(linha("s-1").visto_em === T2.toISOString() && linha("s-1").status_marketplace === null, JSON.stringify(linha("s-1")));
    assert(escritas.every((w) => JSON.stringify(Object.keys(w.payload)) === '["visto_em"]'), JSON.stringify(escritas.map((w) => w.payload)));
    assert(!JSON.stringify(escritas).includes("NORMAL"), "NORMAL gravado");
  });
  t("D16. item ausente do item_list → nenhuma escrita", async () => {
    semearShopee(); const a = JSON.stringify(linha("s-miss"));
    const r = await refSP(SP_A);
    assert(intacta("s-miss", a) && r.naoObservadosPorMotivo.ausente_da_resposta === 1, JSON.stringify(r));
  });
  t("D17. resposta com error → fatia falha (PROVIDER), nada escrito", async () => {
    semearShopee(); SP["900"].erro = true;
    const e = await tenta(() => refSP(SP_A));
    assert(e && e.codigo === "PROVIDER" && escritas.length === 0, `${e?.codigo}`);
  });
  t("D20. models: só o model que VOLTOU (71) é observado; 72 e a row sem model do item ficam intactas", async () => {
    semearShopee(); const m72 = JSON.stringify(linha("s-m72")), mn = JSON.stringify(linha("s-m-null"));
    await refSP(SP_A);
    assert(linha("s-m71").visto_em === T2.toISOString() && intacta("s-m72", m72) && intacta("s-m-null", mn), "model ausente observado");
  });
  t("D21. A/B (mesmo item 1001): refresh de A só consulta a shop de A e só escreve A", async () => {
    semearShopee(); const b = JSON.stringify(linha("sb-1"));
    await refSP(SP_A);
    assert(intacta("sb-1", b) && chamadas.every((c) => c.shop === "900"), "🔴 A tocou B");
    for (const w of escritas) {
      const eq = Object.fromEntries(w.filtros.filter(([k]) => k === "eq").map(([, c, v]) => [c, v]));
      assert(eq.user_id === U && eq.marketplace === "Shopee" && eq.loja_id === SP_A, JSON.stringify(w.filtros));
    }
  });
  t("D22. soft-deleted (ativo=false) é refrescada; ativo continua false", async () => {
    semearShopee(); await refSP(SP_A);
    assert(linha("s-del").ativo === false && linha("s-del").visto_em === T2.toISOString(), JSON.stringify(linha("s-del")));
  });
  t("D23/D24. escrita falha → checkpoint parado (BANCO); retry converge", async () => {
    semearShopee(); falharObservacao = true;
    const e = await tenta(() => refSP(SP_A));
    assert(e && e.codigo === "BANCO" && e.ultimoConcluido === null && linha("s-1").visto_em === null, `${e?.codigo} ${e?.ultimoConcluido}`);
    falharObservacao = false;
    const r = await refSP(SP_A);
    assert(r.parcial === false && linha("s-1").visto_em === T2.toISOString() && r.observados === 3, JSON.stringify(r));
  });
  t("D25. cursor Shopee de outra loja / de ML / de import → recusado antes do provider", async () => {
    const SPI = await import("../lib/anuncios/importacao-shopee");
    for (const cursor of [RC.codificarCursorRefresh("Shopee", SP_B, "1001"), RC.codificarCursorRefresh("ML", SP_A, "MLB1"), SPI.codificarCursor(SP_A, "1001")]) {
      semearShopee();
      const e = await tenta(() => refSP(SP_A, { cursor }));
      assert(e && e.codigo === "CURSOR" && chamadas.length === 0, `${e?.codigo} ${chamadas.length}`);
    }
  });
  t("ROTA-SP. rota Shopee: loja ML ou de fora → recusa antes da Shopee; sem loja e 2 lojas → 409", async () => {
    semearShopee();
    const r1 = await rotaSP(req("/api/shopee/refresh-identidades", { loja_id: LOJA_A }));
    assert(r1.status === 404 && chamadas.length === 0, `${r1.status}`);
    const r2 = await rotaSP(req("/api/shopee/refresh-identidades", {}));
    assert(r2.status === 409 && chamadas.length === 0, `${r2.status}`);
  });

  secao("\n[guard]");
  t("I9/I10. Guard V2 limpo (observação separada de ativo + refresh escopado por loja)", () => {
    const i10 = G2.refreshDeIdentidadesForaDaLoja(), v2 = G2.invariantesV2(undefined, { zonas: false });
    assert(i10.length === 0 && v2.length === 0, [...i10, ...v2].join(" | "));
  });

  await fila;
  imprimir(`\n${falhou === 0 ? "✓" : "✗"} ANUNCIOS-REFRESH-IDENTIDADES — ${ok} passaram, ${falhou} falharam`);
  process.exit(falhou === 0 ? 0 : 1);
}
principal().catch((e) => { imprimir("ERRO", e?.message ?? e); process.exit(1); });
