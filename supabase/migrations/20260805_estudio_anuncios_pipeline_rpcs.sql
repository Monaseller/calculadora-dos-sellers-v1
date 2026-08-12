-- ────────────────────────────────────────────────────────────────────
-- Migration: Pipeline Orchestrator — Fase 1 (RPCs)
--
-- Nomes definitivos (decisão congelada): estudio_anuncios_pipeline_avancar()
-- e estudio_anuncios_pipeline_registrar_falha(). Depende das tabelas de
-- supabase/migrations/20260805_estudio_anuncios_pipeline_schema.sql
-- (deve ser executada ANTES desta).
--
-- Mesmo padrão de segurança já aprovado para criar_projeto_estudio_anuncios():
-- SECURITY INVOKER, search_path fixo, REVOKE explícito de PUBLIC/anon/
-- authenticated, GRANT só para service_role. Chamadas exclusivamente
-- pela rota interna (server-only), nunca pelo cliente anon/browser.
--
-- ESCOPO DA FASE 1 (decisão feita nesta migration, sinalizada no chat
-- antes de escrever o SQL, não silenciosa): sem uma função de
-- avaliação de aplicabilidade (Decisão Aberta #4 da arquitetura —
-- "busca_externa só quando necessária", detecção de pendências
-- bloqueantes, vídeo solicitado ou não), a RPC de avanço só consegue
-- avançar automaticamente por etapas/subetapas marcadas
-- tipo='obrigatoria' / obrigatoria=true. Etapas 'condicional' e
-- 'manual' (pendencias, gerar_video, exportacao) ficam no catálogo mas
-- NUNCA são disparadas automaticamente por esta versão da RPC — isso é
-- consistente com "não implementar upload/IA/imagens/vídeo/exportação/
-- busca externa" desta tarefa, mas é uma escolha de comportamento real,
-- não só uma limitação de infraestrutura. Fluxo automático resultante
-- na Fase 1: ANALISE_PRODUTO → GERAR_CONTEUDO → GERAR_IMAGENS →
-- AVALIACAO → CONCLUIDO.
-- ────────────────────────────────────────────────────────────────────


-- ────────────────────────────────────────────────────────────────────
-- estudio_anuncios_pipeline_avancar(p_pipeline_id, p_job_id)
--
-- Chamada pela rota interna quando um job termina com SUCESSO (job já
-- marcado 'concluido' pela própria rota, ANTES desta chamada). Decide
-- e executa atomicamente: próxima subetapa da mesma etapa ampla, OU
-- próxima etapa ampla aplicável (tipo='obrigatoria'), OU conclusão do
-- pipeline.
-- ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.estudio_anuncios_pipeline_avancar(
  p_pipeline_id UUID,
  p_job_id      UUID
)
RETURNS public.estudio_anuncios_pipeline
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_pipeline              public.estudio_anuncios_pipeline;
  v_job                   public.estudio_anuncios_jobs;
  v_catalogo_atual        public.estudio_anuncios_pipeline_catalogo;
  v_subetapa_atual        public.estudio_anuncios_pipeline_catalogo_jobs;
  v_proxima_subetapa      public.estudio_anuncios_pipeline_catalogo_jobs;
  v_proxima_etapa_row     public.estudio_anuncios_pipeline_catalogo;
  v_primeira_subetapa     public.estudio_anuncios_pipeline_catalogo_jobs;
  v_novo_job_id           UUID;
