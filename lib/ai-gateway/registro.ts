/**
 * Registro de chamadas do AI Gateway — grava em central_ia_prompts e
 * central_ia_consumo. Nenhuma chamada real de rede acontece aqui; isto
 * só grava o resultado que lib/ai-gateway/cliente.ts já produziu.
 *
 * AJUSTE (2026-08-06, Decisão 2): registrarPrompt() não grava mais
 * tipo="texto" fixo — o chamador informa `tipo` (TipoTarefaIA), decidido
 * de forma centralizada por decidirTipoPrompt() em
 * lib/ai-gateway/roteamento.ts (nunca aqui, nunca na rota interna).
 *
 * AJUSTE (2026-08-06, Decisão 3): registrarPrompt() aceita `jobId`
 * opcional e grava em central_ia_prompts.job_id (coluna nova — ver
 * supabase/migrations/20260806_central_ia_prompts_job_id.sql). Quando
 * jobId é informado, a função primeiro verifica se já existe um prompt
 * para esse job (idempotência) e devolve o existente em vez de inserir
 * de novo — e, como rede de segurança contra corrida (2 chamadas
 * simultâneas passando pela checagem antes de qualquer INSERT
 * terminar), trata a violação do índice único parcial
 * idx_prompts_job_unico (código 23505) revertendo para uma releitura
 * em vez de propagar erro. jobId continua opcional porque
 * central_ia_prompts também é usada (e deve continuar sendo) para
 * prompts sem job associado — a coluna é nullable por esse motivo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RespostaIA, TipoTarefaIA, ProvedorIA } from "./tipos";

export async function registrarPrompt(
  supabase: SupabaseClient,
  params: { projetoId: string; jobId?: string; tipo: TipoTarefaIA; promptTexto: string; resposta: RespostaIA }
): Promise<{ id: string }> {
  if (params.jobId) {
    const { data: existente, error: erroBusca } = await supabase
      .from("central_ia_prompts")
      .select("id")
      .eq("job_id", params.jobId)
      .maybeSingle();

    if (erroBusca) {
      throw new Error(`Falha ao verificar prompt existente do job: ${erroBusca.message}`);
    }
    if (existente) {
      return existente as { id: string };
    }
  }

  const { data, error } = await supabase
    .from("central_ia_prompts")
    .insert({
      modulo: "estudio_anuncios",
      projeto_id: params.projetoId,
      job_id: params.jobId ?? null,
      tipo: params.tipo,
      provedor: params.resposta.provedor,
      modelo: params.resposta.modelo,
      prompt_texto: params.promptTexto,
      resultado_resumo: params.resposta.conteudo,
      tempo_ms: params.resposta.tempoMs,
      custo: params.resposta.custoReal,
      reutilizacoes: 0,
    })
    .select("id")
    .single();

  if (error) {
    // 23505 = violação de índice único — só pode ser idx_prompts_job_unico
    // aqui (corrida: outra chamada inseriu entre a checagem acima e este
    // INSERT). Idempotência via releitura, não propaga erro para o
    // chamador nesse caso específico.
    if (error.code === "23505" && params.jobId) {
      const { data: existente, error: erroReleitura } = await supabase
        .from("central_ia_prompts")
        .select("id")
        .eq("job_id", params.jobId)
        .maybeSingle();
      if (!erroReleitura && existente) {
        return existente as { id: string };
      }
    }
    throw new Error(`Falha ao registrar prompt: ${error.message}`);
  }
  return data as { id: string };
}

/**
 * AJUSTE (2026-08-06 — integração funcional): mesmo padrão de
 * idempotência de registrarPrompt() — verifica antes de inserir
 * (job_id já tem índice único parcial idx_central_ia_consumo_job_unico
 * desde 20260806_central_ia_prompts_job_id.sql), e trata 23505 (corrida)
 * revertendo para releitura em vez de propagar erro. jobId aqui é
 * obrigatório (diferente de registrarPrompt) porque central_ia_consumo
 * só existe neste módulo associada a uma execução de job real — não há
 * caso de uso de "consumo sem job" equivalente ao de prompts.
 */
export async function registrarConsumo(
  supabase: SupabaseClient,
  params: { projetoId: string; jobId: string; resposta: RespostaIA }
): Promise<{ id: string }> {
  const { data: existente, error: erroBusca } = await supabase
    .from("central_ia_consumo")
    .select("id")
    .eq("job_id", params.jobId)
    .maybeSingle();

  if (erroBusca) {
    throw new Error(`Falha ao verificar consumo existente do job: ${erroBusca.message}`);
  }
  if (existente) {
    return existente as { id: string };
  }

  const { data, error } = await supabase
    .from("central_ia_consumo")
    .insert({
      modulo: "estudio_anuncios",
      projeto_id: params.projetoId,
      job_id: params.jobId,
      provedor: params.resposta.provedor,
      modelo: params.resposta.modelo,
      tokens_entrada: params.resposta.tokensEntrada,
      tokens_saida: params.resposta.tokensSaida,
      // Fatia de imagem persistida para que o custo seja RE-DERIVAVEL a
      // partir da propria linha: sem ela, um modelo com duas taxas de
      // saida tornaria impossivel conferir `custo_estimado` depois.
      tokens_saida_imagem: params.resposta.tokensSaidaImagem ?? null,
      unidades_geradas: params.resposta.unidadesGeradas,
      custo_estimado: params.resposta.custoEstimado,
      custo_real: params.resposta.custoReal,
    })
    .select("id")
    .single();

  if (error) {
    if (error.code === "23505") {
      const { data: existenteReleitura, error: erroReleitura } = await supabase
        .from("central_ia_consumo")
        .select("id")
        .eq("job_id", params.jobId)
        .maybeSingle();
      if (!erroReleitura && existenteReleitura) {
        return existenteReleitura as { id: string };
      }
    }
    throw new Error(`Falha ao registrar consumo: ${error.message}`);
  }
  return data as { id: string };
}

