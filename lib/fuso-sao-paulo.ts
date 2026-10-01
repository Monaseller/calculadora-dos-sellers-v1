/**
 * O dia civil de Sao Paulo — F7b.4.8.5 §5.
 *
 * ── Por que nao `-3 horas` ──────────────────────────────────────────
 *
 * O resto deste repositorio converte para o fuso de Sao Paulo subtraindo
 * tres horas, e isso esta certo para setembro de 2026: o Brasil nao tem
 * horario de verao desde 2019 e o deslocamento e fixo em -03:00.
 *
 * "Certo hoje" nao e o mesmo que certo. Horario de verao e decisao
 * politica, e ja foi revogada e reinstituida neste pais mais de uma vez;
 * um `-3` espalhado pelo codigo seria uma bomba de relogio em que a conta
 * financeira erraria por uma hora em algumas noites e por um DIA na virada
 * do mes — exatamente o tipo de erro que a pericia do F7b.4.8.4 levou
 * dois gates para achar.
 *
 * `Intl.DateTimeFormat` com `timeZone` consulta a base de fusos do
 * ambiente. Ela sabe de horario de verao, sabe de mudanca de regra, e nao
 * depende de ninguem lembrar de atualizar um numero.
 *
 * ── A ordem importa ────────────────────────────────────────────────
 *
 * Primeiro interpretar o instante com o offset que o provedor mandou,
 * depois converter para Sao Paulo, e so ENTAO extrair o dia. Cortar os
 * dez primeiros caracteres do texto e converter depois e o bug que este
 * modulo existe para impedir: `2026-08-31T23:33:10-04:00` e 01/09 em Sao
 * Paulo, e nao 31/08.
 */
import "server-only";

export const FUSO_SAO_PAULO = "America/Sao_Paulo";

/**
 * `en-CA` porque ele formata como `AAAA-MM-DD`, que e exatamente a forma
 * que o resto do sistema compara. Construido uma vez: criar um formatador
 * por pedido custaria caro numa varredura de onze mil.
 */
const FORMATO_DE_DIA = new Intl.DateTimeFormat("en-CA", {
  timeZone: FUSO_SAO_PAULO,
  year: "numeric", month: "2-digit", day: "2-digit",
});

const FORMATO_DE_MINUTO = new Intl.DateTimeFormat("en-CA", {
  timeZone: FUSO_SAO_PAULO,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false,
});

/**
 * O dia civil de Sao Paulo de um instante ISO, ou `null`.
 *
 * `null` para texto vazio, nao-texto e data impossivel. Nunca uma data
 * inventada: um dia errado entraria silenciosamente num total financeiro.
 */
export function diaEmSaoPaulo(iso: unknown): string | null {
  if (typeof iso !== "string" || iso === "") return null;
  const instante = new Date(iso);
  const t = instante.getTime();
  if (!Number.isFinite(t)) return null;
  return FORMATO_DE_DIA.format(instante);
}

/** `AAAA-MM-DD HH:MM` em Sao Paulo — para log e para conferencia. */
export function minutoEmSaoPaulo(iso: unknown): string | null {
  if (typeof iso !== "string" || iso === "") return null;
  const instante = new Date(iso);
  if (!Number.isFinite(instante.getTime())) return null;
  // `en-CA` entrega "2026-09-01, 00:33"; a virgula sai para ficar
  // comparavel com o texto que o relatorio oficial do Mercado Livre usa.
  return FORMATO_DE_MINUTO.format(instante).replace(", ", " ");
}

/** O inicio do dia `AAAA-MM-DD` em Sao Paulo, como instante ISO. */
export function inicioDoDiaEmSaoPaulo(dia: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) return null;
  // O offset real daquele dia e descoberto, e nao suposto: pede-se meio-dia
  // UTC (que nunca cai no outro dia civil em Sao Paulo) e compara-se o dia
  // formatado para achar o deslocamento vigente.
  const meioDia = new Date(`${dia}T12:00:00Z`);
  const offsetMinutos = deslocamentoEmMinutos(meioDia);
  const sinal = offsetMinutos <= 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutos);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${dia}T00:00:00.000${sinal}${hh}:${mm}`;
}

/** O fim do dia `AAAA-MM-DD` em Sao Paulo, como instante ISO. */
export function fimDoDiaEmSaoPaulo(dia: string): string | null {
  const inicio = inicioDoDiaEmSaoPaulo(dia);
  return inicio === null ? null : inicio.replace("T00:00:00.000", "T23:59:59.999");
}

/**
 * Quantos minutos Sao Paulo esta a frente de UTC naquele instante.
 *
 * Negativo no Brasil. Calculado comparando a hora formatada no fuso com a
 * hora UTC — e assim o horario de verao, se voltar, entra de graca.
 */
function deslocamentoEmMinutos(instante: Date): number {
  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: FUSO_SAO_PAULO,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(instante);
  const pegar = (tipo: string): number => {
    const p = partes.find((x) => x.type === tipo);
    return p === undefined ? 0 : Number(p.value);
  };
  // `hour12: false` pode devolver 24 para meia-noite em alguns ambientes.
  const hora = pegar("hour") % 24;
  const comoSeFosseUtc = Date.UTC(
    pegar("year"), pegar("month") - 1, pegar("day"), hora, pegar("minute"), pegar("second"));
  return Math.round((comoSeFosseUtc - instante.getTime()) / 60000);
}

/** Soma dias a um `AAAA-MM-DD`, sem passar por fuso. */
export function somarDiasNoCalendario(dia: string, n: number): string {
  const t = Date.UTC(
    Number(dia.slice(0, 4)), Number(dia.slice(5, 7)) - 1, Number(dia.slice(8, 10)));
  return new Date(t + n * 86400000).toISOString().slice(0, 10);
}
