/**
 * Leitor ZIP minimo — AGENT-FACTORY-F3.
 *
 * ── Por que escrever isto, e nao instalar uma biblioteca ────────────
 *
 * Um `.xlsx` e um ZIP com XML dentro. Ler um exige inflar entradas
 * DEFLATE, e o Node ja faz isso: `zlib.inflateRawSync` e modulo padrao.
 * O que faltava era percorrer o diretorio central do ZIP — umas cem
 * linhas de deslocamentos fixos, todos publicos (APPNOTE.TXT).
 *
 * A alternativa era uma dependencia nova. O repositorio manda procurar
 * a infraestrutura que ja existe antes de criar outra, e adicionar
 * dependencia e decisao de supply-chain que este gate nao autoriza. As
 * cem linhas abaixo nao alcancam rede, nao executam nada do arquivo e
 * nao escrevem em disco.
 *
 * ── O que ele NAO faz ───────────────────────────────────────────────
 *
 * Nao escreve ZIP. Nao suporta ZIP64, nem entrada cifrada, nem archive
 * multi-volume — cada um desses LANCA com codigo proprio em vez de
 * devolver dado pela metade. Um `.xlsx` de planilha comum nao usa
 * nenhum deles; quando usar, o operador ve o motivo em vez de um total
 * silenciosamente errado.
 */
import { inflateRawSync } from "node:zlib";

/** Teto de seguranca: um ZIP pequeno nao tem milhares de entradas. */
export const MAX_ENTRADAS_ZIP = 512;

/**
 * Teto de bytes por entrada DESCOMPRIMIDA.
 *
 * Existe contra "zip bomb": 40 KB comprimidos podem virar gigabytes.
 * O tamanho vem do cabecalho e e conferido ANTES de inflar, e o
 * resultado e conferido DEPOIS — cabecalho e afirmacao do arquivo, nao
 * fato.
 */
export const MAX_BYTES_POR_ENTRADA = 64 * 1024 * 1024;

export class ErroZip extends Error {
  readonly codigo: string;
  constructor(codigo: string, mensagem: string) {
    super(mensagem);
    this.name = "ErroZip";
    this.codigo = codigo;
  }
}

function u16(b: Uint8Array, p: number): number {
  return b[p] | (b[p + 1] << 8);
}
function u32(b: Uint8Array, p: number): number {
  // `>>> 0` porque o deslocamento de 24 bits produziria negativo em
  // int32 com o bit alto ligado.
  return ((b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0);
}

const ASSINATURA_EOCD = 0x06054b50;
const ASSINATURA_CENTRAL = 0x02014b50;
const ASSINATURA_LOCAL = 0x04034b50;

/**
 * Acha o "End of Central Directory".
 *
 * Varre de tras para frente porque o EOCD fica no fim, mas pode ter ate
 * 64 KB de comentario depois dele. Procurar de frente acharia a
 * assinatura dentro de dados comprimidos por acaso.
 */
function acharEocd(b: Uint8Array): number {
  const minimo = Math.max(0, b.length - (0xffff + 22));
  for (let p = b.length - 22; p >= minimo; p -= 1) {
    if (u32(b, p) === ASSINATURA_EOCD) return p;
  }
  throw new ErroZip("zip_invalido", "Nao e um arquivo ZIP: fim do diretorio central ausente.");
}

/** Uma entrada do arquivo, ja descomprimida sob demanda. */
export interface EntradaZip {
  readonly nome: string;
  readonly bytes: Uint8Array;
}

/**
 * Le todas as entradas de um ZIP.
 *
 * Devolve mapa nome -> bytes. Nomes com `..` ou barra inicial sao
 * RECUSADOS: num `.xlsx` legitimo nao existem, e aceita-los seria
 * carregar para dentro do modelo um nome que algum dia alguem usaria
 * como caminho.
 */
export function lerZip(bytes: Uint8Array): ReadonlyMap<string, Uint8Array> {
  if (bytes.length < 22) {
    throw new ErroZip("zip_invalido", "Arquivo curto demais para ser um ZIP.");
  }
  const eocd = acharEocd(bytes);
  const total = u16(bytes, eocd + 10);
  if (total > MAX_ENTRADAS_ZIP) {
    throw new ErroZip("zip_entradas_demais", `ZIP com ${total} entradas; o teto e ${MAX_ENTRADAS_ZIP}.`);
  }
  if (u32(bytes, eocd + 16) === 0xffffffff || total === 0xffff) {
    throw new ErroZip("zip64_nao_suportado", "ZIP64 nao e suportado por este leitor.");
  }

  let p = u32(bytes, eocd + 16);
  const saida = new Map<string, Uint8Array>();

  for (let i = 0; i < total; i += 1) {
    if (p + 46 > bytes.length || u32(bytes, p) !== ASSINATURA_CENTRAL) {
      throw new ErroZip("zip_invalido", "Diretorio central corrompido.");
    }
    const bandeira = u16(bytes, p + 8);
    const metodo = u16(bytes, p + 10);
    const tamComprimido = u32(bytes, p + 20);
    const tamCru = u32(bytes, p + 24);
    const nomeLen = u16(bytes, p + 28);
    const extraLen = u16(bytes, p + 30);
    const comentarioLen = u16(bytes, p + 32);
    const offsetLocal = u32(bytes, p + 42);
    const nome = Buffer.from(bytes.subarray(p + 46, p + 46 + nomeLen)).toString("utf8");
    p += 46 + nomeLen + extraLen + comentarioLen;

    // bit 0 = cifrado. Nunca tentar "ler assim mesmo".
    if ((bandeira & 0x0001) !== 0) {
      throw new ErroZip("zip_cifrado", "Entrada cifrada: este leitor nao decifra nada.");
    }
    if (nome.endsWith("/")) continue; // diretorio
    if (nome.startsWith("/") || nome.includes("..") || nome.includes("\\")) {
      throw new ErroZip("zip_nome_suspeito", "Entrada com nome de caminho relativo ou absoluto.");
    }
    if (tamCru > MAX_BYTES_POR_ENTRADA) {
      throw new ErroZip("zip_entrada_grande", `Entrada '${nome}' declara ${tamCru} bytes; o teto e ${MAX_BYTES_POR_ENTRADA}.`);
    }

    if (offsetLocal + 30 > bytes.length || u32(bytes, offsetLocal) !== ASSINATURA_LOCAL) {
      throw new ErroZip("zip_invalido", `Cabecalho local ausente para '${nome}'.`);
    }
    const inicio =
      offsetLocal + 30 + u16(bytes, offsetLocal + 26) + u16(bytes, offsetLocal + 28);
    const fim = inicio + tamComprimido;
    if (fim > bytes.length) {
      throw new ErroZip("zip_invalido", `Dados truncados em '${nome}'.`);
    }
    const cru = bytes.subarray(inicio, fim);

    let conteudo: Uint8Array;
    if (metodo === 0) {
      conteudo = cru;
    } else if (metodo === 8) {
      conteudo = new Uint8Array(inflateRawSync(Buffer.from(cru), { maxOutputLength: MAX_BYTES_POR_ENTRADA }));
    } else {
      throw new ErroZip("zip_metodo_nao_suportado", `Metodo de compressao ${metodo} nao suportado.`);
    }

    // O tamanho do cabecalho e AFIRMACAO; este e o fato.
    if (conteudo.length > MAX_BYTES_POR_ENTRADA) {
      throw new ErroZip("zip_entrada_grande", `Entrada '${nome}' inflou alem do teto.`);
    }
    saida.set(nome, conteudo);
  }
  return saida;
}
