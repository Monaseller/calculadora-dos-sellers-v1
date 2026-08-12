/**
 * Tipos de domínio da etapa `geracao_prompts_imagem` — independentes de
 * provedor (nenhum tipo aqui depende do SDK do Google/Gemini). Mesmo
 * princípio já aplicado a geracao-conteudo-tipos.ts,
 * adaptacao-marketplace-tipos.ts e revisao-claude-tipos.ts: o schema JSON
 * específico do Google vive em
 * lib/ai-gateway/provedores/google-prompts-imagem-schema.ts, que importa
 * estes tipos — nunca o contrário.
 *
 * PAPEL DA ETAPA: transformar a VERDADE VISUAL confirmada do produto em
 * instruções estruturadas para uma futura geração de imagem. Ela NÃO
 * gera imagem, NÃO chama modelo de imagem, NÃO toca Storage, NÃO baixa
 * bytes de foto e NÃO escreve em estudio_anuncios_imagens_geradas — a
 * responsabilidade termina na produção e persistência dos prompts.
 *
 * ORIGEM SEMÂNTICA (decisão desta tarefa, 2026-08-15): a etapa consome
 * `analise_visual`, NÃO `adaptacao_marketplace` nem `revisao_claude`.
 * Motivo — e é uma decisão de segurança, não de minimalismo:
 *   1. Tudo que pode ser DESENHADO precisa ser visualmente confirmado.
 *      `analise_visual` é o único artefato do Pipeline que classifica
 *      cada atributo por `origem` ("produto" / "embalagem_fisica" /
 *      "material_promocional" / "indeterminado"). Essa classificação é
 *      exatamente o que separa "o produto é verde" de "a arte da
 *      embalagem é verde".
 *   2. Os artefatos de conteúdo (geracao_conteudo / revisao_claude /
 *      adaptacao_marketplace) são texto comercial derivado. Usá-los como
 *      fonte visual LAVA a classificação de origem: uma frase de anúncio
 *      não carrega mais a marca de que aquele atributo veio de material
 *      promocional. Passar copy de marketplace para um gerador de prompt
 *      de imagem aumenta materialmente a chance de transformar alegação
 *      textual em elemento visual confirmado — a proibição central desta
 *      etapa.
 *   3. Nada que `adaptacao_marketplace` produz é desenhável. Os
 *      marketplaces do projeto vêm da tabela
 *      `estudio_anuncios_projetos_marketplace` (mesma fonte que a
 *      própria adaptacao_marketplace usa), não do artefato dela.
 * Consequência prática: uma única origem, um único `job_origem_id`,
 * nenhuma resolução multi-fonte, nenhum `ORDER BY criado_em`.
 *
 * CONFIGURAÇÃO vem do Projeto Mestre (`estudio_anuncios_projetos`), não
 * de constante no código: `quantidade_imagens_solicitada`, `estilo` e
 * `modo` já existem como dado do projeto.
 */
import type { FonteAnaliseVisual } from "./geracao-conteudo-tipos";

/**
 * Tipos de imagem suportados — subconjunto ESTRITO do CHECK real de
 * `estudio_anuncios_imagens_geradas.finalidade` (verificado por
 * information_schema em 2026-08-15):
 *   ['capa_principal','perspectiva','beneficios','medidas','detalhes',
 *    'uso','embalagem','promocional_secundaria']
 *
 * Reusar o vocabulário do banco é deliberado: a futura `geracao_imagem`
 * grava `finalidade` nessa tabela, então o prompt já nasce falando a
 * mesma língua — nenhuma tradução, nenhum mapa paralelo.
 *
 * Três valores do CHECK ficam de fora na v1, cada um por um motivo
 * concreto (não por esquecimento):
 *   - `beneficios`: representar um benefício exige afirmar um efeito que
 *     nenhuma foto confirma. Cairia direto na proibição "alegação
 *     transformada em propriedade física".
 *   - `medidas`: exigiria medida confirmada E número desenhado dentro da
 *     imagem — e a v1 proíbe texto gerado dentro da imagem.
 *   - `promocional_secundaria`: promocional por definição.
 */
export const TIPOS_IMAGEM_SUPORTADOS = [
  "capa_principal",
  "perspectiva",
  "detalhes",
  "uso",
  "embalagem",
] as const;

export type TipoImagem = (typeof TIPOS_IMAGEM_SUPORTADOS)[number];

