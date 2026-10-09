/**
 * CDS V2 — Fase 2B0: escritas do catálogo ML presas à row EXATA (hotfix antes do schema por loja).
 *
 *   sync-skus:   o UPDATE alcança UMA row (id + dono + ML + item) — nunca as variações irmãs;
 *                SKU/preço vêm só do item (row sem variação) ou da variação de MESMO id;
 *                SKU já preenchido (manual) nunca é sobrescrito.
 *   sync-precos: o UPDATE só leva colunas FÍSICAS de `anuncios` (lucro/margem são derivados de
 *                tela) e erro do banco nunca vira "atualizado" (fail-closed, 503).
 *   A barreira MULTI_ML_CATALOG_NOT_READY continua antes de provider/escrita.
 *
 * Duplo do banco recusa coluna inexistente como o PostgREST real (PGRST204) e pode falhar
 * o UPDATE de uma row. Duplo do Mercado Livre por item. Sem rede, sem banco, sem credencial real.
 *
 * Uso: npx tsx scripts/testar-ml-catalogo-variacoes.ts
 */
import "./_server-only-inerte";
import Module from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { invariantesV2, leitoresMLSemMarketplace } from "./_guard-v2";
import { COLUNAS_ANUNCIO_TELA, DB_ANUNCIO_COLUMNS, DERIVED_UI_FIELDS } from "../lib/anuncios/colunas";

let ok = 0, falhou = 0;
let fila: Promise<void> = Promise.resolve();
const imprimir = console.log.bind(console);
function t(nome: string, fn: () => void | Promise<void>) {
  fila = fila.then(async () => {
    try { await fn(); ok++; imprimir(`  PASS  ${nome}`); }
    catch (e: any) { falhou++; imprimir(`  FALHA ${nome} -> ${e?.message ?? e}`); }
  });
}
function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder-de-teste.invalid";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "chave-de-teste-invalida";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "chave-de-teste-invalida";
process.env.ML_CLIENT_ID ??= "ficticio";
process.env.ML_CLIENT_SECRET ??= "ficticio";
process.env.SESSION_SECRET ??= "segredo-de-teste-com-mais-de-32-bytes-000000";

const UID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LOJA_A = "11111111-1111-4111-8111-111111111111";
const LOJA_B = "22222222-2222-4222-8222-222222222222";
const TOKEN_A = "<access-da-loja-ML-A>";
const PAGINA = 1000;
const FISICAS = new Set<string>(DB_ANUNCIO_COLUMNS);

let lojas: any[] = [];
let anuncios: any[] = [];
/** ids cujo UPDATE o banco recusa. */
let falharUpdate = new Set<string>();
let atualizacoes: Array<{ filtros: Record<string, unknown>; ids: string[]; patch: Record<string, unknown>; erro: string | null }> = [];
/** Itens do Mercado Livre (multiget e /items/{id}). */
let itensML: Record<string, any> = {};
let completosML: Record<string, any> = {};
let chamadasRede: string[] = [];

function loja(id: string) {
  return { id, user_id: UID, marketplace: "ML", ativo: true, nickname: id === LOJA_A ? "LojaA" : "LojaB", seller_id: id === LOJA_A ? "<seller-A>" : "<seller-B>",
    access_token: TOKEN_A, refresh_token: "<refresh>", token_expires_at: new Date(Date.now() + 3600_000).toISOString(), created_at: "2026-01-01" };
}
function reiniciar(linhas: any[], itens: Record<string, any> = {}, completos: Record<string, any> = {}) {
  lojas = [loja(LOJA_A)];
  anuncios = linhas.map((l) => ({ ...l }));
  itensML = itens; completosML = completos;
  falharUpdate = new Set(); atualizacoes = []; chamadasRede = [];
}
function an(id: string, ml_item_id: string, variation_id: string | null, sku: string | null, extra: Record<string, unknown> = {}) {
  return { id, user_id: UID, marketplace: "ML", ml_item_id, variation_id, sku, ativo: true, nome: `p-${id}`, loja_id: null,
    preco_anuncio: 10, thumbnail: `thumb-${id}`, ...extra };
}
const foto = () => JSON.parse(JSON.stringify(anuncios));
const linha = (id: string) => anuncios.find((l) => l.id === id);

