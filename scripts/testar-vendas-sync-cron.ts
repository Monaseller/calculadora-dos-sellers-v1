/**
 * SALES-SYNC-D10 — agendamento dos crons canonicos de vendas em vercel.json (offline).
 *
 *   /api/internal/vendas-sync/coordenador   a cada 15 min   (planeja/cria)
 *   /api/internal/vendas-sync/worker        a cada 1 min    (executa 1 fatia)
 *
 * Cron agendado NAO e sync ativo: as duas rotas exigem auth (Bearer
 * CRON_SECRET — o que a Vercel envia — ou o segredo manual) E a flag
 * server-only ENABLE_CANONICAL_SALES_SYNC === "true"; sem a flag respondem
 * DESABILITADO sem criar cliente (jobs pendentes, como o Shopee deixado
 * pelo D9, ficam congelados).
 *
 * PRE-CONDICAO OBRIGATORIA DO GATE DE DEPLOY (nao verificavel offline):
 * o D9 terminou com Instant Rollback na Vercel. Depois de um rollback a
 * Vercel deixa de promover automaticamente novos pushes de `main` para os
 * dominios de producao ate o rollback ser desfeito/um deployment ser
 * promovido. Antes de publicar este commit, verificar o estado de rollback
 * de Production — nunca assumir que o push vira producao.
 *
 * Uso: npx tsx scripts/testar-vendas-sync-cron.ts
 */
import "./_server-only-inerte";
import { execFileSync } from "node:child_process";
// SALES-CANONICAL-D13A: excecao minima e exata (capability owner-scoped + arquivos novos do D13)
import { filtrarExcecaoD13 } from "./_excecao-d13-vendas-canonicas";
// SALES-CANONICAL-D14B: excecao EXATA do patch D14 nos leitores (ATUAL − patch aprovado = bytes de 1c4fe29)
import { filtrarExcecaoD14 } from "./_excecao-d14-vendas-canonicas";
// SALES-SYNC-D15B2: excecao EXATA do patch D15B nos arquivos de sync (ATUAL − patch aprovado = bytes de d631748)
import { filtrarExcecaoD15B } from "./_excecao-d15b-intraday";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
const BASE = "7a5c30d";
type Cron = { path: string; schedule: string };

const COORDENADOR = "/api/internal/vendas-sync/coordenador", WORKER = "/api/internal/vendas-sync/worker";
const ESPERADOS: Cron[] = [
  { path: "/api/sync", schedule: "0 3 * * *" },
  { path: "/api/internal/estudio-anuncios/worker", schedule: "* * * * *" },
  { path: "/api/internal/agentes/worker", schedule: "* * * * *" },
  { path: "/api/internal/agentes/monitor-ingestao", schedule: "* * * * *" },
  { path: COORDENADOR, schedule: "*/15 * * * *" },
  { path: WORKER, schedule: "* * * * *" },
];
const chave = (c: Cron) => `${c.path} @ ${c.schedule}`;

let fetches = 0;
(globalThis as any).fetch = async () => { fetches++; throw new Error("rede proibida"); };

