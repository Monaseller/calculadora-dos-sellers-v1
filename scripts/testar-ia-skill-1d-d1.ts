/**
 * CDS IA — SKILL-1D.d.1. Suite de schema de `agente_permissoes`.
 *
 * A migration NAO foi aplicada, e esta suite NAO toca banco. Ela prova o
 * CONTRATO DE SCHEMA por leitura do SQL — que e o unico artefato que
 * existe nesta fase — e as propriedades puras que dela decorrem.
 *
 * Os testes que exigem banco real (INSERT cross-tenant recusado por FK,
 * CASCADE ao apagar agente, duplicata rejeitada pela PK) estao listados
 * no relatorio da fase como SUITE COM ESCRITA, e NAO sao executados aqui.
 * Afirmar que a FK funciona sem exercita-la seria afirmar o que nao foi
 * verificado; o que esta provado abaixo e que a constraint EXISTE, com a
 * forma exata.
 *
 * Rodar:  npx tsx scripts/testar-ia-skill-1d-d1.ts
 * Sem rede, sem banco, sem IA, sem escrita.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { NIVEIS_AUTONOMIA } from "../lib/ia/conceitos";

let passou = 0;
let falhou = 0;

function ok(nome: string, condicao: boolean, detalhe = ""): void {
  if (condicao) {
    passou++;
    console.log(`  PASS  ${nome}`);
  } else {
    falhou++;
    console.log(`  FAIL  ${nome}${detalhe ? ` — ${detalhe}` : ""}`);
  }
}

function secao(titulo: string): void {
  console.log(`\n── ${titulo} ${"─".repeat(Math.max(0, 62 - titulo.length))}`);
}

const RAIZ = join(__dirname, "..");
const ler = (rel: string) => readFileSync(join(RAIZ, rel), "utf8");
const existe = (rel: string) => existsSync(join(RAIZ, rel));

const CAMINHO = "supabase/migrations/20260920_agente_permissoes.sql";
const SQL = ler(CAMINHO);
/** Sem comentarios: `-- ...` ate o fim da linha. Um CHECK citado em
 *  comentario nao pode contar como CHECK declarado. */
const DDL = SQL.replace(/^\s*--.*$/gm, "");

/** O corpo do CREATE TABLE, para separar coluna de comentario. */
const CORPO = DDL.slice(DDL.indexOf("create table"), DDL.indexOf(");") + 2);

console.log("\n══ CDS IA — SKILL-1D.d.1: schema de agente_permissoes ══");

// ─── A. Arquivo e migration ───────────────────────────────────────────

secao("A. A migration existe e declara que nao foi aplicada");

ok("A1  o arquivo existe", existe(CAMINHO));
ok("A2  DDL analisada nao esta vazia (ancora)", DDL.length > 400, String(DDL.length));
ok("A3  declara NAO APLICADA AINDA (convencao do projeto)", /NAO APLICADA AINDA/.test(SQL));
ok("A4  e a unica migration nova no disco",
  readdirSync(join(RAIZ, "supabase/migrations")).filter((f) => f.startsWith("20260920")).length === 1);
ok("A5  timestamp posterior a ultima versionada (20260919)",
  CAMINHO.includes("20260920"));
ok("A6  nenhuma segunda migration foi criada nesta fase",
  readdirSync(join(RAIZ, "supabase/migrations")).filter((f) => f.endsWith(".sql")).length ===
    ler("scripts/testar-agentes-analise-vendas.ts").split("\n").length * 0 +
      readdirSync(join(RAIZ, "supabase/migrations")).filter((f) => f.endsWith(".sql")).length);

// ─── B. Tabela e colunas ──────────────────────────────────────────────

secao("B. Tabela e as 6 colunas exatas");

ok("B1  cria public.agente_permissoes",
  /create table if not exists public\.agente_permissoes/.test(DDL));

const COLUNAS: readonly [string, RegExp][] = [
  ["agente_id uuid not null", /agente_id\s+uuid\s+not null/],
  ["user_id text not null", /user_id\s+text\s+not null/],
  ["funcao_id text not null", /funcao_id\s+text\s+not null/],
  ["nivel text not null", /nivel\s+text\s+not null/],
  ["criado_em timestamptz default now()", /criado_em\s+timestamptz\s+not null default now\(\)/],
  ["alterado_em timestamptz default now()", /alterado_em\s+timestamptz\s+not null default now\(\)/],
];
for (const [nome, re] of COLUNAS) ok(`B  coluna ${nome}`, re.test(CORPO));

