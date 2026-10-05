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
  type Reg = { tabela: string; filtros: [string, string, unknown][]; head?: boolean };
  function clienteFalso(dados: Record<string, any[]>, regs: Reg[]) {
    return {
      from(tabela: string) {
        const r: Reg = { tabela, filtros: [] }; regs.push(r);
        const casa = (l: any) => r.filtros.every(([op, col, valor]) => {
          const v = valor as any;
          return op === "eq" ? String(l[col]) === String(v) : op === "in" ? (v as any[]).map(String).includes(String(l[col]))
            : op === "gte" ? l[col] >= v : op === "lt" ? (l[col] !== null && l[col] !== undefined && l[col] < v) : op === "gt" ? l[col] > v
            : op === "is" ? (l[col] ?? null) === v : true;
        });
        const c: any = new Proxy({}, { get(_a, p: string) {
          if (p === "then") return (ok: any) => { const d = (dados[tabela] ?? []).filter(casa); return ok(r.head ? { data: null, count: d.length, error: null } : { data: d, error: null }); };
          if (p === "range") return (a: number, b: number) => Promise.resolve({ data: (dados[tabela] ?? []).filter(casa).slice(a, b + 1), error: null });
          if (p === "select") return (_cols: string, o?: { head?: boolean }) => { if (o?.head) r.head = true; return c; };
          return (...args: any[]) => { if (["eq", "in", "gte", "lt", "gt", "is"].includes(p)) r.filtros.push([p, args[0], args[1]]); return c; };
        } });
        return c;
      },
    } as any;
  }
  const UID = "dono-a", OUTRO = "dono-b", L2 = "22222222-2222-4222-8222-222222222222";
  const jobsCorpus = () => corpus().map((j) => ({ user_id: UID, loja_id: LOJA, marketplace: "Shopee", campo_tempo: "create_time",
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
      { user_id: UID, loja_id: LOJA, marketplace: "Shopee", campo_tempo: "update_time", janela_inicio: "2026-10-01T00:00:00.000Z", janela_fim: "2026-10-09T00:00:00.000Z", listagem_completa: true, status: "concluido" }],
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
