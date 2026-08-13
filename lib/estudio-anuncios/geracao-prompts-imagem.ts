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
  INSTRUCAO_FIDELIDADE_PRODUTO,
  LIMITE_MAXIMO_PROMPTS_IMAGEM,
  RESTRICOES_IMAGEM_PRINCIPAL,
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
  // Ajustado em 2026-09-04: a regra antiga dizia "nunca adicionar marca,
  // logotipo, etiqueta ou selo" e o modelo de imagem a executava como
  // "remova a marca real". O que se quer proibir é INVENTAR marca —
  // preservar a que existe é obrigação, não violação.
  "Nunca inventar marca, logotipo, etiqueta ou selo que não apareça nas fotos do produto.",
  "A marca, o rótulo e os textos já impressos no produto devem ser PRESERVADOS como estão — nunca peça para removê-los, alterá-los ou reescrevê-los.",
  "Nunca pedir texto NOVO dentro da imagem (legenda, chamada, benefício escrito, preço).",
  // Sem esta instrução o planejador escreve "rótulo bem visível" e a
  // validação rejeita por ambiguidade (ela é fail closed). Foi o que
  // quebrou o E2E de 2026-09-05: pedimos preservação e depois barramos a
  // palavra. Aqui ensinamos a FRASE que expressa preservação.
  "Ao mencionar rótulo, texto impresso, marca ou logotipo, diga SEMPRE que é para PRESERVAR o que já existe — use palavras como \"preservar\", \"manter\", \"original\", \"existente\" ou \"exatamente igual ao original\". Menção solta (ex.: \"rótulo visível\") é rejeitada por ambiguidade.",
  "Nunca use verbo de criação (adicionar, criar, inserir, escrever, colocar, aplicar) junto de rótulo, texto, marca, logotipo ou selo.",
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

  // textosLegiveis continua NÃO sendo insumo criativo: o modelo não pode
  // pedir para escrever esses textos numa cena. Mas em 2026-09-04 parou
  // de ir para `naoConfirmado`, e a distinção é o centro da correção de
  // fidelidade: `naoConfirmado` vira lista de PROIBIÇÃO no prompt, então
  // jogar ali o texto impresso na embalagem mandava o gerador apagar a
  // marca real. São coisas opostas — "não invente este texto" e "não
  // mostre este texto" — e a v1 tratava as duas como a mesma.
  //
  // Ficam registrados à parte, como identidade a PRESERVAR.
  const textosImpressosNoProduto = (analise.textosLegiveis ?? []).map(t => t.texto);

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
    textosImpressosNoProduto,
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
  // `beneficios` exige um uso ou característica JÁ CONFIRMADA para
  // mostrar — sem isso, a cena teria que afirmar um efeito que nenhuma
  // foto sustenta, que é a proibição central da etapa.
  if (vv.usosConfirmados.length > 0 || vv.caracteristicasDoProduto.length > 0) {
    permitidos.push("beneficios");
  }
  // `promocional_secundaria` é composição, não afirmação nova: basta o
  // produto. Fica disponível sempre — é o tipo que dá variedade
  // comercial sem inventar nada.
  permitidos.push("promocional_secundaria");
  // Ordem estável, sempre a mesma de TIPOS_IMAGEM_SUPORTADOS.
  return TIPOS_IMAGEM_SUPORTADOS.filter(t => permitidos.includes(t));
}

// ────────────────────────────────────────────────────────────────────
// Configuração (Projeto Mestre) e entrada
// ────────────────────────────────────────────────────────────────────
/**
 * Normaliza as instruções por imagem para EXATAMENTE `quantidade`
 * posições (2026-09-04).
 *
 * O array guardado no projeto pode ter tamanho diferente da quantidade
 * atual: a pessoa escreve 8 instruções e depois baixa para 4, ou o
 * contrário. Truncar/preencher aqui — e congelar o resultado na
 * configuração — garante que o índice de cada imagem seja estável e que
 * o resultado persistido não dependa do estado do projeto no instante
 * da leitura.
 *
 * Excedente é descartado apenas nesta execução; o banco continua com o
 * texto completo, então aumentar a quantidade de novo o traz de volta.
 */
