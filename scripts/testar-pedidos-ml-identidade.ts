/**
 * CDS V2 — Vendas A4-C: identidade da linha de venda ML como UNIQUE do banco.
 *
 * Executa o ARQUIVO REAL supabase/migrations/20261110_pedidos_ml_identidade.sql (comando a comando) sobre
 * um banco em memória (scripts/_guard-v2-sql.ts): prechecks e validações saem do SQL; o índice criado é
 * o do arquivo, aplicado às escritas seguintes. Prova: mesma identidade (loja, pedido, item, variação ou
 * vazio) recusada mesmo com PKs diferentes (legado × novo), variações/lojas/marketplaces diferentes
 * permitidos, NULL de variação como identidade determinística, prechecks fail-closed (índice já existe,
 * coluna diferente, duplicata, sentinel em uso, marketplace errado), nenhuma escrita de dados, I15.
 *
 * LIMITE (honesto): o interpretador NÃO substitui o PostgreSQL — não prova o parser real, locks reais
 * nem a forma canônica de pg_indexes.indexdef; a aplicação em produção é gate próprio.
 *
 * Uso: npx tsx scripts/testar-pedidos-ml-identidade.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Banco, type Linha, type Restricoes, comandosDoScript, declararColunas, executarScript, inserirLinha } from "./_guard-v2-sql";
import { identidadeVendaMLNaoNoBanco, invariantesV2 } from "./_guard-v2";

let ok = 0, falhou = 0;
const imprimir = console.log.bind(console);
function t(nome: string, fn: () => void) {
  try { fn(); ok++; imprimir(`  PASS  ${nome}`); }
  catch (e: any) { falhou++; imprimir(`  FALHA ${nome} -> ${e?.message ?? e}`); }
}
function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }

const RAIZ = join(__dirname, "..");
const MIGRACAO = "supabase/migrations/20261110_pedidos_ml_identidade.sql";
const BRUTO = readFileSync(join(RAIZ, MIGRACAO), "utf8").replace(/\r\n/g, "\n");
const SQL = comandosDoScript(BRUTO).join(";\n") + ";";
const P = "public.pedidos";
const U = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LA = "11111111-1111-4111-8111-111111111111", LB = "22222222-2222-4222-8222-222222222222";

/** Colunas da identidade como em produção (information_schema, auditado em 2026-10-14). */
const COLUNAS: Array<[string, string, boolean, string | null]> = [
  ["id", "text", false, null], ["user_id", "text", false, null], ["marketplace", "text", false, null], ["order_id", "text", false, null],
  ["ml_item_id", "text", true, null], ["variation_id", "text", true, null], ["loja_id", "uuid", true, null], ["qtd", "integer", true, "1"],
];
const restricoes: Restricoes = () => {};
const pedido = (id: string, loja: string | null, order: string, item: string | null, variacao: string | null, marketplace = "ML"): Linha =>
  ({ id, user_id: U, marketplace, order_id: order, ml_item_id: item, variation_id: variacao, loja_id: loja, qtd: 1 });
function banco(linhas: Linha[] = [pedido(`${U}_ML_1_MLB1`, LA, "1", "MLB1", null)], colunas = COLUNAS): Banco {
  const db: Banco = { tabelas: { [P]: linhas.map((l) => ({ ...l })) }, temp: {}, funcoes: {}, gatilhos: [], config: {}, locks: [] };
  declararColunas(db, P, colunas.map(([nome, tipo, nula, padrao]) => ({ nome, tipo, nula, padrao })));
  return db;
}
const aplicar = (db: Banco) => executarScript(SQL, db, restricoes);
function migrado(linhas?: Linha[]): Banco { const r = aplicar(banco(linhas)); assert(r.ok, `migration falhou: ${(r as any).erro}`); return r.db; }
const recusa = (db: Banco, l: Linha) => { try { inserirLinha(db, P, l, restricoes); return ""; } catch (e: any) { return String(e.message); } };

