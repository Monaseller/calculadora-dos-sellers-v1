/**
 * Suite IMPORTACAO SHOPEE V2 — importacao de anuncios em FATIAS retomaveis.
 *
 * Executa o REAL (POST /api/shopee/importar-anuncios + motor
 * lib/anuncios/importacao-shopee.ts + laco da tela importarShopeeEmFatias):
 *   - sessao real (emitirTokenSessao);
 *   - Supabase em memoria com as regras do banco (trigger loja-do-dono,
 *     UNIQUE dono+loja+marketplace+item+model, CHECK Shopee exige loja);
 *   - Shopee FALSA de catalogo (get_item_list / get_item_base_info /
 *     get_model_list) que registra cada chamada; pedido/escrow = PROIBIDO;
 *   - RELOGIO VIRTUAL: cada chamada a Shopee custa CUSTO_MS no Date.now — o
 *     orcamento da fatia (35s) e exercitado sem esperar de verdade.
 *
 * Offline: sem rede, sem banco real, sem OAuth.
 *
 *   npx tsx scripts/testar-shopee-importacao-retomavel.ts
 */
import "./_server-only-inerte";
import Module from "node:module";
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

// ── Relogio virtual ──────────────────────────────────────────────────
const agoraReal = Date.now.bind(Date);
let virtualMs = 0;
Date.now = () => agoraReal() + virtualMs;
let CUSTO_MS = 0;

const DONO_X = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", DONO_Y = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LOJA_A = "11111111-1111-4111-8111-111111111111", LOJA_B = "22222222-2222-4222-8222-222222222222", LOJA_C = "33333333-3333-4333-8333-333333333333";
const SHOP: Record<string, string> = { [LOJA_A]: "419809235", [LOJA_B]: "481902588", [LOJA_C]: "555000111" };
const FUTURO = new Date(Date.now() + 6 * 3600e3).toISOString();
const loja = (id: string, dono: string, partner: string, criada: string) => ({
  id, user_id: dono, marketplace: "Shopee", seller_id: SHOP[id], shop_id: SHOP[id], partner_id: partner, partner_key: `chave-ficticia-${partner}`,
  access_token: `<access-${SHOP[id]}>`, refresh_token: `<refresh-${SHOP[id]}>`, token_expires_at: FUTURO, ativo: true, nome: `Shopee ${SHOP[id]}`,
  nickname: `Shopee ${SHOP[id]}`, created_at: criada, shopee_sincronizado_ate: null,
});

// ── Catalogo falso por shop: item → modelos ([] = sem variacao); preco em REAIS ──
type Catalogo = Record<string, { modelos: string[]; preco: number; nome?: string }>;
let CATALOGO: Record<string, Catalogo> = {};
const PRECO_ITEM = 31.91, PRECO_MODELO = 12.5;
function catalogoGrande(base: number, n: number, comModelos: Record<number, number>): Catalogo {
  const c: Catalogo = {};
  // ordem "embaralhada" de proposito: a Shopee nao garante ordem; o motor ordena
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => ((a * 7919) % n) - ((b * 7919) % n));
  for (const i of idx) {
    const id = String(base + i);
    const k = comModelos[i] ?? 0;
    c[id] = { modelos: Array.from({ length: k }, (_, j) => String((base + i) * 100 + j)), preco: PRECO_ITEM };
  }
  return c;
}

