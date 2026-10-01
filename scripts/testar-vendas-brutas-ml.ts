/**
 * AGENT-FACTORY-F7b.4.8.5 §10/§11/§12 — a regra de VENDAS BRUTAS.
 *
 * Suite PURA: sem rede, sem banco, sem IA. O provedor e um duble, e os
 * casos foram desenhados sobre o que a pericia do F7b.4.8.4 mediu.
 *
 * ── O que ela impede de voltar ──────────────────────────────────────
 *
 * A regra antiga somava `paid_amount` dos pagamentos aprovados e recortava
 * por data de pagamento. Em setembro de 2026 isso deu R$ 383.829,43 contra
 * R$ 393.838,47 do relatorio oficial da loja: dez mil reais e 568 vendas a
 * menos, porque venda cancelada depois tem `paid_amount` zero — e continua
 * sendo venda do mes em que fechou.
 *
 * Os dois pedidos reais do §11 entram como regressao, e os ids NAO moram
 * na regra: eles sao fixture, e o que a regra conhece e o fuso.
 *
 * Roda com: npx tsx scripts/testar-vendas-brutas-ml.ts
 */
import "./_server-only-inerte";

import {
  buscarVendasBrutasML, buscarVendasPagasML, CAMPO_DE_FECHAMENTO,
  CANCELAMENTO_DE_PACOTE_REFEITO, MARGEM_CRIACAO_DIAS,
} from "../lib/mercado-livre-vendas";
import {
  diaEmSaoPaulo, fimDoDiaEmSaoPaulo, inicioDoDiaEmSaoPaulo, minutoEmSaoPaulo,
} from "../lib/fuso-sao-paulo";

const DE = "2026-09-01";
const ATE = "2026-09-30";

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

interface ItemDuble {
  readonly quantity: number;
  readonly unit_price: number;
}
interface PedidoDuble {
  readonly id: number;
  readonly status?: string;
  readonly date_closed: string;
  readonly date_created?: string;
  readonly total_amount: number;
  readonly paid_amount?: number;
  readonly cancel_code?: string;
  readonly cancel_group?: string;
  readonly itens?: readonly ItemDuble[];
  readonly pagamentos?: readonly { status: string; date_approved: string | null }[];
}

/** O payload como a API devolve, montado a partir do caso do teste. */
function comoAApiDevolve(p: PedidoDuble): Record<string, unknown> {
  const itens = p.itens ?? [{ quantity: 1, unit_price: p.total_amount }];
  return {
    id: p.id,
    status: p.status ?? "paid",
    date_created: p.date_created ?? p.date_closed,
    date_closed: p.date_closed,
    total_amount: p.total_amount,
    paid_amount: p.paid_amount ?? p.total_amount,
    cancel_detail: p.cancel_code === undefined ? null
      : { group: p.cancel_group ?? "buyer", code: p.cancel_code },
    order_items: itens.map((it) => ({
      quantity: it.quantity, unit_price: it.unit_price,
      gross_price: it.unit_price * it.quantity,
    })),
    payments: p.pagamentos ?? [
      { status: "approved", date_approved: p.date_closed, transaction_amount: p.total_amount },
    ],
  };
}

/**
 * Um provedor de mentira que responde por DIA pedido.
 *
 * Ele le o filtro da URL e devolve os pedidos cujo campo cai naquele dia,
 * como o provedor de verdade faz. `paging.total` acompanha, senao a
 * varredura marcaria o dia como incompleto e nao haveria total.
 */
