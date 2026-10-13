/**
 * CDS V2 — Fase 2H-B: migration 20261109_anuncios_status_marketplace.sql (PREPARADA, NÃO aplicada).
 *
 * Contrato:
 *   • ADITIVA: só `status_marketplace text` e `visto_em timestamptz`, nulas, sem default, sem NOT NULL,
 *     sem CHECK, sem índice, sem trigger, sem IF NOT EXISTS (fail-closed);
 *   • SEM backfill: toda row termina com as duas colunas NULL (nunca ML = active / Shopee = NORMAL);
 *   • nenhum valor existente muda (snapshot da linha inteira; as duas chaves novas saem antes de comparar);
 *     `ativo` não é tocado (é do usuário; provider nunca escreve `ativo`);
 *   • precheck A–J antes do DDL (estado 4 íntegro e colunas ausentes); validação V1–V12 depois, com o
 *     catálogo inteiro de anuncios (índices + constraints) comparado com o de antes.
 *
 * Semântica: o estado 4 é montado executando a 20261107 e a 20261108 REAIS sobre o estado 2; o catálogo
 * de colunas de anuncios é o de produção (information_schema); a 20261109 REAL roda comando a comando
 * em scripts/_guard-v2-sql.ts — prechecks/snapshot/ALTER/validações saem do SQL.
 *
 * LIMITE (honesto): o interpretador NÃO substitui o PostgreSQL — não prova o parser real, locks reais,
 * a forma do information_schema real além de data_type/is_nullable/column_default, nem o planner.
 *
 * Uso: npx tsx scripts/testar-anuncios-status-marketplace.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Banco, type Linha, type Restricoes, ErroSQL, atualizarLinha, comandosDoScript, consultar, contadorNoTraco,
  declararCheck, declararColunas, declararIndiceUnico, executarBlocoDo, executarScript, inserirLinha,
} from "./_guard-v2-sql";

let ok = 0, falhou = 0;
const imprimir = console.log.bind(console);
function t(nome: string, fn: () => void) {
  try { fn(); ok++; imprimir(`  PASS  ${nome}`); }
  catch (e: any) { falhou++; imprimir(`  FALHA ${nome} -> ${e?.message ?? e}`); }
}
function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }

const RAIZ = join(__dirname, "..");
const MIGRACAO = "supabase/migrations/20261109_anuncios_status_marketplace.sql";
const BRUTO = readFileSync(join(RAIZ, MIGRACAO), "utf8").replace(/\r\n/g, "\n");
const SQL = comandosDoScript(BRUTO).join(";\n") + ";";
const SQL_1107 = readFileSync(join(RAIZ, "supabase/migrations/20261107_anuncios_ml_loja_fase1.sql"), "utf8").replace(/\r\n/g, "\n");
const SQL_1108 = readFileSync(join(RAIZ, "supabase/migrations/20261108_anuncios_ml_loja_fase2.sql"), "utf8").replace(/\r\n/g, "\n");
const A = "public.anuncios", LJ = "public.lojas";

const DEF_SHOPEE_UQ = "CREATE UNIQUE INDEX anuncios_shopee_identidade_uq ON public.anuncios USING btree (user_id, loja_id, marketplace, ml_item_id, COALESCE(variation_id, ''::text)) WHERE ((marketplace = 'Shopee'::text) AND (ml_item_id IS NOT NULL))";
const DEF_SHOPEE_CK = "CHECK (((marketplace <> 'Shopee'::text) OR (loja_id IS NOT NULL)))";
/** Forma canônica do PostgreSQL (confirmada em produção após a 20261108) dos objetos do estado 4. */
const DEF_ML_UQ = "CREATE UNIQUE INDEX anuncios_ml_identidade_uq ON public.anuncios USING btree (user_id, loja_id, marketplace, ml_item_id, COALESCE(variation_id, ''::text)) WHERE ((marketplace = 'ML'::text) AND (ml_item_id IS NOT NULL))";
const DEF_ML_CK = "CHECK (((marketplace <> 'ML'::text) OR (loja_id IS NOT NULL)))";
/** Colunas de public.anuncios em produção (information_schema, estado 4). */
const COLUNAS_PRODUCAO: Array<[string, string, boolean, string | null]> = [
  ["id", "uuid", false, "gen_random_uuid()"], ["created_at", "timestamp with time zone", true, "now()"], ["nome", "text", false, null],
  ["marketplace", "text", false, null], ["categoria", "text", true, null], ["tipo_anuncio", "text", true, null], ["tipo_conta_shopee", "text", true, null],
  ["custo_produto", "numeric", false, "0"], ["insumos", "numeric", false, "0"], ["custo_frete", "numeric", false, "0"], ["frete_gratis", "boolean", false, "false"],
  ["imposto", "numeric", false, "8"], ["margem_desejada", "numeric", false, "20"], ["preco_ideal", "numeric", true, null], ["ativo", "boolean", false, "true"],
  ["ml_item_id", "text", true, null], ["sku", "text", true, null], ["preco_anuncio", "numeric", true, null], ["thumbnail", "text", true, null],
  ["permalink", "text", true, null], ["peso_kg", "numeric", true, null], ["variation_id", "text", true, null], ["logistic_type", "text", true, null],
  ["user_id", "text", true, null], ["loja_id", "uuid", true, null],
];

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
const aplicar = (sql: string, db: Banco) => executarScript(sql, db, restricoes);
const anuncios = (db: Banco) => db.tabelas[A];

