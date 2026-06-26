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

  // Busca por email (suporte multi-usuário)
  const { data: perfil } = await supabase
    .from("perfil")
    .select("id, email, senha, nome_completo, email_verificado, user_uuid")
    .eq("email", email)
    .single();

  if (!perfil || !perfil.email) {
    return NextResponse.json({ erro: "Nenhuma conta configurada. Crie sua conta primeiro." }, { status: 404 });
  }

  if (perfil.senha !== senha) {
    return NextResponse.json({ erro: "Email ou senha incorretos." }, { status: 401 });
  }

  if (!perfil.email_verificado) {
    return NextResponse.json(
      { erro: "Confirme seu email antes de entrar. Verifique sua caixa de entrada.", naoVerificado: true },
      { status: 403 }
    );
  }

  // Garante que o user_uuid existe (migração de contas antigas)
  let userId = perfil.user_uuid;
  if (!userId) {
    userId = crypto.randomUUID();
    await supabase.from("perfil").update({ user_uuid: userId }).eq("id", perfil.id);
  }

  const res = NextResponse.json({ ok: true, nome: perfil.nome_completo });
  res.cookies.set("cds_session", userId, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === "production",
    sameSite: "lax",
    path:     "/",
    maxAge:   86400 * 30,
  });

  return res;
}
