-- AGENT-FACTORY-F7b.4 — a escolha de memoria do dono.
--
-- ── Por que uma coluna, e nao uma linha em outra tabela ──────────────
--
-- "Este agente lembra?" e um atributo DO AGENTE, do mesmo naipe de
-- `ativo`: um valor por agente, lido em todo turno, sem historico e sem
-- cardinalidade. Uma tabela de configuracao para um booleano criaria um
-- JOIN no caminho da resposta do chat e uma linha que pode faltar — e
-- "faltar" precisaria de um default em algum lugar de qualquer forma.
--
-- ── O default e FALSE, e isso e deliberado ──────────────────────────
--
-- Memoria automatica manda conversa para um servico externo. Ligar isso
-- por omissao em todo agente que ja existe seria decidir pelo dono uma
-- questao de privacidade que e dele. Agente existente continua sem
-- memoria automatica ate alguem ligar na tela.
--
-- `not null` para que nao exista o terceiro estado: `null` viraria
-- "nao sei", e cada leitor escolheria o seu proprio default.
alter table public.agentes
  add column if not exists memoria_ativa boolean not null default false;

comment on column public.agentes.memoria_ativa is
  'AGENT-FACTORY-F7b.4: quando true, o runtime recupera contexto de longo '
  'prazo antes de responder e ingere o turno depois. A identidade de '
  'memoria e derivada de (user_id, id) fora do banco — ver '
  'lib/agentes/memoria/identidade.ts. Default false: memoria automatica '
  'manda conversa para servico externo, e isso nao se liga por omissao.';
