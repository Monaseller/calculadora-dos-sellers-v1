/**
 * CDS V2 — Fase 2B: migration 20261107_anuncios_ml_loja_fase1.sql (local, NÃO aplicada) → estado 3.
 *
 * Contrato:
 *   • backfill de anuncios.loja_id SÓ das rows ML sem loja, por CARDINALIDADE (dono com exatamente
 *     1 loja ML) — nunca created_at / mais recente / primeira / LIMIT; só loja_id muda; Shopee intocada;
 *   • trigger anuncios_loja_do_dono valida DONO + MARKETPLACE (permanente) e dispara também em
 *     UPDATE OF marketplace;
 *   • ponte TRANSITIONAL_COMPATIBILITY_ONLY: row ML sem loja_id (runtime d570ff8) recebe a loja ML
 *     ÚNICA do dono; 0 ou 2+ lojas ML → RAISE (o runtime antigo não reintroduz ML sem loja);
 *   • precheck fail-closed A–G antes de qualquer escrita; validação final V1–V7; sem UNIQUE/CHECK ML.
 *
 * Semântica, não snapshot: a função do trigger, a lista de colunas do trigger e o bloco de backfill
 * são EXECUTADOS a partir do TEXTO da migration por um interpretador do subconjunto SQL/plpgsql que
 * ela usa (expressões, subconsultas escalares/count/exists, IF, SELECT INTO [STRICT], UPDATE, GET
 * DIAGNOSTICS, RAISE, NEW.col :=). Construção fora do subconjunto → erro (fail-closed). Prechecks e
 * validações (GROUP BY/JOIN) são conferidos pela presença/ordem dos blocos rotulados e reproduzidos.
 * Sem banco real, sem rede.
 *
 * LIMITE (honesto): este interpretador NÃO substitui o Postgres. Offline NÃO prova o parser real do
 * PostgreSQL, locks reais (lock_timeout/statement_timeout), temp table ON COMMIT DROP nem to_jsonb.
 * Isso só é provado no gate de aplicação (precheck por SELECT + migration numa transação).
 *
 * Uso: npx tsx scripts/testar-anuncios-ml-loja-fase1.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

// ── Interpretador do subconjunto SQL/plpgsql ─────────────────────────
type Linha = Record<string, any>;
type Banco = { anuncios: Linha[]; lojas: Linha[] };
class ErroSQL extends Error {}

type Tok = { t: "id" | "str" | "num" | "op"; v: string };
function tokenizar(s: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "'") { let j = i + 1, v = ""; while (j < s.length) { if (s[j] === "'" && s[j + 1] === "'") { v += "'"; j += 2; continue; } if (s[j] === "'") break; v += s[j++]; } out.push({ t: "str", v }); i = j + 1; continue; }
    if (/\d/.test(c)) { let j = i; while (j < s.length && /\d/.test(s[j])) j++; out.push({ t: "num", v: s.slice(i, j) }); i = j; continue; }
    if (/[A-Za-z_]/.test(c)) { let j = i; while (j < s.length && /[\w]/.test(s[j])) j++; out.push({ t: "id", v: s.slice(i, j).toLowerCase() }); i = j; continue; }
    const dois = s.slice(i, i + 2);
    if (["<>", ":=", ">=", "<=", "!="].includes(dois)) { out.push({ t: "op", v: dois === "!=" ? "<>" : dois }); i += 2; continue; }
    if ("=<>(),.*;%".includes(c)) { out.push({ t: "op", v: c }); i++; continue; }
    throw new ErroSQL(`token não suportado: ${s.slice(i, i + 20)}`);
  }
  return out;
}

type Ctx = { banco: Banco; alias: Record<string, Linha>; vars: Record<string, any>; linha?: Linha };
class Leitor {
  p = 0;
  constructor(public k: Tok[]) {}
  ver(o = 0) { return this.k[this.p + o]; }
  eh(v: string, o = 0) { const x = this.ver(o); return !!x && (x.t === "id" || x.t === "op") && x.v === v; }
  tomar(v?: string) { const x = this.k[this.p]; if (!x) throw new ErroSQL(`fim inesperado (esperava ${v})`); if (v !== undefined && x.v !== v) throw new ErroSQL(`esperava "${v}", veio "${x.v}"`); this.p++; return x; }
  opc(v: string) { if (this.eh(v)) { this.p++; return true; } return false; }
}
type Expr = (c: Ctx) => any;
type Sub = { item: "count" | { alias: string; col: string } | "um"; tabela: keyof Banco; alias: string; onde: Expr | null; ordem: { alias: string; col: string; desc: boolean } | null; limite: number | null };

function lerSub(L: Leitor): Sub {
  L.tomar("select");
  let item: Sub["item"];
  if (L.eh("count")) { L.tomar("count"); L.tomar("("); L.tomar("*"); L.tomar(")"); item = "count"; }
  else if (L.ver()?.t === "num") { L.tomar(); item = "um"; }
  else { const a = L.tomar().v; L.tomar("."); item = { alias: a, col: L.tomar().v }; }
  return lerResto(L, item);
}
function lerResto(L: Leitor, item: Sub["item"], intoAntes?: () => void): Sub {
  intoAntes?.();
  L.tomar("from"); L.tomar("public"); L.tomar(".");
  const tabela = L.tomar().v as keyof Banco;
  if (tabela !== "lojas" && tabela !== "anuncios") throw new ErroSQL(`tabela não suportada: ${tabela}`);
  let alias = tabela as string;
  if (L.ver()?.t === "id" && !["where", "order", "limit"].includes(L.ver().v)) alias = L.tomar().v;
  let onde: Expr | null = null, ordem: Sub["ordem"] = null, limite: number | null = null;
  if (L.opc("where")) onde = lerExpr(L);
  if (L.opc("order")) { L.tomar("by"); const a = L.tomar().v; L.tomar("."); const col = L.tomar().v; const desc = L.opc("desc"); if (!desc) L.opc("asc"); ordem = { alias: a, col, desc }; }
  if (L.opc("limit")) limite = Number(L.tomar().v);
  return { item, tabela, alias, onde, ordem, limite };
}
function rodarSub(s: Sub, c: Ctx): Linha[] {
  let linhas = c.banco[s.tabela].filter((r) => !s.onde || s.onde({ ...c, alias: { ...c.alias, [s.alias]: r }, linha: r }) === true);
  if (s.ordem) { const o = s.ordem; linhas = [...linhas].sort((x, y) => (String(x[o.col]) < String(y[o.col]) ? -1 : String(x[o.col]) > String(y[o.col]) ? 1 : 0) * (o.desc ? -1 : 1)); }
  if (s.limite !== null) linhas = linhas.slice(0, s.limite);
  return linhas;
}
function valorSub(s: Sub, c: Ctx) {
  const linhas = rodarSub(s, c);
  if (s.item === "count") return linhas.length;
  if (linhas.length > 1) throw new ErroSQL("more than one row returned by a subquery used as an expression");
  if (!linhas.length) return null;
  return s.item === "um" ? 1 : linhas[0][s.item.col];
}
function lerExpr(L: Leitor): Expr {
  let e = lerE(L);
  while (L.opc("or")) { const a = e, b = lerE(L); e = (c) => { const x = a(c), y = b(c); return x === true || y === true ? true : x === null || y === null ? null : false; }; }
  return e;
}
function lerE(L: Leitor): Expr {
  let e = lerNao(L);
  while (L.opc("and")) { const a = e, b = lerNao(L); e = (c) => { const x = a(c), y = b(c); return x === false || y === false ? false : x === null || y === null ? null : true; }; }
  return e;
}
function lerNao(L: Leitor): Expr {
  if (L.opc("not")) { const a = lerNao(L); return (c) => { const x = a(c); return x === null ? null : !x; }; }
  return lerCmp(L);
}
function lerCmp(L: Leitor): Expr {
  const a = lerPrim(L);
  const op = L.ver();
  if (op && op.t === "op" && ["=", "<>", ">", "<", ">=", "<="].includes(op.v)) {
    L.tomar(); const b = lerPrim(L);
    return (c) => { const x = a(c), y = b(c); if (x === null || x === undefined || y === null || y === undefined) return null;
      switch (op.v) { case "=": return x === y; case "<>": return x !== y; case ">": return x > y; case "<": return x < y; case ">=": return x >= y; default: return x <= y; } };
  }
  if (L.opc("is")) {
    const neg = L.opc("not");
    if (L.opc("null")) return (c) => { const n = a(c) === null || a(c) === undefined; return neg ? !n : n; };
    L.tomar("distinct"); L.tomar("from"); const b = lerPrim(L);
    return (c) => { const x = a(c) ?? null, y = b(c) ?? null; const d = x !== y; return neg ? !d : d; };
  }
  return a;
}
function lerPrim(L: Leitor): Expr {
  const x = L.ver();
  if (!x) throw new ErroSQL("expressão incompleta");
  if (L.eh("exists")) { L.tomar(); L.tomar("("); const s = lerSub(L); L.tomar(")"); return (c) => rodarSub(s, c).length > 0; }
  if (L.eh("(")) {
    L.tomar("(");
    if (L.eh("select")) { const s = lerSub(L); L.tomar(")"); return (c) => valorSub(s, c); }
    const e = lerExpr(L); L.tomar(")"); return e;
  }
  if (x.t === "str") { L.tomar(); return () => x.v; }
  if (x.t === "num") { L.tomar(); return () => Number(x.v); }
  if (L.eh("null")) { L.tomar(); return () => null; }
  if (L.eh("true")) { L.tomar(); return () => true; }
  if (L.eh("false")) { L.tomar(); return () => false; }
  if (x.t === "id") {
    const a = L.tomar().v;
    if (L.opc(".")) { const col = L.tomar().v; return (c) => { const r = c.alias[a]; if (!r) throw new ErroSQL(`alias desconhecido: ${a}`); return r[col] ?? null; }; }
    // nome solto: variável plpgsql, senão coluna da tabela em escopo (FROM/UPDATE mais interno)
    return (c) => { if (a in c.vars) return c.vars[a]; if (c.linha && a in c.linha) return c.linha[a] ?? null; throw new ErroSQL(`nome desconhecido: ${a}`); };
  }
  throw new ErroSQL(`expressão não suportada: ${x.v}`);
}

type Exec = { db: Banco; novo?: Linha; vars: Record<string, any>; gatilho: Gatilho | null };
type Stmt = (e: Exec) => "return" | void;
function lerBloco(L: Leitor, fim: (L: Leitor) => boolean): Stmt[] {
  const out: Stmt[] = [];
  while (!fim(L)) out.push(lerStmt(L));
  return out;
}
const ctxDe = (e: Exec, extra: Record<string, Linha> = {}): Ctx => ({ banco: e.db, alias: { ...(e.novo ? { new: e.novo } : {}), ...extra }, vars: e.vars });
function lerStmt(L: Leitor): Stmt {
  if (L.opc("if")) {
    const cond = lerExpr(L); L.tomar("then");
    const corpo = lerBloco(L, (l) => l.eh("end") && l.eh("if", 1));
    L.tomar("end"); L.tomar("if"); L.tomar(";");
    return (e) => { if (cond(ctxDe(e)) === true) for (const s of corpo) if (s(e) === "return") return "return"; };
  }
  if (L.eh("select")) {
    L.tomar("select");
    let item: Sub["item"];
    if (L.eh("count")) { L.tomar("count"); L.tomar("("); L.tomar("*"); L.tomar(")"); item = "count"; }
    else { const a = L.tomar().v; L.tomar("."); item = { alias: a, col: L.tomar().v }; }
    L.tomar("into"); const estrito = L.opc("strict"); const alvo = L.tomar().v;
    const s = lerResto(L, item); L.tomar(";");
    return (e) => {
      const linhas = rodarSub(s, ctxDe(e));
      if (s.item === "count") { e.vars[alvo] = linhas.length; return; }
      if (estrito && linhas.length !== 1) throw new ErroSQL(linhas.length ? "query returned more than one row" : "query returned no rows");
      e.vars[alvo] = linhas.length ? linhas[0][(s.item as any).col] : null;
    };
  }
  if (L.opc("update")) {
    L.tomar("public"); L.tomar("."); const tabela = L.tomar().v as keyof Banco;
    if (tabela !== "anuncios") throw new ErroSQL(`UPDATE em tabela não suportada: ${tabela}`);
    let alias: string = tabela; if (!L.eh("set")) alias = L.tomar().v;
    L.tomar("set");
    const sets: Array<[string, Expr]> = [];
    do { const col = L.tomar().v; L.tomar("="); sets.push([col, lerExpr(L)]); } while (L.opc(","));
    let onde: Expr | null = null; if (L.opc("where")) onde = lerExpr(L); L.tomar(";");
    return (e) => {
      let n = 0;
      for (const r of [...e.db.anuncios]) {
        const c = { ...ctxDe(e, { [alias]: r }), linha: r };
        if (onde && onde(c) !== true) continue;
        const patch: Linha = {}; for (const [col, ex] of sets) patch[col] = ex(c);
        atualizar(e.db, e.gatilho, r.id, patch); n++;
      }
      e.vars.__row_count = n;
    };
  }
  if (L.opc("get")) { L.tomar("diagnostics"); const v = L.tomar().v; L.tomar("="); L.tomar("row_count"); L.tomar(";"); return (e) => { e.vars[v] = e.vars.__row_count ?? 0; }; }
  if (L.opc("raise")) {
    const nivel = L.tomar().v;
    const msg = L.tomar(); if (msg.t !== "str") throw new ErroSQL("raise sem mensagem literal");
    const args: Expr[] = []; while (L.opc(",")) args.push(lerExpr(L));
    if (L.opc("using")) { L.tomar("errcode"); L.tomar("="); L.tomar(); }
    L.tomar(";");
    return (e) => { if (nivel !== "exception") return; let i = 0; throw new ErroSQL(msg.v.replace(/%/g, () => String(args[i++]?.(ctxDe(e)) ?? ""))); };
  }
  if (L.eh("new") && L.eh(".", 1)) {
    L.tomar("new"); L.tomar("."); const col = L.tomar().v; L.tomar(":="); const ex = lerExpr(L); L.tomar(";");
    return (e) => { e.novo![col] = ex(ctxDe(e)); };
  }
  if (L.opc("return")) { L.tomar("new"); L.tomar(";"); return () => "return"; }
  throw new ErroSQL(`comando não suportado: ${L.ver()?.v} ${L.ver(1)?.v ?? ""}`);
}
/** Corpo plpgsql "declare ... begin <stmts> end" → comandos. */
function compilarCorpo(corpo: string): Stmt[] {
  const L = new Leitor(tokenizar(corpo));
  if (L.opc("declare")) while (!L.eh("begin")) L.tomar();
  L.tomar("begin");
  const stmts = lerBloco(L, (l) => l.eh("end") && !l.eh("if", 1));
  L.tomar("end"); L.opc(";");
  if (L.ver()) throw new ErroSQL(`sobra após o corpo: ${L.ver().v}`);
  return stmts;
}

