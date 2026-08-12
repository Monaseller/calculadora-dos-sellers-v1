/**
 * sync-shopee.ts -- Sync completo Shopee -> Supabase (tabela pedidos)
 *
 * ── FASE 1: CONFIABILIDADE DOS DADOS ─────────────────────────────────────
 *
 * P1 — income_distribution implementado
 *   Os valores financeiros agora vêm diretamente da Shopee quando disponíveis.
 *   Campos armazenados: escrow_amount, commission_fee, service_fee,
 *   voucher_from_shopee, voucher_from_seller, transaction_fee, campaign_fee,
 *   buyer_paid_amount, seller_income, item_subtotal.
 *   A lib de comissões é usada apenas como fallback.
 *
 * P2 — item_subtotal armazenado separadamente
 *   item_subtotal = model_discounted_price × qty (preço puro dos itens)
 *   buyer_paid_amount = total pago pelo comprador (income_distribution)
 *   Permite comparar com o painel Shopee para identificar o campo de faturamento.
 *
 * P3 — Comissão usa income_distribution quando disponível
 *   tarifaVenda = commission_fee + service_fee + campaign_fee + transaction_fee
 *   (valores oficiais da Shopee, distribuídos proporcionalmente por item)
 *   Fallback: tabela de estimativa usando itemValue como base (não faturamento)
 *
 * P4 — Upsert com verificação de erro
 *   Falhas no upsert são logadas e contabilizadas separadamente.
 *
 * P5 — Todos os status tratados corretamente
 *   Nenhum status desconhecido mapeado para "paid".
 *   Status "unknown" não entra em faturamento nem contagem de pedidos.
 */
import { createClient } from "@supabase/supabase-js";
import { shopeeGet } from "@/lib/shopee-api";
import { obterFaixaShopee, TAXA_CAMPANHA_SHOPEE } from "@/lib/comissoes-shopee";
import { getShopeeLojaAtiva } from "@/lib/shopee-auth";
import { LojaIdIntegrityError } from "@/lib/sync-errors";
import { atualizarResumosDosDias } from "@/lib/resumos-diarios";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// ── P5: mapeamento completo de status ────────────────────────────────────────
// NUNCA usar "paid" como default — status desconhecido nao deve inflar faturamento
function mapStatus(s: string): string {
  const m: Record<string, string> = {
    // Aguardando pagamento (nao conta em faturamento)
    UNPAID: "pending",

    // Pedidos pagos — contam em faturamento e pedidos
    READY_TO_SHIP:      "paid",
    RETRY_SHIP:         "paid",   // nova tentativa de envio apos falha logistica
    PROCESSED:          "paid",
    SHIPPED:            "paid",
    TO_CONFIRM_RECEIVE: "paid",
    COMPLETED:          "paid",   // entregue e confirmado pelo comprador

    // Cancelados — nao contam em faturamento
    CANCELLED:  "cancelled",
    IN_CANCEL:  "cancelled",     // cancelamento em andamento

    // Devolucoes e reembolsos — nao contam em faturamento
    TO_RETURN:      "devolucao",
    RETURN:         "devolucao",
    RETURN_APPROVE: "devolucao",
    RETURN_DONE:    "devolucao",
    REFUND:         "devolucao",  // reembolso processado

    // Problemas logisticos — nao contam em faturamento
    LOST:    "lost",
    DAMAGED: "devolucao",         // dano no transporte — mesmo tratamento de devolucao
  };
  // CORRECAO P5: status desconhecido → "unknown" (nao "paid")
  return m[s] ?? "unknown";
}

// DETAIL_FIELDS/BATCH/CONCURRENCY movidos para escopo de módulo (2026-07-14,
// backfill dos 189 pedidos perdidos de 07/07) — exportados para que a rota de
// backfill pontual (app/api/admin/shopee/backfill-pedidos/route.ts) chame
// get_order_detail com exatamente os mesmos parâmetros do sync normal, sem
// duplicar a lista de campos ou o tamanho de lote em dois lugares.
export const DETAIL_FIELDS = [
  "item_list",
  "order_status",
  "create_time",
  "pay_time",
  "update_time",           // Fase B (2026-07-06): data_atualizacao_marketplace
  "total_amount",
  "actual_shipping_fee",
  "estimated_shipping_fee",
  "payment_method",
  "package_list",
  "recipient_address",
  "buyer_username",
  "shipping_carrier",
  "cancel_reason",
  "buyer_cancel_reason",
  "cancel_by",
  "income_distribution",   // P1: valores financeiros oficiais da Shopee
  "fulfillment_flag",      // SFS vs vendedor
  "split_up",              // pedido dividido
].join(",");

export const DETAIL_BATCH       = 50;
export const DETAIL_CONCURRENCY = 10;

// Etapa 4.2 (2026-07-29, proteção imediata do recálculo inline) — ver
// comentário completo no ponto de uso, dentro de syncShopeeForUserV2.
// Exportado para reuso em testes/diagnóstico sem duplicar o número.
export const LIMITE_RECALCULO_INLINE_DIAS = 3;

export async function withRetry<T>(
  fn: () => Promise<T>,
  tentativas = 3,
  delayMs = 1000,
  // Opção B (2026-07-30) — callback opcional pra quem chama contar retries
  // por escopo próprio (ex: por janela de listagem), sem duplicar lógica.
  // Retrocompatível: parâmetro novo, opcional, no fim — nenhuma chamada
  // existente precisa mudar.
  onRetry?: (tentativa: number, erro: unknown) => void
): Promise<T> {
  let ultimoErro: unknown;
  for (let i = 0; i < tentativas; i++) {
    try {
      return await fn();
    } catch (e) {
      ultimoErro = e;
      // [DIAG-SYNC-SHOPEE] temporário (2026-07-30) — investigação do gargalo
      // do sync inline (ver Fase 4, proteção imediata: o recálculo de resumo
      // foi descartado como causa e o próprio sync com a Shopee ficou
      // suspeito). Revela se o tempo gasto vem de retry por falha
      // transitória/rate limit — remover depois que a causa for confirmada.
      console.warn("[DIAG-SYNC-SHOPEE] retry", {
        tentativa: i + 1,
        de: tentativas,
        erro: e instanceof Error ? e.message : String(e),
      });
      onRetry?.(i + 1, e);
      if (i < tentativas - 1) {
        await new Promise(r => setTimeout(r, delayMs * Math.pow(2, i)));
      }
    }
  }
  throw ultimoErro;
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split("T")[0];
}

