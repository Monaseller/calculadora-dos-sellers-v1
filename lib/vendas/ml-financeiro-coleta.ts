/**
 * Motor do financeiro REAL do Mercado Livre (CDS V2 Vendas A3.2-B/C). Só GET no provider; credencial da
 * LOJA recebida pronta (nada de refresh aqui). Duas entradas:
 *   SYNC   (syncMLForUserV2, após gravar `pedidos`): recebe os PAYLOADS dos pedidos que o próprio sync já
 *          trouxe (order_items[].sale_fee, pack_id, shipping.id) — nenhum GET de pedido a mais;
 *   RETRY  (POST /api/ml/vendas/financeiro, ao recarregar Vendas): recebe order_ids PENDENTES e busca
 *          GET /orders/{order_id} — sempre ORDER id (o pack é outra entidade: GET /packs/{pack_id}).
 * Por pedido: /orders/{id}/discounts; por pack (1×): /packs/{id}; por envio (1×, mesmo com 2+ pedidos):
 * /shipments/{id}/costs; billing em lote. Pedido já COMPLETO no banco não é consultado de novo.
 *
 * TODO pedido do lote é tentado — não há teto por quantidade. A única proteção de tempo é o PRAZO: nenhuma
 * chamada nova ao provider começa depois de `ate` (a função tem 60 s; ver JANELA_PROVIDER_MS). O que não
 * coube vira DEFERRED_BY_RUNTIME_BUDGET: o pedido é gravado pelo payload, PENDENTE, e entra no retry —
 * limite da CDS, não erro do Mercado Livre.
 * Erros do provider: TRANSIENT_ERROR (429, 502/503/504, timeout, rede) → retry com backoff e, se persistir,
 * PENDENTE; INTEGRATION_ERROR (404 inesperado, 4xx, 500, estrutura inválida) → sem retry cego, LOGADO com
 * contexto sanitizado (loja, pedido, pack, envio, etapa, HTTP) — nunca token nem dado do comprador.
 */
import "server-only";
import {
  classificarHttpML, conferirBillingML, extrairEnvioFinanceiroML, extrairPedidoFinanceiroML, financeiroPendenteElegivel,
  FONTE_VERSAO_ML_FINANCEIRO, liquidoPedidoML, type ClasseErroML, type EnvioFinanceiroML, type PedidoFinanceiroML,
} from "./ml-financeiro";

const API_ML = "https://api.mercadolibre.com";
export const LOTE_BILLING_ML = 20;
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

