/**
 * CDS V2 — Fase 2B/2C.1: migration 20261107_anuncios_ml_loja_fase1.sql (APLICADA em produção → estado 3;
 * o arquivo é o artefato exato e não muda).
 *
 * Contrato:
 *   • backfill de anuncios.loja_id SÓ das rows ML sem loja, por CARDINALIDADE (dono com exatamente
 *     1 loja ML no total) — nunca created_at / mais recente / primeira / LIMIT / ativo; só loja_id muda;
 *     Shopee intocada;
 *   • trigger anuncios_loja_do_dono valida DONO + MARKETPLACE (permanente) e dispara também em
 *     UPDATE OF marketplace; loja_id explícito não exige loja ativa;
 *   • ponte TRANSITIONAL_COMPATIBILITY_ONLY: row ML sem loja_id recebe a loja ML ATIVA única do dono;
 *     0 ou 2+ ativas → RAISE;
 *   • precheck fail-closed A–G antes de qualquer escrita; validação final V1–V7; sem UNIQUE/CHECK ML.
 *
 * Semântica (Fase 2C.1): o SCRIPT INTEIRO é executado comando a comando por scripts/_guard-v2-sql.ts
 * — prechecks, snapshot (temp table), função, trigger, backfill e validações saem do SQL real; nenhuma
 * condição é reimplementada para decidir o resultado. Inverter/remover uma condição no arquivo muda o
 * resultado. Os conjuntos A–G/V1–V7 também existem aqui como ORÁCULO independente (teste diferencial:
 * contador calculado pelo SQL == contador do oráculo), nunca como substituto.
 *
 * LIMITE (honesto): o interpretador NÃO substitui o PostgreSQL. Offline NÃO prova o parser real, locks
 * reais (lock_timeout/statement_timeout), o comportamento transacional do SQL Editor, o planner nem a
 * temp table numa sessão real. Sem banco real, sem rede.
 *
 * Uso: npx tsx scripts/testar-anuncios-ml-loja-fase1.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Banco, type Linha, type Restricoes, ErroSQL, atualizarLinha, comandosDoScript, consultar, contadorNoTraco,
  executarBlocoDo, executarScript, inserirLinha,
} from "./_guard-v2-sql";

let ok = 0, falhou = 0;
const imprimir = console.log.bind(console);
function t(nome: string, fn: () => void) {
  try { fn(); ok++; imprimir(`  PASS  ${nome}`); }
  catch (e: any) { falhou++; imprimir(`  FALHA ${nome} -> ${e?.message ?? e}`); }
}
function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }

const RAIZ = join(__dirname, "..");
const MIGRACAO = "supabase/migrations/20261107_anuncios_ml_loja_fase1.sql";
const BRUTO = readFileSync(join(RAIZ, MIGRACAO), "utf8").replace(/\r\n/g, "\n");
/** SQL executável: sem comentários de linha (não há "--" dentro de string nesta migration). */
const SQL = BRUTO.replace(/--.*$/gm, "");
const A = "public.anuncios", LJ = "public.lojas";

// ── Regras do banco que a migration NÃO cria (já existentes em produção) ──
const restricoes: Restricoes = (db, tabela, r) => {
  if (tabela !== A) return;
  if (!["ML", "Shopee"].includes(r.marketplace)) throw new ErroSQL("anuncios_marketplace_check");
  if (r.marketplace === "Shopee" && r.loja_id == null) throw new ErroSQL("anuncios_shopee_exige_loja");
  if (r.loja_id != null && !db.tabelas[LJ].some((l) => l.id === r.loja_id)) throw new ErroSQL("anuncios_loja_id_fkey");
  if (r.marketplace === "Shopee" && r.ml_item_id != null) {
    const k = (x: Linha) => [x.user_id, x.loja_id, x.marketplace, x.ml_item_id, x.variation_id ?? ""].join("|");
    if (db.tabelas[A].some((x) => x.id !== r.id && x.marketplace === "Shopee" && x.ml_item_id != null && k(x) === k(r))) throw new ErroSQL("anuncios_shopee_identidade_uq");
  }
};
/** Estado 2 (20261103/20261104): trigger só-dono em INSERT OR UPDATE OF loja_id, user_id. */
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
function banco(lojas: Linha[], anuncios: Linha[]): Banco {
  const r = executarScript(SCRIPT_ESTADO_2, { tabelas: { [A]: anuncios, [LJ]: lojas }, temp: {}, funcoes: {}, gatilhos: [], config: {}, locks: [] }, restricoes);
  if (!r.ok) throw new Error(`estado 2 não montou: ${r.erro}`);
  return r.db;
}
const inserir = (db: Banco, l: Linha) => inserirLinha(db, A, l, restricoes);
const atualizar = (db: Banco, id: string, p: Linha) => atualizarLinha(db, A, id, p, restricoes);
const aplicar = (sql: string, db: Banco) => executarScript(sql, db, restricoes);
const anuncios = (db: Banco) => db.tabelas[A];
const tenta = (fn: () => void) => { try { fn(); return null; } catch (e: any) { return String(e?.message ?? e); } };

