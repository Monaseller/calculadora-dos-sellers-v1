/**
 * GET /api/debug/reconcile-989
 *
 * Reconstroi o universo EXATO de pedidos de 2026-07-02, dos dois lados, e
 * cruza por order_sn. Não testa hipótese (timezone/status/pipeline/etc) —
 * só produz a diferença real. Correção em relação ao endpoint anterior
 * (full-reconciliation): aquele usava create_time UNIÃO update_time, o que
 * trouxe centenas de pedidos de OUTROS dias (update_time muda toda vez que
 * o status do pedido muda, então um pedido criado em 14/06 mas despachado em
 * 02/07 aparecia lá). Aqui o universo Shopee usa SÓ create_time — é o campo
 * que não muda depois que o pedido é criado, e é o que dá origem ao prefixo
 * do order_sn.
 *
 * Lado Shopee (universo A):
 *   get_order_list(time_range_field=create_time, 02/07 00:00–23:59:59 BRT),
 *   SEM filtro de status (traz todo mundo, não só "paid").
 *
 * Lado CDS (universo B):
 *   pedidos do banco com data = '2026-07-02' E status = 'paid' — é
 *   literalmente a mesma regra que o dashboard do CDS usa hoje para
 *   contar "979 pedidos" (ver docs/BUSINESS_RULES.md).
 *
 * Cruzamento por order_sn / order_id. Para os pedidos que sobram só de um
 * lado, é feita uma consulta extra e pontual (get_order_detail direto por
 * order_sn, sem filtro de data — e busca ampla no banco por esses mesmos
 * order_id) para dizer o motivo exato, não uma suposição.
 */
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getUserId } from "@/lib/session";
import { getShopeeLojaAtiva } from "@/lib/shopee-auth";
import { shopeeGet } from "@/lib/shopee-api";

export const maxDuration = 60;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

function round2(n: number): number { return Math.round((Number(n) || 0) * 100) / 100; }
function toEpoch(iso: string): number { return Math.floor(new Date(iso).getTime() / 1000); }
function isoOrNull(ts: any): string | null {
  const n = Number(ts);
  return n ? new Date(n * 1000).toISOString() : null;
}
function brtDateFromEpoch(ts: any): string | null {
  const n = Number(ts);
  if (!n) return null;
  return new Date((n - 3 * 3600) * 1000).toISOString().split("T")[0];
}

function mapStatus(s: string): string {
  const m: Record<string, string> = {
    UNPAID: "pending",
    READY_TO_SHIP: "paid", RETRY_SHIP: "paid", PROCESSED: "paid",
    SHIPPED: "paid", TO_CONFIRM_RECEIVE: "paid", COMPLETED: "paid",
    CANCELLED: "cancelled", IN_CANCEL: "cancelled",
    TO_RETURN: "devolucao", RETURN: "devolucao", RETURN_APPROVE: "devolucao",
    RETURN_DONE: "devolucao", REFUND: "devolucao", LOST: "lost", DAMAGED: "devolucao",
  };
  return m[s] ?? "unknown";
}

async function fetchOrderSnList(
  partnerId: string, partnerKey: string, accessToken: string, shopId: number,
  timeFrom: number, timeTo: number
): Promise<string[]> {
  const all: string[] = [];
  let cursor = "";
  for (;;) {
    const params: Record<string, string | number> = {
      time_range_field: "create_time",
      time_from: timeFrom,
      time_to: timeTo,
      page_size: 100,
      response_optional_fields: "order_status",
    };
    if (cursor) params.cursor = cursor;
    const data = await shopeeGet("/api/v2/order/get_order_list", partnerId, partnerKey, accessToken, shopId, params);
    if (data?.error && data.error !== "") {
      throw new Error(`get_order_list error: ${data.error} -- ${data.message ?? ""}`);
    }
    const list: any[] = data?.response?.order_list ?? [];
    for (const o of list) all.push(o.order_sn);
    if (!data?.response?.more || !data?.response?.next_cursor) break;
    cursor = data.response.next_cursor;
  }
  return all;
}

const DETAIL_FIELDS = "item_list,order_status,create_time,pay_time,update_time,total_amount,income_distribution";

