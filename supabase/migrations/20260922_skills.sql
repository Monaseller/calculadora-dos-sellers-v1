-- ============================================================
-- SKILL-1D.f.1 — persistencia de Skills e associacao a agentes
--
-- NAO APLICADA AINDA. Este arquivo e o artefato do gate pre-migration;
-- aplicar ao banco exige autorizacao explicita, separada da criacao.
--
-- ── O QUE ESTAS TABELAS RESPONDEM ──────────────────────────────────
--
--   skills         "que conhecimento operacional este dono possui?"
--   agente_skills  "que conhecimento ESTE agente usa?"
--
-- Ate hoje `lib/ia/skills/formato.ts` sabia LER uma Skill e nao havia
-- onde guardar. `diagnosticarSkill` recebe `skill` como parametro e nao
-- tem chamador de producao justamente porque ninguem consegue carregar
-- uma. Esta e a primeira persistencia.
--
-- ── SKILL E DADO, NUNCA AUTORIDADE ─────────────────────────────────
--
-- Uma Skill e importavel de fora da CDS, entao e por definicao dado NAO
-- confiavel. `contrato.ts` ja garante isso pela ausencia: o manifesto nao
-- tem campo para permissao, autonomia, nivel, credencial, token, codigo,
-- handler, `user_id` nem `agente_id`.
--
-- Aqui a mesma regra vira schema. `user_id` existe SO como coluna de
-- posse, e `agente_id` SO na tabela de associacao — nenhum dos dois entra
-- no documento. E o que mantem a Skill portatil: amarrar o dono dentro do
-- manifesto impediria exporta-la.
--
-- ── POR QUE O MANIFESTO INTEIRO EM JSONB ───────────────────────────
--
-- Normalizar `requer` em colunas criaria uma SEGUNDA definicao do
-- contrato, agora em SQL — e `formato` e versionado exatamente para poder
-- mudar. Um dia as duas divergiriam, e a de SQL venceria por acidente.
--
-- O manifesto guardado e o objeto SANEADO que `importarSkill` devolve:
-- chaves desconhecidas ja viraram nomes em `descartados` e nao chegam
-- aqui. O texto BRUTO original nao e guardado em lugar nenhum — guarda-lo
-- reintroduziria tudo que o parser recusou.
--
-- Precedente de jsonb no projeto: 11 colunas, com o mesmo
-- `CHECK jsonb_typeof(x) = 'object'` de `resultados_pipeline`,
-- `compliance_marketplace` e `validacao_oficial_ml`.
--
-- ── LINHA POR VERSAO, IMUTAVEL NO CONTEUDO ─────────────────────────
--
-- Nao ha `alterado_em`, e a ausencia e deliberada: conteudo novo gera
-- LINHA nova, nunca `UPDATE` no manifesto. A unica coluna que muda depois
-- de escrita e `vigente`, e ela e ponteiro, nao conteudo.
--
-- Isso e o que permite a decisao de produto: o agente aponta para a
-- VERSAO, e editar uma Skill nao muda em silencio o que um agente ja faz.
-- ============================================================

