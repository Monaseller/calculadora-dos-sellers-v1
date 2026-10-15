/**
 * Vendas A3.4 (Parte B) — a TABELA de vendas do Mercado Livre lida do PROVIDER, paginada no servidor.
 *
 *   busca     `/orders/search` por `order.date_closed` (dia civil BRT), ≤ 50 por busca, `date_desc`; cursor
 *             (dia, offset) — o offset anda pelo que VEIO; o dia acaba pela contagem `paging.total`. O provider
 *             devolve ~1 h além do fim do dia: cada pedido é do dia BRT do SEU `date_closed` (sem duplicar).
 *   provider  decide status, datas, quantidade, unit_price, pack, item, variação, sale_fee e envio. O legado
 *             `pedidos` NÃO é lido: um status/data velho do banco nunca vence o provider.
 *   regra     `pack_splitted` fora (a MESMA função canônica `pedidoMLContaNaVenda`); status por `statusPedidoML`
 *             (fail-closed: desconhecido nunca vira pago).
 *   visões    "fechamento": o dia do `date_closed`. "pago": candidatos por `date_closed` no período ±1 dia BRT; entra
 *             SÓ pedido pago cuja aprovação elegível MAIS ANTIGA (approved / partially_refunded / in_mediation com
 *             `date_approved` válido) cai, em BRT, dentro do período.
 *   custo     Meus Produtos (custo + insumos + imposto) — custo DESCONHECIDO nunca é zero (lucro pendente).
 *   financeiro A3.4-C: SÓ das linhas desta página (pedidos pagos visíveis), live e sem gravar — tarifa real, frete do
 *             vendedor real, líquido ML e então lucro/margem/MC (lib/vendas/ml-financeiro-live.ts). O prazo vale
 *             para a requisição inteira (busca + financeiro); o que não coube volta PENDING.
 *
 * Nunca devolve dado do comprador nem token.
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { abrirLeitorPaginasFechamentoML, OFFSET_MAXIMO_ML, type PortasVendasML } from "@/lib/mercado-livre-vendas";
import { normalizarPedidoML, pedidoMLContaNaVenda } from "@/lib/vendas/canonico/ml";
import { carregarMapaCustoProduto, type FinanceiroVendaLive } from "@/lib/vendas/custo-produto";
import type { ComponentesFinanceirosML } from "@/lib/vendas/custo-produto-tipos";
import { JANELA_PROVIDER_MS } from "@/lib/vendas/ml-financeiro-coleta";
import { coletarFinanceiroLiveML, componentesDaLinhaML, financeiroLiveDaLinhaML, type DepsFinanceiroLiveML } from "@/lib/vendas/ml-financeiro-live";
import { aprovacaoElegivelMaisAntigaML, dataBRT, statusPedidoML, type StatusPedidoML } from "@/lib/vendas/metricas-ml";
import { somarDiasNoCalendario } from "@/lib/fuso-sao-paulo";

export type VisaoTabelaML = "fechamento" | "pago";
export interface CursorTabelaML { dia: string; offset: number }

/** Buscas por requisição (cada uma ≤ 50 pedidos): a página para ao juntar 50 linhas ou ao fim do período. */
export const MAX_BUSCAS_POR_PAGINA_TABELA_ML = 4;
export const LINHAS_POR_PAGINA_TABELA_ML = 50;

export interface LinhaTabelaML {
  origem: "PROVIDER";
  orderId: string;
  packId: string | null;
  shippingId: string | null;
  /** null = status desconhecido do provider (fail-closed: nunca pago). */
  status: StatusPedidoML | null;
  /** Dia BRT do `date_closed`. */
  dataFechamento: string;
  /** Dia BRT da aprovação elegível mais antiga (null = sem aprovação elegível). */
  dataPagamento: string | null;
  itemId: string | null;
  variacaoId: string | null;
  titulo: string;
  sku: string | null;
  qtd: number;
  valorUnit: number;
  faturamento: number;
  /** `order_items[].sale_fee` (POR UNIDADE), como o provider devolveu. null = ausente. */
  saleFeeUnitario: number | null;
  /** A3.4-C: tarifa / frete do vendedor / frete do comprador / líquido ML desta linha, com status (UNKNOWN ≠ ZERO). */
  financeiroML: ComponentesFinanceirosML;
  /** Custo/imposto/lucro ao vivo de Meus Produtos + componentes. null = mapa de custo indisponível. */
  financeiro: FinanceiroVendaLive | null;
}