// ── Estado 4 real: estado 2 → 20261107 → 20261108 ────────────────────
const D = (n: number) => `d000000${n}-0000-4000-8000-000000000000`;
const L = (n: number) => `10000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const loja = (n: number, dono: string, mk: "ML" | "Shopee", extra: Linha = {}): Linha =>
  ({ id: L(n), user_id: dono, marketplace: mk, ativo: true, seller_id: `s${n}`, created_at: "2026-06-01", ...extra });
let seq = 0;
const anuncio = (dono: string, mk: "ML" | "Shopee", item: string | null, variacao: string | null, extra: Linha = {}): Linha =>
  ({ id: `an-${String(++seq).padStart(4, "0")}`, user_id: dono, marketplace: mk, ml_item_id: item, variation_id: variacao, loja_id: null,
    sku: null, ativo: true, nome: `n-${item}`, preco_anuncio: 10, custo_produto: 0, thumbnail: `t-${item}`, created_at: "2026-06-26", ...extra });
function estado4(): Banco {
  seq = 0;
  const lojas = [loja(1, D(1), "ML"), loja(2, D(1), "Shopee"), loja(3, D(1), "Shopee"), loja(4, D(2), "ML"), loja(5, D(3), "ML", { ativo: false }), loja(8, D(5), "Shopee")];
  const rows = [
    anuncio(D(1), "ML", "MLB1", null), anuncio(D(1), "ML", "MLB2", "501"), anuncio(D(1), "ML", "MLB2", "502", { ativo: false }),
    anuncio(D(2), "ML", "MLB1", null), anuncio(D(3), "ML", "MLB7", null, { sku: "SKU-USER", custo_produto: 30 }),
    anuncio(D(1), "Shopee", "7001", null, { loja_id: L(2) }), anuncio(D(1), "Shopee", "7001", null, { loja_id: L(3), ativo: false }),
    anuncio(D(5), "Shopee", "8001", "9", { loja_id: L(8) }),
  ];
  const r2 = executarScript(SCRIPT_ESTADO_2, { tabelas: { [A]: rows, [LJ]: lojas }, temp: {}, funcoes: {}, gatilhos: [], config: {}, locks: [] }, restricoes);
  if (!r2.ok) throw new Error(`estado 2: ${r2.erro}`);
  declararIndiceUnico(r2.db, "anuncios_shopee_identidade_uq", A, "user_id, loja_id, marketplace, ml_item_id, coalesce(variation_id, '')", "marketplace = 'Shopee' and ml_item_id is not null", DEF_SHOPEE_UQ);
  declararCheck(r2.db, "anuncios_shopee_exige_loja", A, "marketplace <> 'Shopee' or loja_id is not null", DEF_SHOPEE_CK);
  const r3 = aplicar(SQL_1107, r2.db); if (!r3.ok) throw new Error(`20261107: ${r3.erro}`);
  r3.db.tabelas[LJ].push(loja(11, D(1), "ML"));
  inserirLinha(r3.db, A, anuncio(D(1), "ML", "MLB1", null, { loja_id: L(11) }), restricoes);
  inserirLinha(r3.db, A, anuncio(D(1), "ML", null, null, { loja_id: L(1), nome: "manual" }), restricoes);
  const r4 = aplicar(SQL_1108, r3.db); if (!r4.ok) throw new Error(`20261108: ${r4.erro}`);
  const db = r4.db;
  // objetos do estado 4 com a definição CANÔNICA do PostgreSQL (a do interpretador é o texto do comando)
  db.indices!.find((i) => i.nome === "anuncios_ml_identidade_uq")!.def = DEF_ML_UQ;
  db.checks!.find((k) => k.nome === "anuncios_ml_exige_loja")!.def = DEF_ML_CK;
  declararColunas(db, A, COLUNAS_PRODUCAO.map(([nome, tipo, nula, padrao]) => ({ nome, tipo, nula, padrao })));
  // rows completas como em produção: toda coluna existente presente (NOT NULL com o default literal de produção)
  const literal: Record<string, unknown> = { "0": 0, "8": 8, "20": 20, "true": true, "false": false };
  for (const r of anuncios(db)) for (const [nome, , , padrao] of COLUNAS_PRODUCAO) if (!(nome in r)) r[nome] = padrao !== null && padrao in literal ? literal[padrao] : null;
  return db;
}
function aplicada(sql = SQL): Banco {
  const r = aplicar(sql, estado4());
  if (!r.ok) throw new Error(`migration abortou: ${r.erro}`);
  return r.db;
}
const semNovas = (r: Linha) => { const { status_marketplace, visto_em, ...resto } = r; return JSON.stringify(Object.keys(resto).sort().map((k) => [k, resto[k]])); };
const catalogo = (db: Banco) => JSON.stringify({ i: db.indices!.map((i) => [i.nome, i.def, i.valido, i.pronto]), c: db.checks!.map((k) => [k.nome, k.def, k.validado]),
  f: db.fontes, g: db.gatilhos });

// ── Estrutura ──
const blocosDo = (sql: string) => [...sql.matchAll(/\bdo\s+\$\$([\s\S]*?)\$\$\s*;/gi)].map((m) => m[1]);
const blocoCom = (sql: string, marca: RegExp) => blocosDo(sql).find((b) => marca.test(b)) ?? null;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ativoRotulo = (bloco: string, rotulo: string) =>
  new RegExp(`if\\s+n\\s*(>\\s*0|<>\\s*1|<>\\s*\\(select count\\(\\*\\) from _anuncios_antes_20261109\\))\\s+then\\s+raise\\s+exception\\s+'${esc(rotulo)}`, "i").test(bloco);
