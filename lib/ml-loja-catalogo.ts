/**
 * Loja ML das rotas de CATÁLOGO (importar-anuncios, sync-precos, sync-skus) — CDS V2 Fase 2F.
 *
 * Com o estado 4 (UNIQUE de identidade ML por loja + CHECK "toda row ML tem loja") o catálogo
 * multi-ML deixa de ser barrado. No lugar da barreira, a regra é: NENHUMA operação de catálogo
 * escolhe loja sozinha.
 *
 *   sessão (dono) + referência de loja do pedido → validação no servidor → credencial DAQUELA loja
 *
 * A referência é o `loja_id` da AÇÃO (corpo) ou, sem ele, o contexto `loja_ativa_id` (escolhido pelo
 * dono ao trocar a loja em uso). Os dois são só REFERÊNCIA: `resolverContaML` confere dono + ML + ativa;
 * loja de outro dono, loja Shopee, loja inativa ou id malformado → LOJA_ML_INVALIDA, antes de
 * qualquer chamada ao provider. Referência explícita nunca cai para "a loja única".
 *
 * Sem referência: a loja ML ÚNICA do dono é resolvida aqui, na borda (compatibilidade de UX); com
 * 2+ lojas ML → ML_STORE_SELECTION_REQUIRED, com as lojas do próprio dono (id + rótulo, sem
 * credencial) para a tela perguntar qual. Os motores sempre recebem `lojaId` explícito.
 */
import "server-only";
import { resolverContaML, type ResultadoContaML } from "@/lib/ml-conexao";

export const ML_STORE_SELECTION_REQUIRED = "ML_STORE_SELECTION_REQUIRED";
export const LOJA_ML_INVALIDA = "LOJA_ML_INVALIDA";

export type LojaParaEscolherML = { id: string; rotulo: string };
export type LojaCatalogoML =
  | { ok: true; conta: Extract<ResultadoContaML, { ok: true }> }
  | { ok: false; motivo: typeof ML_STORE_SELECTION_REQUIRED; lojas: LojaParaEscolherML[] }
  | { ok: false; motivo: typeof LOJA_ML_INVALIDA }
  | { ok: false; motivo: "SEM_LOJA" | "PRECISA_RECONECTAR" };

/** Referência de loja do pedido: `loja_id` da ação (corpo) ou o contexto `loja_ativa_id`. */
export function referenciaDeLojaML(corpo: unknown, lojaAtivaCookie: string | null | undefined): string | null {
  const daAcao = (corpo as { loja_id?: unknown } | null | undefined)?.loja_id;
  if (daAcao !== undefined && daAcao !== null && daAcao !== "") return String(daAcao);
  return lojaAtivaCookie ? lojaAtivaCookie : null;
}

export async function resolverLojaCatalogoML(userId: string, referencia: string | null): Promise<LojaCatalogoML> {
  const conta = referencia
    ? await resolverContaML(userId, referencia)                          // seleção explícita: nunca a loja única
    : await resolverContaML(userId, null, { permitirUnica: true });   // sem seleção: SÓ a loja ML única
  if (conta.ok) return { ok: true, conta };
  if (conta.motivo === "LOJA_NAO_DEFINIDA") {
    return { ok: false, motivo: ML_STORE_SELECTION_REQUIRED,
      lojas: conta.lojas.map((l) => ({ id: l.id, rotulo: l.nickname || "Conta do Mercado Livre" })) };
  }
  if (conta.motivo === "LOJA_INVALIDA") return { ok: false, motivo: LOJA_ML_INVALIDA };
  return { ok: false, motivo: conta.motivo };
}

/** Resposta HTTP das recusas de SELEÇÃO (sem credencial; só id + rótulo das lojas do próprio dono). */
export function respostaSelecaoLojaML(r: Extract<LojaCatalogoML, { motivo: typeof ML_STORE_SELECTION_REQUIRED | typeof LOJA_ML_INVALIDA }>): { status: number; corpo: Record<string, unknown> } {
  if (r.motivo === ML_STORE_SELECTION_REQUIRED) {
    return { status: 409, corpo: { erro: true, codigo: ML_STORE_SELECTION_REQUIRED, mensagem: "Escolha qual conta do Mercado Livre usar.", lojas: r.lojas } };
  }
  return { status: 404, corpo: { erro: true, codigo: LOJA_ML_INVALIDA, mensagem: "Conta do Mercado Livre não encontrada entre as suas contas ativas." } };
}