export interface PaginaTabelaML {
  origem: "PROVIDER";
  visao: VisaoTabelaML;
  periodo: { de: string; ate: string };
  linhas: LinhaTabelaML[];
  /** null = fim do período. */
  proximoCursor: CursorTabelaML | null;
  buscas: number;
  custoDisponivel: boolean;
  /** Dias cujo volume passou do offset máximo do provider (linhas além disso não são lidas — nunca inventadas). */
  diasTruncados: string[];
  erro: string | null;
}

const DIA = /^\d{4}-\d{2}-\d{2}$/;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const texto = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : null);

/** Dias de busca da visão (do mais recente ao mais antigo). Pago: período ±1 dia (candidatos por fechamento). */
export function diasDeBuscaTabelaML(visao: VisaoTabelaML, de: string, ate: string): { primeiro: string; ultimo: string } {
  return visao === "pago" ? { primeiro: somarDiasNoCalendario(de, -1), ultimo: somarDiasNoCalendario(ate, 1) } : { primeiro: de, ultimo: ate };
}

export function lerCursorTabelaML(v: string | null): CursorTabelaML | null | "INVALIDO" {
  if (v === null || v === "") return null;
  const m = /^(\d{4}-\d{2}-\d{2}):(\d{1,5})$/.exec(v);
  if (!m) return "INVALIDO";
  const offset = Number(m[2]);
  return offset < OFFSET_MAXIMO_ML ? { dia: m[1], offset } : "INVALIDO";
}
export const cursorTabelaMLParaTexto = (c: CursorTabelaML | null): string | null => (c ? `${c.dia}:${c.offset}` : null);

/** Um pedido do provider → linhas da tabela (uma por item) ou [] quando fora da visão/período. Puro. */
type LinhaBrutaML = Omit<LinhaTabelaML, "financeiro" | "financeiroML">;
export function linhasDoPedidoML(o: Record<string, unknown>, ctx: { visao: VisaoTabelaML; de: string; ate: string; diaDaBusca: string }): LinhaBrutaML[] {
  const n = normalizarPedidoML(o);
  if (n.diaFechamento !== ctx.diaDaBusca) return [];          // borda: o pedido é do dia do SEU date_closed
  if (!pedidoMLContaNaVenda(n)) return [];                     // pack_splitted: a venda está nos substitutos
  const status = statusPedidoML(String(o.status ?? ""), o);
  const aprovadoEm = aprovacaoElegivelMaisAntigaML(o.payments);
  const dataPagamento = aprovadoEm ? dataBRT(aprovadoEm) : null;
  if (ctx.visao === "pago") {
    if (status !== "paid" || dataPagamento === null || dataPagamento < ctx.de || dataPagamento > ctx.ate) return [];
  } else if (n.diaFechamento < ctx.de || n.diaFechamento > ctx.ate) return [];
  const shipping = (o.shipping ?? null) as Record<string, unknown> | null;
  const itens = Array.isArray(o.order_items) ? (o.order_items as unknown[]) : [];
  const out: LinhaBrutaML[] = [];
  for (const bruto of itens) {
    if (typeof bruto !== "object" || bruto === null) continue;
    const it = bruto as Record<string, unknown>;
    const item = (it.item ?? {}) as Record<string, unknown>;
    const qtd = num(it.quantity) ?? 0, valorUnit = num(it.unit_price) ?? 0;
    const saleFee = num(it.sale_fee);
    out.push({
      origem: "PROVIDER", orderId: n.pedidoId, packId: texto(o.pack_id), shippingId: texto(shipping?.id),
      status, dataFechamento: n.diaFechamento, dataPagamento,
      itemId: texto(item.id), variacaoId: texto(item.variation_id), titulo: typeof item.title === "string" ? item.title : "",
      sku: texto(item.seller_sku) ?? texto(item.seller_custom_field),
      qtd, valorUnit, faturamento: Math.round(valorUnit * qtd * 100) / 100,
      saleFeeUnitario: saleFee,
    });
  }
  return out;
}

