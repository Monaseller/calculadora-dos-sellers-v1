-- ────────────────────────────────────────────────────────────────────
-- 20260828_embalagem_inteiros.sql
--
-- O DOMINIO DAS MEDIDAS DE EMBALAGEM PASSA A SER INTEIRO.
-- NENHUM anuncio e criado. NENHUM dado e arredondado.
--
-- ── Por que ─────────────────────────────────────────────────────────
-- Evidencia real de POST /items/validate em 2026-08-27, enviando
-- largura "13.5 cm":
--   item.attribute.invalid.format.seller.package.dimensions
--   "The attributes [seller_package_width] are in the wrong format -
--    Only integers are accepted for dimensions and weight, with
--    centimeters 'cm' as the unit for dimensions and grams 'g' as the
--    unit for weight. Examples: 10 cm, 100 g"
-- Reenviando "13 cm" o erro sumiu por completo, o que isola a causa.
--
-- Ou seja: NUMERIC(10,2) modelava um dominio que nao existe. Guardar
-- 13.5 e enviar 13 seria gravar um numero e publicar outro; guardar 13.5
-- e enviar 13.5 e uma submissao que o ML recusa. As duas saidas sao
-- ruins, e por isso o dominio muda no banco em vez de virar
-- arredondamento no adapter.
--
-- ── AUDITORIA ANTES DE MEXER (2026-08-28) ───────────────────────────
-- Rodada contra o banco real antes desta migration:
--   * 27 linhas em projetos_marketplace; 1 com embalagem preenchida;
--   * decimais persistidos: 0 (peso, altura, largura e comprimento);
--   * a unica linha e do projeto TESTE_REVISAO_CLAUDE_REAL_20260814
--     (status `cancelado`) — dado exclusivamente de teste;
--   * maiores valores: 420 g, 8 cm, 13 cm, 23 cm.
-- Nenhuma conversao com perda acontece aqui. Ainda assim a migration NAO
-- confia nessa foto: o bloco abaixo RECUSA rodar se encontrar decimal,
-- em vez de arredondar em silencio.
--
-- ── Tipo escolhido ──────────────────────────────────────────────────
-- INTEGER. Uma embalagem de 30 kg sao 30.000 g, e a maior dimensao
-- plausivel esta na casa das centenas de cm — ambos folgadissimos dentro
-- de ±2.147.483.647. BIGINT so gastaria espaco sem comprar nada.
--
-- ── Por que os parametros da RPC continuam NUMERIC ──────────────────
-- ISTO E DELIBERADO E E O PONTO MAIS IMPORTANTE DESTE ARQUIVO.
-- Se o parametro fosse INTEGER, o Postgres converteria 13.5 para 14
-- SOZINHO, no cast — exatamente o arredondamento silencioso que a tarefa
-- proibe, e sem deixar rastro. Mantendo NUMERIC, o valor chega como veio
-- e a funcao pode RECUSA-LO com erro proprio. A assinatura tambem
-- permanece a mesma, entao nao ha DROP FUNCTION.
-- ────────────────────────────────────────────────────────────────────

-- Trava de seguranca: se existir qualquer decimal, a migration para.
-- Preferimos falhar alto a decidir por conta propria o que fazer com o
-- dado de outra pessoa.
DO $$
DECLARE
  v_decimais INT;
BEGIN
  SELECT count(*) INTO v_decimais
    FROM public.estudio_anuncios_projetos_marketplace
   WHERE (embalagem_peso_g          IS NOT NULL AND embalagem_peso_g          <> trunc(embalagem_peso_g))
      OR (embalagem_altura_cm       IS NOT NULL AND embalagem_altura_cm       <> trunc(embalagem_altura_cm))
      OR (embalagem_largura_cm      IS NOT NULL AND embalagem_largura_cm      <> trunc(embalagem_largura_cm))
      OR (embalagem_comprimento_cm  IS NOT NULL AND embalagem_comprimento_cm  <> trunc(embalagem_comprimento_cm));

  IF v_decimais > 0 THEN
    RAISE EXCEPTION
      'EMBALAGEM_DECIMAL_PERSISTIDO: % linha(s) com medida decimal. Decida caso a caso antes de converter — esta migration nao arredonda.',
      v_decimais;
  END IF;
END $$;

