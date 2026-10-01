/**
 * As tres planilhas de pericia de setembro/2026 — F7b.4.8.4 §37/§38/§39.
 *
 * Le o que `medir-ml-coletar-setembro.ts` e `medir-ml-reconciliar-setembro.ts`
 * gravaram. Nao fala com a API, nao fala com o banco.
 *
 * ── Elas NAO sao a feature de planilha da Agent Factory ─────────────
 *
 * Sao ferramenta de diagnostico, geradas fora do repositorio, para o
 * Rodrigo abrir e conferir pedido por pedido.
 *
 * ── O que NAO entra ─────────────────────────────────────────────────
 *
 * Token, credencial, seller id, comprador, nome, endereco, titulo de
 * anuncio. Entra `order_id`, porque e por ele que se acha o mesmo pedido
 * nos tres arquivos (§40).
 *
 * Roda com: node scripts/gerar-planilhas-reconciliacao.mjs [pasta-de-saida]
 */
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { escreverXlsx } from "./gerar-xlsx.mjs";

const ORIGEM = process.env.ORIGEM ??
  join("C:", "Users", "USER", "AppData", "Local", "Temp", "claude",
    "c--Users-USER-Desktop-calculadora-dos-sellers-v1",
    "c9e0b194-ce1f-484c-80df-7b403c7a8702", "scratchpad", "ml-setembro");
const SAIDA = process.argv[2] ??
  join("C:", "Users", "USER", "Desktop", "reconciliacao-ml-setembro-2026");

const a = JSON.parse(readFileSync(join(ORIGEM, "analise.json"), "utf8"));
const coleta = JSON.parse(readFileSync(join(ORIGEM, "coleta.json"), "utf8"));

const linhasBrutas = readFileSync(join(ORIGEM, "pedidos.jsonl"), "utf8").trim().split("\n");
const porId = new Map();
for (const l of linhasBrutas) {
  const o = JSON.parse(l);
  const atual = porId.get(o.id);
  if (atual === undefined || (o.last_updated ?? "") > (atual.last_updated ?? "")) {
    porId.set(o.id, o);
  }
}
const pedidos = [...porId.values()];

const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const escrito = (iso) => (typeof iso === "string" && iso.length >= 10 ? iso.slice(0, 10) : "");
const dentro = (d) => d >= "2026-09-01" && d <= "2026-09-30";

mkdirSync(SAIDA, { recursive: true });

// ═══════════════════════════════════════════════════════════════════
// ARTEFATO 1 — ML_API_RAW_SETEMBRO_2026.xlsx
// ═══════════════════════════════════════════════════════════════════

// ── A populacao do arquivo bruto e a UNIAO de tudo que se cita ──────
//
// §40 exige que o Rodrigo copie um `order_id` de um arquivo e ache o
// mesmo pedido no outro. A primeira versao filtrou o bruto por criacao ou
// fechamento em setembro, enquanto as abas de pagamento e de calculo
// usavam tambem a data de PAGAMENTO — e 4 pedidos ficaram orfaos, citados
// num arquivo e ausentes do outro. A suite de verificacao pegou.
//
// Entao o bruto cobre: criado, fechado OU pago em setembro, mais qualquer
// id citado pelas outras duas planilhas.
const citados = new Set([
  ...a.linhasPedido.map((l) => String(l.order_id)),
  ...a.linhasPagamento.map((l) => String(l.order_id)),
]);
const doMes = pedidos.filter((p) =>
  citados.has(p.id) ||
  dentro(escrito(p.date_created)) ||
  dentro(escrito(p.date_closed)) ||
  p.pagamentos.some((pg) => dentro(escrito(pg.date_approved))));

