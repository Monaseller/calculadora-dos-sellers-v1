/**
 * Cliente do provedor Google (Gemini). Criado em 2026-08-09 para a
 * etapa analise_visual (chamarGeminiComImagens) e estendido em
 * 2026-08-11 para geracao_conteudo (chamarGeminiTexto) — duas funções
 * paralelas, nunca uma com parâmetro opcional; ver o comentário de
 * chamarGeminiTexto() para o motivo.
 *
 * SDK oficial `@google/genai` (v2.15.0), usando a Interactions API
 * (`client.interactions.create`), recomendada pela documentação
 * oficial atual do Google para todo projeto novo — não a antiga
 * `generateContent`. Tipos confirmados por inspeção direta de
 * node_modules/@google/genai/dist/genai.d.ts (não documentados com
 * exemplo copiável no ponto de "usage"/timeout): `Interaction.usage`
 * é do tipo `Usage` com `total_input_tokens`/`total_output_tokens`/
 * `total_tokens`; `interactions.create(params, options)` aceita
 * `options.timeout` (ms) nativamente — sem precisar de
 * AbortController manual.
 *
 * Regras de segurança/privacidade (não violar):
 * - `store: false` em toda chamada — a Interactions API por padrão
 *   guarda a interação no servidor do Google por até 55 dias; como
 *   não usamos conversa multi-turno aqui, desligamos isso
 *   explicitamente para não reter fotos do produto do usuário além
 *   do necessário.
 * - Nunca loga bytes/base64 de imagem, nunca loga a API key.
 * - Nunca faz retry aqui dentro — decisão do job (tentativas/
 *   max_tentativas em estudio_anuncios_jobs), mesma regra do resto do
 *   Gateway.
 * - Nunca cai silenciosamente para fake em caso de erro — todo erro
 *   vira ErroProvedorIA classificado, que o executor mapeia para o
 *   fluxo de falha normal do job.
 */
import { GoogleGenAI } from "@google/genai";
import { ErroProvedorIA } from "../erros";
import { estimarCustoUsd } from "../custos";

// CORREÇÃO ESTRUTURAL (2026-08-14, Constituição §37.2): `ErroProvedorIA`
// e `estimarCustoUsd` saíram deste arquivo e passaram a viver em
// lib/ai-gateway/erros.ts e lib/ai-gateway/custos.ts — ambos neutros em
// relação a provedor. Motivo: 8 arquivos (incluindo o executor central e
// o domínio de 3 etapas) importavam a classe de erro daqui, e a tabela
// de preços só tinha modelos Gemini — introduzir a Anthropic sobre isso
// significaria o provedor novo importar do arquivo do Google e ter custo
// contabilizado como zero em silêncio.
//
// Os dois símbolos são REEXPORTADOS abaixo para não quebrar nenhum
// importador existente. Código novo deve importar de erros.ts/custos.ts.
export { ErroProvedorIA, estimarCustoUsd };

const TIMEOUT_MS = 30_000;

let clienteCache: GoogleGenAI | null = null;

/**
 * Exportado em 2026-08-16 para o cliente de IMAGEM
 * (provedores/google-imagem.ts) reusar exatamente o mesmo cliente e o
 * mesmo tratamento de `GOOGLE_AI_API_KEY` — sem duplicar a leitura da
 * credencial nem criar um segundo cache de cliente. Continua sendo o
 * único ponto do código que lê `GOOGLE_AI_API_KEY`.
 */
export function obterClienteGoogle(): GoogleGenAI {
  return obterCliente();
}

function obterCliente(): GoogleGenAI {
  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) {
    throw new ErroProvedorIA("auth", "GOOGLE_AI_API_KEY ausente — não é possível chamar o Gemini.");
  }
  if (!clienteCache) {
    clienteCache = new GoogleGenAI({ apiKey });
  }
  return clienteCache;
}

