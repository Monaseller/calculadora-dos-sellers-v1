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
  [TIPO_ANALISE_VENDAS]: (userId: string) =>
    criarHandlerAnaliseVendas(criarLeiturasDeVendas(userId)),
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
