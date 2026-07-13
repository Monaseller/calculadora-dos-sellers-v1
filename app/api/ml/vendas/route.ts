/**
 * GET /api/ml/vendas
 * Lê da tabela `pedidos` (cache). Se não houver dados ou estiver stale, faz sync on-demand.
 * O cron /api/sync mantém os últimos 7 dias sempre frescos.
 */
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getUserId } from "@/lib/session";
import { syncMLForUser } from "@/lib/sync-ml";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

function getToken(request: Request): string | null {
  const cookieHeader = request.headers.get("cookie") || "";
  const entry = cookieHeader.split("; ").find(c => c.startsWith("ml_access_token="));
  return entry ? entry.slice("ml_access_token=".length) : null;
}

function hojeISO() {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().split("T")[0];
}

function pedidoToRow(p: any) {
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
    faturamento:    Number(p.faturamento),
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
  const token  = getToken(request);
  const userId = getUserId(request);

  if (!userId) {
    return NextResponse.json({ erro: true, semConexao: true, mensagem: "Sessão inválida." }, { status: 401 });
  }

  const url        = new URL(request.url);
  const dateFrom   = url.searchParams.get("date_from") || hojeISO();
  const dateTo     = url.searchParams.get("date_to")   || hojeISO();
  const skuParam   = url.searchParams.get("sku") || "";
  const skuFilters = skuParam.split(",").map(s => s.toLowerCase().trim()).filter(Boolean);

  // Id da loja ML ativa — leitura simples, sem side-effect de refresh de
  // token (diferente de getMLLojaAtiva). Exposto na resposta para o
  // frontend disparar POST /api/sync/iniciar com o loja_id correto (ver
  // docs/DECISIONS.md, redesenho do botão Sincronizar, 2026-07-11).
  const { data: lojaRow } = await supabase
    .from("lojas")
    .select("id")
    .eq("user_id", userId)
    .eq("marketplace", "ML")
    .eq("ativo", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const lojaId = lojaRow?.id ?? null;

  // Fase C (2026-07-06): date_field decide se o relatório é filtrado por
  // data_pagamento (visão financeira, padrão) ou data_criacao (visão operacional).
  // Ver docs/BUSINESS_RULES.md "Fase C — date_field nas APIs de vendas".
  const dateField: "pagamento" | "criacao" =
    url.searchParams.get("date_field") === "criacao" ? "criacao" : "pagamento";

  // Checa cache
  const { data: probe } = await supabase
    .from("pedidos")
    .select("synced_at")
    .eq("user_id", userId)
    .eq("marketplace", "ML")
    .gte("data", dateFrom)
    .lte("data", dateTo)
    .order("synced_at", { ascending: false })
    .limit(1);

  const hasData = probe && probe.length > 0;
  const hoje    = hojeISO();

  // Sem token de cookie E sem cache → ML não conectada
  if (!token && !hasData) {
    return NextResponse.json({ erro: true, semConexao: true, mensagem: "Conta do Mercado Livre não conectada." });
  }

  const forceSync = url.searchParams.get("sync") === "1";

  // RESTAURADO em 2026-07-13 (ver docs/DECISIONS.md, feature flag
  // ENABLE_ASYNC_SYNC_JOBS): tinha sido removido em 2026-07-11 assumindo que
  // o novo fluxo (sync_jobs + worker) substituiria este sync inline. Como a
  // ativação em produção do fluxo novo ficou condicionada a existir um
  // processador permanente de jobs (ainda não existe), o botão Sincronizar
  // em produção precisa continuar usando exatamente este caminho enquanto
  // ENABLE_ASYNC_SYNC_JOBS=false. O front só envia ?sync=1 quando a flag
  // está desligada (ver app/(app)/vendas/page.tsx, lerMarketplace).
  // Corrigido 2026-07-13 (auditoria de segurança pré-deploy): as chamadas de
  // sync abaixo não tinham try/catch — diferente de app/api/shopee/vendas
  // (que sempre teve). syncMLForUser → syncMLForUserV2 pode lançar
  // LojaIdIntegrityError (regra de integridade de loja_id, aprovada
  // 2026-07-11) se a resolução por seller_id encontrar 0 ou 2+ lojas em vez
  // de exatamente 1 — sem este try/catch, isso derrubaria a rota inteira
  // com 500 em vez de servir o cache já existente. Nada disto depende da
  // flag ENABLE_ASYNC_SYNC_JOBS; é uma correção de segurança independente.
  try {
    if (forceSync) {
      // Botão Sincronizar (fluxo antigo): re-sincroniza o range inteiro
      await syncMLForUser(userId, dateFrom, dateTo, token ?? undefined);
    } else if (!hasData) {
      // Sem cache: sync completo (primeira vez)
      await syncMLForUser(userId, dateFrom, dateTo, token ?? undefined);
    } else {
      // Tem cache: só atualiza hoje se o range inclui hoje (barato, 1 dia)
      const rangeIncludeHoje = dateFrom <= hoje && hoje <= dateTo;
      if (rangeIncludeHoje) {
        const { data: probeHoje } = await supabase
          .from("pedidos").select("synced_at")
          .eq("user_id", userId).eq("marketplace", "ML")
          .eq("data", hoje)
          .order("synced_at", { ascending: false }).limit(1);
        const lastSyncHoje = probeHoje?.[0]?.synced_at
          ? new Date(probeHoje[0].synced_at).getTime() : 0;
        if (Date.now() - lastSyncHoje > 30 * 60 * 1000) { // stale > 30 min
          await syncMLForUser(userId, hoje, hoje, token ?? undefined);
        }
      }
    }
  } catch (syncErr) {
    console.error("[ml/vendas] sync error:", syncErr instanceof Error ? syncErr.message : syncErr);
    // Não retorna erro - lê do cache mesmo que sync falhe (mesmo padrão de shopee/vendas).
  }

  // Lê do banco
  // Fase C (2026-07-06): filtro por date_field — mesma regra do shopee/vendas.
  // "pagamento" (padrão): filtra por data_pagamento; fallback pra `data` legada
  // só quando data_criacao TAMBÉM é NULL (pedido pré-Fase-B). Pedido pós-Fase-B
  // genuinamente não pago (data_criacao preenchido, data_pagamento NULL) fica
  // de fora da visão financeira, sem exceção.
  // "criacao": filtra por data_criacao, com fallback pra `data` legada quando
  // data_criacao é NULL.
  //
  // Fase E (2026-07-07): mesma correção de truncamento aplicada em
  // shopee/vendas — o Supabase/PostgREST corta silenciosamente qualquer
  // .select() sem .range() no limite implícito do projeto (confirmado em
  // 1000 linhas na auditoria da Shopee). Aqui também passamos a buscar em
  // páginas via .range(), mesmos filtros de sempre.
  function buildPedidosQuery(
    selectArg: string,
    opts?: { count?: "exact"; head?: boolean }
  ) {
    let q = supabase
      .from("pedidos")
      .select(selectArg, opts as any)
      .eq("user_id", userId)
      .eq("marketplace", "ML");

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
  const MAX_PAGES = 50; // guarda de segurança: até 50.000 linhas
  let pedidos: any[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE_SIZE;
    const to   = from + PAGE_SIZE - 1;
    const { data: pageData, error: pageErr } = await buildPedidosQuery("*")
      .order("data", { ascending: false })
      .range(from, to);

    if (pageErr) {
      console.error("[ml/vendas] erro na página", page, pageErr.message);
      break;
    }
    if (!pageData || pageData.length === 0) break;
    pedidos = pedidos.concat(pageData);
    if (pageData.length < PAGE_SIZE) break; // última página (veio incompleta)
  }

  let rows = (pedidos ?? []).map(pedidoToRow);

  if (skuFilters.length > 0) {
    rows = rows.filter(r => {
      const a = (r.sku ?? "").toLowerCase();
      const b = (r.anuncio ?? "").toLowerCase();
      return skuFilters.some(f => a.includes(f) || b.includes(f));
    });
  }

  const conta       = pedidos?.[0]?.conta ?? "ML";
  // P5 FIX: contar apenas pedidos pagos (igual ao pedidosUnicos da página vendas)
  const totalOrders = new Set(rows.filter(r => r.status === 'paid').map(r => r.orderId)).size;

  return NextResponse.json({
    dateFrom,
    dateTo,
    dateField,
    conta,
    lojaId,
    totalPedidos: totalOrders,
    rows,
  });
}
