-- AGENT-FACTORY-F7b.4.7 — a pendencia passa a atravessar a CONEXAO.
--
-- ── O que faltava ───────────────────────────────────────────────────
--
-- O F7b.4.6 fechou "falta ferramenta -> ativa -> continua". Sobrou o caso
-- em que a ferramenta ativada precisa de uma CONTA: ali a pendencia
-- parava em `aguardando_conexao` e a tela mandava a pessoa para
-- Ferramentas — que e o mesmo defeito que o F7b.4.4 corrigiu na aprovacao,
-- de novo, num lugar diferente.
--
-- ── Os dois estados novos, e por que sao dois ────────────────────────
--
--   aguardando_conexao   a ferramenta esta no agente e falta a conta.
--                        Ninguem clicou em conectar ainda.
--
--   conectando           a pessoa clicou, o link foi gerado e ela esta
--                        (ou estava) no provedor. O cartao diz coisas
--                        diferentes nos dois casos, e colapsar os dois
--                        faria a tela repetir "conecte sua conta" para
--                        quem acabou de tentar.
--
--   escolhendo_loja      a capacidade e nativa (Mercado Livre, Shopee), a
--                        conta JA existe e falta dizer QUAL loja. Nao e
--                        conexao: e escolha entre contas que o dono ja
--                        tem, e pedir OAuth aqui seria pedir de novo o que
--                        ele ja deu.
--
-- ── As duas colunas ─────────────────────────────────────────────────
--
--   conexao_toolkit    o aplicativo que precisa de conta. E o que permite
--                      a tela dizer "conectar Google" em vez de "conectar".
--   conexao_conta_id   a conta criada no provedor externo, para CONFERIR o
--                      status depois. Nao e credencial: e um ponteiro
--                      opaco que so serve para perguntar "ja conectou?".
--
-- NENHUM token, NENHUM segredo. O `redirect_url` tambem nao e guardado:
-- ele expira, e guardar link de autorizacao seria guardar material de
-- sessao sem necessidade.
--
-- ── Por que a verificacao e por CONSULTA, e nao por callback ─────────
--
-- MEDIDO: `POST /connected_accounts/link` aceita `callback_url`,
-- `redirect_uri` e `config.callback_url` com 201, e NENHUM deles aparece
-- no `redirect_url` devolvido. Nao da para afirmar que o provedor
-- redireciona de volta para a CDS — e conferir isso exigiria concluir um
-- OAuth real, que este gate proibe.
--
-- Entao a volta nao depende do provedor: quando a pessoa reabre o chat, a
-- CDS CONSULTA o status da conta e, se estiver pronta, retoma. Funciona
-- com callback, sem callback, com a aba trocada e no dia seguinte.

alter table public.agente_capacidades_pendentes
  drop constraint if exists agente_capacidades_pendentes_estado_valido;

alter table public.agente_capacidades_pendentes
  add constraint agente_capacidades_pendentes_estado_valido
  check (estado in (
    'pendente', 'ativando', 'aguardando_conexao', 'conectando',
    'escolhendo_loja', 'concluida', 'recusada', 'falhou'
  ));

alter table public.agente_capacidades_pendentes
  add column if not exists conexao_conta_id text null;

alter table public.agente_capacidades_pendentes
  add column if not exists conexao_toolkit text null;

-- O indice parcial acompanha a lista de estados vivos. As duas
-- definicoes de "vivo" precisam concordar, senao o cartao reaparece na
-- tela e desaparece da consulta.
drop index if exists idx_agente_capacidades_pendentes_vivas;

create index if not exists idx_agente_capacidades_pendentes_vivas
  on public.agente_capacidades_pendentes (user_id, conversa_id)
  where estado in (
    'pendente', 'ativando', 'aguardando_conexao', 'conectando', 'escolhendo_loja'
  );

-- GRANT por coluna, como no resto do projeto: coluna nova nasce sem
-- privilegio, e sem isto a escrita falharia com `42501` em silencio — foi
-- exatamente o que aconteceu na 20261021.
grant update (conexao_conta_id, conexao_toolkit)
  on table public.agente_capacidades_pendentes to service_role;

comment on column public.agente_capacidades_pendentes.conexao_conta_id is
  'F7b.4.7: a conta externa criada para esta pendencia, para conferir o status depois.';
comment on column public.agente_capacidades_pendentes.conexao_toolkit is
  'F7b.4.7: o aplicativo que precisa de conta. NULL quando nao ha conexao pendente.';
