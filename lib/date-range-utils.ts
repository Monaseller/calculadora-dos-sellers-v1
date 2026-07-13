/**
 * lib/date-range-utils.ts
 *
 * Fonte unica de calculo de datas para os filtros de periodo do Dashboard e
 * Vendas (aprovado 2026-07-10). Antes desta unificacao existiam 3 copias
 * independentes da mesma logica (DateRangePicker.tsx, dashboard/page.tsx,
 * vendas/page.tsx) — auditoria encontrou divergencia real: "Ultimos 7 dias"
 * calculava 8 dias em dois lugares (DateRangePicker.tsx e vendas/page.tsx,
 * via `hoje - 7`) e 7 dias (correto) no terceiro (dashboard/page.tsx, via
 * `addDays(hoje, -6)`). Esta e agora a UNICA fonte — Dashboard, Vendas e
 * DateRangePicker devem importar daqui, nunca recalcular localmente.
 *
 * Escopo explicito: SO os filtros de exibicao (Dashboard/Vendas). NAO cobre
 * o seletor de periodo do modal "Sincronizar Historico" em vendas/page.tsx
 * (linha ~1464), que tem sua propria copia do mesmo bug de "-7 dias" — foi
 * encontrado durante esta auditoria mas esta fora do escopo aprovado nesta
 * etapa (e sync/historico, nao filtro de exibicao). Nao alterado.
 *
 * Timezone: todo "hoje" e calculado em horario de Brasilia (UTC-3), fixo,
 * subtraindo 3h do timestamp UTC antes de cortar a data — mesma tecnica ja
 * usada nos 3 lugares anteriores, so que agora em um unico ponto.
 */

/** "Hoje" em YYYY-MM-DD, horario de Brasilia (UTC-3), fixo. */
export function hojeISOBrasilia(): string {
  const now = new Date();
  const brasilia = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  return brasilia.toISOString().split("T")[0];
}

/**
 * Soma (ou subtrai, com n negativo) dias a uma data YYYY-MM-DD.
 * Usa meio-dia UTC como ancora para evitar deslocamento por DST/timezone
 * do ambiente de execucao — mesma tecnica ja usada em dashboard/page.tsx
 * antes desta unificacao.
 */
export function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split("T")[0];
}

export interface DateRange {
  from: string;
  to: string;
}

export function calcularHoje(): DateRange {
  const hoje = hojeISOBrasilia();
  return { from: hoje, to: hoje };
}

export function calcularOntem(): DateRange {
  const ontem = addDays(hojeISOBrasilia(), -1);
  return { from: ontem, to: ontem };
}

/**
 * Hoje + os 6 dias anteriores = exatamente 7 datas.
 * NUNCA usar "hoje - 7" (isso gera 8 dias) — foi o bug real encontrado em
 * auditoria (2026-07-10), presente em DateRangePicker.tsx e vendas/page.tsx.
 */
export function calcularUltimos7Dias(): DateRange {
  const hoje = hojeISOBrasilia();
  return { from: addDays(hoje, -6), to: hoje };
}

/** Hoje + os 29 dias anteriores = exatamente 30 datas. */
export function calcularUltimos30Dias(): DateRange {
  const hoje = hojeISOBrasilia();
  return { from: addDays(hoje, -29), to: hoje };
}

export interface PresetDef {
  label: string;
  get: () => DateRange;
}

/**
 * Presets finais aprovados (2026-07-10): Hoje, Ontem, Ultimos 7 dias,
 * Ultimos 30 dias. "Personalizado" nao e uma funcao daqui — e a propria
 * selecao livre no calendario do DateRangePicker.
 */
export const DATE_PRESETS: PresetDef[] = [
  { label: "Hoje", get: calcularHoje },
  { label: "Ontem", get: calcularOntem },
  { label: "Últimos 7 dias", get: calcularUltimos7Dias },
  { label: "Últimos 30 dias", get: calcularUltimos30Dias },
];