export async function lerPaginaTabelaML(
  entrada: { userId: string; lojaId: string; de: string; ate: string; visao: VisaoTabelaML; cursor: CursorTabelaML | null },
  deps: { cliente: SupabaseClient; portas?: PortasVendasML; financeiro?: DepsFinanceiroLiveML; inicioMs?: number },
): Promise<PaginaTabelaML> {
  const inicioMs = deps.inicioMs ?? Date.now();
  const { userId, lojaId, de, ate, visao } = entrada;
  const { primeiro, ultimo } = diasDeBuscaTabelaML(visao, de, ate);
  const vazia = (erro: string | null, cursor: CursorTabelaML | null = null, buscas = 0): PaginaTabelaML =>
    ({ origem: "PROVIDER", visao, periodo: { de, ate }, linhas: [], proximoCursor: cursor, buscas, custoDisponivel: false, diasTruncados: [], erro });
  if (!DIA.test(de) || !DIA.test(ate) || de > ate) return vazia("periodo_invalido");
  let cursor: CursorTabelaML | null = entrada.cursor ?? { dia: ultimo, offset: 0 };
  if (cursor.dia < primeiro || cursor.dia > ultimo) return vazia("cursor_invalido");

  const leitor = await abrirLeitorPaginasFechamentoML({ userId, lojaId, portas: deps.portas });
  if (!leitor.ok) return vazia(leitor.erro, cursor);

  const brutas: LinhaBrutaML[] = [];
  const pedidosDaPagina = new Map<string, Record<string, unknown>>();   // payload dos pedidos que viraram linha
  const diasTruncados: string[] = [];
  let buscas = 0, erro: string | null = null;
  while (cursor && buscas < MAX_BUSCAS_POR_PAGINA_TABELA_ML && brutas.length < LINHAS_POR_PAGINA_TABELA_ML) {
    const atual: CursorTabelaML = cursor;
    const p = await leitor.ler(atual.dia, atual.offset, "date_desc");
    buscas++;
    if (!p.ok) { erro = p.erro; break; }   // o cursor fica onde estava: a próxima chamada repete esta busca
    for (const o of p.resultados) {
      const ls = linhasDoPedidoML(o, { visao, de, ate, diaDaBusca: atual.dia });
      if (ls.length) { brutas.push(...ls); pedidosDaPagina.set(ls[0].orderId, o); }
    }
    const proximo = atual.offset + p.resultados.length;
    const fimDoDia = p.resultados.length === 0 || (p.total !== null && proximo >= p.total);
    if (!fimDoDia && proximo >= OFFSET_MAXIMO_ML) diasTruncados.push(atual.dia);
    cursor = !fimDoDia && proximo < OFFSET_MAXIMO_ML ? { dia: atual.dia, offset: proximo }
      : atual.dia > primeiro ? { dia: somarDiasNoCalendario(atual.dia, -1), offset: 0 } : null;
  }
  if (erro !== null && brutas.length === 0) return vazia(erro, cursor, buscas);

  // A3.4-C: financeiro live SÓ dos pedidos PAGOS desta página (nunca do período), dentro do prazo da requisição
  const pagos = brutas.filter((l) => l.status === "paid").map((l) => l.orderId);
  const fin = await coletarFinanceiroLiveML({ userId, lojaId, accessToken: leitor.accessToken },
    [...new Set(pagos)].map((id) => pedidosDaPagina.get(id)!), { fetch: deps.portas?.buscar, ...deps.financeiro }, { ate: inicioMs + JANELA_PROVIDER_MS });
  const pedidosPorEnvio = new Map<string, Set<string>>();
  for (const l of brutas) if (l.shippingId) (pedidosPorEnvio.get(l.shippingId) ?? pedidosPorEnvio.set(l.shippingId, new Set()).get(l.shippingId)!).add(l.orderId);

  const mapa = await carregarMapaCustoProduto(deps.cliente, userId, "ML", lojaId);
  const linhas: LinhaTabelaML[] = brutas.map((l) => {
    const f = { pedido: fin.pedidos.get(l.orderId) ?? null, envio: l.shippingId ? fin.envios.get(l.shippingId) ?? null : null };
    const financeiroML = componentesDaLinhaML(l, { ...f, falhas: fin.falhas, envioCompartilhadoNaPagina: (pedidosPorEnvio.get(l.shippingId ?? "")?.size ?? 0) > 1 });
    return { ...l, financeiroML, financeiro: mapa.ok ? financeiroLiveDaLinhaML(l, financeiroML, mapa.mapa, f) : null };
  });
  return { origem: "PROVIDER", visao, periodo: { de, ate }, linhas, proximoCursor: cursor, buscas, custoDisponivel: mapa.ok, diasTruncados, erro };
}