const colsOrders = [
  "order_id", "status", "status_detail", "date_created", "date_closed", "last_updated",
  "dia_criacao_escrito_-04", "dia_criacao_brt_-03", "currency_id",
  "total_amount", "paid_amount", "coupon_amount", "taxes_amount",
  "soma_gross_price", "soma_unit_price_x_qtd", "unidades", "qtd_itens",
  "qtd_pagamentos", "status_pagamentos", "soma_transaction_amount",
  "soma_total_paid_amount", "soma_shipping_cost", "soma_estornado",
  "cancel_group", "cancel_code", "cancel_date", "mediacoes", "pack_id", "fulfilled", "tags",
];
const orders = doMes.map((p) => ({
  order_id: p.id,
  status: p.status ?? "",
  status_detail: p.status_detail ?? "",
  date_created: p.date_created ?? "",
  date_closed: p.date_closed ?? "",
  last_updated: p.last_updated ?? "",
  "dia_criacao_escrito_-04": escrito(p.date_created),
  "dia_criacao_brt_-03": p.date_created
    ? new Date(new Date(p.date_created).getTime() - 3 * 3600e3).toISOString().slice(0, 10) : "",
  currency_id: p.currency_id ?? "",
  total_amount: n(p.total_amount),
  paid_amount: n(p.paid_amount),
  coupon_amount: n(p.coupon_amount),
  taxes_amount: n(p.taxes_amount),
  soma_gross_price: p.itens.reduce((s, it) => s + n(it.gross_price), 0),
  soma_unit_price_x_qtd: p.itens.reduce((s, it) => s + n(it.unit_price) * n(it.quantity), 0),
  unidades: p.itens.reduce((s, it) => s + n(it.quantity), 0),
  qtd_itens: p.itens.length,
  qtd_pagamentos: p.pagamentos.length,
  status_pagamentos: p.pagamentos.map((x) => x.status ?? "?").join("|"),
  soma_transaction_amount: p.pagamentos.reduce((s, x) => s + n(x.transaction_amount), 0),
  soma_total_paid_amount: p.pagamentos.reduce((s, x) => s + n(x.total_paid_amount), 0),
  soma_shipping_cost: p.pagamentos.reduce((s, x) => s + n(x.shipping_cost), 0),
  soma_estornado: p.pagamentos.reduce((s, x) => s + n(x.transaction_amount_refunded), 0),
  cancel_group: p.cancel_group ?? "",
  cancel_code: p.cancel_code ?? "",
  cancel_date: p.cancel_date ?? "",
  mediacoes: p.mediacoes,
  pack_id: p.pack_id ?? "",
  fulfilled: p.fulfilled === null ? "" : (p.fulfilled ? "SIM" : "NAO"),
  tags: (p.tags ?? []).join("|"),
}));

const colsItens = ["order_id", "item_id", "category_id", "listing_type_id",
  "quantity", "unit_price", "gross_price", "unit_x_qtd", "gross_menos_unit_x_qtd", "sale_fee"];
const itens = [];
for (const p of doMes) {
  for (const it of p.itens) {
    itens.push({
      order_id: p.id,
      item_id: it.item_id ?? "",
      category_id: it.category_id ?? "",
      listing_type_id: it.listing_type_id ?? "",
      quantity: n(it.quantity),
      unit_price: n(it.unit_price),
      gross_price: n(it.gross_price),
      unit_x_qtd: n(it.unit_price) * n(it.quantity),
      gross_menos_unit_x_qtd: n(it.gross_price) - n(it.unit_price) * n(it.quantity),
      sale_fee: n(it.sale_fee),
    });
  }
}

const colsPag = Object.keys(a.linhasPagamento[0] ?? { order_id: "" });

