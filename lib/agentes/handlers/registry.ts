/**
 * Registry de handlers de tarefa — AGENTES-FASE1C.
 *
 * ── A unica peca que decide COMO uma tarefa roda ────────────────────
 * Mesmo papel que `lib/estudio-anuncios/executores/registry.ts` tem no
 * Estudio, e nenhuma linha em comum com ele: as duas arvores sao
 * independentes de proposito.
 *
 * ── UMA estrutura, nao duas — e a diferenca importa ─────────────────
 * O registry do Estudio tem DUAS estruturas separadas
 * (`HANDLERS_ESPECIFICOS` e `ETAPAS_FAKE_GENERICAS`), com validacao de
 * boot que lanca se uma etapa aparecer nas duas. Aquilo existe porque
 * la convivem caminho fake e caminho de IA real, e confundi-los
 * significaria chamar um provedor de verdade sem querer.
 *
 * Aqui NAO ha caminho de IA. Todos os handlers desta fase sao
 * deterministicos, entao um unico mapa basta. Copiar a dupla estrutura
 * seria importar a complexidade sem importar o problema que ela resolve.
 *
 * Quando (e se) existir handler com IA, a separacao volta a fazer
 * sentido — e ai ela entra com o problema junto.
 *
 * ── Requisito de entrada no registry ────────────────────────────────
 * A semantica do motor e AT-LEAST-ONCE (ver
 * `20260917_agentes_execucao.sql`, secao 4). Um handler pode ser
 * executado DUAS VEZES para a mesma tarefa se o worker perder o
 * heartbeat.
 *
 *   NENHUM handler com efeito externo — enviar mensagem, publicar
 *   anuncio, alterar preco, gastar credito de IA — entra neste mapa
 *   antes de provar idempotencia. Executar duas vezes tem de ter o
 *   mesmo efeito que executar uma.
 */
import type { ConstruirHandler } from "@/lib/agentes/tipos-execucao";
import { handlerTesteFundacao, TIPO_TESTE_FUNDACAO } from "@/lib/agentes/handlers/teste-fundacao";
// AGENTES-FASE1D-d: o registry passa a ser a COMPOSITION ROOT.
//
// `dados/vendas.ts` carrega `import "server-only"`, entao este import de
// VALOR torna o registry server-only por transitividade. Isso e correto e
// esperado — o registry so e alcancado pelo executor, que ja e
// server-only. O que NAO pode ser contaminado e o HANDLER, e ele
// continua puro: `analise-vendas.ts` importa `dados/vendas` apenas como
// `import type`, e recebe a capability ja construida.
import { criarLeiturasDeVendas } from "@/lib/agentes/dados/vendas";
import { criarHandlerAnaliseVendas, TIPO_ANALISE_VENDAS } from "@/lib/agentes/handlers/analise-vendas";
// AGENTES-FASE1E-c: wiring da interpretacao de IA. Le a flag e devolve o
// FAKE quando ligada — nenhum provedor real, nenhuma rede, nenhuma chave.
import {
  comInterpretacaoDeVendas,
  criarAdaptadorDeConversa,
  criarInterpretadorDeVendas,
} from "@/lib/agentes/ativacao-ia";
// AGENT-VERTICAL-SLICE-V1: `conversa` le o AGENTE, e a leitura ja existia —
// `lerAgenteDoDono` filtra por `id` E `user_id` desde a 1B. Nao ha capability
// nova e nao ha modulo novo de dados: o registry so fecha o dono nela
// antes de entregar ao handler.
import { lerAgenteDoDono } from "@/lib/agentes/capability";
import { criarHandlerConversa, TIPO_CONVERSA } from "@/lib/agentes/handlers/conversa";

/**
 * Erro de tipo nao registrado. Classe propria para que o executor o
 * mapeie a `tipo_desconhecido` em vez de tratar como quebra de handler.
 */
export class ErroTipoTarefaDesconhecido extends Error {
  readonly tipo: string;
  constructor(tipo: string) {
    super("tipo de tarefa nao registrado");
    this.name = "ErroTipoTarefaDesconhecido";
    this.tipo = tipo;
  }
}

/**
 * O mapa. Um tipo, uma FABRICA de handler — nao um handler pronto.
 *
 * ── Por que fabrica, e nao handler global (AGENTES-FASE1D-d) ────────
 * Um handler que le dado real precisa estar preso ao dono DA TAREFA. Um
 * `HandlerTarefa` guardado no modulo seria um so, compartilhado por
 * todos os tenants — e a capability dentro dele estaria amarrada ao
 * primeiro `user_id` que passasse por aqui. Com fabrica, cada execucao
 * constroi o seu, e o `user_id` entra no ato da construcao.
 *
 * `Object.freeze` porque o registry e leitura em todo o resto do
 * sistema: um `HANDLERS[x] = ...` em runtime tornaria a execucao
 * dependente da ordem de import, que e exatamente o tipo de bug que
 * nao aparece em teste.
 */
