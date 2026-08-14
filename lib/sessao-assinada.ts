/**
 * Sessão assinada — infraestrutura criptográfica isolada (Fase 0, F0.c.1).
 *
 * ── O problema que este módulo existe para resolver ─────────────────
 * Hoje o cookie `cds_session` carrega o `user_uuid` em texto puro, sem
 * assinatura: quem souber o UUID de outra pessoa se autentica como ela.
 * Este módulo produz e verifica um token que só pode ser fabricado por
 * quem tem o segredo.
 *
 * ── ESTE MÓDULO NÃO ESTÁ EM USO ─────────────────────────────────────
 * F0.c.1 entrega apenas a peça e seus testes. Nada aqui é importado por
 * login, middleware, `lib/session.ts` ou qualquer rota — produção segue
 * exatamente com o comportamento anterior. A integração é F0.c.3, e é
 * ela que força relogin.
 *
 * ── Decisões de desenho, e o motivo de cada uma ─────────────────────
 *
 * **Uma única implementação criptográfica: Web Crypto (`crypto.subtle`).**
 * Nada de `node:crypto`, `Buffer` ou qualquer API exclusiva do Node —
 * assim o mesmo código serve às rotas (runtime Node) e ao middleware
 * (runtime Edge), sem duas versões da mesma verificação para divergirem
 * com o tempo. O preço é que assinar e verificar são assíncronos.
 *
 * **O módulo nunca lê o relógio.** `agoraSegundos` é sempre parâmetro.
 * Sem isso, testar "no instante exato de exp" viraria adivinhação. Quem
 * chama passa `Math.floor(Date.now() / 1000)`.
 *
 * **O módulo nunca lê variável de ambiente.** O segredo é parâmetro. Ele
 * não sabe o que é `SESSION_SECRET` — quem resolve isso é o chamador, na
 * etapa de integração.
 *
 * **A assinatura cobre a string transmitida**, não o JSON reserializado.
 * Verificar nunca depende de reproduzir byte a byte a serialização
 * original — um clássico de vulnerabilidade em formatos assinados.
 *
 * **Duas classes de falha, deliberadamente diferentes:**
 *   · entrada hostil (token qualquer)  → devolve `null`, em silêncio;
 *   · configuração errada (segredo curto/ausente, runtime sem Web
 *     Crypto) → **lança**. É erro de operação, tem de ser barulhento.
 *
 * **Parser estrito.** Chave a mais, tipo errado, versão desconhecida ou
 * duração acima do teto derrubam o token. Um parser permissivo é
 * exatamente o que transforma "formato válido" em "sessão aceita".
 */

/** Versão do formato. Token com outra versão é recusado. */
export const VERSAO_SESSAO = 1;

/** Algoritmo, fixo. Trocar exige subir VERSAO_SESSAO. */
export const ALGORITMO = "HMAC-SHA-256" as const;

/** 7 dias, decisão de produto (F0.c, item 2). Sem renovação deslizante. */
export const DURACAO_PADRAO_SEGUNDOS = 7 * 24 * 60 * 60;

/**
 * Teto absoluto. Vale também na VERIFICAÇÃO: um token assinado com
 * duração maior que isto é recusado mesmo com assinatura boa — impede
 * que um erro futuro no emissor produza sessão quase eterna.
 */
export const DURACAO_MAXIMA_SEGUNDOS = 7 * 24 * 60 * 60;

/** 256 bits. Segredo menor que isto é erro de configuração, não aviso. */
export const SEGREDO_MINIMO_BYTES = 32;

/**
 * Um token real tem ~150 caracteres. O teto existe para que entrada
 * hostil enorme seja descartada ANTES de qualquer decodificação.
 */
export const TAMANHO_MAXIMO_TOKEN = 512;

/** Campos obrigatórios, exatamente estes — nem a mais, nem a menos. */
const CAMPOS_OBRIGATORIOS = ["v", "uid", "iat", "exp"] as const;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64URL_REGEX = /^[A-Za-z0-9_-]+$/;

/** Conteúdo verificado de uma sessão. */
export interface SessaoVerificada {
  uid: string;
  iat: number;
  exp: number;
  v: number;
}

/** Erro de CONFIGURAÇÃO — nunca causado por entrada de usuário. */
export class ErroConfiguracaoSessao extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = "ErroConfiguracaoSessao";
  }
}

// ── Codificação (sem Buffer, para valer no Edge) ─────────────────────

const codificador = new TextEncoder();
const decodificador = new TextDecoder("utf-8", { fatal: true });

function bytesParaBase64url(bytes: Uint8Array): string {
  let binario = "";
  for (let i = 0; i < bytes.length; i++) binario += String.fromCharCode(bytes[i]);
  return btoa(binario).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Devolve null para qualquer coisa que não seja base64url bem formado. */
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

// ── Chave ────────────────────────────────────────────────────────────

function obterSubtle(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new ErroConfiguracaoSessao(
      "Web Crypto (crypto.subtle) indisponível neste runtime — sessão assinada não pode operar."
    );
  }
  return subtle;
}

