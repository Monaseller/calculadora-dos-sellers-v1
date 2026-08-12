-- ────────────────────────────────────────────────────────────────────
-- 20260830_pictures_mercado_livre.sql
--
-- MAPA imagem do Estudio -> picture id do Mercado Livre.
-- NENHUM anuncio e criado por esta migration nem pelo codigo que a usa.
--
-- ── Por que existe ──────────────────────────────────────────────────
-- A auditoria de 2026-08-30 varreu as 18 tabelas do modulo: NENHUMA
-- guarda identificador de recurso criado do lado do marketplace.
--   * `imagens_geradas` — nosso Storage, nao o CDN do ML;
--   * `validacoes_publicacao` — parecer do ML sobre um payload, nao
--     recurso persistente;
--   * `pacotes_exportacao` — arquivo nosso.
-- Entao a tabela e nova, e nao duplica nada.
--
-- ── A IDENTIDADE INCLUI O CHECKSUM, e esse e o ponto ────────────────
-- A chave e (loja_id, imagem_gerada_id, checksum_sha256). Sem o
-- checksum, trocar os BYTES mantendo o mesmo `imagem_gerada_id`
-- reaproveitaria um `ml_picture_id` que aponta para a imagem ANTIGA no
-- CDN do Mercado Livre — publicar-se-ia uma foto que ninguem aprovou, e
-- em silencio. Com o checksum na chave, bytes novos sao identidade nova
-- e exigem upload novo.
--
-- `loja_id` entra porque o picture id e da CONTA: o mesmo arquivo subido
-- por duas contas gera dois ids, e um nao serve para a outra.
--
-- ── APPEND-ONLY ─────────────────────────────────────────────────────
-- Nunca UPDATE, nunca DELETE. "Qual imagem estava no anuncio em agosto?"
-- so tem resposta se a linha daquele checksum sobreviver a troca de
-- imagem. O historico e o produto.
--
-- ── NAO ATOMICIDADE ENTRE O ML E O POSTGRES ─────────────────────────
-- Subir no ML e gravar aqui sao duas operacoes em dois sistemas. Se duas
-- requisicoes concorrentes subirem a MESMA imagem, o ML devolve dois
-- picture ids diferentes e so um vence o UNIQUE. O perdedor vira um
-- recurso ORFAO no CDN do Mercado Livre: nao referenciado, inofensivo, e
-- **reportado** em vez de escondido. Fingir transacao distribuida aqui
-- seria mentira.
-- ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.estudio_anuncios_pictures_marketplace (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loja_id           UUID NOT NULL REFERENCES public.lojas(id) ON DELETE CASCADE,
  marketplace       TEXT NOT NULL,
  projeto_id        UUID NOT NULL REFERENCES public.estudio_anuncios_projetos(id) ON DELETE CASCADE,
  imagem_gerada_id  UUID NOT NULL REFERENCES public.estudio_anuncios_imagens_geradas(id) ON DELETE CASCADE,
  -- Identidade dos BYTES. 64 hex de sha256, conferido antes do upload.
  checksum_sha256   TEXT NOT NULL,
  -- O que o Mercado Livre devolveu.
  ml_picture_id     TEXT NOT NULL,
  ml_max_size       TEXT,
  ml_dominant_color TEXT,
  -- Metadado tecnico bruto da resposta, para auditoria. NUNCA credencial.
  resposta_ml       JSONB,
  criado_em         TIMESTAMPTZ NOT NULL DEFAULT now(),
  criado_por        TEXT,

  CONSTRAINT chk_pic_marketplace CHECK (marketplace IN ('ML', 'SHOPEE', 'AMAZON', 'TIKTOK')),
  CONSTRAINT chk_pic_checksum CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_pic_ml_id CHECK (length(btrim(ml_picture_id)) > 0),
  -- Recusa qualquer texto que cheire a credencial. Mesma protecao que a
  -- tabela de validacoes ja tem: metadado de imagem nunca precisa disso.
  CONSTRAINT chk_pic_sem_credencial CHECK (
    resposta_ml IS NULL OR (
      resposta_ml::text NOT ILIKE '%access_token%'
      AND resposta_ml::text NOT ILIKE '%refresh_token%'
      AND resposta_ml::text NOT ILIKE '%client_secret%'
      AND resposta_ml::text NOT ILIKE '%bearer %'
    )
  )
);

