-- ────────────────────────────────────────────────────────────────────
-- 20260821_pacotes_exportacao.sql
--
-- Habilita a EXPORTACAO do conteudo aprovado sobre
-- `estudio_anuncios_pacotes_exportacao`.
--
-- POR QUE ESTA TABELA E NAO UMA NOVA. A auditoria de 2026-08-21 confirmou
-- que ela ja existe desde 20260803, esta VAZIA (0 linhas) e **nenhum
-- codigo le ou escreve nela** -- e greenfield. Ja tem `projeto_id` com FK,
-- `itens_incluidos` jsonb, `storage_path` e `criado_em`. Criar tabela nova
-- seria criar uma segunda fonte de verdade de exportacao.
--
-- O QUE FALTAVA, e por que cada coisa importa:
--   1. `hash_conteudo` -- a identidade do pacote e o CONJUNTO DE VERSOES
--      APROVADAS que ele congela, nao o instante em que foi gerado. Sem
--      isso, "regerar sem mudanca" criaria uma linha nova toda vez.
--   2. UNIQUE (projeto_id, hash_conteudo) -- e o que torna a geracao
--      idempotente NO BANCO, nao em logica de aplicacao: dois requests
--      concorrentes com o mesmo conteudo nao conseguem criar dois pacotes.
--   3. `numero_pacote` -- historico legivel por projeto ("pacote 1, 2,
--      3"), monotonico, numerado sob lock (mesma disciplina de
--      `numero_versao` na camada editorial).
--   4. `status` -- `gerado` quando TODOS os canais do projeto tinham
--      versao aprovada; `parcial` quando pelo menos um nao tinha. Sao os
--      dois unicos estados que os dados de fato produzem hoje. Estados
--      como `exportado`/`publicado` entram quando existir o passo que os
--      produz -- inventa-los agora seria criar valor que nada escreve.
--   5. `gerado_por` -- quem pediu a exportacao. TEXT porque
--      `estudio_anuncios_projetos.user_id` e TEXT neste projeto.
--
-- `storage_path` fica NULL nesta etapa, de proposito: o pacote aqui e
-- DADO ESTRUTURADO (`itens_incluidos`), nao arquivo. Materializar ZIP/CSV
-- e passo seguinte, e a coluna ja existe esperando por ele.
--
-- Aditiva: nenhuma coluna removida, nenhuma constraint derrubada, nenhum
-- dado alterado. Nada da Fase 1 nem da camada editorial e tocado.
-- ────────────────────────────────────────────────────────────────────

ALTER TABLE public.estudio_anuncios_pacotes_exportacao
  ADD COLUMN IF NOT EXISTS numero_pacote  INTEGER,
  ADD COLUMN IF NOT EXISTS hash_conteudo  TEXT,
  ADD COLUMN IF NOT EXISTS status         TEXT NOT NULL DEFAULT 'gerado',
  ADD COLUMN IF NOT EXISTS gerado_por     TEXT;

ALTER TABLE public.estudio_anuncios_pacotes_exportacao
  DROP CONSTRAINT IF EXISTS chk_pacotes_exportacao_status;
ALTER TABLE public.estudio_anuncios_pacotes_exportacao
  ADD CONSTRAINT chk_pacotes_exportacao_status
  CHECK (status IN ('gerado', 'parcial'));

ALTER TABLE public.estudio_anuncios_pacotes_exportacao
  DROP CONSTRAINT IF EXISTS chk_pacotes_exportacao_numero;
ALTER TABLE public.estudio_anuncios_pacotes_exportacao
  ADD CONSTRAINT chk_pacotes_exportacao_numero
  CHECK (numero_pacote IS NULL OR numero_pacote > 0);

-- IDEMPOTENCIA GARANTIDA PELO BANCO: um conteudo aprovado -> um pacote.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pacotes_exportacao_hash
  ON public.estudio_anuncios_pacotes_exportacao (projeto_id, hash_conteudo)
  WHERE hash_conteudo IS NOT NULL;

-- Historico legivel e sem buraco por projeto.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pacotes_exportacao_numero
  ON public.estudio_anuncios_pacotes_exportacao (projeto_id, numero_pacote)
  WHERE numero_pacote IS NOT NULL;

