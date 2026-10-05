/**
 * Suite do servico canonico de vendas Shopee — CDS-STABILIZATION S2-D1.
 *
 *  1. FIXTURE: os 3 dias do Seller Center (01-03/10/2026) — 12/12 metricas
 *     EXATAS com a mesma funcao que o servico usa em producao;
 *  2. GRAO (A-F): subsidio/Pix nao duplicam por item; voucher do vendedor,
 *     voucher Shopee e moedas sao por item; multi-item conta 1 pedido;
 *  3. FUSO: limites 23:59:59 / 00:00:00 de Sao Paulo, e um dia REAL de
 *     horario de verao (2018) provando que nao ha "-3h" fixo;
 *  4. COMPLETUDE: COMPLETE / PARTIAL / FAILED, e total nulo fora de COMPLETE;
 *  5. LEITURA: dono sempre no filtro, loja alheia recusada, intervalo certo;
 *  6. FONTE UNICA: a formula so existe em lib/vendas/canonico/shopee.ts.
 *
 * Offline: sem banco, sem Shopee. A fixture e sanitizada (sem comprador,
 * sem order_sn real, sem item_id).
 *
 * Uso: npx tsx scripts/testar-vendas-canonico-shopee.ts
 */
import "./_server-only-inerte";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { PedidoShopeeCanonico, ItemShopeeCanonico, JanelaListagem } from "../lib/vendas/canonico/shopee";

let passou = 0, falhou = 0;
let fila: Promise<void> = Promise.resolve();
function t(nome: string, fn: () => void | Promise<void>) {
  fila = fila.then(async () => {
    try { await fn(); passou++; console.log(`  PASS  ${nome}`); }
    catch (e: any) { falhou++; console.log(`  FALHA ${nome} -> ${e?.message ?? e}`); }
  });
}
function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const RAIZ = join(__dirname, "..");

// ── fixture → entradas canonicas ─────────────────────────────────────
interface Fx { p: string; st: string; c: string; u: string; pg: string; osd: number; pix: number; i: [number, number, number, number, number][] }
const FX = JSON.parse(readFileSync(join(RAIZ, "scripts/fixtures/vendas-canonico/shopee-seller-center-2026-10-01-03.json"), "utf8"));
const LOJA = "11111111-1111-4111-8111-111111111111";
const pedidosFx: PedidoShopeeCanonico[] = (FX.pedidos as Fx[]).map((o) => ({
  lojaId: LOJA, orderSn: o.p, orderStatus: o.st, payTime: o.pg, updateTime: o.u,
  detailFetchedAt: o.u, escrowFetchedAt: o.u, escrowUpdateTime: o.u,
  originalShopeeDiscount: o.osd, pixDiscount: o.pix,
}));
const itensFx: ItemShopeeCanonico[] = (FX.pedidos as Fx[]).flatMap((o) => o.i.map(([preco, qtd, vs, vsh, coin]) => ({
  lojaId: LOJA, orderSn: o.p, precoUnitario: preco, quantidade: qtd, voucherVendedor: vs, voucherShopee: vsh, moedas: coin,
})));

function pedido(sn: string, extra: Partial<PedidoShopeeCanonico> = {}): PedidoShopeeCanonico {
  return { lojaId: LOJA, orderSn: sn, orderStatus: "SHIPPED", payTime: "2026-10-02T15:00:00.000Z", updateTime: "2026-10-02T16:00:00.000Z",
    detailFetchedAt: "2026-10-02T16:01:00.000Z", escrowFetchedAt: "2026-10-02T16:01:00.000Z", escrowUpdateTime: "2026-10-02T16:00:00.000Z",
    originalShopeeDiscount: 0, pixDiscount: 0, ...extra };
}
function item(sn: string, extra: Partial<ItemShopeeCanonico> = {}): ItemShopeeCanonico {
  return { lojaId: LOJA, orderSn: sn, precoUnitario: 10, quantidade: 1, voucherVendedor: 0, voucherShopee: 0, moedas: 0, ...extra };
}

