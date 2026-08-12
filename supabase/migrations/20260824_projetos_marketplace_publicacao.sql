-- ────────────────────────────────────────────────────────────────────
-- 20260824_projetos_marketplace_publicacao.sql
--
-- DADOS DE PUBLICACAO por canal, em
-- `estudio_anuncios_projetos_marketplace`.
--
-- POR QUE AQUI E NAO NO PROJETO. Sao dados ESPECIFICOS DO MARKETPLACE:
-- categoria, condicao e tipo de anuncio nem existem fora do Mercado
-- Livre, e preco/estoque podem legitimamente diferir entre canais do
-- MESMO produto. Guardar no projeto obrigaria todo canal a compartilhar
-- o mesmo valor -- decisao que nada no dominio sustenta.
--
-- POR QUE COLUNAS NOVAS E NAO REUSO DE `anuncios`. A auditoria de
-- 2026-08-24 mostrou que `anuncios` (a tabela de precificacao da
-- Calculadora) tem `preco_anuncio`/`preco_ideal`, mas **todas as 1.533
-- linhas tem `ml_item_id` preenchido**: ela so contem anuncios JA
-- PUBLICADOS e importados dos marketplaces. Nao existe nenhuma coluna ou
-- FK ligando `estudio_anuncios_projetos` a `anuncios`, e um projeto do
-- Estudio e por definicao um produto que ainda nao foi publicado.
-- Reutilizar aquela tabela exigiria inventar um vinculo por nome de
-- produto -- heuristica que a arquitetura proibe. **Nao ha fonte oficial
-- de preco para um produto novo**, entao a fonte passa a ser esta.
-- ESTOQUE nao existe em NENHUMA tabela do CDS hoje (a unica coluna
-- parecida, `entradas_produto.quantidade`, e "unidades por embalagem").
--
-- PRECO EM CENTAVOS (BIGINT), nao NUMERIC. `anuncios` usa NUMERIC porque
-- recebe valores calculados e importados; aqui o valor e digitado por uma
-- pessoa e viaja por JSON ate o navegador, onde NUMERIC vira float e
-- perde centavo. Inteiro de centavos e exato ponta a ponta e e o que a
-- camada de compliance ja consome (`precoCentavos`). Nenhum float em
-- nenhum ponto do caminho.
--
-- CHECKS SO PARA INVARIANTE ESTAVEL. `preco_centavos > 0` e
-- `estoque >= 0` sao propriedades do dominio e nao mudam. `condicao`,
-- `tipo_anuncio_id` e `moeda` sao **enums externos do Mercado Livre**,
-- que mudam sem aviso: congela-los em CHECK transformaria uma mudanca
-- deles num erro de banco. A validacao deles e server-side, contra a API
-- oficial (condicao e moeda) ou contra a documentacao oficial
-- (tipo de anuncio) -- ver `compliance/ml-catalogo.ts`.
--
-- CATEGORIA VALIDADA DE VERDADE. `category_id` so e gravado depois de
-- `GET /categories/{id}` responder 200 na API publica do Mercado Livre
-- (endpoint que NAO exige OAuth, verificado em 2026-08-24). Junto vem
-- `categoria_settings`, o snapshot oficial com `max_title_length`,
-- `item_conditions`, `currencies`, `max_pictures_per_item`,
-- `listing_allowed` e `status` -- e sao esses valores REAIS que o
-- compliance passa a usar, em vez de "nao verificavel".
--
-- Aditiva: nenhuma coluna removida, nenhuma constraint derrubada, nenhum
-- dado alterado. Fase 1, camada editorial, exportacao e pareceres de
-- compliance ja gravados nao sao tocados.
-- ────────────────────────────────────────────────────────────────────

ALTER TABLE public.estudio_anuncios_projetos_marketplace
  ADD COLUMN IF NOT EXISTS category_id              TEXT,
  ADD COLUMN IF NOT EXISTS categoria_nome           TEXT,
  ADD COLUMN IF NOT EXISTS categoria_caminho        TEXT,
  ADD COLUMN IF NOT EXISTS categoria_settings       JSONB,
  ADD COLUMN IF NOT EXISTS categoria_atributos      JSONB,
  ADD COLUMN IF NOT EXISTS categoria_verificada_em  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS condicao                 TEXT,
  ADD COLUMN IF NOT EXISTS tipo_anuncio_id          TEXT,
  ADD COLUMN IF NOT EXISTS moeda                    TEXT,
  ADD COLUMN IF NOT EXISTS preco_centavos           BIGINT,
  ADD COLUMN IF NOT EXISTS estoque                  INTEGER,
  ADD COLUMN IF NOT EXISTS atributos_marketplace    JSONB,
  ADD COLUMN IF NOT EXISTS publicacao_atualizada_em TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS publicacao_atualizada_por TEXT;

