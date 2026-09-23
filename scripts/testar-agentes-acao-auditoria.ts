/**
 * `agente_acao_execucoes` — invariantes ESTRUTURAIS da migration.
 *
 * Le o SQL sem comentario: um invariante nao pode ser provado pela
 * prosa do arquivo que ele audita. Esta suite ja custou caro nesta
 * frente — duas asserções nasceram casando com o proprio comentario.
 *
 * O comportamento contra o Postgres real vive em
 * `scripts/testar-agentes-acao-auditoria-banco.ts`.
 *
 * Rodar:  npx tsx scripts/testar-agentes-acao-auditoria.ts
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

let passou = 0;
let falhou = 0;

function ok(nome: string, condicao: boolean, detalhe = ""): void {
  if (condicao) { passou += 1; console.log(`  PASS  ${nome}`); }
  else { falhou += 1; console.log(`  FAIL  ${nome}${detalhe ? `  — ${detalhe}` : ""}`); }
}

function secao(titulo: string): void {
  console.log(`\n── ${titulo} ${"─".repeat(Math.max(2, 60 - titulo.length))}`);
}

const RAIZ = join(__dirname, "..");
const ler = (rel: string) => readFileSync(join(RAIZ, rel), "utf8");

const ARQUIVO = "supabase/migrations/20261010_agente_acao_execucoes.sql";
const SQL = ler(ARQUIVO);
/** Sem comentarios. Prosa nao prova invariante. */
const CODIGO = SQL.replace(/^\s*--.*$/gm, "");
/** Espacos normalizados, para que quebra de linha nao decida veredito. */
const LISO = CODIGO.replace(/\s+/g, " ");

console.log("\n══ CDS IA — agente_acao_execucoes: invariantes estruturais ══");

// ─── A. A tabela ──────────────────────────────────────────────────────
secao("A. Tabela e colunas");

ok("A1  cria `public.agente_acao_execucoes`",
  /create table public\.agente_acao_execucoes \(/i.test(LISO));
ok("A2  SEM `if not exists` — objeto de forma errada falha alto",
  !/create table if not exists public\.agente_acao_execucoes/i.test(LISO));

const COLUNAS: ReadonlyArray<readonly [string, string]> = [
  ["id", "uuid primary key default gen_random_uuid()"],
  ["user_id", "text not null"],
  ["agente_id", "uuid not null"],
  ["loja_id", "uuid null"],
  ["acao_id", "text not null"],
  ["request_id", "text not null"],
  ["fase", "text not null"],
  ["status", "text not null"],
  ["codigo_desfecho", "text null"],
  ["mensagem_desfecho", "text null"],
  ["idempotency_key", "text null"],
  ["entrada_resumo", "jsonb not null default '{}'::jsonb"],
  ["latencia_ms", "integer null"],
  ["criado_em", "timestamptz not null default now()"],
];
for (const [coluna, declaracao] of COLUNAS) {
  ok(`A3  coluna \`${coluna}\` declarada como esperado`,
    LISO.includes(`${coluna} ${declaracao}`), declaracao);
}
ok("A4  nenhuma coluna especulativa alem das 14",
  (CODIGO.slice(CODIGO.indexOf("create table"), CODIGO.indexOf("constraint agente_acao_execucoes_agente"))
    .match(/^\s{2}[a-z_]+ /gm) ?? []).length === COLUNAS.length);

// ─── B. `loja_id` opcional — o ponto critico ──────────────────────────
secao("B. Autoridade de loja — abertura NAO pode exigir conta");

ok("B1  `loja_id` e NULAVEL",
  /loja_id uuid null/.test(LISO) && !/loja_id uuid not null/.test(LISO));
ok("B2  a FK de loja e composta com o dono",
  /foreign key \(loja_id, user_id\) references public\.lojas \(id, user_id\)/i.test(LISO));
ok("B3  a FK de loja NAO usa `match full` — com NULL ela nao e verificada",
  !/match full/i.test(LISO));
ok("B4  a FK de agente e composta e obrigatoria",
  /foreign key \(agente_id, user_id\) references public\.agentes \(id, user_id\)/i.test(LISO));
ok("B5  as duas FKs usam RESTRICT nos dois sentidos",
  (LISO.match(/on update restrict on delete restrict/gi) ?? []).length === 2);

// ─── C. Identidade da acao ────────────────────────────────────────────
secao("C. `acao_id` nao pode ser confundido com Funcao");

const REGEX_ACAO = /acao_id ~ '\^\[a-z\]\[a-z0-9_\]\{2,63\}\$'/;
ok("C1  `acao_id` tem CHECK de formato", REGEX_ACAO.test(LISO));
ok("C2  o formato PROIBE ponto — o de Funcao o EXIGE",
  !/acao_id ~ '[^']*\\\./.test(LISO));
{
  // Os dois conjuntos sao disjuntos: nenhum id serve nos dois lugares.
  const daAcao = /^[a-z][a-z0-9_]{2,63}$/;
  const daFuncao = /^[a-z0-9]+(\.[a-z0-9_]+)+$/;
  ok("C3  `sincronizar_perguntas` e acao valida e NAO e Funcao valida",
    daAcao.test("sincronizar_perguntas") && !daFuncao.test("sincronizar_perguntas"));
  ok("C4  `mercadolivre.perguntas.listar` e Funcao valida e NAO e acao valida",
    daFuncao.test("mercadolivre.perguntas.listar")
    && !daAcao.test("mercadolivre.perguntas.listar"));
  ok("C5  os conjuntos sao disjuntos por construcao",
    ["sincronizar_perguntas", "a.b", "acao.x", "ab", "A_MAIUSCULO", "com-hifen"]
      .every((s) => !(daAcao.test(s) && daFuncao.test(s))));
  ok("C6  o formato tem teto de comprimento",
    !daAcao.test("a".repeat(65)) && daAcao.test("a".repeat(64)));
}

