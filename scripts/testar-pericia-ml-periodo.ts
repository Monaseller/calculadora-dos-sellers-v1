/**
 * AGENT-FACTORY-F7b.4.8.4-R2 §12 — a aritmetica de periodo da pericia.
 *
 * Suite PURA: sem rede, sem banco, sem IA, sem arquivo. Pedidos sinteticos
 * desenhados em cima dos casos REAIS que o R1 errou.
 *
 * ── O que ela impede de voltar ──────────────────────────────────────
 *
 * O gerador do artefato testava o dia COMO ESCRITO no offset da API antes
 * de converter para America/Sao_Paulo. Dois pedidos reais de 31/08 as
 * 23h33 e 23h48 em -04:00 — que sao 01/09 em Sao Paulo, e que o relatorio
 * oficial do Mercado Livre lista como vendas de setembro — ficaram fora da
 * planilha.
 *
 * Nenhum teste aqui depende de numero do painel: os casos sao construidos,
 * e a expectativa sai da aritmetica de fuso, nao de uma ancora externa.
 *
 * Roda com: npx tsx scripts/testar-pericia-ml-periodo.ts
 */
import "./_server-only-inerte";

import {
  apurar, conferirCobertura, dentroDoPeriodo, diaComoEscrito, diaEmSaoPaulo,
  EIXOS_DE_DATA, EIXOS_DE_POPULACAO, EIXOS_DE_VALOR, FUSO_SAO_PAULO_HORAS,
  minutoEmSaoPaulo, montarCandidatas, pagamentoDoAgente, populacaoDoRaw,
  unidadesDoPedido, type Candidata, type PedidoPericia,
} from "./pericia-ml-periodo";

const DE = "2026-09-01";
const ATE = "2026-09-30";

let pass = 0;
let fail = 0;
function ok(nome: string, cond: boolean, detalhe = ""): void {
  if (cond) { pass += 1; console.log(`  PASS  ${nome}`); }
  else { fail += 1; console.log(`  FAIL  ${nome}${detalhe ? `  — ${detalhe}` : ""}`); }
}
function secao(t: string): void { console.log(`\n${t}`); }

/** Um pedido minimo. Tudo o que o teste nao usa fica neutro. */
function pedido(p: Partial<PedidoPericia> & { id: string }): PedidoPericia {
  return {
    id: p.id,
    status: p.status ?? "paid",
    status_detail: null,
    date_created: p.date_created ?? null,
    date_closed: p.date_closed ?? null,
    last_updated: p.last_updated ?? null,
    total_amount: p.total_amount ?? 0,
    paid_amount: p.paid_amount ?? 0,
    coupon_amount: 0,
    taxes_amount: null,
    cancel_group: p.cancel_group ?? null,
    cancel_code: p.cancel_code ?? null,
    cancel_date: p.cancel_date ?? null,
    mediacoes: 0,
    pack_id: p.pack_id ?? null,
    fulfilled: null,
    tags: [],
    itens: p.itens ?? [{ quantity: 1, unit_price: p.total_amount ?? 0, gross_price: p.total_amount ?? 0 }],
    pagamentos: p.pagamentos ?? [],
  };
}

function candidata(id: string): Candidata {
  const c = montarCandidatas().find((x) => x.id === id);
  if (c === undefined) throw new Error(`candidata inexistente: ${id}`);
  return c;
}

console.log("══ F7b.4.8.4-R2 §12 — periodo da pericia ══");

// ═══ A. A conversao, isolada ══════════════════════════════════════

secao("A. A conversao para Sao Paulo");
ok("A1  o fuso e -3h fixo", FUSO_SAO_PAULO_HORAS === -3, String(FUSO_SAO_PAULO_HORAS));
ok("A2  31/08 23:33 em -04:00 vira 01/09 em Sao Paulo",
  diaEmSaoPaulo("2026-08-31T23:33:10.000-04:00") === "2026-09-01",
  String(diaEmSaoPaulo("2026-08-31T23:33:10.000-04:00")));
ok("A3  e ao MINUTO, 00:33",
  minutoEmSaoPaulo("2026-08-31T23:33:10.000-04:00") === "2026-09-01 00:33",
  minutoEmSaoPaulo("2026-08-31T23:33:10.000-04:00"));
ok("A4  30/09 23:41 em -04:00 vira 01/10 em Sao Paulo",
  diaEmSaoPaulo("2026-09-30T23:41:33.000-04:00") === "2026-10-01",
  String(diaEmSaoPaulo("2026-09-30T23:41:33.000-04:00")));
ok("A5  22:59 em -04:00 continua no mesmo dia",
  diaEmSaoPaulo("2026-09-30T22:59:00.000-04:00") === "2026-09-30",
  String(diaEmSaoPaulo("2026-09-30T22:59:00.000-04:00")));
