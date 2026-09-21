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
// M2-I1-A7: o segundo tipo com continuacao propria. Importado do
// CONTRATO, nunca do handler — este modulo precisa continuar puro, e o
// handler arrasta o executor consigo.
import {
  FUNCAO_ID as FUNCAO_ID_PERGUNTAS_ML,
  lerEntradaConsultarPerguntasML,
  mapearResultadoConsultarPerguntasML,
  TIPO_CONSULTAR_PERGUNTAS_ML,
  type EntradaConsultarPerguntasML,
} from "@/lib/agentes/handlers/consultar-perguntas-ml-contrato";

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
  // M2-I1-A7 — polling de perguntas do Mercado Livre.
  //
  // Este contrato e OBRIGATORIO mesmo o produtor do polling so
  // enfileirar quando a permissao esta em `automatico`: a permissao
  // pode mudar entre o enfileiramento e a execucao, e nessa corrida o
  // guard produz `aguardando_aprovacao`. Sem contrato, a aprovacao
  // nasceria sem continuacao conhecida.
  //
  // Registrar o contrato NAO liga a retomada: `resolverContratoResume`
  // continua sem caller de producao. As duas coisas sao separadas de
  // proposito, e a segunda e outro slice.
  [TIPO_CONSULTAR_PERGUNTAS_ML]: {
    funcaoId: FUNCAO_ID_PERGUNTAS_ML,
    prepararEntrada: lerEntradaConsultarPerguntasML,
    continuarAposFuncao: mapearResultadoConsultarPerguntasML,
  } satisfies ContratoResume<EntradaConsultarPerguntasML>,
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


// ─── O acesso CORRELACIONADO ─────────────────────────────────────────

/**
 * Uma retomada com a entrada JA preparada.
 *
 * ── Por que esta forma existe ───────────────────────────────────────
 *
 * `resolverContratoResume` devolve a UNIAO dos contratos. Quem a segura
 * prepara a entrada num ponto e continua noutro, com a execucao da
 * Funcao no meio — e o TypeScript nao tem como saber que a entrada veio
 * do MESMO ramo do contrato. Ele entao exige, na continuacao, o
 * parametro que serve a TODOS os membros: a intersecao. Nenhuma entrada
 * real satisfaz isso, e o consumidor deixa de compilar.
 *
 * A correlacao e feita AQUI, onde cada contrato ainda e concreto. O que
 * sai e uma continuacao ja amarrada — ao contrato certo e a entrada
 * certa, pela mesma closure.
 *
 * ── A entrada NAO e exposta, e isso e o ponto ───────────────────────
 *
 * Sem `entrada` neste tipo, nao existe estado representavel em que uma
 * entrada de vendas conviva com o contrato de perguntas. A combinacao
 * errada deixa de ser um erro a evitar e passa a ser algo que nao ha
 * como escrever.
 */
export interface RetomadaPreparada {
  /** A Funcao daquele tipo. Mesma constante do contrato. */
  readonly funcaoId: string;
  /** A continuacao, fechada sobre o contrato e a entrada preparada. */
  readonly continuar: (
    resultado: ResultadoExecucaoFuncao
  ) => Record<string, unknown>;
}

/**
 * Prepara a entrada e amarra a continuacao.
 *
 * Generico de proposito: `T` so e inferido quando o chamador passa um
 * contrato CONCRETO. Chamar isto com a uniao nao compila — e nao e
 * limitacao, e a propria garantia funcionando.
 *
 * Nao reimplementa nada: `prepararEntrada` e `continuarAposFuncao` sao
 * as MESMAS referencias do contrato, chamadas daqui.
 */
function preparado<T>(contrato: ContratoResume<T>, bruta: unknown): RetomadaPreparada {
  const entrada = contrato.prepararEntrada(bruta);
  return {
    funcaoId: contrato.funcaoId,
    continuar: (resultado: ResultadoExecucaoFuncao) =>
      contrato.continuarAposFuncao(resultado, entrada),
  };
}

/**
 * Resolve o contrato de um tipo E ja prepara a entrada.
 *
 * FAIL-CLOSED como `resolverContratoResume`: tipo desconhecido devolve
 * `null`, nunca um preparo generico de reserva.
 *
 * `prepararEntrada` pode LANCAR — `ErroEntradaTarefa` para argumento
 * fora do contrato. A excecao ATRAVESSA, porque quem chama ja a trata:
 * engoli-la aqui transformaria argumento invalido em tipo desconhecido,
 * que sao coisas diferentes e pedem respostas diferentes.
 *
 * ── O switch e sobre a CHAVE, nao sobre o contrato ──────────────────
 *
 * `contrato.funcaoId` NAO discrimina: a interface o declara `string`, e
 * o tipo contextual do `satisfies` alarga a literal. Um
 * `switch (contrato.funcaoId)` compila e nao estreita nada — medido.
 * A chave da tabela, essa sim, e literal.
 */
export function prepararRetomada(tipo: string, bruta: unknown): RetomadaPreparada | null {
  if (!Object.prototype.hasOwnProperty.call(CONTRATOS, tipo)) return null;

  const chave = tipo as TipoComContratoResume;
  switch (chave) {
    case TIPO_CONSULTAR_VENDAS:
      return preparado(CONTRATOS[TIPO_CONSULTAR_VENDAS], bruta);
    case TIPO_CONSULTAR_PERGUNTAS_ML:
      return preparado(CONTRATOS[TIPO_CONSULTAR_PERGUNTAS_ML], bruta);
    default: {
      // Exaustividade real: um tipo novo em `CONTRATOS` sem `case` aqui
      // deixa de compilar. E o que impede a tabela e este acesso de
      // divergirem em silencio.
      const _exaustivo: never = chave;
      return _exaustivo;
    }
  }
}

/** Os tipos registrados, para inventario e para as suites. Copia, para
 *  que ninguem altere a tabela por aqui. */
export function tiposComContratoResume(): readonly string[] {
  return Object.keys(CONTRATOS);
}
