/**
 * Gerenciamento de token Shopee com refresh automático.
 * Access token expira em ~4h. Refresh token dura 30 dias.
 */
import { shopeeSign, SHOPEE_BASE } from "@/lib/shopee-api";
import {
  lerCredencialShopeeDoDono,
  gravarCredencialShopee,
  type LinhaCredencialShopee,
} from "@/lib/marketplace/credenciais";

export interface ShopeeTokenResult {
  access_token: string;
  refresh_token?: string;
  expire_in?: number;
}

// ── Renovação concorrente-segura (SALES-SYNC-C3) ────────────────────
//
// Mesmo princípio do ML (`renovarComCas` em lib/ml-auth.ts), adaptado ao
// formato Shopee: o banco decide quem venceu a rotação via
// compare-and-swap sobre o `refresh_token` LIDO; quem perde — porque o
// CAS não casou, ou porque o endpoint recusou um refresh_token que outra
// execução já consumiu — RELÊ a loja e usa a credencial vencedora.
// Nada de mutex em memória: instâncias serverless diferentes não o
// compartilhariam; a proteção é a condição do UPDATE.

/** Margem de expiração da Shopee (inalterada): 5 min. */
const MARGEM_SHOPEE_MS = 5 * 60 * 1000;
const MAX_LEITURAS_DE_RECUPERACAO_SHOPEE = 2;
const ESPERA_ENTRE_LEITURAS_SHOPEE_MS = 150;

/**
 * A loja precisa renovar? Semântica PRESERVADA do fluxo anterior: sem
 * access_token, ou com validade dentro da margem. (`token_expires_at`
 * ausente com access_token presente continua sendo "não renovar".)
 */
export function precisaRenovarShopee(
  linha: Pick<LinhaCredencialShopee, "access_token" | "token_expires_at">,
  agoraMs: number = Date.now()
): boolean {
  return !linha.access_token ||
    (!!linha.token_expires_at && new Date(linha.token_expires_at).getTime() - MARGEM_SHOPEE_MS < agoraMs);
}

/**
 * A linha relida prova que OUTRA execução venceu a rotação? Exige
 * refresh_token DIFERENTE do observado (evidência de rotação) e credencial
 * utilizável (access_token presente, validade conhecida e fora da margem).
 * Conservador como o ML: sem rotação comprovada, não há vencedora.
 */
export function vencedoraShopeeUtilizavel(
  linha: Pick<LinhaCredencialShopee, "access_token" | "refresh_token" | "token_expires_at">,
  refreshObservado: string,
  agoraMs: number = Date.now()
): boolean {
  if (!linha.access_token || !linha.refresh_token) return false;
  if (linha.refresh_token === refreshObservado) return false;
  if (!linha.token_expires_at) return false;
  const vence = new Date(linha.token_expires_at).getTime();
  return Number.isFinite(vence) && vence - MARGEM_SHOPEE_MS >= agoraMs;
}

/** Portas da renovação — reais em produção, dublês na suíte. */
export interface PortasRenovacaoShopee {
  /** Chama o endpoint de refresh da Shopee com este refresh_token. */
  renovar(refreshToken: string): Promise<ShopeeTokenResult | null>;
  /** UPDATE condicional (CAS sobre `refreshAnterior`); true = esta execução venceu. */
  gravarCas(campos: { access_token: string; refresh_token: string; token_expires_at: string }, refreshAnterior: string): Promise<boolean>;
  /** Releitura CRUA da mesma loja, fechada no dono. NUNCA renova. */
  reler(): Promise<Pick<LinhaCredencialShopee, "access_token" | "refresh_token" | "token_expires_at"> | null>;
  esperar?(ms: number): Promise<void>;
  agoraMs?(): number;
}

async function procurarVencedoraShopee(
  lojaId: string,
  refreshObservado: string,
  portas: PortasRenovacaoShopee
): Promise<{ accessToken: string } | null> {
  const agora = portas.agoraMs ?? (() => Date.now());
  const esperar = portas.esperar ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let leitura = 1; leitura <= MAX_LEITURAS_DE_RECUPERACAO_SHOPEE; leitura++) {
    const atual = await portas.reler();
    if (atual !== null && vencedoraShopeeUtilizavel(atual, refreshObservado, agora())) {
      return { accessToken: atual.access_token as string };
    }
    if (leitura < MAX_LEITURAS_DE_RECUPERACAO_SHOPEE) await esperar(ESPERA_ENTRE_LEITURAS_SHOPEE_MS);
  }
  return null;
}

