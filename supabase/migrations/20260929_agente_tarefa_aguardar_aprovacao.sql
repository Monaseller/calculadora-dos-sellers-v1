-- ══════════════════════════════════════════════════════════════════════
-- FUNCTION-RUNTIME-P0 — a terceira transicao terminal de uma tarefa.
--
-- Ate aqui o runtime conhecia dois desfechos: `concluir_tarefa` e
-- `falhar_tarefa`. Falta o terceiro, que ja existe no vocabulario e no
-- schema e nao tinha como acontecer:
--
--     rodando -> aguardando_aprovacao
--
-- `agente_tarefas_status_valido` ja aceita o status e
-- `TRANSICOES_TAREFA` ja permite a transicao desde a FASE 1C. O que
-- faltava era a instrucao atomica que a executa.
--
-- ── Esta migration NAO expande schema ────────────────────────────────
--
-- Zero ALTER TABLE, zero coluna, zero indice, zero trigger. A tarefa NAO
-- ganha `aprovacao_id`: o vinculo ja existe na outra direcao, em
-- `agente_funcao_aprovacoes.tarefa_id`, com FK composta
-- `(tarefa_id, user_id) -> agente_tarefas(id, user_id)` e com
-- `tarefa_id` DENTRO do fingerprint de deduplicacao. Guardar o mesmo
-- vinculo dos dois lados criaria duas verdades que um dia discordariam.
--
-- ── Por que RPC, e nao UPDATE pelo client ────────────────────────────
--
-- O par "exigir rodando na tentativa certa" + "escrever" precisa ser UMA
-- instrucao. Um SELECT-depois-UPDATE abriria janela TOCTOU com o
-- recuperador de orfas (5 min de heartbeat), que e exatamente o cenario
-- que o fencing abaixo existe para fechar.
-- ══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.aguardar_aprovacao_tarefa(
  p_tarefa_id          uuid,
  p_tentativa_esperada integer
)
RETURNS public.agente_tarefas
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_tarefa public.agente_tarefas;
BEGIN
  -- A RPC revalida o parametro cru: ela nao tem sessao para confiar.
  IF p_tarefa_id IS NULL THEN
    RAISE EXCEPTION 'aguardar_aprovacao_tarefa: p_tarefa_id e obrigatorio'
      USING ERRCODE = '22023';
  END IF;

  IF p_tentativa_esperada IS NULL THEN
    RAISE EXCEPTION 'aguardar_aprovacao_tarefa: p_tentativa_esperada e obrigatorio'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.agente_tarefas
  SET status        = 'aguardando_aprovacao',
      -- Ninguem esta executando: zerar o batimento e o que impede o
      -- `claim_next_agente_tarefa` de "recuperar" uma tarefa que nao
      -- esta orfa, apenas parada esperando um humano. O predicado do
      -- claim so alcanca `rodando` com heartbeat vencido, e este status
      -- nao esta la — mas deixar o carimbo antigo seria guardar um fato
      -- que deixou de ser verdade.
      heartbeat_em  = NULL,
      -- Pausa NAO e desfecho: nao ha resultado, nao ha erro, nao houve
      -- conclusao. O CHECK `agente_tarefas_erro_explicado` so cobra
      -- `erro_tipo` quando `status = 'erro'`, entao limpar aqui e
      -- seguro e honesto.
      resultado     = NULL,
      erro_tipo     = NULL,
      erro_mensagem = NULL,
      concluido_em  = NULL
      -- PRESERVADOS de proposito: `progresso` (a tarefa andou ate aqui;
      -- forcar 0 ou 100 mentiria), `tentativas` (pausa nao e tentativa
      -- nova — quem conta e o claim) e `iniciado_em` (a execucao
      -- comecou de verdade).
  WHERE id = p_tarefa_id
    AND status = 'rodando'
    -- ── O FENCING ─────────────────────────────────────────────────
    --
    -- `status = 'rodando'` SOZINHO nao protege nada. O claim recupera
    -- orfa com `rodando -> rodando` direto, sem passar por `pendente`,
    -- e incrementa `tentativas`. Sem a comparacao abaixo, um worker da
    -- tentativa 1 — atrasado alem dos 5 minutos — encontraria a tarefa
    -- em `rodando` e pausaria a execucao da tentativa 2, matando
    -- trabalho alheio no meio.
    --
    -- `tentativas` serve como fencing token porque so muda no claim:
    -- `concluir_tarefa` e `falhar_tarefa` nunca a escrevem, e ela
    -- permanece constante durante uma execucao inteira.
    AND tentativas = p_tentativa_esperada
  RETURNING * INTO v_tarefa;

  -- Fora de ordem LANCA — mesmo 55000 das irmas. Nunca no-op
  -- silencioso: uma pausa que nao aconteceu e um fato que o chamador
  -- PRECISA distinguir de uma que aconteceu. As duas causas possiveis
  -- (status errado, tentativa velha) chegam com a mesma mensagem, de
  -- proposito: quem chamou nao aprende o estado interno da linha.
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'aguardar_aprovacao_tarefa: tarefa % nao esta em rodando na tentativa %',
      p_tarefa_id, p_tentativa_esperada
      USING ERRCODE = '55000';
  END IF;

  RETURN v_tarefa;
END;
$$;

COMMENT ON FUNCTION public.aguardar_aprovacao_tarefa(uuid, integer) IS
  'Estaciona em aguardando_aprovacao uma tarefa que esta em rodando NA TENTATIVA ESPERADA. Fencing por tentativas: o claim recupera orfa com rodando->rodando e incrementa tentativas, entao status sozinho nao protege contra worker atrasado. Limpa heartbeat/resultado/erro/conclusao; preserva progresso, tentativas e iniciado_em. Lanca 55000 se o par (status, tentativa) nao casar — nunca no-op silencioso. Nao recebe nem grava vinculo com aprovacao: ele vive em agente_funcao_aprovacoes.tarefa_id.';

REVOKE EXECUTE ON FUNCTION public.aguardar_aprovacao_tarefa(uuid, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.aguardar_aprovacao_tarefa(uuid, integer) FROM anon;
REVOKE EXECUTE ON FUNCTION public.aguardar_aprovacao_tarefa(uuid, integer) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.aguardar_aprovacao_tarefa(uuid, integer) TO service_role;
