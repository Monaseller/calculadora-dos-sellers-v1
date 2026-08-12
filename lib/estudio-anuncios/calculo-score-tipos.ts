/**
 * Tipos de domínio da etapa `calculo_score` — última etapa da Fase 1.
 *
 * PRINCÍPIO CENTRAL: o score **não é uma nota opaca de IA**. Nenhuma
 * chamada externa acontece nesta etapa. Cada ponto sai de um critério
 * nomeado, com código estável, avaliado por função pura contra artefatos
 * que realmente existem. A nota é reproduzível (mesmas fontes → mesmo
 * número), explicável (todo critério carrega `explicacao`), auditável
 * (todo bloco expõe seus critérios) e versionada.
 *
 * O QUE O SCORE RESPONDE: "quão completo, consistente e pronto para
 * publicação está este anúncio, considerando dados, conteúdo e imagens?"
 *
 * O QUE ELE NÃO RESPONDE, por decisão explícita: se o produto vai
 * vender, CTR, conversão. Nenhum sinal de Ads e nenhum histórico de
 * vendas entra aqui. (A tabela legada `estudio_anuncios_score` tem uma
 * coluna `conversao_estimada` — ver nota sobre ela no cabeçalho de
 * `calculo-score.ts`.)
 */

/**
 * Identificador da REGRA que produziu o score. Vai para
 * `resultados_pipeline.modelo`, que é NOT NULL.
 *
 * Não é um nome de modelo de IA disfarçado: é o nome da versão do
 * conjunto de pesos e critérios. Inventar aqui uma string tipo "fake-v1"
 * ou "internal-model" seria mentir sobre o que produziu o número —
 * quem leu a linha precisa conseguir reencontrar exatamente estas regras.
 * Muda junto com VERSAO_REGRAS_SCORE.
 */
export const VERSAO_REGRAS_SCORE = "regras-score-v1";

/**
 * Versão do ENVELOPE persistido. Independente de VERSAO_REGRAS_SCORE:
 * o shape pode continuar igual enquanto os pesos mudam, e vice-versa.
 * Mudança incompatível em qualquer um dos dois exige bump do respectivo.
 */
export const SCHEMA_VERSAO_CALCULO_SCORE = 1;

/**
 * PESOS — fonte única, server-side, versionada junto com o código.
 * Deliberadamente **não** em variável de ambiente: peso é regra de
 * negócio, não configuração operacional. Se um dia houver peso por
 * usuário/plano, a migração é consciente, não um `process.env` de
 * conveniência.
 *
 * Cada peso foi derivado do que hoje é MENSURÁVEL com os artefatos que
 * existem de verdade — não de uma tabela aspiracional. A soma é validada
 * em tempo de boot (ver `calculo-score.ts`) e por teste.
 */
export const PESOS_BLOCOS = {
  analise_visual: 10,
  completude_produto: 15,
  conteudo: 20,
  integridade_factual: 15,
  adaptacao_marketplace: 10,
  prompts_imagem: 10,
  imagens: 15,
  consistencia_geral: 5,
} as const;

export type CodigoBloco = keyof typeof PESOS_BLOCOS;

export const NOMES_BLOCOS: Record<CodigoBloco, string> = {
  analise_visual: "Análise visual",
  completude_produto: "Completude do produto",
  conteudo: "Conteúdo",
  integridade_factual: "Integridade factual",
  adaptacao_marketplace: "Adaptação por marketplace",
  prompts_imagem: "Prompts de imagem",
  imagens: "Imagens",
  consistencia_geral: "Consistência geral",
};

/**
 * Faixas de classificação — server-side e versionadas, para que nenhum
 * consumidor (UI, relatório, export) invente o próprio corte. Custa
 * pouco e evita três definições divergentes de "bom" no futuro.
 */
export const FAIXAS_CLASSIFICACAO = [
  { minimo: 90, classificacao: "excelente" },
  { minimo: 75, classificacao: "bom" },
  { minimo: 60, classificacao: "atencao" },
  { minimo: 0, classificacao: "insuficiente" },
] as const;

export type ClassificacaoScore = (typeof FAIXAS_CLASSIFICACAO)[number]["classificacao"];

/** `ok` = ponto cheio; `parcial` = parte dos pontos; `falha` = zero; `nao_aplicavel` = fora do denominador. */
export type StatusCriterio = "ok" | "parcial" | "falha" | "nao_aplicavel";

/**
 * Um critério avaliado. `pontosPossiveis` é o peso RELATIVO dentro do
 * bloco (não pontos finais) — a conversão para a escala do bloco é feita
 * uma única vez, em `consolidarBloco()`, para que nenhum critério precise
 * conhecer o peso do bloco em que vive.
 *
 * `nao_aplicavel` sai do denominador em vez de virar zero: é a diferença
 * entre "o anúncio falhou nisso" e "isso não se aplica a este produto" —
 * distinção que a tarefa exige explicitamente (ex.: marca ausente num
 * produto genuinamente sem marca visível).
 */
export interface CriterioScore {
  codigo: string;
  pontosPossiveis: number;
  pontosObtidos: number;
  status: StatusCriterio;
  explicacao: string;
}

export interface BlocoScore {
  codigo: CodigoBloco;
  nome: string;
  pesoMaximo: number;
  /** Pontos já na escala do bloco (0..pesoMaximo), arredondados só no total. */
  pontos: number;
  /** 0..100 dentro do próprio bloco. `null` quando todos os critérios são não-aplicáveis. */
  percentual: number | null;
  criterios: CriterioScore[];
}

/** Job/resultado de cada artefato consumido — rastreabilidade completa da nota. */
export interface FontesScore {
  analiseVisualJobId: string;
  geracaoConteudoJobId: string;
  /** `null` quando a revisão rodou pelo caminho fake e não produziu artefato — estado legítimo, nunca penalizado. */
  revisaoClaudeJobId: string | null;
  adaptacaoMarketplaceJobId: string;
  geracaoPromptsImagemJobId: string;
  geracaoImagemJobId: string;
}

/**
 * Envelope persistido em `estudio_anuncios_resultados_pipeline.resultado`.
 *
 * NÃO tem campo `penalidades`, e a ausência é decisão: os blocos já
 * expressam perda de pontos: um mecanismo paralelo de penalidade seria
 * exatamente o convite à dupla punição que a tarefa manda evitar. Se
 * algum dia existir um efeito **sistêmico** que nenhum bloco captura, aí
 * o campo entra — com código único e bump de versão.
 */
export interface EnvelopeCalculoScore {
  scoreTotal: number;
  classificacao: ClassificacaoScore;
  versaoRegrasScore: string;
  blocos: BlocoScore[];
  /** Observações que NÃO alteram a nota (ex.: revisão rodou fake). Informativo, nunca punitivo. */
  alertas: string[];
  fontes: FontesScore;
  /** Timestamp server-side, gerado no cálculo — nunca vindo do cliente. */
  calculadoEm: string;
}
