/**
 * Contrato da consulta canonica de vendas (SALES-CANONICAL-D13/D14) — a
 * fonte UNICA futura de Dashboard e Vendas. Metricas, cobertura e frescor
 * sao dimensoes SEPARADAS e nunca se colapsam:
 *
 *   metricas   COMPLETE: o periodo inteiro; PARTIAL: o acumulado ate
 *              `observadoAte` (parte fechada + parte atual OBSERVADA).
 *              null = sem cobertura/observacao; zero = observado e sem venda.
 *   cobertura  COMPLETE so se TODAS as lojas do escopo forem completas,
 *              ativas e elegiveis. Periodo com hoje → no maximo PARTIAL;
 *              buraco na parte JA FECHADA → INCOMPLETE.
 *   frescor    idade da observacao (politica canonica do sync).
 *   estado     COMPLETE_FRESH | COMPLETE_STALE | PARTIAL_FRESH |
 *              PARTIAL_STALE | PARTIAL_SEM_OBSERVACAO_ATUAL | INCOMPLETE.
 */
import type { Completude, ComponentesVendasShopee, MetricasVendas } from "../tipos";
import type { MetricasVendasML } from "../ml";
import type { PeriodoVendasResolvido, PresetPeriodoVendas } from "../periodo";
import type { PoliticaSync } from "@/lib/vendas/sync/tipos";

export type MarketplaceConsulta = "mercado_livre" | "shopee" | "todos";
export type MarketplaceLoja = Exclude<MarketplaceConsulta, "todos">;

export interface ConsultaVendasCanonicas {
  userId: string;
  marketplace: MarketplaceConsulta;
  lojaId?: string | null;
  /** Ausente = CUSTOM (exige de/ate). */
  preset?: PresetPeriodoVendas;
  de?: string;
  ate?: string;
}

export type CodigoErroVendasCanonicas =
  | "LOJA_FORA_DO_OWNER"
  | "MARKETPLACE_INVALIDO"
  | "PERIODO_INVALIDO"
  | "PERIODO_SEM_COBERTURA"
  | "OWNER_AUSENTE"
  | "LEITURA_FALHOU";

export class ErroVendasCanonicas extends Error {
  constructor(public readonly codigo: CodigoErroVendasCanonicas, public readonly detalhe: string | null = null) {
    super(detalhe ? `${codigo}:${detalhe}` : codigo);
    this.name = "ErroVendasCanonicas";
  }
}

/** O que soma entre marketplaces: cada `vendas` e o numero OFICIAL do painel do seu marketplace. */
export interface MetricasCombinadas { pedidos: number; unidades: number; vendas: number }

export type EstadoCobertura = "COMPLETE" | "PARTIAL" | "INCOMPLETE";
export type EstadoFrescor = "FRESH" | "STALE" | "IN_PROGRESS" | "DESCONHECIDO";
export type EstadoConsulta =
  | "COMPLETE_FRESH" | "COMPLETE_STALE"
  | "PARTIAL_FRESH" | "PARTIAL_STALE" | "PARTIAL_SEM_OBSERVACAO_ATUAL"
  | "INCOMPLETE";

/** D14: a parte ATUAL (hoje) de um periodo aberto, por loja. */
export interface ParteAtualLoja {
  /** OBSERVADA = a cadeia de janelas completas prova o corpus ate `observadoAte` e o prefixo e COMPLETE. */
  estado: "OBSERVADA" | "NAO_OBSERVADA";
  observadoAte: string | null;
  frescor: EstadoFrescor;
  motivos: string[];
}

export interface LojaVendasCanonicas {
  lojaId: string;
  marketplace: MarketplaceLoja;
  ativa: boolean;
  elegibilidade: "ELEGIVEL" | "INRECUPERAVEL_SEM_CREDENCIAL";
  /** Completude devolvida pelo leitor oficial para a parte FECHADA (null = sem parte fechada ou leitor nao devolveu a loja). */
  completudeLeitor: Completude | null;
  cobertura: EstadoCobertura;
  /** Motivos estruturados (servico + leitor). */
  motivos: string[];
  /** COMPLETE: periodo inteiro; PARTIAL: acumulado ate observadoAte; null caso contrario. */
  metricas: MetricasVendasML | MetricasVendas | null;
  /** So em periodo fechado COMPLETE (componentes nao sao somados entre partes). */
  componentes: ComponentesVendasShopee | null;
  frescor: EstadoFrescor;
  motivosFrescor: string[];
  /** D14: null quando o periodo nao contem hoje. */
  parteAtual: ParteAtualLoja | null;
}

/** D14: como o periodo foi dividido — mesmas fronteiras para todos os marketplaces. */
export interface PartesDoPeriodo {
  /** [de, ontem] — null quando o periodo e so hoje. */
  fechada: { de: string; ate: string } | null;
  /** Hoje: [inicioInclusivo, fimExclusivo) — null quando o periodo nao contem hoje. */
  atual: { dia: string; inicioInclusivo: string; fimExclusivo: string } | null;
}

export interface ResultadoVendasCanonicas {
  userId: string;
  marketplace: MarketplaceConsulta;
  lojaId: string | null;
  periodo: PeriodoVendasResolvido;
  partes: PartesDoPeriodo;
  metricas: {
    /** pedidos/unidades/vendas somados entre os marketplaces consultados (centavo exato). */
    combinadas: MetricasCombinadas | null;
    mercadoLivre: MetricasVendasML | null;
    shopee: MetricasVendas | null;
    /** true = coberto/observado e zero pedidos; false = com venda; null = sem metricas. */
    semVendas: boolean | null;
    /** Metricas que NAO foram somadas entre marketplaces, e por que. */
    incompatibilidades: string[];
  };
  cobertura: {
    estado: EstadoCobertura;
    motivos: string[];
    marketplacesConsultados: MarketplaceLoja[];
    /** Selecionados, mas o dono nao tem loja deles (nada a cobrir). */
    marketplacesSemLoja: MarketplaceLoja[];
    lojas: LojaVendasCanonicas[];
  };
  frescor: { estado: EstadoFrescor; motivos: string[] };
  estado: EstadoConsulta;
  /** O periodo contem hoje (nunca COMPLETE no mesmo dia). */
  parcial: boolean;
  /** estado COMPLETE_*. */
  completo: boolean;
  /** frescor FRESH (null quando nao ha metricas). */
  fresco: boolean | null;
  /** D14: o MENOR observadoAte entre as lojas (as metricas valem ate ai). null fora de PARTIAL com metricas. */
  observadoAte: string | null;
}

/** Injecao para teste. Padrao: cliente service_role, relogio real e POLITICA_SYNC_PROPOSTA. */
export interface DependenciasConsultaVendas {
  cliente?: any;
  agoraMs?: number;
  politica?: PoliticaSync;
}
