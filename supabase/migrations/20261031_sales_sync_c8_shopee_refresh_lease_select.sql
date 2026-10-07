-- =====================================================================
-- CDS-STABILIZATION SALES-SYNC-C8 — SELECT DO service_role NO LEASE SHOPEE
--
-- O DEFEITO, MEDIDO NO BANCO REAL (SALES-SYNC-C7, 2026-10-07 11:22Z):
-- adquirir_lease_refresh_credencial executada como service_role devolveu
--   SQLSTATE 42501  insufficient_privilege
-- e o worker canonico ficou (corretamente) fail-closed em
-- LEASE_INDISPONIVEL, sem nunca renovar o token.
--
-- POR QUE: as duas RPCs sao SECURITY INVOKER (rodam com o privilegio de
-- quem chama). `INSERT ... ON CONFLICT DO UPDATE ... WHERE alvo.expira_em
-- <= now() AND alvo.user_id = ...` e `UPDATE ... WHERE alvo.portador = ...`
-- LEEM colunas da tabela — isso exige SELECT. A 20261030 concedeu so
-- INSERT/UPDATE (copiando a 20261014 do lease do monitor, que teve o MESMO
-- defeito e foi corrigida pela 20261015). O teste de runtime do C5 rodou
-- como `postgres` (dono) e nao podia ver a falta.
--
-- EFEITO UNICO: SELECT para service_role. Nada mais muda: RLS ligada,
-- 0 policies, PUBLIC/anon/authenticated sem privilegio, sem DELETE,
-- TRUNCATE, REFERENCES ou TRIGGER, RPCs e tabela intocadas.
--
-- ROLLBACK EXATO:
--     BEGIN;
--     SET LOCAL lock_timeout = '5s';
--     REVOKE SELECT ON TABLE public.credencial_refresh_lease FROM service_role;
--     COMMIT;
-- (o worker voltaria a 42501 → fail-closed LEASE_INDISPONIVEL)
-- =====================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

GRANT SELECT ON TABLE public.credencial_refresh_lease TO service_role;

COMMIT;
