-- ────────────────────────────────────────────────────────────────────
-- 20260820_conteudo_versoes_editorial.sql
--
-- Habilita a camada EDITORIAL humana sobre `estudio_anuncios_conteudo_versoes`.
--
-- POR QUE ESTA TABELA E NAO UMA NOVA. A auditoria de 2026-08-20 confirmou
-- que ela ja e o lugar certo: e indexada por `projeto_marketplace_id`
-- (a cardinalidade correta -- cada canal tem seu proprio historico), tem
-- `numero_versao` com UNIQUE `(projeto_marketplace_id, numero_versao)`
-- (que e a propria protecao de concorrencia), `origem`, `conteudo` jsonb,
-- `aprovado`/`aprovado_em` e `criado_em`. Esta VAZIA (0 linhas), entao
-- nada precisa ser migrado. Criar tabela nova seria criar uma segunda
-- fonte de verdade editorial.
--
-- O QUE FALTAVA, e por que cada coisa importa:
--   1. `criado_por` / `aprovado_por` -- sem autor nao ha auditoria
--      editorial: era impossivel responder "quem editou/aprovou isto".
--      TEXT porque `estudio_anuncios_projetos.user_id` e TEXT neste
--      projeto (nao existe tabela de usuarios; a sessao vem do cookie).
--   2. `resultado_pipeline_origem_id` -- a versao 1 nasce de uma saida
--      especifica da IA, e sem esse vinculo a unica forma de descobrir
--      qual seria por timestamp/"mais recente", exatamente o que a
--      arquitetura proibe. ON DELETE SET NULL para nunca apagar historico
--      editorial por causa de um artefato tecnico.
--   3. `request_id` -- duplo clique no botao "Salvar nova versao" criaria
--      duas versoes identicas. Com o unique parcial abaixo, a segunda
--      requisicao reencontra a primeira em vez de duplicar.
--   4. `origem` legado -- o CHECK so aceitava 'ia_openai', 'revisao_claude'
--      e 'edicao_manual'. A fonte real desta camada e
--      `adaptacao_marketplace`, e reaproveitar 'ia_openai' para isso
--      seria gravar um nome semanticamente FALSO so para evitar migration.
--      O CHECK e ampliado de forma ADITIVA: os tres valores legados
--      continuam validos.
--   5. UNIQUE PARCIAL de aprovacao -- nada impedia duas versoes aprovadas
--      ao mesmo tempo no mesmo canal. Agora o banco garante no maximo uma.
--
-- SEMANTICA DE `aprovado` (importante): `aprovado = true` significa "esta
-- e a versao aprovada ATUAL". Quando outra versao e aprovada, a anterior
-- volta a `false` mas **mantem** `aprovado_em`/`aprovado_por` -- o
-- historico de que ela ja foi aprovada uma vez nao e apagado.
--
-- Aditiva: nenhuma coluna removida, nenhuma constraint derrubada, nenhum
-- dado alterado.
-- ────────────────────────────────────────────────────────────────────

ALTER TABLE public.estudio_anuncios_conteudo_versoes
  ADD COLUMN IF NOT EXISTS criado_por                   TEXT,
  ADD COLUMN IF NOT EXISTS aprovado_por                 TEXT,
  ADD COLUMN IF NOT EXISTS request_id                   TEXT,
  ADD COLUMN IF NOT EXISTS resultado_pipeline_origem_id UUID
    REFERENCES public.estudio_anuncios_resultados_pipeline(id) ON DELETE SET NULL;

-- CHECK de origem ampliado de forma aditiva.
ALTER TABLE public.estudio_anuncios_conteudo_versoes
  DROP CONSTRAINT IF EXISTS estudio_anuncios_conteudo_versoes_origem_check;
ALTER TABLE public.estudio_anuncios_conteudo_versoes
  ADD CONSTRAINT estudio_anuncios_conteudo_versoes_origem_check
  CHECK (origem = ANY (ARRAY[
    'ia_openai',                  -- legado, preservado
    'revisao_claude',             -- legado, preservado
    'edicao_manual',
    'ia_adaptacao_marketplace'    -- NOVO: a fonte real da versao 1
  ]));

-- Coerencia de aprovacao: nao aprovado nao pode ter carimbo de "quem/quando"
-- SEM ter sido aprovado alguma vez -- mas aprovado exige os dois.
ALTER TABLE public.estudio_anuncios_conteudo_versoes
  DROP CONSTRAINT IF EXISTS chk_conteudo_versoes_aprovacao;
