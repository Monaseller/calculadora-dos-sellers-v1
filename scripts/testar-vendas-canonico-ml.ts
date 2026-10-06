/**
 * ML-CORPUS-A — servico canonico de vendas Mercado Livre (offline).
 *
 * Sem rede, sem banco. Cobre:
 *  1. normalizacao do order da API (date_closed → dia de SP, pack_splitted,
 *     unidades, total_amount; divergencia de itens NAO troca o valor);
 *  2. fixture 02/10/2026 — SINTETICA, construida para reproduzir a
 *     referencia homologada (258 pedidos / 271 unidades / R$ 8.276,25) e
 *     exercitar o caminho API → normalizacao → linha do corpus → calculo.
 *     Ela NAO prova o numero real: isso exige a ingestao live (gate proprio);
 *  3. bordas do periodo e fuso (sem -3h fixo);
 *  4. multi-loja: mesmo order_id em duas lojas, A / B / todas; dono sempre;
 *  5. completude COMPLETE/PARTIAL/FAILED;
 *  6. fonte unica: o oraculo live usa a MESMA normalizacao.
 *
 * Uso: npx tsx scripts/testar-vendas-canonico-ml.ts
 */
import "./_server-only-inerte";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { PedidoMLCanonico, JanelaFechamentoML } from "../lib/vendas/canonico/ml";

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
const LOJA_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", LOJA_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", LOJA_X = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const UID = "dono-ml", OUTRO = "outro-dono";

/** Order no formato da API (offset do provedor -04:00, como ela devolve). */
function orderApi(id: string, fechadoUtc: string, totalCentavos: number, unidades: number, cancel?: string) {
  const t = new Date(fechadoUtc);
  const comOffset = new Date(t.getTime() - 4 * 3600e3).toISOString().replace("Z", "-04:00");
  const itens = unidades === 2
    ? [{ quantity: 1, unit_price: Math.floor(totalCentavos / 2) / 100 }, { quantity: 1, unit_price: (totalCentavos - Math.floor(totalCentavos / 2)) / 100 }]
    : [{ quantity: unidades, unit_price: totalCentavos / 100 / unidades }];
  return { id: Number(id), date_closed: comOffset, date_created: comOffset, total_amount: totalCentavos / 100, status: "paid",
    order_items: itens, ...(cancel ? { cancel_detail: { code: cancel } } : {}) };
}

/** Fixture SINTETICA de 02/10/2026 (referencia homologada: 258 / 271 / 8276.25). */
function fixture0210() {
  const out: ReturnType<typeof orderApi>[] = [];
  const ini = Date.parse("2026-10-02T03:00:00Z"); // 02/10 00:00 em Sao Paulo
  for (let i = 0; i < 258; i++) {
    const cent = 3207 + (i < 219 ? 1 : 0);            // 258×32,07 + 2,19 = 8276,25
    out.push(orderApi(String(2000000000 + i), new Date(ini + 60_000 + i * 300_000).toISOString(), cent, i < 13 ? 2 : 1));
  }
  // pack_splitted no dia: fica FORA (o pacote foi refeito em outros pedidos)
  for (let i = 0; i < 3; i++) out.push(orderApi(String(2100000000 + i), new Date(ini + 7200e3 + i * 1000).toISOString(), 9999, 3, "pack_splitted"));
  // cancelamento comercial no dia: CONTINUA na venda (e por isso a fixture usa so pack_splitted para excluir)
  // bordas: 01/10 23:59:59 e 03/10 00:00 (Sao Paulo) ficam fora de 02/10
  out.push(orderApi("2200000001", "2026-10-02T02:59:59.000Z", 5000, 1));
  out.push(orderApi("2200000002", "2026-10-03T03:00:00.000Z", 5000, 1));
  return out;
}

