/**
 * Servico canonico de vendas Shopee — CDS-STABILIZATION S2-D1.
 *
 * ── A regra (provada 12/12 contra o Seller Center, S2-B) ─────────────
 * "Produto Pago", dia em America/Sao_Paulo:
 *   PEDIDOS     = todo pedido com pay_time no dia, em QUALQUER status
 *                 atual (cancelado depois do pagamento continua dentro);
 *   CANCELADOS  = desses, order_status = CANCELLED;
 *   UNIDADES    = Σ quantidade dos itens desses pedidos;
 *   VENDAS      = itens − voucher do vendedor + subsidio Shopee − Pix;
 *   SEM DESC.   = itens − voucher do vendedor − voucher Shopee − moedas;
 * onde, no GRAO correto:
 *   itens            = Σ item (model_discounted_price × quantidade)
 *   voucher vendedor = Σ item  escrow.items.discount_from_voucher_seller
 *   voucher Shopee   = Σ item  escrow.items.discount_from_voucher_shopee
 *   moedas           = Σ item  escrow.items.discount_from_coin
 *   subsidio Shopee  = Σ PEDIDO escrow.order_income.original_shopee_discount
 *   Pix              = Σ PEDIDO escrow.order_income.pix_discount
 * O voucher Shopee e POR ITEM: o campo de pedido (`voucher_from_shopee`)
 * vem zerado em pedido cancelado depois do pagamento e o Seller Center
 * ainda o conta — foi exatamente a diferenca de R$ 2,88 / R$ 1,51 do S2-B.
 *
 * Este arquivo e a UNICA implementacao dessas formulas. O sync so grava
 * componentes; Dashboard/agentes/relatorios so leem o resultado daqui.
 *
 * ── Completude ───────────────────────────────────────────────────────
 * Um total so sai quando a loja/periodo esta COMPLETE (ver
 * `avaliarCompletudeShopee`). Fora disso `metricas = null`.
 *
 * Valores internos em CENTAVOS inteiros: nada de soma de float.
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { inicioDoDiaEmSaoPaulo, somarDiasNoCalendario } from "@/lib/fuso-sao-paulo";
import type {
  Completude, ComponentesVendasShopee, MetricasVendas, ResultadoVendas, ResultadoVendasLoja,
} from "./tipos";

// ── Entradas normalizadas (o que o banco guarda) ─────────────────────

/** Uma linha de `shopee_pedidos` (grao: loja + order_sn). */
export interface PedidoShopeeCanonico {
  lojaId: string;
  orderSn: string;
  orderStatus: string | null;
  /** ISO 8601 (timestamptz). `null` = nunca pago. */
  payTime: string | null;
  updateTime: string;
  detailFetchedAt: string | null;
  escrowFetchedAt: string | null;
  /** O `update_time` do pedido quando o escrow foi lido. */
  escrowUpdateTime: string | null;
  /** NULL = escrow ainda nao obtido. */
  originalShopeeDiscount: number | null;
  pixDiscount: number | null;
}

/** Um item de `pedidos` (grao: item/variacao) de um pedido Shopee. */
export interface ItemShopeeCanonico {
  lojaId: string;
  orderSn: string;
  /** model_discounted_price. */
  precoUnitario: number;
  quantidade: number;
  /** NULL = escrow ainda nao obtido; 0 = obtido e sem desconto. */
  voucherVendedor: number | null;
  voucherShopee: number | null;
  moedas: number | null;
}

/** Uma janela de listagem registrada em `sync_jobs`. */
export interface JanelaListagem {
  lojaId: string;
  campoTempo: "update_time" | "create_time";
  inicio: string;
  fim: string;
  listagemCompleta: boolean | null;
  status: string;
}

// ── Tempo: dia civil de Sao Paulo, sem "-3h" ─────────────────────────

/** [inicio do dia `de`, inicio do dia seguinte a `ate`) em Sao Paulo. */
export function intervaloSaoPaulo(de: string, ate: string): { inicio: Date; fim: Date } {
  const i = inicioDoDiaEmSaoPaulo(de);
  const f = inicioDoDiaEmSaoPaulo(somarDiasNoCalendario(ate, 1));
  if (i === null || f === null || ate < de) throw new Error("periodo_invalido");
  return { inicio: new Date(i), fim: new Date(f) };
}