function gerarChunks(from: string, to: string): Array<{ from: string; to: string }> {
  const chunks: Array<{ from: string; to: string }> = [];
  let cur = from;
  while (cur <= to) {
    const end = addDays(cur, 13);
    chunks.push({ from: cur, to: end > to ? to : end });
    cur = addDays(end, 1);
  }
  return chunks;
}

// ── Opção B (2026-07-30) — listagem paralela por dia ────────────────────────
// Ver docs/DECISIONS.md. Investigação da Fase 4 mostrou que o gargalo real do
// sync inline não é o recálculo de resumo (já protegido pela Etapa 4.2), e
// sim a listagem via get_order_list: um sync de "ontem+hoje" com volume alto
// gera ~15 páginas SEQUENCIAIS (cursor único pro intervalo inteiro), medido
// em ~31s de ~49s totais. Como get_order_list usa cursor (cada página
// depende da anterior), não dá pra paralelizar páginas dentro de uma mesma
// janela contínua — mas dá pra rodar duas janelas INDEPENDENTES (ontem, hoje)
// em paralelo, cada uma com seu próprio cursor.
//
// Escopo desta mudança: só ativa quando o intervalo pedido é EXATAMENTE 2
// dias (o caso do botão Sincronizar). Qualquer outro intervalo (1 dia, ou
// mais de 2 — backfill histórico, cron, worker) continua usando o algoritmo
// antigo dentro de syncShopeeForUserV2, sem nenhuma alteração de
// comportamento. Concorrência fixa em 2 (nunca mais que as duas janelas
// diárias) — nunca generalizado para 7/30 dias nem para N janelas.
export interface ContextoListagemShopee {
  partnerId:        string;
  partnerKey:       string;
  accessToken:      string;
  shopId:           number;
  timeRangeField:   string;
  filtrarCompleted: boolean;
}

export interface ListagemResultado {
  orderSns: string[];
  paginas:  number;
  tempoMs:  number;
  retries:  number;
  erro:     string | null;
}

export function contarDiasNoIntervalo(dateFrom: string, dateTo: string): number {
  const d1 = new Date(`${dateFrom}T00:00:00Z`).getTime();
  const d2 = new Date(`${dateTo}T00:00:00Z`).getTime();
  return Math.round((d2 - d1) / 86400000) + 1;
}

/**
 * listarOrderSnsDaJanela — lista todos os order_sn de UMA janela contínua,
 * com cursor próprio (nunca compartilhado com outra janela). Usada pelo
 * caminho novo (intervalo == 2 dias) dentro de syncShopeeForUserV2, chamada
 * 2x via Promise.all (ontem, hoje). Nunca lança exceção — erro vem no campo
 * `erro` do retorno, pra permitir que uma janela falhe sem derrubar a
 * Promise.all da outra (a decisão de abortar o sync inteiro é de quem
 * chama, não desta função).
 */
export async function listarOrderSnsDaJanela(
  ctx: ContextoListagemShopee, janelaFrom: string, janelaTo: string
): Promise<ListagemResultado> {
  const inicioMs = Date.now();
  let retries = 0;
  try {
    const chunkFrom = Math.floor(new Date(`${janelaFrom}T00:00:00-03:00`).getTime() / 1000);
    const chunkTo   = Math.floor(new Date(`${janelaTo}T23:59:59-03:00`).getTime() / 1000);
    let cursor = "";
    const orderSns: string[] = [];
    let paginas = 0;

    for (;;) {
      const params: Record<string, string | number> = {
        time_range_field:         ctx.timeRangeField,
        time_from:                chunkFrom,
        time_to:                  chunkTo,
        page_size:                100,
        response_optional_fields: "order_status",
      };
      if (cursor) params.cursor = cursor;

      const data = await withRetry(
        () => shopeeGet("/api/v2/order/get_order_list", ctx.partnerId, ctx.partnerKey, ctx.accessToken, ctx.shopId, params),
        3, 1000,
        () => { retries++; }
      );
      paginas++;

      if (data?.error && data.error !== "") {
        throw new Error(`Shopee get_order_list error: ${data.error} -- ${data.message ?? ""}`);
      }

      const list: any[] = data?.response?.order_list ?? [];
      const sns = ctx.filtrarCompleted
        ? list.filter((o: any) => (o.order_status ?? "") !== "COMPLETED").map((o: any) => o.order_sn)
        : list.map((o: any) => o.order_sn);
      orderSns.push(...sns);

      if (!data?.response?.more || !data?.response?.next_cursor) break;
      cursor = data.response.next_cursor;
    }

    return { orderSns, paginas, tempoMs: Date.now() - inicioMs, retries, erro: null };
  } catch (err: any) {
    return { orderSns: [], paginas: 0, tempoMs: Date.now() - inicioMs, retries, erro: err?.message ?? String(err) };
  }
}

/**
 * listarOrderSnsSequencialParaTeste — cópia fiel do algoritmo ANTIGO (1
 * cursor sequencial pro intervalo inteiro, chunks de até 14 dias), mantida
 * exclusivamente para a rota de debug temporária
 * app/api/debug/comparar-listagem-shopee/route.ts poder comparar contra o
 * caminho novo. NUNCA é chamada pelo fluxo real de sync — syncShopeeForUserV2
 * continua com o algoritmo antigo embutido inline, inalterado, para
 * qualquer intervalo != 2 dias. Esta função existe só pra reproduzir, sob
 * demanda, o que o algoritmo antigo produziria para a MESMA janela de 2
 * dias que o caminho novo processa, permitindo o diff dos dois conjuntos de
 * order_sn (Teste C).
 */
