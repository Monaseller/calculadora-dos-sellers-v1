/**
 * Leitura COMPLETA de `anuncios` (CDS V2 — Fase 0).
 *
 * O PostgREST corta toda resposta no `max-rows` do projeto (1000) sem erro:
 * um `.select()` sem paginação devolve "as primeiras 1000" como se fosse o
 * conjunto inteiro. Para mapas operacionais (existentes da importação, custo
 * por item da sync) isso é corrupção silenciosa: linha fora da janela vira
 * "nova" (duplicata/UNIQUE) ou "sem custo" (lucro errado).
 *
 * Contrato:
 *   - ordem ESTÁVEL por `id` (sem ordem, páginas do PostgREST podem repetir/pular);
 *   - lê até uma página VAZIA — não confia em "página curta" (se o `max-rows`
 *     do servidor for menor que o pedido, a página volta curta e ainda há mais);
 *   - erro em qualquer página → falha (nunca devolve o que leu até ali);
 *   - teto de páginas → falha explícita (nunca truncamento silencioso).
 *
 * Quem chama monta os filtros (dono, marketplace, loja) — este helper só pagina.
 */
export const PAGINA_ANUNCIOS = 1000;
export const MAX_PAGINAS_ANUNCIOS = 500;   // 500k linhas por leitura: acima disso é erro, não corte

type Pagina<T> = PromiseLike<{ data: T[] | null; error: unknown }>;
/** Uma consulta NOVA a cada chamada (builders do PostgREST são de uso único), já com os filtros. */
type Consulta<T> = () => { order(coluna: string, opcoes: { ascending: boolean }): { range(de: number, ate: number): Pagina<T> } };

export type LeituraCompleta<T> = { ok: true; linhas: T[] } | { ok: false; motivo: "ERRO_LEITURA" | "LIMITE_DE_PAGINAS" };

export async function lerTodasAsPaginas<T>(consulta: Consulta<T>, tamanho = PAGINA_ANUNCIOS): Promise<LeituraCompleta<T>> {
  const linhas: T[] = [];
  for (let pagina = 0; pagina < MAX_PAGINAS_ANUNCIOS; pagina++) {
    const de = linhas.length;
    const { data, error } = await consulta().order("id", { ascending: true }).range(de, de + tamanho - 1);
    if (error) return { ok: false, motivo: "ERRO_LEITURA" };
    const lote = data ?? [];
    if (lote.length === 0) return { ok: true, linhas };
    linhas.push(...lote);
  }
  return { ok: false, motivo: "LIMITE_DE_PAGINAS" };
}
