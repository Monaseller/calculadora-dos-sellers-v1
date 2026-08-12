/**
 * Acesso a estudio_anuncios_imagens_origem — fotos originais reais do
 * produto, enviadas pelo usuário.
 *
 * ETAPA (2026-08-08 — Upload real da foto do produto).
 *
 * Regras de negócio implementadas aqui (não na rota):
 * - No máximo 1 foto com e_principal=true por projeto (o índice único
 *   parcial idx_imagens_origem_principal já garante isso no banco —
 *   este módulo só decide QUANDO marcar principal, nunca insere uma
 *   segunda violando o índice).
 * - Primeira foto do projeto (nenhuma existente antes do upload) pode
 *   ser marcada principal automaticamente; uploads seguintes nunca
 *   substituem a principal já existente.
 * - `ordem` começa em 1 e novos uploads recebem a próxima ordem
 *   disponível (MAX(ordem) + 1, nunca reaproveitando números).
 * - Nunca guarda a URL assinada no banco — é gerada sob demanda a
 *   cada leitura via lib/estudio-anuncios/storage.ts.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ImagemOrigem, FotoRespostaAPI } from "./tipos";
import { gerarUrlAssinada } from "./storage";

/** Estado necessário para decidir ordem/principal de um novo lote de uploads. */
export interface EstadoFotosProjeto {
  total: number;
  proximaOrdem: number;
  temPrincipal: boolean;
}

export async function obterEstadoFotosProjeto(
  supabase: SupabaseClient,
  projetoId: string
): Promise<EstadoFotosProjeto> {
  const { data, error } = await supabase
    .from("estudio_anuncios_imagens_origem")
    .select("ordem, e_principal")
    .eq("projeto_id", projetoId);

  if (error) {
    throw new Error(`Falha ao consultar fotos existentes do projeto: ${error.message}`);
  }

  const linhas = data || [];
  const total = linhas.length;
  const maiorOrdem = linhas.reduce((max, l) => Math.max(max, l.ordem ?? 0), 0);
  const temPrincipal = linhas.some(l => l.e_principal === true);

  return { total, proximaOrdem: maiorOrdem + 1, temPrincipal };
}

export interface DadosNovaFoto {
  projeto_id: string;
  storage_path: string;
  ordem: number;
  e_principal: boolean;
  largura_px: number | null;
  altura_px: number | null;
  tamanho_bytes: number;
  mime_type: string;
  nome_original: string;
}

/**
 * Insere o registro da foto — só deve ser chamada DEPOIS do upload ao
 * Storage já ter tido sucesso (nunca antes, ver rota). Lança em caso
 * de erro; o chamador é responsável por excluir o objeto recém-
 * enviado do Storage como ação compensatória.
 */
export async function inserirFoto(
  supabaseServico: SupabaseClient,
  dados: DadosNovaFoto
): Promise<ImagemOrigem> {
  const { data, error } = await supabaseServico
    .from("estudio_anuncios_imagens_origem")
    .insert(dados)
    .select("*")
    .single();

  if (error || !data) {
    throw new Error(`Falha ao registrar foto no banco: ${error?.message ?? "sem dados retornados"}`);
  }
  return data as ImagemOrigem;
}

/** Molda uma linha do banco para o formato de resposta da API, com URL assinada gerada na hora. */
export async function paraRespostaFoto(
  supabaseServico: SupabaseClient,
  imagem: ImagemOrigem
): Promise<FotoRespostaAPI> {
  const urlAssinada = await gerarUrlAssinada(supabaseServico, imagem.storage_path);
  return {
    id: imagem.id,
    ordem: imagem.ordem,
    principal: imagem.e_principal,
    mimeType: imagem.mime_type ?? null,
    tamanhoBytes: imagem.tamanho_bytes ?? null,
    largura: imagem.largura_px ?? null,
    altura: imagem.altura_px ?? null,
    urlAssinada,
  };
}

/**
 * Lista as linhas BRUTAS (não o formato de resposta da API — sem URL
 * assinada) de um projeto, ordenadas principal primeiro e depois por
 * `ordem ASC`. Uso exclusivo de lib/estudio-anuncios/analise-visual.ts
 * para decidir quais fotos baixar do Storage e enviar ao Gemini —
 * nunca exposta em rota HTTP diretamente (rotas usam
 * listarFotosPorProjeto/paraRespostaFoto, que nunca vazam
 * storage_path).
 *
 * ETAPA (2026-08-09 — Primeira API real: Gemini para análise visual).
 */
export async function listarFotosOrdenadasParaAnalise(
  supabaseServico: SupabaseClient,
  projetoId: string
): Promise<ImagemOrigem[]> {
  const { data, error } = await supabaseServico
    .from("estudio_anuncios_imagens_origem")
    .select("*")
    .eq("projeto_id", projetoId)
    .order("e_principal", { ascending: false })
    .order("ordem", { ascending: true });

  if (error) {
    throw new Error(`Falha ao listar fotos para análise visual: ${error.message}`);
  }
  return (data || []) as ImagemOrigem[];
}

/** Lista todas as fotos de um projeto, ordenadas por `ordem`, já no formato de resposta da API. */
export async function listarFotosPorProjeto(
  supabase: SupabaseClient,
  supabaseServico: SupabaseClient,
  projetoId: string
): Promise<FotoRespostaAPI[]> {
  const { data, error } = await supabase
    .from("estudio_anuncios_imagens_origem")
    .select("*")
    .eq("projeto_id", projetoId)
    .order("ordem", { ascending: true });

  if (error) {
    throw new Error(`Falha ao listar fotos do projeto: ${error.message}`);
  }

  const linhas = (data || []) as ImagemOrigem[];
  return Promise.all(linhas.map(l => paraRespostaFoto(supabaseServico, l)));
}
