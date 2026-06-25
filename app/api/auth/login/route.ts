import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export async function POST(request: Request) {
  const { email, senha } = await request.json();

  if (!email || !senha) {
    return NextResponse.json({ erro: "Email e senha obrigatórios." }, { status: 400 });
  }

  const { data: perfil } = await supabase
    .from("perfil")
    .select("id, email, senha, nome_completo")
    .eq("id", 1)
    .single();

  // Primeiro acesso: nenhum perfil cadastrado ainda
  if (!perfil || !perfil.email) {
    return NextResponse.json({ erro: "Nenhuma conta configurada. Crie sua conta primeiro." }, { status: 404 });
  }

  if (perfil.email !== email || perfil.senha !== senha) {
    return NextResponse.json({ erro: "Email ou senha incorretos." }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true, nome: perfil.nome_completo });
  res.cookies.set("cds_session", "1", {
    httpOnly: true,
    secure:   process.env.NODE_ENV === "production",
    sameSite: "lax",
    path:     "/",
    maxAge:   86400 * 30, // 30 dias
  });

  return res;
}
