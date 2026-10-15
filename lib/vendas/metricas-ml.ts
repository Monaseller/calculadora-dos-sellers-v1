/**
 * Vendas A3.3/A3.4 — datas e STATUS do Mercado Livre. Puro (sem I/O): o sync grava com estas regras e a tabela
 * (provider) classifica com elas. A3.4: a MÉTRICA comparável ao painel do ML (Vendas / Unidades / Vendas brutas) NÃO
 * mora aqui — é SÓ do serviço canônico (`lib/vendas/canonico/ml.ts`: `order.date_closed` BRT, sem `pack_splitted`);
 * a antiga métrica por criação sobre `pedidos` foi removida (uma segunda fórmula derivaria).
 *
 * Auditoria real (07–14/10/2026, loja 744240004, mesmo momento do print do ML):
 *   - `date_created`/`date_approved` chegam com offset −04:00; a data da venda é a do instante em BRT (UTC−3, sem
 *     horário de verão) — truncar a string põe as vendas de 00:00–00:59 BRT no dia anterior;
 *   - pedido `paid` com pagamento `in_mediation` tem `date_approved` válido (pagamento já aprovado, depois em disputa);
 *   - cancelado `internal|pack_splitted`: o carrinho foi dividido em pedidos novos, que representam a venda;
 *   - "canceladas" = cancelamentos reais (grupo `internal` fora) — reproduziu as 63 do print; SÓ contagem interna
 *     (API_CANCELLED_COUNT): o painel do ML não é reproduzível e a tela não tem card de canceladas.
 */
import { CANCELAMENTO_DE_PACOTE_REFEITO, codigoDeCancelamentoML } from "@/lib/vendas/canonico/ml";

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

/** Pagamento aprovado do pedido (o primeiro com estado comprovado E `date_approved`), ou null. Usado pelo sync. */
export function pagamentoAprovadoML(payments: unknown): { date_approved: string } | null {
  const lista: any[] = Array.isArray(payments) ? payments : [];
  return lista.find((p) => (STATUS_PAGAMENTO_APROVADO_ML as readonly string[]).includes(p?.status) && !!p?.date_approved) ?? null;
}

/**
 * A3.4 (visão PAGA da tabela): o instante da aprovação MAIS ANTIGA entre os pagamentos elegíveis (estado comprovado E
 * `date_approved` válido), comparando INSTANTES — nunca a ordem do array nem o texto (offsets diferentes). Um segundo
 * pagamento aprovado depois não empurra a venda para a frente. null = sem aprovação elegível.
 */
export function aprovacaoElegivelMaisAntigaML(payments: unknown): string | null {
  let maisAntigo: number | null = null;
  for (const p of Array.isArray(payments) ? payments : []) {
    if (typeof p !== "object" || p === null) continue;
    const { status, date_approved } = p as Record<string, unknown>;
    if (!(STATUS_PAGAMENTO_APROVADO_ML as readonly string[]).includes(String(status))) continue;
    if (typeof date_approved !== "string" || date_approved === "") continue;
    const t = Date.parse(date_approved);
    if (Number.isFinite(t) && (maisAntigo === null || t < maisAntigo)) maisAntigo = t;
  }
  return maisAntigo === null ? null : new Date(maisAntigo).toISOString();
}

/** A3.4: status do provider que são VENDA paga (o estorno parcial não desfaz a venda). */
export const STATUS_ML_PAGO = ["paid", "partially_refunded"] as const;
/** A3.4: status do provider de pedido ainda sem pagamento confirmado. */
export const STATUS_ML_PENDENTE = ["confirmed", "payment_in_process", "payment_required", "partially_paid"] as const;

/**
 * Status do pedido pelo `order.status` do PROVIDER + `cancel_detail`. Cancelado `pack_splitted` → `pack_dividido`
 * (a venda está nos pedidos que o substituíram); outro cancelamento do grupo `internal` → `cancelado_interno`
 * (venda bruta, mas não cancelamento do comprador); cancelado com pagamento reembolsado → `devolucao`; senão `cancelled`.
 * A3.4 FAIL-CLOSED: `paid`/`partially_refunded` → paid; pendentes → pending; QUALQUER outro (`invalid`, desconhecido,
 * ausente) → null — nunca vira venda paga por omissão (o sync não grava, a métrica não conta).
 */
export function statusPedidoML(statusConsultado: string, order: any): StatusPedidoML | null {
  if (statusConsultado === "cancelled") {
    const cd = order?.cancel_detail;
    if (codigoDeCancelamentoML(order ?? {}) === CANCELAMENTO_DE_PACOTE_REFEITO) return "pack_dividido";
    if (cd?.group === "internal") return "cancelado_interno";
    const reembolsado = (order?.payments ?? []).some((p: any) => p?.status === "refunded" || p?.status === "partially_refunded");
    return reembolsado ? "devolucao" : "cancelled";
  }
  if ((STATUS_ML_PAGO as readonly string[]).includes(statusConsultado)) return "paid";
  if ((STATUS_ML_PENDENTE as readonly string[]).includes(statusConsultado)) return "pending";
  return null;
}

/** Status que contam em CANCELADAS (cancelamento real; o grupo internal fica fora, como no painel). Só interno. */
export const STATUS_CANCELADA_ML: readonly StatusPedidoML[] = ["cancelled", "devolucao"];