/**
 * Margem OPERACIONAL de `create_time` (S2-D1.1): quanto antes do dia um
 * backfill por criacao costuma precisar ir para TRAZER os pedidos pagos no
 * dia. Observado no S2-B: maximo 64h em 6.401 pedidos (boleto/Pix).
 *
 * NUNCA E PROVA. A Shopee nao documenta limite entre criacao e pagamento
 * (OBSERVED_MAX != CONTRACTUAL_MAX): um pedido criado em D-30 e pago em D
 * pertence a D. Por isso este valor serve para dimensionar backfill,
 * diagnostico e reconciliacao rapida — e nao participa de
 * `avaliarCompletudeShopee`. Completude so se prova por `update_time`.
 */
export const MARGEM_OPERACIONAL_CREATE_TIME_MS = 7 * 24 * 3600 * 1000;

// ── Calculo (puro) ───────────────────────────────────────────────────

const centavos = (v: number): number => Math.round(v * 100);
const chave = (lojaId: string, orderSn: string) => `${lojaId}|${orderSn}`;

export class ErroGraoShopee extends Error {}

/**
 * As metricas oficiais para um conjunto de pedidos JA filtrado pelo
 * periodo. Exige componentes presentes (nao-nulos): quem chama so deve
 * pedir isto para um conjunto COMPLETE.
 */
export function calcularMetricasShopee(
  pedidos: PedidoShopeeCanonico[],
  itens: ItemShopeeCanonico[],
): { metricas: MetricasVendas; componentes: ComponentesVendasShopee } {
  // Grao de pedido: cada (loja, order_sn) UMA vez. Duplicata e erro de
  // grao — somar de novo inflaria subsidio/Pix e a contagem.
  const porPedido = new Map<string, PedidoShopeeCanonico>();
  for (const p of pedidos) {
    const k = chave(p.lojaId, p.orderSn);
    if (porPedido.has(k)) throw new ErroGraoShopee(`pedido duplicado no grao de pedido: ${k}`);
    if (p.payTime === null) throw new ErroGraoShopee(`pedido sem pay_time no conjunto pago: ${k}`);
    if (p.originalShopeeDiscount === null || p.pixDiscount === null) throw new ErroGraoShopee(`escrow de pedido ausente: ${k}`);
    porPedido.set(k, p);
  }

  let cancelados = 0, subsidio = 0, pix = 0;
  for (const p of porPedido.values()) {
    if (p.orderStatus === "CANCELLED") cancelados++;
    subsidio += centavos(p.originalShopeeDiscount!);   // grao de PEDIDO
    pix += centavos(p.pixDiscount!);                   // grao de PEDIDO
  }

  let unidades = 0, valorItens = 0, vVendedor = 0, vShopee = 0, moedas = 0;
  const comItem = new Set<string>();
  for (const it of itens) {
    const k = chave(it.lojaId, it.orderSn);
    if (!porPedido.has(k)) continue; // item de pedido fora do periodo
    if (it.voucherVendedor === null || it.voucherShopee === null || it.moedas === null) {
      throw new ErroGraoShopee(`escrow de item ausente: ${k}`);
    }
    comItem.add(k);
    unidades += it.quantidade;
    valorItens += Math.round(it.precoUnitario * it.quantidade * 100); // grao de ITEM
    vVendedor += centavos(it.voucherVendedor);                        // grao de ITEM
    vShopee += centavos(it.voucherShopee);                            // grao de ITEM
    moedas += centavos(it.moedas);                                    // grao de ITEM
  }
  for (const k of porPedido.keys()) if (!comItem.has(k)) throw new ErroGraoShopee(`pedido sem itens: ${k}`);

  const reais = (c: number) => c / 100;
  return {
    metricas: {
      pedidos: porPedido.size,
      cancelados,
      unidades,
      vendas: reais(valorItens - vVendedor + subsidio - pix),
      vendasSemDescontosPlataforma: reais(valorItens - vVendedor - vShopee - moedas),
    },
    componentes: {
      itens: reais(valorItens), voucherVendedor: reais(vVendedor), voucherShopee: reais(vShopee),
      moedas: reais(moedas), subsidioShopee: reais(subsidio), descontoPix: reais(pix),
    },
  };
}

/** Pedidos cujo pay_time cai em [inicio, fim). */
export function filtrarPagosNoIntervalo(pedidos: PedidoShopeeCanonico[], inicio: Date, fim: Date): PedidoShopeeCanonico[] {
  const a = inicio.getTime(), b = fim.getTime();
  return pedidos.filter((p) => {
    if (p.payTime === null) return false;
    const t = new Date(p.payTime).getTime();
    return t >= a && t < b;
  });
}

