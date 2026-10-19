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
import { aplicarKeyset, diasDoIntervalo, emParalelo, falhaDeLeitura, intervaloSaoPaulo, lerJanelasSyncJobs, LOJAS_EM_PARALELO, paginarKeyset } from "./shopee";
import { prefixoObservado } from "./periodo";
import type { Completude, DiaObservadoLoja, ParcialObservadoLoja } from "./tipos";

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

/**
 * ETAPA 2A — as MESMAS metricas (calcularMetricasML) por dia civil de Sao Paulo do `date_closed`. Nenhuma formula
 * nova: cada dia e o calculo oficial sobre o SEU subconjunto; os dias sao disjuntos, entao a soma (em centavos) e o total.
 */
export function porDiaML(pedidos: PedidoMLCanonico[]): Record<string, MetricasVendasML> {
  const grupos = new Map<string, PedidoMLCanonico[]>();
  for (const p of pedidos) {
    const dia = diaEmSaoPaulo(p.dateClosed);
    if (dia === null) throw new ErroGraoML(`date_closed_invalido:${p.lojaId}|${p.orderId}`);
    (grupos.get(dia) ?? grupos.set(dia, []).get(dia)!).push(p);
  }
  const out: Record<string, MetricasVendasML> = {};
  for (const [dia, g] of [...grupos].sort((a, b) => a[0].localeCompare(b[0]))) out[dia] = calcularMetricasML(g);
  return out;
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

/**
 * ETAPA 3 — cada dia civil de Sao Paulo de [inicio, fim) avaliado SOZINHO, com as MESMAS funcoes
 * (avaliarCompletudeML / alcanceFechamentoML / calcularMetricasML) e o dia como periodo. Nenhuma regra nova:
 *   COMPLETE do dia → CONFIRMADO; descoberta do dia provada (cadeia date_closed alcanca o fim do dia) e valores
 *   presentes → PROVISORIO (estado ainda nao provado final); senao SEM_DADOS (sem numero).
 */
export function diasObservadosML(inicio: Date, fim: Date, janelas: JanelaFechamentoML[], pedidos: PedidoMLCanonico[]): Record<string, DiaObservadoLoja<MetricasVendasML>> {
  const out: Record<string, DiaObservadoLoja<MetricasVendasML>> = {};
  for (const { dia, inicio: a, fim: b } of diasDoIntervalo(inicio, fim)) {
    const doDia = filtrarFechadosNoIntervalo(pedidos, a, b);
    const av = avaliarCompletudeML({ inicio: a, fim: b, janelas, pedidos: doDia });
    if (av.completude === "COMPLETE") { out[dia] = { estado: "CONFIRMADO", metricas: calcularMetricasML(doDia), motivos: [] }; continue; }
    const alcance = alcanceFechamentoML(janelas, a.getTime());
    const descoberta = alcance !== null && alcance >= b.getTime();
    let metricas: MetricasVendasML | null = null;
    if (descoberta) { try { metricas = calcularMetricasML(doDia); } catch (e) { if (!(e instanceof ErroGraoML)) throw e; } }
    out[dia] = metricas ? { estado: "PROVISORIO", metricas, motivos: av.motivos } : { estado: "SEM_DADOS", metricas: null, motivos: av.motivos };
  }
  return out;
}

// ── Leitura do banco (server-side, dono SEMPRE explicito) ────────────

export interface ResultadoVendasLojaML {
  lojaId: string; completude: Completude; motivos: string[]; metricas: MetricasVendasML | null; estadoEm: string | null;
  /** ETAPA 2A: so com `porDia: true` e so quando COMPLETE. */
  porDia?: Record<string, MetricasVendasML>;
  /** ETAPA 3: so com `observado: true` — cada dia avaliado sozinho (CONFIRMADO / PROVISORIO / SEM_DADOS). */
  observadoPorDia?: Record<string, DiaObservadoLoja<MetricasVendasML>>;
  /** SALES-CANONICAL-D14: so quando o chamador pede `parcial: true`. */
  parcial?: ParcialObservadoLoja<MetricasVendasML>;
}

/**
 * SALES-CANONICAL-D14 — o prefixo OBSERVADO [inicio, observadoAte) de um
 * periodo aberto. observadoAte = alcance da cadeia date_closed (a MESMA de
 * avaliarCompletudeML); avaliado pelas MESMAS funcoes puras. Nenhuma regra nova.
 */
export function parcialObservadoML(inicio: Date, fim: Date, janelas: JanelaFechamentoML[], pedidos: PedidoMLCanonico[], porDia = false, observado = false): ParcialObservadoLoja<MetricasVendasML> {
  const p = prefixoObservado(alcanceFechamentoML(janelas, inicio.getTime()), inicio, fim);
  if (p.estado !== "OBSERVADO_ATE") return { estado: p.estado, observadoAte: null, completude: null, motivos: [], metricas: null };
  const noPrefixo = filtrarFechadosNoIntervalo(pedidos, inicio, p.ate);
  const av = avaliarCompletudeML({ inicio, fim: p.ate, janelas, pedidos: noPrefixo });
  // ETAPA 3: o prefixo e OBSERVADO_ATE = a cadeia de descoberta o cobre; sem prova de estado o valor e so provisorio
  let observadas: MetricasVendasML | null = null;
  if (observado) { try { observadas = calcularMetricasML(noPrefixo); } catch (e) { if (!(e instanceof ErroGraoML)) throw e; } }
  return { estado: p.estado, observadoAte: p.ate.toISOString(), completude: av.completude, motivos: av.motivos,
    metricas: av.completude === "COMPLETE" ? calcularMetricasML(noPrefixo) : null,
    ...(porDia && av.completude === "COMPLETE" ? { porDia: porDiaML(noPrefixo) } : {}),
    ...(observado ? { observadas } : {}) };
}
export interface ResultadoVendasML {
  marketplace: "ML";
  periodo: { de: string; ate: string; fuso: "America/Sao_Paulo" };
  /** COMPLETE so se TODAS as lojas estiverem COMPLETE. */
  completude: Completude;
  lojas: ResultadoVendasLojaML[];
  /** Soma das lojas — `null` se qualquer uma nao estiver COMPLETE. */
  total: MetricasVendasML | null;
}

/**
 * Vendas ML do periodo [de, ate] (datas civis de Sao Paulo) a partir do
 * corpus `ml_pedidos`. Lojas resolvidas DINAMICAMENTE em `lojas` pelo dono
 * (marketplace 'ML'); `lojaIds` restringe e e validado contra o dono.
 */
export async function lerVendasML(
  cliente: SupabaseClient,
  /** `parcial` (D14, padrao false): acrescenta `parcial` por loja; sem ele o resultado e o de sempre. */
  /** `observado` (ETAPA 3, padrao false): acrescenta `observadoPorDia` (e `parcial.observadas`); o resto nao muda. */
  args: { userId: string; de: string; ate: string; lojaIds?: string[]; parcial?: boolean; porDia?: boolean; observado?: boolean },
): Promise<ResultadoVendasML> {
  const { userId, de, ate } = args;
  if (!userId) throw new Error("user_id_ausente");
  const { inicio, fim } = intervaloSaoPaulo(de, ate);

  let consultaLojas = cliente.from("lojas").select("id").eq("user_id", userId).eq("marketplace", "ML");
  if (args.lojaIds) consultaLojas = consultaLojas.in("id", args.lojaIds);
  const { data: lojas, error: errLojas } = await consultaLojas;
  if (errLojas) falhaDeLeitura("ml_lojas", errLojas);
  const lojaIds = ((lojas ?? []) as { id: string }[]).map((l) => l.id);
  if (args.lojaIds && args.lojaIds.some((id) => !lojaIds.includes(id))) throw new Error("loja_invalida");

  // DESEMPENHO: lojas em paralelo (teto), paginas em ondas e janelas junto com os pedidos — mesmos SELECTs, mesma ordem.
  const resultados: ResultadoVendasLojaML[] = await emParalelo(lojaIds, LOJAS_EM_PARALELO, async (lojaId): Promise<ResultadoVendasLojaML> => {
    // KEYSET por (date_closed, order_id) no indice (user_id, loja_id, date_closed): sem OFFSET e sem varrer a PK da loja
    const linhasP = paginarKeyset<Record<string, unknown>>("ml_pedidos", "date_closed", "order_id", (cursor, limite) => aplicarKeyset(cliente.from("ml_pedidos")
      .select("loja_id, order_id, date_closed, cancel_detail_code, total_amount, unidades, fetched_at")
      .eq("user_id", userId).eq("loja_id", lojaId)
      .gte("date_closed", inicio.toISOString()).lt("date_closed", fim.toISOString()), "date_closed", "order_id", cursor, limite));
    // todas as janelas, paginadas (o teto de linhas do PostgREST cortava a leitura unica); a 1a pagina sai ja
    const jobsP = lerJanelasSyncJobs<Record<string, unknown>>("ml_janelas", (apos, limite) => {
      let q = cliente.from("sync_jobs")
        .select("id, campo_tempo, janela_inicio, janela_fim, listagem_completa, status")
        .eq("user_id", userId).eq("loja_id", lojaId).eq("marketplace", "ML")
        .eq("campo_tempo", "date_closed").not("janela_inicio", "is", null);
      if (apos !== null) q = q.gt("id", apos);
      return q.order("id", { ascending: true }).limit(limite);
    });
    jobsP.catch(() => {});   // erro tratado no await abaixo (sem rejeicao solta)
    const linhas = await linhasP;
    const pedidos: PedidoMLCanonico[] = linhas.map((r) => ({
      lojaId: String(r.loja_id), orderId: String(r.order_id), dateClosed: (r.date_closed as string) ?? null,
      cancelCode: (r.cancel_detail_code as string) ?? null,
      totalAmount: r.total_amount === null ? null : Number(r.total_amount),
      unidades: r.unidades === null ? null : Number(r.unidades), fetchedAt: (r.fetched_at as string) ?? null,
    }));
    const jobs = await jobsP;
    const janelas: JanelaFechamentoML[] = jobs.map((j) => ({
      campoTempo: String(j.campo_tempo), inicio: String(j.janela_inicio), fim: String(j.janela_fim),
      listagemCompleta: (j.listagem_completa as boolean | null) ?? null, status: String(j.status),
    }));
    const av = avaliarCompletudeML({ inicio, fim, janelas, pedidos });
    return ({ lojaId, completude: av.completude, motivos: av.motivos, estadoEm: av.estadoEm,
      metricas: av.completude === "COMPLETE" ? calcularMetricasML(pedidos) : null,
      ...(args.porDia === true && av.completude === "COMPLETE" ? { porDia: porDiaML(pedidos) } : {}),
      ...(args.observado === true ? { observadoPorDia: diasObservadosML(inicio, fim, janelas, pedidos) } : {}),
      ...(args.parcial === true ? { parcial: parcialObservadoML(inicio, fim, janelas, pedidos, args.porDia === true, args.observado === true) } : {}) });
  });
  const completude: Completude = resultados.every((r) => r.completude === "COMPLETE")
    ? "COMPLETE" : resultados.some((r) => r.completude === "FAILED") ? "FAILED" : "PARTIAL";
  const total = completude === "COMPLETE" ? somarMetricasML(resultados.map((r) => r.metricas!)) : null;
  return { marketplace: "ML", periodo: { de, ate, fuso: "America/Sao_Paulo" }, completude, lojas: resultados, total };
}
