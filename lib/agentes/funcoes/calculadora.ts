/**
 * `calculadora.calcular` — AGENT-FACTORY-F3.
 *
 * ── NAO existe expressao aqui ───────────────────────────────────────
 *
 * A entrada e uma OPERACAO nomeada mais uma lista de valores. Nao ha
 * string de formula, nao ha `eval`, nao ha `new Function`, nao ha
 * parser de codigo — nem mesmo um "seguro", escrito a mao. A razao nao
 * e so injecao: um mini-avaliador de expressao e uma superficie que
 * cresce sozinha (parenteses, precedencia, unario, funcoes) e cada
 * crescimento e uma chance de o resultado divergir do que a pessoa leu.
 *
 * Com operacao nomeada, o conjunto do que pode acontecer e FINITO e
 * esta escrito em `OPERACOES`. O modelo compoe encadeando chamadas, e
 * cada passo fica visivel na auditoria — em vez de uma string opaca
 * cujo resultado ninguem consegue conferir depois.
 *
 * ── Precisao ────────────────────────────────────────────────────────
 *
 * Tudo passa pelo decimal exato de `planilhas/numeros.ts`: soma,
 * subtracao e multiplicacao sao exatas, divisao arredonda meio-para-par
 * uma vez. Nenhum `+` de ponto flutuante toca dinheiro.
 *
 * ── Falhas sao TIPADAS ──────────────────────────────────────────────
 *
 * Divisao por zero, valor ilegivel e magnitude fora do teto devolvem
 * codigo, nunca `NaN` nem `Infinity`. Um `NaN` viaja calado ate virar
 * um total, e um total `NaN` chega ao usuario como "R$ NaN".
 */
import "server-only";
import {
  ZERO,
  dividir,
  lerValorMonetario,
  media,
  multiplicar,
  paraTexto,
  porcentagem,
  somar,
  subtrair,
  type Decimal,
} from "@/lib/agentes/planilhas/numeros";
import type {
  ContextoFuncao,
  ResultadoInterpretacaoSaida,
  ResultadoValidacaoEntrada,
} from "@/lib/agentes/funcoes/registry";

export const OPERACOES_CALCULADORA = Object.freeze([
  "add", "subtract", "multiply", "divide", "percentage", "average",
] as const);
export type OperacaoCalculadora = (typeof OPERACOES_CALCULADORA)[number];

/** Quantos valores cabem numa chamada. */
export const MAX_VALORES = 1_000;

/**
 * Teto de magnitude, em unidades da escala.
 *
 * ~10^14 na escala 4 = cem trilhoes. Nenhum numero desta aplicacao
 * chega perto; passar disso e sinal de entrada errada, nao de negocio
 * grande. `bigint` nao estoura, entao sem este teto um valor absurdo
 * atravessaria calado e so apareceria como um total sem sentido.
 */
export const MAX_UNIDADES = 10n ** 18n;

export interface EntradaCalculadora {
  readonly operacao: OperacaoCalculadora;
  readonly valores: readonly (string | number)[];
}

export function validarEntradaCalculadora(argumentos: unknown): ResultadoValidacaoEntrada {
  if (typeof argumentos !== "object" || argumentos === null || Array.isArray(argumentos)) {
    return { valida: false, codigo: "entrada_nao_objeto" };
  }
  const a = argumentos as Record<string, unknown>;
  for (const k of Object.keys(a)) {
    if (k !== "operacao" && k !== "valores") return { valida: false, codigo: "campo_desconhecido" };
  }
  if (typeof a.operacao !== "string" ||
      !(OPERACOES_CALCULADORA as readonly string[]).includes(a.operacao)) {
    return { valida: false, codigo: "operacao_invalida" };
  }
  if (!Array.isArray(a.valores) || a.valores.length === 0) {
    return { valida: false, codigo: "valores_ausentes" };
  }
  if (a.valores.length > MAX_VALORES) return { valida: false, codigo: "valores_demais" };

  const op = a.operacao as OperacaoCalculadora;
  const binarias: readonly string[] = ["subtract", "divide", "percentage"];
  if (binarias.includes(op) && a.valores.length !== 2) {
    return { valida: false, codigo: "aridade_invalida" };
  }
  for (const v of a.valores) {
    if (typeof v !== "string" && typeof v !== "number") {
      return { valida: false, codigo: "valor_nao_escalar" };
    }
  }
  return { valida: true };
}

export type SaidaCalculadora =
  | {
      readonly ok: true;
      readonly operacao: OperacaoCalculadora;
      readonly resultado: string;
      readonly entradas: number;
    }
  | { readonly ok: false; readonly codigo: string };

/** O calculo, puro e sem `server-only` na cabeca — testavel direto. */
export function calcular(entrada: EntradaCalculadora): SaidaCalculadora {
  const numeros: Decimal[] = [];
  for (const bruto of entrada.valores) {
    const r = lerValorMonetario(bruto);
    if (r.tipo === "ambiguo") return { ok: false, codigo: "AMBIGUOUS_NUMBER_FORMAT" };
    if (r.tipo !== "ok") return { ok: false, codigo: "valor_invalido" };
    const mag = r.valor.unidades < 0n ? -r.valor.unidades : r.valor.unidades;
    if (mag > MAX_UNIDADES) return { ok: false, codigo: "valor_fora_do_limite" };
    numeros.push(r.valor);
  }

  const op = entrada.operacao;
  let valor: Decimal;

  if (op === "add") {
    valor = numeros.reduce(somar, ZERO);
  } else if (op === "subtract") {
    valor = subtrair(numeros[0], numeros[1]);
  } else if (op === "multiply") {
    valor = numeros.reduce((a, b) => multiplicar(a, b));
  } else if (op === "divide") {
    const r = dividir(numeros[0], numeros[1]);
    if (r.tipo === "erro") return { ok: false, codigo: r.codigo };
    valor = r.valor;
  } else if (op === "percentage") {
    valor = porcentagem(numeros[0], numeros[1]);
  } else {
    const r = media(numeros);
    if (r.tipo === "erro") return { ok: false, codigo: r.codigo };
    valor = r.valor;
  }

  const mag = valor.unidades < 0n ? -valor.unidades : valor.unidades;
  if (mag > MAX_UNIDADES) return { ok: false, codigo: "resultado_fora_do_limite" };

  return { ok: true, operacao: op, resultado: paraTexto(valor), entradas: numeros.length };
}

export async function executarCalculadora(
  contexto: ContextoFuncao,
  argumentos: unknown
): Promise<unknown> {
  void contexto;   // aritmetica nao depende de dono nem de conexao
  return calcular(argumentos as EntradaCalculadora);
}

export function interpretarSaidaCalculadora(saida: unknown): ResultadoInterpretacaoSaida {
  if (typeof saida !== "object" || saida === null || Array.isArray(saida)) {
    return { tipo: "invalida" };
  }
  const s = saida as Record<string, unknown>;
  if (s.ok === false) {
    if (typeof s.codigo !== "string") return { tipo: "invalida" };
    return {
      tipo: "erro",
      codigo: s.codigo,
      mensagem: "Nao foi possivel calcular com os valores recebidos.",
      // Calculo e deterministico: repetir da o mesmo erro. Dizer
      // `retryable: true` convidaria a uma repeticao inutil.
      retryable: false,
    };
  }
  if (
    s.ok !== true ||
    typeof s.operacao !== "string" ||
    typeof s.resultado !== "string" ||
    typeof s.entradas !== "number" ||
    !/^-?\d+\.\d+$/.test(s.resultado)
  ) {
    return { tipo: "invalida" };
  }
  return { tipo: "sucesso", data: saida };
}
