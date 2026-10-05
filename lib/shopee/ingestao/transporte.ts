/**
 * Transporte REAL da API Shopee para o motor de ingestao (S2-D2).
 *
 * Usa o `shopeeGet` existente (assinatura/timeout de lib/shopee-api.ts).
 * Toda resposta com `error` vira `ErroShopee` classificado — nunca "zero
 * pedidos" nem "fim da paginacao". Credenciais chegam ja resolvidas para o
 * par (loja, dono) por quem cria o transporte; nada aqui decide ownership.
 *
 * Endpoints (confirmados no repo):
 *   v2.order.get_order_list    — cursor, page_size ate 100, time_range_field
 *                                create_time|update_time (pay_time e recusado
 *                                pela API, docs/CHANGELOG.md)
 *   v2.order.get_order_detail  — ate 50 order_sn por chamada (DETAIL_BATCH)
 *   v2.payment.get_escrow_detail — UM pedido por chamada (nenhum endpoint de
 *                                escrow em lote existe no repo/docs)
 */
import "server-only";
import { shopeeGet } from "@/lib/shopee-api";
import { normalizarModelId } from "./normalizar";
import { ErroShopee, type EscrowPedido, type PaginaListagem, type PedidoDetalhe, type ShopeeApi, type TipoErro } from "./tipos";

/** Campos opcionais do detail que o motor usa (nada de dado de comprador). */
const CAMPOS_DETALHE = "item_list,total_amount,pay_time,order_status,create_time,update_time,cancel_by,cancel_reason";

export interface CredenciaisShopee { partnerId: string; partnerKey: string; accessToken: string; shopId: number | string }

function classificar(erro: string): TipoErro {
  if (/busy|too_many|rate|limit/i.test(erro)) return "rate_limit";
  if (/server|internal|timeout|system|unavailable/i.test(erro)) return "transitorio";
  return "permanente";
}

async function chamar(cred: CredenciaisShopee, caminho: string, params: Record<string, string | number>): Promise<any> {
  let corpo: any;
  try {
    corpo = await shopeeGet(caminho, cred.partnerId, cred.partnerKey, cred.accessToken, cred.shopId, params);
  } catch (e: any) {
    throw new ErroShopee("transitorio", `${caminho}: ${e?.message ?? e}`); // rede/timeout/JSON invalido
  }
  if (corpo?.error) throw new ErroShopee(classificar(String(corpo.error)), `${caminho}: ${corpo.error}`);
  if (!corpo || typeof corpo.response !== "object" || corpo.response === null) {
    throw new ErroShopee("transitorio", `${caminho}: resposta sem 'response'`);
  }
  return corpo.response;
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number(v));

export function criarTransporteShopee(cred: CredenciaisShopee): ShopeeApi {
  return {
    async listarPagina({ campoTempo, de, ate, cursor, tamanhoPagina }): Promise<PaginaListagem> {
      // [time_from, time_to] com AMBAS as pontas inclusivas, em segundos
      // (S2-D3-B2.2); ver ESTRATEGIA_BORDA em janelas.ts.
      const params: Record<string, string | number> = {
        time_range_field: campoTempo, time_from: Math.floor(de / 1000), time_to: Math.floor(ate / 1000),
        page_size: tamanhoPagina, response_optional_fields: "order_status",
      };
      if (cursor) params.cursor = cursor;
      const r = await chamar(cred, "/api/v2/order/get_order_list", params);
      if (!Array.isArray(r.order_list)) throw new ErroShopee("transitorio", "get_order_list: order_list ausente");
      if (r.more && !r.next_cursor) throw new ErroShopee("transitorio", "get_order_list: more sem next_cursor");
      return {
        pedidos: r.order_list.map((o: any) => ({ orderSn: String(o.order_sn) })),
        mais: Boolean(r.more), proximoCursor: r.more ? String(r.next_cursor) : null,
      };
    },
    async detalhes(orderSns: string[]): Promise<PedidoDetalhe[]> {
      const r = await chamar(cred, "/api/v2/order/get_order_detail", {
        order_sn_list: orderSns.join(","), response_optional_fields: CAMPOS_DETALHE,
      });
      return (r.order_list ?? []).map((o: any): PedidoDetalhe => ({
        orderSn: String(o.order_sn), status: o.order_status ?? null,
        createTime: Number(o.create_time), updateTime: Number(o.update_time), payTime: num(o.pay_time) || null,
        cancelBy: o.cancel_by ?? null, cancelReason: o.cancel_reason ?? null, totalAmount: num(o.total_amount),
        itens: (o.item_list ?? []).map((i: any) => ({
          itemId: String(i.item_id), modelId: normalizarModelId(i.model_id), nome: i.item_name ?? null,
          sku: i.model_sku || i.item_sku || null, precoDescontado: num(i.model_discounted_price),
          precoOriginal: num(i.model_original_price), quantidade: Number(i.model_quantity_purchased ?? 0),
        })),
      }));
    },
    async escrow(orderSn: string): Promise<EscrowPedido> {
      const r = await chamar(cred, "/api/v2/payment/get_escrow_detail", { order_sn: orderSn });
      const inc = r.order_income ?? {};
      return {
        orderSn,
        originalShopeeDiscount: Number(inc.original_shopee_discount ?? 0),
        pixDiscount: Number(inc.pix_discount ?? 0),
        itens: (inc.items ?? []).map((i: any) => ({
          itemId: String(i.item_id), modelId: normalizarModelId(i.model_id),
          voucherVendedor: Number(i.discount_from_voucher_seller ?? 0),
          voucherShopee: Number(i.discount_from_voucher_shopee ?? 0),
          moedas: Number(i.discount_from_coin ?? 0),
        })),
      };
    },
  };
}
