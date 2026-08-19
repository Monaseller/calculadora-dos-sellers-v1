-- =====================================================================
-- SEC-2a — Remocao dos privilegios da role `authenticated` em public
-- =====================================================================
--
-- 1. OBJETIVO
-- ---------------------------------------------------------------------
-- Remover de `authenticated` os tres privilegios que restaram apos a
-- SEC-1:
--
--     SELECT, INSERT, UPDATE
--
-- nas mesmas 33 tabelas, e corrigir o default privilege de `postgres`
-- para que tabelas futuras nao os concedam de volta a essa role.
--
--
-- 2. POR QUE ISTO E SEGURO — A ROLE E ORFA
-- ---------------------------------------------------------------------
-- `authenticated` e a role que o Supabase atribui a uma sessao
-- autenticada pelo Supabase Auth. O CDS NAO USA Supabase Auth:
--
--   - busca por `supabase.auth`, `auth.getUser`, `auth.signIn` e
--     `@supabase/auth` no repositorio inteiro retorna ZERO ocorrencias;
--   - a autenticacao e propria — tabela `perfil` + cookie assinado
--     `cds_session` (`lib/autenticacao.ts` / `lib/sessao-assinada.ts`),
--     usada por 40 arquivos de producao;
--   - nenhum JWT emitido por este projeto carrega `role: authenticated`;
--     a chave publica do projeto resolve para `anon`.
--
-- Logo, NENHUMA requisicao real assume `authenticated` hoje. Revoga-la e
-- reducao de superficie a custo zero: nao existe consumidor para quebrar.
--
-- A auditoria de dependencias (2026-08-19) mapeou 13 rotas e 5
-- componentes de browser usando a chave publica — TODOS pela role `anon`,
-- nenhum por `authenticated`.
--
--
-- 3. O QUE ESTA MIGRATION NAO TOCA
-- ---------------------------------------------------------------------
--   - `anon`          — mantem SELECT, INSERT, UPDATE. E a role que a
--                       aplicacao realmente usa hoje; fecha-la e escopo
--                       das PRs #2b/#2c/#2d, nunca desta.
--   - `service_role`  — inalterada por esta migration
--   - `postgres`/owner— inalterados por esta migration
--   - sequences, functions/RPCs, RLS e policies — nao tocadas
--
-- Lista de tabelas EXPLICITA e fechada, mesmo inventario congelado da
-- SEC-1 (33 tabelas, `relkind='r'`). Sem SQL dinamico: a migration
-- representa exatamente o estado revisado no gate.
--
--
-- 4. EFEITO COMBINADO COM A SEC-1
-- ---------------------------------------------------------------------
-- A SEC-1 ja havia removido de `authenticated` os cinco privilegios
-- DELETE/TRUNCATE/TRIGGER/REFERENCES/MAINTAIN. Com esta migration, a
-- role fica SEM NENHUM privilegio de tabela em `public`.
--
-- Se algum privilegio ainda aparecer para `authenticated` depois desta
-- migration, isso indica um caminho de concessao que nao conheciamos
-- (grant direto novo, ou membership). O procedimento e REPORTAR, nunca
-- "limpar" automaticamente.
--
--
-- 5. RISCO RESIDUAL
-- ---------------------------------------------------------------------
-- Esta migration NAO reduz a superficie realmente explorada hoje: a
-- chave publica do projeto autentica como `anon`, e `anon` continua com
-- SELECT/INSERT/UPDATE nas 33 tabelas. Leitura e alteracao anonima de
-- `pedidos`, `perfil` e das colunas de credencial de `lojas` seguem
-- possiveis.
--
-- O ganho e de defesa em profundidade: elimina uma role inteira como
-- vetor futuro — inclusive no cenario em que o projeto venha a adotar
-- Supabase Auth sem revisar privilegios, que e exatamente como o
-- problema original nasceu.
--
-- PROXIMA ETAPA (nao feita aqui): PR #2b — fechar os quatro bypasses de
-- credencial que ainda usam `anon` (auth/mercadolivre/callback,
-- auth/shopee/callback, lojas/desconectar, lojas/ativar) ANTES de
-- reduzir privilegios de `anon` em `lojas`.
--
-- =====================================================================