COMMENT ON COLUMN public.estudio_anuncios_pacotes_exportacao.hash_conteudo IS
  'sha256 do conjunto de versoes aprovadas + imagens congeladas neste pacote. E a IDENTIDADE do conteudo, nao do instante: regerar sem mudanca reencontra o mesmo pacote; trocar a versao aprovada gera um novo, preservando o anterior.';
COMMENT ON COLUMN public.estudio_anuncios_pacotes_exportacao.status IS
  'gerado = todos os canais do projeto tinham versao aprovada; parcial = pelo menos um canal ficou de fora por nao ter aprovacao. NUNCA ha fallback para versao nao aprovada.';
COMMENT ON COLUMN public.estudio_anuncios_pacotes_exportacao.storage_path IS
  'NULL nesta fase: o pacote e dado estruturado em itens_incluidos. Reservado para quando houver materializacao de arquivo (ZIP/CSV).';

-- ────────────────────────────────────────────────────────────────────
-- RPC: gerar pacote (atomica e idempotente)
--
-- Tres problemas resolvidos na MESMA transacao:
--   a) idempotencia por conteudo -- se ja existe pacote com este
--      hash_conteudo para este projeto, devolve o existente sem inserir.
--      Isso e o que faz "regerar sem mudanca" nao duplicar.
--   b) numeracao sob concorrencia -- `max(numero_pacote)+1` sozinho e
--      inseguro (dois requests leem o mesmo max), entao a linha do
--      PROJETO e travada com FOR UPDATE. O UNIQUE parcial continua como
--      rede de seguranca.
--   c) nunca apaga nem sobrescreve pacote antigo -- e INSERT puro, sem
--      UPDATE em nenhum ponto.
-- ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.estudio_anuncios_gerar_pacote_exportacao(
  p_projeto_id      UUID,
  p_itens_incluidos JSONB,
  p_hash_conteudo   TEXT,
  p_status          TEXT,
  p_gerado_por      TEXT
)
RETURNS public.estudio_anuncios_pacotes_exportacao
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_existente public.estudio_anuncios_pacotes_exportacao;
  v_proximo   INTEGER;
  v_novo      public.estudio_anuncios_pacotes_exportacao;
BEGIN
  -- Trava o projeto: serializa geracoes concorrentes deste projeto.
  PERFORM 1 FROM public.estudio_anuncios_projetos WHERE id = p_projeto_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROJETO_NAO_ENCONTRADO: %', p_projeto_id;
  END IF;

  -- Idempotencia por CONTEUDO: mesmo conjunto aprovado -> mesmo pacote.
  SELECT * INTO v_existente
  FROM public.estudio_anuncios_pacotes_exportacao
  WHERE projeto_id = p_projeto_id AND hash_conteudo = p_hash_conteudo;
  IF FOUND THEN
    RETURN v_existente;
  END IF;

  SELECT coalesce(max(numero_pacote), 0) + 1 INTO v_proximo
  FROM public.estudio_anuncios_pacotes_exportacao
  WHERE projeto_id = p_projeto_id;

  INSERT INTO public.estudio_anuncios_pacotes_exportacao
    (projeto_id, numero_pacote, itens_incluidos, hash_conteudo, status, gerado_por)
  VALUES
    (p_projeto_id, v_proximo, p_itens_incluidos, p_hash_conteudo, p_status, p_gerado_por)
  RETURNING * INTO v_novo;

  RETURN v_novo;
END;
$$;

COMMENT ON FUNCTION public.estudio_anuncios_gerar_pacote_exportacao IS
  'Gera um pacote de exportacao de forma atomica e idempotente: trava o projeto (FOR UPDATE), devolve o pacote existente quando o hash_conteudo ja foi exportado, e numera monotonicamente. INSERT puro -- nunca faz UPDATE nem apaga pacote antigo.';

REVOKE EXECUTE ON FUNCTION public.estudio_anuncios_gerar_pacote_exportacao(UUID, JSONB, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.estudio_anuncios_gerar_pacote_exportacao(UUID, JSONB, TEXT, TEXT, TEXT)
  TO service_role;
