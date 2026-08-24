/**
 * POST /api/auth/login
 *
 * ── PERFIL-SENHA1a ──────────────────────────────────────────────────
 * A leitura do perfil saiu do cliente ANON e vive na capability
 * server-only.
 *
 * ── PERFIL-SENHA1b — o que esta rota passa a fazer ──────────────────
 * A senha deixa de ser comparada por igualdade de string.
 *
 *   senha_hash != null  →  verifica SOMENTE o Argon2id.
 *                          Hash corrompido REPROVA — nunca cai para o
 *                          plaintext. Aceitar esse fallback permitiria a
 *                          quem tivesse escrita no banco anular
 *                          `senha_hash` e reabrir o caminho fraco.
 *
 *   senha_hash == null  →  conta legada. Compara o plaintext em tempo
 *                          constante e, se conferir, gera o hash e migra
 *                          na hora (CAS). Falhar a gravação NÃO impede o
 *                          login: a senha estava certa, e negar acesso
 *                          por problema de migração transformaria uma
 *                          melhoria em indisponibilidade. A conta tenta
 *                          de novo no próximo login.
 *
 * ── Enumeração e timing ─────────────────────────────────────────────
 * Os três desfechos de falha — conta inexistente, senha errada e hash
 * corrompido — devolvem **401 com a mesma mensagem**. O 404
 * "Nenhuma conta configurada" saiu: ele dizia a qualquer visitante se um
 * email estava cadastrado.
 *
 * E quando a conta não existe, roda um Argon2 DUMMY antes de responder.
 * Sem isso, "email inexistente" retornaria em microssegundos e "senha
 * errada" em ~50 ms — a mesma resposta, com o relógio entregando a
 * diferença.
 */
import { NextResponse } from "next/server";
import { emitirTokenSessao, COOKIE_SESSAO, OPCOES_COOKIE_SESSAO } from "@/lib/autenticacao";
import {
  lerCredencialDeLogin,
  gravarUserUuid,
  migrarSenhaLegada,
} from "@/lib/perfil/credenciais";
import {
  gerarHash,
  verificarHash,
  verificarDummy,
  plaintextConfere,
} from "@/lib/perfil/senha";

/** Resposta única de falha de credencial. Não distingue os casos. */
function credencialInvalida() {
  return NextResponse.json({ erro: "Email ou senha incorretos." }, { status: 401 });
}

export async function POST(request: Request) {
  const { email, senha } = await request.json();

  if (!email || !senha) {
    return NextResponse.json({ erro: "Email e senha obrigatórios." }, { status: 400 });
  }

  // Busca por email (case-insensitive, suporte multi-usuário)
  const emailNorm = email.trim().toLowerCase();
  const { credencial: perfil } = await lerCredencialDeLogin(emailNorm);

  if (!perfil || !perfil.email) {
    // Trabalho equivalente ao caminho real, para o tempo não denunciar
    // que a conta não existe.
    await verificarDummy(senha);
    return credencialInvalida();
  }

  if (perfil.senha_hash) {
    // ── Conta já migrada ────────────────────────────────────────────
    // Único caminho possível. Sem fallback, em nenhuma circunstância.
    if (!(await verificarHash(senha, perfil.senha_hash))) return credencialInvalida();
  } else {
    // ── Conta legada ────────────────────────────────────────────────
    if (!plaintextConfere(senha, perfil.senha)) return credencialInvalida();

    // Senha correta: migra agora. `gerarHash` pode lançar se o binário
    // falhar — e nesse caso o login segue, porque a credencial já foi
    // validada e a migração é oportunista, não requisito de acesso.
    try {
      const hash = await gerarHash(senha);
      await migrarSenhaLegada(perfil.id, hash);
    } catch {
      console.error("[login] falha ao migrar senha legada");
    }
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
