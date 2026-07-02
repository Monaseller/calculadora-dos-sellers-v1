import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Rotas públicas — sem sessão OK
const PUBLIC = [
  "/",
  "/login",
  "/verificar-email",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/verificar-email",
  "/api/auth/mercadolivre",
  "/api/auth/shopee",
  "/api/auth/relay",
  "/api/auth/shopee/callback",
  "/api/shopee/status",
  "/api/sync",
  "/_next",
  "/favicon",
];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Permite rotas públicas
  if (PUBLIC.some(p => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Verifica sessão
  const session = request.cookies.get("cds_session")?.value;
  if (!session) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("redirect", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
