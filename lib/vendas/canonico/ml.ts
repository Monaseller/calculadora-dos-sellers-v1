/**
 * Servico canonico de vendas Mercado Livre — ML-CORPUS-A.
 *
 * ── A regra (homologada contra o relatorio oficial do ML, F7b.4.8.4) ─
 *   DATA      = `order.date_closed` em America/Sao_Paulo
 *   POPULACAO = todo pedido fechado no periodo, em QUALQUER status,
 *               EXCETO `cancel_detail.code = pack_splitted` (o pacote foi
 *               refeito em outros pedidos — contar os dois duplicaria)
 *   PEDIDOS   = order.id distintos
 *   UNIDADES  = Σ order_items[].quantity
 *   VENDAS    = Σ order.total_amount, UMA vez por pedido
 *
 * Este arquivo e a UNICA implementacao da regra. A leitura LIVE
 * (`buscarVendasBrutasML`, oraculo de homologacao) e a leitura do BANCO
 * (`lerVendasML`, corpus `ml_pedidos`) normalizam com `normalizarPedidoML`
 * e somam com `calcularMetricasML`. Valores somados em CENTAVOS inteiros.
 *
 * ── Grao e corpus ───────────────────────────────────────────────────
 * `ml_pedidos`: uma linha por (loja_id, order_id), com o que a regra exige
 * no grao de PEDIDO (date_closed, cancel_detail_code, total_amount,
 * unidades). `pedidos` (legado) e por ITEM, com id sem loja e sem
 * variacao e `qtd` com default 1 — nao serve para unidades nem guarda
 * date_closed / cancel_detail / total_amount de pedido.
 *
 * ── Completude (COMPLETE | PARTIAL | FAILED) ────────────────────────
 *  A. DESCOBERTA: cadeia sem buraco de janelas de `date_closed` (sync_jobs
 *     campo_tempo='date_closed', listagem_completa E concluido) cobrindo
 *     [inicio, fim). `date_closed` nao muda depois do fechamento: a
 *     populacao de uma janela FECHADA e imutavel — mesma prova que o
 *     create_time da Shopee, sem ancora: o filtro E a data comercial.
 *  B. ESTADO: todo pedido do periodo observado (fetched_at) depois do fim
 *     do periodo (cancel_detail pode mudar depois do fechamento);
 *     `estadoEm` = observacao mais antiga usada.
 *  C. VALORES: total_amount e unidades presentes em todo pedido.
 * FAILED: A falso e alguma janela necessaria terminou em erro.
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { diaEmSaoPaulo } from "@/lib/fuso-sao-paulo";
import { intervaloSaoPaulo } from "./shopee";
import type { Completude } from "./tipos";

/** O UNICO cancelamento que tira o pedido da venda bruta. */
export const CANCELAMENTO_DE_PACOTE_REFEITO = "pack_splitted";

const centavos = (v: number): number => Math.round(v * 100);
const numeroOuZero = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

// ── Normalizacao (pura): order da API → pedido canonico ──────────────

export interface PedidoMLNormalizado {
  readonly pedidoId: string;
  /** `order.date_closed` em ISO UTC; `null` se ausente/invalido. */
  readonly dateClosed: string | null;
  /** `AAAA-MM-DD` em America/Sao_Paulo — o dia do FECHAMENTO. */
  readonly diaFechamento: string | null;
  /** `order.total_amount`, como a API devolveu. */
  readonly valor: number;
  /** Σ `order_items[].quantity`. */
  readonly unidades: number;
  readonly status: string;
  readonly cancelCode: string | null;
  /** Σ unit_price × quantity — invariante de observabilidade (nao e o valor). */
  readonly valorPorItens: number;
}

/** O codigo de cancelamento, quando ha. */
export function codigoDeCancelamentoML(pedido: Record<string, unknown>): string | null {
  const detalhe = pedido.cancel_detail;
  if (typeof detalhe !== "object" || detalhe === null) return null;
  const codigo = (detalhe as Record<string, unknown>).code;
  return typeof codigo === "string" && codigo !== "" ? codigo : null;
}

export function normalizarPedidoML(o: Record<string, unknown>): PedidoMLNormalizado {
  const itens = Array.isArray(o.order_items) ? o.order_items : [];
  let unidades = 0, porItens = 0;
  for (const bruto of itens) {
    if (typeof bruto !== "object" || bruto === null) continue;
    const item = bruto as Record<string, unknown>;
    const qtd = numeroOuZero(item.quantity);
    unidades += qtd;
    porItens += numeroOuZero(item.unit_price) * qtd;
  }
  const t = typeof o.date_closed === "string" ? Date.parse(o.date_closed) : NaN;
  return {
    pedidoId: String(o.id ?? ""),
    dateClosed: Number.isFinite(t) ? new Date(t).toISOString() : null,
    diaFechamento: diaEmSaoPaulo(o.date_closed),
    valor: numeroOuZero(o.total_amount),
    unidades,
    status: typeof o.status === "string" ? o.status : "",
    cancelCode: codigoDeCancelamentoML(o),
    valorPorItens: porItens,
  };
}

