/**
 * `calendario.periodo` — AGENT-FACTORY-F3.
 *
 * ── Para que ela existe ─────────────────────────────────────────────
 *
 * "quanto entrou este mes" so e verificavel se "este mes" for um
 * INTERVALO calculado, e nao uma data que o modelo escreveu. Um LLM
 * perguntado que dia e hoje responde com confianca — e erra, porque ele
 * nao tem relogio. Se ele inventar 2026-08-01..2026-08-31 numa
 * conversa de setembro, a soma vai sair certinha sobre o mes errado, e
 * nada no resultado denuncia isso.
 *
 * Entao o intervalo vem daqui, de codigo, e o modelo so escolhe o NOME
 * do periodo.
 *
 * ── Isto NAO e integracao de agenda ─────────────────────────────────
 *
 * Nao fala com Google Calendar, nao le evento, nao tem credencial e nao
 * alcanca rede. E aritmetica de calendario, so.
 *
 * ── Fuso ────────────────────────────────────────────────────────────
 *
 * O repositorio ja resolve "hoje" em dois lugares — `dataReferenciaBRT`
 * em `lib/shopee-status.ts` e o calculo de ontem..hoje em
 * `app/api/sync/iniciar/route.ts` — e nos dois com deslocamento FIXO de
 * -3h para America/Sao_Paulo. Nao existe fuso configuravel no sistema;
 * esse deslocamento E o fallback real, e esta sendo reusado aqui em vez
 * de um segundo criterio para a mesma pergunta.
 *
 * O limite dele, dito em voz alta: -3 fixo vale porque o Brasil acabou
 * com o horario de verao em 2019. Para datas anteriores a isso o
 * intervalo pode deslizar um dia. Nenhum dado desta aplicacao e de
 * antes de 2019, e o dia em que for, o lugar de corrigir e este.
 */
import "server-only";
import type {
  ContextoFuncao,
  ResultadoInterpretacaoSaida,
  ResultadoValidacaoEntrada,
} from "@/lib/agentes/funcoes/registry";

export const FUSO_CDS = "America/Sao_Paulo";
const DESLOCAMENTO_MS = 3 * 60 * 60 * 1000;
const DIA_MS = 86_400_000;

export const PERIODOS = Object.freeze([
  "hoje", "ontem", "esta_semana", "semana_passada", "este_mes", "mes_passado", "este_ano",
] as const);
export type NomeDePeriodo = (typeof PERIODOS)[number];

export interface Periodo {
  readonly periodo: NomeDePeriodo;
  /** Primeiro dia, inclusivo. AAAA-MM-DD. */
  readonly inicio: string;
  /** Ultimo dia, INCLUSIVO — ver o comentario em `resolverPeriodo`. */
  readonly fim: string;
  readonly fuso: string;
  readonly rotulo: string;
  readonly dias: number;
}

