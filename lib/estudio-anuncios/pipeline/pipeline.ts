/**
 * Pipeline Service — funções que tocam o banco. Único lugar do módulo
 * que decide "o que executar agora" (fora das 2 RPCs, que decidem o
 * avanço/falha de forma atômica no próprio Postgres — ver
 * supabase/migrations/20260805_estudio_anuncios_pipeline_rpcs.sql,
 * ainda NÃO executada).
 *
 * `supabaseServico` (service_role) é usado para toda escrita e para as
 * 2 RPCs restritas — nunca para leitura simples, que continua no
 * cliente anon (`supabase`) passado separadamente, mesmo padrão já
 * usado em lib/estudio-anuncios/projetos.ts.
 *
 * NADA neste arquivo é chamado por nenhuma rota ainda — rota interna e
 * worker permanecem intocados nesta tarefa (fora de escopo).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { StatusPipeline, TipoEtapa } from "./tipos";
import type { PipelineEstudioAnuncios } from "./tipos";
import { listarCatalogoAtivo, listarSubetapas } from "./catalogo";
import { transicaoValida, estadoTerminal } from "./maquina-estados";
import type { ProvedorIA } from "../../ai-gateway/tipos";

const COLUNAS_PIPELINE =
  "id, projeto_id, etapa_atual, status, job_atual_id, proxima_etapa, versao_catalogo, " +
  "versao_pipeline, ultima_execucao, proxima_execucao, erro_tipo, erro_mensagem, criado_em, " +
  "atualizado_em, concluido_em, cancelado_em";

function mapearPipeline(row: any): PipelineEstudioAnuncios {
  return {
    id: row.id,
    projetoId: row.projeto_id,
    etapaAtual: row.etapa_atual,
    status: row.status as StatusPipeline,
    jobAtualId: row.job_atual_id,
    proximaEtapa: row.proxima_etapa,
    versaoCatalogo: row.versao_catalogo,
    versaoPipeline: row.versao_pipeline,
    ultimaExecucao: row.ultima_execucao,
    proximaExecucao: row.proxima_execucao,
    erroTipo: row.erro_tipo,
    erroMensagem: row.erro_mensagem,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
    concluidoEm: row.concluido_em,
    canceladoEm: row.cancelado_em,
  };
}

export async function buscarPipelinePorId(
  supabase: SupabaseClient,
  pipelineId: string
): Promise<PipelineEstudioAnuncios | null> {
  const { data, error } = await supabase
    .from("estudio_anuncios_pipeline")
    .select(COLUNAS_PIPELINE)
    .eq("id", pipelineId)
    .maybeSingle();

  if (error) throw new Error(`Falha ao buscar pipeline: ${error.message}`);
  return data ? mapearPipeline(data) : null;
}

export async function buscarPipelinePorProjeto(
  supabase: SupabaseClient,
  projetoId: string
): Promise<PipelineEstudioAnuncios | null> {
  const { data, error } = await supabase
    .from("estudio_anuncios_pipeline")
    .select(COLUNAS_PIPELINE)
    .eq("projeto_id", projetoId)
    .maybeSingle();

  if (error) throw new Error(`Falha ao buscar pipeline do projeto: ${error.message}`);
  return data ? mapearPipeline(data) : null;
}

/**
 * Cria a linha do pipeline + o job da 1ª subetapa da 1ª etapa
 * obrigatória ativa do catálogo. NÃO é uma RPC (só as 2 nomeadas na
 * tarefa — estudio_anuncios_pipeline_avancar/_registrar_falha — foram
 * autorizadas) — são 3 escritas sequenciais (pipeline → job → update
 * do pipeline com o job_atual_id). Se cair no meio, o pipeline fica em
 * status='criado' com job_atual_id=NULL — estado seguro e detectável
 * (retomarPipeline() sabe lidar com isso), não um estado corrompido.
 */
