-- ────────────────────────────────────────────────────────────────────
-- 20260818_consumo_tokens_saida_imagem.sql
--
-- Adiciona `central_ia_consumo.tokens_saida_imagem`.
--
-- POR QUE UMA COLUNA NOVA E NAO SO O CUSTO. Ate 2026-08-17 toda a
-- Central de IA assumia UMA taxa de saida por modelo -- verdade para
-- todo modelo de texto. O modelo de imagem em uso quebra isso: a
-- documentacao oficial do Google (consultada em 2026-08-18, tier
-- Standard) cobra `gemini-3.1-flash-image` com DUAS taxas de saida,
-- $3 por 1M para texto/thinking e $60 por 1M para imagem.
--
-- Com so `tokens_saida` (total) na linha, `custo_estimado` deixa de ser
-- RE-DERIVAVEL: nao ha como saber quanto daquele total foi cobrado a
-- $60. Auditar custo passaria a depender de confiar no numero gravado,
-- que e exatamente o que a instrumentacao deveria eliminar. Com esta
-- coluna, a conferencia e aritmetica pura:
--
--   custo = entrada/1e6 * 0.50
--         + (saida - saida_imagem)/1e6 * 3
--         + saida_imagem/1e6 * 60
--
-- Aditiva e nullable: NULL significa "modelo de saida unica" (todas as
-- linhas existentes, e todas as etapas de texto daqui pra frente).
-- Nenhuma coluna removida, nenhuma constraint derrubada, nenhum dado
-- alterado.
-- ────────────────────────────────────────────────────────────────────

ALTER TABLE public.central_ia_consumo
  ADD COLUMN IF NOT EXISTS tokens_saida_imagem INTEGER;

ALTER TABLE public.central_ia_consumo
  DROP CONSTRAINT IF EXISTS chk_consumo_tokens_saida_imagem;
ALTER TABLE public.central_ia_consumo
  ADD CONSTRAINT chk_consumo_tokens_saida_imagem
  CHECK (
    tokens_saida_imagem IS NULL
    OR (tokens_saida_imagem >= 0 AND (tokens_saida IS NULL OR tokens_saida_imagem <= tokens_saida))
  );

COMMENT ON COLUMN public.central_ia_consumo.tokens_saida_imagem IS
  'Subconjunto de tokens_saida cobrado na taxa de IMAGEM (modelos com duas taxas de saida). NULL = modelo de saida unica. Vem de usage.output_tokens_by_modality, reportado pela API -- nunca estimado.';
