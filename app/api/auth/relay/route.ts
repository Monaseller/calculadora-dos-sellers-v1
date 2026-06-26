import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getUserId } from "@/lib/session";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export async function GET(request: Request) {
  const url     = new URL(request.url);
  const token   = url.searchParams.get("token");
  const expires = url.searchParams.get("expires");

  if (!token) return NextResponse.redirect(new URL("/configuracoes", request.url));

  const userId = getUserId(request);
  let lojaId: string | null = null;

  try {
    const meRes = await fetch("https://api.mercadolibre.com/users/me", {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (meRes.ok) {
      const me       = await meRes.json();
      const sellerId = String(me.id);
      const nickname = me.nickname || me.first_name || "Loja ML";
      const expiresAt = new Date(Date.now() + (Number(expires) || 21600) * 1000).toISOString();

      // Upsert por seller_id + user_id para isolar lojas por usuário CDS
      const { data: loja } = await supabase
        .from("lojas")
        .upsert(
          { marketplace: "ML", seller_id: sellerId, nickname, nome: nickname, access_token: token, token_expires_at: expiresAt, ativo: true, user_id: userId },
          { onConflict: "seller_id,user_id" }
        )
        .select("id")
        .single();

      lojaId = loja?.id ?? null;
    }
  } catch {}

  const res = NextResponse.redirect(new URL("/configuracoes", request.url));

  res.cookies.set("ml_access_token", token, {
    httpOnly: true, secure: false, sameSite: "lax", path: "/",
    maxAge: Number(expires) || 21600,
  });

  if (lojaId) {
    res.cookies.set("loja_ativa_id", lojaId, {
      httpOnly: false, secure: false, sameSite: "lax", path: "/",
      maxAge: 86400 * 30,
    });
  }

  return res;
}
