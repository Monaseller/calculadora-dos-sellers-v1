/**
 * Orquestração da etapa `geracao_prompts_imagem` — domínio puro +
 * pré-condições + validação determinística + chamada ao provedor.
 *
 * Mesma divisão das etapas anteriores: este arquivo NÃO decide provedor,
 * NÃO registra prompt/consumo, NÃO avança Pipeline e NÃO persiste
 * resultado — tudo isso é do executor/rota.
 *
 * O que esta etapa NUNCA faz (verificado por teste que lê este próprio
 * arquivo): gerar imagem, chamar modelo de imagem, integrar Veo, tocar
 * Storage, baixar bytes de foto, escrever em
 * `estudio_anuncios_imagens_geradas`, calcular score. Não há import de
 * storage.ts nem de fotos.ts aqui — a ausência é proposital.
 *
 * REGRA PRINCIPAL — VERDADE VISUAL. Nenhuma informação textual incerta
 * pode virar elemento visual confirmado. A defesa é estrutural, em três
 * camadas, e não depende de o modelo "se comportar":
 *   1. O modelo só recebe a verdade visual já FILTRADA por origem —
 *      nunca o resultado bruto de analise_visual, nunca conteúdo de
 *      anúncio, nunca fotos.
 *   2. O modelo só pode escrever os 9 campos de PlanoImagemIA. Tudo que
 *      é estrutural (principal, aspectRatio, textos permitidos/
 *      proibidos, prompt final, negative prompt) é montado pelo
 *      servidor.
 *   3. Todo texto escrito pelo modelo passa por validação
 *      determinística contra o corpus confirmado antes de ser aceito.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { ErroProvedorIA } from "../ai-gateway/erros";
import { chamarGeminiTexto, obterModeloPromptsImagem } from "../ai-gateway/provedores/google";
import { GERACAO_PROMPTS_IMAGEM_JSON_SCHEMA } from "../ai-gateway/provedores/google-prompts-imagem-schema";
import type { AnaliseVisualCompleta } from "../ai-gateway/provedores/google-tipos";
import { SCHEMA_VERSAO_ANALISE_VISUAL } from "../ai-gateway/provedores/google-tipos";
import { MARKETPLACES_SUPORTADOS } from "./adaptacao-marketplace-tipos";
import type { ContextoExecucaoJob } from "./executar-job";
import type { FonteAnaliseVisual } from "./geracao-conteudo-tipos";
import type {
  ConfiguracaoPromptsImagem,
  Enquadramento,
  EntradaPromptsImagem,
  EnvelopeGeracaoPromptsImagem,
  PlanoImagemIA,
  PromptImagem,
  PromptsImagemIA,
  TipoImagem,
  VerdadeVisual,
} from "./geracao-prompts-imagem-tipos";
import {
  ASPECT_RATIO_PADRAO,
  LIMITE_MAXIMO_PROMPTS_IMAGEM,
  RESTRICOES_VISUAIS_GLOBAIS,
  SCHEMA_VERSAO_GERACAO_PROMPTS_IMAGEM,
  TEXTOS_PROIBIDOS_NA_IMAGEM,
  TIPOS_IMAGEM_SUPORTADOS,
  isEnquadramento,
  isTipoImagem,
} from "./geracao-prompts-imagem-tipos";

// ────────────────────────────────────────────────────────────────────
// Restrições apresentadas ao modelo — congeladas junto do resultado.
// ────────────────────────────────────────────────────────────────────
export const RESTRICOES_PROMPTS_IMAGEM: string[] = [
  "Descrever apenas o que está na VERDADE VISUAL confirmada. Nada além.",
  "Nunca transformar informação incerta em elemento visual confirmado.",
  "Nunca inventar cor, material, medida, quantidade, acessório ou componente.",
  "Nunca adicionar marca, logotipo, etiqueta ou selo.",
  "Nunca pedir texto, letra, número ou tipografia dentro da imagem.",
  "Nunca adicionar preço, desconto, promoção, garantia ou alegação de saúde.",
  "Nunca usar item marcado como NÃO CONFIRMADO como elemento da cena.",
  "Elemento de embalagem só pode aparecer em imagem do tipo `embalagem`.",
];

// ────────────────────────────────────────────────────────────────────
// Verdade visual — derivada de analise_visual, filtrada por origem
// ────────────────────────────────────────────────────────────────────
const ORIGENS_CONFIRMADAS_PRODUTO = new Set(["produto"]);
const ORIGENS_EMBALAGEM = new Set(["embalagem_fisica"]);

/**
 * Converte o resultado de `analise_visual` na verdade visual que o
 * modelo enxerga. O filtro por `origem` é o coração da etapa: só o que
 * veio do PRODUTO pode ser desenhado como o produto; o que veio da
 * embalagem física fica isolado; o que veio de material promocional ou
 * é indeterminado vai para `naoConfirmado`, junto com
 * `informacoesNaoConfirmadas` e `alertas`.
 */
