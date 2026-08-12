/**
 * GET /api/debug/dashboard-formulas
 *
 * NÃO reconcilia com o banco. Só testa, usando exclusivamente a API oficial
 * da Shopee, qual combinação de (campo de tempo × grupo de status) reproduz
 * os números do painel oficial: 989 pedidos / R$22.339,82.
 *
 * Por que não "todas as combinações possíveis" literalmente: get_order_list
 * da Shopee não filtra por status (só por time_range_field + time_from/to).
 * Combinações de status são aplicadas em memória, sobre os detalhes já
 * buscados uma única vez — não geram chamadas extras à API. Um conjunto
 * exaustivo de subconjuntos dos ~16 status brutos (2^16) não faria sentido
 * de negócio nem seria auditável; o conjunto abaixo cobre os agrupamentos
 * que uma plataforma de e-commerce plausivelmente usaria para "pedidos do
 * dia", incluindo cada status bruto isolado.
 *
 * Passo 1: busca a lista de order_sn do dia 2026-07-02 três vezes —
 *          uma por create_time, uma por pay_time, uma por update_time —
 *          sem excluir nenhum status. A pertença a cada "balde" de tempo
 *          é a que a PRÓPRIA API retornou nessa chamada (não recalculada
 *          por nós), pra não reintroduzir suposição de timezone.
 * Passo 2: busca o detalhe (get_order_detail) da união desses order_sn,
 *          uma única vez.
 * Passo 3: para cada (campo de tempo, grupo de status), filtra os
 *          detalhes já carregados e soma quantidade / item_subtotal /
 *          buyer_paid_amount.
 * Passo 4: ordena pelo menor erro absoluto de quantidade de pedidos
 *          (989), com o erro de valor ao lado para desempate visual.
 */
import { NextResponse } from "next/server";
import { getUserId } from "@/lib/session";
import { getShopeeLojaAtiva } from "@/lib/shopee-auth";
import { shopeeGet } from "@/lib/shopee-api";

export const maxDuration = 60;

function round2(n: number): number { return Math.round((Number(n) || 0) * 100) / 100; }
function toEpoch(iso: string): number { return Math.floor(new Date(iso).getTime() / 1000); }

async function fetchOrderSnList(
  partnerId: string, partnerKey: string, accessToken: string, shopId: number,
  timeRangeField: "create_time" | "pay_time" | "update_time", timeFrom: number, timeTo: number
): Promise<string[]> {
  const all: string[] = [];
  let cursor = "";
  for (;;) {
    const params: Record<string, string | number> = {
      time_range_field: timeRangeField,
      time_from: timeFrom,
      time_to: timeTo,
      page_size: 100,
      response_optional_fields: "order_status",
    };
    if (cursor) params.cursor = cursor;
    const data = await shopeeGet("/api/v2/order/get_order_list", partnerId, partnerKey, accessToken, shopId, params);
    if (data?.error && data.error !== "") {
      throw new Error(`get_order_list(${timeRangeField}) error: ${data.error} -- ${data.message ?? ""}`);
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
      if (r?.__erro) continue;
      for (const o of (r?.response?.order_list ?? [])) out.push(o);
    }
  }
  return out;
}

// Grupos de status testados (raw = valor exato retornado pela Shopee em order_status)
const STATUS_GROUPS: Array<{ nome: string; test: (raw: string) => boolean }> = [
  { nome: "todos",                        test: () => true },
  { nome: "paid (READY_TO_SHIP..COMPLETED)", test: r => ["READY_TO_SHIP","RETRY_SHIP","PROCESSED","SHIPPED","TO_CONFIRM_RECEIVE","COMPLETED"].includes(r) },
  { nome: "completed",                    test: r => r === "COMPLETED" },
  { nome: "shipped",                      test: r => r === "SHIPPED" },
  { nome: "completed+shipped",            test: r => ["COMPLETED","SHIPPED"].includes(r) },
  { nome: "paid+cancelled",               test: r => ["READY_TO_SHIP","RETRY_SHIP","PROCESSED","SHIPPED","TO_CONFIRM_RECEIVE","COMPLETED","CANCELLED","IN_CANCEL"].includes(r) },
  { nome: "exceto_unpaid",                test: r => r !== "UNPAID" },
  { nome: "exceto_unpaid_e_cancelado",    test: r => !["UNPAID","CANCELLED","IN_CANCEL"].includes(r) },
  { nome: "paid+devolucao+lost (ja_foi_pago)", test: r => ["READY_TO_SHIP","RETRY_SHIP","PROCESSED","SHIPPED","TO_CONFIRM_RECEIVE","COMPLETED","TO_RETURN","RETURN","RETURN_APPROVE","RETURN_DONE","REFUND","LOST","DAMAGED"].includes(r) },
  { nome: "raw=UNPAID",                   test: r => r === "UNPAID" },
  { nome: "raw=READY_TO_SHIP",            test: r => r === "READY_TO_SHIP" },
  { nome: "raw=PROCESSED",                test: r => r === "PROCESSED" },
  { nome: "raw=TO_CONFIRM_RECEIVE",       test: r => r === "TO_CONFIRM_RECEIVE" },
  { nome: "raw=CANCELLED",                test: r => r === "CANCELLED" },
  { nome: "raw=IN_CANCEL",                test: r => r === "IN_CANCEL" },
];