export async function listarOrderSnsSequencialParaTeste(
  ctx: ContextoListagemShopee, dateFrom: string, dateTo: string
): Promise<ListagemResultado> {
  const inicioMs = Date.now();
  let retries = 0;
  const orderSns: string[] = [];
  let paginas = 0;
  try {
    const chunks = gerarChunks(dateFrom, dateTo);
    for (const chunk of chunks) {
      const chunkFrom = Math.floor(new Date(`${chunk.from}T00:00:00-03:00`).getTime() / 1000);
      const chunkTo   = Math.floor(new Date(`${chunk.to}T23:59:59-03:00`).getTime() / 1000);
      let cursor = "";

      for (;;) {
        const params: Record<string, string | number> = {
          time_range_field:         ctx.timeRangeField,
          time_from:                chunkFrom,
          time_to:                  chunkTo,
          page_size:                100,
          response_optional_fields: "order_status",
        };
        if (cursor) params.cursor = cursor;

        const data = await withRetry(
          () => shopeeGet("/api/v2/order/get_order_list", ctx.partnerId, ctx.partnerKey, ctx.accessToken, ctx.shopId, params),
          3, 1000,
          () => { retries++; }
        );
        paginas++;

        if (data?.error && data.error !== "") {
          throw new Error(`Shopee get_order_list error: ${data.error} -- ${data.message ?? ""}`);
        }

        const list: any[] = data?.response?.order_list ?? [];
        const sns = ctx.filtrarCompleted
          ? list.filter((o: any) => (o.order_status ?? "") !== "COMPLETED").map((o: any) => o.order_sn)
          : list.map((o: any) => o.order_sn);
        orderSns.push(...sns);

        if (!data?.response?.more || !data?.response?.next_cursor) break;
        cursor = data.response.next_cursor;
      }
    }
    return { orderSns, paginas, tempoMs: Date.now() - inicioMs, retries, erro: null };
  } catch (err: any) {
    return { orderSns, paginas, tempoMs: Date.now() - inicioMs, retries, erro: err?.message ?? String(err) };
  }
}

export interface SyncShopeeResult {
  found:        number;
  inserted:     number;
  upsertErrors: number;
  // Etapa 4.2 (2026-07-29) — proteção imediata do recálculo inline de
  // dashboard_resumos_diarios. resumoPendente=true significa que o sync
  // gravou os pedidos normalmente, mas o recálculo do resumo foi ADIADO
  // (não executado) por exceder LIMITE_RECALCULO_INLINE_DIAS — nunca
  // silencioso, sempre acompanhado de motivoResumoPendente e de um log
  // "[SYNC_RESUMO_PENDENTE]".
  resumoAtualizado:     boolean;
  resumoPendente:       boolean;
  diasAfetados:         number;
  motivoResumoPendente: string | null;
  // Opção B (2026-07-30) — só usados no caminho novo (intervalo == 2 dias)
  // quando uma das duas janelas (ontem/hoje) falha; ausentes (undefined) em
  // qualquer outro caso. Aprovação do usuário 2026-07-30: NÃO propagar estes
  // 3 campos pela API pública (app/api/shopee/vendas/route.ts) nesta fase —
  // existem só para consumo interno/rota de debug, até a estratégia estar
  // validada e aprovada para virar contrato público.
  syncIncompleto?: boolean;
  janelaFalhou?:   "ontem" | "hoje" | null;
  motivoFalha?:    string | null;
}

/**
 * carregarMapaAnuncios — carrega os anúncios cadastrados (Shopee, ativos, do
 * usuário) num Map keyed por `ml_item_id|variation_id` (e um fallback
 * `ml_item_id|` sem variação), para lookup de custo/imposto/SKU durante a
 * montagem de linhas. Extraída de dentro de `syncShopeeForUserV2` em
 * 2026-07-14 (mesma motivação de `montarLinhasDoPedido`: reaproveitar sem
 * duplicar na rota de backfill pontual). Mesma query, mesmo resultado.
 */
export async function carregarMapaAnuncios(userId: string): Promise<Map<string, any>> {
  const { data: anuncios } = await supabase
    .from("anuncios")
    .select("id, ml_item_id, variation_id, sku, custo_produto, insumos, custo_frete, imposto")
    .eq("marketplace", "Shopee")
    .eq("ativo", true)
    .eq("user_id", userId);

  const mapaAnuncios = new Map<string, any>();
  for (const a of (anuncios ?? [])) {
    const key = a.variation_id ? `${a.ml_item_id}|${a.variation_id}` : `${a.ml_item_id}|`;
    mapaAnuncios.set(key, a);
    if (!mapaAnuncios.has(`${a.ml_item_id}|`)) mapaAnuncios.set(`${a.ml_item_id}|`, a);
  }
  return mapaAnuncios;
}

export interface MontarLinhasCtx {
  userId:       string;
  lojaId:       string;
  nickname:     string;
  // noBuffer decide só a referência de tempo (create_time vs pay_time) usada
  // para `dataBrt`/coluna legada `data` — mesmo significado de sempre (ver
  // comentário original abaixo). dateFrom/dateTo aplicam o mesmo filtro de
  // corte por dia que o sync normal sempre aplicou.
  noBuffer:     boolean;
  dateFrom:     string;
  dateTo:       string;
  mapaAnuncios: Map<string, any>;
}

/**
 * montarLinhasDoPedido — lógica oficial (única) de conversão de 1 pedido
 * Shopee (resposta de get_order_detail) em 1+ linhas da tabela `pedidos`.
 *
 * Extraída de dentro de `syncShopeeForUserV2` em 2026-07-14 (ver
 * docs/DECISIONS.md, backfill dos 189 pedidos perdidos de 07/07) para ser
 * reaproveitada tanto pelo sync normal (cron/histórico) quanto pela rota de
 * backfill pontual — mesma função, uma implementação só, sem risco de as
 * duas divergirem com o tempo. Corpo idêntico ao que estava inline; nenhuma
 * fórmula ou regra de negócio foi alterada nesta extração.
 */
