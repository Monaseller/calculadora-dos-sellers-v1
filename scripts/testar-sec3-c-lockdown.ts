/**
 * Guard offline da migration SEC-3-C (lockdown das 15 tabelas públicas).
 *
 * Lê o SQL (sem comentários) e prova, para as 15 tabelas EXATAS:
 *  - REVOKE ALL de anon E authenticated, numa lista que é exatamente as 15;
 *  - ENABLE ROW LEVEL SECURITY em cada uma, sem tabela faltando ou extra;
 *  - nenhuma policy (CREATE POLICY), nenhum GRANT, nenhum FORCE/DISABLE RLS;
 *  - tudo dentro de BEGIN/COMMIT;
 *  - o rollback documentado restaura exatamente o precheck (comentário).
 * O validador é uma função pura e é auto-testado com SQL sintético ruim.
 *
 * Uso: npx tsx scripts/testar-sec3-c-lockdown.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

let passou = 0, falhou = 0;
function t(nome: string, fn: () => void) {
  try { fn(); passou++; console.log(`  PASS  ${nome}`); }
  catch (e: any) { falhou++; console.log(`  FALHA ${nome} -> ${e?.message ?? e}`); }
}
function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }

const RAIZ = join(__dirname, "..");
const ARQUIVO = "supabase/migrations/20261026_sec3c_lockdown_tabelas_publicas.sql";

const TABELAS = [
  "pedidos", "anuncios", "sync_jobs", "vendas_dia", "dashboard_resumos_diarios",
  "estudio_anuncios_conteudo_versoes", "estudio_anuncios_imagens_origem", "estudio_anuncios_jobs",
  "estudio_anuncios_pipeline", "estudio_anuncios_pipeline_catalogo", "estudio_anuncios_pipeline_catalogo_jobs",
  "estudio_anuncios_projetos", "estudio_anuncios_projetos_marketplace", "estudio_anuncios_resultados_pipeline",
  "estudio_anuncios_validacoes_publicacao",
].sort();

function semComentarios(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
}
const tabelasDe = (lista: string) =>
  lista.split(",").map((s) => s.trim().replace(/^public\./i, "")).filter(Boolean).sort();

/** Devolve a lista de violações (vazia = migration válida). */
function validar(sqlBruto: string): string[] {
  const erros: string[] = [];
  const sql = semComentarios(sqlBruto);
  const stmts = sql.split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);

  if (stmts[0]?.toUpperCase() !== "BEGIN") erros.push("primeiro statement nao e BEGIN");
  if (stmts[stmts.length - 1]?.toUpperCase() !== "COMMIT") erros.push("ultimo statement nao e COMMIT");

  const revokes = stmts.filter((s) => /^REVOKE /i.test(s));
  if (revokes.length !== 1) erros.push(`esperado 1 REVOKE, achei ${revokes.length}`);
  for (const r of revokes) {
    const m = r.match(/^REVOKE ALL PRIVILEGES ON TABLE (.+) FROM (.+)$/i);
    if (!m) { erros.push(`REVOKE fora do formato: ${r.slice(0, 80)}`); continue; }
    const tabs = tabelasDe(m[1]);
    if (JSON.stringify(tabs) !== JSON.stringify(TABELAS)) {
      const faltam = TABELAS.filter((x) => !tabs.includes(x));
      const sobram = tabs.filter((x) => !TABELAS.includes(x));
      erros.push(`REVOKE: faltam [${faltam}] sobram [${sobram}]`);
    }
    const roles = m[2].split(",").map((s) => s.trim().toLowerCase()).sort();
    if (JSON.stringify(roles) !== JSON.stringify(["anon", "authenticated"])) erros.push(`REVOKE roles: ${roles}`);
  }

  const rls = stmts.filter((s) => /^ALTER TABLE /i.test(s));
  const habilitadas: string[] = [];
  for (const a of rls) {
    const m = a.match(/^ALTER TABLE (?:public\.)?(\w+) ENABLE ROW LEVEL SECURITY$/i);
    if (!m) { erros.push(`ALTER TABLE nao permitido: ${a.slice(0, 80)}`); continue; }
    habilitadas.push(m[1]);
  }
  const hab = [...habilitadas].sort();
  if (JSON.stringify(hab) !== JSON.stringify(TABELAS)) {
    erros.push(`ENABLE RLS: faltam [${TABELAS.filter((x) => !hab.includes(x))}] sobram [${hab.filter((x) => !TABELAS.includes(x))}]`);
  }
  if (new Set(habilitadas).size !== habilitadas.length) erros.push("ENABLE RLS duplicado");

  if (/\bFORCE\s+ROW\s+LEVEL\s+SECURITY\b/i.test(sql)) erros.push("FORCE RLS presente");
  if (/\bDISABLE\s+ROW\s+LEVEL\s+SECURITY\b/i.test(sql)) erros.push("DISABLE RLS presente");
  if (/\b(CREATE|ALTER)\s+POLICY\b/i.test(sql)) erros.push("POLICY presente");
  if (/\bGRANT\b/i.test(sql)) erros.push("GRANT presente");
  if (/\bALTER\s+DEFAULT\s+PRIVILEGES\b/i.test(sql)) erros.push("ALTER DEFAULT PRIVILEGES presente");

  const permitidos = stmts.filter((s) => !/^(BEGIN|COMMIT|REVOKE |ALTER TABLE )/i.test(s));
  if (permitidos.length) erros.push(`statements extras: ${permitidos.map((s) => s.slice(0, 40)).join(" | ")}`);
  return erros;
}

