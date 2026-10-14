/**
 * Coletor do financeiro REAL do Mercado Livre (CDS V2 Vendas A3.2-B). Roda em JOB/sync — NUNCA no GET de
 * Vendas (a tela só lê o banco). Só GET no provider; credencial da LOJA recebida pronta (nada de refresh aqui).
 *
 * Por pedido: GET /orders/{id} e /orders/{id}/discounts; por pack (1×): GET /packs/{id} (pedidos do envio);
 * por envio (1×, mesmo com 2+ pedidos): GET /shipments/{id}/costs; billing em lote (order_ids). 429/5xx →
 * retry com backoff; billing que segue sem resposta vira PENDENTE (o pedido é gravado, sem ACTUAL).
 * Gravação idempotente: upsert por (loja_id, order_id) e (loja_id, shipment_id) — reprocessar é seguro.
 */
import "server-only";
import { conferirBillingML, extrairEnvioFinanceiroML, extrairPedidoFinanceiroML, FONTE_VERSAO_ML_FINANCEIRO, type EnvioFinanceiroML, type PedidoFinanceiroML } from "./ml-financeiro";

const API_ML = "https://api.mercadolibre.com";
export const LOTE_BILLING_ML = 20;
export const CONCORRENCIA_ML = 2;
export const TENTATIVAS_ML = 3;

export interface DepsColetaML {
  fetch: typeof fetch;
  esperar: (ms: number) => Promise<void>;
  gravarEnvios: (linhas: Array<EnvioFinanceiroML & { user_id: string; loja_id: string; fonte_versao: number; buscado_em: string }>) => Promise<void>;
  gravarPedidos: (linhas: Array<PedidoFinanceiroML & { user_id: string; loja_id: string; fonte_versao: number; buscado_em: string }>) => Promise<void>;
  agora?: () => Date;
}
export interface ResultadoColetaML { pedidos: number; envios: number; billingPendente: number; falhas: Array<{ order_id: string; motivo: string }> }

/** GET com retry/backoff em 429 e 5xx. Nunca outro método. */
async function getML(deps: DepsColetaML, token: string, caminho: string, extra: Record<string, string> = {}): Promise<{ status: number; corpo: any | null }> {
  let status = 0;
  for (let t = 0; t < TENTATIVAS_ML; t++) {
    if (t > 0) await deps.esperar(1000 * 2 ** (t - 1));
    try {
      const res = await deps.fetch(API_ML + caminho, { method: "GET", headers: { Authorization: `Bearer ${token}`, ...extra } });
      status = res.status;
      if (status === 429 || status >= 500) continue;
      let corpo: any = null; try { corpo = await res.json(); } catch {}
      return { status, corpo };
    } catch { status = 0; }
  }
  return { status, corpo: null };
}

async function emParalelo<T>(itens: readonly T[], limite: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limite, itens.length) }, async () => { while (i < itens.length) await fn(itens[i++]); }));
}

export async function coletarFinanceiroML(
  conta: { userId: string; lojaId: string; accessToken: string },
  orderIds: readonly string[],
  deps: DepsColetaML,
): Promise<ResultadoColetaML> {
  const r: ResultadoColetaML = { pedidos: 0, envios: 0, billingPendente: 0, falhas: [] };
  const extraidos = new Map<string, Omit<PedidoFinanceiroML, "billing_status" | "billing_tarifa">>();
  const pedidosDoPack = new Map<string, string[] | null>();
  const envios = new Map<string, EnvioFinanceiroML>();

  await emParalelo([...new Set(orderIds.map(String))], CONCORRENCIA_ML, async (id) => {
    const o = await getML(deps, conta.accessToken, `/orders/${encodeURIComponent(id)}`);
    if (o.status !== 200 || !o.corpo) { r.falhas.push({ order_id: id, motivo: `order_${o.status}` }); return; }
    const d = await getML(deps, conta.accessToken, `/orders/${encodeURIComponent(id)}/discounts`);
    extraidos.set(id, extrairPedidoFinanceiroML(o.corpo, d.status === 200 ? d.corpo : null));
  });

  // pedidos que compartilham o envio: os do pack (1 GET por pack) ou só o próprio pedido
  for (const p of extraidos.values()) if (p.pack_id && !pedidosDoPack.has(p.pack_id)) {
    const pk = await getML(deps, conta.accessToken, `/packs/${encodeURIComponent(p.pack_id)}`);
    pedidosDoPack.set(p.pack_id, pk.status === 200 && Array.isArray(pk.corpo?.orders) ? pk.corpo.orders.map((x: any) => String(x?.id)) : null);
  }
  // custo do envio: UMA vez por shipment, mesmo com 2+ pedidos
  for (const p of extraidos.values()) if (p.shipment_id && !envios.has(p.shipment_id)) {
    const c = await getML(deps, conta.accessToken, `/shipments/${encodeURIComponent(p.shipment_id)}/costs`, { "x-format-new": "true" });
    const pedidos = p.pack_id ? (pedidosDoPack.get(p.pack_id) ?? null) : [p.order_id];
    envios.set(p.shipment_id, extrairEnvioFinanceiroML(p.shipment_id, p.pack_id, c.status === 200 ? c.corpo : null, pedidos));
  }

  // billing em lote; resposta ausente → PENDENTE por pedido (sem ACTUAL)
  const ids = [...extraidos.keys()];
  const finais: PedidoFinanceiroML[] = [];
  for (let i = 0; i < ids.length; i += LOTE_BILLING_ML) {
    const lote = ids.slice(i, i + LOTE_BILLING_ML);
    const b = await getML(deps, conta.accessToken, `/billing/integration/group/ML/order/details?order_ids=${lote.map(encodeURIComponent).join(",")}`);
    for (const id of lote) {
      const p = extraidos.get(id)!;
      const conf = conferirBillingML(id, p.tarifa_venda, b.status, b.corpo);
      if (conf.billing_status === "PENDENTE") r.billingPendente++;
      finais.push({ ...p, ...conf });
    }
  }

  const buscado_em = (deps.agora?.() ?? new Date()).toISOString();
  const base = { user_id: conta.userId, loja_id: conta.lojaId, fonte_versao: FONTE_VERSAO_ML_FINANCEIRO, buscado_em };
  const linhasEnvio = [...envios.values()].map((e) => ({ ...e, ...base }));
  if (linhasEnvio.length) await deps.gravarEnvios(linhasEnvio);
  if (finais.length) await deps.gravarPedidos(finais.map((p) => ({ ...p, ...base })));
  r.envios = linhasEnvio.length; r.pedidos = finais.length;
  return r;
}
