/**
 * Leitura do financeiro REAL do ML para a tela de Vendas (CDS V2 Vendas A3.2-B). SÓ banco — o provider é
 * chamado pelo coletor (job), nunca aqui. Dono + loja em toda consulta; lotes por `in` (sem N+1).
 * Falha de leitura → mapa vazio: as linhas seguem no modelo legado ESTIMATED (nunca ACTUAL por engano).
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FinanceiroRealML } from "./custo-produto";
import type { EnvioFinanceiroML, PedidoFinanceiroML } from "./ml-financeiro";

const LOTE = 200;
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export async function lerFinanceiroRealML(cliente: SupabaseClient, userId: string, lojaId: string, orderIds: readonly string[]): Promise<Map<string, FinanceiroRealML>> {
  const mapa = new Map<string, FinanceiroRealML>();
  const ids = [...new Set(orderIds.filter(Boolean).map(String))];
  if (!userId || !lojaId || ids.length === 0) return mapa;
  try {
    const pedidos: PedidoFinanceiroML[] = [];
    for (let i = 0; i < ids.length; i += LOTE) {
      const { data, error } = await cliente.from("ml_financeiro_pedidos")
        .select("order_id, pack_id, shipment_id, itens, receita_produto, tarifa_venda, tarifa_origem, desconto_vendedor, desconto_meli, descontos_status, billing_status, billing_tarifa")
        .eq("user_id", userId).eq("loja_id", lojaId).in("order_id", ids.slice(i, i + LOTE));
      if (error) throw new Error(error.message);
      for (const r of (data ?? []) as any[]) pedidos.push({
        ...r, order_id: String(r.order_id), itens: Number(r.itens), receita_produto: Number(r.receita_produto),
        tarifa_venda: num(r.tarifa_venda), desconto_vendedor: num(r.desconto_vendedor), desconto_meli: num(r.desconto_meli), billing_tarifa: num(r.billing_tarifa),
      });
    }
    const envios = new Map<string, EnvioFinanceiroML>();
    const shipments = [...new Set(pedidos.map((p) => p.shipment_id).filter((s): s is string => !!s))];
    for (let i = 0; i < shipments.length; i += LOTE) {
      const { data, error } = await cliente.from("ml_financeiro_envios")
        .select("shipment_id, pack_id, pedidos, frete_comprador, frete_vendedor, frete_bruto_referencia")
        .eq("user_id", userId).eq("loja_id", lojaId).in("shipment_id", shipments.slice(i, i + LOTE));
      if (error) throw new Error(error.message);
      for (const r of (data ?? []) as any[]) envios.set(String(r.shipment_id), {
        shipment_id: String(r.shipment_id), pack_id: r.pack_id ?? null, pedidos: Array.isArray(r.pedidos) ? r.pedidos.map(String) : null,
        frete_comprador: num(r.frete_comprador), frete_vendedor: num(r.frete_vendedor), frete_bruto_referencia: num(r.frete_bruto_referencia),
      });
    }
    for (const p of pedidos) mapa.set(p.order_id, { pedido: p, envio: p.shipment_id ? envios.get(p.shipment_id) ?? null : null });
  } catch (e: any) {
    console.error(`[ml-financeiro] leitura falhou (loja ${lojaId}): ${e?.message ?? e} — linhas seguem no modelo legado`);
    mapa.clear();
  }
  return mapa;
}