// ── Completude (pura) ────────────────────────────────────────────────

/**
 * WATERMARK DE COBERTURA por `update_time` a partir de `desde` (S2-D1.1).
 *
 * Toma a cadeia de janelas COMPLETAS de `update_time` que comeca numa
 * janela contendo `desde` e segue sem buraco (cada proxima janela comeca
 * dentro do alcance da cadeia). O watermark e o INICIO da ultima janela
 * da cadeia — um passo atras do alcance — ou `null` se nao houver cadeia.
 *
 * Por que o inicio da ultima, e nao o fim:
 *   pressupostos (S2-D2 deve cumprir; documentados no contrato):
 *   (P1) `update_time` muda a cada mudanca de status (docs/CHANGELOG.md
 *        "update_time muda toda vez que o status do pedido muda"); pagar e
 *        mudar de status, logo pay_time <= update_time (0/6.401 no S2-C);
 *   (P2) `get_order_list` por update_time devolve o pedido pelo seu
 *        update_time ATUAL no momento da listagem;
 *   (P3) cada janela termina, no maximo, no instante em que a sua listagem
 *        comecou (nunca cobre futuro), e janelas consecutivas se sobrepoem.
 *   Seja o pedido pago em p, com p no dia, e seja u o seu update_time num
 *   momento em que a cadeia ja processou janelas ate o watermark W. Se o
 *   pedido mudou durante a listagem de uma janela k, o novo update_time cai
 *   na janela k+1 (sobreposta) e e visto ali — exceto se k for a ULTIMA
 *   janela, que ainda nao tem sucessora. Declarar o watermark no inicio da
 *   ultima janela garante que toda mudanca anterior a W foi vista por uma
 *   janela que JA teve sucessora completa. Logo todo pedido com
 *   start(dia) <= p < W esta no corpus (no estado mais recente que a
 *   cadeia viu).
 *
 * Nao ha "D + N dias" aqui: o watermark e o que a cobertura real provou.
 */
export function watermarkUpdateTime(janelas: { inicio: string; fim: string }[], desde: number): number | null {
  const ord = janelas.map((j) => [new Date(j.inicio).getTime(), new Date(j.fim).getTime()] as const)
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let alcance: number | null = null;
  let inicioUltima: number | null = null;
  for (const [a, b] of ord) {
    if (alcance === null) {
      if (a <= desde && b > desde) { alcance = b; inicioUltima = a; }
      continue;
    }
    if (a > alcance) break;               // buraco: a cadeia para aqui
    if (b > alcance) { alcance = b; inicioUltima = a; }
  }
  return inicioUltima;
}

/**
 * COMPLETE para uma loja/periodo [inicio, fim) exige, todas juntas:
 *  1. listagem PROVADA por update_time: watermark (acima) a partir de
 *     `inicio` com W >= fim. Janelas de `create_time` (backfill) NUNCA
 *     provam completude — servem para popular o corpus; sem prova por
 *     update_time o periodo fica PARTIAL, qualquer que seja a margem usada.
 *     Periodo historico sem incremental previo precisa de uma passada de
 *     update_time de `inicio` ate o watermark de sincronizacao atual.
 *  2. detail obtido para todo pedido pago no periodo;
 *  3. escrow ATUAL (lido no update_time vigente) para todo pedido pago, e
 *     componentes de item presentes.
 * FAILED: a listagem nao esta provada e alguma janela do periodo terminou
 * em erro. PARTIAL: qualquer outra falta.
 */
