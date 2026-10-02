/**
 * CDS IA — identidade por cor dos DASHBOARDS (F8.1-C1).
 *
 * ── A regra ─────────────────────────────────────────────────────────
 *
 * Todo KPI, metrica, resumo numerico ou card estatistico da CDS IA tem
 * uma COR DE IDENTIDADE — e ela entra de forma controlada:
 *
 *   borda/acento   tinta da cor, baixa opacidade
 *   numero         a cor, um tom mais claro (legivel no fundo escuro)
 *   indicador      um ponto pequeno ao lado do rotulo
 *   fundo          glow MUITO sutil sobre o fundo escuro da CDS
 *
 * Nunca card chapado/saturado: o fundo continua escuro, e a cor
 * identifica sem gritar. A cor e reforco — o rotulo continua dizendo o
 * que o numero e, entao nada depende so dela.
 *
 * ── Por que aqui, e nao em `lib/ia/design.ts` ───────────────────────
 *
 * `design.ts` e o token global (CROMO/PALCO/estado). Esta paleta e so de
 * dashboard, e entrou sem tocar no acento global do produto.
 *
 * Modulo PURO: so constantes e uma funcao de estilo.
 */

/** Uma cor de identidade: o tom base (RGB) e o tom do numero. */
export interface CorDeDashboard {
  /** `r g b` — para montar tintas com opacidade (`rgb(r g b / a)`). */
  readonly rgb: string;
  /** Tom do numero: um passo mais claro, para contraste no fundo escuro. */
  readonly numero: string;
}

/**
 * ── Paleta VALIDADA (F8.2-B) ────────────────────────────────────────
 *
 * Os tons de MARCA (borda, anel, barra, ponto) passaram pelo validador
 * de paleta categorica no fundo escuro do Office (#111723):
 *
 *   #e8661a  #1a56c4  #cc54e8  #16a34a
 *   luminosidade 0.48–0.67  OK   croma  OK
 *   CVD (pior adjacente, protan) dE 9.3  OK   visao normal dE 26.9  OK
 *   contraste: azul 2.71:1 (WARN) — compensado: todo KPI tem rotulo
 *
 * A versao anterior (azul #3b82f6 / violeta #8b5cf6) REPROVAVA: dE 1.3
 * para deuteranopia e 12.0 em visao normal (piso 15). Azul e violeta
 * agora diferem tambem em LUMINOSIDADE, e nao so em matiz.
 *
 * `numero` e TEXTO: um tom claro da mesma cor, para leitura no escuro.
 */
export const CORES_DASHBOARD = {
  /** Laranja CDS. */
  laranja: { rgb: "232 102 26", numero: "#fb923c" },
  azul: { rgb: "26 86 196", numero: "#6ea8ff" },
  violeta: { rgb: "204 84 232", numero: "#e08ef5" },
  verde: { rgb: "22 163 74", numero: "#4ade80" },
} as const satisfies Record<string, CorDeDashboard>;

export type NomeDaCorDeDashboard = keyof typeof CORES_DASHBOARD;

/** As tres camadas de cor de um card, prontas para `style`. */
export function estiloDeCard(cor: CorDeDashboard): {
  readonly borda: string;
  readonly fundo: string;
  readonly indicador: string;
  readonly numero: string;
} {
  return {
    borda: `1px solid rgb(${cor.rgb} / 0.28)`,
    // Glow sutil no topo, sumindo no fundo escuro — nunca cor chapada.
    fundo: `linear-gradient(180deg, rgb(${cor.rgb} / 0.10) 0%, rgb(${cor.rgb} / 0.02) 100%)`,
    indicador: `rgb(${cor.rgb})`,
    numero: cor.numero,
  };
}
