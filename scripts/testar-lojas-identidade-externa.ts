/**
 * CDS V2 — Fase 1A-SCHEMA: identidade externa de loja POR MARKETPLACE.
 *
 * Contrato: (user_id, marketplace, seller_id) identifica no máximo UMA loja. A UNIQUE legada
 * (seller_id, user_id) trata ids de marketplaces diferentes como um namespace só.
 *
 * Migrations (locais, NÃO aplicadas):
 *   20261105_lojas_identidade_externa_por_marketplace.sql  — PASSO A (adiciona a identidade nova)
 *   20261106_lojas_remove_unique_seller_global.sql         — PASSO C (remove a legada)
 *
 * Prova, offline (banco em memória que IMPÕE as UNIQUEs de cada estado — derivadas do TEXTO das
 * migrations, não de constante do teste):
 *   • colisão cross-marketplace no schema alvo: Shopee X + ML X do mesmo dono = 2 lojas válidas;
 *     Shopee X duas vezes = rejeitada; donos diferentes = ambas válidas;
 *   • runtime (capability real): registro/reconexão localizam por user_id + marketplace + seller_id e
 *     funcionam nos 3 estados (0: só legada; 1: legada + nova; 2: só nova) — nunca cruzam marketplace;
 *   • contrato fail-closed das migrations (duplicata aborta; 06 exige a nova VÁLIDA; 06 remove só a legada).
 *
 * Uso: npx tsx scripts/testar-lojas-identidade-externa.ts
 */
import "./_server-only-inerte";
import Module from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { identidadeExternaSemMarketplace, invariantesV2 } from "./_guard-v2";

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

const RAIZ = join(__dirname, "..");
const MIG_A = "supabase/migrations/20261105_lojas_identidade_externa_por_marketplace.sql";
const MIG_C = "supabase/migrations/20261106_lojas_remove_unique_seller_global.sql";
const semComentario = (s: string) => s.replace(/--.*$/gm, "");
const sqlA = semComentario(readFileSync(join(RAIZ, MIG_A), "utf8"));
const sqlC = semComentario(readFileSync(join(RAIZ, MIG_C), "utf8"));

// ── estados de schema, derivados das migrations ──────────────────────
/** UNIQUE legada (auditada no banco: lojas_seller_id_user_id_unique = UNIQUE (seller_id, user_id)). */
const LEGADA = { nome: "lojas_seller_id_user_id_unique", colunas: ["seller_id", "user_id"] };
const mNova = /create\s+unique\s+index\s+(?:if\s+not\s+exists\s+)?(\w+)\s+on\s+public\.lojas\s*\(([^)]*)\)/i.exec(sqlA);
const NOVA = { nome: mNova?.[1] ?? "?", colunas: (mNova?.[2] ?? "").split(",").map((c) => c.trim().toLowerCase()).filter(Boolean) };
const removidas = [...sqlC.matchAll(/drop\s+constraint\s+(?:if\s+exists\s+)?(\w+)/gi)].map((m) => m[1]);
type Unique = { nome: string; colunas: string[] };
const ESTADOS: Record<"0" | "1" | "2", Unique[]> = {
  "0": [LEGADA],
  "1": [LEGADA, NOVA],
  "2": [LEGADA, NOVA].filter((u) => !removidas.includes(u.nome)),
};

