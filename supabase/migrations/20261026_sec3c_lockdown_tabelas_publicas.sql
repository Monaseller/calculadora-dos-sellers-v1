-- =====================================================================
-- SEC-3-C — LOCKDOWN DAS 15 TABELAS PUBLICAS (pedidos, anuncios,
-- sync_jobs, vendas_dia, dashboard_resumos_diarios, estudio_anuncios_*)
-- =====================================================================
--
-- 1. O QUE ESTAVA EXPOSTO
-- ---------------------------------------------------------------------
-- As 15 tabelas abaixo estavam SEM RLS, sem policy e com
-- `anon=arw` (SELECT, INSERT, UPDATE) — herdado do default privilege do
-- projeto. A chave `anon` nao e segredo (NEXT_PUBLIC_*, vai no bundle do
-- browser), entao qualquer pessoa podia ler pedidos, anuncios e projetos
-- de TODOS os tenants, e inserir/alterar linhas.
--
-- 2. POR QUE O CODIGO VEIO ANTES
-- ---------------------------------------------------------------------
-- SEC-3-B1 (1d05e58) moveu os 31 acessos server-side para service_role,
-- com o isolamento por dono provado na propria rota. SEC-3-B2 (a3f17aa)
-- tirou o browser das tabelas (/api/anuncios/**). Hotfix 1a447da.
-- Publicado em Production (dpl_2P8x8zUv8wXiHDtjR5qDq5vh4KtR) ANTES deste
-- arquivo; guards SERVER_ANON_SEC3 = 0 e BROWSER_DIRECT_SEC3 = 0.
--
-- 3. ESTADO REAL ANTES (precheck read-only, 2026-10-05)
-- ---------------------------------------------------------------------
-- Para CADA uma das 15, identico:
--     relacl = {postgres=arwdDxtm/postgres,anon=arw/postgres,
--               service_role=arwdDxtm/postgres}
--     RLS = off, FORCE = off, policies = 0, dono = postgres
--     authenticated: nenhum privilegio; PUBLIC: nenhum privilegio
--     ACL de coluna: nenhuma
-- service_role: privilegios completos e BYPASSRLS = true.
-- Dependencias: nenhuma view/matview, nenhum trigger, nenhuma
-- publication; as 25 funcoes de public que citam estas tabelas sao
-- SECURITY INVOKER e sem EXECUTE para anon/authenticated (nenhum caminho
-- que contorne o lockdown). FKs de outras tabelas apontam para algumas
-- delas — checagem de FK roda como dono e nao e afetada por RLS.
--
-- 4. O QUE ESTA MIGRATION FAZ
-- ---------------------------------------------------------------------
--   a) REVOKE ALL de `anon` e `authenticated` nas 15 (para
--      `authenticated` e no-op hoje; fica explicito para nunca reabrir);
--   b) ENABLE ROW LEVEL SECURITY nas 15, SEM nenhuma policy: qualquer
--      role sem BYPASSRLS nao ve nem grava linha, mesmo que um GRANT
--      volte por engano (defesa em profundidade).
-- Nao usa FORCE: o dono (postgres) e a service_role (BYPASSRLS) seguem
-- operando — e por elas que o servidor acessa estas tabelas.
-- PUBLIC nao tinha privilegio nenhum: nenhum SQL para PUBLIC.
-- Default privileges NAO sao alterados aqui (frente propria; o guard
-- testar-default-privileges segue protegendo tabelas futuras).
--
-- 5. TRANSACAO / IDEMPOTENCIA
-- ---------------------------------------------------------------------
-- Tudo dentro de BEGIN/COMMIT: ou as 15 ficam fechadas, ou nada muda.
-- REVOKE de privilegio ausente e ENABLE RLS ja ligado sao no-op, entao
-- reaplicar e seguro.
--
-- 6. ROLLBACK (MANUAL — NAO EXECUTADO AQUI)
-- ---------------------------------------------------------------------
-- Restaura EXATAMENTE o estado do precheck (secao 3) — reabre a
-- exposicao, exige autorizacao propria:
--
--     BEGIN;
--     GRANT SELECT, INSERT, UPDATE ON TABLE
--       public.pedidos, public.anuncios, public.sync_jobs,
--       public.vendas_dia, public.dashboard_resumos_diarios,
--       public.estudio_anuncios_conteudo_versoes,
--       public.estudio_anuncios_imagens_origem,
--       public.estudio_anuncios_jobs,
--       public.estudio_anuncios_pipeline,
--       public.estudio_anuncios_pipeline_catalogo,
--       public.estudio_anuncios_pipeline_catalogo_jobs,
--       public.estudio_anuncios_projetos,
--       public.estudio_anuncios_projetos_marketplace,
--       public.estudio_anuncios_resultados_pipeline,
--       public.estudio_anuncios_validacoes_publicacao
--     TO anon;
--     ALTER TABLE public.pedidos DISABLE ROW LEVEL SECURITY;
--     ALTER TABLE public.anuncios DISABLE ROW LEVEL SECURITY;
--     ALTER TABLE public.sync_jobs DISABLE ROW LEVEL SECURITY;
--     ALTER TABLE public.vendas_dia DISABLE ROW LEVEL SECURITY;
--     ALTER TABLE public.dashboard_resumos_diarios DISABLE ROW LEVEL SECURITY;
--     ALTER TABLE public.estudio_anuncios_conteudo_versoes DISABLE ROW LEVEL SECURITY;
--     ALTER TABLE public.estudio_anuncios_imagens_origem DISABLE ROW LEVEL SECURITY;
--     ALTER TABLE public.estudio_anuncios_jobs DISABLE ROW LEVEL SECURITY;
--     ALTER TABLE public.estudio_anuncios_pipeline DISABLE ROW LEVEL SECURITY;
--     ALTER TABLE public.estudio_anuncios_pipeline_catalogo DISABLE ROW LEVEL SECURITY;
--     ALTER TABLE public.estudio_anuncios_pipeline_catalogo_jobs DISABLE ROW LEVEL SECURITY;
--     ALTER TABLE public.estudio_anuncios_projetos DISABLE ROW LEVEL SECURITY;
--     ALTER TABLE public.estudio_anuncios_projetos_marketplace DISABLE ROW LEVEL SECURITY;
--     ALTER TABLE public.estudio_anuncios_resultados_pipeline DISABLE ROW LEVEL SECURITY;
--     ALTER TABLE public.estudio_anuncios_validacoes_publicacao DISABLE ROW LEVEL SECURITY;
--     COMMIT;
--
-- Isto e comentario, nao comando.
-- =====================================================================

BEGIN;

REVOKE ALL PRIVILEGES ON TABLE
  public.pedidos,
  public.anuncios,
  public.sync_jobs,
  public.vendas_dia,
  public.dashboard_resumos_diarios,
  public.estudio_anuncios_conteudo_versoes,
  public.estudio_anuncios_imagens_origem,
  public.estudio_anuncios_jobs,
  public.estudio_anuncios_pipeline,
  public.estudio_anuncios_pipeline_catalogo,
  public.estudio_anuncios_pipeline_catalogo_jobs,
  public.estudio_anuncios_projetos,
  public.estudio_anuncios_projetos_marketplace,
  public.estudio_anuncios_resultados_pipeline,
  public.estudio_anuncios_validacoes_publicacao
FROM anon, authenticated;

ALTER TABLE public.pedidos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.anuncios ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendas_dia ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dashboard_resumos_diarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.estudio_anuncios_conteudo_versoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.estudio_anuncios_imagens_origem ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.estudio_anuncios_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.estudio_anuncios_pipeline ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.estudio_anuncios_pipeline_catalogo ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.estudio_anuncios_pipeline_catalogo_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.estudio_anuncios_projetos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.estudio_anuncios_projetos_marketplace ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.estudio_anuncios_resultados_pipeline ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.estudio_anuncios_validacoes_publicacao ENABLE ROW LEVEL SECURITY;

COMMIT;
