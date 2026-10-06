/**
 * Order crua da API → linha de `ml_pedidos` (puro). A regra vem do servico
 * canonico (`normalizarPedidoML`): aqui so se acrescentam os carimbos que
 * o corpus guarda (date_created, last_updated, fetched_at) e o recorte do
 * DIA de fechamento em Sao Paulo — o mesmo da varredura homologada.
 * pack_splitted NAO e omitido: o corpus guarda a populacao real; a
 * exclusao e da camada canonica.
 */
import { normalizarPedidoML } from "@/lib/vendas/canonico/ml";
import type { LinhaPedidoML } from "./tipos";

const iso = (v: unknown): string | null => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/**
 * Pedidos fechados no `dia` (Sao Paulo), deduplicados por order_id, como
 * linhas do corpus. O filtro da API vaza pedido do dia seguinte na borda
 * (medido): quem recorta e o dia em Sao Paulo.
 */
export function linhasDoDia(
  brutos: readonly Record<string, unknown>[],
  ctx: { userId: string; lojaId: string; dia: string; agoraIso: string },
): { linhas: LinhaPedidoML[]; foraDoDia: number; duplicados: number } {
  const porId = new Map<string, LinhaPedidoML>();
  let fora = 0, dup = 0;
  for (const o of brutos) {
    const n = normalizarPedidoML(o);
    if (n.pedidoId === "" || n.diaFechamento !== ctx.dia) { fora++; continue; }
    if (porId.has(n.pedidoId)) { dup++; continue; }
    porId.set(n.pedidoId, {
      user_id: ctx.userId, loja_id: ctx.lojaId, order_id: n.pedidoId,
      date_created: iso(o.date_created), date_closed: n.dateClosed, last_updated: iso(o.last_updated),
      status: n.status || null, cancel_detail_code: n.cancelCode,
      total_amount: n.valor, unidades: n.unidades, fetched_at: ctx.agoraIso,
    });
  }
  return { linhas: [...porId.values()], foraDoDia: fora, duplicados: dup };
}