export function montarVerdadeVisual(analise: AnaliseVisualCompleta): VerdadeVisual {
  const naoConfirmado: string[] = [
    ...(analise.informacoesNaoConfirmadas ?? []),
    ...(analise.alertas ?? []),
  ];

  const coresDoProduto: string[] = [];
  const materiaisDoProduto: string[] = [];
  const componentesDoProduto: string[] = [];
  const itensDaEmbalagem: string[] = [];

  const distribuirItem = (lista: { valor: string; origem: string }[] | undefined, destino: string[]) => {
    for (const item of lista ?? []) {
      if (ORIGENS_CONFIRMADAS_PRODUTO.has(item.origem)) destino.push(item.valor);
      else if (ORIGENS_EMBALAGEM.has(item.origem)) itensDaEmbalagem.push(item.valor);
      else naoConfirmado.push(item.valor);
    }
  };
  distribuirItem(analise.cores, coresDoProduto);
  distribuirItem(analise.materiais, materiaisDoProduto);
  distribuirItem(analise.componentes, componentesDoProduto);

  const caracteristicasDoProduto: string[] = [];
  const usosConfirmados: string[] = [];
  const publicoConfirmado: string[] = [];

  const distribuirDescricao = (lista: { descricao: string; origem: string }[] | undefined, destino: string[]) => {
    for (const item of lista ?? []) {
      if (ORIGENS_CONFIRMADAS_PRODUTO.has(item.origem)) destino.push(item.descricao);
      else if (ORIGENS_EMBALAGEM.has(item.origem)) itensDaEmbalagem.push(item.descricao);
      else naoConfirmado.push(item.descricao);
    }
  };
  distribuirDescricao(analise.caracteristicasVisiveis, caracteristicasDoProduto);
  distribuirDescricao(analise.possiveisUsos, usosConfirmados);
  distribuirDescricao(analise.publicoProvavel, publicoConfirmado);

  // textosLegiveis nunca vira elemento visual — a v1 proíbe texto na
  // imagem, então todo texto lido nas fotos é, para esta etapa,
  // informação não desenhável. Vai inteiro para naoConfirmado.
  for (const t of analise.textosLegiveis ?? []) naoConfirmado.push(t.texto);

  // atributosAdicionais com origem "produto" entram como característica.
  for (const a of analise.atributosAdicionais ?? []) {
    const texto = `${a.nome}: ${a.valor}`;
    if (ORIGENS_CONFIRMADAS_PRODUTO.has(a.origem)) caracteristicasDoProduto.push(texto);
    else if (ORIGENS_EMBALAGEM.has(a.origem)) itensDaEmbalagem.push(texto);
    else naoConfirmado.push(texto);
  }

  return {
    produtoIdentificado: analise.produtoIdentificado ?? null,
    marca: analise.marca ?? null,
    modelo: analise.modelo ?? null,
    categoria: analise.categoriaProvavel ?? null,
    resumoVisual: analise.resumoVisual ?? "",
    coresDoProduto,
    materiaisDoProduto,
    componentesDoProduto,
    caracteristicasDoProduto,
    usosConfirmados,
    publicoConfirmado,
    itensDaEmbalagem,
    naoConfirmado,
  };
}

/**
 * Tipos de imagem permitidos NESTE projeto — calculado a partir da
 * verdade visual, nunca fixo. Um tipo que exigiria inventar algo
 * simplesmente não é oferecido ao modelo, e a validação o rejeita se ele
 * tentar assim mesmo.
 */
export function calcularTiposPermitidos(vv: VerdadeVisual): TipoImagem[] {
  const permitidos: TipoImagem[] = ["capa_principal", "perspectiva"];
  if (vv.componentesDoProduto.length > 0 || vv.caracteristicasDoProduto.length > 0) {
    permitidos.push("detalhes");
  }
  if (vv.usosConfirmados.length > 0) permitidos.push("uso");
  if (vv.itensDaEmbalagem.length > 0) permitidos.push("embalagem");
  // Ordem estável, sempre a mesma de TIPOS_IMAGEM_SUPORTADOS.
  return TIPOS_IMAGEM_SUPORTADOS.filter(t => permitidos.includes(t));
}

// ────────────────────────────────────────────────────────────────────
// Configuração (Projeto Mestre) e entrada
// ────────────────────────────────────────────────────────────────────
export function montarConfiguracao(params: {
  quantidadeSolicitada: number;
  estilo: string | null;
  modo: string;
  marketplaces: string[];
  verdadeVisual: VerdadeVisual;
}): ConfiguracaoPromptsImagem {
  return {
    quantidadeSolicitada: params.quantidadeSolicitada,
    estilo: params.estilo,
    modo: params.modo,
    marketplaces: [...params.marketplaces].sort(),
    aspectRatio: ASPECT_RATIO_PADRAO,
    tiposPermitidos: calcularTiposPermitidos(params.verdadeVisual),
    restricoesVisuaisGlobais: [...RESTRICOES_VISUAIS_GLOBAIS],
    textosPermitidos: [],
    textosProibidos: [...TEXTOS_PROIBIDOS_NA_IMAGEM],
  };
}

/**
 * Valida a configuração ANTES de qualquer chamada paga. Toda falha aqui
 * é `validation` e custa zero.
 */
export function validarConfiguracao(config: ConfiguracaoPromptsImagem): void {
  if (!Number.isInteger(config.quantidadeSolicitada) || config.quantidadeSolicitada < 1) {
    throw new ErroProvedorIA(
      "validation",
      `quantidade_imagens_solicitada inválida (${config.quantidadeSolicitada}) — o projeto precisa de pelo menos 1 imagem.`
    );
  }
  if (config.quantidadeSolicitada > LIMITE_MAXIMO_PROMPTS_IMAGEM) {
    throw new ErroProvedorIA(
      "validation",
      `quantidade_imagens_solicitada=${config.quantidadeSolicitada} acima do teto operacional de ${LIMITE_MAXIMO_PROMPTS_IMAGEM} prompts por job.`
    );
  }
  for (const mk of config.marketplaces) {
    if (!(MARKETPLACES_SUPORTADOS as readonly string[]).includes(mk)) {
      throw new ErroProvedorIA("validation", `Marketplace inexistente na configuração: "${mk}".`);
    }
  }
  if (!config.tiposPermitidos.includes("capa_principal")) {
    throw new ErroProvedorIA("validation", "tiposPermitidos sem `capa_principal` — todo projeto precisa de uma imagem principal.");
  }
  if (config.textosPermitidos.length > 0) {
    throw new ErroProvedorIA(
      "validation",
      "textosPermitidos não vazio — a v1 não autoriza nenhum texto gerado dentro da imagem."
    );
  }
}

