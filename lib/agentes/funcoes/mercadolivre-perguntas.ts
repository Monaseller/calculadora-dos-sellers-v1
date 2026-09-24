/**
 * `mercadolivre.perguntas.listar` — executor, validador e interpretador.
 *
 * ── Por que este arquivo existe ─────────────────────────────────────
 *
 * `vendas.consultar` tem os tres wrappers dentro de `registry.ts`, e
 * isso cabia enquanto havia UMA Funcao. Uma segunda no mesmo padrao
 * levaria o catalogo a ~640 linhas contra um tripwire de 560 — e a
 * resposta nao podia ser subir o tripwire, que existe justamente para
 * forcar esta decisao. Entao a implementacao da Funcao NOVA sai, e o
 * registry volta a ser o que ele promete ser: o mapa.
 *
 * `vendas.consultar` NAO foi movida. Move-la seria mexer num contrato
 * congelado para arrumar a casa, e a arrumacao nao e razao suficiente.
 *
 * ── O que continua no registry ──────────────────────────────────────
 *
 * A ENTRADA. A existencia de uma Funcao continua sendo a presenca dela
 * em `FUNCOES`, num objeto congelado, num arquivo so — nada aqui se
 * auto-registra, e nenhum import decide identidade.
 *
 * ── Este modulo nunca ve credencial ─────────────────────────────────
 *
 * Ele recebe `ContextoFuncao`, que tem `userId` e o binding sanitizado.
 * Quem resolve token e `lib/mercado-livre-perguntas.ts`, atras do
 * dominio. Aqui nao ha `fetch`, nao ha Supabase e nao ha `Authorization`.
 */
import "server-only";
import {
  criarLeiturasDePerguntas,
  validarFiltroPerguntas,
  type FiltroPerguntas,
  type ResultadoPerguntas,
} from "@/lib/agentes/dados/perguntas";
import type {
  ContextoFuncao,
  ResultadoInterpretacaoSaida,
  ResultadoValidacaoEntrada,
} from "@/lib/agentes/funcoes/registry";

/** O requisito de conexao desta Funcao, na forma que o guard consome. */
export const CONEXAO_PERGUNTAS_ML = Object.freeze({
  plataforma: "mercado_livre",
  recurso: "perguntas",
});

/**
 * O executor.
 *
 * ── A loja vem do CONTEXTO, e de nenhum outro lugar ─────────────────
 *
 * `contexto.conexao.lojaId` e o binding que o agregador validou e que o
 * guard autorizou. Os argumentos NAO participam dessa decisao: um
 * `lojaId` neles seria um seletor de conta oferecido a quem chama — e
 * quem chama pode ser um modelo. `validarEntrada` recusa qualquer campo
 * que nao seja `status`, `limite` ou `deslocamento`, entao nem chega a
 * existir um `args.lojaId` para alguem preferir.
 *
 * ── Fail-closed na ausencia e na incompatibilidade ──────────────────
 *
 * O executor generico so monta `conexao` quando a definicao declara
 * requisito, e o guard so permite quando o fato serve. Mesmo assim os
 * tres campos sao conferidos aqui: se um dia outro caminho alcancar esta
 * funcao, ela recusa em vez de agir contra a conta errada. `null` do
 * `conexao`, plataforma diferente ou recurso diferente terminam em
 * `conexao_invalida` — nunca em "escolhe a primeira loja".
 */
export async function executarPerguntasML(
  contexto: ContextoFuncao,
  argumentos: unknown
): Promise<ResultadoPerguntas> {
  const conexao = contexto.conexao;

  if (
    conexao === null ||
    conexao.plataforma !== CONEXAO_PERGUNTAS_ML.plataforma ||
    conexao.recurso !== CONEXAO_PERGUNTAS_ML.recurso ||
    !conexao.lojaId
  ) {
    return {
      linhas: [], truncado: false, erro: "conexao_invalida",
      providerRecebidas: 0, descartadasNormalizacao: 0,
    };
  }

  // O orcamento vem do CONTEXTO — nunca dos argumentos. Ausente, o
  // adapter usa o limite proprio dele, como sempre usou.
  const lerPerguntas = criarLeiturasDePerguntas(
    contexto.userId, conexao.lojaId, undefined,
    contexto.limiteDoProvider, contexto.sinalDoBanco);
  // O cast satisfaz a assinatura; a VALIDACAO acontece dentro, e
  // `validarFiltroPerguntas` recusa nao-objeto antes de tocar campo.
  return lerPerguntas(argumentos as FiltroPerguntas);
}

/**
 * `validarEntrada` — delegacao pura, no mesmo desenho de
 * `vendas.consultar`.
 *
 * `validarFiltroPerguntas` continua sendo a unica autoridade das regras;
 * este wrapper so traduz `{ erro: string | null }` para a uniao
 * discriminada que o executor generico consome.
 */
