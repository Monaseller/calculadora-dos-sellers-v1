/**
 * GET /api/debug/pending-compare
 * PASSO 1+2: Compara status dos pedidos pending do banco com API Shopee (status atual).
 * PASSO 3-6: Se ?sync=1, executa sync incremental de 2026-07-02 e relata resultado final.
 *
 * Uso:
 *   http://localhost:3000/api/debug/pending-compare          → só compara
 *   http://localhost:3000/api/debug/pending-compare?sync=1   → compara + sincroniza + relatório
 */
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getUserId } from "@/lib/session";
import { getShopeeLojaAtiva } from "@/lib/shopee-auth";
import { shopeeGet } from "@/lib/shopee-api";
import { syncShopeeForUser } from "@/lib/sync-shopee";

export const maxDuration = 60;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

const PARTNER_ID  = process.env.SHOPEE_PARTNER_ID!;
const PARTNER_KEY = process.env.SHOPEE_PARTNER_KEY!;

function round2(n: number): number { return Math.round(n * 100) / 100; }
function mapStatus(s: string): string {
  const m: Record<string, string> = {
    UNPAID:"pending", READY_TO_SHIP:"paid", RETRY_SHIP:"paid", PROCESSED:"paid",
    SHIPPED:"paid", TO_CONFIRM_RECEIVE:"paid", COMPLETED:"paid",
    CANCELLED:"cancelled", IN_CANCEL:"cancelled",
    TO_RETURN:"devolucao", RETURN:"devolucao", RETURN_APPROVE:"devolucao",
    RETURN_DONE:"devolucao", REFUND:"devolucao", LOST:"lost", DAMAGED:"devolucao",
  };
  return m[s] ?? "unknown";
}

/** Busca TODAS as linhas de uma data, com paginação */
async function fetchDia(userId: string, data: string, statusFilter?: string): Promise<any[]> {
  const PAGE = 1000;
  const all: any[] = [];
  let from = 0;
  for (;;) {
    let q = supabase
      .from("pedidos")
      .select("order_id, data, status, item_subtotal, faturamento, buyer_paid_amount, has_income_data, forma_pagamento, cancel_reason, cancel_by, synced_at")
      .eq("user_id", userId)
      .eq("marketplace", "Shopee")
      .eq("data", data)
      .range(from, from + PAGE - 1);
    if (statusFilter) q = q.eq("status", statusFilter);
    const { data: rows, error } = await q;
    if (error || !rows || rows.length === 0) break;
    all.push(...(rows as any[]));
    if (rows.length < PAGE) break;
    from += PAGE;
    if (from >= 10000) break;
  }
  return all;
}

/** Chama get_order_detail para uma lista de order_sn (máx 50 por lote) */
async function fetchShopeeDetail(
  orderSns: string[],
  accessToken: string,
  shopId: string | number
): Promise<any[]> {
  const BATCH = 50;
  const FIELDS = "order_status,create_time,pay_time,total_amount,actual_shipping_fee,payment_method,cancel_reason,cancel_by,income_distribution,item_list";
  const results: any[] = [];
  for (let i = 0; i < orderSns.length; i += BATCH) {
    const chunk = orderSns.slice(i, i + BATCH);
    const resp = await shopeeGet(
      "/api/v2/order/get_order_detail",
      PARTNER_ID, PARTNER_KEY, accessToken, shopId,
      { order_sn_list: chunk.join(","), response_optional_fields: FIELDS }
    );
    for (const o of (resp?.response?.order_list ?? [])) {
      results.push(o);
    }
  }
  return results;
}

