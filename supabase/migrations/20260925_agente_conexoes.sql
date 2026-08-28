-- ============================================================
-- SKILL-1D.g.1-A — `agente_conexoes`: seleção EXPLÍCITA de loja
--
-- NAO APLICADA AINDA. Aplicar ao banco exige autorizacao explicita,
-- separada da criacao deste arquivo.
--
-- ── A PERGUNTA QUE ESTA TABELA RESPONDE ─────────────────────────────
--
-- `resolverFatoConexao` (lib/agentes/conexoes/fatos.ts) EXIGE um
-- `lojaId` e se recusa, por escrito, a escolher:
--
--   "Nao escolhe loja: com varias contas da mesma plataforma, escolher
--    'a primeira conectada' seria decidir pelo dono qual conta sofre o
--    efeito. A selecao pertence a camada de cima."
--
-- Hoje ninguem fornece esse `lojaId`. E o blocker da SKILL-1D.e: com
-- duas contas Shopee do mesmo dono, nada diz QUAL delas atende o
-- requisito de uma Skill. Esta tabela e a resposta, e nada alem dela.
--
-- ── POR QUE A CHAVE E (agente_id, plataforma, recurso) ──────────────
--
-- `plataforma`/`recurso` e a identidade CANONICA de um requisito de
-- conexao, e nao uma invencao desta migration: o motor de diagnostico ja
-- trabalha assim. Em `lib/ia/skills/diagnostico.ts`:
--
--   chaveConexao = (plataforma, recurso) => `${plataforma}/${recurso}`
--
-- e `diagnosticarSkill` DEDUPLICA os requisitos por essa chave antes de
-- avaliar, resolvendo `obrigatoria` por OR. `conexaoDe()` casa fato e
-- requisito pelo mesmo par. `RequisitoConexao` nao tem id proprio — a
-- identidade dele E o par, e por isso a selecao se ancora nele.
--
-- Consequencia boa: a chave e textual e estavel entre VERSOES de Skill.
-- Se a v2 mantem `(shopee, chat)`, a selecao continua valendo sozinha.
--
-- ── E POR QUE NAO POR SKILL ─────────────────────────────────────────
--
-- `skill_id` NAO entra na chave. A selecao pertence ao AGENTE, pelo
-- mesmo motivo que `agente_permissoes` tem PK `(agente_id, funcao_id)`:
-- a permissao e do agente para uma Funcao, e Skills apenas REQUEREM
-- Funcoes. A simetria e exata — Skills REQUEREM `(plataforma, recurso)`,
-- e o agente e configurado com qual loja atende isso.
--
-- Se a chave incluisse `skill_id`, duas Skills do mesmo agente exigindo
-- `(shopee, chat)` poderiam apontar para lojas diferentes: o MESMO
-- agente agindo sobre duas contas Shopee para a MESMA capacidade. Isso
-- contradiz o modelo de permissoes, onde ha UM nivel por funcao por
-- agente. E a selecao sobreviveria a dissociacao da Skill sem dono.
--
-- ── ONDE A SELECAO APONTA ───────────────────────────────────────────
--
-- Para `lojas.id`. Nao ha entidade "conexao" neste projeto: a camada de
-- conexoes le `.from("lojas")`, e `20260826_lojas_autoridade_dono.sql`
-- fixou que autoridade e `user_id + loja_id`. `seller_id`/`shop_id` sao
-- atributo externo — o mesmo seller compartilhado entre donos os torna
-- inuteis como identidade, e por isso nao aparecem aqui.
--
-- ── PLATAFORMA NAO TEM CHECK, E ISSO E DELIBERADO ───────────────────
--
-- Existe uma contradicao REAL no HEAD, medida e nao suposta:
--
--   MARKETPLACE_POR_PLATAFORMA usa a chave `mercado_livre`
--   o parser valida `plataforma` com slug(), e
--   RE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/ REJEITA underscore
--
-- Ou seja: hoje nenhuma Skill consegue declarar requisito de Mercado
-- Livre — o arquivo seria recusado com `campo_invalido`. So `shopee`
-- atravessa o parser.
--
-- Congelar um vocabulario num CHECK enquanto o contrato nao consegue
-- expressa-lo produziria uma migration corretiva na primeira vez que a
-- divergencia fosse resolvida. A reconciliacao (`RE_SLUG` x
-- `MARKETPLACE_POR_PLATAFORMA`) e frente propria.
--
-- ATENCAO: ausencia de CHECK aqui NAO autoriza a futura camada de
-- escrita a aceitar plataforma arbitraria. A validacao fail-closed do
-- write path sera desenhada depois, contra o vocabulario vigente.
--
-- ── ON DELETE: assimetrico de proposito ─────────────────────────────
--
-- Agente CASCADE: apagado o agente, a configuracao perde a entidade
-- dona. Precedente: `agente_permissoes`, `agente_skills`.
--
-- Loja RESTRICT: uma loja selecionada nao pode desaparecer em silencio e
-- deixar a configuracao apontando para nada. As FKs de `lojas` no
-- projeto variam (NO ACTION, CASCADE, SET NULL), entao esta escolha e
-- declarada, nao herdada — e segue a mesma intencao de
-- `agente_skills_skill_do_mesmo_dono`, que tambem e RESTRICT para nao
-- perder a referencia.
--
-- ── O QUE ESTA MIGRATION NAO FAZ ────────────────────────────────────
--
-- Nao altera `agentes`, `lojas`, `agente_permissoes`, `agente_skills`
-- nem `skills` — os dois anchors de FK ja existem e foram provados no
-- catalogo real (SKILL-1D.g.0):
--
--   agentes_id_por_dono     UNIQUE (user_id, id)   valido
--   lojas_id_user_id_unico  UNIQUE (id, user_id)   valido
--
-- Nao cria funcao, trigger, view, tipo, sequencia nem indice extra. Nao
-- habilita RLS (nenhuma tabela deste projeto usa). Nao insere dado: a
-- tabela nasce vazia. Nao toca `ALTER DEFAULT PRIVILEGES` — a divida
-- raiz continua fora do escopo, e esta migration apenas se defende.
-- ============================================================

