/**
 * Vendas — loja do Mercado Livre EXPLÍCITA (CDS V2 Vendas A5). Puro (sem React): a tela e os testes usam
 * as mesmas funções.
 *
 * A tela mostra UMA loja ML por vez (seleção, não agregação). A lista vem de GET /api/lojas (só lojas
 * ATIVAS do dono). Com 1 loja ela é a escolhida; com 2+ vale a última escolha salva NESTE navegador
 * se ela ainda estiver na lista — senão o dono escolhe. Nunca "a primeira", "a mais recente" ou ordem.
 * A preferência local é só conveniência: o servidor revalida a loja em toda chamada.
 */
export const CHAVE_LOJA_ML_VENDAS = "cds_vendas_loja_ml";

export interface LojaMLVendas { id: string; nome: string }

/** Lojas ML da resposta de GET /api/lojas (o resto é ignorado). */
export function lojasMLDaLista(lista: unknown): LojaMLVendas[] {
  if (!Array.isArray(lista)) return [];
  return lista
    .filter((l): l is { id: string; marketplace: string; nome_exibicao?: string; nickname?: string } =>
      !!l && typeof (l as { id?: unknown }).id === "string" && (l as { marketplace?: unknown }).marketplace === "ML")
    .map((l) => ({ id: l.id, nome: l.nome_exibicao || l.nickname || "Conta do Mercado Livre" }));
}

/** Lojas da recusa 409 ML_STORE_SELECTION_REQUIRED da rota (id + rótulo). */
export function lojasMLDaRecusa(lojas: unknown): LojaMLVendas[] {
  if (!Array.isArray(lojas)) return [];
  return lojas
    .filter((l): l is { id: string; rotulo?: string } => !!l && typeof (l as { id?: unknown }).id === "string")
    .map((l) => ({ id: l.id, nome: l.rotulo || "Conta do Mercado Livre" }));
}

/**
 * Loja inicial: 0 → nenhuma (a rota responde "não conectado"); 1 → a única; 2+ → a salva SE ainda está
 * na lista, senão `exigeEscolha` (e a salva obsoleta deve ser descartada).
 */
export function escolherLojaMLInicial(lojas: readonly LojaMLVendas[], salva: string | null): { lojaId: string | null; exigeEscolha: boolean; descartarSalva: boolean } {
  if (lojas.length === 0) return { lojaId: null, exigeEscolha: false, descartarSalva: salva !== null };
  if (lojas.length === 1) return { lojaId: lojas[0].id, exigeEscolha: false, descartarSalva: salva !== null && salva !== lojas[0].id };
  const valida = salva !== null && lojas.some((l) => l.id === salva);
  return { lojaId: valida ? salva : null, exigeEscolha: !valida, descartarSalva: salva !== null && !valida };
}
