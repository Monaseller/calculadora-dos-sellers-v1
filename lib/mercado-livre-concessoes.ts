/**
 * Concessoes do Mercado Livre — a evidencia de cobertura, M2-I1-A3.
 *
 * ── A pergunta que este modulo responde ─────────────────────────────
 *
 *   "esta conta continua autorizando a NOSSA aplicacao a LER?"
 *
 * E ele e o unico ponto deste caminho que ve um token. O dono da
 * cobertura (`lib/agentes/conexoes/cobertura-remota.ts`) recebe daqui um
 * veredito de duas palavras e nada mais.
 *
 * ── Por que o grant remoto, se o token ja existe ────────────────────
 *
 * O token foi emitido para a nossa aplicacao, entao ele prova que UM DIA
 * houve autorizacao. O que ele NAO prova e que ela continua valendo: o
 * vendedor pode revogar a aplicacao no painel dele e o nosso banco ficar
 * com a linha antiga. `GET /users/{sellerId}/applications` e a unica
 * pergunta que responde "hoje, ainda?".
 *
 * ── O que ele NAO faz ───────────────────────────────────────────────
 *
 * Nao escreve no marketplace, nao persiste nada, nao cria tabela, nao
 * implementa OAuth, nao guarda token e nao tem cache. Nao decide
 * permissao, nao decide nivel e nao escolhe loja.
 */
import "server-only";
import type { LimiteExterno } from "@/lib/controle-tempo";
import { getMLLojaById } from "@/lib/ml-auth";
import type { CoberturaRecurso } from "@/lib/ia/skills/diagnostico";

const BASE_ML = "https://api.mercadolibre.com";
const TIMEOUT_MS = 20_000;

/**
 * ── A PERMISSAO FUNCIONAL, E POR QUE ELA E UMA CONSTANTE ────────────
 *
 * "Comunicacoes pre e pos-vendas" e permissao DA APLICACAO, configurada
 * no DevCenter. Ela nao varia por vendedor, e nenhum endpoint oficial a
 * expoe — `GET /applications/$APP_ID` devolve so metadados operacionais.
 * Um teste por loja seria a forma errada mesmo que existisse.
 *
 * Entao ela e evidencia HUMANA, congelada aqui com procedencia. E uma
 * condicao mais fraca do que verificacao remota, e esta declarado como
 * tal — nao como se fosse apurada.
 *
 * ── VALID ONLY FOR READ FUNCTIONS. ─────────────────────────────────
 * ── FIRST WRITE FUNCTION MUST REOPEN THIS CONTRACT. ────────────────
 *
 * O argumento de seguranca que sustenta a combinacao e exatamente este:
 * se a permissao for revogada no DevCenter sem ninguem atualizar a
 * constante, a cobertura dira `confirmada` indevidamente, a Funcao
 * rodara e o Mercado Livre respondera 403 — que o adapter ja mapeia sem
 * vazar corpo. Uma confirmacao errada produz UMA LEITURA QUE FALHA,
 * nunca um efeito externo indevido.
 *
 * Esse raciocinio morre no instante em que existir Funcao de ESCRITA, e
 * por isso o limite e mecanico (`acesso !== "leitura"` recusa), nao uma
 * convencao que alguem precise lembrar.
 *
 * Isto NAO e credencial e NAO vai para o agente.
 */
export const PERMISSAO_FUNCIONAL_CONGELADA = Object.freeze({
  habilitada: true,
  permissao: "Comunicacoes pre e pos-vendas",
  verificadoEm: "2026-09-18",
  appIdVerificado: "2563942078878801",
  origem: "M2-A5 / M2-A5-HUMAN-PROOF-COMPLEMENT-2",
});

/**
 * Por que a cobertura nao foi confirmada. Vocabulario FECHADO.
 *
 * Nenhum deles carrega status HTTP, corpo, header ou mensagem do
 * provider. Eles existem para a auditoria e para a futura tela de
 * Conexoes — NAO sobem ao agente, que continua recebendo
 * `conexao_ausente` do guard.
 */
export type MotivoCoberturaML =
  | "credencial_ausente"
  | "configuracao_ausente"
  | "nao_autorizado"
  | "limite_excedido"
  | "indisponivel"
  | "resposta_invalida"
  | "grant_ausente";

/** O veredito. Duas palavras, e um motivo quando nao deu. */
export interface ResultadoCoberturaML {
  readonly cobertura: CoberturaRecurso;
  readonly motivo: MotivoCoberturaML | null;
}

