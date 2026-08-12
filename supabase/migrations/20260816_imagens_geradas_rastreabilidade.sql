-- ────────────────────────────────────────────────────────────────────
-- 20260816_imagens_geradas_rastreabilidade.sql
--
-- Prepara estudio_anuncios_imagens_geradas para receber a saida real de
-- geracao_imagem. A tabela existe desde 20260803, mas foi desenhada
-- antes do Pipeline por job/prompt e nao consegue registrar de onde a
-- imagem veio nem validar o arquivo.
--
-- LACUNAS ENCONTRADAS NA AUDITORIA (2026-08-16), todas aditivas:
--   1. Sem `job_id`  -> impossivel saber qual job produziu a imagem, e
--      impossivel dar idempotencia por job (todas as outras tabelas do
--      modulo ja tem job_id).
--   2. Sem `prompt_ordem` -> impossivel associar a imagem ao prompt que
--      a originou (o envelope de geracao_prompts_imagem numera os
--      prompts de 1..N).
--   3. Sem `mime_type`, `largura_px`, `altura_px`, `tamanho_bytes` ->
--      impossivel provar que o arquivo e valido, do formato certo e na
--      proporcao certa. `estudio_anuncios_imagens_origem` ja tem os
--      quatro; a tabela de saida nao tinha nenhum.
--   4. Sem `provedor`/`modelo` -> impossivel auditar divergencia entre o
--      que foi cobrado (central_ia_consumo) e o que foi gravado.
--
-- COLISAO REAL DO UNIQUE EXISTENTE. O unico (projeto_id, finalidade,
-- numero_versao) impediria duas imagens da MESMA finalidade no mesmo
-- job -- e o contrato de geracao_prompts_imagem permite exatamente isso
-- (ex.: dois prompts do tipo `detalhes`). A constraint NAO e removida:
-- o codigo passa a atribuir `numero_versao` como o indice 1-based da
-- imagem dentro da sua propria finalidade NAQUELE job, o que mantem a
-- constraint valida e ainda preserva o sentido original da coluna
-- (versao daquela finalidade no projeto).
--
-- IDEMPOTENCIA NO BANCO, NAO SO EM TYPESCRIPT. O novo indice unico
-- (job_id, prompt_ordem) e a garantia real de que um retry -- ou dois
-- Workers concorrentes -- nunca criam duas linhas para o mesmo prompt.
-- O claim do job ja serializa na pratica, mas a Constituicao exige que
-- a unicidade nao dependa so de logica de aplicacao.
--
-- Nenhuma coluna e removida, nenhuma constraint e derrubada, nenhum dado
-- e alterado. A tabela esta vazia (0 linhas em 2026-08-16).
-- ────────────────────────────────────────────────────────────────────

ALTER TABLE public.estudio_anuncios_imagens_geradas
  ADD COLUMN IF NOT EXISTS job_id        UUID REFERENCES public.estudio_anuncios_jobs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS prompt_ordem  INTEGER,
  ADD COLUMN IF NOT EXISTS mime_type     TEXT,
  ADD COLUMN IF NOT EXISTS largura_px    INTEGER,
  ADD COLUMN IF NOT EXISTS altura_px     INTEGER,
  ADD COLUMN IF NOT EXISTS tamanho_bytes BIGINT,
  ADD COLUMN IF NOT EXISTS provedor      TEXT,
  ADD COLUMN IF NOT EXISTS modelo        TEXT;

-- MIME: mesmo conjunto do bucket `estudio-anuncios-gerado` e da tabela
-- de fotos originais. NULL continua aceito para as linhas antigas
-- (nao ha nenhuma hoje) e para o caminho fake.
ALTER TABLE public.estudio_anuncios_imagens_geradas
  DROP CONSTRAINT IF EXISTS chk_imagens_geradas_mime;
ALTER TABLE public.estudio_anuncios_imagens_geradas
  ADD CONSTRAINT chk_imagens_geradas_mime
  CHECK (mime_type IS NULL OR mime_type IN ('image/jpeg', 'image/png', 'image/webp'));

ALTER TABLE public.estudio_anuncios_imagens_geradas
  DROP CONSTRAINT IF EXISTS chk_imagens_geradas_dimensoes;
ALTER TABLE public.estudio_anuncios_imagens_geradas
  ADD CONSTRAINT chk_imagens_geradas_dimensoes
  CHECK (
    (largura_px IS NULL OR largura_px > 0)
    AND (altura_px IS NULL OR altura_px > 0)
    AND (tamanho_bytes IS NULL OR tamanho_bytes > 0)
  );

ALTER TABLE public.estudio_anuncios_imagens_geradas
  DROP CONSTRAINT IF EXISTS chk_imagens_geradas_prompt_ordem;
ALTER TABLE public.estudio_anuncios_imagens_geradas
  ADD CONSTRAINT chk_imagens_geradas_prompt_ordem
  CHECK (prompt_ordem IS NULL OR prompt_ordem > 0);

-- Mesmo CHECK de provedor ja usado em jobs/resultados_pipeline/consumo.
ALTER TABLE public.estudio_anuncios_imagens_geradas
  DROP CONSTRAINT IF EXISTS chk_imagens_geradas_provedor;
ALTER TABLE public.estudio_anuncios_imagens_geradas
  ADD CONSTRAINT chk_imagens_geradas_provedor
  CHECK (provedor IS NULL OR provedor IN ('openai', 'anthropic', 'google', 'fake', 'internal'));

-- Garantia de idempotencia/concorrencia no BANCO: 1 imagem por
-- (job, prompt). Parcial para nao afetar linhas sem job_id.
CREATE UNIQUE INDEX IF NOT EXISTS idx_imagens_geradas_job_prompt
  ON public.estudio_anuncios_imagens_geradas (job_id, prompt_ordem)
  WHERE job_id IS NOT NULL AND prompt_ordem IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_imagens_geradas_job
  ON public.estudio_anuncios_imagens_geradas (job_id)
  WHERE job_id IS NOT NULL;

-- storage_path unico: impede que dois registros apontem para o mesmo
-- objeto e que um job sobrescreva o arquivo de outro.
CREATE UNIQUE INDEX IF NOT EXISTS idx_imagens_geradas_storage_path
  ON public.estudio_anuncios_imagens_geradas (storage_path)
  WHERE storage_path IS NOT NULL;

COMMENT ON COLUMN public.estudio_anuncios_imagens_geradas.job_id IS
  'Job de geracao_imagem que produziu esta imagem. Junto de prompt_ordem forma a chave de idempotencia (idx_imagens_geradas_job_prompt).';
COMMENT ON COLUMN public.estudio_anuncios_imagens_geradas.prompt_ordem IS
  'Campo `ordem` do prompt correspondente no envelope de geracao_prompts_imagem (1..N). Liga a imagem ao prompt exato que a originou.';
COMMENT ON COLUMN public.estudio_anuncios_imagens_geradas.numero_versao IS
  'Indice 1-based desta imagem dentro da sua propria finalidade no job. Mantem valido o unique (projeto_id, finalidade, numero_versao) quando o job produz mais de uma imagem da mesma finalidade.';