// ── banco em memória que impõe as UNIQUEs (NULL nunca colide, como no Postgres) ──
type Loja = Record<string, any>;
let lojas: Loja[] = [];
let uniques: Unique[] = ESTADOS["2"];
let seq = 0;
const colide = (a: Loja, b: Loja) => uniques.find((u) => u.colunas.every((c) => a[c] !== null && a[c] !== undefined && String(a[c]) === String(b[c])));
function clienteFalso() {
  return { from(tabela: string) {
    if (tabela !== "lojas") throw new Error(`tabela inesperada: ${tabela}`);
    const st: any = { op: "select", payload: null, filtros: [] as [string, any][] };
    const casa = (l: Loja) => st.filtros.every(([c, v]: [string, any]) => String(l[c]) === String(v));
    const exec = () => {
      if (st.op === "insert") {
        const nova = { id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`, ativo: true, ...st.payload };
        const u = lojas.map((l) => colide(nova, l)).find(Boolean);
        if (u) return { data: null, error: { code: "23505", message: `duplicate key value violates unique constraint "${u.nome}"` } };
        lojas.push(nova); return { data: [{ id: nova.id }], error: null };
      }
      if (st.op === "update") {
        const alvo = lojas.filter(casa);
        for (const l of alvo) {
          const depois = { ...l, ...st.payload };
          const u = lojas.filter((o) => o !== l).map((o) => colide(depois, o)).find(Boolean);
          if (u) return { data: null, error: { code: "23505", message: `duplicate key "${u.nome}"` } };
        }
        for (const l of alvo) Object.assign(l, st.payload);
        return { data: alvo.map((l) => ({ id: l.id })), error: null };
      }
      return { data: lojas.filter(casa).map((l) => ({ ...l })), error: null };
    };
    const b: any = {
      select: () => b, order: () => b, limit: () => b, not: () => b,
      insert: (p: any) => { st.op = "insert"; st.payload = p; return b; },
      update: (p: any) => { st.op = "update"; st.payload = p; return b; },
      eq: (c: string, v: any) => { st.filtros.push([c, v]); return b; },
      then: (res: any, rej: any) => Promise.resolve().then(exec).then(res, rej),
    };
    return b;
  } };
}
const requireOriginal = (Module as any).prototype.require;
(Module as any).prototype.require = function (id: string) {
  if (id === "@supabase/supabase-js") return { createClient: () => clienteFalso() };
  return requireOriginal.apply(this, arguments as any);
};
globalThis.fetch = (async () => { throw new Error("teste tentou acessar a rede"); }) as any;

const U = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OUTRO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const X = "12345";
const ML_U = "33333333-3333-4333-8333-333333333333";
const SH_U = "44444444-4444-4444-8444-444444444444";
const lojaML = (id: string, user_id: string, seller: string): Loja =>
  ({ id, user_id, marketplace: "ML", seller_id: seller, shop_id: null, nome: "ml_apelido", nickname: "ml_apelido", access_token: "<a>", ativo: true });
const lojaSH = (id: string, user_id: string, shop: string): Loja =>
  ({ id, user_id, marketplace: "Shopee", seller_id: shop, shop_id: shop, nome: "Loja Shopee", nickname: "Loja Shopee", access_token: "<a>", ativo: true });
const estado = (e: "0" | "1" | "2", linhas: Loja[] = []) => { uniques = ESTADOS[e]; lojas = linhas.map((l) => ({ ...l })); seq = 0; };
const DADOS_SH = { nomeReal: null, partnerId: "1", partnerKey: "<k>", accessToken: "<a>", refreshToken: "<r>", expiraEm: "2027-01-01" };

async function principal() {
  console.log = () => {}; console.error = () => {}; console.warn = () => {};
  const CAP = await import("../lib/marketplace/credenciais");

  secao("\n[S. estados de schema derivados das migrations]");
  t("S. 20261105 cria (user_id, marketplace, seller_id); 20261106 remove SÓ a legada → estados 0/1/2 bem formados", () => {
    assert(NOVA.nome === "lojas_identidade_externa_uq" && NOVA.colunas.join(",") === "user_id,marketplace,seller_id", JSON.stringify(NOVA));
    assert(removidas.length === 1 && removidas[0] === LEGADA.nome, `06 remove: ${removidas.join(",")}`);
    assert(!/\bdrop\s+(index|table|column)\b/i.test(sqlC) && !/\bdrop\s+/i.test(sqlA), "migration remove algo além da UNIQUE legada");
    assert(ESTADOS["0"].length === 1 && ESTADOS["1"].length === 2 && ESTADOS["2"].length === 1 && ESTADOS["2"][0] === NOVA, JSON.stringify(ESTADOS));
    for (const e of ["0", "1", "2"] as const) assert(ESTADOS[e].length >= 1, `estado ${e} sem constraint de identidade externa`);
  });

  secao("\n[C. colisão cross-marketplace — schema alvo (estado 2)]");
  t("C1. mesmo dono: Shopee 12345 + ML 12345 → AMBAS válidas e distintas", async () => {
    estado("2", [lojaML(ML_U, U, X)]);
    const r = await CAP.registrarLojaShopeeOAuth(U, { shopId: X, ...DADOS_SH });
    assert(r.lojaId && r.lojaId !== ML_U && !r.erro, JSON.stringify(r));
    assert(lojas.filter((l) => l.user_id === U && l.seller_id === X).map((l) => l.marketplace).sort().join(",") === "ML,Shopee", JSON.stringify(lojas));
    assert(lojas.find((l) => l.id === ML_U)!.marketplace === "ML" && lojas.find((l) => l.id === ML_U)!.access_token === "<a>", "loja ML tocada");
  });
  t("C2. mesmo dono: segunda Shopee 12345 → REJEITADA pelo schema", async () => {
    estado("2", [lojaSH(SH_U, U, X)]);
    const dup = { ...lojaSH("55555555-5555-4555-8555-555555555555", U, X) };
    const u = lojas.map((l) => colide(dup, l)).find(Boolean);
    assert(u?.nome === "lojas_identidade_externa_uq", `segunda Shopee aceita: ${JSON.stringify(u)}`);
  });
  t("C3. donos diferentes, mesmo marketplace, mesmo seller_id → AMBAS válidas", async () => {
    estado("2", [lojaSH(SH_U, U, X)]);
    const r = await CAP.registrarLojaShopeeOAuth(OUTRO, { shopId: X, ...DADOS_SH });
    assert(r.lojaId && r.lojaId !== SH_U && !r.erro, JSON.stringify(r));
    assert(lojas.filter((l) => l.seller_id === X && l.marketplace === "Shopee").length === 2, "não criou a do outro dono");
  });
  t("C0. (documenta o bug) estado 0 — só a legada: Shopee 12345 com ML 12345 do mesmo dono FALHA FECHADO, ML intacta", async () => {
    estado("0", [lojaML(ML_U, U, X)]);
    const r = await CAP.registrarLojaShopeeOAuth(U, { shopId: X, ...DADOS_SH });
    assert(!r.lojaId && r.erro === "conflito sem linha correspondente", JSON.stringify(r));
    assert(lojas.length === 1 && lojas[0].marketplace === "ML", "loja ML alterada ou Shopee criada");
  });

  secao("\n[R. runtime localiza por user_id + marketplace + seller_id — estados 0/1/2]");
  for (const e of ["0", "1", "2"] as const) {
    t(`R${e}. estado ${e}: a busca é por marketplace — seller_id ${X} da Shopee não é encontrado como ML; reconexão Shopee atualiza a Shopee, nunca a ML`, async () => {
      estado(e, [lojaSH(SH_U, U, X), lojaML(ML_U, U, "990001")]);
      const ml = await CAP.listarLojasMLDoDonoPorSeller(U, X);
      assert(ml.erro === null && ml.ids.length === 0, `listagem ML por seller ${X} achou a Shopee: ${ml.ids}`);
      const r = await CAP.registrarLojaShopeeOAuth(U, { shopId: X, ...DADOS_SH, accessToken: "<novo-shopee>" });
      assert(r.lojaId === SH_U && !r.erro, JSON.stringify(r));
      assert(lojas.find((l) => l.id === SH_U)!.access_token === "<novo-shopee>" && lojas.find((l) => l.id === ML_U)!.access_token === "<a>", "credencial foi para a loja errada");
      assert(lojas.length === 2, "criou loja a mais");
    });
    t(`N${e}. estado ${e}: conexão nova (sem colisão) cria a loja; reconexão comum funciona`, async () => {
      estado(e);
      const r1 = await CAP.registrarLojaShopeeOAuth(U, { shopId: "777", ...DADOS_SH });
      const r2 = await CAP.registrarLojaShopeeOAuth(U, { shopId: "777", ...DADOS_SH, accessToken: "<b>" });
      assert(r1.lojaId && r2.lojaId === r1.lojaId && lojas.length === 1 && lojas[0].seller_id === "777" && lojas[0].shop_id === "777", JSON.stringify(lojas));
    });
  }

  t("R2x. estado 2 (o único em que podem coexistir): Shopee 12345 + ML 12345 do mesmo dono — cada reconexão escolhe a sua loja pelo marketplace", async () => {
    estado("2", [lojaML(ML_U, U, X), lojaSH(SH_U, U, X)]);
    const r = await CAP.registrarLojaShopeeOAuth(U, { shopId: X, ...DADOS_SH, accessToken: "<novo-shopee>" });
    assert(r.lojaId === SH_U && !r.erro, JSON.stringify(r));
    assert(lojas.find((l) => l.id === ML_U)!.access_token === "<a>", "reconexão Shopee tocou a ML");
    const ml = await CAP.listarLojasMLDoDonoPorSeller(U, X);
    assert(ml.ids.join() === ML_U, `listagem ML por seller: ${ml.ids}`);
    const m2 = await CAP.registrarCredencialMLOAuth(U, { lojaId: ML_U, sellerId: X, nickname: null, accessToken: "<novo-ml>", refreshToken: null, expiraEm: "2027-01-01" });
    assert(m2.lojaId === ML_U && lojas.find((l) => l.id === ML_U)!.access_token === "<novo-ml>" && lojas.find((l) => l.id === SH_U)!.access_token === "<novo-shopee>", "reconexão ML tocou a Shopee");
  });

  secao("\n[M. contrato fail-closed das migrations]");
  t("M1. 20261105: checa duplicata de (user_id, marketplace, seller_id) e seller_id≠shop_id ANTES de criar, com RAISE (nenhum vencedor escolhido)", () => {
    const iDup = sqlA.search(/group\s+by\s+user_id,\s*marketplace,\s*seller_id[\s\S]*?having\s+count\(\*\)\s*>\s*1/i);
    const iRaise = sqlA.search(/raise\s+exception/i);
    const iCreate = sqlA.search(/create\s+unique\s+index/i);
    assert(iDup > 0 && iRaise > iDup && iCreate > iRaise, `ordem: dup=${iDup} raise=${iRaise} create=${iCreate}`);
    assert(/seller_id\s+is\s+distinct\s+from\s+shop_id/i.test(sqlA), "sem pré-checagem Shopee seller_id = shop_id");
    assert(!/\b(delete|update)\b/i.test(sqlA), "migration escolhe vencedor (DELETE/UPDATE)");
    assert(/check\s*\(\s*marketplace\s*<>\s*'Shopee'\s+or\s+shop_id\s+is\s+null\s+or\s+seller_id\s*=\s*shop_id\s*\)/i.test(sqlA), "CHECK de coerência Shopee ausente");
  });
  t("M2. 20261106: exige a nova VÁLIDA (unique, valid, ready, sem predicado, colunas exatas) e sem dependentes ANTES do drop", () => {
    const iDrop = sqlC.search(/alter\s+table\s+public\.lojas\s+drop\s+constraint/i);
    for (const [rotulo, re] of [["existe", /to_regclass\('public\.lojas_identidade_externa_uq'\)\s+is\s+null/i], ["valida", /indisunique\s+and\s+i\.indisvalid\s+and\s+i\.indisready/i],
      ["sem predicado", /indpred\s+is\s+null/i], ["colunas", /array\['user_id',\s*'marketplace',\s*'seller_id'\]/i], ["dependentes", /pg_depend[\s\S]*?lojas_seller_id_user_id_unique/i]] as const) {
      const i = sqlC.search(re as RegExp);
      assert(i > 0 && i < iDrop, `pré-condição "${rotulo}" ausente ou depois do drop`);
    }
  });

  secao("\n[G. Guard V2]");
  t("G. I6 EXTERNAL_IDENTITY_IS_MARKETPLACE_SCOPED e invariantes V2 limpos", () => {
    const v = identidadeExternaSemMarketplace();
    assert(v.length === 0, v.join(" | "));
    const v2 = invariantesV2();
    assert(v2.length === 0, v2.join(" | "));
  });

  await fila;
  imprimir(`\n${falhou === 0 ? "✓" : "✗"} LOJAS-IDENTIDADE-EXTERNA — ${ok} passaram, ${falhou} falharam`);
  process.exit(falhou === 0 ? 0 : 1);
}
principal().catch((e) => { imprimir("ERRO", e?.stack ?? e); process.exit(1); });
