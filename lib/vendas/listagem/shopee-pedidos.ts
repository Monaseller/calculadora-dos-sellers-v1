/**
 * Etapa 3 / V1 — LISTA canonica de pedidos Shopee, paginada no servidor (so leitura).
 *
 *   fonte      `shopee_pedidos` (grao: loja + order_sn) — o MESMO corpus do Dashboard; itens de `pedidos` (grao item),
 *              agrupados por pedido, numa leitura por loja por pagina (nunca N+1).
 *   recorte    o do Dashboard: pedido com `pay_time` em [inicio do dia `de`, inicio do dia seguinte a `ate`) em
 *              America/Sao_Paulo, em QUALQUER status atual (cancelado depois do pagamento continua dentro).
 *   lojas      `loja_ids` explicitas, cada uma conferida contra as lojas Shopee DO DONO pela capability das vendas
 *              canonicas; ausente = todas as lojas Shopee do dono. Nunca o cookie da TopBar.
 *   ordem      pay_time DESC, loja_id ASC, order_sn ASC — total (order_sn e unico na loja).
 *   pagina     50 PEDIDOS (itens nao contam). Cada loja le no maximo 51 linhas a partir do cursor pelo indice
 *              (user_id, loja_id, pay_time); o merge pega os 50 primeiros na ordem global. Nunca o periodo inteiro.
 *   cursor     keyset (pay_time, loja_id, order_sn) da borda da pagina + `consultaAte` (instante da 1a pagina): pedido
 *              pago depois dele nao entra, entao paginas novas nao empurram as ja vistas. Nada e pulado nem repetido
 *              entre paginas; pedido INSERIDO atras do cursor (historico sendo preenchido) muda o total — a resposta
 *              devolve `dadosAlterados` em vez de esconder.
 *   valores    por pedido, SO pela formula canonica (`calcularMetricasShopee` de um pedido); sem componentes de
 *              escrow = `vendas: null` (pendente), nunca zero.
 *   falha      qualquer leitura com erro, prazo estourado, linha fora do recorte, repetida ou fora de ordem →
 *              `LEITURA_FALHOU` sem nenhum pedido (nunca pagina parcial como se fosse final).
 *
 * Nada aqui grava, sincroniza, cria job, renova token ou chama marketplace.
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listarLojasDoDonoParaVendasCanonicas } from "@/lib/marketplace/credenciais";
import { diaEmSaoPaulo } from "@/lib/fuso-sao-paulo";
import {
  alcanceDescobertaCriacao, calcularMetricasShopee, ErroGraoShopee, escrowShopeeAtual, intervaloSaoPaulo, lerJanelasSyncJobs,
  LIMITE_POLITICA_PAGAMENTO_MS, type ItemShopeeCanonico, type JanelaListagem, type PedidoShopeeCanonico,
} from "@/lib/vendas/canonico/shopee";

export const PEDIDOS_POR_PAGINA = 50;
/** Prazo de TODAS as leituras de uma requisicao. */
export const PRAZO_LEITURA_MS = 20_000;
/** Maior periodo aceito (dias civis, inclusivo). */
export const MAXIMO_DIAS_PERIODO = 400;
/** Teto de linhas de item lidas por loja numa pagina; chegar nele = leitura possivelmente cortada → falha. */
export const TETO_ITENS_POR_LOJA = 1000;

export type CodigoErroListaShopee = "PARAMETRO_INVALIDO" | "CURSOR_INVALIDO" | "LOJA_FORA_DO_OWNER" | "LEITURA_FALHOU";
export class ErroListaVendasShopee extends Error {
  constructor(readonly codigo: CodigoErroListaShopee, readonly detalhe: string | null = null) { super(codigo); }
}

/** Categoria normalizada (todo pedido da lista foi pago; TODOS contam como pedido no Dashboard). */
export type CategoriaPedidoShopee = "VALIDO" | "CANCELADO_APOS_PAGAMENTO" | "EM_CANCELAMENTO" | "DEVOLUCAO" | "DESCONHECIDO";
const STATUS_VALIDOS = new Set(["READY_TO_SHIP", "RETRY_SHIP", "PROCESSED", "SHIPPED", "TO_CONFIRM_RECEIVE", "COMPLETED", "INVOICE_PENDING"]);
export function categoriaPedidoShopee(status: string | null): CategoriaPedidoShopee {
  if (status === "CANCELLED") return "CANCELADO_APOS_PAGAMENTO";
  if (status === "IN_CANCEL") return "EM_CANCELAMENTO";
  if (status === "TO_RETURN") return "DEVOLUCAO";
  return status !== null && STATUS_VALIDOS.has(status) ? "VALIDO" : "DESCONHECIDO";
}

