/**
 * O que ESTA chave da OpenAI de fato alcanca — AGENT-FACTORY-F7b.4.2.
 *
 * ── Por que existe um modulo so para isto ───────────────────────────
 *
 * "OpenAI nao configurado" e um diagnostico ruim, porque junta coisas que
 * exigem acoes diferentes de quem le:
 *
 *   sem chave            -> criar a chave
 *   chave invalida       -> trocar a chave
 *   sem credito          -> por dinheiro na conta
 *   sem acesso ao modelo -> mudar permissao do projeto
 *   API fora             -> esperar
 *
 * As cinco chegariam como "nao configurado" e as cinco mandariam a pessoa
 * procurar no lugar errado. Este modulo separa, e o teste prova que ele
 * separa.
 *
 * ── Medido em 2026-09-30 ────────────────────────────────────────────
 *
 * A chave deste projeto AUTENTICA: `GET /v1/models` responde 200 com 127
 * modelos, incluindo a familia `gpt-5`, que tem function calling.
 *
 * E toda chamada de INFERENCIA responde:
 *
 *   429 {"type":"insufficient_quota","code":"credit_balance_exhausted"}
 *   "You have no credits remaining."
 *
 * Tanto em `/v1/responses` quanto em `/v1/chat/completions`, e tambem com
 * `reasoning.effort` em low/medium/high. Ou seja: nao e modelo, nao e
 * permissao, nao e a API — e saldo.
 *
 * Por isso NAO ha adaptador de OpenAI neste repositorio ainda, e NAO ha
 * entrada de OpenAI no catalogo de modelos. Escrever a conversao de
 * dialogo sem nunca ter visto uma resposta real seria repetir o erro do
 * F4, que concluiu algo sobre o protocolo do Gemini sem ter isolado a
 * forma verdadeira — e custou dois gates para ser desfeito.
 *
 * ── Este modulo nao chama o modelo ──────────────────────────────────
 *
 * Ele pergunta `GET /v1/models` (que nao consome credito) e, so quando
 * pedido, faz UMA chamada minima de inferencia para descobrir se o saldo
 * existe. Nenhuma das duas participa do runtime do agente.
 */
import "server-only";

/** Os estados possiveis. `disponivel` e o unico que habilita runtime. */
export const ESTADOS_DA_OPENAI = Object.freeze([
  "disponivel",
  "sem_chave",
  "auth_falhou",
  "billing_necessario",
  "permissao_negada",
  "modelo_indisponivel",
  "api_falhou",
] as const);
export type EstadoDaOpenAI = (typeof ESTADOS_DA_OPENAI)[number];

/** O que quem le o diagnostico deve FAZER. Uma frase por estado. */
export const ACAO_POR_ESTADO: Readonly<Record<EstadoDaOpenAI, string>> = Object.freeze({
  disponivel: "Nada a fazer: a chave responde e tem saldo.",
  sem_chave: "Criar OPENAI_API_KEY.",
  auth_falhou: "A chave nao e aceita. Gerar outra.",
  billing_necessario: "Adicionar credito na conta da OpenAI.",
  permissao_negada: "O projeto nao tem acesso. Ajustar a permissao do projeto.",
  modelo_indisponivel: "O modelo pedido nao existe para esta chave. Escolher outro.",
  api_falhou: "Falha da API. Repetir mais tarde.",
});

/**
 * Classifica uma resposta HTTP da OpenAI. PURO.
 *
 * A ordem importa. `429` e o caso ambiguo: ele significa "sem saldo" E
 * "rate limit", e sao problemas opostos — um exige dinheiro, o outro
 * exige esperar. A unica forma de separar e o corpo, e por isso o corpo
 * entra na classificacao.
 */
export function classificarRespostaDaOpenAI(
  status: number,
  corpo: string
): EstadoDaOpenAI {
  if (status >= 200 && status < 300) return "disponivel";

  const t = corpo.toLowerCase();

  if (status === 401) return "auth_falhou";
  if (status === 402) return "billing_necessario";

  // Saldo esgotado chega como 429, com `insufficient_quota` no corpo.
  // Sem olhar o corpo, isto viraria "rate limit" e alguem esperaria para
  // sempre por uma cota que nao volta.
  if (status === 429) {
    return /insufficient_quota|credit_balance|no credits|billing/.test(t)
      ? "billing_necessario"
      : "api_falhou";
  }

  if (status === 403) return "permissao_negada";

  // 404 so e "modelo indisponivel" quando fala de modelo. Um 404 de
  // caminho errado e falha de API, e trocar o modelo nao resolveria.
  if (status === 404) {
    return /model/.test(t) ? "modelo_indisponivel" : "api_falhou";
  }

  return "api_falhou";
}

export interface DiagnosticoDaOpenAI {
  readonly estado: EstadoDaOpenAI;
  /** O que fazer. Frase de `ACAO_POR_ESTADO`. */
  readonly acao: string;
  /** `true` quando `GET /v1/models` respondeu. */
  readonly autentica: boolean;
  /** Quantos modelos a chave enxerga. `0` quando nao autentica. */
  readonly modelosVisiveis: number;
  /**
   * Modelos com function calling que ESTA chave enxerga, do mais capaz
   * para o menos. Vazio quando nao autentica.
   *
   * Derivado da lista REAL. Nenhum nome e escrito a mao: um modelo que a
   * conta nao tem nunca aparece aqui, e por isso nao pode ser sugerido.
   */
  readonly candidatos: readonly string[];
  /** Evidencia curta e SANITIZADA. Nunca a chave. */
  readonly evidencia: string | null;
}

