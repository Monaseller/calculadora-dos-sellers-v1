import { NextResponse } from "next/server";

function getToken(request: Request): string | null {
  const cookieHeader = request.headers.get("cookie") || "";
  const entry = cookieHeader.split("; ").find(c => c.startsWith("ml_access_token="));
  return entry ? entry.slice("ml_access_token=".length) : null;
}

export async function GET(request: Request) {
  const token = getToken(request);
  if (!token) return NextResponse.json({ erro: "ML não conectado" });

  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ erro: "Passe ?id=MLB..." });

  const r = await fetch(`https://api.mercadolibre.com/items/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const d = await r.json();

  return NextResponse.json({
    id: d.id,
    title: d.title,
    status: d.status,
    price: d.price,
    original_price: d.original_price,
    sale_price: d.sale_price ?? null,
    deals: d.deals ?? null,
    promotion_type: d.promotion_decorations ?? null,
  });
}
