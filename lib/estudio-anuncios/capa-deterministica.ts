/**
 * Capa do anúncio composta deterministicamente — SEM IA.
 *
 * ── O princípio ─────────────────────────────────────────────────────
 * Os pixels do produto vêm da fotografia original. A capa é
 * recorte + fundo branco + centralização + escala uniforme + margem.
 * Nada é redesenhado, nada é inventado, nada é "melhorado".
 *
 * Consequência que justifica a arquitetura inteira: marca, rótulo,
 * textos impressos, cor, geometria e quantidade ficam preservados **por
 * construção**, não por instrução a um modelo. A auditoria de 8 imagens
 * geradas deu 0/8 em fidelidade; o recorte medido deu 100,000% de
 * pixels idênticos. É a diferença entre pedir e garantir.
 *
 * ── Operações permitidas, e por quê essas ───────────────────────────
 * Só translação, escala UNIFORME e composição sobre fundo sólido.
 *   · escala uniforme  → preserva proporção; anisotrópica deformaria o
 *                        rótulo e a silhueta
 *   · fundo branco     → o Mercado Livre pede produto sobre fundo limpo
 *                        na principal
 *   · margem de segurança → evita corte na miniatura do marketplace
 *
 * Proibido aqui, e a proibição é verificada por teste: correção de cor,
 * relight, warp, perspectiva, sombra sintética, texto, cenário,
 * decoração e qualquer chamada a provedor de IA.
 */
import sharp from "sharp";
import { createHash } from "node:crypto";
import { recortarProduto, VERSAO_METODO_RECORTE, type SaidaRecorte } from "./recorte";
import {
  analisarQualidadeFoto,
  selecionarReferenciaPrincipal,
  type AnaliseQualidadeFoto,
} from "./qualidade-foto";

export const METODO_CAPA = "recorte_fundo_branco";
export const VERSAO_METODO_CAPA = 1;

/**
 * Lado da capa exportada. 1024 fica confortavelmente entre o mínimo
 * (500) e o máximo (1920) documentados do Mercado Livre, e é o mesmo
 * lado que a geração por IA já produzia — mantém a UI e o compliance
 * sem surpresa de formato.
 */
export const LADO_CAPA_PX = 1024;

/**
 * Fração do lado ocupada pelo produto. 0,88 deixa 6% de margem de cada
 * lado: respiro suficiente para a miniatura do marketplace não cortar,
 * sem o produto ficar pequeno na listagem.
 */
export const OCUPACAO_PRODUTO = 0.88;

export interface ProvenienciaCapa {
  metodo: string;
  versaoMetodo: number;
  versaoRecorte: number;
  origemFotoId: string;
  houveIA: false;
  houveComposicao: true;
  checksumOriginal: string;
  checksumRecorte: string;
  checksumFinal: string;
  /** Escala aplicada. > 1 significa ampliação — sem ganho de detalhe. */
  escala: number;
  ladoUtilOrigemPx: number;
  alertaTransparencia: boolean;
}

export interface CapaComposta {
  png: Buffer;
  largura: number;
  altura: number;
  proveniencia: ProvenienciaCapa;
}

export type SaidaCapa =
  | { ok: true; capa: CapaComposta }
  | { ok: false; motivo: string; codigo: string };

const sha256 = (b: Buffer | Uint8Array) => createHash("sha256").update(b).digest("hex");

/**
 * Compõe a capa. Falha explicitamente quando a foto não serve — nunca
 * cai para geração por IA. "Não consegui recortar, então redesenhei o
 * produto" é exatamente o comportamento que esta arquitetura existe
 * para impedir.
 */