// ── Duplo do banco (PostgREST) ───────────────────────────────────────
function clienteFalso() {
  const cadeia = (tabela: string) => {
    const preds: Array<(l: any) => boolean> = [];
    const filtrosEq: Record<string, unknown> = {};
    let tipo: "select" | "update" = "select";
    let patch: Record<string, unknown> = {};
    let ordem: string | null = null;
    let faixa: [number, number] | null = null;
    const linhas = () => (tabela === "lojas" ? lojas : anuncios);
    const executar = () => {
      let alvo = linhas().filter((l) => preds.every((p) => p(l)));
      if (tipo === "update") {
        // PostgREST real: coluna inexistente recusa o UPDATE INTEIRO (PGRST204)
        const inexistente = tabela === "anuncios" ? Object.keys(patch).find((c) => !FISICAS.has(c)) : undefined;
        const recusada = tabela === "anuncios" && alvo.some((l) => falharUpdate.has(l.id));
        const erro = inexistente ? `PGRST204 coluna ${inexistente} inexistente` : recusada ? "falha simulada de escrita" : null;
        if (tabela === "anuncios") atualizacoes.push({ filtros: { ...filtrosEq }, ids: alvo.map((l) => l.id), patch: { ...patch }, erro });
        if (erro) return { data: null, error: { message: erro } };
        for (const l of alvo) Object.assign(l, patch);
        return { data: alvo.map((l) => ({ id: l.id })), error: null };
      }
      if (ordem) alvo = [...alvo].sort((a, b) => (String(a[ordem!]) < String(b[ordem!]) ? -1 : String(a[ordem!]) > String(b[ordem!]) ? 1 : 0));
      const ini = faixa ? faixa[0] : 0, fim = faixa ? Math.min(faixa[1] + 1, ini + PAGINA) : PAGINA;
      return { data: alvo.slice(ini, fim).map((l) => ({ ...l })), error: null };
    };
    const c: any = {
      select: () => c,
      update: (p: Record<string, unknown>) => { tipo = "update"; patch = p; return c; },
      eq: (col: string, v: unknown) => { filtrosEq[col] = v; preds.push((l) => l[col] === v); return c; },
      not: (col: string, op: string, v: unknown) => { if (op === "is" && v === null) preds.push((l) => l[col] !== null && l[col] !== undefined); else throw new Error(`not(${op}) nao suportado`); return c; },
      or: (expr: string) => {
        if (expr !== "sku.is.null,sku.eq.") throw new Error(`or(${expr}) nao suportado`);
        filtrosEq["<sku-vazio>"] = true;
        preds.push((l) => l.sku === null || l.sku === undefined || l.sku === ""); return c;
      },
      in: (col: string, vs: unknown[]) => { preds.push((l) => vs.includes(l[col])); return c; },
      order: (col: string) => { ordem = col; return c; },
      limit: () => c,
      range: (de: number, ate: number) => { faixa = [de, ate]; return c; },
      single: async () => { const r = executar(); return { data: (r.data as any[] | null)?.[0] ?? null, error: r.error }; },
      maybeSingle: async () => { const r = executar(); return { data: (r.data as any[] | null)?.[0] ?? null, error: r.error }; },
      then: (res: any, rej: any) => Promise.resolve(executar()).then(res, rej),
    };
    return c;
  };
  return { from: (tabela: string) => cadeia(tabela) };
}
const requireOriginal = (Module as any).prototype.require;
(Module as any).prototype.require = function (id: string) {
  if (id === "@supabase/supabase-js") return { createClient: () => clienteFalso() };
  return requireOriginal.apply(this, arguments as any);
};

// ── Duplo do Mercado Livre ───────────────────────────────────────────
globalThis.fetch = (async (url: any) => {
  const alvo = String(url);
  chamadasRede.push(alvo);
  if (!alvo.includes("api.mercadolibre.com")) throw new Error(`teste tentou acessar a rede: ${alvo}`);
  if (alvo.includes("/users/me")) return { ok: true, status: 200, json: async () => ({ id: 12345 }) } as any;
  const multi = /\/items\?ids=([^&]*)/.exec(alvo);
  if (multi) {
    const ids = decodeURIComponent(multi[1]).split(",").filter(Boolean);
    return { ok: true, status: 200, json: async () => ids.map((id) => itensML[id] ? { code: 200, body: JSON.parse(JSON.stringify(itensML[id])) } : { code: 404, body: null }) } as any;
  }
  const individual = /\/items\/([^/?]+)/.exec(alvo);
  if (individual) {
    const corpo = completosML[individual[1]] ?? itensML[individual[1]];
    if (corpo) return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(corpo)) } as any;
  }
  return { ok: false, status: 404, json: async () => ({}) } as any;
}) as any;

