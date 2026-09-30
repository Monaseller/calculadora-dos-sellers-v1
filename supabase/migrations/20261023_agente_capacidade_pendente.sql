-- AGENT-FACTORY-F7b.4.6 — a capacidade que falta, e a tarefa que espera.
--
-- ── O que esta tabela guarda, e por que ela precisa existir ─────────
--
-- Quando o agente nao tem a ferramenta que a tarefa pede, a CDS oferece
-- ativa-la no proprio chat. Entre o "oferecer" e o "continuar a tarefa"
-- ha uma espera — a pessoa clica, pode dar refresh, pode sair e voltar,
-- pode ter de autorizar uma conta no Google no meio.
--
-- O que atravessa essa espera e esta linha. Sem ela, "continue de onde
-- paramos" nao teria onde ler o que era "onde paramos" — e a pessoa
-- teria de repetir o pedido, que e exatamente o que o §9 proibe.
--
-- E a mesma licao do F7b.4.4: uma aprovacao sem `conversa_id` nao sabia
-- para qual turno voltar. Aqui o `objetivo` nasce junto.
--
-- ── O que NAO entra aqui ────────────────────────────────────────────
--
-- Nenhuma credencial, nenhum token, nenhum id vindo do modelo. `objetivo`
-- e o texto que o PROPRIO usuario escreveu — ja esta em
-- `agente_conversas_mensagens`, e e copiado para ca para que a retomada
-- nao dependa de reencontrar a mensagem certa num historico que pode ter
-- crescido.
--
-- `opcoes` e o recorte do CATALOGO que a CDS resolveu no momento do
-- pedido. Congelado de proposito: a pessoa clica no que leu, e nao no que
-- o catalogo virou depois.
--
-- ── Sem RLS, como o resto do projeto ────────────────────────────────
--
-- Autorizacao e 100% em codigo de aplicacao, e todo acesso e escopado por
-- `user_id` na propria consulta.

create table if not exists public.agente_capacidades_pendentes (
  id uuid not null default gen_random_uuid(),

  -- `text` porque TODO `user_id` deste projeto e text.
  user_id text not null,
  agente_id uuid not null,
  conversa_id uuid not null,

  -- O que a pessoa pediu, com as palavras dela. E o que sera retomado.
  objetivo text not null,

  -- O nome de gente da capacidade que faltou. Ex.: `Planilhas`.
  necessidade text not null,

  -- As opcoes que a CDS ofereceu, congeladas. Ver o cabecalho.
  opcoes jsonb not null,

  -- O que a pessoa escolheu, quando escolheu. `chave` + `origem`.
  escolha_chave text null,
  escolha_origem text null,

  estado text not null default 'pendente',

  criado_em timestamptz not null default now(),
  decidido_em timestamptz null,
  concluido_em timestamptz null,

  constraint agente_capacidades_pendentes_pk primary key (id),

  -- A MESMA FK composta das outras tabelas do agente: mirar o agente de
  -- outro dono produz um par que nao existe, e a FK derruba a instrucao.
  constraint agente_capacidades_pendentes_agente_do_mesmo_dono
    foreign key (agente_id, user_id)
    references public.agentes (id, user_id)
    on delete cascade,

  constraint agente_capacidades_pendentes_estado_valido
    check (estado in ('pendente', 'ativando', 'aguardando_conexao', 'concluida', 'recusada', 'falhou')),

  constraint agente_capacidades_pendentes_objetivo_nao_vazio
    check (length(btrim(objetivo)) > 0),

  constraint agente_capacidades_pendentes_necessidade_nao_vazia
    check (length(btrim(necessidade)) > 0),

  -- Origem so pode ser uma das duas que a CDS resolve.
  constraint agente_capacidades_pendentes_origem_valida
    check (escolha_origem is null or escolha_origem in ('cds', 'integracao')),

  -- Escolha e um par: sem um dos dois, a retomada nao sabe o que ativar.
  constraint agente_capacidades_pendentes_escolha_completa
    check (
      (escolha_chave is null and escolha_origem is null)
      or (escolha_chave is not null and escolha_origem is not null)
    )
);

-- A consulta que o chat faz ao abrir: "ha pendencia viva nesta conversa?".
-- Parcial pelos estados que ainda podem virar alguma coisa — `concluida`,
-- `recusada` e `falhou` nao reaparecem.
create index if not exists idx_agente_capacidades_pendentes_vivas
  on public.agente_capacidades_pendentes (user_id, conversa_id)
  where estado in ('pendente', 'ativando', 'aguardando_conexao');

comment on table public.agente_capacidades_pendentes is
  'F7b.4.6: capacidade que faltou numa conversa, com o objetivo original para retomar depois de ativar.';

-- ── Privilegios ─────────────────────────────────────────────────────
--
-- Mesmo desenho das outras: `service_role` faz o que a aplicacao precisa,
-- e os pseudo-roles nao alcancam nada. `revoke from public` NAO cobre
-- `anon`/`authenticated` neste projeto — ver §3 do CLAUDE.md e o bug SEC1.
revoke all on table public.agente_capacidades_pendentes from public;
revoke all on table public.agente_capacidades_pendentes from anon;
revoke all on table public.agente_capacidades_pendentes from authenticated;

grant select, insert, update, delete
  on table public.agente_capacidades_pendentes to service_role;