async function principal() {
  const C = await import("../lib/vendas/canonico/ml");
  const S = await import("../lib/vendas/canonico/shopee");

  const paraLinha = (lojaId: string, o: ReturnType<typeof orderApi>, fetchedAt = "2026-10-05T12:00:00.000Z"): PedidoMLCanonico => {
    const n = C.normalizarPedidoML(o as any);
    return { lojaId, orderId: n.pedidoId, dateClosed: n.dateClosed, cancelCode: n.cancelCode, totalAmount: n.valor, unidades: n.unidades, fetchedAt };
  };

  console.log("\n[1. normalizacao do order da API]");
  t("1a. date_closed com offset do provedor vira instante UTC e dia de Sao Paulo corretos", () => {
    const n = C.normalizarPedidoML({ id: 1, date_closed: "2026-10-01T23:33:00.000-04:00", total_amount: 10, order_items: [] });
    assert(n.dateClosed === "2026-10-02T03:33:00.000Z" && n.diaFechamento === "2026-10-02", JSON.stringify(n));
  });
  t("1b. pack_splitted vem de cancel_detail.code (nao de status); unidades = Σ quantity; valor = total_amount", () => {
    const n = C.normalizarPedidoML({ id: 7, date_closed: "2026-10-02T10:00:00.000-03:00", total_amount: 50, status: "cancelled",
      cancel_detail: { code: "pack_splitted" }, order_items: [{ quantity: 2, unit_price: 10 }, { quantity: 3, unit_price: 9 }] });
    assert(n.cancelCode === "pack_splitted" && n.unidades === 5 && n.valor === 50 && n.valorPorItens === 47 && !C.pedidoMLContaNaVenda(n), JSON.stringify(n));
    const comercial = C.normalizarPedidoML({ id: 8, date_closed: "2026-10-02T10:00:00.000-03:00", total_amount: 30, status: "cancelled", cancel_detail: { code: "buyer_cancel" }, order_items: [] });
    assert(C.pedidoMLContaNaVenda(comercial), "cancelamento comercial saiu da venda");
  });

  console.log("\n[2. fixture 02/10/2026 (SINTETICA) — 258 / 271 / 8276.25]");
  const fx = fixture0210();
  const dia = S.intervaloSaoPaulo("2026-10-02", "2026-10-02");
  t("2a. API → normalizacao → linha do corpus → calculo = 258 pedidos / 271 unidades / R$ 8.276,25 (exato)", () => {
    const linhas = fx.map((o) => paraLinha(LOJA_A, o));
    const m = C.calcularMetricasML(C.filtrarFechadosNoIntervalo(linhas, dia.inicio, dia.fim));
    assert(m.pedidos === 258 && m.unidades === 271 && m.vendas === 8276.25, JSON.stringify(m));
  });
  t("2b. o recorte pelo instante (banco) e o recorte pelo dia de SP (oraculo live) escolhem o MESMO conjunto", () => {
    const porInstante = new Set(C.filtrarFechadosNoIntervalo(fx.map((o) => paraLinha(LOJA_A, o)), dia.inicio, dia.fim).map((p) => p.orderId));
    const porDia = new Set(fx.map((o) => C.normalizarPedidoML(o as any)).filter((n) => n.diaFechamento === "2026-10-02").map((n) => n.pedidoId));
    assert(porInstante.size === porDia.size && [...porDia].every((x) => porInstante.has(x)), `${porInstante.size} x ${porDia.size}`);
  });

  console.log("\n[3. periodo: date_closed em America/Sao_Paulo, [inicio 00:00, dia seguinte 00:00)]");
  const em = (de: string, ate: string, fechadoUtc: string) => { const { inicio, fim } = S.intervaloSaoPaulo(de, ate);
    return C.filtrarFechadosNoIntervalo([{ lojaId: LOJA_A, orderId: "1", dateClosed: fechadoUtc, cancelCode: null, totalAmount: 1, unidades: 1, fetchedAt: "z" }], inicio, fim).length === 1; };
  t("3a. 01/10 23:59:59 fora; 02/10 00:00 dentro; 02/10 23:59:59 dentro; 03/10 00:00 fora", () => {
    assert(!em("2026-10-02", "2026-10-02", "2026-10-02T02:59:59.000Z") && em("2026-10-02", "2026-10-02", "2026-10-02T03:00:00.000Z"), "inicio");
    assert(em("2026-10-02", "2026-10-02", "2026-10-03T02:59:59.000Z") && !em("2026-10-02", "2026-10-02", "2026-10-03T03:00:00.000Z"), "fim");
  });
  t("3b. horario de verao de 2018 pela tabela de fuso (nao -3h fixo)", () => {
    assert(em("2018-11-04", "2018-11-04", "2018-11-05T01:59:59.000Z") && !em("2018-11-04", "2018-11-04", "2018-11-05T02:00:00.000Z"), "DST");
  });
  t("3c. agregacao: metric(01→03) = Σ metric(dia) — centavos exatos", () => {
    const linhas = fx.map((o) => paraLinha(LOJA_A, o));
    const m = (de: string, ate: string) => { const { inicio, fim } = S.intervaloSaoPaulo(de, ate); return C.calcularMetricasML(C.filtrarFechadosNoIntervalo(linhas, inicio, fim)); };
    assert(JSON.stringify(m("2026-10-01", "2026-10-03")) === JSON.stringify(C.somarMetricasML([m("2026-10-01", "2026-10-01"), m("2026-10-02", "2026-10-02"), m("2026-10-03", "2026-10-03")])), "soma");
  });

  console.log("\n[4. completude]");
  const janela = (extra: Partial<JanelaFechamentoML> = {}): JanelaFechamentoML => ({ campoTempo: "date_closed",
    inicio: "2026-10-01T03:00:00.000Z", fim: "2026-10-04T03:00:00.000Z", listagemCompleta: true, status: "concluido", ...extra });
  const linhas02 = () => C.filtrarFechadosNoIntervalo(fx.map((o) => paraLinha(LOJA_A, o)), dia.inicio, dia.fim);
  t("4a. janela de date_closed completa cobrindo o dia + observado depois do fim = COMPLETE", () => {
    const r = C.avaliarCompletudeML({ ...dia, janelas: [janela()], pedidos: linhas02() });
    assert(r.completude === "COMPLETE" && r.estadoEm === "2026-10-05T12:00:00.000Z", JSON.stringify(r));
  });
  t("4b. sem janela / janela de create_time ou update_time / janela incompleta ou rodando → PARTIAL", () => {
    for (const js of [[], [janela({ campoTempo: "create_time" })], [janela({ campoTempo: "update_time" })], [janela({ listagemCompleta: false })], [janela({ status: "rodando" })]]) {
      const r = C.avaliarCompletudeML({ ...dia, janelas: js, pedidos: linhas02() });
      assert(r.completude === "PARTIAL" && r.motivos.includes("cobertura_por_date_closed_nao_provada"), JSON.stringify(js));
    }
  });
  t("4c. buraco entre janelas → PARTIAL; borda compartilhada → cadeia continua", () => {
    const b = "2026-10-02T15:00:00.000Z";
    assert(C.avaliarCompletudeML({ ...dia, janelas: [janela({ fim: b }), janela({ inicio: "2026-10-02T15:00:01.000Z" })], pedidos: linhas02() }).completude === "PARTIAL", "buraco");
    assert(C.avaliarCompletudeML({ ...dia, janelas: [janela({ fim: b }), janela({ inicio: b })], pedidos: linhas02() }).completude === "COMPLETE", "borda");
  });
  t("4d. janela necessaria em erro → FAILED", () => {
    assert(C.avaliarCompletudeML({ ...dia, janelas: [janela({ status: "erro", listagemCompleta: null })], pedidos: linhas02() }).completude === "FAILED", "failed");
  });
  t("4e. pedido observado antes do fim do periodo (cancel_detail pode mudar) ou sem valor → PARTIAL", () => {
    const antes = linhas02().map((p, i) => (i === 0 ? { ...p, fetchedAt: "2026-10-02T20:00:00.000Z" } : p));
    assert(C.avaliarCompletudeML({ ...dia, janelas: [janela()], pedidos: antes }).motivos.includes("estado_observado_antes_do_fim_do_periodo:1"), "antes");
    const semValor = linhas02().map((p, i) => (i === 0 ? { ...p, totalAmount: null } : p));
    assert(C.avaliarCompletudeML({ ...dia, janelas: [janela()], pedidos: semValor }).motivos.includes("valor_ausente:1"), "valor");
  });

  console.log("\n[5. grao]");
  t("5a. mesmo pedido duas vezes na MESMA loja e erro (nunca soma em dobro)", () => {
    let erro = ""; try { C.calcularMetricasML([...linhas02(), linhas02()[0]]); } catch (e: any) { erro = e.message; }
    assert(erro.startsWith("pedido_duplicado:"), erro || "nao lancou");
  });

  console.log("\n[6. multi-loja e dono (leitura do banco, duplo)]");
  type Reg = { tabela: string; filtros: [string, string, unknown][] };
  function clienteFalso(dados: Record<string, any[]>, regs: Reg[]) {
    return { from(tabela: string) {
      const r: Reg = { tabela, filtros: [] }; regs.push(r);
      const casa = (l: any) => r.filtros.every(([op, col, v]: any) => op === "eq" ? String(l[col]) === String(v) : op === "in" ? v.map(String).includes(String(l[col]))
        : op === "gte" ? l[col] >= v : op === "lt" ? l[col] < v : true);
      const c: any = new Proxy({}, { get(_a, p: string) {
        if (p === "then") return (ok: any) => ok({ data: (dados[tabela] ?? []).filter(casa), error: null });
        if (p === "range") return (a: number, b: number) => Promise.resolve({ data: (dados[tabela] ?? []).filter(casa).slice(a, b + 1), error: null });
        return (...args: any[]) => { if (["eq", "in", "gte", "lt"].includes(p)) r.filtros.push([p, args[0], args[1]]); return c; };
      } });
      return c;
    } } as any;
  }
  const linha = (lojaId: string, user: string, orderId: string, total: number, unid: number, closed = "2026-10-02T15:00:00.000Z") =>
    ({ user_id: user, loja_id: lojaId, order_id: orderId, date_closed: closed, cancel_detail_code: null, total_amount: total, unidades: unid, fetched_at: "2026-10-05T12:00:00.000Z" });
  const jobs = (lojaId: string, user: string) => ({ user_id: user, loja_id: lojaId, marketplace: "ML", campo_tempo: "date_closed",
    janela_inicio: "2026-10-01T03:00:00.000Z", janela_fim: "2026-10-04T03:00:00.000Z", listagem_completa: true, status: "concluido" });
  const base = () => ({
    lojas: [{ id: LOJA_A, user_id: UID, marketplace: "ML" }, { id: LOJA_B, user_id: UID, marketplace: "ML" }, { id: LOJA_X, user_id: OUTRO, marketplace: "ML" }],
    ml_pedidos: [linha(LOJA_A, UID, "999", 100, 1), linha(LOJA_B, UID, "999", 40, 2), linha(LOJA_A, UID, "1000", 10, 1), linha(LOJA_X, OUTRO, "999", 777, 7)],
    sync_jobs: [jobs(LOJA_A, UID), jobs(LOJA_B, UID), jobs(LOJA_X, OUTRO)],
  });
  t("6a. MESMO order_id em A e B: dois pedidos distintos; A so A; B so B; todas = A + B; outro dono nunca entra", async () => {
    const q = (lojaIds?: string[]) => C.lerVendasML(clienteFalso(base(), []), { userId: UID, de: "2026-10-02", ate: "2026-10-02", lojaIds });
    const a = await q([LOJA_A]), b = await q([LOJA_B]), todas = await q();
    assert(a.total?.pedidos === 2 && a.total.vendas === 110 && a.total.unidades === 2, JSON.stringify(a.total));
    assert(b.total?.pedidos === 1 && b.total.vendas === 40 && b.total.unidades === 2, JSON.stringify(b.total));
    assert(todas.total?.pedidos === 3 && todas.total.vendas === 150 && todas.total.unidades === 4 && todas.lojas.length === 2, JSON.stringify(todas));
  });
  t("6b. loja de outro dono pedida explicitamente → loja_invalida (nunca zero)", async () => {
    let erro = ""; try { await C.lerVendasML(clienteFalso(base(), []), { userId: UID, de: "2026-10-02", ate: "2026-10-02", lojaIds: [LOJA_X] }); } catch (e: any) { erro = e.message; }
    assert(erro === "loja_invalida", erro || "nao lancou");
  });
  t("6c. TODA consulta leva o dono; corpus e jobs tambem a loja; lojas resolvidas por marketplace (nenhuma loja fixa no codigo)", async () => {
    const regs: Reg[] = [];
    await C.lerVendasML(clienteFalso(base(), regs), { userId: UID, de: "2026-10-02", ate: "2026-10-02" });
    for (const g of regs) assert(g.filtros.some(([op, c, v]) => op === "eq" && c === "user_id" && v === UID), `${g.tabela} sem dono`);
    for (const g of regs.filter((x) => x.tabela !== "lojas")) assert(g.filtros.some(([op, c]) => op === "eq" && c === "loja_id"), `${g.tabela} sem loja`);
    assert(regs.find((g) => g.tabela === "lojas")!.filtros.some(([op, c, v]) => op === "eq" && c === "marketplace" && v === "ML"), "marketplace");
    const fonte = readFileSync(join(RAIZ, "lib/vendas/canonico/ml.ts"), "utf8");
    assert(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(fonte) && !/seller_id\s*[:=]\s*\d/.test(fonte), "loja/conta fixa no codigo");
  });
  t("6d. uma loja sem cobertura deixa o TOTAL nulo (nunca soma parcial como definitiva)", async () => {
    const d = base(); d.sync_jobs = d.sync_jobs.filter((j) => j.loja_id !== LOJA_B);
    const r = await C.lerVendasML(clienteFalso(d, []), { userId: UID, de: "2026-10-02", ate: "2026-10-02" });
    assert(r.completude === "PARTIAL" && r.total === null && r.lojas.find((l) => l.lojaId === LOJA_A)!.completude === "COMPLETE", JSON.stringify(r));
  });

  console.log("\n[7. fonte unica da regra]");
  t("7a. o oraculo live (buscarVendasBrutasML) usa normalizarPedidoML e nao tem logica propria de cancelamento/unidades", () => {
    const s = readFileSync(join(RAIZ, "lib/mercado-livre-vendas.ts"), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    const corpo = s.slice(s.indexOf("export async function buscarVendasBrutasML"));
    assert(/normalizarPedidoML\(o\)/.test(corpo) && !/cancel_detail|order_items|\.quantity/.test(corpo), "regra duplicada no oraculo live");
    assert(!/=\s*"pack_splitted"/.test(s), "pack_splitted redefinido fora do servico canonico");
  });
  t("7b. 'pack_splitted' so e literal no servico canonico (em lib/)", () => {
    const arqs: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.tsx?$/.test(f)) arqs.push(p); } };
    walk(join(RAIZ, "lib"));
    const com = arqs.filter((p) => /["'`]pack_splitted["'`]/.test(readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")))
      .map((p) => p.slice(RAIZ.length + 1).replace(/\\/g, "/"));
    assert(com.length === 1 && com[0] === "lib/vendas/canonico/ml.ts", com.join(", "));
  });

  await fila;
  console.log(`\n${falhou === 0 ? "✓" : "✗"} VENDAS-CANONICO-ML — ${passou} passaram, ${falhou} falharam`);
  process.exit(falhou === 0 ? 0 : 1);
}
principal().catch((e) => { console.error("ERRO FATAL", e); process.exit(1); });
