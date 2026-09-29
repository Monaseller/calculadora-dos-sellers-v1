/**
 * `.xlsx` e `.csv` -> `Pasta` — AGENT-FACTORY-F3.
 *
 * ── O que este leitor NAO faz, dito antes do que ele faz ────────────
 *
 * Nao executa formula. Nao recalcula nada. Nao segue link externo, nem
 * `externalLink`, nem conexao de dados, nem macro — um `.xlsm` com VBA
 * lido aqui e so um ZIP com XML: o binario da macro nunca e aberto.
 * O que a planilha diz que uma celula vale e o valor CACHEADO que o
 * Excel gravou; quando ha formula, o texto dela viaja em campo separado
 * e a inspecao AVISA. Prometer recalculo exigiria um motor de formula,
 * que nao existe aqui e nao vai ser fingido.
 *
 * ── Por que um parser de XML por varredura, e nao DOM ───────────────
 *
 * As partes de um `.xlsx` sao geradas por maquina e tem forma estreita:
 * `<row>`, `<c>`, `<v>`, `<f>`, `<t>`. Um DOM completo traria
 * resolucao de entidade externa (XXE) para dentro de um arquivo que
 * chega de fora. A varredura abaixo le exatamente essas tags e ignora o
 * resto; `<!DOCTYPE` e ENTIDADE DECLARADA sao RECUSADOS de saida.
 */
import { lerZip } from "@/lib/agentes/planilhas/zip";
import type { Aba, Celula, Pasta } from "@/lib/agentes/planilhas/tabela";

export class ErroPlanilha extends Error {
  readonly codigo: string;
  constructor(codigo: string, mensagem: string) {
    super(mensagem);
    this.name = "ErroPlanilha";
    this.codigo = codigo;
  }
}

// ─── XML ──────────────────────────────────────────────────────────────

const ENTIDADES: Readonly<Record<string, string>> = Object.freeze({
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
});

function desescapar(s: string): string {
  return s.replace(/&(#x?[0-9A-Fa-f]+|[a-zA-Z]+);/g, (inteiro, corpo: string) => {
    if (corpo.startsWith("#x") || corpo.startsWith("#X")) {
      const c = Number.parseInt(corpo.slice(2), 16);
      return Number.isFinite(c) ? String.fromCodePoint(c) : inteiro;
    }
    if (corpo.startsWith("#")) {
      const c = Number.parseInt(corpo.slice(1), 10);
      return Number.isFinite(c) ? String.fromCodePoint(c) : inteiro;
    }
    return ENTIDADES[corpo] ?? inteiro;
  });
}

function texto(bytes: Uint8Array): string {
  const s = Buffer.from(bytes).toString("utf8");
  // XXE e "billion laughs" morrem aqui: um .xlsx legitimo nao declara
  // DOCTYPE nem entidade propria.
  if (/<!DOCTYPE/i.test(s) || /<!ENTITY/i.test(s)) {
    throw new ErroPlanilha("xml_com_doctype", "XML com DOCTYPE/ENTITY nao e aceito.");
  }
  return s;
}

function atributo(tag: string, nome: string): string | null {
  const m = new RegExp(`\\s${nome}="([^"]*)"`).exec(tag);
  return m ? desescapar(m[1]) : null;
}

/** Concatena os `<t>` de um bloco (rich text vem partido em varios). */
function juntarT(xml: string): string {
  let out = "";
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out += desescapar(m[1] ?? "");
  return out;
}

// ─── .xlsx ────────────────────────────────────────────────────────────

/** "BC" -> 55 (indice 1-based da coluna). */
function colunaDeReferencia(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n;
}

function lerSharedStrings(xml: string): string[] {
  const saida: string[] = [];
  const re = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>|<si(?:\s[^>]*)?\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) saida.push(juntarT(m[1] ?? ""));
  return saida;
}

function lerAba(xml: string, nome: string, compartilhadas: readonly string[]): Aba {
  const linhas: Celula[][] = [];
  const reLinha = /<row(?:\s[^>]*)?>([\s\S]*?)<\/row>|<row(\s[^>]*)?\/>/g;
  let ml: RegExpExecArray | null;

  while ((ml = reLinha.exec(xml)) !== null) {
    const corpo = ml[1] ?? "";
    const celulas: Celula[] = [];
    const reCel = /<c(\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/c>)/g;
    let mc: RegExpExecArray | null;

    while ((mc = reCel.exec(corpo)) !== null) {
      const attrs = mc[1] ?? "";
      const dentro = mc[2] ?? "";
      const ref = atributo(attrs, "r");
      const tipo = atributo(attrs, "t");

      const mf = /<f(?:\s[^>]*)?>([\s\S]*?)<\/f>|<f(?:\s[^>]*)?\/>/.exec(dentro);
      const formula = mf ? desescapar(mf[1] ?? "") : null;

      let bruto: string | number | null = null;
      if (tipo === "inlineStr") {
        bruto = juntarT(dentro);
      } else {
        const mv = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(dentro);
        const v = mv ? desescapar(mv[1]) : null;
        if (v === null) {
          bruto = null;
        } else if (tipo === "s") {
          const i = Number(v);
          bruto = Number.isInteger(i) && i >= 0 && i < compartilhadas.length ? compartilhadas[i] : "";
        } else if (tipo === "b") {
          bruto = v === "1" ? "VERDADEIRO" : "FALSO";
        } else if (tipo === "e") {
          bruto = v;                       // #DIV/0!, #N/D — texto de erro
        } else if (tipo === "str") {
          bruto = v;                       // resultado textual de formula
        } else {
          const n = Number(v);
          bruto = v.trim() !== "" && Number.isFinite(n) ? n : v;
        }
      }

      // `r` diz a coluna de verdade; sem ele, celulas vazias omitidas
      // deslocariam tudo para a esquerda e uma soma somaria a coluna
      // errada.
      const alvo = ref ? colunaDeReferencia(ref) - 1 : celulas.length;
      while (celulas.length < alvo) celulas.push({ bruto: null, formula: null });
      celulas[alvo] = { bruto, formula };
    }
    linhas.push(celulas);
  }
  return { nome, linhas };
}

