import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getUserId } from "@/lib/session";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

function getToken(request: Request): string | null {
  const cookieHeader = request.headers.get("cookie") || "";
  const entry = cookieHeader.split("; ").find(c => c.startsWith("ml_access_token="));
  return entry ? entry.slice("ml_access_token=".length) : null;
}

// Busca SKU via user_products API (fallback para itens omnichannel)
async function buscarSkuUserProducts(
  catalogProductId: string,
  userId: string,
  token: string
): Promise<string | null> {
  try {
    const res = await fetch(
      `https://api.mercadolibre.com/users/${userId}/user_products?catalog_product_id=${catalogProductId}&status=active`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const results = Array.isArray(data) ? data : (data.results ?? []);
    return results[0]?.seller_sku ?? results[0]?.seller_custom_field ?? null;
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  const token  = getToken(request);
  const userId = getUserId(request);
  if (!token) {
    return NextResponse.json({ erro: true, mensagem: "Conta ML não conectada." });
  }
  if (!userId) {
    return NextResponse.json({ erro: true, mensagem: "Sessão inválida." });
  }

  // Busca anúncios com ml_item_id mas sem SKU (ou SKU vazio) — apenas deste usuário
  const { data: anuncios, error } = await supabase
    .from("anuncios")
    .select("id, ml_item_id, nome, sku")
    .eq("ativo", true)
    .eq("user_id", userId)
    .not("ml_item_id", "is", null)
    .or("sku.is.null,sku.eq.");

  if (error || !anuncios?.length) {
    return NextResponse.json({ atualizados: 0, mensagem: "Nenhum anúncio para atualizar." });
  }

  // Filtra apenas IDs MLB (MLBU não funciona na /items/)
  const candidatos = anuncios.filter(a =>
    a.ml_item_id?.toUpperCase().startsWith("MLB") &&
    !a.ml_item_id?.toUpperCase().startsWith("MLBU")
  );

  if (!candidatos.length) {
    return NextResponse.json({ atualizados: 0, mensagem: "Nenhum anúncio MLB sem SKU encontrado." });
  }

  // Obtém user_id uma vez (necessário para o fallback user_products)
  let userId: string | null = null;
  try {
    const meRes = await fetch("https://api.mercadolibre.com/users/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (meRes.ok) {
      const meData = await meRes.json();
      userId = String(meData.id);
    }
  } catch {}

  let atualizados = 0;
  const erros: string[] = [];

  // Busca em lotes de 20
  const LOTE = 20;
  for (let i = 0; i < candidatos.length; i += LOTE) {
    const lote = candidatos.slice(i, i + LOTE);
    const ids  = lote.map(a => a.ml_item_id).join(",");

    try {
      const res = await fetch(
        `https://api.mercadolibre.com/items?ids=${ids}&attributes=id,title,price,thumbnail,seller_custom_field,variations,catalog_product_id`,
        { headers: { Authorization: `Bearer ${token}` } }
      );

      if (!res.ok) {
        erros.push(`Lote ${i / LOTE + 1}: HTTP ${res.status}`);
        continue;
      }

      const resultados: Array<{ code: number; body: any }> = await res.json();

      for (const item of resultados) {
        if (item.code !== 200 || !item.body) continue;

        const body = item.body;

        // 1. Tenta seller_custom_field no nível do item
        let sku: string | null = body.seller_custom_field ?? null;

        // 2. Tenta nas variações
        if (!sku) {
          sku = (body.variations ?? [])
            .map((v: { seller_custom_field?: string }) => v.seller_custom_field)
            .find(Boolean) ?? null;
        }

        // 3. Fallback: busca individual completa para obter catalog_product_id
        if (!sku && userId) {
          try {
            const fullRes = await fetch(
              `https://api.mercadolibre.com/items/${body.id}`,
              { headers: { Authorization: `Bearer ${token}` } }
            );
            if (fullRes.ok) {
              const fullData = await fullRes.json();
              // Tenta seller_custom_field e variações na resposta completa
              sku = fullData.seller_custom_field ?? null;
              if (!sku) {
                sku = (fullData.variations ?? [])
                  .map((v: { seller_custom_field?: string }) => v.seller_custom_field)
                  .find(Boolean) ?? null;
              }
              // Tenta user_products com catalog_product_id da resposta completa
              if (!sku && fullData.catalog_product_id) {
                sku = await buscarSkuUserProducts(fullData.catalog_product_id, userId, token);
              }
            }
          } catch {}
        }

        const preco     = body.price ?? null;
        const thumbnail = body.thumbnail ?? null;

        const updates: Record<string, any> = {};
        if (sku)       updates.sku           = sku;
        if (preco)     updates.preco_anuncio = preco;
        if (thumbnail) updates.thumbnail     = thumbnail;

        if (Object.keys(updates).length === 0) continue;

        const { error: updateError } = await supabase
          .from("anuncios")
          .update(updates)
          .eq("ml_item_id", body.id);

        if (!updateError) atualizados++;
      }
    } catch (e) {
      erros.push(`Lote ${i / LOTE + 1}: ${e}`);
    }
  }

  return NextResponse.json({
    atualizados,
    total: candidatos.length,
    erros: erros.length ? erros : undefined,
    mensagem: `${atualizados} de ${candidatos.length} anúncio(s) atualizado(s).`,
  });
}
