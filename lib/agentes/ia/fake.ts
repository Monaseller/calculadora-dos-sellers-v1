/**
 * Adaptador FAKE determinístico — AGENTES-FASE1E-a.
 *
 * Este é o único adaptador que existe na 1E-a. Não há provedor real
 * nesta fase, e o fake não é degradação de um: é a implementação de
 * referência do contrato, e é infraestrutura de teste de produção — a
 * mesma doutrina que vale para `gerarConteudoFake()` do Estúdio.
 *
 * ── Garantias, todas verificáveis pela suíte ────────────────────────
 *   sem rede ......... nenhum `fetch`, nenhum SDK, nenhum socket
 *   sem env .......... não lê `process.env`, nem uma vez
 *   sem banco ........ não conhece Supabase
 *   sem relógio ...... não chama `Date.now()` nem `new Date()`
 *   sem aleatório .... não chama `Math.random()`
 *   sem arquivo ...... não escreve nada
 *
 * As duas últimas merecem explicação: relógio e aleatoriedade são as
 * formas mais comuns de um "fake determinístico" deixar de ser
 * determinístico sem que ninguém perceba. `tempoMs` é fixo em 0 de
 * propósito — um valor medido faria a mesma entrada produzir saídas
 * diferentes, e a suíte que compara duas execuções passaria a falhar
 * por motivo errado. Zero é honesto: nenhum tempo foi gasto, porque
 * nenhuma chamada foi feita.
 *
 * ── Ele valida de verdade ───────────────────────────────────────────
 * O fake roda `pedido.validar` sobre o conteúdo bruto, exatamente como
 * um provedor real fará. Se o bruto for inválido, o erro que sobe é o
 * da NOSSA validação, não um erro simulado — o caminho de recusa
 * exercitado nos testes é o mesmo que vai rodar em produção.
 *
 * ── Sem fallback ────────────────────────────────────────────────────
 * Modo de erro lança. Não devolve resposta parcial, não devolve `null`,
 * não "tenta de novo". Retry é decisão da tarefa (`tentativas` /
 * `max_tentativas`), nunca do adaptador — mesma regra já vigente para
 * os provedores reais do gateway.
 */
import { ErroProvedorIA } from "@/lib/ai-gateway/erros";
import type { TipoErroIA } from "@/lib/ai-gateway/tipos";
import type { AdaptadorIA, PedidoIA, RespostaEstruturadaIA } from "@/lib/agentes/ia/tipos";
import type { AnaliseVendasIA } from "@/lib/agentes/ia/contrato-analise";

/**
 * O que o fake faz quando chamado.
 *
 * `resposta_invalida` existe separado de `erro` porque são falhas
 * diferentes: em `erro` o provedor falhou; em `resposta_invalida` o
 * provedor respondeu e a NOSSA validação recusou. Testar só o primeiro
 * deixaria o segundo — o mais provável na prática — sem cobertura.
 */
export type ModoFake = "sucesso" | "erro" | "resposta_invalida";

export const MODELO_FAKE = "fake-agentes-analise-v1";

export interface OpcoesAdaptadorFake {
  modo?: ModoFake;
  /** Só em `modo: "erro"`. Padrão `transient`. */
  tipoErro?: TipoErroIA;
  /** Só em `modo: "erro"`. Mensagem que o `ErroProvedorIA` carrega. */
  mensagemErro?: string;
  /**
   * Conteúdo bruto a devolver antes da validação.
   *
   * Em `modo: "sucesso"`, ausente = usa `montarAnaliseFake(pedido)`.
   * Em `modo: "resposta_invalida"`, é o bruto malformado que o teste
   * quer ver recusado — e aí ele é obrigatório, porque um "inválido"
   * padrão inventado por este módulo esconderia qual desvio está
   * realmente sendo exercitado.
   *
   * `unknown` de propósito: o ponto do fake é conseguir devolver coisas
   * que o tipo `T` proíbe.
   */
  bruto?: unknown;
  modelo?: string;
  tokensEntrada?: number;
  tokensSaida?: number;
}

/**
 * O adaptador mais o registro do que ele recebeu.
 *
 * `chamadas` existe para que a suíte prove afirmações sobre a ENTRADA —
 * inclusive a mais importante delas: que nada de identidade, segredo ou
 * acesso atravessou o contrato. Sem espião, "o pedido não contém
 * `user_id`" seria opinião.
 *
 * `chamadas` é populado ANTES de qualquer decisão de modo: uma chamada
 * que termina em erro também fica registrada. Espião que só enxerga o
 * caminho feliz não serve para auditar o infeliz.
 */
export interface AdaptadorFake {
  adaptador: AdaptadorIA;
  chamadas: PedidoIA<unknown>[];
}

/**
 * Saída determinística padrão do modo `sucesso`.
 *
 * Derivada apenas do comprimento dos textos do pedido — função pura da
 * entrada, sem relógio e sem contador global. Duas chamadas com o mesmo
 * pedido produzem strings idênticas; pedidos diferentes produzem
 * strings diferentes.
 *
 * O prefixo `[fake]` é obrigatório e não é decoração: se este texto
 * vazar para uma tela real, tem que ser óbvio na hora que ele não veio
 * de modelo nenhum. Um fake que se disfarça de resposta real é pior que
 * não ter fake.
 */
export function montarAnaliseFake(pedido: PedidoIA<unknown>): AnaliseVendasIA {
  return {
    resumo:
      `[fake] análise determinística sobre ${pedido.dados.length} caracteres de dados ` +
      `e ${pedido.instrucao.length} de instrução. Nenhum provedor foi chamado.`,
    destaques: [`[fake] destaque derivado de ${pedido.dados.length} caracteres`],
    alertas: [],
  };
}

/**
 * Cria um adaptador fake. Nada aqui é lido de ambiente: todo o
 * comportamento vem das opções, o que torna cada teste explícito sobre
 * o cenário que exercita.
 */
export function criarAdaptadorFake(opcoes: OpcoesAdaptadorFake = {}): AdaptadorFake {
  const chamadas: PedidoIA<unknown>[] = [];
  const modo: ModoFake = opcoes.modo ?? "sucesso";

  const adaptador = async <T>(pedido: PedidoIA<T>): Promise<RespostaEstruturadaIA<T>> => {
    chamadas.push(pedido as PedidoIA<unknown>);

    if (modo === "erro") {
      throw new ErroProvedorIA(
        opcoes.tipoErro ?? "transient",
        opcoes.mensagemErro ?? "[fake] falha simulada de provedor."
      );
    }

    if (modo === "resposta_invalida" && !("bruto" in opcoes)) {
      // Não inventamos um inválido padrão — ver docblock de `bruto`.
      throw new ErroProvedorIA(
        "validation",
        '[fake] modo "resposta_invalida" exige `bruto` explícito nas opções.'
      );
    }

    const bruto = "bruto" in opcoes ? opcoes.bruto : montarAnaliseFake(pedido);

    // A validação é do chamador e roda sempre — inclusive no caminho
    // feliz. Se ela lançar, o erro sobe intacto: o fake não o converte,
    // não o embrulha e não o engole.
    const conteudo = pedido.validar(bruto);

    return {
      conteudo,
      provedor: "fake",
      modelo: opcoes.modelo ?? MODELO_FAKE,
      tokensEntrada: opcoes.tokensEntrada ?? 0,
      tokensSaida: opcoes.tokensSaida ?? 0,
      tempoMs: 0,
    };
  };

  return { adaptador, chamadas };
}
