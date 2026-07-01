/**
 * Busca o preço de promoção ativa de um item ML via /seller-promotions/items/{id}
 * Requer scope write_items no OAuth.
 * Retorna o price da promoção com status "started", ou null se não houver.
 */
export async function getActivePromoPrice(itemId: string, token: string): Promise<number | null> {
  try {
    const res = await fetch(
      `https://api.mercadolibre.com/seller-promotions/items/${itemId}?app_version=v2`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) return null;
    const data = await res.json();

    // A resposta pode ser array de arrays ou array de objetos
    const promotions: any[] = Array.isArray(data[0]) ? data[0] : (Array.isArray(data) ? data : []);

    // Promoção ativa = status "started" com preço > 0
    const active = promotions.find(
      (p: any) => p.status === "started" && typeof p.price === "number" && p.price > 0
    );
    return active?.price ?? null;
  } catch {
    return null;
  }
}
