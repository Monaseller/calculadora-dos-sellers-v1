-- ────────────────────────────────────────────────────────────────────
-- Migration: estudio_anuncios_pipeline_iniciar() — exigir pelo menos 1
-- foto original antes de permitir o início do Pipeline.
--
-- CONTEXTO / BUG CORRIGIDO: o teste real "projeto sem fotos" (Fase 2 de
-- validação funcional do Gemini) mostrou que era possível chamar esta
-- RPC (via rota POST /api/estudio-anuncios/projetos/[id]/pipeline/iniciar)
-- para um projeto com ZERO fotos em estudio_anuncios_imagens_origem — o
-- Pipeline era criado normalmente, o job de analise_visual era
-- reivindicado pelo Worker, e só então falhava dentro do executor
-- (executarAnaliseVisualGoogle(), erro_tipo='validation', "Nenhuma foto
-- válida encontrada..."). Isso contraria a regra de negócio já aprovada
-- de que um projeto só pode iniciar a geração quando tiver pelo menos 1
-- foto original válida — a regra deve impedir a CRIAÇÃO do Pipeline/job,
-- não apenas ser detectada depois, gastando um ciclo do Worker.
--
-- Esta migration substitui SOMENTE a função
-- public.estudio_anuncios_pipeline_iniciar(UUID), definida originalmente
-- em 20260807_estudio_anuncios_iniciar_pipeline_rpc.sql (não alterada —
-- convenção do projeto é sempre criar uma migration nova, nunca editar
-- uma já executada). Toda a lógica existente é preservada seguindo
-- exatamente o mesmo corpo: lock do projeto, rejeição de
-- cancelado/concluido, checagem de idempotência (Pipeline já existente),
-- localização de etapa/subetapa obrigatória do catálogo, criação atômica
-- de Pipeline + job, RETURNS TABLE com criado_agora, SECURITY INVOKER,
-- search_path fixo, e o mesmo REVOKE/GRANT restrito a service_role.
--
-- ÚNICA MUDANÇA: uma nova checagem "(3b)", inserida IMEDIATAMENTE DEPOIS
-- da checagem de idempotência (3) e ANTES da localização da 1ª etapa do
-- catálogo (4) — ou seja, só é avaliada quando a função está prestes a
-- criar um Pipeline novo; nunca bloqueia a leitura idempotente de um
-- Pipeline que já existe (mesmo que, por algum motivo futuro, as fotos
-- do projeto tenham sido todas removidas depois do Pipeline já ter
-- iniciado — esse cenário não é reavaliado aqui, só a criação inicial).
--
-- FIX AMBIGUIDADE (mesmo cuidado já documentado/aplicado no resto desta
-- função, ver 20260807): a nova checagem usa
-- `public.estudio_anuncios_imagens_origem.projeto_id = p_projeto_id`
-- totalmente qualificado, e NÃO a forma "bare" `projeto_id = p_projeto_id`
-- — porque `projeto_id` é um dos nomes da lista RETURNS TABLE, logo o
-- Postgres o declara implicitamente como variável OUT visível em toda a
-- função; uma referência não-qualificada dentro do EXISTS colidiria com
-- essa variável (mesma classe de bug já corrigida em 20260807 para "id",
-- "projeto_id" e "versao_catalogo" em outros pontos da função).
--
-- Nenhuma tabela alterada. Nenhum dado de projeto real inserido por esta
-- migration (só a definição da função).
--
-- NÃO EXECUTAR sem aprovação — ver apresentação no chat.
-- ────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.estudio_anuncios_pipeline_iniciar(
  p_projeto_id UUID
)
RETURNS TABLE (
  id               UUID,
  projeto_id       UUID,
  etapa_atual      TEXT,
  status           TEXT,
  job_atual_id     UUID,
  proxima_etapa    TEXT,
  versao_catalogo  INTEGER,
  versao_pipeline  INTEGER,
  ultima_execucao  TIMESTAMPTZ,
  proxima_execucao TIMESTAMPTZ,
  erro_tipo        TEXT,
  erro_mensagem    TEXT,
  criado_em        TIMESTAMPTZ,
  atualizado_em    TIMESTAMPTZ,
  concluido_em     TIMESTAMPTZ,
  cancelado_em     TIMESTAMPTZ,
  criado_agora     BOOLEAN
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_projeto           public.estudio_anuncios_projetos;
  v_pipeline           public.estudio_anuncios_pipeline;
  v_primeira_etapa     public.estudio_anuncios_pipeline_catalogo;
  v_primeira_subetapa  public.estudio_anuncios_pipeline_catalogo_jobs;
  v_novo_job_id        UUID;
  v_versao_catalogo    CONSTANT INTEGER := 1;
  v_versao_pipeline    CONSTANT INTEGER := 1;
BEGIN
  -- (1) Lock do projeto — serializa chamadas concorrentes para o MESMO
  -- projeto (2 requisições simultâneas de "iniciar" não podem, juntas,
  -- criar 2 pipelines: a segunda só enxerga o estado depois que a
  -- primeira já commitou o INSERT).
  SELECT * INTO v_projeto
  FROM public.estudio_anuncios_projetos
  WHERE public.estudio_anuncios_projetos.id = p_projeto_id  -- FIX AMBIGUIDADE: "id" bare colidia com o OUT param "id"
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROJETO_NAO_ENCONTRADO: projeto % não encontrado', p_projeto_id;
  END IF;

  -- (2) Ver nota "ADIÇÃO SINALIZADA" no cabeçalho da migration original
  -- (20260807) — defesa extra além da checagem já feita pela rota.
  IF v_projeto.status = 'cancelado' THEN
    RAISE EXCEPTION 'PROJETO_CANCELADO: projeto % está cancelado', p_projeto_id;
  END IF;

  IF v_projeto.status = 'concluido' THEN
    RAISE EXCEPTION 'PROJETO_CONCLUIDO: projeto % já está concluído', p_projeto_id;
  END IF;

  -- (3) Já existe Pipeline para este projeto? UNIQUE em
  -- estudio_anuncios_pipeline.projeto_id garante no máximo 1 linha —
  -- aqui só lemos para decidir "criar" vs "devolver o que já existe".
  -- FOR UPDATE aqui é redundante com o lock do projeto acima (nenhum
  -- outro código cria a 1ª linha de pipeline de um projeto além desta
  -- função), mantido por defesa em profundidade, sem custo relevante.
  SELECT * INTO v_pipeline
  FROM public.estudio_anuncios_pipeline
  WHERE public.estudio_anuncios_pipeline.projeto_id = p_projeto_id  -- FIX AMBIGUIDADE: "projeto_id" bare colidia com o OUT param "projeto_id"
  FOR UPDATE;

  IF FOUND THEN
    -- Idempotente — nunca duplica, devolve o estado atual tal como
    -- está, sem alterar nada. A ROTA decide o código HTTP (200 se
    -- não-terminal, 409 se concluido/cancelado) olhando o status
    -- devolvido; esta função não decide HTTP. Note que a checagem de
    -- foto (3b) abaixo NUNCA é alcançada neste caminho — um Pipeline já
    -- existente é sempre devolvido tal como está, nunca bloqueado
    -- retroativamente por falta de foto.
    RETURN QUERY SELECT
      v_pipeline.id, v_pipeline.projeto_id, v_pipeline.etapa_atual, v_pipeline.status,
      v_pipeline.job_atual_id, v_pipeline.proxima_etapa, v_pipeline.versao_catalogo,
      v_pipeline.versao_pipeline, v_pipeline.ultima_execucao, v_pipeline.proxima_execucao,
      v_pipeline.erro_tipo, v_pipeline.erro_mensagem, v_pipeline.criado_em, v_pipeline.atualizado_em,
      v_pipeline.concluido_em, v_pipeline.cancelado_em, false;
    RETURN;
  END IF;

  -- (3b) NOVO — exige pelo menos 1 foto original válida antes de criar
  -- o Pipeline. Só chega aqui quando vamos de fato criar um Pipeline
  -- novo (o caso idempotente já retornou acima). Qualificado com o nome
  -- completo da tabela (ver "FIX AMBIGUIDADE" no cabeçalho) porque
  -- "projeto_id" bare colidiria com o parâmetro OUT de mesmo nome.
  IF NOT EXISTS (
    SELECT 1
    FROM public.estudio_anuncios_imagens_origem
    WHERE public.estudio_anuncios_imagens_origem.projeto_id = p_projeto_id
  ) THEN
    RAISE EXCEPTION
      'PROJETO_SEM_FOTOS: adicione pelo menos uma foto original antes de iniciar o Pipeline';
  END IF;

  -- (4) Localiza a primeira etapa OBRIGATÓRIA ativa do catálogo (versão
  -- travada em 1 nesta função — mesma decisão já usada em
  -- iniciarPipeline()/pipeline.ts e nas RPCs de avanço/falha).
  SELECT * INTO v_primeira_etapa
  FROM public.estudio_anuncios_pipeline_catalogo
  WHERE public.estudio_anuncios_pipeline_catalogo.versao_catalogo = v_versao_catalogo  -- FIX AMBIGUIDADE: "versao_catalogo" bare colidia com o OUT param "versao_catalogo"
    AND ativa = true
    AND tipo = 'obrigatoria'
  ORDER BY ordem ASC
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CATALOGO_SEM_ETAPA_OBRIGATORIA: catálogo (versão %) não tem nenhuma etapa obrigatória ativa', v_versao_catalogo;
  END IF;

  -- (5) Localiza a primeira subetapa OBRIGATÓRIA dessa etapa.
  SELECT * INTO v_primeira_subetapa
  FROM public.estudio_anuncios_pipeline_catalogo_jobs
  WHERE catalogo_id = v_primeira_etapa.id
    AND obrigatoria = true
  ORDER BY ordem ASC
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CATALOGO_SEM_SUBETAPA_OBRIGATORIA: etapa "%" não tem nenhuma subetapa obrigatória cadastrada', v_primeira_etapa.etapa;
  END IF;

  -- (6) Cria o Pipeline (estado inicial "criado" — vira "aguardando" no
  -- passo 8, depois de já ter etapa_atual/job_atual_id definidos).
  INSERT INTO public.estudio_anuncios_pipeline (
    projeto_id, versao_catalogo, versao_pipeline, status
  ) VALUES (
    p_projeto_id, v_versao_catalogo, v_versao_pipeline, 'criado'
  )
  RETURNING * INTO v_pipeline;

  -- (7) Cria o primeiro job, pendente, com max_tentativas herdado da
  -- etapa ampla no catálogo.
  INSERT INTO public.estudio_anuncios_jobs (
    projeto_id, etapa, status, max_tentativas
  ) VALUES (
    p_projeto_id, v_primeira_subetapa.job_etapa, 'pendente', v_primeira_etapa.max_tentativas
  )
  RETURNING public.estudio_anuncios_jobs.id INTO v_novo_job_id;  -- FIX AMBIGUIDADE: "id" bare colidia com o OUT param "id"

  -- (8) Atualiza o Pipeline com a etapa/job atuais e deixa em
  -- "aguardando" — pronto para claim_next_estudio_anuncios_job() (não
  -- chamada por esta função; o Worker reivindica o job no ciclo dele).
  UPDATE public.estudio_anuncios_pipeline
  SET etapa_atual      = v_primeira_etapa.etapa,
      job_atual_id     = v_novo_job_id,
      status           = 'aguardando',
      ultima_execucao  = now(),
      atualizado_em    = now()
  WHERE public.estudio_anuncios_pipeline.id = v_pipeline.id  -- FIX AMBIGUIDADE: "id" bare colidia com o OUT param "id"
  RETURNING * INTO v_pipeline;

  RETURN QUERY SELECT
    v_pipeline.id, v_pipeline.projeto_id, v_pipeline.etapa_atual, v_pipeline.status,
    v_pipeline.job_atual_id, v_pipeline.proxima_etapa, v_pipeline.versao_catalogo,
    v_pipeline.versao_pipeline, v_pipeline.ultima_execucao, v_pipeline.proxima_execucao,
    v_pipeline.erro_tipo, v_pipeline.erro_mensagem, v_pipeline.criado_em, v_pipeline.atualizado_em,
    v_pipeline.concluido_em, v_pipeline.cancelado_em, true;
END;
$$;

COMMENT ON FUNCTION public.estudio_anuncios_pipeline_iniciar(UUID) IS
  'Cria atomicamente o Pipeline + o primeiro job (1ª subetapa obrigatória da 1ª etapa obrigatória ativa do catálogo versão 1) para um projeto que ainda não tem Pipeline, desde que o projeto já tenha pelo menos 1 foto original em estudio_anuncios_imagens_origem (senão RAISE EXCEPTION PROJETO_SEM_FOTOS). Idempotente: se o projeto já tem Pipeline, devolve a linha existente sem duplicar e sem alterar nada (criado_agora=false) — a exigência de foto não é reavaliada nesse caminho. Lock FOR UPDATE na linha do projeto evita duplicidade em chamadas concorrentes. Nunca avança etapa, nunca chama Gateway/Worker. Restrita a service_role — ver REVOKE/GRANT abaixo.';

-- Restrição de permissão — mesmo padrão das demais RPCs restritas deste
-- módulo (criar_projeto_estudio_anuncios, pipeline_avancar,
-- pipeline_registrar_falha, pipeline_concluir_job, pipeline_falhar_job):
-- recebe p_projeto_id cru, sem verificação de sessão possível dentro da
-- própria função — a defesa fica inteiramente na rota, que só chama com
-- um cliente server-only (service_role) depois de validar a sessão.
-- CREATE OR REPLACE FUNCTION não reseta permissões já concedidas, mas o
-- REVOKE/GRANT é repetido aqui por completude/auto-suficiência desta
-- migration (idempotente — reexecutar não tem efeito colateral).
REVOKE EXECUTE ON FUNCTION public.estudio_anuncios_pipeline_iniciar(UUID)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.estudio_anuncios_pipeline_iniciar(UUID)
  TO service_role;
