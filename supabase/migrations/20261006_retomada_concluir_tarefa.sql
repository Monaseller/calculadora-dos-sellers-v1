-- APPROVAL-DECISION-RESUME-D5-C2 — conclusao de tarefa retomada.
--
-- ════════════════════════════════════════════════════════════════════
-- O BURACO QUE ESTA MIGRATION FECHA
-- ════════════════════════════════════════════════════════════════════
--
-- O D5 instalou o inicio da retomada, a falha terminal e a recuperacao,
-- todos cercados pelo marcador causal `retomada_request_id`. O SUCESSO
-- ficou de fora: a lane de retomada teria de usar `concluir_tarefa`, que
-- cerca por `(id, status, tentativas)` e NAO conhece o marcador.
--
-- Como a retomada PRESERVA a tentativa N, uma tarefa retomada satisfaz
-- as tres cercas do terminalizador generico — ou seja, ele nao tem como
-- recusa-la. E, diferente da falha, aqui nao ha rede: o CHECK
-- `agente_tarefas_retomada_so_em_execucao_ou_terminal` admite
-- `concluido` com marcador nao-nulo, entao uma conclusao vinda da lane
-- errada passaria em silencio.
--
-- Esta funcao existe para que a lane de retomada tenha um terminalizador
-- de sucesso proprio, cercado pelas CINCO condicoes que identificam o
-- ciclo: dono, tarefa, execucao viva, tentativa e marcador.
--
-- ════════════════════════════════════════════════════════════════════
-- POR QUE NOME PROPRIO, E NAO UMA SOBRECARGA
-- ════════════════════════════════════════════════════════════════════
--
-- `concluir_tarefa` continua sendo o sucesso da lane normal, intocado.
-- Uma sobrecarga faria as duas compartilharem o nome, e o erro que se
-- quer impedir — a lane de retomada chamando o terminalizador generico
-- — deixaria de ser visivel em code review e em varredura de import.
-- A separacao nominal e metade da barreira; a outra metade sao as
-- cercas abaixo.
--
-- ════════════════════════════════════════════════════════════════════
-- O MARCADOR E PRESERVADO
-- ════════════════════════════════════════════════════════════════════
--
-- `retomada_request_id` NAO e limpo na conclusao, pelos mesmos motivos
-- que `retomada_falhar_tarefa` o preserva: o CHECK admite o marcador em
-- `concluido`, a FK causal continua satisfeita porque a aprovacao
-- permanece `consumida` com o mesmo `request_id_consumo`, e apagar o
-- vinculo justamente no caminho feliz destruiria a trilha que liga
-- tarefa, aprovacao e Tool Call.
--
-- ════════════════════════════════════════════════════════════════════
-- UMA SO ESCRITA, SEM LEITURA PREVIA
-- ════════════════════════════════════════════════════════════════════
--
-- Diferente de `falhar_tarefa`, que precisa ler `tentativas` contra
-- `max_tentativas` para escolher entre requeue e termino, aqui nao ha
-- decisao a tomar: sucesso e sucesso. Sem bifurcacao, nao existe janela
-- entre SELECT e UPDATE para fechar — o proprio UPDATE cercado e a
-- autoridade, e `RETURNING` devolve o que ele escreveu.
--
-- `progresso = 100` nao e enfeite: o CHECK
-- `agente_tarefas_concluido_completo` recusa `concluido` com qualquer
-- outro valor.
--
-- ════════════════════════════════════════════════════════════════════
-- NADA ALEM DA TAREFA
-- ════════════════════════════════════════════════════════════════════
--
-- Nao toca aprovacao, nao abre nem fecha Tool Call, nao executa Funcao,
-- nao mexe em permissao nem conexao. Tudo isso ja aconteceu antes da
-- execucao; o que resta e registrar o desfecho da tarefa.

