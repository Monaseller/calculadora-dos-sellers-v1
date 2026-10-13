/**
 * Refresh de IDENTIDADES CONHECIDAS por id do provider (CDS V2 Fase 2H-D) — ML e Shopee, por LOJA.
 *
 *   identidade já conhecida em anuncios (dono + marketplace + loja + id do item)
 *   → consulta direta pelo id → resposta POSITIVA comprovada → observacaoPositiva → gravarObservacoes
 *   → só então o checkpoint (cursor) avança.
 *
 * Amplia a cobertura de OBSERVAÇÃO (visto_em; status RAW só quando a resposta o traz — ML). Não amplia a
 * cobertura de status para estados que o repositório não prova.
 *
 * Regras (protegidas por I9 e I10):
 *   • fonte = anuncios do dono + marketplace + LOJA com id de item não nulo, TODAS as páginas, SEM filtro de
 *     ativo/status/visto (row soft-deleted segue observável); dedup por loja|item (a fonte já é da loja);
 *   • credencial da MESMA loja (ML: resolverContaML(userId, lojaId) no motor; Shopee: a da loja resolvida
 *     pela rota); ids de outra loja nunca vão ao provider;
 *   • positivo = ML: code 200 E body.id === id pedido; Shopee: item em response.item_list com o mesmo id.
 *     Qualquer outra coisa (404, outro code, sem body, id divergente, ausente da lista) = NÃO OBSERVADO:
 *     nenhuma escrita (nem status, nem visto_em, nem ativo) — só diagnóstico. Ausência não é status;
 *     404 não é "deleted"; resposta parcial não é "closed";
 *   • variação/model só é observada se VOLTOU na resposta positiva do item (ML: body.variations; Shopee:
 *     get_model_list). Item sem variação/model: só a row sem variação. Retorno do item não prova os
 *     models/variações históricos;
 *   • ML: status = body.status RAW (se presente). Shopee: SÓ visto_em (status não provado em resposta
 *     gravada — SHOPEE_STATUS_WRITER = DEFERRED; nunca NORMAL por inferência);
 *   • id inválido (fora do padrão do provider) não vai ao provider: conta em diagnóstico na 1ª fatia e
 *     fica fora da sequência do cursor;
 *   • cursor { v, m, l, k: "refresh", i }: preso a marketplace + loja + tipo; recusado ANTES do provider;
 *     nunca offset nem id de anuncio;
 *   • orçamento: 35s por fatia e no máximo 60 chamadas ao provider; unidade (lote/item) só começa se puder
 *     terminar; resultado parcial devolve o cursor do último item concluído e gravado;
 *   • escrita falha ou confirmação parcial → a fatia falha (fail-closed); retry converge.
 *
 * Contadores PRÓPRIOS (não são importados/atualizados/ignorados).
 */
import { cmpItemML } from "@/lib/anuncios/importacao-ml";

export const ORCAMENTO_REFRESH_MS = 35_000;
export const MAX_CHAMADAS_REFRESH = 60;
export const LOTE_REFRESH_ML = 20;
export const LOTE_REFRESH_SHOPEE = 50;
export const CONCORRENCIA_MODELOS_REFRESH = 3;

export const UUID_REFRESH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ITEM_ID_ML = /^[A-Z]{3,4}\d{1,20}$/;
export const ITEM_ID_SHOPEE = /^\d{1,20}$/;
export type Mkt = "ML" | "Shopee";
export const padraoDe = (m: Mkt) => (m === "ML" ? ITEM_ID_ML : ITEM_ID_SHOPEE);
export const cmpShopee = (a: string, b: string) => { const x = BigInt(a), y = BigInt(b); return x < y ? -1 : x > y ? 1 : 0; };
export const ordemDe = (m: Mkt) => (m === "ML" ? cmpItemML : cmpShopee);

// ── Cursor ────────────────────────────────────────────────────────────
export function codificarCursorRefresh(m: Mkt, lojaId: string, ultimoItem: string): string {
  return Buffer.from(JSON.stringify({ v: 1, m, l: lojaId, k: "refresh", i: ultimoItem }), "utf8").toString("base64url");
}
export type CursorRefreshLido = { ok: true; ultimoItem: string | null } | { ok: false; motivo: "CURSOR_INVALIDO" | "CURSOR_DE_OUTRA_LOJA" };
export function lerCursorRefresh(cursor: unknown, m: Mkt, lojaId: string): CursorRefreshLido {
  if (cursor === undefined || cursor === null || cursor === "") return { ok: true, ultimoItem: null };
  if (typeof cursor !== "string" || cursor.length > 400) return { ok: false, motivo: "CURSOR_INVALIDO" };
  let c: any;
  try { c = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { return { ok: false, motivo: "CURSOR_INVALIDO" }; }
  if (!c || c.v !== 1 || c.k !== "refresh" || c.m !== m || typeof c.l !== "string" || !UUID_REFRESH.test(c.l) || typeof c.i !== "string" || !padraoDe(m).test(c.i)) {
    return { ok: false, motivo: "CURSOR_INVALIDO" };
  }
  if (c.l !== lojaId) return { ok: false, motivo: "CURSOR_DE_OUTRA_LOJA" };
  return { ok: true, ultimoItem: c.i };
}

export type CodigoErroRefresh = "CURSOR" | "LOJA" | "TOKEN" | "PROVIDER" | "BANCO";
export class ErroRefreshIdentidades extends Error {
  /** Último item CONCLUÍDO e gravado antes da falha (null = nenhum além do cursor recebido). */
  ultimoConcluido: string | null = null;
  constructor(public codigo: CodigoErroRefresh, mensagem: string, public motivo?: string) { super(mensagem); }
}

export interface ResultadoRefresh {
  marketplace: Mkt; lojaId: string; parcial: boolean; cursor: string | null;
  /** ids distintos válidos da loja (fila completa) */
  conhecidos: number;
  /** ids consultados nesta fatia */
  consultados: number;
  observados: number;
  naoObservados: number;
  linhasObservadas: number;
  /** ids inválidos (não vão ao provider) — contados só na 1ª fatia */
  idsInvalidos: number;
  /** não observados por motivo/código (diagnóstico; nunca vira status) */
  naoObservadosPorMotivo: Record<string, number>;
  chamadasProvider: number;
}

export type LinhaFonte = { id: string; ml_item_id: string; variation_id: string | null; loja_id: string };
/** Agrupa a fonte (já escopada pela loja) por item — dedup loja|item —, separa ids válidos (ordenados) e inválidos. */
export function agruparFonte(linhas: LinhaFonte[], lojaId: string, m: Mkt) {
  const porItem = new Map<string, LinhaFonte[]>();
  for (const row of linhas) {
    if (row.loja_id !== lojaId) throw new ErroRefreshIdentidades("BANCO", "linha de outra loja na fonte do refresh");
    const k = String(row.ml_item_id);
    const g = porItem.get(k) ?? []; g.push(row); porItem.set(k, g);
  }
  const todos = [...porItem.keys()];
  const validos = todos.filter((id) => padraoDe(m).test(id)).sort(ordemDe(m));
  return { porItem, validos, invalidos: todos.length - validos.length };
}
export const somarNaoObservado = (r: ResultadoRefresh, motivo: string) => { r.naoObservados++; r.naoObservadosPorMotivo[motivo] = (r.naoObservadosPorMotivo[motivo] ?? 0) + 1; };