// ─── D. Fase e status ─────────────────────────────────────────────────
secao("D. Duas linhas, nunca um UPDATE");

ok("D1  `fase` e abertura ou desfecho",
  /fase in \('abertura', 'desfecho'\)/.test(LISO));
ok("D2  cinco estados, incluindo `parcial`",
  /status in \('executando', 'sucesso', 'parcial', 'erro', 'negado'\)/.test(LISO));
ok("D3  bicondicional: abertura sse executando",
  /\(fase = 'abertura'\) = \(status = 'executando'\)/.test(LISO));
ok("D4  abertura EXIGE chave de tentativa",
  /fase = 'desfecho' or idempotency_key is not null/.test(LISO));
ok("D5  abertura nao tem latencia; desfecho aceita nao negativa",
  /\(fase = 'abertura' and latencia_ms is null\) or \(fase = 'desfecho' and \(latencia_ms is null or latencia_ms >= 0\)\)/
    .test(LISO));

// ─── E. Vocabulario de desfecho ───────────────────────────────────────
secao("E. Vocabulario FECHADO, e capaz de dizer a verdade");

ok("E1  `executando` e `sucesso` nao tem codigo",
  /when 'executando' then codigo_desfecho is null/.test(LISO)
  && /when 'sucesso' then codigo_desfecho is null/.test(LISO));
for (const codigo of [
  "backlog_truncado", "descartes_na_varredura", "permission_denied",
  "provider_error", "persistence_error", "authority_drift", "internal_error",
]) {
  ok(`E2  o vocabulario contempla \`${codigo}\``, LISO.includes(`'${codigo}'`));
}
ok("E3  `backlog_truncado` cai em `parcial`, nunca em `sucesso`",
  /when 'parcial' then codigo_desfecho in \( 'backlog_truncado', 'descartes_na_varredura'\)/
    .test(LISO));
ok("E4  nao existe codigo generico de reserva",
  !/'outro'|'desconhecido'|'generico'/.test(LISO));
ok("E5  `agente_indisponivel` nao e codigo — sem agente nao ha linha",
  !/'agente_indisponivel'/.test(LISO));

// ─── F. Mensagem e resumo ─────────────────────────────────────────────
secao("F. Nada de payload comercial");

ok("F1  mensagem so em desfecho que explica algo",
  /mensagem_desfecho is null or status not in \('executando', 'sucesso'\)/.test(LISO));
ok("F2  mensagem limitada a 300",
  /length\(mensagem_desfecho\) <= 300/.test(LISO));
ok("F3  `entrada_resumo` e OBJETO, nunca array nem string",
  /jsonb_typeof\(entrada_resumo\) = 'object'/.test(LISO));
ok("F4  o resumo comeca vazio", /entrada_resumo jsonb not null default '\{\}'::jsonb/.test(LISO));

// ─── G. Indices ───────────────────────────────────────────────────────
secao("G. Unicidade e observabilidade");

ok("G1  a tentativa abre UMA vez (parcial nos dois eixos)",
  /create unique index idx_agente_acao_execucoes_tentativa on public\.agente_acao_execucoes \(user_id, acao_id, idempotency_key\) where fase = 'abertura' and idempotency_key is not null/i
    .test(LISO));
ok("G2  UMA abertura por request_id",
  /create unique index idx_agente_acao_execucoes_abertura_unica on public\.agente_acao_execucoes \(user_id, request_id\) where fase = 'abertura'/i
    .test(LISO));
