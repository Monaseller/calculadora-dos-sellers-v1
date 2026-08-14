/**
 * /api/perfil — perfil do usuário da sessão.
 *
 * TRATAMENTO DE ERRO (corrigido em 2026-09-01). O GET somava dois
 * problemas:
 *
 *   if (!userId) return NextResponse.json({});   // 200 sem sessão
 *   const { data } = await supabase...single();  // erro DESCARTADO
 *
 * Sem sessão respondia **200 com objeto vazio**, indistinguível de
 * "perfil sem dados"; e o erro do Supabase era literalmente ignorado na
 * desestruturação, então banco fora do ar também virava 200 e `{}`.
 * Junto com o mesmo padrão em `/api/lojas`, foi isso que manteve
 * invisível por ~54 dias uma `NEXT_PUBLIC_SUPABASE_URL` malformada em
 * produção — nenhum monitoramento acusa 200.
 *
 * Agora: sem sessão é 401, falha de infraestrutura é 5xx, e **perfil
 * inexistente continua 200 com `{}`** — essa última é ausência legítima,
 * não erro, e a semântica foi preservada de propósito.
 *
 * `maybeSingle()` no lugar de `single()`: com `single()`, zero linhas é
 * erro (`PGRST116`), o que obrigaria a separar "não achou" de "quebrou"
 * por código. `maybeSingle()` devolve `null` sem erro, e aí só sobra
 * erro de verdade.
 *
 * A mensagem crua do Supabase nunca vai ao cliente — pode conter nome de
 * tabela, coluna e detalhe de esquema. Fica no log do servidor.
 */
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { autenticarRequisicao } from "@/lib/autenticacao";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export async function GET(request: Request) {
  const auth = await autenticarRequisicao(request);
  const userId = auth.autenticado ? auth.uid : null;
  if (!userId) return NextResponse.json({ erro: "Não autenticado." }, { status: 401 });

  try {
    const { data, error } = await supabase
      .from("perfil")
      .select("id, nome_completo, usuario, email, documento, email_verificado, user_uuid")
      .eq("user_uuid", userId)
      .maybeSingle();

    if (error) {
      console.error("[GET /api/perfil] falha ao consultar perfil:", error.message);
      return NextResponse.json({ erro: "Não foi possível carregar o perfil." }, { status: 503 });
    }

    // Perfil ausente é ausência LEGÍTIMA, não erro: segue 200 com {}.
    return NextResponse.json(data ?? {});
  } catch (err: any) {
    console.error("[GET /api/perfil] erro inesperado:", err?.message);
    return NextResponse.json({ erro: "Não foi possível carregar o perfil." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const body = await request.json();
  const isNovaConta = body._novaConta === true;

  if (isNovaConta) {
    // Verifica se email já existe
    const { data: existente } = await supabase
      .from("perfil")
      .select("id")
      .eq("email", body.email)
      .single();

    if (existente) {
      return NextResponse.json({ erro: true, mensagem: "Este email já está cadastrado." }, { status: 409 });
    }

    const userUuid = crypto.randomUUID();
    const token    = crypto.randomUUID();
    const expiracao = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const { error } = await supabase.from("perfil").insert({
      nome_completo:     body.nome_completo,
      usuario:           body.usuario,
      email:             body.email,
      documento:         body.documento,
      senha:             body.senha,
      email_verificado:  false, // verificação via email obrigatória antes do primeiro acesso
      token_verificacao: token,
      token_expiracao:   expiracao,
      user_uuid:         userUuid,
    });

    if (error) {
      // Mensagem crua do Supabase fica no log, não na resposta.
      console.error("[POST /api/perfil] falha ao criar conta:", error.message);
      return NextResponse.json({ erro: true, mensagem: "Não foi possível criar a conta." }, { status: 500 });
    }

    // Envia email de verificação
    try {
      const { Resend } = await import("resend");
      const resend  = new Resend(process.env.RESEND_API_KEY);
      const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://www.calculadoradossellers.com.br";
      const link    = `${baseUrl}/verificar-email?token=${token}`;

      await resend.emails.send({
        from: "CDS <noreply@calculadoradossellers.com.br>",
        to:   body.email as string,
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

    return NextResponse.json({ ok: true, emailEnviado: true });
  }

  // ── Atualização de perfil existente ──────────────────────────────────────
  const auth = await autenticarRequisicao(request);
  const userId = auth.autenticado ? auth.uid : null;
  if (!userId) {
    return NextResponse.json({ erro: true, mensagem: "Não autorizado." }, { status: 401 });
  }

  const campos: Record<string, unknown> = {};
  if (body.nome_completo !== undefined) campos.nome_completo = body.nome_completo;
  if (body.usuario       !== undefined) campos.usuario       = body.usuario;
  if (body.email         !== undefined) campos.email         = body.email;
  if (body.documento     !== undefined) campos.documento     = body.documento;
  if (body.senha         !== undefined) campos.senha         = body.senha;

  const { error } = await supabase
    .from("perfil")
    .update(campos)
    .eq("user_uuid", userId);

  if (error) {
    console.error("[POST /api/perfil] falha ao atualizar perfil:", error.message);
    return NextResponse.json({ erro: true, mensagem: "Não foi possível salvar o perfil." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

