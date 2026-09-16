/**
 * Normalizacao da LINHA COMPOSTA devolvida por RPC.
 *
 * ── Por que este modulo existe ──────────────────────────────────────
 *
 * A implementacao nasceu privada dentro de `capability-worker.ts`, onde
 * atendia as tres RPCs terminais da lane normal. Os wrappers de
 * persistence da lane de retomada precisam da MESMA normalizacao —
 * as RPCs terminais de la tambem devolvem a linha composta da tarefa —
 * e duas copias que precisassem concordar para sempre seriam
 * exatamente a segunda fonte de verdade que o D5 vem evitando.
 *
 * Entao a implementacao mudou de LUGAR, nao de CONTEUDO: este arquivo e
 * neutro de proposito. Ele nao conhece Supabase, Tarefa, Aprovacao,
 * worker nem executor, e por isso pode ser importado de qualquer lado
 * sem criar aresta de volta.
 *
 * ── O comportamento, preservado byte a byte ─────────────────────────
 *
 * As RPCs devolvem `RETURNS public.agente_tarefas`. O PostgREST entrega
 * isso ora como objeto, ora como array de um elemento, dependendo da
 * versao — normalizar aqui evita que cada chamador descubra isso
 * sozinho, em producao.
 */
export function normalizarLinha(data: unknown): unknown {
  if (Array.isArray(data)) return data.length > 0 ? data[0] : null;
  return data ?? null;
}
