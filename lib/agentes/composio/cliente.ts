import "server-only";

/**
 * O cliente do Composio — AGENT-FACTORY-F7b.4.
 *
 * ── REST puro, e a razao nao e preferencia ──────────────────────────
 *
 * As operacoes de que a Factory precisa — buscar toolkit, listar as tools
 * de um toolkit — sao duas chamadas HTTP. Medidas contra a API real antes
 * de escrever este arquivo:
 *
 *   GET /api/v3/toolkits?search=sheets   -> 200, 4 de 1584
 *   GET /api/v3/tools?toolkit_slug=...   -> 200, 36 tools
 *   GET /api/v1/apps                     -> 410, v1 esta morta
 *
 * O SDK `@composio/core` resolveria isso e traria tambem um EXECUTOR de
 * tools — inclusive a meta-tool que executa qualquer acao por nome. Essa
 * e exatamente a superficie que o §10 proibe deixar perto do modelo. Nao
 * instalar o SDK nao e economia de dependencia: e nao ter em casa a peca
 * que nao pode ser usada.
 *
 * ── A chave nao sai do servidor ─────────────────────────────────────
 *
 * `server-only` faz o build falhar se um componente de cliente importar
 * este arquivo. A chave e lida aqui e em nenhum outro lugar.
 *
 * ── Falha do Composio nao derruba a Factory ─────────────────────────
 *
 * Toda funcao devolve desfecho. Catalogo externo fora significa que a
 * busca externa mostra erro e as ferramentas INTERNAS continuam
 * inteiras — elas nao passam por aqui.
 */

const BASE = "https://backend.composio.dev/api/v3";

/** Curto: a busca acontece enquanto a pessoa digita. */
const TIMEOUT_MS = 10000;

export type ResultadoComposio<T> =
  | { readonly estado: "ok"; readonly dados: T }
  | { readonly estado: "nao_configurado" }
  | { readonly estado: "falha"; readonly codigo: string };

