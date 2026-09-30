import "server-only";

/**
 * Conectar uma conta externa — AGENT-FACTORY-F7b.4.2 §14/§15.
 *
 * ── Tudo aqui foi MEDIDO, nao suposto ───────────────────────────────
 *
 * `scripts/medir-composio-conexao.ts`, contra a API real:
 *
 *   GET  /toolkits/googlesheets
 *        -> `composio_managed_auth_schemes: ["OAUTH2"]`
 *        E o fato que sustenta o §14: o app OAuth e do COMPOSIO. Nao e
 *        preciso um projeto no Google Cloud do Rodrigo.
 *
 *   POST /auth_configs
 *        `{ toolkit: { slug }, auth_config: { type: "use_composio_managed_auth" } }`
 *        -> 201, `{ toolkit, auth_config: { id, auth_scheme,
 *           is_composio_managed, restrict_to_following_tools } }`
 *        `id` tem a forma `ac_…`, e `is_composio_managed: true`.
 *
 *   POST /connected_accounts
 *        -> 400, code 600: "Creating connections on this endpoint for
 *           Composio-managed OAuth auth configs is no longer supported.
 *           Use POST /api/v3/connected_accounts/link instead."
 *        A propria API indicou o caminho. Fica registrado porque e o tipo
 *        de detalhe que se perde e custa uma hora na proxima vez.
 *
 *   POST /connected_accounts/link
 *        `{ auth_config_id, user_id }`
 *        -> 201, `{ link_token, redirect_url, expires_at,
 *           connected_account_id, experimental }`
 *        O host do `redirect_url` e `connect.composio.dev`.
 *
 *   GET  /connected_accounts/{id}
 *        -> 200, `status: "INITIALIZING"` enquanto o OAuth nao concluiu.
 *        O corpo NAO traz `access_token`, `refresh_token` nem
 *        `client_secret` — verificado por varredura do corpo cru.
 *
 *   DELETE /connected_accounts/{id} -> 200
 *
 * ── O que NUNCA sai daqui — §14 ─────────────────────────────────────
 *
 * `COMPOSIO_API_KEY`, `link_token`, access token, refresh token e qualquer
 * segredo de credencial. O browser recebe TRES coisas: a URL para onde ir,
 * quando ela expira, e o estado da conta. O LLM nao recebe nem isso — ele
 * nunca ve este modulo.
 *
 * `link_token` fica de fora de proposito, mesmo parecendo inofensivo: ele e
 * material de autorizacao do fluxo, e `redirect_url` ja e tudo que a tela
 * precisa para levar a pessoa adiante.
 *
 * ── A identidade e do DONO, e derivada aqui ─────────────────────────
 *
 * `user_id` do Composio NUNCA e o `user_id` da CDS cru. Ele e derivado por
 * hash, com a mesma forma comprimento-prefixada da memoria — ver
 * `lib/agentes/memoria/identidade.ts` e o defeito de colisao que a obrigou.
 *
 * E ela e por DONO, e nao por agente. Isso e deliberado, e segue o modelo
 * que a CDS ja usa em Mercado Livre e Shopee: a credencial e do dono, e o
 * agente recebe capability e binding, nunca a credencial. Uma conexao por
 * agente obrigaria o Rodrigo a autorizar o mesmo Google N vezes, e cada
 * autorizacao extra e uma chance extra de conceder escopo demais.
 *
 * Quem limita o que o agente faz com a conexao continua sendo o par
 * vinculo + permissao, conferido pelo guard. Conectar nao concede nada —
 * pelo mesmo motivo que selecionar uma Tool nao concede (§10).
 */
import { createHash } from "node:crypto";

const BASE = "https://backend.composio.dev/api/v3";
/** Maior que o da busca: criar conexao nao acontece enquanto se digita. */
const TIMEOUT_MS = 15000;

export type ResultadoConexao<T> =
  | { readonly estado: "ok"; readonly dados: T }
  | { readonly estado: "nao_configurado" }
  | { readonly estado: "falha"; readonly codigo: string };

