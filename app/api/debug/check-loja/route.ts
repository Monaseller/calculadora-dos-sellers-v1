/**
 * GET /api/debug/check-loja
 * Mostra status da loja Shopee no banco e tenta refresh do token.
 */
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getUserId } from "@/lib/session";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export async function GET(request: Request) {
  const userId = getUserId(request);
  if (!userId) return NextResponse.json({ erro: "Sessao invalida" }, { status: 401 });

  const { data: loja, error } = await supabase
    .from("lojas")
    .select("id, shop_id, partner_id, partner_key, access_token, refresh_token, token_expires_at, nickname, ativo, created_at")
    .eq("user_id", userId)
    .eq("marketplace", "Shopee")
    .order("created_at", { ascending: false })
    .limit(3);

  const now = new Date();

  return NextResponse.json({
    userId,
    now: now.toISOString(),
    dbError: error?.message ?? null,
    lojas: (loja ?? []).map(l => ({
      id:              l.id,
      shop_id:         l.shop_id,
      nickname:        l.nickname,
      ativo:           l.ativo,
      tem_partner_id:  !!l.partner_id,
      tem_partner_key: !!l.partner_key,
      tem_access_token: !!l.access_token,
      tem_refresh_token: !!l.refresh_token,
      token_expires_at: l.token_expires_at,
      token_expirado:   l.token_expires_at
        ? new Date(l.token_expires_at).getTime() < now.getTime()
        : null,
      minutos_para_expirar: l.token_expires_at
        ? Math.round((new Date(l.token_expires_at).getTime() - now.getTime()) / 60000)
        : null,
    })),
  });
}
