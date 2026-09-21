/**
 * Catalogo de ACOES DE PRODUTO — M2-I1-A8.
 *
 * ── Por que existe uma camada entre a acao e a Funcao ───────────────
 *
 * Um orquestrador externo precisa pedir alguma coisa. O que ele NAO pode
 * pedir e uma CAPACIDADE: aceitar `funcaoId` do pedido transformaria o
 * catalogo de Funcoes numa API publica, e o guard passaria a proteger
 * uma decisao que o proprio pedido tomou.
 *
 * Entao ele pede uma ACAO — vocabulario de produto — e este modulo faz a
 * traducao, server-side, por um mapa fechado. A lista de acoes e curta de
 * proposito: ela cresce por gate, nao por conveniencia.
 *
 * ── A string da Funcao nao e redigitada ─────────────────────────────
 *
 * `FUNCAO_ID` vem do contrato da propria Funcao. Copiar o literal aqui
 * criaria uma segunda verdade que precisaria concordar para sempre, e que
 * divergiria em silencio no dia em que o id mudasse.
 *
 * ── Cada acao carrega o PROPRIO contrato de argumentos — M2-I1-A8B ───
 *
 * Ate a A8 havia UMA lista de argumentos para toda acao, na rota. Com
 * duas Funcoes de contratos diferentes isso deixou de funcionar: vendas
 * exige `dataInicio`/`dataFim`, perguntas aceita `status`/`limite`/
 * `deslocamento`, e uma lista global seria a uniao das duas — o que
 * deixaria `dataInicio` passar na acao de perguntas.
 *
 * Unir as listas afrouxaria uma fronteira que hoje e fechada, entao o
 * contrato mora JUNTO da acao. Resolver a acao e receber os argumentos
 * que ela aceita sao a MESMA operacao: nao da para fazer uma e esquecer
 * a outra.
 *
 * O que esta lista diz e apenas QUAIS chaves viajam. O que cada valor
 * pode ser continua sendo do validador da Funcao (`validarFiltroVendas`,
 * `validarFiltroPerguntas`) — nenhuma regra de dominio e recopiada aqui.
 */
import { FUNCAO_ID as FUNCAO_PERGUNTAS_ML } from "@/lib/agentes/handlers/consultar-perguntas-ml-contrato";
import { FUNCAO_ID as FUNCAO_VENDAS } from "@/lib/agentes/handlers/consultar-vendas-contrato";

/** O nome publico da acao de perguntas. */
export const ACAO_CONSULTAR_PERGUNTAS = "consultar_perguntas";

/**
 * O nome publico da acao de vendas.
 *
 * Coincide com `TIPO_CONSULTAR_VENDAS`, o tipo de TAREFA, e a coincidencia
 * e deliberadamente NAO transformada em import: acao de produto e tipo de
 * tarefa sao vocabularios distintos que hoje calham de ter a mesma
 * palavra. Perguntas prova isso — a acao e `consultar_perguntas` e o tipo
 * de tarefa e `consultar_perguntas_ml`. Acoplar os dois faria renomear um
 * arrastar o outro sem motivo.
 */
export const ACAO_CONSULTAR_VENDAS = "consultar_vendas";

/** O que uma acao registrada carrega: para onde traduz, e o que aceita. */
export interface ContratoDeAcao {
  readonly funcaoId: string;
  /** As UNICAS chaves de argumento aceitas. Fechada nos dois sentidos. */
  readonly argumentos: readonly string[];
}

/**
 * O mapa. `Object.freeze` porque este modulo e leitura em todo o resto do
 * sistema: um `ACOES[x] = ...` em runtime tornaria a traducao dependente
 * da ordem de import, que e o tipo de defeito que nao aparece em teste.
 */
