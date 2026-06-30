import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getUserId } from "@/lib/session";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export async function POST(request: Request) {
  const { loja_id } = await request.json();
  const userId = getUserId(request);
  if (!userId) return NextResponse.json({ erro: true, mensagem: "Sessão inválida." }, { status: 401 });

  const { data: loja } = await supabase
    .from("lojas")
    .select("*")
    .eq("id", loja_id)
    .eq("user_id", userId)
    .single();

  if (!loja) return NextResponse.json({ erro: true, mensagem: "Loja não encontrada." }, { status: 404 });

  const res = NextResponse.json({ ok: true, loja: { id: loja.id, nome: loja.nome, nickname: loja.nickname, marketplace: loja.marketplace } });

  if (loja.access_token) {
    res.cookies.set("ml_access_token", loja.access_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 21600,
    });
  }

  res.cookies.set("loja_ativa_id", loja.id, {
    httpOnly: false,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 86400 * 30,
  });

  return res;
}
