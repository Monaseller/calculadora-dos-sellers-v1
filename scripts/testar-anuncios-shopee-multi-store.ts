/**
 * Suite ANUNCIOS SHOPEE MULTI-LOJA — cada anuncio Shopee pertence a UMA loja.
 *
 * Contrato: dono + loja_id + marketplace + item_id + model_id. O mesmo
 * item/model em outra loja e OUTRO anuncio; importar uma loja nunca toca a
 * outra; o mapa de custo/cadastro da venda e SEMPRE o da loja da venda.
 *
 * Executa o REAL (/api/shopee/importar-anuncios, /api/anuncios POST/PATCH,
 * carregarMapaAnuncios) com:
 *   - sessao real (emitirTokenSessao);
 *   - Supabase em memoria que EMULA as regras do banco das migrations
 *     20261103/20261104 (trigger "loja do dono", UNIQUE de identidade Shopee,
 *     CHECK "Shopee exige loja") — e confere que o SQL as declara;
 *   - Shopee FALSA de catalogo (get_item_list / get_item_base_info /
 *     get_model_list) que registra shop_id/partner_id; qualquer endpoint de
 *     pedido/escrow e registrado como PROIBIDO; qualquer host real lanca.
 *
 * Offline: sem rede, sem banco real, sem OAuth.
 *
 *   npx tsx scripts/testar-anuncios-shopee-multi-store.ts
 */
import "./_server-only-inerte";
import Module from "node:module";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const RAIZ = join(__dirname, "..");
let passou = 0, falhou = 0;
let fila: Promise<void> = Promise.resolve();
function t(nome: string, fn: () => void | Promise<void>) {
  fila = fila.then(async () => {
    try { await fn(); passou++; console.log(`  PASS  ${nome}`); }
    catch (e: any) { falhou++; console.log(`  FALHA ${nome} -> ${e?.message ?? e}`); }
  });
}
function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const fonte = (rel: string) => readFileSync(join(RAIZ, rel), "utf8").replace(/\r\n/g, "\n");

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://placeholder-de-teste.invalid";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "chave-de-teste-invalida";
process.env.SUPABASE_SERVICE_ROLE_KEY = "chave-de-teste-invalida";
process.env.SESSION_SECRET = "segredo-de-teste-com-mais-de-32-bytes-000000";
process.env.SHOPEE_BASE_URL = "https://shopee.teste.invalid";

const DONO_X = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", DONO_Y = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LOJA_A = "11111111-1111-4111-8111-111111111111", LOJA_B = "22222222-2222-4222-8222-222222222222", LOJA_C = "33333333-3333-4333-8333-333333333333";
const SHOP = { [LOJA_A]: "419809235", [LOJA_B]: "481902588", [LOJA_C]: "555000111" } as Record<string, string>;
const FUTURO = new Date(Date.now() + 6 * 3600e3).toISOString();
const loja = (id: string, dono: string, partner: string, criada: string) => ({
  id, user_id: dono, marketplace: "Shopee", seller_id: SHOP[id], shop_id: SHOP[id], partner_id: partner, partner_key: `chave-ficticia-${partner}`,
  access_token: `<access-${SHOP[id]}>`, refresh_token: `<refresh-${SHOP[id]}>`, token_expires_at: FUTURO, ativo: true, nome: `Shopee ${SHOP[id]}`,
  nickname: `Shopee ${SHOP[id]}`, created_at: criada, shopee_sincronizado_ate: null,
});

/** Catalogo FALSO por shop: item → modelos ([] = sem variacao). O item 7001 existe nas DUAS lojas (mesmo id: pior caso). */
const CATALOGO: Record<string, Record<string, string[]>> = {
  "419809235": { "7001": [], "7002": ["71", "72"] },
  "481902588": { "7001": [], "8001": ["81"] },
  "555000111": { "9001": [] },
};