create table if not exists public.agente_conexoes (
  agente_id   uuid        not null,
  user_id     text        not null,

  -- O requisito canonico, exatamente como o motor de diagnostico o
  -- identifica. Sao texto porque o contrato de Skill os declara como
  -- slug livre — nao ha enum a espelhar.
  plataforma  text        not null,
  recurso     text        not null,

  -- A escolha. `not null`: uma linha existe para dizer QUAL loja, e
  -- "selecionado como nada" seria a mesma coisa que nao ter linha.
  loja_id     uuid        not null,

  -- Estado ATUAL, nunca historico. Mesmo par de `agente_permissoes`.
  -- Nao ha trigger de `alterado_em` porque este projeto nao tem trigger
  -- nenhum: quem escreve atualiza a coluna explicitamente.
  criado_em   timestamptz not null default now(),
  alterado_em timestamptz not null default now(),

  -- UM agente + UM requisito canonico = no maximo UMA loja. Sem uuid
  -- artificial: a identidade logica ja e unica, e um id sintetico so
  -- criaria uma segunda forma de dizer a mesma coisa.
  constraint agente_conexoes_pk
    primary key (agente_id, plataforma, recurso),

  -- Ownership fechado no BANCO, nao por disciplina de aplicacao. A FK
  -- composta impede que um agente do dono A selecione loja do dono B —
  -- as duas pontas carregam o mesmo `user_id`.
  constraint agente_conexoes_agente_do_mesmo_dono
    foreign key (agente_id, user_id)
    references public.agentes (id, user_id)
    on delete cascade
    on update restrict,

  constraint agente_conexoes_loja_do_mesmo_dono
    foreign key (loja_id, user_id)
    references public.lojas (id, user_id)
    on delete restrict
    on update restrict,

  -- FORMATO, nunca vocabulario. O contrato valida `recurso` com o mesmo
  -- slug (`RE_SLUG` em formato.ts), e `recurso` e chave OPACA para o
  -- motor: enumerar `chat`, `pedidos`, `anuncios` aqui transformaria uma
  -- lista de exemplos em regra, e cada recurso novo viraria migration.
  -- Precedente de CHECK de formato: `agente_permissoes_funcao_id_formato`
  -- e `skills_slug_formato`.
  constraint agente_conexoes_recurso_formato
    check (recurso ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);

-- ── Privilegios ─────────────────────────────────────────────────────
--
-- Medido no catalogo real (SKILL-1D.g.0): existe
--
--   ALTER DEFAULT PRIVILEGES do papel `supabase_admin`, schema `public`,
--   objeto `r`, concedendo `arwdDxtm` a anon E a authenticated
--
-- Ou seja: TODA tabela nova nasce com leitura, escrita, delete, truncate,
-- references, trigger e maintain para os dois papeis de cliente. Os
-- REVOKE nominais abaixo NAO sao redundancia de `from public`: `PUBLIC`
-- e um pseudo-role distinto, e revoga-lo nao alcanca uma concessao
-- nominal. Foi exatamente a causa do bug SEC1.
--
-- `service_role` tambem e revogado antes do grant: GRANT e aditivo, e
-- comecar de estado conhecido e a unica forma de o arquivo descrever o
-- resultado. Sem isso, a tabela ficaria com `arwdDxtm` — foi o que
-- aconteceu com `agentes` e `lojas`, que ainda carregam a ACL legada.
--
-- O grant e CRUD e nada mais: sem TRUNCATE, REFERENCES, TRIGGER nem
-- MAINTAIN. Precedente: `20260921_agente_permissoes_privilegios.sql`.

revoke all on table public.agente_conexoes from public;
revoke all on table public.agente_conexoes from anon;
revoke all on table public.agente_conexoes from authenticated;
revoke all on table public.agente_conexoes from service_role;

grant select, insert, update, delete on table public.agente_conexoes to service_role;
