/**
 * GET /api/shopee/vendas
 * Lê da tabela `pedidos` (cache Supabase).
 * Sync on-demand limitado a HOJE apenas (Vercel Hobby: 10s timeout).
 * Sync de histórico via /api/sync ou botão Histórico.
 */
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getUserId } from "@/lib/session";
import { getShopeeLojaAtiva } from "@/lib/shopee-auth";
import { syncShopeeForUser } from "@/lib/sync-shopee";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

function hojeISO() {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().split("T")[0];
}

function pedidoToRow(p: any) {
  // P-FAT: faturamento Shopee = item_subtotal (preço puro dos itens, sem frete do comprador).
  // Equivale ao campo "Vendas" do painel Shopee Seller Center.
  // Fallback para p.faturamento (total_amount) em pedidos pré-Fase1 onde item_subtotal=0.
  const fatExibido = Number(p.item_subtotal) > 0
    ? Number(p.item_subtotal)
    : Number(p.faturamento);

  return {
    orderId:        p.order_id,
    data:           p.data,
    anuncio:        p.anuncio,
    mlItemId:       p.ml_item_id,
    conta:          p.conta,
    marketplace:    p.marketplace,
    sku:            p.sku,
    status:         p.status,
    frete:          p.frete,
    logistica:      p.logistica,
    valorUnit:      Number(p.valor_unit),
    qtd:            Number(p.qtd),
    faturamento:    fatExibido,  // item_subtotal (sem frete comprador)
    custo:          Number(p.custo),
    imposto:        Number(p.imposto),
    tarifaVenda:    Number(p.tarifa_venda),
    freteComprador: Number(p.frete_comprador),
    freteVendedor:  Number(p.frete_vendedor),
    margemContrib:  Number(p.margem_contrib),
    mcPercent:      Number(p.mc_percent),
    cadastrado:     p.cadastrado,
  };
}

