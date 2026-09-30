-- AGENT-FACTORY-F7b.4.4 — a aprovacao passa a saber de qual CONVERSA veio.
--
-- ── O defeito que isto corrige ──────────────────────────────────────
--
-- `agente_funcao_aprovacoes` nasceu para Funcao de TAREFA, onde a
-- retomada tem fila propria. Quando o chat passou a usar o mesmo guard, a
-- aprovacao continuou sem nenhuma referencia a conversa — e sem ela nao
-- havia como voltar ao turno depois de aprovar.
--
-- O efeito, medido pelo Rodrigo no Preview: o cartao mandava para
-- `/ia/aprovacoes`, ele aprovava la, voltava, e o chat estava do jeito que
-- ficou — parado. Reperguntar criava o mesmo bloqueio de novo.
--
-- ── As tres colunas, e por que sao exatamente estas ─────────────────
--
--   conversa_id        para onde voltar.
--   pedido_id          QUAL chamada do modelo ficou pendente. E o id que
--                      o provedor deu ao `tool_use`/`function_call`, e ele
--                      e obrigatorio para remontar o dialogo: todo
--                      provedor exige que o resultado da ferramenta cite
--                      o id do pedido que o originou.
--   texto_assistente   o que o modelo disse JUNTO do pedido. Pode ser
--                      null (muitos turnos so pedem a ferramenta), e
--                      preservar isso mantem o dialogo fiel.
--
-- NAO entra aqui o historico da conversa: ele ja esta em
-- `agente_conversas_mensagens` e duplica-lo criaria duas verdades sobre o
-- que foi dito. O que se guarda e so o que NAO e derivavel de la.
--
-- As tres sao NULL por definicao: aprovacao de Tarefa nao tem conversa, e
-- toda aprovacao ja existente continua valendo exatamente como esta (§16).
--
-- ── Sem RLS, como o resto do projeto ────────────────────────────────
--
-- Autorizacao e 100% em codigo de aplicacao. O indice novo e escopado por
-- `user_id` pelo mesmo motivo de todos os outros aqui.

alter table public.agente_funcao_aprovacoes
  add column if not exists conversa_id uuid null;

alter table public.agente_funcao_aprovacoes
  add column if not exists pedido_id text null;

alter table public.agente_funcao_aprovacoes
  add column if not exists texto_assistente text null;

-- `pedido_id` vem do provedor: nunca vazio quando presente. Um id em
-- branco produziria um dialogo que o provedor recusa na remontagem, e o
-- erro apareceria longe daqui.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'agente_funcao_aprovacoes_pedido_id_nao_vazio'
  ) then
    alter table public.agente_funcao_aprovacoes
      add constraint agente_funcao_aprovacoes_pedido_id_nao_vazio
      check (pedido_id is null or length(btrim(pedido_id)) > 0);
  end if;
end $$;

-- Retomar exige conversa E pedido juntos: com um so, o dialogo nao
-- remonta. Amarrar os dois aqui impede um estado meio-preenchido que so
-- falharia na hora de retomar.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'agente_funcao_aprovacoes_retomada_completa'
  ) then
    alter table public.agente_funcao_aprovacoes
      add constraint agente_funcao_aprovacoes_retomada_completa
      check (
        (conversa_id is null and pedido_id is null)
        or (conversa_id is not null and pedido_id is not null)
      );
  end if;
end $$;

-- A consulta que o chat faz ao abrir uma conversa: "ha aprovacao viva
-- aqui?". Parcial pelos dois estados que ainda podem ser retomados —
-- `consumida`, `rejeitada` e `expirada` nao reaparecem como pendentes.
create index if not exists idx_agente_funcao_aprovacoes_conversa_viva
  on public.agente_funcao_aprovacoes (user_id, conversa_id)
  where conversa_id is not null and estado in ('pendente', 'aprovada');

comment on column public.agente_funcao_aprovacoes.conversa_id is
  'F7b.4.4: a conversa que originou esta aprovacao. NULL para aprovacao de Tarefa.';
comment on column public.agente_funcao_aprovacoes.pedido_id is
  'F7b.4.4: o id do tool_use/function_call do provedor que ficou pendente.';
comment on column public.agente_funcao_aprovacoes.texto_assistente is
  'F7b.4.4: o texto que o modelo disse junto do pedido de ferramenta. Pode ser NULL.';
