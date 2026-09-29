/**
 * `vendas.consultar` — os tres wrappers da primeira Funcao real.
 *
 * ── Por que o bloco saiu de `registry.ts` ───────────────────────────
 *
 * Nao e arrumacao. O tripwire J1 tocou em 583 linhas contra um limite
 * de 560, e a resposta a um alarme nao pode ser desligar o alarme. O
 * mesmo caminho ja foi percorrido pela `mercadolivre.perguntas.listar`
 * na M2-I1-A2: catalogo e MAPA, implementacao mora ao lado.
 *
 * O conteudo abaixo foi movido LITERALMENTE — mesmos corpos, mesmos
 * comentarios, mesma ordem. As unicas mudancas sao as tres palavras
 * `export` que tornam os wrappers alcancaveis pelo registry e os
 * imports que vieram junto. A suite compara o bloco por hash.
 *
 * ── Isto NAO e um segundo registry ──────────────────────────────────
 *
 * Aqui nao ha mapa, nao ha id e nao ha `Object.freeze` de catalogo.
 * Quem declara que `vendas.consultar` existe continua sendo `FUNCOES`
 * em `registry.ts`, e so ele. Este modulo exporta funcoes soltas; sem
 * o registry elas nao sao Funcao nenhuma.
 */
import "server-only";
import {
  criarLeiturasDeVendas,
  validarFiltroVendas,
  type FiltroVendas,
  type ResultadoVendas,
} from "@/lib/agentes/dados/vendas";
import type {
  ContextoFuncao,
  ResultadoInterpretacaoSaida,
  ResultadoValidacaoEntrada,
} from "@/lib/agentes/funcoes/registry";

/**
 * `vendas.consultar` — leitura das vendas pagas do dono numa janela.
 *
 * ── Por que ESTA operacao passa no criterio, e o handler nao ────────
 *
 * O executor NAO envolve `analise_vendas`. Ele usa
 * `criarLeiturasDeVendas`, que ja e um modulo de dominio proprio
 * (`lib/agentes/dados/vendas.ts`), desenhado como capability
 * independente muito antes desta fase:
 *
 *   - nao le, nao escreve e nao consulta `agente_tarefas`;
 *   - nao depende de status `rodando`, de claim nem de heartbeat;
 *   - nao escreve nada (zero `insert`/`update`/`delete`);
 *   - nao chama API externa (zero `fetch`);
 *   - fecha o `userId` por CLOSURE — a funcao devolvida NAO tem
 *     parametro de dono, entao nao existe assinatura pela qual o
 *     chamador peca dado de outro tenant.
 *
 * `analise_vendas`, por contraste, e o TIPO DE TAREFA que consome essa
 * leitura e ainda agrega, opcionalmente interpreta com IA e formata
 * resultado. Registrar o handler seria embrulho cosmetico; registrar a
 * leitura subjacente e reusar a operacao que ja significa "consultar
 * vendas".
 *
 * ── Idempotencia ────────────────────────────────────────────────────
 *
 * Leitura pura: repetir tem o mesmo efeito que executar uma vez. E o
 * motivo de a primeira Funcao real ser de leitura — escrita sob
 * semantica at-least-once exige contrato proprio de repeticao, que esta
 * fase nao decide.
 *
 * ── Validacao dos argumentos ────────────────────────────────────────
 *
 * Nao ha cast. `lerVendasDoPeriodo` ja chama `validarFiltroVendas`, que
 * e pura e recusa `filtro_ausente`, `data_invalida`, `periodo_invertido`,
 * `janela_excedida` e `marketplace_invalido` com codigos ESTAVEIS. Um
 * argumento arbitrario volta como erro classificado, nunca como consulta
 * ampla.
 */
export async function executarVendasConsultar(
  contexto: ContextoFuncao,
  argumentos: unknown
): Promise<ResultadoVendas> {
  const lerVendas = criarLeiturasDeVendas(contexto.userId);
  // O cast e apenas para satisfazer a assinatura; a VALIDACAO acontece
  // dentro, e recusa qualquer coisa que nao seja um filtro valido.
  return lerVendas(argumentos as FiltroVendas);
}

