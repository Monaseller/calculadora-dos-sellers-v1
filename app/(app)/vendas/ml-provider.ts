/**
 * Vendas A3.4 — tela de Vendas, Mercado Livre HÍBRIDO (puro, sem I/O; a página importa daqui).
 *
 *   linhaProviderParaVendaRow  linha da tabela lida do PROVIDER (GET /api/ml/vendas/pedidos) → linha da tabela da tela.
 *                              Status/data/qtd/preço/tarifa vêm SÓ do provider; nada do legado `pedidos`. Status
 *                              desconhecido ou pacote dividido não viram linha (fail-closed: nunca "pago").
 *   rotuloMetricasML           o texto da linha de métricas do ML por estado: COMPLETE "dados confirmados",
 *                              PARTIAL "Carregando… X/Y dias" (sem número), FAILED "indisponíveis". Nunca "ao vivo":
 *                              os números são do corpus canônico, não de uma leitura do provider.
 */
import type { ComponentesFinanceirosML, FinanceiroVendaLive, StatusComponenteML } from "@/lib/vendas/custo-produto-tipos";

export type StatusVendaTela = "paid" | "cancelled" | "devolucao" | "pending";

export interface LinhaProviderML {
  origem: "PROVIDER";
  orderId: string;
  packId: string | null;
  shippingId: string | null;
  status: string | null;
  dataFechamento: string;
  dataPagamento: string | null;
  itemId: string | null;
  variacaoId: string | null;
  titulo: string;
  sku: string | null;
  qtd: number;
  valorUnit: number;
  faturamento: number;
  saleFeeUnitario: number | null;
  financeiroML: ComponentesFinanceirosML;
  financeiro: FinanceiroVendaLive | null;
}

export interface VendaRowProviderML {
  orderId: string; data: string; anuncio: string; conta: string; marketplace: "ML"; sku: string | null; mlItemId: string;
  frete: null; logistica: string; status: StatusVendaTela; valorUnit: number; qtd: number; faturamento: number;
  custo: number; imposto: number; tarifaVenda: number; freteComprador: number; freteVendedor: number;
  margemContrib: number; mcPercent: number; cadastrado: boolean; financeiro: FinanceiroVendaLive | null; packId: string | null;
  origem: "PROVIDER"; shippingId: string | null; financeiroML: ComponentesFinanceirosML;
}

const STATUS_TELA: Record<string, StatusVendaTela> = { paid: "paid", pending: "pending", devolucao: "devolucao", cancelled: "cancelled", cancelado_interno: "cancelled" };

export function linhaProviderParaVendaRow(l: LinhaProviderML, visao: "fechamento" | "pago"): VendaRowProviderML | null {
  const status = l.status === null ? undefined : STATUS_TELA[l.status];
  if (!status) return null;
  const data = visao === "pago" ? l.dataPagamento : l.dataFechamento;
  if (!data) return null;
  return {
    orderId: l.orderId, data, anuncio: l.titulo, conta: "ML", marketplace: "ML", sku: l.sku, mlItemId: l.itemId ?? "",
    frete: null, logistica: "", status, valorUnit: l.valorUnit, qtd: l.qtd, faturamento: l.faturamento,
    // campos LEGADOS da linha: a tela usa `financeiro` (ao vivo); nada de valor inventado aqui
    custo: 0, imposto: 0, tarifaVenda: l.saleFeeUnitario ?? 0, freteComprador: 0, freteVendedor: 0, margemContrib: 0, mcPercent: 0,
    cadastrado: l.financeiro?.custoStatus === "PRODUCT_FOUND_WITH_COST",
    financeiro: l.financeiro, packId: l.packId, origem: "PROVIDER", shippingId: l.shippingId, financeiroML: l.financeiroML,
  };
}

/**
 * A3.4-C: texto de um componente financeiro do ML SEM valor confirmado — nunca "R$ 0,00" nem "não incluído" (que
 * pareceria zero). Com valor, a tela mostra o valor.
 */
export function textoComponenteML(status: StatusComponenteML): string {
  if (status === "PROVIDER_NOT_READY") return "Aguardando Mercado Livre";
  if (status === "SHARED_SHIPMENT_PENDING") return "Pendente (envio compartilhado)";
  if (status === "DIVERGENT") return "Pendente (divergente)";
  return "Pendente";
}

export interface MetricasMLTela {
  estado: "COMPLETE" | "PARTIAL" | "FAILED";
  fonte: "CANONICO";
  estadoEm: string;
  observadoAte: string | null;
  metricas: { vendas: number; unidades: number; vendasBrutas: number } | null;
  dias: { confirmados: number; total: number } | null;
}

export const METRICAS_ML_INDISPONIVEIS: MetricasMLTela = { estado: "FAILED", fonte: "CANONICO", estadoEm: "", observadoAte: null, metricas: null, dias: null };

const hora = (iso: string) => new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });

export function rotuloMetricasML(m: MetricasMLTela): string {
  if (m.estado === "COMPLETE") return m.observadoAte ? `Mercado Livre · dados confirmados até ${hora(m.observadoAte)}` : "Mercado Livre · dados confirmados";
  if (m.estado === "PARTIAL") return m.dias ? `Carregando dados do Mercado Livre — ${m.dias.confirmados}/${m.dias.total} dias` : "Carregando dados do Mercado Livre";
  return "Dados do Mercado Livre indisponíveis";
}

/** Os cards da linha do ML — SÓ os três equivalentes ao painel (sem "canceladas"), e só com número confirmado. */
export function cardsMetricasML(m: MetricasMLTela): { label: string; valor: number; tipo: "moeda" | "inteiro" }[] {
  if (m.estado !== "COMPLETE" || !m.metricas) return [];
  return [
    { label: "Vendas", valor: m.metricas.vendas, tipo: "inteiro" },
    { label: "Unidades", valor: m.metricas.unidades, tipo: "inteiro" },
    { label: "Vendas brutas", valor: m.metricas.vendasBrutas, tipo: "moeda" },
  ];
}
