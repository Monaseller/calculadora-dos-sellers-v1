/**
 * GET /api/debug/shopee-audit
 * v2 - queries separadas por data para evitar o limite 1000 linhas do Supabase.
 * Abrir no browser logado: http://localhost:3000/api/debug/shopee-audit
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
function round2(n: number): number { return Math.round(n * 100) / 100; }

/** Busca TODAS as linhas de uma data especifica, paginando ate 10.000 */
async function fetchDia(userId: string, data: string): Promise<any[]> {
  const PAGE = 1000;
  const all: any[] = [];
  let from = 0;
  for (;;) {
    const { data: rows, error } = await supabase
      .from("pedidos")
      .select(
        "order_id, data, status, faturamento, item_subtotal, buyer_paid_amount," +
        " escrow_amount, commission_fee, has_income_data"
      )
      .eq("user_id", userId)
      .eq("marketplace", "Shopee")
      .eq("data", data)
      .range(from, from + PAGE - 1);
    if (error || !rows || rows.length === 0) break;
    all.push(...(rows as any[]));
    if (rows.length < PAGE) break;
    from += PAGE;
    if (from >= 10000) break; // safety cap
  }
  return all;
}

/** Agrega rows em { status -> { pedidos, faturamento } } */
function agrupar(rows: any[]): any[] {
  const sm: Record<string, { ids: Set<string>; fat: number }> = {};
  for (const r of rows) {
    const s = String(r.status ?? "null");
    if (!sm[s]) sm[s] = { ids: new Set<string>(), fat: 0 };
    sm[s].ids.add(String(r.order_id ?? ""));
    sm[s].fat += Number(r.faturamento) || 0;
  }
  const out = Object.entries(sm)
    .map(([status, v]) => ({ status, pedidos: v.ids.size, faturamento: round2(v.fat) }))
    .sort((a, b) => b.pedidos - a.pedidos);
  out.push({
    status:      "__TOTAL__",
    pedidos:     countDistinct(rows, "order_id"),
    faturamento: round2(sumField(rows, "faturamento")),
  });
  return out;
}

