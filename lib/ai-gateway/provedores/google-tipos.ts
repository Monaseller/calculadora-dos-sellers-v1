/**
 * Tipos e schema JSON do provedor Google (Gemini) — exclusivo da etapa
 * analise_visual.
 *
 * `ANALISE_VISUAL_JSON_SCHEMA` é o JSON Schema (subset suportado pela
 * Gemini API — ver docs oficiais de Structured Outputs) enviado em
 * `response_format.schema`. Note que `fotosAnalisadas` e
 * `metadadosAnalise` NÃO estão neste schema — nunca são pedidos ao
 * modelo. Ambos são montados pelo servidor DEPOIS da resposta, a
 * partir do que a aplicação já sabe (quais fotos selecionou, de onde
 * vieram), nunca do que o Gemini devolve. Isso elimina de raiz o
 * risco de o modelo inventar/errar um ID de foto.
 *
 * REVISÃO (contrato V2, ainda gravado como schema_versao=1 — decisão
 * explícita: todos os registros anteriores eram exclusivamente de
 * teste, removidos antes desta revisão entrar em vigor, então este É
 * o primeiro contrato oficial, não uma "V2" no sentido de versão
 * paralela). Baseada em 4 análises reais auditadas (ver relatório no
 * chat): produto/embalagem se misturavam em cores/materiais/
 * componentes/características sempre que havia embalagem na foto;
 * marca confirmada no produto não tinha campo estruturado próprio;
 * texto de material promocional (infográfico) contaminava
 * "possiveisUsos" sem sinalização; categoria já vinha formatada como
 * hierarquia por "/" espontaneamente em 4/4 amostras.
 *
 * Mudanças em relação ao contrato anterior:
 * - `marca`/`modelo` (novos, string|null, mesma disciplina de
 *   `produtoIdentificado`);
 * - `categoriaProvavel` vira array de strings (hierarquia), nunca mais
 *   string concatenada por "/";
 * - `caracteristicasVisiveis`/`cores`/`materiais` (renomeado de
 *   `materiaisProvaveis`)/`componentes` (renomeado de
 *   `componentesVisiveis`)/`textosLegiveis` (renomeado de
 *   `textosLegiveisNaEmbalagem`)/`possiveisUsos`/`publicoProvavel`
 *   viram arrays de objeto com `origem` — nunca mais array de string
 *   simples;
 * - `quantidadeDeclarada` (novo, `{valor, textoOrigem}`) — substitui
 *   `conteudoDaEmbalagemVisivel`, removido (2/2 vezes que apareceu foi
 *   redundante com `componentesVisiveis`, nunca capturou uma
 *   declaração comercial real);
 * - `atributosAdicionais` (novo, `{nome, valor, origem}[]`) — ainda
 *   sem validação empírica (nenhum produto testado tinha especificação
 *   técnica visível).
 * Deliberadamente SEM nível de confiança por campo (decisão fechada:
 * nos 4 testes, `informacoesNaoConfirmadas` sempre bastou) e SEM
 * mecanismo de evidência dedicado (a auditabilidade vem de `origem` em
 * `textosLegiveis`/`caracteristicasVisiveis` + `textoOrigem` de
 * `quantidadeDeclarada`).
 */

/**
 * De onde vem cada informação — obrigatório em todo item de lista que
 * descreve um atributo observado. "produto" e "embalagem_fisica" nunca
 * podem ser confundidos entre si; "material_promocional" existe
 * especificamente para isolar alegação de marketing (nunca fato
 * confirmado); "indeterminado" é o escape explícito quando não dá pra
 * saber.
 */
export type OrigemAtributo =
  | "produto"
  | "embalagem_fisica"
  | "material_promocional"
  | "indeterminado";

export interface ItemComOrigem {
  valor: string;
  origem: OrigemAtributo;
}

export interface DescricaoComOrigem {
  descricao: string;
  origem: OrigemAtributo;
}

export interface TextoComOrigem {
  texto: string;
  origem: OrigemAtributo;
}

export interface AtributoAdicional {
  nome: string;
  valor: string;
  origem: OrigemAtributo;
}

