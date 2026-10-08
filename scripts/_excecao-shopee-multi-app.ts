/**
 * SHOPEE MULTI-APP (V2/V2B) — excecao EXATA dos 6 guards para o OAuth
 * Shopee com dois apps (default / rd) e estado assinado obrigatorio.
 *
 * MODIFICADOS: app/api/auth/shopee/route.ts, app/api/auth/shopee/callback/
 * route.ts, app/(app)/configuracoes/page.tsx e .env.example so passam se,
 * revertendo EXATAMENTE os hunks aprovados abaixo (gerados do diff contra
 * eca183a), o resultado for BYTE-IDENTICO ao blob de eca183a — e se o arquivo
 * na base do guard for um blob ja aprovado (pinado abaixo). Pipeline Shopee
 * (refresh, sync, ingestao, worker, intraday, escrow, importar-anuncios),
 * Vendas, Dashboard e Meus Produtos seguem travados.
 *
 * NOVOS, so com o conteudo EXATO (sha256, forma LF) e so se nao existiam na
 * base do guard: lib/shopee-apps.ts, lib/shopee-oauth-estado.ts,
 * app/api/auth/shopee/apps/route.ts, o teste multi-app e este helper (auto-pin).
 *
 * SEC-3-B1 J2: configuracoes/page.tsx sai da lista SO por esta excecao exata —
 * a lista generica de telas "use client" nao muda.
 * .env.example: SO os dois nomes VAZIOS do app rd (+ comentario).
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const BASE_SHOPEE_MULTI_APP = "eca183a";
export const HELPER_SHOPEE_MULTI_APP = "scripts/_excecao-shopee-multi-app.ts";
export const ENV_EXEMPLO = ".env.example";
/** As UNICAS linhas de variavel que o .env.example ganha (nomes vazios, nunca valor). */
export const VARS_ENV_APROVADAS = ["+SHOPEE_RD_PARTNER_ID=", "+SHOPEE_RD_PARTNER_KEY="];

