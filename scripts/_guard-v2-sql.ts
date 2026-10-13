/**
 * Guard V2 — interpretador OFFLINE do subconjunto SQL/plpgsql usado pelas migrations de catálogo
 * (CDS V2 Fase 2C.1). Executa o SCRIPT INTEIRO da migration, comando a comando, sobre um banco em
 * memória: begin/commit, SET LOCAL, LOCK TABLE, DO $$...$$, CREATE TEMP TABLE ... AS SELECT,
 * CREATE OR REPLACE FUNCTION (trigger plpgsql), DROP/CREATE TRIGGER. Prechecks e validações são
 * EXECUTADOS a partir do SQL (nenhuma condição é reimplementada aqui): inverter/remover uma condição
 * no arquivo muda o resultado.
 *
 * Subconjunto: SELECT [DISTINCT] itens [INTO [STRICT] v] FROM fonte [JOIN fonte ON e]* [WHERE e]
 * [GROUP BY e,..] [HAVING e] [ORDER BY col] [LIMIT n]; fonte = tabela [alias] | (SELECT ...) alias;
 * expressões: AND/OR/NOT, = <> < > <= >=, IS [NOT] NULL, IS [NOT] DISTINCT FROM, EXISTS(...),
 * subconsulta escalar, count(*), coalesce, md5, to_jsonb, jsonb - 'k', ::tipo; plpgsql: IF/THEN/
 * END IF, SELECT INTO, UPDATE ... SET ... WHERE, GET DIAGNOSTICS, RAISE, NEW.col :=, RETURN NEW.
 * Qualquer coisa fora disso → ErroSQL (fail-closed: o teste falha, não "passa por não entender").
 *
 * LIMITE: NÃO substitui o PostgreSQL. Não prova parser real, locks/timeouts reais, comportamento
 * transacional do SQL Editor, planner, nem temp table numa sessão real.
 */
import { createHash } from "node:crypto";

export type Linha = Record<string, any>;
export class ErroSQL extends Error {}

/** Trigger instalado: função compilada + eventos. */
export type Gatilho = { nome: string; tabela: string; funcao: string; colunasUpdate: string[] | null; insert: boolean };
/** Índice UNIQUE (parcial) emulado: colunas/predicado executados do SQL; `def` = pg_indexes.indexdef. */
export type IndiceUnico = { nome: string; tabela: string; colunas: Expr[]; onde: Expr | null; def: string; valido: boolean; pronto: boolean };
/** CHECK emulado: expressão executada do SQL (NOT VALID também vale para escritas novas); `def` = pg_get_constraintdef. */
export type CheckRestricao = { nome: string; tabela: string; expr: Expr; def: string; validado: boolean };
/** Coluna declarada (information_schema.columns): tipo no nome do PostgreSQL, nulabilidade e default (texto). */
export type Coluna = { nome: string; tipo: string; nula: boolean; padrao: string | null; padraoExpr?: Expr | null };
export type Banco = {
  tabelas: Record<string, Linha[]>;
  temp: Record<string, Linha[]>;
  funcoes: Record<string, Stmt[]>;
  gatilhos: Gatilho[];
  config: Record<string, string>;
  locks: Array<{ tabela: string; modo: string }>;
  /** Fonte (prosrc) de cada função instalada. */
  fontes?: Record<string, string>;
  indices?: IndiceUnico[];
  checks?: CheckRestricao[];
  /** Colunas por tabela (só tabelas declaradas; ADD COLUMN exige a tabela declarada). */
  colunas?: Record<string, Coluna[]>;
};
/** Restrições do banco que a migration NÃO cria (CHECK/FK/UNIQUE já existentes) — emuladas pelo chamador. */
export type Restricoes = (db: Banco, tabela: string, linha: Linha) => void;
export type Traco = Array<{ rotulo: string; vars: Record<string, any> }>;

// ── Tokens ───────────────────────────────────────────────────────────
type Tok = { t: "id" | "str" | "num" | "op"; v: string };
export function tokenizar(s: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "'") { let j = i + 1, v = ""; while (j < s.length) { if (s[j] === "'" && s[j + 1] === "'") { v += "'"; j += 2; continue; } if (s[j] === "'") break; v += s[j++]; } out.push({ t: "str", v }); i = j + 1; continue; }
    if (/\d/.test(c)) { let j = i; while (j < s.length && /\d/.test(s[j])) j++; out.push({ t: "num", v: s.slice(i, j) }); i = j; continue; }
    if (/[A-Za-z_]/.test(c)) { let j = i; while (j < s.length && /\w/.test(s[j])) j++; out.push({ t: "id", v: s.slice(i, j).toLowerCase() }); i = j; continue; }
    const dois = s.slice(i, i + 2);
    if (["<>", ":=", ">=", "<=", "!=", "::"].includes(dois)) { out.push({ t: "op", v: dois === "!=" ? "<>" : dois }); i += 2; continue; }
    if ("=<>(),.*;%-".includes(c)) { out.push({ t: "op", v: c }); i++; continue; }
    throw new ErroSQL(`token não suportado: ${s.slice(i, i + 20)}`);
  }
  return out;
}
class Leitor {
  p = 0;
  constructor(public k: Tok[]) {}
  ver(o = 0) { return this.k[this.p + o]; }
  eh(v: string, o = 0) { const x = this.ver(o); return !!x && (x.t === "id" || x.t === "op") && x.v === v; }
  tomar(v?: string) { const x = this.k[this.p]; if (!x) throw new ErroSQL(`fim inesperado (esperava ${v ?? "token"})`); if (v !== undefined && x.v !== v) throw new ErroSQL(`esperava "${v}", veio "${x.v}"`); this.p++; return x; }
  opc(v: string) { if (this.eh(v)) { this.p++; return true; } return false; }
  fim() { return this.p >= this.k.length; }
}

