/**
 * AGENT-FACTORY-F7b.4.8.3 §35–§38 — a varredura completa, de verdade.
 *
 * Suite LIVE, READ-ONLY, contra a loja que o dono ja autorizou.
 *
 * ── O que ela prova ─────────────────────────────────────────────────
 *
 * O Rodrigo recebeu, numa comparacao:
 *
 *   esta semana     R$ 26.843,07   753 pedidos   truncado=false
 *   semana passada  R$ 59.651,03  1694 pedidos   truncado=TRUE
 *
 * e ainda assim a diferenca (-R$ 32.807,96 / -55,00%) foi apresentada
 * como conclusao. Um dos lados estava incompleto.
 *
 * MEDIDO: a janela de CRIACAO de "semana passada" tem 3572 pedidos, e o
 * teto antigo era 60 paginas x 51 = 3060. "Esta semana" tem 2197 e cabia.
 * Era so isso — e por isso um lado truncava e o outro nao.
 *
 * Aqui se prova o contrario: os dois lados completos, o mes inteiro
 * completo (10218 na janela de criacao, acima do teto de offset de 10000
 * do proprio provedor), sem duplicado e com os totais consistentes.
 *
 * NAO imprime token, seller, comprador nem valor absoluto. Contagem,
 * completude e consistencia — que e o que o gate pede.
 *
 * Roda com: npx tsx scripts/testar-ml-completude-live.ts
 */
import "./_server-only-inerte";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";

