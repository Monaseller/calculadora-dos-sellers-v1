/**
 * Contrato do tipo de tarefa `consultar_perguntas_ml` — M2-I1-A7.
 *
 * ── Por que contrato SEPARADO do handler ────────────────────────────
 *
 * Mesma razao de `consultar-vendas-contrato.ts`: este modulo e PURO.
 * Nao importa executor, nem cliente de banco, nem env, nem rede.
 * `ResultadoExecucaoFuncao` entra por `import type`, que some na
 * compilacao e por isso nao cria aresta de runtime. E o que permite
 * `resume-contratos` alcancar a preparacao e a continuacao sem passar
 * pelo handler que executa.
 */
import { ErroEntradaTarefa, PausaPorAprovacao } from "@/lib/agentes/erros";
import type { ResultadoExecucaoFuncao } from "@/lib/agentes/execucao-funcoes/executar";
import type { PerguntaRecebida } from "@/lib/agentes/dados/perguntas";

/** O tipo de tarefa. A constante e a chave do registry — a suite prova
 *  que as duas sao a mesma string. */
export const TIPO_CONSULTAR_PERGUNTAS_ML = "consultar_perguntas_ml";

/**
 * A Funcao executada. CONSTANTE do modulo, nunca da entrada.
 *
 * Se viesse do `contexto.entrada`, uma tarefa enfileirada poderia
 * escolher qual capacidade invocar — e o guard passaria a proteger uma
 * decisao que o proprio pedido tomou. O produtor do polling monta a
 * `entrada` campo a campo justamente para que `funcaoId` nao tenha por
 * onde viajar nela.
 */
export const FUNCAO_ID = "mercadolivre.perguntas.listar";

// ─── Entrada ──────────────────────────────────────────────────────────

/**
 * O filtro, PLANO — mesma forma de `FiltroPerguntas`, sem envelope.
 *
 * `lojaId` NAO esta aqui, e a ausencia e o ponto: a conta vem do
 * binding, resolvida pelo executor e conferida pelo handler da Funcao.
 * Uma tarefa que carregasse `lojaId` ofereceria um seletor de conta a
 * quem enfileira.
 */
export interface EntradaConsultarPerguntasML {
  readonly status: string | null;
  readonly limite: number | null;
  readonly deslocamento: number | null;
}

const CHAVES_ACEITAS = ["status", "limite", "deslocamento"] as const;

/**
 * Le a entrada CRUA da linha da tarefa.
 *
 * ── FORMA, nao REGRA ────────────────────────────────────────────────
 *
 * Esta funcao confere que o objeto tem a forma esperada e nada alem
 * dela. Ela NAO decide se `limite` cabe no maximo, se `status` e um dos
 * valores aceitos, nem qual e o default — isso e `validarFiltroPerguntas`,
 * a autoridade unica dessas regras, e recopia-las aqui criaria uma
 * segunda verdade que divergiria no primeiro conserto feito de um lado so.
 *
 * Propriedade extra REPROVA. Ignora-la silenciosamente deixaria um
 * `funcaoId`, um `userId` ou um `lojaId` viajar na entrada sem que nada
 * acusasse — e o teste que prova isso e o mesmo que prova o contrato de
 * vendas.
 */
export function lerEntradaConsultarPerguntasML(
  bruta: unknown
): EntradaConsultarPerguntasML {
  if (typeof bruta !== "object" || bruta === null || Array.isArray(bruta)) {
    throw new ErroEntradaTarefa("entrada da tarefa nao e um objeto");
  }

  const entrada = bruta as Record<string, unknown>;

  for (const chave of Object.keys(entrada)) {
    if (!(CHAVES_ACEITAS as readonly string[]).includes(chave)) {
      throw new ErroEntradaTarefa(`propriedade nao aceita na entrada: ${chave}`);
    }
  }

  const status = entrada.status;
  if (status !== undefined && typeof status !== "string") {
    throw new ErroEntradaTarefa("status deve ser string");
  }

  const limite = entrada.limite;
  if (limite !== undefined && typeof limite !== "number") {
    throw new ErroEntradaTarefa("limite deve ser numero");
  }

  const deslocamento = entrada.deslocamento;
  if (deslocamento !== undefined && typeof deslocamento !== "number") {
    throw new ErroEntradaTarefa("deslocamento deve ser numero");
  }

  return {
    status: status ?? null,
    limite: limite ?? null,
    deslocamento: deslocamento ?? null,
  };
}

/**
 * Os argumentos da Funcao, montados a partir da entrada.
 *
 * Chave ausente NAO vira `null`: `validarFiltroPerguntas` trata campo
 * opcional como AUSENTE, e mandar `null` seria mandar um valor que ela
 * teria de recusar. Omitir e o que preserva o default do dominio.
 */
export function argumentosDaEntrada(
  entrada: EntradaConsultarPerguntasML
): Record<string, unknown> {
  const argumentos: Record<string, unknown> = {};
  if (entrada.status !== null) argumentos.status = entrada.status;
  if (entrada.limite !== null) argumentos.limite = entrada.limite;
  if (entrada.deslocamento !== null) argumentos.deslocamento = entrada.deslocamento;
  return argumentos;
}