// ── Valores ──────────────────────────────────────────────────────────
type Jsonb = { __jsonb: Linha };
const ehJsonb = (v: any): v is Jsonb => !!v && typeof v === "object" && "__jsonb" in v;
function textoCanonico(v: any): string {
  if (ehJsonb(v)) return JSON.stringify(Object.keys(v.__jsonb).sort().map((k) => [k, v.__jsonb[k] ?? null]));
  return v === null || v === undefined ? "" : String(v);
}

// ── Expressões ───────────────────────────────────────────────────────
export type Ctx = { db: Banco; alias: Record<string, Linha>; vars: Record<string, any>; linha?: Linha; grupo?: Ctx[] };
type Expr = (c: Ctx) => any;

const tri = (x: any) => (x === null || x === undefined ? null : !!x);
function lerExpr(L: Leitor): Expr {
  let e = lerE(L);
  while (L.opc("or")) { const a = e, b = lerE(L); e = (c) => { const x = tri(a(c)), y = tri(b(c)); return x === true || y === true ? true : x === null || y === null ? null : false; }; }
  return e;
}
function lerE(L: Leitor): Expr {
  let e = lerNao(L);
  while (L.opc("and")) { const a = e, b = lerNao(L); e = (c) => { const x = tri(a(c)), y = tri(b(c)); return x === false || y === false ? false : x === null || y === null ? null : true; }; }
  return e;
}
function lerNao(L: Leitor): Expr {
  if (L.opc("not")) { const a = lerNao(L); return (c) => { const x = tri(a(c)); return x === null ? null : !x; }; }
  return lerCmp(L);
}
function lerCmp(L: Leitor): Expr {
  const a = lerSoma(L);
  const op = L.ver();
  if (op && op.t === "op" && ["=", "<>", ">", "<", ">=", "<="].includes(op.v)) {
    L.tomar(); const b = lerSoma(L);
    return (c) => {
      let x = a(c), y = b(c);
      if (x === null || x === undefined || y === null || y === undefined) return null;
      if (ehJsonb(x) || ehJsonb(y)) { x = textoCanonico(x); y = textoCanonico(y); }
      switch (op.v) { case "=": return x === y; case "<>": return x !== y; case ">": return x > y; case "<": return x < y; case ">=": return x >= y; default: return x <= y; }
    };
  }
  if (L.eh("like") || (L.eh("not") && L.eh("like", 1))) {
    const neg = L.opc("not"); L.tomar("like"); const b = lerSoma(L);
    return (c) => {
      const x = a(c), p = b(c);
      if (x === null || x === undefined || p === null || p === undefined) return null;
      const re = new RegExp("^" + String(p).split("%").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/_/g, ".")).join("[\\s\\S]*") + "$");
      const m = re.test(String(x)); return neg ? !m : m;
    };
  }
  if (L.opc("is")) {
    const neg = L.opc("not");
    if (L.opc("null")) return (c) => { const v = a(c); const n = v === null || v === undefined; return neg ? !n : n; };
    L.tomar("distinct"); L.tomar("from"); const b = lerSoma(L);
    return (c) => { const x = a(c) ?? null, y = b(c) ?? null; const d = textoCanonico(x) !== textoCanonico(y) || (x === null) !== (y === null); return neg ? !d : d; };
  }
  return a;
}
function lerSoma(L: Leitor): Expr {
  let e = lerCast(L);
  while (L.eh("-")) {
    L.tomar("-"); const a = e, b = lerCast(L);
    e = (c) => { const x = a(c), y = b(c);
      if (ehJsonb(x)) { const { [String(y)]: _, ...resto } = x.__jsonb; return { __jsonb: resto }; }
      if (x === null || y === null) return null; return Number(x) - Number(y); };
  }
  return e;
}
function lerCast(L: Leitor): Expr {
  let e = lerPrim(L);
  while (L.opc("::")) {
    const tipo = L.tomar().v; const a = e;
    if (tipo === "text") e = (c) => { const v = a(c); return v === null || v === undefined ? null : textoCanonico(v); };
    else if (tipo === "regclass" || tipo === "regprocedure") e = (c) => a(c);
    else throw new ErroSQL(`cast não suportado: ${tipo}`);
  }
  return e;
}
function lerPrim(L: Leitor): Expr {
  const x = L.ver();
  if (!x) throw new ErroSQL("expressão incompleta");
  if (L.eh("exists")) { L.tomar(); L.tomar("("); const q = lerSelect(L); L.tomar(")"); return (c) => rodarSelect(q, c).length > 0; }
  if (L.eh("(")) {
    L.tomar("(");
    if (L.eh("select")) { const q = lerSelect(L); L.tomar(")"); return (c) => escalar(q, c); }
    const e = lerExpr(L); L.tomar(")"); return e;
  }
  if (x.t === "str") { L.tomar(); return () => x.v; }
  if (x.t === "num") { L.tomar(); return () => Number(x.v); }
  if (L.eh("null")) { L.tomar(); return () => null; }
  if (L.eh("true")) { L.tomar(); return () => true; }
  if (L.eh("false")) { L.tomar(); return () => false; }
  if (x.t === "id" && L.eh("(", 1)) {
    const f = L.tomar().v; L.tomar("(");
    if (f === "count") { L.tomar("*"); L.tomar(")"); return (c) => { if (!c.grupo) throw new ErroSQL("count(*) fora de agregação"); return c.grupo.length; }; }
    const args: Expr[] = [];
    if (!L.eh(")")) do args.push(lerExpr(L)); while (L.opc(","));
    L.tomar(")");
    if (f === "coalesce") return (c) => { for (const a of args) { const v = a(c); if (v !== null && v !== undefined) return v; } return null; };
    if (f === "md5") return (c) => { const v = args[0](c); return v === null ? null : createHash("md5").update(textoCanonico(v)).digest("hex"); };
    if (f === "to_jsonb") return (c) => { const v = args[0](c); if (!v || typeof v !== "object") throw new ErroSQL("to_jsonb de não-linha"); return { __jsonb: { ...v } }; };
    if (f === "pg_get_triggerdef") return (c) => { const g = c.db.gatilhos.find((x) => `trg:${x.nome}` === args[0](c)); return g ? definicaoGatilho(g) : null; };
    if (f === "pg_get_constraintdef") return (c) => (c.db.checks ?? []).find((x) => `con:${x.nome}` === args[0](c))?.def ?? null;
    throw new ErroSQL(`função não suportada: ${f}`);
  }
  if (x.t === "id") {
    const a = L.tomar().v;
    if (L.opc(".")) { const col = L.tomar().v; return (c) => { const r = c.alias[a]; if (!r) throw new ErroSQL(`alias desconhecido: ${a}`); return r[col] ?? null; }; }
    // nome solto: variável plpgsql, linha inteira (to_jsonb(a)), senão coluna da fonte em escopo
    return (c) => {
      if (a in c.vars) return c.vars[a];
      if (a in c.alias) return c.alias[a];
      if (c.linha && a in c.linha) return c.linha[a] ?? null;
      throw new ErroSQL(`nome desconhecido: ${a}`);
    };
  }
  throw new ErroSQL(`expressão não suportada: ${x.v}`);
}

