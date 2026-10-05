/**
 * Planejamento de janelas de listagem (puro) — S2-D2.
 *
 * Contrato das janelas (S2-D3-B2.1: so `create_time` prova descoberta;
 * `update_time` e acelerador de frescor):
 *  - a janela NUNCA cobre o futuro: fim <= instante em que a listagem dela
 *    comeca (o motor confere de novo ao comecar a listar);
 *  - janelas consecutivas se SOBREPOEM (protecao operacional contra pedido
 *    que muda durante a listagem anterior — MITIGACAO, nunca prova);
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
 * SEMANTICA REAL da API (provada em LIVE no S2-D3-B2.2): `get_order_list`
 * filtra `[time_from, time_to]` com AMBAS as pontas INCLUSIVAS, em segundos
 * inteiros (o transporte trunca com Math.floor). Nao e [inicio, fim).
 */
export const SEMANTICA_INTERVALO_API = "AMBOS_INCLUSIVOS" as const;
/**
 * Estrategia UNICA de borda entre janelas adjacentes: BORDA COMPARTILHADA —
 * a janela seguinte comeca exatamente no fim da anterior. Um pedido criado
 * no segundo da borda e listado pelas duas e gravado UMA vez (upsert por
 * (loja, order_sn)). Zero lacuna mesmo com milissegundos (o Math.floor do
 * transporte leva as duas pontas ao mesmo segundo). Duplicata controlada e
 * aceitavel; lacuna nao. `alcanceDescobertaCriacao` usa a mesma regra.
 */
export const ESTRATEGIA_BORDA = "BORDA_COMPARTILHADA_COM_DEDUP" as const;

/**
 * Janelas de `create_time` em blocos contiguos de ate 14 dias, com BORDA
 * COMPARTILHADA (fim[i] === inicio[i+1]) — DESCOBERTA do corpus a partir da
 * ancora (S2-D3-B2.1, ver lib/vendas/canonico/shopee.ts).
 */
export function planejarJanelasCriacao(de: Date, ate: Date): Janela[] {
  if (!(de < ate)) return [];
  const out: Janela[] = [];
  for (let a = de.getTime(); a < ate.getTime(); a += JANELA_MAXIMA_MS) {
    out.push({ inicio: new Date(a), fim: new Date(Math.min(a + JANELA_MAXIMA_MS, ate.getTime())) });
  }
  return out;
}