type LinhaBase = { user_id: string; loja_id: string; fonte_versao: number; buscado_em: string };
export interface DepsColetaML {
  fetch: typeof fetch;
  esperar: (ms: number) => Promise<void>;
  gravarEnvios: (linhas: Array<EnvioFinanceiroML & LinhaBase>) => Promise<void>;
  gravarPedidos: (linhas: Array<PedidoFinanceiroML & LinhaBase>) => Promise<void>;
  /** Registros já gravados (pedido + envio) — pedido COMPLETO não é consultado de novo. */
  lerExistentes?: (orderIds: string[]) => Promise<Map<string, { pedido: PedidoFinanceiroML; envio: EnvioFinanceiroML | null }>>;
  agora?: () => Date;
  /** Relógio em ms (testes); padrão Date.now. */
  relogio?: () => number;
  log?: (linha: string) => void;
}
export interface FalhaFinanceiraML { order_id: string; pack_id: string | null; shipment_id: string | null; etapa: string; classe: ClasseErroML; http: number }
export interface ResultadoColetaML {
  pedidos: number; envios: number; billingPendente: number;
  actual: number; pendentes: number; integracao: number; transitorios: number; adiados: number; jaCompletos: number;
  falhas: FalhaFinanceiraML[];
}
export type EntradaColetaML = readonly string[] | { pedidos: readonly any[] };
type RespML = { status: number; corpo: any | null; classe: ClasseErroML | "OK" | typeof DEFERIDO };

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
  const r: ResultadoColetaML = { pedidos: 0, envios: 0, billingPendente: 0, actual: 0, pendentes: 0, integracao: 0, transitorios: 0, adiados: 0, jaCompletos: 0, falhas: [] };
  const log = deps.log ?? ((l: string) => console.error(l));
  const agoraMs = deps.relogio ?? (() => Date.now());
  const ate = prazo.ate ?? agoraMs() + JANELA_PROVIDER_MS;
  const modoSync = !Array.isArray(entrada);
  const payloads = new Map<string, any>();
  if (modoSync) for (const o of (entrada as { pedidos: readonly any[] }).pedidos) if (o?.id != null) payloads.set(String(o.id), o);
  const ids = modoSync ? [...payloads.keys()] : [...new Set((entrada as readonly string[]).map(String))];

  /** GET com timeout; retry com backoff SÓ em erro transitório; nenhuma chamada (nem retry) depois do prazo. */
  async function getML(caminho: string, extra: Record<string, string> = {}): Promise<RespML> {
    let status = 0;
    for (let t = 0; t < TENTATIVAS_ML; t++) {
      if (t > 0) await deps.esperar(BACKOFF_BASE_MS * 2 ** (t - 1));
      if (agoraMs() >= ate) return { status, corpo: null, classe: t === 0 ? DEFERIDO : "TRANSIENT_ERROR" };
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), TIMEOUT_REQUISICAO_MS);
      try {
        const res = await deps.fetch(API_ML + caminho, { method: "GET", headers: { Authorization: `Bearer ${conta.accessToken}`, ...extra }, signal: ctrl.signal });
        status = res.status;
        const classe = classificarHttpML(status);
        if (classe === "TRANSIENT_ERROR") continue;
        let corpo: any = null; try { corpo = await res.json(); } catch {}
        return { status, corpo, classe };
      } catch { status = 0; } // timeout/rede → transitório
      finally { clearTimeout(tid); }
    }
    return { status, corpo: null, classe: "TRANSIENT_ERROR" };
  }

  const adiados = new Set<string>();
  const registrar = (f: FalhaFinanceiraML | { order_id: string; pack_id: string | null; shipment_id: string | null; etapa: string; classe: typeof DEFERIDO }) => {
    if (f.classe === DEFERIDO) {
      if (!adiados.has(f.order_id)) { adiados.add(f.order_id); log(`[ml-financeiro] ${DEFERIDO} loja=${conta.lojaId} order=${f.order_id} pack=${f.pack_id ?? "-"} shipment=${f.shipment_id ?? "-"} etapa=${f.etapa}`); }
      return;
    }
    r.falhas.push(f);
    if (f.classe === "INTEGRATION_ERROR") r.integracao++; else r.transitorios++;
    log(`[ml-financeiro] ${f.classe} loja=${conta.lojaId} order=${f.order_id} pack=${f.pack_id ?? "-"} shipment=${f.shipment_id ?? "-"} etapa=${f.etapa} http=${f.http}`);
  };

  // pedido já COMPLETO no banco → não consulta de novo
  const existentes = deps.lerExistentes ? await deps.lerExistentes(ids).catch(() => new Map()) : new Map();
  const alvo = ids.filter((id) => {
    const e = existentes.get(id);
    if (e && financeiroPendenteElegivel(e.pedido, e.envio) === null) { r.jaCompletos++; return false; }
    return true;
  });

  const extraidos = new Map<string, Omit<PedidoFinanceiroML, "billing_status" | "billing_tarifa">>();
  const pedidosDoPack = new Map<string, Promise<string[] | null>>();   // 1 GET por pack, mesmo concorrente
  const envios = new Map<string, Promise<EnvioFinanceiroML | null>>();  // 1 GET por envio, mesmo concorrente

  // pipeline por pedido (concorrência 2): pedido → descontos → pack → custo do envio
  await emParalelo(alvo, CONCORRENCIA_ML, async (id) => {
    let order = payloads.get(id);
    if (!order) {
      const o = await getML(`/orders/${encodeURIComponent(id)}`);
      if (o.classe === DEFERIDO) { registrar({ order_id: id, pack_id: null, shipment_id: null, etapa: "order", classe: DEFERIDO }); return; }
      if (o.classe !== "OK" || !o.corpo) { registrar({ order_id: id, pack_id: null, shipment_id: null, etapa: "order", classe: o.classe === "OK" ? "INTEGRATION_ERROR" : o.classe, http: o.status }); return; }
      order = o.corpo;
    }
    if (String(order?.id) !== id || !Array.isArray(order?.order_items)) {
      registrar({ order_id: id, pack_id: order?.pack_id != null ? String(order.pack_id) : null, shipment_id: null, etapa: "order_estrutura", classe: "INTEGRATION_ERROR", http: 200 });
      return;
    }
    const d = await getML(`/orders/${encodeURIComponent(id)}/discounts`);
    const p = extrairPedidoFinanceiroML(order, d.classe === "OK" ? d.corpo : null);
    extraidos.set(id, p);
    if (d.classe === DEFERIDO) { registrar({ order_id: id, pack_id: p.pack_id, shipment_id: p.shipment_id, etapa: "discounts", classe: DEFERIDO }); return; }
    if (d.classe !== "OK") registrar({ order_id: id, pack_id: p.pack_id, shipment_id: p.shipment_id, etapa: "discounts", classe: d.classe, http: d.status });

    let pedidosDoEnvio: string[] | null = [p.order_id];
    if (p.pack_id) {
      if (!pedidosDoPack.has(p.pack_id)) pedidosDoPack.set(p.pack_id, getML(`/packs/${encodeURIComponent(p.pack_id)}`).then((pk) => {
        if (pk.classe === DEFERIDO) { registrar({ order_id: id, pack_id: p.pack_id, shipment_id: p.shipment_id, etapa: "pack", classe: DEFERIDO }); return null; }
        const lista = pk.classe === "OK" && Array.isArray(pk.corpo?.orders) ? pk.corpo.orders.map((x: any) => String(x?.id)) : null;
        if (!lista) registrar({ order_id: id, pack_id: p.pack_id, shipment_id: p.shipment_id, etapa: "pack", classe: pk.classe === "OK" ? "INTEGRATION_ERROR" : pk.classe, http: pk.status });
        return lista;
      }));
      pedidosDoEnvio = await pedidosDoPack.get(p.pack_id)!;
    }
    if (p.shipment_id && !envios.has(p.shipment_id)) {
      const pedidos = pedidosDoEnvio;
      envios.set(p.shipment_id, getML(`/shipments/${encodeURIComponent(p.shipment_id)}/costs`, { "x-format-new": "true" }).then((c) => {
        if (c.classe === DEFERIDO) { registrar({ order_id: id, pack_id: p.pack_id, shipment_id: p.shipment_id, etapa: "shipment_costs", classe: DEFERIDO }); return null; }
        const envio = extrairEnvioFinanceiroML(p.shipment_id!, p.pack_id, c.classe === "OK" ? c.corpo : null, pedidos);
        if (c.classe !== "OK") registrar({ order_id: id, pack_id: p.pack_id, shipment_id: p.shipment_id, etapa: "shipment_costs", classe: c.classe, http: c.status });
        else if (envio.frete_vendedor === null) registrar({ order_id: id, pack_id: p.pack_id, shipment_id: p.shipment_id, etapa: "shipment_costs_estrutura", classe: "INTEGRATION_ERROR", http: 200 });
        return envio;
      }));
    }
    if (p.shipment_id) await envios.get(p.shipment_id);
  });

  // pedidos do payload que nem começaram (prazo) → gravados pelo payload, PENDENTES
  for (const id of alvo) if (!extraidos.has(id) && adiados.has(id)) { const o = payloads.get(id); if (o && Array.isArray(o.order_items)) extraidos.set(id, extrairPedidoFinanceiroML(o, null)); }

  // billing em lote; sem resposta → PENDENTE (nunca ACTUAL); prazo → PENDENTE (deferido); divergência → logada
  const finais: PedidoFinanceiroML[] = [];
  const consultados = [...extraidos.keys()];
  for (let i = 0; i < consultados.length; i += LOTE_BILLING_ML) {
    const lote = consultados.slice(i, i + LOTE_BILLING_ML);
    const b = await getML(`/billing/integration/group/ML/order/details?order_ids=${lote.map(encodeURIComponent).join(",")}`);
    for (const id of lote) {
      const p = extraidos.get(id)!;
      const conf = b.classe === DEFERIDO ? { billing_status: "PENDENTE" as const, billing_tarifa: null } : conferirBillingML(id, p.tarifa_venda, b.status, b.corpo);
      if (conf.billing_status === "PENDENTE") r.billingPendente++;
      if (b.classe === DEFERIDO) registrar({ order_id: id, pack_id: p.pack_id, shipment_id: p.shipment_id, etapa: "billing", classe: DEFERIDO });
      else if (b.classe !== "OK") registrar({ order_id: id, pack_id: p.pack_id, shipment_id: p.shipment_id, etapa: "billing", classe: b.classe, http: b.status });
      else if (conf.billing_status === "DIVERGENTE") registrar({ order_id: id, pack_id: p.pack_id, shipment_id: p.shipment_id, etapa: "billing_divergente", classe: "INTEGRATION_ERROR", http: 200 });
      finais.push({ ...p, ...conf });
    }
  }

  const buscado_em = (deps.agora?.() ?? new Date()).toISOString();
  const base = { user_id: conta.userId, loja_id: conta.lojaId, fonte_versao: FONTE_VERSAO_ML_FINANCEIRO, buscado_em };
  const enviosProntos = new Map<string, EnvioFinanceiroML>();
  for (const [s, pr] of envios) { const e = await pr; if (e) enviosProntos.set(s, e); }
  const linhasEnvio = [...enviosProntos.values()].map((e) => ({ ...e, ...base }));
  if (linhasEnvio.length) await deps.gravarEnvios(linhasEnvio);
  if (finais.length) await deps.gravarPedidos(finais.map((p) => ({ ...p, ...base })));
  r.envios = linhasEnvio.length; r.pedidos = finais.length; r.adiados = adiados.size;
  for (const p of finais) {
    const envio = p.shipment_id ? enviosProntos.get(p.shipment_id) ?? existentes.get(p.order_id)?.envio ?? null : null;
    if (liquidoPedidoML(p, envio).qualidade === "ACTUAL") r.actual++; else r.pendentes++;
  }
  log(`[ml-financeiro] resumo loja=${conta.lojaId} modo=${modoSync ? "sync" : "retry"} pedidos=${ids.length} ja_completos=${r.jaCompletos} gravados=${r.pedidos} actual=${r.actual} pendentes=${r.pendentes} transient=${r.transitorios} integracao=${r.integracao} deferred_by_runtime_budget=${r.adiados}`);
  return r;
}
