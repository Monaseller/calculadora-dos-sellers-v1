/**
 * Expressao de periodo em portugues -> intervalo de datas — F7b.4.8.3.
 *
 * ── Por que este modulo existe ──────────────────────────────────────
 *
 * O enum de sete periodos (`hoje`, `esta_semana`, `este_mes`...) cobre o
 * que se pergunta todo dia e nao cobre o que se pergunta de vez em
 * quando: "de 10/09/2026 ate 20/09/2026", "em agosto de 2026", "no dia
 * 15/08/2026", "ultimos 7 dias". Sem eles, a unica saida do modelo era
 * inventar datas — e data inventada produz um total certo sobre o mes
 * errado.
 *
 * ── A arquitetura do §13 ────────────────────────────────────────────
 *
 *   linguagem natural  ->  intencao  ->  A CDS resolve o intervalo
 *
 * O modelo entrega as PALAVRAS da pessoa. Quem transforma em datas e este
 * modulo, deterministicamente. O modelo nao calcula data nenhuma, e nao
 * ha caminho em que ele mande `de`/`ate` por conta propria.
 *
 * ── PURO ────────────────────────────────────────────────────────────
 *
 * Sem banco, sem rede, sem `server-only`. O relogio ENTRA por parametro:
 * "esta semana" e exatamente uma pergunta sobre quando se pergunta, e uma
 * funcao que le `Date.now()` por dentro nao pode ser testada em duas
 * datas.
 *
 * ── Fuso ────────────────────────────────────────────────────────────
 *
 * Tudo em `America/Sao_Paulo`, como `funcoes/calendario.ts` — que
 * continua sendo a autoridade dos sete periodos nomeados. Este modulo o
 * CHAMA para eles em vez de recalcular: duas implementacoes de "esta
 * semana" divergiriam no primeiro feriado de convencao.
 */
import {
  FUSO_CDS, PERIODOS, resolverPeriodo, type NomeDePeriodo,
} from "@/lib/agentes/funcoes/calendario";

const DIA_MS = 86_400_000;
/** O mesmo deslocamento fixo de `calendario.ts`. Ver o porque lá. */
const DESLOCAMENTO_MS = 3 * 60 * 60 * 1000;

export interface PeriodoResolvido {
  /** Primeiro dia, inclusivo. `AAAA-MM-DD`. */
  readonly de: string;
  /** Ultimo dia, INCLUSIVO. */
  readonly ate: string;
  /** Como dizer isto a uma pessoa. */
  readonly rotulo: string;
  readonly fuso: string;
}

