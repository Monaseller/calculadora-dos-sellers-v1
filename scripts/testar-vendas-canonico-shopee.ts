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
// SALES-SYNC-D15D3: o motor intraday Shopee consulta shopee_pedidos SO para candidatos a re-detail (conteudo pinado por sha256)
import { MOTOR_INTRADAY_SHOPEE, motorIntradayShopeeExato } from "./_excecao-d15d-shopee-intraday";

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
  lojaId: LOJA, orderSn: o.p, orderStatus: o.st, createTime: o.c, payTime: o.pg, updateTime: o.u,
  detailFetchedAt: o.u, escrowFetchedAt: o.u, escrowUpdateTime: o.u,
  originalShopeeDiscount: o.osd, pixDiscount: o.pix,
}));
const itensFx: ItemShopeeCanonico[] = (FX.pedidos as Fx[]).flatMap((o) => o.i.map(([preco, qtd, vs, vsh, coin]) => ({
  lojaId: LOJA, orderSn: o.p, precoUnitario: preco, quantidade: qtd, voucherVendedor: vs, voucherShopee: vsh, moedas: coin,
})));

function pedido(sn: string, extra: Partial<PedidoShopeeCanonico> = {}): PedidoShopeeCanonico {
  return { lojaId: LOJA, orderSn: sn, orderStatus: "SHIPPED", createTime: "2026-10-02T14:30:00.000Z", payTime: "2026-10-02T15:00:00.000Z", updateTime: "2026-10-02T16:00:00.000Z",
    detailFetchedAt: "2026-10-05T16:01:00.000Z", escrowFetchedAt: "2026-10-05T16:01:00.000Z", escrowUpdateTime: "2026-10-02T16:00:00.000Z",
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

  console.log("\n[4. completude = A (descoberta create_time) && B (estado) && C (financeiro)]");
  const dia = S.intervaloSaoPaulo("2026-10-02", "2026-10-02");
  const ANCORA = new Date("2026-08-01T03:00:00.000Z"); // inicio comprovado do historico (fixture)
  const jan = (extra: Partial<JanelaListagem> = {}): JanelaListagem => ({ lojaId: LOJA, campoTempo: "create_time",
    inicio: "2026-08-01T03:00:00.000Z", fim: "2026-08-15T03:00:00.000Z", listagemCompleta: true, status: "concluido", ...extra });
  // corpus por create_time da ancora ate depois do fim do dia (blocos de 14 dias, contiguos)
  const corpus = (ate = "2026-10-04T00:00:00.000Z"): JanelaListagem[] => {
    const out: JanelaListagem[] = []; let a = ANCORA.getTime(); const f = Date.parse(ate);
    while (a < f) { const b = Math.min(a + 14 * 86400e3, f); out.push(jan({ inicio: new Date(a).toISOString(), fim: new Date(b).toISOString() })); a = b; }
    return out;
  };
  const updOk = (inicio: string, fim: string): JanelaListagem => jan({ campoTempo: "update_time", inicio, fim });
  // a cadeia de update_time da run real do S2-D3-B2 (as duas janelas invalidadas)
  const cadeiaUpdD3B2 = () => [updOk("2026-10-02T03:00:00.000Z", "2026-10-03T03:15:00.000Z"), updOk("2026-10-03T03:00:00.000Z", "2026-10-05T19:19:03.410Z")];
  const av = (o: Partial<Parameters<typeof S.avaliarCompletudeShopee>[0]> = {}) => S.avaliarCompletudeShopee({ ...dia, janelas: corpus(),
    ancoraDescoberta: ANCORA, pedidosPagos: [pedido("X")], itens: [item("X")], naoPagosSemObservacaoPosPeriodo: 0, ...o });

  t("4a. corpus create_time da ancora + estado pos-periodo + escrow atual = COMPLETE", () => {
    const r = av();
    assert(r.completude === "COMPLETE" && r.dimensoes.descoberta && r.dimensoes.estado && r.dimensoes.financeiro, JSON.stringify(r));
    assert(r.estadoEm === "2026-10-05T16:01:00.000Z" && r.alcanceDescoberta === "2026-10-04T00:00:00.000Z", JSON.stringify(r));
  });
  t("4b. UPDATE_TIME_CAN_PROVE_DISCOVERY_COMPLETE = NO: cadeia de update_time perfeita, sem corpus → nunca COMPLETE", () => {
    for (const janelas of [cadeiaUpdD3B2(), [updOk("2026-07-01T00:00:00.000Z", "2026-10-03T12:00:00.000Z"), updOk("2026-10-03T11:45:00.000Z", "2026-10-09T00:00:00.000Z")]]) {
      const r = av({ janelas });
      assert(r.completude === "PARTIAL" && !r.dimensoes.descoberta && r.motivos.includes("update_time_nao_prova_descoberta"), JSON.stringify(r));
    }
  });
  t("4c. sem ancora → base POLITICA_PRAZO_PAGAMENTO: corpus desde inicio − 10d basta; o que comeca depois nao", () => {
    const desde = new Date(dia.inicio.getTime() - S.LIMITE_POLITICA_PAGAMENTO_MS);
    const corpusDe = (ini: Date) => { const out: JanelaListagem[] = []; for (let x = ini.getTime(); x < Date.parse("2026-10-04T00:00:00.000Z"); x += 14 * 86400e3) out.push(jan({ inicio: new Date(x).toISOString(), fim: new Date(Math.min(x + 14 * 86400e3, Date.parse("2026-10-04T00:00:00.000Z"))).toISOString() })); return out; };
    const ok = av({ ancoraDescoberta: null, janelas: corpusDe(desde) });
    assert(ok.completude === "COMPLETE" && ok.baseDescoberta === "POLITICA_PRAZO_PAGAMENTO" && ok.descobertaDesde === desde.toISOString(), JSON.stringify(ok));
    const curto = av({ ancoraDescoberta: null, janelas: corpusDe(new Date(desde.getTime() + 1000)) });
    assert(curto.completude === "PARTIAL" && curto.motivos.includes("descoberta_por_create_time_nao_provada"), JSON.stringify(curto));
  });
  t("4c2. POLITICA: sentinela — pedido do periodo com atraso de pagamento > 10d, ou create_time desconhecido → PARTIAL", () => {
    const lento = pedido("X", { createTime: "2026-09-21T14:59:59.000Z" }); // 10d + 1s antes do pagamento
    const r1 = av({ ancoraDescoberta: null, pedidosPagos: [lento] });
    assert(r1.completude === "PARTIAL" && r1.motivos.includes("atraso_de_pagamento_acima_da_politica:1"), JSON.stringify(r1));
    const limite = pedido("X", { createTime: "2026-09-22T15:00:00.000Z" }); // exatamente 10d
    assert(av({ ancoraDescoberta: null, pedidosPagos: [limite] }).completude === "COMPLETE", "10d exatos devia passar");
    const r2 = av({ ancoraDescoberta: null, pedidosPagos: [pedido("X", { createTime: null })] });
    assert(r2.completude === "PARTIAL" && r2.motivos.includes("create_time_desconhecido:1"), JSON.stringify(r2));
    // com ANCORA provada o sentinela nao se aplica: o corpus inteiro e a prova
    assert(av({ pedidosPagos: [lento] }).completude === "COMPLETE", "ancora provada nao devia depender do prazo");
  });
  t("4d. buraco no corpus / corpus que nao alcanca o fim do dia / que comeca depois da ancora → PARTIAL", () => {
    const comBuraco = corpus().filter((_, i) => i !== 2);
    for (const [nome, janelas] of [["buraco", comBuraco], ["curto", corpus("2026-10-03T02:59:59.000Z")], ["sem ancora", corpus().slice(1)]] as const) {
      const r = av({ janelas: [...janelas] });
      assert(r.completude === "PARTIAL" && r.motivos.includes("descoberta_por_create_time_nao_provada"), `${nome}: ${JSON.stringify(r)}`);
    }
  });
  t("4e. janela de corpus 'concluida' mas nao completa, ou completa mas job rodando/erro, nao prova", () => {
    for (const mut of [{ listagemCompleta: false }, { listagemCompleta: null }, { status: "rodando" }, { status: "erro" }]) {
      const r = av({ janelas: corpus().map((j, i) => (i === 3 ? { ...j, ...mut } : j)) });
      assert(r.completude !== "COMPLETE", `${JSON.stringify(mut)}: ${JSON.stringify(r)}`);
    }
  });
  t("4f. janela de corpus em erro no intervalo necessario = FAILED", () => {
    const r = av({ janelas: corpus().map((j, i) => (i === 3 ? { ...j, listagemCompleta: null, status: "erro" } : j)) });
    assert(r.completude === "FAILED", JSON.stringify(r));
  });
  t("4g. B: detail observado antes do fim do periodo, ou ausente → PARTIAL", () => {
    for (const [p, m] of [[pedido("X", { detailFetchedAt: "2026-10-02T20:00:00.000Z" }), "estado_observado_antes_do_fim_do_periodo"],
      [pedido("X", { detailFetchedAt: null }), "detalhe_ausente"]] as const) {
      const r = av({ pedidosPagos: [p] });
      assert(r.completude === "PARTIAL" && !r.dimensoes.estado && r.motivos.some((x) => x.startsWith(m)), `${m}: ${JSON.stringify(r)}`);
    }
  });
  t("4h. B: pedido do corpus nao pago, visto pela ultima vez antes do fim do dia, pode ter sido pago no dia → PARTIAL", () => {
    const r = av({ naoPagosSemObservacaoPosPeriodo: 1 });
    assert(r.completude === "PARTIAL" && r.motivos.includes("nao_pagos_sem_observacao_pos_periodo:1"), JSON.stringify(r));
    assert(S.ESTADOS_TERMINAIS_VERIFICADOS.length === 0, "status terminal presumido sem verificacao");
  });
  t("4i. C: escrow anterior ao update_time vigente / item sem escrow / pedido sem itens → PARTIAL", () => {
    for (const [ps, its, m] of [
      [[pedido("X", { updateTime: "2026-10-03T10:00:00.000Z" })], [item("X")], "escrow_ausente_ou_desatualizado"],
      [[pedido("X")], [item("X", { moedas: null })], "escrow_ausente_ou_desatualizado"],
      [[pedido("X")], [], "pedido_sem_itens"],
    ] as const) {
      const r = av({ pedidosPagos: [...ps], itens: [...its] });
      assert(r.completude === "PARTIAL" && !r.dimensoes.financeiro && r.motivos.some((x) => x.startsWith(m)), `${m}: ${JSON.stringify(r)}`);
    }
  });
  t("4j. C: escrow lido num update_time POSTERIOR ao vigente (>) = ATUAL", () => {
    assert(av({ pedidosPagos: [pedido("X", { escrowUpdateTime: "2026-10-02T17:00:00.000Z" })] }).completude === "COMPLETE", "> virou pendente");
  });
  t("4k. escrowShopeeAtual A-F (regra unica S2-D3-A.1)", () => {
    const U = "2026-10-02T16:00:00.000Z", menos = "2026-10-02T15:59:59.000Z", mais = "2026-10-02T16:00:01.000Z";
    for (const [caso, fetched, eut, esperadoAtual] of [
      ["B nunca lido", null, null, false],
      ["C fetched sem escrow_update_time", "z", null, false],
      ["D <", "z", menos, false],
      ["E ==", "z", U, true],
      ["F >", "z", mais, true],
    ] as const) assert(S.escrowShopeeAtual(fetched, eut, U) === esperadoAtual, caso);
  });
  t("4l. alcance do corpus = FIM da cadeia (membership de create_time e imutavel); sem cadeia = null", () => {
    assert(S.alcanceDescobertaCriacao(corpus(), ANCORA.getTime()) === Date.parse("2026-10-04T00:00:00.000Z"), "alcance");
    assert(S.alcanceDescobertaCriacao(corpus().slice(1), ANCORA.getTime()) === null, "sem janela na ancora");
    assert(S.alcanceDescobertaCriacao(cadeiaUpdD3B2(), Date.parse("2026-10-02T03:00:00.000Z")) === null, "update_time entrou no alcance");
  });

  t("4m. bordas: janela seguinte comecando NO fim (borda compartilhada) ou antes dele continua a cadeia", () => {
    const b = "2026-09-01T03:00:00.000Z";
    const partes = (ini2: string) => [jan({ inicio: ANCORA.toISOString(), fim: b }), jan({ inicio: ini2, fim: "2026-09-14T03:00:00.000Z" })];
    assert(S.alcanceDescobertaCriacao(partes(b), ANCORA.getTime()) === Date.parse("2026-09-14T03:00:00.000Z"), "borda compartilhada quebrou a cadeia");
    assert(S.alcanceDescobertaCriacao(partes("2026-09-01T02:59:59.000Z"), ANCORA.getTime()) === Date.parse("2026-09-14T03:00:00.000Z"), "overlap quebrou a cadeia");
  });
  t("4n. bordas: janela seguinte comecando 1 s DEPOIS do fim e lacuna (estrategia unica = borda compartilhada)", () => {
    const b = "2026-09-01T03:00:00.000Z";
    const js = [jan({ inicio: ANCORA.toISOString(), fim: b }), jan({ inicio: "2026-09-01T03:00:01.000Z", fim: "2026-09-14T03:00:00.000Z" })];
    assert(S.alcanceDescobertaCriacao(js, ANCORA.getTime()) === Date.parse(b), "lacuna de 1 s foi aceita");
  });

  console.log("\n[4-REG. o falso COMPLETE real do S2-D3-B2]");
  // Seller Center 02/10 = 939. A paginacao de update_time trouxe 929 (cursor
  // posicional sobre conjunto mutavel). detail/escrow dos 929 perfeitos; a
  // evidencia antiga dizia "listagem completa".
  const pagos02 = S.filtrarPagosNoIntervalo(pedidosFx, dia.inicio, dia.fim)
    .map((p) => ({ ...p, detailFetchedAt: "2026-10-05T16:00:00.000Z", escrowFetchedAt: "2026-10-05T16:00:00.000Z" }));
  const perdidos = new Set(pagos02.filter((_, i) => i % 93 === 7).slice(0, 10).map((p) => p.orderSn));
  const vistos929 = pagos02.filter((p) => !perdidos.has(p.orderSn));
  t("REG-a. fixture: 939 no Seller Center, 929 vistos pela paginacao de update_time", () => {
    assert(pagos02.length === 939 && vistos929.length === 929 && perdidos.size === 10, `${pagos02.length} ${vistos929.length}`);
  });
  t("REG-b. 929 perfeitos + evidencia antiga de update_time 'completa' → COMPLETE = false, metricas nulas", () => {
    const r = S.avaliarCompletudeShopee({ ...dia, janelas: cadeiaUpdD3B2(), ancoraDescoberta: null, pedidosPagos: vistos929, itens: itensFx, naoPagosSemObservacaoPosPeriodo: 0 });
    assert(r.completude !== "COMPLETE" && !r.dimensoes.descoberta && r.dimensoes.estado && r.dimensoes.financeiro, JSON.stringify(r));
    // mesmo com uma ancora informada, update_time nao alcanca nada
    const r2 = S.avaliarCompletudeShopee({ ...dia, janelas: cadeiaUpdD3B2(), ancoraDescoberta: ANCORA, pedidosPagos: vistos929, itens: itensFx, naoPagosSemObservacaoPosPeriodo: 0 });
    assert(r2.completude !== "COMPLETE" && r2.motivos.includes("descoberta_por_create_time_nao_provada"), JSON.stringify(r2));
  });
  t("REG-c. com o corpus create_time da ancora (que contem os 939) → COMPLETE e 939/15/22719.10/22205.82", () => {
    const r = S.avaliarCompletudeShopee({ ...dia, janelas: [...cadeiaUpdD3B2(), ...corpus()], ancoraDescoberta: ANCORA, pedidosPagos: pagos02, itens: itensFx, naoPagosSemObservacaoPosPeriodo: 0 });
    assert(r.completude === "COMPLETE", JSON.stringify(r));
    const m = S.calcularMetricasShopee(pagos02, itensFx).metricas;
    assert(m.pedidos === 939 && m.cancelados === 15 && m.vendas === 22719.10 && m.vendasSemDescontosPlataforma === 22205.82, JSON.stringify(m));
  });

  console.log("\n[4-ADV. pedidos adversariais: criados muito antes, pagos em D]");
  const D = dia;
  const advDez = pedido("ADV10", { payTime: "2026-10-02T15:00:00.000Z",
    updateTime: "2026-10-14T15:00:00.000Z", escrowUpdateTime: "2026-10-14T15:00:00.000Z", detailFetchedAt: "2026-10-14T16:00:00.000Z" }); // criado D-10, update D+12
  const advTrinta = pedido("ADV30", { payTime: "2026-10-02T15:00:00.000Z", updateTime: "2026-10-02T15:00:00.000Z",
    escrowUpdateTime: "2026-10-02T15:00:00.000Z" }); // criado D-30
  const criadoDez = new Date("2026-09-22T15:00:00.000Z").getTime(), criadoTrinta = new Date("2026-09-02T15:00:00.000Z").getTime();
  t("ADV-10a. criado em D-10, pago em D, update em D+12: pertence a D", () => {
    assert(criadoDez < D.inicio.getTime() - S.MARGEM_OPERACIONAL_CREATE_TIME_MS, "fixture: criado antes da margem de 7d");
    const em = S.filtrarPagosNoIntervalo([advDez], D.inicio, D.fim);
    assert(em.length === 1 && S.calcularMetricasShopee(em, [item("ADV10")]).metricas.pedidos === 1, "fora de D");
  });
  t("ADV-10b. corpus create_time a partir de D-7 (nao enxergaria a criacao) NAO produz COMPLETE — nem com ancora", () => {
    const desde7 = corpus().filter((j) => new Date(j.inicio).getTime() >= Date.parse("2026-09-25T00:00:00.000Z"));
    assert(desde7.every((j) => !(new Date(j.inicio).getTime() <= criadoDez && criadoDez < new Date(j.fim).getTime())), "fixture: alcanca a criacao");
    const r = av({ janelas: desde7, pedidosPagos: [advDez], itens: [item("ADV10")] });
    assert(r.completude !== "COMPLETE", JSON.stringify(r));
  });
  t("ADV-10c. a cadeia de update_time que alcanca o update do pedido NAO prova D (S2-D3-B2.1); o corpus da ancora prova", () => {
    const cadeiaUpd = [updOk("2026-10-02T00:00:00.000Z", "2026-10-08T00:00:00.000Z"), updOk("2026-10-07T23:45:00.000Z", "2026-10-14T20:00:00.000Z"),
      updOk("2026-10-14T19:45:00.000Z", "2026-10-15T00:00:00.000Z")];
    assert(av({ janelas: cadeiaUpd, pedidosPagos: [advDez], itens: [item("ADV10")] }).completude !== "COMPLETE", "update_time provou");
    assert(av({ janelas: corpus(), pedidosPagos: [advDez], itens: [item("ADV10")] }).completude === "COMPLETE", "corpus nao provou");
  });
  t("ADV-30a. criado em D-30, pago em D: pertence a D e o corpus da ancora o contem", () => {
    assert(criadoTrinta < D.inicio.getTime() - S.MARGEM_OPERACIONAL_CREATE_TIME_MS && criadoTrinta >= ANCORA.getTime(), "fixture");
    const em = S.filtrarPagosNoIntervalo([advTrinta, advDez], D.inicio, D.fim);
    assert(em.map((p) => p.orderSn).sort().join() === "ADV10,ADV30", em.map((p) => p.orderSn).join());
    assert(av({ pedidosPagos: [advTrinta], itens: [item("ADV30")] }).completude === "COMPLETE", "corpus");
  });
  t("ADV-z. nenhuma margem OBSERVADA de N dias nem update_time na regra; so o limite da politica publicada", () => {
    const fonte = readFileSync(join(RAIZ, "lib/vendas/canonico/shopee.ts"), "utf8");
    const corpo = fonte.slice(fonte.indexOf("export function alcanceDescobertaCriacao"), fonte.indexOf("// ── Leitura do banco"))
      .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    assert(corpo.length > 100 && !/MARGEM_OPERACIONAL|LAG_MAXIMO|7 \* 24|86400/.test(corpo), "margem usada na completude");
    assert(/LIMITE_POLITICA_PAGAMENTO_MS = 10 \* 24 \* 3600 \* 1000;/.test(fonte) && /Central de Ajuda/.test(fonte), "limite da politica sem fonte");
    assert(!/watermarkUpdateTime/.test(fonte), "watermark de update_time ainda existe");
    // update_time so aparece como DIAGNOSTICO (motivo), nunca no alcance
    const alc = corpo.slice(0, corpo.indexOf("export function avaliarCompletudeShopee"));
    assert(!/update_time/.test(alc), "alcance olha update_time");
  });

  console.log("\n[5. leitura do banco (duplo)]");
  // duplo minimo: registra filtros e devolve linhas por tabela
  type Reg = { tabela: string; filtros: [string, string, unknown][]; head?: boolean; ordens?: string[]; limite?: number };
  function clienteFalso(dados: Record<string, any[]>, regs: Reg[]) {
    return {
      from(tabela: string) {
        const r: Reg = { tabela, filtros: [], ordens: [] }; regs.push(r);
        // ORDER BY + LIMIT como o PostgREST (a leitura paginada de sync_jobs depende dos dois)
        const ordenar = (d: any[]) => { const o = [...d].sort((a, b) => { for (const k of r.ordens!) { if (a[k] < b[k]) return -1; if (a[k] > b[k]) return 1; } return 0; });
          return r.limite === undefined ? o : o.slice(0, r.limite); };
        const casa = (l: any) => r.filtros.every(([op, col, valor]) => {
          const v = valor as any;
          return op === "eq" ? String(l[col]) === String(v) : op === "in" ? (v as any[]).map(String).includes(String(l[col]))
            : op === "gte" ? l[col] >= v : op === "lt" ? (l[col] !== null && l[col] !== undefined && l[col] < v) : op === "gt" ? l[col] > v
            : op === "is" ? (l[col] ?? null) === v : true;
        });
        const c: any = new Proxy({}, { get(_a, p: string) {
          if (p === "then") return (ok: any) => { const d = (dados[tabela] ?? []).filter(casa); return ok(r.head ? { data: null, count: d.length, error: null } : { data: ordenar(d), error: null }); };
          if (p === "range") return (a: number, b: number) => Promise.resolve({ data: (dados[tabela] ?? []).filter(casa).slice(a, b + 1), error: null });
          if (p === "select") return (_cols: string, o?: { head?: boolean }) => { if (o?.head) r.head = true; return c; };
          return (...args: any[]) => {
            if (["eq", "in", "gte", "lt", "gt", "is"].includes(p)) r.filtros.push([p, args[0], args[1]]);
            if (p === "order") r.ordens!.push(args[0]);
            if (p === "limit") r.limite = args[0];
            return c;
          };
        } });
        return c;
      },
    } as any;
  }
  const UID = "dono-a", OUTRO = "dono-b", L2 = "22222222-2222-4222-8222-222222222222";
  const jobsCorpus = () => corpus().map((j, i) => ({ id: `sj-${String(i).padStart(4, "0")}`, user_id: UID, loja_id: LOJA, marketplace: "Shopee", campo_tempo: "create_time",
    janela_inicio: j.inicio, janela_fim: j.fim, listagem_completa: true, status: "concluido" }));
  const base = () => ({
    lojas: [{ id: LOJA, user_id: UID, marketplace: "Shopee" }, { id: L2, user_id: OUTRO, marketplace: "Shopee" }],
    shopee_pedidos: [
      { user_id: UID, loja_id: LOJA, order_sn: "X", order_status: "SHIPPED", create_time: "2026-10-02T14:00:00.000Z", pay_time: "2026-10-02T15:00:00.000Z", update_time: "2026-10-02T16:00:00.000Z",
        detail_fetched_at: "2026-10-05T00:00:00.000Z", escrow_fetched_at: "z", escrow_update_time: "2026-10-02T16:00:00.000Z", original_shopee_discount: 1, pix_discount: 0 },
      { user_id: UID, loja_id: LOJA, order_sn: "FORA", order_status: "SHIPPED", create_time: "2026-10-03T14:00:00.000Z", pay_time: "2026-10-03T15:00:00.000Z", update_time: "2026-10-03T16:00:00.000Z",
        detail_fetched_at: "2026-10-05T00:00:00.000Z", escrow_fetched_at: "z", escrow_update_time: "2026-10-03T16:00:00.000Z", original_shopee_discount: 9, pix_discount: 0 },
    ],
    pedidos: [{ user_id: UID, marketplace: "Shopee", loja_id: LOJA, order_id: "X", qtd: 2, valor_unit: 10, escrow_voucher_seller: 1, escrow_voucher_shopee: 0, escrow_coin: 0 }],
    sync_jobs: [...jobsCorpus(),
      // a evidencia de update_time NAO e nem lida para completude
      { id: "sj-upd", user_id: UID, loja_id: LOJA, marketplace: "Shopee", campo_tempo: "update_time", janela_inicio: "2026-10-01T00:00:00.000Z", janela_fim: "2026-10-09T00:00:00.000Z", listagem_completa: true, status: "concluido" }],
  });
  const ANC = { [LOJA]: ANCORA.toISOString() };
  t("5a. dono em TODA consulta; so pedidos pagos no dia; corpus da ancora → COMPLETE; total = loja", async () => {
    const regs: Reg[] = [];
    const r = await S.lerVendasShopee(clienteFalso(base(), regs), { userId: UID, de: "2026-10-02", ate: "2026-10-02", ancorasDescoberta: ANC });
    assert(r.completude === "COMPLETE" && r.total?.pedidos === 1 && r.total?.vendas === 20 - 1 + 1, JSON.stringify(r));
    for (const g of regs) assert(g.filtros.some(([op, col, v]) => op === "eq" && col === "user_id" && v === UID), `${g.tabela} sem dono`);
    const sp = regs.find((g) => g.tabela === "shopee_pedidos")!;
    assert(sp.filtros.some(([op, c, v]) => op === "gte" && c === "pay_time" && v === "2026-10-02T03:00:00.000Z"), "inicio");
    assert(sp.filtros.some(([op, c, v]) => op === "lt" && c === "pay_time" && v === "2026-10-03T03:00:00.000Z"), "fim exclusivo");
    const sj = regs.find((g) => g.tabela === "sync_jobs")!;
    assert(sj.filtros.some(([op, c, v]) => op === "eq" && c === "campo_tempo" && v === "create_time"), "le janelas de update_time");
  });
  t("5b. loja de outro dono pedida explicitamente → erro loja_invalida (nunca zero)", async () => {
    let erro = "";
    try { await S.lerVendasShopee(clienteFalso(base(), []), { userId: UID, de: "2026-10-02", ate: "2026-10-02", lojaIds: [L2] }); } catch (e: any) { erro = e.message; }
    assert(erro === "loja_invalida", erro || "nao lancou");
  });
  t("5c. sem ancora: so update_time 'completo' (sem corpus create_time) → PARTIAL e total NULL", async () => {
    const d = base(); d.sync_jobs = d.sync_jobs.filter((j) => j.campo_tempo === "update_time");
    const r = await S.lerVendasShopee(clienteFalso(d, []), { userId: UID, de: "2026-10-02", ate: "2026-10-02" });
    assert(r.completude === "PARTIAL" && r.total === null && r.lojas[0].metricas === null && r.lojas[0].motivos.includes("descoberta_por_create_time_nao_provada"), JSON.stringify(r));
  });
  t("5c2. sem ancora + corpus create_time cobrindo inicio − 10d → COMPLETE pela POLITICA, e o B so olha o corpus relevante", async () => {
    const regs: Reg[] = [];
    const r = await S.lerVendasShopee(clienteFalso(base(), regs), { userId: UID, de: "2026-10-02", ate: "2026-10-02" });
    assert(r.completude === "COMPLETE" && r.lojas[0].baseDescoberta === "POLITICA_PRAZO_PAGAMENTO" && r.total?.pedidos === 1, JSON.stringify(r));
    const b = regs.filter((g) => g.tabela === "shopee_pedidos" && g.head);
    assert(b.length === 2 && b.every((g) => g.filtros.some(([op, c, v]) => op === "gte" && c === "create_time" && v === "2026-09-22T03:00:00.000Z")), JSON.stringify(b));
  });
  t("5d. pedido do corpus nao pago visto so antes do fim do dia → PARTIAL (poderia ter sido pago no dia)", async () => {
    const d = base();
    d.shopee_pedidos.push({ user_id: UID, loja_id: LOJA, order_sn: "U", order_status: "UNPAID", create_time: "2026-10-01T10:00:00.000Z", pay_time: null as any,
      update_time: "2026-10-01T10:00:00.000Z", detail_fetched_at: "2026-10-02T20:00:00.000Z", escrow_fetched_at: null as any, escrow_update_time: null as any, original_shopee_discount: null as any, pix_discount: null as any });
    const r = await S.lerVendasShopee(clienteFalso(d, []), { userId: UID, de: "2026-10-02", ate: "2026-10-02", ancorasDescoberta: ANC });
    assert(r.completude === "PARTIAL" && r.total === null && r.lojas[0].motivos.includes("nao_pagos_sem_observacao_pos_periodo:1"), JSON.stringify(r));
  });

  console.log("\n[7. PERIODOS (S2-D3-B3): pay_time em America/Sao_Paulo, [inicio 00:00, dia seguinte ao fim 00:00)]");
  const em = (de: string, ate: string, pay: string) => { const { inicio, fim } = S.intervaloSaoPaulo(de, ate); return S.filtrarPagosNoIntervalo([pedido("P", { payTime: pay })], inicio, fim).length === 1; };
  const met = (de: string, ate: string) => { const { inicio, fim } = S.intervaloSaoPaulo(de, ate); return S.calcularMetricasShopee(S.filtrarPagosNoIntervalo(pedidosFx, inicio, fim), itensFx).metricas; };
  t("7A. um unico dia (02/10) = Seller Center 939/15/22719.10/22205.82", () => {
    const m = met("2026-10-02", "2026-10-02");
    assert(m.pedidos === 939 && m.cancelados === 15 && m.vendas === 22719.10 && m.vendasSemDescontosPlataforma === 22205.82, JSON.stringify(m));
  });
  t("7B. 01/10 → 03/10 = 2828 / 62 / 68378.37 / 67008.24 (exato)", () => {
    const m = met("2026-10-01", "2026-10-03");
    assert(m.pedidos === 2828 && m.cancelados === 62 && m.vendas === 68378.37 && m.vendasSemDescontosPlataforma === 67008.24, JSON.stringify(m));
  });
  t("7C/D. inicio incluso; fim selecionado incluso comercialmente = dia seguinte 00:00 EXCLUSIVO", () => {
    const { inicio, fim } = S.intervaloSaoPaulo("2026-10-01", "2026-10-03");
    assert(inicio.toISOString() === "2026-10-01T03:00:00.000Z" && fim.toISOString() === "2026-10-04T03:00:00.000Z", `${inicio.toISOString()} ${fim.toISOString()}`);
  });
  t("7E-H. 30/09 23:59:59 fora; 01/10 00:00 dentro; 03/10 23:59:59 dentro; 04/10 00:00 fora (horario de Sao Paulo)", () => {
    assert(!em("2026-10-01", "2026-10-03", "2026-10-01T02:59:59.000Z"), "E");
    assert(em("2026-10-01", "2026-10-03", "2026-10-01T03:00:00.000Z"), "F");
    assert(em("2026-10-01", "2026-10-03", "2026-10-04T02:59:59.000Z"), "G");
    assert(!em("2026-10-01", "2026-10-03", "2026-10-04T03:00:00.000Z"), "H");
    assert(em("2026-10-01", "2026-10-03", "2026-10-04T02:59:59.999Z") && !em("2026-10-01", "2026-10-03", "2026-10-01T02:59:59.999Z"), "milissegundo da borda");
  });
  t("7I/J. fuso America/Sao_Paulo pela tabela (nao -3h fixo): periodo cruzando o inicio do horario de verao de 2018", () => {
    // 04/11/2018 comecou o horario de verao (UTC-2): 03/11 00:00 = 03:00Z, 05/11 00:00 = 02:00Z
    const { inicio, fim } = S.intervaloSaoPaulo("2018-11-03", "2018-11-04");
    assert(inicio.toISOString() === "2018-11-03T03:00:00.000Z" && fim.toISOString() === "2018-11-05T02:00:00.000Z", `${inicio.toISOString()} ${fim.toISOString()}`);
    assert(em("2018-11-03", "2018-11-04", "2018-11-05T01:59:59.000Z") && !em("2018-11-03", "2018-11-04", "2018-11-05T02:00:00.000Z"), "borda no horario de verao");
  });
  t("7K. AGREGACAO: metric(01→03) = metric(01) + metric(02) + metric(03) em pedidos, cancelados, unidades, vendas e sem descontos — sem erro de arredondamento", () => {
    const tot = met("2026-10-01", "2026-10-03");
    const dias = ["2026-10-01", "2026-10-02", "2026-10-03"].map((d) => met(d, d));
    const soma = S.somarMetricas(dias);
    assert(JSON.stringify(tot) === JSON.stringify(soma), `${JSON.stringify(tot)} != ${JSON.stringify(soma)}`);
    const c = (x: number) => Math.round(x * 100);
    assert(c(tot.vendas) === dias.reduce((s, m) => s + c(m.vendas), 0) && c(tot.vendasSemDescontosPlataforma) === dias.reduce((s, m) => s + c(m.vendasSemDescontosPlataforma), 0), "centavos");
    assert(tot.unidades === dias.reduce((s, m) => s + m.unidades, 0) && tot.unidades > 0, "unidades");
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
    // D15D3: excecao EXATA — so o motor intraday Shopee, so com o conteudo aprovado (sha256 do helper D15D2).
    // A verificacao de CALCULO abaixo continua valendo para ele.
    const consultaCandidatos = (f: string) => f === MOTOR_INTRADAY_SHOPEE && motorIntradayShopeeExato(RAIZ);
    const fora = arqs.filter((f) => !ARMAZENAM.includes(f) && !consultaCandidatos(f) &&
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

  // ── CORRECAO DO 57014: paginacao KEYSET (data, id) — sem OFFSET, sem varrer a PK; mesmo conjunto, sem perda/duplicata ──
  const ML = await import("../lib/vendas/canonico/ml");
  /** Banco em memoria com a semantica do PostgREST que os leitores usam (inclusive `or`, `order` multiplo e `limit`). */
  // teto = max-rows do PostgREST (corta TODA resposta, sem erro); ignorarOrdem = servidor que nao aplica ORDER BY
  const bancoKeyset = (tabelas: Record<string, any[]>, opc: { falhar?: (tabela: string, n: number) => boolean; ignorarCursor?: boolean; teto?: number; ignorarOrdem?: boolean } = {}) => {
    const chamadas: { tabela: string; filtros: string[]; ordens: string[]; limite: number | null; or: string | null; range: boolean; head: boolean }[] = [];
    const ts = (v: unknown) => typeof v === "string" && /^\d{4}-\d\d-\d\dT/.test(v) ? Date.parse(v) : NaN;
    const cmp = (a: any, b: any) => { const x = ts(a), y = ts(b); if (!isNaN(x) && !isNaN(y)) return x - y; return a < b ? -1 : a > b ? 1 : 0; };
    const nulo = (v: unknown) => v === null || v === undefined;
    return { from(tabela: string) {
      const q = { tabela, filtros: [] as string[], ordens: [] as string[], limite: null as number | null, or: null as string | null, range: false, head: false };
      const preds: ((r: any) => boolean)[] = [];
      chamadas.push(q);
      const api: any = {
        select(_c: string, o?: { head?: boolean }) { if (o?.head) q.head = true; return api; },
        eq(c: string, v: any) { q.filtros.push(`eq:${c}`); preds.push((r) => String(r[c]) === String(v)); return api; },
        gte(c: string, v: any) { q.filtros.push(`gte:${c}`); preds.push((r) => !nulo(r[c]) && cmp(r[c], v) >= 0); return api; },
        lt(c: string, v: any) { q.filtros.push(`lt:${c}`); preds.push((r) => !nulo(r[c]) && cmp(r[c], v) < 0); return api; },
        gt(c: string, v: any) { q.filtros.push(`gt:${c}`); if (!opc.ignorarCursor) preds.push((r) => !nulo(r[c]) && cmp(r[c], v) > 0); return api; },
        is(c: string, v: any) { q.filtros.push(`is:${c}`); preds.push((r) => (r[c] ?? null) === v); return api; },
        in(c: string, vs: any[]) { q.filtros.push(`in:${c}`); preds.push((r) => vs.map(String).includes(String(r[c]))); return api; },
        not(c: string, _op: string, _v: string) { q.filtros.push(`not:${c}`); return api; },
        or(expr: string) {
          q.or = expr;
          const termos = expr.split(/,(?=[a-z_]+\.gt\.)/).map((t) => { const m = t.match(/^([a-z_]+)\.gt\."(.*)"$/); if (!m) throw new Error(`or invalido: ${t}`); return m; });
          if (!opc.ignorarCursor) preds.push((r) => termos.some(([, c, v]) => !nulo(r[c]) && cmp(r[c], v) > 0));
          return api;
        },
        order(c: string) { q.ordens.push(c); return api; },
        limit(n: number) { q.limite = n; return api; },
        range() { q.range = true; return api; },
        then(ok: any, ko: any) {
          const n = chamadas.filter((x) => x.tabela === tabela).length;
          if (opc.falhar?.(tabela, n)) return Promise.resolve({ data: null, count: null, error: { code: "57014", message: "canceling statement due to statement timeout" } }).then(ok, ko);
          let linhas = (tabelas[tabela] ?? []).filter((r) => preds.every((p) => p(r)));
          if (q.head) return Promise.resolve({ data: null, count: linhas.length, error: null }).then(ok, ko);
          if (!opc.ignorarOrdem) linhas = [...linhas].sort((a, b) => { for (const c of q.ordens) { const d = nulo(a[c]) && nulo(b[c]) ? 0 : nulo(a[c]) ? 1 : nulo(b[c]) ? -1 : cmp(a[c], b[c]); if (d) return d; } return 0; });
          if (q.limite !== null) linhas = linhas.slice(0, q.limite);
          if (opc.teto !== undefined) linhas = linhas.slice(0, opc.teto);
          return Promise.resolve({ data: linhas, error: null }).then(ok, ko);
        },
      };
      return api;
    }, chamadas };
  };
  const capturarErros = async <T,>(f: () => Promise<T>) => {
    const antes = console.error; const msgs: string[] = []; console.error = (...a: any[]) => { msgs.push(a.map(String).join(" ")); };
    try { return { r: await f(), msgs, erro: null as string | null }; } catch (e: any) { return { r: null as T | null, msgs, erro: e?.message ?? String(e) }; } finally { console.error = antes; }
  };

  // ML: 2.600 pedidos de setembro numa loja; 1.500 deles no MESMO segundo (atravessa as paginas 1→2); bordas de dia/mes;
  // outra loja do mesmo dono e outro dono com os mesmos order_id (isolamento)
  const DONO = "dono-ks", ML_K = "aaaaaaaa-0000-4000-8000-0000000000ks", ML_K2 = "aaaaaaaa-0000-4000-8000-0000000000k2";
  const mlPedido = (loja: string, user: string, i: number, quando: string, valor = 10) => ({ user_id: user, loja_id: loja, order_id: `2000${String(i).padStart(7, "0")}`,
    date_closed: quando, cancel_detail_code: null, total_amount: valor, unidades: 1 + (i % 3), fetched_at: "2026-10-15T00:00:00.000Z" });
  const mundoML = () => {
    const ped: any[] = [];
    for (let i = 0; i < 2600; i++) {
      const quando = i < 1500 ? "2026-09-10T15:00:00.000Z"                                  // 1.500 empatados no timestamp
        : new Date(Date.parse("2026-09-01T03:00:00.000Z") + (i * 997 % 2592000) * 1000).toISOString();
      ped.push(mlPedido(ML_K, DONO, (i * 7919) % 100000, quando, 10 + (i % 17)));            // order_id fora da ordem da data
    }
    ped.push(mlPedido(ML_K, DONO, 99990, "2026-09-01T03:00:00.000Z", 1));                  // 1a fronteira: 01/09 00:00 SP (entra)
    ped.push(mlPedido(ML_K, DONO, 99991, "2026-10-01T02:59:59.999Z", 2));                  // 30/09 23:59:59.999 SP (entra)
    ped.push(mlPedido(ML_K, DONO, 99992, "2026-10-01T03:00:00.000Z", 1000));               // 01/10 00:00 SP (fora)
    ped.push(mlPedido(ML_K, DONO, 99993, "2026-09-01T02:59:59.999Z", 1000));               // 31/08 23:59:59.999 SP (fora)
    for (let i = 0; i < 300; i++) ped.push(mlPedido(ML_K2, DONO, i, "2026-09-10T15:00:00.000Z", 5));
    for (let i = 0; i < 300; i++) ped.push({ ...mlPedido(ML_K, "outro-dono", i, "2026-09-10T15:00:00.000Z", 5) });
    return {
      lojas: [{ id: ML_K, user_id: DONO, marketplace: "ML" }, { id: ML_K2, user_id: DONO, marketplace: "ML" }],
      ml_pedidos: ped,
      sync_jobs: [ML_K, ML_K2].map((l) => ({ id: `sj-${l}`, user_id: DONO, loja_id: l, marketplace: "ML", campo_tempo: "date_closed", janela_inicio: "2026-08-25T03:00:00.000Z", janela_fim: "2026-10-05T03:00:00.000Z", listagem_completa: true, status: "concluido" })),
    };
  };
  const esperadoML = (m: any, loja: string) => {
    const set = m.ml_pedidos.filter((p: any) => p.user_id === DONO && p.loja_id === loja && Date.parse(p.date_closed) >= Date.parse("2026-09-01T03:00:00.000Z") && Date.parse(p.date_closed) < Date.parse("2026-10-01T03:00:00.000Z"));
    // a mesma conversao que o leitor faz da linha do banco
    return { n: set.length, metricas: ML.calcularMetricasML(set.map((r: any) => ({ lojaId: r.loja_id, orderId: r.order_id, dateClosed: r.date_closed, cancelCode: r.cancel_detail_code, totalAmount: r.total_amount, unidades: r.unidades, fetchedAt: r.fetched_at }))) };
  };
  t("KS-1. ML: 2.604 pedidos (1.500 no MESMO segundo, cruzando páginas) → todos exatamente 1x; fronteiras de dia/mês em BRT; métricas = cálculo oficial", async () => {
    const m = mundoML(); const b = bancoKeyset(m);
    const r = await ML.lerVendasML(b as any, { userId: DONO, de: "2026-09-01", ate: "2026-09-30", lojaIds: [ML_K] });
    const e = esperadoML(m, ML_K);
    assert(e.n === 2602, `pré-condição ${e.n}`);
    assert(r.lojas[0].completude === "COMPLETE" && JSON.stringify(r.lojas[0].metricas) === JSON.stringify(e.metricas), `${JSON.stringify(r.lojas[0].metricas)} ≠ ${JSON.stringify(e.metricas)}`);
    const pags = b.chamadas.filter((c) => c.tabela === "ml_pedidos");
    assert(pags.length === 3 && pags.every((c) => !c.range && c.limite === 1000 && JSON.stringify(c.ordens) === JSON.stringify(["date_closed", "order_id"])), JSON.stringify(pags.map((c) => [c.limite, c.ordens, c.range])));
    assert(pags[0].or === null && pags[1].or !== null && /^date_closed\.gt\."[^"]+",order_id\.gt\."[^"]+"$/.test(pags[1].or!) && pags[1].filtros.filter((f) => f === "gte:date_closed").length === 2, JSON.stringify(pags[1]));
  });
  t("KS-2. ML: isolamento — outra loja do dono e outro dono com os MESMOS order_id/timestamps nunca entram; loja 2 sozinha = 300", async () => {
    const m = mundoML();
    const r = await ML.lerVendasML(bancoKeyset(m) as any, { userId: DONO, de: "2026-09-01", ate: "2026-09-30" });
    const k = r.lojas.find((l: any) => l.lojaId === ML_K)!, k2 = r.lojas.find((l: any) => l.lojaId === ML_K2)!;
    assert(JSON.stringify(k.metricas) === JSON.stringify(esperadoML(m, ML_K).metricas) && k2.metricas!.pedidos === 300 && k2.metricas!.vendas === 1500, JSON.stringify([k.metricas, k2.metricas]));
  });
  t("KS-3. keyset: múltiplo EXATO de 1000 (3.000) termina com todas (última página vazia); 0 → vazio; 2.500 empatados no mesmo valor → sem perda/duplicata", async () => {
    for (const [n, empatados] of [[3000, false], [0, false], [2500, true]] as const) {
      const linhas = Array.from({ length: n }, (_, i) => ({ id: `K${String((i * 37) % n).padStart(5, "0")}`, dt: empatados ? "2026-09-10T15:00:00.000Z" : new Date(Date.parse("2026-09-01T03:00:00.000Z") + Math.floor(i / 3) * 1000).toISOString() }));
      const b = bancoKeyset({ x: linhas });
      const r = await S.paginarKeyset<any>("teste", "dt", "id", (cur, lim) => S.aplicarKeyset(b.from("x").select("*"), "dt", "id", cur, lim));
      const ids = r.map((x) => x.id);
      assert(r.length === n && new Set(ids).size === n, `${n}: ${r.length} / únicos ${new Set(ids).size}`);
      assert(b.chamadas.length === Math.floor(n / 1000) + 1, `${n}: ${b.chamadas.length} páginas`);
    }
  });
  t("KS-4. falha em página INTERMEDIÁRIA (57014 na 2a) → leitura_falhou, nunca parcial; log com etapa + código, sem filtros/ids/dono", async () => {
    const m = mundoML();
    const c = await capturarErros(() => ML.lerVendasML(bancoKeyset(m, { falhar: (t, n) => t === "ml_pedidos" && n === 2 }) as any, { userId: DONO, de: "2026-09-01", ate: "2026-09-30", lojaIds: [ML_K] }));
    assert(c.erro === "leitura_falhou", c.erro ?? "não lançou");
    assert(c.msgs.length === 1 && c.msgs[0] === "[vendas-canonico] leitura falhou etapa=ml_pedidos codigo=57014", JSON.stringify(c.msgs));
    assert(!c.msgs[0].includes(DONO) && !c.msgs[0].includes(ML_K) && !/2000\d{7}/.test(c.msgs[0]), "log vaza dado");
  });
  t("KS-5. cursor que não avança numa página cheia (banco ignorando o filtro) → falha fechado na 2a página, nunca laço", async () => {
    const linhas = Array.from({ length: 2500 }, (_, i) => ({ id: `K${i}`, dt: "2026-09-10T15:00:00.000Z" }));
    // teto do simulador: sem a trava, o laco acabaria so aqui (6a pagina, outro codigo) — o teste falha, nao trava
    const b = bancoKeyset({ x: linhas }, { ignorarCursor: true, falhar: (_t, n) => n > 5 });
    const c = await capturarErros(() => S.paginarKeyset<any>("teste", "dt", "id", (cur, lim) => S.aplicarKeyset(b.from("x").select("*"), "dt", "id", cur, lim)));
    assert(c.erro === "leitura_falhou" && b.chamadas.length === 2 && c.msgs.some((x) => x.includes("codigo=linha_repetida")), `${c.erro} / ${b.chamadas.length} / ${c.msgs.join(" | ")}`);
  });
  t("KS-6. valor do cursor com aspas/barra → falha fechado (nunca monta filtro com conteúdo arbitrário)", () => {
    let e = ""; try { S.aplicarKeyset(bancoKeyset({}).from("x"), "dt", "id", { valor: '2026"x', id: "1" }, 1000); } catch (x: any) { e = x.message; }
    assert(e === "leitura_falhou", e || "não lançou");
  });

  // Shopee: 2.300 pagos (1.200 no mesmo segundo) com itens + 1.150 NÃO pagos (pay_time NULL) no recorte da regra B
  const SH_K = "aaaaaaaa-0000-4000-8000-000000000shk";
  const mundoShopee = (detalheNaoPagos: string) => {
    const sp: any[] = [], itens: any[] = [];
    for (let i = 0; i < 2300; i++) {
      const pay = i < 1200 ? "2026-09-12T18:00:00.000Z" : new Date(Date.parse("2026-09-01T03:00:00.000Z") + (i * 1013 % 2592000) * 1000).toISOString();
      const sn = `SN${String((i * 7907) % 100000).padStart(6, "0")}`;
      sp.push({ user_id: DONO, loja_id: SH_K, order_sn: sn, order_status: "COMPLETED", create_time: new Date(Date.parse(pay) - 3600000).toISOString(), pay_time: pay, update_time: pay,
        detail_fetched_at: "2026-10-15T00:00:00.000Z", escrow_fetched_at: "2026-10-15T00:00:00.000Z", escrow_update_time: pay, original_shopee_discount: 0, pix_discount: 0 });
      itens.push({ user_id: DONO, marketplace: "Shopee", loja_id: SH_K, order_id: sn, qtd: 1 + (i % 2), valor_unit: 20, escrow_voucher_seller: 0, escrow_voucher_shopee: 0, escrow_coin: 0 });
    }
    for (let i = 0; i < 1150; i++) sp.push({ user_id: DONO, loja_id: SH_K, order_sn: `NP${String((i * 31) % 5000).padStart(5, "0")}`, order_status: "CANCELLED",
      create_time: "2026-09-05T12:00:00.000Z", pay_time: null, update_time: "2026-09-05T12:00:00.000Z", detail_fetched_at: detalheNaoPagos,
      escrow_fetched_at: null, escrow_update_time: null, original_shopee_discount: null, pix_discount: null });
    return { lojas: [{ id: SH_K, user_id: DONO, marketplace: "Shopee" }], shopee_pedidos: sp, pedidos: itens,
      sync_jobs: [{ id: "sj-shk", user_id: DONO, loja_id: SH_K, marketplace: "Shopee", campo_tempo: "create_time", janela_inicio: "2026-08-15T03:00:00.000Z", janela_fim: "2026-10-05T03:00:00.000Z", listagem_completa: true, status: "concluido" }] };
  };
  t("KS-7. Shopee: 2.300 pagos (1.200 empatados) → todos 1x, itens de todos, métricas = cálculo oficial; páginas keyset (pay_time, order_sn)", async () => {
    const m = mundoShopee("2026-10-15T00:00:00.000Z"); const b = bancoKeyset(m);
    const r = await S.lerVendasShopee(b as any, { userId: DONO, de: "2026-09-01", ate: "2026-09-30" });
    const pagos = m.shopee_pedidos.filter((p: any) => p.pay_time).map((r: any) => ({ lojaId: r.loja_id, orderSn: r.order_sn, orderStatus: r.order_status, createTime: r.create_time, payTime: r.pay_time, updateTime: r.update_time,
      detailFetchedAt: r.detail_fetched_at, escrowFetchedAt: r.escrow_fetched_at, escrowUpdateTime: r.escrow_update_time, originalShopeeDiscount: r.original_shopee_discount, pixDiscount: r.pix_discount }));
    const its = m.pedidos.map((r: any) => ({ lojaId: r.loja_id, orderSn: r.order_id, precoUnitario: r.valor_unit, quantidade: r.qtd, voucherVendedor: 0, voucherShopee: 0, moedas: 0 }));
    const esperado = S.calcularMetricasShopee(pagos, its).metricas;
    assert(r.lojas[0].completude === "COMPLETE" && JSON.stringify(r.lojas[0].metricas) === JSON.stringify(esperado) && esperado.pedidos === 2300, `${r.lojas[0].completude} ${JSON.stringify(r.lojas[0].metricas)}`);
    const pags = b.chamadas.filter((c) => c.tabela === "shopee_pedidos" && !c.head);
    assert(pags.length === 3 && pags.every((c) => !c.range && JSON.stringify(c.ordens) === JSON.stringify(["pay_time", "order_sn"])), JSON.stringify(pags.map((c) => c.ordens)));
  });
  t("KS-8. Shopee não pagos (pay_time NULL): 1.150 linhas em keyset só pelo order_sn — conferência com a contagem oficial PASSA (nada perdido)", async () => {
    const m = mundoShopee("2026-09-20T00:00:00.000Z");   // observados ANTES do fim → período não COMPLETE → lê as linhas
    const b = bancoKeyset(m);
    const r = await S.lerVendasShopee(b as any, { userId: DONO, de: "2026-09-01", ate: "2026-09-30", observado: true });
    const dias = Object.values(r.lojas[0].observadoPorDia ?? {});
    assert(r.lojas[0].completude !== "COMPLETE" && dias.length === 30 && !dias.some((d: any) => d.motivos.includes("nao_pagos_divergem_da_contagem_oficial")), JSON.stringify(dias.slice(0, 2)));
    const np = b.chamadas.filter((c) => c.tabela === "shopee_pedidos" && !c.head && c.filtros.includes("is:pay_time"));
    assert(np.length === 2 && np[1].filtros.includes("gt:order_sn") && np[1].or === null && JSON.stringify(np[0].ordens) === JSON.stringify(["pay_time", "order_sn"]), JSON.stringify(np.map((c) => c.filtros)));
  });
  t("KS-9. nenhuma leitura de pedidos usa OFFSET/range (o padrão que estourou 8 s)", () => {
    for (const f of ["lib/vendas/canonico/ml.ts", "lib/vendas/canonico/shopee.ts"]) {
      const src = readFileSync(join(RAIZ, f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
      assert(!/\.range\(/.test(src) && !/PAGINAS_EM_PARALELO/.test(src), `${f}: range/offset ou páginas em paralelo`);
    }
  });

  // ── P1 sync_jobs: o PostgREST corta toda resposta em max-rows (1000) SEM erro — as janelas sao lidas em paginas keyset por id ──
  const pad = (i: number) => String(i).padStart(5, "0");
  // embaralha de forma deterministica (a ordem de insercao nunca e a do id)
  const embaralhar = <X,>(xs: X[]) => xs.map((x, i) => [((i * 7919) % 104729), x] as const).sort((a, b) => a[0] - b[0]).map(([, x]) => x);
  // janelas COMPLETAS que nao tocam o periodo (2025): so empurram a janela util para fora da 1a pagina
  const lixo = (n: number, loja: string, mp: "ML" | "Shopee") => Array.from({ length: n }, (_, i) => ({ id: `sj-${pad(i)}`, user_id: DONO, loja_id: loja, marketplace: mp,
    campo_tempo: mp === "ML" ? "date_closed" : "create_time", janela_inicio: new Date(Date.parse("2025-01-01T03:00:00.000Z") + i * 1800_000).toISOString(),
    janela_fim: new Date(Date.parse("2025-01-01T03:00:00.000Z") + (i + 1) * 1800_000).toISOString(), listagem_completa: true, status: "concluido" }));
  const paginaJanelas = (b: ReturnType<typeof bancoKeyset>) => (apos: string | null, lim: number) => {
    let q: any = b.from("x").select("*"); if (apos !== null) q = q.gt("id", apos); return q.order("id", { ascending: true }).limit(lim);
  };
  const SH_J = "aaaaaaaa-0000-4000-8000-000000000shj", ML_J = "aaaaaaaa-0000-4000-8000-0000000000mj";
  const mundoJanelasShopee = (nLixo: number) => {
    const sp: any[] = [], itens: any[] = [];
    for (let i = 0; i < 3; i++) {
      const pay = `2026-09-1${i}T15:00:00.000Z`, sn = `SJ${i}`;
      sp.push({ user_id: DONO, loja_id: SH_J, order_sn: sn, order_status: "COMPLETED", create_time: new Date(Date.parse(pay) - 3600000).toISOString(), pay_time: pay, update_time: pay,
        detail_fetched_at: "2026-10-15T00:00:00.000Z", escrow_fetched_at: "2026-10-15T00:00:00.000Z", escrow_update_time: pay, original_shopee_discount: 1, pix_discount: 0 });
      itens.push({ user_id: DONO, marketplace: "Shopee", loja_id: SH_J, order_id: sn, qtd: 1 + i, valor_unit: 25, escrow_voucher_seller: 0, escrow_voucher_shopee: 0, escrow_coin: 0 });
    }
    // a janela que prova setembro (desde 22/08) tem o MAIOR id: so aparece depois da 1a pagina
    const ancora = { id: "sj-zzzzz", user_id: DONO, loja_id: SH_J, marketplace: "Shopee", campo_tempo: "create_time", janela_inicio: "2026-08-15T03:00:00.000Z", janela_fim: "2026-10-05T03:00:00.000Z", listagem_completa: true, status: "concluido" };
    return { lojas: [{ id: SH_J, user_id: DONO, marketplace: "Shopee" }], shopee_pedidos: sp, pedidos: itens, sync_jobs: embaralhar([ancora, ...lixo(nLixo, SH_J, "Shopee")]) };
  };
  const chamadasJanelas = (b: ReturnType<typeof bancoKeyset>) => b.chamadas.filter((c) => c.tabela === "sync_jobs");

  t("SJ-1. Shopee: 2.345 janelas, âncora FORA da 1a página, teto 1000 → COMPLETE; 4 páginas (1000/1000/345/0) por id, dono/loja/campo em todas; métricas = cálculo oficial", async () => {
    const m = mundoJanelasShopee(2344); const b = bancoKeyset(m, { teto: 1000 });
    const primeiraPagina = [...m.sync_jobs].sort((x, y) => (x.id < y.id ? -1 : 1)).slice(0, 1000).map((j) => j.id);
    assert(!primeiraPagina.includes("sj-zzzzz"), "pré-condição: âncora deveria estar fora da 1a página");
    const r = await S.lerVendasShopee(b as any, { userId: DONO, de: "2026-09-01", ate: "2026-09-30" });
    const pagos = m.shopee_pedidos.map((r: any) => ({ lojaId: r.loja_id, orderSn: r.order_sn, orderStatus: r.order_status, createTime: r.create_time, payTime: r.pay_time, updateTime: r.update_time,
      detailFetchedAt: r.detail_fetched_at, escrowFetchedAt: r.escrow_fetched_at, escrowUpdateTime: r.escrow_update_time, originalShopeeDiscount: r.original_shopee_discount, pixDiscount: r.pix_discount }));
    const its = m.pedidos.map((r: any) => ({ lojaId: r.loja_id, orderSn: r.order_id, precoUnitario: r.valor_unit, quantidade: r.qtd, voucherVendedor: 0, voucherShopee: 0, moedas: 0 }));
    const esperado = S.calcularMetricasShopee(pagos, its).metricas;
    assert(r.lojas[0].completude === "COMPLETE" && JSON.stringify(r.total) === JSON.stringify(esperado) && esperado.pedidos === 3, `${r.lojas[0].completude} ${r.lojas[0].motivos} ${JSON.stringify(r.total)}`);
    const pags = chamadasJanelas(b);
    assert(pags.length === 4 && pags.every((c) => JSON.stringify(c.ordens) === JSON.stringify(["id"]) && c.limite === 1000 && !c.range), JSON.stringify(pags.map((c) => [c.ordens, c.limite])));
    assert(!pags[0].filtros.includes("gt:id") && pags.slice(1).every((c) => c.filtros.includes("gt:id")), "cursor por id a partir da 2a página");
    assert(pags.every((c) => ["eq:user_id", "eq:loja_id", "eq:marketplace", "eq:campo_tempo", "not:janela_inicio"].every((f) => c.filtros.includes(f))), "filtro perdido numa página");
  });
  t("SJ-2. ML: 1.500 janelas fora de ordem de inserção, âncora com o maior id → COMPLETE com todas; mesma loja nas 2 páginas", async () => {
    const ped = [0, 1, 2].map((i) => ({ user_id: DONO, loja_id: ML_J, order_id: `9000${i}`, date_closed: `2026-09-2${i}T15:00:00.000Z`, cancel_detail_code: null, total_amount: 10 + i, unidades: 1, fetched_at: "2026-10-15T00:00:00.000Z" }));
    const ancora = { id: "sj-zzzzz", user_id: DONO, loja_id: ML_J, marketplace: "ML", campo_tempo: "date_closed", janela_inicio: "2026-09-01T03:00:00.000Z", janela_fim: "2026-10-01T03:00:00.000Z", listagem_completa: true, status: "concluido" };
    const m = { lojas: [{ id: ML_J, user_id: DONO, marketplace: "ML" }], ml_pedidos: ped, sync_jobs: embaralhar([ancora, ...lixo(1499, ML_J, "ML")]) };
    const b = bancoKeyset(m, { teto: 1000 });
    const r = await ML.lerVendasML(b as any, { userId: DONO, de: "2026-09-01", ate: "2026-09-30" });
    const esperado = ML.calcularMetricasML(ped.map((r) => ({ lojaId: r.loja_id, orderId: r.order_id, dateClosed: r.date_closed, cancelCode: r.cancel_detail_code, totalAmount: r.total_amount, unidades: r.unidades, fetchedAt: r.fetched_at })));
    assert(r.lojas[0].completude === "COMPLETE" && JSON.stringify(r.total) === JSON.stringify(esperado) && esperado.pedidos === 3, `${r.lojas[0].completude} ${JSON.stringify(r.total)}`);
    const pags = chamadasJanelas(b);
    assert(pags.length === 3 && pags.every((c) => JSON.stringify(c.ordens) === JSON.stringify(["id"]) && c.filtros.includes("eq:loja_id") && c.filtros.includes("eq:campo_tempo")), JSON.stringify(pags.map((c) => c.filtros)));
  });
  t("SJ-3. EXATAMENTE 1000 janelas → 1000, com a página vazia confirmando o fim (2 idas); 999 → 999 (página curta não é fim: 2 idas); 0 → vazio (1 ida)", async () => {
    for (const [n, idas] of [[1000, 2], [999, 2], [0, 1]] as const) {
      const b = bancoKeyset({ x: embaralhar(lixo(n, SH_J, "Shopee")) }, { teto: 1000 });
      const r = await S.lerJanelasSyncJobs<any>("teste_janelas", paginaJanelas(b));
      assert(r.length === n && b.chamadas.length === idas, `${n}: ${r.length} linhas / ${b.chamadas.length} idas`);
    }
  });
  t("SJ-4. 2.500 janelas embaralhadas, teto MENOR que o limite (300 < 1000) → todas, cada uma 1x, ids estritamente crescentes (sem lacuna nem duplicata)", async () => {
    const todas = lixo(2500, SH_J, "Shopee");
    for (const teto of [1000, 300]) {
      const b = bancoKeyset({ x: embaralhar(todas) }, { teto });
      const r = await S.lerJanelasSyncJobs<any>("teste_janelas", paginaJanelas(b));
      const ids = r.map((x) => x.id);
      assert(ids.length === 2500 && new Set(ids).size === 2500 && ids.every((id, i) => i === 0 || id > ids[i - 1]) && JSON.stringify(ids) === JSON.stringify(todas.map((j) => j.id)),
        `teto ${teto}: ${ids.length} / ${new Set(ids).size}`);
      assert(b.chamadas.length === Math.ceil(2500 / teto) + 1, `teto ${teto}: ${b.chamadas.length} idas`);   // + a página vazia
    }
  });
  t("SJ-5. falha na 2a página (57014) → leitura_falhou, nunca o conjunto da 1a; log só com etapa + código", async () => {
    const b = bancoKeyset({ x: lixo(1500, SH_J, "Shopee") }, { teto: 1000, falhar: (_t, n) => n === 2 });
    const c = await capturarErros(() => S.lerJanelasSyncJobs<any>("teste_janelas", paginaJanelas(b)));
    assert(c.erro === "leitura_falhou" && c.r === null && b.chamadas.length === 2, `${c.erro} / ${b.chamadas.length}`);
    assert(c.msgs.length === 1 && c.msgs[0] === "[vendas-canonico] leitura falhou etapa=teste_janelas codigo=57014", JSON.stringify(c.msgs));
    // e no leitor: a falha da 2a página de janelas derruba a loja inteira (nunca completude de um conjunto cortado)
    const m = mundoJanelasShopee(2344);
    const c2 = await capturarErros(() => S.lerVendasShopee(bancoKeyset(m, { teto: 1000, falhar: (t, n) => t === "sync_jobs" && n === 2 }) as any, { userId: DONO, de: "2026-09-01", ate: "2026-09-30" }));
    assert(c2.erro === "leitura_falhou" && c2.msgs.some((x) => x === "[vendas-canonico] leitura falhou etapa=shopee_janelas codigo=57014"), `${c2.erro} ${JSON.stringify(c2.msgs)}`);
  });
  t("SJ-6. ordem estável exigida: servidor sem ORDER BY, ou ignorando o cursor (repete a página) → falha fechado na hora, nunca laço", async () => {
    const semOrdem = bancoKeyset({ x: embaralhar(lixo(1500, SH_J, "Shopee")) }, { teto: 1000, ignorarOrdem: true });
    const a = await capturarErros(() => S.lerJanelasSyncJobs<any>("teste_janelas", paginaJanelas(semOrdem)));
    assert(a.erro === "leitura_falhou" && a.msgs.some((x) => x.includes("codigo=ordem_instavel")) && semOrdem.chamadas.length === 1, `${a.erro} ${semOrdem.chamadas.length} ${a.msgs}`);
    const semCursor = bancoKeyset({ x: lixo(1500, SH_J, "Shopee") }, { teto: 1000, ignorarCursor: true, falhar: (_t, n) => n > 4 });
    const b = await capturarErros(() => S.lerJanelasSyncJobs<any>("teste_janelas", paginaJanelas(semCursor)));
    assert(b.erro === "leitura_falhou" && b.msgs.some((x) => x.includes("codigo=ordem_instavel")) && semCursor.chamadas.length === 2, `${b.erro} ${semCursor.chamadas.length} ${b.msgs}`);
  });
  t("SJ-7. janela sem id (coluna não selecionada) → falha fechado: sem id não há cursor nem prova de unicidade", async () => {
    const b = bancoKeyset({ x: lixo(3, SH_J, "Shopee").map(({ id: _id, ...resto }) => resto) });
    const c = await capturarErros(() => S.lerJanelasSyncJobs<any>("teste_janelas", paginaJanelas(b)));
    assert(c.erro === "leitura_falhou" && c.msgs.some((x) => x.includes("codigo=janela_sem_id")), `${c.erro} ${c.msgs}`);
  });
  t("SJ-8. nenhuma leitura de sync_jobs dos 3 leitores (Shopee, ML, híbrido ML) fica fora da paginação", () => {
    for (const f of ["lib/vendas/canonico/shopee.ts", "lib/vendas/canonico/ml.ts", "lib/vendas/ml-metricas-hibridas.ts"]) {
      const src = readFileSync(join(RAIZ, f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
      const leituras = [...src.matchAll(/\.from\("sync_jobs"\)/g)];
      assert(leituras.length >= 1, `${f}: nenhuma leitura encontrada`);
      for (const l of leituras) {
        const antes = src.slice(Math.max(0, l.index! - 160), l.index!);
        assert(/lerJanelasSyncJobs<Record<string, unknown>>\("[a-z_]+", \(apos, limite\) => \{\s*let q = cliente$/.test(antes), `${f}: leitura de sync_jobs fora de lerJanelasSyncJobs`);
      }
    }
  });

  t("PG-4. emParalelo: resultado na ORDEM dos itens, teto de concorrência respeitado, erro rejeita", async () => {
    let voo = 0, pico = 0;
    const r = await S.emParalelo(Array.from({ length: 20 }, (_, i) => i), 6, async (x) => {
      voo++; pico = Math.max(pico, voo); await new Promise((ok) => setTimeout(ok, (x * 7) % 4)); voo--; return x * 10;
    });
    assert(JSON.stringify(r) === JSON.stringify(Array.from({ length: 20 }, (_, i) => i * 10)) && pico <= 6 && pico > 1, `pico ${pico}`);
    let e = ""; try { await S.emParalelo([1, 2, 3], 2, async (x) => { if (x === 2) throw new Error("boom"); return x; }); } catch (x: any) { e = x.message; }
    assert(e === "boom", e || "não lançou");
    assert((await S.emParalelo([], 3, async (x) => x)).length === 0, "vazio");
  });

  await fila;
  console.log(`\n${falhou === 0 ? "✓" : "✗"} VENDAS-CANONICO-SHOPEE — ${passou} passaram, ${falhou} falharam`);
  process.exit(falhou === 0 ? 0 : 1);
}
principal().catch((e) => { console.error("ERRO FATAL", e); process.exit(1); });
