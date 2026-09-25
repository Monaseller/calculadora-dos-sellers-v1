/**
 * OBS-3 R1 — quem mexeu no cursor, e quando.
 *
 * ── O BURACO QUE ESTE MODULO FECHA ──────────────────────────────────
 *
 * A tabela de continuacao tem UMA linha por (agente, plataforma,
 * recurso), e TODA execucao da rota dedicada escreve nela — inclusive as
 * diagnosticas. As execucoes 38 e 39 desta frente provaram isso na
 * pratica: `diag-*` passou pelo mesmo caminho e moveu o mesmo cursor.
 *
 * Reconstruir `fim(Bn) = inicio(Bn+1)` sem olhar quem mais escreveu no
 * intervalo produz duas mentiras simetricas:
 *
 *   FABRICA PROGRESSO — o scheduler ficou parado em 100, um `diag`
 *   moveu para 200, e o bucket seguinte comeca em 200. A inferencia
 *   ingenua credita 100->200 ao scheduler e ESCONDE um travamento.
 *
 *   FABRICA TRAVAMENTO — um `diag` reinicia o cursor para 0 e o
 *   scheduler seguinte recomeca do mesmo lugar do anterior, parecendo
 *   nao ter andado.
 *
 * Nenhuma das duas pode acontecer. Quando a proveniencia nao pode ser
 * provada, a transicao e INCERTA — nunca progresso, nunca travamento.
 *
 * ── O QUE E OBSERVAVEL, E O QUE NAO E ───────────────────────────────
 *
 * O desfecho da acao carrega `cursor_atualizado` e `cursor_reiniciado`,
 * entao uma execucao QUE TERMINOU diz se escreveu. Uma execucao que
 * morreu antes do desfecho nao diz nada — e o cursor e escrito ANTES do
 * desfecho. Essa e a lacuna, e ela e tratada fechando: sem terminal, a
 * execucao CONTA como possivel escritora.
 *
 * Puro: sem banco, sem rede, sem `server-only`.
 */
import { lerIdentidadeDeAcaoDoScheduler } from "./scheduler-bucket";

/** O prefixo que a identidade manual do workflow usava. Evidencia real. */
export const PREFIXO_DIAGNOSTICO = "diag-";

export type TipoDeOperacao =
  | "scheduler_bucket"
  | "diagnostico"
  | "desconhecido";

export interface EvidenciaDeMutacaoDoCursor {
  readonly userId: string;
  readonly agenteId: string;
  readonly plataforma: string;
  readonly recurso: string;
  readonly requestId: string;
  readonly tipoDeOperacao: TipoDeOperacao;
  /** Preenchido quando a operacao e do agendador. */
  readonly canonicalBucketId: string | null;
  /** Epoch ms da ABERTURA — o cursor e escrito durante a execucao. */
  readonly ocorridoEm: number;
  /** `null` quando a execucao nao chegou ao desfecho: nao se sabe. */
  readonly cursorAtualizado: boolean | null;
  readonly cursorReiniciado: boolean | null;
  readonly temTerminal: boolean;
}

/**
 * Classifica a operacao pela CHAVE, reusando a gramatica real.
 *
 * Sem casamento frouxo de prefixo: `w5m-` so vale quando a chave inteira
 * passa pelo parser do agendador. Tudo o que nao e reconhecido cai em
 * `desconhecido`, que contamina — fail closed.
 */
export function classificarOperacao(idempotencyKey: unknown): {
  readonly tipo: TipoDeOperacao;
  readonly canonicalBucketId: string | null;
} {
  const leitura = lerIdentidadeDeAcaoDoScheduler(idempotencyKey);
  if (leitura.ok) {
    return { tipo: "scheduler_bucket", canonicalBucketId: leitura.identidade.canonicalBucketId };
  }
  if (typeof idempotencyKey === "string") {
    // `provedor:operationId:acao:agente` — o operationId e o miolo.
    const partes = idempotencyKey.split(":");
    if (partes.length >= 4) {
      const operationId = partes.slice(1, partes.length - 2).join(":");
      if (operationId.startsWith(PREFIXO_DIAGNOSTICO)) {
        return { tipo: "diagnostico", canonicalBucketId: null };
      }
    }
  }
  return { tipo: "desconhecido", canonicalBucketId: null };
}

/**
 * Esta evidencia PODE ter escrito o cursor?
 *
 * Negativo so quando a execucao terminou E declarou que nao escreveu.
 * Sem terminal, a resposta e "pode" — o cursor e escrito antes do
 * desfecho, entao a ausencia de desfecho nao prova ausencia de escrita.
 */
export function podeTerEscritoOCursor(e: EvidenciaDeMutacaoDoCursor): boolean {
  if (!e.temTerminal) return true;
  if (e.cursorAtualizado === null || e.cursorReiniciado === null) return true;
  return e.cursorAtualizado === true || e.cursorReiniciado === true;
}

/** A evidencia pertence ao mesmo cursor que esta sendo analisado? */
export function noMesmoEscopo(
  e: EvidenciaDeMutacaoDoCursor,
  escopo: { readonly agenteId: string; readonly plataforma: string; readonly recurso: string }
): boolean {
  return (
    e.agenteId === escopo.agenteId &&
    e.plataforma === escopo.plataforma &&
    e.recurso === escopo.recurso
  );
}
