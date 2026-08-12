/**
 * GET /api/debug/refresh-token
 * Força o refresh do access_token Shopee usando o refresh_token salvo no banco.
 */
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getUserId } from "@/lib/session";
import { refreshShopeeToken } from "@/lib/shopee-auth";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export async function GET(request: Request) {
  const userId = getUserId(request);
  if (!userId) return NextResponse.json({ erro: "Sessao invalida" }, { status: 401 });

  const { data: loja, error } = await supabase
    .from("lojas")
    .select("id, shop_id, partner_id, partner_key, access_token, refresh_token, token_expires_at, nickname")
    .eq("user_id", userId)
    .eq("marketplace", "Shopee")
    .eq("ativo", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !loja) {
    return NextResponse.json({ erro: "Loja nao encontrada no banco", dbError: error?.message });
  }

  const before = {
    token_expires_at: loja.token_expires_at,
    token_expirado: loja.token_expires_at
      ? new Date(loja.token_expires_at).getTime() < Date.now()
      : null,
    tem_refresh_token: !!loja.refresh_token,
  };

  if (!loja.refresh_token) {
    return NextResponse.json({
      erro: "Sem refresh_token — precisa reconectar a Shopee",
      before,
    });
  }

  const result = await refreshShopeeToken(
    loja.partner_id,
    loja.partner_key,
    Number(loja.shop_id),
    loja.refresh_token
  );

  if (!result) {
    return NextResponse.json({
      erro: "Refresh falhou — o refresh_token pode ter expirado (30 dias) ou a URL da API esta incorreta. Reconecte a Shopee.",
      before,
      shopee_base_url: process.env.SHOPEE_BASE_URL ?? "(nao definida, usa producao)",
    });
  }

  // Salva novo token
  const novaExpiracao = new Date(Date.now() + (result.expire_in ?? 14400) * 1000).toISOString();
  const { error: updateErr } = await supabase.from("lojas").update({
    access_token:     result.access_token,
    refresh_token:    result.refresh_token ?? loja.refresh_token,
    token_expires_at: novaExpiracao,
  }).eq("id", loja.id);

  return NextResponse.json({
    ok: updateErr ? false : true,
    update_erro: updateErr?.message ?? null,
    before,
    after: {
      token_expires_at: novaExpiracao,
      expire_in_segundos: result.expire_in ?? 14400,
      novo_refresh_token: result.refresh_token !== loja.refresh_token,
    },
    proximo_passo: updateErr
      ? "Refresh OK mas falhou ao salvar — tente de novo"
      : "Token renovado. Agora acesse /api/debug/pending-compare",
  });
}
