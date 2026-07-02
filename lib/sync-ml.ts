/**
 * Sync de pedidos ML → tabela `pedidos` (Supabase).
 * Chamado pelo cron horário e pelo endpoint de vendas quando cache está vazio/stale.
 */
import { createClient } from "@supabase/supabase-js";
import { CATEGORIAS_ML } from "@/lib/comissoes-mercado-livre";
import { getMLLojaAtiva } from "@/lib/ml-auth";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// ── Helpers (idênticos ao ml/vendas/route.ts) ────────────────────────────────

function inferLogistica(order: any): string {
  const directType = order.shipping?.logistic_type as string | undefined;
  if (directType) return mapLogisticType(directType);
  if (order.fulfillment) return "Full";
  const tags: string[] = order.tags ?? [];
  if (tags.includes("fulfillment"))  return "Full";
  if (tags.includes("self_service")) return "Flex";
  if (tags.some((t: string) => ["me2","me1","drop_off","xd_drop_off","cross_docking"].includes(t))) return "Coleta";
  const shTags: string[] = order.shipping?.tags ?? [];
  if (shTags.some((t: string) => t.includes("fulfillment")))  return "Full";
  if (shTags.some((t: string) => t.includes("self_service"))) return "Flex";
  return "—";
}

function mapLogisticType(t: string): string {
  const map: Record<string, string> = {
    fulfillment: "Full", self_service: "Flex",
    me2: "Coleta", me1: "Coleta", drop_off: "Coleta",
    xd_drop_off: "Coleta", cross_docking: "Coleta",
  };
  return map[t] ?? t;
}

