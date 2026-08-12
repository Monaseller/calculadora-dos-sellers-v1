/**
 * Acesso mínimo à fila estudio_anuncios_jobs, usado pela rota interna
 * (app/api/internal/estudio-anuncios/executar).
 *
 * AJUSTE (2026-08-06 — integração funcional): marcarJobConcluido() e
 * marcarJobErro() foram REMOVIDAS por pedido explícito — a rota não
 * marca mais o job manualmente antes de avançar/falhar o Pipeline; as
 * RPCs atômicas (estudio_anuncios_pipeline_concluir_job/_falhar_job,
 * envelopadas em lib/estudio-anuncios/pipeline/pipeline.ts) fazem essa
 * mudança de status do job na MESMA transação em que avançam/falham o
 * Pipeline. Manter essas duas funções aqui seria código morto que
 * convida a reintroduzir a janela de inconsistência que a integração
 * atômica resolveu.
 *
 * NÃO inclui claim (isso é exclusivo do worker, via RPC
 * claim_next_estudio_anuncios_job — nunca duplicado aqui) nem criação
 * de job (isso é CRUD, fora do escopo desta tarefa).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface JobEstudioAnuncios {
  id: string;
  projeto_id: string;
  etapa: string;
  status: string;
  tentativas: number;
  max_tentativas: number;
}

/** Regex simples de formato UUID (v1-v5, minúsculo/maiúsculo) — sem dependência nova. */
export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function buscarJobPorId(
  supabase: SupabaseClient,
  jobId: string
): Promise<JobEstudioAnuncios | null> {
  const { data, error } = await supabase
    .from("estudio_anuncios_jobs")
    .select("id, projeto_id, etapa, status, tentativas, max_tentativas")
    .eq("id", jobId)
    .maybeSingle();

  if (error || !data) return null;
  return data as JobEstudioAnuncios;
}

/**
 * AJUSTE (2026-08-06 — UI do Projeto Mestre): usado exclusivamente pela
 * leitura somente-leitura em GET /api/estudio-anuncios/projetos/[id]
 * (ver ali — pipeline/jobs só são buscados DEPOIS de confirmar que o
 * projeto pertence ao usuário da sessão). Não é chamado pela rota
 * interna nem pelo worker.
 */
export interface JobEstudioAnunciosDetalhado {
  id: string;
  /** Índice 1-based calculado aqui por ordem de criado_em — não é uma coluna do banco (estudio_anuncios_jobs não tem campo "ordem"). */
  ordem: number;
  etapa: string;
  status: string;
  tentativas: number;
  maxTentativas: number;
  provedor: string | null;
  criadoEm: string;
  iniciadoEm: string | null;
  heartbeatEm: string | null;
  concluidoEm: string | null;
  erroTipo: string | null;
  erroMensagem: string | null;
}

/** Lista os jobs de um projeto, ordenados por criado_em ASC (ordem real de execução). Somente leitura. */
export async function listarJobsPorProjeto(
  supabase: SupabaseClient,
  projetoId: string
): Promise<JobEstudioAnunciosDetalhado[]> {
  const { data, error } = await supabase
    .from("estudio_anuncios_jobs")
    .select("id, etapa, status, tentativas, max_tentativas, provedor, criado_em, iniciado_em, heartbeat_em, concluido_em, erro_tipo, erro_mensagem")
    .eq("projeto_id", projetoId)
    .order("criado_em", { ascending: true });

  if (error) throw new Error(`Falha ao listar jobs do projeto: ${error.message}`);

  return (data ?? []).map((row: any, index: number) => ({
    id: row.id,
    ordem: index + 1,
    etapa: row.etapa,
    status: row.status,
    tentativas: row.tentativas,
    maxTentativas: row.max_tentativas,
    provedor: row.provedor,
    criadoEm: row.criado_em,
    iniciadoEm: row.iniciado_em,
    heartbeatEm: row.heartbeat_em,
    concluidoEm: row.concluido_em,
    erroTipo: row.erro_tipo,
    erroMensagem: row.erro_mensagem,
  }));
}
