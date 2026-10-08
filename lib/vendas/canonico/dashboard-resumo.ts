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
  /** Dia civil America/Sao_Paulo (AAAA-MM-DD), inclusivo. */
  de: string;
  /** Dia civil America/Sao_Paulo (AAAA-MM-DD), inclusivo. */
  ate: string;
}

export interface MetricasResumoDashboard { faturamento: number; pedidos: number; unidades: number; ticket: number }

export interface ResumoVendasDashboard {
  /** Estado canonico, ou SEM_LOJA_NO_ESCOPO quando o dono nao tem loja no filtro. */
  estado: EstadoConsulta | "SEM_LOJA_NO_ESCOPO";
  completo: boolean;
  parcial: boolean;
  /** Fim do prefixo comprovado do dia corrente (ISO), quando o periodo inclui hoje. */
  observadoAte: string | null;
  periodo: { de: string; ate: string };
  metricas: MetricasResumoDashboard | null;
}

const MARKETPLACES: readonly MarketplaceConsulta[] = ["mercado_livre", "shopee", "todos"];
const DIA = /^\d{4}-\d{2}-\d{2}$/;

/** Le e valida os parametros da rota. null = parametro invalido (400). */
export function lerFiltroResumoDashboard(p: URLSearchParams): FiltroResumoDashboard | null {
  const marketplace = (p.get("marketplace") ?? "todos") as MarketplaceConsulta;
  const de = p.get("de") ?? "", ate = p.get("ate") ?? "";
  const loja = p.get("loja_id");
  if (!MARKETPLACES.includes(marketplace) || !DIA.test(de) || !DIA.test(ate)) return null;
  if (loja !== null && loja.trim() === "") return null;
  return { marketplace, lojaId: loja, de, ate };
}

/** Projeta o resultado canonico SO nos campos que os 4 cards usam. */
export function resumoParaDashboard(r: ResultadoVendasCanonicas): ResumoVendasDashboard {
  const c = r.metricas.combinadas;
  return {
    estado: r.estado, completo: r.completo, parcial: r.parcial, observadoAte: r.observadoAte,
    periodo: { de: r.periodo.de, ate: r.periodo.ate },
    metricas: c ? { faturamento: c.vendas, pedidos: c.pedidos, unidades: c.unidades, ticket: c.pedidos > 0 ? c.vendas / c.pedidos : 0 } : null,
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
    const r = await consultarVendasCanonicas({ userId, marketplace: f.marketplace, lojaId: f.lojaId, de: f.de, ate: f.ate }, deps);
    return resumoParaDashboard(r);
  } catch (e) {
    // dono sem nenhuma loja do marketplace pedido: estado neutro, sem numero
    if (e instanceof ErroVendasCanonicas && e.codigo === "PERIODO_SEM_COBERTURA") {
      return { estado: "SEM_LOJA_NO_ESCOPO", completo: false, parcial: false, observadoAte: null, periodo: { de: f.de, ate: f.ate }, metricas: null };
    }
    throw e;
  }
}
