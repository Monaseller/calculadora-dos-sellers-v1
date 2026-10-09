/**
 * SALES-SYNC-D8.2 — auth das rotas canonicas: CRON_SECRET (Vercel Cron) OU
 * CANONICAL_SALES_SYNC_MANUAL_SECRET (manual), so nas duas rotas (offline).
 *
 * Sem rede, sem banco real: `fetch` e armadilha e o env do Supabase aponta
 * para um host invalido. As rotas reais sao chamadas em processo (CRON_SECRET,
 * segredo manual e flag sao lidos a cada request). Com auth valida + flag ON,
 * "entrou no fluxo" = 500 generico ao criar o cliente — nenhuma rede.
 *
 * Uso: npx tsx scripts/testar-vendas-sync-auth-interna.ts
 */
import "./_server-only-inerte";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { varsEnvExemploAprovadas } from "./_excecao-shopee-multi-app";
// CDS GUARD V2 (Fase 0B): invariantes estruturais + zonas protegidas no lugar da cerca "arquivo nao mudou desde a base"
import { invariantesV2 } from "./_guard-v2";

let passou = 0, falhou = 0;
let fila: Promise<void> = Promise.resolve();
function t(nome: string, fn: () => void | Promise<void>) {
  fila = fila.then(async () => {
    try { await fn(); passou++; console.log(`  PASS  ${nome}`); }
    catch (e: any) { falhou++; console.log(`  FALHA ${nome} -> ${e?.stack?.split("\n").slice(0, 2).join(" | ") ?? e}`); }
  });
}
function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const RAIZ = join(__dirname, "..");
const BASE = "a0875c4";
const CRON = "cron-test-d82-11aa", MANUAL = "manual-test-d82-22bb";
const ROTAS = ["app/api/internal/vendas-sync/coordenador/route.ts", "app/api/internal/vendas-sync/worker/route.ts"];
const HELPER = "lib/vendas/sync/auth-interna.ts";

let fetches = 0;
(globalThis as any).fetch = async () => { fetches++; throw new Error("rede proibida"); };
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://placeholder.invalid";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "placeholder";
delete process.env.SUPABASE_SERVICE_ROLE_KEY;   // cliente service_role falha FECHADO se chegar a ser criado

type Env = { cron?: string; manual?: string; flag?: string };
function comEnv(e: Env) {
  const set = (k: string, v?: string) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  set("CRON_SECRET", e.cron); set("CANONICAL_SALES_SYNC_MANUAL_SECRET", e.manual); set("ENABLE_CANONICAL_SALES_SYNC", e.flag);
}