/**
 * Renova a credencial Shopee com COMPARE-AND-SWAP.
 *
 *   refresh OK  + CAS casou (1 linha)  → CAS_WON: usa o par novo
 *   refresh OK  + CAS 0 linhas         → CAS_LOST: relê; usa a vencedora
 *                                        (o par recebido NUNCA é gravado)
 *   refresh FALHOU                     → relê; se outra execução já
 *                                        rotacionou, usa a vencedora
 *                                        (REFRESH_FAILED_REUSED_WINNER);
 *                                        senão `null` (falha real)
 *
 * Logs só com o id técnico da loja — nunca token, segredo ou comprador.
 */
export async function renovarShopeeComCas(
  lojaId: string,
  refreshObservado: string,
  portas: PortasRenovacaoShopee
): Promise<{ accessToken: string } | null> {
  const agora = portas.agoraMs ?? (() => Date.now());
  const renovado = await portas.renovar(refreshObservado);

  if (!renovado?.access_token) {
    const vencedora = await procurarVencedoraShopee(lojaId, refreshObservado, portas);
    console.log(`[shopee-auth] ${vencedora ? "REFRESH_FAILED_REUSED_WINNER" : "REFRESH_FAILED"} loja:`, lojaId);
    return vencedora;
  }

  const gravou = await portas.gravarCas({
    access_token: renovado.access_token,
    refresh_token: renovado.refresh_token ?? refreshObservado,
    token_expires_at: new Date(agora() + (renovado.expire_in ?? 14400) * 1000).toISOString(),
  }, refreshObservado);
  if (gravou) {
    console.log("[shopee-auth] CAS_WON loja:", lojaId);
    return { accessToken: renovado.access_token };
  }

  console.log("[shopee-auth] CAS_LOST loja:", lojaId);
  return procurarVencedoraShopee(lojaId, refreshObservado, portas);
}

/** Portas reais: endpoint oficial + CAS em `lojas` + releitura da MESMA loja do dono. */
function portasReaisShopee(loja: LinhaCredencialShopee, userId: string): PortasRenovacaoShopee {
  return {
    renovar: (rt) => refreshShopeeToken(loja.partner_id as string, loja.partner_key as string, Number(loja.shop_id), rt),
    gravarCas: (campos, anterior) => gravarCredencialShopee(loja.id, userId, campos, anterior),
    reler: async () => (await lerCredencialShopeeDoDono(userId, loja.id)).linha,
  };
}

/**
 * Tenta fazer refresh do access token usando o refresh_token.
 * Retorna o novo access_token ou null se falhou.
 */
export async function refreshShopeeToken(
  partnerId: string,
  partnerKey: string,
  shopId: number,
  refreshToken: string
): Promise<ShopeeTokenResult | null> {
  try {
    const path      = "/api/v2/auth/access_token/get";
    const timestamp = Math.floor(Date.now() / 1000);
    const sign      = shopeeSign(partnerId, partnerKey, path, timestamp);

    const refreshCtrl = new AbortController();
    const refreshTimer = setTimeout(() => refreshCtrl.abort(), 8000); // 8s timeout
    let res: Response;
    try {
      res = await fetch(
        `${SHOPEE_BASE}${path}?partner_id=${partnerId}&timestamp=${timestamp}&sign=${sign}`,
        {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({
            shop_id:       shopId,
            refresh_token: refreshToken,
            partner_id:    Number(partnerId),
          }),
          signal: refreshCtrl.signal,
        }
      );
    } catch {
      clearTimeout(refreshTimer);
      return null; // timeout ou erro de rede no refresh
    }
    clearTimeout(refreshTimer);

    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.access_token) return null;

    return {
      access_token:  data.access_token,
      refresh_token: data.refresh_token ?? refreshToken,
      expire_in:     data.expire_in ?? 14400,
    };
  } catch {
    return null;
  }
}

/**
 * Busca loja Shopee ativa do usuário e garante token válido.
 * Faz refresh automático se o token estiver expirado.
 * Retorna os dados da loja com access_token garantido, ou null.
 */
