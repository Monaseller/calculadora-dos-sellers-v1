import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getUserId } from "@/lib/session";
import { shopeeGet } from "@/lib/shopee-api";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export async function GET(request: Request) {
  const userId = getUserId(request);
  if (!userId) return NextResponse.json({ erro: "sem sessão" });

  // 1. Busca loja no DB
  const { data: loja, error: dbErr } = await supabase
    .from("lojas")
    .select("id, shop_id, partner_id, partner_key, access_token, refresh_token, token_expires_at, nickname, ativo")
    .eq("user_id", userId)
    .eq("marketplace", "Shopee")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (dbErr) return NextResponse.json({ erro: "db error", detalhe: dbErr.message });
  if (!loja)  return NextResponse.json({ erro: "loja não encontrada no DB", userId });

  const agora = new Date();
  const expira = loja.token_expires_at ? new Date(loja.token_expires_at) : null;
  const tokenExpirado = expira ? expira < agora : null;

  // 2. Testa chamada de API com o token atual
  let apiTest: any = "não testado";
  if (loja.access_token && loja.partner_id && loja.partner_key) {
    try {
      const data = await shopeeGet(
        "/api/v2/shop/get_shop_info",
        loja.partner_id,
        loja.partner_key,
        loja.access_token,
        Number(loja.shop_id),
        {}
      );
      apiTest = { error: data?.error ?? null, shop_name: data?.response?.shop_name ?? null, request_id: data?.request_id };
    } catch (e) {
      apiTest = { threw: String(e) };
    }
  }

  return NextResponse.json({
    userId,
    loja: {
      id:               loja.id,
      nickname:         loja.nickname,
      shop_id:          loja.shop_id,
      ativo:            loja.ativo,
      partner_id:       loja.partner_id,
      tem_access_token: !!loja.access_token,
      tem_refresh_token: !!loja.refresh_token,
      token_expires_at: loja.token_expires_at,
      token_expirado:   tokenExpirado,
    },
    api_test: apiTest,
  });
}