/** Entra na venda bruta? (so `pack_splitted` sai). */
export function pedidoMLContaNaVenda(p: { cancelCode: string | null }): boolean {
  return p.cancelCode !== CANCELAMENTO_DE_PACOTE_REFEITO;
}

// ── Calculo (puro) ───────────────────────────────────────────────────

/** Uma linha de `ml_pedidos` (grao: loja + order_id). */
export interface PedidoMLCanonico {
  lojaId: string;
  orderId: string;
  /** ISO 8601 (timestamptz). */
  dateClosed: string | null;
  cancelCode: string | null;
  /** NULL = nao obtido. */
  totalAmount: number | null;
  unidades: number | null;
  fetchedAt: string | null;
}

export interface MetricasVendasML { pedidos: number; unidades: number; vendas: number }

export class ErroGraoML extends Error {}

/**
 * Metricas de um conjunto JA filtrado pelo periodo. Exclui `pack_splitted`.
 * Exige valores presentes: quem chama so pede isto para um conjunto
 * COMPLETE (ou para o oraculo live, que sempre tem valor).
 */
export function calcularMetricasML(pedidos: PedidoMLCanonico[]): MetricasVendasML {
  const vistos = new Set<string>();
  let n = 0, unidades = 0, vendas = 0;
  for (const p of pedidos) {
    const k = `${p.lojaId}|${p.orderId}`;
    if (vistos.has(k)) throw new ErroGraoML(`pedido_duplicado:${k}`);
    vistos.add(k);
    if (!pedidoMLContaNaVenda(p)) continue;
    if (p.totalAmount === null || p.unidades === null) throw new ErroGraoML(`valor_ausente:${k}`);
    n++; unidades += p.unidades; vendas += centavos(p.totalAmount);
  }
  return { pedidos: n, unidades, vendas: vendas / 100 };
}

/** Fechados em [inicio, fim) — o mesmo recorte do dia de Sao Paulo. */
export function filtrarFechadosNoIntervalo(pedidos: PedidoMLCanonico[], inicio: Date, fim: Date): PedidoMLCanonico[] {
  const a = inicio.getTime(), b = fim.getTime();
  return pedidos.filter((p) => {
    if (p.dateClosed === null) return false;
    const t = new Date(p.dateClosed).getTime();
    return t >= a && t < b;
  });
}

/** Soma por loja — lojas sao conjuntos disjuntos (PK inclui loja_id). */
export function somarMetricasML(ms: MetricasVendasML[]): MetricasVendasML {
  return { pedidos: ms.reduce((s, m) => s + m.pedidos, 0), unidades: ms.reduce((s, m) => s + m.unidades, 0),
    vendas: ms.reduce((s, m) => s + centavos(m.vendas), 0) / 100 };
}

// ── Completude (pura) ────────────────────────────────────────────────

export interface JanelaFechamentoML { campoTempo: string; inicio: string; fim: string; listagemCompleta: boolean | null; status: string }

/** Fim da cadeia sem buraco de janelas COMPLETAS de date_closed que comeca numa janela contendo `desde`. */
export function alcanceFechamentoML(janelas: JanelaFechamentoML[], desde: number): number | null {
  const ord = janelas.filter((j) => j.campoTempo === "date_closed" && j.listagemCompleta === true && j.status === "concluido")
    .map((j) => [new Date(j.inicio).getTime(), new Date(j.fim).getTime()] as const)
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let alcance: number | null = null;
  for (const [a, b] of ord) {
    if (alcance === null) { if (a <= desde && b > desde) alcance = b; continue; }
    if (a > alcance) break;
    if (b > alcance) alcance = b;
  }
  return alcance;
}

export function avaliarCompletudeML(args: { inicio: Date; fim: Date; janelas: JanelaFechamentoML[]; pedidos: PedidoMLCanonico[] }):
  { completude: Completude; motivos: string[]; estadoEm: string | null } {
  const { inicio, fim, janelas, pedidos } = args;
  const a = inicio.getTime(), b = fim.getTime();
  const motivos: string[] = [];
  const alcance = alcanceFechamentoML(janelas, a);
  const descoberta = alcance !== null && alcance >= b;
  if (!descoberta) motivos.push("cobertura_por_date_closed_nao_provada");
  let antes = 0, semObs = 0, semValor = 0; let estadoMin: number | null = null;
  for (const p of pedidos) {
    if (!p.fetchedAt) semObs++;
    else { const t = new Date(p.fetchedAt).getTime(); if (!(t >= b)) antes++; if (estadoMin === null || t < estadoMin) estadoMin = t; }
    if (pedidoMLContaNaVenda(p) && (p.totalAmount === null || p.unidades === null)) semValor++;
  }
  if (semObs) motivos.push(`pedido_sem_observacao:${semObs}`);
  if (antes) motivos.push(`estado_observado_antes_do_fim_do_periodo:${antes}`);
  if (semValor) motivos.push(`valor_ausente:${semValor}`);
  const estadoEm = estadoMin === null ? null : new Date(estadoMin).toISOString();
  if (motivos.length === 0) return { completude: "COMPLETE", motivos, estadoEm };
  const falhou = !descoberta && janelas.some((j) => j.campoTempo === "date_closed" && j.status === "erro"
    && new Date(j.fim).getTime() > a && new Date(j.inicio).getTime() < b);
  return { completude: falhou ? "FAILED" : "PARTIAL", motivos, estadoEm };
}

