/**
 * `state` assinado do OAuth Mercado Livre — F0.c.6c.
 *
 * ── O que este módulo impede ────────────────────────────────────────
 * O fluxo OAuth do CDS não tinha `state`. Sem ele, qualquer pessoa podia
 * fazer o navegador de um usuário autenticado completar uma autorização
 * que ela iniciou (CSRF), e não havia como o callback saber QUAL loja
 * estava sendo reconectada — o `loja_id` simplesmente não trafegava.
 *
 * Este módulo produz um token que:
 *   · só pode ser fabricado por quem tem o segredo;
 *   · carrega o `uid` de quem iniciou, para o callback comparar com a
 *     sessão de quem voltou;
 *   · carrega a loja pretendida quando é reconexão;
 *   · expira em minutos.
 *
 * ── Por que não reaproveitar `assinarSessao` ────────────────────────
 * O parser de `lib/sessao-assinada.ts` exige EXATAMENTE os campos
 * `v/uid/iat/exp` e recusa qualquer chave a mais — `intent` e `loja`
 * seriam rejeitados. O desenho é copiado; a função, não.
 *
 * ── SEPARAÇÃO DE DOMÍNIO ────────────────────────────────────────────
 * A chave é a mesma da sessão (`SESSION_SECRET`), então a assinatura NÃO
 * cobre só o payload: ela cobre `CONTEXTO + payload`. Sem isso, um token
 * de sessão e um `state` seriam artefatos do mesmo formato assinados com
 * a mesma chave, e a separação dependeria apenas de os dois parsers
 * discordarem — o que é verdade hoje e pode deixar de ser amanhã. Com o
 * contexto, um token de sessão é estruturalmente inválido como `state`,
 * e vice-versa, mesmo que os parsers convirjam.
 *
 * ── Mesmas invariantes de `sessao-assinada.ts` ──────────────────────
 * Web Crypto apenas (vale em Node e Edge) · nunca lê o relógio · nunca
 * lê variável de ambiente · a assinatura cobre a STRING TRANSMITIDA, não
 * um JSON reserializado · entrada hostil devolve `null` em silêncio ·
 * erro de configuração **lança** · parser estrito.
 *
 * ── O que este módulo NÃO resolve ───────────────────────────────────
 * REPLAY. Sendo stateless, não há onde marcar "já usado": o mesmo
 * `state` pode ser reapresentado dentro da validade. Isso é aceito com
 * três condições, todas verdadeiras no fluxo atual: o callback exige
 * sessão, o `code` do Mercado Livre é de uso único, e a propriedade da
 * loja é revalidada no banco. Se qualquer uma dessas cair, este módulo
 * deixa de ser suficiente e o caminho é uma tabela `oauth_attempts` com
 * `used_at`.
 */

/**
 * Versão do formato. `state` de outra versão é recusado.
 *
 * 1 → 2 em F0.c.7, com a entrada do PKCE: o payload passou a carregar
 * `chal` (o `code_challenge`), e o parser é estrito por CONJUNTO de
 * chaves — um `state` da versão 1 não tem esse campo e não pode ser
 * aceito. States em voo são invalidados, o que é aceitável porque duram
 * 10 minutos; a alternativa (aceitar as duas formas) criaria um caminho
 * sem PKCE, que é exatamente o que esta etapa fecha.
 */
export const VERSAO_ESTADO = 2;

/**
 * Prefixo da separação de domínio. Trocar isto invalida todo `state` em
 * voo — o que é aceitável, porque eles duram minutos.
 */
export const CONTEXTO_ASSINATURA = "cds.oauth.state.v1:";

/**
 * 10 minutos. O caminho real inclui login no Mercado Livre, 2FA e a tela
 * de permissões; 5 minutos reprovaria gente legítima. Curto o bastante
 * para a janela de replay ser irrelevante.
 */
export const TTL_PADRAO_SEGUNDOS = 600;

/**
 * Teto absoluto, validado também na VERIFICAÇÃO: um `state` assinado com
 * duração maior é recusado mesmo com assinatura boa. Impede que um erro
 * futuro no emissor produza `state` quase eterno.
 */
export const TTL_MAXIMO_SEGUNDOS = 600;

/** 256 bits. Segredo menor é erro de configuração, não aviso. */
export const SEGREDO_MINIMO_BYTES = 32;

/** Um `state` real tem ~200 caracteres. Entrada hostil enorme cai antes. */
export const TAMANHO_MAXIMO_ESTADO = 512;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64URL_REGEX = /^[A-Za-z0-9_-]+$/;