export function avaliarCompletudeShopee(args: {
  inicio: Date; fim: Date;
  janelas: JanelaListagem[];
  pedidosPagos: PedidoShopeeCanonico[];
  itens: ItemShopeeCanonico[];
}): { completude: Completude; motivos: string[]; watermark: string | null } {
  const { inicio, fim, janelas, pedidosPagos, itens } = args;
  const a = inicio.getTime(), b = fim.getTime();
  const completas = janelas.filter((j) => j.listagemCompleta === true);
  const w = watermarkUpdateTime(completas.filter((j) => j.campoTempo === "update_time"), a);
  const porUpdate = w !== null && w >= b;
  const watermark = w === null ? null : new Date(w).toISOString();
  const motivos: string[] = [];
  if (!porUpdate) {
    motivos.push("listagem_nao_provada_por_update_time");
    // diagnostico apenas: create_time pode ter populado, mas nao prova nada
    if (completas.some((j) => j.campoTempo === "create_time" && new Date(j.fim).getTime() > a && new Date(j.inicio).getTime() < b)) {
      motivos.push("so_create_time_sem_prova");
    }
  }

  const itensPorPedido = new Map<string, ItemShopeeCanonico[]>();
  for (const it of itens) { const k = chave(it.lojaId, it.orderSn); (itensPorPedido.get(k) ?? itensPorPedido.set(k, []).get(k)!).push(it); }
  let semDetalhe = 0, semEscrow = 0, semItens = 0;
  for (const p of pedidosPagos) {
    if (!p.detailFetchedAt) semDetalhe++;
    const escrowAtual = p.escrowFetchedAt !== null && p.escrowUpdateTime !== null
      && new Date(p.escrowUpdateTime).getTime() === new Date(p.updateTime).getTime()
      && p.originalShopeeDiscount !== null && p.pixDiscount !== null;
    const its = itensPorPedido.get(chave(p.lojaId, p.orderSn)) ?? [];
    if (its.length === 0) semItens++;
    const itensOk = its.every((i) => i.voucherVendedor !== null && i.voucherShopee !== null && i.moedas !== null);
    if (!escrowAtual || !itensOk) semEscrow++;
  }
  if (semDetalhe) motivos.push(`detalhe_ausente:${semDetalhe}`);
  if (semItens) motivos.push(`pedido_sem_itens:${semItens}`);
  if (semEscrow) motivos.push(`escrow_ausente_ou_desatualizado:${semEscrow}`);

  if (motivos.length === 0) return { completude: "COMPLETE", motivos, watermark };
  const falhou = !porUpdate && janelas.some((j) =>
    j.status === "erro" && new Date(j.fim).getTime() > a && new Date(j.inicio).getTime() < b);
  return { completude: falhou ? "FAILED" : "PARTIAL", motivos, watermark };
}

// ── Leitura do banco (server-side, dono SEMPRE explicito) ────────────

const PAGINA = 1000;
const LOTE_IN = 150;

async function paginar<T>(consulta: (de: number, ate: number) => PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  const out: T[] = [];
  for (let de = 0; ; de += PAGINA) {
    const { data, error } = await consulta(de, de + PAGINA - 1);
    if (error) throw new Error("leitura_falhou");
    const lote = (data ?? []) as T[];
    out.push(...lote);
    if (lote.length < PAGINA) return out;
  }
}

/**
 * Vendas canonicas Shopee de um usuario, por loja e no total, para o
 * periodo [de, ate] (dias de Sao Paulo, inclusivos).
 *
 * `lojaIds` omitido = todas as lojas Shopee do usuario. Loja pedida que nao
 * seja do usuario → erro (nunca "zero"). Toda consulta leva `user_id`.
 */
