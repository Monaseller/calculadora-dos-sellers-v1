/**
 * O cliente da inbox de perguntas — fino de proposito. I2.
 *
 * ── O que ele faz ───────────────────────────────────────────────────
 *
 * Recebe autoridade JA resolvida e perguntas JA filtradas, chama
 * `agente_perguntas_ml_upsert_lote` e le a resposta com rigor. Nada
 * alem disso.
 *
 * ── O que ele NAO faz ───────────────────────────────────────────────
 *
 * Nao resolve agente, nao resolve binding, nao decide qual loja, nao
 * chama marketplace, nao pagina e nao sabe o que e n8n. Se algum dia
 * precisar de uma dessas coisas, o lugar esta errado — quem resolve
 * autoridade e o executor, e quem orquestra e o servico de ingestao.
 *
 * ── Por que `p_user_id` e `p_loja_id` sao PARAMETROS ────────────────
 *
 * Eles nao viajam dentro das linhas. A RPC os usa para a guarda de
 * tenant ANTES de qualquer escrita — loja inexistente, alheia ou de
 * outro marketplace dao o mesmo 42501 — e a FK composta fecha o resto.
 * Coloca-los na linha faria cada item carregar autoridade propria, e
 * um lote com duas autoridades e exatamente o que nao pode existir.
 *
 * ── Fail-closed na leitura da resposta ──────────────────────────────
 *
 * A RPC devolve `jsonb`. Se vier fora de forma, este modulo NAO
 * completa com zero: um contador ausente lido como zero afirmaria que
 * nada foi gravado, e isso e pior do que admitir que nao sabemos.
 */
import "server-only";

import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";

/** O nome da RPC, num lugar so. */
export const RPC_UPSERT_LOTE = "agente_perguntas_ml_upsert_lote";

/** A forma de UMA pergunta no lote. Exatamente as cinco chaves da RPC. */
export interface LinhaParaInbox {
  readonly id_externo: string;
  readonly anuncio_id_externo: string;
  readonly texto: string;
  readonly provider_status: string;
  readonly criada_em_provider: string;
}

/** Os seis contadores que a RPC devolve. */
export interface MetricasPersistencia {
  readonly recebidas: number;
  readonly unicas: number;
  readonly duplicadas_no_lote: number;
  readonly novas: number;
  readonly atualizadas: number;
  readonly reobservadas: number;
}

const CONTADORES = [
  "recebidas",
  "unicas",
  "duplicadas_no_lote",
  "novas",
  "atualizadas",
  "reobservadas",
] as const;

export type ResultadoPersistencia =
  | { readonly tipo: "gravado"; readonly metricas: MetricasPersistencia }
  /**
   * `codigo` e o SQLSTATE quando a RPC recusou por contrato — `42501`
   * para loja inutilizavel, `22023` para lote invalido ou identidade do
   * provider divergente, `25000` para lote incompleto. Nunca a mensagem
   * crua: ela pode citar coluna, constraint e as vezes valor.
   */
  | { readonly tipo: "recusado"; readonly codigo: string }
  /**
   * ── Por que `resposta_rpc_fora_de_forma`, e nao `resposta_fora_de_forma` ──
   *
   * O nome curto colidia. `sincronizarPerguntas` usa exatamente a mesma
   * palavra quando o ENVELOPE DA FUNCAO vem fora de forma, e as duas
   * viajavam achatadas em `{ tipo: "erro", codigo }`. Quem registra o
   * desfecho da acao recebia uma string que podia significar "a Funcao
   * rompeu o contrato dela" ou "a RPC da inbox rompeu o dela" — duas
   * causas, duas acoes, e nenhuma forma de distinguir sem adivinhar pelo
   * estado em volta.
   *
   * O prefixo resolve na FONTE. Nenhum consumidor precisa inferir
   * procedencia depois.
   */
  | { readonly tipo: "erro"; readonly codigo: "falha_rpc" | "resposta_rpc_fora_de_forma" };

/**
 * A autoridade da gravacao. Vem inteira do executor que buscou as
 * perguntas — nunca de um segundo binding, nunca do chamador.
 */
export interface AutoridadeDaInbox {
  readonly userId: string;
  readonly lojaId: string;
}

function lerMetricas(bruto: unknown): MetricasPersistencia | null {
  if (typeof bruto !== "object" || bruto === null || Array.isArray(bruto)) return null;
  const o = bruto as Record<string, unknown>;
  const destino: Record<string, number> = {};
  for (const chave of CONTADORES) {
    const valor = o[chave];
    // Inteiro nao negativo, e nada mais. `"3"` nao vira 3: string aqui
    // e sinal de que a resposta mudou de forma, nao de que ha 3.
    if (typeof valor !== "number" || !Number.isInteger(valor) || valor < 0) return null;
    destino[chave] = valor;
  }
  return destino as unknown as MetricasPersistencia;
}

/**
 * Grava o lote. UMA chamada, atomica no banco.
 *
 * Lote vazio tambem chama a RPC, de proposito: e assim que a guarda de
 * tenant roda em TODA sincronizacao, e nao so quando ha pergunta. Uma
 * loja que deixou de servir aparece no ciclo seguinte, nao no dia em
 * que a primeira pergunta chegar. As metricas continuam vindo de uma
 * fonte so, entao "zero" tem sempre o mesmo significado.
 */
export async function gravarPerguntasNaInbox(
  autoridade: AutoridadeDaInbox,
  linhas: readonly LinhaParaInbox[],
  /** OPCIONAL. O sinal RIGIDO da acao — nunca o do provider. */
  signal?: AbortSignal
): Promise<ResultadoPersistencia> {
  const chamada = getSupabaseServidor().rpc(RPC_UPSERT_LOTE, {
    p_user_id: autoridade.userId,
    p_loja_id: autoridade.lojaId,
    p_perguntas: linhas,
  });
  const { data, error } = await (signal === undefined
    ? chamada : chamada.abortSignal(signal));

  if (error) {
    // Sem `error.message`: mensagem de driver vaza nome de coluna, de
    // constraint e as vezes de valor. O SQLSTATE ja e vocabulario
    // fechado, e e ele que diz se foi recusa de contrato ou falha.
    const codigo = typeof error.code === "string" ? error.code : "";
    if (codigo === "42501" || codigo === "22023" || codigo === "25000") {
      return { tipo: "recusado", codigo };
    }
    console.error("[perguntas-inbox] falha ao gravar lote");
    return { tipo: "erro", codigo: "falha_rpc" };
  }

  const metricas = lerMetricas(data);
  if (metricas === null) return { tipo: "erro", codigo: "resposta_rpc_fora_de_forma" };

  return { tipo: "gravado", metricas };
}
