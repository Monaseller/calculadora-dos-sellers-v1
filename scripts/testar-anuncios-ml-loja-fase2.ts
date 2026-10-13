/**
 * CDS V2 — Fase 2E: migration 20261108_anuncios_ml_loja_fase2.sql (PREPARADA, NÃO aplicada) — estado 3 → 4.
 *
 * Contrato:
 *   • precheck fail-closed A–J antes de qualquer DDL (estado 3 íntegro e esperado);
 *   • UNIQUE parcial anuncios_ml_identidade_uq (user_id, loja_id, marketplace, ml_item_id,
 *     coalesce(variation_id,'')) WHERE marketplace='ML' AND ml_item_id IS NOT NULL — rows ML manuais
 *     (sem ml_item_id) ficam fora e nunca colidem;
 *   • CHECK anuncios_ml_exige_loja (marketplace <> 'ML' OR loja_id IS NOT NULL), NOT VALID + VALIDATE;
 *   • função anuncios_loja_do_dono SEM ponte (não conta, não escolhe, não preenche loja_id), mantendo
 *     a validação permanente dono + marketplace sem exigir ativo; trigger inalterado;
 *   • validação final V1–V11 com snapshot; nenhum dado muda; contratos Shopee intocados.
 *
 * Semântica: o estado 3 é montado executando a 20261107 REAL sobre o estado 2; depois a 20261108 REAL é
 * executada comando a comando por scripts/_guard-v2-sql.ts — prechecks, snapshot, DDL, função e validações
 * saem do SQL; catálogos (pg_indexes, pg_class, pg_index, pg_constraint, pg_proc, pg_trigger) são
 * derivados do estado emulado. Objetos já existentes em produção (UNIQUE/CHECK Shopee) são declarados com a
 * definição EXATA do catálogo de produção. Os contadores A–E também têm ORÁCULO independente (diferencial).
 *
 * LIMITE (honesto): o interpretador NÃO substitui o PostgreSQL. Offline NÃO prova o parser real, a forma
 * canônica que o PostgreSQL dará ao indexdef/constraintdef novo, locks reais (ACCESS EXCLUSIVE,
 * lock_timeout/statement_timeout), atomicidade real do caminho de aplicação (SQL Editor não foi atômico na
 * 20261107), concorrência nem o planner. Sem banco real, sem rede.
 *
 * Uso: npx tsx scripts/testar-anuncios-ml-loja-fase2.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Banco, type Linha, type Restricoes, ErroSQL, atualizarLinha, comandosDoScript, consultar, contadorNoTraco,
  declararCheck, declararIndiceUnico, executarBlocoDo, executarScript, inserirLinha,
} from "./_guard-v2-sql";

let ok = 0, falhou = 0;
const imprimir = console.log.bind(console);
function t(nome: string, fn: () => void) {
  try { fn(); ok++; imprimir(`  PASS  ${nome}`); }
  catch (e: any) { falhou++; imprimir(`  FALHA ${nome} -> ${e?.message ?? e}`); }
}
function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }

const RAIZ = join(__dirname, "..");
const MIGRACAO = "supabase/migrations/20261108_anuncios_ml_loja_fase2.sql";
const FASE1 = "supabase/migrations/20261107_anuncios_ml_loja_fase1.sql";
const BRUTO = readFileSync(join(RAIZ, MIGRACAO), "utf8").replace(/\r\n/g, "\n");
/** SQL executável (sem comentários "--" fora de string). */
const SQL = comandosDoScript(BRUTO).join(";\n") + ";";
const SQL_FASE1 = readFileSync(join(RAIZ, FASE1), "utf8").replace(/\r\n/g, "\n");
const A = "public.anuncios", LJ = "public.lojas";

// ── Catálogo de produção (estado 3) — definições EXATAS auditadas ─────
const DEF_SHOPEE_UQ = "CREATE UNIQUE INDEX anuncios_shopee_identidade_uq ON public.anuncios USING btree (user_id, loja_id, marketplace, ml_item_id, COALESCE(variation_id, ''::text)) WHERE ((marketplace = 'Shopee'::text) AND (ml_item_id IS NOT NULL))";
const DEF_SHOPEE_CK = "CHECK (((marketplace <> 'Shopee'::text) OR (loja_id IS NOT NULL)))";
const DEF_TRIGGER = "CREATE TRIGGER anuncios_loja_do_dono BEFORE INSERT OR UPDATE OF loja_id, user_id, marketplace ON public.anuncios FOR EACH ROW EXECUTE FUNCTION anuncios_loja_do_dono()";
/** Forma que o PostgreSQL deve dar ao novo índice (esperada; offline não prova a canonização real). */
const DEF_ML_UQ_ESPERADA = "CREATE UNIQUE INDEX anuncios_ml_identidade_uq ON public.anuncios USING btree (user_id, loja_id, marketplace, ml_item_id, COALESCE(variation_id, ''::text)) WHERE ((marketplace = 'ML'::text) AND (ml_item_id IS NOT NULL))";

