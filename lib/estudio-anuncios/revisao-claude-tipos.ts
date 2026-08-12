/**
 * Tipos de domínio da etapa `revisao_claude` — independentes de
 * provedor. Mesmo princípio já aplicado a `geracao-conteudo-tipos.ts` e
 * `adaptacao-marketplace-tipos.ts`: o schema JSON específico da Anthropic
 * vive em lib/ai-gateway/provedores/anthropic-revisao-schema.ts, que
 * importa estes tipos — nunca o contrário.
 *
 * PAPEL DA ETAPA: recebe o `EnvelopeGeracaoConteudo` e REVISA o texto.
 * Não cria conteúdo novo, não adapta marketplace, não consulta imagem,
 * não altera fatos.
 *
 * DESENHO CENTRAL — por que o modelo só devolve TEXTO:
 * A revisão pede ao modelo apenas os textos revisados, identificados por
 * uma referência estável (`ref`). Tudo que é FATO — `fatoIds`,
 * `contemRessalva`, `especificacoes`, `publicoSugerido` — é copiado
 * verbatim pelo servidor a partir do conteúdo-base, e nunca é pedido ao
 * modelo. Isso torna as proibições da tarefa (não alterar marca, modelo,
 * medidas, especificações, quantidade, materiais, características
 * técnicas) estruturalmente impossíveis de violar, em vez de depender de
 * uma validação textual que pode falhar. O modelo simplesmente não tem
 * onde escrever um fato.
 */
import type { GeracaoConteudoIA } from "./geracao-conteudo-tipos";

/**
 * Referência estável a um trecho revisável do conteúdo-base. Formato
 * fechado, gerado pelo servidor e validado na volta:
 *   "tituloBase" | "descricaoCurta" | "bullet:N" | "descricaoLonga:N"
 *
 * `especificacoes` e `publicoSugerido` NÃO têm referência — são fato
 * estruturado, ficam fora do alcance da revisão por desenho.
 */
export type RefTextoRevisavel = string;

export interface TextoRevisado {
  ref: RefTextoRevisavel;
  textoRevisado: string;
  /** true = o texto mudou; obriga `motivo`. false = obriga texto idêntico ao original. */
  alterado: boolean;
  /** Justificativa curta da mudança. Obrigatório quando alterado=true, proibido quando false. */
  motivo?: string;
}

/** O que o modelo devolve — só texto e justificativa, nunca fato. */
export interface RevisaoClaudeIA {
  textos: TextoRevisado[];
  /** Comentários gerais do revisor. Nunca vira conteúdo do anúncio. */
  observacoes?: string[];
}

/** Referência embutida ao job/resultado de geracao_conteudo consumido. */
export interface FonteConteudoBase {
  jobId: string;
  resultadoId: string;
  schemaVersao: number;
}

/** Exatamente o que foi apresentado ao revisor nesta chamada. */
export interface EntradaRevisaoClaude {
  /** Só os trechos revisáveis, na forma em que foram enviados. */
  trechos: { ref: RefTextoRevisavel; textoOriginal: string }[];
  /** Restrições apresentadas ao modelo, congeladas junto do resultado. */
  restricoes: string[];
}

/**
 * Envelope persistido em estudio_anuncios_resultados_pipeline.resultado.
 *
 * `conteudoRevisado` é a peça que torna esta etapa um ARTEFATO SUCESSOR
 * legítimo: um `GeracaoConteudoIA` completo, remontado pelo servidor com
 * os textos revisados e todo o resto copiado verbatim. É por isso que
 * `adaptacao_marketplace` pode passar a consumir revisao_claude — o
 * shape é o mesmo que ela já sabe ler (ver migration 20260814).
 */
export interface EnvelopeRevisaoClaude {
  fonteConteudoBase: FonteConteudoBase;
  entrada: EntradaRevisaoClaude;
  saida: RevisaoClaudeIA;
  conteudoRevisado: GeracaoConteudoIA;
}

/**
 * SCHEMA_VERSAO_REVISAO_CLAUDE = 1, constante independente — nunca um
 * contador global compartilhado (Constituição, Seção 10). Versiona o
 * envelope inteiro.
 */
export const SCHEMA_VERSAO_REVISAO_CLAUDE = 1;
