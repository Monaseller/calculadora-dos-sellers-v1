/**
 * OBS-5 R1 — a porta do lease do vigia.
 *
 * ── O TTL NAO E ESCOLHIDO, E DERIVADO ───────────────────────────────
 *
 * A rota declara `maxDuration = 60`, e a Vercel corta ali de qualquer
 * forma. O lease e adquirido DENTRO da execucao, entao a vida legitima
 * de um portador e menor que 60 s — nunca maior.
 *
 * O TTL entao precisa de dois lados:
 *
 *   piso — exceder com folga a vida legitima maxima, senao uma execucao
 *          viva perderia o direito para a seguinte e as duas avaliariam
 *          juntas, que e o defeito que este modulo existe para impedir;
 *   teto — nao prender o vigia por muitos minutos depois de uma morte
 *          abrupta, porque durante o lease vencido ninguem avalia.
 *
 * 90 s = 60 s de orcamento + 30 s de margem. A margem cobre a diferenca
 * entre o relogio do Postgres e o tempo decorrido dentro da funcao, e o
 * fato de a plataforma nao prometer matar no milissegundo exato. O custo
 * de uma morte abrupta fica em uma ou duas rodadas puladas — para um
 * watchdog idempotente que roda a cada minuto, isso e latencia, nao
 * perda: a rodada seguinte reavalia a janela inteira.
 */
import "server-only";

import { randomUUID } from "node:crypto";

import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";

import type { AquisicaoDaSerializacao, EscopoDaSerializacao } from "./monitor-ingestao";

const RPC_ADQUIRIR = "adquirir_lease_monitor_ingestao";
const RPC_LIBERAR = "liberar_lease_monitor_ingestao";

/** Derivado do `maxDuration` da rota. Ver o cabecalho. */
export const TTL_DO_LEASE_SEGUNDOS = 90;

function primeiraLinha(data: unknown): Record<string, unknown> | null {
  const bruta = Array.isArray(data) ? data[0] : data;
  if (typeof bruta !== "object" || bruta === null) return null;
  return bruta as Record<string, unknown>;
}

export async function adquirirLeaseDoMonitor(
  escopo: EscopoDaSerializacao
): Promise<AquisicaoDaSerializacao> {
  // O portador nasce AQUI, opaco e por execucao. Nao e parametro de
  // ninguem: se viesse de fora, quem chamasse poderia se passar pelo
  // portador atual e liberar o lease de outra execucao.
  const portador = randomUUID();

  const { data, error } = await getSupabaseServidor().rpc(RPC_ADQUIRIR, {
    p_user_id: escopo.userId,
    p_agente_id: escopo.agenteId,
    p_plataforma: escopo.plataforma,
    p_recurso: escopo.recurso,
    p_portador: portador,
    p_ttl_segundos: TTL_DO_LEASE_SEGUNDOS,
  });

  if (error) {
    // Sem `error.message`: mensagem de driver vaza nome de coluna.
    console.error("[monitor-ingestao] falha ao adquirir o lease do vigia");
    return { estado: "falhou" };
  }

  const linha = primeiraLinha(data);
  // Forma inesperada NAO vira "adquirido": avaliar sem o direito e
  // exatamente a corrida que o lease existe para impedir.
  if (linha === null || typeof linha.adquirida !== "boolean") {
    console.error("[monitor-ingestao] o lease do vigia veio fora de forma");
    return { estado: "falhou" };
  }

  if (!linha.adquirida) return { estado: "ocupada" };

  return {
    estado: "adquirida",
    portador,
    expiraEm: typeof linha.expira_em === "string" ? linha.expira_em : null,
    tomadaDeExpirada: linha.tomada_de_expirada === true,
  };
}

/**
 * Libera antes da hora. MELHOR ESFORCO, de proposito: quem garante e a
 * expiracao. Falhar aqui atrasa a proxima avaliacao, nunca corrompe —
 * entao nao ha motivo para derrubar uma rodada que ja terminou.
 */
export async function liberarLeaseDoMonitor(
  escopo: EscopoDaSerializacao,
  portador: string
): Promise<void> {
  const { error } = await getSupabaseServidor().rpc(RPC_LIBERAR, {
    p_user_id: escopo.userId,
    p_agente_id: escopo.agenteId,
    p_plataforma: escopo.plataforma,
    p_recurso: escopo.recurso,
    p_portador: portador,
  });

  if (error) {
    console.error("[monitor-ingestao] falha ao liberar o lease do vigia");
  }
}
