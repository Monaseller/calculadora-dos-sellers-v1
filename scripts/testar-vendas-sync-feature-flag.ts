/**
 * SALES-SYNC-D6 — flag server-only da automacao canonica, desacoplada da flag publica da Vendas (offline).
 *
 * Sem rede, sem banco real. A matriz 2×2 (flag publica antiga × flag canonica
 * nova) roda em PROCESSOS FILHOS deste mesmo arquivo (MODO_SONDA): a flag
 * publica e uma constante de modulo (lib/feature-flags.ts), fixada no import.
 * Nos filhos o env do Supabase e esvaziado e `fetch` e uma armadilha — uma rota
 * canonica LIGADA prova que entrou no fluxo ao falhar FECHADO na criacao do
 * cliente (500 generico), sem nenhuma rede.
 *
 * Uso: npx tsx scripts/testar-vendas-sync-feature-flag.ts
 */
import "./_server-only-inerte";
import { execFileSync } from "node:child_process";
// SALES-CANONICAL-D13A: excecao minima e exata (capability owner-scoped + arquivos novos do D13)
import { filtrarExcecaoD13 } from "./_excecao-d13-vendas-canonicas";
// SALES-CANONICAL-D14B: excecao EXATA do patch D14 nos leitores (ATUAL − patch aprovado = bytes de 1c4fe29)
import { filtrarExcecaoD14 } from "./_excecao-d14-vendas-canonicas";
// SALES-SYNC-D15B2: excecao EXATA do patch D15B nos arquivos de sync (ATUAL − patch aprovado = bytes de d631748)
import { filtrarExcecaoD15B } from "./_excecao-d15b-intraday";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const RAIZ = join(__dirname, "..");
const BASE = "43cd394";
const SEG = "segredo-d6-NAO-VAZA-77aa";

// ── modo sonda (processo filho): chama as DUAS rotas reais e devolve o que viu ──
if (process.env.MODO_SONDA === "1") {
  (async () => {
    let fetches = 0;
    (globalThis as any).fetch = async () => { fetches++; throw new Error("rede proibida"); };
    const saidas: string[] = []; const log = console.log, err = console.error;
    console.log = (...a: unknown[]) => { saidas.push(a.map(String).join(" ")); }; console.error = console.log;
    const FF = await import("../lib/feature-flags");
    const C = await import("../app/api/internal/vendas-sync/coordenador/route");
    const W = await import("../app/api/internal/vendas-sync/worker/route");
    const req = (p: string, h?: string) => new Request(`http://x/api/internal/vendas-sync/${p}`, { headers: h ? { authorization: h } : {} });
    const chamar = async (R: any, p: string, h?: string) => { const r = await R.GET(req(p, h)); return { status: r.status, corpo: await r.json() }; };
    const out = {
      legadoVendasAsync: FF.ASYNC_SYNC_JOBS_ENABLED,
      coord: await chamar(C, "coordenador", `Bearer ${SEG}`), worker: await chamar(W, "worker", `Bearer ${SEG}`),
      coordSemAuth: await chamar(C, "coordenador"), workerSemAuth: await chamar(W, "worker", "Bearer errado"),
      fetches, saidas,
    };
    console.log = log; console.error = err;
    console.log(`SONDA:${JSON.stringify(out)}`);
  })().catch((e) => { console.log(`SONDA_ERRO:${String(e?.message ?? e)}`); process.exit(1); });
} else {
  principal();
}

function sonda(publica: string | undefined, canonica: string | undefined): any {
  const env: Record<string, string> = { ...process.env as Record<string, string>, MODO_SONDA: "1", CRON_SECRET: SEG, NEXT_PUBLIC_SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "" };
  delete env.NEXT_PUBLIC_ENABLE_ASYNC_SYNC_JOBS; delete env.ENABLE_CANONICAL_SALES_SYNC;
  if (publica !== undefined) env.NEXT_PUBLIC_ENABLE_ASYNC_SYNC_JOBS = publica;
  if (canonica !== undefined) env.ENABLE_CANONICAL_SALES_SYNC = canonica;
  let out = "";
  try { out = execFileSync("npx", ["tsx", JSON.stringify(__filename)], { cwd: RAIZ, env: env as NodeJS.ProcessEnv, encoding: "utf8", timeout: 120000, shell: true }); }
  catch (e: any) { out = String(e.stdout ?? "") + String(e.stderr ?? ""); }
  const linha = out.split(/\r?\n/).find((l) => l.startsWith("SONDA:"));
  if (!linha) throw new Error(`sonda sem saida: ${out.slice(-400)}`);
  return JSON.parse(linha.slice(6));
}

