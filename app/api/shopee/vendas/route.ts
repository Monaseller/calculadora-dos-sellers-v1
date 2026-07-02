/**
 * GET /api/shopee/vendas
 * Lê da tabela `pedidos` (cache). Se não houver dados ou estiver stale, faz sync on-demand.
 * O cron /api/sync mantém os últimos 7 dias sempre frescos.
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
  const userId = getUserId(request);
  if (!userId) return NextResponse.json({ erro: true, mensagem: "Sessão inválida." }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const dateFrom   = searchParams.get("date_from") ?? hojeISO();
  const dateTo     = searchParams.get("date_to")   ?? dateFrom;
  const skuParam   = searchParams.get("sku") ?? "";
  const forceSync  = searchParams.get("sync") === "1";
  const skuFilters = skuParam.split(",").map(s => s.toLowerCase().trim()).filter(Boolean);

  // Verifica conexão Shopee
  const loja = await getShopeeLojaAtiva(userId);
  if (!loja) {
    return NextResponse.json({ erro: true, semConexao: true, mensagem: "Conta Shopee não conectada." });
  }

  // Checa cache: busca 1 linha para ver se há dados e quando foram sincronizados
  const { data: probe } = await supabase
    .from("pedidos")
    .select("synced_at")
    .eq("user_id", userId)
    .eq("marketplace", "Shopee")
    .gte("data", dateFrom)
    .lte("data", dateTo)
    .order("synced_at", { ascending: false })
    .limit(1);

  const hasData        = probe && probe.length > 0;
  const lastSync       = hasData ? new Date(probe![0].synced_at).getTime() : 0;
  const staleThreshold = 2 * 60 * 60 * 1000; // 2 horas
  const isStale        = Date.now() - lastSync > staleThreshold;
  const isRecent       = dateTo >= diasAtras(7); // dentro da janela do cron

  // Sincroniza se: forçado, sem dados, ou dados recentes estão stale
  if (forceSync || !hasData || (isRecent && isStale)) {
    await syncShopeeForUser(userId, dateFrom, dateTo);
  }

  // Lê do banco
  const { data: pedidos } = await supabase
    .from("pedidos")
    .select("*")
    .eq("user_id", userId)
    .eq("marketplace", "Shopee")
    .gte("data", dateFrom)
    .lte("data", dateTo)
    .order("data", { ascending: false });

  let rows = (pedidos ?? []).map(pedidoToRow);

  // Filtro SKU client-side (já aplicado no sync, mas mantemos por segurança)
  if (skuFilters.length > 0) {
    rows = rows.filter(r => {
      const a = (r.sku ?? "").toLowerCase();
      const b = (r.anuncio ?? "").toLowerCase();
      return skuFilters.some(f => a.includes(f) || b.includes(f));
    });
  }

  return NextResponse.json({
    dateFrom,
    dateTo,
    conta:        loja.nickname,
    marketplace:  "Shopee",
    totalPedidos: new Set(rows.map(r => r.orderId)).size,
    rows,
  });
}