/** Sem acento, sem caixa, espaco colapsado. */
function normalizar(t: string): string {
  return t
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function iso(a: number, m: number, d: number): string {
  return `${String(a).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** O dia civil de HOJE em Sao Paulo. */
function hojeBRT(agoraMs: number): { a: number; m: number; d: number; dia: string } {
  const d = new Date(agoraMs - DESLOCAMENTO_MS);
  const a = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const dd = d.getUTCDate();
  return { a, m, d: dd, dia: iso(a, m, dd) };
}

function somarDias(dia: string, n: number): string {
  const [a, m, d] = dia.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, d) + n * DIA_MS).toISOString().slice(0, 10);
}

/** O ultimo dia do mes. `Date.UTC(a, m, 0)` e o dia 0 do mes seguinte. */
function ultimoDiaDoMes(a: number, m: number): number {
  return new Date(Date.UTC(a, m, 0)).getUTCDate();
}

/** `AAAA-MM-DD` que existe de verdade? `new Date` aceita 31/02. */
function diaValido(a: number, m: number, d: number): boolean {
  if (m < 1 || m > 12) return false;
  if (d < 1) return false;
  return d <= ultimoDiaDoMes(a, m);
}

const MESES: Readonly<Record<string, number>> = Object.freeze({
  janeiro: 1, jan: 1,
  fevereiro: 2, fev: 2,
  marco: 3, mar: 3,
  abril: 4, abr: 4,
  maio: 5, mai: 5,
  junho: 6, jun: 6,
  julho: 7, jul: 7,
  agosto: 8, ago: 8,
  setembro: 9, set: 9,
  outubro: 10, out: 10,
  novembro: 11, nov: 11,
  dezembro: 12, dez: 12,
});

const NOME_DO_MES: readonly string[] = Object.freeze([
  "", "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
]);

/** Os sinonimos de cada periodo nomeado. O enum tambem e aceito cru. */
const SINONIMOS: readonly { readonly nome: NomeDePeriodo; readonly ditos: readonly string[] }[] =
  Object.freeze([
    { nome: "hoje", ditos: ["hoje", "de hoje", "do dia de hoje"] },
    { nome: "ontem", ditos: ["ontem", "de ontem", "do dia de ontem"] },
    // "esta semana" antes de "semana" para nao ser engolido por ele.
    { nome: "esta_semana", ditos: ["esta semana", "essa semana", "nesta semana", "semana atual"] },
    {
      nome: "semana_passada",
      ditos: ["semana passada", "semana anterior", "ultima semana", "na semana passada"],
    },
    { nome: "este_mes", ditos: ["este mes", "esse mes", "neste mes", "mes atual", "do mes"] },
    { nome: "mes_passado", ditos: ["mes passado", "mes anterior", "ultimo mes"] },
    { nome: "este_ano", ditos: ["este ano", "esse ano", "ano atual", "no ano"] },
  ]);

/**
 * O ANO de uma data escrita sem ano — §19.
 *
 * ── A regra, e por que ela e esta ───────────────────────────────────
 *
 * "de 3 a 18 de agosto", perguntado em setembro de 2026, quer dizer
 * agosto de 2026 — o que acabou de passar. Perguntado em janeiro de 2027,
 * quer dizer agosto de 2026 tambem: e o agosto mais recente que existiu.
 *
 * Entao: ano corrente se o periodo JA COMECOU; ano anterior se comecar no
 * futuro. Ninguem pergunta "quanto vendi" sobre um mes que nao aconteceu,
 * e escolher o futuro devolveria zero com cara de resposta.
 */
function anoParaMesSemAno(mes: number, agoraMs: number): number {
  const hoje = hojeBRT(agoraMs);
  // O mes ja comecou neste ano?
  return mes <= hoje.m ? hoje.a : hoje.a - 1;
}

function periodoNomeado(nome: NomeDePeriodo, agoraMs: number): PeriodoResolvido {
  const p = resolverPeriodo(nome, agoraMs);
  return { de: p.inicio, ate: p.fim, rotulo: p.rotulo, fuso: p.fuso };
}

/** `dd/mm/aaaa` ou `dd/mm/aa` ou `dd/mm`. pt-BR: DIA primeiro (§18). */
function lerDataNumerica(bruto: string, agoraMs: number): string | null {
  const m = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?$/.exec(bruto.trim());
  if (m === null) return null;
  const d = Number(m[1]);
  const mes = Number(m[2]);
  let ano: number;
  if (m[3] === undefined) {
    ano = anoParaMesSemAno(mes, agoraMs);
  } else if (m[3].length === 2) {
    // `26` e 2026. Dois digitos nunca significam o ano 26.
    ano = 2000 + Number(m[3]);
  } else {
    ano = Number(m[3]);
  }
  return diaValido(ano, mes, d) ? iso(ano, mes, d) : null;
}

/** `15 de agosto de 2026`, `3 de agosto`, `15 de ago`. */
function lerDataEscrita(bruto: string, agoraMs: number): string | null {
  const t = normalizar(bruto);
  const m = /^(\d{1,2})\s*(?:de\s+)?([a-z]+)(?:\s*(?:de\s+)?(\d{4}))?$/.exec(t);
  if (m === null) return null;
  const mes = MESES[m[2]];
  if (mes === undefined) return null;
  const d = Number(m[1]);
  const ano = m[3] === undefined ? anoParaMesSemAno(mes, agoraMs) : Number(m[3]);
  return diaValido(ano, mes, d) ? iso(ano, mes, d) : null;
}

/** Uma data, em qualquer das formas aceitas. */
function lerData(bruto: string, agoraMs: number): string | null {
  return lerDataNumerica(bruto, agoraMs) ?? lerDataEscrita(bruto, agoraMs);
}

function rotuloDeIntervalo(de: string, ate: string): string {
  const br = (d: string) => d.split("-").reverse().join("/");
  return de === ate ? br(de) : `${br(de)} a ${br(ate)}`;
}

/**
 * Resolve a expressao, ou devolve `null`.
 *
 * `null` NAO e erro deste modulo: e "nao sei o que isto quer dizer". Quem
 * chama recusa com `periodo_invalido`, que e corrigivel — o modelo tenta
 * de novo com palavras que a CDS entende, em vez de o turno morrer.
 *
 * ── A ordem das tentativas importa ─────────────────────────────────
 *
 * Do mais especifico para o mais geral. "ultima semana de agosto" tem de
 * ser lido antes de "semana" e antes de "agosto", senao um dos dois o
 * engole e a resposta e sobre outro periodo.
 */
export function resolverExpressaoDePeriodo(
  expressao: unknown,
  agoraMs: number
): PeriodoResolvido | null {
  if (typeof expressao !== "string") return null;
  const t = normalizar(expressao);
  if (t === "") return null;

  // ── 0. O proprio nome do enum, cru ──────────────────────────────
  if ((PERIODOS as readonly string[]).includes(t)) {
    return periodoNomeado(t as NomeDePeriodo, agoraMs);
  }

  // ── 1. "ultima semana de agosto [de 2026]" ──────────────────────
  {
    const m = /(?:ultima|derradeira)\s+semana\s+de\s+([a-z]+)(?:\s+de\s+(\d{4}))?/.exec(t);
    if (m !== null) {
      const mes = MESES[m[1]];
      if (mes !== undefined) {
        const ano = m[2] === undefined ? anoParaMesSemAno(mes, agoraMs) : Number(m[2]);
        const fim = iso(ano, mes, ultimoDiaDoMes(ano, mes));
        // Sete dias terminando no ultimo dia do mes. "Ultima semana de
        // agosto" e coloquial, e nao a semana ISO — quem pergunta quer os
        // ultimos sete dias do mes, e nao um pedaco que invade setembro.
        return {
          de: somarDias(fim, -6), ate: fim,
          rotulo: `última semana de ${NOME_DO_MES[mes]} de ${ano}`, fuso: FUSO_CDS,
        };
      }
    }
  }

  // ── 2. "ultimos N dias" ─────────────────────────────────────────
  {
    const m = /ultim[oa]s?\s+(\d{1,3})\s+dias?/.exec(t);
    if (m !== null) {
      const n = Number(m[1]);
      if (n >= 1 && n <= 366) {
        // §15: INCLUINDO hoje. Em 30/09, "ultimos 7 dias" e 24/09 a 30/09.
        // Sete dias contados de tras para frente com hoje dentro — e o que
        // uma pessoa quer dizer, e o que o §15 congelou.
        const hoje = hojeBRT(agoraMs).dia;
        return {
          de: somarDias(hoje, -(n - 1)), ate: hoje,
          rotulo: `últimos ${n} dias`, fuso: FUSO_CDS,
        };
      }
    }
  }

  // ── 3. Intervalo: "de X a/ate Y", "entre X e Y", "X - Y" ────────
  {
    const padroes: readonly RegExp[] = [
      /(?:de|desde)\s+(.+?)\s+(?:ate|a|at[eé])\s+(.+)/,
      /entre\s+(.+?)\s+e\s+(.+)/,
      /^(.+?)\s+(?:ate|a)\s+(.+)$/,
    ];
    for (const padrao of padroes) {
      const m = padrao.exec(t);
      if (m === null) continue;

      // "de 3 a 18 de agosto": o mes esta SO no fim. O inicio herda dele.
      const fim = lerData(m[2], agoraMs);
      if (fim === null) continue;
      let inicio = lerData(m[1], agoraMs);
      if (inicio === null) {
        const soDia = /^(\d{1,2})$/.exec(m[1].trim());
        if (soDia !== null) {
          const [a, mes] = fim.split("-").map(Number);
          const d = Number(soDia[1]);
          inicio = diaValido(a, mes, d) ? iso(a, mes, d) : null;
        }
      }
      if (inicio === null) continue;
      return inicio <= fim
        ? { de: inicio, ate: fim, rotulo: rotuloDeIntervalo(inicio, fim), fuso: FUSO_CDS }
        // Invertido nao vira silenciosamente o contrario: quem escreveu
        // "de 20 a 10" errou, e adivinhar a intencao seria inventar.
        : null;
    }
  }

  // ── 4. Um DIA: "dia 15/08/2026", "15/08/2026", "15 de agosto" ───
  {
    const limpo = t.replace(/^(?:no\s+|em\s+)?dia\s+/, "").replace(/^(?:no|em)\s+/, "");
    const dia = lerData(limpo, agoraMs);
    if (dia !== null) {
      return { de: dia, ate: dia, rotulo: rotuloDeIntervalo(dia, dia), fuso: FUSO_CDS };
    }
  }

  // ── 5. Periodo nomeado por sinonimo ─────────────────────────────
  for (const { nome, ditos } of SINONIMOS) {
    if (ditos.some((d) => t.includes(d))) return periodoNomeado(nome, agoraMs);
  }

  // ── 6. Mes inteiro: "agosto", "agosto de 2026", "em agosto/2026" ─
  //
  // Percorre TODAS as palavras, e nao a primeira: "em agosto de 2026"
  // comeca com "em", que nao e mes. Parar no primeiro candidato fazia a
  // expressao inteira virar `null` — o teste A1 pegou.
  {
    const palavras = /([a-z]+)(?:\s+de\s+(\d{4})|\/(\d{4}))?/g;
    for (let m = palavras.exec(t); m !== null; m = palavras.exec(t)) {
      const mes = MESES[m[1]];
      if (mes === undefined) continue;
      const ano = m[2] !== undefined ? Number(m[2])
        : m[3] !== undefined ? Number(m[3])
        : anoParaMesSemAno(mes, agoraMs);
      return {
        de: iso(ano, mes, 1), ate: iso(ano, mes, ultimoDiaDoMes(ano, mes)),
        rotulo: `${NOME_DO_MES[mes]} de ${ano}`, fuso: FUSO_CDS,
      };
    }
  }

  return null;
}
