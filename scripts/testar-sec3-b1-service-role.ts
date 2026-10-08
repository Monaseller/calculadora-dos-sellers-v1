/**
 * Suite da frente SEC-3-B1 — acesso server-side as 15 tabelas SEC-3 so
 * por `service_role`, com o isolamento por dono provado na propria rota.
 *
 * ── Por que existe ──────────────────────────────────────────────────
 * As 15 tabelas (pedidos, anuncios, sync_jobs, vendas_dia,
 * dashboard_resumos_diarios e as 10 `estudio_anuncios_*`) estao sem RLS
 * e concedem SELECT/INSERT/UPDATE a `anon`. O REVOKE (SEC-3-C) so pode
 * rodar quando nenhum leitor server-side depender da chave anon. E, com
 * `service_role`, o banco nao filtra NADA: quem pode ver o que passa a
 * ser decidido inteiramente pelo codigo. Esta suite trava as duas coisas.
 *
 *  A. guarda estatica: nenhum arquivo SERVER que toque uma das 15 usa anon
 *  B. o helper oficial (`getSupabaseServidor`) nas entradas migradas
 *  C. rotas de usuario derivam `user_id` da sessao, nunca do request
 *  D. loja de outro usuario e recusada
 *  E. projeto / job de outro usuario e recusado
 *  F. backfill nao e disparavel por usuario comum
 *  G. vendas-hoje nao funciona sem sessao e nao le anuncios alheios
 *  H. motores de sync preservam loja<->usuario
 *  I. Studio preserva isolamento por dono
 *  J. nenhum arquivo de browser mudou neste gate
 *  K. nenhuma migration / grant / RLS mudou neste gate
 *
 * Offline: banco, rede e credenciais sao duplos. Nenhum segredo real.
 *
 * Uso: npx tsx scripts/testar-sec3-b1-service-role.ts
 */
import "./_server-only-inerte";
import Module from "node:module";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname, normalize } from "node:path";
// SHOPEE MULTI-APP: excecao EXATA — Configuracoes so sai da J2 pelos hunks aprovados (pagina − hunks = eca183a)
import { filtrarExcecaoShopeeMultiApp } from "./_excecao-shopee-multi-app";
// SHOPEE UX V4: excecao EXATA do painel unico Shopee (Configuracoes − hunks UX = cdeb7af; novos por sha256)
import { filtrarExcecaoShopeeUX } from "./_excecao-shopee-ux";

let passou = 0, falhou = 0;
let fila: Promise<void> = Promise.resolve();
function t(nome: string, fn: () => void | Promise<void>) {
  fila = fila.then(async () => {
    try { await fn(); passou++; console.log(`  PASS  ${nome}`); }
    catch (e: any) { falhou++; console.log(`  FALHA ${nome} -> ${e?.message ?? e}`); }
  });
}
function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }

// ── Ambiente de teste (valores deliberadamente invalidos para trafego real)
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://placeholder-de-teste.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "chave-de-teste-invalida";
process.env.SESSION_SECRET = "segredo-de-sessao-so-para-teste-0123456789abcdef";
process.env.NEXT_PUBLIC_ENABLE_ASYNC_SYNC_JOBS = "true";
delete process.env.CRON_SECRET;

const RAIZ = join(__dirname, "..");
const BASE = "c075653";

const TABELAS_SEC3 = [
  "pedidos", "anuncios", "sync_jobs", "vendas_dia", "dashboard_resumos_diarios",
  "estudio_anuncios_conteudo_versoes", "estudio_anuncios_imagens_origem", "estudio_anuncios_jobs",
  "estudio_anuncios_pipeline", "estudio_anuncios_pipeline_catalogo", "estudio_anuncios_pipeline_catalogo_jobs",
  "estudio_anuncios_projetos", "estudio_anuncios_projetos_marketplace", "estudio_anuncios_resultados_pipeline",
  "estudio_anuncios_validacoes_publicacao",
];

/** Dependencias de browser que ficam para o SEC-3-B2 (fora deste gate). */
const BROWSER_PENDENTE = [
  "app/(app)/anuncios/page.tsx",
  "app/(app)/anuncios/FormAnuncio.tsx",
  "app/(app)/anuncios/CardAnuncio.tsx",
  "app/(app)/dashboard/page.tsx",
];

