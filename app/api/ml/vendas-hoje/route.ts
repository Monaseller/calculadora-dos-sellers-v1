import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// ── Helpers ────────────────────────────────────────────────────────────────

function getToken(request: Request): string | null {
  const cookieHeader = request.headers.get("cookie") || "";
  const entry = cookieHeader.split("; ").find(c => c.startsWith("ml_access_token="));
  return entry ? entry.slice("ml_access_token=".length) : null;
}

function hojeISO() {
  // Retorna YYYY-MM-DD no horário de Brasília (UTC-3)
  const now = new Date();
  const brasilia = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  return brasilia.toISOString().split("T")[0];
}

// ── GET /api/ml/vendas-hoje ────────────────────────────────────────────────
export async function GET(request: Request) {
  const token = getToken(request);

  if (!token) {
    return NextResponse.json({ erro: true, semConexao: true, mensagem: "Conta do Mercado Livre não conectada." });
  }

  // 1. Busca dados do usuário ML para obter o seller_id
  const meRes = await fetch("https://api.mercadolibre.com/users/me", {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!meRes.ok) {
    return NextResponse.json({ erro: true, tokenExpirado: true, mensagem: "Sessão do Mercado Livre expirada. Reconecte." });
  }

  const me = await meRes.json();
  const sellerId: number = me.id;

  // 2. Datas de hoje no formato ISO 8601 com timezone
  const hoje = hojeISO();
  const dataInicio = `${hoje}T00:00:00.000-03:00`;
  const dataFim    = `${hoje}T23:59:59.999-03:00`;

  // 3. Busca pedidos pagos de hoje
  const ordersUrl = `https://api.mercadolibre.com/orders/search?seller=${sellerId}&order.status=paid&order.date_created.from=${encodeURIComponent(dataInicio)}&order.date_created.to=${encodeURIComponent(dataFim)}&limit=50`;

  const ordersRes = await fetch(ordersUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!ordersRes.ok) {
    const errData = await ordersRes.json().catch(() => ({}));
    return NextResponse.json({
      erro: true,
      mensagem: `Erro ao buscar pedidos (${ordersRes.status}): ${(errData as any).message ?? ""}`,
    });
  }

  const ordersData = await ordersRes.json();
  const orders: any[] = ordersData.results ?? [];

  if (orders.length === 0) {
    return NextResponse.json({ hoje, totalPedidos: 0, itens: [], faturamentoTotal: 0, lucroTotal: 0 });
  }

  // 4. Busca anúncios cadastrados no Supabase
  const { data: anuncios } = await supabase
    .from("anuncios")
    .select("id, ml_item_id, nome, preco_ideal, custo_produto, insumos, custo_frete, frete_gratis, imposto, margem_desejada")
    .eq("ativo", true)
    .not("ml_item_id", "is", null);

  const mapa = new Map<string, any>();
  for (const a of (anuncios ?? [])) {
    if (a.ml_item_id) mapa.set(a.ml_item_id, a);
  }

  // 5. Processa cada pedido
  type ItemVenda = {
    anuncioId: string;
    mlItemId: string;
    nome: string;
    unidades: number;
    precoUnitario: number;
    faturamento: number;
    lucro: number;
    cadastrado: boolean;
  };

  const itensPorAnuncio = new Map<string, ItemVenda>();

  for (const order of orders) {
    for (const orderItem of (order.order_items ?? [])) {
      const mlItemId: string = orderItem.item?.id ?? "";
      const unidades: number = orderItem.quantity ?? 1;
      const precoUnitario: number = orderItem.unit_price ?? 0;
      const faturamento = precoUnitario * unidades;

      const anuncio = mapa.get(mlItemId);

      const chave = mlItemId;
      const existing = itensPorAnuncio.get(chave);

      if (existing) {
        existing.unidades   += unidades;
        existing.faturamento += faturamento;
        if (anuncio) existing.lucro += faturamento * (anuncio.margem_desejada / 100);
      } else {
        const lucro = anuncio
          ? faturamento * (anuncio.margem_desejada / 100)
          : 0;

        itensPorAnuncio.set(chave, {
          anuncioId:    anuncio?.id ?? "",
          mlItemId,
          nome:         anuncio?.nome ?? (orderItem.item?.title ?? mlItemId),
          unidades,
          precoUnitario,
          faturamento,
          lucro,
          cadastrado:   !!anuncio,
        });
      }
    }
  }

  const itens = [...itensPorAnuncio.values()];
  const faturamentoTotal = itens.reduce((s, i) => s + i.faturamento, 0);
  const lucroTotal       = itens.reduce((s, i) => s + i.lucro, 0);

  // 6. Salva/atualiza vendas_dia no Supabase para anúncios cadastrados
  for (const item of itens.filter(i => i.cadastrado && i.anuncioId)) {
    await supabase.from("vendas_dia").upsert({
      anuncio_id: item.anuncioId,
      data: hoje,
      unidades_vendidas: item.unidades,
      faturamento: item.faturamento,
      lucro: item.lucro,
    }, { onConflict: "anuncio_id,data" });
  }

  return NextResponse.json({
    hoje,
    sellerId,
    totalPedidos: orders.length,
    itens,
    faturamentoTotal,
    lucroTotal,
  });
}
