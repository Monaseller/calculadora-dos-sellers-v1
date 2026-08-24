import { NextResponse } from "next/server";
import { autenticarRequisicao } from "@/lib/autenticacao";
import { lerLojaParaAtivacao } from "@/lib/marketplace/credenciais";

export async function POST(request: Request) {
  const { loja_id } = await request.json();
  const auth = await autenticarRequisicao(request);
  const userId = auth.autenticado ? auth.uid : null;
  if (!userId) return NextResponse.json({ erro: true, mensagem: "Sessão inválida." }, { status: 401 });

  // A rota não monta query: a leitura privilegiada vive na capability
  // server-only, com o filtro de dono (`id + user_id`) na própria
  // consulta e projeção fechada — sem `refresh_token`, `partner_key`
  // nem `token_expires_at`, que a rota nunca usou.
  const { loja, erro } = await lerLojaParaAtivacao(loja_id, userId);

  // Banco falhou é DIFERENTE de loja não encontrada. Antes os dois casos
  // colapsavam em 404, e uma indisponibilidade se disfarçava de "não é
  // sua". O código interno fica no log da capability; ao cliente vai uma
  // mensagem estável, sem detalhe de esquema.
  if (erro) {
    return NextResponse.json(
      { erro: true, mensagem: "Não foi possível ativar a loja agora." },
      { status: 503 }
    );
  }

  if (!loja) return NextResponse.json({ erro: true, mensagem: "Loja não encontrada." }, { status: 404 });

  const res = NextResponse.json({ ok: true, loja: { id: loja.id, nome: loja.nome, nickname: loja.nickname, marketplace: loja.marketplace } });

  const isProd = process.env.NODE_ENV === "production";
  const isShopee = loja.marketplace === "Shopee";

  if (isShopee) {
    // Shopee: cookie específico — não toca no loja_ativa_id do ML
    res.cookies.set("shopee_loja_id", loja.id, {
      httpOnly: false, secure: isProd, sameSite: "lax", path: "/", maxAge: 86400 * 30,
    });
  } else {
    // ML ou outros
    if (loja.access_token) {
      res.cookies.set("ml_access_token", loja.access_token, {
        httpOnly: true, secure: isProd, sameSite: "lax", path: "/", maxAge: 21600,
      });
    }
    res.cookies.set("loja_ativa_id", loja.id, {
      httpOnly: false, secure: isProd, sameSite: "lax", path: "/", maxAge: 86400 * 30,
    });
  }

  return res;
}
