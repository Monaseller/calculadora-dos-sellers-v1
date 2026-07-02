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
  const forceSync  = url.searchParams.get("sync") === "1";
  const skuFilters = skuParam.split(",").map(s => s.toLowerCase().trim()).filter(Boolean);

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

  if (forceSync) {
    // Botão Sincronizar: re-sincroniza o range inteiro
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

  // Lê do banco
  const { data: pedidos } = await supabase
    .from("pedidos")
    .select("*")
    .eq("user_id", userId)
    .eq("marketplace", "ML")
    .gte("data", dateFrom)
    .lte("data", dateTo)
    .order("data", { ascending: false });

  let rows = (pedidos ?? []).map(pedidoToRow);

  if (skuFilters.length > 0) {
    rows = rows.filter(r => {
      const a = (r.sku ?? "").toLowerCase();
      const b = (r.anuncio ?? "").toLowerCase();
      return skuFilters.some(f => a.includes(f) || b.includes(f));
    });
  }

  const conta       = pedidos?.[0]?.conta ?? "ML";
  const totalOrders = new Set(rows.map(r => r.orderId)).size;

  return NextResponse.json({
    dateFrom,
    dateTo,
    conta,
    totalPedidos: totalOrders,
    rows,
  });
}
