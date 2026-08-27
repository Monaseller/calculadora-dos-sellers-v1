/**
 * CDS IA — tokens visuais.
 *
 * ── Por que tokens em TypeScript, e nao um tema de framework ────────
 *
 * O projeto NAO usa Tailwind, CSS-in-JS nem biblioteca de componentes:
 * ele estiliza com `style={{}}` inline (172 ocorrencias so em Vendas).
 * Introduzir um stack visual novo aqui criaria duas maneiras de estilizar
 * o mesmo produto. Entao "design system" neste repositorio significa
 * constantes tipadas — e a disciplina de importa-las em vez de repetir
 * hex solto.
 *
 * ── Duas paletas, de proposito ──────────────────────────────────────
 *
 * CROMO  = a moldura do CDS: sidebar, cards, textos, bordas. Sao os
 *          valores JA usados em `components/Sidebar.tsx`, `TopBar.tsx` e
 *          `central-ia/page.tsx`, copiados de la para que a area nova
 *          nao pareca outro produto.
 *
 * PALCO  = so dentro do escritorio pixel art. Parede, piso, mesa,
 *          monitor. Nunca sai do palco: um card de custos com parede
 *          azul-ardosia destoaria do resto do CDS.
 *
 * A regra pratica: fora do palco, use CROMO. Dentro, PALCO — exceto as
 * cores de ESTADO, que sao as mesmas nos dois lugares, porque "erro"
 * precisa ser a mesma coisa numa luz de mesa e num badge de lista.
 */

// ── Cromo (identidade CDS existente) ──────────────────────────────────

export const CROMO = {
  fundo: "#111318",
  fundoCard: "rgba(255,255,255,0.03)",
  fundoCardHover: "rgba(255,255,255,0.06)",
  borda: "rgba(255,255,255,0.08)",
  bordaSutil: "rgba(255,255,255,0.06)",
  texto: "#ffffff",
  textoFraco: "#9099aa",
  acento: "#FF6A00",
  acentoFundo: "rgba(255,106,0,0.12)",
  acentoBorda: "rgba(255,106,0,0.25)",
} as const;

// ── Palco (somente dentro do escritorio) ──────────────────────────────

export const PALCO = {
  parede: "#2b3a52",
  paredeEscura: "#22304a",
  rodape: "#16202f",
  pisoA: "#8d7a63",
  pisoB: "#7d6b56",
  mesa: "#5a4632",
  mesaTopo: "#6d5740",
  monitor: "#1b2a3a",
  monitorApagado: "#243447",
  linha: "#0f1622",
  tapete: "#3d5a52",
  copa: "#41506b",
} as const;

// ── Cores de estado (valem no palco E no cromo) ───────────────────────
//
// `concluido` reusa o verde que a TopBar ja usa para "conectado"
// (#00D97E), em vez de inventar um terceiro verde no produto.

export const CORES_ESTADO = {
  ocioso: "#6b7a90",
  trabalhando: "#4fd1c5",
  aguardando_aprovacao: "#f0b429",
  concluido: "#00D97E",
  erro: "#f06a6a",
} as const;

/** Modificador `foraDeOperacao`: mais apagado que qualquer estado. */
export const COR_FORA_DE_OPERACAO = "#4a5262";

/**
 * Cor do personagem por TIPO de agente — nunca por estado.
 *
 * Sao dois eixos independentes: a cor do corpo diz QUEM e o agente e nao
 * muda nunca; a cor do estado diz COMO ele esta e muda o tempo todo. Se
 * o corpo mudasse de cor junto com o estado, o usuario perderia a
 * identidade do agente exatamente no momento em que precisa reconhece-lo
 * — quando algo deu errado.
 *
 * As chaves espelham o CHECK de `agentes.tipo`.
 */
export const CORES_TIPO = {
  mensagens: "#4a9de8",
  ads: "#b06ae8",
  fotos: "#e8a54a",
  anuncios: "#63d471",
  financeiro: "#4fd1c5",
  gerente: "#e86a9d",
} as const;

// ── Tipografia ────────────────────────────────────────────────────────

export const FONTE = {
  /** Fora do palco: a fonte do sistema, como no resto do CDS. */
  interface: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
  /** Dentro do palco: monoespacada, parte da leitura de pixel art. */
  palco: "ui-monospace, SFMono-Regular, Menlo, monospace",
} as const;

// ── Espacamento, bordas ───────────────────────────────────────────────

export const ESPACO = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

export const RAIO = {
  /** Cards e chrome do CDS. */
  card: 16,
  controle: 12,
  /** Dentro do palco NAO existe raio: pixel art nao tem canto redondo. */
  palco: 0,
} as const;

/** Sombra em degrau (sem blur) — a escolha que da leitura de pixel art. */
export function degrau(cor = "#00000055", n = 3): string {
  return `${n}px ${n}px 0 0 ${cor}`;
}

// ── Breakpoints ───────────────────────────────────────────────────────
//
// Usados em `@media` dentro dos blocos <style> dos componentes. O CDS tem
// 4 `@media` no repositorio inteiro; estes sao locais da area de IA e nao
// alteram o comportamento global.

export const BREAKPOINT = {
  /** Abaixo disto o escritorio nao e desenhado — ver Escritorio.tsx. */
  palcoMinimo: 720,
  tablet: 1024,
} as const;
