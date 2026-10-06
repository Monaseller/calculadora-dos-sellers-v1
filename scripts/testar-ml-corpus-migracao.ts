/**
 * Guard da migration ML-CORPUS-A (FOUNDATION, nao aplicada).
 *
 *  1. SQL exato: tabela ml_pedidos (grao loja + order_id, FK do dono),
 *     indice de consulta, REVOKE de PUBLIC/anon/authenticated, RLS, e a
 *     AMPLIACAO do CHECK de sync_jobs.campo_tempo (superconjunto do atual);
 *  2. legado intocado: nada em `pedidos`, nenhum GRANT/POLICY/FORCE/DISABLE;
 *  3. auto-teste: variantes ruins sao pegas.
 *
 * Uso: npx tsx scripts/testar-ml-corpus-migracao.ts
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
const ARQ = "supabase/migrations/20261028_ml_corpus_foundation.sql";
const SQL = readFileSync(join(RAIZ, ARQ), "utf8");
const semComentarios = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
const stmts = (s: string) => semComentarios(s).split(";").map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean);

const ESPERADO = [
  "BEGIN",
  "SET LOCAL lock_timeout = '5s'",
  "CREATE TABLE public.ml_pedidos ( user_id text NOT NULL, loja_id uuid NOT NULL, order_id text NOT NULL, date_created timestamptz NULL, date_closed timestamptz NULL, last_updated timestamptz NULL, status text NULL, cancel_detail_code text NULL, total_amount numeric NULL, unidades integer NULL, fetched_at timestamptz NOT NULL, CONSTRAINT ml_pedidos_pkey PRIMARY KEY (loja_id, order_id), CONSTRAINT ml_pedidos_loja_do_mesmo_dono FOREIGN KEY (loja_id, user_id) REFERENCES public.lojas (id, user_id) )",
  "CREATE INDEX idx_ml_pedidos_dono_loja_date_closed ON public.ml_pedidos (user_id, loja_id, date_closed)",
  "REVOKE ALL PRIVILEGES ON TABLE public.ml_pedidos FROM PUBLIC, anon, authenticated",
  "ALTER TABLE public.ml_pedidos ENABLE ROW LEVEL SECURITY",
  "ALTER TABLE public.sync_jobs DROP CONSTRAINT sync_jobs_campo_tempo_check, ADD CONSTRAINT sync_jobs_campo_tempo_check CHECK (campo_tempo IS NULL OR campo_tempo IN ('update_time', 'create_time', 'date_closed'))",
  "COMMIT",
];

/** Violacoes (vazio = valido). */
function validar(sqlBruto: string): string[] {
  const e: string[] = [];
  const s = stmts(sqlBruto);
  if (JSON.stringify(s) !== JSON.stringify(ESPERADO)) e.push(`statements diferentes: ${JSON.stringify(s).slice(0, 240)}`);
  const sc = semComentarios(sqlBruto);
  if (/\b(GRANT|CREATE POLICY|ALTER POLICY|FORCE ROW LEVEL SECURITY|DISABLE ROW LEVEL SECURITY)\b/i.test(sc)) e.push("grant/policy/force/disable");
  if (/\bpublic\.pedidos\b|\bTABLE pedidos\b/i.test(sc)) e.push("toca pedidos (legado)");
  // o CHECK novo e SUPERCONJUNTO do aplicado (S2-D1): toda linha existente segue valida
  const m = sc.match(/sync_jobs_campo_tempo_check CHECK \(campo_tempo IS NULL OR campo_tempo IN \(([^)]*)\)\)/);
  const valores = m ? m[1].split(",").map((x) => x.trim().replace(/'/g, "")) : [];
  if (!["update_time", "create_time"].every((v) => valores.includes(v))) e.push("CHECK de campo_tempo deixou de aceitar valor existente");
  return e;
}

console.log("\n[1-2. conteudo e legado]");
t("1. SQL exato (tabela fechada, FK do dono, PK por loja, indice, CHECK ampliado) e legado intocado", () => {
  const e = validar(SQL); assert(e.length === 0, e.join(" | "));
});
t("1b. cabecalho documenta rollback e que NAO esta aplicada", () => {
  assert(/NAO APLICADA/.test(SQL) && /ROLLBACK \(MANUAL/.test(SQL), "cabecalho");
});

console.log("\n[3. auto-teste]");
const v = (de: RegExp | string, para: string) => SQL.replace(de, para);
const pega = (sql: string, re: RegExp) => validar(sql).some((x) => re.test(x));
t("3a. sem REVOKE → pego", () => assert(pega(v(/^REVOKE ALL PRIVILEGES[^\n]*\n/m, ""), /statements/), "nao pegou"));
t("3b. REVOKE so de anon → pego", () => assert(pega(v("FROM PUBLIC, anon, authenticated;", "FROM anon;"), /statements/), "nao pegou"));
t("3c. PK sem loja (so order_id) → pego", () => assert(pega(v("PRIMARY KEY (loja_id, order_id)", "PRIMARY KEY (order_id)"), /statements/), "nao pegou"));
t("3d. FK sem o dono → pego", () => assert(pega(v("FOREIGN KEY (loja_id, user_id) REFERENCES public.lojas (id, user_id)", "FOREIGN KEY (loja_id) REFERENCES public.lojas (id)"), /statements/), "nao pegou"));
t("3e. CHECK que remove create_time → pego", () => assert(pega(v("('update_time', 'create_time', 'date_closed')", "('update_time', 'date_closed')"), /deixou de aceitar/), "nao pegou"));
t("3f. GRANT/POLICY ou mexer em pedidos → pego", () => {
  assert(pega(v(/^COMMIT;/m, "GRANT SELECT ON public.ml_pedidos TO anon;\nCOMMIT;"), /grant/), "grant");
  assert(pega(v(/^COMMIT;/m, "ALTER TABLE public.pedidos ADD COLUMN x int;\nCOMMIT;"), /pedidos/), "pedidos");
});
t("3g. as variantes de fato mudam o SQL", () => {
  assert(v("FROM PUBLIC, anon, authenticated;", "FROM anon;") !== SQL && v("PRIMARY KEY (loja_id, order_id)", "PRIMARY KEY (order_id)") !== SQL, "vazio");
});

console.log(`\n${falhou === 0 ? "✓" : "✗"} ML-CORPUS-MIGRACAO — ${passou} passaram, ${falhou} falharam`);
process.exit(falhou === 0 ? 0 : 1);
