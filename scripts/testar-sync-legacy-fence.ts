/**
 * SALES-SYNC-C1 — fence legado x canonico em sync_jobs (offline).
 *
 * Prova que o caminho LEGADO (claim_next_sync_job + recuperacao de travados
 * de scripts/sync-worker.mjs) so toca job explicitamente legado — allowlist
 * positiva `campo_tempo IS NULL AND checkpoint IS NULL` — e que o worker
 * canonico continua com os tipos dele. A migration NAO e aplicada aqui:
 * o WHERE real do arquivo e avaliado por um interpretador minimo e a
 * funcao real de recuperacao roda contra um duplo de banco.
 *
 * Uso: npx tsx scripts/testar-sync-legacy-fence.ts
 */
import "./_server-only-inerte";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
const BASE = "349932a";
const MIGRATION = "supabase/migrations/20261029_sales_sync_c1_legacy_claim_fence.sql";
const ORIGINAL = "supabase/migrations/20260711_sync_jobs.sql";
const ler = (f: string) => readFileSync(join(RAIZ, f), "utf8").replace(/\r/g, "");

type Linha = Record<string, any>;
const CATCHUP = { versao: 1, modo: "escrow_catchup", apos: null, varreduraTerminou: false, retentar: [], tentativas: {}, falhas: {} };
// jobs equivalentes aos reais (SALES-SYNC-B2: 7 legados NULL/NULL; 2 update_time do S2-D3-B2 com checkpoint do motor)
const FIX: Record<string, Linha> = {
  legado: { id: "legado", campo_tempo: null, checkpoint: null },
  ml_date_closed: { id: "ml", campo_tempo: "date_closed", checkpoint: null },
  ml_date_closed_ck: { id: "ml-ck", campo_tempo: "date_closed", checkpoint: { versao: 1, diasConcluidos: [] } },
  shopee_create_time: { id: "sp", campo_tempo: "create_time", checkpoint: null },
  shopee_create_time_ck: { id: "sp-ck", campo_tempo: "create_time", checkpoint: { versao: 1, fase: "LIST" } },
  catchup: { id: "cu", campo_tempo: null, checkpoint: CATCHUP },
  update_time_motor: { id: "upd", campo_tempo: "update_time", checkpoint: { versao: 1, fase: "DONE" } },
  update_time_sem_ck: { id: "upd2", campo_tempo: "update_time", checkpoint: null },
  futuro_campo: { id: "fut", campo_tempo: "future_field", checkpoint: null },
  futuro_checkpoint: { id: "fut-ck", campo_tempo: null, checkpoint: { versao: 9, modo: "algo_novo" } },
};
const LEGADOS_REAIS = Array.from({ length: 7 }, (_, i) => ({ id: `legado-real-${i}`, campo_tempo: null, checkpoint: null, janela_inicio: null, janela_fim: null }));

