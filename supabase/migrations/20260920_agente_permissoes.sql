-- ============================================================
-- SKILL-1D.d.1 — permissoes reais por agente e funcao
--
-- NAO APLICADA AINDA. Este arquivo e o artefato do gate pre-migration;
-- aplicar ao banco exige autorizacao explicita, separada da criacao.
--
-- ── O QUE ESTA TABELA RESPONDE ─────────────────────────────────────
--
--   "Este agente pode usar esta Funcao, e com que grau?"
--
-- A SKILL-1C ja consome `FatoPermissao { funcaoId, nivel }` e trata
-- permissao AUSENTE como `bloqueado`. Ate hoje essa resposta so existia
-- em mock (`MOCK_PERMISSOES`), que e apresentacao, nao autoridade. Esta
-- e a primeira persistencia real.
--
-- ── FAIL-CLOSED E ESTRUTURAL, NAO POR CONVENCAO ────────────────────
--
-- Nao ha seed, nao ha trigger que crie linha por Funcao e nao ha
-- `DEFAULT 'bloqueado'`. AUSENCIA DE LINHA E O BLOQUEIO. Popular a
-- tabela com `bloqueado` inverteria a garantia: passaria a depender de
-- alguem lembrar de inserir, e uma Funcao nova nasceria sem linha —
-- portanto sem bloqueio, se o codigo lesse "ausente = permitido".
--
-- `nivel` e NOT NULL, mas so existe quando existe uma linha.
--
-- ── POR QUE `user_id` REDUNDANTE ───────────────────────────────────
--
-- Ele e derivavel de `agente_id`. Mesmo assim entra, pelo motivo que
-- `lib/agentes/capability.ts` ja documenta para `agente_tarefas`: a FK
-- composta garante que o PAR e coerente, e isso e uma garantia de BANCO
-- que vale inclusive contra SQL direto com service_role. Sem a coluna,
-- essa camada simplesmente nao existe e sobra apenas o filtro da
-- aplicacao.
--
-- Precedentes no schema: `agente_tarefas (agente_id, user_id)` e
-- `pedidos (loja_id, user_id)`.
--
-- ── PK COMPOSTA, SEM `id` ARTIFICIAL ───────────────────────────────
--
-- Nada referencia uma permissao. Um `uuid id` so teria valor se algo
-- apontasse para ela; como ninguem aponta, ele seria coluna a mais e um
-- segundo caminho de unicidade. A PK natural ja da o indice de
-- `(agente_id, ...)` de graca.
--
-- `user_id` NAO entra na PK: `agente_id` ja e unico globalmente, e
-- inclui-lo permitiria duas linhas para o mesmo par caso alguem
-- conseguisse variar o dono — exatamente o que a FK composta proibe.
--
-- ── `funcao_id` E TEXTO, SEM FK E SEM CATALOGO ─────────────────────
--
-- O catalogo de Funcoes e CODIGO (`lib/agentes/funcoes/registry.ts`), e
-- existencia ali significa "ha executor". Uma tabela espelho criaria uma
-- segunda fonte de verdade sobre existencia, e um dia as duas
-- divergiriam. O CHECK abaixo valida apenas a FORMA.
--
-- FORMATO VALIDO NAO E FUNCAO EXISTENTE. Uma linha para
-- `foo.bar.inventado` passa no CHECK e nao faz a Funcao existir: a
-- SKILL-1C avalia existencia ANTES de permissao, e devolve FALTA_FUNCAO.
--
-- ── RLS: OFF, E ISSO FOI MEDIDO ────────────────────────────────────
--
-- O projeto tem ZERO `CREATE POLICY` em linha executavel, e o CDS NAO
-- usa Supabase Auth — `auth.uid()` seria NULL numa policy, entao
-- `auth.uid() = user_id` nunca casaria. Tres migrations ja registram
-- isso por escrito (20260711, 20260803, 20260819).
--
-- Escrever policy morta aqui criaria falsa sensacao de isolamento por
-- banco. O isolamento real e: sessao assinada na aplicacao + `user_id`
-- na propria instrucao + FK composta + privilegios abaixo.
-- ============================================================

