/**
 * Registro SERVER-ONLY dos apps Shopee Open Platform da CDS.
 *
 * Uma loja Shopee e conectada por UM app (partner_id + partner_key). O
 * OAuth escolhe o app SO por esta allowlist: o navegador manda, no maximo,
 * a CHAVE do app (`default` | `rd`) — nunca partner_id nem partner_key.
 * Depois do OAuth a loja guarda o partner_id/partner_key do app que a
 * autorizou (registrarLojaShopeeOAuth) e refresh, sync, worker, ingestao,
 * intraday e escrow seguem usando a credencial DA LOJA — nada aqui muda isso.
 *
 *   default  SHOPEE_PARTNER_ID / SHOPEE_PARTNER_KEY       (app historico)
 *   rd       SHOPEE_RD_PARTNER_ID / SHOPEE_RD_PARTNER_KEY (segundo app)
 *
 * `rd` e so o identificador do app (credencial de integracao), nao regra de
 * negocio: nenhum dono, loja ou shop_id e associado a ele aqui. App sem as
 * duas envs (ou com partner_id nao numerico) fica INDISPONIVEL — e nunca cai
 * para outro app.
 */
import "server-only";

export type ChaveAppShopee = "default" | "rd";

interface DefinicaoApp { readonly rotulo: string; readonly envPartnerId: string; readonly envPartnerKey: string }

const APPS: Readonly<Record<ChaveAppShopee, DefinicaoApp>> = Object.freeze({
  default: { rotulo: "Shopee", envPartnerId: "SHOPEE_PARTNER_ID", envPartnerKey: "SHOPEE_PARTNER_KEY" },
  rd: { rotulo: "Shopee — R.D.", envPartnerId: "SHOPEE_RD_PARTNER_ID", envPartnerKey: "SHOPEE_RD_PARTNER_KEY" },
});

export const CHAVES_APP_SHOPEE = Object.freeze(Object.keys(APPS) as ChaveAppShopee[]);
export const APP_SHOPEE_PADRAO: ChaveAppShopee = "default";

/** Credencial resolvida de UM app — so para uso no servidor. */
export interface AppShopeeResolvido { readonly chave: ChaveAppShopee; readonly partnerId: string; readonly partnerKey: string }
/** O que pode ir ao navegador: nem partner_id nem partner_key. */
export interface AppShopeePublico { readonly chave: ChaveAppShopee; readonly rotulo: string; readonly configurado: boolean }

type Ambiente = Record<string, string | undefined>;

export function ehChaveAppShopee(valor: unknown): valor is ChaveAppShopee {
  return typeof valor === "string" && Object.prototype.hasOwnProperty.call(APPS, valor);
}

/** Credencial do app pela CHAVE allowlisted. null = chave desconhecida OU app nao configurado (sem fallback). */
export function resolverAppShopee(chave: unknown, ambiente: Ambiente = process.env): AppShopeeResolvido | null {
  if (!ehChaveAppShopee(chave)) return null;
  const def = APPS[chave];
  const partnerId = (ambiente[def.envPartnerId] ?? "").trim();
  const partnerKey = ambiente[def.envPartnerKey] ?? "";
  if (!/^\d+$/.test(partnerId) || partnerKey.length === 0) return null;
  return { chave, partnerId, partnerKey };
}

/** Lista publica para a UI: chave, rotulo e se esta configurado. */
export function listarAppsShopeePublicos(ambiente: Ambiente = process.env): AppShopeePublico[] {
  return CHAVES_APP_SHOPEE.map((chave) => ({ chave, rotulo: APPS[chave].rotulo, configurado: resolverAppShopee(chave, ambiente) !== null }));
}