ALTER TABLE public.estudio_anuncios_projetos_marketplace
  DROP CONSTRAINT IF EXISTS chk_pm_preco_positivo;
ALTER TABLE public.estudio_anuncios_projetos_marketplace
  ADD CONSTRAINT chk_pm_preco_positivo
  CHECK (preco_centavos IS NULL OR preco_centavos > 0);

ALTER TABLE public.estudio_anuncios_projetos_marketplace
  DROP CONSTRAINT IF EXISTS chk_pm_estoque_nao_negativo;
ALTER TABLE public.estudio_anuncios_projetos_marketplace
  ADD CONSTRAINT chk_pm_estoque_nao_negativo
  CHECK (estoque IS NULL OR estoque >= 0);

-- Um `category_id` gravado sem o snapshot oficial significaria categoria
-- aceita sem verificacao -- exatamente o que esta etapa existe para
-- impedir. Os tres andam juntos ou nenhum existe.
ALTER TABLE public.estudio_anuncios_projetos_marketplace
  DROP CONSTRAINT IF EXISTS chk_pm_categoria_verificada;
ALTER TABLE public.estudio_anuncios_projetos_marketplace
  ADD CONSTRAINT chk_pm_categoria_verificada
  CHECK (
    category_id IS NULL
    OR (categoria_settings IS NOT NULL AND categoria_verificada_em IS NOT NULL)
  );

ALTER TABLE public.estudio_anuncios_projetos_marketplace
  DROP CONSTRAINT IF EXISTS chk_pm_atributos_array;
ALTER TABLE public.estudio_anuncios_projetos_marketplace
  ADD CONSTRAINT chk_pm_atributos_array
  CHECK (atributos_marketplace IS NULL OR jsonb_typeof(atributos_marketplace) = 'array');

COMMENT ON COLUMN public.estudio_anuncios_projetos_marketplace.category_id IS
  'category_id REAL do marketplace, gravado apenas apos verificacao contra a API oficial publica (GET /categories/{id}). Nunca aceita string arbitraria; a categoria textual da IA e da ficha e texto livre e NUNCA vira category_id.';
COMMENT ON COLUMN public.estudio_anuncios_projetos_marketplace.categoria_settings IS
  'Snapshot oficial de settings da categoria (max_title_length, max_description_length, max_pictures_per_item, currencies, item_conditions, listing_allowed, status). E a fonte que o compliance usa para validar limites que sao POR CATEGORIA -- entra no hash do parecer, entao mudanca de settings gera parecer novo.';
COMMENT ON COLUMN public.estudio_anuncios_projetos_marketplace.categoria_atributos IS
  'Atributos OBRIGATORIOS da categoria (GET /categories/{id}/attributes, tag required). Depois de resolver a categoria, o compliance descobre pendencias reais de atributo -- BRAND, MODEL, GTIN etc. Nenhum valor e inventado.';
COMMENT ON COLUMN public.estudio_anuncios_projetos_marketplace.preco_centavos IS
  'Preco de publicacao em CENTAVOS (inteiro exato). Nao usa NUMERIC porque o valor viaja por JSON ate o navegador, onde decimal vira float e perde centavo. Nao ha conversao de moeda em nenhum ponto.';
COMMENT ON COLUMN public.estudio_anuncios_projetos_marketplace.moeda IS
  'Derivada de categoria_settings.currencies pelo servidor -- nunca digitada. Sem categoria resolvida, fica NULL.';
COMMENT ON COLUMN public.estudio_anuncios_projetos_marketplace.estoque IS
  'Estoque de publicacao. Nao existe fonte de estoque em nenhuma outra tabela do CDS; entradas_produto.quantidade e "unidades por embalagem" e NAO e usada aqui.';

