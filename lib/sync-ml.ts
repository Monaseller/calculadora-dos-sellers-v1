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
 *   -> noBuffer=false (Cron diario/auto-sync): estende ML_STATUS_RECHECK_WINDOW_HOURS (7 dias) para trás
 *      (boletos e rechecagem de status de vendas recentes)
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
import { coletarFinanceiroML, JANELA_PROVIDER_MS, type DepsColetaML, type ResultadoColetaML } from "@/lib/vendas/ml-financeiro-coleta";
import { lerFinanceiroRealML } from "@/lib/vendas/ml-financeiro-leitura";
import { dataBRT, pagamentoAprovadoML, statusPedidoML } from "@/lib/vendas/metricas-ml";

/** Chave do mapa de custo ML: LOJA | item | variacao ("" = item sem variacao). Nunca so dono + item. */
export function chaveAnuncioML(lojaId: string, mlItemId: string, variationId: string | number | null | undefined): string {
  return `${lojaId}|${mlItemId}|${variationId === null || variationId === undefined ? "" : String(variationId)}`;
}
/** Custo da linha EXATA (item + variacao) da loja; fallback controlado so para a linha SEM variacao do item. */
export function buscarAnuncioML(mapa: Map<string, any>, lojaId: string, mlItemId: string, variationId: string | number | null | undefined): any {
  return mapa.get(chaveAnuncioML(lojaId, mlItemId, variationId)) ?? mapa.get(chaveAnuncioML(lojaId, mlItemId, null));
}

/**
 * Mapa de custo por item ML (CDS V2 Fase 0 → 2D): SO anuncios do Mercado Livre
 * DAQUELA LOJA do dono — nunca Shopee, nunca outra loja ML (o mesmo item/variacao
 * em ML-A e ML-B sao anuncios diferentes, com custos diferentes) — e TODAS as
 * paginas (o PostgREST corta em 1000 sem erro). Leitura falha → erro: um mapa
 * parcial gravaria custo 0 em silencio.
 */