let rotaSkus: (r: Request) => Promise<Response>;
let rotaPrecos: (r: Request) => Promise<Response>;
let sessao = "";
const chamar = async (rota: (r: Request) => Promise<Response>, caminho: string) => {
  const res = await rota(new Request(`https://exemplo.test${caminho}`, { method: "POST", headers: { cookie: `cds_session=${sessao}` } }));
  return { status: res.status, corpo: await res.json() as any };
};
const skus = () => chamar(rotaSkus, "/api/ml/sync-skus");
const precos = () => chamar(rotaPrecos, "/api/ml/sync-precos");
/** Toda escrita alcança no máximo UMA row e é presa por id. */
function escritasExatas() {
  for (const u of atualizacoes) {
    assert(typeof u.filtros.id === "string", `UPDATE sem id (alcança o item inteiro): ${JSON.stringify(u.filtros)}`);
    assert(u.ids.length <= 1, `UPDATE alcançou ${u.ids.length} rows: ${u.ids}`);
    assert(u.filtros.user_id === UID && u.filtros.marketplace === "ML", `UPDATE sem dono/ML: ${JSON.stringify(u.filtros)}`);
  }
}
/** ITEM X com VAR-A e VAR-B no Mercado Livre (preços e SKUs próprios por variação). */
const itemX = (skuA: string | null = "SKU_PROVIDER_A", skuB: string | null = "SKU_PROVIDER_B") => ({
  MLB1000: { id: "MLB1000", price: 99, thumbnail: "thumb-item-x", seller_custom_field: null,
    variations: [{ id: 501, price: 51, seller_custom_field: skuA }, { id: 502, price: 52, seller_custom_field: skuB }] },
});