ok("A6  `null` nao vira data", diaEmSaoPaulo(null) === null &&
  minutoEmSaoPaulo(null) === "");
ok("A7  texto invalido nao vira data", diaEmSaoPaulo("ontem") === null);

// O diagnostico de borda: ele DEVE discordar, e e por isso que existe.
ok("A8  o dia COMO ESCRITO discorda do dia em Sao Paulo na borda",
  diaComoEscrito("2026-08-31T23:33:10.000-04:00") === "2026-08-31" &&
  diaEmSaoPaulo("2026-08-31T23:33:10.000-04:00") === "2026-09-01");
ok("A9  §3: e esse e exatamente o teste que o periodo NAO pode usar",
  !dentroDoPeriodo(diaComoEscrito("2026-08-31T23:33:10.000-04:00"), DE, ATE) &&
  dentroDoPeriodo(diaEmSaoPaulo("2026-08-31T23:33:10.000-04:00"), DE, ATE));

// ═══ B. Nenhum eixo de data usa o dia escrito ════════════════════

secao("B. Os eixos de data convertem antes de comparar");
{
  // Um pedido cujo dia escrito e agosto e cujo dia em Sao Paulo e
  // setembro, nos TRES campos de data ao mesmo tempo.
  const naBorda = pedido({
    id: "borda",
    date_created: "2026-08-31T23:10:00.000-04:00",
    date_closed: "2026-08-31T23:33:10.000-04:00",
    pagamentos: [{
      id: "p1", status: "approved", status_detail: null,
      date_approved: "2026-08-31T23:40:00.000-04:00", date_created: null,
      transaction_amount: 10, total_paid_amount: 10, shipping_cost: 0,
      taxes_amount: 0, coupon_amount: 0, overpaid_amount: 0,
      transaction_amount_refunded: 0, installments: 1,
      payment_type: "x", operation_type: "y",
    }],
    total_amount: 10, paid_amount: 10,
  });
  for (const eixo of EIXOS_DE_DATA) {
    ok(`B1  eixo \`${eixo.id}\` coloca o pedido de borda em SETEMBRO`,
      dentroDoPeriodo(eixo.dia(naBorda), DE, ATE),
      `dia=${String(eixo.dia(naBorda))}`);
  }
  ok("B2  ANCORA: o dia escrito desses campos e AGOSTO",
    diaComoEscrito(naBorda.date_closed) === "2026-08-31");
  ok("B3  nenhum eixo de data tem `escrito` no id",
    EIXOS_DE_DATA.every((e) => !/escrit/i.test(e.id) && !/escrit/i.test(e.rotulo)),
    EIXOS_DE_DATA.map((e) => e.id).join(","));
}

// ═══ C. Virada de MES nos dois sentidos ══════════════════════════

secao("C. Virada de mes — as duas bordas (§3)");
{
  const entra = pedido({
    id: "entra", date_closed: "2026-08-31T23:48:12.000-04:00",
    total_amount: 26.9, status: "cancelled", cancel_code: "buyer_cancel_express",
    itens: [{ quantity: 1, unit_price: 26.9, gross_price: 26.9 }],
  });
  const sai = pedido({
    id: "sai", date_closed: "2026-09-30T23:41:33.000-04:00",
    total_amount: 24.2,
    itens: [{ quantity: 1, unit_price: 24.2, gross_price: 24.2 }],
  });
  const dentro = pedido({
    id: "dentro", date_closed: "2026-09-15T12:00:00.000-04:00",
    total_amount: 50,
    itens: [{ quantity: 2, unit_price: 25, gross_price: 50 }],
  });
  const a = apurar(candidata("fechamento_sp|sem_pack_splitted|total_amount"),
    [entra, sai, dentro], DE, ATE);
  ok("C1  31/08 23:48 (-04) ENTRA em setembro", a.ids.includes("entra"));
  ok("C2  30/09 23:41 (-04) SAI de setembro — e 01/10 em Sao Paulo",
    !a.ids.includes("sai"));
  ok("C3  e o pedido do meio do mes fica", a.ids.includes("dentro"));
  ok("C4  o total soma so os dois que entram", Math.abs(a.total - 76.9) < 0.005,
    a.total.toFixed(2));
  ok("C5  e as unidades acompanham", a.unidades === 3, String(a.unidades));
}

// ═══ D. Cancelado sem pagamento aprovado ═════════════════════════

