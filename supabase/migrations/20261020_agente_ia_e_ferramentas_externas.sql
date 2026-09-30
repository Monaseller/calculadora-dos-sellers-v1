-- AGENT-FACTORY-F7b.4.2 — a IA do agente, e o vinculo de ferramenta externa.
--
-- Duas mudancas, e as duas corrigem coisas que estavam implicitas.
--
-- ═══════════════════════════════════════════════════════════════════════
-- 1. A IA e do AGENTE, e nao do ambiente
-- ═══════════════════════════════════════════════════════════════════════
--
-- Ate aqui o provedor era resolvido pelo gateway a partir de env: todos os
-- agentes usavam o mesmo cerebro, e trocar o cerebro de um trocava o de
-- todos. Isso nunca foi decisao de produto — foi consequencia de nao haver
-- onde guardar a escolha.
--
-- As tres colunas nascem NULL, e `null` tem significado: "este agente nao
-- escolheu, use o default do ambiente". E o que preserva o comportamento
-- dos agentes que ja existem, que e exigencia explicita do gate.
--
-- ── Por que NAO ha CHECK de valor em `provedor_ia` ──────────────────────
--
-- A lista de provedores compativeis e MEDIDA, nao declarada: ela vive em
-- `lib/agentes/factory/catalogo-de-modelos.ts`, onde cada entrada aponta a
-- suite que provou a capacidade. Um CHECK aqui congelaria essa lista no
-- banco, e o dia em que um provedor entrasse exigiria migration — o que
-- transformaria "provamos que funciona" em "precisamos de DDL".
--
-- O formato E restringido, porque formato nao e opiniao: minusculas e
-- underscore, como os outros identificadores desta area.
--
-- ═══════════════════════════════════════════════════════════════════════
-- 2. Selecionar ferramenta NAO e conceder permissao
-- ═══════════════════════════════════════════════════════════════════════
--
-- No F7b.4.1 vincular uma acao externa ERA gravar a permissao dela. A
-- intencao era boa — sem tabela paralela, sem estado para reconciliar —
-- mas o efeito estava errado em dois pontos:
--
--   a) toda acao vinculada nascia com um nivel, entao o estado
--      "selecionada e ainda nao decidida" nao existia. A regra de
--      completude da ativacao nao tinha o que barrar, e a decisao
--      explicita do dono virava um default nosso.
--
--   b) apagar o vinculo era impossivel sem apagar a permissao, e a
--      permissao e justamente o registro historico de uma decisao.
--
-- Agora sao duas coisas:
--
--   POSSUIR   `agente_ferramentas_externas`  -> o agente TEM esta acao
--   PODER     `agente_permissoes`            -> COMO ele pode usa-la
--
-- E a consequencia que importa, exigida pelo gate: uma permissao que
-- sobrou de um vinculo removido NAO ressuscita a ferramenta. Quem afirma
-- que a Funcao externa EXISTE e o vinculo; a permissao so diz o nivel. Sem
-- vinculo, `declararFerramentas` nao a declara e o guard a trata como
-- inexistente — mesmo com a linha de permissao ainda la.
--
-- ── Sem FK para `agente_permissoes`, de proposito ───────────────────────
--
-- As duas tabelas descrevem fatos independentes, e uma FK criaria uma
-- ordem obrigatoria entre eles ("nao pode vincular antes de permitir" ou o
-- contrario). O estado interessante — vinculado e sem permissao — e
-- exatamente o que uma FK impediria de existir.

-- ─── 1. A IA do agente ───────────────────────────────────────────────

alter table public.agentes
  add column if not exists provedor_ia text,
  add column if not exists modelo_ia text,
  add column if not exists nivel_de_trabalho text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'agentes_provedor_ia_formato'
  ) then
    alter table public.agentes
      add constraint agentes_provedor_ia_formato
      check (provedor_ia is null or provedor_ia ~ '^[a-z][a-z0-9_]{1,30}$');
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'agentes_modelo_ia_formato'
  ) then
    -- Id de modelo carrega ponto e hifen (`gpt-5.2`,
    -- `claude-haiku-4-5`, `gemini-3.8-flash`). O CHECK e de forma e de
    -- tamanho, e nao de lista: quem decide quais modelos existem e o
    -- catalogo, que aponta a prova de cada um.
    alter table public.agentes
      add constraint agentes_modelo_ia_formato
      check (modelo_ia is null or modelo_ia ~ '^[A-Za-z0-9][A-Za-z0-9._-]{1,80}$');
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'agentes_nivel_de_trabalho_valido'
  ) then
    -- Aqui o CHECK de VALOR e correto: os quatro rotulos sao da CDS, nao
    -- do provedor, e nao mudam quando um provedor novo entra.
    alter table public.agentes
      add constraint agentes_nivel_de_trabalho_valido
      check (nivel_de_trabalho is null
             or nivel_de_trabalho in ('rapido','equilibrado','avancado','maximo'));
  end if;
