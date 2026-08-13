/**
 * Recorte determinístico do produto — sem IA, sem serviço externo.
 *
 * ── Por que este módulo existe (2026-09-06) ─────────────────────────
 * A auditoria visual de 8 imagens geradas pelo modelo deu 0/8 aprovadas
 * por fidelidade: marca e rótulo apagados, tampa alongada, frasco
 * bojudo, quantidade errada, cena fisicamente impossível. A conclusão
 * arquitetural foi que um modelo generativo não pode ser o responsável
 * por reconstruir um produto comercial que precisa permanecer fiel.
 *
 * A medição da Etapa 0 provou a alternativa: recortando o produto da
 * foto original, os pixels internos ficam **byte-idênticos** ao original
 * (medido: 100,000% dos 99.754 pixels, maior diferença de canal = 0),
 * inclusive na região do rótulo. Fidelidade deixa de ser avaliada e
 * passa a ser garantida por construção.
 *
 * ── O método ────────────────────────────────────────────────────────
 * Flood fill a partir das bordas. Só vira fundo o pixel que é (a)
 * parecido com fundo E (b) alcançável desde a borda. A condição (b) é o
 * que separa este método de um limiar global: um reflexo claro DENTRO
 * do vidro, ou um esmalte creme, não é alcançável desde fora, então não
 * é apagado. Limiar global comeria o produto.
 *
 * ── Limites conhecidos, medidos, não estimados ──────────────────────
 * 1. **Fundo complexo não funciona.** Numa foto sobre mármore o flood
 *    fill marcou 0% do quadro como fundo. O método detecta isso e
 *    recusa — nunca recorta "mais ou menos".
 * 2. **Vidro/transparência não é resolvido.** O fundo visível ATRAVÉS
 *    do produto é preservado como opaco (medido: 10,6% dos pixels da
 *    faixa inferior quase brancos). Sobre fundo branco é invisível;
 *    sobre fundo escuro aparece. Por isso `alertaTransparencia`.
 * 3. **Halo de borda** existia (49,0% dos pixels a 1px da fronteira
 *    eram quase brancos, mistura produto+fundo do anti-aliasing).
 *    Erosão de 1px derruba para 2,8% custando 2,3% dos pixels — que já
 *    estavam contaminados.
 *
 * Este módulo NÃO altera cor, NÃO faz relight, NÃO faz warp, NÃO corrige
 * perspectiva e NÃO "melhora" o produto. Ele separa produto de fundo.
 */
import sharp from "sharp";

/** Versão do método — vai para a proveniência da imagem gerada. */
export const VERSAO_METODO_RECORTE = 1;

/**
 * Limiares do flood fill, calibrados na Etapa 0 sobre packshot real.
 * `LIMIAR_CLARO`: canal mínimo para o pixel ser candidato a fundo.
 * `SATURACAO_MAXIMA`: fundo neutro tem pouca diferença entre canais —
 * é o que impede confundir fundo branco com um produto branco saturado.
 */
const LIMIAR_CLARO = 235;
const SATURACAO_MAXIMA = 18;

/**
 * Cobertura mínima de fundo para o recorte ser confiável. Abaixo disso a
 * foto provavelmente não tem fundo neutro (medido: foto sobre mármore
 * deu 0%). Não é chute: é o sinal que separa packshot de lifestyle.
 */
export const COBERTURA_FUNDO_MINIMA_PCT = 8;

/**
 * Cobertura máxima de fundo. Acima disso sobrou produto de menos — ou o
 * flood fill vazou para dentro do produto por uma abertura, ou a foto
 * está quase vazia. Nos dois casos o recorte não presta.
 */
export const COBERTURA_FUNDO_MAXIMA_PCT = 97;

export interface ResultadoRecorte {
  /** PNG RGBA com o produto sobre transparência. */
  png: Buffer;
  largura: number;
  altura: number;
  /** Caixa mínima que contém o produto — base para escala e margem. */
  caixa: { x: number; y: number; largura: number; altura: number };
  /** Pixels marcados como produto após a erosão. */
  pixelsProduto: number;
  coberturaFundoPct: number;
  /**
   * Produto transparente detectado: o fundo original pode ter ficado
   * preservado através do vidro. Composição sobre fundo escuro deixa de
   * ser segura. Ver limite 2 no cabeçalho.
   */
  alertaTransparencia: boolean;
}

export interface FalhaRecorte {
  motivo: string;
  codigo: "fundo_nao_detectado" | "fundo_excessivo" | "produto_ausente";
}

export type SaidaRecorte =
  | { ok: true; recorte: ResultadoRecorte }
  | { ok: false; falha: FalhaRecorte };

/** Pixel candidato a fundo: claro e sem cor dominante. */
function ehFundo(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return min >= LIMIAR_CLARO && max - min <= SATURACAO_MAXIMA;
}

/**
 * Máscara de produto por flood fill 4-vizinhos desde todas as bordas.
 * Exportada para o módulo de qualidade poder medir recortabilidade sem
 * produzir o recorte inteiro.
 */
