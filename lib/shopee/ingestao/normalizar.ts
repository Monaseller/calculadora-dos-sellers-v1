/**
 * Normalizacao (pura) — detail/escrow da Shopee → linhas persistidas.
 *
 * Regras:
 *  - grao de PEDIDO (shopee_pedidos): status, timestamps reais, total e o
 *    escrow de pedido (subsidio Shopee, Pix) — UMA vez por pedido;
 *  - grao de ITEM (pedidos): preco descontado × quantidade e o escrow por
 *    item (voucher vendedor, voucher Shopee, moedas). Valor de pedido NUNCA
 *    e copiado para item;
 *  - chave de item = a ja existente: <user>_SHOPEE_<order_sn>_<item>_<model|nv>;
 *  - escrow ↔ detail por (item_id, model_id), 1:1 exato. Sem correspondencia
 *    exata o pedido falha no financeiro — nada e adivinhado;
 *  - sem fallback semantico: campo ausente → NULL quando a coluna permite.
 */
import { diaEmSaoPaulo } from "@/lib/fuso-sao-paulo";
import { mapStatus } from "@/lib/sync-shopee";
import type {
  EscrowPedido, ItemDetalhe, LinhaItemDetalhe, LinhaItemEscrow, LinhaPedidoDetalhe, LinhaPedidoEscrow, PedidoDetalhe,
} from "./tipos";

const iso = (epochS: number) => new Date(epochS * 1000).toISOString();

/** Mesma regra de variacao do sync atual: model_id 0/vazio = sem variacao. */
export function normalizarModelId(m: unknown): string | null {
  if (m === null || m === undefined) return null;
  const s = String(m);
  return s === "" || s === "0" ? null : s;
}

/** A chave idempotente de item ja usada em `pedidos`. */
export function idItem(userId: string, orderSn: string, itemId: string, modelId: string | null): string {
  return `${userId}_SHOPEE_${orderSn}_${itemId}_${modelId ?? "nv"}`;
}

const chaveItem = (itemId: string, modelId: string | null) => `${itemId}|${modelId ?? ""}`;

/**
 * CHAVE CANONICA DE ITEM (S2-D2.1): (loja, pedido, item, variacao). E o que
 * o indice unico parcial `pedidos_shopee_item_por_loja_unico` garante no
 * banco. Nao se supoe order_sn unico entre lojas.
 */
export function chaveItemLoja(lojaId: string, orderSn: string, itemId: string, modelId: string | null): string {
  return `${lojaId}|${orderSn}|${itemId}|${modelId ?? ""}`;
}

/** Variante do id quando o id legado ja pertence a OUTRA loja do dono. */
export function idItemPorLoja(userId: string, lojaId: string, orderSn: string, itemId: string, modelId: string | null): string {
  return `${userId}_SHOPEE_L${lojaId}_${orderSn}_${itemId}_${modelId ?? "nv"}`;
}

/**
 * Decide o `pedidos.id` de cada item sem reescrever id existente:
 *  1. ja existe linha desta LOJA para (pedido, item, variacao) → o id dela;
 *  2. senao, o id legado se estiver livre;
 *  3. senao (legado ocupado por outra loja do dono) → variante com a loja.
 * Puro: o adaptador real e o fake usam a mesma regra.
 */
export function resolverIdsDeItens<T extends LinhaItemDetalhe>(
  itens: T[], existentesPorChave: Map<string, string>, idsOcupados: Set<string>,
): T[] {
  return itens.map((it) => {
    const k = chaveItemLoja(it.loja_id, it.order_id, it.ml_item_id, it.variation_id);
    const existente = existentesPorChave.get(k);
    if (existente) return { ...it, id: existente };
    const legado = idItem(it.user_id, it.order_id, it.ml_item_id, it.variation_id);
    if (!idsOcupados.has(legado)) return { ...it, id: legado };
    return { ...it, id: idItemPorLoja(it.user_id, it.loja_id, it.order_id, it.ml_item_id, it.variation_id) };
  });
}