const DDL = comandosDoScript(BRUTO).filter((c) => /^(create|drop|alter|reindex|comment|update|insert|delete|truncate)\b/i.test(c) && !/^create\s+temp\s+table\s+\w+\s+on\s+commit\s+drop\s+as\s+select\b/i.test(c));
const SNAPSHOTS = [...SQL.matchAll(/create\s+temp\s+table\s+(\w+)\s+on\s+commit\s+drop\s+as\s+([\s\S]*?);/gi)].map((m) => ({ nome: m[1].toLowerCase(), select: m[2] }));
const ALTER = DDL.find((c) => /^alter\s+table/i.test(c)) ?? "";

imprimir(`\n[ANUNCIOS STATUS MARKETPLACE — ${MIGRACAO}]`);
imprimir("\n[1. estrutura]");

t("S1. uma transação; PRECHECK A–J ativos ANTES do ALTER; V1–V12 ativos DEPOIS", () => {
  assert(/^\s*begin\s*;/im.test(SQL) && /commit\s*;\s*$/i.test(SQL), "sem begin/commit");
  const pre = blocoCom(SQL, /PRECHECK A/) ?? "";
  for (const r of "ABCDEFGHIJ") assert(ativoRotulo(pre, `PRECHECK ${r}`), `PRECHECK ${r} ausente ou neutralizado`);
  const val = blocoCom(SQL, /V1:/) ?? "";
  for (let i = 1; i <= 12; i++) assert(ativoRotulo(val, `V${i}:`), `V${i} ausente ou neutralizado`);
  assert(SQL.search(/PRECHECK A/) < SQL.search(/alter\s+table/i) && SQL.search(/V1:/) > SQL.search(/alter\s+table/i), "ordem precheck → alter → validação");
});
t("S2. o ÚNICO DDL é ALTER TABLE public.anuncios ADD COLUMN status_marketplace text, ADD COLUMN visto_em timestamptz — sem default/not null/check/índice/IF NOT EXISTS", () => {
  assert(DDL.length === 1, `DDL/escritas de topo: ${DDL.map((c) => c.slice(0, 40)).join(" | ")}`);
  assert(ALTER.replace(/\s+/g, " ") === "alter table public.anuncios add column status_marketplace text, add column visto_em timestamptz", `ALTER: ${ALTER}`);
  const semLiterais = blocosDo(SQL).join("\n").replace(/'(?:[^']|'')*'/g, "''");
  assert(!/\b(update|insert\s+into|delete\s+from|truncate)\b/i.test(semLiterais), "escrita de dado em bloco DO (backfill?)");
  assert(!/schema_migrations/i.test(SQL) && !/\bif\s+(not\s+)?exists\b/i.test(SQL), "histórico ou IF [NOT] EXISTS");
  assert(!/\bativo\b/i.test(SQL), "a migration menciona `ativo` no SQL executável");
});
t("S3. limites locais antes do lock; lock exato: anuncios ACCESS EXCLUSIVE", () => {
  const iLock = SQL.search(/lock\s+table/i);
  assert(SQL.search(/set\s+local\s+lock_timeout\s*=\s*'5s'\s*;/i) < iLock && SQL.search(/set\s+local\s+statement_timeout\s*=\s*'60s'\s*;/i) < iLock, "timeouts");
  const locks = [...SQL.matchAll(/lock\s+table\s+public\.(\w+)\s+in\s+([\w\s]+?)\s+mode\s*;/gi)].map((m) => `${m[1]}:${m[2].toLowerCase()}`);
  assert(JSON.stringify(locks) === JSON.stringify(["anuncios:access exclusive"]), `locks: ${locks}`);
});
t("S4. o interpretador executa o SCRIPT INTEIRO: begin, set local×2, lock, do(precheck), temp×3, alter, do(validação), commit", () => {
  const r = aplicar(SQL, estado4());
  assert(r.ok, `abortou: ${(r as any).erro}`);
  const esperado = ["begin", "set local", "set local", "lock table", "do $$", "create temp", "create temp", "create temp", "alter table", "do $$", "commit"];
  assert(JSON.stringify(r.comandos) === JSON.stringify(esperado), `comandos: ${r.comandos}`);
  assert(Object.keys(r.db.temp).length === 0, "temp ON COMMIT DROP sobreviveu");
  assert(/ROLLBACK CONTROLADO/.test(BRUTO) && /drop column status_marketplace, drop column visto_em/.test(BRUTO) && !/^\s*alter\s+table[^;]*drop\s+column/im.test(SQL), "rollback não documentado ou executável");
});