/** As 31 entradas server-side que usavam a chave anon antes do B1. */
const MIGRADOS = [
  "app/api/admin/backfill-resumos-diarios/route.ts",
  "app/api/admin/shopee/backfill-pedidos-0707/route.ts",
  "app/api/admin/shopee/reconciliar-financeiro/route.ts",
  "app/api/dashboard/resumo/route.ts",
  "app/api/estudio-anuncios/projetos/route.ts",
  "app/api/estudio-anuncios/projetos/[id]/route.ts",
  "app/api/estudio-anuncios/projetos/[id]/compliance/[marketplace]/route.ts",
  "app/api/estudio-anuncios/projetos/[id]/conteudo/[marketplace]/aprovar/route.ts",
  "app/api/estudio-anuncios/projetos/[id]/conteudo/[marketplace]/versoes/route.ts",
  "app/api/estudio-anuncios/projetos/[id]/exportacao/route.ts",
  "app/api/estudio-anuncios/projetos/[id]/exportacao/[pacoteId]/arquivo/route.ts",
  "app/api/estudio-anuncios/projetos/[id]/fotos/route.ts",
  "app/api/estudio-anuncios/projetos/[id]/marketplaces/[marketplace]/route.ts",
  "app/api/estudio-anuncios/projetos/[id]/marketplaces/[marketplace]/categorias/route.ts",
  "app/api/estudio-anuncios/projetos/[id]/marketplaces/[marketplace]/lojas/route.ts",
  "app/api/estudio-anuncios/projetos/[id]/marketplaces/[marketplace]/publicar/route.ts",
  "app/api/estudio-anuncios/projetos/[id]/marketplaces/[marketplace]/validacao-oficial/route.ts",
  "app/api/estudio-anuncios/projetos/[id]/pipeline/iniciar/route.ts",
  "app/api/estudio-anuncios/projetos/[id]/pipeline/retomar/route.ts",
  "app/api/ml/importar-anuncios/route.ts",
  "app/api/ml/sync-precos/route.ts",
  "app/api/ml/sync-skus/route.ts",
  "app/api/ml/vendas-hoje/route.ts",
  "app/api/ml/vendas/route.ts",
  "app/api/shopee/importar-anuncios/route.ts",
  "app/api/shopee/vendas/route.ts",
  "app/api/sync/iniciar/route.ts",
  "app/api/sync/status/route.ts",
  "lib/resumos-diarios.ts",
  "lib/sync-ml.ts",
  "lib/sync-shopee.ts",
];

// ─────────────────────────────────────────────────────────────────────
// Guarda estatica SERVER_SEC3 (exportavel como funcao pura para o
// auto-teste: a guarda tem de PEGAR a violacao, nao so passar).
// ─────────────────────────────────────────────────────────────────────
/**
 * Mudancas de banco APROVADAS depois da base deste gate — cada uma com o
 * proprio guard linha a linha (SEC-3-C: testar-sec3-c-lockdown;
 * S2-D1: testar-s2d1-migracao). Qualquer outra continua reprovando K1/K2.
 */
const MIGRACOES_APROVADAS = [
  "supabase/migrations/20261026_sec3c_lockdown_tabelas_publicas.sql",
  "supabase/migrations/20261027_s2d1_shopee_foundation.sql",
  // S2-D2.2: cutover (NAO aplicado, fora de supabase/migrations) — guard proprio: testar-s2-cutover-migracao
  "supabase/cutover/PENDENTE_s2_cutover_shopee_item_store_unique.sql",
  // ML-CORPUS-A: foundation ML (NAO aplicada) — guard proprio: testar-ml-corpus-migracao
  "supabase/migrations/20261028_ml_corpus_foundation.sql",
  // SALES-SYNC-C1: fence do claim legado (NAO aplicada) — guard proprio: testar-sync-legacy-fence
  "supabase/migrations/20261029_sales_sync_c1_legacy_claim_fence.sql",
  // SALES-SYNC-C4: lease do refresh Shopee (NAO aplicada) — guard proprio: testar-shopee-refresh-lease
  "supabase/migrations/20261030_sales_sync_c4_shopee_refresh_lease.sql",
  // SALES-SYNC-C8: SELECT do service_role no lease (guard proprio: testar-shopee-refresh-lease M6)
  "supabase/migrations/20261031_sales_sync_c8_shopee_refresh_lease_select.sql",
];