/**
 * Único ponto do código que lê GOOGLE_AI_MODEL_VISUAL (ajuste de
 * arquitetura, 2026-08-09) — nenhum outro módulo lê essa variável
 * diretamente; todos recebem o modelo já resolvido por esta função,
 * propagado a partir do retorno de chamarGeminiComImagens() (evita
 * divergência entre o modelo enviado ao Google, o usado no cálculo de
 * custo e o persistido no banco).
 *
 * Normaliza só com trim() — nunca altera caixa, nunca substitui nome,
 * nunca mapeia para outro modelo. Ausente, vazio ou só espaços →
 * erro explícito classificado como "auth" (categoria mais próxima
 * disponível em TipoErroIA para uma falha de configuração/pré-
 * requisito de autenticação — mesma classificação já usada para
 * GOOGLE_AI_API_KEY ausente; não existe uma categoria "config"
 * separada no CHECK de estudio_anuncios_jobs.erro_tipo). Nunca cai em
 * fallback silencioso para outro modelo.
 */
export function obterModeloVisual(): string {
  const bruto = process.env.GOOGLE_AI_MODEL_VISUAL;
  const modelo = bruto?.trim() ?? "";
  if (!modelo) {
    throw new ErroProvedorIA(
      "auth",
      "GOOGLE_AI_MODEL_VISUAL ausente, vazio ou só com espaços — configure essa variável de ambiente antes de habilitar GOOGLE_AI_ENABLED."
    );
  }
  return modelo;
}

/**
 * Único ponto do código que lê GOOGLE_AI_MODEL_CONTEUDO — mesmo padrão
 * de obterModeloVisual() (trim, erro explícito classificado como
 * "auth" se ausente/vazio/só espaços, nunca fallback para outro
 * modelo, muito menos para GOOGLE_AI_MODEL_VISUAL). Variável própria
 * por decisão explícita (ESTUDIO_ANUNCIOS_IA_GERACAO_CONTEUDO_
 * PREPARACAO_IMPLEMENTACAO.md, seção 1.1, pergunta 3): reaproveitar
 * GOOGLE_AI_MODEL_VISUAL quebraria a invariante já documentada em
 * obterModeloVisual() de que só ela lê essa variável.
 */
export function obterModeloConteudo(): string {
  const bruto = process.env.GOOGLE_AI_MODEL_CONTEUDO;
  const modelo = bruto?.trim() ?? "";
  if (!modelo) {
    throw new ErroProvedorIA(
      "auth",
      "GOOGLE_AI_MODEL_CONTEUDO ausente, vazio ou só com espaços — configure essa variável de ambiente antes de usar o Gemini em geracao_conteudo."
    );
  }
  return modelo;
}

/**
 * Único ponto do código que lê GOOGLE_AI_MODEL_ADAPTACAO_MARKETPLACE —
 * mesmo padrão de obterModeloVisual()/obterModeloConteudo(). Variável
 * própria por decisão explícita: reaproveitar GOOGLE_AI_MODEL_CONTEUDO
 * quebraria a invariante "uma variável por etapa, um único leitor" e
 * impediria trocar o modelo de uma etapa sem afetar a outra — mesmo que
 * o valor inicial das duas seja idêntico. Nunca cai em fallback para
 * outro modelo.
 */
export function obterModeloAdaptacaoMarketplace(): string {
  const bruto = process.env.GOOGLE_AI_MODEL_ADAPTACAO_MARKETPLACE;
  const modelo = bruto?.trim() ?? "";
  if (!modelo) {
    throw new ErroProvedorIA(
      "auth",
      "GOOGLE_AI_MODEL_ADAPTACAO_MARKETPLACE ausente, vazio ou só com espaços — configure essa variável de ambiente antes de usar o Gemini em adaptacao_marketplace."
    );
  }
  return modelo;
}

/**
 * Único ponto do código que lê GOOGLE_AI_MODEL_PROMPTS_IMAGEM — mesmo
 * padrão das três anteriores. Variável própria por decisão explícita:
 * reaproveitar GOOGLE_AI_MODEL_CONTEUDO ou
 * GOOGLE_AI_MODEL_ADAPTACAO_MARKETPLACE quebraria a invariante "uma
 * variável por etapa, um único leitor", mesmo que o valor inicial das
 * três seja idêntico. Nunca cai em fallback para outro modelo.
 *
 * Note que geracao_prompts_imagem é geração de TEXTO (planejamento de
 * prompts), não de imagem — por isso usa chamarGeminiTexto() e um modelo
 * de texto, nunca um modelo de imagem.
 */