async function fetchOrdersRange(
  sellerId: string, token: string,
  from: string, to: string, status = "paid"
): Promise<any[]> {
  const orders: any[] = [];
  let offset = 0;
  for (;;) {
    const url =
      `https://api.mercadolibre.com/orders/search` +
      `?seller=${sellerId}&order.status=${status}` +
      `&order.date_created.from=${encodeURIComponent(from)}` +
      `&order.date_created.to=${encodeURIComponent(to)}` +
      `&limit=50&offset=${offset}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) break;
    const data = await res.json();
    const results: any[] = data.results ?? [];
    orders.push(...results);
    if (results.length < 50 || offset + 50 >= 1000) break;
    offset += 50;
  }
  return orders;
}

function gerarDias(from: string, to: string): string[] {
  const dias: string[] = [];
  const cur = new Date(`${from}T12:00:00Z`);
  const fim = new Date(`${to}T12:00:00Z`);
  while (cur <= fim) {
    dias.push(cur.toISOString().split("T")[0]);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dias;
}

function addDias(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split("T")[0];
}

// ── Função principal ──────────────────────────────────────────────────────────

export async function syncMLForUser(
  userId: string,
  dateFrom: string,
  dateTo: string,
  cookieToken?: string   // passa o token do cookie se disponível (mais fresco)
): Promise<number> {
  // Obtém token — cookie tem prioridade, depois DB
  let token = cookieToken;
  let sellerId = "";
  let conta = "ML";

  if (token) {
    const meRes = await fetch("https://api.mercadolibre.com/users/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (meRes.ok) {
      const me = await meRes.json();
      sellerId = String(me.id);
      conta    = me.nickname || me.first_name || "ML";
    } else {
      token = undefined; // cookie expirado, tenta DB
    }
  }

  if (!token) {
    const loja = await getMLLojaAtiva(userId);
    if (!loja) return 0;
    token    = loja.accessToken;
    sellerId = loja.sellerId;
    conta    = loja.nickname;
  }

  // Busca com janela estendida (5 dias antes para capturar boletos atrasados)
  const dateFetchFrom = addDias(dateFrom, -5);
  const diasFetch     = gerarDias(dateFetchFrom, dateTo);

  async function fetchAllDias(status: string): Promise<any[]> {
    const res = await Promise.all(
      diasFetch.map(d =>
        fetchOrdersRange(sellerId, token!, `${d}T00:00:00.000-03:00`, `${d}T23:59:59.999-03:00`, status)
      )
    );
    return res.flat();
  }

  const [paidOrders, confirmedOrders, paymentInProcessOrders, cancelledOrders] = await Promise.all([
    fetchAllDias("paid"),
    fetchAllDias("confirmed"),
    fetchAllDias("payment_in_process"),
    fetchAllDias("cancelled"),
  ]);

  paidOrders.forEach(o => { o._status = "paid"; });
  confirmedOrders.forEach(o => { o._status = "pending"; });
  paymentInProcessOrders.forEach(o => { o._status = "pending"; });
  cancelledOrders.forEach(o => {
    const foiReembolsado = (o.payments ?? []).some(
      (p: any) => p.status === "refunded" || p.status === "partially_refunded"
    );
    o._status = foiReembolsado ? "devolucao" : "cancelled";
  });

  const seenIds = new Set<number>();
  const allOrders = [...paidOrders, ...confirmedOrders, ...paymentInProcessOrders, ...cancelledOrders]
    .filter(o => { if (seenIds.has(o.id)) return false; seenIds.add(o.id); return true; });

  // Anúncios
  const { data: anuncios } = await supabase
    .from("anuncios")
    .select("id, ml_item_id, nome, sku, custo_produto, insumos, custo_frete, frete_gratis, imposto, tipo_anuncio, categoria")
    .eq("ativo", true)
    .not("ml_item_id", "is", null)
    .eq("user_id", userId);

  const mapaAnuncios = new Map<string, any>();
  for (const a of (anuncios ?? [])) {
    if (a.ml_item_id) mapaAnuncios.set(a.ml_item_id, a);
  }

  const rows: any[] = [];
  const now = new Date().toISOString();

  for (const order of allOrders) {
    // Data do pedido em BRT (igual ao ml/vendas atual)
    let dataPedido: string;
    if (order._status === "cancelled" || order._status === "devolucao") {
      const ref = order.date_created ?? order.date_closed ?? "";
      dataPedido = ref ? ref.split("T")[0] : dateFrom;
    } else {
      const approvedPayment = (order.payments ?? []).find(
        (p: any) => p.status === "approved" || p.status === "partially_refunded"
      );
      if (approvedPayment?.date_approved) {
        const brt = new Date(new Date(approvedPayment.date_approved).getTime() - 3 * 60 * 60 * 1000);
        dataPedido = brt.toISOString().split("T")[0];
      } else {
        const ref = order.date_created ?? "";
        dataPedido = ref ? ref.split("T")[0] : dateFrom;
      }
    }

    if (dataPedido < dateFrom || dataPedido > dateTo) continue;

    const logistica = inferLogistica(order);

    for (const orderItem of (order.order_items ?? [])) {
      const mlItemId:  string = orderItem.item?.id  ?? "";
      const qtd:       number = orderItem.quantity   ?? 1;
      const valorUnit: number = orderItem.unit_price ?? 0;
      const faturamento       = valorUnit * qtd;
      const anuncio           = mapaAnuncios.get(mlItemId);

      const saleFeeML = typeof orderItem.sale_fee === "number" ? orderItem.sale_fee : null;
      let tarifaVenda: number;
      if (saleFeeML !== null) {
        tarifaVenda = saleFeeML;
      } else {
        const cat = anuncio?.categoria
          ? CATEGORIAS_ML.find((c: any) => c.nome.toLowerCase() === (anuncio.categoria as string).toLowerCase())
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
      const margemContrib  = faturamento - tarifaVenda - freteComprador - freteVendedor - impostoVal - custo;
      const mcPercent      = faturamento > 0 ? (margemContrib / faturamento) * 100 : 0;

      rows.push({
        id:              `${userId}_ML_${order.id}_${mlItemId}`,
        user_id:         userId,
        marketplace:     "ML",
        order_id:        String(order.id),
        data:            dataPedido,
        anuncio:         anuncio?.nome ?? orderItem.item?.title ?? mlItemId,
        ml_item_id:      mlItemId,
        variation_id:    null,
        conta,
        sku:             anuncio?.sku ?? null,
        status:          order._status ?? "paid",
        frete:           freteGratis ? "gratis" : "comprador",
        logistica,
        valor_unit:      valorUnit,
        qtd,
        faturamento,
        custo,
        imposto:         impostoVal,
        tarifa_venda:    tarifaVenda,
        frete_comprador: freteComprador,
        frete_vendedor:  freteVendedor,
        margem_contrib:  margemContrib,
        mc_percent:      mcPercent,
        cadastrado:      !!anuncio,
        synced_at:       now,
      });
    }
  }

  // Upsert em lotes
  const UPSERT_BATCH = 100;
  for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
    await supabase
      .from("pedidos")
      .upsert(rows.slice(i, i + UPSERT_BATCH), { onConflict: "id" });
  }

  return rows.length;
}
