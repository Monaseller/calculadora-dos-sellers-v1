/**
 * Planejamento de janelas de listagem (puro) — S2-D2.
 *
 * Contrato herdado do S2-D1.1 (prova de completude por update_time):
 *  - a janela NUNCA cobre o futuro: fim <= instante em que a listagem dela
 *    comeca (o motor confere de novo ao comecar a listar);
 *  - janelas consecutivas se SOBREPOEM (protecao operacional contra pedido
 *    que muda durante a listagem anterior — nao e regra financeira);
 *  - cada janela respeita o limite da API (`get_order_list` aceita ate 15
 *    dias; usamos 14, como o sync atual).
 */

/** Sobreposicao entre janelas consecutivas — a aprovada (15 min). */
export const SOBREPOSICAO_MS = 15 * 60 * 1000;
/** Maior janela aceita por chamada (API: 15 dias; margem: 14). */
export const JANELA_MAXIMA_MS = 14 * 24 * 3600 * 1000;

export interface Janela { inicio: Date; fim: Date }

/**
 * Proximas janelas incrementais de `update_time` a partir do cursor da loja
 * (fim da ultima janela concluida) ate `agora`. Cada janela comeca
 * SOBREPOSICAO antes da anterior terminar; nenhuma passa de `agora`.
 */
export function planejarJanelasIncrementais(cursor: Date, agora: Date): Janela[] {
  if (!(cursor < agora)) return [];
  const out: Janela[] = [];
  let inicio = new Date(cursor.getTime() - SOBREPOSICAO_MS);
  for (;;) {
    const fim = new Date(Math.min(inicio.getTime() + JANELA_MAXIMA_MS, agora.getTime()));
    out.push({ inicio, fim });
    if (fim.getTime() >= agora.getTime()) return out;
    inicio = new Date(fim.getTime() - SOBREPOSICAO_MS);
  }
}

/**
 * Janelas de `create_time` em blocos contiguos (backfill — POPULA o corpus;
 * nunca prova completude, ver lib/vendas/canonico/shopee.ts).
 */
export function planejarJanelasCriacao(de: Date, ate: Date): Janela[] {
  if (!(de < ate)) return [];
  const out: Janela[] = [];
  for (let a = de.getTime(); a < ate.getTime(); a += JANELA_MAXIMA_MS) {
    out.push({ inicio: new Date(a), fim: new Date(Math.min(a + JANELA_MAXIMA_MS, ate.getTime())) });
  }
  return out;
}
