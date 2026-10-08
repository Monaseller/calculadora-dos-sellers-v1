/**
 * Selecao EXPLICITA da loja Shopee para os fluxos LEGADOS (multi-loja V1).
 *
 * Regra central: nenhum fluxo Shopee escolhe loja por data de criacao
 * ("a mais recente"), nem "uma qualquer". Uma acao e:
 *   A. store-scoped — a loja vem desta selecao, sempre conferida no servidor
 *      contra as lojas ATIVAS do dono (capability listarLojasAtivasDoDono);
 *   B. global ao dono — o chamador ENUMERA todas as lojas Shopee ativas
 *      (lojasShopeeAtivasDoDono) e opera uma por vez.
 *
 * Ordem da selecao store-scoped:
 *   1. `loja_id` explicito do pedido (precisa ser Shopee, ativa e do dono);
 *   2. o cookie `shopee_loja_id` do "Usar esta" — SO como padrao de acoes
 *      interativas e SO se re-conferido aqui (o cookie nao e httpOnly: e
 *      identidade a validar, nunca autoridade);
 *   3. exatamente UMA loja Shopee ativa → ela (nao ha ambiguidade);
 *   4. duas ou mais sem escolha valida → STORE_SELECTION_REQUIRED.
 * Loja explicita invalida NUNCA cai para outra: e recusada.
 */
import "server-only";
import { listarLojasAtivasDoDono } from "@/lib/marketplace/credenciais";

export const NOME_COOKIE_LOJA_SHOPEE = "shopee_loja_id";

export interface LojaShopeeDoDono { id: string; rotulo: string }

export type MotivoSelecaoLojaShopee = "STORE_SELECTION_REQUIRED" | "LOJA_INVALIDA" | "SEM_LOJA_SHOPEE" | "ERRO_LEITURA";
export type SelecaoLojaShopee =
  | { ok: true; lojaId: string; origem: "explicita" | "cookie" | "unica" }
  | { ok: false; motivo: MotivoSelecaoLojaShopee; lojas: LojaShopeeDoDono[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Decisao PURA sobre as lojas Shopee ATIVAS do dono (ja filtradas).
 * `usarCookie` = false para acoes que exigem escolha explicita (ex.: importar
 * anuncios, rotas admin): ai o cookie nunca decide.
 */
export function escolherLojaShopee(
  ativas: readonly LojaShopeeDoDono[],
  pedido: { lojaIdExplicito?: string | null; lojaIdCookie?: string | null; usarCookie: boolean; exigirExplicita?: boolean },
): SelecaoLojaShopee {
  const ids = new Set(ativas.map((l) => l.id));
  const explicito = (pedido.lojaIdExplicito ?? "").trim();
  if (explicito) {
    return UUID.test(explicito) && ids.has(explicito)
      ? { ok: true, lojaId: explicito, origem: "explicita" }
      : { ok: false, motivo: "LOJA_INVALIDA", lojas: [...ativas] };
  }
  if (pedido.exigirExplicita) return { ok: false, motivo: ativas.length ? "STORE_SELECTION_REQUIRED" : "SEM_LOJA_SHOPEE", lojas: [...ativas] };
  const cookie = (pedido.lojaIdCookie ?? "").trim();
  if (pedido.usarCookie && UUID.test(cookie) && ids.has(cookie)) return { ok: true, lojaId: cookie, origem: "cookie" };
  if (ativas.length === 1) return { ok: true, lojaId: ativas[0].id, origem: "unica" };
  if (ativas.length === 0) return { ok: false, motivo: "SEM_LOJA_SHOPEE", lojas: [] };
  return { ok: false, motivo: "STORE_SELECTION_REQUIRED", lojas: [...ativas] };
}

/** Lojas Shopee ATIVAS do dono (para enumerar em acoes globais). null = falha de leitura. */
export async function lojasShopeeAtivasDoDono(userId: string): Promise<LojaShopeeDoDono[] | null> {
  const { linhas, erro } = await listarLojasAtivasDoDono(userId);
  if (erro) return null;
  return linhas.filter((l) => l.marketplace === "Shopee" && l.id)
    .map((l) => ({ id: String(l.id), rotulo: String(l.nickname || l.nome || "Shopee") }));
}

/** Selecao store-scoped com as lojas lidas do banco (dono vem da SESSAO, nunca do pedido). */
export async function selecionarLojaShopee(
  userId: string,
  pedido: { lojaIdExplicito?: string | null; lojaIdCookie?: string | null; usarCookie: boolean; exigirExplicita?: boolean },
): Promise<SelecaoLojaShopee> {
  const ativas = await lojasShopeeAtivasDoDono(userId);
  if (ativas === null) return { ok: false, motivo: "ERRO_LEITURA", lojas: [] };
  return escolherLojaShopee(ativas, pedido);
}

/** Resposta HTTP padrao para uma selecao recusada (sem credencial; so id e rotulo das lojas do proprio dono). */
export function corpoSelecaoRecusada(s: Extract<SelecaoLojaShopee, { ok: false }>): { status: number; corpo: Record<string, unknown> } {
  const mensagens: Record<MotivoSelecaoLojaShopee, [number, string]> = {
    STORE_SELECTION_REQUIRED: [409, "Escolha qual loja Shopee usar."],
    LOJA_INVALIDA: [404, "Loja Shopee nao encontrada entre as suas lojas ativas."],
    SEM_LOJA_SHOPEE: [404, "Conta Shopee nao conectada."],
    ERRO_LEITURA: [503, "Nao foi possivel ler as lojas agora."],
  };
  const [status, mensagem] = mensagens[s.motivo];
  return { status, corpo: { erro: true, codigo: s.motivo, mensagem, lojas: s.lojas } };
}
