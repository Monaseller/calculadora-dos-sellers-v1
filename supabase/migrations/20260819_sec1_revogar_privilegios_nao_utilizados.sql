-- =====================================================================
-- SEC-1 — Reducao monotonica de privilegio no schema public
-- =====================================================================
--
-- 1. OBJETIVO — DUAS PARTES, UMA TRANSACAO
-- ---------------------------------------------------------------------
-- Remover de `anon` e `authenticated` os cinco privilegios que a
-- auditoria de 2026-08-19 provou NAO serem usados por nenhum caminho da
-- aplicacao:
--
--     DELETE, TRUNCATE, TRIGGER, REFERENCES, MAINTAIN
--
-- A migration cobre os dois tempos do problema:
--
--   PARTE A (SEC-1)  — as 33 tabelas que existem HOJE em public.
--   PARTE B (SEC-1B) — o default privilege de `postgres` em public, para
--                      que tabelas criadas no FUTURO nao recebam esses
--                      cinco privilegios de volta automaticamente.
--
-- As duas andam juntas de proposito: aplicar so a Parte A seria limpeza
-- com prazo de validade — a proxima `CREATE TABLE` reintroduziria o
-- defeito sem aviso. Uma migration, uma transacao, estado final coerente.
--
-- Motivo: as 33 tabelas de `public` concedem hoje os OITO privilegios
-- possiveis a `anon` e `authenticated` — comportamento padrao do
-- Supabase para toda tabela criada, nunca revogado por este projeto. A
-- chave `anon` e publica por construcao (vai no bundle do navegador),
-- entao esse conjunto e a superficie real exposta a qualquer visitante.
--
-- O PostgREST expoe por HTTP apenas SELECT/INSERT/UPDATE/DELETE. Logo, o
-- unico dos cinco alcancavel com a chave publica e o DELETE — e e ele
-- que esta migration fecha. TRUNCATE, TRIGGER, REFERENCES e MAINTAIN
-- exigiriam conexao Postgres direta; sao revogados junto por higiene de
-- menor privilegio, nao por urgencia.
--
-- Evidencia de que os cinco sao inertes para a aplicacao:
--   DELETE     — zero `.delete()` sobre tabela Supabase em app/ ou lib/;
--                a desconexao de loja e UPDATE, nao DELETE
--   TRUNCATE   — nenhuma ocorrencia em codigo, migrations ou funcoes
--   TRIGGER    — zero triggers nao-internos em public
--   REFERENCES — as FKs ja existem; o privilegio e exigido para CRIAR
--                uma FK, jamais para o Postgres aplica-la em runtime
--   MAINTAIN   — VACUUM/ANALYZE/REINDEX, sem uso pela aplicacao
--
--
-- 2. INVENTARIO CONGELADO — 33 TABELAS
-- ---------------------------------------------------------------------
-- A lista abaixo e EXPLICITA e FECHADA, deliberadamente. Nao ha SQL
-- dinamico varrendo `pg_class`.
--
-- Razao: a migration precisa representar exatamente o inventario que foi
-- revisado no design gate — 33 tabelas `relkind='r'`, conferidas duas
-- vezes sem drift. Uma varredura dinamica passaria a alterar tabelas
-- futuras em silencio, escondendo justamente a mudanca que precisa ser
-- revisada.
--
-- Tabela criada DEPOIS desta migration nao entra nesta lista — e nao
-- precisa: quem cuida dela e a Parte B, alterando o default privilege.
-- Ver item 5.
--
--
-- 3. PRIVILEGIOS PRESERVADOS — E POR QUE
-- ---------------------------------------------------------------------
-- SELECT, INSERT e UPDATE permanecem intactos para `anon` e
-- `authenticated`. Nao e descuido: 13 rotas de producao usam hoje a
-- chave anon para ler e escrever. Revoga-los aqui derrubaria a
-- aplicacao.
--
-- Fecha-los e escopo das PRs #2b/#2c (mover credencial para capability
-- server-only) e do programa de RLS — nunca desta migration.
--
-- Esta migration NAO toca:
--   - service_role      (inalterada por esta migration)
--   - postgres / owner  (inalterados por esta migration)
--   - funcoes / RPCs    (ja revogadas de anon/authenticated)
--   - RLS e policies
--   - default privileges
--
--
-- 4. RISCO RESIDUAL — ESTA MIGRATION NAO TORNA O BANCO SEGURO
-- ---------------------------------------------------------------------
-- Continuam abertos, intencionalmente:
--   - SELECT anonimo em 31 tabelas sem RLS, incluindo `pedidos`
--     (~415 mil linhas), `perfil` (senha em texto puro) e as colunas de
--     credencial de `lojas` (access_token, refresh_token, partner_key);
--   - INSERT anonimo em 33 tabelas, incluindo `sync_jobs`;
--   - UPDATE anonimo em 33 tabelas, o que permite contornar invariantes
--     que hoje so as RPCs protegem (append-only, registro imutavel,
--     catalogo de etapas como fonte unica de verdade);
--   - RLS ausente em 31 tabelas, bloqueada ate existir `tenant_atual()`
--     (o CDS nao usa Supabase Auth, entao nao ha `auth.uid()`).
--
-- Em uma frase: a SEC-1 impede que apaguem os dados; NAO impede que os
-- leiam nem que os alterem.
--
--
-- 5. PARTE B — DEFAULT PRIVILEGES (SEC-1B, incorporada)
-- ---------------------------------------------------------------------
-- Existem `ALTER DEFAULT PRIVILEGES` ativos em `public` para objetos do
-- tipo tabela, tanto do criador `postgres` quanto de `supabase_admin`,
-- concedendo os OITO privilegios a `anon` e `authenticated`.
--
-- Como as migrations deste projeto criam objetos como `postgres` (as 33
-- tabelas tem owner `postgres`), toda `CREATE TABLE` futura em `public`
-- RECONCEDERIA automaticamente os cinco privilegios revogados na Parte A.
-- A Parte B fecha isso.
--
-- `ALTER DEFAULT PRIVILEGES` afeta SOMENTE objetos criados no FUTURO —
-- nao altera nenhuma das 33 tabelas existentes. Quem faz isso e a Parte A.
--
-- Estado resultante para tabela NOVA criada por `postgres` em `public`:
--   anon           -> SELECT, INSERT, UPDATE
--   authenticated  -> SELECT, INSERT, UPDATE
--   service_role   -> inalterado por esta migration
--   postgres/owner -> inalterado por esta migration
--
-- `supabase_admin` NAO e tocado, por dois motivos comprovados:
--   1. default privileges sao especificos do role CRIADOR, e nossas
--      migrations criam como `postgres` — as 33 tabelas tem owner
--      `postgres`, e a sessao de migration roda como `postgres`;
--   2. `postgres` nao e membro de `supabase_admin` e nao e superusuario
--      (`rolsuper=false`), entao o comando sequer seria permitido.
-- Alterar aquele default tambem seria risco desnecessario de assumir,
-- por atingir objetos de componentes gerenciados do Supabase.
--
-- FORA DE ESCOPO desta migration, registrado como divida:
--   - SEC-1C: default `EXECUTE` de FUNCTIONS para anon/authenticated;
--   - defaults de SEQUENCES (`SELECT, UPDATE, USAGE` a anon), que
--     habilitam `setval()` e merecem gate proprio.
--
-- =====================================================================