export async function GET(request: Request) {
  const userId = getUserId(request);
  if (!userId) return NextResponse.json({ erro: "Sessao invalida" }, { status: 401 });

  const loja = await getShopeeLojaAtiva(userId);
  if (!loja) return NextResponse.json({ erro: "Shopee nao conectada" }, { status: 400 });
  const { partnerId, partnerKey, accessToken, shopId } = loja;

  const PERIODO = "2026-07-02";
  const dayFrom = toEpoch(`${PERIODO}T00:00:00-03:00`);
  const dayTo   = toEpoch(`${PERIODO}T23:59:59-03:00`);

  // pay_time NAO e aceito por get_order_list — Shopee retorna erro
  // "must use create_time or update_time" (confirmado empiricamente em 2026-07-06).
  // So esses dois sao usados para listar. Qualquer outro que falhar no futuro
  // e registrado em campos_nao_suportados e ignorado, sem derrubar o endpoint.
  const TIME_FIELDS: Array<"create_time" | "update_time"> = ["create_time", "update_time"];

  // ── Passo 1: lista de order_sn por cada campo de tempo (baldes da própria API) ──
  const baldes: Record<string, Set<string>> = {};
  const camposNaoSuportados: Array<{ campo: string; detalhe: string }> = [];

  for (const tf of TIME_FIELDS) {
    try {
      const sns = await fetchOrderSnList(partnerId, partnerKey, accessToken, shopId, tf, dayFrom, dayTo);
      baldes[tf] = new Set(sns);
    } catch (e: any) {
      camposNaoSuportados.push({ campo: tf, detalhe: String(e?.message ?? e) });
      baldes[tf] = new Set(); // vazio — nao quebra o restante do endpoint
    }
  }

  const uniaoOrderSns = new Set<string>();
  for (const tf of TIME_FIELDS) for (const sn of baldes[tf]) uniaoOrderSns.add(sn);

  if (uniaoOrderSns.size === 0) {
    return NextResponse.json({
      erro: `Nenhum order_sn retornado por nenhum dos campos de tempo suportados para ${PERIODO}.`,
      campos_nao_suportados: camposNaoSuportados,
    });
  }

  // ── Passo 2: detalhe de cada pedido, uma única vez ──────────────────────
  const detailsRaw = await fetchOrderDetailsConcurrent([...uniaoOrderSns], partnerId, partnerKey, accessToken, shopId);
  const detailMap = new Map<string, { status_raw: string; item_subtotal: number; buyer_paid_amount: number }>();
  for (const o of detailsRaw) {
    const itemSubtotal = (o.item_list ?? []).reduce((s: number, it: any) =>
      s + Number(it.model_discounted_price ?? it.model_original_price ?? 0) * Number(it.model_quantity_purchased ?? 1), 0);
    const inc = o.income_distribution ?? {};
    const buyerPaidAmount = Number(inc.buyer_total_amount ?? o.total_amount ?? 0);
    detailMap.set(o.order_sn, {
      status_raw: o.order_status,
      item_subtotal: itemSubtotal,
      buyer_paid_amount: buyerPaidAmount,
    });
  }

  // ── Passo 3: calcula cada combinação (campo de tempo × grupo de status) ──
  const OFICIAL_PEDIDOS = 989;
  const OFICIAL_VENDAS  = 22339.82;

  const resultados: any[] = [];
  for (const tf of TIME_FIELDS) {
    const baldeSns = baldes[tf];
    for (const grupo of STATUS_GROUPS) {
      let count = 0;
      let somaItemSubtotal = 0;
      let somaBuyerPaid = 0;
      for (const sn of baldeSns) {
        const d = detailMap.get(sn);
        if (!d) continue; // detalhe nao encontrado (raro; ignorado, nao afeta baldes de outras combinacoes)
        if (!grupo.test(d.status_raw)) continue;
        count++;
        somaItemSubtotal += d.item_subtotal;
        somaBuyerPaid    += d.buyer_paid_amount;
      }
      somaItemSubtotal = round2(somaItemSubtotal);
      somaBuyerPaid    = round2(somaBuyerPaid);

      resultados.push({
        campo_tempo: tf,
        grupo_status: grupo.nome,
        quantidade_pedidos: count,
        soma_item_subtotal: somaItemSubtotal,
        soma_buyer_paid_amount: somaBuyerPaid,
        erro_pedidos: Math.abs(count - OFICIAL_PEDIDOS),
        erro_valor_item_subtotal: round2(Math.abs(somaItemSubtotal - OFICIAL_VENDAS)),
        erro_valor_buyer_paid: round2(Math.abs(somaBuyerPaid - OFICIAL_VENDAS)),
      });
    }
  }

  resultados.sort((a, b) =>
    a.erro_pedidos - b.erro_pedidos ||
    Math.min(a.erro_valor_item_subtotal, a.erro_valor_buyer_paid) - Math.min(b.erro_valor_item_subtotal, b.erro_valor_buyer_paid)
  );

  const match_exato = resultados.filter(r => r.erro_pedidos === 0);

  return NextResponse.json({
    geradoEm: new Date().toISOString(),
    periodo_auditado: PERIODO,
    shopeeOficialDashboard: { pedidos: OFICIAL_PEDIDOS, vendas: OFICIAL_VENDAS },
    tamanho_uniao_order_sn: uniaoOrderSns.size,
    tamanho_por_balde_tempo: {
      create_time: baldes.create_time.size,
      update_time: baldes.update_time.size,
    },
    campos_nao_suportados: camposNaoSuportados,
    match_exato_de_quantidade: match_exato,
    resultados_ordenados_por_menor_erro: resultados,
  });
}
