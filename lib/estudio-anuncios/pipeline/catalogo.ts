/**
 * Acesso de LEITURA ao catálogo do Pipeline (Decisão 3 — única fonte
 * de verdade é o banco: estudio_anuncios_pipeline_catalogo +
 * estudio_anuncios_pipeline_catalogo_jobs).
 *
 * Este módulo NÃO decide "qual é a próxima etapa" — isso é
 * responsabilidade exclusiva das RPCs (estudio_anuncios_pipeline_avancar/
 * _registrar_falha), para não duplicar a mesma lógica em TypeScript e
 * PL/pgSQL (proibido pela Decisão 3). As funções aqui só servem para
 * OUTRAS partes do sistema (ex.: uma futura tela de progresso, ou uma
 * validação antes de chamar iniciarPipeline()) inspecionarem o
 * catálogo sem duplicar a decisão de avanço.
 *
 * Nome da tabela de mapeamento (era "..._catalogo_subetapas") ajustado
 * nesta revisão (2026-08-05) para estudio_anuncios_pipeline_catalogo_jobs.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DefinicaoEtapaCatalogo, SubetapaCatalogo, EtapaPipeline, TipoEtapa } from "./tipos";

const COLUNAS_CATALOGO =
  "id, versao_catalogo, ordem, etapa, ativa, tipo, depende_de, usa_gateway, gera_arquivos, permite_paralelismo, timeout_ms, max_tentativas";

const COLUNAS_SUBETAPA = "id, catalogo_id, ordem, job_etapa, obrigatoria, permite_multiplos";

function mapearCatalogo(row: any): DefinicaoEtapaCatalogo {
  return {
    id: row.id,
    versaoCatalogo: row.versao_catalogo,
    ordem: row.ordem,
    etapa: row.etapa as EtapaPipeline,
    ativa: row.ativa,
    tipo: row.tipo as TipoEtapa,
    dependeDe: (row.depende_de ?? []) as EtapaPipeline[],
    usaGateway: row.usa_gateway,
    geraArquivos: row.gera_arquivos,
    permiteParalelismo: row.permite_paralelismo,
    timeoutMs: row.timeout_ms,
    maxTentativas: row.max_tentativas,
  };
}

function mapearSubetapa(row: any): SubetapaCatalogo {
  return {
    id: row.id,
    catalogoId: row.catalogo_id,
    ordem: row.ordem,
    jobEtapa: row.job_etapa,
    obrigatoria: row.obrigatoria,
    permiteMultiplos: row.permite_multiplos,
  };
}

/** Todas as etapas de uma versão do catálogo, em ordem. */
export async function listarCatalogo(
  supabase: SupabaseClient,
  versaoCatalogo: number
): Promise<DefinicaoEtapaCatalogo[]> {
  const { data, error } = await supabase
    .from("estudio_anuncios_pipeline_catalogo")
    .select(COLUNAS_CATALOGO)
    .eq("versao_catalogo", versaoCatalogo)
    .order("ordem", { ascending: true });

  if (error) throw new Error(`Falha ao listar catálogo do Pipeline: ${error.message}`);
  return (data ?? []).map(mapearCatalogo);
}

/** Só as etapas ativas de uma versão, em ordem — o que a RPC efetivamente considera. */
export async function listarCatalogoAtivo(
  supabase: SupabaseClient,
  versaoCatalogo: number
): Promise<DefinicaoEtapaCatalogo[]> {
  const { data, error } = await supabase
    .from("estudio_anuncios_pipeline_catalogo")
    .select(COLUNAS_CATALOGO)
    .eq("versao_catalogo", versaoCatalogo)
    .eq("ativa", true)
    .order("ordem", { ascending: true });

  if (error) throw new Error(`Falha ao listar catálogo ativo do Pipeline: ${error.message}`);
  return (data ?? []).map(mapearCatalogo);
}

export async function obterDefinicaoEtapa(
  supabase: SupabaseClient,
  versaoCatalogo: number,
  etapa: EtapaPipeline
): Promise<DefinicaoEtapaCatalogo | null> {
  const { data, error } = await supabase
    .from("estudio_anuncios_pipeline_catalogo")
    .select(COLUNAS_CATALOGO)
    .eq("versao_catalogo", versaoCatalogo)
    .eq("etapa", etapa)
    .maybeSingle();

  if (error) throw new Error(`Falha ao buscar etapa "${etapa}" do catálogo: ${error.message}`);
  return data ? mapearCatalogo(data) : null;
}

/** Subetapas (valores de estudio_anuncios_jobs.etapa) de uma etapa ampla, em ordem. */
export async function listarSubetapas(
  supabase: SupabaseClient,
  catalogoId: string
): Promise<SubetapaCatalogo[]> {
  const { data, error } = await supabase
    .from("estudio_anuncios_pipeline_catalogo_jobs")
    .select(COLUNAS_SUBETAPA)
    .eq("catalogo_id", catalogoId)
    .order("ordem", { ascending: true });

  if (error) throw new Error(`Falha ao listar subetapas do catálogo: ${error.message}`);
  return (data ?? []).map(mapearSubetapa);
}
