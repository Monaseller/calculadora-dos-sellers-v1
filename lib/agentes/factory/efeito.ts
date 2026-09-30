/**
 * O EFEITO de uma operacao — AGENT-FACTORY-F7b.4.5 §2/§4/§5.
 *
 * ── A decisao de produto que este modulo codifica ───────────────────
 *
 * Aprovacao NAO e por Tool. E por EFEITO.
 *
 *   ler, consultar, buscar, inspecionar, analisar, calcular
 *     -> roda sozinho. Nao ha o que confirmar: nada muda no mundo.
 *
 *   escrever, alterar, apagar, enviar, publicar, gastar
 *     -> o dono confirma ANTES do efeito.
 *
 * Antes disto, adicionar qualquer ferramenta levava o dono a escolher
 * entre tres niveis — inclusive para "ler uma planilha". Pedir permissao
 * para ler e ruido: gasta a atencao que deveria sobrar para o momento em
 * que algo muda de verdade.
 *
 * ── §4: a classificacao NAO deriva do nome ──────────────────────────
 *
 * Function INTERNA: vem de `DefinicaoFuncao.acesso`, que e declarado no
 * registry ao lado do executor. E metadado nosso, revisado em code review.
 *
 * Acao EXTERNA: vem da tag `readOnlyHint` do catalogo do Composio.
 * MEDIDO em `/tools/{slug}`:
 *
 *   GOOGLESHEETS_GET_SPREADSHEET_INFO  tags: [readOnlyHint, openWorldHint, important]
 *   HACKERNEWS_GET_ITEM_WITH_ID        tags: [openWorldHint, readOnlyHint]
 *   GOOGLESHEETS_ADD_SHEET             tags: [googlesheets, sheet, important]
 *   GMAIL_SEND_EMAIL                   tags: [important, openWorldHint]
 *
 * Ou seja: o catalogo diz quem e somente-leitura, e os que escrevem
 * simplesmente nao tem a tag. O slug entra apenas como reforco — nunca
 * como unica fonte, e nunca para RELAXAR: uma acao sem `readOnlyHint`
 * continua sendo tratada como efetiva mesmo que o nome pareca leitura.
 *
 * ── UNKNOWN e conservador, sempre ───────────────────────────────────
 *
 * Sem sinal confiavel, a resposta e "pode ter efeito". O custo de errar
 * para o lado cauteloso e um clique a mais; para o outro lado, e uma
 * alteracao que ninguem autorizou.
 */

export const EFEITOS = Object.freeze([
  /** Le dados e nao muda nada. */
  "READ_ONLY",
  /** Calcula a partir do que recebeu. Nao toca em lugar nenhum. */
  "CALCULATION",
  /** Cria ou altera dado. */
  "WRITE",
  /** Remove dado. */
  "DESTRUCTIVE",
  /** Manda algo para fora — mensagem, e-mail, resposta a cliente. */
  "SEND",
  /** Torna algo publico. */
  "PUBLISH",
  /** Move dinheiro, preco ou cobranca. */
  "FINANCIAL_EFFECT",
  /** Nao ha sinal confiavel. Tratado como efetivo. */
  "UNKNOWN",
] as const);

export type Efeito = (typeof EFEITOS)[number];

/** Os UNICOS efeitos que dispensam confirmacao. A lista curta e a defesa. */
export const EFEITOS_SEM_CONFIRMACAO: readonly Efeito[] =
  Object.freeze(["READ_ONLY", "CALCULATION"]);

/**
 * Este efeito precisa da confirmacao do dono antes de acontecer?
 *
 * Por LISTA de permitidos, e nao por lista de proibidos: um efeito novo
 * acrescentado a `EFEITOS` sem passar por aqui cai automaticamente no
 * lado que confirma — que e o lado seguro.
 */
export function exigeConfirmacao(efeito: Efeito): boolean {
  return !EFEITOS_SEM_CONFIRMACAO.includes(efeito);
}

/**
 * O nivel que a CDS SUGERE para este efeito.
 *
 * Sugestao, e nao decisao: quem confirma continua sendo o dono (§13 do
 * F7b.4.4). O que muda e que ler deixou de exigir deliberacao.
 */
