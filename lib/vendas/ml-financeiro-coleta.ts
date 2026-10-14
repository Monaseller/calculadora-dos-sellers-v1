/**
 * Motor do financeiro REAL do Mercado Livre (CDS V2 Vendas A3.2-B/C/E). Só GET no provider; credencial da
 * LOJA recebida pronta (nada de refresh aqui). Duas entradas:
 *   SYNC   (syncMLForUserV2, após gravar `pedidos`): recebe os PAYLOADS dos pedidos que o próprio sync já
 *          trouxe (order_items[].sale_fee, pack_id, shipping.id) — nenhum GET de pedido a mais;
 *   RETRY  (POST /api/ml/vendas/financeiro, ao recarregar Vendas): recebe order_ids PENDENTES e busca
 *          GET /orders/{order_id} — sempre ORDER id (o pack é outra entidade: GET /packs/{pack_id}).
 * Por pedido: /orders/{id}/discounts; por pack (1×): /packs/{id}; por envio (1×, mesmo com 2+ pedidos):
 * /shipments/{id}/costs; billing em lote. Pedido já COMPLETO no banco não é consultado de novo.
 *
 * A3.2-E STAGE-AWARE + MONOTÔNICO (fix forward da regressão 182af4e, em que o billing ficava numa cauda global depois
 * de todo o resto e a gravação de linha inteira rebaixava CONFERIDO para PENDENTE):
 *   - cada pedido tem um PLANO (planoRecuperacaoML): só as etapas que faltam — BILLING_ONLY não refaz pedido,
 *     descontos nem envio; sem linha → FULL_PIPELINE;
 *   - FILA por prioridade: P0 billing-only, P1 uma etapa, P2 várias, P3 sem linha; mais recente primeiro na classe;
 *   - MICRO-LOTES de MICRO_LOTE_ML: etapas necessárias do lote → billing DAQUELE lote → merge/gravação → próximo lote.
 *     Não existe billing global no fim;
 *   - gravação = MERGE com a linha existente (mesclarPedidoFinanceiroML / mesclarEnvioFinanceiroML): o que não foi
 *     obtido nunca vai como NULL/zero; veredito de billing nunca volta a PENDENTE; linha sem mudança não é regravada;
 *   - qualidade (ACTUAL/…) do resumo = estado FINAL mesclado, não só o resultado desta execução.
 *
 * TODO pedido do lote é tentado — não há teto por quantidade. A única proteção de tempo é o PRAZO: nenhuma
 * chamada nova ao provider começa depois de `ate` (a função tem 60 s; ver JANELA_PROVIDER_MS). O que não
 * coube vira DEFERRED_BY_RUNTIME_BUDGET: o pedido novo é gravado pelo payload, PENDENTE; o existente fica como
 * está — e entra no retry. Limite da CDS, não erro do Mercado Livre.
 * Erros do provider: TRANSIENT_ERROR (429, 502/503/504, timeout, rede) → retry com backoff e, se persistir,
 * PENDENTE; INTEGRATION_ERROR (404 inesperado, 4xx, 500, estrutura inválida) → sem retry cego, LOGADO com
 * contexto sanitizado (loja, pedido, pack, envio, etapa, HTTP) — nunca token nem dado do comprador.
 * A3.2-F RATE LIMIT + LOGS: o billing que esgota as tentativas com 429 abre um DISJUNTOR pelo resto da execução — nenhuma
 * chamada de billing nova; os pedidos restantes ficam como estão (elegíveis, nada rebaixado) e contam como rate_limited.
 * Billing 200 VÁLIDO sem cobrança do pedido = PROVIDER_DATA_NOT_READY em qualquer idade (o ML lança o billing depois
 * de 5 min — visto com 312/478/606 s). Logs por pedido são AMOSTRA (AMOSTRAS_LOG_ML por classe); o resumo é SEMPRE
 * emitido, uma vez, no fim — o volume de log não cresce com o número de pedidos.
 * A3.2-C.3 CARÊNCIA: venda com < 5 min (relógio do provider: date_closed/date_created) cujo subrecurso
 * financeiro ainda não existe (404/200 incompleto em descontos, pack, custos do envio ou billing) é
 * PROVIDER_DATA_NOT_READY — PENDENTE e elegível ao refresh, não bug. A 1ª tentativa é sempre imediata.
 */