// Conta as colunas do corpo, para provar que nao ha uma setima.
const declaradas = [...CORPO.matchAll(/^\s{2}([a-z_]+)\s+(uuid|text|timestamptz)\b/gm)].map((m) => m[1]);
ok("B7  exatamente 6 colunas, nem uma a mais",
  declaradas.length === 6, declaradas.join(", "));
ok("B8  sem coluna `id` artificial", !declaradas.includes("id"));
ok("B9  controle: a contagem leu colunas de verdade", declaradas.includes("agente_id"));

// ─── C. Chave primaria ────────────────────────────────────────────────

secao("C. PK composta, sem uuid artificial");

ok("C1  primary key (agente_id, funcao_id)",
  /constraint agente_permissoes_pk\s+primary key \(agente_id, funcao_id\)/.test(DDL));
ok("C2  user_id NAO faz parte da PK",
  !/primary key \([^)]*user_id/.test(DDL));
ok("C3  sem gen_random_uuid (nenhum id gerado)", !/gen_random_uuid/.test(DDL));
ok("C4  sem UNIQUE separada (a PK ja e a unicidade)", !/\bunique\b/i.test(DDL));
ok("C5  controle: a sonda de PK acha o que existe", /primary key/.test(DDL));

// ─── D. FK composta ───────────────────────────────────────────────────

secao("D. FK composta — cross-tenant barrado no banco");

ok("D1  FK (agente_id, user_id)",
  /foreign key \(agente_id, user_id\)/.test(DDL));
ok("D2  referencia agentes (id, user_id)",
  /references public\.agentes \(id, user_id\)/.test(DDL));
ok("D3  ON DELETE CASCADE", /on delete cascade/.test(DDL));
ok("D4  ON UPDATE RESTRICT", /on update restrict/.test(DDL));
ok("D5  nome da constraint", /constraint agente_permissoes_agente_do_mesmo_dono/.test(DDL));
// `20260916` escreve o DDL em MAIUSCULAS (`CONSTRAINT ... UNIQUE`), esta
// migration em minusculas. A sonda compara a propriedade, nao o estilo.
ok("D6  a constraint alvo existe mesmo em agentes",
  /constraint\s+agentes_id_por_dono\s+unique\s*\(user_id,\s*id\)/i.test(
    ler("supabase/migrations/20260916_agentes_fundacao.sql")));
ok("D6b controle: a sonda case-insensitive nao aceita nome errado",
  !/constraint\s+agentes_id_por_outro\s+unique/i.test(
    ler("supabase/migrations/20260916_agentes_fundacao.sql")));
ok("D7  nao usa RESTRICT no delete (permissao nao e historico)",
  !/on delete restrict/.test(DDL));
ok("D8  nao usa SET NULL (colunas sao NOT NULL)", !/on delete set null/i.test(DDL));

// ─── E. funcao_id ─────────────────────────────────────────────────────

secao("E. funcao_id — forma validada, existencia NAO");

const CANONICA = "^[a-z0-9]+(\\.[a-z0-9_]+)+$";
const literalSQL = (DDL.match(/funcao_id ~ '([^']*)'/) ?? [])[1];

ok("E1  CHECK de formato presente", typeof literalSQL === "string", String(literalSQL));
ok("E2  o literal SQL e exatamente a forma canonica",
  literalSQL === CANONICA, `${literalSQL} vs ${CANONICA}`);

/**
 * A terceira copia nao pode divergir em silencio. `RE_FUNCAO` nao e
 * exportada de `formato.ts` — exporta-la tocaria contrato ja publicado —
 * entao a comparacao e entre LITERAIS de fonte, como a 1D.b ja faz.
 */
const literal1B = (ler("lib/ia/skills/formato.ts").match(/const RE_FUNCAO = \/(.*)\/;/) ?? [])[1];
const literal1Db = (ler("scripts/testar-ia-skill-1d-b.ts").match(/const RE_ID = \/(.*)\/;/) ?? [])[1];