-- ---------------------------------------------------------------------
-- CDS — nucleo financeiro e operacional (7 tabelas)
-- ---------------------------------------------------------------------
REVOKE DELETE, TRUNCATE, TRIGGER, REFERENCES, MAINTAIN ON TABLE
  public.anuncios,
  public.dashboard_resumos_diarios,
  public.lojas,
  public.pedidos,
  public.perfil,
  public.sync_jobs,
  public.vendas_dia
FROM anon, authenticated;


-- ---------------------------------------------------------------------
-- Central de IA (6 tabelas)
-- ---------------------------------------------------------------------
REVOKE DELETE, TRUNCATE, TRIGGER, REFERENCES, MAINTAIN ON TABLE
  public.central_ia_biblioteca_produtos,
  public.central_ia_biblioteca_produtos_versoes,
  public.central_ia_consumo,
  public.central_ia_creditos,
  public.central_ia_creditos_lancamentos,
  public.central_ia_prompts
FROM anon, authenticated;


-- ---------------------------------------------------------------------
-- Estudio de Anuncios (20 tabelas)
-- ---------------------------------------------------------------------
REVOKE DELETE, TRUNCATE, TRIGGER, REFERENCES, MAINTAIN ON TABLE
  public.estudio_anuncios_auditoria,
  public.estudio_anuncios_compliance_marketplace,
  public.estudio_anuncios_conteudo_versoes,
  public.estudio_anuncios_entradas_produto,
  public.estudio_anuncios_imagens_geradas,
  public.estudio_anuncios_imagens_origem,
  public.estudio_anuncios_jobs,
  public.estudio_anuncios_pacotes_exportacao,
  public.estudio_anuncios_pendencias,
  public.estudio_anuncios_pictures_marketplace,
  public.estudio_anuncios_pipeline,
  public.estudio_anuncios_pipeline_catalogo,
  public.estudio_anuncios_pipeline_catalogo_jobs,
  public.estudio_anuncios_projetos,
  public.estudio_anuncios_projetos_marketplace,
  public.estudio_anuncios_publicacoes,
  public.estudio_anuncios_resultados_pipeline,
  public.estudio_anuncios_score,
  public.estudio_anuncios_validacoes_publicacao,
  public.estudio_anuncios_videos_gerados
