/**
 * Tipos do Pipeline Orchestrator — Fase 1.
 *
 * Espelham as tabelas de
 * supabase/migrations/20260805_estudio_anuncios_pipeline_schema.sql
 * (ainda NÃO executada — ver chat). Nenhuma lógica aqui, só formato.
 *
 * O catálogo (ordem, subetapas, aplicabilidade) mora no banco
 * (estudio_anuncios_pipeline_catalogo / _catalogo_jobs) — única
 * fonte de verdade (Decisão 3 da arquitetura). Este arquivo só
 * declara o formato do que vem de lá; não redefine as regras.
 */

export enum StatusPipeline {
  CRIADO = "criado",
  AGUARDANDO = "aguardando",
  EM_EXECUCAO = "em_execucao",
  AGUARDANDO_PENDENCIAS = "aguardando_pendencias",
  CONCLUIDO = "concluido",
  ERRO = "erro",
  CANCELADO = "cancelado",
  PAUSADO = "pausado",
}

export enum EtapaPipeline {
  ANALISE_PRODUTO = "analise_produto",
  PENDENCIAS = "pendencias",
  GERAR_CONTEUDO = "gerar_conteudo",
  GERAR_IMAGENS = "gerar_imagens",
  GERAR_VIDEO = "gerar_video",
  AVALIACAO = "avaliacao",
  EXPORTACAO = "exportacao",
}

export enum TipoEtapa {
  OBRIGATORIA = "obrigatoria",
  CONDICIONAL = "condicional",
  MANUAL = "manual",
}

export enum TipoEvento {
  PIPELINE_INICIADO = "pipeline_iniciado",
  JOB_CRIADO = "job_criado",
  JOB_CONCLUIDO = "job_concluido",
  JOB_ERRO = "job_erro",
  ETAPA_CONCLUIDA = "etapa_concluida",
  PIPELINE_CONCLUIDO = "pipeline_concluido",
  PIPELINE_CANCELADO = "pipeline_cancelado",
  PIPELINE_PAUSADO = "pipeline_pausado",
  PIPELINE_RETOMADO = "pipeline_retomado",
}

/** Linha de estudio_anuncios_pipeline. */
export interface PipelineEstudioAnuncios {
  id: string;
  projetoId: string;
  etapaAtual: EtapaPipeline | null;
  status: StatusPipeline;
  jobAtualId: string | null;
  proximaEtapa: EtapaPipeline | null;
  /** Versão do CATÁLOGO (definição das etapas) com que este pipeline nasceu. */
  versaoCatalogo: number;
  /** Versão do FLUXO/comportamento do Pipeline em si — conceito distinto de versaoCatalogo (ver migration de schema). */
  versaoPipeline: number;
  ultimaExecucao: string | null;
  proximaExecucao: string | null;
  erroTipo: string | null;
  erroMensagem: string | null;
  criadoEm: string;
  atualizadoEm: string;
  concluidoEm: string | null;
  canceladoEm: string | null;
}

/** Linha de estudio_anuncios_pipeline_catalogo. */
export interface DefinicaoEtapaCatalogo {
  id: string;
  versaoCatalogo: number;
  ordem: number;
  etapa: EtapaPipeline;
  ativa: boolean;
  tipo: TipoEtapa;
  dependeDe: EtapaPipeline[];
  usaGateway: boolean;
  geraArquivos: boolean;
  permiteParalelismo: boolean;
  timeoutMs: number | null;
  maxTentativas: number;
}

/** Linha de estudio_anuncios_pipeline_catalogo_jobs (mapeamento etapa ampla → estudio_anuncios_jobs.etapa; tabela renomeada nesta revisão, era "..._subetapas"). */
export interface SubetapaCatalogo {
  id: string;
  catalogoId: string;
  ordem: number;
  jobEtapa: string; // valor de estudio_anuncios_jobs.etapa
  obrigatoria: boolean;
  permiteMultiplos: boolean;
}

/** Estrutura preparada, sem Event Bus (ver arquitetura, seção Eventos). */
export interface EventoPipeline {
  tipo: TipoEvento;
  projetoId: string;
  pipelineId: string;
  etapa?: EtapaPipeline;
  jobId?: string;
  timestamp: string;
  detalhe?: Record<string, unknown>;
}
