/**
 * Resolvedor UNICO de periodo das vendas canonicas (SALES-CANONICAL-D13).
 *
 * Preset ou intervalo livre → dias civis de America/Sao_Paulo [de, ate] e o
 * intervalo TECNICO [inicioInclusivo, fimExclusivo): 00:00 de `de` ate
 * 00:00 do dia seguinte a `ate`, com o offset REAL de cada dia (nunca um
 * "-3h" fixo). E o mesmo intervalo que os leitores canonicos aplicam
 * (intervaloSaoPaulo) — o teste do servico prova a igualdade.
 *
 *   HOJE                 hoje (parcial: o dia esta aberto)
 *   ONTEM                ontem
 *   ULTIMOS_7/30/60_DIAS N dias COMPLETOS terminando ONTEM (hoje fora)
 *   MES_PASSADO          dia 1 ao ultimo dia do mes anterior
 *   ESTE_MES             dia 1 do mes ate hoje (parcial)
 *   ESTE_ANO             01/01 ate hoje (parcial)
 *   CUSTOM               [de, ate] informados; futuro e invalido; ate = hoje → parcial
 *
 * Puro: sem banco, sem rede, sem React. O relogio e injetado (`agoraMs`).
 * NAO usa lib/date-range-utils.ts (legado: UTC-3 fixo e "ultimos N" incluindo hoje).
 */
import { FUSO_SAO_PAULO, diaEmSaoPaulo, inicioDoDiaEmSaoPaulo, somarDiasNoCalendario } from "@/lib/fuso-sao-paulo";

export const PRESETS_PERIODO_VENDAS = [
  "HOJE", "ONTEM", "ULTIMOS_7_DIAS", "ULTIMOS_30_DIAS", "ULTIMOS_60_DIAS", "MES_PASSADO", "ESTE_MES", "ESTE_ANO", "CUSTOM",
] as const;
export type PresetPeriodoVendas = (typeof PRESETS_PERIODO_VENDAS)[number];

export interface PeriodoVendasResolvido {
  preset: PresetPeriodoVendas;
  /** Primeiro dia civil (AAAA-MM-DD, Sao Paulo), incluso. */
  de: string;
  /** Ultimo dia civil (AAAA-MM-DD, Sao Paulo), incluso comercialmente. */
  ate: string;
  /** Instante ISO (UTC) de 00:00 de `de` em Sao Paulo — incluso. */
  inicioInclusivo: string;
  /** Instante ISO (UTC) de 00:00 do dia seguinte a `ate` em Sao Paulo — EXCLUSIVO. */
  fimExclusivo: string;
  fuso: typeof FUSO_SAO_PAULO;
  /** Hoje (Sao Paulo) no relogio usado. */
  hoje: string;
  /** O periodo contem hoje: o dia esta aberto e o resultado nunca e definitivo. */
  parcial: boolean;
  dias: number;
}

export class ErroPeriodoVendas extends Error {
  constructor(public readonly detalhe: string) { super(`periodo_invalido:${detalhe}`); }
}

const DIA_RE = /^\d{4}-\d{2}-\d{2}$/;

/** AAAA-MM-DD existente no calendario (rejeita 2026-02-29, 2026-13-01...). */
export function diaCivilValido(dia: unknown): dia is string {
  if (typeof dia !== "string" || !DIA_RE.test(dia)) return false;
  const t = Date.UTC(Number(dia.slice(0, 4)), Number(dia.slice(5, 7)) - 1, Number(dia.slice(8, 10)));
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === dia;
}

function diasEntre(de: string, ate: string): number {
  // meia-noite UTC de dias civis: a diferenca e multiplo exato de 24h (sem fuso nem arredondamento)
  return (Date.parse(`${ate}T00:00:00Z`) - Date.parse(`${de}T00:00:00Z`)) / 86400000 + 1;
}

export function resolverPeriodoVendas(
  entrada: { preset?: PresetPeriodoVendas | string; de?: string; ate?: string },
  agoraMs: number,
): PeriodoVendasResolvido {
  if (!Number.isFinite(agoraMs)) throw new ErroPeriodoVendas("relogio_invalido");
  const hoje = diaEmSaoPaulo(new Date(agoraMs).toISOString());
  if (hoje === null) throw new ErroPeriodoVendas("relogio_invalido");
  const ontem = somarDiasNoCalendario(hoje, -1);
  const primeiroDoMes = `${hoje.slice(0, 7)}-01`;
  const preset = (entrada.preset ?? "CUSTOM") as PresetPeriodoVendas;
  if (!(PRESETS_PERIODO_VENDAS as readonly string[]).includes(preset)) throw new ErroPeriodoVendas("preset_desconhecido");
  if (preset !== "CUSTOM" && (entrada.de !== undefined || entrada.ate !== undefined)) throw new ErroPeriodoVendas("preset_com_datas");

  let de: string, ate: string;
  switch (preset) {
    case "HOJE": de = hoje; ate = hoje; break;
    case "ONTEM": de = ontem; ate = ontem; break;
    case "ULTIMOS_7_DIAS": de = somarDiasNoCalendario(hoje, -7); ate = ontem; break;
    case "ULTIMOS_30_DIAS": de = somarDiasNoCalendario(hoje, -30); ate = ontem; break;
    case "ULTIMOS_60_DIAS": de = somarDiasNoCalendario(hoje, -60); ate = ontem; break;
    case "MES_PASSADO": ate = somarDiasNoCalendario(primeiroDoMes, -1); de = `${ate.slice(0, 7)}-01`; break;
    case "ESTE_MES": de = primeiroDoMes; ate = hoje; break;
    case "ESTE_ANO": de = `${hoje.slice(0, 4)}-01-01`; ate = hoje; break;
    default: {
      if (!diaCivilValido(entrada.de) || !diaCivilValido(entrada.ate)) throw new ErroPeriodoVendas("data_invalida");
      de = entrada.de; ate = entrada.ate;
      if (ate < de) throw new ErroPeriodoVendas("fim_antes_do_inicio");
      if (ate > hoje) throw new ErroPeriodoVendas("periodo_no_futuro");
    }
  }

  const inicio = inicioDoDiaEmSaoPaulo(de);
  const fim = inicioDoDiaEmSaoPaulo(somarDiasNoCalendario(ate, 1));
  if (inicio === null || fim === null) throw new ErroPeriodoVendas("data_invalida");
  return {
    preset, de, ate,
    inicioInclusivo: new Date(inicio).toISOString(),
    fimExclusivo: new Date(fim).toISOString(),
    fuso: FUSO_SAO_PAULO, hoje, parcial: ate >= hoje, dias: diasEntre(de, ate),
  };
}
