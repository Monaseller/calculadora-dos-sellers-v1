-- APPROVAL-DECISION-RESUME-D5 — retomada de tarefa apos aprovacao.
--
-- ════════════════════════════════════════════════════════════════════
-- O QUE FALTA HOJE
-- ════════════════════════════════════════════════════════════════════
--
-- O D4 fechou a decisao: rejeitar e cancelar encerram a tarefa causal.
-- Aprovar, de proposito, NAO toca a tarefa — ela fica em
-- `aguardando_aprovacao` com o ponteiro intacto, porque esse par e o
-- insumo do resume. Mas o resume nao existia: `claim_next_agente_tarefa`
-- so alcanca `pendente` ou `rodando` orfa, e `retomarAprovacao` nao tem
-- chamador de producao. Uma aprovacao concedida nao produzia nada.
--
-- Esta migration instala TODO o lado de banco do resume, e nada aqui e
-- alcancavel ainda: nenhum caller de runtime chama as funcoes novas.
-- A ativacao e um slice posterior.
--
-- ════════════════════════════════════════════════════════════════════
-- POR QUE UMA COLUNA NOVA, E NAO O PONTEIRO EXISTENTE
-- ════════════════════════════════════════════════════════════════════
--
-- Quando a tarefa volta a `rodando`, o CHECK
-- `agente_tarefas_ponteiro_so_na_espera` obriga `aprovacao_aguardada_id`
-- a ser NULL. A tarefa perde, nesse instante, o vinculo com a aprovacao
-- que a retomou — e sem vinculo nao ha como uma recuperacao de queda
-- saber o que ja aconteceu.
--
-- `retomada_request_id` guarda esse vinculo. Ele NAO e um segundo
-- ponteiro: e o `request_id` do ciclo de retomada, o mesmo valor que a
-- aprovacao grava em `request_id_consumo` e que a Tool Call grava em
-- `request_id`. Os tres passam a contar a mesma historia.
--
-- ════════════════════════════════════════════════════════════════════
-- POR QUE A FK E DE TRES COLUNAS
-- ════════════════════════════════════════════════════════════════════
--
-- Uma FK por `(user_id, retomada_request_id)` provaria dono e request,
-- mas NAO que a aprovacao e daquela tarefa: outra tarefa do mesmo dono
-- satisfaria a constraint. E ela nem seria criavel — o unico existente
-- `agente_funcao_aprovacoes_consumo_unico` e PARCIAL, e o PostgreSQL
-- recusa indice parcial como alvo de chave estrangeira.
--
-- Por isso nasce um unico NAO PARCIAL sobre a tripla, e a FK amarra
-- `(user_id, id, retomada_request_id)` a `(user_id, tarefa_id,
-- request_id_consumo)`. Com `MATCH SIMPLE`, ela so e exigida quando
-- todas as colunas filhas sao nao-nulas — e `user_id`/`id` nunca sao —,
-- ou seja, exatamente quando existe marcador. Marcador causalmente
-- invalido deixa de ser possivel, em vez de ser apenas improvavel.
--
-- ════════════════════════════════════════════════════════════════════
-- POR QUE O CLAIM NORMAL PRECISA MUDAR
-- ════════════════════════════════════════════════════════════════════
--
-- Uma tarefa em resume fica `rodando`. Sem alterar o claim, o
-- recuperador de orfas a pegaria 5 minutos depois e incrementaria
-- `tentativas` — quebrando a regra de que o resume continua a MESMA
-- tentativa, e reentrando no caminho generico, que criaria uma aprovacao
-- nova para uma acao cuja execucao anterior e incerta.
--
-- A unica alteracao de comportamento no claim e a cerca
-- `retomada_request_id IS NULL`. Ordenacao, limiar de orfa, incremento,
-- fence de agente ativo, `FOR UPDATE SKIP LOCKED` e forma de retorno
-- ficam byte a byte como estavam.
--
-- ════════════════════════════════════════════════════════════════════
-- POR QUE UMA PRIMITIVA COMPARTILHADA
-- ════════════════════════════════════════════════════════════════════
--
-- O resume precisa das MESMAS provas que `aprovacao_consumir_e_abrir` ja
-- faz: estado, TTL, revisao, permissao atual, conexao atual e escrita
-- fail-closed. Reescreve-las numa funcao nova criaria duas copias que
-- teriam de concordar para sempre — e um bugfix futuro corrigiria uma e
-- esqueceria a outra.
--
-- Entao a implementacao muda de lugar, nao de conteudo:
-- `aprovacao_consumir_abrir_e_retomar` passa a ser a unica autoridade, e
-- `aprovacao_consumir_e_abrir` vira um delegador de MESMA assinatura,
-- MESMOS codigos de retorno e MESMA ACL. Quem chama nao percebe.
--
-- ════════════════════════════════════════════════════════════════════
-- N = max_tentativas TAMBEM RETOMA
-- ════════════════════════════════════════════════════════════════════
--
-- `max_tentativas` limita execucoes INICIADAS, nao continuacoes: so o
-- claim incrementa, e a pausa nao gasta tentativa. Uma tarefa que pausou
-- na ultima tentativa foi aprovada por um humano e PRECISA retomar. Por
-- isso a cerca aqui e `tentativas <= max_tentativas` — asserção contra
-- dado corrompido, ja que nenhum CHECK limita a coluna —, e nunca `<`.
--
-- ════════════════════════════════════════════════════════════════════
-- NADA AQUI EXECUTA FUNCAO
-- ════════════════════════════════════════════════════════════════════
--
-- A recuperacao de queda CLASSIFICA e encerra; ela nunca reexecuta, nao
-- fecha Tool Call aberta, nao cria aprovacao e nao inventa resultado.
-- Abertura sem desfecho significa execucao INCERTA, e incerteza nao se
-- resolve repetindo o efeito.