// Inventario de campos: o que foi MEDIDO no payload, nao documentado.
const colsCampos = ["campo", "onde", "tipo", "presenca", "observacao_medida"];
const campos = [
  { campo: "total_amount", onde: "order", tipo: "number", presenca: "100%",
    observacao_medida: "igual a soma(unit_price x quantity). E o que foi cobrado." },
  { campo: "paid_amount", onde: "order", tipo: "number", presenca: "100%",
    observacao_medida: "o que o comprador pagou; 0,00 quando houve estorno total. Campo usado HOJE pelo agente." },
  { campo: "order_items[].unit_price", onde: "item", tipo: "number", presenca: "100%",
    observacao_medida: "preco por unidade efetivamente cobrado" },
  { campo: "order_items[].gross_price", onde: "item", tipo: "number", presenca: "100%",
    observacao_medida: "preco de TABELA da linha (quantity x preco cheio). MEDIDO: em 300 de 410 itens com quantity=2, gross = 2 x unit cheio; nunca igual a unit_price." },
  { campo: "order_items[].quantity", onde: "item", tipo: "number", presenca: "100%",
    observacao_medida: "unidades. A soma delas e que corresponde a 'Unidades vendidas' do painel." },
  { campo: "order_items[].sale_fee", onde: "item", tipo: "number", presenca: "100%",
    observacao_medida: "tarifa do Mercado Livre. CUSTO, nao receita." },
  { campo: "coupon.amount", onde: "order", tipo: "number", presenca: "100% (muitos 0)",
    observacao_medida: "cupom; existe SO na busca, nao em /orders/{id}" },
  { campo: "taxes.amount", onde: "order", tipo: "null", presenca: "0% preenchido",
    observacao_medida: "sempre nulo nesta loja" },
  { campo: "shipping_cost (order)", onde: "order", tipo: "null", presenca: "0% preenchido",
    observacao_medida: "sempre nulo; o frete aparece em payments[].shipping_cost" },
  { campo: "payments[].transaction_amount", onde: "payment", tipo: "number", presenca: "100%",
    observacao_medida: "valor da transacao" },
  { campo: "payments[].total_paid_amount", onde: "payment", tipo: "number", presenca: "100%",
    observacao_medida: "transacao + frete + taxas do pagamento" },
  { campo: "payments[].shipping_cost", onde: "payment", tipo: "number", presenca: "100%",
    observacao_medida: "frete pago pelo comprador" },
  { campo: "payments[].transaction_amount_refunded", onde: "payment", tipo: "number", presenca: "100%",
    observacao_medida: "quanto foi estornado" },
  { campo: "payments[].status", onde: "payment", tipo: "string", presenca: "100%",
    observacao_medida: "approved, refunded, rejected, cancelled, charged_back, in_mediation" },
  { campo: "payments[].date_approved", onde: "payment", tipo: "string|null", presenca: "98%",
    observacao_medida: "data usada HOJE pelo agente (a mais antiga aprovada)" },
  { campo: "payments[].marketplace_fee", onde: "payment", tipo: "number", presenca: "SO em /orders/{id}",
    observacao_medida: "NAO existe em /orders/search. Tarifa, nao receita." },
  { campo: "order_items[].discounts", onde: "item", tipo: "?", presenca: "SO em /orders/{id}",
    observacao_medida: "NAO existe em /orders/search. Campo de desconto nao auditado por amostra completa." },
  { campo: "date_created", onde: "order", tipo: "string", presenca: "100%",
    observacao_medida: "MEDIDO: 18.019 de 18.019 vem com offset -04:00, nao -03:00" },
  { campo: "date_closed", onde: "order", tipo: "string", presenca: "100%",
    observacao_medida: "quase sempre poucos segundos depois de date_created nesta loja" },
  { campo: "cancel_detail.group / .code", onde: "order", tipo: "string", presenca: "so em cancelados",
    observacao_medida: "existe SO na busca. `internal/pack_splitted` marca pedido que o ML desfez e recriou." },
  { campo: "mediations[]", onde: "order", tipo: "array", presenca: "so com mediacao",
    observacao_medida: "existe SO na busca" },
];