async function fetchOrderDetailsConcurrent(
  orderSns: string[], partnerId: string, partnerKey: string, accessToken: string, shopId: number
): Promise<any[]> {
  const BATCH = 50;
  const CONCURRENCY = 8;
  const batches: string[][] = [];
  for (let i = 0; i < orderSns.length; i += BATCH) batches.push(orderSns.slice(i, i + BATCH));

  const out: any[] = [];
  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const grupo = batches.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      grupo.map(batch =>
        shopeeGet("/api/v2/order/get_order_detail", partnerId, partnerKey, accessToken, shopId, {
          order_sn_list: batch.join(","),
          response_optional_fields: DETAIL_FIELDS,
        }).catch((e: any) => ({ __erro: String(e?.message ?? e) }))
      )
    );
    for (const r of results) {
      if (r?.__erro) continue; // ignorado; nao trava a auditoria por causa de 1 lote
      for (const o of (r?.response?.order_list ?? [])) out.push(o);
    }
  }
  return out;
}

function detailToRecord(o: any) {
  const itemSubtotal = (o.item_list ?? []).reduce((s: number, it: any) =>
    s + Number(it.model_discounted_price ?? it.model_original_price ?? 0) * Number(it.model_quantity_purchased ?? 1), 0);
  const inc = o.income_distribution ?? {};
  const buyerPaidAmount = Number(inc.buyer_total_amount ?? o.total_amount ?? 0);
  return {
    order_sn:          o.order_sn,
    status_raw:        o.order_status,
    status_mapeado:    mapStatus(o.order_status ?? "UNKNOWN"),
    item_subtotal:     round2(itemSubtotal),
    buyer_paid_amount: round2(buyerPaidAmount),
    create_time:       isoOrNull(o.create_time),
    pay_time:          isoOrNull(o.pay_time),
    update_time:       isoOrNull(o.update_time),
    create_time_brt_date: brtDateFromEpoch(o.create_time),
    pay_time_brt_date:    brtDateFromEpoch(o.pay_time),
  };
}

async function fetchCdsDia(userId: string, data: string): Promise<any[]> {
  const PAGE = 1000;
  const all: any[] = [];
  let offset = 0;
  for (;;) {
    const { data: rows, error } = await supabase
      .from("pedidos")
      .select("order_id, data, status, item_subtotal, buyer_paid_amount, synced_at")
      .eq("user_id", userId)
      .eq("marketplace", "Shopee")
      .eq("data", data)
      .range(offset, offset + PAGE - 1);
    if (error) { console.error("[reconcile-989] supabase:", error.message); break; }
    if (!rows || rows.length === 0) break;
    all.push(...rows);
    if (rows.length < PAGE) break;
    offset += PAGE;
    if (offset >= 20000) break;
  }
  return all;
}

async function fetchCdsPorOrderIds(userId: string, orderIds: string[]): Promise<any[]> {
  if (orderIds.length === 0) return [];
  const { data: rows, error } = await supabase
    .from("pedidos")
    .select("order_id, data, status, item_subtotal, buyer_paid_amount, synced_at")
    .eq("user_id", userId)
    .eq("marketplace", "Shopee")
    .in("order_id", orderIds);
  if (error) { console.error("[reconcile-989] supabase (lookup avulso):", error.message); return []; }
  return rows ?? [];
}