-- ─── 1. Marcador causal da retomada ──────────────────────────────────

alter table public.agente_tarefas
  add column if not exists retomada_request_id text;

alter table public.agente_tarefas
  add constraint agente_tarefas_retomada_so_em_execucao_ou_terminal
  check (
    retomada_request_id is null
    or status in ('rodando', 'concluido', 'erro')
  );

alter table public.agente_tarefas
  add constraint agente_tarefas_retomada_nao_vazia
  check (
    retomada_request_id is null
    or length(btrim(retomada_request_id)) > 0
  );

-- ─── 2. Unico NAO PARCIAL, alvo da FK causal ─────────────────────────
--
-- Existe para habilitar a FK, e nao para impor regra nova: a unicidade
-- semantica do request continua sendo do `consumo_unico`, que segue
-- intacto. Linhas com qualquer coluna NULL nao colidem entre si.

alter table public.agente_funcao_aprovacoes
  add constraint agente_funcao_aprovacoes_consumo_por_tarefa
  unique (user_id, tarefa_id, request_id_consumo);

alter table public.agente_tarefas
  add constraint agente_tarefas_retomada_causal
  foreign key (user_id, id, retomada_request_id)
  references public.agente_funcao_aprovacoes (user_id, tarefa_id, request_id_consumo)
  on update restrict
  on delete restrict;

-- ─── 3. Filas ────────────────────────────────────────────────────────
--
-- Nenhum predicado parcial usa `now()`: a funcao nao e IMMUTABLE e o
-- PostgreSQL recusaria o indice. O corte temporal fica na consulta.

create index if not exists idx_agente_funcao_aprovacoes_fila_retomada
  on public.agente_funcao_aprovacoes (decidido_em, id)
  where estado = 'aprovada';

create index if not exists idx_agente_tarefas_retomada_stale
  on public.agente_tarefas (heartbeat_em)
  where status = 'rodando' and retomada_request_id is not null;

-- ─── 4. Claim normal: uma cerca a mais, e so ─────────────────────────

create or replace function public.claim_next_agente_tarefa()
returns public.agente_tarefas
language plpgsql
security invoker
set search_path = public
as $$
DECLARE
  v_tarefa public.agente_tarefas;
  v_limite_orfa CONSTANT interval := interval '5 minutes';
