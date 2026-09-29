/**
 * Leitura de datas de planilha — AGENT-FACTORY-F3.
 *
 * ── Ambiguidade e propriedade da COLUNA, nao da celula ──────────────
 *
 * "03/04/2026" sozinho nao tem resposta: 3 de abril e 4 de marco sao
 * ambos plausiveis, e nenhuma regra sobre aquela string decide. Olhar a
 * COLUNA decide, porque uma planilha nao mistura convencao no meio de
 * uma coluna: basta UMA linha com "13/…" para provar dia-primeiro, ou
 * uma com "…/13/" para provar mes-primeiro.
 *
 * Entao a inferencia roda sobre o conjunto:
 *
 *   ha prova de dia-primeiro e nao de mes-primeiro  -> dd/mm/yyyy
 *   ha prova de mes-primeiro e nao de dia-primeiro  -> mm/dd/yyyy
 *   ha prova das DUAS                               -> AMBIGUOUS_DATE_FORMAT
 *   nao ha prova nenhuma                            -> dd/mm/yyyy, e a
 *                                                      Tool DECLARA que
 *                                                      foi presumido
 *
 * O ultimo caso e o unico palpite, e ele nao e silencioso: sai em
 * `formatoPresumido: true` na proveniencia, para a UI poder dizer "as
 * datas foram lidas como dia/mes" em vez de o numero aparecer sozinho.
 *
 * ── Excel serial ────────────────────────────────────────────────────
 *
 * Data no `.xlsx` e numero: dias desde 1899-12-30. A epoca e 30/12 e
 * nao 31/12 porque o Excel acredita que 1900 foi bissexto — o serial 60
 * aponta para um 29/02/1900 que nunca existiu. Esse valor e RECUSADO em
 * vez de deslizar um dia sem avisar.
 */

export type FormatoDeData = "iso" | "dd/mm/yyyy" | "mm/dd/yyyy" | "serial";

export type ResultadoData =
  | { readonly tipo: "ok"; readonly iso: string }
  | { readonly tipo: "ambiguo"; readonly codigo: "AMBIGUOUS_DATE_FORMAT"; readonly texto: string }
  | { readonly tipo: "invalido"; readonly texto: string };

/** Dias desde 1899-12-30, a epoca do sistema de datas de 1900. */
const EPOCA_EXCEL_MS = Date.UTC(1899, 11, 30);
const DIA_MS = 86_400_000;

function ehDataReal(a: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || a < 1900 || a > 9999) return false;
  const dt = new Date(Date.UTC(a, m - 1, d));
  return dt.getUTCFullYear() === a && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function iso(a: number, m: number, d: number): string {
  return `${String(a).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Serial do Excel -> ISO. Recusa o 29/02/1900 que nao existiu. */
export function deSerialExcel(serial: number): ResultadoData {
  if (!Number.isFinite(serial) || serial < 1) {
    return { tipo: "invalido", texto: String(serial) };
  }
  if (Math.floor(serial) === 60) {
    return { tipo: "invalido", texto: "60 (29/02/1900 nao existiu)" };
  }
  const dias = Math.floor(serial);
  const dt = new Date(EPOCA_EXCEL_MS + dias * DIA_MS);
  return { tipo: "ok", iso: dt.toISOString().slice(0, 10) };
}

const RE_ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/;
const RE_BARRA = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/;

/**
 * Qual evidencia esta string carrega sobre a ordem dia/mes.
 *
 * `null` quando ela nao prova nada (ambos os campos <= 12).
 */
export function evidenciaDeOrdem(bruto: unknown): "dia-primeiro" | "mes-primeiro" | null {
  if (typeof bruto !== "string") return null;
  const m = RE_BARRA.exec(bruto.trim());
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a > 12 && b <= 12) return "dia-primeiro";
  if (b > 12 && a <= 12) return "mes-primeiro";
  return null;
}

export interface OrdemInferida {
  readonly formato: "dd/mm/yyyy" | "mm/dd/yyyy";
  /** `true` quando nenhuma linha provou a ordem e ela foi presumida. */
  readonly presumido: boolean;
  readonly ambiguo: boolean;
}

/**
 * Decide a ordem olhando a coluna INTEIRA. Ver o cabecalho.
 *
 * O default pt-BR nao e neutralidade fingida: este repositorio e
 * brasileiro de ponta a ponta, e "presumido" viaja junto para que a
 * escolha seja visivel em vez de embutida.
 */
export function inferirOrdem(valores: readonly unknown[]): OrdemInferida {
  let dia = false;
  let mes = false;
  for (const v of valores) {
    const e = evidenciaDeOrdem(v);
    if (e === "dia-primeiro") dia = true;
    else if (e === "mes-primeiro") mes = true;
  }
  if (dia && mes) return { formato: "dd/mm/yyyy", presumido: false, ambiguo: true };
  if (mes) return { formato: "mm/dd/yyyy", presumido: false, ambiguo: false };
  if (dia) return { formato: "dd/mm/yyyy", presumido: false, ambiguo: false };
  return { formato: "dd/mm/yyyy", presumido: true, ambiguo: false };
}

/**
 * Le UMA celula como data, com a ordem ja decidida pela coluna.
 *
 * `ordem` e obrigatoria de proposito: nao existe leitura correta de
 * "03/04/2026" sem ela, e deixar um default aqui esconderia isso.
 */
export function lerData(bruto: unknown, ordem: "dd/mm/yyyy" | "mm/dd/yyyy"): ResultadoData {
  if (bruto instanceof Date) {
    if (Number.isNaN(bruto.getTime())) return { tipo: "invalido", texto: "Invalid Date" };
    return { tipo: "ok", iso: bruto.toISOString().slice(0, 10) };
  }
  if (typeof bruto === "number") return deSerialExcel(bruto);
  if (typeof bruto !== "string") return { tipo: "invalido", texto: String(bruto) };

  const t = bruto.trim();
  if (t === "") return { tipo: "invalido", texto: bruto };

  const mi = RE_ISO.exec(t);
  if (mi) {
    const [a, m, d] = [Number(mi[1]), Number(mi[2]), Number(mi[3])];
    return ehDataReal(a, m, d)
      ? { tipo: "ok", iso: iso(a, m, d) }
      : { tipo: "invalido", texto: bruto };
  }

  const mb = RE_BARRA.exec(t);
  if (mb) {
    const p1 = Number(mb[1]);
    const p2 = Number(mb[2]);
    const ano = Number(mb[3]);
    const [d, m] = ordem === "dd/mm/yyyy" ? [p1, p2] : [p2, p1];
    // Se a ordem escolhida NAO produz data real mas a inversa produz, a
    // linha contradiz a coluna. Nao se conserta em silencio: o numero
    // certo com o mes errado e exatamente o erro invisivel.
    if (!ehDataReal(ano, m, d)) {
      if (ehDataReal(ano, d, m)) {
        return { tipo: "ambiguo", codigo: "AMBIGUOUS_DATE_FORMAT", texto: bruto };
      }
      return { tipo: "invalido", texto: bruto };
    }
    return { tipo: "ok", iso: iso(ano, m, d) };
  }

  // Numero em texto: pode ser serial exportado como string.
  if (/^\d+(\.\d+)?$/.test(t)) return deSerialExcel(Number(t));

  return { tipo: "invalido", texto: bruto };
}