end $$;

comment on column public.agentes.provedor_ia is
  'AGENT-FACTORY-F7b.4.2: o provedor escolhido para ESTE agente. NULL = nao escolheu, usa o default do ambiente (comportamento dos agentes anteriores a esta coluna). Sem CHECK de lista: quais provedores existem e decidido pelo catalogo, que aponta a prova de cada um.';
comment on column public.agentes.modelo_ia is
  'AGENT-FACTORY-F7b.4.2: o id de modelo escolhido. NULL = default do ambiente.';
comment on column public.agentes.nivel_de_trabalho is
  'AGENT-FACTORY-F7b.4.2: rotulo da CDS (rapido/equilibrado/avancado/maximo), traduzido por cada adaptador para o parametro real do provedor. NULL = default do modelo.';

-- ─── 2. O vinculo de ferramenta externa ──────────────────────────────

create table if not exists public.agente_ferramentas_externas (
  id uuid primary key default gen_random_uuid(),

  -- Dono e agente JUNTOS, como no resto da area: a FK composta torna
  -- cross-tenant impossivel no banco, e nao dependente de filtro no
  -- codigo.
  user_id text not null,
  agente_id uuid not null,

  -- `composio` hoje. Coluna, e nao valor fixo, porque um segundo catalogo
  -- externo nao deveria exigir migration.
  provedor_externo text not null,
  toolkit text not null,
  acao text not null,

  -- O id canonico que o guard e `agente_permissoes` usam. Redundante em
  -- relacao as tres colunas acima, e guardado de proposito: e ele que
  -- amarra vinculo e permissao, e derivar em SQL espalharia a regra de
  -- composicao por duas linguagens.
  funcao_id text not null,

  criado_em timestamptz not null default now(),

  -- Um vinculo por acao, por agente. Vincular duas vezes e a MESMA coisa.
  constraint agente_ferramentas_externas_unica
    unique (agente_id, funcao_id),

  constraint agente_ferramentas_externas_agente_fk
    foreign key (agente_id, user_id)
    references public.agentes (id, user_id)
    on delete cascade,

  -- O MESMO formato de `agente_permissoes.funcao_id`. Sem isto, um vinculo
  -- poderia existir com um id que a permissao nunca aceitaria — e o par
  -- ficaria eternamente incompleto.
  constraint agente_ferramentas_externas_funcao_id_formato
    check (funcao_id ~ '^[a-z0-9]+(\.[a-z0-9_]+)+$'),

  constraint agente_ferramentas_externas_provedor_formato
    check (provedor_externo ~ '^[a-z][a-z0-9_]{1,30}$'),
  constraint agente_ferramentas_externas_toolkit_formato
    check (toolkit ~ '^[a-z0-9][a-z0-9_-]{0,60}$'),
  constraint agente_ferramentas_externas_acao_nao_vazia
    check (length(btrim(acao)) > 0)
);

-- A leitura quente: "o que este agente possui?". Sempre por dono+agente.
create index if not exists agente_ferramentas_externas_por_agente
  on public.agente_ferramentas_externas (user_id, agente_id);

comment on table public.agente_ferramentas_externas is
  'AGENT-FACTORY-F7b.4.2: o que o agente POSSUI de ferramenta externa. Separado de agente_permissoes, que diz COMO ele pode usar. Selecionar nao concede: uma acao vinculada sem linha de permissao fica UNCONFIGURED e barra a ativacao. E permissao que sobrou de um vinculo removido NAO ressuscita a ferramenta — quem afirma existencia e esta tabela.';

-- Privilegios: o padrao desta area. `service_role` opera; `anon` e
-- `authenticated` nao alcancam a tabela, porque nenhuma autorizacao deste
-- projeto vem de RLS.
revoke all on public.agente_ferramentas_externas from public;
revoke all on public.agente_ferramentas_externas from anon;
revoke all on public.agente_ferramentas_externas from authenticated;
grant select, insert, update, delete on public.agente_ferramentas_externas to service_role;
