/**
 * O que SAI da CDS para a memoria externa — AGENT-FACTORY-F7b.4.
 *
 * ── A pergunta que este modulo responde ─────────────────────────────
 *
 * Ingerir "a conversa" e facil de dizer e perigoso de fazer. Uma conversa
 * carrega o que o usuario digitou, o que o agente respondeu, e tambem —
 * se ninguem cortar — instrucao de sistema, resultado cru de ferramenta,
 * e qualquer coisa que tenha caido numa mensagem de erro.
 *
 * Aqui a regra e de ALLOWLIST: entram dois papeis, e mais nada.
 *
 * ── Resultado de ferramenta NAO entra ───────────────────────────────
 *
 * Decisao do MVP, e ela e conservadora por um motivo concreto. O envelope
 * de uma Function carrega o dado que ela leu: linhas de planilha, valores
 * de venda, nome de comprador. Isso e dado do negocio do Rodrigo, e
 * manda-lo para um servico de memoria seria decidir uma questao de
 * privacidade de passagem.
 *
 * O que o agente precisa lembrar nao esta no resultado — esta no que a
 * pessoa PEDIU e em como ela quer a resposta. Isso vive nas duas
 * mensagens que entram.
 *
 * ── Sobre temporalidade (§22) ───────────────────────────────────────
 *
 * A estrategia escolhida e NAO construir classificador.
 *
 * O Zep monta um grafo temporal e invalida aresta antiga quando uma nova
 * a contradiz — e isso e feito por ele melhor do que uma heuristica
 * nossa faria. Um classificador caseiro que tentasse separar "prefiro
 * saldo primeiro" (estavel) de "o saldo e 2368.62" (transitorio) erraria
 * nos dois sentidos: descartaria preferencia escrita de forma estranha, e
 * guardaria numero escrito de forma parecida com preferencia.
 *
 * O que ESTE modulo faz e mais estreito e mais seguro: garante que nada
 * alem das duas mensagens legitimas atravesse, e redige o que parece
 * segredo. A questao de "por quanto tempo isso e verdade" fica com quem
 * tem grafo temporal para responde-la.
 *
 * ── Este modulo e PURO ──────────────────────────────────────────────
 *
 * Sem rede, sem env, sem banco. Recebe texto, devolve texto ou `null`.
 */

/** Teto por mensagem. Memoria nao e arquivo: texto enorme e anexo. */
export const MAX_CARACTERES_POR_MENSAGEM = 4000;

/**
 * Padroes que NAO podem sair da CDS.
 *
 * Nao e deteccao de segredo por nome de variavel — e por FORMA, porque o
 * que chega aqui e texto livre. A lista cobre o que de fato apareceria
 * numa mensagem: chave de provedor, token, URL assinada de storage,
 * cabecalho de autorizacao.
 *
 * Fail-closed por desenho: o que casa e substituido por marcador, e o
 * marcador e visivel. Uma mensagem com marcador e uma mensagem que
 * alguem vai investigar; uma mensagem com a chave dentro e um incidente.
 */
const PADROES_PROIBIDOS: readonly { readonly nome: string; readonly re: RegExp }[] =
  Object.freeze([
    { nome: "chave_anthropic", re: /sk-ant-[A-Za-z0-9_\-]{10,}/g },
    { nome: "chave_openai", re: /sk-(?:proj-)?[A-Za-z0-9_\-]{20,}/g },
    { nome: "chave_google", re: /AIza[A-Za-z0-9_\-]{30,}/g },
    { nome: "jwt", re: /eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/g },
    { nome: "bearer", re: /\b(?:Bearer|Api-Key)\s+[A-Za-z0-9_\-.]{12,}/gi },
    // URL assinada de storage: o que a torna perigosa e o token na query.
    { nome: "url_assinada", re: /https?:\/\/\S*[?&](?:token|signature|X-Amz-Signature)=[^\s&]+/gi },
    { nome: "postgres_url", re: /postgres(?:ql)?:\/\/\S+/gi },
  ]);

export const MARCADOR = "[REDIGIDO]";

export interface Redacao {
  readonly texto: string;
  /** Nomes dos padroes que casaram. Vazio no caminho normal. */
  readonly redigidos: readonly string[];
}

/** Aplica a allowlist de forma: o que parece segredo vira marcador. */
export function redigir(texto: string): Redacao {
  let saida = texto;
  const achados: string[] = [];
  for (const p of PADROES_PROIBIDOS) {
    // `RegExp` com `g` carrega `lastIndex`; recria para nao vazar estado
    // entre chamadas.
    const re = new RegExp(p.re.source, p.re.flags);
    if (re.test(saida)) {
      achados.push(p.nome);
      saida = saida.replace(new RegExp(p.re.source, p.re.flags), MARCADOR);
    }
  }
  return { texto: saida, redigidos: achados };
}

export interface MensagemDaConversa {
  readonly papel: string;
  readonly conteudo: string;
}

export interface MensagemAprovada {
  readonly papel: "user" | "assistant";
  readonly conteudo: string;
}

export interface ResultadoDaPolitica {
  readonly aprovadas: readonly MensagemAprovada[];
  /** Papeis recusados, para diagnostico. Nunca o conteudo deles. */
  readonly recusados: readonly string[];
  readonly redigidos: readonly string[];
}

/**
 * Os UNICOS dois papeis que atravessam.
 *
 * `sistema` nao existe como papel persistido nesta area (a instrucao e
 * composta por turno), e mesmo assim entra na recusa explicita: se um dia
 * passar a existir, ele nao atravessa por omissao.
 */
const PAPEIS_PERMITIDOS = Object.freeze(["usuario", "assistente"] as const);

const PARA_ZEP: Record<string, "user" | "assistant"> = {
  usuario: "user",
  assistente: "assistant",
};

/**
 * Filtra e prepara o que vai para a memoria.
 *
 * Mensagem vazia depois da redacao NAO entra: guardar `[REDIGIDO]`
 * sozinho poluiria o grafo com um episodio sem conteudo.
 */
export function prepararParaMemoria(
  mensagens: readonly MensagemDaConversa[]
): ResultadoDaPolitica {
  const aprovadas: MensagemAprovada[] = [];
  const recusados: string[] = [];
  const redigidos: string[] = [];

  for (const m of mensagens) {
    if (!(PAPEIS_PERMITIDOS as readonly string[]).includes(m.papel)) {
      recusados.push(m.papel);
      continue;
    }
    if (typeof m.conteudo !== "string") { recusados.push(m.papel); continue; }

    const r = redigir(m.conteudo.trim());
    for (const nome of r.redigidos) {
      if (!redigidos.includes(nome)) redigidos.push(nome);
    }
    const corpo = r.texto.slice(0, MAX_CARACTERES_POR_MENSAGEM).trim();
    if (corpo === "" || corpo === MARCADOR) continue;

    aprovadas.push({ papel: PARA_ZEP[m.papel], conteudo: corpo });
  }

  return { aprovadas, recusados, redigidos };
}
