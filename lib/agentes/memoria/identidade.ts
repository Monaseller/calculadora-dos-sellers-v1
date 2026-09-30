/**
 * A IDENTIDADE de memoria — AGENT-FACTORY-F7b.4.
 *
 * ── A regra que este modulo existe para cumprir ─────────────────────
 *
 * O Zep guarda memoria por `user`. Se o `user` do Zep fosse o
 * `CDS_USER_ID`, todos os agentes do mesmo dono dividiriam um grafo: o
 * que o Financeiro aprendesse apareceria no de Mensagens, e uma
 * preferencia de fechamento contabil vazaria para o agente que responde
 * pergunta de comprador.
 *
 * Por isso o principal de memoria e derivado de DOIS fatores:
 *
 *   CDS_USER_ID + AGENT_ID
 *
 * Um agente nao alcanca a memoria do outro porque nao existe nome que
 * ele possa formar para chegar la — nao porque alguem se lembrou de
 * filtrar.
 *
 * ── Por que hash, e por que NAO com segredo ─────────────────────────
 *
 * O `user_id` do Zep viaja para um servico externo. Concatenar os dois
 * uuids em claro entregaria a topologia da conta: quantos agentes, quais
 * ids, quem e o dono. O hash entrega um identificador opaco e estavel.
 *
 * E deliberadamente NAO ha segredo na entrada do hash. Um segredo
 * rotacionavel tornaria TODA a memoria inacessivel no dia da rotacao —
 * o agente esqueceria tudo porque uma chave mudou, e nao haveria como
 * voltar. A entropia vem dos proprios uuids (122 bits cada); um segredo
 * nao acrescentaria sigilo que importe e acrescentaria um modo de falha
 * catastrofico.
 *
 * ── Versao no prefixo, e por que ela e obrigatoria ──────────────────
 *
 * `zep-user-v1:` nao e enfeite. Se um dia a derivacao mudar — outro
 * algoritmo, outra ordem, outro separador — os principals antigos
 * continuam validos e legiveis pelo prefixo, e a migracao pode ser
 * gradual. Sem versao, mudar a formula seria perder a memoria de todos
 * os agentes de uma vez, em silencio.
 *
 * ── Este modulo e PURO ──────────────────────────────────────────────
 *
 * Nao le ambiente, nao fala com rede, nao toca banco. Recebe dois ids e
 * devolve strings. Por isso a derivacao pode ser testada sem chave e sem
 * custo, e e o que a suite faz.
 */
import { createHash } from "node:crypto";

/** A versao da derivacao. Muda junto com a formula, nunca sozinha. */
export const VERSAO_DO_PRINCIPAL = "v1";

const PREFIXO_PRINCIPAL = `zep-user-${VERSAO_DO_PRINCIPAL}:`;
const PREFIXO_THREAD = `zep-thread-${VERSAO_DO_PRINCIPAL}:`;

/**
 * A entrada do hash, com COMPRIMENTO declarado.
 *
 * A primeira versao deste modulo concatenava `userId + ":" + agenteId` e
 * o comentario afirmava que isso era injetivo porque uuid nao contem
 * `:`. A afirmacao era falsa, e o proprio teste a derrubou:
 *
 *   ("a:b", "c")  ->  "a:b:c"
 *   ("a",  "b:c") ->  "a:b:c"
 *
 * Mesma entrada, mesmo hash, MESMA memoria. A funcao aceita string
 * arbitraria, e depender de um formato que ela nao valida e depender de
 * sorte.
 *
 * Declarar o comprimento de cada parte remove a ambiguidade para
 * QUALQUER entrada, porque o parser implicito passa a saber onde a
 * primeira parte termina antes de ler a segunda:
 *
 *   ("a:b", "c")  ->  "3:a:b|1:c"
 *   ("a",  "b:c") ->  "1:a|3:b:c"
 */
function entradaCanonica(userId: string, agenteId: string): string {
  return `${userId.length}:${userId}|${agenteId.length}:${agenteId}`;
}

function limpo(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

/**
 * O principal de memoria de UM agente de UM dono.
 *
 * Lanca em entrada invalida em vez de devolver um principal degradado:
 * um id vazio produziria um hash valido, e esse hash seria um balde
 * compartilhado por todos os chamadores que errassem igual.
 */
export function principalDeMemoria(userId: unknown, agenteId: unknown): string {
  const u = limpo(userId);
  const a = limpo(agenteId);
  if (u === null || a === null) {
    throw new Error("principalDeMemoria exige userId e agenteId nao vazios");
  }
  const digest = createHash("sha256").update(entradaCanonica(u, a)).digest("hex");
  return PREFIXO_PRINCIPAL + digest;
}

/**
 * O thread de UMA conversa.
 *
 * Derivado so da conversa, e nao do par dono+agente: a conversa ja e
 * unica no CDS, e o thread e sempre criado JUNTO com o principal correto
 * (ver `garantirThread`), entao o vinculo dono+agente vive no lado do
 * Zep, no campo `user_id` do thread.
 *
 * Duas conversas do mesmo agente dao threads diferentes — e por isso que
 * o historico nao atravessa — enquanto as duas apontam para o MESMO
 * principal, que e por isso que a memoria atravessa.
 */
export function threadDeConversa(conversaId: unknown): string {
  const c = limpo(conversaId);
  if (c === null) throw new Error("threadDeConversa exige conversaId nao vazio");
  return PREFIXO_THREAD + createHash("sha256").update(c).digest("hex");
}

/** Reconhece um principal desta versao. Usado por diagnostico e teste. */
export function ehPrincipalDesteFormato(valor: unknown): boolean {
  return typeof valor === "string" &&
    valor.startsWith(PREFIXO_PRINCIPAL) &&
    valor.length === PREFIXO_PRINCIPAL.length + 64 &&
    /^[0-9a-f]+$/.test(valor.slice(PREFIXO_PRINCIPAL.length));
}
