/**
 * GET /api/auth/shopee/callback — retorno do OAuth da Shopee.
 *
 * ── O BUG QUE ESTA VERSAO CORRIGE (PR #2b-1) ────────────────────────
 * A rota ficou no mecanismo de sessao V1, extinto no cutover:
 *
 *     const userId = getCookie(request, "cds_session");
 *     …eq("user_id", userId) / insert({ user_id: userId })
 *
 * Desde o cutover, `cds_session` carrega um TOKEN ASSINADO, nao um
 * UUID. Comparar ou gravar esse token numa coluna `uuid` nunca casa — e
 * os erros do Supabase eram DESCARTADOS (`const { data } = await …`,
 * sem `error`), com redirect `?ok=shopee` de qualquer forma. Ou seja: a
 * tela dizia "conectado" e nada acontecia.
 *
 * E a MESMA classe de falha que `lojas/desconectar` ja corrigiu na
 * F0.c.6a. Esta rota escapou do inventario porque lia o cookie com um
 * helper proprio, em vez de `autenticarRequisicao`.
 *
 * ── O QUE MUDA ──────────────────────────────────────────────────────
 *  • `userId` vem EXCLUSIVAMENTE de `autenticarRequisicao`;
 *  • sessao ausente/invalida/expirada nao troca nem persiste nada;
 *  • persistencia sai daqui e vai para a capability server-only
 *    `registrarLojaShopeeOAuth` (service_role encapsulada);
 *  • todo erro e checado — falha de persistencia NUNCA devolve `ok`;
 *  • `partner_id`/`partner_key` so de env; o fallback por cookie era
 *    codigo morto (nada os emitia) e um vetor de injecao;
 *  • nenhum log recebe token, chave ou corpo bruto do provedor.
 *
 * ── DIVIDA REGISTRADA, FORA DESTA PR ────────────────────────────────
 * Este fluxo NAO tem `state`. Sem ele, um atacante pode induzir um
 * usuario autenticado a visitar este callback com `code`/`shop_id` da
 * conta DELE, associando a loja do atacante a conta da vitima. Corrigir
 * exige comprovar que a Shopee preserva parametros no `redirect` do
 * `auth_partner` — gate proprio. PKCE nao se aplica: o fluxo usado e um
 * redirect assinado por parceiro, nao authorization-code OAuth2.
 */
import { NextResponse } from "next/server";
import { createHmac } from "crypto";
import { autenticarRequisicao } from "@/lib/autenticacao";
import { registrarLojaShopeeOAuth } from "@/lib/marketplace/credenciais";

// Shopee espera a chave completa como string UTF-8
function getHmacKey(partnerKey: string): string {
  return partnerKey;
}

function shopeeSign(partnerId: string, path: string, timestamp: number, partnerKey: string) {
  return createHmac("sha256", getHmacKey(partnerKey))
    .update(`${partnerId}${path}${timestamp}`)
    .digest("hex");
}

