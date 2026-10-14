/**
 * Financeiro REAL do Mercado Livre (CDS V2 Vendas A3.2-B). Puro: extrai das respostas do provider (GET) e
 * calcula o líquido — sem I/O. O coletor (ml-financeiro-coleta.ts) busca e grava; a rota de Vendas só LÊ.
 *
 * Contrato provado na venda golden (order 2000018971279352, pack 2000015516685373):
 *   receita       = Σ order_items[].unit_price × quantity          (desconto do VENDEDOR já está no preço)
 *   tarifa        = Σ order_items[].sale_fee × quantity            (POR UNIDADE e LÍQUIDA: o rebate de
 *                   campanha — parte do ML no desconto, funding_mode "sale_fee" — já está dentro;
 *                   o billing confere: Σ CHARGE do pedido = tarifa)
 *   frete vendedor= Σ /shipments/{id}/costs senders[].cost         (NUNCA receiver.cost — é do comprador —
 *                   nem gross_amount — inclui o subsídio do ML; ambos só referência)
 *   líquido ML    = receita − tarifa − frete vendedor               (nada somado de volta: sem dupla contagem)
 *
 * O frete é do ENVIO: um pack com 2+ pedidos tem UM envio e a API não rateia o custo entre eles. Sem rateio
 * inventado: o líquido de um pedido só existe quando o envio tem EXATAMENTE aquele pedido.
 */

export const FONTE_VERSAO_ML_FINANCEIRO = 1;

export type OrigemTarifaML = "PROVIDER" | "AUSENTE";
export type StatusDescontosML = "OK" | "INDISPONIVEL";
export type StatusBillingML = "CONFERIDO" | "DIVERGENTE" | "PENDENTE" | "SEM_PERMISSAO";

/** Linha de public.ml_financeiro_pedidos (sem user_id/loja_id, que o coletor acrescenta). */
export interface PedidoFinanceiroML {
  order_id: string;
  pack_id: string | null;
  shipment_id: string | null;
  itens: number;
  receita_produto: number;
  tarifa_venda: number | null;
  tarifa_origem: OrigemTarifaML;
  desconto_vendedor: number | null;
  desconto_meli: number | null;
  descontos_status: StatusDescontosML;
  billing_status: StatusBillingML;
  billing_tarifa: number | null;
}

/** Linha de public.ml_financeiro_envios (sem user_id/loja_id). */
export interface EnvioFinanceiroML {
  shipment_id: string;
  pack_id: string | null;
  pedidos: string[] | null;            // order_ids que compartilham o envio; null = desconhecido
  frete_comprador: number | null;      // receiver.cost — pago pelo COMPRADOR (referência)
  frete_vendedor: number | null;       // Σ senders[].cost — custo LÍQUIDO do vendedor
  frete_bruto_referencia: number | null; // gross_amount — referência, NUNCA custo
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v));
const cent = (v: number) => Math.round(v * 100) / 100;

/** Pedido (GET /orders/{id}) + descontos (GET /orders/{id}/discounts; null = indisponível). */
export function extrairPedidoFinanceiroML(order: any, descontos: any | null): Omit<PedidoFinanceiroML, "billing_status" | "billing_tarifa"> {
  const itens: any[] = Array.isArray(order?.order_items) ? order.order_items : [];
  let receita = 0;
  let tarifa = 0;
  let tarifaCompleta = itens.length > 0;
  for (const i of itens) {
    const qtd = num(i?.quantity) ?? 0;
    receita += (num(i?.unit_price) ?? 0) * qtd;
    const fee = num(i?.sale_fee);
    if (fee === null) tarifaCompleta = false; else tarifa += fee * qtd;
  }
  let vendedor: number | null = null, meli: number | null = null;
  const detalhes: any[] | null = descontos && Array.isArray(descontos.details) ? descontos.details : null;
  if (detalhes) {
    vendedor = 0; meli = 0;
    for (const d of detalhes) for (const it of (Array.isArray(d?.items) ? d.items : [])) {
      const total = num(it?.amounts?.total) ?? 0, seller = num(it?.amounts?.seller) ?? 0;
      vendedor += seller; meli += total - seller;
    }
    vendedor = cent(vendedor); meli = cent(meli);
  }
  return {
    order_id: String(order?.id),
    pack_id: str(order?.pack_id),
    shipment_id: str(order?.shipping?.id),
    itens: itens.length,
    receita_produto: cent(receita),
    tarifa_venda: tarifaCompleta ? cent(tarifa) : null,
    tarifa_origem: tarifaCompleta ? "PROVIDER" : "AUSENTE",
    desconto_vendedor: vendedor,
    desconto_meli: meli,
    descontos_status: detalhes ? "OK" : "INDISPONIVEL",
  };
}