/**
 * `valor`/`textoOrigem` sempre andam juntos: os dois null (nenhuma
 * declaração textual de quantidade encontrada) ou os dois preenchidos
 * (valor extraído + o trecho exato do texto que o sustenta). Nunca um
 * preenchido sem o outro — validado explicitamente.
 */
export interface QuantidadeDeclarada {
  valor: number | null;
  textoOrigem: string | null;
}

export interface QualidadeDasFotos {
  nota: number; // 0-100
  problemas: string[];
  sugestoes: string[];
}

/** Exatamente o que o Gemini devolve — validado contra este shape após o parse do JSON. */
export interface AnaliseVisualIA {
  produtoIdentificado: string | null;
  marca: string | null;
  modelo: string | null;
  categoriaProvavel: string[] | null;
  resumoVisual: string;
  caracteristicasVisiveis: DescricaoComOrigem[];
  cores: ItemComOrigem[];
  materiais: ItemComOrigem[];
  componentes: ItemComOrigem[];
  textosLegiveis: TextoComOrigem[];
  quantidadeDeclarada: QuantidadeDeclarada;
  possiveisUsos: DescricaoComOrigem[];
  publicoProvavel: DescricaoComOrigem[];
  alertas: string[];
  informacoesNaoConfirmadas: string[];
  qualidadeDasFotos: QualidadeDasFotos;
  atributosAdicionais: AtributoAdicional[];
}

/**
 * Campos de AnaliseVisualIA que servem de fonte de "fato citável" para
 * geracao_conteudo (ver ESTUDIO_ANUNCIOS_IA_GERACAO_CONTEUDO_CONTRATO.md,
 * seção 12). Definido AQUI (não em geracao-conteudo-tipos.ts) por pedido
 * explícito do contrato — CampoOrigem descreve a estrutura de
 * AnaliseVisualIA, não algo de geracao_conteudo, então vive junto de
 * onde AnaliseVisualIA já vive, e é importado pela outra etapa, nunca
 * redigitado como se fosse propriedade dela (mesmo padrão já aplicado a
 * OrigemAtributo/OrigemFatoEntrada).
 *
 * `keyof Pick<...>`, não uma lista de string literal copiada à mão: se
 * AnaliseVisualIA mudar de nome/campo, é este tipo que muda com ela
 * (erro de compilação, não drift silencioso). Exclui modelo,
 * resumoVisual, alertas, informacoesNaoConfirmadas, qualidadeDasFotos —
 * não são campos-fonte de fato citável (ver contrato, seção 12).
 *
 * `publicoProvavel` incluído nesta lista de 12 campos — a versão
 * ilustrativa de 11 campos no texto do contrato (seção 12) omite
 * `publicoProvavel`, o que tornaria o mecanismo de `publicoSugerido`
 * (seção 7 do contrato — publicoProvavel classificado por origem,
 * podendo virar fatoPermitido) inexequível: um fato vindo de
 * publicoProvavel precisa de um CampoOrigem válido pra existir no
 * envelope. Decisão confirmada explicitamente (2026-08-11) — a lista
 * ilustrativa do contrato é reconhecida como desatualizada nesse ponto,
 * não a definição normativa (que é este Pick<>, por decisão da própria
 * seção 12 do contrato: "a implementação normativa é derivada das
 * chaves reais de AnaliseVisualIA... nunca copiada à mão a partir da
 * lista escrita [no contrato]").
 */
export type CampoOrigem = keyof Pick<
  AnaliseVisualIA,
  | "produtoIdentificado"
  | "marca"
  | "categoriaProvavel"
  | "caracteristicasVisiveis"
  | "cores"
  | "materiais"
  | "componentes"
  | "textosLegiveis"
  | "quantidadeDeclarada"
  | "possiveisUsos"
  | "publicoProvavel"
  | "atributosAdicionais"
>;

/** Foto realmente enviada ao Gemini — montado 100% pelo servidor, nunca pelo modelo. */
export interface FotoAnalisada {
  imagemId: string;
  ordem: number;
  principal: boolean;
}

/** Montado 100% pelo servidor, nunca pedido ao Gemini. */
export interface MetadadosAnalise {
  totalFotosProjeto: number;
  totalFotosAnalisadas: number;
  analiseParcial: boolean;
  motivoAnaliseParcial: "limite_quantidade" | "limite_bytes" | null;
}

