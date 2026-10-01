/**
 * RECONCILIACAO — setembro/2026 contra o painel oficial — F7b.4.8.4.
 *
 * Roda SOBRE o arquivo que `medir-ml-coletar-setembro.ts` gravou. Nao toca
 * a API: a loja muda enquanto se investiga, e refazer a leitura a cada
 * pergunta trocaria a pericia por um alvo movel.
 *
 * ── A ancora, e o que ela NAO e ─────────────────────────────────────
 *
 * O painel oficial do Mercado Livre, em Metricas > Negocio > Visao geral,
 * para 01/09/2026 a 30/09/2026, exibiu:
 *
 *   Vendas brutas              R$ 393.839      (sem centavos na tela)
 *   Quantidade de vendas       10.898
 *   Unidades vendidas          11.361
 *   Preco medio por venda      R$ 36,14
 *   Preco medio por unidade    R$ 34,67
 *   Vendas canceladas          414
 *
 * Isso e ancora de VALIDACAO, e nao alvo de ajuste. Nenhuma formula aqui
 * foi escolhida por chegar perto de 393.839: as candidatas saem dos campos
 * que existem, e sao julgadas por explicarem TAMBEM contagem, unidades,
 * canceladas e os dois precos medios (§31).
 *
 * Roda com: npx tsx scripts/medir-ml-reconciliar-setembro.ts
 */
import "./_server-only-inerte";

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DESTINO = process.env.DESTINO ??
  join("C:", "Users", "USER", "AppData", "Local", "Temp", "claude",
    "c--Users-USER-Desktop-calculadora-dos-sellers-v1",
    "c9e0b194-ce1f-484c-80df-7b403c7a8702", "scratchpad", "ml-setembro");

const DE = "2026-09-01";
const ATE = "2026-09-30";

/** O painel, como o Rodrigo o viu. Centavos NAO sao conhecidos. */
const PAINEL = Object.freeze({
  vendasBrutasExibido: 393839,
  quantidadeDeVendas: 10898,
  unidadesVendidas: 11361,
  precoMedioPorVenda: 36.14,
  precoMedioPorUnidade: 34.67,
  canceladas: 414,
});

interface ItemColetado {
  quantity: number | null; unit_price: number | null; gross_price: number | null;
  sale_fee: number | null; listing_type_id: string | null;
  item_id: string | null; category_id: string | null;
}
interface PagamentoColetado {
  id: string; status: string | null; status_detail: string | null;
  date_approved: string | null; date_created: string | null;
  date_last_modified: string | null;
  transaction_amount: number | null; total_paid_amount: number | null;
  shipping_cost: number | null; taxes_amount: number | null;
  coupon_amount: number | null; overpaid_amount: number | null;
  transaction_amount_refunded: number | null;
  installments: number | null; installment_amount: number | null;
  payment_type: string | null; operation_type: string | null;
  payment_method_id: string | null;
}
interface PedidoColetado {
  id: string; status: string | null; status_detail: string | null;
  date_created: string | null; date_closed: string | null;
  last_updated: string | null; expiration_date: string | null;
  currency_id: string | null;
  total_amount: number | null; paid_amount: number | null;
  shipping_cost_pedido: number | null;
  coupon_amount: number | null; taxes_amount: number | null;
  cancel_group: string | null; cancel_code: string | null; cancel_date: string | null;
  mediacoes: number; pack_id: string | null; fulfilled: boolean | null;
  tags: string[];
  itens: ItemColetado[];
  pagamentos: PagamentoColetado[];
}

