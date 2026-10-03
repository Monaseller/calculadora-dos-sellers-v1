import "server-only";

/**
 * A memoria automatica de UMA conversa — F9.1-D.
 *
 * ── O defeito que este modulo fecha ─────────────────────────────────
 *
 * A politica (`memoria/politica.ts`) ja barra o resultado CRU de
 * ferramenta. Mas a resposta final do assistente repete o que a
 * ferramenta leu — "Quantidade 123, Valor R$ 456,78" — e ela era
 * ingerida. O Zep transforma o thread em FATO no grafo do dono+agente,
 * e o grafo atravessa conversas. Medido no Preview do F9.1: um anexo
 * "Usar somente nesta conversa" reapareceu, como lembranca, numa conversa
 * nova do mesmo agente.
 *
 * ── A regra: a conversa inteira, e para sempre ──────────────────────
 *
 * Uma conversa que TEM ou JA TEVE anexo de escopo `conversa` nao alimenta
 * a memoria automatica: nem a fala do usuario, nem a do assistente. Por
 * conversa e nao por turno, porque o dado lido no turno 2 pode ser
 * repetido no turno 5 sem ferramenta nenhuma — pelo modelo, a partir do
 * historico, ou pelo proprio usuario ("certo, entao sao 123 unidades").
 * E para sempre, porque remover o anexo nao desfaz o que ja foi dito.
 *
 * O que NAO muda: conversa sem anexo segue ingerindo como antes; arquivo
 * PERMANENTE do agente nao marca nada (ele ja vale em toda conversa);
 * memoria manual, historico da propria conversa e recuperacao seguem
 * iguais. Turnos anteriores ao primeiro anexo ja foram ingeridos limpos e
 * ficam.
 *
 * ── Fail-closed ─────────────────────────────────────────────────────
 *
 * Se a verificacao falhar, a conversa NAO e ingerida. Perder uma memoria
 * automatica e recuperavel; vazar dado de um anexo nao e.
 *
 * ── Uma porta so ────────────────────────────────────────────────────
 *
 * Todo caminho que ingerir turno de conversa passa por aqui. A retomada
 * de aprovacao hoje nao ingere; se um dia ingerir, e por esta funcao — a
 * suite do F9.1-D reprova qualquer outro chamador de `ingerirTurno`.
 */
import {
  ingerirTurno,
  type EscopoDeMemoria,
  type ResultadoDaIngestao,
} from "@/lib/agentes/memoria/automatica";
import type { MensagemDaConversa } from "@/lib/agentes/memoria/politica";

/** Pergunta a origem dos anexos. Lanca em falha. */
export type VerificarAnexoDaConversa = (userId: string, conversaId: string) => Promise<boolean>;

export type ResultadoDaIngestaoDaConversa =
  | ResultadoDaIngestao
  | {
      readonly desfecho: "isolada";
      /** POR QUE nada foi enviado. Diagnostico, nunca conteudo. */
      readonly motivo: "anexo_da_conversa" | "verificacao_falhou";
      readonly mensagensIngeridas: 0;
    };

export async function ingerirTurnoDaConversa(
  escopo: EscopoDeMemoria,
  mensagens: readonly MensagemDaConversa[],
  temOuTeveAnexo: VerificarAnexoDaConversa
): Promise<ResultadoDaIngestaoDaConversa> {
  // Memoria desligada nao consulta nada — nem banco, nem Zep. Igual a antes.
  if (!escopo.memoriaAtiva) return ingerirTurno(escopo, mensagens);

  let marcada: boolean;
  try {
    marcada = await temOuTeveAnexo(escopo.userId, escopo.conversaId);
  } catch {
    // Sem ids e sem mensagem do driver: o fato basta para o operador.
    console.error("[conversas/memoria] verificacao de anexo falhou; turno nao ingerido");
    return { desfecho: "isolada", motivo: "verificacao_falhou", mensagensIngeridas: 0 };
  }
  if (marcada) return { desfecho: "isolada", motivo: "anexo_da_conversa", mensagensIngeridas: 0 };

  return ingerirTurno(escopo, mensagens);
}
