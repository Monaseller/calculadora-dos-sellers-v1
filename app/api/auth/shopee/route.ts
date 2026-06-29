import { NextResponse } from "next/server";
import { createHmac } from "crypto";

// POST /api/auth/shopee
// Body: { partner_id: string, partner_key: string }
// Salva credenciais em cookies temporários e retorna URL de OAuth
export async function POST(request: Request) {
  const { partner_id, partner_key } = await request.json();

  if (!partner_id || !partner_key) {
    return NextResponse.json({ erro: true, mensagem: "partner_id e partner_key são obrigatórios." }, { status: 400 });
  }

  const partnerId  = String(partner_id).trim();
  const partnerKey = String(partner_key).trim();
  const timestamp  = Math.floor(Date.now() / 1000);
  const path       = "/api/v2/shop/auth_partner";
  const baseString = `${partnerId}${path}${timestamp}`;
  const sign       = createHmac("sha256", partnerKey).update(baseString).digest("hex");

  const siteUrl    = process.env.NEXT_PUBLIC_SITE_URL ?? "https://calculadora-dos-sellers-v1.vercel.app";
  const redirectUri = `${siteUrl}/api/auth/shopee/callback`;

  const authUrl =
    `https://partner.shopeemobile.com${path}` +
    `?partner_id=${partnerId}` +
    `&timestamp=${timestamp}` +
    `&sign=${sign}` +
    `&redirect=${encodeURIComponent(redirectUri)}`;

  const res = NextResponse.json({ url: authUrl });

  // Credenciais ficam em cookies httpOnly por 10 min para o callback usar
  res.cookies.set("shopee_partner_id",  partnerId,  { httpOnly: true, maxAge: 600, path: "/" });
  res.cookies.set("shopee_partner_key", partnerKey, { httpOnly: true, maxAge: 600, path: "/" });

  return res;
}