export function lerXlsx(bytes: Uint8Array): Pasta {
  const zip = lerZip(bytes);
  const wb = zip.get("xl/workbook.xml");
  if (!wb) throw new ErroPlanilha("xlsx_invalido", "xl/workbook.xml ausente: nao parece um .xlsx.");

  const rels = zip.get("xl/_rels/workbook.xml.rels");
  const alvoPorId = new Map<string, string>();
  if (rels) {
    const reRel = /<Relationship\s[^>]*\/>/g;
    let m: RegExpExecArray | null;
    const t = texto(rels);
    while ((m = reRel.exec(t)) !== null) {
      const id = atributo(m[0], "Id");
      const alvo = atributo(m[0], "Target");
      if (id && alvo) alvoPorId.set(id, alvo.replace(/^\/?xl\//, "").replace(/^\.\//, ""));
    }
  }

  const compartilhadas = zip.has("xl/sharedStrings.xml")
    ? lerSharedStrings(texto(zip.get("xl/sharedStrings.xml") as Uint8Array))
    : [];

  const abas: Aba[] = [];
  const reSheet = /<sheet\s[^>]*\/>/g;
  const twb = texto(wb);
  let ms: RegExpExecArray | null;
  let ordem = 0;

  while ((ms = reSheet.exec(twb)) !== null) {
    ordem += 1;
    const nome = atributo(ms[0], "name") ?? `Planilha${ordem}`;
    const rid = atributo(ms[0], "r:id") ?? atributo(ms[0], "id");
    const relativo = rid ? alvoPorId.get(rid) : undefined;
    const caminho = relativo ? `xl/${relativo}` : `xl/worksheets/sheet${ordem}.xml`;
    const parte = zip.get(caminho) ?? zip.get(`xl/worksheets/sheet${ordem}.xml`);
    if (!parte) continue;
    abas.push(lerAba(texto(parte), nome, compartilhadas));
  }

  if (abas.length === 0) throw new ErroPlanilha("xlsx_sem_abas", "Nenhuma aba legivel no arquivo.");
  return { abas };
}

// ─── .csv ─────────────────────────────────────────────────────────────

/**
 * Escolhe o separador CONTANDO, nao adivinhando pelo idioma.
 *
 * Excel em pt-BR exporta com `;` porque a virgula ja e decimal. Assumir
 * `,` quebraria "1.234,56" em duas colunas e a soma sairia pela metade
 * — calada.
 */
export function detectarSeparador(amostra: string): "," | ";" | "\t" {
  const linha = amostra.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  let melhor: "," | ";" | "\t" = ",";
  let contagem = -1;
  for (const sep of [",", ";", "\t"] as const) {
    let n = 0;
    let aspas = false;
    for (let i = 0; i < linha.length; i += 1) {
      const c = linha[i];
      if (c === '"') aspas = !aspas;
      else if (c === sep && !aspas) n += 1;
    }
    if (n > contagem) {
      contagem = n;
      melhor = sep;
    }
  }
  return melhor;
}

export function lerCsv(bytes: Uint8Array, nomeAba = "csv"): Pasta {
  let s = Buffer.from(bytes).toString("utf8");
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);   // BOM do Excel
  const sep = detectarSeparador(s.slice(0, 4096));

  const linhas: Celula[][] = [];
  let celulas: Celula[] = [];
  let campo = "";
  let aspas = false;
  let temConteudo = false;

  const fecharCampo = () => {
    const t = campo;
    const n = Number(t);
    // Numero puro vira numero; o resto fica texto. `""` vira null para
    // que `missing` conte celula vazia como vazia, e nao como "0".
    celulas.push({
      bruto: t.trim() === "" ? null : t.trim() !== "" && /^-?\d+(\.\d+)?$/.test(t.trim()) && Number.isFinite(n) ? n : t,
      formula: null,
    });
    campo = "";
    temConteudo = true;
  };
  const fecharLinha = () => {
    fecharCampo();
    linhas.push(celulas);
    celulas = [];
    temConteudo = false;
  };

  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (aspas) {
      if (c === '"') {
        if (s[i + 1] === '"') { campo += '"'; i += 1; }
        else aspas = false;
      } else campo += c;
      continue;
    }
    if (c === '"') { aspas = true; temConteudo = true; continue; }
    if (c === sep) { fecharCampo(); continue; }
    if (c === "\n") { fecharLinha(); continue; }
    if (c === "\r") continue;
    campo += c;
  }
  if (campo !== "" || celulas.length > 0 || temConteudo) fecharLinha();

  return { abas: [{ nome: nomeAba, linhas }] };
}