/**
 * `validarEntrada` de `vendas.consultar` — delegacao pura.
 *
 * `validarFiltroVendas` continua sendo a UNICA autoridade das regras:
 * `filtro_ausente`, `data_invalida`, `periodo_invertido`,
 * `janela_excedida` e `marketplace_invalido` nao sao recopiados aqui, e
 * o wrapper so traduz a forma (`erro: string | null`) para a uniao
 * discriminada que o executor generico consome.
 *
 * O cast existe pelo mesmo motivo do executor: `validarFiltroVendas`
 * recusa nao-objeto com `filtro_ausente` antes de tocar qualquer campo,
 * entao ele nunca confia no tipo.
 */
export function validarEntradaVendasConsultar(argumentos: unknown): ResultadoValidacaoEntrada {
  const validacao = validarFiltroVendas(argumentos as FiltroVendas);
  return validacao.erro === null ? { valida: true } : { valida: false, codigo: validacao.erro };
}

/**
 * A mensagem que o DONO le quando a consulta falha.
 *
 * Uma so, porque depois da validacao pre-execucao existe exatamente UM
 * codigo alcancavel (`erro_consulta_vendas`, devolvido pelo limite
 * inicial e pela paginacao). Nao e tabela de traducao: e a unica frase
 * que esta Funcao precisa. No dia em que forem cinco, a decisao volta a
 * ser gate.
 *
 * Nunca deriva de `error.message`, `details` ou `hint` do driver — o
 * modulo de dados ja descarta essas mensagens e registra so o codigo.
 */
const MENSAGEM_ERRO_VENDAS = "Nao foi possivel ler as vendas do periodo.";

/**
 * `interpretarSaida` de `vendas.consultar` — e por que ha checagem de
 * runtime aqui.
 *
 * `saida as ResultadoVendas` seria apagado na compilacao e nao provaria
 * nada: `null`, `[]`, `{}` e `{ erro: 123 }` passariam pelo cast e
 * quebrariam adiante, ou pior, virariam "sucesso". A forma minima e
 * conferida de verdade, e o que nao a respeita e `invalida`.
 *
 * As LINHAS nao sao validadas uma a uma: `ResultadoVendas` nao promete
 * mais do que "array", e exigir a forma de cada `LinhaVenda` inventaria
 * requisito que o contrato nao tem.
 *
 * `truncado` atravessa para o `data`. Silencia-lo entregaria um total
 * incompleto com cara de completo — o proprio contrato de
 * `ResultadoVendas` diz que quem consome PRECISA propagar isso.
 */
export function interpretarSaidaVendasConsultar(saida: unknown): ResultadoInterpretacaoSaida {
  if (typeof saida !== "object" || saida === null) return { tipo: "invalida" };
  const proto = Object.getPrototypeOf(saida);
  if (proto !== Object.prototype && proto !== null) return { tipo: "invalida" };

  const bruto = saida as Record<string, unknown>;
  if (!Array.isArray(bruto.linhas)) return { tipo: "invalida" };
  if (typeof bruto.truncado !== "boolean") return { tipo: "invalida" };

  const erro = bruto.erro;
  if (erro === null) {
    return {
      tipo: "sucesso",
      data: { linhas: bruto.linhas, truncado: bruto.truncado, erro: null },
    };
  }

  // String vazia nao e codigo de erro nem ausencia de erro: e saida que
  // nao respeita o proprio contrato.
  if (typeof erro !== "string" || erro.trim().length === 0) return { tipo: "invalida" };

  return {
    tipo: "erro",
    codigo: erro,
    mensagem: MENSAGEM_ERRO_VENDAS,
    // Leitura idempotente: repetir nao causa dano. Isto NAO pede retry —
    // nao existe retry no sistema, e o executor nao reexecuta nada.
    retryable: true,
  };
}