function n(v: number | null | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
/** O dia civil de Sao Paulo de um ISO com offset. `-3h` sobre o instante. */
function diaBRT(iso: string | null): string | null {
  if (iso === null || iso === "") return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return new Date(t - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
function dentro(dia: string | null): boolean {
  return dia !== null && dia >= DE && dia <= ATE;
}
function brl(v: number): string {
  return v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── As regras do agente HOJE, isoladas e nomeadas ──────────────────
//
// Copiadas de `lib/mercado-livre-vendas.ts`. Ficam aqui para a analise
// poder compara-las com as candidatas sem importar o modulo de producao e
// sem risco de alterar comportamento.

const STATUS_DE_PAGAMENTO_QUE_CONTA = ["approved", "partially_refunded"];

/** §16 CURRENT_AGENT_PAYMENT_RULE: o pagamento aprovado MAIS ANTIGO. */
function pagamentoDoAgente(p: PedidoColetado): PagamentoColetado | null {
  let escolhido: PagamentoColetado | null = null;
  let melhor = Infinity;
  for (const pg of p.pagamentos) {
    if (pg.status === null || !STATUS_DE_PAGAMENTO_QUE_CONTA.includes(pg.status)) continue;
    if (pg.date_approved === null) continue;
    const t = new Date(pg.date_approved).getTime();
    if (!Number.isFinite(t)) continue;
    if (t < melhor) { melhor = t; escolhido = pg; }
  }
  return escolhido;
}
/** §16 CURRENT_AGENT_DATE_RULE: o dia BRT desse pagamento. */
function dataDoAgente(p: PedidoColetado): string | null {
  const pg = pagamentoDoAgente(p);
  return pg === null ? null : diaBRT(pg.date_approved);
}
/** §16 CURRENT_AGENT_REVENUE_FORMULA: soma de `paid_amount`. */
function valorDoAgente(p: PedidoColetado): number {
  return n(p.paid_amount);
}
function entraNoAgente(p: PedidoColetado): boolean {
  return dentro(dataDoAgente(p));
}

// ── Candidatas monetarias ──────────────────────────────────────────

const VALORES: readonly { chave: string; rotulo: string; valor: (p: PedidoColetado) => number }[] = [
  { chave: "paid_amount", rotulo: "paid_amount (regra atual)", valor: (p) => n(p.paid_amount) },
  { chave: "total_amount", rotulo: "total_amount", valor: (p) => n(p.total_amount) },
  {
    chave: "itens_unit_x_qtd", rotulo: "soma(unit_price x quantity)",
    valor: (p) => p.itens.reduce((a, it) => a + n(it.unit_price) * n(it.quantity), 0),
  },
  {
    chave: "itens_gross", rotulo: "soma(gross_price) — preco de tabela",
    valor: (p) => p.itens.reduce((a, it) => a + n(it.gross_price), 0),
  },
  {
    chave: "pag_transaction", rotulo: "soma(payments que contam .transaction_amount)",
    valor: (p) => p.pagamentos
      .filter((pg) => pg.status !== null && STATUS_DE_PAGAMENTO_QUE_CONTA.includes(pg.status))
      .reduce((a, pg) => a + n(pg.transaction_amount), 0),
  },
  {
    chave: "pag_total_paid", rotulo: "soma(payments que contam .total_paid_amount)",
    valor: (p) => p.pagamentos
      .filter((pg) => pg.status !== null && STATUS_DE_PAGAMENTO_QUE_CONTA.includes(pg.status))
      .reduce((a, pg) => a + n(pg.total_paid_amount), 0),
  },
  {
    chave: "total_mais_frete", rotulo: "total_amount + frete do comprador",
    valor: (p) => n(p.total_amount) + p.pagamentos
      .filter((pg) => pg.status !== null && STATUS_DE_PAGAMENTO_QUE_CONTA.includes(pg.status))
      .reduce((a, pg) => a + n(pg.shipping_cost), 0),
  },
  {
    chave: "total_mais_cupom", rotulo: "total_amount + coupon.amount",
    valor: (p) => n(p.total_amount) + n(p.coupon_amount),
  },
  {
    chave: "paid_menos_estorno", rotulo: "paid_amount - estornado",
    valor: (p) => n(p.paid_amount) - p.pagamentos
      .reduce((a, pg) => a + n(pg.transaction_amount_refunded), 0),
  },
];

// ── Candidatas de data ─────────────────────────────────────────────

/**
 * O dia COMO ESCRITO no payload, sem conversao.
 *
 * MEDIDO: as 18.019 datas de `date_created` da coleta vem com offset
 * `-04:00`. A CDS converte o instante para o dia civil de Sao Paulo
 * (-03:00), que e a regra da casa — e na virada do mes as duas convencoes
 * discordam em 14 pedidos de setembro.
 */
function diaEscrito(iso: string | null): string | null {
  return iso === null || iso.length < 10 ? null : iso.slice(0, 10);
}

const DATAS: readonly { chave: string; rotulo: string; dia: (p: PedidoColetado) => string | null }[] = [
  { chave: "pagamento", rotulo: "payments[].date_approved -> dia BRT (regra atual)", dia: dataDoAgente },
  { chave: "criacao", rotulo: "order.date_created -> dia BRT", dia: (p) => diaBRT(p.date_created) },
  { chave: "fechamento", rotulo: "order.date_closed -> dia BRT", dia: (p) => diaBRT(p.date_closed) },
  {
    chave: "criacao_escrita", rotulo: "order.date_created como ESCRITO (-04:00)",
    dia: (p) => diaEscrito(p.date_created),
  },
  {
    chave: "pagamento_escrito", rotulo: "payments[].date_approved como ESCRITO (-04:00)",
    dia: (p) => {
      const pg = pagamentoDoAgente(p);
      return pg === null ? null : diaEscrito(pg.date_approved);
    },
  },
];

// ── Populacoes de status ───────────────────────────────────────────

const POPULACOES: readonly { chave: string; rotulo: string; inclui: (p: PedidoColetado) => boolean }[] = [
  {
    chave: "com_pagamento_que_conta",
    rotulo: "tem pagamento approved/partially_refunded (regra atual)",
    inclui: (p) => pagamentoDoAgente(p) !== null,
  },
  { chave: "todos", rotulo: "todos os pedidos, sem filtro", inclui: () => true },
  {
    chave: "nao_cancelado", rotulo: "todos menos status cancelled",
    inclui: (p) => p.status !== "cancelled",
  },
  {
    chave: "qualquer_pagamento", rotulo: "tem qualquer pagamento com data",
    inclui: (p) => p.pagamentos.some((pg) => pg.date_approved !== null || pg.date_created !== null),
  },
  {
    // ── Por que `pack_splitted` e diferente dos outros cancelamentos ──
    //
    // MEDIDO: 134 pedidos de setembro foram cancelados com
    // `cancel_group = internal` e `cancel_code = pack_splitted`. Nenhum
    // deles tem irmao vivo no mesmo `pack_id`: o proprio Mercado Livre
    // desfez o pedido e criou outro no lugar. Contar os dois seria contar
    // a mesma venda duas vezes — e e a unica exclusao deste tipo que a
    // medicao sustenta.
    chave: "sem_pack_splitted", rotulo: "todos menos os cancelados por pack_splitted",
    inclui: (p) => p.cancel_code !== "pack_splitted",
  },
];

function main(): void {
  const linhas = readFileSync(join(DESTINO, "pedidos.jsonl"), "utf8").trim().split("\n");
  const brutos: PedidoColetado[] = linhas.map((l) => JSON.parse(l) as PedidoColetado);
  const coleta = JSON.parse(readFileSync(join(DESTINO, "coleta.json"), "utf8")) as {
    completo: boolean; dias: { dia: string; unicos: number; total: number | null; completo: boolean }[];
  };

  console.log("══ F7b.4.8.4 — reconciliacao de setembro/2026 ══\n");

  // ═══ 1. Dataset ══════════════════════════════════════════════════
  //
  // ── As subjanelas diarias se SOBREPOEM ──────────────────────────
  //
  // Fato medido na F7b.4.8.3: o mesmo pedido volta em mais de um dia de
  // `date_created`, e a producao deduplica globalmente por isso. A coleta
  // deduplica por DIA, entao o arquivo tem repetido de proposito — e a
  // primeira versao desta analise somou esses pedidos DUAS vezes, o que
  // inflava todo candidato. A deduplicacao e aqui, e ela e por `order_id`.
  //
  // Fica a linha com `last_updated` mais recente: duas leituras do mesmo
  // pedido podem ter pegado estados diferentes, e a mais nova e a que
  // descreve o pedido hoje.
  const porId = new Map<string, PedidoColetado>();
  for (const p of brutos) {
    const atual = porId.get(p.id);
    if (atual === undefined) { porId.set(p.id, p); continue; }
    const a = atual.last_updated ?? "";
    const b = p.last_updated ?? "";
    if (b > a) porId.set(p.id, p);
  }
  const pedidos = [...porId.values()];
  const ids = new Set(pedidos.map((p) => p.id));

  console.log("1. DATASET");
  console.log(`   linhas no arquivo ........ ${brutos.length}`);
  console.log(`   order_id unicos .......... ${ids.size}`);
  console.log(`   repetidos entre dias ..... ${brutos.length - ids.size}  (esperado: subjanelas se sobrepoem)`);
  console.log(`   dias coletados ........... ${coleta.dias.length}`);
  console.log(`   dias incompletos ......... ${coleta.dias.filter((d) => !d.completo).length}`);
  console.log(`   DATASET_COMPLETE ......... ${coleta.completo ? "PROVEN" : "FAILED"}`);

  // Pedido fechado em setembro que nasceu ANTES da janela coletada
  // seria populacao perdida para a atribuicao por fechamento. A borda
  // mede isso.
  const naBorda = pedidos.filter((p) => diaBRT(p.date_created) === coleta.dias[0]?.dia);
  const bordaFechaEmSetembro = naBorda.filter((p) => dentro(diaBRT(p.date_closed))).length;
  console.log(`   no 1o dia coletado: ${naBorda.length} pedidos, ` +
    `${bordaFechaEmSetembro} fecham em setembro`);
  console.log(`   (se > 0, a atribuicao por fechamento pode ter populacao fora da janela)`);

  // ═══ 2. A regra atual ════════════════════════════════════════════

  const doAgente = pedidos.filter(entraNoAgente);
  const totalAgente = doAgente.reduce((a, p) => a + valorDoAgente(p), 0);
  const unidadesAgente = doAgente.reduce(
    (a, p) => a + p.itens.reduce((b, it) => b + n(it.quantity), 0), 0);

  console.log("\n2. A REGRA ATUAL DO AGENTE, em setembro");
  console.log(`   pedidos .................. ${doAgente.length}`);
  console.log(`   unidades ................. ${unidadesAgente}`);
  console.log(`   total .................... R$ ${brl(totalAgente)}`);
  console.log(`   preco medio por venda .... R$ ${brl(totalAgente / doAgente.length)}`);
  console.log(`   preco medio por unidade .. R$ ${brl(totalAgente / unidadesAgente)}`);
  console.log(`   painel: ${PAINEL.quantidadeDeVendas} vendas, ${PAINEL.unidadesVendidas} unidades, ` +
    `R$ ${brl(PAINEL.vendasBrutasExibido)} (exibido)`);
  console.log(`   diferenca de valor ....... R$ ${brl(PAINEL.vendasBrutasExibido - totalAgente)}` +
    `  (${((PAINEL.vendasBrutasExibido - totalAgente) / PAINEL.vendasBrutasExibido * 100).toFixed(2)}%)`);
  console.log(`   diferenca de pedidos ..... ${PAINEL.quantidadeDeVendas - doAgente.length}`);
  console.log(`   diferenca de unidades .... ${PAINEL.unidadesVendidas - unidadesAgente}`);

  // ═══ 3. Matriz: data x populacao x valor ═════════════════════════

  console.log("\n3. MATRIZ DE CANDIDATAS  (setembro, R$ e contagem)");
  interface Celula {
    data: string; populacao: string; valor: string;
    total: number; pedidos: number; unidades: number;
  }
  const celulas: Celula[] = [];
  for (const d of DATAS) {
    for (const pop of POPULACOES) {
      const conjunto = pedidos.filter((p) => pop.inclui(p) && dentro(d.dia(p)));
      const unidades = conjunto.reduce(
        (a, p) => a + p.itens.reduce((b, it) => b + n(it.quantity), 0), 0);
      for (const v of VALORES) {
        celulas.push({
          data: d.chave, populacao: pop.chave, valor: v.chave,
          total: conjunto.reduce((a, p) => a + v.valor(p), 0),
          pedidos: conjunto.length, unidades,
        });
      }
    }
  }

  // Impresso de forma legivel: por data, uma tabela populacao x valor.
  for (const d of DATAS) {
    console.log(`\n   ── data: ${d.rotulo}`);
    for (const pop of POPULACOES) {
      const umaCelula = celulas.find((c) => c.data === d.chave && c.populacao === pop.chave);
      console.log(`      populacao: ${pop.rotulo}`);
      console.log(`         pedidos=${umaCelula?.pedidos}  unidades=${umaCelula?.unidades}`);
      for (const v of VALORES) {
        const c = celulas.find((x) =>
          x.data === d.chave && x.populacao === pop.chave && x.valor === v.chave);
        if (c === undefined) continue;
        const dif = PAINEL.vendasBrutasExibido - c.total;
        console.log(`         ${v.rotulo.padEnd(46)} R$ ${brl(c.total).padStart(14)}` +
          `   vs painel ${dif >= 0 ? "+" : ""}${brl(dif).padStart(12)}`);
      }
    }
  }

  // ═══ 4. Controles cruzados — §31 ═════════════════════════════════
  //
  // Uma candidata que acerta o faturamento e erra contagem, unidades e os
  // dois precos medios nao e boa. Aqui cada candidata recebe uma nota por
  // quantos dos cinco indicadores ela aproxima.

  console.log("\n4. CONTROLES CRUZADOS — quantos indicadores cada candidata explica");
  console.log("   (tolerancia: valor 0,5% | contagem 0,5% | preco medio R$ 0,02)");
  interface Nota {
    data: string; populacao: string; valor: string;
    total: number; pedidos: number; unidades: number;
    acertaValor: boolean; acertaPedidos: boolean; acertaUnidades: boolean;
    acertaMedioVenda: boolean; acertaMedioUnidade: boolean; nota: number;
  }
  const notas: Nota[] = celulas.map((c) => {
    const medioVenda = c.pedidos === 0 ? 0 : c.total / c.pedidos;
    const medioUnidade = c.unidades === 0 ? 0 : c.total / c.unidades;
    const acertaValor = Math.abs(c.total - PAINEL.vendasBrutasExibido) <=
      PAINEL.vendasBrutasExibido * 0.005;
    const acertaPedidos = Math.abs(c.pedidos - PAINEL.quantidadeDeVendas) <=
      PAINEL.quantidadeDeVendas * 0.005;
    const acertaUnidades = Math.abs(c.unidades - PAINEL.unidadesVendidas) <=
      PAINEL.unidadesVendidas * 0.005;
    const acertaMedioVenda = Math.abs(medioVenda - PAINEL.precoMedioPorVenda) <= 0.02;
    const acertaMedioUnidade = Math.abs(medioUnidade - PAINEL.precoMedioPorUnidade) <= 0.02;
    return {
      ...c, acertaValor, acertaPedidos, acertaUnidades, acertaMedioVenda, acertaMedioUnidade,
      nota: [acertaValor, acertaPedidos, acertaUnidades, acertaMedioVenda, acertaMedioUnidade]
        .filter(Boolean).length,
    };
  });
  const melhores = [...notas].sort((a, b) =>
    b.nota - a.nota ||
    Math.abs(a.total - PAINEL.vendasBrutasExibido) - Math.abs(b.total - PAINEL.vendasBrutasExibido));
  for (const x of melhores.slice(0, 12)) {
    const marcas = `${x.acertaValor ? "V" : "-"}${x.acertaPedidos ? "Q" : "-"}` +
      `${x.acertaUnidades ? "U" : "-"}${x.acertaMedioVenda ? "v" : "-"}${x.acertaMedioUnidade ? "u" : "-"}`;
    console.log(`   ${x.nota}/5 [${marcas}] ${x.data}/${x.populacao}/${x.valor}`);
    console.log(`        R$ ${brl(x.total)}  ped=${x.pedidos}  un=${x.unidades}  ` +
      `medio/venda=${brl(x.pedidos === 0 ? 0 : x.total / x.pedidos)}  ` +
      `medio/un=${brl(x.unidades === 0 ? 0 : x.total / x.unidades)}`);
  }

  // ═══ 5. Canceladas — a ancora extra do §28 ═══════════════════════

  console.log("\n5. CANCELADAS — painel diz 414");
  const canceladasPor: { criterio: string; n: number }[] = [];
  const contarCancel = (criterio: string, f: (p: PedidoColetado) => boolean) => {
    const n = pedidos.filter(f).length;
    canceladasPor.push({ criterio, n });
    console.log(`   ${criterio.padEnd(52)} ${String(n).padStart(5)}` +
      `   vs painel ${PAINEL.canceladas - n >= 0 ? "+" : ""}${PAINEL.canceladas - n}`);
  };
  contarCancel("status=cancelled, criado em setembro (escrito)",
    (p) => p.status === "cancelled" && dentro(diaEscrito(p.date_created)));
  contarCancel("idem, sem os internos (pack_splitted etc.)",
    (p) => p.status === "cancelled" && p.cancel_group !== "internal" &&
      dentro(diaEscrito(p.date_created)));
  contarCancel("status=cancelled, CANCELADO em setembro (escrito)",
    (p) => p.status === "cancelled" && dentro(diaEscrito(p.cancel_date)));
  contarCancel("idem, sem os internos",
    (p) => p.status === "cancelled" && p.cancel_group !== "internal" &&
      dentro(diaEscrito(p.cancel_date)));
  contarCancel("cancelado em setembro, sem internos, que TEVE pagamento",
    (p) => p.status === "cancelled" && p.cancel_group !== "internal" &&
      dentro(diaEscrito(p.cancel_date)) &&
      p.pagamentos.some((pg) => pg.date_approved !== null));

  const gruposCancel = new Map<string, number>();
  for (const p of pedidos) {
    if (p.status !== "cancelled" || !dentro(diaEscrito(p.date_created))) continue;
    const k = `${p.cancel_group ?? "?"} / ${p.cancel_code ?? "?"}`;
    gruposCancel.set(k, (gruposCancel.get(k) ?? 0) + 1);
  }
  console.log("   motivos (criados em setembro, data escrita):");
  for (const [k, v] of [...gruposCancel.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`     ${String(v).padStart(5)}  ${k}`);
  }
  console.log("   NENHUM critério reproduz 414. A definicao de 'venda cancelada'");
  console.log("   do painel NAO esta disponivel pela API — fica ABERTO.");

  // ═══ 6. Populacoes de excecao ════════════════════════════════════

  console.log("\n6. POPULACOES DE EXCECAO (criados em setembro)");
  const setembroCriacao = pedidos.filter((p) => dentro(diaBRT(p.date_created)));
  const grupos: { chave: string; rotulo: string; pedidos: PedidoColetado[] }[] = [
    {
      chave: "MULTIPLOS_PAGAMENTOS", rotulo: "mais de um pagamento",
      pedidos: setembroCriacao.filter((p) => p.pagamentos.length > 1),
    },
    {
      chave: "MULTIPLOS_APROVADOS", rotulo: "mais de um pagamento que conta",
      pedidos: setembroCriacao.filter((p) => p.pagamentos.filter((pg) =>
        pg.status !== null && STATUS_DE_PAGAMENTO_QUE_CONTA.includes(pg.status)).length > 1),
    },
    {
      chave: "PARTIAL_REFUNDS", rotulo: "estorno parcial (pedido partially_refunded)",
      pedidos: setembroCriacao.filter((p) => p.status === "partially_refunded"),
    },
    {
      chave: "FULL_REFUNDS", rotulo: "estorno total (todo pagamento refunded)",
      pedidos: setembroCriacao.filter((p) => p.pagamentos.length > 0 &&
        p.pagamentos.every((pg) => pg.status === "refunded")),
    },
    {
      chave: "PAID_THEN_CANCELLED", rotulo: "cancelado tendo tido pagamento aprovado",
      pedidos: setembroCriacao.filter((p) => p.status === "cancelled" &&
        p.pagamentos.some((pg) => pg.date_approved !== null &&
          (pg.status === "approved" || pg.status === "refunded" ||
            pg.status === "partially_refunded"))),
    },
    {
      chave: "CHARGEBACK", rotulo: "chargeback",
      pedidos: setembroCriacao.filter((p) =>
        p.pagamentos.some((pg) => pg.status === "charged_back")),
    },
    {
      chave: "MEDIATION", rotulo: "mediacao",
      pedidos: setembroCriacao.filter((p) => p.mediacoes > 0 ||
        p.pagamentos.some((pg) => pg.status === "in_mediation")),
    },
    {
      chave: "PAID_NE_TOTAL", rotulo: "paid_amount != total_amount",
      pedidos: setembroCriacao.filter((p) =>
        Math.abs(n(p.paid_amount) - n(p.total_amount)) > 0.005),
    },
    {
      chave: "GROSS_NE_TOTAL", rotulo: "soma(gross_price) != total_amount",
      pedidos: setembroCriacao.filter((p) =>
        Math.abs(p.itens.reduce((a, it) => a + n(it.gross_price), 0) - n(p.total_amount)) > 0.005),
    },
    {
      chave: "SEM_PAGAMENTO_QUE_CONTA", rotulo: "nenhum pagamento que conta — fora da regra atual",
      pedidos: setembroCriacao.filter((p) => pagamentoDoAgente(p) === null),
    },
  ];
  for (const g of grupos) {
    const soma = g.pedidos.reduce((a, p) => a + valorDoAgente(p), 0);
    const somaTotal = g.pedidos.reduce((a, p) => a + n(p.total_amount), 0);
    const somaGross = g.pedidos.reduce(
      (a, p) => a + p.itens.reduce((b, it) => b + n(it.gross_price), 0), 0);
    console.log(`   ${g.chave.padEnd(24)} ${String(g.pedidos.length).padStart(5)} pedidos  ` +
      `paid=R$ ${brl(soma).padStart(12)}  total=R$ ${brl(somaTotal).padStart(12)}  ` +
      `gross=R$ ${brl(somaGross).padStart(12)}`);
  }

  // ═══ 7. Virada do mes — §19 ══════════════════════════════════════

  console.log("\n7. VIRADA DO MES — pedidos que mudam de competencia");
  let mudamCriacaoPagamento = 0;
  let valorMudaCriacaoPagamento = 0;
  let mudamCriacaoFechamento = 0;
  for (const p of pedidos) {
    const c = diaBRT(p.date_created);
    const pag = dataDoAgente(p);
    const f = diaBRT(p.date_closed);
    if (c !== null && pag !== null && dentro(c) !== dentro(pag)) {
      mudamCriacaoPagamento += 1;
      valorMudaCriacaoPagamento += dentro(c) ? n(p.paid_amount) : -n(p.paid_amount);
    }
    if (c !== null && f !== null && dentro(c) !== dentro(f)) mudamCriacaoFechamento += 1;
  }
  console.log(`   criacao vs pagamento: ${mudamCriacaoPagamento} pedidos mudam de mes`);
  console.log(`     efeito liquido em setembro: R$ ${brl(valorMudaCriacaoPagamento)}`);
  console.log(`   criacao vs fechamento: ${mudamCriacaoFechamento} pedidos mudam de mes`);

  // ═══ 8. Decomposicao da diferenca — §33 ══════════════════════════
  //
  // Um passo por vez, cumulativo, da regra de hoje ate a candidata que
  // mais explica o painel. Cada linha mostra o que AQUELA troca move —
  // e nao um rateio inventado no fim.

  console.log("\n8. DECOMPOSICAO — passo a passo, cumulativo");
  interface Passo {
    nome: string; total: number; pedidos: number; unidades: number;
    deltaValor: number; deltaPedidos: number;
  }
  const medir = (
    dia: (p: PedidoColetado) => string | null,
    inclui: (p: PedidoColetado) => boolean,
    valor: (p: PedidoColetado) => number
  ) => {
    const c = pedidos.filter((p) => inclui(p) && dentro(dia(p)));
    return {
      total: c.reduce((a, p) => a + valor(p), 0),
      pedidos: c.length,
      unidades: c.reduce((a, p) => a + p.itens.reduce((b, it) => b + n(it.quantity), 0), 0),
    };
  };
  const temPagamentoQueConta = (p: PedidoColetado) => pagamentoDoAgente(p) !== null;
  const semSplit = (p: PedidoColetado) => p.cancel_code !== "pack_splitted";
  const vTotal = (p: PedidoColetado) => n(p.total_amount);

  const estagios: { nome: string; m: { total: number; pedidos: number; unidades: number } }[] = [
    {
      nome: "1. regra de hoje: pagamento BRT + paid_amount + so quem tem pagamento",
      m: medir(dataDoAgente, temPagamentoQueConta, valorDoAgente),
    },
    {
      nome: "2. troca o VALOR: paid_amount -> total_amount",
      m: medir(dataDoAgente, temPagamentoQueConta, vTotal),
    },
    {
      nome: "3. troca a DATA: pagamento BRT -> criacao como escrita (-04:00)",
      m: medir((p) => diaEscrito(p.date_created), temPagamentoQueConta, vTotal),
    },
    {
      nome: "4. troca a POPULACAO: so quem tem pagamento -> todos menos pack_splitted",
      m: medir((p) => diaEscrito(p.date_created), semSplit, vTotal),
    },
  ];
  const passos: Passo[] = [];
  let anterior: { total: number; pedidos: number } | null = null;
  for (const e of estagios) {
    passos.push({
      nome: e.nome, total: e.m.total, pedidos: e.m.pedidos, unidades: e.m.unidades,
      deltaValor: anterior === null ? 0 : e.m.total - anterior.total,
      deltaPedidos: anterior === null ? 0 : e.m.pedidos - anterior.pedidos,
    });
    console.log(`   ${e.nome}`);
    console.log(`      R$ ${brl(e.m.total).padStart(14)}  ped=${String(e.m.pedidos).padStart(6)}` +
      `  un=${String(e.m.unidades).padStart(6)}` +
      (anterior === null ? "" :
        `   delta R$ ${brl(e.m.total - anterior.total)}  ped ${e.m.pedidos - anterior.pedidos >= 0 ? "+" : ""}${e.m.pedidos - anterior.pedidos}`));
    anterior = { total: e.m.total, pedidos: e.m.pedidos };
  }
  const melhor = estagios[estagios.length - 1].m;
  const residuoValor = PAINEL.vendasBrutasExibido - melhor.total;
  const residuoPedidos = PAINEL.quantidadeDeVendas - melhor.pedidos;
  const residuoUnidades = PAINEL.unidadesVendidas - melhor.unidades;
  const divergenciaTotal = PAINEL.vendasBrutasExibido - passos[0].total;
  console.log(`\n   painel exibido ........... R$ ${brl(PAINEL.vendasBrutasExibido)}`);
  console.log(`   divergencia inicial ...... R$ ${brl(divergenciaTotal)}`);
  console.log(`   explicado pelos passos ... R$ ${brl(divergenciaTotal - residuoValor)}` +
    `  (${((divergenciaTotal - residuoValor) / divergenciaTotal * 100).toFixed(1)}%)`);
  console.log(`   NAO explicado ............ R$ ${brl(residuoValor)}  ` +
    `(${residuoPedidos} pedidos, ${residuoUnidades} unidades)`);
  console.log(`   preco medio por venda .... R$ ${brl(melhor.total / melhor.pedidos)}` +
    `   painel R$ ${brl(PAINEL.precoMedioPorVenda)}`);
  console.log(`   preco medio por unidade .. R$ ${brl(melhor.total / melhor.unidades)}` +
    `   painel R$ ${brl(PAINEL.precoMedioPorUnidade)}`);

  // ═══ 9. As linhas que vao para as planilhas ══════════════════════

  const doMes = pedidos
    .filter((p) => dentro(diaEscrito(p.date_created)) || dentro(dataDoAgente(p)))
    .sort((a, b) => (a.date_created ?? "").localeCompare(b.date_created ?? ""));

  const linhasPedido = doMes.map((p) => {
    const pg = pagamentoDoAgente(p);
    const unidades = p.itens.reduce((a, it) => a + n(it.quantity), 0);
    const estornado = p.pagamentos.reduce((a, x) => a + n(x.transaction_amount_refunded), 0);
    const noAgente = dentro(dataDoAgente(p));
    const naCandidata = dentro(diaEscrito(p.date_created)) && semSplit(p);
    const excecoes: string[] = [];
    if (p.pagamentos.length > 1) excecoes.push("multiplos_pagamentos");
    if (p.pagamentos.filter((x) => x.status !== null &&
      STATUS_DE_PAGAMENTO_QUE_CONTA.includes(x.status)).length > 1) excecoes.push("multiplos_aprovados");
    if (p.status === "partially_refunded") excecoes.push("estorno_parcial");
    if (p.pagamentos.length > 0 && p.pagamentos.every((x) => x.status === "refunded")) {
      excecoes.push("estorno_total");
    }
    if (p.status === "cancelled") excecoes.push(`cancelado:${p.cancel_code ?? "?"}`);
    if (p.pagamentos.some((x) => x.status === "charged_back")) excecoes.push("chargeback");
    if (p.mediacoes > 0 || p.pagamentos.some((x) => x.status === "in_mediation")) {
      excecoes.push("mediacao");
    }
    if (Math.abs(n(p.paid_amount) - n(p.total_amount)) > 0.005) excecoes.push("paid!=total");
    if (dentro(diaEscrito(p.date_created)) !== dentro(diaBRT(p.date_created))) {
      excecoes.push("virada_de_mes_por_fuso");
    }
    return {
      order_id: p.id,
      status_pedido: p.status ?? "",
      date_created: p.date_created ?? "",
      dia_criacao_escrito: diaEscrito(p.date_created) ?? "",
      dia_criacao_brt: diaBRT(p.date_created) ?? "",
      date_closed: p.date_closed ?? "",
      dia_pagamento_brt: dataDoAgente(p) ?? "",
      unidades,
      total_amount: n(p.total_amount),
      paid_amount: n(p.paid_amount),
      soma_gross_price: p.itens.reduce((a, it) => a + n(it.gross_price), 0),
      soma_unit_x_qtd: p.itens.reduce((a, it) => a + n(it.unit_price) * n(it.quantity), 0),
      coupon_amount: n(p.coupon_amount),
      frete_comprador: p.pagamentos.reduce((a, x) => a + n(x.shipping_cost), 0),
      estornado,
      qtd_pagamentos: p.pagamentos.length,
      status_pagamentos: p.pagamentos.map((x) => x.status ?? "?").join("|"),
      cancel_group: p.cancel_group ?? "",
      cancel_code: p.cancel_code ?? "",
      cancel_date: p.cancel_date ?? "",
      mediacoes: p.mediacoes,
      pack_id: p.pack_id ?? "",
      // O que o agente faz HOJE com este pedido, e por que.
      agente_incluiu: noAgente ? "SIM" : "NAO",
      agente_valor_usado: noAgente ? n(p.paid_amount) : 0,
      agente_campo_valor: "paid_amount",
      agente_campo_data: "payments[].date_approved (mais antigo) -> dia BRT",
      agente_data_usada: dataDoAgente(p) ?? "",
      agente_motivo: pg === null
        ? "sem pagamento approved/partially_refunded"
        : (noAgente ? "pagamento aprovado dentro do periodo" : "pagamento aprovado FORA do periodo"),
      // O que a candidata faria.
      candidata_incluiu: naCandidata ? "SIM" : "NAO",
      candidata_valor_usado: naCandidata ? n(p.total_amount) : 0,
      candidata_motivo: !dentro(diaEscrito(p.date_created))
        ? "criado fora de setembro (data escrita)"
        : (semSplit(p) ? "criado em setembro" : "cancelado por pack_splitted"),
      excecoes: excecoes.join("; "),
    };
  });

  const linhasPagamento: Record<string, unknown>[] = [];
  for (const p of doMes) {
    for (const pg of p.pagamentos) {
      linhasPagamento.push({
        order_id: p.id,
        payment_id: pg.id,
        status: pg.status ?? "",
        status_detail: pg.status_detail ?? "",
        date_approved: pg.date_approved ?? "",
        dia_aprovado_escrito: diaEscrito(pg.date_approved) ?? "",
        dia_aprovado_brt: diaBRT(pg.date_approved) ?? "",
        date_created: pg.date_created ?? "",
        transaction_amount: n(pg.transaction_amount),
        total_paid_amount: n(pg.total_paid_amount),
        shipping_cost: n(pg.shipping_cost),
        coupon_amount: n(pg.coupon_amount),
        taxes_amount: n(pg.taxes_amount),
        overpaid_amount: n(pg.overpaid_amount),
        transaction_amount_refunded: n(pg.transaction_amount_refunded),
        installments: n(pg.installments),
        payment_type: pg.payment_type ?? "",
        operation_type: pg.operation_type ?? "",
        conta_na_regra_atual: pg.status !== null &&
          STATUS_DE_PAGAMENTO_QUE_CONTA.includes(pg.status) && pg.date_approved !== null
          ? "SIM" : "NAO",
        escolhido_pelo_agente: pagamentoDoAgente(p)?.id === pg.id ? "SIM" : "NAO",
      });
    }
  }

  // ═══ 10. Grava o JSON que alimenta as planilhas ══════════════════

  mkdirSync(DESTINO, { recursive: true });
  writeFileSync(join(DESTINO, "analise.json"), JSON.stringify({
    geradoEm: new Date().toISOString(),
    periodo: { de: DE, ate: ATE },
    painel: PAINEL,
    dataset: {
      linhasNoArquivo: brutos.length, idsUnicos: ids.size,
      repetidosEntreDias: brutos.length - ids.size,
      completo: coleta.completo, dias: coleta.dias,
      bordaFechaEmSetembro,
    },
    regraAtual: {
      pedidos: doAgente.length, unidades: unidadesAgente, total: totalAgente,
      medioPorVenda: totalAgente / doAgente.length,
      medioPorUnidade: totalAgente / unidadesAgente,
    },
    celulas, notas,
    grupos: grupos.map((g) => ({
      chave: g.chave, rotulo: g.rotulo, pedidos: g.pedidos.length,
      somaPaid: g.pedidos.reduce((a, p) => a + n(p.paid_amount), 0),
      somaTotal: g.pedidos.reduce((a, p) => a + n(p.total_amount), 0),
      somaGross: g.pedidos.reduce(
        (a, p) => a + p.itens.reduce((b, it) => b + n(it.gross_price), 0), 0),
      ids: g.pedidos.map((p) => p.id),
    })),
    viradaDeMes: {
      criacaoVsPagamento: mudamCriacaoPagamento,
      efeitoLiquido: valorMudaCriacaoPagamento,
      criacaoVsFechamento: mudamCriacaoFechamento,
    },
    canceladasPor,
    decomposicao: {
      passos,
      divergenciaInicial: divergenciaTotal,
      explicado: divergenciaTotal - residuoValor,
      naoExplicado: residuoValor,
      residuoPedidos, residuoUnidades,
      melhor: {
        total: melhor.total, pedidos: melhor.pedidos, unidades: melhor.unidades,
        medioPorVenda: melhor.total / melhor.pedidos,
        medioPorUnidade: melhor.total / melhor.unidades,
      },
    },
    linhasPedido, linhasPagamento,
  }, null, 2), "utf8");
  console.log(`\n   analise.json gravado em ${DESTINO}`);
  console.log(`   linhas por pedido: ${linhasPedido.length}   por pagamento: ${linhasPagamento.length}`);
}

main();
