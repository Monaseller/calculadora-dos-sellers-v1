import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getUserId } from "@/lib/session";
import { shopeeGet } from "@/lib/shopee-api";
import { obterFaixaShopee, TAXA_CAMPANHA_SHOPEE } from "@/lib/comissoes-shopee";
import { getShopeeLojaAtiva } from "@/lib/shopee-auth";

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
  const skuParam = searchParams.get("sku") ?? "";
  const skuFilters = skuParam.split(",").map(s => s.toLowerCase().trim()).filter(Boolean);

  // Busca loja Shopee ativa com refresh automático de token
  const loja = await getShopeeLojaAtiva(userId);
  if (!loja) {
    return NextResponse.json({ erro: true, semConexao: true, mensagem: "Conta Shopee não conectada." });
  }

  const { partnerId: partner_id, partnerKey: partner_key, accessToken: access_token, shopId, nickname } = loja;

  try {
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
    return NextResponse.json({ dateFrom, dateTo, conta: nickname ?? `Shopee ${shopId}`, marketplace: "Shopee", totalPedidos: 0, rows: [] });
  }

  // ── 2. Anúncios cadastrados no Supabase para custo/imposto ───────────────
  const { data: anuncios } = await supabase
    .from("anuncios")
    .select("id, ml_item_id, variation_id, sku, custo_produto, insumos, custo_frete, imposto")
    .eq("marketplace", "Shopee")
    .eq("ativo", true)
    .eq("user_id", userId);

  const mapaAnuncios = new Map<string, any>();
  for (const a of (anuncios ?? [])) {
    const key = a.variation_id ? `${a.ml_item_id}|${a.variation_id}` : `${a.ml_item_id}|`;
    mapaAnuncios.set(key, a);
    // Também indexa só pelo item_id para fallback
    if (!mapaAnuncios.has(`${a.ml_item_id}|`)) mapaAnuncios.set(`${a.ml_item_id}|`, a);
  }

  // ── 3. Detalhes em lotes de 50 ───────────────────────────────────────────
  const rows: any[] = [];
  const BATCH = 50;

  for (let i = 0; i < allOrderSns.length; i += BATCH) {
    const batch = allOrderSns.slice(i, i + BATCH);

    const detail = await shopeeGet("/api/v2/order/get_order_detail", partner_id, partner_key, access_token, shopId, {
      order_sn_list: batch.join(","),
      response_optional_fields: "item_list,total_amount,order_status,create_time,pay_time",
    });

    for (const order of (detail?.response?.order_list ?? [])) {
      const status  = order.order_status ?? "UNKNOWN";
      const ts      = order.pay_time || order.create_time || 0;
      const dataBrt = new Date((ts - 3 * 3600) * 1000).toISOString().split("T")[0];

      for (const item of (order.item_list ?? [])) {
        const itemIdStr   = String(item.item_id);
        const variationId = item.model_id ? String(item.model_id) : null;
        const valorUnit   = (item.model_discounted_price ?? item.model_original_price ?? 0) / 100000;
        const qtd         = item.model_quantity_purchased ?? 1;
        const faturamento = valorUnit * qtd;

        // Filtro SKU
        if (skuFilters.length > 0) {
          const skuLower  = (item.model_sku ?? "").toLowerCase();
          const nameLower = (item.item_name ?? "").toLowerCase();
          const match = skuFilters.some(f => skuLower.includes(f) || nameLower.includes(f));
          if (!match) continue;
        }

        // Dados do anúncio cadastrado
        const keyVar = variationId ? `${itemIdStr}|${variationId}` : `${itemIdStr}|`;
        const anuncio = mapaAnuncios.get(keyVar) ?? mapaAnuncios.get(`${itemIdStr}|`) ?? null;

        const custo        = anuncio ? ((anuncio.custo_produto || 0) + (anuncio.insumos || 0)) * qtd : 0;
        const impostoVal   = anuncio ? faturamento * ((anuncio.imposto || 0) / 100) : 0;
        const cadastrado   = !!anuncio;

        const faixa         = obterFaixaShopee(valorUnit);
        const comissaoRate  = faixa.comissao + TAXA_CAMPANHA_SHOPEE;
        const tarifaVenda   = faturamento * comissaoRate;
        const margemContrib = faturamento - tarifaVenda - custo - impostoVal;
        const mcPercent     = faturamento > 0 ? (margemContrib / faturamento) * 100 : 0;

        rows.push({
          orderId:        order.order_sn,
          data:           dataBrt,
          anuncio:        item.item_name ?? itemIdStr,
          mlItemId:       itemIdStr,
          conta:          nickname ?? `Shopee ${shopId}`,
          marketplace:    "Shopee",
          sku:            item.model_sku || anuncio?.sku || null,
          status:         mapStatus(status),
          frete:          "comprador" as const,
          logistica:      "Shopee",
          valorUnit,
          qtd,
          faturamento,
          custo,
          imposto:        impostoVal,
          tarifaVenda,
          freteComprador: 0,
          freteVendedor:  0,
          margemContrib,
          mcPercent,
          cadastrado,
        });
      }
    }
  }

  rows.sort((a, b) => b.data.localeCompare(a.data));

  return NextResponse.json({
    dateFrom,
    dateTo,
    conta:        nickname,
    marketplace:  "Shopee",
    totalPedidos: new Set(rows.map(r => r.orderId)).size,
    rows,
  });

  } catch (e: any) {
    console.error("[shopee/vendas] erro:", e);
    return NextResponse.json({ erro: true, mensagem: `Erro Shopee: ${e?.message ?? String(e)}` });
  }
}