const BASE = "https://api.openai.com/v1";
const TIMEOUT_MS = 20000;

/**
 * Famílias que suportam function calling, da mais capaz para a menos.
 *
 * Padroes, e nao nomes fixos: a lista de modelos muda, e cruzar padrao
 * com a lista real e o que impede sugerir um modelo que a conta nao tem.
 */
const PADROES_COM_FERRAMENTA: readonly RegExp[] = Object.freeze([
  /^gpt-5\.\d/, /^gpt-5$/, /^gpt-5-(?!chat|codex)/, /^gpt-4\.1/, /^o4/, /^o3/, /^gpt-4o/,
]);

/** Variantes que nao servem para dialogo com ferramenta. */
const EXCLUIR = /audio|realtime|transcribe|tts|search|image|embedding|moderation|codex/;

function chave(): string | null {
  const v = process.env.OPENAI_API_KEY;
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/** Remove a chave de qualquer texto, venha de onde vier. */
function sanitizar(texto: string, k: string | null): string {
  const limpo = k !== null && k.length > 8 ? texto.split(k).join("[REDIGIDO]") : texto;
  return limpo.replace(/\s+/g, " ").slice(0, 220);
}

async function pedir(
  caminho: string, k: string, metodo: "GET" | "POST", corpo?: unknown
): Promise<{ status: number; texto: string }> {
  const controle = new AbortController();
  const relogio = setTimeout(() => controle.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(BASE + caminho, {
      method: metodo,
      headers: {
        Authorization: `Bearer ${k}`,
        Accept: "application/json",
        ...(corpo !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
      signal: controle.signal,
      cache: "no-store",
    });
    return { status: r.status, texto: await r.text() };
  } finally {
    clearTimeout(relogio);
  }
}

/**
 * O diagnostico real desta chave.
 *
 * Duas chamadas, e a segunda so acontece se a primeira passar:
 *
 *   1. `GET /v1/models`   nao consome credito. Diz se autentica e o que
 *                         a conta enxerga.
 *   2. inferencia minima  a UNICA forma de saber se ha saldo. `max_output
 *                         _tokens` no minimo para que o custo, quando
 *                         houver saldo, seja o menor possivel.
 */
export async function diagnosticarOpenAI(): Promise<DiagnosticoDaOpenAI> {
  const k = chave();
  if (k === null) {
    return {
      estado: "sem_chave", acao: ACAO_POR_ESTADO.sem_chave,
      autentica: false, modelosVisiveis: 0, candidatos: [], evidencia: null,
    };
  }

  let lista: { status: number; texto: string };
  try {
    lista = await pedir("/models", k, "GET");
  } catch (err) {
    const nome = (err as { name?: string }).name;
    return {
      estado: "api_falhou", acao: ACAO_POR_ESTADO.api_falhou,
      autentica: false, modelosVisiveis: 0, candidatos: [],
      evidencia: nome === "AbortError" ? "timeout" : "rede",
    };
  }

  if (lista.status < 200 || lista.status >= 300) {
    const estado = classificarRespostaDaOpenAI(lista.status, lista.texto);
    return {
      estado, acao: ACAO_POR_ESTADO[estado],
      autentica: false, modelosVisiveis: 0, candidatos: [],
      evidencia: sanitizar(lista.texto, k),
    };
  }

  let ids: string[] = [];
  try {
    const d = JSON.parse(lista.texto) as { data?: { id?: unknown }[] };
    ids = (d.data ?? [])
      .map((x) => (typeof x.id === "string" ? x.id : ""))
      .filter((x) => x !== "");
  } catch {
    return {
      estado: "api_falhou", acao: ACAO_POR_ESTADO.api_falhou,
      autentica: true, modelosVisiveis: 0, candidatos: [],
      evidencia: "lista de modelos ilegivel",
    };
  }

  const candidatos: string[] = [];
  for (const re of PADROES_COM_FERRAMENTA) {
    for (const id of ids.filter((x) => re.test(x) && !EXCLUIR.test(x)).sort()) {
      if (!candidatos.includes(id)) candidatos.push(id);
    }
  }

  // Sem candidato, nao ha o que testar: a conta enxerga modelos, e nenhum
  // deles serve para dialogo com ferramenta.
  if (candidatos.length === 0) {
    return {
      estado: "modelo_indisponivel", acao: ACAO_POR_ESTADO.modelo_indisponivel,
      autentica: true, modelosVisiveis: ids.length, candidatos: [],
      evidencia: "nenhum modelo com function calling visivel para esta chave",
    };
  }

  // A chamada minima. `store: false` por coerencia com o resto do
  // repositorio: nenhum provedor retem dialogo desta aplicacao.
  let inferencia: { status: number; texto: string };
  try {
    inferencia = await pedir("/responses", k, "POST", {
      model: candidatos[0],
      input: [{ role: "user", content: "ok" }],
      max_output_tokens: 16,
      store: false,
    });
  } catch (err) {
    const nome = (err as { name?: string }).name;
    return {
      estado: "api_falhou", acao: ACAO_POR_ESTADO.api_falhou,
      autentica: true, modelosVisiveis: ids.length, candidatos,
      evidencia: nome === "AbortError" ? "timeout" : "rede",
    };
  }

  const estado = classificarRespostaDaOpenAI(inferencia.status, inferencia.texto);
  return {
    estado, acao: ACAO_POR_ESTADO[estado],
    autentica: true, modelosVisiveis: ids.length, candidatos,
    evidencia: estado === "disponivel" ? null : sanitizar(inferencia.texto, k),
  };
}
