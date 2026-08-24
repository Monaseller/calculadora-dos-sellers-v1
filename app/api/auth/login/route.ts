/**
 * PERFIL-SENHA1a: a leitura do perfil saiu do cliente ANON e passou a
 * viver na capability server-only. `senha` continua PLAINTEXT e continua
 * comparada aqui — trocar isso é a PERFIL-SENHA1b, deliberadamente
 * separada. Esta rota mudou de CLIENTE, não de comportamento.
 */
import { NextResponse } from "next/server";
import { emitirTokenSessao, COOKIE_SESSAO, OPCOES_COOKIE_SESSAO } from "@/lib/autenticacao";
import { lerCredencialDeLogin, gravarUserUuid } from "@/lib/perfil/credenciais";

export async function POST(request: Request) {
  const { email, senha } = await request.json();

  if (!email || !senha) {
    return NextResponse.json({ erro: "Email e senha obrigatórios." }, { status: 400 });
  }

  // Busca por email (case-insensitive, suporte multi-usuário)
  const emailNorm = email.trim().toLowerCase();
  const { credencial: perfil } = await lerCredencialDeLogin(emailNorm);

  if (!perfil || !perfil.email) {
    return NextResponse.json({ erro: "Nenhuma conta configurada. Crie sua conta primeiro." }, { status: 404 });
  }

  if (perfil.senha?.trim() !== senha.trim()) {
    return NextResponse.json({ erro: "Email ou senha incorretos." }, { status: 401 });
  }

  // Bloqueia apenas se explicitamente false (não null — contas antigas não tinham verificação)
  if (perfil.email_verificado === false) {
    return NextResponse.json(
      { erro: "Confirme seu email antes de entrar. Verifique sua caixa de entrada.", naoVerificado: true },
      { status: 403 }
    );
  }

  // Garante que o user_uuid existe (migração de contas antigas)
  let userId = perfil.user_uuid;
  if (!userId) {
    userId = crypto.randomUUID();
    await gravarUserUuid(perfil.id, userId);
  }

  // F0.c.3 — o cookie deixa de carregar o user_uuid em texto puro e passa
  // a carregar um token assinado (HMAC-SHA-256, 7 dias, sem renovação).
  // Trocar o UUID no cookie deixa de autenticar como outra pessoa.
  //
  // Nada mais deste fluxo muda: validação de email, de senha, de
  // email_verificado e o formato da resposta seguem iguais.
  const { token } = await emitirTokenSessao(userId);

  const res = NextResponse.json({ ok: true, nome: perfil.nome_completo });
  res.cookies.set(COOKIE_SESSAO, token, OPCOES_COOKIE_SESSAO);

  return res;
}
