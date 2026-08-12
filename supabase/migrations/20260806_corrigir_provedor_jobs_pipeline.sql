-- ────────────────────────────────────────────────────────────────────
-- Migration: correção do ciclo de vida de estudio_anuncios_jobs.provedor
--
-- Contexto (bug encontrado na integração funcional do Worker, 2026-08-06):
-- chk_jobs_provedor_definido exigia `status = 'pendente' OR provedor IS
-- NOT NULL`, ou seja, qualquer status diferente de 'pendente' (inclusive
-- 'rodando' e 'erro') já exigia provedor definido. Isso quebra o fluxo
-- real: claim_next_estudio_anuncios_job() reivindica o job (pendente ->
-- rodando) SEM conhecer o provedor ainda (só é conhecido depois da
-- chamada ao Gateway) — o primeiro UPDATE de claim já violava a
-- constraint. Mesmo corrigindo só isso, estudio_anuncios_pipeline_
-- concluir_job() marcaria o job 'concluido' sem nunca ter setado
-- provedor, violando a constraint de novo no passo seguinte.
--
-- Regra correta (decisão aprovada no chat): provedor só é exigido
-- quando o job efetivamente CONCLUI. pendente/rodando/erro podem ter
-- provedor NULL — em 'erro', o provedor pode já ser conhecido (falha
-- depois do Gateway responder) ou nunca ter chegado a ser contactado
-- (falha de validação antes do Gateway), então continua opcional ali.
--
-- Esta migration:
--   1. corrige chk_jobs_provedor_definido;
--   2. substitui estudio_anuncios_pipeline_concluir_job(UUID, UUID) por
--      uma versão (UUID, UUID, TEXT) que exige e grava p_provedor;
--   3. substitui estudio_anuncios_pipeline_falhar_job(UUID, UUID, TEXT,
--      TEXT) por uma versão (..., TEXT) que aceita p_provedor opcional,
--      nunca apagando um provedor já conhecido (COALESCE).
--
-- claim_next_estudio_anuncios_job() NÃO é alterada nesta migration —
-- com a nova constraint, o UPDATE que ela já faz (pendente -> rodando,
-- sem tocar provedor) passa a ser válido sem nenhuma mudança de código.
--
-- estudio_anuncios_pipeline_avancar() e
-- estudio_anuncios_pipeline_registrar_falha() permanecem INTOCADAS —
-- continuam sendo chamadas internamente pelas duas RPCs substituídas
-- abaixo, exatamente como antes.
--
-- Lista de provedores válidos usada nas duas RPCs abaixo é a mesma já
-- aplicada como CHECK de coluna em estudio_anuncios_jobs.provedor (ver
-- 20260803_central_ia_estudio_anuncios_schema.sql linha 387) e o mesmo
-- union type ProvedorIA de lib/ai-gateway/tipos.ts — validação
-- redundante e intencional (mensagem de erro clara antes de depender só
-- do CHECK de coluna), mesmo padrão já usado nas demais RPCs desta
-- migration/tarefa.
-- ────────────────────────────────────────────────────────────────────

ALTER TABLE public.estudio_anuncios_jobs
  DROP CONSTRAINT chk_jobs_provedor_definido;

ALTER TABLE public.estudio_anuncios_jobs
  ADD CONSTRAINT chk_jobs_provedor_definido
  CHECK (status <> 'concluido' OR provedor IS NOT NULL);

COMMENT ON CONSTRAINT chk_jobs_provedor_definido ON public.estudio_anuncios_jobs IS
  'provedor só é obrigatório quando status=concluido. pendente/rodando/erro podem ter provedor NULL (é conhecido apenas depois de uma chamada bem-sucedida ao Gateway).';


-- ────────────────────────────────────────────────────────────────────
-- estudio_anuncios_pipeline_concluir_job — nova assinatura (UUID, UUID, TEXT)
-- ────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.estudio_anuncios_pipeline_concluir_job(UUID, UUID);