export async function iniciarPipeline(
  supabase: SupabaseClient,
  supabaseServico: SupabaseClient,
  projetoId: string,
  versaoCatalogo: number = 1
): Promise<PipelineEstudioAnuncios> {
  const { data: pipelineRow, error: erroInsert } = await supabaseServico
    .from("estudio_anuncios_pipeline")
    .insert({ projeto_id: projetoId, versao_catalogo: versaoCatalogo, status: StatusPipeline.CRIADO })
    .select(COLUNAS_PIPELINE)
    .single();

  if (erroInsert) throw new Error(`Falha ao criar pipeline: ${erroInsert.message}`);

  const etapasAtivas = await listarCatalogoAtivo(supabase, versaoCatalogo);
  const primeiraEtapa = etapasAtivas
    .filter(e => e.tipo === TipoEtapa.OBRIGATORIA)
    .sort((a, b) => a.ordem - b.ordem)[0];

  if (!primeiraEtapa) {
    throw new Error(`Catálogo (versão ${versaoCatalogo}) não tem nenhuma etapa obrigatória ativa — pipeline criado mas sem 1ª etapa para iniciar.`);
  }

  const subetapas = await listarSubetapas(supabase, primeiraEtapa.id);
  const primeiraSubetapa = subetapas
    .filter(s => s.obrigatoria)
    .sort((a, b) => a.ordem - b.ordem)[0];

  if (!primeiraSubetapa) {
    throw new Error(`Etapa "${primeiraEtapa.etapa}" não tem nenhuma subetapa obrigatória cadastrada no catálogo.`);
  }

  const { data: jobRow, error: erroJob } = await supabaseServico
    .from("estudio_anuncios_jobs")
    .insert({
      projeto_id: projetoId,
      etapa: primeiraSubetapa.jobEtapa,
      status: "pendente",
      max_tentativas: primeiraEtapa.maxTentativas,
    })
    .select("id")
    .single();

  if (erroJob) throw new Error(`Pipeline criado, mas falha ao criar o primeiro job: ${erroJob.message}`);

  const agora = new Date().toISOString();
  const { data: atualizado, error: erroUpdate } = await supabaseServico
    .from("estudio_anuncios_pipeline")
    .update({
      etapa_atual: primeiraEtapa.etapa,
      job_atual_id: jobRow.id,
      status: StatusPipeline.AGUARDANDO,
      ultima_execucao: agora,
      atualizado_em: agora,
    })
    .eq("id", (pipelineRow as any).id)
    .select(COLUNAS_PIPELINE)
    .single();

  if (erroUpdate) throw new Error(`Pipeline e job criados, mas falha ao atualizar o pipeline com o job_atual_id: ${erroUpdate.message}`);

  return mapearPipeline(atualizado);
}

/**
 * Chamada pela rota interna (fora de escopo desta tarefa alterar)
 * quando um job termina com SUCESSO — job já deve estar marcado
 * 'concluido' ANTES desta chamada. Envelope fino sobre a RPC
 * estudio_anuncios_pipeline_avancar().
 */
export async function avancarPipeline(
  supabaseServico: SupabaseClient,
  pipelineId: string,
  jobId: string
): Promise<PipelineEstudioAnuncios> {
  const { data, error } = await supabaseServico
    .rpc("estudio_anuncios_pipeline_avancar", { p_pipeline_id: pipelineId, p_job_id: jobId })
    .single();

  if (error) throw new Error(`Falha ao avançar pipeline: ${error.message}`);
  if (!data) throw new Error("RPC estudio_anuncios_pipeline_avancar não retornou o pipeline.");
  return mapearPipeline(data);
}

/**
 * Chamada pela rota interna quando um job termina em FALHA — job já
 * deve estar marcado 'erro' ANTES desta chamada. Envelope fino sobre a
 * RPC estudio_anuncios_pipeline_registrar_falha().
 */