export function nivelSugeridoParaEfeito(efeito: Efeito): "automatico" | "aprovacao" {
  return exigeConfirmacao(efeito) ? "aprovacao" : "automatico";
}

/**
 * O efeito de uma Function INTERNA.
 *
 * `acesso` vem do registry, onde mora ao lado do executor. Nao ha
 * heuristica: se a Funcao declara `escrita`, ela escreve.
 *
 * `calculadora.*` e a unica famiia que recebe `CALCULATION` — ela nao le
 * nem escreve nada, so opera sobre o que recebeu. A distincao nao muda a
 * decisao (os dois dispensam confirmacao), mas mantem a auditoria
 * legivel: "calculou" e "leu" sao coisas diferentes.
 */
export function efeitoDaFuncaoInterna(entrada: {
  readonly funcaoId: string;
  readonly acesso: "leitura" | "escrita";
}): Efeito {
  if (entrada.acesso === "escrita") return "WRITE";
  return entrada.funcaoId.startsWith("calculadora.") ? "CALCULATION" : "READ_ONLY";
}

/** Verbos que, no slug, indicam efeito. Usados para AGRAVAR, nunca aliviar. */
const VERBOS_DE_EFEITO: readonly { readonly padrao: RegExp; readonly efeito: Efeito }[] =
  Object.freeze([
    { padrao: /_(delete|remove|destroy|drop|clear|trash)(_|$)/i, efeito: "DESTRUCTIVE" },
    { padrao: /_(send|reply|email|message|notify|post_message)(_|$)/i, efeito: "SEND" },
    { padrao: /_(publish|share|make_public)(_|$)/i, efeito: "PUBLISH" },
    { padrao: /_(pay|charge|refund|invoice|price|checkout)(_|$)/i, efeito: "FINANCIAL_EFFECT" },
  ]);

/**
 * O efeito de uma acao EXTERNA.
 *
 * ── A ordem, e por que ela e esta ───────────────────────────────────
 *
 * 1. Verbo de efeito no slug vence PRIMEIRO. `GMAIL_SEND_EMAIL` e `SEND`
 *    mesmo que um dia ganhe `readOnlyHint` por engano do catalogo — o
 *    sinal mais grave prevalece.
 * 2. `readOnlyHint` presente -> `READ_ONLY`.
 * 3. Sem nenhum sinal -> `UNKNOWN`, que confirma.
 *
 * Nunca o contrario: nao ha caminho em que o slug ALIVIE a classificacao.
 */
export function efeitoDaAcaoExterna(entrada: {
  readonly slug: string;
  readonly tags: readonly string[];
}): Efeito {
  const slug = entrada.slug.trim().toUpperCase();

  for (const v of VERBOS_DE_EFEITO) {
    if (v.padrao.test(slug)) return v.efeito;
  }

  const somenteLeitura = entrada.tags.some(
    (t) => t.trim().toLowerCase() === "readonlyhint");
  if (somenteLeitura) return "READ_ONLY";

  // Sem tag e sem verbo conhecido: pode escrever. O catalogo nao marca
  // escrita explicitamente, entao a ausencia do sinal de leitura e o que
  // temos — e ela nao autoriza nada sozinha.
  return "UNKNOWN";
}

/** A frase que a tela mostra. Curta, e sobre o EFEITO — nunca sobre o id. */
export function fraseDoEfeito(efeito: Efeito): string {
  switch (efeito) {
    case "READ_ONLY": return "Só consulta dados. Não altera nada.";
    case "CALCULATION": return "Só faz contas. Não altera nada.";
    case "WRITE": return "Altera dados no aplicativo.";
    case "DESTRUCTIVE": return "Apaga dados. Não dá para desfazer.";
    case "SEND": return "Envia algo para fora — pode chegar a outra pessoa.";
    case "PUBLISH": return "Torna algo público.";
    case "FINANCIAL_EFFECT": return "Mexe com valores, preços ou cobrança.";
    case "UNKNOWN": return "Pode alterar algo. Na dúvida, pedimos confirmação.";
  }
}
