import { NextResponse } from "next/server";
import { getMLToken, applyMLCookies } from "@/lib/ml-auth";

export async function GET(request: Request) {
  const tokenResult = await getMLToken(request);

  if (!tokenResult) {
    return NextResponse.json({ erro: "ML não conectado — token expirado e sem refresh_token no banco. Reconecte o ML em Configurações." });
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ erro: "Passe ?id=MLB...", ml_conectado: true });

  const r = await fetch(`https://api.mercadolibre.com/items/${id}`, {
    headers: { Authorization: `Bearer ${tokenResult.token}` },
  });
  const d = await r.json();

  const res = NextResponse.json({
    price: d.price,
    original_price: d.original_price,
    sale_price: d.sale_price ?? null,
    deals: d.deals ?? null,
    promotion_decorations: d.promotion_decorations ?? null,
    base_price: d.base_price ?? null,
    variations_price: d.variations?.map((v: any) => ({
      id: v.id, price: v.price, sale_price: v.sale_price ?? null,
    })) ?? [],
  });

  applyMLCookies(res, tokenResult);
  return res;
}
