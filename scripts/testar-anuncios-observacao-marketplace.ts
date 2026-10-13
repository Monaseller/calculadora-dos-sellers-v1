/**
 * CDS V2 — Fase 2H-C: observação do marketplace (`status_marketplace` + `visto_em`) pelos imports ML e Shopee.
 *
 * Contrato provado (motores REAIS: lib/anuncios/importacao-ml.ts e importacao-shopee.ts, helper
 * lib/anuncios/observacao-marketplace.ts):
 *   • `ativo` é do usuário — nenhum writer do provider o altera (nem em row soft-deleted observada);
 *   • status RAW byte a byte quando presente (ML: `item.status`); resposta válida sem status → só
 *     `visto_em` avança e o status anterior fica; nunca `status_marketplace = null`;
 *   • ausência (identidade que não voltou) não escreve status, visto_em nem ativo;
 *   • `visto_em` = instante da observação (seam `observadoEm`), não `last_updated`/`created_at`;
 *   • gravação em lote por in(ids) + dono + marketplace + loja que confirma TODAS as rows; A nunca toca B;
 *   • ordem: negócio → observação → cursor; falha da observação = fatia falha, cursor não avança, retry
 *     converge; contadores de negócio (importados/atualizados/ignorados) intactos;
 *   • Shopee: status NÃO provado em resposta gravada → só `visto_em` (nunca NORMAL por inferência).
 *
 * Duplo do PostgREST: filtros eq/in/not/or, UPDATE com .select() devolve as rows afetadas, UNIQUE ML/Shopee
 * por identidade; falhas injetáveis. Duplos de ML e Shopee. Sem rede, sem banco, sem credencial real.
 * Uso: npx tsx scripts/testar-anuncios-observacao-marketplace.ts
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

const U = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LOJA_A = "11111111-1111-4111-8111-111111111111", LOJA_B = "22222222-2222-4222-8222-222222222222";
const SP_A = "33333333-3333-4333-8333-333333333333", SP_B = "44444444-4444-4444-8444-444444444444";
const TOKEN_A = "<TOKEN_A>", TOKEN_B = "<TOKEN_B>";
const SELLER: Record<string, string> = { [TOKEN_A]: "111", [TOKEN_B]: "222" };
const T1 = new Date("2026-10-01T10:00:00.000Z"), T2 = new Date("2026-10-13T12:00:00.000Z");

// ── PostgREST falso ──────────────────────────────────────────────────
type Linha = Record<string, any>;
let BANCO: Record<string, Linha[]> = {};
let escritas: Array<{ tabela: string; op: string; payload: any; filtros: Array<[string, string, any]> }> = [];
let falharObservacao = false;          // UPDATE só de observação → erro do banco
let confirmarParcial = false;          // UPDATE só de observação → banco "confirma" uma row a menos
let seq = 0;
const ehObservacao = (p: any) => p && typeof p === "object" && !Array.isArray(p) && Object.keys(p).length > 0
  && Object.keys(p).every((k) => k === "visto_em" || k === "status_marketplace");
const chave = (l: Linha) => l.ml_item_id != null ? [l.user_id, l.loja_id, l.marketplace, l.ml_item_id, l.variation_id ?? ""].join("|") : null;
function clienteFalso() {
  return { from(tabela: string) {
    const st: any = { op: "select", payload: null, filtros: [] as Array<[string, string, any]>, preds: [] as Array<(l: Linha) => boolean>, faixa: null, retornar: false };
    const exec = () => {
      const linhas = BANCO[tabela] ?? (BANCO[tabela] = []);
      const alvo = () => linhas.filter((l) => st.preds.every((p: any) => p(l)));
      if (st.op === "insert") {
        escritas.push({ tabela, op: "insert", payload: st.payload, filtros: [...st.filtros] });
        const novos = (Array.isArray(st.payload) ? st.payload : [st.payload]).map((n: Linha) => ({ id: `novo-${++seq}`, ...n }));
        const vistas = new Set(linhas.map(chave).filter(Boolean));
        for (const n of novos) { const k = chave(n); if (k && vistas.has(k)) return { data: null, error: { code: "23505", message: "duplicate key" } }; if (k) vistas.add(k); }
        linhas.push(...novos);
        return { data: novos.map((n: Linha) => ({ id: n.id })), error: null };
      }
      if (st.op === "update") {
        escritas.push({ tabela, op: "update", payload: st.payload, filtros: [...st.filtros] });
        if (ehObservacao(st.payload) && falharObservacao) return { data: null, error: { message: "falha simulada na observacao" } };
        const a = alvo();
        for (const l of a) Object.assign(l, st.payload);
        let dados = a.map((l) => ({ id: l.id }));
        if (ehObservacao(st.payload) && confirmarParcial) dados = dados.slice(1);
        return { data: st.retornar ? dados : null, error: null };
      }
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
        else if (p === "not") { if (args[1] === "is" && args[2] === null) st.preds.push((l: Linha) => l[args[0]] != null); }
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

// ── Mercado Livre e Shopee falsos ─────────────────────────────────────
let CAT_ML: Record<string, any[]> = {};
let CAT_SP: Record<string, Array<{ id: string; modelos: string[]; extra?: Linha }>> = {};
globalThis.fetch = (async (url: any, init?: any) => {
  const alvo = String(url);
  const json = (body: any, status = 200) => ({ ok: status < 400, status, json: async () => JSON.parse(JSON.stringify(body)), text: async () => JSON.stringify(body) }) as any;
  if (alvo.includes("shopee.teste.invalid")) {
    const u = new URL(alvo); const cat = CAT_SP[u.searchParams.get("shop_id") ?? ""] ?? [];
    if (u.pathname.endsWith("/product/get_item_list")) return json({ response: { item: cat.map((i) => ({ item_id: Number(i.id) })), has_next_page: false } });
    if (u.pathname.endsWith("/product/get_item_base_info")) {
      const ids = String(u.searchParams.get("item_id_list") ?? "").split(",");
      return json({ response: { item_list: cat.filter((i) => ids.includes(i.id)).map((i) => ({ item_id: Number(i.id), item_name: `S ${i.id}`, has_model: i.modelos.length > 0, price_info: [{ current_price: 20 }], ...(i.extra ?? {}) })) } });
    }
    if (u.pathname.endsWith("/product/get_model_list")) {
      const it = cat.find((i) => i.id === u.searchParams.get("item_id"));
      return json({ response: { model: (it?.modelos ?? []).map((m) => ({ model_id: Number(m), model_name: `M${m}`, price_info: [{ current_price: 20 }], model_sku: `SKU-${m}` })) } });
    }
    return json({ response: {} });
  }
  if (!alvo.includes("api.mercadolibre.com")) throw new Error(`rede proibida: ${alvo}`);
  const h = init?.headers ?? {}; const auth = h.Authorization ?? h.authorization ?? null;
  const seller = auth ? SELLER[String(auth).replace(/^Bearer\s+/i, "")] : undefined;
  if (alvo.includes("/users/me")) return seller ? json({ id: Number(seller) }) : json({}, 401);
  let m = /\/users\/(\d+)\/items\/search\?status=active&limit=(\d+)&offset=(\d+)/.exec(alvo);
  if (m) return json({ results: (CAT_ML[seller ?? ""] ?? []).map((i) => i.id).slice(Number(m[3]), Number(m[3]) + Number(m[2])) });
  m = /\/items\?ids=([^&]*)/.exec(alvo);
  if (m) {
    const ids = decodeURIComponent(m[1]).split(","); const meus = new Map((CAT_ML[seller ?? ""] ?? []).map((i) => [i.id, i]));
    return json(ids.map((id) => meus.has(id) ? { code: 200, body: meus.get(id) } : { code: 404, body: null }));
  }
  if (alvo.includes("/categories/")) return json({ name: "Categoria", path_from_root: [{ name: "Raiz" }, { name: "Categoria" }] });
  return json({}, 404);
}) as any;

// ── Cenário ─────────────────────────────────────────────────────────
const FUTURO = () => new Date(Date.now() + 3600_000).toISOString();
const lojaML = (id: string, token: string) => ({ id, user_id: U, marketplace: "ML", ativo: true, nickname: id.slice(0, 4), nome: id.slice(0, 4), seller_id: SELLER[token],
  access_token: token, refresh_token: "<r>", token_expires_at: FUTURO(), created_at: "2026-01-01" });
/** item ML; `status` só entra no corpo se informado (resposta válida pode não trazê-lo). */
function itemML(id: string, opts: { status?: string; variacoes?: number[]; preco?: number } = {}): any {
  return { id, title: `T ${id}`, price: opts.preco ?? 100, listing_type_id: "gold_special", category_id: "MLB1234", thumbnail: `th-${id}`, permalink: `pl-${id}`,
    seller_custom_field: null, shipping: { logistic_type: "me2", free_shipping: false }, last_updated: "2020-01-01T00:00:00.000Z",
    ...(opts.status !== undefined ? { status: opts.status } : {}),
    variations: (opts.variacoes ?? []).map((v) => ({ id: v, price: opts.preco ?? 100, seller_custom_field: null, attribute_combinations: [{ value_name: `V${v}` }] })) };
}
function rowML(id: string, loja: string, item: string, variacao: string | null, extra: Linha = {}): Linha {
  return { id, user_id: U, marketplace: "ML", loja_id: loja, ml_item_id: item, variation_id: variacao, nome: `T ${item}`, preco_anuncio: 100, tipo_anuncio: "Clássico",
    logistic_type: "me2", frete_gratis: false, thumbnail: `th-${item}`, permalink: `pl-${item}`, peso_kg: null, custo_frete: 0, sku: "MANUAL", custo_produto: 7, insumos: 2,
    imposto: 6, margem_desejada: 33, preco_ideal: 77, ativo: true, status_marketplace: null, visto_em: null, ...extra };
}
function semearML() {
  BANCO = {
    lojas: [lojaML(LOJA_A, TOKEN_A), lojaML(LOJA_B, TOKEN_B)],
    anuncios: [
      rowML("a-1", LOJA_A, "MLB1", null),
      rowML("a-2", LOJA_A, "MLB2", "501"), rowML("a-3", LOJA_A, "MLB2", "502"),
      rowML("a-del", LOJA_A, "MLB4", null, { ativo: false }),
      rowML("a-old", LOJA_A, "MLB5", null, { status_marketplace: "paused", visto_em: T1.toISOString() }),
      rowML("a-aus", LOJA_A, "MLB9", null, { status_marketplace: "known_raw", visto_em: T1.toISOString() }),
      rowML("b-1", LOJA_B, "MLB1", null, { status_marketplace: "b_raw", visto_em: T1.toISOString() }),
    ],
  };
  CAT_ML = {
    "111": [itemML("MLB1", { status: "active" }), itemML("MLB2", { status: "active", variacoes: [501, 502] }), itemML("MLB3", { status: "active" }),
      itemML("MLB4", { status: "active" }), itemML("MLB5")],                         // MLB5 SEM status; MLB9 ausente
    "222": [itemML("MLB1", { status: "SOME_PROVIDER_RAW_VALUE" })],
  };
  escritas = []; falharObservacao = false; confirmarParcial = false; seq = 0;
}
const rowSP = (id: string, loja: string, item: string, modelo: string | null, extra: Linha = {}): Linha =>
  ({ id, user_id: U, marketplace: "Shopee", loja_id: loja, ml_item_id: item, variation_id: modelo, nome: modelo ? `S ${item} - M${modelo}` : `S ${item}`, preco_anuncio: 20,
    thumbnail: null, sku: modelo ? `SKU-${modelo}` : null, custo_produto: 5, insumos: 1, imposto: 3, ativo: true, status_marketplace: null, visto_em: null, ...extra });