// Regras que nenhuma das migrations cria e que não estão no catálogo emulado: CHECK de marketplace e FK.
const restricoes: Restricoes = (db, tabela, r) => {
  if (tabela !== A) return;
  if (!["ML", "Shopee"].includes(r.marketplace)) throw new ErroSQL("anuncios_marketplace_check");
  if (r.loja_id != null && !db.tabelas[LJ].some((l) => l.id === r.loja_id)) throw new ErroSQL("anuncios_loja_id_fkey");
};
const SCRIPT_ESTADO_2 = `begin;
create or replace function public.anuncios_loja_do_dono() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.loja_id is not null and not exists (select 1 from public.lojas l where l.id = new.loja_id and l.user_id = new.user_id) then
    raise exception 'anuncios.loja_id nao pertence ao dono do anuncio' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger anuncios_loja_do_dono before insert or update of loja_id, user_id on public.anuncios for each row execute function public.anuncios_loja_do_dono();
commit;`;
const inserir = (db: Banco, l: Linha) => inserirLinha(db, A, l, restricoes);
const atualizar = (db: Banco, id: string, p: Linha) => atualizarLinha(db, A, id, p, restricoes);
const aplicar = (sql: string, db: Banco) => executarScript(sql, db, restricoes);
const anuncios = (db: Banco) => db.tabelas[A];
const tenta = (fn: () => void) => { try { fn(); return null; } catch (e: any) { return String(e?.message ?? e); } };

// ── Cenário: estado 2 → 20261107 real → estado 3 multi-loja ─────────
const D = (n: number) => `d000000${n}-0000-4000-8000-000000000000`;
const L = (n: number) => `10000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
function loja(n: number, dono: string, marketplace: "ML" | "Shopee", extra: Linha = {}): Linha {
  return { id: L(n), user_id: dono, marketplace, ativo: true, seller_id: `s${n}`, created_at: "2026-06-01", ...extra };
}
let seq = 0;
function anuncio(dono: string | null, marketplace: "ML" | "Shopee", item: string | null, variacao: string | null, extra: Linha = {}): Linha {
  return { id: `an-${String(++seq).padStart(4, "0")}`, user_id: dono, marketplace, ml_item_id: item, variation_id: variacao, loja_id: null,
    sku: null, ativo: true, nome: `n-${item}`, preco_anuncio: 10, custo_produto: 0, thumbnail: `t-${item}`, created_at: "2026-06-26", ...extra };
}
function estado2(): Banco {
  seq = 0;
  const lojas = [loja(1, D(1), "ML"), loja(2, D(1), "Shopee"), loja(3, D(1), "Shopee"), loja(4, D(2), "ML"),
    loja(5, D(3), "ML", { ativo: false }), loja(8, D(5), "Shopee")];
  const rows = [
    anuncio(D(1), "ML", "MLB1", null), anuncio(D(1), "ML", "MLB2", "501"), anuncio(D(1), "ML", "MLB2", "502", { ativo: false }),
    anuncio(D(2), "ML", "MLB1", null), anuncio(D(3), "ML", "MLB7", null, { sku: "SKU-USER", custo_produto: 30 }),
    anuncio(D(1), "Shopee", "7001", null, { loja_id: L(2) }), anuncio(D(1), "Shopee", "7001", null, { loja_id: L(3) }),
    anuncio(D(5), "Shopee", "8001", "9", { loja_id: L(8) }),
  ];
  const r = executarScript(SCRIPT_ESTADO_2, { tabelas: { [A]: rows, [LJ]: lojas }, temp: {}, funcoes: {}, gatilhos: [], config: {}, locks: [] }, restricoes);
  if (!r.ok) throw new Error(`estado 2 não montou: ${r.erro}`);
  declararIndiceUnico(r.db, "anuncios_shopee_identidade_uq", A, "user_id, loja_id, marketplace, ml_item_id, coalesce(variation_id, '')",
    "marketplace = 'Shopee' and ml_item_id is not null", DEF_SHOPEE_UQ);
  declararCheck(r.db, "anuncios_shopee_exige_loja", A, "marketplace <> 'Shopee' or loja_id is not null", DEF_SHOPEE_CK);
  return r.db;
}
/** Estado 3 de produção: 20261107 REAL aplicada; depois o runtime 2D cria uma 2ª loja ML e rows nela. */
function estado3(): Banco {
  const r = aplicar(SQL_FASE1, estado2());
  if (!r.ok) throw new Error(`20261107 abortou: ${r.erro}`);
  const db = r.db;
  db.tabelas[LJ].push(loja(11, D(1), "ML"));                                             // 2ª loja ML do mesmo dono
  inserir(db, anuncio(D(1), "ML", "MLB1", null, { loja_id: L(11) }));                     // an-0009: mesmo item, outra loja
  inserir(db, anuncio(D(1), "ML", null, null, { loja_id: L(1), nome: "manual-1" }));      // an-0010: manual sem item
  inserir(db, anuncio(D(1), "ML", null, null, { loja_id: L(1), nome: "manual-2" }));      // an-0011: manual sem item
  return db;
}
function estado4(sql = SQL): Banco {
  const r = aplicar(sql, estado3());
  if (!r.ok) throw new Error(`migration abortou: ${r.erro}`);
  return r.db;
}
const linhaDe = (db: Banco, id: string) => anuncios(db).find((a) => a.id === id)!;

// ── Oráculo independente (só diferencial) ──
const ORACULO: Record<string, (db: Banco) => number> = {
  "PRECHECK A": (db) => anuncios(db).filter((a) => a.marketplace === "ML" && a.loja_id == null).length,
  "PRECHECK B": (db) => anuncios(db).filter((a) => a.loja_id != null && !db.tabelas[LJ].some((l) => l.id === a.loja_id)).length,
  "PRECHECK C": (db) => anuncios(db).filter((a) => db.tabelas[LJ].some((l) => l.id === a.loja_id && l.user_id !== a.user_id)).length,
  "PRECHECK D": (db) => anuncios(db).filter((a) => db.tabelas[LJ].some((l) => l.id === a.loja_id && l.marketplace !== a.marketplace)).length,
  "PRECHECK E": (db) => { const m = new Map<string, number>(); for (const a of anuncios(db)) if (a.marketplace === "ML" && a.ml_item_id != null) { const k = [a.user_id, a.loja_id, a.ml_item_id, a.variation_id ?? ""].join("|"); m.set(k, (m.get(k) ?? 0) + 1); } return [...m.values()].filter((n) => n > 1).length; },
};

// ── Estrutura ──
const blocosDo = (sql: string) => [...sql.matchAll(/\bdo\s+\$\$([\s\S]*?)\$\$\s*;/gi)].map((m) => m[1]);
const blocoCom = (sql: string, marca: RegExp) => blocosDo(sql).find((b) => marca.test(b)) ?? null;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Rótulo ativo: "if n > 0 then raise exception '<rótulo>" ou "if n <> 1 then raise exception '<rótulo>". */
const ativo = (bloco: string, rotulo: string) =>
  new RegExp(`if\\s+n\\s*(>\\s*0|<>\\s*1)\\s+then\\s+raise\\s+exception\\s+'${esc(rotulo)}`, "i").test(bloco);
