/**
 * GET /api/debug/full-reconciliation
 *
 * Reconciliação definitiva pedido-a-pedido, Shopee (fonte da verdade) vs banco.
 * NÃO testa hipótese nenhuma — só monta os fatos: quem existe onde, e onde os
 * campos batem ou não. A classificação de causa (pipeline/timezone/status/etc.)
 * é feita por leitura humana dos dados retornados aqui, não por este endpoint.
 *
 * Desenho (decisões registradas em docs/DECISIONS.md):
 *  - Período: 2026-07-02 (00:00:00 a 23:59:59 BRT), mesmo escopo já usado nos
 *    endpoints anteriores (boundary-audit, nao-paid-02jul, shopee-audit).
 *  - PASSO 1 (Shopee): get_order_list é chamado DUAS vezes para o mesmo dia —
 *    uma com time_range_field=create_time, outra com update_time — e os
 *    resultados são UNIDOS por order_sn. Isso evita perder pedidos por causa
 *    da escolha de um único campo de tempo. Nenhum filtro de order_status é
 *    aplicado (ao contrário do sync normal, que exclui COMPLETED no modo cron).
 *  - PASSO 2 (banco): busca TODOS os pedidos Shopee do usuário numa janela
 *    ampla (2026-06-25 a 2026-07-10), SEM filtrar estritamente por data=02/07,
 *    porque o campo `data` é exatamente o que está sob suspeita. O match com
 *    a Shopee é feito por order_id/order_sn, não por igualdade de data.
 *  - PASSO 3-6: conjuntos A (só Shopee) / B (só banco) / C (nos dois, com
 *    comparação campo a campo).
 *
 * Response é compacto de propósito: pedidos idênticos em C só entram como
 * contagem + soma financeira (não listados um a um), pois não agregam
 * informação para a investigação. A, B e os divergentes de C vêm completos.
 */
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getUserId } from "@/lib/session";
import { getShopeeLojaAtiva } from "@/lib/shopee-auth";
import { shopeeGet } from "@/lib/shopee-api";

export const maxDuration = 60;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

function round2(n: number): number { return Math.round((Number(n) || 0) * 100) / 100; }
function toEpoch(iso: string): number { return Math.floor(new Date(iso).getTime() / 1000); }
function isoOrNull(ts: any): string | null {
  const n = Number(ts);
  return n ? new Date(n * 1000).toISOString() : null;
}

// Cópia local do mapeamento de status (mesma regra de lib/sync-shopee.ts,
// duplicada aqui só para leitura — não altera o arquivo original).
function mapStatus(s: string): string {
  const m: Record<string, string> = {
    UNPAID: "pending",
    READY_TO_SHIP: "paid", RETRY_SHIP: "paid", PROCESSED: "paid",
    SHIPPED: "paid", TO_CONFIRM_RECEIVE: "paid", COMPLETED: "paid",
    CANCELLED: "cancelled", IN_CANCEL: "cancelled",
    TO_RETURN: "devolucao", RETURN: "devolucao", RETURN_APPROVE: "devolucao",
    RETURN_DONE: "devolucao", REFUND: "devolucao", LOST: "lost", DAMAGED: "devolucao",
  };
  return m[s] ?? "unknown";
}

async function fetchOrderSnsByField(
  partnerId: string, partnerKey: string, accessToken: string, shopId: number,
  timeRangeField: "create_time" | "update_time", timeFrom: number, timeTo: number
): Promise<Array<{ order_sn: string; order_status: string }>> {
  const all: Array<{ order_sn: string; order_status: string }> = [];
  let cursor = "";
  for (;;) {
    const params: Record<string, string | number> = {
      time_range_field: timeRangeField,
      time_from: timeFrom,
      time_to: timeTo,
      page_size: 100,
      response_optional_fields: "order_status",
    };
    if (cursor) params.cursor = cursor;

    const data = await shopeeGet("/api/v2/order/get_order_list", partnerId, partnerKey, accessToken, shopId, params);
    if (data?.error && data.error !== "") {
      throw new Error(`get_order_list (${timeRangeField}) error: ${data.error} -- ${data.message ?? ""}`);
    }
    const list: any[] = data?.response?.order_list ?? [];
    for (const o of list) all.push({ order_sn: o.order_sn, order_status: o.order_status });

    if (!data?.response?.more || !data?.response?.next_cursor) break;
    cursor = data.response.next_cursor;
  }
  return all;
}

