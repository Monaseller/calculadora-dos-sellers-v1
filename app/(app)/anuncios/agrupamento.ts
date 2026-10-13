/**
 * Meus Produtos — chave de agrupamento de anúncios (CDS V2 Fase 2D).
 *
 * O mesmo `ml_item_id` em lojas diferentes (ou em marketplaces diferentes) é OUTRO anúncio:
 * nunca fundir ML-A/item X com ML-B/item X. A chave usa a identidade técnica REAL da loja
 * (`loja_id`, sem hash paralelo) e não é exibida. Sem `ml_item_id` → não agrupa (null).
 *
 * Puro (sem React): a tela e os testes usam a mesma função.
 */
export interface IdentidadeAgrupavel { marketplace?: string | null; loja_id?: string | null; ml_item_id?: string | null }

export function chaveDeGrupoAnuncio(a: IdentidadeAgrupavel): string | null {
  if (!a.ml_item_id) return null;
  return `${a.marketplace ?? ""}|${a.loja_id ?? ""}|${a.ml_item_id}`;
}

interface Agrupavel extends IdentidadeAgrupavel { id: string; variation_id?: string | null }

/** Duplicados "antigos": mesma chave (marketplace|loja|item) com 2+ linhas que não são só variações. */
export function idsDuplicadosAntigos<T extends Agrupavel>(lista: readonly T[]): Set<string> {
  const grupos = new Map<string, T[]>();
  for (const a of lista) {
    const chave = chaveDeGrupoAnuncio(a);
    if (!chave) continue;
    const g = grupos.get(chave) ?? [];
    g.push(a);
    grupos.set(chave, g);
  }
  const ids = new Set<string>();
  for (const grupo of grupos.values()) {
    if (grupo.length <= 1) continue;
    // Grupos onde todos têm variation_id são variações intencionais — não duplicados
    if (grupo.every((a) => a.variation_id)) continue;
    grupo.slice(1).forEach((a) => ids.add(a.id));
  }
  return ids;
}

/** Variações agrupadas num card por chave (marketplace|loja|item); o resto fica solo. */
export function agruparVariacoes<T extends Agrupavel>(lista: readonly T[]): { solo: T[]; grupos: T[][] } {
  const mapa = new Map<string, T[]>();
  const solo: T[] = [];
  for (const a of lista) {
    const chave = chaveDeGrupoAnuncio(a);
    if (a.variation_id && chave) {
      const g = mapa.get(chave) ?? [];
      g.push(a);
      mapa.set(chave, g);
    } else {
      solo.push(a);
    }
  }
  return { solo, grupos: [...mapa.values()] };
}
