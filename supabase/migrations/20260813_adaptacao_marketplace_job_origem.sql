-- ────────────────────────────────────────────────────────────────────
-- 20260813_adaptacao_marketplace_job_origem.sql
--
-- Substitui estudio_anuncios_pipeline_avancar() para dar a
-- `adaptacao_marketplace` uma ORIGEM DETERMINÍSTICA.
--
-- SEMÂNTICA OFICIAL DE job_origem_id (decidida pelo usuário, 2026-08-13):
--   job_origem_id aponta para o job que produziu o ARTEFATO DE DOMÍNIO
--   efetivamente consumido pela etapa atual. NÃO significa "job
--   imediatamente anterior na cadeia".
--
-- Aplicação nesta migration:
--   analise_visual      -> geracao_conteudo        (já existia, 20260811)
--   geracao_conteudo    -> adaptacao_marketplace   (NOVO, aqui)
--
-- POR QUE NÃO revisao_claude: ela está em ETAPAS_FAKE_GENERICAS
-- (lib/estudio-anuncios/executores/registry.ts), usa handlerFakeGenerico
-- com geraResultadoEstruturado=false e portanto NÃO grava nenhuma linha
-- em estudio_anuncios_resultados_pipeline. Não existe artefato dela para
-- consumir. Ela permanece no fluxo do Pipeline, apenas não é origem
-- semântica. Quando revisao_claude passar a produzir resultado real,
-- esta regra deve ser reavaliada explicitamente.
--
-- NÃO GENERALIZA (decisão explícita do usuário): nenhuma outra transição
-- intra-etapa passa a preencher job_origem_id. Em particular,
-- geracao_prompts_imagem -> geracao_imagem continua gravando NULL — cada
-- dependência semântica é definida quando a etapa real for implementada.
--
-- ────────────────────────────────────────────────────────────────────
-- COMO A ORIGEM É RESOLVIDA (determinística, sem heurística de tempo)
--
-- Proibido por decisão do usuário: ORDER BY criado_em DESC LIMIT 1.
-- Nenhuma ordenação é usada aqui.
--
-- O job de geracao_conteudo é localizado pela existência do próprio
-- artefato: JOIN com estudio_anuncios_resultados_pipeline. Só é origem
-- válida um job que (a) pertence ao mesmo projeto, (b) tem
-- etapa='geracao_conteudo', (c) está 'concluido' e (d) POSSUI resultado
-- estruturado gravado. Como resultados_pipeline tem UNIQUE(job_id), a
-- relação é 1:1 e o conjunto é exato, não aproximado.
--
-- Três desfechos, todos explícitos:
--   • exatamente 1  -> job_origem_id recebe esse id;
--   • 0             -> job_origem_id fica NULL. Isso NÃO é fallback
--                      silencioso: significa que nenhum artefato real
--                      existe (caminho fake, em que geracao_conteudo não
--                      grava resultado). O handler de
--                      adaptacao_marketplace rejeita explicitamente
--                      origem ausente quando o provedor é real, e o
--                      caminho fake segue funcionando sem regressão;
--   • >1            -> RAISE EXCEPTION. Ambiguidade real nunca é
--                      resolvida por escolha automática.
--
-- Verificado no banco antes de escrever (2026-08-13): 0 projetos com
-- mais de 1 job de geracao_conteudo concluído com resultado.
--
-- Corpo copiado da versão VIGENTE (20260811). Única diferença: o branch
-- intra-etapa, marcado abaixo.
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
  v_origem_id             UUID;
  v_origem_qtd            INTEGER;
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
    -- ── ÚNICA MUDANÇA DESTA MIGRATION (2026-08-13) ──────────────────
    -- Transição intra-etapa. Até 20260811 este branch gravava sempre
    -- NULL. Agora, e SOMENTE quando a próxima subetapa é
    -- 'adaptacao_marketplace', resolve a origem semântica: o job de
    -- geracao_conteudo que produziu o EnvelopeGeracaoConteudo a ser
    -- consumido. Nenhuma outra subetapa é afetada.
    v_origem_id := NULL;

    IF v_proxima_subetapa.job_etapa = 'adaptacao_marketplace' THEN
      SELECT count(*) INTO v_origem_qtd
      FROM public.estudio_anuncios_jobs j
      JOIN public.estudio_anuncios_resultados_pipeline rp
        ON rp.job_id = j.id
       AND rp.etapa = 'geracao_conteudo'
      WHERE j.projeto_id = v_pipeline.projeto_id
        AND j.etapa      = 'geracao_conteudo'
        AND j.status     = 'concluido';

      IF v_origem_qtd > 1 THEN
        RAISE EXCEPTION 'ORIGEM_AMBIGUA: % jobs de geracao_conteudo concluídos com resultado no projeto % — origem de adaptacao_marketplace não pode ser escolhida automaticamente',
          v_origem_qtd, v_pipeline.projeto_id;
      END IF;

      IF v_origem_qtd = 1 THEN
        SELECT j.id INTO v_origem_id
        FROM public.estudio_anuncios_jobs j
        JOIN public.estudio_anuncios_resultados_pipeline rp
          ON rp.job_id = j.id
         AND rp.etapa = 'geracao_conteudo'
        WHERE j.projeto_id = v_pipeline.projeto_id
          AND j.etapa      = 'geracao_conteudo'
          AND j.status     = 'concluido';
      END IF;
      -- v_origem_qtd = 0 -> v_origem_id permanece NULL (caminho fake,
      -- sem artefato real). Tratado explicitamente pelo handler.
    END IF;

    INSERT INTO public.estudio_anuncios_jobs (projeto_id, etapa, status, max_tentativas, job_origem_id)
    VALUES (v_pipeline.projeto_id, v_proxima_subetapa.job_etapa, 'pendente', v_catalogo_atual.max_tentativas, v_origem_id)
    RETURNING id INTO v_novo_job_id;
    -- ── FIM DA MUDANÇA ──────────────────────────────────────────────

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

  -- Branch entre etapas amplas — inalterado desde 20260811.
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
  'Avança o Pipeline após um job concluir com sucesso — cria o próximo job (mesma etapa ou próxima etapa ampla obrigatória) ou marca o pipeline concluído, atomicamente. job_origem_id segue a semântica oficial "job que produziu o artefato de domínio consumido": preenchido em analise_visual -> geracao_conteudo (20260811) e em geracao_conteudo -> adaptacao_marketplace (20260813, resolvido por JOIN com resultados_pipeline, sem ordenação; >1 candidato levanta ORIGEM_AMBIGUA). Demais transições gravam NULL até terem vínculo definido. NÃO é tolerante a chamada duplicada/fora de ordem. Restrita a service_role.';

REVOKE EXECUTE ON FUNCTION public.estudio_anuncios_pipeline_avancar(UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.estudio_anuncios_pipeline_avancar(UUID, UUID)
  TO service_role;
