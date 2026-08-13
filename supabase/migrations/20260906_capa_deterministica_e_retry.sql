-- ────────────────────────────────────────────────────────────────────
-- 20260906_capa_deterministica_e_retry.sql
--
-- DUAS COISAS, ambas aditivas:
--   A) proveniencia da imagem composta deterministicamente
--   B) RPC de retomada de pipeline em erro
--
-- NENHUM anuncio e publicado. NENHUMA chamada de IA acontece aqui.
--
-- ── (A) POR QUE PROVENIENCIA ────────────────────────────────────────
-- A capa passa a ser COMPOSTA a partir dos pixels reais da foto, sem
-- IA. Isso muda a natureza do artefato: ele deixa de ser "saida de um
-- modelo" e passa a ser "transformacao auditavel de um original".
--
-- Para a fidelidade ser AUDITAVEL, e nao apenas afirmada, e preciso
-- saber depois: de qual foto veio, por qual metodo, em que versao, se
-- houve IA, e os checksums de cada estagio. Sem isso, "o produto foi
-- preservado" seria promessa, nao prova.
--
-- As colunas entram em `estudio_anuncios_imagens_geradas` de proposito:
-- e a MESMA tabela das imagens geradas por IA. Criar uma tabela paralela
-- para imagens compostas produziria duas fontes de verdade sobre "as
-- imagens do projeto" — e todo consumidor (score, exportacao, UI,
-- pictures do ML) teria de conhecer as duas.
--
-- `provedor` NAO precisa mudar: o CHECK ja aceita 'internal', que e
-- exatamente o valor correto para um caminho sem provedor externo.
--
-- ── (B) POR QUE A RPC DE RETRY ──────────────────────────────────────
-- Um pipeline que falha hoje fica parado para sempre. A rota
-- `pipeline_iniciar` e idempotente e devolve o estado atual sem retomar
-- (comportamento documentado e correto — retomar nao era escopo dela).
-- Resultado pratico: uma etapa que falhou obriga a refazer o projeto
-- inteiro, pagando de novo todas as etapas anteriores.
--
-- A RPC abaixo cria UM job novo da etapa que falhou. Ela nao reseta o
-- job antigo: append-only preserva o historico das tentativas, que e a
-- disciplina do resto do modulo.
--
-- IDEMPOTENTE. Pode rodar mais de uma vez sem efeito colateral.
-- ────────────────────────────────────────────────────────────────────

-- ══════════════════════════════════════════════════════════════════
-- (A) PROVENIENCIA
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE public.estudio_anuncios_imagens_geradas
  ADD COLUMN IF NOT EXISTS origem_foto_id     UUID REFERENCES public.estudio_anuncios_imagens_origem(id),
  ADD COLUMN IF NOT EXISTS metodo             TEXT,
  ADD COLUMN IF NOT EXISTS versao_metodo      INTEGER,
  ADD COLUMN IF NOT EXISTS houve_ia           BOOLEAN,
  ADD COLUMN IF NOT EXISTS houve_composicao   BOOLEAN,
  ADD COLUMN IF NOT EXISTS checksum_original  TEXT,
  ADD COLUMN IF NOT EXISTS checksum_recorte   TEXT,
  ADD COLUMN IF NOT EXISTS checksum_final     TEXT,
  ADD COLUMN IF NOT EXISTS escala_aplicada    NUMERIC;

-- Metodo e vocabulario fechado: um valor livre viraria texto solto e
-- impediria consultar "todas as capas compostas sem IA".
ALTER TABLE public.estudio_anuncios_imagens_geradas
  DROP CONSTRAINT IF EXISTS chk_imagens_geradas_metodo;
ALTER TABLE public.estudio_anuncios_imagens_geradas
  ADD CONSTRAINT chk_imagens_geradas_metodo
  CHECK (metodo IS NULL OR metodo IN ('geracao_ia', 'recorte_fundo_branco'));

-- Coerencia: o caminho deterministico NAO pode se declarar com IA, e
-- precisa dizer de qual foto veio. Sem isto, a proveniencia poderia
-- mentir sem que nada reclamasse.
ALTER TABLE public.estudio_anuncios_imagens_geradas
  DROP CONSTRAINT IF EXISTS chk_imagens_geradas_proveniencia_coerente;
ALTER TABLE public.estudio_anuncios_imagens_geradas
  ADD CONSTRAINT chk_imagens_geradas_proveniencia_coerente
  CHECK (
    metodo IS DISTINCT FROM 'recorte_fundo_branco'
    OR (houve_ia = false AND origem_foto_id IS NOT NULL AND checksum_final IS NOT NULL)
  );

COMMENT ON COLUMN public.estudio_anuncios_imagens_geradas.origem_foto_id IS
  'Foto de origem quando a imagem foi COMPOSTA a partir de pixels reais. NULL quando gerada por IA.';
COMMENT ON COLUMN public.estudio_anuncios_imagens_geradas.metodo IS
  'geracao_ia = modelo produziu os pixels. recorte_fundo_branco = recorte da foto original + fundo branco, sem IA.';
COMMENT ON COLUMN public.estudio_anuncios_imagens_geradas.checksum_final IS
  'sha256 do arquivo persistido. Com checksum_original e checksum_recorte permite reauditar a cadeia inteira sem confiar em log.';

