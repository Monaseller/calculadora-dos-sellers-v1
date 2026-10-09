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
 * ── STATE OBRIGATORIO E MULTI-APP (Shopee multi-app V2) ────────────
 * Antes este fluxo NAO tinha `state`: um atacante podia induzir um
 * usuario autenticado a visitar este callback com `code`/`shop_id` da
 * conta DELE, associando a loja do atacante a conta da vitima. Agora o
 * inicio (/api/auth/shopee) grava um estado ASSINADO {uid, app, nonce,
 * exp} num cookie httpOnly (lib/shopee-oauth-estado.ts) e este callback:
 *   • exige a sessao (como antes) E o estado valido — sem ele, REJEITA;
 *   • exige uid do estado == uid da sessao;
 *   • usa o app (partner_id/partner_key) SO do estado verificado, resolvido
 *     na allowlist server-side (lib/shopee-apps.ts) — `?app=` aqui nunca e
 *     autoridade, e app sem credencial nunca cai para outro;
 *   • limpa o cookie em QUALQUER desfecho (estado limpo no callback; a
 *     protecao e assinatura + uid + expiracao + httpOnly + o `code` da
 *     Shopee, de uso unico no provedor — nao um "uso unico absoluto").
 * O estado viaja em cookie, nao na URL: nao foi provado que a Shopee
 * preserva parametros no `redirect` do `auth_partner`.
 * PKCE nao se aplica: o fluxo usado e um redirect assinado por parceiro,
 * nao authorization-code OAuth2.
 */
import { NextResponse } from "next/server";
import { createHmac } from "crypto";
import { agoraEmSegundos, autenticarRequisicao, lerCookie } from "@/lib/autenticacao";
import { registrarLojaShopeeOAuth } from "@/lib/marketplace/credenciais";
import { extrairNomeLojaShopee } from "@/lib/lojas/identidade";
import { resolverAppShopee } from "@/lib/shopee-apps";
import { NOME_COOKIE_ESTADO_SHOPEE, opcoesCookieEstadoShopee, verificarEstadoShopee } from "@/lib/shopee-oauth-estado";

// Shopee espera a chave completa como string UTF-8
function getHmacKey(partnerKey: string): string {
  return partnerKey;
}

function shopeeSign(partnerId: string, path: string, timestamp: number, partnerKey: string) {
  return createHmac("sha256", getHmacKey(partnerKey))
    .update(`${partnerId}${path}${timestamp}`)
    .digest("hex");
}

async function processarCallback(request: Request) {
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

  // ── Estado (binding obrigatorio) ──────────────────────────────────
  // Tambem ANTES da troca: sem o estado assinado desta mesma sessao, o
  // `code` nao e trocado. Qualquer falha e a MESMA recusa (sem detalhe).
  const segredo = process.env.SESSION_SECRET;
  const estado = segredo
    ? await verificarEstadoShopee(lerCookie(request, NOME_COOKIE_ESTADO_SHOPEE), { segredo, agoraSegundos: agoraEmSegundos() })
    : null;
  if (!estado || estado.uid !== userId) {
    return NextResponse.redirect(new URL("/configuracoes?erro=shopee_estado", request.url));
  }

  // Credenciais do app QUE INICIOU o fluxo: so do estado verificado, pela
  // allowlist server-side. SOMENTE env (via registro): o fallback por
  // cookie foi removido — nenhum codigo emitia `shopee_partner_*`, e
  // aceita-los deixaria um atacante injetar partner_key pelo navegador.
  const app = resolverAppShopee(estado.app);
  const partnerId  = app?.partnerId;
  const partnerKey = app?.partnerKey;
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

  // 2. Busca nome REAL da loja (assinatura correta para endpoints autenticados: pid+path+ts+token+shopId).
  // CDS V2 Fase 1A: sem nome real fica null — a capability preserva o nome que a loja ja tem
  // e so uma loja NOVA recebe o fallback tecnico. Nunca "Shopee <shop_id>" por cima de nome real.
  let nomeReal: string | null = null;
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
    nomeReal = extrairNomeLojaShopee(info);
    if (nomeReal) console.log("[shopee callback] get_shop_info ok — nome resolvido");
  } catch {
    // Sem detalhe do erro: a excecao pode carregar a URL da requisicao,
    // que contem access_token no query string.
    console.error("[shopee callback] get_shop_info falhou — nome existente preservado");
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
    nomeReal,
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
  // A loja conectada e IDENTIFICADA no retorno (?loja=), sem virar a loja em uso.
  const destino = new URL("/configuracoes?ok=shopee", request.url);
  destino.searchParams.set("loja", lojaId);
  const res = NextResponse.redirect(destino);

  // Salva token ativo
  const isProd = process.env.NODE_ENV === "production";
  res.cookies.set("shopee_access_token", access_token, {
    httpOnly: true, secure: isProd, sameSite: "lax", path: "/", maxAge: expire_in ?? 14400,
  });
  res.cookies.set("shopee_shop_id", String(shopId), {
    httpOnly: false, secure: isProd, sameSite: "lax", path: "/", maxAge: 86400 * 30,
  });

  // CDS V2 Fase 1A: conectar uma conta NAO troca a loja Shopee em uso. O callback nao grava
  // `shopee_loja_id`: a loja corrente so muda pelo "Usar esta" (/api/lojas/ativar). Com uma
  // unica loja Shopee a selecao ja e inequivoca; com varias, a escolha e explicita.
  return res;
}

// Estado LIMPO NO CALLBACK em qualquer desfecho (sucesso, erro ou recusa).
export async function GET(request: Request) {
  const res = await processarCallback(request);
  res.cookies.set(NOME_COOKIE_ESTADO_SHOPEE, "", opcoesCookieEstadoShopee(process.env.NODE_ENV === "production", 0));
  return res;
}