export async function lerVendasShopee(
  cliente: SupabaseClient,
  args: { userId: string; de: string; ate: string; lojaIds?: string[] },
): Promise<ResultadoVendas> {
  const { userId, de, ate } = args;
  if (!userId) throw new Error("user_id_ausente");
  const { inicio, fim } = intervaloSaoPaulo(de, ate);

  let consultaLojas = cliente.from("lojas").select("id").eq("user_id", userId).eq("marketplace", "Shopee");
  if (args.lojaIds) consultaLojas = consultaLojas.in("id", args.lojaIds);
  const { data: lojas, error: errLojas } = await consultaLojas;
  if (errLojas) throw new Error("leitura_falhou");
  const lojaIds = ((lojas ?? []) as { id: string }[]).map((l) => l.id);
  if (args.lojaIds && args.lojaIds.some((id) => !lojaIds.includes(id))) throw new Error("loja_invalida");

  const resultados: ResultadoVendasLoja[] = [];
  for (const lojaId of lojaIds) {
    const linhas = await paginar<Record<string, unknown>>((a, b) => cliente
      .from("shopee_pedidos")
      .select("loja_id, order_sn, order_status, pay_time, update_time, detail_fetched_at, escrow_fetched_at, escrow_update_time, original_shopee_discount, pix_discount")
      .eq("user_id", userId).eq("loja_id", lojaId)
      .gte("pay_time", inicio.toISOString()).lt("pay_time", fim.toISOString())
      .order("order_sn", { ascending: true }).range(a, b));
    const pedidos: PedidoShopeeCanonico[] = linhas.map((r) => ({
      lojaId: String(r.loja_id), orderSn: String(r.order_sn), orderStatus: (r.order_status as string) ?? null,
      payTime: (r.pay_time as string) ?? null, updateTime: String(r.update_time),
      detailFetchedAt: (r.detail_fetched_at as string) ?? null, escrowFetchedAt: (r.escrow_fetched_at as string) ?? null,
      escrowUpdateTime: (r.escrow_update_time as string) ?? null,
      originalShopeeDiscount: r.original_shopee_discount === null ? null : Number(r.original_shopee_discount),
      pixDiscount: r.pix_discount === null ? null : Number(r.pix_discount),
    }));

    const itens: ItemShopeeCanonico[] = [];
    const sns = pedidos.map((p) => p.orderSn);
    for (let i = 0; i < sns.length; i += LOTE_IN) {
      const { data, error } = await cliente.from("pedidos")
        .select("order_id, qtd, valor_unit, escrow_voucher_seller, escrow_voucher_shopee, escrow_coin")
        .eq("user_id", userId).eq("marketplace", "Shopee").eq("loja_id", lojaId)
        .in("order_id", sns.slice(i, i + LOTE_IN));
      if (error) throw new Error("leitura_falhou");
      for (const r of (data ?? []) as Record<string, unknown>[]) itens.push({
        lojaId, orderSn: String(r.order_id), precoUnitario: Number(r.valor_unit), quantidade: Number(r.qtd),
        voucherVendedor: r.escrow_voucher_seller === null ? null : Number(r.escrow_voucher_seller),
        voucherShopee: r.escrow_voucher_shopee === null ? null : Number(r.escrow_voucher_shopee),
        moedas: r.escrow_coin === null ? null : Number(r.escrow_coin),
      });
    }

    const { data: jobs, error: errJobs } = await cliente.from("sync_jobs")
      .select("loja_id, campo_tempo, janela_inicio, janela_fim, listagem_completa, status")
      .eq("user_id", userId).eq("loja_id", lojaId).eq("marketplace", "Shopee")
      .not("janela_inicio", "is", null)
      // Sem limite superior: o watermark depende das janelas POSTERIORES ao
      // periodo (a sucessora da ultima). Sem margem de create_time: ela nao
      // prova nada (S2-D1.1).
      .gt("janela_fim", inicio.toISOString());
    if (errJobs) throw new Error("leitura_falhou");
    const janelas: JanelaListagem[] = ((jobs ?? []) as Record<string, unknown>[]).map((j) => ({
      lojaId, campoTempo: j.campo_tempo as JanelaListagem["campoTempo"],
      inicio: String(j.janela_inicio), fim: String(j.janela_fim),
      listagemCompleta: (j.listagem_completa as boolean | null) ?? null, status: String(j.status),
    }));

    const { completude, motivos } = avaliarCompletudeShopee({ inicio, fim, janelas, pedidosPagos: pedidos, itens });
    if (completude !== "COMPLETE") {
      resultados.push({ lojaId, completude, motivos, metricas: null, componentes: null });
      continue;
    }
    const { metricas, componentes } = calcularMetricasShopee(pedidos, itens);
    resultados.push({ lojaId, completude, motivos, metricas, componentes });
  }

  const completude: Completude = resultados.every((r) => r.completude === "COMPLETE")
    ? "COMPLETE" : resultados.some((r) => r.completude === "FAILED") ? "FAILED" : "PARTIAL";
  const total = completude === "COMPLETE" ? somarMetricas(resultados.map((r) => r.metricas!)) : null;
  return { marketplace: "Shopee", periodo: { de, ate, fuso: "America/Sao_Paulo" }, completude, lojas: resultados, total };
}

/** Soma por loja — lojas sao conjuntos disjuntos (PK inclui loja_id). */
export function somarMetricas(ms: MetricasVendas[]): MetricasVendas {
  const c = (f: (m: MetricasVendas) => number) => ms.reduce((s, m) => s + Math.round(f(m) * 100), 0) / 100;
  return {
    pedidos: ms.reduce((s, m) => s + m.pedidos, 0),
    cancelados: ms.reduce((s, m) => s + m.cancelados, 0),
    unidades: ms.reduce((s, m) => s + m.unidades, 0),
    vendas: c((m) => m.vendas),
    vendasSemDescontosPlataforma: c((m) => m.vendasSemDescontosPlataforma),
  };
}