const SHA256_NOVOS: Record<string, string> = {
  "lib/shopee-apps.ts": "6e5dd50a5210710cceff2e54b56881d8a03bfaae23254b25c8468b7178372378",
  "lib/shopee-oauth-estado.ts": "d9df966ef973979db214142611f10232d83cdb0af58e432f3738403c75db6d59",
  "app/api/auth/shopee/apps/route.ts": "d7848576ef5346cae193f6cb85b57ea5771a5c5a76b74f48311c50db0b581629",
  "scripts/testar-shopee-multi-app.ts": "41b7b4255893f2274f0a656bfaf967cfc5c86001363318eb5e937e40cf98ba76"
};
const SHA256_HELPER_SHOPEE_MULTI_APP = "d15c33acac2f1b59ed7e532eeafdb738dbf40d20ab5d4ba8f152e2f4bc94a09a";
const BLOBS_BASE_APROVADOS: Record<string, string[]> = {
  "app/api/auth/shopee/route.ts": [
    "dff7fd997b62eeed0e0cbaf446bfbc39afea3c00"
  ],
  "app/api/auth/shopee/callback/route.ts": [
    "b81cceef6e714bae05b1428b066ffbb6442f995e"
  ],
  "app/(app)/configuracoes/page.tsx": [
    "b03ea2fa10bb7551f587370d2f8c9eb346d5f4c5"
  ],
  ".env.example": [
    "0aa1bc04415148451758e7792a1d808d68f6c677",
    "476aceb22791f974ba2c3b9dd734ff2575f3113d",
    "f15f9409b06e9f07f3164883be9901948ae16495"
  ]
};
const PATCH: Record<string, { base: string; novo: string }[]> = {
  "app/api/auth/shopee/route.ts": [
    {
      "base": "import { createHmac } from \"crypto\";\n",
      "novo": "import { createHmac } from \"crypto\";\nimport { agoraEmSegundos, autenticarRequisicao } from \"@/lib/autenticacao\";\nimport { APP_SHOPEE_PADRAO, ehChaveAppShopee, resolverAppShopee } from \"@/lib/shopee-apps\";\nimport { emitirEstadoShopee, NOME_COOKIE_ESTADO_SHOPEE, opcoesCookieEstadoShopee } from \"@/lib/shopee-oauth-estado\";\n"
    },
    {
      "base": "\n// GET /api/auth/shopee\n// Gera URL de autorização Shopee usando credenciais do servidor (env vars)\nexport async function GET(request: Request) {\n  const partnerId  = process.env.SHOPEE_PARTNER_ID;\n  const partnerKey = process.env.SHOPEE_PARTNER_KEY;\n  const baseUrl    = process.env.SHOPEE_BASE_URL ?? \"https://partner.shopeemobile.com\";\n\n  if (!partnerId || !partnerKey) {\n    return NextResponse.json({ erro: true, mensagem: \"Credenciais Shopee não configuradas no servidor.\" }, { status: 500 });\n  }\n\n  const timestamp   = Math.floor(Date.now() / 1000);\n  const path        = \"/api/v2/shop/auth_partner\";\n  const baseString  = `${partnerId}${path}${timestamp}`;\n  const sign        = createHmac(\"sha256\", getHmacKey(partnerKey)).update(baseString).digest(\"hex\");\n",
      "novo": "\n/** Parametros que NUNCA sao aceitos do navegador: a credencial do app vem so do registro server-side. */\nconst PARAMETROS_PROIBIDOS = [\"partner_id\", \"partner_key\", \"partnerId\", \"partnerKey\"];\n\n// GET /api/auth/shopee[?app=default|rd]\n// Inicia o OAuth com o app ESCOLHIDO NA ALLOWLIST (lib/shopee-apps.ts).\n// Exige sessao: o estado assinado amarra (uid, app) a esta tentativa e o\n// callback so aceita a volta com esse mesmo estado (lib/shopee-oauth-estado.ts).\n// O middleware mantem a rota na lista de navegacao (redirect em vez de 401\n// JSON); a protecao de sessao vive AQUI.\nexport async function GET(request: Request) {\n  const auth = await autenticarRequisicao(request);\n  if (!auth.autenticado) {\n    const login = new URL(\"/login\", request.url);\n    login.searchParams.set(\"redirect\", \"/configuracoes\");\n    return NextResponse.redirect(login);\n  }\n\n  const url = new URL(request.url);\n  if (PARAMETROS_PROIBIDOS.some((p) => url.searchParams.has(p))) {\n    return NextResponse.json({ erro: true, mensagem: \"Parametro nao permitido.\" }, { status: 400 });\n  }\n  const pedido = url.searchParams.get(\"app\") ?? APP_SHOPEE_PADRAO;\n  if (!ehChaveAppShopee(pedido)) {\n    return NextResponse.json({ erro: true, mensagem: \"App Shopee invalido.\" }, { status: 400 });\n  }\n  // App sem credencial configurada: erro controlado — NUNCA cai para outro app.\n  const app = resolverAppShopee(pedido);\n  if (!app) {\n    return NextResponse.json({ erro: true, mensagem: \"App Shopee indisponivel no servidor.\" }, { status: 503 });\n  }\n\n  const segredo = process.env.SESSION_SECRET;\n  if (!segredo) {\n    console.error(\"[GET /api/auth/shopee] SESSION_SECRET ausente — OAuth nao pode iniciar.\");\n    return NextResponse.json({ erro: true, mensagem: \"Configuracao invalida no servidor.\" }, { status: 500 });\n  }\n  const estado = await emitirEstadoShopee(auth.uid, app.chave, { segredo, agoraSegundos: agoraEmSegundos() });\n\n  const baseUrl     = process.env.SHOPEE_BASE_URL ?? \"https://partner.shopeemobile.com\";\n  const timestamp   = Math.floor(Date.now() / 1000);\n  const path        = \"/api/v2/shop/auth_partner\";\n  const baseString  = `${app.partnerId}${path}${timestamp}`;\n  const sign        = createHmac(\"sha256\", getHmacKey(app.partnerKey)).update(baseString).digest(\"hex\");\n"
    },
    {
      "base": "    `${baseUrl}${path}` +\n    `?partner_id=${partnerId}` +\n    `&timestamp=${timestamp}` +",
      "novo": "    `${baseUrl}${path}` +\n    `?partner_id=${app.partnerId}` +\n    `&timestamp=${timestamp}` +"
    },
    {
      "base": "\n  // Redireciona direto para a Shopee\n  return NextResponse.redirect(authUrl);\n}\n\n// Mantém POST para compatibilidade\nexport async function POST(request: Request) {",
      "novo": "\n  // Redireciona para a Shopee com o estado no cookie httpOnly (limpo pelo callback em qualquer desfecho)\n  const res = NextResponse.redirect(authUrl);\n  res.cookies.set(NOME_COOKIE_ESTADO_SHOPEE, estado, opcoesCookieEstadoShopee(process.env.NODE_ENV === \"production\"));\n  return res;\n}\n\n// Mantém POST para compatibilidade (mesmas regras do GET; corpo ignorado)\nexport async function POST(request: Request) {"
    }
  ],
  "app/api/auth/shopee/callback/route.ts": [
    {
      "base": " *\n * ── DIVIDA REGISTRADA, FORA DESTA PR ────────────────────────────────\n * Este fluxo NAO tem `state`. Sem ele, um atacante pode induzir um\n * usuario autenticado a visitar este callback com `code`/`shop_id` da\n * conta DELE, associando a loja do atacante a conta da vitima. Corrigir\n * exige comprovar que a Shopee preserva parametros no `redirect` do\n * `auth_partner` — gate proprio. PKCE nao se aplica: o fluxo usado e um\n * redirect assinado por parceiro, nao authorization-code OAuth2.\n */",
      "novo": " *\n * ── STATE OBRIGATORIO E MULTI-APP (Shopee multi-app V2) ────────────\n * Antes este fluxo NAO tinha `state`: um atacante podia induzir um\n * usuario autenticado a visitar este callback com `code`/`shop_id` da\n * conta DELE, associando a loja do atacante a conta da vitima. Agora o\n * inicio (/api/auth/shopee) grava um estado ASSINADO {uid, app, nonce,\n * exp} num cookie httpOnly (lib/shopee-oauth-estado.ts) e este callback:\n *   • exige a sessao (como antes) E o estado valido — sem ele, REJEITA;\n *   • exige uid do estado == uid da sessao;\n *   • usa o app (partner_id/partner_key) SO do estado verificado, resolvido\n *     na allowlist server-side (lib/shopee-apps.ts) — `?app=` aqui nunca e\n *     autoridade, e app sem credencial nunca cai para outro;\n *   • limpa o cookie em QUALQUER desfecho (estado limpo no callback; a\n *     protecao e assinatura + uid + expiracao + httpOnly + o `code` da\n *     Shopee, de uso unico no provedor — nao um \"uso unico absoluto\").\n * O estado viaja em cookie, nao na URL: nao foi provado que a Shopee\n * preserva parametros no `redirect` do `auth_partner`.\n * PKCE nao se aplica: o fluxo usado e um redirect assinado por parceiro,\n * nao authorization-code OAuth2.\n */"
    },
    {
      "base": "import { createHmac } from \"crypto\";\nimport { autenticarRequisicao } from \"@/lib/autenticacao\";\nimport { registrarLojaShopeeOAuth } from \"@/lib/marketplace/credenciais\";\n",
      "novo": "import { createHmac } from \"crypto\";\nimport { agoraEmSegundos, autenticarRequisicao, lerCookie } from \"@/lib/autenticacao\";\nimport { registrarLojaShopeeOAuth } from \"@/lib/marketplace/credenciais\";\nimport { resolverAppShopee } from \"@/lib/shopee-apps\";\nimport { NOME_COOKIE_ESTADO_SHOPEE, opcoesCookieEstadoShopee, verificarEstadoShopee } from \"@/lib/shopee-oauth-estado\";\n"
    },
    {
      "base": "\nexport async function GET(request: Request) {\n  const url    = new URL(request.url);",
      "novo": "\nasync function processarCallback(request: Request) {\n  const url    = new URL(request.url);"
    },
    {
      "base": "\n  // Credenciais centrais do servidor. SOMENTE env: o fallback por\n  // cookie foi removido — nenhum codigo emitia `shopee_partner_*`, e\n  // aceita-los deixaria um atacante injetar partner_key pelo navegador\n  // caso a env faltasse.\n  const partnerId  = process.env.SHOPEE_PARTNER_ID;\n  const partnerKey = process.env.SHOPEE_PARTNER_KEY;\n  const baseUrl    = process.env.SHOPEE_BASE_URL ?? \"https://partner.shopeemobile.com\";",
      "novo": "\n  // ── Estado (binding obrigatorio) ──────────────────────────────────\n  // Tambem ANTES da troca: sem o estado assinado desta mesma sessao, o\n  // `code` nao e trocado. Qualquer falha e a MESMA recusa (sem detalhe).\n  const segredo = process.env.SESSION_SECRET;\n  const estado = segredo\n    ? await verificarEstadoShopee(lerCookie(request, NOME_COOKIE_ESTADO_SHOPEE), { segredo, agoraSegundos: agoraEmSegundos() })\n    : null;\n  if (!estado || estado.uid !== userId) {\n    return NextResponse.redirect(new URL(\"/configuracoes?erro=shopee_estado\", request.url));\n  }\n\n  // Credenciais do app QUE INICIOU o fluxo: so do estado verificado, pela\n  // allowlist server-side. SOMENTE env (via registro): o fallback por\n  // cookie foi removido — nenhum codigo emitia `shopee_partner_*`, e\n  // aceita-los deixaria um atacante injetar partner_key pelo navegador.\n  const app = resolverAppShopee(estado.app);\n  const partnerId  = app?.partnerId;\n  const partnerKey = app?.partnerKey;\n  const baseUrl    = process.env.SHOPEE_BASE_URL ?? \"https://partner.shopeemobile.com\";"
    },
    {
      "base": "}",
      "novo": "}\n\n// Estado LIMPO NO CALLBACK em qualquer desfecho (sucesso, erro ou recusa).\nexport async function GET(request: Request) {\n  const res = await processarCallback(request);\n  res.cookies.set(NOME_COOKIE_ESTADO_SHOPEE, \"\", opcoesCookieEstadoShopee(process.env.NODE_ENV === \"production\", 0));\n  return res;\n}"
    }
  ],
  "app/(app)/configuracoes/page.tsx": [
    {
      "base": "  const [shopeeAtiva,  setShopeeAtiva]  = useState<string | null>(null);\n  const [loading,   setLoading]   = useState(true);",
      "novo": "  const [shopeeAtiva,  setShopeeAtiva]  = useState<string | null>(null);\n  // Apps Shopee alem do padrao, so os CONFIGURADOS no servidor (sem credencial no navegador)\n  const [appsShopeeExtras, setAppsShopeeExtras] = useState<{ chave: string; rotulo: string }[]>([]);\n  const [loading,   setLoading]   = useState(true);"
    },
    {
      "base": "  useEffect(() => { carregarLojas(); carregarPerfil(); }, []);\n",
      "novo": "  useEffect(() => { carregarLojas(); carregarPerfil(); }, []);\n  useEffect(() => {\n    fetch(\"/api/auth/shopee/apps\").then((r) => (r.ok ? r.json() : null)).then((d) => {\n      const apps = Array.isArray(d?.apps) ? d.apps : [];\n      setAppsShopeeExtras(apps.filter((a: { chave: string; configurado: boolean }) => a.chave !== \"default\" && a.configurado === true)\n        .map((a: { chave: string; rotulo: string }) => ({ chave: String(a.chave), rotulo: String(a.rotulo) })));\n    }).catch(() => setAppsShopeeExtras([]));\n  }, []);\n"
    },
    {
      "base": "\n        </div>",
      "novo": "\n          {/* Shopee — outros apps configurados no servidor (ex.: R.D.) */}\n          {appsShopeeExtras.map((app) => (\n            <a key={app.chave} href={`/api/auth/shopee?app=${encodeURIComponent(app.chave)}`}\n              style={{ display: \"block\", textDecoration: \"none\", background: \"rgba(238,77,45,0.05)\", border: \"1px solid rgba(238,77,45,0.18)\", borderRadius: \"14px\", padding: \"24px\", cursor: \"pointer\" }}>\n              <div style={{ fontWeight: 800, fontSize: \"15px\", color: \"#EE4D2D\", marginBottom: \"6px\" }}>{app.rotulo}</div>\n              <div style={{ fontSize: \"13px\", color: \"#EE4D2D\", fontWeight: 700 }}>Conectar {app.rotulo}</div>\n            </a>\n          ))}\n\n        </div>"
    }
  ],
  ".env.example": [
    {
      "base": "N8N_INGESTAO_AGENT_ID=",
      "novo": "N8N_INGESTAO_AGENT_ID=\n\n# Segundo app Shopee Open Platform (chave \"rd\" em lib/shopee-apps.ts). Sem as duas,\n# o app fica INDISPONIVEL (nunca cai para o app padrao). Valores so no servidor.\nSHOPEE_RD_PARTNER_ID=\nSHOPEE_RD_PARTNER_KEY="
    }
  ]
};

