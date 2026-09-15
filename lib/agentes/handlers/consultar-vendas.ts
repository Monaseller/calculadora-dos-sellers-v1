/**
 * Handler `consultar_vendas` — FUNCTION-RUNTIME-V1-A.
 *
 * ── O que esta etapa prova ──────────────────────────────────────────
 *
 * Que uma TAREFA da fila consegue executar uma FUNCAO real, passando
 * pelo guard de permissao, pela auditoria de Tool Call e pela Approval
 * — e que o terceiro desfecho publicado pela FUNCTION-RUNTIME-P0
 * (`rodando -> aguardando_aprovacao`) finalmente tem quem o produza.
 *
 * ── A EXCECAO ARQUITETURAL, nomeada ─────────────────────────────────
 *
 * A doutrina vigente e que handler NAO alcanca `execucao-funcoes`:
 * `conversa` e proibido de faze-lo, e ha assert que o prova. Este
 * arquivo e a UNICA excecao ratificada, e ela e nominal — nao e
 * liberacao geral. O motivo e concreto: `conversa` entrega ao modelo
 * uma instrucao e uma mensagem, e um modelo sem tools nao alcanca dado
 * que ninguem lhe deu; aqui a Funcao E o proposito da tarefa, decidido
 * antes de qualquer execucao, sem modelo nenhum no caminho.
 *
 * ── A tarefa NAO escolhe a Funcao ───────────────────────────────────
 *
 * `FUNCAO_ID` e constante deste modulo. A entrada da tarefa carrega
 * APENAS o filtro. Nao ha `funcaoId` no shape aceito, nao ha tool
 * calling, nao ha modelo decidindo ferramenta: a tarefa ja nasce
 * sabendo qual e a operacao dela.
 *
 * ── Quem valida o que ───────────────────────────────────────────────
 *
 * Este handler valida ESTRUTURA e nada mais: as tres chaves conhecidas,
 * tipos, e recusa de propriedade extra. Regex de data, calendario,
 * ordem das pontas, janela de 14 dias e enum de marketplace pertencem a
 * `validarFiltroVendas`, que e a autoridade dessas regras e ja e
 * chamada por `executarFuncao` antes de abrir a Tool Call. Recopia-las
 * aqui criaria a segunda fonte de verdade que o registry de Funcoes
 * existe para impedir.
 *
 * O handler CLASSIFICA o codigo que aquele validador devolveu — isso
 * nao e validar de novo, e ler o veredicto alheio.
 *
 * ── Por que o resultado e um agregado, e nao as linhas ──────────────
 *
 * Um unico dia real desta base tem milhares de linhas, e
 * `agente_tarefas.resultado` e `jsonb` de uma fila, nao um data lake.
 * O agregado abaixo tem TETO ESTRUTURAL: nenhum campo cresce com o
 * volume, os buckets de marketplace sao fixos, e nao ha lista de SKU
 * nem de pedido. Um dia com 25 linhas e um com 3.576 produzem JSON do
 * mesmo tamanho.
 *
 * ── A logica pura vive em `consultar-vendas-contrato.ts` ────────────
 *
 * Leitura da entrada, agregacao e traducao dos desfechos sairam daqui
 * por EXTRACAO, sem alteracao, para que a retomada pos-aprovacao use as
 * MESMAS referencias — nao copias que precisariam concordar. Este
 * arquivo ficou com o que so ele faz: chamar o executor de Funcoes.
 *
 * Os simbolos continuam alcancaveis por aqui, reexportados: quem ja
 * importava deste caminho nao precisa mudar, e o reexport devolve a
 * MESMA funcao, nunca um invólucro novo.
 */
import { executarFuncao } from "@/lib/agentes/execucao-funcoes/executar";
import type {
  ContextoTarefa,
  HandlerTarefa,
  RelatarProgresso,
} from "@/lib/agentes/tipos-execucao";
import {
  FUNCAO_ID,
  lerEntradaConsultarVendas,
  mapearResultadoConsultarVendas,
} from "@/lib/agentes/handlers/consultar-vendas-contrato";

// Reexport de COMPATIBILIDADE: mesma referencia, zero invólucro.
export {
  agregarConsultaDeVendas,
  FUNCAO_ID,
  lerEntradaConsultarVendas,
  mapearResultadoConsultarVendas,
  TIPO_CONSULTAR_VENDAS,
} from "@/lib/agentes/handlers/consultar-vendas-contrato";
export type {
  AgregadoConsultarVendas,
  BucketMarketplace,
  EntradaConsultarVendas,
  ResumoConsultarVendas,
} from "@/lib/agentes/handlers/consultar-vendas-contrato";

// ─── O handler ────────────────────────────────────────────────────────

/**
 * A fabrica. `userId` fica preso AQUI, na closure, fora do alcance do
 * handler — mesmo padrao de `analise_vendas` e `conversa`.
 *
 * O handler recebe o ALVO pelo contexto (`agenteId`, `tarefaId`) e o
 * PODER daqui. Nao ha assinatura pela qual ele peca dado de outro dono,
 * e `contexto.userId` deliberadamente NAO e usado: o valor seria o
 * mesmo, mas o handler passaria a ter uma variavel de dono ao alcance.
 */
export function criarHandlerConsultarVendas(userId: string): HandlerTarefa {
  return async function handlerConsultarVendas(
    contexto: ContextoTarefa,
    relatarProgresso: RelatarProgresso
  ): Promise<Record<string, unknown>> {
    relatarProgresso(0);

    const entrada = lerEntradaConsultarVendas(contexto.entrada);

    // Vem da LINHA da tarefa, nunca da entrada. Vazio aqui e defeito
    // nosso, nao pedido malformado — por isso nao e `ErroEntradaTarefa`.
    if (!contexto.agenteId) throw new Error("contexto sem agenteId");
    // `tarefaId` e OBRIGATORIO neste caminho, e nao por simetria: ele
    // entra no fingerprint da Approval (duas tarefas pedindo a mesma
    // acao nao podem colidir), e `executarFuncao` o usa para provar
    // posse da tarefa. `null` aqui descartaria as duas coisas.
    if (!contexto.tarefaId) throw new Error("contexto sem tarefaId");

    relatarProgresso(25);

    const resultado = await executarFuncao({
      userId,
      agenteId: contexto.agenteId,
      tarefaId: contexto.tarefaId,
      funcaoId: FUNCAO_ID,
      argumentos: {
        dataInicio: entrada.dataInicio,
        dataFim: entrada.dataFim,
        marketplace: entrada.marketplace,
      },
    });

    relatarProgresso(75);

    // O `switch` exaustivo vive em `mapearResultadoConsultarVendas`, que
    // e pura e por isso PODE ser provada variante a variante. Aqui so
    // resta devolver o que ela devolveu — ou deixar subir o que ela
    // lancou, inclusive `PausaPorAprovacao`.
    const saida = mapearResultadoConsultarVendas(resultado, entrada);
    relatarProgresso(100);
    return saida;
  };
}