export async function GET(request: Request) {
  const userId = getUserId(request);
  if (!userId) return NextResponse.json({ erro: true, mensagem: "Sessão inválida." }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const dateFrom   = searchParams.get("date_from") ?? hojeISO();
  const dateTo     = searchParams.get("date_to")   ?? dateFrom;
  const skuParam   = searchParams.get("sku") ?? "";
  const skuFilters = skuParam.split(",").map(s => s.toLowerCase().trim()).filter(Boolean);

  // Fase C (2026-07-06): date_field decide se o relatório é filtrado por
  // data_pagamento (visão financeira, padrão) ou data_criacao (visão operacional).
  // Ver docs/BUSINESS_RULES.md "Fase C - date_field nas APIs de vendas".
  const dateField: "pagamento" | "criacao" =
    searchParams.get("date_field") === "criacao" ? "criacao" : "pagamento";

  // Verifica conexão Shopee
  const loja = await getShopeeLojaAtiva(userId);
  if (!loja) {
    return NextResponse.json({ erro: true, semConexao: true, mensagem: "Conta Shopee não conectada." });
  }

  const forceSync = searchParams.get("sync") === "1";
  const hoje = hojeISO();

  // RESTAURADO em 2026-07-13 (ver docs/DECISIONS.md, feature flag
  // ENABLE_ASYNC_SYNC_JOBS): tinha sido removido em 2026-07-11 assumindo que
  // o novo fluxo (sync_jobs + worker) substituiria este sync inline. Como a
  // ativação em produção do fluxo novo ficou condicionada a existir um
  // processador permanente de jobs (ainda não existe), o botão Sincronizar
  // em produção precisa continuar usando exatamente este caminho enquanto
  // ENABLE_ASYNC_SYNC_JOBS=false. O front só envia ?sync=1 quando a flag
  // está desligada (ver app/(app)/vendas/page.tsx, lerMarketplace).
  try {
    if (forceSync) {
      // Botão Sincronizar (fluxo antigo): sincroniza ontem + hoje (máx 2 dias, cabe em 55s)
      const ontem = new Date(Date.now() - 3 * 60 * 60 * 1000);
      ontem.setDate(ontem.getDate() - 1);
      const ontemISO = ontem.toISOString().split("T")[0];
      const syncFrom = dateFrom > ontemISO ? dateFrom : ontemISO;
      await syncShopeeForUser(userId, syncFrom, hoje, true); // noBuffer=true → create_time
    } else if (dateFrom <= hoje && hoje <= dateTo) {
      // Auto: só sincroniza hoje se stale
      const { data: probeHoje } = await supabase
        .from("pedidos").select("synced_at")
        .eq("user_id", userId).eq("marketplace", "Shopee")
        .eq("data", hoje)
        .order("synced_at", { ascending: false }).limit(1);

      const lastSyncHoje = probeHoje?.[0]?.synced_at
        ? new Date(probeHoje[0].synced_at).getTime() : 0;

      if (Date.now() - lastSyncHoje > 30 * 60 * 1000) {
        await syncShopeeForUser(userId, hoje, hoje, true); // noBuffer=true -> create_time
      }
    }
  } catch (syncErr) {
    console.error("[shopee/vendas] sync error:", syncErr instanceof Error ? syncErr.message : syncErr);
    // Não retorna erro - lê do cache mesmo que sync falhe
  }

  // Lê do banco (range completo - pode ser cache do cron ou Histórico)
  // Fase C (2026-07-06): filtro por date_field.
  // - "pagamento" (padrão, visão financeira): filtra por data_pagamento. Pedidos
  //   com data_pagamento NULL só entram via fallback legado (coluna `data`) se
  //   TAMBÉM tiverem data_criacao NULL - isso restringe o fallback a pedidos
  //   sincronizados antes da Fase B (nunca tocados pelo código novo). Pedidos
  //   pós-Fase-B genuinamente não pagos (data_criacao preenchido, data_pagamento
  //   NULL por não terem pagamento) NÃO caem no fallback e ficam de fora da
  //   visão financeira - por decisão explícita de arquitetura, sem exceção.
  // - "criacao" (visão operacional): filtra por data_criacao, com fallback para
  //   `data` legada quando data_criacao é NULL (pedido pré-Fase-B).
  //
  // Fase E (2026-07-07): CORREÇÃO DE TRUNCAMENTO - confirmado matematicamente
  // (debug rows_length_from_select_star=1000 vs db_row_count_exact=7136) que o
  // Supabase/PostgREST corta silenciosamente qualquer .select() sem .range() no
  // limite padrão de linhas do projeto (db-max-rows). A query abaixo agora busca
  // em páginas de PAGE_SIZE via .range(), até uma página vir incompleta - mesmos
  // filtros de sempre, só que sem depender do limite implícito do PostgREST.
  function buildPedidosQuery(selectArg: string, opts?: { count?: "exact"; head?: boolean }) {
    let q = supabase
      .from("pedidos")
      .select(selectArg, opts as any)
      .eq("user_id", userId)
      .eq("marketplace", "Shopee");

    if (dateField === "pagamento") {
      q = q.or(
        `and(data_pagamento.gte.${dateFrom},data_pagamento.lte.${dateTo}),` +
        `and(data_pagamento.is.null,data_criacao.is.null,data.gte.${dateFrom},data.lte.${dateTo})`
      );
    } else {
      q = q.or(
        `and(data_criacao.gte.${dateFrom},data_criacao.lte.${dateTo}),` +
        `and(data_criacao.is.null,data.gte.${dateFrom},data.lte.${dateTo})`
      );
    }
    return q;
  }

  const PAGE_SIZE = 1000;
  const MAX_PAGES = 50; // guarda de seguranca: ate 50.000 linhas
  let pedidos: any[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
    // Desempate por "id" (2026-07-13, ver docs/BUGS.md): "data" tem milhares
    // de linhas empatadas, e sem uma chave única de desempate o Postgres/
    // PostgREST não garante ordem estável entre chamadas de paginação
    // sucessivas — confirmado que id é único e NOT NULL em toda a tabela.
    const pageResult = await buildPedidosQuery("*")
      .order("data", { ascending: false })
      .order("id",   { ascending: true })
      .range(from, to);
    const pageData = pageResult.data;
    const pageErr = pageResult.error;

    if (pageErr) {
      console.error("[shopee/vendas] erro na pagina", page, pageErr.message);
      break;
    }
    if (!pageData || pageData.length === 0) break;
    pedidos = pedidos.concat(pageData);
    if (pageData.length < PAGE_SIZE) break; // ultima pagina (veio incompleta)
  }

  if (!pedidos || pedidos.length === 0) {
    return NextResponse.json({
      semDados: true,
      conta: loja.nickname ?? "Shopee",
      lojaId: loja.lojaId,
      dateFrom,
      dateTo,
      dateField,
      totalPedidos: 0,
      rows: [],
    });
  }

  let rows = (pedidos ?? []).map(pedidoToRow);

  if (skuFilters.length > 0) {
    rows = rows.filter(r => {
      const a = (r.sku ?? "").toLowerCase();
      const b = (r.anuncio ?? "").toLowerCase();
      return skuFilters.some(f => a.includes(f) || b.includes(f));
    });
  }

  const conta       = pedidos[0]?.conta ?? loja.nickname ?? "Shopee";
  // P5 FIX: contar apenas pedidos pagos (igual ao pedidosUnicos da página vendas)
  const totalOrders = new Set(rows.filter(r => r.status === 'paid').map(r => r.orderId)).size;

  return NextResponse.json({
    dateFrom,
    dateTo,
    dateField,
    conta,
    lojaId: loja.lojaId,
    totalPedidos: totalOrders,
    rows,
  });
}