export async function GET(request: Request) {
  const userId = getUserId(request);
  if (!userId) return NextResponse.json({ erro: "Sessao invalida" }, { status: 401 });

  const doSync = new URL(request.url).searchParams.get("sync") === "1";

  // ── Auth Shopee ────────────────────────────────────────────────────────────
  const loja = await getShopeeLojaAtiva(userId);
  if (!loja) return NextResponse.json({ erro: "Shopee nao conectada" }, { status: 400 });
  const accessToken = loja.accessToken as string;
  const shopId      = loja.shopId as string | number;

  // ══════════════════════════════════════════════════════════════════════════
  // PASSO 1: Buscar pedidos pending no banco para 2026-07-02
  // ══════════════════════════════════════════════════════════════════════════
  const pendingBanco = await fetchDia(userId, "2026-07-02", "pending");
  const orderSns = [...new Set(pendingBanco.map(r => r.order_id as string))];

  // ══════════════════════════════════════════════════════════════════════════
  // PASSO 2: Consultar status atual na API Shopee
  // ══════════════════════════════════════════════════════════════════════════
  const shopeeOrders = await fetchShopeeDetail(orderSns, accessToken, shopId);

  // Mapear: order_sn → { status_shopee, create_time, pay_time, total_amount, ... }
  const shopeeMap: Record<string, any> = {};
  for (const o of shopeeOrders) {
    shopeeMap[o.order_sn] = {
      status_shopee_raw: o.order_status,
      status_shopee_mapped: mapStatus(o.order_status ?? "UNKNOWN"),
      create_time: o.create_time,
      pay_time:    o.pay_time,
      total_amount: o.total_amount,
      payment_method: o.payment_method,
      cancel_reason:  o.cancel_reason,
      cancel_by:      o.cancel_by,
    };
  }

  // Agregar por order_id (pode haver múltiplas linhas por pedido com multi-item)
  const pendingAgg: Record<string, any> = {};
  for (const r of pendingBanco) {
    if (!pendingAgg[r.order_id]) {
      pendingAgg[r.order_id] = {
        order_sn:          r.order_id,
        status_banco:      r.status,
        item_subtotal:     0,
        faturamento:       0,
        buyer_paid_amount: 0,
        forma_pagamento:   r.forma_pagamento,
        synced_at:         r.synced_at,
        itens:             0,
      };
    }
    pendingAgg[r.order_id].item_subtotal     += Number(r.item_subtotal) || 0;
    pendingAgg[r.order_id].faturamento       += Number(r.faturamento) || 0;
    pendingAgg[r.order_id].buyer_paid_amount += Number(r.buyer_paid_amount) || 0;
    pendingAgg[r.order_id].itens             += 1;
  }

  // Combinar banco + Shopee API
  const comparacao = Object.values(pendingAgg).map((r: any) => {
    const api = shopeeMap[r.order_sn] ?? null;
    const statusAtual = api?.status_shopee_mapped ?? "nao_encontrado_na_api";
    return {
      ...r,
      item_subtotal:     round2(r.item_subtotal),
      faturamento:       round2(r.faturamento),
      buyer_paid_amount: round2(r.buyer_paid_amount),
      status_api_raw:    api?.status_shopee_raw ?? null,
      status_api:        statusAtual,
      status_mudou:      statusAtual !== "pending",
      pay_time_iso:      api?.pay_time ? new Date(Number(api.pay_time) * 1000).toISOString() : null,
      create_time_iso:   api?.create_time ? new Date(Number(api.create_time) * 1000).toISOString() : null,
      total_amount_api:  api?.total_amount ?? null,
      payment_method:    api?.payment_method ?? r.forma_pagamento,
      cancel_reason_api: api?.cancel_reason ?? null,
    };
  }).sort((a: any, b: any) => b.item_subtotal - a.item_subtotal);

  const agora_paid    = comparacao.filter((r: any) => r.status_api === "paid");
  const ainda_pending = comparacao.filter((r: any) => r.status_api === "pending");
  const virou_outro   = comparacao.filter((r: any) => !["paid","pending"].includes(r.status_api));

  const somaItemSubtotalAgora = round2(agora_paid.reduce((s: number, r: any) => s + r.item_subtotal, 0));

  const resultado: any = {
    geradoEm: new Date().toISOString(),
    data_auditada: "2026-07-02",
    shopeeOficial: { pedidos: 989, vendas: 22339.82 },
    passo1_banco: {
      pedidos_pending_no_banco:  orderSns.length,
      total_rows_pending:        pendingBanco.length,
    },
    passo2_comparacao_api: {
      consultados_na_api:       shopeeOrders.length,
      nao_encontrados_na_api:   orderSns.length - shopeeOrders.length,
      agora_paid_count:         agora_paid.length,
      ainda_pending_count:      ainda_pending.length,
      virou_outro_status_count: virou_outro.length,
      soma_item_subtotal_agora_paid: somaItemSubtotalAgora,
    },
    comparacao_detalhada: comparacao,
  };

  // ══════════════════════════════════════════════════════════════════════════
  // PASSO 3: Sync incremental (apenas se ?sync=1)
  // ══════════════════════════════════════════════════════════════════════════
  if (doSync) {
    let syncErro: string | null = null;
    let syncN    = 0;
    try {
      syncN = await syncShopeeForUser(userId, "2026-07-02", "2026-07-02", true, loja);
    } catch (e: any) {
      syncErro = String(e?.message ?? e);
    }
    resultado["passo3_sync"] = {
      executado: true,
      rows_sincronizados: syncN,
      erro: syncErro,
    };

    // ═════════════════════════════════════════════════════════════════════
    // PASSO 4-6: Estado do banco após sync
    // ═════════════════════════════════════════════════════════════════════
    const todosAposSync = await fetchDia(userId, "2026-07-02");
    const paidApos      = todosAposSync.filter(r => r.status === "paid");
    const pendApos      = todosAposSync.filter(r => r.status === "pending");
    const cancApos      = todosAposSync.filter(r => r.status === "cancelled");
    const devApos       = todosAposSync.filter(r => r.status === "devolucao");

    const paidDistinctApos = new Set(paidApos.map(r => r.order_id)).size;
    const somaFatApos      = round2(paidApos.reduce((s, r) => s + (Number(r.item_subtotal) || 0), 0));

    const SHOPEE_PEDIDOS = 989;
    const SHOPEE_VENDAS  = 22339.82;
    const diffPedidos    = SHOPEE_PEDIDOS - paidDistinctApos;
    const diffFat        = round2(SHOPEE_VENDAS - somaFatApos);
    const precisao       = round2((paidDistinctApos / SHOPEE_PEDIDOS) * 100);

    const encerrada = paidDistinctApos >= SHOPEE_PEDIDOS - 2 && Math.abs(diffFat) < 10;

    // Pedidos que ainda divergem
    const pendAposDistinct = new Set(pendApos.map(r => r.order_id)).size;
    let divergentes: any[] = [];
    if (!encerrada) {
      const pendAposMap: Record<string, any> = {};
      for (const r of pendApos) {
        if (!pendAposMap[r.order_id]) pendAposMap[r.order_id] = {
          order_sn: r.order_id, status_banco: r.status,
          item_subtotal: 0, forma_pagamento: r.forma_pagamento,
          motivo: "continua_pending_no_banco_apos_sync",
          onde_descartado: "banco (status nao atualizado pela API Shopee)",
        };
        pendAposMap[r.order_id].item_subtotal += Number(r.item_subtotal) || 0;
      }
      divergentes = Object.values(pendAposMap)
        .map((r: any) => ({ ...r, item_subtotal: round2(r.item_subtotal) }))
        .sort((a: any, b: any) => b.item_subtotal - a.item_subtotal);
    }

    resultado["passo4_estado_pos_sync"] = {
      paid_pedidos_distintos:    paidDistinctApos,
      pending_pedidos_distintos: pendAposDistinct,
      cancelado_pedidos:         new Set(cancApos.map(r => r.order_id)).size,
      devolucao_pedidos:         new Set(devApos.map(r => r.order_id)).size,
      soma_item_subtotal_paid:   somaFatApos,
      diferenca_vs_shopee: {
        pedidos:     diffPedidos,
        faturamento: diffFat,
      },
    };

    if (encerrada) {
      resultado["passo6_relatorio_fase1"] = {
        STATUS: "FASE_1_ENCERRADA",
        total_pedidos_sincronizados:  new Set(todosAposSync.map(r => r.order_id)).size,
        total_pedidos_paid:           paidDistinctApos,
        total_pedidos_cancelados:     new Set(cancApos.map(r => r.order_id)).size,
        total_pedidos_pendentes:      pendAposDistinct,
        total_pedidos_devolucao:      new Set(devApos.map(r => r.order_id)).size,
        faturamento_cds:              somaFatApos,
        faturamento_shopee:           SHOPEE_VENDAS,
        diferenca_final:              diffFat,
        precisao_sincronizacao_pct:   precisao,
        receita_liquida_nota:         "Disponivel apenas para pedidos COMPLETED (income_distribution). Para julho/2026 ainda em transito, escrow_amount = 0.",
      };
    } else {
      resultado["passo5_pedidos_divergentes"] = {
        motivo_geral: "Pedidos ainda pending no banco apos sync — API Shopee pode ter retornado UNPAID novamente (boleto nao pago, expirado, ou delay).",
        count: divergentes.length,
        lista: divergentes,
      };
    }
  }

  return NextResponse.json(resultado);
}