BEGIN
  SELECT t.* INTO v_tarefa
  FROM public.agente_tarefas t
  JOIN public.agentes a
    ON a.id = t.agente_id
   AND a.user_id = t.user_id
  WHERE t.tentativas < t.max_tentativas
    AND a.ativo
    -- A UNICA linha nova. Tarefa em retomada tem dono proprio: a
    -- recuperacao do D5, que nao incrementa tentativa e nao executa
    -- Funcao. Deixa-la aqui devolveria a tarefa ao caminho generico.
    AND t.retomada_request_id IS NULL
    AND (
          t.status = 'pendente'
       OR (    t.status = 'rodando'
           AND t.heartbeat_em IS NOT NULL
           AND t.heartbeat_em < now() - v_limite_orfa)
        )
  ORDER BY t.criado_em ASC
  FOR UPDATE OF t SKIP LOCKED
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  UPDATE public.agente_tarefas
  SET status       = 'rodando',
      tentativas   = tentativas + 1,
      iniciado_em  = now(),
      heartbeat_em = now()
  WHERE id = v_tarefa.id
  RETURNING * INTO v_tarefa;
  RETURN v_tarefa;
END;
$$;

-- ─── 5. A primitiva: consumir, abrir e (opcionalmente) retomar ───────

create or replace function public.aprovacao_consumir_abrir_e_retomar(
  p_user_id text,
  p_aprovacao_id uuid,
  p_request_id text,
  p_revisao_atual text,
  p_retomar boolean,
  p_tipo_tarefa_esperado text,
  p_funcao_id_esperada text
)
returns text
language plpgsql
security invoker
set search_path = public
as $$
declare
  ap public.agente_funcao_aprovacoes%rowtype;
  v_nivel text;
  v_afetadas int;
  v_tarefa_id uuid;