/**
 * Erro controlado de idempotência de estudio_anuncios_resultados_pipeline
 * — lançado quando já existe um resultado para o mesmo job_id mas ele
 * diverge (identidade ou conteúdo) do que se está tentando gravar
 * agora. Nunca sobrescreve silenciosamente (não há UPDATE/upsert nesta
 * função). Distinto de erro genérico para o chamador poder decidir
 * tratar como falha "unknown" do job sem confundir com falha de rede/
 * banco.
 */
export class ErroIdempotenciaResultadoPipeline extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = "ErroIdempotenciaResultadoPipeline";
  }
}

/** Compara dois valores JSON por equivalência profunda, ignorando ordem de chaves de objeto (ordem de array importa). */
function canonicalizarJson(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.map(canonicalizarJson);
  if (valor !== null && typeof valor === "object") {
    const chaves = Object.keys(valor as Record<string, unknown>).sort();
    const saida: Record<string, unknown> = {};
    for (const chave of chaves) saida[chave] = canonicalizarJson((valor as Record<string, unknown>)[chave]);
    return saida;
  }
  return valor;
}

function resultadosEquivalentes(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonicalizarJson(a)) === JSON.stringify(canonicalizarJson(b));
}

/**
 * Registra o resultado estruturado de UMA etapa do Pipeline em
 * estudio_anuncios_resultados_pipeline (UNIQUE(job_id) — 1 resultado
 * por job, nunca atualizado depois de gravado).
 *
 * ETAPA (2026-08-09 — Primeira API real: Gemini para análise visual).
 *
 * Responsabilidade estrita, por pedido explícito: só persistência e
 * idempotência. NÃO seleciona fotos, NÃO monta prompt, NÃO chama o
 * Google, NÃO decide provedor, NÃO valida regras de Pipeline, NÃO
 * avança job — tudo isso já aconteceu antes desta chamada (ver
 * lib/estudio-anuncios/analise-visual.ts e executar-job.ts).
 *
 * Todos os parâmetros devem vir do contexto de execução já validado
 * pelo servidor (contexto do job carregado pela rota interna antes de
 * chamar o executor, e a resposta que o próprio Gateway/provedor
 * devolveu) — nunca de valor informado por um cliente HTTP. Esta
 * função não reconsulta estudio_anuncios_jobs porque o chamador
 * (executar-job.ts) já opera estritamente sobre esse contexto validado;
 * não há caminho de código em que este parâmetro venha de entrada de
 * usuário sem passar antes pela validação de propriedade/existência do
 * job na rota.
 *
 * Idempotência com comparação profunda (mais estrita que
 * registrarPrompt/registrarConsumo, que são determinísticos): em caso
 * de UNIQUE(job_id) violado (23505) — nova tentativa do mesmo job ou
 * corrida entre 2 chamadas simultâneas — relê o registro existente e
 * só devolve como sucesso se ele for realmente equivalente (mesma
 * identidade completa E resultado profundamente igual) ao que se
 * tentou gravar agora. Diverge → ErroIdempotenciaResultadoPipeline
 * (nunca sobrescreve, nunca ignora a divergência). Isso é necessário
 * porque, diferente do Gateway fake (determinístico), o Gemini não é
 * determinístico — duas execuções podem gerar textos diferentes para
 * o mesmo job em caso de retry, e isso deve ser detectado, não
 * mascarado.
 */
export async function registrarResultadoPipeline(
  supabase: SupabaseClient,
  params: {
    projetoId: string;
    jobId: string;
    etapa: string;
    provedor: ProvedorIA;
    modelo: string;
    schemaVersao: number;
    resultado: Record<string, unknown>;
  }
): Promise<{ id: string }> {
  const { data, error } = await supabase
    .from("estudio_anuncios_resultados_pipeline")
    .insert({
      projeto_id: params.projetoId,
      job_id: params.jobId,
      etapa: params.etapa,
      provedor: params.provedor,
      modelo: params.modelo,
      schema_versao: params.schemaVersao,
      resultado: params.resultado,
    })
    .select("id")
    .single();

  if (!error) {
    return data as { id: string };
  }

  if (error.code !== "23505") {
    throw new Error(`Falha ao registrar resultado do pipeline: ${error.message}`);
  }

  const { data: existente, error: erroReleitura } = await supabase
    .from("estudio_anuncios_resultados_pipeline")
    .select("id, projeto_id, job_id, etapa, provedor, modelo, schema_versao, resultado")
    .eq("job_id", params.jobId)
    .maybeSingle();

  if (erroReleitura || !existente) {
    throw new Error(`Falha ao registrar resultado do pipeline: ${error.message}`);
  }

  const identidadeDivergente =
    existente.projeto_id !== params.projetoId ||
    existente.etapa !== params.etapa ||
    existente.provedor !== params.provedor ||
    existente.modelo !== params.modelo ||
    existente.schema_versao !== params.schemaVersao;

  if (identidadeDivergente) {
    throw new ErroIdempotenciaResultadoPipeline(
      `Já existe um resultado para job_id=${params.jobId} com identidade diferente da informada agora (projeto/etapa/provedor/modelo/schema_versao) — não sobrescrito.`
    );
  }

  if (!resultadosEquivalentes(existente.resultado, params.resultado)) {
    throw new ErroIdempotenciaResultadoPipeline(
      `Já existe um resultado para job_id=${params.jobId} cujo conteúdo diverge do resultado atual (Gemini não é determinístico) — não sobrescrito. Investigue antes de reprocessar este job.`
    );
  }

  return { id: existente.id as string };
}