async function principal() {
  const bruto = readFileSync(join(RAIZ, "vercel.json"), "utf8");
  const vj = JSON.parse(bruto) as { crons: Cron[]; functions: Record<string, { maxDuration: number }> };
  const base = JSON.parse(execFileSync("git", ["show", `${BASE}:vercel.json`], { cwd: RAIZ, encoding: "utf8" })) as typeof vj;

  console.log("\n[17-20. conjunto exato]");
  t("17. o conjunto de crons e EXATAMENTE os 6 esperados (path + schedule, nao so contagem)", () => {
    const atual = vj.crons.map(chave).sort(), esperado = ESPERADOS.map(chave).sort();
    assert(JSON.stringify(atual) === JSON.stringify(esperado), `atual:\n  ${atual.join("\n  ")}`);
    assert(vj.crons.every((c) => Object.keys(c).sort().join() === "path,schedule"), "entrada com campo extra");
  });
  t("18. nenhum path duplicado; coordenador e worker canonico com EXATAMENTE 1 entrada cada", () => {
    const paths = vj.crons.map((c) => c.path);
    assert(new Set(paths).size === paths.length, `duplicado: ${paths}`);
    assert(paths.filter((p) => p === COORDENADOR).length === 1 && paths.filter((p) => p === WORKER).length === 1, "canonico ausente/duplicado");
  });
  t("19. os 4 crons anteriores e o bloco functions sao IGUAIS aos da base (legado /api/sync em 0 3 * * *)", () => {
    assert(base.crons.length === 4, "base inesperada");
    for (const c of base.crons) assert(vj.crons.some((x) => x.path === c.path && x.schedule === c.schedule), `cron anterior alterado/removido: ${chave(c)}`);
    assert(vj.crons.find((c) => c.path === "/api/sync")?.schedule === "0 3 * * *", "schedule do legado mudou");
    assert(JSON.stringify(vj.functions) === JSON.stringify(base.functions), "bloco functions mudou");
    assert(Object.keys(vj).sort().join() === Object.keys(base).sort().join(), "chaves de topo mudaram");
  });
  t("20. schedules canonicos exatos e expressoes cron validas (5 campos)", () => {
    assert(vj.crons.find((c) => c.path === COORDENADOR)?.schedule === "*/15 * * * *", "coordenador != */15");
    assert(vj.crons.find((c) => c.path === WORKER)?.schedule === "* * * * *", "worker != * * * * *");
    const campo = /^(\*|\d+)(\/\d+)?(,(\*|\d+)(\/\d+)?)*$/;
    for (const c of vj.crons) { const p = c.schedule.split(" "); assert(p.length === 5 && p.every((x) => campo.test(x)), `expressao invalida: ${chave(c)}`); }
  });

  console.log("\n[21. sem segredo na config]");
  t("21. vercel.json so tem path/schedule: nenhum segredo, header, query string ou credencial", () => {
    assert(!/secret|bearer|authorization|token|password|key=|\?/i.test(JSON.stringify(vj.crons)), "algo alem de path/schedule nos crons");
    assert(!/CRON_SECRET|CANONICAL_SALES_SYNC_MANUAL_SECRET|Bearer/i.test(bruto), "segredo/header citado em vercel.json");
    assert(vj.crons.every((c) => /^\/api\/[a-z0-9\-/]+$/.test(c.path)), "path com caractere inesperado");
  });

  console.log("\n[7/13. rotas, middleware, teto]");
  t("13. rotas canonicas existem, exportam so GET, maxDuration 60 (coberto por app/api/** = 60) e orcamento 45s", () => {
    for (const p of [COORDENADOR, WORKER]) {
      const arq = join(RAIZ, "app", p, "route.ts");
      assert(existsSync(arq), `rota ausente: ${p}`);
      const s = readFileSync(arq, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
      assert(/export async function GET\(/.test(s) && !/export async function (POST|PUT|PATCH|DELETE)/.test(s), `${p}: metodos`);
      assert(/export const maxDuration = 60;/.test(s) && /const ORCAMENTO_MS = 45_000;/.test(s), `${p}: teto/orcamento`);
    }
    assert(vj.functions["app/api/**"]?.maxDuration === 60 && !Object.keys(vj.functions).some((k) => k.includes("vendas-sync")), "teto das rotas canonicas mudou");
  });
  t("7. middleware deixa o GET do cron chegar as duas rotas (a auth e da rota); policy so GET", async () => {
    const MW = await import("../lib/middleware-rotas");
    for (const p of [COORDENADOR, WORKER]) {
      assert(MW.decidirAcesso(p, "GET", false) === "liberar", `${p}: GET bloqueado`);
      assert(JSON.stringify((MW as any).ROTAS_COM_SEGREDO[p]) === '["GET"]', `${p}: policy`);
    }
  });

  console.log("\n[8/22. cron agendado != sync ativo]");
  t("8/22. chamada de Vercel Cron (Bearer CRON_SECRET) e manual, com flag canonica OFF → 200 DESABILITADO, zero atividade; sem auth → 401", async () => {
    process.env.NEXT_PUBLIC_ENABLE_ASYNC_SYNC_JOBS = "true";   // a flag PUBLICA nao liga o canonico
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://placeholder.invalid";
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const CRON = "cron-d10-aa11", MANUAL = "manual-d10-bb22";
    process.env.CRON_SECRET = CRON; process.env.CANONICAL_SALES_SYNC_MANUAL_SECRET = MANUAL;
    const C = await import("../app/api/internal/vendas-sync/coordenador/route");
    const W = await import("../app/api/internal/vendas-sync/worker/route");
    const saidas: string[] = []; const l0 = console.log, e0 = console.error;
    console.log = (...a: unknown[]) => { saidas.push(a.map(String).join(" ")); }; console.error = console.log;
    try {
      for (const flag of [undefined, "false", "1", "TRUE"]) {
        if (flag === undefined) delete process.env.ENABLE_CANONICAL_SALES_SYNC; else process.env.ENABLE_CANONICAL_SALES_SYNC = flag;
        for (const [R, p] of [[C, "coordenador"], [W, "worker"]] as const) {
          for (const h of [`Bearer ${CRON}`, `Bearer ${MANUAL}`]) {
            const r = await (R as any).GET(new Request(`http://x/api/internal/vendas-sync/${p}`, { headers: { authorization: h } }));
            const corpo = await r.json(); saidas.push(JSON.stringify(corpo));
            assert(r.status === 200 && corpo.resultado === "DESABILITADO", `${p} flag=${flag}: ${r.status} ${JSON.stringify(corpo)}`);
            assert(p === "coordenador" ? corpo.jobsCriados === 0 && corpo.lojasAvaliadas === 0 : corpo.recuperados === 0 && corpo.job_id === undefined, `${p}: atividade`);
          }
          const sem = await (R as any).GET(new Request(`http://x/api/internal/vendas-sync/${p}`));
          assert(sem.status === 401, `${p}: sem auth != 401`);
        }
      }
    } finally { console.log = l0; console.error = e0; }
    assert(fetches === 0, "rede tocada com flag OFF");
    assert(!saidas.join("\n").includes(CRON) && !saidas.join("\n").includes(MANUAL), "segredo vazou");
  });

  console.log("\n[23. escopo]");
  t("23. so vercel.json e scripts de teste mudaram desde a base: rotas, coordenador, worker, elegibilidade, motores, auth, Vendas, Dashboard INTOCADOS", () => {
    const d = execFileSync("git", ["diff", "--name-only", BASE], { cwd: RAIZ, encoding: "utf8" }).trim().split(/\r?\n/).filter(Boolean);
    // SALES-CANONICAL-D13A: alem disso, SO o bloco D13 de credenciais.ts e os arquivos novos do D13 (inclui scripts/_excecao-d13-vendas-canonicas.ts)
    const fora = filtrarExcecaoD15B(RAIZ, BASE, filtrarExcecaoD14(RAIZ, BASE, filtrarExcecaoD13(RAIZ, BASE, d.filter((f) => f !== "vercel.json" && !/^scripts\/testar-[a-z0-9-]+\.ts$/.test(f)))));
    assert(fora.length === 0, `alterados fora do escopo: ${fora}`);
    const novos = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: RAIZ, encoding: "utf8" }).trim().split(/\r?\n/).filter(Boolean)
      .filter((f) => !/^scripts\/testar-[a-z0-9-]+\.ts$/.test(f));
    // SALES-CANONICAL-D13A: SO os arquivos novos do D13 (lista exata, inexistentes na base)
    const novosFora = filtrarExcecaoD15B(RAIZ, BASE, filtrarExcecaoD14(RAIZ, BASE, filtrarExcecaoD13(RAIZ, BASE, novos, false)));
    assert(novosFora.length === 0, `arquivos novos fora do escopo: ${novosFora}`);
  });

  await fila;
  console.log(`\n${falhou === 0 ? "✓" : "✗"} VENDAS-SYNC-CRON — ${passou} passaram, ${falhou} falharam`);
  process.exit(falhou === 0 ? 0 : 1);
}
principal().catch((e) => { console.error(e); process.exit(1); });
