import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// GET /api/auth/verificar-email?token=xxx — confirma o token
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get("token");

  if (!token) {
    return NextResponse.json({ erro: "Token inválido." }, { status: 400 });
  }

  const { data: perfil } = await supabase
    .from("perfil")
    .select("id, token_verificacao, token_expiracao, email_verificado")
    .eq("id", 1)
    .single();

  if (!perfil) {
    return NextResponse.json({ erro: "Conta não encontrada." }, { status: 404 });
  }

  if (perfil.email_verificado) {
    return NextResponse.json({ ok: true, mensagem: "Email já verificado." });
  }

  if (perfil.token_verificacao !== token) {
    return NextResponse.json({ erro: "Token inválido ou expirado." }, { status: 400 });
  }

  if (perfil.token_expiracao && new Date(perfil.token_expiracao) < new Date()) {
    return NextResponse.json({ erro: "Token expirado. Solicite um novo link." }, { status: 400 });
  }

  await supabase
    .from("perfil")
    .update({ email_verificado: true, token_verificacao: null, token_expiracao: null })
    .eq("id", 1);

  return NextResponse.json({ ok: true });
}

// POST /api/auth/verificar-email — reenvia o email de verificação
export async function POST(request: Request) {
  const { email } = await request.json();

  const { data: perfil } = await supabase
    .from("perfil")
    .select("id, email, email_verificado")
    .eq("id", 1)
    .single();

  if (!perfil || perfil.email !== email) {
    return NextResponse.json({ erro: "Email não encontrado." }, { status: 404 });
  }

  if (perfil.email_verificado) {
    return NextResponse.json({ ok: true, mensagem: "Email já verificado." });
  }

  const token = crypto.randomUUID();
  const expiracao = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  await supabase
    .from("perfil")
    .update({ token_verificacao: token, token_expiracao: expiracao })
    .eq("id", 1);

  await enviarEmailVerificacao(email, token);

  return NextResponse.json({ ok: true });
}

async function enviarEmailVerificacao(email: string, token: string) {
  const { Resend } = await import("resend");
  const resend = new Resend(process.env.RESEND_API_KEY);

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://www.calculadoradossellers.com.br";
  const link = `${baseUrl}/verificar-email?token=${token}`;

  await resend.emails.send({
    from: "CDS <onboarding@resend.dev>",
    to: email,
    subject: "Confirme seu email — Calculadora dos Sellers",
    html: `
      <div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;background:#0d0e12;color:#fff;padding:40px;border-radius:16px">
        <div style="width:48px;height:48px;background:linear-gradient(135deg,#FFB600,#FF6B00);border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:900;color:#000;margin-bottom:28px">C</div>
        <h1 style="font-size:22px;font-weight:900;margin:0 0 12px 0">Confirme seu email</h1>
        <p style="color:#9099aa;font-size:15px;line-height:1.6;margin:0 0 32px 0">
          Clique no botão abaixo para verificar seu email e acessar a <strong style="color:#FFB600">Calculadora dos Sellers</strong>.
        </p>
        <a href="${link}" style="display:inline-block;padding:14px 32px;background:linear-gradient(135deg,#FFB600,#FF6B00);color:#000;font-weight:800;font-size:15px;text-decoration:none;border-radius:11px">
          Verificar email →
        </a>
        <p style="color:#555;font-size:12px;margin-top:32px">
          Link válido por 24 horas. Se não foi você, ignore este email.
        </p>
      </div>
    `,
  });
}