/**
 * A identidade que basta. `sellerId` NAO entra: ele e resolvido aqui
 * dentro, pelo dono da credencial. Aceita-lo de fora transformaria um
 * numero em autoridade — bastaria troca-lo para perguntar pela conta
 * alheia.
 */
export interface EntradaCoberturaML {
  readonly userId: string;
  readonly lojaId: string;
  /** Da DEFINICAO da Funcao, nunca da entrada do chamador. */
  readonly acesso: "leitura" | "escrita";
}

/** As duas fronteiras injetaveis, e so elas. Producao nunca as passa. */
export interface PortasCoberturaML {
  readonly resolverCredencial?: (
    lojaId: string,
    userId: string,
    /** O orcamento compartilhado, quando quem chama o tem. */
    limiteExterno?: LimiteExterno,
    /** O sinal RIGIDO, para a LEITURA da credencial no banco. */
    signalDoBanco?: AbortSignal
  ) => Promise<{ accessToken: string; sellerId: string } | null>;
  readonly buscar?: typeof fetch;
}

const CONFIRMADA: ResultadoCoberturaML = Object.freeze({
  cobertura: "confirmada" as CoberturaRecurso,
  motivo: null,
});

const recusa = (motivo: MotivoCoberturaML): ResultadoCoberturaML =>
  Object.freeze({ cobertura: "nao_verificavel" as CoberturaRecurso, motivo });

/**
 * Status HTTP -> motivo fechado.
 *
 * 401, 403 e 404 dao o MESMO motivo: a auditoria M2-A4 congelou que 403
 * no ML e ambiguo demais para virar diagnostico proprio, e 404 num
 * `/users/{id}/applications` nao distingue "seller inexistente" de
 * "aplicacao nao concedida". Inventar a diferenca seria pior que nao
 * te-la.
 */
function classificarStatus(status: number): MotivoCoberturaML {
  if (status === 401 || status === 403 || status === 404) return "nao_autorizado";
  if (status === 429) return "limite_excedido";
  return "indisponivel";
}

/**
 * `scopes` contem `read`?
 *
 * ── Estrito de proposito ────────────────────────────────────────────
 *
 * A forma da resposta e UNVERIFIED: o M2-A3 mediu 403 na documentacao e
 * nenhum gate autorizou chamada viva. Entao a unica forma aceita e a
 * declarada — array de strings contendo `read`. Sem `split(" ")` numa
 * string, sem `scope` no singular, sem objeto, sem array misto.
 *
 * Forma desconhecida NAO vira cobertura: vira `resposta_invalida`. Se o
 * provider provar outro formato, isso e gate novo, nao adaptacao aqui.
 */
function temEscopoRead(scopes: unknown): boolean {
  return (
    Array.isArray(scopes) &&
    scopes.every((s) => typeof s === "string") &&
    scopes.includes("read")
  );
}

/**
 * Confirma — ou nao — a cobertura de leitura desta loja.
 *
 * ── A ordem dos passos, e por que ela e essa ────────────────────────
 *
 * Tudo que pode recusar SEM rede acontece antes da rede. Escrita,
 * configuracao ausente, credencial e seller vazio sao respondidos com
 * zero ida ao provider: gastar uma chamada para descobrir algo que ja se
 * sabia seria trabalho e superficie a toa.
 *
 * ── Zero retry ──────────────────────────────────────────────────────
 *
 * Mesma regra do adapter de perguntas e dos provedores de IA: retry e
 * decisao de quem orquestra. Repetir aqui multiplicaria chamada sob 429.
 */
