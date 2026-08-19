import { createClient } from "@supabase/supabase-js";
import {
  lerCredencialMLPorLojaEDono,
  lerCredencialMLAtivaDoDono,
  gravarCredencialML,
} from "@/lib/marketplace/credenciais";

/**
 * Cliente ANON — menor privilégio, e é tudo de que `resolverLojaDoUsuario`
 * precisa: ela lê APENAS `id`, nunca uma coluna de credencial. Dar-lhe
 * service_role seria privilégio gratuito.
 *
 * Toda leitura ou escrita de credencial deste módulo passa por
 * `lib/marketplace/credenciais.ts` — ver a invariante lá.
 */
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") || "";
  const entry = header.split("; ").find(c => c.startsWith(`${name}=`));
  return entry ? entry.slice(name.length + 1) : null;
}

export interface MLTokenResult {
  token: string;
  newAccessToken?: string;
  newRefreshToken?: string;
  expires?: number;
  lojaId?: string;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A loja indicada pelo cookie pertence a este usuário?
 *
 * Devolve o id só quando a linha existe, é de marketplace ML e tem
 * `user_id` igual ao da sessão. Loja de outro dono, loja órfã
 * (`user_id NULL`), loja de outro marketplace, id inexistente e id
 * malformado produzem o MESMO resultado: `null`. Quem chama não
 * consegue distinguir os casos, então não há enumeração.
 */
async function resolverLojaDoUsuario(lojaIdBruto: string, userId: string): Promise<string | null> {
  if (!UUID_REGEX.test(lojaIdBruto)) return null;

  const { data } = await supabase
    .from("lojas")
    .select("id")
    .eq("id", lojaIdBruto)
    .eq("user_id", userId)
    .eq("marketplace", "ML")
    .maybeSingle();

  return data?.id ?? null;
}

/**
 * Tenta obter um token ML válido, com fallback para refresh automático.
 *
 * ── ISOLAMENTO DE PROPRIEDADE (F0.c.4) ──────────────────────────────
 * `userId` é OBRIGATÓRIO e vem da sessão — nunca do cliente. Antes desta
 * correção, a função resolvia a loja apenas por `loja_ativa_id`, um
 * cookie que qualquer cliente pode enviar com qualquer valor, e
 * consultava `lojas` só por `id`. Um usuário autenticado que informasse
 * o id da loja de outro recebia o **token de Mercado Livre alheio** — e,
 * pelo caminho de refresh, ainda **sobrescrevia os tokens daquela loja**
 * no banco.
 *
 * Agora a propriedade é validada UMA vez, antes de qualquer uso, e o
 * fracasso é fechado: cookie apontando para loja que não é do usuário
 * não cai em outra loja nem segue adiante — devolve `null`, e a rota
 * responde o mesmo "Conta do ML não conectada" de sempre.
 */
export async function getMLToken(request: Request, userId: string): Promise<MLTokenResult | null> {
  if (!userId) return null;

  const lojaIdCookie = getCookie(request, "loja_ativa_id");
  let lojaId: string | null = null;
  if (lojaIdCookie) {
    lojaId = await resolverLojaDoUsuario(lojaIdCookie, userId);
    // Loja declarada mas não pertencente ao usuário: nega tudo. Ignorar o
    // cookie e seguir seria aceitar uma tentativa de usar loja alheia.
    if (!lojaId) return null;
  }

  // 1. Cookie ml_access_token presente → usa direto
  const existing = getCookie(request, "ml_access_token");
  if (existing) return { token: existing };

  const refreshCookie = getCookie(request, "ml_refresh_token");

  // 2. Tenta refresh pelo cookie ml_refresh_token
  if (refreshCookie) {
    const result = await refreshMLToken(refreshCookie);
    if (result) {
      // Só grava na loja já validada como do usuário.
      if (lojaId) await saveTokensToDB(lojaId, userId, result);
      return { ...result, lojaId: lojaId ?? undefined };
    }
  }

  // 3. Fallback: lê access_token/refresh_token do banco pela loja ativa
  if (lojaId) {
    const { linha: loja } = await lerCredencialMLPorLojaEDono(lojaId, userId);

    if (loja?.access_token && new Date(loja.token_expires_at as string) > new Date()) {
      // Token do banco ainda válido → usa e re-emite o cookie
      return { token: loja.access_token, newAccessToken: loja.access_token, lojaId };
    }

    if (loja?.refresh_token) {
      const result = await refreshMLToken(loja.refresh_token);
      if (result) {
        await saveTokensToDB(lojaId, userId, result);
        return { ...result, lojaId };
      }
    }
  }

  return null;
}

/**
 * Margem aplicada à expiração: um token que vence em menos de 5 minutos é
 * tratado como já vencido, para não iniciar uma chamada ao ML que expira
 * no meio. Valor extraído de `getMLLojaAtiva`/`getMLLojaById`, que já
 * usavam exatamente `5 * 60 * 1000` — aqui ele ganha um nome só.
 */
export const MARGEM_EXPIRACAO_SEGUNDOS = 300;

/**
 * A credencial precisa ser renovada? (F0.c.5-A)
 *
 * DIFERENÇA DELIBERADA EM RELAÇÃO AO LEGADO: `token_expires_at` ausente
 * conta como **expirado**. As funções antigas fazem
 * `const expired = loja.token_expires_at && …`, o que trata "não sei
 * quando vence" como "ainda vale" e usa um token possivelmente morto. Sem
 * data não há como afirmar validade, e a resposta segura é renovar.
 *
 * As chamadas antigas NÃO foram reescritas nesta etapa: mudá-las alteraria
 * o comportamento de rotas que a F0.c.5-A não deve tocar (§14). A migração
 * delas é das fases seguintes.
 */
export function credencialExpirada(
  tokenExpiresAt: string | null | undefined,
  agoraMs: number = Date.now()
): boolean {
  if (!tokenExpiresAt) return true;
  const vence = new Date(tokenExpiresAt).getTime();
  if (!Number.isFinite(vence)) return true;
  return vence - MARGEM_EXPIRACAO_SEGUNDOS * 1000 < agoraMs;
}

/**
 * `export` acrescentado em F0.c.5-A. O corpo é o mesmo — o resolvedor novo
 * (`lib/ml-conexao.ts`) precisa do MESMO refresh, e não de uma segunda
 * implementação que possa divergir desta.
 */
export async function refreshMLToken(refreshToken: string): Promise<MLTokenResult | null> {
  try {
    const res = await fetch("https://api.mercadolibre.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type:    "refresh_token",
        client_id:     process.env.ML_CLIENT_ID!.trim(),
        client_secret: process.env.ML_CLIENT_SECRET!.trim(),
        refresh_token: refreshToken,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.access_token) return null;
    return {
      token:           data.access_token,
      newAccessToken:  data.access_token,
      newRefreshToken: data.refresh_token ?? refreshToken,
      expires:         data.expires_in ?? 21600,
    };
  } catch {
    return null;
  }
}

/**
 * Grava a credencial renovada. `export` e o 3º parâmetro foram
 * acrescentados em F0.c.5-A; os 4 chamadores antigos continuam passando 2
 * argumentos e ignorando o retorno, então o comportamento deles é idêntico.
 *
 * `refreshTokenAnterior` liga uma escrita CONDICIONAL (compare-and-swap):
 * só grava se a linha ainda contiver o refresh_token de onde partimos. É a
 * proteção contra sobrescrita cega quando duas requisições renovam a mesma
 * loja ao mesmo tempo — usando as colunas que já existem, sem migration.
 * Devolve `false` quando nada foi gravado porque outra requisição chegou
 * primeiro; quem chama deve reler a linha em vez de reescrever por cima.
 *
 * `userId` acrescentado na PR #1 e OBRIGATÓRIO: a escrita passa a ser
 * `id + user_id`, nunca só `id`. O filtro soma-se ao CAS sem alterá-lo.
 */
export async function saveTokensToDB(
  lojaId: string,
  userId: string,
  result: MLTokenResult,
  refreshTokenAnterior?: string | null
): Promise<boolean> {
  const updates: Record<string, unknown> = {
    access_token:     result.newAccessToken,
    token_expires_at: new Date(Date.now() + (result.expires ?? 21600) * 1000).toISOString(),
  };
  if (result.newRefreshToken) updates.refresh_token = result.newRefreshToken;

  return gravarCredencialML(lojaId, userId, updates, refreshTokenAnterior);
}

/** Busca loja ML ativa pelo userId (para sync server-side sem cookie) */
export async function getMLLojaAtiva(userId: string): Promise<{
  lojaId:      string;
  accessToken: string;
  sellerId:    string;
  nickname:    string;
} | null> {
  const { linha: loja } = await lerCredencialMLAtivaDoDono(userId);

  if (!loja || !loja.access_token) return null;

  let accessToken = loja.access_token;
  const expired = loja.token_expires_at &&
    new Date(loja.token_expires_at).getTime() - 5 * 60 * 1000 < Date.now();

  if (expired && loja.refresh_token) {
    const result = await refreshMLToken(loja.refresh_token);
    if (result) {
      accessToken = result.newAccessToken!;
      await saveTokensToDB(loja.id, userId, result);
    }
  }

  return {
    lojaId:      loja.id,
    accessToken,
    sellerId:    loja.seller_id ?? "",
    nickname:    loja.nickname ?? "ML",
  };
}

/**
 * Busca uma loja ML específica pelo id (não "a mais recente ativa").
 * Adicionado 2026-07-11 para o worker de sincronização (sync_jobs) poder
 * sincronizar exatamente a loja do job — getMLLojaAtiva sempre resolveria
 * para a mais recente, o que quebraria o contrato "job por loja_id
 * específico" quando o usuário tem mais de uma loja ML. Mesma lógica de
 * refresh de token de getMLLojaAtiva, sem o filtro "mais recente ativa".
 *
 * ── PR #1: `userId` passou a ser OBRIGATÓRIO ────────────────────────
 * Esta função consultava `lojas` SÓ por `id` e devolvia token — o que a
 * tornava uma capability cross-tenant cuja segurança dependia
 * inteiramente da disciplina de quem chamava. Agora o par entra na
 * query: par coerente devolve credencial, par incoerente devolve `null`.
 * O `userId` não precisa vir provado — ele RESTRINGE a consulta, e é
 * isso que faz um job forjado em `sync_jobs` falhar fechado.
 *
 * O critério de SELEÇÃO da loja não mudou: continua sendo "exatamente
 * esta loja", nunca "a mais recente".
 */
export async function getMLLojaById(lojaId: string, userId: string): Promise<{
  lojaId:      string;
  accessToken: string;
  sellerId:    string;
  nickname:    string;
} | null> {
  const { linha: loja } = await lerCredencialMLPorLojaEDono(lojaId, userId);

  if (!loja || !loja.access_token) return null;

  let accessToken = loja.access_token;
  const expired = loja.token_expires_at &&
    new Date(loja.token_expires_at).getTime() - 5 * 60 * 1000 < Date.now();

  if (expired && loja.refresh_token) {
    const result = await refreshMLToken(loja.refresh_token);
    if (result) {
      accessToken = result.newAccessToken!;
      await saveTokensToDB(loja.id, userId, result);
    }
  }

  return {
    lojaId:      loja.id,
    accessToken,
    sellerId:    loja.seller_id ?? "",
    nickname:    loja.nickname ?? "ML",
  };
}

/** Aplica cookies novos numa NextResponse após refresh */
export function applyMLCookies(res: any, result: MLTokenResult) {
  if (!result.newAccessToken) return;
  const isProd = process.env.NODE_ENV === "production";
  res.cookies.set("ml_access_token", result.newAccessToken, {
    httpOnly: true, secure: isProd, sameSite: "lax", path: "/",
    maxAge: result.expires ?? 21600,
  });
  if (result.newRefreshToken) {
    res.cookies.set("ml_refresh_token", result.newRefreshToken, {
      httpOnly: true, secure: isProd, sameSite: "lax", path: "/",
      maxAge: 86400 * 180,
    });
  }
}
