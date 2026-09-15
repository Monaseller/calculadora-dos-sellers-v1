-- APPROVAL-DECISION-RESUME-D4 — a decisao humana passa a encerrar a Tarefa.
--
-- ════════════════════════════════════════════════════════════════════
-- O QUE ESTAVA QUEBRADO
-- ════════════════════════════════════════════════════════════════════
--
-- `aprovacao_decidir` era Approval-only: mudava a aprovacao e NAO tocava
-- `agente_tarefas`. Rejeitar deixava a tarefa em `aguardando_aprovacao`
-- com o ponteiro apontando para uma aprovacao ja rejeitada — e nada a
-- resgatava, porque `claim_next_agente_tarefa` so alcanca `pendente` ou
-- `rodando` orfa. A tarefa encalhava para sempre.
--
-- ════════════════════════════════════════════════════════════════════
-- POR QUE `CREATE OR REPLACE` DA MESMA ASSINATURA, E NAO UMA NOVA RPC
-- ════════════════════════════════════════════════════════════════════
--
-- A informacao que faltava — QUAL tarefa — ja esta na propria aprovacao
-- (`tarefa_id`), e ela ja e escopada por dono. Nenhum parametro novo e
-- necessario, entao a assinatura nao muda e nao nasce overload. Isso
-- importa: o D3 acabou de custar cinco gates para remover uma overload
-- legada, e repetir o padrao sem necessidade seria criar a mesma divida
-- de novo. Substituicao in-place preserva OID e nao exige cutover.
--
-- ════════════════════════════════════════════════════════════════════
-- ORDEM DE LOCK: APPROVAL -> TASK. NUNCA O INVERSO.
-- ════════════════════════════════════════════════════════════════════
--
-- `aprovacao_consumir_e_abrir` ja trava a aprovacao primeiro. A pausa
-- (`aguardar_aprovacao_tarefa`) escreve a tarefa e le a aprovacao por
-- MVCC, DE PROPOSITO sem `FOR UPDATE`, para nao inverter a ordem do
-- sistema. Esta funcao segue a mesma direcao: aprovacao primeiro,
-- tarefa depois. Nenhuma rotina do sistema trava tarefa antes de
-- aprovacao, entao o ciclo nunca fecha.
--
-- ════════════════════════════════════════════════════════════════════
-- ORDEM DAS CHECAGENS, E POR QUE A TAREFA E A ULTIMA
-- ════════════════════════════════════════════════════════════════════
--
--   A. validar entrada e vocabulario
--   B. travar a aprovacao por id + dono
--   C. inexistente -> 'aprovacao_inexistente'
--   D. materializar expiracao
--   E. resolver estado: ja_* / expirada
--   F. SO ENTAO, se a acao ainda e elegivel: travar e validar a tarefa
--   G. escrever
--
-- A tarefa e validada por ULTIMO porque `tarefa_incompativel` nao pode
-- mascarar um `ja_aprovada` ou um `expirada`. Quem clica duas vezes tem
-- de receber o motivo real, nao um erro sobre a tarefa.
--
-- ════════════════════════════════════════════════════════════════════
-- FAIL-CLOSED TAMBEM NO APPROVE
-- ════════════════════════════════════════════════════════════════════
--
-- Se a aprovacao aponta para uma tarefa mas a tarefa nao esta esperando
-- POR ELA, aprovar produziria uma `aprovada` inalcancavel: o resume do
-- D5 procura exatamente tarefa em `aguardando_aprovacao` com o ponteiro
-- casando. Melhor recusar agora do que gerar lixo que so o D7 varreria.
--
-- ════════════════════════════════════════════════════════════════════
-- O PONTEIRO SAI NO MESMO UPDATE QUE O STATUS
-- ════════════════════════════════════════════════════════════════════
--
-- CHECK `agente_tarefas_ponteiro_so_na_espera`:
--   status = 'aguardando_aprovacao' OR aprovacao_aguardada_id IS NULL
-- Em dois statements o CHECK dispara no primeiro. Nao e estilo: e o que
-- o schema impoe.
--
-- Campos terminais explicitos (status/ponteiro/heartbeat/concluido_em/
-- resultado/erro_*) seguem a convencao de `concluir_tarefa`, que zera
-- `erro_*` redundantemente vindo de `rodando`: a transicao terminal
-- estabelece o proprio invariante em vez de herda-lo. `progresso` e
-- `tentativas` sao PRESERVADOS — espera humana nao e tentativa, e o
-- progresso registra ate onde a tarefa chegou.
--
-- NAO cria Tool Call, NAO consome aprovacao, NAO executa Funcao.
-- Expiracao de tarefa orfa e corrida de pausa continuam sendo do D7.

