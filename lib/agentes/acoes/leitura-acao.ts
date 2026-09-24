/**
 * A RECONCILIACAO de uma acao pela identidade da tentativa — I4C.
 *
 * ── Para que serve ──────────────────────────────────────────────────
 *
 * Sob semantica at-least-once, o mesmo pedido chega duas vezes. A
 * primeira defesa e o indice unico da abertura, e ela e suficiente para
 * impedir a SEGUNDA varredura — mas nao para RESPONDER a segunda
 * chamada. Quem pergunta de novo recebia so "ja processado", que nao diz
 * se a primeira deu certo, deu errado ou ainda esta rodando.
 *
 * Este modulo responde essa pergunta lendo o registro duravel. Nenhum
 * cache, nenhum estado de processo: a resposta vem das linhas, e por isso
 * sobrevive a um restart do servidor entre as duas chamadas.
 *
 * ── O que ele NAO e ─────────────────────────────────────────────────
 *
 * Nao e API de consulta do ledger. Nao ha filtro por periodo, por agente
 * ou por status; nao ha listagem e nao ha paginacao. Ele responde UMA
 * pergunta sobre UMA identidade, e a identidade e montada no servidor.
 *
 * Nao e porta de escrita. `agente_acao_execucoes` continua com uma unica
 * porta de escrita, `auditoria-acao.ts`, e este arquivo so le.
 *
 * ── Como as duas linhas se encontram ────────────────────────────────
 *
 * A abertura e localizada por `(user_id, acao_id, idempotency_key)` —
 * exatamente as colunas de `idx_agente_acao_execucoes_tentativa`.
 *
 * O desfecho NAO pode ser localizado pela mesma chave: ele grava
 * `idempotency_key` NULL de proposito, para nao colidir com a propria
 * abertura no indice de tentativa. Ele e localizado pelo `request_id`
 * que a abertura carrega, que e a coluna de
 * `idx_agente_acao_execucoes_desfecho_unico`.
 *
 * Abertura -> request_id -> desfecho. Duas leituras indexadas, nessa
 * ordem, e nenhuma varredura.
 *
 * ── Por que `limit(2)` e nao `maybeSingle` ──────────────────────────
 *
 * Os dois indices unicos tornam a segunda linha impossivel. "Impossivel"
 * aqui significa "impossivel enquanto o indice existir": se ele for
 * removido numa manutencao, `maybeSingle` devolveria erro de driver e a
 * rota leria isso como banco indisponivel — um estado que pede retry.
 * Ler duas e ver que vieram duas nomeia o que de fato aconteceu, e leva
 * a um estado que NAO pede retry.
 */
import "server-only";

import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";

import {
  CODIGOS_POR_STATUS,
  projetarResumoDaAcao,
  type AcaoAuditavel,
  type StatusTerminalAcao,
} from "./auditoria-acao";

const TABELA_ACOES = "agente_acao_execucoes";

const COLUNAS_ABERTURA = "request_id, agente_id, status, criado_em";
const COLUNAS_DESFECHO = "agente_id, status, codigo_desfecho, entrada_resumo, criado_em";

/** A identidade, TODA derivada no servidor. Nada aqui vem do corpo. */
export interface IdentidadeDaAcao {
  readonly userId: string;
  readonly acaoId: AcaoAuditavel;
  readonly idempotencyKey: string;
  /** OPCIONAL. O sinal rigido, quando quem le tem relogio. */
  readonly signal?: AbortSignal;
}

/** O desfecho, como o banco o guardou. */
export interface DesfechoDuravel {
  readonly status: StatusTerminalAcao;
  readonly codigo: string | null;
  /** Somente escalares, pela allowlist de `auditoria-acao.ts`. */
  readonly resumo: Record<string, number | boolean>;
}

export type EstadoDaAcao =
  /** Nenhuma abertura. A operacao nunca comecou — pode executar. */
  | { readonly estado: "nao_iniciada" }
  /**
   * Abertura e desfecho. Terminou, e sabemos COMO.
   *
   * `requestId` e o da ACAO ORIGINAL — o mesmo das duas linhas. Nao e um
   * id novo: um id novo passaria por original numa superficie que existe
   * exatamente para nao mentir.
   */
  | {
      readonly estado: "concluida";
      readonly requestId: string;
      readonly desfecho: DesfechoDuravel;
    }
  /**
   * Abertura sem desfecho. A ORFA.
   *
   * `idadeMs` sai do carimbo DURAVEL da abertura. Quem classifica a orfa
   * por idade e quem chama — a politica e de produto, nao de leitura.
   */
  | { readonly estado: "aberta"; readonly requestId: string; readonly idadeMs: number }
  /**
   * O ledger diz algo que o contrato torna impossivel. FAIL CLOSED.
   *
   * Nao e "nao sei ainda": e "o que esta gravado nao pode ser verdade".
   * Executar sobre isso seria agir com base num registro que ja se sabe
   * inconsistente, e um retry nao melhora nada.
   */
  | { readonly estado: "conflito"; readonly motivo: MotivoDoConflito }
  /** O banco nao respondeu. Estado DESCONHECIDO, nunca "nao iniciada". */
  | { readonly estado: "falhou_leitura" };

export type MotivoDoConflito =
  | "aberturas_duplicadas"
  | "desfechos_duplicados"
  | "abertura_sem_request_id"
  | "abertura_com_status_invalido"
  | "carimbo_invalido"
  | "agente_divergente"
  | "status_desconhecido"
  | "codigo_incompativel";

const FALHOU_LEITURA = { estado: "falhou_leitura" } as const;