export function montarEntradaPromptsImagem(verdadeVisual: VerdadeVisual): EntradaPromptsImagem {
  return { verdadeVisual, restricoes: RESTRICOES_PROMPTS_IMAGEM };
}

const ROTULO_TIPO: Record<TipoImagem, string> = {
  capa_principal: "imagem principal do anúncio — produto isolado, leitura imediata, composição limpa",
  perspectiva: "outro ângulo do mesmo produto, sem novos elementos",
  detalhes: "close de um componente ou característica já confirmada",
  uso: "produto em contexto de uso confirmado, sem pessoas",
  embalagem: "embalagem física do produto, apenas se ela foi observada",
};

const ROTULO_ENQUADRAMENTO: Record<Enquadramento, string> = {
  produto_inteiro: "produto inteiro no quadro",
  tres_quartos: "ângulo de três quartos",
  close_detalhe: "close aproximado de detalhe",
  plano_medio: "plano médio",
};

export function montarPromptGeracaoPromptsImagem(
  entrada: EntradaPromptsImagem,
  config: ConfiguracaoPromptsImagem
): string {
  const vv = entrada.verdadeVisual;
  const linhas: string[] = [];
  const lista = (titulo: string, itens: string[]) => {
    if (itens.length === 0) return;
    linhas.push(`${titulo}:`);
    for (const i of itens) linhas.push(`- ${i}`);
    linhas.push("");
  };

  linhas.push(
    "Você planeja um conjunto de imagens de produto para um anúncio de e-commerce.",
    "Você NÃO gera imagens. Você NÃO escreve texto de anúncio. Você descreve, de forma estruturada, o que cada imagem deve mostrar.",
    "",
    "REGRAS INVIOLÁVEIS:"
  );
  for (const r of entrada.restricoes) linhas.push(`- ${r}`);
  linhas.push("");

  linhas.push("VERDADE VISUAL CONFIRMADA (única fonte permitida):");
  linhas.push(`- Produto: ${vv.produtoIdentificado ?? "não identificado"}`);
  if (vv.categoria?.length) linhas.push(`- Categoria: ${vv.categoria.join(" > ")}`);
  if (vv.resumoVisual) linhas.push(`- Resumo visual: ${vv.resumoVisual}`);
  linhas.push("");
  lista("Cores do produto", vv.coresDoProduto);
  lista("Materiais do produto", vv.materiaisDoProduto);
  lista("Componentes do produto", vv.componentesDoProduto);
  lista("Características do produto", vv.caracteristicasDoProduto);
  lista("Usos confirmados", vv.usosConfirmados);
  lista("Público confirmado", vv.publicoConfirmado);
  lista("Itens da embalagem física (só usáveis em imagem do tipo `embalagem`)", vv.itensDaEmbalagem);
  lista("NÃO CONFIRMADO — proibido virar elemento visual", vv.naoConfirmado);

  linhas.push("TIPOS DE IMAGEM PERMITIDOS NESTE PROJETO:");
  for (const t of config.tiposPermitidos) linhas.push(`- ${t}: ${ROTULO_TIPO[t]}`);
  linhas.push("", "ENQUADRAMENTOS PERMITIDOS:");
  for (const e of Object.keys(ROTULO_ENQUADRAMENTO) as Enquadramento[]) {
    linhas.push(`- ${e}: ${ROTULO_ENQUADRAMENTO[e]}`);
  }
  linhas.push("");

  if (config.estilo) {
    linhas.push(`ESTILO VISUAL DO PROJETO: ${config.estilo}. Ele orienta fundo e iluminação, nunca altera o produto.`, "");
  }

  linhas.push(
    `Produza EXATAMENTE ${config.quantidadeSolicitada} imagem(ns).`,
    "`ordem` deve ir de 1 até a quantidade pedida, sem repetir e sem pular.",
    "A imagem de `ordem` 1 tem obrigatoriamente `tipo` = capa_principal, e nenhuma outra pode ter esse tipo.",
    "A imagem principal prioriza o produto: leitura clara, composição limpa, fundo adequado, sem distrações e sem elemento decorativo desnecessário.",
    "",
    "Nenhuma imagem pode conter texto. Não descreva rótulo, letreiro, banner, selo ou tipografia.",
    "`elementosProibidos` deve trazer restrições concretas específicas desta imagem (o restante já é aplicado pelo servidor)."
  );
  return linhas.join("\n");
}