import "server-only";
import {
  classeComCarenciaML, classificarHttpML, conferirBillingML, extrairDescontosML, extrairEnvioFinanceiroML, extrairPedidoFinanceiroML,
  FONTE_VERSAO_ML_FINANCEIRO, idadePedidoMLms, liquidoPedidoML, mesclarEnvioFinanceiroML, mesclarPedidoFinanceiroML, planoRecuperacaoML, prioridadeRecuperacaoML,
  type ClasseErroML, type ClasseFinanceiraML, type EnvioFinanceiroML, type EtapaRecuperacaoML, type ObtidoPedidoML, type PedidoFinanceiroML, type PlanoRecuperacaoML,
  type StatusBillingML, type TipoPlanoML,
} from "./ml-financeiro";

const API_ML = "https://api.mercadolibre.com";
export const LOTE_BILLING_ML = 20;
/**
 * A3.2-E — MICRO-LOTE = o lote do billing (20 ids por chamada): cada micro-lote executa só as etapas que faltam, o
 * billing DAQUELE lote e grava (merge) antes do próximo. Não é teto de negócio — todos os pedidos passam, lote a
 * lote, até o prazo. Com 20: 1 chamada de billing por lote; o prazo perde no máximo o lote em andamento; o
 * billing nunca espera o resto da fila (regressão 182af4e).
 */
export const MICRO_LOTE_ML = LOTE_BILLING_ML;
/** Mesma concorrência do coletor original (2): o ML já respondeu 429 no billing com chamadas avulsas. */
export const CONCORRENCIA_ML = 2;
export const TENTATIVAS_ML = 3;
/** Backoff entre tentativas transitórias: 1 s, 2 s. */
export const BACKOFF_BASE_MS = 1000;
/** Timeout por requisição — estourou → TRANSIENT_ERROR (retry). */
export const TIMEOUT_REQUISICAO_MS = 10_000;
/**
 * Janela em que chamadas NOVAS ao provider podem começar, contada do início da operação (sync ou retry).
 * Funções da Vercel têm 60 s: a última chamada iniciada em 40 s termina em até 50 s (timeout de 10 s;
 * nenhuma nova tentativa começa depois do prazo), sobrando ~10 s para gravar e responder. É a ÚNICA
 * proteção de tempo — sem teto por número de pedidos.
 */
export const JANELA_PROVIDER_MS = 40_000;
export const DEFERIDO = "DEFERRED_BY_RUNTIME_BUDGET" as const;
/**
 * A3.2-F — linhas de log por pedido são AMOSTRA: no máximo 5 por classe (INTEGRATION_ERROR, TRANSIENT_ERROR,
 * PROVIDER_DATA_NOT_READY, DEFERRED). Uma execução normal em produção registrou 4 linhas de falha (sync 4654084);
 * 5 por classe mantém tudo de uma execução saudável e corta a tempestade (o retry real passou de 250 linhas e perdeu o
 * resumo no teto de log da Vercel). As contagens completas ficam no resumo.
 */
export const AMOSTRAS_LOG_ML = 5;