// ── SELECT ───────────────────────────────────────────────────────────
type Fonte = { tabela?: string; sub?: Select; alias: string };
type Item = { tipo: "count" } | { tipo: "expr"; e: Expr; nome: string };
export type Select = {
  distinct: boolean; itens: Item[]; into: { vars: string[]; estrito: boolean } | null;
  fontes: Array<{ fonte: Fonte; on: Expr | null }>; onde: Expr | null; grupo: Expr[] | null; having: Expr | null;
  ordem: { e: Expr; desc: boolean } | null; limite: number | null;
};
function lerNomeTabela(L: Leitor): string {
  const a = L.tomar().v;
  if (L.opc(".")) return `${a}.${L.tomar().v}`;
  return a;
}
const RESERVADAS = new Set(["where", "join", "on", "group", "having", "order", "limit", "into", "inner", "set"]);
function lerFonte(L: Leitor): Fonte {
  if (L.opc("(")) { const sub = lerSelect(L); L.tomar(")"); L.opc("as"); return { sub, alias: L.tomar().v }; }
  const tabela = lerNomeTabela(L);
  let alias = tabela.split(".").pop()!;
  if (L.ver()?.t === "id" && !RESERVADAS.has(L.ver().v)) alias = L.tomar().v;
  return { tabela, alias };
}
export function lerSelect(L: Leitor): Select {
  L.tomar("select");
  const distinct = L.opc("distinct");
  const itens: Item[] = [];
  do {
    if (L.eh("count") && L.eh("(", 1) && L.eh("*", 2)) { L.tomar(); L.tomar("("); L.tomar("*"); L.tomar(")"); itens.push({ tipo: "count" }); continue; }
    const ini = L.p; const e = lerExpr(L);
    let nome = L.k[L.p - 1]?.v ?? "?column?";
    if (L.opc("as")) nome = L.tomar().v;
    else if (L.k[ini].t === "num") nome = "?column?";
    itens.push({ tipo: "expr", e, nome });
  } while (L.opc(","));
  let into: Select["into"] = null;
  if (L.opc("into")) { const estrito = L.opc("strict"); const vars = [L.tomar().v]; while (L.opc(",")) vars.push(L.tomar().v); into = { vars, estrito }; }
  L.tomar("from");
  const fontes: Select["fontes"] = [{ fonte: lerFonte(L), on: null }];
  while (L.eh("join") || L.eh("inner")) { L.opc("inner"); L.tomar("join"); const f = lerFonte(L); L.tomar("on"); fontes.push({ fonte: f, on: lerExpr(L) }); }
  let onde: Expr | null = null, grupo: Expr[] | null = null, having: Expr | null = null, ordem: Select["ordem"] = null, limite: number | null = null;
  if (L.opc("where")) onde = lerExpr(L);
  if (L.opc("group")) { L.tomar("by"); grupo = []; do grupo.push(lerExpr(L)); while (L.opc(",")); }
  if (L.opc("having")) having = lerExpr(L);
  if (L.opc("order")) { L.tomar("by"); const e = lerExpr(L); const desc = L.opc("desc"); if (!desc) L.opc("asc"); ordem = { e, desc }; }
  if (L.opc("limit")) limite = Number(L.tomar().v);
  return { distinct, itens, into, fontes, onde, grupo, having, ordem, limite };
}
function linhasDaFonte(f: Fonte, c: Ctx): Linha[] {
  if (f.sub) return rodarSelect(f.sub, c);
  const t = f.tabela!;
  // catálogo virtual (o suficiente para prechecks/validações de migration)
  if (t === "pg_trigger") return c.db.gatilhos.map((g) => ({ oid: `trg:${g.nome}`, tgrelid: g.tabela, tgname: g.nome, tgisinternal: false }));
  if (t === "pg_indexes") return (c.db.indices ?? []).map((i) => ({ schemaname: i.tabela.split(".")[0], tablename: i.tabela.split(".")[1], indexname: i.nome, indexdef: i.def }));
  if (t === "pg_class") return (c.db.indices ?? []).map((i) => ({ oid: `idx:${i.nome}`, relname: i.nome }));
  if (t === "pg_index") return (c.db.indices ?? []).map((i) => ({ indexrelid: `idx:${i.nome}`, indrelid: i.tabela, indisunique: true, indisvalid: i.valido, indisready: i.pronto }));
  if (t === "pg_constraint") return (c.db.checks ?? []).map((k) => ({ oid: `con:${k.nome}`, conname: k.nome, conrelid: k.tabela, contype: "c", convalidated: k.validado }));
  if (t === "pg_proc") return Object.keys(c.db.funcoes).map((n) => ({ oid: `${n}()`, proname: n.split(".").pop(), prosrc: c.db.fontes?.[n] ?? "" }));
  if (t === "information_schema.columns") return Object.entries(c.db.colunas ?? {}).flatMap(([tab, cols]) => cols.map((col) => ({
    table_schema: tab.split(".")[0], table_name: tab.split(".")[1], column_name: col.nome, data_type: col.tipo,
    is_nullable: col.nula ? "YES" : "NO", column_default: col.padrao })));
  if (t in c.db.temp) return c.db.temp[t];
  if (t in c.db.tabelas) return c.db.tabelas[t];
  throw new ErroSQL(`relation "${t}" does not exist`);
}
/** Linhas projetadas (objetos nome→valor). */
export function rodarSelect(q: Select, c: Ctx): Linha[] {
  // produto das fontes com JOIN ... ON
  let ctxs: Ctx[] = linhasDaFonte(q.fontes[0].fonte, c).map((r) => ({ ...c, alias: { ...c.alias, [q.fontes[0].fonte.alias]: r }, linha: r, grupo: undefined }));
  for (const { fonte, on } of q.fontes.slice(1)) {
    const novos: Ctx[] = [];
    for (const x of ctxs) for (const r of linhasDaFonte(fonte, x)) {
      const y: Ctx = { ...x, alias: { ...x.alias, [fonte.alias]: r }, linha: undefined };
      if (!on || tri(on(y)) === true) novos.push(y);
    }
    ctxs = novos;
  }
  if (q.onde) ctxs = ctxs.filter((x) => tri(q.onde!(x)) === true);
  const agregado = q.grupo !== null || q.itens.some((i) => i.tipo === "count");
  let saida: Linha[];
  const projetar = (x: Ctx) => { const o: Linha = {}; for (const i of q.itens) o[i.tipo === "count" ? "count" : i.nome] = i.tipo === "count" ? x.grupo!.length : i.e(x); return o; };
  if (agregado) {
    const grupos = new Map<string, Ctx[]>();
    if (q.grupo) for (const x of ctxs) { const k = JSON.stringify(q.grupo.map((g) => textoCanonico(g(x)) + (g(x) === null ? "\u0000" : ""))); (grupos.get(k) ?? grupos.set(k, []).get(k)!).push(x); }
    else grupos.set("", ctxs);
    saida = [];
    for (const membros of grupos.values()) {
      const g: Ctx = { ...(membros[0] ?? c), grupo: membros };
      if (q.having && tri(q.having(g)) !== true) continue;
      saida.push(projetar(g));
    }
  } else {
    if (q.ordem) { const o = q.ordem; ctxs = [...ctxs].sort((x, y) => { const a = String(o.e(x)), b = String(o.e(y)); return (a < b ? -1 : a > b ? 1 : 0) * (o.desc ? -1 : 1); }); }
    saida = ctxs.map(projetar);
  }
  if (q.distinct) { const vistos = new Set<string>(); saida = saida.filter((r) => { const k = JSON.stringify(r); if (vistos.has(k)) return false; vistos.add(k); return true; }); }
  if (q.limite !== null) saida = saida.slice(0, q.limite);
  return saida;
}
function escalar(q: Select, c: Ctx) {
  const linhas = rodarSelect(q, c);
  if (linhas.length > 1) throw new ErroSQL("more than one row returned by a subquery used as an expression");
  if (!linhas.length) return null;
  return Object.values(linhas[0])[0] ?? null;
}