/**
 * `code_challenge` de SHA-256 em base64url sem padding tem exatamente 43
 * caracteres. O formato é validado tanto para recusar lixo quanto porque
 * ele vira parte do NOME do cookie do PKCE — ver `nomeCookiePkce`.
 */
const CHALLENGE_REGEX = /^[A-Za-z0-9_-]{43}$/;

/** Conjuntos de chaves ACEITOS — exatamente estes, nem a mais nem a menos. */
const CAMPOS_CONNECT = ["v", "uid", "intent", "chal", "iat", "exp"] as const;
const CAMPOS_RECONNECT = ["v", "uid", "intent", "loja", "chal", "iat", "exp"] as const;

export type IntencaoOAuth = "connect" | "reconnect";

export type EstadoOAuth =
  | { v: number; uid: string; intent: "connect"; chal: string; iat: number; exp: number }
  | { v: number; uid: string; intent: "reconnect"; loja: string; chal: string; iat: number; exp: number };

/** Erro de CONFIGURAÇÃO — nunca causado por entrada de usuário. */
export class ErroConfiguracaoEstado extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = "ErroConfiguracaoEstado";
  }
}

// ── Codificação (sem Buffer, para valer no Edge) ─────────────────────
// Duplicada de `lib/sessao-assinada.ts` de propósito: aquele módulo não
// exporta estes utilitários, e alterá-lo — o mais crítico e mais testado
// do repositório — não é escopo desta etapa.

const codificador = new TextEncoder();
const decodificador = new TextDecoder("utf-8", { fatal: true });

function bytesParaBase64url(bytes: Uint8Array): string {
  let binario = "";
  for (let i = 0; i < bytes.length; i++) binario += String.fromCharCode(bytes[i]);
  return btoa(binario).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlParaBytes(texto: string): Uint8Array | null {
  if (!texto || !BASE64URL_REGEX.test(texto)) return null;
  const padded = texto.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (texto.length % 4)) % 4);
  try {
    const binario = atob(padded);
    const bytes = new Uint8Array(binario.length);
    for (let i = 0; i < binario.length; i++) bytes[i] = binario.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function obterSubtle(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new ErroConfiguracaoEstado(
      "Web Crypto (crypto.subtle) indisponível neste runtime — state do OAuth não pode operar."
    );
  }
  return subtle;
}

