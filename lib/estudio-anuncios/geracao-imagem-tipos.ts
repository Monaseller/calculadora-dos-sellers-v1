/**
 * Tipos de domínio da etapa `geracao_imagem` — independentes de
 * provedor. Mesmo princípio das etapas anteriores: o cliente específico
 * do Google vive em `lib/ai-gateway/provedores/google-imagem.ts`, que
 * não conhece estes tipos; quem os une é `geracao-imagem.ts`.
 *
 * PAPEL DA ETAPA: **executar** o contrato produzido por
 * `geracao_prompts_imagem`. Ela não decide estratégia visual, não
 * inventa prompt, não reinterpreta copy comercial, não altera a
 * quantidade de imagens, não cria texto, não cria CTA, não muda
 * marketplace, não recalcula score e não refaz `analise_visual`.
 *
 * ORIGEM SEMÂNTICA: `geracao_prompts_imagem` — aqui, diferente da etapa
 * anterior, o job imediatamente anterior na fila **é** a origem
 * semântica, porque o artefato consumido é exatamente o
 * `EnvelopeGeracaoPromptsImagem`. As fotos originais entram como
 * REFERÊNCIA VISUAL, mas referência não é artefato de domínio consumido:
 * `job_origem_id` continua sendo um só.
 */
import type { TipoImagem } from "./geracao-prompts-imagem-tipos";

/**
 * MIMEs aceitos na SAÍDA. Interseção do que o bucket
 * `estudio-anuncios-gerado` aceita com o CHECK `chk_imagens_geradas_mime`
 * (migration 20260816) — nunca uma lista própria que pudesse divergir do
 * banco. `video/mp4` é aceito pelo bucket mas não por esta etapa: aqui
 * só se gera imagem estática.
 */
export const MIMES_IMAGEM_GERADA = ["image/jpeg", "image/png", "image/webp"] as const;
export type MimeImagemGerada = (typeof MIMES_IMAGEM_GERADA)[number];

/**
 * Tolerância de proporção — **decisão do usuário (2026-08-16): rejeitar,
 * nunca transformar.** Uma imagem fora de 1:1 além desta margem falha
 * como `conteudo_rejeitado` e o job entra no retry normal. Não há crop
 * nem resize server-side: nenhuma transformação silenciosa da imagem, e
 * nenhuma dependência nova (sharp não foi instalado).
 *
 * 2% absorve só arredondamento do provedor (ex.: 1024×1024 exato passa;
 * 1024×1000 ≈ 2,4% não passa).
 */
export const TOLERANCIA_ASPECT_RATIO = 0.02;

/** Piso de qualidade: abaixo disso a imagem não serve para anúncio. */
export const DIMENSAO_MINIMA_PX = 512;
/** Teto de sanidade — protege memória/Storage contra resposta anômala. */
export const DIMENSAO_MAXIMA_PX = 4096;
/** Teto de bytes por imagem gerada, bem abaixo do limite do bucket (200MB). */
export const TAMANHO_MAXIMO_IMAGEM_BYTES = 20 * 1024 * 1024;

/**
 * Limites da referência visual. Constantes, não variáveis de ambiente:
 * são regra de domínio desta etapa, e as variáveis existentes
 * (`GOOGLE_AI_MAX_IMAGES`/`GOOGLE_AI_MAX_BYTES`) têm escopo declarado
 * "por análise visual" — reaproveitá-las mudaria o significado
 * documentado delas.
 */
export const MAX_REFERENCIAS_VISUAIS = 3;
export const MAX_BYTES_REFERENCIAS = 8 * 1024 * 1024;

/** Foto original efetivamente enviada como referência — montado 100% pelo servidor. */
export interface ReferenciaUtilizada {
  imagemOrigemId: string;
  ordem: number;
  principal: boolean;
}

/** Configuração efetiva desta execução, congelada junto do resultado. */
export interface ConfiguracaoGeracaoImagem {
  quantidadePrevista: number;
  aspectRatio: string;
  toleranciaAspectRatio: number;
  dimensaoMinimaPx: number;
  dimensaoMaximaPx: number;
  referencias: ReferenciaUtilizada[];
}

/**
 * Referência a uma imagem persistida. Deliberadamente MAGRO: o envelope
 * guarda só o vínculo, nunca os bytes (proibido) e nunca uma cópia dos
 * metadados que já vivem em `estudio_anuncios_imagens_geradas`
 * (storage_path, mime, dimensões, tamanho, provedor, modelo). Quem quer
 * o metadado lê a tabela por `imagemGeradaId`; quem quer o prompt exato
 * lê o envelope de origem por `ordem`. Zero duplicação.
 */
export interface ImagemGeradaRef {
  imagemGeradaId: string;
  ordem: number;
  principal: boolean;
  finalidade: TipoImagem;
  /** true quando esta execução reaproveitou uma imagem já persistida (retry idempotente). */
  reaproveitada: boolean;
}

/** Referência embutida ao job/resultado de geracao_prompts_imagem consumido. */
export interface FontePromptsImagem {
  jobId: string;
  resultadoId: string;
  schemaVersao: number;
}

/**
 * Envelope persistido em `estudio_anuncios_resultados_pipeline.resultado`.
 * Nunca contém base64, nunca contém bytes, nunca contém URL assinada.
 */
export interface EnvelopeGeracaoImagem {
  fontePromptsImagem: FontePromptsImagem;
  configuracao: ConfiguracaoGeracaoImagem;
  imagens: ImagemGeradaRef[];
}

export const SCHEMA_VERSAO_GERACAO_IMAGEM = 1;
