/**
 * Tipos de domínio da etapa `adaptacao_marketplace` — independentes de
 * provedor (nenhum tipo aqui depende do SDK do Google/Gemini). Mesmo
 * princípio já aplicado a `geracao-conteudo-tipos.ts`: o schema JSON
 * específico do Google vive em
 * lib/ai-gateway/provedores/google-adaptacao-marketplace-schema.ts, que
 * importa estes tipos — nunca o contrário.
 *
 * PAPEL DA ETAPA (não é uma nova análise do produto): recebe o
 * conteúdo-base já validado de `geracao_conteudo` e produz uma versão
 * adaptada de FORMATO para cada marketplace do projeto. Ela não
 * pesquisa, não olha fotos, não chama Storage, não reinterpreta
 * `analise_visual`, não cria fatos, não gera imagens e não calcula
 * score.
 *
 * CARDINALIDADE (decisão aprovada, 2026-08-13): 1 job de
 * adaptacao_marketplace -> N marketplaces do projeto -> 1 envelope
 * estruturado contendo todas as adaptações. Isso respeita o
 * UNIQUE(job_id) de estudio_anuncios_resultados_pipeline sem tocar no
 * Pipeline nem criar job por marketplace.
 */
import type { GeracaoConteudoIA } from "./geracao-conteudo-tipos";

/**
 * Marketplaces aceitos. Espelha EXATAMENTE o CHECK de
 * estudio_anuncios_projetos_marketplace.marketplace no banco
 * (verificado por information_schema em 2026-08-13):
 * ARRAY['ML','Shopee','Amazon','TikTok Shop']. Nunca inventar um valor
 * novo aqui sem migration correspondente — o banco rejeitaria.
 */
export const MARKETPLACES_SUPORTADOS = ["ML", "Shopee", "Amazon", "TikTok Shop"] as const;

export type MarketplaceSuportado = (typeof MARKETPLACES_SUPORTADOS)[number];

export function isMarketplaceSuportado(valor: unknown): valor is MarketplaceSuportado {
  return typeof valor === "string" && (MARKETPLACES_SUPORTADOS as readonly string[]).includes(valor);
}

/**
 * CTA — lista controlada 100% server-side. A IA NUNCA cria CTA livre:
 * ela escolhe um índice desta lista ou omite o campo. Qualquer valor
 * fora dela é rejeitado pela validação determinística
 * (validarIntegridadeAdaptacao), nunca "corrigido" silenciosamente.
 *
 * Mantida deliberadamente curta e neutra: nenhuma promessa, nenhuma
 * urgência artificial, nenhuma menção a preço/promoção/prazo — nada que
 * a etapa não tenha como sustentar a partir do conteúdo-base.
 */
export const CTAS_PERMITIDOS = [
  "Confira os detalhes",
  "Veja mais informações",
  "Conheça o produto",
] as const;

export type CtaPermitido = (typeof CTAS_PERMITIDOS)[number];

/**
 * Especificação adaptada. Diferente de `EspecificacaoGerada` de
 * geracao_conteudo, aqui NÃO existe `fatoId`: a rastreabilidade desta
 * etapa é para o conteúdo-base, não para os fatos originais — e o
 * conteúdo-base já foi validado contra os fatos na etapa anterior.
 *
 * `nome` e `valor` precisam existir tal e qual no conteúdo-base
 * (comparação normalizada em validarIntegridadeAdaptacao) — esta etapa
 * pode reordenar, remover ou renomear a APRESENTAÇÃO, nunca alterar o
 * valor de uma especificação.
 */
export interface EspecificacaoAdaptada {
  nome: string;
  valor: string;
}

/** Conteúdo adaptado para UM marketplace. */
export interface AdaptacaoDeMarketplace {
  marketplace: MarketplaceSuportado;
  titulo: string;
  bullets?: string[];
  descricao: string;
  especificacoes?: EspecificacaoAdaptada[];
  /** Só um valor de CTAS_PERMITIDOS, ou ausente. Nunca texto livre. */
  cta?: CtaPermitido;
}

/**
 * Saída da IA. Só isto é gerado pelo modelo — `fonteGeracaoConteudo` e
 * `entrada` (ver envelope abaixo) são montados pelo servidor.
 */
export interface AdaptacaoMarketplaceIA {
  adaptacoes: AdaptacaoDeMarketplace[];
}

/**
 * Referência embutida ao job/resultado de `geracao_conteudo` consumido —
 * mesma disciplina de `FonteAnaliseVisual`: copiada no momento da
 * geração, nunca recalculada depois. Mais confiável para auditoria do
 * que só `job_origem_id`, que vive na tabela de jobs e não no resultado
 * imutável.
 */
export interface FonteGeracaoConteudo {
  jobId: string;
  resultadoId: string;
  schemaVersao: number;
}

/**
 * Exatamente o que foi apresentado à IA nesta chamada, persistido junto
 * do resultado. Mesmo princípio de `EntradaSeguraGeracaoConteudo`:
 * congela a entrada real para que auditoria futura não precise
 * recalcular nada.
 *
 * `conteudoBase` é a SAÍDA de geracao_conteudo (GeracaoConteudoIA) — não
 * o envelope inteiro. A entrada segura de geracao_conteudo
 * (fatosPermitidos, descricoesComRessalva, informacoesProibidas) NÃO é
 * reenviada: esta etapa não cita fatos, ela reformata texto já
 * validado. Enviar aquilo seria mandar dado desnecessário à IA.
 *
 * Nota: evitar a sequência de dois caracteres "asterisco+barra" em
 * comentário — ela fecha o bloco prematuramente e quebra o parser
 * (bug real já registrado em PROJECT_STATE.md, Seção 9, item 7).
 */
export interface EntradaAdaptacaoMarketplace {
  conteudoBase: GeracaoConteudoIA;
  marketplacesAlvo: MarketplaceSuportado[];
  /** Cópia literal de CTAS_PERMITIDOS vigente nesta chamada — congela a lista usada, caso ela mude depois. */
  ctasPermitidos: string[];
  /** Restrições apresentadas ao modelo, congeladas junto do resultado. */
  restricoes: string[];
}

/** Envelope efetivamente persistido em estudio_anuncios_resultados_pipeline.resultado. */
export interface EnvelopeAdaptacaoMarketplace {
  fonteGeracaoConteudo: FonteGeracaoConteudo;
  entrada: EntradaAdaptacaoMarketplace;
  saida: AdaptacaoMarketplaceIA;
}

/**
 * SCHEMA_VERSAO_ADAPTACAO_MARKETPLACE = 1, constante independente —
 * nunca um contador global compartilhado com as outras etapas
 * (Constituição, Seção 10). Versiona o ENVELOPE INTEIRO
 * (entrada+saida), não só `saida`.
 */
export const SCHEMA_VERSAO_ADAPTACAO_MARKETPLACE = 1;