-- ══════════════════════════════════════════════════════════════════
-- (B) RETOMADA DE PIPELINE EM ERRO
-- ══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.estudio_anuncios_pipeline_retomar(
  p_pipeline_id UUID
)
RETURNS TABLE (
  pipeline_id   UUID,
  projeto_id    UUID,
  status        TEXT,
  etapa_atual   TEXT,
  job_atual_id  UUID,
  job_criado    BOOLEAN
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_pipeline   public.estudio_anuncios_pipeline%ROWTYPE;
  v_projeto    public.estudio_anuncios_projetos%ROWTYPE;
  v_job_falho  public.estudio_anuncios_jobs%ROWTYPE;
  v_origem_id  UUID;
  v_novo_id    UUID;
BEGIN
  -- Trava o pipeline: dois cliques simultaneos nao podem criar dois jobs.
  SELECT pl.* INTO v_pipeline
  FROM public.estudio_anuncios_pipeline pl
  WHERE pl.id = p_pipeline_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PIPELINE_NAO_ENCONTRADO: %', p_pipeline_id;
  END IF;

  SELECT pr.* INTO v_projeto
  FROM public.estudio_anuncios_projetos pr
  WHERE pr.id = v_pipeline.projeto_id;

  IF v_projeto.status = 'cancelado' THEN
    RAISE EXCEPTION 'PROJETO_CANCELADO: nao e possivel retomar';
  END IF;
  IF v_projeto.status = 'concluido' THEN
    RAISE EXCEPTION 'PROJETO_CONCLUIDO: nao e possivel retomar';
  END IF;

  -- IDEMPOTENCIA: fora de 'erro' nao ha o que retomar. Devolve o estado
  -- atual com job_criado=false em vez de lancar — assim duplo clique e
  -- clique em pipeline sadio sao inofensivos.
  IF v_pipeline.status <> 'erro' THEN
    RETURN QUERY SELECT v_pipeline.id, v_pipeline.projeto_id, v_pipeline.status,
                        v_pipeline.etapa_atual, v_pipeline.job_atual_id, false;
    RETURN;
  END IF;

  IF v_pipeline.job_atual_id IS NULL THEN
    RAISE EXCEPTION 'PIPELINE_SEM_JOB_ATUAL: nao ha etapa identificavel para refazer';
  END IF;

  SELECT j.* INTO v_job_falho
  FROM public.estudio_anuncios_jobs j
  WHERE j.id = v_pipeline.job_atual_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'JOB_ATUAL_NAO_ENCONTRADO: %', v_pipeline.job_atual_id;
  END IF;
  IF v_job_falho.status <> 'erro' THEN
    RAISE EXCEPTION 'JOB_ATUAL_NAO_ESTA_EM_ERRO: status atual %', v_job_falho.status;
  END IF;

  -- Se ja existe job executavel para este projeto, nao cria outro. Duas
  -- linhas pendentes da mesma etapa quebrariam a resolucao de origem.
  -- `j.` obrigatorio: `projeto_id` e `status` tambem sao nomes da lista
  -- RETURNS TABLE, e sem qualificar o Postgres acusa ambiguidade. Mesma
  -- armadilha ja registrada na Constituicao (secao 11).
  IF EXISTS (
    SELECT 1 FROM public.estudio_anuncios_jobs j
    WHERE j.projeto_id = v_pipeline.projeto_id
      AND j.status IN ('pendente', 'rodando')
  ) THEN
    RETURN QUERY SELECT v_pipeline.id, v_pipeline.projeto_id, v_pipeline.status,
                        v_pipeline.etapa_atual, v_pipeline.job_atual_id, false;
    RETURN;
  END IF;

  -- A origem do job novo e a MESMA do job que falhou. Reaproveitar em vez
  -- de recalcular evita divergir da logica de `_avancar()` — e o job
  -- falho ja tinha a origem correta quando foi criado.
  v_origem_id := v_job_falho.job_origem_id;

  v_novo_id := gen_random_uuid();

  -- APPEND-ONLY: o job falho fica intacto, como historico das tentativas.
  -- Resetar o antigo apagaria o registro das falhas.
  INSERT INTO public.estudio_anuncios_jobs (
    id, projeto_id, projeto_marketplace_id, etapa, referencia_id,
    status, tentativas, max_tentativas, job_origem_id, criado_em
  ) VALUES (
    v_novo_id, v_job_falho.projeto_id, v_job_falho.projeto_marketplace_id,
    v_job_falho.etapa, v_job_falho.referencia_id,
    'pendente', 0, v_job_falho.max_tentativas, v_origem_id, now()
  );

  -- `etapa_atual` NAO muda: e a mesma etapa ampla. Só o job e o status.
  UPDATE public.estudio_anuncios_pipeline AS pl
  SET status        = 'aguardando',
      job_atual_id  = v_novo_id,
      erro_tipo     = NULL,
      erro_mensagem = NULL,
      atualizado_em = now()
  WHERE pl.id = p_pipeline_id;

  RETURN QUERY SELECT p_pipeline_id, v_pipeline.projeto_id, 'aguardando'::TEXT,
                      v_pipeline.etapa_atual, v_novo_id, true;
END;
$$;

-- SEC1 (BUGS.md): este projeto tem ALTER DEFAULT PRIVILEGES concedendo
-- EXECUTE a anon/authenticated em TODA funcao nova. REVOKE FROM PUBLIC
-- nao cobre isso — PUBLIC e um pseudo-role distinto. O revoke abaixo e
-- explicito e obrigatorio.
REVOKE ALL ON FUNCTION public.estudio_anuncios_pipeline_retomar(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.estudio_anuncios_pipeline_retomar(UUID) TO service_role;

COMMENT ON FUNCTION public.estudio_anuncios_pipeline_retomar(UUID) IS
  'Retoma um pipeline em erro criando UM job novo (append-only) da etapa que falhou, reaproveitando a origem do job falho. Preserva o job antigo, os resultados das etapas concluidas e etapa_atual. Idempotente: fora do status erro, ou havendo job pendente/rodando, devolve o estado atual com job_criado=false. Nao executa nada — quem processa e o cron. Restrita a service_role.';
