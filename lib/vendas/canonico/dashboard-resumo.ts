/**
 * D16 (Dashboard first) — resumo canonico dos 4 cards principais do Dashboard:
 * Faturamento, Pedidos, Unidades e Ticket Medio.
 *
 * Fonte UNICA: consultarVendasCanonicas (owner-scoped, so leitura, nunca sync).
 * Faturamento = `vendas` canonico; Ticket = faturamento / pedidos (calculado
 * aqui, no servidor — o frontend nao repete formula). Sem metricas canonicas
 * (INCOMPLETE / sem observacao) → `metricas: null`: nunca um zero inventado,
 * nunca fallback para o legado `pedidos`.
 *
 * Nada aqui chama provider, cria sync_job ou toca o pipeline de sync.
 */
import {
  consultarVendasCanonicas, ErroVendasCanonicas,
  type DependenciasConsultaVendas, type EstadoConsulta, type MarketplaceConsulta, type ResultadoVendasCanonicas,
} from "./service";

export interface FiltroResumoDashboard {
  marketplace: MarketplaceConsulta;
  lojaId: string | null;
  /** MULTI-LOJA: as lojas selecionadas (2+); null = uma loja (`lojaId`) ou todas. */
  lojaIds?: string[] | null;
  /** Dia civil America/Sao_Paulo (AAAA-MM-DD), inclusivo. */
  de: string;
  /** Dia civil America/Sao_Paulo (AAAA-MM-DD), inclusivo. */
  ate: string;
}

export interface MetricasResumoDashboard { faturamento: number; pedidos: number; unidades: number; ticket: number }
/** ETAPA 2A: um dia do grafico — as MESMAS metricas dos cards, por dia (faturamento = `vendas` canonico). */
export interface DiaResumoDashboard { dia: string; faturamento: number; pedidos: number; unidades: number }
/** ETAPA 2A: total de cada marketplace da selecao (null = marketplace fora da selecao ou sem metrica). */
export interface MarketplaceResumoDashboard { faturamento: number; pedidos: number; unidades: number }

export interface ResumoVendasDashboard {
  /** Estado canonico, ou SEM_LOJA_NO_ESCOPO quando o dono nao tem loja no filtro. */
  estado: EstadoConsulta | "SEM_LOJA_NO_ESCOPO";
  completo: boolean;
  parcial: boolean;
  /** Fim do prefixo comprovado do dia corrente (ISO), quando o periodo inclui hoje. */
  observadoAte: string | null;
  periodo: { de: string; ate: string };
  metricas: MetricasResumoDashboard | null;
  /** ETAPA 2A: serie diaria (soma = metricas); null quando nao ha metricas. */
  serie: DiaResumoDashboard[] | null;
  /** ETAPA 2A: separacao por marketplace, da MESMA consulta (null sem metricas). */
  porMarketplace: { mercadoLivre: MarketplaceResumoDashboard | null; shopee: MarketplaceResumoDashboard | null } | null;
}

const MARKETPLACES: readonly MarketplaceConsulta[] = ["mercado_livre", "shopee", "todos"];
const DIA = /^\d{4}-\d{2}-\d{2}$/;
const ID_LOJA = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Le e valida os parametros da rota. null = parametro invalido (400). */
export function lerFiltroResumoDashboard(p: URLSearchParams): FiltroResumoDashboard | null {
  const marketplace = (p.get("marketplace") ?? "todos") as MarketplaceConsulta;
  const de = p.get("de") ?? "", ate = p.get("ate") ?? "";
  const loja = p.get("loja_id");
  const lojas = p.get("loja_ids");
  if (!MARKETPLACES.includes(marketplace) || !DIA.test(de) || !DIA.test(ate)) return null;
  if (loja !== null && loja.trim() === "") return null;
  // MULTI-LOJA: `loja_ids=a,b` — vazio, item vazio/malformado ou junto com loja_id é 400 (nunca vira "todas")
  if (lojas !== null) {
    const ids = lojas.split(",").map((x) => x.trim());
    if (loja !== null || ids.length === 0 || ids.some((x) => !ID_LOJA.test(x))) return null;
    return { marketplace, lojaId: null, lojaIds: [...new Set(ids)], de, ate };
  }
  return { marketplace, lojaId: loja, lojaIds: null, de, ate };
}

const mkt = (m: { pedidos: number; unidades: number; vendas: number } | null): MarketplaceResumoDashboard | null =>
  m ? { faturamento: m.vendas, pedidos: m.pedidos, unidades: m.unidades } : null;

/** Projeta o resultado canonico SO nos campos que o Dashboard usa (4 cards, grafico diario, separacao por marketplace). */
export function resumoParaDashboard(r: ResultadoVendasCanonicas): ResumoVendasDashboard {
  const c = r.metricas.combinadas;
  return {
    estado: r.estado, completo: r.completo, parcial: r.parcial, observadoAte: r.observadoAte,
    periodo: { de: r.periodo.de, ate: r.periodo.ate },
    metricas: c ? { faturamento: c.vendas, pedidos: c.pedidos, unidades: c.unidades, ticket: c.pedidos > 0 ? c.vendas / c.pedidos : 0 } : null,
    serie: c && r.serieDiaria ? r.serieDiaria.map((d) => ({ dia: d.dia, faturamento: d.vendas, pedidos: d.pedidos, unidades: d.unidades })) : null,
    porMarketplace: c ? { mercadoLivre: mkt(r.metricas.mercadoLivre), shopee: mkt(r.metricas.shopee) } : null,
  };
}

/** Status HTTP de cada erro tipado do servico (nunca expoe detalhe interno). */
export function statusDoErroResumo(e: ErroVendasCanonicas): number {
  switch (e.codigo) {
    case "OWNER_AUSENTE": return 401;
    case "LOJA_FORA_DO_OWNER": return 404;
    case "MARKETPLACE_INVALIDO": case "PERIODO_INVALIDO": return 400;
    case "LEITURA_FALHOU": return 503;
    default: return 500;
  }
}

/** Consulta canonica do dono autenticado → resumo dos 4 cards. */
export async function consultarResumoVendasDashboard(userId: string, f: FiltroResumoDashboard, deps: DependenciasConsultaVendas = {}): Promise<ResumoVendasDashboard> {
  try {
    const r = await consultarVendasCanonicas({ userId, marketplace: f.marketplace, lojaId: f.lojaId, lojaIds: f.lojaIds ?? null, de: f.de, ate: f.ate, serieDiaria: true }, deps);
    return resumoParaDashboard(r);
  } catch (e) {
    // dono sem nenhuma loja do marketplace pedido: estado neutro, sem numero
    if (e instanceof ErroVendasCanonicas && e.codigo === "PERIODO_SEM_COBERTURA") {
      return { estado: "SEM_LOJA_NO_ESCOPO", completo: false, parcial: false, observadoAte: null, periodo: { de: f.de, ate: f.ate }, metricas: null, serie: null, porMarketplace: null };
    }
    throw e;
  }
}
