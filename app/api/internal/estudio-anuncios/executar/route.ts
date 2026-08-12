/**
 * POST /api/internal/estudio-anuncios/executar
 *
 * Rota INTERNA — protegida por segredo estático (header
 * x-worker-secret), nunca pelo cookie cds_session. Só
 * scripts/estudio-anuncios-worker.mjs deve chamar isto.
 *
 * AJUSTE (2026-08-06 — integração funcional): deixa de tratar só
 * "ping" e passa a processar as 7 etapas reais do fluxo obrigatório da
 * Fase 1 do Pipeline, via lib/estudio-anuncios/executar-job.ts
 * (Gateway ainda 100% fake, sem rede). "ping" continua suportado como
 * teste de infraestrutura.
 *
 * REGRA CENTRAL desta tarefa: esta rota NÃO decide sequência do
 * Pipeline. Ela só: valida -> marca início de execução (se preciso)
 * -> executa a etapa via o executor -> chama EXATAMENTE UMA das duas
 * RPCs atômicas (estudio_anuncios_pipeline_concluir_job/_falhar_job).
 * Quem decide o próximo job / conclusão do Pipeline é a RPC, sempre.
 * Esta rota nunca marca o job concluído/erro manualmente antes disso
 * (marcarJobConcluido/marcarJobErro foram removidas de
 * lib/estudio-anuncios/jobs.ts por esse motivo).
 */
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { buscarJobPorId, UUID_REGEX } from "@/lib/estudio-anuncios/jobs";
import {
  buscarPipelinePorProjeto,
  concluirJobPipeline,
  falharJobPipeline,
  iniciarExecucaoJobPipeline,
} from "@/lib/estudio-anuncios/pipeline/pipeline";
import { StatusPipeline } from "@/lib/estudio-anuncios/pipeline/tipos";
import { obterDefinicaoEtapa, listarSubetapas } from "@/lib/estudio-anuncios/pipeline/catalogo";
import { executarJobEstudioAnuncios } from "@/lib/estudio-anuncios/executar-job";
import type { TipoErroIA } from "@/lib/ai-gateway/tipos";

const supabaseServico = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Estados do Pipeline em que a etapa atual pode legitimamente ser
// executada. Os demais (concluido/cancelado/pausado/erro/
// aguardando_pendencias) nunca chamam o Gateway.
const STATUS_PIPELINE_EXECUTAVEL: ReadonlySet<StatusPipeline> = new Set([
  StatusPipeline.AGUARDANDO,
  StatusPipeline.EM_EXECUCAO,
]);

function respostaErro(status: number, erro: string) {
  // Nunca inclui stack trace nem detalhe interno além da mensagem já
  // controlada — todo texto que chega aqui já foi truncado/sanitizado
  // antes de subir até este ponto.
  return NextResponse.json({ ok: false, erro }, { status });
}