export function obterModeloPromptsImagem(): string {
  const bruto = process.env.GOOGLE_AI_MODEL_PROMPTS_IMAGEM;
  const modelo = bruto?.trim() ?? "";
  if (!modelo) {
    throw new ErroProvedorIA(
      "auth",
      "GOOGLE_AI_MODEL_PROMPTS_IMAGEM ausente, vazio ou só com espaços — configure essa variável de ambiente antes de usar o Gemini em geracao_prompts_imagem."
    );
  }
  return modelo;
}

export interface ImagemParaAnalise {
  buffer: Uint8Array;
  mimeType: string;
}

export interface ResultadoChamadaGoogle {
  resultadoTexto: string;
  modelo: string;
  tokensEntrada: number;
  tokensSaida: number;
  tempoMs: number;
}

/**
 * Chama o Gemini com as imagens inline (nunca File API nesta versão —
 * ver proposta técnica aprovada: até 3 fotos / 12MB, sempre bem abaixo
 * do limite de 20MB de payload inline da API). `schema` é o JSON
 * Schema de `response_format` — o chamador decide o contrato.
 */
export async function chamarGeminiComImagens(params: {
  promptTexto: string;
  imagens: ImagemParaAnalise[];
  schema: object;
}): Promise<ResultadoChamadaGoogle> {
  const cliente = obterCliente();
  const modelo = obterModeloVisual();
  const inicio = Date.now();

  const input = [
    { type: "text" as const, text: params.promptTexto },
    ...params.imagens.map(img => ({
      type: "image" as const,
      data: Buffer.from(img.buffer).toString("base64"),
      mime_type: img.mimeType,
    })),
  ];

  try {
    const interaction = await cliente.interactions.create(
      {
        model: modelo,
        input,
        response_format: { type: "text", mime_type: "application/json", schema: params.schema },
        store: false,
      },
      { timeout: TIMEOUT_MS }
    );

    const tempoMs = Date.now() - inicio;

    if (!interaction.output_text) {
      throw new ErroProvedorIA("validation", "Gemini não devolveu output_text — resposta vazia ou bloqueada.");
    }

    return {
      resultadoTexto: interaction.output_text,
      modelo,
      tokensEntrada: interaction.usage?.total_input_tokens ?? 0,
      tokensSaida: interaction.usage?.total_output_tokens ?? 0,
      tempoMs,
    };
  } catch (err) {
    if (err instanceof ErroProvedorIA) throw err;
    throw mapearErroGoogle(err);
  }
}

// Constante própria para a chamada de texto — NÃO reaproveita a
// TIMEOUT_MS de chamarGeminiComImagens(), que foi calibrada para
// chamada multimodal (imagem+texto). Mesmo valor numérico hoje (sem
// evidência real ainda pra calibrar diferente), mas declarada à parte
// por decisão consciente (ESTUDIO_ANUNCIOS_IA_GERACAO_CONTEUDO_
// PREPARACAO_IMPLEMENTACAO.md, seção 1.1, pergunta 2) — as duas podem
// divergir no futuro sem uma alterar a outra sem querer.
const TIMEOUT_MS_TEXTO = 30_000;

/**
 * Chama o Gemini só com texto (sem imagens) — usada por geracao_conteudo.
 * Função nova e paralela a chamarGeminiComImagens(), não uma ramificação
 * dela: geracao_conteudo não envia imagens (a entrada é o resultado já
 * estruturado de analise_visual, texto puro), e forçar essa função a
 * aceitar imagens opcionais seria acoplamento, não reuso (ESTUDIO_
 * ANUNCIOS_IA_GERACAO_CONTEUDO_PREPARACAO_IMPLEMENTACAO.md, seção 1.1,
 * pergunta 1). Reaproveita obterCliente()/mapearErroGoogle() (100%
 * genéricos, sem nenhuma dependência de analise_visual) e usa
 * obterModeloConteudo() (nunca obterModeloVisual()).
 */