secao("D. Cancelado sem pagamento aprovado (§12.3)");
{
  const cancelado = pedido({
    id: "cancelado", date_closed: "2026-09-10T10:00:00.000-04:00",
    status: "cancelled", cancel_group: "buyer", cancel_code: "buyer_cancel_express",
    total_amount: 53.8, paid_amount: 0,
    itens: [{ quantity: 2, unit_price: 26.9, gross_price: 26.9 }],
    pagamentos: [{
      id: "p1", status: "refunded", status_detail: "bpp_refunded",
      date_approved: "2026-09-10T10:05:00.000-04:00", date_created: null,
      transaction_amount: 53.8, total_paid_amount: 53.8, shipping_cost: 0,
      taxes_amount: 0, coupon_amount: 0, overpaid_amount: 0,
      transaction_amount_refunded: 53.8, installments: 1,
      payment_type: "x", operation_type: "y",
    }],
  });
  ok("D1  ele NAO tem pagamento que conta pela regra de hoje",
    pagamentoDoAgente(cancelado) === null);
  const porPagamento = apurar(candidata("pagamento_sp|com_pagamento_que_conta|paid_amount"),
    [cancelado], DE, ATE);
  ok("D2  por isso a regra de HOJE o deixa de fora",
    porPagamento.pedidos === 0 && porPagamento.total === 0);
  const porFechamento = apurar(candidata("fechamento_sp|sem_pack_splitted|total_amount"),
    [cancelado], DE, ATE);
  ok("D3  mas a candidata de venda BRUTA o inclui, com total_amount",
    porFechamento.pedidos === 1 && Math.abs(porFechamento.total - 53.8) < 0.005,
    `${porFechamento.pedidos} / ${porFechamento.total}`);
  ok("D4  e `paid_amount` dele e ZERO — por isso nao serve como venda bruta",
    cancelado.paid_amount === 0);
}

// ═══ E. `pack_splitted` excluido; pedido comum incluido ══════════

secao("E. pack_splitted fora, pedido comum dentro (§12.4/§12.5)");
{
  const split = pedido({
    id: "split", date_closed: "2026-09-05T10:00:00.000-04:00",
    status: "cancelled", cancel_group: "internal", cancel_code: "pack_splitted",
    total_amount: 32.9, pack_id: "pk1",
    itens: [{ quantity: 1, unit_price: 32.9, gross_price: 32.9 }],
  });
  const comum = pedido({
    id: "comum", date_closed: "2026-09-05T11:00:00.000-04:00",
    total_amount: 41.24,
    itens: [{ quantity: 1, unit_price: 41.24, gross_price: 41.24 }],
  });
  const a = apurar(candidata("fechamento_sp|sem_pack_splitted|total_amount"),
    [split, comum], DE, ATE);
  ok("E1  o pack_splitted fica fora", !a.ids.includes("split"));
  ok("E2  o pedido comum entra", a.ids.includes("comum"));
  ok("E3  o total e so o do comum", Math.abs(a.total - 41.24) < 0.005, a.total.toFixed(2));

  // CONTROLE: na populacao `todos` ele entra — a exclusao e do eixo, e
  // nao um filtro escondido na aritmetica.
  const b = apurar(candidata("fechamento_sp|todos|total_amount"), [split, comum], DE, ATE);
  ok("E4  CONTROLE: na populacao `todos` ele entra",
    b.ids.includes("split") && Math.abs(b.total - 74.14) < 0.005, b.total.toFixed(2));
  ok("E5  e outro cancelamento interno NAO e excluido por engano",
    apurar(candidata("fechamento_sp|sem_pack_splitted|total_amount"), [
      pedido({
        id: "outro", date_closed: "2026-09-05T10:00:00.000-04:00",
        status: "cancelled", cancel_group: "internal", cancel_code: "pack_creation_error",
        total_amount: 20, itens: [{ quantity: 1, unit_price: 20, gross_price: 20 }],
      }),
    ], DE, ATE).pedidos === 1);
}

// ═══ F. Anti-vacuidade: populacao ausente do raw => FALHA ════════