-- ────────────────────────────────────────────────────────────────────
-- RPC: salvar dados de publicacao (atomica)
--
-- Por que RPC e nao UPDATE solto: a operacao precisa, na MESMA transacao,
-- (a) confirmar que o canal pertence ao projeto informado -- a rota ja
-- checou, mas a RPC recebe parametro cru e nao tem sessao para confiar
-- (Constituicao 27.3); (b) aplicar so os campos enviados, preservando os
-- demais; e (c) manter categoria e seu snapshot sempre coerentes.
--
-- COALESCE por campo implementa o PATCH parcial: campo ausente (NULL no
-- parametro) preserva o valor atual. Para LIMPAR a categoria existe um
-- parametro dedicado, em vez de sobrecarregar NULL com dois significados.
-- ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.estudio_anuncios_salvar_publicacao_marketplace(
  p_projeto_id            UUID,
  p_marketplace           TEXT,
  p_category_id           TEXT,
  p_categoria_nome        TEXT,
  p_categoria_caminho     TEXT,
  p_categoria_settings    JSONB,
  p_categoria_atributos   JSONB,
  p_moeda                 TEXT,
  p_condicao              TEXT,
  p_tipo_anuncio_id       TEXT,
  p_preco_centavos        BIGINT,
  p_estoque               INTEGER,
  p_atributos_marketplace JSONB,
  p_limpar_categoria      BOOLEAN,
  p_atualizado_por        TEXT
)
RETURNS public.estudio_anuncios_projetos_marketplace
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_canal public.estudio_anuncios_projetos_marketplace;
BEGIN
  SELECT * INTO v_canal
  FROM public.estudio_anuncios_projetos_marketplace
  WHERE projeto_id = p_projeto_id AND marketplace = p_marketplace
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CANAL_NAO_ENCONTRADO: % / %', p_projeto_id, p_marketplace;
  END IF;

  -- Categoria so entra com o snapshot junto: gravar o id sem os settings
  -- seria aceitar categoria sem verificacao.
  IF p_category_id IS NOT NULL AND p_categoria_settings IS NULL THEN
    RAISE EXCEPTION 'CATEGORIA_SEM_SNAPSHOT_OFICIAL';
  END IF;

  UPDATE public.estudio_anuncios_projetos_marketplace
     SET category_id             = CASE WHEN p_limpar_categoria THEN NULL
                                        ELSE coalesce(p_category_id, category_id) END,
         categoria_nome          = CASE WHEN p_limpar_categoria THEN NULL
                                        ELSE coalesce(p_categoria_nome, categoria_nome) END,
         categoria_caminho       = CASE WHEN p_limpar_categoria THEN NULL
                                        ELSE coalesce(p_categoria_caminho, categoria_caminho) END,
         categoria_settings      = CASE WHEN p_limpar_categoria THEN NULL
                                        ELSE coalesce(p_categoria_settings, categoria_settings) END,
         categoria_atributos     = CASE WHEN p_limpar_categoria THEN NULL
                                        ELSE coalesce(p_categoria_atributos, categoria_atributos) END,
         categoria_verificada_em = CASE WHEN p_limpar_categoria THEN NULL
                                        WHEN p_category_id IS NOT NULL THEN now()
                                        ELSE categoria_verificada_em END,
         -- A moeda acompanha a categoria: sem categoria nao ha moeda
         -- oficial de onde derivar.
         moeda                   = CASE WHEN p_limpar_categoria THEN NULL
                                        ELSE coalesce(p_moeda, moeda) END,
         condicao                = coalesce(p_condicao, condicao),
         tipo_anuncio_id         = coalesce(p_tipo_anuncio_id, tipo_anuncio_id),
         preco_centavos          = coalesce(p_preco_centavos, preco_centavos),
         estoque                 = coalesce(p_estoque, estoque),
         atributos_marketplace   = coalesce(p_atributos_marketplace, atributos_marketplace),
         publicacao_atualizada_em  = now(),
         publicacao_atualizada_por = p_atualizado_por,
         atualizado_em             = now()
   WHERE id = v_canal.id
  RETURNING * INTO v_canal;

  RETURN v_canal;
END;
$$;

COMMENT ON FUNCTION public.estudio_anuncios_salvar_publicacao_marketplace IS
  'Salva os dados de publicacao de UM canal, sob FOR UPDATE. PATCH parcial via coalesce: campo nao enviado preserva o valor atual. Recusa gravar category_id sem o snapshot oficial de settings. NUNCA toca em conteudo, imagens, Pipeline, score ou pareceres de compliance.';

REVOKE EXECUTE ON FUNCTION public.estudio_anuncios_salvar_publicacao_marketplace(UUID, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, TEXT, TEXT, TEXT, BIGINT, INTEGER, JSONB, BOOLEAN, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.estudio_anuncios_salvar_publicacao_marketplace(UUID, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, TEXT, TEXT, TEXT, BIGINT, INTEGER, JSONB, BOOLEAN, TEXT)
  TO service_role;