export function normalizarDirecoesImagens(
  direcoes: string[] | null | undefined,
  quantidade: number
): string[] {
  const origem = Array.isArray(direcoes) ? direcoes : [];
  const saida: string[] = [];
  for (let i = 0; i < quantidade; i++) {
    const item = origem[i];
    saida.push(typeof item === "string" ? item.trim() : "");
  }
  return saida;
}

export function montarConfiguracao(params: {
  quantidadeSolicitada: number;
  estilo: string | null;
  modo: string;
  marketplaces: string[];
  verdadeVisual: VerdadeVisual;
  direcaoCriativa?: string | null;
  direcoesImagens?: string[] | null;
}): ConfiguracaoPromptsImagem {
  const direcaoCriativa = params.direcaoCriativa?.trim() ?? "";
  return {
    quantidadeSolicitada: params.quantidadeSolicitada,
    estilo: params.estilo,
    modo: params.modo,
    direcaoCriativa: direcaoCriativa === "" ? null : direcaoCriativa,
    direcoesImagens: normalizarDirecoesImagens(params.direcoesImagens, params.quantidadeSolicitada),
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
  // "sem pessoas" saiu em 2026-09-04: demonstrar uso quase sempre pede
  // uma mão, e a proibição global de pessoa contradizia o próprio tipo.
  // A restrição continua valendo na capa (RESTRICOES_IMAGEM_PRINCIPAL).
  uso: "produto em contexto de uso confirmado; pode incluir mão ou pessoa quando o uso confirmado exigir",
  embalagem: "embalagem física do produto, apenas se ela foi observada",
  beneficios: "produto no contexto que MOSTRA um benefício já confirmado — o benefício é demonstrado pela cena, nunca escrito",
  promocional_secundaria: "imagem comercial de apoio: composição mais elaborada, cenário trabalhado, sem texto e sem selo",
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
  lista(
    "TEXTOS JÁ IMPRESSOS NO PRODUTO — identidade a PRESERVAR (nunca peça para removê-los, e nunca peça para escrevê-los na cena)",
    vv.textosImpressosNoProduto
  );
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

  // ── Direção criativa do usuário (2026-09-04) ──────────────────────
  // Entra como CONTEXTO para o planejamento, nunca como prompt bruto: o
  // texto do usuário descreve intenção comercial, e é este modelo que a
  // traduz em cena concreta usando a verdade visual confirmada. Vem
  // depois das regras invioláveis de propósito — direção criativa não
  // pode destravar o que a verdade visual proíbe.
  if (config.direcaoCriativa) {
    linhas.push(
      "DIREÇÃO CRIATIVA DO ENSAIO (escrita pelo vendedor):",
      config.direcaoCriativa,
      "",
      "Use essa direção para orientar clima, paleta, cenário e composição. Ela NUNCA autoriza alterar o produto, inventar atributo ou contrariar as regras acima. Se algum trecho conflitar com a verdade visual, siga a verdade visual e ignore o trecho.",
      ""
    );
  }

  const instrucoesEscritas = config.direcoesImagens
    .map((texto, i) => ({ imagem: i + 1, texto }))
    .filter(d => d.texto !== "");
  if (instrucoesEscritas.length > 0) {
    linhas.push("INSTRUÇÕES POR IMAGEM (escritas pelo vendedor):");
    for (const d of instrucoesEscritas) linhas.push(`- Imagem ${d.imagem}: ${d.texto}`);
    linhas.push(
      "",
      "Interprete cada instrução e transforme-a numa cena concreta e coerente com a verdade visual — não a copie literalmente.",
      "Imagens sem instrução ficam a seu critério: escolha para elas a função comercial que estiver faltando no conjunto.",
      ""
    );
  }

  linhas.push(
    `Produza EXATAMENTE ${config.quantidadeSolicitada} imagem(ns).`,
    "`ordem` deve ir de 1 até a quantidade pedida, sem repetir e sem pular.",
    "A imagem de `ordem` 1 tem obrigatoriamente `tipo` = capa_principal, e nenhuma outra pode ter esse tipo.",
    "A imagem principal prioriza o produto: leitura clara, composição limpa, fundo adequado, sem distrações e sem elemento decorativo desnecessário.",
    "",
    // ── Estratégia comercial (2026-09-04) ───────────────────────────
    // Antes o modelo recebia só "produza N imagens" e devolvia N
    // variações do mesmo retrato — a queixa do usuário. Agora precisa
    // justificar por que cada imagem existe no anúncio.
    "PLANEJAMENTO COMERCIAL — cada imagem precisa ter uma função DIFERENTE no anúncio.",
    "Pergunte-se: quais imagens fariam esta pessoa entender e comprar este produto? Decida a combinação a partir do que ESTE produto é, não de uma fórmula fixa.",
    "Duas imagens com a mesma função são desperdício: se duas ficarem parecidas, troque uma por outra função.",
    "`objetivo` deve dizer o que a imagem VENDE (a razão comercial), não repetir a descrição da cena.",
    "",
    "Nenhuma imagem pode receber texto NOVO: não descreva legenda, chamada, banner, preço ou selo inventado. Os textos já impressos no produto são exceção e devem ser preservados.",
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
  // camada gráfica ADICIONADA — não existe fisicamente no produto, então
  // mencioná-las é sempre pedir para criar algo novo.
  "banner", "letreiro", "legenda", "watermark", "marca dagua", "badge",
];

/**
 * ────────────────────────────────────────────────────────────────────
 * IDENTIDADE FÍSICA vs TEXTO NOVO (2026-09-05)
 * ────────────────────────────────────────────────────────────────────
 * Estes termos ESTAVAM em TERMOS_SEMPRE_PROIBIDOS, e a mudança veio de
 * uma falha real em produção.
 *
 * No primeiro E2E da nova arquitetura, o projeto "Cacau shows" quebrou
 * 3/3 em `geracao_prompts_imagem` com:
 *   `imagem 1 (capa_principal): usou termo proibido ("rotulo")`
 *
 * A causa é uma contradição que nós mesmos criamos. A instrução do
 * vendedor pedia "preservar perfeitamente todas as embalagens, marcas e
 * rótulos", e a arquitetura de 2026-09-04 passou a exigir que o
 * planejador instruísse preservação de identidade. O planejador fez
 * exatamente isso — e a validação, que só olhava a PALAVRA, rejeitou.
 *
 * Enquanto a v1 proibia TODO texto na imagem, banir o substantivo
 * equivalia a banir a intenção. Isso deixou de ser verdade: agora o
 * mesmo substantivo carrega duas intenções opostas.
 *
 *   (A) "preservar o rótulo original"  -> identidade que JÁ EXISTE
 *   (B) "adicionar um selo promocional" -> texto NOVO na arte
 *
 * (A) precisa passar; (B) precisa continuar barrado. A regra passou a
 * olhar o CONTEXTO da frase, não só a presença do substantivo.
 *
 * FAIL CLOSED: sem marcador explícito de preservação, o termo continua
 * rejeitado. Ambiguidade não libera.
 */
/**
 * Quebra os campos do plano em trechos avaliáveis. A intenção é decidida
 * POR FRASE: um "preservar" no `objetivo` não pode autorizar um
 * "adicionar texto" escrito na `cena`.
 *
 * Cada campo já é uma fronteira natural; dentro dele, corta em pontuação
 * forte. Trechos vazios somem.
 */
export function segmentarTrechos(campos: string[]): string[] {
  return campos
    // Corta ANTES de normalizar: `normalizar()` troca pontuação por
    // espaço, então segmentar depois perderia toda fronteira de frase.
    .flatMap(campo => campo.split(/[.;,]|\se\s|\smas\s|\spor[ée]m\s/i))
    .map(t => normalizar(t).trim())
    .filter(t => t.length > 0);
}

const TERMOS_DE_IDENTIDADE_FISICA = [
  "texto", "letra", "letras", "palavra", "palavras", "numero", "numeros",
  "tipografia", "fonte tipografica", "rotulo", "carimbo", "adesivo",
];

/**
 * Verbos que denunciam CRIAÇÃO de elemento novo. Presentes no mesmo
 * trecho, rejeitam o termo mesmo que haja palavra de preservação junto —
 * "manter o rótulo e adicionar um selo" não pode passar por causa da
 * primeira metade.
 */
const VERBOS_DE_CRIACAO = [
  "adicionar", "adicione", "acrescentar", "acrescente", "criar", "crie",
  "inserir", "insira", "escrever", "escreva", "colocar", "coloque",
  "incluir", "inclua", "sobrepor", "sobreponha", "estampar", "estampe",
  "aplicar", "aplique", "imprimir", "imprima", "desenhar", "desenhe",
  "gerar", "gere", "novo", "nova", "novos", "novas",
];

/**
 * Marcadores de PRESERVAÇÃO do que já existe. Só a presença de um deles,
 * no mesmo trecho e sem verbo de criação, autoriza o termo de identidade.
 */
const MARCADORES_DE_PRESERVACAO = [
  "preservar", "preserve", "preservando", "preservada", "preservadas",
  "preservado", "preservados", "manter", "mantenha", "mantendo", "mantida",
  "mantidas", "mantido", "mantidos", "conservar", "conserve", "original",
  "originais", "existente", "existentes", "ja impresso", "ja impressos",
  "ja impressa", "ja impressas", "impresso", "impressos", "impressa",
  "impressas", "como esta", "como estao", "sem alterar", "sem alteracao",
  "sem modificar", "inalterado", "inalterada", "inalterados", "inalteradas",
  "identico", "identica", "fiel", "fieis", "da referencia", "das referencias",
  "de referencia", "exatamente igual", "igual ao original",
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

    // Trechos individuais — a decisão de intenção é POR FRASE, não pelo
    // texto inteiro concatenado. Sem isso, um "preservar" em `objetivo`
    // liberaria um "adicionar selo" lá em `cena`.
    const trechos = segmentarTrechos([img.objetivo, img.cena, img.fundo, img.iluminacao, ...img.elementosObrigatorios]);

    // 1. termo proibido sem exceção (promocional, clínico, camada gráfica)
    for (const termo of TERMOS_SEMPRE_PROIBIDOS) {
      if (contemPalavraOuPlural(textoDescritivo, normalizar(termo))) {
        return { valido: false, motivo: `${onde}: usou termo proibido em prompt de imagem ("${termo}").` };
      }
    }

    // 1b. identidade física — permitida SÓ em contexto de preservação.
    // Ver o bloco de comentário em TERMOS_DE_IDENTIDADE_FISICA: banir o
    // substantivo quebrou o E2E real de 2026-09-05, porque preservar a
    // identidade passou a ser exigência da arquitetura.
    for (const termo of TERMOS_DE_IDENTIDADE_FISICA) {
      const n = normalizar(termo);
      for (const trecho of trechos) {
        if (!contemPalavraOuPlural(trecho, n)) continue;
        const criacao = VERBOS_DE_CRIACAO.find(v => contemPalavraOuPlural(trecho, normalizar(v)));
        if (criacao) {
          return {
            valido: false,
            motivo: `${onde}: pediu para CRIAR texto/identidade nova ("${criacao}" + "${termo}"). Só é permitido preservar o que já existe no produto.`,
          };
        }
        if (!MARCADORES_DE_PRESERVACAO.some(m => trecho.includes(normalizar(m)))) {
          return {
            valido: false,
            motivo: `${onde}: citou "${termo}" sem deixar explícito que é para PRESERVAR o que já existe no produto.`,
          };
        }
      }
    }

    // 2. marca/modelo/logotipo sem respaldo na análise visual
    for (const termo of TERMOS_PROIBIDOS_SE_AUSENTES_NO_CORPUS) {
      const n = normalizar(termo);
      if (contemPalavraOuPlural(textoDescritivo, n) && !contemPalavraOuPlural(corpus, n)) {
        return { valido: false, motivo: `${onde}: introduziu "${termo}" sem respaldo na análise visual.` };
      }
      // Estar no corpus prova que a marca EXISTE — não autoriza criar
      // outra. "criar um novo logotipo" continua proibido mesmo com a
      // marca confirmada na análise.
      for (const trecho of trechos) {
        if (!contemPalavraOuPlural(trecho, n)) continue;
        const criacao = VERBOS_DE_CRIACAO.find(v => contemPalavraOuPlural(trecho, normalizar(v)));
        if (criacao) {
          return {
            valido: false,
            motivo: `${onde}: pediu para CRIAR "${termo}" ("${criacao}"). Identidade de marca só pode ser preservada, nunca inventada.`,
          };
        }
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
    //
    // Ajustado em 2026-09-05 pelo mesmo motivo da regra 1b: a intenção
    // importa. Introduzir a caixa como elemento de cena continua
    // proibido, mas "manter a embalagem exatamente como no original" é
    // PRESERVAÇÃO — o produto já está na embalagem dele, e pedir para
    // não alterá-la não adiciona nada à cena.
    if (img.tipo !== "embalagem" && vv.itensDaEmbalagem.length > 0) {
      for (const trecho of trechos) {
        if (!contemPalavra(trecho, "embalagem") && !contemPalavra(trecho, "caixa")) continue;
        const preservando = MARCADORES_DE_PRESERVACAO.some(m => trecho.includes(normalizar(m)));
        const criando = VERBOS_DE_CRIACAO.some(v => contemPalavraOuPlural(trecho, normalizar(v)));
        if (!preservando || criando) {
          return { valido: false, motivo: `${onde}: usou elemento de embalagem fora de uma imagem do tipo "embalagem".` };
        }
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
    const ehPrincipal = img.tipo === "capa_principal";

    // A instrução de fidelidade vem PRIMEIRO, antes de qualquer
    // descrição de cena (2026-09-04). A ordem é deliberada: o modelo
    // precisa saber que as fotos anexadas são o produto a preservar
    // antes de ler o que deve criar. Com a cena primeiro, ele começa a
    // compor e trata a referência como estilo.
    const partes: string[] = [
      INSTRUCAO_FIDELIDADE_PRODUTO,
      `Produto: ${produto}.`,
    ];
    // Nomear os textos impressos torna a preservação verificável pelo
    // modelo, em vez de uma instrução genérica que ele pode ignorar.
    if (vv.textosImpressosNoProduto.length > 0) {
      partes.push(
        `Estes textos já estão impressos no produto e devem aparecer exatamente como estão, sem reescrever nem traduzir: ${vv.textosImpressosNoProduto.join("; ")}.`
      );
    }
    if (vv.marca) partes.push(`A marca "${vv.marca}" faz parte do produto e deve ser preservada.`);
    partes.push(
      `Objetivo comercial desta imagem: ${img.objetivo}`,
      `Cena: ${img.cena}`,
      `Enquadramento: ${ROTULO_ENQUADRAMENTO[img.enquadramento]}.`,
      `Fundo: ${img.fundo}.`,
      `Iluminação: ${img.iluminacao}.`,
      `Elementos obrigatórios: ${img.elementosObrigatorios.join("; ")}.`
    );
    if (config.estilo) partes.push(`Estilo visual: ${config.estilo}.`);
    partes.push(`Proporção: ${config.aspectRatio}.`);
    // Não diz mais "sem nenhum texto na imagem": isso mandava apagar o
    // texto impresso na própria embalagem. A proibição agora é de texto
    // NOVO, e vive no negative prompt como substantivo.
    partes.push(
      "Não acrescente nenhum texto novo à imagem; os textos que já existem no produto devem ser mantidos como estão."
    );

    return {
      ...img,
      principal: ehPrincipal,
      aspectRatio: config.aspectRatio,
      textosPermitidos: [...config.textosPermitidos],
      textosProibidos: [...config.textosProibidos],
      instrucaoUsuario: config.direcoesImagens[img.ordem - 1] ?? "",
      promptTexto: partes.join(" "),
      // Só substantivos — nunca regras negadas. O provedor prefixa
      // "NÃO INCLUA, em hipótese alguma:", então cada item precisa ser
      // uma COISA que não deve aparecer no quadro.
      negativePrompt: [
        ...config.restricoesVisuaisGlobais,
        ...(ehPrincipal ? RESTRICOES_IMAGEM_PRINCIPAL : []),
        ...img.elementosProibidos,
      ].join(", "),
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
): Promise<{
  quantidadeSolicitada: number;
  estilo: string | null;
  modo: string;
  marketplaces: string[];
  direcaoCriativa: string | null;
  direcoesImagens: string[] | null;
}> {
  const { data: projeto, error } = await supabase
    .from("estudio_anuncios_projetos")
    .select("quantidade_imagens_solicitada, estilo, modo, direcao_criativa, direcoes_imagens")
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
    // Direcao do usuario (2026-09-04). Ausente e o caso NORMAL e
    // significa "a IA decide" — nunca e tratado como dado faltando.
    direcaoCriativa: (projeto as { direcao_criativa: string | null }).direcao_criativa ?? null,
    direcoesImagens: (projeto as { direcoes_imagens: string[] | null }).direcoes_imagens ?? null,
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
