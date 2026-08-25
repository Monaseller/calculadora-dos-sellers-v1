-- =====================================================================
-- AGENTES-FASE1C — EXECUCAO DETERMINISTICA (1 INDICE + 3 RPCs)
-- =====================================================================
--
-- 1. O QUE ESTA MIGRATION FAZ, E O QUE ELA NAO TOCA
-- ---------------------------------------------------------------------
-- Da a `agente_tarefas` o motor de execucao: aquisicao atomica, conclusao
-- e falha. Nada mais.
--
-- ZERO tabela nova. ZERO `ALTER TABLE`. ZERO coluna nova. ZERO trigger.
-- ZERO RLS. ZERO policy. As duas tabelas da FASE 1B ficam EXATAMENTE
-- como estao — `heartbeat_em`, `tentativas`, `max_tentativas`,
-- `iniciado_em` e `concluido_em` foram criadas la justamente para que
-- esta fase nao precisasse alterar nada.
--
-- 2. O INDICE — o que foi adiado na 1B, e por que entra agora
-- ---------------------------------------------------------------------
-- `idx_agente_tarefas_fila` ficou de fora da 1B por nao ter consumidor.
-- Agora tem: e exatamente o predicado do claim. Parcial porque a fila
-- so olha dois status; tarefas terminais (`concluido`, `cancelado`,
-- `erro` esgotado) sao a maioria a longo prazo e nao precisam estar no
-- indice.
--
-- O indice de heartbeat continua FORA: com `status` ja filtrado pelo
-- indice parcial, o residuo de `heartbeat_em` e irrelevante no volume
-- desta fase. Entra quando houver volume que o justifique, nao antes.
--
-- 3. O CLAIM — quatro condicoes, e uma armadilha de JOIN
-- ---------------------------------------------------------------------
-- `claim_next_agente_tarefa()` reivindica UMA tarefa se, e somente se:
--
--   a) `tentativas < max_tentativas`   — retry esgotado nao volta a fila
--   b) o agente dono esta `ativo`      — desativar pausa a fila dele
--   c) status = 'pendente'
--      OU status = 'rodando' com heartbeat parado ha mais de 5 minutos
--   d) a linha nao esta travada por outra transacao (SKIP LOCKED)
--
-- ── ARMADILHA: `FOR UPDATE` com JOIN ────────────────────────────────
-- O filtro (b) exige juntar `agentes`. Um `FOR UPDATE` simples tentaria
-- travar as linhas das DUAS tabelas — e travar `agentes` faria um claim
-- bloquear um `UPDATE` de configuracao do agente feito pelo usuario, sem
-- nenhuma razao. Por isso o `FOR UPDATE OF t`: trava SO
-- `agente_tarefas`. O JOIN continua sendo leitura.
--
-- ── AGENTE INATIVO NAO CANCELA TAREFA ───────────────────────────────
-- Decisao explicita: as tarefas de um agente desativado permanecem
-- `pendente` e voltam a ser reivindicadas quando ele for reativado. O
-- oposto — cancelar em cascata — destruiria trabalho por causa de um
-- toggle, e seria irreversivel.
--
-- 4. SEMANTICA = AT-LEAST-ONCE. NAO E exactly-once.
-- ---------------------------------------------------------------------
-- A recuperacao de orfa da condicao (c) existe porque um worker morto
-- deixaria a tarefa em `rodando` para sempre. Mas ela tem um preco que
-- precisa estar escrito, nao descoberto em producao:
--
--   Se o worker original estiver VIVO, apenas lento ou com o heartbeat
--   atrasado, a ressurreicao provoca EXECUCAO DUPLA da mesma tarefa.
--
-- Nao ha como distinguir "morto" de "muito lento" de fora. A escolha
-- foi executar de novo em vez de travar para sempre — e a consequencia
-- e que a garantia deste motor e AT-LEAST-ONCE.
--
-- Duas obrigacoes decorrem disso:
--   1. o limite de orfa (5 min) e MUITO maior que o intervalo do
--      heartbeat (15 s). Sao 20 batidas perdidas antes de alguem
--      considerar a tarefa abandonada.
--
--      QUEM BATE: `lib/agentes/executar-tarefa.ts`, via `setInterval` de
--      `INTERVALO_HEARTBEAT_MS`, enquanto o handler roda — NAO o worker,
--      que e execucao unica e fica apenas esperando a resposta HTTP. O
--      batimento e PERIODICO e independe de o progresso mudar: um
--      handler que trabalhe 6 minutos em silencio continua batendo, e
--      por isso nao e reivindicado estando vivo.
--
--      Se aquele `setInterval` for removido, ou o intervalo crescer
--      acima de 5 minutos, esta secao deixa de ser verdadeira. A suite
--      offline verifica o VALOR de `INTERVALO_HEARTBEAT_MS` e a relacao
--      20x com o limite abaixo, justamente para que os dois nao possam
--      divergir em silencio;
--   2. TODO HANDLER PRECISA SER IDEMPOTENTE. `teste_fundacao` e, por
--      construcao — nao tem efeito externo nenhum. Qualquer handler
--      futuro COM efeito externo (enviar mensagem, criar anuncio,
--      alterar preco) so pode entrar no registry depois de provar que
--      executar duas vezes tem o mesmo efeito que executar uma.
--
-- 5. RETRY, E POR QUE A FALHA PRESERVA O ERRO
-- ---------------------------------------------------------------------
-- `tentativas` incrementa NO CLAIM, nao na conclusao — cada claim e uma
-- tentativa real, nao uma promessa. E o mesmo que
-- `claim_next_estudio_anuncios_job()` faz, pelo mesmo motivo: se o
-- processo morrer no meio, a tentativa ja foi contada.
--
-- `falhar_tarefa()` decide entre devolver a tarefa a fila e encerra-la:
--
--   tentativas < max_tentativas  ->  status = 'pendente'   (retry)
--   tentativas >= max_tentativas ->  status = 'erro'       (terminal)
--
-- Nos DOIS casos `erro_tipo` e `erro_mensagem` sao gravados. Erro
-- apagado no retry deixa uma tarefa que falhou 2 vezes indistinguivel de
-- uma que nunca falhou — o Estudio ja passou por isso, e a correcao
-- virou a migration `20260812_preservar_erro_no_retry.sql`.
--
-- 6. FORA DE ORDEM LANCA, NUNCA VIRA NO-OP
-- ---------------------------------------------------------------------
-- `concluir_tarefa` e `falhar_tarefa` exigem `status = 'rodando'`. Se a
-- tarefa nao estiver nesse estado, elas LANCAM. Um `UPDATE` que casa
-- zero linhas e devolve "ok" e a forma mais silenciosa de perder um
-- job — e nenhuma das duas pode ser chamada duas vezes para a mesma
-- execucao.
--
-- Isso tambem e o que garante "concluir OU falhar, NUNCA ambos": a
-- primeira a rodar tira a tarefa de `rodando`, e a segunda lanca.
--
-- 7. PRIVILEGIOS — o REVOKE que NAO e redundante
-- ---------------------------------------------------------------------
-- Este projeto Supabase tem `ALTER DEFAULT PRIVILEGES` concedendo
-- EXECUTE a `anon` e `authenticated` em TODA funcao nova, no momento da
-- criacao. `REVOKE ... FROM PUBLIC` NAO cobre isso — `PUBLIC` e um
-- pseudo-role distinto de `anon`/`authenticated`.
--
-- Isso nao e teoria: esta documentado em
-- `20260803_central_ia_estudio_anuncios_schema.sql` como correcao
-- pos-execucao, descoberta por leitura DEPOIS da primeira aplicacao, e
-- e o bug SEC1. Sem os REVOKE explicitos abaixo, estas tres funcoes
-- ficariam chamaveis pela API publica com a chave anon — e
-- `claim_next_agente_tarefa()` reivindica tarefa de QUALQUER tenant.
--
-- A suite pos-migration MEDE `has_function_privilege(...,'EXECUTE')`
-- para `anon` e `authenticated` nas tres. Nao presume.
--
-- 8. BASELINE ESPERADA (medir READ-ONLY imediatamente antes)
-- ---------------------------------------------------------------------
--   tabelas em public ............ 35   ->  35 (inalterado)
--   grants anon .................. 48   ->  48 (inalterado)
--   tabelas com anon ............. 16   ->  16 (inalterado)
--   linhas em agentes/tarefas .... 0/0  ->  0/0
--   indices em agente_tarefas .... 2    ->  3
--   as 3 funcoes ................. nao existem
--   EXECUTE para anon nas 3 ...... n/a  ->  DEVE SER 0
--   md5 ACL das tabelas .......... deve permanecer IDENTICO
--   md5 default privileges ....... deve permanecer IDENTICO
--
-- 9. ROLLBACK (MANUAL — COMENTARIO, NAO COMANDO)
-- ---------------------------------------------------------------------
--     DROP FUNCTION IF EXISTS public.claim_next_agente_tarefa();
--     DROP FUNCTION IF EXISTS public.concluir_tarefa(uuid, jsonb);
--     DROP FUNCTION IF EXISTS public.falhar_tarefa(uuid, text, text);
--     DROP INDEX IF EXISTS public.idx_agente_tarefas_fila;
--
-- Barato: nenhuma tabela e alterada, nenhum dado migra.
-- =====================================================================

