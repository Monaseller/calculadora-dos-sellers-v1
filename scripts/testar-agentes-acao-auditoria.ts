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
ok("D2  seis estados, incluindo `parcial` e `aguardando_aprovacao`",
  /status in \( 'executando', 'sucesso', 'parcial', 'aguardando_aprovacao', 'negado', 'erro'\)/
    .test(LISO));
ok("D3  bicondicional: abertura sse executando",
  /\(fase = 'abertura'\) = \(status = 'executando'\)/.test(LISO));
ok("D4  abertura EXIGE chave de tentativa",
  /fase = 'desfecho' or idempotency_key is not null/.test(LISO));
ok("D5  abertura nao tem latencia; desfecho aceita nao negativa",
  /\(fase = 'abertura' and latencia_ms is null\) or \(fase = 'desfecho' and \(latencia_ms is null or latencia_ms >= 0\)\)/
    .test(LISO));

// ─── E. Vocabulario de desfecho ───────────────────────────────
secao("E. Vocabulario FECHADO, e capaz de dizer a verdade");

/**
 * O mapa que a migration DEVE implementar, derivado do union real de
 * `ResultadoSincronizacao` — nao de uma lista imaginada.
 */
const MAPA: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["executando", []],
  ["sucesso", []],
  ["parcial", ["backlog_truncado", "descartes_na_varredura"]],
  ["aguardando_aprovacao", ["aprovacao_necessaria"]],
  ["negado", [
    "funcao_inexistente", "permissao_ausente",
    "permissao_bloqueada", "conexao_ausente",
  ]],
  ["erro", [
    "provedor_falhou", "contrato_violado",
    "autoridade_divergente", "autoridade_indisponivel",
    "persistencia_negada", "persistencia_recusada", "persistencia_falhou",
    "auditoria_funcao_falhou", "erro_interno",
  ]],
];

/**
 * Le os ramos do `case` do SQL — o texto EXECUTAVEL, nunca o comentario.
 *
 * O veredito nao pode sair de `LISO.includes("'x'")`: um codigo citado
 * num `comment on column` passaria por essa peneira sem nunca estar no
 * CHECK. Aqui o ramo e recortado do proprio `case`.
 */