// CDS V2 Fase 0: forma LF (a do repositorio). Com core.autocrlf=true a copia de trabalho
// vem em CRLF e os mutantes 3a/3i (que removem um trecho terminado em "\n") viravam no-op.
const SQL = readFileSync(join(RAIZ, ARQUIVO), "utf8").replace(/\r\n/g, "\n");

console.log("\n[1. a migration real]");
t("1. a migration SEC-3-C e valida (15 exatas, REVOKE anon+authenticated, ENABLE RLS, sem policy/grant/force/disable)", () => {
  const e = validar(SQL);
  assert(e.length === 0, e.join(" | "));
});
t("2. o rollback documentado restaura exatamente o precheck (GRANT arw a anon + DISABLE RLS nas 15)", () => {
  const coment = SQL.split("\n").filter((l) => /^--/.test(l)).map((l) => l.replace(/^--\s?/, "")).join("\n");
  const g = coment.match(/GRANT SELECT, INSERT, UPDATE ON TABLE([\s\S]+?)TO anon;/);
  assert(g, "rollback sem GRANT");
  assert(JSON.stringify(tabelasDe(g[1])) === JSON.stringify(TABELAS), "rollback GRANT nao cobre as 15 exatas");
  const dis = [...coment.matchAll(/ALTER TABLE public\.(\w+) DISABLE ROW LEVEL SECURITY;/g)].map((m) => m[1]).sort();
  assert(JSON.stringify(dis) === JSON.stringify(TABELAS), `rollback DISABLE: ${dis}`);
  assert(!/authenticated/.test(g[0]), "rollback nao pode conceder a authenticated (nao tinha nada)");
});

console.log("\n[2. auto-teste do validador]");
const base = SQL;
const variante = (de: RegExp | string, para: string) => base.replace(de, para);
t("3a. tabela faltando no REVOKE e pega", () => {
  assert(validar(variante("  public.vendas_dia,\n", "")).some((e) => /REVOKE: faltam \[vendas_dia\]/.test(e)), "nao pegou");
});
t("3b. tabela extra (lojas) no ENABLE RLS e pega", () => {
  assert(validar(variante(/^COMMIT;$/m, "ALTER TABLE public.lojas ENABLE ROW LEVEL SECURITY;\nCOMMIT;")).some((e) => /sobram \[lojas\]/.test(e)), "nao pegou");
});
t("3c. REVOKE so de anon e pego", () => {
  assert(validar(variante("FROM anon, authenticated;", "FROM anon;")).some((e) => /REVOKE roles/.test(e)), "nao pegou");
});
t("3d. FORCE RLS e pego", () => {
  assert(validar(variante(/^COMMIT;$/m, "ALTER TABLE public.pedidos FORCE ROW LEVEL SECURITY;\nCOMMIT;")).some((e) => /FORCE/.test(e)), "nao pegou");
});
t("3e. DISABLE RLS e pego", () => {
  assert(validar(variante("ALTER TABLE public.anuncios ENABLE ROW LEVEL SECURITY;", "ALTER TABLE public.anuncios DISABLE ROW LEVEL SECURITY;")).some((e) => /DISABLE/.test(e)), "nao pegou");
});
t("3f. policy permissiva e pega", () => {
  assert(validar(variante(/^COMMIT;$/m, "CREATE POLICY todos ON public.pedidos FOR SELECT USING (true);\nCOMMIT;")).some((e) => /POLICY/.test(e)), "nao pegou");
});
t("3g. GRANT e pego", () => {
  assert(validar(variante(/^COMMIT;$/m, "GRANT SELECT ON public.pedidos TO anon;\nCOMMIT;")).some((e) => /GRANT/.test(e)), "nao pegou");
});
t("3h. sem BEGIN/COMMIT e pego", () => {
  const e = validar(base.replace(/^BEGIN;$/m, "").replace(/^COMMIT;$/m, ""));
  assert(e.some((x) => /BEGIN/.test(x)) && e.some((x) => /COMMIT/.test(x)), e.join("|"));
});
t("3i. ENABLE RLS faltando numa tabela e pego", () => {
  assert(validar(variante("ALTER TABLE public.sync_jobs ENABLE ROW LEVEL SECURITY;\n", "")).some((e) => /ENABLE RLS: faltam \[sync_jobs\]/.test(e)), "nao pegou");
});
t("3j. comentarios nao contam (o rollback em comentario nao reprova)", () => {
  assert(validar(base).length === 0 && /DISABLE ROW LEVEL SECURITY/.test(base), "comentario influenciou");
});

console.log(`\n${falhou === 0 ? "✓" : "✗"} SEC-3-C — ${passou} passaram, ${falhou} falharam`);
process.exit(falhou === 0 ? 0 : 1);
