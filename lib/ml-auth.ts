import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") || "";
  const entry = header.split("; ").find(c => c.startsWith(`${name}=`));
  return entry ? entry.slice(name.length + 1) : null;
}

export interface MLTokenResult {
  token: string;
  newAccessToken?: string;
  newRefreshToken?: string;
  expires?: number;
  lojaId?: string;
}

/** Tenta obter um token ML válido, com fallback para refresh automático */
export async function getMLToken(request: Request): Promise<MLTokenResult | null> {
  // 1. Cookie ml_access_token presente → usa direto
  const existing = getCookie(request, "ml_access_token");
  if (existing) return { token: existing };

  const lojaId      = getCookie(request, "loja_ativa_id");
  const refreshCookie = getCookie(request, "ml_refresh_token");

  // 2. Tenta refresh pelo cookie ml_refresh_token
  if (refreshCookie) {
    const result = await refreshMLToken(refreshCookie);
    if (result) {
      if (lojaId) await saveTokensToDB(lojaId, result);
      return { ...result, lojaId: lojaId ?? undefined };
    }
  }

  // 3. Fallback: lê access_token/refresh_token do banco pela loja ativa
  if (lojaId) {
    const { data: loja } = await supabase
      .from("lojas")
      .select("access_token, refresh_token, token_expires_at")
      .eq("id", lojaId)
      .maybeSingle();

    if (loja?.access_token && new Date(loja.token_expires_at) > new Date()) {
      // Token do banco ainda válido → usa e re-emite o cookie
      return { token: loja.access_token, newAccessToken: loja.access_token, lojaId };
    }

    if (loja?.refresh_token) {
      const result = await refreshMLToken(loja.refresh_token);
      if (result) {
        await saveTokensToDB(lojaId, result);
        return { ...result, lojaId };
      }
    }
  }

  return null;
}

async function refreshMLToken(refreshToken: string): Promise<MLTokenResult | null> {
  try {
    const res = await fetch("https://api.mercadolibre.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type:    "refresh_token",
        client_id:     process.env.ML_CLIENT_ID!.trim(),
        client_secret: process.env.ML_CLIENT_SECRET!.trim(),
        refresh_token: refreshToken,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.access_token) return null;
    return {
      token:           data.access_token,
      newAccessToken:  data.access_token,
      newRefreshToken: data.refresh_token ?? refreshToken,
      expires:         data.expires_in ?? 21600,
    };
  } catch {
    return null;
  }
}

async function saveTokensToDB(lojaId: string, result: MLTokenResult) {
  const updates: Record<string, unknown> = {
    access_token:     result.newAccessToken,
    token_expires_at: new Date(Date.now() + (result.expires ?? 21600) * 1000).toISOString(),
  };
  if (result.newRefreshToken) updates.refresh_token = result.newRefreshToken;
  await supabase.from("lojas").update(updates).eq("id", lojaId);
}

/** Busca loja ML ativa pelo userId (para sync server-side sem cookie) */
export async function getMLLojaAtiva(userId: string): Promise<{
  lojaId:      string;
  accessToken: string;
  sellerId:    string;
  nickname:    string;
} | null> {
  const { data: loja } = await supabase
    .from("lojas")
    .select("id, seller_id, nickname, access_token, refresh_token, token_expires_at")
    .eq("user_id", userId)
    .eq("marketplace", "ML")
    .eq("ativo", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!loja || !loja.access_token) return null;

  let accessToken = loja.access_token;
  const expired = loja.token_expires_at &&
    new Date(loja.token_expires_at).getTime() - 5 * 60 * 1000 < Date.now();

  if (expired && loja.refresh_token) {
    const result = await refreshMLToken(loja.refresh_token);
    if (result) {
      accessToken = result.newAccessToken!;
      await saveTokensToDB(loja.id, result);
    }
  }

  return {
    lojaId:      loja.id,
    accessToken,
    sellerId:    loja.seller_id ?? "",
    nickname:    loja.nickname ?? "ML",
  };
}

/** Aplica cookies novos numa NextResponse após refresh */
export function applyMLCookies(res: any, result: MLTokenResult) {
  if (!result.newAccessToken) return;
  const isProd = process.env.NODE_ENV === "production";
  res.cookies.set("ml_access_token", result.newAccessToken, {
    httpOnly: true, secure: isProd, sameSite: "lax", path: "/",
    maxAge: result.expires ?? 21600,
  });
  if (result.newRefreshToken) {
    res.cookies.set("ml_refresh_token", result.newRefreshToken, {
      httpOnly: true, secure: isProd, sameSite: "lax", path: "/",
      maxAge: 86400 * 180,
    });
  }
}