// ── interpretador minimo de WHERE (=, <>, !=, IS [NOT] NULL, IN, AND, OR, NOT, parenteses) ──
function avaliarWhere(sql: string, l: Linha): boolean {
  const toks = sql.match(/'[^']*'|\(|\)|,|<>|!=|=|[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  let i = 0; const peek = () => toks[i]?.toUpperCase(); const next = () => toks[i++];
  const valor = (tok: string) => (tok.startsWith("'") ? tok.slice(1, -1) : tok.toUpperCase() === "NULL" ? null : tok);
  function ou(): boolean { let v = e(); while (peek() === "OR") { next(); const r = e(); v = v || r; } return v; }
  function e(): boolean { let v = nao(); while (peek() === "AND") { next(); const r = nao(); v = v && r; } return v; }
  function nao(): boolean { if (peek() === "NOT") { next(); return !nao(); } return atomo(); }
  function atomo(): boolean {
    if (peek() === "(") { next(); const v = ou(); if (next() !== ")") throw new Error("parentese"); return v; }
    const col = next(); const atual = l[col] ?? null; const op = next()!.toUpperCase();
    if (op === "IS") { let neg = false; if (peek() === "NOT") { next(); neg = true; } if (next()!.toUpperCase() !== "NULL") throw new Error("IS"); return neg ? atual !== null : atual === null; }
    if (op === "=" || op === "<>" || op === "!=") { const v = valor(next()!); if (atual === null || v === null) return false; return op === "=" ? String(atual) === v : String(atual) !== v; }
    if (op === "IN") { if (next() !== "(") throw new Error("IN"); const vs: (string | null)[] = []; while (peek() !== ")") { const x = next()!; if (x !== ",") vs.push(valor(x)); } next(); return atual !== null && vs.includes(String(atual)); }
    throw new Error(`operador nao suportado: ${op}`);
  }
  const r = ou(); if (i !== toks.length) throw new Error(`sobrou: ${toks.slice(i).join(" ")}`); return r;
}
const corpo = (sql: string) => { const m = sql.match(/CREATE OR REPLACE FUNCTION (?:public\.)?claim_next_sync_job\(\)[\s\S]*?AS \$\$([\s\S]*?)\$\$;/); if (!m) throw new Error("funcao nao encontrada"); return m[1]; };
const whereDaSelecao = (sql: string) => { const m = corpo(sql).match(/FROM sync_jobs\s+WHERE([\s\S]*?)ORDER BY/); if (!m) throw new Error("WHERE da selecao nao encontrado"); return m[1].trim(); };
/** Simula o claim: WHERE da selecao, ORDER BY criado_em ASC, LIMIT 1. */
const claim = (sql: string, jobs: Linha[]) => jobs.filter((j) => avaliarWhere(whereDaSelecao(sql), j)).sort((a, b) => String(a.criado_em).localeCompare(String(b.criado_em)))[0] ?? null;
const pendente = (k: string, minutos: number): Linha => ({ ...FIX[k], status: "pendente", criado_em: new Date(Date.UTC(2026, 9, 6, 12, minutos)).toISOString() });

/** Todas as checagens da migration; devolve a lista de violacoes (vazia = ok). Usada tambem pelos mutantes. */
function violacoesMigration(sql: string): string[] {
  const v: string[] = [];
  let w = ""; try { w = whereDaSelecao(sql); } catch (e: any) { return [e.message]; }
  const ok = (k: string) => { try { return avaliarWhere(w, { ...FIX[k], status: "pendente" }); } catch (e: any) { v.push(`where invalido: ${e.message}`); return false; } };
  if (!ok("legado")) v.push("legado pendente NAO e reivindicavel");
  for (const k of Object.keys(FIX)) if (k !== "legado" && ok(k)) v.push(`legacy claim aceitaria ${k}`);
  for (const r of LEGADOS_REAIS) { try { if (!avaliarWhere(w, { ...r, status: "pendente" })) v.push("legado real fora da allowlist"); } catch { /* ja contado */ } }
  try { if (avaliarWhere(w, { ...FIX.legado, status: "rodando" })) v.push("aceita status != pendente"); } catch { /* idem */ }
  const c = corpo(sql);
  for (const [nome, re] of [["status = 'pendente'", /status\s*=\s*'pendente'/], ["campo_tempo IS NULL", /campo_tempo\s+IS\s+NULL/i], ["checkpoint IS NULL", /checkpoint\s+IS\s+NULL/i],
    ["FOR UPDATE SKIP LOCKED", /FOR UPDATE SKIP LOCKED/], ["ORDER BY criado_em ASC", /ORDER BY criado_em ASC/], ["LIMIT 1", /LIMIT 1;/],
    ["UPDATE rodando", /SET status\s+= 'rodando',\s+iniciado_em\s+= now\(\),\s+heartbeat_em = now\(\)\s+WHERE id = v_job\.id\s+RETURNING \* INTO v_job;/]] as const)
    if (!re.test(c)) v.push(`corpo sem ${nome}`);
  if (/\bOR\b/i.test(w)) v.push("WHERE com OR");
  if (/date_closed|create_time|update_time|escrow_catchup/i.test(w)) v.push("WHERE nomeia tipo canonico (regra negativa)");
  // assinatura / propriedades preservadas (banco real: INVOKER, sem config, plpgsql)
  if (!/CREATE OR REPLACE FUNCTION public\.claim_next_sync_job\(\)\s+RETURNS sync_jobs\s+LANGUAGE plpgsql\s+AS \$\$/.test(sql)) v.push("assinatura/retorno/linguagem mudaram");
  if (/SECURITY\s+DEFINER|SET\s+search_path|\bSTABLE\b|\bIMMUTABLE\b/i.test(sql.replace(/^--.*$/gm, ""))) v.push("propriedade da funcao alterada");
  const priv = new RegExp("\\b(GR" + "ANT|REV" + "OKE)\\b", "i");
  if (priv.test(sql.replace(/^--.*$/gm, ""))) v.push("mexe em privilegios");
  if (/\b(CREATE|DROP|ALTER)\s+(UNIQUE\s+)?INDEX\b/i.test(sql.replace(/^--.*$/gm, ""))) v.push("mexe em indice");
  if (!/^BEGIN;\s*\nSET LOCAL lock_timeout = '5s';/m.test(sql) || !/^COMMIT;\s*$/m.test(sql)) v.push("sem BEGIN/lock_timeout/COMMIT");
  return v;
}

