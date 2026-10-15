/**
 * Vendas A3.3 — VOLUME do Mercado Livre: datas, status e a métrica comparável ao painel do ML. Puro (sem I/O): o sync
 * grava com estas regras e a rota de Vendas calcula com elas.
 *
 * Auditoria real (07–14/10/2026, loja 744240004, mesmo momento do print do ML):
 *   - `date_created`/`date_approved` chegam com offset −04:00; a data da venda é a do instante em BRT (UTC−3, sem
 *     horário de verão) — truncar a string põe as vendas de 00:00–00:59 BRT no dia anterior;
 *   - pedido `paid` com pagamento `in_mediation` tem `date_approved` válido (pagamento já aprovado, depois em disputa);
 *   - "Vendas brutas" do painel ML = pedidos CRIADOS no período (BRT), inclusive cancelados depois, MENOS os cancelados
 *     `internal|pack_splitted` (o carrinho foi dividido em pedidos novos, que representam a venda) — reproduziu
 *     1517 / 1608 / 57.408,29 contra 1518 / 1609 / 57.430,00 do print (resíduo de 1 pedido / R$ 21,71 é da camada
 *     de relatório do ML e NÃO vira regra);
 *   - "canceladas" = cancelamentos reais (grupo `internal` fora) — reproduziu exatamente as 63 do print.
 */

/** Status gravados em `pedidos.status` para o ML. Os dois últimos são cancelamentos TÉCNICOS do provider (grupo internal). */
export type StatusPedidoML = "paid" | "pending" | "cancelled" | "devolucao" | "pack_dividido" | "cancelado_interno";

const BRT_MS = 3 * 60 * 60 * 1000;

/** Data (AAAA-MM-DD) do INSTANTE em America/Sao_Paulo (UTC−3 fixo desde 2019). null se ausente/ilegível. */
export function dataBRT(iso: unknown): string | null {
  if (iso === null || iso === undefined || iso === "") return null;
  const t = Date.parse(String(iso));
  return Number.isFinite(t) ? new Date(t - BRT_MS).toISOString().slice(0, 10) : null;
}

/**
 * Estados de pagamento com aprovação COMPROVADA (auditados): approved, partially_refunded e in_mediation (disputa aberta
 * depois da aprovação — `date_approved` presente). Nenhum outro estado gera data de pagamento.
 */
export const STATUS_PAGAMENTO_APROVADO_ML = ["approved", "partially_refunded", "in_mediation"] as const;

/** Pagamento aprovado do pedido (o primeiro com estado comprovado E `date_approved`), ou null. */
export function pagamentoAprovadoML(payments: unknown): { date_approved: string } | null {
  const lista: any[] = Array.isArray(payments) ? payments : [];
  return lista.find((p) => (STATUS_PAGAMENTO_APROVADO_ML as readonly string[]).includes(p?.status) && !!p?.date_approved) ?? null;
}

/**
 * Status do pedido pelo status consultado no provider + `cancel_detail`. Cancelado `pack_splitted` → `pack_dividido`
 * (a venda está nos pedidos que o substituíram); outro cancelamento do grupo `internal` → `cancelado_interno`
 * (venda bruta, mas não cancelamento do comprador); cancelado com pagamento reembolsado → `devolucao`; senão `cancelled`.
 */
export function statusPedidoML(statusConsultado: string, order: any): StatusPedidoML {
  if (statusConsultado === "cancelled") {
    const cd = order?.cancel_detail;
    if (cd?.code === "pack_splitted") return "pack_dividido";
    if (cd?.group === "internal") return "cancelado_interno";
    const reembolsado = (order?.payments ?? []).some((p: any) => p?.status === "refunded" || p?.status === "partially_refunded");
    return reembolsado ? "devolucao" : "cancelled";
  }
  if (statusConsultado === "confirmed" || statusConsultado === "payment_in_process") return "pending";
  return "paid";
}

/** Status que contam em VENDAS BRUTAS ML (pedido criado e não substituído). `pending` fica fora: sem evidência no painel. */
export const STATUS_VENDA_BRUTA_ML: readonly StatusPedidoML[] = ["paid", "cancelled", "devolucao", "cancelado_interno"];
/** Status que contam em CANCELADAS (cancelamento real; o grupo internal fica fora, como no painel). */
export const STATUS_CANCELADA_ML: readonly StatusPedidoML[] = ["cancelled", "devolucao"];

export interface MetricasBrutasML { pedidos: number; unidades: number; bruto: number; canceladas: number }

/**
 * VENDAS BRUTAS ML sobre as linhas de `pedidos` já filtradas pela janela de CRIAÇÃO (BRT): pedidos = order_id distintos
 * (nunca pack), unidades = Σ qtd, bruto = Σ faturamento (= unit_price × quantity por linha), canceladas à parte.
 */
export function metricasBrutasML(linhas: ReadonlyArray<{ order_id: string; status: string | null; qtd: unknown; faturamento: unknown }>): MetricasBrutasML {
  const pedidos = new Set<string>(), canceladas = new Set<string>();
  let unidades = 0, bruto = 0;
  for (const r of linhas) {
    if (!(STATUS_VENDA_BRUTA_ML as readonly string[]).includes(String(r.status))) continue;
    pedidos.add(String(r.order_id));
    unidades += Number(r.qtd) || 0;
    bruto += Number(r.faturamento) || 0;
    if ((STATUS_CANCELADA_ML as readonly string[]).includes(String(r.status))) canceladas.add(String(r.order_id));
  }
  return { pedidos: pedidos.size, unidades, bruto: Math.round(bruto * 100) / 100, canceladas: canceladas.size };
}
