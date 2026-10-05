/**
 * Suite da frente SEC-3-B2 — o browser não toca mais nenhuma das 15
 * tabelas SEC-3; anúncios e vendas do dia passam por `/api/anuncios/**`,
 * com o dono derivado da sessão e provado dentro de cada consulta.
 *
 * ── Guarda estática COMPLETA (SEC-3-B1 + B2) ────────────────────────
 *  SERVER_ANON_SEC3   : arquivo server-side que usa anon e toca uma das 15
 *  BROWSER_DIRECT_SEC3: arquivo alcançável de "use client" que faz
 *                       `.from("<uma das 15>")` (com qualquer cliente)
 * As duas têm de ser 0, e as duas são auto-testadas com violação sintética.
 *
 * ── Isolamento por dono (sem depender de RLS) ───────────────────────
 *  A. browser SEC-3 = 0          H. dashboard só do dono
 *  B. server anon SEC-3 = 0      I. whitelist de payload
 *  C. GET só do dono             J. browser nunca manda user_id
 *  D. POST nunca escolhe dono    K. loja/anúncio alheio recusado
 *  E. PATCH alheio = 404         L. backfill: escopo final só do dono
 *  F. soft delete alheio ignorado M. nenhuma migration/grant/RLS
 *  G. vendas_dia alheio = 404, nenhuma escrita
 *
 * Offline: banco, rede e credenciais são duplos. Nenhum segredo real.
 *
 * Uso: npx tsx scripts/testar-sec3-b2-browser.ts
 */
import "./_server-only-inerte";
import Module from "node:module";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname, normalize } from "node:path";

let passou = 0, falhou = 0;
let fila: Promise<void> = Promise.resolve();
function t(nome: string, fn: () => void | Promise<void>) {
  fila = fila.then(async () => {
    try { await fn(); passou++; console.log(`  PASS  ${nome}`); }
    catch (e: any) { falhou++; console.log(`  FALHA ${nome} -> ${e?.message ?? e}`); }
  });
}
function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://placeholder-de-teste.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "chave-de-teste-invalida";
process.env.SESSION_SECRET = "segredo-de-sessao-so-para-teste-0123456789abcdef";
process.env.CRON_SECRET = "segredo-operador-teste";

const RAIZ = join(__dirname, "..");
const BASE = "c075653";

const TABELAS_SEC3 = [
  "pedidos", "anuncios", "sync_jobs", "vendas_dia", "dashboard_resumos_diarios",
  "estudio_anuncios_conteudo_versoes", "estudio_anuncios_imagens_origem", "estudio_anuncios_jobs",
  "estudio_anuncios_pipeline", "estudio_anuncios_pipeline_catalogo", "estudio_anuncios_pipeline_catalogo_jobs",
  "estudio_anuncios_projetos", "estudio_anuncios_projetos_marketplace", "estudio_anuncios_resultados_pipeline",
  "estudio_anuncios_validacoes_publicacao",
];
const TELAS = [
  "app/(app)/anuncios/page.tsx",
  "app/(app)/anuncios/FormAnuncio.tsx",
  "app/(app)/anuncios/CardAnuncio.tsx",
  "app/(app)/dashboard/page.tsx",
];