// ── Supabase em memoria + regras do banco ────────────────────────────
type Linha = Record<string, any>;
let db: Record<string, Linha[]> = {};
let seq = 0;
let ops: { op: string; tabela: string; payload: any; filtros: any[] }[] = [];
function cenario() {
  db = {
    lojas: [loja(LOJA_A, DONO_X, "2038003", "2026-07-01T00:00:00Z"), loja(LOJA_B, DONO_X, "2047853", "2026-10-08T18:40:00Z"), loja(LOJA_C, DONO_Y, "2038003", "2026-08-01T00:00:00Z")],
    anuncios: [], pedidos: [],
  };
  ops = []; chamadas = []; virtualMs = 0; CUSTO_MS = 0; falharModeloDoItem = null; emVoo = 0; maxEmVoo = 0;
}
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
      const st: any = { op: "select", payload: null, filtros: [] as any[], ini: 0, fim: Infinity, unico: false, ordens: [] as any[] };
      const casa = (r: Linha) => st.filtros.every(([k, c, v]: any) =>
        k === "eq" ? String(r[c]) === String(v) : k === "in" ? (v as any[]).map(String).includes(String(r[c])) : k === "is" ? (r[c] ?? null) === v
          : k === "gte" ? String(r[c] ?? "") >= String(v) : k === "lte" ? String(r[c] ?? "") <= String(v) : k === "lt" ? String(r[c] ?? "") < String(v) : true);
      const exec = () => {
        const ls = (db[tabela] ??= []);
        if (st.op !== "select") ops.push({ op: st.op, tabela, payload: st.payload, filtros: [...st.filtros] });
        if (st.op === "update") {
          const alvo = ls.filter(casa);
          for (const r of alvo) { const err = tabela === "anuncios" ? regraBanco({ ...r, ...st.payload }, r.id) : null; if (err) return { data: null, error: { code: err.slice(0, 5), message: err } }; }
          for (const r of alvo) Object.assign(r, st.payload);
          return { data: alvo.map((r) => ({ ...r })), error: null };
        }
        if (st.op === "insert" || st.op === "upsert") {
          const novos = (Array.isArray(st.payload) ? st.payload : [st.payload]).map((n: Linha) => ({ id: `anuncio-${++seq}`, ...n }));
          // atomico como um INSERT de varias linhas: uma recusa → nenhuma entra
          const tmp = [...ls];
          for (const n of novos) {
            const err = tabela === "anuncios" ? (() => { const salvo = db.anuncios; db.anuncios = tmp; try { return regraBanco(n); } finally { db.anuncios = salvo; } })() : null;
            if (err) return { data: null, error: { code: err.slice(0, 5), message: err } };
            tmp.push(n);
          }
          for (const n of novos) ls.push({ ...n });
          return st.unico ? { data: novos[0], error: null } : { data: novos, error: null };
        }
        let out = ls.filter(casa).map((r) => ({ ...r }));
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
let chamadas: { path: string; shopId: string; partnerId: string; params: Record<string, string> }[] = [];
let falharModeloDoItem: string | null = null;
let emVoo = 0, maxEmVoo = 0;
const PROIBIDO = /\/order\/|\/payment\/|escrow|get_order/;
globalThis.fetch = (async (url: any) => {
  const u = new URL(String(url));
  if (u.hostname !== "shopee.teste.invalid") throw new Error(`teste tentou acessar a rede: ${u.hostname}`);
  const shopId = u.searchParams.get("shop_id") ?? "";
  chamadas.push({ path: u.pathname, shopId, partnerId: u.searchParams.get("partner_id") ?? "", params: Object.fromEntries(u.searchParams) });
  virtualMs += CUSTO_MS;
  const cat = CATALOGO[shopId] ?? {};
  let corpo: any = { response: {} };
  if (u.pathname.endsWith("/product/get_item_list")) {
    const ids = Object.keys(cat); const off = Number(u.searchParams.get("offset") ?? 0); const tam = Number(u.searchParams.get("page_size") ?? 100);
    corpo = { response: { item: ids.slice(off, off + tam).map((id) => ({ item_id: Number(id) })), has_next_page: off + tam < ids.length, next_offset: off + tam } };
  } else if (u.pathname.endsWith("/product/get_item_base_info")) {
    const ids = String(u.searchParams.get("item_id_list") ?? "").split(",").filter(Boolean);
    corpo = { response: { item_list: ids.filter((id) => id in cat).map((id) => ({ item_id: Number(id), item_name: cat[id].nome ?? `Item ${id}`, has_model: cat[id].modelos.length > 0, price_info: [{ current_price: cat[id].preco }], sku: `SKU-${id}` })) } };
  } else if (u.pathname.endsWith("/product/get_model_list")) {
    const id = String(u.searchParams.get("item_id"));
    emVoo++; maxEmVoo = Math.max(maxEmVoo, emVoo);
    await new Promise((r) => setTimeout(r, 2));
    emVoo--;
    corpo = falharModeloDoItem === id ? { error: "error_server", message: "falha simulada" }
      : { response: { model: (cat[id]?.modelos ?? []).map((m) => ({ model_id: Number(m), model_name: `M${m}`, price_info: [{ current_price: PRECO_MODELO }], model_sku: `SKU-${m}` })) } };
  }
  return { ok: true, status: 200, json: async () => corpo, text: async () => JSON.stringify(corpo) } as any;
}) as any;

async function principal() {
  const auth = await import("../lib/autenticacao");
  const importar = await import("../app/api/shopee/importar-anuncios/route");
  const MOT = await import("../lib/anuncios/importacao-shopee");
  const UI = await import("../app/(app)/anuncios/importacao-shopee");
  const sessaoX = (await auth.emitirTokenSessao(DONO_X)).token;
  const H = "https://www.calculadoradossellers.com.br";
  const postarCorpo = async (corpo: Record<string, unknown>) => {
    const r = await importar.POST(new Request(`${H}/api/shopee/importar-anuncios`, {
      method: "POST", headers: { "content-type": "application/json", cookie: `cds_session=${sessaoX}` }, body: JSON.stringify(corpo) }));
    return { status: r.status, texto: await r.text() };
  };
  const fatia = async (corpo: Record<string, unknown>) => { const r = await postarCorpo(corpo); return { status: r.status, d: JSON.parse(r.texto) }; };
  const daLoja = (id: string) => db.anuncios.filter((a) => a.loja_id === id);
  const linhasEsperadas = (cat: Catalogo) => Object.values(cat).reduce((s, v) => s + Math.max(1, v.modelos.length), 0);
  const fp = (id: string) => JSON.stringify(daLoja(id).map((a) => ({ ...a })).sort((p, q) => String(p.id).localeCompare(String(q.id))));
  const itemDoCursor = (c: string) => JSON.parse(Buffer.from(c, "base64url").toString("utf8")).i as string;
  const completo = (cat: Catalogo, lojaId: string, item: string) =>
    daLoja(lojaId).filter((a) => a.ml_item_id === item).length === Math.max(1, cat[item].modelos.length);
  const ordenados = (cat: Catalogo) => Object.keys(cat).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));

  console.log("\n[A-E. fatias, cursor, atomicidade, orcamento]");
  t("A. catalogo cabe em 1 fatia → parcial=false, cursor=null, tudo gravado", async () => {
    cenario();
    CATALOGO = { [SHOP[LOJA_B]]: catalogoGrande(9000, 5, { 1: 3 }) };
    const { status, d } = await fatia({ loja_id: LOJA_B });
    assert(status === 200 && d.parcial === false && d.cursor === null && d.loja_id === LOJA_B, JSON.stringify(d));
    assert(daLoja(LOJA_B).length === linhasEsperadas(CATALOGO[SHOP[LOJA_B]]) && d.importados === daLoja(LOJA_B).length && d.total === 5, JSON.stringify(d));
    assert(chamadas.every((c) => !PROIBIDO.test(c.path)), "chamou pedido/escrow");
  });

  const CAT_B = () => catalogoGrande(5000, 120, { ...Object.fromEntries(Array.from({ length: 40 }, (_, k) => [k * 3, 2])), 4: 20 });
  let respostas: any[] = [];
  t("B/C/D. catalogo de 3+ fatias → cursor progride; nenhum item gravado 2x; item de 20 models inteiro antes do cursor", async () => {
    cenario(); CUSTO_MS = 2000;
    CATALOGO = { [SHOP[LOJA_B]]: CAT_B() };
    const cat = CATALOGO[SHOP[LOJA_B]];
    respostas = [];
    let corpo: Record<string, unknown> = { loja_id: LOJA_B };
    for (let n = 0; n < 50; n++) {
      virtualMs = 0;                         // cada request comeca com o relogio "zerado" (inicioMs da rota)
      const { status, d } = await fatia(corpo);
      assert(status === 200, `fatia ${n}: ${status} ${JSON.stringify(d)}`);
      respostas.push(d);
      if (!d.parcial) break;
      // D: no fim de CADA fatia, todo item ≤ cursor esta completo (models inclusive)
      const c = itemDoCursor(d.cursor);
      for (const id of ordenados(cat).filter((x) => BigInt(x) <= BigInt(c))) assert(completo(cat, LOJA_B, id), `item ${id} incompleto com cursor em ${c}`);
      corpo = { loja_id: d.loja_id, cursor: d.cursor };
    }
    assert(respostas.length >= 3 && respostas[respostas.length - 1].parcial === false, `fatias=${respostas.length}`);
    const cursores = respostas.filter((d) => d.parcial).map((d) => BigInt(itemDoCursor(d.cursor)));
    assert(cursores.every((c, i) => i === 0 || c > cursores[i - 1]), "cursor nao avancou");
    // C: cada linha exatamente uma vez; insercoes somadas = linhas; nenhuma atualizacao numa importacao do zero
    assert(daLoja(LOJA_B).length === linhasEsperadas(cat), `${daLoja(LOJA_B).length} != ${linhasEsperadas(cat)}`);
    assert(respostas.reduce((s, d) => s + d.importados, 0) === linhasEsperadas(cat) && respostas.every((d) => d.atualizados === 0), "item gravado 2x");
    assert(respostas.reduce((s, d) => s + d.itens_processados, 0) === 120, "item repetido ou perdido entre fatias");
    const item20 = ordenados(cat).find((id) => cat[id].modelos.length === 20)!;
    assert(completo(cat, LOJA_B, item20), "item de 20 models incompleto");
  });
  t("E. orcamento quase no fim → nao comeca item novo (fatia sem itens, cursor nao avanca, nenhum get_model_list)", async () => {
    cenario(); CUSTO_MS = 20_000;            // listagem 20s + base_info 40s > 35s
    CATALOGO = { [SHOP[LOJA_B]]: catalogoGrande(7000, 10, { 0: 5 }) };
    const { status, d } = await fatia({ loja_id: LOJA_B });
    assert(status === 200 && d.parcial === true && d.itens_processados === 0 && daLoja(LOJA_B).length === 0, JSON.stringify(d));
    assert(!chamadas.some((c) => c.path.endsWith("get_model_list")), "comecou item depois do orcamento");
    assert(MOT.ORCAMENTO_FATIA_MS >= 30_000 && MOT.ORCAMENTO_FATIA_MS <= 40_000, `orcamento ${MOT.ORCAMENTO_FATIA_MS}`);
  });

  console.log("\n[F-I. retomada e idempotencia]");
  t("F. retomada sobre linhas antigas (inclusive item com models faltando) → completa, sem duplicar", async () => {
    cenario();
    CATALOGO = { [SHOP[LOJA_B]]: catalogoGrande(6000, 30, { 2: 6, 5: 3 }) };
    const cat = CATALOGO[SHOP[LOJA_B]];
    const ids = ordenados(cat);
    // execucao antiga (sem cursor) gravou os 10 primeiros itens — e o item com 6 models so pela metade
    for (const id of ids.slice(0, 10)) {
      const mods = cat[id].modelos.length ? cat[id].modelos.slice(0, cat[id].modelos.length === 6 ? 3 : undefined) : [null];
      for (const m of mods) db.anuncios.push({ id: `antigo-${id}-${m}`, user_id: DONO_X, loja_id: LOJA_B, marketplace: "Shopee", ml_item_id: id, variation_id: m,
        nome: m ? `Item ${id} - M${m}` : `Item ${id}`, preco_anuncio: m ? PRECO_MODELO : PRECO_ITEM, sku: m ? `SKU-${m}` : `SKU-${id}`, thumbnail: null, ativo: true, custo_produto: 0 });
    }
    const r = await UI.importarShopeeEmFatias(postarCorpo, LOJA_B);
    assert(r.tipo === "ok", JSON.stringify(r));
    assert(daLoja(LOJA_B).length === linhasEsperadas(cat), `${daLoja(LOJA_B).length} != ${linhasEsperadas(cat)}`);
    for (const id of ids) assert(completo(cat, LOJA_B, id), `item ${id} incompleto`);
    assert(r.progresso.ignorados > 0 && r.progresso.atualizados === 0, JSON.stringify(r.progresso));
  });
  t("G. linha igual a da Shopee → NENHUM update", async () => {
    ops = [];
    const r = await UI.importarShopeeEmFatias(postarCorpo, LOJA_B);
    assert(r.tipo === "ok" && r.progresso.importados === 0 && r.progresso.atualizados === 0, JSON.stringify(r));
    assert(!ops.some((o) => o.op === "update"), `updates: ${ops.filter((o) => o.op === "update").length}`);
    assert(r.progresso.ignorados === daLoja(LOJA_B).length, JSON.stringify(r.progresso));
  });
  t("H/I. preco novo na Shopee → UPDATE so de campos da Shopee; custo/imposto/insumos/ativo do usuario preservados", async () => {
    const cat = CATALOGO[SHOP[LOJA_B]]; const alvo = ordenados(cat).find((id) => cat[id].modelos.length === 0)!;
    cat[alvo].preco = 44.9;
    const linha = daLoja(LOJA_B).find((a) => a.ml_item_id === alvo)!;
    Object.assign(linha, { custo_produto: 9.99, imposto: 6, insumos: 1.5, ativo: false });
    ops = [];
    const r = await UI.importarShopeeEmFatias(postarCorpo, LOJA_B);
    const ups = ops.filter((o) => o.op === "update");
    assert(r.tipo === "ok" && r.progresso.atualizados === 1 && ups.length === 1, JSON.stringify(r));
    assert(JSON.stringify(Object.keys(ups[0].payload)) === JSON.stringify(["preco_anuncio"]), `payload: ${JSON.stringify(ups[0].payload)}`);
    const d = daLoja(LOJA_B).find((a) => a.ml_item_id === alvo)!;
    assert(d.preco_anuncio === 44.9 && d.custo_produto === 9.99 && d.imposto === 6 && d.insumos === 1.5 && d.ativo === false, JSON.stringify(d));
    assert(ups[0].filtros.some(([k, c, v]: any) => k === "eq" && c === "loja_id" && v === LOJA_B) && ups[0].filtros.some(([k, c, v]: any) => k === "eq" && c === "user_id" && v === DONO_X), "update sem prender loja/dono");
  });

  console.log("\n[J-L. isolamento e falha]");
  t("J/K. importar R.D. (B) → 0 alteracoes na Monamor (A); mesmo item/model nas duas lojas = linhas independentes", async () => {
    cenario();
    CATALOGO = { [SHOP[LOJA_A]]: catalogoGrande(4000, 8, { 1: 2 }), [SHOP[LOJA_B]]: catalogoGrande(4000, 8, { 1: 2 }) };   // MESMOS item/model
    assert((await UI.importarShopeeEmFatias(postarCorpo, LOJA_A)).tipo === "ok", "import A");
    const antesA = fp(LOJA_A);
    ops = [];
    assert((await UI.importarShopeeEmFatias(postarCorpo, LOJA_B)).tipo === "ok", "import B");
    assert(fp(LOJA_A) === antesA, "import B alterou A");
    assert(ops.every((o) => o.op !== "update" || o.filtros.some(([k, c, v]: any) => c === "loja_id" && v === LOJA_B)), "escrita fora da loja B");
    assert(daLoja(LOJA_A).length === daLoja(LOJA_B).length && daLoja(LOJA_B).every((b) => !daLoja(LOJA_A).some((a) => a.id === b.id)), "linhas compartilhadas entre lojas");
    assert(chamadas.filter((c) => c.shopId === SHOP[LOJA_B]).every((c) => c.partnerId === "2047853"), "B chamada com app de outra loja");
  });
  t("L. erro da Shopee no meio → 502, progresso anterior mantido; nova importacao completa sem duplicar", async () => {
    cenario();
    CATALOGO = { [SHOP[LOJA_B]]: catalogoGrande(3000, 20, { 4: 2, 12: 3 }) };
    const cat = CATALOGO[SHOP[LOJA_B]]; const ids = ordenados(cat);
    falharModeloDoItem = ids[12];
    const r = await UI.importarShopeeEmFatias(postarCorpo, LOJA_B);
    assert(r.tipo === "erro", JSON.stringify(r));
    const gravadas = daLoja(LOJA_B).length;
    assert(gravadas > 0 && !daLoja(LOJA_B).some((a) => a.ml_item_id === ids[12]), `gravadas=${gravadas}`);
    for (const id of ids.slice(0, 12)) assert(completo(cat, LOJA_B, id), `item anterior ${id} nao preservado`);
    // o erro devolve o cursor do ULTIMO item completo e gravado — nunca do item que falhou
    const e = await fatia({ loja_id: LOJA_B });
    assert(e.status === 502 && e.d.codigo === "FALHA_SHOPEE" && typeof e.d.cursor === "string" && itemDoCursor(e.d.cursor) === ids[11], `${e.status} ${JSON.stringify(e.d)}`);
    falharModeloDoItem = null;
    const r2 = await UI.importarShopeeEmFatias(postarCorpo, LOJA_B);
    assert(r2.tipo === "ok" && daLoja(LOJA_B).length === linhasEsperadas(cat), JSON.stringify(r2));
  });

  console.log("\n[M-P. tela, cursor, preco]");
  t("M. a tela recebe parcial=true e chama a proxima fatia com EXATAMENTE o cursor/loja devolvidos", async () => {
    cenario(); CUSTO_MS = 2000;
    CATALOGO = { [SHOP[LOJA_B]]: CAT_B() };
    const corpos: Record<string, unknown>[] = [], resps: any[] = [];
    const progresso: number[] = [];
    const r = await UI.importarShopeeEmFatias(async (corpo) => {
      virtualMs = 0; corpos.push(corpo);
      const x = await postarCorpo(corpo); resps.push(JSON.parse(x.texto)); return x;
    }, LOJA_B, (p) => progresso.push(p.itensProcessados));
    assert(r.tipo === "ok" && corpos.length >= 3, `fatias=${corpos.length}`);
    for (let i = 1; i < corpos.length; i++) {
      assert(corpos[i].cursor === resps[i - 1].cursor && corpos[i].loja_id === resps[i - 1].loja_id, `fatia ${i}: cursor/loja divergente`);
    }
    assert(corpos[0].cursor === undefined && progresso.length === corpos.length - 1 && progresso.every((v, i) => i === 0 || v > progresso[i - 1]), `progresso ${progresso}`);
    // cursor que nao avanca → erro (nunca laco infinito)
    const travado = await UI.importarShopeeEmFatias(async () => ({ status: 200, texto: JSON.stringify({ parcial: true, cursor: "X", loja_id: LOJA_B, importados: 0, atualizados: 0, ignorados: 0, total: 1 }) }), LOJA_B);
    assert(travado.tipo === "erro", "cursor repetido nao interrompeu");
    // a pagina usa o laco
    const pg = fonte("app/(app)/anuncios/page.tsx");
    assert(/const r = await importarShopeeEmFatias\(async \(corpo\) => \{/.test(pg) && /body: JSON\.stringify\(corpo\)/.test(pg), "tela nao usa importarShopeeEmFatias");
  });
  t("N/O. cursor invalido → 400 CURSOR_INVALIDO; cursor de OUTRA loja → 400 CURSOR_DE_OUTRA_LOJA; nenhuma chamada a Shopee", async () => {
    cenario();
    CATALOGO = { [SHOP[LOJA_B]]: catalogoGrande(9000, 3, {}) };
    for (const cursor of ["lixo", "e30", 123, MOT.codificarCursor("nao-uuid", "1")]) {
      const { status, d } = await fatia({ loja_id: LOJA_B, cursor });
      assert(status === 400 && d.codigo === "CURSOR_INVALIDO", `${String(cursor)} → ${status} ${d.codigo}`);
    }
    const { status, d } = await fatia({ loja_id: LOJA_B, cursor: MOT.codificarCursor(LOJA_A, "9001") });
    assert(status === 400 && d.codigo === "CURSOR_DE_OUTRA_LOJA", `${status} ${d.codigo}`);
    assert(chamadas.length === 0 && db.anuncios.length === 0, `chamadas=${chamadas.length}`);
  });
  t("P. preco da Shopee 31.91 → banco 31.91 (item) e 12.5 (model) — nunca /100000", async () => {
    cenario();
    CATALOGO = { [SHOP[LOJA_B]]: catalogoGrande(8000, 2, { 1: 1 }) };
    await fatia({ loja_id: LOJA_B });
    const semModelo = daLoja(LOJA_B).find((a) => a.variation_id === null)!, comModelo = daLoja(LOJA_B).find((a) => a.variation_id !== null)!;
    assert(semModelo.preco_anuncio === 31.91 && comModelo.preco_anuncio === 12.5, `${semModelo.preco_anuncio} / ${comModelo.preco_anuncio}`);
  });
  t("Q. get_model_list com no maximo 3 em voo; get_item_base_info em lotes de ate 50; get_item_list de 100", async () => {
    cenario();
    CATALOGO = { [SHOP[LOJA_B]]: catalogoGrande(2000, 60, Object.fromEntries(Array.from({ length: 30 }, (_, i) => [i, 2]))) };
    await fatia({ loja_id: LOJA_B });
    assert(maxEmVoo >= 2 && maxEmVoo <= MOT.CONCORRENCIA_MODELOS && MOT.CONCORRENCIA_MODELOS === 3, `max em voo ${maxEmVoo}`);
    const bi = chamadas.filter((c) => c.path.endsWith("get_item_base_info")).map((c) => c.params.item_id_list.split(",").length);
    assert(bi.length === 2 && bi[0] === 50 && bi[1] === 10, `lotes base_info ${bi}`);
    assert(chamadas.filter((c) => c.path.endsWith("get_item_list")).every((c) => c.params.page_size === "100"), "page_size != 100");
  });

  await fila;
  console.log(`\n${falhou === 0 ? "✓" : "✗"} SHOPEE-IMPORTACAO-RETOMAVEL — ${passou} passaram, ${falhou} falharam`);
  process.exit(falhou === 0 ? 0 : 1);
}
principal().catch((e) => { console.error("ERRO FATAL", e?.message ?? e); process.exit(1); });