/** Objeto final persistido em estudio_anuncios_resultados_pipeline.resultado. */
export interface AnaliseVisualCompleta extends AnaliseVisualIA {
  fotosAnalisadas: FotoAnalisada[];
  metadadosAnalise: MetadadosAnalise;
}

export const SCHEMA_VERSAO_ANALISE_VISUAL = 1;

const ORIGENS_VALIDAS = ["produto", "embalagem_fisica", "material_promocional", "indeterminado"] as const;

// Fragmentos reutilizados nas 7 listas que carregam origem — evita
// repetir a mesma forma 7 vezes e garante que todas usam exatamente o
// mesmo enum.
const SCHEMA_ITEM_COM_ORIGEM = {
  type: "object",
  properties: {
    valor: { type: "string" },
    origem: { type: "string", enum: ORIGENS_VALIDAS },
  },
  required: ["valor", "origem"],
  additionalProperties: false,
} as const;

const SCHEMA_DESCRICAO_COM_ORIGEM = {
  type: "object",
  properties: {
    descricao: { type: "string" },
    origem: { type: "string", enum: ORIGENS_VALIDAS },
  },
  required: ["descricao", "origem"],
  additionalProperties: false,
} as const;

const SCHEMA_TEXTO_COM_ORIGEM = {
  type: "object",
  properties: {
    texto: { type: "string" },
    origem: { type: "string", enum: ORIGENS_VALIDAS },
  },
  required: ["texto", "origem"],
  additionalProperties: false,
} as const;

const SCHEMA_ATRIBUTO_ADICIONAL = {
  type: "object",
  properties: {
    nome: { type: "string" },
    valor: { type: "string" },
    origem: { type: "string", enum: ORIGENS_VALIDAS },
  },
  required: ["nome", "valor", "origem"],
  additionalProperties: false,
} as const;

export const ANALISE_VISUAL_JSON_SCHEMA = {
  type: "object",
  properties: {
    produtoIdentificado: { type: ["string", "null"] },
    marca: { type: ["string", "null"] },
    modelo: { type: ["string", "null"] },
    categoriaProvavel: { type: ["array", "null"], items: { type: "string" } },
    resumoVisual: { type: "string" },
    caracteristicasVisiveis: { type: "array", items: SCHEMA_DESCRICAO_COM_ORIGEM },
    cores: { type: "array", items: SCHEMA_ITEM_COM_ORIGEM },
    materiais: { type: "array", items: SCHEMA_ITEM_COM_ORIGEM },
    componentes: { type: "array", items: SCHEMA_ITEM_COM_ORIGEM },
    textosLegiveis: { type: "array", items: SCHEMA_TEXTO_COM_ORIGEM },
    quantidadeDeclarada: {
      type: "object",
      properties: {
        valor: { type: ["integer", "null"] },
        textoOrigem: { type: ["string", "null"] },
      },
      required: ["valor", "textoOrigem"],
      additionalProperties: false,
    },
    possiveisUsos: { type: "array", items: SCHEMA_DESCRICAO_COM_ORIGEM },
    publicoProvavel: { type: "array", items: SCHEMA_DESCRICAO_COM_ORIGEM },
    alertas: { type: "array", items: { type: "string" } },
    informacoesNaoConfirmadas: { type: "array", items: { type: "string" } },
    qualidadeDasFotos: {
      type: "object",
      properties: {
        nota: { type: "integer", minimum: 0, maximum: 100 },
        problemas: { type: "array", items: { type: "string" } },
        sugestoes: { type: "array", items: { type: "string" } },
      },
      required: ["nota", "problemas", "sugestoes"],
      additionalProperties: false,
    },
    atributosAdicionais: { type: "array", items: SCHEMA_ATRIBUTO_ADICIONAL },
  },
  required: [
    "produtoIdentificado", "marca", "modelo", "categoriaProvavel", "resumoVisual",
    "caracteristicasVisiveis", "cores", "materiais", "componentes", "textosLegiveis",
    "quantidadeDeclarada", "possiveisUsos", "publicoProvavel", "alertas",
    "informacoesNaoConfirmadas", "qualidadeDasFotos", "atributosAdicionais",
  ],
  additionalProperties: false,
} as const;