const ACOES: Readonly<Record<string, ContratoDeAcao>> = Object.freeze({
  [ACAO_CONSULTAR_PERGUNTAS]: Object.freeze({
    funcaoId: FUNCAO_PERGUNTAS_ML,
    // Espelha `validarFiltroPerguntas`. Todas opcionais la; aqui so se
    // decide QUAIS podem viajar.
    argumentos: Object.freeze(["deslocamento", "limite", "status"]),
  }),
  [ACAO_CONSULTAR_VENDAS]: Object.freeze({
    funcaoId: FUNCAO_VENDAS,
    // Espelha `CHAVES_ACEITAS` de `consultar-vendas-contrato`. A
    // obrigatoriedade de `dataInicio`/`dataFim` NAO e checada aqui: quem
    // reprova ausencia e o validador da Funcao, que e a autoridade.
    argumentos: Object.freeze(["dataFim", "dataInicio", "marketplace"]),
  }),
});

/**
 * Resolve o CONTRATO de uma acao, ou `null`.
 *
 * ── FAIL-CLOSED, e fechado tambem para o PROTOTIPO ──────────────────
 *
 * `ACOES["toString"]` acharia uma funcao no prototipo de `Object` e
 * devolveria algo que nao e Funcao nenhuma. `hasOwnProperty` e o que
 * separa "a chave existe no mapa" de "a chave existe em algum lugar da
 * cadeia de prototipos" — mesma disciplina de `resolverContratoResume`.
 *
 * Acao desconhecida devolve `null`, nunca uma Funcao de reserva.
 *
 * Devolve o CONTRATO inteiro, e nao so o `funcaoId`, de proposito: quem
 * traduz a acao precisa das duas metades, e devolver uma so permitiria
 * executar a Funcao sem aplicar o filtro de argumentos dela.
 */
export function resolverAcao(acao: unknown): ContratoDeAcao | null {
  if (typeof acao !== "string" || acao.length === 0) return null;
  if (!Object.prototype.hasOwnProperty.call(ACOES, acao)) return null;
  return ACOES[acao];
}

/** As acoes registradas, para inventario e para as suites. Copia, para
 *  que ninguem altere o mapa por aqui. */
export function acoesRegistradas(): readonly string[] {
  return Object.keys(ACOES);
}

/**
 * A chave de idempotencia de UMA chamada da ponte.
 *
 * ── Derivada AQUI, nunca recebida ───────────────────────────────────
 *
 * Quem orquestra manda o `operationId` da INTENCAO dele. Se essa string
 * virasse a chave direto, dois orquestradores diferentes — ou o mesmo,
 * com outro workflow — poderiam colidir de proposito num namespace
 * global. O prefixo do provedor e a composicao com acao e agente mantem
 * cada origem no seu espaco.
 *
 * ── Por que `operationId` e nao `executionId` — M2-I1-A8B ───────────
 *
 * Ate a A8 a chave era composta com o `executionId` do n8n. Isso
 * confundia duas coisas: identidade de EXECUCAO e identidade de
 * INTENCAO. O `executionId` muda a cada disparo, entao um retry de
 * transporte — o mesmo pedido, reenviado porque a resposta se perdeu —
 * nascia com chave nova e era processado DE NOVO. Sob Schedule isso
 * viraria uma segunda coleta da mesma janela.
 *
 * `operationId` e a identidade que quem orquestra promete manter estavel
 * enquanto a intencao for a mesma, e trocar quando for outra. O
 * `executionId` continua viajando no corpo, mas so para correlacionar.
 *
 * O que a chave AFIRMA: a mesma intencao, para a mesma acao e o mesmo
 * agente, e a MESMA chamada logica. Pedi-la duas vezes e replay.
 *
 * Limite conhecido (`N8N-IDEM-F1`): um workflow que precise chamar a
 * mesma acao para o mesmo agente DUAS vezes dentro da mesma intencao
 * precisara de um `stepId` neste namespace. Nao ha esse caso hoje.
 */
export function chaveDeIdempotencia(
  provedor: string,
  operationId: string,
  acao: string,
  agenteId: string
): string {
  return `${provedor}:${operationId}:${acao}:${agenteId}`;
}