CREATE OR REPLACE FUNCTION public.estudio_anuncios_pipeline_concluir_job(
  p_pipeline_id UUID,
  p_job_id      UUID,
  p_provedor    TEXT
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
  IF p_provedor IS NULL OR btrim(p_provedor) = '' THEN
    RAISE EXCEPTION 'PROVEDOR_OBRIGATORIO: p_provedor não pode ser nulo/vazio ao concluir um job';
  END IF;
  IF p_provedor NOT IN ('openai', 'anthropic', 'google', 'fake', 'internal') THEN
    RAISE EXCEPTION 'PROVEDOR_INVALIDO: "%" não é um provedor reconhecido (esperado: openai, anthropic, google, fake, internal)', p_provedor;
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
      provedor = p_provedor,
      concluido_em = now(),
      erro_tipo = NULL,
      erro_mensagem = NULL
  WHERE id = p_job_id;

  -- Reaproveita 100% da lógica de avanço já validada — mesma transação.
  RETURN public.estudio_anuncios_pipeline_avancar(p_pipeline_id, p_job_id);
END;
$$;

COMMENT ON FUNCTION public.estudio_anuncios_pipeline_concluir_job(UUID, UUID, TEXT) IS
  'Conclui o job atual (rodando -> concluido, gravando provedor=p_provedor) e avança o Pipeline numa única transação. p_provedor é obrigatório e deve ser um dos valores reconhecidos (openai/anthropic/google/fake/internal). Valida explicitamente (nulos, provedor, existência, projeto correspondente, job_atual_id, status do pipeline, status do job) ANTES de mudar qualquer estado, com FOR UPDATE em pipeline e job. Chama estudio_anuncios_pipeline_avancar() internamente, reaproveitando 100% da lógica já validada. Restrita a service_role.';

REVOKE EXECUTE ON FUNCTION public.estudio_anuncios_pipeline_concluir_job(UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.estudio_anuncios_pipeline_concluir_job(UUID, UUID, TEXT)
  TO service_role;


-- ────────────────────────────────────────────────────────────────────
-- estudio_anuncios_pipeline_falhar_job — nova assinatura (UUID, UUID, TEXT, TEXT, TEXT)
-- ────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.estudio_anuncios_pipeline_falhar_job(UUID, UUID, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.estudio_anuncios_pipeline_falhar_job(
  p_pipeline_id   UUID,
  p_job_id        UUID,
  p_erro_tipo     TEXT,
  p_erro_mensagem TEXT,
  p_provedor      TEXT
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
  -- p_provedor é opcional aqui (uma falha pode ocorrer antes de
  -- qualquer provedor ser contactado) — mas, se informado, precisa ser
  -- um valor reconhecido.
  IF p_provedor IS NOT NULL AND p_provedor NOT IN ('openai', 'anthropic', 'google', 'fake', 'internal') THEN
    RAISE EXCEPTION 'PROVEDOR_INVALIDO: "%" não é um provedor reconhecido (esperado: openai, anthropic, google, fake, internal)', p_provedor;
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

  -- COALESCE: nunca apaga um provedor já conhecido no job (defensivo —
  -- hoje o job sempre chega aqui com provedor NULL, mas não presume
  -- isso para sempre).
  UPDATE public.estudio_anuncios_jobs
  SET status = 'erro',
      provedor = COALESCE(p_provedor, provedor),
      erro_tipo = p_erro_tipo,
      erro_mensagem = left(p_erro_mensagem, 300)
  WHERE id = p_job_id;

  -- Reaproveita 100% da lógica de retry/erro já validada (a RPC decide
  -- sozinha se devolve o job para 'pendente' ou marca o pipeline em
  -- 'erro') — mesma transação.
  RETURN public.estudio_anuncios_pipeline_registrar_falha(p_pipeline_id, p_job_id, p_erro_tipo, p_erro_mensagem);
END;
$$;

COMMENT ON FUNCTION public.estudio_anuncios_pipeline_falhar_job(UUID, UUID, TEXT, TEXT, TEXT) IS
  'Marca o job atual em erro (rodando -> erro) e registra a falha no Pipeline numa única transação. p_provedor é opcional (uma falha pode ocorrer antes do Gateway ser contactado); quando informado, deve ser um valor reconhecido, e nunca sobrescreve com NULL um provedor já gravado (COALESCE). Mesmas validações explícitas de estudio_anuncios_pipeline_concluir_job() antes de mudar qualquer estado. A RPC interna pode devolver o job para pendente (retry) ou marcar o pipeline em erro (tentativas esgotadas) — decisão já validada, reaproveitada sem duplicação. Restrita a service_role.';

REVOKE EXECUTE ON FUNCTION public.estudio_anuncios_pipeline_falhar_job(UUID, UUID, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.estudio_anuncios_pipeline_falhar_job(UUID, UUID, TEXT, TEXT, TEXT)
  TO service_role;
