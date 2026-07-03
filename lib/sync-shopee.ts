/**
 * sync-shopee.ts -- Sync completo Shopee -> Supabase (tabela pedidos)
 *
 * CORRECOES v2:
 * BUG 1 CORRIGIDO: COMPLETED filtrado no create_time causava -20-40% de pedidos.
 *   -> create_time: inclui TODOS os status (COMPLETED = entregue = valido)
 *   -> update_time: filtra COMPLETED (evita pedidos antigos com update hoje)
 *
 * BUG 2 CORRIGIDO: response_optional_fields incompleto.
 *   -> Agora busca: actual_shipping_fee, payment_method, package_list,
 *     recipient_address, buyer_username, estimated_shipping_fee
 *   -> Extrai imagem direto do item_list[].image_info.image_url
 *
 * BUG 3 NOVO: Retry com backoff exponencial (3 tentativas, 1s->2s->4s)
 *
 * Retorna { found, inserted } para validacao externa.
 */
import { createClient } from "@supabase/supabase-js";
import { shopeeGet } from "@/lib/shopee-api";
import { obterFaixaShopee, TAXA_CAMPANHA_SHOPEE } from "@/lib/comissoes-shopee";
import { getShopeeLojaAtiva } from "@/lib/shopee-auth";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

function mapStatus(s: string): string {
  const m: Record<string, string> = {
    UNPAID:             "pending",
    READY_TO_SHIP:      "paid",
    PROCESSED:          "paid",
    SHIPPED:            "paid",
    TO_CONFIRM_RECEIVE: "paid",
    COMPLETED:          "paid",
    CANCELLED:          "cancelled",
    IN_CANCEL:          "cancelled",
    TO_RETURN:          "devolucao",
  };
  return m[s] ?? "paid";
}

async function withRetry<T>(
  fn: () => Promise<T>,
  tentativas = 3,
  delayMs = 1000
): Promise<T> {
  let ultimoErro: unknown;
  for (let i = 0; i < tentativas; i++) {
    try {
      return await fn();
    } catch (e) {
      ultimoErro = e;
      if (i < tentativas - 1) {
        await new Promise(r => setTimeout(r, delayMs * Math.pow(2, i)));
      }
    }
  }
  throw ultimoErro;
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split("T")[0];
}

function gerarChunks(from: string, to: string): Array<{ from: string; to: string }> {
  const chunks: Array<{ from: string; to: string }> = [];
  let cur = from;
  while (cur <= to) {
    const end = addDays(cur, 13);
    chunks.push({ from: cur, to: end > to ? to : end });
    cur = addDays(end, 1);
  }
  return chunks;
}

export interface SyncShopeeResult {
  found:    number;
  inserted: number;
}

export async function syncShopeeForUser(
  userId:      string,
  dateFrom:    string,
  dateTo:      string,
  noBuffer     = false,
  lojaOverride?: {
    lojaId: string; partnerId: string; partnerKey: string;
    accessToken: string; shopId: number; nickname: string;
  }
): Promise<number> {
  const result = await syncShopeeForUserV2(userId, dateFrom, dateTo, noBuffer, lojaOverride);
  return result.inserted;
}