export const HANDLERS: Readonly<Record<string, ConstruirHandler>> = Object.freeze({
  // Aridade ZERO, de proposito: nao e que ele ignore o `userId` por
  // disciplina — ele nao tem por onde recebe-lo. `teste_fundacao` e
  // andaime deterministico e nao toca dado de ninguem.
  [TIPO_TESTE_FUNDACAO]: () => handlerTesteFundacao,

  // LEAST-CAPABILITY, em uma linha: `criarLeiturasDeVendas(userId)`
  // devolve a FUNCAO `lerVendasDoPeriodo` ja com o dono fechado por
  // closure, e e ela — sozinha — que chega ao handler. Nao existe objeto
  // de dependencias, nao existe `SupabaseClient`, e o handler nao recebe
  // `userId`: nao ha assinatura pela qual ele peca dado de outro tenant.
  // AGENTES-FASE1E-c: a interpretacao de IA entra AQUI, como decorator,
  // e nao dentro do handler. `analise_vendas` continua sendo o mesmo
  // tipo e o mesmo handler — nao ha tipo novo de tarefa, nao ha
  // migration, e tarefa ja enfileirada continua valendo.
  //
  // Com a flag DESLIGADA, `criarInterpretadorDeVendas()` devolve `null`
  // e `comInterpretacaoDeVendas` devolve o proprio handler base: mesmo
  // objeto de funcao, zero codigo novo no caminho. Rollback e desligar
  // a env, sem deploy.
  //
  // O handler deterministico segue sem saber que IA existe — ele nao a
  // escolhe, nao a recebe e nao a menciona. O `userId` tambem nao chega
  // ao interpretador: a fabrica nao o aceita, e a analise que ele le ja
  // e o agregado de UM dono, produzido pela capability vinculada.
  [TIPO_ANALISE_VENDAS]: (userId: string) =>
    comInterpretacaoDeVendas(
      criarHandlerAnaliseVendas(criarLeiturasDeVendas(userId)),
      criarInterpretadorDeVendas()
    ),

  // AGENT-VERTICAL-SLICE-V1 — o MESMO least-capability das entradas
  // acima, agora com duas dependencias em vez de uma.
  //
  // A closure de leitura recebe `agenteId` e nada mais; `userId` fica
  // preso AQUI, fora do alcance do handler. O ALVO vem do contexto da
  // tarefa, o PODER vem daqui — e por isso o handler nao tem por onde
  // pedir o agente de outro dono, nem por engano nem de proposito.
  //
  // `ContextoTarefa` NAO foi ampliado para isso: o contexto ja carrega
  // `agenteId` desde a 1C, e e so disso que a leitura precisa.
  //
  // A escolha do provedor tambem nao passa por aqui: a fabrica le a
  // flag na camada que ja e dona dela, e o registry so a chama.
  [TIPO_CONVERSA]: (userId: string) =>
    criarHandlerConversa(
      (agenteId: string) => lerAgenteDoDono(agenteId, userId),
      criarAdaptadorDeConversa()
    ),
});

/** Tipos registrados, para diagnostico e para a suite. */
export const TIPOS_REGISTRADOS: readonly string[] = Object.freeze(Object.keys(HANDLERS));

/**
 * Resolve a FABRICA de handler de um tipo.
 *
 * Quem chama recebe `(userId) => HandlerTarefa` e ainda precisa fazer o
 * binding de tenant — que e do executor, com `tarefa.user_id` tirado da
 * linha reivindicada. Resolver e construir sao passos separados de
 * proposito: resolver depende do TIPO, construir depende do DONO.
 *
 * LANCA em tipo desconhecido — nunca devolve `undefined` nem um handler
 * "generico". Recusa fechada: uma tarefa cujo tipo ninguem sabe executar
 * precisa terminar em `erro` com causa registrada, e nao passar batido
 * como se tivesse sido feita.
 */
export function resolverHandler(tipo: unknown): ConstruirHandler {
  if (typeof tipo !== "string" || !Object.prototype.hasOwnProperty.call(HANDLERS, tipo)) {
    throw new ErroTipoTarefaDesconhecido(typeof tipo === "string" ? tipo : String(tipo));
  }
  return HANDLERS[tipo];
}