export async function confirmarCoberturaML(
  entrada: EntradaCoberturaML,
  portas?: PortasCoberturaML,
  /** OPCIONAL. O orcamento COMPARTILHADO do provider — ver `controle-tempo`. */
  limiteExterno?: LimiteExterno,
  /** OPCIONAL. O sinal RIGIDO, so para a leitura de credencial no banco. */
  signalDoBanco?: AbortSignal
): Promise<ResultadoCoberturaML> {
  const { userId, lojaId, acesso } = entrada;

  // ── HARD BOUND ────────────────────────────────────────────────────
  //
  // Em CODIGO, e primeiro de todos. A combinacao "evidencia humana +
  // grant remoto" so e defensavel porque uma confirmacao errada custa
  // uma leitura que falha. Para escrita o custo seria um efeito externo
  // indevido, e nenhuma evidencia congelada paga isso.
  if (acesso !== "leitura") return recusa("configuracao_ausente");

  if (!PERMISSAO_FUNCIONAL_CONGELADA.habilitada) return recusa("configuracao_ausente");

  const appId = (process.env.ML_CLIENT_ID ?? "").trim();
  if (appId.length === 0) return recusa("configuracao_ausente");

  if (!userId || !lojaId) return recusa("credencial_ausente");

  const resolver = portas?.resolverCredencial ?? getMLLojaById;
  const buscar = portas?.buscar ?? fetch;

  let credencial: { accessToken: string; sellerId: string } | null;
  try {
    // Este e o UNICO caminho de token, e ele ja trata renovacao. Um
    // segundo mecanismo de refresh aqui divergiria do primeiro no
    // primeiro conserto feito so de um lado. O orcamento viaja junto:
    // uma renovacao disparada aqui nao pode abrir 20 s proprios.
    credencial = await resolver(lojaId, userId, limiteExterno, signalDoBanco);
  } catch {
    // Sem `error.message`: mensagem de driver vaza coluna e as vezes valor.
    console.error("[ml-concessoes] falha ao resolver credencial da loja");
    return recusa("indisponivel");
  }

  // `getMLLojaById` filtra por `{ id, user_id, marketplace: 'ML' }`.
  // Loja de outro dono, de outro provider ou inexistente simplesmente
  // nao volta — os tres casos chegam aqui iguais, de proposito.
  if (credencial === null || !credencial.accessToken) return recusa("credencial_ausente");
  if (!credencial.sellerId) return recusa("credencial_ausente");

  const url = `${BASE_ML}/users/${encodeURIComponent(credencial.sellerId)}/applications`;

  // O teto EFETIVO: o menor entre o limite proprio e o que resta do
  // orcamento compartilhado. Esgotado, nao se comeca a chamada.
  const teto = limiteExterno === undefined
    ? TIMEOUT_MS
    : Math.min(TIMEOUT_MS, limiteExterno.restanteMs());
  if (teto <= 0) return recusa("indisponivel");

  const controlador = new AbortController();
  const relogio = setTimeout(() => controlador.abort(), teto);
  const propagar = () => controlador.abort();
  const doOrcamento = limiteExterno?.signal;
  if (doOrcamento?.aborted) controlador.abort();
  else doOrcamento?.addEventListener("abort", propagar, { once: true });

  let resposta: Response;
  try {
    resposta = await buscar(url, {
      headers: { Authorization: `Bearer ${credencial.accessToken}` },
      signal: controlador.signal,
    });
  } catch {
    // Timeout e queda de rede dao o mesmo motivo: os dois significam
    // "nao consegui perguntar", e a acao de quem le e a mesma.
    return recusa("indisponivel");
  } finally {
    clearTimeout(relogio);
    doOrcamento?.removeEventListener("abort", propagar);
  }

  if (!resposta.ok) return recusa(classificarStatus(resposta.status));

  let corpo: unknown;
  try {
    corpo = await resposta.json();
  } catch {
    return recusa("resposta_invalida");
  }

  // A resposta pode vir como lista ou como envelope com lista. As duas
  // formas sao aceitas porque nenhuma das duas foi DESCARTADA por
  // evidencia; o que nao se aceita e qualquer outra coisa.
  const lista = Array.isArray(corpo)
    ? corpo
    : typeof corpo === "object" && corpo !== null &&
        Array.isArray((corpo as Record<string, unknown>).applications)
      ? ((corpo as Record<string, unknown>).applications as unknown[])
      : null;

  if (lista === null) return recusa("resposta_invalida");

  // A NOSSA aplicacao, por igualdade EXATA de string apos trim. Sem
  // coercao numerica solta, sem `includes`, sem prefixo, sem
  // case-insensitive: qualquer um deles transformaria "parece o nosso"
  // em "e o nosso".
  const nossa = lista.find((item) => {
    if (typeof item !== "object" || item === null) return false;
    const bruto = (item as Record<string, unknown>).app_id;
    if (typeof bruto !== "string" && typeof bruto !== "number") return false;
    return String(bruto).trim() === appId;
  });

  if (nossa === undefined) return recusa("grant_ausente");

  const scopes = (nossa as Record<string, unknown>).scopes;
  if (scopes === undefined) return recusa("grant_ausente");
  // Forma desconhecida e resposta invalida; forma conhecida SEM `read` e
  // ausencia de concessao. Sao fatos diferentes e pedem acoes diferentes.
  if (!Array.isArray(scopes) || !scopes.every((s) => typeof s === "string")) {
    return recusa("resposta_invalida");
  }
  if (!temEscopoRead(scopes)) return recusa("grant_ausente");

  return CONFIRMADA;
}