async function principal() {
  const C = await import("../app/api/internal/vendas-sync/coordenador/route");
  const W = await import("../app/api/internal/vendas-sync/worker/route");
  const H = await import("../lib/vendas/sync/auth-interna");
  const saidas: string[] = [];
  const log0 = console.log, err0 = console.error;
  const capturar = async <X>(fn: () => Promise<X>) => { console.log = (...a: unknown[]) => { saidas.push(a.map(String).join(" ")); }; console.error = console.log;
    try { return await fn(); } finally { console.log = log0; console.error = err0; } };
  const chamar = async (R: any, p: string, h?: string) => capturar(async () => {
    const r = await R.GET(new Request(`http://x/api/internal/vendas-sync/${p}`, { headers: h ? { authorization: h } : {} }));
    const corpo = await r.json(); saidas.push(JSON.stringify(corpo));
    return { status: r.status as number, corpo };
  });
  const ambas = async (h?: string) => [await chamar(C, "coordenador", h), await chamar(W, "worker", h)];
  const nega = (r: any) => r.status === 401 && r.corpo.erro === "nao_autorizado";
  const desab = (r: any) => r.status === 200 && r.corpo.resultado === "DESABILITADO";
  const fluxo = (r: any) => r.status === 500 && r.corpo.erro === "falha_interna";

  console.log("\n[1-5. contrato de auth]");
  t("1. nenhum segredo configurado → 401 (com qualquer header, inclusive os 'certos')", async () => {
    comEnv({ flag: "true" });
    for (const h of [undefined, "Bearer ", `Bearer ${CRON}`, `Bearer ${MANUAL}`, "Bearer undefined"]) for (const r of await ambas(h)) assert(nega(r), `${h}: ${JSON.stringify(r)}`);
  });
  t("2. header ausente / errado / parcial / sem 'Bearer ' / com sobra / minusculo → 401", async () => {
    comEnv({ cron: CRON, manual: MANUAL, flag: "true" });
    // (espaco nas PONTAS do valor e removido pela propria API Headers/Fetch — mesmo comportamento da guarda anterior)
    for (const h of [undefined, "", "Bearer errado", CRON, MANUAL, `Bearer ${CRON.slice(0, -1)}`, `Bearer ${CRON}x`, `Bearer  ${CRON}`, `bearer ${CRON}`, `Bearer ${MANUAL}x`, `Basic ${MANUAL}`, `Bearer ${CRON},Bearer ${MANUAL}`])
      for (const r of await ambas(h)) assert(nega(r), `${JSON.stringify(h)} passou: ${JSON.stringify(r)}`);
  });
  t("3/11. CRON_SECRET correto → autorizado (Vercel Cron continua compativel), com ou sem segredo manual", async () => {
    for (const manual of [undefined, MANUAL]) { comEnv({ cron: CRON, manual, flag: "true" }); for (const r of await ambas(`Bearer ${CRON}`)) assert(fluxo(r), `manual=${manual}: ${JSON.stringify(r)}`); }
  });
  t("4/12. segredo MANUAL correto → autorizado", async () => {
    comEnv({ cron: CRON, manual: MANUAL, flag: "true" });
    for (const r of await ambas(`Bearer ${MANUAL}`)) assert(fluxo(r), JSON.stringify(r));
  });
  t("5. os dois configurados → qualquer um correto autoriza; manual vazio NAO vira 'Bearer ' valido", async () => {
    comEnv({ cron: CRON, manual: MANUAL, flag: "true" });
    for (const h of [`Bearer ${CRON}`, `Bearer ${MANUAL}`]) for (const r of await ambas(h)) assert(fluxo(r), h);
    comEnv({ cron: CRON, manual: "", flag: "true" });
    for (const r of await ambas("Bearer ")) assert(nega(r), "manual vazio aceitou 'Bearer '");
  });
  t("CRON_SECRET ausente → 401 mesmo com o manual correto (ancora fail-closed do invariante 38)", async () => {
    comEnv({ manual: MANUAL, flag: "true" });
    for (const r of await ambas(`Bearer ${MANUAL}`)) assert(nega(r), JSON.stringify(r));
  });

  console.log("\n[6-9. auth ANTES da flag; flag OFF = zero atividade]");
  t("6/7. flag OFF depois de auth valida (CRON ou manual) → 200 DESABILITADO; sem auth → 401 mesmo OFF", async () => {
    for (const flag of [undefined, "false"]) {
      comEnv({ cron: CRON, manual: MANUAL, flag });
      for (const h of [`Bearer ${CRON}`, `Bearer ${MANUAL}`]) for (const r of await ambas(h)) assert(desab(r), `${flag} ${h}: ${JSON.stringify(r)}`);
      for (const r of await ambas("Bearer errado")) assert(nega(r), "auth depois da flag");
      for (const r of await ambas()) assert(nega(r), "sem header passou com flag OFF");
    }
  });
  t("8/9. flag OFF: coordenador e worker com contadores zero e sem tentar cliente/rede", async () => {
    comEnv({ cron: CRON, manual: MANUAL, flag: "false" });
    const f0 = fetches;
    const [c, w] = await ambas(`Bearer ${MANUAL}`);
    assert(c.corpo.lojasAvaliadas === 0 && c.corpo.jobsCriados === 0 && c.corpo.resultados.length === 0, JSON.stringify(c));
    assert(w.corpo.recuperados === 0 && w.corpo.job_id === undefined, JSON.stringify(w));
    assert(fetches === f0, "fetch com flag OFF");
  });

  console.log("\n[10. escopo do segredo manual]");
  t("10. o segredo manual NAO autentica /api/sync nem os crons de agentes/estudio (runtime)", async () => {
    comEnv({ cron: CRON, manual: MANUAL });
    const alvos: [string, string][] = [["../app/api/sync/route", "sync"], ["../app/api/internal/agentes/worker/route", "agentes/worker"],
      ["../app/api/internal/estudio-anuncios/worker/route", "estudio-anuncios/worker"], ["../app/api/internal/agentes/monitor-ingestao/route", "agentes/monitor-ingestao"]];
    // essas rotas criam cliente no IMPORT: chave placeholder so aqui (a armadilha de fetch segue ativa)
    process.env.SUPABASE_SERVICE_ROLE_KEY = "placeholder";
    for (const [mod, p] of alvos) {
      const R: any = await capturar(() => import(mod));
      const r = await capturar(async () => R.GET(new Request(`http://x/api/${p}`, { headers: { authorization: `Bearer ${MANUAL}` } })));
      assert(r.status === 401, `${p} aceitou o segredo manual: ${r.status}`);
    }
  });
  t("10b. so o helper e as duas rotas mencionam o segredo manual / o helper (texto, app/ + lib/)", () => {
    const arquivos = (d: string): string[] => readdirSync(join(RAIZ, d)).flatMap((n) => { const p = `${d}/${n}`; return statSync(join(RAIZ, p)).isDirectory() ? arquivos(p) : /\.(tsx?|jsx?)$/.test(n) ? [p] : []; });
    const usam = [...arquivos("app"), ...arquivos("lib")].filter((f) => /CANONICAL_SALES_SYNC_MANUAL_SECRET|auth-interna|cabecalhoEsperadoSalesSync/.test(readFileSync(join(RAIZ, f), "utf8")) && f !== HELPER);
    assert(usam.sort().join() === [...ROTAS].sort().join(), `fora do escopo: ${usam}`);
  });

  console.log("\n[11-12. client / vazamento / forma]");
  t("11. helper server-only; nenhum client component importa; nada NEXT_PUBLIC", () => {
    const h = readFileSync(join(RAIZ, HELPER), "utf8");
    assert(/^import "server-only";$/m.test(h) && !/NEXT_PUBLIC/.test(h.replace(/\/\*[\s\S]*?\*\//g, "")), "helper");
    for (const f of ROTAS) assert(!/^["']use client["']/m.test(readFileSync(join(RAIZ, f), "utf8")), f);
  });
  t("12. nenhum segredo em resposta ou log (todas as chamadas desta suite); helper nao loga", () => {
    const tudo = saidas.join("\n");
    assert(saidas.length > 40, `poucas saidas capturadas: ${saidas.length}`);
    assert(!tudo.includes(CRON) && !tudo.includes(MANUAL), "segredo vazou em resposta/log");
    assert(!/console\./.test(readFileSync(join(RAIZ, HELPER), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")), "helper loga");
  });
  t("forma: guarda padrao (invariante 38) com o helper; CRON_SECRET lido na rota; auth antes da flag; sem query/cookie", () => {
    for (const f of ROTAS) {
      const s = readFileSync(join(RAIZ, f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
      assert(/const segredo = process\.env\.CRON_SECRET;/.test(s) && /const auth = request\.headers\.get\("authorization"\);/.test(s), `${f}: leitura`);
      assert(/if \(!segredo \|\| !auth \|\| auth !== cabecalhoEsperadoSalesSync\(auth, segredo\)\) \{/.test(s), `${f}: guarda`);
      assert(s.indexOf("cabecalhoEsperadoSalesSync(auth, segredo)") < s.indexOf("syncCanonicoVendasHabilitado()"), `${f}: flag antes da auth`);
      assert(!/searchParams|cookies|nextUrl/.test(s), `${f}: le query/cookie`);
    }
    assert(H.cabecalhoEsperadoSalesSync("Bearer x", "c") === "Bearer c", "fallback nao e o do cron");
  });
  t("escopo V2: toda rota interna exige segredo (I4) + invariantes estruturais e zonas protegidas; .env.example so acrescenta o segredo manual", () => {
    const errosV2 = invariantesV2(RAIZ);
    assert(errosV2.length === 0, `escopo: ${errosV2.join(" | ")}`);
    const dc = execFileSync("git", ["diff", "-U0", BASE, "--", ".env.example"], { cwd: RAIZ, encoding: "utf8" }).split(/\r?\n/);
    const add = dc.filter((l) => l.startsWith("+") && !l.startsWith("+++")), rem = dc.filter((l) => l.startsWith("-") && !l.startsWith("---"));
    // SHOPEE MULTI-APP: SO os dois nomes VAZIOS do app rd, e SO com .env.example exato (helper)
    const aprovadasMultiApp = varsEnvExemploAprovadas(RAIZ);
    assert(rem.length === 0 && add.filter((l) => /^\+[A-Z_]+=/.test(l) && !aprovadasMultiApp.includes(l)).join() === "+CANONICAL_SALES_SYNC_MANUAL_SECRET=", ".env.example com valor/variavel extra");
  });

  await fila;
  console.log(`\n${falhou === 0 ? "✓" : "✗"} VENDAS-SYNC-AUTH-INTERNA — ${passou} passaram, ${falhou} falharam`);
  process.exit(falhou === 0 ? 0 : 1);
}
principal().catch((e) => { console.error(e); process.exit(1); });
