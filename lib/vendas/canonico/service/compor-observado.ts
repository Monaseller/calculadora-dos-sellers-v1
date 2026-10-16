/**
 * ETAPA 3 — composicao PURA dos valores observados por dia (Dashboard: cards e grafico do MESMO objeto).
 *
 * Nao tem formula: cada dia de cada loja ja vem classificado e calculado pelo PROPRIO leitor
 * (observadoPorDia / parcial); aqui so se escolhe o pior estado do dia entre as lojas e se soma pelo leitor
 * oficial (somarMetricasML, soma de centavos dos campos compativeis). Defesas:
 *   - dia com QUALQUER loja SEM_DADOS fica sem numero (nunca a soma das outras, nunca zero);
 *   - hoje nunca e CONFIRMADO;
 *   - com `combinadas` (a prova do servico) o total observado tem de ser IGUAL a ela, e periodo COMPLETE exige todo
 *     dia CONFIRMADO — senao `null` (nunca um numero que contradiz o card provado).
 */
import { somarMetricasML } from "../ml";
import type { DiaObservadoLoja, EstadoDiaObservado } from "../tipos";
import type {
  DiaObservadoVendas, EstadoConsulta, MarketplaceLoja, MetricasCombinadas, ObservadoVendas, SituacaoObservado,
} from "./tipos";

type M = { pedidos: number; unidades: number; vendas: number };

export interface LojaObservada {
  lojaId: string;
  marketplace: MarketplaceLoja;
  /** Dia → classificacao do leitor. Dia ausente = SEM_DADOS. */
  dias: Record<string, DiaObservadoLoja<M>>;
}

const PESO: Record<EstadoDiaObservado, number> = { CONFIRMADO: 0, PROVISORIO: 1, SEM_DADOS: 2 };
const ZERO: MetricasCombinadas = { pedidos: 0, unidades: 0, vendas: 0 };
const so = (m: M): MetricasCombinadas => ({ pedidos: m.pedidos, unidades: m.unidades, vendas: m.vendas });
const iguais = (a: MetricasCombinadas, b: MetricasCombinadas) => a.pedidos === b.pedidos && a.unidades === b.unidades && a.vendas === b.vendas;

export function comporObservado(a: {
  /** Todo dia civil do periodo, em ordem. */
  dias: string[];
  lojas: LojaObservada[];
  /** O dia de hoje quando o periodo o contem (nunca CONFIRMADO). */
  hoje: string | null;
  /** O menor observadoAte do dia de hoje entre as lojas. */
  observadoAteHoje: string | null;
  estado: EstadoConsulta;
  combinadas: MetricasCombinadas | null;
}): ObservadoVendas | null {
  const dias: DiaObservadoVendas[] = [];
  const incluidos = new Set<string>();
  for (const dia of a.dias) {
    const entradas = a.lojas.map((l) => l.dias[dia] ?? { estado: "SEM_DADOS" as const, metricas: null, motivos: [] });
    let estado: EstadoDiaObservado = entradas.reduce<EstadoDiaObservado>((p, e) => (PESO[e.estado] > PESO[p] ? e.estado : p), "CONFIRMADO");
    if (entradas.some((e) => e.estado !== "SEM_DADOS" && e.metricas === null)) estado = "SEM_DADOS";
    if (dia === a.hoje && estado === "CONFIRMADO") estado = "PROVISORIO";
    const soma = estado === "SEM_DADOS" ? null : somarMetricasML(entradas.map((e) => so(e.metricas!)));
    if (soma) incluidos.add(dia);
    dias.push({ dia, estado, pedidos: soma?.pedidos ?? null, unidades: soma?.unidades ?? null, vendas: soma?.vendas ?? null,
      observadoAte: dia === a.hoje ? a.observadoAteHoje : null });
  }

  const comValor = dias.filter((d) => d.estado !== "SEM_DADOS").map((d) => ({ pedidos: d.pedidos!, unidades: d.unidades!, vendas: d.vendas! }));
  const total = comValor.length ? somarMetricasML(comValor) : null;
  const de = (e: EstadoDiaObservado) => dias.filter((d) => d.estado === e).map((d) => ({ pedidos: d.pedidos!, unidades: d.unidades!, vendas: d.vendas! }));
  const confirmado = somarMetricasML(de("CONFIRMADO")), provisorio = somarMetricasML(de("PROVISORIO"));
  const doMarketplace = (m: MarketplaceLoja): MetricasCombinadas | null => {
    const ls = a.lojas.filter((l) => l.marketplace === m);
    if (!ls.length) return null;
    return somarMetricasML(ls.flatMap((l) => [...incluidos].map((d) => so(l.dias[d].metricas!))));
  };
  const diasSemDados = dias.filter((d) => d.estado === "SEM_DADOS").map((d) => d.dia);
  const completo = a.estado === "COMPLETE_FRESH" || a.estado === "COMPLETE_STALE";

  // defesas: nunca contradizer a prova do servico
  if (completo && dias.some((d) => d.estado !== "CONFIRMADO")) return null;
  if (a.combinadas !== null && (total === null || !iguais(total, a.combinadas))) return null;

  const situacao: SituacaoObservado = total === null ? "SEM_DADOS" : diasSemDados.length ? "INCOMPLETO" : completo ? "CONFIRMADO" : "PROVISORIO";
  return {
    situacao, dias, total, confirmado: total ? confirmado : ZERO, provisorio: total ? provisorio : ZERO,
    porMarketplace: { mercadoLivre: doMarketplace("mercado_livre"), shopee: doMarketplace("shopee") },
    diasConfirmados: dias.filter((d) => d.estado === "CONFIRMADO").length,
    diasProvisorios: dias.filter((d) => d.estado === "PROVISORIO").length,
    diasSemDados,
  };
}
