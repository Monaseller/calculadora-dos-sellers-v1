/**
 * GET /api/debug/shopee-audit
 * Endpoint TEMPORARIO de diagnostico — NAO usar em producao.
 * Abrir no browser logado: http://localhost:3001/api/debug/shopee-audit
 */
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getUserId } from "@/lib/session";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

function countDistinct(rows: any[], field: string): number {
  return new Set(rows.map((r: any) => String(r[field] ?? ""))).size;
}

function sumField(rows: any[], field: string): number {
  return rows.reduce((acc: number, r: any) => acc + (Number(r[field]) || 0), 0);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export async function GET(request: Request) {
  const userId = getUserId(request);
  if (!userId) {
    return NextResponse.json(
      { erro: "Sessao invalida — faca login primeiro." },
      { status: 401 }
    );
  }

  const { data: rawRows, error } = await supabase
    .from("pedidos")
    .select(
      "order_id, data, status, faturamento, item_subtotal, buyer_paid_amount," +
      " escrow_amount, commission_fee, has_income_data, marketplace, user_id"
    )
    .eq("user_id", userId)
    .eq("marketplace", "Shopee")
    .gte("data", "2026-06-29")
    .lte("data", "2026-07-03");

  if (error) {
    return NextResponse.json(
      { erro: String((error as any).message ?? error) },
      { status: 500 }
    );
  }

  const allRows: any[] = (rawRows as any[]) ?? [];

  // ── Q1: por status em 2026-07-02 ─────────────────────────────────────────
  const dia02 = allRows.filter((r: any) => r.data === "2026-07-02");

  const sm: Record<string, { ids: Set<string>; fat: number }> = {};
  for (const r of dia02) {
    const s = String(r.status ?? "null");
    if (!sm[s]) sm[s] = { ids: new Set<string>(), fat: 0 };
    sm[s].ids.add(String(r.order_id ?? ""));
    sm[s].fat += Number(r.faturamento) || 0;
  }

  const q1 = Object.entries(sm)
    .map(([status, v]) => ({ status, pedidos: v.ids.size, faturamento: round2(v.fat) }))
    .sort((a, b) => b.pedidos - a.pedidos);

  q1.push({
    status:      "__TOTAL__",
    pedidos:     countDistinct(dia02, "order_id"),
    faturamento: round2(sumField(dia02, "faturamento")),
  });

  // ── Q2: por data+status 2026-06-29..2026-07-03 ───────────────────────────
  const DATAS = ["2026-06-29","2026-06-30","2026-07-01","2026-07-02","2026-07-03"];
  const q2: any[] = [];

  for (const dt of DATAS) {
    const rd = allRows.filter((r: any) => r.data === dt);
    const bs: Record<string, { ids: Set<string>; fat: number }> = {};
    for (const r of rd) {
      const s = String(r.status ?? "null");
      if (!bs[s]) bs[s] = { ids: new Set<string>(), fat: 0 };
      bs[s].ids.add(String(r.order_id ?? ""));
      bs[s].fat += Number(r.faturamento) || 0;
    }
    for (const [status, v] of Object.entries(bs)) {
      q2.push({ data: dt, status, pedidos: v.ids.size, faturamento: round2(v.fat) });
    }
    q2.push({
      data: dt, status: "__TOTAL_DIA__",
      pedidos:     countDistinct(rd, "order_id"),
      faturamento: round2(sumField(rd, "faturamento")),
    });
  }

  // ── Q3: campos financeiros 2026-07-02 (paid) ─────────────────────────────
  const paid02 = dia02.filter((r: any) => r.status === "paid");
  const q3 = {
    pedidos_paid:                  countDistinct(paid02, "order_id"),
    faturamento_item_subtotal:     round2(sumField(paid02, "item_subtotal")),
    faturamento_total_amount:      round2(sumField(paid02, "faturamento")),
    faturamento_buyer_paid_amount: round2(sumField(paid02, "buyer_paid_amount")),
    escrow_amount_sum:             round2(sumField(paid02, "escrow_amount")),
    commission_fee_sum:            round2(sumField(paid02, "commission_fee")),
    rows_com_income_data:          dia02.filter((r: any) => r.has_income_data === true).length,
    rows_sem_income_data:          dia02.filter((r: any) => r.has_income_data !== true).length,
    total_rows_dia:                dia02.length,
  };

  // ── Diagnostico ───────────────────────────────────────────────────────────
  const SHOPEE_PEDIDOS = 989;
  const SHOPEE_VENDAS  = 22339.82;
  const totalBanco     = countDistinct(dia02, "order_id");
  const paidBanco      = q3.pedidos_paid;
  const diag: string[] = [];

  if (allRows.length === 0) {
    diag.push("SEM_DADOS: 0 rows retornadas — RLS bloqueando ou tabela vazia.");
  } else if (dia02.length === 0) {
    diag.push("SEM_DADOS_DIA_02: 0 rows para 2026-07-02 — sync nao rodou.");
  } else if (totalBanco < SHOPEE_PEDIDOS) {
    diag.push(
      "BANCO_MENOR: banco=" + String(totalBanco) +
      " shopee=" + String(SHOPEE_PEDIDOS) +
      " faltam=" + String(SHOPEE_PEDIDOS - totalBanco) +
      " => pedidos NAO chegaram ao banco (paginacao, timeout, filtro de data)."
    );
  } else {
    diag.push(
      "BANCO_OK: banco=" + String(totalBanco) +
      " >= shopee=" + String(SHOPEE_PEDIDOS) +
      ". Pedidos ESTAO no banco. paid=" + String(paidBanco) +
      " nao-paid=" + String(totalBanco - paidBanco) +
      " => diferenca causada por filtro de status na UI."
    );
  }

  const campos = [
    { campo: "item_subtotal",     valor: q3.faturamento_item_subtotal },
    { campo: "total_amount",      valor: q3.faturamento_total_amount },
    { campo: "buyer_paid_amount", valor: q3.faturamento_buyer_paid_amount },
    { campo: "escrow_amount",     valor: q3.escrow_amount_sum },
  ];
  const closest = campos
    .map(c => ({ ...c, diff: Math.abs(c.valor - SHOPEE_VENDAS) }))
    .sort((a, b) => a.diff - b.diff)[0];

  diag.push(
    "CAMPO_FATURAMENTO: " + closest.campo +
    " = R$" + String(closest.valor) +
    " diff=R$" + String(round2(closest.diff)) +
    " vs shopee=R$" + String(SHOPEE_VENDAS)
  );

  diag.push(
    "ORIGEM_DATA: lib/sync-shopee.ts:267-272 — " +
    "noBuffer=true(manual) usa CREATE_TIME; " +
    "noBuffer=false(cron) usa PAY_TIME. " +
    "Se Shopee panel usa PAY_TIME, pedidos criados antes de ontem mas pagos ontem " +
    "aparecem no painel Shopee mas nao no CDS ontem."
  );

  return NextResponse.json({
    geradoEm:         new Date().toISOString(),
    userId,
    totalRowsFetched: allRows.length,
    shopeeOficial:    { pedidos: SHOPEE_PEDIDOS, vendas: SHOPEE_VENDAS },
    resumo: {
      total_no_banco_02jul:    totalBanco,
      paid_no_banco_02jul:     paidBanco,
      nao_paid_no_banco_02jul: totalBanco - paidBanco,
      faltam_vs_shopee:        SHOPEE_PEDIDOS - totalBanco,
      campo_faturamento:       closest,
    },
    diagnostico: diag,
    q1_status_02jul:    q1,
    q2_por_data_status: q2,
    q3_financeiro:      q3,
  });
}
