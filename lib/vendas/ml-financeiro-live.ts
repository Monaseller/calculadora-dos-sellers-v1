/**
 * Vendas A3.4 (Parte C) — financeiro LIVE das linhas ML VISÍVEIS da tabela (provider), sem gravar nada.
 *
 *   coleta     o MESMO motor da A3.2 (`coletarFinanceiroML`): billing em lotes de 20 com disjuntor de 429, custo do
 *              envio 1× por shipment, pedidos do pack (envio compartilhado), concorrência 2, 3 tentativas (1 s / 2 s),
 *              timeout, prazo e log compacto. Aqui os "gravadores" só guardam em MEMÓRIA para esta resposta e nada é
 *              lido do banco — o financeiro live não é persistido. Sem `/discounts` (não entra no líquido).
 *   tarifa     Σ `order_items[].sale_fee` × qtd do pedido da busca = REAL (PROVIDER_ORDER); billing `sale_fee.net`
 *              (fallback CVV*, nunca CFFE) só RECONCILIA (PROVIDER_BILLING) ou acusa DIVERGENT. 429 no billing não
 *              apaga a tarifa real. Sem sale_fee → PENDING (nenhuma estimativa).
 *   frete      `senders[].cost` do `/shipments/{id}/costs` (0 explícito = R$ 0,00 real; ausente/falha/prazo = PENDING);
 *              `receiver.cost` é do comprador: só referência. Envio de 2+ pedidos (pack ou página) ou pedido de 2+
 *              linhas → SHARED_SHIPMENT_PENDING: sem rateio inventado, sem líquido individual.
 *   líquido    receita − tarifa − frete do vendedor pela fórmula A3.2 (`liquidoPedidoML`); lucro/margem/MC pela MESMA
 *              composição da A3.2 (`financeiroDaVenda`) e SÓ com o líquido CONFIRMED e o custo de Meus Produtos
 *              conhecido — qualquer componente pendente/divergente → lucro, margem e MC PENDENTES.
 */
import "server-only";
import { coletarFinanceiroML, type FalhaFinanceiraML } from "./ml-financeiro-coleta";
import { liquidoPedidoML, type EnvioFinanceiroML, type PedidoFinanceiroML } from "./ml-financeiro";
import { financeiroDaVenda, identidadeDaVenda, resolverCustoProduto, type MapaCustoProduto } from "./custo-produto";
import type { ComponentesFinanceirosML, FinanceiroVendaLive, StatusComponenteML } from "./custo-produto-tipos";

const cent = (v: number) => Math.round(v * 100) / 100;

export interface FinanceiroPedidosLiveML {
  pedidos: Map<string, PedidoFinanceiroML>;
  envios: Map<string, EnvioFinanceiroML>;
  falhas: FalhaFinanceiraML[];
}

export interface DepsFinanceiroLiveML {
  fetch?: typeof fetch;
  esperar?: (ms: number) => Promise<void>;
  relogio?: () => number;
  agora?: () => Date;
  log?: (linha: string) => void;
}

/** Os pedidos (payload da busca) da página visível → financeiro do provider, em memória. Nada é gravado. */
export async function coletarFinanceiroLiveML(
  conta: { userId: string; lojaId: string; accessToken: string },
  pedidosDaPagina: readonly Record<string, unknown>[],
  deps: DepsFinanceiroLiveML,
  prazo: { ate: number },
): Promise<FinanceiroPedidosLiveML> {
  const pedidos = new Map<string, PedidoFinanceiroML>(), envios = new Map<string, EnvioFinanceiroML>();
  if (pedidosDaPagina.length === 0) return { pedidos, envios, falhas: [] };
  const r = await coletarFinanceiroML(conta, { pedidos: pedidosDaPagina }, {
    fetch: deps.fetch ?? fetch,
    esperar: deps.esperar ?? ((ms) => new Promise((ok) => setTimeout(ok, ms))),
    // LIVE: memória desta resposta — nenhuma escrita em banco, nenhuma leitura do estado gravado
    gravarPedidos: async (linhas) => { for (const l of linhas) pedidos.set(l.order_id, l); },
    gravarEnvios: async (linhas) => { for (const e of linhas) envios.set(e.shipment_id, e); },
    semDescontos: true,
    modo: "live",
    relogio: deps.relogio, agora: deps.agora, log: deps.log,
  }, prazo);
  return { pedidos, envios, falhas: r.falhas };
}

export interface LinhaParaFinanceiroML {
  orderId: string;
  packId: string | null;
  shippingId: string | null;
  itemId: string | null;
  variacaoId: string | null;
  qtd: number;
  faturamento: number;
  saleFeeUnitario: number | null;
}