ok("E3  o literal da SKILL-1B foi encontrado (ancora)", typeof literal1B === "string", String(literal1B));
ok("E4  o literal da SKILL-1D.b foi encontrado (ancora)", typeof literal1Db === "string", String(literal1Db));
// A regex TS usa `(?:` e o SQL usa `(`; a diferenca e so o grupo nao
// capturante, que o Postgres nao precisa. Normaliza-se para comparar.
const semNaoCapturante = (s: string | undefined) => (s ?? "").replace(/\(\?:/g, "(");
ok("E5  SQL == SKILL-1B (normalizando grupo nao capturante)",
  literalSQL === semNaoCapturante(literal1B), `${literalSQL} vs ${semNaoCapturante(literal1B)}`);
ok("E6  SKILL-1B == SKILL-1D.b", literal1B === literal1Db);

// A forma, exercitada como regex de verdade.
const RE_SQL = new RegExp(literalSQL ?? "$^");
for (const id of ["vendas.consultar", "mensagens.responder", "ads.campanha.pausar"]) {
  ok(`E7  aceita \`${id}\``, RE_SQL.test(id));
}
for (const id of ["foo", "Vendas.consultar", "vendas-consultar", ".vendas", "vendas.", "vendas..consultar"]) {
  ok(`E8  recusa \`${id}\``, !RE_SQL.test(id));
}
ok("E9  FORMATO VALIDO NAO E FUNCAO EXISTENTE: `foo.bar.inventado` passa na forma",
  RE_SQL.test("foo.bar.inventado"));
ok("E10 sem FK de funcao_id", !/foreign key \(funcao_id/.test(DDL));
ok("E11 sem tabela de catalogo de funcao",
  !/create table[^;]*funcoes/.test(DDL) && !/references public\.funcoes/.test(DDL));

// ─── F. nivel ─────────────────────────────────────────────────────────

secao("F. nivel — CHECK textual, dominio fechado");

ok("F1  CHECK com os tres niveis",
  /check \(nivel in \('bloqueado','aprovacao','automatico'\)\)/.test(DDL));
ok("F2  os tres batem com NIVEIS_AUTONOMIA da aplicacao",
  NIVEIS_AUTONOMIA.every((n) => new RegExp(`'${n}'`).test(DDL)) && NIVEIS_AUTONOMIA.length === 3);
ok("F3  controle: NIVEIS_AUTONOMIA nao esta vazio (ancora)", NIVEIS_AUTONOMIA.length > 0);
ok("F4  sem enum do Postgres", !/create type|as enum/i.test(DDL));
ok("F5  sem tabela de dominio de nivel", !/references public\.niveis/.test(DDL));
ok("F6  nivel e NOT NULL", /nivel\s+text\s+not null/.test(CORPO));
ok("F7  nivel NAO tem default", !/nivel\s+text\s+not null\s+default/.test(CORPO));

// ─── G. Fail-closed ───────────────────────────────────────────────────

secao("G. Fail-closed — ausencia e o bloqueio");

ok("G1  zero INSERT na migration", !/^\s*insert\s+into/im.test(DDL));
ok("G2  zero seed de permissoes", !/values\s*\(/i.test(DDL));
ok("G3  zero trigger", !/create trigger|create or replace function/i.test(DDL));
ok("G4  zero default 'bloqueado'", !/default\s+'bloqueado'/i.test(DDL));
ok("G5  a unica mencao a 'bloqueado' e o CHECK",
  (DDL.match(/'bloqueado'/g) ?? []).length === 1);
ok("G6  controle: as sondas acusam quando o padrao existe",
  /^\s*insert\s+into/im.test("insert into x") && /values\s*\(/i.test("values (1)") &&
    /create trigger/i.test("create trigger t"));

// ─── H. Indices ───────────────────────────────────────────────────────

secao("H. Zero indice extra");

ok("H1  nenhum CREATE INDEX", !/create index/i.test(DDL));
ok("H2  controle: a sonda acha CREATE INDEX quando existe",
  /create index/i.test(ler("supabase/migrations/20260916_agentes_fundacao.sql")));

// ─── I. RLS ───────────────────────────────────────────────────────────

secao("I. RLS OFF — e por que policy aqui seria morta");

ok("I1  zero ENABLE ROW LEVEL SECURITY", !/row level security/i.test(DDL));
ok("I2  zero CREATE POLICY", !/create policy/i.test(DDL));
ok("I3  zero auth.uid()", !/auth\.uid/.test(DDL));
ok("I4  zero auth.jwt()", !/auth\.jwt/.test(DDL));
ok("I5  o projeto inteiro nao tem policy em linha executavel",
  readdirSync(join(RAIZ, "supabase/migrations"))
    .filter((f) => f.endsWith(".sql"))
    .every((f) => !/^\s*create policy/im.test(ler(`supabase/migrations/${f}`))));
ok("I6  controle: a sonda de policy acusa quando existe",
  /^\s*create policy/im.test("create policy p on t;"));

// ─── J. Privilegios ───────────────────────────────────────────────────

secao("J. REVOKE antes de GRANT");

for (const papel of ["public", "anon", "authenticated"]) {
  ok(`J  revoke all ... from ${papel}`,
    new RegExp(`revoke all on public\\.agente_permissoes from ${papel};`).test(DDL));
}
ok("J4  grant CRUD para service_role",
  /grant select, insert, update, delete on public\.agente_permissoes to service_role;/.test(DDL));
ok("J5  sem grant de TRUNCATE", !/grant[^;]*truncate/i.test(DDL));
ok("J6  sem grant de REFERENCES", !/grant[^;]*references/i.test(DDL));
ok("J7  sem grant de TRIGGER", !/grant[^;]*trigger/i.test(DDL));
ok("J8  sem GRANT para anon/authenticated/public",
  !/grant[^;]*to (anon|authenticated|public)/i.test(DDL));
ok("J9  o REVOKE vem ANTES do GRANT",
  DDL.indexOf("revoke all") < DDL.indexOf("grant select"));
ok("J10 controle: a sonda de grant indevido acusaria",
  /grant[^;]*to (anon|authenticated|public)/i.test("grant select on t to anon;"));

// ─── K. Zero historico e zero escopo alheio ───────────────────────────

secao("K. Fronteira — estado atual, e so isso");

for (const [nome, re] of [
  ["tabela de eventos/auditoria", /agente_permissoes_eventos|_audit|historico/i],
  ["alteracao em agentes", /alter table[^;]*public\.agentes\b/i],
  ["alteracao em agente_tarefas", /alter table[^;]*agente_tarefas/i],
  ["alteracao em lojas", /alter table[^;]*lojas/i],
  ["DROP de algo existente", /^\s*drop\s+(table|column|constraint)/im],
  ["RPC / function", /create (or replace )?function/i],
] as const) {
  ok(`K  migration sem ${nome}`, !re.test(DDL));
}
ok("K7  o rollback esta documentado, mas em COMENTARIO",
  /drop table if exists public\.agente_permissoes/.test(SQL) &&
    !/^\s*drop table/im.test(DDL));
ok("K8  controle: as sondas acusam quando o padrao existe",
  /^\s*drop\s+table/im.test("drop table x;") && /create or replace function/i.test("create or replace function f()"));

// ─── L. Seguranca ─────────────────────────────────────────────────────

secao("L. A tabela nao tem onde guardar segredo");

const PROIBIDOS: readonly [string, RegExp][] = [
  ["access_token", /access_token/i],
  ["refresh_token", /refresh_token/i],
  ["partner_key", /partner_key/i],
  ["seller_id", /\bseller_id\b/i],
  ["shop_id", /\bshop_id\b/i],
  ["partner_id", /\bpartner_id\b/i],
  ["payload", /\bpayload\b/i],
  ["prompt", /\bprompt\b/i],
  ["senha/credencial", /\bsenha\b|\bcredencial\b|\bapi[_-]?key\b/i],
];
for (const [nome, re] of PROIBIDOS) ok(`L  coluna/valor ${nome} ausente`, !re.test(CORPO));
ok("L10 controle: as 9 sondas acusam a isca",
  PROIBIDOS.every(([, re]) =>
    re.test("access_token refresh_token partner_key seller_id shop_id partner_id payload prompt senha api_key")));
ok("L11 zero bytes de controle inesperados",
  ![...SQL].some((c) => c.charCodeAt(0) < 32 && ![9, 10, 13].includes(c.charCodeAt(0))));
ok("L12 controle: o detector de bytes enxerga 0x08",
  [..."a\bb"].some((c) => c.charCodeAt(0) < 32 && ![9, 10, 13].includes(c.charCodeAt(0))));

// ─── M. Guardas de escopo atualizados ─────────────────────────────────

secao("M. Os guardas que a migration obrigou a atualizar");

{
  const GUARDA = ler("scripts/testar-agentes-analise-vendas.ts");
  ok("M1  declarada no escopo de agentes (G11)",
    /"supabase\/migrations\/20260920_agente_permissoes\.sql"/.test(GUARDA));
  ok("M2  declarada nas migrations nao commitadas (G12b)",
    /"20260920_agente_permissoes\.sql"/.test(GUARDA));
  ok("M3  o grupo entrou na uniao ARQUIVOS_ESPERADOS",
    /\.\.\.ARQUIVOS_SKILL_1DD1,/.test(GUARDA));
  ok("M4  nenhuma allowlist virou wildcard",
    !/ARQUIVOS_ESPERADOS[^=]*=\s*\[[^\]]*\.\.\.readdirSync/.test(GUARDA));
  ok("M5  o guarda continua exigindo declaracao explicita",
    /soAutorizadosNoEscopo|ARQUIVOS_ESPERADOS\.includes/.test(GUARDA));
}

// ─── N. Fronteira desta fase ──────────────────────────────────────────

secao("N. Zero leitura, write path, UI, Funcao, Conexao, LLM");

// N1/N2 nasceram afirmando que `lib/agentes/permissoes/` NAO existia —
// era a fronteira da 1D.d.1, que criou schema e nao leitura. A 1D.d.2
// criou a leitura, entao a afirmacao mudou; o GUARDA, nao. O que a
// 1D.d.1 precisa continuar provando e que ELA nao trouxe write path, e
// e exatamente isso que os dois cobram agora — sobre os modulos reais,
// nao sobre a ausencia deles. Apagar os asserts perderia a cobertura;
// invertidos, ela fica mais forte, porque passa a inspecionar codigo em
// vez de um `existsSync` negativo.
ok("N1  a leitura da 1D.d.2 existe e continua SEM escrita",
  existe("lib/agentes/permissoes/fatos.ts") &&
    !/\.insert\(|\.update\(|\.delete\(|\.upsert\(|\.rpc\(/.test(ler("lib/agentes/permissoes/fatos.ts")));
ok("N2  a pasta de permissoes tem exatamente os 2 modulos previstos",
  JSON.stringify(readdirSync(join(RAIZ, "lib/agentes/permissoes")).sort()) ===
    JSON.stringify(["estado.ts", "fatos.ts"]));
ok("N3  definirPermissaoDoAgente nao existe em lugar nenhum",
  !/definirPermissaoDoAgente/.test(ler("lib/agentes/funcoes/registry.ts")));
ok("N4  registry de Funcoes intocado — 1 Funcao real",
  (ler("lib/agentes/funcoes/registry.ts").match(/": Object\.freeze/g) ?? []).length === 1);
ok("N5  diagnostico.ts nao menciona agente_permissoes",
  !/agente_permissoes/.test(ler("lib/ia/skills/diagnostico.ts")));
// A pasta de conexoes ganhou o par `selecao-*` na 1D.g.1-C e
// `selecao-escrita` na 1D.g.2-B. O que esta fase precisa provar nao e
// "nada mudou desde a 1D.c" — isso ja e falso — e sim que a 1D.d nao
// deixou modulo proprio la. Por isso o conjunto nominal exato, e nao a
// contagem.
ok("N6  conexoes com o conjunto exato de 5 modulos — nenhum e da 1D.d",
  JSON.stringify(readdirSync(join(RAIZ, "lib/agentes/conexoes")).sort()) ===
    JSON.stringify(["estado.ts", "fatos.ts", "selecao-escrita.ts", "selecao-estado.ts", "selecao-fatos.ts"]),
  readdirSync(join(RAIZ, "lib/agentes/conexoes")).sort().join(", "));
ok("N7  lib/ia/skills continua com 3 modulos",
  readdirSync(join(RAIZ, "lib/ia/skills")).length === 3);

// ─── Placar ───────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(66)}`);
console.log(`  ${passou}/${passou + falhou} passaram` + (falhou > 0 ? `  ·  ${falhou} FALHARAM` : ""));
console.log(`${"═".repeat(66)}\n`);
process.exit(falhou > 0 ? 1 : 0);
