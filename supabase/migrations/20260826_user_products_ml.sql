-- ────────────────────────────────────────────────────────────────────
-- 20260826_user_products_ml.sql
--
-- MODELO DE PUBLICACAO do Mercado Livre (User Products vs legacy) e
-- `family_name`. NENHUM anuncio e criado.
--
-- ── Por que isto existe ─────────────────────────────────────────────
-- A validacao oficial real de 2026-08-25 respondeu
-- `body.required_fields ... [family_name]`. A documentacao oficial
-- (User Products, atualizada 19/12/2025) explica: sellers com a tag
-- `user_product_seller` publicam pelo modelo novo, em que **o title nao e
-- enviado pelo integrador** e `family_name` passa a ser obrigatorio.
-- Confirmado na conta real em 2026-08-26: `GET /users/744240004` devolveu
-- `tags: [... "user_product_seller" ...]`.
--
-- ── `modelo_publicacao` e resolvido, nunca presumido ─────────────────
-- Vem da tag em `/users/{seller_id}` com o token da conta — nao do erro
-- do `/items/validate`, que so diria que algo faltou. Guardamos as tags
-- cruas junto, para a decisao continuar auditavel depois de a conta
-- mudar de modelo. Nao e segunda fonte de verdade: a fonte e a API, isto
-- e o SNAPSHOT datado dela, e ele entra no hash do payload.
--
-- ── `family_name` mora aqui, e nao no conteudo editorial ────────────
-- Ele e configuracao de PUBLICACAO no Mercado Livre, nao texto de
-- anuncio: e o nome GENERICO da familia do produto, usado pelo ML para
-- agrupar variacoes. O titulo editorial continua existindo, aprovado e
-- versionado como sempre — a diferenca vive so no adapter de payload.
--
-- ── Sem limite de tamanho no banco ──────────────────────────────────
-- A documentacao e explicita: "The family_name that can be entered must
-- be less than or equal to the domain's max_title_length". Esse numero e
-- POR CATEGORIA/DOMINIO e vem da API (60 na categoria de teste). Um CHECK
-- com numero fixo congelaria um limite que nao e nosso.
--
-- Aditiva: nenhuma coluna removida, nenhuma constraint derrubada.
-- ────────────────────────────────────────────────────────────────────

ALTER TABLE public.estudio_anuncios_projetos_marketplace
  ADD COLUMN IF NOT EXISTS modelo_publicacao      TEXT,
  ADD COLUMN IF NOT EXISTS modelo_verificado_em   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS conta_tags             JSONB,
  ADD COLUMN IF NOT EXISTS family_name            TEXT;

-- Enum NOSSO (não do Mercado Livre): só dois valores, e eles descrevem
-- uma decisão interna de qual adapter usar. Diferente de condição/tipo de
-- anúncio, que são enums externos e por isso não têm CHECK.
ALTER TABLE public.estudio_anuncios_projetos_marketplace
  DROP CONSTRAINT IF EXISTS chk_pm_modelo_publicacao;
ALTER TABLE public.estudio_anuncios_projetos_marketplace
  ADD CONSTRAINT chk_pm_modelo_publicacao
  CHECK (modelo_publicacao IS NULL OR modelo_publicacao IN ('user_products', 'legacy'));

ALTER TABLE public.estudio_anuncios_projetos_marketplace
  DROP CONSTRAINT IF EXISTS chk_pm_modelo_com_snapshot;
ALTER TABLE public.estudio_anuncios_projetos_marketplace
  ADD CONSTRAINT chk_pm_modelo_com_snapshot
  CHECK (modelo_publicacao IS NULL OR modelo_verificado_em IS NOT NULL);

ALTER TABLE public.estudio_anuncios_projetos_marketplace
  DROP CONSTRAINT IF EXISTS chk_pm_conta_tags_array;
ALTER TABLE public.estudio_anuncios_projetos_marketplace
  ADD CONSTRAINT chk_pm_conta_tags_array
  CHECK (conta_tags IS NULL OR jsonb_typeof(conta_tags) = 'array');

COMMENT ON COLUMN public.estudio_anuncios_projetos_marketplace.modelo_publicacao IS
  'user_products quando a conta tem a tag `user_product_seller` em GET /users/{seller_id}; legacy caso contrario. RESOLVIDO pela API com o token da conta, nunca inferido do erro de /items/validate. Entra no hash do payload: mudar de modelo invalida a validacao oficial anterior.';