export async function GET(request: Request) {
  const userId = getUserId(request);
  if (!userId) {
    return NextResponse.json({ erro: "Sessao invalida" }, { status: 401 });
  }

  // Busca cada data separadamente (evita limite 1000 do Supabase)
  const DATAS = ["2026-06-29","2026-06-30","2026-07-01","2026-07-02","2026-07-03"];
  const porData: Record<string, any[]> = {};
  for (const dt of DATAS) {
    porData[dt] = await fetchDia(userId, dt);
  }

  const dia02 = porData["2026-07-02"];
  const dia03 = porData["2026-07-03"];

  // ── Q1: breakdown por status em 2026-07-02 ────────────────────────────────
  const q1 = agrupar(dia02);

  // ── Q2: resumo por data ───────────────────────────────────────────────────
  const q2 = DATAS.map(dt => {
    const rows = porData[dt];
    const paid = rows.filter((r: any) => r.status === "paid");
    return {
      data:             dt,
      total_rows:       rows.length,
      pedidos_total:    countDistinct(rows, "order_id"),
      pedidos_paid:     countDistinct(paid, "order_id"),
      faturamento_paid: round2(sumField(paid, "faturamento")),
      statuses: agrupar(rows).filter(x => x.status !== "__TOTAL__").map(x => x.status + "=" + String(x.pedidos)).join(", ") || "(vazio)",
    };
  });

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

  // ── Q3b: mesmos campos para 2026-07-03 (comparacao) ─────────────────────
  const paid03 = dia03.filter((r: any) => r.status === "paid");
  const q3b = {
    pedidos_paid:                  countDistinct(paid03, "order_id"),
    faturamento_item_subtotal:     round2(sumField(paid03, "item_subtotal")),
    faturamento_total_amount:      round2(sumField(paid03, "faturamento")),
    faturamento_buyer_paid_amount: round2(sumField(paid03, "buyer_paid_amount")),
    escrow_amount_sum:             round2(sumField(paid03, "escrow_amount")),
    commission_fee_sum:            round2(sumField(paid03, "commission_fee")),
    total_rows_dia:                dia03.length,
  };

  // ── Diagnostico ───────────────────────────────────────────────────────────
  const SHOPEE_PEDIDOS = 989;
  const SHOPEE_VENDAS  = 22339.82;
  const totalBanco02   = countDistinct(dia02, "order_id");
  const paidBanco02    = q3.pedidos_paid;
  const diag: string[] = [];

  if (dia02.length === 0) {
    diag.push("SEM_DADOS_02JUL: 0 rows para 2026-07-02. Sync nao rodou ou datas erradas no banco.");
    diag.push("VERIFICAR: q2 mostra onde os dados estao. Se 07-03 tem ~989 pedidos, o campo data esta errado (um dia a mais).");
  } else if (totalBanco02 < SHOPEE_PEDIDOS) {
    diag.push(
      "BANCO_MENOR_QUE_SHOPEE: banco=" + String(totalBanco02) +
      " todos_statuses, shopee=" + String(SHOPEE_PEDIDOS) +
      ", faltam=" + String(SHOPEE_PEDIDOS - totalBanco02) +
      ". Os pedidos nao chegaram ao banco (API, paginacao, timeout ou filtro de data no sync)."
    );
  } else {
    diag.push(
      "BANCO_OK: banco=" + String(totalBanco02) +
      " (todos status) >= shopee=" + String(SHOPEE_PEDIDOS) +
      ". paid=" + String(paidBanco02) +
      ", nao-paid=" + String(totalBanco02 - paidBanco02) +
      ". Diferenca causada por filtro de status na UI (pedidosUnicos conta apenas paid)."
    );
  }

  const campos = [
    { campo: "item_subtotal",     valor: q3.faturamento_item_subtotal },
    { campo: "total_amount",      valor: q3.faturamento_total_amount },
    { campo: "buyer_paid_amount", valor: q3.faturamento_buyer_paid_amount },
    { campo: "escrow_amount",     valor: q3.escrow_amount_sum },
  ];
  const closest = campos.map(c => ({ ...c, diff: Math.abs(c.valor - SHOPEE_VENDAS) }))
    .sort((a, b) => a.diff - b.diff)[0];

  diag.push(
    "CAMPO_FATURAMENTO_PROXIMO_02JUL: " + closest.campo +
    " = R$" + String(closest.valor) +
    " vs shopee=R$" + String(SHOPEE_VENDAS) +
    " diff=R$" + String(round2(closest.diff))
  );

  // Comparar 07-03 com oficial (hipotese: dado de 02 esta salvo como 03)
  const campos03 = [
    { campo: "item_subtotal_03",     valor: q3b.faturamento_item_subtotal },
    { campo: "total_amount_03",      valor: q3b.faturamento_total_amount },
    { campo: "buyer_paid_amount_03", valor: q3b.faturamento_buyer_paid_amount },
  ];
  const closest03 = campos03.map(c => ({ ...c, diff: Math.abs(c.valor - SHOPEE_VENDAS) }))
    .sort((a, b) => a.diff - b.diff)[0];
  diag.push(
    "COMPARACAO_07-03_VS_SHOPEE_02: pedidos_paid_03=" + String(q3b.pedidos_paid) +
    " faturamento_03=" + String(q3b.faturamento_total_amount) +
    " (shopee_oficial=" + String(SHOPEE_PEDIDOS) + "/" + String(SHOPEE_VENDAS) + ")" +
    " campo_mais_proximo=" + closest03.campo + " diff=R$" + String(round2(closest03.diff)) +
    (q3b.pedidos_paid > 900 ? " !!! PEDIDOS_07-03_BATEM_COM_SHOPEE_02 -> HIPOTESE_DATA_ERRADA_CONFIRMADA !!!" : "")
  );

  diag.push(
    "ORIGEM_DATA: lib/sync-shopee.ts:267 — noBuffer=true(manual) usa CREATE_TIME, noBuffer=false(cron) usa PAY_TIME."
  );

  return NextResponse.json({
    geradoEm:       new Date().toISOString(),
    userId,
    rowsPorData: {
      "2026-06-29": porData["2026-06-29"].length,
      "2026-06-30": porData["2026-06-30"].length,
      "2026-07-01": porData["2026-07-01"].length,
      "2026-07-02": porData["2026-07-02"].length,
      "2026-07-03": porData["2026-07-03"].length,
    },
    shopeeOficial: { pedidos: SHOPEE_PEDIDOS, vendas: SHOPEE_VENDAS },
    resumo02jul: {
      total_no_banco:  totalBanco02,
      paid_no_banco:   paidBanco02,
      nao_paid:        totalBanco02 - paidBanco02,
      faltam_shopee:   SHOPEE_PEDIDOS - totalBanco02,
    },
    diagnostico: diag,
    q1_status_02jul:       q1,
    q2_resumo_por_data:    q2,
    q3_financeiro_02jul:   q3,
    q3b_financeiro_03jul:  q3b,
  });
}