export async function carregarMapaAnunciosML(userId: string, lojaId: string): Promise<Map<string, any>> {
  if (!lojaId) throw new Error("carregarMapaAnunciosML: loja_obrigatoria");
  const leitura = await lerTodasAsPaginas<any>(() => supabase()
    .from("anuncios")
    .select("id, ml_item_id, variation_id, nome, sku, custo_produto, insumos, custo_frete, frete_gratis, imposto, tipo_anuncio, categoria, loja_id")
    .eq("marketplace", "ML")
    .eq("ativo", true)
    .not("ml_item_id", "is", null)
    .eq("user_id", userId)
    .eq("loja_id", lojaId));
  if (!leitura.ok) throw new Error(`carregarMapaAnunciosML: ${leitura.motivo}`);
  const mapaAnuncios = new Map<string, any>();
  for (const a of leitura.linhas) {
    if (a.ml_item_id && a.loja_id === lojaId) mapaAnuncios.set(chaveAnuncioML(lojaId, a.ml_item_id, a.variation_id), a);
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

/**
 * Vendas A3.3.1 — JANELA DE RECHECAGEM de status (decisão aprovada): o sync de rotina (noBuffer=false: cron e
 * auto-sync) busca pedidos CRIADOS até 168 h antes do início do intervalo; cancelamentos (inclusive pack_splitted)
 * achados nessa janela atualizam a linha existente (pago fora do intervalo continua fora — o financeiro não muda de
 * escopo). Evidência (auditoria real 07–14/10/2026, 112 cancelamentos): até 151,6 h após a criação
 * (shipment_not_delivered); os 120 h (5 dias) anteriores não cobriam. NÃO é o limite de devoluções tardias (fase
 * separada) — é só a reconciliação de status recente.
 */
export const ML_STATUS_RECHECK_WINDOW_HOURS = 168;

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
  /** Vendas A4-B: itens com linha legada sem variação + 2+ variações na resposta — preservados, não corrigidos. */
  legadoVariacaoAmbigua?: number;
  /** Vendas A3.2-C: resumo do financeiro REAL coletado no próprio sync (null = enriquecimento falhou, logado). */
  financeiro?: ResultadoColetaML | null;
}

/** Vendas A3.2-C: dependências do motor financeiro — mesmo cliente servidor do sync, mesma loja. */
function depsFinanceiroML(userId: string, lojaId: string): DepsColetaML {
  return {
    fetch: (...a) => fetch(...a),
    esperar: (ms) => new Promise((ok) => setTimeout(ok, ms)),
    gravarEnvios: async (linhas) => {
      const { error } = await supabase().from("ml_financeiro_envios").upsert(linhas, { onConflict: "loja_id,shipment_id" });
      if (error) throw new Error(`gravação de ml_financeiro_envios falhou: ${error.message}`);
    },
    gravarPedidos: async (linhas) => {
      const { error } = await supabase().from("ml_financeiro_pedidos").upsert(linhas, { onConflict: "loja_id,order_id" });
      if (error) throw new Error(`gravação de ml_financeiro_pedidos falhou: ${error.message}`);
    },
    lerExistentes: (ids) => lerFinanceiroRealML(supabase(), userId, lojaId, ids, { estrito: true }),
  };
}

// ── Vendas A4-B: identidade EXATA da linha de venda ML ──────────────────────
//
// Identidade = dono + loja + ML + pedido + item + variação (ou vazio). SKU, nome, preço e posição não
// participam. Linha NOVA ganha id com loja e variação; linha LEGADA (`${userId}_ML_${order}_${item}`, sem
// loja nem variação) mantém o PK: é reaproveitada quando é a mesma identidade, ou ADOTADA (recebe a
// variação) só quando a resposta tem UMA única variação daquele item no pedido. Com 2+ variações e uma
// legada sem variação, nada é chutado: a legada fica como está e o item é reportado (sem dupla contagem).
// Histórico nunca é preenchido por inferência. Toda leitura/escrita é da loja da execução.

/** Erro de GRAVAÇÃO dos pedidos ML: o sync falha (nunca "concluído" com lote perdido). Transitório. */
export class ErroGravacaoPedidosML extends Error {}

/** Id de uma linha NOVA: dono + ML + loja + pedido + item + variação ("nv" = sem variação). */
export function idPedidoML(userId: string, lojaId: string, orderId: string, itemId: string, variationId: string | null): string {
  return `${userId}_ML_${lojaId}_${orderId}_${itemId}_${variationId ?? "nv"}`;
}

/** Variação informada pelo provider para o item do pedido (null = item sem variação). */
export function variacaoDoItemML(orderItem: any): string | null {
  const v = orderItem?.item?.variation_id;
  return v === null || v === undefined || String(v) === "" ? null : String(v);
}

/** Linha de `pedidos` já existente da MESMA loja (lida por dono + ML + loja + pedidos). */
export interface PedidoMLExistente { id: string; order_id: string; ml_item_id: string | null; variation_id: string | null; loja_id: string | null }
export interface AmbiguidadeVariacaoML { order_id: string; ml_item_id: string; idLegado: string; variacoes: string[] }

/**
 * Decide o PK de cada linha a gravar. `linhas` já vêm com o id NOVO (idPedidoML). Existentes de outra loja
 * são ignorados (a leitura já é da loja; isto é defesa) — nenhuma linha de outra loja é adotada.
 */
export function resolverIdsPedidosML<T extends { id: string; order_id: string; ml_item_id: string; variation_id: string | null }>(
  lojaId: string, linhas: readonly T[], existentes: readonly PedidoMLExistente[]
): { linhas: T[]; ambiguas: AmbiguidadeVariacaoML[] } {
  const chave = (o: string, i: string | null, v: string | null) => `${o}|${i ?? ""}|${v ?? ""}`;
  const daLoja = existentes.filter((e) => e.loja_id === lojaId);
  const exatos = new Map(daLoja.map((e) => [chave(e.order_id, e.ml_item_id, e.variation_id), e] as const));
  const legadosSemVariacao = new Map<string, PedidoMLExistente[]>();
  for (const e of daLoja) if (e.variation_id === null) {
    const k = `${e.order_id}|${e.ml_item_id ?? ""}`;
    legadosSemVariacao.set(k, [...(legadosSemVariacao.get(k) ?? []), e]);
  }
  const variacoesDoItem = new Map<string, Set<string>>();
  for (const l of linhas) if (l.variation_id !== null) {
    const k = `${l.order_id}|${l.ml_item_id}`;
    variacoesDoItem.set(k, (variacoesDoItem.get(k) ?? new Set<string>()).add(l.variation_id));
  }
  const saida: T[] = [];
  const ambiguas = new Map<string, AmbiguidadeVariacaoML>();
  for (const l of linhas) {
    const exato = exatos.get(chave(l.order_id, l.ml_item_id, l.variation_id));
    if (exato) { saida.push({ ...l, id: exato.id }); continue; }
    const k = `${l.order_id}|${l.ml_item_id}`;
    const legados = legadosSemVariacao.get(k) ?? [];
    if (l.variation_id !== null && legados.length > 0) {
      const variacoes = variacoesDoItem.get(k)!;
      if (variacoes.size === 1 && legados.length === 1) { saida.push({ ...l, id: legados[0].id }); continue; }
      ambiguas.set(k, { order_id: l.order_id, ml_item_id: l.ml_item_id, idLegado: legados[0].id, variacoes: [...variacoes].sort() });
      continue;
    }
    saida.push(l);
  }
  return { linhas: saida, ambiguas: [...ambiguas.values()] };
}

/** Linhas existentes da loja para os pedidos da resposta (dono + ML + loja + pedidos). Erro → falha. */
async function lerPedidosMLExistentesDaLoja(userId: string, lojaId: string, orderIds: string[]): Promise<PedidoMLExistente[]> {
  const existentes: PedidoMLExistente[] = [];
  for (let i = 0; i < orderIds.length; i += 200) {
    const { data, error } = await supabase()
      .from("pedidos")
      .select("id, order_id, ml_item_id, variation_id, loja_id")
      .eq("user_id", userId)
      .eq("marketplace", "ML")
      .eq("loja_id", lojaId)
      .in("order_id", orderIds.slice(i, i + 200));
    if (error) throw new ErroGravacaoPedidosML(`[sync-ml] leitura de pedidos existentes falhou: ${error.message}`);
    existentes.push(...((data ?? []) as PedidoMLExistente[]));
  }
  return existentes;
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
  const inicioSync = Date.now();   // A3.2-C.1: prazo do financeiro conta do início do sync (função de 60 s)
  const token    = lojaOverride.accessToken;
  const sellerId = lojaOverride.sellerId;
  const conta    = lojaOverride.nickname;
  const lojaId   = lojaOverride.lojaId;

  // CORRECAO BUG 2:
  // noBuffer=true  (Historico): busca EXATAMENTE o range pedido
  // noBuffer=false (Cron diario/auto-sync): estende a janela de rechecagem (7 dias) — boletos + status recente
  const dateFetchFrom = noBuffer ? dateFrom : addDias(dateFrom, -ML_STATUS_RECHECK_WINDOW_HOURS / 24);
  const diasFetch     = gerarDias(dateFetchFrom, dateTo);

  const STATUSES = ["paid", "confirmed", "payment_in_process", "cancelled"] as const;

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

      // Vendas A3.3: cancelado `pack_splitted` → pack_dividido; outro `internal` → cancelado_interno (auditado)
      o._status = statusPedidoML(o._rawStatus, o);

      allOrders.push(o);
    }
  }

  const found = allOrders.length;
  if (found === 0) return { found: 0, inserted: 0 };

  const mapaAnuncios = await carregarMapaAnunciosML(userId, lojaId);

  const rows: any[] = [];
  const now = new Date().toISOString();

  for (const order of allOrders) {
    // Vendas A3.3: toda data é a do INSTANTE em BRT (o ML manda −04:00; truncar a string errava 00:00–00:59 BRT)
    const cancelado = order._status !== "paid" && order._status !== "pending";
    let dataPedido: string;
    if (cancelado) {
      dataPedido = dataBRT(order.date_created ?? order.date_closed) ?? dateFrom;
    } else {
      dataPedido = dataBRT(pagamentoAprovadoML(order.payments)?.date_approved) ?? dataBRT(order.date_created) ?? dateFrom;
    }

    // Vendas A3.3 STATUS: cancelamento de pedido criado na janela de busca (inclusive o buffer de dias anteriores) é
    // gravado mesmo com a data fora do intervalo — a linha antiga deixa de ficar `paid` para sempre (venda cancelada ou
    // dividida depois do sync do seu dia). Pedido pago fora do intervalo segue fora (o financeiro não muda de escopo).
    if ((dataPedido < dateFrom || dataPedido > dateTo) && !cancelado) continue;

    // ── Fase B (2026-07-06): data_criacao / data_pagamento / data_atualizacao_marketplace ──
    // Regra oficial: docs/BUSINESS_RULES.md ("Arquitetura de três datas"). Mesma arquitetura
    // aplicada em lib/sync-shopee.ts, adaptada aos campos nativos do ML. Não altera `dataPedido`
    // nem a regra de relatório existente (coluna `data` continua exatamente como antes).

    // data_criacao: dia em BRT do INSTANTE date_created (A3.3: o ML manda −04:00 — truncar a string punha as
    // vendas de 00:00–00:59 BRT no dia anterior; auditado em 8 pedidos de 06→07/10).
    const dataCriacaoML = dataBRT(order.date_created);

    // data_pagamento: só com pagamento de aprovação COMPROVADA (approved, partially_refunded, in_mediation — A3.3) e
    // date_approved; NULL sem fallback quando não há pagamento — mesma regra estrita usada na Shopee.
    const dataPagamentoML = dataBRT(pagamentoAprovadoML(order.payments)?.date_approved);

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
      const variationId       = variacaoDoItemML(orderItem);   // Vendas A4-B: variação EXATA do provider
      const anuncio           = buscarAnuncioML(mapaAnuncios, lojaId, mlItemId, variationId);

      // Vendas A3.2-B: `tarifa_venda` é SEMPRE POR UNIDADE (a sale_fee do provider é por unidade e líquida);
      // a estimativa por categoria também passa a ser por unidade (antes era da LINHA e o leitor × qtd
      // contava de novo) e a origem fica marcada: 'PROVIDER' | 'ESTIMATE'. Histórico não é reescrito.
      const saleFeeML = typeof orderItem.sale_fee === "number" ? orderItem.sale_fee : null;
      const tarifaOrigem: "PROVIDER" | "ESTIMATE" = saleFeeML !== null ? "PROVIDER" : "ESTIMATE";
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
        tarifaVenda = valorUnit * comissaoRate;
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
        id:              idPedidoML(userId, lojaId, String(order.id), mlItemId, variationId),
        user_id:         userId,
        marketplace:     "ML",
        order_id:        String(order.id),
        data:            dataPedido,
        data_criacao:    dataCriacaoML,
        data_pagamento:  dataPagamentoML,
        data_atualizacao_marketplace: dataAtualizacaoMarketplaceML,
        anuncio:         anuncio?.nome ?? orderItem.item?.title ?? mlItemId,
        ml_item_id:      mlItemId,
        variation_id:    variationId,
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
        tarifa_origem:   tarifaOrigem,
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

  // Vendas A4-B: PK de cada linha pela identidade exata (legada reaproveitada/adotada; nova com loja e
  // variação); item legado ambíguo (2+ variações) não é gravado nem chutado — fica como está.
  const existentes = await lerPedidosMLExistentesDaLoja(userId, lojaId, [...new Set(rows.map((r) => r.order_id as string))]);
  const { linhas: resolvidas, ambiguas } = resolverIdsPedidosML(lojaId, rows, existentes);
  for (const a of ambiguas) {
    console.error(`[sync-ml] LEGACY_VARIATION_AMBIGUOUS loja=${lojaId} pedido=${a.order_id} item=${a.ml_item_id} variacoes=${a.variacoes.join(",")} — linha legada preservada`);
  }

  // Erro de gravação FALHA o sync (antes era ignorado: lote perdido em silêncio e sync "concluído").
  const UPSERT_BATCH = 250;
  for (let i = 0; i < resolvidas.length; i += UPSERT_BATCH) {
    const { error } = await supabase()
      .from("pedidos")
      .upsert(resolvidas.slice(i, i + UPSERT_BATCH), { onConflict: "id" });
    if (error) throw new ErroGravacaoPedidosML(`[sync-ml] gravação de pedidos falhou (loja ${lojaId}, lote ${i / UPSERT_BATCH + 1}): ${error.message}`);
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

  // Vendas A3.2-C: o financeiro REAL das vendas gravadas entra NO PRÓPRIO sync — todo caminho (auto-sync de
  // Vendas, sync manual, cron, executor interno) passa por aqui. Mesma loja/credencial do pedido; só vendas
  // PAGAS; o payload já trazido é reaproveitado (sem GET de pedido); pedido já completo não é consultado.
  // A3.2-C.1: TODA venda do lote é tentada; só o prazo de execução adia (DEFERRED_BY_RUNTIME_BUDGET).
  // Erro financeiro NÃO falha o sync (os pedidos já foram gravados): é logado e fica pendente para retry.
  const gravados = new Set(resolvidas.map((r) => String(r.order_id)));
  let financeiro: ResultadoColetaML | null = null;
  try {
    financeiro = await coletarFinanceiroML(
      { userId, lojaId, accessToken: token },
      { pedidos: allOrders.filter((o) => o._status === "paid" && gravados.has(String(o.id))) },
      depsFinanceiroML(userId, lojaId),
      { ate: inicioSync + JANELA_PROVIDER_MS },
    );
  } catch (e: any) {
    console.error(`[ml-financeiro] ERRO enriquecimento loja=${lojaId}: ${e?.message ?? e}`);
  }

  return { found, inserted: resolvidas.length, legadoVariacaoAmbigua: ambiguas.length, financeiro };
}
