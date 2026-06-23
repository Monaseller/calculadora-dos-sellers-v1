import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { CATEGORIAS_ML } from "@/lib/comissoes-mercado-livre";

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
  const now = new Date();
  const brasilia = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  return brasilia.toISOString().split("T")[0];
}

export async function GET(request: Request) {
  const token = getToken(request);
  if (!token) {
    return NextResponse.json({ erro: true, semConexao: true, mensagem: "Conta do Mercado Livre não conectada." });
  }

  const url = new URL(request.url);
  const dateFrom          = url.searchParams.get("date_from") || hojeISO();
  const dateTo            = url.searchParams.get("date_to")   || hojeISO();
  const skuParam          = url.searchParams.get("sku") || "";
  const skuFilters        = skuParam.split(",").map(s => s.toLowerCase().trim()).filter(Boolean);
  const includeCanceladas = url.searchParams.get("include_cancelled") === "true";

  // ── Dados do usuário ML ────────────────────────────────────────────────────
  const meRes = await fetch("https://api.mercadolibre.com/users/me", {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!meRes.ok) {
    return NextResponse.json({ erro: true, tokenExpirado: true, mensagem: "Sessão do Mercado Livre expirada. Reconecte." });
  }

  const me         = await meRes.json();
  const sellerId   = me.id as number;
  const conta      = (me.nickname || me.first_name || "ML") as string;

  // ── Busca pedidos com paginação completa ──────────────────────────────────
  // ML limita offset a 1000. Para ranges longos dividimos por dia.
  // Usamos BRT (-03:00) que é o horário do painel do ML.
  // Para cobrir pedidos na fronteira de meia-noite, alargamos 3h no início (= UTC midnight do dia).
  const dataInicio = `${dateFrom}T00:00:00.000-03:00`;
  const dataFim    = `${dateTo}T23:59:59.999-03:00`;


  async function fetchOrdersRange(from: string, to: string, status = "paid"): Promise<any[]> {
    const orders: any[] = [];
    const pageLimit = 50;
    let offset = 0;

    for (;;) {
      const url =
        `https://api.mercadolibre.com/orders/search` +
        `?seller=${sellerId}` +
        `&order.status=${status}` +
        `&order.date_created.from=${encodeURIComponent(from)}` +
        `&order.date_created.to=${encodeURIComponent(to)}` +
        `&limit=${pageLimit}&offset=${offset}`;

      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) break;

      const data = await res.json();
      const results: any[] = data.results ?? [];
      orders.push(...results);

      if (results.length < pageLimit || offset + pageLimit >= 1000) break;
      offset += pageLimit;
    }

    return orders;
  }

  // Gera lista de dias entre dateFrom e dateTo
  function gerarDias(from: string, to: string): string[] {
    const dias: string[] = [];
    const cur = new Date(`${from}T12:00:00Z`); // meio-dia UTC para evitar problemas de timezone
    const fim = new Date(`${to}T12:00:00Z`);
    while (cur <= fim) {
      dias.push(cur.toISOString().split("T")[0]);
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return dias;
  }

  const dias = gerarDias(dateFrom, dateTo);

  async function fetchAllDias(status: string): Promise<any[]> {
    if (dias.length > 1) {
      const res = await Promise.all(
        dias.map(d => fetchOrdersRange(`${d}T00:00:00.000-03:00`, `${d}T23:59:59.999-03:00`, status))
      );
      return res.flat();
    }
    return fetchOrdersRange(dataInicio, dataFim, status);
  }

  // Canceladas: usa o mesmo período selecionado, igual aos pedidos pagos
  async function fetchAllCancelled(): Promise<any[]> {
    return fetchAllDias("cancelled");
  }

  // Sempre busca canceladas — precisamos delas para classificar "devolucao"
  // (pedidos pagos-e-devolvidos que o ML conta como "vendas" no painel)
  const [paidOrders, confirmedOrders, paymentInProcessOrders, cancelledOrders] = await Promise.all([
    fetchAllDias("paid"),
    fetchAllDias("confirmed"),
    fetchAllDias("payment_in_process"),
    fetchAllCancelled(),
  ]);
  void includeCanceladas; // mantido no contrato da API por compatibilidade

  // Marca status — confirmed e payment_in_process tratados como "paid" para fins de exibição
  paidOrders.forEach(o => { o._status = "paid"; });
  confirmedOrders.forEach(o => { o._status = "paid"; });
  paymentInProcessOrders.forEach(o => { o._status = "paid"; });
  cancelledOrders.forEach(o => {
    const foiPago = (o.paid_amount ?? 0) > 0 ||
      (o.payments ?? []).some((p: any) => p.status === "approved" || p.status === "refunded");
    o._status = foiPago ? "devolucao" : "cancelled";
  });

  // Deduplica por order id (um mesmo pedido não deve aparecer em dois status)
  const seenIds = new Set<number>();
  const allOrders = [...paidOrders, ...confirmedOrders, ...paymentInProcessOrders, ...cancelledOrders]
    .filter(o => { if (seenIds.has(o.id)) return false; seenIds.add(o.id); return true; });

  // ── Inferência de logística sem chamadas extras à API ────────────────────
  // O /orders/search retorna campos suficientes para identificar Full e Flex:
  //   order.fulfillment         → existe e não-nulo = Full (Fulfillment)
  //   order.shipping.logistic_type → às vezes presente diretamente
  //   order.tags                → array com strings como "fulfillment", "self_service"
  //
  // Isso elimina ~380 chamadas extras por request (que causavam rate limit 429 no ML).
  function inferLogistica(order: any): string {
    // 1. Se o campo logistic_type vier direto no shipping (algumas versões da API)
    const directType = order.shipping?.logistic_type as string | undefined;
    if (directType) {
      return mapLogisticType(directType);
    }
    // 2. Se existir fulfillment object → Full
    if (order.fulfillment) return "Full";
    // 3. Verifica tags do pedido
    const tags: string[] = order.tags ?? [];
    if (tags.includes("fulfillment"))  return "Full";
    if (tags.includes("self_service")) return "Flex";
    if (tags.includes("me2") || tags.includes("me1") || tags.includes("drop_off") ||
        tags.includes("xd_drop_off") || tags.includes("cross_docking")) return "Coleta";
    // 4. Verifica shipping.tags
    const shTags: string[] = order.shipping?.tags ?? [];
    if (shTags.some((t: string) => t.includes("fulfillment"))) return "Full";
    if (shTags.some((t: string) => t.includes("self_service"))) return "Flex";
    // 5. Não identificado
    return "—";
  }

  function mapLogisticType(t: string): string {
    const map: Record<string, string> = {
      fulfillment:   "Full",
      self_service:  "Flex",
      me2:           "Coleta",
      me1:           "Coleta",
      drop_off:      "Coleta",
      xd_drop_off:   "Coleta",
      cross_docking: "Coleta",
    };
    return map[t] ?? t;
  }

  const shippingLogisticMap = new Map<number, string>();
  // Preenche com inferência local (sem chamadas extras)
  for (const o of allOrders) {
    const shId = o.shipping?.id;
    if (shId && !shippingLogisticMap.has(shId)) {
      shippingLogisticMap.set(shId, inferLogistica(o));
    }
  }

  // ── Anúncios cadastrados no Supabase ──────────────────────────────────────
  const { data: anuncios } = await supabase
    .from("anuncios")
    .select("id, ml_item_id, nome, sku, preco_anuncio, custo_produto, insumos, custo_frete, frete_gratis, imposto, tipo_anuncio, categoria")
    .eq("ativo", true)
    .not("ml_item_id", "is", null);

  const mapaAnuncios = new Map<string, any>();
  for (const a of (anuncios ?? [])) {
    if (a.ml_item_id) mapaAnuncios.set(a.ml_item_id, a);
  }

  // ── Monta linhas da tabela ─────────────────────────────────────────────────
  type VendaRow = {
    orderId:        string;
    data:           string;
    anuncio:        string;
    conta:          string;
    marketplace:    string;
    sku:            string | null;
    mlItemId:       string;
    frete:          "gratis" | "comprador";
    logistica:      string;
    status:         "paid" | "cancelled" | "devolucao";
    valorUnit:      number;
    qtd:            number;
    faturamento:    number;
    custo:          number;
    imposto:        number;
    tarifaVenda:    number;
    freteComprador: number;
    freteVendedor:  number;
    margemContrib:  number;
    mcPercent:      number;
    cadastrado:     boolean;
  };

  const rows: VendaRow[] = [];

  for (const order of allOrders) {
    const dateRef = order._status === "cancelled" || order._status === "devolucao"
      ? (order.date_closed ?? order.date_created ?? "")
      : (order.date_created ?? "");
    const dataPedido: string = dateRef.split("T")[0] || dateFrom;

    const rawLogistic = shippingLogisticMap.get(order.shipping?.id) ?? "";
    const logisticaOrder =
      rawLogistic === "fulfillment"   ? "Full"   :
      rawLogistic === "self_service"  ? "Flex"   :
      rawLogistic === "me2"           ? "Coleta" :
      rawLogistic === "me1"           ? "Coleta" :
      rawLogistic === "drop_off"      ? "Coleta" :
      rawLogistic === "xd_drop_off"   ? "Coleta" :
      rawLogistic === "cross_docking" ? "Coleta" :
      rawLogistic                     || "—";

    for (const orderItem of (order.order_items ?? [])) {
      const mlItemId:  string = orderItem.item?.id  ?? "";
      const qtd:       number = orderItem.quantity   ?? 1;
      const valorUnit: number = orderItem.unit_price ?? 0;
      const faturamento       = valorUnit * qtd;
      const logistica         = logisticaOrder;

      const anuncio = mapaAnuncios.get(mlItemId);
      const sku: string | null = anuncio?.sku ?? null;

      if (skuFilters.length > 0) {
        const skuLower  = sku?.toLowerCase() ?? "";
        const nameLower = (anuncio?.nome ?? orderItem.item?.title ?? "").toLowerCase();
        const match = skuFilters.some(f => skuLower.includes(f) || nameLower.includes(f));
        if (!match) continue;
      }

      const saleFeeML = typeof orderItem.sale_fee === "number" ? orderItem.sale_fee : null;

      let tarifaVenda: number;
      if (saleFeeML !== null) {
        tarifaVenda = saleFeeML;
      } else {
        const cat = anuncio?.categoria
          ? CATEGORIAS_ML.find(c => c.nome.toLowerCase() === (anuncio.categoria as string).toLowerCase())
          : null;
        const comissaoRate = cat
          ? (anuncio.tipo_anuncio === "Premium" ? cat.premium : cat.classico)
          : 0.13;
        tarifaVenda = faturamento * comissaoRate;
      }

      const impostoVal     = anuncio ? faturamento * ((anuncio.imposto || 0) / 100) : 0;
      const custo          = anuncio ? ((anuncio.custo_produto || 0) + (anuncio.insumos || 0)) * qtd : 0;
      const freteGratis    = anuncio?.frete_gratis ?? false;
      const custoFrete     = (anuncio?.custo_frete ?? 0) as number;
      const freteComprador = freteGratis ? 0 : custoFrete * qtd;
      const freteVendedor  = freteGratis ? custoFrete * qtd : 0;
      const margemContrib  = faturamento - tarifaVenda - (freteComprador + freteVendedor) - impostoVal - custo;
      const mcPercent      = faturamento > 0 ? (margemContrib / faturamento) * 100 : 0;

      rows.push({
        orderId:        String(order.id),
        data:           dataPedido,
        anuncio:        anuncio?.nome ?? orderItem.item?.title ?? mlItemId,
        conta,
        status:         (order._status ?? "paid") as "paid" | "cancelled" | "devolucao",
        marketplace:    "ML",
        sku,
        mlItemId,
        frete:          freteGratis ? "gratis" : "comprador",
        logistica,
        valorUnit,
        qtd,
        faturamento,
        custo,
        imposto:        impostoVal,
        tarifaVenda,
        freteComprador,
        freteVendedor,
        margemContrib,
        mcPercent,
        cadastrado:     !!anuncio,
      });
    }
  }

  rows.sort((a, b) => b.data.localeCompare(a.data));

  return NextResponse.json({
    dateFrom,
    dateTo,
    conta,
    sellerId,
    totalPedidos: allOrders.length,
    rows,
  });
}
