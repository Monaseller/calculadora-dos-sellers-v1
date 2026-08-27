/**
 * CDS IA — TODOS os dados simulados da interface. Nao ha mock em nenhum
 * outro lugar do produto, e nao deve haver.
 *
 * ── Por que uma pasta, e nao mais um arquivo unico ──────────────────
 *
 * `lib/ia/mocks.ts` guardava cinco dominios independentes — agentes,
 * tarefas, conexoes, capabilities e aprovacoes — e cruzou 400 linhas na
 * UI-1D.a. O limite existia justamente como alarme, e ele tocou:
 * arquivo que concentra dominios sem relacao entre si vira o lugar onde
 * ninguem acha nada e todo mundo acrescenta.
 *
 * A divisao foi ESTRUTURAL: nenhum dado mudou, nenhuma tela mudou.
 *
 * ── Este arquivo e a fronteira publica ──────────────────────────────
 *
 * Consumidores importam de `@/lib/ia/mocks` e nada mais. Os arquivos de
 * dominio (`./agentes`, `./tarefas`, …) sao detalhe interno: importar
 * direto deles espalharia a dependencia e faria a proxima reorganizacao
 * tocar em vinte telas em vez de neste `index`.
 *
 * ── Regras que valem para a pasta inteira ───────────────────────────
 *
 *   - todo export comeca com `MOCK_`;
 *   - todo id e obviamente ficticio (`ag-atendimento`, `tf-1`, `ap-1`) —
 *     um UUID falso e indistinguivel de um real em screenshot e em log;
 *   - nao existe `user_id`, `loja_id`, `seller_id`, `shop_id`, token,
 *     credencial, pedido real nem nome de pessoa;
 *   - nomes sao de funcao ("Atendimento", "Campanhas").
 */
export { MOCK_AGENTES, MOCK_AGENTE_POR_ID } from "@/lib/ia/mocks/agentes";
export { MOCK_TAREFAS } from "@/lib/ia/mocks/tarefas";
export { MOCK_CONEXOES, MOCK_FUNCOES_DA_CONEXAO } from "@/lib/ia/mocks/conexoes";
export {
  MOCK_FUNCOES,
  MOCK_PERMISSOES,
  MOCK_NIVEL_DA_FUNCAO,
} from "@/lib/ia/mocks/capabilities";
export { MOCK_APROVACOES } from "@/lib/ia/mocks/aprovacoes";

import { MOCK_CONTAGEM_TRABALHANDO } from "@/lib/ia/mocks/tarefas";
import { MOCK_APROVACOES } from "@/lib/ia/mocks/aprovacoes";

/** Texto obrigatorio na tela enquanto a area roda com simulacao. */
export const MOCK_AVISO = "Dados simulados";

/**
 * Contagens da subnav — a unica agregacao que cruza dominios, e por isso
 * a unica coisa alem de reexports que este arquivo tem.
 *
 * `trabalhando` vem das tarefas; `aguardandoAprovacao` vem da FILA, que
 * e quem representa o que espera decisao humana. Nenhuma das duas e
 * digitada: numero escrito em dois lugares e numero que diverge.
 */
export const MOCK_CONTAGENS = {
  trabalhando: MOCK_CONTAGEM_TRABALHANDO,
  aguardandoAprovacao: MOCK_APROVACOES.length,
} as const;
