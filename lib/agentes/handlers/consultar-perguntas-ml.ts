/**
 * Handler do tipo `consultar_perguntas_ml` — M2-I1-A7.
 *
 * ── O que ele faz, e o que NAO faz ──────────────────────────────────
 *
 * Ele le a entrada da tarefa, confere a forma e chama `executarFuncao`.
 * Nao chama `executarPerguntasML`, nao chama o adapter do Mercado Livre
 * e nao resolve conexao: quem alcanca a leitura e o EXECUTOR DA FUNCAO,
 * depois de passar pelo guard de permissao, pela cobertura remota e pela
 * auditoria de Tool Call.
 *
 * Chamar o executor da Funcao direto pularia as tres coisas de uma vez,
 * e a tarefa passaria a agir com uma autoridade que ninguem conferiu.
 *
 * ── `lojaId` nao aparece aqui ───────────────────────────────────────
 *
 * Nem como parametro, nem na entrada, nem nos argumentos. A conta vem do
 * binding, e `executarPerguntasML` a le de `contexto.conexao.lojaId`
 * conferindo plataforma e recurso. Este handler nao tem por onde
 * escolher conta — e essa ausencia e a garantia, nao a disciplina.
 *
 * ── AT-LEAST-ONCE ───────────────────────────────────────────────────
 *
 * O motor pode executar a mesma tarefa duas vezes se o worker perder o
 * heartbeat. `mercadolivre.perguntas.listar` e `acesso: "leitura"` e
 * `idempotente: true`: executar duas vezes tem o mesmo efeito que
 * executar uma. E o que autoriza este tipo a entrar no registry.
 */
import { executarFuncao } from "@/lib/agentes/execucao-funcoes/executar";
import type {
  ContextoTarefa,
  HandlerTarefa,
  RelatarProgresso,
} from "@/lib/agentes/tipos-execucao";
import {
  argumentosDaEntrada,
  FUNCAO_ID,
  lerEntradaConsultarPerguntasML,
  mapearResultadoConsultarPerguntasML,
} from "@/lib/agentes/handlers/consultar-perguntas-ml-contrato";

// Reexport de conveniencia: mesma referencia, zero involucro. Espelha o
// que `consultar-vendas.ts` ja faz, para que o registry e as suites
// alcancem o tipo pelo handler sem conhecer o arquivo de contrato.
export {
  argumentosDaEntrada,
  FUNCAO_ID,
  lerEntradaConsultarPerguntasML,
  mapearResultadoConsultarPerguntasML,
  TIPO_CONSULTAR_PERGUNTAS_ML,
} from "@/lib/agentes/handlers/consultar-perguntas-ml-contrato";
export type { EntradaConsultarPerguntasML } from "@/lib/agentes/handlers/consultar-perguntas-ml-contrato";

/**
 * A fabrica. `userId` fica preso AQUI, na closure, fora do alcance do
 * handler — mesmo padrao dos outros quatro tipos.
 *
 * O handler recebe o ALVO pelo contexto (`agenteId`, `tarefaId`) e o
 * PODER daqui. `contexto.userId` deliberadamente NAO e usado: o valor
 * seria o mesmo, mas o handler passaria a ter uma variavel de dono ao
 * alcance.
 */
export function criarHandlerConsultarPerguntasML(userId: string): HandlerTarefa {
  return async function handlerConsultarPerguntasML(
    contexto: ContextoTarefa,
    relatarProgresso: RelatarProgresso
  ): Promise<Record<string, unknown>> {
    relatarProgresso(0);

    const entrada = lerEntradaConsultarPerguntasML(contexto.entrada);

    // Vem da LINHA da tarefa, nunca da entrada. Vazio aqui e defeito
    // nosso, nao pedido malformado — por isso nao e `ErroEntradaTarefa`.
    if (!contexto.agenteId) throw new Error("contexto sem agenteId");
    // `tarefaId` e OBRIGATORIO: ele entra no fingerprint da Approval e
    // `executarFuncao` o usa para provar posse da tarefa. `null` aqui
    // descartaria as duas coisas.
    if (!contexto.tarefaId) throw new Error("contexto sem tarefaId");

    relatarProgresso(25);

    const resultado = await executarFuncao({
      userId,
      agenteId: contexto.agenteId,
      tarefaId: contexto.tarefaId,
      funcaoId: FUNCAO_ID,
      argumentos: argumentosDaEntrada(entrada),
    });

    relatarProgresso(75);

    // O `switch` exaustivo vive no contrato, que e puro e por isso PODE
    // ser provado variante a variante. Aqui so resta devolver o que ele
    // devolveu — ou deixar subir o que ele lancou, inclusive
    // `PausaPorAprovacao`.
    const saida = mapearResultadoConsultarPerguntasML(resultado, entrada);
    relatarProgresso(100);
    return saida;
  };
}
