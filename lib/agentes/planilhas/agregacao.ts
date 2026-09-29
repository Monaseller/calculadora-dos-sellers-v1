/**
 * Agregacao deterministica sobre uma aba — AGENT-FACTORY-F3.
 *
 * ── Por que `filter` e `group` NAO viraram Tools separadas ──────────
 *
 * O gate permitia dividir, desde que justificado. Ficaram como
 * MODIFICADORES de uma agregacao, e a razao e a propriedade que esta
 * frente inteira existe para garantir: o total nao pode ser calculado
 * pelo modelo.
 *
 * Com `filter` separado, "quanto entrou este mes" viraria: filtrar ->
 * receber as linhas -> somar. O ultimo passo cairia no modelo, que
 * somaria lendo numero de um texto — exatamente o erro que a Tool
 * existe para impedir. Com os modificadores juntos, a mesma pergunta e
 * UMA chamada, e a soma sai de codigo.
 *
 * `planilha.ler` continua existindo para quem precisa VER linhas. A
 * diferenca e clara: ler mostra, agregar conclui.
 *
 * ── Dinheiro nunca passa por `number` ───────────────────────────────
 *
 * `sum`, `min`, `max` e a media do calculo usam o decimal exato de
 * `numeros.ts`. Uma celula que nao e numero nao vira zero: entra em
 * `ignoradas`, e a contagem viaja na resposta. Zero silencioso e um
 * total errado que parece certo.
 */
import {
  ZERO,
  comparar,
  lerValorMonetario,
  paraTexto,
  somar,
  type Decimal,
} from "@/lib/agentes/planilhas/numeros";
import { inferirOrdem, lerData } from "@/lib/agentes/planilhas/datas";
import {
  MAX_GRUPOS_RETORNADOS,
  cabecalhos,
  celulaVazia,
  textoDaCelula,
  type Aba,
} from "@/lib/agentes/planilhas/tabela";

export const OPERACOES = Object.freeze([
  "count", "sum", "min", "max", "average", "distinct", "missing", "duplicates",
] as const);
export type Operacao = (typeof OPERACOES)[number];

export const OPERADORES = Object.freeze([
  "igual", "diferente", "contem", "maior", "menor", "entre", "vazio", "nao_vazio",
] as const);
export type OperadorFiltro = (typeof OPERADORES)[number];

export interface Filtro {
  readonly coluna: string;
  readonly operador: OperadorFiltro;
  readonly valor?: unknown;
  readonly ate?: unknown;
}

export interface PedidoAgregacao {
  readonly operacao: Operacao;
  /** Obrigatoria para tudo menos `count`. */
  readonly coluna?: string;
  readonly filtros?: readonly Filtro[];
  readonly agruparPor?: string;
}

export interface GrupoAgregado {
  readonly chave: string;
  readonly valor: string | number;
  readonly linhas: number;
}

export interface ResultadoAgregacao {
  readonly operacao: Operacao;
  readonly coluna: string | null;
  readonly valor: string | number | readonly string[] | null;
  readonly linhasNaAba: number;
  readonly linhasFiltradas: number;
  /** Celulas que a operacao NAO conseguiu ler como numero. */
  readonly ignoradas: number;
  readonly grupos: readonly GrupoAgregado[] | null;
  readonly gruposTruncados: boolean;
  readonly avisos: readonly string[];
}

export type SaidaAgregacao =
  | { readonly tipo: "ok"; readonly resultado: ResultadoAgregacao }
  | { readonly tipo: "erro"; readonly codigo: string; readonly mensagem: string };

function indiceDaColuna(aba: Aba, nome: unknown): number {
  if (typeof nome !== "string") return -1;
  const heads = cabecalhos(aba);
  const alvo = nome.trim().toLowerCase();
  return heads.findIndex((h) => h.toLowerCase() === alvo);
}

/** Valores de uma coluna, sem o cabecalho. */
function colunaBruta(aba: Aba, i: number): (string | number | null)[] {
  return aba.linhas.slice(1).map((l) => l[i]?.bruto ?? null);
}

// ─── Filtros ──────────────────────────────────────────────────────────

function comparavelComoNumero(a: unknown, b: unknown): [Decimal, Decimal] | null {
  const ra = lerValorMonetario(a);
  const rb = lerValorMonetario(b);
  if (ra.tipo !== "ok" || rb.tipo !== "ok") return null;
  return [ra.valor, rb.valor];
}

/**
 * Aplica os filtros. Devolve os indices de linha (base 0 sobre dados).
 *
 * A comparacao tenta, nesta ordem: data (quando a coluna foi inferida
 * como data e o alvo e ISO), numero, texto. Nao ha adivinhacao por
 * celula — a decisao de data e da COLUNA, como em `datas.ts`.
 */