create or replace function public.retomada_concluir_tarefa(
  p_tarefa_id uuid,
  p_user_id text,
  p_resultado jsonb,
  p_tentativa_esperada integer,
  p_retomada_request_id text
)
returns public.agente_tarefas
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_tarefa public.agente_tarefas;
begin
  -- `p_resultado` PODE ser nulo: o mapper de um tipo de tarefa tem o
  -- direito de concluir sem payload, e o COALESCE abaixo o normaliza —
  -- mesma tolerancia de `concluir_tarefa`.
  if p_tarefa_id is null or p_user_id is null or btrim(p_user_id) = ''
     or p_tentativa_esperada is null
     or p_retomada_request_id is null or btrim(p_retomada_request_id) = '' then
    raise exception 'retomada_concluir_tarefa: entrada obrigatoria ausente'
      using errcode = '22023';
  end if;

  -- As CINCO cercas. Nenhuma e redundante:
  --   `id`                  — qual tarefa;
  --   `user_id`             — de quem ela e;
  --   `status`              — a execucao ainda esta viva;
  --   `tentativas`          — e a MESMA tentativa que retomou, nao uma
  --                           reivindicacao posterior;
  --   `retomada_request_id` — e a lane de RETOMADA, e este ciclo dela.
  --
  -- A ultima e a que o terminalizador generico nao tem, e e por ela que
  -- esta funcao recusa uma tarefa normal: marcador nulo nunca casa com
  -- um request nao vazio.
  update public.agente_tarefas
     set status        = 'concluido',
         progresso     = 100,
         resultado     = coalesce(p_resultado, '{}'::jsonb),
         concluido_em  = now(),
         heartbeat_em  = null,
         erro_tipo     = null,
         erro_mensagem = null
   where id                  = p_tarefa_id
     and user_id             = p_user_id
     and status              = 'rodando'
     and tentativas          = p_tentativa_esperada
     and retomada_request_id = p_retomada_request_id
  returning * into v_tarefa;

  -- Fora de contrato LANCA — nunca no-op silencioso, nunca idempotencia
  -- fingida. A mensagem e FIXA e nao diz QUAL das cinco cercas falhou:
  -- com cinco condicoes, discriminar a culpada devolveria ao chamador o
  -- estado da linha que ele justamente nao conseguiu alcancar.
  if not found then
    raise exception
      'retomada_concluir_tarefa: a tarefa nao esta em execucao de retomada sob as cercas exigidas'
      using errcode = '55000';
  end if;

  return v_tarefa;
end;
$$;

comment on function public.retomada_concluir_tarefa(uuid, text, jsonb, integer, text) is
  'Conclui EXCLUSIVAMENTE uma tarefa da lane de retomada: status=concluido, progresso=100, resultado persistido, erro limpo. Cercada por dono, status rodando, tentativa esperada e marcador de retomada — uma tarefa da lane normal (marcador NULL) nao e alcancavel por aqui, e o sucesso da lane normal continua em concluir_tarefa. Preserva o marcador causal, a tentativa e a causalidade com a aprovacao consumida. Lanca 55000 se as cercas nao casarem e 22023 em entrada invalida; nunca no-op silencioso.';

-- ─── Privilegios ─────────────────────────────────────────────────────
--
-- Este projeto tem ALTER DEFAULT PRIVILEGES concedendo EXECUTE a
-- `anon`/`authenticated` em toda funcao nova, e `REVOKE FROM PUBLIC`
-- NAO cobre isso — `PUBLIC` e pseudo-role distinto. Foi a causa do bug
-- SEC1, e por isso cada principal e revogado nominalmente.

revoke all on function public.retomada_concluir_tarefa(uuid, text, jsonb, integer, text) from public;
revoke all on function public.retomada_concluir_tarefa(uuid, text, jsonb, integer, text) from anon;
revoke all on function public.retomada_concluir_tarefa(uuid, text, jsonb, integer, text) from authenticated;
revoke all on function public.retomada_concluir_tarefa(uuid, text, jsonb, integer, text) from service_role;
grant execute on function public.retomada_concluir_tarefa(uuid, text, jsonb, integer, text) to service_role;