ALTER TABLE public.estudio_anuncios_conteudo_versoes
  ADD CONSTRAINT chk_conteudo_versoes_aprovacao
  CHECK (aprovado = false OR (aprovado_em IS NOT NULL AND aprovado_por IS NOT NULL));

-- NO MAXIMO UMA versao aprovada por canal -- garantido pelo BANCO, nao por
-- logica de aplicacao.
CREATE UNIQUE INDEX IF NOT EXISTS idx_conteudo_versoes_aprovada_unica
  ON public.estudio_anuncios_conteudo_versoes (projeto_marketplace_id)
  WHERE aprovado;

-- Idempotencia de criacao (duplo clique / retry de rede).
CREATE UNIQUE INDEX IF NOT EXISTS idx_conteudo_versoes_request
  ON public.estudio_anuncios_conteudo_versoes (projeto_marketplace_id, request_id)
  WHERE request_id IS NOT NULL;

COMMENT ON COLUMN public.estudio_anuncios_conteudo_versoes.origem IS
  'ia_adaptacao_marketplace = snapshot da saida oficial da IA (versao 1); edicao_manual = versao criada por pessoa. Valores ia_openai/revisao_claude sao legado preservado.';
COMMENT ON COLUMN public.estudio_anuncios_conteudo_versoes.aprovado IS
  'true = versao aprovada ATUAL deste canal (no maximo uma, garantido por indice unico parcial). Ao aprovar outra, esta volta a false mas mantem aprovado_em/aprovado_por como historico.';
COMMENT ON COLUMN public.estudio_anuncios_conteudo_versoes.resultado_pipeline_origem_id IS
  'Resultado de adaptacao_marketplace que originou a versao 1 deste canal. Responde "esta versao editorial nasceu de qual saida da IA" sem depender de timestamp.';

-- ────────────────────────────────────────────────────────────────────
-- RPC: criar versao editorial (atomica)
--
-- Resolve tres problemas de uma vez, todos dentro da MESMA transacao:
--   a) numero_versao sob concorrencia. `max(numero_versao)+1` sozinho e
--      inseguro: duas requisicoes simultaneas leem o mesmo max. Aqui a
--      linha pai (`projetos_marketplace`) e travada com FOR UPDATE, entao
--      a segunda requisicao espera e le o numero ja atualizado. O UNIQUE
--      `(projeto_marketplace_id, numero_versao)` continua como rede de
--      seguranca.
--   b) materializacao LAZY da versao 1. A camada editorial so passa a
--      existir quando ha intencao editorial real. Se ainda nao existe
--      nenhuma versao e o chamador passou o snapshot da IA, a versao 1
--      (origem ia_adaptacao_marketplace) e criada ANTES da versao do
--      usuario -- as duas na mesma transacao, nunca meia camada.
--   c) idempotencia por request_id (duplo clique).
-- ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.estudio_anuncios_criar_versao_conteudo(
  p_projeto_marketplace_id UUID,
  p_conteudo               JSONB,
  p_titulo                 TEXT,
  p_origem                 TEXT,
  p_criado_por             TEXT,
  p_request_id             TEXT DEFAULT NULL,
  p_base_conteudo          JSONB DEFAULT NULL,
  p_base_titulo            TEXT DEFAULT NULL,
  p_base_resultado_id      UUID DEFAULT NULL
)
RETURNS public.estudio_anuncios_conteudo_versoes
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_pm       public.estudio_anuncios_projetos_marketplace;
  v_existe   public.estudio_anuncios_conteudo_versoes;
  v_qtd      INTEGER;
  v_proximo  INTEGER;
  v_nova     public.estudio_anuncios_conteudo_versoes;
