/**
 * Tipos-base do módulo Estúdio de Anúncios com IA.
 *
 * Interfaces refletindo as colunas já criadas em
 * supabase/migrations/20260803_central_ia_estudio_anuncios_schema.sql —
 * nenhuma lógica, nenhuma função, nenhum import. Campos opcionais (`?`)
 * espelham colunas nullable no banco.
 *
 * Seção "CRUD do Projeto Mestre" (final do arquivo) adicionada na tarefa
 * de CRUD mínimo — tipos de entrada/saída das rotas
 * app/api/estudio-anuncios/projetos e .../[id].
 */

export type StatusProjeto =
  | "rascunho"
  | "aguardando_analise"
  | "analisando_produto"
  | "gerando_conteudo"
  | "revisando_conteudo"
  | "aguardando_aprovacao_conteudo"
  | "gerando_imagens"
  | "aguardando_aprovacao_imagens"
  | "gerando_video"
  | "aguardando_aprovacao_video"
  | "concluido"
  | "erro_parcial"
  | "cancelado";

export type ModoGeracao = "rapido" | "profissional";

export type Marketplace = "ML" | "Shopee" | "Amazon" | "TikTok Shop";

export type StatusProjetoMarketplace =
  | "aguardando"
  | "analisando"
  | "gerando_conteudo"
  | "gerando_imagens"
  | "gerando_video"
  | "aguardando_pendencias"
  | "concluido"
  | "erro_parcial"
  | "cancelado";

export interface ProjetoMestre {
  id: string;
  user_id: string;
  loja_id?: string | null;
  nome_produto: string;
  marketplace?: string | null;
  modo: ModoGeracao;
  quantidade_imagens_solicitada: number;
  estilo?: string | null;
  permitir_busca_externa: boolean;
  biblioteca_produto_id?: string | null;
  status: StatusProjeto;
  criado_em: string;
  atualizado_em: string;
  concluido_em?: string | null;
  cancelado_em?: string | null;
}

export interface ProjetoMarketplaceAdaptacao {
  id: string;
  projeto_id: string;
  marketplace: Marketplace;
  status: StatusProjetoMarketplace;
  criado_em: string;
  atualizado_em: string;
  concluido_em?: string | null;
}

export interface EntradaProduto {
  id: string;
  projeto_id: string;
  marca?: string | null;
  categoria?: string | null;
  modelo?: string | null;
  cor?: string | null;
  material?: string | null;
  medidas?: Record<string, unknown> | null;
  peso?: number | null;
  unidade_peso?: "g" | "kg" | null;
  quantidade?: number | null;
  conteudo_embalagem?: string | null;
  diferenciais?: string | null;
  observacoes?: string | null;
}

/**
 * AJUSTE (2026-08-08 — Upload real da foto do produto): campos
 * completados para refletir as colunas reais confirmadas por SQL
 * direto (incluindo mime_type/nome_original, adicionadas por
 * supabase/migrations/20260808_estudio_anuncios_imagens_origem_add_mime.sql,
 * já executada).
 */
export interface ImagemOrigem {
  id: string;
  projeto_id: string;
  storage_path: string;
  ordem: number;
  e_principal: boolean;
  largura_px?: number | null;
  altura_px?: number | null;
  tamanho_bytes?: number | null;
  mime_type?: string | null;
  nome_original?: string | null;
  criado_em: string;
}

/** Corpo de cada foto na resposta de POST/GET de fotos — nunca inclui storage_path. */
export interface FotoRespostaAPI {
  id: string;
  ordem: number;
  principal: boolean;
  mimeType: string | null;
  tamanhoBytes: number | null;
  largura: number | null;
  altura: number | null;
  urlAssinada: string | null;
}

/** Item de falha por arquivo em POST .../fotos — upload é por-arquivo, não all-or-nothing. */
export interface FalhaUploadFoto {
  nomeOriginal: string;
  motivo: string;
}

export interface Pendencia {
  id: string;
  projeto_id: string;
  campo: string;
  pergunta: string;
  resposta?: string | null;
  respondida_em?: string | null;
}

// ────────────────────────────────────────────────────────────────────
// CRUD do Projeto Mestre
// ────────────────────────────────────────────────────────────────────

export type EstiloProjeto =
  | "minimalista"
  | "premium"
  | "tecnologico"
  | "luxo"
  | "clean"
  | "infantil"
  | "marketplace";

/** Corpo aceito por POST /api/estudio-anuncios/projetos. */
export interface CriarProjetoInput {
  nome_produto: string;
  marketplaces: Marketplace[];
  quantidade_imagens: number;
  modo?: ModoGeracao;
  permitir_busca_externa?: boolean;
  estilo?: EstiloProjeto | null;
}

/**
 * Corpo aceito por PATCH /api/estudio-anuncios/projetos/[id]. Todos os
 * campos opcionais (atualização parcial) — mas o corpo como um todo não
 * pode vir vazio (ver lib/estudio-anuncios/validacao.ts). Não inclui
 * nenhum campo de estudio_anuncios_projetos_marketplace nem os campos
 * proibidos (user_id, id, status, criado_em, concluido_em, cancelado_em,
 * biblioteca_produto_id, loja_id, marketplace-resumo) — de propósito,
 * fora do escopo desta tarefa.
 */
export interface EditarProjetoInput {
  nome_produto?: string;
  quantidade_imagens_solicitada?: number;
  modo?: ModoGeracao;
  estilo?: EstiloProjeto | null;
  permitir_busca_externa?: boolean;
}

/** Projeto Mestre + suas adaptações por marketplace, para respostas de API. */
export interface ProjetoComAdaptacoes extends ProjetoMestre {
  adaptacoes: ProjetoMarketplaceAdaptacao[];
}
