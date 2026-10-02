/**
 * Vendas AO VIVO — o resumo de HOJE para o painel do Escritorio. F8.2-A.
 *
 * ── Este modulo nao calcula nada ────────────────────────────────────
 *
 * A fonte e `criarLeiturasDeVendasML` (`vendas-ml.ts`) — a MESMA camada
 * deterministica que a Tool `mercadolivre.vendas.consultar` usa: API
 * oficial, `order.date_closed` no fuso de Sao Paulo, `total_amount`, sem
 * `pack_splitted`, ticket medio = o que ela devolve. Aqui so se COPIA o
 * resultado para a forma do painel, e se decide quando NAO ha numero:
 *
 *   erro                         -> "erro"        (sem numero)
 *   completo=false / sem total   -> "incompleto"  (sem numero)
 *   completo=true com total      -> "ok"          (os 4 valores, copiados)
 *
 * Nenhuma loja e somada a outra: cada loja e um bloco. Somar seria
 * criar um total que o runtime nunca calculou.
 *
 * Unica conta deste modulo: a VARIACAO hoje x ontem (`variacao`), sobre
 * dois resultados ja prontos da camada. Ela nao toca a semantica de
 * nenhum dos dois.
 *
 * Sem LLM, sem conversa, sem mensagem: e leitura de dado.
 *
 * Modulo PURO (so `import type`), para a suite poder exercita-lo.
 */
import type { ResultadoVendasML } from "@/lib/agentes/dados/vendas-ml";

/** Os marketplaces que o painel conhece. Shopee entra quando existir. */
export const MARKETPLACES_AO_VIVO = ["mercadolivre", "shopee"] as const;
export type MarketplaceAoVivo = (typeof MARKETPLACES_AO_VIVO)[number];

export interface KpisAoVivo {
  readonly valor: number;
  readonly vendas: number;
  readonly unidades: number;
  readonly ticketMedio: number;
}

/** A variacao de UM KPI entre duas janelas comparaveis. */
export interface VariacaoAoVivo {
  /** hoje - ontem. Monetario em centavos (2 casas). */
  readonly delta: number;
  /** % sobre ontem, 1 casa. `null` quando ontem e zero: nao ha base. */
  readonly pct: number | null;
}

/**
 * HOJE ate agora versus ONTEM ate o MESMO horario — F8.2-B.
 *
 * As duas janelas saem da MESMA camada (`criarLeiturasDeVendasML`) com o
 * MESMO criterio (`date_closed` em Sao Paulo), cada uma cortada no seu
 * instante: agora, e agora - 24h. Comparar com o dia INTEIRO de ontem
 * faria toda manha parecer queda.
 */
export interface ComparativoAoVivo {
  readonly ontem: KpisAoVivo;
  readonly periodoOntem: { readonly de: string; readonly ate: string };
  /**
   * Vendas brutas de hoje como fracao das de ontem no mesmo horario
   * (1 = igual). 3 casas. `null` quando ontem e zero. E o que o medidor
   * desenha — calculado aqui, e nao na tela.
   */
  readonly progressoValor: number | null;
  readonly variacao: {
    readonly valor: VariacaoAoVivo;
    readonly vendas: VariacaoAoVivo;
    readonly unidades: VariacaoAoVivo;
    readonly ticketMedio: VariacaoAoVivo;
  };
}

export type LojaAoVivo =
  | {
      readonly nome: string;
      readonly estado: "ok";
      readonly periodo: { readonly de: string; readonly ate: string };
      readonly kpis: KpisAoVivo;
      /** `null` = a leitura de ontem nao completou: sem comparativo. */
      readonly comparativo: ComparativoAoVivo | null;
    }
  | { readonly nome: string; readonly estado: "incompleto" }
  | { readonly nome: string; readonly estado: "erro" };

export interface MarketplaceDoPainel {
  readonly marketplace: MarketplaceAoVivo;
  /** `false` = o dono nao tem loja ativa deste marketplace. */
  readonly configurado: boolean;
  readonly lojas: readonly LojaAoVivo[];
}

/** O periodo que a camada ML entende como "hoje" (fuso de Sao Paulo). */
export const PERIODO_AO_VIVO = "hoje";
/** E o dia anterior, no mesmo resolvedor. */
export const PERIODO_COMPARADO = "ontem";

/**
 * O corte de ONTEM: o mesmo horario de agora, um dia antes.
 *
 * `agora - 24h` e exatamente "o mesmo horario de ontem" em
 * America/Sao_Paulo porque o fuso nao tem horario de verao desde 2019. Se
 * isso voltar a existir, esta e a UNICA linha que precisa mudar.
 */
export function corteDeOntemMs(agoraMs: number): number {
  return agoraMs - 24 * 60 * 60 * 1000;
}

const centavos = (v: number) => Math.round(v * 100) / 100;

/** Variacao de um KPI. A aritmetica deste painel mora AQUI (e no progresso). */
export function variacao(hoje: number, ontem: number, monetario: boolean): VariacaoAoVivo {
  const bruto = hoje - ontem;
  return {
    delta: monetario ? centavos(bruto) : bruto,
    pct: ontem === 0 ? null : Math.round((bruto / ontem) * 1000) / 10,
  };
}

/** O comparativo, ou `null` se ontem nao tem total confiavel. */
export function comparativoDoResultado(
  hoje: KpisAoVivo, rOntem: ResultadoVendasML
): ComparativoAoVivo | null {
  if (rOntem.erro !== null || rOntem.completo !== true || rOntem.vendasBrutas === null) return null;
  const o = rOntem.vendasBrutas;
  const ontem: KpisAoVivo = {
    valor: o.valor, vendas: o.vendas, unidades: o.unidades, ticketMedio: o.ticketMedio,
  };
  return {
    ontem,
    periodoOntem: { de: rOntem.periodo.de, ate: rOntem.periodo.ate },
    progressoValor: ontem.valor === 0 ? null : Math.round((hoje.valor / ontem.valor) * 1000) / 1000,
    variacao: {
      valor: variacao(hoje.valor, ontem.valor, true),
      vendas: variacao(hoje.vendas, ontem.vendas, false),
      unidades: variacao(hoje.unidades, ontem.unidades, false),
      ticketMedio: variacao(hoje.ticketMedio, ontem.ticketMedio, true),
    },
  };
}

/**
 * Os resultados da camada ML -> o bloco de UMA loja. Os KPIs sao COPIADOS;
 * so a variacao contra ontem e derivada, e por `variacao`.
 */
export function lojaAoVivoDoResultado(
  nome: string, r: ResultadoVendasML, rOntem: ResultadoVendasML | null = null
): LojaAoVivo {
  if (r.erro !== null) return { nome, estado: "erro" };
  if (r.completo !== true || r.vendasBrutas === null) return { nome, estado: "incompleto" };
  const v = r.vendasBrutas;
  const kpis: KpisAoVivo = {
    valor: v.valor, vendas: v.vendas, unidades: v.unidades, ticketMedio: v.ticketMedio,
  };
  return {
    nome,
    estado: "ok",
    periodo: { de: r.periodo.de, ate: r.periodo.ate },
    kpis,
    comparativo: rOntem === null ? null : comparativoDoResultado(kpis, rOntem),
  };
}

/** O nome que o dono reconhece. Nunca o id nem o seller_id. */
export function nomeDaLoja(linha: { nome: string | null; nickname: string | null }): string {
  const nome = linha.nome?.trim() || linha.nickname?.trim();
  return nome && nome.length > 0 ? nome : "Mercado Livre";
}