create table if not exists public.agente_permissoes (
  agente_id   uuid        not null,
  user_id     text        not null,
  funcao_id   text        not null,
  nivel       text        not null,

  -- Estado ATUAL, nunca historico. `alterado_em` diz QUANDO mudou; nao
  -- diz o que era antes nem quem mudou. Um event log append-only e
  -- divida futura registrada, e nao se finge que estas duas colunas o
  -- substituem — a licao de `agente_tarefas`, que sobrescreve estado.
  --
  -- Sem trigger de `updated_at`: o projeto nao tem esse padrao (a
  -- capability mantem `atualizado_em` a mao). O write path futuro
  -- precisara atualizar `alterado_em` explicitamente.
  criado_em   timestamptz not null default now(),
  alterado_em timestamptz not null default now(),

  constraint agente_permissoes_pk
    primary key (agente_id, funcao_id),

  -- Impede, no BANCO, permissao do dono A para agente do dono B.
  -- Apoiada em `agentes_id_por_dono UNIQUE (user_id, id)` — o Postgres
  -- casa a FK por CONJUNTO de colunas, entao a ordem invertida na
  -- referencia e correta.
  --
  -- CASCADE: permissao e estado do agente; apagado o agente, ela perde
  -- sentido. Difere de `agente_tarefas`, que usa RESTRICT porque
  -- preserva historico. Precedente direto: `agentes_ia_chamadas` usa
  -- `on delete cascade` para `agente_id`.
  --
  -- ON UPDATE RESTRICT: id e dono nao migram. Sem isso, um UPDATE em
  -- `agentes` poderia arrastar o vinculo para outro par.
  constraint agente_permissoes_agente_do_mesmo_dono
    foreign key (agente_id, user_id)
    references public.agentes (id, user_id)
    on delete cascade
    on update restrict,

  -- CHECK textual, como `agentes_tipo_valido` e
  -- `agente_tarefas_status_valido`. O projeto nao usa enum do Postgres
  -- em nenhuma tabela, e um enum exigiria `ALTER TYPE` para evoluir.
  constraint agente_permissoes_nivel_valido
    check (nivel in ('bloqueado','aprovacao','automatico')),

  -- A MESMA forma validada em `lib/ia/skills/formato.ts` (SKILL-1B) e
  -- conferida em `scripts/testar-ia-skill-1d-b.ts`. E a terceira copia
  -- da regra, e isso e assumido: ela barra lixo inserido por SQL direto,
  -- caminho que a validacao da aplicacao nao cobre. A suite desta fase
  -- compara este literal com o canonico e reprova se divergirem.
  constraint agente_permissoes_funcao_id_formato
    check (funcao_id ~ '^[a-z0-9]+(\.[a-z0-9_]+)+$')
);

-- ── SEM INDICE ADICIONAL ───────────────────────────────────────────
--
-- A PK `(agente_id, funcao_id)` serve as duas leituras previstas: todas
-- as permissoes de um agente, e a permissao de uma Funcao especifica
-- desse agente. Um indice em `agente_id` sozinho seria PREFIXO da PK —
-- duplicata pura. Um indice em `user_id` nao teria consumidor: toda
-- consulta parte de um `agente_id` ja autorizado.
--
-- O projeto ja pagou por indice redundante uma vez; nao se cria por
-- simetria.

-- ── PRIVILEGIOS ────────────────────────────────────────────────────
--
-- O REVOKE explicito NAO e redundante, e isso foi medido: este projeto
-- tem `ALTER DEFAULT PRIVILEGES` concedendo a `anon`/`authenticated`, e
-- `PUBLIC` e pseudo-role DISTINTO de `anon` — `REVOKE FROM PUBLIC` nao
-- cobre os outros dois. Foi exatamente o que causou o bug SEC1.
--
-- Segue a convencao da migration mais recente
-- (`20260919_agentes_ia_chamadas.sql`), que tambem revoga antes de
-- conceder em vez de confiar no ACL default.

revoke all on public.agente_permissoes from public;
revoke all on public.agente_permissoes from anon;
revoke all on public.agente_permissoes from authenticated;

-- CRUD completo: diferente de `agentes_ia_chamadas`, que e append-only,
-- permissao MUDA — o dono altera o nivel. `truncate`, `references` e
-- `trigger` ficam de fora por nao terem uso previsto.
grant select, insert, update, delete on public.agente_permissoes to service_role;

-- ── ROLLBACK ───────────────────────────────────────────────────────
--
--   drop table if exists public.agente_permissoes;
--
-- Seguro: esta tabela e o lado REFERENCIANTE, e nada aponta para ela —
-- `agentes` e `agente_tarefas` ficam intactos. Perde-se a configuracao
-- de permissoes, e o sistema volta a "tudo bloqueado", que e o estado
-- seguro por fail-closed.
