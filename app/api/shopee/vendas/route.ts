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
  const skuFilters = skuParam.split(",").map(s => s.toLowerCase().trim()).filter(Boolean);

  // Verifica conexão Shopee
  const loja = await getShopeeLojaAtiva(userId);
  if (!loja) {
    return NextResponse.json({ erro: true, semConexao: true, mensagem: "Conta Shopee não conectada." });
  }

  const { searchParams: sp2 } = new URL(request.url);
  const forceSync = sp2.get("sync") === "1";

  const hoje = hojeISO();

  // ── Sync on-demand ──────────────────────────────────────────────────────────
  // forceSync (botão Sincronizar): sincroniza ontem + hoje (máx 2 dias, cabe em 55s)
  // Auto-load: só sincroniza hoje se stale (> 30 min)
  try {
    if (forceSync) {
      // Sincroniza os últimos 2 dias (ontem + hoje) para refrescar o cache recente
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
        await syncShopeeForUser(userId, hoje, hoje, true); // noBuffer=true → create_time
      }
    }
  } catch (syncErr) {
    console.error("[shopee/vendas] sync error:", syncErr instanceof Error ? syncErr.message : syncErr);
    // Não retorna erro — lê do cache mesmo que sync falhe
  }

  // Lê do banco (range completo — pode ser cache do cron ou Histórico)
  const { data: pedidos } = await supabase
    .from("pedidos")
    .select("*")
    .eq("user_id", userId)
    .eq("marketplace", "Shopee")
    .gte("data", dateFrom)
    .lte("data", dateTo)
    .order("data", { ascending: false });

  if (!pedidos || pedidos.length === 0) {
    return NextResponse.json({
      semDados: true,
      conta: loja.nickname ?? "Shopee",
      dateFrom,
      dateTo,
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
    conta,
    totalPedidos: totalOrders,
    rows,
  });
}