// ── duplo de banco para a recuperacao REAL de scripts/sync-worker.mjs ──
function bancoFalso(jobs: Linha[]) {
  const updates: { id: string; patch: Linha }[] = [];
  const cliente = { from(_t: string) {
    const filtros: [string, string, unknown][] = []; let patch: Linha | null = null;
    const casa = (l: Linha) => filtros.every(([o, c, v]) => o === "eq" ? String(l[c]) === String(v) : o === "is" ? (l[c] ?? null) === v : o === "lt" ? l[c] !== null && l[c] < (v as any) : true);
    const q: any = {
      select() { return q; }, update(p: Linha) { patch = p; return q; },
      eq(c: string, v: unknown) { filtros.push(["eq", c, v]); return q; }, is(c: string, v: unknown) { filtros.push(["is", c, v]); return q; },
      lt(c: string, v: unknown) { filtros.push(["lt", c, v]); return q; },
      then(ok: any) {
        if (patch) { for (const l of jobs.filter(casa)) { Object.assign(l, patch); updates.push({ id: l.id, patch: patch! }); } return Promise.resolve({ data: null, error: null }).then(ok); }
        return Promise.resolve({ data: jobs.filter(casa).map((l) => ({ ...l })), error: null }).then(ok);
      },
    };
    return q;
  } };
  return { cliente, updates, jobs };
}
function funcaoReclamar(fonte: string) {
  const i = fonte.indexOf("async function reclamarJobsTravados()");
  let j = fonte.indexOf("{", i), prof = 0;
  for (; j < fonte.length; j++) { if (fonte[j] === "{") prof++; else if (fonte[j] === "}" && --prof === 0) break; }
  return fonte.slice(i, j + 1);
}
async function rodarRecuperacao(fonte: string, jobs: Linha[]) {
  const b = bancoFalso(jobs);
  const fn = new Function("supabase", "STALE_MINUTES", "console", `${funcaoReclamar(fonte)}; return reclamarJobsTravados;`)(b.cliente, 10, { log() {}, error() {} });
  await fn(); return b;
}
const STALE = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const travado = (k: string): Linha => ({ ...structuredClone(FIX[k]), status: "rodando", heartbeat_em: STALE, tentativas: 0, max_tentativas: 3 });
async function violacoesRecuperacao(fonte: string): Promise<string[]> {
  const v: string[] = [];
  const jobs = Object.keys(FIX).map(travado);
  const antes = JSON.stringify(jobs.filter((j) => j.id !== "legado"));
  const b = await rodarRecuperacao(fonte, jobs);
  const leg = jobs.find((j) => j.id === "legado")!;
  if (leg.status !== "pendente" || leg.tentativas !== 1) v.push("legado travado nao foi recuperado");
  if (JSON.stringify(jobs.filter((j) => j.id !== "legado")) !== antes) v.push(`recuperacao tocou nao-legado: ${b.updates.filter((u) => u.id !== "legado").map((u) => u.id).join(",")}`);
  return v;
}

