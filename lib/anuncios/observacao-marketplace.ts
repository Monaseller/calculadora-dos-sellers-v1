/**
 * Observação do marketplace (CDS V2 Fase 2H-C) — `status_marketplace` + `visto_em`.
 *
 *   ativo              = do USUÁRIO (soft delete no CDS). O provider NUNCA escreve `ativo`.
 *   status_marketplace = último valor RAW de status efetivamente presente numa resposta válida do
 *                        provider — exatamente como veio (sem lowercase, tradução, mapeamento).
 *   visto_em           = momento da última observação POSITIVA da identidade numa resposta válida.
 *
 * Regras:
 *   • observação sem status (a resposta provou a identidade, mas não trouxe status) → só `visto_em`;
 *     o payload NÃO leva `status_marketplace` (o valor anterior é preservado; nunca vira NULL);
 *   • AUSÊNCIA (identidade que não voltou na resposta) não gera observação nenhuma — quem chama só
 *     observa identidades presentes na resposta; ausência nunca vira status/visto_em/ativo;
 *   • a gravação em row existente é escopada por id + dono + marketplace + LOJA e não filtra `ativo`
 *     (row soft-deleted no CDS continua observável); o payload é só { status_marketplace?, visto_em };
 *   • fail-closed: banco recusou ou não confirmou TODAS as rows pedidas → erro (quem chama não avança
 *     o cursor além da unidade concluída).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type ObservacaoMarketplace = { visto_em: string; status_marketplace?: string };

/** Observação positiva em `observadoEm`; `status_marketplace` só se a resposta trouxe um status RAW. */
export function observacaoPositiva(observadoEm: Date, statusRaw?: unknown): ObservacaoMarketplace {
  if (!(observadoEm instanceof Date) || Number.isNaN(observadoEm.getTime())) throw new Error("observacao: instante invalido");
  const obs: ObservacaoMarketplace = { visto_em: observadoEm.toISOString() };
  if (typeof statusRaw === "string" && statusRaw.trim() !== "") obs.status_marketplace = statusRaw;
  return obs;
}

/** Lote de ids por UPDATE (o `in` vai na URL do PostgREST — mesmo teto medido para a exclusão). */
export const LOTE_OBSERVACAO = 200;

/**
 * Grava observações em rows EXISTENTES de UMA loja: um UPDATE por payload idêntico (em lotes de ids),
 * sempre com id + dono + marketplace + loja. Devolve `false` se o banco recusar ou não confirmar todas.
 */
export async function gravarObservacoes(
  banco: SupabaseClient,
  alvo: { userId: string; lojaId: string; marketplace: "ML" | "Shopee" },
  pares: ReadonlyArray<{ id: string; obs: ObservacaoMarketplace }>,
): Promise<boolean> {
  const grupos = new Map<string, { obs: ObservacaoMarketplace; ids: string[] }>();
  for (const p of pares) {
    const chave = JSON.stringify([p.obs.visto_em, p.obs.status_marketplace ?? null, "status_marketplace" in p.obs]);
    const g = grupos.get(chave) ?? { obs: p.obs, ids: [] };
    g.ids.push(p.id);
    grupos.set(chave, g);
  }
  for (const { obs, ids } of grupos.values()) {
    for (let i = 0; i < ids.length; i += LOTE_OBSERVACAO) {
      const lote = ids.slice(i, i + LOTE_OBSERVACAO);
      const { data, error } = await banco.from("anuncios").update(obs)
        .in("id", lote).eq("user_id", alvo.userId).eq("marketplace", alvo.marketplace).eq("loja_id", alvo.lojaId).select("id");
      if (error || (data ?? []).length !== lote.length) return false;
    }
  }
  return true;
}
