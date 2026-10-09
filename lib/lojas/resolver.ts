/**
 * STORE RESOLVER V2 — CDS V2, Fase 1A.
 *
 * resolverLoja({ userId, marketplace, lojaId }) devolve UMA loja do dono, daquele
 * marketplace, ativa — ou recusa com motivo. Nunca escolhe por data ("mais recente"),
 * nunca pega "a primeira ativa", nunca cai de uma loja explícita inválida para outra.
 *
 *   • lojaId presente  → precisa ser do dono, do marketplace e ativa; senão LOJA_INVALIDA;
 *   • lojaId ausente   → STORE_SELECTION_REQUIRED (ou SEM_LOJA se o dono não tem nenhuma);
 *     exceção ÚNICA e opt-in: `permitirUnica` (fluxo "exatamente uma loja" já aprovado no
 *     Shopee V1) — com exatamente uma loja ativa, ela; com duas ou mais, recusa.
 *
 * O dono vem SEMPRE da sessão (quem chama), nunca do pedido. Os callers ML ainda não
 * migraram para cá (Fase 1B) — este é o contrato a que eles convergem.
 */
import "server-only";
import { listarLojasAtivasDoDono, type LinhaLojaDoDono } from "@/lib/marketplace/credenciais";
import { nomeExibicaoDaLoja, type MarketplaceLoja } from "@/lib/lojas/identidade";

export type MotivoResolucaoLoja = "ENTRADA_INVALIDA" | "LOJA_INVALIDA" | "STORE_SELECTION_REQUIRED" | "SEM_LOJA" | "ERRO_LEITURA";

export interface LojaResolvida { id: string; marketplace: MarketplaceLoja; idExterno: string | null; nomeExibicao: string }

export type ResolucaoLoja =
  | { ok: true; loja: LojaResolvida; origem: "explicita" | "unica" }
  | { ok: false; motivo: MotivoResolucaoLoja };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function paraResolvida(l: LinhaLojaDoDono, marketplace: MarketplaceLoja): LojaResolvida {
  const ext = l.seller_id === null || l.seller_id === undefined ? "" : String(l.seller_id).trim();
  return { id: String(l.id), marketplace, idExterno: ext || null, nomeExibicao: nomeExibicaoDaLoja(l) };
}

/** Decisão PURA sobre as lojas ATIVAS do dono (já lidas pelo par user_id da sessão). */
export function decidirLoja(
  lojasAtivasDoDono: readonly LinhaLojaDoDono[],
  pedido: { marketplace: MarketplaceLoja; lojaId?: string | null; permitirUnica?: boolean },
): ResolucaoLoja {
  if (pedido.marketplace !== "Shopee" && pedido.marketplace !== "ML") return { ok: false, motivo: "ENTRADA_INVALIDA" };
  const doMarketplace = lojasAtivasDoDono.filter((l) => l.marketplace === pedido.marketplace && l.ativo !== false && l.id);
  const explicita = (pedido.lojaId ?? "").trim();
  if (explicita) {
    if (!UUID.test(explicita)) return { ok: false, motivo: "LOJA_INVALIDA" };
    const achada = doMarketplace.find((l) => String(l.id) === explicita);
    return achada ? { ok: true, loja: paraResolvida(achada, pedido.marketplace), origem: "explicita" } : { ok: false, motivo: "LOJA_INVALIDA" };
  }
  if (doMarketplace.length === 0) return { ok: false, motivo: "SEM_LOJA" };
  if (pedido.permitirUnica && doMarketplace.length === 1) return { ok: true, loja: paraResolvida(doMarketplace[0], pedido.marketplace), origem: "unica" };
  return { ok: false, motivo: "STORE_SELECTION_REQUIRED" };
}

export async function resolverLoja(
  pedido: { userId: string; marketplace: MarketplaceLoja; lojaId?: string | null; permitirUnica?: boolean },
): Promise<ResolucaoLoja> {
  if (!pedido?.userId) return { ok: false, motivo: "ENTRADA_INVALIDA" };
  const { linhas, erro } = await listarLojasAtivasDoDono(pedido.userId);
  if (erro) return { ok: false, motivo: "ERRO_LEITURA" };
  return decidirLoja(linhas, pedido);
}
