/**
 * Estado ASSINADO do OAuth Shopee (multi-app) — binding obrigatorio entre o
 * inicio (/api/auth/shopee) e o callback (/api/auth/shopee/callback).
 *
 * ── O que impede ────────────────────────────────────────────────────
 * Sem estado, um atacante podia fazer o navegador de um usuario autenticado
 * concluir uma autorizacao iniciada por ELE (code/shop_id do atacante),
 * ligando a loja do atacante a conta da vitima (login-CSRF / shop-linking
 * cross-flow). E, com dois apps, o callback precisa PROVAR qual app iniciou
 * o fluxo — `?app=` no callback nunca e autoridade.
 *
 * ── Onde viaja ──────────────────────────────────────────────────────
 * Num cookie httpOnly (path /api/auth/shopee, sameSite=lax, ~10 min), nao
 * na URL: o `auth_partner` da Shopee nao tem `state` documentado e nao foi
 * provado que ela preserve parametros do `redirect`. sameSite=lax manda o
 * cookie na navegacao GET de volta da Shopee; o callback LIMPA o cookie em
 * QUALQUER desfecho (estado limpo no callback).
 *
 * ── Conteudo ────────────────────────────────────────────────────────
 * {v, uid, app, nonce, iat, exp} — exatamente estas chaves. O callback exige
 * uid == sessao, app allowlisted e configurado, exp no futuro e TTL <= teto.
 *
 * ── Mesmas invariantes de lib/estado-oauth.ts (ML) ──────────────────
 * Web Crypto apenas · nunca le relogio nem ambiente (quem chama passa) ·
 * assinatura sobre CONTEXTO + payload transmitido (separacao de dominio da
 * sessao e do state do ML, que usam o mesmo SESSION_SECRET) · entrada hostil
 * → null em silencio · erro de configuracao LANCA · parser estrito.
 *
 * ── Protecao (e o que NAO e) ─────────────────────────────────────────
 * O estado e stateless: NAO e "uso unico absoluto". A protecao e a soma de
 * assinatura (HMAC com contexto proprio) + vinculo ao uid da sessao +
 * expiracao (<= 600 s) + cookie httpOnly + o `code` da Shopee, que e de uso
 * unico no provedor. O callback LIMPA o cookie em qualquer desfecho, entao o
 * mesmo navegador nao o reapresenta; um valor copiado so serve para a MESMA
 * sessao dentro da validade. Se alguma dessas premissas cair, o caminho e
 * persistir tentativas (used_at) — fora deste gate.
 */
import { ehChaveAppShopee, type ChaveAppShopee } from "./shopee-apps";

export const VERSAO_ESTADO_SHOPEE = 1;
export const CONTEXTO_ESTADO_SHOPEE = "cds.shopee.oauth.state.v1:";
export const TTL_ESTADO_SHOPEE_SEGUNDOS = 600;
export const TTL_MAXIMO_ESTADO_SHOPEE_SEGUNDOS = 600;
export const NOME_COOKIE_ESTADO_SHOPEE = "cds_shopee_oauth";
export const CAMINHO_COOKIE_ESTADO_SHOPEE = "/api/auth/shopee";
const SEGREDO_MINIMO_BYTES = 32;
const TAMANHO_MAXIMO = 512;
const FOLGA_RELOGIO_SEGUNDOS = 60;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64URL_REGEX = /^[A-Za-z0-9_-]+$/;
const NONCE_REGEX = /^[A-Za-z0-9_-]{22}$/; // 16 bytes
const CAMPOS = ["v", "uid", "app", "nonce", "iat", "exp"] as const;

export interface EstadoShopee { v: number; uid: string; app: ChaveAppShopee; nonce: string; iat: number; exp: number }

export class ErroConfiguracaoEstadoShopee extends Error {
  constructor(m: string) { super(m); this.name = "ErroConfiguracaoEstadoShopee"; }
}

const codificador = new TextEncoder();
const decodificador = new TextDecoder("utf-8", { fatal: true });

