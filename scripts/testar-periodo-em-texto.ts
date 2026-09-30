/**
 * AGENT-FACTORY-F7b.4.8.3 §12–§19 — o resolvedor de periodo.
 *
 * Suite PURA: sem rede, sem banco, sem IA. O relogio e FIXO.
 *
 * ── O relogio do teste ──────────────────────────────────────────────
 *
 * 30/09/2026, meio-dia em Sao Paulo — a data do teste do Rodrigo. Um
 * resolvedor de datas testado com `Date.now()` mede outra coisa a cada
 * dia, e "ultimos 7 dias" e exatamente uma pergunta sobre quando se
 * pergunta.
 *
 * Roda com: npx tsx scripts/testar-periodo-em-texto.ts
 */
import "./_server-only-inerte";

import { resolverExpressaoDePeriodo } from "../lib/agentes/funcoes/periodo-em-texto";

/** 2026-09-30, 12:00 em Sao Paulo (15:00 UTC). Uma QUARTA-feira. */
const AGORA = Date.UTC(2026, 8, 30, 15, 0, 0);

let pass = 0;
let fail = 0;
function ok(nome: string, cond: boolean, detalhe = ""): void {
  if (cond) { pass += 1; console.log(`  PASS  ${nome}`); }
  else { fail += 1; console.log(`  FAIL  ${nome}${detalhe ? `  — ${detalhe}` : ""}`); }
}
function secao(t: string): void { console.log(`\n${t}`); }

/** Resolve e compara o intervalo, imprimindo o que saiu quando difere. */
function intervalo(expressao: string): string {
  const r = resolverExpressaoDePeriodo(expressao, AGORA);
  return r === null ? "null" : `${r.de}..${r.ate}`;
}

console.log("══ F7b.4.8.3 — periodo em texto (relogio: 30/09/2026 BRT) ══");

// ─── A. As expressoes OBRIGATORIAS do §14 ────────────────────────────

secao("A. Todas as expressoes do §14");

{
  const esperado: readonly [string, string][] = [
    // Os sete nomeados — delegados a `calendario.ts`, a autoridade deles.
    ["hoje", "2026-09-30..2026-09-30"],
    ["ontem", "2026-09-29..2026-09-29"],
    // §16: semana de SEGUNDA a DOMINGO. 30/09/2026 e quarta.
    ["esta semana", "2026-09-28..2026-10-04"],
    ["semana passada", "2026-09-21..2026-09-27"],
    ["este mes", "2026-09-01..2026-09-30"],
    ["mes passado", "2026-08-01..2026-08-31"],
    ["este ano", "2026-01-01..2026-12-31"],

    // §15: "ultimos N dias" INCLUI hoje.
    ["ultimos 7 dias", "2026-09-24..2026-09-30"],
    ["últimos 7 dias", "2026-09-24..2026-09-30"],
    ["ultimos 15 dias", "2026-09-16..2026-09-30"],
    ["ultimos 30 dias", "2026-09-01..2026-09-30"],

    // Mes por nome, com e sem ano.
    ["agosto", "2026-08-01..2026-08-31"],
    ["agosto de 2026", "2026-08-01..2026-08-31"],
    ["em agosto de 2026", "2026-08-01..2026-08-31"],

    // §18: pt-BR — DIA primeiro. 15/09 e 15 de setembro.
    ["15/09/2026", "2026-09-15..2026-09-15"],
    ["dia 15/09/2026", "2026-09-15..2026-09-15"],
    ["no dia 15/08/2026", "2026-08-15..2026-08-15"],

    // Intervalos explicitos.
    ["de 10/09/2026 até 20/09/2026", "2026-09-10..2026-09-20"],
    ["de 10/09/2026 ate 20/09/2026", "2026-09-10..2026-09-20"],
    ["entre 01/08/2026 e 15/08/2026", "2026-08-01..2026-08-15"],
    // §19: sem ano, o mes esta so no FIM e o inicio herda dele.
    ["de 3 a 18 de agosto", "2026-08-03..2026-08-18"],

    // Coloquial.
    ["última semana de agosto", "2026-08-25..2026-08-31"],
  ];

  for (const [expressao, alvo] of esperado) {
    ok(`A1  "${expressao}" -> ${alvo}`, intervalo(expressao) === alvo, intervalo(expressao));
  }
}