imprimir("\n[1. a migration aplica sobre o estado auditado e não muda dados]");
t("A4-C0. aplica: índice pedidos_ml_identidade_uq criado (único, válido, pronto); dados idênticos; lock SHARE + timeouts locais", () => {
  const linhas = [pedido(`${U}_ML_1_MLB1`, LA, "1", "MLB1", null), pedido(`${U}_SHOPEE_9_1_nv`, LA, "9", "1", null, "Shopee")];
  const db0 = banco(linhas), antes = JSON.stringify(db0.tabelas);
  const r = aplicar(db0);
  assert(r.ok && JSON.stringify(r.db.tabelas) === antes, `${(r as any).erro} / dados mudaram`);
  const idx = (r.db.indices ?? []).filter((i) => i.nome === "pedidos_ml_identidade_uq");
  assert(idx.length === 1 && idx[0].valido && idx[0].pronto && idx[0].tabela === P, JSON.stringify(idx.map((i) => i.def)));
  assert(r.db.locks.some((l) => l.tabela === P && l.modo === "share") && r.db.config["lock_timeout"] === "5s", JSON.stringify({ l: r.db.locks, c: r.db.config }));
});

imprimir("\n[2. o índice protege a identidade semântica]");
t("A4-C1. mesma loja/pedido/item SEM variação duas vezes (PKs diferentes) → viola", () => {
  const db = migrado();
  assert(/duplicate key value violates unique constraint "pedidos_ml_identidade_uq"/.test(recusa(db, pedido(`${U}_ML_${LA}_1_MLB1_nv`, LA, "1", "MLB1", null))), "duplicata sem variação aceita");
});
t("A4-C2. mesma loja/pedido/item/variação A duas vezes → viola", () => {
  const db = migrado([pedido("x1", LA, "2", "MLB2", "10")]);
  assert(/pedidos_ml_identidade_uq/.test(recusa(db, pedido("x2", LA, "2", "MLB2", "10"))), "duplicata com variação aceita");
});
t("A4-C3. mesma loja/pedido/item com variações A e B → permitido; variação A ≠ sem variação", () => {
  const db = migrado([pedido("x1", LA, "3", "MLB3", "10")]);
  assert(recusa(db, pedido("x2", LA, "3", "MLB3", "20")) === "" && recusa(db, pedido("x3", LA, "3", "MLB3", null)) === "", "variações distintas recusadas");
});
t("A4-C4. lojas A e B com o mesmo pedido/item/variação → permitido", () => {
  const db = migrado([pedido("a", LA, "4", "MLB4", "1")]);
  assert(recusa(db, pedido("b", LB, "4", "MLB4", "1")) === "", "lojas diferentes colidiram");
});
t("A4-C5. Shopee com a mesma identidade → índice ML não interfere", () => {
  const db = migrado([pedido("m", LA, "5", "5001", null)]);
  assert(recusa(db, pedido("s1", LA, "5", "5001", null, "Shopee")) === "" && recusa(db, pedido("s2", LA, "5", "5001", null, "Shopee")) === "", "índice ML pegou Shopee");
});
t("A4-C6/C7. PK legado × PK novo com a MESMA identidade ML → viola (a identidade não depende de pedidos.id)", () => {
  const db = migrado([pedido(`${U}_ML_6_MLB6`, LA, "6", "MLB6", "61")]);
  assert(/pedidos_ml_identidade_uq/.test(recusa(db, pedido(`${U}_ML_${LA}_6_MLB6_61`, LA, "6", "MLB6", "61"))), "legado e novo coexistiram com a mesma identidade");
  assert(/pedidos_ml_identidade_uq/.test(recusa(db, pedido("qualquer-outro-id", LA, "6", "MLB6", "61"))), "PK arbitrário escapou da identidade");
});
t("A4-C9. variação NULL é UMA identidade determinística (coalesce); identidade incompleta (sem loja/item) fica de fora, explicitamente", () => {
  const db = migrado([pedido("n1", LA, "9", "MLB9", null)]);
  assert(/pedidos_ml_identidade_uq/.test(recusa(db, pedido("n2", LA, "9", "MLB9", null))), "NULL tratado como distinto");
  assert(recusa(db, pedido("s1", null, "9", "MLB9", null)) === "" && recusa(db, pedido("s2", null, "9", "MLB9", null)) === "", "sem loja deveria estar FORA do índice (não protegida por NULL)");
  const idx = (db.indices ?? []).find((i) => i.nome === "pedidos_ml_identidade_uq")!;
  assert(/coalesce\(variation_id, ''\)/i.test(idx.def) && /marketplace = 'ML' and loja_id is not null and ml_item_id is not null/i.test(idx.def), idx.def);
});

