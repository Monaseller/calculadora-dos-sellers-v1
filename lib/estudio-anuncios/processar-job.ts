/**
 * Processamento de UM job do Pipeline — a lógica que estava presa
 * dentro da rota interna (2026-09-04).
 *
 * ── Por que isto virou função ───────────────────────────────────────
 * Até aqui só existia um consumidor da fila: `scripts/estudio-anuncios-
 * worker.mjs`, rodando na máquina de quem desenvolve, chamando
 * `/api/internal/estudio-anuncios/executar` por HTTP. Em produção não há
 * esse processo — e o resultado é que "Iniciar pipeline" pela interface
 * enfileirava um job que **ninguém nunca executava**. O projeto ficava
 * parado em `pendente`, sem erro, para sempre.
 *
 * Para o cron de produção poder processar a fila sem repetir as ~15
 * validações de estado que a rota fazia, a lógica saiu de lá e virou
 * esta função. A rota interna passou a ser um invólucro fino sobre ela,
 * então o worker local continua funcionando exatamente como antes — e
 * não existem duas implementações para divergirem com o tempo.
 *
 * Esta função **não** faz o claim: reivindicar é responsabilidade de
 * quem chama, e continua acontecendo só pela RPC atômica
 * `claim_next_estudio_anuncios_job`. Aqui o job já chega `rodando`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { buscarJobPorId } from "./jobs";
import {
  buscarPipelinePorProjeto,
  concluirJobPipeline,
  falharJobPipeline,
  iniciarExecucaoJobPipeline,
} from "./pipeline/pipeline";
import { StatusPipeline } from "./pipeline/tipos";
import { obterDefinicaoEtapa, listarSubetapas } from "./pipeline/catalogo";
import { executarJobEstudioAnuncios } from "./executar-job";
import type { TipoErroIA } from "../ai-gateway/tipos";

/** Estados em que a etapa atual pode legitimamente ser executada. */
const STATUS_PIPELINE_EXECUTAVEL: ReadonlySet<StatusPipeline> = new Set([
  StatusPipeline.AGUARDANDO,
  StatusPipeline.EM_EXECUCAO,
]);

export interface ResultadoProcessamento {
  /** Status HTTP que a rota deve devolver. */
  status: number;
  corpo: Record<string, unknown>;
}

const erro = (status: number, mensagem: string): ResultadoProcessamento => ({
  status,
  corpo: { ok: false, erro: mensagem },
});

/**
 * Executa um job já reivindicado, com todas as checagens de coerência
 * entre job, pipeline e catálogo.
 *
 * Devolve status + corpo em vez de `NextResponse` de propósito: assim a
 * função serve tanto à rota interna quanto ao cron, sem que nenhum dos
 * dois precise conhecer o formato do outro.
 */