export async function POST(request: Request) {
  const segredoEsperado = process.env.ESTUDIO_ANUNCIOS_WORKER_INTERNAL_SECRET;
  const segredoRecebido = request.headers.get("x-worker-secret");

  if (!segredoEsperado || !segredoRecebido || segredoRecebido !== segredoEsperado) {
    return respostaErro(401, "Não autorizado.");
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return respostaErro(400, "Body inválido.");
  }

  const jobId = body?.job_id;
  if (!jobId || typeof jobId !== "string") {
    return respostaErro(400, "job_id é obrigatório.");
  }
  if (!UUID_REGEX.test(jobId)) {
    return respostaErro(400, "job_id não é um UUID válido.");
  }
  // Nunca aceita user_id do worker — autorização desta rota é
  // exclusivamente o segredo, nunca dado enviado pelo chamador.

  try {
    const job = await buscarJobPorId(supabaseServico, jobId);
    if (!job) {
      return respostaErro(404, "Job não encontrado.");
    }

    if (job.status !== "rodando") {
      return respostaErro(
        409,
        `Job precisa estar com status "rodando" para ser processado (atual: "${job.status}"). Claim é responsabilidade exclusiva do worker.`
      );
    }

    if (job.tentativas > job.max_tentativas) {
      return respostaErro(409, "tentativas excede max_tentativas — job não deveria ter sido reivindicado.");
    }

    const pipeline = await buscarPipelinePorProjeto(supabaseServico, job.projeto_id);
    if (!pipeline) {
      return respostaErro(404, "Pipeline não encontrado para o projeto deste job.");
    }

    if (pipeline.projetoId !== job.projeto_id) {
      // Defensivo — buscarPipelinePorProjeto já filtra por job.projeto_id,
      // então isso só dispararia por um bug real de leitura.
      return respostaErro(409, "Pipeline não corresponde ao projeto do job.");
    }

    if (pipeline.jobAtualId !== job.id) {
      return respostaErro(
        409,
        `Job informado não corresponde ao job_atual_id do pipeline (pipeline aponta para ${pipeline.jobAtualId ?? "NULL"}).`
      );
    }

    if (!STATUS_PIPELINE_EXECUTAVEL.has(pipeline.status)) {
      return respostaErro(409, `Pipeline não está em estado executável (status atual: "${pipeline.status}").`);
    }

    if (!pipeline.etapaAtual) {
      return respostaErro(409, "Pipeline não tem etapa_atual definida.");
    }

    // Confirma que a etapa do job pertence à etapa AMPLA atual do
    // pipeline, segundo o catálogo da versão travada neste pipeline —
    // única fonte de verdade (Decisão 3 da arquitetura), nunca
    // reimplementada aqui.
    const definicaoEtapa = await obterDefinicaoEtapa(supabaseServico, pipeline.versaoCatalogo, pipeline.etapaAtual);
    if (!definicaoEtapa) {
      return respostaErro(
        409,
        `Etapa "${pipeline.etapaAtual}" não encontrada no catálogo (versão ${pipeline.versaoCatalogo}).`
      );
    }
    const subetapas = await listarSubetapas(supabaseServico, definicaoEtapa.id);
    const jobPertenceAEtapaAtual = subetapas.some(s => s.jobEtapa === job.etapa);
    if (!jobPertenceAEtapaAtual) {
      return respostaErro(
        409,
        `Etapa do job ("${job.etapa}") não pertence à etapa ampla atual do pipeline ("${pipeline.etapaAtual}").`
      );
    }

    // A partir daqui, o job está numa posição legítima para ser
    // processado. Marca início de execução (aguardando -> em_execucao,
    // se aplicável) ANTES de chamar o Gateway — nunca toca
    // etapa_atual/job_atual_id (só as RPCs atômicas fazem isso).
    await iniciarExecucaoJobPipeline(supabaseServico, pipeline.id, pipeline.status);

    const resultado = await executarJobEstudioAnuncios(supabaseServico, {
      jobId: job.id,
      projetoId: job.projeto_id,
      etapa: job.etapa,
    });

    if (resultado.sucesso) {
      // Invariante do executor (lib/estudio-anuncios/executar-job.ts):
      // todo retorno sucesso=true inclui provedor (vem direto da
      // resposta do Gateway). Se isso não for verdade, é um bug no
      // executor, não algo para mascarar aqui com um valor inventado —
      // provedor nunca vem do body/worker/frontend, só do Gateway/
      // roteamento server-side.
      if (!resultado.provedor) {
        throw new Error("INVARIANTE_VIOLADA: executor retornou sucesso sem provedor definido.");
      }
      const pipelineAtualizado = await concluirJobPipeline(supabaseServico, pipeline.id, job.id, resultado.provedor);
      return NextResponse.json({
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
      });
    }

    const erroTipo: TipoErroIA = resultado.erro?.tipo ?? "unknown";
    const erroMensagem = (resultado.erro?.mensagem ?? "Falha desconhecida ao executar o job.").slice(0, 300);

    // resultado.provedor só vem preenchido se o executor decidir expor
    // isso num retorno de falha (hoje ele não expõe em nenhum caminho
    // de erro — ver nota na entrega). Nunca derivado do body/worker/
    // frontend, só do resultado do executor (server-side).
    const pipelineAtualizado = await falharJobPipeline(
      supabaseServico, pipeline.id, job.id, erroTipo, erroMensagem, resultado.provedor ?? null
    );
    return NextResponse.json({
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
    });
  } catch (err: any) {
    // Última rede de segurança — nunca deixa exceção crua/stack trace
    // chegar na resposta. Não tenta marcar job/pipeline aqui: se algo
    // chegou até este catch, não há garantia de qual etapa do fluxo
    // falhou, então não arrisca um estado parcial extra.
    const mensagem = (err?.message ?? "Erro desconhecido").toString().slice(0, 300);
    console.error("[internal/estudio-anuncios/executar] falhou:", mensagem);
    return respostaErro(500, mensagem);
  }
}