export async function GET(request: Request) {
  const url    = new URL(request.url);
  const code   = url.searchParams.get("code");
  const shopId = Number(url.searchParams.get("shop_id") ?? 0);

  // ── Identidade ────────────────────────────────────────────────────
  // ANTES de qualquer troca de token: sem dono confiavel nao ha o que
  // persistir, e trocar o `code` gastaria uma autorizacao de uso unico
  // para jogar o resultado fora. `autenticarRequisicao` e fail-closed —
  // lanca se `SESSION_SECRET` faltar, e nunca aceita o formato antigo.
  const auth = await autenticarRequisicao(request);
  if (!auth.autenticado) {
    return NextResponse.redirect(new URL("/configuracoes?erro=shopee_sessao", request.url));
  }
  const userId = auth.uid;

  // Credenciais centrais do servidor. SOMENTE env: o fallback por
  // cookie foi removido — nenhum codigo emitia `shopee_partner_*`, e
  // aceita-los deixaria um atacante injetar partner_key pelo navegador
  // caso a env faltasse.
  const partnerId  = process.env.SHOPEE_PARTNER_ID;
  const partnerKey = process.env.SHOPEE_PARTNER_KEY;
  const baseUrl    = process.env.SHOPEE_BASE_URL ?? "https://partner.shopeemobile.com";

  if (!code || !shopId || !partnerId || !partnerKey) {
    return NextResponse.redirect(new URL("/configuracoes?erro=shopee_sem_credenciais", request.url));
  }

  // 1. Troca code por access_token
  const timestamp  = Math.floor(Date.now() / 1000);
  const tokenPath  = "/api/v2/auth/token/get";
  const sign       = shopeeSign(partnerId, tokenPath, timestamp, partnerKey);

  const tokenRes = await fetch(
    `${baseUrl}${tokenPath}?partner_id=${partnerId}&timestamp=${timestamp}&sign=${sign}`,
    {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ code, shop_id: shopId, partner_id: Number(partnerId) }),
    }
  );
  const tokenData = await tokenRes.json();

  if (!tokenData.access_token) {
    // NUNCA logar `tokenData`: o corpo pode conter access_token /
    // refresh_token. O codigo de erro curto e extraido ANTES, para que
    // nenhuma expressao de log sequer referencie o objeto bruto.
    const codigoErro = String(tokenData?.error ?? "desconhecido").slice(0, 60);
    console.error("[shopee callback] token/get falhou — status:", tokenRes.status, "erro:", codigoErro);
    return NextResponse.redirect(new URL("/configuracoes?erro=shopee_token", request.url));
  }

  const { access_token, refresh_token, expire_in } = tokenData;

  // 2. Busca nome da loja (assinatura correta para endpoints autenticados: pid+path+ts+token+shopId)
  let nickname = `Shopee ${shopId}`;
  try {
    const ts2    = Math.floor(Date.now() / 1000);
    const iPath  = "/api/v2/shop/get_shop_info";
    // Endpoints autenticados exigem assinatura com accessToken E shopId
    const iBase  = `${partnerId}${iPath}${ts2}${access_token}${shopId}`;
    const iSign  = createHmac("sha256", getHmacKey(partnerKey)).update(iBase).digest("hex");
    const infoRes = await fetch(
      `${baseUrl}${iPath}?partner_id=${partnerId}&timestamp=${ts2}&sign=${iSign}&access_token=${access_token}&shop_id=${shopId}`
    );
    const info = await infoRes.json();
    // Loga so o nome resolvido — nunca o corpo bruto, que carrega o
    // access_token na propria URL assinada da chamada.
    if (info?.response?.shop_name) {
      nickname = info.response.shop_name;
      console.log("[shopee callback] get_shop_info ok — nome resolvido");
    }
  } catch {
    // Sem detalhe do erro: a excecao pode carregar a URL da requisicao,
    // que contem access_token no query string.
    console.error("[shopee callback] get_shop_info falhou — usando nome padrao");
  }

  // 3. Persistencia — via capability server-only, tenant-aware.
  //
  // NAO ha upsert por (seller_id, user_id): a unique do banco NAO inclui
  // `marketplace`, e `seller_id` e coluna generica entre marketplaces.
  // Um upsert cego poderia sobrescrever a linha de ML do proprio usuario
  // cujo seller_id coincidisse com este shopId. A capability faz SELECT
  // escopado por marketplace e so entao UPDATE ou INSERT.
  const expiresAt = new Date(Date.now() + (expire_in ?? 14400) * 1000).toISOString();

  const registro = await registrarLojaShopeeOAuth(userId, {
    shopId:       String(shopId),
    nickname,
    nome:         nickname,
    partnerId,
    partnerKey,
    accessToken:  access_token,
    refreshToken: refresh_token ?? null,
    expiraEm:     expiresAt,
  });

  // Falha de persistencia NUNCA pode terminar em `?ok=shopee` — foi
  // exatamente esse falso sucesso que escondeu o bug por semanas.
  if (registro.motivo === "duplicidade_loja") {
    console.error("[shopee callback] duplicidade de loja para o proprio usuario — nada gravado");
    return NextResponse.redirect(new URL("/configuracoes?erro=shopee_duplicidade", request.url));
  }
  if (registro.erro || !registro.lojaId) {
    console.error("[shopee callback] persistencia falhou:", String(registro.erro ?? "sem lojaId").slice(0, 120));
    return NextResponse.redirect(new URL("/configuracoes?erro=shopee_persistencia", request.url));
  }
  const lojaId = registro.lojaId;

  // 4. Seta cookies e redireciona
  const res = NextResponse.redirect(new URL("/configuracoes?ok=shopee", request.url));

  // Salva token ativo
  const isProd = process.env.NODE_ENV === "production";
  res.cookies.set("shopee_access_token", access_token, {
    httpOnly: true, secure: isProd, sameSite: "lax", path: "/", maxAge: expire_in ?? 14400,
  });
  res.cookies.set("shopee_shop_id", String(shopId), {
    httpOnly: false, secure: isProd, sameSite: "lax", path: "/", maxAge: 86400 * 30,
  });

  if (lojaId) {
    // Cookie específico da Shopee — não sobrescreve loja_ativa_id do ML
    res.cookies.set("shopee_loja_id", lojaId, {
      httpOnly: false, secure: isProd, sameSite: "lax", path: "/", maxAge: 86400 * 30,
    });
  }

  return res;
}