begin
  if p_user_id is null or btrim(p_user_id) = '' or p_aprovacao_id is null
     or p_request_id is null or btrim(p_request_id) = '' then
    return 'entrada_invalida';
  end if;

  -- Retomar exige saber o que se espera encontrar. Os dois valores vem
  -- do contrato congelado em TypeScript; aqui eles sao CERCA, e o banco
  -- nao finge conhecer o registry.
  if p_retomar then
    if p_tipo_tarefa_esperado is null or btrim(p_tipo_tarefa_esperado) = ''
       or p_funcao_id_esperada is null or btrim(p_funcao_id_esperada) = '' then
      return 'entrada_invalida';
    end if;
  end if;

  -- 1. Expiracao materializada antes de qualquer prova.
  update public.agente_funcao_aprovacoes
     set estado = 'expirada'
   where id = p_aprovacao_id
     and user_id = p_user_id
     and estado in ('pendente', 'aprovada')
     and expira_em <= now();

  -- 2. Trava a linha. Sem isto, duas transacoes leriam `aprovada` e as
  --    duas tentariam consumir — o mesmo cuidado de
  --    `claim_next_agente_tarefa`.
  select * into ap
  from public.agente_funcao_aprovacoes a
  where a.id = p_aprovacao_id and a.user_id = p_user_id
  for update;

  if not found then return 'aprovacao_inexistente'; end if;

  -- 3. Posse do agente revalidada AQUI dentro, e nao so em TypeScript:
  --    entre a checagem da aplicacao e o COMMIT cabe uma mudanca.
  if not exists (
    select 1 from public.agentes a
    where a.id = ap.agente_id and a.user_id = p_user_id
  ) then
    return 'agente_indisponivel';
  end if;

  -- 4. Tarefa: mesmo dono E mesmo agente.
  if ap.tarefa_id is not null then
    if not exists (
      select 1 from public.agente_tarefas t
      where t.id = ap.tarefa_id and t.user_id = p_user_id and t.agente_id = ap.agente_id
    ) then
      return 'tarefa_indisponivel';
    end if;
  end if;

  -- 5. So `aprovada` e nao vencida.
  if ap.estado <> 'aprovada' then
    if ap.estado = 'pendente' then return 'aprovacao_pendente'; end if;
    if ap.estado = 'consumida' then return 'ja_consumida'; end if;
    if ap.estado = 'rejeitada' then return 'ja_rejeitada'; end if;
    if ap.estado = 'cancelada' then return 'ja_cancelada'; end if;
    return 'expirada';
  end if;

  if ap.expira_em <= now() then return 'expirada'; end if;

  -- 6. A definicao precisa ser a MESMA que o humano aprovou.
  if ap.revisao_funcao is distinct from p_revisao_atual then
    return 'aprovacao_desatualizada';
  end if;

  -- 7. Escrita continua fail-closed, e a recusa vem ANTES do consumo.
  --    Deixar seguir estouraria no CHECK de `idempotency_key` da Tool
  --    Call, com a aprovacao ja gasta e um 23514 generico no lugar de
  --    uma resposta nomeada.
  if ap.acesso = 'escrita' then
    return 'escrita_nao_suportada';
  end if;

  -- 8. Permissao ATUAL. `automatico` segue — a autoridade so ficou mais
  --    permissiva, e exigir nova aprovacao por isso seria punir o dono
  --    por relaxar a propria regra. `bloqueado` e ausente param: uma
  --    aprovacao nao revive autoridade revogada.
  select p.nivel into v_nivel
  from public.agente_permissoes p
  where p.agente_id = ap.agente_id and p.funcao_id = ap.funcao_id;

  if v_nivel is null then return 'permissao_ausente'; end if;
  if v_nivel not in ('aprovacao', 'automatico') then return 'permissao_bloqueada'; end if;

  -- 9. O alvo congelado precisa continuar sendo o alvo atual — mesma
  --    plataforma, mesmo recurso e MESMA LOJA. E aqui que a troca de
  --    loja durante a espera e barrada.
  if ap.conexao_plataforma is not null then
    if not exists (
      select 1 from public.agente_conexoes c
      where c.agente_id = ap.agente_id
        and c.user_id = p_user_id
        and c.plataforma = ap.conexao_plataforma
        and c.recurso = ap.conexao_recurso
        and c.loja_id = ap.conexao_loja_id
    ) then
      return 'conexao_indisponivel';
    end if;
  end if;

  -- ── 10. SO AGORA a tarefa causal, e so no modo retomada ───────────
  --
  -- Depois da resolucao de estado, pelo mesmo motivo do D4: uma recusa
  -- de tarefa nao pode mascarar `ja_consumida` nem `expirada`. E a
  -- ordem de lock continua Approval -> Task, nunca o inverso.
  if p_retomar then
    if ap.tarefa_id is null then
      return 'tarefa_incompativel';
    end if;

    select t.id into v_tarefa_id
    from public.agente_tarefas t
    join public.agentes ag
      on ag.id = t.agente_id
     and ag.user_id = t.user_id
    where t.id                     = ap.tarefa_id
      and t.user_id                = ap.user_id
      and t.agente_id              = ap.agente_id
      and t.status                 = 'aguardando_aprovacao'
      and t.aprovacao_aguardada_id = ap.id
      and t.retomada_request_id is null
      -- `<=`, nunca `<`: a tarefa que pausou na ultima tentativa foi
      -- aprovada por um humano e tem de retomar a MESMA tentativa.
      and t.tentativas <= t.max_tentativas
      and ag.ativo
      and t.tipo = p_tipo_tarefa_esperado
    for update of t;

    if not found then
      return 'tarefa_incompativel';
    end if;

    -- A Funcao aprovada tem de ser a que o contrato daquele tipo sabe
    -- interpretar. Sem esta cerca, o resultado de uma Funcao seria
    -- entregue ao mapper de outra.
    if ap.funcao_id is distinct from p_funcao_id_esperada then
      return 'funcao_incompativel';
    end if;
  end if;

  -- ── 11. Escritas ──────────────────────────────────────────────────
  --
  -- A ordem importa por causa da FK causal, que e IMMEDIATE: a
  -- aprovacao precisa ja carregar `request_id_consumo` quando a tarefa
  -- gravar o marcador.
  update public.agente_funcao_aprovacoes
     set estado = 'consumida',
         consumida_em = now(),
         request_id_consumo = p_request_id
   where id = ap.id
     and estado = 'aprovada';

  get diagnostics v_afetadas = row_count;
  if v_afetadas <> 1 then return 'ja_consumida'; end if;

  if p_retomar then
    -- Mesma tentativa, progresso preservado. O ponteiro sai no MESMO
    -- UPDATE que o status, porque o CHECK "ponteiro so na espera"
    -- exige isso — e o marcador entra no lugar dele como vinculo
    -- causal do ciclo de retomada.
    update public.agente_tarefas
       set status                 = 'rodando',
           aprovacao_aguardada_id = null,
           retomada_request_id    = p_request_id,
           heartbeat_em           = now(),
           iniciado_em            = now(),
           concluido_em           = null,
           resultado              = null,
           erro_tipo              = null,
           erro_mensagem          = null
     where id = v_tarefa_id
       and status = 'aguardando_aprovacao'
       and retomada_request_id is null;

    get diagnostics v_afetadas = row_count;
    if v_afetadas <> 1 then
      raise exception
        'retomada: transicao da tarefa % afetou % linhas sob lock',
        v_tarefa_id, v_afetadas using errcode = '55000';
    end if;
  end if;

  -- 12. A abertura. Mesmas 17 colunas de `registrarAbertura`, com os
  --     valores vindos da LINHA TRAVADA — nunca de parametro do
  --     chamador. `acesso` sai de `ap.acesso` e nao e escrito como
  --     'leitura' na mao: cravar a constante mascararia uma aprovacao de
  --     escrita se o passo 7 algum dia deixasse de existir.
  insert into public.agente_funcao_chamadas (
    user_id, agente_id, request_id, funcao_id, tarefa_id, acesso,
    nivel_no_momento, plataforma, recurso, loja_id, entrada_resumo,
    fase, status, codigo_desfecho, mensagem_desfecho, idempotency_key, latencia_ms
  )
  values (
    p_user_id, ap.agente_id, p_request_id, ap.funcao_id, ap.tarefa_id, ap.acesso,
    v_nivel, ap.conexao_plataforma, ap.conexao_recurso, ap.conexao_loja_id, '{}'::jsonb,
    'abertura', 'executando', null, null, null, null
  );

  return 'consumida';