export function normalizarDetalhe(
  d: PedidoDetalhe,
  ctx: { userId: string; lojaId: string; agoraIso: string },
): { pedido: LinhaPedidoDetalhe; itens: LinhaItemDetalhe[] } {
  const createIso = iso(d.createTime), updateIso = iso(d.updateTime);
  const payIso = d.payTime ? iso(d.payTime) : null;
  const dataCriacao = diaEmSaoPaulo(createIso);
  const dataPagamento = payIso ? diaEmSaoPaulo(payIso) : null;
  const pedido: LinhaPedidoDetalhe = {
    user_id: ctx.userId, loja_id: ctx.lojaId, order_sn: d.orderSn,
    create_time: createIso, update_time: updateIso, pay_time: payIso,
    order_status: d.status, cancel_by: d.cancelBy, cancel_reason: d.cancelReason,
    total_amount: d.totalAmount, detail_fetched_at: ctx.agoraIso,
  };
  const vistos = new Set<string>();
  const itens = d.itens.map((it: ItemDetalhe): LinhaItemDetalhe => {
    const k = chaveItem(it.itemId, it.modelId);
    if (vistos.has(k)) throw new Error(`item_repetido_no_pedido:${d.orderSn}:${k}`);
    vistos.add(k);
    const preco = it.precoDescontado ?? it.precoOriginal;
    if (preco === null) throw new Error(`item_sem_preco:${d.orderSn}:${k}`);
    return {
      id: idItem(ctx.userId, d.orderSn, it.itemId, it.modelId),
      user_id: ctx.userId, marketplace: "Shopee", order_id: d.orderSn, loja_id: ctx.lojaId,
      ml_item_id: it.itemId, variation_id: it.modelId, anuncio: it.nome ?? it.itemId, sku: it.sku,
      status: mapStatus(d.status ?? "UNKNOWN"), status_shopee_raw: d.status,
      valor_unit: preco, qtd: it.quantidade, item_subtotal: Math.round(preco * it.quantidade * 100) / 100,
      data: dataPagamento ?? dataCriacao, data_criacao: dataCriacao, data_pagamento: dataPagamento,
      data_atualizacao_marketplace: updateIso, synced_at: ctx.agoraIso,
    };
  });
  if (itens.length === 0) throw new Error(`pedido_sem_itens:${d.orderSn}`);
  return { pedido, itens };
}

export class ErroCorrespondenciaEscrow extends Error {}

/**
 * Escrow → linha de pedido + linhas de item. `itensGravados` sao as chaves
 * dos itens do pedido ja persistidos (do DETAIL). Exige 1:1 exato.
 */
export function normalizarEscrow(
  e: EscrowPedido,
  ctx: { userId: string; lojaId: string; agoraIso: string; updateTimeDoPedido: string;
    itensGravados: { id: string; itemId: string; modelId: string | null }[] },
): { pedido: LinhaPedidoEscrow; itens: LinhaItemEscrow[] } {
  const porChave = new Map<string, { id: string }>();
  for (const g of ctx.itensGravados) porChave.set(chaveItem(g.itemId, g.modelId), g);
  const usados = new Set<string>();
  const itens: LinhaItemEscrow[] = [];
  for (const it of e.itens) {
    const k = chaveItem(it.itemId, it.modelId);
    const alvo = porChave.get(k);
    if (!alvo) throw new ErroCorrespondenciaEscrow(`item_de_escrow_sem_par:${e.orderSn}:${k}`);
    if (usados.has(k)) throw new ErroCorrespondenciaEscrow(`item_de_escrow_repetido:${e.orderSn}:${k}`);
    usados.add(k);
    itens.push({ id: alvo.id, user_id: ctx.userId, loja_id: ctx.lojaId,
      escrow_voucher_seller: it.voucherVendedor, escrow_voucher_shopee: it.voucherShopee, escrow_coin: it.moedas });
  }
  if (usados.size !== porChave.size) throw new ErroCorrespondenciaEscrow(`item_de_detalhe_sem_escrow:${e.orderSn}`);
  return {
    pedido: { user_id: ctx.userId, loja_id: ctx.lojaId, order_sn: e.orderSn,
      original_shopee_discount: e.originalShopeeDiscount, pix_discount: e.pixDiscount,
      escrow_fetched_at: ctx.agoraIso, escrow_update_time: ctx.updateTimeDoPedido },
    itens,
  };
}
