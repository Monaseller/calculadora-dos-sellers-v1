-- ────────────────────────────────────────────────────────────────────
-- 20260831_publicacao_mercado_livre.sql
--
-- VINCULO Estudio -> anuncio real do Mercado Livre, e a TRAVA que
-- impede publicar duas vezes.
--
-- ── Por que NAO gravar em `anuncios` ────────────────────────────────
-- A auditoria de 2026-08-31 leu a tabela inteira: 1.579 linhas, TODAS
-- com `ml_item_id`, alimentadas pelo Worker de sincronizacao do ML. As
-- colunas obrigatorias sao `custo_produto`, `insumos`, `custo_frete`,
-- `imposto`, `margem_desejada` — ela e a CALCULADORA de custo e margem
-- de anuncios que ja existem no marketplace, nao um registro de
-- publicacao. Gravar la exigiria **inventar custos**, que e exatamente o
-- que este modulo se recusa a fazer. E nao ha nenhuma coluna ligando
-- anuncio a projeto do Estudio.
--
-- Entao `anuncios` continua sendo a fonte de verdade do ANUNCIO (via
-- sync), e esta tabela responde a outra pergunta, que hoje nao tem
-- resposta em lugar nenhum: **qual projeto do Estudio criou qual item do
-- Mercado Livre?**
--
-- ── A TRAVA E UMA RESERVA, NAO UM REGISTRO POSTERIOR ────────────────
-- Este e o ponto mais importante do arquivo. Se a linha so fosse
-- gravada DEPOIS do `POST /items`, dois cliques simultaneos disparariam
-- dois POSTs antes de qualquer INSERT — e nasceriam dois anuncios. Por
-- isso a publicacao acontece em duas fases:
--
--   1. RESERVA (`em_andamento`) — INSERT que o UNIQUE parcial protege.
--      Perdeu a corrida? Nao chama o ML.
--   2. CONCLUSAO — UPDATE da propria reserva com o desfecho.
--
-- O UPDATE existe SO para fechar a reserva, e so a partir de
-- `em_andamento`. Nada e apagado: uma tentativa que falhou fica como
-- evidencia.
--
-- ── `publicacao_incerta` NAO E FALHA ────────────────────────────────
-- Timeout ou 5xx DEPOIS do envio significa que o item pode ter sido
-- criado. Chamar isso de "falha" convidaria a um retry que criaria o
-- segundo anuncio. O status proprio mantem a trava fechada ate alguem
-- reconciliar.
-- ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.estudio_anuncios_publicacoes (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  projeto_id              UUID NOT NULL REFERENCES public.estudio_anuncios_projetos(id) ON DELETE CASCADE,
  projeto_marketplace_id  UUID NOT NULL REFERENCES public.estudio_anuncios_projetos_marketplace(id) ON DELETE CASCADE,
  loja_id                 UUID NOT NULL REFERENCES public.lojas(id),
  marketplace             TEXT NOT NULL,

  -- EVIDENCIA que autorizou publicar. Sem isto nao da para responder
  -- "com base em que este anuncio foi criado?".
  validacao_id            UUID NOT NULL REFERENCES public.estudio_anuncios_validacoes_publicacao(id),
  compliance_id           UUID REFERENCES public.estudio_anuncios_compliance_marketplace(id),
  versao_conteudo_id      UUID REFERENCES public.estudio_anuncios_conteudo_versoes(id),
  hash_payload            TEXT NOT NULL,
  -- O payload EXATO que foi enviado. E o que permite comparar depois com
  -- o item real e detectar divergencia.
  payload_enviado         JSONB,
  -- Warnings oficiais vigentes no momento da autorizacao.
  alertas_validacao       JSONB,

  status                  TEXT NOT NULL,
  -- Preenchidos na conclusao.
  ml_item_id              TEXT,
  permalink               TEXT,
  status_ml               TEXT,
  resposta_ml             JSONB,
  erro                    JSONB,

  criado_em               TIMESTAMPTZ NOT NULL DEFAULT now(),
  concluido_em            TIMESTAMPTZ,
  criado_por              TEXT NOT NULL,

  CONSTRAINT chk_pub_marketplace CHECK (marketplace IN ('ML', 'SHOPEE', 'AMAZON', 'TIKTOK')),
  -- NENHUM status se chama "sucesso" por default: cada um afirma uma
  -- coisa diferente, e `publicacao_incerta` e deliberadamente distinto
  -- de `falha`.
  CONSTRAINT chk_pub_status CHECK (status IN ('em_andamento', 'publicado', 'falha', 'publicacao_incerta')),
  -- `publicado` sem item_id seria uma afirmacao sem prova.
  CONSTRAINT chk_pub_item_quando_publicado CHECK (status <> 'publicado' OR (ml_item_id IS NOT NULL AND length(btrim(ml_item_id)) > 0)),
  -- Mesma protecao das outras tabelas do modulo.
  CONSTRAINT chk_pub_sem_credencial CHECK (
    (resposta_ml IS NULL OR (
      resposta_ml::text NOT ILIKE '%access_token%'
      AND resposta_ml::text NOT ILIKE '%refresh_token%'
      AND resposta_ml::text NOT ILIKE '%client_secret%'
      AND resposta_ml::text NOT ILIKE '%bearer %'))
    AND (payload_enviado IS NULL OR (
      payload_enviado::text NOT ILIKE '%access_token%'
      AND payload_enviado::text NOT ILIKE '%bearer %'))
  )
);

