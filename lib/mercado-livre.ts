export function extrairItemIdMercadoLivre(link: string): string | null {
  const match = link.match(/MLB-?(\d+)/i);

  if (!match) return null;

  return `MLB${match[1]}`;
}

export async function buscarAnuncioMercadoLivre(link: string) {
  const itemId = extrairItemIdMercadoLivre(link);

  if (!itemId) {
    throw new Error("Link inválido do Mercado Livre.");
  }

  const response = await fetch(`https://api.mercadolibre.com/items/${itemId}`);

  if (!response.ok) {
    throw new Error("Não foi possível buscar o anúncio no Mercado Livre.");
  }

  const data = await response.json();

  return {
    id: data.id,
    titulo: data.title,
    preco: data.price,
    categoria: data.category_id,
    tipoAnuncio: data.listing_type_id,
    permalink: data.permalink,
    thumbnail: data.thumbnail
  };
}