function ramosDoCase(): Map<string, string[]> {
  const abre = LISO.indexOf(
    "constraint agente_acao_execucoes_codigo_por_status check ( case status");
  const fecha = LISO.indexOf(" end )", abre);
  const corpo = abre < 0 || fecha < 0 ? "" : LISO.slice(abre, fecha);
  const ramos = new Map<string, string[]>();
  for (const m of corpo.matchAll(/when '([a-z_]+)' then ([^]*?)(?=when '|$)/g)) {
    const arm = m[2];
    ramos.set(m[1], /is null/.test(arm)
      ? []
      : [...arm.matchAll(/'([a-z_]+)'/g)].map((c) => c[1]));
  }
  return ramos;
}
const RAMOS = ramosDoCase();

ok("E1  ha exatamente um ramo por status, e nada alem",
  RAMOS.size === MAPA.length && MAPA.every(([s]) => RAMOS.has(s)),
  [...RAMOS.keys()].join(","));

for (const [status, esperados] of MAPA) {
  const lidos = RAMOS.get(status) ?? ["<ausente>"];
  ok(`E2  \`${status}\` aceita exatamente ${esperados.length === 0 ? "NENHUM codigo" : esperados.join(", ")}`,
    lidos.length === esperados.length && esperados.every((c, i) => lidos[i] === c),
    lidos.join(","));
}

ok("E3  `executando` e `sucesso` exigem codigo NULO",
  /when 'executando' then codigo_desfecho is null/.test(LISO)
  && /when 'sucesso' then codigo_desfecho is null/.test(LISO));

{
  // Um codigo pertence a UM status. Sem isto, `permissao_ausente` sob
  // `erro` passaria despercebido e a leitura do ledger viraria adivinhacao.
  const dono = new Map<string, string>();
  let colisao = "";
  for (const [status, codigos] of RAMOS) {
    for (const c of codigos) {
      if (dono.has(c)) colisao = `${c}: ${dono.get(c)} e ${status}`;
      dono.set(c, status);
    }
  }
  ok("E4  nenhum codigo pertence a dois status", colisao === "", colisao);

  // O CHECK e um `case` sobre `status`: um codigo do ramo errado e
  // recusado pelo BANCO, e nao por convencao. A prova de runtime esta em
  // `testar-agentes-acao-auditoria-banco.ts` (secao X).
  ok("E5  o vocabulario inteiro cabe no `case`, sem lista paralela",
    [...dono.keys()].length === MAPA.reduce((n, [, c]) => n + c.length, 0));
}

ok("E6  `backlog_truncado` cai em `parcial`, nunca em `sucesso`",
  (RAMOS.get("parcial") ?? []).includes("backlog_truncado")
  && (RAMOS.get("sucesso") ?? []).length === 0);

{
  // CHECK aceita TRUE e NULL. Sem `is not null` explicito, um desfecho
  // de `erro` com codigo nulo passaria — e o teste de banco (secao V)
  // prova que a guarda funciona de verdade.
  const comGuarda = ["parcial", "aguardando_aprovacao", "negado", "erro"];
  const corpo = LISO.slice(
    LISO.indexOf("constraint agente_acao_execucoes_codigo_por_status"),
    LISO.indexOf(" end )", LISO.indexOf("constraint agente_acao_execucoes_codigo_por_status")));
  const faltando = comGuarda.filter((s) => {
    const i = corpo.indexOf(`when '${s}' then `);
    return i < 0 || !corpo.slice(i, i + 60).includes("codigo_desfecho is not null");
  });
  ok("E13 todo status com codigo EXIGE codigo nao nulo",
    faltando.length === 0, faltando.join(","));
}

ok("E7  nao existe codigo generico de reserva",
  !/'outro'|'desconhecido'|'generico'|'indefinido'/.test(LISO));

for (const ausente of ["agente_indisponivel", "ja_processado", "aprovacao_indisponivel"]) {
  // Os tres sao desfechos que o servico NAO pode produzir com a acao ja
  // aberta — ver o bloco de comentario da constraint. Um deles no
  // vocabulario seria codigo morto convidando a mapeamento errado.
  ok(`E8  \`${ausente}\` nao e codigo de desfecho`,
    ![...RAMOS.values()].flat().includes(ausente));
}

{
  // Os codigos ingleses da primeira versao deste arquivo. A migration
  // nunca foi aplicada, entao a correcao foi feita nela mesma.
  const INGLES = ["permission_denied", "provider_error", "persistence_error",
    "authority_drift", "internal_error"];
  const achados = INGLES.filter((c) => LISO.includes(`'${c}'`));
  ok("E9  nenhum codigo em ingles sobrou", achados.length === 0, achados.join(","));
}

{
  // ── O vinculo com o guard, lido da FONTE ──────────────────────────
  //
  // `CODIGOS_NEGACAO` e contrato: o docblock dele diz que renomear um
  // deles e mudanca de contrato, nao refatoracao. Se a lista de la
  // mudar e esta nao, este invariante reprova — que e exatamente o
  // ponto de nao redigitar vocabulario alheio.
  const GUARD = ler("lib/agentes/funcoes/guard.ts");
  const bloco = GUARD.slice(GUARD.indexOf("export const CODIGOS_NEGACAO = ["));
  const doGuard = [...bloco.slice(0, bloco.indexOf("]")).matchAll(/"([a-z_]+)"/g)]
    .map((m) => m[1]);
  const terminais = doGuard.filter((c) => c !== "aprovacao_necessaria");

  ok("E10 o guard publica cinco codigos de negacao", doGuard.length === 5, doGuard.join(","));
  ok("E11 `negado` adota EXATAMENTE `CodigoNegacaoTerminal`",
    (RAMOS.get("negado") ?? []).length === terminais.length
    && terminais.every((c) => (RAMOS.get("negado") ?? []).includes(c)),
    terminais.join(","));
  ok("E12 `aprovacao_necessaria` saiu de `negado` e virou status proprio",
    !(RAMOS.get("negado") ?? []).includes("aprovacao_necessaria")
    && (RAMOS.get("aguardando_aprovacao") ?? []).includes("aprovacao_necessaria"));
}

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

{
  // A unica migration que esta frente pode alterar e a DELA — e ela so
  // pode ser alterada porque nunca foi aplicada nem publicada. O
  // invariante nao e "nada mudou": e "nada ALHEIO mudou".
  const MINHA = "supabase/migrations/20261010_agente_acao_execucoes.sql";
  const mudadas = git("diff", "--name-only", "HEAD", "--", "supabase/migrations/")
    .split("\n").map((l) => l.trim()).filter((l) => l !== "");
  ok("J1  nenhuma migration ALHEIA difere do HEAD",
    mudadas.every((l) => l === MINHA), mudadas.join(" | "));
}
{
  // Path estranho e o sinal que importa entre gates: arquivo fora da
  // convencao `AAAAMMDD_nome.sql` sob `migrations/` nao veio de gate
  // nenhum. Migration nova de gate em curso e esperada.
  const estado = git("status", "--short", "--", "supabase/migrations/")
    .split("\n").map((l) => l.trimEnd()).filter((l) => l !== "");
  ok("J2  nenhum path estranho sob migrations",
    estado.every((l) => /supabase\/migrations\/\d{8}_[a-z0-9_]+\.sql$/.test(l)),
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

// --- K. Cobertura do desfecho -----------------------------------------
secao("K. Todo desfecho que o servico produz cabe no vocabulario");

/**
 * As variantes que `sincronizarPerguntas` pode devolver, lidas da FONTE.
 *
 * Nao e lista redigitada: o union e recortado do arquivo do servico e os
 * `tipo:` sao extraidos dele. Variante nova la reprova aqui — que e o
 * unico jeito de a cobertura nao envelhecer sozinha.
 */
function variantesDoServico(): string[] {
  const SRC = ler("lib/agentes/ingestao/sincronizar-perguntas.ts");
  const abre = SRC.indexOf("export type ResultadoSincronizacao =");
  const fim = SRC.indexOf('readonly tipo: "indisponivel"', abre);
  const corpo = abre < 0 || fim < 0 ? "" : SRC.slice(abre, SRC.indexOf("\n\n", fim));
  return [...new Set([...corpo.matchAll(/readonly tipo: "([a-z_]+)"/g)].map((m) => m[1]))];
}

/**
 * O mapa de desfecho. Uma linha por variante do servico.
 *
 * `null` significa "nao produz linha de desfecho" — e so
 * `agente_indisponivel` tem esse direito, porque os tres motivos dela
 * acontecem ANTES de a abertura existir.
 */
const MATRIZ: ReadonlyArray<readonly [string, readonly [string, string | null] | null]> = [
  ["sincronizado", ["sucesso", null]],
  ["backlog_truncado", ["parcial", "backlog_truncado"]],
  ["autoridade_divergente", ["erro", "autoridade_divergente"]],
  ["persistencia_recusada", ["erro", "persistencia_recusada"]],
  ["agente_indisponivel", null],
  ["negado", ["negado", "permissao_ausente"]],
  ["aguardando_aprovacao", ["aguardando_aprovacao", "aprovacao_necessaria"]],
  ["erro", ["erro", "provedor_falhou"]],
  ["ja_processado", ["erro", "erro_interno"]],
  ["indisponivel", ["erro", "autoridade_indisponivel"]],
];

{
  const doServico = variantesDoServico();
  const naMatriz = MATRIZ.map(([v]) => v);
  ok("K1  o union do servico foi lido da fonte", doServico.length === 10, doServico.join(","));
  ok("K2  toda variante do servico esta na matriz",
    doServico.every((v) => naMatriz.includes(v)),
    doServico.filter((v) => !naMatriz.includes(v)).join(","));
  ok("K3  a matriz nao inventa variante que o servico nao produz",
    naMatriz.every((v) => doServico.includes(v)),
    naMatriz.filter((v) => !doServico.includes(v)).join(","));
}

for (const [variante, destino] of MATRIZ) {
  if (destino === null) {
    ok(`K4  \`${variante}\` nao produz desfecho — e so ela tem esse direito`,
      variante === "agente_indisponivel");
    continue;
  }
  const [status, codigo] = destino;
  const aceitos = RAMOS.get(status) ?? null;
  ok(`K5  \`${variante}\` -> ${status}/${codigo ?? "NULL"} e aceito pelo CHECK`,
    aceitos !== null && (codigo === null ? aceitos.length === 0 : aceitos.includes(codigo)),
    aceitos === null ? "status ausente do case" : aceitos.join(","));
}

{
  // Todo codigo do vocabulario precisa de um caminho que o produza. A
  // matriz cita um representante por variante; os demais codigos sao
  // ramos INTERNOS da mesma variante (`erro` carrega nove causas), e a
  // prova de que nenhum e orfao e o mapa de origem abaixo.
  const ORIGEM: Readonly<Record<string, string>> = {
    backlog_truncado: "backlog_truncado",
    descartes_na_varredura: "sincronizado com descartes ou status inesperados",
    aprovacao_necessaria: "aguardando_aprovacao",
    funcao_inexistente: "negado",
    permissao_ausente: "negado",
    permissao_bloqueada: "negado",
    conexao_ausente: "negado",
    provedor_falhou: "erro: codigo do provider, ou executor_falhou",
    contrato_violado: "erro: resposta_fora_de_forma, saida_invalida, autoridade_ausente",
    autoridade_divergente: "autoridade_divergente",
    autoridade_indisponivel: "indisponivel",
    persistencia_negada: "persistencia_recusada com 42501",
    persistencia_recusada: "persistencia_recusada com 22023 ou 25000",
    persistencia_falhou: "erro: falha_rpc",
    auditoria_funcao_falhou: "erro: falha_auditoria",
    erro_interno: "erro: erro_interno, e o invariante quebrado de ja_processado",
  };
  const todos = [...RAMOS.values()].flat();
  ok("K6  todo codigo do CHECK tem origem declarada",
    todos.every((c) => c in ORIGEM),
    todos.filter((c) => !(c in ORIGEM)).join(","));
  ok("K7  nenhuma origem aponta para codigo que nao existe no CHECK",
    Object.keys(ORIGEM).every((c) => todos.includes(c)),
    Object.keys(ORIGEM).filter((c) => !todos.includes(c)).join(","));
}

{
  // O executor tem SETE variantes. Uma oitava mudaria o que o servico
  // pode receber, e portanto o que a auditoria precisa saber dizer.
  const EXEC = ler("lib/agentes/execucao-funcoes/executar.ts");
  const abre = EXEC.indexOf("export type ResultadoExecucaoFuncao =");
  const corpo = EXEC.slice(abre, EXEC.indexOf("/** O sub-tipo", abre));
  const tipos = [...new Set([...corpo.matchAll(/tipo: "([a-z_]+)"/g)].map((m) => m[1]))];
  ok("K8  o executor publica exatamente sete variantes", tipos.length === 7, tipos.join(","));
  ok("K9  `aguardando_aprovacao` e uma delas — logo, alcancavel",
    tipos.includes("aguardando_aprovacao"));
}

{
  // `nivel = 'aprovacao'` nao tem recorte por Funcao nem por acesso: o
  // CHECK da migration de permissoes aceita os tres niveis para
  // QUALQUER `funcao_id`. E por isso que `aguardando_aprovacao` e
  // alcancavel para uma Funcao de LEITURA, e nao so em teoria.
  const PERM = ler("supabase/migrations/20260920_agente_permissoes.sql");
  ok("K10 o banco aceita nivel `aprovacao` para qualquer Funcao",
    /check \(nivel in \('bloqueado','aprovacao','automatico'\)\)/.test(PERM));
  const GUARD = ler("lib/agentes/funcoes/guard.ts");
  ok("K11 o guard pausa em `aprovacao` sem olhar acesso nem id",
    /if \(permissao\.nivel === "aprovacao"\) \{/.test(GUARD));
}

console.log(`\n── placar ${"─".repeat(54)}`);
console.log(`  PASS ${passou}   FAIL ${falhou}\n`);
if (falhou > 0) process.exitCode = 1;