-- ── FILA ──────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_agente_tarefas_fila
  ON public.agente_tarefas (status, criado_em)
  WHERE status IN ('pendente', 'rodando');


-- ── CLAIM ATOMICO ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.claim_next_agente_tarefa()
RETURNS public.agente_tarefas
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_tarefa public.agente_tarefas;
  -- Limite de orfa. 20x o intervalo de heartbeat do worker (15s) — ver
  -- secao 4 sobre at-least-once.
  v_limite_orfa CONSTANT interval := interval '5 minutes';
BEGIN
  SELECT t.* INTO v_tarefa
  FROM public.agente_tarefas t
  -- JOIN pelo PAR (id, user_id): e o mesmo par da FK composta da 1B.
  -- Juntar so por `id` aceitaria uma linha incoerente caso a FK fosse
  -- removida um dia; assim o claim carrega a propria verificacao.
  JOIN public.agentes a
    ON a.id = t.agente_id
   AND a.user_id = t.user_id
  WHERE t.tentativas < t.max_tentativas
    AND a.ativo
    AND (
          t.status = 'pendente'
       OR (    t.status = 'rodando'
           AND t.heartbeat_em IS NOT NULL
           AND t.heartbeat_em < now() - v_limite_orfa)
        )
  ORDER BY t.criado_em ASC
  -- `OF t`: trava SOMENTE agente_tarefas. Ver secao 3.
  FOR UPDATE OF t SKIP LOCKED
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  UPDATE public.agente_tarefas
  SET status       = 'rodando',
      -- A tentativa e contada AQUI. Ver secao 5.
      tentativas   = tentativas + 1,
      iniciado_em  = now(),
      heartbeat_em = now()
  WHERE id = v_tarefa.id
  RETURNING * INTO v_tarefa;

  RETURN v_tarefa;