const RE_TABELA = new RegExp(`\\.from\\(\\s*["'\`](${TABELAS_SEC3.join("|")})["'\`]\\s*\\)`, "g");
const RE_RPC_SEC3 = /\.rpc\(\s*["'`](claim_next_sync_job|criar_projeto_estudio_anuncios|estudio_anuncios_\w+)["'`]/g;

function usaAnon(fonte: string): boolean {
  return /NEXT_PUBLIC_SUPABASE_ANON_KEY/.test(fonte)
    || /from\s+["']@\/lib\/supabase["']/.test(fonte)
    || /from\s+["'](?:\.\.\/)+lib\/supabase["']/.test(fonte);
}
function tabelasTocadas(fonte: string): string[] {
  const s = new Set<string>();
  for (const m of fonte.matchAll(RE_TABELA)) s.add(m[1]);
  for (const m of fonte.matchAll(RE_RPC_SEC3)) s.add(`rpc:${m[1]}`);
  return [...s];
}
type Contexto = "SERVER" | "BROWSER" | "TEST";
/** Violacoes: arquivo SERVER que usa anon E toca tabela SEC-3. */
function guardaServerSec3(arquivos: Map<string, string>, contexto: (f: string) => Contexto) {
  const violacoes: { arquivo: string; tabelas: string[] }[] = [];
  for (const [f, s] of arquivos) {
    if (contexto(f) !== "SERVER") continue;
    const tabs = tabelasTocadas(s);
    if (tabs.length > 0 && usaAnon(s)) violacoes.push({ arquivo: f, tabelas: tabs });
  }
  return violacoes;
}

// SALES-SYNC-C3: o diff contra a base passou de 1 MiB (padrão do maxBuffer)
// e o spawnSync abortava com ENOBUFS. Só a capacidade muda — base,
// exclusões, padrões e asserções continuam os mesmos.
const GIT_MAX_BUFFER = 16 * 1024 * 1024;
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: RAIZ, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: GIT_MAX_BUFFER });
const arquivosRepo = git("ls-files", "app", "lib", "components", "middleware.ts")
  .split(/\r?\n/).filter((f) => /\.(ts|tsx|js|mjs)$/.test(f));
const fonte = new Map(arquivosRepo.map((f) => [f, readFileSync(join(RAIZ, f), "utf8")]));

// Alcance de browser: tudo que um arquivo "use client" importa, transitivamente.
function resolver(de: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = spec.slice(2);
  else if (spec.startsWith(".")) base = normalize(join(dirname(de), spec)).replace(/\\/g, "/");
  else return null;
  for (const ext of ["", ".ts", ".tsx", ".js", "/index.ts", "/index.tsx"]) if (fonte.has(base + ext)) return base + ext;
  return null;
}
const browser = new Set<string>();
{
  const pilha = arquivosRepo.filter((f) =>
    /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']use client["']/.test(fonte.get(f)!));
  while (pilha.length) {
    const f = pilha.pop()!;
    if (browser.has(f)) continue;
    browser.add(f);
    for (const m of fonte.get(f)!.matchAll(/(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) {
      const r = resolver(f, m[1] ?? m[2]);
      if (r && !browser.has(r)) pilha.push(r);
    }
  }
}
const contextoDe = (f: string): Contexto =>
  f.startsWith("scripts/") ? "TEST" : browser.has(f) ? "BROWSER" : "SERVER";

// ─────────────────────────────────────────────────────────────────────
// Duplo do Supabase: registra cada cadeia (tabela, operacao, filtros) e
// responde a partir de um banco em memoria filtrado por eq/in.
// ─────────────────────────────────────────────────────────────────────
const UID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LOJA_A = "11111111-1111-4111-8111-111111111111";
const LOJA_B = "22222222-2222-4222-8222-222222222222";
const PROJ_B = "55555555-5555-4555-8555-555555555555";
const JOB_B = "66666666-6666-4666-8666-666666666666";
const DIA = "2026-09-01";

interface Chamada { tabela: string; op: string; filtros: [string, string, unknown][]; payload?: unknown }
let chamadas: Chamada[] = [];
let BANCO: Record<string, any[]> = {};
function bancoPadrao(): Record<string, any[]> {
  return {
    lojas: [
      { id: LOJA_A, user_id: UID_A, marketplace: "ML", nickname: "conta-a", ativo: true, partner_id: "p", partner_key: "<k-a>", access_token: "<t-a>", shop_id: 1 },
      { id: LOJA_B, user_id: UID_B, marketplace: "Shopee", nickname: "conta-b", ativo: true, partner_id: "p", partner_key: "<k-b>", access_token: "<t-b>", shop_id: 2 },
    ],
    pedidos: [
      { id: "pa", user_id: UID_A, loja_id: LOJA_A, data_pagamento: DIA, data_criacao: DIA },
      { id: "pb", user_id: UID_B, loja_id: LOJA_B, data_pagamento: DIA, data_criacao: DIA },
    ],
    anuncios: [
      { id: "anuncio-a", user_id: UID_A, ativo: true, ml_item_id: "MLB1", nome: "A", margem_desejada: 10 },
      { id: "anuncio-b", user_id: UID_B, ativo: true, ml_item_id: "MLB1", nome: "B", margem_desejada: 10 },
    ],
    sync_jobs: [
      { id: JOB_B, user_id: UID_B, loja_id: LOJA_B, marketplace: "Shopee", tipo: "incremental", status: "rodando" },
    ],
    estudio_anuncios_projetos: [{ id: PROJ_B, user_id: UID_B, nome: "projeto-b" }],
  };
}

function clienteFalso() {
  const cadeia = (tabela: string) => {
    const reg: Chamada = { tabela, op: "select", filtros: [] };
    const linhas = () => {
      chamadas.push(reg);
      if (reg.op === "insert") return [{ id: "job-novo", ...(reg.payload as object) }];
      if (reg.op !== "select") return [];
      return (BANCO[tabela] ?? []).filter((l) => reg.filtros.every(([tipo, col, v]) =>
        tipo === "eq" ? String(l[col]) === String(v)
          : tipo === "in" ? (v as unknown[]).map(String).includes(String(l[col]))
          : true));
    };
    const c: any = new Proxy({}, {
      get(_alvo, prop: string) {
        if (prop === "then") return (ok: any, erro: any) => {
          try { ok({ data: linhas(), error: null }); } catch (e) { erro(e); }
        };
        if (prop === "maybeSingle" || prop === "single") return async () => ({ data: linhas()[0] ?? null, error: null });
        return (...args: unknown[]) => {
          if (["insert", "update", "upsert", "delete"].includes(prop)) { reg.op = prop; reg.payload = args[0]; }
          if (prop === "eq" || prop === "in") reg.filtros.push([prop, String(args[0]), args[1]]);
          return c;
        };
      },
    });
    return c;
  };
  return { from: cadeia, rpc: async () => ({ data: null, error: null }) };
}
const requireOriginal = (Module as any).prototype.require;
(Module as any).prototype.require = function (id: string) {
  if (id === "@supabase/supabase-js") return { createClient: () => clienteFalso() };
  return requireOriginal.apply(this, arguments as any);
};

// Rede: nenhum fetch real. Contabiliza chamadas e responde o minimo do ML.
let fetches: string[] = [];
(globalThis as any).fetch = async (url: string) => {
  fetches.push(String(url));
  if (String(url).includes("/users/me")) return new Response(JSON.stringify({ id: 999 }), { status: 200 });
  if (String(url).includes("/orders/search")) {
    return new Response(JSON.stringify({ results: [{ order_items: [{ item: { id: "MLB1", title: "x" }, quantity: 1, unit_price: 100 }] }] }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
};

let sessaoA = "";
function req(url: string, opcoes: { sessao?: string; extraCookie?: string; authorization?: string; method?: string; body?: unknown } = {}) {
  const cookies = [opcoes.sessao ? `cds_session=${opcoes.sessao}` : "", opcoes.extraCookie ?? ""].filter(Boolean).join("; ");
  const headers: Record<string, string> = {};
  if (cookies) headers.cookie = cookies;
  if (opcoes.authorization) headers.authorization = opcoes.authorization;
  if (opcoes.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`https://exemplo.test${url}`, {
    method: opcoes.method ?? "GET", headers,
    body: opcoes.body !== undefined ? JSON.stringify(opcoes.body) : undefined,
  });
}
function reset() { chamadas = []; fetches = []; BANCO = bancoPadrao(); }
const filtroDono = (c: Chamada) => c.filtros.find(([tipo, col]) => tipo === "eq" && col === "user_id")?.[2];

async function principal() {
  const { emitirTokenSessao } = await import("../lib/autenticacao");
  sessaoA = (await emitirTokenSessao(UID_A)).token;

  // ══ A. guarda estatica ════════════════════════════════════════════
  console.log("\n[A. guarda SERVER_SEC3: nenhum server-side com anon toca as 15 tabelas]");
  t("A1. guarda: 0 violacoes no repositorio", () => {
    const v = guardaServerSec3(fonte, contextoDe);
    assert(v.length === 0, `violacoes: ${v.map((x) => `${x.arquivo} -> ${x.tabelas.join(",")}`).join(" | ")}`);
  });
  t("A2. auto-teste: a guarda PEGA um arquivo server anon que toca pedidos (e reporta arquivo+tabela)", () => {
    const sintetico = new Map([["app/api/falso/route.ts",
      `const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);\ns.from("pedidos").select("*");`]]);
    const v = guardaServerSec3(sintetico, () => "SERVER");
    assert(v.length === 1 && v[0].arquivo === "app/api/falso/route.ts" && v[0].tabelas.includes("pedidos"), JSON.stringify(v));
  });
  t("A3. auto-teste: o cliente anon de lib/supabase tambem conta como anon", () => {
    const v = guardaServerSec3(new Map([["lib/x.ts", `import { supabase } from "@/lib/supabase";\nsupabase.from("anuncios").select("id");`]]), () => "SERVER");
    assert(v.length === 1 && v[0].tabelas.includes("anuncios"), JSON.stringify(v));
  });
  t("A4. auto-teste: arquivo de BROWSER fica fora desta guarda (pendente do B2)", () => {
    const v = guardaServerSec3(new Map([["app/(app)/x.tsx", `import { supabase } from "@/lib/supabase";\nsupabase.from("anuncios")`]]), () => "BROWSER");
    assert(v.length === 0, JSON.stringify(v));
  });
  t("A5. a classificacao enxerga os 4 arquivos de browser pendentes como BROWSER", () => {
    for (const f of BROWSER_PENDENTE) assert(contextoDe(f) === "BROWSER", `${f} classificado como ${contextoDe(f)}`);
  });
  t("A6. nenhum arquivo SERVER instancia cliente com a chave anon (em qualquer tabela)", () => {
    const usando = [...fonte].filter(([f, s]) => contextoDe(f) === "SERVER" && /NEXT_PUBLIC_SUPABASE_ANON_KEY/.test(s) && f !== "lib/supabase.ts")
      .map(([f]) => f);
    assert(usando.length === 0, usando.join(", "));
  });
  // SEC-3-B2: o dashboard deixou de criar o proprio cliente anon.
  t("A7. o unico usuario restante da chave anon e lib/supabase.ts", () => {
    const usando = [...fonte].filter(([, s]) => /NEXT_PUBLIC_SUPABASE_ANON_KEY/.test(s)).map(([f]) => f).sort();
    assert(JSON.stringify(usando) === JSON.stringify(["lib/supabase.ts"]), usando.join(", "));
  });

  // ══ B. helper oficial nas entradas migradas ═══════════════════════
  console.log("\n[B. service_role via getSupabaseServidor nas 31 entradas]");
  t("B1. as 31 entradas importam getSupabaseServidor e nao criam cliente proprio", () => {
    for (const f of MIGRADOS) {
      const s = fonte.get(f);
      assert(s, `${f} ausente`);
      assert(/from "@\/lib\/estudio-anuncios\/supabase-servidor"/.test(s), `${f}: sem import do helper`);
      assert(!/\bcreateClient\s*\(/.test(s), `${f}: ainda chama createClient`);
      assert(!/ANON_KEY/.test(s), `${f}: ainda cita ANON_KEY`);
    }
  });
  t("B2. cliente sob demanda: nenhum `const supabase =` no topo; acessor memoizado", () => {
    for (const f of MIGRADOS) {
      const s = fonte.get(f)!;
      assert(!/^const supabase\s*=/m.test(s), `${f}: cliente no import`);
      assert(/return \(clienteServidor \?\?= getSupabaseServidor\(\)\);/.test(s), `${f}: sem acessor`);
    }
  });
  t("B3. o helper oficial continua server-only e fail-closed", () => {
    const s = readFileSync(join(RAIZ, "lib/estudio-anuncios/supabase-servidor.ts"), "utf8");
    assert(/^import "server-only";/m.test(s), "sem server-only");
    assert(/SUPABASE_SERVICE_ROLE_KEY/.test(s), "nao usa service_role");
  });

  // ══ C. user_id sempre da sessao ═══════════════════════════════════
  console.log("\n[C. rotas de usuario: user_id da sessao]");
  t("C1. toda rota migrada autentica a sessao (autenticarRequisicao)", () => {
    for (const f of MIGRADOS.filter((x) => x.startsWith("app/"))) {
      assert(/autenticarRequisicao\(/.test(fonte.get(f)!), `${f}: sem sessao`);
    }
  });
  t("C2. nenhuma rota migrada le user_id de query, body ou header", () => {
    for (const f of MIGRADOS.filter((x) => x.startsWith("app/"))) {
      const s = fonte.get(f)!;
      assert(!/searchParams\.get\(\s*["'](user_id|userId|uid)["']/.test(s), `${f}: user_id da query`);
      assert(!/body\??\.(user_id|userId|uid)\b/.test(s), `${f}: user_id do body`);
      assert(!/headers\.get\(\s*["']x-user/.test(s), `${f}: user_id de header`);
    }
  });

  const status = await import("../app/api/sync/status/route");
  const iniciar = await import("../app/api/sync/iniciar/route");
  const backfill = await import("../app/api/admin/backfill-resumos-diarios/route");
  const vendasHoje = await import("../app/api/ml/vendas-hoje/route");
  const { buscarProjetoPorId } = await import("../lib/estudio-anuncios/projetos");
  const { getShopeeLojaById } = await import("../lib/shopee-auth");

  // ══ D. loja de outro usuario ══════════════════════════════════════
  console.log("\n[D. loja de outro usuario e recusada]");
  t("D1. sync/iniciar: sessao A + loja de B -> 400 e NENHUM job criado", async () => {
    reset();
    const r = await iniciar.POST(req("/api/sync/iniciar", { sessao: sessaoA, method: "POST", body: { loja_id: LOJA_B } }));
    assert(r.status === 400, `status ${r.status}`);
    assert(!chamadas.some((c) => c.tabela === "sync_jobs"), "tocou sync_jobs");
  });
  t("D2. sync/iniciar: sessao A + loja A -> job com user_id da SESSAO", async () => {
    reset();
    const r = await iniciar.POST(req("/api/sync/iniciar", { sessao: sessaoA, method: "POST", body: { loja_id: LOJA_A, user_id: UID_B } }));
    assert(r.status === 200, `status ${r.status}`);
    const ins = chamadas.find((c) => c.tabela === "sync_jobs" && c.op === "insert");
    assert(ins && (ins.payload as any).user_id === UID_A, `insert: ${JSON.stringify(ins?.payload)}`);
  });
  t("D3. getShopeeLojaById(loja de B, usuario A) -> null (credencial alheia nunca sai)", async () => {
    reset();
    const r = await getShopeeLojaById(LOJA_B, UID_A);
    assert(r === null, `VAZAMENTO: ${JSON.stringify(r)}`);
  });
  t("D4. sem sessao: sync/iniciar -> 401 sem tocar no banco", async () => {
    reset();
    const r = await iniciar.POST(req("/api/sync/iniciar", { method: "POST", body: { loja_id: LOJA_A } }));
    assert(r.status === 401 && chamadas.length === 0, `status ${r.status}, chamadas ${chamadas.length}`);
  });

  // ══ E. projeto / job de outro usuario ═════════════════════════════
  console.log("\n[E. projeto/job de outro usuario e recusado]");
  t("E1. buscarProjetoPorId(A, projeto de B) -> null, com user_id DENTRO da consulta", async () => {
    reset();
    const r = await buscarProjetoPorId(clienteFalso() as any, UID_A, PROJ_B);
    assert(r === null, "VAZAMENTO de projeto alheio");
    const c = chamadas.find((x) => x.tabela === "estudio_anuncios_projetos");
    assert(c && filtroDono(c) === UID_A, "consulta sem filtro de dono");
  });
  t("E2. sync/status?job_id=<job de B> com sessao A -> nada de B no corpo", async () => {
    reset();
    const r = await status.GET(req(`/api/sync/status?job_id=${JOB_B}`, { sessao: sessaoA }));
    const corpo = await r.json();
    assert(!JSON.stringify(corpo).includes(LOJA_B) && corpo.job_id === undefined, JSON.stringify(corpo));
    const c = chamadas.find((x) => x.tabela === "sync_jobs");
    assert(c && filtroDono(c) === UID_A, "consulta sem filtro de dono");
  });
  t("E3. sync/status?loja_id=<loja de B> com sessao A -> 'idle' (igual a loja sem jobs)", async () => {
    reset();
    const r = await status.GET(req(`/api/sync/status?loja_id=${LOJA_B}`, { sessao: sessaoA }));
    const corpo = await r.json();
    assert(r.status === 200 && corpo.status === "idle", JSON.stringify(corpo));
  });
  t("E4. sync/status sem sessao -> 401 sem tocar no banco", async () => {
    reset();
    const r = await status.GET(req(`/api/sync/status?job_id=${JOB_B}`));
    assert(r.status === 401 && chamadas.length === 0, `status ${r.status}`);
  });

  // ══ F. backfill: operador, nao usuario comum ══════════════════════
  console.log("\n[F. backfill-resumos-diarios: sessao + CRON_SECRET]");
  const urlBackfill = `/api/admin/backfill-resumos-diarios?data=${DIA}`;
  t("F1. sem sessao -> 401, banco intocado", async () => {
    reset(); process.env.CRON_SECRET = "segredo-operador-teste";
    const r = await backfill.GET(req(urlBackfill, { authorization: "Bearer segredo-operador-teste" }));
    assert(r.status === 401 && chamadas.length === 0, `status ${r.status}, chamadas ${chamadas.length}`);
  });
  t("F2. usuario comum (sessao valida, sem segredo) -> 403, banco intocado", async () => {
    reset(); process.env.CRON_SECRET = "segredo-operador-teste";
    const r = await backfill.GET(req(urlBackfill, { sessao: sessaoA }));
    assert(r.status === 403 && chamadas.length === 0, `status ${r.status}, chamadas ${chamadas.length}`);
  });
  t("F3. segredo errado -> 403", async () => {
    reset(); process.env.CRON_SECRET = "segredo-operador-teste";
    const r = await backfill.GET(req(urlBackfill, { sessao: sessaoA, authorization: "Bearer outro" }));
    assert(r.status === 403 && chamadas.length === 0, `status ${r.status}`);
  });
  t("F4. CRON_SECRET ausente no servidor -> 403 mesmo com header (fail-closed)", async () => {
    reset(); delete process.env.CRON_SECRET;
    const r = await backfill.GET(req(urlBackfill, { sessao: sessaoA, authorization: "Bearer " }));
    assert(r.status === 403 && chamadas.length === 0, `status ${r.status}`);
  });
  t("F5. segredo so por header: ?secret= na query nao autoriza", async () => {
    reset(); process.env.CRON_SECRET = "segredo-operador-teste";
    const r = await backfill.GET(req(`${urlBackfill}&secret=segredo-operador-teste`, { sessao: sessaoA }));
    assert(r.status === 403, `status ${r.status}`);
  });
  t("F6. operador autorizado -> so as lojas do DONO da sessao sao recalculadas", async () => {
    reset(); process.env.CRON_SECRET = "segredo-operador-teste";
    const r = await backfill.GET(req(urlBackfill, { sessao: sessaoA, authorization: "Bearer segredo-operador-teste" }));
    const corpo = await r.json();
    assert(r.status === 200, `status ${r.status}`);
    const lojas = (corpo.resultado ?? []).map((x: any) => x.lojaId);
    assert(JSON.stringify(lojas) === JSON.stringify([LOJA_A]), `lojas: ${lojas}`);
    const escritas = chamadas.filter((c) => c.op !== "select");
    assert(escritas.every((c) => (c.payload as any)?.user_id === undefined || (c.payload as any).user_id === UID_A
      || (Array.isArray(c.payload) && (c.payload as any[]).every((p) => p.user_id === UID_A))), "escrita para outro dono");
    assert(!JSON.stringify(corpo).includes(LOJA_B), "loja de B no corpo");
    delete process.env.CRON_SECRET;
  });
  t("F7. o script de operador manda o segredo por header e exige CRON_SECRET", () => {
    const s = readFileSync(join(RAIZ, "scripts/backfill-resumos-diarios.mjs"), "utf8");
    assert(/authorization: `Bearer \$\{process\.env\.CRON_SECRET/.test(s), "sem header");
    assert(/if \(!process\.env\.CRON_SECRET\)/.test(s), "sem checagem de CRON_SECRET");
  });

  // ══ G. vendas-hoje ════════════════════════════════════════════════
  console.log("\n[G. ml/vendas-hoje: sessao obrigatoria]");
  t("G1. sem sessao -> 401, sem banco e sem chamada ao ML (mesmo com cookie ML)", async () => {
    reset();
    const r = await vendasHoje.GET(req("/api/ml/vendas-hoje", { extraCookie: "ml_access_token=tok" }));
    assert(r.status === 401, `status ${r.status}`);
    assert(chamadas.length === 0 && fetches.length === 0, `chamadas ${chamadas.length}, fetches ${fetches.length}`);
  });
  t("G2. sessao invalida (token adulterado) -> 401", async () => {
    reset();
    const r = await vendasHoje.GET(req("/api/ml/vendas-hoje", { sessao: sessaoA.slice(0, -2) + "xx", extraCookie: "ml_access_token=tok" }));
    assert(r.status === 401 && chamadas.length === 0, `status ${r.status}`);
  });
  t("G3. com sessao A (e ?user_id=B forjado): anuncios SEMPRE filtrados pelo dono da sessao", async () => {
    reset();
    const r = await vendasHoje.GET(req(`/api/ml/vendas-hoje?user_id=${UID_B}`, { sessao: sessaoA, extraCookie: "ml_access_token=tok" }));
    assert(r.status === 200, `status ${r.status}`);
    const c = chamadas.find((x) => x.tabela === "anuncios");
    assert(c && filtroDono(c) === UID_A, `filtro de dono: ${c && filtroDono(c)}`);
    const ups = chamadas.filter((x) => x.tabela === "vendas_dia");
    assert(ups.length === 1 && (ups[0].payload as any).anuncio_id === "anuncio-a", `upserts: ${JSON.stringify(ups.map((u) => u.payload))}`);
  });
  t("G4. fonte: sem filtro de dono condicional", () => {
    const s = fonte.get("app/api/ml/vendas-hoje/route.ts")!;
    assert(!/if \(userId\)/.test(s), "filtro ainda condicional");
    assert(/if \(!auth\.autenticado\) \{\s*return NextResponse\.json\(\{[^}]*\}, \{ status: 401 \}\)/.test(s), "sem 401");
  });

  // ══ H. motores de sync ════════════════════════════════════════════
  console.log("\n[H. motores de sync preservam loja<->usuario]");
  t("H1. sync-ml / sync-shopee: toda leitura de anuncios filtra por user_id", () => {
    for (const f of ["lib/sync-ml.ts", "lib/sync-shopee.ts"]) {
      const ls = fonte.get(f)!.split(/\r?\n/);
      ls.forEach((l, i) => {
        if (!/\.from\(\s*["']anuncios["']\s*\)/.test(l)) return;
        const cadeia = ls.slice(i, i + 10).join(" ");
        assert(/\.eq\(\s*["']user_id["']/.test(cadeia), `${f}:${i + 1} sem user_id`);
      });
    }
  });
  t("H2. worker interno resolve a credencial pelo PAR (loja_id, user_id), nunca so pela loja", () => {
    const s = readFileSync(join(RAIZ, "app/api/internal/sync/executar/route.ts"), "utf8");
    assert(/getShopeeLojaById\(\s*\w+,\s*\w+\s*\)/.test(s), "Shopee sem o par");
    assert(/x-worker-secret/.test(s), "sem segredo de worker");
  });
  t("H3. sync-shopee: leitura de pedidos por order_id sempre com user_id", () => {
    const ls = fonte.get("lib/sync-shopee.ts")!.split(/\r?\n/);
    ls.forEach((l, i) => {
      if (!/\.from\(\s*["']pedidos["']\s*\)/.test(l)) return;
      const cadeia = ls.slice(i, i + 8).join(" ");
      if (/\.in\(\s*["']order_id["']/.test(cadeia)) assert(/\.eq\(\s*["']user_id["']/.test(cadeia), `linha ${i + 1}`);
    });
  });

  // ══ I. Studio ═════════════════════════════════════════════════════
  console.log("\n[I. Studio: dono validado antes de operar]");
  t("I1. toda rota projetos/[id]/** valida o dono com buscarProjetoPorId(supabase(), userId, ...)", () => {
    for (const f of MIGRADOS.filter((x) => x.includes("/projetos/[id]"))) {
      assert(/buscarProjetoPorId\(\s*supabase\(\),\s*userId,/.test(fonte.get(f)!), `${f}: sem checagem de dono`);
    }
  });
  t("I2. libs do Studio continuam genericas (inalteradas desde a base)", () => {
    const d = git("diff", "--name-only", BASE, "--", "lib/estudio-anuncios").trim();
    assert(d === "", d);
  });

  // ══ J/K. escopo do gate ═══════════════════════════════════════════
  console.log("\n[J/K. escopo: browser, migrations, grants, RLS]");
  // SEC-3-B2 mudou de proposito as 4 telas de browser (a guarda completa
  // de browser fica em testar-sec3-b2-browser.ts). O que continua valendo
  // daqui: lib/supabase.ts intocado, e nenhum OUTRO arquivo de browser mudou.
  t("J1. lib/supabase.ts nao mudou", () => {
    const d = git("diff", "--name-only", BASE, "--", "lib/supabase.ts").trim();
    assert(d === "", d);
  });
  t("J2. os unicos arquivos 'use client' alterados sao as 4 telas do SEC-3-B2", () => {
    // SHOPEE MULTI-APP: a lista generica (BROWSER_PENDENTE) NAO muda; Configuracoes sai SO pela excecao exata
    const d = filtrarExcecaoShopeeUX(RAIZ, BASE, filtrarExcecaoShopeeMultiApp(RAIZ, BASE, git("diff", "--name-only", BASE, "--", "app", "components", "lib").split(/\r?\n/).filter(Boolean)));
    const cliente = d.filter((f) => fonte.has(f) && browser.has(f) && !BROWSER_PENDENTE.includes(f));
    assert(cliente.length === 0, cliente.join(", "));
  });
  // SEC-3-C: a migration de lockdown e a unica mudanca aprovada em
  // supabase/ (validada por scripts/testar-sec3-c-lockdown.ts).
  t("K1. nenhuma migration / arquivo em supabase/ mudou (alem da migration SEC-3-C)", () => {
    const d = git("diff", "--name-only", BASE, "--", "supabase").split(/\r?\n/)
      .filter((f) => f && !MIGRACOES_APROVADAS.includes(f));
    assert(d.length === 0, d.join(", "));
  });
  // ── K2: mudanca de banco no diff ──────────────────────────────────
  // As suites SEC-3 (esta e a do B2) CONTEM o proprio padrao de busca, e
  // por isso ficam fora — so elas. Todo o resto do diff (inclusive outros
  // scripts e arquivos novos ainda nao commitados) continua varrido.
  const EXCLUSAO_K2 = ":(exclude)scripts/testar-sec3-*.ts";
  // SEC-3-C: a migration de lockdown e a UNICA mudanca de banco aprovada;
  // ela e validada linha a linha por scripts/testar-sec3-c-lockdown.ts.
  // Qualquer outro GRANT/REVOKE/RLS/POLICY no diff continua reprovando.
  // S2-D1: a fundacao canonica Shopee e a segunda mudanca de banco
  // aprovada (validada por scripts/testar-s2d1-migracao.ts, que contem o
  // proprio padrao de busca e por isso tambem sai da varredura).
  // ML-CORPUS-A: o guard da foundation ML tambem contem o padrao de busca.
  const EXCLUSOES_APROVADAS = [...MIGRACOES_APROVADAS, "scripts/testar-s2d1-migracao.ts", "scripts/testar-ml-corpus-migracao.ts"].map((f) => `:(exclude)${f}`);
  const RE_MUDANCA_BANCO =
    /\b(GRANT|REVOKE)\s+\w+|\b(ENABLE|DISABLE|FORCE)\s+ROW\s+LEVEL\s+SECURITY|ROW LEVEL SECURITY|\b(CREATE|ALTER|DROP)\s+POLICY\b/i;
  /** Linhas ADICIONADAS (diff unificado) que mudam grant/RLS/policy. */
  const mudancasDeBanco = (diff: string) =>
    diff.split(/\r?\n/).filter((l) => l.startsWith("+") && !l.startsWith("+++") && RE_MUDANCA_BANCO.test(l));

  t("K2. nenhum GRANT/REVOKE/RLS/POLICY introduzido no diff (fora das suites SEC-3)", () => {
    const d = git("diff", BASE, "--", ".", EXCLUSAO_K2, ...EXCLUSOES_APROVADAS);
    const novos = git("ls-files", "--others", "--exclude-standard", "--", ".", EXCLUSAO_K2, ...EXCLUSOES_APROVADAS)
      .split(/\r?\n/).filter(Boolean);
    const diffNovos = novos.map((f) => readFileSync(join(RAIZ, f), "utf8").split(/\r?\n/).map((l) => `+${l}`).join("\n")).join("\n");
    const sql = [...mudancasDeBanco(d), ...mudancasDeBanco(diffNovos)];
    assert(sql.length === 0, sql.join(" | "));
  });
  t("K2a. auto-teste: o detector pega GRANT, REVOKE, ENABLE/DISABLE RLS e CREATE/ALTER/DROP POLICY", () => {
    const casos = [
      "+GRANT SELECT ON public.pedidos TO anon;",
      "+revoke all on public.anuncios from anon, authenticated;",
      "+ALTER TABLE public.pedidos ENABLE ROW LEVEL SECURITY;",
      "+alter table public.pedidos disable row level security;",
      "+ALTER TABLE public.pedidos FORCE ROW LEVEL SECURITY;",
      "+CREATE POLICY dono ON public.anuncios USING (true);",
      "+ALTER POLICY dono ON public.anuncios USING (false);",
      "+DROP POLICY dono ON public.anuncios;",
    ];
    for (const c of casos) assert(mudancasDeBanco(`diff --git a/x b/x\n${c}`).length === 1, `nao pegou: ${c}`);
    // linha removida ou de contexto nao conta como mudanca introduzida
    assert(mudancasDeBanco("-GRANT SELECT ON t TO anon;\n GRANT SELECT ON t TO anon;").length === 0, "contou linha nao adicionada");
  });
  t("K2b. auto-teste: a exclusao cobre SO as suites SEC-3 — o resto do diff continua varrido", () => {
    const todos = git("diff", "--name-only", BASE).split(/\r?\n/).filter(Boolean);
    const varridos = git("diff", "--name-only", BASE, "--", ".", EXCLUSAO_K2).split(/\r?\n/).filter(Boolean);
    const fora = todos.filter((f) => !varridos.includes(f));
    assert(fora.every((f) => /^scripts\/testar-sec3-[^/]+\.ts$/.test(f)), `excluido demais: ${fora.join(", ")}`);
    // as duas suites SEC-3 commitadas ficam fora (sem falso positivo)...
    for (const f of ["scripts/testar-sec3-b1-service-role.ts", "scripts/testar-sec3-b2-browser.ts"]) {
      if (todos.includes(f)) assert(!varridos.includes(f), `${f} ainda varrido`);
    }
    // ...e codigo de aplicacao e outros scripts continuam dentro.
    assert(varridos.some((f) => f.startsWith("app/")) && varridos.some((f) => f.startsWith("lib/")), "app/lib fora da varredura");
    assert(varridos.includes("scripts/testar-listagem-anuncios.ts"), "outros scripts fora da varredura");
  });

  await fila;
  console.log(`\n${falhou === 0 ? "✓" : "✗"} SEC-3-B1 — ${passou} passaram, ${falhou} falharam`);
  process.exit(falhou === 0 ? 0 : 1);
}

principal().catch((e) => { console.error("ERRO FATAL", e); process.exit(1); });