type LinhaBase = { user_id: string; loja_id: string; fonte_versao: number; buscado_em: string };
export interface DepsColetaML {
  fetch: typeof fetch;
  esperar: (ms: number) => Promise<void>;
  gravarEnvios: (linhas: Array<EnvioFinanceiroML & LinhaBase>) => Promise<void>;
  gravarPedidos: (linhas: Array<PedidoFinanceiroML & LinhaBase>) => Promise<void>;
  /** Registros já gravados (pedido + envio): base do plano e do MERGE. Falha → nada é consultado nem gravado. */
  lerExistentes?: (orderIds: string[]) => Promise<Map<string, { pedido: PedidoFinanceiroML; envio: EnvioFinanceiroML | null }>>;
  agora?: () => Date;
  /** Relógio em ms (testes); padrão Date.now. */
  relogio?: () => number;
  log?: (linha: string) => void;
}
export interface FalhaFinanceiraML { order_id: string; pack_id: string | null; shipment_id: string | null; etapa: string; classe: ClasseFinanceiraML; http: number }
export interface ResultadoColetaML {
  pedidos: number; envios: number; billingPendente: number;
  actual: number; pendentes: number; integracao: number; transitorios: number; naoProntos: number; adiados: number; jaCompletos: number;
  planos: Record<TipoPlanoML, number>; lotes: number;
  /** A3.2-F: pedidos cujo billing ficou sem resposta por 429 (lote que esgotou as tentativas + os que o disjuntor pulou). */
  limitados: number;
  /** Linhas de log por pedido suprimidas (além da amostra) — as contagens acima seguem completas. */
  logsOmitidos: number;
  falhas: FalhaFinanceiraML[];
}
export type EntradaColetaML = readonly string[] | { pedidos: readonly any[] };
type RespML = { status: number; corpo: any | null; classe: ClasseErroML | "OK" | typeof DEFERIDO; retryAfter?: string | null };
type Billing = { billing_status: StatusBillingML; billing_tarifa: number | null };

const CAMPOS_PEDIDO = ["pack_id", "shipment_id", "itens", "receita_produto", "tarifa_venda", "tarifa_origem", "desconto_vendedor", "desconto_meli", "descontos_status", "billing_status", "billing_tarifa", "fonte_versao"] as const;
const CAMPOS_ENVIO = ["pack_id", "pedidos", "frete_comprador", "frete_vendedor", "frete_bruto_referencia"] as const;
const iguais = (a: any, b: any, campos: readonly string[]) => campos.every((k) => JSON.stringify(a[k] ?? null) === JSON.stringify(b[k] ?? null));

async function emParalelo<T>(itens: readonly T[], limite: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limite, itens.length) }, async () => { while (i < itens.length) await fn(itens[i++]); }));
}

export async function coletarFinanceiroML(
  conta: { userId: string; lojaId: string; accessToken: string },
  entrada: EntradaColetaML,
  deps: DepsColetaML,
  prazo: { ate?: number } = {},
): Promise<ResultadoColetaML> {
  const r: ResultadoColetaML = {
    pedidos: 0, envios: 0, billingPendente: 0, actual: 0, pendentes: 0, integracao: 0, transitorios: 0, naoProntos: 0, adiados: 0, jaCompletos: 0,
    planos: { FULL_PIPELINE: 0, BILLING_ONLY: 0, DISCOUNTS_ONLY: 0, SHIPPING_ONLY: 0, MULTI_STAGE: 0, SKIP: 0 }, lotes: 0, limitados: 0, logsOmitidos: 0, falhas: [],
  };
  const log = deps.log ?? ((l: string) => console.error(l));
  const ctx = { modoSync: !Array.isArray(entrada), pedidos: 0, adiados: new Set<string>() };
  try {
    await coletar(conta, entrada, deps, prazo, r, ctx, log);
    return r;
  } finally {
    // A3.2-F: o resumo sai SEMPRE (inclusive em falha de leitura/gravação), uma vez, e não depende das linhas anteriores
    r.adiados = ctx.adiados.size;
    const pl = r.planos;
    log(`[ml-financeiro] resumo loja=${conta.lojaId} modo=${ctx.modoSync ? "sync" : "retry"} pedidos=${ctx.pedidos} ja_completos=${r.jaCompletos} gravados=${r.pedidos} actual=${r.actual} pendentes=${r.pendentes} transient=${r.transitorios} integracao=${r.integracao} provider_data_not_ready=${r.naoProntos} deferred_by_runtime_budget=${r.adiados} rate_limited=${r.limitados} lotes=${r.lotes} full=${pl.FULL_PIPELINE} billing_only=${pl.BILLING_ONLY} discounts_only=${pl.DISCOUNTS_ONLY} shipping_only=${pl.SHIPPING_ONLY} multi=${pl.MULTI_STAGE} logs_omitidos=${r.logsOmitidos}`);
  }
}

