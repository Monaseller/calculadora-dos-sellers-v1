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
  /**
   * A aprovacao que este passo criou — F7b.4.4.
   *
   * Gravada na mensagem de proposito: depois de um refresh, e ela que
   * permite a tela reencontrar o cartao sem inventar estado. O que a
   * pessoa ve vem do banco, e nao da memoria do browser (§11).
   */
  readonly aprovacaoId?: string;
  /**
   * Dados MINIMOS de apresentacao do passo — F8.1-B4A.
   *
   * Este campo contem SOMENTE dados de apresentacao explicitamente
   * allowlisted, campo a campo, por `apresentacaoDoPasso`. Ele NUNCA
   * recebe o output de uma Tool copiado automaticamente: nada de
   * `porDia`, pedido, item, comprador, request/response bruto ou
   * credencial. Ausente = nao ha apresentacao estruturada.
   */
  readonly apresentacao?: ApresentacaoDoPasso;
}

/** A Funcao cujo resultado pode virar apresentacao. Hoje, uma so. */
export const FUNCAO_VENDAS_ML = "mercadolivre.vendas.consultar";

/**
 * Uniao FECHADA. Um tipo novo entra aqui com o seu `tipo` literal e o
 * seu extrator — nunca como `unknown`/`Record` generico.
 *
 * `vendas_ml`: os quatro agregados e o periodo que o runtime do Mercado
 * Livre JA calculou (`VendasBrutasML` + `periodo`). Copiados, nunca
 * recalculados: a semantica financeira (date_closed, total_amount, sem
 * pack_splitted, ticket = valor/vendas) mora no runtime.
 */
export type ApresentacaoDoPasso = {
  readonly tipo: "vendas_ml";
  readonly valor: number;
  readonly vendas: number;
  readonly unidades: number;
  readonly ticketMedio: number;
  readonly periodo: { readonly de: string; readonly ate: string };
};

/**
 * A apresentacao de UM passo de SUCESSO, ou `null`.
 *
 * Recebe o `data` do envelope de sucesso — a saida ja validada por
 * `interpretarSaidaVendasML` — e devolve um objeto NOVO, montado chave a
 * chave. `null` para outra Funcao, consulta incompleta
 * (`completo !== true` ou `vendasBrutas === null`) e qualquer forma
 * inesperada: na duvida, nao ha card, e o texto continua valendo.
 *
 * Quem chama garante que o passo foi SUCESSO; erro, recusa e aprovacao
 * pendente nem chegam aqui.
 */
export function apresentacaoDoPasso(
  funcaoId: string,
  data: unknown
): ApresentacaoDoPasso | null {
  if (funcaoId !== FUNCAO_VENDAS_ML) return null;
  if (typeof data !== "object" || data === null) return null;
  const saida = data as Record<string, unknown>;
  if (saida.completo !== true) return null;

  const brutas = saida.vendasBrutas;
  if (typeof brutas !== "object" || brutas === null) return null;
  const { valor, vendas, unidades, ticketMedio } = brutas as Record<string, unknown>;
  const finito = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  if (!finito(valor) || !finito(vendas) || !finito(unidades) || !finito(ticketMedio)) {
    return null;
  }

  const periodo = saida.periodo;
  if (typeof periodo !== "object" || periodo === null) return null;
  const { de, ate } = periodo as Record<string, unknown>;
  if (typeof de !== "string" || de === "" || typeof ate !== "string" || ate === "") {
    return null;
  }

  return { tipo: "vendas_ml", valor, vendas, unidades, ticketMedio, periodo: { de, ate } };
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