imprimir("\n[2. prechecks executados do SQL]");

t("P0. estado 4 íntegro → prechecks contam o esperado e a migration passa", () => {
  const r = aplicar(SQL, estado4());
  assert(r.ok, `abortou: ${(r as any).erro}`);
  for (const x of "FGHIJ") assert(contadorNoTraco(r.traco, `PRECHECK ${x}`) === 0, `${x}=${contadorNoTraco(r.traco, `PRECHECK ${x}`)}`);
  for (const x of "ABCDE") assert(contadorNoTraco(r.traco, `PRECHECK ${x}`) === 1, `${x}=${contadorNoTraco(r.traco, `PRECHECK ${x}`)}`);
});
const linha = (db: Banco, id: string) => anuncios(db).find((a) => a.id === id)!;
const PRECHECKS: Array<[string, string, (db: Banco) => void]> = [
  ["PRECHECK A", "UNIQUE ML com definição diferente", (db) => { db.indices!.find((i) => i.nome === "anuncios_ml_identidade_uq")!.def += " "; }],
  ["PRECHECK A", "UNIQUE ML inválida", (db) => { db.indices!.find((i) => i.nome === "anuncios_ml_identidade_uq")!.valido = false; }],
  ["PRECHECK A", "UNIQUE ML ausente", (db) => { db.indices = db.indices!.filter((i) => i.nome !== "anuncios_ml_identidade_uq"); }],
  ["PRECHECK B", "CHECK ML não validado", (db) => { db.checks!.find((k) => k.nome === "anuncios_ml_exige_loja")!.validado = false; }],
  ["PRECHECK C", "função com ponte transitória (estado 3)", (db) => { db.fontes!["public.anuncios_loja_do_dono"] += " "; }],
  ["PRECHECK D", "trigger sem marketplace", (db) => { db.gatilhos.find((g) => g.nome === "anuncios_loja_do_dono")!.colunasUpdate = ["loja_id", "user_id"]; }],
  ["PRECHECK E", "UNIQUE Shopee diferente", (db) => { db.indices!.find((i) => i.nome === "anuncios_shopee_identidade_uq")!.def += " "; }],
  ["PRECHECK E", "CHECK Shopee não validado", (db) => { db.checks!.find((k) => k.nome === "anuncios_shopee_exige_loja")!.validado = false; }],
  ["PRECHECK F", "status_marketplace já existe", (db) => { db.colunas![A].push({ nome: "status_marketplace", tipo: "text", nula: true, padrao: null }); }],
  ["PRECHECK G", "visto_em já existe", (db) => { db.colunas![A].push({ nome: "visto_em", tipo: "timestamp with time zone", nula: true, padrao: null }); }],
  ["PRECHECK H", "row ML sem loja", (db) => { linha(db, "an-0001").loja_id = null; }],
  ["PRECHECK I", "identidade ML duplicada", (db) => { anuncios(db).push({ ...linha(db, "an-0001"), id: "an-dup" }); }],
  ["PRECHECK J", "loja de outro dono", (db) => { linha(db, "an-0001").loja_id = L(4); }],
  ["PRECHECK J", "loja de outro marketplace", (db) => { linha(db, "an-0006").loja_id = L(1); }],
  ["PRECHECK J", "loja inexistente", (db) => { linha(db, "an-0006").loja_id = "99999999-0000-4000-8000-000000000000"; }],
];
for (const [rotulo, descricao, mexer] of PRECHECKS) {
  t(`${rotulo.replace("PRECHECK ", "P")}. ${descricao} → ABORTA em ${rotulo} antes do ALTER; nada muda`, () => {
    const db0 = estado4(); mexer(db0);
    const antes = JSON.stringify({ t: db0.tabelas, col: db0.colunas, cat: catalogo(db0) });
    const r = aplicar(SQL, db0);
    assert(!r.ok && r.erro.startsWith(rotulo), `esperava ${rotulo}: ${JSON.stringify((r as any).erro ?? "aplicou")}`);
    assert(!r.comandos.includes("alter table"), `ALTER rodou: ${r.comandos}`);
    assert(JSON.stringify({ t: r.db.tabelas, col: r.db.colunas, cat: catalogo(r.db) }) === antes, "estado mudou");
  });
}
t("P1. idempotência fail-closed: aplicar de novo ABORTA em PRECHECK F (coluna já existe)", () => {
  const r = aplicar(SQL, aplicada());
  assert(!r.ok && r.erro.startsWith("PRECHECK F"), JSON.stringify((r as any).erro ?? "aplicou"));
});
t("P2. sem o bloco de precheck, o ALTER sozinho também falha fechado com a coluna já existente (sem IF NOT EXISTS)", () => {
  const semPre = SQL.replace(/do\s+\$\$[\s\S]*?PRECHECK A[\s\S]*?\$\$\s*;/i, "");
  const r = aplicar(semPre, aplicada());
  assert(!r.ok && /already exists/.test(r.erro), JSON.stringify((r as any).erro ?? "aplicou"));
});

