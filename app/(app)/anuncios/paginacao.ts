/**
 * Leitura paginada e recorte por marketplace de Meus Produtos — F0.c.17b.
 *
 * ── O defeito que isto corrige ──────────────────────────────────────
 * `carregar()` fazia UMA consulta sem `range`. O PostgREST aplica um
 * `max-rows` de 1000 e responde `content-range: 0-999/*` — sem erro, sem
 * aviso. Com 1076 anúncios ativos, 76 nunca chegavam à tela; e como a
 * ordem é `created_at DESC` e as linhas Shopee eram mais recentes, os 76
 * cortados eram todos do Mercado Livre. Medido em produção em 2026-08-17:
 * a tela mostrava 198 dos 274 anúncios ML.
 *
 * O limite não vinha do nosso código, então nenhum `select` local o
 * revelava. É a razão de a paginação ser explícita aqui: pedir páginas
 * nomeadas torna o teto visível, em vez de silencioso.
 *
 * ── Por que este arquivo existe, e não `page.tsx` ───────────────────
 * O Next.js valida os exports de um arquivo de rota: `.next/types/.../
 * page.ts` declara a lista fechada do que um `page.tsx` pode exportar
 * (`default`, `dynamic`, `metadata`, …) e tipa qualquer outro nome como
 * `never`. Exportar helper de lá quebra `tsc --noEmit` com TS2344.
 *
 * Como estas funções precisam ser importadas por
 * `scripts/testar-listagem-anuncios.ts` — provar que a paginação não
 * trunca, não duplica e não reordena exige EXECUTÁ-LA, não ler seu
 * código —, elas moram aqui: irmão do `page.tsx`, sem ser rota.
 *
 * Nada aqui conhece Supabase, faz rede ou depende de React.
 */

/**
 * Tamanho de página pedido ao PostgREST. Igual ao `max-rows` dele de
 * propósito: pedir menos multiplicaria requisições sem ganho, e pedir
 * mais seria silenciosamente cortado — que é o bug original.
 */
export const TAMANHO_PAGINA_ANUNCIOS = 1000;

/**
 * Trava contra laço infinito. 50 × 1000 = 50.000 anúncios, duas ordens de
 * grandeza acima do catálogo real. Se algum dia o teto for atingido, o
 * problema é de produto (paginar na interface), não de aumentar esta
 * constante em silêncio.
 */
export const MAX_PAGINAS_ANUNCIOS = 50;

/** Recortes disponíveis na tela. A lista unificada é intencional. */
export type FiltroMarketplace = "todos" | "ML" | "Shopee";

/**
 * Acumula páginas até uma vir incompleta.
 *
 * Recebe a busca como FUNÇÃO: é o que permite provar o comportamento com
 * um dataset > 1000 sem tocar banco nem rede.
 *
 * Página vazia OU menor que `tamanhoPagina` encerra. Uma página exatamente
 * cheia NÃO encerra — pode haver mais, e era exatamente assim que o bug se
 * disfarçava: 1000 linhas parecendo o total.
 *
 * `null` significa falha da consulta, não "acabou": encerra e devolve o
 * que já veio, para quem chama distinguir uma coisa da outra.
 */
export async function buscarPaginado<T>(
  buscarPagina: (de: number, ate: number) => Promise<T[] | null>,
  tamanhoPagina: number = TAMANHO_PAGINA_ANUNCIOS,
  maxPaginas: number = MAX_PAGINAS_ANUNCIOS,
): Promise<T[]> {
  const acumulado: T[] = [];
  for (let pagina = 0; pagina < maxPaginas; pagina++) {
    const de = pagina * tamanhoPagina;
    const lote = await buscarPagina(de, de + tamanhoPagina - 1);
    if (!lote || lote.length === 0) break;
    acumulado.push(...lote);
    if (lote.length < tamanhoPagina) break;
  }
  return acumulado;
}

/**
 * Recorte por marketplace. Extraído da `useMemo` da lista sem mudar
 * comportamento: `"todos"` devolve tudo, e os demais comparam igualdade
 * exata. Não muta a lista recebida.
 */
export function aplicarFiltroMarketplace<T extends { marketplace: string }>(
  linhas: T[],
  filtro: FiltroMarketplace,
): T[] {
  if (filtro === "todos") return linhas;
  return linhas.filter(a => a.marketplace === filtro);
}
