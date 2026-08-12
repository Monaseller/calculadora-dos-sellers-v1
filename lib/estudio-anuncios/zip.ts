/**
 * Escritor de ZIP determinístico (2026-08-22).
 *
 * POR QUE ESCREVER EM VEZ DE INSTALAR UMA BIBLIOTECA. Duas razões, nesta
 * ordem:
 *   1. **Determinismo.** As bibliotecas usuais carimbam o horário atual em
 *      cada entrada, então o mesmo pacote produziria bytes diferentes a
 *      cada materialização — exatamente o que a tarefa proíbe. Aqui o
 *      timestamp é um PARÂMETRO (o `criado_em` congelado do pacote), a
 *      ordem das entradas é a que o chamador der, e o nível de compressão
 *      é fixo. Mesmo pacote ⇒ mesmos bytes, byte a byte.
 *   2. Zero dependência nova: só `node:zlib`, que já vem no runtime.
 *
 * Escopo deliberadamente mínimo: ZIP clássico (sem ZIP64, sem cifra, sem
 * data descriptor), método deflate, nomes em UTF-8 com o bit 11 do flag
 * ligado. Suficiente para um pacote de conteúdo + imagens; um pacote com
 * mais de 65.535 arquivos ou acima de 4 GB é rejeitado explicitamente em
 * vez de gerar um arquivo silenciosamente inválido.
 */
import { deflateRawSync, inflateRawSync } from "node:zlib";

export interface EntradaZip {
  /** Caminho relativo dentro do ZIP, sempre com "/" (nunca "\"). */
  caminho: string;
  dados: Uint8Array;
}

const LIMITE_ENTRADAS = 65_535;
const LIMITE_BYTES = 0xffffffff;

// ────────────────────────────────────────────────────────────────────
// CRC-32 (o ZIP exige; não é hash de segurança)
// ────────────────────────────────────────────────────────────────────
const TABELA_CRC = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(dados: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < dados.length; i++) c = TABELA_CRC[(c ^ dados[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Converte um instante para o par (data, hora) do formato MS-DOS que o
 * ZIP usa. Sempre em UTC: usar o fuso local faria o mesmo pacote gerar
 * bytes diferentes em máquinas diferentes. Datas antes de 1980 não são
 * representáveis no formato — são fixadas em 1980-01-01, nunca no
 * horário atual (que quebraria o determinismo).
 */
export function dataDosUtc(quando: Date): { data: number; hora: number } {
  const ano = quando.getUTCFullYear();
  if (!Number.isFinite(ano) || ano < 1980) return { data: (1 << 5) | 1, hora: 0 };
  const data = ((ano - 1980) << 9) | ((quando.getUTCMonth() + 1) << 5) | quando.getUTCDate();
  const hora =
    (quando.getUTCHours() << 11) | (quando.getUTCMinutes() << 5) | Math.floor(quando.getUTCSeconds() / 2);
  return { data, hora };
}

function u16(v: number): Uint8Array {
  return new Uint8Array([v & 0xff, (v >>> 8) & 0xff]);
}
function u32(v: number): Uint8Array {
  return new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
}
function juntar(partes: Uint8Array[]): Uint8Array {
  const total = partes.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of partes) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * Monta o ZIP. `quando` é obrigatório e sem valor padrão de propósito:
 * um default `new Date()` reintroduziria a não-determinação que este
 * módulo existe para eliminar — quem chama precisa declarar qual
 * instante congelado está usando.
 */
export function montarZip(entradas: EntradaZip[], quando: Date): Uint8Array {
  if (entradas.length > LIMITE_ENTRADAS) {
    throw new Error(`ZIP com ${entradas.length} entradas excede o limite sem ZIP64 (${LIMITE_ENTRADAS}).`);
  }
  const vistos = new Set<string>();
  for (const e of entradas) {
    if (vistos.has(e.caminho)) throw new Error(`Caminho repetido no ZIP: ${e.caminho}`);
    vistos.add(e.caminho);
  }

  const { data, hora } = dataDosUtc(quando);
  const locais: Uint8Array[] = [];
  const centrais: Uint8Array[] = [];
  let offset = 0;

  for (const entrada of entradas) {
    const nome = new TextEncoder().encode(entrada.caminho);
    const bruto = entrada.dados;
    // Nível 9 fixo: o nível também entra nos bytes de saída.
    const comprimido = deflateRawSync(bruto, { level: 9 });
    if (bruto.length > LIMITE_BYTES || comprimido.length > LIMITE_BYTES) {
      throw new Error(`Entrada ${entrada.caminho} excede o limite de 4 GB sem ZIP64.`);
    }
    const crc = crc32(bruto);
    // bit 11 = nomes em UTF-8. Sem bit 3 (data descriptor): os tamanhos
    // já são conhecidos aqui, então vão no próprio cabeçalho local.
    const flag = 0x0800;

    const cabecalhoLocal = juntar([
      u32(0x04034b50), u16(20), u16(flag), u16(8), u16(hora), u16(data),
      u32(crc), u32(comprimido.length), u32(bruto.length), u16(nome.length), u16(0),
      nome,
    ]);
    locais.push(cabecalhoLocal, comprimido);

    centrais.push(
      juntar([
        u32(0x02014b50), u16(20), u16(20), u16(flag), u16(8), u16(hora), u16(data),
        u32(crc), u32(comprimido.length), u32(bruto.length),
        u16(nome.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset),
        nome,
      ])
    );
    offset += cabecalhoLocal.length + comprimido.length;
  }

  const central = juntar(centrais);
  const fim = juntar([
    u32(0x06054b50), u16(0), u16(0), u16(entradas.length), u16(entradas.length),
    u32(central.length), u32(offset), u16(0),
  ]);

  return juntar([...locais, central, fim]);
}

/**
 * Lê de volta a lista `{caminho, dados}` de um ZIP produzido aqui.
 * Existe para a VALIDAÇÃO conseguir abrir o arquivo real e comparar com o
 * banco — não é um leitor genérico de ZIP e assume o formato que
 * `montarZip` escreve (deflate, sem ZIP64, sem data descriptor).
 */
export function lerZip(buffer: Uint8Array): EntradaZip[] {
  const dv = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const saida: EntradaZip[] = [];
  let i = 0;
  while (i + 4 <= buffer.length && dv.getUint32(i, true) === 0x04034b50) {
    const tamComprimido = dv.getUint32(i + 18, true);
    const tamNome = dv.getUint16(i + 26, true);
    const tamExtra = dv.getUint16(i + 28, true);
    const inicioNome = i + 30;
    const caminho = new TextDecoder().decode(buffer.slice(inicioNome, inicioNome + tamNome));
    const inicioDados = inicioNome + tamNome + tamExtra;
    const comprimido = buffer.slice(inicioDados, inicioDados + tamComprimido);
    saida.push({ caminho, dados: new Uint8Array(inflateRawSync(comprimido)) });
    i = inicioDados + tamComprimido;
  }
  return saida;
}