export async function comporCapaDeterministica(params: {
  origemFotoId: string;
  bufferOriginal: Buffer;
}): Promise<SaidaCapa> {
  const { origemFotoId, bufferOriginal } = params;

  const saida: SaidaRecorte = await recortarProduto(bufferOriginal);
  if (!saida.ok) {
    return { ok: false, codigo: saida.falha.codigo, motivo: saida.falha.motivo };
  }
  const recorte = saida.recorte;
  const { caixa } = recorte;

  // Escala UNIFORME: um único fator para os dois eixos, calculado pelo
  // lado dominante do produto. É o que preserva proporção.
  const ladoDominante = Math.max(caixa.largura, caixa.altura);
  const alvo = Math.round(LADO_CAPA_PX * OCUPACAO_PRODUTO);
  const escala = alvo / ladoDominante;

  const larguraFinal = Math.max(1, Math.round(caixa.largura * escala));
  const alturaFinal = Math.max(1, Math.round(caixa.altura * escala));

  const produtoEscalado = await sharp(recorte.png)
    .extract({ left: caixa.x, top: caixa.y, width: caixa.largura, height: caixa.altura })
    .resize(larguraFinal, alturaFinal, { fit: "fill", kernel: "lanczos3" })
    .png()
    .toBuffer();

  const png = await sharp({
    create: {
      width: LADO_CAPA_PX,
      height: LADO_CAPA_PX,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .composite([
      {
        input: produtoEscalado,
        left: Math.round((LADO_CAPA_PX - larguraFinal) / 2),
        top: Math.round((LADO_CAPA_PX - alturaFinal) / 2),
      },
    ])
    .png()
    .toBuffer();

  return {
    ok: true,
    capa: {
      png,
      largura: LADO_CAPA_PX,
      altura: LADO_CAPA_PX,
      proveniencia: {
        metodo: METODO_CAPA,
        versaoMetodo: VERSAO_METODO_CAPA,
        versaoRecorte: VERSAO_METODO_RECORTE,
        origemFotoId,
        houveIA: false,
        houveComposicao: true,
        checksumOriginal: sha256(bufferOriginal),
        checksumRecorte: sha256(recorte.png),
        checksumFinal: sha256(png),
        escala,
        ladoUtilOrigemPx: Math.min(caixa.largura, caixa.altura),
        alertaTransparencia: recorte.alertaTransparencia,
      },
    },
  };
}

/**
 * Escolhe a melhor foto do projeto e compõe a capa, já com as
 * assertivas de fidelidade aplicadas.
 *
 * FALHA EXPLÍCITA por desenho. Se nenhuma foto serve, devolve o motivo —
 * nunca cai para geração por IA. "Não consegui recortar, então
 * redesenhei o produto" é precisamente o comportamento que a auditoria
 * reprovou 8 vezes em 8.
 */
export async function escolherEComporCapa(
  fotos: { imagemOrigemId: string; buffer: Buffer }[]
): Promise<SaidaCapa> {
  if (fotos.length === 0) {
    return { ok: false, codigo: "sem_foto", motivo: "O projeto não tem fotos para compor a capa." };
  }

  const analises: AnaliseQualidadeFoto[] = [];
  for (const f of fotos) {
    analises.push(await analisarQualidadeFoto(f.imagemOrigemId, f.buffer));
  }
  const selecao = selecionarReferenciaPrincipal(analises);
  if (!selecao.principalId) {
    return { ok: false, codigo: "sem_foto_apta", motivo: selecao.bloqueio ?? "Nenhuma foto apta para a capa." };
  }

  const escolhida = fotos.find(f => f.imagemOrigemId === selecao.principalId)!;
  const capa = await comporCapaDeterministica({
    origemFotoId: escolhida.imagemOrigemId,
    bufferOriginal: escolhida.buffer,
  });
  if (!capa.ok) return capa;

  // Assertivas ANTES de qualquer persistência: uma capa que não passa
  // não chega ao Storage.
  const analise = analises.find(a => a.imagemOrigemId === selecao.principalId)!;
  if (analise.caixaProduto) {
    const veredicto = await verificarFidelidadeCapa(capa.capa, analise.caixaProduto);
    if (!veredicto.aprovada) {
      return {
        ok: false,
        codigo: "assertiva_fidelidade",
        motivo: `A capa composta não passou nas verificações de fidelidade: ${veredicto.falhas.join(" ")}`,
      };
    }
  }
  return capa;
}

export interface ResultadoAssertivas {
  aprovada: boolean;
  falhas: string[];
  /** Proporção do produto: origem vs final. Devem coincidir. */
  aspectOrigem: number;
  aspectFinal: number;
}

/**
 * Assertivas de fidelidade — determinísticas, sem IA.
 *
 * Verifica o que a composição prometeu: proporção mantida, escala
 * uniforme, fundo realmente branco, e o produto presente e único no
 * quadro. A preservação dos pixels internos é garantida antes disto,
 * pelo recorte (que só escreve alpha), e é coberta por teste próprio.
 */
export async function verificarFidelidadeCapa(capa: CapaComposta, origemCaixa: {
  largura: number;
  altura: number;
}): Promise<ResultadoAssertivas> {
  const falhas: string[] = [];
  const aspectOrigem = origemCaixa.largura / origemCaixa.altura;

  const { data, info } = await sharp(capa.png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const c = info.channels;

  if (w !== capa.largura || h !== capa.altura) {
    falhas.push(`Dimensão final divergente: esperado ${capa.largura}x${capa.altura}, obtido ${w}x${h}.`);
  }
  if (w !== h) falhas.push("A capa precisa ser quadrada.");

  // Caixa do que NÃO é branco puro — é o produto composto.
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  let naoBrancos = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * c;
      if (data[o] === 255 && data[o + 1] === 255 && data[o + 2] === 255) continue;
      naoBrancos++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }

  if (naoBrancos === 0) {
    falhas.push("A capa ficou inteiramente branca — o produto não foi composto.");
    return { aprovada: false, falhas, aspectOrigem, aspectFinal: 0 };
  }

  const larguraFinal = x1 - x0 + 1;
  const alturaFinal = y1 - y0 + 1;
  const aspectFinal = larguraFinal / alturaFinal;

  // Tolerância de 1,5%: arredondamento de pixel inteiro, não deformação.
  const desvio = Math.abs(aspectFinal - aspectOrigem) / aspectOrigem;
  if (desvio > 0.015) {
    falhas.push(
      `Proporção do produto mudou ${(desvio * 100).toFixed(1)}% — a escala precisa ser uniforme ` +
      `(origem ${aspectOrigem.toFixed(3)}, final ${aspectFinal.toFixed(3)}).`
    );
  }

  // Cantos brancos provam que há margem e que nada vazou até a borda.
  const canto = (x: number, y: number) => {
    const o = (y * w + x) * c;
    return data[o] === 255 && data[o + 1] === 255 && data[o + 2] === 255;
  };
  if (!canto(0, 0) || !canto(w - 1, 0) || !canto(0, h - 1) || !canto(w - 1, h - 1)) {
    falhas.push("O fundo da capa não é branco puro nos cantos.");
  }

  const ocupacao = Math.max(larguraFinal, alturaFinal) / w;
  if (ocupacao > OCUPACAO_PRODUTO + 0.02) {
    falhas.push(`O produto ocupa ${(ocupacao * 100).toFixed(0)}% do lado — margem de segurança insuficiente.`);
  }

  return { aprovada: falhas.length === 0, falhas, aspectOrigem, aspectFinal };
}
