/**
 * GET /api/debug/boundary-audit
 *
 * Hipótese: Shopee atribui data aos pedidos usando UTC no order_sn (prefixo YYMMDD).
 * CDS grava data usando BRT (UTC-3). Pedidos criados entre 21h-23h59 BRT têm
 * prefixo do dia seguinte (UTC) — logo aparecem no painel Shopee como dia+1.
 *
 * Este endpoint busca pedidos paid de 01/07, 02/07 e 03/07 e compara:
 *   - data gravada no banco (BRT)
 *   - data implícita no order_sn (UTC, prefixo YYMMDD)
 *
 * Se pedidos pagos do banco em 01/07 tiverem prefixo 260702, eles aparecem
 * no painel Shopee como 02/07 — explicando a diferença de 10 pedidos / R$349,34.
 */
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getUserId } from "@/lib/session";

export const maxDuration = 60;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

function round2(n: number): number { return Math.round(n * 100) / 100; }

/**
 * Extrai data do prefixo do order_sn.
 * order_sn "260702N9HMHMR3" -> prefixo "260702" -> "2026-07-02"
 * O prefixo usa o timestamp UTC no momento da criação do pedido.
 */
function orderSnDate(orderSn: string): string | null {
  if (!orderSn || orderSn.length < 6) return null;
  const raw = orderSn.substring(0, 6);
  const yy = raw.substring(0, 2);
  const mm = raw.substring(2, 4);
  const dd = raw.substring(4, 6);
  const month = parseInt(mm, 10);
  const day   = parseInt(dd, 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `20${yy}-${mm}-${dd}`;
}

async function fetchPaidRange(userId: string, from: string, to: string): Promise<any[]> {
  const PAGE = 1000;
  const all: any[] = [];
  let offset = 0;
  for (;;) {
    const { data: rows, error } = await supabase
      .from("pedidos")
      .select(
        "order_id, data, status, item_subtotal, faturamento, anuncio, qtd, valor_unit, synced_at"
      )
      .eq("user_id", userId)
      .eq("marketplace", "Shopee")
      .eq("status", "paid")
      .gte("data", from)
      .lte("data", to)
      .range(offset, offset + PAGE - 1);

    if (error) {
      console.error("[boundary-audit] supabase:", error.message);
      break;
    }
    if (!rows || rows.length === 0) break;
    all.push(...(rows as any[]));
    if (rows.length < PAGE) break;
    offset += PAGE;
    if (offset >= 20000) break;
  }
  return all;
}

export async function GET(request: Request) {
  const userId = getUserId(request);
  if (!userId) return NextResponse.json({ erro: "Sessao invalida" }, { status: 401 });

  // 1. Busca todos os pedidos paid dos 3 dias ao redor do dia auditado
  const rows = await fetchPaidRange(userId, "2026-07-01", "2026-07-03");

  if (rows.length === 0) {
    return NextResponse.json({
      erro: "Sem dados para 01-03/07/2026. Verifique sync.",
      userId,
    });
  }

  // 2. Agrupa por order_id (múltiplos itens -> um pedido)
  const byOrder: Record<string, {
    order_id: string;
    bank_date: string;
    shopee_date: string | null;
    item_subtotal: number;
    itens: number;
    synced_at: string;
  }> = {};

  for (const r of rows) {
    if (!byOrder[r.order_id]) {
      byOrder[r.order_id] = {
        order_id:     r.order_id,
        bank_date:    r.data,
        shopee_date:  orderSnDate(r.order_id),
        item_subtotal: 0,
        itens:        0,
        synced_at:    r.synced_at,
      };
    }
    byOrder[r.order_id].item_subtotal += Number(r.item_subtotal) || 0;
    byOrder[r.order_id].itens         += 1;
  }

  const orders = Object.values(byOrder).map(o => ({
    ...o,
    item_subtotal: round2(o.item_subtotal),
    mismatched:    o.shopee_date !== o.bank_date,
    motivo:        o.shopee_date !== o.bank_date
      ? `order_sn="${o.shopee_date}" mas banco="${o.bank_date}" (${
          o.shopee_date && o.bank_date && o.shopee_date > o.bank_date
            ? "criado 21h-24h BRT, UTC já era dia seguinte"
            : "criado 00h-03h BRT, UTC ainda era dia anterior"
        })`
      : "OK",
  }));

  // 3. Classificações principais
  const SHOPEE_PEDIDOS = 989;
  const SHOPEE_VENDAS  = 22339.82;

  // Pedidos que Shopee conta como 02/07 (order_sn prefix = 260702)
  // mas banco gravou como 01/07 ou 03/07
  const shopee02_bancoDiff = orders.filter(
    o => o.shopee_date === "2026-07-02" && o.bank_date !== "2026-07-02"
  );

  // Pedidos que banco conta como 02/07
  // mas order_sn sugere outro dia (excesso no banco para 02/07)
  const banco02_shopeeDiff = orders.filter(
    o => o.bank_date === "2026-07-02" && o.shopee_date !== "2026-07-02"
  );

  // Totais banco para 02/07
  const paid02 = orders.filter(o => o.bank_date === "2026-07-02");
  const totalPaid02    = paid02.length;
  const somaFat02      = round2(paid02.reduce((a, o) => a + o.item_subtotal, 0));

  const somaShopee02extra  = round2(shopee02_bancoDiff.reduce((a, o) => a + o.item_subtotal, 0));
  const somaExcessoBanco02 = round2(banco02_shopeeDiff.reduce((a, o) => a + o.item_subtotal, 0));

  // 4. Cenário ajustado: se usarmos order_sn como referência de data
  //    + add pedidos que Shopee conta como 02 mas banco colocou em 01 ou 03
  //    - remove pedidos que banco conta como 02 mas Shopee conta como 01 ou 03
  const pedidosAjustados = totalPaid02 - banco02_shopeeDiff.length + shopee02_bancoDiff.length;
  const fatAjustado      = round2(somaFat02 - somaExcessoBanco02 + somaShopee02extra);
  const diffPedidos      = SHOPEE_PEDIDOS - pedidosAjustados;
  const diffFat          = round2(SHOPEE_VENDAS - fatAjustado);

  // 5. Conclusão
  let conclusao: string;
  if (Math.abs(diffPedidos) <= 2 && Math.abs(diffFat) <= 20) {
    conclusao = "CONFIRMADO: fuso horário UTC vs BRT explica o gap de pedidos/faturamento";
  } else if (shopee02_bancoDiff.length === 0) {
    conclusao = "NAO CONFIRMADO: nenhum pedido com order_sn 260702 foi encontrado em 01/07 ou 03/07. Causa do gap é outra.";
  } else {
    conclusao = `PARCIAL: pedidos_diff_ajustado=${diffPedidos}, fat_diff_ajustado=R$${diffFat}. Timezone explica parte mas não tudo.`;
  }

  return NextResponse.json({
    geradoEm:      new Date().toISOString(),
    data_auditada: "2026-07-02",
    hipotese:      "order_sn prefix = UTC date (Shopee). data banco = BRT (UTC-3). Criações 21h-24h BRT têm prefixo do dia UTC seguinte.",
    shopeeOficial: { pedidos: SHOPEE_PEDIDOS, vendas: SHOPEE_VENDAS },

    // Estado original (sem ajuste)
    banco_sem_ajuste: {
      paid_02jul_pedidos:   totalPaid02,
      paid_02jul_fat:       somaFat02,
      diff_pedidos:         SHOPEE_PEDIDOS - totalPaid02,
      diff_fat:             round2(SHOPEE_VENDAS - somaFat02),
    },

    // Pedidos que a Shopee contaria como 02/07 (prefixo 260702)
    // mas que o banco registrou como 01/07 ou 03/07
    shopee_02jul_banco_fora: {
      count:              shopee02_bancoDiff.length,
      soma_item_subtotal: somaShopee02extra,
      pedidos: shopee02_bancoDiff
        .sort((a, b) => b.item_subtotal - a.item_subtotal)
        .map(o => ({
          order_id:      o.order_id,
          bank_date:     o.bank_date,
          shopee_date:   o.shopee_date,
          item_subtotal: o.item_subtotal,
          motivo:        o.motivo,
          synced_at:     o.synced_at,
        })),
    },

    // Pedidos que banco conta como 02/07 mas order_sn é de outro dia
    banco_02jul_shopee_fora: {
      count:              banco02_shopeeDiff.length,
      soma_item_subtotal: somaExcessoBanco02,
      pedidos: banco02_shopeeDiff
        .sort((a, b) => b.item_subtotal - a.item_subtotal)
        .map(o => ({
          order_id:      o.order_id,
          bank_date:     o.bank_date,
          shopee_date:   o.shopee_date,
          item_subtotal: o.item_subtotal,
          motivo:        o.motivo,
          synced_at:     o.synced_at,
        })),
    },

    // Todos os mismatches (para inspeção detalhada)
    todos_mismatches: orders
      .filter(o => o.mismatched)
      .sort((a, b) => a.bank_date.localeCompare(b.bank_date))
      .map(o => ({
        order_id:      o.order_id,
        bank_date:     o.bank_date,
        shopee_date:   o.shopee_date,
        item_subtotal: o.item_subtotal,
        motivo:        o.motivo,
      })),

    // Cenário ajustado — se CDS usasse order_sn date como referência
    cenario_ajustado: {
      pedidos_02jul: pedidosAjustados,
      fat_02jul:     fatAjustado,
      diff_vs_shopee_pedidos: diffPedidos,
      diff_vs_shopee_fat:     diffFat,
      conclusao,
    },
  });
}
