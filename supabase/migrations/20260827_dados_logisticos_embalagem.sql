-- ────────────────────────────────────────────────────────────────────
-- 20260827_dados_logisticos_embalagem.sql
--
-- DADOS LOGISTICOS DA EMBALAGEM de envio. NENHUM anuncio e criado.
--
-- ── Por que isto existe ─────────────────────────────────────────────
-- A validacao oficial de 2026-08-26 respondeu:
--   item.attribute.missing.seller.package.dimensions
--   "The attributes [seller_package_height, seller_package_width,
--    seller_package_length, seller_package_weight] are all required"
--
-- ── Por que campos NOVOS, e nao reuso ───────────────────────────────
-- A auditoria de 2026-08-27 varreu TODO o schema atras de coluna de
-- peso/dimensao. Achou exatamente tres coisas, e nenhuma serve:
--   * `anuncios.peso_kg` — peso usado no calculo de frete de anuncios JA
--     PUBLICADOS (todas as linhas tem `ml_item_id`), sem vinculo com
--     projetos do Estudio;
--   * `estudio_anuncios_entradas_produto.peso` / `unidade_peso` /
--     `medidas` — atributos do PRODUTO;
--   * `imagens_*.altura_px` / `largura_px` — pixels de imagem.
-- Nao existe nenhuma tabela de logistica/embalagem no CDS.
--
-- ── PRODUTO ≠ EMBALAGEM, e isso e o ponto ───────────────────────────
-- Um produto de 20x10x5 cm e 300 g viaja numa caixa de 23x13x8 cm e
-- 420 g. Copiar `entradas_produto.peso` para `seller_package_weight`
-- **inventaria informacao logistica** — o peso da caixa inclui a propria
-- caixa, o enchimento e a fita. Por isso os campos sao proprios, ficam
-- em tabela diferente da ficha do produto, e NADA no codigo os deriva:
-- sao digitados por uma pessoa que sabe como o item e embalado.
--
-- ── UNIDADES: as do Mercado Livre, sem conversao ────────────────────
-- Confirmado na API real em 2026-08-27, em
-- `GET /categories/MLB425079/attributes`:
--   SELLER_PACKAGE_HEIGHT/WIDTH/LENGTH → value_type `number_unit`,
--     default_unit `cm`, **allowed_units: apenas `cm`**
--   SELLER_PACKAGE_WEIGHT              → value_type `number_unit`,
--     default_unit `g`,  **allowed_units: apenas `g`**
-- Entao guardamos exatamente nessas unidades: dimensoes em CENTIMETROS,
-- peso em GRAMAS. Nao ha conversao em lugar nenhum — nem no banco, nem
-- no adapter — e portanto nao ha onde perder precisao.
--
-- NUMERIC(10,2) e nao float: duas casas decimais sao exatas em NUMERIC, e
-- o valor viaja como string ate o atributo (`"23.5 cm"`).
--
-- Os quatro `SELLER_PACKAGE_*` sao `hierarchy: ITEM` e tag `hidden` —
-- podem ser enviados. Os `PACKAGE_*` (hierarchy FAMILY) sao `read_only`
-- e NAO devem ser enviados; o codigo nunca os monta.
--
-- Aditiva: nenhuma coluna removida, nenhuma constraint derrubada.
-- ────────────────────────────────────────────────────────────────────

ALTER TABLE public.estudio_anuncios_projetos_marketplace
  ADD COLUMN IF NOT EXISTS embalagem_peso_g          NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS embalagem_altura_cm       NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS embalagem_largura_cm      NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS embalagem_comprimento_cm  NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS embalagem_atualizada_em   TIMESTAMPTZ;

-- Invariante fisica, nao regra de marketplace: caixa nao tem lado zero
-- nem peso zero. Estavel — por isso vira CHECK.
ALTER TABLE public.estudio_anuncios_projetos_marketplace
  DROP CONSTRAINT IF EXISTS chk_pm_embalagem_positiva;
ALTER TABLE public.estudio_anuncios_projetos_marketplace
  ADD CONSTRAINT chk_pm_embalagem_positiva
  CHECK (
    (embalagem_peso_g IS NULL OR embalagem_peso_g > 0)
    AND (embalagem_altura_cm IS NULL OR embalagem_altura_cm > 0)
    AND (embalagem_largura_cm IS NULL OR embalagem_largura_cm > 0)
    AND (embalagem_comprimento_cm IS NULL OR embalagem_comprimento_cm > 0)
  );

COMMENT ON COLUMN public.estudio_anuncios_projetos_marketplace.embalagem_peso_g IS
  'Peso da EMBALAGEM DE ENVIO em GRAMAS — unidade exigida por SELLER_PACKAGE_WEIGHT (allowed_units: apenas g, verificado na API em 2026-08-27). NAO e o peso do produto: inclui caixa, enchimento e fita. Nunca derivado de entradas_produto.peso.';