/** Componentes da linha (puro). `envioCompartilhadoNaPagina` = o mesmo shipment em 2+ pedidos visíveis. */
export function componentesDaLinhaML(
  l: LinhaParaFinanceiroML,
  f: { pedido: PedidoFinanceiroML | null; envio: EnvioFinanceiroML | null; falhas: readonly FalhaFinanceiraML[]; envioCompartilhadoNaPagina: boolean },
): ComponentesFinanceirosML {
  const p = f.pedido;
  let fee: ComponentesFinanceirosML["fee"];
  if (l.saleFeeUnitario === null) fee = { value: null, source: null, status: "PENDING", billingValue: p?.billing_tarifa ?? null };
  else {
    const valor = cent(l.saleFeeUnitario * l.qtd);
    if (p?.billing_status === "DIVERGENTE") fee = { value: valor, source: "PROVIDER_ORDER", status: "DIVERGENT", billingValue: p.billing_tarifa };
    else if (p?.billing_status === "CONFERIDO") fee = { value: valor, source: "PROVIDER_BILLING", status: "CONFIRMED", billingValue: p.billing_tarifa };
    else fee = { value: valor, source: "PROVIDER_ORDER", status: "CONFIRMED", billingValue: null };
  }

  const naoPronto = f.falhas.some((x) => x.classe === "PROVIDER_DATA_NOT_READY" && x.order_id === l.orderId && /^(shipment|pack)/.test(x.etapa));
  const pendente: StatusComponenteML = naoPronto ? "PROVIDER_NOT_READY" : "PENDING";
  const e = p && l.shippingId && f.envio?.shipment_id === l.shippingId ? f.envio : null;
  let sellerShipping: ComponentesFinanceirosML["sellerShipping"];
  if (!e || e.frete_vendedor === null || e.pedidos === null) sellerShipping = { value: null, status: pendente };
  else if (f.envioCompartilhadoNaPagina || e.pedidos.length !== 1 || e.pedidos[0] !== l.orderId || p!.itens !== 1) sellerShipping = { value: null, status: "SHARED_SHIPMENT_PENDING" };
  else sellerShipping = { value: e.frete_vendedor, status: "CONFIRMED" };
  const buyerShipping: ComponentesFinanceirosML["buyerShipping"] = e && e.frete_comprador !== null ? { value: e.frete_comprador, status: "CONFIRMED" } : { value: null, status: pendente };

  let mlNet: ComponentesFinanceirosML["mlNet"];
  if (fee.status === "PENDING") mlNet = { value: null, status: "PENDING" };
  else if (sellerShipping.status !== "CONFIRMED") mlNet = { value: null, status: sellerShipping.status };
  else {
    const liq = liquidoPedidoML(p!, e);   // a fórmula A3.2: receita − tarifa − frete do vendedor
    mlNet = liq.liquido === null ? { value: null, status: liq.motivo === "frete_compartilhado" ? "SHARED_SHIPMENT_PENDING" : "PENDING" }
      : { value: liq.liquido, status: fee.status === "DIVERGENT" ? "DIVERGENT" : "CONFIRMED" };
  }
  return { fee, sellerShipping, buyerShipping, mlNet, financialStatus: mlNet.status };
}

/** Financeiro da linha para a tela: custo de Meus Produtos + componentes live; lucro/margem/MC só com tudo confirmado. */
export function financeiroLiveDaLinhaML(
  l: LinhaParaFinanceiroML, comp: ComponentesFinanceirosML, mapa: MapaCustoProduto,
  f: { pedido: PedidoFinanceiroML | null; envio: EnvioFinanceiroML | null },
): FinanceiroVendaLive {
  const venda = { marketplace: "ML", ml_item_id: l.itemId, variation_id: l.variacaoId, qtd: l.qtd, faturamento: l.faturamento,
    tarifa_venda: l.saleFeeUnitario, tarifa_origem: l.saleFeeUnitario !== null ? "PROVIDER" : null };
  const confirmado = comp.mlNet.status === "CONFIRMED" && f.pedido !== null;
  // líquido CONFIRMADO → a composição A3.2 (financeiroRealML: líquido − custo − imposto); senão só custo/imposto
  const base = financeiroDaVenda(venda, resolverCustoProduto(mapa, identidadeDaVenda(venda)), confirmado ? { pedido: f.pedido!, envio: f.envio } : null);
  const lucroValido = confirmado && base.baseFinanceira === "ML_RECONCILIADO";
  const motivo = comp.fee.status === "PENDING" ? "tarifa" : comp.sellerShipping.status === "SHARED_SHIPMENT_PENDING" ? "frete_compartilhado"
    : comp.sellerShipping.status !== "CONFIRMED" ? "frete" : comp.fee.status === "DIVERGENT" ? "billing" : "ok";
  return {
    ...base,
    qualidadeFinanceira: confirmado ? "ACTUAL" : "PENDING",
    baseFinanceira: "ML_RECONCILIADO",
    tarifa: comp.fee.value ?? 0,
    tarifaOrigem: comp.fee.value !== null ? "real" : "legada",
    freteStatus: comp.sellerShipping.status === "CONFIRMED" ? "no_liquido_ml" : "pendente",
    freteVendedor: comp.sellerShipping.value,
    liquidoMarketplace: comp.mlNet.value,
    detalheML: { packId: l.packId, freteComprador: comp.buyerShipping.value, descontoVendedor: null, descontoMeli: null,
      billing: f.pedido?.billing_status ?? "PENDENTE", motivo },
    lucro: lucroValido ? base.lucro : null,
    margemPct: lucroValido ? base.margemPct : null,
    roi: lucroValido ? base.roi : null,
    pendencias: [...new Set([...base.pendencias, ...(confirmado ? [] : ["financeiro" as const])])],
    componentesML: comp,
  };
}
