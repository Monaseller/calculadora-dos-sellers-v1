/**
 * `/ia/aprovacoes` — a fila de decisao humana.
 *
 * ── Um lugar so para decidir ────────────────────────────────────────
 *
 * Toda acao que um agente nao pode executar sozinho termina aqui.
 * Permissoes, Funcoes, Tarefas e o Escritorio APONTAM para esta rota e
 * nao decidem nada — dois caminhos para a mesma decisao seriam duas
 * fontes de verdade sobre quem autorizou o que.
 *
 * ── O que esta tela ainda nao faz ───────────────────────────────────
 *
 * Aprovar e Recusar aparecem desabilitados. Nao existe tabela de
 * aprovacoes, nao existe registro de quem decidiu, e a transicao que
 * retomaria a tarefa ainda nao foi implementada. Botao que muda a tela
 * sem gravar nada e pior que botao nenhum.
 *
 * A pagina e fina: a fila inteira vive em `FilaAprovacoes`, que e Client
 * Component porque calcula "solicitada ha X" a partir do relogio.
 */
import FilaAprovacoes from "@/components/ia/aprovacoes/FilaAprovacoes";

export default function PaginaAprovacoes() {
  return <FilaAprovacoes />;
}
