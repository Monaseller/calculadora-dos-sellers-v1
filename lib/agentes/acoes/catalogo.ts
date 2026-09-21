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
 */
import { FUNCAO_ID as FUNCAO_PERGUNTAS_ML } from "@/lib/agentes/handlers/consultar-perguntas-ml-contrato";

/** O nome publico da acao. UMA, nesta versao. */
export const ACAO_CONSULTAR_PERGUNTAS = "consultar_perguntas";

/**
 * O mapa. `Object.freeze` porque este modulo e leitura em todo o resto do
 * sistema: um `ACOES[x] = ...` em runtime tornaria a traducao dependente
 * da ordem de import, que e o tipo de defeito que nao aparece em teste.
 */
const ACOES: Readonly<Record<string, string>> = Object.freeze({
  [ACAO_CONSULTAR_PERGUNTAS]: FUNCAO_PERGUNTAS_ML,
});

/**
 * Resolve a Funcao de uma acao, ou `null`.
 *
 * ── FAIL-CLOSED, e fechado tambem para o PROTOTIPO ──────────────────
 *
 * `ACOES["toString"]` acharia uma funcao no prototipo de `Object` e
 * devolveria algo que nao e Funcao nenhuma. `hasOwnProperty` e o que
 * separa "a chave existe no mapa" de "a chave existe em algum lugar da
 * cadeia de prototipos" — mesma disciplina de `resolverContratoResume`.
 *
 * Acao desconhecida devolve `null`, nunca uma Funcao de reserva.
 */
export function resolverAcao(acao: unknown): string | null {
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
 * Quem orquestra manda o `executionId` da execucao dele. Se essa string
 * virasse a chave direto, dois orquestradores diferentes — ou o mesmo,
 * com outro workflow — poderiam colidir de proposito num namespace
 * global. O prefixo do provedor e a composicao com acao e agente mantem
 * cada origem no seu espaco.
 *
 * O que a chave AFIRMA: dentro de uma mesma execucao, a mesma acao para o
 * mesmo agente e a MESMA chamada logica. Pedi-la duas vezes e replay.
 *
 * Limite conhecido (`N8N-IDEM-F1`): um workflow que precise chamar a
 * mesma acao para o mesmo agente DUAS vezes na mesma execucao precisara
 * de um `stepId` neste namespace. Nao ha esse caso hoje.
 */
export function chaveDeIdempotencia(
  provedor: string,
  executionId: string,
  acao: string,
  agenteId: string
): string {
  return `${provedor}:${executionId}:${acao}:${agenteId}`;
}