function conflito(motivo: MotivoDoConflito): EstadoDaAcao {
  return { estado: "conflito", motivo };
}

function texto(valor: unknown): string | null {
  return typeof valor === "string" && valor.trim().length > 0 ? valor : null;
}

/**
 * O par `(status, codigo)` que o banco devolveu e um par do CONTRATO?
 *
 * A mesma checagem que `registrarDesfechoAcao` faz na escrita, refeita na
 * leitura. Nao e desconfianca do CHECK: e que o CHECK de hoje pode nao
 * ser o CHECK que gravou a linha, e uma combinacao que nao existe mais no
 * vocabulario nao deve virar resposta de rota so porque um dia coube.
 */
function parValido(status: string, codigo: string | null): boolean {
  const aceitos = (CODIGOS_POR_STATUS as Record<string, readonly string[]>)[status];
  if (aceitos === undefined) return false;
  if (aceitos.length === 0) return codigo === null;
  return codigo !== null && aceitos.includes(codigo);
}

/**
 * Le o estado duravel de UMA tentativa.
 *
 * Duas consultas indexadas, ambas filtradas por `user_id`: a leitura
 * nunca alcanca linha de outro dono, mesmo que a chave colidisse.
 */
export async function lerEstadoDaAcaoPorIdempotencia(
  identidade: IdentidadeDaAcao
): Promise<EstadoDaAcao> {
  // Entrada vazia e defeito NOSSO, nao inconsistencia do ledger: vira
  // leitura falha, que a rota traduz em 500, e nao em 409.
  if (texto(identidade.userId) === null) return FALHOU_LEITURA;
  if (texto(identidade.idempotencyKey) === null) return FALHOU_LEITURA;

  const cliente = getSupabaseServidor();

  const consultaAbertura = cliente
    .from(TABELA_ACOES)
    .select(COLUNAS_ABERTURA)
    .eq("user_id", identidade.userId)
    .eq("acao_id", identidade.acaoId)
    .eq("idempotency_key", identidade.idempotencyKey)
    .eq("fase", "abertura")
    .limit(2);

  const aberturas = await (identidade.signal === undefined
    ? consultaAbertura
    : consultaAbertura.abortSignal(identidade.signal));

  if (aberturas.error) {
    // Sem `error.message`: mensagem de driver vaza nome de coluna e as
    // vezes valor.
    console.error("[acoes] falha ao ler a abertura para reconciliacao");
    return FALHOU_LEITURA;
  }

  const linhasAbertura = (aberturas.data ?? []) as ReadonlyArray<Record<string, unknown>>;
  if (linhasAbertura.length === 0) return { estado: "nao_iniciada" };
  if (linhasAbertura.length > 1) return conflito("aberturas_duplicadas");

  const abertura = linhasAbertura[0];
  const requestId = texto(abertura.request_id);
  if (requestId === null) return conflito("abertura_sem_request_id");
  // `fase='abertura'` implica `status='executando'` pelo CHECK
  // `fase_casa_status`. Uma linha que diga outra coisa nao e uma abertura.
  if (abertura.status !== "executando") return conflito("abertura_com_status_invalido");

  const consultaDesfecho = cliente
    .from(TABELA_ACOES)
    .select(COLUNAS_DESFECHO)
    .eq("user_id", identidade.userId)
    .eq("request_id", requestId)
    .eq("fase", "desfecho")
    .limit(2);

  const desfechos = await (identidade.signal === undefined
    ? consultaDesfecho
    : consultaDesfecho.abortSignal(identidade.signal));

  if (desfechos.error) {
    console.error("[acoes] falha ao ler o desfecho para reconciliacao");
    return FALHOU_LEITURA;
  }

  const linhasDesfecho = (desfechos.data ?? []) as ReadonlyArray<Record<string, unknown>>;
  if (linhasDesfecho.length > 1) return conflito("desfechos_duplicados");

  if (linhasDesfecho.length === 0) {
    // ── A idade vem do carimbo DURAVEL ────────────────────────────────
    //
    // `criado_em` e `now()` do Postgres no instante do insert, nunca um
    // valor que alguem mandou. O `executionId` do chamador e o relogio
    // dele estao fora desta conta de proposito: os dois sao de fora.
    //
    // A COMPARACAO usa o relogio deste processo, e isso e assumido: para
    // ela errar seria preciso uma deriva de minutos entre o servidor da
    // aplicacao e o do banco, ambos em UTC e sincronizados por NTP.
    const nascimento = Date.parse(String(abertura.criado_em ?? ""));
    if (!Number.isFinite(nascimento)) return conflito("carimbo_invalido");
    return { estado: "aberta", requestId, idadeMs: Math.max(0, Date.now() - nascimento) };
  }

  const desfecho = linhasDesfecho[0];

  // Abertura de um agente e desfecho de OUTRO nao e uma execucao — e
  // duas metades de execucoes diferentes que compartilharam um id.
  if (desfecho.agente_id !== abertura.agente_id) return conflito("agente_divergente");

  const status = texto(desfecho.status);
  if (status === null) return conflito("status_desconhecido");
  const codigo = texto(desfecho.codigo_desfecho);
  if (!(status in CODIGOS_POR_STATUS)) return conflito("status_desconhecido");
  if (!parValido(status, codigo)) return conflito("codigo_incompativel");

  return {
    estado: "concluida",
    requestId,
    desfecho: {
      status: status as StatusTerminalAcao,
      codigo,
      resumo: projetarResumoDaAcao(desfecho.entrada_resumo),
    },
  };
}