function duble(
  pedidos: readonly PedidoDuble[],
  campoEsperado = CAMPO_DE_FECHAMENTO,
  /**
   * Devolve tambem pedidos do dia SEGUINTE, como a API real faz.
   *
   * MEDIDO (`medir-ml-fuso-da-janela.ts`): uma janela terminando as
   * 23:59:59.999 devolveu pedidos exibidos como do dia seguinte. Um duble
   * exato esconderia esse comportamento, e com ele esconderia o motivo de
   * o recorte local existir.
   */
  vazaBorda = false
) {
  const urls: string[] = [];
  const buscar: typeof fetch = async (entrada) => {
    const url = new URL(String(entrada));
    urls.push(String(entrada));
    const de = url.searchParams.get(`${campoEsperado}.from`) ?? "";
    const ate = url.searchParams.get(`${campoEsperado}.to`) ?? "";
    const offset = Number(url.searchParams.get("offset") ?? "0");
    const inicio = new Date(de).getTime();
    const fim = new Date(ate).getTime();
    const instanteDe = (p: PedidoDuble): number => new Date(
      campoEsperado === CAMPO_DE_FECHAMENTO ? p.date_closed
        : (p.date_created ?? p.date_closed)).getTime();
    // Uma hora de folga no fim quando o duble imita o vazamento medido.
    const limite = vazaBorda ? fim + 3600_000 : fim;
    const doDia = pedidos.filter((p) => {
      const t = instanteDe(p);
      return Number.isFinite(t) && t >= inicio && t <= limite;
    });
    const lote = doDia.slice(offset, offset + 51).map(comoAApiDevolve);
    return new Response(JSON.stringify({ paging: { total: doDia.length }, results: lote }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  };
  return { buscar, urls };
}

const PORTAS_BASE = { resolverCredencial: async () => CREDENCIAL };

async function brutas(
  pedidos: readonly PedidoDuble[], de = DE, ate = ATE, vazaBorda = false
) {
  const d = duble(pedidos, CAMPO_DE_FECHAMENTO, vazaBorda);
  const r = await buscarVendasBrutasML(
    { userId: "dono", lojaId: "loja", de, ate },
    undefined, { ...PORTAS_BASE, buscar: d.buscar });
  return { ...r, urls: d.urls };
}

async function main(): Promise<void> {
  console.log("══ F7b.4.8.5 — vendas brutas do Mercado Livre ══");

  // ═══ 0. O fuso, por Intl e nao por -3h ════════════════════════════

  secao("0. O fuso e de verdade (§5)");
  ok("0a  31/08 23:33 em -04:00 e 01/09 em Sao Paulo",
    diaEmSaoPaulo("2026-08-31T23:33:10.000-04:00") === "2026-09-01",
    String(diaEmSaoPaulo("2026-08-31T23:33:10.000-04:00")));
  ok("0b  e ao minuto, 00:33",
    minutoEmSaoPaulo("2026-08-31T23:33:10.000-04:00") === "2026-09-01 00:33",
    String(minutoEmSaoPaulo("2026-08-31T23:33:10.000-04:00")));
  ok("0c  30/09 23:41 em -04:00 e 01/10 em Sao Paulo",
    diaEmSaoPaulo("2026-09-30T23:41:33.000-04:00") === "2026-10-01",
    String(diaEmSaoPaulo("2026-09-30T23:41:33.000-04:00")));
  ok("0d  o mesmo instante em UTC da o mesmo dia",
    diaEmSaoPaulo("2026-09-01T03:33:10.000Z") === "2026-09-01");
  ok("0e  e em -03:00 tambem — o que decide e o INSTANTE",
    diaEmSaoPaulo("2026-09-01T00:33:10.000-03:00") === "2026-09-01");
  ok("0f  data impossivel nao vira dia", diaEmSaoPaulo("ontem") === null &&
    diaEmSaoPaulo(null) === null && diaEmSaoPaulo(42) === null);
  // As fronteiras do filtro saem do fuso real, com o offset daquele dia.
  ok("0g  o inicio do dia carrega o offset vigente",
    inicioDoDiaEmSaoPaulo("2026-09-15") === "2026-09-15T00:00:00.000-03:00",
    String(inicioDoDiaEmSaoPaulo("2026-09-15")));
  ok("0h  e o fim do dia tambem",
    fimDoDiaEmSaoPaulo("2026-09-15") === "2026-09-15T23:59:59.999-03:00",
    String(fimDoDiaEmSaoPaulo("2026-09-15")));
  ok("0i  §5: nenhum `-3` fixo decide periodo — o modulo usa Intl",
    /Intl\.DateTimeFormat/.test(
      require("node:fs").readFileSync(
        require("node:path").join(__dirname, "..", "lib", "fuso-sao-paulo.ts"), "utf8")));

  // ═══ A. Pedido pago normal ════════════════════════════════════════

  secao("A. Pedido pago normal (§10.A)");
  {
    const r = await brutas([{
      id: 1, date_closed: "2026-09-10T14:00:00.000-04:00", total_amount: 41.24,
    }]);
    ok("A1  entra", r.pedidos.length === 1, String(r.pedidos.length));
    ok("A2  com o valor de `total_amount`",
      Math.abs(r.pedidos[0]?.valor - 41.24) < 0.005, String(r.pedidos[0]?.valor));
    ok("A3  no dia de fechamento em Sao Paulo",
      r.pedidos[0]?.diaFechamento === "2026-09-10", String(r.pedidos[0]?.diaFechamento));
    ok("A4  e a varredura se declara completa", r.completo === true && r.erro === null);
    ok("A5  §5: a URL filtrou por `order.date_closed`",
      r.urls.every((u) => u.includes("order.date_closed.from")), r.urls[0]?.slice(0, 120));
    ok("A6  §6: e NAO mandou `order.status`",
      r.urls.every((u) => !u.includes("order.status")));
  }

  // ═══ B/C/H. Cancelado, estornado, `paid_amount` zerado ════════════

  secao("B/C/H. Cancelado e estornado CONTINUAM sendo venda (§10.B/C/H)");
  {
    const cancelado: PedidoDuble = {
      id: 2, date_closed: "2026-09-11T10:00:00.000-04:00",
      status: "cancelled", cancel_group: "buyer", cancel_code: "buyer_cancel_express",
      total_amount: 53.8, paid_amount: 0,
      itens: [{ quantity: 2, unit_price: 26.9 }],
      pagamentos: [{ status: "refunded", date_approved: "2026-09-11T10:05:00.000-04:00" }],
    };
    const r = await brutas([cancelado]);
    ok("B1  pedido cancelado depois ENTRA", r.pedidos.length === 1);
    ok("C1  e o valor usado e `total_amount`, nao o estorno",
      Math.abs(r.pedidos[0]?.valor - 53.8) < 0.005, String(r.pedidos[0]?.valor));
    ok("H1  §10.H: `paid_amount` zero NAO zera a venda",
      r.pedidos[0]?.valor !== 0);
    ok("B2  as unidades vem dos itens", r.pedidos[0]?.unidades === 2,
      String(r.pedidos[0]?.unidades));
    ok("B3  e o status viaja, para a resposta poder explicar",
      r.pedidos[0]?.status === "cancelled" &&
      r.pedidos[0]?.cancelCode === "buyer_cancel_express");

    // CONTROLE: a regra ANTIGA, de pagamento, perde este pedido — e essa
    // perda e exatamente o defeito que o gate corrigiu.
    const d = duble([cancelado], "order.date_created");
    const antiga = await buscarVendasPagasML(
      { userId: "dono", lojaId: "loja", de: DE, ate: ATE },
      undefined, { ...PORTAS_BASE, buscar: d.buscar });
    ok("B4  CONTROLE: a regra de PAGAMENTO deixa este pedido de fora",
      antiga.pedidos.length === 0, String(antiga.pedidos.length));
    ok("B5  e ela continua existindo — pagamento nao virou lixo (§3)",
      antiga.erro === null && typeof MARGEM_CRIACAO_DIAS === "number");
  }

  // ═══ D/J. `pack_splitted` fica fora ═══════════════════════════════

  secao("D/J. pack_splitted fora, e so ele (§10.D/J)");
  {
    const r = await brutas([
      {
        id: 3, date_closed: "2026-09-12T10:00:00.000-04:00", total_amount: 32.9,
        status: "cancelled", cancel_group: "internal",
        cancel_code: CANCELAMENTO_DE_PACOTE_REFEITO,
      },
      { id: 4, date_closed: "2026-09-12T11:00:00.000-04:00", total_amount: 41.24 },
    ]);
    ok("D1  o pack_splitted NAO entra", r.pedidos.length === 1 &&
      r.pedidos[0]?.pedidoId === "4", r.pedidos.map((p) => p.pedidoId).join(","));
    ok("D2  e a exclusao e CONTADA", r.excluidosPackSplitted === 1,
      String(r.excluidosPackSplitted));
    ok("D3  o total soma so o que entrou",
      Math.abs(r.pedidos.reduce((a, p) => a + p.valor, 0) - 41.24) < 0.005);

    // §10.J: outro cancelamento interno NAO e excluido por tabela.
    const outro = await brutas([{
      id: 5, date_closed: "2026-09-12T10:00:00.000-04:00", total_amount: 20,
      status: "cancelled", cancel_group: "internal", cancel_code: "pack_creation_error",
    }]);
    ok("J1  §10.J: `pack_creation_error` NAO e excluido — a regra e por codigo",
      outro.pedidos.length === 1, String(outro.pedidos.length));
    const comercial = await brutas([{
      id: 6, date_closed: "2026-09-12T10:00:00.000-04:00", total_amount: 25,
      status: "cancelled", cancel_group: "shipment", cancel_code: "shipment_not_delivered",
    }]);
    ok("J2  e cancelamento de ENVIO tambem entra", comercial.pedidos.length === 1);
    ok("J3  ANCORA: a exclusao usa o codigo medido, e nao `status`",
      CANCELAMENTO_DE_PACOTE_REFEITO === "pack_splitted");
  }

  // ═══ E/F. As duas bordas do mes ═══════════════════════════════════

  secao("E/F. Virada de mes pelo fuso (§10.E/F)");
  {
    const r = await brutas([
      // ENTRA: 31/08 23:33 em -04:00 e 01/09 00:33 em Sao Paulo.
      {
        id: 7, date_closed: "2026-08-31T23:33:10.000-04:00", total_amount: 53.8,
        status: "cancelled", cancel_code: "buyer_cancel_express", paid_amount: 0,
        itens: [{ quantity: 2, unit_price: 26.9 }],
      },
      // SAI: 30/09 23:41 em -04:00 e 01/10 em Sao Paulo.
      { id: 8, date_closed: "2026-09-30T23:41:33.000-04:00", total_amount: 24.2 },
      // Controle no meio do mes.
      { id: 9, date_closed: "2026-09-15T12:00:00.000-04:00", total_amount: 10 },
    ], DE, ATE, true);
    const ids = r.pedidos.map((p) => p.pedidoId);
    ok("E1  o de 31/08 23:33 (-04) ENTRA em setembro", ids.includes("7"), ids.join(","));
    ok("E2  com o dia de Sao Paulo, 01/09",
      r.pedidos.find((p) => p.pedidoId === "7")?.diaFechamento === "2026-09-01");
    ok("F1  o de 30/09 23:41 (-04) NAO entra — e 01/10 em Sao Paulo",
      !ids.includes("8"), ids.join(","));
    ok("F2  o provedor o DEVOLVEU (vazamento de borda) e o recorte local o descartou",
      r.foraDoPeriodo >= 1, String(r.foraDoPeriodo));
    ok("F2a CONTROLE: sem vazamento, nao ha o que descartar",
      (await brutas([
        { id: 8, date_closed: "2026-09-30T23:41:33.000-04:00", total_amount: 24.2 },
      ])).foraDoPeriodo === 0);
    ok("E3  o do meio do mes fica", ids.includes("9"));
    ok("E4  o total e so dos dois que entram",
      Math.abs(r.pedidos.reduce((a, p) => a + p.valor, 0) - 63.8) < 0.005,
      String(r.pedidos.reduce((a, p) => a + p.valor, 0)));
    ok("E5  e as unidades acompanham",
      r.pedidos.reduce((a, p) => a + p.unidades, 0) === 3,
      String(r.pedidos.reduce((a, p) => a + p.unidades, 0)));
  }

  // ═══ G. `paid_amount` diferente de `total_amount` ═════════════════

  secao("G. paid_amount diferente de total_amount (§10.G)");
  {
    const r = await brutas([{
      id: 10, date_closed: "2026-09-14T10:00:00.000-04:00",
      total_amount: 20.8, paid_amount: 30.79,
    }]);
    ok("G1  usa `total_amount`, e nao `paid_amount`",
      Math.abs(r.pedidos[0]?.valor - 20.8) < 0.005, String(r.pedidos[0]?.valor));
    const total = r.pedidos[0]?.valor ?? 0;
    const pago = 30.79;
    ok("G2  ANCORA: os dois valores sao de fato diferentes no caso",
      Math.abs(total - pago) > 0.005, `${total} vs ${pago}`);
  }

  // ═══ I. Varios itens ══════════════════════════════════════════════

  secao("I. Varios itens (§10.I)");
  {
    const r = await brutas([{
      id: 11, date_closed: "2026-09-16T10:00:00.000-04:00", total_amount: 80,
      itens: [{ quantity: 2, unit_price: 25 }, { quantity: 3, unit_price: 10 }],
    }]);
    ok("I1  unidades e a SOMA das quantidades", r.pedidos[0]?.unidades === 5,
      String(r.pedidos[0]?.unidades));
    ok("I2  e nao a contagem de pedidos", r.pedidos.length === 1);
    ok("I3  §7: `soma(unit_price x qtd)` e guardado como invariante",
      Math.abs(r.pedidos[0]?.valorPorItens - 80) < 0.005,
      String(r.pedidos[0]?.valorPorItens));
    ok("I4  e sem divergencia quando os dois batem",
      r.divergenciasDeValor === 0, String(r.divergenciasDeValor));

    // §7: divergindo, o valor NAO e trocado em silencio — ela e contada.
    const divergente = await brutas([{
      id: 12, date_closed: "2026-09-16T10:00:00.000-04:00", total_amount: 99,
      itens: [{ quantity: 2, unit_price: 25 }],
    }]);
    ok("I5  §7: divergencia e CONTADA", divergente.divergenciasDeValor === 1,
      String(divergente.divergenciasDeValor));
    ok("I6  e o valor apresentado continua sendo `total_amount`",
      Math.abs(divergente.pedidos[0]?.valor - 99) < 0.005,
      String(divergente.pedidos[0]?.valor));
  }

  // ═══ 11. Os dois pedidos REAIS ════════════════════════════════════

  secao("11. Os dois pedidos reais do §11");
  {
    // Fixture com os valores medidos na loja real. Os ids NAO estao na
    // regra: eles sao caso de teste, e o que a regra sabe e o fuso.
    const reais: PedidoDuble[] = [
      {
        id: 2000018219592150, date_closed: "2026-08-31T23:33:10.000-04:00",
        date_created: "2026-08-31T23:32:27.000-04:00",
        total_amount: 53.8, paid_amount: 0, status: "cancelled",
        cancel_group: "buyer", cancel_code: "buyer_cancel_express",
        itens: [{ quantity: 2, unit_price: 26.9 }],
        pagamentos: [{ status: "refunded", date_approved: "2026-08-31T23:34:00.000-04:00" }],
      },
      {
        id: 2000018219744892, date_closed: "2026-08-31T23:48:12.000-04:00",
        date_created: "2026-08-31T23:47:31.000-04:00",
        total_amount: 26.9, paid_amount: 0, status: "cancelled",
        cancel_group: "buyer", cancel_code: "buyer_cancel_express",
        itens: [{ quantity: 1, unit_price: 26.9 }],
        pagamentos: [{ status: "refunded", date_approved: "2026-08-31T23:49:00.000-04:00" }],
      },
    ];
    const r = await brutas(reais);
    ok("11a os DOIS entram em setembro", r.pedidos.length === 2,
      r.pedidos.map((p) => p.pedidoId).join(","));
    ok("11b somando R$ 80,70",
      Math.abs(r.pedidos.reduce((a, p) => a + p.valor, 0) - 80.7) < 0.005,
      String(r.pedidos.reduce((a, p) => a + p.valor, 0)));
    ok("11c e 3 unidades", r.pedidos.reduce((a, p) => a + p.unidades, 0) === 3,
      String(r.pedidos.reduce((a, p) => a + p.unidades, 0)));
    ok("11d cada um no dia 01/09 em Sao Paulo",
      r.pedidos.every((p) => p.diaFechamento === "2026-09-01"));

    // CONTROLE: a regra antiga perde os dois.
    const d = duble(reais, "order.date_created");
    const antiga = await buscarVendasPagasML(
      { userId: "dono", lojaId: "loja", de: DE, ate: ATE },
      undefined, { ...PORTAS_BASE, buscar: d.buscar });
    ok("11e CONTROLE: a regra antiga perdia os dois",
      antiga.pedidos.length === 0, String(antiga.pedidos.length));
    ok("11f §11: e os ids NAO aparecem no codigo de producao",
      !["2000018219592150", "2000018219744892"].some((id) =>
        require("node:fs").readFileSync(
          require("node:path").join(__dirname, "..", "lib", "mercado-livre-vendas.ts"),
          "utf8").includes(id)));
  }

  // ═══ 12. A camada de dados entrega o contrato ═════════════════════

  secao("12. O contrato que chega ao modelo (§4)");
  {
    const { criarLeiturasDeVendasML } = await import("../lib/agentes/dados/vendas-ml");
    const d = duble([
      { id: 20, date_closed: "2026-09-05T10:00:00.000-04:00", total_amount: 100,
        itens: [{ quantity: 2, unit_price: 50 }] },
      { id: 21, date_closed: "2026-09-06T10:00:00.000-04:00", total_amount: 50 },
    ]);
    const ler = criarLeiturasDeVendasML(
      "dono", "loja", Date.UTC(2026, 9, 1, 15), undefined,
      { ...PORTAS_BASE, buscar: d.buscar });
    const r = await ler({ periodo: "setembro de 2026" });
    ok("12a o periodo veio da CDS", r.periodo.de === "2026-09-01" && r.periodo.ate === "2026-09-30",
      `${r.periodo.de}..${r.periodo.ate}`);
    ok("12b ha `vendasBrutas`, e nao `totais`",
      r.vendasBrutas !== null && !("totais" in r));
    ok("12c com valor, vendas e unidades",
      r.vendasBrutas?.valor === 150 && r.vendasBrutas?.vendas === 2 &&
      r.vendasBrutas?.unidades === 3,
      JSON.stringify(r.vendasBrutas));
    ok("12d o ticket medio e derivado",
      Math.abs((r.vendasBrutas?.ticketMedio ?? 0) - 75) < 0.005);
    ok("12e a quebra por dia traz valor, vendas e unidades",
      r.porDia.length === 2 && r.porDia[0]?.vendas === 1 && r.porDia[0]?.unidades === 2,
      JSON.stringify(r.porDia));
    ok("12f e o diagnostico diz qual campo recortou",
      r.diagnostico.campoDeData === CAMPO_DE_FECHAMENTO, r.diagnostico.campoDeData);
    ok("12g a fonte continua sendo a API oficial", r.fonte === "mercadolivre_api");
  }

  // ═══ 13. A Function valida a forma nova ══════════════════════════

  secao("13. A Function reconhece a saida nova");
  {
    const { interpretarSaidaVendasML } = await import(
      "../lib/agentes/funcoes/mercadolivre-vendas");
    const boa = {
      vendasBrutas: { valor: 150, vendas: 2, unidades: 3, ticketMedio: 75 },
      porDia: [], periodo: { de: DE, ate: ATE, rotulo: "setembro", fuso: "America/Sao_Paulo" },
      fonte: "mercadolivre_api", completo: true, truncado: false, parcial: null,
      diagnostico: {}, erro: null,
    };
    const i = interpretarSaidaVendasML(boa);
    ok("13a saida valida e sucesso", i.tipo === "sucesso", i.tipo);
    ok("13b e `vendasBrutas` atravessa para o modelo",
      i.tipo === "sucesso" &&
      (i.data as { vendasBrutas?: unknown }).vendasBrutas !== undefined);
    ok("13c completo SEM numeros e invalido",
      interpretarSaidaVendasML({ ...boa, vendasBrutas: null }).tipo === "invalida");
    ok("13d e `vendas` fracionada e invalida — contagem e inteiro",
      interpretarSaidaVendasML({
        ...boa, vendasBrutas: { valor: 150, vendas: 2.5, unidades: 3, ticketMedio: 75 },
      }).tipo === "invalida");
    ok("13e `unidades` negativa tambem",
      interpretarSaidaVendasML({
        ...boa, vendasBrutas: { valor: 150, vendas: 2, unidades: -1, ticketMedio: 75 },
      }).tipo === "invalida");
    ok("13f incompleto COM numeros e invalido",
      interpretarSaidaVendasML({ ...boa, completo: false, truncado: true }).tipo === "invalida");
  }

  console.log(`\nPASS ${pass}   FAIL ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