imprimir("\n[3. resultado: colunas novas, nada mais muda]");

t("R1. colunas: status_marketplace text NULLABLE sem default; visto_em timestamptz NULLABLE sem default", () => {
  const db = aplicada();
  const v = consultar("select column_name, data_type, is_nullable, column_default from information_schema.columns where table_name = 'anuncios' and (column_name = 'status_marketplace' or column_name = 'visto_em')", db);
  const por = Object.fromEntries(v.map((x) => [x.column_name, x]));
  assert(por.status_marketplace?.data_type === "text" && por.status_marketplace.is_nullable === "YES" && por.status_marketplace.column_default === null, JSON.stringify(por.status_marketplace));
  assert(por.visto_em?.data_type === "timestamp with time zone" && por.visto_em.is_nullable === "YES" && por.visto_em.column_default === null, JSON.stringify(por.visto_em));
});
t("R2. SEM backfill: toda row (ML e Shopee, ativa ou não) termina com status_marketplace NULL e visto_em NULL", () => {
  const db = aplicada();
  assert(anuncios(db).length > 0 && anuncios(db).every((a) => a.status_marketplace === null && a.visto_em === null), JSON.stringify(anuncios(db).map((a) => [a.marketplace, a.status_marketplace, a.visto_em])));
});
t("R3. nenhum valor existente muda (linha inteira sem as 2 chaves novas); mesmos ids; `ativo` intacto row a row", () => {
  const d4 = estado4(); const r = aplicar(SQL, d4);
  assert(r.ok, (r as any).erro);
  assert(JSON.stringify(anuncios(d4).map((a) => a.id)) === JSON.stringify(anuncios(r.db).map((a) => a.id)), "ids mudaram");
  for (const a0 of anuncios(d4)) {
    const a = anuncios(r.db).find((x) => x.id === a0.id)!;
    assert(semNovas(a) === semNovas(a0), `campo existente mudou em ${a0.id}`);
    assert(a.ativo === a0.ativo, `ativo mudou em ${a0.id}`);
  }
  assert(JSON.stringify(d4.tabelas[LJ]) === JSON.stringify(r.db.tabelas[LJ]), "lojas mudaram");
  imprimir("        EXISTING_DATA_CHANGED=NO ATIVO_DATA_CHANGED=NO");
});
t("R4. catálogo intacto: UNIQUE/CHECK ML e Shopee, função e trigger do estado 4 idênticos; nenhum índice/CHECK novo; `ativo` sem mudança de schema", () => {
  const d4 = estado4(); const r = aplicar(SQL, d4);
  assert(r.ok && catalogo(r.db) === catalogo(d4), "catálogo mudou");
  const ativo = (db: Banco) => JSON.stringify(db.colunas![A].find((c) => c.nome === "ativo"));
  assert(ativo(r.db) === ativo(d4), "schema de ativo mudou");
  assert(r.db.colunas![A].length === d4.colunas![A].length + 2, "colunas além das duas");
});
t("R5. depois da migration, escrita nova sem as colunas grava NULL (nada de default escondido); a identidade ML segue protegida", () => {
  const db = aplicada();
  const a = inserirLinha(db, A, anuncio(D(1), "ML", "MLB900", null, { loja_id: L(1) }), restricoes);
  assert(a.status_marketplace === null && a.visto_em === null, JSON.stringify(a));
  let erro = ""; try { inserirLinha(db, A, anuncio(D(1), "ML", "MLB900", null, { loja_id: L(1) }), restricoes); } catch (e: any) { erro = e.message; }
  assert(/anuncios_ml_identidade_uq/.test(erro), `UNIQUE ML não protege mais: ${erro}`);
  const u = atualizarLinha(db, A, a.id, { status_marketplace: "active" }, restricoes);
  assert(u.status_marketplace === "active" && u.ativo === true, "coluna nova não gravável ou mexeu em ativo");
});