/** Componentes do dia civil em BRT para um instante UTC. */
function civilBRT(agoraMs: number): { a: number; m: number; d: number } {
  const d = new Date(agoraMs - DESLOCAMENTO_MS);
  return { a: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

function iso(a: number, m: number, d: number): string {
  return `${String(a).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function somarDias(isoData: string, n: number): string {
  const [a, m, d] = isoData.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, d) + n * DIA_MS).toISOString().slice(0, 10);
}

function diasEntre(de: string, ate: string): number {
  const [a1, m1, d1] = de.split("-").map(Number);
  const [a2, m2, d2] = ate.split("-").map(Number);
  return Math.round((Date.UTC(a2, m2 - 1, d2) - Date.UTC(a1, m1 - 1, d1)) / DIA_MS) + 1;
}

const ROTULOS: Readonly<Record<NomeDePeriodo, string>> = Object.freeze({
  hoje: "hoje", ontem: "ontem", esta_semana: "esta semana",
  semana_passada: "semana passada", este_mes: "este mes",
  mes_passado: "mes passado", este_ano: "este ano",
});

/**
 * Resolve o intervalo.
 *
 * `fim` e INCLUSIVO: o ultimo dia pertence ao periodo. A alternativa —
 * fim exclusivo — e a fonte classica do erro de um dia, e aqui o
 * consumidor e um filtro `entre` sobre uma coluna de datas, onde
 * inclusivo e o que uma pessoa espera.
 *
 * A semana comeca na SEGUNDA, a convencao comercial brasileira. Domingo
 * como inicio faria "semana passada" incluir um dia do fim de semana
 * que a pessoa ja considera da semana anterior.
 */
export function resolverPeriodo(nome: NomeDePeriodo, agoraMs: number): Periodo {
  const { a, m, d } = civilBRT(agoraMs);
  const hoje = iso(a, m, d);
  let inicio: string;
  let fim: string;

  if (nome === "hoje") {
    inicio = hoje; fim = hoje;
  } else if (nome === "ontem") {
    inicio = somarDias(hoje, -1); fim = inicio;
  } else if (nome === "esta_semana" || nome === "semana_passada") {
    const dow = new Date(Date.UTC(a, m - 1, d)).getUTCDay();   // 0=dom
    const desdeSegunda = (dow + 6) % 7;
    const segundaDesta = somarDias(hoje, -desdeSegunda);
    if (nome === "esta_semana") {
      inicio = segundaDesta; fim = somarDias(segundaDesta, 6);
    } else {
      inicio = somarDias(segundaDesta, -7); fim = somarDias(segundaDesta, -1);
    }
  } else if (nome === "este_mes") {
    inicio = iso(a, m, 1);
    fim = new Date(Date.UTC(a, m, 1) - DIA_MS).toISOString().slice(0, 10);
  } else if (nome === "mes_passado") {
    const am = m === 1 ? a - 1 : a;
    const mm = m === 1 ? 12 : m - 1;
    inicio = iso(am, mm, 1);
    fim = new Date(Date.UTC(am, mm, 1) - DIA_MS).toISOString().slice(0, 10);
  } else {
    inicio = iso(a, 1, 1); fim = iso(a, 12, 31);
  }

  return {
    periodo: nome, inicio, fim, fuso: FUSO_CDS,
    rotulo: ROTULOS[nome], dias: diasEntre(inicio, fim),
  };
}

// ─── Os wrappers da Funcao ────────────────────────────────────────────

export function validarEntradaCalendario(argumentos: unknown): ResultadoValidacaoEntrada {
  if (typeof argumentos !== "object" || argumentos === null || Array.isArray(argumentos)) {
    return { valida: false, codigo: "entrada_nao_objeto" };
  }
  const a = argumentos as Record<string, unknown>;
  // Allowlist, nao denylist: um campo a mais e recusado em vez de
  // ignorado. Ignorar campo desconhecido ensina o modelo a mandar
  // qualquer coisa e nunca descobrir que nao teve efeito.
  for (const k of Object.keys(a)) {
    if (k !== "periodo") return { valida: false, codigo: "campo_desconhecido" };
  }
  if (typeof a.periodo !== "string" || !(PERIODOS as readonly string[]).includes(a.periodo)) {
    return { valida: false, codigo: "periodo_invalido" };
  }
  return { valida: true };
}

export async function executarCalendario(
  contexto: ContextoFuncao,
  argumentos: unknown
): Promise<unknown> {
  void contexto;   // periodo nao depende de dono nem de conexao
  const a = argumentos as { periodo: NomeDePeriodo };
  return resolverPeriodo(a.periodo, Date.now());
}

export function interpretarSaidaCalendario(saida: unknown): ResultadoInterpretacaoSaida {
  if (typeof saida !== "object" || saida === null || Array.isArray(saida)) {
    return { tipo: "invalida" };
  }
  const s = saida as Record<string, unknown>;
  const dataIso = /^\d{4}-\d{2}-\d{2}$/;
  if (
    typeof s.periodo !== "string" ||
    typeof s.inicio !== "string" || !dataIso.test(s.inicio) ||
    typeof s.fim !== "string" || !dataIso.test(s.fim) ||
    typeof s.fuso !== "string" ||
    typeof s.rotulo !== "string" ||
    typeof s.dias !== "number" ||
    s.inicio > s.fim
  ) {
    return { tipo: "invalida" };
  }
  return { tipo: "sucesso", data: saida };
}