// ── Supabase em memoria + regras do banco (migrations 20261103/20261104) ──
type Linha = Record<string, any>;
let db: Record<string, Linha[]> = {};
let seq = 0;
function cenario() {
  db = {
    lojas: [
      loja(LOJA_A, DONO_X, "2038003", "2026-07-01T00:00:00Z"),
      loja(LOJA_B, DONO_X, "2047853", "2026-10-08T18:40:00Z"),
      loja(LOJA_C, DONO_Y, "2038003", "2026-08-01T00:00:00Z"),
    ],
    anuncios: [], pedidos: [],
  };
}
/** Emula: trigger anuncios_loja_do_dono, UNIQUE anuncios_shopee_identidade_uq e CHECK anuncios_shopee_exige_loja. */
function regraBanco(nova: Linha, ignorarId?: string): string | null {
  if (nova.loja_id != null && !db.lojas.some((l) => l.id === nova.loja_id && l.user_id === nova.user_id)) return "23514 loja_do_dono";
  if (nova.marketplace === "Shopee" && nova.loja_id == null) return "23514 shopee_exige_loja";
  if (nova.marketplace === "Shopee" && nova.ml_item_id != null) {
    const ident = (r: Linha) => [r.user_id, r.loja_id, r.marketplace, r.ml_item_id, r.variation_id ?? ""].join("|");
    if (db.anuncios.some((r) => r.id !== ignorarId && r.marketplace === "Shopee" && r.ml_item_id != null && ident(r) === ident(nova))) return "23505 identidade";
  }
  return null;
}
function clienteFalso() {
  return {
    rpc: async () => ({ data: null, error: { message: "rpc_indisponivel_no_teste" } }),
    from(tabela: string) {
      const st: any = { op: "select", payload: null, filtros: [] as any[], ini: 0, fim: Infinity, unico: false, ordens: [] as any[], retorno: false };
      const casa = (r: Linha) => st.filtros.every(([k, c, v]: any) =>
        k === "eq" ? String(r[c]) === String(v) : k === "in" ? (v as any[]).map(String).includes(String(r[c])) : k === "is" ? (r[c] ?? null) === v
          : k === "gte" ? String(r[c] ?? "") >= String(v) : k === "lte" ? String(r[c] ?? "") <= String(v) : k === "lt" ? String(r[c] ?? "") < String(v) : true);
      const exec = () => {
        const ls = (db[tabela] ??= []);
        if (st.op === "update") {
          const alvo = ls.filter(casa);
          for (const r of alvo) { const err = tabela === "anuncios" ? regraBanco({ ...r, ...st.payload }, r.id) : null; if (err) return { data: null, error: { code: err.slice(0, 5), message: err } }; }
          for (const r of alvo) Object.assign(r, st.payload);
          return { data: alvo.map((r) => ({ ...r })), error: null };
        }
        if (st.op === "insert" || st.op === "upsert") {
          const novos = (Array.isArray(st.payload) ? st.payload : [st.payload]).map((n: Linha) => ({ id: `anuncio-${++seq}`, ...n }));
          for (const n of novos) { const err = tabela === "anuncios" ? regraBanco(n) : null; if (err) return { data: null, error: { code: err.slice(0, 5), message: err } }; }
          for (const n of novos) ls.push({ ...n });
          return st.unico ? { data: novos[0], error: null } : { data: novos, error: null };
        }
        let out = ls.filter(casa).map((r) => ({ ...r }));
        for (const [c, asc] of [...st.ordens].reverse()) out.sort((a, b) => (asc ? 1 : -1) * (String(a[c] ?? "") < String(b[c] ?? "") ? -1 : String(a[c] ?? "") > String(b[c] ?? "") ? 1 : 0));
        const total = out.length;
        out = out.slice(st.ini, Math.min(out.length, st.fim));
        return st.unico ? { data: out[0] ?? null, error: null } : { data: out, error: null, count: total };
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

// ── Shopee falsa de catalogo ─────────────────────────────────────────
let chamadas: { path: string; shopId: string; partnerId: string }[] = [];
/** Precos de catalogo como a Open API v2 entrega: REAIS decimais (mesma unidade de model_discounted_price). */
const PRECO_ITEM = 31.91, PRECO_MODELO = 12.5;
const PROIBIDO = /\/order\/|\/payment\/|escrow|get_order/;
globalThis.fetch = (async (url: any) => {
  const u = new URL(String(url));
  if (u.hostname !== "shopee.teste.invalid") throw new Error(`teste tentou acessar a rede: ${u.hostname}`);
  const shopId = u.searchParams.get("shop_id") ?? "";
  chamadas.push({ path: u.pathname, shopId, partnerId: u.searchParams.get("partner_id") ?? "" });
  const cat = CATALOGO[shopId] ?? {};
  let corpo: any = { response: {} };
  if (u.pathname.endsWith("/product/get_item_list")) corpo = { response: { item: Object.keys(cat).map((id) => ({ item_id: Number(id) })), has_next_page: false } };
  else if (u.pathname.endsWith("/product/get_item_base_info")) {
    const ids = String(u.searchParams.get("item_id_list") ?? "").split(",").filter(Boolean);
    corpo = { response: { item_list: ids.filter((id) => id in cat).map((id) => ({ item_id: Number(id), item_name: `Item ${id} @${shopId}`, has_model: cat[id].length > 0, price_info: [{ current_price: PRECO_ITEM }], sku: `SKU-${id}` })) } };
  } else if (u.pathname.endsWith("/product/get_model_list")) {
    const id = String(u.searchParams.get("item_id"));
    corpo = { response: { model: (cat[id] ?? []).map((m) => ({ model_id: Number(m), model_name: `M${m}`, price_info: [{ current_price: PRECO_MODELO }], model_sku: `SKU-${id}-${m}` })) } };
  }
  return { ok: true, status: 200, json: async () => corpo, text: async () => JSON.stringify(corpo) } as any;
}) as any;

async function principal() {
  const auth = await import("../lib/autenticacao");
  const importar = await import("../app/api/shopee/importar-anuncios/route");
  const rotaAnuncios = await import("../app/api/anuncios/route");
  const rotaAnuncio = await import("../app/api/anuncios/[id]/route");
  const SS = await import("../lib/sync-shopee");
  const sessaoX = (await auth.emitirTokenSessao(DONO_X)).token;
  const H = "https://www.calculadoradossellers.com.br";
  const post = (caminho: string, corpo: unknown) => new Request(`${H}${caminho}`, {
    method: "POST", headers: { "content-type": "application/json", cookie: `cds_session=${sessaoX}` }, body: JSON.stringify(corpo),
  });
  const importarLoja = async (lojaId?: string) => importar.POST(post("/api/shopee/importar-anuncios", lojaId ? { loja_id: lojaId } : {}));
  const daLoja = (id: string) => db.anuncios.filter((a) => a.loja_id === id).map((a) => ({ ...a })).sort((p, q) => String(p.id).localeCompare(String(q.id)));
  const proibidas = () => chamadas.filter((c) => PROIBIDO.test(c.path));
  const patch = (id: string, corpo: unknown) => rotaAnuncio.PATCH(new Request(`${H}/api/anuncios/${id}`, {
    method: "PATCH", headers: { "content-type": "application/json", cookie: `cds_session=${sessaoX}` }, body: JSON.stringify(corpo),
  }), { params: { id } });
  const identidade = (a: Linha) => JSON.stringify([a.user_id, a.loja_id, a.marketplace, a.ml_item_id, a.variation_id ?? null]);

  console.log("\n[A-C. importacao por loja: linhas independentes, uma loja nunca toca a outra]");
  t("A. mesmo dono, lojas A e B, MESMO item 7001 → duas linhas independentes (uma por loja)", async () => {
    cenario(); chamadas = [];
    assert((await importarLoja(LOJA_A)).status === 200, "import A");
    assert((await importarLoja(LOJA_B)).status === 200, "import B");
    const l7001 = db.anuncios.filter((a) => a.ml_item_id === "7001");
    assert(l7001.length === 2 && new Set(l7001.map((a) => a.loja_id)).size === 2 && l7001[0].id !== l7001[1].id, JSON.stringify(l7001.map((a) => [a.id, a.loja_id])));
    assert(db.anuncios.every((a) => a.user_id === DONO_X && a.marketplace === "Shopee" && (a.loja_id === LOJA_A || a.loja_id === LOJA_B)), "linha sem loja/dono");
    // A: 7001 + 7002/71 + 7002/72 ; B: 7001 + 8001/81
    assert(daLoja(LOJA_A).length === 3 && daLoja(LOJA_B).length === 2, `${daLoja(LOJA_A).length}/${daLoja(LOJA_B).length}`);
    assert(chamadas.every((c) => (c.shopId === SHOP[LOJA_A] && c.partnerId === "2038003") || (c.shopId === SHOP[LOJA_B] && c.partnerId === "2047853")), JSON.stringify(chamadas));
    assert(proibidas().length === 0, "chamou pedido/escrow");
  });
  t("B. reimportar A → B intacta (inclusive o custo editado em B)", async () => {
    const b7001 = db.anuncios.find((a) => a.loja_id === LOJA_B && a.ml_item_id === "7001")!;
    b7001.custo_produto = 20; b7001.nome = "editado na B";
    const antesB = JSON.stringify(daLoja(LOJA_B));
    chamadas = [];
    const r = await importarLoja(LOJA_A); const d = await r.json();
    // IMPORT V2: linha igual a da Shopee nao e regravada (ignorados)
    assert(r.status === 200 && d.parcial === false && d.ignorados === 3 && d.atualizados === 0 && d.importados === 0 && d.loja_id === LOJA_A, JSON.stringify(d));
    assert(JSON.stringify(daLoja(LOJA_B)) === antesB, "importar A alterou B");
    assert(chamadas.every((c) => c.shopId === SHOP[LOJA_A]), "import A chamou outra loja");
  });
  t("C. reimportar B → A intacta (inclusive o custo editado em A)", async () => {
    const a7001 = db.anuncios.find((a) => a.loja_id === LOJA_A && a.ml_item_id === "7001")!;
    a7001.custo_produto = 10;
    const antesA = JSON.stringify(daLoja(LOJA_A));
    chamadas = [];
    const r = await importarLoja(LOJA_B); const d = await r.json();
    // nome editado na B volta ao da Shopee (atualizado); 8001/81 igual (ignorado)
    assert(r.status === 200 && d.atualizados === 1 && d.ignorados === 1 && d.importados === 0, JSON.stringify(d));
    assert(JSON.stringify(daLoja(LOJA_A)) === antesA, "importar B alterou A");
    assert(db.anuncios.find((a) => a.loja_id === LOJA_B && a.ml_item_id === "7001")!.custo_produto === 20, "custo da B perdido");
  });

  console.log("\n[D-F. matching da venda: mapa SEMPRE da loja da venda]");
  t("D. venda da loja A → mapa so com anuncios de A (custo de A)", async () => {
    const mapa = await SS.carregarMapaAnuncios(DONO_X, LOJA_A);
    const ids = new Set([...mapa.values()].map((a: any) => a.id));
    assert([...ids].every((id) => db.anuncios.find((a) => a.id === id)!.loja_id === LOJA_A), "mapa de A com anuncio de outra loja");
    assert(mapa.get("7001|")?.custo_produto === 10 && !mapa.has("8001|81"), `custo ${mapa.get("7001|")?.custo_produto}`);
  });
  t("E. venda da loja B → mapa so com anuncios de B (custo de B)", async () => {
    const mapa = await SS.carregarMapaAnuncios(DONO_X, LOJA_B);
    const ids = new Set([...mapa.values()].map((a: any) => a.id));
    assert([...ids].every((id) => db.anuncios.find((a) => a.id === id)!.loja_id === LOJA_B), "mapa de B com anuncio de outra loja");
    assert(mapa.get("7001|")?.custo_produto === 20 && !mapa.has("7002|71") && !mapa.has("7002|"), `custo ${mapa.get("7001|")?.custo_produto}`);
  });
  t("F. 7002/71 cadastrado na A e NAO na B → Cadastro A=sim / B=nao (cadastrado = !!anuncio do mapa DA loja)", async () => {
    const mA = await SS.carregarMapaAnuncios(DONO_X, LOJA_A), mB = await SS.carregarMapaAnuncios(DONO_X, LOJA_B);
    assert(!!mA.get("7002|71") && !mB.get("7002|71") && !mB.get("7002|"), "cadastro vazou entre lojas");
    const src = fonte("lib/sync-shopee.ts");
    assert(/const anuncio\s+= mapaAnuncios\.get\(keyVar\) \?\? mapaAnuncios\.get\(`\$\{itemIdStr\}\|`\) \?\? null;/.test(src) && /cadastrado:\s+!!anuncio,/.test(src), "cadastrado deixou de vir do mapa");
    assert(/carregarMapaAnuncios\(userId, lojaId\)/.test(src) && /carregarMapaAnuncios\(userId, loja\.lojaId\)/.test(fonte("app/api/admin/shopee/backfill-pedidos-0707/route.ts")), "caller sem loja");
  });

  console.log("\n[G-J. fail-closed]");
  t("G/T. loja de OUTRO dono → importacao recusada (nenhuma chamada); banco recusa loja_id alheia", async () => {
    chamadas = []; const n = db.anuncios.length;
    const r = await importarLoja(LOJA_C);
    assert(r.status === 404 && chamadas.length === 0 && db.anuncios.length === n, `status ${r.status}, chamadas ${chamadas.length}`);
    assert(regraBanco({ user_id: DONO_X, loja_id: LOJA_C, marketplace: "Shopee", ml_item_id: "1" }) === "23514 loja_do_dono", "regra loja-do-dono");
    const sql = fonte("supabase/migrations/20261103_anuncios_loja_fase1.sql");
    assert(/create trigger anuncios_loja_do_dono before insert or update of loja_id, user_id on public\.anuncios/.test(sql)
      && /l\.id = new\.loja_id and l\.user_id = new\.user_id/.test(sql), "trigger loja-do-dono ausente");
  });
  t("H/S. writer Shopee sem loja_id → FALHA (API manual nao cria nem converte para Shopee; todo insert Shopee grava loja_id; banco exige loja)", async () => {
    const n = db.anuncios.length;
    const r1 = await rotaAnuncios.POST(post("/api/anuncios", { nome: "x", marketplace: "Shopee", custo_produto: 1, ml_item_id: "7001" }));
    assert(r1.status === 400 && db.anuncios.length === n, `POST Shopee manual ${r1.status}`);
    const ml = await rotaAnuncios.POST(post("/api/anuncios", { nome: "ml", marketplace: "ML", custo_produto: 1, ml_item_id: "MLB1" }));
    assert(ml.status === 201, `POST ML ${ml.status} (fluxo ML nao pode quebrar)`);
    const linhaMl = db.anuncios.find((a) => a.marketplace === "ML")!; const antesMl = JSON.stringify(linhaMl);
    const r2 = await patch(String(linhaMl.id), { marketplace: "Shopee", ml_item_id: "7001" });
    assert(r2.status === 400 && JSON.stringify(db.anuncios.find((a) => a.id === linhaMl.id)) === antesMl, `ML virou Shopee pela edicao (${r2.status})`);
    assert(regraBanco({ user_id: DONO_X, loja_id: null, marketplace: "Shopee", ml_item_id: "1" }) === "23514 shopee_exige_loja", "regra shopee-exige-loja");
    assert(/check \(marketplace <> 'Shopee' or loja_id is not null\)/.test(fonte("supabase/migrations/20261104_anuncios_loja_fase2.sql")), "CHECK ausente");
    // todo insert em anuncios com marketplace "Shopee" no codigo grava loja_id
    const arquivos = execFileSync("git", ["grep", "-l", "from(\"anuncios\")", "--", "app", "lib"], { cwd: RAIZ, encoding: "utf8" }).trim().split(/\r?\n/);
    const semLoja: string[] = [];
    for (const f of arquivos) {
      const s = fonte(f);
      for (const m of s.matchAll(/\.from\("anuncios"\)\.insert\(\{([\s\S]*?)\}\)/g)) if (/marketplace: "Shopee"/.test(m[1]) && !/loja_id:/.test(m[1])) semLoja.push(f);
    }
    assert(semLoja.length === 0, `insert Shopee sem loja_id: ${semLoja.join(", ")}`);
    // IMPORT V2: o motor insere em lote — toda linha nova nasce Shopee, da loja e ativa
    const linhaNova = /novas\.push\(\{([\s\S]*?)\}\);/.exec(fonte("lib/anuncios/importacao-shopee.ts"))?.[1] ?? "";
    assert(/marketplace: "Shopee"/.test(linhaNova) && /loja_id: lojaId/.test(linhaNova) && /user_id: userId/.test(linhaNova) && /ativo: true/.test(linhaNova), "linha nova do lote sem marketplace/loja/dono/ativo");
  });
  t("I. query Shopee de anuncios sem loja_id → FALHA (todo SELECT Shopee filtra loja; mapa sem loja lanca)", async () => {
    const arquivos = execFileSync("git", ["grep", "-l", "from(\"anuncios\")", "--", "app", "lib"], { cwd: RAIZ, encoding: "utf8" }).trim().split(/\r?\n/);
    const fora: string[] = [];
    for (const f of arquivos) {
      const s = fonte(f);
      for (const m of s.matchAll(/\.from\("anuncios"\)([^;]*);/g)) {
        const cadeia = m[1];
        if (!/\.eq\("marketplace", "Shopee"\)/.test(cadeia) || /\.(insert|update)\(/.test(cadeia)) continue;
        if (!/\.eq\("loja_id", /.test(cadeia) && !/\.is\("loja_id", null\)/.test(cadeia)) fora.push(f);
      }
    }
    assert(fora.length === 0, `SELECT Shopee sem loja: ${fora.join(", ")}`);
    // UPDATE do importador (IMPORT V2: motor em lib/anuncios/importacao-shopee.ts): WHERE prende
    // id + dono + loja; payload so com campos da Shopee — nunca loja_id/ativo/campos do usuario
    const imp = fonte("lib/anuncios/importacao-shopee.ts");
    const updates = [...imp.matchAll(/\.from\("anuncios"\)\.update\(([^)]*)\)([^;]*);/g)];
    assert(updates.length === 1 && updates[0][1] === "m.upd" && updates[0][2] === `.eq("id", m.id).eq("user_id", userId).eq("loja_id", lojaId)`, updates.map((u) => u[0]).join(" | "));
    const chavesUpd = [...imp.matchAll(/\bupd\.(\w+) =/g)].map((m) => m[1]);
    assert(chavesUpd.length > 0 && chavesUpd.every((c) => ["nome", "preco_anuncio", "thumbnail", "sku"].includes(c)), `update toca campo fora da Shopee: ${chavesUpd}`);
    assert(!/\.(insert|update|upsert)\(/.test(fonte("app/api/shopee/importar-anuncios/route.ts")), "rota voltou a escrever em anuncios fora do motor");
    let lancou = false;
    try { await SS.carregarMapaAnuncios(DONO_X, ""); } catch { lancou = true; }
    assert(lancou, "carregarMapaAnuncios sem loja nao falhou");
  });
  t("J. sem loja_id com 2 lojas → 409 (nunca a mais recente); anuncio Shopee sem loja pendente → 409 ANUNCIOS_SEM_LOJA; nenhuma chamada", async () => {
    chamadas = [];
    const r = await importarLoja(); const d = await r.json();
    assert(r.status === 409 && d.codigo === "STORE_SELECTION_REQUIRED" && chamadas.length === 0, `${r.status} ${d.codigo}`);
    db.anuncios.push({ id: "legado-sem-loja", user_id: DONO_X, marketplace: "Shopee", loja_id: null, ml_item_id: "7001", variation_id: null, ativo: true });
    const n = db.anuncios.length;
    const r2 = await importarLoja(LOJA_B); const d2 = await r2.json();
    assert(r2.status === 409 && d2.codigo === "ANUNCIOS_SEM_LOJA" && chamadas.length === 0 && db.anuncios.length === n, `${r2.status} ${d2.codigo}`);
    db.anuncios = db.anuncios.filter((a) => a.id !== "legado-sem-loja");
    let usos = "";
    try { usos = execFileSync("git", ["grep", "-n", "getShopeeLojaAtiva(", "--", "app", "lib"], { cwd: RAIZ, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch (e: any) { if (e.status !== 1) throw e; }
    assert(usos.split(/\r?\n/).filter((l) => l && !/export async function getShopeeLojaAtiva/.test(l)).length === 0, usos);
  });

  console.log("\n[K-L. identidade]");
  t("K/V. identidade duplicada na MESMA loja → UNIQUE impede (importacao concorrente: fatia para fail-closed, nunca 2a linha)", async () => {
    const existente = db.anuncios.find((a) => a.loja_id === LOJA_A && a.ml_item_id === "7001")!;
    assert(regraBanco({ user_id: DONO_X, loja_id: LOJA_A, marketplace: "Shopee", ml_item_id: "7001", variation_id: null }) === "23505 identidade", "duplicata aceita");
    // corrida: outra importacao gravou 8001/81 na B DEPOIS que esta leu os existentes → esta tenta inserir de novo
    const antes = db.anuncios.filter((a) => a.loja_id === LOJA_B).length;
    const linhaB = db.anuncios.find((a) => a.loja_id === LOJA_B && a.ml_item_id === "8001")!;
    db.anuncios = db.anuncios.filter((a) => a !== linhaB);
    const original = (db as any).anuncios;
    let injetou = false;
    const fetchOriginal = globalThis.fetch;
    globalThis.fetch = (async (url: any, init?: any) => {
      if (!injetou && String(url).includes("get_model_list") && String(url).includes("item_id=8001")) { injetou = true; original.push({ ...linhaB, id: "concorrente" }); }
      return fetchOriginal(url, init);
    }) as any;
    try {
      // IMPORT V2: INSERT em lote recusado pela UNIQUE → a fatia para (502), sem segunda linha
      const rr = await importarLoja(LOJA_B); const d = await rr.json();
      assert(rr.status === 502 && d.codigo === "FALHA_BANCO" && db.anuncios.filter((a) => a.loja_id === LOJA_B).length === antes, `${rr.status} ${JSON.stringify(d)}`);
    } finally { globalThis.fetch = fetchOriginal; }
    assert(existente.loja_id === LOJA_A, "existente mudou de loja");
    const sql = fonte("supabase/migrations/20261104_anuncios_loja_fase2.sql").replace(/\s+/g, " ");
    assert(sql.includes("on public.anuncios (user_id, loja_id, marketplace, ml_item_id, coalesce(variation_id, '')) where marketplace = 'Shopee' and ml_item_id is not null"), "UNIQUE nao e dono+loja+marketplace+item+model");
  });
  t("L/U. mesmo item/model em lojas DIFERENTES → permitido", () => {
    assert(regraBanco({ user_id: DONO_X, loja_id: LOJA_B, marketplace: "Shopee", ml_item_id: "7002", variation_id: "71" }) === null, "item da A recusado na B");
    assert(db.anuncios.filter((a) => a.ml_item_id === "7001").length === 2, "7001 nao existe nas duas lojas");
  });

  console.log("\n[M-P. edicao manual: identidade Shopee vem do banco]");
  t("M. PATCH de anuncio Shopee com marketplace=\"ML\" (o que o formulario mandava) → continua Shopee, identidade intacta", async () => {
    const a = db.anuncios.find((x) => x.loja_id === LOJA_A && x.ml_item_id === "7001")!; const id0 = identidade(a);
    const r = await patch(String(a.id), { marketplace: "ML", nome: "renomeado" });
    const depois = db.anuncios.find((x) => x.id === a.id)!;
    assert(r.status === 200 && depois.marketplace === "Shopee" && identidade(depois) === id0 && depois.nome === "renomeado", `${r.status} ${identidade(depois)}`);
    // o formulario de edicao nao manda mais identidade, nem re-busca no ML um anuncio Shopee
    const form = fonte("app/(app)/anuncios/FormAnuncio.tsx");
    assert(/if \(inicial\) \{\n\s*delete \(payload as any\)\.marketplace;\n\s*delete \(payload as any\)\.ml_item_id;\n\s*delete \(payload as any\)\.variation_id;\n\s*\}\n\n\s*await gravarAnuncio\(payload, inicial\?\.id\);/.test(form), "formulario ainda manda identidade no PATCH");
    assert(/if \(!modoEdicao \|\| !inicial\?\.ml_item_id \|\| inicial\.marketplace === "Shopee"\) return;/.test(form), "formulario re-busca anuncio Shopee no ML");
  });
  t("N. PATCH de anuncio Shopee tentando mudar loja_id → 400, nada muda", async () => {
    const a = db.anuncios.find((x) => x.loja_id === LOJA_A && x.ml_item_id === "7001")!; const antes = JSON.stringify(a);
    const r = await patch(String(a.id), { loja_id: LOJA_B, custo_produto: 99 });
    assert(r.status === 400 && JSON.stringify(db.anuncios.find((x) => x.id === a.id)) === antes, `${r.status}`);
  });
  t("O. PATCH de anuncio Shopee altera custo/imposto/insumos → mudam; item/variacao/marketplace/loja enviados sao ignorados", async () => {
    const a = db.anuncios.find((x) => x.loja_id === LOJA_A && x.ml_item_id === "7002" && x.variation_id === "71")!; const id0 = identidade(a);
    const r = await patch(String(a.id), { custo_produto: 7.5, imposto: 6, insumos: 1.25, marketplace: "ML", ml_item_id: "MLB999", variation_id: null });
    const d = db.anuncios.find((x) => x.id === a.id)!;
    assert(r.status === 200 && d.custo_produto === 7.5 && d.imposto === 6 && d.insumos === 1.25 && identidade(d) === id0, `${r.status} ${identidade(d)}`);
    const outro = await patch("nao-existe", { custo_produto: 1 });
    assert(outro.status === 404, "anuncio inexistente/alheio");
  });
  t("P. POST manual de anuncio Shopee (sem importacao) → 400, nada criado", async () => {
    const n = db.anuncios.length;
    const r = await rotaAnuncios.POST(post("/api/anuncios", { nome: "manual", marketplace: "Shopee", custo_produto: 3 }));
    assert(r.status === 400 && db.anuncios.length === n, `${r.status}`);
  });

  console.log("\n[Q-R. preco Shopee em reais]");
  t("Q. preco conhecido (API v2 = 31.91 / modelo 12.5) → banco grava 31.91 / 12.5 (nunca 0.0003191)", async () => {
    const it = db.anuncios.find((x) => x.loja_id === LOJA_A && x.ml_item_id === "7001")!;
    const md = db.anuncios.find((x) => x.loja_id === LOJA_A && x.ml_item_id === "7002" && x.variation_id === "71")!;
    assert(it.preco_anuncio === 31.91 && md.preco_anuncio === 12.5, `${it.preco_anuncio} / ${md.preco_anuncio}`);
  });
  t("R. conversao /100000 (convencao da API v1) ausente do importador", () => {
    for (const arq of ["app/api/shopee/importar-anuncios/route.ts", "lib/anuncios/importacao-shopee.ts"]) {
      assert(!/\/\s*1e5|\/\s*100_?000|\*\s*0?\.00001/.test(fonte(arq).replace(/\/\/.*$/gm, "")), `conversao /100000 reintroduzida em ${arq}`);
    }
    const imp = fonte("lib/anuncios/importacao-shopee.ts").replace(/\/\/.*$/gm, "");
    assert((imp.match(/Number\((item|m)\.price_info\?\.\[0\]\?\.current_price/g) ?? []).length === 2, "preco nao lido direto de current_price");
  });

  console.log("\n[X. migrations]");
  t("X. fase 1 aditiva + backfill fail-closed generico; fase 2 aborta com pendencias; nada fixo, nada destrutivo", () => {
    const f1 = fonte("supabase/migrations/20261103_anuncios_loja_fase1.sql"), f2 = fonte("supabase/migrations/20261104_anuncios_loja_fase2.sql");
    assert(/add column if not exists loja_id uuid;/.test(f1) && /references public\.lojas\(id\) on delete restrict/.test(f1), "coluna/FK");
    assert(/create index if not exists idx_anuncios_user_loja_marketplace on public\.anuncios \(user_id, loja_id, marketplace\)/.test(f1), "indice");
    assert(!/not null/i.test(f1.replace(/is not null|loja_id is not null|ml_item_id is not null/gi, "")), "fase 1 impos NOT NULL");
    assert(/and c\.n = 1/.test(f1) && /l\.created_at <= a\.created_at/.test(f1) && /donos_com_loja_sumida/.test(f1) && /vendas_de_outras_lojas/.test(f1), "regra fail-closed");
    const codigoSql = (s: string) => s.replace(/--.*$/gm, "");
    assert(!/419809235|481902588/.test(codigoSql(f1) + codigoSql(f2)), "loja fixa no SQL");
    assert(!/order by[^;]*desc/i.test(codigoSql(f1)) && !/ativo\s*=\s*true/i.test(codigoSql(f1)), "backfill escolhe por recencia/ativa");
    assert(!/\bdelete\s+from\b|\btruncate\b|\bdrop table\b|\bdrop column\b/i.test(codigoSql(f1) + codigoSql(f2)), "SQL destrutivo");
    assert(/raise exception 'ANUNCIOS FASE 2: existem anuncios Shopee sem loja_id/.test(f2) && /raise exception 'ANUNCIOS FASE 2: identidade Shopee duplicada/.test(f2), "fase 2 sem pre-condicao");
  });

  await fila;
  console.log(`\n${falhou === 0 ? "✓" : "✗"} ANUNCIOS-SHOPEE-MULTI-STORE — ${passou} passaram, ${falhou} falharam`);
  process.exit(falhou === 0 ? 0 : 1);
}
principal().catch((e) => { console.error("ERRO FATAL", e?.message ?? e); process.exit(1); });
