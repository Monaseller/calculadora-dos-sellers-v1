/**
 * Vendas — códigos ORIGINAIS do marketplace (CDS V2 Vendas A3.2). Puro (sem React): a tela e os testes usam
 * as mesmas funções.
 *
 *   CÓD. VENDA    `orderId` da linha = `pedidos.order_id` — ML: `order.id`; Shopee: `order_sn`.
 *   CÓD. ANÚNCIO  `mlItemId` da linha = `pedidos.ml_item_id` — ML: `order_items[].item.id` (MLB…); Shopee: o
 *                 `item_id` do provider. Vazio (linha legada sem item) → sem código, nunca inventado.
 *
 * Nunca `pedidos.id` (chave interna), SKU, título ou outro código visual não provado.
 */
export interface LinhaComCodigos { orderId?: string | null; mlItemId?: string | null }

const limpo = (v: string | null | undefined): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  return s === "" ? null : s;
};

/** Código da venda/pedido no marketplace (ML order_id; Shopee order_sn). */
export function codigoVenda(r: LinhaComCodigos): string | null { return limpo(r.orderId); }

/** Código do anúncio no marketplace (ML item id; Shopee item_id). */
export function codigoAnuncio(r: LinhaComCodigos): string | null { return limpo(r.mlItemId); }

/** Copia EXATAMENTE o código (sem rótulo, sem espaços). `false` se não há área de transferência ou ela falha. */
export async function copiarCodigo(codigo: string, area: { writeText(t: string): Promise<void> } | null | undefined): Promise<boolean> {
  if (!area) return false;
  try { await area.writeText(codigo); return true; } catch { return false; }
}