async function importarChave(segredo: string): Promise<CryptoKey> {
  if (typeof segredo !== "string" || segredo.length === 0) {
    throw new ErroConfiguracaoEstado("Segredo do state ausente.");
  }
  const bytes = codificador.encode(segredo);
  if (bytes.length < SEGREDO_MINIMO_BYTES) {
    // A mensagem cita o tamanho exigido, nunca o segredo.
    throw new ErroConfiguracaoEstado(
      `Segredo do state curto demais: ${bytes.length} bytes, mínimo ${SEGREDO_MINIMO_BYTES}.`
    );
  }
  return obterSubtle().importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

// ── Payload ──────────────────────────────────────────────────────────

/** Serialização determinística: ordem fixa, escrita à mão. */
function serializar(e: EstadoOAuth): string {
  const cabeca = `{"v":${e.v},"uid":${JSON.stringify(e.uid)},"intent":${JSON.stringify(e.intent)}`;
  const loja = e.intent === "reconnect" ? `,"loja":${JSON.stringify(e.loja)}` : "";
  return `${cabeca}${loja},"chal":${JSON.stringify(e.chal)},"iat":${e.iat},"exp":${e.exp}}`;
}

function inteiroPositivoValido(valor: unknown): valor is number {
  return typeof valor === "number" && Number.isSafeInteger(valor) && valor > 0;
}

function mesmasChaves(chaves: string[], esperadas: readonly string[]): boolean {
  if (chaves.length !== esperadas.length) return false;
  for (const c of esperadas) if (!chaves.includes(c)) return false;
  return true;
}

/**
 * Valida a forma do payload. `null` em qualquer desvio — fail-closed.
 *
 * A checagem de conjunto de chaves é o que faz `loja` em connect e `loja`
 * ausente em reconnect serem recusados sem nenhuma regra extra.
 */
function validarPayload(bruto: unknown): EstadoOAuth | null {
  if (typeof bruto !== "object" || bruto === null || Array.isArray(bruto)) return null;

  const registro = bruto as Record<string, unknown>;
  const chaves = Object.keys(registro);
  const { v, uid, intent, iat, exp, loja, chal } = registro;

  if (v !== VERSAO_ESTADO) return null;
  if (typeof uid !== "string" || !UUID_REGEX.test(uid)) return null;
  if (typeof chal !== "string" || !CHALLENGE_REGEX.test(chal)) return null;
  if (!inteiroPositivoValido(iat) || !inteiroPositivoValido(exp)) return null;
  if (exp <= iat) return null;
  if (exp - iat > TTL_MAXIMO_SEGUNDOS) return null;

  if (intent === "connect") {
    if (!mesmasChaves(chaves, CAMPOS_CONNECT)) return null;
    return { v, uid, intent: "connect", chal, iat, exp };
  }

  if (intent === "reconnect") {
    if (!mesmasChaves(chaves, CAMPOS_RECONNECT)) return null;
    if (typeof loja !== "string" || !UUID_REGEX.test(loja)) return null;
    return { v, uid, intent: "reconnect", loja, chal, iat, exp };
  }

  return null;
}

// ── PKCE (RFC 7636) ──────────────────────────────────────────────────

/** Prefixo do cookie que guarda o `code_verifier`. */
export const PREFIXO_COOKIE_PKCE = "ml_pkce_";

/**
 * Nome do cookie de UMA tentativa.
 *
 * O `code_challenge` entra no NOME porque ele é PÚBLICO — viaja na URL
 * de autorização, o Mercado Livre o recebe — e porque é único por
 * tentativa. Isso resolve a concorrência sem inventar identificador
 * novo: duas abas geram challenges diferentes, logo cookies diferentes,
 * e o callback acha o verifier da SUA tentativa a partir do `state` que
 * recebeu. O `code_verifier` NUNCA aparece no nome.
 */
export function nomeCookiePkce(chal: string): string {
  return PREFIXO_COOKIE_PKCE + chal;
}

/**
 * `code_verifier` conforme RFC 7636 §4.1: 32 bytes aleatórios em
 * base64url (43 caracteres, dentro da faixa 43–128 exigida), usando só
 * caracteres do conjunto `unreserved`.
 *
 * `crypto.getRandomValues` é a fonte criptográfica — nunca `Math.random`.
 */
export function gerarCodeVerifier(): string {
  const cripto = globalThis.crypto;
  if (!cripto?.getRandomValues) {
    throw new ErroConfiguracaoEstado("Web Crypto indisponível — não é possível gerar o code_verifier.");
  }
  const bytes = new Uint8Array(32);
  cripto.getRandomValues(bytes);
  return bytesParaBase64url(bytes);
}

/** `code_challenge = BASE64URL(SHA256(ASCII(code_verifier)))`, sem padding. */
export async function calcularCodeChallenge(verifier: string): Promise<string> {
  if (typeof verifier !== "string" || verifier.length < 43 || verifier.length > 128) {
    throw new ErroConfiguracaoEstado("code_verifier fora da faixa exigida pelo RFC 7636 (43–128).");
  }
  const digest = await obterSubtle().digest("SHA-256", codificador.encode(verifier));
  return bytesParaBase64url(new Uint8Array(digest));
}

/** Comparação de tempo constante — não vaza onde duas strings divergem. */
function iguaisTempoConstante(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diferenca = 0;
  for (let i = 0; i < a.length; i++) diferenca |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diferenca === 0;
}

/**
 * O verifier do cookie corresponde ao challenge do `state`?
 *
 * É o que impede parear o cookie de uma tentativa com o `state` de
 * outra. Entrada malformada devolve `false` — nunca lança.
 */
export async function verifierConfere(verifier: unknown, chal: unknown): Promise<boolean> {
  if (typeof verifier !== "string" || typeof chal !== "string") return false;
  if (!CHALLENGE_REGEX.test(chal)) return false;
  if (verifier.length < 43 || verifier.length > 128) return false;
  if (!BASE64URL_REGEX.test(verifier)) return false;
  try {
    return iguaisTempoConstante(await calcularCodeChallenge(verifier), chal);
  } catch {
    return false;
  }
}

// ── API pública ──────────────────────────────────────────────────────

export interface OpcoesAssinaturaEstado {
  segredo: string;
  /** Instante de referência, em segundos. O módulo nunca lê o relógio. */
  agoraSegundos: number;
  /** Padrão: TTL_PADRAO_SEGUNDOS. Nunca acima do teto. */
  ttlSegundos?: number;
}

export type DadosEstado =
  | { intent: "connect"; chal: string }
  | { intent: "reconnect"; loja: string; chal: string };

/**
 * Assina um `state`.
 *
 * **Lança** para uid inválido, loja inválida, instante inválido, TTL fora
 * do permitido ou segredo inadequado — todos erros de programação ou de
 * configuração, nunca entrada de usuário.
 */
export async function assinarEstado(
  uid: string,
  dados: DadosEstado,
  opcoes: OpcoesAssinaturaEstado
): Promise<string> {
  const { segredo, agoraSegundos, ttlSegundos = TTL_PADRAO_SEGUNDOS } = opcoes;

  if (typeof uid !== "string" || !UUID_REGEX.test(uid)) {
    throw new ErroConfiguracaoEstado("uid não é um UUID válido.");
  }
  if (!inteiroPositivoValido(agoraSegundos)) {
    throw new ErroConfiguracaoEstado("agoraSegundos deve ser um inteiro positivo (segundos).");
  }
  if (!inteiroPositivoValido(ttlSegundos) || ttlSegundos > TTL_MAXIMO_SEGUNDOS) {
    throw new ErroConfiguracaoEstado(`ttlSegundos deve ser inteiro positivo até ${TTL_MAXIMO_SEGUNDOS}.`);
  }
  if (dados.intent === "reconnect" && (typeof dados.loja !== "string" || !UUID_REGEX.test(dados.loja))) {
    throw new ErroConfiguracaoEstado("loja não é um UUID válido.");
  }
  if (typeof dados.chal !== "string" || !CHALLENGE_REGEX.test(dados.chal)) {
    throw new ErroConfiguracaoEstado("code_challenge ausente ou fora do formato S256/base64url.");
  }

  const estado: EstadoOAuth =
    dados.intent === "reconnect"
      ? { v: VERSAO_ESTADO, uid, intent: "reconnect", loja: dados.loja, chal: dados.chal, iat: agoraSegundos, exp: agoraSegundos + ttlSegundos }
      : { v: VERSAO_ESTADO, uid, intent: "connect", chal: dados.chal, iat: agoraSegundos, exp: agoraSegundos + ttlSegundos };

  const payloadB64 = bytesParaBase64url(codificador.encode(serializar(estado)));
  const chave = await importarChave(segredo);
  const assinatura = await obterSubtle().sign(
    "HMAC",
    chave,
    codificador.encode(CONTEXTO_ASSINATURA + payloadB64)
  );

  return `${payloadB64}.${bytesParaBase64url(new Uint8Array(assinatura))}`;
}

export interface OpcoesVerificacaoEstado {
  segredo: string;
  agoraSegundos: number;
}

/**
 * Verifica um `state`.
 *
 * Devolve `null` para QUALQUER state inválido — ausente, adulterado,
 * expirado, malformado, de outra versão, assinado com outro segredo,
 * assinado sem a separação de domínio, ou com o par intent/loja
 * inconsistente. Quem chama não precisa saber o motivo, e não deve
 * contar essa diferença para fora.
 *
 * **Lança** apenas quando o problema é de configuração.
 */
export async function verificarEstado(
  estado: unknown,
  opcoes: OpcoesVerificacaoEstado
): Promise<EstadoOAuth | null> {
  const { segredo, agoraSegundos } = opcoes;

  // A chave vem primeiro, de propósito: segredo inadequado tem de
  // estourar mesmo quando o state é lixo.
  const chave = await importarChave(segredo);

  if (!inteiroPositivoValido(agoraSegundos)) {
    throw new ErroConfiguracaoEstado("agoraSegundos deve ser um inteiro positivo (segundos).");
  }

  if (typeof estado !== "string" || estado.length === 0) return null;
  if (estado.length > TAMANHO_MAXIMO_ESTADO) return null;

  const partes = estado.split(".");
  if (partes.length !== 2) return null;

  const [payloadB64, assinaturaB64] = partes;
  if (!payloadB64 || !assinaturaB64) return null;

  const assinatura = base64urlParaBytes(assinaturaB64);
  if (!assinatura) return null;
  // HMAC-SHA-256 produz exatamente 32 bytes. Truncada ou inflada, cai aqui.
  if (assinatura.length !== 32) return null;

  // Comparação timing-safe por construção: quem compara é o `verify` do
  // Web Crypto, nunca um `===` entre assinaturas neste código.
  const assinaturaConfere = await obterSubtle().verify(
    "HMAC",
    chave,
    assinatura,
    codificador.encode(CONTEXTO_ASSINATURA + payloadB64)
  );
  if (!assinaturaConfere) return null;

  const payloadBytes = base64urlParaBytes(payloadB64);
  if (!payloadBytes) return null;

  let bruto: unknown;
  try {
    bruto = JSON.parse(decodificador.decode(payloadBytes));
  } catch {
    return null; // UTF-8 inválido ou JSON inválido
  }

  const validado = validarPayload(bruto);
  if (!validado) return null;

  // `exp` é EXCLUSIVO: no instante exato de exp o state já expirou.
  if (agoraSegundos >= validado.exp) return null;

  return validado;
}
