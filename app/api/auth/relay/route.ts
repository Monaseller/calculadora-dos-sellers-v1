import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getUserId } from "@/lib/session";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export async function GET(request: Request) {
  const url          = new URL(request.url);
  const token        = url.searchParams.get("token");
  const expires      = url.searchParams.get("expires");
  const refreshToken = url.searchParams.get("refresh_token");

  if (!token) return NextResponse.redirect(new URL("/configuracoes", request.url));

  const userId = getUserId(request);
  let lojaId: string | null = null;

  try {
    const meRes = await fetch("https://api.mercadolibre.com/users/me", {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (meRes.ok) {
      const me        = await meRes.json();
      const sellerId  = String(me.id);
      const nickname  = me.nickname || me.first_name || "Loja ML";
      const expiresAt = new Date(Date.now() + (Number(expires) || 21600) * 1000).toISOString();

      // Busca loja existente
      let existente: { id: string } | null = null;
      if (userId) {
        const { data } = await supabase.from("lojas").select("id")
          .eq("marketplace", "ML").eq("seller_id", sellerId).eq("user_id", userId)
          .limit(1).maybeSingle();
        existente = data;
      }
      if (!existente) {
        const { data } = await supabase.from("lojas").select("id")
          .eq("marketplace", "ML").eq("seller_id", sellerId)
          .limit(1).maybeSingle();
        existente = data;
      }

      if (existente?.id) {
        const updates: Record<string, unknown> = {
          nickname, nome: nickname, access_token: token,
          token_expires_at: expiresAt, ativo: true,
        };
        if (userId) updates.user_id = userId;
        if (refreshToken) updates.refresh_token = refreshToken;
        await supabase.from("lojas").update(updates).eq("id", existente.id);
        lojaId = existente.id;
      } else {
        const { data: nova } = await supabase
          .from("lojas")
          .insert({
            marketplace: "ML", seller_id: sellerId, nickname, nome: nickname,
            access_token: token, token_expires_at: expiresAt, ativo: true,
            user_id: userId ?? null,
            ...(refreshToken ? { refresh_token: refreshToken } : {}),
          })
          .select("id")
          .single();
        lojaId = nova?.id ?? null;
      }
    }
  } catch {}

  const isProd = process.env.NODE_ENV === "production";
  const res = NextResponse.redirect(new URL("/configuracoes", request.url));

  res.cookies.set("ml_access_token", token, {
    httpOnly: true, secure: isProd, sameSite: "lax", path: "/",
    maxAge: Number(expires) || 21600,
  });

  if (refreshToken) {
    res.cookies.set("ml_refresh_token", refreshToken, {
      httpOnly: true, secure: isProd, sameSite: "lax", path: "/",
      maxAge: 86400 * 180, // 6 meses
    });
  }

  if (lojaId) {
    res.cookies.set("loja_ativa_id", lojaId, {
      httpOnly: false, secure: isProd, sameSite: "lax", path: "/",
      maxAge: 86400 * 30,
    });
  }

  return res;
}
