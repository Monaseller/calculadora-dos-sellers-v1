/**
 * Tipos-base do AI Gateway (lib/ai-gateway/*).
 *
 * Fase 0: só contratos/interfaces — nenhuma chamada real a
 * OpenAI/Anthropic/Google acontece nesta fase (Decisão 2,
 * ESTUDIO_ANUNCIOS_IA_CONSOLIDACAO_ARQUITETURA.md). O Gateway só passa
 * a chamar um provedor de verdade a partir da Fase 2.
 *
 * `TipoTarefaIA` é a classificação de CONTEÚDO usada para gravar em
 * central_ia_prompts.tipo (CHECK do banco, não pode ser alterado nesta
 * tarefa) — diferente de `tarefa` em `SolicitacaoIA`, que é a ETAPA do
 * job (estudio_anuncios_jobs.etapa, ex.: "ping"). São dois conceitos
 * relacionados mas não idênticos: nem toda etapa de job tem uma
 * categoria de conteúdo própria (é o caso de "ping" — ver
 * lib/ai-gateway/registro.ts para o mapeamento explícito).
 */

export type TipoTarefaIA = "texto" | "imagem" | "video" | "seo" | "revisao" | "auditoria";

export type ProvedorIA = "openai" | "anthropic" | "google" | "fake" | "internal";

export interface SolicitacaoIA {
  modulo: string;
  projetoId: string;
  jobId: string;
  /** Etapa do job (estudio_anuncios_jobs.etapa) — ex.: "ping". */
  tarefa: string;
  promptTexto: string;
}

export interface RespostaIA {
  provedor: ProvedorIA;
  modelo: string;
  sucesso: boolean;
  conteudo: string;
  custoEstimado: number;
  custoReal: number;
  tokensEntrada: number;
  /** Total de saida, todas as modalidades. */
  tokensSaida: number;
  /**
   * Subconjunto de `tokensSaida` cobrado como IMAGEM (2026-08-18).
   * So as etapas que geram imagem preenchem; ausente/0 nas de texto,
   * onde a saida tem uma taxa unica. Existe porque o modelo de imagem
   * cobra saida de texto e saida de imagem a taxas MUITO diferentes
   * ($3 vs $60 por 1M) - sem separar, o custo sairia errado em silencio.
   */
  tokensSaidaImagem?: number;
  unidadesGeradas: number;
  tempoMs: number;
}

export type TipoErroIA = "transient" | "auth" | "rate_limit" | "conteudo_rejeitado" | "validation" | "unknown";

export interface ErroIA {
  tipo: TipoErroIA;
  mensagem: string;
}