export interface ItemListaShopee { itemId: string | null; variacaoId: string | null; titulo: string; sku: string | null; quantidade: number; precoUnitario: number }

export interface PedidoListaShopee {
  lojaId: string;
  orderSn: string;
  /** ISO (UTC) — a data de referencia do Dashboard. */
  pagoEm: string;
  /** Dia civil de Sao Paulo do pagamento. */
  diaPagamento: string;
  criadoEm: string | null;
  statusOriginal: string | null;
  categoria: CategoriaPedidoShopee;
  itens: ItemListaShopee[];
  /** false = nenhuma linha de item gravada ainda para o pedido (detail pendente): itens/unidades nao sao finais. */
  itensDisponiveis: boolean;
  unidades: number;
  /** `vendas` canonico DESTE pedido; null = componentes de escrow ainda ausentes (pendente, nunca zero). */
  vendas: number | null;
  /** true = escrow lido no update_time vigente do pedido (a mesma regra do Dashboard). */
  financeiroAtual: boolean;
}

export interface CoberturaLojaListaShopee {
  lojaId: string;
  /** Fim (ISO) da cadeia comprovada de descoberta por create_time; null = sem cadeia. */
  descobertaComprovadaAte: string | null;
  /** true = toda venda paga ate `consultaAte` ja foi DESCOBERTA nesta loja (dimensao A do Dashboard). */
  descobertaCompleta: boolean;
}

export interface CursorListaShopee {
  v: 1;
  de: string; ate: string; lojas: string[];
  /** Instante da 1a pagina (ISO): limite superior exclusivo de pay_time em toda a navegacao. */
  ate_consulta: string;
  /** Borda da pagina: pay_time (ISO), loja, order_sn. */
  t: string; l: string; s: string;
  dir: "proximo" | "anterior";
  /** Numero da pagina que este cursor ABRE. */
  pg: number;
  /** Total contado quando o cursor foi emitido (detecta mudanca entre paginas). */
  tot: number;
}

export interface PaginaListaShopee {
  marketplace: "shopee";
  periodo: { de: string; ate: string; fuso: "America/Sao_Paulo"; criterio: "pay_time" };
  lojas: string[];
  consultaAte: string;
  pagina: number;
  tamanhoPagina: number;
  /** Pedidos (nunca linhas de item) do recorte inteiro ate `consultaAte`. */
  total: number;
  totalPaginas: number;
  /** O total mudou desde que o cursor foi emitido (ex.: historico sendo preenchido): numeracao pode ter andado. */
  dadosAlterados: boolean;
  pedidos: PedidoListaShopee[];
  linhasDeItens: number;
  cursores: { proximo: string | null; anterior: string | null };
  /** So na 1a pagina (custa uma leitura de sync_jobs por loja). */
  cobertura: { listaCompleta: boolean; lojas: CoberturaLojaListaShopee[] } | null;
}

export interface EntradaListaShopee {
  userId: string;
  de: string;
  ate: string;
  /** null = todas as lojas Shopee do dono. */
  lojaIds: string[] | null;
  cursor: string | null;
  direcao: "proximo" | "anterior" | null;
}

export interface DepsListaShopee {
  cliente: SupabaseClient;
  agoraMs?: number;
  prazoMs?: number;
  /** Teste: substitui a capability de lojas. */
  listarLojas?: typeof listarLojasDoDonoParaVendasCanonicas;
}

const DIA = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORDER_SN = /^[A-Za-z0-9]{1,64}$/;
const COLUNAS_PEDIDO = "loja_id, order_sn, order_status, create_time, pay_time, update_time, escrow_fetched_at, escrow_update_time, original_shopee_discount, pix_discount";
const COLUNAS_ITEM = "id, loja_id, order_id, ml_item_id, variation_id, anuncio, sku, qtd, valor_unit, escrow_voucher_seller, escrow_voucher_shopee, escrow_coin";