ok("G3  UM desfecho por request_id",
  /create unique index idx_agente_acao_execucoes_desfecho_unico on public\.agente_acao_execucoes \(user_id, request_id\) where fase = 'desfecho'/i
    .test(LISO));
ok("G4  leitura por dono e por agente, do mais recente",
  /\(user_id, criado_em desc\)/.test(LISO) && /\(agente_id, criado_em desc\)/.test(LISO));
ok("G5  os dois lados do anti-join de orfas estao indexados",
  /where fase = 'abertura'/.test(LISO) && /where fase = 'desfecho'/.test(LISO));
ok("G6  nenhum indice especulativo alem dos cinco",
  (LISO.match(/create (unique )?index /gi) ?? []).length === 5);

// ─── H. Seguranca ─────────────────────────────────────────────────────
secao("H. Append-only e SEC1");

for (const papel of ["public", "anon", "authenticated", "service_role"]) {
  ok(`H1  revoke all nominal de \`${papel}\``,
    LISO.includes(`revoke all on table public.agente_acao_execucoes from ${papel};`));
}
ok("H2  service_role recebe SELECT e INSERT, e so",
  /grant select, insert on table public\.agente_acao_execucoes to service_role;/.test(LISO));
ok("H3  UPDATE/DELETE/TRUNCATE revogados de service_role",
  /revoke update, delete, truncate on table public\.agente_acao_execucoes from service_role;/.test(LISO));
ok("H4  nenhum grant a anon ou authenticated",
  !/grant [^;]*to (anon|authenticated|public)\b/i.test(LISO));
ok("H5  RLS permanece fora — o padrao congelado do projeto",
  !/enable row level security|create policy/i.test(LISO));

// ─── I. Contencao ─────────────────────────────────────────────────────
secao("I. O que esta migration NAO toca");

const SEM_TEXTO = CODIGO.replace(/'(?:[^']|'')*'/g, "''");
ok("I1  nenhum DDL alcanca `agente_funcao_chamadas`",
  !/agente_funcao_chamadas/.test(SEM_TEXTO));
ok("I2  nenhum DDL alcanca a inbox de perguntas",
  !/agente_perguntas_ml/.test(SEM_TEXTO));
ok("I3  nao menciona a 20261008 nem o indice do A7",
  !/20261008|idx_agente_tarefas_polling/.test(SEM_TEXTO));
ok("I3b as unicas tabelas referenciadas sao a nova e as duas FKs",
  [...SEM_TEXTO.matchAll(/public\.([a-z_]+)/g)].every(
    (m) => ["agente_acao_execucoes", "agentes", "lojas"].includes(m[1])),
  [...new Set([...SEM_TEXTO.matchAll(/public\.([a-z_]+)/g)].map((m) => m[1]))].join(","));
ok("I4  nao cria funcao nem RPC", !/create (or replace )?function/i.test(CODIGO));
ok("I5  nao faz DROP nem ALTER de objeto existente",
  !/\bdrop\b|\balter table\b/i.test(CODIGO));

// ─── J. Integridade do repositorio ────────────────────────────────────
secao("J. Migrations existentes intocadas");

const git = (...args: string[]) =>
  execFileSync("git", ["-C", RAIZ, ...args], { encoding: "utf8" });

ok("J1  nenhuma migration rastreada difere do HEAD",
  git("diff", "--name-only", "HEAD", "--", "supabase/migrations/").trim() === "");
{
  const estado = git("status", "--short", "--", "supabase/migrations/")
    .split("\n").map((l) => l.trimEnd()).filter((l) => l !== "");
  ok("J2  o unico path novo sob migrations e o desta frente",
    estado.every((l) => /^\?\? +supabase\/migrations\/20261010_agente_acao_execucoes\.sql$/.test(l)),
    estado.join(" | "));
}
{
  const A7 = "supabase/migrations/20261008_agente_tarefas_polling_perguntas_unica.sql";
  ok("J3  20261008 segue byte-identica ao HEAD",
    git("hash-object", "--", A7).trim() === git("rev-parse", `HEAD:${A7}`).trim());
  const INBOX = "supabase/migrations/20261009_agente_perguntas_ml.sql";
  ok("J4  20261009 segue byte-identica ao HEAD",
    git("hash-object", "--", INBOX).trim() === git("rev-parse", `HEAD:${INBOX}`).trim());
}
ok("J5  zero bytes 0x08 na migration", !SQL.includes(String.fromCharCode(8)));

console.log(`\n── placar ${"─".repeat(54)}`);
console.log(`  PASS ${passou}   FAIL ${falhou}\n`);
if (falhou > 0) process.exitCode = 1;