async function fetchOrderDetails(
  orderSns: string[], partnerId: string, partnerKey: string, accessToken: string, shopId: number
): Promise<any[]> {
  const FIELDS = "item_list,order_status,create_time,pay_time,update_time,total_amount,income_distribution";
  const BATCH = 50;
  const out: any[] = [];
  for (let i = 0; i < orderSns.length; i += BATCH) {
    const chunk = orderSns.slice(i, i + BATCH);
    const resp = await shopeeGet("/api/v2/order/get_order_detail", partnerId, partnerKey, accessToken, shopId, {
      order_sn_list: chunk.join(","),
      response_optional_fields: FIELDS,
    });
    for (const o of (resp?.response?.order_list ?? [])) out.push(o);
  }
  return out;
}

async function fetchBancoAmplo(userId: string): Promise<any[]> {
  const PAGE = 1000;
  const all: any[] = [];
  let offset = 0;
  for (;;) {
    const { data: rows, error } = await supabase
      .from("pedidos")
      .select("order_id, data, status, item_subtotal, buyer_paid_amount, escrow_amount, synced_at")
      .eq("user_id", userId)
      .eq("marketplace", "Shopee")
      .gte("data", "2026-06-25")
      .lte("data", "2026-07-10")
      .range(offset, offset + PAGE - 1);
    if (error) {
      console.error("[full-reconciliation] supabase:", error.message);
      break;
    }
    if (!rows || rows.length === 0) break;
    all.push(...rows);
    if (rows.length < PAGE) break;
    offset += PAGE;
    if (offset >= 20000) break;
  }
  return all;
}

