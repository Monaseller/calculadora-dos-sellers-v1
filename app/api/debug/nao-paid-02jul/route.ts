/**
 * GET /api/debug/nao-paid-02jul
 * Lista todos os pedidos de 2026-07-02 com status != paid.
 * Objetivo: identificar os ~10 pedidos que explicam a diferenca entre
 * Shopee (989 pedidos, R$22.339,82) e CDS (979 paid, R$21.990,48).
 */
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getUserId } from "@/lib/session";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

function round2(n: number): number { return Math.round(n * 100) / 100; }

async function fetchAll02jul(userId: string): Promise<any[]> {
  const PAGE = 1000;
  const all: any[] = [];
  let from = 0;
  for (;;) {
    const { data: rows, error } = await supabase
      .from("pedidos")
      .select(
        "order_id, data, status, item_subtotal, faturamento, buyer_paid_amount," +
        " escrow_amount, commission_fee, has_income_data, synced_at," +
        " forma_pagamento, cancel_reason, cancel_by, anuncio, qtd, valor_unit"
      )
      .eq("user_id", userId)
      .eq("marketplace", "Shopee")
      .eq("data", "2026-07-02")
      .range(from, from + PAGE - 1);

    if (error) {
      console.error("[nao-paid-02jul] supabase error:", error.message);
      break;
    }
    if (!rows || rows.length === 0) break;
    all.push(...(rows as any[]));
    if (rows.length < PAGE) break;
    from += PAGE;
    if (from >= 10000) break;
  }
  return all;
}

export async function GET(request: Request) {
  const userId = getUserId(request);
  if (!userId) return NextResponse.json({ erro: "Sessao invalida" }, { status: 401 });

  const todos = await fetchAll02jul(userId);

  if (todos.length === 0) {
    return NextResponse.json({
      erro: "Nenhuma linha retornada para data=2026-07-02. Verifique se o sync rodou.",
      userId,
    });
  }

  const paid    = todos.filter(r => r.status === "paid");
  const naoPaid = todos.filter(r => r.status !== "paid");

  const somaItemSubtotalNaoPaid = round2(
    naoPaid.reduce((acc, r) => acc + (Number(r.item_subtotal) || 0), 0)
  );
  const somaFaturamentoNaoPaid = round2(
    naoPaid.reduce((acc, r) => acc + (Number(r.faturamento) || 0), 0)
  );
  const somaItemSubtotalPaid = round2(
    paid.reduce((acc, r) => acc + (Number(r.item_subtotal) || 0), 0)
  );

  const porStatusPedidos: Record<string, number> = {};
  const seenPerStatus: Record<string, Set<string>> = {};
  for (const r of todos) {
    const s = String(r.status ?? "null");
    if (!seenPerStatus[s]) seenPerStatus[s] = new Set();
    seenPerStatus[s].add(r.order_id);
  }
  for (const [s, set] of Object.entries(seenPerStatus)) {
    porStatusPedidos[s] = set.size;
  }

  const SHOPEE_PEDIDOS = 989;
  const SHOPEE_VENDAS  = 22339.82;
  const paidDistinct   = new Set(paid.map(r => r.order_id)).size;
  const naoPaidDistinct = new Set(naoPaid.map(r => r.order_id)).size;
  const diff_pedidos   = SHOPEE_PEDIDOS - paidDistinct;
  const diff_fat       = round2(SHOPEE_VENDAS - somaItemSubtotalPaid);

  const gap = round2(diff_fat - somaItemSubtotalNaoPaid);
  const confirmacao =
    Math.abs(gap) < 5
      ? "CONFIRMADO: nao-paid=" + String(naoPaidDistinct) + " pedidos / soma_item_subtotal=R$" + String(somaItemSubtotalNaoPaid) + " explica diff de R$" + String(diff_fat) + " (gap residual=R$" + String(gap) + ")"
      : "PARCIAL: nao-paid=" + String(naoPaidDistinct) + " pedidos / soma_item_subtotal=R$" + String(somaItemSubtotalNaoPaid) + " / diff_esperada=R$" + String(diff_fat) + " / gap_nao_explicado=R$" + String(gap);

  const naoPaidAgg: Record<string, any> = {};
  for (const r of naoPaid) {
    if (!naoPaidAgg[r.order_id]) {
      naoPaidAgg[r.order_id] = {
        order_id:          r.order_id,
        status:            r.status,
        data:              r.data,
        item_subtotal:     0,
        faturamento:       0,
        buyer_paid_amount: 0,
        has_income_data:   r.has_income_data,
        forma_pagamento:   r.forma_pagamento,
        cancel_reason:     r.cancel_reason,
        cancel_by:         r.cancel_by,
        synced_at:         r.synced_at,
        itens:             0,
      };
    }
    naoPaidAgg[r.order_id].item_subtotal     = (naoPaidAgg[r.order_id].item_subtotal     || 0) + (Number(r.item_subtotal) || 0);
    naoPaidAgg[r.order_id].faturamento       = (naoPaidAgg[r.order_id].faturamento       || 0) + (Number(r.faturamento) || 0);
    naoPaidAgg[r.order_id].buyer_paid_amount = (naoPaidAgg[r.order_id].buyer_paid_amount || 0) + (Number(r.buyer_paid_amount) || 0);
    naoPaidAgg[r.order_id].itens             = (naoPaidAgg[r.order_id].itens             || 0) + 1;
  }
  const naoPaidLista = Object.values(naoPaidAgg)
    .map(r => ({
      ...r,
      item_subtotal:     round2(r.item_subtotal),
      faturamento:       round2(r.faturamento),
      buyer_paid_amount: round2(r.buyer_paid_amount),
    }))
    .sort((a: any, b: any) => b.item_subtotal - a.item_subtotal);

  return NextResponse.json({
    geradoEm:      new Date().toISOString(),
    data_auditada: "2026-07-02",
    shopeeOficial: { pedidos: SHOPEE_PEDIDOS, vendas: SHOPEE_VENDAS },
    banco: {
      total_rows:                 todos.length,
      pedidos_distintos_total:    new Set(todos.map(r => r.order_id)).size,
      paid_pedidos_distintos:     paidDistinct,
      nao_paid_pedidos_distintos: naoPaidDistinct,
      por_status_pedidos:         porStatusPedidos,
      soma_item_subtotal_paid:       somaItemSubtotalPaid,
      soma_item_subtotal_nao_paid:   somaItemSubtotalNaoPaid,
      soma_faturamento_nao_paid:     somaFaturamentoNaoPaid,
    },
    diferenca_vs_shopee: {
      pedidos:                     diff_pedidos,
      faturamento:                 diff_fat,
      soma_nao_paid_item_subtotal: somaItemSubtotalNaoPaid,
      gap_nao_explicado:           gap,
    },
    conclusao: confirmacao,
    pedidos_nao_paid: naoPaidLista,
  });
}