/** Comandos de topo que são DDL (strings dentro de blocos DO não contam). */
const DDL = comandosDoScript(BRUTO).filter((c) => /^(create|drop|alter|reindex|comment)\b/i.test(c));
const SELECT_SNAPSHOT = /create\s+temp\s+table\s+(\w+)\s+on\s+commit\s+drop\s+as\s+([\s\S]*?);/i.exec(SQL);
const FUNCAO = /create\s+or\s+replace\s+function[\s\S]*?\$\$([\s\S]*?)\$\$\s*;/i.exec(SQL)?.[1] ?? "";

imprimir(`\n[ANUNCIOS ML LOJA fase 2 — ${MIGRACAO}]`);
imprimir("\n[1. estrutura]");

t("S1. uma transação; PRECHECK A–J ativos ANTES de qualquer DDL; V1–V11 ativos DEPOIS do DDL", () => {
  assert(/^\s*begin\s*;/im.test(SQL) && /commit\s*;\s*$/i.test(SQL), "sem begin/commit");
  const iPre = SQL.search(/PRECHECK A/);
  const iDdl = Math.min(...[/create\s+unique\s+index/i, /alter\s+table/i, /create\s+or\s+replace\s+function/i, /create\s+temp/i].map((r) => { const i = SQL.search(r); return i < 0 ? Infinity : i; }));
  assert(iPre > 0 && iPre < iDdl, "precheck não vem antes do primeiro DDL");
  const pre = blocoCom(SQL, /PRECHECK A/) ?? "";
  for (const r of "ABCDEFGHIJ") assert(ativo(pre, `PRECHECK ${r}`), `PRECHECK ${r} ausente ou neutralizado`);
  const val = blocoCom(SQL, /V1:/) ?? "";
  for (let i = 1; i <= 11; i++) assert(ativo(val, `V${i}:`), `V${i} ausente ou neutralizado`);
  assert(SQL.search(/V1:/) > SQL.search(/validate\s+constraint/i) && SQL.search(/V1:/) > SQL.search(/create\s+or\s+replace\s+function/i), "validação antes do DDL");
});

t("S2. nenhum dado escrito; sem histórico de migrations; sem IF [NOT] EXISTS; sem CONCURRENTLY; Shopee e 20261107 não tocados", () => {
  assert(!/\b(insert\s+into|delete\s+from|truncate|update\s+public\.)/i.test(SQL), "escreve dado");
  assert(!/schema_migrations/i.test(SQL), "toca o histórico de migrations");
  assert(!/\bif\s+(not\s+)?exists\b/i.test(SQL), "IF [NOT] EXISTS mascarando divergência");
  assert(!/concurrently/i.test(SQL), "CONCURRENTLY não roda em transação");
  assert(!DDL.some((c) => /anuncios_shopee_/i.test(c)), "DDL nos contratos Shopee");
  assert(!DDL.some((c) => /^drop\b|\bdrop\s+constraint\b/i.test(c)), "DROP executável (rollback no arquivo?)");
});

t("S3. limites LOCAIS antes dos locks; locks exatos: anuncios ACCESS EXCLUSIVE, lojas SHARE", () => {
  const iBegin = SQL.search(/begin\s*;/i), iLock = SQL.search(/lock\s+table/i);
  const iLt = SQL.search(/set\s+local\s+lock_timeout\s*=\s*'5s'\s*;/i), iSt = SQL.search(/set\s+local\s+statement_timeout\s*=\s*'60s'\s*;/i);
  assert(iLt > iBegin && iSt > iBegin && iLt < iLock && iSt < iLock, "timeouts locais ausentes ou depois dos locks");
  assert(!/(^|;)\s*set\s+(session\s+)?(lock_timeout|statement_timeout)\b/im.test(SQL) && !/alter\s+(system|database|role)/i.test(SQL), "timeout global/de sessão");
  const locks = [...SQL.matchAll(/lock\s+table\s+public\.(\w+)\s+in\s+([\w\s]+?)\s+mode\s*;/gi)].map((m) => `${m[1]}:${m[2].toLowerCase().replace(/\s+/g, " ")}`);
  assert(JSON.stringify(locks) === JSON.stringify(["anuncios:access exclusive", "lojas:share"]), `locks: ${locks}`);
});

