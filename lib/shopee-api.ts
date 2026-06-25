import crypto from "crypto";

// ── Configuração ────────────────────────────────────────────────────────────
const PARTNER_ID  = Number(process.env.SHOPEE_PARTNER_ID ?? 0);
const PARTNER_KEY = process.env.SHOPEE_PARTNER_KEY ?? "";
const REDIRECT_URI = process.env.SHOPEE_REDIRECT_URI ?? "";

// Sandbox vs produção
const IS_SANDBOX  = process.env.SHOPEE_SANDBOX === "true";
export const BASE_URL = IS_SANDBOX
  ? "https://partner.test-stable.shopeemobile.com"
  : "https://partner.shopeemobile.com";

// ── Assinatura HMAC-SHA256 ───────────────────────────────────────────────────
// Formato base_string varia por tipo de chamada:
//   Sem token (auth):   partner_id + path + timestamp
//   Com token e shop:   partner_id + path + timestamp + access_token + shop_id
export function sign(path: string, timestamp: number, accessToken = "", shopId = 0): string {
  const base = shopId
    ? `${PARTNER_ID}${path}${timestamp}${accessToken}${shopId}`
    : accessToken
      ? `${PARTNER_ID}${path}${timestamp}${accessToken}`
      : `${PARTNER_ID}${path}${timestamp}`;
  return crypto.createHmac("sha256", PARTNER_KEY).update(base).digest("hex");
}

// ── URL de autorização OAuth ─────────────────────────────────────────────────
export function buildAuthUrl(): string {
  const path      = "/api/v2/shop/auth_partner";
  const timestamp = Math.floor(Date.now() / 1000);
  const s         = sign(path, timestamp);
  const redirect  = encodeURIComponent(REDIRECT_URI);
  return `${BASE_URL}${path}?partner_id=${PARTNER_ID}&timestamp=${timestamp}&sign=${s}&redirect=${redirect}`;
}

// ── Troca code → tokens ──────────────────────────────────────────────────────
export async function exchangeToken(code: string, shopId: number): Promise<{
  access_token:  string;
  refresh_token: string;
  expire_in:     number;
  error?:        string;
}> {
  const path      = "/api/v2/auth/token/get";
  const timestamp = Math.floor(Date.now() / 1000);
  const s         = sign(path, timestamp);

  const res = await fetch(`${BASE_URL}${path}?partner_id=${PARTNER_ID}&timestamp=${timestamp}&sign=${s}`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ code, shop_id: shopId, partner_id: PARTNER_ID }),
  });

  return res.json();
}

// ── Refresh token ────────────────────────────────────────────────────────────
export async function refreshToken(refreshTk: string, shopId: number): Promise<{
  access_token:  string;
  refresh_token: string;
  expire_in:     number;
  error?:        string;
}> {
  const path      = "/api/v2/auth/access_token/get";
  const timestamp = Math.floor(Date.now() / 1000);
  const s         = sign(path, timestamp);

  const res = await fetch(`${BASE_URL}${path}?partner_id=${PARTNER_ID}&timestamp=${timestamp}&sign=${s}`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ refresh_token: refreshTk, shop_id: shopId, partner_id: PARTNER_ID }),
  });

  return res.json();
}

// ── Chamada autenticada genérica ─────────────────────────────────────────────
export async function shopeeGet(
  path: string,
  accessToken: string,
  shopId: number,
  params: Record<string, string | number> = {}
): Promise<any> {
  const timestamp = Math.floor(Date.now() / 1000);
  const s         = sign(path, timestamp, accessToken, shopId);

  const qs = new URLSearchParams({
    partner_id:   String(PARTNER_ID),
    timestamp:    String(timestamp),
    access_token: accessToken,
    shop_id:      String(shopId),
    sign:         s,
    ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
  });

  const res = await fetch(`${BASE_URL}${path}?${qs}`);
  return res.json();
}

export async function shopeePost(
  path: string,
  accessToken: string,
  shopId: number,
  body: Record<string, any>
): Promise<any> {
  const timestamp = Math.floor(Date.now() / 1000);
  const s         = sign(path, timestamp, accessToken, shopId);

  const qs = new URLSearchParams({
    partner_id:   String(PARTNER_ID),
    timestamp:    String(timestamp),
    access_token: accessToken,
    shop_id:      String(shopId),
    sign:         s,
  });

  const res = await fetch(`${BASE_URL}${path}?${qs}`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });

  return res.json();
}

export { PARTNER_ID, REDIRECT_URI };
