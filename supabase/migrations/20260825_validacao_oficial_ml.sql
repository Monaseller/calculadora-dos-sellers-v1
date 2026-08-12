-- ────────────────────────────────────────────────────────────────────
-- 20260825_validacao_oficial_ml.sql
--
-- VINCULO PROJETO→LOJA e persistencia da VALIDACAO OFICIAL do
-- Mercado Livre (`POST /items/validate`). NENHUM anuncio e criado.
--
-- ── 1. Por que o vinculo fica em `projetos_marketplace` ──────────────
-- `estudio_anuncios_projetos.loja_id` ja existe, mas e do PROJETO
-- inteiro: obrigaria todos os canais a publicarem na mesma conta, o que
-- o dominio nao sustenta -- preco, estoque, categoria e condicao ja sao
-- por canal, e a conta e da mesma natureza. A auditoria de 2026-08-25
-- confirmou que `projetos.loja_id` **nao e lido por nenhum codigo do
-- Estudio** (so aparece no SELECT e no tipo), entao nao ha reuso a
-- preservar nem risco de divergencia.
--
-- ── 2. Por que existe RPC de vinculo em vez de UPDATE ────────────────
-- Tres invariantes que precisam valer na MESMA transacao, e que a rota
-- sozinha nao garante (ela recebe parametro cru -- Constituicao 27.3):
--   a) a loja pertence ao MESMO usuario do projeto;
--   b) a loja e do marketplace certo (`ML`) e esta ativa;
--   c) o canal pertence ao projeto informado.
-- Sem (a), um id de loja de outro usuario poderia ser gravado e depois
-- usado para carregar TOKEN ALHEIO -- e a funcao existente
-- `getMLLojaById()` nao checa dono (ela nasceu para o worker, que resolve
-- a loja a partir do job). Aqui a checagem e do banco, nao da confianca.
--
-- ── 3. Por que uma tabela nova para a validacao oficial ──────────────
-- `estudio_anuncios_compliance_marketplace` guarda o parecer LOCAL
-- (regras nossas, sem rede). Esta guarda o parecer do MERCADO LIVRE
-- (resposta real da API, dependente de conta e de token). Sao autoridades
-- diferentes: misturar as duas tornaria impossivel responder "quem
-- reprovou, nos ou eles?". Append-only pelo mesmo motivo do compliance:
-- a resposta do ML muda com o tempo e o historico precisa continuar
-- explicavel.
--
-- ── 4. Idempotencia por hash do PAYLOAD ──────────────────────────────
-- UNIQUE (projeto_marketplace_id, hash_payload). O hash cobre o payload
-- inteiro + a loja + a versao do construtor, entao qualquer mudanca em
-- preco, estoque, categoria, condicao, tipo de anuncio, atributos,
-- conteudo aprovado, imagens ou conta gera validacao nova -- e duplo
-- clique nao gera duas linhas.
--
-- NUNCA ARMAZENA TOKEN. `resposta_ml` guarda o corpo da resposta da API,
-- que nao contem credencial; um CHECK recusa qualquer texto com
-- access_token/refresh_token, como rede de seguranca contra regressao.
-- ────────────────────────────────────────────────────────────────────

