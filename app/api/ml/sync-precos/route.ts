import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

function getToken(request: Request): string | null {
  const cookieHeader = request.headers.get("cookie") || "";
  const entry = cookieHeader.split("; ").find(c => c.startsWith("ml_access_token="));
  return entry ? entry.slice("ml_access_token=".length) : null;
}

function mapTipoAnuncio(listingTypeId: string): string {
  if (listingTypeId === "gold_premium" || listingTypeId === "gold_pro") return "Premium";
  return "Clássico";
}

// Helper: busca dados completos de um item MLB via /items/{id}
async function fetchItemData(mlbId: string, token: string): Promise<any | null> {
  const r = await fetch(`https://api.mercadolibre.com/items/${mlbId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  return r.json();
}

// Helper: resolve MLBU → MLB real do vendedor via /products/
// Retorna o item body completo (price, title, thumbnail, etc.)
async function resolverMLBU(mlbuId: string, token: string): Promise<{ mlbId: string; body: any } | null> {
  // Tenta MLBU e MLB (sem o 'U')
  for (const pid of [mlbuId, "MLB" + mlbuId.slice(4)]) {
    try {
      const r = await fetch(`https://api.mercadolibre.com/products/${pid}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) continue;
      const prod = await r.json();

      // buy_box_winner.item_id = ID do anúncio real deste vendedor no catálogo
      const mlbId: string | null = prod.buy_box_winner?.item_id ?? null;
      if (!mlbId) continue;

      const body = await fetchItemData(mlbId, token);
      if (body) return { mlbId, body };
    } catch {}
  }
  return null;
}

export async function POST(request: Request) {
  const token = getToken(request);
  if (!token) {
    return NextResponse.json({ erro: true, mensagem: "Mercado Livre não conectado." });
  }

  // Busca todos anúncios ML ativos
  const { data: anuncios, error } = await supabase
    .from("anuncios")
    .select("id, ml_item_id, nome, preco_anuncio, frete_gratis, tipo_anuncio, thumbnail, permalink, variation_id")
    .eq("ativo", true)
    .eq("marketplace", "ML")
    .not("ml_item_id", "is", null);

  if (error) {
    return NextResponse.json({ erro: true, mensagem: "Erro ao buscar anúncios: " + error.message });
  }
  if (!anuncios?.length) {
    return NextResponse.json({ erro: false, atualizados: 0, mensagem: "Nenhum anúncio ML encontrado." });
  }

  // ── Separa MLB (listagens diretas) de MLBU (catálogo) ───────────────────
  const mlbAnuncios  = anuncios.filter(a => !a.ml_item_id!.toUpperCase().startsWith("MLBU"));
  const mlbuAnuncios = anuncios.filter(a =>  a.ml_item_id!.toUpperCase().startsWith("MLBU"));

  let atualizados = 0;
  const detalhes: string[] = [];

  // ── 1. MLB: batch fetch via /items?ids= ──────────────────────────────────
  const BATCH = 20;
  const mlItems: any[] = [];

  for (let i = 0; i < mlbAnuncios.length; i += BATCH) {
    const ids = mlbAnuncios.slice(i, i + BATCH).map(a => a.ml_item_id).join(",");
    try {
      const res = await fetch(`https://api.mercadolibre.com/items?ids=${ids}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) continue;
      const batch = await res.json();
      if (Array.isArray(batch)) mlItems.push(...batch);
    } catch {}
  }

  function aplicarMudancas(anuncio: any, body: any): Record<string, any> {
    const mudancas: Record<string, any> = {};

    // Preço: usa o da variação específica se o anúncio tem variation_id
    let novoPreco: number | null = typeof body.price === "number" ? body.price : null;
    if (anuncio.variation_id && body.variations?.length) {
      const varId = String(anuncio.variation_id);
      const variation = (body.variations as any[]).find((v: any) => String(v.id) === varId);
      if (variation && typeof variation.price === "number") novoPreco = variation.price;
    }

    const novoNome      = typeof body.title === "string" ? body.title : null;
    const novoFrete     = body.shipping?.free_shipping ?? false;
    const novoTipo      = body.listing_type_id ? mapTipoAnuncio(body.listing_type_id) : null;
    const novoThumb     = body.thumbnail ?? null;
    const novoPermalink = body.permalink ?? null;

    if (novoPreco !== null && novoPreco !== anuncio.preco_anuncio) {
      mudancas.preco_anuncio = novoPreco;
      const nomeExib = (novoNome ?? anuncio.nome ?? "").substring(0, 35);
      detalhes.push(`${nomeExib}: R$ ${(anuncio.preco_anuncio ?? 0).toFixed(2).replace(".", ",")} → R$ ${novoPreco.toFixed(2).replace(".", ",")}`);
    }
    if (novoNome      && novoNome      !== anuncio.nome)          mudancas.nome         = novoNome;
    if (novoFrete     !== anuncio.frete_gratis)                   mudancas.frete_gratis = novoFrete;
    if (novoTipo      && novoTipo      !== anuncio.tipo_anuncio)  mudancas.tipo_anuncio = novoTipo;
    if (novoThumb     && novoThumb     !== anuncio.thumbnail)     mudancas.thumbnail    = novoThumb;
    if (novoPermalink && novoPermalink !== anuncio.permalink)     mudancas.permalink    = novoPermalink;
    return mudancas;
  }

  for (const item of mlItems) {
    if (item.code !== 200 || !item.body) continue;
    const body    = item.body;
    const anuncio = mlbAnuncios.find(a => a.ml_item_id === body.id);
    if (!anuncio) continue;

    const mudancas = aplicarMudancas(anuncio, body);
    if (Object.keys(mudancas).length > 0) {
      await supabase.from("anuncios").update(mudancas).eq("id", anuncio.id);
      atualizados++;
    }
  }

  // ── 2. MLBU: resolve para MLB real, atualiza tudo inclusive ml_item_id ──
  for (const anuncio of mlbuAnuncios) {
    try {
      const resultado = await resolverMLBU(anuncio.ml_item_id!, token);
      if (!resultado) continue;

      const { mlbId, body } = resultado;
      const mudancas = aplicarMudancas(anuncio, body);

      // Atualiza ml_item_id para o MLB real — próximos syncs vão pelo caminho normal
      if (mlbId !== anuncio.ml_item_id) {
        mudancas.ml_item_id = mlbId;
      }

      // Para MLBU sem thumbnail ou com thumbnail errada, força atualização
      if (body.thumbnail && body.thumbnail !== anuncio.thumbnail) {
        mudancas.thumbnail = body.thumbnail;
      }

      if (Object.keys(mudancas).length > 0) {
        await supabase.from("anuncios").update(mudancas).eq("id", anuncio.id);
        atualizados++;
      }
    } catch {}
  }

  const mensagem = atualizados === 0
    ? `Todos os ${anuncios.length} anúncios já estão atualizados!`
    : `${atualizados} anúncio${atualizados !== 1 ? "s" : ""} atualizado${atualizados !== 1 ? "s" : ""}!`;

  return NextResponse.json({ erro: false, atualizados, mensagem, detalhes });
}
