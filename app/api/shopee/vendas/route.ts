import { NextResponse } from "next/server";
import { shopeeGet, shopeePost } from "@/lib/shopee-api";
import { CATEGORIAS_SHOPEE } from "@/lib/comissoes-shopee";

function getShopeeAuth(request: Request): { token: string; shopId: number } | null {
  const cookies = request.headers.get("cookie") || "";
  const token   = cookies.split("; ").find(c => c.startsWith("shopee_access_token="))?.slice("shopee_access_token=".length) ?? "";
  const shopId  = Number(cookies.split("; ").find(c => c.startsWith("shopee_shop_id="))?.slice("shopee_shop_id=".length) ?? 0);
  if (!token || !shopId) return null;
  return { token, shopId };
}

function hojeISO() {
  const now = new Date();
  const brt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  return brt.toISOString().split("T")[0];
}

export async function GET(request: Request) {
  const auth = getShopeeAuth(request);
  if (!auth) {
    return NextResponse.json({ erro: true, semConexao: true, mensagem: "Conta Shopee não conectada." });
  }

  const url      = new URL(request.url);
  const dateFrom = url.searchParams.get("date_from") || hojeISO();
  const dateTo   = url.searchParams.get("date_to")   || hojeISO();

  const timeFrom = Math.floor(new Date(`${dateFrom}T00:00:00-03:00`).getTime() / 1000);
  const timeTo   = Math.floor(new Date(`${dateTo}T23:59:59-03:00`).getTime() / 1000);

  const { token, shopId } = auth;

  // ── 1. Lista orderSNs no período ─────────────────────────────────────────
  const allOrderSns: string[] = [];
  let cursor = "";
  const pageSize = 50;

  for (;;) {
    const params: Record<string, string | number> = {
      time_range_field: "create_time",
      time_from:        timeFrom,
      time_to:          timeTo,
      page_size:        pageSize,
      response_optional_fields: "order_status",
    };
    if (cursor) params.cursor = cursor;

    const data = await shopeeGet("/api/v2/order/get_order_list", token, shopId, params);
    const list: any[] = data?.response?.order_list ?? [];
    allOrderSns.push(...list.map((o: any) => o.order_sn));

    if (!data?.response?.more || !data?.response?.next_cursor) break;
    cursor = data.response.next_cursor;
  }

  if (allOrderSns.length === 0) {
    return NextResponse.json({ dateFrom, dateTo, conta: `Shopee ${shopId}`, rows: [] });
  }

  // ── 2. Detalhes dos pedidos em lotes de 50 ───────────────────────────────
  type VendaRow = {
    orderId:     string;
    data:        string;
    anuncio:     string;
    conta:       string;
    marketplace: string;
    sku:         string | null;
    status:      string;
    valorUnit:   number;
    qtd:         number;
    faturamento: number;
    tarifaVenda: number;
    margemContrib: number;
    mcPercent:   number;
  };

  const rows: VendaRow[] = [];
  const BATCH = 50;

  for (let i = 0; i < allOrderSns.length; i += BATCH) {
    const batch = allOrderSns.slice(i, i + BATCH);

    const detail = await shopeePost("/api/v2/order/get_order_detail", token, shopId, {
      order_sn_list: batch,
      response_optional_fields: [
        "item_list", "total_amount", "buyer_username",
        "order_status", "create_time", "pay_time",
      ].join(","),
    });

    const orders: any[] = detail?.response?.order_list ?? [];

    for (const order of orders) {
      const status    = order.order_status ?? "UNKNOWN";
      const ts        = order.pay_time || order.create_time || 0;
      const dataBrt   = new Date((ts - 3 * 3600) * 1000).toISOString().split("T")[0];

      if (dataBrt < dateFrom || dataBrt > dateTo) continue;

      const items: any[] = order.item_list ?? [];
      for (const item of items) {
        const valorUnit: number = item.model_discounted_price ?? item.model_original_price ?? 0;
        const qtd:       number = item.model_quantity_purchased ?? 1;
        const faturamento       = valorUnit * qtd;

        // Comissão Shopee — tenta mapear categoria
        const cat = CATEGORIAS_SHOPEE.find(c =>
          (item.item_name ?? "").toLowerCase().includes(c.nome.toLowerCase())
        );
        const comissaoRate = cat?.taxa ?? 0.14; // 14% padrão
        const tarifaVenda  = faturamento * comissaoRate;
        const margemContrib = faturamento - tarifaVenda;
        const mcPercent    = faturamento > 0 ? (margemContrib / faturamento) * 100 : 0;

        rows.push({
          orderId:      order.order_sn,
          data:         dataBrt,
          anuncio:      item.item_name ?? item.item_id,
          conta:        `Shopee ${shopId}`,
          marketplace:  "Shopee",
          sku:          item.model_sku || null,
          status:       mapStatus(status),
          valorUnit,
          qtd,
          faturamento,
          tarifaVenda,
          margemContrib,
          mcPercent,
        });
      }
    }
  }

  rows.sort((a, b) => b.data.localeCompare(a.data));

  return NextResponse.json({
    dateFrom,
    dateTo,
    conta: `Shopee ${shopId}`,
    totalPedidos: allOrderSns.length,
    rows,
  });
}

function mapStatus(s: string): string {
  const m: Record<string, string> = {
    UNPAID:              "pending",
    READY_TO_SHIP:       "paid",
    PROCESSED:           "paid",
    SHIPPED:             "paid",
    TO_CONFIRM_RECEIVE:  "paid",
    COMPLETED:           "paid",
    CANCELLED:           "cancelled",
    IN_CANCEL:           "cancelled",
    TO_RETURN:           "devolucao",
  };
  return m[s] ?? "paid";
}
