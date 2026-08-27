/**
 * `/ia/atividade` — placeholder deliberado.
 *
 * Parte da timeline JA seria derivavel hoje: `agente_tarefas` tem
 * `criado_em`, `iniciado_em`, `concluido_em`, `status` e `erro_tipo`, e
 * `agentes_ia_chamadas` tem cada chamada de IA com modelo, tokens e
 * latencia. Isso cobre os eventos de EXECUCAO.
 *
 * O que nao existe e o registro de DECISAO: aprovacao concedida ou
 * recusada, permissao alterada, conexao ligada ou desligada. Uma timeline
 * que mostra so metade dos eventos, sem dizer qual metade falta, engana
 * mais do que informa — por isso a tela inteira espera.
 */
import EmBreve from "@/components/ia/EmBreve";

export default function PaginaAtividade() {
  return (
    <EmBreve
      titulo="Atividade"
      descricao="A linha do tempo de tudo que os agentes fizeram: tarefas criadas, iniciadas e concluídas, falhas, chamadas de IA, aprovações concedidas e permissões alteradas."
      pendencia="registro de eventos de decisão. Os eventos de execução já poderiam vir de `agente_tarefas` e `agentes_ia_chamadas`, mas aprovação, permissão e conexão não deixam rastro em lugar nenhum hoje."
    />
  );
}