async function principal() {
  const W = await import("../lib/vendas/sync/worker-contrato");
  const sql = ler(MIGRATION);
  const worker = ler("scripts/sync-worker.mjs");

  console.log("\n[migration: allowlist positiva no claim legado]");
  t("M0. a migration real passa em TODAS as checagens (allowlist, assinatura, propriedades, sem privilegios/indice)", () => {
    const v = violacoesMigration(sql); assert(v.length === 0, v.join(" | "));
  });
  t("M1. o corpo novo = corpo original do banco (20260711) + SO as duas condicoes do fence", () => {
    const novo = corpo(sql).replace(/\n\s+AND campo_tempo IS NULL\n\s+AND checkpoint IS NULL/, "");
    const norm = (s: string) => s.replace(/\s+/g, " ").trim();
    assert(norm(novo) === norm(corpo(ler(ORIGINAL))), "corpo diverge do original alem do fence");
  });
  t("M2. o WHERE ORIGINAL (sem fence) aceitaria job canonico — o defeito que o gate fecha", () => {
    const orig = ler(ORIGINAL);
    assert(avaliarWhere(whereDaSelecao(orig), { ...FIX.ml_date_closed, status: "pendente" }) && avaliarWhere(whereDaSelecao(orig), { ...FIX.catchup, status: "pendente" }), "controle");
    assert(violacoesMigration(orig).some((x) => x.startsWith("legacy claim aceitaria")), "controle: original deveria violar");
  });

  console.log("\n[claim legado simulado]");
  t("P7. 1 legado + ML + Shopee + catch-up pendentes (canonicos MAIS ANTIGOS) → legado claima SO o legado", () => {
    const jobs = [pendente("ml_date_closed", 0), pendente("shopee_create_time", 1), pendente("catchup", 2), pendente("legado", 30)];
    assert(claim(sql, jobs)?.id === "legado", JSON.stringify(claim(sql, jobs)));
    assert(claim(ler(ORIGINAL), jobs)?.id === "ml", "controle: o original pegaria o canonico mais antigo");
  });
  t("P8. so canonico pendente (ML, Shopee, catch-up — cada um sozinho) → NO JOB", () => {
    for (const k of ["ml_date_closed", "ml_date_closed_ck", "shopee_create_time", "shopee_create_time_ck", "catchup"]) assert(claim(sql, [pendente(k, 0)]) === null, `${k} reivindicado`);
  });
  t("P10/11. futuro/desconhecido e update_time → legado NAO toca (fail closed)", () => {
    for (const k of ["futuro_campo", "futuro_checkpoint", "update_time_motor", "update_time_sem_ck"]) assert(claim(sql, [pendente(k, 0)]) === null, `${k} reivindicado`);
  });
  t("P12. os 7 jobs legados reais (NULL/NULL) continuam reivindicaveis; status != pendente nunca", () => {
    for (const r of LEGADOS_REAIS) assert(claim(sql, [{ ...r, status: "pendente", criado_em: "x" }])?.id === r.id, r.id);
    assert(claim(sql, [{ ...LEGADOS_REAIS[0], status: "rodando", criado_em: "x" }]) === null, "rodando reivindicado");
  });
  t("P5. canonico e legado DISJUNTOS: nenhum fixture e aceito pelos dois caminhos; o worker canonico continua com os seus", () => {
    const canon = (l: Linha) => W.classificarJobParaWorker({ marketplace: l.id.startsWith("ml") ? "ML" : "Shopee", campo_tempo: l.campo_tempo, janela_inicio: l.campo_tempo ? "a" : null, janela_fim: l.campo_tempo ? "b" : null, checkpoint: l.checkpoint });
    for (const [k, l] of Object.entries(FIX)) {
      const leg = avaliarWhere(whereDaSelecao(sql), { ...l, status: "pendente" }); const c = canon(l);
      assert(!(leg && c !== "NAO_CANONICO"), `${k} aceito pelos dois`);
    }
    assert(canon(FIX.ml_date_closed) === "ML_DATE_CLOSED" && canon(FIX.shopee_create_time) === "SHOPEE_CREATE_TIME" && canon(FIX.catchup) === "SHOPEE_ESCROW_CATCHUP", "canonico perdeu tipo");
    assert(canon(FIX.legado) === "NAO_CANONICO" && canon(FIX.update_time_motor) === "NAO_CANONICO" && canon(FIX.futuro_campo) === "NAO_CANONICO", "canonico ganhou tipo");
  });

  console.log("\n[mutantes da migration — o guard tem de reprovar]");
  const mutantes: [string, (s: string) => string][] = [
    ["A. sem campo_tempo IS NULL", (s) => s.replace(/\n\s+AND campo_tempo IS NULL/, "")],
    ["B. sem checkpoint IS NULL", (s) => s.replace(/\n\s+AND checkpoint IS NULL/, "")],
    ["C. AND → OR", (s) => s.replace("AND campo_tempo IS NULL", "OR campo_tempo IS NULL")],
    ["C2. AND → OR (checkpoint)", (s) => s.replace("AND checkpoint IS NULL", "OR checkpoint IS NULL")],
    ["D. aceita date_closed", (s) => s.replace("AND campo_tempo IS NULL", "AND (campo_tempo IS NULL OR campo_tempo = 'date_closed')")],
    ["E. aceita create_time", (s) => s.replace("AND campo_tempo IS NULL", "AND (campo_tempo IS NULL OR campo_tempo IN ('create_time'))")],
    ["F. regra negativa (<> date_closed)", (s) => s.replace("AND campo_tempo IS NULL", "AND campo_tempo <> 'date_closed'")],
    ["G. SECURITY DEFINER", (s) => s.replace("LANGUAGE plpgsql\nAS $$", "LANGUAGE plpgsql\nSECURITY DEFINER\nAS $$")],
    ["H. sem SKIP LOCKED", (s) => s.replace("FOR UPDATE SKIP LOCKED", "FOR UPDATE")],
  ];
  // mutante aplicado SO no codigo (o cabecalho de comentario repete os mesmos trechos)
  const noCodigo = (m: (s: string) => string) => (s: string) => { const i = s.indexOf("CREATE OR REPLACE FUNCTION"); return s.slice(0, i) + m(s.slice(i)); };
  for (const [nome, m0] of mutantes) t(`MUT ${nome} → reprovado`, () => {
    const s2 = noCodigo(m0)(sql); assert(s2 !== sql, "mutante nao aplicou");
    assert(violacoesMigration(s2).length > 0, "mutante sobreviveu");
  });

  console.log("\n[recuperacao de travados do worker legado — funcao REAL do script]");
  t("R9. travados: legado recuperado; ML, Shopee, catch-up, update_time, futuros INTOCADOS", async () => {
    const v = await violacoesRecuperacao(worker); assert(v.length === 0, v.join(" | "));
  });
  t("R9b. o fence esta na SELECAO e no UPDATE da recuperacao", () => {
    const f = funcaoReclamar(worker);
    const sel = f.slice(f.indexOf(".select("), f.indexOf(".lt("));
    const upd = f.slice(f.indexOf(".update("), f.indexOf("console.log"));
    for (const [nome, trecho] of [["selecao", sel], ["update", upd]] as const)
      assert(/\.is\("campo_tempo", null\)/.test(trecho) && /\.is\("checkpoint", null\)/.test(trecho), `sem fence na ${nome}`);
  });
  t("MUT R. recuperacao SEM o fence → reprovada (o guard morde)", async () => {
    const semFence = worker.replace(/\n\s*\.is\("campo_tempo", null\)\n\s*\.is\("checkpoint", null\)/, "").replace('.is("campo_tempo", null).is("checkpoint", null)', "");
    assert(semFence !== worker, "mutante nao aplicou");
    assert((await violacoesRecuperacao(semFence)).length > 0, "mutante sobreviveu");
  });
  t("R-outros. o worker legado so escreve em job que ELE reivindicou (claim/recuperacao) — sem outro SELECT de sync_jobs", () => {
    const sem = worker.replace(/\/\/[^\n]*/g, "");
    assert((sem.match(/\.from\("sync_jobs"\)/g) ?? []).length === 6 && (sem.match(/rpc\("claim_next_sync_job"\)/g) ?? []).length === 1, "consumidor novo de sync_jobs no worker legado");
    assert((sem.match(/\.select\(/g) ?? []).length === 1, "worker legado ganhou outra leitura de sync_jobs");
  });

  console.log("\n[outros consumidores e intocados]");
  t("I1. POST /api/sync/iniciar cria job no formato LEGADO (sem campo_tempo/checkpoint) → casa com a allowlist", () => {
    const s = ler("app/api/sync/iniciar/route.ts"); const ins = s.slice(s.indexOf(".insert({"), s.indexOf("})", s.indexOf(".insert({")));
    assert(ins.length > 20 && !/campo_tempo|checkpoint|janela_/.test(ins), ins);
    assert(/ASYNC_SYNC_JOBS_ENABLED/.test(s), "iniciar perdeu o gate da flag");
  });
  t("I2. /api/sync (cron diario) nao usa sync_jobs nem o claim", () => {
    const s = ler("app/api/sync/route.ts").replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "");
    assert(!/sync_jobs|claim_next_sync_job/.test(s), "cron diario passou a usar sync_jobs");
  });
  t("I3. worker canonico, coordenador, planner, motores, canonicos, rotas legadas e sync-on-read INTOCADOS desde a base", () => {
    // SALES-SYNC-C3 muda DE PROPOSITO a camada de credencial Shopee (CAS do refresh):
    // lib/shopee-auth.ts e lib/marketplace/credenciais.ts saem desta lista — quem os
    // guarda agora e scripts/testar-shopee-token-cas.ts (+ testar-credenciais-marketplace).
    const d = execFileSync("git", ["diff", "--name-only", BASE, "--", "lib/vendas", "lib/mercado-livre/ingestao", "lib/shopee/ingestao", "lib/sync-ml.ts", "lib/sync-shopee.ts",
      "lib/ml-auth.ts", "app/api/sync", "app/api/internal", "app/api/ml/vendas", "app/api/shopee/vendas", "vercel.json", "lib/feature-flags.ts"], { cwd: RAIZ, encoding: "utf8" }).trim();
    assert(d === "", d);
  });
  t("I4. a unica migration nova e a do fence, e ela nao toca idx_sync_jobs_loja_ativo (so comentario)", () => {
    const novos = execFileSync("git", ["diff", "--name-only", BASE, "--", "supabase"], { cwd: RAIZ, encoding: "utf8" }).trim().split(/\r?\n/).filter(Boolean);
    const naoRastreados = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--", "supabase"], { cwd: RAIZ, encoding: "utf8" }).trim().split(/\r?\n/).filter(Boolean);
    const todos = [...new Set([...novos, ...naoRastreados])];
    assert(todos.length === 1 && todos[0] === MIGRATION, todos.join(", "));
    assert(!/idx_sync_jobs_loja_ativo/.test(sql.replace(/^--.*$/gm, "")), "migration toca o indice");
  });

  await fila;
  console.log(`\n${falhou === 0 ? "✓" : "✗"} SYNC-LEGACY-FENCE — ${passou} passaram, ${falhou} falharam`);
  process.exit(falhou === 0 ? 0 : 1);
}
principal().catch((e) => { console.error("ERRO FATAL", e); process.exit(1); });