export async function registrarFalhaPipeline(
  supabaseServico: SupabaseClient,
  pipelineId: string,
  jobId: string,
  erroTipo: string,
  erroMensagem: string
): Promise<PipelineEstudioAnuncios> {
  const { data, error } = await supabaseServico
    .rpc("estudio_anuncios_pipeline_registrar_falha", {
      p_pipeline_id: pipelineId,
      p_job_id: jobId,
      p_erro_tipo: erroTipo,
      p_erro_mensagem: erroMensagem,
    })
    .single();

  if (error) throw new Error(`Falha ao registrar falha do pipeline: ${error.message}`);
  if (!data) throw new Error("RPC estudio_anuncios_pipeline_registrar_falha não retornou o pipeline.");
  return mapearPipeline(data);
}

/** Cancela de qualquer estado não-terminal. Idempotente. */
export async function cancelarPipeline(
  supabaseServico: SupabaseClient,
  pipelineId: string
): Promise<PipelineEstudioAnuncios> {
  const atual = await buscarPipelinePorId(supabaseServico, pipelineId);
  if (!atual) throw new Error("Pipeline não encontrado.");
  if (estadoTerminal(atual.status)) return atual;

  if (!transicaoValida(atual.status, StatusPipeline.CANCELADO)) {
    throw new Error(`Transição inválida: "${atual.status}" → "cancelado".`);
  }

  const agora = new Date().toISOString();
  const { data, error } = await supabaseServico
    .from("estudio_anuncios_pipeline")
    .update({ status: StatusPipeline.CANCELADO, cancelado_em: agora, atualizado_em: agora })
    .eq("id", pipelineId)
    .select(COLUNAS_PIPELINE)
    .single();

  if (error) throw new Error(`Falha ao cancelar pipeline: ${error.message}`);
  return mapearPipeline(data);
}

/** Pausa de qualquer estado não-terminal. Idempotente. */
export async function pausarPipeline(
  supabaseServico: SupabaseClient,
  pipelineId: string
): Promise<PipelineEstudioAnuncios> {
  const atual = await buscarPipelinePorId(supabaseServico, pipelineId);
  if (!atual) throw new Error("Pipeline não encontrado.");
  if (atual.status === StatusPipeline.PAUSADO) return atual;
  if (estadoTerminal(atual.status)) {
    throw new Error(`Não é possível pausar um pipeline em estado terminal ("${atual.status}").`);
  }
  if (!transicaoValida(atual.status, StatusPipeline.PAUSADO)) {
    throw new Error(`Transição inválida: "${atual.status}" → "pausado".`);
  }

  const { data, error } = await supabaseServico
    .from("estudio_anuncios_pipeline")
    .update({ status: StatusPipeline.PAUSADO, atualizado_em: new Date().toISOString() })
    .eq("id", pipelineId)
    .select(COLUNAS_PIPELINE)
    .single();

  if (error) throw new Error(`Falha ao pausar pipeline: ${error.message}`);
  return mapearPipeline(data);
}

/**
 * Retomada — NUNCA confia cegamente em etapa_atual/job_atual_id,
 * sempre relê o job real (arquitetura, seção "Estratégia de
 * retomada"). Reaproveita avancarPipeline()/registrarFalhaPipeline()
 * em vez de duplicar a lógica de decisão.
 *
 * Nota (revisão 2026-08-05): as duas RPCs abaixo delas deixaram de ser
 * tolerantes a chamada fora de ordem (Ajuste 3 — job_atual_id
 * divergente ou status != em_execucao agora lançam exceção, não fazem
 * mais no-op silencioso). Esta função continua correta porque só
 * chama avancarPipeline()/registrarFalhaPipeline() depois de reler o
 * estado real e confirmar a precondição — mas numa corrida rara (outro
 * processo avança o mesmo pipeline entre a leitura aqui e a chamada),
 * a exceção da RPC vai propagar em vez de ser absorvida. Aceito por
 * design (retomada não é um loop de retry automático nesta fase).
 */