-- Sem decimais, o cast e exato: nenhum valor muda.
ALTER TABLE public.estudio_anuncios_projetos_marketplace
  ALTER COLUMN embalagem_peso_g         TYPE INTEGER USING embalagem_peso_g::INTEGER,
  ALTER COLUMN embalagem_altura_cm      TYPE INTEGER USING embalagem_altura_cm::INTEGER,
  ALTER COLUMN embalagem_largura_cm     TYPE INTEGER USING embalagem_largura_cm::INTEGER,
  ALTER COLUMN embalagem_comprimento_cm TYPE INTEGER USING embalagem_comprimento_cm::INTEGER;

-- Mesma invariante fisica de antes (caixa nao tem lado zero nem peso
-- zero), agora sobre um tipo inteiro. NULL continua valido: configuracao
-- incompleta e um estado legitimo, e quem barra a publicacao e o
-- compliance, nao o banco.
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
  'Peso da EMBALAGEM DE ENVIO em GRAMAS INTEIRAS — SELLER_PACKAGE_WEIGHT aceita apenas inteiros e apenas a unidade g (confirmado por /items/validate em 2026-08-27). NAO e o peso do produto: inclui caixa, enchimento e fita. Nunca derivado de entradas_produto.peso.';
COMMENT ON COLUMN public.estudio_anuncios_projetos_marketplace.embalagem_altura_cm IS
  'Altura da EMBALAGEM em CENTIMETROS INTEIROS — SELLER_PACKAGE_HEIGHT. NAO e a altura do produto.';
COMMENT ON COLUMN public.estudio_anuncios_projetos_marketplace.embalagem_largura_cm IS
  'Largura da EMBALAGEM em CENTIMETROS INTEIROS — SELLER_PACKAGE_WIDTH. NAO e a largura do produto.';
COMMENT ON COLUMN public.estudio_anuncios_projetos_marketplace.embalagem_comprimento_cm IS
  'Comprimento da EMBALAGEM em CENTIMETROS INTEIROS — SELLER_PACKAGE_LENGTH. NAO e o comprimento do produto.';

-- ────────────────────────────────────────────────────────────────────
-- RPC: mesma assinatura (NUMERIC, ver acima), agora recusando decimal.
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

    -- Decimal e RECUSADO, nunca arredondado. Sem esta checagem o cast
    -- para INTEGER na coluna faria 13.5 virar 14 sem ninguem saber.
    IF (p_peso_g IS NOT NULL AND p_peso_g <> trunc(p_peso_g))
       OR (p_altura_cm IS NOT NULL AND p_altura_cm <> trunc(p_altura_cm))
       OR (p_largura_cm IS NOT NULL AND p_largura_cm <> trunc(p_largura_cm))
       OR (p_comprimento_cm IS NOT NULL AND p_comprimento_cm <> trunc(p_comprimento_cm)) THEN
      RAISE EXCEPTION 'EMBALAGEM_VALOR_NAO_INTEIRO';
    END IF;
  END IF;

  UPDATE public.estudio_anuncios_projetos_marketplace
     SET embalagem_peso_g         = CASE WHEN coalesce(p_limpar, false) THEN NULL
                                         ELSE coalesce(p_peso_g::INTEGER, embalagem_peso_g) END,
         embalagem_altura_cm      = CASE WHEN coalesce(p_limpar, false) THEN NULL
                                         ELSE coalesce(p_altura_cm::INTEGER, embalagem_altura_cm) END,
         embalagem_largura_cm     = CASE WHEN coalesce(p_limpar, false) THEN NULL
                                         ELSE coalesce(p_largura_cm::INTEGER, embalagem_largura_cm) END,
         embalagem_comprimento_cm = CASE WHEN coalesce(p_limpar, false) THEN NULL
                                         ELSE coalesce(p_comprimento_cm::INTEGER, embalagem_comprimento_cm) END,
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
  'Grava peso e dimensoes da EMBALAGEM DE ENVIO em INTEIROS (g e cm, unidades do Mercado Livre). Recusa valor <= 0 e recusa decimal — nunca arredonda. Nao deriva nada do produto e nao toca conteudo, imagens, Pipeline, score ou pareceres.';

REVOKE EXECUTE ON FUNCTION public.estudio_anuncios_salvar_embalagem(UUID, TEXT, NUMERIC, NUMERIC, NUMERIC, NUMERIC, BOOLEAN, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.estudio_anuncios_salvar_embalagem(UUID, TEXT, NUMERIC, NUMERIC, NUMERIC, NUMERIC, BOOLEAN, TEXT)
  TO service_role;