// ─── B. §18: pt-BR nao e en-US ───────────────────────────────────────

secao("B. Data numerica e pt-BR — dia primeiro (§18)");

{
  const r = resolverExpressaoDePeriodo("10/09/2026", AGORA);
  ok("B1  10/09/2026 e 10 de SETEMBRO", r?.de === "2026-09-10", String(r?.de));
  ok("B2  e NAO 9 de outubro", r?.de !== "2026-10-09");
  // 25/12 so existe como dia/mes: se lido como mes/dia seria invalido.
  ok("B3  25/12/2026 e 25 de dezembro",
    resolverExpressaoDePeriodo("25/12/2026", AGORA)?.de === "2026-12-25");
  ok("B4  ANCORA: e o mes 13 nao existe — a leitura nao e mes/dia",
    resolverExpressaoDePeriodo("13/25/2026", AGORA) === null);
}

// ─── C. Recusas — o que o resolvedor NAO deve adivinhar ──────────────

secao("C. O que ele recusa, em vez de adivinhar");

{
  ok("C1  intervalo invertido NAO e silenciosamente trocado",
    resolverExpressaoDePeriodo("de 20/09/2026 até 10/09/2026", AGORA) === null);
  ok("C2  dia que nao existe e recusado",
    resolverExpressaoDePeriodo("31/02/2026", AGORA) === null);
  ok("C3  e 30/02 tambem",
    resolverExpressaoDePeriodo("30/02/2026", AGORA) === null);
  ok("C4  texto sem periodo nenhum devolve null",
    resolverExpressaoDePeriodo("quanto vendi", AGORA) === null);
  ok("C5  vazio devolve null", resolverExpressaoDePeriodo("", AGORA) === null);
  ok("C6  nao-string devolve null",
    resolverExpressaoDePeriodo(42, AGORA) === null &&
      resolverExpressaoDePeriodo(null, AGORA) === null);
  ok("C7  mes inventado devolve null",
    resolverExpressaoDePeriodo("em smarch de 2026", AGORA) === null);
  ok("C8  `ultimos 0 dias` nao vira intervalo vazio",
    resolverExpressaoDePeriodo("ultimos 0 dias", AGORA) === null);
}

// ─── D. §19: o ANO de uma data sem ano ───────────────────────────────

secao("D. Sem ano, a regra e deterministica — §19");

{
  // Em 30/09/2026: agosto JA passou -> 2026.
  ok("D1  em setembro, `agosto` e o agosto deste ano",
    resolverExpressaoDePeriodo("agosto", AGORA)?.de === "2026-08-01");
  // Dezembro ainda NAO comecou em setembro -> o dezembro mais recente e 2025.
  ok("D2  e `dezembro` e o do ano passado — nao o que nao aconteceu",
    resolverExpressaoDePeriodo("dezembro", AGORA)?.de === "2025-12-01",
    String(resolverExpressaoDePeriodo("dezembro", AGORA)?.de));
  ok("D3  setembro (o mes corrente) e deste ano",
    resolverExpressaoDePeriodo("setembro", AGORA)?.de === "2026-09-01");

  // Em JANEIRO de 2027, `agosto` continua sendo 2026.
  const janeiro2027 = Date.UTC(2027, 0, 15, 15, 0, 0);
  ok("D4  em janeiro/2027, `agosto` e agosto de 2026",
    resolverExpressaoDePeriodo("agosto", janeiro2027)?.de === "2026-08-01",
    String(resolverExpressaoDePeriodo("agosto", janeiro2027)?.de));
  ok("D5  e `janeiro` e o corrente, de 2027",
    resolverExpressaoDePeriodo("janeiro", janeiro2027)?.de === "2027-01-01");
}

// ─── E. Ano bissexto e bordas de mes ─────────────────────────────────

secao("E. Bordas de calendario");