// ── Leitura do banco (server-side, dono SEMPRE explicito) ────────────

export interface ResultadoVendasLojaML { lojaId: string; completude: Completude; motivos: string[]; metricas: MetricasVendasML | null; estadoEm: string | null }
export interface ResultadoVendasML {
  marketplace: "ML";
  periodo: { de: string; ate: string; fuso: "America/Sao_Paulo" };
  /** COMPLETE so se TODAS as lojas estiverem COMPLETE. */
  completude: Completude;
  lojas: ResultadoVendasLojaML[];
  /** Soma das lojas — `null` se qualquer uma nao estiver COMPLETE. */
  total: MetricasVendasML | null;
}

const PAGINA = 1000;

/**
 * Vendas ML do periodo [de, ate] (datas civis de Sao Paulo) a partir do
 * corpus `ml_pedidos`. Lojas resolvidas DINAMICAMENTE em `lojas` pelo dono
 * (marketplace 'ML'); `lojaIds` restringe e e validado contra o dono.
 */
export async function lerVendasML(
  cliente: SupabaseClient,
  args: { userId: string; de: string; ate: string; lojaIds?: string[] },
): Promise<ResultadoVendasML> {
  const { userId, de, ate } = args;
  if (!userId) throw new Error("user_id_ausente");
  const { inicio, fim } = intervaloSaoPaulo(de, ate);

  let consultaLojas = cliente.from("lojas").select("id").eq("user_id", userId).eq("marketplace", "ML");
  if (args.lojaIds) consultaLojas = consultaLojas.in("id", args.lojaIds);
  const { data: lojas, error: errLojas } = await consultaLojas;
  if (errLojas) throw new Error("leitura_falhou");
  const lojaIds = ((lojas ?? []) as { id: string }[]).map((l) => l.id);
  if (args.lojaIds && args.lojaIds.some((id) => !lojaIds.includes(id))) throw new Error("loja_invalida");

  const resultados: ResultadoVendasLojaML[] = [];
  for (const lojaId of lojaIds) {
    const pedidos: PedidoMLCanonico[] = [];
    for (let deP = 0; ; deP += PAGINA) {
      const { data, error } = await cliente.from("ml_pedidos")
        .select("loja_id, order_id, date_closed, cancel_detail_code, total_amount, unidades, fetched_at")
        .eq("user_id", userId).eq("loja_id", lojaId)
        .gte("date_closed", inicio.toISOString()).lt("date_closed", fim.toISOString())
        .order("order_id", { ascending: true }).range(deP, deP + PAGINA - 1);
      if (error) throw new Error("leitura_falhou");
      const lote = (data ?? []) as Record<string, unknown>[];
      for (const r of lote) pedidos.push({
        lojaId: String(r.loja_id), orderId: String(r.order_id), dateClosed: (r.date_closed as string) ?? null,
        cancelCode: (r.cancel_detail_code as string) ?? null,
        totalAmount: r.total_amount === null ? null : Number(r.total_amount),
        unidades: r.unidades === null ? null : Number(r.unidades), fetchedAt: (r.fetched_at as string) ?? null,
      });
      if (lote.length < PAGINA) break;
    }
    const { data: jobs, error: errJobs } = await cliente.from("sync_jobs")
      .select("campo_tempo, janela_inicio, janela_fim, listagem_completa, status")
      .eq("user_id", userId).eq("loja_id", lojaId).eq("marketplace", "ML")
      .eq("campo_tempo", "date_closed").not("janela_inicio", "is", null);
    if (errJobs) throw new Error("leitura_falhou");
    const janelas: JanelaFechamentoML[] = ((jobs ?? []) as Record<string, unknown>[]).map((j) => ({
      campoTempo: String(j.campo_tempo), inicio: String(j.janela_inicio), fim: String(j.janela_fim),
      listagemCompleta: (j.listagem_completa as boolean | null) ?? null, status: String(j.status),
    }));
    const av = avaliarCompletudeML({ inicio, fim, janelas, pedidos });
    resultados.push({ lojaId, completude: av.completude, motivos: av.motivos, estadoEm: av.estadoEm,
      metricas: av.completude === "COMPLETE" ? calcularMetricasML(pedidos) : null });
  }
  const completude: Completude = resultados.every((r) => r.completude === "COMPLETE")
    ? "COMPLETE" : resultados.some((r) => r.completude === "FAILED") ? "FAILED" : "PARTIAL";
  const total = completude === "COMPLETE" ? somarMetricasML(resultados.map((r) => r.metricas!)) : null;
  return { marketplace: "ML", periodo: { de, ate, fuso: "America/Sao_Paulo" }, completude, lojas: resultados, total };
}
