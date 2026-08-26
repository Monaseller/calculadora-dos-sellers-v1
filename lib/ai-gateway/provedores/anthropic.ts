/**
 * Cliente do provedor Anthropic (Claude) — segundo provedor real do
 * módulo, criado em 2026-08-14 para a etapa `revisao_claude`.
 *
 * SDK oficial `@anthropic-ai/sdk`, Messages API
 * (`client.messages.create`). Structured output via
 * `output_config.format` com `json_schema` — o parâmetro `output_format`
 * de nível superior está descontinuado e não é usado aqui.
 *
 * Simetria deliberada com `provedores/google.ts`: mesmas
 * responsabilidades (resolver modelo, chamar, mapear erro), mesmas
 * proibições. O que este arquivo NÃO faz: decidir provedor, montar
 * prompt de domínio, validar conteúdo, persistir, fazer retry.
 *
 * Regras (as mesmas do provedor Google, reafirmadas):
 * - Nunca faz retry aqui dentro — retry é decisão do job
 *   (tentativas/max_tentativas em estudio_anuncios_jobs).
 * - Nunca cai silenciosamente para fake em caso de erro — todo erro
 *   vira ErroProvedorIA classificado.
 * - Nunca loga a API key nem o prompt.
 *
 * `ErroProvedorIA` e `estimarCustoUsd` são importados de
 * lib/ai-gateway/{erros,custos}.ts — neutros em relação a provedor
 * desde a correção estrutural de 2026-08-14 (Constituição §37.2). Este
 * arquivo NUNCA importa nada de `provedores/google.ts`.
 */
import Anthropic from "@anthropic-ai/sdk";
import { ErroProvedorIA } from "../erros";

const TIMEOUT_MS_REVISAO = 120_000;

let clienteCache: Anthropic | null = null;

function obterCliente(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new ErroProvedorIA("auth", "ANTHROPIC_API_KEY ausente — não é possível chamar a Anthropic.");
  }
  if (!clienteCache) {
    // timeout em MILISSEGUNDOS no SDK TypeScript (difere do Python, que
    // usa segundos) — ver documentação de client config.
    clienteCache = new Anthropic({ apiKey, timeout: TIMEOUT_MS_REVISAO, maxRetries: 0 });
  }
  return clienteCache;
}

/**
 * Único ponto do código que lê ANTHROPIC_MODEL_REVISAO — mesmo padrão
 * das três funções equivalentes do provedor Google (trim, erro "auth"
 * explícito se ausente/vazio, nunca fallback para outro modelo).
 * Variável própria por decisão explícita: nenhuma flag ou modelo de
 * outra etapa é reaproveitado.
 */
export function obterModeloRevisao(): string {
  const bruto = process.env.ANTHROPIC_MODEL_REVISAO;
  const modelo = bruto?.trim() ?? "";
  if (!modelo) {
    throw new ErroProvedorIA(
      "auth",
      "ANTHROPIC_MODEL_REVISAO ausente, vazio ou só com espaços — configure essa variável de ambiente antes de usar a Anthropic em revisao_claude."
    );
  }
  return modelo;
}

export interface ResultadoChamadaAnthropic {
  resultadoTexto: string;
  modelo: string;
  tokensEntrada: number;
  tokensSaida: number;
  tempoMs: number;
}

/**
 * Chamada texto-only com structured output. Sem `temperature`/`top_p`/
 * `top_k`: os modelos atuais da Anthropic rejeitam esses parâmetros com
 * 400 — o comportamento é guiado por prompt.
 *
 * `max_tokens` é limite rígido de pensamento + resposta. Como o
 * pensamento adaptativo está ligado por padrão nos modelos atuais, o
 * valor precisa de folga real ou a resposta trunca no meio.
 */
