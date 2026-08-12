/**
 * Cliente do provedor Google para GERAÇÃO DE IMAGEM — etapa
 * `geracao_imagem` (2026-08-16). Arquivo separado de
 * `provedores/google.ts` de propósito: aquele é o cliente de TEXTO
 * (analise_visual, geracao_conteudo, adaptacao_marketplace,
 * geracao_prompts_imagem) e nenhuma das suas funções serve aqui — a
 * saída não é `output_text`, o timeout é de outra ordem de grandeza e a
 * unidade de custo é diferente. Reusa `obterClienteGoogle()` e
 * `mapearErroGoogle()` daquele arquivo (100% genéricos), então
 * `GOOGLE_AI_API_KEY` continua com um único leitor.
 *
 * ESCOLHA DO PROVEDOR (decidida com o usuário em 2026-08-16, depois de
 * listar os 58 modelos REALMENTE disponíveis para a chave do projeto —
 * nada aqui é nome de modelo inventado):
 *
 *   Gemini image ("Nano Banana")   vs   Imagen 4
 *   - IDs reais confirmados: `gemini-3.1-flash-image`,
 *     `gemini-3-pro-image`, `gemini-2.5-flash-image` (ação
 *     `generateContent`) contra `imagen-4.0-generate-001` e variantes
 *     (ação `predict`, via `models.generateImages`).
 *   - **Imagem de referência é o critério decisivo.** A família Gemini
 *     aceita imagem na entrada, então as fotos REAIS do produto entram
 *     como referência visual. Imagen 4 nesta chave é só texto→imagem: o
 *     modelo de referência (`imagen-3.0-capability-001`, usado por
 *     `models.editImage`) **não está disponível**. Sem referência, o
 *     produto gerado seria uma interpretação do texto, não o produto do
 *     usuário — e a Constituição proíbe fingir que prompt textual
 *     sozinho preserva identidade física.
 *   - Bônus: usa a mesma Interactions API que o projeto já usa.
 *
 * Regras de segurança (não violar):
 * - `store: false` em toda chamada — não reter fotos do produto do
 *   usuário no servidor do Google além do necessário.
 * - Nunca loga bytes/base64 (nem de referência, nem de saída), nunca
 *   loga a API key.
 * - Nunca faz retry aqui dentro — decisão do job.
 * - Nunca cai silenciosamente para fake nem para outro modelo.
 */
import { ErroProvedorIA } from "../erros";
import { obterClienteGoogle, mapearErroGoogle } from "./google";

/**
 * Timeout POR IMAGEM. Deliberadamente não reaproveita os 30s das
 * chamadas de texto: geração de imagem é outra ordem de grandeza de
 * latência, e um timeout curto aqui produziria falso negativo caro (o
 * provedor cobra a imagem que já gerou). Configurável por
 * `GOOGLE_AI_IMAGEM_TIMEOUT_MS`, com teto de 5 min — nunca infinito.
 *
 * ATENÇÃO OPERACIONAL: um job gera N imagens em SEQUÊNCIA, então o pior
 * caso do job é N × este timeout. `ESTUDIO_ANUNCIOS_WORKER_HTTP_TIMEOUT_MS`
 * precisa continuar maior que isso, senão o Worker desiste de esperar
 * enquanto a rota ainda está persistindo (falso negativo já documentado
 * no cabeçalho do worker).
 */
const TIMEOUT_IMAGEM_PADRAO_MS = 90_000;
const TIMEOUT_IMAGEM_TETO_MS = 300_000;

export function obterTimeoutImagemMs(): number {
  const bruto = process.env.GOOGLE_AI_IMAGEM_TIMEOUT_MS?.trim();
  if (!bruto) return TIMEOUT_IMAGEM_PADRAO_MS;
  const valor = Number(bruto);
  if (!Number.isInteger(valor) || valor <= 0 || valor > TIMEOUT_IMAGEM_TETO_MS) {
    throw new ErroProvedorIA(
      "auth",
      `GOOGLE_AI_IMAGEM_TIMEOUT_MS inválido ("${bruto}") — inteiro positivo até ${TIMEOUT_IMAGEM_TETO_MS}.`
    );
  }
  return valor;
}

/**
 * Único ponto do código que lê GOOGLE_AI_MODEL_IMAGEM — mesma invariante
 * "uma variável por etapa, um único leitor" das quatro anteriores.
 * NUNCA reaproveita GOOGLE_AI_MODEL_VISUAL, GOOGLE_AI_MODEL_CONTEUDO,
 * GOOGLE_AI_MODEL_ADAPTACAO_MARKETPLACE nem
 * GOOGLE_AI_MODEL_PROMPTS_IMAGEM: os quatro são modelos de TEXTO e
 * apontar um deles aqui produziria erro obscuro no provedor em vez de
 * erro de configuração explícito.
 */