FROM anon, authenticated;


-- ---------------------------------------------------------------------
-- PARTE B — default privileges (tabelas FUTURAS criadas por postgres)
-- ---------------------------------------------------------------------
-- Nao toca nenhuma tabela existente. Nao toca service_role nem o owner.
-- Nao toca sequences nem functions. Nao toca `supabase_admin`.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE DELETE, TRUNCATE, TRIGGER, REFERENCES, MAINTAIN
  ON TABLES FROM anon, authenticated;


-- =====================================================================
-- ROLLBACK — simetria exata, documentada aqui de proposito
-- =====================================================================
--
-- Nao existe migration separada de rollback: manter o inverso ao lado do
-- forward evita que as duas listas divirjam com o tempo.
--
-- O rollback restaura EXATAMENTE os cinco privilegios removidos, para as
-- MESMAS duas roles, nas MESMAS 33 tabelas. Nunca `GRANT ALL` — isso
-- concederia tambem SELECT/INSERT/UPDATE de forma redundante e apagaria
-- a intencao de simetria.
--
-- Para reverter, executar:
--
-- GRANT DELETE, TRUNCATE, TRIGGER, REFERENCES, MAINTAIN ON TABLE
--   public.anuncios,
--   public.dashboard_resumos_diarios,
--   public.lojas,
--   public.pedidos,
--   public.perfil,
--   public.sync_jobs,
--   public.vendas_dia
-- TO anon, authenticated;
--
-- GRANT DELETE, TRUNCATE, TRIGGER, REFERENCES, MAINTAIN ON TABLE
--   public.central_ia_biblioteca_produtos,
--   public.central_ia_biblioteca_produtos_versoes,
--   public.central_ia_consumo,
--   public.central_ia_creditos,
--   public.central_ia_creditos_lancamentos,
--   public.central_ia_prompts
-- TO anon, authenticated;
--
-- GRANT DELETE, TRUNCATE, TRIGGER, REFERENCES, MAINTAIN ON TABLE
--   public.estudio_anuncios_auditoria,
--   public.estudio_anuncios_compliance_marketplace,
--   public.estudio_anuncios_conteudo_versoes,
--   public.estudio_anuncios_entradas_produto,
--   public.estudio_anuncios_imagens_geradas,
--   public.estudio_anuncios_imagens_origem,
--   public.estudio_anuncios_jobs,
--   public.estudio_anuncios_pacotes_exportacao,
--   public.estudio_anuncios_pendencias,
--   public.estudio_anuncios_pictures_marketplace,
--   public.estudio_anuncios_pipeline,
--   public.estudio_anuncios_pipeline_catalogo,
--   public.estudio_anuncios_pipeline_catalogo_jobs,
--   public.estudio_anuncios_projetos,
--   public.estudio_anuncios_projetos_marketplace,
--   public.estudio_anuncios_publicacoes,
--   public.estudio_anuncios_resultados_pipeline,
--   public.estudio_anuncios_score,
--   public.estudio_anuncios_validacoes_publicacao,
--   public.estudio_anuncios_videos_gerados
-- TO anon, authenticated;
--
-- -- Parte B (default privileges) — reverter na ordem inversa:
-- ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
--   GRANT DELETE, TRUNCATE, TRIGGER, REFERENCES, MAINTAIN
--   ON TABLES TO anon, authenticated;
--
-- =====================================================================
-- VERIFICACAO POS-EXECUCAO (nao destrutiva)
-- =====================================================================
--
-- Rodar ANTES e DEPOIS e comparar. Esperado: 33 x 2 celulas passando de
-- `true` para `false` nos cinco privilegios revogados, SELECT/INSERT/
-- UPDATE inalterados, e service_role sem uma unica mudanca.
--
-- SELECT c.relname::text AS tabela, r.rolname::text AS papel,
--        has_table_privilege(r.rolname, c.oid, 'SELECT')     AS sel,
--        has_table_privilege(r.rolname, c.oid, 'INSERT')     AS ins,
--        has_table_privilege(r.rolname, c.oid, 'UPDATE')     AS upd,
--        has_table_privilege(r.rolname, c.oid, 'DELETE')     AS del,
--        has_table_privilege(r.rolname, c.oid, 'TRUNCATE')   AS trunc,
--        has_table_privilege(r.rolname, c.oid, 'TRIGGER')    AS trg,
--        has_table_privilege(r.rolname, c.oid, 'REFERENCES') AS refs,
--        has_table_privilege(r.rolname, c.oid, 'MAINTAIN')   AS maint
-- FROM pg_class c
-- JOIN pg_namespace n ON n.oid = c.relnamespace
-- CROSS JOIN pg_roles r
-- WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
--   AND r.rolname IN ('anon','authenticated','service_role','postgres')
-- ORDER BY 1, 2;
-- =====================================================================