export function isTipoImagem(valor: unknown): valor is TipoImagem {
  return typeof valor === "string" && (TIPOS_IMAGEM_SUPORTADOS as readonly string[]).includes(valor);
}

/** Enquadramentos aceitos — lista fechada, escolhida pelo modelo dentro dela. */
export const ENQUADRAMENTOS_SUPORTADOS = [
  "produto_inteiro",
  "tres_quartos",
  "close_detalhe",
  "plano_medio",
] as const;

export type Enquadramento = (typeof ENQUADRAMENTOS_SUPORTADOS)[number];

export function isEnquadramento(valor: unknown): valor is Enquadramento {
  return typeof valor === "string" && (ENQUADRAMENTOS_SUPORTADOS as readonly string[]).includes(valor);
}

/**
 * Proporções que o contrato reconhece. O valor efetivo NÃO é escolhido
 * pelo modelo: é definido pelo servidor (ver ASPECT_RATIO_PADRAO).
 */
export const ASPECT_RATIOS_SUPORTADOS = ["1:1", "4:5", "9:16"] as const;

export type AspectRatio = (typeof ASPECT_RATIOS_SUPORTADOS)[number];

/**
 * v1 usa "1:1" para TODAS as imagens, de todos os marketplaces.
 *
 * Isto é uma decisão de honestidade, não de preguiça: não existe no
 * repositório nenhuma fonte verificada das políticas de imagem de
 * Mercado Livre, Shopee, Amazon ou TikTok Shop, e a Constituição proíbe
 * afirmar regra de canal sem fonte. "1:1" é o formato quadrado
 * universalmente aceito em listagem de marketplace. Proporção por canal
 * fica registrada como pendência de compliance (ver NEXT_TASK.md), junto
 * da pendência já existente de compliance textual.
 */
export const ASPECT_RATIO_PADRAO: AspectRatio = "1:1";

/**
 * Teto operacional de prompts por job. NÃO é uma regra de marketplace e
 * NÃO substitui `quantidade_imagens_solicitada` — a quantidade produzida
 * é sempre a do projeto. Este limite só existe para que um projeto com
 * quantidade absurda seja rejeitado com `validation` ANTES de qualquer
 * chamada paga (o CHECK do banco só garante > 0, sem teto superior).
 */
export const LIMITE_MAXIMO_PROMPTS_IMAGEM = 12;

/**
 * Restrições visuais globais — 100% server-side, nunca escritas pelo
 * modelo. Entram no `negativePrompt` de TODOS os prompts, somadas aos
 * `elementosProibidos` específicos daquela imagem.
 */
export const RESTRICOES_VISUAIS_GLOBAIS: readonly string[] = [
  "não alterar o formato, a proporção ou a silhueta do produto",
  "não inventar acessórios, peças ou componentes que não existam",
  "não adicionar marca, logotipo, etiqueta ou selo",
  "não alterar as cores do produto",
  "não alterar a quantidade de itens",
  "não adicionar texto, letras, números ou tipografia",
  "não deformar, derreter ou duplicar o produto",
  "não adicionar preço, desconto, promoção ou banner",
  "não adicionar pessoa, mão ou modelo humano",
];

/**
 * Textos proibidos dentro da imagem — server-side. Espelha a decisão da
 * v1: NENHUM texto gerado dentro da imagem (modelos de imagem ainda
 * erram ortografia, e texto renderizado vira alegação sem revisão).
 */
export const TEXTOS_PROIBIDOS_NA_IMAGEM: readonly string[] = [
  "qualquer texto, palavra, letra ou número",
  "nome de marca ou modelo",
  "preço, desconto ou porcentagem",
  "selo, carimbo ou badge",
];

/**
 * Verdade visual apresentada ao modelo — derivada de `analise_visual` e
 * já FILTRADA por origem. É o único insumo de produto que o modelo
 * enxerga: ele nunca recebe o resultado bruto de analise_visual, nunca
 * recebe conteúdo de anúncio e nunca recebe fotos.
 */
