import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { calcularFreteMl, calcularFreteFullMl, calcularFreteFlexMl } from "@/lib/tabela-frete-ml";
import { CATEGORIAS_ML } from "@/lib/comissoes-mercado-livre";
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

function mapTipoAnuncio(listingTypeId: string): string {
  return (listingTypeId === "gold_premium" || listingTypeId === "gold_pro") ? "Premium" : "Clássico";
}

function mapLogisticType(t: string): string {
  const m: Record<string, string> = {
    fulfillment: "fulfillment",
    self_service: "self_service",
    me2: "me2",
    me1: "me1",
    drop_off: "drop_off",
    xd_drop_off: "xd_drop_off",
    cross_docking: "cross_docking",
  };
  return m[t] ?? t;
}

function parsePeso(dim: string | null | undefined, attributes: any[]): number | null {
  // 1. Tenta atributos (WEIGHT)
  if (Array.isArray(attributes)) {
    const attr = attributes.find(
      (a: any) => ["WEIGHT", "SHIPPING_WEIGHT", "ITEM_WEIGHT", "NET_WEIGHT"].includes((a.id ?? "").toUpperCase())
    );
    if (attr?.value_name) {
      const s = String(attr.value_name).toLowerCase().trim();
      const g = s.match(/^([\d.,]+)\s*g$/);
      if (g) { const v = parseFloat(g[1].replace(",", ".")) / 1000; if (v > 0 && v <= 150) return v; }
      const kg = s.match(/^([\d.,]+)\s*kg$/);
      if (kg) { const v = parseFloat(kg[1].replace(",", ".")); if (v > 0 && v <= 150) return v; }
    }
  }
  // 2. Tenta shipping.dimensions "LxWxH,peso"
  if (dim) {
    const m = dim.match(/^[\d.]+[xX][\d.]+[xX][\d.]+,\s*([\d.]+)/);
    if (m) {
      const w = parseFloat(m[1]);
      if (w > 0) {
        const kg = w >= 20 ? w / 1000 : w;
        if (kg >= 0.001 && kg <= 150) return kg;
      }
    }
  }
  return null;
}

// Tenta mapear categoria ML → nossa lista de CATEGORIAS_ML
function mapCategoria(mlCategoryName: string | null): string | null {
  if (!mlCategoryName) return null;
  const nameLower = mlCategoryName.toLowerCase();
  // Match exato primeiro
  const exact = CATEGORIAS_ML.find(c => c.nome.toLowerCase() === nameLower);
  if (exact) return exact.nome;
  // Match parcial
  const partial = CATEGORIAS_ML.find(c =>
    nameLower.includes(c.nome.toLowerCase()) || c.nome.toLowerCase().includes(nameLower.split(/[,>/]/)[0].trim())
  );
  return partial ? partial.nome : null;
}

