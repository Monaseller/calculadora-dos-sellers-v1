/**
 * sync-ml.ts -- Sync completo Mercado Livre -> Supabase (tabela pedidos)
 *
 * CORRECOES v2:
 * BUG 1 CORRIGIDO: Paginacao travava em 1.000 pedidos por dia por status.
 *   -> ANTES: if (results.length < 50 || offset + 50 >= 1000) break;
 *   -> DEPOIS: usa paging.total da resposta; para so quando offset >= total
 *   -> Safety cap em 50.000
 *
 * BUG 2 CORRIGIDO: Historico buscava 6 dias quando pediu 1 (buffer desnecessario).
 *   -> noBuffer=true (Historico): busca EXATAMENTE o range solicitado
 *   -> noBuffer=false (Cron diario): estende -5 dias para capturar boletos
 *
 * BUG 3 NOVO: Retry com backoff exponencial (3 tentativas, 1s->2s->4s).
 *
 * BUG 4 NOVO: Timeout por request ML (20s).
 *
 * Retorna { found, inserted } para validacao externa.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";
import { CATEGORIAS_ML } from "@/lib/comissoes-mercado-livre";
import { LojaIdIntegrityError } from "@/lib/sync-errors";
import { lerTodasAsPaginas } from "@/lib/anuncios/leitura-paginada";

/**
 * Mapa de custo por item ML (CDS V2 Fase 0): SO anuncios do Mercado Livre do
 * dono — nunca Shopee (antes nao havia filtro de marketplace) — e TODAS as
 * paginas (o PostgREST corta em 1000 sem erro). Leitura falha → erro: um mapa
 * parcial gravaria custo 0 em silencio. Ainda sem loja: anuncios ML nao tem
 * loja_id (Fase 2); o item_id do ML e do vendedor, entao nao colide entre contas.
 */
export async function carregarMapaAnunciosML(userId: string): Promise<Map<string, any>> {
  const leitura = await lerTodasAsPaginas<any>(() => supabase()
    .from("anuncios")
    .select("id, ml_item_id, nome, sku, custo_produto, insumos, custo_frete, frete_gratis, imposto, tipo_anuncio, categoria")
    .eq("marketplace", "ML")
    .eq("ativo", true)
    .not("ml_item_id", "is", null)
    .eq("user_id", userId));
  if (!leitura.ok) throw new Error(`carregarMapaAnunciosML: ${leitura.motivo}`);
  const mapaAnuncios = new Map<string, any>();
  for (const a of leitura.linhas) {
    if (a.ml_item_id) mapaAnuncios.set(a.ml_item_id, a);
  }
  return mapaAnuncios;
}
// import { atualizarResumosDosDias } from "@/lib/resumos-diarios"; — desativado
// temporariamente 2026-07-13 (ver bloco de chamada removido mais abaixo).

// SEC-3-B1: dados sensiveis (SEC-3) so por service_role, server-side.
// O cliente nasce sob demanda — nunca no import — a partir do helper
// oficial; o isolamento por dono e da propria rota, nao do banco.
let clienteServidor: SupabaseClient | null = null;
function supabase(): SupabaseClient {
  return (clienteServidor ??= getSupabaseServidor());
}

async function withRetry<T>(
  fn: () => Promise<T>,
  tentativas = 3,
  delayMs    = 1000
): Promise<T> {
  let ultimoErro: unknown;
  for (let i = 0; i < tentativas; i++) {
    try {
      return await fn();
    } catch (e) {
      ultimoErro = e;
      if (i < tentativas - 1) {
        await new Promise(r => setTimeout(r, delayMs * Math.pow(2, i)));
      }
    }
  }
  throw ultimoErro;
}

async function mlFetch(url: string, token: string): Promise<any> {
  return withRetry(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`ML API ${res.status}: ${body.slice(0, 120)}`);
      }
      return await res.json();
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  });
}

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

// CORRECAO BUG 1: usa paging.total; nao trava em 1.000
async function fetchOrdersRange(
  sellerId: string,
  token:    string,
  from:     string,
  to:       string,
  status  = "paid"
): Promise<any[]> {
  const orders: any[] = [];
  let offset  = 0;
  const LIMIT = 50;
  const MAX   = 50_000;

  for (;;) {
    const url =
      `https://api.mercadolibre.com/orders/search` +
      `?seller=${sellerId}&order.status=${status}` +
      `&order.date_created.from=${encodeURIComponent(from)}` +
      `&order.date_created.to=${encodeURIComponent(to)}` +
      `&sort=date_asc` +
      `&limit=${LIMIT}&offset=${offset}`;

    const data = await mlFetch(url, token);
    const results: any[] = data.results ?? [];
    orders.push(...results);

    // CORRECAO BUG 1:
    // ANTES: if (results.length < 50 || offset + 50 >= 1000) break;
    // DEPOIS: para quando nao ha mais itens ou offset atingiu o total
    if (results.length < LIMIT) break;

    offset += LIMIT;
    const total = data.paging?.total ?? 0;
    if (total > 0 && offset >= total) break;
    if (offset >= MAX) break;
  }

  return orders;
}