const r1 = escreverXlsx(join(SAIDA, "ML_API_RAW_SETEMBRO_2026.xlsx"), [
  { nome: "Orders_Raw_Normalized", colunas: colsOrders, linhas: orders },
  { nome: "Payments_Raw_Normalized", colunas: colsPag, linhas: a.linhasPagamento },
  { nome: "Order_Items", colunas: colsItens, linhas: itens },
  { nome: "Campos_Medidos", colunas: colsCampos, linhas: campos },
  {
    nome: "Status_Distribution",
    colunas: ["escopo", "chave", "pedidos"],
    linhas: (() => {
      const l = [];
      const conta = (escopo, f) => {
        const m = new Map();
        for (const p of doMes) {
          if (!dentro(escrito(p.date_created))) continue;
          const k = f(p);
          if (k === null) continue;
          m.set(k, (m.get(k) ?? 0) + 1);
        }
        for (const [k, v] of [...m.entries()].sort((x, y) => y[1] - x[1])) {
          l.push({ escopo, chave: k, pedidos: v });
        }
      };
      conta("order.status", (p) => p.status ?? "?");
      conta("cancel_group/code", (p) =>
        p.status === "cancelled" ? `${p.cancel_group ?? "?"} / ${p.cancel_code ?? "?"}` : null);
      conta("qtd_pagamentos", (p) => String(p.pagamentos.length));
      const mp = new Map();
      for (const p of doMes) {
        if (!dentro(escrito(p.date_created))) continue;
        for (const pg of p.pagamentos) {
          const k = `${pg.status ?? "?"} / ${pg.status_detail ?? "?"}`;
          mp.set(k, (mp.get(k) ?? 0) + 1);
        }
      }
      for (const [k, v] of [...mp.entries()].sort((x, y) => y[1] - x[1])) {
        l.push({ escopo: "payment.status/detail", chave: k, pedidos: v });
      }
      return l;
    })(),
  },
  {
    nome: "Metadata",
    colunas: ["item", "valor"],
    linhas: [
      { item: "gate", valor: "AGENT-FACTORY-F7b.4.8.4" },
      { item: "gerado em", valor: a.geradoEm },
      { item: "coletado em", valor: coleta.coletadoEm },
      { item: "fonte", valor: "api.mercadolibre.com/orders/search — leitura apenas" },
      { item: "janela de criacao coletada", valor: `${coleta.criacaoDe} a ${coleta.criacaoAte}` },
      { item: "dias coletados", valor: coleta.dias.length },
      { item: "dias incompletos", valor: coleta.diasIncompletos.length },
      { item: "linhas lidas da API", valor: linhasBrutas.length },
      { item: "order_id unicos", valor: pedidos.length },
      { item: "repetidos entre subjanelas", valor: linhasBrutas.length - pedidos.length },
      { item: "pedidos nesta planilha", valor: orders.length },
      { item: "ATENCAO", valor: "paid_amount, total_amount e gross_price sao campos DIFERENTES. Ver aba Campos_Medidos." },
      { item: "nao contem", valor: "token, credencial, seller, comprador, endereco, titulo de anuncio" },
    ],
  },
]);

// ═══════════════════════════════════════════════════════════════════
// ARTEFATO 2 — AGENTE_CALCULO_SETEMBRO_2026.xlsx
// ═══════════════════════════════════════════════════════════════════

const colsCalc = Object.keys(a.linhasPedido[0] ?? { order_id: "" });
const incluidos = a.linhasPedido.filter((l) => l.agente_incluiu === "SIM");
const excluidos = a.linhasPedido.filter((l) => l.agente_incluiu !== "SIM");

const porDia = (() => {
  const m = new Map();
  for (const l of incluidos) {
    const k = l.dia_pagamento_brt;
    const atual = m.get(k) ?? { dia: k, pedidos: 0, unidades: 0, paid_amount: 0, total_amount: 0 };
    atual.pedidos += 1;
    atual.unidades += l.unidades;
    atual.paid_amount += l.paid_amount;
    atual.total_amount += l.total_amount;
    m.set(k, atual);
  }
  return [...m.values()].sort((x, y) => x.dia.localeCompare(y.dia));
})();

const comExcecao = (termo) => a.linhasPedido.filter((l) => l.excecoes.includes(termo));

const suspeitos = [...a.linhasPedido]
  .map((l) => ({
    ...l,
    impacto: Math.max(
      Math.abs(l.total_amount - l.paid_amount),
      Math.abs(l.soma_gross_price - l.total_amount),
      l.estornado
    ),
  }))
  .sort((x, y) => y.impacto - x.impacto)
  .slice(0, 100);