{
  ok("E1  fevereiro de 2028 tem 29 dias (bissexto)",
    resolverExpressaoDePeriodo("fevereiro de 2028", AGORA)?.ate === "2028-02-29",
    String(resolverExpressaoDePeriodo("fevereiro de 2028", AGORA)?.ate));
  ok("E2  fevereiro de 2026 tem 28",
    resolverExpressaoDePeriodo("fevereiro de 2026", AGORA)?.ate === "2026-02-28");
  ok("E3  29/02/2028 existe",
    resolverExpressaoDePeriodo("29/02/2028", AGORA)?.de === "2028-02-29");
  ok("E4  e 29/02/2026 NAO existe",
    resolverExpressaoDePeriodo("29/02/2026", AGORA) === null);
  ok("E5  dezembro termina no dia 31",
    resolverExpressaoDePeriodo("dezembro de 2026", AGORA)?.ate === "2026-12-31");

  // "ultimos 30 dias" atravessando a virada de mes.
  const primeiroDeOutubro = Date.UTC(2026, 9, 1, 15, 0, 0);
  ok("E6  `ultimos 7 dias` em 01/10 volta para setembro",
    resolverExpressaoDePeriodo("ultimos 7 dias", primeiroDeOutubro)?.de === "2026-09-25",
    String(resolverExpressaoDePeriodo("ultimos 7 dias", primeiroDeOutubro)?.de));
}

// ─── F. O rotulo e para gente ────────────────────────────────────────

secao("F. O rotulo nao e um id");

{
  ok("F1  o intervalo explicito vira data brasileira",
    resolverExpressaoDePeriodo("de 10/09/2026 até 20/09/2026", AGORA)?.rotulo ===
      "10/09/2026 a 20/09/2026",
    String(resolverExpressaoDePeriodo("de 10/09/2026 até 20/09/2026", AGORA)?.rotulo));
  ok("F2  um dia so aparece sozinho",
    resolverExpressaoDePeriodo("15/08/2026", AGORA)?.rotulo === "15/08/2026");
  ok("F3  o mes aparece pelo NOME",
    resolverExpressaoDePeriodo("agosto de 2026", AGORA)?.rotulo === "agosto de 2026");
  ok("F4  e o nomeado usa o rotulo do calendario",
    resolverExpressaoDePeriodo("semana passada", AGORA)?.rotulo === "semana passada");
  ok("F5  o fuso viaja em todos",
    ["hoje", "agosto", "15/08/2026", "ultimos 7 dias"].every((e) =>
      resolverExpressaoDePeriodo(e, AGORA)?.fuso === "America/Sao_Paulo"));
}

// ─── G. Nenhuma expressao produz intervalo invertido ─────────────────

secao("G. Invariante: de <= ate, sempre");

{
  const todas = [
    "hoje", "ontem", "esta semana", "semana passada", "ultimos 7 dias",
    "ultimos 15 dias", "ultimos 30 dias", "este mes", "mes passado", "este ano",
    "agosto", "agosto de 2026", "15/09/2026", "dia 15/09/2026",
    "de 10/09/2026 até 20/09/2026", "entre 01/08/2026 e 15/08/2026",
    "de 3 a 18 de agosto", "última semana de agosto",
  ];
  const resolvidas = todas.map((e) => resolverExpressaoDePeriodo(e, AGORA));
  ok("G1  todas as expressoes do §14 resolvem",
    resolvidas.every((r) => r !== null),
    todas.filter((e) => resolverExpressaoDePeriodo(e, AGORA) === null).join(","));
  ok("G2  e em nenhuma o inicio passa do fim",
    resolvidas.every((r) => r === null || r.de <= r.ate));
  ok("G3  todas com data no formato AAAA-MM-DD",
    resolvidas.every((r) => r === null ||
      (/^\d{4}-\d{2}-\d{2}$/.test(r.de) && /^\d{4}-\d{2}-\d{2}$/.test(r.ate))));
  ok("G4  ANCORA: sao dezoito expressoes medidas", todas.length === 18);
}

console.log(`\nPASS ${pass}   FAIL ${fail}`);
process.exit(fail === 0 ? 0 : 1);