create table if not exists public.skills (
  id       uuid not null default gen_random_uuid(),
  user_id  text not null,

  -- `slug` e `versao` sao o par de identidade LOGICA. `id` existe porque
  -- `agente_skills` precisa apontar para UMA versao, e apontar por
  -- (slug, versao) exigiria FK de tres colunas carregando o dono junto.
  slug     text not null,
  versao   text not null,

  nome     text not null,
  origem   text not null,

  manifesto jsonb not null,

  -- O corpo da Skill ACEITA — nao o texto bruto recebido na importacao.
  -- Markdown livre, e conteudo do USUARIO: quando existir montagem de
  -- prompt ele entrara delimitado e rotulado, jamais concatenado como se
  -- fosse autoridade da CDS.
  --
  -- A revalidacao por `acharSegredos` na escrita pertence ao write path,
  -- nao a esta migration: SQL nao tem como reimplementar os 5 padroes do
  -- parser sem virar uma sexta copia que diverge na primeira mudanca.
  corpo    text not null,

  -- SHA-256 do texto BRUTO recebido, calculado ANTES da sanitizacao.
  --
  -- Responde "esta linha veio daquele arquivo?" sem guardar o arquivo.
  -- NAO e unique de proposito: o mesmo texto pode ser legitimamente
  -- importado por donos diferentes, e ate pelo mesmo dono como versao
  -- distinta se o manifesto mudou. Unicidade aqui recusaria importacao
  -- valida.
  --
  -- Calculado pela APLICACAO. O banco nao computa: fazer o hash aqui
  -- exigiria o bruto chegar ao banco, que e exatamente o que nao deve
  -- acontecer.
  conteudo_hash text not null,

  -- Ponteiro para "a versao que vale agora", por (dono, slug). Sem
  -- default `true` e sem troca automatica: promover versao e ato
  -- explicito do write path, nunca efeito colateral de INSERT.
  vigente  boolean not null default false,

  criado_em timestamptz not null default now(),

  constraint skills_pk primary key (id),

  -- Uma versao por slug, por dono. Reimportar a mesma versao recusa.
  constraint skills_versao_unica unique (user_id, slug, versao),

  -- Habilita a FK composta de `agente_skills`. Mesmo papel de
  -- `agentes_id_por_dono`.
  constraint skills_id_por_dono unique (user_id, id),

  constraint skills_manifesto_objeto
    check (jsonb_typeof(manifesto) = 'object'),

  -- MESMO dominio de `RE_SLUG` em `lib/ia/skills/formato.ts`, lido antes
  -- de escrever esta linha. O original e `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`;
  -- aqui o grupo nao-capturante e desnecessario e foi normalizado. A
  -- suite compara os dois literais e reprova se divergirem.
  constraint skills_slug_formato
    check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),

  -- Os tres valores de `ORIGENS_SKILL`. CHECK textual, como
  -- `agentes_tipo_valido` — o projeto nao usa enum do Postgres.
  constraint skills_origem_valida
    check (origem in ('oficial_cds','importada','gerada_ia')),

  -- SHA-256 em hex minusculo. 64 caracteres, nem 63 nem 65.
  constraint skills_conteudo_hash_formato
    check (conteudo_hash ~ '^[0-9a-f]{64}$'),

  -- ── COLUNA x MANIFESTO: UMA VERDADE, NAO DUAS ────────────────────
  --
  -- As colunas promovidas existem para consultar sem abrir o jsonb. Isso
  -- cria o risco classico de duas verdades: alguem faz UPDATE em `nome` e
  -- o manifesto continua dizendo outra coisa. A aplicacao NAO pode ser a
  -- unica responsavel por manter isso alinhado.
  --
  -- ARMADILHA FECHADA AQUI: `manifesto->>'id'` devolve NULL quando a
  -- chave nao existe, e `slug = NULL` avalia como NULL — que um CHECK
  -- ACEITA, porque so `false` reprova. Escrito sem o `is not null`, cada
  -- um destes CHECKs falharia ABERTO justamente no caso que ele existe
  -- para pegar: manifesto sem a chave. Por isso os quatro testam
  -- existencia antes de comparar.
  constraint skills_slug_igual_ao_manifesto
    check (manifesto->>'id' is not null and slug = manifesto->>'id'),
  constraint skills_versao_igual_ao_manifesto
    check (manifesto->>'versao' is not null and versao = manifesto->>'versao'),
  constraint skills_nome_igual_ao_manifesto
    check (manifesto->>'nome' is not null and nome = manifesto->>'nome'),
  constraint skills_origem_igual_ao_manifesto
    check (manifesto->>'origem' is not null and origem = manifesto->>'origem'),

  -- `formato` nao vira coluna: ninguem consulta por ele. Mas o manifesto
  -- precisa declarar o formato que ESTE codigo sabe ler.
  -- `FORMATO_SUPORTADO = 1`, e o parser RECUSA qualquer outro em vez de
  -- adaptar. O CHECK repete a regra para barrar o caminho que o parser
  -- nao cobre: SQL direto.
  --
  -- Custo assumido: um formato 2 exigira migration. E o custo certo —
  -- guardar manifesto v2 numa tabela cujos leitores esperam v1 seria pior
  -- que uma migration.
  --
  -- Compara como TEXTO, nao com `::int`: cast de texto nao-numerico
  -- LANCA 22P02 dentro do CHECK em vez de devolver violacao 23514, e erro
  -- de tipo disfarçado de erro de constraint confunde quem depura.
  constraint skills_formato_suportado
    check (jsonb_typeof(manifesto->'formato') = 'number'
           and manifesto->>'formato' = '1')
);

-- NO MAXIMO UMA versao vigente por (dono, slug) — garantido pelo BANCO,
-- nao por disciplina de aplicacao. Precedente direto:
-- `idx_conteudo_versoes_aprovada_unica ... WHERE aprovado`, em
-- `20260820_conteudo_versoes_editorial.sql`.
--
-- Indice PARCIAL: as linhas com `vigente = false` sao a maioria e nao
-- participam da restricao. Um unique comum sobre (user_id, slug)
-- permitiria uma unica versao por Skill, que e o oposto do desejado.
create unique index if not exists idx_skills_vigente_por_slug
  on public.skills (user_id, slug)
  where vigente;