const r2 = escreverXlsx(join(SAIDA, "AGENTE_CALCULO_SETEMBRO_2026.xlsx"), [
  {
    nome: "Resumo",
    colunas: ["indicador", "agente_hoje", "painel_oficial", "diferenca", "observacao"],
    linhas: [
      {
        indicador: "Faturamento (pagos)", agente_hoje: a.regraAtual.total,
        painel_oficial: a.painel.vendasBrutasExibido,
        diferenca: a.painel.vendasBrutasExibido - a.regraAtual.total,
        observacao: "painel exibido SEM centavos; 'Vendas brutas' pode nao ser a mesma metrica",
      },
      {
        indicador: "Quantidade de pedidos", agente_hoje: a.regraAtual.pedidos,
        painel_oficial: a.painel.quantidadeDeVendas,
        diferenca: a.painel.quantidadeDeVendas - a.regraAtual.pedidos, observacao: "",
      },
      {
        indicador: "Unidades", agente_hoje: a.regraAtual.unidades,
        painel_oficial: a.painel.unidadesVendidas,
        diferenca: a.painel.unidadesVendidas - a.regraAtual.unidades,
        observacao: "soma de order_items[].quantity",
      },
      {
        indicador: "Preco medio por venda", agente_hoje: Number(a.regraAtual.medioPorVenda.toFixed(2)),
        painel_oficial: a.painel.precoMedioPorVenda,
        diferenca: Number((a.painel.precoMedioPorVenda - a.regraAtual.medioPorVenda).toFixed(2)),
        observacao: "",
      },
      {
        indicador: "Preco medio por unidade", agente_hoje: Number(a.regraAtual.medioPorUnidade.toFixed(2)),
        painel_oficial: a.painel.precoMedioPorUnidade,
        diferenca: Number((a.painel.precoMedioPorUnidade - a.regraAtual.medioPorUnidade).toFixed(2)),
        observacao: "",
      },
      { indicador: "", agente_hoje: "", painel_oficial: "", diferenca: "", observacao: "" },
      {
        indicador: "REGRA DE VALOR usada hoje", agente_hoje: "soma de order.paid_amount",
        painel_oficial: "", diferenca: "", observacao: "nao usa total_amount nem gross_price",
      },
      {
        indicador: "REGRA DE DATA usada hoje",
        agente_hoje: "payments[].date_approved mais antigo, convertido para o dia de Sao Paulo (-03:00)",
        painel_oficial: "", diferenca: "",
        observacao: "a API devolve as datas em -04:00",
      },
      {
        indicador: "REGRA DE PAGAMENTO usada hoje",
        agente_hoje: "status approved ou partially_refunded, com date_approved",
        painel_oficial: "", diferenca: "", observacao: "",
      },
      {
        indicador: "REGRA DE ESTORNO usada hoje",
        agente_hoje: "nao desconta: soma paid_amount cheio",
        painel_oficial: "", diferenca: "",
        observacao: "estorno total zera paid_amount na propria API",
      },
      {
        indicador: "REGRA DE CANCELAMENTO usada hoje",
        agente_hoje: "nao olha order.status; quem decide e o pagamento",
        painel_oficial: "", diferenca: "", observacao: "",
      },
    ],
  },
  { nome: "Calculo_Por_Pedido", colunas: colsCalc, linhas: a.linhasPedido },
  {
    nome: "Calculo_Por_Dia",
    colunas: ["dia", "pedidos", "unidades", "paid_amount", "total_amount"],
    linhas: porDia,
  },
  { nome: "Incluidos", colunas: colsCalc, linhas: incluidos },
  { nome: "Excluidos", colunas: colsCalc, linhas: excluidos },
  { nome: "Multiplos_Pagamentos", colunas: colsCalc, linhas: comExcecao("multiplos_pagamentos") },
  { nome: "Reembolsos_Parciais", colunas: colsCalc, linhas: comExcecao("estorno_parcial") },
  { nome: "Reembolsos_Totais", colunas: colsCalc, linhas: comExcecao("estorno_total") },
  { nome: "Cancelados_Pos_Pagamento", colunas: colsCalc, linhas: comExcecao("cancelado:") },
  { nome: "Paid_vs_Total", colunas: colsCalc, linhas: comExcecao("paid!=total") },
  { nome: "Virada_de_Mes", colunas: colsCalc, linhas: comExcecao("virada_de_mes_por_fuso") },
  { nome: "Chargeback", colunas: colsCalc, linhas: comExcecao("chargeback") },
  { nome: "Mediacao", colunas: colsCalc, linhas: comExcecao("mediacao") },
  {
    nome: "Pedidos_Suspeitos", colunas: ["impacto", ...colsCalc], linhas: suspeitos,
  },
  {
    nome: "Diferencas_Candidatos",
    colunas: ["data", "populacao", "campo_de_valor", "total", "pedidos", "unidades",
      "medio_por_venda", "medio_por_unidade", "vs_painel_valor", "vs_painel_pedidos",
      "vs_painel_unidades", "indicadores_que_bate"],
    linhas: a.notas
      .map((x) => ({
        data: x.data, populacao: x.populacao, campo_de_valor: x.valor,
        total: Number(x.total.toFixed(2)), pedidos: x.pedidos, unidades: x.unidades,
        medio_por_venda: x.pedidos === 0 ? 0 : Number((x.total / x.pedidos).toFixed(2)),
        medio_por_unidade: x.unidades === 0 ? 0 : Number((x.total / x.unidades).toFixed(2)),
        vs_painel_valor: Number((a.painel.vendasBrutasExibido - x.total).toFixed(2)),
        vs_painel_pedidos: a.painel.quantidadeDeVendas - x.pedidos,
        vs_painel_unidades: a.painel.unidadesVendidas - x.unidades,
        indicadores_que_bate: `${x.nota}/5`,
      }))
      .sort((x, y) => Number(y.indicadores_que_bate.split("/")[0]) -
        Number(x.indicadores_que_bate.split("/")[0]) ||
        Math.abs(x.vs_painel_valor) - Math.abs(y.vs_painel_valor)),
  },
]);

