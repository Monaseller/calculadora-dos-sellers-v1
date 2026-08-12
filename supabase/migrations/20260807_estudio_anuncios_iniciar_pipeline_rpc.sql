-- ────────────────────────────────────────────────────────────────────
-- Migration: estudio_anuncios_pipeline_iniciar() — RPC de inicialização
-- atômica do Pipeline (Central de IA / Estúdio de Anúncios).
--
-- Contexto: iniciarPipeline() em lib/estudio-anuncios/pipeline/pipeline.ts
-- já faz esta mesma sequência (criar Pipeline → localizar 1ª etapa/
-- subetapa obrigatória do catálogo → criar 1º job → atualizar o
-- Pipeline com job_atual_id), mas como 3 escritas sequenciais em
-- TypeScript, sem transação — o próprio comentário da função já
-- documenta isso como risco aceito ("se cair no meio, o pipeline fica
-- em status='criado' com job_atual_id=NULL"). Essa função NÃO é
-- chamada por nenhuma rota hoje. Esta migration propõe uma RPC que
-- substitui esse uso (iniciarPipeline() é mantida no arquivo só como
-- histórico/comparação, sem ser chamada por nenhum código novo).
--
-- Mesmo padrão de segurança já aprovado para criar_projeto_estudio_anuncios()
-- e para as RPCs de avanço/falha: SECURITY INVOKER, search_path fixo,
-- REVOKE explícito de PUBLIC/anon/authenticated, GRANT só para
-- service_role. Chamada exclusivamente pela nova rota
-- POST /api/estudio-anuncios/projetos/[id]/pipeline/iniciar (server-only,
-- depois de getUserId(request) + buscarProjetoPorId() confirmarem sessão
-- e propriedade do projeto) — nunca pelo cliente anon/browser.
--
-- IDEMPOTÊNCIA / CONCORRÊNCIA: a função dá lock (FOR UPDATE) na linha do
-- PROJETO antes de decidir qualquer coisa — isso serializa chamadas
-- concorrentes para o MESMO projeto (a segunda só roda depois que a
-- primeira já commitou), então nunca duas transações simultâneas veem
-- "sem pipeline" ao mesmo tempo e criam 2 linhas. O UNIQUE já existente
-- em estudio_anuncios_pipeline.projeto_id continua como cinto-e-suspensório,
-- mas não é o mecanismo principal de idempotência aqui.
--
-- ADIÇÃO SINALIZADA, NÃO PEDIDA EXPLICITAMENTE NA TAREFA: a função
-- também rejeita explicitamente projeto.status IN ('cancelado','concluido')
-- (RAISE EXCEPTION PROJETO_CANCELADO / PROJETO_CONCLUIDO), mesmo a rota
-- já validando isso antes de chamar. Motivo: a checagem da rota e esta
-- chamada são 2 round-trips separados (janela TOCTOU); mesmo princípio
-- de "não confiar só em TypeScript" já usado em criar_projeto_estudio_anuncios().
-- Se isso não for desejado, é só remover as 2 checagens marcadas "(2)"
-- abaixo antes de executar — o resto da função não depende delas.
--
-- ESCOPO: cria exatamente 1 Pipeline + 1 job por chamada nova; nunca
-- avança etapas, nunca chama o Gateway, nunca chama o Worker. Etapas/
-- subetapas condicionais e manuais (pendencias, gerar_video, exportacao)
-- não são consideradas — mesma decisão já congelada nas RPCs de avanço/
-- falha (só tipo='obrigatoria' / obrigatoria=true avança automaticamente
-- na Fase 1).
--
-- Nenhuma tabela alterada. Nenhum dado de projeto real inserido por
-- esta migration (só a definição da função).
--
-- NÃO EXECUTAR sem aprovação — ver apresentação no chat.
--
-- CORREÇÃO (2026-08-05, achada no teste funcional real — 1ª tentativa
-- de chamada real da RPC, ANTES desta correção, falhou com "column
-- reference "id" is ambiguous"): `RETURNS TABLE (id UUID, projeto_id
-- UUID, ..., versao_catalogo INTEGER, ...)` é açúcar sintático para
-- parâmetros OUT — o Postgres declara `id`, `projeto_id`,
-- `versao_catalogo` (e os demais nomes de coluna do RETURNS TABLE)
-- como VARIÁVEIS PL/pgSQL implícitas, visíveis em toda a função. Como
-- essas mesmas palavras também são nomes de coluna reais nas tabelas
-- consultadas (estudio_anuncios_projetos.id,
-- estudio_anuncios_pipeline.projeto_id,
-- estudio_anuncios_pipeline_catalogo.versao_catalogo), toda referência
-- NÃO qualificada a esses nomes dentro de um WHERE/RETURNING vira
-- ambígua entre "a variável OUT" e "a coluna da tabela". As RPCs
-- irmãs (estudio_anuncios_pipeline_avancar/_registrar_falha) nunca
-- tiveram esse problema porque devolvem `RETURNS
-- public.estudio_anuncios_pipeline` (um composto único, sem lista de
-- OUT params) — só esta função, por usar RETURNS TABLE com nomes de
-- coluna reais, precisava desse cuidado. Corrigido qualificando com o
-- nome completo da tabela toda referência que colidia (marcado "FIX
-- AMBIGUIDADE" abaixo); nenhuma outra lógica mudou.
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

  -- (2) Ver nota "ADIÇÃO SINALIZADA" no cabeçalho — defesa extra além
  -- da checagem já feita pela rota.
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
    -- devolvido; esta função não decide HTTP.
    RETURN QUERY SELECT
      v_pipeline.id, v_pipeline.projeto_id, v_pipeline.etapa_atual, v_pipeline.status,
      v_pipeline.job_atual_id, v_pipeline.proxima_etapa, v_pipeline.versao_catalogo,
      v_pipeline.versao_pipeline, v_pipeline.ultima_execucao, v_pipeline.proxima_execucao,
      v_pipeline.erro_tipo, v_pipeline.erro_mensagem, v_pipeline.criado_em, v_pipeline.atualizado_em,
      v_pipeline.concluido_em, v_pipeline.cancelado_em, false;
    RETURN;
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
  'Cria atomicamente o Pipeline + o primeiro job (1ª subetapa obrigatória da 1ª etapa obrigatória ativa do catálogo versão 1) para um projeto que ainda não tem Pipeline. Idempotente: se o projeto já tem Pipeline, devolve a linha existente sem duplicar e sem alterar nada (criado_agora=false). Lock FOR UPDATE na linha do projeto evita duplicidade em chamadas concorrentes. Nunca avança etapa, nunca chama Gateway/Worker. Restrita a service_role — ver REVOKE/GRANT abaixo.';

-- Restrição de permissão — mesmo padrão das demais RPCs restritas deste
-- módulo (criar_projeto_estudio_anuncios, pipeline_avancar,
-- pipeline_registrar_falha, pipeline_concluir_job, pipeline_falhar_job):
-- recebe p_projeto_id cru, sem verificação de sessão possível dentro da
-- própria função — a defesa fica inteiramente na rota, que só chama com
-- um cliente server-only (service_role) depois de validar a sessão.
REVOKE EXECUTE ON FUNCTION public.estudio_anuncios_pipeline_iniciar(UUID)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.estudio_anuncios_pipeline_iniciar(UUID)
  TO service_role;
