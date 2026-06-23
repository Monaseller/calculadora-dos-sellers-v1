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

export async function POST(request: Request) {
  const token = getToken(request);
  if (!token) {
    return NextResponse.json({ erro: true, mensagem: "Mercado Livre não conectado." });
  }

  // Busca todos anúncios ML ativos com ml_item_id
  const { data: anuncios, error } = await supabase
    .from("anuncios")
    .select("id, ml_item_id, nome, preco_anuncio, frete_gratis, tipo_anuncio, thumbnail, permalink")
    .eq("ativo", true)
    .eq("marketplace", "ML")
    .not("ml_item_id", "is", null);

  if (error) {
    return NextResponse.json({ erro: true, mensagem: "Erro ao buscar anúncios: " + error.message });
  }

  if (!anuncios?.length) {
    return NextResponse.json({ erro: false, atualizados: 0, mensagem: "Nenhum anúncio ML encontrado." });
  }

  // Busca dados do ML em batches de 20 (limite seguro de URL)
  const BATCH = 20;
  const mlItems: any[] = [];

  for (let i = 0; i < anuncios.length; i += BATCH) {
    const ids = anuncios.slice(i, i + BATCH).map(a => a.ml_item_id).join(",");
    const res = await fetch(`https://api.mercadolibre.com/items?ids=${ids}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) continue;
    const batch = await res.json();
    if (Array.isArray(batch)) mlItems.push(...batch);
  }

  let atualizados = 0;
  const detalhes: string[] = [];

  for (const item of mlItems) {
    if (item.code !== 200 || !item.body) continue;
    const body = item.body;

    const anuncio = anuncios.find(a => a.ml_item_id === body.id);
    if (!anuncio) continue;

    const novoPreco      = typeof body.price === "number" ? body.price : null;
    const novoNome       = typeof body.title === "string" ? body.title : null;
    const novoFrete      = body.shipping?.free_shipping ?? false;
    const novoTipo       = body.listing_type_id ? mapTipoAnuncio(body.listing_type_id) : null;
    const novoThumb      = body.thumbnail ?? null;
    const novoPermalink  = body.permalink ?? null;

    const mudancas: Record<string, any> = {};

    if (novoPreco !== null && novoPreco !== anuncio.preco_anuncio) {
      mudancas.preco_anuncio = novoPreco;
      // Registra mudança de preço para feedback
      const nomeExib = (novoNome ?? anuncio.nome ?? "").substring(0, 35);
      detalhes.push(`${nomeExib}: R$ ${(anuncio.preco_anuncio ?? 0).toFixed(2).replace(".", ",")} → R$ ${novoPreco.toFixed(2).replace(".", ",")}`);
    }
    if (novoNome && novoNome !== anuncio.nome)              mudancas.nome         = novoNome;
    if (novoFrete !== anuncio.frete_gratis)                 mudancas.frete_gratis = novoFrete;
    if (novoTipo && novoTipo !== anuncio.tipo_anuncio)      mudancas.tipo_anuncio = novoTipo;
    // Sempre atualiza thumbnail se vier da API e o DB estiver vazio ou diferente
    if (novoThumb && (!anuncio.thumbnail || novoThumb !== anuncio.thumbnail)) mudancas.thumbnail = novoThumb;
    if (novoPermalink && novoPermalink !== anuncio.permalink) mudancas.permalink  = novoPermalink;

    if (Object.keys(mudancas).length > 0) {
      await supabase.from("anuncios").update(mudancas).eq("id", anuncio.id);
      atualizados++;
    }
  }

  // ── Fallback para produtos sem thumbnail (MLBU catálogo ou MLB sem foto) ──
  // Para MLBU: resolve o ID de listagem MLB via /products/ ou search, depois busca thumbnail.
  // Para MLB sem foto: tenta buscar o item diretamente.
  const semThumb = anuncios.filter(a => !a.thumbnail && a.ml_item_id);

  for (const anuncio of semThumb) {
    try {
      const mlbuId   = anuncio.ml_item_id!;
      const isMLBU   = mlbuId.toUpperCase().startsWith("MLBU");
      let   thumb: string | null = null;

      if (isMLBU) {
        // 1. Tenta /products/{MLBU} → pega pictures[0].url ou thumbnail
        for (const pid of [mlbuId, "MLB" + mlbuId.slice(4)]) {
          const r = await fetch(`https://api.mercadolibre.com/products/${pid}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (r.ok) {
            const prod = await r.json();
            thumb = prod.pictures?.[0]?.url ?? prod.thumbnail ?? null;
            if (thumb) break;
          }
        }

        // 2. Se não achou, resolve o MLB do vendedor via search e busca thumbnail lá
        if (!thumb) {
          const meRes = await fetch("https://api.mercadolibre.com/users/me", {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (meRes.ok) {
            const me     = await meRes.json();
            const userId = me.id;
            // Tenta com MLBU e sem U
            for (const pid of [mlbuId, "MLB" + mlbuId.slice(4)]) {
              const sr = await fetch(
                `https://api.mercadolibre.com/users/${userId}/items/search?catalog_product_id=${pid}&limit=1`,
                { headers: { Authorization: `Bearer ${token}` } }
              );
              if (!sr.ok) continue;
              const sd = await sr.json();
              const itemId = sd.results?.[0] ?? null;
              if (!itemId) continue;
              const ir = await fetch(`https://api.mercadolibre.com/items/${itemId}?attributes=thumbnail`, {
                headers: { Authorization: `Bearer ${token}` },
              });
              if (ir.ok) {
                const item = await ir.json();
                thumb = item.thumbnail ?? null;
                if (thumb) break;
              }
            }
          }
        }
      } else {
        // MLB normal sem thumbnail: busca direto
        const r = await fetch(`https://api.mercadolibre.com/items/${mlbuId}?attributes=thumbnail`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (r.ok) {
          const item = await r.json();
          thumb = item.thumbnail ?? null;
        }
      }

      if (thumb) {
        await supabase.from("anuncios").update({ thumbnail: thumb }).eq("id", anuncio.id);
        atualizados++;
      }
    } catch {}
  }

  const mensagem = atualizados === 0
    ? `Todos os ${anuncios.length} anúncios já estão atualizados!`
    : `${atualizados} anúncio${atualizados !== 1 ? "s" : ""} atualizado${atualizados !== 1 ? "s" : ""}!`;

  return NextResponse.json({ erro: false, atualizados, mensagem, detalhes });
}