create or replace function public.aprovacao_decidir(
  p_user_id text,
  p_aprovacao_id uuid,
  p_decisao text,
  p_motivo text
)
returns text
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_aprovacao public.agente_funcao_aprovacoes;
  v_tarefa_id uuid;
  v_motivo    text;
  v_afetadas  int;
begin
  -- ── A. entrada e vocabulario, antes de qualquer lock ──────────────
  if p_user_id is null or btrim(p_user_id) = '' or p_aprovacao_id is null then
    return 'entrada_invalida';
  end if;

  if p_decisao not in ('aprovar', 'rejeitar', 'cancelar') then
    return 'decisao_invalida';
  end if;

  -- ── B. PRIMEIRO LOCK DO FLUXO: a aprovacao ────────────────────────
  select a.* into v_aprovacao
  from public.agente_funcao_aprovacoes a
  where a.id = p_aprovacao_id
    and a.user_id = p_user_id
  for update;

  -- ── C. inexistente e de outro dono devolvem a MESMA coisa ─────────
  if not found then
    return 'aprovacao_inexistente';
  end if;

  -- ── D. expiracao materializada, alterando SOMENTE `estado` ────────
  --
  -- Uma `aprovada` que vence continua carregando quem aprovou e quando.
  if v_aprovacao.estado in ('pendente', 'aprovada')
     and v_aprovacao.expira_em <= now() then
    update public.agente_funcao_aprovacoes
       set estado = 'expirada'
     where id = p_aprovacao_id;

    get diagnostics v_afetadas = row_count;
    if v_afetadas <> 1 then
      raise exception
        'aprovacao_decidir: expiracao de % afetou % linhas sob lock',
        p_aprovacao_id, v_afetadas using errcode = '55000';
    end if;

    return 'expirada';
  end if;

  -- ── E. estados que encerram a decisao ANTES de olhar a tarefa ─────
  if v_aprovacao.estado = 'rejeitada' then return 'ja_rejeitada'; end if;
  if v_aprovacao.estado = 'cancelada' then return 'ja_cancelada'; end if;
  if v_aprovacao.estado = 'consumida' then return 'ja_consumida'; end if;
  if v_aprovacao.estado = 'expirada'  then return 'expirada';     end if;

  -- `aprovada` encerra aprovar e rejeitar, mas NAO cancelar.
  if v_aprovacao.estado = 'aprovada' and p_decisao <> 'cancelar' then
    return 'ja_aprovada';
  end if;

  -- Sobra apenas: pendente (as tres decisoes) ou aprovada + cancelar.

  -- ── F. SO AGORA a tarefa causal, e so se houver vinculo ───────────
  --
  -- `tarefa_id` e nullable: aprovacao sem tarefa decide sozinha, sem
  -- procurar nem travar linha nenhuma.
  if v_aprovacao.tarefa_id is not null then
    select t.id into v_tarefa_id
    from public.agente_tarefas t
    where t.id                     = v_aprovacao.tarefa_id
      and t.user_id                = v_aprovacao.user_id
      and t.agente_id              = v_aprovacao.agente_id
      and t.status                 = 'aguardando_aprovacao'
      and t.aprovacao_aguardada_id = v_aprovacao.id
    for update;

    -- Mismatch e descoberto SOB OS DOIS LOCKS e ANTES da primeira
    -- escrita. Rejeitar a aprovacao e so depois descobrir que a tarefa
    -- nao casa deixaria metade da transicao gravada — exatamente o
    -- defeito que este D4 existe para eliminar.
    if not found then
      return 'tarefa_incompativel';
    end if;
  end if;

  -- ── G. escritas ───────────────────────────────────────────────────
  if p_decisao = 'aprovar' then
    update public.agente_funcao_aprovacoes
       set estado       = 'aprovada',
           decidido_por = p_user_id,
           decidido_em  = now()
     where id = p_aprovacao_id;

    get diagnostics v_afetadas = row_count;
    if v_afetadas <> 1 then
      raise exception
        'aprovacao_decidir: aprovar % afetou % linhas sob lock',
        p_aprovacao_id, v_afetadas using errcode = '55000';
    end if;

    -- A TAREFA NAO E TOCADA. Ela permanece em `aguardando_aprovacao`
    -- com o ponteiro intacto: e exatamente esse par que o resume do D5
    -- vai reivindicar.
    return 'aprovada';
  end if;

  if p_decisao = 'rejeitar' then
    -- Motivo em branco vira NULL: o CHECK recusa texto so de espacos, e
    -- normalizar aqui evita transformar um campo opcional em erro.
    v_motivo := nullif(btrim(coalesce(p_motivo, '')), '');

    update public.agente_funcao_aprovacoes
       set estado        = 'rejeitada',
           decidido_por  = p_user_id,
           decidido_em   = now(),
           motivo_recusa = v_motivo
     where id = p_aprovacao_id;

    get diagnostics v_afetadas = row_count;
    if v_afetadas <> 1 then
      raise exception
        'aprovacao_decidir: rejeitar % afetou % linhas sob lock',
        p_aprovacao_id, v_afetadas using errcode = '55000';
    end if;
  else
    -- Cancelar aceita as duas origens, e NAO toca `decidido_*`: quando
    -- vem de `aprovada`, quem aprovou continua registrado ao lado de
    -- quem cancelou.
    update public.agente_funcao_aprovacoes
       set estado        = 'cancelada',
           cancelado_por = p_user_id,
           cancelado_em  = now()
     where id = p_aprovacao_id;

    get diagnostics v_afetadas = row_count;
    if v_afetadas <> 1 then
      raise exception
        'aprovacao_decidir: cancelar % afetou % linhas sob lock',
        p_aprovacao_id, v_afetadas using errcode = '55000';
    end if;
  end if;

  -- Rejeitar e cancelar encerram a tarefa do mesmo jeito. O que os
  -- distingue vive na aprovacao: `motivo_recusa` + `decidido_*` de um
  -- lado, `cancelado_*` do outro.
  if v_tarefa_id is not null then
    update public.agente_tarefas
       set status                 = 'cancelado',
           aprovacao_aguardada_id = null,
           heartbeat_em           = null,
           concluido_em           = now(),
           resultado              = null,
           erro_tipo              = null,
           erro_mensagem          = null
     where id = v_tarefa_id;

    get diagnostics v_afetadas = row_count;
    if v_afetadas <> 1 then
      raise exception
        'aprovacao_decidir: encerrar tarefa % afetou % linhas sob lock',
        v_tarefa_id, v_afetadas using errcode = '55000';
    end if;
  end if;

  if p_decisao = 'rejeitar' then return 'rejeitada'; end if;
  return 'cancelada';