export async function syncShopeeForUserV2(
  userId:      string,
  dateFrom:    string,
  dateTo:      string,
  noBuffer     = false,
  lojaOverride?: {
    lojaId: string; partnerId: string; partnerKey: string;
    accessToken: string; shopId: number; nickname: string;
  }
): Promise<SyncShopeeResult> {
  const loja = lojaOverride ?? await getShopeeLojaAtiva(userId);
  if (!loja) return { found: 0, inserted: 0 };

  const { partnerId: partner_id, partnerKey: partner_key, accessToken: access_token, shopId, nickname } = loja;

  // noBuffer=true  -> Historico: create_time
  //   Inclui TODOS os status -- COMPLETED (entregue) e valido no range
  //   NAO filtrar COMPLETED aqui (era bug: -20-40% pedidos perdidos silenciosamente)
  //
  // noBuffer=false -> Cron diario: update_time
  //   Pedidos com qualquer update hoje -- pode incluir pedidos antigos
  //   Filtra COMPLETED (pedidos de meses atras com update de entrega hoje)
  const timeRangeField   = noBuffer ? "create_time" : "update_time";
  const filtrarCompleted = !noBuffer;

  const chunks = gerarChunks(dateFrom, dateTo);

  // 1. Listagem: todas as paginas via cursor
  const allOrderSns: string[] = [];

  for (const chunk of chunks) {
    const chunkFrom = Math.floor(new Date(`${chunk.from}T00:00:00-03:00`).getTime() / 1000);
    const chunkTo   = Math.floor(new Date(`${chunk.to}T23:59:59-03:00`).getTime() / 1000);
    let cursor = "";

    for (;;) {
      const params: Record<string, string | number> = {
        time_range_field:         timeRangeField,
        time_from:                chunkFrom,
        time_to:                  chunkTo,
        page_size:                100,
        response_optional_fields: "order_status",
      };
      if (cursor) params.cursor = cursor;

      const data = await withRetry(() =>
        shopeeGet("/api/v2/order/get_order_list", partner_id, partner_key, access_token, shopId, params)
      );

      if (data?.error && data.error !== "") {
        throw new Error(`Shopee API error: ${data.error} -- ${data.message ?? ""}`);
      }

      const list: any[] = data?.response?.order_list ?? [];

      // CORRECAO BUG 1:
      // create_time: inclui TODOS os status -- COMPLETED = entregue mas valido
      // update_time: exclui COMPLETED -- sao pedidos antigos com update hoje (entrega)
      const sns = filtrarCompleted
        ? list.filter((o: any) => (o.order_status ?? "") !== "COMPLETED").map((o: any) => o.order_sn)
        : list.map((o: any) => o.order_sn);

      allOrderSns.push(...sns);

      if (!data?.response?.more || !data?.response?.next_cursor) break;
      cursor = data.response.next_cursor;
    }
  }

  const found = allOrderSns.length;
  if (found === 0) return { found: 0, inserted: 0 };

  // 2. Anuncios cadastrados
  const { data: anuncios } = await supabase
    .from("anuncios")
    .select("id, ml_item_id, variation_id, sku, custo_produto, insumos, imposto")
    .eq("marketplace", "Shopee")
    .eq("ativo", true)
    .eq("user_id", userId);

  const mapaAnuncios = new Map<string, any>();
  for (const a of (anuncios ?? [])) {
    const key = a.variation_id ? `${a.ml_item_id}|${a.variation_id}` : `${a.ml_item_id}|`;
    mapaAnuncios.set(key, a);
    if (!mapaAnuncios.has(`${a.ml_item_id}|`)) mapaAnuncios.set(`${a.ml_item_id}|`, a);
  }

  // 3. Detalhes em paralelo (50 por batch, 10 concurrent)
  // CORRECAO BUG 2: response_optional_fields completos
  const DETAIL_FIELDS = [
    "item_list",
    "order_status",
    "create_time",
    "pay_time",
    "total_amount",
    "actual_shipping_fee",
    "estimated_shipping_fee",
    "payment_method",
    "package_list",
    "recipient_address",
    "buyer_username",
    "shipping_carrier",
    "cancel_reason",
    "buyer_cancel_reason",
  ].join(",");

  const BATCH       = 50;
  const CONCURRENCY = 10;
  const batches: string[][] = [];
  for (let i = 0; i < allOrderSns.length; i += BATCH) {
    batches.push(allOrderSns.slice(i, i + BATCH));
  }

  const allDetails: any[] = [];
  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const grupo = batches.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      grupo.map(batch =>
        withRetry(() =>
          shopeeGet("/api/v2/order/get_order_detail", partner_id, partner_key, access_token, shopId, {
            order_sn_list:            batch.join(","),
            response_optional_fields: DETAIL_FIELDS,
          })
        )
      )
    );
    allDetails.push(...results);
  }

  // 4. Monta linhas
  const rows: any[] = [];
  const now = new Date().toISOString();

  for (const detail of allDetails) {
    for (const order of (detail?.response?.order_list ?? [])) {
      const status   = order.order_status ?? "UNKNOWN";
      const ts       = order.pay_time || order.create_time || 0;
      const dataBrt  = new Date((ts - 3 * 3600) * 1000).toISOString().split("T")[0];

      if (dataBrt < dateFrom || dataBrt > dateTo) continue;

      const freteReal      = Number(order.actual_shipping_fee   ?? 0);
      const freteEstimado  = Number(order.estimated_shipping_fee ?? 0);
      const formaPagamento = order.payment_method ?? null;
      const buyerUsername  = order.buyer_username ?? null;

      const addr        = order.recipient_address ?? {};
      const buyerCidade = addr.city    ?? addr.district ?? null;
      const buyerEstado = addr.state   ?? null;

      const packages      = order.package_list ?? [];
      const firstPkg      = packages[0] ?? {};
      const rastreio      = firstPkg.package_number ?? null;
      const transportadora = order.shipping_carrier ?? firstPkg.logistics_status ?? null;

      for (const item of (order.item_list ?? [])) {
        const itemIdStr   = String(item.item_id);
        const variationId = item.model_id ? String(item.model_id) : null;
        const valorUnit   = Number(item.model_discounted_price ?? item.model_original_price ?? 0);
        const qtd         = Number(item.model_quantity_purchased ?? 1);
        const faturamento = valorUnit * qtd;

        const imagemUrl = item.image_info?.image_url ?? item.cover_image ?? null;
        const itemSku   = item.model_sku || item.item_sku || null;

        const keyVar  = variationId ? `${itemIdStr}|${variationId}` : `${itemIdStr}|`;
        const anuncio = mapaAnuncios.get(keyVar) ?? mapaAnuncios.get(`${itemIdStr}|`) ?? null;

        const custo         = anuncio ? ((anuncio.custo_produto || 0) + (anuncio.insumos || 0)) * qtd : 0;
        const impostoVal    = anuncio ? faturamento * ((anuncio.imposto || 0) / 100) : 0;
        const faixa         = obterFaixaShopee(valorUnit);
        const tarifaVenda   = faturamento * (faixa.comissao + TAXA_CAMPANHA_SHOPEE);
        // freteReal (actual_shipping_fee) = frete pago pelo COMPRADOR à Shopee, NÃO é custo do vendedor.
        // Além disso é um campo de nível de PEDIDO; aplicá-lo por item causaria multi-contagem.
        // O custo de frete do vendedor (ex: etiqueta Shopee) deve ser registrado em anuncio.custo_frete.
        const custoFrete    = anuncio?.custo_frete ? (anuncio.custo_frete as number) * qtd : 0;
        const margemContrib = faturamento - tarifaVenda - custo - impostoVal - custoFrete;
        const mcPercent     = faturamento > 0 ? (margemContrib / faturamento) * 100 : 0;
        const lucroLiquido  = margemContrib;
        const roi           = custo > 0 ? (lucroLiquido / custo) * 100 : 0;

        rows.push({
          id:               `${userId}_SHOPEE_${order.order_sn}_${itemIdStr}_${variationId ?? "nv"}`,
          user_id:          userId,
          marketplace:      "Shopee",
          order_id:         order.order_sn,
          data:             dataBrt,
          anuncio:          item.item_name ?? itemIdStr,
          ml_item_id:       itemIdStr,
          variation_id:     variationId,
          conta:            nickname,
          sku:              itemSku ?? anuncio?.sku ?? null,
          status:           mapStatus(status),
          frete:            "comprador",
          logistica:        "Shopee",
          valor_unit:       valorUnit,
          qtd,
          faturamento,
          custo,
          imposto:          impostoVal,
          tarifa_venda:     tarifaVenda,
          frete_comprador:  0,
          frete_vendedor:   custoFrete,   // custo_frete do anuncio (frete do vendedor real)
          frete_real:       freteReal,    // actual_shipping_fee Shopee (frete do comprador, só referência)
          frete_estimado:   freteEstimado,
          margem_contrib:   margemContrib,
          mc_percent:       mcPercent,
          lucro_liquido:    lucroLiquido,
          roi,
          forma_pagamento:  formaPagamento,
          codigo_rastreio:  rastreio,
          transportadora,
          imagem_url:       imagemUrl,
          buyer_username:   buyerUsername,
          buyer_cidade:     buyerCidade,
          buyer_estado:     buyerEstado,
          cadastrado:       !!anuncio,
          synced_at:        now,
        });
      }
    }
  }

  // 5. Upsert em lotes de 250
  const UPSERT_BATCH = 250;
  for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
    await supabase
      .from("pedidos")
      .upsert(rows.slice(i, i + UPSERT_BATCH), { onConflict: "id" });
  }

  return { found, inserted: rows.length };
}