function semearShopee() {
  BANCO = { anuncios: [
    rowSP("s-1", SP_A, "1001", null), rowSP("s-2", SP_A, "1002", "71"), rowSP("s-del", SP_A, "1003", null, { ativo: false }),
    rowSP("s-aus", SP_A, "1009", null, { visto_em: T1.toISOString() }), rowSP("sb-1", SP_B, "1001", null),
  ] };
  // a resposta FALSA traz item_status, mas nenhuma resposta GRAVADA prova o campo: o writer não pode usá-lo
  CAT_SP = { "900": [{ id: "1001", modelos: [], extra: { item_status: "NORMAL" } }, { id: "1002", modelos: ["71"] }, { id: "1003", modelos: [] }, { id: "1004", modelos: [] }] };
  escritas = []; falharObservacao = false; confirmarParcial = false; seq = 0;
}
const linha = (id: string) => BANCO.anuncios.find((a) => a.id === id)!;
const doItem = (loja: string, item: string) => BANCO.anuncios.filter((a) => a.loja_id === loja && a.ml_item_id === item);
const obsUpdates = () => escritas.filter((w) => w.tabela === "anuncios" && w.op === "update" && ehObservacao(w.payload));
const negocioUpdates = () => escritas.filter((w) => w.tabela === "anuncios" && w.op === "update" && !ehObservacao(w.payload));
const semObs = (l: Linha) => { const { status_marketplace, visto_em, ...r } = l; return JSON.stringify(r); };