// ─────────────────────────────────────────────────────────────────────
// Guarda estática completa
// ─────────────────────────────────────────────────────────────────────
const RE_TABELA = new RegExp(`\\.from\\(\\s*["'\`](${TABELAS_SEC3.join("|")})["'\`]\\s*\\)`, "g");
const RE_RPC_SEC3 = /\.rpc\(\s*["'`](claim_next_sync_job|criar_projeto_estudio_anuncios|estudio_anuncios_\w+)["'`]/g;

function usaAnon(fonte: string): boolean {
  return /NEXT_PUBLIC_SUPABASE_ANON_KEY/.test(fonte)
    || /import\s*\{[^}]*\bsupabase\b[^}]*\}\s*from\s+["'](?:@\/|(?:\.\.\/)+)lib\/supabase["']/.test(fonte);
}
function tabelasTocadas(fonte: string): string[] {
  const s = new Set<string>();
  for (const m of fonte.matchAll(RE_TABELA)) s.add(m[1]);
  for (const m of fonte.matchAll(RE_RPC_SEC3)) s.add(`rpc:${m[1]}`);
  return [...s];
}
type Contexto = "SERVER" | "BROWSER" | "TEST";
interface Violacao { regra: "SERVER_ANON_SEC3" | "BROWSER_DIRECT_SEC3"; arquivo: string; tabelas: string[] }

function guardaSec3(arquivos: Map<string, string>, contexto: (f: string) => Contexto): Violacao[] {
  const v: Violacao[] = [];
  for (const [f, s] of arquivos) {
    const ctx = contexto(f);
    if (ctx === "TEST") continue;
    const tabs = tabelasTocadas(s);
    if (tabs.length === 0) continue;
    if (ctx === "BROWSER") v.push({ regra: "BROWSER_DIRECT_SEC3", arquivo: f, tabelas: tabs });
    else if (usaAnon(s)) v.push({ regra: "SERVER_ANON_SEC3", arquivo: f, tabelas: tabs });
  }
  return v;
}

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: RAIZ, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
// `--others --exclude-standard`: arquivos novos ainda não commitados também entram.
const arquivosRepo = [...new Set(git("ls-files", "--cached", "--others", "--exclude-standard", "app", "lib", "components", "middleware.ts")
  .split(/\r?\n/).filter((f) => /\.(ts|tsx|js|mjs)$/.test(f)))];
const fonte = new Map(arquivosRepo.map((f) => [f, readFileSync(join(RAIZ, f), "utf8")]));

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

/** Código sem comentários — para checar o que o browser realmente envia. */
function semComentarios(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

// ─────────────────────────────────────────────────────────────────────
// Duplo do Supabase: banco em memória que APLICA os filtros eq/in em
// select, update e upsert — a resposta é a que o banco real daria.
// ─────────────────────────────────────────────────────────────────────
const UID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LOJA_A = "11111111-1111-4111-8111-111111111111";
const LOJA_B = "22222222-2222-4222-8222-222222222222";
const DIA = "2026-09-01";

interface Chamada { tabela: string; op: string; filtros: [string, string, unknown][]; payload?: any; colunas?: string; opcoes?: any }
let chamadas: Chamada[] = [];
let BANCO: Record<string, any[]> = {};
function bancoPadrao(): Record<string, any[]> {
  return {
    lojas: [
      { id: LOJA_A, user_id: UID_A, marketplace: "ML", nickname: "conta-a", ativo: true },
      { id: LOJA_B, user_id: UID_B, marketplace: "Shopee", nickname: "conta-b", ativo: true },
    ],
    anuncios: [
      { id: "an-a1", user_id: UID_A, ativo: true, nome: "A1", marketplace: "ML", created_at: "2026-09-02" },
      { id: "an-a2", user_id: UID_A, ativo: true, nome: "A2", marketplace: "Shopee", created_at: "2026-09-01" },
      { id: "an-a3", user_id: UID_A, ativo: false, nome: "A3-inativo", marketplace: "ML", created_at: "2026-09-01" },
      { id: "an-b1", user_id: UID_B, ativo: true, nome: "B1", marketplace: "ML", created_at: "2026-09-03" },
    ],
    vendas_dia: [],
    pedidos: [
      { id: "pa", user_id: UID_A, loja_id: LOJA_A, data_pagamento: DIA, data_criacao: DIA },
      { id: "pb", user_id: UID_B, loja_id: LOJA_B, data_pagamento: DIA, data_criacao: DIA },
    ],
    dashboard_resumos_diarios: [],
  };
}
function casa(l: any, filtros: [string, string, unknown][]) {
  return filtros.every(([tipo, col, v]) =>
    tipo === "eq" ? String(l[col]) === String(v)
      : tipo === "in" ? (v as unknown[]).map(String).includes(String(l[col]))
      : true);
}
function clienteFalso() {
  const cadeia = (tabela: string) => {
    const reg: Chamada = { tabela, op: "select", filtros: [] };
    const executar = () => {
      chamadas.push(reg);
      const linhas = BANCO[tabela] ??= [];
      if (reg.op === "insert") {
        const novo = { id: `novo-${linhas.length + 1}`, ...reg.payload };
        linhas.push(novo);
        return [novo];
      }
      if (reg.op === "upsert") {
        for (const p of [].concat(reg.payload)) linhas.push({ ...(p as object) });
        return [];
      }
      const alvo = linhas.filter((l) => casa(l, reg.filtros));
      if (reg.op === "update") for (const l of alvo) Object.assign(l, reg.payload);
      return alvo.map((l) => ({ ...l }));
    };
    const c: any = new Proxy({}, {
      get(_alvo, prop: string) {
        if (prop === "then") return (ok: any, erro: any) => {
          try { ok({ data: executar(), error: null }); } catch (e) { erro(e); }
        };
        if (prop === "maybeSingle" || prop === "single") return async () => ({ data: executar()[0] ?? null, error: null });
        return (...args: unknown[]) => {
          if (["insert", "update", "upsert", "delete"].includes(prop)) { reg.op = prop; reg.payload = args[0]; reg.opcoes = args[1]; }
          if (prop === "select" && reg.op === "select") reg.colunas = String(args[0] ?? "*");
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
(globalThis as any).fetch = async () => { throw new Error("rede proibida nesta suite"); };

let sessaoA = "";
function req(url: string, o: { sessao?: string; method?: string; body?: unknown; authorization?: string } = {}) {
  const headers: Record<string, string> = {};
  if (o.sessao) headers.cookie = `cds_session=${o.sessao}`;
  if (o.authorization) headers.authorization = o.authorization;
  if (o.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`https://exemplo.test${url}`, {
    method: o.method ?? "GET", headers,
    body: o.body === undefined ? undefined : typeof o.body === "string" ? o.body : JSON.stringify(o.body),
  });
}
function reset() { chamadas = []; BANCO = bancoPadrao(); }
const filtroDono = (c: Chamada) => c.filtros.find(([tipo, col]) => tipo === "eq" && col === "user_id")?.[2];
const escritas = () => chamadas.filter((c) => c.op !== "select");
const anuncio = (id: string) => BANCO.anuncios.find((a) => a.id === id);

const FORM_VALIDO = {
  nome: "Produto X", marketplace: "ML", categoria: null, tipo_anuncio: "Clássico", tipo_conta_shopee: null,
  custo_produto: 10, insumos: 0, custo_frete: 0, frete_gratis: false, imposto: 6, margem_desejada: 20,
  preco_ideal: null, preco_anuncio: 50, sku: "SKU1", peso_kg: null, ml_item_id: "MLB1", variation_id: null,
  thumbnail: null, permalink: null, ativo: true, logistic_type: "me2",
};

async function principal() {
  const { emitirTokenSessao } = await import("../lib/autenticacao");
  sessaoA = (await emitirTokenSessao(UID_A)).token;
  const servico = await import("../lib/anuncios/servico");
  const rotaLista = await import("../app/api/anuncios/route");
  const rotaId = await import("../app/api/anuncios/[id]/route");
  const rotaDesativar = await import("../app/api/anuncios/desativar/route");
  const rotaVendas = await import("../app/api/anuncios/[id]/vendas-dia/route");
  const backfill = await import("../app/api/admin/backfill-resumos-diarios/route");

  // ══ A/B. guarda completa ══════════════════════════════════════════
  console.log("\n[A/B. guarda SEC-3 completa]");
  t("A1. BROWSER_DIRECT_SEC3 = 0 e SERVER_ANON_SEC3 = 0 no repositorio", () => {
    const v = guardaSec3(fonte, contextoDe);
    assert(v.length === 0, v.map((x) => `${x.regra}: ${x.arquivo} -> ${x.tabelas.join(",")}`).join(" | "));
  });
  t("A2. auto-teste: arquivo de browser que faz .from('vendas_dia') e pego (arquivo + tabela)", () => {
    const v = guardaSec3(new Map([["app/(app)/x.tsx", `"use client";\nawait cli.from("vendas_dia").upsert({});`]]), () => "BROWSER");
    assert(v.length === 1 && v[0].regra === "BROWSER_DIRECT_SEC3" && v[0].arquivo === "app/(app)/x.tsx" && v[0].tabelas[0] === "vendas_dia", JSON.stringify(v));
  });
  t("A3. auto-teste: no browser, QUALQUER cliente conta (nao so o anon)", () => {
    const v = guardaSec3(new Map([["components/y.tsx", `outroCliente.from('anuncios').select('*')`]]), () => "BROWSER");
    assert(v.length === 1 && v[0].tabelas.includes("anuncios"), JSON.stringify(v));
  });
  t("A4. auto-teste: tabela fora da SEC-3 no browser nao e violacao", () => {
    const v = guardaSec3(new Map([["components/z.tsx", `cli.from("lojas_publicas").select("*")`]]), () => "BROWSER");
    assert(v.length === 0, JSON.stringify(v));
  });
  t("B1. auto-teste: server com anon tocando pedidos e pego como SERVER_ANON_SEC3", () => {
    const v = guardaSec3(new Map([["app/api/w/route.ts",
      `createClient(u, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!).from("pedidos").select("*")`]]), () => "SERVER");
    assert(v.length === 1 && v[0].regra === "SERVER_ANON_SEC3" && v[0].tabelas.includes("pedidos"), JSON.stringify(v));
  });
  t("B2. auto-teste: server com service_role nao e violacao", () => {
    const v = guardaSec3(new Map([["app/api/w/route.ts", `getSupabaseServidor().from("pedidos").select("*")`]]), () => "SERVER");
    assert(v.length === 0, JSON.stringify(v));
  });
  t("A5. as 4 telas continuam classificadas como BROWSER e nao importam cliente Supabase", () => {
    for (const f of TELAS) {
      assert(contextoDe(f) === "BROWSER", `${f}: ${contextoDe(f)}`);
      const s = fonte.get(f)!;
      assert(!/createClient/.test(s), `${f}: cria cliente`);
      assert(!usaAnon(s), `${f}: importa o cliente anon`);
    }
  });
  t("A6. nenhum arquivo alcancavel do browser importa o cliente anon como valor", () => {
    const ruins = [...browser].filter((f) => usaAnon(fonte.get(f)!) && f !== "lib/supabase.ts");
    assert(ruins.length === 0, ruins.join(", "));
  });
  t("A7. as rotas e o servico novos sao SERVER e usam o helper oficial", () => {
    for (const f of ["lib/anuncios/servico.ts", "app/api/anuncios/route.ts", "app/api/anuncios/[id]/route.ts",
                     "app/api/anuncios/desativar/route.ts", "app/api/anuncios/[id]/vendas-dia/route.ts"]) {
      assert(fonte.has(f), `${f} ausente`);
      assert(contextoDe(f) === "SERVER", `${f}: ${contextoDe(f)}`);
    }
    assert(/^import "server-only";/m.test(fonte.get("lib/anuncios/servico.ts")!), "servico sem server-only");
    for (const f of ["app/api/anuncios/route.ts", "app/api/anuncios/[id]/route.ts",
                     "app/api/anuncios/desativar/route.ts", "app/api/anuncios/[id]/vendas-dia/route.ts"]) {
      const s = fonte.get(f)!;
      assert(/return \(clienteServidor \?\?= getSupabaseServidor\(\)\);/.test(s), `${f}: sem helper`);
      assert(/autenticarRequisicao\(request\)/.test(s), `${f}: sem sessao`);
    }
  });

  // ══ C. GET ════════════════════════════════════════════════════════
  console.log("\n[C. GET /api/anuncios]");
  t("C1. sem sessao -> 401, banco intocado", async () => {
    reset();
    const r = await rotaLista.GET(req("/api/anuncios?de=0&ate=999"));
    assert(r.status === 401 && chamadas.length === 0, `status ${r.status}`);
  });
  t("C2. sessao A (com ?user_id=B forjado) -> so anuncios ATIVOS de A, na ordem da tela", async () => {
    reset();
    const r = await rotaLista.GET(req(`/api/anuncios?de=0&ate=999&user_id=${UID_B}`, { sessao: sessaoA }));
    const corpo = await r.json();
    const ids = corpo.anuncios.map((a: any) => a.id).sort();
    assert(r.status === 200 && JSON.stringify(ids) === JSON.stringify(["an-a1", "an-a2"]), JSON.stringify(ids));
    const c = chamadas.find((x) => x.tabela === "anuncios")!;
    assert(filtroDono(c) === UID_A, "filtro de dono");
  });
  t("C3. a projecao da tela NAO devolve user_id", async () => {
    reset();
    await rotaLista.GET(req("/api/anuncios?de=0&ate=999", { sessao: sessaoA }));
    const c = chamadas.find((x) => x.tabela === "anuncios")!;
    assert(c.colunas !== "*" && !/\buser_id\b/.test(c.colunas ?? ""), c.colunas ?? "");
  });
  t("C4. intervalo invalido ou maior que 1000 -> 400, banco intocado", async () => {
    for (const q of ["de=0&ate=1000", "de=5&ate=2", "de=-1&ate=10", "de=a&ate=b"]) {
      reset();
      const r = await rotaLista.GET(req(`/api/anuncios?${q}`, { sessao: sessaoA }));
      assert(r.status === 400 && chamadas.length === 0, `${q}: ${r.status}`);
    }
  });

  // ══ H. dashboard ══════════════════════════════════════════════════
  console.log("\n[H. dashboard]");
  // SEC-3-B3.3: as 8 colunas de antes menos `margem_contribuicao`, que não
  // existe na tabela (a consulta do dashboard já falhava em Production).
  t("H1. projecao=dashboard: so de A e com as 7 colunas reais de antes", async () => {
    reset();
    const r = await rotaLista.GET(req("/api/anuncios?projecao=dashboard&de=0&ate=999", { sessao: sessaoA }));
    const corpo = await r.json();
    assert(corpo.anuncios.every((a: any) => a.user_id === UID_A), "anuncio alheio");
    const c = chamadas.find((x) => x.tabela === "anuncios")!;
    assert(c.colunas === "ml_item_id, thumbnail, nome, sku, marketplace, custo_produto, preco_anuncio", c.colunas ?? "");
    assert(filtroDono(c) === UID_A, "filtro de dono");
  });
  t("H2. a tela do dashboard usa a API, sem user_id, mesma pagina unica 0..999", () => {
    const s = semComentarios(fonte.get("app/(app)/dashboard/page.tsx")!);
    assert(/fetch\("\/api\/anuncios\?projecao=dashboard&de=0&ate=999"\)/.test(s), "nao usa a API");
    assert(!/\.from\(\s*["'`]/.test(s), "ainda consulta tabela");
  });

  // ══ D/I/K. POST ═══════════════════════════════════════════════════
  console.log("\n[D/I/K. POST /api/anuncios]");
  t("D1. sem sessao -> 401, nenhuma escrita", async () => {
    reset();
    const r = await rotaLista.POST(req("/api/anuncios", { method: "POST", body: FORM_VALIDO }));
    assert(r.status === 401 && chamadas.length === 0, `status ${r.status}`);
  });
  t("D2. formulario valido -> 201 e o dono gravado e o da SESSAO", async () => {
    reset();
    const r = await rotaLista.POST(req("/api/anuncios", { sessao: sessaoA, method: "POST", body: FORM_VALIDO }));
    assert(r.status === 201, `status ${r.status}`);
    const ins = escritas();
    assert(ins.length === 1 && ins[0].op === "insert" && ins[0].payload.user_id === UID_A, JSON.stringify(ins));
  });
  t("D3/K1. body com user_id de B -> 400, nenhuma escrita (dono nao e escolhido pelo browser)", async () => {
    reset();
    const r = await rotaLista.POST(req("/api/anuncios", { sessao: sessaoA, method: "POST", body: { ...FORM_VALIDO, user_id: UID_B } }));
    assert(r.status === 400 && escritas().length === 0, `status ${r.status}`);
  });
  t("K2. body com loja_id de B -> 400, nenhuma escrita", async () => {
    reset();
    const r = await rotaLista.POST(req("/api/anuncios", { sessao: sessaoA, method: "POST", body: { ...FORM_VALIDO, loja_id: LOJA_B } }));
    assert(r.status === 400 && escritas().length === 0, `status ${r.status}`);
  });
  t("I1. whitelist: id/created_at/campo desconhecido -> recusados", () => {
    for (const extra of [{ id: "x" }, { created_at: "2020-01-01" }, { coluna_nova: 1 }, { user_id: UID_A }]) {
      const r = servico.montarCamposGravaveis({ ...FORM_VALIDO, ...extra }, false);
      assert(!r.ok, `aceitou ${Object.keys(extra)[0]}`);
    }
  });
  t("I2. whitelist: tipos validados (marketplace, numero, booleano)", () => {
    for (const ruim of [{ marketplace: "Amazon" }, { custo_produto: "10" }, { custo_produto: Infinity }, { frete_gratis: "sim" }, { nome: 5 }]) {
      const r = servico.montarCamposGravaveis({ ...FORM_VALIDO, ...ruim }, false);
      assert(!r.ok, `aceitou ${JSON.stringify(ruim)}`);
    }
    assert(!servico.montarCamposGravaveis({ nome: "x" }, false).ok, "criacao sem obrigatorios");
    assert(!servico.montarCamposGravaveis({}, true).ok, "edicao vazia");
    assert(!servico.montarCamposGravaveis([1], false).ok, "array como corpo");
  });
  t("I3. o objeto gravado tem EXATAMENTE os campos da whitelist + user_id", async () => {
    reset();
    await rotaLista.POST(req("/api/anuncios", { sessao: sessaoA, method: "POST", body: FORM_VALIDO }));
    const chaves = Object.keys(escritas()[0].payload).sort();
    const esperado = [...Object.keys(FORM_VALIDO), "user_id"].sort();
    assert(JSON.stringify(chaves) === JSON.stringify(esperado), chaves.join(","));
    assert(Object.keys(FORM_VALIDO).every((k) => k in servico.CAMPOS_GRAVAVEIS), "form fora da whitelist");
  });
  t("I4. JSON invalido -> 400", async () => {
    reset();
    const r = await rotaLista.POST(req("/api/anuncios", { sessao: sessaoA, method: "POST", body: "{nao-json" }));
    assert(r.status === 400 && chamadas.length === 0, `status ${r.status}`);
  });

  // ══ E. PATCH ══════════════════════════════════════════════════════
  console.log("\n[E. PATCH /api/anuncios/[id]]");
  t("E1. anuncio de B com sessao A -> 404 e B intacto; escrita com id E user_id", async () => {
    reset();
    const r = await rotaId.PATCH(req("/api/anuncios/an-b1", { sessao: sessaoA, method: "PATCH", body: { nome: "sequestrado" } }), { params: { id: "an-b1" } });
    assert(r.status === 404, `status ${r.status}`);
    assert(anuncio("an-b1").nome === "B1", "anuncio de B foi alterado");
    const u = escritas()[0];
    assert(u && u.filtros.some(([t2, c, v]) => t2 === "eq" && c === "id" && v === "an-b1") && filtroDono(u) === UID_A, JSON.stringify(u?.filtros));
  });
  t("E2. anuncio inexistente responde IGUAL ao alheio (nao revela existencia)", async () => {
    reset();
    const alheio = await rotaId.PATCH(req("/api/anuncios/an-b1", { sessao: sessaoA, method: "PATCH", body: { nome: "x" } }), { params: { id: "an-b1" } });
    reset();
    const inexistente = await rotaId.PATCH(req("/api/anuncios/nao-existe", { sessao: sessaoA, method: "PATCH", body: { nome: "x" } }), { params: { id: "nao-existe" } });
    assert(alheio.status === inexistente.status, `${alheio.status} vs ${inexistente.status}`);
    assert(JSON.stringify(await alheio.json()) === JSON.stringify(await inexistente.json()), "corpos diferentes");
  });
  t("E3. anuncio proprio -> 200 e alterado", async () => {
    reset();
    const r = await rotaId.PATCH(req("/api/anuncios/an-a1", { sessao: sessaoA, method: "PATCH", body: { nome: "novo nome", preco_anuncio: 60 } }), { params: { id: "an-a1" } });
    assert(r.status === 200 && anuncio("an-a1").nome === "novo nome", `status ${r.status}`);
  });
  t("E4. PATCH nao pode trocar o dono (user_id no body -> 400, nada escrito)", async () => {
    reset();
    const r = await rotaId.PATCH(req("/api/anuncios/an-a1", { sessao: sessaoA, method: "PATCH", body: { user_id: UID_B } }), { params: { id: "an-a1" } });
    assert(r.status === 400 && escritas().length === 0 && anuncio("an-a1").user_id === UID_A, `status ${r.status}`);
  });
  t("E5. sem sessao -> 401", async () => {
    reset();
    const r = await rotaId.PATCH(req("/api/anuncios/an-a1", { method: "PATCH", body: { nome: "x" } }), { params: { id: "an-a1" } });
    assert(r.status === 401 && chamadas.length === 0, `status ${r.status}`);
  });

  // ══ F. soft delete ════════════════════════════════════════════════
  console.log("\n[F. POST /api/anuncios/desativar]");
  t("F1. lote [A, B] com sessao A -> so A confirmado e desativado; B segue ativo", async () => {
    reset();
    const r = await rotaDesativar.POST(req("/api/anuncios/desativar", { sessao: sessaoA, method: "POST", body: { ids: ["an-a1", "an-b1"] } }));
    const corpo = await r.json();
    assert(r.status === 200 && JSON.stringify(corpo.ids) === JSON.stringify(["an-a1"]), JSON.stringify(corpo));
    assert(anuncio("an-a1").ativo === false && anuncio("an-b1").ativo === true, "estado errado");
    const u = escritas()[0];
    assert(u.op === "update" && JSON.stringify(u.payload) === JSON.stringify({ ativo: false }) && filtroDono(u) === UID_A, JSON.stringify(u));
  });
  t("F2. so soft delete: nenhuma operacao delete, nenhuma linha removida", async () => {
    reset();
    await rotaDesativar.POST(req("/api/anuncios/desativar", { sessao: sessaoA, method: "POST", body: { ids: ["an-a1"] } }));
    assert(!chamadas.some((c) => c.op === "delete") && BANCO.anuncios.length === 4, "delete fisico");
  });
  t("F3. lote acima de 200, vazio, ou com chave extra (user_id) -> 400", async () => {
    for (const body of [{ ids: Array.from({ length: 201 }, (_, i) => `x${i}`) }, { ids: [] }, { ids: ["an-a1"], user_id: UID_B }, { ids: [5] }]) {
      reset();
      const r = await rotaDesativar.POST(req("/api/anuncios/desativar", { sessao: sessaoA, method: "POST", body }));
      assert(r.status === 400 && escritas().length === 0, `${JSON.stringify(body).slice(0, 40)}: ${r.status}`);
    }
  });
  t("F4. sem sessao -> 401", async () => {
    reset();
    const r = await rotaDesativar.POST(req("/api/anuncios/desativar", { method: "POST", body: { ids: ["an-a1"] } }));
    assert(r.status === 401 && chamadas.length === 0, `status ${r.status}`);
  });

  // ══ G. vendas_dia ═════════════════════════════════════════════════
  console.log("\n[G. POST /api/anuncios/[id]/vendas-dia]");
  const VENDA = { unidades_vendidas: 2, faturamento: 100, lucro: 20 };
  t("G1. anuncio de B com sessao A -> 404 e NENHUMA escrita em vendas_dia", async () => {
    reset();
    const r = await rotaVendas.POST(req("/api/anuncios/an-b1/vendas-dia", { sessao: sessaoA, method: "POST", body: VENDA }), { params: { id: "an-b1" } });
    assert(r.status === 404, `status ${r.status}`);
    assert(escritas().length === 0 && BANCO.vendas_dia.length === 0, "escreveu");
    const prova = chamadas.find((c) => c.tabela === "anuncios")!;
    assert(filtroDono(prova) === UID_A, "prova de posse sem dono");
  });
  t("G2. anuncio proprio -> upsert com anuncio_id, data do servidor e a mesma chave de conflito", async () => {
    reset();
    const r = await rotaVendas.POST(req("/api/anuncios/an-a1/vendas-dia", { sessao: sessaoA, method: "POST", body: VENDA }), { params: { id: "an-a1" } });
    assert(r.status === 200, `status ${r.status}`);
    const up = escritas()[0];
    assert(up.tabela === "vendas_dia" && up.op === "upsert" && up.opcoes?.onConflict === "anuncio_id,data", JSON.stringify(up));
    assert(up.payload.anuncio_id === "an-a1" && /^\d{4}-\d{2}-\d{2}$/.test(up.payload.data), JSON.stringify(up.payload));
  });
  t("G3. browser nao escolhe a data nem o anuncio pelo corpo (chave extra -> 400)", async () => {
    for (const body of [{ ...VENDA, data: "2020-01-01" }, { ...VENDA, anuncio_id: "an-b1" }, { ...VENDA, unidades_vendidas: 0 }]) {
      reset();
      const r = await rotaVendas.POST(req("/api/anuncios/an-a1/vendas-dia", { sessao: sessaoA, method: "POST", body }), { params: { id: "an-a1" } });
      assert(r.status === 400 && escritas().length === 0, `${JSON.stringify(body)}: ${r.status}`);
    }
  });
  t("G4. sem sessao -> 401", async () => {
    reset();
    const r = await rotaVendas.POST(req("/api/anuncios/an-a1/vendas-dia", { method: "POST", body: VENDA }), { params: { id: "an-a1" } });
    assert(r.status === 401 && chamadas.length === 0, `status ${r.status}`);
  });

  // ══ J. browser nunca manda user_id ════════════════════════════════
  console.log("\n[J. o browser nao decide o dono]");
  t("J1. nenhuma das 4 telas envia user_id (codigo, sem comentarios)", () => {
    for (const f of TELAS) {
      const s = semComentarios(fonte.get(f)!);
      assert(!/user_id/.test(s), `${f} ainda menciona user_id no codigo`);
    }
  });
  t("J2. as telas falam so com /api/anuncios/** para estas operacoes", () => {
    const s = (f: string) => semComentarios(fonte.get(f)!);
    assert(/\/api\/anuncios\?de=/.test(s("app/(app)/anuncios/page.tsx")), "lista");
    assert(/\/api\/anuncios\/desativar/.test(s("app/(app)/anuncios/page.tsx")), "soft delete");
    assert(/"\/api\/anuncios"/.test(s("app/(app)/anuncios/FormAnuncio.tsx")) && /method: idExistente \? "PATCH" : "POST"/.test(s("app/(app)/anuncios/FormAnuncio.tsx")), "form");
    assert(/\/vendas-dia`/.test(s("app/(app)/anuncios/CardAnuncio.tsx")), "card");
  });

  // ══ L. backfill ═══════════════════════════════════════════════════
  console.log("\n[L. backfill: lojas de varios tenants na consulta intermediaria]");
  t("L1. pedidos de A e B no dia -> resumos gravados SO para lojas/dono de A", async () => {
    reset();
    const r = await backfill.GET(req(`/api/admin/backfill-resumos-diarios?data=${DIA}`, { sessao: sessaoA, authorization: "Bearer segredo-operador-teste" }));
    assert(r.status === 200, `status ${r.status}`);
    // A consulta intermediaria de fato viu os dois tenants...
    const intermediaria = chamadas.filter((c) => c.tabela === "pedidos" && c.op === "select" && !filtroDono(c));
    assert(intermediaria.length > 0, "cenario nao exercitou a consulta global");
    // ...mas toda escrita ficou com A.
    const resumos = escritas().filter((c) => c.tabela === "dashboard_resumos_diarios");
    assert(resumos.length > 0, "nenhum resumo gravado");
    for (const w of resumos) for (const p of [].concat(w.payload) as any[]) {
      assert(p.user_id === UID_A && p.loja_id === LOJA_A, `escrita fora do dono: ${JSON.stringify(p)}`);
    }
    assert(escritas().every((c) => c.tabela === "dashboard_resumos_diarios"), "escreveu em outra tabela");
    const corpo = await r.json();
    assert(!JSON.stringify(corpo).includes(LOJA_B), "loja de B na resposta");
  });

  // ══ M. escopo ═════════════════════════════════════════════════════
  console.log("\n[M. nenhuma migration / grant / RLS]");
  // SEC-3-C: a migration de lockdown e a unica mudanca aprovada em
  // supabase/ (validada por scripts/testar-sec3-c-lockdown.ts).
  // S2-D1: segunda mudanca aprovada (guard proprio: testar-s2d1-migracao,
  // que contem o padrao de busca e por isso tambem sai da varredura).
  const APROVADAS = [
    "supabase/migrations/20261026_sec3c_lockdown_tabelas_publicas.sql",
    "supabase/migrations/20261027_s2d1_shopee_pedidos_canonico.sql",
  ];
  const FORA_DA_VARREDURA = [...APROVADAS, "scripts/testar-s2d1-migracao.ts"];
  t("M1. nada em supabase/ mudou desde a base (alem da migration SEC-3-C)", () => {
    const d = git("diff", "--name-only", BASE, "--", "supabase").split(/\r?\n/).filter((f) => f && !APROVADAS.includes(f));
    const novos = git("ls-files", "--others", "--exclude-standard", "supabase").split(/\r?\n/).filter((f) => f && !APROVADAS.includes(f));
    assert(d.length === 0 && novos.length === 0, `${d} ${novos}`);
  });
  t("M2. nenhum GRANT/REVOKE/RLS/POLICY introduzido", () => {
    const d = git("diff", BASE, "--", ".", ":(exclude)scripts/testar-sec3-*.ts", ...FORA_DA_VARREDURA.map((f) => `:(exclude)${f}`));
    const novos = git("ls-files", "--others", "--exclude-standard").split(/\r?\n/)
      .filter((f) => f && !/^scripts\/testar-sec3-/.test(f) && !FORA_DA_VARREDURA.includes(f));
    const linhas = [
      ...d.split(/\r?\n/).filter((l) => l.startsWith("+") && !l.startsWith("+++")),
      ...novos.flatMap((f) => readFileSync(join(RAIZ, f), "utf8").split(/\r?\n/)),
    ];
    const sql = linhas.filter((l) => /\b(GRANT|REVOKE)\s+\w+|ROW LEVEL SECURITY|CREATE POLICY/i.test(l));
    assert(sql.length === 0, sql.join(" | "));
  });

  await fila;
  console.log(`\n${falhou === 0 ? "✓" : "✗"} SEC-3-B2 — ${passou} passaram, ${falhou} falharam`);
  process.exit(falhou === 0 ? 0 : 1);
}

principal().catch((e) => { console.error("ERRO FATAL", e); process.exit(1); });