-- ── SEM INDICE ADICIONAL ───────────────────────────────────────────
--
-- `skills_versao_unica (user_id, slug, versao)` ja serve "todas as Skills
-- do dono" e "todas as versoes deste slug" por prefixo. Um indice so em
-- `user_id` seria PREFIXO dele — duplicata pura. O projeto ja pagou por
-- indice redundante uma vez; nao se cria por simetria.

-- ============================================================
-- agente_skills — a associacao, e nada alem dela
-- ============================================================
--
-- Quatro colunas. Nao ha `ordem`, `prioridade`, `ativa`, `loja_id`,
-- `nivel` nem `obrigatoria`:
--
--   ordem/prioridade  so importam para montagem de prompt, que nao
--                     existe. Uniao de requisitos e comutativa.
--   ativa             desassociar e DELETE. Um booleano criaria dois
--                     jeitos de dizer "nao usa mais".
--   loja_id           Skill declara requisito de conexao
--                     (plataforma/recurso), nunca autoridade de loja. A
--                     selecao de loja por requisito e fase propria.
--   nivel/autonomia   vivem em `agente_permissoes`, decididos pelo dono.
--
-- A regra "obrigatoria vence opcional" quando duas Skills pedem a mesma
-- Funcao NAO vira coluna nem trigger: e regra PURA de composicao, e o
-- lugar dela e o codigo que unir os requisitos.
create table if not exists public.agente_skills (
  agente_id uuid        not null,
  skill_id  uuid        not null,
  user_id   text        not null,
  criado_em timestamptz not null default now(),

  -- A mesma versao da mesma Skill nao entra duas vezes no mesmo agente.
  -- Varias Skills DIFERENTES no mesmo agente continuam permitidas — a PK
  -- restringe o par, nunca o agente.
  constraint agente_skills_pk primary key (agente_id, skill_id),

  -- Impede, no BANCO, agente do dono A associado a Skill do dono B.
  -- Apoiadas em `agentes_id_por_dono` e `skills_id_por_dono` — o Postgres
  -- casa a FK por CONJUNTO de colunas, entao a ordem invertida na
  -- referencia esta certa. Precedentes: `agente_permissoes`,
  -- `pedidos (loja_id, user_id)`.
  --
  -- CASCADE no agente: a associacao e estado dele; apagado o agente, ela
  -- perde sentido. Mesma decisao de `agente_permissoes`.
  constraint agente_skills_agente_do_mesmo_dono
    foreign key (agente_id, user_id)
    references public.agentes (id, user_id)
    on delete cascade
    on update restrict,

  -- RESTRICT na Skill, e a assimetria e o ponto: apagar uma Skill que
  -- algum agente usa deve FALHAR. Um CASCADE aqui removeria capacidade de
  -- um agente em producao como efeito colateral de uma limpeza de
  -- biblioteca. Desassociar e ato explicito.
  constraint agente_skills_skill_do_mesmo_dono
    foreign key (skill_id, user_id)
    references public.skills (id, user_id)
    on delete restrict
    on update restrict
);

-- ── SEM INDICE ADICIONAL ───────────────────────────────────────────
--
-- A PK `(agente_id, skill_id)` serve a leitura prevista: "todas as Skills
-- deste agente". A leitura inversa ("que agentes usam esta Skill") nao
-- tem consumidor; quando tiver, ganha indice proprio com justificativa.

-- ============================================================
-- RLS — OFF, coerente com o padrao medido
-- ============================================================
--
-- Zero `CREATE POLICY` em linha executavel no repositorio inteiro, e o
-- CDS nao usa Supabase Auth: numa policy, `auth.uid()` seria NULL e
-- `auth.uid() = user_id` nunca casaria. Tres migrations ja registram isso
-- por escrito (20260711, 20260803, 20260819).
--
-- Escrever policy morta aqui criaria falsa sensacao de isolamento por
-- banco. O isolamento real e: sessao assinada + `user_id` na propria
-- instrucao + FK composta + os privilegios abaixo.

