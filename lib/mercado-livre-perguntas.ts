/**
 * Perguntas recebidas — a fronteira com o Mercado Livre, M2-I1-A2.
 *
 * ── A pergunta que este modulo responde ─────────────────────────────
 *
 *   "o que a API do Mercado Livre devolve para esta conta, agora?"
 *
 * E ele e o UNICO lugar deste caminho que sabe que existe um token. O
 * dominio (`lib/agentes/dados/perguntas.ts`) recebe itens e devolve
 * itens; o executor recebe um binding e devolve um envelope; nenhum dos
 * dois tem como pedir uma credencial, porque nenhum dos dois a ve.
 *
 * ── Por que `/my/received_questions/search` ─────────────────────────
 *
 * O `/my/` resolve o vendedor pelo PROPRIO token e elimina `seller_id`
 * da entrada. Um endpoint que aceitasse o vendedor por parametro
 * transformaria um id em autoridade: bastaria trocar o numero para
 * perguntar pela conta de outro. Aqui isso nao tem por onde acontecer.
 *
 * ── O contrato de RESPOSTA nao foi verificado ───────────────────────
 *
 * A auditoria M2-A3 mediu 403 nas paginas de referencia do ML e este
 * slice nao tem autorizacao para chamada real. Entao a forma da resposta
 * e HIPOTESE, e este modulo trata como tal: nao ha cast, nao ha
 * `as any`, e nada que nao chegue na forma esperada vira valor. O que
 * este modulo garante e o ENVELOPE (`itens`, `haMais`, `erro`); o que
 * cada item contem e conferido campo a campo pelo dominio.
 *
 * ── O que ele NAO faz ───────────────────────────────────────────────
 *
 * Nao escreve no marketplace, nao responde pergunta, nao altera anuncio,
 * nao persiste nada, nao cria tabela, nao guarda token e nao implementa
 * OAuth: a credencial e resolvida pelo dono dela, `getMLLojaById`, que
 * ja existe e ja trata renovacao.
 *
 * Tambem NAO confirma cobertura. Esta Funcao existir e o adapter
 * funcionar nao torna `ML_COVERAGE = confirmada`: o grant remoto e
 * `GET /users/$SELLER_ID/applications` continuam fora deste slice.
 */
import "server-only";
import type { LimiteExterno } from "@/lib/controle-tempo";
import { getMLLojaById } from "@/lib/ml-auth";

const BASE_ML = "https://api.mercadolibre.com";
const CAMINHO_PERGUNTAS = "/my/received_questions/search";

/** Orcamento explicito, como toda operacao externa deste repositorio. */
const TIMEOUT_MS = 20_000;

/**
 * Os codigos de falha. Vocabulario FECHADO.
 *
 * Nenhum deles carrega status HTTP cru, corpo, header ou mensagem do
 * provider. `credencial_ausente` e `credencial_expirada` sao internos e
 * acionaveis pelo dono; os quatro seguintes descrevem o que aconteceu
 * com a chamada, no grao em que o agente pode agir.
 *
 * `nao_autorizado` cobre 401 E 403 de proposito: a auditoria M2-A4 ja
 * congelou que 403 no ML e ambiguo demais para virar diagnostico
 * especifico — pode ser escopo, permissao de app ou recurso alheio.
 */
export type ErroPerguntasML =
  | "credencial_ausente"
  | "nao_autorizado"
  | "limite_excedido"
  | "indisponivel"
  | "resposta_invalida";

/** O envelope cru: itens ainda NAO normalizados, mais o que se sabe da pagina. */
export interface ResultadoBrutoPerguntasML {
  readonly itens: readonly unknown[];
  /** `true` quando o provider indicou total maior do que o pedido. */
  readonly haMais: boolean;
  readonly erro: ErroPerguntasML | null;
}

/** A conta e o recorte. `sellerId` NAO entra: o `/my/` o dispensa. */
export interface EntradaPerguntasML {
  readonly userId: string;
  readonly lojaId: string;
  readonly status: string | null;
  readonly limite: number;
  readonly deslocamento: number;
}

/**
 * As duas fronteiras injetaveis — e SO elas.
 *
 * Existem para as suites, que nao podem tocar rede nem banco. Producao
 * nunca passa o parametro. Nao ha porta para base URL, para caminho nem
 * para token: uma delas transformaria o chamador em quem decide contra
 * qual servidor, com qual credencial, a CDS fala.
 */
export interface PortasPerguntasML {
  readonly resolverCredencial?: (
    lojaId: string,
    userId: string,
    /** O orcamento compartilhado, quando quem chama o tem. */
    limiteExterno?: LimiteExterno
  ) => Promise<{ accessToken: string } | null>;
  readonly buscar?: typeof fetch;
}

const VAZIO: ResultadoBrutoPerguntasML = Object.freeze({
  itens: Object.freeze([]) as readonly unknown[],
  haMais: false,
  erro: null,
});

const falha = (erro: ErroPerguntasML): ResultadoBrutoPerguntasML =>
  Object.freeze({ itens: VAZIO.itens, haMais: false, erro });

