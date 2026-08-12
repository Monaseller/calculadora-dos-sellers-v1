-- ────────────────────────────────────────────────────────────────────
-- Migration: RPCs atômicas de conclusão/falha do Pipeline
--
-- Contexto: as RPCs estudio_anuncios_pipeline_avancar() e
-- estudio_anuncios_pipeline_registrar_falha() (já instaladas, já
-- validadas ponta a ponta) exigem que o job já esteja
-- concluido/erro ANTES de serem chamadas. Isso deixa "marcar o job" e
-- "avançar o pipeline" como duas operações distintas — se o processo
-- cair entre elas, o job fica marcado mas o pipeline não avança
-- (estado inconsistente, recuperável só via reconciliação manual).
--
-- Esta migration cria 2 novas RPCs que fazem as duas operações numa
-- ÚNICA transação, sem duplicar a lógica de progressão: elas fazem
-- todas as validações + o UPDATE do job, e então CHAMAM as RPCs já
-- existentes (estudio_anuncios_pipeline_avancar/_registrar_falha)
-- internamente — reaproveitando 100% do que já foi testado, sem
-- reescrever a decisão de "qual é a próxima etapa".
--
-- estudio_anuncios_pipeline_avancar() e
-- estudio_anuncios_pipeline_registrar_falha() permanecem INTOCADAS
-- (nenhum CREATE OR REPLACE nelas nesta migration) — continuam
-- podendo ser chamadas isoladamente se algum dia fizer sentido (ex.:
-- reconciliação via retomarPipeline(), que já as usa hoje).
--
-- Validações explícitas ANTES de qualquer mudança de estado (pedido
-- explícito — não confiar só na RPC interna para detectar
-- inconsistência depois do 1º UPDATE, mesmo que o rollback funcione):
--   1. p_pipeline_id não nulo
--   2. p_job_id não nulo
--   3. pipeline existe (FOR UPDATE)
--   4. job existe (FOR UPDATE)
--   5. job.projeto_id = pipeline.projeto_id
--   6. job.id = pipeline.job_atual_id
--   7. pipeline.status = 'em_execucao'
--   8. job.status = 'rodando'
-- ────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.estudio_anuncios_pipeline_concluir_job(
  p_pipeline_id UUID,
  p_job_id      UUID
)
RETURNS public.estudio_anuncios_pipeline
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_pipeline public.estudio_anuncios_pipeline;
  v_job      public.estudio_anuncios_jobs;
BEGIN
  IF p_pipeline_id IS NULL THEN
    RAISE EXCEPTION 'p_pipeline_id não pode ser nulo';
  END IF;
  IF p_job_id IS NULL THEN
    RAISE EXCEPTION 'p_job_id não pode ser nulo';
  END IF;

  -- Lock da linha do pipeline — impede duas tentativas concorrentes de
  -- finalizar o mesmo job.
  SELECT * INTO v_pipeline FROM public.estudio_anuncios_pipeline WHERE id = p_pipeline_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pipeline % não encontrado', p_pipeline_id;
  END IF;

  -- Lock da linha do job — mesmo motivo.
  SELECT * INTO v_job FROM public.estudio_anuncios_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'job % não encontrado', p_job_id;
  END IF;

  IF v_job.projeto_id <> v_pipeline.projeto_id THEN
    RAISE EXCEPTION 'JOB_PROJETO_DIVERGENTE: job % pertence ao projeto %, mas o pipeline % pertence ao projeto %',
      p_job_id, v_job.projeto_id, p_pipeline_id, v_pipeline.projeto_id;
  END IF;

  IF v_pipeline.job_atual_id IS DISTINCT FROM p_job_id THEN
    RAISE EXCEPTION 'USO_INVALIDO_PIPELINE: job informado não corresponde ao job atual do pipeline (pipeline=%, job_atual_id=%, job_informado=%)',
      p_pipeline_id, v_pipeline.job_atual_id, p_job_id;
  END IF;

  IF v_pipeline.status <> 'em_execucao' THEN
    RAISE EXCEPTION 'PIPELINE_NAO_ESTA_EM_EXECUCAO: status atual é "%" (pipeline=%)', v_pipeline.status, p_pipeline_id;
  END IF;

  IF v_job.status <> 'rodando' THEN
    RAISE EXCEPTION 'JOB_NAO_ESTA_RODANDO: job % não está com status rodando (status atual: %)', p_job_id, v_job.status;
  END IF;

  UPDATE public.estudio_anuncios_jobs
  SET status = 'concluido',
      concluido_em = now(),
      erro_tipo = NULL,
      erro_mensagem = NULL
  WHERE id = p_job_id;

  -- Reaproveita 100% da lógica de avanço já validada — mesma transação.
  RETURN public.estudio_anuncios_pipeline_avancar(p_pipeline_id, p_job_id);
