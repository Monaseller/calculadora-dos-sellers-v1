/**
 * Qualidade e papel das fotos enviadas — análise determinística.
 *
 * ── Por que existe (2026-09-06) ─────────────────────────────────────
 * Dois achados da auditoria motivaram este módulo.
 *
 * 1. Uma das duas "fotos originais" de um projeto real **era ela mesma
 *    uma imagem gerada por IA**, com textos deformados ("Cacau Shovi",
 *    "SB627YA VO7/2E51"). O sistema tratou as duas como fonte factual
 *    igual. Uma referência ruim contaminava uma boa.
 * 2. O único packshot legítimo tinha 447×447. Recorte perfeito de uma
 *    foto pequena continua sendo uma imagem pequena — ampliar não cria
 *    detalhe, só borra o rótulo que estávamos tentando preservar.
 *
 * ── O que este módulo NÃO faz ───────────────────────────────────────
 * Não usa IA. Não adivinha confiança. Todo sinal aqui é medido do
 * arquivo: dimensão real, cobertura de fundo por flood fill, tamanho da
 * caixa do produto, indício de transparência. Onde não há evidência, o
 * papel é o mais conservador, nunca o mais otimista.
 *
 * ── Política de resolução, e de onde ela vem ────────────────────────
 * Não inventamos 1200 como requisito. A única fonte documentada no
 * repositório é a regra oficial do Mercado Livre, já citada literalmente
 * em `compliance/regras-mercado-livre.ts`:
 *   RESOLUCAO_MINIMA_IMAGEM_ML = 500  ("the minimum is 500px x 500px")
 *   RESOLUCAO_MAXIMA_IMAGEM_ML = 1920 ("The maximum size accepted is 1920 x 1920 px")
 *
 * O que decide detalhe real não é a dimensão do arquivo, e sim o tamanho
 * da CAIXA DO PRODUTO dentro dele: um produto que ocupa 350px numa foto
 * de 447px tem 350px de detalhe, não 447. Por isso a política mede a
 * caixa, e distingue resolução de origem de resolução de exportação.
 */
import sharp from "sharp";
import {
  RESOLUCAO_MINIMA_IMAGEM_ML,
  RESOLUCAO_MAXIMA_IMAGEM_ML,
} from "./compliance/regras-mercado-livre";
import {
  calcularMascaraProduto,
  COBERTURA_FUNDO_MINIMA_PCT,
  COBERTURA_FUNDO_MAXIMA_PCT,
} from "./recorte";

/** Versão da análise — muda quando os critérios mudam. */
export const VERSAO_ANALISE_QUALIDADE = 1;

/**
 * Papéis possíveis. Ordem = prioridade como fonte de identidade.
 * `referencia_nao_confiavel_para_identidade` não descarta a foto: ela
 * continua útil para análise visual e contexto, só não manda em marca,
 * rótulo, cor, geometria ou quantidade.
 */
export const PAPEIS_FOTO = [
  "packshot_principal",
  "referencia_secundaria",
  "lifestyle",
  "detalhe",
  "uso",
  "referencia_nao_confiavel_para_identidade",
] as const;
export type PapelFoto = (typeof PAPEIS_FOTO)[number];

export type VeredictoResolucao = "adequada" | "aceitavel" | "insuficiente";

export interface AnaliseQualidadeFoto {
  imagemOrigemId: string;
  largura: number;
  altura: number;
  /** Caixa do produto — só existe quando o fundo foi reconhecido. */
  caixaProduto: { largura: number; altura: number } | null;
  /** Menor lado da caixa do produto: é ele que limita o detalhe real. */
  ladoUtilPx: number;
  coberturaFundoPct: number;
  aptaParaRecorteDeterministico: boolean;
  motivoNaoApta: string | null;
  resolucao: VeredictoResolucao;
  alertaTransparencia: boolean;
  papel: PapelFoto;
  /** Quanto do quadro é produto — proxy de enquadramento. */
  coberturaProdutoPct: number;
}

