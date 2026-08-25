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
import type { HandlerTarefa } from "@/lib/agentes/tipos-execucao";
import { handlerTesteFundacao, TIPO_TESTE_FUNDACAO } from "@/lib/agentes/handlers/teste-fundacao";

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
 * O mapa. Um tipo, um handler.
 *
 * `Object.freeze` porque o registry e leitura em todo o resto do
 * sistema: um `HANDLERS[x] = ...` em runtime tornaria a execucao
 * dependente da ordem de import, que e exatamente o tipo de bug que
 * nao aparece em teste.
 */
export const HANDLERS: Readonly<Record<string, HandlerTarefa>> = Object.freeze({
  [TIPO_TESTE_FUNDACAO]: handlerTesteFundacao,
});

/** Tipos registrados, para diagnostico e para a suite. */
export const TIPOS_REGISTRADOS: readonly string[] = Object.freeze(Object.keys(HANDLERS));

/**
 * Resolve o handler de um tipo.
 *
 * LANCA em tipo desconhecido — nunca devolve `undefined` nem um handler
 * "generico". Recusa fechada: uma tarefa cujo tipo ninguem sabe executar
 * precisa terminar em `erro` com causa registrada, e nao passar batido
 * como se tivesse sido feita.
 */
export function resolverHandler(tipo: unknown): HandlerTarefa {
  if (typeof tipo !== "string" || !Object.prototype.hasOwnProperty.call(HANDLERS, tipo)) {
    throw new ErroTipoTarefaDesconhecido(typeof tipo === "string" ? tipo : String(tipo));
  }
  return HANDLERS[tipo];
}
