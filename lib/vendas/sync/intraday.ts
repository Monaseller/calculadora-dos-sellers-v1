/**
 * Observacao INTRADAY do dia corrente (SALES-SYNC-D15B) — contrato puro.
 *
 * Um job intraday observa o dia civil corrente (America/Sao_Paulo) ate um
 * alvo T numa GRADE de 15 minutos. Ele prova so OBSERVED_THROUGH (o corpus
 * foi listado ate T), nunca CLOSED_DAY_COMPLETE: nao conta como cobertura de
 * periodo fechado; depois da meia-noite o fechamento normal relista o dia.
 *
 *   marcador   tipo = 'incremental' + campo_tempo canonico + janela valida
 *              dentro de UM dia civil (date_from = date_to = esse dia).
 *              'incremental' SEM janela continua sendo o catch-up de escrow.
 *   campo      ML → date_closed; Shopee → create_time (descoberta). A data de
 *              negocio da Shopee continua sendo pay_time (o REDETAIL do D15D
 *              resolve estado/pagamento) — create_time aqui e so o campo da
 *              listagem.
 *   alvo T     floor(agora, 15 min) na hora UTC (o fuso de Sao Paulo tem
 *              offset de hora inteira, entao a grade e a mesma no relogio
 *              local). Nenhum atraso de indexacao do provedor e assumido: a
 *              correcao NUNCA depende dele (o motor relista/re-detalha); um
 *              atraso, se existir, sera so parametro OPERACIONAL.
 *   cadencia   no maximo 1 nova observacao por loja a cada 30 min, medida
 *              pelo T da ultima observacao CONCLUIDA (independe da latencia
 *              do worker). O coordenador continua a cada 15 min: o tick do meio e NOOP.
 *
 * HABILITADO = false ate existirem os motores (D15C ML / D15D Shopee): o
 * tick so planeja intraday quando chamado explicitamente com `intraday: true`
 * (testes), e o worker recusa qualquer job intraday (fail-closed).
 */
import { inicioDoDiaEmSaoPaulo, somarDiasNoCalendario } from "@/lib/fuso-sao-paulo";

/** Producao: nenhum job intraday e criado antes dos motores intraday (D15C/D15D). */
export const INTRADAY_CANONICO_HABILITADO = true;

export const GRADE_INTRADAY_MS = 15 * 60 * 1000;
export const CADENCIA_INTRADAY_MS = 30 * 60 * 1000;
/** Prioridade na fila serial da loja: depois da descoberta recente (fechamento, 3), antes do refresh recente (4), bootstrap (5) e historico (6/7). */
export const PRIORIDADE_INTRADAY = 3.5;

/** O minimo de um job para classificar (linha de sync_jobs ou JobExistenteSync). */
export interface JobClassificavelIntraday {
  tipo?: string | null;
  campoTempo?: string | null;
  janelaInicio?: string | null;
  janelaFim?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
}

const CAMPOS_INTRADAY = new Set(["date_closed", "create_time"]);
const DIA = /^\d{4}-\d{2}-\d{2}$/;

/** Limites [inicio, fim) do dia civil `dia` em Sao Paulo, em ms (offset REAL do dia). */
export function limitesDoDiaMs(dia: string): { inicio: number; fim: number } | null {
  if (!DIA.test(dia)) return null;
  const i = inicioDoDiaEmSaoPaulo(dia), f = inicioDoDiaEmSaoPaulo(somarDiasNoCalendario(dia, 1));
  if (i === null || f === null) return null;
  return { inicio: Date.parse(i), fim: Date.parse(f) };
}

/**
 * O UNICO classificador de job intraday. Independe do relogio: um intraday
 * de 06/10 continua intraday em 07/10 (e por isso continua FORA da cobertura
 * fechada de 06/10). Para "e do dia corrente?" use `ehJobIntradayDoDia`.
 */
export function ehJobIntraday(j: JobClassificavelIntraday): boolean {
  if (j.tipo !== "incremental" || !j.campoTempo || !CAMPOS_INTRADAY.has(j.campoTempo)) return false;
  if (!j.janelaInicio || !j.janelaFim || !j.dateFrom || j.dateFrom !== j.dateTo) return false;
  const a = Date.parse(j.janelaInicio), b = Date.parse(j.janelaFim), dia = limitesDoDiaMs(j.dateFrom);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a || dia === null) return false;
  return a >= dia.inicio && b <= dia.fim;
}

/** Intraday do dia civil `dia` (ex.: hoje). */
export function ehJobIntradayDoDia(j: JobClassificavelIntraday, dia: string): boolean {
  return ehJobIntraday(j) && j.dateFrom === dia;
}

/** Alvo T: floor(agora, 15 min). Deterministico — o mesmo para todo tick dentro do mesmo quarto de hora. */
export function alvoIntradayMs(agoraMs: number): number {
  return Math.floor(agoraMs / GRADE_INTRADAY_MS) * GRADE_INTRADAY_MS;
}

/** Identidade logica: marketplace | loja | campo | inicio do dia | T | intraday. */
export function chaveIntraday(marketplace: string, lojaId: string, campoTempo: string, inicioDiaIso: string, alvoIso: string): string {
  return `${marketplace}|${lojaId}|${campoTempo}|${inicioDiaIso}|${alvoIso}|intraday`;
}
