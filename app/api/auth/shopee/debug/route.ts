import { NextResponse } from "next/server";
import { createHmac } from "crypto";

export async function GET() {
  const partnerId  = process.env.SHOPEE_PARTNER_ID ?? "NOT_SET";
  const partnerKey = process.env.SHOPEE_PARTNER_KEY ?? "NOT_SET";
  const baseUrl    = process.env.SHOPEE_BASE_URL ?? "NOT_SET";

  const path = "/api/v2/shop/auth_partner";
  const ts   = Math.floor(Date.now() / 1000);
  const base = `${partnerId}${path}${ts}`;

  // Método 1: key como string
  const sign1 = createHmac("sha256", partnerKey).update(base).digest("hex");

  // Método 2: key sem prefixo shpk (string)
  const keyNoPrefix = partnerKey.startsWith("shpk") ? partnerKey.slice(4) : partnerKey;
  const sign2 = createHmac("sha256", keyNoPrefix).update(base).digest("hex");

  // Método 3: key sem prefixo shpk (hex decoded → Buffer)
  let sign3 = "error";
  try {
    const keyBuf = Buffer.from(keyNoPrefix, "hex");
    sign3 = createHmac("sha256", keyBuf).update(base).digest("hex");
  } catch (e) { sign3 = String(e); }

  return NextResponse.json({
    partnerId,
    partnerKeyLength: partnerKey.length,
    partnerKeyStart: partnerKey.slice(0, 8),
    partnerKeyEnd: partnerKey.slice(-8),
    baseUrl,
    baseString: base,
    timestamp: ts,
    sign_key_as_string: sign1,
    sign_no_shpk_string: sign2,
    sign_no_shpk_hex_decoded: sign3,
    url_sign1: `https://partner.test-stable.shopeemobile.com${path}?partner_id=${partnerId}&timestamp=${ts}&sign=${sign1}&redirect=https://www.calculadoradossellers.com.br/api/auth/shopee/callback`,
    url_sign3: `https://partner.test-stable.shopeemobile.com${path}?partner_id=${partnerId}&timestamp=${ts}&sign=${sign3}&redirect=https://www.calculadoradossellers.com.br/api/auth/shopee/callback`,
  });
}
