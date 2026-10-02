/**
 * Vendas AO VIVO — estado e ciclo de atualizacao do painel. F8.2-A.
 *
 * Modulo PURO: sem React, sem rede. A tela injeta a leitura e o relogio;
 * a suite injeta os falsos. E o que permite provar as tres garantias:
 *
 *   1. ERRO NAO APAGA DADO BOM. Uma atualizacao que falha mantem o
 *      ultimo retrato e marca o painel como desatualizado.
 *   2. NUNCA DUAS LEITURAS EM VOO. Atualizar manualmente durante uma
 *      leitura e ignorado; o proximo ciclo so e agendado quando a
 *      leitura TERMINA (`await` + `setTimeout`, nao `setInterval` — o
 *      mesmo motivo do refresh do Escritorio).
 *   3. GLOBAL DO ESCRITORIO. O ciclo nao conhece agente: trocar de agente
 *      nao o recria (quem monta o painel fora do `key` do agente garante).
 */
import type { RespostaVendasAoVivo, VendasAoVivoUI } from "@/lib/ia/agentes-http";

export const INTERVALO_AO_VIVO_MS = 10 * 60 * 1000;

/** Passado disto sem retrato novo, o painel se declara desatualizado. */
export const LIMITE_DESATUALIZADO_MS = Math.round(INTERVALO_AO_VIVO_MS * 1.5);

export const ESTADOS_AO_VIVO = ["LOADING", "OK", "STALE", "ERROR", "NOT_CONFIGURED"] as const;
export type EstadoAoVivo = (typeof ESTADOS_AO_VIVO)[number];

export interface MemoriaAoVivo {
  /** O ultimo retrato BOM. Nunca e apagado por uma falha. */
  readonly retrato: VendasAoVivoUI | null;
  /** Quando o ultimo retrato bom chegou (relogio do cliente). */
  readonly obtidoEmMs: number | null;
  /** A ULTIMA tentativa falhou (com ou sem retrato anterior). */
  readonly ultimaFalhou: boolean;
  readonly carregando: boolean;
}

export const MEMORIA_INICIAL: MemoriaAoVivo = {
  retrato: null, obtidoEmMs: null, ultimaFalhou: false, carregando: true,
};

/** Aplica uma resposta. Falha PRESERVA o retrato anterior. */
export function aplicarResposta(
  anterior: MemoriaAoVivo,
  resposta: RespostaVendasAoVivo,
  agoraMs: number
): MemoriaAoVivo {
  if (resposta.estado === "ok") {
    return { retrato: resposta.dados, obtidoEmMs: agoraMs, ultimaFalhou: false, carregando: false };
  }
  return { ...anterior, ultimaFalhou: true, carregando: false };
}

/** O estado que a tela mostra. */
export function estadoAoVivo(m: MemoriaAoVivo, agoraMs: number): EstadoAoVivo {
  if (m.retrato === null) return m.carregando ? "LOADING" : "ERROR";
  if (m.retrato.marketplaces.every((x) => !x.configurado)) return "NOT_CONFIGURED";
  const velho = m.obtidoEmMs !== null && agoraMs - m.obtidoEmMs > LIMITE_DESATUALIZADO_MS;
  return m.ultimaFalhou || velho ? "STALE" : "OK";
}

/** "agora", "há 1 min", "há 12 min", "há 2 h". */
export function haQuantoTempo(desdeMs: number, agoraMs: number): string {
  const min = Math.max(0, Math.floor((agoraMs - desdeMs) / 60_000));
  if (min < 1) return "agora";
  if (min < 60) return `há ${min} min`;
  return `há ${Math.floor(min / 60)} h`;
}

// ── O ciclo ──────────────────────────────────────────────────────────

export interface RelogioDoCiclo {
  agendar(fn: () => void, ms: number): unknown;
  cancelar(id: unknown): void;
}

export interface CicloAoVivo {
  /** Primeira leitura imediata; as proximas a cada intervalo. */
  iniciar(): void;
  /** Leitura agora, se nao houver uma em voo. Reinicia a contagem. */
  atualizarAgora(): void;
  /** Para tudo: cancela timer e leitura; resposta tardia e descartada. */
  parar(): void;
}

export function criarCicloAoVivo(opcoes: {
  ler: (signal: AbortSignal) => Promise<RespostaVendasAoVivo>;
  aoComecar: () => void;
  aoResponder: (r: RespostaVendasAoVivo) => void;
  intervaloMs?: number;
  relogio?: RelogioDoCiclo;
}): CicloAoVivo {
  const intervalo = opcoes.intervaloMs ?? INTERVALO_AO_VIVO_MS;
  const relogio: RelogioDoCiclo = opcoes.relogio ?? {
    agendar: (fn, ms) => setTimeout(fn, ms),
    cancelar: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  };
  let timer: unknown = null;
  let emVoo: AbortController | null = null;
  let parado = false;

  const agendarProximo = () => {
    if (timer !== null) relogio.cancelar(timer);
    timer = relogio.agendar(() => { timer = null; void ler(); }, intervalo);
  };

  async function ler(): Promise<void> {
    if (parado || emVoo !== null) return;
    if (timer !== null) { relogio.cancelar(timer); timer = null; }
    const controlador = new AbortController();
    emVoo = controlador;
    opcoes.aoComecar();
    let r: RespostaVendasAoVivo;
    try {
      r = await opcoes.ler(controlador.signal);
    } catch {
      r = { estado: "falha" };
    }
    emVoo = null;
    if (parado || controlador.signal.aborted) return;
    opcoes.aoResponder(r);
    agendarProximo();
  }

  return {
    iniciar: () => { void ler(); },
    atualizarAgora: () => { void ler(); },
    parar: () => {
      parado = true;
      if (timer !== null) relogio.cancelar(timer);
      timer = null;
      emVoo?.abort();
      emVoo = null;
    },
  };
}