export async function retomarPipeline(
  supabaseServico: SupabaseClient,
  pipelineId: string
): Promise<PipelineEstudioAnuncios> {
  const atual = await buscarPipelinePorId(supabaseServico, pipelineId);
  if (!atual) throw new Error("Pipeline não encontrado.");
  if (estadoTerminal(atual.status)) return atual;

  if (!atual.jobAtualId) {
    // Nunca chegou a criar job para a etapa atual (crash entre decidir
    // e criar) — fora do escopo desta função recriar isso sozinha
    // nesta fase; fica como está para investigação manual.
    return atual;
  }

  const { data: job, error } = await supabaseServico
    .from("estudio_anuncios_jobs")
    .select("id, status")
    .eq("id", atual.jobAtualId)
    .maybeSingle();

  if (error) throw new Error(`Falha ao reler job atual para retomada: ${error.message}`);
  if (!job) return atual;

  if (job.status === "concluido") {
    return avancarPipeline(supabaseServico, pipelineId, job.id);
  }
  if (job.status === "erro") {
    return registrarFalhaPipeline(
      supabaseServico,
      pipelineId,
      job.id,
      atual.erroTipo ?? "unknown",
      atual.erroMensagem ?? "Retomado após pausa/erro — motivo original não preservado."
    );
  }

  // 'pendente' ou 'rodando' — só realinha o status do pipeline com a
  // realidade, nunca toca no job (claim/execução seguem seu fluxo).
  const novoStatus = job.status === "rodando" ? StatusPipeline.EM_EXECUCAO : StatusPipeline.AGUARDANDO;
  if (atual.status === novoStatus) return atual;
  if (!transicaoValida(atual.status, novoStatus)) return atual;

  const { data: atualizado, error: erroUpdate } = await supabaseServico
    .from("estudio_anuncios_pipeline")
    .update({ status: novoStatus, atualizado_em: new Date().toISOString() })
    .eq("id", pipelineId)
    .select(COLUNAS_PIPELINE)
    .single();

  if (erroUpdate) throw new Error(`Falha ao retomar pipeline: ${erroUpdate.message}`);
  return mapearPipeline(atualizado);
}

/**
 * AJUSTE (2026-08-06 — integração funcional Worker/rota/Pipeline).
 *
 * Envelopes finos sobre as 2 RPCs ATÔMICAS instaladas em
 * supabase/migrations/20260806_estudio_anuncios_pipeline_rpcs_atomicas.sql
 * (estudio_anuncios_pipeline_concluir_job / _falhar_job) — que fazem
 * "mudar status do job" + "avançar/falhar o Pipeline" numa única
 * transação. A rota interna usa EXCLUSIVAMENTE estas duas funções para
 * concluir/falhar um job — nunca mais marcarJobConcluido()/
 * marcarJobErro() (removidas de lib/estudio-anuncios/jobs.ts) nem as
 * RPCs não-atômicas estudio_anuncios_pipeline_avancar()/
 * _registrar_falha() diretamente (elas continuam existindo só como
 * primitivas internas, chamadas de dentro das RPCs atômicas — regra
 * central desta tarefa).
 *
 * AJUSTE (2026-08-06 — correção do bug de provedor, ver migration
 * 20260806_corrigir_provedor_jobs_pipeline.sql): as duas RPCs atômicas
 * mudaram de assinatura no banco — concluir_job agora exige p_provedor
 * (chk_jobs_provedor_definido só é satisfeita quando status=concluido
 * já tem provedor definido); falhar_job aceita p_provedor opcional,
 * sem nunca apagar um provedor já gravado (COALESCE do lado do banco).
 * `provedor`/`ProvedorIA` aqui é o mesmo tipo de lib/ai-gateway/tipos.ts
 * — nada de string livre. Sem fallback para as assinaturas antigas (2 e
 * 4 argumentos), que não existem mais no banco.
 */
export async function concluirJobPipeline(
  supabaseServico: SupabaseClient,
  pipelineId: string,
  jobId: string,
  provedor: ProvedorIA
): Promise<PipelineEstudioAnuncios> {
  const { data, error } = await supabaseServico
    .rpc("estudio_anuncios_pipeline_concluir_job", {
      p_pipeline_id: pipelineId,
      p_job_id: jobId,
      p_provedor: provedor,
    })
    .single();

  if (error) throw new Error(`Falha ao concluir job do pipeline: ${error.message}`);
  if (!data) throw new Error("RPC estudio_anuncios_pipeline_concluir_job não retornou o pipeline.");
  return mapearPipeline(data);
}

