import { NextResponse } from "next/server";
import { getMLToken, applyMLCookies } from "@/lib/ml-auth";

export async function GET(request: Request) {
  const tokenResult = await getMLToken(request);
  if (!tokenResult) {
    return NextResponse.json({ erro: "ML não conectado" });
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ erro: "Passe ?id=MLB...", ml_conectado: true });

  const token = tokenResult.token;
  const headers = { Authorization: `Bearer ${token}` };

  // Busca item principal
  const [itemRes, promoRes, dealRes] = await Promise.all([
    fetch(`https://api.mercadolibre.com/items/${id}`, { headers }),
    fetch(`https://api.mercadolibre.com/seller-promotions/items/${id}?app_version=v2`, { headers }),
    fetch(`https://api.mercadolibre.com/items/${id}/deals`, { headers }),
  ]);

  const item  = await itemRes.json();
  const promo = promoRes.ok ? await promoRes.json() : { status: promoRes.status, erro: "não acessível" };
  const deal  = dealRes.ok  ? await dealRes.json()  : { status: dealRes.status,  erro: "não acessível" };

  const res = NextResponse.json({
    // preços do item
    price:                item.price,
    original_price:       item.original_price,
    sale_price:           item.sale_price ?? null,
    base_price:           item.base_price ?? null,
    deals:                item.deals ?? null,
    promotion_decorations: item.promotion_decorations ?? null,
    // promoções do vendedor
    seller_promotions:    promo,
    item_deals:           deal,
  });

  applyMLCookies(res, tokenResult);
  return res;
}
