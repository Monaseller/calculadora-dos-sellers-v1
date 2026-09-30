/**
 * AGENT-FACTORY-F7b.4.8.3 §8/§11 — a varredura sob provedor hostil.
 *
 * PURA: sem rede, sem banco, sem IA. O provedor e um duble, e e nele que
 * estao os comportamentos que a API real mostrou ter e que uma suite live
 * nao consegue provocar sob demanda.
 *
 * ── O que a medicao real encontrou, e que aqui se reproduz ──────────
 *
 *   1. pagina curta NO MEIO       uma resposta com menos de 51 linhas sem
 *                                 ser a ultima. O desenho antigo parava
 *                                 ali e dizia "completo".
 *   2. linha perdida por empate   09/07: 476 lidas, `paging.total` 477,
 *                                 uma duplicada. Intermitente, 2 em 4
 *                                 varreduras.
 *   3. 429 sob concorrencia       3 dias de uma passada em ondas de 6.
 *                                 Era tratado como erro de CONTA e
 *                                 abortava a consulta inteira.
 *
 * Roda com: npx tsx scripts/testar-ml-varredura-robusta.ts
 */
import "./_server-only-inerte";

import {
  buscarVendasPagasML, MAX_PAGINAS_POR_DIA, TENTATIVAS_POR_DIA,
  TENTATIVAS_APOS_429, CONCORRENCIA_DE_SUBJANELAS,
} from "../lib/mercado-livre-vendas";

let pass = 0;
let fail = 0;
function ok(nome: string, cond: boolean, detalhe = ""): void {
  if (cond) { pass += 1; console.log(`  PASS  ${nome}`); }
  else { fail += 1; console.log(`  FAIL  ${nome}${detalhe ? `  — ${detalhe}` : ""}`); }
}
function secao(t: string): void { console.log(`\n${t}`); }

const CREDENCIAL = {
  accessToken: "token-de-duble", sellerId: "1", id: "loja", userId: "dono",
} as unknown as Awaited<ReturnType<typeof import("../lib/ml-auth").getMLLojaById>>;

/** Um pedido pago no dia, com o valor pedido. */
function pedido(id: number, dia: string, valor: number, statusPag = "approved") {
  return {
    id,
    status: "paid",
    paid_amount: valor,
    date_created: `${dia}T10:00:00.000-03:00`,
    payments: [{ status: statusPag, date_approved: `${dia}T12:00:00.000-03:00` }],
  };
}

/** Uma resposta do duble: erro HTTP, ou um lote com o total relatado. */
type Resposta =
  | { readonly status: number }
  | { readonly ids: readonly number[]; readonly total?: number | null };

/**
 * Um provedor de mentira que responde por OFFSET, e nao por ordem de
 * chamada.
 *
 * A primeira versao deste duble respondia por indice — a n-esima chamada
 * devolvia a n-esima pagina do roteiro. Isso reprovou quatro asserções
 * corretas: a pagina de sobra do roteiro relatava `paging.total = 0`, e
 * "li 10 de 0" fecha como completo. O defeito era do instrumento.
 *
 * Um provedor de verdade e uma funcao de `(offset, janela)`, e o roteiro
 * tem de ser isso. A passada entra porque o fenomeno medido — empate na
 * fronteira de pagina — muda de uma passada para a outra.
 */
function dubleDeProvedor(
  roteiros: Record<string, (offset: number, passada: number) => Resposta>,
  chamadas: Record<string, number>
) {
  const urls: string[] = [];
  /** Quantas passadas por dia. Uma passada nova comeca no offset zero. */
  const passadas: Record<string, number> = {};
  const buscar: typeof fetch = async (entrada) => {
    const url = new URL(String(entrada));
    urls.push(String(entrada));
    const dia = String(url.searchParams.get("order.date_created.from") ?? "").slice(0, 10);
    const offset = Number(url.searchParams.get("offset") ?? "0");
    chamadas[dia] = (chamadas[dia] ?? 0) + 1;
    if (offset === 0) passadas[dia] = (passadas[dia] ?? 0) + 1;

    const roteiro = roteiros[dia];
    const r: Resposta = roteiro === undefined
      ? { ids: [], total: 0 }
      : roteiro(offset, passadas[dia] ?? 1);
    if ("status" in r) return new Response("{}", { status: r.status });

    const corpo: Record<string, unknown> = {
      results: r.ids.map((id) => pedido(id, dia, 10)),
    };
    if (r.total !== null && r.total !== undefined) corpo.paging = { total: r.total };
    return new Response(JSON.stringify(corpo), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  };
  return { buscar, urls, passadas };
}

/**
 * Um dia normal de `n` pedidos, paginado de verdade.
 *
 * `omitirTotal` reproduz um provedor que nao devolve `paging`.
 */
function diaDe(n: number, omitirTotal = false) {
  return (offset: number): Resposta => ({
    ids: ids(1 + offset, Math.max(0, Math.min(51, n - offset))),
    total: omitirTotal ? null : n,
  });
}

/** Uma lista de n ids comecando em `de`. */
function ids(de: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => de + i);
}

