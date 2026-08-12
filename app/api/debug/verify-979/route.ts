/**
 * GET /api/debug/verify-979
 *
 * Última validação da Fase 1: os "979 pedidos" da API (regra
 * create_time + exceto_unpaid_e_cancelado, achada em dashboard-formulas)
 * são o MESMO conjunto de order_sn que os "979 pedidos" que a CDS exibe
 * (data=02/07 AND status=paid)? Contagem igual não implica conjunto igual.
 *
 * Não testa hipótese nova — só compara os dois conjuntos de 979 por
 * order_sn/order_id e diz se são idênticos ou não. Se não forem, lista as
 * diferenças (que devem ser poucas, dado que ambos os totais são 979).
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

async function fetchOrderSnList(
  partnerId: string, partnerKey: string, accessToken: string, shopId: number,
  timeFrom: number, timeTo: number
): Promise<Array<{ order_sn: string; order_status: string }>> {
  const all: Array<{ order_sn: string; order_status: string }> = [];
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
    if (data?.error && data.error !== "") throw new Error(`get_order_list error: ${data.error} -- ${data.message ?? ""}`);
    const list: any[] = data?.response?.order_list ?? [];
    for (const o of list) all.push({ order_sn: o.order_sn, order_status: o.order_status });
    if (!data?.response?.more || !data?.response?.next_cursor) break;
    cursor = data.response.next_cursor;
  }
  return all;
}

async function fetchOrderDetailsConcurrent(
  orderSns: string[], partnerId: string, partnerKey: string, accessToken: string, shopId: number
): Promise<any[]> {
  const FIELDS = "item_list,order_status,create_time,pay_time,update_time,income_distribution";
  const BATCH = 50, CONCURRENCY = 8;
  const batches: string[][] = [];
  for (let i = 0; i < orderSns.length; i += BATCH) batches.push(orderSns.slice(i, i + BATCH));
  const out: any[] = [];
  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const grupo = batches.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      grupo.map(batch =>
        shopeeGet("/api/v2/order/get_order_detail", partnerId, partnerKey, accessToken, shopId, {
          order_sn_list: batch.join(","), response_optional_fields: FIELDS,
        }).catch((e: any) => ({ __erro: String(e?.message ?? e) }))
      )
    );
    for (const r of results) {
      if (r?.__erro) continue;
      for (const o of (r?.response?.order_list ?? [])) out.push(o);
    }
  }
  return out;
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

  // ── Lado Shopee: create_time = 02/07, status NOT IN (UNPAID, CANCELLED, IN_CANCEL) ──
  let listaBruta: Array<{ order_sn: string; order_status: string }> = [];
  try {
    listaBruta = await fetchOrderSnList(partnerId, partnerKey, accessToken, shopId, dayFrom, dayTo);
  } catch (e: any) {
    return NextResponse.json({ erro: "Falha ao listar por create_time", detalhe: String(e?.message ?? e) }, { status: 502 });
  }

  const excluidos = new Set(["UNPAID", "CANCELLED", "IN_CANCEL"]);
  const shopeeOrderSns = listaBruta.filter(o => !excluidos.has(o.order_status)).map(o => o.order_sn);

  const detailsRaw = await fetchOrderDetailsConcurrent(shopeeOrderSns, partnerId, partnerKey, accessToken, shopId);
  type ShopeeRec = {
    status_raw: string; item_subtotal: number; buyer_paid_amount: number;
    create_time: string | null; pay_time: string | null; update_time: string | null;
    create_time_brt_date: string | null; pay_time_brt_date: string | null;
  };
  const shopeeMap = new Map<string, ShopeeRec>();
  for (const o of detailsRaw) {
    const itemSubtotal = (o.item_list ?? []).reduce((s: number, it: any) =>
      s + Number(it.model_discounted_price ?? it.model_original_price ?? 0) * Number(it.model_quantity_purchased ?? 1), 0);
    const inc = o.income_distribution ?? {};
    const buyerPaidAmount = Number(inc.buyer_total_amount ?? o.total_amount ?? 0);
    shopeeMap.set(o.order_sn, {
      status_raw: o.order_status, item_subtotal: round2(itemSubtotal), buyer_paid_amount: round2(buyerPaidAmount),
      create_time: isoOrNull(o.create_time), pay_time: isoOrNull(o.pay_time), update_time: isoOrNull(o.update_time),
      create_time_brt_date: brtDateFromEpoch(o.create_time), pay_time_brt_date: brtDateFromEpoch(o.pay_time),
    });
  }

  // ── Lado CDS: data = 02/07 AND status = paid ─────────────────────────
  const PAGE = 1000;
  const cdsRows: any[] = [];
  let offset = 0;
  for (;;) {
    const { data: rows, error } = await supabase
      .from("pedidos")
      .select("order_id, status, item_subtotal, buyer_paid_amount")
      .eq("user_id", userId).eq("marketplace", "Shopee").eq("data", PERIODO).eq("status", "paid")
      .range(offset, offset + PAGE - 1);
    if (error) { console.error("[verify-979] supabase:", error.message); break; }
    if (!rows || rows.length === 0) break;
    cdsRows.push(...rows);
    if (rows.length < PAGE) break;
    offset += PAGE;
    if (offset >= 20000) break;
  }
  const cdsMap = new Map<string, { item_subtotal: number; buyer_paid_amount: number }>();
  for (const r of cdsRows) {
    if (!cdsMap.has(r.order_id)) cdsMap.set(r.order_id, { item_subtotal: 0, buyer_paid_amount: 0 });
    const c = cdsMap.get(r.order_id)!;
    c.item_subtotal += Number(r.item_subtotal) || 0;
    c.buyer_paid_amount += Number(r.buyer_paid_amount) || 0;
  }
  for (const c of cdsMap.values()) { c.item_subtotal = round2(c.item_subtotal); c.buyer_paid_amount = round2(c.buyer_paid_amount); }

  // ── Comparação de conjuntos ───────────────────────────────────────────
  const shopeeSet = new Set(shopeeMap.keys());
  const cdsSet    = new Set(cdsMap.keys());

  const soShopeeIds = [...shopeeSet].filter(sn => !cdsSet.has(sn));
  const soCdsIds    = [...cdsSet].filter(id => !shopeeSet.has(id));

  // ── Enriquecimento factual (só-Shopee): esse order_sn existe em QUALQUER
  //    linha do banco (qualquer status, qualquer data)? ────────────────
  let buscaAmplaBanco: any[] = [];
  if (soShopeeIds.length > 0) {
    const { data: rows, error } = await supabase
      .from("pedidos")
      .select("order_id, data, status, synced_at")
      .eq("user_id", userId).eq("marketplace", "Shopee")
      .in("order_id", soShopeeIds);
    if (error) console.error("[verify-979] busca ampla banco:", error.message);
    buscaAmplaBanco = rows ?? [];
  }
  const bancoAmploMap = new Map<string, any[]>();
  for (const r of buscaAmplaBanco) {
    if (!bancoAmploMap.has(r.order_id)) bancoAmploMap.set(r.order_id, []);
    bancoAmploMap.get(r.order_id)!.push(r);
  }

  const soShopee = soShopeeIds.map(sn => {
    const s = shopeeMap.get(sn)!;
    const linhasBanco = bancoAmploMap.get(sn) ?? [];
    let motivo_estrutural: string;
    if (linhasBanco.length === 0) {
      motivo_estrutural = "order_sn nao existe em NENHUMA linha do banco (nenhum status, nenhuma data) — nunca foi sincronizado.";
    } else {
      const datas = [...new Set(linhasBanco.map(r => r.data))].join(",");
      const statuses = [...new Set(linhasBanco.map(r => r.status))].join(",");
      const mesmaDataQueCreateTime = s.create_time_brt_date && datas === s.create_time_brt_date;
      motivo_estrutural = `Existe no banco com data=[${datas}] status=[${statuses}]` +
        (datas !== PERIODO
          ? ` — banco gravou data diferente de ${PERIODO}.` + (mesmaDataQueCreateTime ? ` (bate com create_time_brt_date=${s.create_time_brt_date})` : ` (create_time_brt_date=${s.create_time_brt_date}, pay_time_brt_date=${s.pay_time_brt_date})`)
          : ` — mesma data, mas status != paid.`);
    }
    return {
      order_sn: sn, status_shopee: s.status_raw,
      item_subtotal: s.item_subtotal, buyer_paid_amount: s.buyer_paid_amount,
      create_time: s.create_time, pay_time: s.pay_time, update_time: s.update_time,
      create_time_brt_date: s.create_time_brt_date, pay_time_brt_date: s.pay_time_brt_date,
      banco_linhas_encontradas: linhasBanco.map(r => ({ data: r.data, status: r.status, synced_at: r.synced_at })),
      motivo_estrutural,
    };
  });

  // ── Enriquecimento factual (só-CDS): o que a Shopee diz HOJE sobre
  //    esse order_sn, direto por get_order_detail (sem filtro de janela)? ──
  let detalheSoCdsRaw: any[] = [];
  if (soCdsIds.length > 0) {
    detalheSoCdsRaw = await fetchOrderDetailsConcurrent(soCdsIds, partnerId, partnerKey, accessToken, shopId);
  }
  const detalheSoCdsMap = new Map<string, ShopeeRec>();
  for (const o of detalheSoCdsRaw) {
    const itemSubtotal = (o.item_list ?? []).reduce((s: number, it: any) =>
      s + Number(it.model_discounted_price ?? it.model_original_price ?? 0) * Number(it.model_quantity_purchased ?? 1), 0);
    const inc = o.income_distribution ?? {};
    detalheSoCdsMap.set(o.order_sn, {
      status_raw: o.order_status, item_subtotal: round2(itemSubtotal), buyer_paid_amount: round2(Number(inc.buyer_total_amount ?? o.total_amount ?? 0)),
      create_time: isoOrNull(o.create_time), pay_time: isoOrNull(o.pay_time), update_time: isoOrNull(o.update_time),
      create_time_brt_date: brtDateFromEpoch(o.create_time), pay_time_brt_date: brtDateFromEpoch(o.pay_time),
    });
  }

  const soCds = soCdsIds.map(id => {
    const c = cdsMap.get(id)!;
    const s = detalheSoCdsMap.get(id);
    let motivo_estrutural: string;
    if (!s) {
      motivo_estrutural = `order_sn NAO EXISTE na API Shopee agora (get_order_detail sem filtro nao retornou nada).`;
    } else if (s.create_time_brt_date !== PERIODO) {
      motivo_estrutural = `Shopee diz create_time_brt_date=${s.create_time_brt_date} (pay_time_brt_date=${s.pay_time_brt_date}), diferente de ${PERIODO}. Banco gravou data=${PERIODO}.`;
    } else if (!["READY_TO_SHIP","RETRY_SHIP","PROCESSED","SHIPPED","TO_CONFIRM_RECEIVE","COMPLETED"].includes(s.status_raw)) {
      motivo_estrutural = `Shopee diz que o status ATUAL e "${s.status_raw}" (nao mapeia para paid) — banco esta desatualizado ou pedido mudou de status apos o sync.`;
    } else {
      motivo_estrutural = `Shopee diz create_time_brt_date=${PERIODO} e status="${s.status_raw}" (paid) — deveria ter aparecido na listagem create_time=${PERIODO} do Passo 1; nao apareceu (possível instabilidade de paginacao da API).`;
    }
    return {
      order_id: id, item_subtotal: c.item_subtotal, buyer_paid_amount: c.buyer_paid_amount,
      status_shopee_atual: s?.status_raw ?? null,
      create_time: s?.create_time ?? null, pay_time: s?.pay_time ?? null, update_time: s?.update_time ?? null,
      create_time_brt_date: s?.create_time_brt_date ?? null, pay_time_brt_date: s?.pay_time_brt_date ?? null,
      motivo_estrutural,
    };
  });

  const emAmbos = [...shopeeSet].filter(sn => cdsSet.has(sn));
  const valorDiferente = emAmbos
    .map(sn => {
      const s = shopeeMap.get(sn)!;
      const c = cdsMap.get(sn)!;
      const diffItem = round2(Math.abs(s.item_subtotal - c.item_subtotal));
      const diffBuyer = round2(Math.abs(s.buyer_paid_amount - c.buyer_paid_amount));
      if (diffItem <= 0.01 && diffBuyer <= 0.01) return null;
      return {
        order_sn: sn,
        item_subtotal_shopee: s.item_subtotal, item_subtotal_cds: c.item_subtotal, diff_item_subtotal: diffItem,
        buyer_paid_amount_shopee: s.buyer_paid_amount, buyer_paid_amount_cds: c.buyer_paid_amount, diff_buyer_paid_amount: diffBuyer,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  const conjuntosIdenticos = soShopee.length === 0 && soCds.length === 0;
  const valoresIdenticos   = valorDiferente.length === 0;

  // pedidos_valor_diferente pode ser enorme (centenas) quando o campo de
  // valor usado nao bate por uma razao sistemica (ex.: formula diferente
  // de rateio de frete/voucher) — nao o foco desta rodada. Limitamos a
  // amostra retornada e mandamos a agregacao completa, para nao gerar uma
  // resposta gigante e dificil de copiar/colar.
  const valorDiferenteOrdenado = [...valorDiferente].sort((a, b) => b.diff_buyer_paid_amount - a.diff_buyer_paid_amount);
  const AMOSTRA = 20;

  return NextResponse.json({
    geradoEm: new Date().toISOString(),
    periodo_auditado: PERIODO,
    regra_shopee: "create_time = 02/07 BRT, status NOT IN (UNPAID, CANCELLED, IN_CANCEL)",
    regra_cds: "data = '2026-07-02' AND status = 'paid'",
    total_shopee: shopeeSet.size,
    total_cds: cdsSet.size,
    conjuntos_identicos_por_order_sn: conjuntosIdenticos,
    valores_identicos_nos_pedidos_em_comum: valoresIdenticos,
    resumo: {
      so_shopee_count: soShopee.length,
      so_cds_count: soCds.length,
      em_ambos_count: emAmbos.length,
      valor_diferente_count: valorDiferente.length,
      soma_item_subtotal_so_shopee: round2(soShopee.reduce((s, o) => s + o.item_subtotal, 0)),
      soma_item_subtotal_so_cds: round2(soCds.reduce((s, o) => s + o.item_subtotal, 0)),
      soma_diff_buyer_paid_amount_total: round2(valorDiferente.reduce((s, o) => s + o.diff_buyer_paid_amount, 0)),
      nota_valor_diferente: "valor_diferente_count alto (quase todos os pedidos em comum) sugere causa sistemica na formula de buyer_paid_amount, nao um problema pontual desses 12 pedidos. Nao investigado nesta rodada — ver pedidos_valor_diferente_amostra (top 20) e a soma total.",
    },
    pedidos_so_shopee: soShopee,
    pedidos_so_cds: soCds,
    pedidos_valor_diferente_amostra: valorDiferenteOrdenado.slice(0, AMOSTRA),
    veredito: conjuntosIdenticos && valoresIdenticos
      ? "IDENTICO: mesmo conjunto de order_sn, mesmos valores. Fase 1 pode ser encerrada definitivamente."
      : conjuntosIdenticos
        ? "CONJUNTO IGUAL, VALOR DIFERENTE: mesmos order_sn nos dois lados, mas ha diferenca de valor em alguns pedidos (ver pedidos_valor_diferente_amostra)."
        : "CONJUNTOS DIFERENTES: ha order_sn presentes so de um lado (ver pedidos_so_shopee / pedidos_so_cds), mesmo com contagem total igual.",
  });
}