// ── Peças da migration (derivadas do TEXTO) ──────────────────────────
type Gatilho = { funcao: Stmt[]; colunasUpdate: string[] | null };
function extrairFuncao(sql: string): Stmt[] {
  const m = /create\s+or\s+replace\s+function\s+public\.anuncios_loja_do_dono\(\)[\s\S]*?\bas\s+\$\$([\s\S]*?)\$\$\s*;/i.exec(sql);
  if (!m) throw new ErroSQL("função anuncios_loja_do_dono ausente");
  return compilarCorpo(m[1]);
}
function extrairGatilho(sql: string): Gatilho {
  const m = /create\s+trigger\s+anuncios_loja_do_dono\s+before\s+insert(?:\s+or\s+update(?:\s+of\s+([\w,\s]+?))?)?\s+on\s+public\.anuncios\s+for\s+each\s+row\s+execute\s+function\s+public\.anuncios_loja_do_dono\(\)/i.exec(sql);
  if (!m) throw new ErroSQL("trigger anuncios_loja_do_dono ausente");
  const cols = m[1] ? m[1].split(",").map((c) => c.trim().toLowerCase()) : null;
  return { funcao: extrairFuncao(sql), colunasUpdate: /update/i.test(m[0]) ? cols : [] };
}
const blocosDo = (sql: string) => [...sql.matchAll(/\bdo\s+\$\$([\s\S]*?)\$\$\s*;/gi)].map((m) => m[1]);
const blocoCom = (sql: string, marca: RegExp) => blocosDo(sql).find((b) => marca.test(b)) ?? null;