// ── Cenários ─────────────────────────────────────────────────────────
const D = (n: number) => `d000000${n}-0000-4000-8000-000000000000`;
const L = (n: number) => `10000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
function loja(n: number, dono: string, marketplace: "ML" | "Shopee", extra: Linha = {}): Linha {
  return { id: L(n), user_id: dono, marketplace, ativo: true, seller_id: `s${n}`, created_at: `2026-0${(n % 8) + 1}-01`, ...extra };
}
let seq = 0;
function anuncio(dono: string | null, marketplace: "ML" | "Shopee", item: string, variacao: string | null, extra: Linha = {}): Linha {
  return { id: `an-${String(++seq).padStart(4, "0")}`, user_id: dono, marketplace, ml_item_id: item, variation_id: variacao, loja_id: null,
    sku: null, ativo: true, nome: `n-${item}`, preco_anuncio: 10, custo_produto: 0, thumbnail: `t-${item}`, created_at: "2026-06-26", ...extra };
}
function lojasPadrao(): Linha[] {
  return [
    loja(1, D(1), "ML"), loja(2, D(1), "Shopee"), loja(3, D(1), "Shopee"),     // dono com ML + 2 Shopee
    loja(4, D(2), "ML", { created_at: "2026-06-27" }),                         // loja ML criada DEPOIS dos anúncios (caso dos 196)
    loja(5, D(3), "ML", { ativo: false }),                                      // única loja ML, inativa
    loja(6, D(4), "ML", { ativo: false }), loja(7, D(4), "ML", { ativo: false }), // 2 ML inativas, sem anúncios
    loja(8, D(5), "Shopee"),
  ];
}
function bancoProducao(): Banco {
  seq = 0;
  return banco(lojasPadrao(), [
    anuncio(D(1), "ML", "MLB1", null), anuncio(D(1), "ML", "MLB2", "501"), anuncio(D(1), "ML", "MLB2", "502", { ativo: false }),
    anuncio(D(2), "ML", "MLB1", null, { created_at: "2026-06-26" }), anuncio(D(2), "ML", "MLB9", null),
    anuncio(D(3), "ML", "MLB7", null, { sku: "SKU-USER", custo_produto: 30 }),
    anuncio(D(1), "Shopee", "7001", null, { loja_id: L(2) }), anuncio(D(1), "Shopee", "7001", null, { loja_id: L(3) }),
    anuncio(D(5), "Shopee", "8001", "9", { loja_id: L(8) }),
  ]);
}
/** Formato dos números reais: 871 ML (339/198/196/118/20 por dono) + Shopee, todas ML sem loja. */
function banco871(): Banco {
  seq = 0;
  const lojas = [loja(1, D(1), "ML"), loja(2, D(1), "Shopee"), loja(3, D(1), "Shopee"), loja(4, D(2), "ML"), loja(5, D(3), "ML", { ativo: false }),
    loja(9, D(6), "ML"), loja(10, D(7), "ML"), loja(6, D(4), "ML", { ativo: false }), loja(7, D(4), "ML", { ativo: false })];
  const rows: Linha[] = [];
  [[D(1), 339], [D(2), 198], [D(3), 196], [D(6), 118], [D(7), 20]].forEach(([dono, n]) => {
    for (let i = 0; i < (n as number); i++) rows.push(anuncio(dono as string, "ML", `MLB${String(dono).slice(7, 8)}${i}`, i % 12 === 0 ? String(i) : null));
  });
  for (let i = 0; i < 120; i++) rows.push(anuncio(D(1), "Shopee", `S${i}`, i % 5 === 0 ? "m" : null, { loja_id: i % 2 ? L(2) : L(3) }));
  return banco(lojas, rows);
}
const lojaDe = (db: Banco, id: string) => anuncios(db).find((a) => a.id === id)!.loja_id;
const semLoja = (r: Linha) => { const { loja_id, ...resto } = r; return JSON.stringify(Object.keys(resto).sort().map((k) => [k, resto[k]])); };
function estado3(sql = SQL) {
  const r = aplicar(sql, bancoProducao());
  if (!r.ok) throw new Error(`migration abortou: ${r.erro}`);
  return r.db;
}

// ── Oráculo independente (só para teste diferencial — nunca decide o resultado da migration) ──
const lojasML = (db: Banco, uid: string) => db.tabelas[LJ].filter((l) => l.user_id === uid && l.marketplace === "ML").length;
const ORACULO: Record<string, (db: Banco) => number> = {
  "PRECHECK A": (db) => new Set(anuncios(db).filter((a) => a.marketplace === "ML" && a.loja_id == null && lojasML(db, a.user_id) === 0).map((a) => a.user_id)).size,
  "PRECHECK B": (db) => new Set(anuncios(db).filter((a) => a.marketplace === "ML" && a.loja_id == null && lojasML(db, a.user_id) > 1).map((a) => a.user_id)).size,
  "PRECHECK C": (db) => { const m = new Map<string, number>(); for (const a of anuncios(db)) if (a.marketplace === "ML" && a.ml_item_id != null) { const k = `${a.user_id}|${a.ml_item_id}|${a.variation_id ?? ""}`; m.set(k, (m.get(k) ?? 0) + 1); } return [...m.values()].filter((n) => n > 1).length; },
  "PRECHECK D": (db) => anuncios(db).filter((a) => a.loja_id != null && !db.tabelas[LJ].some((l) => l.id === a.loja_id && l.user_id === a.user_id)).length,
  "PRECHECK E": (db) => anuncios(db).filter((a) => a.loja_id != null && db.tabelas[LJ].some((l) => l.id === a.loja_id && l.marketplace !== a.marketplace)).length,
  "PRECHECK G": (db) => anuncios(db).filter((a) => a.marketplace === "ML" && a.loja_id != null).length,
};

// ── Estrutura (blocos por rótulo) ────────────────────────────────────
const blocosDo = (sql: string) => [...sql.matchAll(/\bdo\s+\$\$([\s\S]*?)\$\$\s*;/gi)].map((m) => m[1]);
const blocoCom = (sql: string, marca: RegExp) => blocosDo(sql).find((b) => marca.test(b)) ?? null;
/** O bloco rotulado está ATIVO: "if n > 0 then raise exception '<rótulo>". */
const ativo = (bloco: string, rotulo: string) =>
  new RegExp(`if\\s+n\\s*>\\s*0\\s+then\\s+raise\\s+exception\\s+'${rotulo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(bloco);