BEGIN
  -- 1) Lock da linha do pipeline — impede duas chamadas concorrentes
  -- para o mesmo pipeline de avançarem ao mesmo tempo.
  SELECT * INTO v_pipeline
  FROM public.estudio_anuncios_pipeline
  WHERE id = p_pipeline_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'pipeline % não encontrado', p_pipeline_id;
  END IF;

  -- 2) AJUSTE (revisão 2026-08-05): antes esta checagem retornava
  -- v_pipeline silenciosamente quando job_atual_id não batia (tratado
  -- como "chamada duplicada, no-op seguro"). Por pedido explícito, isso
  -- agora é erro explícito — job_atual_id não bater é considerado erro
  -- de programação do chamador (rota interna chamando com o job
  -- errado, ou chamando 2x sem checar o estado antes), não algo a
  -- mascarar. Quem chama esta função é responsável por só chamar
  -- quando tem certeza de que job_id é o job_atual_id corrente.
  IF v_pipeline.job_atual_id IS DISTINCT FROM p_job_id THEN
    RAISE EXCEPTION 'USO_INVALIDO_PIPELINE: job informado não corresponde ao job atual do pipeline (pipeline=%, job_atual_id=%, job_informado=%)',
      p_pipeline_id, v_pipeline.job_atual_id, p_job_id;
  END IF;

  -- Mesmo ajuste: só avança a partir de EM_EXECUCAO — qualquer outro
  -- status agora é erro explícito, não mais no-op silencioso.
  IF v_pipeline.status <> 'em_execucao' THEN
    RAISE EXCEPTION 'PIPELINE_NAO_ESTA_EM_EXECUCAO: status atual é "%" (pipeline=%)', v_pipeline.status, p_pipeline_id;
  END IF;

  -- 3) Confirma que o job realmente terminou com sucesso — a rota
  -- interna deveria SEMPRE marcar o job antes de chamar esta RPC; se
  -- não estiver 'concluido', é erro de uso da rota, não algo a
  -- silenciar.
  SELECT * INTO v_job FROM public.estudio_anuncios_jobs WHERE id = p_job_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'job % não encontrado', p_job_id;
  END IF;
  IF v_job.status <> 'concluido' THEN
    RAISE EXCEPTION 'job % não está concluído (status atual: %)', p_job_id, v_job.status;
  END IF;

  -- 4) Localiza a etapa ampla atual no catálogo (versão travada no pipeline).
  SELECT * INTO v_catalogo_atual
  FROM public.estudio_anuncios_pipeline_catalogo
  WHERE versao_catalogo = v_pipeline.versao_catalogo
    AND etapa = v_pipeline.etapa_atual;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'etapa "%" não encontrada no catálogo (versão %)', v_pipeline.etapa_atual, v_pipeline.versao_catalogo;
  END IF;

  -- 5) Localiza a subetapa que acabou de rodar.
  SELECT * INTO v_subetapa_atual
  FROM public.estudio_anuncios_pipeline_catalogo_jobs
  WHERE catalogo_id = v_catalogo_atual.id
    AND job_etapa = v_job.etapa;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'subetapa "%" não encontrada no catálogo para a etapa "%"', v_job.etapa, v_catalogo_atual.etapa;
  END IF;

  -- 6) Há mais uma subetapa OBRIGATÓRIA dentro da mesma etapa ampla?
  -- (Fase 1: subetapas não-obrigatórias, ex. busca_externa, nunca são
  -- disparadas automaticamente — ver nota no cabeçalho.)
  SELECT * INTO v_proxima_subetapa
  FROM public.estudio_anuncios_pipeline_catalogo_jobs
  WHERE catalogo_id = v_catalogo_atual.id
    AND ordem > v_subetapa_atual.ordem
    AND obrigatoria = true
  ORDER BY ordem ASC
  LIMIT 1;

  IF FOUND THEN
    -- 7) Cria o job da próxima subetapa, dentro da MESMA etapa ampla.
    INSERT INTO public.estudio_anuncios_jobs (projeto_id, etapa, status, max_tentativas)
    VALUES (v_pipeline.projeto_id, v_proxima_subetapa.job_etapa, 'pendente', v_catalogo_atual.max_tentativas)
    RETURNING id INTO v_novo_job_id;

    UPDATE public.estudio_anuncios_pipeline
    SET job_atual_id = v_novo_job_id,
        status = 'aguardando',
        ultima_execucao = now(),
        atualizado_em = now()
    WHERE id = p_pipeline_id
    RETURNING * INTO v_pipeline;

    RETURN v_pipeline;
  END IF;

  -- 8) Etapa ampla atual terminou (todas as subetapas obrigatórias
  -- concluídas). Localiza a próxima etapa ampla ATIVA e OBRIGATÓRIA
  -- (ver nota no cabeçalho — condicional/manual não avança sozinha
  -- nesta fase).
  SELECT * INTO v_proxima_etapa_row
  FROM public.estudio_anuncios_pipeline_catalogo
  WHERE versao_catalogo = v_pipeline.versao_catalogo
    AND ordem > v_catalogo_atual.ordem
    AND ativa = true
    AND tipo = 'obrigatoria'
  ORDER BY ordem ASC
  LIMIT 1;

  IF NOT FOUND THEN
    -- 9) Não há mais etapa aplicável — pipeline concluído.
    -- etapa_atual/job_atual_id permanecem apontando para a última
    -- etapa/job executados (histórico), não são zerados.
    UPDATE public.estudio_anuncios_pipeline
    SET status = 'concluido',
        proxima_etapa = NULL,
        concluido_em = now(),
        ultima_execucao = now(),
        atualizado_em = now()
    WHERE id = p_pipeline_id
    RETURNING * INTO v_pipeline;

    RETURN v_pipeline;
  END IF;

  -- 10) Cria o job da primeira subetapa obrigatória da próxima etapa ampla.
  SELECT * INTO v_primeira_subetapa
  FROM public.estudio_anuncios_pipeline_catalogo_jobs
  WHERE catalogo_id = v_proxima_etapa_row.id
    AND obrigatoria = true
  ORDER BY ordem ASC
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'etapa "%" está ativa e obrigatória mas não tem nenhuma subetapa obrigatória cadastrada', v_proxima_etapa_row.etapa;
  END IF;

  INSERT INTO public.estudio_anuncios_jobs (projeto_id, etapa, status, max_tentativas)
  VALUES (v_pipeline.projeto_id, v_primeira_subetapa.job_etapa, 'pendente', v_proxima_etapa_row.max_tentativas)
  RETURNING id INTO v_novo_job_id;

  UPDATE public.estudio_anuncios_pipeline
  SET etapa_atual = v_proxima_etapa_row.etapa,
      job_atual_id = v_novo_job_id,
      status = 'aguardando',
      ultima_execucao = now(),
      atualizado_em = now()
  WHERE id = p_pipeline_id
  RETURNING * INTO v_pipeline;

  RETURN v_pipeline;