/** Regras do banco ANTES da migration (20261103/20261104): trigger só-dono em insert/update of loja_id,user_id. */
const GATILHO_ANTERIOR: Gatilho = {
  funcao: compilarCorpo(`begin
    if new.loja_id is not null and not exists (select 1 from public.lojas l where l.id = new.loja_id and l.user_id = new.user_id) then
      raise exception 'anuncios.loja_id nao pertence ao dono do anuncio';
    end if;
    return new;
  end`),
  colunasUpdate: ["loja_id", "user_id"],
};
function dispararGatilho(db: Banco, g: Gatilho | null, novo: Linha) {
  if (!g) return;
  const e: Exec = { db, novo, vars: {}, gatilho: g };
  for (const s of g.funcao) if (s(e) === "return") return;
}
function checks(db: Banco, r: Linha) {
  if (!["ML", "Shopee"].includes(r.marketplace)) throw new ErroSQL("anuncios_marketplace_check");
  if (r.marketplace === "Shopee" && r.loja_id == null) throw new ErroSQL("anuncios_shopee_exige_loja");
  if (r.loja_id != null && !db.lojas.some((l) => l.id === r.loja_id)) throw new ErroSQL("anuncios_loja_id_fkey");
  if (r.marketplace === "Shopee" && r.ml_item_id != null) {
    const k = (x: Linha) => [x.user_id, x.loja_id, x.marketplace, x.ml_item_id, x.variation_id ?? ""].join("|");
    if (db.anuncios.some((x) => x.id !== r.id && x.marketplace === "Shopee" && x.ml_item_id != null && k(x) === k(r))) throw new ErroSQL("anuncios_shopee_identidade_uq");
  }
}
function inserir(db: Banco, g: Gatilho | null, linha: Linha) {
  const novo = { ...linha }; dispararGatilho(db, g, novo); checks(db, novo); db.anuncios.push(novo); return novo;
}
function atualizar(db: Banco, g: Gatilho | null, id: string, patch: Linha) {
  const i = db.anuncios.findIndex((r) => r.id === id);
  const novo = { ...db.anuncios[i], ...patch };
  if (g && (g.colunasUpdate === null || Object.keys(patch).some((c) => g.colunasUpdate!.includes(c)))) dispararGatilho(db, g, novo);
  checks(db, novo); db.anuncios[i] = novo; return novo;
}