// ────────────────────────────────────────────────────────────────────
// Validação estrutural (forma) — independente do provedor
// ────────────────────────────────────────────────────────────────────
function ehObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function textoNaoVazio(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function arrayDeTextos(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(textoNaoVazio);
}

const CHAVES_PLANO = new Set([
  "ordem",
  "tipo",
  "objetivo",
  "cena",
  "enquadramento",
  "fundo",
  "iluminacao",
  "elementosObrigatorios",
  "elementosProibidos",
]);

export function validarEstruturaPromptsImagem(
  json: unknown,
  config: ConfiguracaoPromptsImagem
): PromptsImagemIA {
  if (!ehObjeto(json)) throw new ErroProvedorIA("validation", "Resposta não é um objeto JSON.");
  for (const chave of Object.keys(json)) {
    if (chave !== "imagens") {
      throw new ErroProvedorIA("validation", `Propriedade extra não permitida na raiz: "${chave}".`);
    }
  }
  const bruto = json.imagens;
  if (!Array.isArray(bruto) || bruto.length === 0) {
    throw new ErroProvedorIA("validation", "Campo obrigatório 'imagens' ausente ou vazio.");
  }
  if (bruto.length !== config.quantidadeSolicitada) {
    throw new ErroProvedorIA(
      "validation",
      `Quantidade incorreta: ${bruto.length} imagem(ns) devolvida(s), ${config.quantidadeSolicitada} solicitada(s) pelo projeto.`
    );
  }

  const imagens: PlanoImagemIA[] = [];
  const ordensVistas = new Set<number>();
  let principais = 0;

  for (const item of bruto) {
    if (!ehObjeto(item)) throw new ErroProvedorIA("validation", "Item de 'imagens' não é objeto.");
    for (const chave of Object.keys(item)) {
      if (!CHAVES_PLANO.has(chave)) {
        throw new ErroProvedorIA("validation", `Propriedade extra não permitida em imagem: "${chave}".`);
      }
    }
    for (const chave of CHAVES_PLANO) {
      if (item[chave] === undefined) {
        throw new ErroProvedorIA("validation", `Campo obrigatório ausente em imagem: "${chave}".`);
      }
    }

    if (typeof item.ordem !== "number" || !Number.isInteger(item.ordem)) {
      throw new ErroProvedorIA("validation", `ordem inválida: ${JSON.stringify(item.ordem)}.`);
    }
    if (item.ordem < 1 || item.ordem > config.quantidadeSolicitada) {
      throw new ErroProvedorIA(
        "validation",
        `ordem ${item.ordem} fora do intervalo 1..${config.quantidadeSolicitada}.`
      );
    }
    if (ordensVistas.has(item.ordem)) {
      throw new ErroProvedorIA("validation", `ordem duplicada: ${item.ordem}.`);
    }
    ordensVistas.add(item.ordem);

    if (!isTipoImagem(item.tipo)) {
      throw new ErroProvedorIA("validation", `Tipo de imagem inválido: ${JSON.stringify(item.tipo)}.`);
    }
    if (!config.tiposPermitidos.includes(item.tipo)) {
      throw new ErroProvedorIA(
        "validation",
        `Tipo "${item.tipo}" não permitido neste projeto (permitidos: ${config.tiposPermitidos.join(", ")}).`
      );
    }
    if (item.tipo === "capa_principal") {
      principais++;
      if (item.ordem !== 1) {
        throw new ErroProvedorIA("validation", `capa_principal precisa ter ordem 1 (veio ${item.ordem}).`);
      }
    }
    if (!isEnquadramento(item.enquadramento)) {
      throw new ErroProvedorIA("validation", `Enquadramento inválido: ${JSON.stringify(item.enquadramento)}.`);
    }
    for (const campo of ["objetivo", "cena", "fundo", "iluminacao"] as const) {
      if (!textoNaoVazio(item[campo])) {
        throw new ErroProvedorIA("validation", `Campo "${campo}" vazio na imagem de ordem ${item.ordem}.`);
      }
    }
    if (!arrayDeTextos(item.elementosObrigatorios) || item.elementosObrigatorios.length === 0) {
      throw new ErroProvedorIA(
        "validation",
        `elementosObrigatorios inválido ou vazio na imagem de ordem ${item.ordem}.`
      );
    }
    if (!arrayDeTextos(item.elementosProibidos)) {
      throw new ErroProvedorIA("validation", `elementosProibidos inválido na imagem de ordem ${item.ordem}.`);
    }

    imagens.push({
      ordem: item.ordem,
      tipo: item.tipo,
      objetivo: item.objetivo as string,
      cena: item.cena as string,
      enquadramento: item.enquadramento,
      fundo: item.fundo as string,
      iluminacao: item.iluminacao as string,
      elementosObrigatorios: item.elementosObrigatorios,
      elementosProibidos: item.elementosProibidos,
    });
  }

  if (principais !== 1) {
    throw new ErroProvedorIA(
      "validation",
      `Esperada exatamente 1 imagem principal (capa_principal), encontradas ${principais}.`
    );
  }
  for (let i = 1; i <= config.quantidadeSolicitada; i++) {
    if (!ordensVistas.has(i)) {
      throw new ErroProvedorIA("validation", `ordem ${i} ausente — a sequência precisa ser contínua de 1 a ${config.quantidadeSolicitada}.`);
    }
  }

  // Ordem determinística no resultado persistido, nunca a ordem de
  // retorno do modelo.
  imagens.sort((a, b) => a.ordem - b.ordem);
  return { imagens };
}

// ────────────────────────────────────────────────────────────────────
// Validação de INTEGRIDADE (conteúdo) — o que impede invenção visual
// ────────────────────────────────────────────────────────────────────
export interface ResultadoValidacaoPromptsImagem {
  valido: boolean;
  motivo?: string;
}

function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Termos SEMPRE proibidos no texto escrito pelo modelo — nunca
 * condicionados ao corpus. Diferente das etapas de texto, aqui a
 * proibição é absoluta: mesmo que a embalagem física traga a palavra
 * "promoção", ela não pode ser desenhada.
 */
const TERMOS_SEMPRE_PROIBIDOS = [
  // promocional / comercial
  //
  // "reais" e "off" estiveram nesta lista e foram REMOVIDOS depois da
  // primeira rodada real (2026-08-15): "reais" barrou "condições reais de
  // uso" (adjetivo, não moeda) e "off" barraria "off-white" (fundo neutro
  // legítimo). Preço e desconto continuam cobertos por "preco",
  // "desconto", "promocao", "cupom" e "porcentagem", sem o falso positivo.
  "preco", "desconto", "promocao", "oferta", "cupom", "gratis", "frete",
  "garantia", "garantido", "imperdivel", "melhor preco", "compre", "aproveite",
  "porcentagem",
  // alegação clínica
  "cura", "trata", "tratamento", "terapeutico", "medicinal", "emagrece",
  "anti idade", "rejuvenesce", "clinicamente comprovado", "anvisa",
  // texto dentro da imagem
  "texto", "letra", "letras", "palavra", "palavras", "numero", "numeros",
  "tipografia", "fonte tipografica", "banner", "letreiro", "rotulo",
  "legenda", "watermark", "marca dagua", "badge", "carimbo", "adesivo",
];

/**
 * Termos proibidos SE ausentes do corpus confirmado — cobrem marca,
 * modelo e identidade visual. Quando `marca`/`modelo` existem na análise,
 * eles entram no corpus e a menção passa a ser legítima.
 */
const TERMOS_PROIBIDOS_SE_AUSENTES_NO_CORPUS = [
  "marca", "logo", "logotipo", "etiqueta", "selo", "modelo",
];

/** Cores em português — base do teste "cor inventada". */
const CORES_CONHECIDAS = [
  "branco", "branca", "preto", "preta", "cinza", "prata", "prateado", "dourado", "dourada",
  "amarelo", "amarela", "laranja", "vermelho", "vermelha", "rosa", "roxo", "roxa", "lilas",
  "azul", "verde", "marrom", "bege", "creme", "bronze", "cobre", "turquesa", "vinho", "salmao",
];

/**
 * Cores neutras aceitas em FUNDO e ILUMINAÇÃO, mesmo sem constar na
 * verdade visual.
 *
 * A distinção veio da primeira chamada real (2026-08-15): o modelo pediu
 * "fundo branco", e a validação rejeitou porque "branco" não estava entre
 * as cores do produto. A rejeição estava errada — a proibição do contrato
 * é "nenhuma cor nova atribuída AO PRODUTO", e a cor do cenário não
 * afirma nada sobre o produto. Fundo neutro é, aliás, exatamente o que a
 * imagem principal exige.
 *
 * A lista é curta e deliberadamente só neutra: um fundo colorido ao lado
 * de um produto colorido pode, sim, induzir leitura errada da cor do
 * produto. Cor de cenário fora desta lista continua exigindo respaldo no
 * corpus confirmado.
 */
const CORES_NEUTRAS_DE_CENARIO = [
  "branco", "branca", "cinza", "preto", "preta", "bege", "creme", "prata", "prateado", "prateada",
];

/** Materiais em português — base do teste "material inventado". */
const MATERIAIS_CONHECIDOS = [
  "madeira", "plastico", "metal", "aco", "aluminio", "ferro", "vidro", "ceramica", "porcelana",
  "couro", "camurca", "silicone", "borracha", "tecido", "algodao", "linho", "poliester", "nylon",
  "bambu", "pedra", "marmore", "granito", "jade", "quartzo", "cristal", "papel", "papelao",
  "cortica", "resina", "gesso",
];

/** Palavras curtas/comuns ignoradas ao checar reaparecimento de informação proibida. */
const PALAVRAS_IGNORADAS = new Set([
  "para", "como", "com", "sem", "que", "dos", "das", "uma", "por", "pela", "pelo", "nao",
  "esta", "este", "isso", "mais", "menos", "muito", "pouco", "sobre", "entre", "seus", "suas",
  "produto", "produtos", "imagem", "imagens", "foto", "fotos", "cor", "cores",
]);

/** Números com unidade opcional — detecta medida/quantidade inventada. */
function extrairNumeros(textoNormalizado: string): Set<string> {
  const achados = new Set<string>();
  const re = /(\d+(?:[.,]\d+)?)\s*(ml|l|g|kg|mg|cm|mm|m|un|unidades|unidade|pecas|peca|pares|par|w|v)?\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(textoNormalizado)) !== null) {
    achados.add(`${m[1].replace(",", ".")}${m[2] ?? ""}`);
  }
  return achados;
}

