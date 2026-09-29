/**
 * CONVERSAS do agente — o contrato puro. AGENT-FACTORY-F7a.
 *
 * ── HISTORICO nao e MEMORIA, e nenhum dos dois e FONTE ──────────────
 *
 * HISTORICO  o que foi dito NAQUELA conversa. Nasce e morre com ela.
 * MEMORIA    preferencia que a PESSOA escreveu. Atravessa todas.
 * FONTE      arquivo que a pessoa entregou. Atravessa todas.
 *
 * A consequencia pratica, e a que a suite cobra: abrir uma conversa
 * nova zera o assunto e NAO zera o agente. As fontes continuam la, as
 * memorias continuam la, as Skills continuam la — so o fio da conversa
 * recomeca.
 *
 * ── Nao existe papel `sistema` ──────────────────────────────────────
 *
 * Regras, instrucoes, Skills e memorias sao MONTADAS a cada turno pela
 * camada de contexto (F6), a partir do estado de AGORA. Persistir a
 * instrucao junto da mensagem faria uma conversa antiga continuar
 * obedecendo uma Skill que o dono ja removeu — e ninguem entenderia por
 * que.
 *
 * ── Este modulo e PURO ──────────────────────────────────────────────
 */

export const PAPEIS_DE_MENSAGEM = Object.freeze(["usuario", "assistente"] as const);
export type PapelDeMensagem = (typeof PAPEIS_DE_MENSAGEM)[number];

/** Espelha `agente_mensagens_conteudo_tamanho`. */
export const MAX_CONTEUDO_DA_MENSAGEM = 20_000;
export const MAX_TITULO_DA_CONVERSA = 200;

/**
 * Quantos turnos do historico entram no contexto.
 *
 * O historico e pago em token a cada turno, igual a memoria. 20
 * mensagens (~10 idas e voltas) e o ponto onde a conversa ainda faz
 * sentido para o modelo sem que uma thread longa encareca sozinha.
 * Estourar NAO apaga nada do banco: so o que ENTRA no prompt e cortado,
 * pelas mais recentes, e o runtime declara quantas ficaram de fora.
 */
export const MAX_MENSAGENS_NO_CONTEXTO = 20;

export interface Conversa {
  readonly id: string;
  readonly userId: string;
  readonly agenteId: string;
  readonly titulo: string | null;
  readonly arquivada: boolean;
  readonly criadoEm: string;
  readonly atualizadoEm: string;
}

/** Um passo de ferramenta, como a UI vai mostrar em "Ver dados usados". */
export interface PassoRegistrado {
  readonly funcaoId: string;
  readonly desfecho: string;
  readonly executou: boolean;
  readonly requestId: string | null;
}

export interface Mensagem {
  readonly id: string;
  readonly userId: string;
  readonly conversaId: string;
  readonly papel: PapelDeMensagem;
  readonly conteudo: string;
  readonly ordem: number;
  readonly passos: readonly PassoRegistrado[] | null;
  readonly provedor: string | null;
  readonly modelo: string | null;
  readonly tokensEntrada: number | null;
  readonly tokensSaida: number | null;
  readonly tempoMs: number | null;
  readonly criadoEm: string;
}

export type ResultadoValidacao =
  | { readonly ok: true }
  | { readonly ok: false; readonly codigo: string; readonly mensagem: string };

export function validarMensagemDoUsuario(conteudo: unknown): ResultadoValidacao {
  if (typeof conteudo !== "string" || conteudo.trim() === "") {
    return { ok: false, codigo: "mensagem_vazia", mensagem: "Escreva uma mensagem." };
  }
  if (conteudo.length > MAX_CONTEUDO_DA_MENSAGEM) {
    return {
      ok: false,
      codigo: "mensagem_longa",
      mensagem: `Mensagem acima de ${MAX_CONTEUDO_DA_MENSAGEM} caracteres. Para documento, use uma fonte.`,
    };
  }
  return { ok: true };
}

export function validarTitulo(titulo: unknown): ResultadoValidacao {
  if (titulo === undefined || titulo === null) return { ok: true };
  if (typeof titulo !== "string" || titulo.trim() === "" ||
      titulo.length > MAX_TITULO_DA_CONVERSA) {
    return { ok: false, codigo: "titulo_invalido", mensagem: "Titulo invalido." };
  }
  return { ok: true };
}

/**
 * Corta o historico que vai ao modelo.
 *
 * Pelas MAIS RECENTES, porque o fim da conversa e o que da sentido a
 * pergunta atual. O que ficou de fora e contado e devolvido — cortar
 * calado faria o agente parecer esquecido sem ninguem saber por que.
 */
export function recortarHistorico(
  mensagens: readonly Mensagem[],
  max: number = MAX_MENSAGENS_NO_CONTEXTO
): { readonly incluidas: readonly Mensagem[]; readonly excluidasPorTeto: number } {
  const ordenadas = [...mensagens].sort((a, b) => a.ordem - b.ordem);
  if (ordenadas.length <= max) return { incluidas: ordenadas, excluidasPorTeto: 0 };
  return {
    incluidas: ordenadas.slice(ordenadas.length - max),
    excluidasPorTeto: ordenadas.length - max,
  };
}
