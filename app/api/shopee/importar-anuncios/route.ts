import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { shopeeGet, shopeePost } from "@/lib/shopee-api";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

function getShopeeAuth(request: Request): { token: string; shopId: number } | null {
  const cookies = request.headers.get("cookie") || "";
  const token   = cookies.split("; ").find(c => c.startsWith("shopee_access_token="))?.slice("shopee_access_token=".length) ?? "";
  const shopId  = Number(cookies.split("; ").find(c => c.startsWith("shopee_shop_id="))?.slice("shopee_shop_id=".length) ?? 0);
  if (!token || !shopId) return null;
  return { token, shopId };
}

export async function POST(request: Request) {
  const auth = getShopeeAuth(request);
  if (!auth) {
    return NextResponse.json({ erro: true, mensagem: "Conta Shopee não conectada." }, { status: 401 });
  }

  const { token, shopId } = auth;

  // ── 1. Lista todos os item_ids ativos ────────────────────────────────────
  const allItemIds: number[] = [];
  let offset = 0;
  const pageSize = 100;

  for (;;) {
    const data = await shopeeGet("/api/v2/product/get_item_list", token, shopId, {
      offset,
      page_size: pageSize,
      item_status: "NORMAL",
    });

    const items: any[] = data?.response?.item ?? [];
    allItemIds.push(...items.map((i: any) => i.item_id));

    if (!data?.response?.has_next_page) break;
    offset += pageSize;
  }

  if (allItemIds.length === 0) {
    return NextResponse.json({ importados: 0, atualizados: 0, total: 0 });
  }

  // ── 2. Busca existentes no Supabase ──────────────────────────────────────
  const { data: existentes } = await supabase
    .from("anuncios")
    .select("id, ml_item_id, variation_id, sku, custo_produto, insumos, custo_frete, imposto")
    .eq("marketplace", "Shopee");

  const existMap = new Map<string, any>();
  for (const row of (existentes ?? [])) {
    const key = `${row.ml_item_id}|${row.variation_id ?? ""}`;
    existMap.set(key, row);
  }

  // ── 3. Detalhes em lotes de 50 ───────────────────────────────────────────
  let importados = 0;
  let atualizados = 0;
  const BATCH = 50;

  for (let i = 0; i < allItemIds.length; i += BATCH) {
    const batch = allItemIds.slice(i, i + BATCH);

    const baseInfo = await shopeeGet("/api/v2/product/get_item_base_info", token, shopId, {
      item_id_list: batch.join(","),
      need_tax_info: "false",
      need_complaint_policy: "false",
    });

    const items: any[] = baseInfo?.response?.item_list ?? [];

    for (const item of items) {
      const itemId   = String(item.item_id);
      const titulo   = item.item_name ?? itemId;
      const thumbnail = item.image?.image_url_list?.[0] ?? null;

      // Verifica se tem variações (modelos)
      const hasModels = (item.has_model ?? false) || (item.model_list?.length ?? 0) > 0;

      if (!hasModels) {
        // ── Sem variação ──────────────────────────────────────────────────
        const preco = (item.price_info?.[0]?.current_price ?? item.price ?? 0) / 100000;
        const sku   = item.sku ?? null;
        const key   = `${itemId}|`;
        const existente = existMap.get(key);

        if (existente) {
          const upd: any = { nome: titulo, preco_anuncio: preco, thumbnail, ativo: true };
          if (!existente.sku && sku) upd.sku = sku;
          await supabase.from("anuncios").update(upd).eq("id", existente.id);
          atualizados++;
        } else {
          await supabase.from("anuncios").insert({
            marketplace: "Shopee", nome: titulo,
            ml_item_id: itemId, variation_id: null,
            preco_anuncio: preco, sku, thumbnail,
            custo_produto: 0, insumos: 0, custo_frete: 0, imposto: 0,
            margem_desejada: 0, frete_gratis: false, ativo: true,
          });
          importados++;
        }
      } else {
        // ── Com variações: busca modelos ──────────────────────────────────
        const modelData = await shopeeGet("/api/v2/product/get_model_list", token, shopId, {
          item_id: item.item_id,
        });
        const models: any[] = modelData?.response?.model ?? [];

        for (const model of models) {
          const variationId = String(model.model_id);
          const nomeVar     = model.model_name ? `${titulo} - ${model.model_name}` : titulo;
          const preco       = (model.price_info?.[0]?.current_price ?? 0) / 100000;
          const sku         = model.model_sku ?? null;
          const key         = `${itemId}|${variationId}`;
          const existente   = existMap.get(key);

          if (existente) {
            const upd: any = { nome: nomeVar, preco_anuncio: preco, thumbnail, ativo: true };
            if (!existente.sku && sku) upd.sku = sku;
            await supabase.from("anuncios").update(upd).eq("id", existente.id);
            atualizados++;
          } else {
            await supabase.from("anuncios").insert({
              marketplace: "Shopee", nome: nomeVar,
              ml_item_id: itemId, variation_id: variationId,
              preco_anuncio: preco, sku, thumbnail,
              custo_produto: 0, insumos: 0, custo_frete: 0, imposto: 0,
              margem_desejada: 0, frete_gratis: false, ativo: true,
            });
            importados++;
          }
        }
      }
    }

    if (i + BATCH < allItemIds.length) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  return NextResponse.json({ importados, atualizados, total: allItemIds.length });
}