export async function falharJobPipeline(
  supabaseServico: SupabaseClient,
  pipelineId: string,
  jobId: string,
  erroTipo: string,
  erroMensagem: string,
  provedor: ProvedorIA | null
): Promise<PipelineEstudioAnuncios> {
  const { data, error } = await supabaseServico
    .rpc("estudio_anuncios_pipeline_falhar_job", {
      p_pipeline_id: pipelineId,
      p_job_id: jobId,
      p_erro_tipo: erroTipo,
      p_erro_mensagem: erroMensagem,
      p_provedor: provedor,
    })
    .single();

  if (error) throw new Error(`Falha ao registrar falha atômica do job/pipeline: ${error.message}`);
  if (!data) throw new Error("RPC estudio_anuncios_pipeline_falhar_job não retornou o pipeline.");
  return mapearPipeline(data);
}

/**
 * AJUSTE (2026-08-07 — UI iniciar/acompanhar Pipeline).
 *
 * Envelope fino sobre a RPC atômica estudio_anuncios_pipeline_iniciar()
 * (ver supabase/migrations/20260807_estudio_anuncios_iniciar_pipeline_rpc.sql
 * — ainda NÃO executada). Cria o Pipeline + o primeiro job (1ª subetapa
 * obrigatória da 1ª etapa obrigatória ativa do catálogo) atomicamente.
 * Substitui iniciarPipeline() (acima) para uso real — iniciarPipeline()
 * continua neste arquivo só por não ter sido removida (não é chamada
 * por nenhuma rota, é a versão não-transacional que motivou esta RPC),
 * mantida como histórico/comparação, não como código morto perigoso
 * (não escreve nada sozinha se não for chamada).
 *
 * Idempotente: se o projeto já tem Pipeline, a RPC devolve a linha
 * existente sem duplicar (criadoAgora=false) — quem chama decide o
 * código HTTP a partir de resultado.pipeline.status.
 */
export async function iniciarPipelineAtomico(
  supabaseServico: SupabaseClient,
  projetoId: string
): Promise<{ pipeline: PipelineEstudioAnuncios; criadoAgora: boolean }> {
  const { data, error } = await supabaseServico
    .rpc("estudio_anuncios_pipeline_iniciar", { p_projeto_id: projetoId })
    .single();

  if (error) throw new Error(`Falha ao iniciar pipeline: ${error.message}`);
  if (!data) throw new Error("RPC estudio_anuncios_pipeline_iniciar não retornou nada.");

  const row = data as any;
  return {
    pipeline: mapearPipeline(row),
    criadoAgora: Boolean(row.criado_agora),
  };
}

/**
 * Marca o início do processamento do job atual: se o pipeline estava
 * 'aguardando', passa para 'em_execucao' (nunca o contrário — não
 * regride de em_execucao para aguardando aqui). Sempre atualiza
 * ultima_execucao/atualizado_em, independente da transição de status.
 * NUNCA toca etapa_atual/job_atual_id — só as RPCs atômicas fazem isso.
 */
export async function iniciarExecucaoJobPipeline(
  supabaseServico: SupabaseClient,
  pipelineId: string,
  statusAtual: StatusPipeline
): Promise<void> {
  const novoStatus = statusAtual === StatusPipeline.AGUARDANDO ? StatusPipeline.EM_EXECUCAO : statusAtual;
  const agora = new Date().toISOString();

  const { error } = await supabaseServico
    .from("estudio_anuncios_pipeline")
    .update({ status: novoStatus, ultima_execucao: agora, atualizado_em: agora })
    .eq("id", pipelineId);

  if (error) throw new Error(`Falha ao marcar início de execução do job no pipeline: ${error.message}`);
}