END;
$$;

COMMENT ON FUNCTION public.estudio_anuncios_pipeline_concluir_job(UUID, UUID) IS
  'Conclui o job atual (rodando -> concluido) e avança o Pipeline numa única transação. Valida explicitamente (nulos, existência, projeto correspondente, job_atual_id, status do pipeline, status do job) ANTES de mudar qualquer estado, com FOR UPDATE em pipeline e job. Chama estudio_anuncios_pipeline_avancar() internamente, reaproveitando 100% da lógica já validada. Restrita a service_role.';

REVOKE EXECUTE ON FUNCTION public.estudio_anuncios_pipeline_concluir_job(UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.estudio_anuncios_pipeline_concluir_job(UUID, UUID)
  TO service_role;


CREATE OR REPLACE FUNCTION public.estudio_anuncios_pipeline_falhar_job(
  p_pipeline_id   UUID,
  p_job_id        UUID,
  p_erro_tipo     TEXT,
  p_erro_mensagem TEXT
)
RETURNS public.estudio_anuncios_pipeline
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_pipeline public.estudio_anuncios_pipeline;
  v_job      public.estudio_anuncios_jobs;
BEGIN
  IF p_pipeline_id IS NULL THEN
    RAISE EXCEPTION 'p_pipeline_id não pode ser nulo';
  END IF;
  IF p_job_id IS NULL THEN
    RAISE EXCEPTION 'p_job_id não pode ser nulo';
  END IF;

  SELECT * INTO v_pipeline FROM public.estudio_anuncios_pipeline WHERE id = p_pipeline_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pipeline % não encontrado', p_pipeline_id;
  END IF;

  SELECT * INTO v_job FROM public.estudio_anuncios_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'job % não encontrado', p_job_id;
  END IF;

  IF v_job.projeto_id <> v_pipeline.projeto_id THEN
    RAISE EXCEPTION 'JOB_PROJETO_DIVERGENTE: job % pertence ao projeto %, mas o pipeline % pertence ao projeto %',
      p_job_id, v_job.projeto_id, p_pipeline_id, v_pipeline.projeto_id;
  END IF;

  IF v_pipeline.job_atual_id IS DISTINCT FROM p_job_id THEN
    RAISE EXCEPTION 'USO_INVALIDO_PIPELINE: job informado não corresponde ao job atual do pipeline (pipeline=%, job_atual_id=%, job_informado=%)',
      p_pipeline_id, v_pipeline.job_atual_id, p_job_id;
  END IF;

  IF v_pipeline.status <> 'em_execucao' THEN
    RAISE EXCEPTION 'PIPELINE_NAO_ESTA_EM_EXECUCAO: status atual é "%" (pipeline=%)', v_pipeline.status, p_pipeline_id;
  END IF;

  IF v_job.status <> 'rodando' THEN
    RAISE EXCEPTION 'JOB_NAO_ESTA_RODANDO: job % não está com status rodando (status atual: %)', p_job_id, v_job.status;
  END IF;

  UPDATE public.estudio_anuncios_jobs
  SET status = 'erro',
      erro_tipo = p_erro_tipo,
      erro_mensagem = left(p_erro_mensagem, 300)
  WHERE id = p_job_id;

  -- Reaproveita 100% da lógica de retry/erro já validada (a RPC decide
  -- sozinha se devolve o job para 'pendente' ou marca o pipeline em
  -- 'erro') — mesma transação.
  RETURN public.estudio_anuncios_pipeline_registrar_falha(p_pipeline_id, p_job_id, p_erro_tipo, p_erro_mensagem);
END;
$$;

COMMENT ON FUNCTION public.estudio_anuncios_pipeline_falhar_job(UUID, UUID, TEXT, TEXT) IS
  'Marca o job atual em erro (rodando -> erro) e registra a falha no Pipeline numa única transação. Mesmas validações explícitas de estudio_anuncios_pipeline_concluir_job() antes de mudar qualquer estado. A RPC interna pode devolver o job para pendente (retry) ou marcar o pipeline em erro (tentativas esgotadas) — decisão já validada, reaproveitada sem duplicação. Restrita a service_role.';

REVOKE EXECUTE ON FUNCTION public.estudio_anuncios_pipeline_falhar_job(UUID, UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.estudio_anuncios_pipeline_falhar_job(UUID, UUID, TEXT, TEXT)
  TO service_role;