END;
$$;

COMMENT ON FUNCTION public.claim_next_agente_tarefa() IS
  'Aquisicao atomica da proxima tarefa de agente ATIVO (FOR UPDATE OF t SKIP LOCKED). Considera pendente e rodando com heartbeat orfao > 5min. Exige tentativas < max_tentativas. Incrementa tentativas no claim. Semantica AT-LEAST-ONCE: handlers devem ser idempotentes. Retorna 1 linha ou NULL.';

REVOKE EXECUTE ON FUNCTION public.claim_next_agente_tarefa() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.claim_next_agente_tarefa() FROM anon;
REVOKE EXECUTE ON FUNCTION public.claim_next_agente_tarefa() FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.claim_next_agente_tarefa() TO service_role;


-- ── CONCLUSAO ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.concluir_tarefa(
  p_tarefa_id uuid,
  p_resultado jsonb
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
    RAISE EXCEPTION 'concluir_tarefa: p_tarefa_id e obrigatorio'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.agente_tarefas
  SET status        = 'concluido',
      -- Forcado, nao aceito do chamador: "concluida" significa 100% por
      -- definicao. O CHECK `agente_tarefas_concluido_completo` continua
      -- valendo como rede para quem escrever direto no banco.
      progresso     = 100,
      resultado     = COALESCE(p_resultado, '{}'::jsonb),
      concluido_em  = now(),
      heartbeat_em  = NULL,
      -- Terminou bem: o erro da tentativa anterior deixa de descrever o
      -- estado atual.
      erro_tipo     = NULL,
      erro_mensagem = NULL
  WHERE id = p_tarefa_id
    AND status = 'rodando'
  RETURNING * INTO v_tarefa;

  -- Fora de ordem LANCA. Ver secao 6.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'concluir_tarefa: tarefa % nao esta em rodando', p_tarefa_id
      USING ERRCODE = '55000';
  END IF;

  RETURN v_tarefa;
END;
$$;

COMMENT ON FUNCTION public.concluir_tarefa(uuid, jsonb) IS
  'Conclui uma tarefa que esta em rodando: status=concluido, progresso=100, resultado persistido, erro limpo. Lanca 55000 se a tarefa nao estiver em rodando — nunca no-op silencioso.';

REVOKE EXECUTE ON FUNCTION public.concluir_tarefa(uuid, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.concluir_tarefa(uuid, jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION public.concluir_tarefa(uuid, jsonb) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.concluir_tarefa(uuid, jsonb) TO service_role;


-- ── FALHA ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.falhar_tarefa(
  p_tarefa_id     uuid,
  p_erro_tipo     text,
  p_erro_mensagem text
)
RETURNS public.agente_tarefas
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_tarefa public.agente_tarefas;
  v_status text;
BEGIN
  IF p_tarefa_id IS NULL THEN
    RAISE EXCEPTION 'falhar_tarefa: p_tarefa_id e obrigatorio'
      USING ERRCODE = '22023';
  END IF;
  -- Sem classificacao nao ha o que auditar. O CHECK
  -- `agente_tarefas_erro_explicado` exigiria isso so no status 'erro';
  -- aqui a exigencia vale tambem no retry, para que a causa nunca se
  -- perca.
  IF p_erro_tipo IS NULL OR length(btrim(p_erro_tipo)) = 0 THEN
    RAISE EXCEPTION 'falhar_tarefa: p_erro_tipo e obrigatorio'
      USING ERRCODE = '22023';
  END IF;

  SELECT CASE
           WHEN t.tentativas < t.max_tentativas THEN 'pendente'
           ELSE 'erro'
         END
    INTO v_status
  FROM public.agente_tarefas t
  WHERE t.id = p_tarefa_id
    AND t.status = 'rodando';

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'falhar_tarefa: tarefa % nao esta em rodando', p_tarefa_id
      USING ERRCODE = '55000';
  END IF;

  UPDATE public.agente_tarefas
  SET status        = v_status,
      -- Gravados nos DOIS caminhos, inclusive no retry. Ver secao 5.
      erro_tipo     = btrim(p_erro_tipo),
      erro_mensagem = left(COALESCE(p_erro_mensagem, ''), 500),
      -- `concluido_em` so no terminal: no retry a tarefa nao terminou.
      concluido_em  = CASE WHEN v_status = 'erro' THEN now() ELSE NULL END,
      heartbeat_em  = NULL
  WHERE id = p_tarefa_id
    AND status = 'rodando'
  RETURNING * INTO v_tarefa;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'falhar_tarefa: tarefa % saiu de rodando durante a falha', p_tarefa_id
      USING ERRCODE = '55000';
  END IF;

  RETURN v_tarefa;
END;
$$;

COMMENT ON FUNCTION public.falhar_tarefa(uuid, text, text) IS
  'Registra falha de uma tarefa em rodando. Devolve a fila (status=pendente) se tentativas < max_tentativas, senao encerra em erro. Grava erro_tipo/erro_mensagem nos DOIS casos. Lanca 55000 se a tarefa nao estiver em rodando.';

REVOKE EXECUTE ON FUNCTION public.falhar_tarefa(uuid, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.falhar_tarefa(uuid, text, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.falhar_tarefa(uuid, text, text) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.falhar_tarefa(uuid, text, text) TO service_role;
