import { NextResponse } from "next/server";
import { createHmac } from "crypto";

// Chaves shpk* têm o segredo em hex após o prefixo
function getHmacKey(partnerKey: string): string | Buffer {
  if (partnerKey.startsWith("shpk")) {
    return Buffer.from(partnerKey.slice(4), "hex");
  }
  return partnerKey;
}

// GET /api/auth/shopee
// Gera URL de autorização Shopee usando credenciais do servidor (env vars)
export async function GET(request: Request) {
  const partnerId  = process.env.SHOPEE_PARTNER_ID;
  const partnerKey = process.env.SHOPEE_PARTNER_KEY;
  const baseUrl    = process.env.SHOPEE_BASE_URL ?? "https://partner.shopeemobile.com";

  if (!partnerId || !partnerKey) {
    return NextResponse.json({ erro: true, mensagem: "Credenciais Shopee não configuradas no servidor." }, { status: 500 });
  }

  const timestamp   = Math.floor(Date.now() / 1000);
  const path        = "/api/v2/shop/auth_partner";
  const baseString  = `${partnerId}${path}${timestamp}`;
  const sign        = createHmac("sha256", getHmacKey(partnerKey)).update(baseString).digest("hex");

  const siteUrl     = process.env.SHOPEE_REDIRECT_URI
    ?? `${process.env.NEXT_PUBLIC_SITE_URL ?? "https://www.calculadoradossellers.com.br"}/api/auth/shopee/callback`;

  const authUrl =
    `${baseUrl}${path}` +
    `?partner_id=${partnerId}` +
    `&timestamp=${timestamp}` +
    `&sign=${sign}` +
    `&redirect=${encodeURIComponent(siteUrl)}`;

  // Redireciona direto para a Shopee
  return NextResponse.redirect(authUrl);
}

// Mantém POST para compatibilidade
export async function POST(request: Request) {
  return GET(request);
}