END;
$$;

COMMENT ON FUNCTION public.estudio_anuncios_pipeline_avancar(UUID, UUID) IS
  'Avança o Pipeline após um job concluir com sucesso — cria o próximo job (mesma etapa ou próxima etapa ampla obrigatória) ou marca o pipeline concluído, atomicamente. NÃO é tolerante a chamada duplicada/fora de ordem — job_atual_id divergente ou status != em_execucao lançam exceção explícita (USO_INVALIDO_PIPELINE / PIPELINE_NAO_ESTA_EM_EXECUCAO), por decisão explícita (revisão 2026-08-05): tratado como erro de programação do chamador, não mascarado. Restrita a service_role.';


-- ────────────────────────────────────────────────────────────────────
-- estudio_anuncios_pipeline_registrar_falha(p_pipeline_id, p_job_id, p_erro_tipo, p_erro_mensagem)
--
-- Chamada pela rota interna quando um job termina em FALHA (job já
-- marcado 'erro' pela própria rota, ANTES desta chamada). Decide
-- atomicamente: reenviar o mesmo job para 'pendente' (ainda cabe
-- tentativa) ou marcar o pipeline em erro (tentativas esgotadas).
-- ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.estudio_anuncios_pipeline_registrar_falha(
  p_pipeline_id   UUID,
  p_job_id        UUID,
  p_erro_tipo     TEXT,
  p_erro_mensagem TEXT
)
RETURNS public.estudio_anuncios_pipeline
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_pipeline  public.estudio_anuncios_pipeline;
  v_job       public.estudio_anuncios_jobs;
