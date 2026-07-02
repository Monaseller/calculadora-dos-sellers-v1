import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createHmac } from "crypto";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") || "";
  const entry  = header.split("; ").find(c => c.startsWith(`${name}=`));
  return entry ? entry.slice(name.length + 1) : null;
}

// Shopee espera a chave completa como string UTF-8
function getHmacKey(partnerKey: string): string {
  return partnerKey;
}

function shopeeSign(partnerId: string, path: string, timestamp: number, partnerKey: string) {
  return createHmac("sha256", getHmacKey(partnerKey))
    .update(`${partnerId}${path}${timestamp}`)
    .digest("hex");
}

export async function GET(request: Request) {
  const url    = new URL(request.url);
  const code   = url.searchParams.get("code");
  const shopId = Number(url.searchParams.get("shop_id") ?? 0);

  // Usa credenciais centrais do servidor (env vars)
  const partnerId  = process.env.SHOPEE_PARTNER_ID  ?? getCookie(request, "shopee_partner_id");
  const partnerKey = process.env.SHOPEE_PARTNER_KEY ?? getCookie(request, "shopee_partner_key");
  const baseUrl    = process.env.SHOPEE_BASE_URL ?? "https://partner.shopeemobile.com";
  const userId     = getCookie(request, "cds_session");

  if (!code || !shopId || !partnerId || !partnerKey) {
    return NextResponse.redirect(new URL("/configuracoes?erro=shopee_sem_credenciais", request.url));
  }

  // 1. Troca code por access_token
  const timestamp  = Math.floor(Date.now() / 1000);
  const tokenPath  = "/api/v2/auth/token/get";
  const sign       = shopeeSign(partnerId, tokenPath, timestamp, partnerKey);

  const tokenRes = await fetch(
    `${baseUrl}${tokenPath}?partner_id=${partnerId}&timestamp=${timestamp}&sign=${sign}`,
    {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ code, shop_id: shopId, partner_id: Number(partnerId) }),
    }
  );
  const tokenData = await tokenRes.json();

  if (!tokenData.access_token) {
    console.error("[shopee callback] token error:", tokenData);
    return NextResponse.redirect(new URL("/configuracoes?erro=shopee_token", request.url));
  }

  const { access_token, refresh_token, expire_in } = tokenData;

  // 2. Busca nome da loja (assinatura correta para endpoints autenticados: pid+path+ts+token+shopId)
  let nickname = `Shopee ${shopId}`;
  try {
    const ts2    = Math.floor(Date.now() / 1000);
    const iPath  = "/api/v2/shop/get_shop_info";
    // Endpoints autenticados exigem assinatura com accessToken E shopId
    const iBase  = `${partnerId}${iPath}${ts2}${access_token}${shopId}`;
    const iSign  = createHmac("sha256", getHmacKey(partnerKey)).update(iBase).digest("hex");
    const infoRes = await fetch(
      `${baseUrl}${iPath}?partner_id=${partnerId}&timestamp=${ts2}&sign=${iSign}&access_token=${access_token}&shop_id=${shopId}`
    );
    const info = await infoRes.json();
    console.log("[shopee callback] shop_info:", JSON.stringify(info).slice(0, 300));
    if (info?.response?.shop_name) nickname = info.response.shop_name;
  } catch (e) {
    console.error("[shopee callback] get_shop_info error:", e);
  }

  // 3. Salva loja no Supabase (SELECT + UPDATE para evitar problemas de constraint)
  const expiresAt = new Date(Date.now() + (expire_in ?? 14400) * 1000).toISOString();

  let lojaId: string | null = null;

  const { data: existente } = await supabase
    .from("lojas")
    .select("id")
    .eq("marketplace", "Shopee")
    .eq("seller_id", String(shopId))
    .eq("user_id", userId ?? "")
    .limit(1)
    .maybeSingle();

  if (existente?.id) {
    await supabase.from("lojas").update({
      nickname,
      nome:             nickname,
      access_token,
      refresh_token:    refresh_token ?? null,
      token_expires_at: expiresAt,
      ativo:            true,
      user_id:          userId ?? null,
      partner_id:       partnerId,
      partner_key:      partnerKey,
    }).eq("id", existente.id);
    lojaId = existente.id;
  } else {
    const { data: nova } = await supabase.from("lojas").insert({
      marketplace:      "Shopee",
      seller_id:        String(shopId),
      shop_id:          String(shopId),
      partner_id:       partnerId,
      partner_key:      partnerKey,
      nickname,
      nome:             nickname,
      access_token,
      refresh_token:    refresh_token ?? null,
      token_expires_at: expiresAt,
      ativo:            true,
      user_id:          userId ?? null,
    }).select("id").single();
    lojaId = nova?.id ?? null;
  }

  // 4. Seta cookies e redireciona
  const res = NextResponse.redirect(new URL("/configuracoes?ok=shopee", request.url));

  // Limpa credenciais temporárias
  res.cookies.set("shopee_partner_id",  "", { maxAge: 0, path: "/" });
  res.cookies.set("shopee_partner_key", "", { maxAge: 0, path: "/" });

  // Salva token ativo
  const isProd = process.env.NODE_ENV === "production";
  res.cookies.set("shopee_access_token", access_token, {
    httpOnly: true, secure: isProd, sameSite: "lax", path: "/", maxAge: expire_in ?? 14400,
  });
  res.cookies.set("shopee_shop_id", String(shopId), {
    httpOnly: false, secure: isProd, sameSite: "lax", path: "/", maxAge: 86400 * 30,
  });

  if (lojaId) {
    // Cookie específico da Shopee — não sobrescreve loja_ativa_id do ML
    res.cookies.set("shopee_loja_id", lojaId, {
      httpOnly: false, secure: isProd, sameSite: "lax", path: "/", maxAge: 86400 * 30,
    });
  }

  return res;
}
