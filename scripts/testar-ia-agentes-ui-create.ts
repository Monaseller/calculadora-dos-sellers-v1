/**
 * CDS IA — SKILL-1D.agent-create-ui-B. Suite da criacao visual de agente.
 *
 * A pergunta central desta suite e uma so: **o que sai daqui pela rede?**
 *
 * A criacao e a primeira ESCRITA que a interface dispara. Um corpo com
 * uma chave a mais nao quebra teste nenhum, nao aparece na tela e so se
 * revela no dia em que o servidor mudar de opiniao sobre confiar no
 * cliente. Por isso o corpo efetivo e medido chave a chave, e o
 * cenario de mass assignment passa um objeto de origem cheio de campos
 * privilegiados so para provar que nenhum deles atravessa.
 *
 * As funcoes REAIS do transporte rodam contra um `fetch` duplado que
 * guarda url, metodo, headers e corpo. Nenhum banco, nenhum servidor,
 * nenhuma escrita real — a primeira criacao de verdade e gate proprio.
 *
 * Rodar:  npx tsx scripts/testar-ia-agentes-ui-create.ts
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { TIPOS_AGENTE_UI } from "../lib/ia/contratos";
import { DESCRICAO_TIPO } from "../lib/ia/conceitos";
import { CORES_TIPO } from "../lib/ia/design";
import { FUNCOES_DE_CRIACAO } from "../lib/ia/criar-agente";

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
const codigo = (f: string) =>
  f.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const TRANSPORTE = "lib/ia/agentes-http.ts";
// F8.3-C3-C: o dialogo antigo (`components/ia/agente/CriarAgente.tsx`) e a
// lista legada que o abria foram REMOVIDOS. A criacao e o fluxo de 6
// etapas — e a Identidade dele e quem cria o agente.
const DIALOGO_REMOVIDO = "components/ia/agente/CriarAgente.tsx";
const LISTA_LEGADA_REMOVIDA = "components/ia/agente/ListaDeAgentesLegada.tsx";
const CRIAR = "components/ia/criar/CriarAgente.tsx";
const NOVO = "app/(app)/ia/agentes/novo/page.tsx";
const LISTA = "app/(app)/ia/agentes/page.tsx";

const CODIGO_TRANSPORTE = codigo(ler(TRANSPORTE));
const CODIGO_CRIAR = codigo(ler(CRIAR));
const CODIGO_LISTA = codigo(ler(LISTA));

function arquivosDe(dirRel: string): string[] {
  const saida: string[] = [];
  const caminhar = (rel: string) => {
    for (const nome of readdirSync(join(RAIZ, rel))) {
      const filho = `${rel}/${nome}`;
      if (statSync(join(RAIZ, filho)).isDirectory()) caminhar(filho);
      else saida.push(filho);
    }
  };
  caminhar(dirRel);
  return saida.sort();
}
const AREA = [
  ...arquivosDe("lib/ia"),
  ...arquivosDe("components/ia"),
  ...arquivosDe("app/(app)/ia"),
];

console.log("\n══ CDS IA — SKILL-1D.agent-create-ui-B: criacao visual ══");

// ─── A. Estrutura ─────────────────────────────────────────────────────

secao("A. A escrita mora num lugar so");

{
  const comPost = AREA.filter((a) => /"POST"|method:\s*"POST"/.test(codigo(ler(a))));
  ok("A1  exatamente UM arquivo da area faz POST",
    JSON.stringify(comPost) === JSON.stringify([TRANSPORTE]), comPost.join(", "));
  ok("A2  e e o mesmo boundary de rede de sempre",
    /\bfetch\s*\(/.test(CODIGO_TRANSPORTE) && !/\bfetch\s*\(/.test(CODIGO_CRIAR) &&
      !/\bfetch\s*\(/.test(CODIGO_LISTA));
  // ── A3 reconciliado na AGENT-VERTICAL-SLICE-V1-I3 ────────────────
  //
  // A frase "uma unica escrita publicada" deixou de ser verdadeira: a
  // aba Chat trouxe a segunda, `enviarMensagemAoAgente`, que cria uma
  // tarefa de conversa. Sao DUAS, nominais, e somente essas — nao "duas
  // ou mais". O que esta suite protege continua sendo a CRIACAO DE
  // AGENTE: ela tem de seguir existindo, por POST, entre as autorizadas.
  // A cobertura do Chat vive em `testar-ia-ui-1c.ts`, e nao e duplicada
  // aqui.
  //
  // ── A3 reconciliado de novo na EDITAR-AGENTE-V1 ──────────────────
  //
  // Entrou a TERCEIRA escrita, `atualizarAgenteViaApi`, e ela nao e uma
  // criacao: e a primeira ALTERACAO da area, por PATCH. O veto em bloco
  // a PUT/PATCH/DELETE foi revogado so na parte do PATCH — PUT e DELETE
  // seguem proibidos.
  //
  // Esta suite e a da CRIACAO, e continua medindo a criacao: o que ela
  // protege e que `criarAgenteViaApi` siga existindo, por POST, e que a
  // contagem de POST NAO suba junto com a chegada do PATCH. A doutrina
  // nominal completa (funcao=verbo, com os controles de troca de verbo)
  // vive em `testar-ia-agentes-ui-source.ts`, e nao e duplicada aqui.
  //
  // ── A3 reconciliado de novo na PERMISSOES-FUNCTION-V1-B ──────────
  //
  // Entrou a QUARTA escrita, `definirPermissaoDeFuncao`, tambem por
  // PATCH: ela grava o nivel de autonomia de uma Funcao. POST continua
  // em DOIS — a chegada de uma escrita nova nao pode empurrar a
  // contagem de CRIACAO, e e exatamente isso que esta suite protege.
  ok("A3  quatro escritas publicadas, nominais — duas por POST, duas por PATCH",
    (CODIGO_TRANSPORTE.match(/method:\s*"POST"/g) ?? []).length === 2 &&
      (CODIGO_TRANSPORTE.match(/method:\s*"PATCH"/g) ?? []).length === 2 &&
      /export async function criarAgenteViaApi\(/.test(CODIGO_TRANSPORTE) &&
      /export async function enviarMensagemAoAgente\(/.test(CODIGO_TRANSPORTE) &&
      /export async function atualizarAgenteViaApi\(/.test(CODIGO_TRANSPORTE) &&
      /export async function definirPermissaoDeFuncao\(/.test(CODIGO_TRANSPORTE) &&
      !/"PUT"|"DELETE"/.test(CODIGO_TRANSPORTE));
  ok("A3a a criacao de agente continua sendo uma delas, e por POST",
    /export async function criarAgenteViaApi\(/.test(CODIGO_TRANSPORTE) &&
      /method: "POST"/.test(CODIGO_TRANSPORTE));
  ok("A3b CONTROLE NEGATIVO: um terceiro POST reprovaria a contagem",
    ((CODIGO_TRANSPORTE + '\n  method: "POST"').match(/method:\s*"POST"/g) ?? []).length !== 2);
  ok("A3c CONTROLE NEGATIVO: um terceiro PATCH reprovaria a contagem",
    ((CODIGO_TRANSPORTE + '\n  method: "PATCH"').match(/method:\s*"PATCH"/g) ?? []).length !== 2);
  ok("A3d CONTROLE NEGATIVO: a sonda de PUT/DELETE acusa quando o padrao existe",
    /"PUT"|"DELETE"/.test('method: "PUT"') && /"PUT"|"DELETE"/.test('method: "DELETE"'));
  // Criar e alterar sao capacidades separadas. F8.3-C3-C: o fluxo de 6
  // etapas grava o RASCUNHO que ele mesmo criou (PATCH so de nome e
  // instrucoes, depois do POST, no id devolvido) — nao e caminho de
  // edicao de outro agente. A lista de Agentes segue sem nenhum dos dois.
  ok("A3e a criacao so altera o proprio rascunho, so nome/instrucoes",
    /atualizarAgenteViaApi\(agenteId, \{ nome: nome\.trim\(\), instrucoes \}\)/.test(CODIGO_CRIAR) &&
      (CODIGO_CRIAR.match(/atualizarAgenteViaApi\(/g) ?? []).length === 1 &&
      !/atualizarAgenteViaApi/.test(CODIGO_LISTA));
  // Nem a de CONFIGURAR capacidade: criar um agente nao pode, de
  // passagem, conceder nivel de autonomia a uma Funcao.
  // Permissao de Funcao so pelas etapas APIs/Tools (o helper de pack), e
  // nunca gravada direto pela tela de criacao nem pela lista.
  ok("A3f nem a capacidade de configurar permissao de Funcao direto",
    !/definirPermissaoDeFuncao|listarPermissoesDoAgente/.test(CODIGO_CRIAR) &&
      !/definirPermissaoDeFuncao|listarPermissoesDoAgente/.test(CODIGO_LISTA));
  ok("A4  o nome do dominio continua reservado ao servidor",
    /export async function criarAgenteViaApi\(/.test(CODIGO_TRANSPORTE) &&
      !/export async function criarAgente\(/.test(CODIGO_TRANSPORTE));
  ok("A5  o corpo e montado campo a campo, nunca do formulario inteiro",
    /nome: dados\.nome/.test(CODIGO_TRANSPORTE) &&
      !/JSON\.stringify\(dados\)|JSON\.stringify\(form/.test(CODIGO_TRANSPORTE) &&
      !/\.\.\.\s*dados/.test(CODIGO_TRANSPORTE));
  ok("A6  a criacao nao aceita sinal de cancelamento",
    !/criarAgenteViaApi\([^)]*signal/.test(CODIGO_TRANSPORTE));
  ok("A7  ANCORA: a varredura leu a area", AREA.length > 40, String(AREA.length));
}

secao("B. A Identidade pede nome, funcao e instrucoes — e nenhuma a mais");

{
  // F8.3-C3-C: o dialogo antigo foi removido. As mesmas perguntas valem
  // para a etapa Identidade do fluxo atual, que e quem CRIA o agente.
  ok("B0  o dialogo antigo foi REMOVIDO", !existsSync(join(RAIZ, DIALOGO_REMOVIDO)));
  ok("B1  e Client Component", /^"use client"/.test(ler(CRIAR)));
  ok("B2  cria pelo transporte, com corpo de TRES chaves",
    /criarAgenteViaApi\(\{\s*nome: nome\.trim\(\), tipo, instrucoes: instrucoes\.trim\(\) === "" \? null : instrucoes,\s*\}\)/
      .test(CODIGO_CRIAR));
  ok("B3  campo de nome", /<input[\s\S]{0,120}value=\{nome\}/.test(CODIGO_CRIAR));
  ok("B4  funcao escolhida entre os tipos da autoridade",
    /FUNCOES_DE_CRIACAO\.map/.test(CODIGO_CRIAR) && /onClick=\{\(\) => setTipo\(f\.tipo\)\}/.test(CODIGO_CRIAR));
  ok("B5  textarea de instrucoes", /<textarea[\s\S]{0,160}value=\{instrucoes\}/.test(CODIGO_CRIAR));
  ok("B6  Continuar e quem cria", /if \(etapa === 1\) \{\s*if \(!\(await salvarIdentidade\(\)\)\) return;/.test(CODIGO_CRIAR));

  ok("B7  as funcoes vem da autoridade, sem tipo inventado",
    FUNCOES_DE_CRIACAO.length === TIPOS_AGENTE_UI.length &&
      FUNCOES_DE_CRIACAO.every((f) => (TIPOS_AGENTE_UI as readonly string[]).includes(f.tipo)) &&
      !/"(mensagens|ads|fotos|anuncios|financeiro|gerente)"/.test(CODIGO_CRIAR));
  ok("B7a a autoridade tem exatamente sete perfis",
    TIPOS_AGENTE_UI.length === 7, String(TIPOS_AGENTE_UI.length));
  ok("B7b `personalizado` e o estado inicial (o unico tipo escrito na tela)",
    TIPOS_AGENTE_UI[0] === "personalizado" &&
      /useState<TipoAgenteUI>\("personalizado"\)/.test(CODIGO_CRIAR));
  ok("B7c depois de criado, a funcao NAO muda (o PATCH nao leva tipo)",
    /disabled=\{agenteId !== null \|\| ocupado\}/.test(CODIGO_CRIAR) &&
      !/atualizarAgenteViaApi\([^)]*tipo/.test(CODIGO_CRIAR));
  ok("B7d a autoridade de descricoes segue intacta",
    DESCRICAO_TIPO.personalizado === "Propósito definido por você" &&
      DESCRICAO_TIPO.mensagens === "Atendimento ao comprador");
  ok("B7e e a de cores tambem",
    CORES_TIPO.personalizado === "#8b93a5" && CORES_TIPO.mensagens === "#4a9de8");
  ok("B7f toda a autoridade tem descricao e cor",
    TIPOS_AGENTE_UI.every((t) => DESCRICAO_TIPO[t]?.length > 0 && CORES_TIPO[t]?.length > 0));
  ok("B7h a tela diz que a funcao nao da nem tira capacidade",
    /O que ele pode fazer é definido em APIs e Tools\./.test(CODIGO_CRIAR));

  ok("B9  zero campo prematuro na tela de criacao",
    !/value=\{(modelo|temperatura|tools?|funcao|skill|fonte|conexao|permissao|memoria|avatar|cor|icone|agenda|budget)\}/i
      .test(CODIGO_CRIAR));
  ok("B10 zero controle de dono, id, ativo ou datas",
    !/value=\{(userId|uid|user_id|id|ativo|criado_em|atualizado_em)\}/.test(CODIGO_CRIAR));
  ok("B11 acessibilidade: etapas navegaveis e etapa atual marcada",
    /aria-label="Etapas da criação"/.test(CODIGO_CRIAR) && /aria-current=\{atual \? "step" : undefined\}/.test(CODIGO_CRIAR));
  ok("B14 envio duplo fechado no botao enquanto grava",
    /className=\{cx\(estilos\.botao, estilos\.botaoPrimario\)\} disabled=\{ocupado\}\s*onClick=\{\(\) => void continuar\(\)\}/.test(CODIGO_CRIAR));
  ok("B16 nome obrigatorio por trim, sem regra alem da do servidor",
    /if \(nome\.trim\(\) === ""\) \{ setErro\("Dê um nome ao agente\."\)/.test(CODIGO_CRIAR));
  ok("B17 instrucoes vazias viram null, explicitamente",
    /instrucoes: instrucoes\.trim\(\) === "" \? null : instrucoes/.test(CODIGO_CRIAR));
  ok("B18 a criacao nao navega por router nem leva ao assistente antigo",
    !/useRouter|router\.|next\/navigation|\/configurar/.test(CODIGO_CRIAR));
  ok("B19 e nao conhece mock nenhum", !/MOCK_/.test(CODIGO_CRIAR));
}

secao("C. Um caminho so de criacao");

{
  // ── F8.3-C3-C: a intencao original (CAMINHO UNICO) sobre a UI atual ──
  //
  // Antes, "a lista abre a criacao". Agora: a pagina Agentes NAO cria; a
  // criacao e so a aba "Criar agente" (`/ia/agentes/novo`), que monta o
  // fluxo de 6 etapas. O dialogo antigo e a lista legada foram removidos.
  const SUBNAV = codigo(ler("components/ia/SubNavIA.tsx"));
  const GESTAO = codigo(ler("components/ia/agentes/GestaoDeAgentes.tsx"));
  const PAGINA_NOVO = codigo(ler(NOVO));
  const RUNTIME = [...arquivosDe("app"), ...arquivosDe("components"), ...arquivosDe("lib")]
    .filter((a) => /\.(tsx?|jsx?)$/.test(a));
  const chamamCriacao = RUNTIME.filter((a) => a !== TRANSPORTE && /criarAgenteViaApi\(/.test(codigo(ler(a))));
  ok("C1  criar agente e aba da navegacao principal",
    /href: "\/ia\/agentes\/novo", rotulo: "Criar agente", principal: true/.test(SUBNAV));
  ok("C2  a pagina Agentes nao oferece criacao (nem botao, nem dialogo)",
    !/Criar agente|CriarAgente|setCriando|criarAgenteViaApi/.test(CODIGO_LISTA + GESTAO));
  ok("C3  /ia/agentes usa a GestaoDeAgentes; /ia/agentes/novo usa o fluxo atual",
    /<GestaoDeAgentes \/>/.test(CODIGO_LISTA) &&
      /import CriarAgente from "@\/components\/ia\/criar\/CriarAgente";/.test(PAGINA_NOVO) && /<CriarAgente \/>/.test(PAGINA_NOVO));
  ok("C4  o dialogo antigo e a lista legada foram removidos",
    !existsSync(join(RAIZ, DIALOGO_REMOVIDO)) && !existsSync(join(RAIZ, LISTA_LEGADA_REMOVIDA)));
  ok("C4a e nada mais os importa",
    RUNTIME.every((a) => !/components\/ia\/agente\/(CriarAgente|ListaDeAgentesLegada)\b/.test(ler(a))));
  // O Wizard antigo ainda tem um ramo de criacao, mas nenhuma rota o monta
  // sem id: ele so configura agente EXISTENTE (`/ia/agentes/[id]/configurar`).
  ok("C4b so o fluxo atual cria em runtime (o Wizard so entra com id)",
    JSON.stringify(chamamCriacao.sort()) === JSON.stringify([CRIAR, "components/ia/factory/Wizard.tsx"].sort()) &&
      RUNTIME.every((a) => !/agenteIdInicial=\{null\}/.test(codigo(ler(a)))) &&
      /<Wizard agenteIdInicial=\{params\.id\} \/>/.test(codigo(ler("app/(app)/ia/agentes/[id]/configurar/page.tsx"))),
    chamamCriacao.join(", "));
  ok("C4c nenhum botao interno antigo recria o dialogo",
    RUNTIME.every((a) => !/setCriando\(true\)|criar primeiro agente/i.test(codigo(ler(a)))));
  ok("C5  sem segunda leitura, sem reload, sem navegacao automatica na lista",
    !/listarAgentes\(\)[\s\S]{0,80}aoCriar|router\.|location\.reload|window\.location/.test(CODIGO_LISTA));
  ok("C6  a lista nao inventa id, ativo nem data para agente nenhum",
    !/id:\s*(crypto|randomUUID|`)|ativo:\s*true|criado_em:\s*new Date/.test(CODIGO_LISTA));
  ok("C7  e continua sem mock", !/MOCK_/.test(CODIGO_LISTA));
}

// ─── D–F. O transporte REAL, contra um fetch duplado ──────────────────

interface Chamada { url: string; init?: RequestInit }
let chamadas: Chamada[] = [];
let proxima: { status: number; corpo: unknown } | "erro" = { status: 201, corpo: null };

const fetchOriginal = globalThis.fetch;
globalThis.fetch = (async (entrada: unknown, init?: RequestInit) => {
  chamadas.push({ url: String(entrada), init });
  if (proxima === "erro") throw new Error("rede caiu");
  return {
    status: proxima.status,
    ok: proxima.status >= 200 && proxima.status < 300,
    json: async () => {
      if (proxima !== "erro" && proxima.corpo === "ilegivel") throw new Error("json invalido");
      return proxima === "erro" ? null : proxima.corpo;
    },
  } as unknown as Response;
}) as typeof fetch;

function responde(status: number, corpo: unknown): void {
  chamadas = [];
  proxima = { status, corpo };
}

const UUID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const agenteCriado = (extra: Record<string, unknown> = {}) => ({
  id: UUID, nome: "Atendimento", tipo: "mensagens", instrucoes: null,
  ativo: true, criado_em: "2026-08-29T12:00:00.000Z", ...extra,
});
const corpoEnviado = (): Record<string, unknown> =>
  JSON.parse(String(chamadas[0]?.init?.body ?? "{}"));

async function principal(): Promise<void> {
  const { criarAgenteViaApi } = await import("../lib/ia/agentes-http");

  secao("D. A requisicao: metodo, endereco e corpo exato");

  responde(201, { ok: true, agente: agenteCriado() });
  const r = await criarAgenteViaApi({ nome: "Atendimento", tipo: "mensagens", instrucoes: null });

  ok("D1  201 -> ok com o agente criado", r.estado === "ok");
  ok("D2  metodo POST", chamadas[0]?.init?.method === "POST", String(chamadas[0]?.init?.method));
  ok("D3  endereco publicado", chamadas[0]?.url === "/api/agentes", chamadas[0]?.url);
  ok("D4  UM header, e so o necessario para o corpo",
    JSON.stringify(chamadas[0]?.init?.headers) === JSON.stringify({ "Content-Type": "application/json" }),
    JSON.stringify(chamadas[0]?.init?.headers));
  ok("D5  `credentials` omitido", chamadas[0]?.init?.credentials === undefined);
  ok("D6  zero sinal de cancelamento numa escrita", chamadas[0]?.init?.signal === undefined);
  ok("D7  o corpo tem EXATAMENTE tres chaves",
    JSON.stringify(Object.keys(corpoEnviado()).sort()) ===
      JSON.stringify(["instrucoes", "nome", "tipo"]),
    JSON.stringify(Object.keys(corpoEnviado()).sort()));
  ok("D8  e os valores sao os enviados",
    corpoEnviado().nome === "Atendimento" && corpoEnviado().tipo === "mensagens" &&
      corpoEnviado().instrucoes === null);
  ok("D9  o agente devolvido e o do servidor, com uuid dele",
    r.estado === "ok" && r.agente.id === UUID && r.agente.ativo === true);

  // O setimo perfil atravessa o transporte pelo MESMO caminho: nao ha
  // ramo, nao ha tratamento proprio, e o parser da lista o aceita como
  // aceita qualquer outro.
  responde(201, { ok: true, agente: agenteCriado({ tipo: "personalizado", nome: "Meu agente" }) });
  const rPers = await criarAgenteViaApi({
    nome: "Meu agente", tipo: "personalizado", instrucoes: "Cuidar do que eu pedir.",
  });
  ok("D10 POST com `personalizado` -> ok, sem ramo especial",
    rPers.estado === "ok" && rPers.agente.tipo === "personalizado");
  ok("D11 e o corpo continua com as mesmas tres chaves",
    JSON.stringify(Object.keys(corpoEnviado()).sort()) ===
      JSON.stringify(["instrucoes", "nome", "tipo"]) &&
      corpoEnviado().tipo === "personalizado");
  ok("D12 zero branch por perfil no transporte",
    !/=== "personalizado"|personalizado\s*\?/.test(CODIGO_TRANSPORTE));

  const { listarAgentes } = await import("../lib/ia/agentes-http");
  responde(200, { ok: true, agentes: [agenteCriado({ tipo: "personalizado" })] });
  const lPers = await listarAgentes();
  ok("D13 a listagem parseia `personalizado` sem shape novo",
    lPers.estado === "ok" && lPers.agentes.length === 1 &&
      lPers.agentes[0].tipo === "personalizado");

  responde(200, { ok: true, agentes: [agenteCriado({ tipo: "custom" })] });
  ok("D14 e continua recusando um perfil fora da autoridade",
    (await listarAgentes()).estado === "falha");

  secao("E. Mass assignment: o que o cliente pede nao vira coluna");

  // Uma origem "contaminada" — como um objeto de formulario que ganhou
  // chaves com o tempo. A tipagem sozinha nao e prova: o que se mede e o
  // corpo que SAIU.
  const contaminado = {
    nome: "Invasor",
    tipo: "gerente",
    instrucoes: "instrucoes legitimas",
    user_id: "B", userId: "B", uid: "B",
    id: "00000000-dead-4bee-8000-000000000000",
    ativo: false,
    criado_em: "1999-01-01T00:00:00.000Z",
    atualizado_em: "1999-01-01T00:00:00.000Z",
    agoraMs: 123,
    Authorization: "Bearer nao-deve-viajar",
    token: "nao-deve-viajar",
  } as unknown as { nome: string; tipo: "gerente"; instrucoes: string | null };

  responde(201, { ok: true, agente: agenteCriado({ nome: "Invasor", tipo: "gerente" }) });
  await criarAgenteViaApi(contaminado);

  const enviado = corpoEnviado();
  ok("E1  o corpo continua com TRES chaves",
    JSON.stringify(Object.keys(enviado).sort()) === JSON.stringify(["instrucoes", "nome", "tipo"]),
    JSON.stringify(Object.keys(enviado).sort()));
  for (const proibida of [
    "user_id", "userId", "uid", "id", "ativo", "criado_em", "atualizado_em",
    "agoraMs", "Authorization", "token",
  ]) {
    ok(`E2  \`${proibida}\` nao atravessou`, !(proibida in enviado));
  }
  ok("E3  e nada disso vazou por header tampouco",
    JSON.stringify(chamadas[0]?.init?.headers) === JSON.stringify({ "Content-Type": "application/json" }));

  secao("F. Cada resposta no seu lugar");

  for (const [nome, status, corpo, esperado] of [
    ["F1  400 nome invalido", 400, { ok: false, erro: "nome inválido." }, "dados_invalidos"],
    ["F2  400 tipo invalido", 400, { ok: false, erro: "tipo inválido." }, "dados_invalidos"],
    ["F3  400 corpo invalido", 400, { ok: false, erro: "Corpo da requisição inválido (JSON esperado)." }, "dados_invalidos"],
    ["F4  401", 401, { ok: false, erro: "Não autenticado." }, "nao_autenticado"],
    ["F5  500", 500, { ok: false, erro: "Falha ao criar o agente." }, "falha"],
    ["F6  corpo ilegivel", 201, "ilegivel", "falha"],
    ["F7  201 sem `ok`", 201, { agente: agenteCriado() }, "falha"],
    ["F8  201 sem agente", 201, { ok: true }, "falha"],
    ["F9  201 com agente parcial", 201, { ok: true, agente: { id: UUID, nome: "x" } }, "falha"],
    ["F10 201 com tipo fora do vocabulario", 201, { ok: true, agente: agenteCriado({ tipo: "vendedor" }) }, "falha"],
  ] as [string, number, unknown, string][]) {
    responde(status, corpo);
    const res = await criarAgenteViaApi({ nome: "x", tipo: "mensagens", instrucoes: null });
    ok(`${nome} -> ${esperado}`, res.estado === esperado, res.estado);
  }

  proxima = "erro";
  chamadas = [];
  ok("F11 rede caida -> falha, sem excecao vazando",
    (await criarAgenteViaApi({ nome: "x", tipo: "mensagens", instrucoes: null })).estado === "falha");

  // A mensagem que a tela mostra e SEMPRE uma frase nossa.
  responde(400, { ok: false, erro: "nome inválido." });
  const conhecida = await criarAgenteViaApi({ nome: "", tipo: "mensagens", instrucoes: null });
  ok("F12 mensagem publicada atravessa como esta",
    conhecida.estado === "dados_invalidos" && conhecida.mensagem === "nome inválido.");

  responde(400, { ok: false, erro: "violates check constraint agentes_tipo_valido" });
  const desconhecida = await criarAgenteViaApi({ nome: "x", tipo: "mensagens", instrucoes: null });
  ok("F13 mensagem DESCONHECIDA vira generica — nada de texto de banco na tela",
    desconhecida.estado === "dados_invalidos" &&
      !/constraint|agentes_tipo_valido|violates/i.test(desconhecida.mensagem),
    desconhecida.estado === "dados_invalidos" ? desconhecida.mensagem : desconhecida.estado);

  globalThis.fetch = fetchOriginal;

  console.log(`\n══ ${passou} PASS / ${falhou} FAIL ══\n`);
  process.exitCode = falhou === 0 ? 0 : 1;
}

principal().catch((e) => {
  globalThis.fetch = fetchOriginal;
  console.log(`  FAIL  excecao nao tratada — ${String(e).slice(0, 300)}`);
  process.exitCode = 1;
});