export async function POST(request: Request) {
  const token  = getToken(request);
  const userId = getUserId(request);
  if (!token) {
    return NextResponse.json({ erro: true, mensagem: "Conta do ML não conectada." }, { status: 401 });
  }
  if (!userId) {
    return NextResponse.json({ erro: true, mensagem: "Sessão inválida." }, { status: 401 });
  }

  const meRes = await fetch("https://api.mercadolibre.com/users/me", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!meRes.ok) {
    return NextResponse.json({ erro: true, mensagem: "Token ML expirado." }, { status: 401 });
  }
  const me = await meRes.json();
  const sellerId = me.id as number;

  // ── 1. Busca todos os IDs de anúncios ativos ────────────────────────────
  const allItemIds: string[] = [];
  let offset = 0;
  const limit = 100;

  for (;;) {
    const r = await fetch(
      `https://api.mercadolibre.com/users/${sellerId}/items/search?status=active&limit=${limit}&offset=${offset}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!r.ok) break;
    const data = await r.json();
    const results: string[] = data.results ?? [];
    allItemIds.push(...results);
    if (results.length < limit) break;
    offset += limit;
  }

  if (allItemIds.length === 0) {
    return NextResponse.json({ importados: 0, atualizados: 0, erros: 0, total: 0 });
  }

  // ── 2. Cache de categorias ML ────────────────────────────────────────────
  const categoryCache = new Map<string, string | null>();

  async function getCategoryName(categoryId: string): Promise<string | null> {
    if (categoryCache.has(categoryId)) return categoryCache.get(categoryId)!;
    try {
      const r = await fetch(`https://api.mercadolibre.com/categories/${categoryId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) { categoryCache.set(categoryId, null); return null; }
      const data = await r.json();
      // Pega o segundo nível da hierarquia (primeiro útil depois do root)
      const pathFromRoot: any[] = data.path_from_root ?? [];
      const name = pathFromRoot.length >= 2 ? pathFromRoot[1].name : (data.name ?? null);
      categoryCache.set(categoryId, name);
      return name;
    } catch {
      categoryCache.set(categoryId, null);
      return null;
    }
  }

  // ── 3. Busca anúncios existentes no Supabase (apenas deste usuário) ──────
  const { data: existentes } = await supabase
    .from("anuncios")
    .select("id, ml_item_id, variation_id, sku, custo_produto, insumos, custo_frete, imposto, peso_kg, preco_anuncio")
    .eq("marketplace", "ML")
    .eq("user_id", userId);

  // Mapa: "ml_item_id|variation_id" → row
  const existMap = new Map<string, any>();
  for (const row of (existentes ?? [])) {
    const key = `${row.ml_item_id}|${row.variation_id ?? ""}`;
    existMap.set(key, row);
  }

  // ── 4. Busca detalhes em batches de 20 ──────────────────────────────────
  let importados = 0;
  let atualizados = 0;
  let erros = 0;

  const BATCH = 20;
  for (let i = 0; i < allItemIds.length; i += BATCH) {
    const batch = allItemIds.slice(i, i + BATCH);
    const idsParam = batch.join(",");

    let items: any[];
    try {
      const r = await fetch(
        `https://api.mercadolibre.com/items?ids=${idsParam}&include_attributes=all`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!r.ok) { erros += batch.length; continue; }
      const raw: any[] = await r.json();
      // Cada elemento é { code: 200, body: {...} } ou { code: 404, body: null }
      items = raw
        .filter((x: any) => x.code === 200 && x.body)
        .map((x: any) => x.body);
    } catch {
      erros += batch.length;
      continue;
    }

    for (const item of items) {
      try {
        const itemId: string = item.id;
        const titulo: string = item.title ?? itemId;
        const tipoAnuncio = mapTipoAnuncio(item.listing_type_id ?? "");
        const logisticType = mapLogisticType(item.shipping?.logistic_type ?? "");
        const freteGratis: boolean = item.shipping?.free_shipping === true;
        const dim: string | null = item.shipping?.dimensions ?? null;
        const attrs: any[] = item.attributes ?? [];
        const pesoBase = parsePeso(dim, attrs);

        // Categoria
        const catName = await getCategoryName(item.category_id ?? "");
        const categoria = mapCategoria(catName);

        const variations: any[] = item.variations ?? [];
        const thumbnail: string | null = item.thumbnail ?? item.pictures?.[0]?.url ?? null;
        const permalink: string | null = item.permalink ?? null;

        if (variations.length === 0) {
          // ── Item sem variação ──────────────────────────────────────────
          const preco: number = item.price ?? 0;
          const sku: string | null = item.seller_custom_field ?? null;
          const key = `${itemId}|`;
          const existente = existMap.get(key);

          const pesoKg = pesoBase;
          const custoFrete = calcularFreteParaItem(pesoKg, preco, logisticType, freteGratis);

          if (existente) {
            const upd: any = {
              nome: titulo,
              preco_anuncio: preco,
              tipo_anuncio: tipoAnuncio,
              logistic_type: logisticType,
              frete_gratis: freteGratis,
              ativo: true,
              thumbnail,
              permalink,
            };
            if (!existente.peso_kg && pesoKg) upd.peso_kg = pesoKg;
            if (!existente.custo_frete && custoFrete) upd.custo_frete = custoFrete;
            if (!existente.sku && sku) upd.sku = sku;
            await supabase.from("anuncios").update(upd).eq("id", existente.id);
            atualizados++;
          } else {
            await supabase.from("anuncios").insert({
              marketplace: "ML",
              nome: titulo,
              ml_item_id: itemId,
              variation_id: null,
              preco_anuncio: preco,
              tipo_anuncio: tipoAnuncio,
              categoria,
              logistic_type: logisticType,
              frete_gratis: freteGratis,
              peso_kg: pesoKg,
              custo_frete: custoFrete ?? 0,
              sku: sku ?? null,
              thumbnail,
              permalink,
              custo_produto: 0,
              insumos: 0,
              imposto: 0,
              margem_desejada: 0,
              ativo: true,
              user_id: userId,
            });
            importados++;
          }
        } else {
          // ── Item com variações ────────────────────────────────────────
          for (const v of variations) {
            const variationId = String(v.id);
            const varAttrs: any[] = v.attribute_combinations ?? [];
            const varDesc = varAttrs.map((a: any) => a.value_name).filter(Boolean).join(" / ");
            const nomeVar = varDesc ? `${titulo} - ${varDesc}` : titulo;
            const preco: number = v.price ?? item.price ?? 0;
            const sku: string | null = v.seller_custom_field ?? null;

            // Thumbnail da variação: tenta picture da variação, fallback para item
            const varPicId: string | null = v.picture_ids?.[0] ?? null;
            const varThumb: string | null = varPicId
              ? (item.pictures?.find((p: any) => p.id === varPicId)?.url ?? thumbnail)
              : thumbnail;

            // Peso da variação (tenta atributos da variação, fallback para item)
            const varAtributos: any[] = v.attributes ?? [];
            const pesoKg = parsePeso(dim, [...varAtributos, ...attrs]);
            const custoFrete = calcularFreteParaItem(pesoKg, preco, logisticType, freteGratis);

            const key = `${itemId}|${variationId}`;
            const existente = existMap.get(key);

            if (existente) {
              const upd: any = {
                nome: nomeVar,
                preco_anuncio: preco,
                tipo_anuncio: tipoAnuncio,
                logistic_type: logisticType,
                frete_gratis: freteGratis,
                ativo: true,
                thumbnail: varThumb,
                permalink,
              };
              if (!existente.peso_kg && pesoKg) upd.peso_kg = pesoKg;
              if (!existente.custo_frete && custoFrete) upd.custo_frete = custoFrete;
              if (!existente.sku && sku) upd.sku = sku;
              await supabase.from("anuncios").update(upd).eq("id", existente.id);
              atualizados++;
            } else {
              await supabase.from("anuncios").insert({
                marketplace: "ML",
                nome: nomeVar,
                ml_item_id: itemId,
                variation_id: variationId,
                preco_anuncio: preco,
                tipo_anuncio: tipoAnuncio,
                categoria,
                logistic_type: logisticType,
                frete_gratis: freteGratis,
                peso_kg: pesoKg,
                custo_frete: custoFrete ?? 0,
                sku: sku ?? null,
                thumbnail: varThumb,
                permalink,
                custo_produto: 0,
                insumos: 0,
                imposto: 0,
                margem_desejada: 0,
                ativo: true,
                user_id: userId,
              });
              importados++;
            }
          }
        }
      } catch {
        erros++;
      }
    }

    // Pequena pausa entre batches para não estourar rate limit do ML
    if (i + BATCH < allItemIds.length) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  return NextResponse.json({ importados, atualizados, erros, total: allItemIds.length });
}

// Calcula custo de frete com base na logística do item
function calcularFreteParaItem(
  pesoKg: number | null,
  preco: number,
  logisticType: string,
  freteGratis: boolean
): number | null {
  if (!preco) return null;
  if (logisticType === "self_service") {
    return calcularFreteFlexMl(preco);
  }
  if (logisticType === "fulfillment") {
    if (!pesoKg) return null;
    return calcularFreteFullMl("P", preco, pesoKg); // tamanho P como proxy; usuário pode ajustar
  }
  // me2, drop_off, cross_docking, etc.
  if (pesoKg) return calcularFreteMl(pesoKg, preco);
  return null;
}