-- A TRAVA. Um canal so pode ter UMA publicacao viva: em andamento,
-- publicada, ou incerta. `falha` fica de fora de proposito — um 4xx
-- estruturado prova que nada foi criado, entao tentar de novo e legitimo.
CREATE UNIQUE INDEX IF NOT EXISTS uq_publicacao_viva_por_canal
  ON public.estudio_anuncios_publicacoes (projeto_marketplace_id)
  WHERE status IN ('em_andamento', 'publicado', 'publicacao_incerta');

-- Um item do ML nunca pode aparecer em duas linhas.
CREATE UNIQUE INDEX IF NOT EXISTS uq_publicacao_ml_item
  ON public.estudio_anuncios_publicacoes (ml_item_id)
  WHERE ml_item_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_publicacao_projeto
  ON public.estudio_anuncios_publicacoes (projeto_id, marketplace);

COMMENT ON TABLE public.estudio_anuncios_publicacoes IS
  'Vinculo Estudio -> item real do marketplace, e trava de publicacao unica por canal. NAO substitui `anuncios` (calculadora de custo/margem alimentada pelo sync): responde a pergunta que nenhuma tabela respondia — qual projeto criou qual item.';
COMMENT ON COLUMN public.estudio_anuncios_publicacoes.status IS
  'em_andamento = reserva antes do POST; publicado = item criado; falha = 4xx estruturado, nada criado; publicacao_incerta = timeout/5xx apos o envio, o item PODE existir e nao se deve reenviar.';

-- ────────────────────────────────────────────────────────────────────
-- RPC 1: RESERVAR — roda ANTES do POST /items.
-- ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.estudio_anuncios_reservar_publicacao(
  p_projeto_id              UUID,
  p_projeto_marketplace_id  UUID,
  p_loja_id                 UUID,
  p_marketplace             TEXT,
  p_validacao_id            UUID,
  p_compliance_id           UUID,
  p_versao_conteudo_id      UUID,
  p_hash_payload            TEXT,
  p_payload                 JSONB,
  p_alertas                 JSONB,
  p_criado_por              TEXT
)
RETURNS public.estudio_anuncios_publicacoes
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_linha public.estudio_anuncios_publicacoes;
  v_existente public.estudio_anuncios_publicacoes;
