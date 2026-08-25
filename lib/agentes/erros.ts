/**
 * Erros de execucao de tarefa de agente — AGENTES-FASE1D-b.
 *
 * ── Por que este arquivo existe ─────────────────────────────────────
 * `ErroEntradaTarefa` nasceu dentro de
 * `lib/agentes/handlers/teste-fundacao.ts` porque, na FASE 1C, aquele
 * era o unico handler. O efeito colateral foi que
 * `lib/agentes/executar-tarefa.ts` — codigo de producao, o coracao do
 * motor — passou a importar uma classe de um HANDLER DE TESTE.
 *
 * `teste_fundacao` e andaime: existe para provar o motor, nao para
 * servir de dependencia. Enquanto a classe morava la, remover o handler
 * de teste quebraria o executor e, mais tarde, quebraria tambem
 * handlers reais. Uma casa neutra desfaz isso: nenhum codigo real
 * depende mais de codigo de teste.
 *
 * ── Por que NAO em `tipos-execucao.ts` ──────────────────────────────
 * Aquele arquivo declara CONTRATOS — tipos e interfaces, tudo apagado
 * na compilacao. Uma classe e valor de runtime: colocada la, todo
 * importador de um tipo passaria a carregar codigo executavel junto.
 * Decisao explicita do gate: `tipos-execucao.ts` continua sendo so
 * contrato.
 *
 * ── Este modulo e PURO ──────────────────────────────────────────────
 * Sem `server-only`, sem SDK, sem env, sem banco, sem rede. Precisa ser
 * importavel tanto pelo executor (server-only) quanto por um handler
 * puro, sem arrastar nada para nenhum dos dois.
 */

/**
 * A entrada da tarefa esta errada — nao o handler.
 *
 * O executor usa esta distincao em `classificarErro`: `instanceof`
 * desta classe vira `entrada_invalida`; qualquer outro `Error` vira
 * `handler_falhou`. A diferenca importa porque as duas coisas pedem
 * acoes diferentes de quem investiga: entrada errada e problema de quem
 * criou a tarefa, handler quebrado e problema do codigo.
 *
 * Lancar e o UNICO caminho de falha de um handler. Nenhum handler chama
 * RPC, nenhum grava o proprio estado.
 */
export class ErroEntradaTarefa extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = "ErroEntradaTarefa";
  }
}
