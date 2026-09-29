/**
 * O modelo comum de planilha — AGENT-FACTORY-F3.
 *
 * `.xlsx` e `.csv` chegam por caminhos diferentes e viram a MESMA
 * forma, para que `ler` e `agregar` nao tenham um ramo por formato. Um
 * `if (extensao)` dentro da agregacao significaria que a soma pode
 * divergir entre os dois, e e exatamente a soma que ninguem confere.
 */

/**
 * Uma celula.
 *
 * `formula` e o TEXTO da formula, quando existe, e `bruto` e o valor
 * CACHEADO que o Excel gravou junto. Sao coisas diferentes e ficam em
 * campos diferentes de proposito — ver `formulasPresentes` na inspecao.
 * Este leitor NUNCA recalcula: nao ha motor de formula aqui, e fingir
 * que ha seria prometer um numero que nao foi verificado.
 */
export interface Celula {
  readonly bruto: string | number | null;
  readonly formula: string | null;
}

export interface Aba {
  readonly nome: string;
  readonly linhas: readonly (readonly Celula[])[];
}

export interface Pasta {
  readonly abas: readonly Aba[];
}

// ─── Limites ──────────────────────────────────────────────────────────
//
// Existem porque o modelo pede o que couber na resposta dele, nao o que
// couber na memoria do servidor. Sem teto, "me traga a planilha" vira
// um milhao de linhas no prompt: caro, lento e inutil.

export const MAX_LINHAS_POR_LEITURA = 500;
export const MAX_CELULAS_POR_LEITURA = 5_000;
export const MAX_GRUPOS_RETORNADOS = 100;
export const MAX_ABAS_INSPECIONADAS = 50;

export const CELULA_VAZIA: Celula = Object.freeze({ bruto: null, formula: null });

export function celulaVazia(c: Celula | undefined): boolean {
  return c === undefined || c.bruto === null || (typeof c.bruto === "string" && c.bruto.trim() === "");
}

/** Texto da celula para exibicao/comparacao. Nunca `undefined`. */
export function textoDaCelula(c: Celula | undefined): string {
  if (c === undefined || c.bruto === null) return "";
  return typeof c.bruto === "number" ? String(c.bruto) : c.bruto;
}

/**
 * Cabecalhos de uma aba: a primeira linha, como TEXTO.
 *
 * Coluna sem cabecalho vira `coluna_<n>` em vez de string vazia —
 * duas colunas anonimas com o mesmo nome fariam `group` juntar dados de
 * lugares diferentes.
 */
export function cabecalhos(aba: Aba): readonly string[] {
  const primeira = aba.linhas[0] ?? [];
  const largura = larguraDaAba(aba);
  const saida: string[] = [];
  const vistos = new Set<string>();
  for (let i = 0; i < largura; i += 1) {
    const t = textoDaCelula(primeira[i]).trim();
    let nome = t === "" ? `coluna_${i + 1}` : t;
    if (vistos.has(nome)) {
      let n = 2;
      while (vistos.has(`${nome}_${n}`)) n += 1;
      nome = `${nome}_${n}`;
    }
    vistos.add(nome);
    saida.push(nome);
  }
  return saida;
}

export function larguraDaAba(aba: Aba): number {
  let w = 0;
  for (const l of aba.linhas) if (l.length > w) w = l.length;
  return w;
}

/** Quantas linhas de DADO (fora o cabecalho). */
export function linhasDeDado(aba: Aba): number {
  return Math.max(0, aba.linhas.length - 1);
}

export function acharAba(pasta: Pasta, nome: unknown): Aba | null {
  if (typeof nome !== "string") return null;
  const alvo = nome.trim().toLowerCase();
  return pasta.abas.find((a) => a.nome.toLowerCase() === alvo) ?? null;
}

/**
 * Uma celula "parece formula" se o TEXTO comeca com `=`, `+`, `-` ou
 * `@` — a forma que vira comando quando um CSV e aberto no Excel.
 *
 * Aqui nada e executado: este gate e somente leitura e nao exporta
 * arquivo nenhum. A funcao existe para que a inspecao possa AVISAR, e
 * para que o dia em que houver exportacao encontre o aviso ja pronto,
 * em vez de descobrir o problema depois.
 */
export function pareceFormulaEmTexto(bruto: string | number | null): boolean {
  if (typeof bruto !== "string") return false;
  const t = bruto.trimStart();
  return t.startsWith("=") || t.startsWith("+") || t.startsWith("@") ||
    (t.startsWith("-") && !/^-\s*\d/.test(t));
}