BEGIN
  -- 1) Lock da linha do pipeline.
  SELECT * INTO v_pipeline
  FROM public.estudio_anuncios_pipeline
  WHERE id = p_pipeline_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'pipeline % não encontrado', p_pipeline_id;
  END IF;

  -- 2) Mesmo ajuste da RPC de avanço (revisão 2026-08-05): job_atual_id
  -- divergente ou status != em_execucao agora são erro explícito, não
  -- mais no-op silencioso — ver comentário completo em
  -- estudio_anuncios_pipeline_avancar() acima.
  IF v_pipeline.job_atual_id IS DISTINCT FROM p_job_id THEN
    RAISE EXCEPTION 'USO_INVALIDO_PIPELINE: job informado não corresponde ao job atual do pipeline (pipeline=%, job_atual_id=%, job_informado=%)',
      p_pipeline_id, v_pipeline.job_atual_id, p_job_id;
  END IF;

  IF v_pipeline.status <> 'em_execucao' THEN
    RAISE EXCEPTION 'PIPELINE_NAO_ESTA_EM_EXECUCAO: status atual é "%" (pipeline=%)', v_pipeline.status, p_pipeline_id;
  END IF;

  -- 3) Confirma que o job realmente falhou.
  SELECT * INTO v_job FROM public.estudio_anuncios_jobs WHERE id = p_job_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'job % não encontrado', p_job_id;
  END IF;
  IF v_job.status <> 'erro' THEN
    RAISE EXCEPTION 'job % não está em erro (status atual: %)', p_job_id, v_job.status;
  END IF;

  -- 4) Ainda cabe tentativa? tentativas/max_tentativas são sempre lidos
  -- do JOB (fonte única — pipeline não mantém contador próprio).
  IF v_job.tentativas < v_job.max_tentativas THEN
    -- Devolve a MESMA linha para 'pendente' — não zera tentativas, não
    -- cria um novo job. O próximo claim_next_estudio_anuncios_job()
    -- incrementa tentativas de novo.
    UPDATE public.estudio_anuncios_jobs
    SET status = 'pendente',
        erro_tipo = NULL,
        erro_mensagem = NULL
    WHERE id = p_job_id;

    UPDATE public.estudio_anuncios_pipeline
    SET status = 'aguardando',
        erro_tipo = NULL,
        erro_mensagem = NULL,
        atualizado_em = now()
    WHERE id = p_pipeline_id
    RETURNING * INTO v_pipeline;

    RETURN v_pipeline;
  END IF;

  -- 5) Tentativas esgotadas — pipeline vai para erro. Job permanece
  -- 'erro' (não é resetado).
  UPDATE public.estudio_anuncios_pipeline
  SET status = 'erro',
      erro_tipo = p_erro_tipo,
      erro_mensagem = p_erro_mensagem,
      atualizado_em = now()
  WHERE id = p_pipeline_id
  RETURNING * INTO v_pipeline;

  RETURN v_pipeline;
END;
$$;

COMMENT ON FUNCTION public.estudio_anuncios_pipeline_registrar_falha(UUID, UUID, TEXT, TEXT) IS
  'Registra a falha de um job do Pipeline — reenvia o mesmo job para pendente (retry) se ainda houver tentativas, ou marca o pipeline em erro (tentativas esgotadas), atomicamente. NÃO é tolerante a chamada duplicada/fora de ordem — mesmo comportamento de erro explícito de estudio_anuncios_pipeline_avancar() (revisão 2026-08-05). Restrita a service_role.';


-- ────────────────────────────────────────────────────────────────────
-- Permissões — mesmo padrão de criar_projeto_estudio_anuncios(): ambas
-- as funções recebem parâmetros que, se chamáveis pela chave anon,
-- permitiriam manipular o estado de qualquer pipeline sem passar pela
-- validação de sessão da rota. Restritas a service_role.
-- ────────────────────────────────────────────────────────────────────
REVOKE EXECUTE ON FUNCTION public.estudio_anuncios_pipeline_avancar(UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.estudio_anuncios_pipeline_avancar(UUID, UUID)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.estudio_anuncios_pipeline_registrar_falha(UUID, UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.estudio_anuncios_pipeline_registrar_falha(UUID, UUID, TEXT, TEXT)
  TO service_role;