function aplicarFiltros(
  aba: Aba,
  filtros: readonly Filtro[],
  avisos: string[]
): { indices: number[] } | { erro: string; mensagem: string } {
  const total = Math.max(0, aba.linhas.length - 1);
  let indices = Array.from({ length: total }, (_, i) => i);

  for (const f of filtros) {
    const i = indiceDaColuna(aba, f.coluna);
    if (i < 0) return { erro: "coluna_inexistente", mensagem: `Coluna '${String(f.coluna)}' nao existe.` };
    if (!OPERADORES.includes(f.operador)) {
      return { erro: "operador_invalido", mensagem: `Operador '${String(f.operador)}' nao existe.` };
    }
    const valores = colunaBruta(aba, i);
    const ordem = inferirOrdem(valores);
    if (ordem.ambiguo) {
      return {
        erro: "AMBIGUOUS_DATE_FORMAT",
        mensagem: `A coluna '${f.coluna}' mistura dia/mes e mes/dia; nao da para filtrar por data com seguranca.`,
      };
    }

    const alvoEhData =
      typeof f.valor === "string" && /^\d{4}-\d{2}-\d{2}$/.test(f.valor);
    if (alvoEhData && ordem.presumido) {
      avisos.push(
        `A coluna '${f.coluna}' nao prova a ordem dia/mes; foi lida como ${ordem.formato}.`
      );
    }

    const passa = (linha: number): boolean => {
      const bruto = valores[linha];
      const txt = bruto === null ? "" : String(bruto);
      if (f.operador === "vazio") return celulaVazia(aba.linhas[linha + 1]?.[i]);
      if (f.operador === "nao_vazio") return !celulaVazia(aba.linhas[linha + 1]?.[i]);
      if (f.operador === "contem") {
        return txt.toLowerCase().includes(String(f.valor ?? "").toLowerCase());
      }

      if (alvoEhData) {
        const d = lerData(bruto, ordem.formato);
        if (d.tipo !== "ok") return false;
        const de = String(f.valor);
        const ate = typeof f.ate === "string" ? f.ate : de;
        if (f.operador === "entre") return d.iso >= de && d.iso <= ate;
        if (f.operador === "igual") return d.iso === de;
        if (f.operador === "diferente") return d.iso !== de;
        if (f.operador === "maior") return d.iso > de;
        if (f.operador === "menor") return d.iso < de;
        return false;
      }

      const par = comparavelComoNumero(bruto, f.valor);
      if (par) {
        const c = comparar(par[0], par[1]);
        if (f.operador === "igual") return c === 0;
        if (f.operador === "diferente") return c !== 0;
        if (f.operador === "maior") return c > 0;
        if (f.operador === "menor") return c < 0;
        if (f.operador === "entre") {
          const parAte = comparavelComoNumero(bruto, f.ate);
          return c >= 0 && parAte !== null && comparar(parAte[0], parAte[1]) <= 0;
        }
      }
      const alvo = String(f.valor ?? "");
      if (f.operador === "igual") return txt === alvo;
      if (f.operador === "diferente") return txt !== alvo;
      if (f.operador === "maior") return txt > alvo;
      if (f.operador === "menor") return txt < alvo;
      if (f.operador === "entre") return txt >= alvo && txt <= String(f.ate ?? alvo);
      return false;
    };

    indices = indices.filter(passa);
  }
  return { indices };
}

// ─── A operacao ───────────────────────────────────────────────────────

interface Nucleo {
  valor: string | number | readonly string[] | null;
  ignoradas: number;
}

function calcular(
  op: Operacao,
  valores: readonly (string | number | null)[],
  vaziosOriginais: readonly boolean[]
): Nucleo {
  if (op === "count") return { valor: valores.length, ignoradas: 0 };
  if (op === "missing") {
    return { valor: vaziosOriginais.filter(Boolean).length, ignoradas: 0 };
  }
  if (op === "distinct") {
    const set = new Set(valores.filter((v) => v !== null).map((v) => String(v)));
    return { valor: [...set].sort(), ignoradas: 0 };
  }
  if (op === "duplicates") {
    const contagem = new Map<string, number>();
    for (const v of valores) {
      if (v === null) continue;
      const k = String(v);
      contagem.set(k, (contagem.get(k) ?? 0) + 1);
    }
    const dups = [...contagem.entries()].filter(([, n]) => n > 1).map(([k]) => k).sort();
    return { valor: dups, ignoradas: 0 };
  }

  // sum / min / max / average: so numero entra.
  const numeros: Decimal[] = [];
  let ignoradas = 0;
  for (const v of valores) {
    if (v === null || (typeof v === "string" && v.trim() === "")) { ignoradas += 1; continue; }
    const r = lerValorMonetario(v);
    if (r.tipo === "ok") numeros.push(r.valor);
    else ignoradas += 1;
  }
  if (numeros.length === 0) return { valor: op === "sum" ? paraTexto(ZERO) : null, ignoradas };

  if (op === "sum") return { valor: paraTexto(numeros.reduce(somar, ZERO)), ignoradas };
  if (op === "min") {
    return { valor: paraTexto(numeros.reduce((a, b) => (comparar(a, b) <= 0 ? a : b))), ignoradas };
  }
  if (op === "max") {
    return { valor: paraTexto(numeros.reduce((a, b) => (comparar(a, b) >= 0 ? a : b))), ignoradas };
  }
  const total = numeros.reduce(somar, ZERO);
  const und = total.unidades / BigInt(numeros.length);
  return { valor: paraTexto({ unidades: und }), ignoradas };
}