async function principal() {
  console.log = () => {}; console.error = () => {};
  ({ POST: rotaSkus } = await import("../app/api/ml/sync-skus/route") as any);
  ({ POST: rotaPrecos } = await import("../app/api/ml/sync-precos/route") as any);
  const { emitirTokenSessao } = await import("../lib/autenticacao");
  sessao = (await emitirTokenSessao(UID)).token;

  imprimir("\n[1. sync-skus — variações irmãs]");

  t("S1. VAR-A e VAR-B com SKU manual → ambos preservados (provider tem outro SKU para cada)", async () => {
    reiniciar([an("a", "MLB1000", "501", "SKU_USER_A"), an("b", "MLB1000", "502", "SKU_USER_B")], itemX());
    const r = await skus();
    assert(r.status === 200, `status ${r.status}`);
    assert(linha("a").sku === "SKU_USER_A" && linha("b").sku === "SKU_USER_B", `sku: a=${linha("a").sku} b=${linha("b").sku}`);
    assert(atualizacoes.length === 0, `houve escrita: ${JSON.stringify(atualizacoes)}`);
  });

  t("S2. VAR-A e VAR-B vazios → A recebe SÓ SKU_PROVIDER_A, B recebe SÓ SKU_PROVIDER_B", async () => {
    reiniciar([an("a", "MLB1000", "501", null), an("b", "MLB1000", "502", "")], itemX());
    const r = await skus();
    assert(r.status === 200 && r.corpo.atualizados === 2 && r.corpo.total === 2, JSON.stringify(r.corpo));
    assert(linha("a").sku === "SKU_PROVIDER_A", `A recebeu ${linha("a").sku}`);
    assert(linha("b").sku === "SKU_PROVIDER_B", `B recebeu ${linha("b").sku}`);
    escritasExatas();
  });

  t("S3. A com SKU manual + B vazio → A intocada (sku, preço, thumb); B recebe o próprio SKU; UPDATE nunca alcança a irmã", async () => {
    reiniciar([an("a", "MLB1000", "501", "SKU_USER_A"), an("b", "MLB1000", "502", null)], itemX());
    const antesA = JSON.stringify(linha("a"));
    const r = await skus();
    assert(r.status === 200 && r.corpo.atualizados === 1, JSON.stringify(r.corpo));
    assert(JSON.stringify(linha("a")) === antesA, `row irmã A mudou: ${JSON.stringify(linha("a"))}`);
    assert(linha("b").sku === "SKU_PROVIDER_B", `B recebeu ${linha("b").sku}`);
    assert(atualizacoes.every((u) => !u.ids.includes("a")), `UPDATE alcançou A: ${JSON.stringify(atualizacoes)}`);
    escritasExatas();
  });

  t("S4. ITEM_Y sem variação → só a row ITEM_Y muda; outro item e suas variações intocados", async () => {
    reiniciar([an("y", "MLB2000", null, null), an("a", "MLB1000", "501", "SKU_USER_A"), an("b", "MLB1000", "502", "SKU_USER_B"),
      an("z", "MLB3000", null, "SKU_USER_Z")],
      { ...itemX(), MLB2000: { id: "MLB2000", price: 77, thumbnail: "thumb-y", seller_custom_field: "SKU_PROVIDER_Y" },
        MLB3000: { id: "MLB3000", price: 33, thumbnail: "thumb-z", seller_custom_field: "SKU_PROVIDER_Z" } });
    const antes = foto();
    const r = await skus();
    assert(r.status === 200 && r.corpo.atualizados === 1, JSON.stringify(r.corpo));
    assert(linha("y").sku === "SKU_PROVIDER_Y" && linha("y").preco_anuncio === 77, `y=${JSON.stringify(linha("y"))}`);
    for (const l of antes.filter((x: any) => x.id !== "y")) assert(JSON.stringify(linha(l.id)) === JSON.stringify(l), `row ${l.id} mudou`);
    escritasExatas();
  });

  t("S5. preço do sync-skus vai só na row exata: variação recebe o preço DELA (nunca o do item nem o da irmã); item sem variação, o do item", async () => {
    reiniciar([an("a", "MLB1000", "501", null), an("b", "MLB1000", "502", null), an("y", "MLB2000", null, null)],
      { ...itemX(), MLB2000: { id: "MLB2000", price: 77, thumbnail: "thumb-y", seller_custom_field: "SKU_PROVIDER_Y" } });
    await skus();
    assert(linha("a").preco_anuncio === 51 && linha("b").preco_anuncio === 52, `a=${linha("a").preco_anuncio} b=${linha("b").preco_anuncio}`);
    assert(linha("y").preco_anuncio === 77, `y=${linha("y").preco_anuncio}`);
    escritasExatas();
  });

  t("S6. variação sem SKU no ML → não herda o SKU da primeira variação nem o de outra", async () => {
    reiniciar([an("a", "MLB1000", "501", null), an("b", "MLB1000", "502", null)], itemX("SKU_PROVIDER_A", null));
    await skus();
    assert(linha("a").sku === "SKU_PROVIDER_A", `A=${linha("a").sku}`);
    assert(linha("b").sku === null, `B herdou SKU alheio: ${linha("b").sku}`);
    escritasExatas();
  });

  t("S7. fallback /items/{id}: cada variação pega o SKU da MESMA variação na resposta completa", async () => {
    reiniciar([an("a", "MLB1000", "501", null), an("b", "MLB1000", "502", null)], itemX(null, null),
      { MLB1000: { id: "MLB1000", variations: [{ id: 502, seller_custom_field: "FULL_B" }, { id: 501, seller_custom_field: "FULL_A" }] } });
    await skus();
    assert(linha("a").sku === "FULL_A" && linha("b").sku === "FULL_B", `a=${linha("a").sku} b=${linha("b").sku}`);
    assert(chamadasRede.filter((u) => u.endsWith("/items/MLB1000")).length === 1, "busca completa repetida por variação");
  });

  t("S8. row sem variação de item COM variações (legado) → não recebe o SKU de nenhuma variação", async () => {
    reiniciar([an("p", "MLB1000", null, null)], itemX());
    await skus();
    assert(linha("p").sku === null, `row-pai recebeu SKU de variação: ${linha("p").sku}`);
  });

  t("S9. erro do banco no sync-skus → não conta como atualizado e aparece em erros", async () => {
    reiniciar([an("a", "MLB1000", "501", null), an("b", "MLB1000", "502", null)], itemX());
    falharUpdate.add("a");
    const r = await skus();
    assert(r.status === 200 && r.corpo.atualizados === 1 && Array.isArray(r.corpo.erros) && r.corpo.erros.length === 1, JSON.stringify(r.corpo));
    assert(linha("a").sku === null && linha("b").sku === "SKU_PROVIDER_B", `a=${linha("a").sku} b=${linha("b").sku}`);
    assert(!JSON.stringify(r.corpo).includes("falha simulada"), "mensagem crua do banco vazou");
  });

  imprimir("\n[2. sync-precos — só colunas físicas, erro não é sucesso]");

  const comCusto = (id: string, item: string, extra: Record<string, unknown> = {}) =>
    an(id, item, null, "SKU", { custo_produto: 30, imposto: 8, insumos: 1, custo_frete: 12, frete_gratis: false,
      tipo_anuncio: "Clássico", categoria: null, logistic_type: "self_service", peso_kg: null, permalink: `perm-${id}`, preco_anuncio: 100, ...extra });
  const corpoPreco = (id: string, extra: Record<string, unknown> = {}) =>
    ({ id, title: `p-${id}`, price: 120, listing_type_id: "gold_special", thumbnail: `thumb-${id}`, permalink: `perm-${id}`,
      shipping: { logistic_type: "self_service", free_shipping: false }, ...extra });

  t("P1. custo>0 + preço mudou → UPDATE só com colunas físicas (sem lucro_liquido/margem_contribuicao) e o preço é gravado", async () => {
    reiniciar([comCusto("c1", "MLB4000")], { MLB4000: corpoPreco("MLB4000") });
    const r = await precos();
    assert(r.status === 200 && r.corpo.erro === false && r.corpo.atualizados === 1, `${r.status} ${JSON.stringify(r.corpo)}`);
    assert(atualizacoes.length === 1, `updates=${atualizacoes.length}`);
    const chaves = Object.keys(atualizacoes[0].patch);
    assert(chaves.every((c) => FISICAS.has(c)), `coluna inexistente no UPDATE: ${chaves.filter((c) => !FISICAS.has(c))}`);
    assert(!("lucro_liquido" in atualizacoes[0].patch) && !("margem_contribuicao" in atualizacoes[0].patch), `derivados no UPDATE: ${chaves}`);
    assert(linha("c1").preco_anuncio === 120, `preço não gravado: ${linha("c1").preco_anuncio}`);
    assert(atualizacoes[0].filtros.id === "c1" && atualizacoes[0].filtros.user_id === UID && atualizacoes[0].filtros.marketplace === "ML", JSON.stringify(atualizacoes[0].filtros));
  });

  t("P2. custo>0 + frete e tipo de anúncio mudaram (preço igual) → UPDATE válido e gravado", async () => {
    // flex abaixo de R$79: o frete recalculado é > 0
    reiniciar([comCusto("c2", "MLB4100", { preco_anuncio: 50, custo_frete: 0 })], { MLB4100: corpoPreco("MLB4100", { price: 50, listing_type_id: "gold_pro" }) });
    const r = await precos();
    assert(r.status === 200 && r.corpo.atualizados === 1, `${r.status} ${JSON.stringify(r.corpo)}`);
    const p = atualizacoes[0]?.patch ?? {};
    assert("tipo_anuncio" in p && "custo_frete" in p && !("preco_anuncio" in p), `esperava tipo e frete, sem preço: ${Object.keys(p)}`);
    assert(Object.keys(p).every((c) => FISICAS.has(c)), `coluna inexistente: ${Object.keys(p)}`);
    assert(linha("c2").tipo_anuncio === "Premium" && linha("c2").custo_frete > 0, JSON.stringify(linha("c2")));
  });

  t("P3. erro do banco no UPDATE → 503 erro:true, atualizados=0, nada de 'atualizado', mensagem crua não vaza", async () => {
    reiniciar([comCusto("c3", "MLB4200")], { MLB4200: corpoPreco("MLB4200") });
    falharUpdate.add("c3");
    const r = await precos();
    assert(r.status === 503 && r.corpo.erro === true && r.corpo.atualizados === 0, `${r.status} ${JSON.stringify(r.corpo)}`);
    assert(!/atualizado!/.test(r.corpo.mensagem) && (r.corpo.detalhes ?? []).length === 0, JSON.stringify(r.corpo));
    assert(!JSON.stringify(r.corpo).includes("falha simulada"), "mensagem crua do banco vazou");
    assert(linha("c3").preco_anuncio === 100, "row mudou apesar do erro");
  });

  t("P4. 1ª row grava, 2ª falha → para (fail-closed): atualizados=1, 503, detalhes só da 1ª, 3ª nem tentada", async () => {
    reiniciar([comCusto("d1", "MLB4301"), comCusto("d2", "MLB4302"), comCusto("d3", "MLB4303")],
      { MLB4301: corpoPreco("MLB4301"), MLB4302: corpoPreco("MLB4302"), MLB4303: corpoPreco("MLB4303") });
    falharUpdate.add("d2");
    const r = await precos();
    assert(r.status === 503 && r.corpo.erro === true && r.corpo.atualizados === 1, `${r.status} ${JSON.stringify(r.corpo)}`);
    assert(linha("d1").preco_anuncio === 120 && linha("d2").preco_anuncio === 100 && linha("d3").preco_anuncio === 100, "estado das rows");
    assert(!atualizacoes.some((u) => u.filtros.id === "d3"), "continuou depois da falha");
    assert((r.corpo.detalhes as string[]).every((d) => d.includes("p-d1")), `detalhes: ${r.corpo.detalhes}`);
  });

  t("P5. derivados seguem calculáveis na tela: não são colunas, e a projeção da tela traz os insumos do cálculo", () => {
    const derivados = DERIVED_UI_FIELDS as readonly string[];
    assert(derivados.every((d) => !FISICAS.has(d)), "derivado virou coluna");
    const tela = COLUNAS_ANUNCIO_TELA.split(",").map((c) => c.trim());
    for (const c of ["preco_anuncio", "custo_produto", "insumos", "custo_frete", "imposto", "categoria", "tipo_anuncio"]) assert(tela.includes(c), `tela sem ${c}`);
    const card = readFileSync(join(__dirname, "..", "app/(app)/anuncios/CardAnuncio.tsx"), "utf8");
    assert(/const lucro\s+= precoAtual - comissaoVal - impostoVal - freteVal - a\.custo_produto - a\.insumos/.test(card), "CardAnuncio não deriva mais o lucro dos campos gravados");
  });

  imprimir("\n[3. barreira multi-ML intacta]");

  t("B. dono com 2 lojas ML → 409 MULTI_ML_CATALOG_NOT_READY nas duas rotas, sem provider e sem escrita", async () => {
    for (const [nome, chamada] of [["sync-skus", skus], ["sync-precos", precos]] as const) {
      reiniciar([an("a", "MLB1000", "501", null), comCusto("c", "MLB4000")], { ...itemX(), MLB4000: corpoPreco("MLB4000") });
      lojas.push(loja(LOJA_B));
      const r = await chamada();
      assert(r.status === 409 && r.corpo.codigo === "MULTI_ML_CATALOG_NOT_READY", `${nome}: ${r.status} ${JSON.stringify(r.corpo)}`);
      assert(chamadasRede.length === 0 && atualizacoes.length === 0, `${nome}: rede=${chamadasRede.length} escritas=${atualizacoes.length}`);
    }
  });

  t("G. Guard V2 limpo (I5: leitura e escrita ML filtram marketplace)", () => {
    const i5 = leitoresMLSemMarketplace();
    assert(i5.length === 0, i5.join(" | "));
    const v2 = invariantesV2();
    assert(v2.length === 0, v2.join(" | "));
  });

  await fila;
  imprimir(`\n${falhou === 0 ? "✓" : "✗"} ML-CATALOGO-VARIACOES — ${ok} passaram, ${falhou} falharam`);
  process.exit(falhou === 0 ? 0 : 1);
}
principal().catch((e) => { imprimir("ERRO", e?.message ?? e); process.exit(1); });