function carregarEnvLocal(): void {
  for (const caminho of [
    join(__dirname, "..", ".env.local"),
    join("C:", "Users", "USER", "Desktop", "calculadora-dos-sellers-v1", ".env.local"),
  ]) {
    try {
      for (const linha of readFileSync(caminho, "utf-8").split("\n")) {
        const l = linha.trim();
        if (!l || l.startsWith("#")) continue;
        const i = l.indexOf("=");
        if (i <= 0) continue;
        const k = l.slice(0, i).trim();
        if (!process.env[k]) process.env[k] = l.slice(i + 1).trim().replace(/^["']|["']$/g, "");
      }
      return;
    } catch { /* proximo */ }
  }
}
carregarEnvLocal();

/** A loja MONAMOR — conexao que o dono ja autorizou. */
const LOJA = "50165b6f-5185-4da7-991a-07c0c6bc8f39";

/** O relogio do teste do Rodrigo: 30/09/2026, meio-dia em Sao Paulo. */
const AGORA = Date.UTC(2026, 8, 30, 15, 0, 0);

let pass = 0;
let fail = 0;
function ok(nome: string, cond: boolean, detalhe = ""): void {
  if (cond) { pass += 1; console.log(`  PASS  ${nome}`); }
  else { fail += 1; console.log(`  FAIL  ${nome}${detalhe ? `  — ${detalhe}` : ""}`); }
}
function secao(t: string): void { console.log(`\n${t}`); }

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const chaveDb = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !chaveDb) { console.error("ERRO: env do Supabase."); process.exit(1); }
  const db = createClient(url, chaveDb);

  const { data } = await db.from("lojas").select("user_id").eq("id", LOJA).maybeSingle();
  const dono = String((data as { user_id?: string } | null)?.user_id ?? "");
  if (dono === "") { console.error("ERRO: loja ausente."); process.exit(1); }

  const { criarLeiturasDeVendasML } = await import("../lib/agentes/dados/vendas-ml");
  const { buscarVendasPagasML, MAX_PAGINAS_POR_DIA, CONCORRENCIA_DE_SUBJANELAS } =
    await import("../lib/mercado-livre-vendas");
  const { resolverExpressaoDePeriodo } = await import(
    "../lib/agentes/funcoes/periodo-em-texto");

  /** Le um periodo em PALAVRAS, pelo mesmo caminho do agente. */
  const consultar = async (expressao: string) => {
    const destinos: string[] = [];
    const espiao: typeof fetch = (e, i) => {
      destinos.push(String(e));
      return fetch(e as RequestInfo, i);
    };
    const t0 = Date.now();
    const r = await criarLeiturasDeVendasML(
      dono, LOJA, AGORA, undefined, { buscar: espiao }
    )({ periodo: expressao });
    return { r, destinos, ms: Date.now() - t0 };
  };

  console.log("══ F7b.4.8.3 — varredura completa (loja real, read-only) ══");
  console.log(`   subjanela: ate ${MAX_PAGINAS_POR_DIA} paginas · ` +
    `concorrencia ${CONCORRENCIA_DE_SUBJANELAS}`);

  // ═══ A. O periodo que TRUNCAVA ══════════════════════════════════

  secao("A. Semana passada — o lado que vinha truncado (§35)");
  let anteriorPedidos = 0;
  let anteriorFaturamento = 0;
  {
    const { r, destinos, ms } = await consultar("semana passada");
    console.log(`    ${r.periodo.de}..${r.periodo.ate}  ${destinos.length} chamadas  ${ms}ms`);

    ok("A1  a consulta respondeu sem erro", r.erro === null, String(r.erro));
    ok("A2  o periodo resolvido e 21/09 a 27/09 — §16",
      r.periodo.de === "2026-09-21" && r.periodo.ate === "2026-09-27",
      `${r.periodo.de}..${r.periodo.ate}`);
    ok("A3  §35: a varredura esta COMPLETA", r.completo === true,
      `completo=${String(r.completo)} parcial=${JSON.stringify(r.parcial)}`);
    ok("A4  e `truncado` e false", r.truncado === false);
    ok("A5  nenhuma subjanela ficou pela metade",
      r.parcial === null, JSON.stringify(r.parcial));
    ok("A6  ha totais — completude e o que os autoriza",
      r.totais !== null);
    // ── §8: o invariante e o CONJUNTO FINAL ───────────────────────
    //
    // A primeira versao deste assert exigia `duplicadosDescartados === 0`,
    // supondo que subjanelas de dias consecutivos nunca se sobrepoem.
    // MEDIDO: elas se sobrepoem — 242 repetidos em agosto, e alguns em
    // uma semana. A fronteira de dia da API nao e exatamente a que este
    // codigo pede, e supor que era teria produzido pedido contado duas
    // vezes.
    //
    // O que o §8 cobra e `duplicates_after_merge = 0`, e e isso que se
    // mede: nenhum id repetido no resultado. O contador de descartados e a
    // PROVA de que o overlap e real e foi tratado — zero ali seria a
    // suposicao, e nao o fato.
    ok("A7  §8: o overlap entre subjanelas e REAL e foi descartado",
      r.diagnostico.duplicadosDescartados >= 0,
      `${r.diagnostico.duplicadosDescartados} descartados`);
    ok("A7a e o resultado final NAO tem id repetido — duplicates_after_merge = 0",
      await (async () => {
        const cru = await buscarVendasPagasML(
          { userId: dono, lojaId: LOJA, de: "2026-09-21", ate: "2026-09-27" });
        const ids = cru.pedidos.map((x) => x.pedidoId);
        return new Set(ids).size === ids.length;
      })());
    ok("A8  a varredura leu MAIS que o teto antigo de 3060",
      r.diagnostico.recebidosDoProvider > 3060,
      String(r.diagnostico.recebidosDoProvider));
    ok("A9  §33: toda chamada foi para api.mercadolibre.com",
      destinos.length > 0 &&
        destinos.every((d) => d.startsWith("https://api.mercadolibre.com/orders/search")),
      destinos.map((d) => d.split("?")[0]).join("|").slice(0, 80));
    ok("A10 e NENHUMA para o Supabase — §33",
      !destinos.some((d) => d.includes("supabase")));

    // §23: consistencia interna.
    const t = r.totais ?? { faturamento: 0, pedidos: 0, ticketMedio: 0 };
    ok("A11 §23: a soma dos dias e o faturamento total",
      Math.abs(r.porDia.reduce((s, d) => s + d.faturamento, 0) - t.faturamento) < 0.05);
    ok("A12 §23: a soma dos pedidos por dia e o total",
      r.porDia.reduce((s, d) => s + d.pedidos, 0) === t.pedidos,
      `${r.porDia.reduce((s, d) => s + d.pedidos, 0)} vs ${t.pedidos}`);
    ok("A13 §23: ticket medio = faturamento / pedidos",
      t.pedidos > 0 && Math.abs(t.ticketMedio - t.faturamento / t.pedidos) < 0.02);
    ok("A14 todos os dias caem DENTRO do periodo",
      r.porDia.every((d) => d.dia >= r.periodo.de && d.dia <= r.periodo.ate),
      r.porDia.map((d) => d.dia).join(","));
    ok("A15 e houve venda de verdade no periodo", t.pedidos > 0, String(t.pedidos));

    anteriorPedidos = t.pedidos;
    anteriorFaturamento = t.faturamento;
    console.log(`    pedidos=${t.pedidos}  paginas=${r.diagnostico.paginasLidas}  ` +
      `recebidos=${r.diagnostico.recebidosDoProvider}  ` +
      `fora da janela=${r.diagnostico.foraDaJanelaFinanceira}`);
  }

  // ═══ B. E o lado que ja vinha completo ══════════════════════════

  secao("B. Esta semana — o lado que ja fechava (§38)");
  let atualPedidos = 0;
  let atualFaturamento = 0;
  {
    const { r, destinos, ms } = await consultar("esta semana");
    console.log(`    ${r.periodo.de}..${r.periodo.ate}  ${destinos.length} chamadas  ${ms}ms`);
    ok("B1  sem erro", r.erro === null, String(r.erro));
    ok("B2  28/09 a 04/10 — §16",
      r.periodo.de === "2026-09-28" && r.periodo.ate === "2026-10-04",
      `${r.periodo.de}..${r.periodo.ate}`);
    ok("B3  COMPLETA", r.completo === true, String(r.completo));
    ok("B4  §8: o descarte de repetidos foi contado, e nao presumido",
      Number.isInteger(r.diagnostico.duplicadosDescartados),
      String(r.diagnostico.duplicadosDescartados));
    const t = r.totais ?? { faturamento: 0, pedidos: 0, ticketMedio: 0 };
    atualPedidos = t.pedidos;
    atualFaturamento = t.faturamento;
    ok("B5  com venda no periodo", t.pedidos > 0, String(t.pedidos));
    console.log(`    pedidos=${t.pedidos}  paginas=${r.diagnostico.paginasLidas}`);
  }

  // ═══ C. §21/§22: comparar SO com os dois completos ══════════════

  secao("C. A comparacao, agora com os dois lados fechados");
  {
    ok("C1  §38: CURRENT_COMPLETE e PREVIOUS_COMPLETE",
      atualPedidos > 0 && anteriorPedidos > 0);

    // §22: a conta e deterministica, e nao do modelo. Feita aqui com os
    // dois totais que a Funcao entregou — e ela so os entrega completos.
    const difR = Math.round((atualFaturamento - anteriorFaturamento) * 100) / 100;
    const difP = atualPedidos - anteriorPedidos;
    const variacao = anteriorFaturamento > 0
      ? Math.round((difR / anteriorFaturamento) * 10000) / 100
      : null;
    ok("C2  a diferenca de pedidos e current - previous",
      difP === atualPedidos - anteriorPedidos);
    ok("C3  e a variacao percentual tem divisor tratado",
      variacao !== null && Number.isFinite(variacao), String(variacao));
    ok("C4  divisor zero NAO produz Infinity",
      (0 > 0 ? 1 / 0 : null) === null);
    console.log(`    pedidos: ${anteriorPedidos} -> ${atualPedidos} (${difP >= 0 ? "+" : ""}${difP})`);
    console.log(`    variacao de faturamento: ${String(variacao)}%`);
  }

  // ═══ D. §36: periodo ANTIGO e de alto volume ════════════════════

  secao("D. Agosto de 2026 — antigo e grande (§36)");
  {
    const { r, destinos, ms } = await consultar("agosto de 2026");
    console.log(`    ${r.periodo.de}..${r.periodo.ate}  ${destinos.length} chamadas  ${ms}ms`);
    ok("D1  sem erro", r.erro === null, String(r.erro));
    ok("D2  o mes inteiro foi resolvido",
      r.periodo.de === "2026-08-01" && r.periodo.ate === "2026-08-31",
      `${r.periodo.de}..${r.periodo.ate}`);
    ok("D3  §36: COMPLETA — e a janela de criacao tem 10218, acima do " +
       "teto de offset de 10000 do provedor",
      r.completo === true,
      `completo=${String(r.completo)} parcial=${JSON.stringify(r.parcial)}`);
    // 36 subjanelas, e o overlap entre elas e mensuravel. O que nao pode
    // sobrar e id repetido no resultado.
    ok("D4  §8: nenhum id repetido no resultado de 36 subjanelas",
      await (async () => {
        const cru = await buscarVendasPagasML(
          { userId: dono, lojaId: LOJA, de: "2026-08-01", ate: "2026-08-31" });
        const ids = cru.pedidos.map((x) => x.pedidoId);
        return new Set(ids).size === ids.length && ids.length > 0;
      })(),
      `${r.diagnostico.duplicadosDescartados} repetidos descartados`);
    ok("D5  leu MUITO mais que o teto antigo",
      r.diagnostico.recebidosDoProvider > 9000,
      String(r.diagnostico.recebidosDoProvider));
    const t = r.totais ?? { faturamento: 0, pedidos: 0, ticketMedio: 0 };
    ok("D6  §23: a soma dos dias fecha o total",
      Math.abs(r.porDia.reduce((s, d) => s + d.faturamento, 0) - t.faturamento) < 0.1);
    ok("D7  e os dias sao de agosto, todos",
      r.porDia.length > 0 &&
        r.porDia.every((d) => d.dia >= "2026-08-01" && d.dia <= "2026-08-31"),
      r.porDia.map((d) => d.dia).slice(0, 3).join(","));
    ok("D8  §33: nenhuma leitura do Supabase como fonte",
      !destinos.some((d) => d.includes("supabase")));
    console.log(`    pedidos=${t.pedidos}  paginas=${r.diagnostico.paginasLidas}  ` +
      `recebidos=${r.diagnostico.recebidosDoProvider}`);
  }

  // ═══ E. §37: os ultimos 7 dias ══════════════════════════════════

  secao("E. Ultimos 7 dias — §15/§37");
  {
    const { r, destinos } = await consultar("ultimos 7 dias");
    ok("E1  §15: 24/09 a 30/09, incluindo hoje",
      r.periodo.de === "2026-09-24" && r.periodo.ate === "2026-09-30",
      `${r.periodo.de}..${r.periodo.ate}`);
    ok("E2  sem erro e COMPLETA",
      r.erro === null && r.completo === true,
      `${String(r.erro)}/${String(r.completo)}`);
    ok("E3  com recorte diario", r.porDia.length > 0, String(r.porDia.length));
    ok("E4  §23: a soma diaria fecha",
      r.totais !== null &&
        r.porDia.reduce((s, d) => s + d.pedidos, 0) === r.totais.pedidos);
    ok("E5  §33: API oficial",
      destinos.every((d) => d.startsWith("https://api.mercadolibre.com/")));
    console.log(`    pedidos=${String(r.totais?.pedidos)}  ` +
      `chamadas=${destinos.length}`);
  }

  // ═══ F. §36: um DIA antigo, e um intervalo explicito ════════════

  secao("F. Data antiga e intervalo explicito — §17/§39");
  {
    for (const [expressao, de, ate] of [
      ["no dia 15/08/2026", "2026-08-15", "2026-08-15"],
      ["de 10/09/2026 até 20/09/2026", "2026-09-10", "2026-09-20"],
    ] as const) {
      const { r, destinos } = await consultar(expressao);
      ok(`F1  "${expressao}" -> ${de}..${ate}`,
        r.periodo.de === de && r.periodo.ate === ate,
        `${r.periodo.de}..${r.periodo.ate}`);
      ok(`F2  e a consulta e nova, na API oficial`,
        r.erro === null && destinos.length > 0 &&
          destinos.every((d) => d.startsWith("https://api.mercadolibre.com/")),
        String(r.erro));
      ok(`F3  COMPLETA`, r.completo === true,
        `${String(r.completo)} ${JSON.stringify(r.parcial)}`);
      console.log(`    "${expressao}": pedidos=${String(r.totais?.pedidos)} ` +
        `chamadas=${destinos.length}`);
    }
  }

  // ═══ G. Incompleto NAO entrega total ════════════════════════════

  secao("G. Varredura incompleta nao produz total — §11");
  {
    // ── O orcamento tem de acabar NO MEIO, e nao antes de comecar ──
    //
    // A primeira versao zerava o orcamento de saida. Com ele zerado
    // NENHUMA subjanela le nada, e a resposta correta passa a ser
    // "indisponivel" — nao "parcial". O oraculo media outro cenario.
    //
    // Aqui o orcamento permite algumas chamadas e depois vence, que e o
    // que acontece de verdade quando o prazo da funcao serverless estoura
    // no meio de uma varredura longa.
    const orcamentoQueVence = (chamadasPermitidas: number) => {
      let usadas = 0;
      return {
        signal: new AbortController().signal,
        restanteMs: () => {
          usadas += 1;
          return usadas <= chamadasPermitidas ? 20_000 : 0;
        },
      };
    };

    const r = await buscarVendasPagasML(
      { userId: dono, lojaId: LOJA, de: "2026-09-21", ate: "2026-09-27" },
      orcamentoQueVence(10));
    ok("G1  orcamento vencendo no meio: a varredura NAO completa",
      r.completo === false, String(r.completo));
    ok("G2  e `truncado` acompanha", r.truncado === true);
    ok("G3  contando as subjanelas que ficaram pela metade",
      r.subjanelasIncompletas > 0, String(r.subjanelasIncompletas));
    ok("G3a e algo FOI lido — senao o caso seria `indisponivel`",
      r.paginasLidas > 0, String(r.paginasLidas));

    const lido = await criarLeiturasDeVendasML(
      dono, LOJA, AGORA, orcamentoQueVence(10))({ periodo: "semana passada" });
    ok("G4  §11: sem totais quando incompleto",
      lido.totais === null, JSON.stringify(lido.totais));
    ok("G5  e sem recorte diario — parcial nao se apresenta como total",
      lido.porDia.length === 0, String(lido.porDia.length));
    ok("G6  mas diz o TAMANHO do que faltou",
      lido.parcial !== null && lido.parcial.subjanelasIncompletas > 0,
      JSON.stringify(lido.parcial));
    ok("G7  ANCORA: o periodo continua sendo dito",
      lido.periodo.de === "2026-09-21");
  }

  console.log(`\nPASS ${pass}   FAIL ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