function addDias(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split("T")[0];
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

export interface SyncMLResult {
  found:    number;
  inserted: number;
}

/** Loja ML já resolvida no servidor (dono + marketplace + credencial). */
export interface LojaMLResolvida { lojaId: string; accessToken: string; sellerId: string; nickname: string }

export async function syncMLForUser(
  userId:      string,
  dateFrom:    string,
  dateTo:      string,
  // CDS V2 Fase 1B: posição preservada, mas token do navegador NÃO é mais aceito.
  _semTokenDeCookie?: undefined,
  noBuffer     = false,
  lojaOverride?: LojaMLResolvida
): Promise<number> {
  const result = await syncMLForUserV2(userId, dateFrom, dateTo, undefined, noBuffer, lojaOverride);
  return result.inserted;
}

export async function syncMLForUserV2(
  userId:      string,
  dateFrom:    string,
  dateTo:      string,
  // CDS V2 Fase 1B: posição preservada, mas token do navegador NÃO é mais aceito.
  _semTokenDeCookie?: undefined,
  noBuffer     = false,
  // Adicionado 2026-07-11 (worker de sync_jobs): quando informado, sincroniza
  // EXATAMENTE esta loja (id conhecido, já resolvido por getMLLojaById),
  // sem passar pelo fluxo de cookie nem por getMLLojaAtiva ("mais recente
  // ativa") — necessário para o worker atender um job de uma loja_id
  // específica quando o usuário tem mais de uma loja ML. Não afeta nenhum
  // caller existente (cron, rota legada por cookie), que continuam sem
  // passar este argumento.
  // CDS V2 Fase 1B: OBRIGATÓRIA na prática — sem ela o sync falha fechado (ver abaixo).
  lojaOverride?: LojaMLResolvida
): Promise<SyncMLResult> {
  // CDS V2 Fase 1B: a loja é SEMPRE explícita — já resolvida por quem chama (resolverContaML /
  // getMLLojaById: dono + marketplace + credencial do servidor). Sem ela, falha fechado: nunca token
  // de cookie, nunca /users/me para adivinhar a loja, nunca "a mais recente" (getMLLojaAtiva).
  // Regra de integridade (2026-07-11) preservada: nenhum pedido é gravado sem loja_id.
  if (!lojaOverride?.lojaId || !lojaOverride.accessToken) {
    throw new LojaIdIntegrityError(`[sync-ml] loja ML explicita obrigatoria (userId=${userId}) — sync interrompido, nenhum pedido gravado.`);
  }
  const token    = lojaOverride.accessToken;
  const sellerId = lojaOverride.sellerId;
  const conta    = lojaOverride.nickname;
  const lojaId   = lojaOverride.lojaId;

  // CORRECAO BUG 2:
  // noBuffer=true  (Historico): busca EXATAMENTE o range pedido
  // noBuffer=false (Cron diario): estende -5 dias para capturar boletos
  const dateFetchFrom = noBuffer ? dateFrom : addDias(dateFrom, -5);
  const diasFetch     = gerarDias(dateFetchFrom, dateTo);

  const STATUSES = ["paid", "confirmed", "payment_in_process", "cancelled"] as const;
  const STATUS_MAP: Record<string, string> = {
    paid:               "paid",
    confirmed:          "pending",
    payment_in_process: "pending",
    cancelled:          "cancelled",
  };

  const allByStatus = await Promise.all(
    STATUSES.map(status =>
      Promise.all(
        diasFetch.map(d =>
          fetchOrdersRange(
            sellerId, token!,
            `${d}T00:00:00.000-03:00`,
            `${d}T23:59:59.999-03:00`,
            status
          ).catch(() => [] as any[])
        )
      ).then(results => results.flat().map(o => ({ ...o, _rawStatus: status })))
    )
  );

  const seenIds = new Set<number>();
  const allOrders: any[] = [];

  for (const grupo of allByStatus) {
    for (const o of grupo) {
      if (seenIds.has(o.id)) continue;
      seenIds.add(o.id);

      if (o._rawStatus === "cancelled") {
        const foiReembolsado = (o.payments ?? []).some(
          (p: any) => p.status === "refunded" || p.status === "partially_refunded"
        );
        o._status = foiReembolsado ? "devolucao" : "cancelled";
      } else {
        o._status = STATUS_MAP[o._rawStatus] ?? "paid";
      }

      allOrders.push(o);
    }
  }

  const found = allOrders.length;
  if (found === 0) return { found: 0, inserted: 0 };

  const mapaAnuncios = await carregarMapaAnunciosML(userId);

  const rows: any[] = [];
  const now = new Date().toISOString();

  for (const order of allOrders) {
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

    // ── Fase B (2026-07-06): data_criacao / data_pagamento / data_atualizacao_marketplace ──
    // Regra oficial: docs/BUSINESS_RULES.md ("Arquitetura de três datas"). Mesma arquitetura
    // aplicada em lib/sync-shopee.ts, adaptada aos campos nativos do ML. Não altera `dataPedido`
    // nem a regra de relatório existente (coluna `data` continua exatamente como antes).

    // data_criacao: sempre a partir de date_created, mesma extração de data que o
    // código já usa nos ramos de fallback acima (sem shift extra de timezone —
    // date_created do ML já vem com offset embutido no ISO string).
    const dataCriacaoML = order.date_created ? String(order.date_created).split("T")[0] : null;

    // data_pagamento: só quando existe pagamento aprovado (mesmo critério do bloco
    // acima: status "approved" ou "partially_refunded" com date_approved). NULL sem
    // fallback quando não há pagamento — mesma regra estrita usada na Shopee.
    const approvedPaymentML = (order.payments ?? []).find(
      (p: any) => p.status === "approved" || p.status === "partially_refunded"
    );
    const dataPagamentoML = approvedPaymentML?.date_approved
      ? new Date(new Date(approvedPaymentML.date_approved).getTime() - 3 * 60 * 60 * 1000).toISOString().split("T")[0]
      : null;

    // data_atualizacao_marketplace: ML expõe `last_updated` no recurso de Order (não
    // verificado empiricamente nesta sessão contra uma resposta real da API — se o
    // campo não vier, fica NULL de propósito, conforme instrução do usuário).
    const dataAtualizacaoMarketplaceML = order.last_updated
      ? new Date(order.last_updated).toISOString()
      : null;

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

      const impostoVal     = anuncio ? faturamento * ((anuncio.imposto   || 0) / 100) : 0;
      const custo          = anuncio ? ((anuncio.custo_produto || 0) + (anuncio.insumos || 0)) * qtd : 0;
      const freteGratis    = anuncio?.frete_gratis ?? false;
      const custoFrete     = (anuncio?.custo_frete ?? 0) as number;
      const freteComprador = freteGratis ? 0 : custoFrete * qtd;
      const freteVendedor  = freteGratis ? custoFrete * qtd : 0;
      const margemContrib  = faturamento - tarifaVenda - freteComprador - freteVendedor - impostoVal - custo;
      const mcPercent      = faturamento > 0 ? (margemContrib / faturamento) * 100 : 0;
      const lucroLiquido   = margemContrib;
      const roi            = custo > 0 ? (lucroLiquido / custo) * 100 : 0;

      rows.push({
        id:              `${userId}_ML_${order.id}_${mlItemId}`,
        user_id:         userId,
        marketplace:     "ML",
        order_id:        String(order.id),
        data:            dataPedido,
        data_criacao:    dataCriacaoML,
        data_pagamento:  dataPagamentoML,
        data_atualizacao_marketplace: dataAtualizacaoMarketplaceML,
        anuncio:         anuncio?.nome ?? orderItem.item?.title ?? mlItemId,
        ml_item_id:      mlItemId,
        variation_id:    null,
        conta,
        loja_id:         lojaId,
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
        lucro_liquido:   lucroLiquido,
        roi,
        cadastrado:      !!anuncio,
        synced_at:       now,
      });
    }
  }

  const UPSERT_BATCH = 250;
  for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
    await supabase()
      .from("pedidos")
      .upsert(rows.slice(i, i + UPSERT_BATCH), { onConflict: "id" });
  }

  // Fase 4 Parte 2 (recalculo de dashboard_resumos_diarios) REMOVIDA
  // TEMPORARIAMENTE em 2026-07-13 (ver docs/DECISIONS.md e docs/ROADMAP.md).
  // Motivo: dashboard_resumos_diarios ainda não existe no banco, a
  // funcionalidade pertence à Fase 4/Grupo C (não faz parte deste deploy), e
  // mesmo protegida por try/catch gerava log de erro conhecido em todo sync
  // de produção. lib/resumos-diarios.ts e a migration continuam no repo,
  // só não são chamados daqui até a Fase 4 estar completa e a migration
  // executada — reativar então (reintroduzir o bloco de coleta por conta +
  // a chamada a atualizarResumosDosDias, removidos nesta edição).

  return { found, inserted: rows.length };
}