async function principal() {
  const S = await import("../lib/vendas/canonico/shopee");

  console.log("\n[1. fixture Seller Center — 12 metricas]");
  for (const [dia, ref] of Object.entries(FX.seller_center as Record<string, { pedidos: number; cancelados: number; vendas: number; vendas_sem_descontos: number }>)) {
    t(`1. ${dia}: pedidos, cancelados, Vendas e Vendas sem descontos EXATOS`, () => {
      const { inicio, fim } = S.intervaloSaoPaulo(dia, dia);
      const pagos = S.filtrarPagosNoIntervalo(pedidosFx, inicio, fim);
      const { metricas } = S.calcularMetricasShopee(pagos, itensFx);
      const got = [metricas.pedidos, metricas.cancelados, metricas.vendas, metricas.vendasSemDescontosPlataforma];
      const exp = [ref.pedidos, ref.cancelados, ref.vendas, ref.vendas_sem_descontos];
      assert(JSON.stringify(got) === JSON.stringify(exp), `obtido ${JSON.stringify(got)} esperado ${JSON.stringify(exp)}`);
    });
  }
  t("1d. periodo 01-03/10 = soma dos tres dias (pedidos disjuntos por pay_time)", () => {
    const { inicio, fim } = S.intervaloSaoPaulo("2026-10-01", "2026-10-03");
    const { metricas } = S.calcularMetricasShopee(S.filtrarPagosNoIntervalo(pedidosFx, inicio, fim), itensFx);
    assert(metricas.pedidos === 1077 + 939 + 812 && metricas.cancelados === 39 + 15 + 8, JSON.stringify(metricas));
    assert(Math.abs(metricas.vendas - (26880.70 + 22719.10 + 18778.57)) < 0.005, String(metricas.vendas));
  });

  console.log("\n[2. grao]");
  const umPedidoTresItens = () => ({
    pedidos: [pedido("X", { originalShopeeDiscount: 5, pixDiscount: 2 })],
    itens: [item("X", { precoUnitario: 10, quantidade: 2, voucherVendedor: 1, voucherShopee: 0.5, moedas: 0.25 }),
            item("X", { precoUnitario: 20, quantidade: 1, voucherVendedor: 1, voucherShopee: 0.5, moedas: 0.25 }),
            item("X", { precoUnitario: 5, quantidade: 3, voucherVendedor: 1, voucherShopee: 0.5, moedas: 0.25 })],
  });
  t("A/B. subsidio Shopee e Pix entram UMA vez por pedido (nao por item)", () => {
    const { pedidos, itens } = umPedidoTresItens();
    const { componentes } = S.calcularMetricasShopee(pedidos, itens);
    assert(componentes.subsidioShopee === 5 && componentes.descontoPix === 2, JSON.stringify(componentes));
  });
  t("C/D/E. voucher do vendedor, voucher Shopee e moedas somados POR ITEM", () => {
    const { pedidos, itens } = umPedidoTresItens();
    const { componentes, metricas } = S.calcularMetricasShopee(pedidos, itens);
    assert(componentes.itens === 55 && componentes.voucherVendedor === 3 && componentes.voucherShopee === 1.5 && componentes.moedas === 0.75, JSON.stringify(componentes));
    assert(metricas.vendas === 55 - 3 + 5 - 2 && metricas.vendasSemDescontosPlataforma === 55 - 3 - 1.5 - 0.75, JSON.stringify(metricas));
  });
  t("F. pedido multi-item (e cancelado) conta 1 em pedidos e em cancelados; unidades por item", () => {
    const { pedidos, itens } = umPedidoTresItens();
    pedidos[0].orderStatus = "CANCELLED";
    const { metricas } = S.calcularMetricasShopee(pedidos, itens);
    assert(metricas.pedidos === 1 && metricas.cancelados === 1 && metricas.unidades === 6, JSON.stringify(metricas));
  });
  t("G. mesmo pedido duas vezes no grao de pedido e ERRO (nunca soma em dobro)", () => {
    let erro = "";
    try { S.calcularMetricasShopee([pedido("X"), pedido("X")], [item("X")]); } catch (e: any) { erro = e.message; }
    assert(/duplicado/.test(erro), erro || "nao lancou");
  });
  t("H. escrow nulo NAO vira zero: calculo recusa (NULL = nao obtido)", () => {
    let erro = "";
    try { S.calcularMetricasShopee([pedido("X")], [item("X", { voucherShopee: null })]); } catch (e: any) { erro = e.message; }
    assert(/escrow de item ausente/.test(erro), erro || "nao lancou");
    erro = "";
    try { S.calcularMetricasShopee([pedido("X", { pixDiscount: null })], [item("X")]); } catch (e: any) { erro = e.message; }
    assert(/escrow de pedido ausente/.test(erro), erro || "nao lancou");
  });
  t("I. lojas diferentes com o mesmo order_sn sao pedidos distintos", () => {
    const L2 = "22222222-2222-4222-8222-222222222222";
    const { metricas } = S.calcularMetricasShopee([pedido("X"), { ...pedido("X"), lojaId: L2 }], [item("X"), { ...item("X"), lojaId: L2 }]);
    assert(metricas.pedidos === 2 && metricas.unidades === 2, JSON.stringify(metricas));
  });

  console.log("\n[3. fuso America/Sao_Paulo]");
  t("3a. 23:59:59 BRT de 01/10 conta em 01/10; 00:00:00 BRT de 02/10 conta em 02/10", () => {
    const p1 = pedido("A", { payTime: "2026-10-01T23:59:59-03:00" }), p2 = pedido("B", { payTime: "2026-10-02T00:00:00-03:00" });
    const d1 = S.intervaloSaoPaulo("2026-10-01", "2026-10-01"), d2 = S.intervaloSaoPaulo("2026-10-02", "2026-10-02");
    assert(S.filtrarPagosNoIntervalo([p1, p2], d1.inicio, d1.fim).map((p) => p.orderSn).join() === "A", "01/10");
    assert(S.filtrarPagosNoIntervalo([p1, p2], d2.inicio, d2.fim).map((p) => p.orderSn).join() === "B", "02/10");
  });
  t("3b. o intervalo e [inicio, inicio do dia seguinte) — fim exclusivo", () => {
    const { inicio, fim } = S.intervaloSaoPaulo("2026-10-02", "2026-10-02");
    assert(inicio.toISOString() === "2026-10-02T03:00:00.000Z" && fim.toISOString() === "2026-10-03T03:00:00.000Z", `${inicio.toISOString()} ${fim.toISOString()}`);
  });
  t("3c. horario de verao real (01/12/2018, UTC-2): o dia comeca as 02:00Z — prova que nao ha -3h fixo", () => {
    const { inicio, fim } = S.intervaloSaoPaulo("2018-12-01", "2018-12-01");
    assert(inicio.toISOString() === "2018-12-01T02:00:00.000Z" && fim.toISOString() === "2018-12-02T02:00:00.000Z", `${inicio.toISOString()} ${fim.toISOString()}`);
  });
  t("3d. a fonte nao tem deslocamento fixo de 3h", () => {
    const fonte = readFileSync(join(RAIZ, "lib/vendas/canonico/shopee.ts"), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    assert(!/3\s*\*\s*3600|10800|-03:00|"-3"|3 \* 60 \* 60/.test(fonte), "achei offset fixo");
  });

  console.log("\n[4. completude]");
  const dia = S.intervaloSaoPaulo("2026-10-02", "2026-10-02");
  const janelaOk = (extra: Partial<JanelaListagem> = {}): JanelaListagem => ({ lojaId: LOJA, campoTempo: "update_time",
    inicio: "2026-10-01T00:00:00.000Z", fim: "2026-10-04T00:00:00.000Z", listagemCompleta: true, status: "concluido", ...extra });
  // S2-D1.1: prova = CADEIA de update_time com sucessora. Duas janelas
  // sobrepostas; watermark = inicio da ultima (03/10 11:45Z) >= fim do dia.
  const cadeiaOk = (): JanelaListagem[] => [
    janelaOk({ inicio: "2026-10-01T00:00:00.000Z", fim: "2026-10-03T12:00:00.000Z" }),
    janelaOk({ inicio: "2026-10-03T11:45:00.000Z", fim: "2026-10-04T00:00:00.000Z" }),
  ];
  t("4a. listagem coberta + detail + escrow atual = COMPLETE", () => {
    const r = S.avaliarCompletudeShopee({ ...dia, janelas: cadeiaOk(), pedidosPagos: [pedido("X")], itens: [item("X")] });
    assert(r.completude === "COMPLETE", JSON.stringify(r));
  });
  t("4b. buraco na cobertura = PARTIAL", () => {
    const r = S.avaliarCompletudeShopee({ ...dia, janelas: [janelaOk({ fim: "2026-10-02T12:00:00.000Z" }), janelaOk({ inicio: "2026-10-02T13:00:00.000Z" })], pedidosPagos: [pedido("X")], itens: [item("X")] });
    assert(r.completude === "PARTIAL" && r.motivos.includes("listagem_nao_provada_por_update_time"), JSON.stringify(r));
  });
  t("4c. janela em erro sem cobertura = FAILED", () => {
    const r = S.avaliarCompletudeShopee({ ...dia, janelas: [janelaOk({ listagemCompleta: null, status: "erro" })], pedidosPagos: [pedido("X")], itens: [item("X")] });
    assert(r.completude === "FAILED", JSON.stringify(r));
  });
  t("4d. listagem 'concluida' mas NAO marcada completa nao prova cobertura", () => {
    const r = S.avaliarCompletudeShopee({ ...dia, janelas: [janelaOk({ listagemCompleta: false })], pedidosPagos: [pedido("X")], itens: [item("X")] });
    assert(r.completude !== "COMPLETE", JSON.stringify(r));
  });
  t("4d2. listagem completa mas job em 'rodando' ou 'erro' nao prova (S2-D2: pedido listado pode nao ter materializado)", () => {
    for (const status of ["rodando", "erro"]) {
      const cadeia = cadeiaOk().map((j, i) => (i === 0 ? { ...j, status } : j));
      const r = S.avaliarCompletudeShopee({ ...dia, janelas: cadeia, pedidosPagos: [pedido("X")], itens: [item("X")] });
      assert(r.completude !== "COMPLETE", `${status}: ${JSON.stringify(r)}`);
    }
  });
  t("4e. escrow lido antes da ultima mudanca do pedido = PARTIAL (escrow desatualizado)", () => {
    const r = S.avaliarCompletudeShopee({ ...dia, janelas: cadeiaOk(), pedidosPagos: [pedido("X", { updateTime: "2026-10-03T10:00:00.000Z" })], itens: [item("X")] });
    assert(r.completude === "PARTIAL" && r.motivos.some((m) => m.startsWith("escrow_ausente_ou_desatualizado")), JSON.stringify(r));
  });
  t("4e2. escrow lido num update_time POSTERIOR ao vigente (>) = ATUAL, nao desatualizado", () => {
    const r = S.avaliarCompletudeShopee({ ...dia, janelas: cadeiaOk(), pedidosPagos: [pedido("X", { escrowUpdateTime: "2026-10-02T17:00:00.000Z" })], itens: [item("X")] });
    assert(r.completude === "COMPLETE", JSON.stringify(r));
  });
  t("4e3. escrowShopeeAtual A-F (regra unica S2-D3-A.1)", () => {
    const U = "2026-10-02T16:00:00.000Z", menos = "2026-10-02T15:59:59.000Z", mais = "2026-10-02T16:00:01.000Z";
    for (const [caso, fetched, eut, esperadoAtual] of [
      ["B nunca lido", null, null, false],
      ["C fetched sem escrow_update_time", "z", null, false],
      ["D <", "z", menos, false],
      ["E ==", "z", U, true],
      ["F >", "z", mais, true],
    ] as const) assert(S.escrowShopeeAtual(fetched, eut, U) === esperadoAtual, caso);
    // A (pay_time NULL) nao entra: avaliarCompletude so recebe pedidos pagos.
  });
  t("4f. detail ausente / item sem escrow / pedido sem itens = PARTIAL", () => {
    for (const [p, its, m] of [
      [pedido("X", { detailFetchedAt: null }), [item("X")], "detalhe_ausente"],
      [pedido("X"), [item("X", { moedas: null })], "escrow_ausente_ou_desatualizado"],
      [pedido("X"), [], "pedido_sem_itens"],
    ] as const) {
      const r = S.avaliarCompletudeShopee({ ...dia, janelas: cadeiaOk(), pedidosPagos: [p], itens: [...its] });
      assert(r.completude === "PARTIAL" && r.motivos.some((x) => x.startsWith(m)), `${m}: ${JSON.stringify(r)}`);
    }
  });
  t("4g. create_time NUNCA prova COMPLETE — nem com 7, nem com 365 dias de margem", () => {
    for (const ini of ["2026-09-25T00:00:00.000Z", "2025-10-02T00:00:00.000Z"]) {
      const cadeiaCreate = [janelaOk({ campoTempo: "create_time", inicio: ini, fim: "2026-10-03T12:00:00.000Z" }),
        janelaOk({ campoTempo: "create_time", inicio: "2026-10-03T11:45:00.000Z" })];
      const r = S.avaliarCompletudeShopee({ ...dia, janelas: cadeiaCreate, pedidosPagos: [pedido("X")], itens: [item("X")] });
      assert(r.completude === "PARTIAL" && r.motivos.includes("so_create_time_sem_prova"), `${ini}: ${JSON.stringify(r)}`);
    }
  });
  t("4h. UMA janela de update_time cobrindo o dia, sem sucessora, nao prova (watermark = seu inicio)", () => {
    const r = S.avaliarCompletudeShopee({ ...dia, janelas: [janelaOk()], pedidosPagos: [pedido("X")], itens: [item("X")] });
    assert(r.completude === "PARTIAL" && r.watermark === "2026-10-01T00:00:00.000Z", JSON.stringify(r));
  });
  t("4i. cadeia que comeca DEPOIS do inicio do dia nao prova", () => {
    const r = S.avaliarCompletudeShopee({ ...dia, janelas: [janelaOk({ inicio: "2026-10-02T03:30:00.000Z", fim: "2026-10-03T12:00:00.000Z" }),
      janelaOk({ inicio: "2026-10-03T11:45:00.000Z" })], pedidosPagos: [pedido("X")], itens: [item("X")] });
    assert(r.completude === "PARTIAL" && r.watermark === null, JSON.stringify(r));
  });

  console.log("\n[4-ADV. pedidos adversariais: criados muito antes, pagos em D]");
  // D = 02/10 em Sao Paulo. Pertinencia a D e SO por pay_time.
  const D = dia;
  const advDez = pedido("ADV10", { payTime: "2026-10-02T15:00:00.000Z",
    updateTime: "2026-10-14T15:00:00.000Z", escrowUpdateTime: "2026-10-14T15:00:00.000Z" }); // criado D-10, update D+12
  const advTrinta = pedido("ADV30", { payTime: "2026-10-02T15:00:00.000Z", updateTime: "2026-10-02T15:00:00.000Z",
    escrowUpdateTime: "2026-10-02T15:00:00.000Z" }); // criado D-30; escrow lido no update vigente
  const criadoDez = new Date("2026-09-22T15:00:00.000Z").getTime(), criadoTrinta = new Date("2026-09-02T15:00:00.000Z").getTime();
  t("ADV-10a. criado em D-10, pago em D, update em D+12: pertence a D", () => {
    assert(criadoDez < D.inicio.getTime() - S.MARGEM_OPERACIONAL_CREATE_TIME_MS, "fixture: criado antes da margem de 7d");
    const em = S.filtrarPagosNoIntervalo([advDez], D.inicio, D.fim);
    assert(em.length === 1, "fora de D");
    assert(S.calcularMetricasShopee(em, [item("ADV10")]).metricas.pedidos === 1, "nao contou");
  });
  t("ADV-10b. backfill create_time a partir de D-7 (nao o enxergaria) NAO produz COMPLETE", () => {
    const cadeiaCreate7 = [janelaOk({ campoTempo: "create_time", inicio: "2026-09-25T03:00:00.000Z", fim: "2026-10-03T12:00:00.000Z" }),
      janelaOk({ campoTempo: "create_time", inicio: "2026-10-03T11:45:00.000Z", fim: "2026-10-04T00:00:00.000Z" })];
    const nenhumaCobreCriacao = cadeiaCreate7.every((j) => !(new Date(j.inicio).getTime() <= criadoDez && criadoDez < new Date(j.fim).getTime()));
    assert(nenhumaCobreCriacao, "fixture: a margem de 7d de fato nao alcanca a criacao");
    const r = S.avaliarCompletudeShopee({ ...D, janelas: cadeiaCreate7, pedidosPagos: [advDez], itens: [item("ADV10")] });
    assert(r.completude !== "COMPLETE", JSON.stringify(r));
  });
  t("ADV-10c. cadeia de update_time que alcanca o update do pedido o descobre e prova D", () => {
    const cadeiaUpd = [janelaOk({ inicio: "2026-10-02T00:00:00.000Z", fim: "2026-10-08T00:00:00.000Z" }),
      janelaOk({ inicio: "2026-10-07T23:45:00.000Z", fim: "2026-10-14T20:00:00.000Z" }),
      janelaOk({ inicio: "2026-10-14T19:45:00.000Z", fim: "2026-10-15T00:00:00.000Z" })];
    const u = new Date(advDez.updateTime).getTime();
    assert(cadeiaUpd.some((j) => new Date(j.inicio).getTime() <= u && u < new Date(j.fim).getTime()), "nenhuma janela de update_time contem o update do pedido");
    const r = S.avaliarCompletudeShopee({ ...D, janelas: cadeiaUpd, pedidosPagos: [advDez], itens: [item("ADV10")] });
    assert(r.completude === "COMPLETE", JSON.stringify(r));
  });
  t("ADV-30a. criado em D-30, pago e atualizado em D: pertence a D e nenhuma margem de create_time o exclui", () => {
    assert(criadoTrinta < D.inicio.getTime() - S.MARGEM_OPERACIONAL_CREATE_TIME_MS, "fixture");
    const em = S.filtrarPagosNoIntervalo([advTrinta, advDez], D.inicio, D.fim);
    assert(em.map((p) => p.orderSn).sort().join() === "ADV10,ADV30", em.map((p) => p.orderSn).join());
    const { metricas } = S.calcularMetricasShopee(em, [item("ADV10"), item("ADV30")]);
    assert(metricas.pedidos === 2, JSON.stringify(metricas));
  });
  t("ADV-30b. so backfill create_time (margem 7d) → PARTIAL; cadeia de update_time → COMPLETE", () => {
    const cadeiaCreate7 = [janelaOk({ campoTempo: "create_time", inicio: "2026-09-25T03:00:00.000Z", fim: "2026-10-03T12:00:00.000Z" }),
      janelaOk({ campoTempo: "create_time", inicio: "2026-10-03T11:45:00.000Z" })];
    assert(S.avaliarCompletudeShopee({ ...D, janelas: cadeiaCreate7, pedidosPagos: [advTrinta], itens: [item("ADV30")] }).completude === "PARTIAL", "create");
    assert(S.avaliarCompletudeShopee({ ...D, janelas: cadeiaOk(), pedidosPagos: [advTrinta], itens: [item("ADV30")] }).completude === "COMPLETE", "update");
  });
  t("ADV-z. a margem de 7 dias nao aparece na regra de completude (so como constante operacional)", () => {
    const fonte = readFileSync(join(RAIZ, "lib/vendas/canonico/shopee.ts"), "utf8");
    const corpo = fonte.slice(fonte.indexOf("export function avaliarCompletudeShopee"), fonte.indexOf("// ── Leitura do banco"));
    assert(corpo.length > 100 && !/MARGEM_OPERACIONAL|LAG_MAXIMO|7 \* 24/.test(corpo), "margem usada na completude");
    assert(!/LAG_MAXIMO_PAGAMENTO/.test(fonte), "constante antiga ainda existe");
  });

  console.log("\n[5. leitura do banco (duplo)]");
  // duplo minimo: registra filtros e devolve linhas por tabela
  type Reg = { tabela: string; filtros: [string, string, unknown][] };
  function clienteFalso(dados: Record<string, any[]>, regs: Reg[]) {
    return {
      from(tabela: string) {
        const r: Reg = { tabela, filtros: [] }; regs.push(r);
        const casa = (l: any) => r.filtros.every(([op, col, valor]) => {
          const v = valor as any;
          return op === "eq" ? String(l[col]) === String(v) : op === "in" ? (v as any[]).map(String).includes(String(l[col]))
            : op === "gte" ? l[col] >= v : op === "lt" ? l[col] < v : op === "gt" ? l[col] > v : true;
        });
        const c: any = new Proxy({}, { get(_a, p: string) {
          if (p === "then") return (ok: any) => ok({ data: (dados[tabela] ?? []).filter(casa), error: null });
          if (p === "range") return (a: number, b: number) => Promise.resolve({ data: (dados[tabela] ?? []).filter(casa).slice(a, b + 1), error: null });
          return (...args: any[]) => { if (["eq", "in", "gte", "lt", "gt"].includes(p)) r.filtros.push([p, args[0], args[1]]); return c; };
        } });
        return c;
      },
    } as any;
  }
  const UID = "dono-a", OUTRO = "dono-b", L2 = "22222222-2222-4222-8222-222222222222";
  const base = () => ({
    lojas: [{ id: LOJA, user_id: UID, marketplace: "Shopee" }, { id: L2, user_id: OUTRO, marketplace: "Shopee" }],
    shopee_pedidos: [
      { user_id: UID, loja_id: LOJA, order_sn: "X", order_status: "SHIPPED", pay_time: "2026-10-02T15:00:00.000Z", update_time: "2026-10-02T16:00:00.000Z",
        detail_fetched_at: "z", escrow_fetched_at: "z", escrow_update_time: "2026-10-02T16:00:00.000Z", original_shopee_discount: 1, pix_discount: 0 },
      { user_id: UID, loja_id: LOJA, order_sn: "FORA", order_status: "SHIPPED", pay_time: "2026-10-03T15:00:00.000Z", update_time: "2026-10-03T16:00:00.000Z",
        detail_fetched_at: "z", escrow_fetched_at: "z", escrow_update_time: "2026-10-03T16:00:00.000Z", original_shopee_discount: 9, pix_discount: 0 },
    ],
    pedidos: [{ user_id: UID, marketplace: "Shopee", loja_id: LOJA, order_id: "X", qtd: 2, valor_unit: 10, escrow_voucher_seller: 1, escrow_voucher_shopee: 0, escrow_coin: 0 }],
    sync_jobs: [
      { user_id: UID, loja_id: LOJA, marketplace: "Shopee", campo_tempo: "update_time", janela_inicio: "2026-10-01T00:00:00.000Z", janela_fim: "2026-10-03T12:00:00.000Z", listagem_completa: true, status: "concluido" },
      { user_id: UID, loja_id: LOJA, marketplace: "Shopee", campo_tempo: "update_time", janela_inicio: "2026-10-03T11:45:00.000Z", janela_fim: "2026-10-04T00:00:00.000Z", listagem_completa: true, status: "concluido" },
    ],
  });
  t("5a. dono em TODA consulta; so pedidos pagos no dia; total = loja", async () => {
    const regs: Reg[] = [];
    const r = await S.lerVendasShopee(clienteFalso(base(), regs), { userId: UID, de: "2026-10-02", ate: "2026-10-02" });
    assert(r.completude === "COMPLETE" && r.total?.pedidos === 1 && r.total?.vendas === 20 - 1 + 1, JSON.stringify(r));
    for (const g of regs) assert(g.filtros.some(([op, col, v]) => op === "eq" && col === "user_id" && v === UID), `${g.tabela} sem dono`);
    const sp = regs.find((g) => g.tabela === "shopee_pedidos")!;
    assert(sp.filtros.some(([op, c, v]) => op === "gte" && c === "pay_time" && v === "2026-10-02T03:00:00.000Z"), "inicio");
    assert(sp.filtros.some(([op, c, v]) => op === "lt" && c === "pay_time" && v === "2026-10-03T03:00:00.000Z"), "fim exclusivo");
  });
  t("5b. loja de outro dono pedida explicitamente → erro loja_invalida (nunca zero)", async () => {
    let erro = "";
    try { await S.lerVendasShopee(clienteFalso(base(), []), { userId: UID, de: "2026-10-02", ate: "2026-10-02", lojaIds: [L2] }); } catch (e: any) { erro = e.message; }
    assert(erro === "loja_invalida", erro || "nao lancou");
  });
  t("5c. sem cobertura de listagem → PARTIAL e total NULL", async () => {
    const d = base(); d.sync_jobs = [];
    const r = await S.lerVendasShopee(clienteFalso(d, []), { userId: UID, de: "2026-10-02", ate: "2026-10-02" });
    assert(r.completude === "PARTIAL" && r.total === null && r.lojas[0].metricas === null, JSON.stringify(r));
  });

  console.log("\n[6. fonte unica da formula]");
  t("6a. componentes de escrow e formulas so aparecem no servico canonico (e migration/testes)", () => {
    const arqs = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "app", "lib", "components"], { cwd: RAIZ, encoding: "utf8" })
      .split(/\r?\n/).filter((f) => /\.(ts|tsx)$/.test(f));
    // S2-D2: o motor de ingestao GRAVA os componentes (tipos/normalizacao/
    // persistencia) — isso e esperado. O que nao pode existir fora do
    // servico canonico e CALCULO com eles.
    const ARMAZENAM = ["lib/vendas/canonico/shopee.ts", "lib/shopee/ingestao/tipos.ts",
      "lib/shopee/ingestao/normalizar.ts", "lib/shopee/ingestao/persistencia.ts"];
    const fora = arqs.filter((f) => !ARMAZENAM.includes(f) &&
      /escrow_voucher_seller|escrow_voucher_shopee|escrow_coin|shopee_pedidos/.test(readFileSync(join(RAIZ, f), "utf8")));
    assert(fora.length === 0, fora.join(", "));
    const calculo = /[-+*]\s*[\w.!?()]*\b(pix_discount|original_shopee_discount|escrow_voucher_seller|escrow_voucher_shopee|escrow_coin|pixDiscount|originalShopeeDiscount|voucherVendedor|voucherShopee|moedas)\b/;
    const calculam = arqs.filter((f) => f !== "lib/vendas/canonico/shopee.ts" && f.startsWith("lib/") &&
      calculo.test(readFileSync(join(RAIZ, f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")));
    assert(calculam.length === 0, `calculo com componentes fora do servico canonico: ${calculam.join(", ")}`);
  });
  t("6b. o servico e server-only e nao conhece UI", () => {
    const s = readFileSync(join(RAIZ, "lib/vendas/canonico/shopee.ts"), "utf8");
    assert(/^import "server-only";/m.test(s), "sem server-only");
    assert(!/from ["'](react|next\/)/.test(s) && !/@\/components|@\/app/.test(s), "importa UI");
  });

  await fila;
  console.log(`\n${falhou === 0 ? "✓" : "✗"} VENDAS-CANONICO-SHOPEE — ${passou} passaram, ${falhou} falharam`);
  process.exit(falhou === 0 ? 0 : 1);
}
principal().catch((e) => { console.error("ERRO FATAL", e); process.exit(1); });
