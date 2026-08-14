import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { decidirAcesso, precisaDeSessao } from "@/lib/middleware-rotas";
import { autenticarRequisicao } from "@/lib/autenticacao";

/**
 * F0.b — ALCANCE: a lista anterior continha "/" e era testada com
 * `startsWith`, o que liberava toda e qualquer rota. A política passou a
 * viver em `lib/middleware-rotas.ts`, com casamento exato, método
 * considerado e default deny.
 *
 * F0.c.3 — FORÇA: "cookie presente" deixa de ser sessão. Agora vale a
 * verificação criptográfica de `lib/autenticacao.ts` — assinatura HMAC,
 * expiração e formato. Cookie forjado, adulterado, expirado, o formato
 * antigo (UUID cru) e o legado "1" passam a ser recusados.
 *
 * **A política de rotas de F0.b não muda em nada**: páginas públicas,
 * rotas públicas, rotas com segredo próprio, exceções temporárias,
 * default deny, 401 JSON para API e redirect para página continuam
 * exatamente como estão, e seguem cobertos por
 * `scripts/testar-middleware.ts`.
 *
 * A sessão só é verificada quando a rota exige — ver `precisaDeSessao`.
 */
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Rota liberada pela política não paga verificação criptográfica, e
  // continua acessível mesmo se SESSION_SECRET faltar no ambiente.
  let temSessao = false;
  if (precisaDeSessao(pathname, request.method)) {
    const auth = await autenticarRequisicao(request);
    temSessao = auth.autenticado;
  }

  switch (decidirAcesso(pathname, request.method, temSessao)) {
    case "liberar":
      return NextResponse.next();

    case "bloquear_api":
      // Cliente `fetch` precisa de 401 — nunca do HTML da tela de login
      // devolvido com status 200, que era o comportamento anterior.
      return NextResponse.json(
        { erro: true, mensagem: "Sessão inválida." },
        { status: 401 }
      );

    case "redirecionar": {
      const loginUrl = new URL("/login", request.url);
      loginUrl.searchParams.set("redirect", pathname);
      return NextResponse.redirect(loginUrl);
    }
  }
}

/**
 * F0.b.1 — o namespace `_next` inteiro fica FORA do middleware.
 *
 * Antes só `_next/static` e `_next/image` eram excluídos, e o resto do
 * namespace interno do Next.js (ex.: `_next/webpack-hmr` em dev) caía na
 * política de sessão: um visitante deslogado numa página pública recebia
 * redirect para /login em infraestrutura do próprio framework.
 *
 * `_next` é namespace reservado — nenhuma rota nossa vive lá — então a
 * exclusão é do prefixo inteiro, não de dois casos conhecidos.
 *
 * ⚠ O valor precisa ser um LITERAL: o Next.js extrai `config.matcher`
 * estaticamente no build e não aceita constante importada. Por isso ele
 * não é compartilhado com `lib/middleware-rotas.ts` — em vez disso,
 * `scripts/testar-middleware.ts` lê ESTE arquivo e valida o literal,
 * impedindo divergência silenciosa.
 */
export const config = {
  matcher: ["/((?!_next|favicon.ico).*)"],
};