end;
$$;

comment on function public.aprovacao_decidir(text, uuid, text, text) is
  'Aprovar/rejeitar (somente de pendente) ou cancelar (de pendente ou aprovada), e ENCERRAR a tarefa causal quando a decisao for terminal. Trava a aprovacao primeiro e a tarefa depois — nunca o inverso. Resolve ja_*/expirada ANTES de olhar a tarefa, para que tarefa_incompativel nunca mascare um estado ja decidido. Com tarefa_id nao nulo exige tarefa em aguardando_aprovacao, mesmo dono/agente e ponteiro casando; senao devolve tarefa_incompativel SEM escrever nada. Aprovar nao toca a tarefa (insumo do resume). Rejeitar e cancelar levam a tarefa a cancelado com ponteiro NULL no MESMO UPDATE, zerando heartbeat/resultado/erro e carimbando concluido_em, preservando progresso e tentativas. decidido_por deriva de p_user_id. Cancelar preserva decidido_por/em. NAO cria Tool Call, NAO consome aprovacao, NAO executa Funcao.';

revoke all on function public.aprovacao_decidir(text, uuid, text, text) from public;
revoke all on function public.aprovacao_decidir(text, uuid, text, text) from anon;
revoke all on function public.aprovacao_decidir(text, uuid, text, text) from authenticated;
revoke all on function public.aprovacao_decidir(text, uuid, text, text) from service_role;
grant execute on function public.aprovacao_decidir(text, uuid, text, text) to service_role;
