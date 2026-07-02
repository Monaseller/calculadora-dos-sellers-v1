import crypto from "crypto";

export const SHOPEE_BASE = process.env.SHOPEE_BASE_URL ?? "https://partner.shopeemobile.com";

// Shopee espera a chave completa como string UTF-8 (não hex-decodificar)
function getHmacKey(partnerKey: string): string {
  return partnerKey;
}

// ── Assinatura por usuário (credenciais dinâmicas) ───────────────────────────
export function shopeeSign(
  partnerId: string | number,
  partnerKey: string,
  path: string,
  timestamp: number,
  accessToken = "",
  shopId: string | number = 0
): string {
  const pid  = String(partnerId);
  const sid  = String(shopId);
  const base = sid && sid !== "0"
    ? `${pid}${path}${timestamp}${accessToken}${sid}`
    : accessToken
      ? `${pid}${path}${timestamp}${accessToken}`
      : `${pid}${path}${timestamp}`;
  return crypto.createHmac("sha256", getHmacKey(partnerKey)).update(base).digest("hex");
}

// ── GET autenticado ──────────────────────────────────────────────────────────
export async function shopeeGet(
  path: string,
  partnerId: string,
  partnerKey: string,
  accessToken: string,
  shopId: string | number,
  params: Record<string, string | number> = {}
): Promise<any> {
  const timestamp = Math.floor(Date.now() / 1000);
  const sign      = shopeeSign(partnerId, partnerKey, path, timestamp, accessToken, shopId);

  const qs = new URLSearchParams({
    partner_id:   partnerId,
    timestamp:    String(timestamp),
    access_token: accessToken,
    shop_id:      String(shopId),
    sign,
    ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
  });

  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), 10000); // 10s timeout por chamada
  let res: Response;
  try {
    res = await fetch(`${SHOPEE_BASE}${path}?${qs}`, { signal: ctrl.signal });
  } catch (fetchErr: any) {
    clearTimeout(timeoutId);
    if (fetchErr?.name === "AbortError") throw new Error(`Shopee GET ${path} timeout (10s)`);
    throw fetchErr;
  }
  clearTimeout(timeoutId);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    console.error(`[shopee-api] GET ${path} status=${res.status} body=${text.slice(0, 300)}`);
    throw new Error(`Shopee GET ${path} retornou JSON inválido (${res.status}): ${text.slice(0, 150)}`);
  }
}

// ── POST autenticado ─────────────────────────────────────────────────────────
export async function shopeePost(
  path: string,
  partnerId: string,
  partnerKey: string,
  accessToken: string,
  shopId: string | number,
  body: Record<string, any>
): Promise<any> {
  const timestamp = Math.floor(Date.now() / 1000);
  const sign      = shopeeSign(partnerId, partnerKey, path, timestamp, accessToken, shopId);

  const qs = new URLSearchParams({
    partner_id:   partnerId,
    timestamp:    String(timestamp),
    access_token: accessToken,
    shop_id:      String(shopId),
    sign,
  });

  const res = await fetch(`${SHOPEE_BASE}${path}?${qs}`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    console.error(`[shopee-api] POST ${path} status=${res.status} body=${text.slice(0, 300)}`);
    throw new Error(`Shopee POST ${path} retornou JSON inválido (${res.status}): ${text.slice(0, 150)}`);
  }
}