BEGIN
  -- Trava o projeto: dois cliques simultaneos serializam aqui, antes de
  -- qualquer chamada externa.
  PERFORM 1 FROM public.estudio_anuncios_projetos WHERE id = p_projeto_id FOR UPDATE;

  SELECT * INTO v_existente
    FROM public.estudio_anuncios_publicacoes
   WHERE projeto_marketplace_id = p_projeto_marketplace_id
     AND status IN ('em_andamento', 'publicado', 'publicacao_incerta')
   LIMIT 1;

  IF v_existente.id IS NOT NULL THEN
    IF v_existente.status = 'publicado' THEN
      RAISE EXCEPTION 'ANUNCIO_JA_PUBLICADO: % (item %)', v_existente.id, v_existente.ml_item_id;
    ELSIF v_existente.status = 'publicacao_incerta' THEN
      RAISE EXCEPTION 'PUBLICACAO_INCERTA: % — reconcilie antes de tentar de novo', v_existente.id;
    ELSE
      RAISE EXCEPTION 'PUBLICACAO_EM_ANDAMENTO: %', v_existente.id;
    END IF;
  END IF;

  INSERT INTO public.estudio_anuncios_publicacoes (
    projeto_id, projeto_marketplace_id, loja_id, marketplace,
    validacao_id, compliance_id, versao_conteudo_id, hash_payload,
    payload_enviado, alertas_validacao, status, criado_por
  ) VALUES (
    p_projeto_id, p_projeto_marketplace_id, p_loja_id, p_marketplace,
    p_validacao_id, p_compliance_id, p_versao_conteudo_id, p_hash_payload,
    p_payload, p_alertas, 'em_andamento', p_criado_por
  )
  RETURNING * INTO v_linha;

  RETURN v_linha;
END;
$$;

-- ────────────────────────────────────────────────────────────────────
-- RPC 2: CONCLUIR — o unico UPDATE, e so a partir de `em_andamento`.
-- ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.estudio_anuncios_concluir_publicacao(
  p_publicacao_id  UUID,
  p_status         TEXT,
  p_ml_item_id     TEXT,
  p_permalink      TEXT,
  p_status_ml      TEXT,
  p_resposta       JSONB,
  p_erro           JSONB
)
RETURNS public.estudio_anuncios_publicacoes
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_linha public.estudio_anuncios_publicacoes;
BEGIN
  IF p_status NOT IN ('publicado', 'falha', 'publicacao_incerta') THEN
    RAISE EXCEPTION 'STATUS_CONCLUSAO_INVALIDO: %', p_status;
  END IF;

  UPDATE public.estudio_anuncios_publicacoes
     SET status = p_status,
         ml_item_id = p_ml_item_id,
         permalink = p_permalink,
         status_ml = p_status_ml,
         resposta_ml = p_resposta,
         erro = p_erro,
         concluido_em = now()
   WHERE id = p_publicacao_id
     -- So fecha reserva aberta. Reescrever um desfecho ja gravado seria
     -- apagar a evidencia do que aconteceu.
     AND status = 'em_andamento'
  RETURNING * INTO v_linha;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RESERVA_NAO_ABERTA: %', p_publicacao_id;
  END IF;

  RETURN v_linha;
END;
$$;

COMMENT ON FUNCTION public.estudio_anuncios_reservar_publicacao IS
  'Reserva a publicacao ANTES do POST /items. E a trava server-side contra duplo clique e concorrencia: quem perde a corrida recebe ANUNCIO_JA_PUBLICADO / PUBLICACAO_EM_ANDAMENTO / PUBLICACAO_INCERTA e nao chama o marketplace.';
COMMENT ON FUNCTION public.estudio_anuncios_concluir_publicacao IS
  'Fecha uma reserva `em_andamento` com o desfecho real. Unico UPDATE da tabela; nunca reescreve desfecho ja gravado, nunca apaga.';

REVOKE EXECUTE ON FUNCTION public.estudio_anuncios_reservar_publicacao(UUID, UUID, UUID, TEXT, UUID, UUID, UUID, TEXT, JSONB, JSONB, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.estudio_anuncios_reservar_publicacao(UUID, UUID, UUID, TEXT, UUID, UUID, UUID, TEXT, JSONB, JSONB, TEXT)
  TO service_role;
REVOKE EXECUTE ON FUNCTION public.estudio_anuncios_concluir_publicacao(UUID, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.estudio_anuncios_concluir_publicacao(UUID, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB)
  TO service_role;

ALTER TABLE public.estudio_anuncios_publicacoes ENABLE ROW LEVEL SECURITY;
