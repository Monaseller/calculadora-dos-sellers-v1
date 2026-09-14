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

/**
 * A tarefa PAROU porque existe uma aprovacao esperando decisao humana.
 *
 * ── Isto NAO e falha do handler ─────────────────────────────────────
 *
 * Ate aqui o executor conhecia dois desfechos: devolver (concluir) e
 * lancar (falhar). Um terceiro existe de verdade — a Funcao pedida tem
 * `nivel = aprovacao`, a aprovacao foi criada e nada mais pode
 * acontecer sem um humano. Representar isso como `handler_falhou`
 * deixaria a Task mentindo sobre o proprio estado e criaria uma
 * aprovacao pendente que ninguem alcanca.
 *
 * ── Por que sentinel, e nao union no retorno ────────────────────────
 *
 * `HandlerTarefa` continua `Promise<Record<string, unknown>>`. Uma
 * union obrigaria `teste_fundacao`, `analise_vendas` e `conversa` a
 * declarar um envelope que nenhum deles usa — Approval vazaria para
 * tres handlers que nao a conhecem. O executor ja discrimina excecao
 * por `instanceof` em `classificarErro` (`ErroTipoTarefaDesconhecido`,
 * `ErroEntradaTarefa`); este e o MESMO mecanismo, nao um novo.
 *
 * ── A lista de campos e a defesa ────────────────────────────────────
 *
 * So `aprovacaoId`. NAO carrega `tarefaId` nem `tentativa`: o executor
 * ja tem os dois, lidos da LINHA que o claim reivindicou, e aceita-los
 * de quem lanca seria deixar o handler descrever o proprio fencing.
 * NAO carrega `userId`, `agenteId`, argumentos nem nada do pedido — o
 * vinculo autoritativo entre aprovacao e tarefa e
 * `agente_funcao_aprovacoes.tarefa_id`, garantido pela FK composta e
 * pelo fingerprint, que ja inclui `tarefa_id`.
 *
 * `aprovacaoId` viaja como MARCADOR: serve para log e para prova, e nao
 * e revalidado no caminho da pausa.
 */
export class PausaPorAprovacao extends Error {
  readonly aprovacaoId: string;

  constructor(aprovacaoId: string) {
    super("tarefa pausada: aprovacao pendente");
    this.name = "PausaPorAprovacao";
    this.aprovacaoId = aprovacaoId;
  }
}
