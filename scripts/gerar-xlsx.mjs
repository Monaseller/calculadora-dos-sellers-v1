/**
 * Escritor minimo de XLSX — F7b.4.8.4.
 *
 * ── Por que escrever isto a mao ─────────────────────────────────────
 *
 * O repositorio LE xlsx (`lib/agentes/planilhas/leitura.ts`, com um
 * leitor de zip proprio) e nao escreve. Uma planilha de PERICIA nao
 * justifica uma dependencia nova em producao, e o gate e explicito de que
 * estes arquivos sao ferramenta de diagnostico — nao a feature de
 * planilha da Agent Factory.
 *
 * Um xlsx e um zip com XML dentro. `zlib` ja vem no Node, entao o custo
 * disto e um CRC32 e dois cabecalhos de zip.
 *
 * Deliberadamente simples: `inlineStr` em vez de `sharedStrings`, nenhum
 * estilo, nenhuma formula. O arquivo serve para o Rodrigo olhar e filtrar,
 * e nao para ser bonito.
 */
import { deflateRawSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const TABELA_CRC = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = TABELA_CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** O que o XML nao aceita no meio do texto. */
function esc(v) {
  return String(v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // Caractere de controle quebra o arquivo inteiro no Excel, e um dado
    // vindo de API pode ter. Fora, sem aviso.
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
}

/** A1, B1, ... Z1, AA1. Mais de 26 colunas e o caso normal aqui. */
function coluna(i) {
  let s = "";
  let n = i;
  for (;;) {
    s = String.fromCharCode(65 + (n % 26)) + s;
    if (n < 26) break;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}

function celula(ref, valor) {
  if (valor === null || valor === undefined || valor === "") return "";
  if (typeof valor === "number" && Number.isFinite(valor)) {
    return `<c r="${ref}"><v>${valor}</v></c>`;
  }
  if (typeof valor === "boolean") {
    return `<c r="${ref}" t="inlineStr"><is><t>${valor ? "SIM" : "NAO"}</t></is></c>`;
  }
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(valor)}</t></is></c>`;
}

function folha(aba) {
  const partes = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    // Congela o cabecalho: com 11 mil linhas, rolar sem cabecalho e inutil.
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>',
    "<sheetData>",
  ];
  partes.push(`<row r="1">${aba.colunas
    .map((c, i) => celula(`${coluna(i)}1`, c)).join("")}</row>`);
  for (let r = 0; r < aba.linhas.length; r += 1) {
    const linha = aba.linhas[r];
    const cels = aba.colunas
      .map((c, i) => celula(`${coluna(i)}${r + 2}`, linha[c])).join("");
    partes.push(`<row r="${r + 2}">${cels}</row>`);
  }
  partes.push("</sheetData>");
  if (aba.linhas.length > 0) {
    partes.push(`<autoFilter ref="A1:${coluna(aba.colunas.length - 1)}${aba.linhas.length + 1}"/>`);
  }
  partes.push("</worksheet>");
  return partes.join("");
}

/** Nome de aba: 31 caracteres, sem os proibidos pelo Excel. */
function nomeDeAba(nome) {
  return nome.replace(/[[\]:*?/\\]/g, "-").slice(0, 31);
}

/**
 * Escreve o arquivo.
 *
 * `abas`: [{ nome, colunas: [string], linhas: [{coluna: valor}] }]
 */
export function escreverXlsx(caminho, abas) {
  const arquivos = [];
  const add = (nome, texto) => arquivos.push({ nome, dados: Buffer.from(texto, "utf8") });

  const nomes = abas.map((a) => nomeDeAba(a.nome));
  const vistos = new Set();
  for (let i = 0; i < nomes.length; i += 1) {
    // Duas abas com o mesmo nome fazem o Excel recusar o arquivo inteiro.
    let n = nomes[i];
    let sufixo = 2;
    while (vistos.has(n)) n = `${nomes[i].slice(0, 28)}_${sufixo++}`;
    vistos.add(n);
    nomes[i] = n;
  }

  add("[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    abas.map((_, i) =>
      `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
    ).join("") +
    "</Types>");

  add("_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    "</Relationships>");

  add("xl/workbook.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
    nomes.map((n, i) =>
      `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
    "</sheets></workbook>");

  add("xl/_rels/workbook.xml.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    abas.map((_, i) =>
      `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
    ).join("") +
    "</Relationships>");

  for (let i = 0; i < abas.length; i += 1) {
    add(`xl/worksheets/sheet${i + 1}.xml`, folha(abas[i]));
  }

  // ── O zip ──────────────────────────────────────────────────────────
  const locais = [];
  const central = [];
  let offset = 0;
  for (const f of arquivos) {
    const nome = Buffer.from(f.nome, "utf8");
    const comprimido = deflateRawSync(f.dados, { level: 9 });
    const crc = crc32(f.dados);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);        // versao
    local.writeUInt16LE(0, 6);         // flags
    local.writeUInt16LE(8, 8);         // deflate
    local.writeUInt16LE(0, 10);        // hora
    local.writeUInt16LE(0x21, 12);     // data (1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comprimido.length, 18);
    local.writeUInt32LE(f.dados.length, 22);
    local.writeUInt16LE(nome.length, 26);
    local.writeUInt16LE(0, 28);
    locais.push(local, nome, comprimido);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(0x21, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(comprimido.length, 20);
    dir.writeUInt32LE(f.dados.length, 24);
    dir.writeUInt16LE(nome.length, 28);
    dir.writeUInt16LE(0, 30);
    dir.writeUInt16LE(0, 32);
    dir.writeUInt16LE(0, 34);
    dir.writeUInt16LE(0, 36);
    dir.writeUInt32LE(0, 38);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nome);

    offset += local.length + nome.length + comprimido.length;
  }

  const corpoCentral = Buffer.concat(central);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0);
  fim.writeUInt16LE(0, 4);
  fim.writeUInt16LE(0, 6);
  fim.writeUInt16LE(arquivos.length, 8);
  fim.writeUInt16LE(arquivos.length, 10);
  fim.writeUInt32LE(corpoCentral.length, 12);
  fim.writeUInt32LE(offset, 16);
  fim.writeUInt16LE(0, 20);

  writeFileSync(caminho, Buffer.concat([...locais, corpoCentral, fim]));
  return { abas: abas.length, bytes: offset + corpoCentral.length + 22 };
}
