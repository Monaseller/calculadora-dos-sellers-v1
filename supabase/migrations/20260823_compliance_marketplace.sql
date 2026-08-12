-- ────────────────────────────────────────────────────────────────────
-- 20260823_compliance_marketplace.sql
--
-- Camada de PRE-PUBLICACAO: guarda o parecer de compliance por
-- marketplace.
--
-- POR QUE UMA TABELA NOVA (e nao reuso). A auditoria de 2026-08-23
-- percorreu as 16 tabelas `estudio_anuncios_*` e nenhuma responde a
-- pergunta desta camada:
--   * `conteudo_versoes`   -> "o que o usuario aprovou" (editorial);
--   * `pacotes_exportacao` -> "o que foi congelado para exportar";
--   * `resultados_pipeline`-> saida imutavel das etapas de IA, com
--                             UNIQUE(job_id) -- e compliance nao nasce de job;
--   * `estudio_anuncios_score` (legada) -> nota de qualidade, vazia e sem uso;
--   * `pendencias`         -> pendencia operacional do Pipeline, com
--                             maquina de estados propria.
-- Enfiar compliance em qualquer uma delas criaria uma segunda fonte de
-- verdade sobre coisa diferente. A tabela e nova porque a PERGUNTA e nova.
--
-- POR QUE E IMUTAVEL. Regra de marketplace muda. Uma versao aprovada hoje
-- pode ser bloqueada amanha, e a pergunta "por que este anuncio foi
-- considerado publicavel em agosto?" so tem resposta se o parecer daquela
-- data continuar existindo. Toda validacao nova e uma LINHA NOVA: nao ha
-- UPDATE em nenhum caminho de codigo.
--
-- IDEMPOTENCIA POR CONTEUDO, nao por instante: UNIQUE
-- (projeto_id, marketplace, hash_entrada), onde o hash cobre conteudo
-- aprovado + imagens + categoria + atributos + preco + estoque +
-- logistica + **versao das regras**. Revalidar sem mudanca reencontra a
-- linha; mudar qualquer entrada -- ou subir a versao das regras -- gera
-- parecer novo. Mesma disciplina ja usada em pacotes de exportacao.
--
-- Aditiva: nenhuma tabela existente e tocada. Nada da Fase 1, da camada
-- editorial ou da exportacao muda.
-- ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.estudio_anuncios_compliance_marketplace (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  projeto_id             UUID NOT NULL
                           REFERENCES public.estudio_anuncios_projetos(id) ON DELETE CASCADE,
  -- Nulo quando o canal nem existe no projeto, ou quando o parecer e
  -- `nao_implementado`: nesses casos nao ha conteudo editorial envolvido.
  projeto_marketplace_id UUID
                           REFERENCES public.estudio_anuncios_projetos_marketplace(id) ON DELETE SET NULL,
  -- Qual versao editorial foi validada. Responde "validou exatamente o
  -- que?" sem heuristica de timestamp.
  versao_conteudo_id     UUID
                           REFERENCES public.estudio_anuncios_conteudo_versoes(id) ON DELETE SET NULL,
  marketplace            TEXT NOT NULL,
  versao_regras          INTEGER NOT NULL,
  status                 TEXT NOT NULL,
  hash_entrada           TEXT NOT NULL,
  resultado              JSONB NOT NULL,
  criado_em              TIMESTAMPTZ NOT NULL DEFAULT now(),
  criado_por             TEXT,

  CONSTRAINT chk_compliance_marketplace
    CHECK (marketplace IN ('ML', 'Shopee', 'Amazon', 'TikTok Shop')),
  -- Os quatro estados que a camada produz. `aprovado` significa
  -- "nenhuma regra implementada foi violada" -- nunca "o marketplace
  -- aceitou".
  CONSTRAINT chk_compliance_status
    CHECK (status IN ('aprovado', 'aprovado_com_alertas', 'bloqueado', 'nao_implementado')),
  CONSTRAINT chk_compliance_versao_regras
    CHECK (versao_regras >= 0),
  CONSTRAINT chk_compliance_resultado_objeto
    CHECK (jsonb_typeof(resultado) = 'object'),
  -- Sem validador nao existe versao de regras; com validador, existe.
  CONSTRAINT chk_compliance_nao_implementado
    CHECK ((status = 'nao_implementado') = (versao_regras = 0))
);

-- Idempotencia no BANCO, nao na aplicacao: dois requests concorrentes com
-- a mesma entrada nao conseguem criar dois pareceres.
CREATE UNIQUE INDEX IF NOT EXISTS idx_compliance_entrada
  ON public.estudio_anuncios_compliance_marketplace (projeto_id, marketplace, hash_entrada);

-- Leitura da UI: ultimo parecer por canal.
CREATE INDEX IF NOT EXISTS idx_compliance_projeto_recente
  ON public.estudio_anuncios_compliance_marketplace (projeto_id, marketplace, criado_em DESC);

