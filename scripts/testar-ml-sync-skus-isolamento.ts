/**
 * CDS V2 — Fase 0C: POST /api/ml/sync-skus isolado por marketplace.
 *
 * Invariante (ML_SKU_SYNC_NEVER_READS_OR_WRITES_SHOPEE_ROWS): a rota ML nunca envia ao
 * provider ML um item de row marketplace = Shopee — mesmo do mesmo dono, ativa,
 * sem SKU, com ml_item_id preenchido (até com cara de MLB) e vindo ANTES das
 * rows ML na paginação — e nunca ESCREVE numa row Shopee, nem quando ela colide
 * com uma row ML no mesmo dono + ml_item_id (Fase 0C.1).
 *
 * Prova pelo que o duplo do Mercado Livre RECEBE (`/items?ids=`), não pela
 * resposta. Duplo do banco interpreta eq/not/or/order/range como o PostgREST
 * (inclusive o corte de página). Sem rede, sem banco, sem credencial real.
 *
 * Uso: npx tsx scripts/testar-ml-sync-skus-isolamento.ts
 */
import "./_server-only-inerte";
import Module from "node:module";
import { invariantesV2, leitoresMLSemMarketplace } from "./_guard-v2";

let ok = 0, falhou = 0;
let fila: Promise<void> = Promise.resolve();
const imprimir = console.log.bind(console);
function t(nome: string, fn: () => void | Promise<void>) {
  fila = fila.then(async () => {
    try { await fn(); ok++; imprimir(`  PASS  ${nome}`); }
    catch (e: any) { falhou++; imprimir(`  FALHA ${nome} -> ${e?.message ?? e}`); }
  });
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder-de-teste.invalid";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "chave-de-teste-invalida";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "chave-de-teste-invalida";
process.env.ML_CLIENT_ID ??= "ficticio";
process.env.ML_CLIENT_SECRET ??= "ficticio";
process.env.SESSION_SECRET ??= "segredo-de-teste-com-mais-de-32-bytes-000000";

const UID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UID_OUTRO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LOJA_ML_A = "11111111-1111-4111-8111-111111111111";
const LOJA_SHOPEE_A = "44444444-4444-4444-8444-444444444444";
const TOKEN_A = "<access-da-loja-ML-A>";
const PAGINA = 1000;   // max-rows do PostgREST

let lojas: any[] = [];
let anuncios: any[] = [];
/** Página (0-based) de anuncios cuja leitura falha; null = nenhuma. */
let falharPagina: number | null = null;
let paginasLidas = 0;
/** Todo UPDATE em anuncios: filtros eq aplicados e ids das linhas alcançadas. */
let atualizacoes: Array<{ filtros: Record<string, unknown>; ids: string[] }> = [];

function reiniciar(linhas: any[]) {
  lojas = [{ id: LOJA_ML_A, user_id: UID_A, marketplace: "ML", ativo: true, nickname: "LojaA", seller_id: "<seller-A>",
    access_token: TOKEN_A, refresh_token: "<refresh-A>", token_expires_at: new Date(Date.now() + 3600_000).toISOString(), created_at: "2026-01-01" }];
  anuncios = linhas.map((l) => ({ ...l }));
  falharPagina = null; paginasLidas = 0; idsEnviados = []; chamadasRede = []; atualizacoes = [];
}
/** Linha de anuncio. `id` ordena a paginação (ordem lexicográfica, como uuid em texto). */
function an(id: string, user_id: string, marketplace: "ML" | "Shopee", ml_item_id: string | null, sku: string | null, ativo = true) {
  return { id, user_id, marketplace, ml_item_id, sku, ativo, nome: `p-${id}`, loja_id: marketplace === "Shopee" ? LOJA_SHOPEE_A : null };
}

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
      if (tipo === "update") { if (tabela === "anuncios") atualizacoes.push({ filtros: { ...filtrosEq }, ids: alvo.map((l) => l.id) }); for (const l of alvo) Object.assign(l, patch); return { data: alvo.map((l) => ({ id: l.id })), error: null }; }
      if (ordem) alvo = [...alvo].sort((a, b) => (String(a[ordem!]) < String(b[ordem!]) ? -1 : String(a[ordem!]) > String(b[ordem!]) ? 1 : 0));
      if (tabela === "anuncios" && faixa) {
        const pagina = Math.floor(faixa[0] / PAGINA);
        paginasLidas++;
        if (falharPagina === pagina) return { data: null, error: { message: "falha simulada" } };
      }
      // max-rows: o PostgREST nunca devolve mais de 1000 por resposta
      const ini = faixa ? faixa[0] : 0, fim = faixa ? Math.min(faixa[1] + 1, ini + PAGINA) : PAGINA;
      return { data: alvo.slice(ini, fim), error: null };
    };
    const c: any = {
      select: () => c,
      update: (p: Record<string, unknown>) => { tipo = "update"; patch = p; return c; },
      eq: (col: string, v: unknown) => { filtrosEq[col] = v; preds.push((l) => l[col] === v); return c; },
      not: (col: string, op: string, v: unknown) => { if (op === "is" && v === null) preds.push((l) => l[col] !== null && l[col] !== undefined); else throw new Error(`not(${op}) nao suportado`); return c; },
      or: (expr: string) => {
        if (expr !== "sku.is.null,sku.eq.") throw new Error(`or(${expr}) nao suportado`);
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

// ── Duplo do Mercado Livre: registra TODO id que chega ao provider ───
let idsEnviados: string[] = [];
let chamadasRede: string[] = [];
globalThis.fetch = (async (url: any) => {
  const alvo = String(url);
  chamadasRede.push(alvo);
  if (!alvo.includes("api.mercadolibre.com")) throw new Error(`teste tentou acessar a rede: ${alvo}`);
  if (alvo.includes("/users/me")) return { ok: true, status: 200, json: async () => ({ id: 12345 }) } as any;
  const m = /\/items\?ids=([^&]*)/.exec(alvo);
  if (m) {
    const ids = decodeURIComponent(m[1]).split(",").filter(Boolean);
    idsEnviados.push(...ids);
    return { ok: true, status: 200, json: async () => ids.map((id) => ({ code: 200, body: { id, seller_custom_field: `SKU-${id}` } })) } as any;
  }
  const individual = /\/items\/([^/?]+)/.exec(alvo);
  if (individual) idsEnviados.push(individual[1]);
  return { ok: false, status: 404, json: async () => ({}) } as any;
}) as any;

let rota: (r: Request) => Promise<Response>;
let sessaoA = "";
const chamar = async () => {
  const res = await rota(new Request("https://exemplo.test/api/ml/sync-skus", { method: "POST", headers: { cookie: `cds_session=${sessaoA}` } }));
  return { status: res.status, corpo: await res.json() as any };
};
const idsDe = (pred: (l: any) => boolean) => anuncios.filter(pred).map((l) => l.ml_item_id as string);
const mesmoConjunto = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();
const pad = (n: number) => String(n).padStart(5, "0");

async function principal() {
  console.log = () => {}; console.error = () => {};
  ({ POST: rota } = await import("../app/api/ml/sync-skus/route") as any);
  const { emitirTokenSessao } = await import("../lib/autenticacao");
  sessaoA = (await emitirTokenSessao(UID_A)).token;

  imprimir("\n[ML sync-skus — isolamento por marketplace (Fase 0C)]");

  t("A. owner só com ML → comportamento preservado: os ML sem SKU vão ao provider, o com SKU não", async () => {
    reiniciar([an("a1", UID_A, "ML", "MLB100", null), an("a2", UID_A, "ML", "MLB101", ""), an("a3", UID_A, "ML", "MLB102", "JA-TEM"),
      an("a4", UID_A, "ML", "MLBU900", null)]);
    const r = await chamar();
    assert(r.status === 200, `status ${r.status}`);
    assert(mesmoConjunto(idsEnviados, ["MLB100", "MLB101"]), `enviados=${idsEnviados}`);
    assert(r.corpo.atualizados === 2 && r.corpo.total === 2, JSON.stringify(r.corpo));
    assert(anuncios.find((l) => l.id === "a1").sku === "SKU-MLB100" && anuncios.find((l) => l.id === "a3").sku === "JA-TEM", "SKU nao gravado/sobrescrito");
  });

  t("B. ML + Shopee misturados (Shopee ANTES na paginação, ativas, sem SKU, até com id MLB) → só ML chega ao provider", async () => {
    reiniciar([an("0s1", UID_A, "Shopee", "MLB900", null), an("0s2", UID_A, "Shopee", "22334455", null), an("0s3", UID_A, "Shopee", "MLB901", ""),
      an("m1", UID_A, "ML", "MLB200", null), an("m2", UID_A, "ML", "MLB201", null)]);
    const r = await chamar();
    assert(r.status === 200, `status ${r.status}`);
    assert(mesmoConjunto(idsEnviados, ["MLB200", "MLB201"]), `enviados=${idsEnviados}`);
    assert(r.corpo.total === 2, JSON.stringify(r.corpo));
  });

  t("C. Shopee sem SKU + ML sem SKU → Shopee ignorada (nem enviada nem tocada); ML processado", async () => {
    reiniciar([an("0s", UID_A, "Shopee", "MLB300", null), an("m", UID_A, "ML", "MLB301", null)]);
    const r = await chamar();
    assert(mesmoConjunto(idsEnviados, ["MLB301"]), `enviados=${idsEnviados}`);
    assert(r.corpo.atualizados === 1, JSON.stringify(r.corpo));
    assert(anuncios.find((l) => l.id === "0s").sku === null, "row Shopee foi alterada");
    assert(anuncios.find((l) => l.id === "m").sku === "SKU-MLB301", "row ML nao recebeu SKU");
  });

  t("D. >1000 rows misturadas (1300 Shopee antes + 1300 ML) → paginação completa e filtro mantido", async () => {
    const linhas: any[] = [];
    for (let i = 0; i < 1300; i++) linhas.push(an(`0s${pad(i)}`, UID_A, "Shopee", `MLB9${pad(i)}`, null));
    for (let i = 0; i < 1300; i++) linhas.push(an(`m${pad(i)}`, UID_A, "ML", `MLB5${pad(i)}`, null));
    reiniciar(linhas);
    const r = await chamar();
    const esperados = idsDe((l) => l.marketplace === "ML");
    assert(r.status === 200, `status ${r.status}`);
    assert(paginasLidas >= 2, `paginas lidas=${paginasLidas}`);
    assert(mesmoConjunto(idsEnviados, esperados), `enviados=${idsEnviados.length} esperados=${esperados.length}`);
    assert(!idsEnviados.some((id) => id.startsWith("MLB9")), "id de row Shopee chegou ao provider");
    assert(r.corpo.total === 1300 && r.corpo.atualizados === 1300, JSON.stringify(r.corpo));
  });

  t("E. erro numa página intermediária → 503, nada enviado ao provider, nada gravado", async () => {
    const linhas: any[] = [];
    for (let i = 0; i < 2500; i++) linhas.push(an(`m${pad(i)}`, UID_A, "ML", `MLB7${pad(i)}`, null));
    reiniciar(linhas);
    falharPagina = 1;
    const r = await chamar();
    assert(r.status === 503 && r.corpo.erro === true, `${r.status} ${JSON.stringify(r.corpo)}`);
    assert(idsEnviados.length === 0 && !chamadasRede.some((u) => u.includes("/items")), `provider chamado: ${chamadasRede.length}`);
    assert(anuncios.every((l) => l.sku === null), "conjunto parcial foi gravado");
  });

  t("F. rows de OUTRO owner (ML, ativas, sem SKU) → nunca entram", async () => {
    reiniciar([an("0x1", UID_OUTRO, "ML", "MLB400", null), an("0x2", UID_OUTRO, "Shopee", "MLB401", null), an("m", UID_A, "ML", "MLB402", null)]);
    const r = await chamar();
    assert(mesmoConjunto(idsEnviados, ["MLB402"]), `enviados=${idsEnviados}`);
    assert(anuncios.filter((l) => l.user_id === UID_OUTRO).every((l) => l.sku === null), "row de outro owner foi alterada");
    assert(r.corpo.total === 1, JSON.stringify(r.corpo));
  });

  t("H. COLISÃO artificial: row Shopee do MESMO dono com o MESMO ml_item_id de uma row ML (ativa, SKU vazio) → só a ML é escrita; o UPDATE filtra marketplace = ML", async () => {
    reiniciar([an("0shopee", UID_A, "Shopee", "MLB500", ""), an("ml", UID_A, "ML", "MLB500", null)]);
    const r = await chamar();
    assert(r.status === 200 && r.corpo.atualizados === 1, JSON.stringify(r.corpo));
    assert(mesmoConjunto(idsEnviados, ["MLB500"]), `enviados=${idsEnviados}`);
    assert(atualizacoes.length >= 1, "nenhum UPDATE registrado");
    for (const u of atualizacoes) {
      assert(u.filtros.marketplace === "ML" && u.filtros.user_id === UID_A && u.filtros.ml_item_id === "MLB500", `filtros do UPDATE: ${JSON.stringify(u.filtros)}`);
      assert(!u.ids.includes("0shopee"), `UPDATE alcançou a row Shopee: ${u.ids}`);
    }
    const shopee = anuncios.find((l) => l.id === "0shopee"), ml = anuncios.find((l) => l.id === "ml");
    assert(shopee.sku === "" && shopee.marketplace === "Shopee", `row Shopee alterada: sku=${shopee.sku}`);
    assert(ml.sku === "SKU-MLB500", `row ML nao recebeu SKU: ${ml.sku}`);
  });

  t("G. Guard V2 I5 ML_SKU_SYNC_NEVER_READS_OR_WRITES_SHOPEE_ROWS limpo (READ e WRITE do sync-skus filtram marketplace = ML)", () => {
    const i5 = leitoresMLSemMarketplace();
    assert(i5.length === 0, i5.join(" | "));
    const v2 = invariantesV2();
    assert(v2.length === 0, v2.join(" | "));
  });

  await fila;
  imprimir(`\n${falhou === 0 ? "✓" : "✗"} ML-SYNC-SKUS-ISOLAMENTO — ${ok} passaram, ${falhou} falharam`);
  process.exit(falhou === 0 ? 0 : 1);
}
principal().catch((e) => { imprimir("ERRO", e?.message ?? e); process.exit(1); });