export async function GET(request: Request) {
  const userId = getUserId(request);
  if (!userId) return NextResponse.json({ erro: "Sessao invalida" }, { status: 401 });

  const loja = await getShopeeLojaAtiva(userId);
  if (!loja) return NextResponse.json({ erro: "Shopee nao conectada" }, { status: 400 });
  const { partnerId, partnerKey, accessToken, shopId } = loja;

  const PERIODO = "2026-07-02";
  const dayFrom = toEpoch(`${PERIODO}T00:00:00-03:00`);
  const dayTo   = toEpoch(`${PERIODO}T23:59:59-03:00`);

  // ══════════════════════════════════════════════════════════════════════
  // PASSO 1 — Universo Shopee: SÓ create_time = 02/07, sem filtro de status
  // ══════════════════════════════════════════════════════════════════════
  let orderSns: string[] = [];
  try {
    orderSns = await fetchOrderSnList(partnerId, partnerKey, accessToken, shopId, dayFrom, dayTo);
  } catch (e: any) {
    return NextResponse.json({ erro: "Falha ao listar pedidos Shopee (create_time)", detalhe: String(e?.message ?? e) }, { status: 502 });
  }

  if (orderSns.length === 0) {
    return NextResponse.json({ erro: `Shopee nao retornou pedidos via create_time para ${PERIODO}.` });
  }

  const detailsRaw = await fetchOrderDetailsConcurrent(orderSns, partnerId, partnerKey, accessToken, shopId);
  const shopeeMap = new Map<string, ReturnType<typeof detailToRecord>>();
  for (const o of detailsRaw) shopeeMap.set(o.order_sn, detailToRecord(o));

  const shopeeTotalAll  = shopeeMap.size;
  const shopeeTotalPaid = [...shopeeMap.values()].filter(r => r.status_mapeado === "paid").length;

  // ══════════════════════════════════════════════════════════════════════
  // PASSO 2 — Universo CDS: data = 02/07 (mesma regra que o dashboard usa)
  // ══════════════════════════════════════════════════════════════════════
  const cdsRowsDia = await fetchCdsDia(userId, PERIODO);
  const cdsMapAll = new Map<string, any>();
  for (const r of cdsRowsDia) {
    if (!cdsMapAll.has(r.order_id)) {
      cdsMapAll.set(r.order_id, { order_id: r.order_id, data: r.data, status: r.status, item_subtotal: 0, buyer_paid_amount: 0, synced_at: r.synced_at });
    }
    const c = cdsMapAll.get(r.order_id);
    c.item_subtotal += Number(r.item_subtotal) || 0;
    c.buyer_paid_amount += Number(r.buyer_paid_amount) || 0;
  }
  for (const c of cdsMapAll.values()) { c.item_subtotal = round2(c.item_subtotal); c.buyer_paid_amount = round2(c.buyer_paid_amount); }

  const cdsMapPaid = new Map<string, any>();
  for (const [id, c] of cdsMapAll) if (c.status === "paid") cdsMapPaid.set(id, c);

  const cdsTotalAll  = cdsMapAll.size;
  const cdsTotalPaid = cdsMapPaid.size;

  // ══════════════════════════════════════════════════════════════════════
  // PASSO 3 — Cruzamento: universo Shopee (todo status, create_time=02/07)
  //           vs universo CDS (status=paid, data=02/07)
  // ══════════════════════════════════════════════════════════════════════
  const shopeeSet = new Set(shopeeMap.keys());
  const cdsSet    = new Set(cdsMapPaid.keys());

  const soShopeeIds = [...shopeeSet].filter(sn => !cdsSet.has(sn));
  const soCdsIds    = [...cdsSet].filter(id => !shopeeSet.has(id));
  const emAmbosIds  = [...shopeeSet].filter(sn => cdsSet.has(sn));

  // ── Enriquecimento factual: pedidos só-Shopee — existem no banco em
  //    QUALQUER status/data (não só paid/02-07)? ────────────────────────
  const buscaAmplaSoShopee = await fetchCdsPorOrderIds(userId, soShopeeIds);
  const bancoAmploMap = new Map<string, any[]>();
  for (const r of buscaAmplaSoShopee) {
    if (!bancoAmploMap.has(r.order_id)) bancoAmploMap.set(r.order_id, []);
    bancoAmploMap.get(r.order_id)!.push(r);
  }

  const pedidosSoShopee = soShopeeIds.map(sn => {
    const s = shopeeMap.get(sn)!;
    const outrasLinhasBanco = bancoAmploMap.get(sn) ?? [];
    let motivo: string;
    if (outrasLinhasBanco.length === 0) {
      motivo = `order_sn nao encontrado em NENHUMA linha do banco (nenhum status, nenhuma data). Nao foi sincronizado.`;
    } else {
      const statusesEncontrados = [...new Set(outrasLinhasBanco.map(r => r.status))].join(",");
      const datasEncontradas    = [...new Set(outrasLinhasBanco.map(r => r.data))].join(",");
      motivo = `Existe no banco com status=[${statusesEncontrados}] e data=[${datasEncontradas}] — nao esta em (status=paid AND data=${PERIODO}).`;
    }
    return {
      order_sn: sn,
      status_shopee: s.status_raw,
      status_shopee_mapeado: s.status_mapeado,
      status_cds: outrasLinhasBanco.length > 0 ? [...new Set(outrasLinhasBanco.map(r => r.status))].join(",") : null,
      create_time: s.create_time,
      pay_time: s.pay_time,
      update_time: s.update_time,
      data_gravada_banco: outrasLinhasBanco.length > 0 ? [...new Set(outrasLinhasBanco.map(r => r.data))].join(",") : null,
      item_subtotal: s.item_subtotal,
      buyer_paid_amount: s.buyer_paid_amount,
      motivo_exato: motivo,
    };
  }).sort((a, b) => b.item_subtotal - a.item_subtotal);

  // ── Enriquecimento factual: pedidos só-CDS — o que a Shopee diz sobre
  //    esse order_sn, direto por get_order_detail (sem filtro de data)? ──
  let detalheSoCdsRaw: any[] = [];
  if (soCdsIds.length > 0) {
    detalheSoCdsRaw = await fetchOrderDetailsConcurrent(soCdsIds, partnerId, partnerKey, accessToken, shopId);
  }
  const detalheSoCdsMap = new Map<string, ReturnType<typeof detailToRecord>>();
  for (const o of detalheSoCdsRaw) detalheSoCdsMap.set(o.order_sn, detailToRecord(o));

  const pedidosSoCds = soCdsIds.map(id => {
    const c = cdsMapPaid.get(id)!;
    const s = detalheSoCdsMap.get(id);
    let motivo: string;
    if (!s) {
      motivo = `order_sn NAO EXISTE na API Shopee (get_order_detail sem filtro de data nao retornou nada para este order_sn). Pode ser order_sn invalido ou de outra loja/conta.`;
    } else if (s.create_time_brt_date !== PERIODO) {
      motivo = `Shopee diz que este pedido foi criado em ${s.create_time_brt_date} (create_time=${s.create_time}), nao em ${PERIODO}. Banco gravou data=${c.data}.`;
    } else if (s.status_mapeado !== "paid") {
      motivo = `Shopee diz que o status atual deste pedido e "${s.status_raw}" (mapeado="${s.status_mapeado}"), nao "paid" — banco esta desatualizado ou o pedido mudou de status na Shopee depois do sync.`;
    } else {
      motivo = `Shopee tem create_time=${PERIODO} e status=paid para este order_sn, mas ele nao apareceu na listagem create_time=${PERIODO} do Passo 1 — inconsistencia na propria API/paginacao da Shopee.`;
    }
    return {
      order_id: id,
      status_shopee: s?.status_raw ?? null,
      status_cds: c.status,
      create_time: s?.create_time ?? null,
      pay_time: s?.pay_time ?? null,
      update_time: s?.update_time ?? null,
      data_gravada_banco: c.data,
      item_subtotal_shopee: s?.item_subtotal ?? null,
      item_subtotal_banco: c.item_subtotal,
      buyer_paid_amount_shopee: s?.buyer_paid_amount ?? null,
      buyer_paid_amount_banco: c.buyer_paid_amount,
      motivo_exato: motivo,
    };
  }).sort((a, b) => (b.item_subtotal_banco ?? 0) - (a.item_subtotal_banco ?? 0));

  // ── Pedidos em ambos: status diferente / data diferente / valor diferente ──
  const statusDiferente: any[] = [];
  const dataDiferente: any[] = [];
  const valorDiferente: any[] = [];
  let identicosCount = 0;

  for (const sn of emAmbosIds) {
    const s = shopeeMap.get(sn)!;
    const c = cdsMapPaid.get(sn)!;
    let algumaDivergencia = false;

    if (s.status_mapeado !== "paid") {
      statusDiferente.push({
        order_sn: sn, status_shopee: s.status_raw, status_shopee_mapeado: s.status_mapeado, status_cds: c.status,
        create_time: s.create_time, pay_time: s.pay_time, update_time: s.update_time,
        data_gravada_banco: c.data, item_subtotal: s.item_subtotal, buyer_paid_amount: s.buyer_paid_amount,
        motivo_exato: `Shopee mapeia este order_sn como "${s.status_mapeado}" (raw="${s.status_raw}") mas o banco tem status="paid".`,
      });
      algumaDivergencia = true;
    }

    if (s.create_time_brt_date !== PERIODO || (s.pay_time_brt_date && s.pay_time_brt_date !== PERIODO)) {
      dataDiferente.push({
        order_sn: sn, status_shopee: s.status_raw, status_cds: c.status,
        create_time: s.create_time, pay_time: s.pay_time, update_time: s.update_time,
        create_time_brt_date: s.create_time_brt_date, pay_time_brt_date: s.pay_time_brt_date,
        data_gravada_banco: c.data, item_subtotal: s.item_subtotal, buyer_paid_amount: s.buyer_paid_amount,
        motivo_exato: `create_time cai em ${s.create_time_brt_date} BRT` +
          (s.pay_time_brt_date ? ` e pay_time cai em ${s.pay_time_brt_date} BRT` : "") +
          `, mas o banco gravou data=${c.data}.`,
      });
      algumaDivergencia = true;
    }

    const diffItem  = round2(Math.abs(s.item_subtotal - c.item_subtotal));
    const diffBuyer = round2(Math.abs(s.buyer_paid_amount - c.buyer_paid_amount));
    if (diffItem > 0.01 || diffBuyer > 0.01) {
      valorDiferente.push({
        order_sn: sn, status_shopee: s.status_raw, status_cds: c.status,
        create_time: s.create_time, pay_time: s.pay_time, update_time: s.update_time,
        data_gravada_banco: c.data,
        item_subtotal_shopee: s.item_subtotal, item_subtotal_banco: c.item_subtotal, diff_item_subtotal: diffItem,
        buyer_paid_amount_shopee: s.buyer_paid_amount, buyer_paid_amount_banco: c.buyer_paid_amount, diff_buyer_paid_amount: diffBuyer,
        motivo_exato: `item_subtotal difere em R$${diffItem}` + (diffBuyer > 0.01 ? ` e buyer_paid_amount difere em R$${diffBuyer}` : "") + ".",
      });
      algumaDivergencia = true;
    }

    if (!algumaDivergencia) identicosCount++;
  }

  return NextResponse.json({
    geradoEm: new Date().toISOString(),
    periodo_auditado: PERIODO,
    shopeeOficialDashboard: { pedidos: 989, vendas: 22339.82 },

    universo_shopee: {
      criterio: "get_order_list(time_range_field=create_time, 02/07 00:00-23:59:59 BRT), sem filtro de status",
      total_todos_status: shopeeTotalAll,
      total_status_paid: shopeeTotalPaid,
    },
    universo_cds: {
      criterio: "pedidos.data = '2026-07-02' AND status = 'paid' (mesma regra do dashboard CDS)",
      total_todos_status: cdsTotalAll,
      total_status_paid: cdsTotalPaid,
    },
    nota_alinhamento: "Se universo_shopee.total_todos_status bater com 989, o dashboard Shopee conta TODOS os status por create_time do dia. Se bater com total_status_paid, conta so pagos. Confira contra o print do painel Shopee.",

    resumo: {
      pedidos_exclusivos_shopee: soShopeeIds.length,
      pedidos_exclusivos_cds:    soCdsIds.length,
      pedidos_status_diferente: statusDiferente.length,
      pedidos_data_diferente:   dataDiferente.length,
      pedidos_valor_diferente:  valorDiferente.length,
      pedidos_identicos:        identicosCount,
      total_cruzado:            emAmbosIds.length,
    },

    pedidos_exclusivos_shopee: pedidosSoShopee,
    pedidos_exclusivos_cds:    pedidosSoCds,
    pedidos_status_diferente:  statusDiferente,
    pedidos_data_diferente:    dataDiferente,
    pedidos_valor_diferente:   valorDiferente,
  });
}