async function principal() {
  let passou = 0, falhou = 0;
  let fila: Promise<void> = Promise.resolve();
  const t = (nome: string, fn: () => void | Promise<void>) => {
    fila = fila.then(async () => {
      try { await fn(); passou++; console.log(`  PASS  ${nome}`); }
      catch (e: any) { falhou++; console.log(`  FALHA ${nome} -> ${e?.stack?.split("\n").slice(0, 2).join(" | ") ?? e}`); }
    });
  };
  function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
  const semComentarios = (f: string) => readFileSync(join(RAIZ, f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  const ROTAS = ["app/api/internal/vendas-sync/coordenador/route.ts", "app/api/internal/vendas-sync/worker/route.ts"];
  const HELPER = "lib/vendas/sync/flag-canonica.ts";
  const desabilitado = (r: any) => r.status === 200 && r.corpo.resultado === "DESABILITADO";
  // canonica LIGADA sem env do Supabase: entrou no fluxo e falhou fechado na criacao do cliente
  const entrouNoFluxo = (r: any) => r.status === 500 && r.corpo.erro === "falha_interna";

  const F = await import("../lib/vendas/sync/flag-canonica");
  const T = await import("../lib/vendas/sync/coordenador-tick");
  const W = await import("../lib/vendas/sync/worker");
  const comEnv = <X>(v: string | undefined, fn: () => X): X => { const a = process.env.ENABLE_CANONICAL_SALES_SYNC;
    if (v === undefined) delete process.env.ENABLE_CANONICAL_SALES_SYNC; else process.env.ENABLE_CANONICAL_SALES_SYNC = v;
    try { return fn(); } finally { if (a === undefined) delete process.env.ENABLE_CANONICAL_SALES_SYNC; else process.env.ENABLE_CANONICAL_SALES_SYNC = a; } };

  console.log("\n[A-B. valores / leitura]");
  t("A/B. so a string exata \"true\" liga; ausente, \"\", \"false\", \"1\", \"TRUE\", \" true\", \"yes\" → OFF", () => {
    assert(comEnv("true", () => F.syncCanonicoVendasHabilitado()) === true, "true");
    for (const v of [undefined, "", "false", "1", "TRUE", " true", "true ", "yes", "on"]) assert(comEnv(v, () => F.syncCanonicoVendasHabilitado()) === false, `liga com ${JSON.stringify(v)}`);
  });
  t("FLAG_READ_MODEL: lida a cada chamada (mudar o env entre chamadas muda o resultado; sem constante de modulo)", () => {
    assert(comEnv("true", () => F.syncCanonicoVendasHabilitado()) && !comEnv(undefined, () => F.syncCanonicoVendasHabilitado()) && comEnv("true", () => F.syncCanonicoVendasHabilitado()), "nao reflete o env da chamada");
    const s = semComentarios(HELPER);
    assert(/export function syncCanonicoVendasHabilitado\(\): boolean \{\s*return process\.env\.ENABLE_CANONICAL_SALES_SYNC === "true";\s*\}/.test(s), "leitura nao esta dentro da funcao");
    assert((s.match(/process\.env/g) ?? []).length === 1 && !/NEXT_PUBLIC/.test(s), "outra leitura de env / NEXT_PUBLIC");
  });

  console.log("\n[C-D/G-H. fluxo pelas libs com dubles]");
  const lojaFake = { id: "11111111-1111-4111-8111-111111111111", user_id: "dono", marketplace: "ML", ativo: true, seller_id: "s", access_token: "x", refresh_token: "y", token_expires_at: null, partner_id: null, partner_key: null };
  const clienteFake = (cont: { from: number }) => ({ rpc: async () => ({ data: null, error: { code: "X" } }), from(tab: string) { cont.from++;
    const linhas = tab === "lojas" ? [lojaFake] : []; let ins: any = null;
    const q: any = new Proxy({}, { get(_a, p: string) {
      if (p === "then") return (ok: any) => ok(ins ? { data: { id: "novo" }, error: null } : { data: linhas, count: 0, error: null });
      if (p === "insert") return (l: any) => { ins = l; return q; };
      return () => q; } });
    return q; } });
  t("C. flag ON → tick do coordenador entra no fluxo normal (lista, avalia, cria 1 job no duble)", async () => {
    const cont = { from: 0, deps: 0 };
    const r = await comEnv("true", () => T.executarTickCoordenador(() => { cont.deps++; return { cliente: clienteFake(cont) as any, relogio: { agoraMs: () => Date.parse("2026-10-07T12:00:00Z") }, log: () => {} }; },
      { orcamentoMs: 45_000, habilitado: F.syncCanonicoVendasHabilitado() }));
    assert(cont.deps === 1 && cont.from > 0 && r.resultado === "OK" && r.lojasAvaliadas === 1 && r.jobsCriados === 1, JSON.stringify(r));
  });
  t("D. flag ON → worker entra no fluxo normal (recuperacao + candidatos; NO_JOB no duble vazio)", async () => {
    const cont = { from: 0, deps: 0 };
    const r = await comEnv("true", () => W.executarWorkerCanonico(() => { cont.deps++; return { cliente: clienteFake(cont) as any, relogio: { agoraMs: () => Date.now() },
      portasML: async () => { throw new Error("nao"); }, portasShopee: async () => null }; }, { orcamentoMs: 45_000, habilitado: F.syncCanonicoVendasHabilitado() }));
    assert(cont.deps === 1 && cont.from >= 2 && r.resultado === "NO_JOB", JSON.stringify(r));
  });
  t("G. flag OFF → coordenador: 0 cliente, 0 leitura de lojas, 0 job", async () => {
    const cont = { from: 0, deps: 0 };
    const r = await comEnv(undefined, () => T.executarTickCoordenador(() => { cont.deps++; return { cliente: clienteFake(cont) as any, relogio: { agoraMs: () => 0 } }; },
      { orcamentoMs: 45_000, habilitado: F.syncCanonicoVendasHabilitado() }));
    assert(r.resultado === "DESABILITADO" && cont.deps === 0 && cont.from === 0 && r.jobsCriados === 0, JSON.stringify({ r, cont }));
  });
  t("H. flag OFF → worker: 0 cliente, 0 recuperacao, 0 claim, 0 auth, 0 motor", async () => {
    const cont = { from: 0, deps: 0, auth: 0, motor: 0 };
    const r = await comEnv("false", () => W.executarWorkerCanonico(() => { cont.deps++; return { cliente: clienteFake(cont) as any, relogio: { agoraMs: () => 0 },
      portasML: async () => { cont.auth++; throw new Error("x"); }, portasShopee: async () => { cont.auth++; return null; },
      motores: { ml: (async () => { cont.motor++; }) as any, shopee: (async () => { cont.motor++; }) as any, catchup: (async () => { cont.motor++; }) as any } }; },
      { orcamentoMs: 45_000, habilitado: F.syncCanonicoVendasHabilitado() }));
    assert(r.resultado === "DESABILITADO" && cont.deps === 0 && cont.from === 0 && cont.auth === 0 && cont.motor === 0 && r.recuperados === 0, JSON.stringify({ r, cont }));
  });

  console.log("\n[17. matriz 2×2 pelas ROTAS reais (processos filhos)]");
  t("E/F + 2×2: publica e canonica sao INDEPENDENTES; auth vem antes da flag; segredo nunca sai; 0 rede", () => {
    const casos: [string | undefined, string | undefined, boolean, boolean][] = [
      [undefined, undefined, false, false], ["true", undefined, true, false], [undefined, "true", false, true], ["true", "true", true, true],
      ["false", "true", false, true], ["true", "false", true, false],
    ];
    for (const [pub, can, esperaVendasAsync, esperaCanonico] of casos) {
      const s = sonda(pub, can); const rotulo = `publica=${pub} canonica=${can}`;
      assert(s.legadoVendasAsync === esperaVendasAsync, `${rotulo}: flag da Vendas ${s.legadoVendasAsync}`);
      for (const r of [s.coord, s.worker]) assert(esperaCanonico ? entrouNoFluxo(r) : desabilitado(r), `${rotulo}: rota ${JSON.stringify(r)}`);
      assert(s.coordSemAuth.status === 401 && s.workerSemAuth.status === 401, `${rotulo}: auth`);
      assert(s.fetches === 0 && !JSON.stringify(s).includes(SEG), `${rotulo}: rede/segredo`);
    }
  });

  console.log("\n[guardas]");
  t("rotas canonicas usam SO a flag nova (passam habilitado explicito) e nunca a publica", () => {
    for (const f of ROTAS) {
      const s = semComentarios(f);
      assert(/import \{ syncCanonicoVendasHabilitado \} from "@\/lib\/vendas\/sync\/flag-canonica";/.test(s) && /habilitado: syncCanonicoVendasHabilitado\(\) \}\)/.test(s), `${f}: sem a flag nova`);
      assert(!/NEXT_PUBLIC|ASYNC_SYNC_JOBS|feature-flags/.test(s), `${f}: usa a flag publica`);
      // SALES-SYNC-D8.2: a comparacao passa pelo helper (CRON_SECRET OU segredo manual) — guard proprio: testar-vendas-sync-auth-interna
      assert(/if \(!segredo \|\| !auth \|\| auth !== cabecalhoEsperadoSalesSync\(auth, segredo\)\)/.test(s) && s.indexOf("auth !== cabecalhoEsperadoSalesSync") < s.indexOf("syncCanonicoVendasHabilitado()"), `${f}: auth depois da flag`);
      assert(!/console\.\w+\([^)]*(syncCanonicoVendasHabilitado|ENABLE_CANONICAL)/.test(s) && !/ENABLE_CANONICAL_SALES_SYNC/.test(s), `${f}: expoe/loga a flag`);
    }
  });
  t("24. diff das rotas desde a base = SO gating: comentario, o import do helper e o argumento habilitado", () => {
    for (const f of ROTAS) {
      const dc = execFileSync("git", ["diff", "-U0", BASE, "--", f], { cwd: RAIZ, encoding: "utf8" }).split(/\r?\n/)
        .filter((l) => /^[-+]/.test(l) && !/^(---|\+\+\+)/.test(l)).filter((l) => !/^[-+]\s*(\*|\/\*\*|\/\/)/.test(l) && l.trim() !== "+" && l.trim() !== "-");
      const add = dc.filter((l) => l.startsWith("+")), rem = dc.filter((l) => l.startsWith("-"));
      const chamada = /^[-+]\s+const relatorio = await executar(TickCoordenador|WorkerCanonico)\(criarDeps(Tick|Worker)Reais, \{ orcamentoMs: ORCAMENTO_MS(, habilitado: syncCanonicoVendasHabilitado\(\))? \}\);$/;
      // SALES-SYNC-D8.2 troca SO a linha da guarda (e importa o helper de auth) — exatamente estas duas linhas a mais
      const guardaAntiga = "-  if (!segredo || !auth || auth !== `Bearer ${segredo}`) {", guardaNova = "+  if (!segredo || !auth || auth !== cabecalhoEsperadoSalesSync(auth, segredo)) {";
      const importAuth = '+import { cabecalhoEsperadoSalesSync } from "@/lib/vendas/sync/auth-interna";';
      const remG = rem.filter((l) => l !== guardaAntiga), addG = add.filter((l) => l !== guardaNova && l !== importAuth);
      assert(rem.includes(guardaAntiga) && add.includes(guardaNova) && add.includes(importAuth), `${f}: troca de auth D8.2 ausente`);
      assert(remG.length === 1 && chamada.test(remG[0]) && !remG[0].includes("habilitado"), `${f} removeu: ${rem}`);
      assert(addG.length === 2 && addG.some((l) => l === '+import { syncCanonicoVendasHabilitado } from "@/lib/vendas/sync/flag-canonica";') && addG.some((l) => chamada.test(l) && l.includes("habilitado")), `${f} acrescentou: ${add}`);
    }
  });
  t("I. helper server-only; nenhum client component (nem a Vendas) importa a flag canonica", () => {
    assert(/^import "server-only";$/m.test(readFileSync(join(RAIZ, HELPER), "utf8")), "helper sem server-only");
    const arquivos = (d: string): string[] => readdirSync(join(RAIZ, d)).flatMap((n) => { const p = `${d}/${n}`; return statSync(join(RAIZ, p)).isDirectory() ? arquivos(p) : /\.(tsx?|jsx?)$/.test(n) ? [p] : []; });
    const usam = [...arquivos("app"), ...arquivos("lib"), ...(statSync(join(RAIZ, "components"), { throwIfNoEntry: false }) ? arquivos("components") : [])]
      .filter((f) => /flag-canonica|syncCanonicoVendasHabilitado|ENABLE_CANONICAL_SALES_SYNC/.test(readFileSync(join(RAIZ, f), "utf8")) && f !== HELPER);
    assert(usam.sort().join() === ROTAS.slice().sort().join(), `importadores: ${usam}`);
    for (const f of usam) assert(!/^["']use client["']/m.test(readFileSync(join(RAIZ, f), "utf8")), `${f} e client`);
  });
  t("K/L. Vendas, Dashboard, legado (/api/sync, iniciar, status, sync-on-read, worker local), flag publica e logica canonica INTOCADOS", () => {
    const d = execFileSync("git", ["diff", "--name-only", BASE, "--", "app/(app)", "app/api/sync", "app/api/ml", "app/api/shopee", "app/api/internal/sync", "lib/feature-flags.ts",
      "lib/vendas", "lib/marketplace", "lib/shopee-auth.ts", "lib/ml-auth.ts", "lib/mercado-livre", "lib/shopee", "lib/sync-ml.ts", "lib/sync-shopee.ts", "scripts/sync-worker.mjs",
      /* SALES-SYNC-D10: vercel.json agora agenda os crons canonicos — guard proprio: testar-vendas-sync-cron */ "supabase", "middleware.ts", "lib/middleware-rotas.ts"], { cwd: RAIZ, encoding: "utf8" }).trim().split(/\r?\n/)
      // SALES-SYNC-D8.2: helper de auth das rotas canonicas (guard proprio: testar-vendas-sync-auth-interna)
      .filter((f) => f && f !== HELPER && f !== "lib/vendas/sync/auth-interna.ts");
    // SALES-CANONICAL-D13A: SO o bloco D13 de credenciais.ts e os arquivos novos do D13
    const fora = filtrarExcecaoD15B(RAIZ, BASE, filtrarExcecaoD14(RAIZ, BASE, filtrarExcecaoD13(RAIZ, BASE, d)));
    assert(fora.length === 0, `alterados: ${fora}`);
    const vendas = readFileSync(join(RAIZ, "app/(app)/vendas/page.tsx"), "utf8");
    assert(/import \{ ASYNC_SYNC_JOBS_ENABLED \} from "@\/lib\/feature-flags";/.test(vendas) && /if \(!ASYNC_SYNC_JOBS_ENABLED\) \{\s*dispararSincronizarInline\(\);/.test(vendas), "Vendas mudou de flag");
  });
  t("env template: so ACRESCENTA ENABLE_CANONICAL_SALES_SYNC=false (sem segredo); nada removido", () => {
    const dc = execFileSync("git", ["diff", "-U0", BASE, "--", ".env.example"], { cwd: RAIZ, encoding: "utf8" }).split(/\r?\n/);
    const rem = dc.filter((l) => l.startsWith("-") && !l.startsWith("---")), add = dc.filter((l) => l.startsWith("+") && !l.startsWith("+++"));
    const vars = add.filter((l) => /^\+[A-Z_]+=/.test(l));
    // SALES-SYNC-D8.2 acrescenta SO o nome do segredo manual, VAZIO (nunca um valor)
    assert(rem.length === 0 && vars.join() === "+ENABLE_CANONICAL_SALES_SYNC=false,+CANONICAL_SALES_SYNC_MANUAL_SECRET="
      && add.every((l) => l === "+" || /^\+#/.test(l) || vars.includes(l)), dc.join("\n"));
  });

  await fila;
  console.log(`\n${falhou === 0 ? "✓" : "✗"} VENDAS-SYNC-FEATURE-FLAG — ${passou} passaram, ${falhou} falharam`);
  process.exit(falhou === 0 ? 0 : 1);
}