imprimir("\n[4. validações V1–V12 executadas do SQL — prova negativa isolada de cada uma]");

const VALIDACAO = blocoCom(SQL, /V1:/)!;
/** Estado 4 → snapshots pelos SELECTs da migration → ALTER real → violação → bloco de validação real. */
function validar(mexer: (db: Banco) => void) {
  const db = estado4();
  for (const s of SNAPSHOTS) db.temp[s.nome] = consultar(s.select, db);
  const r = executarScript(`begin;\n${ALTER};\ncommit;`, db, restricoes);
  if (!r.ok) throw new Error(`ALTER: ${r.erro}`);
  for (const s of SNAPSHOTS) r.db.temp[s.nome] = db.temp[s.nome];
  mexer(r.db);
  return executarBlocoDo(VALIDACAO, r.db, restricoes);
}
t("V0. estado íntegro + snapshots do próprio SQL → V1–V12 passam", () => {
  const r = validar(() => {});
  assert(r.erro === null, `falhou num estado íntegro: ${r.erro}`);
});
const col = (db: Banco, nome: string) => db.colunas![A].find((c) => c.nome === nome)!;
const NEGATIVOS: Array<[string, string, (db: Banco) => void]> = [
  ["V1", "row nova", (db) => { anuncios(db).push({ ...anuncios(db)[0], id: "an-novo", ml_item_id: "MLBX" }); }],
  ["V2", "id trocado (mesma quantidade)", (db) => { anuncios(db)[0] = { ...anuncios(db)[0], id: "an-trocado" }; }],
  ["V3", "campo de negócio alterado", (db) => { anuncios(db)[0].preco_anuncio = 999; }],
  ["V3", "ativo alterado", (db) => { anuncios(db)[0].ativo = !anuncios(db)[0].ativo; }],
  ["V4", "status_marketplace preenchido", (db) => { anuncios(db)[0].status_marketplace = "active"; }],
  ["V5", "visto_em preenchido", (db) => { anuncios(db)[0].visto_em = "2026-10-13T00:00:00Z"; }],
  ["V6", "status_marketplace com default", (db) => { col(db, "status_marketplace").padrao = "'active'::text"; }],
  ["V6", "status_marketplace NOT NULL", (db) => { col(db, "status_marketplace").nula = false; }],
  ["V7", "visto_em com default", (db) => { col(db, "visto_em").padrao = "now()"; }],
  ["V7", "visto_em com outro tipo", (db) => { col(db, "visto_em").tipo = "text"; }],
  ["V8", "UNIQUE ML alterada", (db) => { db.indices!.find((i) => i.nome === "anuncios_ml_identidade_uq")!.def += " "; }],
  ["V9", "CHECK ML não validado", (db) => { db.checks!.find((k) => k.nome === "anuncios_ml_exige_loja")!.validado = false; }],
  ["V10", "função alterada", (db) => { db.fontes!["public.anuncios_loja_do_dono"] = "begin return new; end"; }],
  ["V10", "trigger alterado", (db) => { db.gatilhos.find((g) => g.nome === "anuncios_loja_do_dono")!.colunasUpdate = ["loja_id"]; }],
  ["V11", "CHECK Shopee alterado", (db) => { db.checks!.find((k) => k.nome === "anuncios_shopee_exige_loja")!.def = "CHECK (true)"; }],
  ["V12", "índice novo sobre visto_em", (db) => declararIndiceUnico(db, "anuncios_visto_uq", A, "id, visto_em", null, "CREATE UNIQUE INDEX anuncios_visto_uq ON public.anuncios USING btree (id, visto_em)")],
  ["V12", "CHECK novo sobre status_marketplace", (db) => declararCheck(db, "anuncios_status_ck", A, "true", "CHECK ((status_marketplace = 'active'::text))")],
  ["V12", "índice novo qualquer em anuncios", (db) => declararIndiceUnico(db, "anuncios_extra_uq", A, "user_id, ml_item_id", null, "CREATE UNIQUE INDEX anuncios_extra_uq ON public.anuncios USING btree (user_id, ml_item_id)")],
  ["V12", "constraint nova qualquer em anuncios", (db) => declararCheck(db, "anuncios_extra_ck", A, "true", "CHECK ((loja_id IS NOT NULL))")],
];
for (const [v, descricao, mexer] of NEGATIVOS) {
  t(`${v}. ${descricao} → o bloco de validação do SQL aborta EM ${v}`, () => {
    const r = validar(mexer);
    assert(r.erro !== null && r.erro.startsWith(`${v}:`), `esperava ${v}: ${JSON.stringify(r.erro)}`);
  });
}

imprimir(`\n${falhou === 0 ? "✓" : "✗"} ANUNCIOS-STATUS-MARKETPLACE — ${ok} passaram, ${falhou} falharam`);
process.exit(falhou === 0 ? 0 : 1);