/** SELECT da temp table de snapshot, tirado do SQL real. */
const SELECT_SNAPSHOT = /create\s+temp\s+table\s+(\w+)\s+on\s+commit\s+drop\s+as\s+([\s\S]*?);/i.exec(SQL);

imprimir(`\n[ANUNCIOS ML LOJA fase 1 — ${MIGRACAO}]`);
imprimir("\n[1. estrutura]");

t("S1. uma transação; precheck ANTES de qualquer escrita/DDL; rótulos A–G e V1–V7 ativos", () => {
  assert(/^\s*begin\s*;/im.test(SQL) && /^\s*commit\s*;\s*$/im.test(SQL), "sem begin/commit");
  const iPre = SQL.search(/PRECHECK A/), iEsc = Math.min(...[/create\s+or\s+replace\s+function/i, /drop\s+trigger/i, /update\s+public\./i, /create\s+temp/i].map((r) => { const i = SQL.search(r); return i < 0 ? Infinity : i; }));
  assert(iPre > 0 && iPre < iEsc, "precheck não vem antes da primeira escrita/DDL");
  const pre = blocoCom(SQL, /PRECHECK A/) ?? "";
  for (const r of "ABCDEFG") assert(ativo(pre, `PRECHECK ${r}`), `PRECHECK ${r} ausente ou neutralizado`);
  const val = blocoCom(SQL, /V1:/) ?? "";
  for (let i = 1; i <= 7; i++) assert(ativo(val, `V${i}:`), `V${i} ausente ou neutralizado`);
  assert(SQL.search(/V1:/) > SQL.search(/update\s+public\.anuncios/i), "validação antes do backfill");
});