/**
 * Status HTTP -> codigo fechado.
 *
 * `res.ok` nunca chega aqui. E uma traducao, nao uma mensagem: o texto
 * do provider pode conter id de recurso, nickname e ate fragmento de
 * token em erro de autenticacao, e nada disso pode subir.
 */
function classificarStatus(status: number): ErroPerguntasML {
  if (status === 401 || status === 403) return "nao_autorizado";
  if (status === 429) return "limite_excedido";
  return "indisponivel";
}

/**
 * Busca as perguntas recebidas da conta ligada a `lojaId`.
 *
 * ── A ordem dos passos, e por que ela e essa ────────────────────────
 *
 * Credencial PRIMEIRO. Sem token nao ha chamada a fazer, e tentar a rede
 * para descobrir isso gastaria uma ida ao provider para responder algo
 * que o banco ja sabia. `getMLLojaById` tambem filtra por
 * `marketplace: 'ML'` e por dono — uma loja Shopee, ou de outro usuario,
 * simplesmente nao volta, e vira `credencial_ausente`.
 *
 * ── Zero retry ──────────────────────────────────────────────────────
 *
 * Mesma regra dos provedores de IA: retry e decisao de quem orquestra,
 * nao do cliente. Repetir aqui multiplicaria chamada sob 429 — o
 * codigo exato que existe para pedir o contrario.
 */
export async function buscarPerguntasRecebidasML(
  entrada: EntradaPerguntasML,
  portas?: PortasPerguntasML,
  /** OPCIONAL. O orcamento COMPARTILHADO do provider. */
  limiteExterno?: LimiteExterno
): Promise<ResultadoBrutoPerguntasML> {
  const { userId, lojaId, status, limite, deslocamento } = entrada;

  if (!userId || !lojaId) return falha("credencial_ausente");

  const resolver = portas?.resolverCredencial ?? getMLLojaById;
  const buscar = portas?.buscar ?? fetch;

  let credencial: { accessToken: string } | null;
  try {
    // O orcamento viaja junto: uma renovacao de token disparada aqui
    // nao pode abrir 20 s proprios com a acao quase vencida.
    credencial = await resolver(lojaId, userId, limiteExterno);
  } catch {
    // Falha ao RESOLVER credencial e infraestrutura nossa, nao recusa do
    // provider. Sem `error.message`: a mensagem do driver vaza coluna e
    // as vezes valor.
    console.error("[ml-perguntas] falha ao resolver credencial da loja");
    return falha("indisponivel");
  }

  if (credencial === null || !credencial.accessToken) return falha("credencial_ausente");

  const url = new URL(CAMINHO_PERGUNTAS, BASE_ML);
  url.searchParams.set("limit", String(limite));
  url.searchParams.set("offset", String(deslocamento));
  if (status !== null) url.searchParams.set("status", status);

  // O teto EFETIVO: o menor entre o limite proprio e o que resta do
  // orcamento compartilhado. Esgotado, nao se comeca a chamada — e o
  // codigo e `indisponivel`, o mesmo de qualquer "nao consegui
  // perguntar".
  const teto = limiteExterno === undefined
    ? TIMEOUT_MS
    : Math.min(TIMEOUT_MS, limiteExterno.restanteMs());
  if (teto <= 0) return falha("indisponivel");

  const controlador = new AbortController();
  const relogio = setTimeout(() => controlador.abort(), teto);
  const propagar = () => controlador.abort();
  const doOrcamento = limiteExterno?.signal;
  if (doOrcamento?.aborted) controlador.abort();
  else doOrcamento?.addEventListener("abort", propagar, { once: true });

  let resposta: Response;
  try {
    resposta = await buscar(url.toString(), {
      headers: { Authorization: `Bearer ${credencial.accessToken}` },
      signal: controlador.signal,
    });
  } catch {
    // Timeout e queda de rede dao o MESMO codigo: os dois significam "nao
    // consegui perguntar", e distingui-los nao muda a acao de ninguem.
    return falha("indisponivel");
  } finally {
    clearTimeout(relogio);
    doOrcamento?.removeEventListener("abort", propagar);
  }

  if (!resposta.ok) return falha(classificarStatus(resposta.status));

  let corpo: unknown;
  try {
    corpo = await resposta.json();
  } catch {
    return falha("resposta_invalida");
  }

  if (typeof corpo !== "object" || corpo === null || Array.isArray(corpo)) {
    return falha("resposta_invalida");
  }

  const envelope = corpo as Record<string, unknown>;
  const itens = envelope.questions;
  if (!Array.isArray(itens)) return falha("resposta_invalida");

  // `total` e uma DICA, nao autoridade: se vier ausente ou fora de forma,
  // a comparacao de tamanho da pagina ainda responde "havia mais?". O que
  // nao se faz e assumir `false` por omissao — isso apresentaria uma
  // pagina como a lista inteira.
  const total = envelope.total;
  const haMais =
    typeof total === "number" && Number.isFinite(total)
      ? deslocamento + itens.length < total
      : itens.length >= limite;

  return Object.freeze({ itens: Object.freeze([...itens]), haMais, erro: null });
}
