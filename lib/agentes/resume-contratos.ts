/**
 * APPROVAL-DECISION-RESUME-D5 — o registry de contratos de retomada.
 *
 * ── O que um contrato e, e o que ele NAO e ──────────────────────────
 *
 * Quando uma tarefa pausa em `aguardando_aprovacao` e um humano aprova,
 * alguem precisa retomar de onde parou: preparar a MESMA entrada que o
 * caminho automatico prepararia e interpretar o resultado da Funcao do
 * MESMO jeito. Este modulo diz ONDE essas duas operacoes moram, por
 * tipo de tarefa. Nada mais.
 *
 * Ele nao toca banco, nao move tarefa, nao le nem consome Approval, nao
 * chama Funcao e nao conhece worker. E uma tabela de referencias.
 *
 * ── Por que aponta para o contrato, e nunca para o handler ──────────
 *
 * O handler automatico importa `executarFuncao`. Se este registry
 * importasse o handler, o executor passaria a alcancar o registry por
 * um caminho de volta no dia em que fosse ligado a ele — um ciclo de
 * runtime. Apontando para `consultar-vendas-contrato.ts`, que e puro, o
 * grafo fica aciclico por construcao:
 *
 *   erros  <-  consultar-vendas-contrato  <-  resume-contratos
 *                        ^
 *                        |
 *              consultar-vendas (handler)  ->  executarFuncao
 *
 * ── MESMA referencia, nunca uma copia ───────────────────────────────
 *
 * `prepararEntrada` e `continuarAposFuncao` sao as FUNCOES REAIS que o
 * caminho automatico usa — nao adaptadores, nao `bind`, nao arrow que
 * chama a original. Igualdade estrita e o que garante que os dois
 * caminhos nao possam divergir: nao existe segunda implementacao para
 * ficar desatualizada.
 *
 * ── Dormente ────────────────────────────────────────────────────────
 *
 * Nenhum caller de producao usa `resolverContratoResume` ainda. A
 * ativacao — executor, worker e persistencia — e slice posterior.
 */
import type { ResultadoExecucaoFuncao } from "@/lib/agentes/execucao-funcoes/executar";
import {
  FUNCAO_ID,
  lerEntradaConsultarVendas,
  mapearResultadoConsultarVendas,
  TIPO_CONSULTAR_VENDAS,
  type EntradaConsultarVendas,
} from "@/lib/agentes/handlers/consultar-vendas-contrato";

/**
 * O contrato de UM tipo de tarefa.
 *
 * `TEntrada` amarra as duas pontas: o que `prepararEntrada` devolve e
 * exatamente o que `continuarAposFuncao` exige. Sem esse parametro, a
 * entrada de um tipo poderia ser entregue ao interpretador de outro e o
 * compilador nao teria como recusar.
 */
export interface ContratoResume<TEntrada> {
  /** A Funcao que este tipo de tarefa executa. Constante do contrato,
   *  nunca vinda da entrada — a tarefa nao escolhe capacidade. */
  readonly funcaoId: string;
  /** Le a entrada CRUA da linha da tarefa. A mesma leitura do caminho
   *  automatico: mesma recusa de campo extra, mesmos defaults. */
  readonly prepararEntrada: (bruta: unknown) => TEntrada;
  /** Traduz o desfecho da Funcao no resultado da TAREFA — incluindo
   *  lancar `PausaPorAprovacao` e os terminais. */
  readonly continuarAposFuncao: (
    resultado: ResultadoExecucaoFuncao,
    entrada: TEntrada
  ) => Record<string, unknown>;
}

/**
 * A tabela. Um tipo de tarefa so entra aqui quando a continuacao dele
 * ja existe e ja foi provada — registrar um tipo sem continuacao seria
 * prometer uma retomada que ninguem sabe terminar.
 *
 * `satisfies` confere a forma SEM apagar o tipo de cada entrada: a
 * consulta continua devolvendo o contrato especifico, com
 * `EntradaConsultarVendas` preservada nas duas pontas.
 */
const CONTRATOS = {
  [TIPO_CONSULTAR_VENDAS]: {
    funcaoId: FUNCAO_ID,
    prepararEntrada: lerEntradaConsultarVendas,
    continuarAposFuncao: mapearResultadoConsultarVendas,
  } satisfies ContratoResume<EntradaConsultarVendas>,
} as const;

/** Os tipos que TEM contrato. Derivado da tabela, nunca redigitado. */
export type TipoComContratoResume = keyof typeof CONTRATOS;

/**
 * A uniao dos contratos conhecidos.
 *
 * Com um tipo registrado ela e um contrato so; com dois ela vira uniao,
 * e quem consumir passa a ser OBRIGADO a discriminar. E o que se quer:
 * um segundo tipo nao pode entrar de carona na forma do primeiro.
 */
export type ContratoResumeConhecido = (typeof CONTRATOS)[TipoComContratoResume];

/**
 * Resolve o contrato de um tipo, ou `null`.
 *
 * FAIL-CLOSED: tipo desconhecido devolve `null`, nunca um contrato
 * generico de reserva. Retomar com a preparacao errada seria pior do
 * que nao retomar — entregaria o resultado de uma Funcao ao
 * interpretador de outra.
 *
 * `hasOwnProperty` e deliberado: `CONTRATOS["toString"]` acharia algo
 * no prototipo e devolveria uma funcao que nao e contrato nenhum.
 */
export function resolverContratoResume(tipo: string): ContratoResumeConhecido | null {
  if (!Object.prototype.hasOwnProperty.call(CONTRATOS, tipo)) return null;
  return CONTRATOS[tipo as TipoComContratoResume];
}

/** Os tipos registrados, para inventario e para as suites. Copia, para
 *  que ninguem altere a tabela por aqui. */
export function tiposComContratoResume(): readonly string[] {
  return Object.keys(CONTRATOS);
}