const lf = (s: string) => s.replace(/\r\n/g, "\n");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
function blob(raiz: string, rev: string, arquivo: string): string | null {
  try { return lf(execFileSync("git", ["show", `${rev}:${arquivo}`], { cwd: raiz, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })); }
  catch { return null; }
}
function idBlob(raiz: string, rev: string, arquivo: string): string | null {
  try { return execFileSync("git", ["rev-parse", `${rev}:${arquivo}`], { cwd: raiz, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return null; }
}
function ler(raiz: string, arquivo: string): string | null {
  try { return lf(readFileSync(join(raiz, arquivo), "utf8")); } catch { return null; }
}

/** Arquivo atual − hunks aprovados = eca183a, byte a byte (cada hunk exatamente uma vez). */
export function arquivoExatoShopeeMultiApp(raiz: string, arquivo: string): boolean {
  const hunks = PATCH[arquivo];
  let s = hunks ? ler(raiz, arquivo) : null;
  if (s === null) return false;
  for (const h of hunks) {
    if (s.split(h.novo).length !== 2) return false;
    s = s.replace(h.novo, () => h.base);
  }
  const base = blob(raiz, BASE_SHOPEE_MULTI_APP, arquivo);
  return base !== null && s === base;
}

export function novoExatoShopeeMultiApp(raiz: string, arquivo: string): boolean {
  if (arquivo === HELPER_SHOPEE_MULTI_APP) {
    const s = ler(raiz, HELPER_SHOPEE_MULTI_APP);
    return s !== null && sha(s.replace(/const SHA256_HELPER_SHOPEE_MULTI_APP = "[0-9a-f]{64}";/, `const SHA256_HELPER_SHOPEE_MULTI_APP = "${"0".repeat(64)}";`)) === SHA256_HELPER_SHOPEE_MULTI_APP;
  }
  const esperado = SHA256_NOVOS[arquivo];
  const s = esperado ? ler(raiz, arquivo) : null;
  return s !== null && sha(s) === esperado;
}

const ehNovo = (f: string) => f in SHA256_NOVOS || f === HELPER_SHOPEE_MULTI_APP;

/** Remove da lista SO o que esta excecao cobre (modificados exatos com base aprovada; novos exatos ausentes na base). */
export function filtrarExcecaoShopeeMultiApp(raiz: string, base: string, alterados: string[]): string[] {
  return alterados.filter((f) => {
    if (f in PATCH) { const b = idBlob(raiz, base, f); return !(b !== null && BLOBS_BASE_APROVADOS[f].includes(b) && arquivoExatoShopeeMultiApp(raiz, f)); }
    if (ehNovo(f) && blob(raiz, base, f) === null) return !novoExatoShopeeMultiApp(raiz, f);
    return true;
  });
}

/** Linhas de variavel extras aceitas no template de env: SO com .env.example exato e helper exato. */
export function varsEnvExemploAprovadas(raiz: string): string[] {
  return arquivoExatoShopeeMultiApp(raiz, ENV_EXEMPLO) && novoExatoShopeeMultiApp(raiz, HELPER_SHOPEE_MULTI_APP) ? [...VARS_ENV_APROVADAS] : [];
}
