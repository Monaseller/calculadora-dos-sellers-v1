/**
 * Sync de pedidos Shopee → tabela `pedidos` (Supabase).
 * Chamado pelo cron horário e pelo endpoint de vendas quando cache está vazio/stale.
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

export async function syncShopeeForUser(
  userId: string,
  dateFrom: string,
  dateTo: string
): Promise<number> {
  const loja = await getShopeeLojaAtiva(userId);
  if (!loja) return 0;

  const { partnerId: partner_id, partnerKey: partner_key, accessToken: access_token, shopId, nickname } = loja;

  // Busca por create_time com janela estendida (-7 dias) para capturar pedidos
  // cujo pagamento (pay_time) cai dentro do período mesmo criados antes.
  // Nota: pay_time não é suportado como time_range_field pela API Shopee v2.
  function addDaysShopee(iso: string, n: number): string {
    const d = new Date(`${iso}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().split("T")[0];
  }
  const fetchFrom = addDaysShopee(dateFrom, -7);
  const timeFrom  = Math.floor(new Date(`${fetchFrom}T00:00:00-03:00`).getTime() / 1000);
  const timeTo    = Math.floor(new Date(`${dateTo}T23:59:59-03:00`).getTime() / 1000);

  // ── 1. Lista orderSNs ────────────────────────────────────────────────────────
  const allOrderSns: string[] = [];
  let cursor = "";

  for (;;) {
    const params: Record<string, string | number> = {
      time_range_field:         "create_time",  // pay_time não é válido na API Shopee v2
      time_from:                timeFrom,
      time_to:                  timeTo,
      page_size:                50,
      response_optional_fields: "order_status",
    };
    if (cursor) params.cursor = cursor;

    const data = await shopeeGet("/api/v2/order/get_order_list", partner_id, partner_key, access_token, shopId, params);

    // Detecta erros da API Shopee (ex: token expirado, assinatura inválida)
    if (data?.error && data.error !== "") {
      throw new Error(`Shopee API error: ${data.error} – ${data.message ?? "sem mensagem"}`);
    }

    const list: any[] = data?.response?.order_list ?? [];
    allOrderSns.push(...list.map((o: any) => o.order_sn));

    if (!data?.response?.more || !data?.response?.next_cursor) break;
    cursor = data.response.next_cursor;
  }

  if (allOrderSns.length === 0) return 0;

  // ── 2. Anúncios cadastrados ───────────────────────────────────────────────────
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

  // ── 3. Detalhes em paralelo (5 por vez) ─────────────────────────────────────
  const BATCH = 50;
  const CONCURRENCY = 5;
  const batches: string[][] = [];
  for (let i = 0; i < allOrderSns.length; i += BATCH) {
    batches.push(allOrderSns.slice(i, i + BATCH));
  }

  const allDetails: any[] = [];
  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const chunk = batches.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      chunk.map(batch =>
        shopeeGet("/api/v2/order/get_order_detail", partner_id, partner_key, access_token, shopId, {
          order_sn_list:            batch.join(","),
          response_optional_fields: "item_list,total_amount,order_status,create_time,pay_time",
        })
      )
    );
    allDetails.push(...results);
  }

  // ── 4. Monta linhas ───────────────────────────────────────────────────────────
  const rows: any[] = [];
  const now = new Date().toISOString();

  for (const detail of allDetails) {
    for (const order of (detail?.response?.order_list ?? [])) {
      const status  = order.order_status ?? "UNKNOWN";
      const ts      = order.pay_time || order.create_time || 0;
      const dataBrt = new Date((ts - 3 * 3600) * 1000).toISOString().split("T")[0];

      // Só armazena pedidos cujo pay_time (ou create_time) cai dentro do range real
      if (dataBrt < dateFrom || dataBrt > dateTo) continue;

      for (const item of (order.item_list ?? [])) {
        const itemIdStr   = String(item.item_id);
        const variationId = item.model_id ? String(item.model_id) : null;
        const valorUnit   = item.model_discounted_price ?? item.model_original_price ?? 0;
        const qtd         = item.model_quantity_purchased ?? 1;
        const faturamento = valorUnit * qtd;

        const keyVar  = variationId ? `${itemIdStr}|${variationId}` : `${itemIdStr}|`;
        const anuncio = mapaAnuncios.get(keyVar) ?? mapaAnuncios.get(`${itemIdStr}|`) ?? null;

        const custo       = anuncio ? ((anuncio.custo_produto || 0) + (anuncio.insumos || 0)) * qtd : 0;
        const impostoVal  = anuncio ? faturamento * ((anuncio.imposto || 0) / 100) : 0;
        const faixa       = obterFaixaShopee(valorUnit);
        const tarifaVenda = faturamento * (faixa.comissao + TAXA_CAMPANHA_SHOPEE);
        const margemContrib = faturamento - tarifaVenda - custo - impostoVal;
        const mcPercent     = faturamento > 0 ? (margemContrib / faturamento) * 100 : 0;

        rows.push({
          id:              `${userId}_SHOPEE_${order.order_sn}_${itemIdStr}_${variationId ?? "nv"}`,
          user_id:         userId,
          marketplace:     "Shopee",
          order_id:        order.order_sn,
          data:            dataBrt,
          anuncio:         item.item_name ?? itemIdStr,
          ml_item_id:      itemIdStr,
          variation_id:    variationId,
          conta:           nickname,
          sku:             item.model_sku || anuncio?.sku || null,
          status:          mapStatus(status),
          frete:           "comprador",
          logistica:       "Shopee",
          valor_unit:      valorUnit,
          qtd,
          faturamento,
          custo,
          imposto:         impostoVal,
          tarifa_venda:    tarifaVenda,
          frete_comprador: 0,
          frete_vendedor:  0,
          margem_contrib:  margemContrib,
          mc_percent:      mcPercent,
          cadastrado:      !!anuncio,
          synced_at:       now,
        });
      }
    }
  }

  // ── 5. Upsert em lotes de 100 ────────────────────────────────────────────────
  const UPSERT_BATCH = 100;
  for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
    await supabase
      .from("pedidos")
      .upsert(rows.slice(i, i + UPSERT_BATCH), { onConflict: "id" });
  }

  return rows.length;
}
