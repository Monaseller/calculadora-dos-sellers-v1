/**
 * Contrato da consulta canonica de vendas (SALES-CANONICAL-D13) — a fonte
 * UNICA futura de Dashboard e Vendas. Metricas, cobertura e frescor sao
 * dimensoes SEPARADAS e nunca se colapsam:
 *
 *   metricas   so existem quando a cobertura do agregado e COMPLETE
 *              (null = sem cobertura; zero = completo e sem venda).
 *   cobertura  COMPLETE so se TODAS as lojas do escopo forem completas,
 *              ativas e elegiveis. Hoje no periodo → PARTIAL.
 *   frescor    idade da observacao (politica do planejador do sync).
 *   estado     COMPLETE_FRESH | COMPLETE_STALE | PARTIAL | INCOMPLETE.
 */
import type { Completude, ComponentesVendasShopee, MetricasVendas } from "../tipos";
import type { MetricasVendasML } from "../ml";
import type { PeriodoVendasResolvido, PresetPeriodoVendas } from "../periodo";

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
export type EstadoConsulta = "COMPLETE_FRESH" | "COMPLETE_STALE" | "PARTIAL" | "INCOMPLETE";

export interface LojaVendasCanonicas {
  lojaId: string;
  marketplace: MarketplaceLoja;
  ativa: boolean;
  elegibilidade: "ELEGIVEL" | "INRECUPERAVEL_SEM_CREDENCIAL";
  /** Completude devolvida pelo leitor oficial (null = leitor nao devolveu a loja). */
  completudeLeitor: Completude | null;
  cobertura: EstadoCobertura;
  /** Motivos estruturados (servico + leitor). */
  motivos: string[];
  /** So quando a cobertura da loja e COMPLETE. */
  metricas: MetricasVendasML | MetricasVendas | null;
  componentes: ComponentesVendasShopee | null;
  frescor: EstadoFrescor;
  motivosFrescor: string[];
}

export interface ResultadoVendasCanonicas {
  userId: string;
  marketplace: MarketplaceConsulta;
  lojaId: string | null;
  periodo: PeriodoVendasResolvido;
  metricas: {
    /** pedidos/unidades/vendas somados entre os marketplaces consultados (centavo exato). */
    combinadas: MetricasCombinadas | null;
    mercadoLivre: MetricasVendasML | null;
    shopee: MetricasVendas | null;
    /** true = COMPLETE e zero pedidos; false = COMPLETE com venda; null = sem cobertura completa. */
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
}

/** Injecao para teste. Padrao: cliente service_role e relogio real. */
export interface DependenciasConsultaVendas {
  cliente?: any;
  agoraMs?: number;
}