ALTER TABLE public.estudio_anuncios_projetos_marketplace
  ADD COLUMN IF NOT EXISTS loja_id UUID REFERENCES public.lojas(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS loja_vinculada_em TIMESTAMPTZ,
  -- Tipos de anuncio que a CONTA de fato permite nesta categoria,
  -- obtidos com token real. Sem isso, `listing_type_id` continuaria
  -- validado so contra a lista documentada.
  ADD COLUMN IF NOT EXISTS tipos_anuncio_disponiveis JSONB,
  ADD COLUMN IF NOT EXISTS tipos_anuncio_verificados_em TIMESTAMPTZ;

ALTER TABLE public.estudio_anuncios_projetos_marketplace
  DROP CONSTRAINT IF EXISTS chk_pm_tipos_anuncio_array;
ALTER TABLE public.estudio_anuncios_projetos_marketplace
  ADD CONSTRAINT chk_pm_tipos_anuncio_array
  CHECK (tipos_anuncio_disponiveis IS NULL OR jsonb_typeof(tipos_anuncio_disponiveis) = 'array');

COMMENT ON COLUMN public.estudio_anuncios_projetos_marketplace.loja_id IS
  'Conta do marketplace usada para publicar ESTE canal. Vinculada apenas via RPC, que exige loja do mesmo usuario, do mesmo marketplace e ativa. O access_token NUNCA sai do servidor.';
COMMENT ON COLUMN public.estudio_anuncios_projetos_marketplace.tipos_anuncio_disponiveis IS
  'listing_types que a CONTA permite (GET /sites/{site}/listing_types, exige OAuth). Enquanto for NULL, o tipo de anuncio so pode ser conferido contra a lista documentada.';

-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.estudio_anuncios_validacoes_publicacao (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  projeto_id             UUID NOT NULL
                           REFERENCES public.estudio_anuncios_projetos(id) ON DELETE CASCADE,
  projeto_marketplace_id UUID NOT NULL
                           REFERENCES public.estudio_anuncios_projetos_marketplace(id) ON DELETE CASCADE,
  loja_id                UUID REFERENCES public.lojas(id) ON DELETE SET NULL,
  marketplace            TEXT NOT NULL,
  -- Qual parecer local autorizou esta submissao. Responde "o compliance
  -- que aprovou era qual?" sem heuristica de timestamp.
  compliance_id          UUID REFERENCES public.estudio_anuncios_compliance_marketplace(id) ON DELETE SET NULL,
  versao_conteudo_id     UUID REFERENCES public.estudio_anuncios_conteudo_versoes(id) ON DELETE SET NULL,
  versao_construtor      INTEGER NOT NULL,
  hash_payload           TEXT NOT NULL,
  payload                JSONB NOT NULL,
  status                 TEXT NOT NULL,
  http_status            INTEGER,
  erros                  JSONB NOT NULL DEFAULT '[]'::jsonb,
  alertas                JSONB NOT NULL DEFAULT '[]'::jsonb,
  resposta_ml            JSONB,
  criado_em              TIMESTAMPTZ NOT NULL DEFAULT now(),
  criado_por             TEXT,

  CONSTRAINT chk_validacao_marketplace CHECK (marketplace IN ('ML', 'Shopee', 'Amazon', 'TikTok Shop')),
  -- Tres estados, e nenhum deles se chama "publicado": nada foi criado.
  CONSTRAINT chk_validacao_status
    CHECK (status IN ('validado', 'validado_com_alertas', 'bloqueado', 'erro_comunicacao')),
  CONSTRAINT chk_validacao_hash CHECK (length(hash_payload) = 64),
  CONSTRAINT chk_validacao_payload_objeto CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT chk_validacao_erros_array CHECK (jsonb_typeof(erros) = 'array'),
  CONSTRAINT chk_validacao_alertas_array CHECK (jsonb_typeof(alertas) = 'array'),
  -- Rede de seguranca contra regressao: credencial nunca entra aqui.
  CONSTRAINT chk_validacao_sem_credencial
    CHECK (
      (payload::text !~* '(access_token|refresh_token|client_secret|Bearer )')
      AND (resposta_ml IS NULL OR resposta_ml::text !~* '(access_token|refresh_token|client_secret|Bearer )')
    )
);

-- Idempotencia NO BANCO: mesmo payload + mesmo canal -> uma linha.
CREATE UNIQUE INDEX IF NOT EXISTS idx_validacao_publicacao_hash
  ON public.estudio_anuncios_validacoes_publicacao (projeto_marketplace_id, hash_payload);

CREATE INDEX IF NOT EXISTS idx_validacao_publicacao_recente
  ON public.estudio_anuncios_validacoes_publicacao (projeto_id, marketplace, criado_em DESC);

COMMENT ON TABLE public.estudio_anuncios_validacoes_publicacao IS
  'Parecer OFICIAL do marketplace (POST /items/validate) sobre o payload de publicacao. Append-only. NENHUM anuncio e criado por esta tabela nem pelo fluxo que a alimenta -- status nunca e "publicado". Distinta de compliance_marketplace, que guarda o parecer LOCAL: autoridades diferentes.';
COMMENT ON COLUMN public.estudio_anuncios_validacoes_publicacao.hash_payload IS
  'sha256 do payload enviado + loja + versao do construtor. Mudou qualquer coisa (preco, estoque, categoria, conteudo aprovado, imagens, conta) -> validacao anterior fica stale e NAO pode publicar.';

-- ────────────────────────────────────────────────────────────────────
-- RPC 1: vincular loja ao canal (com checagem de propriedade no banco)
-- ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.estudio_anuncios_vincular_loja_marketplace(
  p_projeto_id  UUID,
  p_marketplace TEXT,
  p_loja_id     UUID,
  p_user_id     TEXT
)
RETURNS public.estudio_anuncios_projetos_marketplace
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_canal   public.estudio_anuncios_projetos_marketplace;
  v_projeto public.estudio_anuncios_projetos;
  v_loja    public.lojas;
BEGIN
  SELECT * INTO v_projeto FROM public.estudio_anuncios_projetos
   WHERE id = p_projeto_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROJETO_NAO_ENCONTRADO: %', p_projeto_id;
  END IF;

  -- O projeto tem de ser do usuario que pediu. A rota ja checou; aqui a
  -- checagem e do banco, porque a RPC nao tem sessao para confiar.
  IF v_projeto.user_id IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'PROJETO_DE_OUTRO_USUARIO';
  END IF;

  SELECT * INTO v_canal FROM public.estudio_anuncios_projetos_marketplace
   WHERE projeto_id = p_projeto_id AND marketplace = p_marketplace;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CANAL_NAO_ENCONTRADO: % / %', p_projeto_id, p_marketplace;
  END IF;

  IF p_loja_id IS NULL THEN
    UPDATE public.estudio_anuncios_projetos_marketplace
       SET loja_id = NULL, loja_vinculada_em = NULL,
           tipos_anuncio_disponiveis = NULL, tipos_anuncio_verificados_em = NULL,
           atualizado_em = now()
     WHERE id = v_canal.id
    RETURNING * INTO v_canal;
    RETURN v_canal;
  END IF;

  SELECT * INTO v_loja FROM public.lojas WHERE id = p_loja_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'LOJA_NAO_ENCONTRADA: %', p_loja_id;
  END IF;

  -- A checagem que impede usar token alheio.
  IF v_loja.user_id IS NULL OR v_loja.user_id::text IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'LOJA_DE_OUTRO_USUARIO';
  END IF;
  IF v_loja.marketplace IS DISTINCT FROM p_marketplace THEN
    RAISE EXCEPTION 'LOJA_DE_OUTRO_MARKETPLACE: % <> %', v_loja.marketplace, p_marketplace;
  END IF;
  IF v_loja.ativo IS NOT TRUE THEN
    RAISE EXCEPTION 'LOJA_INATIVA';
  END IF;

  UPDATE public.estudio_anuncios_projetos_marketplace
     SET loja_id = p_loja_id,
         loja_vinculada_em = now(),
         -- Trocar de conta invalida os tipos de anuncio da conta anterior.
         tipos_anuncio_disponiveis = CASE WHEN loja_id IS DISTINCT FROM p_loja_id
                                          THEN NULL ELSE tipos_anuncio_disponiveis END,
         tipos_anuncio_verificados_em = CASE WHEN loja_id IS DISTINCT FROM p_loja_id
                                             THEN NULL ELSE tipos_anuncio_verificados_em END,
         atualizado_em = now()
   WHERE id = v_canal.id
  RETURNING * INTO v_canal;

  RETURN v_canal;
END;
$$;

COMMENT ON FUNCTION public.estudio_anuncios_vincular_loja_marketplace IS
  'Vincula uma conta de marketplace a UM canal do projeto. Recusa loja de outro usuario, de outro marketplace ou inativa, e projeto de outro usuario -- as tres checagens no banco, nao na confianca da rota. Trocar de conta zera os tipos de anuncio verificados da anterior.';

REVOKE EXECUTE ON FUNCTION public.estudio_anuncios_vincular_loja_marketplace(UUID, TEXT, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.estudio_anuncios_vincular_loja_marketplace(UUID, TEXT, UUID, TEXT)
  TO service_role;

-- ────────────────────────────────────────────────────────────────────
-- RPC 2: gravar tipos de anuncio verificados na conta
-- ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.estudio_anuncios_salvar_tipos_anuncio(
  p_projeto_marketplace_id UUID,
  p_tipos                  JSONB
)
RETURNS public.estudio_anuncios_projetos_marketplace
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_canal public.estudio_anuncios_projetos_marketplace;
BEGIN
  IF p_tipos IS NULL OR jsonb_typeof(p_tipos) <> 'array' THEN
    RAISE EXCEPTION 'TIPOS_INVALIDOS';
  END IF;

  UPDATE public.estudio_anuncios_projetos_marketplace
     SET tipos_anuncio_disponiveis = p_tipos,
         tipos_anuncio_verificados_em = now(),
         atualizado_em = now()
   WHERE id = p_projeto_marketplace_id
  RETURNING * INTO v_canal;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CANAL_NAO_ENCONTRADO: %', p_projeto_marketplace_id;
  END IF;
  RETURN v_canal;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.estudio_anuncios_salvar_tipos_anuncio(UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.estudio_anuncios_salvar_tipos_anuncio(UUID, JSONB)
  TO service_role;

-- ────────────────────────────────────────────────────────────────────
-- RPC 3: registrar validacao oficial (atomica e idempotente)
--
-- Mesma disciplina das anteriores: trava o CANAL com FOR UPDATE (duas
-- validacoes concorrentes do mesmo payload serializam), devolve a
-- existente quando o hash ja foi validado, e e INSERT PURO.
-- ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.estudio_anuncios_registrar_validacao_publicacao(
  p_projeto_id             UUID,
  p_projeto_marketplace_id UUID,
  p_loja_id                UUID,
  p_marketplace            TEXT,
  p_compliance_id          UUID,
  p_versao_conteudo_id     UUID,
  p_versao_construtor      INTEGER,
  p_hash_payload           TEXT,
  p_payload                JSONB,
  p_status                 TEXT,
  p_http_status            INTEGER,
  p_erros                  JSONB,
  p_alertas                JSONB,
  p_resposta_ml            JSONB,
  p_criado_por             TEXT
)
RETURNS public.estudio_anuncios_validacoes_publicacao
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_canal     public.estudio_anuncios_projetos_marketplace;
  v_existente public.estudio_anuncios_validacoes_publicacao;
  v_nova      public.estudio_anuncios_validacoes_publicacao;
BEGIN
  IF p_hash_payload IS NULL OR length(p_hash_payload) <> 64 THEN
    RAISE EXCEPTION 'HASH_PAYLOAD_INVALIDO';
  END IF;

  SELECT * INTO v_canal FROM public.estudio_anuncios_projetos_marketplace
   WHERE id = p_projeto_marketplace_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CANAL_NAO_ENCONTRADO: %', p_projeto_marketplace_id;
  END IF;
  IF v_canal.projeto_id <> p_projeto_id THEN
    RAISE EXCEPTION 'CANAL_DE_OUTRO_PROJETO';
  END IF;

  SELECT * INTO v_existente
  FROM public.estudio_anuncios_validacoes_publicacao
  WHERE projeto_marketplace_id = p_projeto_marketplace_id
    AND hash_payload = p_hash_payload;
  IF FOUND THEN
    RETURN v_existente;
  END IF;

  INSERT INTO public.estudio_anuncios_validacoes_publicacao
    (projeto_id, projeto_marketplace_id, loja_id, marketplace, compliance_id,
     versao_conteudo_id, versao_construtor, hash_payload, payload, status,
     http_status, erros, alertas, resposta_ml, criado_por)
  VALUES
    (p_projeto_id, p_projeto_marketplace_id, p_loja_id, p_marketplace, p_compliance_id,
     p_versao_conteudo_id, p_versao_construtor, p_hash_payload, p_payload, p_status,
     p_http_status, coalesce(p_erros, '[]'::jsonb), coalesce(p_alertas, '[]'::jsonb),
     p_resposta_ml, p_criado_por)
  RETURNING * INTO v_nova;

  RETURN v_nova;
END;
$$;

COMMENT ON FUNCTION public.estudio_anuncios_registrar_validacao_publicacao IS
  'Registra o parecer oficial do marketplace de forma atomica e idempotente: trava o canal (FOR UPDATE), devolve a validacao existente quando o mesmo payload ja foi validado. INSERT puro -- nunca UPDATE, nunca apaga. NENHUM anuncio e criado.';

REVOKE EXECUTE ON FUNCTION public.estudio_anuncios_registrar_validacao_publicacao(UUID, UUID, UUID, TEXT, UUID, UUID, INTEGER, TEXT, JSONB, TEXT, INTEGER, JSONB, JSONB, JSONB, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.estudio_anuncios_registrar_validacao_publicacao(UUID, UUID, UUID, TEXT, UUID, UUID, INTEGER, TEXT, JSONB, TEXT, INTEGER, JSONB, JSONB, JSONB, TEXT)
  TO service_role;
