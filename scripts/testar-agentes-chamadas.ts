/**
 * CDS IA — TOOL-CALL-B. Suite da fundacao de Tool Call.
 *
 * Duas naturezas de prova, deliberadamente separadas:
 *
 *   contrato.ts   e PURO, entao roda DE VERDADE. Todo assert de
 *                 envelope executa o validador com um objeto real.
 *   registro.ts   e `server-only` e a migration e SQL. Os dois sao
 *                 auditados por ESTRUTURA — nunca por comentario: cada
 *                 sonda mira o codigo com comentarios removidos, para
 *                 que a promessa escrita num docblock nunca satisfaca
 *                 um teste sozinha.
 *
 * Rodar:  npx tsx scripts/testar-agentes-chamadas.ts
 * Sem rede, sem banco, sem IA, sem escrita.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { EntradaDesfechoSemExecucao } from "../lib/agentes/chamadas/registro";
import {
  CODIGOS_EXECUCAO,
  CODIGOS_NEGACAO,
  CODIGOS_NEGACAO_TERMINAL,
  FASES_CHAMADA,
  LIMITE_EXECUTION_ID,
  STATUS_CHAMADA,
  STATUS_TERMINAIS,
  VERSAO_CONTRATO,
  codigoValidoParaStatus,
  envelopeDeSucesso,
  envelopeValido,
  faseDoStatus,
} from "../lib/agentes/chamadas/contrato";

let passou = 0;
let falhou = 0;

function ok(nome: string, condicao: boolean, detalhe = ""): void {
  if (condicao) {
    passou++;
  } else {
    falhou++;
    console.error(`  x ${nome}${detalhe ? `  · ${detalhe}` : ""}`);
  }
}

function secao(titulo: string): void {
  console.log(`\n── ${titulo}`);
}

const RAIZ = join(__dirname, "..");
const fonte = (rel: string) => readFileSync(join(RAIZ, rel), "utf8");
const semComentarios = (t: string) =>
  t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const MIGRATION = fonte("supabase/migrations/20260927_agente_funcao_chamadas.sql");
// SQL EFETIVO: comentario fora, inclusive indentado. As sondas de
// vocabulario proibido (`erro_codigo`, `token`, `n8n_*`) olham o que o
// banco vai executar — a prosa que EXPLICA por que aquilo NAO entra cita
// os termos, e acusa-la seria acusar a documentacao da propria regra.
const SQL = MIGRATION.replace(/^[ \t]*--[^\n]*$/gm, "");
const REGISTRO = fonte("lib/agentes/chamadas/registro.ts");
const REGISTRO_CODIGO = semComentarios(REGISTRO);
const CONTRATO = fonte("lib/agentes/chamadas/contrato.ts");
const CONTRATO_CODIGO = semComentarios(CONTRATO);

// ─── A. Tripwire da pasta nova ────────────────────────────────────────

secao("A. A pasta nova tem exatamente os modulos autorizados");
{
  const AUTORIZADOS = ["contrato.ts", "registro.ts"];
  const noDisco = readdirSync(join(RAIZ, "lib/agentes/chamadas")).sort();

  ok("A1  lib/agentes/chamadas com o conjunto exato de 2 modulos",
    JSON.stringify(noDisco) === JSON.stringify(AUTORIZADOS), noDisco.join(", "));

  // Igualdade, nunca subconjunto. Um `executar.ts` aparecendo aqui sem
  // gate proprio significa que o executor nasceu dentro do modulo de
  // auditoria — exatamente o que a separacao existe para impedir.
  ok("A1b controle: um arquivo EXTRA reprovaria",
    JSON.stringify([...AUTORIZADOS, "executar.ts"].sort()) !== JSON.stringify(AUTORIZADOS));
  ok("A1c controle: um arquivo AUSENTE reprovaria",
    JSON.stringify(["contrato.ts"]) !== JSON.stringify(AUTORIZADOS));
}

// ─── B. Vocabulario ───────────────────────────────────────────────────

secao("B. Fases, status e codigos");
{
  ok("B1  duas fases, exatamente",
    JSON.stringify([...FASES_CHAMADA]) === JSON.stringify(["abertura", "desfecho"]));

  ok("B2  cinco status, exatamente",
    JSON.stringify([...STATUS_CHAMADA]) ===
      JSON.stringify(["executando", "sucesso", "erro", "negado", "aguardando_aprovacao"]));

  // Os nomes que a auditoria descartou. `requested`/`authorized`/
  // `running` seriam a maquina de `agente_tarefas` copiada; `failed` e
  // `cancelled` seriam sinonimos de coisas que ja existem ou de quem
  // nao existe.
  ok("B3  nenhum status inventado ou sinonimo",
    !(["requested", "authorized", "running", "failed", "cancelled"] as string[]).some((s) =>
      (STATUS_CHAMADA as readonly string[]).includes(s)));

  ok("B4  quatro status terminais — so `executando` nao encerra",
    JSON.stringify(STATUS_TERMINAIS) ===
      JSON.stringify(["sucesso", "erro", "negado", "aguardando_aprovacao"]));

  ok("B5  a fase e DERIVADA do status, nunca escolhida a parte",
    faseDoStatus("executando") === "abertura" &&
      STATUS_TERMINAIS.every((s) => faseDoStatus(s) === "desfecho"));

  ok("B6  os cinco codigos de execucao, exatamente",
    JSON.stringify([...CODIGOS_EXECUCAO]) ===
      JSON.stringify([
        "entrada_invalida",
        "executor_falhou",
        "saida_invalida",
        "timeout",
        "erro_interno",
      ]));

  // Os codigos do executor externo NAO existem ainda: nao ha executor
  // externo que os produza, e categoria sem produtor e categoria que
  // ninguem sabe quando usar.
  ok("B7  nenhum codigo do futuro executor externo",
    !(["http_error", "network_error", "settings_drift", "credential_error", "retry_exhausted"] as string[])
      .some((c) => (CODIGOS_EXECUCAO as readonly string[]).includes(c)));
}

secao("B2. Os codigos de negacao sao REUTILIZADOS, nao recopiados");
{
  ok("B8  os cinco codigos canonicos do guard",
    JSON.stringify([...CODIGOS_NEGACAO]) ===
      JSON.stringify([
        "funcao_inexistente",
        "permissao_ausente",
        "permissao_bloqueada",
        "aprovacao_necessaria",
        "conexao_ausente",
      ]));

  // A prova de que nao ha segunda taxonomia: o contrato IMPORTA do
  // guard. Se alguem recopiar a uniao aqui, este assert cai.
  ok("B9  contrato.ts importa CODIGOS_NEGACAO do guard",
    /import\s*\{[^}]*CODIGOS_NEGACAO[^}]*\}\s*from\s*"@\/lib\/agentes\/funcoes\/guard"/
      .test(CONTRATO_CODIGO));
  ok("B10 e NAO declara a propria lista de negacao",
    !/const\s+CODIGOS_NEGACAO\s*=/.test(CONTRATO_CODIGO));

  // `aprovacao_necessaria` e exclusivo de `aguardando_aprovacao`:
  // `negado` significa "nada muda isso sozinho" e a espera significa
  // "alguem pode aprovar". Colapsar os dois apagaria a diferenca.
  // `CODIGOS_NEGACAO_TERMINAL` ja e a lista filtrada, entao o proprio
  // tipo dela nao admite o valor removido — a comparacao precisa ser
  // sobre `string[]` para poder ser feita.
  ok("B11 `aprovacao_necessaria` sai da lista de negacao terminal",
    !(CODIGOS_NEGACAO_TERMINAL as readonly string[]).includes("aprovacao_necessaria") &&
      CODIGOS_NEGACAO_TERMINAL.length === 4);
}

secao("B3. Codigo pertence ao status, nao a 'qualquer desfecho'");
{
  ok("B12 executando e sucesso nao carregam codigo",
    codigoValidoParaStatus("executando", null) &&
      codigoValidoParaStatus("sucesso", null) &&
      !codigoValidoParaStatus("sucesso", "timeout"));

  ok("B13 aguardando_aprovacao exige exatamente aprovacao_necessaria",
    codigoValidoParaStatus("aguardando_aprovacao", "aprovacao_necessaria") &&
      !codigoValidoParaStatus("aguardando_aprovacao", "permissao_ausente") &&
      !codigoValidoParaStatus("aguardando_aprovacao", null));

  ok("B14 negado aceita as quatro negacoes terminais, e NAO a aprovacao",
    CODIGOS_NEGACAO_TERMINAL.every((c) => codigoValidoParaStatus("negado", c)) &&
      !codigoValidoParaStatus("negado", "aprovacao_necessaria"));

  ok("B15 erro aceita so os cinco de execucao",
    CODIGOS_EXECUCAO.every((c) => codigoValidoParaStatus("erro", c)) &&
      !codigoValidoParaStatus("erro", "permissao_bloqueada"));
}

// ─── C. Envelope ──────────────────────────────────────────────────────

const SUCESSO = { contrato: 1, ok: true, request_id: "req-1", data: { total: 3 } };
const ERRO = {
  contrato: 1,
  ok: false,
  request_id: "req-1",
  error: { code: "executor_falhou", message: "falhou", retryable: false },
};

secao("C. Envelope valido");
{
  ok("C1  sucesso minimo passa", envelopeValido(SUCESSO));
  ok("C2  erro minimo passa", envelopeValido(ERRO));
  ok("C3  execution_id opcional e aceito",
    envelopeValido({ ...SUCESSO, execution_id: "exec-42" }));
  ok("C4  data null e resposta, nao ausencia",
    envelopeValido({ ...SUCESSO, data: null }));
  ok("C5  envelopeDeSucesso distingue os dois ramos",
    envelopeDeSucesso(SUCESSO) && !envelopeDeSucesso(ERRO));
  ok("C6  a versao do contrato e 1", VERSAO_CONTRATO === 1);
}

secao("C2. Envelope recusado");
{
  ok("C7  contrato ausente reprova", !envelopeValido({ ...SUCESSO, contrato: undefined }));
  ok("C8  contrato errado reprova", !envelopeValido({ ...SUCESSO, contrato: 2 }));
  // Numero, nao string: `"1"` passaria num `==` e viraria compatibilidade
  // acidental com um produtor que serializa tudo como texto.
  ok("C9  contrato como string reprova", !envelopeValido({ ...SUCESSO, contrato: "1" }));

  ok("C10 request_id vazio reprova", !envelopeValido({ ...SUCESSO, request_id: "" }));
  ok("C11 request_id so com espaco reprova", !envelopeValido({ ...SUCESSO, request_id: "   " }));
  ok("C12 request_id ausente reprova", !envelopeValido({ contrato: 1, ok: true, data: 1 }));

  ok("C13 ok nao-boolean reprova", !envelopeValido({ ...SUCESSO, ok: "true" }));

  // Shape hibrido: o executor respondeu duas coisas ao mesmo tempo.
  // Aceitar o ramo "que parece certo" seria escolher em qual metade
  // acreditar, e o palpite ficaria gravado como fato.
  ok("C14 ok=true com error reprova",
    !envelopeValido({ ...SUCESSO, error: { code: "x", message: "y", retryable: false } }));
  ok("C15 ok=false com data reprova", !envelopeValido({ ...ERRO, data: 1 }));

  ok("C16 sucesso sem data reprova",
    !envelopeValido({ contrato: 1, ok: true, request_id: "req-1" }));
  ok("C17 erro sem error reprova",
    !envelopeValido({ contrato: 1, ok: false, request_id: "req-1" }));
  ok("C18 error sem code reprova",
    !envelopeValido({ ...ERRO, error: { message: "y", retryable: false } }));
  ok("C19 error sem message reprova",
    !envelopeValido({ ...ERRO, error: { code: "x", retryable: false } }));
  ok("C20 error sem retryable reprova",
    !envelopeValido({ ...ERRO, error: { code: "x", message: "y" } }));

  // `"false"` e truthy. Um retry decidido por essa string repetiria uma
  // escrita externa — o acidente exato que o contrato existe para
  // impedir.
  ok("C21 retryable como string reprova",
    !envelopeValido({ ...ERRO, error: { code: "x", message: "y", retryable: "false" } }));

  ok("C22 execution_id vazio reprova", !envelopeValido({ ...SUCESSO, execution_id: "" }));
  ok("C23 execution_id nao-string reprova", !envelopeValido({ ...SUCESSO, execution_id: 42 }));
  ok("C24 execution_id longo demais reprova",
    !envelopeValido({ ...SUCESSO, execution_id: "e".repeat(LIMITE_EXECUTION_ID + 1) }));

  ok("C25 nao-objeto reprova",
    [null, undefined, 42, "texto", true, [SUCESSO]].every((v) => !envelopeValido(v)));

  // `Request`/`Headers`/`Map` nao tem propriedades proprias enumeraveis
  // e sairiam vazios por acidente. Recusar na porta transforma o atalho
  // ("passa a resposta inteira") em recusa explicita.
  ok("C26 instancia de classe reprova",
    !envelopeValido(new Map()) && !envelopeValido(new Date()));
}

// ─── D. Migration: modelo append-only ─────────────────────────────────

secao("D. A migration impoe append-only por PRIVILEGIO");
{
  ok("D1  service_role recebe somente SELECT e INSERT",
    /grant\s+select,\s*insert\s+on\s+public\.agente_funcao_chamadas\s+to\s+service_role/i.test(SQL));
  ok("D2  e perde UPDATE, DELETE e TRUNCATE",
    /revoke\s+update,\s*delete,\s*truncate\s+on\s+public\.agente_funcao_chamadas\s+from\s+service_role/i
      .test(SQL));
  ok("D3  service_role NAO recebe update/delete em nenhum grant",
    !/grant[^;]*\b(update|delete|truncate)\b[^;]*agente_funcao_chamadas/i.test(SQL));

  // Os tres REVOKE separados: `REVOKE FROM PUBLIC` nao cobre privilegio
  // herdado por anon/authenticated via ALTER DEFAULT PRIVILEGES. Foi a
  // causa do bug SEC1.
  ok("D4  revoke explicito de public, anon e authenticated",
    ["public", "anon", "authenticated"].every((papel) =>
      new RegExp(`revoke\\s+all\\s+on\\s+public\\.agente_funcao_chamadas\\s+from\\s+${papel}`, "i")
        .test(SQL)));

  ok("D5  nenhuma RLS habilitada", !/enable\s+row\s+level\s+security/i.test(SQL));
  ok("D6  nenhuma policy", !/create\s+policy/i.test(SQL));
  ok("D7  nenhuma RPC", !/create\s+(or\s+replace\s+)?function/i.test(SQL));
  ok("D8  nenhum trigger", !/create\s+trigger/i.test(SQL));
  ok("D9  nenhum SECURITY DEFINER", !/security\s+definer/i.test(SQL));
}

secao("D2. Colunas: o que entra e o que fica de fora");
{
  const COLUNAS = [
    "id", "user_id", "agente_id", "funcao_id", "tarefa_id", "request_id",
    "fase", "status", "codigo_desfecho", "mensagem_desfecho", "idempotency_key",
    "acesso", "nivel_no_momento", "plataforma", "recurso", "loja_id",
    "entrada_resumo", "latencia_ms", "criado_em",
  ];
  ok("D10 as 19 colunas previstas existem",
    COLUNAS.every((c) => new RegExp(`^\\s{2}${c}\\s`, "m").test(SQL)),
    COLUNAS.filter((c) => !new RegExp(`^\\s{2}${c}\\s`, "m").test(SQL)).join(", "));

  ok("D11 `codigo_desfecho`, e nunca `erro_codigo`",
    /codigo_desfecho/.test(SQL) && !/\berro_codigo\b/.test(SQL));
  ok("D12 `mensagem_desfecho`, e nunca `erro_mensagem`",
    /mensagem_desfecho/.test(SQL) && !/\berro_mensagem\b/.test(SQL));

  // Coluna sem produtor e espelho que envelhece sozinho. O executor
  // externo nao existe neste gate.
  ok("D13 nenhuma coluna n8n_*", !/\bn8n_\w+/.test(SQL));
  ok("D14 sem modo_execucao, tentativa ou origem_request_id",
    !/\bmodo_execucao\b|\borigem_request_id\b/.test(SQL) &&
      !/^\s{2}tentativa\s/m.test(SQL));

  // Saida crua nunca e persistida: ela e a superficie por onde dado de
  // pedido e mensagem de terceiro entrariam na tabela.
  ok("D15 nenhuma coluna de saida/resultado/response",
    !/^\s{2}(saida|resultado|response|payload)\s/m.test(SQL));
  ok("D16 `finalizado_em` nao existe — o criado_em do desfecho JA e a hora",
    !/\bfinalizado_em\b/.test(SQL));
  // A sonda mira DECLARACAO DE COLUNA, e nao o texto do arquivo: o
  // `comment on table` declara em prosa que credencial e token NAO sao
  // guardados, e uma sonda de arquivo inteiro acusaria justamente a
  // frase que promete o contrario do que ela procura.
  const SEGREDO = "token|credential|credencial|authorization|cookie|api_key|secret|seller_id";
  const colunaDeSegredo = new RegExp(`^\\s{2}(${SEGREDO})\\s`, "mi");
  ok("D17 nenhuma COLUNA de credencial", !colunaDeSegredo.test(SQL));
  ok("D17b controle: a sonda acharia uma coluna assim",
    colunaDeSegredo.test("  token             text        null,"));
}

secao("D3. Constraints que sustentam o modelo");
{
  ok("D18 fase e status sao bicondicionais",
    /\(fase\s*=\s*'abertura'\)\s*=\s*\(status\s*=\s*'executando'\)/i.test(SQL));

  ok("D19 UNIQUE (user_id, request_id, fase)",
    /unique\s*\(\s*user_id,\s*request_id,\s*fase\s*\)/i.test(SQL));
  ok("D20 e NAO ha unique global de request_id",
    !/unique\s*\(\s*request_id\s*\)/i.test(SQL));

  ok("D21 unique parcial de idempotencia, so em abertura e so com chave",
    /create\s+unique\s+index[\s\S]*?\(user_id,\s*funcao_id,\s*idempotency_key\)[\s\S]*?where\s+fase\s*=\s*'abertura'\s+and\s+idempotency_key\s+is\s+not\s+null/i
      .test(SQL));

  ok("D22 idempotency_key so existe na abertura",
    /fase\s*=\s*'abertura'\s+or\s+idempotency_key\s+is\s+null/i.test(SQL));
  ok("D23 e e obrigatoria quando a Funcao escreve",
    /fase\s*<>\s*'abertura'\s+or\s+acesso\s*<>\s*'escrita'\s+or\s+idempotency_key\s+is\s+not\s+null/i
      .test(SQL));

  ok("D24 o codigo e amarrado ao status por CASE, nao por 'nao nulo'",
    /case\s+status[\s\S]*?when\s+'aguardando_aprovacao'\s+then\s+codigo_desfecho\s*=\s*'aprovacao_necessaria'/i
      .test(SQL));
  ok("D25 negado NAO aceita aprovacao_necessaria",
    /when\s+'negado'\s+then\s+codigo_desfecho\s+in\s*\(([\s\S]*?)\)/i.test(SQL) &&
      !/when\s+'negado'\s+then\s+codigo_desfecho\s+in\s*\([\s\S]*?aprovacao_necessaria/i.test(SQL));

  ok("D26 funcao_id usa o regex canonico do dominio",
    /funcao_id\s*~\s*'\^\[a-z0-9\]\+\(\\\.\[a-z0-9_\]\+\)\+\$'/.test(SQL));
  ok("D27 funcao_id so e nula em negado/funcao_inexistente",
    /funcao_id\s+is\s+not\s+null[\s\S]{0,120}status\s*=\s*'negado'\s+and\s+codigo_desfecho\s*=\s*'funcao_inexistente'/i
      .test(SQL));

  // O bicondicional correto amarra `acesso` a NAO-RESOLUCAO da Funcao,
  // e nao a nulidade de `funcao_id`: `vendas.inexistente` tem
  // `funcao_id` preenchido e `acesso` NULL.
  ok("D28 acesso e nulo exatamente quando a Funcao nao foi resolvida",
    /\(acesso\s+is\s+null\)\s*=\s*\(\s*status\s*=\s*'negado'\s+and\s+codigo_desfecho\s*=\s*'funcao_inexistente'\s*\)/i
      .test(SQL));
  ok("D29 e NAO existe o bicondicional incorreto funcao_id<=>acesso",
    !/\(funcao_id\s+is\s+null\)\s*=\s*\(acesso\s+is\s+null\)/i.test(SQL));

  ok("D30 plataforma e recurso vem juntos ou nenhum",
    /\(plataforma\s+is\s+null\)\s*=\s*\(recurso\s+is\s+null\)/i.test(SQL));
  ok("D31 loja exige requisito, mas requisito nao exige loja",
    /loja_id\s+is\s+null\s+or\s+plataforma\s+is\s+not\s+null/i.test(SQL));

  ok("D32 abertura nao tem latencia, e latencia nunca e negativa",
    /fase\s*<>\s*'abertura'\s+or\s+latencia_ms\s+is\s+null/i.test(SQL) &&
      /latencia_ms\s+is\s+null\s+or\s+latencia_ms\s*>=\s*0/i.test(SQL));

  ok("D33 request_id nao vazio", /length\(btrim\(request_id\)\)\s*>\s*0/i.test(SQL));
  ok("D34 mensagem truncada em 300 no proprio banco",
    /length\(mensagem_desfecho\)\s*<=\s*300/i.test(SQL));
}

secao("D4. Tenant imposto pelo banco");
{
  ok("D35 a UNIQUE composta e adicionada a agente_tarefas",
    /alter\s+table\s+public\.agente_tarefas[\s\S]*?add\s+constraint\s+agente_tarefas_id_por_dono\s+unique\s*\(\s*id,\s*user_id\s*\)/i
      .test(SQL));

  const fkComposta = (tabela: string, coluna: string) =>
    new RegExp(
      `foreign\\s+key\\s*\\(\\s*${coluna},\\s*user_id\\s*\\)\\s*references\\s+public\\.${tabela}\\s*\\(\\s*id,\\s*user_id\\s*\\)`,
      "i"
    ).test(SQL);

  ok("D36 FK de agente e composta com user_id", fkComposta("agentes", "agente_id"));
  ok("D37 FK de tarefa e composta com user_id", fkComposta("agente_tarefas", "tarefa_id"));
  ok("D38 FK de loja e composta com user_id", fkComposta("lojas", "loja_id"));

  // Historico de acao com efeito externo nao pode desaparecer porque o
  // agente, a tarefa ou a loja foram apagados.
  ok("D39 as tres FKs sao RESTRICT, nunca CASCADE",
    (SQL.match(/on\s+delete\s+restrict/gi) ?? []).length >= 3 &&
      !/agente_funcao_chamadas[\s\S]*?on\s+delete\s+cascade/i.test(SQL));

  ok("D40 nenhuma FK simples para as tres tabelas de tenant",
    !/references\s+public\.(agentes|lojas|agente_tarefas)\s*\(\s*id\s*\)/i.test(SQL));
}

secao("D5. Indices tem consulta, e nenhum e especulativo");
{
  ok("D41 historico do dono", /\(user_id,\s*criado_em\s+desc\)/i.test(SQL));
  ok("D42 historico do agente", /\(agente_id,\s*criado_em\s+desc\)/i.test(SQL));
  ok("D43 recuperacao de abertura sem desfecho",
    /where\s+status\s*=\s*'executando'/i.test(SQL));
  // `tarefa_id` ainda nao tem consultador.
  ok("D44 nenhum indice especulativo por tarefa_id",
    !/create\s+index[^;]*\(tarefa_id/i.test(SQL));
}

// ─── E. registro.ts ───────────────────────────────────────────────────

secao("E. O modulo de escrita nao vira executor");
{
  ok("E1  e server-only", /^import "server-only";/m.test(REGISTRO));

  ok("E2  nenhum UPDATE", !/\.update\(/.test(REGISTRO_CODIGO));
  ok("E3  nenhum DELETE", !/\.delete\(/.test(REGISTRO_CODIGO));
  ok("E4  nenhum upsert — historico nao e reescrito",
    !/\.upsert\(|onConflict/.test(REGISTRO_CODIGO));
  ok("E5  controle: as sondas achariam as tres operacoes",
    /\.update\(/.test(".update({a:1})") &&
      /\.delete\(/.test(".delete()") &&
      /\.upsert\(/.test(".upsert({})"));

  ok("E6  nenhum fetch", !/\bfetch\s*\(/.test(REGISTRO_CODIGO));
  ok("E7  nenhuma mencao a n8n ou marketplace",
    !/\bn8n\b|mercado_?livre|shopee/i.test(REGISTRO_CODIGO));

  // O modulo NAO decide: nao chama guard, nao resolve catalogo, nao le
  // permissao nem conexao. Ele recebe fatos e grava.
  ok("E8  nao chama o guard nem resolve o registry",
    !/autorizarFuncao|resolverFuncao|funcaoExiste|FUNCOES\b/.test(REGISTRO_CODIGO));
  ok("E9  nao le permissao nem conexao",
    !/resolverFatosPermissoes|resolverConexoesDoAgente|agente_permissoes|agente_conexoes/
      .test(REGISTRO_CODIGO));

  ok("E10 escreve em UMA tabela so",
    (REGISTRO_CODIGO.match(/\.from\(/g) ?? []).length === 1 &&
      /const TABELA_CHAMADAS = "agente_funcao_chamadas"/.test(REGISTRO_CODIGO));
}

secao("E2. Segredo nao chega a tabela");
{
  ok("E11 nenhuma referencia a header, token ou credencial",
    !/authorization|\bcookie\b|\bheaders?\b|\btoken\b|api[_-]?key|credential/i
      .test(REGISTRO_CODIGO));

  // A fronteira e fail-closed: mesmo recebendo objeto ja projetado, o
  // modulo reprojeta e aceita somente escalares.
  ok("E12 entrada_resumo passa por projecao propria",
    /function entradaResumoSegura/.test(REGISTRO_CODIGO) &&
      /Number\.isFinite/.test(REGISTRO_CODIGO));
  ok("E13 e o default e o objeto vazio, nunca o bruto",
    /return \{\};/.test(REGISTRO_CODIGO));
  ok("E14 nenhuma allowlist vinda de parametro",
    !/permitidos\s*:|allowlist\s*:/.test(REGISTRO_CODIGO));

  ok("E15 a mensagem e truncada pela autoridade ja existente",
    /truncarMensagem/.test(REGISTRO_CODIGO) &&
      /from "@\/lib\/agentes\/funcoes\/sanitizar"/.test(REGISTRO_CODIGO));
}

secao("E3. Duplicidade e evento semantico");
{
  ok("E16 23505 vira `duplicada`, nao sucesso silencioso",
    /23505/.test(REGISTRO_CODIGO) && /DUPLICADA/.test(REGISTRO_CODIGO));
  ok("E17 23503 vira `nao_disponivel` — FK indistinguivel de proposito",
    /23503/.test(REGISTRO_CODIGO) && /NAO_DISPONIVEL/.test(REGISTRO_CODIGO));
  ok("E18 nenhum retry, replay ou recovery neste modulo",
    !/\bretry\b|\breplay\b|recovery|tentarNovamente/i.test(REGISTRO_CODIGO));

  ok("E19 o erro do driver nunca e propagado como mensagem",
    !/error\.message|erro\.message/.test(REGISTRO_CODIGO));
}

secao("E4. A API e por FORMA de linha");
{
  ok("E20 tres operacoes exportadas, e so elas",
    /export async function registrarDesfechoSemExecucao/.test(REGISTRO_CODIGO) &&
      /export async function registrarAbertura/.test(REGISTRO_CODIGO) &&
      /export async function registrarDesfechoDeExecucao/.test(REGISTRO_CODIGO));

  ok("E21 nenhuma operacao de finalizar/cancelar/executar",
    !/export\s+(async\s+)?function\s+(finalizar|cancelar|executar|buscar|listar)/
      .test(REGISTRO_CODIGO));

  // O INSERT e privado: a superficie publica e por forma, para que uma
  // combinacao invalida seja dificil de escrever antes de o CHECK
  // reprova-la.
  ok("E22 o INSERT generico nao e exportado",
    /^async function inserir\(/m.test(REGISTRO_CODIGO) &&
      !/export\s+async\s+function\s+inserir/.test(REGISTRO_CODIGO));

  ok("E23 a abertura cobra idempotencia de escrita antes do banco",
    /acesso === "escrita"[\s\S]{0,80}idempotencyKey/.test(REGISTRO_CODIGO));
  ok("E24 desfecho sem execucao nunca carrega idempotency_key",
    /idempotency_key: null/.test(REGISTRO_CODIGO));
}

secao("E4b. Pre-execucao: quais codigos o TIPO admite");
{
  // ── Por que a prova e de COMPILACAO ──────────────────────────────
  //
  // O CHECK do banco aceita qualquer um dos cinco codigos de execucao
  // em `status='erro'`, com ou sem abertura — ele nao tem como saber se
  // houve uma. A separacao entre pre e pos-execucao e invariante de
  // TypeScript, e e o `tsc` quem a impoe.
  //
  // `AceitaCodigo<C>` responde, em tempo de compilacao, se `C` cabe no
  // campo. Trocar a uniao em `registro.ts` faz uma destas linhas parar
  // de compilar — que e exatamente o alarme desejado.
  type AceitaCodigo<C extends string> =
    C extends EntradaDesfechoSemExecucao["codigo"] ? true : false;

  // Permitidos antes de o executor ser engajado.
  const entradaInvalida: AceitaCodigo<"entrada_invalida"> = true;
  const erroInterno: AceitaCodigo<"erro_interno"> = true;

  // Proibidos: os tres descrevem uma tentativa em que o executor rodou —
  // ou pode ter rodado —, e essa so existe depois de uma abertura.
  const executorFalhou: AceitaCodigo<"executor_falhou"> = false;
  const saidaInvalida: AceitaCodigo<"saida_invalida"> = false;
  const timeout: AceitaCodigo<"timeout"> = false;

  // As cinco negacoes continuam cabendo.
  const funcaoInexistente: AceitaCodigo<"funcao_inexistente"> = true;
  const aprovacaoNecessaria: AceitaCodigo<"aprovacao_necessaria"> = true;

  ok("E4b1 `entrada_invalida` e permitido pre-execucao", entradaInvalida === true);
  ok("E4b2 `erro_interno` e permitido pre-execucao", erroInterno === true);
  ok("E4b3 `executor_falhou` e PROIBIDO pre-execucao", executorFalhou === false);
  ok("E4b4 `saida_invalida` e PROIBIDO pre-execucao", saidaInvalida === false);
  ok("E4b5 `timeout` e PROIBIDO pre-execucao", timeout === false);
  ok("E4b6 as negacoes continuam cabendo",
    funcaoInexistente === true && aprovacaoNecessaria === true);

  // E a mesma separacao, vista pela fonte: o campo cita nominalmente os
  // dois permitidos e nenhum dos tres proibidos.
  ok("E4b7 a uniao do campo nomeia so os dois codigos de execucao",
    /codigo: CodigoNegacao \| Extract<CodigoExecucao, "entrada_invalida" \| "erro_interno">/
      .test(REGISTRO_CODIGO));
  ok("E4b8 o caminho pos-execucao continua aceitando CodigoExecucao inteiro",
    /codigo\?: CodigoExecucao \| null;/.test(REGISTRO_CODIGO));
}

secao("E5. Snapshot nao e autoridade");
{
  // A regra precisa estar escrita onde alguem vai ler antes de usar o
  // campo — e o CHECK do banco nao consegue expressa-la.
  ok("E25 o modulo declara que snapshot nao autoriza",
    /snapshot/i.test(REGISTRO) && /autoridade/i.test(REGISTRO));
  ok("E26 a migration declara o mesmo nas colunas de snapshot",
    /NUNCA consultar para autorizar/i.test(MIGRATION));
}

// ─── F. Fronteiras preservadas ────────────────────────────────────────

secao("F. As tres pastas vizinhas continuam intocadas");
{
  ok("F1  lib/agentes/funcoes segue com os 3 modulos autorizados",
    JSON.stringify(readdirSync(join(RAIZ, "lib/agentes/funcoes")).sort()) ===
      JSON.stringify(["guard.ts", "registry.ts", "sanitizar.ts"]));

  // A divida do trust boundary (`autorizarFuncao` recebe
  // `conexaoNecessaria` de fora) e do gate do EXECUTOR. Fecha-la aqui
  // exigiria mexer no guard, que esta fora desta allowlist.
  ok("F2  o guard nao foi alterado para acomodar este gate",
    /conexaoNecessaria: RequisitoConexaoFuncao \| null/
      .test(fonte("lib/agentes/funcoes/guard.ts")));

  ok("F3  contrato.ts e PURO — sem server-only, sem Supabase, sem fetch",
    !/server-only/.test(CONTRATO_CODIGO) &&
      !/supabase/i.test(CONTRATO_CODIGO) &&
      !/\bfetch\s*\(/.test(CONTRATO_CODIGO));
  ok("F4  e nao conhece HTTP nem n8n",
    !/\bn8n\b/i.test(CONTRATO_CODIGO) && !/status\s*===?\s*(200|404|500)/.test(CONTRATO_CODIGO));
}

// ─── Placar ───────────────────────────────────────────────────────────

console.log(`\n══ ${passou} PASS / ${falhou} FAIL ══\n`);
process.exit(falhou === 0 ? 0 : 1);