/** Envio: GET /shipments/{id}/costs (x-format-new) + os pedidos que o compartilham (pack.orders, ou o próprio). */
export function extrairEnvioFinanceiroML(shipmentId: string, packId: string | null, custos: any | null, pedidos: string[] | null): EnvioFinanceiroML {
  const senders: any[] | null = custos && Array.isArray(custos.senders) ? custos.senders : null;
  let freteVendedor: number | null = null;
  if (senders && senders.length > 0 && senders.every((s) => num(s?.cost) !== null)) freteVendedor = cent(senders.reduce((a, s) => a + (s.cost as number), 0));
  return {
    shipment_id: shipmentId,
    pack_id: packId,
    pedidos: pedidos ? [...new Set(pedidos.map(String))].sort() : null,
    frete_comprador: custos ? num(custos?.receiver?.cost) : null,
    frete_vendedor: freteVendedor,
    frete_bruto_referencia: custos ? num(custos?.gross_amount) : null,
  };
}

/**
 * Conferência da tarifa pelo billing (GET billing order details): Σ `detail_amount` das cobranças (CHARGE)
 * do pedido = tarifa (±1 centavo) → CONFERIDO. 403 → SEM_PERMISSAO; sem resposta (429/erro) → PENDENTE.
 */
export function conferirBillingML(orderId: string, tarifa: number | null, httpStatus: number, corpo: any | null): { billing_status: StatusBillingML; billing_tarifa: number | null } {
  if (httpStatus === 401 || httpStatus === 403) return { billing_status: "SEM_PERMISSAO", billing_tarifa: null };
  if (httpStatus !== 200 || !corpo) return { billing_status: "PENDENTE", billing_tarifa: null };
  let soma = 0, achou = false;
  for (const r of (Array.isArray(corpo.results) ? corpo.results : [])) for (const d of (Array.isArray(r?.details) ? r.details : [])) {
    const doPedido = (Array.isArray(d?.sales_info) ? d.sales_info : []).some((s: any) => String(s?.order_id) === orderId);
    if (doPedido && d?.charge_info?.detail_type === "CHARGE" && num(d.charge_info.detail_amount) !== null) { soma += d.charge_info.detail_amount; achou = true; }
  }
  if (!achou) return { billing_status: "PENDENTE", billing_tarifa: null };
  const total = cent(soma);
  return { billing_status: tarifa !== null && Math.abs(total - tarifa) <= 0.01 ? "CONFERIDO" : "DIVERGENTE", billing_tarifa: total };
}

/**
 * A3.2-C — classe do erro do provider. TRANSIENT_ERROR: 429, 502/503/504 e timeout/rede (status 0) — retry e
 * nova tentativa depois. INTEGRATION_ERROR: qualquer outro não-200 (404 inesperado, 4xx, 500) — bug de
 * integração a investigar, nunca escondido como "pendente" comum.
 */
export type ClasseErroML = "TRANSIENT_ERROR" | "INTEGRATION_ERROR";
export function classificarHttpML(status: number): ClasseErroML | "OK" {
  if (status === 200) return "OK";
  if (status === 0 || status === 429 || status === 502 || status === 503 || status === 504) return "TRANSIENT_ERROR";
  return "INTEGRATION_ERROR";
}

