-- ────────────────────────────────────────────────────────────────────
-- Migration: central_ia_prompts ganha job_id
--
-- Contexto: usar só o status do job ('rodando' -> guarda de
-- idempotência) não é suficiente. Existe uma janela real: Gateway
-- executa -> prompt é gravado -> processo cai antes de gravar consumo
-- ou concluir o job -> job continua 'rodando' -> uma nova execução
-- pode gravar OUTRO prompt para o mesmo job. A idempotência precisa
-- existir também no banco, não só na aplicação.
--
-- job_id é NULLABLE (preserva registros antigos, que nunca tiveram
-- job associado, e permite usos futuros de central_ia_prompts sem
-- job — ex.: biblioteca de prompts reutilizáveis fora de um job
-- específico). ON DELETE SET NULL: remover o job não apaga o
-- histórico do prompt.
--
-- Índice único PARCIAL (WHERE job_id IS NOT NULL) — não um UNIQUE
-- simples na coluna — porque múltiplos registros antigos/futuros com
-- job_id NULL não podem colidir entre si (NULL <> NULL em índice
-- único), mas cada job real só pode ter 1 prompt.
--
-- AJUSTE (revisão pré-execução, 2026-08-06): a tarefa original também
-- exigia verificar central_ia_consumo. Inspeção por leitura confirmou
-- que a tabela já tem job_id (desde a migration de Fase 0), mas só com
-- índice normal (idx_consumo_job) — sem nenhuma restrição de
-- unicidade. Adicionado abaixo o mesmo padrão de índice único parcial
-- usado em central_ia_prompts, fechando a mesma janela de duplicidade
-- (2 gravações de consumo para o mesmo job) que motivou esta migration.
--
-- Nenhuma outra tabela além de central_ia_prompts/central_ia_consumo é
-- tocada. Nenhuma RPC é criada/alterada aqui (isso está na migration
-- irmã 20260806_estudio_anuncios_pipeline_rpcs_atomicas.sql).
-- ────────────────────────────────────────────────────────────────────

ALTER TABLE central_ia_prompts
  ADD COLUMN IF NOT EXISTS job_id UUID REFERENCES estudio_anuncios_jobs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_prompts_job
  ON central_ia_prompts (job_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_prompts_job_unico
  ON central_ia_prompts (job_id)
  WHERE job_id IS NOT NULL;

COMMENT ON COLUMN central_ia_prompts.job_id IS
  'Job (estudio_anuncios_jobs.id) que gerou este prompt, quando aplicável. Nullable para preservar registros antigos e usos futuros sem job associado. ON DELETE SET NULL: remover o job não apaga o histórico do prompt. Índice único parcial (idx_prompts_job_unico) garante no máximo 1 prompt por job — idempotência real no banco, não só na aplicação.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_central_ia_consumo_job_unico
  ON public.central_ia_consumo (job_id)
  WHERE job_id IS NOT NULL;

COMMENT ON INDEX public.idx_central_ia_consumo_job_unico IS
  'Garante no máximo 1 registro de consumo por job — mesma motivação de idx_prompts_job_unico (fecha a janela de duplicidade entre gravar o registro e concluir/avançar o job). central_ia_consumo.job_id já existia desde a Fase 0 (nullable, FK ON DELETE SET NULL); só faltava a restrição de unicidade.';
