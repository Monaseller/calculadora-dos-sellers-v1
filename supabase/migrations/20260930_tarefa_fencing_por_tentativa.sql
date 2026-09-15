-- ══════════════════════════════════════════════════════════════════════
-- APPROVAL-DECISION-RESUME-B0 — quem tem direito de terminalizar.
--
-- Ate aqui `concluir_tarefa` e `falhar_tarefa` perguntavam duas coisas:
-- "e esta tarefa?" e "ela esta em rodando?". Faltava a terceira, e ela
-- e a que importa quando existe mais de um executor possivel:
--
--     "voce ainda e o dono DESTA tentativa?"
--
-- ── Por que isso vira problema agora, e nao antes ────────────────────
--
-- Hoje o unico produtor e o worker, logo apos o claim, e a janela entre
-- reivindicar e terminalizar e curta. Mesmo assim ela existe: o claim
-- recupera tarefa `rodando` com batimento parado ha mais de 5 minutos,
-- e nesse instante passam a existir DUAS execucoes em voo sobre a mesma
-- linha. A antiga, que so estava lenta, volta e escreve o desfecho dela
-- por cima da tentativa nova — e o banco deixava, porque `status` ainda
-- era `rodando` e ninguem perguntava de quem.
--
-- Com Resume, essa janela deixa de ser excecao: passara a existir um
-- segundo caminho legitimo que leva a tarefa de volta a `rodando`. Por
-- isso o fencing entra ANTES do Resume, e nao junto — corrigir uma
-- corrida depois de multiplicar os corredores e a ordem errada.
--
-- ── O que muda, exatamente ───────────────────────────────────────────
--
-- As duas RPCs passam a exigir `tentativas = p_tentativa_esperada`,
-- ALEM de id e `status = 'rodando'`. Os tres juntos, e o `status`
-- continua: uma tarefa em `aguardando_aprovacao` pode carregar a mesma
-- tentativa e nao deve ser terminalizavel por ninguem.
--
-- O que NAO muda: a politica de retry, o limite de tentativas, os
-- campos escritos, o retorno e o 55000 fail-closed. O fencing decide
-- QUEM registra o desfecho, nunca QUAL desfecho e.
--
-- ── Por que esta migration NAO remove as assinaturas antigas ─────────
--
-- Porque remover aqui criaria uma janela em que producao e banco
-- discordam, em QUALQUER ordem de rollout:
--
--   migration primeiro  o codigo publicado chama `concluir_tarefa` com
--                       duas chaves; a funcao de duas chaves nao existe
--                       mais; nenhuma tarefa consegue terminalizar.
--   codigo primeiro     o codigo novo chama com tres chaves; a de tres
--                       ainda nao existe; mesmo resultado.
--
-- E a janela nao seria teorica: dois crons de minuto (`* * * * *`)
-- garantem que ela seja exercitada. Uma tarefa apanhada nela fica em
-- `rodando` com batimento parado, so volta pela recuperacao de orfa
-- cinco minutos depois, reencontra o mesmo erro e queima `tentativas`
-- ate morrer em `erro` — por contrato, nao por defeito de negocio.
--
-- Entao esta e a FASE A de um cutover aditivo: as quatro assinaturas
-- coexistem, o codigo antigo continua resolvendo a dele e o novo, quando
-- chegar, resolve a dele. As antigas saem numa migration SEPARADA, so
-- depois de o novo caller estar provado em producao. Enquanto durar a
-- coexistencia, voltar atras no deploy tambem continua seguro.
--
-- ── O que faz a resolucao ser inequivoca ─────────────────────────────
--
-- O PostgREST escolhe o overload casando o CONJUNTO DE CHAVES do corpo
-- JSON com os nomes dos parametros. `{p_tarefa_id, p_resultado}` casa
-- so a antiga; com `p_tentativa_esperada` junto, casa so a nova.
--
-- Isso depende de `p_tentativa_esperada` NAO ter DEFAULT. Com default,
-- o corpo de duas chaves passaria a casar as DUAS e o PostgREST
-- responderia 300. Por isso o parametro e obrigatorio aqui: nao e so
-- rigor de validacao, e o que sustenta o rollout.
--
-- Nada abaixo toca as assinaturas antigas — nem DROP, nem ALTER, nem
-- CREATE OR REPLACE, nem GRANT. Elas ficam exatamente como estao.
-- ══════════════════════════════════════════════════════════════════════