export function agregar(aba: Aba, pedido: PedidoAgregacao): SaidaAgregacao {
  if (!OPERACOES.includes(pedido.operacao)) {
    return { tipo: "erro", codigo: "operacao_invalida", mensagem: `Operacao '${String(pedido.operacao)}' nao existe.` };
  }
  const precisaColuna = pedido.operacao !== "count";
  let iCol = -1;
  if (precisaColuna) {
    iCol = indiceDaColuna(aba, pedido.coluna);
    if (iCol < 0) {
      return { tipo: "erro", codigo: "coluna_inexistente", mensagem: `Coluna '${String(pedido.coluna)}' nao existe.` };
    }
  }

  const avisos: string[] = [];
  const filtrado = aplicarFiltros(aba, pedido.filtros ?? [], avisos);
  if ("erro" in filtrado) {
    return { tipo: "erro", codigo: filtrado.erro, mensagem: filtrado.mensagem };
  }
  const indices = filtrado.indices;
  const linhasNaAba = Math.max(0, aba.linhas.length - 1);

  const valoresDaColuna = precisaColuna ? colunaBruta(aba, iCol) : [];
  const vazios = precisaColuna
    ? aba.linhas.slice(1).map((l) => celulaVazia(l[iCol]))
    : [];

  if (pedido.agruparPor === undefined) {
    const nucleo = calcular(
      pedido.operacao,
      indices.map((i) => valoresDaColuna[i] ?? null),
      indices.map((i) => vazios[i] ?? true)
    );
    return {
      tipo: "ok",
      resultado: {
        operacao: pedido.operacao,
        coluna: precisaColuna ? cabecalhos(aba)[iCol] : null,
        valor: nucleo.valor,
        linhasNaAba,
        linhasFiltradas: indices.length,
        ignoradas: nucleo.ignoradas,
        grupos: null,
        gruposTruncados: false,
        avisos,
      },
    };
  }

  const iGrupo = indiceDaColuna(aba, pedido.agruparPor);
  if (iGrupo < 0) {
    return { tipo: "erro", codigo: "coluna_inexistente", mensagem: `Coluna de agrupamento '${String(pedido.agruparPor)}' nao existe.` };
  }
  const chaves = colunaBruta(aba, iGrupo);
  const baldes = new Map<string, number[]>();
  for (const i of indices) {
    const k = chaves[i] === null ? "(vazio)" : String(chaves[i]);
    const b = baldes.get(k);
    if (b) b.push(i);
    else baldes.set(k, [i]);
  }

  let ignoradas = 0;
  const grupos: GrupoAgregado[] = [];
  for (const [chave, linhas] of [...baldes.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const n = calcular(
      pedido.operacao,
      linhas.map((i) => valoresDaColuna[i] ?? null),
      linhas.map((i) => vazios[i] ?? true)
    );
    ignoradas += n.ignoradas;
    grupos.push({
      chave,
      valor: Array.isArray(n.valor) ? n.valor.length : ((n.valor ?? 0) as string | number),
      linhas: linhas.length,
    });
  }

  const truncados = grupos.length > MAX_GRUPOS_RETORNADOS;
  if (truncados) {
    avisos.push(`Havia ${grupos.length} grupos; foram devolvidos ${MAX_GRUPOS_RETORNADOS}.`);
  }
  return {
    tipo: "ok",
    resultado: {
      operacao: pedido.operacao,
      coluna: precisaColuna ? cabecalhos(aba)[iCol] : null,
      valor: null,
      linhasNaAba,
      linhasFiltradas: indices.length,
      ignoradas,
      grupos: grupos.slice(0, MAX_GRUPOS_RETORNADOS),
      gruposTruncados: truncados,
      avisos,
    },
  };
}