export async function getShopeeLojaAtiva(userId: string): Promise<{
  lojaId:      string;
  partnerId:   string;
  partnerKey:  string;
  accessToken: string;
  shopId:      number;
  nickname:    string;
} | null> {
  const { linha: loja, erro: dbErr } = await lerCredencialShopeeDoDono(userId);

  if (dbErr) {
    console.error("[shopee-auth] db error:", dbErr, "userId:", userId);
    return null;
  }
  if (!loja) {
    console.error("[shopee-auth] loja não encontrada para userId:", userId);
    return null;
  }
  if (!loja.partner_id || !loja.partner_key) {
    console.error("[shopee-auth] loja sem partner_id/partner_key:", loja.id);
    return null;
  }

  // `?? ""` preserva o comportamento anterior: a variável era tipada como
  // `string` mas podia chegar nula, e a guarda `if (!accessToken)` adiante
  // tratava isso. String vazia é falsy do mesmo modo.
  let accessToken: string = loja.access_token ?? "";

  // Verifica se token expirou (com 5 min de margem)
  const expiredOrMissing = precisaRenovarShopee(loja);

  if (expiredOrMissing && loja.refresh_token) {
    console.log("[shopee-auth] token expirado, tentando refresh para loja:", loja.id);
    // SALES-SYNC-C3: CAS sobre o refresh_token lido + releitura da vencedora.
    const renovada = await renovarShopeeComCas(loja.id, loja.refresh_token, portasReaisShopee(loja, userId));
    if (renovada) {
      accessToken = renovada.accessToken;
    } else {
      // Refresh falhou e nenhuma execução concorrente rotacionou → token
      // expirado e não renovável → não tenta usar token inválido
      console.error("[shopee-auth] refresh FALHOU para loja:", loja.id, "- reconecte a Shopee");
      return null;
    }
  }

  if (!accessToken) {
    console.error("[shopee-auth] sem accessToken para loja:", loja.id, "expirado:", expiredOrMissing, "tem_refresh:", !!loja.refresh_token);
    return null;
  }

  return {
    lojaId:     loja.id,
    partnerId:  loja.partner_id,
    partnerKey: loja.partner_key,
    accessToken,
    shopId:     Number(loja.shop_id),
    nickname:   loja.nickname ?? `Shopee ${loja.shop_id}`,
  };
}

/**
 * Busca uma loja Shopee específica pelo id (não "a mais recente ativa").
 * Adicionado 2026-07-11 para o worker de sincronização (sync_jobs) poder
 * sincronizar exatamente a loja do job, mesmo quando o usuário tem mais
 * de uma loja Shopee — getShopeeLojaAtiva sempre resolveria para a mais
 * recente, o que quebraria o contrato "job por loja_id específico".
 * Mesma lógica de refresh de token de getShopeeLojaAtiva, sem o filtro
 * "mais recente ativa".
 *
 * ── PR #1: `userId` passou a ser OBRIGATÓRIO ────────────────────────
 * Esta função consultava `lojas` SÓ por `id` e devolvia `partnerKey` (o
 * app secret da Shopee) além do access_token. O par agora entra na
 * query: par incoerente devolve `null` em vez de credencial alheia. O
 * critério de seleção da loja não mudou.
 */
export async function getShopeeLojaById(lojaId: string, userId: string): Promise<{
  lojaId:      string;
  partnerId:   string;
  partnerKey:  string;
  accessToken: string;
  shopId:      number;
  nickname:    string;
} | null> {
  const { linha: loja, erro: dbErr } = await lerCredencialShopeeDoDono(userId, lojaId);

  if (dbErr) {
    console.error("[shopee-auth] db error (getShopeeLojaById):", dbErr, "lojaId:", lojaId);
    return null;
  }
  if (!loja) {
    console.error("[shopee-auth] loja não encontrada (getShopeeLojaById):", lojaId);
    return null;
  }
  if (!loja.partner_id || !loja.partner_key) {
    console.error("[shopee-auth] loja sem partner_id/partner_key:", loja.id);
    return null;
  }

  // `?? ""` preserva o comportamento anterior: a variável era tipada como
  // `string` mas podia chegar nula, e a guarda `if (!accessToken)` adiante
  // tratava isso. String vazia é falsy do mesmo modo.
  let accessToken: string = loja.access_token ?? "";

  const expiredOrMissing = precisaRenovarShopee(loja);

  if (expiredOrMissing && loja.refresh_token) {
    // SALES-SYNC-C3: CAS sobre o refresh_token lido + releitura da vencedora.
    const renovada = await renovarShopeeComCas(loja.id, loja.refresh_token, portasReaisShopee(loja, userId));
    if (renovada) {
      accessToken = renovada.accessToken;
    } else {
      console.error("[shopee-auth] refresh FALHOU (getShopeeLojaById) para loja:", loja.id, "- reconecte a Shopee");
      return null;
    }
  }

  if (!accessToken) return null;

  return {
    lojaId:     loja.id,
    partnerId:  loja.partner_id,
    partnerKey: loja.partner_key,
    accessToken,
    shopId:     Number(loja.shop_id),
    nickname:   loja.nickname ?? `Shopee ${loja.shop_id}`,
  };
}