-- ============================================================
-- PRIVILEGIOS — REVOKE ANTES DE GRANT, INCLUSIVE service_role
-- ============================================================
--
-- Este projeto tem `ALTER DEFAULT PRIVILEGES` concedendo os OITO
-- privilegios a `service_role` em TODA tabela nova. `GRANT` e ADITIVO:
-- ele concede e nunca restringe, entao conceder CRUD sobre uma tabela que
-- ja nasceu com tudo nao tira nada.
--
-- Foi exatamente o que aconteceu com `agente_permissoes`, e antes dela
-- com `agentes_ia_chamadas` — as duas precisaram de corretiva. Aqui o
-- REVOKE vem antes, na propria migration de criacao.
--
-- Sao OITO, nao sete: `arwdDxtm` inclui `MAINTAIN` (PG17+), que
-- `information_schema.role_table_grants` NAO reporta. So `REVOKE ALL`
-- alcanca os oito sem depender de enumera-los.
--
-- A causa raiz (o default privilege global) NAO e corrigida aqui: ela tem
-- frente propria, e resolve-la de passagem atingiria tabelas futuras sem
-- revisao.

revoke all on table public.skills from public;
revoke all on table public.skills from anon;
revoke all on table public.skills from authenticated;
revoke all on table public.skills from service_role;

revoke all on table public.agente_skills from public;
revoke all on table public.agente_skills from anon;
revoke all on table public.agente_skills from authenticated;
revoke all on table public.agente_skills from service_role;

-- ── skills: IMUTABILIDADE GARANTIDA POR PRIVILEGIO ─────────────────
--
-- O schema DECLARA que uma versao e imutavel quanto ao conteudo: edicao
-- gera linha nova, e so `vigente` muda depois da criacao. Um
-- `grant update` de TABELA contradiria essa declaracao — permitiria
-- reescrever `slug`, `versao`, `nome`, `origem`, `manifesto`, `corpo`,
-- `conteudo_hash` e ate `user_id`, desde que as constraints continuassem
-- satisfeitas. As constraints checam COERENCIA, nao imutabilidade: os
-- quatro CHECKs de equivalencia continuariam valendo se manifesto e
-- colunas fossem reescritos JUNTOS.
--
-- Por isso o UPDATE e concedido POR COLUNA. `vigente` e a unica coluna
-- com operacao de escrita legitima depois do INSERT — promover versao. O
-- resto so muda por INSERT de linha nova ou DELETE.
--
-- Nota para a fase de prova em banco (1D.f.1b): privilegio de coluna NAO
-- aparece em `pg_class.relacl` — ele vive em `pg_attribute.attacl`, e a
-- leitura correta e `information_schema.column_privileges` ou
-- `has_column_privilege()`. Conferir so o `relacl` mostraria "sem UPDATE"
-- e esconderia o grant de coluna.
grant select, insert, delete on table public.skills to service_role;
grant update (vigente) on table public.skills to service_role;

-- ── agente_skills: SEM UPDATE, por menor privilegio ────────────────
--
-- A tabela nao tem coluna legitimamente mutavel: `agente_id`, `skill_id`
-- e `user_id` sao identidade, e `criado_em` e historico. Trocar a Skill
-- de um agente nao e "editar a associacao" — e apagar uma e criar outra.
--
-- Nao ha operacao valida de UPDATE aqui, entao o privilegio nao e
-- concedido. O motivo e esse, e nao "UPDATE escaparia da FK": as FKs sao
-- verificadas em UPDATE tambem.
grant select, insert, delete on table public.agente_skills to service_role;

-- ── ESTADO FINAL ESPERADO ──────────────────────────────────────────
--
--   public / anon / authenticated  -> nenhum, nas duas tabelas
--   service_role em skills         -> ard  na TABELA
--                                     + UPDATE apenas na coluna `vigente`
--   service_role em agente_skills  -> ard  (sem UPDATE em lugar nenhum)
--
-- Sem TRUNCATE, sem REFERENCES, sem TRIGGER, sem MAINTAIN.
--
-- Conferir pelo CATALOGO, nunca por este arquivo — e nos DOIS lugares,
-- porque privilegio de tabela e de coluna moram separados:
--
--   select relname, relacl from pg_class
--    where relname in ('skills','agente_skills');
--
--   select table_name, column_name, privilege_type
--     from information_schema.column_privileges
--    where table_schema = 'public' and grantee = 'service_role';

-- ── ZERO AUTOMACAO ─────────────────────────────────────────────────
--
-- Nenhum trigger: nada associa Skill, troca versao, marca `vigente`,
-- desassocia, altera agente ou concede permissao sozinho. Nenhum seed,
-- nenhum backfill, nenhuma associacao automatica. Tabela nova nasce
-- vazia, e ausencia de linha significa "este agente nao tem Skill".

-- ── ROLLBACK ───────────────────────────────────────────────────────
--
--   drop table if exists public.agente_skills;
--   drop table if exists public.skills;
--
-- Nesta ordem: `agente_skills` e o lado REFERENCIANTE das duas FKs.
-- Invertida, o drop de `skills` falharia — que e a propria prova do
-- RESTRICT funcionando. `agentes` fica intacto.
