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
  Completude, ComponentesVendasShopee, MetricasVendas, ParcialObservadoLoja, ResultadoVendas, ResultadoVendasLoja,
} from "./tipos";
import { prefixoObservado } from "./periodo";

// ── Entradas normalizadas (o que o banco guarda) ─────────────────────

/** Uma linha de `shopee_pedidos` (grao: loja + order_sn). */
export interface PedidoShopeeCanonico {
  lojaId: string;
  orderSn: string;
  orderStatus: string | null;
  /** ISO 8601. Usado so pelo sentinela da politica de prazo de pagamento. */
  createTime?: string | null;
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
 * `avaliarCompletudeShopee`. Completude so se prova por descoberta via
 * `create_time` a partir de uma ancora explicita (S2-D3-B2.1).
 */
export const MARGEM_OPERACIONAL_CREATE_TIME_MS = 7 * 24 * 3600 * 1000;

// ── Calculo (puro) ───────────────────────────────────────────────────

const centavos = (v: number): number => Math.round(v * 100);
const chave = (lojaId: string, orderSn: string) => `${lojaId}|${orderSn}`;

export class ErroGraoShopee extends Error {}

/**
 * Regra UNICA de frescor do escrow (S2-D3-A.1), a mesma da coluna gerada
 * `shopee_pedidos.escrow_pendente` e do motor de ingestao: o escrow esta
 * ATUAL quando foi lido (`escrowFetchedAt` e `escrowUpdateTime` presentes)
 * num update_time >= ao update_time vigente do pedido. `>` e atual — nunca
 * gera refetch. So `<` (ou nunca lido) e pendente.
 */
export function escrowShopeeAtual(escrowFetchedAt: string | null, escrowUpdateTime: string | null, updateTime: string): boolean {
  if (escrowFetchedAt === null || escrowUpdateTime === null) return false;
  return new Date(escrowUpdateTime).getTime() >= new Date(updateTime).getTime();
}

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
 * DECISAO ARQUITETURAL (S2-D3-B2.1) — provada em LIVE no S2-D3-B2:
 *
 *   UPDATE_TIME_CAN_PROVE_DISCOVERY_COMPLETE = NO
 *
 * `get_order_list` por `update_time` pagina um conjunto que MUDA durante a
 * paginacao (pedidos atualizados saem da janela) e o cursor e posicional:
 * na run controlada 46 pedidos estaveis foram pulados, 10 deles pagos em
 * 02/10, com zero erro de API, cursor ate o fim e `listagem_completa=true`.
 * Nenhum overlap, janela menor, retry ou "duas passagens iguais" transforma
 * update_time em prova de descoberta — servem so como mitigacao/aceleracao
 * (TWO_EQUAL_PASSES = CONSISTENCY_CHECK; SMALL_WINDOWS = MITIGATION).
 * Janelas de update_time sao IGNORADAS aqui.
 *
 * COMPLETE (loja, periodo [inicio, fim)) = A && B && C:
 *
 *  A. DISCOVERY_COMPLETE — o CORPUS por `create_time` esta completo de
 *     `desde` ate `fim` (ver BASE abaixo). `create_time` e imutavel: numa janela
 *     FECHADA (fim <= inicio da listagem, garantido pelo motor) a populacao
 *     nao muda quando o status muda. Todo pedido pago em [inicio, fim) foi
 *     criado antes de `fim` (create_time <= pay_time) e, por definicao da
 *     ancora, nao antes dela. Prova = cadeia SEM BURACO de janelas de
 *     create_time completas (`listagem_completa` E job `concluido`) que
 *     comeca numa janela contendo a ancora e alcanca `fim`.
 *     BASE (S2-D3-B3), uma de duas, informada em `baseDescoberta`:
 *       ANCORA — `desde` = ancora EXPLICITA e comprovada (inicio do
 *         historico da loja). Prova absoluta.
 *       POLITICA_PRAZO_PAGAMENTO — sem ancora: `desde` = inicio do periodo
 *         − LIMITE_POLITICA_PAGAMENTO_MS. A Shopee publica que pedido nao
 *         pago no prazo e cancelado automaticamente (logo pay_time −
 *         create_time <= prazo). E POLITICA PUBLICADA, nao contrato da API:
 *         um SENTINELA derruba A se qualquer pedido pago do periodo tiver
 *         atraso acima do limite (ou create_time desconhecido). Nao e
 *         heuristica de "D-N dias observados": o limite vem da regra
 *         publicada, com folga, e e verificado a cada consulta.
 *  B. STATE_CURRENT — o estado conhecido e posterior ao fim do periodo:
 *     todo pedido pago no periodo tem detail obtido em >= `fim`, e nenhum
 *     pedido do corpus criado antes de `fim` segue sem pagamento conhecido
 *     com ultima observacao anterior a `fim` (poderia ter sido pago no
 *     periodo). Status so e "final" se estiver em `estadosTerminais`
 *     VERIFICADOS (hoje: nenhum). O resultado informa `estadoEm` (o detail
 *     mais antigo usado): as metricas valem "na data de estadoEm".
 *  C. FINANCIAL_CURRENT — escrow ATUAL (`escrowShopeeAtual`) e
 *     componentes de item presentes para todo pedido pago no periodo.
 *
 * FAILED: A falso e alguma janela de create_time do intervalo necessario
 * terminou em erro. PARTIAL: qualquer outra falta.
 */

/**
 * Alcance da descoberta por `create_time` a partir da ancora: fim da cadeia
 * sem buraco de janelas COMPLETAS de create_time que comeca numa janela
 * contendo a ancora. `null` = sem cadeia. Membership de create_time e
 * imutavel, entao o alcance e o FIM da cadeia (sem "um passo atras").
 *
 * Bordas: a API lista `[time_from, time_to]` com AMBAS as pontas inclusivas
 * (segundos inteiros). A estrategia unica do planner e a BORDA COMPARTILHADA
 * (proxima janela comeca no fim da anterior; dedup por (loja, order_sn)).
 * Por isso a cadeia continua quando `inicio <= alcance`; uma janela que
 * comeca DEPOIS do alcance (mesmo 1 s) e tratada como lacuna — conservador.
 */
export function alcanceDescobertaCriacao(janelas: JanelaListagem[], ancora: number): number | null {
  const ord = janelas
    .filter((j) => j.campoTempo === "create_time" && j.listagemCompleta === true && j.status === "concluido")
    .map((j) => [new Date(j.inicio).getTime(), new Date(j.fim).getTime()] as const)
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let alcance: number | null = null;
  for (const [a, b] of ord) {
    if (alcance === null) { if (a <= ancora && b > ancora) alcance = b; continue; }
    if (a > alcance) break;               // buraco: a cadeia para aqui
    if (b > alcance) alcance = b;
  }
  return alcance;
}

export interface DimensoesCompletude { descoberta: boolean; estado: boolean; financeiro: boolean }
export type BaseDescoberta = "ANCORA" | "POLITICA_PRAZO_PAGAMENTO";

/**
 * Prazo MAXIMO entre criacao e pagamento pela POLITICA PUBLICADA da Shopee
 * Brasil (Central de Ajuda, "Quanto tempo tenho para fazer o pagamento do
 * meu pedido nao pago?" e "Por que meu pedido foi cancelado
 * automaticamente"): boleto = 1 dia util para pagar + processamento de ate
 * 3 dias uteis; Pix = 1h a 24h; cartao = verificacao em ate 24h; nao pago
 * no prazo → cancelado automaticamente. Pior caso: 4 dias uteis; 10 dias
 * corridos cobrem fins de semana + feriados prolongados (ex.: Carnaval).
 * Maior atraso OBSERVADO (S2-B, 6.401 pedidos): 64h.
 */
export const LIMITE_POLITICA_PAGAMENTO_MS = 10 * 24 * 3600 * 1000;

export function avaliarCompletudeShopee(args: {
  inicio: Date; fim: Date;
  janelas: JanelaListagem[];
  /** DISCOVERY_ANCHOR explicita e comprovada; `null` = usa a POLITICA de prazo de pagamento + sentinela. */
  ancoraDescoberta: Date | null;
  pedidosPagos: PedidoShopeeCanonico[];
  itens: ItemShopeeCanonico[];
  /**
   * Pedidos do corpus criados antes de `fim`, sem pay_time, cuja ultima
   * observacao (detail) e anterior a `fim` — e que nao estao num status
   * terminal verificado. Qualquer um deles pode ter sido pago no periodo.
   */
  naoPagosSemObservacaoPosPeriodo: number;
}): { completude: Completude; motivos: string[]; dimensoes: DimensoesCompletude; alcanceDescoberta: string | null; estadoEm: string | null;
  baseDescoberta: BaseDescoberta; descobertaDesde: string } {
  const { inicio, fim, janelas, ancoraDescoberta, pedidosPagos, itens } = args;
  const a = inicio.getTime(), b = fim.getTime();
  const motivos: string[] = [];

  // ── A. descoberta (create_time, desde a ancora OU desde inicio − prazo publicado) ──
  const baseDescoberta: BaseDescoberta = ancoraDescoberta !== null ? "ANCORA" : "POLITICA_PRAZO_PAGAMENTO";
  const desde = ancoraDescoberta !== null ? ancoraDescoberta.getTime() : a - LIMITE_POLITICA_PAGAMENTO_MS;
  const alcance = alcanceDescobertaCriacao(janelas, desde);
  if (alcance === null || alcance < b) motivos.push("descoberta_por_create_time_nao_provada");
  let sentinelaOk = true;
  if (baseDescoberta === "POLITICA_PRAZO_PAGAMENTO") {
    let semCriacao = 0, acima = 0;
    for (const p of pedidosPagos) {
      if (!p.createTime || !p.payTime) { semCriacao++; continue; }
      if (new Date(p.payTime).getTime() - new Date(p.createTime).getTime() > LIMITE_POLITICA_PAGAMENTO_MS) acima++;
    }
    if (semCriacao) motivos.push(`create_time_desconhecido:${semCriacao}`);
    if (acima) motivos.push(`atraso_de_pagamento_acima_da_politica:${acima}`);
    sentinelaOk = semCriacao === 0 && acima === 0;
  }
  const descoberta = alcance !== null && alcance >= b && sentinelaOk;
  // diagnostico: update_time "completo" nao e prova (S2-D3-B2)
  if (!descoberta && janelas.some((j) => j.campoTempo === "update_time" && j.listagemCompleta === true)) {
    motivos.push("update_time_nao_prova_descoberta");
  }

  // ── B. estado ──
  let semDetalhe = 0, observadoAntes = 0; let estadoMin: number | null = null;
  for (const p of pedidosPagos) {
    if (!p.detailFetchedAt) { semDetalhe++; continue; }
    const t = new Date(p.detailFetchedAt).getTime();
    if (!(t >= b)) observadoAntes++;
    if (estadoMin === null || t < estadoMin) estadoMin = t;
  }
  if (semDetalhe) motivos.push(`detalhe_ausente:${semDetalhe}`);
  if (observadoAntes) motivos.push(`estado_observado_antes_do_fim_do_periodo:${observadoAntes}`);
  if (args.naoPagosSemObservacaoPosPeriodo > 0) motivos.push(`nao_pagos_sem_observacao_pos_periodo:${args.naoPagosSemObservacaoPosPeriodo}`);
  const estado = semDetalhe === 0 && observadoAntes === 0 && args.naoPagosSemObservacaoPosPeriodo === 0;

  // ── C. financeiro ──
  const itensPorPedido = new Map<string, ItemShopeeCanonico[]>();
  for (const it of itens) { const k = chave(it.lojaId, it.orderSn); (itensPorPedido.get(k) ?? itensPorPedido.set(k, []).get(k)!).push(it); }
  let semEscrow = 0, semItens = 0;
  for (const p of pedidosPagos) {
    const escrowAtual = escrowShopeeAtual(p.escrowFetchedAt, p.escrowUpdateTime, p.updateTime)
      && p.originalShopeeDiscount !== null && p.pixDiscount !== null;
    const its = itensPorPedido.get(chave(p.lojaId, p.orderSn)) ?? [];
    if (its.length === 0) semItens++;
    const itensOk = its.every((i) => i.voucherVendedor !== null && i.voucherShopee !== null && i.moedas !== null);
    if (!escrowAtual || !itensOk) semEscrow++;
  }
  if (semItens) motivos.push(`pedido_sem_itens:${semItens}`);
  if (semEscrow) motivos.push(`escrow_ausente_ou_desatualizado:${semEscrow}`);
  const financeiro = semItens === 0 && semEscrow === 0;

  const dimensoes = { descoberta, estado, financeiro };
  const alcanceDescoberta = alcance === null ? null : new Date(alcance).toISOString();
  const estadoEm = estadoMin === null ? null : new Date(estadoMin).toISOString();
  const base = { dimensoes, alcanceDescoberta, estadoEm, baseDescoberta, descobertaDesde: new Date(desde).toISOString() };
  if (descoberta && estado && financeiro) return { completude: "COMPLETE", motivos: [], ...base };
  const falhou = !descoberta && janelas.some((j) => j.campoTempo === "create_time" && j.status === "erro"
    && new Date(j.fim).getTime() > desde && new Date(j.inicio).getTime() < b);
  return { completude: falhou ? "FAILED" : "PARTIAL", motivos, ...base };
}

/**
 * Status Shopee VERIFICADOS como terminais (nao mudam mais). Vazio de
 * proposito: nenhum foi verificado contra documentacao/comportamento ainda
 * (COMPLETED nao e assumido final — devolucao pos-entrega; CANCELLED e
 * candidato). Ate la todo pedido nao pago do corpus precisa ser observado
 * depois do fim do periodo.
 */
export const ESTADOS_TERMINAIS_VERIFICADOS: readonly string[] = [];

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
  args: {
    userId: string; de: string; ate: string; lojaIds?: string[];
    /** SALES-CANONICAL-D14 (padrao false): acrescenta `parcial` por loja; sem ele o resultado e o de sempre. */
    parcial?: boolean;
    /**
     * DISCOVERY_ANCHOR por loja (ISO), explicita e comprovada. Ainda nao ha
     * onde persisti-la (proposta de schema no S2-D3-B2.1): sem ela, A e
     * falso e o periodo nunca e COMPLETE.
     */
    ancorasDescoberta?: Record<string, string>;
  },
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
      .select("loja_id, order_sn, order_status, create_time, pay_time, update_time, detail_fetched_at, escrow_fetched_at, escrow_update_time, original_shopee_discount, pix_discount")
      .eq("user_id", userId).eq("loja_id", lojaId)
      .gte("pay_time", inicio.toISOString()).lt("pay_time", fim.toISOString())
      .order("order_sn", { ascending: true }).range(a, b));
    const pedidos: PedidoShopeeCanonico[] = linhas.map((r) => ({
      lojaId: String(r.loja_id), orderSn: String(r.order_sn), orderStatus: (r.order_status as string) ?? null,
      createTime: (r.create_time as string) ?? null,
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

    // So janelas de DESCOBERTA (create_time): update_time nao prova nada.
    // Sem filtro pelo periodo: a cadeia comeca na ancora, bem antes dele.
    const { data: jobs, error: errJobs } = await cliente.from("sync_jobs")
      .select("loja_id, campo_tempo, janela_inicio, janela_fim, listagem_completa, status")
      .eq("user_id", userId).eq("loja_id", lojaId).eq("marketplace", "Shopee")
      .eq("campo_tempo", "create_time").not("janela_inicio", "is", null);
    if (errJobs) throw new Error("leitura_falhou");
    const janelas: JanelaListagem[] = ((jobs ?? []) as Record<string, unknown>[]).map((j) => ({
      lojaId, campoTempo: j.campo_tempo as JanelaListagem["campoTempo"],
      inicio: String(j.janela_inicio), fim: String(j.janela_fim),
      listagemCompleta: (j.listagem_completa as boolean | null) ?? null, status: String(j.status),
    }));

    // B: pedidos do corpus sem pagamento conhecido e sem observacao depois
    // do periodo (poderiam ter sido pagos nele). Nenhum status terminal e
    // presumido (ESTADOS_TERMINAIS_VERIFICADOS).
    const fimIso = fim.toISOString();
    const ancora = args.ancorasDescoberta?.[lojaId];
    // so o corpus que pode conter pagamentos do periodo (mesmo `desde` de A)
    const desdeIso = new Date(ancora ? new Date(ancora).getTime() : inicio.getTime() - LIMITE_POLITICA_PAGAMENTO_MS).toISOString();
    const naoPagos = await contarNaoPagosSemObservacaoShopee(cliente, { userId, lojaId, desdeIso, fimIso });
    const av = avaliarCompletudeShopee({ inicio, fim, janelas, ancoraDescoberta: ancora ? new Date(ancora) : null,
      pedidosPagos: pedidos, itens, naoPagosSemObservacaoPosPeriodo: naoPagos });
    const extra = { dimensoes: av.dimensoes, estadoEm: av.estadoEm, baseDescoberta: av.baseDescoberta, descobertaDesde: av.descobertaDesde,
      ...(args.parcial === true ? { parcial: await parcialObservadoShopee(cliente, { userId, lojaId, inicio, fim, janelas,
        ancora: ancora ? new Date(ancora) : null, desdeIso, pedidos, itens }) } : {}) };
    if (av.completude !== "COMPLETE") {
      resultados.push({ lojaId, completude: av.completude, motivos: av.motivos, metricas: null, componentes: null, ...extra });
      continue;
    }
    const { metricas, componentes } = calcularMetricasShopee(pedidos, itens);
    resultados.push({ lojaId, completude: av.completude, motivos: av.motivos, metricas, componentes, ...extra });
  }

  const completude: Completude = resultados.every((r) => r.completude === "COMPLETE")
    ? "COMPLETE" : resultados.some((r) => r.completude === "FAILED") ? "FAILED" : "PARTIAL";
  const total = completude === "COMPLETE" ? somarMetricas(resultados.map((r) => r.metricas!)) : null;
  return { marketplace: "Shopee", periodo: { de, ate, fuso: "America/Sao_Paulo" }, completude, lojas: resultados, total };
}

/**
 * SALES-CANONICAL-D14 — o prefixo OBSERVADO [inicio, observadoAte) de um
 * periodo aberto. observadoAte = alcance da cadeia create_time (a MESMA de
 * avaliarCompletudeShopee, desde a ancora ou inicio − prazo publicado);
 * avaliado pelas MESMAS funcoes (filtro por pay_time, contagem B ate o
 * corte, completude A/B/C, calcularMetricasShopee). Nenhuma regra nova.
 */
async function parcialObservadoShopee(cliente: SupabaseClient, a: {
  userId: string; lojaId: string; inicio: Date; fim: Date; janelas: JanelaListagem[]; ancora: Date | null; desdeIso: string;
  pedidos: PedidoShopeeCanonico[]; itens: ItemShopeeCanonico[];
}): Promise<ParcialObservadoLoja<MetricasVendas>> {
  const p = prefixoObservado(alcanceDescobertaCriacao(a.janelas, new Date(a.desdeIso).getTime()), a.inicio, a.fim);
  if (p.estado !== "OBSERVADO_ATE") return { estado: p.estado, observadoAte: null, completude: null, motivos: [], metricas: null };
  const pagos = filtrarPagosNoIntervalo(a.pedidos, a.inicio, p.ate);
  const naoPagos = await contarNaoPagosSemObservacaoShopee(cliente, { userId: a.userId, lojaId: a.lojaId, desdeIso: a.desdeIso, fimIso: p.ate.toISOString() });
  const av = avaliarCompletudeShopee({ inicio: a.inicio, fim: p.ate, janelas: a.janelas, ancoraDescoberta: a.ancora,
    pedidosPagos: pagos, itens: a.itens, naoPagosSemObservacaoPosPeriodo: naoPagos });
  return { estado: p.estado, observadoAte: p.ate.toISOString(), completude: av.completude, motivos: av.motivos,
    metricas: av.completude === "COMPLETE" ? calcularMetricasShopee(pagos, a.itens).metricas : null };
}

/**
 * Dimensao B (contagem): pedidos do corpus relevante [desde, fim) sem
 * pagamento conhecido cuja ultima observacao e anterior a `fim`. UMA
 * implementacao — usada pelo leitor canonico e pelo coordenador de sync.
 */
export async function contarNaoPagosSemObservacaoShopee(
  cliente: SupabaseClient, a: { userId: string; lojaId: string; desdeIso: string; fimIso: string },
): Promise<number> {
  let total = 0;
  for (const sem of [false, true]) {
    let q = cliente.from("shopee_pedidos").select("order_sn", { count: "exact", head: true })
      .eq("user_id", a.userId).eq("loja_id", a.lojaId).is("pay_time", null).gte("create_time", a.desdeIso).lt("create_time", a.fimIso);
    q = sem ? q.is("detail_fetched_at", null) : q.lt("detail_fetched_at", a.fimIso);
    if (ESTADOS_TERMINAIS_VERIFICADOS.length) q = q.not("order_status", "in", `(${ESTADOS_TERMINAIS_VERIFICADOS.join(",")})`);
    const { count, error } = await q;
    if (error || count === null || count === undefined) throw new Error("leitura_falhou");
    total += count;
  }
  return total;
}

/** Dimensao C (contagem): pagos no periodo com escrow pendente (coluna gerada escrow_pendente). */
export async function contarEscrowPendenteShopee(
  cliente: SupabaseClient, a: { userId: string; lojaId: string; inicioIso: string; fimIso: string },
): Promise<number> {
  const { count, error } = await cliente.from("shopee_pedidos").select("order_sn", { count: "exact", head: true })
    .eq("user_id", a.userId).eq("loja_id", a.lojaId).eq("escrow_pendente", true).gte("pay_time", a.inicioIso).lt("pay_time", a.fimIso);
  if (error || count === null || count === undefined) throw new Error("leitura_falhou");
  return count;
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