-- ── 1. CONCLUSAO, agora com dono ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.concluir_tarefa(
  p_tarefa_id          uuid,
  p_resultado          jsonb,
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
    RAISE EXCEPTION 'concluir_tarefa: p_tarefa_id e obrigatorio'
      USING ERRCODE = '22023';
  END IF;

  -- Obrigatorio, e nao opcional com default: um parametro que pudesse
  -- ser omitido reintroduziria exatamente o caminho sem fencing que o
  -- DROP acima existe para fechar.
  IF p_tentativa_esperada IS NULL THEN
    RAISE EXCEPTION 'concluir_tarefa: p_tentativa_esperada e obrigatorio'
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
  WHERE id         = p_tarefa_id
    AND status     = 'rodando'
    -- O FENCE. Um executor atrasado carrega a tentativa DELE; se o
    -- claim ja devolveu a linha a outro, os numeros divergem e este
    -- UPDATE nao alcanca nada.
    AND tentativas = p_tentativa_esperada
  RETURNING * INTO v_tarefa;

  -- Fora de ordem LANCA — nunca no-op silencioso, e nunca idempotencia
  -- fingida. A mensagem separa os dois motivos porque eles pedem
  -- investigacoes diferentes: `status` errado e chamada fora do ciclo;
  -- tentativa errada e execucao velha ainda em voo.
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.agente_tarefas t
                WHERE t.id = p_tarefa_id AND t.status = 'rodando') THEN
      RAISE EXCEPTION
        'concluir_tarefa: tarefa % nao esta na tentativa esperada %',
        p_tarefa_id, p_tentativa_esperada
        USING ERRCODE = '55000';
    END IF;
    RAISE EXCEPTION 'concluir_tarefa: tarefa % nao esta em rodando', p_tarefa_id
      USING ERRCODE = '55000';
  END IF;

  RETURN v_tarefa;
END;
$$;

COMMENT ON FUNCTION public.concluir_tarefa(uuid, jsonb, integer) IS
  'Conclui uma tarefa que esta em rodando NA TENTATIVA ESPERADA: status=concluido, progresso=100, resultado persistido, erro limpo. Fencing por (id, status, tentativas) — um executor atrasado nao terminaliza a tentativa de outro. Lanca 55000 se o trio nao casar, distinguindo status de tentativa; nunca no-op silencioso.';