// ═══════════════════════════════════════════════════════════════════
// ARTEFATO 3 — RECONCILIACAO_ML_SETEMBRO_2026.xlsx
// ═══════════════════════════════════════════════════════════════════

const d = a.decomposicao;

const r3 = escreverXlsx(join(SAIDA, "RECONCILIACAO_ML_SETEMBRO_2026.xlsx"), [
  {
    nome: "Painel_Oficial",
    colunas: ["metrica", "valor_exibido", "observacao"],
    linhas: [
      { metrica: "Periodo", valor_exibido: "01/09/2026 a 30/09/2026", observacao: "Metricas > Negocio > Visao geral" },
      { metrica: "Vendas brutas", valor_exibido: "R$ 393.839", observacao: "painel exibido SEM centavos — centavos DESCONHECIDOS" },
      { metrica: "Quantidade de vendas", valor_exibido: 10898, observacao: "" },
      { metrica: "Unidades vendidas", valor_exibido: 11361, observacao: "" },
      { metrica: "Preco medio por venda", valor_exibido: "R$ 36,14", observacao: "393.839 / 10.898 = 36,139... confere" },
      { metrica: "Preco medio por unidade", valor_exibido: "R$ 34,67", observacao: "393.839 / 11.361 = 34,666... confere" },
      { metrica: "Vendas canceladas", valor_exibido: 414, observacao: "NAO reproduzido por nenhum critério da API — ver aba Metricas_Cruzadas" },
      { metrica: "", valor_exibido: "", observacao: "" },
      { metrica: "ATENCAO", valor_exibido: "'Vendas brutas' e 'Faturamento (pagos)' podem nao ser a mesma metrica", observacao: "esta e uma das perguntas abertas do gate" },
      { metrica: "ATENCAO", valor_exibido: "nenhuma formula aqui foi escolhida por chegar perto de 393.839", observacao: "a ancora valida; nao define a regra" },
    ],
  },
  {
    nome: "Totais_Candidatos",
    colunas: ["data", "populacao", "campo_de_valor", "total", "pedidos", "unidades",
      "medio_por_venda", "medio_por_unidade", "vs_painel", "indicadores_que_bate"],
    linhas: a.notas
      .map((x) => ({
        data: x.data, populacao: x.populacao, campo_de_valor: x.valor,
        total: Number(x.total.toFixed(2)), pedidos: x.pedidos, unidades: x.unidades,
        medio_por_venda: x.pedidos === 0 ? 0 : Number((x.total / x.pedidos).toFixed(2)),
        medio_por_unidade: x.unidades === 0 ? 0 : Number((x.total / x.unidades).toFixed(2)),
        vs_painel: Number((a.painel.vendasBrutasExibido - x.total).toFixed(2)),
        indicadores_que_bate: x.nota,
      }))
      .sort((x, y) => y.indicadores_que_bate - x.indicadores_que_bate ||
        Math.abs(x.vs_painel) - Math.abs(y.vs_painel)),
  },
  {
    nome: "Metricas_Cruzadas",
    colunas: ["indicador", "painel", "regra_de_hoje", "candidata_mais_proxima", "veredito"],
    linhas: [
      {
        indicador: "Vendas brutas (R$)", painel: 393839,
        regra_de_hoje: Number(a.regraAtual.total.toFixed(2)),
        candidata_mais_proxima: Number(d.melhor.total.toFixed(2)),
        veredito: `faltam R$ ${d.naoExplicado.toFixed(2)}`,
      },
      {
        indicador: "Quantidade de vendas", painel: 10898,
        regra_de_hoje: a.regraAtual.pedidos, candidata_mais_proxima: d.melhor.pedidos,
        veredito: `faltam ${d.residuoPedidos}`,
      },
      {
        indicador: "Unidades vendidas", painel: 11361,
        regra_de_hoje: a.regraAtual.unidades, candidata_mais_proxima: d.melhor.unidades,
        veredito: `faltam ${d.residuoUnidades}`,
      },
      {
        indicador: "Preco medio por venda", painel: 36.14,
        regra_de_hoje: Number(a.regraAtual.medioPorVenda.toFixed(2)),
        candidata_mais_proxima: Number(d.melhor.medioPorVenda.toFixed(2)),
        veredito: Math.abs(d.melhor.medioPorVenda - 36.14) <= 0.005 ? "BATE EXATO" : "difere",
      },
      {
        indicador: "Preco medio por unidade", painel: 34.67,
        regra_de_hoje: Number(a.regraAtual.medioPorUnidade.toFixed(2)),
        candidata_mais_proxima: Number(d.melhor.medioPorUnidade.toFixed(2)),
        veredito: Math.abs(d.melhor.medioPorUnidade - 34.67) <= 0.005 ? "BATE EXATO" : "difere",
      },
      ...a.canceladasPor.map((c) => ({
        indicador: `Canceladas — ${c.criterio}`, painel: 414,
        regra_de_hoje: "", candidata_mais_proxima: c.n,
        veredito: c.n === 414 ? "BATE" : `difere em ${414 - c.n}`,
      })),
    ],
  },
  {
    nome: "Categorias_Divergencia",
    colunas: ["passo", "o_que_muda", "total_depois", "pedidos_depois", "unidades_depois",
      "delta_valor", "delta_pedidos"],
    linhas: d.passos.map((p) => ({
      passo: p.nome.split(".")[0],
      o_que_muda: p.nome.replace(/^\d+\.\s*/, ""),
      total_depois: Number(p.total.toFixed(2)),
      pedidos_depois: p.pedidos, unidades_depois: p.unidades,
      delta_valor: Number(p.deltaValor.toFixed(2)), delta_pedidos: p.deltaPedidos,
    })).concat([
      {
        passo: "=", o_que_muda: "DIVERGENCIA INICIAL (painel - regra de hoje)",
        total_depois: "", pedidos_depois: "", unidades_depois: "",
        delta_valor: Number(d.divergenciaInicial.toFixed(2)), delta_pedidos: "",
      },
      {
        passo: "=", o_que_muda: "EXPLICADO pelos passos acima",
        total_depois: "", pedidos_depois: "", unidades_depois: "",
        delta_valor: Number(d.explicado.toFixed(2)), delta_pedidos: "",
      },
      {
        passo: "=", o_que_muda: "NAO EXPLICADO",
        total_depois: "", pedidos_depois: "", unidades_depois: "",
        delta_valor: Number(d.naoExplicado.toFixed(2)), delta_pedidos: d.residuoPedidos,
      },
    ]),
  },
  {
    nome: "Pedidos_Maior_Impacto",
    colunas: ["impacto", "order_id", "status_pedido", "dia_criacao_escrito", "dia_pagamento_brt",
      "total_amount", "paid_amount", "soma_gross_price", "estornado",
      "agente_incluiu", "candidata_incluiu", "excecoes"],
    linhas: suspeitos.map((s) => ({
      impacto: Number(s.impacto.toFixed(2)), order_id: s.order_id,
      status_pedido: s.status_pedido, dia_criacao_escrito: s.dia_criacao_escrito,
      dia_pagamento_brt: s.dia_pagamento_brt, total_amount: s.total_amount,
      paid_amount: s.paid_amount, soma_gross_price: Number(s.soma_gross_price.toFixed(2)),
      estornado: s.estornado, agente_incluiu: s.agente_incluiu,
      candidata_incluiu: s.candidata_incluiu, excecoes: s.excecoes,
    })),
  },
  {
    nome: "Checklist_Para_Rodrigo",
    colunas: ["ordem", "o_que_conferir", "onde", "por_que"],
    linhas: [
      { ordem: 1, o_que_conferir: "Os dois precos medios do painel (36,14 e 34,67) batem EXATO com a candidata",
        onde: "aba Metricas_Cruzadas", por_que: "sao dois controles independentes; bater nos dois por acaso e improvavel" },
      { ordem: 2, o_que_conferir: "A troca de campo: paid_amount x total_amount x gross_price",
        onde: "ML_API_RAW / aba Campos_Medidos e Order_Items", por_que: "sao tres campos diferentes; o agente usa paid_amount" },
      { ordem: 3, o_que_conferir: "Os 134 pedidos cancelados como `internal / pack_splitted`",
        onde: "AGENTE_CALCULO / aba Cancelados_Pos_Pagamento, filtrar cancel_code", por_que: "o proprio ML desfez e recriou o pedido; contar os dois contaria a venda duas vezes" },
      { ordem: 4, o_que_conferir: "Os pedidos da virada do mes (datas 31/08 23h e 30/09 23h)",
        onde: "AGENTE_CALCULO / aba Virada_de_Mes", por_que: "a API devolve as datas em -04:00 e a CDS converte para -03:00; 14 pedidos mudam de mes" },
      { ordem: 5, o_que_conferir: "Confirmar no painel do ML se 'Vendas brutas' conta pedido cancelado",
        onde: "painel do Mercado Livre", por_que: "a candidata que mais explica INCLUI cancelados; a regra de hoje exclui" },
      { ordem: 6, o_que_conferir: "Baixar o relatorio oficial de setembro no ML (Gerar relatorios)",
        onde: "painel do Mercado Livre", por_que: "com order_id por linha, a reconciliacao vira exata e os R$ 81,00 restantes se resolvem" },
      { ordem: 7, o_que_conferir: "Os 414 cancelados do painel — nenhum critério da API reproduziu",
        onde: "aba Metricas_Cruzadas, linhas 'Canceladas'", por_que: "a definicao do painel nao esta disponivel pela API; segue ABERTO" },
      { ordem: 8, o_que_conferir: "NADA foi alterado na regra financeira do agente",
        onde: "—", por_que: "o gate pede investigacao primeiro; a decisao de regra e sua" },
    ],
  },
]);

console.log("planilhas geradas em", SAIDA);
console.log("  ML_API_RAW_SETEMBRO_2026.xlsx       ", r1.abas, "abas", (r1.bytes / 1024 / 1024).toFixed(2), "MB");
console.log("  AGENTE_CALCULO_SETEMBRO_2026.xlsx   ", r2.abas, "abas", (r2.bytes / 1024 / 1024).toFixed(2), "MB");
console.log("  RECONCILIACAO_ML_SETEMBRO_2026.xlsx ", r3.abas, "abas", (r3.bytes / 1024 / 1024).toFixed(2), "MB");
console.log("  linhas: orders", orders.length, "| payments", a.linhasPagamento.length,
  "| itens", itens.length, "| calculo", a.linhasPedido.length);
