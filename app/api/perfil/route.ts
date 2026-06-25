import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export async function GET() {
  const { data } = await supabase
    .from("perfil")
    .select("*")
    .eq("id", 1)
    .single();

  return NextResponse.json(data ?? {});
}

export async function POST(request: Request) {
  const body = await request.json();
  const isNovaConta = body._novaConta === true;

  const campos: Record<string, unknown> = {};
  if (body.nome_completo !== undefined) campos.nome_completo = body.nome_completo;
  if (body.usuario       !== undefined) campos.usuario       = body.usuario;
  if (body.email         !== undefined) campos.email         = body.email;
  if (body.documento     !== undefined) campos.documento     = body.documento;
  if (body.senha         !== undefined) campos.senha         = body.senha;

  // Criação de conta nova: gera token de verificação
  if (isNovaConta) {
    const token = crypto.randomUUID();
    campos.email_verificado = false;
    campos.token_verificacao = token;
    campos.token_expiracao = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  }

  const { error } = await supabase
    .from("perfil")
    .upsert({ id: 1, ...campos }, { onConflict: "id" });

  if (error) {
    return NextResponse.json({ erro: true, mensagem: error.message }, { status: 500 });
  }

  // Envia email de verificação para nova conta
  if (isNovaConta && campos.email && campos.token_verificacao) {
    try {
      const { Resend } = await import("resend");
      const resend = new Resend(process.env.RESEND_API_KEY);
      const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://www.calculadoradossellers.com.br";
      const link = `${baseUrl}/verificar-email?token=${campos.token_verificacao}`;

      await resend.emails.send({
        from: "CDS <onboarding@resend.dev>",
        to: campos.email as string,
        subject: "Confirme seu email — Calculadora dos Sellers",
        html: `
          <div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;background:#0d0e12;color:#fff;padding:40px;border-radius:16px">
            <div style="width:48px;height:48px;background:linear-gradient(135deg,#FFB600,#FF6B00);border-radius:12px;display:inline-flex;align-items:center;justify-content:center;font-size:22px;font-weight:900;color:#000;margin-bottom:28px">C</div>
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
    } catch (e) {
      console.error("Erro ao enviar email:", e);
    }
  }

  return NextResponse.json({ ok: true, emailEnviado: isNovaConta });
}