imprimir("\n[3. prechecks fail-closed (nada muda quando falham)]");
const falha = (db: Banco, padrao: RegExp, rotulo: string) => {
  const antes = JSON.stringify(db.tabelas);
  const r = aplicar(db);
  assert(!r.ok && padrao.test((r as any).erro) && JSON.stringify(r.db.tabelas) === antes && !(r.db.indices ?? []).some((i) => i.nome === "pedidos_ml_identidade_uq"), `${rotulo}: ${(r as any).erro}`);
};
t("P-A. índice com o mesmo nome já existe → falha (nunca substitui)", () => {
  const db = migrado();
  const r = aplicar(db);
  assert(!r.ok && /PRECHECK A/.test((r as any).erro), String((r as any).erro));
});
t("P-B. coluna da identidade com tipo diferente → falha", () => {
  falha(banco(undefined, COLUNAS.map((c) => (c[0] === "loja_id" ? ["loja_id", "text", true, null] : c) as [string, string, boolean, string | null])), /PRECHECK B/, "tipo");
});
t("P-C. duplicata semântica existente → falha (não deduplica)", () => {
  falha(banco([pedido("d1", LA, "1", "MLB1", null), pedido("d2", LA, "1", "MLB1", null)]), /PRECHECK C/, "duplicata");
});
t("P-D. variation_id = '' em uso (sentinel inseguro) → falha", () => {
  falha(banco([pedido("e1", LA, "1", "MLB1", "")]), /PRECHECK D/, "sentinel");
});
t("P-E. sem rows ML (marketplace diferente do auditado) → falha", () => {
  falha(banco([pedido("x", LA, "1", "MLB1", null, "MercadoLivre")]), /PRECHECK E/, "marketplace");
});

imprimir("\n[4. o arquivo]");
t("A4-C8. a migration não contém UPDATE/DELETE/INSERT/backfill, nem NOT NULL, DROP, CONCURRENTLY, SKU ou pedidos.id na identidade", () => {
  const cmds = comandosDoScript(BRUTO).join("\n").toLowerCase();
  assert(!/\b(update|delete|insert|truncate)\b\s/.test(cmds.replace(/'[^']*'/g, "")) && !/set not null|drop\s|concurrently|\bsku\b/.test(cmds), "escrita/alteração proibida no SQL");
  assert(!/\(\s*id\b|,\s*id\s*[,)]/.test(/create unique index[^;]*/.exec(cmds)?.[0] ?? "x"), "pedidos.id na identidade");
});
t("I15. Guard V2 limpo (I15_ML_SALE_IDENTITY_IS_DB_UNIQUE + demais)", () => {
  const i15 = identidadeVendaMLNaoNoBanco(), v2 = invariantesV2(undefined, { zonas: false });
  assert(i15.length === 0 && v2.length === 0, [...i15, ...v2].join(" | "));
});

imprimir(`\n${falhou === 0 ? "✓" : "✗"} PEDIDOS-ML-IDENTIDADE — ${ok} passaram, ${falhou} falharam`);
process.exit(falhou === 0 ? 0 : 1);