end;
$$;

-- ─── 6. O consumo publico continua identico, por delegacao ───────────

create or replace function public.aprovacao_consumir_e_abrir(
  p_user_id text,
  p_aprovacao_id uuid,
  p_request_id text,
  p_revisao_atual text
)
returns text
language plpgsql
security invoker
set search_path = public
as $$
begin
  -- Mesma assinatura, mesmos codigos, mesmo comportamento. A
  -- implementacao mudou de lugar para que o resume nao precise de uma
  -- segunda copia das cercas de revisao, permissao e conexao.
  return public.aprovacao_consumir_abrir_e_retomar(
    p_user_id, p_aprovacao_id, p_request_id, p_revisao_atual,
    false, null, null
  );
end;
$$;

-- ─── 7. Inicio da retomada ───────────────────────────────────────────

create or replace function public.retomar_aprovacao_iniciar(
  p_user_id text,
  p_aprovacao_id uuid,
  p_request_id text,
  p_revisao_atual text,
  p_tipo_tarefa_esperado text,
  p_funcao_id_esperada text
)
returns text
language plpgsql
security invoker
set search_path = public
as $$
begin
  return public.aprovacao_consumir_abrir_e_retomar(
    p_user_id, p_aprovacao_id, p_request_id, p_revisao_atual,
    true, p_tipo_tarefa_esperado, p_funcao_id_esperada
  );
end;
$$;

-- ─── 8. Falha terminal de uma retomada ───────────────────────────────