-- ---------------------------------------------------------------------
-- PARTE A — 33 tabelas existentes
-- ---------------------------------------------------------------------

-- CDS — nucleo financeiro e operacional (7)
REVOKE SELECT, INSERT, UPDATE ON TABLE
  public.anuncios,
  public.dashboard_resumos_diarios,
  public.lojas,
  public.pedidos,
  public.perfil,
  public.sync_jobs,
  public.vendas_dia
FROM authenticated;

-- Central de IA (6)
REVOKE SELECT, INSERT, UPDATE ON TABLE
  public.central_ia_biblioteca_produtos,
  public.central_ia_biblioteca_produtos_versoes,
  public.central_ia_consumo,
  public.central_ia_creditos,
  public.central_ia_creditos_lancamentos,
  public.central_ia_prompts
FROM authenticated;

-- Estudio de Anuncios (20)
REVOKE SELECT, INSERT, UPDATE ON TABLE
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
FROM authenticated;


-- ---------------------------------------------------------------------
-- PARTE B — default privileges (tabelas FUTURAS criadas por postgres)
-- ---------------------------------------------------------------------
-- Nao toca nenhuma tabela existente. Nao toca anon, service_role nem o
-- owner. Nao toca sequences nem functions. Nao toca `supabase_admin`
-- (default privileges sao especificos do role criador, e `postgres` nao
-- e membro dele nem superusuario).
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE SELECT, INSERT, UPDATE
  ON TABLES FROM authenticated;


-- =====================================================================
-- ROLLBACK — documentado, NAO executavel automaticamente
-- =====================================================================
--
-- Restaura EXATAMENTE os tres privilegios removidos, para a MESMA role,
-- nas MESMAS 33 tabelas. Nunca `GRANT ALL` — isso devolveria tambem os
-- cinco que a SEC-1 revogou, desfazendo silenciosamente o gate anterior.
--
-- GRANT SELECT, INSERT, UPDATE ON TABLE
--   public.anuncios,
--   public.dashboard_resumos_diarios,
--   public.lojas,
--   public.pedidos,
--   public.perfil,
--   public.sync_jobs,
--   public.vendas_dia
-- TO authenticated;
--
-- GRANT SELECT, INSERT, UPDATE ON TABLE
--   public.central_ia_biblioteca_produtos,
--   public.central_ia_biblioteca_produtos_versoes,
--   public.central_ia_consumo,
--   public.central_ia_creditos,
--   public.central_ia_creditos_lancamentos,
--   public.central_ia_prompts
-- TO authenticated;
--
-- GRANT SELECT, INSERT, UPDATE ON TABLE
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
-- TO authenticated;
--
-- -- Parte B (default privileges) — reverter na ordem inversa:
-- ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
--   GRANT SELECT, INSERT, UPDATE
--   ON TABLES TO authenticated;
--
-- =====================================================================
-- VERIFICACAO POS-EXECUCAO (nao destrutiva)
-- =====================================================================
--
-- Esperado: `authenticated` sem NENHUM privilegio nas 33; `anon` com
-- exatamente SELECT/INSERT/UPDATE; `service_role` e `postgres` iguais ao
-- baseline. Nenhuma mutacao de dado e necessaria para provar isso.
--
-- SELECT c.relname::text AS tabela, r.rolname::text AS papel,
--        has_table_privilege(r.rolname, c.oid, 'SELECT') AS sel,
--        has_table_privilege(r.rolname, c.oid, 'INSERT') AS ins,
--        has_table_privilege(r.rolname, c.oid, 'UPDATE') AS upd
-- FROM pg_class c
-- JOIN pg_namespace n ON n.oid = c.relnamespace
-- CROSS JOIN pg_roles r
-- WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
--   AND r.rolname IN ('anon','authenticated','service_role','postgres')
-- ORDER BY 1, 2;
-- =====================================================================