export async function chamarClaudeTexto(params: {
  promptSistema: string;
  promptUsuario: string;
  schema: object;
  modelo: string;
  maxTokens?: number;
  /**
   * Timeout desta chamada, em milissegundos. AGENTES-FASE1E-d.
   *
   * AUSENTE = comportamento historico intacto: vale o timeout do
   * cliente cacheado (TIMEOUT_MS_REVISAO, 120 s). Nenhum chamador
   * existente do Estudio precisou mudar, e nenhum mudou.
   *
   * Existe porque o cliente e cacheado no modulo e seu timeout e fixado
   * na construcao — calibrado para `revisao_claude`. O runtime dos
   * AGENTES tem outro orcamento: o worker aborta o HTTP em 60 s
   * (`AGENTES_WORKER_HTTP_TIMEOUT_MS`, padrao) e o Vercel Hobby corta a
   * funcao serverless em 60 s. Um provedor com teto de 120 s
   * terminaria DEPOIS de quem o espera, deixando a tarefa `executando`
   * segurando o lease.
   *
   * Vai como opcao POR REQUISICAO ao SDK: nao recria o cliente, nao
   * mexe na credencial, nao altera `maxRetries: 0` e nao afeta nenhuma
   * outra chamada em voo.
   */
  timeoutMs?: number;
}): Promise<ResultadoChamadaAnthropic> {
  const cliente = obterCliente();
  const inicio = Date.now();

  try {
    const resposta = await cliente.messages.create(
      {
        model: params.modelo,
        max_tokens: params.maxTokens ?? 16000,
        system: params.promptSistema,
        messages: [{ role: "user", content: params.promptUsuario }],
        output_config: { format: { type: "json_schema", schema: params.schema } },
      } as Anthropic.MessageCreateParamsNonStreaming,
      // `undefined` e exatamente equivalente a omitir o argumento — e o
      // que preserva a retrocompatibilidade sem um segundo caminho de
      // codigo para manter.
      params.timeoutMs === undefined ? undefined : { timeout: params.timeoutMs }
    );

    const tempoMs = Date.now() - inicio;

    // stop_reason precisa ser checado ANTES de ler content: numa recusa
    // o array pode vir vazio, e indexar content[0] quebraria.
    if (resposta.stop_reason === "refusal") {
      throw new ErroProvedorIA(
        "conteudo_rejeitado",
        "Claude recusou a requisição por política de segurança (stop_reason=refusal)."
      );
    }
    if (resposta.stop_reason === "max_tokens") {
      throw new ErroProvedorIA(
        "validation",
        "Resposta truncada por max_tokens — o JSON devolvido está incompleto. Aumente max_tokens."
      );
    }

    const bloco = resposta.content.find(b => b.type === "text");
    if (!bloco || bloco.type !== "text" || !bloco.text) {
      throw new ErroProvedorIA("validation", "Claude não devolveu bloco de texto — resposta vazia ou bloqueada.");
    }

    return {
      resultadoTexto: bloco.text,
      modelo: resposta.model,
      tokensEntrada: resposta.usage?.input_tokens ?? 0,
      tokensSaida: resposta.usage?.output_tokens ?? 0,
      tempoMs,
    };
  } catch (err) {
    if (err instanceof ErroProvedorIA) throw err;
    throw mapearErroAnthropic(err);
  }
}

/**
 * Mapeia erros do SDK da Anthropic para as 6 categorias já existentes em
 * estudio_anuncios_jobs.erro_tipo. Nunca inventa categoria nova.
 *
 * Diferente do provedor Google — onde `instanceof` era impossível porque
 * a hierarquia de erro da Interactions API não é exportada — o SDK da
 * Anthropic **exporta** suas classes de erro tipadas, e a documentação
 * oficial é explícita em preferir `instanceof` a comparação de texto.
 * Ordem da mais específica para a mais genérica, com inspeção estrutural
 * de `status` como rede de segurança para versões de SDK que não
 * exportem alguma classe.
 */
export function mapearErroAnthropic(err: unknown): ErroProvedorIA {
  const mensagemOriginal = ((err as any)?.message ?? String(err)).slice(0, 300);

  if (err instanceof Anthropic.AuthenticationError) return new ErroProvedorIA("auth", mensagemOriginal);
  if (err instanceof Anthropic.PermissionDeniedError) return new ErroProvedorIA("auth", mensagemOriginal);
  if (err instanceof Anthropic.RateLimitError) return new ErroProvedorIA("rate_limit", mensagemOriginal);
  if (err instanceof Anthropic.InternalServerError) return new ErroProvedorIA("transient", mensagemOriginal);
  if (err instanceof Anthropic.APIConnectionError) return new ErroProvedorIA("transient", mensagemOriginal);
  if (err instanceof Anthropic.NotFoundError) return new ErroProvedorIA("validation", mensagemOriginal);
  if (err instanceof Anthropic.BadRequestError) return new ErroProvedorIA("validation", mensagemOriginal);

  // Rede de segurança estrutural (mesma técnica do provedor Google):
  // vale se alguma classe não estiver exportada nesta versão do SDK.
  const statusBruto = (err as any)?.status ?? (err as any)?.statusCode;
  const status = typeof statusBruto === "number" ? statusBruto : undefined;
  if (status !== undefined) {
    const mensagem = `HTTP ${status}: ${mensagemOriginal}`;
    if (status === 401 || status === 403) return new ErroProvedorIA("auth", mensagem);
    if (status === 429) return new ErroProvedorIA("rate_limit", mensagem);
    if (status >= 500) return new ErroProvedorIA("transient", mensagem);
    if (status === 400 || status === 404 || status === 413 || status === 422) {
      return new ErroProvedorIA("validation", mensagem);
    }
    return new ErroProvedorIA("unknown", mensagem);
  }

  if (/timeout|timed out|aborted|connection error/i.test(mensagemOriginal)) {
    return new ErroProvedorIA("transient", mensagemOriginal);
  }
  return new ErroProvedorIA("unknown", mensagemOriginal);
}