export interface VerdadeVisual {
  produtoIdentificado: string | null;
  marca: string | null;
  modelo: string | null;
  categoria: string[] | null;
  resumoVisual: string;
  /** origem = "produto" — o que pode ser desenhado como o produto. */
  coresDoProduto: string[];
  materiaisDoProduto: string[];
  componentesDoProduto: string[];
  caracteristicasDoProduto: string[];
  usosConfirmados: string[];
  publicoConfirmado: string[];
  /** origem = "embalagem_fisica" — só desenhável em imagem do tipo `embalagem`. */
  itensDaEmbalagem: string[];
  /**
   * Tudo que NÃO pode virar elemento visual: informacoesNaoConfirmadas,
   * alertas e todo item com origem "material_promocional" ou
   * "indeterminado". Vai ao modelo como lista de proibição explícita,
   * nunca como insumo criativo.
   */
  naoConfirmado: string[];
}

/** Configuração efetiva desta execução — lida do Projeto Mestre, congelada junto do resultado. */
export interface ConfiguracaoPromptsImagem {
  quantidadeSolicitada: number;
  estilo: string | null;
  modo: string;
  /** Marketplaces do projeto — contexto/rastreabilidade. Ver nota sobre `marketplace` por prompt no cabeçalho de PromptImagem. */
  marketplaces: string[];
  aspectRatio: AspectRatio;
  tiposPermitidos: TipoImagem[];
  restricoesVisuaisGlobais: string[];
  /** v1: sempre vazio — nenhum texto autorizado dentro da imagem. */
  textosPermitidos: string[];
  textosProibidos: string[];
}

/** Exatamente o que foi apresentado ao modelo nesta chamada. */
export interface EntradaPromptsImagem {
  verdadeVisual: VerdadeVisual;
  restricoes: string[];
}

/**
 * O que o MODELO devolve por imagem — e SÓ isto. Nenhum campo
 * estrutural (principal, aspectRatio, textos permitidos/proibidos,
 * prompt final, negative prompt) é escrito pelo modelo: todos são
 * server-side. Mesmo desenho de segurança estrutural já usado em
 * `revisao_claude`, onde o modelo só podia escrever texto e os fatos
 * eram copiados pelo servidor.
 */
export interface PlanoImagemIA {
  ordem: number;
  tipo: TipoImagem;
  objetivo: string;
  cena: string;
  enquadramento: Enquadramento;
  fundo: string;
  iluminacao: string;
  elementosObrigatorios: string[];
  elementosProibidos: string[];
}

export interface PromptsImagemIA {
  imagens: PlanoImagemIA[];
}

/**
 * Prompt final persistido — campos do modelo (PlanoImagemIA) + campos do
 * servidor. `promptTexto` e `negativePrompt` são COMPOSTOS pelo servidor
 * a partir dos campos estruturados: cada palavra do prompt final vem ou
 * de um template server-side, ou de um campo do modelo que já passou
 * pela validação determinística. Nada chega ao prompt final sem passar
 * por uma das duas portas.
 *
 * NÃO existe campo `marketplace` por prompt na v1, e a ausência é
 * deliberada: `quantidade_imagens_solicitada` é do PROJETO, não por
 * canal, então o conjunto de imagens serve o projeto inteiro. Um campo
 * sempre nulo seria pior que campo nenhum. Os marketplaces do projeto
 * ficam registrados em `ConfiguracaoPromptsImagem.marketplaces`.
 */
export interface PromptImagem extends PlanoImagemIA {
  /** Servidor: exatamente 1 prompt principal por job (o de tipo `capa_principal`, ordem 1). */
  principal: boolean;
  aspectRatio: AspectRatio;
  textosPermitidos: string[];
  textosProibidos: string[];
  promptTexto: string;
  negativePrompt: string;
}

/**
 * Envelope persistido em `estudio_anuncios_resultados_pipeline.resultado`.
 *
 * Sem duplicação: os campos escritos pelo modelo aparecem UMA vez, dentro
 * de `prompts` (PromptImagem estende PlanoImagemIA). Não existe um campo
 * `saida` separado repetindo o mesmo conteúdo.
 */
export interface EnvelopeGeracaoPromptsImagem {
  fonteAnaliseVisual: FonteAnaliseVisual;
  configuracao: ConfiguracaoPromptsImagem;
  entrada: EntradaPromptsImagem;
  prompts: PromptImagem[];
}

/** Versão do ENVELOPE inteiro (configuracao + entrada + prompts), não só dos prompts. */
export const SCHEMA_VERSAO_GERACAO_PROMPTS_IMAGEM = 1;

export type { FonteAnaliseVisual };