create or replace function public.retomada_falhar_tarefa(
  p_tarefa_id uuid,
  p_user_id text,
  p_erro_tipo text,
  p_erro_mensagem text,
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
  if p_tarefa_id is null or p_user_id is null or btrim(p_user_id) = ''
     or p_erro_tipo is null or length(btrim(p_erro_tipo)) = 0
     or p_tentativa_esperada is null
     or p_retomada_request_id is null or btrim(p_retomada_request_id) = '' then
    raise exception 'retomada_falhar_tarefa: entrada obrigatoria ausente'
      using errcode = '22023';
  end if;

  -- Diferente de `falhar_tarefa`, esta NAO devolve a tarefa para
  -- `pendente` quando ainda ha tentativa. Depois do consumo a aprovacao
  -- nao volta: requeue mandaria a tarefa ao caminho generico, que
  -- criaria uma aprovacao nova para uma acao ja executada — ou pior,
  -- executaria direto se a permissao tiver virado `automatico`.
  update public.agente_tarefas
     set status        = 'erro',
         erro_tipo     = btrim(p_erro_tipo),
         erro_mensagem = left(coalesce(p_erro_mensagem, ''), 500),
         concluido_em  = now(),
         heartbeat_em  = null,
         resultado     = null
   where id                  = p_tarefa_id
     and user_id             = p_user_id
     and status              = 'rodando'
     and tentativas          = p_tentativa_esperada
     and retomada_request_id = p_retomada_request_id
  returning * into v_tarefa;

  if not found then
    raise exception
      'retomada_falhar_tarefa: tarefa % nao esta em rodando na tentativa % com o request desta retomada',
      p_tarefa_id, p_tentativa_esperada
      using errcode = '55000';
  end if;

  return v_tarefa;
end;
$$;

-- ─── 9. Recuperacao de retomada travada ──────────────────────────────

create or replace function public.retomada_recuperar_tarefa_stale(
  p_tarefa_id uuid,
  p_user_id text,
  p_tentativa_esperada integer,
  p_retomada_request_id text
)
returns text
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_limite_orfa constant interval := interval '5 minutes';
  v_tarefa_id uuid;
  v_aprovacao_id uuid;
  v_tem_desfecho boolean;
  v_erro_tipo text;
  v_afetadas int;
begin
  if p_tarefa_id is null or p_user_id is null or btrim(p_user_id) = ''
     or p_tentativa_esperada is null
     or p_retomada_request_id is null or btrim(p_retomada_request_id) = '' then
    return 'entrada_invalida';
  end if;

  -- O corte e calculado AQUI, e nao recebido pronto: um chamador lento
  -- com um corte antigo poderia matar uma tarefa que acabou de voltar a
  -- respirar. Heartbeat fresco derrota a recuperacao — sem erro, sem
  -- escrita, apenas `nao_stale`.
  select t.id into v_tarefa_id
  from public.agente_tarefas t
  where t.id                  = p_tarefa_id
    and t.user_id             = p_user_id
    and t.status              = 'rodando'
    and t.tentativas          = p_tentativa_esperada
    and t.retomada_request_id = p_retomada_request_id
    and t.heartbeat_em is not null
    and t.heartbeat_em < now() - v_limite_orfa
  for update of t;

  if not found then return 'nao_stale'; end if;

  -- A FK causal ja torna esta relacao estruturalmente garantida. A
  -- leitura permanece como defesa em profundidade: se um dia a
  -- integridade for contornada por DDL, e melhor recusar do que agir
  -- sobre uma causalidade que nao existe.
  select a.id into v_aprovacao_id
  from public.agente_funcao_aprovacoes a
  where a.user_id            = p_user_id
    and a.tarefa_id          = p_tarefa_id
    and a.request_id_consumo = p_retomada_request_id;

  if not found then return 'causal_incompativel'; end if;

  -- Classificacao no snapshot desta transacao. Um desfecho tardio ainda
  -- pode ser gravado depois pelo processo original; isso e aceitavel,
  -- porque nenhum dos dois ramos executa nada de novo.
  select exists (
    select 1 from public.agente_funcao_chamadas c
    where c.user_id    = p_user_id
      and c.request_id = p_retomada_request_id
      and c.fase       = 'desfecho'
  ) into v_tem_desfecho;

  if v_tem_desfecho then
    -- A Funcao rodou e o desfecho ficou registrado, mas o resultado da
    -- TAREFA se perdeu com o processo: a auditoria guarda o que
    -- aconteceu, nunca a saida. Reexecutar para recuperar o resultado e
    -- exatamente o que nao se pode fazer.
    v_erro_tipo := 'execucao_ja_ocorrida_resultado_indisponivel';
  else
    if not exists (
      select 1 from public.agente_funcao_chamadas c
      where c.user_id    = p_user_id
        and c.request_id = p_retomada_request_id
        and c.fase       = 'abertura'
    ) then
      return 'causal_incompativel';
    end if;
    -- Abertura sem desfecho: ninguem sabe se o efeito aconteceu. A
    -- chamada NAO e fechada aqui — `executando` continua sendo o sinal
    -- que o indice parcial existe para encontrar.
    v_erro_tipo := 'execucao_incerta';
  end if;

  update public.agente_tarefas
     set status        = 'erro',
         erro_tipo     = v_erro_tipo,
         erro_mensagem = 'retomada interrompida; nenhuma reexecucao automatica',
         concluido_em  = now(),
         heartbeat_em  = null,
         resultado     = null
   where id                  = v_tarefa_id
     and status              = 'rodando'
     and tentativas          = p_tentativa_esperada
     and retomada_request_id = p_retomada_request_id;

  get diagnostics v_afetadas = row_count;
  if v_afetadas <> 1 then
    raise exception
      'retomada_recuperar_tarefa_stale: encerrar tarefa % afetou % linhas sob lock',
      v_tarefa_id, v_afetadas using errcode = '55000';
  end if;

  return v_erro_tipo;
end;
$$;

-- ─── 10. Comentarios ─────────────────────────────────────────────────

comment on column public.agente_tarefas.retomada_request_id is
  'request_id do ciclo de retomada em curso ou concluido. Igual a agente_funcao_aprovacoes.request_id_consumo e a agente_funcao_chamadas.request_id do mesmo ciclo, com FK causal garantindo mesmo dono, mesma tarefa e mesmo request. NULL em tarefas que nunca passaram por retomada; o claim normal so alcanca tarefas com NULL.';

comment on function public.aprovacao_consumir_abrir_e_retomar(text, uuid, text, text, boolean, text, text) is
  'Autoridade unica do consumo de aprovacao: valida estado, TTL, revisao, escrita fail-closed, permissao e conexao atuais, consome a aprovacao e abre a Tool Call. Com p_retomar, tambem trava a tarefa causal (Approval primeiro, Task depois), exige tipo e funcao esperados, e a transiciona para rodando preservando a MESMA tentativa, com ponteiro NULL e marcador de retomada, tudo na mesma transacao. Nao executa Funcao.';

comment on function public.aprovacao_consumir_e_abrir(text, uuid, text, text) is
  'Consome uma aprovacao aprovada e abre a Tool Call correspondente. Mesma assinatura, mesmos codigos de retorno e mesmo comportamento de antes; a implementacao passou a viver em aprovacao_consumir_abrir_e_retomar para nao duplicar as cercas com a retomada. Nao toca a tarefa.';

comment on function public.retomar_aprovacao_iniciar(text, uuid, text, text, text, text) is
  'Inicia a retomada de uma tarefa pausada cuja aprovacao foi concedida: consome a aprovacao, abre a Tool Call e leva a tarefa de aguardando_aprovacao para rodando, preservando a tentativa N (inclusive N = max_tentativas), limpando o ponteiro e gravando o marcador causal — tudo atomicamente. p_tipo_tarefa_esperado e p_funcao_id_esperada vem do contrato congelado na aplicacao e sao cercados contra as linhas travadas. Nao executa Funcao.';

comment on function public.retomada_falhar_tarefa(uuid, text, text, text, integer, text) is
  'Encerra em erro uma tarefa cuja retomada falhou depois do consumo. Cercada por dono, status rodando, tentativa esperada e marcador de retomada. NUNCA devolve a tarefa para pendente: apos o consumo a aprovacao nao volta, e requeue reabriria o caminho generico sobre uma acao ja executada. Preserva progresso, tentativas e o marcador.';

comment on function public.retomada_recuperar_tarefa_stale(uuid, text, integer, text) is
  'Encerra, sem executar nada, uma retomada interrompida cuja tarefa ficou rodando com heartbeat vencido. Revalida o estado stale, a identidade causal e o estado da auditoria na MESMA transacao; heartbeat fresco devolve nao_stale sem escrever. Classifica em execucao_incerta (abertura sem desfecho) ou execucao_ja_ocorrida_resultado_indisponivel (desfecho presente). Nunca reexecuta a Funcao, nunca fecha a Tool Call aberta, nunca cria aprovacao.';

-- ─── 11. Privilegios ─────────────────────────────────────────────────
--
-- Este projeto tem ALTER DEFAULT PRIVILEGES concedendo EXECUTE a
-- `anon`/`authenticated` em toda funcao nova, e `REVOKE FROM PUBLIC`
-- NAO cobre isso — `PUBLIC` e pseudo-role distinto. Foi a causa do bug
-- SEC1, e por isso cada principal e revogado nominalmente.

revoke all on function public.aprovacao_consumir_abrir_e_retomar(text, uuid, text, text, boolean, text, text) from public;
revoke all on function public.aprovacao_consumir_abrir_e_retomar(text, uuid, text, text, boolean, text, text) from anon;
revoke all on function public.aprovacao_consumir_abrir_e_retomar(text, uuid, text, text, boolean, text, text) from authenticated;
revoke all on function public.aprovacao_consumir_abrir_e_retomar(text, uuid, text, text, boolean, text, text) from service_role;
grant execute on function public.aprovacao_consumir_abrir_e_retomar(text, uuid, text, text, boolean, text, text) to service_role;

revoke all on function public.aprovacao_consumir_e_abrir(text, uuid, text, text) from public;
revoke all on function public.aprovacao_consumir_e_abrir(text, uuid, text, text) from anon;
revoke all on function public.aprovacao_consumir_e_abrir(text, uuid, text, text) from authenticated;
revoke all on function public.aprovacao_consumir_e_abrir(text, uuid, text, text) from service_role;
grant execute on function public.aprovacao_consumir_e_abrir(text, uuid, text, text) to service_role;

revoke all on function public.retomar_aprovacao_iniciar(text, uuid, text, text, text, text) from public;
revoke all on function public.retomar_aprovacao_iniciar(text, uuid, text, text, text, text) from anon;
revoke all on function public.retomar_aprovacao_iniciar(text, uuid, text, text, text, text) from authenticated;
revoke all on function public.retomar_aprovacao_iniciar(text, uuid, text, text, text, text) from service_role;
grant execute on function public.retomar_aprovacao_iniciar(text, uuid, text, text, text, text) to service_role;

revoke all on function public.retomada_falhar_tarefa(uuid, text, text, text, integer, text) from public;
revoke all on function public.retomada_falhar_tarefa(uuid, text, text, text, integer, text) from anon;
revoke all on function public.retomada_falhar_tarefa(uuid, text, text, text, integer, text) from authenticated;
revoke all on function public.retomada_falhar_tarefa(uuid, text, text, text, integer, text) from service_role;
grant execute on function public.retomada_falhar_tarefa(uuid, text, text, text, integer, text) to service_role;

revoke all on function public.retomada_recuperar_tarefa_stale(uuid, text, integer, text) from public;
revoke all on function public.retomada_recuperar_tarefa_stale(uuid, text, integer, text) from anon;
revoke all on function public.retomada_recuperar_tarefa_stale(uuid, text, integer, text) from authenticated;
revoke all on function public.retomada_recuperar_tarefa_stale(uuid, text, integer, text) from service_role;
grant execute on function public.retomada_recuperar_tarefa_stale(uuid, text, integer, text) to service_role;

revoke all on function public.claim_next_agente_tarefa() from public;
revoke all on function public.claim_next_agente_tarefa() from anon;
revoke all on function public.claim_next_agente_tarefa() from authenticated;
revoke all on function public.claim_next_agente_tarefa() from service_role;
grant execute on function public.claim_next_agente_tarefa() to service_role;
