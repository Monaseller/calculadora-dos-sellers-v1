import { NextResponse } from "next/server";
import { createHmac } from "crypto";
import { agoraEmSegundos, autenticarRequisicao } from "@/lib/autenticacao";
import { APP_SHOPEE_PADRAO, ehChaveAppShopee, resolverAppShopee } from "@/lib/shopee-apps";
import { emitirEstadoShopee, NOME_COOKIE_ESTADO_SHOPEE, opcoesCookieEstadoShopee } from "@/lib/shopee-oauth-estado";

// Shopee espera a chave completa como string UTF-8
function getHmacKey(partnerKey: string): string {
  return partnerKey;
}

/** Parametros que NUNCA sao aceitos do navegador: a credencial do app vem so do registro server-side. */
const PARAMETROS_PROIBIDOS = ["partner_id", "partner_key", "partnerId", "partnerKey"];

// GET /api/auth/shopee[?app=default|rd]
// Inicia o OAuth com o app ESCOLHIDO NA ALLOWLIST (lib/shopee-apps.ts).
// Exige sessao: o estado assinado amarra (uid, app) a esta tentativa e o
// callback so aceita a volta com esse mesmo estado (lib/shopee-oauth-estado.ts).
// O middleware mantem a rota na lista de navegacao (redirect em vez de 401
// JSON); a protecao de sessao vive AQUI.
export async function GET(request: Request) {
  const auth = await autenticarRequisicao(request);
  if (!auth.autenticado) {
    const login = new URL("/login", request.url);
    login.searchParams.set("redirect", "/configuracoes");
    return NextResponse.redirect(login);
  }

  const url = new URL(request.url);
  if (PARAMETROS_PROIBIDOS.some((p) => url.searchParams.has(p))) {
    return NextResponse.json({ erro: true, mensagem: "Parametro nao permitido." }, { status: 400 });
  }
  const pedido = url.searchParams.get("app") ?? APP_SHOPEE_PADRAO;
  if (!ehChaveAppShopee(pedido)) {
    return NextResponse.json({ erro: true, mensagem: "App Shopee invalido." }, { status: 400 });
  }
  // App sem credencial configurada: erro controlado — NUNCA cai para outro app.
  const app = resolverAppShopee(pedido);
  if (!app) {
    return NextResponse.json({ erro: true, mensagem: "App Shopee indisponivel no servidor." }, { status: 503 });
  }

  const segredo = process.env.SESSION_SECRET;
  if (!segredo) {
    console.error("[GET /api/auth/shopee] SESSION_SECRET ausente — OAuth nao pode iniciar.");
    return NextResponse.json({ erro: true, mensagem: "Configuracao invalida no servidor." }, { status: 500 });
  }
  const estado = await emitirEstadoShopee(auth.uid, app.chave, { segredo, agoraSegundos: agoraEmSegundos() });

  const baseUrl     = process.env.SHOPEE_BASE_URL ?? "https://partner.shopeemobile.com";
  const timestamp   = Math.floor(Date.now() / 1000);
  const path        = "/api/v2/shop/auth_partner";
  const baseString  = `${app.partnerId}${path}${timestamp}`;
  const sign        = createHmac("sha256", getHmacKey(app.partnerKey)).update(baseString).digest("hex");

  const siteUrl     = process.env.SHOPEE_REDIRECT_URI
    ?? `${process.env.NEXT_PUBLIC_SITE_URL ?? "https://www.calculadoradossellers.com.br"}/api/auth/shopee/callback`;

  const authUrl =
    `${baseUrl}${path}` +
    `?partner_id=${app.partnerId}` +
    `&timestamp=${timestamp}` +
    `&sign=${sign}` +
    `&redirect=${encodeURIComponent(siteUrl)}`;

  // Redireciona para a Shopee com o estado no cookie httpOnly (limpo pelo callback em qualquer desfecho)
  const res = NextResponse.redirect(authUrl);
  res.cookies.set(NOME_COOKIE_ESTADO_SHOPEE, estado, opcoesCookieEstadoShopee(process.env.NODE_ENV === "production"));
  return res;
}

// Mantém POST para compatibilidade (mesmas regras do GET; corpo ignorado)
export async function POST(request: Request) {
  return GET(request);
}
