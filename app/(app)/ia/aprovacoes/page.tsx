/**
 * `/ia/aprovacoes` — placeholder deliberado.
 *
 * O status `aguardando_aprovacao` ja existe em `agente_tarefas`, mas NAO
 * existe tabela de aprovacoes: nao ha onde registrar quem aprovou, o que
 * foi aprovado, com qual justificativa e ate quando a autorizacao vale.
 *
 * Renderizar cards com botoes inertes daria a impressao de que o fluxo
 * existe e so nao foi ligado. Ele nao existe.
 */
import EmBreve from "@/components/ia/EmBreve";

export default function PaginaAprovacoes() {
  return (
    <EmBreve
      titulo="Aprovações"
      descricao="Toda ação que altera algo fora do CDS passará por aqui antes de acontecer: qual agente pediu, em qual conta, o que faz, por quê, qual o impacto e até quando o pedido vale. Aprovar e recusar serão decisões suas, registradas."
      pendencia="modelo de aprovação no banco — não existe tabela de aprovações, apenas o status `aguardando_aprovacao` nas tarefas. Sem registro de quem decidiu e quando, aprovar seria um clique sem prova."
    />
  );
}