export async function chamarGeminiTexto(params: {
  promptTexto: string;
  schema: object;
  /**
   * Modelo já resolvido pelo chamador. Existe para que uma segunda etapa
   * texto-only (adaptacao_marketplace, 2026-08-13) reaproveite esta
   * função sem duplicá-la inteira e sem que ela passe a ler uma segunda
   * variável de ambiente — a invariante "uma variável, um único leitor"
   * continua valendo: quem resolve é obterModeloAdaptacaoMarketplace(),
   * aqui o valor só chega pronto. Ausente = comportamento original
   * (obterModeloConteudo), preservando os chamadores existentes.
   */
  modelo?: string;
}): Promise<ResultadoChamadaGoogle> {
  const cliente = obterCliente();
  const modelo = params.modelo ?? obterModeloConteudo();
  const inicio = Date.now();

  const input = [{ type: "text" as const, text: params.promptTexto }];

  try {
    const interaction = await cliente.interactions.create(
      {
        model: modelo,
        input,
        response_format: { type: "text", mime_type: "application/json", schema: params.schema },
        store: false,
      },
      { timeout: TIMEOUT_MS_TEXTO }
    );

    const tempoMs = Date.now() - inicio;

    if (!interaction.output_text) {
      throw new ErroProvedorIA("validation", "Gemini não devolveu output_text — resposta vazia ou bloqueada.");
    }

    return {
      resultadoTexto: interaction.output_text,
      modelo,
      tokensEntrada: interaction.usage?.total_input_tokens ?? 0,
      tokensSaida: interaction.usage?.total_output_tokens ?? 0,
      tempoMs,
    };
  } catch (err) {
    if (err instanceof ErroProvedorIA) throw err;
    throw mapearErroGoogle(err);
  }
}

/**
 * Detecta evidência inequívoca de credencial/API key inválida dentro
 * de um erro HTTP 400 da Interactions API — usada em mapearErroGoogle
 * para reclassificar esse caso específico como "auth" em vez do
 * "validation" padrão de 400 (regra aprovada 2026-08-09). Nunca
 * depende de `instanceof`/classe do SDK, mesma razão da correção do
 * `mapearErroGoogle` — só inspeciona texto disponível no objeto de
 * erro (mensagem + corpo/causa quando existirem), nunca reclassifica
 * um 400 genérico sem correspondência clara a um destes padrões.
 * Nada aqui é logado — a função só devolve true/false.
 *
 * ACHADO (2026-08-09, teste real com chave inválida): a mensagem
 * devolvida pelo SDK nesse teste foi
 * "400 API error occurred: {\"httpMeta\":{\"response\":{},\"request\":{}}}"
 * — sem nenhum texto reconhecível de erro de credencial. Isso indica
 * que, nesta versão da Interactions API, o corpo de erro real do
 * Google nem sempre chega ao objeto de erro do SDK (parece limitação/
 * bug da API, lançada recentemente) — então este helper pode não
 * capturar esse caso específico até isso mudar do lado do SDK/Google.
 * Documentado aqui de propósito, não escondido: se o teste real
 * continuar voltando "validation" após esta correção, a causa mais
 * provável é esta, não um erro na lógica abaixo.
 */
function erroIndicaCredencialInvalida(err: unknown): boolean {
  const e = err as any;
  const partes: string[] = [];
  if (typeof e?.message === "string") partes.push(e.message);
  for (const campo of ["error", "body", "rawResponse", "cause"] as const) {
    const valor = e?.[campo];
    if (valor === undefined || valor === null) continue;
    try {
      partes.push(typeof valor === "string" ? valor : JSON.stringify(valor));
    } catch {
      // valor não serializável — ignora, diagnóstico nunca deve lançar
    }
  }
  const textoCompleto = partes.join(" ").toLowerCase();
  const PADROES_CREDENCIAL_INVALIDA = [
    "api key not valid",
    "invalid api key",
    "api_key_invalid",
    "credencial inválida",
    "credencial invalida",
    "chave de api inválida",
    "chave de api invalida",
    "authentication failed",
    "unauthenticated",
  ];
  return PADROES_CREDENCIAL_INVALIDA.some(padrao => textoCompleto.includes(padrao));
}

