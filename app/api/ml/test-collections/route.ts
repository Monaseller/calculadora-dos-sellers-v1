import { NextResponse } from "next/server";

function getToken(request: Request): string | null {
  const cookieHeader = request.headers.get("cookie") || "";
  const entry = cookieHeader.split("; ").find(c => c.startsWith("ml_access_token="));
  return entry ? entry.slice("ml_access_token=".length) : null;
}

export async function GET(request: Request) {
  const token = getToken(request);
  if (!token) return NextResponse.json({ erro: "Sem token" });

  const url = new URL(request.url);
  const date = url.searchParams.get("date") || "2026-06-22";

  const meRes = await fetch("https://api.mercadolibre.com/users/me", { headers: { Authorization: `Bearer ${token}` } });
  if (!meRes.ok) return NextResponse.json({ erro: "Token expirado" });
  const me = await meRes.json();
  const sellerId = me.id;

  async function fetchOrders(from: string, to: string, status = "paid"): Promise<any[]> {
    const orders: any[] = [];
    const seen = new Set<number>();
    let offset = 0;
    for (;;) {
      const u = `https://api.mercadolibre.com/orders/search?seller=${sellerId}&order.status=${status}` +
        `&order.date_created.from=${encodeURIComponent(from)}&order.date_created.to=${encodeURIComponent(to)}&limit=50&offset=${offset}`;
      const res = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) break;
      const data = await res.json();
      const results: any[] = data.results ?? [];
      for (const o of results) if (!seen.has(o.id)) { seen.add(o.id); orders.push(o); }
      if (results.length < 50 || offset + 50 >= 1000) break;
      offset += 50;
    }
    return orders;
  }

  // Busca dia anterior + dia atual (janela 48h) para capturar pedidos criados no final do dia anterior
  // mas aprovados no dia atual (que o painel ML conta como hoje)
  const prevDate = new Date(date + "T12:00:00Z");
  prevDate.setUTCDate(prevDate.getUTCDate() - 1);
  const prevDay = prevDate.toISOString().split("T")[0];

  const [ordersDay, ordersPrev] = await Promise.all([
    fetchOrders(`${date}T00:00:00.000-03:00`, `${date}T23:59:59.999-03:00`, "paid"),
    fetchOrders(`${prevDay}T00:00:00.000-03:00`, `${prevDay}T23:59:59.999-03:00`, "paid"),
  ]);

  // Combina e deduplica
  const seen = new Set<number>();
  const allOrders: any[] = [];
  for (const o of [...ordersDay, ...ordersPrev]) {
    if (!seen.has(o.id)) { seen.add(o.id); allOrders.push(o); }
  }

  // Filtra por date_approved no dia solicitado (timezone -03:00 BRT)
  function getDateBRT(isoStr: string | null): string {
    if (!isoStr) return "";
    // Converte para BRT (-03:00) e pega só a data
    const d = new Date(isoStr);
    const brt = new Date(d.getTime() - 3 * 60 * 60 * 1000); // UTC-3
    return brt.toISOString().split("T")[0];
  }

  // Também testa UTC-4 (o que ML usa nas respostas)
  function getDateGMT4(isoStr: string | null): string {
    if (!isoStr) return "";
    const d = new Date(isoStr);
    const gmt4 = new Date(d.getTime() - 4 * 60 * 60 * 1000);
    return gmt4.toISOString().split("T")[0];
  }

  const filteredByApprovedBRT  = allOrders.filter(o => getDateBRT(o.date_approved)  === date);
  const filteredByApprovedGMT4 = allOrders.filter(o => getDateGMT4(o.date_approved) === date);
  const filteredByCreatedBRT   = ordersDay; // nosso método atual

  // Mostra os date_approved dos primeiros 5 pedidos do dia anterior
  const prevSample = ordersPrev.slice(0, 5).map(o => ({
    id: o.id,
    date_created: o.date_created,
    date_approved: o.date_approved,
    approved_brt: getDateBRT(o.date_approved),
    approved_gmt4: getDateGMT4(o.date_approved),
  }));

  return NextResponse.json({
    date,
    painel_ml_meta: 386,
    metodo_atual_date_created_BRT: filteredByCreatedBRT.length,
    metodo_date_approved_BRT:  filteredByApprovedBRT.length,
    metodo_date_approved_GMT4: filteredByApprovedGMT4.length,
    total_pedidos_dia_anterior: ordersPrev.length,
    amostra_dia_anterior: prevSample,
    conclusao: filteredByApprovedBRT.length === 386 ? "BRT approved BATE com painel!" :
               filteredByApprovedGMT4.length === 386 ? "GMT-4 approved BATE com painel!" :
               `Mais próximo: approved_BRT=${filteredByApprovedBRT.length}, approved_GMT4=${filteredByApprovedGMT4.length}`,
  });
}