async function importarChave(segredo: string): Promise<CryptoKey> {
  if (typeof segredo !== "string" || segredo.length === 0) {
    throw new ErroConfiguracaoSessao("Segredo de sessão ausente.");
  }
  const bytes = codificador.encode(segredo);
  if (bytes.length < SEGREDO_MINIMO_BYTES) {
    // A mensagem cita o tamanho exigido, nunca o segredo.
    throw new ErroConfiguracaoSessao(
      `Segredo de sessão curto demais: ${bytes.length} bytes, mínimo ${SEGREDO_MINIMO_BYTES}.`
    );
  }
  return obterSubtle().importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

// ── Payload ──────────────────────────────────────────────────────────

/**
 * Serialização determinística: ordem de chaves fixa, escrita à mão.
 * Duas assinaturas do mesmo conteúdo têm de ser idênticas byte a byte.
 */
function serializar(s: SessaoVerificada): string {
  return `{"v":${s.v},"uid":${JSON.stringify(s.uid)},"iat":${s.iat},"exp":${s.exp}}`;
}

function inteiroPositivoValido(valor: unknown): valor is number {
  return typeof valor === "number" && Number.isSafeInteger(valor) && valor > 0;
}

/** Valida a forma do payload. Null em qualquer desvio — fail-closed. */
function validarPayload(bruto: unknown): SessaoVerificada | null {
  if (typeof bruto !== "object" || bruto === null || Array.isArray(bruto)) return null;

  const chaves = Object.keys(bruto as Record<string, unknown>);
  // Estrito: campo extra derruba o token. Um payload com campo que este
  // código não entende não pode ser tratado como se fosse entendido.
  if (chaves.length !== CAMPOS_OBRIGATORIOS.length) return null;
  for (const campo of CAMPOS_OBRIGATORIOS) if (!chaves.includes(campo)) return null;

  const { v, uid, iat, exp } = bruto as Record<string, unknown>;

  if (v !== VERSAO_SESSAO) return null;
  if (typeof uid !== "string" || !UUID_REGEX.test(uid)) return null;
  if (!inteiroPositivoValido(iat) || !inteiroPositivoValido(exp)) return null;
  if (exp <= iat) return null;                              // exp == iat também é inválido
  if (exp - iat > DURACAO_MAXIMA_SEGUNDOS) return null;

  return { v, uid, iat, exp };
}

// ── API pública ──────────────────────────────────────────────────────

export interface OpcoesAssinatura {
  segredo: string;
  /** Instante de referência, em segundos. O módulo nunca lê o relógio. */
  agoraSegundos: number;
  /** Padrão: DURACAO_PADRAO_SEGUNDOS. Nunca acima do teto. */
  duracaoSegundos?: number;
}

/**
 * Assina uma sessão. Lança `ErroConfiguracaoSessao` para uid inválido,
 * instante inválido, duração fora do permitido ou segredo inadequado —
 * são erros de programação/configuração, não entrada de usuário.
 */
export async function assinarSessao(uid: string, opcoes: OpcoesAssinatura): Promise<string> {
  const { segredo, agoraSegundos, duracaoSegundos = DURACAO_PADRAO_SEGUNDOS } = opcoes;

  if (typeof uid !== "string" || !UUID_REGEX.test(uid)) {
    throw new ErroConfiguracaoSessao("uid não é um UUID válido.");
  }
  if (!inteiroPositivoValido(agoraSegundos)) {
    throw new ErroConfiguracaoSessao("agoraSegundos deve ser um inteiro positivo (segundos).");
  }
  if (!inteiroPositivoValido(duracaoSegundos) || duracaoSegundos > DURACAO_MAXIMA_SEGUNDOS) {
    throw new ErroConfiguracaoSessao(
      `duracaoSegundos deve ser inteiro positivo até ${DURACAO_MAXIMA_SEGUNDOS}.`
    );
  }

  const sessao: SessaoVerificada = {
    v: VERSAO_SESSAO,
    uid,
    iat: agoraSegundos,
    exp: agoraSegundos + duracaoSegundos,
  };

  const payloadB64 = bytesParaBase64url(codificador.encode(serializar(sessao)));
  const chave = await importarChave(segredo);
  const assinatura = await obterSubtle().sign("HMAC", chave, codificador.encode(payloadB64));

  return `${payloadB64}.${bytesParaBase64url(new Uint8Array(assinatura))}`;
}

export interface OpcoesVerificacao {
  segredo: string;
  /** Instante de referência, em segundos. */
  agoraSegundos: number;
}

/**
 * Verifica um token.
 *
 * Devolve `null` para QUALQUER token inválido — adulterado, expirado,
 * malformado, de outra versão, assinado com outro segredo. Quem chama
 * não precisa saber o motivo, e não deve contar essa diferença para
 * fora.
 *
 * Lança apenas quando o problema é de configuração (segredo inadequado
 * ou runtime sem Web Crypto).
 */
export async function verificarSessao(
  token: unknown,
  opcoes: OpcoesVerificacao
): Promise<SessaoVerificada | null> {
  const { segredo, agoraSegundos } = opcoes;

  // A chave é importada primeiro, de propósito: segredo inadequado tem
  // de estourar mesmo quando o token é lixo.
  const chave = await importarChave(segredo);

  if (!inteiroPositivoValido(agoraSegundos)) {
    throw new ErroConfiguracaoSessao("agoraSegundos deve ser um inteiro positivo (segundos).");
  }

  if (typeof token !== "string" || token.length === 0) return null;
  if (token.length > TAMANHO_MAXIMO_TOKEN) return null;

  const partes = token.split(".");
  if (partes.length !== 2) return null;

  const [payloadB64, assinaturaB64] = partes;
  if (!payloadB64 || !assinaturaB64) return null;

  const assinatura = base64urlParaBytes(assinaturaB64);
  if (!assinatura) return null;
  // HMAC-SHA-256 produz exatamente 32 bytes. Truncada ou inflada, cai aqui.
  if (assinatura.length !== 32) return null;

  const assinaturaConfere = await obterSubtle().verify(
    "HMAC",
    chave,
    assinatura,
    codificador.encode(payloadB64)
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

  const sessao = validarPayload(bruto);
  if (!sessao) return null;

  // `exp` é EXCLUSIVO: no instante exato de exp a sessão já expirou.
  if (agoraSegundos >= sessao.exp) return null;

  return sessao;
}