function paraBase64url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function deBase64url(texto: string): Uint8Array | null {
  if (!texto || !BASE64URL_REGEX.test(texto)) return null;
  const p = texto.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (texto.length % 4)) % 4);
  try { const b = atob(p); const out = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i); return out; }
  catch { return null; }
}
function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new ErroConfiguracaoEstadoShopee("Web Crypto indisponivel — estado do OAuth Shopee nao pode operar.");
  return s;
}
async function chave(segredo: string): Promise<CryptoKey> {
  if (typeof segredo !== "string" || segredo.length === 0) throw new ErroConfiguracaoEstadoShopee("Segredo do estado ausente.");
  const bytes = codificador.encode(segredo);
  if (bytes.length < SEGREDO_MINIMO_BYTES) throw new ErroConfiguracaoEstadoShopee(`Segredo do estado curto demais: minimo ${SEGREDO_MINIMO_BYTES} bytes.`);
  return subtle().importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
const serializar = (e: EstadoShopee) =>
  `{"v":${e.v},"uid":${JSON.stringify(e.uid)},"app":${JSON.stringify(e.app)},"nonce":${JSON.stringify(e.nonce)},"iat":${e.iat},"exp":${e.exp}}`;
const inteiro = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x > 0;

function validar(bruto: unknown): EstadoShopee | null {
  if (typeof bruto !== "object" || bruto === null || Array.isArray(bruto)) return null;
  const r = bruto as Record<string, unknown>;
  const chaves = Object.keys(r);
  if (chaves.length !== CAMPOS.length || !CAMPOS.every((c) => chaves.includes(c))) return null;
  if (r.v !== VERSAO_ESTADO_SHOPEE) return null;
  if (typeof r.uid !== "string" || !UUID_REGEX.test(r.uid)) return null;
  if (!ehChaveAppShopee(r.app)) return null;
  if (typeof r.nonce !== "string" || !NONCE_REGEX.test(r.nonce)) return null;
  if (!inteiro(r.iat) || !inteiro(r.exp) || r.exp <= r.iat || r.exp - r.iat > TTL_MAXIMO_ESTADO_SHOPEE_SEGUNDOS) return null;
  return { v: r.v, uid: r.uid, app: r.app, nonce: r.nonce, iat: r.iat, exp: r.exp };
}

/** Novo estado assinado para (uid, app). Lanca so por configuracao (segredo/Web Crypto). */
export async function emitirEstadoShopee(
  uid: string, app: ChaveAppShopee, opcoes: { segredo: string; agoraSegundos: number; ttlSegundos?: number },
): Promise<string> {
  const ttl = opcoes.ttlSegundos ?? TTL_ESTADO_SHOPEE_SEGUNDOS;
  const nonce = paraBase64url(globalThis.crypto.getRandomValues(new Uint8Array(16)));
  const e = validar({ v: VERSAO_ESTADO_SHOPEE, uid, app, nonce, iat: opcoes.agoraSegundos, exp: opcoes.agoraSegundos + ttl });
  if (!e) throw new ErroConfiguracaoEstadoShopee("Estado Shopee invalido na emissao (uid/app/ttl).");
  const payload = paraBase64url(codificador.encode(serializar(e)));
  const assinatura = await subtle().sign("HMAC", await chave(opcoes.segredo), codificador.encode(CONTEXTO_ESTADO_SHOPEE + payload));
  return `${payload}.${paraBase64url(new Uint8Array(assinatura))}`;
}

/** Estado valido (assinatura, formato, validade) ou null. NAO compara uid/app — isso e do callback. */
export async function verificarEstadoShopee(token: unknown, opcoes: { segredo: string; agoraSegundos: number }): Promise<EstadoShopee | null> {
  const k = await chave(opcoes.segredo); // configuracao errada lanca antes de olhar a entrada
  if (typeof token !== "string" || token.length === 0 || token.length > TAMANHO_MAXIMO) return null;
  const partes = token.split(".");
  if (partes.length !== 2) return null;
  const [payload, assinaturaTxt] = partes;
  const assinatura = deBase64url(assinaturaTxt);
  if (!assinatura || !BASE64URL_REGEX.test(payload)) return null;
  const ok = await subtle().verify("HMAC", k, assinatura, codificador.encode(CONTEXTO_ESTADO_SHOPEE + payload));
  if (!ok) return null;
  const bytes = deBase64url(payload);
  if (!bytes) return null;
  let bruto: unknown;
  try { bruto = JSON.parse(decodificador.decode(bytes)); } catch { return null; }
  const e = validar(bruto);
  if (!e) return null;
  if (opcoes.agoraSegundos >= e.exp) return null;
  if (e.iat > opcoes.agoraSegundos + FOLGA_RELOGIO_SEGUNDOS) return null;
  return e;
}

/** Opcoes do cookie do estado (secure so em producao, como a sessao). */
export function opcoesCookieEstadoShopee(producao: boolean, maxAge: number = TTL_ESTADO_SHOPEE_SEGUNDOS) {
  return { httpOnly: true, secure: producao, sameSite: "lax" as const, path: CAMINHO_COOKIE_ESTADO_SHOPEE, maxAge };
}
