/**
 * Decimal exato e leitura de valor monetario — AGENT-FACTORY-F3.
 *
 * ── Por que nao `number` ────────────────────────────────────────────
 *
 * `0.1 + 0.2 === 0.30000000000000004`. Num relatorio financeiro isso
 * vira centavo faltando que ninguem consegue explicar, e o repositorio
 * ja proibe estimativa em numero de dinheiro. Nao ha biblioteca decimal
 * entre as dependencias — foram auditadas antes — e adicionar uma e
 * decisao de supply-chain que este gate nao autoriza. Entao o valor
 * vive como INTEIRO em `bigint`, numa escala fixa.
 *
 * ESCALA = 4 e deliberado: dinheiro tem 2 casas, e as outras duas sao a
 * folga para divisao e porcentagem arredondarem uma vez so, no fim, em
 * vez de a cada passo.
 *
 * ── O que continua sendo aproximacao, dito em voz alta ──────────────
 *
 * Soma, subtracao e multiplicacao sao EXATAS. Divisao nao pode ser: 1/3
 * nao cabe em 4 casas. Ela arredonda meio-para-par (o mesmo criterio de
 * contabilidade) e isso esta documentado em `dividir`, nao escondido.
 */

/** Casas decimais guardadas. Ver o cabecalho para o porque de 4. */
export const ESCALA = 4;
const FATOR = 10n ** BigInt(ESCALA);

/** Um decimal exato: `unidades` ja multiplicado por 10^ESCALA. */
export interface Decimal {
  readonly unidades: bigint;
}

export type ResultadoNumero =
  | { readonly tipo: "ok"; readonly valor: Decimal }
  | { readonly tipo: "ambiguo"; readonly codigo: "AMBIGUOUS_NUMBER_FORMAT"; readonly texto: string }
  | { readonly tipo: "invalido"; readonly texto: string };

export function deUnidades(unidades: bigint): Decimal {
  return { unidades };
}

export const ZERO: Decimal = { unidades: 0n };

/**
 * Converte um `number` nativo (celula numerica do Excel).
 *
 * Passa pela representacao decimal do proprio JS e nao por
 * multiplicacao em ponto flutuante: `Math.round(0.615 * 10000)` erra,
 * `"0.615"` nao.
 */
export function deNumeroNativo(n: number): ResultadoNumero {
  if (!Number.isFinite(n)) return { tipo: "invalido", texto: String(n) };
  return deTextoDecimal(n.toString(), String(n));
}

/** Le "-123.4567" (ponto como separador decimal, sem milhar). */
function deTextoDecimal(t: string, original: string): ResultadoNumero {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(t);
  if (!m) return { tipo: "invalido", texto: original };
  if (m[4] !== undefined) {
    // Notacao cientifica: normaliza por `Number` e volta, uma vez so.
    const expandido = Number(t);
    if (!Number.isFinite(expandido)) return { tipo: "invalido", texto: original };
    const semExpoente = expandido.toFixed(ESCALA);
    return deTextoDecimal(semExpoente, original);
  }
  const sinal = m[1] === "-" ? -1n : 1n;
  const inteiro = m[2];
  const frac = (m[3] ?? "").padEnd(ESCALA, "0");
  if (frac.length > ESCALA) {
    // Mais casas do que a escala guarda: arredonda meio-para-cima uma
    // unica vez, na entrada, e o resto do calculo e exato.
    const guardadas = frac.slice(0, ESCALA);
    const proxima = frac.charCodeAt(ESCALA) - 48;
    let u = BigInt(inteiro) * FATOR + BigInt(guardadas);
    if (proxima >= 5) u += 1n;
    return { tipo: "ok", valor: { unidades: sinal * u } };
  }
  return { tipo: "ok", valor: { unidades: sinal * (BigInt(inteiro) * FATOR + BigInt(frac)) } };
}

/**
 * Le um valor monetario escrito por humano.
 *
 * ── A regra de desempate, e onde ela se recusa a adivinhar ──────────
 *
 * Com os DOIS separadores presentes, o ULTIMO e o decimal: "1.234,56" e
 * "1,234.56" sao ambos sem duvida. Com so um separador e exatamente 3
 * digitos depois dele, "1.234" pode ser mil duzentos e trinta e quatro
 * (milhar pt-BR) ou um virgula duzentos e trinta e quatro (decimal
 * en-US) — e nada no texto decide. Ai devolve AMBIGUOUS_NUMBER_FORMAT
 * em vez de escolher, porque escolher errado por 1000x num total
 * financeiro e o tipo de erro que passa despercebido.
 *
 * `R$` DESFAZ essa duvida: quem escreve o simbolo escreve em pt-BR, e
 * ali o separador de 3 digitos e milhar. E evidencia no proprio texto,
 * nao um palpite sobre o usuario.
 */