// ─── Resultado ────────────────────────────────────────────────────────

interface DadosPerguntas {
  readonly linhas: readonly PerguntaRecebida[];
  readonly truncado: boolean;
}

/**
 * Le `envelope.data` como `ResultadoPerguntas`.
 *
 * Checagem ESTRUTURAL mesmo o executor ja tendo interpretado a saida:
 * o envelope carrega `unknown` por contrato, e confiar nele aqui seria
 * confiar num `as` disfarcado de leitura.
 */
function lerDadosDaFuncao(data: unknown): DadosPerguntas {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("funcao_saida_invalida");
  }
  const o = data as Record<string, unknown>;
  if (!Array.isArray(o.linhas)) throw new Error("funcao_saida_invalida");
  if (typeof o.truncado !== "boolean") throw new Error("funcao_saida_invalida");
  return { linhas: o.linhas as readonly PerguntaRecebida[], truncado: o.truncado };
}

/**
 * Os codigos que significam "o pedido estava errado", e nao "o motor
 * quebrou".
 *
 * Os QUATRO de `validarFiltroPerguntas`, copiados da fonte e nao
 * imaginados — ela e a autoridade, e a lista dela e fechada. Um codigo
 * a mais aqui classificaria como erro de entrada algo que o validador
 * nunca produz; um a menos mandaria um pedido malformado terminar como
 * falha do motor.
 */
const CODIGOS_DE_ENTRADA = [
  "filtro_ausente",
  "status_invalido",
  "limite_invalido",
  "deslocamento_invalido",
] as const;

const ehCodigoDeEntrada = (codigo: string): boolean =>
  (CODIGOS_DE_ENTRADA as readonly string[]).includes(codigo);

/**
 * Traduz o desfecho da Funcao no resultado da TAREFA.
 *
 * As SETE variantes, exaustivamente, com `never` no default — e nao
 * `if/else`: o compilador passa a recusar uma variante nova nao tratada.
 * Um fallback generico engoliria `aguardando_aprovacao`, e uma Approval
 * real ficaria pendente com a tarefa mentindo que falhou.
 *
 * Mesma arvore de `mapearResultadoConsultarVendas`, e nao um helper
 * compartilhado: os dois tipos divergem no ramo de SUCESSO, que e o que
 * cada contrato tem de proprio. Um helper comum precisaria de um
 * parametro para o unico ramo que difere, o que e a mesma coisa escrita
 * de forma mais dificil de provar.
 */
export function mapearResultadoConsultarPerguntasML(
  resultado: ResultadoExecucaoFuncao,
  entrada: EntradaConsultarPerguntasML
): Record<string, unknown> {
  switch (resultado.tipo) {
    case "sucesso": {
      const dados = lerDadosDaFuncao(resultado.envelope.data);
      return {
        filtro: {
          status: entrada.status,
          limite: entrada.limite,
          deslocamento: entrada.deslocamento,
        },
        // As perguntas JA vem normalizadas pelo dominio: cinco chaves,
        // nenhuma credencial, nenhum campo do provider. Este contrato
        // nao as reinterpreta — copiar o array seria a oportunidade de
        // alguem "enriquecer" uma pergunta com algo que nao veio dela.
        perguntas: dados.linhas,
        total: dados.linhas.length,
        // `truncado` ATRAVESSA. Um total incompleto com cara de completo
        // e exatamente o que o contrato de `ResultadoPerguntas` existe
        // para impedir.
        truncado: dados.truncado,
      };
    }

    case "aguardando_aprovacao":
      // EXATAMENTE isto. A Approval ja foi criada ou reutilizada por
      // `executarFuncao`; a pausa da tarefa e do executor. O handler nao
      // chama RPC, nao decide e nao consome aprovacao.
      throw new PausaPorAprovacao(resultado.aprovacaoId);

    case "negado":
      // Termina, nao pausa. `permissao_bloqueada` e decisao ja tomada
      // pelo dono; `conexao_ausente` pede configuracao na aba Conexoes.
      // Esperar por qualquer uma seria esperar para sempre.
      throw new Error(`funcao_negada:${resultado.codigo}`);

    case "erro": {
      const codigo = resultado.envelope.error.code;
      if (ehCodigoDeEntrada(codigo)) throw new ErroEntradaTarefa(`entrada_invalida:${codigo}`);
      // So o CODIGO, que e vocabulario fechado e ja sanitizado.
      // `envelope.error.message` nao viaja: o adapter ja descartou corpo,
      // header e status do provider, e repetir a frase aqui nao
      // acrescenta fato nenhum.
      throw new Error(`funcao_erro:${codigo}`);
    }

    case "aprovacao_indisponivel":
      throw new Error(`aprovacao_indisponivel:${resultado.codigo}`);

    case "falha_auditoria":
      throw new Error(`falha_auditoria:${resultado.etapa}`);

    case "indisponivel":
      throw new Error("funcao_indisponivel");

    default: {
      const _exaustivo: never = resultado;
      return _exaustivo;
    }
  }
}