export function calcularMascaraProduto(
  data: Buffer | Uint8Array,
  largura: number,
  altura: number,
  canais: number
): { alpha: Uint8Array; coberturaFundoPct: number } {
  const total = largura * altura;
  const fundo = new Uint8Array(total);
  const fila = new Int32Array(total);
  let ini = 0;
  let fim = 0;

  const empilhar = (i: number) => {
    if (fundo[i]) return;
    const o = i * canais;
    if (!ehFundo(data[o], data[o + 1], data[o + 2])) return;
    fundo[i] = 1;
    fila[fim++] = i;
  };

  for (let x = 0; x < largura; x++) {
    empilhar(x);
    empilhar((altura - 1) * largura + x);
  }
  for (let y = 0; y < altura; y++) {
    empilhar(y * largura);
    empilhar(y * largura + largura - 1);
  }

  while (ini < fim) {
    const i = fila[ini++];
    const x = i % largura;
    const y = (i / largura) | 0;
    if (x > 0) empilhar(i - 1);
    if (x < largura - 1) empilhar(i + 1);
    if (y > 0) empilhar(i - largura);
    if (y < altura - 1) empilhar(i + largura);
  }

  let qtdFundo = 0;
  const alpha = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    if (fundo[i]) qtdFundo++;
    alpha[i] = fundo[i] ? 0 : 255;
  }
  return { alpha, coberturaFundoPct: (qtdFundo / total) * 100 };
}

/**
 * Erosão de 1px. Remove o anel de fronteira, que carrega a mistura
 * produto+fundo do anti-aliasing do JPEG. Medido na Etapa 0: derruba
 * pixels quase-brancos na borda de 49,0% para 2,8%.
 */
function erodir1px(alpha: Uint8Array, largura: number, altura: number): Uint8Array {
  const saida = Uint8Array.from(alpha);
  for (let y = 1; y < altura - 1; y++) {
    for (let x = 1; x < largura - 1; x++) {
      const i = y * largura + x;
      if (!alpha[i]) continue;
      if (!alpha[i - 1] || !alpha[i + 1] || !alpha[i - largura] || !alpha[i + largura]) {
        saida[i] = 0;
      }
    }
  }
  return saida;
}

/** Luminância perceptual — usada só para detectar sinal de transparência. */
const luminancia = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * Recorta o produto preservando os pixels internos **sem tocá-los**.
 * Só o canal alpha é escrito; R, G e B são copiados do original.
 */
export async function recortarProduto(buffer: Buffer): Promise<SaidaRecorte> {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const largura = info.width;
  const altura = info.height;
  const canais = info.channels;

  const { alpha: bruta, coberturaFundoPct } = calcularMascaraProduto(data, largura, altura, canais);

  if (coberturaFundoPct < COBERTURA_FUNDO_MINIMA_PCT) {
    return {
      ok: false,
      falha: {
        codigo: "fundo_nao_detectado",
        motivo:
          `Só ${coberturaFundoPct.toFixed(1)}% da imagem foi reconhecida como fundo removível ` +
          `(mínimo ${COBERTURA_FUNDO_MINIMA_PCT}%). A foto provavelmente não tem fundo neutro.`,
      },
    };
  }
  if (coberturaFundoPct > COBERTURA_FUNDO_MAXIMA_PCT) {
    return {
      ok: false,
      falha: {
        codigo: "fundo_excessivo",
        motivo: `${coberturaFundoPct.toFixed(1)}% da imagem virou fundo — sobrou produto de menos para recortar.`,
      },
    };
  }

  const alpha = erodir1px(bruta, largura, altura);

  // Caixa do produto + sinal de transparência, numa passada só.
  let x0 = largura;
  let y0 = altura;
  let x1 = -1;
  let y1 = -1;
  let pixelsProduto = 0;
  let baseTotal = 0;
  let baseClaros = 0;
  const inicioBase = Math.floor(altura * 0.78);

  for (let y = 0; y < altura; y++) {
    for (let x = 0; x < largura; x++) {
      const i = y * largura + x;
      if (!alpha[i]) continue;
      pixelsProduto++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (y >= inicioBase) {
        baseTotal++;
        const o = i * canais;
        if (luminancia(data[o], data[o + 1], data[o + 2]) > 215) baseClaros++;
      }
    }
  }

  if (pixelsProduto === 0 || x1 < 0) {
    return { ok: false, falha: { codigo: "produto_ausente", motivo: "Nenhum pixel de produto restou após o recorte." } };
  }

  // RGB copiado byte a byte; só o alpha é decidido por nós. É isto que
  // sustenta a assertiva de fidelidade em `capa-deterministica.ts`.
  const rgba = Buffer.alloc(largura * altura * 4);
  for (let i = 0; i < largura * altura; i++) {
    const o = i * canais;
    const d = i * 4;
    rgba[d] = data[o];
    rgba[d + 1] = data[o + 1];
    rgba[d + 2] = data[o + 2];
    rgba[d + 3] = alpha[i];
  }

  const png = await sharp(rgba, { raw: { width: largura, height: altura, channels: 4 } }).png().toBuffer();

  return {
    ok: true,
    recorte: {
      png,
      largura,
      altura,
      caixa: { x: x0, y: y0, largura: x1 - x0 + 1, altura: y1 - y0 + 1 },
      pixelsProduto,
      coberturaFundoPct,
      // 8% da faixa inferior quase branca já indica fundo preservado
      // através do vidro (medido: 10,6% no packshot de esmaltes).
      alertaTransparencia: baseTotal > 0 && baseClaros / baseTotal > 0.08,
    },
  };
}