-- A CHAVE da idempotencia. Tres requests concorrentes com a mesma
-- identidade produzem UMA linha; os uploads perdedores viram orfaos no
-- CDN do ML e sao reportados.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pictures_ml_identidade
  ON public.estudio_anuncios_pictures_marketplace (loja_id, imagem_gerada_id, checksum_sha256);

CREATE INDEX IF NOT EXISTS idx_pictures_ml_projeto
  ON public.estudio_anuncios_pictures_marketplace (projeto_id, marketplace);

COMMENT ON TABLE public.estudio_anuncios_pictures_marketplace IS
  'Mapa append-only imagem do Estudio -> picture id do Mercado Livre. Identidade = (loja, imagem, CHECKSUM dos bytes): bytes novos exigem upload novo, para nunca reaproveitar um id que aponta para a imagem antiga no CDN. Nao guarda token nem URL assinada.';
COMMENT ON COLUMN public.estudio_anuncios_pictures_marketplace.checksum_sha256 IS
  'sha256 dos BYTES enviados ao Mercado Livre, conferido imediatamente antes do upload. Faz parte da identidade — nao e metadado decorativo.';

-- ────────────────────────────────────────────────────────────────────
-- RPC: registrar o picture id.
--
-- INSERT puro com ON CONFLICT DO NOTHING e RETURN da linha VENCEDORA,
-- seja ela a nossa ou a de quem chegou antes. O chamador compara o
-- `ml_picture_id` devolvido com o que ele acabou de subir: se diferirem,
-- o dele ficou orfao no ML e isso e reportado.
-- ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.estudio_anuncios_registrar_picture_ml(
  p_loja_id           UUID,
  p_marketplace       TEXT,
  p_projeto_id        UUID,
  p_imagem_gerada_id  UUID,
  p_checksum          TEXT,
  p_ml_picture_id     TEXT,
  p_max_size          TEXT,
  p_dominant_color    TEXT,
  p_resposta          JSONB,
  p_criado_por        TEXT
)
RETURNS public.estudio_anuncios_pictures_marketplace
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_linha public.estudio_anuncios_pictures_marketplace;
BEGIN
  -- A imagem precisa ser DO PROJETO informado. Revalida no banco o que o
  -- TypeScript ja validou: parametro cru nao se confia (Constituicao 27.3).
  IF NOT EXISTS (
    SELECT 1 FROM public.estudio_anuncios_imagens_geradas
     WHERE id = p_imagem_gerada_id AND projeto_id = p_projeto_id
  ) THEN
    RAISE EXCEPTION 'IMAGEM_NAO_PERTENCE_AO_PROJETO: % / %', p_imagem_gerada_id, p_projeto_id;
  END IF;

  INSERT INTO public.estudio_anuncios_pictures_marketplace (
    loja_id, marketplace, projeto_id, imagem_gerada_id, checksum_sha256,
    ml_picture_id, ml_max_size, ml_dominant_color, resposta_ml, criado_por
  ) VALUES (
    p_loja_id, p_marketplace, p_projeto_id, p_imagem_gerada_id, p_checksum,
    p_ml_picture_id, p_max_size, p_dominant_color, p_resposta, p_criado_por
  )
  ON CONFLICT (loja_id, imagem_gerada_id, checksum_sha256) DO NOTHING
  RETURNING * INTO v_linha;

  -- Perdeu a corrida: devolve a linha de quem chegou antes. O upload
  -- desta chamada fica orfao no CDN do ML — o chamador reporta.
  IF v_linha IS NULL THEN
    SELECT * INTO v_linha
      FROM public.estudio_anuncios_pictures_marketplace
     WHERE loja_id = p_loja_id
       AND imagem_gerada_id = p_imagem_gerada_id
       AND checksum_sha256 = p_checksum;
  END IF;

  RETURN v_linha;
END;
$$;

COMMENT ON FUNCTION public.estudio_anuncios_registrar_picture_ml IS
  'Registra o picture id do Mercado Livre de forma idempotente por (loja, imagem, checksum). INSERT puro: nunca UPDATE, nunca DELETE. Devolve sempre a linha vencedora, permitindo ao chamador detectar upload orfao em concorrencia.';

REVOKE EXECUTE ON FUNCTION public.estudio_anuncios_registrar_picture_ml(UUID, TEXT, UUID, UUID, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.estudio_anuncios_registrar_picture_ml(UUID, TEXT, UUID, UUID, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT)
  TO service_role;

ALTER TABLE public.estudio_anuncios_pictures_marketplace ENABLE ROW LEVEL SECURITY;