async function principal() {
  console.log = () => {}; console.error = () => {}; console.warn = () => {};
  const OBS = await import("../lib/anuncios/observacao-marketplace");
  const ML = await import("../lib/anuncios/importacao-ml");
  const SP = await import("../lib/anuncios/importacao-shopee");
  const G2 = await import("./_guard-v2");
  const { getSupabaseServidor } = await import("../lib/estudio-anuncios/supabase-servidor");
  const banco = () => getSupabaseServidor();
  const importarML = (lojaId: string, em = T2, extra: Linha = {}) => ML.importarCatalogoML({ banco: banco(), userId: U, lojaId, inicioMs: Date.now(), observadoEm: () => em, ...extra } as any);
  const importarSP = (lojaId: string, em = T2) => SP.importarFatiaShopee({ banco: banco(), userId: U, lojaId, ultimoItem: null, inicioMs: Date.now(), orcamentoMs: 600_000, observadoEm: () => em,
    cred: { partnerId: "1", partnerKey: "k", accessToken: "t", shopId: lojaId === SP_A ? "900" : "901" } } as any);
  const tenta = async (fn: () => Promise<unknown>) => { try { await fn(); return null; } catch (e: any) { return e; } };

  secao("\n[0. helper]");
  t("H1. com status RAW → { status_marketplace: raw (byte a byte), visto_em }; sem status/vazio/não-string → só { visto_em } (nunca null)", () => {
    for (const raw of ["active", "SOME_PROVIDER_RAW_VALUE", "Under Review ", "pausado/ç"]) {
      const o = OBS.observacaoPositiva(T2, raw);
      assert(o.status_marketplace === raw && o.visto_em === T2.toISOString() && Object.keys(o).length === 2, JSON.stringify(o));
    }
    for (const sem of [undefined, null, "", "   ", 7, { s: 1 }]) {
      const o = OBS.observacaoPositiva(T2, sem);
      assert(JSON.stringify(Object.keys(o)) === '["visto_em"]' && !("status_marketplace" in o), `${JSON.stringify(sem)} → ${JSON.stringify(o)}`);
    }
    let erro = ""; try { OBS.observacaoPositiva(new Date("x")); } catch (e: any) { erro = e.message; }
    assert(/instante/.test(erro), "instante inválido aceito");
  });
  t("K. lote: in(ids) + dono + marketplace + loja; >200 ids em lotes; confirma TODAS; confirmação parcial ou erro → false", async () => {
    BANCO = { anuncios: Array.from({ length: 450 }, (_, i) => rowSP(`x-${i}`, SP_A, String(5000 + i), null)) }; escritas = []; falharObservacao = false; confirmarParcial = false;
    const pares = BANCO.anuncios.map((a) => ({ id: a.id, obs: OBS.observacaoPositiva(T2) }));
    assert(await OBS.gravarObservacoes(banco(), { userId: U, lojaId: SP_A, marketplace: "Shopee" }, pares) === true, "lote íntegro recusado");
    assert(obsUpdates().length === 3 && obsUpdates().every((w) => (w.filtros.find(([k]) => k === "in")?.[2] as any[]).length <= 200), `lotes: ${obsUpdates().map((w) => (w.filtros.find(([k]) => k === "in")?.[2] as any[]).length)}`);
    for (const w of obsUpdates()) {
      const eq = Object.fromEntries(w.filtros.filter(([k]) => k === "eq").map(([, c, v]) => [c, v]));
      assert(eq.user_id === U && eq.marketplace === "Shopee" && eq.loja_id === SP_A, JSON.stringify(w.filtros));
    }
    assert(BANCO.anuncios.every((a) => a.visto_em === T2.toISOString()), "row sem observação");
    confirmarParcial = true;
    assert(await OBS.gravarObservacoes(banco(), { userId: U, lojaId: SP_A, marketplace: "Shopee" }, pares.slice(0, 5)) === false, "confirmação parcial aceita");
    confirmarParcial = false; falharObservacao = true;
    assert(await OBS.gravarObservacoes(banco(), { userId: U, lojaId: SP_A, marketplace: "Shopee" }, pares.slice(0, 5)) === false, "erro do banco aceito");
    falharObservacao = false;
    assert(await OBS.gravarObservacoes(banco(), { userId: U, lojaId: SP_B, marketplace: "Shopee" }, pares.slice(0, 5)) === false, "ids de outra loja 'confirmados'");
  });

  secao("\n[1. Mercado Livre]");
  t("A. status RAW 'active' + visto_em = instante da observação (não last_updated) em linha nova e existente; ativo intacto", async () => {
    semearML();
    const r = await importarML(LOJA_A);
    assert(r.parcial === false, JSON.stringify(r));
    const a1 = linha("a-1");
    assert(a1.status_marketplace === "active" && a1.visto_em === T2.toISOString() && a1.ativo === true, JSON.stringify(a1));
    const nova = doItem(LOJA_A, "MLB3")[0];
    assert(nova && nova.status_marketplace === "active" && nova.visto_em === T2.toISOString() && nova.ativo === true, JSON.stringify(nova));
  });
  t("A2. variações: as rows do item recebem o MESMO status do item e o MESMO visto_em", async () => {
    semearML();
    await importarML(LOJA_A);
    const v = doItem(LOJA_A, "MLB2");
    assert(v.length === 2 && v.every((x) => x.status_marketplace === "active" && x.visto_em === T2.toISOString()), JSON.stringify(v.map((x) => [x.variation_id, x.status_marketplace, x.visto_em])));
  });
  t("B. status RAW arbitrário preservado byte a byte (sem lowercase/tradução)", async () => {
    semearML();
    await importarML(LOJA_B);
    assert(linha("b-1").status_marketplace === "SOME_PROVIDER_RAW_VALUE", linha("b-1").status_marketplace);
  });
  t("C. row soft-deleted (ativo=false) observada: ativo continua false; status/visto_em atualizam; nenhum campo do usuário muda", async () => {
    semearML();
    const antes = semObs(linha("a-del"));
    await importarML(LOJA_A);
    const d = linha("a-del");
    assert(d.ativo === false && d.status_marketplace === "active" && d.visto_em === T2.toISOString(), JSON.stringify(d));
    assert(semObs(d) === antes, "campo além da observação mudou");
  });
  t("D. resposta válida SEM status: status antigo 'paused' fica; visto_em avança T1 → T2; o payload não leva status", async () => {
    semearML();
    await importarML(LOJA_A);
    const o = linha("a-old");
    assert(o.status_marketplace === "paused" && o.visto_em === T2.toISOString() && Date.parse(o.visto_em) > T1.getTime(), JSON.stringify(o));
    const doA_old = obsUpdates().filter((w) => (w.filtros.find(([k, c]) => k === "in" && c === "id")?.[2] as string[]).includes("a-old"));
    assert(doA_old.length === 1 && JSON.stringify(Object.keys(doA_old[0].payload)) === '["visto_em"]', JSON.stringify(doA_old.map((w) => w.payload)));
  });
  t("E. ausência: identidade que não voltou (MLB9) — status, visto_em e ativo intactos; nenhuma escrita a alcança", async () => {
    semearML();
    const antes = JSON.stringify(linha("a-aus"));
    await importarML(LOJA_A);
    assert(JSON.stringify(linha("a-aus")) === antes, JSON.stringify(linha("a-aus")));
    assert(!escritas.some((w) => w.op === "update" && JSON.stringify(w.filtros).includes("a-aus")), "escrita alcançou a row ausente");
  });
  t("F. A/B: observação de A só muda A; de B só muda B (mesmo item); filtros dono + ML + loja + in(ids da loja)", async () => {
    semearML();
    const b0 = JSON.stringify(linha("b-1"));
    await importarML(LOJA_A);
    assert(JSON.stringify(linha("b-1")) === b0, "🔴 observação de A alcançou B");
    for (const w of obsUpdates()) {
      const eq = Object.fromEntries(w.filtros.filter(([k]) => k === "eq").map(([, c, v]) => [c, v]));
      const ids = w.filtros.find(([k, c]) => k === "in" && c === "id")?.[2] as string[];
      assert(eq.user_id === U && eq.marketplace === "ML" && eq.loja_id === LOJA_A && ids.length > 0 && ids.every((id) => linha(id).loja_id === LOJA_A), JSON.stringify(w.filtros));
    }
    const a1 = JSON.stringify(linha("a-1"));
    escritas = [];
    await importarML(LOJA_B, new Date("2026-10-14T00:00:00.000Z"));
    assert(JSON.stringify(linha("a-1")) === a1 && linha("b-1").visto_em === "2026-10-14T00:00:00.000Z", "🔴 observação de B alcançou A");
  });
  t("G. observação falha DEPOIS das escritas de negócio → fatia falha (BANCO), sem sucesso falso, cursor NÃO avança", async () => {
    semearML(); falharObservacao = true;
    const e = await tenta(() => importarML(LOJA_A));
    assert(e && e.codigo === "BANCO" && /observacao/.test(e.message) && e.ultimoConcluido === null, `${e?.codigo} ${e?.message} cursor=${e?.ultimoConcluido}`);
    assert(doItem(LOJA_A, "MLB3").length === 1, "escrita de negócio do lote não aconteceu antes da observação");
    assert(linha("a-1").visto_em === null, "observação gravada apesar da falha");
  });
  t("H. retry converge: mesma fatia de novo → observação gravada, nenhuma duplicata, MLB3 agora ignorado (não importado 2x)", async () => {
    semearML(); falharObservacao = true;
    await tenta(() => importarML(LOJA_A));
    falharObservacao = false;
    const r = await importarML(LOJA_A);
    assert(r.parcial === false && r.importados === 0 && linha("a-1").visto_em === T2.toISOString() && doItem(LOJA_A, "MLB3").length === 1, JSON.stringify(r));
    const ks = BANCO.anuncios.filter((a) => a.loja_id === LOJA_A).map((a) => `${a.ml_item_id}|${a.variation_id ?? ""}`);
    assert(new Set(ks).size === ks.length, "duplicata");
  });
  t("CNT. contadores de negócio intactos: 2ª passada → 0 importados, 0 atualizados, todas ignoradas; só observação escrita", async () => {
    semearML();
    await importarML(LOJA_A);
    escritas = [];
    const r2 = await importarML(LOJA_A, new Date("2026-10-15T00:00:00.000Z"));
    assert(r2.importados === 0 && r2.atualizados === 0 && r2.ignorados === 6, JSON.stringify(r2));
    assert(negocioUpdates().length === 0 && !escritas.some((w) => w.op === "insert") && obsUpdates().length > 0, "escrita de negócio na 2ª passada");
    assert(obsUpdates().every((w) => !("ativo" in w.payload) && Object.keys(w.payload).every((k) => k === "visto_em" || k === "status_marketplace")), "observação com campo do usuário");
  });
  t("CUR. orçamento estoura no 2º lote: a fatia devolve cursor só depois da observação do 1º lote gravada", async () => {
    semearML();
    CAT_ML["111"] = Array.from({ length: 30 }, (_, i) => itemML(`MLB${100 + i}`, { status: "active" }));
    // orçamento já estourado: o motor sempre processa o 1º lote e para antes do 2º
    const r = await importarML(LOJA_A, T2, { agora: () => Date.now() + 10 * 60_000 });
    assert(r.parcial === true && r.cursor, JSON.stringify(r));
    const gravadas = BANCO.anuncios.filter((a) => a.loja_id === LOJA_A && /^MLB1\d\d$/.test(a.ml_item_id));
    assert(gravadas.length === 20 && gravadas.every((a) => a.visto_em === T2.toISOString()), `${gravadas.length} ${gravadas.filter((a) => !a.visto_em).length} sem visto_em`);
  });

  secao("\n[2. Shopee — só visto_em (status não provado em resposta gravada)]");
  t("I. Shopee: observação só { visto_em } (linha nova e existente, com e sem model); ativo e campos do usuário intactos", async () => {
    semearShopee();
    const antes = semObs(linha("s-1"));
    const r = await importarSP(SP_A);
    assert(r.parcial === false, JSON.stringify(r));
    assert(["s-1", "s-2", "s-del"].every((id) => linha(id).visto_em === T2.toISOString()), JSON.stringify(BANCO.anuncios.map((a) => [a.id, a.visto_em])));
    const nova = doItem(SP_A, "1004")[0];
    assert(nova && nova.visto_em === T2.toISOString() && !("status_marketplace" in nova && nova.status_marketplace !== null), JSON.stringify(nova));
    assert(obsUpdates().length > 0 && obsUpdates().every((w) => JSON.stringify(Object.keys(w.payload)) === '["visto_em"]'), JSON.stringify(obsUpdates().map((w) => w.payload)));
    assert(semObs(linha("s-1")) === antes && linha("s-del").ativo === false, "campo além da observação mudou / ativo mudou");
  });
  t("J. Shopee NUNCA grava status (nem NORMAL do filtro, nem item_status da resposta não-provada); ausência intacta; loja B intacta", async () => {
    semearShopee();
    const aus = JSON.stringify(linha("s-aus")), b = JSON.stringify(linha("sb-1"));
    await importarSP(SP_A);
    assert(BANCO.anuncios.every((a) => a.status_marketplace === null || a.status_marketplace === undefined), JSON.stringify(BANCO.anuncios.map((a) => [a.id, a.status_marketplace])));
    assert(!JSON.stringify(escritas.map((w) => w.payload)).includes("NORMAL"), "NORMAL gravado");
    assert(JSON.stringify(linha("s-aus")) === aus && JSON.stringify(linha("sb-1")) === b, "ausente ou loja B alterada");
    for (const w of obsUpdates()) {
      const eq = Object.fromEntries(w.filtros.filter(([k]) => k === "eq").map(([, c, v]) => [c, v]));
      assert(eq.user_id === U && eq.marketplace === "Shopee" && eq.loja_id === SP_A, JSON.stringify(w.filtros));
    }
  });
  t("G2. Shopee: falha da observação → fatia falha (BANCO), cursor não avança; retry converge", async () => {
    semearShopee(); falharObservacao = true;
    const e = await tenta(() => importarSP(SP_A));
    assert(e && e.codigo === "BANCO" && e.ultimoConcluido === null, `${e?.codigo} ${e?.message} ${e?.ultimoConcluido}`);
    falharObservacao = false;
    const r = await importarSP(SP_A);
    assert(r.parcial === false && r.importados === 0 && linha("s-1").visto_em === T2.toISOString() && doItem(SP_A, "1004").length === 1, JSON.stringify(r));
  });

  secao("\n[3. guard]");
  t("I9. Guard V2 limpo (I9_MARKETPLACE_OBSERVATION_IS_SEPARATE_FROM_ATIVO + demais)", () => {
    const i9 = G2.observacaoMisturadaComAtivo(), v2 = G2.invariantesV2(undefined, { zonas: false });
    assert(i9.length === 0 && v2.length === 0, [...i9, ...v2].join(" | "));
  });

  await fila;
  imprimir(`\n${falhou === 0 ? "✓" : "✗"} ANUNCIOS-OBSERVACAO-MARKETPLACE — ${ok} passaram, ${falhou} falharam`);
  process.exit(falhou === 0 ? 0 : 1);
}
principal().catch((e) => { imprimir("ERRO", e?.message ?? e); process.exit(1); });
