import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getUserId } from "@/lib/session";
import { shopeeGet, shopeePost } from "@/lib/shopee-api";
import { CATEGORIAS_SHOPEE } from "@/lib/comissoes-shopee";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

function hojeISO() {
  const now = new Date();
  return new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString().split("T")[0];
}

function mapStatus(s: string): string {
  const m: Record<string, string> = {
    UNPAID:             "pending",
    READY_TO_SHIP:      "paid",
    PROCESSED:          "paid",
    SHIPPED:            "paid",
    TO_CONFIRM_RECEIVE: "paid",
    COMPLETED:          "paid",
    CANCELLED:          "cancelled",
    IN_CANCEL:          "cancelled",
    TO_RETURN:          "devolucao",
  };
  return m[s] ?? "paid";
}

// GET /api/shopee/vendas?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD
export async function GET(request: Request) {
  const userId = getUserId(request);
  if (!userId) return NextResponse.json({ erro: true, mensagem: "Sessão inválida." }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const dateFrom = searchParams.get("date_from") ?? hojeISO();
  const dateTo   = searchParams.get("date_to")   ?? dateFrom;

  // Busca loja Shopee ativa do usuário no Supabase
  const { data: loja } = await supabase
    .from("lojas")
    .select("id, shop_id, partner_id, partner_key, access_token, nickname")
    .eq("user_id", userId)
    .eq("marketplace", "Shopee")
    .eq("ativo", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (!loja || !loja.partner_id || !loja.partner_key || !loja.access_token) {
    return NextResponse.json({ erro: true, semConexao: true, mensagem: "Conta Shopee não conectada." });
  }

  const { shop_id, partner_id, partner_key, access_token, nickname } = loja;
  const shopId = Number(shop_id);

  const timeFrom = Math.floor(new Date(`${dateFrom}T00:00:00-03:00`).getTime() / 1000);
  const timeTo   = Math.floor(new Date(`${dateTo}T23:59:59-03:00`).getTime() / 1000);

  // ── 1. Lista orderSNs no período ─────────────────────────────────────────
  const allOrderSns: string[] = [];
  let cursor = "";

  for (;;) {
    const params: Record<string, string | number> = {
      time_range_field:         "create_time",
      time_from:                timeFrom,
      time_to:                  timeTo,
      page_size:                50,
      response_optional_fields: "order_status",
    };
    if (cursor) params.cursor = cursor;

    const data = await shopeeGet("/api/v2/order/get_order_list", partner_id, partner_key, access_token, shopId, params);
    const list: any[] = data?.response?.order_list ?? [];
    allOrderSns.push(...list.map((o: any) => o.order_sn));

    if (!data?.response?.more || !data?.response?.next_cursor) break;
    cursor = data.response.next_cursor;
  }

  if (allOrderSns.length === 0) {
    return NextResponse.json({ dateFrom, dateTo, conta: nickname ?? `Shopee ${shopId}`, rows: [] });
  }

  // ── 2. Detalhes em lotes de 50 ───────────────────────────────────────────
  const rows: any[] = [];
  const BATCH = 50;

  for (let i = 0; i < allOrderSns.length; i += BATCH) {
    const batch = allOrderSns.slice(i, i + BATCH);

    const detail = await shopeePost("/api/v2/order/get_order_detail", partner_id, partner_key, access_token, shopId, {
      order_sn_list: batch,
      response_optional_fields: "item_list,total_amount,order_status,create_time,pay_time",
    });

    for (const order of (detail?.response?.order_list ?? [])) {
      const status  = order.order_status ?? "UNKNOWN";
      const ts      = order.pay_time || order.create_time || 0;
      const dataBrt = new Date((ts - 3 * 3600) * 1000).toISOString().split("T")[0];

      for (const item of (order.item_list ?? [])) {
        const valorUnit   = item.model_discounted_price ?? item.model_original_price ?? 0;
        const qtd         = item.model_quantity_purchased ?? 1;
        const faturamento = valorUnit * qtd;

        const cat = CATEGORIAS_SHOPEE.find(c =>
          (item.item_name ?? "").toLowerCase().includes(c.nome.toLowerCase())
        );
        const comissaoRate  = cat?.taxa ?? 0.14;
        const tarifaVenda   = faturamento * comissaoRate;
        const margemContrib = faturamento - tarifaVenda;
        const mcPercent     = faturamento > 0 ? (margemContrib / faturamento) * 100 : 0;

        rows.push({
          orderId:      order.order_sn,
          data:         dataBrt,
          anuncio:      item.item_name ?? String(item.item_id),
          mlItemId:     String(item.item_id),
          conta:        nickname ?? `Shopee ${shopId}`,
          marketplace:  "Shopee",
          sku:          item.model_sku || null,
          status:       mapStatus(status),
          qtd,
          faturamento,
          custo:        0,
          tarifaVenda,
          freteComprador: 0,
          freteVendedor:  0,
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
    conta:        nickname ?? `Shopee ${shopId}`,
    marketplace:  "Shopee",
    totalPedidos: new Set(rows.map(r => r.orderId)).size,
    rows,
  });
}