secao("F. Anti-vacuidade (§4)");
{
  const dentro = pedido({
    id: "A", date_closed: "2026-09-10T10:00:00.000-04:00", total_amount: 10,
    itens: [{ quantity: 1, unit_price: 10, gross_price: 10 }],
  });
  const naBorda = pedido({
    id: "B", date_closed: "2026-08-31T23:33:10.000-04:00", total_amount: 53.8,
    status: "cancelled", cancel_code: "buyer_cancel_express",
    itens: [{ quantity: 2, unit_price: 26.9, gross_price: 26.9 }],
  });
  const todos = [dentro, naBorda];
  const porId = new Map(todos.map((p) => [p.id, p]));
  const cands = montarCandidatas();
  const porCand = new Map(cands.map((c) => [c.id, c]));
  const apuracoes = cands.map((c) => apurar(c, todos, DE, ATE));

  // Raw AMPUTADO, do jeito que o R1 entregou: sem o pedido de borda.
  const rawRuim = new Set(["A"]);
  const falhas = conferirCobertura(apuracoes, porCand, porId, rawRuim);
  ok("F1  §4: raw sem o pedido de borda PRODUZ falha", falhas.length > 0,
    String(falhas.length));
  const umaFalha = falhas.find((f) => f.orderId === "B");
  ok("F2  e a falha nomeia o pedido", umaFalha !== undefined);
  ok("F3  com o instante original e o convertido",
    umaFalha?.instanteOriginal === "2026-08-31T23:33:10.000-04:00" &&
    umaFalha?.instanteEmSaoPaulo === "2026-09-01 00:33",
    `${umaFalha?.instanteOriginal} / ${umaFalha?.instanteEmSaoPaulo}`);
  ok("F4  e com os dois dias, lado a lado",
    umaFalha?.diaComoEscrito === "2026-08-31" && umaFalha?.diaEmSaoPaulo === "2026-09-01",
    `${umaFalha?.diaComoEscrito} / ${umaFalha?.diaEmSaoPaulo}`);
  ok("F5  e com o motivo de inclusao",
    (umaFalha?.motivoDeInclusao ?? "").includes("date_closed"),
    umaFalha?.motivoDeInclusao);
  ok("F6  a candidata obrigatoria do §4 esta entre as que falham",
    falhas.some((f) => f.candidataId === "fechamento_sp|sem_pack_splitted|total_amount"));

  // Raw COMPLETO, derivado do mesmo registro de candidatas: zero falhas.
  const rawBom = new Set(populacaoDoRaw(todos, DE, ATE).map((p) => p.id));
  ok("F7  o raw derivado de `populacaoDoRaw` cobre os dois", rawBom.size === 2,
    String(rawBom.size));
  ok("F8  e ai NAO ha falha de cobertura",
    conferirCobertura(apuracoes, porCand, porId, rawBom).length === 0);
  // ANCORA: se `apuracoes` estivesse vazio, F8 passaria por vacuidade.
  ok("F8a ANCORA: havia populacao a conferir",
    apuracoes.some((a) => a.ids.length > 0));
}

// ═══ G. Identidade e lineage ═════════════════════════════════════

secao("G. Identidade das candidatas (§6)");
{
  const cands = montarCandidatas();
  ok("G1  ha uma candidata por combinacao dos tres eixos",
    cands.length === EIXOS_DE_DATA.length * EIXOS_DE_POPULACAO.length *
      EIXOS_DE_VALOR.length, String(cands.length));
  ok("G2  todo id e unico", new Set(cands.map((c) => c.id)).size === cands.length);
  ok("G3  e o id diz data|populacao|valor",
    cands.every((c) => c.id === `${c.data.id}|${c.populacao.id}|${c.valor.id}`));
  ok("G4  a candidata obrigatoria do §7 existe",
    cands.some((c) => c.id === "fechamento_sp|sem_pack_splitted|total_amount"));
}

// ═══ H. Nenhum numero do painel mora aqui ════════════════════════

secao("H. Sem numero do painel no codigo (§5/§12.8)");
{
  const fonte = require("node:fs")
    .readFileSync(require("node:path").join(__dirname, "pericia-ml-periodo.ts"), "utf8") as string;
  const semComentario = fonte
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  for (const proibido of ["393838", "393839", "10898", "11361", "36.14", "34.67", "414"]) {
    ok(`H1  \`${proibido}\` nao aparece no CODIGO do modulo`,
      !semComentario.includes(proibido));
  }
  ok("H2  ANCORA: o arquivo foi lido de verdade", fonte.length > 3000,
    String(fonte.length));
}

// ═══ I. Unidades ═════════════════════════════════════════════════

secao("I. Unidades vem dos itens");
{
  const p = pedido({
    id: "u", date_closed: "2026-09-10T10:00:00.000-04:00", total_amount: 100,
    itens: [
      { quantity: 2, unit_price: 25, gross_price: 50 },
      { quantity: 3, unit_price: 10, gross_price: 30 },
    ],
  });
  ok("I1  soma de order_items[].quantity", unidadesDoPedido(p) === 5,
    String(unidadesDoPedido(p)));
  ok("I2  e nao e a contagem de pedidos",
    apurar(candidata("fechamento_sp|todos|total_amount"), [p], DE, ATE).unidades === 5);
  ok("I3  item sem quantidade conta zero, e nao NaN",
    unidadesDoPedido(pedido({ id: "z", itens: [{ quantity: null, unit_price: 1, gross_price: 1 }] })) === 0);
}

console.log(`\nPASS ${pass}   FAIL ${fail}`);
process.exit(fail === 0 ? 0 : 1);