// ── Cursor ────────────────────────────────────────────────────────────

export function codificarCursorListaShopee(c: CursorListaShopee): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

const iso = (v: unknown): string | null => {
  if (typeof v !== "string" || v === "") return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

export function lerCursorListaShopee(texto: string): CursorListaShopee {
  let c: Record<string, unknown>;
  try { c = JSON.parse(Buffer.from(texto, "base64url").toString("utf8")); } catch { throw new ErroListaVendasShopee("CURSOR_INVALIDO"); }
  const ok = c && typeof c === "object" && c.v === 1
    && typeof c.de === "string" && DIA.test(c.de) && typeof c.ate === "string" && DIA.test(c.ate)
    && Array.isArray(c.lojas) && c.lojas.length > 0 && c.lojas.every((x) => typeof x === "string" && UUID.test(x))
    && iso(c.ate_consulta) === c.ate_consulta && iso(c.t) === c.t
    && typeof c.l === "string" && UUID.test(c.l) && typeof c.s === "string" && ORDER_SN.test(c.s)
    && (c.dir === "proximo" || c.dir === "anterior")
    && Number.isSafeInteger(c.pg) && (c.pg as number) >= 1 && Number.isSafeInteger(c.tot) && (c.tot as number) >= 0;
  if (!ok) throw new ErroListaVendasShopee("CURSOR_INVALIDO");
  return c as unknown as CursorListaShopee;
}

// ── Ordem global ──────────────────────────────────────────────────────

interface Chave { t: string; l: string; s: string }
/** < 0: `a` vem ANTES de `b` na lista (pay_time DESC, loja ASC, order_sn ASC). */
export function compararChave(a: Chave, b: Chave): number {
  const ta = Date.parse(a.t), tb = Date.parse(b.t);
  if (ta !== tb) return tb - ta;
  if (a.l !== b.l) return a.l < b.l ? -1 : 1;
  return a.s === b.s ? 0 : a.s < b.s ? -1 : 1;
}

// ── Leitura ───────────────────────────────────────────────────────────

const falhou = (detalhe: string): never => { throw new ErroListaVendasShopee("LEITURA_FALHOU", detalhe); };
const literal = (v: string): string => (/["\\,()]/.test(v) ? falhou("literal_invalido") : `"${v}"`);

function comPrazo<T>(p: PromiseLike<T>, prazo: { ate: number }): Promise<T> {
  const resta = prazo.ate - Date.now();
  if (resta <= 0) return Promise.reject(new ErroListaVendasShopee("LEITURA_FALHOU", "timeout"));
  return new Promise<T>((res, rej) => {
    const id = setTimeout(() => rej(new ErroListaVendasShopee("LEITURA_FALHOU", "timeout")), resta);
    Promise.resolve(p).then((v) => { clearTimeout(id); res(v); }, (e) => { clearTimeout(id); rej(e); });
  });
}

/** Resultado de um SELECT do PostgREST: erro → falha fechado, registrando so a etapa e o codigo do banco. */
function linhas(etapa: string, r: { data: unknown; error: unknown }): Record<string, unknown>[] {
  if (r.error) {
    const codigo = typeof (r.error as { code?: unknown })?.code === "string" ? (r.error as { code: string }).code : "desconhecido";
    console.error(`[vendas-lista-shopee] leitura falhou etapa=${etapa} codigo=${codigo}`);
    falhou(etapa);
  }
  if (!Array.isArray(r.data)) falhou(`${etapa}:sem_dados`);
  return r.data as Record<string, unknown>[];
}

/**
 * Ate `limite` linhas de UMA loja depois (`proximo`) ou antes (`anterior`) da borda, na ordem da direcao. A condicao
 * keyset global, restrita a loja L, vira so pay_time — exceto na loja da borda, onde o order_sn desempata.
 */
function consultaDaLoja(cliente: SupabaseClient, a: {
  userId: string; lojaId: string; inicio: string; limiteSuperior: string; borda: Chave | null; dir: "proximo" | "anterior"; limite: number;
}) {
  let q: any = cliente.from("shopee_pedidos").select(COLUNAS_PEDIDO)
    .eq("user_id", a.userId).eq("loja_id", a.lojaId)
    .gte("pay_time", a.inicio).lt("pay_time", a.limiteSuperior);
  const b = a.borda;
  if (b) {
    if (a.dir === "proximo") {
      if (a.lojaId < b.l) q = q.lt("pay_time", b.t);
      else if (a.lojaId > b.l) q = q.lte("pay_time", b.t);
      else q = q.lte("pay_time", b.t).or(`pay_time.lt.${literal(b.t)},order_sn.gt.${literal(b.s)}`);
    } else {
      if (a.lojaId < b.l) q = q.gte("pay_time", b.t);
      else if (a.lojaId > b.l) q = q.gt("pay_time", b.t);
      else q = q.gte("pay_time", b.t).or(`pay_time.gt.${literal(b.t)},order_sn.lt.${literal(b.s)}`);
    }
  }
  const desc = a.dir === "proximo";
  return q.order("pay_time", { ascending: !desc }).order("order_sn", { ascending: desc }).limit(a.limite);
}

interface LinhaPedido extends Chave { bruto: PedidoShopeeCanonico }

function normalizarPedido(r: Record<string, unknown>, a: { lojaId: string; inicioMs: number; limiteMs: number }): LinhaPedido {
  const t = iso(r.pay_time);
  const sn = typeof r.order_sn === "string" ? r.order_sn : null;
  if (r.loja_id !== a.lojaId || t === null || sn === null || !ORDER_SN.test(sn)) falhou("pedido_fora_do_recorte");
  const ms = Date.parse(t!);
  if (ms < a.inicioMs || ms >= a.limiteMs) falhou("pedido_fora_do_periodo");
  const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  return {
    t: t!, l: a.lojaId, s: sn!,
    bruto: {
      lojaId: a.lojaId, orderSn: sn!, orderStatus: typeof r.order_status === "string" ? r.order_status : null,
      createTime: iso(r.create_time), payTime: t!, updateTime: String(r.update_time ?? ""),
      detailFetchedAt: null, escrowFetchedAt: typeof r.escrow_fetched_at === "string" ? r.escrow_fetched_at : null,
      escrowUpdateTime: typeof r.escrow_update_time === "string" ? r.escrow_update_time : null,
      originalShopeeDiscount: num(r.original_shopee_discount), pixDiscount: num(r.pix_discount),
    },
  };
}

/** Itens dos pedidos de UMA loja na pagina — uma leitura (`in`), conferida (loja, pedido, teto). */
async function itensDaLoja(cliente: SupabaseClient, userId: string, lojaId: string, sns: string[], prazo: { ate: number }) {
  const r = await comPrazo<{ data: unknown; error: unknown }>((cliente.from("pedidos").select(COLUNAS_ITEM) as any)
    .eq("user_id", userId).eq("marketplace", "Shopee").eq("loja_id", lojaId).in("order_id", sns)
    .order("id", { ascending: true }).limit(TETO_ITENS_POR_LOJA), prazo);
  const ls = linhas("itens", r);
  if (ls.length >= TETO_ITENS_POR_LOJA) falhou("itens_teto");
  const pedidos = new Set(sns);
  const porPedido = new Map<string, { item: ItemListaShopee; canonico: ItemShopeeCanonico }[]>();
  for (const x of ls) {
    const sn = String(x.order_id);
    if (x.loja_id !== lojaId || !pedidos.has(sn)) falhou("item_fora_do_recorte");
    const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
    const quantidade = Number(x.qtd), preco = Number(x.valor_unit);
    if (!Number.isFinite(quantidade) || !Number.isFinite(preco)) falhou("item_invalido");
    const texto = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : typeof v === "number" ? String(v) : null);
    (porPedido.get(sn) ?? porPedido.set(sn, []).get(sn)!).push({
      item: { itemId: texto(x.ml_item_id), variacaoId: texto(x.variation_id), titulo: typeof x.anuncio === "string" ? x.anuncio : "", sku: texto(x.sku), quantidade, precoUnitario: preco },
      canonico: { lojaId, orderSn: sn, precoUnitario: preco, quantidade, voucherVendedor: n(x.escrow_voucher_seller), voucherShopee: n(x.escrow_voucher_shopee), moedas: n(x.escrow_coin) },
    });
  }
  return porPedido;
}

async function contarDaLoja(cliente: SupabaseClient, userId: string, lojaId: string, inicio: string, limiteSuperior: string, prazo: { ate: number }): Promise<number> {
  const r = await comPrazo((cliente.from("shopee_pedidos").select("order_sn", { count: "exact", head: true }) as any)
    .eq("user_id", userId).eq("loja_id", lojaId).gte("pay_time", inicio).lt("pay_time", limiteSuperior), prazo) as { count: unknown; error: unknown };
  if (r.error) linhas("contagem", { data: null, error: r.error });
  if (!Number.isSafeInteger(r.count) || (r.count as number) < 0) falhou("contagem_invalida");
  return r.count as number;
}

/** Cobertura de descoberta da loja (dimensao A do Dashboard, base politica de prazo de pagamento). */
async function coberturaDaLoja(cliente: SupabaseClient, userId: string, lojaId: string, inicioMs: number, limiteMs: number, prazo: { ate: number }): Promise<CoberturaLojaListaShopee> {
  let jobs: Record<string, unknown>[];
  try {
    jobs = await comPrazo(lerJanelasSyncJobs<Record<string, unknown>>("lista_shopee_janelas", (apos, limite) => {
      let q: any = cliente.from("sync_jobs").select("id, campo_tempo, janela_inicio, janela_fim, listagem_completa, status")
        .eq("user_id", userId).eq("loja_id", lojaId).eq("marketplace", "Shopee").eq("campo_tempo", "create_time").not("janela_inicio", "is", null);
      if (apos !== null) q = q.gt("id", apos);
      return q.order("id", { ascending: true }).limit(limite);
    }), prazo);
  } catch (e) {
    if (e instanceof ErroListaVendasShopee) throw e;
    return falhou("cobertura");
  }
  const janelas: JanelaListagem[] = jobs.map((j) => ({ lojaId, campoTempo: "create_time", inicio: String(j.janela_inicio), fim: String(j.janela_fim),
    listagemCompleta: (j.listagem_completa as boolean | null) ?? null, status: String(j.status) }));
  const alcance = alcanceDescobertaCriacao(janelas, inicioMs - LIMITE_POLITICA_PAGAMENTO_MS);
  return { lojaId, descobertaComprovadaAte: alcance === null ? null : new Date(alcance).toISOString(), descobertaCompleta: alcance !== null && alcance >= limiteMs };
}

function montarPedido(l: LinhaPedido, itens: { item: ItemListaShopee; canonico: ItemShopeeCanonico }[] | undefined): PedidoListaShopee {
  const p = l.bruto;
  let vendas: number | null = null;
  if (itens?.length) {
    try { vendas = calcularMetricasShopee([p], itens.map((i) => i.canonico)).metricas.vendas; }
    catch (e) { if (!(e instanceof ErroGraoShopee)) throw e; }
  }
  return {
    lojaId: l.l, orderSn: l.s, pagoEm: l.t, diaPagamento: diaEmSaoPaulo(l.t) ?? "", criadoEm: p.createTime ?? null,
    statusOriginal: p.orderStatus, categoria: categoriaPedidoShopee(p.orderStatus),
    itens: (itens ?? []).map((i) => i.item), itensDisponiveis: !!itens?.length,
    unidades: (itens ?? []).reduce((s, i) => s + i.item.quantidade, 0),
    vendas, financeiroAtual: escrowShopeeAtual(p.escrowFetchedAt, p.escrowUpdateTime, p.updateTime),
  };
}

/** Lojas Shopee do dono no escopo pedido (capability; uma loja invalida derruba a consulta inteira). */
async function lojasDoEscopo(userId: string, pedidas: string[] | null, deps: DepsListaShopee, agoraMs: number): Promise<string[]> {
  const listar = deps.listarLojas ?? listarLojasDoDonoParaVendasCanonicas;
  const { linhas: ls, erro } = await listar(userId, deps.cliente, agoraMs);
  if (erro) falhou("lojas");
  const shopee = new Set(ls.filter((l) => l.marketplace === "Shopee").map((l) => l.id));
  if (pedidas === null) return [...shopee].sort();
  for (const id of pedidas) if (!shopee.has(id)) throw new ErroListaVendasShopee("LOJA_FORA_DO_OWNER");
  return [...new Set(pedidas)].sort();
}

export async function listarPedidosShopee(e: EntradaListaShopee, deps: DepsListaShopee): Promise<PaginaListaShopee> {
  const agoraMs = deps.agoraMs ?? Date.now();
  const prazo = { ate: Date.now() + (deps.prazoMs ?? PRAZO_LEITURA_MS) };
  if (!e.userId) throw new ErroListaVendasShopee("PARAMETRO_INVALIDO", "dono");
  if (!DIA.test(e.de) || !DIA.test(e.ate) || e.de > e.ate) throw new ErroListaVendasShopee("PARAMETRO_INVALIDO", "periodo");
  if (e.lojaIds !== null && (e.lojaIds.length === 0 || e.lojaIds.some((x) => !UUID.test(x)))) throw new ErroListaVendasShopee("PARAMETRO_INVALIDO", "loja_ids");
  let periodo: { inicio: Date; fim: Date };
  try { periodo = intervaloSaoPaulo(e.de, e.ate); } catch { throw new ErroListaVendasShopee("PARAMETRO_INVALIDO", "periodo"); }
  if ((periodo.fim.getTime() - periodo.inicio.getTime()) / 86_400_000 > MAXIMO_DIAS_PERIODO + 1) throw new ErroListaVendasShopee("PARAMETRO_INVALIDO", "periodo_longo");
  if ((e.cursor === null) !== (e.direcao === null)) throw new ErroListaVendasShopee("PARAMETRO_INVALIDO", "cursor_direcao");

  let lojas: string[];
  try { lojas = await comPrazo(lojasDoEscopo(e.userId, e.lojaIds, deps, agoraMs), prazo); }
  catch (x) { if (x instanceof ErroListaVendasShopee) throw x; return falhou("lojas"); }

  const cursor = e.cursor === null ? null : lerCursorListaShopee(e.cursor);
  if (cursor) {
    // o cursor so vale para a MESMA consulta (periodo e lojas) que o emitiu
    if (cursor.de !== e.de || cursor.ate !== e.ate || cursor.lojas.join() !== lojas.join() || cursor.dir !== e.direcao || !lojas.includes(cursor.l)) {
      throw new ErroListaVendasShopee("CURSOR_INVALIDO");
    }
  }
  const consultaAte = cursor ? cursor.ate_consulta : new Date(agoraMs).toISOString();
  const limiteMs = Math.min(periodo.fim.getTime(), Date.parse(consultaAte));
  const inicio = periodo.inicio.toISOString(), limiteSuperior = new Date(limiteMs).toISOString();
  const base = {
    marketplace: "shopee" as const, periodo: { de: e.de, ate: e.ate, fuso: "America/Sao_Paulo" as const, criterio: "pay_time" as const },
    lojas, consultaAte, tamanhoPagina: PEDIDOS_POR_PAGINA,
  };
  if (lojas.length === 0 || limiteMs <= periodo.inicio.getTime()) {
    return { ...base, pagina: 1, total: 0, totalPaginas: 0, dadosAlterados: false, pedidos: [], linhasDeItens: 0, cursores: { proximo: null, anterior: null },
      cobertura: lojas.length === 0 ? null : { listaCompleta: false, lojas: [] } };
  }

  const dir = cursor?.dir ?? "proximo";
  const borda: Chave | null = cursor ? { t: cursor.t, l: cursor.l, s: cursor.s } : null;
  let porLoja: LinhaPedido[][];
  let contagens: number[];
  let cobertura: CoberturaLojaListaShopee[] | null;
  try {
    [porLoja, contagens, cobertura] = await Promise.all([
      Promise.all(lojas.map(async (lojaId) => {
        const r = await comPrazo<{ data: unknown; error: unknown }>(consultaDaLoja(deps.cliente, { userId: e.userId, lojaId, inicio, limiteSuperior, borda, dir, limite: PEDIDOS_POR_PAGINA + 1 }), prazo);
        const ls = linhas("pedidos", r).map((x) => normalizarPedido(x, { lojaId, inicioMs: periodo.inicio.getTime(), limiteMs }));
        if (ls.length > PEDIDOS_POR_PAGINA + 1) falhou("pedidos_acima_do_limite");
        // a ordem da loja precisa ser a pedida e estritamente do lado certo da borda (filtro ignorado → falha fechado)
        const sinal = dir === "proximo" ? 1 : -1;
        for (let i = 0; i < ls.length; i++) {
          if (borda && sinal * compararChave(ls[i], borda) <= 0) falhou("pedido_do_lado_errado_da_borda");
          if (i > 0 && sinal * compararChave(ls[i], ls[i - 1]) <= 0) falhou("ordem_instavel");
        }
        return ls;
      })),
      Promise.all(lojas.map((lojaId) => contarDaLoja(deps.cliente, e.userId, lojaId, inicio, limiteSuperior, prazo))),
      cursor ? Promise.resolve(null)
        : Promise.all(lojas.map((lojaId) => coberturaDaLoja(deps.cliente, e.userId, lojaId, periodo.inicio.getTime(), limiteMs, prazo))),
    ]);
  } catch (x) {
    if (x instanceof ErroListaVendasShopee) throw x;
    return falhou("leitura");
  }

  // merge: cada loja trouxe ate 51 na ordem da direcao; os 50 primeiros do merge sao exatamente os da pagina
  const sinal = dir === "proximo" ? 1 : -1;
  // sem repeticao por construcao: cada linha e da SUA loja (normalizarPedido) e cada loja vem em ordem estrita
  const candidatos = porLoja.flat().sort((a, b) => sinal * compararChave(a, b));
  const temMaisNaDirecao = candidatos.length > PEDIDOS_POR_PAGINA;
  let pagina = candidatos.slice(0, PEDIDOS_POR_PAGINA);
  if (dir === "anterior") pagina = pagina.reverse();

  const total = contagens.reduce((s, n) => s + n, 0);
  const numero = cursor ? cursor.pg : 1;
  const totalPaginas = Math.ceil(total / PEDIDOS_POR_PAGINA);
  // pagina "anterior" curta antes da 1a, ou total diferente do emitido: a numeracao andou
  const dadosAlterados = cursor !== null && (cursor.tot !== total || (dir === "anterior" && !temMaisNaDirecao && numero > 1) || (dir === "anterior" && pagina.length < PEDIDOS_POR_PAGINA));

  // itens: uma leitura por loja, so dos pedidos desta pagina
  let itensPorLoja: Map<string, Map<string, { item: ItemListaShopee; canonico: ItemShopeeCanonico }[]>>;
  try {
    const grupos = lojas.map((lojaId) => [lojaId, pagina.filter((p) => p.l === lojaId).map((p) => p.s)] as const).filter(([, sns]) => sns.length > 0);
    itensPorLoja = new Map(await Promise.all(grupos.map(async ([lojaId, sns]) => [lojaId, await itensDaLoja(deps.cliente, e.userId, lojaId, sns, prazo)] as const)));
  } catch (x) {
    if (x instanceof ErroListaVendasShopee) throw x;
    return falhou("itens");
  }
  const pedidos = pagina.map((p) => montarPedido(p, itensPorLoja.get(p.l)?.get(p.s)));

  const emitir = (b: LinhaPedido, d: "proximo" | "anterior", pg: number): string =>
    codificarCursorListaShopee({ v: 1, de: e.de, ate: e.ate, lojas, ate_consulta: consultaAte, t: b.t, l: b.l, s: b.s, dir: d, pg, tot: total });
  const primeira = pagina[0], ultima = pagina[pagina.length - 1];
  const haProxima = dir === "proximo" ? temMaisNaDirecao : true;
  const haAnterior = dir === "proximo" ? cursor !== null : temMaisNaDirecao;
  const numeroFinal = dir === "anterior" && !temMaisNaDirecao ? 1 : numero;
  return {
    ...base, pagina: numeroFinal, total, totalPaginas, dadosAlterados,
    pedidos, linhasDeItens: pedidos.reduce((s, p) => s + p.itens.length, 0),
    cursores: {
      proximo: ultima && haProxima ? emitir(ultima, "proximo", numeroFinal + 1) : null,
      anterior: primeira && haAnterior && numeroFinal > 1 ? emitir(primeira, "anterior", numeroFinal - 1) : null,
    },
    cobertura: cobertura === null ? null : { listaCompleta: cobertura.every((c) => c.descobertaCompleta), lojas: cobertura },
  };
}
