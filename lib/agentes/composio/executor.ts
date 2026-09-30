import "server-only";

/**
 * Executar UMA action externa — AGENT-FACTORY-F7b.4.3 §2/§3/§7.
 *
 * ── Este modulo NAO decide autorizacao ──────────────────────────────
 *
 * Ele e chamado DEPOIS do guard, de dentro do `executor` de uma
 * `DefinicaoFuncao`, exatamente como qualquer Funcao interna. A ordem e:
 *
 *   LLM -> laco -> executarFuncao -> GUARD -> abertura de auditoria
 *       -> executor da Funcao -> ESTE MODULO -> Composio -> resultado
 *       -> interpretador -> desfecho -> LLM
 *
 * Nao ha caminho do LLM para ca. Nao ha meta-tool: `COMPOSIO_EXECUTE_TOOL`
 * existe no catalogo do Composio e NUNCA e declarada — a suite reprova se
 * o nome aparecer em codigo de producao.
 *
 * ── Tudo aqui foi MEDIDO ────────────────────────────────────────────
 *
 * `scripts/medir-composio-execucao.ts`, contra a API real:
 *
 *   POST /api/v3/tools/execute/{ACTION_SLUG}
 *        `{ arguments: {...}, user_id }`
 *
 *   SUCESSO   -> HTTP 200
 *        `{ data: object, successful: true, error: null, log_id: string }`
 *
 *   FALHA DA ACAO -> HTTP **200 TAMBEM**
 *        `{ data: { message, status_code }, successful: false,
 *           error: "Invalid request data provided…", log_id }`
 *
 *        ISTO E A ARMADILHA CENTRAL. O status HTTP nao e o sinal de
 *        sucesso. Quem olhar so `r.ok` vai gravar na auditoria que a acao
 *        funcionou quando ela falhou — exatamente o defeito que
 *        `interpretarSaida` existe para impedir no resto do sistema.
 *
 *   SEM CONEXAO -> HTTP 404
 *        `{ error: { message, code: 1810,
 *           slug: "ActionExecute_ConnectedAccountNotFound", … } }`
 *
 *        E este par (404 + code 1810) que sustenta CONNECTION_REQUIRED.
 *        Reconhecemos pelo CODIGO do servidor, e nao pela frase: frase
 *        muda de idioma, codigo nao.
 *
 * ── A identidade e derivada, sempre ─────────────────────────────────
 *
 * `user_id` enviado ao Composio e `principalDeConexao(userId)` — o mesmo
 * hash do F7b.4.2. NUNCA o `user_id` da CDS cru, NUNCA algo vindo do
 * modelo, do browser ou dos argumentos.
 *
 * Este modulo nao aceita `connectedAccountId`, `externalUserId`,
 * `credential id` nem token de lugar nenhum — nem como parametro. O tipo
 * de entrada nao tem esses campos, entao o `tsc` recusa antes de qualquer
 * teste, que e o mesmo padrao de `conexaoNecessaria` em `executarFuncao`.
 */
import { principalDeConexao } from "@/lib/agentes/composio/conexao";

const BASE = "https://backend.composio.dev/api/v3";
/** Acao externa e chamada de rede de terceiro dentro do turno do chat. */
const TIMEOUT_MS = 20000;

/** MEDIDO: o codigo do Composio para "nao ha conta conectada". */
const CODIGO_SEM_CONEXAO = 1810;
const SLUG_SEM_CONEXAO = "ActionExecute_ConnectedAccountNotFound";

export type ResultadoExecucaoExterna =
  | { readonly estado: "ok"; readonly dados: unknown }
  /** A acao rodou e o PROVEDOR disse que falhou. HTTP 200, `successful:false`. */
  | { readonly estado: "acao_falhou"; readonly codigo: string }
  /** Falta o dono conectar a conta. Fail-closed: nada executou. */
  | { readonly estado: "conexao_necessaria"; readonly toolkit: string }
  | { readonly estado: "nao_configurado" }
  | { readonly estado: "falha"; readonly codigo: string };