const PORTAS_BASE = {
  resolverCredencial: async () => CREDENCIAL,
};

async function main(): Promise<void> {
  console.log("══ F7b.4.8.3 — a varredura sob provedor hostil ══");

  // ═══ A. As constantes que a medicao fixou ════════════════════════

  secao("A. O desenho que a medicao real impos");
  ok("A1  concorrencia CAIU para 3 — ondas de 6 deram 429",
    CONCORRENCIA_DE_SUBJANELAS === 3, String(CONCORRENCIA_DE_SUBJANELAS));
  ok("A2  ha releitura de dia curto", TENTATIVAS_POR_DIA >= 2,
    String(TENTATIVAS_POR_DIA));
  ok("A3  e espera apos 429", TENTATIVAS_APOS_429 >= 1,
    String(TENTATIVAS_APOS_429));
  ok("A4  o teto de paginas por dia cabe TENTATIVAS_POR_DIA passadas de um dia pesado",
    MAX_PAGINAS_POR_DIA >= TENTATIVAS_POR_DIA * 12,
    `${MAX_PAGINAS_POR_DIA} vs ${TENTATIVAS_POR_DIA} x 12`);

  // ═══ B. `order.status` nao e mais enviado ════════════════════════

  secao("B. A autoridade e o pagamento — nenhum `order.status` na URL");
  {
    const contador: Record<string, number> = {};
    const { buscar, urls } = dubleDeProvedor({
      "2026-08-10": diaDe(2),
    }, contador);
    const r = await buscarVendasPagasML(
      { userId: "dono", lojaId: "loja", de: "2026-08-10", ate: "2026-08-10" },
      undefined, { ...PORTAS_BASE, buscar });
    ok("B1  a consulta funciona", r.erro === null && r.completo === true,
      `${String(r.erro)} completo=${String(r.completo)}`);
    ok("B2  §10: NENHUMA chamada manda `order.status`",
      urls.length > 0 && urls.every((u) => !u.includes("order.status")),
      urls[0]?.split("?")[1]?.slice(0, 80) ?? "(sem url)");
    ok("B3  ANCORA: o duble VIU as chamadas — o teste nao e vazio",
      urls.length >= 1, String(urls.length));
    ok("B4  e a janela de criacao continua sendo enviada",
      urls.every((u) => u.includes("order.date_created.from")));
  }

  // ═══ C. Pagina curta NO MEIO nao encerra o dia ═══════════════════

  secao("C. Pagina curta no meio — §8");
  {
    const contador: Record<string, number> = {};
    // 60 pedidos no dia. A pagina do offset 0 volta com 40 (curta!), e o
    // desenho antigo pararia ali, dizendo "completo" com 40 de 60.
    const { buscar } = dubleDeProvedor({
      "2026-08-10": (offset) => ({
        total: 60,
        ids: offset === 0 ? ids(1, 40) : ids(1 + offset, Math.max(0, 60 - offset)),
      }),
    }, contador);
    const r = await buscarVendasPagasML(
      { userId: "dono", lojaId: "loja", de: "2026-08-10", ate: "2026-08-10" },
      undefined, { ...PORTAS_BASE, buscar });
    ok("C1  a varredura CONTINUOU depois da pagina curta",
      r.pedidos.length === 60, `${r.pedidos.length}`);
    ok("C2  e se declara completa, porque alcancou o total do dia",
      r.completo === true && r.truncado === false);
    ok("C3  §8: o offset andou pelo que VEIO (40), e nao pelo que se pediu",
      contador["2026-08-10"] === 2 || contador["2026-08-10"] === 3,
      `${contador["2026-08-10"]} chamadas`);
    ok("C4  nenhum duplicado", r.duplicadosDescartados === 0,
      String(r.duplicadosDescartados));
  }

  // ═══ D. Contagem curta: releitura, e ela resolve ═════════════════

  secao("D. Linha perdida por empate — a releitura encontra");
  {
    const contador: Record<string, number> = {};
    // Passada 1: 51 + 8 = 59 lidas, e o total relatado e 60. Falta uma —
    // e a fronteira da pagina engoliu justamente ela.
    // Passada 2: os empates caem de outro jeito, e a que faltava aparece.
    const { buscar } = dubleDeProvedor({
      "2026-08-10": (offset, passada) => {
        if (passada === 1) {
          if (offset === 0) return { total: 60, ids: ids(1, 51) };
          if (offset === 51) return { total: 60, ids: ids(52, 8) };
          return { total: 60, ids: [] };
        }
        if (offset === 0) return { total: 60, ids: ids(1, 51) };
        if (offset === 51) return { total: 60, ids: [...ids(52, 8), 999] };
        return { total: 60, ids: [] };
      },
    }, contador);
    const r = await buscarVendasPagasML(
      { userId: "dono", lojaId: "loja", de: "2026-08-10", ate: "2026-08-10" },
      undefined, { ...PORTAS_BASE, buscar });
    ok("D1  a releitura aconteceu — houve mais de uma passada",
      (contador["2026-08-10"] ?? 0) >= 3, `${contador["2026-08-10"]} chamadas`);
    ok("D2  e a linha que faltava entrou", r.pedidos.length === 60,
      `${r.pedidos.length}`);
    ok("D3  a varredura se declara completa", r.completo === true);
    ok("D4  §8: e a releitura NAO inflou `duplicadosDescartados`",
      r.duplicadosDescartados === 0, String(r.duplicadosDescartados));
  }

  // ═══ E. Curta ATE O FIM: incompleta, e sem total ═════════════════

  secao("E. A perda que nao se resolve — §11");
  {
    const contador: Record<string, number> = {};
    // Sempre 59 de 60, em toda passada. Nao ha o que fazer alem de admitir.
    const { buscar } = dubleDeProvedor({
      "2026-08-10": (offset) => {
        if (offset === 0) return { total: 60, ids: ids(1, 51) };
        if (offset === 51) return { total: 60, ids: ids(52, 8) };
        return { total: 60, ids: [] };
      },
    }, contador);
    const r = await buscarVendasPagasML(
      { userId: "dono", lojaId: "loja", de: "2026-08-10", ate: "2026-08-10" },
      undefined, { ...PORTAS_BASE, buscar });
    ok("E1  tentou TENTATIVAS_POR_DIA passadas, e nao mais",
      (contador["2026-08-10"] ?? 0) === TENTATIVAS_POR_DIA * 3,
      `${contador["2026-08-10"]} chamadas`);
    ok("E2  §11: a varredura NAO se declara completa",
      r.completo === false && r.truncado === true);
    ok("E3  contando a subjanela que ficou curta",
      r.subjanelasIncompletas === 1, String(r.subjanelasIncompletas));
    ok("E4  e o que FOI lido continua ali — nada se joga fora",
      r.pedidos.length === 59, `${r.pedidos.length}`);
  }

  // ═══ F. `paging.total` ausente = sem afirmacao de completude ═════

  secao("F. Sem total nao ha conferencia — fail-closed");
  {
    const contador: Record<string, number> = {};
    const { buscar } = dubleDeProvedor({
      "2026-08-10": diaDe(10, true),
    }, contador);
    const r = await buscarVendasPagasML(
      { userId: "dono", lojaId: "loja", de: "2026-08-10", ate: "2026-08-10" },
      undefined, { ...PORTAS_BASE, buscar });
    ok("F1  leu o que havia", r.pedidos.length === 10, `${r.pedidos.length}`);
    ok("F2  e NAO afirma completude sem ter o que conferir",
      r.completo === false, String(r.completo));

    // CONTROLE: o MESMO roteiro com total presente fecha completo. Sem
    // isso, F2 poderia estar passando por qualquer outro motivo.
    const c2: Record<string, number> = {};
    const d2 = dubleDeProvedor({ "2026-08-10": diaDe(10) }, c2);
    const r2 = await buscarVendasPagasML(
      { userId: "dono", lojaId: "loja", de: "2026-08-10", ate: "2026-08-10" },
      undefined, { ...PORTAS_BASE, buscar: d2.buscar });
    ok("F3  CONTROLE: com `paging.total`, o mesmo dia fecha completo",
      r2.completo === true && r2.pedidos.length === 10,
      `completo=${String(r2.completo)} n=${r2.pedidos.length}`);
  }

  // ═══ G. 429 espera; 401 condena ══════════════════════════════════

  secao("G. 429 pede calma, 401 fala da conta");
  {
    const contador: Record<string, number> = {};
    // A primeira tentativa do offset zero leva 429; a segunda responde.
    let primeira = true;
    const { buscar } = dubleDeProvedor({
      "2026-08-10": (offset) => {
        if (offset === 0 && primeira) { primeira = false; return { status: 429 }; }
        return diaDe(3)(offset);
      },
    }, contador);
    const t0 = Date.now();
    const r = await buscarVendasPagasML(
      { userId: "dono", lojaId: "loja", de: "2026-08-10", ate: "2026-08-10" },
      undefined, { ...PORTAS_BASE, buscar });
    const ms = Date.now() - t0;
    ok("G1  429 NAO derruba a consulta", r.erro === null, String(r.erro));
    ok("G2  a pagina foi pedida de novo e o dia fechou",
      r.completo === true && r.pedidos.length === 3,
      `completo=${String(r.completo)} n=${r.pedidos.length}`);
    ok("G3  e houve espera de verdade entre as tentativas", ms >= 400, `${ms}ms`);
  }
  {
    const contador: Record<string, number> = {};
    // 429 em TODA chamada. O dia nunca le pagina nenhuma.
    const { buscar } = dubleDeProvedor({
      "2026-08-10": () => ({ status: 429 }),
      // Um segundo dia que RESPONDE: sem ele o resultado seria
      // `indisponivel` por "nenhum dia leu nada", e a asserção nao
      // distinguiria "429 nao e fatal" de "tudo falhou".
      "2026-08-11": diaDe(2),
    }, contador);
    const r = await buscarVendasPagasML(
      { userId: "dono", lojaId: "loja", de: "2026-08-10", ate: "2026-08-11" },
      undefined, { ...PORTAS_BASE, buscar });
    ok("G4  429 insistente NAO condena a consulta — o outro dia respondeu",
      r.erro === null, String(r.erro));
    ok("G4a mas o dia dele fica incompleto, e por isso nao ha total",
      r.completo === false && r.subjanelasIncompletas === 1,
      `completo=${String(r.completo)} incompletas=${r.subjanelasIncompletas}`);
    ok("G4b e o dia que respondeu foi lido", r.pedidos.length === 2,
      String(r.pedidos.length));
    ok("G5  a espera foi tentada o numero declarado de vezes, por passada",
      (contador["2026-08-10"] ?? 0) >= TENTATIVAS_APOS_429 + 1,
      `${contador["2026-08-10"]}`);
  }
  {
    const contador: Record<string, number> = {};
    const { buscar } = dubleDeProvedor({
      "2026-08-10": () => ({ status: 401 }),
      "2026-08-11": diaDe(1),
    }, contador);
    const r = await buscarVendasPagasML(
      { userId: "dono", lojaId: "loja", de: "2026-08-10", ate: "2026-08-11" },
      undefined, { ...PORTAS_BASE, buscar });
    ok("G6  401 condena a consulta inteira — e da conta, nao do dia",
      r.erro === "nao_autorizado", String(r.erro));
    ok("G7  e nada e apresentado: sem pedidos e sem completude",
      r.pedidos.length === 0 && r.completo === false,
      `n=${r.pedidos.length} completo=${String(r.completo)}`);
  }

  // ═══ H. O recorte financeiro nao mudou ═══════════════════════════

  secao("H. Quem conta continua sendo o pagamento");
  {
    const contador: Record<string, number> = {};
    const diaBom = "2026-08-10";
    const buscarLocal: typeof fetch = async (entrada) => {
      const url = new URL(String(entrada));
      const dia = String(url.searchParams.get("order.date_created.from") ?? "").slice(0, 10);
      const n = contador[dia] ?? 0;
      contador[dia] = n + 1;
      if (n > 0) {
        return new Response(JSON.stringify({ paging: { total: 4 }, results: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        paging: { total: 4 },
        results: [
          pedido(1, diaBom, 100, "approved"),
          pedido(2, diaBom, 50, "partially_refunded"),
          pedido(3, diaBom, 30, "refunded"),
          pedido(4, diaBom, 20, "in_mediation"),
        ],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const r = await buscarVendasPagasML(
      { userId: "dono", lojaId: "loja", de: diaBom, ate: diaBom },
      undefined, { ...PORTAS_BASE, buscar: buscarLocal });
    ok("H1  a varredura completou", r.completo === true, String(r.completo));
    const valores = r.pedidos.map((p) => p.valorPago).sort((a, b) => b - a);
    ok("H2  `approved` conta", valores.includes(100), valores.join(","));
    ok("H3  `partially_refunded` conta — venda paga em parte foi paga",
      valores.includes(50), valores.join(","));
    ok("H4  `refunded` NAO conta", !valores.includes(30), valores.join(","));
    ok("H5  `in_mediation` NAO conta — dinheiro em disputa nao e receita",
      !valores.includes(20), valores.join(","));
    ok("H6  e os dois descartados aparecem na contagem",
      r.foraDaJanelaFinanceira === 2, String(r.foraDaJanelaFinanceira));
  }

  // ═══ I. Mais de um pagamento aprovado — §10 ══════════════════════

  secao("I. Dois pagamentos aprovados: vale o mais antigo");
  {
    // O pedido foi pago em 09/08 e recebeu um segundo pagamento aprovado
    // em 11/08 — e o array vem com o SEGUNDO primeiro, que e o caso
    // medido em 3 dos 10 pedidos com dois aprovados.
    const doisPagamentos = {
      id: 1, status: "paid", paid_amount: 100,
      date_created: "2026-08-09T10:00:00.000-03:00",
      payments: [
        { status: "approved", date_approved: "2026-08-11T12:00:00.000-03:00" },
        { status: "approved", date_approved: "2026-08-09T12:00:00.000-03:00" },
      ],
    };
    const responder = (rows: unknown[]) => {
      const buscar: typeof fetch = async (entrada) => {
        const offset = Number(new URL(String(entrada)).searchParams.get("offset") ?? "0");
        return new Response(JSON.stringify({
          paging: { total: rows.length },
          results: offset === 0 ? rows : [],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      };
      return buscar;
    };

    // Janela financeira SO do dia 09: com a regra nova a venda entra.
    const r09 = await buscarVendasPagasML(
      { userId: "dono", lojaId: "loja", de: "2026-08-09", ate: "2026-08-09" },
      undefined, { ...PORTAS_BASE, buscar: responder([doisPagamentos]) });
    ok("I1  §10: conta no dia do pagamento MAIS ANTIGO",
      r09.pedidos.length === 1 && r09.pedidos[0]?.dataPagamento === "2026-08-09",
      `${r09.pedidos.length} / ${r09.pedidos[0]?.dataPagamento}`);

    // E NAO entra no dia do segundo pagamento — senao seria contada duas
    // vezes por quem somasse os dois dias.
    const r11 = await buscarVendasPagasML(
      { userId: "dono", lojaId: "loja", de: "2026-08-11", ate: "2026-08-11" },
      undefined, { ...PORTAS_BASE, buscar: responder([doisPagamentos]) });
    ok("I2  e NAO conta no dia do segundo pagamento",
      r11.pedidos.length === 0, `${r11.pedidos.length}`);

    // CONTROLE: com um unico pagamento no dia 11, ele conta no dia 11.
    // Sem este controle, I2 poderia passar por a janela estar errada.
    const soUm = {
      id: 2, status: "paid", paid_amount: 100,
      date_created: "2026-08-09T10:00:00.000-03:00",
      payments: [{ status: "approved", date_approved: "2026-08-11T12:00:00.000-03:00" }],
    };
    const c11 = await buscarVendasPagasML(
      { userId: "dono", lojaId: "loja", de: "2026-08-11", ate: "2026-08-11" },
      undefined, { ...PORTAS_BASE, buscar: responder([soUm]) });
    ok("I3  CONTROLE: pagamento unico em 11/08 conta em 11/08",
      c11.pedidos.length === 1 && c11.pedidos[0]?.dataPagamento === "2026-08-11",
      `${c11.pedidos.length} / ${c11.pedidos[0]?.dataPagamento}`);

    // CONTROLE: um pagamento recusado ANTES do aprovado nao rouba a data.
    const recusadoAntes = {
      id: 3, status: "paid", paid_amount: 100,
      date_created: "2026-08-09T10:00:00.000-03:00",
      payments: [
        { status: "rejected", date_approved: "2026-08-08T12:00:00.000-03:00" },
        { status: "approved", date_approved: "2026-08-09T12:00:00.000-03:00" },
      ],
    };
    const r08 = await buscarVendasPagasML(
      { userId: "dono", lojaId: "loja", de: "2026-08-08", ate: "2026-08-08" },
      undefined, { ...PORTAS_BASE, buscar: responder([recusadoAntes]) });
    ok("I4  CONTROLE: `rejected` mais antigo NAO vira a data da venda",
      r08.pedidos.length === 0, `${r08.pedidos.length}`);
  }

  console.log(`\nPASS ${pass}   FAIL ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
