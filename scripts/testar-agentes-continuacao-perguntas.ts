/**
 * `agente_perguntas_continuacao` — invariantes ESTRUTURAIS. I4B2.
 *
 * Le o SQL sem comentario e o modulo de dominio sem comentario: um
 * invariante nao pode ser provado pela prosa do arquivo que ele audita.
 * Esta frente ja perdeu tempo com oraculos que casavam com a propria
 * documentacao, inclusive no gate passado.
 *
 * O comportamento contra o Postgres real vive em
 * `scripts/testar-agentes-continuacao-perguntas-banco.ts`.
 *
 * Rodar:  npx tsx scripts/testar-agentes-continuacao-perguntas.ts
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
const semComentario = (rel: string) =>
  ler(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*(--|\/\/).*$/gm, "");

const ARQUIVO = "supabase/migrations/20261011_agente_perguntas_continuacao.sql";
const SQL = ler(ARQUIVO);
const CODIGO = SQL.replace(/^\s*--.*$/gm, "");
const LISO = CODIGO.replace(/\s+/g, " ");

console.log("\n══ CDS IA — continuacao de perguntas: invariantes estruturais ══");

// ─── A. A tabela ──────────────────────────────────────────────────────
secao("A. Tabela e colunas");

ok("A1  cria `public.agente_perguntas_continuacao`",
  /create table public\.agente_perguntas_continuacao \(/i.test(LISO));
ok("A2  SEM `if not exists` — objeto de forma errada falha alto",
  !/create table if not exists/i.test(LISO));

const COLUNAS: ReadonlyArray<readonly [string, string]> = [
  ["agente_id", "uuid not null"],
  ["user_id", "text not null"],
  ["plataforma", "text not null"],
  ["recurso", "text not null"],
  ["loja_id", "uuid null"],
  ["proximo_deslocamento", "integer not null default 0"],
  ["versao", "bigint not null default 1"],
  ["criado_em", "timestamptz not null default now()"],
  ["alterado_em", "timestamptz not null default now()"],
];
for (const [coluna, decl] of COLUNAS) {
  ok(`A3  coluna \`${coluna}\` declarada como esperado`,
    LISO.includes(`${coluna} ${decl}`), decl);
}
ok("A4  nenhuma coluna especulativa alem das 9",
  (CODIGO.slice(CODIGO.indexOf("create table"), CODIGO.indexOf("constraint agente_perguntas_continuacao_pk"))
    .match(/^\s{2}[a-z_]+ /gm) ?? []).length === COLUNAS.length);
ok("A5  NENHUM campo de payload — nem pergunta, nem resposta do provider",
  !/texto|id_externo|anuncio|questions|payload|corpo|resposta/i.test(
    CODIGO.slice(0, CODIGO.indexOf("comment on table"))));

// ─── B. Identidade ────────────────────────────────────────────────────
secao("B. Uma linha por fluxo logico — troca de vinculo REINICIA");

ok("B1  a chave natural e (agente_id, plataforma, recurso)",
  /primary key \(agente_id, plataforma, recurso\)/i.test(LISO));
ok("B2  `loja_id` NAO entra na identidade — cursores rivais nao coexistem",
  !/primary key \([^)]*loja_id/i.test(LISO)
  && !/unique \([^)]*loja_id/i.test(LISO));
ok("B3  a forma espelha `agente_conexoes`, que ja resolve o mesmo problema",
  /primary key \(agente_id, plataforma, recurso\)/i.test(
    ler("supabase/migrations/20260925_agente_conexoes.sql").replace(/\s+/g, " ")));

// ─── C. Cercas de dono ────────────────────────────────────────────────
secao("C. Tenancy fechada no BANCO");

ok("C1  FK composta do agente",
  /foreign key \(agente_id, user_id\) references public\.agentes \(id, user_id\)/i.test(LISO));
ok("C2  FK composta da loja",
  /foreign key \(loja_id, user_id\) references public\.lojas \(id, user_id\)/i.test(LISO));
ok("C3  as duas com RESTRICT nos dois sentidos",
  (LISO.match(/on update restrict on delete restrict/gi) ?? []).length === 2);
ok("C4  nenhuma FK usa `match full` — `loja_id` NULL precisa passar",
  !/match full/i.test(LISO));

// ─── D. O contrato do deslocamento ────────────────────────────────────
secao("D. Deslocamento e o que ele exige");

ok("D1  deslocamento nao negativo", /check \(proximo_deslocamento >= 0\)/i.test(LISO));
ok("D2  deslocamento ADIANTADO exige conta — e o que impede o salto mudo",
  /check \(proximo_deslocamento = 0 or loja_id is not null\)/i.test(LISO));
ok("D3  NAO ha CHECK amarrado ao tamanho da pagina",
  !/% 50|mod\(proximo_deslocamento/i.test(LISO));
ok("D4  o requisito canonico e fechado no banco",
  /check \(plataforma = 'mercado_livre' and recurso = 'perguntas'\)/i.test(LISO));

// ─── E. CAS ───────────────────────────────────────────────────────────
secao("E. Comparacao-e-troca, e por que a versao existe");

ok("E1  ha token de versao, monotonico por contrato",
  /versao bigint not null default 1/i.test(LISO)
  && /check \(versao >= 1\)/i.test(LISO));

{
  const MOD = semComentario("lib/agentes/dados/continuacao-perguntas.ts");
  ok("E2  o modulo e `server-only`", /^import "server-only";$/m.test(MOD));
  ok("E3  toda troca passa por UM `update` condicional",
    (MOD.match(/\.update\(/g) ?? []).length === 1);
  ok("E4  o `where` do CAS confere versao, deslocamento E loja",
    /\.eq\("versao", esperada\.versao\)/.test(MOD)
    && /\.eq\("proximo_deslocamento", esperada\.proximoDeslocamento\)/.test(MOD)
    && /\.is\("loja_id", null\)/.test(MOD)
    && /\.eq\("loja_id", esperada\.lojaId\)/.test(MOD));
  ok("E5  a versao nova sai da versao LIDA, nao de leitura nova",
    /versao: esperada\.versao \+ 1,/.test(MOD));
  ok("E6  zero linha alterada vira `perdida`, nunca sucesso",
    /if \(data === null\) return \{ estado: "perdida" \};/.test(MOD));
  ok("E7  nao ha `select` seguido de `update` incondicional",
    !/\.update\([^)]*\)\s*\.eq\("agente_id"[^;]*;\s*$/m.test(MOD));
  ok("E8  o par (plataforma, recurso) vem do CONTRATO da Funcao",
    /const PLATAFORMA = CONEXAO_PERGUNTAS_ML\.plataforma;/.test(MOD)
    && !/"mercado_livre"/.test(MOD));
  ok("E9  o modulo NAO resolve vinculo — a conta chega pronta",
    !/agente_conexoes|resolverConexoesDoAgente|resolverFatoConexao/.test(MOD));
  ok("E10 nao ha DELETE: o reinicio e UPDATE na MESMA linha",
    !/\.delete\(/.test(MOD));
  ok("E11 as quatro operacoes de escrita sao nomeadas por INTENCAO",
    /export async function iniciarContinuacao/.test(MOD)
    && /export async function avancarContinuacao/.test(MOD)
    && /export async function reiniciarContinuacao/.test(MOD)
    && /export async function reapontarContinuacao/.test(MOD));
}

// ─── F. Seguranca ─────────────────────────────────────────────────────
secao("F. Privilegios de uma tabela MUTAVEL");

for (const papel of ["public", "anon", "authenticated", "service_role"]) {
  ok(`F1  revoke all nominal de \`${papel}\``,
    LISO.includes(`revoke all on table public.agente_perguntas_continuacao from ${papel};`));
}
ok("F2  service_role recebe SELECT, INSERT e UPDATE — e so",
  /grant select, insert, update on table public\.agente_perguntas_continuacao to service_role;/
    .test(LISO));
ok("F3  DELETE e TRUNCATE revogados de service_role",
  /revoke delete, truncate on table public\.agente_perguntas_continuacao from service_role;/
    .test(LISO));
ok("F4  nenhum grant a anon, authenticated ou PUBLIC",
  !/grant [^;]*to (anon|authenticated|public)\b/i.test(LISO));
ok("F5  RLS permanece fora — o padrao congelado do projeto",
  !/enable row level security|create policy/i.test(LISO));

// ─── G. Contencao ─────────────────────────────────────────────────────
secao("G. O que esta migration NAO toca");

const SEM_TEXTO = CODIGO.replace(/'(?:[^']|'')*'/g, "''");
ok("G1  nao alcanca `agente_funcao_chamadas`", !/agente_funcao_chamadas/.test(SEM_TEXTO));
ok("G2  nao alcanca `agente_acao_execucoes`", !/agente_acao_execucoes/.test(SEM_TEXTO));
ok("G3  nao alcanca a inbox", !/agente_perguntas_ml\b/.test(SEM_TEXTO));
ok("G4  as unicas tabelas referenciadas sao a nova e as duas FKs",
  [...SEM_TEXTO.matchAll(/public\.([a-z_]+)/g)].every(
    (m) => ["agente_perguntas_continuacao", "agentes", "lojas"].includes(m[1])),
  [...new Set([...SEM_TEXTO.matchAll(/public\.([a-z_]+)/g)].map((m) => m[1]))].join(","));
ok("G5  nao cria RPC — um `update` condicional ja e atomico",
  !/create (or replace )?function/i.test(CODIGO));
ok("G6  nao faz DROP nem ALTER de objeto existente",
  !/\bdrop\b|\balter table\b/i.test(CODIGO));
ok("G7  nenhum indice especulativo — a PK ja cobre a leitura",
  (LISO.match(/create (unique )?index /gi) ?? []).length === 0);

// ─── H. O servico ─────────────────────────────────────────────────────
secao("H. A fiacao: cursor lido antes, escrito depois");

{
  const SERV = semComentario("lib/agentes/ingestao/sincronizar-perguntas.ts");
  ok("H1  o deslocamento da pagina soma o cursor",
    /deslocamento: deslocamentoInicial \+ deslocamentoDaPagina\(indice\)/.test(SERV));
  ok("H2  o cursor e LIDO antes do laco de paginas",
    SERV.indexOf("portas.lerCursor(") < SERV.indexOf("portas.executar(")
    && SERV.indexOf("portas.lerCursor(") > 0);
  ok("H3  toda escrita de cursor vem DEPOIS da gravacao na inbox",
    SERV.indexOf("portas.gravar(") < SERV.indexOf("portas.iniciarCursor(")
    && SERV.indexOf("portas.gravar(") < SERV.indexOf("portas.avancarCursor(")
    && SERV.indexOf("portas.gravar(") < SERV.indexOf("portas.reiniciarCursor("));
  ok("H4  e ANTES do desfecho da acao",
    SERV.indexOf("portas.avancarCursor(") < SERV.lastIndexOf("portas.fecharAcao("));
  ok("H5  cursor ilegivel falha FECHADO, antes do provider",
    /leituraCursor\.estado === "falhou"\) \{[\s\S]{0,600}?codigo: "cursor_ilegivel"/.test(SERV));
  ok("H6  a deriva de conta reaponta e NAO grava a pagina",
    /portas\.reapontarCursor\(cursor, pagina\.lojaId\)/.test(SERV)
    && SERV.indexOf("portas.reapontarCursor(") < SERV.indexOf("portas.gravar("));
  ok("H7  teto de paginas e orcamento avancam o cursor IGUAL",
    /const janelaConsumida = coletadas\.length \* PAGE_LIMIT;/.test(SERV)
    && !/orcamentoEsgotado \?[^:]*avancarCursor/.test(SERV));
  ok("H8  a janela consumida vem do contrato BRUTO de paginacao",
    /coletadas\.length \* PAGE_LIMIT/.test(SERV)
    && !/aptas\.length \* PAGE_LIMIT|normalizadas \* PAGE_LIMIT/.test(SERV));
  ok("H9  fim de lista REINICIA em vez de avancar",
    /portas\.reiniciarCursor\(cursor, lojaCongelada\)/.test(SERV));
  ok("H10 o chamador nao escolhe deslocamento em lugar nenhum",
    !/entrada\.deslocamento|entrada\.offset|entrada\.cursor/.test(SERV));
}

// ─── I. Integridade do repositorio ────────────────────────────────────
secao("I. Migrations existentes intocadas");

const git = (...args: string[]) =>
  execFileSync("git", ["-C", RAIZ, ...args], { encoding: "utf8" });

{
  const MINHA = "supabase/migrations/20261011_agente_perguntas_continuacao.sql";
  const mudadas = git("diff", "--name-only", "HEAD", "--", "supabase/migrations/")
    .split("\n").map((l) => l.trim()).filter((l) => l !== "");
  ok("I1  nenhuma migration ALHEIA difere do HEAD",
    mudadas.every((l) => l === MINHA), mudadas.join(" | "));
}
{
  const estado = git("status", "--short", "--", "supabase/migrations/")
    .split("\n").map((l) => l.trimEnd()).filter((l) => l !== "");
  ok("I2  nenhum path estranho sob migrations",
    estado.every((l) => /supabase\/migrations\/\d{8}_[a-z0-9_]+\.sql$/.test(l)),
    estado.join(" | "));
}
for (const [rotulo, caminho] of [
  ["20261008", "supabase/migrations/20261008_agente_tarefas_polling_perguntas_unica.sql"],
  ["20261009", "supabase/migrations/20261009_agente_perguntas_ml.sql"],
  ["20261010", "supabase/migrations/20261010_agente_acao_execucoes.sql"],
] as const) {
  ok(`I3  ${rotulo} segue byte-identica ao HEAD`,
    git("hash-object", "--", caminho).trim() === git("rev-parse", `HEAD:${caminho}`).trim());
}
ok("I4  zero bytes 0x08 na migration", !SQL.includes(String.fromCharCode(8)));
ok("I5  zero bytes 0x08 no modulo de dominio",
  !ler("lib/agentes/dados/continuacao-perguntas.ts").includes(String.fromCharCode(8)));

console.log(`\n── placar ${"─".repeat(54)}`);
console.log(`  PASS ${passou}   FAIL ${falhou}\n`);
if (falhou > 0) process.exitCode = 1;