COMMENT ON TABLE public.estudio_anuncios_compliance_marketplace IS
  'Parecer de PRE-PUBLICACAO por marketplace. Append-only: toda validacao e uma linha nova, nunca UPDATE -- regras mudam e o historico precisa continuar explicavel. status=aprovado significa "nenhuma regra implementada foi violada", NUNCA "o marketplace aceitara o anuncio".';
COMMENT ON COLUMN public.estudio_anuncios_compliance_marketplace.hash_entrada IS
  'sha256 do conjunto validado: conteudo aprovado + imagens + categoria + atributos + preco + estoque + logistica + versao_regras. Deliberadamente SEM timestamp: revalidar sem mudanca reencontra o parecer; mudar a entrada ou a versao das regras gera um novo.';
COMMENT ON COLUMN public.estudio_anuncios_compliance_marketplace.versao_regras IS
  'Versao do conjunto de regras aplicado. 0 = sem validador (nao_implementado). Subir esta versao invalida os pareceres anteriores, porque entra no hash_entrada.';

-- ────────────────────────────────────────────────────────────────────
-- RPC: registrar parecer (atomica e idempotente)
--
-- Mesma disciplina da RPC de pacotes: trava o PROJETO com FOR UPDATE
-- (serializa validacoes concorrentes do mesmo projeto), devolve o parecer
-- existente quando a entrada ja foi validada, e e INSERT PURO -- sem
-- UPDATE e sem DELETE em nenhum ponto, o que e o que torna o historico
-- confiavel.
-- ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.estudio_anuncios_registrar_compliance(
  p_projeto_id             UUID,
  p_projeto_marketplace_id UUID,
  p_versao_conteudo_id     UUID,
  p_marketplace            TEXT,
  p_versao_regras          INTEGER,
  p_status                 TEXT,
  p_hash_entrada           TEXT,
  p_resultado              JSONB,
  p_criado_por             TEXT
)
RETURNS public.estudio_anuncios_compliance_marketplace
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_existente public.estudio_anuncios_compliance_marketplace;
  v_novo      public.estudio_anuncios_compliance_marketplace;
BEGIN
  -- Revalida o que o TypeScript ja validou: a RPC recebe parametro cru e
  -- nao tem sessao para confiar (Constituicao 27.3).
  IF p_hash_entrada IS NULL OR length(p_hash_entrada) <> 64 THEN
    RAISE EXCEPTION 'HASH_ENTRADA_INVALIDO';
  END IF;
  IF p_marketplace NOT IN ('ML', 'Shopee', 'Amazon', 'TikTok Shop') THEN
    RAISE EXCEPTION 'MARKETPLACE_INVALIDO: %', p_marketplace;
  END IF;

  PERFORM 1 FROM public.estudio_anuncios_projetos WHERE id = p_projeto_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROJETO_NAO_ENCONTRADO: %', p_projeto_id;
  END IF;

  -- O canal informado precisa ser DESTE projeto: sem isso, um id de outro
  -- projeto poderia ser gravado no parecer.
  IF p_projeto_marketplace_id IS NOT NULL THEN
    PERFORM 1 FROM public.estudio_anuncios_projetos_marketplace
     WHERE id = p_projeto_marketplace_id AND projeto_id = p_projeto_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'CANAL_DE_OUTRO_PROJETO: %', p_projeto_marketplace_id;
    END IF;
  END IF;

  SELECT * INTO v_existente
  FROM public.estudio_anuncios_compliance_marketplace
  WHERE projeto_id = p_projeto_id
    AND marketplace = p_marketplace
    AND hash_entrada = p_hash_entrada;
  IF FOUND THEN
    RETURN v_existente;
  END IF;

  INSERT INTO public.estudio_anuncios_compliance_marketplace
    (projeto_id, projeto_marketplace_id, versao_conteudo_id, marketplace,
     versao_regras, status, hash_entrada, resultado, criado_por)
  VALUES
    (p_projeto_id, p_projeto_marketplace_id, p_versao_conteudo_id, p_marketplace,
     p_versao_regras, p_status, p_hash_entrada, p_resultado, p_criado_por)
  RETURNING * INTO v_novo;

  RETURN v_novo;
END;
$$;

COMMENT ON FUNCTION public.estudio_anuncios_registrar_compliance IS
  'Registra um parecer de pre-publicacao de forma atomica e idempotente: trava o projeto (FOR UPDATE), devolve o parecer existente quando a mesma entrada ja foi validada com a mesma versao de regras, e recusa canal de outro projeto. INSERT puro -- nunca UPDATE, nunca apaga parecer antigo.';

REVOKE EXECUTE ON FUNCTION public.estudio_anuncios_registrar_compliance(UUID, UUID, UUID, TEXT, INTEGER, TEXT, TEXT, JSONB, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.estudio_anuncios_registrar_compliance(UUID, UUID, UUID, TEXT, INTEGER, TEXT, TEXT, JSONB, TEXT)
  TO service_role;
