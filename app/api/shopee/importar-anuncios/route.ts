import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";
import { shopeeGet } from "@/lib/shopee-api";
import { autenticarRequisicao } from "@/lib/autenticacao";
import { getShopeeLojaById } from "@/lib/shopee-auth";
import { corpoSelecaoRecusada, selecionarLojaShopee } from "@/lib/shopee-loja-selecao";

// SEC-3-B1: dados sensiveis (SEC-3) so por service_role, server-side.
// O cliente nasce sob demanda — nunca no import — a partir do helper
// oficial; o isolamento por dono e da propria rota, nao do banco.
let clienteServidor: SupabaseClient | null = null;
function supabase(): SupabaseClient {
  return (clienteServidor ??= getSupabaseServidor());
}

export async function POST(request: Request) {
  const auth = await autenticarRequisicao(request);
  const userId = auth.autenticado ? auth.uid : null;
  if (!userId) {
    return NextResponse.json({ erro: true, mensagem: "Sessão inválida." }, { status: 401 });
  }

  // MULTI-LOJA V1: importa de UMA loja EXPLICITA (loja_id no corpo ou na query),
  // conferida contra as lojas Shopee ATIVAS do dono. Com uma unica loja ativa o
  // fluxo direto continua; com duas ou mais e sem loja_id → 409
  // STORE_SELECTION_REQUIRED (a tela pergunta qual). O cookie "Usar esta" NAO decide aqui.
  const corpoPedido = await request.json().catch(() => ({})) as { loja_id?: string };
  const selecao = await selecionarLojaShopee(userId, {
    lojaIdExplicito: corpoPedido.loja_id ?? new URL(request.url).searchParams.get("loja_id"), usarCookie: false,
  });
  if (!selecao.ok) {
    if (selecao.motivo === "SEM_LOJA_SHOPEE") {
      return NextResponse.json({ erro: true, semConexao: true, mensagem: "Conta Shopee não conectada." }, { status: 401 });
    }
    const { status, corpo } = corpoSelecaoRecusada(selecao);
    return NextResponse.json(corpo, { status });
  }
  // ANUNCIOS MULTI-LOJA: anuncio Shopee historico SEM loja_id (backfill ambiguo)
  // ainda nao tem dono de loja definido. Importar agora criaria uma segunda
  // linha do mesmo item ao lado dela → recusa ANTES de qualquer chamada a Shopee.
  const { count: semLoja, error: erroSemLoja } = await supabase()
    .from("anuncios").select("id", { count: "exact", head: true })
    .eq("user_id", userId).eq("marketplace", "Shopee").is("loja_id", null);
  if (erroSemLoja) {
    return NextResponse.json({ erro: true, mensagem: "Não foi possível ler seus anúncios agora." }, { status: 503 });
  }
  if ((semLoja ?? 0) > 0) {
    return NextResponse.json({ erro: true, codigo: "ANUNCIOS_SEM_LOJA",
      mensagem: "Há anúncios Shopee antigos ainda sem loja associada. A importação fica bloqueada até essa associação ser concluída." }, { status: 409 });
  }
  // Busca a loja ESCOLHIDA com refresh automático de token
  const lojaAtiva = await getShopeeLojaById(selecao.lojaId, userId);
  if (!lojaAtiva) {
    return NextResponse.json({ erro: true, semConexao: true, mensagem: "Conta Shopee não conectada." }, { status: 401 });
  }

  const { partnerId: partner_id, partnerKey: partner_key, accessToken: access_token, shopId } = lojaAtiva;

  // ── 1. Lista todos os item_ids ativos ────────────────────────────────────
  const allItemIds: number[] = [];
  let offset = 0;
  const pageSize = 100;

  for (;;) {
    const data = await shopeeGet("/api/v2/product/get_item_list", partner_id, partner_key, access_token, shopId, {
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

  // ── 2. Busca existentes no Supabase (apenas deste usuário E desta loja) ──
  // ANUNCIOS MULTI-LOJA: a chave `item|variacao` so vale DENTRO de uma loja.
  // Leitura falha → para (mapa vazio reinseriria tudo como novo).
  const lojaId = selecao.lojaId;
  const { data: existentes, error: erroExistentes } = await supabase()
    .from("anuncios")
    .select("id, ml_item_id, variation_id, sku, custo_produto, insumos, custo_frete, imposto")
    .eq("marketplace", "Shopee")
    .eq("user_id", userId)
    .eq("loja_id", lojaId);
  if (erroExistentes) {
    return NextResponse.json({ erro: true, mensagem: "Não foi possível ler seus anúncios agora." }, { status: 503 });
  }

  const existMap = new Map<string, any>();
  for (const row of (existentes ?? [])) {
    const key = `${row.ml_item_id}|${row.variation_id ?? ""}`;
    existMap.set(key, row);
  }

  // ── 3. Detalhes em lotes de 50 ───────────────────────────────────────────
  let importados = 0;
  let atualizados = 0;
  let conflitos = 0;
  const BATCH = 50;

  for (let i = 0; i < allItemIds.length; i += BATCH) {
    const batch = allItemIds.slice(i, i + BATCH);

    const baseInfo = await shopeeGet("/api/v2/product/get_item_base_info", partner_id, partner_key, access_token, shopId, {
      item_id_list: batch.join(","),
      need_tax_info: "false",
      need_complaint_policy: "false",
    });

    const items: any[] = baseInfo?.response?.item_list ?? [];

    for (const item of items) {
      const itemId    = String(item.item_id);
      const titulo    = item.item_name ?? itemId;
      const thumbnail = item.image?.image_url_list?.[0] ?? null;

      const hasModels = (item.has_model ?? false) || (item.model_list?.length ?? 0) > 0;

      if (!hasModels) {
        // ── Sem variação ──────────────────────────────────────────────────
        // Open API v2: price_info.current_price ja vem em REAIS decimais (ex.: 18.23) —
        // mesma unidade de model_discounted_price usada pelo sync de pedidos. O "/100000"
        // era a convencao da API v1 e gravava 0.0001823 (auditoria: preco×100000 = preco vendido).
        const preco = Number(item.price_info?.[0]?.current_price ?? item.price ?? 0);
        const sku   = item.sku ?? null;
        const key   = `${itemId}|`;
        const existente = existMap.get(key);

        if (existente) {
          // `ativo` NÃO entra no update (F0.c.18A). Exclusão na CDS é
          // decisão do usuário: importar não pode ressuscitar o que ele
          // apagou. Linha ativa continua ativa; linha soft-deleted tem os
          // dados atualizados e permanece `ativo=false`.
          const upd: any = { nome: titulo, preco_anuncio: preco, thumbnail };
          if (!existente.sku && sku) upd.sku = sku;
          // loja_id NAO entra no update (preservado) e o WHERE prende dono + loja.
          await supabase().from("anuncios").update(upd).eq("id", existente.id).eq("user_id", userId).eq("loja_id", lojaId);
          atualizados++;
        } else {
          const { error: erroInsert } = await supabase().from("anuncios").insert({
            marketplace: "Shopee", nome: titulo,
            ml_item_id: itemId, variation_id: null,
            preco_anuncio: preco, sku, thumbnail,
            custo_produto: 0, insumos: 0, custo_frete: 0, imposto: 0,
            margem_desejada: 0, frete_gratis: false, ativo: true,
            user_id: userId, loja_id: lojaId,
          });
          if (erroInsert) conflitos++; else importados++;
        }
      } else {
        // ── Com variações: busca modelos ──────────────────────────────────
        const modelData = await shopeeGet("/api/v2/product/get_model_list", partner_id, partner_key, access_token, shopId, {
          item_id: item.item_id,
        });
        const models: any[] = modelData?.response?.model ?? [];

        for (const model of models) {
          const variationId = String(model.model_id);
          const nomeVar     = model.model_name ? `${titulo} - ${model.model_name}` : titulo;
          const preco       = Number(model.price_info?.[0]?.current_price ?? 0);   // reais (ver acima)
          const sku         = model.model_sku ?? null;
          const key         = `${itemId}|${variationId}`;
          const existente   = existMap.get(key);

          if (existente) {
            // Ver comentário acima: `ativo` fora do update.
            const upd: any = { nome: nomeVar, preco_anuncio: preco, thumbnail };
            if (!existente.sku && sku) upd.sku = sku;
            await supabase().from("anuncios").update(upd).eq("id", existente.id).eq("user_id", userId).eq("loja_id", lojaId);
            atualizados++;
          } else {
            const { error: erroInsert } = await supabase().from("anuncios").insert({
              marketplace: "Shopee", nome: nomeVar,
              ml_item_id: itemId, variation_id: variationId,
              preco_anuncio: preco, sku, thumbnail,
              custo_produto: 0, insumos: 0, custo_frete: 0, imposto: 0,
              margem_desejada: 0, frete_gratis: false, ativo: true,
              user_id: userId, loja_id: lojaId,
            });
            // UNIQUE da fase 2: importacao concorrente da MESMA loja → conflito, nunca segunda linha
            if (erroInsert) conflitos++; else importados++;
          }
        }
      }
    }

    if (i + BATCH < allItemIds.length) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  return NextResponse.json({ importados, atualizados, conflitos, total: allItemIds.length, loja_id: lojaId });
}