function chave(): string | null {
  const v = process.env.COMPOSIO_API_KEY;
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/**
 * A identidade do dono no provedor externo.
 *
 * `entradaCanonica` prefixa o comprimento porque a concatenacao simples
 * NAO e injetiva — foi um defeito real na memoria: `("a:b")` e `("a", "b")`
 * produziam a mesma string, o mesmo hash e a mesma identidade.
 *
 * Aqui ha um campo so, entao a colisao nao e possivel pelo mesmo caminho.
 * A forma e mantida de proposito: o dia em que um segundo componente
 * entrar, ele entra sem reabrir o buraco.
 */
export function principalDeConexao(userId: string): string {
  const canonica = `${userId.length}:${userId}`;
  return `cds-conta-v1:${createHash("sha256").update(canonica).digest("hex")}`;
}

async function pedir<T>(
  metodo: "GET" | "POST" | "DELETE",
  caminho: string,
  corpo?: unknown
): Promise<ResultadoConexao<T>> {
  const k = chave();
  if (k === null) return { estado: "nao_configurado" };

  const controle = new AbortController();
  const relogio = setTimeout(() => controle.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${BASE}${caminho}`, {
      method: metodo,
      headers: {
        "x-api-key": k,
        Accept: "application/json",
        ...(corpo === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
      signal: controle.signal,
      cache: "no-store",
    });
    const texto = await r.text();
    if (!r.ok) {
      // O CORPO do erro NAO e propagado: ele carrega `request_id`, `slug` e
      // as vezes eco do que foi enviado. So o status viaja.
      return { estado: "falha", codigo: `http_${r.status}` };
    }
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

// ─── A auth config do toolkit ─────────────────────────────────────────

interface RespostaAuthConfigs {
  readonly items?: readonly Record<string, unknown>[];
}

/**
 * A auth config GERENCIADA deste toolkit — reusa antes de criar.
 *
 * Idempotente de proposito: cada auth config e uma configuracao viva na
 * conta do Composio, e criar uma por clique deixaria lixo acumulado que
 * ninguem sabe qual e a certa.
 *
 * So aceita `is_composio_managed`: uma auth config com credencial propria
 * exigiria um app OAuth do Rodrigo, e este caminho existe justamente para
 * nao exigir isso (§14).
 */
export async function garantirAuthConfig(
  toolkit: string
): Promise<ResultadoConexao<{ readonly authConfigId: string; readonly criada: boolean }>> {
  const slug = toolkit.trim().toLowerCase();
  if (slug === "") return { estado: "falha", codigo: "toolkit_invalido" };

  const existentes = await pedir<RespostaAuthConfigs>(
    "GET", `/auth_configs?toolkit_slug=${encodeURIComponent(slug)}`);
  if (existentes.estado !== "ok") return existentes;

  for (const it of existentes.dados.items ?? []) {
    if (it.is_composio_managed !== true) continue;
    if (typeof it.id !== "string" || it.id === "") continue;
    return { estado: "ok", dados: { authConfigId: it.id, criada: false } };
  }

  const criada = await pedir<{ auth_config?: Record<string, unknown> }>(
    "POST", "/auth_configs", {
      toolkit: { slug },
      // MEDIDO: e este `type` que faz o app OAuth ser o do Composio.
      auth_config: { type: "use_composio_managed_auth" },
    });
  if (criada.estado !== "ok") return criada;

  const id = criada.dados.auth_config?.id;
  if (typeof id !== "string" || id === "") {
    return { estado: "falha", codigo: "resposta_sem_id" };
  }
  return { estado: "ok", dados: { authConfigId: id, criada: true } };
}

// ─── O link de conexao ────────────────────────────────────────────────

export interface LinkDeConexao {
  /** Para onde a pessoa vai. E o UNICO segredo-adjacente que sai daqui. */
  readonly urlParaConectar: string;
  readonly expiraEm: string | null;
  readonly contaId: string;
}

/**
 * Gera o link para o dono autorizar a conta dele.
 *
 * Nao conecta nada: quem autoriza e a pessoa, no provedor. Ao voltar, a
 * conta fica `ACTIVE` e `estadoDaConta` passa a dizer isso.
 *
 * `userId` vem da SESSAO, sempre — e a razao de este modulo derivar o
 * principal em vez de aceita-lo. Aceitar um principal do chamador deixaria
 * qualquer requisicao pedir link para a conta de outra pessoa.
 */
export async function gerarLinkDeConexao(entrada: {
  readonly userId: string;
  readonly toolkit: string;
}): Promise<ResultadoConexao<LinkDeConexao>> {
  if (!entrada.userId) return { estado: "falha", codigo: "sem_dono" };

  const config = await garantirAuthConfig(entrada.toolkit);
  if (config.estado !== "ok") return config;

  // MEDIDO: `/connected_accounts` responde 400 code 600 para auth config
  // gerenciada. E `/link` que serve este caso. Ver o docblock.
  const r = await pedir<Record<string, unknown>>("POST", "/connected_accounts/link", {
    auth_config_id: config.dados.authConfigId,
    user_id: principalDeConexao(entrada.userId),
  });
  if (r.estado !== "ok") return r;

  const url = r.dados.redirect_url;
  const contaId = r.dados.connected_account_id;
  if (typeof url !== "string" || url === "") {
    return { estado: "falha", codigo: "resposta_sem_link" };
  }
  if (typeof contaId !== "string" || contaId === "") {
    return { estado: "falha", codigo: "resposta_sem_conta" };
  }

  // `link_token` e `experimental` ficam de fora. Ver o docblock: o que a
  // tela precisa e para onde ir e por quanto tempo.
  return {
    estado: "ok",
    dados: {
      urlParaConectar: url,
      expiraEm: typeof r.dados.expires_at === "string" ? r.dados.expires_at : null,
      contaId,
    },
  };
}

// ─── O estado da conta ────────────────────────────────────────────────

export const ESTADOS_DA_CONTA = Object.freeze([
  /** O dono ainda nao concluiu o OAuth. MEDIDO como `INITIALIZING`. */
  "aguardando_dono",
  "conectada",
  "com_problema",
  "desconhecida",
] as const);

export type EstadoDaConta = (typeof ESTADOS_DA_CONTA)[number];

export interface ContaExterna {
  readonly contaId: string;
  readonly toolkit: string;
  readonly estado: EstadoDaConta;
  /** `true` quando a conta pertence ao principal DESTE dono. */
  readonly doDono: boolean;
  /**
   * `true` SO quando ha evidencia de que a autorizacao chegou a comecar.
   *
   * Existe por causa de um FAIL medido — ver `autorizacaoChegouAComecar`.
   */
  readonly autorizouAntes: boolean;
}

/**
 * Houve, de fato, uma autorizacao — ou apenas um link abandonado?
 *
 * ── O FAIL que obrigou esta funcao a existir ────────────────────────
 *
 * O §10 pede distinguir "conecte sua conta" de "sua conexao expirou". A
 * primeira regra foi: existe conta em `com_problema` -> expirou. A suite
 * live reprovou para um dono que NUNCA concluiu conexao nenhuma: os
 * links emitidos e abandonados ficam `EXPIRED` depois de alguns minutos,
 * e `com_problema` os pegava junto.
 *
 * Dizer "sua conexao expirou" a quem nunca conectou faz a pessoa procurar
 * um erro que nao e dela — que e exatamente o problema que o §10 aponta,
 * so do outro lado.
 *
 * ── MEDIDO em `/connected_accounts` ────────────────────────────────
 *
 * O provedor publica `status_reason`, e para o link abandonado ele diz,
 * literalmente: "Connection expired before authorization was started".
 * Ou seja: ele mesmo informa que nao houve autorizacao.
 *
 * ── Por que a regra exige evidencia POSITIVA ───────────────────────
 *
 * `reconectar: true` e uma AFIRMACAO sobre o passado do dono — "voce
 * conectou isto antes". Nenhum campo publicado prova que uma conta
 * esteve ativa: nao ha `activated_at`, e `updated_at` tambem se move
 * quando o proprio vencimento e gravado.
 *
 * Entao: sem razao publicada, NAO se afirma nada. O pior caso desta
 * regra e mostrar a frase neutra ("falta conectar") para uma conexao que
 * de fato expirou — chato, e verdadeiro. O contrario seria inventar uma
 * conexao que nunca houve.
 */
function autorizacaoChegouAComecar(razao: unknown): boolean {
  if (typeof razao !== "string" || razao.trim() === "") return false;
  // A razao MEDIDA do link abandonado. Sem ela, nao ha o que afirmar.
  return !/before authorization was started/i.test(razao);
}

/**
 * Traduz o estado do provedor para o nosso.
 *
 * Estado desconhecido NAO vira `conectada`. Tratar o que nao se entende
 * como funcionando faria a tela dizer "pronto" para uma conta que nao
 * executaria nada.
 */
function estadoTraduzido(bruto: unknown): EstadoDaConta {
  if (typeof bruto !== "string") return "desconhecida";
  const s = bruto.toUpperCase();
  if (s === "ACTIVE") return "conectada";
  if (s === "INITIALIZING" || s === "INITIATED") return "aguardando_dono";
  if (s === "FAILED" || s === "EXPIRED" || s === "INACTIVE") return "com_problema";
  return "desconhecida";
}

/**
 * O estado de UMA conta, conferindo a PROPRIEDADE.
 *
 * `doDono` vem da comparacao do `user_id` devolvido com o principal
 * derivado aqui. Sem isso, um `contaId` de outra pessoa responderia
 * normalmente — e `contaId` e um id que viaja pela tela.
 */
export async function estadoDaConta(entrada: {
  readonly userId: string;
  readonly contaId: string;
}): Promise<ResultadoConexao<ContaExterna>> {
  if (!entrada.userId || !entrada.contaId) {
    return { estado: "falha", codigo: "entrada_invalida" };
  }
  const r = await pedir<Record<string, unknown>>(
    "GET", `/connected_accounts/${encodeURIComponent(entrada.contaId)}`);
  if (r.estado !== "ok") return r;

  const esperado = principalDeConexao(entrada.userId);
  const toolkitBruto = r.dados.toolkit;
  const slug = typeof toolkitBruto === "object" && toolkitBruto !== null
    ? String((toolkitBruto as Record<string, unknown>).slug ?? "")
    : typeof toolkitBruto === "string" ? toolkitBruto : "";

  return {
    estado: "ok",
    dados: {
      contaId: entrada.contaId,
      toolkit: slug,
      estado: r.dados.is_disabled === true
        ? "com_problema"
        : estadoTraduzido(r.dados.status),
      doDono: r.dados.user_id === esperado,
      autorizouAntes: autorizacaoChegouAComecar(r.dados.status_reason),
    },
  };
}

/**
 * As contas DESTE dono.
 *
 * O filtro por `user_id` vai na QUERY, e nao em memoria depois: pedir tudo
 * e filtrar aqui traria contas de outros donos pela rede sem necessidade.
 */
export async function listarContasDoDono(entrada: {
  readonly userId: string;
  readonly toolkit?: string;
}): Promise<ResultadoConexao<readonly ContaExterna[]>> {
  if (!entrada.userId) return { estado: "falha", codigo: "sem_dono" };

  const esperado = principalDeConexao(entrada.userId);
  const q = new URLSearchParams({ user_ids: esperado });
  if (entrada.toolkit !== undefined && entrada.toolkit.trim() !== "") {
    q.set("toolkit_slugs", entrada.toolkit.trim().toLowerCase());
  }

  const r = await pedir<RespostaAuthConfigs>("GET", `/connected_accounts?${q.toString()}`);
  if (r.estado !== "ok") return r;

  const contas: ContaExterna[] = [];
  for (const it of r.dados.items ?? []) {
    if (typeof it.id !== "string" || it.id === "") continue;
    // Conferido de novo, mesmo tendo filtrado na query: o filtro e do
    // servidor deles, e a propriedade e afirmacao nossa.
    if (it.user_id !== esperado) continue;
    const tk = it.toolkit;
    contas.push({
      contaId: it.id,
      toolkit: typeof tk === "object" && tk !== null
        ? String((tk as Record<string, unknown>).slug ?? "")
        : typeof tk === "string" ? tk : "",
      estado: it.is_disabled === true ? "com_problema" : estadoTraduzido(it.status),
      doDono: true,
      autorizouAntes: autorizacaoChegouAComecar(it.status_reason),
    });
  }
  return { estado: "ok", dados: contas };
}
