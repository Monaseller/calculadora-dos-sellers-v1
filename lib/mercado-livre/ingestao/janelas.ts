/**
 * Janelas comerciais do motor ML (puro). Dias civis de America/Sao_Paulo:
 * [inicio de `de`, inicio do dia seguinte a `ate`) — sem -3h fixo e sem
 * 23:59:59 (o fuso vem de lib/fuso-sao-paulo).
 */
import { inicioDoDiaEmSaoPaulo, somarDiasNoCalendario } from "@/lib/fuso-sao-paulo";

const DATA = /^\d{4}-\d{2}-\d{2}$/;

/** Os dias civis de `de` ate `ate`, inclusivos; [] se invalido. */
export function diasDaJanela(de: string, ate: string): string[] {
  if (!DATA.test(de) || !DATA.test(ate) || de > ate) return [];
  const out: string[] = [];
  for (let d = de; d <= ate; d = somarDiasNoCalendario(d, 1)) out.push(d);
  return out;
}

/** Limites da janela em instantes: [inicio(de), inicio(ate + 1)). */
export function limitesDaJanela(de: string, ate: string): { inicio: Date; fim: Date } | null {
  const i = inicioDoDiaEmSaoPaulo(de), f = inicioDoDiaEmSaoPaulo(somarDiasNoCalendario(ate, 1));
  if (i === null || f === null || ate < de) return null;
  return { inicio: new Date(i), fim: new Date(f) };
}