-- ── 2. FALHA, com o fence nos DOIS pontos ─────────────────────────────
CREATE OR REPLACE FUNCTION public.falhar_tarefa(
  p_tarefa_id          uuid,
  p_erro_tipo          text,
  p_erro_mensagem      text,
  p_tentativa_esperada integer
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
  IF p_tentativa_esperada IS NULL THEN
    RAISE EXCEPTION 'falhar_tarefa: p_tentativa_esperada e obrigatorio'
      USING ERRCODE = '22023';
  END IF;

  -- ── O fence no SELECT ──────────────────────────────────────────────
  --
  -- Ele precisa estar AQUI tambem, e nao so no UPDATE: e este SELECT
  -- que decide entre devolver a fila e encerrar em erro, lendo
  -- `tentativas`/`max_tentativas`. Sem o fence, um executor atrasado
  -- leria a contagem da tentativa ALHEIA e escolheria o desfecho dela.
  SELECT CASE
           WHEN t.tentativas < t.max_tentativas THEN 'pendente'
           ELSE 'erro'
         END
    INTO v_status
  FROM public.agente_tarefas t
  WHERE t.id         = p_tarefa_id
    AND t.status     = 'rodando'
    AND t.tentativas = p_tentativa_esperada;

  IF v_status IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.agente_tarefas t
                WHERE t.id = p_tarefa_id AND t.status = 'rodando') THEN
      RAISE EXCEPTION
        'falhar_tarefa: tarefa % nao esta na tentativa esperada %',
        p_tarefa_id, p_tentativa_esperada
        USING ERRCODE = '55000';
    END IF;
    RAISE EXCEPTION 'falhar_tarefa: tarefa % nao esta em rodando', p_tarefa_id
      USING ERRCODE = '55000';
  END IF;

  -- ── E o fence no UPDATE ────────────────────────────────────────────
  --
  -- Repetido de proposito: entre o SELECT e o UPDATE a linha pode
  -- trocar de dono, e a janela tem de continuar fechada. Sem isto, o
  -- fence do SELECT seria apenas uma leitura otimista.
  UPDATE public.agente_tarefas
  SET status        = v_status,
      -- Gravados nos DOIS caminhos, inclusive no retry.
      erro_tipo     = btrim(p_erro_tipo),
      erro_mensagem = left(COALESCE(p_erro_mensagem, ''), 500),
      -- `concluido_em` so no terminal: no retry a tarefa nao terminou.
      concluido_em  = CASE WHEN v_status = 'erro' THEN now() ELSE NULL END,
      heartbeat_em  = NULL
  WHERE id         = p_tarefa_id
    AND status     = 'rodando'
    AND tentativas = p_tentativa_esperada
  RETURNING * INTO v_tarefa;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'falhar_tarefa: tarefa % saiu da tentativa % durante a falha',
      p_tarefa_id, p_tentativa_esperada
      USING ERRCODE = '55000';
  END IF;

  RETURN v_tarefa;
END;
$$;

COMMENT ON FUNCTION public.falhar_tarefa(uuid, text, text, integer) IS
  'Registra falha de uma tarefa em rodando NA TENTATIVA ESPERADA. Devolve a fila (status=pendente) se tentativas < max_tentativas, senao encerra em erro. Grava erro_tipo/erro_mensagem nos DOIS casos. Fencing por (id, status, tentativas) no SELECT que decide o desfecho E no UPDATE que o escreve. Lanca 55000 se o trio nao casar.';


-- ── 3. Privilegios: neutralizar defaults e conceder o minimo ───────────
--
-- `pg_default_acl` concede EXECUTE a `anon`, `authenticated` e
-- `service_role` em toda funcao nova. Os quatro REVOKE deixam a
-- concessao final explicita em vez de herdada.
--
-- Valem SO para as assinaturas novas: os privilegios das antigas nao
-- sao mexidos aqui. Padronizar a ACL delas seria alterar objeto que
-- esta em uso por producao, no slice errado.
REVOKE ALL ON FUNCTION public.concluir_tarefa(uuid, jsonb, integer) FROM public;
REVOKE ALL ON FUNCTION public.concluir_tarefa(uuid, jsonb, integer) FROM anon;
REVOKE ALL ON FUNCTION public.concluir_tarefa(uuid, jsonb, integer) FROM authenticated;
REVOKE ALL ON FUNCTION public.concluir_tarefa(uuid, jsonb, integer) FROM service_role;
GRANT EXECUTE ON FUNCTION public.concluir_tarefa(uuid, jsonb, integer) TO service_role;

REVOKE ALL ON FUNCTION public.falhar_tarefa(uuid, text, text, integer) FROM public;
REVOKE ALL ON FUNCTION public.falhar_tarefa(uuid, text, text, integer) FROM anon;
REVOKE ALL ON FUNCTION public.falhar_tarefa(uuid, text, text, integer) FROM authenticated;
REVOKE ALL ON FUNCTION public.falhar_tarefa(uuid, text, text, integer) FROM service_role;
GRANT EXECUTE ON FUNCTION public.falhar_tarefa(uuid, text, text, integer) TO service_role;
