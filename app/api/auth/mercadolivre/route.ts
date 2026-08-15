/**
 * GET /api/auth/mercadolivre — início do OAuth do Mercado Livre.
 *
 * ── O que muda em F0.c.6c ───────────────────────────────────────────
 * Antes, esta rota montava a URL de autorização e redirecionava sem
 * olhar quem estava chamando: qualquer um podia iniciar um fluxo OAuth,
 * e o `state` — a proteção padrão contra CSRF — simplesmente não
 * existia. Também não havia como dizer QUAL loja estava sendo
 * reconectada: o `loja_id` não trafegava em lugar nenhum.
 *
 * Agora:
 *   · exige sessão CDS;
 *   · distingue CONNECT (conta nova) de RECONNECT (loja existente);
 *   · em RECONNECT, confirma a propriedade da loja ANTES de mandar o
 *     usuário ao Mercado Livre;
 *   · assina um `state` que carrega `uid` e, quando for o caso, a loja.
 *
 * ── Por que redirect e não 401 ──────────────────────────────────────
 * Esta rota é NAVEGAÇÃO: o usuário chega por clique em link, não por
 * `fetch`. Um 401 em JSON seria um beco sem saída na tela. O contrato de
 * "API responde 401" existe para chamadas programáticas; aqui a resposta
 * coerente é mandar para o login e voltar. Por isso ela permanece em
 * `ROTAS_PUBLICAS` (o middleware deixa chegar) e a decisão de sessão é
 * da própria rota.
 */
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { autenticarRequisicao, agoraEmSegundos } from "@/lib/autenticacao";
import {
  assinarEstado,
  gerarCodeVerifier,
  calcularCodeChallenge,
  nomeCookiePkce,
  TTL_PADRAO_SEGUNDOS,
} from "@/lib/estado-oauth";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Redireciona para Configurações com um código enumerado (nunca detalhe). */
function erro(request: Request, codigo: string) {
  const destino = new URL("/configuracoes", request.url);
  destino.searchParams.set("ml_erro", codigo);
  return NextResponse.redirect(destino);
}

export async function GET(request: Request) {
  const auth = await autenticarRequisicao(request);
  if (!auth.autenticado) {
    const login = new URL("/login", request.url);
    login.searchParams.set("redirect", "/configuracoes");
    return NextResponse.redirect(login);
  }
  const userId = auth.uid;

  const lojaId = new URL(request.url).searchParams.get("loja_id");
  const ehReconexao = lojaId !== null && lojaId !== "";

  // ── RECONNECT: a propriedade é confirmada ANTES de sair daqui ─────
  // Mandar o usuário ao Mercado Livre para só depois descobrir que a
  // loja não é dele gastaria uma autorização à toa e ainda deixaria um
  // `code` queimado no caminho.
  if (ehReconexao) {
    if (!UUID_REGEX.test(lojaId)) return erro(request, "loja_nao_pertence_usuario");

    const { data, error } = await supabase
      .from("lojas")
      .select("id")
      .eq("id", lojaId)
      .eq("user_id", userId)
      .eq("marketplace", "ML")
      .eq("ativo", true)
      .maybeSingle();

    if (error) {
      console.error("[GET /api/auth/mercadolivre] falha ao validar a loja:", error.message);
      return erro(request, "persistencia_falhou");
    }
    // Inexistente, de outro dono ou inativa produzem a MESMA recusa —
    // distinguir permitiria descobrir se uma loja alheia existe.
    if (!data) return erro(request, "loja_nao_pertence_usuario");
  }

  const segredo = process.env.SESSION_SECRET;
  if (!segredo) {
    // Fail-closed e barulhento: é erro de operação, não do usuário.
    console.error("[GET /api/auth/mercadolivre] SESSION_SECRET ausente — OAuth não pode iniciar.");
    return erro(request, "configuracao_invalida");
  }

  // ── PKCE (RFC 7636) — F0.c.7 ──────────────────────────────────────
  // A aplicação no Mercado Livre está com PKCE exigido. Sem estes dois
  // campos, o `code` é emitido normalmente e a TROCA por token falha com
  // HTTP 400 — foi o que o log de produção mostrou.
  //
  // O verifier é o segredo: fica só num cookie HttpOnly. O challenge é
  // público (vai na URL) e viaja também dentro do `state` assinado, para
  // que o callback consiga provar que o cookie que recebeu pertence a
  // ESTA tentativa.
  const codeVerifier = gerarCodeVerifier();
  const codeChallenge = await calcularCodeChallenge(codeVerifier);

  const state = await assinarEstado(
    userId,
    ehReconexao
      ? { intent: "reconnect", loja: lojaId, chal: codeChallenge }
      : { intent: "connect", chal: codeChallenge },
    { segredo, agoraSegundos: agoraEmSegundos() }
  );

  const clientId = process.env.ML_CLIENT_ID!.trim();
  const redirectUri = process.env.ML_REDIRECT_URI!.trim();

  const authUrl =
    `https://auth.mercadolivre.com.br/authorization` +
    `?response_type=code` +
    `&client_id=${clientId}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=read_catalog%20write_items%20offline_access` +
    `&state=${encodeURIComponent(state)}` +
    `&code_challenge=${encodeURIComponent(codeChallenge)}` +
    `&code_challenge_method=S256`;

  const res = NextResponse.redirect(authUrl);

  // O cookie é nomeado pelo challenge: duas abas produzem challenges
  // diferentes e portanto cookies diferentes, sem uma sobrescrever a
  // outra. `path` cobre só o próprio fluxo do ML — o callback está sob
  // ele, e nenhuma outra rota recebe este cookie.
  res.cookies.set(nomeCookiePkce(codeChallenge), codeVerifier, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/auth/mercadolivre",
    maxAge: TTL_PADRAO_SEGUNDOS,
  });

  return res;
}