function chave(): string | null {
  const v = process.env.COMPOSIO_API_KEY;
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/**
 * O erro do provedor, reduzido a um CODIGO nosso.
 *
 * A frase do Composio nao atravessa: ela cita `request_id`, `entity`, o
 * principal derivado e as vezes eco dos argumentos. Nada disso tem o que
 * fazer numa mensagem que volta para o modelo — e o modelo repete o que
 * recebe.
 */
function codigoDoErro(bruto: unknown): string {
  if (typeof bruto !== "string" || bruto.trim() === "") return "erro_externo";
  // Um rotulo curto e estavel. Sem numero, sem id, sem nome proprio.
  if (/invalid request data|should be a valid/i.test(bruto)) return "argumentos_invalidos";
  if (/rate limit|too many/i.test(bruto)) return "limite_excedido";
  if (/timeout|timed out/i.test(bruto)) return "tempo_esgotado";
  if (/not found/i.test(bruto)) return "recurso_inexistente";
  return "erro_externo";
}

/**
 * Executa a action e devolve o resultado JA classificado.
 *
 * `toolkit` entra so para a mensagem de `conexao_necessaria` — a API nao
 * o exige, e quem escolhe a action ja sabe de qual aplicativo ela e.
 */
export async function executarAcaoComposio(entrada: {
  readonly userId: string;
  readonly toolkit: string;
  readonly acao: string;
  readonly argumentos: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
}): Promise<ResultadoExecucaoExterna> {
  const k = chave();
  if (k === null) return { estado: "nao_configurado" };
  if (!entrada.userId) return { estado: "falha", codigo: "sem_dono" };
  if (!entrada.acao.trim()) return { estado: "falha", codigo: "acao_invalida" };

  const controle = new AbortController();
  const relogio = setTimeout(() => controle.abort(), TIMEOUT_MS);
  // O sinal de quem chamou TAMBEM aborta: sem isto, o turno do chat
  // poderia ser cancelado e esta chamada continuaria correndo sozinha.
  const externo = entrada.signal;
  const repassar = () => controle.abort();
  if (externo !== undefined) externo.addEventListener("abort", repassar, { once: true });

  try {
    const r = await fetch(
      `${BASE}/tools/execute/${encodeURIComponent(entrada.acao.trim().toUpperCase())}`,
      {
        method: "POST",
        headers: {
          "x-api-key": k,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          arguments: entrada.argumentos,
          // DERIVADO. Ver o docblock.
          user_id: principalDeConexao(entrada.userId),
        }),
        signal: controle.signal,
        cache: "no-store",
      }
    );

    const texto = await r.text();
    let corpo: unknown = null;
    try { corpo = JSON.parse(texto); } catch { /* fica null */ }

    // ── 404 + code 1810: falta conectar ─────────────────────────────
    if (r.status === 404) {
      const e = (corpo as { error?: Record<string, unknown> })?.error;
      if (e?.code === CODIGO_SEM_CONEXAO || e?.slug === SLUG_SEM_CONEXAO) {
        return { estado: "conexao_necessaria", toolkit: entrada.toolkit };
      }
      return { estado: "falha", codigo: "http_404" };
    }

    if (!r.ok) return { estado: "falha", codigo: `http_${r.status}` };

    if (typeof corpo !== "object" || corpo === null) {
      return { estado: "falha", codigo: "resposta_ilegivel" };
    }
    const o = corpo as Record<string, unknown>;

    // ── HTTP 200 NAO significa sucesso ──────────────────────────────
    //
    // `successful` e o sinal. E ele e cobrado por IGUALDADE a `true`:
    // ausente, `null` ou qualquer outra coisa conta como falha, porque o
    // padrao seguro e "nao funcionou".
    if (o.successful !== true) {
      return { estado: "acao_falhou", codigo: codigoDoErro(o.error) };
    }

    return { estado: "ok", dados: o.data ?? null };
  } catch (err) {
    const nome = (err as { name?: string }).name;
    return { estado: "falha", codigo: nome === "AbortError" ? "tempo_esgotado" : "rede" };
  } finally {
    clearTimeout(relogio);
    if (externo !== undefined) externo.removeEventListener("abort", repassar);
  }
}