export async function processarJobDoPipeline(
  supabaseServico: SupabaseClient,
  jobId: string
): Promise<ResultadoProcessamento> {
  const job = await buscarJobPorId(supabaseServico, jobId);
  if (!job) return erro(404, "Job não encontrado.");

  if (job.status !== "rodando") {
    return erro(
      409,
      `Job precisa estar com status "rodando" para ser processado (atual: "${job.status}"). Claim é responsabilidade exclusiva de quem chama.`
    );
  }
  if (job.tentativas > job.max_tentativas) {
    return erro(409, "tentativas excede max_tentativas — job não deveria ter sido reivindicado.");
  }

  const pipeline = await buscarPipelinePorProjeto(supabaseServico, job.projeto_id);
  if (!pipeline) return erro(404, "Pipeline não encontrado para o projeto deste job.");

  if (pipeline.projetoId !== job.projeto_id) {
    // Defensivo — `buscarPipelinePorProjeto` já filtra por
    // `job.projeto_id`, então isso só dispararia por bug real de leitura.
    return erro(409, "Pipeline não corresponde ao projeto do job.");
  }
  if (pipeline.jobAtualId !== job.id) {
    return erro(
      409,
      `Job informado não corresponde ao job_atual_id do pipeline (pipeline aponta para ${pipeline.jobAtualId ?? "NULL"}).`
    );
  }
  if (!STATUS_PIPELINE_EXECUTAVEL.has(pipeline.status)) {
    return erro(409, `Pipeline não está em estado executável (status atual: "${pipeline.status}").`);
  }
  if (!pipeline.etapaAtual) return erro(409, "Pipeline não tem etapa_atual definida.");

  // A etapa do job precisa pertencer à etapa AMPLA atual do pipeline,
  // segundo o catálogo da versão travada nele — fonte de verdade única,
  // nunca reimplementada aqui.
  const definicaoEtapa = await obterDefinicaoEtapa(supabaseServico, pipeline.versaoCatalogo, pipeline.etapaAtual);
  if (!definicaoEtapa) {
    return erro(409, `Etapa "${pipeline.etapaAtual}" não encontrada no catálogo (versão ${pipeline.versaoCatalogo}).`);
  }
  const subetapas = await listarSubetapas(supabaseServico, definicaoEtapa.id);
  if (!subetapas.some(s => s.jobEtapa === job.etapa)) {
    return erro(
      409,
      `Etapa do job ("${job.etapa}") não pertence à etapa ampla atual do pipeline ("${pipeline.etapaAtual}").`
    );
  }

  // Daqui em diante o job está numa posição legítima. Marca início
  // (aguardando -> em_execucao) ANTES de chamar o Gateway; nunca toca
  // `etapa_atual`/`job_atual_id` — só as RPCs atômicas fazem isso.
  await iniciarExecucaoJobPipeline(supabaseServico, pipeline.id, pipeline.status);

  const resultado = await executarJobEstudioAnuncios(supabaseServico, {
    jobId: job.id,
    projetoId: job.projeto_id,
    etapa: job.etapa,
  });

  if (resultado.sucesso) {
    // Invariante do executor: todo `sucesso=true` traz `provedor`, vindo
    // direto do Gateway. Se faltar, é bug do executor — não algo para
    // mascarar aqui com um valor inventado.
    if (!resultado.provedor) {
      throw new Error("INVARIANTE_VIOLADA: executor retornou sucesso sem provedor definido.");
    }
    const pipelineAtualizado = await concluirJobPipeline(supabaseServico, pipeline.id, job.id, resultado.provedor);
    return {
      status: 200,
      corpo: {
        ok: true,
        job: { id: job.id, etapa: job.etapa, status: "concluido" },
        provedor: resultado.provedor,
        modelo: resultado.modelo,
        tempoMs: resultado.tempoMs,
        pipeline: {
          id: pipelineAtualizado.id,
          status: pipelineAtualizado.status,
          etapaAtual: pipelineAtualizado.etapaAtual,
          jobAtualId: pipelineAtualizado.jobAtualId,
          concluido: pipelineAtualizado.status === StatusPipeline.CONCLUIDO,
        },
      },
    };
  }

  const erroTipo: TipoErroIA = resultado.erro?.tipo ?? "unknown";
  const erroMensagem = (resultado.erro?.mensagem ?? "Falha desconhecida ao executar o job.").slice(0, 300);

  const pipelineAtualizado = await falharJobPipeline(
    supabaseServico, pipeline.id, job.id, erroTipo, erroMensagem, resultado.provedor ?? null
  );
  return {
    status: 200,
    corpo: {
      ok: false,
      job: { id: job.id, etapa: job.etapa, status: "erro" },
      erro: erroMensagem,
      erroTipo,
      pipeline: {
        id: pipelineAtualizado.id,
        status: pipelineAtualizado.status,
        etapaAtual: pipelineAtualizado.etapaAtual,
        jobAtualId: pipelineAtualizado.jobAtualId,
      },
    },
  };
}

/**
 * Reivindica o próximo job pendente. `null` quando a fila está vazia.
 *
 * O claim é atômico no banco (`FOR UPDATE SKIP LOCKED` + incremento de
 * `tentativas` + `status='rodando'` na mesma transação), então dois
 * chamadores simultâneos nunca pegam o mesmo job.
 */
export async function reivindicarProximoJob(
  supabaseServico: SupabaseClient
): Promise<{ id: string; etapa: string; projeto_id: string; tentativas: number; max_tentativas: number } | null> {
  const { data, error } = await supabaseServico.rpc("claim_next_estudio_anuncios_job");
  if (error) throw new Error(`Falha ao reivindicar job: ${error.message}`);
  // Sem job pendente, o PostgREST serializa a linha composta NULL
  // expandida — não literalmente `null`. `data.id` é o sinal confiável.
  if (!data || (data as any).id == null) return null;
  return data as any;
}
