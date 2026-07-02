/**
 * GET /api/shopee/ping
 * Diagnóstico: testa conectividade e credenciais Shopee.
 * Retorna timing e resposta bruta das principais chamadas.
 */
import { NextResponse } from "next/server";
import { getUserId } from "@/lib/session";
import { getShopeeLojaAtiva } from "@/lib/shopee-auth";
import { SHOPEE_BASE, shopeeSign } from "@/lib/shopee-api";

export const maxDuration = 30;

export async function GET(request: Request) {
  const userId = getUserId(request);
  if (!userId) return NextResponse.json({ erro: "Sessão inválida" }, { status: 401 });

  const diag: Record<string, any> = {
    baseUrl:    SHOPEE_BASE,
    timestamp:  new Date().toISOString(),
  };

  // 1. Busca loja no banco
  const t0 = Date.now();
  const loja = await getShopeeLojaAtiva(userId);
  diag.getLojaMs = Date.now() - t0;

  if (!loja) {
    return NextResponse.json({ ...diag, erro: "Shopee não conectada" });
  }

  diag.shopId    = loja.shopId;
  diag.partnerId = loja.partnerId;
  diag.nickname  = loja.nickname;

  // 2. get_shop_info (call simples, sem pedidos)
  try {
    const t1   = Date.now();
    const path = "/api/v2/shop/get_shop_info";
    const ts   = Math.floor(Date.now() / 1000);
    const sign = shopeeSign(loja.partnerId, loja.partnerKey, path, ts, loja.accessToken, loja.shopId);
    const url  = `${SHOPEE_BASE}${path}?partner_id=${loja.partnerId}&timestamp=${ts}&sign=${sign}&access_token=${loja.accessToken}&shop_id=${loja.shopId}`;

    const raceResult = await Promise.race([
      fetch(url).then(r => r.json()),
      new Promise<any>((_, rej) => setTimeout(() => rej(new Error("timeout 8s")), 8000)),
    ]);
    diag.shopInfoMs  = Date.now() - t1;
    diag.shopInfo    = raceResult;
  } catch (e: any) {
    diag.shopInfoErro = e?.message ?? String(e);
  }

  // 3. get_order_list (janela de 1 dia para medir tempo)
  try {
    const t2     = Date.now();
    const path   = "/api/v2/order/get_order_list";
    const ts2    = Math.floor(Date.now() / 1000);
    const sign2  = shopeeSign(loja.partnerId, loja.partnerKey, path, ts2, loja.accessToken, loja.shopId);
    const hoje   = new Date(Date.now() - 3 * 3600 * 1000).toISOString().split("T")[0];
    const from   = Math.floor(new Date(`${hoje}T00:00:00-03:00`).getTime() / 1000);
    const to     = Math.floor(new Date(`${hoje}T23:59:59-03:00`).getTime() / 1000);
    const qs     = new URLSearchParams({
      partner_id:               loja.partnerId,
      timestamp:                String(ts2),
      sign:                     sign2,
      access_token:             loja.accessToken,
      shop_id:                  String(loja.shopId),
      time_range_field:         "create_time",
      time_from:                String(from),
      time_to:                  String(to),
      page_size:                "5",
      response_optional_fields: "order_status",
    });

    const raceResult2 = await Promise.race([
      fetch(`${SHOPEE_BASE}${path}?${qs}`).then(r => r.json()),
      new Promise<any>((_, rej) => setTimeout(() => rej(new Error("timeout 8s")), 8000)),
    ]);
    diag.orderListMs    = Date.now() - t2;
    diag.orderListError = raceResult2?.error ?? null;
    diag.orderListCount = raceResult2?.response?.order_list?.length ?? 0;
    diag.orderListRaw   = raceResult2;
  } catch (e: any) {
    diag.orderListErro = e?.message ?? String(e);
  }

  return NextResponse.json(diag);
}