function escaparRegex(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Casamento por PALAVRA inteira, nunca por substring. A diferença não é
 * cosmética: com substring, "retratar o produto" dispararia o termo
 * proibido "trata" e "close preciso" dispararia "preco" — rejeições
 * falsas que custariam uma chamada paga e bloqueariam o job.
 */
function contemPalavra(textoNormalizado: string, palavraNormalizada: string): boolean {
  if (!palavraNormalizada) return false;
  return new RegExp(`(^| )${escaparRegex(palavraNormalizada)}( |$)`).test(textoNormalizado);
}

function contemPalavraOuPlural(textoNormalizado: string, palavraNormalizada: string): boolean {
  return contemPalavra(textoNormalizado, palavraNormalizada) || contemPalavra(textoNormalizado, `${palavraNormalizada}s`);
}

/**
 * Radical conservador, usado SÓ para cor e material — onde a flexão de
 * gênero/número é a regra ("dourado" na análise, "dourada" no prompt) e
 * exigir casamento exato produziria rejeição falsa.
 *
 * Os limiares de tamanho existem para evitar radicais curtos demais:
 * sem eles, "rosa" viraria "ros" e casaria com "rosto" — justamente numa
 * categoria de produto (estética facial) onde "rosto" é esperado.
 */
function radical(palavra: string): string {
  let r = palavra;
  if (r.endsWith("s") && r.length >= 5) r = r.slice(0, -1);
  if ((r.endsWith("a") || r.endsWith("o")) && r.length >= 5) r = r.slice(0, -1);
  return r;
}

function contemRadical(textoNormalizado: string, palavraNormalizada: string): boolean {
  const r = radical(palavraNormalizada);
  if (r.length < 3) return false;
  return new RegExp(`(^| )${escaparRegex(r)}[a-z]*( |$)`).test(textoNormalizado);
}

/** Corpus confirmado — tudo que PODE ser desenhado, normalizado. */
export function corpusConfirmado(vv: VerdadeVisual): string {
  const partes: string[] = [
    vv.produtoIdentificado ?? "",
    vv.resumoVisual,
    ...(vv.categoria ?? []),
    ...vv.coresDoProduto,
    ...vv.materiaisDoProduto,
    ...vv.componentesDoProduto,
    ...vv.caracteristicasDoProduto,
    ...vv.usosConfirmados,
    ...vv.publicoConfirmado,
    ...vv.itensDaEmbalagem,
  ];
  // marca/modelo só entram no corpus quando de fato existem — é isso que
  // libera a menção a "marca"/"logotipo" sem abrir exceção manual.
  if (vv.marca) partes.push(vv.marca, "marca", "logo", "logotipo");
  if (vv.modelo) partes.push(vv.modelo, "modelo");
  return normalizar(partes.join(" "));
}

export function validarIntegridadePromptsImagem(
  saida: PromptsImagemIA,
  entrada: EntradaPromptsImagem,
  config: ConfiguracaoPromptsImagem
): ResultadoValidacaoPromptsImagem {
  const vv = entrada.verdadeVisual;
  const corpus = corpusConfirmado(vv);
  const numerosCorpus = extrairNumeros(corpus);

  // Palavras significativas do que NÃO foi confirmado e que não existem
  // no corpus — se reaparecerem no texto do modelo, é informação
  // proibida voltando pela porta dos fundos.
  const palavrasProibidas = new Set<string>();
  for (const item of vv.naoConfirmado) {
    for (const palavra of normalizar(item).split(" ")) {
      if (palavra.length < 5) continue;
      if (PALAVRAS_IGNORADAS.has(palavra)) continue;
      if (contemRadical(corpus, palavra)) continue;
      palavrasProibidas.add(palavra);
    }
  }

  for (const img of saida.imagens) {
    const onde = `imagem ${img.ordem} (${img.tipo})`;

    // `elementosProibidos` é uma lista de restrições — nela, citar o que
    // NÃO deve aparecer é o comportamento correto, então a checagem de
    // termos só vale para o texto que descreve a cena.
    const textoDescritivo = normalizar(
      [img.objetivo, img.cena, img.fundo, img.iluminacao, ...img.elementosObrigatorios].join(" ")
    );
    // Separação essencial: cor e material só são atributos do PRODUTO nos
    // campos que descrevem o produto. `fundo` e `iluminacao` descrevem o
    // cenário e seguem uma regra própria (ver CORES_NEUTRAS_DE_CENARIO).
    const textoProduto = normalizar([img.objetivo, img.cena, ...img.elementosObrigatorios].join(" "));
    const textoCenario = normalizar([img.fundo, img.iluminacao].join(" "));

    // 1. termo sempre proibido (promocional, clínico, texto na imagem)
    for (const termo of TERMOS_SEMPRE_PROIBIDOS) {
      if (contemPalavraOuPlural(textoDescritivo, normalizar(termo))) {
        return { valido: false, motivo: `${onde}: usou termo proibido em prompt de imagem ("${termo}").` };
      }
    }

    // 2. marca/modelo/logotipo sem respaldo na análise visual
    for (const termo of TERMOS_PROIBIDOS_SE_AUSENTES_NO_CORPUS) {
      const n = normalizar(termo);
      if (contemPalavraOuPlural(textoDescritivo, n) && !contemPalavraOuPlural(corpus, n)) {
        return { valido: false, motivo: `${onde}: introduziu "${termo}" sem respaldo na análise visual.` };
      }
    }

    // 3. cor inventada ATRIBUÍDA AO PRODUTO
    for (const cor of CORES_CONHECIDAS) {
      const n = normalizar(cor);
      if (contemRadical(textoProduto, n) && !contemRadical(corpus, n)) {
        return { valido: false, motivo: `${onde}: atribuiu ao produto a cor "${cor}", ausente da verdade visual confirmada.` };
      }
    }

    // 3b. cor de CENÁRIO — neutra, ou confirmada na verdade visual
    for (const cor of CORES_CONHECIDAS) {
      const n = normalizar(cor);
      if (!contemRadical(textoCenario, n)) continue;
      const neutra = CORES_NEUTRAS_DE_CENARIO.some(c => radical(normalizar(c)) === radical(n));
      if (!neutra && !contemRadical(corpus, n)) {
        return { valido: false, motivo: `${onde}: fundo/iluminação com a cor "${cor}", que não é neutra nem confirmada.` };
      }
    }

    // 4. material inventado ATRIBUÍDO AO PRODUTO
    for (const material of MATERIAIS_CONHECIDOS) {
      const n = normalizar(material);
      if (contemRadical(textoProduto, n) && !contemRadical(corpus, n)) {
        return { valido: false, motivo: `${onde}: atribuiu ao produto o material "${material}", ausente da verdade visual confirmada.` };
      }
    }

    // 5. medida/quantidade inventada
    for (const numero of extrairNumeros(textoDescritivo)) {
      if (!numerosCorpus.has(numero)) {
        return { valido: false, motivo: `${onde}: número/medida "${numero}" não existe na verdade visual confirmada.` };
      }
    }

    // 6. informação não confirmada reaparecendo
    for (const palavra of palavrasProibidas) {
      if (contemPalavra(textoDescritivo, palavra)) {
        return { valido: false, motivo: `${onde}: reutilizou informação NÃO CONFIRMADA ("${palavra}").` };
      }
    }

    // 7. elemento de embalagem fora de imagem de embalagem
    if (img.tipo !== "embalagem" && vv.itensDaEmbalagem.length > 0) {
      if (contemPalavra(textoDescritivo, "embalagem") || contemPalavra(textoDescritivo, "caixa")) {
        return { valido: false, motivo: `${onde}: usou elemento de embalagem fora de uma imagem do tipo "embalagem".` };
      }
    }

    // 8. a imagem principal não aceita distração
    if (img.tipo === "capa_principal") {
      for (const termo of ["pessoa", "modelo humano", "mao", "maos", "cenario elaborado", "props decorativos"]) {
        if (contemPalavra(textoDescritivo, normalizar(termo))) {
          return { valido: false, motivo: `${onde}: a imagem principal não aceita "${termo}".` };
        }
      }
    }
  }

  // 9. a configuração precisa continuar coerente com o que foi validado
  if (saida.imagens.length !== config.quantidadeSolicitada) {
    return { valido: false, motivo: `Quantidade divergente da configuração do projeto.` };
  }

  return { valido: true };
}

// ────────────────────────────────────────────────────────────────────
// Composição server-side do prompt final
// ────────────────────────────────────────────────────────────────────
export function montarPromptsFinais(
  saida: PromptsImagemIA,
  vv: VerdadeVisual,
  config: ConfiguracaoPromptsImagem
): PromptImagem[] {
  const produto = vv.produtoIdentificado ?? "produto";
  return saida.imagens.map(img => {
    const partes: string[] = [
      `Fotografia de produto: ${produto}.`,
      `Objetivo: ${img.objetivo}`,
      `Cena: ${img.cena}`,
      `Enquadramento: ${ROTULO_ENQUADRAMENTO[img.enquadramento]}.`,
      `Fundo: ${img.fundo}.`,
      `Iluminação: ${img.iluminacao}.`,
      `Elementos obrigatórios: ${img.elementosObrigatorios.join("; ")}.`,
    ];
    if (config.estilo) partes.push(`Estilo visual: ${config.estilo}.`);
    partes.push(`Proporção: ${config.aspectRatio}.`, "Sem nenhum texto na imagem.");

    return {
      ...img,
      principal: img.tipo === "capa_principal",
      aspectRatio: config.aspectRatio,
      textosPermitidos: [...config.textosPermitidos],
      textosProibidos: [...config.textosProibidos],
      promptTexto: partes.join(" "),
      negativePrompt: [...config.restricoesVisuaisGlobais, ...img.elementosProibidos].join(", "),
    };
  });
}

// ────────────────────────────────────────────────────────────────────
// Pré-condições de origem — analise_visual, nunca "o mais recente"
// ────────────────────────────────────────────────────────────────────
interface OrigemAnaliseVisual {
  analise: AnaliseVisualCompleta;
  jobOrigemId: string;
  resultadoId: string;
  schemaVersao: number;
}

/** Exportada para teste determinístico com cliente Supabase de mentira — nunca chamada fora daqui em produção. */
export async function validarOrigemEBuscarAnaliseVisual(
  supabase: SupabaseClient,
  ctx: ContextoExecucaoJob
): Promise<OrigemAnaliseVisual> {
  const { data: job, error: erroJob } = await supabase
    .from("estudio_anuncios_jobs")
    .select("id, projeto_id, job_origem_id")
    .eq("id", ctx.jobId)
    .maybeSingle();
  if (erroJob) throw new ErroProvedorIA("validation", `Falha ao ler job atual: ${erroJob.message}`.slice(0, 300));
  if (!job) throw new ErroProvedorIA("validation", `Job ${ctx.jobId} não encontrado.`);

  if (!job.job_origem_id) {
    throw new ErroProvedorIA(
      "validation",
      "job_origem_id ausente — geracao_prompts_imagem exige o job de analise_visual de origem explícito (nunca inferido por ordenação)."
    );
  }

  const { data: jobOrigem, error: erroOrigem } = await supabase
    .from("estudio_anuncios_jobs")
    .select("id, projeto_id, etapa, status")
    .eq("id", job.job_origem_id)
    .maybeSingle();
  if (erroOrigem) throw new ErroProvedorIA("validation", `Falha ao ler job de origem: ${erroOrigem.message}`.slice(0, 300));
  if (!jobOrigem) throw new ErroProvedorIA("validation", `Job de origem ${job.job_origem_id} não encontrado.`);
  if (jobOrigem.projeto_id !== job.projeto_id) {
    throw new ErroProvedorIA(
      "validation",
      `Job de origem pertence a outro projeto (esperado ${job.projeto_id}, encontrado ${jobOrigem.projeto_id}).`
    );
  }
  if (jobOrigem.etapa !== "analise_visual") {
    throw new ErroProvedorIA(
      "validation",
      `Job de origem tem etapa "${jobOrigem.etapa}", esperado "analise_visual" — geracao_prompts_imagem consome a verdade visual, não o conteúdo comercial.`
    );
  }
  if (jobOrigem.status !== "concluido") {
    throw new ErroProvedorIA("validation", `Job de origem não está concluído (status atual: "${jobOrigem.status}").`);
  }

  const { data: resultados, error: erroRes } = await supabase
    .from("estudio_anuncios_resultados_pipeline")
    .select("id, etapa, schema_versao, resultado")
    .eq("job_id", job.job_origem_id);
  if (erroRes) throw new ErroProvedorIA("validation", `Falha ao ler resultado de origem: ${erroRes.message}`.slice(0, 300));
  if (!resultados || resultados.length !== 1) {
    throw new ErroProvedorIA(
      "validation",
      `Esperado exatamente 1 resultado de analise_visual para o job de origem, encontrado ${resultados?.length ?? 0}.`
    );
  }
  const row = resultados[0] as { id: string; etapa: string; schema_versao: number; resultado: unknown };
  if (row.etapa !== "analise_visual") {
    throw new ErroProvedorIA("validation", `Resultado de origem tem etapa "${row.etapa}", esperado "analise_visual".`);
  }
  if (row.schema_versao !== SCHEMA_VERSAO_ANALISE_VISUAL) {
    throw new ErroProvedorIA(
      "validation",
      `Resultado de origem tem schema_versao=${row.schema_versao}, esperado ${SCHEMA_VERSAO_ANALISE_VISUAL}.`
    );
  }

  const analise = row.resultado as AnaliseVisualCompleta;
  if (typeof analise?.resumoVisual !== "string" || !Array.isArray(analise?.cores)) {
    throw new ErroProvedorIA("validation", "Resultado de analise_visual sem shape utilizável (resumoVisual/cores ausentes).");
  }

  return { analise, jobOrigemId: job.job_origem_id as string, resultadoId: row.id, schemaVersao: row.schema_versao };
}

/** Configuração do Projeto Mestre — nunca inventada, sempre lida da tabela. */
async function buscarConfiguracaoDoProjeto(
  supabase: SupabaseClient,
  projetoId: string
): Promise<{ quantidadeSolicitada: number; estilo: string | null; modo: string; marketplaces: string[] }> {
  const { data: projeto, error } = await supabase
    .from("estudio_anuncios_projetos")
    .select("quantidade_imagens_solicitada, estilo, modo")
    .eq("id", projetoId)
    .maybeSingle();
  if (error) throw new ErroProvedorIA("validation", `Falha ao ler o projeto: ${error.message}`.slice(0, 300));
  if (!projeto) throw new ErroProvedorIA("validation", `Projeto ${projetoId} não encontrado.`);

  const { data: mks, error: erroMk } = await supabase
    .from("estudio_anuncios_projetos_marketplace")
    .select("marketplace")
    .eq("projeto_id", projetoId);
  if (erroMk) throw new ErroProvedorIA("validation", `Falha ao ler marketplaces do projeto: ${erroMk.message}`.slice(0, 300));

  return {
    quantidadeSolicitada: (projeto as { quantidade_imagens_solicitada: number }).quantidade_imagens_solicitada,
    estilo: (projeto as { estilo: string | null }).estilo ?? null,
    modo: (projeto as { modo: string }).modo,
    marketplaces: (mks ?? []).map(r => (r as { marketplace: string }).marketplace),
  };
}

// ────────────────────────────────────────────────────────────────────
// Orquestrador
// ────────────────────────────────────────────────────────────────────
export interface ExecucaoGeracaoPromptsImagem {
  envelope: EnvelopeGeracaoPromptsImagem;
  modelo: string;
  tokensEntrada: number;
  tokensSaida: number;
  tempoMs: number;
}

export async function executarGeracaoPromptsImagemGoogle(
  supabaseServico: SupabaseClient,
  ctx: ContextoExecucaoJob
): Promise<ExecucaoGeracaoPromptsImagem> {
  const origem = await validarOrigemEBuscarAnaliseVisual(supabaseServico, ctx);
  const verdadeVisual = montarVerdadeVisual(origem.analise);
  const dadosProjeto = await buscarConfiguracaoDoProjeto(supabaseServico, ctx.projetoId);
  const configuracao = montarConfiguracao({ ...dadosProjeto, verdadeVisual });

  // Toda falha de configuração acontece ANTES da chamada paga.
  validarConfiguracao(configuracao);

  const entrada = montarEntradaPromptsImagem(verdadeVisual);
  const promptTexto = montarPromptGeracaoPromptsImagem(entrada, configuracao);

  const { resultadoTexto, modelo, tokensEntrada, tokensSaida, tempoMs } = await chamarGeminiTexto({
    promptTexto,
    schema: GERACAO_PROMPTS_IMAGEM_JSON_SCHEMA,
    modelo: obterModeloPromptsImagem(),
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(resultadoTexto);
  } catch {
    throw new ErroProvedorIA("validation", "JSON inválido devolvido pelo Gemini (falha ao fazer parse).");
  }

  const saida = validarEstruturaPromptsImagem(parsed, configuracao);

  const integridade = validarIntegridadePromptsImagem(saida, entrada, configuracao);
  if (!integridade.valido) {
    throw new ErroProvedorIA(
      "conteudo_rejeitado",
      (integridade.motivo ?? "Violação de integridade dos prompts de imagem.").slice(0, 300)
    );
  }

  const prompts = montarPromptsFinais(saida, verdadeVisual, configuracao);

  const fonteAnaliseVisual: FonteAnaliseVisual = {
    jobId: origem.jobOrigemId,
    resultadoId: origem.resultadoId,
    schemaVersao: origem.schemaVersao,
  };

  return {
    envelope: { fonteAnaliseVisual, configuracao, entrada, prompts },
    modelo,
    tokensEntrada,
    tokensSaida,
    tempoMs,
  };
}

/** Resumo curto e seguro para central_ia_prompts.resultado_resumo — nunca o envelope inteiro. */
export function montarResumoCurtoPromptsImagem(envelope: EnvelopeGeracaoPromptsImagem): string {
  const tipos = envelope.prompts.map(p => `${p.ordem}:${p.tipo}`).join(" | ");
  return `${envelope.prompts.length} prompt(s) — ${tipos}`.slice(0, 500);
}

export { SCHEMA_VERSAO_GERACAO_PROMPTS_IMAGEM };
