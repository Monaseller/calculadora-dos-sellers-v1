/**
 * Máquina de estados do Pipeline — função pura, sem banco, sem I/O.
 * Espelha a tabela de transições da arquitetura (Revisão 2, seção 6).
 *
 * Usada como checagem defensiva antes de qualquer UPDATE de status
 * fora das duas RPCs (ex.: cancelarPipeline()/pausarPipeline() em
 * pipeline.ts) — as RPCs de avanço/falha já garantem suas próprias
 * transições internamente em SQL, mas as funções mais simples
 * (cancelar/pausar/retomar) fazem UPDATE direto e usam isto para não
 * aplicar uma transição inválida.
 */
import { StatusPipeline } from "./tipos";

const TRANSICOES: Record<StatusPipeline, StatusPipeline[]> = {
  [StatusPipeline.CRIADO]: [StatusPipeline.AGUARDANDO, StatusPipeline.AGUARDANDO_PENDENCIAS, StatusPipeline.CANCELADO],
  [StatusPipeline.AGUARDANDO]: [StatusPipeline.EM_EXECUCAO, StatusPipeline.PAUSADO, StatusPipeline.CANCELADO],
  [StatusPipeline.EM_EXECUCAO]: [
    StatusPipeline.AGUARDANDO,
    StatusPipeline.AGUARDANDO_PENDENCIAS,
    StatusPipeline.CONCLUIDO,
    StatusPipeline.ERRO,
    StatusPipeline.PAUSADO,
    StatusPipeline.CANCELADO,
  ],
  [StatusPipeline.AGUARDANDO_PENDENCIAS]: [StatusPipeline.AGUARDANDO, StatusPipeline.PAUSADO, StatusPipeline.CANCELADO],
  [StatusPipeline.ERRO]: [StatusPipeline.AGUARDANDO, StatusPipeline.PAUSADO, StatusPipeline.CANCELADO],
  [StatusPipeline.PAUSADO]: [
    StatusPipeline.AGUARDANDO,
    StatusPipeline.EM_EXECUCAO,
    StatusPipeline.AGUARDANDO_PENDENCIAS,
    StatusPipeline.CANCELADO,
  ],
  [StatusPipeline.CONCLUIDO]: [],
  [StatusPipeline.CANCELADO]: [],
};

export function transicaoValida(de: StatusPipeline, para: StatusPipeline): boolean {
  return TRANSICOES[de]?.includes(para) ?? false;
}

export function proximosEstadosValidos(de: StatusPipeline): StatusPipeline[] {
  return TRANSICOES[de] ?? [];
}

export function estadoTerminal(status: StatusPipeline): boolean {
  return status === StatusPipeline.CONCLUIDO || status === StatusPipeline.CANCELADO;
}
