/**
 * Guard da migration de CUTOVER Shopee (S2-D2.2) — chave unica de item por loja.
 *
 *  1. o arquivo fica FORA de supabase/migrations (nenhuma ferramenta aplica
 *     sozinha) e nenhuma migration aplicavel cria esse indice;
 *  2. o SQL e exatamente: BEGIN; o indice unico parcial Shopee
 *     (loja_id, order_id, ml_item_id, variation_id) NULLS NOT DISTINCT; COMMIT;
 *  3. o cabecalho documenta as 4 condicoes de aplicacao e a auditoria de
 *     duplicatas que tem de dar 0 no dia;
 *  4. auto-teste do validador com variantes ruins.
 *
 * Uso: npx tsx scripts/testar-s2-cutover-migracao.ts
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

let passou = 0, falhou = 0;
function t(nome: string, fn: () => void) {
  try { fn(); passou++; console.log(`  PASS  ${nome}`); }
  catch (e: any) { falhou++; console.log(`  FALHA ${nome} -> ${e?.message ?? e}`); }
}
function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }

const RAIZ = join(__dirname, "..");
const ARQ = "supabase/cutover/PENDENTE_s2_cutover_shopee_item_store_unique.sql";
const NOME = "pedidos_shopee_item_por_loja_unico";
const semComentarios = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

/** Violacoes do SQL de cutover (vazio = valido). */
function validarCutover(sqlBruto: string): string[] {
  const e: string[] = [];
  const stmts = semComentarios(sqlBruto).split(";").map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean);
  const esperado = [
    "BEGIN",
    `CREATE UNIQUE INDEX ${NOME} ON public.pedidos (loja_id, order_id, ml_item_id, variation_id) NULLS NOT DISTINCT WHERE marketplace = 'Shopee'`,
    "COMMIT",
  ];
  if (JSON.stringify(stmts) !== JSON.stringify(esperado)) e.push(`statements diferentes do esperado: ${JSON.stringify(stmts).slice(0, 220)}`);
  const coment = sqlBruto.split(/\r?\n/).filter((l) => /^\s*--/.test(l)).join("\n");
  for (const [k, re] of [
    ["condicao 1 (motor novo e o writer oficial)", /writer oficial/i],
    ["condicao 2 (legado desabilitado ou atualizado)", /desabilitado ou atualizado/i],
    ["condicao 3 (auditoria de 0 duplicatas no dia)", /IMEDIATAMENTE anterior[\s\S]*0 duplicatas|tem que ser 0/i],
    ["condicao 4 (erro de gravacao nunca ignorado)", /ignore erro de grava/i],
    ["consulta de auditoria", /GROUP BY 1, 2, 3, 4 HAVING count\(\*\) > 1/i],
    ["aviso NAO APLICAR AINDA", /NAO APLICAR AINDA/i],
    ["regra de timestamp no cutover", /timestamp MAIOR/i],
  ] as const) if (!re.test(coment)) e.push(`cabecalho sem ${k}`);
  return e;
}

const SQL = readFileSync(join(RAIZ, ARQ), "utf8");

console.log("\n[1. localizacao]");
t("1a. o cutover existe e fica FORA de supabase/migrations", () => {
  assert(existsSync(join(RAIZ, ARQ)) && !ARQ.startsWith("supabase/migrations/"), ARQ);
});
t("1b. nenhuma migration aplicavel cria a chave unica de item por loja", () => {
  const dir = join(RAIZ, "supabase/migrations");
  const com = readdirSync(dir).filter((f) => f.endsWith(".sql") && new RegExp(`CREATE UNIQUE INDEX ${NOME}`, "i").test(semComentarios(readFileSync(join(dir, f), "utf8"))));
  assert(com.length === 0, com.join(", "));
});

console.log("\n[2-3. conteudo]");
t("2-3. SQL exato (indice unico parcial Shopee, NULLS NOT DISTINCT, transacional) e condicoes documentadas", () => {
  const e = validarCutover(SQL);
  assert(e.length === 0, e.join(" | "));
});

console.log("\n[4. auto-teste]");
const v = (de: RegExp | string, para: string) => SQL.replace(de, para);
const pega = (sql: string, re: RegExp) => validarCutover(sql).some((x) => re.test(x));
t("4a. sem NULLS NOT DISTINCT → pego", () => assert(pega(v(/ NULLS NOT DISTINCT(\r?\n)/, "$1"), /statements diferentes/), "nao pegou"));
t("4b. sem o WHERE marketplace = 'Shopee' (afetaria o ML) → pego", () => assert(pega(v(/\r?\n\s*WHERE marketplace = 'Shopee';/, ";"), /statements diferentes/), "nao pegou"));
t("4c. statement extra (ex.: DROP de outro indice) → pego", () => assert(pega(v(/^COMMIT;/m, "DROP INDEX public.idx_pedidos_loja_id;\nCOMMIT;"), /statements diferentes/), "nao pegou"));
t("4d. sem a condicao de auditoria no cabecalho → pego", () => assert(pega(v(/GROUP BY 1, 2, 3, 4 HAVING count\(\*\) > 1/, "GROUP BY 1"), /consulta de auditoria/), "nao pegou"));
t("4e. as variantes de fato alteram o arquivo (auto-teste nao vazio)", () => {
  assert(v(/ NULLS NOT DISTINCT(\r?\n)/, "$1") !== SQL && v(/\r?\n\s*WHERE marketplace = 'Shopee';/, ";") !== SQL, "variante vazia");
});

console.log(`\n${falhou === 0 ? "✓" : "✗"} S2-CUTOVER-MIGRACAO — ${passou} passaram, ${falhou} falharam`);
process.exit(falhou === 0 ? 0 : 1);
