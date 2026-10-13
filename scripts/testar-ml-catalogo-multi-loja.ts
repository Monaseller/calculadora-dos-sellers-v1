/**
 * CDS V2 — Fase 2F: catálogo Mercado Livre MULTI-LOJA liberado (estado 4 aplicado), sem migration.
 *
 * Cenário realista: o MESMO dono com ML-A (TOKEN_A) e ML-B (TOKEN_B), ambas ATIVAS, e o MESMO
 * ml_item_id (MLB123), a MESMA variation_id (456) e o MESMO SKU (ABC) nas duas lojas. Prova, pelas
 * ROTAS reais (sessão → loja → credencial → provider → banco):
 *   • import / sync-precos / sync-skus da loja A tocam SÓ A, da loja B SÓ B; TOKEN_A nunca em B e vice-versa;
 *   • sem loja escolhida e com 2+ lojas → 409 ML_STORE_SELECTION_REQUIRED (lojas do dono com rótulo
 *     amigável, sem credencial), provider = 0, escritas = 0;
 *   • loja de outro dono / loja Shopee / loja ML inativa / id malformado → 404 LOJA_ML_INVALIDA antes do
 *     provider, escritas = 0 (loja inativa: identidade histórica válida no schema, mas operação de provider
 *     exige loja ativa — contrato existente do resolvedor, não alterado);
 *   • `loja_id` da ação vence o contexto loja_ativa_id; sem ação, o contexto validado é reutilizado; com
 *     UMA loja ML, nada precisa ser escolhido (UX preservada);
 *   • cursor da loja A enviado com a loja B → 400 antes do provider;
 *   • corrida de INSERT da mesma identidade (estado 4: anuncios_ml_identidade_uq) → a fatia falha
 *     (FALHA_BANCO), nunca sucesso falso, nenhuma row duplicada, cursor NÃO avança; o retry converge.
 *     Não há lease de job: CONCURRENT_IMPORT_JOB_SERIALIZATION = NO (só a identidade final é protegida
 *     pelo banco);
 *   • tela: a ação leva o `loja_id` (1ª fatia e continuação) e a escolha de conta repete a ação;
 *   • Vendas multi-ML segue barrada (MULTI_ML_VENDAS_NOT_READY); Guard V2 limpo.
 *
 * O duplo do banco aplica a UNIQUE parcial do estado 4 (ML com ml_item_id; manual sem item fica fora).
 * Sem rede, sem banco, sem OAuth, sem credencial real (segredo de sessão placeholder).
 * Uso: npx tsx scripts/testar-ml-catalogo-multi-loja.ts
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

const U = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", OUTRO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", SOLO = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const LOJA_A = "11111111-1111-4111-8111-111111111111", LOJA_B = "22222222-2222-4222-8222-222222222222";
const LOJA_X = "33333333-3333-4333-8333-333333333333", LOJA_SP = "44444444-4444-4444-8444-444444444444";
const LOJA_INATIVA = "55555555-5555-4555-8555-555555555555", LOJA_SOLO = "66666666-6666-4666-8666-666666666666";
const TOKEN_A = "<TOKEN_A>", TOKEN_B = "<TOKEN_B>", TOKEN_X = "<TOKEN_X>", TOKEN_I = "<TOKEN_I>", TOKEN_S = "<TOKEN_S>";
const SELLER: Record<string, string> = { [TOKEN_A]: "111", [TOKEN_B]: "222", [TOKEN_X]: "333", [TOKEN_I]: "444", [TOKEN_S]: "666" };

// ── Banco falso (PostgREST) com a UNIQUE ML do estado 4 ──────────────
type Linha = Record<string, any>;
let BANCO: Record<string, Linha[]> = {};
let escritas: Array<{ tabela: string; op: string; payload: any; filtros: Array<[string, string, any]> }> = [];
let antesDoInsert: (() => void) | null = null;
let seq = 0;
const PAGINA = 1000;
/** anuncios_ml_identidade_uq: (user_id, loja_id, marketplace, ml_item_id, coalesce(variation_id,'')) WHERE ML e item não nulo. */
const chaveML = (l: Linha) => l.marketplace === "ML" && l.ml_item_id != null
  ? [l.user_id, l.loja_id, l.marketplace, l.ml_item_id, l.variation_id ?? ""].join("|") : null;