COMMENT ON COLUMN public.estudio_anuncios_projetos_marketplace.embalagem_altura_cm IS
  'Altura da EMBALAGEM em CENTIMETROS — unidade exigida por SELLER_PACKAGE_HEIGHT (allowed_units: apenas cm). NAO e a altura do produto.';
COMMENT ON COLUMN public.estudio_anuncios_projetos_marketplace.embalagem_largura_cm IS
  'Largura da EMBALAGEM em CENTIMETROS — SELLER_PACKAGE_WIDTH. NAO e a largura do produto.';
COMMENT ON COLUMN public.estudio_anuncios_projetos_marketplace.embalagem_comprimento_cm IS
  'Comprimento da EMBALAGEM em CENTIMETROS — SELLER_PACKAGE_LENGTH. NAO e o comprimento do produto.';

-- ────────────────────────────────────────────────────────────────────
-- RPC: salvar dados logisticos
--
-- Separada das demais pelo mesmo motivo de `salvar_family_name`: as RPCs
-- existentes tem assinatura fechada, e reescreve-las exigiria DROP.
-- PATCH parcial por coalesce; NULL em `p_limpar` zera os quatro juntos —
-- meia embalagem nao existe.
-- ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.estudio_anuncios_salvar_embalagem(
  p_projeto_id       UUID,
  p_marketplace      TEXT,
  p_peso_g           NUMERIC,
  p_altura_cm        NUMERIC,
  p_largura_cm       NUMERIC,
  p_comprimento_cm   NUMERIC,
  p_limpar           BOOLEAN,
  p_atualizado_por   TEXT
)
RETURNS public.estudio_anuncios_projetos_marketplace
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_canal public.estudio_anuncios_projetos_marketplace;
BEGIN
  -- Revalida o que o TypeScript ja validou: parametro cru, sem sessao
  -- para confiar (Constituicao 27.3).
  IF NOT coalesce(p_limpar, false) THEN
    IF (p_peso_g IS NOT NULL AND p_peso_g <= 0)
       OR (p_altura_cm IS NOT NULL AND p_altura_cm <= 0)
       OR (p_largura_cm IS NOT NULL AND p_largura_cm <= 0)
       OR (p_comprimento_cm IS NOT NULL AND p_comprimento_cm <= 0) THEN
      RAISE EXCEPTION 'EMBALAGEM_VALOR_NAO_POSITIVO';
    END IF;
  END IF;

  UPDATE public.estudio_anuncios_projetos_marketplace
     SET embalagem_peso_g         = CASE WHEN coalesce(p_limpar, false) THEN NULL
                                         ELSE coalesce(p_peso_g, embalagem_peso_g) END,
         embalagem_altura_cm      = CASE WHEN coalesce(p_limpar, false) THEN NULL
                                         ELSE coalesce(p_altura_cm, embalagem_altura_cm) END,
         embalagem_largura_cm     = CASE WHEN coalesce(p_limpar, false) THEN NULL
                                         ELSE coalesce(p_largura_cm, embalagem_largura_cm) END,
         embalagem_comprimento_cm = CASE WHEN coalesce(p_limpar, false) THEN NULL
                                         ELSE coalesce(p_comprimento_cm, embalagem_comprimento_cm) END,
         embalagem_atualizada_em  = CASE WHEN coalesce(p_limpar, false) THEN NULL ELSE now() END,
         publicacao_atualizada_em = now(),
         publicacao_atualizada_por = p_atualizado_por,
         atualizado_em = now()
   WHERE projeto_id = p_projeto_id AND marketplace = p_marketplace
  RETURNING * INTO v_canal;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CANAL_NAO_ENCONTRADO: % / %', p_projeto_id, p_marketplace;
  END IF;
  RETURN v_canal;
END;
$$;

COMMENT ON FUNCTION public.estudio_anuncios_salvar_embalagem IS
  'Grava peso e dimensoes da EMBALAGEM DE ENVIO (g e cm, unidades do Mercado Livre). Recusa valor <= 0. Nao deriva nada do produto e nao toca conteudo, imagens, Pipeline, score ou pareceres.';

REVOKE EXECUTE ON FUNCTION public.estudio_anuncios_salvar_embalagem(UUID, TEXT, NUMERIC, NUMERIC, NUMERIC, NUMERIC, BOOLEAN, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.estudio_anuncios_salvar_embalagem(UUID, TEXT, NUMERIC, NUMERIC, NUMERIC, NUMERIC, BOOLEAN, TEXT)
  TO service_role;
