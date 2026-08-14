import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { decidirAcesso } from "@/lib/middleware-rotas";

/**
 * F0.b — corrige o ALCANCE do middleware.
 *
 * A lista anterior continha "/" e era testada com `startsWith`, o que
 * liberava toda e qualquer rota. A política agora vive em
 * `lib/middleware-rotas.ts`, com casamento exato, método considerado e
 * default deny — e é função pura, testada por
 * `scripts/testar-middleware.ts`.
 *
 * NÃO muda a FORÇA da sessão: o cookie continua sendo verificado apenas
 * por PRESENÇA. Assinatura, expiração, papel e o tratamento do valor
 * legado "1" são F0.c.
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const cookie = request.cookies.get("cds_session")?.value;
  const temSessao = !!cookie;

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