export async function GET(request: Request) {
  const userId = getUserId(request);
  if (!userId) return NextResponse.json({ erro: "Sessao invalida" }, { status: 401 });

  const loja = await getShopeeLojaAtiva(userId);
  if (!loja) return NextResponse.json({ erro: "Shopee nao conectada" }, { status: 400 });
  const { partnerId, partnerKey, accessToken, shopId } = loja;

  const PERIODO = "2026-07-02";
  const dayFrom = toEpoch(`${PERIODO}T00:00:00-03:00`);
  const dayTo   = toEpoch(`${PERIODO}T23:59:59-03:00`);

  // ══════════════════════════════════════════════════════════════════════
  // PASSO 1 — TODOS os pedidos Shopee do período (create_time ∪ update_time)
  // ══════════════════════════════════════════════════════════════════════
  let viaCreate: Array<{ order_sn: string; order_status: string }> = [];
  let viaUpdate: Array<{ order_sn: string; order_status: string }> = [];
  try {
    viaCreate = await fetchOrderSnsByField(partnerId, partnerKey, accessToken, shopId, "create_time", dayFrom, dayTo);
  } catch (e: any) {
    return NextResponse.json({ erro: "Falha ao listar por create_time", detalhe: String(e?.message ?? e) }, { status: 502 });
  }
  try {
    viaUpdate = await fetchOrderSnsByField(partnerId, partnerKey, accessToken, shopId, "update_time", dayFrom, dayTo);
  } catch (e: any) {
    return NextResponse.json({ erro: "Falha ao listar por update_time", detalhe: String(e?.message ?? e) }, { status: 502 });
  }

  const foundVia: Record<string, Set<string>> = {};
  for (const o of viaCreate) (foundVia[o.order_sn] ??= new Set()).add("create_time");
  for (const o of viaUpdate) (foundVia[o.order_sn] ??= new Set()).add("update_time");
  const allOrderSns = Object.keys(foundVia);

  if (allOrderSns.length === 0) {
    return NextResponse.json({
      erro: `Shopee nao retornou nenhum pedido (create_time nem update_time) para ${PERIODO}. Confirme token/loja ativa.`,
    });
  }

  // Detalhe completo de cada pedido Shopee
  let details: any[] = [];
  try {
    details = await fetchOrderDetails(allOrderSns, partnerId, partnerKey, accessToken, shopId);
  } catch (e: any) {
    return NextResponse.json({ erro: "Falha ao buscar get_order_detail", detalhe: String(e?.message ?? e) }, { status: 502 });
  }

  const shopeeDetailMap = new Map<string, any>();
  for (const o of details) {
    const itemSubtotal = (o.item_list ?? []).reduce((s: number, it: any) =>
      s + Number(it.model_discounted_price ?? it.model_original_price ?? 0) * Number(it.model_quantity_purchased ?? 1), 0);
    const inc = o.income_distribution ?? {};
    const buyerPaidAmount = Number(inc.buyer_total_amount ?? o.total_amount ?? 0);
    const escrowAmount    = Number(inc.escrow_amount ?? 0);

    shopeeDetailMap.set(o.order_sn, {
      order_sn:          o.order_sn,
      status_raw:        o.order_status,
      status_mapeado:    mapStatus(o.order_status ?? "UNKNOWN"),
      item_subtotal:     round2(itemSubtotal),
      buyer_paid_amount: round2(buyerPaidAmount),
      escrow_amount:     round2(escrowAmount),
      create_time:       isoOrNull(o.create_time),
      pay_time:          isoOrNull(o.pay_time),
      update_time:       isoOrNull(o.update_time),
      encontrado_via:    [...(foundVia[o.order_sn] ?? [])].join("+"),
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  // PASSO 2 — TODOS os pedidos do banco (janela ampla, sem filtro estrito
  //           por data=02/07 — match será feito por order_id)
  // ══════════════════════════════════════════════════════════════════════
  const bancoRows = await fetchBancoAmplo(userId);
  if (bancoRows.length === 0) {
    return NextResponse.json({ erro: "Nenhum pedido Shopee no banco entre 2026-06-25 e 2026-07-10. Verifique sync." });
  }

  const bancoMap = new Map<string, any>();
  for (const r of bancoRows) {
    if (!bancoMap.has(r.order_id)) {
      bancoMap.set(r.order_id, {
        order_id: r.order_id, data_banco: r.data, status: r.status,
        item_subtotal: 0, buyer_paid_amount: 0, escrow_amount: 0, synced_at: r.synced_at,
      });
    }
    const b = bancoMap.get(r.order_id);
    b.item_subtotal     += Number(r.item_subtotal) || 0;
    b.buyer_paid_amount  += Number(r.buyer_paid_amount) || 0;
    b.escrow_amount      += Number(r.escrow_amount) || 0;
  }
  for (const b of bancoMap.values()) {
    b.item_subtotal = round2(b.item_subtotal);
    b.buyer_paid_amount = round2(b.buyer_paid_amount);
    b.escrow_amount = round2(b.escrow_amount);
  }

  // ══════════════════════════════════════════════════════════════════════
  // PASSO 3 — Conjuntos A / B / C (por order_sn / order_id)
  // ══════════════════════════════════════════════════════════════════════
  const shopeeSet = new Set(shopeeDetailMap.keys());
  const bancoSet  = new Set(bancoMap.keys());

  const apenasShopeeIds = [...shopeeSet].filter(sn => !bancoSet.has(sn));
  const apenasBancoIds  = [...bancoSet].filter(id => !shopeeSet.has(id));
  const emAmbosIds      = [...shopeeSet].filter(sn => bancoSet.has(sn));

  // ── PASSO 4 — Conjunto A (só Shopee) ──────────────────────────────────
  const conjuntoA = apenasShopeeIds.map(sn => {
    const d = shopeeDetailMap.get(sn);
    return {
      order_sn: sn,
      status: d.status_raw,
      status_mapeado: d.status_mapeado,
      item_subtotal: d.item_subtotal,
      buyer_paid_amount: d.buyer_paid_amount,
      create_time: d.create_time,
      pay_time: d.pay_time,
      update_time: d.update_time,
      encontrado_via: d.encontrado_via,
      motivo_ausencia_banco:
        "Existe na API Shopee (create_time ou update_time = 02/07) mas nenhuma linha com esse order_id foi encontrada no banco entre 2026-06-25 e 2026-07-10.",
    };
  }).sort((a, b) => b.item_subtotal - a.item_subtotal);

  // ── PASSO 5 — Conjunto B (só banco) ───────────────────────────────────
  const conjuntoB = apenasBancoIds.map(id => {
    const b = bancoMap.get(id);
    return {
      order_id: id,
      status_banco: b.status,
      item_subtotal: b.item_subtotal,
      buyer_paid_amount: b.buyer_paid_amount,
      data_gravada_banco: b.data_banco,
      synced_at: b.synced_at,
      motivo_ausencia_shopee:
        "Existe no banco (gravado entre 2026-06-25 e 2026-07-10) mas a API Shopee nao retornou esse order_id nem por create_time nem por update_time = 02/07. Ou a data real do pedido eh outra, ou o pedido foi alterado/removido na Shopee depois do sync.",
    };
  }).sort((a, b) => b.item_subtotal - a.item_subtotal);

  // ── PASSO 6 — Conjunto C (em ambos): comparar campo a campo ──────────
  const divergentes: any[] = [];
  let identicosCount = 0;
  let identicosItemSubtotal = 0;
  let identicosBuyerPaid = 0;

  for (const sn of emAmbosIds) {
    const s = shopeeDetailMap.get(sn);
    const b = bancoMap.get(sn);

    const diffs: string[] = [];
    if (s.status_mapeado !== b.status) diffs.push(`status: shopee="${s.status_mapeado}" (raw="${s.status_raw}") vs banco="${b.status}"`);
    if (Math.abs(s.item_subtotal - b.item_subtotal) > 0.01) diffs.push(`item_subtotal: shopee=${s.item_subtotal} vs banco=${b.item_subtotal}`);
    if (Math.abs(s.buyer_paid_amount - b.buyer_paid_amount) > 0.01) diffs.push(`buyer_paid_amount: shopee=${s.buyer_paid_amount} vs banco=${b.buyer_paid_amount}`);
    if (b.data_banco !== PERIODO) diffs.push(`data: banco gravou "${b.data_banco}" mas foi localizado via Shopee ${PERIODO} (${s.encontrado_via})`);

    if (diffs.length > 0) {
      divergentes.push({
        order_sn: sn,
        shopee: { status: s.status_raw, status_mapeado: s.status_mapeado, item_subtotal: s.item_subtotal, buyer_paid_amount: s.buyer_paid_amount, create_time: s.create_time, pay_time: s.pay_time, update_time: s.update_time },
        banco:  { status: b.status, item_subtotal: b.item_subtotal, buyer_paid_amount: b.buyer_paid_amount, data: b.data_banco, synced_at: b.synced_at },
        diffs,
      });
    } else {
      identicosCount++;
      identicosItemSubtotal += b.item_subtotal;
      identicosBuyerPaid    += b.buyer_paid_amount;
    }
  }
  divergentes.sort((a, b) => b.shopee.item_subtotal - a.shopee.item_subtotal);

  // ══════════════════════════════════════════════════════════════════════
  // PASSO 7 — Relatório final (só fatos — sem conclusao automatica)
  // ══════════════════════════════════════════════════════════════════════
  return NextResponse.json({
    geradoEm: new Date().toISOString(),
    periodo_auditado: PERIODO,
    shopeeOficial: { pedidos: 989, vendas: 22339.82 },

    passo1_shopee_universo: {
      total_order_sn: allOrderSns.length,
      via_create_time: viaCreate.length,
      via_update_time: viaUpdate.length,
      apenas_create_time: allOrderSns.filter(sn => foundVia[sn].size === 1 && foundVia[sn].has("create_time")).length,
      apenas_update_time: allOrderSns.filter(sn => foundVia[sn].size === 1 && foundVia[sn].has("update_time")).length,
      em_ambos_create_update: allOrderSns.filter(sn => foundVia[sn].size === 2).length,
    },

    passo2_banco_universo: {
      total_order_id_distintos: bancoSet.size,
      janela_consultada: "2026-06-25 a 2026-07-10 (sem filtro estrito por data=02/07)",
    },

    passo3_conjuntos: {
      A_apenas_shopee: conjuntoA.length,
      B_apenas_banco: conjuntoB.length,
      C_em_ambos: emAmbosIds.length,
    },

    conjunto_A_apenas_shopee: {
      count: conjuntoA.length,
      soma_item_subtotal: round2(conjuntoA.reduce((s, o) => s + o.item_subtotal, 0)),
      pedidos: conjuntoA,
    },

    conjunto_B_apenas_banco: {
      count: conjuntoB.length,
      soma_item_subtotal: round2(conjuntoB.reduce((s, o) => s + o.item_subtotal, 0)),
      pedidos: conjuntoB,
    },

    conjunto_C_divergentes: {
      count: divergentes.length,
      pedidos: divergentes,
    },

    conjunto_C_identicos: {
      count: identicosCount,
      soma_item_subtotal: round2(identicosItemSubtotal),
      soma_buyer_paid_amount: round2(identicosBuyerPaid),
    },

    resumo_para_classificacao: {
      nota: "Este endpoint nao classifica causa. Ler conjunto_A (so Shopee), conjunto_B (so banco) e conjunto_C_divergentes junto com os motivos estruturais listados em cada pedido para determinar, order_sn por order_sn, se a causa e pipeline/timezone/status/filtro/API/banco/outro.",
    },
  });
}