/** Prechecks/validações da migration (GROUP BY/JOIN): reproduzidos, mas SÓ se o bloco rotulado existir. */
const lojasML = (db: Banco, uid: string) => db.lojas.filter((l) => l.user_id === uid && l.marketplace === "ML").length;
const PRECHECKS: Record<string, (db: Banco) => number> = {
  "PRECHECK A": (db) => new Set(db.anuncios.filter((a) => a.marketplace === "ML" && a.loja_id == null && lojasML(db, a.user_id) === 0).map((a) => a.user_id)).size,
  "PRECHECK B": (db) => new Set(db.anuncios.filter((a) => a.marketplace === "ML" && a.loja_id == null && lojasML(db, a.user_id) > 1).map((a) => a.user_id)).size,
  "PRECHECK C": (db) => { const k = db.anuncios.filter((a) => a.marketplace === "ML" && a.ml_item_id != null).map((a) => `${a.user_id}|${a.ml_item_id}|${a.variation_id ?? ""}`); return k.length - new Set(k).size; },
  "PRECHECK D": (db) => db.anuncios.filter((a) => a.loja_id != null && !db.lojas.some((l) => l.id === a.loja_id && l.user_id === a.user_id)).length,
  "PRECHECK E": (db) => db.anuncios.filter((a) => a.loja_id != null && db.lojas.some((l) => l.id === a.loja_id && l.marketplace !== a.marketplace)).length,
  "PRECHECK F": (db) => db.anuncios.filter((a) => a.marketplace === "Shopee" && a.loja_id == null).length,
  "PRECHECK G": (db) => db.anuncios.filter((a) => a.marketplace === "ML" && a.loja_id != null).length,
};
const semLoja = (r: Linha) => { const { loja_id, ...resto } = r; return JSON.stringify(Object.keys(resto).sort().map((k) => [k, resto[k]])); };
const VALIDACOES: Record<string, (db: Banco, antes: Linha[]) => number> = {
  "V1:": (db, antes) => (db.anuncios.length === antes.length && antes.every((s) => db.anuncios.some((a) => a.id === s.id)) ? 0 : 1),
  "V2:": (db) => db.anuncios.filter((a) => a.marketplace === "ML" && a.loja_id == null).length,
  "V3:": (db) => PRECHECKS["PRECHECK D"](db),
  "V4:": (db) => PRECHECKS["PRECHECK E"](db),
  "V5:": (db, antes) => antes.filter((s) => s.marketplace === "Shopee").filter((s) => { const a = db.anuncios.find((x) => x.id === s.id)!; return a.loja_id !== s.loja_id || semLoja(a) !== semLoja(s); }).length,
  "V6:": (db, antes) => antes.filter((s) => semLoja(db.anuncios.find((x) => x.id === s.id)!) !== semLoja(s)).length,
  "V7:": (db) => { const k = db.anuncios.filter((a) => a.marketplace === "ML" && a.ml_item_id != null).map((a) => `${a.user_id}|${a.loja_id}|${a.ml_item_id}|${a.variation_id ?? ""}`); return k.length - new Set(k).size; },
};

