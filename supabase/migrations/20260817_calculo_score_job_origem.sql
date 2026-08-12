-- ────────────────────────────────────────────────────────────────────
-- 20260817_calculo_score_job_origem.sql
--
-- Substitui estudio_anuncios_pipeline_avancar() para dar origem
-- deterministica a calculo_score -- a ultima etapa da Fase 1.
--
-- SEMANTICA (inalterada, congelada em 2026-08-13): job_origem_id aponta
-- para o job que produziu o ARTEFATO DE DOMINIO efetivamente consumido.
--
-- Mapa apos esta migration (Fase 1 completa):
--   analise_visual         -> geracao_conteudo         (20260811)
--   geracao_conteudo       -> revisao_claude           (20260814)
--   revisao_claude         -> adaptacao_marketplace    (20260814, precedencia)
--   analise_visual         -> geracao_prompts_imagem   (20260815)
--   geracao_prompts_imagem -> geracao_imagem           (20260816)
--   geracao_imagem         -> calculo_score            (NOVO)
--
-- POR QUE geracao_imagem. calculo_score avalia o ANUNCIO INTEIRO, entao
-- consome varios artefatos -- mas job_origem_id representa UMA origem
-- principal, nunca uma lista. A escolhida e geracao_imagem por ser o
-- ultimo artefato obrigatorio produzido antes do score. As demais fontes
-- NAO sao resolvidas por busca cega: saem de referencias EMBUTIDAS nos
-- proprios envelopes, encadeadas a partir dai --
--   geracao_imagem.fontePromptsImagem      -> geracao_prompts_imagem
--   geracao_prompts_imagem.fonteAnaliseVisual -> analise_visual
--   adaptacao_marketplace.fonteGeracaoConteudo -> revisao_claude ou geracao_conteudo
--   revisao_claude.fonteConteudoBase       -> geracao_conteudo
-- Unica excecao: adaptacao_marketplace nao e alcancavel por link
-- embutido (nada aponta "para frente" a partir das imagens), entao vale
-- a mesma regra das origens: EXATAMENTE 1 candidato no projeto, e mais de
-- um levanta erro explicito. Em nenhum ponto ha ORDER BY criado_em nem
-- "resultado mais recente".
--
-- REGRA DE RESOLUCAO (identica as anteriores): exatamente 1 candidato.
--   * 1 geracao_imagem concluida com resultado -> usa essa
--   * >1 -> RAISE ORIGEM_AMBIGUA
--   * 0  -> NULL, e o handler rejeita explicitamente
--
-- ESTA E A ULTIMA TRANSICAO DA FASE 1. Depois de calculo_score nao ha
-- proxima etapa obrigatoria ativa no catalogo, entao o Pipeline fecha
-- (status=concluido, concluido_em preenchido) pelo caminho que ja
-- existia -- nenhum job novo e criado.
--
-- Corpo copiado da versao VIGENTE (20260816). Diferenca: um IF novo no
-- branch entre etapas amplas, marcado abaixo.
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
    -- ── Transição intra-etapa — inalterada desde 20260814 ────────────
    v_origem_id := NULL;

    -- revisao_claude consome o artefato de geracao_conteudo.
    IF v_proxima_subetapa.job_etapa = 'revisao_claude' THEN
      SELECT count(*) INTO v_origem_qtd
      FROM public.estudio_anuncios_jobs j
      JOIN public.estudio_anuncios_resultados_pipeline rp
        ON rp.job_id = j.id AND rp.etapa = 'geracao_conteudo'
      WHERE j.projeto_id = v_pipeline.projeto_id
        AND j.etapa = 'geracao_conteudo' AND j.status = 'concluido';

      IF v_origem_qtd > 1 THEN
        RAISE EXCEPTION 'ORIGEM_AMBIGUA: % jobs de geracao_conteudo concluidos com resultado no projeto % -- origem de revisao_claude nao pode ser escolhida automaticamente',
          v_origem_qtd, v_pipeline.projeto_id;
      END IF;

      IF v_origem_qtd = 1 THEN
        SELECT j.id INTO v_origem_id
        FROM public.estudio_anuncios_jobs j
        JOIN public.estudio_anuncios_resultados_pipeline rp
          ON rp.job_id = j.id AND rp.etapa = 'geracao_conteudo'
        WHERE j.projeto_id = v_pipeline.projeto_id
          AND j.etapa = 'geracao_conteudo' AND j.status = 'concluido';
      END IF;
    END IF;

    -- adaptacao_marketplace: precedencia revisao_claude -> geracao_conteudo.
    IF v_proxima_subetapa.job_etapa = 'adaptacao_marketplace' THEN
      SELECT count(*) INTO v_origem_qtd
      FROM public.estudio_anuncios_jobs j
      JOIN public.estudio_anuncios_resultados_pipeline rp
        ON rp.job_id = j.id AND rp.etapa = 'revisao_claude'
      WHERE j.projeto_id = v_pipeline.projeto_id
        AND j.etapa = 'revisao_claude' AND j.status = 'concluido';

      IF v_origem_qtd > 1 THEN
        RAISE EXCEPTION 'ORIGEM_AMBIGUA: % jobs de revisao_claude concluidos com resultado no projeto % -- origem de adaptacao_marketplace nao pode ser escolhida automaticamente',
          v_origem_qtd, v_pipeline.projeto_id;
      END IF;

      IF v_origem_qtd = 1 THEN
        SELECT j.id INTO v_origem_id
        FROM public.estudio_anuncios_jobs j
        JOIN public.estudio_anuncios_resultados_pipeline rp
          ON rp.job_id = j.id AND rp.etapa = 'revisao_claude'
        WHERE j.projeto_id = v_pipeline.projeto_id
          AND j.etapa = 'revisao_claude' AND j.status = 'concluido';
      ELSE
        SELECT count(*) INTO v_origem_qtd
        FROM public.estudio_anuncios_jobs j
        JOIN public.estudio_anuncios_resultados_pipeline rp
          ON rp.job_id = j.id AND rp.etapa = 'geracao_conteudo'
        WHERE j.projeto_id = v_pipeline.projeto_id
          AND j.etapa = 'geracao_conteudo' AND j.status = 'concluido';

        IF v_origem_qtd > 1 THEN
          RAISE EXCEPTION 'ORIGEM_AMBIGUA: % jobs de geracao_conteudo concluidos com resultado no projeto % -- origem de adaptacao_marketplace nao pode ser escolhida automaticamente',
            v_origem_qtd, v_pipeline.projeto_id;
        END IF;

        IF v_origem_qtd = 1 THEN
          SELECT j.id INTO v_origem_id
          FROM public.estudio_anuncios_jobs j
          JOIN public.estudio_anuncios_resultados_pipeline rp
            ON rp.job_id = j.id AND rp.etapa = 'geracao_conteudo'
          WHERE j.projeto_id = v_pipeline.projeto_id
            AND j.etapa = 'geracao_conteudo' AND j.status = 'concluido';
        END IF;
      END IF;
    END IF;

    -- ── UNICA MUDANCA DESTA MIGRATION (2026-08-16) ─────────────────
    -- geracao_imagem consome o artefato de geracao_prompts_imagem.
    -- Transicao intra-etapa (gerar_imagens: subetapa 1 -> 2).
    IF v_proxima_subetapa.job_etapa = 'geracao_imagem' THEN
      SELECT count(*) INTO v_origem_qtd
      FROM public.estudio_anuncios_jobs j
      JOIN public.estudio_anuncios_resultados_pipeline rp
        ON rp.job_id = j.id AND rp.etapa = 'geracao_prompts_imagem'
      WHERE j.projeto_id = v_pipeline.projeto_id
        AND j.etapa = 'geracao_prompts_imagem' AND j.status = 'concluido';

      IF v_origem_qtd > 1 THEN
        RAISE EXCEPTION 'ORIGEM_AMBIGUA: % jobs de geracao_prompts_imagem concluidos com resultado no projeto % -- origem de geracao_imagem nao pode ser escolhida automaticamente',
          v_origem_qtd, v_pipeline.projeto_id;
      END IF;

      IF v_origem_qtd = 1 THEN
        SELECT j.id INTO v_origem_id
        FROM public.estudio_anuncios_jobs j
        JOIN public.estudio_anuncios_resultados_pipeline rp
          ON rp.job_id = j.id AND rp.etapa = 'geracao_prompts_imagem'
        WHERE j.projeto_id = v_pipeline.projeto_id
          AND j.etapa = 'geracao_prompts_imagem' AND j.status = 'concluido';
      END IF;
    END IF;
    -- ── FIM DA MUDANCA ─────────────────────────────────────────────

    INSERT INTO public.estudio_anuncios_jobs (projeto_id, etapa, status, max_tentativas, job_origem_id)
    VALUES (v_pipeline.projeto_id, v_proxima_subetapa.job_etapa, 'pendente', v_catalogo_atual.max_tentativas, v_origem_id)
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

  -- ── UNICA MUDANCA DESTA MIGRATION (2026-08-15) ────────────────────
  -- Branch entre etapas amplas. Ate 20260814 este branch so sabia
  -- resolver a transicao analise_visual -> geracao_conteudo (onde o job
  -- de origem E o job atual). Agora resolve tambem
  -- adaptacao_marketplace -> geracao_prompts_imagem, onde o job de
  -- origem NAO e o job atual: e preciso buscar o job de analise_visual
  -- do projeto, por JOIN com resultados_pipeline, exigindo exatamente 1
  -- candidato. Nenhuma ordenacao por criado_em.
  v_origem_id := NULL;

  IF v_job.etapa = 'analise_visual' AND v_primeira_subetapa.job_etapa = 'geracao_conteudo' THEN
    v_origem_id := v_job.id;
  END IF;

  -- ── UNICA MUDANCA DESTA MIGRATION (2026-08-17) ────────────────────
  -- calculo_score consome o artefato de geracao_imagem. Transicao entre
  -- etapas amplas (gerar_imagens -> avaliacao).
  IF v_primeira_subetapa.job_etapa = 'calculo_score' THEN
    SELECT count(*) INTO v_origem_qtd
    FROM public.estudio_anuncios_jobs j
    JOIN public.estudio_anuncios_resultados_pipeline rp
      ON rp.job_id = j.id AND rp.etapa = 'geracao_imagem'
    WHERE j.projeto_id = v_pipeline.projeto_id
      AND j.etapa = 'geracao_imagem' AND j.status = 'concluido';

    IF v_origem_qtd > 1 THEN
      RAISE EXCEPTION 'ORIGEM_AMBIGUA: % jobs de geracao_imagem concluidos com resultado no projeto % -- origem de calculo_score nao pode ser escolhida automaticamente',
        v_origem_qtd, v_pipeline.projeto_id;
    END IF;

    IF v_origem_qtd = 1 THEN
      SELECT j.id INTO v_origem_id
      FROM public.estudio_anuncios_jobs j
      JOIN public.estudio_anuncios_resultados_pipeline rp
        ON rp.job_id = j.id AND rp.etapa = 'geracao_imagem'
      WHERE j.projeto_id = v_pipeline.projeto_id
        AND j.etapa = 'geracao_imagem' AND j.status = 'concluido';
    END IF;
  END IF;
  -- ── FIM DA MUDANCA ────────────────────────────────────────────────

  IF v_primeira_subetapa.job_etapa = 'geracao_prompts_imagem' THEN
    SELECT count(*) INTO v_origem_qtd
    FROM public.estudio_anuncios_jobs j
    JOIN public.estudio_anuncios_resultados_pipeline rp
      ON rp.job_id = j.id AND rp.etapa = 'analise_visual'
    WHERE j.projeto_id = v_pipeline.projeto_id
      AND j.etapa = 'analise_visual' AND j.status = 'concluido';

    IF v_origem_qtd > 1 THEN
      RAISE EXCEPTION 'ORIGEM_AMBIGUA: % jobs de analise_visual concluidos com resultado no projeto % -- origem de geracao_prompts_imagem nao pode ser escolhida automaticamente',
        v_origem_qtd, v_pipeline.projeto_id;
    END IF;

    IF v_origem_qtd = 1 THEN
      SELECT j.id INTO v_origem_id
      FROM public.estudio_anuncios_jobs j
      JOIN public.estudio_anuncios_resultados_pipeline rp
        ON rp.job_id = j.id AND rp.etapa = 'analise_visual'
      WHERE j.projeto_id = v_pipeline.projeto_id
        AND j.etapa = 'analise_visual' AND j.status = 'concluido';
    END IF;
  END IF;

  INSERT INTO public.estudio_anuncios_jobs (projeto_id, etapa, status, max_tentativas, job_origem_id)
  VALUES (
    v_pipeline.projeto_id,
    v_primeira_subetapa.job_etapa,
    'pendente',
    v_proxima_etapa_row.max_tentativas,
    v_origem_id
  )
  RETURNING id INTO v_novo_job_id;
  -- ── FIM DA MUDANCA ────────────────────────────────────────────────

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
  'Avança o Pipeline após um job concluir com sucesso — cria o próximo job (mesma etapa ou próxima etapa ampla obrigatória) ou marca o pipeline concluído, atomicamente. job_origem_id segue a semântica oficial "job que produziu o artefato de domínio consumido": analise_visual -> geracao_conteudo (20260811), geracao_conteudo -> revisao_claude e revisao_claude -> adaptacao_marketplace com precedência (20260814), analise_visual -> geracao_prompts_imagem (20260815) e geracao_prompts_imagem -> geracao_imagem (20260816) e geracao_imagem -> calculo_score (20260817), todos resolvidos por JOIN com resultados_pipeline, sem ordenação; >1 candidato levanta ORIGEM_AMBIGUA. Demais transições gravam NULL até terem vínculo definido. NÃO é tolerante a chamada duplicada/fora de ordem. Restrita a service_role.';

REVOKE EXECUTE ON FUNCTION public.estudio_anuncios_pipeline_avancar(UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.estudio_anuncios_pipeline_avancar(UUID, UUID)
  TO service_role;