t("S2. nada de escolha arbitrária: sem created_at / order by / limit / max / min / distinct on / array_agg no SQL executável", () => {
  for (const r of [/created_at/i, /order\s+by/i, /\blimit\b/i, /\bmax\s*\(/i, /\bmin\s*\(/i, /distinct\s+on/i, /array_agg/i, /\bfirst_value\b/i, /row_number/i])
    assert(!r.test(SQL), `SQL executável usa ${r}`);
});

t("S3. sem UNIQUE ML, sem CHECK/ALTER, sem histórico de migrations, sem IF [NOT] EXISTS mascarando estado", () => {
  assert(!/create\s+unique\s+index/i.test(SQL) && !/anuncios_ml_identidade_uq/i.test(SQL), "UNIQUE ML criada");
  assert(!/alter\s+table/i.test(SQL) && !/add\s+constraint/i.test(SQL), "ALTER/CHECK nesta fase");
  assert(!/schema_migrations/i.test(SQL), "toca o histórico de migrations");
  assert(!/\b(create|drop|alter)\b[^;]*?\bif\s+(not\s+)?exists/i.test(SQL), "IF [NOT] EXISTS em DDL mascarando divergência");
  assert(!/anuncios_shopee_identidade_uq|anuncios_shopee_exige_loja/i.test(SQL), "mexe nos contratos Shopee");
});

t("S4. UM único UPDATE (o backfill), só em anuncios, e o SET grava SÓ loja_id", () => {
  const ups = [...SQL.matchAll(/\bupdate\s+public\.(\w+)/gi)].map((m) => m[1]);
  assert(ups.length === 1 && ups[0] === "anuncios", `UPDATEs: ${ups}`);
  assert(!/\b(insert\s+into|delete\s+from|truncate)\b/i.test(SQL), "INSERT/DELETE/TRUNCATE em dado");
  const m = /update\s+public\.anuncios\s+\w+\s+set\s+([\s\S]*?)\s+where/i.exec(SQL)!;
  assert(/^loja_id\s*=/.test(m[1].trim()) && !/,\s*\w+\s*=/.test(m[1].replace(/\([\s\S]*\)/g, "")), `SET: ${m[1]}`);
});

t("S5. marketplace real: 'ML'/'Shopee' nas duas tabelas = constante do runtime (MARKETPLACE_ML)", () => {
  const conexao = readFileSync(join(RAIZ, "lib/ml-conexao.ts"), "utf8");
  assert(/export const MARKETPLACE_ML = "ML";/.test(conexao), "MARKETPLACE_ML do runtime não é 'ML'");
  assert(!/MercadoLivre|mercado_livre/i.test(SQL), "valor conceitual em vez do real");
  assert(/l\.marketplace\s*=\s*new\.marketplace/i.test(SQL), "validação não compara lojas.marketplace com anuncios.marketplace");
});

t("S6. ponte marcada TRANSITIONAL_COMPATIBILITY_ONLY e removível pela 20261108; rollback documentado (não executável)", () => {
  const fn = /^create\s+or\s+replace\s+function[\s\S]*?\$\$\s*;/im.exec(BRUTO)?.[0] ?? "";
  assert(/TRANSITIONAL_COMPATIBILITY_ONLY/.test(fn) && /20261108/.test(fn), "função sem a marca transitória");
  assert(/ROLLBACK CONTROLADO/.test(BRUTO) && /before insert or update of loja_id, user_id on public\.anuncios/.test(BRUTO), "rollback sem a definição anterior");
  assert(!/^\s*(drop\s+function|update\s+public\.anuncios\s+set\s+loja_id\s*=\s*null)/im.test(SQL), "rollback executável no arquivo");
});

t("S7. limites LOCAIS logo após o begin e antes dos locks; lock modes exatos; validação explícita não exige ativo", () => {
  const iBegin = SQL.search(/^\s*begin\s*;/im), iLock = SQL.search(/lock\s+table/i);
  const iLt = SQL.search(/set\s+local\s+lock_timeout\s*=\s*'5s'\s*;/i), iSt = SQL.search(/set\s+local\s+statement_timeout\s*=\s*'60s'\s*;/i);
  assert(iLt > iBegin && iSt > iBegin && iLt < iLock && iSt < iLock, "lock_timeout/statement_timeout locais ausentes ou depois dos locks");
  assert(!/(^|;)\s*set\s+(session\s+)?(lock_timeout|statement_timeout)\b/im.test(SQL) && !/alter\s+(system|database|role)/i.test(SQL), "timeout global/de sessão");
  const locks = [...SQL.matchAll(/lock\s+table\s+public\.(\w+)\s+in\s+([\w\s]+?)\s+mode\s*;/gi)].map((m) => `${m[1]}:${m[2].toLowerCase().replace(/\s+/g, " ")}`);
  assert(JSON.stringify(locks) === JSON.stringify(["anuncios:share row exclusive", "lojas:share"]), `locks: ${locks}`);
  const fn = /create\s+or\s+replace\s+function[\s\S]*?\$\$\s*;/i.exec(SQL)![0];
  const permanente = /if\s+new\.loja_id\s+is\s+not\s+null\s+and\s+not\s+exists\s*\(([\s\S]*?)\)\s*then/i.exec(fn)?.[1] ?? "";
  assert(permanente && !/\bativo\b/i.test(permanente), `validação explícita depende de ativo: ${permanente}`);
});

t("S8. o interpretador executa o SCRIPT INTEIRO, na ordem: begin, set local×2, lock×2, do(precheck), temp, função, drop/create trigger, do(backfill), do(validação), commit", () => {
  const r = aplicar(SQL, bancoProducao());
  assert(r.ok, `abortou: ${(r as any).erro}`);
  const esperado = ["begin", "set local", "set local", "lock table", "lock table", "do $$", "create temp", "create or", "drop trigger", "create trigger", "do $$", "do $$", "commit"];
  assert(JSON.stringify(r.comandos) === JSON.stringify(esperado), `comandos: ${r.comandos}`);
  assert(r.db.config.lock_timeout === "5s" && r.db.config.statement_timeout === "60s", JSON.stringify(r.db.config));
  assert(JSON.stringify(r.db.locks) === JSON.stringify([{ tabela: A, modo: "share row exclusive" }, { tabela: LJ, modo: "share" }]), JSON.stringify(r.db.locks));
  assert(Object.keys(r.db.temp).length === 0, "temp ON COMMIT DROP sobreviveu ao commit");
  assert(comandosDoScript(BRUTO).length === esperado.length, "comentários do arquivo viraram comando");
});

imprimir("\n[2. prechecks executados do SQL — PRECHECK G e diferencial com oráculo]");

t("G1. 871 ML todas com loja_id NULL → contador do PRECHECK G (calculado pelo SQL) = 0 → migration PASSA e preenche as 871", () => {
  const db0 = banco871();
  const r = aplicar(SQL, db0);
  assert(r.ok, `abortou: ${(r as any).erro}`);
  assert(contadorNoTraco(r.traco, "PRECHECK G") === 0, `G contou ${contadorNoTraco(r.traco, "PRECHECK G")}`);
  const ml = anuncios(r.db).filter((a) => a.marketplace === "ML");
  assert(ml.length === 871 && ml.every((a) => a.loja_id != null), `ML com loja: ${ml.filter((a) => a.loja_id).length}/${ml.length}`);
  assert(r.notices.some((n) => /871 row\(s\) ML preenchida/.test(n)), `notice: ${r.notices}`);
});

t("G2. 1 ML com loja_id preenchido → PRECHECK G conta 1 e ABORTA (nada muda)", () => {
  const db0 = bancoProducao(); anuncios(db0).find((a) => a.id === "an-0001")!.loja_id = L(1);
  const r = aplicar(SQL, db0);
  assert(!r.ok && /^PRECHECK G: 1 /.test(r.erro), `esperava PRECHECK G: 1 → ${JSON.stringify((r as any).erro ?? "aplicou")}`);
  assert(contadorNoTraco(r.traco, "PRECHECK G") === 1, "contador do traço ≠ 1");
  assert(JSON.stringify(r.db) === JSON.stringify(db0), "estado mudou");
});

t("G3. 870 NULL + 1 preenchida → contador do PRECHECK G = 1 (só as preenchidas contam)", () => {
  const db0 = banco871(); anuncios(db0)[0].loja_id = L(1);
  const r = aplicar(SQL, db0);
  assert(!r.ok && contadorNoTraco(r.traco, "PRECHECK G") === 1, `G contou ${contadorNoTraco(r.traco, "PRECHECK G")}`);
});

t("G4. sensibilidade: o mesmo SQL com G invertido (IS NOT NULL → IS NULL) contaria as 871 e abortaria um estado limpo", () => {
  const a = "where marketplace = 'ML' and loja_id is not null;";
  assert(SQL.split(a).length === 2, "condição do PRECHECK G não encontrada exatamente uma vez");
  const r = aplicar(SQL.replace(a, a.replace("is not null", "is null")), banco871());
  assert(!r.ok && /^PRECHECK G: 871 /.test(r.erro), `inversão não detectada: ${JSON.stringify((r as any).erro ?? "aplicou")}`);
});

t("P1. diferencial: em 7 bancos (limpo + 1 violação de cada A–G), o contador de cada precheck calculado PELO SQL = oráculo", () => {
  const variantes: Array<[string, (db: Banco) => void]> = [
    ["limpo", () => {}],
    ["A", (db) => anuncios(db).push(anuncio(D(5), "ML", "MLB50", null))],
    ["B", (db) => anuncios(db).push(anuncio(D(4), "ML", "MLB60", null))],
    ["C", (db) => anuncios(db).push(anuncio(D(1), "ML", "MLB1", null))],
    ["D", (db) => { anuncios(db).find((a) => a.id === "an-0009")!.loja_id = L(2); }],
    ["E", (db) => { anuncios(db).find((a) => a.id === "an-0007")!.loja_id = L(1); }],
    ["G", (db) => { anuncios(db).find((a) => a.id === "an-0001")!.loja_id = L(1); }],
  ];
  for (const [nome, mexer] of variantes) {
    const db0 = bancoProducao(); mexer(db0);
    const r = aplicar(SQL, db0);
    let comparados = 0;
    for (const [rotulo, oraculo] of Object.entries(ORACULO)) {
      const sqlConta = contadorNoTraco(r.traco, rotulo);
      if (sqlConta === null) continue;          // bloco não chegou a rodar (abortou antes)
      assert(sqlConta === oraculo(db0), `${nome}/${rotulo}: SQL=${sqlConta} oráculo=${oraculo(db0)}`);
      comparados++;
    }
    assert(comparados > 0, `${nome}: nenhum precheck comparado`);
    if (nome !== "limpo") assert(!r.ok && r.erro.startsWith(`PRECHECK ${nome}`), `${nome}: ${JSON.stringify((r as any).erro ?? "aplicou")}`);
  }
});

imprimir("\n[3. backfill por cardinalidade]");

t("B1. formato de produção: toda row ML recebe a loja ML ÚNICA do dono; só loja_id muda; Shopee intocada", () => {
  const db0 = bancoProducao();
  const r = aplicar(SQL, db0);
  assert(r.ok, `abortou: ${(r as any).erro}`);
  const ml = anuncios(r.db).filter((a) => a.marketplace === "ML");
  assert(ml.length === 6 && ml.every((a) => a.loja_id === r.db.tabelas[LJ].find((l) => l.user_id === a.user_id && l.marketplace === "ML")!.id), JSON.stringify(ml.map((a) => [a.id, a.loja_id])));
  for (const a0 of anuncios(db0)) {
    const a = anuncios(r.db).find((x) => x.id === a0.id)!;
    assert(semLoja(a) === semLoja(a0), `campo além de loja_id mudou em ${a0.id}`);
    if (a0.marketplace === "Shopee") assert(a.loja_id === a0.loja_id, `Shopee ${a0.id} mudou de loja`);
  }
});

t("B2. loja ML criada DEPOIS dos anúncios e loja ML inativa: cardinalidade decide (created_at/ativo não entram)", () => {
  const db = estado3();
  assert(lojaDe(db, "an-0004") === L(4) && lojaDe(db, "an-0005") === L(4), "dono com loja posterior ficou sem loja");
  assert(lojaDe(db, "an-0006") === L(5), "loja ML única inativa não usada");
});

t("B3. dono com anúncio ML e 0 lojas ML → ABORTA (A) e nada muda", () => {
  const db0 = bancoProducao(); anuncios(db0).push(anuncio(D(5), "ML", "MLB50", null));
  const r = aplicar(SQL, db0);
  assert(!r.ok && /^PRECHECK A/.test(r.erro), `esperava PRECHECK A: ${JSON.stringify((r as any).erro)}`);
  assert(JSON.stringify(r.db) === JSON.stringify(db0), "estado mudou");
});

t("B4. dono com anúncio ML e 2 lojas ML → ABORTA (B); e o bloco de backfill sozinho nunca escolhe uma delas", () => {
  const db0 = bancoProducao(); anuncios(db0).push(anuncio(D(4), "ML", "MLB60", null));
  const r = aplicar(SQL, db0);
  assert(!r.ok && /^PRECHECK B/.test(r.erro), `esperava PRECHECK B: ${JSON.stringify((r as any).erro)}`);
  const semPrecheck = SQL.replace(/do\s+\$\$[\s\S]*?PRECHECK A[\s\S]*?\$\$\s*;/i, "");
  const r2 = aplicar(semPrecheck, db0);
  assert(!r2.ok && /^BACKFILL/.test(r2.erro), `backfill não abortou sozinho: ${JSON.stringify((r2 as any).erro ?? "aplicou")}`);
});

t("B5. prechecks C–G: duplicata ML, loja de outro dono, marketplace incompatível, Shopee sem loja / duplicada, ML já com loja → ABORTA", () => {
  const casos: Array<[string, (db: Banco) => void]> = [
    ["PRECHECK C", (db) => anuncios(db).push(anuncio(D(1), "ML", "MLB1", null))],
    ["PRECHECK D", (db) => { anuncios(db).find((a) => a.id === "an-0009")!.loja_id = L(2); }],
    ["PRECHECK E", (db) => { anuncios(db).find((a) => a.id === "an-0007")!.loja_id = L(1); }],
    ["PRECHECK F", (db) => { anuncios(db).find((a) => a.id === "an-0009")!.loja_id = null; }],
    ["PRECHECK F", (db) => anuncios(db).push(anuncio(D(5), "Shopee", "8001", "9", { loja_id: L(8) }))],
    ["PRECHECK G", (db) => { anuncios(db).find((a) => a.id === "an-0001")!.loja_id = L(1); }],
  ];
  for (const [rotulo, mexer] of casos) {
    const db0 = bancoProducao(); mexer(db0);
    const r = aplicar(SQL, db0);
    assert(!r.ok && r.erro.startsWith(rotulo), `${rotulo}: ${JSON.stringify((r as any).erro ?? "aplicou")}`);
  }
});

t("B6. backfill por TODAS as lojas ML: dono com 1 única loja ML total, INATIVA, é backfillado; a ponte recusa novo anúncio dele", () => {
  const db = estado3();
  assert(lojaDe(db, "an-0006") === L(5) && db.tabelas[LJ].find((l) => l.id === L(5))!.ativo === false, "backfill deixou de usar a loja inativa única");
  assert(!/\bativo\b/i.test(blocoCom(SQL, /update\s+public\.anuncios/i)!), "backfill passou a filtrar ativo");
  assert(tenta(() => inserir(db, anuncio(D(3), "ML", "MLB307", null))) !== null, "ponte aceitou dono sem loja ativa");
});

imprimir("\n[4. validações V1–V7 executadas do SQL — prova negativa isolada de cada uma]");

const VALIDACAO = blocoCom(SQL, /V1:/)!;
/** Estado 3 + snapshot tirado PELO SELECT DA MIGRATION; `mexer` cria a violação (antes ou depois do snapshot). */
function validar(mexerAntes: (db: Banco) => void, mexerDepois: (db: Banco) => void) {
  const db = estado3();
  mexerAntes(db);
  assert(SELECT_SNAPSHOT, "CREATE TEMP do snapshot não encontrado");
  db.temp[SELECT_SNAPSHOT![1].toLowerCase()] = consultar(SELECT_SNAPSHOT![2], db);
  mexerDepois(db);
  return executarBlocoDo(VALIDACAO, db, restricoes);
}
const nada = () => {};
const linhaDe = (db: Banco, id: string) => anuncios(db).find((a) => a.id === id)!;

t("V0. estado 3 íntegro + snapshot do próprio SQL → V1–V7 passam (todos os contadores = 0)", () => {
  const r = validar(nada, nada);
  assert(r.erro === null, `validação falhou num estado íntegro: ${r.erro}`);
  for (let i = 1; i <= 7; i++) assert(contadorNoTraco(r.traco, `V${i}`) === 0, `V${i} contou ${contadorNoTraco(r.traco, `V${i}`)}`);
});

const NEGATIVOS: Array<[string, string, (db: Banco) => void, (db: Banco) => void]> = [
  ["V1", "row nova depois do snapshot", nada, (db) => { anuncios(db).push({ ...linhaDe(db, "an-0001"), id: "an-novo", ml_item_id: "MLBX" }); }],
  ["V1", "row sumiu depois do snapshot", nada, (db) => { db.tabelas[A] = anuncios(db).filter((a) => a.id !== "an-0009"); }],
  ["V2", "row ML sem loja", nada, (db) => { linhaDe(db, "an-0001").loja_id = null; }],
  ["V3", "row ML com loja ML de outro dono", nada, (db) => { linhaDe(db, "an-0001").loja_id = L(4); }],
  ["V4", "row Shopee com loja ML do mesmo dono", nada, (db) => { linhaDe(db, "an-0007").loja_id = L(1); }],
  ["V5", "campo de row Shopee alterado", nada, (db) => { linhaDe(db, "an-0007").nome = "outro"; }],
  ["V6", "campo de row ML alterado", nada, (db) => { linhaDe(db, "an-0001").preco_anuncio = 99; }],
  ["V7", "identidade ML duplicada na mesma loja", (db) => { anuncios(db).push({ ...linhaDe(db, "an-0001"), id: "an-dup" }); }, nada],
];
for (const [v, descricao, antes, depois] of NEGATIVOS) {
  t(`${v}. ${descricao} → o bloco de validação do SQL aborta EM ${v} (contador de ${v} > 0)`, () => {
    const r = validar(antes, depois);
    assert(r.erro !== null && r.erro.startsWith(`${v}:`), `esperava ${v}: ${JSON.stringify(r.erro)}`);
    assert((contadorNoTraco(r.traco, v) ?? 0) > 0, `contador de ${v} = ${contadorNoTraco(r.traco, v)}`);
  });
}

imprimir("\n[5. estado 3: trigger dono + marketplace + ponte transitória]");

t("R1. runtime antigo insere ML SEM loja_id, dono com exatamente 1 loja ML ativa → banco atribui a loja correta", () => {
  const db = estado3();
  assert(inserir(db, anuncio(D(1), "ML", "MLB100", null)).loja_id === L(1), "loja não atribuída");
});
t("R2. ML sem loja_id, dono com 0 lojas ML → REJEITADO", () => {
  const db = estado3(); const n = anuncios(db).length;
  assert(tenta(() => inserir(db, anuncio(D(5), "ML", "MLB102", null))) !== null && anuncios(db).length === n, "aceitou");
});
t("R3. ML sem loja_id, dono com 2 lojas ML (inativas) → REJEITADO (nenhuma escolhida)", () => {
  const db = estado3(); const n = anuncios(db).length;
  assert(tenta(() => inserir(db, anuncio(D(4), "ML", "MLB103", null))) !== null && anuncios(db).length === n, "aceitou");
});
t("R4. ML com loja_id explícito correto → aceito sem troca", () => {
  const db = estado3();
  assert(inserir(db, anuncio(D(1), "ML", "MLB104", null, { loja_id: L(1) })).loja_id === L(1), "trocou/rejeitou");
});
t("R5. ML apontando loja ML de OUTRO dono → REJEITADO", () => {
  assert(tenta(() => inserir(estado3(), anuncio(D(1), "ML", "MLB105", null, { loja_id: L(4) }))) !== null, "aceitou loja alheia");
});
t("R6. ML apontando loja SHOPEE do mesmo dono → REJEITADO", () => {
  assert(tenta(() => inserir(estado3(), anuncio(D(1), "ML", "MLB106", null, { loja_id: L(2) }))) !== null, "ML aceitou loja Shopee");
});
t("R7. Shopee válida → preservada; Shopee de outro dono / sem loja / duplicada → rejeitada", () => {
  const db = estado3();
  assert(inserir(db, anuncio(D(1), "Shopee", "7002", null, { loja_id: L(3) })).loja_id === L(3), "Shopee válida rejeitada");
  assert(tenta(() => inserir(db, anuncio(D(1), "Shopee", "7003", null, { loja_id: L(8) }))) !== null, "Shopee de outro dono aceita");
  assert(tenta(() => inserir(db, anuncio(D(1), "Shopee", "7004", null))) !== null, "Shopee sem loja aceita (ponte vazou para Shopee)");
  assert(tenta(() => inserir(db, anuncio(D(1), "Shopee", "7001", null, { loja_id: L(2) }))) !== null, "UNIQUE Shopee deixou de valer");
});
t("R8. Shopee apontando loja ML do mesmo dono → REJEITADO", () => {
  assert(tenta(() => inserir(estado3(), anuncio(D(1), "Shopee", "7005", null, { loja_id: L(1) }))) !== null, "Shopee aceitou loja ML");
});
t("R9. UPDATE de marketplace dispara o trigger: row Shopee virando ML com loja Shopee → REJEITADO", () => {
  const db = estado3();
  const g = db.gatilhos.find((x) => x.nome === "anuncios_loja_do_dono")!;
  assert(g.insert && ["loja_id", "user_id", "marketplace"].every((c) => g.colunasUpdate!.includes(c)), `trigger: ${JSON.stringify(g)}`);
  assert(tenta(() => atualizar(db, "an-0007", { marketplace: "ML" })) !== null, "virou ML com loja Shopee");
});
t("R10. UPDATE ML zerando loja_id → ponte reatribui a única ativa; 2 ativas → rejeitado; ML sem dono → rejeitado", () => {
  const db = estado3();
  assert(atualizar(db, "an-0001", { loja_id: null }).loja_id === L(1), "não reatribuiu");
  db.tabelas[LJ].push(loja(19, D(1), "ML"));
  assert(tenta(() => atualizar(db, "an-0002", { loja_id: null })) !== null, "escolheu entre 2 lojas ML ativas");
  assert(tenta(() => inserir(db, anuncio(null, "ML", "MLB107", null))) !== null, "ML sem dono aceito");
});
t("R11. update que não toca loja/dono/marketplace (ex.: SKU) não passa pelo trigger e não muda loja", () => {
  const db = estado3();
  const a = atualizar(db, "an-0002", { sku: "X" });
  assert(a.loja_id === L(1) && a.sku === "X", JSON.stringify(a));
});

imprimir("\n[6. ponte por lojas ML ATIVAS; loja explícita não depende de ativo]");

const L7 = (i: number) => `70000000-0000-4000-8000-00000000000${i}`;
const comLojas = (...ativos: boolean[]) => {
  const db = estado3();
  ativos.forEach((a, i) => db.tabelas[LJ].push({ ...loja(70 + i, D(7), "ML"), id: L7(i), ativo: a }));
  return db;
};
t("T1. 1 loja ML ATIVA → NULL recebe essa loja", () => {
  assert(inserir(comLojas(true), anuncio(D(7), "ML", "MLB300", null)).loja_id === L7(0), "não atribuiu a ativa");
});
t("T2. 0 lojas ML ativas (nenhuma loja) → rejeita", () => {
  assert(tenta(() => inserir(comLojas(), anuncio(D(7), "ML", "MLB301", null))) !== null, "aceitou sem loja ativa");
});
t("T3. 2 lojas ML ATIVAS → rejeita (nenhuma escolhida)", () => {
  const db = comLojas(true, true); const n = anuncios(db).length;
  assert(tenta(() => inserir(db, anuncio(D(7), "ML", "MLB302", null))) !== null && anuncios(db).length === n, "escolheu entre 2 ativas");
});
t("T4. 1 ativa + 1 inativa → escolhe EXATAMENTE a ativa (em qualquer ordem)", () => {
  for (const ordem of [[true, false], [false, true]]) {
    assert(inserir(comLojas(...ordem), anuncio(D(7), "ML", "MLB303", null)).loja_id === L7(ordem.indexOf(true)), `ordem ${ordem}: não escolheu a ativa`);
  }
});
t("T5. 0 ativas + 2 inativas → rejeita; dono com 1 só inativa → rejeita", () => {
  assert(tenta(() => inserir(comLojas(false, false), anuncio(D(7), "ML", "MLB304", null))) !== null, "aceitou com 2 inativas");
  assert(tenta(() => inserir(comLojas(false), anuncio(D(7), "ML", "MLB305", null))) !== null, "ponte aceitou loja inativa sem ativa");
});
t("T6. loja_id EXPLÍCITA de loja ML INATIVA do mesmo dono → aceita, e o trigger não troca pela ativa", () => {
  const db = comLojas(false, true);
  const a = inserir(db, anuncio(D(7), "ML", "MLB306", null, { loja_id: L7(0) }));
  assert(a.loja_id === L7(0), `trocou a loja explícita: ${a.loja_id}`);
  assert(atualizar(db, a.id, { loja_id: L7(0), user_id: D(7) }).loja_id === L7(0), "UPDATE explícito trocou a loja");
});

t("N1. estado 3 não tem UNIQUE ML: a migration não impõe identidade ML (fica para a 20261108)", () => {
  assert(tenta(() => inserir(estado3(), anuncio(D(1), "ML", "MLB1", null, { loja_id: L(1) }))) === null, "estado 3 já rejeita duplicata ML");
});
t("N2. antes da migration (estado 2), o mesmo runtime grava ML sem loja e aceita loja Shopee em row ML — o buraco que a 20261107 fecha", () => {
  const db = bancoProducao();
  assert(inserir(db, anuncio(D(1), "ML", "MLB200", null)).loja_id === null, "controle: estado 2 já atribuía loja");
  assert(tenta(() => inserir(db, anuncio(D(1), "ML", "MLB201", null, { loja_id: L(2) }))) === null, "controle: estado 2 já validava marketplace");
});

imprimir(`\n${falhou === 0 ? "✓" : "✗"} ANUNCIOS-ML-LOJA-FASE1 — ${ok} passaram, ${falhou} falharam`);
process.exit(falhou === 0 ? 0 : 1);