BEGIN
  -- Trava o canal: serializa criacoes concorrentes deste marketplace.
  SELECT * INTO v_pm
  FROM public.estudio_anuncios_projetos_marketplace
  WHERE id = p_projeto_marketplace_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MARKETPLACE_NAO_ENCONTRADO: %', p_projeto_marketplace_id;
  END IF;

  -- Idempotencia: mesma requisicao repetida devolve a versao ja criada.
  IF p_request_id IS NOT NULL THEN
    SELECT * INTO v_existe
    FROM public.estudio_anuncios_conteudo_versoes
    WHERE projeto_marketplace_id = p_projeto_marketplace_id
      AND request_id = p_request_id;
    IF FOUND THEN
      RETURN v_existe;
    END IF;
  END IF;

  SELECT count(*), coalesce(max(numero_versao), 0)
  INTO v_qtd, v_proximo
  FROM public.estudio_anuncios_conteudo_versoes
  WHERE projeto_marketplace_id = p_projeto_marketplace_id;

  -- Materializacao lazy da versao 1 (snapshot da IA), quando ainda nao ha
  -- nenhuma versao e o chamador forneceu a base.
  IF v_qtd = 0 AND p_base_conteudo IS NOT NULL THEN
    v_proximo := v_proximo + 1;
    INSERT INTO public.estudio_anuncios_conteudo_versoes
      (projeto_marketplace_id, numero_versao, origem, titulo_principal, conteudo,
       criado_por, resultado_pipeline_origem_id)
    VALUES
      (p_projeto_marketplace_id, v_proximo, 'ia_adaptacao_marketplace', p_base_titulo, p_base_conteudo,
       NULL, p_base_resultado_id);
  END IF;

  v_proximo := v_proximo + 1;

  INSERT INTO public.estudio_anuncios_conteudo_versoes
    (projeto_marketplace_id, numero_versao, origem, titulo_principal, conteudo,
     criado_por, request_id, resultado_pipeline_origem_id)
  VALUES
    (p_projeto_marketplace_id, v_proximo, p_origem, p_titulo, p_conteudo,
     p_criado_por, p_request_id, p_base_resultado_id)
  RETURNING * INTO v_nova;

  RETURN v_nova;
END;
$$;

COMMENT ON FUNCTION public.estudio_anuncios_criar_versao_conteudo IS
  'Cria uma versao editorial de forma atomica: trava o canal (FOR UPDATE) para numerar sob concorrencia, materializa lazily a versao 1 a partir do snapshot da IA quando ainda nao existe nenhuma, e e idempotente por request_id. NUNCA faz UPDATE de versao anterior -- append-only.';

REVOKE EXECUTE ON FUNCTION public.estudio_anuncios_criar_versao_conteudo(UUID, JSONB, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.estudio_anuncios_criar_versao_conteudo(UUID, JSONB, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, UUID)
  TO service_role;

-- ────────────────────────────────────────────────────────────────────
-- RPC: aprovar versao (troca atomica)
--
-- Rebaixar a anterior e promover a nova em duas chamadas independentes
-- deixaria uma janela com zero (ou duas) versoes aprovadas. Aqui as duas
-- operacoes acontecem na mesma transacao, com o canal travado. A versao
-- rebaixada MANTEM aprovado_em/aprovado_por -- historico nao se apaga.
-- ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.estudio_anuncios_aprovar_versao_conteudo(
  p_versao_id    UUID,
  p_aprovado_por TEXT
)
RETURNS public.estudio_anuncios_conteudo_versoes
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_versao public.estudio_anuncios_conteudo_versoes;
BEGIN
  SELECT * INTO v_versao
  FROM public.estudio_anuncios_conteudo_versoes
  WHERE id = p_versao_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'VERSAO_NAO_ENCONTRADA: %', p_versao_id;
  END IF;

  PERFORM 1
  FROM public.estudio_anuncios_projetos_marketplace
  WHERE id = v_versao.projeto_marketplace_id
  FOR UPDATE;

  -- Rebaixa a aprovada atual (se houver e se nao for a propria).
  UPDATE public.estudio_anuncios_conteudo_versoes
  SET aprovado = false
  WHERE projeto_marketplace_id = v_versao.projeto_marketplace_id
    AND aprovado
    AND id <> p_versao_id;

  UPDATE public.estudio_anuncios_conteudo_versoes
  SET aprovado = true,
      aprovado_em = now(),
      aprovado_por = p_aprovado_por
  WHERE id = p_versao_id
  RETURNING * INTO v_versao;

  RETURN v_versao;
END;
$$;

COMMENT ON FUNCTION public.estudio_anuncios_aprovar_versao_conteudo IS
  'Aprova uma versao editorial trocando a aprovada atual do canal ATOMICAMENTE (rebaixa a anterior e promove a nova na mesma transacao, com o canal travado). A versao rebaixada mantem aprovado_em/aprovado_por como historico. Nunca apaga nem reescreve conteudo.';

REVOKE EXECUTE ON FUNCTION public.estudio_anuncios_aprovar_versao_conteudo(UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.estudio_anuncios_aprovar_versao_conteudo(UUID, TEXT)
  TO service_role;