export function validarEntradaPerguntasML(argumentos: unknown): ResultadoValidacaoEntrada {
  const validacao = validarFiltroPerguntas(argumentos);
  return validacao.erro === null ? { valida: true } : { valida: false, codigo: validacao.erro };
}

/**
 * As mensagens que o DONO le.
 *
 * Uma por codigo alcancavel, e nenhuma delas deriva de texto do
 * provider: `resposta.text()` nunca sobe, `error.message` nunca sobe, e
 * status HTTP nao aparece. Sao seis frases porque sao seis situacoes
 * com acoes diferentes — reconectar, esperar, tentar depois, avisar.
 */
const MENSAGENS_ERRO: Readonly<Record<string, string>> = Object.freeze({
  conexao_invalida: "Nao ha conta do Mercado Livre ligada a este agente para perguntas.",
  credencial_ausente: "A conta do Mercado Livre precisa ser reconectada.",
  nao_autorizado: "O Mercado Livre recusou o acesso as perguntas desta conta.",
  limite_excedido: "O Mercado Livre limitou as consultas agora. Tente mais tarde.",
  indisponivel: "Nao foi possivel falar com o Mercado Livre agora.",
  resposta_invalida: "O Mercado Livre respondeu num formato que nao reconhecemos.",
});

const MENSAGEM_GENERICA = "Nao foi possivel ler as perguntas recebidas.";

/**
 * Codigos em que REPETIR e seguro.
 *
 * Leitura idempotente, entao repetir nunca causa dano — mas `retryable`
 * nao e sobre dano, e sim sobre a chance de o proximo resultado ser
 * diferente. Reconectar uma conta e permissao recusada nao mudam
 * sozinhos; rede, limite e 5xx, sim.
 *
 * Isto NAO pede retry: nao existe retry neste sistema, e o executor nao
 * reexecuta nada.
 */
const REPETIVEIS: ReadonlySet<string> = new Set(["limite_excedido", "indisponivel"]);

/**
 * `interpretarSaida` — checagem de runtime de verdade.
 *
 * `saida as ResultadoPerguntas` seria apagado na compilacao e nao
 * provaria nada: `null`, `[]`, `{}` passariam pelo cast e virariam
 * "sucesso". A forma minima e conferida, e o que nao a respeita e
 * `invalida`.
 *
 * As LINHAS nao sao revalidadas uma a uma: `normalizarPergunta` ja
 * recusou item a item na camada de dominio, e conferir de novo aqui
 * criaria uma segunda autoridade sobre a mesma forma.
 */
export function interpretarSaidaPerguntasML(saida: unknown): ResultadoInterpretacaoSaida {
  if (typeof saida !== "object" || saida === null) return { tipo: "invalida" };
  const proto = Object.getPrototypeOf(saida);
  if (proto !== Object.prototype && proto !== null) return { tipo: "invalida" };

  const bruto = saida as Record<string, unknown>;
  if (!Array.isArray(bruto.linhas)) return { tipo: "invalida" };
  if (typeof bruto.truncado !== "boolean") return { tipo: "invalida" };
  // As duas contagens sao obrigatorias e inteiras nao negativas.
  // Aceitar ausencia como zero faria uma pagina cheia de itens
  // malformados parecer vazia, e quem pagina pararia cedo demais.
  const contagem = (v: unknown): number | null =>
    typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
  const providerRecebidas = contagem(bruto.providerRecebidas);
  const descartadasNormalizacao = contagem(bruto.descartadasNormalizacao);
  if (providerRecebidas === null || descartadasNormalizacao === null) {
    return { tipo: "invalida" };
  }

  const erro = bruto.erro;
  if (erro === null) {
    return {
      tipo: "sucesso",
      // `truncado` atravessa: silencia-lo entregaria uma pagina com cara
      // de lista inteira, e o agente concluiria que nao ha mais perguntas.
      data: {
        linhas: bruto.linhas,
        truncado: bruto.truncado,
        erro: null,
        // Aditivo. Consumidores existentes leem so `linhas` e `truncado`
        // e ignoram o resto; quem pagina precisa da janela BRUTA.
        providerRecebidas,
        descartadasNormalizacao,
      },
    };
  }

  // String vazia nao e codigo de erro nem ausencia de erro: e saida que
  // nao respeita o proprio contrato.
  if (typeof erro !== "string" || erro.trim().length === 0) return { tipo: "invalida" };

  return {
    tipo: "erro",
    codigo: erro,
    mensagem: MENSAGENS_ERRO[erro] ?? MENSAGEM_GENERICA,
    retryable: REPETIVEIS.has(erro),
  };
}