function clienteFalso() {
  return { from(tabela: string) {
    const st: any = { op: "select", payload: null, filtros: [] as Array<[string, string, any]>, preds: [] as Array<(l: Linha) => boolean>, faixa: null as [number, number] | null, ordem: null as string | null };
    const exec = () => {
      const linhas = BANCO[tabela] ?? (BANCO[tabela] = []);
      const alvo = () => linhas.filter((l) => st.preds.every((p: any) => p(l)));
      if (st.op === "insert" || st.op === "upsert") {
        escritas.push({ tabela, op: st.op, payload: st.payload, filtros: [...st.filtros] });
        if (tabela === "anuncios" && antesDoInsert) { const f = antesDoInsert; antesDoInsert = null; f(); }
        const novos = (Array.isArray(st.payload) ? st.payload : [st.payload]).map((n: Linha) => ({ id: `novo-${++seq}`, ...n }));
        if (tabela === "anuncios") {
          // um INSERT é UM statement: qualquer violação recusa o lote inteiro (nada é gravado)
          if (novos.some((n: Linha) => n.marketplace === "ML" && n.loja_id == null)) return { data: null, error: { code: "23514", message: "anuncios_ml_exige_loja" } };
          const vistas = new Set(linhas.map(chaveML).filter(Boolean));
          for (const n of novos) { const k = chaveML(n); if (k && vistas.has(k)) return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint \"anuncios_ml_identidade_uq\"" } }; if (k) vistas.add(k); }
        }
        linhas.push(...novos);
        return { data: novos.map((n: Linha) => ({ id: n.id })), error: null };
      }
      if (st.op === "update") {
        escritas.push({ tabela, op: "update", payload: st.payload, filtros: [...st.filtros] });
        const a = alvo();
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

// ── Mercado Livre falso: catálogo por seller; registra todo token usado ──
let CATALOGO: Record<string, any[]> = {};
let chamadas: Array<{ url: string; token: string | null }> = [];
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
  m = /\/items\/([A-Z]+\d+)/.exec(alvo);
  if (m) { const it = (CATALOGO[seller ?? ""] ?? []).find((i) => i.id === m![1]); return it ? json(it) : json({}, 404); }
  return json({}, 404);
}) as any;

// ── Cenário A/B ──────────────────────────────────────────────────────
const FUTURO = () => new Date(Date.now() + 3600_000).toISOString();
function lojaML(id: string, dono: string, token: string, nickname: string, ativo = true): Linha {
  return { id, user_id: dono, marketplace: "ML", ativo, nickname, nome: nickname, seller_id: SELLER[token], access_token: token,
    refresh_token: `<refresh-${nickname}>`, token_expires_at: FUTURO(), created_at: "2026-01-01" };
}
function item(id: string, preco: number, varPreco: number, sku: string): any {
  return { id, title: `T ${id}`, price: preco, listing_type_id: "gold_special", category_id: "MLB1234", thumbnail: `thumb-${id}`, permalink: `perm-${id}`,
    seller_custom_field: null, shipping: { logistic_type: "me2", free_shipping: false },
    variations: [{ id: 456, price: varPreco, seller_custom_field: sku, attribute_combinations: [{ value_name: "V456" }] }] };
}
function anuncio(id: string, dono: string, loja: string, extra: Linha = {}): Linha {
  return { id, user_id: dono, marketplace: "ML", loja_id: loja, ml_item_id: "MLB123", variation_id: "456", nome: "T MLB123", preco_anuncio: 100,
    tipo_anuncio: "Clássico", logistic_type: "me2", frete_gratis: false, thumbnail: "thumb-MLB123", permalink: "perm-MLB123", peso_kg: null, custo_frete: 0,
    sku: "ABC", custo_produto: 10, insumos: 0, imposto: 8, ativo: true, ...extra };
}
/** Mesmo dono, ML-A e ML-B ATIVAS, MESMO item/variação/SKU nas duas (custos diferentes). */
function semear(opcoes: { semRows?: boolean } = {}) {
  BANCO = {
    lojas: [lojaML(LOJA_A, U, TOKEN_A, "Loja Azul"), lojaML(LOJA_B, U, TOKEN_B, "Loja Verde"), lojaML(LOJA_INATIVA, U, TOKEN_I, "Loja Antiga", false),
      lojaML(LOJA_X, OUTRO, TOKEN_X, "Alheia"), lojaML(LOJA_SOLO, SOLO, TOKEN_S, "Solo"),
      { id: LOJA_SP, user_id: U, marketplace: "Shopee", ativo: true, nickname: "sp", nome: "sp", seller_id: "9", shop_id: "9", created_at: "2026-01-01" }],
    anuncios: opcoes.semRows ? [] : [
      anuncio("a-1", U, LOJA_A, { custo_produto: 10 }),
      anuncio("b-1", U, LOJA_B, { custo_produto: 99 }),
      { ...anuncio("s-1", U, LOJA_SP), marketplace: "Shopee" },
      anuncio("x-1", OUTRO, LOJA_X),
      anuncio("i-1", U, LOJA_INATIVA),
    ],
  };
  CATALOGO = { "111": [item("MLB123", 120, 51, "ABC")], "222": [item("MLB123", 220, 61, "ABC")], "333": [item("MLB123", 999, 999, "ABC")], "444": [], "666": [item("MLB777", 70, 7, "Z")] };
  escritas = []; chamadas = []; antesDoInsert = null; seq = 0;
}
const escritasAnuncios = () => escritas.filter((w) => w.tabela === "anuncios");
const foto = (pred: (l: Linha) => boolean) => JSON.stringify(BANCO.anuncios.filter(pred).sort((x, y) => String(x.id).localeCompare(String(y.id))));
const tokens = () => chamadas.map((c) => c.token).filter(Boolean) as string[];
const fora = (loja: string) => (l: Linha) => l.loja_id !== loja;

const sessoes: Record<string, string> = {};
function req(dono: string, caminho: string, corpo?: unknown, cookies: Record<string, string> = {}) {
  const cookie = [`cds_session=${sessoes[dono]}`, ...Object.entries(cookies).map(([k, v]) => `${k}=${v}`)].join("; ");
  return new Request(`https://exemplo.test${caminho}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
}

async function principal() {
  console.log = () => {}; console.error = () => {}; console.warn = () => {};
  const G2 = await import("./_guard-v2");
  const UI = await import("../app/(app)/anuncios/importacao-ml");
  const PAG = await import("../app/(app)/anuncios/paginacao");
  const MOT = await import("../lib/anuncios/importacao-ml");
  const AUT = await import("../lib/autenticacao");
  const ROTAS: Record<string, (r: Request) => Promise<Response>> = {
    "importar-anuncios": (await import("../app/api/ml/importar-anuncios/route")).POST,
    "sync-precos": (await import("../app/api/ml/sync-precos/route")).POST,
    "sync-skus": (await import("../app/api/ml/sync-skus/route")).POST,
  };
  const rotaVendasHoje = (await import("../app/api/ml/vendas-hoje/route")).GET as (r: Request) => Promise<Response>;
  for (const d of [U, OUTRO, SOLO]) sessoes[d] = (await AUT.emitirTokenSessao(d)).token;
  const chamar = async (nome: string, dono: string, corpo?: unknown, cookies: Record<string, string> = {}) => {
    const res = await ROTAS[nome](req(dono, `/api/ml/${nome}`, corpo, cookies));
    return { status: res.status, corpo: await res.json() as any };
  };

  secao("\n[1. A/B realista: mesmo dono, mesmo MLB123 / 456 / ABC nas duas lojas]");

  for (const [loja, token, outra, outroToken] of [[LOJA_A, TOKEN_A, LOJA_B, TOKEN_B], [LOJA_B, TOKEN_B, LOJA_A, TOKEN_A]] as const) {
    const n = loja === LOJA_A ? "A" : "B";
    t(`AB-import-${n}. import com loja_id ${n} → lê/grava SÓ ${n}; só a credencial de ${n}; a outra loja intocada`, async () => {
      semear();
      const antes = foto(fora(loja));
      const r = await chamar("importar-anuncios", U, { loja_id: loja });
      assert(r.status === 200 && r.corpo.loja_id === loja && r.corpo.parcial === false, `${r.status} ${JSON.stringify(r.corpo)}`);
      assert(foto(fora(loja)) === antes, `🔴 import ${n} tocou outra loja`);
      assert(tokens().length > 0 && tokens().every((x) => x === token) && !tokens().includes(outroToken), `tokens: ${tokens()}`);
      assert(escritasAnuncios().every((w) => w.op === "insert" ? (w.payload as Linha[]).every((p) => p.loja_id === loja) : w.filtros.some(([, c, v]) => c === "loja_id" && v === loja)), "escrita sem a loja");
      const precoEsperado = loja === LOJA_A ? 51 : 61;
      assert(BANCO.anuncios.find((a) => a.loja_id === loja && a.ml_item_id === "MLB123")!.preco_anuncio === precoEsperado, "preço da variação de outra loja");
      assert(BANCO.anuncios.filter((a) => a.loja_id === outra && a.ml_item_id === "MLB123").length === 1, "duplicou na outra loja");
    });
    t(`AB-precos-${n}. sync-precos com loja_id ${n} → UPDATE só em ${n} (id + dono + ML + loja); credencial só de ${n}`, async () => {
      semear();
      const antes = foto(fora(loja));
      const r = await chamar("sync-precos", U, { loja_id: loja });
      assert(r.status === 200 && r.corpo.erro === false && r.corpo.atualizados === 1, `${r.status} ${JSON.stringify(r.corpo)}`);
      assert(foto(fora(loja)) === antes, `🔴 sync-precos ${n} tocou outra loja`);
      assert(tokens().length > 0 && tokens().every((x) => x === token), `tokens: ${tokens()}`);
      const ups = escritasAnuncios().filter((w) => w.op === "update");
      assert(ups.length === 1 && ups[0].filtros.some(([, c, v]) => c === "loja_id" && v === loja) && ups[0].filtros.some(([, c, v]) => c === "user_id" && v === U), JSON.stringify(ups.map((u) => u.filtros)));
    });
    t(`AB-skus-${n}. sync-skus com loja_id ${n} → lê/escreve SÓ ${n}; payload final = { sku }`, async () => {
      semear();
      for (const a of BANCO.anuncios) a.sku = null;
      const antes = foto(fora(loja));
      const r = await chamar("sync-skus", U, { loja_id: loja });
      assert(r.status === 200 && r.corpo.atualizados === 1, `${r.status} ${JSON.stringify(r.corpo)}`);
      assert(foto(fora(loja)) === antes, `🔴 sync-skus ${n} tocou outra loja`);
      assert(tokens().length > 0 && tokens().every((x) => x === token), `tokens: ${tokens()}`);
      const ups = escritasAnuncios().filter((w) => w.op === "update");
      assert(ups.length === 1 && JSON.stringify(ups[0].payload) === '{"sku":"ABC"}' && ups[0].filtros.some(([, c, v]) => c === "loja_id" && v === loja), JSON.stringify(ups));
    });
  }

  secao("\n[2. seleção: sem loja, loja alheia, Shopee, inativa, malformada]");

  for (const nome of Object.keys(ROTAS)) {
    t(`SEL-${nome}. 2+ lojas ML e SEM loja → 409 ML_STORE_SELECTION_REQUIRED com as lojas do dono (rótulo amigável, sem credencial); provider 0, escritas 0`, async () => {
      semear();
      const r = await chamar(nome, U, {});
      assert(r.status === 409 && r.corpo.codigo === "ML_STORE_SELECTION_REQUIRED", `${r.status} ${JSON.stringify(r.corpo)}`);
      const lojas = r.corpo.lojas as Array<{ id: string; rotulo: string }>;
      assert(JSON.stringify(lojas.map((l) => l.id).sort()) === JSON.stringify([LOJA_A, LOJA_B].sort()), `lojas: ${JSON.stringify(lojas)}`);
      assert(lojas.every((l) => l.rotulo && l.rotulo !== l.id) && JSON.stringify(lojas.map((l) => l.rotulo).sort()) === JSON.stringify(["Loja Azul", "Loja Verde"]), "rótulo não é o nome da conta");
      assert(!/TOKEN|refresh|access_token/i.test(JSON.stringify(r.corpo)), "🔴 resposta carrega credencial");
      assert(chamadas.length === 0 && escritas.length === 0, `provider=${chamadas.length} escritas=${escritas.length}`);
    });
    for (const [caso, loja] of [["outro dono", LOJA_X], ["loja Shopee", LOJA_SP], ["loja ML inativa", LOJA_INATIVA], ["id malformado", "nao-e-uuid"], ["inexistente", "77777777-7777-4777-8777-777777777777"]] as const) {
      t(`INV-${nome}. loja_id de ${caso} → 404 LOJA_ML_INVALIDA antes do provider; escritas 0; nunca cai para outra loja`, async () => {
        semear();
        const r = await chamar(nome, U, { loja_id: loja });
        assert(r.status === 404 && r.corpo.codigo === "LOJA_ML_INVALIDA", `${r.status} ${JSON.stringify(r.corpo)}`);
        assert(chamadas.length === 0 && escritas.length === 0, `provider=${chamadas.length} escritas=${escritas.length}`);
        // o mesmo via contexto (cookie) também não vira autoridade
        semear();
        const r2 = await chamar(nome, U, {}, { loja_ativa_id: loja });
        assert(r2.status === 404 && chamadas.length === 0 && escritas.length === 0, `cookie: ${r2.status} provider=${chamadas.length}`);
      });
    }
  }

  t("CTX1. loja_id da AÇÃO vence o contexto: corpo B + loja_ativa_id A → opera B, nunca A", async () => {
    for (const nome of Object.keys(ROTAS)) {
      semear();
      if (nome === "sync-skus") for (const a of BANCO.anuncios) a.sku = null;
      const antesA = foto((l) => l.loja_id === LOJA_A);
      await chamar(nome, U, { loja_id: LOJA_B }, { loja_ativa_id: LOJA_A });
      assert(tokens().length > 0 && tokens().every((x) => x === TOKEN_B), `${nome}: tokens ${tokens()}`);
      assert(foto((l) => l.loja_id === LOJA_A) === antesA, `${nome}: 🔴 tocou A`);
    }
  });
  t("CTX2. sem loja na ação, o contexto loja_ativa_id VALIDADO é reutilizado (2+ lojas): opera exatamente a loja do contexto", async () => {
    for (const nome of Object.keys(ROTAS)) {
      semear();
      if (nome === "sync-skus") for (const a of BANCO.anuncios) a.sku = null;
      await chamar(nome, U, {}, { loja_ativa_id: LOJA_B });
      assert(tokens().length > 0 && tokens().every((x) => x === TOKEN_B), `${nome}: tokens ${tokens()}`);
    }
  });
  t("UNI. dono com UMA loja ML: nada a escolher — a única loja é resolvida na borda (UX preservada)", async () => {
    for (const nome of Object.keys(ROTAS)) {
      semear();
      BANCO.anuncios.push({ ...anuncio("solo-1", SOLO, LOJA_SOLO), ml_item_id: "MLB777", variation_id: "7", sku: null });
      const r = await chamar(nome, SOLO, {});
      assert(r.status === 200 && tokens().length > 0 && tokens().every((x) => x === TOKEN_S), `${nome}: ${r.status} tokens ${tokens()} ${JSON.stringify(r.corpo)}`);
    }
  });

  secao("\n[3. cursor preso à loja; corrida de INSERT (UNIQUE do estado 4)]");

  t("CUR. cursor da loja A enviado com loja_id B → 400 antes do provider; escritas 0", async () => {
    semear();
    const cursorA = MOT.codificarCursorML(LOJA_A, "MLB100");
    const r = await chamar("importar-anuncios", U, { loja_id: LOJA_B, cursor: cursorA });
    assert(r.status === 400 && chamadas.length === 0 && escritas.length === 0, `${r.status} ${JSON.stringify(r.corpo)} provider=${chamadas.length}`);
  });
  t("RACE. outro job grava a MESMA identidade entre a leitura e o INSERT → 502 FALHA_BANCO (não sucesso), nenhuma row duplicada, cursor não avança; retry converge", async () => {
    semear({ semRows: true });
    antesDoInsert = () => { BANCO.anuncios.push(anuncio("concorrente", U, LOJA_A)); };
    const r = await chamar("importar-anuncios", U, { loja_id: LOJA_A });
    assert(r.status === 502 && r.corpo.codigo === "FALHA_BANCO" && r.corpo.parcial === undefined, `${r.status} ${JSON.stringify(r.corpo)}`);
    assert(r.corpo.cursor === null, `cursor avançou além do lote recusado: ${r.corpo.cursor}`);
    const deA = BANCO.anuncios.filter((a) => a.loja_id === LOJA_A && a.ml_item_id === "MLB123" && a.variation_id === "456");
    assert(deA.length === 1 && deA[0].id === "concorrente", `duplicou: ${JSON.stringify(deA.map((a) => a.id))}`);
    const r2 = await chamar("importar-anuncios", U, { loja_id: LOJA_A });
    assert(r2.status === 200 && r2.corpo.parcial === false && r2.corpo.importados === 0, `retry: ${r2.status} ${JSON.stringify(r2.corpo)}`);
    assert(BANCO.anuncios.filter((a) => a.loja_id === LOJA_A && a.ml_item_id === "MLB123").length === 1, "retry duplicou");
  });
  t("RACE2. a MESMA identidade em lojas diferentes não colide (A e B importam o MLB123/456)", async () => {
    semear({ semRows: true });
    const ra = await chamar("importar-anuncios", U, { loja_id: LOJA_A });
    const rb = await chamar("importar-anuncios", U, { loja_id: LOJA_B });
    assert(ra.status === 200 && rb.status === 200 && ra.corpo.importados === 1 && rb.corpo.importados === 1, `${JSON.stringify(ra.corpo)} ${JSON.stringify(rb.corpo)}`);
  });

  secao("\n[4. tela: a ação leva a loja; escolha repete a ação]");

  t("UI1. importarMLEmFatias com loja escolhida: 1ª fatia { loja_id }, continuação { loja_id, cursor }", async () => {
    const classificar = (s: number, x: string) => PAG.classificarRespostaImportacao(s, x, "Mercado Livre");
    const fatia = (o: Record<string, unknown>) => ({ status: 200, texto: JSON.stringify({ importados: 1, atualizados: 0, ignorados: 0, itens_processados: 1, total: 2, loja_id: LOJA_B, ...o }) });
    const seqOk = [fatia({ parcial: true, cursor: "c1" }), fatia({ parcial: false, cursor: null })];
    const corpos: any[] = [];
    const r = await UI.importarMLEmFatias(async (c) => { corpos.push(c); return seqOk.shift()!; }, classificar, () => {}, LOJA_B);
    assert(r.tipo === "ok" && JSON.stringify(corpos) === JSON.stringify([{ loja_id: LOJA_B }, { loja_id: LOJA_B, cursor: "c1" }]), JSON.stringify(corpos));
    const trocou = [fatia({ parcial: true, cursor: "c1", loja_id: LOJA_A })];
    assert((await UI.importarMLEmFatias(async () => trocou.shift()!, classificar, () => {}, LOJA_B)).tipo === "erro", "servidor trocou a loja escolhida e a tela seguiu");
  });
  t("UI2. 409 ML_STORE_SELECTION_REQUIRED → escolher_loja com as contas; outras respostas não viram escolha", async () => {
    const classificar = (s: number, x: string) => PAG.classificarRespostaImportacao(s, x, "Mercado Livre");
    const corpo409 = JSON.stringify({ erro: true, codigo: "ML_STORE_SELECTION_REQUIRED", lojas: [{ id: LOJA_A, rotulo: "Loja Azul" }, { id: LOJA_B, rotulo: "Loja Verde" }] });
    const r = await UI.importarMLEmFatias(async () => ({ status: 409, texto: corpo409 }), classificar);
    assert(r.tipo === "escolher_loja" && r.lojas.length === 2 && r.lojas[1].rotulo === "Loja Verde", JSON.stringify(r));
    assert(UI.lojasParaEscolherML(409, corpo409)?.length === 2, "sync não reconhece a escolha");
    assert(UI.lojasParaEscolherML(404, JSON.stringify({ codigo: "LOJA_ML_INVALIDA" })) === null && UI.lojasParaEscolherML(409, "não-json") === null, "falso positivo de escolha");
  });

  secao("\n[5. Vendas multi-ML segue barrada; guard]");

  t("V. vendas-hoje com 2 contas ML → 409 MULTI_ML_VENDAS_NOT_READY, provider 0, escritas 0", async () => {
    semear();
    const res = await rotaVendasHoje(new Request("https://exemplo.test/api/ml/vendas-hoje", { headers: { cookie: `cds_session=${sessoes[U]}; loja_ativa_id=${LOJA_A}` } }));
    const corpo: any = await res.json();
    assert(res.status === 409 && corpo.codigo === "MULTI_ML_VENDAS_NOT_READY" && chamadas.length === 0 && escritas.length === 0, `${res.status} ${JSON.stringify(corpo)}`);
  });
  t("G. Guard V2 limpo: I7 (catálogo multi-ML permitido, vendas barrada) e I8 (ação leva a loja)", () => {
    const v2 = G2.invariantesV2(undefined, { zonas: false });
    assert(v2.length === 0, v2.join(" | "));
  });

  await fila;
  imprimir(`\n${falhou === 0 ? "✓" : "✗"} ML-CATALOGO-MULTI-LOJA — ${ok} passaram, ${falhou} falharam`);
  process.exit(falhou === 0 ? 0 : 1);
}
principal().catch((e) => { imprimir("ERRO", e?.message ?? e); process.exit(1); });
