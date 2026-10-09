/**
 * Gerenciamento de token Shopee com refresh automático.
 * Access token expira em ~4h. Refresh token dura 30 dias.
 */
import { shopeeSign, SHOPEE_BASE } from "@/lib/shopee-api";
import { randomUUID } from "crypto";
import { nomeExibicaoDaLoja } from "@/lib/lojas/identidade";
import {
  lerCredencialShopeeDoDono,
  gravarCredencialShopee,
  adquirirLeaseRefreshShopee,
  liberarLeaseRefreshShopee,
  LEASE_REFRESH_SHOPEE_TTL_S,
  type LinhaCredencialShopee,
  type ResultadoLeaseShopee,
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
  portas: PortasRenovacaoShopee,
  leituras: number = MAX_LEITURAS_DE_RECUPERACAO_SHOPEE,
  esperaMs: number = ESPERA_ENTRE_LEITURAS_SHOPEE_MS
): Promise<{ accessToken: string } | null> {
  const agora = portas.agoraMs ?? (() => Date.now());
  const esperar = portas.esperar ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let leitura = 1; leitura <= leituras; leitura++) {
    const atual = await portas.reler();
    if (atual !== null && vencedoraShopeeUtilizavel(atual, refreshObservado, agora())) {
      return { accessToken: atual.access_token as string };
    }
    if (leitura < leituras) await esperar(esperaMs);
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

// ── Lease distribuído ANTES do provider (SALES-SYNC-C4) ─────────────
//
// O CAS acima resolve a corrida NO BANCO, mas acontece depois da chamada
// à Shopee. O lease (public.credencial_refresh_lease, relógio do banco)
// garante no máximo UMA chamada de refresh em andamento por loja entre
// instâncias. Fluxo: lease → RELER → (só se ainda precisa) provider →
// CAS → liberar no finally. Lease ocupado NUNCA vira "reconecte".

/** Lease ocupado: espera limitada (~2,5 s) pela vencedora — nunca um segundo refresh. */
const MAX_LEITURAS_LEASE_OCUPADO = 6;
const ESPERA_LEASE_OCUPADO_MS = 500;

export interface PortasLeaseShopee {
  adquirirLease(portador: string): Promise<ResultadoLeaseShopee>;
  liberarLease(portador: string): Promise<boolean>;
  /** Portador opaco por tentativa (padrão: UUID aleatório). */
  novoPortador?(): string;
}

export type ResultadoRenovacaoShopee =
  | { ok: true; accessToken: string }
  /**
   * refresh_em_andamento = outra execução detém o lease (transitório, NÃO reconectar);
   * lease_indisponivel   = infraestrutura do lease ausente/falhou no modo canônico
   *                        (transitório, de infra — não da conta);
   * loja_ou_dono_invalido / credencial_indisponivel = indisponibilidade REAL.
   */
  | { ok: false; motivo: "refresh_em_andamento" | "lease_indisponivel" | "loja_ou_dono_invalido" | "credencial_indisponivel" };

/**
 * Modo da renovação (SALES-SYNC-C6):
 *   canonico   — worker automático: lease ausente/erro = FAIL-CLOSED
 *                (lease_indisponivel, provider NUNCA chamado; sem CAS-only);
 *   compativel — callers legados/manuais: comportamento do C4 preservado
 *                (RPC ausente → modo C3, só CAS; erro do banco → tratado
 *                como ocupado, sem chamar o provider).
 */
export type ModoAuthShopee = "canonico" | "compativel";

const comoResultado = (r: { accessToken: string } | null): ResultadoRenovacaoShopee =>
  r ? { ok: true, accessToken: r.accessToken } : { ok: false, motivo: "credencial_indisponivel" };

export async function renovarShopeeComLease(
  lojaId: string,
  refreshObservado: string,
  portas: PortasRenovacaoShopee & PortasLeaseShopee,
  opcoes: { modo?: ModoAuthShopee } = {}
): Promise<ResultadoRenovacaoShopee> {
  const modo = opcoes.modo ?? "compativel";
  const agora = portas.agoraMs ?? (() => Date.now());
  const portador = portas.novoPortador?.() ?? randomUUID();
  const resultadoLease = await portas.adquirirLease(portador);

  if (resultadoLease === "LOJA_OU_DONO_INVALIDO") {
    // O banco recusou o par loja/dono: indisponibilidade REAL, nunca "em andamento".
    console.log("[shopee-auth] SHOPEE_LEASE_INVALID_STORE_OR_OWNER loja:", lojaId);
    return { ok: false, motivo: "loja_ou_dono_invalido" };
  }
  if (modo === "canonico" && (resultadoLease === "INDISPONIVEL" || resultadoLease === "ERRO")) {
    // Worker automático: sem lease confiável NÃO há refresh (nem CAS-only). Transitório de infra.
    console.log("[shopee-auth] SHOPEE_LEASE_UNAVAILABLE loja:", lojaId);
    return { ok: false, motivo: "lease_indisponivel" };
  }
  // compatível: erro do banco segue o comportamento do C4 (= ocupado)
  const lease = resultadoLease === "ERRO" ? "OCUPADO" : resultadoLease;

  if (lease === "OCUPADO") {
    // Outra execução está renovando: NÃO chamar o provider; esperar (limitado) a vencedora.
    const vencedora = await procurarVencedoraShopee(lojaId, refreshObservado, portas, MAX_LEITURAS_LEASE_OCUPADO, ESPERA_LEASE_OCUPADO_MS);
    console.log(`[shopee-auth] ${vencedora ? "LEASE_BUSY_REUSED_WINNER" : "LEASE_BUSY"} loja:`, lojaId);
    return vencedora ? { ok: true, accessToken: vencedora.accessToken } : { ok: false, motivo: "refresh_em_andamento" };
  }

  if (lease === "INDISPONIVEL") {
    // RPC ausente (migration não aplicada/revertida): modo C3 — CAS sem lease, já seguro no banco.
    console.log("[shopee-auth] LEASE_UNAVAILABLE_FALLBACK_CAS loja:", lojaId);
    return comoResultado(await renovarShopeeComCas(lojaId, refreshObservado, portas));
  }

  try {
    // RELER antes do provider: outra execução pode ter renovado entre a
    // nossa leitura e a aquisição do lease.
    const atual = await portas.reler();
    if (!atual) return { ok: false, motivo: "credencial_indisponivel" };
    if (atual.access_token && !precisaRenovarShopee(atual, agora())) {
      console.log("[shopee-auth] LEASE_REREAD_ALREADY_FRESH loja:", lojaId);
      return { ok: true, accessToken: atual.access_token };
    }
    if (!atual.refresh_token) return { ok: false, motivo: "credencial_indisponivel" };
    // O CAS parte do refresh_token VIGENTE (pode ter rotacionado e vencido de novo).
    return comoResultado(await renovarShopeeComCas(lojaId, atual.refresh_token, portas));
  } finally {
    try { await portas.liberarLease(portador); } catch { /* a expiração devolve a loja */ }
  }
}

/**
 * Pontos de injeção (SALES-SYNC-C6): em produção TODOS ficam vazios e as
 * portas usam o banco real e o endpoint oficial; a suíte injeta o duplo do
 * banco e o provider falso para exercitar o código REAL do resolvedor.
 */
export interface InjecaoAuthShopee {
  cliente?: any;
  renovar?: (refreshToken: string) => Promise<ShopeeTokenResult | null>;
  esperar?: (ms: number) => Promise<void>;
  agoraMs?: () => number;
  novoPortador?: () => string;
}

/** Portas reais: endpoint oficial + CAS em `lojas` + lease no banco + releitura da MESMA loja do dono. */
function portasReaisShopee(loja: LinhaCredencialShopee, userId: string, inj: InjecaoAuthShopee = {}): PortasRenovacaoShopee & PortasLeaseShopee {
  return {
    renovar: inj.renovar ?? ((rt) => refreshShopeeToken(loja.partner_id as string, loja.partner_key as string, Number(loja.shop_id), rt)),
    gravarCas: (campos, anterior) => gravarCredencialShopee(loja.id, userId, campos, anterior, inj.cliente),
    reler: async () => (await lerCredencialShopeeDoDono(userId, loja.id, inj.cliente)).linha,
    adquirirLease: (portador) => adquirirLeaseRefreshShopee(loja.id, userId, portador, inj.cliente),
    liberarLease: (portador) => liberarLeaseRefreshShopee(loja.id, userId, portador, inj.cliente),
    ...(inj.esperar ? { esperar: inj.esperar } : {}),
    ...(inj.agoraMs ? { agoraMs: inj.agoraMs } : {}),
    ...(inj.novoPortador ? { novoPortador: inj.novoPortador } : {}),
  };
}

// ── Contrato DETALHADO da credencial Shopee (SALES-SYNC-C6) ──────────
//
// Fonte de verdade de TODA resolução de credencial Shopee. Os getters
// públicos (credencial | null) são invólucros finos sobre ele; o worker
// canônico o usa direto para separar contenção/infra (transitório,
// retomável) de indisponibilidade real (erro de auth).

export interface CredencialShopee {
  lojaId:      string;
  partnerId:   string;
  partnerKey:  string;
  accessToken: string;
  shopId:      number;
  nickname:    string;
}

export type MotivoCredencialIndisponivelShopee =
  | "erro_leitura" | "loja_nao_encontrada" | "sem_partner" | "sem_access_token" | "refresh_falhou" | "loja_ou_dono_invalido";

export type ResultadoCredencialShopee =
  | { status: "OK"; credencial: CredencialShopee }
  /** Outra execução está renovando (lease ocupado): transitório. NÃO é preciso reconectar. */
  | { status: "REFRESH_EM_ANDAMENTO"; retryAfterMs: number }
  /** Infra do lease ausente/falhou no modo canônico: transitório de infra, não da conta. */
  | { status: "LEASE_INDISPONIVEL"; retryAfterMs: number }
  /** Indisponibilidade REAL — só este caminho leva a "reconecte". */
  | { status: "CREDENCIAL_INDISPONIVEL"; motivo: MotivoCredencialIndisponivelShopee };

/** Depois de quanto tempo vale tentar de novo: o lease vence sozinho em LEASE_TTL. */
const RETRY_REFRESH_EM_ANDAMENTO_MS = LEASE_REFRESH_SHOPEE_TTL_S * 1000;
const RETRY_LEASE_INDISPONIVEL_MS = 60_000;

export async function resolverCredencialShopee(
  userId: string,
  /** null = "a mais recente ATIVA" do dono (semântica de getShopeeLojaAtiva). */
  lojaId: string | null,
  modo: ModoAuthShopee,
  inj: InjecaoAuthShopee = {}
): Promise<ResultadoCredencialShopee> {
  const rotulo = lojaId ? " (getShopeeLojaById)" : "";
  const indisponivel = (motivo: MotivoCredencialIndisponivelShopee): ResultadoCredencialShopee => {
    console.log(`[shopee-auth] SHOPEE_CREDENTIAL_UNAVAILABLE${rotulo} motivo:`, motivo);
    return { status: "CREDENCIAL_INDISPONIVEL", motivo };
  };

  const { linha: loja, erro: dbErr } = await lerCredencialShopeeDoDono(userId, lojaId, inj.cliente);
  if (dbErr) {
    console.error(`[shopee-auth] db error${rotulo}:`, dbErr, lojaId ? `lojaId: ${lojaId}` : `userId: ${userId}`);
    return indisponivel("erro_leitura");
  }
  if (!loja) {
    console.error(`[shopee-auth] loja não encontrada${rotulo}:`, lojaId ?? `userId ${userId}`);
    return indisponivel("loja_nao_encontrada");
  }
  if (!loja.partner_id || !loja.partner_key) {
    console.error("[shopee-auth] loja sem partner_id/partner_key:", loja.id);
    return indisponivel("sem_partner");
  }

  // `?? ""` preserva o comportamento anterior: a variável era tipada como
  // `string` mas podia chegar nula; string vazia é falsy do mesmo modo.
  let accessToken: string = loja.access_token ?? "";

  // Verifica se token expirou (com 5 min de margem). `loja` veio de uma
  // leitura com marketplace = 'Shopee' (filtrosShopeeDoDono): o id que vai
  // para o lease é SEMPRE de loja Shopee do dono.
  const expiredOrMissing = precisaRenovarShopee(loja, inj.agoraMs?.() ?? Date.now());

  if (expiredOrMissing && loja.refresh_token) {
    console.log("[shopee-auth] token expirado, tentando refresh para loja:", loja.id);
    // SALES-SYNC-C4: lease distribuído → reler → provider → CAS (C3) → liberar.
    const renovada = await renovarShopeeComLease(loja.id, loja.refresh_token, portasReaisShopee(loja, userId, inj), { modo });
    if (!renovada.ok) {
      if (renovada.motivo === "refresh_em_andamento") {
        console.error(`[shopee-auth] SHOPEE_REFRESH_IN_PROGRESS — refresh em andamento por outra execução${rotulo} para loja:`, loja.id, "- tente novamente (NÃO é preciso reconectar)");
        return { status: "REFRESH_EM_ANDAMENTO", retryAfterMs: RETRY_REFRESH_EM_ANDAMENTO_MS };
      }
      if (renovada.motivo === "lease_indisponivel") {
        console.error(`[shopee-auth] SHOPEE_LEASE_UNAVAILABLE — lease de refresh indisponível${rotulo} para loja:`, loja.id, "- infraestrutura, NÃO é preciso reconectar");
        return { status: "LEASE_INDISPONIVEL", retryAfterMs: RETRY_LEASE_INDISPONIVEL_MS };
      }
      // Sem credencial utilizável → não tenta usar token inválido.
      console.error(`[shopee-auth] refresh FALHOU${rotulo} para loja:`, loja.id, "- reconecte a Shopee");
      return indisponivel(renovada.motivo === "loja_ou_dono_invalido" ? "loja_ou_dono_invalido" : "refresh_falhou");
    }
    accessToken = renovada.accessToken;
  }

  if (!accessToken) {
    console.error("[shopee-auth] sem accessToken para loja:", loja.id, "expirado:", expiredOrMissing, "tem_refresh:", !!loja.refresh_token);
    return indisponivel("sem_access_token");
  }

  console.log("[shopee-auth] SHOPEE_AUTH_OK loja:", loja.id);
  return {
    status: "OK",
    credencial: {
      lojaId:     loja.id,
      partnerId:  loja.partner_id,
      partnerKey: loja.partner_key,
      accessToken,
      shopId:     Number(loja.shop_id),
      nickname:   nomeExibicaoDaLoja({ nickname: loja.nickname, marketplace: "Shopee", shop_id: loja.shop_id }),
    },
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
  // SALES-SYNC-C6: invólucro fino e COMPATÍVEL (credencial | null) sobre o
  // contrato detalhado — mesma lógica de leitura, lease, CAS e logs.
  const r = await resolverCredencialShopee(userId, null, "compativel");
  return r.status === "OK" ? r.credencial : null;
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
  // SALES-SYNC-C6: invólucro fino e COMPATÍVEL (credencial | null) sobre o
  // contrato detalhado — mesma lógica de leitura, lease, CAS e logs.
  const r = await resolverCredencialShopee(userId, lojaId, "compativel");
  return r.status === "OK" ? r.credencial : null;
}