export interface SelecaoReferencias {
  analises: AnaliseQualidadeFoto[];
  /** Foto eleita base da capa. `null` = nenhuma apta. */
  principalId: string | null;
  /** Mensagem de bloqueio quando não há foto apta. */
  bloqueio: string | null;
}

const luminancia = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * Veredicto de resolução com base no lado útil (caixa do produto).
 *
 * - abaixo do mínimo oficial do ML  → insuficiente: capa fiel é impossível
 * - entre o mínimo e o máximo       → aceitável: serve, mas ampliar não
 *                                     cria detalhe; a UI precisa dizer isso
 * - a partir do máximo do ML        → adequada: exporta sem ampliar
 */
export function classificarResolucao(ladoUtilPx: number): VeredictoResolucao {
  if (ladoUtilPx < RESOLUCAO_MINIMA_IMAGEM_ML) return "insuficiente";
  if (ladoUtilPx < RESOLUCAO_MAXIMA_IMAGEM_ML) return "aceitavel";
  return "adequada";
}

/**
 * Analisa UMA foto. Recebe os bytes porque toda medida vem do arquivo
 * real — nunca de metadado declarado pelo cliente.
 */
export async function analisarQualidadeFoto(
  imagemOrigemId: string,
  buffer: Buffer
): Promise<AnaliseQualidadeFoto> {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const largura = info.width;
  const altura = info.height;
  const canais = info.channels;

  const { alpha, coberturaFundoPct } = calcularMascaraProduto(data, largura, altura, canais);

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

  const temCaixa = x1 >= 0 && y1 >= 0;
  const caixaProduto = temCaixa ? { largura: x1 - x0 + 1, altura: y1 - y0 + 1 } : null;

  let apta = true;
  let motivoNaoApta: string | null = null;
  if (coberturaFundoPct < COBERTURA_FUNDO_MINIMA_PCT) {
    apta = false;
    motivoNaoApta = "O fundo não é neutro o bastante para recortar o produto com segurança.";
  } else if (coberturaFundoPct > COBERTURA_FUNDO_MAXIMA_PCT) {
    apta = false;
    motivoNaoApta = "Quase toda a imagem foi lida como fundo — não há produto suficiente para recortar.";
  } else if (!temCaixa) {
    apta = false;
    motivoNaoApta = "Não foi possível localizar o produto na imagem.";
  }

  // Sem caixa, o lado útil é o menor lado do arquivo: é o teto do que
  // aquela foto pode oferecer de detalhe.
  const ladoUtilPx = caixaProduto
    ? Math.min(caixaProduto.largura, caixaProduto.altura)
    : Math.min(largura, altura);
  const resolucao = classificarResolucao(ladoUtilPx);
  const alertaTransparencia = baseTotal > 0 && baseClaros / baseTotal > 0.08;
  const coberturaProdutoPct = (pixelsProduto / (largura * altura)) * 100;

  return {
    imagemOrigemId,
    largura,
    altura,
    caixaProduto,
    ladoUtilPx,
    coberturaFundoPct,
    aptaParaRecorteDeterministico: apta,
    motivoNaoApta,
    resolucao,
    alertaTransparencia,
    coberturaProdutoPct,
    papel: derivarPapel({ apta, resolucao, coberturaProdutoPct }),
  };
}

/**
 * Papel derivado só de sinal medido.
 *
 * Deliberadamente conservador: `packshot_principal` exige fundo
 * recortável E resolução que não seja insuficiente. Sem fundo neutro a
 * foto é `lifestyle` — descritivo do que ela é, não uma reprovação.
 *
 * `referencia_nao_confiavel_para_identidade` fica reservado ao caso em
 * que a foto não serve nem para identidade nem para contexto útil: sem
 * recorte E abaixo do mínimo oficial. Detectar "isto foi gerado por IA"
 * por sinal de imagem não é confiável, então não fingimos que é — a
 * defesa contra referência sintética está na escolha da principal, que
 * prefere sempre a foto com fundo neutro e maior lado útil.
 */