export function montarLinhasDoPedido(order: any, ctx: MontarLinhasCtx): any[] {
  const { userId, lojaId, nickname, noBuffer, dateFrom, dateTo, mapaAnuncios } = ctx;
  const now = new Date().toISOString();
  const rows: any[] = [];

  const status = order.order_status ?? "UNKNOWN";

  // P5 + BUG-PIPE-1 FIX: usar create_time quando noBuffer=true
  // (API foi consultada por create_time — pay_time pode estar fora do range para boletos)
  // NOTA (Fase B, 2026-07-06): esta lógica de `dataBrt`/`refTs` decide só o RANGE da
  // busca (fetch não muda) e alimenta a coluna legada `data` (fallback, ver DATABASE.md).
  // NÃO é a mesma coisa que data_criacao/data_pagamento abaixo, que são sempre
  // calculadas a partir do campo bruto correspondente, independente de noBuffer.
  const refTs   = noBuffer
    ? (order.create_time || 0)
    : (order.pay_time || order.create_time || 0);
  const dataBrt = new Date((refTs - 3 * 3600) * 1000).toISOString().split("T")[0];

  if (dataBrt < dateFrom || dataBrt > dateTo) return rows;

  // ── Fase B (2026-07-06): data_criacao / data_pagamento / data_atualizacao_marketplace ──
  // Regra oficial: docs/BUSINESS_RULES.md ("Arquitetura de três datas").
  // data_criacao: SEMPRE a partir de create_time, nunca muda com o modo de sync.
  const dataCriacao = order.create_time
    ? new Date((Number(order.create_time) - 3 * 3600) * 1000).toISOString().split("T")[0]
    : null;
  // data_pagamento: só quando existe pay_time de verdade. Sem fallback automático —
  // pedido nunca pago fica NULL (decisão do usuário, ver DECISIONS.md ponto 2).
  const dataPagamento = order.pay_time
    ? new Date((Number(order.pay_time) - 3 * 3600) * 1000).toISOString().split("T")[0]
    : null;
  // data_atualizacao_marketplace: timestamp bruto (não só a data) da última alteração
  // do pedido na Shopee — preparação para a reconciliação de status (ver BUGS.md).
  const dataAtualizacaoMarketplace = order.update_time
    ? new Date(Number(order.update_time) * 1000).toISOString()
    : null;

  // ── Campos de endereco e logistica ──────────────────────────────────────
  const freteReal      = Number(order.actual_shipping_fee    ?? 0);
  const freteEstimado  = Number(order.estimated_shipping_fee ?? 0);
  const formaPagamento = order.payment_method ?? null;
  const buyerUsername  = order.buyer_username ?? null;
  const cancelBy       = order.cancel_by      ?? null;
  const cancelReason   = order.cancel_reason  ?? order.buyer_cancel_reason ?? null;
  const fulfillmentFlag = order.fulfillment_flag ?? null;
  const splitUp        = order.split_up ?? false;

  const addr        = order.recipient_address ?? {};
  const buyerCidade = addr.city ?? addr.district ?? null;
  const buyerEstado = addr.state ?? null;

  const packages    = order.package_list ?? [];
  const firstPkg    = packages[0] ?? {};
  const rastreio    = firstPkg.package_number ?? null;
  const transportadora = order.shipping_carrier ?? firstPkg.logistics_status ?? null;

  // ── P1: income_distribution — valores financeiros oficiais da Shopee ────
  const incDist = order.income_distribution ?? {};

  // Mapeamento com fallbacks para variações de nome entre versoes da API
  const incEscrow        = Number(incDist.escrow_amount                                   ?? 0);
  const incCommission    = Number(incDist.commission_amount   ?? incDist.commission_fee    ?? 0);
  const incServiceFee    = Number(incDist.service_fee                                      ?? 0);
  const incTxFee         = Number(incDist.seller_transaction_fee ?? incDist.transaction_fee ?? 0);
  const incCampaignFee   = Number(incDist.campaign_fee        ?? incDist.advertising_fee   ?? 0);
  const incVoucherShopee = Number(incDist.voucher_from_shopee ?? incDist.coins_cash_back   ?? 0);
  const incVoucherSeller = Number(incDist.voucher_from_seller                              ?? 0);
  const incBuyerTotal    = Number(incDist.buyer_total_amount  ?? order.total_amount        ?? 0);

  // income_distribution considerado disponivel quando tem pelo menos um valor significativo
  // Fase F (2026-07-07): CORRECAO DE BUG - a versao anterior usava `incBuyerTotal > 0`,
  // mas incBuyerTotal cai no fallback `order.total_amount` quando a Shopee NAO manda
  // income_distribution (linha acima). Isso fazia hasIncomeData dar true quase sempre,
  // mesmo sem nenhum dado real de income_distribution (confirmado matematicamente:
  // voucher_from_shopee/voucher_from_seller/escrow_amount = 0 em 100% das linhas
  // marcadas has_income_data=true no dia 06/07/2026). A correcao usa o valor BRUTO de
  // buyer_total_amount, sem fallback, para decidir se o dado e real.
  const incBuyerTotalRaw = Number(incDist.buyer_total_amount ?? 0);
  const hasIncomeData = incEscrow > 0 || incCommission > 0 || incBuyerTotalRaw > 0;

  // Total Shopee fees (ordem inteira) — distribui por item proporcionalmente
  const incPlataformaTotalOrder = incCommission + incServiceFee + incCampaignFee + incTxFee;

  // total_amount = o que o comprador pagou (itens + frete comprador - coins/vouchers buyer)
  const totalAmount = Number(order.total_amount ?? 0);

  // orderItemsSubtotal = soma de (model_discounted_price × qty) de todos os itens
  // usado como denominador para distribuicao proporcional
  const orderItemsSubtotal = (order.item_list ?? []).reduce((sum: number, it: any) =>
    sum + Number(it.model_discounted_price ?? it.model_original_price ?? 0)
        * Number(it.model_quantity_purchased ?? 1), 0);

  // ── Processar cada item do pedido ────────────────────────────────────────
  if ((order.item_list ?? []).length === 0) {
    // P4 (BUG-DATA-EMPTY): pedido sem item_list — salva row minima para nao perder o pedido
    rows.push({
      id:               `${userId}_SHOPEE_${order.order_sn}_NOITEM`,
      user_id:          userId,
      marketplace:      "Shopee",
      order_id:         order.order_sn,
      data:             dataBrt,
      data_criacao:     dataCriacao,
      data_pagamento:   dataPagamento,
      data_atualizacao_marketplace: dataAtualizacaoMarketplace,
      anuncio:          "(sem item_list)",
      ml_item_id:       "",
      variation_id:     null,
      conta:            nickname,
      loja_id:          lojaId,
      sku:              null,
      status:           mapStatus(status),
      status_shopee_raw: status,
      frete:            "comprador",
      logistica:        fulfillmentFlag === "fulfilled_by_shopee" ? "SFS" : "Shopee",
      valor_unit:       0,
      qtd:              0,
      item_subtotal:    0,
      faturamento:      hasIncomeData ? incBuyerTotal : totalAmount,
      buyer_paid_amount: incBuyerTotal || totalAmount,
      custo:            0,
      imposto:          0,
      tarifa_venda:     incPlataformaTotalOrder,
      frete_comprador:  0,
      frete_vendedor:   0,
      frete_real:       freteReal,
      frete_estimado:   freteEstimado,
      margem_contrib:   hasIncomeData ? incEscrow : 0,
      mc_percent:       0,
      lucro_liquido:    hasIncomeData ? incEscrow : 0,
      seller_income:    hasIncomeData ? incEscrow : 0,
      roi:              0,
      escrow_amount:    incEscrow,
      commission_fee:   incCommission,
      service_fee:      incServiceFee,
      transaction_fee:  incTxFee,
      campaign_fee:     incCampaignFee,
      voucher_from_shopee: incVoucherShopee,
      voucher_from_seller: incVoucherSeller,
      has_income_data:  hasIncomeData,
      split_up:         splitUp,
      forma_pagamento:  formaPagamento,
      cancel_reason:    cancelReason,
      cancel_by:        cancelBy,
      fulfillment_flag: fulfillmentFlag,
      codigo_rastreio:  rastreio,
      transportadora,
      imagem_url:       null,
      buyer_username:   buyerUsername,
      buyer_cidade:     buyerCidade,
      buyer_estado:     buyerEstado,
      cadastrado:       false,
      synced_at:        now,
    });
    return rows;
  }

  for (const item of (order.item_list ?? [])) {
    const itemIdStr   = String(item.item_id);
    const variationId = item.model_id ? String(item.model_id) : null;
    const valorUnit   = Number(item.model_discounted_price ?? item.model_original_price ?? 0);
    const qtd         = Number(item.model_quantity_purchased ?? 1);
    const itemValue   = valorUnit * qtd; // item_subtotal deste item especifico

    // ── Ratio proporcional (peso deste item no total de itens do pedido) ──
    const ratioItem = orderItemsSubtotal > 0 ? itemValue / orderItemsSubtotal : 1;

    // ── P2: faturamento vs item_subtotal ──────────────────────────────────
    // item_subtotal = preço puro dos itens (model_discounted_price × qty)
    // faturamento   = buyer_paid_amount proporcional (total_amount inclui frete comprador)
    // Apos primeiro sync, comparar qual deles bate com o painel Shopee (Prioridade 2)
    const itemSubtotal = itemValue;
    const faturamento  = totalAmount > 0 && orderItemsSubtotal > 0
      ? totalAmount * ratioItem
      : itemValue; // fallback se total_amount nao disponivel

    // buyer_paid_amount = o que o comprador pagou (via income_distribution ou total_amount)
    const buyerPaidItem = hasIncomeData
      ? incBuyerTotal * ratioItem
      : faturamento;

    // ── P3: comissao oficial vs estimada ──────────────────────────────────
    let tarifaVenda: number;
    if (hasIncomeData && incPlataformaTotalOrder > 0) {
      // Valores oficiais da Shopee: distribui proporcional por item
      tarifaVenda = incPlataformaTotalOrder * ratioItem;
    } else {
      // Fallback: tabela estimada
      // BUG-COM-1 FIX: usar itemValue como base (nao faturamento que inclui frete)
      const faixa = obterFaixaShopee(valorUnit);
      tarifaVenda = itemValue * (faixa.comissao + TAXA_CAMPANHA_SHOPEE);
      // Nota: taxaFixa (BUG-COM-2) pendente — requer tipo CNPJ/CPF
    }

    // ── P1: campos income_distribution proporcionais ───────────────────────
    const escrowItem        = hasIncomeData ? incEscrow        * ratioItem : 0;
    const commissionItem    = hasIncomeData ? incCommission    * ratioItem : tarifaVenda;
    const serviceFeeItem    = hasIncomeData ? incServiceFee    * ratioItem : 0;
    const txFeeItem         = hasIncomeData ? incTxFee         * ratioItem : 0;
    const campaignFeeItem   = hasIncomeData ? incCampaignFee   * ratioItem : 0;
    const voucherShopeeItem = hasIncomeData ? incVoucherShopee * ratioItem : 0;
    const voucherSellerItem = hasIncomeData ? incVoucherSeller * ratioItem : 0;

    // ── Custos do vendedor ────────────────────────────────────────────────
    const imagemUrl  = item.image_info?.image_url ?? item.cover_image ?? null;
    const itemSku    = item.model_sku || item.item_sku || null;
    const keyVar     = variationId ? `${itemIdStr}|${variationId}` : `${itemIdStr}|`;
    const anuncio    = mapaAnuncios.get(keyVar) ?? mapaAnuncios.get(`${itemIdStr}|`) ?? null;

    const custo      = anuncio ? ((anuncio.custo_produto || 0) + (anuncio.insumos || 0)) * qtd : 0;
    const impostoVal = anuncio ? faturamento * ((anuncio.imposto || 0) / 100) : 0;
    const custoFrete = anuncio?.custo_frete ? (anuncio.custo_frete as number) * qtd : 0;

    // ── Margem e lucro ────────────────────────────────────────────────────
    // Com income_distribution: escrow_amount ja descontou todas as taxas Shopee
    // Sem income_distribution: faturamento - tarifaVenda (estimado)
    let margemContrib: number;
    if (hasIncomeData && incEscrow > 0) {
      // Margem real = receita liquida Shopee - custos do vendedor
      margemContrib = escrowItem - custo - impostoVal - custoFrete;
    } else {
      margemContrib = faturamento - tarifaVenda - custo - impostoVal - custoFrete;
    }

    const mcPercent    = faturamento > 0 ? (margemContrib / faturamento) * 100 : 0;
    const lucroLiquido = margemContrib; // mesmo valor, nome mais intuitivo
    const sellerIncome = escrowItem - custo - impostoVal - custoFrete; // receita liquida real
    const roi          = custo > 0 ? (lucroLiquido / custo) * 100 : 0;

    rows.push({
      id:               `${userId}_SHOPEE_${order.order_sn}_${itemIdStr}_${variationId ?? "nv"}`,
      user_id:          userId,
      marketplace:      "Shopee",
      order_id:         order.order_sn,
      data:             dataBrt,
      data_criacao:     dataCriacao,
      data_pagamento:   dataPagamento,
      data_atualizacao_marketplace: dataAtualizacaoMarketplace,
      anuncio:          item.item_name ?? itemIdStr,
      ml_item_id:       itemIdStr,
      variation_id:     variationId,
      conta:            nickname,
      loja_id:          lojaId,
      sku:              itemSku ?? anuncio?.sku ?? null,
      status:           mapStatus(status),
      status_shopee_raw: status,
      frete:            "comprador",
      logistica:        fulfillmentFlag === "fulfilled_by_shopee" ? "SFS" : "Shopee",
      valor_unit:       valorUnit,
      qtd,
      // P2: item_subtotal e faturamento separados para comparacao com painel
      item_subtotal:    itemSubtotal,     // model_discounted_price × qty
      faturamento,                         // total_amount proporcional (inclui frete)
      buyer_paid_amount: buyerPaidItem,   // confirmacao via income_distribution
      custo,
      imposto:          impostoVal,
      tarifa_venda:     tarifaVenda,       // P3: oficial ou estimado
      frete_comprador:  0,
      frete_vendedor:   custoFrete,
      frete_real:       freteReal,
      frete_estimado:   freteEstimado,
      margem_contrib:   margemContrib,
      mc_percent:       mcPercent,
      lucro_liquido:    lucroLiquido,
      roi,
      // P1: campos income_distribution (valores oficiais Shopee)
      escrow_amount:       escrowItem,
      commission_fee:      commissionItem,
      service_fee:         serviceFeeItem,
      transaction_fee:     txFeeItem,
      campaign_fee:        campaignFeeItem,
      voucher_from_shopee: voucherShopeeItem,
      voucher_from_seller: voucherSellerItem,
      seller_income:       sellerIncome,
      has_income_data:     hasIncomeData,
      // Metadata
      split_up:         splitUp,
      forma_pagamento:  formaPagamento,
      cancel_reason:    cancelReason,
      cancel_by:        cancelBy,
      fulfillment_flag: fulfillmentFlag,
      codigo_rastreio:  rastreio,
      transportadora,
      imagem_url:       imagemUrl,
      buyer_username:   buyerUsername,
      buyer_cidade:     buyerCidade,
      buyer_estado:     buyerEstado,
      cadastrado:       !!anuncio,
      synced_at:        now,
    });
  }

  return rows;
}

