-- supabase/migrations/20260811_estudio_anuncios_job_origem_id.sql
--
-- Adiciona rastreabilidade explícita entre um job de geracao_conteudo e
-- o job exato de analise_visual que o originou. Nunca inferido por
-- "resultado mais recente" — preenchido dentro da mesma transação que
-- cria o job, por estudio_anuncios_pipeline_avancar().
--
-- Escopo desta migration: só a transição analise_visual -> geracao_conteudo
-- é preenchida. Não generaliza para "job_origem_id sempre aponta pro job
-- imediatamente anterior" — decisão explícita, ver contrato/preparação
-- de implementação. Outras transições continuam gravando NULL até uma
-- decisão própria existir para elas.

ALTER TABLE public.estudio_anuncios_jobs
  ADD COLUMN IF NOT EXISTS job_origem_id UUID;

-- Postgres não tem "ADD CONSTRAINT IF NOT EXISTS" (diferente de ADD
-- COLUMN) — idempotência via checagem explícita em pg_constraint antes
-- de adicionar.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_estudio_anuncios_jobs_job_origem_id'
      AND conrelid = 'public.estudio_anuncios_jobs'::regclass
  ) THEN
    ALTER TABLE public.estudio_anuncios_jobs
      ADD CONSTRAINT fk_estudio_anuncios_jobs_job_origem_id
      FOREIGN KEY (job_origem_id)
      REFERENCES public.estudio_anuncios_jobs(id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- Parcial (WHERE NOT NULL): a maioria dos jobs continuará com
-- job_origem_id=NULL nesta fase (só geracao_conteudo o preenche) —
-- mesmo padrão já usado em idx_imagens_origem_principal/
-- idx_imagens_geradas_principal (índice parcial condicionado a um
-- subconjunto pequeno de linhas).
CREATE INDEX IF NOT EXISTS idx_estudio_anuncios_jobs_job_origem_id
  ON public.estudio_anuncios_jobs (job_origem_id)
  WHERE job_origem_id IS NOT NULL;

COMMENT ON COLUMN public.estudio_anuncios_jobs.job_origem_id IS
  'Job de origem imediata desta execução (hoje: só preenchido em jobs geracao_conteudo, apontando pro job analise_visual concluído que o originou). NULL para o primeiro job de qualquer pipeline (analise_visual) e para qualquer transição ainda sem vínculo definido. Preenchido exclusivamente por estudio_anuncios_pipeline_avancar(), na mesma transação que cria o job — nunca em TypeScript, nunca inferido por "resultado mais recente". ON DELETE SET NULL: preserva o job consumidor mesmo se o job de origem for removido (hoje jobs nunca são DELETE físico, mas a FK não presume isso pra sempre).';


-- ────────────────────────────────────────────────────────────────────
-- estudio_anuncios_pipeline_avancar() — CREATE OR REPLACE completo,
-- corpo idêntico ao atual (confirmado via pg_get_functiondef contra o
-- banco real) exceto o INSERT do branch "próxima etapa ampla", que
-- ganha a coluna job_origem_id. O branch "próxima subetapa da mesma
-- etapa ampla" e todo o resto da função permanecem byte-a-byte iguais —
-- reproduzidos aqui só porque CREATE OR REPLACE FUNCTION exige o corpo
-- inteiro, não porque a lógica de decisão foi tocada.
-- ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.estudio_anuncios_pipeline_avancar(
  p_pipeline_id UUID,
  p_job_id      UUID
)
RETURNS public.estudio_anuncios_pipeline
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_pipeline              public.estudio_anuncios_pipeline;
  v_job                   public.estudio_anuncios_jobs;
  v_catalogo_atual        public.estudio_anuncios_pipeline_catalogo;
  v_subetapa_atual        public.estudio_anuncios_pipeline_catalogo_jobs;
  v_proxima_subetapa      public.estudio_anuncios_pipeline_catalogo_jobs;
  v_proxima_etapa_row     public.estudio_anuncios_pipeline_catalogo;
  v_primeira_subetapa     public.estudio_anuncios_pipeline_catalogo_jobs;
  v_novo_job_id           UUID;
BEGIN
  SELECT * INTO v_pipeline
  FROM public.estudio_anuncios_pipeline
  WHERE id = p_pipeline_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'pipeline % não encontrado', p_pipeline_id;
  END IF;

  IF v_pipeline.job_atual_id IS DISTINCT FROM p_job_id THEN
    RAISE EXCEPTION 'USO_INVALIDO_PIPELINE: job informado não corresponde ao job atual do pipeline (pipeline=%, job_atual_id=%, job_informado=%)',
      p_pipeline_id, v_pipeline.job_atual_id, p_job_id;
  END IF;

  IF v_pipeline.status <> 'em_execucao' THEN
    RAISE EXCEPTION 'PIPELINE_NAO_ESTA_EM_EXECUCAO: status atual é "%" (pipeline=%)', v_pipeline.status, p_pipeline_id;
  END IF;

  SELECT * INTO v_job FROM public.estudio_anuncios_jobs WHERE id = p_job_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'job % não encontrado', p_job_id;
  END IF;
  IF v_job.status <> 'concluido' THEN
    RAISE EXCEPTION 'job % não está concluído (status atual: %)', p_job_id, v_job.status;
  END IF;

  SELECT * INTO v_catalogo_atual
  FROM public.estudio_anuncios_pipeline_catalogo
  WHERE versao_catalogo = v_pipeline.versao_catalogo
    AND etapa = v_pipeline.etapa_atual;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'etapa "%" não encontrada no catálogo (versão %)', v_pipeline.etapa_atual, v_pipeline.versao_catalogo;
  END IF;

  SELECT * INTO v_subetapa_atual
  FROM public.estudio_anuncios_pipeline_catalogo_jobs
  WHERE catalogo_id = v_catalogo_atual.id
    AND job_etapa = v_job.etapa;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'subetapa "%" não encontrada no catálogo para a etapa "%"', v_job.etapa, v_catalogo_atual.etapa;
  END IF;

  SELECT * INTO v_proxima_subetapa
  FROM public.estudio_anuncios_pipeline_catalogo_jobs
  WHERE catalogo_id = v_catalogo_atual.id
    AND ordem > v_subetapa_atual.ordem
    AND obrigatoria = true
  ORDER BY ordem ASC
  LIMIT 1;

  IF FOUND THEN
    -- Branch inalterado nesta migration: job_origem_id não é preenchido
    -- aqui (transições dentro da mesma etapa ampla, ex. geracao_conteudo
    -- -> revisao_claude, não têm vínculo definido nesta tarefa).
    INSERT INTO public.estudio_anuncios_jobs (projeto_id, etapa, status, max_tentativas)
    VALUES (v_pipeline.projeto_id, v_proxima_subetapa.job_etapa, 'pendente', v_catalogo_atual.max_tentativas)
    RETURNING id INTO v_novo_job_id;

    UPDATE public.estudio_anuncios_pipeline
    SET job_atual_id = v_novo_job_id,
        status = 'aguardando',
        ultima_execucao = now(),
        atualizado_em = now()
    WHERE id = p_pipeline_id
    RETURNING * INTO v_pipeline;

    RETURN v_pipeline;
  END IF;

  SELECT * INTO v_proxima_etapa_row
  FROM public.estudio_anuncios_pipeline_catalogo
  WHERE versao_catalogo = v_pipeline.versao_catalogo
    AND ordem > v_catalogo_atual.ordem
    AND ativa = true
    AND tipo = 'obrigatoria'
  ORDER BY ordem ASC
  LIMIT 1;

  IF NOT FOUND THEN
    UPDATE public.estudio_anuncios_pipeline
    SET status = 'concluido',
        proxima_etapa = NULL,
        concluido_em = now(),
        ultima_execucao = now(),
        atualizado_em = now()
    WHERE id = p_pipeline_id
    RETURNING * INTO v_pipeline;

    RETURN v_pipeline;
  END IF;

  SELECT * INTO v_primeira_subetapa
  FROM public.estudio_anuncios_pipeline_catalogo_jobs
  WHERE catalogo_id = v_proxima_etapa_row.id
    AND obrigatoria = true
  ORDER BY ordem ASC
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'etapa "%" está ativa e obrigatória mas não tem nenhuma subetapa obrigatória cadastrada', v_proxima_etapa_row.etapa;
  END IF;

  -- ÚNICA MUDANÇA REAL DESTA MIGRATION: job_origem_id preenchido só
  -- quando o job que acabou de concluir é analise_visual e o job novo é
  -- geracao_conteudo. Qualquer outra combinação grava NULL, igual hoje.
  INSERT INTO public.estudio_anuncios_jobs (projeto_id, etapa, status, max_tentativas, job_origem_id)
  VALUES (
    v_pipeline.projeto_id,
    v_primeira_subetapa.job_etapa,
    'pendente',
    v_proxima_etapa_row.max_tentativas,
    CASE
      WHEN v_job.etapa = 'analise_visual' AND v_primeira_subetapa.job_etapa = 'geracao_conteudo'
      THEN v_job.id
      ELSE NULL
    END
  )
  RETURNING id INTO v_novo_job_id;

  UPDATE public.estudio_anuncios_pipeline
  SET etapa_atual = v_proxima_etapa_row.etapa,
      job_atual_id = v_novo_job_id,
      status = 'aguardando',
      ultima_execucao = now(),
      atualizado_em = now()
  WHERE id = p_pipeline_id
  RETURNING * INTO v_pipeline;

  RETURN v_pipeline;
END;
$$;

COMMENT ON FUNCTION public.estudio_anuncios_pipeline_avancar(UUID, UUID) IS
  'Avança o Pipeline após um job concluir com sucesso — cria o próximo job (mesma etapa ou próxima etapa ampla obrigatória) ou marca o pipeline concluído, atomicamente. Preenche job_origem_id apenas na transição analise_visual -> geracao_conteudo (ver migration 20260811); outras transições gravam NULL até terem vínculo definido. NÃO é tolerante a chamada duplicada/fora de ordem. Restrita a service_role.';

-- REVOKE/GRANT inalterados (já existem, CREATE OR REPLACE não os remove
-- em Postgres — mas reafirmados aqui por clareza/paridade com o padrão
-- já usado nas outras migrations desta RPC).
REVOKE EXECUTE ON FUNCTION public.estudio_anuncios_pipeline_avancar(UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.estudio_anuncios_pipeline_avancar(UUID, UUID)
  TO service_role;
