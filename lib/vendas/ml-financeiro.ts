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

/**
 * Versão da lógica que gravou a linha financeira. 1 = A3.2-B/C (billing somava TODAS as cobranças — inclusive o
 * frete CFFE — e desconto_meli somava cupom); 2 = A3.2-D (billing = sale_fee.net do provider; desconto_meli = só o
 * rebate da tarifa). DIVERGENTE de versão anterior é reavaliado UMA vez (ver financeiroPendenteElegivel).
 */
export const FONTE_VERSAO_ML_FINANCEIRO = 2;

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
  /** Versão da lógica que gravou a linha (ausente = registro ainda não lido do banco). */
  fonte_versao?: number;
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
    // A3.2-D (auditado): desconto do VENDEDOR = parte do vendedor (já no preço); desconto_meli = SÓ o rebate da tarifa —
    // parte do ML num "discount" com supplier.funding_mode "sale_fee" (bate com billing sale_fee.rebate). Cupom
    // (funding null) é benefício do ML ao comprador, NÃO rebate da tarifa: fica fora de desconto_meli.
    for (const d of detalhes) for (const it of (Array.isArray(d?.items) ? d.items : [])) {
      const total = num(it?.amounts?.total) ?? 0, seller = num(it?.amounts?.seller) ?? 0;
      vendedor += seller;
      if (d?.supplier?.funding_mode === "sale_fee") meli += total - seller;
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
 * Conferência da tarifa pelo billing (GET billing order details) — A3.2-D, auditado em pedidos reais:
 *   FONTE PRINCIPAL: `results[pedido].sale_fee.net` — agregado do provider (bate com Σ sale_fee × qtd mesmo enquanto as
 *   linhas de cobrança ainda estão sendo lançadas);
 *   FALLBACK (sem sale_fee.net): Σ das linhas CHARGE do pedido cujo `detail_sub_type` começa com "CVV" (família de
 *   tarifa: CVVML, CVVPRC, CVVFNU…). Frete (CFFE) e qualquer outra cobrança NUNCA entram.
 * ±1 centavo → CONFERIDO; diferente → DIVERGENTE; 403 → SEM_PERMISSAO; sem resposta (429/erro) ou sem dado → PENDENTE.
 */
export function conferirBillingML(orderId: string, tarifa: number | null, httpStatus: number, corpo: any | null): { billing_status: StatusBillingML; billing_tarifa: number | null } {
  if (httpStatus === 401 || httpStatus === 403) return { billing_status: "SEM_PERMISSAO", billing_tarifa: null };
  if (httpStatus !== 200 || !corpo) return { billing_status: "PENDENTE", billing_tarifa: null };
  const resultados: any[] = Array.isArray(corpo.results) ? corpo.results : [];
  const doPedido = resultados.find((r) => String(r?.order_id) === orderId);
  let total: number | null = num(doPedido?.sale_fee?.net);
  if (total === null) {
    let soma = 0, achou = false;
    for (const r of resultados) for (const d of (Array.isArray(r?.details) ? r.details : [])) {
      const ehDoPedido = (Array.isArray(d?.sales_info) ? d.sales_info : []).some((s: any) => String(s?.order_id) === orderId);
      const sub = String(d?.charge_info?.detail_sub_type ?? "");
      if (ehDoPedido && d?.charge_info?.detail_type === "CHARGE" && sub.startsWith("CVV") && num(d.charge_info.detail_amount) !== null) { soma += d.charge_info.detail_amount; achou = true; }
    }
    if (!achou) return { billing_status: "PENDENTE", billing_tarifa: null };
    total = soma;
  }
  total = cent(total);
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
 * A3.2-C.3 — CARÊNCIA do provider: numa venda recém-fechada o Mercado Livre leva ~5 min para expor todo o
 * financeiro (billing, descontos, custos do envio). A 1ª tentativa é IMEDIATA (sem espera artificial); só a
 * AUSÊNCIA de um subrecurso financeiro dentro da carência deixa de ser erro de integração.
 */
export const CARENCIA_PROVIDER_ML_MS = 5 * 60_000;
/** Etapas com consistência eventual no provider — nunca "order" (o pedido já existe: 404 aqui é identidade errada). */
export const ETAPAS_COM_CARENCIA_ML = ["discounts", "pack", "shipment_costs", "shipment_costs_estrutura", "billing", "billing_divergente"] as const;
export type ClasseFinanceiraML = ClasseErroML | "PROVIDER_DATA_NOT_READY";

/** Idade da venda pelo horário do PROVIDER (date_closed, senão date_created); null se ausente/ilegível. */
export function idadePedidoMLms(order: any, agora: Date): number | null {
  const ref = order?.date_closed ?? order?.date_created;
  const t = ref ? Date.parse(String(ref)) : NaN;
  return Number.isFinite(t) ? agora.getTime() - t : null;
}

/**
 * Reclassifica uma falha à luz da carência: INTEGRATION_ERROR vira PROVIDER_DATA_NOT_READY SÓ se (1) a etapa é de
 * subrecurso financeiro com consistência eventual, (2) a resposta foi 404 (ainda não existe) ou 200 incompleto, e
 * (3) a venda tem menos de 5 min pelo relógio do provider (tolerância de 60 s para relógios adiantados).
 * 401/403/400/500, a etapa "order" (pack usado como order, credencial/loja errada) e venda antiga continuam ERRO.
 * TRANSIENT_ERROR nunca é tocado (segue o retry com backoff).
 */
export function classeComCarenciaML(classe: ClasseErroML, etapa: string, http: number, idadeMs: number | null): ClasseFinanceiraML {
  if (classe !== "INTEGRATION_ERROR") return classe;
  if (!(ETAPAS_COM_CARENCIA_ML as readonly string[]).includes(etapa)) return classe;
  if (http !== 404 && http !== 200) return classe;
  if (idadeMs === null || idadeMs < -60_000 || idadeMs >= CARENCIA_PROVIDER_ML_MS) return classe;
  return "PROVIDER_DATA_NOT_READY";
}

/**
 * A3.2-C — o pedido tem financeiro INCOMPLETO que uma nova tentativa pode completar? Devolve o motivo ou null.
 * Elegível: billing PENDENTE, descontos indisponíveis, tarifa ausente no pedido, ou envio que existe mas cujo
 * custo/pedidos do pack não vieram. NÃO elegível (null): completo; sem envio (nada a buscar); envio
 * COMPARTILHADO por vários pedidos (sem rateio do provider — não é falha técnica); billing SEM_PERMISSAO ou
 * DIVERGENTE (erro de integração: investigar, não repetir a cada carga de página).
 */
export function financeiroPendenteElegivel(p: PedidoFinanceiroML, envio: EnvioFinanceiroML | null): "billing" | "descontos" | "tarifa" | "frete" | "pack" | "versao" | null {
  if (p.tarifa_origem !== "PROVIDER" || p.tarifa_venda === null) return "tarifa";
  if (p.shipment_id) {
    if (!envio || envio.frete_vendedor === null) return "frete";
    if (p.pack_id && envio.pedidos === null) return "pack";
  }
  if (p.billing_status === "PENDENTE") return "billing";
  // A3.2-D: DIVERGENTE gravado pela lógica antiga (somava frete CFFE) é reavaliado UMA vez; DIVERGENTE da versão atual não
  if (p.billing_status === "DIVERGENTE" && (p.fonte_versao ?? FONTE_VERSAO_ML_FINANCEIRO) < FONTE_VERSAO_ML_FINANCEIRO) return "versao";
  if (p.descontos_status === "INDISPONIVEL") return "descontos";
  return null;
}

/**
 * A3.2-C.2 — data que coloca a venda na janela da tela (a MESMA regra do GET /api/ml/vendas, `date_field`):
 * pagamento → data_pagamento; sem ela e sem data_criacao → `data` legada; criacao → data_criacao ?? `data`.
 * null = fora de qualquer janela por esse critério.
 */
export function dataDaJanelaML(r: { data?: string | null; data_pagamento?: string | null; data_criacao?: string | null }, campo: "pagamento" | "criacao"): string | null {
  if (campo === "pagamento") return r.data_pagamento ?? (r.data_criacao == null ? r.data ?? null : null);
  return r.data_criacao ?? r.data ?? null;
}

/**
 * A3.2-C.2 — candidatos à RECUPERAÇÃO financeira de uma janela da tela: vendas ML PAGAS (já filtradas por dono +
 * loja) SEM linha financeira, ou com linha financeira pendente elegível. Mais recentes primeiro. Sem linha =
 * nunca reconciliada (não é erro de integração). Completo (ACTUAL), SEM_PERMISSAO e DIVERGENTE ficam fora.
 */
export function candidatosRecuperacaoFinanceiraML(
  vendas: ReadonlyArray<{ order_id: string; status?: string | null; data?: string | null; data_pagamento?: string | null; data_criacao?: string | null }>,
  fin: ReadonlyMap<string, { pedido: PedidoFinanceiroML; envio: EnvioFinanceiroML | null }>,
  janela: { de: string; ate: string; campo: "pagamento" | "criacao" },
): string[] {
  const porPedido = new Map<string, string>();
  for (const v of vendas) {
    if (v.status !== "paid") continue;
    const d = dataDaJanelaML(v, janela.campo);
    if (!d || d < janela.de || d > janela.ate) continue;
    const id = String(v.order_id);
    if ((porPedido.get(id) ?? "") < d) porPedido.set(id, d);
  }
  return [...porPedido.entries()]
    .filter(([id]) => { const f = fin.get(id); return !f || financeiroPendenteElegivel(f.pedido, f.envio) !== null; })
    .sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : a[0] < b[0] ? 1 : -1))
    .map(([id]) => id);
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
