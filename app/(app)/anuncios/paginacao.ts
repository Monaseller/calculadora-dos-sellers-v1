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

// ────────────────────────────────────────────────────────────────────
// ESCRITA EM LOTE — a outra face do mesmo limite do PostgREST
//
// A exclusao em massa montava `.in("id", ids)` com a selecao inteira. Com
// 1076 anuncios isso vira um filtro de 39.819 bytes numa URL de ~39.877 —
// e a requisicao volta 400 Bad Request. Medido em 2026-08-17 contra os
// IDs reais: 200 ids passam (7.475 bytes), 400 ja falham na rede, 800+
// respondem 400. O maximo observado foi 398 ids.
//
// O codigo antigo nao lia o erro e removia os cards da tela na linha
// seguinte ao await. Os anuncios "sumiam" e voltavam no F5, porque o
// banco nunca foi tocado: `ativo=false` tinha ZERO linhas no catalogo.
// ────────────────────────────────────────────────────────────────────

/**
 * Metade do maximo medido (398). A folga e deliberada: o teto real
 * depende de proxy e CDN no caminho, que podem mudar sem aviso, e o custo
 * de um lote a mais e uma requisicao — o de um lote grande demais e uma
 * exclusao que nao acontece em silencio.
 */
export const LOTE_MAXIMO_IDS = 200;

/** Divide em lotes de no maximo `tamanho`, preservando ordem. */
export function dividirEmLotes<T>(itens: T[], tamanho: number = LOTE_MAXIMO_IDS): T[][] {
  if (!Number.isInteger(tamanho) || tamanho < 1) {
    throw new Error(`tamanho de lote invalido: ${tamanho}`);
  }
  const lotes: T[][] = [];
  for (let i = 0; i < itens.length; i += tamanho) lotes.push(itens.slice(i, i + tamanho));
  return lotes;
}

export interface ResultadoDesativacao {
  /** IDs que o BANCO devolveu como efetivamente alterados. */
  confirmados: string[];
  /** Pedidos que nao voltaram confirmados — por erro ou por nao casarem. */
  naoConfirmados: string[];
  /** Primeira mensagem de erro encontrada, ou `null`. */
  erro: string | null;
}

/**
 * Desativa em lotes e devolve o que o banco CONFIRMOU.
 *
 * Recebe a escrita como funcao: nao conhece Supabase, o que permite provar
 * sucesso total, erro no primeiro lote, erro intermediario e falha parcial
 * sem tocar em banco nenhum.
 *
 * ── Estrategia em falha parcial: CONTINUAR os lotes restantes ───────
 * Nao e fail-fast. Os lotes sao independentes, e uma falha no lote 3 nao
 * diz nada sobre o 4 — pode ser instabilidade momentanea. Parar ali
 * deixaria de excluir itens que o usuario pediu para excluir, sem ganho:
 * como cada ID e classificado como confirmado ou nao, continuar nunca
 * perde informacao nem finge sucesso. O custo maximo de insistir sao
 * poucas requisicoes; o custo de parar cedo e trabalho nao feito.
 *
 * IDs repetidos na entrada sao deduplicados antes da divisao, para que um
 * mesmo ID nunca apareca em dois lotes.
 */
export async function desativarEmLotes(
  desativarLote: (ids: string[]) => Promise<{ ids: string[] | null; erro: string | null }>,
  ids: string[],
  tamanho: number = LOTE_MAXIMO_IDS,
): Promise<ResultadoDesativacao> {
  const unicos = [...new Set(ids)];
  const confirmados = new Set<string>();
  let erro: string | null = null;

  for (const lote of dividirEmLotes(unicos, tamanho)) {
    let resposta: { ids: string[] | null; erro: string | null };
    try {
      resposta = await desativarLote(lote);
    } catch (e: any) {
      // Excecao NAO e confirmacao. Registra e segue para o proximo lote.
      erro = erro ?? (e?.message ?? String(e));
      continue;
    }
    if (resposta.erro) { erro = erro ?? resposta.erro; continue; }
    for (const id of resposta.ids ?? []) confirmados.add(id);
  }

  const naoConfirmados = unicos.filter(id => !confirmados.has(id));
  // Pedido que nao voltou e falha, mesmo sem o banco ter reclamado: pode
  // ser ownership negando a linha. Nunca tratar ausencia como sucesso.
  if (!erro && naoConfirmados.length > 0) {
    erro = "Algumas linhas não foram confirmadas pelo banco.";
  }
  return { confirmados: [...confirmados], naoConfirmados, erro };
}