// ── plpgsql ──────────────────────────────────────────────────────────
type Exec = { db: Banco; novo?: Linha; vars: Record<string, any>; restricoes: Restricoes; traco: Traco; notices: string[] };
export type Stmt = ((e: Exec) => "return" | void) & { rotulo?: string };
const ctxDe = (e: Exec, extra: Record<string, Linha> = {}): Ctx => ({ db: e.db, alias: { ...(e.novo ? { new: e.novo } : {}), ...extra }, vars: e.vars });
function lerBloco(L: Leitor, fim: (L: Leitor) => boolean): Stmt[] {
  const out: Stmt[] = [];
  while (!fim(L)) out.push(lerStmt(L));
  return out;
}
function lerStmt(L: Leitor): Stmt {
  if (L.opc("if")) {
    const cond = lerExpr(L); L.tomar("then");
    const corpo = lerBloco(L, (l) => l.eh("end") && l.eh("if", 1));
    L.tomar("end"); L.tomar("if"); L.tomar(";");
    const rotulo = corpo[0]?.rotulo;
    const s: Stmt = (e) => {
      if (rotulo) e.traco.push({ rotulo, vars: { ...e.vars } });
      if (tri(cond(ctxDe(e))) === true) for (const x of corpo) if (x(e) === "return") return "return";
    };
    s.rotulo = rotulo;
    return s;
  }
  if (L.eh("select")) {
    const q = lerSelect(L); L.tomar(";");
    if (!q.into) throw new ErroSQL("SELECT sem INTO em plpgsql");
    return (e) => {
      const linhas = rodarSelect(q, ctxDe(e));
      if (q.into!.estrito && linhas.length !== 1) throw new ErroSQL(linhas.length ? "query returned more than one row" : "query returned no rows");
      const vals = linhas.length ? Object.values(linhas[0]) : [];
      q.into!.vars.forEach((v, i) => { e.vars[v] = vals[i] ?? null; });
    };
  }
  if (L.opc("update")) {
    const tabela = lerNomeTabela(L);
    let alias = tabela.split(".").pop()!; if (!L.eh("set")) alias = L.tomar().v;
    L.tomar("set");
    const sets: Array<[string, Expr]> = [];
    do { const col = L.tomar().v; L.tomar("="); sets.push([col, lerExpr(L)]); } while (L.opc(","));
    let onde: Expr | null = null; if (L.opc("where")) onde = lerExpr(L); L.tomar(";");
    return (e) => {
      let n = 0;
      const tab = e.db.tabelas[tabela]; if (!tab) throw new ErroSQL(`relation "${tabela}" does not exist`);
      for (const r of [...tab]) {
        const c: Ctx = { ...ctxDe(e, { [alias]: r }), linha: r };
        if (onde && tri(onde(c)) !== true) continue;
        const patch: Linha = {}; for (const [col, ex] of sets) patch[col] = ex(c);
        atualizarLinha(e.db, tabela, r.id, patch, e.restricoes); n++;
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
    const s: Stmt = (e) => {
      let i = 0; const texto = msg.v.replace(/%/g, () => textoCanonico(args[i++]?.(ctxDe(e))));
      if (nivel === "exception") throw new ErroSQL(texto);
      e.notices.push(texto);
    };
    if (nivel === "exception") s.rotulo = msg.v.split(":")[0].trim();
    return s;
  }
  if (L.eh("new") && L.eh(".", 1)) {
    L.tomar("new"); L.tomar("."); const col = L.tomar().v; L.tomar(":="); const ex = lerExpr(L); L.tomar(";");
    return (e) => { e.novo![col] = ex(ctxDe(e)); };
  }
  if (L.opc("return")) { L.tomar("new"); L.tomar(";"); return () => "return"; }
  throw new ErroSQL(`comando plpgsql não suportado: ${L.ver()?.v} ${L.ver(1)?.v ?? ""}`);
}
/** Corpo "declare ... begin <comandos> end" → comandos. */
export function compilarCorpo(corpo: string): Stmt[] {
  const L = new Leitor(tokenizar(corpo));
  if (L.opc("declare")) while (!L.eh("begin")) L.tomar();
  L.tomar("begin");
  const stmts = lerBloco(L, (l) => l.eh("end") && !l.eh("if", 1));
  L.tomar("end"); L.opc(";");
  if (!L.fim()) throw new ErroSQL(`sobra após o corpo: ${L.ver().v}`);
  return stmts;
}

// ── Escrita com triggers ─────────────────────────────────────────────
function dispararGatilhos(db: Banco, tabela: string, novo: Linha, evento: "insert" | string[], restricoes: Restricoes) {
  for (const g of db.gatilhos.filter((x) => x.tabela === tabela)) {
    const dispara = evento === "insert" ? g.insert : g.colunasUpdate !== null && evento.some((c) => g.colunasUpdate!.includes(c));
    if (!dispara) continue;
    const corpo = db.funcoes[g.funcao]; if (!corpo) throw new ErroSQL(`function ${g.funcao}() does not exist`);
    const e: Exec = { db, novo, vars: {}, restricoes, traco: [], notices: [] };
    for (const s of corpo) if (s(e) === "return") break;
  }
}
/** pg_get_triggerdef no formato do PostgreSQL. */
export function definicaoGatilho(g: Gatilho): string {
  const upd = g.colunasUpdate === null ? "" : `UPDATE${g.colunasUpdate[0] === "*" ? "" : ` OF ${g.colunasUpdate.join(", ")}`}`;
  const eventos = [g.insert ? "INSERT" : "", upd].filter(Boolean).join(" OR ");
  return `CREATE TRIGGER ${g.nome} BEFORE ${eventos} ON ${g.tabela} FOR EACH ROW EXECUTE FUNCTION ${g.funcao.split(".").pop()}()`;
}
const ctxLinha = (db: Banco, r: Linha): Ctx => ({ db, alias: {}, vars: {}, linha: r });
/** Chave de um índice UNIQUE para a linha; null = fora do índice (predicado falso ou algum componente NULL). */
function chaveIndice(db: Banco, i: IndiceUnico, r: Linha): string | null {
  if (i.onde && tri(i.onde(ctxLinha(db, r))) !== true) return null;
  const vals = i.colunas.map((e) => e(ctxLinha(db, r)));
  if (vals.some((v) => v === null || v === undefined)) return null;       // NULL é distinto de NULL no UNIQUE
  return JSON.stringify(vals.map(textoCanonico));
}
/** CHECKs (também NOT VALID: valem para escrita nova) e UNIQUEs declarados pelo SQL. */
function aplicarRestricoesDeclaradas(db: Banco, tabela: string, novo: Linha) {
  for (const c of db.colunas?.[tabela] ?? []) {
    if (!c.nula && (novo[c.nome] === null || novo[c.nome] === undefined)) throw new ErroSQL(`null value in column "${c.nome}" violates not-null constraint`);
  }
  for (const k of (db.checks ?? []).filter((x) => x.tabela === tabela)) {
    if (tri(k.expr(ctxLinha(db, novo))) === false) throw new ErroSQL(`new row violates check constraint "${k.nome}"`);
  }
  for (const i of (db.indices ?? []).filter((x) => x.tabela === tabela)) {
    const k = chaveIndice(db, i, novo); if (k === null) continue;
    if (db.tabelas[tabela].some((r) => r.id !== novo.id && chaveIndice(db, i, r) === k)) throw new ErroSQL(`duplicate key value violates unique constraint "${i.nome}"`);
  }
}
export function inserirLinha(db: Banco, tabela: string, linha: Linha, restricoes: Restricoes): Linha {
  const novo = { ...linha };
  for (const c of db.colunas?.[tabela] ?? []) if (!(c.nome in novo)) novo[c.nome] = c.padraoExpr ? c.padraoExpr(ctxLinha(db, novo)) : null;
  dispararGatilhos(db, tabela, novo, "insert", restricoes); restricoes(db, tabela, novo); aplicarRestricoesDeclaradas(db, tabela, novo);
  db.tabelas[tabela].push(novo); return novo;
}
export function atualizarLinha(db: Banco, tabela: string, id: string, patch: Linha, restricoes: Restricoes): Linha {
  const tab = db.tabelas[tabela]; const i = tab.findIndex((r) => r.id === id);
  const novo = { ...tab[i], ...patch };
  dispararGatilhos(db, tabela, novo, Object.keys(patch), restricoes);
  restricoes(db, tabela, novo); aplicarRestricoesDeclaradas(db, tabela, novo); tab[i] = novo; return novo;
}

// ── Script ───────────────────────────────────────────────────────────
/** Remove comentários "--" (fora de string) e separa em comandos de topo respeitando $$...$$. */
export function comandosDoScript(sql: string): string[] {
  const semComentario = sql.replace(/\r\n/g, "\n").split("\n").map((l) => {
    let emStr = false;
    for (let i = 0; i < l.length; i++) { if (l[i] === "'") emStr = !emStr; else if (!emStr && l[i] === "-" && l[i + 1] === "-") return l.slice(0, i); }
    return l;
  }).join("\n");
  const out: string[] = []; let atual = "", dolar = false;
  for (let i = 0; i < semComentario.length; i++) {
    if (semComentario.startsWith("$$", i)) { dolar = !dolar; atual += "$$"; i++; continue; }
    if (!dolar && semComentario[i] === ";") { if (atual.trim()) out.push(atual.trim()); atual = ""; continue; }
    atual += semComentario[i];
  }
  if (dolar) throw new ErroSQL("$$ sem fechamento");
  if (atual.trim()) out.push(atual.trim());
  return out;
}
export type Execucao = { ok: true; db: Banco; traco: Traco; notices: string[]; comandos: string[] } | { ok: false; erro: string; db: Banco; traco: Traco; comandos: string[] };
/**
 * Executa o script numa "transação": qualquer erro → banco original intacto (o chamador recebe o
 * erro, o traço dos IFs rotulados até ali e os comandos executados). Temp ON COMMIT DROP some no commit.
 */
export function executarScript(sql: string, db0: Banco, restricoes: Restricoes): Execucao {
  const db = clonar(db0);
  const traco: Traco = [], notices: string[] = [], comandos: string[] = [];
  let emTransacao = false;
  const dropNoCommit: string[] = [];
  try {
    for (const cmd of comandosDoScript(sql)) {
      const baixo = cmd.toLowerCase();
      const tipo = baixo.split(/\s+/).slice(0, 2).join(" ");
      comandos.push(tipo);
      let m: RegExpExecArray | null;
      if (/^begin$/.test(baixo)) { if (emTransacao) throw new ErroSQL("transação já aberta"); emTransacao = true; continue; }
      if (/^commit$/.test(baixo)) { if (!emTransacao) throw new ErroSQL("there is no transaction in progress"); for (const t of dropNoCommit) delete db.temp[t]; emTransacao = false; continue; }
      if ((m = /^set\s+local\s+(\w+)\s*=\s*'([^']*)'$/.exec(baixo))) { if (!emTransacao) throw new ErroSQL("SET LOCAL fora de transação"); db.config[m[1]] = m[2]; continue; }
      if ((m = /^lock\s+table\s+([\w.]+)\s+in\s+([\w\s]+?)\s+mode$/.exec(baixo))) { if (!emTransacao) throw new ErroSQL("LOCK TABLE can only be used in transaction blocks"); db.locks.push({ tabela: m[1], modo: m[2].replace(/\s+/g, " ") }); continue; }
      if ((m = /^do\s+\$\$([\s\S]*)\$\$$/i.exec(cmd))) {
        const e: Exec = { db, vars: {}, restricoes, traco, notices };
        for (const s of compilarCorpo(m[1])) s(e);
        continue;
      }
      if ((m = /^create\s+temp(?:orary)?\s+table\s+(\w+)\s+on\s+commit\s+drop\s+as\s+([\s\S]+)$/i.exec(cmd))) {
        if (!emTransacao) throw new ErroSQL("ON COMMIT DROP fora de transação some na hora");
        const L = new Leitor(tokenizar(m[2])); const q = lerSelect(L); if (!L.fim()) throw new ErroSQL("sobra no CREATE TEMP");
        db.temp[m[1].toLowerCase()] = rodarSelect(q, { db, alias: {}, vars: {} }); dropNoCommit.push(m[1].toLowerCase());
        continue;
      }
      if ((m = /^create\s+or\s+replace\s+function\s+([\w.]+)\(\)\s+returns\s+trigger\s+language\s+plpgsql\b[\s\S]*?\bas\s+\$\$([\s\S]*)\$\$$/i.exec(cmd))) {
        db.funcoes[m[1].toLowerCase()] = compilarCorpo(m[2]); (db.fontes ??= {})[m[1].toLowerCase()] = m[2]; continue;
      }
      if ((m = /^create\s+unique\s+index\s+(\w+)\s+on\s+([\w.]+)\s*\(([\s\S]*)$/i.exec(cmd))) {
        const nome = m[1].toLowerCase(), tabela = m[2].toLowerCase();
        if ((db.indices ?? []).some((i) => i.nome === nome)) throw new ErroSQL(`relation "${nome}" already exists`);
        const L = new Leitor(tokenizar(`(${m[3]}`)); L.tomar("(");
        const colunas: Expr[] = []; do colunas.push(lerExpr(L)); while (L.opc(","));
        L.tomar(")");
        const onde = L.opc("where") ? lerExpr(L) : null;
        if (!L.fim()) throw new ErroSQL(`sobra no CREATE UNIQUE INDEX: ${L.ver().v}`);
        const idx: IndiceUnico = { nome, tabela, colunas, onde, def: cmd.replace(/\s+/g, " "), valido: true, pronto: true };
        const vistos = new Set<string>();
        for (const r of db.tabelas[tabela] ?? []) { const k = chaveIndice(db, idx, r); if (k === null) continue; if (vistos.has(k)) throw new ErroSQL(`could not create unique index "${nome}"`); vistos.add(k); }
        (db.indices ??= []).push(idx); continue;
      }
      if ((m = /^alter\s+table\s+([\w.]+)\s+add\s+constraint\s+(\w+)\s+check\s*\(([\s\S]*)$/i.exec(cmd))) {
        const tabela = m[1].toLowerCase(), nome = m[2].toLowerCase();
        if ((db.checks ?? []).some((k) => k.nome === nome)) throw new ErroSQL(`constraint "${nome}" for relation "${tabela}" already exists`);
        const L = new Leitor(tokenizar(`(${m[3]}`)); L.tomar("("); const expr = lerExpr(L); L.tomar(")");
        const naoValida = L.opc("not") ? (L.tomar("valid"), true) : false;
        if (!L.fim()) throw new ErroSQL(`sobra no ADD CONSTRAINT: ${L.ver().v}`);
        const k: CheckRestricao = { nome, tabela, expr, def: `CHECK (${m[3].replace(/\)\s*not\s+valid\s*$/i, "").replace(/\)\s*$/, "").trim()})`, validado: false };
        if (!naoValida) validarCheck(db, k);
        (db.checks ??= []).push(k); continue;
      }
      if ((m = /^alter\s+table\s+([\w.]+)\s+(add\s+column\s+[\s\S]+)$/i.exec(cmd))) {
        adicionarColunas(db, m[1].toLowerCase(), m[2]); continue;
      }
      if ((m = /^alter\s+table\s+([\w.]+)\s+validate\s+constraint\s+(\w+)$/i.exec(cmd))) {
        const k = (db.checks ?? []).find((x) => x.nome === m![2].toLowerCase() && x.tabela === m![1].toLowerCase());
        if (!k) throw new ErroSQL(`constraint "${m[2]}" of relation "${m[1]}" does not exist`);
        validarCheck(db, k); continue;
      }
      if ((m = /^drop\s+trigger\s+(\w+)\s+on\s+([\w.]+)$/i.exec(cmd))) {
        const i = db.gatilhos.findIndex((g) => g.nome === m![1].toLowerCase() && g.tabela === m![2].toLowerCase());
        if (i < 0) throw new ErroSQL(`trigger "${m[1]}" for table "${m[2]}" does not exist`);
        db.gatilhos.splice(i, 1); continue;
      }
      if ((m = /^create\s+trigger\s+(\w+)\s+before\s+(insert)?(?:\s*or\s+)?(update(?:\s+of\s+([\w,\s]+?))?)?\s+on\s+([\w.]+)\s+for\s+each\s+row\s+execute\s+function\s+([\w.]+)\(\)$/i.exec(cmd))) {
        const nome = m[1].toLowerCase();
        if (db.gatilhos.some((g) => g.nome === nome && g.tabela === m![5].toLowerCase())) throw new ErroSQL(`trigger "${nome}" already exists`);
        db.gatilhos.push({ nome, tabela: m[5].toLowerCase(), funcao: m[6].toLowerCase(), insert: !!m[2],
          colunasUpdate: m[3] ? (m[4] ? m[4].split(",").map((c) => c.trim().toLowerCase()) : ["*"]) : null });
        continue;
      }
      throw new ErroSQL(`comando de topo não suportado: ${cmd.slice(0, 60)}`);
    }
    if (emTransacao) throw new ErroSQL("script terminou com transação aberta (sem COMMIT)");
    return { ok: true, db, traco, notices, comandos };
  } catch (err: any) {
    return { ok: false, erro: String(err?.message ?? err), db: clonar(db0), traco, comandos };
  }
}
/** Tipos aceitos em ADD COLUMN → nome em information_schema.columns.data_type. Outro tipo → erro. */
const TIPOS_COLUNA: Record<string, string> = { text: "text", timestamptz: "timestamp with time zone", boolean: "boolean", uuid: "uuid", numeric: "numeric" };
/**
 * ALTER TABLE t ADD COLUMN c tipo [DEFAULT expr] [NOT NULL | NULL] [, ADD COLUMN ...] — atômico no
 * comando. Coluna existente → erro (sem IF NOT EXISTS); NOT NULL sem default em tabela com linhas →
 * erro; o default é avaliado e gravado em TODA linha existente. Qualquer outra sintaxe → erro.
 */
function adicionarColunas(db: Banco, tabela: string, clausulas: string) {
  const cols = db.colunas?.[tabela];
  if (!cols) throw new ErroSQL(`colunas de "${tabela}" não declaradas (ADD COLUMN exige o catálogo da tabela)`);
  const L = new Leitor(tokenizar(clausulas));
  const novas: Coluna[] = [];
  do {
    L.tomar("add"); L.tomar("column");
    if (L.eh("if")) throw new ErroSQL("IF NOT EXISTS não suportado (fail-closed)");
    const nome = L.tomar().v;
    let tipo = L.tomar().v;
    if (tipo === "timestamp" && L.opc("with")) { L.tomar("time"); L.tomar("zone"); tipo = "timestamptz"; }
    if (!(tipo in TIPOS_COLUNA)) throw new ErroSQL(`tipo não suportado em ADD COLUMN: ${tipo}`);
    const col: Coluna = { nome, tipo: TIPOS_COLUNA[tipo], nula: true, padrao: null, padraoExpr: null };
    while (!L.fim() && !L.eh(",")) {
      if (L.opc("default")) {
        const ini = L.p; col.padraoExpr = lerExpr(L);
        col.padrao = L.k.slice(ini, L.p).map((x) => (x.t === "str" ? `'${x.v}'` : x.v)).join(" ");
      } else if (L.opc("not")) { L.tomar("null"); col.nula = false; }
      else if (L.opc("null")) { col.nula = true; }
      else throw new ErroSQL(`sobra no ADD COLUMN: ${L.ver().v}`);
    }
    if (cols.some((c) => c.nome === nome) || novas.some((c) => c.nome === nome)) throw new ErroSQL(`column "${nome}" of relation "${tabela.split(".").pop()}" already exists`);
    novas.push(col);
  } while (L.opc(","));
  const linhas = db.tabelas[tabela] ?? [];
  const valores = linhas.map((r) => novas.map((c) => (c.padraoExpr ? c.padraoExpr(ctxLinha(db, r)) : null)));
  novas.forEach((c, j) => {
    if (!c.nula && valores.some((v) => v[j] === null || v[j] === undefined)) throw new ErroSQL(`column "${c.nome}" of relation "${tabela.split(".").pop()}" contains null values`);
  });
  linhas.forEach((r, i) => novas.forEach((c, j) => { r[c.nome] = valores[i][j] ?? null; }));
  cols.push(...novas);
}
function validarCheck(db: Banco, k: CheckRestricao) {
  if ((db.tabelas[k.tabela] ?? []).some((r) => tri(k.expr(ctxLinha(db, r))) === false)) {
    throw new ErroSQL(`check constraint "${k.nome}" of relation "${k.tabela.split(".").pop()}" is violated by some row`);
  }
  k.validado = true;
}
export function clonar(db: Banco): Banco {
  return { tabelas: JSON.parse(JSON.stringify(db.tabelas)), temp: JSON.parse(JSON.stringify(db.temp)), funcoes: { ...db.funcoes },
    gatilhos: db.gatilhos.map((g) => ({ ...g, colunasUpdate: g.colunasUpdate ? [...g.colunasUpdate] : null })), config: { ...db.config }, locks: [...db.locks],
    fontes: { ...(db.fontes ?? {}) }, indices: (db.indices ?? []).map((i) => ({ ...i })), checks: (db.checks ?? []).map((k) => ({ ...k })),
    ...(db.colunas ? { colunas: Object.fromEntries(Object.entries(db.colunas).map(([t, cs]) => [t, cs.map((c) => ({ ...c }))])) } : {}) };
}
/** Declara as colunas JÁ existentes de uma tabela (catálogo de produção), para ADD COLUMN / information_schema. */
export function declararColunas(db: Banco, tabela: string, colunas: Array<Omit<Coluna, "padraoExpr">>) {
  // default executável quando é literal simples (0, true, 8...); função (now(), gen_random_uuid()) fica só como texto
  const expr = (padrao: string | null) => {
    if (padrao === null || /\(/.test(padrao)) return null;
    const L = new Leitor(tokenizar(padrao)); const e = lerExpr(L); return L.fim() ? e : null;
  };
  (db.colunas ??= {})[tabela] = colunas.map((c) => ({ ...c, padraoExpr: expr(c.padrao) }));
}
/**
 * Declara objetos JÁ existentes no banco (fora da migration sob teste): UNIQUE parcial e CHECK com a
 * definição exata do catálogo de produção; as expressões são executáveis (parseadas do SQL dado).
 */
export function declararIndiceUnico(db: Banco, nome: string, tabela: string, colunas: string, onde: string | null, def: string) {
  const L = new Leitor(tokenizar(`(${colunas})`)); L.tomar("("); const cols: Expr[] = []; do cols.push(lerExpr(L)); while (L.opc(",")); L.tomar(")");
  (db.indices ??= []).push({ nome, tabela, colunas: cols, onde: onde ? lerExpr(new Leitor(tokenizar(onde))) : null, def, valido: true, pronto: true });
}
export function declararCheck(db: Banco, nome: string, tabela: string, expr: string, def: string) {
  (db.checks ??= []).push({ nome, tabela, expr: lerExpr(new Leitor(tokenizar(expr))), def, validado: true });
}
/** Valor da variável `nome` no ÚLTIMO IF rotulado `rotulo` executado (ex.: contador n do PRECHECK G). */
export function contadorNoTraco(traco: Traco, rotulo: string, nome = "n"): number | null {
  const x = [...traco].reverse().find((t) => t.rotulo === rotulo);
  return x ? (x.vars[nome] ?? null) : null;
}
/** Executa UM SELECT (texto) sobre o banco e devolve as linhas projetadas. */
export function consultar(select: string, db: Banco): Linha[] {
  const L = new Leitor(tokenizar(select)); const q = lerSelect(L); L.opc(";");
  if (!L.fim()) throw new ErroSQL(`sobra no SELECT: ${L.ver().v}`);
  return rodarSelect(q, { db, alias: {}, vars: {} });
}
/** Executa SÓ um bloco DO (ex.: o de validação) sobre um banco já preparado — para provas negativas isoladas. */
export function executarBlocoDo(corpo: string, db: Banco, restricoes: Restricoes): { erro: string | null; traco: Traco } {
  const traco: Traco = [];
  try { const e: Exec = { db, vars: {}, restricoes, traco, notices: [] }; for (const s of compilarCorpo(corpo)) s(e); return { erro: null, traco }; }
  catch (err: any) { return { erro: String(err?.message ?? err), traco }; }
}