function derivarPapel(params: {
  apta: boolean;
  resolucao: VeredictoResolucao;
  coberturaProdutoPct: number;
}): PapelFoto {
  const { apta, resolucao, coberturaProdutoPct } = params;
  if (apta && resolucao !== "insuficiente") {
    // Produto ocupando muito pouco do quadro é detalhe/contexto, não capa.
    return coberturaProdutoPct >= 12 ? "packshot_principal" : "detalhe";
  }
  if (apta && resolucao === "insuficiente") return "referencia_secundaria";
  if (!apta && resolucao === "insuficiente") return "referencia_nao_confiavel_para_identidade";
  return "lifestyle";
}

/**
 * Escolhe a base da capa entre várias fotos.
 *
 * Critério, nesta ordem: apta ao recorte → resolução → maior lado útil.
 * Ordem de upload nunca decide sozinha quando há evidência melhor; ela
 * só desempata, para o resultado ser estável entre execuções.
 *
 * Uma foto ruim NÃO invalida as boas: basta uma apta para o projeto
 * seguir. As demais continuam disponíveis para análise e contexto.
 */
export function selecionarReferenciaPrincipal(analises: AnaliseQualidadeFoto[]): SelecaoReferencias {
  const candidatas = analises.filter(
    a => a.aptaParaRecorteDeterministico && a.resolucao !== "insuficiente"
  );

  if (candidatas.length === 0) {
    const houveAptaPequena = analises.some(a => a.aptaParaRecorteDeterministico);
    return {
      analises,
      principalId: null,
      bloqueio: houveAptaPequena
        ? `Nenhuma foto tem resolução suficiente para uma capa fiel. O produto precisa aparecer com pelo menos ` +
          `${RESOLUCAO_MINIMA_IMAGEM_ML}px no menor lado — que é o mínimo exigido pelo Mercado Livre.`
        : "Envie ao menos uma foto do produto em fundo neutro e com resolução suficiente para gerar uma capa fiel.",
    };
  }

  const ordem: Record<VeredictoResolucao, number> = { adequada: 0, aceitavel: 1, insuficiente: 2 };
  const eleita = [...candidatas].sort((a, b) => {
    if (ordem[a.resolucao] !== ordem[b.resolucao]) return ordem[a.resolucao] - ordem[b.resolucao];
    if (b.ladoUtilPx !== a.ladoUtilPx) return b.ladoUtilPx - a.ladoUtilPx;
    return a.imagemOrigemId.localeCompare(b.imagemOrigemId);
  })[0];

  return { analises, principalId: eleita.imagemOrigemId, bloqueio: null };
}

/** Rótulo curto para a UI. Explica sempre POR QUE, nunca só o veredicto. */
export function descreverParaUI(a: AnaliseQualidadeFoto): { nivel: "ok" | "alerta" | "erro"; texto: string } {
  if (!a.aptaParaRecorteDeterministico) {
    return { nivel: "alerta", texto: a.motivoNaoApta ?? "Serve como referência, mas não para recorte." };
  }
  if (a.resolucao === "insuficiente") {
    return {
      nivel: "alerta",
      texto: `Produto com ${a.ladoUtilPx}px no menor lado — abaixo dos ${RESOLUCAO_MINIMA_IMAGEM_ML}px mínimos do Mercado Livre.`,
    };
  }
  if (a.alertaTransparencia) {
    return {
      nivel: "alerta",
      texto: "Boa para capa em fundo claro. O produto tem partes transparentes, então cenário escuro não fica confiável.",
    };
  }
  if (a.resolucao === "aceitavel") {
    return {
      nivel: "ok",
      texto: `Boa para capa. Produto com ${a.ladoUtilPx}px — ampliar além disso não acrescenta detalhe real.`,
    };
  }
  return { nivel: "ok", texto: "Boa para capa." };
}