COMMENT ON COLUMN public.estudio_anuncios_projetos_marketplace.conta_tags IS
  'Snapshot datado das tags da conta no momento da resolucao — mantem auditavel POR QUE o modelo foi decidido assim.';
COMMENT ON COLUMN public.estudio_anuncios_projetos_marketplace.family_name IS
  'Nome GENERICO da familia do produto no modelo User Products. NAO e o titulo do anuncio: no modelo novo o titulo e montado pelo Mercado Livre e nao e enviado pelo integrador. Limite = max_title_length da categoria/dominio (vem da API, nunca fixo aqui). O titulo editorial nao e alterado por este campo.';

-- ────────────────────────────────────────────────────────────────────
-- RPC: gravar o modelo resolvido da conta
-- ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.estudio_anuncios_salvar_modelo_publicacao(
  p_projeto_marketplace_id UUID,
  p_modelo                 TEXT,
  p_tags                   JSONB
)
RETURNS public.estudio_anuncios_projetos_marketplace
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_canal public.estudio_anuncios_projetos_marketplace;
BEGIN
  IF p_modelo IS NULL OR p_modelo NOT IN ('user_products', 'legacy') THEN
    RAISE EXCEPTION 'MODELO_INVALIDO: %', p_modelo;
  END IF;
  IF p_tags IS NOT NULL AND jsonb_typeof(p_tags) <> 'array' THEN
    RAISE EXCEPTION 'TAGS_INVALIDAS';
  END IF;

  UPDATE public.estudio_anuncios_projetos_marketplace
     SET modelo_publicacao = p_modelo,
         conta_tags = p_tags,
         modelo_verificado_em = now(),
         atualizado_em = now()
   WHERE id = p_projeto_marketplace_id
  RETURNING * INTO v_canal;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CANAL_NAO_ENCONTRADO: %', p_projeto_marketplace_id;
  END IF;
  RETURN v_canal;
END;
$$;

COMMENT ON FUNCTION public.estudio_anuncios_salvar_modelo_publicacao IS
  'Grava o modelo de publicacao resolvido pela API do marketplace, junto com o snapshot das tags que sustentaram a decisao. NAO toca conteudo, imagens, Pipeline nem pareceres.';

REVOKE EXECUTE ON FUNCTION public.estudio_anuncios_salvar_modelo_publicacao(UUID, TEXT, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.estudio_anuncios_salvar_modelo_publicacao(UUID, TEXT, JSONB)
  TO service_role;

-- ────────────────────────────────────────────────────────────────────
-- RPC: gravar family_name
--
-- Separada da RPC de configuracao geral de propósito: aquela ja tem
-- assinatura fechada e reescreve-la exigiria DROP (operacao destrutiva).
-- Esta e pequena, focada e nao toca em nenhum outro campo.
-- ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.estudio_anuncios_salvar_family_name(
  p_projeto_id     UUID,
  p_marketplace    TEXT,
  p_family_name    TEXT,
  p_atualizado_por TEXT
)
RETURNS public.estudio_anuncios_projetos_marketplace
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_canal public.estudio_anuncios_projetos_marketplace;
BEGIN
  -- NULL limpa; string vazia nunca e gravada como "preenchido".
  IF p_family_name IS NOT NULL AND btrim(p_family_name) = '' THEN
    RAISE EXCEPTION 'FAMILY_NAME_VAZIO';
  END IF;

  UPDATE public.estudio_anuncios_projetos_marketplace
     SET family_name = CASE WHEN p_family_name IS NULL THEN NULL ELSE btrim(p_family_name) END,
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

COMMENT ON FUNCTION public.estudio_anuncios_salvar_family_name IS
  'Grava o family_name do canal (modelo User Products). Recusa string vazia; NULL limpa. Nao altera conteudo editorial nem qualquer outro campo de publicacao.';

REVOKE EXECUTE ON FUNCTION public.estudio_anuncios_salvar_family_name(UUID, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.estudio_anuncios_salvar_family_name(UUID, TEXT, TEXT, TEXT)
  TO service_role;