/**
 * Mapeia erros reais da API/SDK do Google para as 6 categorias já
 * existentes em estudio_anuncios_jobs.erro_tipo. Nunca inventa uma
 * categoria nova fora da lista já aceita pelo banco.
 *
 * CORREÇÃO (2026-08-09, pós primeiro teste real): a versão anterior
 * usava `err instanceof ApiError`. Confirmado por teste real (chave
 * inválida → erro_tipo gravado como "unknown" em vez de "auth") e por
 * inspeção direta do runtime do SDK (node_modules/@google/genai/dist/
 * node/index.mjs) que a Interactions API lança uma hierarquia de erros
 * própria e NÃO exportada publicamente pelo pacote (`APIError` e
 * subclasses como `AuthenticationError`, `RateLimitError`, etc., raiz
 * `GeminiNextGenAPIClientError`) — completamente distinta da classe
 * legada `ApiError` (usada só pelo cliente antigo `generateContent`).
 * Como essas classes não são exportadas, `instanceof` contra elas nem
 * é possível de escrever. A correção usa inspeção ESTRUTURAL do objeto
 * de erro em vez de `instanceof`, o que funciona tanto para a classe
 * legada quanto para a nova hierarquia (ambas setam `status`/
 * `statusCode` no próprio objeto) e não quebra se o SDK mudar essa
 * hierarquia interna de novo no futuro — nunca dependemos de uma
 * classe específica exportada ou não.
 *
 * Ordem de inspeção: status -> statusCode -> name -> fallback
 * genérico. Mensagem: quando existe status HTTP, sempre
 * "HTTP <status>: <mensagem original>"; sem status, a mensagem
 * original do SDK sem nenhuma alteração — nunca perdida, nunca
 * substituída por texto genérico.
 */
export function mapearErroGoogle(err: unknown): ErroProvedorIA {
  const mensagemOriginal = ((err as any)?.message ?? String(err)).slice(0, 300);

  // 1) status  2) statusCode — presentes tanto na hierarquia nova
  // (APIError e subclasses) quanto na classe legada ApiError.
  const statusBruto = (err as any)?.status ?? (err as any)?.statusCode;
  const status = typeof statusBruto === "number" ? statusBruto : undefined;

  if (status !== undefined) {
    const mensagem = `HTTP ${status}: ${mensagemOriginal}`;
    if (status === 401 || status === 403) return new ErroProvedorIA("auth", mensagem);
    if (status === 429) return new ErroProvedorIA("rate_limit", mensagem);
    if (status >= 500) return new ErroProvedorIA("transient", mensagem);
    if (status === 400) {
      // Regra específica (2026-08-09): 400 com evidência inequívoca de
      // credencial inválida vira "auth", não "validation" — checado
      // ANTES da regra de safety/conteúdo, mas só quando o padrão bate
      // de forma clara (ver erroIndicaCredencialInvalida acima).
      if (erroIndicaCredencialInvalida(err)) {
        return new ErroProvedorIA("auth", mensagem);
      }
      if (/safety|blocked|prohibited/i.test(mensagemOriginal)) {
        return new ErroProvedorIA("conteudo_rejeitado", mensagem);
      }
      return new ErroProvedorIA("validation", mensagem);
    }
    return new ErroProvedorIA("unknown", mensagem);
  }

  // 3) name — sem status HTTP (erro de transporte/conexão/timeout/
  // abort, nunca chegou a haver resposta do servidor). Nomes reais das
  // classes internas da Interactions API para esse caso (confirmados
  // por inspeção do runtime): APIConnectionError,
  // APIConnectionTimeoutError, APIUserAbortError. Mantido também
  // reconhecimento por mensagem como rede de segurança para formatos
  // de erro fora dessas classes (ex.: AbortError nativo do fetch).
  const nome = (err as any)?.name as string | undefined;
  if (
    nome === "APIConnectionError" ||
    nome === "APIConnectionTimeoutError" ||
    nome === "APIUserAbortError" ||
    nome === "AbortError" ||
    /timeout|timed out|aborted|connection error/i.test(mensagemOriginal)
  ) {
    return new ErroProvedorIA("transient", mensagemOriginal);
  }

  // 4) fallback genérico — nem status, nem nome reconhecido.
  if (/api key/i.test(mensagemOriginal)) return new ErroProvedorIA("auth", mensagemOriginal);
  if (/safety|blocked|prohibited/i.test(mensagemOriginal)) return new ErroProvedorIA("conteudo_rejeitado", mensagemOriginal);

  return new ErroProvedorIA("unknown", mensagemOriginal);
}