export function obterModeloImagem(): string {
  const bruto = process.env.GOOGLE_AI_MODEL_IMAGEM;
  const modelo = bruto?.trim() ?? "";
  if (!modelo) {
    throw new ErroProvedorIA(
      "auth",
      "GOOGLE_AI_MODEL_IMAGEM ausente, vazio ou só com espaços — configure essa variável antes de habilitar GOOGLE_AI_IMAGEM_ENABLED."
    );
  }
  return modelo;
}

export interface ReferenciaVisual {
  buffer: Uint8Array;
  mimeType: string;
}

export interface ResultadoChamadaImagemGoogle {
  bytes: Uint8Array;
  mimeTypeDeclarado: string | null;
  modelo: string;
  tokensEntrada: number;
  /** Total de saida, todas as modalidades - e o que a API reporta e o que o banco persiste. */
  tokensSaida: number;
  /**
   * Subconjunto de `tokensSaida` cobrado como IMAGEM. Vem de
   * `usage.output_tokens_by_modality`, reportado pela propria API -
   * nunca estimado a partir da contagem de imagens, porque a contagem
   * por imagem muda com a resolucao. Confirmado em chamada real
   * (2026-08-18): 1120 tokens para uma imagem 1024x1024, exatamente o
   * numero da documentacao oficial.
   */
  tokensSaidaImagem: number;
  tempoMs: number;
}

/** Le a fatia de saida da modalidade `image`. Ausente = 0, nunca um palpite. */
function extrairTokensDeImagem(usage: unknown): number {
  const lista = (usage as { output_tokens_by_modality?: Array<{ modality?: string; tokens?: number }> })
    ?.output_tokens_by_modality;
  if (!Array.isArray(lista)) return 0;
  return lista
    .filter(m => m?.modality === "image")
    .reduce((total, m) => total + (typeof m.tokens === "number" ? m.tokens : 0), 0);
}

/**
 * Gera UMA imagem. Nunca gera lote: a etapa percorre os prompts em
 * sequência e persiste cada imagem antes de pedir a próxima, para que
 * uma falha na imagem 3 não perca as imagens 1 e 2 (recuperação parcial
 * é requisito da tarefa, não otimização).
 *
 * `referencias` são as fotos ORIGINAIS do produto, já baixadas do bucket
 * privado pelo chamador via service role. Entram antes do texto, para o
 * modelo tratá-las como o assunto a preservar.
 *
 * O MIME devolvido aqui é o DECLARADO pelo provedor — o chamador
 * reconfere por magic bytes antes de persistir, nunca confia nele.
 */
export async function gerarImagemGoogle(params: {
  promptTexto: string;
  negativePrompt?: string;
  referencias: ReferenciaVisual[];
  aspectRatio: string;
  modelo: string;
}): Promise<ResultadoChamadaImagemGoogle> {
  const cliente = obterClienteGoogle();
  const inicio = Date.now();

  // O negative prompt não tem campo próprio nesta API: entra como
  // instrução textual explícita, no mesmo bloco de texto. Nunca é
  // silenciosamente descartado.
  const texto = params.negativePrompt
    ? `${params.promptTexto}\n\nNÃO INCLUA, em hipótese alguma: ${params.negativePrompt}.`
    : params.promptTexto;

  const input = [
    ...params.referencias.map(r => ({
      type: "image" as const,
      data: Buffer.from(r.buffer).toString("base64"),
      mime_type: r.mimeType,
    })),
    { type: "text" as const, text: texto },
  ];

  try {
    const interaction = await cliente.interactions.create(
      {
        model: params.modelo,
        input,
        response_modalities: ["image"],
        generation_config: { image_config: { aspect_ratio: params.aspectRatio } },
        store: false,
      } as never,
      { timeout: obterTimeoutImagemMs() }
    );

    const tempoMs = Date.now() - inicio;
    const saida = (interaction as { output_image?: { data?: string; mime_type?: string } }).output_image;

    if (!saida?.data) {
      // Sem imagem na resposta: quase sempre filtro de segurança do
      // provedor. Classificado como conteudo_rejeitado, nunca como
      // sucesso vazio nem como erro genérico.
      throw new ErroProvedorIA(
        "conteudo_rejeitado",
        "Gemini não devolveu output_image — resposta vazia ou bloqueada por filtro de conteúdo."
      );
    }

    return {
      bytes: new Uint8Array(Buffer.from(saida.data, "base64")),
      mimeTypeDeclarado: saida.mime_type ?? null,
      modelo: params.modelo,
      tokensEntrada: interaction.usage?.total_input_tokens ?? 0,
      tokensSaida: interaction.usage?.total_output_tokens ?? 0,
      tokensSaidaImagem: extrairTokensDeImagem(interaction.usage),
      tempoMs,
    };
  } catch (err) {
    if (err instanceof ErroProvedorIA) throw err;
    throw mapearErroGoogle(err);
  }
}