export function lerValorMonetario(bruto: unknown): ResultadoNumero {
  if (typeof bruto === "number") return deNumeroNativo(bruto);
  if (typeof bruto !== "string") return { tipo: "invalido", texto: String(bruto) };

  const original = bruto;
  let t = bruto.trim();
  if (t === "") return { tipo: "invalido", texto: original };

  const temSimboloBRL = /R\$/i.test(t);
  t = t.replace(/R\$/gi, "").replace(/\s| /g, "");

  let negativo = false;
  if (/^\(.*\)$/.test(t)) {          // (1.234,56) — negativo contabil
    negativo = true;
    t = t.slice(1, -1);
  }
  if (t.startsWith("-")) {
    negativo = !negativo;
    t = t.slice(1);
  }
  if (t.startsWith("+")) t = t.slice(1);
  if (!/^[\d.,]+$/.test(t)) return { tipo: "invalido", texto: original };

  const pontos = (t.match(/\./g) ?? []).length;
  const virgulas = (t.match(/,/g) ?? []).length;

  let normalizado: string;
  if (pontos > 0 && virgulas > 0) {
    const decimal = t.lastIndexOf(".") > t.lastIndexOf(",") ? "." : ",";
    const milhar = decimal === "." ? "," : ".";
    normalizado = t.split(milhar).join("").replace(decimal, ".");
  } else if (pontos === 0 && virgulas === 0) {
    normalizado = t;
  } else {
    const sep = pontos > 0 ? "." : ",";
    const partes = t.split(sep);
    const ultima = partes[partes.length - 1];
    if (partes.length > 2) {
      // "1.234.567": so faz sentido como milhar.
      if (ultima.length !== 3) return { tipo: "invalido", texto: original };
      normalizado = partes.join("");
    } else if (ultima.length === 3 && partes[0].length >= 1 && partes[0].length <= 3) {
      if (temSimboloBRL) {
        normalizado = partes.join("");           // pt-BR: milhar
      } else if (sep === ",") {
        // "1,234" sem R$: virgula com 3 digitos e o caso classico
        // indecidivel — pt-BR leria 1,234; en-US leria 1234.
        return { tipo: "ambiguo", codigo: "AMBIGUOUS_NUMBER_FORMAT", texto: original };
      } else {
        return { tipo: "ambiguo", codigo: "AMBIGUOUS_NUMBER_FORMAT", texto: original };
      }
    } else {
      normalizado = `${partes[0]}.${ultima}`;    // separador decimal
    }
  }

  const r = deTextoDecimal(normalizado, original);
  if (r.tipo !== "ok" || !negativo) return r;
  return { tipo: "ok", valor: { unidades: -r.valor.unidades } };
}

// ─── Aritmetica ───────────────────────────────────────────────────────

export function somar(a: Decimal, b: Decimal): Decimal {
  return { unidades: a.unidades + b.unidades };
}
export function subtrair(a: Decimal, b: Decimal): Decimal {
  return { unidades: a.unidades - b.unidades };
}
/** Exato: (a*b) desce uma escala, com arredondamento meio-para-par. */
export function multiplicar(a: Decimal, b: Decimal): Decimal {
  return { unidades: dividirBigint(a.unidades * b.unidades, FATOR) };
}
export function comparar(a: Decimal, b: Decimal): number {
  return a.unidades < b.unidades ? -1 : a.unidades > b.unidades ? 1 : 0;
}
export function ehZero(a: Decimal): boolean {
  return a.unidades === 0n;
}

/** Meio-para-par ("banker's rounding"), o criterio contabil. */
function dividirBigint(n: bigint, d: bigint): bigint {
  const neg = (n < 0n) !== (d < 0n);
  const an = n < 0n ? -n : n;
  const ad = d < 0n ? -d : d;
  const q = an / ad;
  const r = an % ad;
  const dobro = r * 2n;
  let out = q;
  if (dobro > ad || (dobro === ad && q % 2n === 1n)) out = q + 1n;
  return neg ? -out : out;
}

export type ResultadoDivisao =
  | { readonly tipo: "ok"; readonly valor: Decimal }
  | { readonly tipo: "erro"; readonly codigo: "divisao_por_zero" };

/**
 * Divisao. Arredonda meio-para-par na ultima casa da escala.
 *
 * Divisao por zero NAO devolve `Infinity` nem `NaN`: devolve erro
 * tipado. `Infinity` viajaria como numero ate virar um total, e um
 * total infinito e pior do que uma falha.
 */
export function dividir(a: Decimal, b: Decimal): ResultadoDivisao {
  if (b.unidades === 0n) return { tipo: "erro", codigo: "divisao_por_zero" };
  return { tipo: "ok", valor: { unidades: dividirBigint(a.unidades * FATOR, b.unidades) } };
}

/** `porcentagem(200, 15)` = 30 — quanto e 15% de 200. */
export function porcentagem(valor: Decimal, percentual: Decimal): Decimal {
  return { unidades: dividirBigint(valor.unidades * percentual.unidades, FATOR * 100n) };
}

export function media(valores: readonly Decimal[]): ResultadoDivisao {
  if (valores.length === 0) return { tipo: "erro", codigo: "divisao_por_zero" };
  const total = valores.reduce((acc, v) => acc + v.unidades, 0n);
  return { tipo: "ok", valor: { unidades: dividirBigint(total, BigInt(valores.length)) } };
}

/**
 * Texto canonico, sempre com ponto decimal e sem separador de milhar.
 *
 * Formatacao para humano e decisao de UI, nao de calculo: se a Tool
 * devolvesse "R$ 1.234,56" o modelo teria de reinterpretar o proprio
 * resultado para reusa-lo, e reinterpretar e onde ele erra.
 */
export function paraTexto(d: Decimal, casas = 2): string {
  const neg = d.unidades < 0n;
  const u = neg ? -d.unidades : d.unidades;
  const ajustado =
    casas >= ESCALA
      ? u * 10n ** BigInt(casas - ESCALA)
      : dividirBigint(u, 10n ** BigInt(ESCALA - casas));
  const s = ajustado.toString().padStart(casas + 1, "0");
  const corte = s.length - casas;
  const texto = casas === 0 ? s : `${s.slice(0, corte)}.${s.slice(corte)}`;
  return neg && ajustado !== 0n ? `-${texto}` : texto;
}