t("S4. UNIQUE ML exata: (user_id, loja_id, marketplace, ml_item_id, coalesce(variation_id,'')) WHERE marketplace='ML' AND ml_item_id IS NOT NULL", () => {
  const m = /create\s+unique\s+index\s+anuncios_ml_identidade_uq\s+on\s+public\.anuncios\s*\(([\s\S]*?)\)\s*where\s+([\s\S]*?);/i.exec(SQL);
  assert(m, "UNIQUE ML ausente");
  const cols = m![1].replace(/\s+/g, " ").trim(), onde = m![2].replace(/\s+/g, " ").trim();
  assert(cols === "user_id, loja_id, marketplace, ml_item_id, coalesce(variation_id, '')",`colunas: ${cols}`);
  assert(onde === "marketplace = 'ML' and ml_item_id is not null", `predicado: ${onde}`);
});

t("S5. CHECK final exato (marketplace <> 'ML' or loja_id is not null) NOT VALID + VALIDATE do MESMO nome; sem ml_item_id", () => {
  const m = /alter\s+table\s+public\.anuncios\s+add\s+constraint\s+anuncios_ml_exige_loja\s+check\s*\(([^;]*)\)\s+not\s+valid\s*;/i.exec(SQL);
  assert(m && m[1].replace(/\s+/g, " ").trim() === "marketplace <> 'ML' or loja_id is not null", `CHECK: ${m?.[1]}`);
  assert(/alter\s+table\s+public\.anuncios\s+validate\s+constraint\s+anuncios_ml_exige_loja\s*;/i.test(SQL), "sem VALIDATE");
  assert(SQL.search(/validate\s+constraint/i) > SQL.search(/add\s+constraint/i), "VALIDATE antes do ADD");
});

