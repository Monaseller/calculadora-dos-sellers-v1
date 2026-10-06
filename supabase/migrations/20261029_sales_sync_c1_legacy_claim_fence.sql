-- =====================================================================
-- CDS-STABILIZATION SALES-SYNC-C1 — FENCE DO CLAIM LEGADO
--
-- NAO APLICADA neste gate (o proximo gate faz preflight → autorizacao →
-- apply → teste real do fence).
--
-- O QUE MUDA: somente o WHERE da selecao em public.claim_next_sync_job().
-- Antes ela pegava QUALQUER job `pendente` — inclusive os jobs CANONICOS
-- do worker novo (campo_tempo date_closed / create_time, catch-up de
-- escrow com checkpoint.modo) — e o worker legado (scripts/sync-worker.mjs)
-- os mandaria para /api/internal/sync/executar, um executor incompativel.
--
-- ALLOWLIST POSITIVA DE JOB LEGADO:
--     campo_tempo IS NULL AND checkpoint IS NULL
-- (forma de todo job criado por POST /api/sync/iniciar; os 7 jobs
-- legados reais conferidos no SALES-SYNC-B2 satisfazem). Regra POSITIVA
-- de proposito: um tipo canonico FUTURO, ou qualquer linha que nao seja
-- reconhecidamente legada, NUNCA e reivindicado pelo caminho legado.
--
-- PRESERVADO (conferido contra pg_get_functiondef no banco real em
-- 2026-10-06, md5 be873471…): assinatura sem argumentos, RETURNS
-- sync_jobs, LANGUAGE plpgsql, VOLATILE, SECURITY INVOKER, sem
-- search_path/config, FOR UPDATE SKIP LOCKED, ORDER BY criado_em ASC,
-- LIMIT 1, o mesmo UPDATE (rodando / iniciado_em / heartbeat_em) e o
-- mesmo RETURN. CREATE OR REPLACE mantem dono e privilegios de execucao
-- existentes (postgres, service_role) — este arquivo nao mexe neles.
-- idx_sync_jobs_loja_ativo continua intocado (um job ativo por loja,
-- legado e canonico juntos).
--
-- ROLLBACK EXATO (reaplicar a versao anterior):
--     BEGIN;
--     SET LOCAL lock_timeout = '5s';
--     CREATE OR REPLACE FUNCTION public.claim_next_sync_job() ... com
--       WHERE status = 'pendente'   -- (sem as duas condicoes novas)
--     COMMIT;
-- =====================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.claim_next_sync_job()
RETURNS sync_jobs
LANGUAGE plpgsql
AS $$
DECLARE
  v_job sync_jobs;
BEGIN
  SELECT * INTO v_job
  FROM sync_jobs
  WHERE status = 'pendente'
    AND campo_tempo IS NULL
    AND checkpoint IS NULL
  ORDER BY criado_em ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  UPDATE sync_jobs
  SET status       = 'rodando',
      iniciado_em  = now(),
      heartbeat_em = now()
  WHERE id = v_job.id
  RETURNING * INTO v_job;

  RETURN v_job;
END;
$$;

COMMENT ON FUNCTION public.claim_next_sync_job() IS
  'Aquisição atômica do próximo job LEGADO pendente (campo_tempo IS NULL AND checkpoint IS NULL; FOR UPDATE SKIP LOCKED). Jobs canônicos nunca são reivindicados aqui — são do worker canônico (/api/internal/vendas-sync/worker). Retorna uma única linha (sync_jobs) ou NULL. Chamada exclusivamente pelo worker legado (scripts/sync-worker.mjs) via service role key.';

COMMIT;
