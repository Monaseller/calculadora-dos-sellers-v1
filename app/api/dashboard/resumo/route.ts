/**
 * GET /api/dashboard/resumo
 *
 * Lê SOMENTE `dashboard_resumos_diarios` — nunca `pedidos` diretamente
 * (regra aprovada 2026-07-10: "O Dashboard nunca deverá acessar diretamente
 * a tabela pedidos para gerar KPIs principais"). Alimenta Cards, KPIs,
 * Gráficos e Balancete do Dashboard.
 *
 * A tabela de resumos não é fonte de verdade (ver migration) — os números
 * aqui são só a soma dos dias já pré-agregados a partir de `pedidos` por
 * lib/resumos-diarios.ts.
 *
 * Query params:
 *   date_from, date_to  - obrigatórios, YYYY-MM-DD
 *   date_field           - "pagamento" (padrão) | "criacao"
 *   marketplace          - opcional: "ML" | "Shopee". Sem isso, soma todos.
 *   conta                - opcional: filtra uma conta específica.
 */
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getUserId } from "@/lib/session";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

interface ResumoRow {
  data_referencia:     string;
  marketplace:         string;
  conta:               string;
  pedidos_total:        number;
  pedidos_pagos:        number;
  pedidos_cancelados:   number;
  pedidos_devolvidos:   number;
  faturamento:          number;
  faturamento_bruto:    number;
  buyer_paid_amount:    number;
  escrow_amount:        number;
  commission_fee:       number;
  service_fee:          number;
  transaction_fee:      number;
  campaign_fee:         number;
  voucher_from_seller:  number;
  voucher_from_shopee:  number;
  custo:                number;
  imposto:              number;
  frete:                number;
  lucro:                number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export async function GET(request: Request) {
  const userId = getUserId(request);
  if (!userId) return NextResponse.json({ erro: true, mensagem: "Sessão inválida." }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const dateFrom = searchParams.get("date_from");
  const dateTo   = searchParams.get("date_to");
  if (!dateFrom || !dateTo) {
    return NextResponse.json({ ok: false, erro: "date_from e date_to são obrigatórios." }, { status: 400 });
  }

  const dateField: "pagamento" | "criacao" =
    searchParams.get("date_field") === "criacao" ? "criacao" : "pagamento";
  const marketplace = searchParams.get("marketplace");
  const conta        = searchParams.get("conta");

  let q = supabase
    .from("dashboard_resumos_diarios")
    .select(
      "data_referencia, marketplace, conta, pedidos_total, pedidos_pagos, pedidos_cancelados, " +
      "pedidos_devolvidos, faturamento, faturamento_bruto, buyer_paid_amount, escrow_amount, " +
      "commission_fee, service_fee, transaction_fee, campaign_fee, voucher_from_seller, " +
      "voucher_from_shopee, custo, imposto, frete, lucro"
    )
    .eq("user_id", userId)
    .eq("tipo_data", dateField)
    .gte("data_referencia", dateFrom)
    .lte("data_referencia", dateTo);

  if (marketplace) q = q.eq("marketplace", marketplace);
  if (conta)        q = q.eq("conta", conta);

  const { data, error } = await q.order("data_referencia", { ascending: true });
  if (error) {
    return NextResponse.json({ ok: false, erro: "Erro ao ler dashboard_resumos_diarios: " + error.message }, { status: 500 });
  }

  const linhas = (data ?? []) as unknown as ResumoRow[];

  const kpis = linhas.reduce((acc, r) => ({
    pedidosTotal:       acc.pedidosTotal + (r.pedidos_total ?? 0),
    pedidosPagos:       acc.pedidosPagos + (r.pedidos_pagos ?? 0),
    pedidosCancelados:  acc.pedidosCancelados + (r.pedidos_cancelados ?? 0),
    pedidosDevolvidos:  acc.pedidosDevolvidos + (r.pedidos_devolvidos ?? 0),
    faturamento:        acc.faturamento + (Number(r.faturamento) || 0),
    faturamentoBruto:   acc.faturamentoBruto + (Number(r.faturamento_bruto) || 0),
    buyerPaidAmount:    acc.buyerPaidAmount + (Number(r.buyer_paid_amount) || 0),
    escrowAmount:       acc.escrowAmount + (Number(r.escrow_amount) || 0),
    commissionFee:      acc.commissionFee + (Number(r.commission_fee) || 0),
    serviceFee:         acc.serviceFee + (Number(r.service_fee) || 0),
    transactionFee:     acc.transactionFee + (Number(r.transaction_fee) || 0),
    campaignFee:        acc.campaignFee + (Number(r.campaign_fee) || 0),
    voucherFromSeller:  acc.voucherFromSeller + (Number(r.voucher_from_seller) || 0),
    voucherFromShopee:  acc.voucherFromShopee + (Number(r.voucher_from_shopee) || 0),
    custo:              acc.custo + (Number(r.custo) || 0),
    imposto:            acc.imposto + (Number(r.imposto) || 0),
    frete:              acc.frete + (Number(r.frete) || 0),
    lucro:              acc.lucro + (Number(r.lucro) || 0),
  }), {
    pedidosTotal: 0, pedidosPagos: 0, pedidosCancelados: 0, pedidosDevolvidos: 0,
    faturamento: 0, faturamentoBruto: 0, buyerPaidAmount: 0, escrowAmount: 0,
    commissionFee: 0, serviceFee: 0, transactionFee: 0, campaignFee: 0,
    voucherFromSeller: 0, voucherFromShopee: 0, custo: 0, imposto: 0, frete: 0, lucro: 0,
  });

  // Recalculado no agregado (razão de somas), não soma de percentuais diários.
  const margemContribuicao = kpis.faturamento > 0 ? (kpis.lucro / kpis.faturamento) * 100 : 0;
  const ticketMedio        = kpis.pedidosPagos > 0 ? kpis.faturamento / kpis.pedidosPagos : 0;

  // Série diária: soma por data_referencia (caso marketplace/conta não tenham
  // sido filtrados, um mesmo dia pode ter múltiplas linhas — uma por conta).
  const porDia = new Map<string, { data: string; faturamento: number; lucro: number; custo: number; frete: number; pedidosPagos: number }>();
  for (const r of linhas) {
    const atual = porDia.get(r.data_referencia) ?? {
      data: r.data_referencia, faturamento: 0, lucro: 0, custo: 0, frete: 0, pedidosPagos: 0,
    };
    atual.faturamento  += Number(r.faturamento) || 0;
    atual.lucro         += Number(r.lucro) || 0;
    atual.custo          += Number(r.custo) || 0;
    atual.frete           += Number(r.frete) || 0;
    atual.pedidosPagos    += r.pedidos_pagos ?? 0;
    porDia.set(r.data_referencia, atual);
  }
  const serieDiaria = Array.from(porDia.values())
    .sort((a, b) => a.data.localeCompare(b.data))
    .map(d => ({
      data: d.data,
      faturamento: round2(d.faturamento),
      lucro: round2(d.lucro),
      custo: round2(d.custo),
      frete: round2(d.frete),
      pedidosPagos: d.pedidosPagos,
    }));

  return NextResponse.json({
    ok: true,
    dateFrom, dateTo, dateField,
    marketplace: marketplace ?? "todos",
    conta: conta ?? "todas",
    kpis: {
      ...kpis,
      faturamento:        round2(kpis.faturamento),
      faturamentoBruto:   round2(kpis.faturamentoBruto),
      buyerPaidAmount:    round2(kpis.buyerPaidAmount),
      escrowAmount:       round2(kpis.escrowAmount),
      commissionFee:      round2(kpis.commissionFee),
      serviceFee:         round2(kpis.serviceFee),
      transactionFee:     round2(kpis.transactionFee),
      campaignFee:        round2(kpis.campaignFee),
      voucherFromSeller:  round2(kpis.voucherFromSeller),
      voucherFromShopee:  round2(kpis.voucherFromShopee),
      custo:              round2(kpis.custo),
      imposto:            round2(kpis.imposto),
      frete:              round2(kpis.frete),
      lucro:              round2(kpis.lucro),
      margemContribuicao: round2(margemContribuicao),
      ticketMedio:        round2(ticketMedio),
    },
    serieDiaria,
    diasComResumo: linhas.length,
  });
}
