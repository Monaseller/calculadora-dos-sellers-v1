/**
 * Decisao (pura) da tela "Gerenciar contas Shopee" — Shopee UX V4.
 *
 * Shopee e UM marketplace. `default` / `rd` sao so apps OAuth internos: a
 * tela nunca os mostra como marketplace, so (quando ha mais de um app
 * configurado) como "como conectar esta loja". Depois do OAuth a loja e uma
 * loja Shopee comum.
 *
 * Entrada: a resposta de GET /api/auth/shopee/apps. Desta resposta so se
 * aproveitam `chave`, `rotulo` e `configurado` — qualquer outro campo e
 * descartado (credencial nunca chega aqui, e se chegasse nao seria usada).
 * A URL de inicio e sempre /api/auth/shopee?app=<chave>: o servidor valida a
 * chave na allowlist (lib/shopee-apps.ts) e decide a credencial.
 *
 * Sem React e sem I/O: testavel offline.
 */

export interface OpcaoAppShopee { readonly chave: string; readonly rotulo: string; readonly url: string }

export type DecisaoConexaoShopee =
  | { readonly tipo: "direto"; readonly url: string }
  | { readonly tipo: "escolher"; readonly opcoes: readonly OpcaoAppShopee[] }
  | { readonly tipo: "erro"; readonly mensagem: string };

/** Mensagens controladas (nunca detalhe tecnico). */
export const MENSAGEM_APPS_INDISPONIVEIS = "Nao foi possivel carregar as opcoes de conexao Shopee. Tente novamente.";
export const MENSAGEM_NENHUM_APP = "Nenhuma conexao Shopee esta disponivel no momento.";

const CHAVE_VALIDA = /^[a-z][a-z0-9_-]{0,31}$/;

/** URL de inicio do OAuth para a chave do app (a allowlist e do servidor). */
export function urlConexaoShopee(chave: string): string {
  return `/api/auth/shopee?app=${encodeURIComponent(chave)}`;
}

/** So {chave, rotulo, configurado} validos; o resto e descartado. null = resposta ilegivel. */
export function lerAppsShopee(corpo: unknown): { chave: string; rotulo: string; configurado: boolean }[] | null {
  const apps = (corpo as { apps?: unknown } | null)?.apps;
  if (!Array.isArray(apps)) return null;
  const out: { chave: string; rotulo: string; configurado: boolean }[] = [];
  for (const a of apps) {
    if (typeof a !== "object" || a === null) continue;
    const { chave, rotulo, configurado } = a as Record<string, unknown>;
    if (typeof chave !== "string" || !CHAVE_VALIDA.test(chave) || typeof rotulo !== "string" || typeof configurado !== "boolean") continue;
    out.push({ chave, rotulo, configurado });
  }
  return out;
}

/**
 * 1 app configurado → OAuth direto; 2+ → escolher (na ordem do servidor);
 * 0 ou resposta invalida → erro controlado (nunca um OAuth adivinhado).
 */
export function decidirConexaoShopee(corpo: unknown): DecisaoConexaoShopee {
  const apps = lerAppsShopee(corpo);
  if (apps === null) return { tipo: "erro", mensagem: MENSAGEM_APPS_INDISPONIVEIS };
  const configurados = apps.filter((a) => a.configurado);
  if (configurados.length === 0) return { tipo: "erro", mensagem: MENSAGEM_NENHUM_APP };
  if (configurados.length === 1) return { tipo: "direto", url: urlConexaoShopee(configurados[0].chave) };
  return { tipo: "escolher", opcoes: configurados.map((a) => ({ chave: a.chave, rotulo: a.rotulo, url: urlConexaoShopee(a.chave) })) };
}
