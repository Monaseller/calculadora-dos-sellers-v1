-- ────────────────────────────────────────────────────────────────────
-- 20260812_preservar_erro_no_retry.sql
--
-- CORRIGE: estudio_anuncios_pipeline_registrar_falha() apagava
-- erro_tipo/erro_mensagem do JOB toda vez que o reenfileirava para
-- retry (passo 4 da versão de 20260805). Consequência real: a causa de
-- toda tentativa que não fosse a última era destruída permanentemente.
-- Um job que falha 2x e só depois é investigado não tem mais nenhuma
-- informação sobre por que falhou.
--
-- ACHADO QUE MOTIVOU A CORREÇÃO (2026-08-06): 4 jobs foram encontrados
-- em estado `status='pendente'` com `tentativas = max_tentativas` e
-- `erro_tipo IS NULL` — um estado que a lógica atual não deveria
-- conseguir produzir (o passo 4 só roda quando
-- `tentativas < max_tentativas`; com as tentativas esgotadas o passo 5
-- deixa o job em 'erro'). A causa exata NÃO pôde ser determinada,
-- justamente porque a evidência que a explicaria já tinha sido apagada
-- por este mesmo comportamento. Os 4 jobs não têm nenhum registro em
-- central_ia_prompts, o que indica que falharam ANTES de qualquer
-- chamada de IA. Eles são inofensivos hoje (não são reivindicáveis,
-- porque claim_next_estudio_anuncios_job() exige
-- `tentativas < max_tentativas`) e foram deixados intactos, nunca
-- apagados.
--
-- O QUE MUDA: uma linha de comportamento — o UPDATE do passo 4 deixa de
-- zerar erro_tipo/erro_mensagem do job. A semântica de retry é
-- IDÊNTICA: mesmo job devolvido a 'pendente', tentativas não zeradas,
-- nenhum job novo criado, mesma condição de corte, mesmos erros
-- explícitos de uso inválido. Só para de destruir dado.
--
-- O QUE NÃO MUDA: o pipeline continua tendo erro_tipo/erro_mensagem
-- limpos ao voltar para 'aguardando' — o pipeline de fato não está em
-- erro enquanto ainda há tentativa; quem carrega o histórico da falha é
-- o job, que é a unidade que falhou.
--
-- SEGURANÇA DA MUDANÇA (verificado por leitura antes de escrever):
--   - claim_next_estudio_anuncios_job() filtra só por status='pendente'
--     e tentativas < max_tentativas; não lê erro_tipo.
--   - Nenhum código TypeScript depende de erro_tipo ser NULL em job
--     pendente (grep em *.ts/*.tsx/*.mjs: só leitura para exibição).
--   - app/(app)/central-ia/estudio-anuncios/[projetoId]/page.tsx:562 já
--     exibe `erroTipo: erroMensagem` quando presentes — com esta
--     correção a UI passa a mostrar, corretamente, por que a tentativa
--     anterior falhou enquanto o job aguarda nova tentativa. Melhora
--     observável, não regressão.
--
-- Recria a função inteira (CREATE OR REPLACE exige o corpo completo).
-- Corpo copiado da versão VIGENTE — 20260805_estudio_anuncios_pipeline_rpcs.sql
-- (nenhuma migration posterior recriou esta função; 20260806_corrigir_provedor
-- recriou concluir_job/falhar_job, e 20260811 recriou avancar).
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

  -- 2) job_atual_id divergente ou status != em_execucao são erro
  -- explícito, nunca no-op silencioso (revisão 2026-08-05).
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
    --
    -- ⚠️ ÚNICA MUDANÇA DESTA MIGRATION (2026-08-12): erro_tipo e
    -- erro_mensagem NÃO são mais zerados aqui. Eles passam a carregar a
    -- causa da ÚLTIMA tentativa falha enquanto o job aguarda a próxima.
    -- Antes eram apagados, o que tornava impossível diagnosticar
    -- qualquer falha que não fosse a definitiva. O valor é sobrescrito
    -- naturalmente pela próxima falha (falhar_job grava antes de chamar
    -- esta função) e deixa de ser relevante quando o job conclui.
    UPDATE public.estudio_anuncios_jobs
    SET status = 'pendente'
    WHERE id = p_job_id;

    -- O PIPELINE, sim, tem o erro limpo: enquanto há tentativa
    -- restante, o pipeline não está em erro — está aguardando.
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
  -- 'erro' (não é resetado), agora com a causa preservada tanto no job
  -- quanto no pipeline.
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
  'Registra a falha de um job do Pipeline — reenvia o mesmo job para pendente (retry) se ainda houver tentativas, ou marca o pipeline em erro (tentativas esgotadas), atomicamente. Desde 20260812: o retry PRESERVA erro_tipo/erro_mensagem do job (antes eram apagados, destruindo a causa de toda tentativa não-final). NÃO é tolerante a chamada duplicada/fora de ordem. Restrita a service_role.';

-- Permissões — CREATE OR REPLACE não remove GRANT/REVOKE existentes,
-- mas são repetidos aqui por disciplina do projeto (toda migration que
-- recria função reafirma as permissões), e porque o ALTER DEFAULT
-- PRIVILEGES deste projeto Supabase concede EXECUTE a anon/authenticated
-- automaticamente em função nova — ver docs/BUGS.md, item SEC1.
REVOKE EXECUTE ON FUNCTION public.estudio_anuncios_pipeline_registrar_falha(UUID, UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.estudio_anuncios_pipeline_registrar_falha(UUID, UUID, TEXT, TEXT)
  TO service_role;
