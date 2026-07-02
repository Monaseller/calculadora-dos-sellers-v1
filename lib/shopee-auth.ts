/**
 * Gerenciamento de token Shopee com refresh automático.
 * Access token expira em ~4h. Refresh token dura 30 dias.
 */
import { createClient } from "@supabase/supabase-js";
import { shopeeSign, SHOPEE_BASE } from "@/lib/shopee-api";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export interface ShopeeTokenResult {
  access_token: string;
  refresh_token?: string;
  expire_in?: number;
}

/**
 * Tenta fazer refresh do access token usando o refresh_token.
 * Retorna o novo access_token ou null se falhou.
 */
export async function refreshShopeeToken(
  partnerId: string,
  partnerKey: string,
  shopId: number,
  refreshToken: string
): Promise<ShopeeTokenResult | null> {
  try {
    const path      = "/api/v2/auth/access_token/get";
    const timestamp = Math.floor(Date.now() / 1000);
    const sign      = shopeeSign(partnerId, partnerKey, path, timestamp);

    const refreshCtrl = new AbortController();
    const refreshTimer = setTimeout(() => refreshCtrl.abort(), 8000); // 8s timeout
    let res: Response;
    try {
      res = await fetch(
        `${SHOPEE_BASE}${path}?partner_id=${partnerId}&timestamp=${timestamp}&sign=${sign}`,
        {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({
            shop_id:       shopId,
            refresh_token: refreshToken,
            partner_id:    Number(partnerId),
          }),
          signal: refreshCtrl.signal,
        }
      );
    } catch {
      clearTimeout(refreshTimer);
      return null; // timeout ou erro de rede no refresh
    }
    clearTimeout(refreshTimer);

    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.access_token) return null;

    return {
      access_token:  data.access_token,
      refresh_token: data.refresh_token ?? refreshToken,
      expire_in:     data.expire_in ?? 14400,
    };
  } catch {
    return null;
  }
}

/**
 * Busca loja Shopee ativa do usuário e garante token válido.
 * Faz refresh automático se o token estiver expirado.
 * Retorna os dados da loja com access_token garantido, ou null.
 */
export async function getShopeeLojaAtiva(userId: string): Promise<{
  lojaId:      string;
  partnerId:   string;
  partnerKey:  string;
  accessToken: string;
  shopId:      number;
  nickname:    string;
} | null> {
  const { data: loja, error: dbErr } = await supabase
    .from("lojas")
    .select("id, shop_id, partner_id, partner_key, access_token, refresh_token, token_expires_at, nickname, ativo")
    .eq("user_id", userId)
    .eq("marketplace", "Shopee")
    .eq("ativo", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (dbErr) {
    console.error("[shopee-auth] db error:", dbErr.message, "userId:", userId);
    return null;
  }
  if (!loja) {
    console.error("[shopee-auth] loja não encontrada para userId:", userId);
    return null;
  }
  if (!loja.partner_id || !loja.partner_key) {
    console.error("[shopee-auth] loja sem partner_id/partner_key:", loja.id);
    return null;
  }

  let accessToken: string = loja.access_token;

  // Verifica se token expirou (com 5 min de margem)
  const expiredOrMissing = !loja.access_token ||
    (loja.token_expires_at && new Date(loja.token_expires_at).getTime() - 5 * 60 * 1000 < Date.now());

  if (expiredOrMissing && loja.refresh_token) {
    console.log("[shopee-auth] token expirado, tentando refresh para loja:", loja.id);
    const refreshed = await refreshShopeeToken(
      loja.partner_id,
      loja.partner_key,
      Number(loja.shop_id),
      loja.refresh_token
    );
    if (refreshed) {
      console.log("[shopee-auth] refresh OK para loja:", loja.id);
      accessToken = refreshed.access_token;
      // Salva novo token no banco
      await supabase.from("lojas").update({
        access_token:     refreshed.access_token,
        refresh_token:    refreshed.refresh_token ?? loja.refresh_token,
        token_expires_at: new Date(Date.now() + (refreshed.expire_in ?? 14400) * 1000).toISOString(),
      }).eq("id", loja.id);
    } else {
      // Refresh falhou → token expirado e não renovável → não tenta usar token inválido
      console.error("[shopee-auth] refresh FALHOU para loja:", loja.id, "- reconecte a Shopee");
      return null;
    }
  }

  if (!accessToken) {
    console.error("[shopee-auth] sem accessToken para loja:", loja.id, "expirado:", expiredOrMissing, "tem_refresh:", !!loja.refresh_token);
    return null;
  }

  return {
    lojaId:     loja.id,
    partnerId:  loja.partner_id,
    partnerKey: loja.partner_key,
    accessToken,
    shopId:     Number(loja.shop_id),
    nickname:   loja.nickname ?? `Shopee ${loja.shop_id}`,
  };
}