export async function syncShopeeForUser(
  userId:      string,
  dateFrom:    string,
  dateTo:      string,
  noBuffer     = false,
  lojaOverride?: {
    lojaId: string; partnerId: string; partnerKey: string;
    accessToken: string; shopId: number; nickname: string;
  }
): Promise<number> {
  const result = await syncShopeeForUserV2(userId, dateFrom, dateTo, noBuffer, lojaOverride);
  return result.inserted;
}

export async function syncShopeeForUserV2(
  userId:      string,
  dateFrom:    string,
  dateTo:      string,
  noBuffer     = false,
  lojaOverride?: {
    lojaId: string; partnerId: string; partnerKey: string;
    accessToken: string; shopId: number; nickname: string;
  }
): Promise<SyncShopeeResult> {
  const loja = lojaOverride ?? await getShopeeLojaAtiva(userId);
  if (!loja) return { found: 0, inserted: 0, upsertErrors: 0, resumoAtualizado: false, resumoPendente: false, diasAfetados: 0, motivoResumoPendente: null };

  const { partnerId: partner_id, partnerKey: partner_key, accessToken: access_token, shopId, nickname, lojaId } = loja;

  // Regra de integridade (aprovada 2026-07-11): loja_id é obrigatório para
  // gravar qualquer pedido. Se não resolver, o sync desta loja PARA aqui —
  // nunca upsert parcial com loja_id NULL. Pedidos já existentes não são
  // tocados. Estruturalmente `loja.lojaId` sempre vem preenchido (é o `id`
  // da própria linha em `lojas`, PK nunca nula) — este check é uma trava
  // defensiva explícita, não um caminho esperado de falha.
  if (!lojaId) {
    // LojaIdIntegrityError (lib/sync-errors.ts, 2026-07-11): classe
    // reconhecível por app/api/internal/sync/executar/route.ts via
    // `instanceof`, para marcar este erro como PERMANENTE (sem retry)
    // na fila sync_jobs — diferente de uma falha transitória de rede.
    throw new LojaIdIntegrityError(`[sync-shopee] loja_id ausente para userId=${userId}, nickname=${nickname} — sync interrompido, nenhum pedido gravado.`);
  }

  // noBuffer=true  → Historico: create_time (todos os status validos no range)
  // noBuffer=false → Cron diario: update_time (filtra COMPLETED = entregues antigos)
  const timeRangeField   = noBuffer ? "create_time" : "update_time";
  const filtrarCompleted = !noBuffer;

  const chunks = gerarChunks(dateFrom, dateTo);

  // [DIAG-SYNC-SHOPEE] temporário (2026-07-30) — ver comentário em withRetry.
  const _syncInicioMs = Date.now();

  // ── ETAPA 1: Listar todos os order_sn via cursor paginado ──────────────────
  let allOrderSns: string[] = [];
  let _paginasListagem = 0;
  const _etapa1InicioMs = Date.now();
  const diasNoIntervalo = contarDiasNoIntervalo(dateFrom, dateTo);

  if (diasNoIntervalo === 2) {
    // Opção B (2026-07-30) — ver comentário completo acima de
    // ContextoListagemShopee. Só entra aqui quando o intervalo pedido é
    // EXATAMENTE 2 dias (sempre o caso do botão Sincronizar/forceSync).
    const ctxListagem: ContextoListagemShopee = {
      partnerId: partner_id, partnerKey: partner_key, accessToken: access_token, shopId,
      timeRangeField, filtrarCompleted,
    };

    const [resOntem, resHoje] = await Promise.all([
      listarOrderSnsDaJanela(ctxListagem, dateFrom, dateFrom),
      listarOrderSnsDaJanela(ctxListagem, dateTo,   dateTo),
    ]);

    // [DIAG-SYNC-SHOPEE] temporário (2026-07-30) — ver comentário em withRetry.
    console.log("[DIAG-SYNC-SHOPEE] etapa1_janela_ontem", {
      paginas: resOntem.paginas, tempoMs: resOntem.tempoMs, retries: resOntem.retries,
      pedidosEncontrados: resOntem.orderSns.length, erro: resOntem.erro,
    });
    console.log("[DIAG-SYNC-SHOPEE] etapa1_janela_hoje", {
      paginas: resHoje.paginas, tempoMs: resHoje.tempoMs, retries: resHoje.retries,
      pedidosEncontrados: resHoje.orderSns.length, erro: resHoje.erro,
    });

    if (resOntem.erro || resHoje.erro) {
      // Etapa 5 (aprovada 2026-07-30): nunca fallback silencioso pra
      // resultado parcial — se uma janela falhar, o sync inteiro é
      // considerado incompleto e aborta aqui, sem seguir pra detalhes/upsert
      // com só metade dos pedidos.
      const janelaFalhou: "ontem" | "hoje" = resOntem.erro ? "ontem" : "hoje";
      const motivoFalha = resOntem.erro ?? resHoje.erro ?? "erro_desconhecido";
      console.error("[DIAG-SYNC-SHOPEE] etapa1_abortando_sync_incompleto", { janelaFalhou, motivoFalha });
      return {
        found: 0, inserted: 0, upsertErrors: 0,
        resumoAtualizado: false, resumoPendente: false, diasAfetados: 0, motivoResumoPendente: null,
        syncIncompleto: true, janelaFalhou, motivoFalha,
      };
    }

    const totalAntesDedup = resOntem.orderSns.length + resHoje.orderSns.length;
    const setUnico = new Set([...resOntem.orderSns, ...resHoje.orderSns]);
    allOrderSns = Array.from(setUnico);
    _paginasListagem = resOntem.paginas + resHoje.paginas;

    // [DIAG-SYNC-SHOPEE] temporário (2026-07-30) — ver comentário em withRetry.
    console.log("[DIAG-SYNC-SHOPEE] etapa1_dedup", {
      totalAntesDedup,
      totalDepoisDedup: allOrderSns.length,
      duplicadosRemovidos: totalAntesDedup - allOrderSns.length,
    });
  } else {
    // ── Caminho antigo (qualquer intervalo != 2 dias) — sem NENHUMA alteração
    // de comportamento em relação ao código original.
    for (const chunk of chunks) {
      const chunkFrom = Math.floor(new Date(`${chunk.from}T00:00:00-03:00`).getTime() / 1000);
      const chunkTo   = Math.floor(new Date(`${chunk.to}T23:59:59-03:00`).getTime() / 1000);
      let cursor = "";

      for (;;) {
        const params: Record<string, string | number> = {
          time_range_field:         timeRangeField,
          time_from:                chunkFrom,
          time_to:                  chunkTo,
          page_size:                100,
          response_optional_fields: "order_status",
        };
        if (cursor) params.cursor = cursor;

        const _paginaInicioMs = Date.now();
        const data = await withRetry(() =>
          shopeeGet("/api/v2/order/get_order_list", partner_id, partner_key, access_token, shopId, params)
        );
        _paginasListagem++;
        // [DIAG-SYNC-SHOPEE] temporário (2026-07-30) — ver comentário em withRetry.
        console.log("[DIAG-SYNC-SHOPEE] etapa1_pagina", {
          pagina: _paginasListagem,
          tempoMs: Date.now() - _paginaInicioMs,
          acumulado: allOrderSns.length,
        });

        if (data?.error && data.error !== "") {
          throw new Error(`Shopee get_order_list error: ${data.error} -- ${data.message ?? ""}`);
        }

        const list: any[] = data?.response?.order_list ?? [];

        // Cron (update_time): exclui COMPLETED para nao buscar pedidos antigos entregues hoje
        const sns = filtrarCompleted
          ? list.filter((o: any) => (o.order_status ?? "") !== "COMPLETED").map((o: any) => o.order_sn)
          : list.map((o: any) => o.order_sn);

        allOrderSns.push(...sns);

        // Paginacao: para quando mais=false OU cursor vazio
        if (!data?.response?.more || !data?.response?.next_cursor) break;
        cursor = data.response.next_cursor;
      }
    }
  }

  const found = allOrderSns.length;
  // [DIAG-SYNC-SHOPEE] temporário (2026-07-30) — ver comentário em withRetry.
  console.log("[DIAG-SYNC-SHOPEE] etapa1_total", {
    tempoMs: Date.now() - _etapa1InicioMs,
    paginas: _paginasListagem,
    orderSnsEncontrados: found,
    modo: diasNoIntervalo === 2 ? "paralelo_2_janelas" : "sequencial_legado",
  });
  if (found === 0) return { found: 0, inserted: 0, upsertErrors: 0, resumoAtualizado: false, resumoPendente: false, diasAfetados: 0, motivoResumoPendente: null };

  // ── ETAPA 2: Carregar anuncios cadastrados (para custos) ───────────────────
  // Extraído para `carregarMapaAnuncios()` em 2026-07-14 (backfill dos 189
  // pedidos de 07/07) — mesma query, zero mudança de comportamento, só
  // reaproveitável pela rota de backfill sem duplicar.
  const _etapa2InicioMs = Date.now();
  const mapaAnuncios = await carregarMapaAnuncios(userId);
  console.log("[DIAG-SYNC-SHOPEE] etapa2_anuncios", { tempoMs: Date.now() - _etapa2InicioMs });

  // ── ETAPA 3: Buscar detalhes em paralelo (50/batch, 10 concurrent) ─────────
  // P1: income_distribution adicionado para valores financeiros oficiais
  // (DETAIL_FIELDS/DETAIL_BATCH/DETAIL_CONCURRENCY movidos para escopo de
  // módulo em 2026-07-14 — ver comentário acima de `withRetry`.)
  const batches: string[][] = [];
  for (let i = 0; i < allOrderSns.length; i += DETAIL_BATCH) {
    batches.push(allOrderSns.slice(i, i + DETAIL_BATCH));
  }

  const allDetails: any[] = [];
  const _etapa3InicioMs = Date.now();
  for (let i = 0; i < batches.length; i += DETAIL_CONCURRENCY) {
    const grupo = batches.slice(i, i + DETAIL_CONCURRENCY);
    const _ondaInicioMs = Date.now();
    const results = await Promise.all(
      grupo.map(batch =>
        withRetry(() =>
          shopeeGet("/api/v2/order/get_order_detail", partner_id, partner_key, access_token, shopId, {
            order_sn_list:            batch.join(","),
            response_optional_fields: DETAIL_FIELDS,
          })
        )
      )
    );
    allDetails.push(...results);
    // [DIAG-SYNC-SHOPEE] temporário (2026-07-30) — ver comentário em withRetry.
    console.log("[DIAG-SYNC-SHOPEE] etapa3_onda", {
      onda: Math.floor(i / DETAIL_CONCURRENCY) + 1,
      lotesNaOnda: grupo.length,
      pedidosNaOnda: grupo.reduce((s, b) => s + b.length, 0),
      tempoMsDaOnda: Date.now() - _ondaInicioMs,
    });
  }
  console.log("[DIAG-SYNC-SHOPEE] etapa3_total", {
    tempoMs: Date.now() - _etapa3InicioMs,
    totalLotes: batches.length,
    totalOndas: Math.ceil(batches.length / DETAIL_CONCURRENCY),
  });

  // ── ETAPA 4: Montar linhas ──────────────────────────────────────────────────
  // Extraída para `montarLinhasDoPedido()` em 2026-07-14 (backfill dos 189
  // pedidos perdidos de 07/07) — mesma lógica, zero mudança de comportamento,
  // só reaproveitável pela rota de backfill pontual sem duplicar código.
  const _etapa4InicioMs = Date.now();
  const rows: any[] = [];

  for (const detail of allDetails) {
    for (const order of (detail?.response?.order_list ?? [])) {
      rows.push(...montarLinhasDoPedido(order, {
        userId, lojaId, nickname, noBuffer, dateFrom, dateTo, mapaAnuncios,
      }));
    }
  }
  console.log("[DIAG-SYNC-SHOPEE] etapa4_montarlinhas", { tempoMs: Date.now() - _etapa4InicioMs, rows: rows.length });

  // ── ETAPA 5: Upsert com verificacao de erro (P4) ──────────────────────────
  const UPSERT_BATCH = 250;
  let upsertErrors   = 0;
  const _etapa5InicioMs = Date.now();

  for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
    const { error } = await supabase
      .from("pedidos")
      .upsert(rows.slice(i, i + UPSERT_BATCH), { onConflict: "id" });

    if (error) {
      upsertErrors++;
      console.error(
        `[sync-shopee] upsert batch ${i / UPSERT_BATCH + 1} falhou:`,
        error.message,
        `| rows ${i}–${Math.min(i + UPSERT_BATCH, rows.length) - 1}`
      );
    }
  }
  // [DIAG-SYNC-SHOPEE] temporário (2026-07-30) — ver comentário em withRetry.
  console.log("[DIAG-SYNC-SHOPEE] etapa5_upsert", { tempoMs: Date.now() - _etapa5InicioMs, upsertErrors });

  // Fase 4 Parte 2 — REATIVADA em 2026-07-29 (ver Fase 3 desta sessão:
  // dashboard_resumos_diarios existe, migration executada, validada com
  // backfill de 7 e 30 dias consecutivos sem erro nem divergência
  // financeira material). Recalcula só os dias efetivamente afetados por
  // ESTE sync (nunca o período inteiro) — protegido por try/catch: falha
  // aqui nunca derruba o sync principal, resumo é cache, não fonte de
  // verdade (regra permanente, ver migration 20260710).
  //
  // Etapa 4.1 (2026-07-29): estas datas já vêm exclusivamente dos pedidos
  // efetivamente processados neste sync (`rows`, montado a partir dos
  // order_sn retornados pela Shopee para o range pedido) — NUNCA do
  // dateFrom/dateTo inteiro. Um sync de 7 dias corridos só recalcula os
  // dias em que de fato existiu pedido com data_pagamento/data_criacao
  // naquele dia; dias sem pedido novo/alterado no meio do range não entram
  // aqui. Isso já era verdade antes desta etapa — não precisou de correção.
  const datasPagamento = Array.from(new Set(rows.map(r => r.data_pagamento).filter(Boolean)));
  const datasCriacao   = Array.from(new Set(rows.map(r => r.data_criacao).filter(Boolean)));

  // Etapa 4.2 (2026-07-29) — limitador de recálculo inline. Cada data em
  // datasPagamento/datasCriacao custa 1 chamada a atualizarResumoDia (1
  // query paginada + upsert em dashboard_resumos_diarios), medido em
  // 1.5-5.5s cada na Fase 4 original. Isso roda dentro do fluxo síncrono
  // (inline, usado sempre que ENABLE_ASYNC_SYNC_JOBS está off — confirmado
  // em 2026-07-29 que a variável não existe nem em produção/Vercel), e soma
  // direto ao tempo de resposta da rota, que tem 45s de limite no frontend
  // (AbortController em vendas/page.tsx). Um teste real com janela efetiva
  // de 7 dias empurrou o total da requisição para 59.7s.
  //
  // "dias afetados" = datasPagamento.length + datasCriacao.length, ou seja,
  // o número de chamadas individuais a atualizarResumoDia que este sync
  // executaria — não a contagem de dias de calendário únicos. Um mesmo
  // pedido pode ter data_pagamento e data_criacao em dias diferentes; cada
  // data em cada eixo é 1 query+upsert separado, e é isso que custa tempo,
  // não o dia de calendário em si.
  const diasAfetados = datasPagamento.length + datasCriacao.length;

  let resumoAtualizado = false;
  let resumoPendente = false;
  let motivoResumoPendente: string | null = null;

  if (diasAfetados > LIMITE_RECALCULO_INLINE_DIAS) {
    // Etapa 4.3 — nunca pular em silêncio: log estruturado (Etapa 4.4) +
    // retorno da rota (app/api/shopee/vendas/route.ts) expõe
    // resumo_pendente=true e o motivo em código estável. Os pedidos em si
    // já foram gravados normalmente acima (upsert em `pedidos`) — só o
    // recálculo do resumo/cache fica pendente.
    resumoPendente = true;
    motivoResumoPendente = "LIMITE_RECALCULO_INLINE_EXCEDIDO";
    console.warn("[SYNC_RESUMO_PENDENTE]", {
      userId,
      lojaId,
      marketplace: "Shopee",
      dataInicial: dateFrom,
      dataFinal: dateTo,
      diasAfetados,
      quantidadePedidos: rows.length,
      motivo: motivoResumoPendente,
    });
  } else if (diasAfetados > 0) {
    const _resumoInicioMs = Date.now();
    try {
      await atualizarResumosDosDias(userId, lojaId, "Shopee", nickname, datasPagamento, datasCriacao);
      resumoAtualizado = true;
    } catch (err: any) {
      console.error("[sync-shopee] erro ao atualizar dashboard_resumos_diarios (não afeta o sync):", err?.message ?? err);
    }
    // [DIAG-SYNC-SHOPEE] temporário (2026-07-30) — ver comentário em withRetry.
    console.log("[DIAG-SYNC-SHOPEE] etapa6_resumo", { tempoMs: Date.now() - _resumoInicioMs, diasAfetados });
  }

  // [DIAG-SYNC-SHOPEE] temporário (2026-07-30) — ver comentário em withRetry.
  // Fecha o quadro: tempo total do sync inteiro, pra comparar com a soma das
  // etapas acima e confirmar que não sobra tempo "invisível" fora delas.
  console.log("[DIAG-SYNC-SHOPEE] sync_total", {
    tempoMsTotal: Date.now() - _syncInicioMs,
    found,
    inserted: rows.length,
    diasAfetados,
    resumoPendente,
  });

  return { found, inserted: rows.length, upsertErrors, resumoAtualizado, resumoPendente, diasAfetados, motivoResumoPendente };
}
