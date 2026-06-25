import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { exchangeToken, shopeeGet } from "@/lib/shopee-api";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export async function GET(request: Request) {
  const url    = new URL(request.url);
  const code   = url.searchParams.get("code");
  const shopId = Number(url.searchParams.get("shop_id") ?? 0);

  if (!code || !shopId) {
    return NextResponse.redirect(new URL("/configuracoes?erro=shopee_sem_code", request.url));
  }

  // 1. Troca code por tokens
  const tokenData = await exchangeToken(code, shopId);
  if (tokenData.error) {
    console.error("[shopee callback] token error:", tokenData);
    return NextResponse.redirect(new URL("/configuracoes?erro=shopee_token", request.url));
  }

  const { access_token, refresh_token, expire_in } = tokenData;

  // 2. Busca info da loja
  let nickname = `Shopee ${shopId}`;
  try {
    const shopInfo = await shopeeGet("/api/v2/shop/get_shop_info", access_token, shopId);
    if (shopInfo?.response?.shop_name) nickname = shopInfo.response.shop_name;
  } catch {}

  // 3. Salva/atualiza loja no Supabase
  const expiresAt = new Date(Date.now() + expire_in * 1000).toISOString();

  const { data: loja } = await supabase
    .from("lojas")
    .upsert(
      {
        marketplace:      "Shopee",
        seller_id:        String(shopId),
        nickname,
        nome:             nickname,
        access_token,
        refresh_token,
        token_expires_at: expiresAt,
        ativo:            true,
      },
      { onConflict: "seller_id" }
    )
    .select("id")
    .single();

  const lojaId = loja?.id ?? null;

  // 4. Seta cookies e redireciona
  const res = NextResponse.redirect(new URL("/configuracoes", request.url));

  res.cookies.set("shopee_access_token", access_token, {
    httpOnly: true, secure: false, sameSite: "lax", path: "/",
    maxAge: expire_in,
  });
  res.cookies.set("shopee_shop_id", String(shopId), {
    httpOnly: false, secure: false, sameSite: "lax", path: "/",
    maxAge: 86400 * 30,
  });

  if (lojaId) {
    res.cookies.set("loja_ativa_id", lojaId, {
      httpOnly: false, secure: false, sameSite: "lax", path: "/",
      maxAge: 86400 * 30,
    });
  }

  return res;
}