async function coletar(
  conta: { userId: string; lojaId: string; accessToken: string },
  entrada: EntradaColetaML,
  deps: DepsColetaML,
  prazo: { ate?: number },
  r: ResultadoColetaML,
  ctx: { modoSync: boolean; pedidos: number; adiados: Set<string> },
  log: (linha: string) => void,
): Promise<void> {
  const agoraMs = deps.relogio ?? (() => Date.now());
  const ate = prazo.ate ?? agoraMs() + JANELA_PROVIDER_MS;
  const agoraReal = () => deps.agora?.() ?? new Date();   // idade da venda: relógio de parede vs horário do provider
  const idades = new Map<string, number | null>();
  const modoSync = ctx.modoSync;
  const payloads = new Map<string, any>();
  if (modoSync) for (const o of (entrada as { pedidos: readonly any[] }).pedidos) if (o?.id != null) payloads.set(String(o.id), o);
  // mais recente primeiro: o retry já chega ordenado pelo servidor; o sync é ordenado pelo relógio do provider
  const recencia = (id: string) => String(payloads.get(id)?.date_closed ?? payloads.get(id)?.date_created ?? "");
  const ids = modoSync
    ? [...payloads.keys()].sort((a, b) => (recencia(a) < recencia(b) ? 1 : recencia(a) > recencia(b) ? -1 : 0))
    : [...new Set((entrada as readonly string[]).map(String))];
  ctx.pedidos = ids.length;

  /** GET com timeout; retry com backoff SÓ em erro transitório; nenhuma chamada (nem retry) depois do prazo. */
  async function getML(caminho: string, extra: Record<string, string> = {}): Promise<RespML> {
    let status = 0, retryAfter: string | null = null;
    for (let t = 0; t < TENTATIVAS_ML; t++) {
      if (t > 0) await deps.esperar(BACKOFF_BASE_MS * 2 ** (t - 1));
      if (agoraMs() >= ate) return { status, corpo: null, classe: t === 0 ? DEFERIDO : "TRANSIENT_ERROR" };
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), TIMEOUT_REQUISICAO_MS);
      try {
        const res = await deps.fetch(API_ML + caminho, { method: "GET", headers: { Authorization: `Bearer ${conta.accessToken}`, ...extra }, signal: ctrl.signal });
        status = res.status;
        const classe = classificarHttpML(status);
        if (classe === "TRANSIENT_ERROR") { if (status === 429) retryAfter = (res.headers?.get?.("retry-after") ?? "").replace(/[^0-9]/g, "").slice(0, 6) || null; continue; }
        let corpo: any = null; try { corpo = await res.json(); } catch {}
        return { status, corpo, classe };
      } catch { status = 0; } // timeout/rede → transitório
      finally { clearTimeout(tid); }
    }
    return { status, corpo: null, classe: "TRANSIENT_ERROR", retryAfter };
  }

  const adiados = ctx.adiados;
  const amostras = new Map<string, number>();
  /** A3.2-F: a linha por pedido só sai enquanto a classe não esgotou a amostra; o resto só conta. */
  const amostra = (classe: string) => { const n = amostras.get(classe) ?? 0; amostras.set(classe, n + 1); if (n >= AMOSTRAS_LOG_ML) r.logsOmitidos++; return n < AMOSTRAS_LOG_ML; };
  const registrar = (f: (Omit<FalhaFinanceiraML, "classe"> & { classe: ClasseFinanceiraML }) | { order_id: string; pack_id: string | null; shipment_id: string | null; etapa: string; classe: typeof DEFERIDO }) => {
    if (f.classe === DEFERIDO) {
      if (!adiados.has(f.order_id)) { adiados.add(f.order_id); if (amostra(DEFERIDO)) log(`[ml-financeiro] ${DEFERIDO} loja=${conta.lojaId} order=${f.order_id} pack=${f.pack_id ?? "-"} shipment=${f.shipment_id ?? "-"} etapa=${f.etapa}`); }
      return;
    }
    const idade = idades.get(f.order_id) ?? null;
    const g: FalhaFinanceiraML = { ...f, classe: f.classe === "INTEGRATION_ERROR" ? classeComCarenciaML(f.classe, f.etapa, f.http, idade) : f.classe };
    r.falhas.push(g);
    if (g.classe === "INTEGRATION_ERROR") r.integracao++; else if (g.classe === "TRANSIENT_ERROR") r.transitorios++; else r.naoProntos++;
    const idadeLog = idade !== null ? ` order_age_s=${Math.round(idade / 1000)}` : "";
    if (amostra(g.classe)) log(`[ml-financeiro] ${g.classe} loja=${conta.lojaId} order=${g.order_id} pack=${g.pack_id ?? "-"} shipment=${g.shipment_id ?? "-"} etapa=${g.etapa} http=${g.http}${idadeLog}`);
  };

  // A3.2-E: o merge monotônico PRECISA do estado existente — leitura falhou → nada é consultado nem gravado
  let existentes: Map<string, { pedido: PedidoFinanceiroML; envio: EnvioFinanceiroML | null }>;
  try { existentes = deps.lerExistentes ? await deps.lerExistentes(ids) : new Map(); }
  catch {
    log(`[ml-financeiro] ERRO leitura do financeiro existente loja=${conta.lojaId} — nada consultado nem gravado (merge sem base)`);
    return;
  }
  const enviosBanco = new Map<string, EnvioFinanceiroML>();
  for (const e of existentes.values()) if (e.envio) enviosBanco.set(e.envio.shipment_id, e.envio);

  // plano por pedido; COMPLETO (SKIP) não é consultado de novo
  const planos = new Map<string, PlanoRecuperacaoML>();
  for (const id of ids) { const pl = planoRecuperacaoML(existentes.get(id)); planos.set(id, pl); r.planos[pl.tipo]++; }
  r.jaCompletos = r.planos.SKIP;
  // fila: P0 billing-only → P1 uma etapa → P2 várias → P3 sem linha; dentro da classe, a ordem de recência
  const fila = ids.filter((id) => planos.get(id)!.tipo !== "SKIP")
    .map((id, i) => ({ id, i, p: prioridadeRecuperacaoML(planos.get(id)!.tipo)! }))
    .sort((a, b) => a.p - b.p || a.i - b.i)
    .map((x) => x.id);

  const obtidos = new Map<string, ObtidoPedidoML>();
  const envios = new Map<string, Promise<EnvioFinanceiroML | null>>();  // 1 GET por envio na execução inteira, mesmo concorrente
  const precisa = (id: string, e: EtapaRecuperacaoML) => planos.get(id)!.etapas.includes(e);

  /** Etapas do plano de UM pedido (sem billing — o billing é do lote). */
  async function etapasDoPedido(id: string): Promise<void> {
    const ob: ObtidoPedidoML = {};
    obtidos.set(id, ob);
    const ex = existentes.get(id)?.pedido ?? null;
    let order = payloads.get(id);
    if (!order && precisa(id, "pedido")) {
      const o = await getML(`/orders/${encodeURIComponent(id)}`);
      if (o.classe === DEFERIDO) { registrar({ order_id: id, pack_id: null, shipment_id: null, etapa: "order", classe: DEFERIDO }); return; }
      if (o.classe !== "OK" || !o.corpo) { registrar({ order_id: id, pack_id: null, shipment_id: null, etapa: "order", classe: o.classe === "OK" ? "INTEGRATION_ERROR" : o.classe, http: o.status }); return; }
      order = o.corpo;
    }
    if (order && (String(order?.id) !== id || !Array.isArray(order?.order_items))) {
      if (precisa(id, "pedido")) {
        registrar({ order_id: id, pack_id: order?.pack_id != null ? String(order.pack_id) : null, shipment_id: null, etapa: "order_estrutura", classe: "INTEGRATION_ERROR", http: 200 });
        return;
      }
      order = undefined;
    }
    if (order) idades.set(id, idadePedidoMLms(order, agoraReal()));
    // venda do payload: os dados do pedido existem mesmo que o prazo acabe antes da 1ª chamada (gravada PENDENTE)
    if (order && precisa(id, "pedido")) ob.pedido = extrairPedidoFinanceiroML(order, null);
    const pack_id = ob.pedido?.pack_id ?? ex?.pack_id ?? null;
    const shipment_id = ob.pedido?.shipment_id ?? ex?.shipment_id ?? null;

    if (precisa(id, "descontos")) {
      const d = await getML(`/orders/${encodeURIComponent(id)}/discounts`);
      // A3.2-D (auditado): 404 com error "discount_not_found" = pedido SEM desconto (não é erro) — tem precedência sobre a
      // carência genérica; qualquer outro 404 segue a classificação normal (carência/integração).
      const semDesconto = d.status === 404 && d.corpo?.error === "discount_not_found";
      const desc = extrairDescontosML(d.classe === "OK" ? d.corpo : semDesconto ? { details: [] } : null);
      if (desc) ob.descontos = desc;
      if (d.classe === DEFERIDO) { registrar({ order_id: id, pack_id, shipment_id, etapa: "discounts", classe: DEFERIDO }); return; }
      if (d.classe !== "OK" && !semDesconto) registrar({ order_id: id, pack_id, shipment_id, etapa: "discounts", classe: d.classe, http: d.status });
    }

    if (precisa(id, "envio") && shipment_id) {
      if (!envios.has(shipment_id)) envios.set(shipment_id, (async () => {
        const noBanco = enviosBanco.get(shipment_id) ?? null;
        let pedidos: string[] | null = noBanco?.pedidos ?? (pack_id ? null : [id]);
        if (!pedidos && pack_id) {
          const pk = await getML(`/packs/${encodeURIComponent(pack_id)}`);
          if (pk.classe === DEFERIDO) { registrar({ order_id: id, pack_id, shipment_id, etapa: "pack", classe: DEFERIDO }); return null; }
          pedidos = pk.classe === "OK" && Array.isArray(pk.corpo?.orders) ? pk.corpo.orders.map((x: any) => String(x?.id)) : null;
          if (!pedidos) registrar({ order_id: id, pack_id, shipment_id, etapa: "pack", classe: pk.classe === "OK" ? "INTEGRATION_ERROR" : pk.classe, http: pk.status });
        }
        // custo já gravado: só faltavam os pedidos do pack — nenhum GET de custo
        if (noBanco && noBanco.frete_vendedor !== null) return mesclarEnvioFinanceiroML(noBanco, { ...noBanco, pedidos });
        const c = await getML(`/shipments/${encodeURIComponent(shipment_id)}/costs`, { "x-format-new": "true" });
        if (c.classe === DEFERIDO) { registrar({ order_id: id, pack_id, shipment_id, etapa: "shipment_costs", classe: DEFERIDO }); return null; }
        const envio = extrairEnvioFinanceiroML(shipment_id, pack_id, c.classe === "OK" ? c.corpo : null, pedidos);
        if (c.classe !== "OK") registrar({ order_id: id, pack_id, shipment_id, etapa: "shipment_costs", classe: c.classe, http: c.status });
        else if (envio.frete_vendedor === null) registrar({ order_id: id, pack_id, shipment_id, etapa: "shipment_costs_estrutura", classe: "INTEGRATION_ERROR", http: 200 });
        return mesclarEnvioFinanceiroML(noBanco, envio);
      })());
      await envios.get(shipment_id);
    }
  }

  /**
   * A3.2-F DISJUNTOR: um lote de billing que esgotou as tentativas com 429 abre o disjuntor — nenhum billing novo nesta
   * execução (o próximo lote não é "testado"). Os pedidos pulados não ganham `billing` obtido: a linha fica como está.
   */
  let billingLimitado = false;
  /** Billing do MICRO-LOTE (1 chamada ≤ 20 ids) — só dos pedidos cujo plano inclui billing e que têm base. */
  async function billingDoLote(lote: readonly string[]): Promise<void> {
    const alvoB = lote.filter((id) => precisa(id, "billing") && (existentes.has(id) || !!obtidos.get(id)?.pedido));
    if (!alvoB.length) return;
    if (billingLimitado) { r.limitados += alvoB.length; return; }
    const b = await getML(`/billing/integration/group/ML/order/details?order_ids=${alvoB.map(encodeURIComponent).join(",")}`);
    if (b.classe === "TRANSIENT_ERROR" && b.status === 429) {
      billingLimitado = true;
      r.limitados += alvoB.length;
      log(`[ml-financeiro] billing_rate_limited loja=${conta.lojaId} lote=${r.lotes} pedidos=${alvoB.length} tentativas=${TENTATIVAS_ML} retry_after=${b.retryAfter ?? "-"} — disjuntor aberto: sem billing até o fim da execução`);
    }
    // 200 sem a lista de resultados = resposta impossível (erro de integração); 200 válido sem cobrança = ainda não lançado
    const estruturaInvalida = b.classe === "OK" && !Array.isArray(b.corpo?.results);
    const aplicar = (id: string, conf0: Billing, base: PedidoFinanceiroML | null) => {
      const ob = obtidos.get(id)!;
      // A3.2-C.3: billing parcial de venda na carência não é divergência — fica PENDENTE (elegível ao refresh)
      const parcialNaCarencia = conf0.billing_status === "DIVERGENTE" && classeComCarenciaML("INTEGRATION_ERROR", "billing_divergente", 200, idades.get(id) ?? null) === "PROVIDER_DATA_NOT_READY";
      const conf: Billing = parcialNaCarencia ? { billing_status: "PENDENTE", billing_tarifa: conf0.billing_tarifa } : conf0;
      const ctx = { order_id: id, pack_id: base?.pack_id ?? null, shipment_id: base?.shipment_id ?? null };
      if (b.classe === DEFERIDO) registrar({ ...ctx, etapa: "billing", classe: DEFERIDO });
      else if (b.classe !== "OK") registrar({ ...ctx, etapa: "billing", classe: b.classe, http: b.status });
      else if (conf0.billing_status === "DIVERGENTE") registrar({ ...ctx, etapa: "billing_divergente", classe: "INTEGRATION_ERROR", http: 200 });
      else if (estruturaInvalida) registrar({ ...ctx, etapa: "billing_estrutura", classe: "INTEGRATION_ERROR", http: 200 });
      // A3.2-F (produção: 312/478/606 s): 200 válido sem cobrança do pedido = o ML ainda não lançou — em QUALQUER idade
      else if (conf0.billing_status === "PENDENTE") registrar({ ...ctx, etapa: "billing", classe: "PROVIDER_DATA_NOT_READY", http: 200 });
      ob.billing = conf;   // PENDENTE nunca rebaixa um veredito existente (mesclarPedidoFinanceiroML)
    };
    const semIdade: Array<{ id: string; conf0: Billing; base: PedidoFinanceiroML | null }> = [];
    for (const id of alvoB) {
      const base = mesclarPedidoFinanceiroML(existentes.get(id)?.pedido ?? null, { pedido: obtidos.get(id)?.pedido });
      const conf0: Billing = b.classe === DEFERIDO ? { billing_status: "PENDENTE", billing_tarifa: null } : conferirBillingML(id, base?.tarifa_venda ?? null, b.status, b.corpo);
      // BILLING_ONLY no retry não lê o pedido: sem a idade, um billing ainda parcial (carência) viraria DIVERGENTE definitivo
      if (conf0.billing_status === "DIVERGENTE" && !idades.has(id)) semIdade.push({ id, conf0, base });
      else aplicar(id, conf0, base);
    }
    await emParalelo(semIdade, CONCORRENCIA_ML, async ({ id, conf0, base }) => {
      const o = await getML(`/orders/${encodeURIComponent(id)}`);
      if (o.classe === DEFERIDO) { registrar({ order_id: id, pack_id: base?.pack_id ?? null, shipment_id: base?.shipment_id ?? null, etapa: "billing", classe: DEFERIDO }); return; }
      if (o.classe !== "OK" || String(o.corpo?.id) !== id) { registrar({ order_id: id, pack_id: base?.pack_id ?? null, shipment_id: base?.shipment_id ?? null, etapa: "billing_idade", classe: o.classe === "OK" ? "INTEGRATION_ERROR" : o.classe, http: o.status }); return; }
      idades.set(id, idadePedidoMLms(o.corpo, agoraReal()));
      aplicar(id, conf0, base);
    });
  }

  // merge + gravação por micro-lote; depois do prazo, as linhas restantes vão numa gravação final única
  const finais = new Map<string, PedidoFinanceiroML>();
  const enviosVistos = new Set<string>();
  const paraGravar = { pedidos: [] as Array<PedidoFinanceiroML & LinhaBase>, envios: [] as Array<EnvioFinanceiroML & LinhaBase> };
  async function mesclarLote(lote: readonly string[]): Promise<void> {
    const buscado_em = (deps.agora?.() ?? new Date()).toISOString();
    const base = { user_id: conta.userId, loja_id: conta.lojaId, buscado_em };
    for (const id of lote) {
      const ex = existentes.get(id)?.pedido ?? null;
      const m = mesclarPedidoFinanceiroML(ex, obtidos.get(id) ?? {});
      if (!m) continue;
      finais.set(id, m);
      if (!ex || !iguais(ex, m, CAMPOS_PEDIDO)) paraGravar.pedidos.push({ ...m, ...base, fonte_versao: m.fonte_versao ?? FONTE_VERSAO_ML_FINANCEIRO });
      const s = m.shipment_id;
      if (!s || enviosVistos.has(s) || !envios.has(s)) continue;
      enviosVistos.add(s);
      const e = await envios.get(s)!;
      if (!e) continue;
      const ant = enviosBanco.get(s) ?? null;
      if (!ant || !iguais(ant, e, CAMPOS_ENVIO)) { paraGravar.envios.push({ ...e, ...base, fonte_versao: FONTE_VERSAO_ML_FINANCEIRO }); enviosBanco.set(s, e); }
    }
  }
  async function gravar(): Promise<void> {
    if (paraGravar.envios.length) { r.envios += paraGravar.envios.length; await deps.gravarEnvios(paraGravar.envios.splice(0)); }
    if (paraGravar.pedidos.length) { r.pedidos += paraGravar.pedidos.length; await deps.gravarPedidos(paraGravar.pedidos.splice(0)); }
  }

  // MICRO-LOTES: etapas necessárias → billing do MESMO lote → merge/gravação → só então o próximo
  for (let i = 0; i < fila.length; i += MICRO_LOTE_ML) {
    const lote = fila.slice(i, i + MICRO_LOTE_ML);
    r.lotes++;
    await emParalelo(lote, CONCORRENCIA_ML, etapasDoPedido);
    await billingDoLote(lote);
    await mesclarLote(lote);
    if (agoraMs() < ate) await gravar();
  }
  await gravar();

  // qualidade pelo estado FINAL mesclado (linha + envio do banco/desta execução)
  for (const [id, p] of finais) {
    const envio = p.shipment_id ? enviosBanco.get(p.shipment_id) ?? existentes.get(id)?.envio ?? null : null;
    if (liquidoPedidoML(p, envio).qualidade === "ACTUAL") r.actual++; else r.pendentes++;
    if (p.billing_status === "PENDENTE") r.billingPendente++;
  }
}
