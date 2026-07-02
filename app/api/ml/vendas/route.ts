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

function diasAtras(n: number) {
  return new Date(Date.now() - 3 * 60 * 60 * 1000 - n * 86400 * 1000).toISOString().split("T")[0];
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

  const hasData        = probe && probe.length > 0;
  const lastSync       = hasData ? new Date(probe![0].synced_at).getTime() : 0;
  const staleThreshold = 2 * 60 * 60 * 1000; // 2 horas
  const isStale        = Date.now() - lastSync > staleThreshold;
  const isRecent       = dateTo >= diasAtras(7);

  // Sem token de cookie E sem cache → ML não conectada
  if (!token && !hasData) {
    return NextResponse.json({ erro: true, semConexao: true, mensagem: "Conta do Mercado Livre não conectada." });
  }

  if (forceSync || !hasData || (isRecent && isStale)) {
    // Passa o cookie token se disponível (mais fresco que o DB)
    await syncMLForUser(userId, dateFrom, dateTo, token ?? undefined);
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
