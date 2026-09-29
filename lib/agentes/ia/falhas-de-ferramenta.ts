/**
 * Classificacao de falha de ferramenta — AGENT-FACTORY-F4.1.
 *
 * ── O que o F4 encontrou na conversa REAL ───────────────────────────
 *
 * O provedor pediu `calculadora.calcular`, o guard NEGOU, o modelo
 * recebeu a recusa como resultado de ferramenta — e respondeu:
 *
 *   "parece que a ferramenta nao esta disponivel. Mas posso fazer o
 *    calculo para voce: R$ 184.530,20 - R$ 137.810,55 = R$ 46.719,65"
 *
 * Acertou. Nao vai acertar sempre, e o problema nao e o acerto: e que
 * um numero que NENHUMA ferramenta produziu saiu com a mesma cara de um
 * numero verificado. Num ERP financeiro isso e a mesma falha que o
 * repositorio ja proibe em outro lugar — "nunca usar estimativa".
 *
 * ── Por que a solucao NAO pode ser so instrucao ─────────────────────
 *
 * Instrucao e pedido; o modelo atende quase sempre e falha exatamente
 * quando o caso e dificil. O que fecha de verdade e nao DAR ao modelo o
 * turno seguinte: se ele nao e chamado de novo, nao ha onde escrever o
 * numero. A instrucao continua existindo (ver `INSTRUCAO_SEM_ESTIMATIVA`)
 * como defesa em profundidade, nunca como a cerca.
 *
 * ── A distincao que este modulo faz ─────────────────────────────────
 *
 * Nem toda falha fecha o turno, e tratar todas igual seria pior: um
 * nome de coluna errado e um pedido MAL FEITO, e o modelo consegue
 * corrigir sozinho. Entao:
 *
 *   FECHA O TURNO   a ferramenta ou a fonte NAO ESTAVA disponivel —
 *                   permissao, aprovacao, conexao, fonte, auditoria.
 *                   Nenhuma insistencia do modelo muda isso, e qualquer
 *                   resposta dele seria substituicao.
 *
 *   CORRIGIVEL      o pedido estava errado — argumento invalido, aba ou
 *                   coluna inexistente. O proximo turno e util, e o
 *                   modelo pode acertar com o que a propria recusa
 *                   contou. Isto NAO e fallback generico: e uma lista
 *                   fechada, e o que nao esta nela fecha.
 *
 * Os codigos abaixo sao os REAIS, lidos de `guard.ts`,
 * `execucao-funcoes/executar.ts`, `planilhas/fonte.ts` e
 * `funcoes/planilha.ts`. Nenhum foi inventado para esta classificacao.
 */

/**
 * Desfechos de `ResultadoExecucaoFuncao` que fecham o turno.
 *
 * `negado` cobre `permissao_ausente`, `permissao_bloqueada`,
 * `conexao_ausente` e `funcao_inexistente` — o guard ja os colapsa num
 * unico desfecho terminal.
 */
export const DESFECHOS_QUE_FECHAM = Object.freeze([
  "negado",
  "aguardando_aprovacao",
  "aprovacao_indisponivel",
  "indisponivel",
  "falha_auditoria",
  "nome_invalido",
] as const);

/**
 * Codigos de DOMINIO que fecham o turno mesmo vindo com desfecho
 * `erro`.
 *
 * Todos querem dizer a mesma coisa: a FONTE nao estava la. Sem ela nao
 * existe resposta verificavel, e o modelo nao pode inventar o conteudo
 * de um arquivo que ninguem leu.
 */
export const CODIGOS_DE_FONTE_QUE_FECHAM = Object.freeze([
  "fonte_nao_configurada",
  "fonte_indisponivel",
  "arquivo_nao_encontrado",
  "file_id_invalido",
  "extensao_nao_suportada",
  "arquivo_ilegivel",
  "fonte_inativa",
  "fonte_de_outro_dono",
] as const);

/**
 * Codigos que o modelo PODE corrigir sozinho.
 *
 * Lista fechada e curta de proposito. Tudo que nao estiver aqui e nao
 * for `sucesso` fecha o turno — a regra e fail-closed, e a excecao e
 * que precisa ser escrita.
 */
export const CODIGOS_CORRIGIVEIS = Object.freeze([
  "aba_inexistente",
  "coluna_inexistente",
  "entrada_nao_objeto",
  "campo_desconhecido",
  "operacao_invalida",
  "operacao_ausente",
  "periodo_invalido",
  "aridade_invalida",
  "valores_ausentes",
  "valores_demais",
  "valor_nao_escalar",
  "limite_invalido",
  "limite_acima_do_teto",
  "inicio_invalido",
  "aba_invalida",
  "colunas_invalidas",
  "coluna_invalida",
  "agrupamento_invalido",
  "filtros_invalidos",
  "operador_invalido",
  "file_id_ausente",
] as const);

export type ClasseDeFalha = "fecha_o_turno" | "corrigivel";

/**
 * Classifica UMA falha.
 *
 * `desfecho` e o `tipo` de `ResultadoExecucaoFuncao`; `codigo` e o
 * codigo de dominio quando houver. O default e FECHAR: um codigo novo
 * que ninguem classificou nao deve virar permissao para o modelo
 * responder por conta propria.
 */
export function classificarFalha(
  desfecho: string,
  codigo?: string | null
): ClasseDeFalha {
  if ((DESFECHOS_QUE_FECHAM as readonly string[]).includes(desfecho)) {
    return "fecha_o_turno";
  }
  if (codigo != null && (CODIGOS_DE_FONTE_QUE_FECHAM as readonly string[]).includes(codigo)) {
    return "fecha_o_turno";
  }
  if (codigo != null && (CODIGOS_CORRIGIVEIS as readonly string[]).includes(codigo)) {
    return "corrigivel";
  }
  return "fecha_o_turno";
}

/**
 * O texto que o RUNTIME devolve quando o turno fecha.
 *
 * Escrito aqui, e nao pelo modelo. E de proposito que ele nao tenta
 * explicar a causa tecnica: `permissao_bloqueada` e `fonte_indisponivel`
 * sao informacao de operador, e detalhar para o usuario final daria
 * pistas sobre o que existe na conta de outra pessoa.
 */
export const MENSAGEM_DE_BLOQUEIO =
  "Nao consigo concluir porque a ferramenta ou fonte necessaria nao esta " +
  "disponivel para este agente. Nao vou estimar o resultado.";

/**
 * Instrucao acrescentada ao contexto do agente.
 *
 * Defesa em profundidade, jamais a cerca: PROMPT != SECURITY_BOUNDARY.
 * Ela reduz o caso em que o modelo TENTA substituir; quem impede e o
 * laco nao lhe dar o turno seguinte.
 */
export const INSTRUCAO_SEM_ESTIMATIVA =
  "Quando uma informacao ou calculo depender de uma ferramenta e essa " +
  "ferramenta falhar, for negada ou nao tiver os dados necessarios, NAO " +
  "substitua o resultado por estimativa, memoria ou calculo mental. " +
  "Informe que nao foi possivel verificar.";