/**
 * A3.2-C — o pedido tem financeiro INCOMPLETO que uma nova tentativa pode completar? Devolve o motivo ou null.
 * Elegível: billing PENDENTE, descontos indisponíveis, tarifa ausente no pedido, ou envio que existe mas cujo
 * custo/pedidos do pack não vieram. NÃO elegível (null): completo; sem envio (nada a buscar); envio
 * COMPARTILHADO por vários pedidos (sem rateio do provider — não é falha técnica); billing SEM_PERMISSAO ou
 * DIVERGENTE (erro de integração: investigar, não repetir a cada carga de página).
 */
export function financeiroPendenteElegivel(p: PedidoFinanceiroML, envio: EnvioFinanceiroML | null): "billing" | "descontos" | "tarifa" | "frete" | "pack" | null {
  if (p.tarifa_origem !== "PROVIDER" || p.tarifa_venda === null) return "tarifa";
  if (p.shipment_id) {
    if (!envio || envio.frete_vendedor === null) return "frete";
    if (p.pack_id && envio.pedidos === null) return "pack";
  }
  if (p.billing_status === "PENDENTE") return "billing";
  if (p.descontos_status === "INDISPONIVEL") return "descontos";
  return null;
}

/**
 * A3.2-C.1 — validação de ENTRADA do retry (tamanho do corpo/consulta), não teto de negócio: o retry tenta
 * todos os pendentes recebidos até o PRAZO de execução do coletor.
 */
export const MAX_IDS_RETRY_FINANCEIRO_ML = 2000;

/** Order_ids com financeiro pendente ELEGÍVEL, na ordem recebida (a tela manda os mais recentes primeiro). */
export function pedidosComFinanceiroPendente(ordem: readonly string[], fin: ReadonlyMap<string, { pedido: PedidoFinanceiroML; envio: EnvioFinanceiroML | null }>): string[] {
  const out: string[] = [];
  for (const id of new Set(ordem)) {
    const f = fin.get(id);
    if (f && financeiroPendenteElegivel(f.pedido, f.envio) !== null) out.push(id);
  }
  return out;
}

export type QualidadeLiquidoML = "ACTUAL" | "ESTIMATED" | "PENDING";
export interface LiquidoML {
  liquido: number | null;
  freteVendedor: number | null;
  qualidade: QualidadeLiquidoML;
  motivo: "ok" | "tarifa" | "frete" | "frete_compartilhado" | "billing";
}

/**
 * Líquido do PEDIDO: receita − tarifa − frete do vendedor. ACTUAL só com tudo real e conferido; billing ainda
 * não conferido (429/sem permissão/divergente) → ESTIMATED; tarifa ou frete ausente, ou envio compartilhado
 * (sem rateio do provider) → PENDING, sem número.
 */
export function liquidoPedidoML(p: PedidoFinanceiroML, envio: EnvioFinanceiroML | null): LiquidoML {
  if (p.tarifa_origem !== "PROVIDER" || p.tarifa_venda === null) return { liquido: null, freteVendedor: null, qualidade: "PENDING", motivo: "tarifa" };
  if (!p.shipment_id || !envio || envio.shipment_id !== p.shipment_id || envio.frete_vendedor === null) return { liquido: null, freteVendedor: null, qualidade: "PENDING", motivo: "frete" };
  if (!envio.pedidos || envio.pedidos.length !== 1 || envio.pedidos[0] !== p.order_id) return { liquido: null, freteVendedor: null, qualidade: "PENDING", motivo: "frete_compartilhado" };
  const liquido = cent(p.receita_produto - p.tarifa_venda - envio.frete_vendedor);
  return { liquido, freteVendedor: envio.frete_vendedor, qualidade: p.billing_status === "CONFERIDO" ? "ACTUAL" : "ESTIMATED", motivo: p.billing_status === "CONFERIDO" ? "ok" : "billing" };
}