t("S6. função final sem ponte (sem :=, count(, ativo, declare, TRANSITIONAL); valida dono + marketplace; trigger não é recriado", () => {
  assert(FUNCAO, "função ausente");
  for (const r of [/:=/, /count\s*\(/i, /\bativo\b/i, /\bdeclare\b/i, /TRANSITIONAL/i, /\binto\b/i])
    assert(!r.test(FUNCAO), `função contém ${r}`);
  assert(/l\.id\s*=\s*new\.loja_id\s+and\s+l\.user_id\s*=\s*new\.user_id\s+and\s+l\.marketplace\s*=\s*new\.marketplace/i.test(FUNCAO), "validação dono + marketplace ausente");
  assert(!DDL.some((c) => /^(create|drop)\s+trigger\b/i.test(c)), "trigger recriado/derrubado");
});

t("S7. o interpretador executa o SCRIPT INTEIRO na ordem: begin, set local×2, lock×2, do(precheck), temp, unique, add check, validate, função, do(validação), commit", () => {
  const r = aplicar(SQL, estado3());
  assert(r.ok, `abortou: ${(r as any).erro}`);
  const esperado = ["begin", "set local", "set local", "lock table", "lock table", "do $$", "create temp", "create unique", "alter table", "alter table", "create or", "do $$", "commit"];
  assert(JSON.stringify(r.comandos) === JSON.stringify(esperado), `comandos: ${r.comandos}`);
  assert(r.db.config.lock_timeout === "5s" && r.db.config.statement_timeout === "60s", JSON.stringify(r.db.config));
  assert(JSON.stringify(r.db.locks.slice(-2)) === JSON.stringify([{ tabela: A, modo: "access exclusive" }, { tabela: LJ, modo: "share" }]), JSON.stringify(r.db.locks));
  assert(Object.keys(r.db.temp).length === 0, "temp ON COMMIT DROP sobreviveu");
  assert(comandosDoScript(BRUTO).length === esperado.length, "comentário virou comando");
});

t("S8. rollback documentado e NÃO executável; aplicação não é declarada atômica", () => {
  assert(/ROLLBACK CONTROLADO/.test(BRUTO) && /drop index public\.anuncios_ml_identidade_uq/.test(BRUTO) && /drop constraint anuncios_ml_exige_loja/.test(BRUTO), "rollback não documentado");
  assert(/20261107_anuncios_ml_loja_fase1\.sql/.test(BRUTO), "rollback não aponta a função do estado 3");
  assert(/nao foi atomica/i.test(BRUTO), "dívida de atomicidade não registrada no arquivo");
});

imprimir("\n[2. prechecks executados do SQL]");

t("P0. estado 3 íntegro (multi-loja, manuais sem item) → todos os prechecks contam 0 e a migration passa", () => {
  const r = aplicar(SQL, estado3());
  assert(r.ok, `abortou: ${(r as any).erro}`);
  for (const x of "ABCDE") assert(contadorNoTraco(r.traco, `PRECHECK ${x}`) === 0, `${x} contou ${contadorNoTraco(r.traco, `PRECHECK ${x}`)}`);
  for (const x of "FGJ") assert(contadorNoTraco(r.traco, `PRECHECK ${x}`) === 1, `${x} contou ${contadorNoTraco(r.traco, `PRECHECK ${x}`)}`);
  for (const x of "HI") assert(contadorNoTraco(r.traco, `PRECHECK ${x}`) === 0, `${x} contou ${contadorNoTraco(r.traco, `PRECHECK ${x}`)}`);
});

const PRECHECKS: Array<[string, string, (db: Banco) => void]> = [
  ["PRECHECK A", "row ML sem loja_id", (db) => { linhaDe(db, "an-0001").loja_id = null; }],
  ["PRECHECK B", "loja_id inexistente", (db) => { linhaDe(db, "an-0001").loja_id = "99999999-0000-4000-8000-000000000000"; }],
  ["PRECHECK C", "row ML com loja ML de outro dono", (db) => { linhaDe(db, "an-0001").loja_id = L(4); }],
  ["PRECHECK D", "row Shopee com loja ML do mesmo dono", (db) => { linhaDe(db, "an-0006").loja_id = L(1); }],
  ["PRECHECK E", "identidade ML duplicada na mesma loja", (db) => { anuncios(db).push({ ...linhaDe(db, "an-0001"), id: "an-dup" }); }],
  ["PRECHECK E", "identidade ML duplicada com variação NULL vs '' (coalesce)", (db) => { anuncios(db).push({ ...linhaDe(db, "an-0001"), id: "an-dup", variation_id: "" }); }],
  ["PRECHECK F", "row Shopee sem loja", (db) => { linhaDe(db, "an-0008").loja_id = null; }],
  ["PRECHECK F", "UNIQUE Shopee com definição diferente", (db) => { db.indices!.find((i) => i.nome === "anuncios_shopee_identidade_uq")!.def = DEF_SHOPEE_UQ.replace("user_id, loja_id, ", "user_id, "); }],
  ["PRECHECK F", "UNIQUE Shopee ausente", (db) => { db.indices = db.indices!.filter((i) => i.nome !== "anuncios_shopee_identidade_uq"); }],
  ["PRECHECK F", "CHECK Shopee não validado", (db) => { db.checks!.find((k) => k.nome === "anuncios_shopee_exige_loja")!.validado = false; }],
  ["PRECHECK F", "CHECK Shopee com definição diferente", (db) => { db.checks!.find((k) => k.nome === "anuncios_shopee_exige_loja")!.def = "CHECK ((loja_id IS NOT NULL))"; }],
  ["PRECHECK G", "função do estado 2 (sem ponte)", (db) => { db.fontes!["public.anuncios_loja_do_dono"] = "begin return new; end"; }],
  ["PRECHECK H", "UNIQUE ML já existe", (db) => declararIndiceUnico(db, "anuncios_ml_identidade_uq", A, "user_id", null, "x")],
  ["PRECHECK I", "CHECK ML já existe", (db) => declararCheck(db, "anuncios_ml_exige_loja", A, "true", "CHECK (true)")],
  ["PRECHECK J", "trigger do estado 2 (sem marketplace)", (db) => { db.gatilhos.find((g) => g.nome === "anuncios_loja_do_dono")!.colunasUpdate = ["loja_id", "user_id"]; }],
  ["PRECHECK J", "trigger ausente", (db) => { db.gatilhos = db.gatilhos.filter((g) => g.nome !== "anuncios_loja_do_dono"); }],
];
for (const [rotulo, descricao, mexer] of PRECHECKS) {
  t(`${rotulo.replace("PRECHECK ", "P")}. ${descricao} → ABORTA em ${rotulo} antes de qualquer DDL; nada muda`, () => {
    const db0 = estado3(); mexer(db0);
    const antes = JSON.stringify({ t: db0.tabelas, i: db0.indices?.map((i) => [i.nome, i.def]), c: db0.checks?.map((k) => [k.nome, k.def, k.validado]), f: db0.fontes, g: db0.gatilhos });
    const r = aplicar(SQL, db0);
    assert(!r.ok && r.erro.startsWith(rotulo), `esperava ${rotulo}: ${JSON.stringify((r as any).erro ?? "aplicou")}`);
    assert(JSON.stringify(r.comandos.slice(-1)) === JSON.stringify(["do $$"]) && !r.comandos.includes("create unique"), `DDL rodou antes do abort: ${r.comandos}`);
    assert(JSON.stringify({ t: r.db.tabelas, i: r.db.indices?.map((i) => [i.nome, i.def]), c: r.db.checks?.map((k) => [k.nome, k.def, k.validado]), f: r.db.fontes, g: r.db.gatilhos }) === antes, "estado mudou");
  });
}

t("P1. diferencial: em bancos limpo + violação A–E, o contador de cada precheck calculado PELO SQL = oráculo", () => {
  const variantes: Array<[string, (db: Banco) => void]> = [["limpo", () => {}], ...PRECHECKS.filter(([r]) => /PRECHECK [A-E]$/.test(r)).map(([r, , m]) => [r, m] as [string, (db: Banco) => void])];
  for (const [nome, mexer] of variantes) {
    const db0 = estado3(); mexer(db0);
    const r = aplicar(SQL, db0);
    let comparados = 0;
    for (const [rotulo, oraculo] of Object.entries(ORACULO)) {
      const n = contadorNoTraco(r.traco, rotulo); if (n === null) continue;
      assert(n === oraculo(db0), `${nome}/${rotulo}: SQL=${n} oráculo=${oraculo(db0)}`); comparados++;
    }
    assert(comparados > 0, `${nome}: nada comparado`);
  }
});

t("P2. idempotência fail-closed: aplicar a 20261108 sobre o estado 4 ABORTA em PRECHECK G (nada duplica)", () => {
  const r = aplicar(SQL, estado4());
  assert(!r.ok && r.erro.startsWith("PRECHECK G"), JSON.stringify((r as any).erro ?? "aplicou"));
});

t("P3. defesa em profundidade: sem o bloco de precheck, duplicata faz o CREATE UNIQUE INDEX falhar e ML sem loja faz o VALIDATE falhar", () => {
  const semPre = SQL.replace(/do\s+\$\$[\s\S]*?PRECHECK A[\s\S]*?\$\$\s*;/i, "");
  assert(semPre !== SQL, "bloco de precheck não encontrado");
  const d = estado3(); anuncios(d).push({ ...linhaDe(d, "an-0001"), id: "an-dup" });
  const r1 = aplicar(semPre, d);
  assert(!r1.ok && /could not create unique index "anuncios_ml_identidade_uq"/.test(r1.erro), JSON.stringify((r1 as any).erro ?? "aplicou"));
  const s = estado3(); linhaDe(s, "an-0001").loja_id = null;
  const r2 = aplicar(semPre, s);
  assert(!r2.ok && /check constraint "anuncios_ml_exige_loja"/.test(r2.erro), JSON.stringify((r2 as any).erro ?? "aplicou"));
});

imprimir("\n[3. estado 4: catálogo e dados]");

t("C1. UNIQUE ML criada: unique, válida, pronta, na tabela certa; predicado/colunas executáveis", () => {
  const db = estado4();
  const i = db.indices!.find((x) => x.nome === "anuncios_ml_identidade_uq")!;
  assert(i && i.tabela === A && i.valido && i.pronto, JSON.stringify(i));
  const v = consultar("select count(*) from pg_index i join pg_class c on c.oid = i.indexrelid where c.relname = 'anuncios_ml_identidade_uq' and i.indisunique and i.indisvalid and i.indisready", db);
  assert(Object.values(v[0])[0] === 1, JSON.stringify(v));
});

t("C2. CHECK ML criada e VALIDADA (convalidated)", () => {
  const db = estado4();
  const k = db.checks!.find((x) => x.nome === "anuncios_ml_exige_loja")!;
  assert(k && k.validado && k.def === "CHECK (marketplace <> 'ML' or loja_id is not null)", JSON.stringify(k));
});

t("C3. contratos Shopee com a MESMA definição e estado antes e depois (UNIQUE e CHECK)", () => {
  const d3 = estado3(), d4 = estado4();
  for (const d of [d3, d4]) {
    assert(d.indices!.filter((i) => i.nome === "anuncios_shopee_identidade_uq").map((i) => i.def).join() === DEF_SHOPEE_UQ, "UNIQUE Shopee mudou");
    const k = d.checks!.filter((x) => x.nome === "anuncios_shopee_exige_loja");
    assert(k.length === 1 && k[0].def === DEF_SHOPEE_CK && k[0].validado, "CHECK Shopee mudou");
  }
});

t("C4. trigger final = definição auditada (INSERT OR UPDATE OF loja_id, user_id, marketplace)", () => {
  const db = estado4();
  const v = consultar("select pg_get_triggerdef(t.oid) as d from pg_trigger t where t.tgname = 'anuncios_loja_do_dono'", db);
  assert(v.length === 1 && v[0].d === DEF_TRIGGER, JSON.stringify(v));
});

t("C5. DATA_ROWS_CHANGED = 0: todas as rows (ML e Shopee, todos os campos) idênticas; lojas idênticas", () => {
  const d3 = estado3(); const r = aplicar(SQL, d3);
  assert(r.ok, (r as any).erro);
  const mudou = anuncios(d3).filter((a) => JSON.stringify(a) !== JSON.stringify(anuncios(r.db).find((x) => x.id === a.id))).length;
  assert(mudou === 0 && anuncios(d3).length === anuncios(r.db).length, `DATA_ROWS_CHANGED=${mudou}`);
  assert(JSON.stringify(d3.tabelas[LJ]) === JSON.stringify(r.db.tabelas[LJ]), "lojas mudaram");
  imprimir("        DATA_ROWS_CHANGED=0");
});

imprimir("\n[4. estado 4: comportamento]");

t("U1. mesmo item/variação em DUAS lojas ML do mesmo dono → ambos aceitos (UNIQUE é por loja)", () => {
  const db = estado4();
  assert(tenta(() => inserir(db, anuncio(D(1), "ML", "MLB2", "501", { loja_id: L(11) }))) === null, "rejeitou outra loja");
});
t("U2. mesma identidade na MESMA loja → REJEITADO por anuncios_ml_identidade_uq", () => {
  const e = tenta(() => inserir(estado4(), anuncio(D(1), "ML", "MLB1", null, { loja_id: L(1) })));
  assert(e && /anuncios_ml_identidade_uq/.test(e), `aceitou duplicata: ${e}`);
});
t("U3. variação diferente do mesmo item na mesma loja → aceita; variação NULL x '' → colide (coalesce)", () => {
  const db = estado4();
  assert(tenta(() => inserir(db, anuncio(D(1), "ML", "MLB2", "503", { loja_id: L(1) }))) === null, "variação nova rejeitada");
  assert(/anuncios_ml_identidade_uq/.test(tenta(() => inserir(db, anuncio(D(1), "ML", "MLB1", "", { loja_id: L(1) }))) ?? ""), "NULL x '' não colidiu");
});
t("U4. mesmo item, mesma loja, dono diferente → nunca colide por loja alheia (trigger recusa a loja alheia antes)", () => {
  const db = estado4();
  assert(tenta(() => inserir(db, anuncio(D(2), "ML", "MLB1", null, { loja_id: L(4) }))) !== null, "duplicata do próprio dono aceita");
  assert(tenta(() => inserir(db, anuncio(D(2), "ML", "MLB2", "501", { loja_id: L(4) }))) === null, "item igual de outro dono rejeitado");
});
t("U5. rows ML MANUAIS sem ml_item_id na mesma loja NUNCA colidem (fora do índice)", () => {
  const db = estado4();
  assert(tenta(() => inserir(db, anuncio(D(1), "ML", null, null, { loja_id: L(1), nome: "manual-3" }))) === null, "manual colidiu");
  assert(tenta(() => inserir(db, anuncio(D(1), "ML", null, "x", { loja_id: L(1) }))) === null && tenta(() => inserir(db, anuncio(D(1), "ML", null, "x", { loja_id: L(1) }))) === null, "manual com variação colidiu");
});
t("U6. Shopee com a mesma chave de uma row ML → fora do índice ML (só UNIQUE Shopee vale para Shopee)", () => {
  const db = estado4();
  assert(tenta(() => inserir(db, anuncio(D(1), "Shopee", "MLB1", null, { loja_id: L(2) }))) === null, "índice ML pegou Shopee");
  assert(/anuncios_shopee_identidade_uq/.test(tenta(() => inserir(db, anuncio(D(1), "Shopee", "7001", null, { loja_id: L(2) }))) ?? ""), "UNIQUE Shopee deixou de valer");
});

t("K1. ML SEM loja_id, dono com exatamente 1 loja ML ATIVA → REJEITADO pelo CHECK (sem autofill)", () => {
  const db = estado4(); const n = anuncios(db).length;
  const e = tenta(() => inserir(db, anuncio(D(2), "ML", "MLB300", null)));
  assert(e && /anuncios_ml_exige_loja/.test(e) && anuncios(db).length === n, `aceitou/preencheu: ${e}`);
});
t("K2. ML MANUAL (sem ml_item_id) sem loja_id → REJEITADO (CHECK não depende de identidade do provider)", () => {
  const e = tenta(() => inserir(estado4(), anuncio(D(2), "ML", null, null)));
  assert(e && /anuncios_ml_exige_loja/.test(e), `aceitou manual sem loja: ${e}`);
});
t("K3. UPDATE zerando loja_id de row ML → REJEITADO (sem reatribuição)", () => {
  const e = tenta(() => atualizar(estado4(), "an-0004", { loja_id: null }));
  assert(e && /anuncios_ml_exige_loja/.test(e), `aceitou/reatribuiu: ${e}`);
});
t("K4. Shopee sem loja → REJEITADO (contrato Shopee mantido)", () => {
  assert(/anuncios_shopee_exige_loja/.test(tenta(() => inserir(estado4(), anuncio(D(1), "Shopee", "7009", null))) ?? ""), "Shopee sem loja aceita");
});

t("F1. loja_id EXPLÍCITA de loja ML INATIVA do mesmo dono → aceita e mantida", () => {
  const db = estado4();
  const a = inserir(db, anuncio(D(3), "ML", "MLB301", null, { loja_id: L(5) }));
  assert(a.loja_id === L(5) && db.tabelas[LJ].find((l) => l.id === L(5))!.ativo === false, JSON.stringify(a));
  assert(atualizar(db, a.id, { loja_id: L(5), user_id: D(3) }).loja_id === L(5), "UPDATE explícito trocou a loja");
});
t("F2. loja ML de OUTRO dono → REJEITADO; loja SHOPEE do mesmo dono em row ML → REJEITADO", () => {
  const db = estado4();
  assert(tenta(() => inserir(db, anuncio(D(1), "ML", "MLB302", null, { loja_id: L(4) }))) !== null, "aceitou loja alheia");
  assert(tenta(() => inserir(db, anuncio(D(1), "ML", "MLB303", null, { loja_id: L(2) }))) !== null, "ML aceitou loja Shopee");
  assert(tenta(() => inserir(db, anuncio(D(1), "Shopee", "7010", null, { loja_id: L(1) }))) !== null, "Shopee aceitou loja ML");
});
t("F3. UPDATE de marketplace dispara o trigger: Shopee → ML com loja Shopee → REJEITADO", () => {
  assert(tenta(() => atualizar(estado4(), "an-0006", { marketplace: "ML" })) !== null, "virou ML com loja Shopee");
});
t("F4. UPDATE que não toca loja/dono/marketplace (SKU) segue funcionando", () => {
  const a = atualizar(estado4(), "an-0002", { sku: "X" });
  assert(a.sku === "X" && a.loja_id === L(1), JSON.stringify(a));
});
t("F5. controle: no estado 3 o mesmo insert ML sem loja era PREENCHIDO pela ponte (o que a 20261108 remove)", () => {
  assert(inserir(estado3(), anuncio(D(2), "ML", "MLB300", null)).loja_id === L(4), "controle: estado 3 não preenchia");
});

imprimir("\n[5. validações V1–V11 executadas do SQL — prova negativa isolada de cada uma]");

const VALIDACAO = blocoCom(SQL, /V1:/)!;
function validar(mexerAntes: (db: Banco) => void, mexerDepois: (db: Banco) => void) {
  const db = estado4();
  mexerAntes(db);
  assert(SELECT_SNAPSHOT, "CREATE TEMP do snapshot não encontrado");
  db.temp[SELECT_SNAPSHOT![1].toLowerCase()] = consultar(SELECT_SNAPSHOT![2], db);
  mexerDepois(db);
  return executarBlocoDo(VALIDACAO, db, restricoes);
}
const nada = () => {};
const FONTE_FASE1 = /create\s+or\s+replace\s+function[\s\S]*?\$\$([\s\S]*?)\$\$\s*;/i.exec(SQL_FASE1)![1];

t("V0. estado 4 íntegro + snapshot do próprio SQL → V1–V11 passam", () => {
  const r = validar(nada, nada);
  assert(r.erro === null, `falhou num estado íntegro: ${r.erro}`);
  for (const v of ["V1", "V2", "V3", "V4", "V6", "V7"]) assert(contadorNoTraco(r.traco, v) === 0, `${v} contou ${contadorNoTraco(r.traco, v)}`);
});

const NEGATIVOS: Array<[string, string, (db: Banco) => void, (db: Banco) => void]> = [
  ["V1", "row nova depois do snapshot", nada, (db) => { anuncios(db).push({ ...linhaDe(db, "an-0001"), id: "an-novo", ml_item_id: "MLBX" }); }],
  ["V1", "row sumiu depois do snapshot", nada, (db) => { db.tabelas[A] = anuncios(db).filter((a) => a.id !== "an-0008"); }],
  ["V2", "row ML sem loja", nada, (db) => { linhaDe(db, "an-0001").loja_id = null; }],
  ["V3", "row ML com loja ML de outro dono", nada, (db) => { linhaDe(db, "an-0001").loja_id = L(4); }],
  ["V4", "row Shopee com loja ML do mesmo dono", nada, (db) => { linhaDe(db, "an-0006").loja_id = L(1); }],
  ["V5", "campo de row Shopee alterado", nada, (db) => { linhaDe(db, "an-0006").nome = "outro"; }],
  ["V5", "UNIQUE Shopee com definição diferente", nada, (db) => { db.indices!.find((i) => i.nome === "anuncios_shopee_identidade_uq")!.def += " "; }],
  ["V5", "CHECK Shopee removido", nada, (db) => { db.checks = db.checks!.filter((k) => k.nome !== "anuncios_shopee_exige_loja"); }],
  ["V6", "campo de row ML alterado", nada, (db) => { linhaDe(db, "an-0001").preco_anuncio = 99; }],
  ["V6", "loja_id de row ML trocada por outra loja válida do dono", nada, (db) => { linhaDe(db, "an-0001").loja_id = L(11); }],
  ["V7", "identidade ML duplicada na mesma loja", (db) => { anuncios(db).push({ ...linhaDe(db, "an-0001"), id: "an-dup" }); }, nada],
  ["V8", "UNIQUE ML ausente", nada, (db) => { db.indices = db.indices!.filter((i) => i.nome !== "anuncios_ml_identidade_uq"); }],
  ["V8", "UNIQUE ML inválida", nada, (db) => { db.indices!.find((i) => i.nome === "anuncios_ml_identidade_uq")!.valido = false; }],
  ["V8", "UNIQUE ML não pronta", nada, (db) => { db.indices!.find((i) => i.nome === "anuncios_ml_identidade_uq")!.pronto = false; }],
  ["V9", "CHECK ML não validado", nada, (db) => { db.checks!.find((k) => k.nome === "anuncios_ml_exige_loja")!.validado = false; }],
  ["V9", "CHECK ML ausente", nada, (db) => { db.checks = db.checks!.filter((k) => k.nome !== "anuncios_ml_exige_loja"); }],
  ["V10", "função ainda é a ponte do estado 3", nada, (db) => { db.fontes!["public.anuncios_loja_do_dono"] = FONTE_FASE1; }],
  ["V10", "função sem validação de marketplace", nada, (db) => { db.fontes!["public.anuncios_loja_do_dono"] = FUNCAO.replace(" and l.marketplace = new.marketplace", ""); }],
  ["V11", "trigger sem UPDATE OF marketplace", nada, (db) => { db.gatilhos.find((g) => g.nome === "anuncios_loja_do_dono")!.colunasUpdate = ["loja_id", "user_id"]; }],
  ["V11", "trigger ausente", nada, (db) => { db.gatilhos = db.gatilhos.filter((g) => g.nome !== "anuncios_loja_do_dono"); }],
];
for (const [v, descricao, antes, depois] of NEGATIVOS) {
  t(`${v}. ${descricao} → o bloco de validação do SQL aborta EM ${v}`, () => {
    const r = validar(antes, depois);
    assert(r.erro !== null && r.erro.startsWith(`${v}:`), `esperava ${v}: ${JSON.stringify(r.erro)}`);
  });
}

imprimir(`\n${falhou === 0 ? "✓" : "✗"} ANUNCIOS-ML-LOJA-FASE2 — ${ok} passaram, ${falhou} falharam`);
process.exit(falhou === 0 ? 0 : 1);