function chave(): string | null {
  const v = process.env.COMPOSIO_API_KEY;
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/** `true` quando ha credencial. Nao revela nada sobre o valor. */
export function catalogoExternoConfigurado(): boolean {
  return chave() !== null;
}

async function obter<T>(
  caminho: string,
  parametros: Record<string, string | number | undefined>
): Promise<ResultadoComposio<T>> {
  const k = chave();
  if (k === null) return { estado: "nao_configurado" };

  const q = new URLSearchParams();
  for (const [nome, valor] of Object.entries(parametros)) {
    if (valor !== undefined && valor !== "") q.set(nome, String(valor));
  }

  const controle = new AbortController();
  const relogio = setTimeout(() => controle.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${BASE}${caminho}${q.size > 0 ? `?${q.toString()}` : ""}`, {
      method: "GET",
      headers: { "x-api-key": k, Accept: "application/json" },
      signal: controle.signal,
      cache: "no-store",
    });
    if (!r.ok) return { estado: "falha", codigo: `http_${r.status}` };
    const texto = await r.text();
    try {
      return { estado: "ok", dados: JSON.parse(texto) as T };
    } catch {
      return { estado: "falha", codigo: "resposta_ilegivel" };
    }
  } catch (err) {
    const nome = (err as { name?: string }).name;
    return { estado: "falha", codigo: nome === "AbortError" ? "timeout" : "rede" };
  } finally {
    clearTimeout(relogio);
  }
}

// ─── Toolkits ─────────────────────────────────────────────────────────

export interface ToolkitExterno {
  readonly slug: string;
  readonly nome: string;
  /** `true` quando a ferramenta funciona sem conta conectada. */
  readonly semAutenticacao: boolean;
  readonly depreciado: boolean;
}

function toolkitDaResposta(bruto: unknown): ToolkitExterno | null {
  if (typeof bruto !== "object" || bruto === null) return null;
  const o = bruto as Record<string, unknown>;
  if (typeof o.slug !== "string" || o.slug === "") return null;
  if (typeof o.name !== "string" || o.name === "") return null;
  return {
    slug: o.slug,
    nome: o.name,
    semAutenticacao: o.no_auth === true,
    depreciado: o.deprecated === true,
  };
}

export interface PaginaDeToolkits {
  readonly itens: readonly ToolkitExterno[];
  readonly totalDisponivel: number;
}

/**
 * Busca toolkits por termo, PAGINADA no servidor.
 *
 * O catalogo tem ~1584 toolkits. Baixar tudo para filtrar no browser
 * seria mandar megabytes para a tela e, pior, tornaria tentador despejar
 * a lista num prompt. A busca acontece la, e o limite e explicito.
 *
 * Toolkit depreciado NAO e escondido aqui: quem decide se mostra e a
 * tela. Esconder na camada de transporte apagaria a informacao de que
 * uma escolha antiga do dono virou legado.
 */
export async function buscarToolkits(
  termo: string,
  limite = 12
): Promise<ResultadoComposio<PaginaDeToolkits>> {
  const r = await obter<{ items?: unknown[]; total_items?: unknown }>(
    "/toolkits", { search: termo.trim(), limit: Math.min(Math.max(limite, 1), 50) });
  if (r.estado !== "ok") return r;

  const itens: ToolkitExterno[] = [];
  for (const bruto of r.dados.items ?? []) {
    const t = toolkitDaResposta(bruto);
    // Item torto e DESCARTADO, nao condena a busca: uma entrada nova no
    // catalogo do Composio com campo faltando nao deve apagar o
    // resultado inteiro para quem esta procurando outra coisa.
    if (t !== null) itens.push(t);
  }
  const total = typeof r.dados.total_items === "number" ? r.dados.total_items : itens.length;
  return { estado: "ok", dados: { itens, totalDisponivel: total } };
}

// ─── Tools de um toolkit ──────────────────────────────────────────────

export interface AcaoExterna {
  /** Slug do Composio, como veio. Ex.: `GOOGLESHEETS_ADD_SHEET`. */
  readonly slug: string;
  readonly nome: string;
  readonly descricao: string | null;
  readonly semAutenticacao: boolean;
  /** Schema de entrada, quando o catalogo o publica. */
  readonly schemaEntrada: object | null;
}

function acaoDaResposta(bruto: unknown): AcaoExterna | null {
  if (typeof bruto !== "object" || bruto === null) return null;
  const o = bruto as Record<string, unknown>;
  if (typeof o.slug !== "string" || o.slug === "") return null;
  const schema = o.input_parameters;
  return {
    slug: o.slug,
    nome: typeof o.name === "string" && o.name !== "" ? o.name : o.slug,
    descricao: typeof o.description === "string" ? o.description : null,
    semAutenticacao: o.no_auth === true,
    schemaEntrada:
      typeof schema === "object" && schema !== null && !Array.isArray(schema)
        ? (schema as object)
        : null,
  };
}

export interface PaginaDeAcoes {
  readonly itens: readonly AcaoExterna[];
  readonly totalDisponivel: number;
}

/**
 * As acoes reais de UM toolkit.
 *
 * Nada e hardcoded: a lista vem do catalogo, e um toolkit que ganhe uma
 * acao nova a mostra sem este arquivo mudar.
 *
 * O limite existe porque toolkits grandes tem dezenas de acoes (Google
 * Sheets tem 36), e schema de acao e o que mais pesa num prompt.
 */
export async function listarAcoesDoToolkit(
  toolkitSlug: string,
  limite = 30
): Promise<ResultadoComposio<PaginaDeAcoes>> {
  const r = await obter<{ items?: unknown[]; total_items?: unknown }>(
    "/tools", { toolkit_slug: toolkitSlug.trim(), limit: Math.min(Math.max(limite, 1), 50) });
  if (r.estado !== "ok") return r;

  const itens: AcaoExterna[] = [];
  for (const bruto of r.dados.items ?? []) {
    const a = acaoDaResposta(bruto);
    if (a !== null) itens.push(a);
  }
  const total = typeof r.dados.total_items === "number" ? r.dados.total_items : itens.length;
  return { estado: "ok", dados: { itens, totalDisponivel: total } };
}

// ─── O DETALHE de uma action — AGENT-FACTORY-F7b.4.3 ──────────────────

/**
 * Tudo que e preciso para DECLARAR e EXECUTAR uma action.
 *
 * `parametros` e o JSON Schema do PROVEDOR, repassado inteiro. Nao e
 * reescrito nem resumido por nos: inventar schema de acao alheia faria o
 * modelo montar argumentos que a acao recusa, e o erro apareceria como
 * falha de ferramenta em vez de defeito nosso.
 */
export interface DetalheDaAcao {
  readonly slug: string;
  readonly nome: string;
  readonly descricao: string;
  readonly parametros: Readonly<Record<string, unknown>>;
  readonly versao: string;
  /** `true` quando a action roda sem conta conectada. MEDIDO. */
  readonly semAutenticacao: boolean;
  readonly depreciada: boolean;
}

/**
 * UMA action, pelo slug.
 *
 * `GET /tools/{ACTION_SLUG}` — MEDIDO em
 * `scripts/medir-composio-execucao.ts`: devolve `slug`, `name`,
 * `description`, `input_parameters`, `output_parameters`, `version`,
 * `no_auth`, `is_deprecated`.
 *
 * Esta e tambem a prova de EXISTENCIA que o §5 exige: uma action que saiu
 * do catalogo devolve falha aqui e, por isso, nao e declarada ao modelo —
 * mesmo que o vinculo e a permissao continuem gravados.
 */
export async function detalharAcao(
  slug: string
): Promise<ResultadoComposio<DetalheDaAcao>> {
  const limpo = slug.trim().toUpperCase();
  if (limpo === "") return { estado: "falha", codigo: "slug_vazio" };

  const r = await obter<Record<string, unknown>>(`/tools/${encodeURIComponent(limpo)}`, {});
  if (r.estado !== "ok") return r;

  const o = r.dados;
  if (typeof o.slug !== "string" || o.slug === "") {
    return { estado: "falha", codigo: "resposta_sem_slug" };
  }
  const params = o.input_parameters;
  return {
    estado: "ok",
    dados: {
      slug: o.slug,
      nome: typeof o.name === "string" && o.name !== "" ? o.name : o.slug,
      descricao: typeof o.description === "string" ? o.description : "",
      parametros: (typeof params === "object" && params !== null
        ? params
        : { type: "object", properties: {} }) as Readonly<Record<string, unknown>>,
      versao: typeof o.version === "string" ? o.version : "",
      semAutenticacao: o.no_auth === true,
      depreciada: o.is_deprecated === true,
    },
  };
}