/** O bloco rotulado só conta se estiver ATIVO: "if n > 0 then raise exception '<rótulo>" (não basta o texto existir). */
const ativo = (bloco: string, rotulo: string) =>
  new RegExp(`if\\s+n\\s*>\\s*0\\s+then\\s+raise\\s+exception\\s+'${rotulo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(bloco);

type Resultado ={ ok: true; db: Banco; gatilho: Gatilho; notices: number } | { ok: false; erro: string; db: Banco };
/** Aplica a migration (texto `sql`) sobre `db0` numa "transação": erro → estado original intacto. */
function aplicar(sql: string, db0: Banco): Resultado {
  const original = JSON.parse(JSON.stringify(db0)) as Banco;
  const db = JSON.parse(JSON.stringify(db0)) as Banco;
  try {
    if (!/^\s*begin\s*;/im.test(sql) || !/^\s*commit\s*;\s*$/im.test(sql)) throw new ErroSQL("migration fora de uma transação begin/commit");
    const pre = blocoCom(sql, /PRECHECK A/);
    if (!pre) throw new ErroSQL("bloco de precheck ausente");
    for (const [rotulo, contar] of Object.entries(PRECHECKS)) if (ativo(pre, rotulo)) { const n = contar(db); if (n > 0) throw new ErroSQL(`${rotulo}: ${n}`); }
    const antes = JSON.parse(JSON.stringify(db.anuncios)) as Linha[];
    const gatilho = extrairGatilho(sql);
    const backfill = blocoCom(sql, /update\s+public\.anuncios/i);
    if (!backfill) throw new ErroSQL("bloco de backfill ausente");
    const e: Exec = { db, vars: {}, gatilho };
    for (const s of compilarCorpo(backfill)) s(e);
    const val = blocoCom(sql, /V1:/);
    if (!val) throw new ErroSQL("bloco de validação ausente");
    for (const [rotulo, contar] of Object.entries(VALIDACOES)) if (ativo(val, rotulo)) { const n = contar(db, antes); if (n > 0) throw new ErroSQL(`${rotulo} ${n}`); }
    return { ok: true, db, gatilho, notices: 0 };
  } catch (err: any) {
    return { ok: false, erro: String(err?.message ?? err), db: original };
  }
}

// ── Cenário com o formato de produção (estado 2) ─────────────────────
const D = (n: number) => `d000000${n}-0000-4000-8000-000000000000`;
const L = (n: number) => `10000000-0000-4000-8000-00000000000${n}`;
function loja(n: number, dono: string, marketplace: "ML" | "Shopee", extra: Linha = {}): Linha {
  return { id: L(n), user_id: dono, marketplace, ativo: true, seller_id: `s${n}`, created_at: `2026-0${(n % 8) + 1}-01`, ...extra };
}
let seq = 0;
function anuncio(dono: string, marketplace: "ML" | "Shopee", item: string, variacao: string | null, extra: Linha = {}): Linha {
  return { id: `an-${String(++seq).padStart(4, "0")}`, user_id: dono, marketplace, ml_item_id: item, variation_id: variacao, loja_id: null,
    sku: null, ativo: true, nome: `n-${item}`, preco_anuncio: 10, custo_produto: 0, thumbnail: `t-${item}`, created_at: "2026-06-26", ...extra };
}
function bancoProducao(): Banco {
  seq = 0;
  const lojas = [
    loja(1, D(1), "ML"), loja(2, D(1), "Shopee"), loja(3, D(1), "Shopee"),      // dono com ML + 2 Shopee
    loja(4, D(2), "ML", { created_at: "2026-06-27" }),                         // loja ML criada DEPOIS dos anúncios (caso dos 196)
    loja(5, D(3), "ML", { ativo: false }),                                      // única loja ML, inativa: cardinalidade conta
    loja(6, D(4), "ML", { ativo: false }), loja(7, D(4), "ML", { ativo: false }), // 2 ML sem anúncios: irrelevante
    loja(8, D(5), "Shopee"),
  ];
  const anuncios = [
    anuncio(D(1), "ML", "MLB1", null), anuncio(D(1), "ML", "MLB2", "501"), anuncio(D(1), "ML", "MLB2", "502", { ativo: false }),
    anuncio(D(2), "ML", "MLB1", null, { created_at: "2026-06-26" }), anuncio(D(2), "ML", "MLB9", null),
    anuncio(D(3), "ML", "MLB7", null, { sku: "SKU-USER", custo_produto: 30 }),
    anuncio(D(1), "Shopee", "7001", null, { loja_id: L(2) }), anuncio(D(1), "Shopee", "7001", null, { loja_id: L(3) }),
    anuncio(D(5), "Shopee", "8001", "9", { loja_id: L(8) }),
  ];
  return { lojas, anuncios };
}
const lojaDe = (db: Banco, id: string) => db.anuncios.find((a) => a.id === id)!.loja_id;
const tenta = (fn: () => void) => { try { fn(); return null; } catch (e: any) { return String(e?.message ?? e); } };

function suite(sql: string, rotuloSecao = true) {
  if (rotuloSecao) imprimir("\n[1. estrutura]");

  t("S1. uma transação; precheck ANTES de qualquer escrita/DDL; rótulos A–G e V1–V7 com RAISE", () => {
    assert(/^\s*begin\s*;/im.test(sql) && /^\s*commit\s*;\s*$/im.test(sql), "sem begin/commit");
    const iPre = sql.search(/PRECHECK A/), iEsc = Math.min(...[/create\s+or\s+replace\s+function/i, /drop\s+trigger/i, /update\s+public\./i, /create\s+temp/i].map((r) => { const i = sql.search(r); return i < 0 ? Infinity : i; }));
    assert(iPre > 0 && iPre < iEsc, "precheck não vem antes da primeira escrita/DDL");
    const pre = blocoCom(sql, /PRECHECK A/) ?? "";
    for (const r of "ABCDEFG") assert(ativo(pre, `PRECHECK ${r}`), `PRECHECK ${r} ausente ou neutralizado`);
    const val = blocoCom(sql, /V1:/) ?? "";
    for (let i = 1; i <= 7; i++) assert(ativo(val, `V${i}:`), `V${i} ausente ou neutralizado`);
    assert(sql.search(/V1:/) > sql.search(/update\s+public\.anuncios/i), "validação antes do backfill");
  });

  t("S2. nada de escolha arbitrária: sem created_at / order by / limit / max / min / distinct on / array_agg no SQL executável", () => {
    for (const r of [/created_at/i, /order\s+by/i, /\blimit\b/i, /\bmax\s*\(/i, /\bmin\s*\(/i, /distinct\s+on/i, /array_agg/i, /\bfirst_value\b/i, /row_number/i])
      assert(!r.test(sql), `SQL executável usa ${r}`);
  });

  t("S3. sem UNIQUE ML, sem CHECK/ALTER, sem histórico de migrations, sem IF [NOT] EXISTS mascarando estado", () => {
    assert(!/create\s+unique\s+index/i.test(sql) && !/anuncios_ml_identidade_uq/i.test(sql), "UNIQUE ML criada");
    assert(!/alter\s+table/i.test(sql) && !/add\s+constraint/i.test(sql), "ALTER/CHECK nesta fase");
    assert(!/schema_migrations/i.test(sql), "toca o histórico de migrations");
    assert(!/\b(create|drop|alter)\b[^;]*?\bif\s+(not\s+)?exists/i.test(sql), "IF [NOT] EXISTS em DDL mascarando divergência");
    assert(!/anuncios_shopee_identidade_uq|anuncios_shopee_exige_loja/i.test(sql), "mexe nos contratos Shopee");
  });

  t("S4. UM único UPDATE (o backfill), só em anuncios, e o SET grava SÓ loja_id", () => {
    const ups = [...sql.matchAll(/\bupdate\s+public\.(\w+)/gi)].map((m) => m[1]);
    assert(ups.length === 1 && ups[0] === "anuncios", `UPDATEs: ${ups}`);
    assert(!/\b(insert\s+into|delete\s+from|truncate)\b/i.test(sql), "INSERT/DELETE/TRUNCATE em dado");
    const m = /update\s+public\.anuncios\s+\w+\s+set\s+([\s\S]*?)\s+where/i.exec(sql)!;
    assert(/^loja_id\s*=/.test(m[1].trim()) && !/,\s*\w+\s*=/.test(m[1].replace(/\([\s\S]*\)/g, "")), `SET: ${m[1]}`);
  });

  t("S5. marketplace real: 'ML'/'Shopee' nas duas tabelas = constante do runtime (MARKETPLACE_ML)", () => {
    const conexao = readFileSync(join(RAIZ, "lib/ml-conexao.ts"), "utf8");
    assert(/export const MARKETPLACE_ML = "ML";/.test(conexao), "MARKETPLACE_ML do runtime não é 'ML'");
    assert(!/MercadoLivre|mercado_livre/i.test(sql), "valor conceitual em vez do real");
    assert(/l\.marketplace\s*=\s*new\.marketplace/i.test(sql), "validação não compara lojas.marketplace com anuncios.marketplace");
  });

  t("S6. ponte marcada TRANSITIONAL_COMPATIBILITY_ONLY e removível pela 20261108; rollback documentado (não executável)", () => {
    // a definição executável (início de linha), não a cópia do rollback documentado em comentário
    const fn = /^create\s+or\s+replace\s+function[\s\S]*?\$\$\s*;/im.exec(BRUTO)?.[0] ?? "";
    assert(/TRANSITIONAL_COMPATIBILITY_ONLY/.test(fn) && /20261108/.test(fn), "função sem a marca transitória");
    assert(/ROLLBACK CONTROLADO/.test(BRUTO) && /before insert or update of loja_id, user_id on public\.anuncios/.test(BRUTO), "rollback sem a definição anterior");
    assert(!/^\s*(drop\s+function|update\s+public\.anuncios\s+set\s+loja_id\s*=\s*null)/im.test(SQL), "rollback executável no arquivo");
  });

  t("S7. limites LOCAIS logo após o begin e antes dos locks; lock modes exatos; validação explícita não exige ativo", () => {
    const iBegin = sql.search(/^\s*begin\s*;/im), iLock = sql.search(/lock\s+table/i);
    const iLt = sql.search(/set\s+local\s+lock_timeout\s*=\s*'5s'\s*;/i), iSt = sql.search(/set\s+local\s+statement_timeout\s*=\s*'60s'\s*;/i);
    assert(iLt > iBegin && iSt > iBegin && iLt < iLock && iSt < iLock, "lock_timeout/statement_timeout locais ausentes ou depois dos locks");
    assert(!/(^|;)\s*set\s+(session\s+)?(lock_timeout|statement_timeout)\b/im.test(sql) && !/alter\s+(system|database|role)/i.test(sql), "timeout global/de sessão");
    const locks = [...sql.matchAll(/lock\s+table\s+public\.(\w+)\s+in\s+([\w\s]+?)\s+mode\s*;/gi)].map((m) => `${m[1]}:${m[2].toLowerCase().replace(/\s+/g, " ")}`);
    assert(JSON.stringify(locks) === JSON.stringify(["anuncios:share row exclusive", "lojas:share"]), `locks: ${locks}`);
    const fn = /create\s+or\s+replace\s+function[\s\S]*?\$\$\s*;/i.exec(sql)![0];
    const permanente = /if\s+new\.loja_id\s+is\s+not\s+null\s+and\s+not\s+exists\s*\(([\s\S]*?)\)\s*then/i.exec(fn)?.[1] ?? "";
    assert(permanente && !/\bativo\b/i.test(permanente), `validação explícita depende de ativo: ${permanente}`);
  });

  if (rotuloSecao) imprimir("\n[2. backfill por cardinalidade]");

  t("B1. formato de produção: toda row ML recebe a loja ML ÚNICA do dono; contagem = esperada; só loja_id muda; Shopee intocada", () => {
    const db0 = bancoProducao();
    const r = aplicar(sql, db0);
    assert(r.ok, `abortou: ${(r as any).erro}`);
    const ml = r.db.anuncios.filter((a) => a.marketplace === "ML");
    assert(ml.length === 6 && ml.every((a) => a.loja_id === r.db.lojas.find((l) => l.user_id === a.user_id && l.marketplace === "ML")!.id), JSON.stringify(ml.map((a) => [a.id, a.loja_id])));
    for (const a0 of db0.anuncios) {
      const a = r.db.anuncios.find((x) => x.id === a0.id)!;
      assert(semLoja(a) === semLoja(a0), `campo além de loja_id mudou em ${a0.id}`);
      if (a0.marketplace === "Shopee") assert(a.loja_id === a0.loja_id, `Shopee ${a0.id} mudou de loja`);
    }
  });

  t("B2. loja ML criada DEPOIS dos anúncios e loja ML inativa: cardinalidade decide (created_at/ativo não entram)", () => {
    const r = aplicar(sql, bancoProducao());
    assert(r.ok, `abortou: ${(r as any).erro}`);
    assert(lojaDe(r.db, "an-0004") === L(4) && lojaDe(r.db, "an-0005") === L(4), "dono com loja posterior ficou sem loja");
    assert(lojaDe(r.db, "an-0006") === L(5), "loja ML única inativa não usada");
  });

  t("B3. dono com anúncio ML e 0 lojas ML → ABORTA (A) e nada muda", () => {
    const db0 = bancoProducao(); db0.anuncios.push(anuncio(D(5), "ML", "MLB50", null));
    const r = aplicar(sql, db0);
    assert(!r.ok && /PRECHECK A/.test(r.erro), `esperava PRECHECK A: ${JSON.stringify((r as any).erro)}`);
    assert(JSON.stringify(r.db) === JSON.stringify(db0), "estado mudou");
  });

  t("B4. dono com anúncio ML e 2 lojas ML → ABORTA (B); e o backfill sozinho nunca escolhe uma delas", () => {
    const db0 = bancoProducao(); db0.anuncios.push(anuncio(D(4), "ML", "MLB60", null));
    const r = aplicar(sql, db0);
    assert(!r.ok && /PRECHECK B/.test(r.erro), `esperava PRECHECK B: ${JSON.stringify((r as any).erro)}`);
    // defesa em profundidade: o bloco de backfill, executado SEM o precheck, não atribui loja ao dono ambíguo e aborta
    const db = JSON.parse(JSON.stringify(db0)) as Banco;
    const e: Exec = { db, vars: {}, gatilho: extrairGatilho(sql) };
    const erro = tenta(() => { for (const s of compilarCorpo(blocoCom(sql, /update\s+public\.anuncios/i)!)) s(e); });
    assert(db.anuncios.filter((a) => a.user_id === D(4)).every((a) => a.loja_id == null), "backfill escolheu loja para dono com 2 lojas ML");
    assert(erro !== null && /BACKFILL/.test(erro), `backfill não abortou: ${erro}`);
  });

  t("B5. prechecks C–G: duplicata ML, loja de outro dono, marketplace incompatível, Shopee sem loja, ML já com loja → ABORTA", () => {
    const casos: Array<[string, (db: Banco) => void]> = [
      ["PRECHECK C", (db) => db.anuncios.push(anuncio(D(1), "ML", "MLB1", null))],
      ["PRECHECK D", (db) => { db.anuncios.find((a) => a.id === "an-0009")!.loja_id = L(2); }],
      ["PRECHECK E", (db) => { db.anuncios.find((a) => a.id === "an-0007")!.loja_id = L(1); }],
      ["PRECHECK F", (db) => { db.anuncios.find((a) => a.id === "an-0009")!.loja_id = null; }],
      ["PRECHECK G", (db) => { db.anuncios.find((a) => a.id === "an-0001")!.loja_id = L(1); }],
    ];
    for (const [rotulo, mexer] of casos) {
      const db0 = bancoProducao(); mexer(db0);
      const r = aplicar(sql, db0);
      assert(!r.ok && r.erro.startsWith(rotulo), `${rotulo}: ${JSON.stringify((r as any).erro ?? "aplicou")}`);
    }
  });

  if (rotuloSecao) imprimir("\n[3. estado 3: trigger dono + marketplace + ponte transitória]");

  const estado3 = () => { const r = aplicar(sql, bancoProducao()); if (!r.ok) throw new Error(`migration abortou: ${r.erro}`); return r; };

  t("R1. runtime antigo insere ML SEM loja_id, dono com exatamente 1 loja ML → banco atribui a loja correta", () => {
    const { db, gatilho } = estado3();
    const novo = inserir(db, gatilho, anuncio(D(1), "ML", "MLB100", null));
    assert(novo.loja_id === L(1), `loja atribuída: ${novo.loja_id}`);
  });

  t("R2. ML sem loja_id, dono com 0 lojas ML → REJEITADO", () => {
    const { db, gatilho } = estado3(); const n = db.anuncios.length;
    assert(tenta(() => inserir(db, gatilho, anuncio(D(5), "ML", "MLB102", null))) !== null && db.anuncios.length === n, "aceitou");
  });

  t("R3. ML sem loja_id, dono com 2 lojas ML → REJEITADO (nenhuma escolhida)", () => {
    const { db, gatilho } = estado3(); const n = db.anuncios.length;
    assert(tenta(() => inserir(db, gatilho, anuncio(D(4), "ML", "MLB103", null))) !== null && db.anuncios.length === n, "aceitou");
  });

  t("R4. ML com loja_id explícito correto → aceito sem troca", () => {
    const { db, gatilho } = estado3();
    assert(inserir(db, gatilho, anuncio(D(1), "ML", "MLB104", null, { loja_id: L(1) })).loja_id === L(1), "trocou/rejeitou");
  });

  t("R5. ML apontando loja ML de OUTRO dono → REJEITADO", () => {
    const { db, gatilho } = estado3();
    assert(tenta(() => inserir(db, gatilho, anuncio(D(1), "ML", "MLB105", null, { loja_id: L(4) }))) !== null, "aceitou loja alheia");
  });

  t("R6. ML apontando loja SHOPEE do mesmo dono → REJEITADO", () => {
    const { db, gatilho } = estado3();
    assert(tenta(() => inserir(db, gatilho, anuncio(D(1), "ML", "MLB106", null, { loja_id: L(2) }))) !== null, "ML aceitou loja Shopee");
  });

  t("R7. Shopee válida (dono + loja Shopee) → comportamento preservado; Shopee de outro dono / sem loja → rejeitada", () => {
    const { db, gatilho } = estado3();
    assert(inserir(db, gatilho, anuncio(D(1), "Shopee", "7002", null, { loja_id: L(3) })).loja_id === L(3), "Shopee válida rejeitada");
    assert(tenta(() => inserir(db, gatilho, anuncio(D(1), "Shopee", "7003", null, { loja_id: L(8) }))) !== null, "Shopee de outro dono aceita");
    assert(tenta(() => inserir(db, gatilho, anuncio(D(1), "Shopee", "7004", null))) !== null, "Shopee sem loja aceita (ponte vazou para Shopee)");
    assert(tenta(() => inserir(db, gatilho, anuncio(D(1), "Shopee", "7001", null, { loja_id: L(2) }))) !== null, "UNIQUE Shopee deixou de valer");
  });

  t("R8. Shopee apontando loja ML do mesmo dono → REJEITADO", () => {
    const { db, gatilho } = estado3();
    assert(tenta(() => inserir(db, gatilho, anuncio(D(1), "Shopee", "7005", null, { loja_id: L(1) }))) !== null, "Shopee aceitou loja ML");
  });

  t("R9. UPDATE de marketplace dispara o trigger: row Shopee virando ML com loja Shopee → REJEITADO", () => {
    const { db, gatilho } = estado3();
    assert(gatilho.colunasUpdate !== null && ["loja_id", "user_id", "marketplace"].every((c) => gatilho.colunasUpdate!.includes(c)), `colunas: ${gatilho.colunasUpdate}`);
    assert(tenta(() => atualizar(db, gatilho, "an-0007", { marketplace: "ML" })) !== null, "virou ML com loja Shopee");
  });

  t("R10. UPDATE ML zerando loja_id → ponte reatribui a única; dono com 2 lojas → rejeitado; ML sem dono → rejeitado", () => {
    const { db, gatilho } = estado3();
    assert(atualizar(db, gatilho, "an-0001", { loja_id: null }).loja_id === L(1), "não reatribuiu");
    db.lojas.push(loja(9, D(1), "ML"));
    assert(tenta(() => atualizar(db, gatilho, "an-0002", { loja_id: null })) !== null, "escolheu entre 2 lojas ML");
    assert(tenta(() => inserir(db, gatilho, anuncio(null as any, "ML", "MLB107", null))) !== null, "ML sem dono aceito");
  });

  t("R11. update que não toca loja/dono/marketplace (ex.: SKU) não passa pelo trigger e não muda loja", () => {
    const { db, gatilho } = estado3();
    const a = atualizar(db, gatilho, "an-0002", { sku: "X" });
    assert(a.loja_id === L(1) && a.sku === "X", JSON.stringify(a));
  });

  if (rotuloSecao) imprimir("\n[4. ponte por lojas ML ATIVAS; loja explícita não depende de ativo]");

  /** Estado 3 + um dono D(7) só com as lojas ML pedidas (sem anúncios: não afeta o backfill). */
  const comLojas = (...ativos: boolean[]) => {
    const r = estado3();
    ativos.forEach((a, i) => r.db.lojas.push(loja(70 + i, D(7), "ML", { id: `70000000-0000-4000-8000-00000000000${i}`, ativo: a })));
    return r;
  };
  const L7 = (i: number) => `70000000-0000-4000-8000-00000000000${i}`;

  t("T1. 1 loja ML ATIVA → NULL recebe essa loja", () => {
    const { db, gatilho } = comLojas(true);
    assert(inserir(db, gatilho, anuncio(D(7), "ML", "MLB300", null)).loja_id === L7(0), "não atribuiu a ativa");
  });

  t("T2. 0 lojas ML ativas (nenhuma loja) → rejeita", () => {
    const { db, gatilho } = comLojas();
    assert(tenta(() => inserir(db, gatilho, anuncio(D(7), "ML", "MLB301", null))) !== null, "aceitou sem loja ativa");
  });

  t("T3. 2 lojas ML ATIVAS → rejeita (nenhuma escolhida)", () => {
    const { db, gatilho } = comLojas(true, true); const n = db.anuncios.length;
    assert(tenta(() => inserir(db, gatilho, anuncio(D(7), "ML", "MLB302", null))) !== null && db.anuncios.length === n, "escolheu entre 2 ativas");
  });

  t("T4. 1 ativa + 1 inativa → escolhe EXATAMENTE a ativa (em qualquer ordem)", () => {
    for (const ordem of [[true, false], [false, true]]) {
      const { db, gatilho } = comLojas(...ordem);
      const esperada = L7(ordem.indexOf(true));
      assert(inserir(db, gatilho, anuncio(D(7), "ML", "MLB303", null)).loja_id === esperada, `ordem ${ordem}: não escolheu a ativa`);
    }
  });

  t("T5. 0 ativas + 2 inativas (reconexão pendente) → rejeita; e dono com 1 só inativa → rejeita", () => {
    const a = comLojas(false, false);
    assert(tenta(() => inserir(a.db, a.gatilho, anuncio(D(7), "ML", "MLB304", null))) !== null, "aceitou com 2 inativas");
    const b = comLojas(false);
    assert(tenta(() => inserir(b.db, b.gatilho, anuncio(D(7), "ML", "MLB305", null))) !== null, "ponte aceitou loja inativa sem ativa");
  });

  t("T6. loja_id EXPLÍCITA de loja ML INATIVA do mesmo dono → aceita, e o trigger não troca pela ativa", () => {
    const { db, gatilho } = comLojas(false, true);
    const a = inserir(db, gatilho, anuncio(D(7), "ML", "MLB306", null, { loja_id: L7(0) }));
    assert(a.loja_id === L7(0), `trocou a loja explícita: ${a.loja_id}`);
    const upd = atualizar(db, gatilho, a.id, { loja_id: L7(0), user_id: D(7) });
    assert(upd.loja_id === L7(0), "UPDATE explícito trocou a loja");
  });

  t("B6. backfill continua por TODAS as lojas ML: dono com 1 única loja ML total, INATIVA, é backfillado; a ponte não muda isso", () => {
    const r = aplicar(sql, bancoProducao());
    assert(r.ok, `abortou: ${(r as any).erro}`);
    assert(lojaDe(r.db, "an-0006") === L(5) && r.db.lojas.find((l) => l.id === L(5))!.ativo === false, "backfill deixou de usar a loja inativa única");
    const bloco = blocoCom(sql, /update\s+public\.anuncios/i)!;
    assert(!/\bativo\b/i.test(bloco), "backfill passou a filtrar ativo");
    // depois do backfill, um NOVO anúncio desse dono (0 ativas) é recusado pela ponte
    assert(tenta(() => inserir(r.db, r.gatilho, anuncio(D(3), "ML", "MLB307", null))) !== null, "ponte aceitou dono sem loja ativa");
  });

  t("N1. estado 3 não tem UNIQUE ML: a migration não impõe identidade ML (fica para a 20261108)", () => {
    const { db, gatilho } = estado3();
    assert(tenta(() => inserir(db, gatilho, anuncio(D(1), "ML", "MLB1", null, { loja_id: L(1) }))) === null, "estado 3 já rejeita duplicata ML (UNIQUE antecipada)");
  });

  t("N2. antes da migration (estado 2), o mesmo runtime grava ML sem loja — é o buraco que a ponte fecha", () => {
    const db = bancoProducao();
    const a = inserir(db, GATILHO_ANTERIOR, anuncio(D(1), "ML", "MLB200", null));
    assert(a.loja_id === null, "controle: estado 2 já atribuía loja");
    assert(tenta(() => inserir(db, GATILHO_ANTERIOR, anuncio(D(1), "ML", "MLB201", null, { loja_id: L(2) }))) === null, "controle: estado 2 já validava marketplace");
  });
}

imprimir(`\n[ANUNCIOS ML LOJA fase 1 — ${MIGRACAO}]`);
suite(SQL);
imprimir(`\n${falhou === 0 ? "✓" : "✗"} ANUNCIOS-ML-LOJA-FASE1 — ${ok} passaram, ${falhou} falharam`);
process.exit(falhou === 0 ? 0 : 1);
