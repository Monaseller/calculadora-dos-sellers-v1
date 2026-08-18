/**
 * scripts/testar-camada-financeira-shopee.ts
 *
 * Suite standalone da camada financeira Shopee (2026-08-18).
 * Nao chama IA, rede nem banco — lib/shopee-financeiro.ts e pura.
 *
 *   npx tsx scripts/testar-camada-financeira-shopee.ts
 *
 * Os numeros usados vem de pedidos REAIS do checkpoint de 04/07/2026 auditado,
 * nao de valores inventados.
 */
import {
  ELEGIVEIS_FINANCEIRO,
  FINANCIAL_SOURCE,
  FINANCIAL_VERSION,
  ehElegivelParaFinanceiro,
  extrairCamposFinanceiros,
  montarSnapshotsFinanceirosDoPedido,
  pesosDoPedido,
  ratearCentavos,
  round2,
  ehCancelamentoOuDevolucao,
} from "../lib/shopee-financeiro";

/** Atalho: snapshot de um pedido de UMA linha (o caso mais comum). */
const snapUm = (campos: any, agora: string) =>
  montarSnapshotsFinanceirosDoPedido(campos, [{ id: "L1", item_subtotal: 1 }], agora)[0];
/** Atalho: snapshots de um pedido com os subtotais dados. */
const snapN = (campos: any, subtotais: number[], agora = "2026-08-18T12:00:00.000Z") =>
  montarSnapshotsFinanceirosDoPedido(
    campos, subtotais.map((s, i) => ({ id: `L${String(i).padStart(3, "0")}`, item_subtotal: s })), agora);

let passou = 0, falhou = 0;
const falhas: string[] = [];
function ok(nome: string, cond: boolean, det = "") {
  if (cond) { passou++; console.log(`  PASS  ${nome}`); }
  else { falhou++; falhas.push(nome); console.log(`  FALHA ${nome}${det ? `  -> ${det}` : ""}`); }
}
function eq(nome: string, real: unknown, esp: unknown) {
  ok(nome, JSON.stringify(real) === JSON.stringify(esp), `recebido ${JSON.stringify(real)}, esperado ${JSON.stringify(esp)}`);
}
const AGORA = "2026-08-18T12:00:00.000Z";

console.log("\n=== A. elegibilidade ===\n");
eq("1. lista de elegiveis e exatamente COMPLETED e CANCELLED", [...ELEGIVEIS_FINANCEIRO], ["COMPLETED","CANCELLED"]);
ok("2. COMPLETED e elegivel", ehElegivelParaFinanceiro("COMPLETED"));
ok("3. CANCELLED e elegivel", ehElegivelParaFinanceiro("CANCELLED"));
for (const s of ["PROCESSED","SHIPPED","READY_TO_SHIP","TO_CONFIRM_RECEIVE","UNPAID","IN_CANCEL"])
  ok(`4. ${s} NAO e elegivel (escrow ainda provisorio)`, !ehElegivelParaFinanceiro(s));
ok("5. status nulo nao e elegivel", !ehElegivelParaFinanceiro(null));

console.log("\n=== B. pedido normal (260703PJUYYMM0, real) ===\n");
{
  // base 12,19 - commission 2,19 - service 4,24 = escrow 5,76
  const income = {
    original_cost_of_goods_sold: 12.19, buyer_total_amount: 24.23,
    commission_fee: 2.19, net_commission_fee: 2.19,
    service_fee: 4.24, net_service_fee: 4.24,
    escrow_amount: 5.76, escrow_amount_after_adjustment: 5.76,
  };
  const c = extrairCamposFinanceiros(income);
  eq("6. escrow final = 5,76", c.escrowAmount, 5.76);
  eq("7. escrow bruto preservado", c.escrowBruto, 5.76);
  eq("8. commission_fee lido", c.commissionFee, 2.19);
  eq("9. service_fee lido", c.serviceFee, 4.24);
  eq("10. campos ausentes viram 0, nunca NaN", c.productRebate, 0);
  const s = snapUm(c, AGORA);
  eq("11. snapshot grava escrow final", s.escrow_amount, 5.76);
  eq("12. identidade base - taxas = escrow confere",
     round2(12.19 - Number(s.commission_fee) - Number(s.service_fee)), 5.76);
  ok("13. nao inventa campo fora do contrato", !("order_original_price" in s) && !("seller_discount" in s));
}

console.log("\n=== C. escrow_amount_after_adjustment tem prioridade ===\n");
{
  // 260704R2GQUU1W real: escrow 33,80 -> after_adjustment 27,34 (ajuste -6,46)
  const c = extrairCamposFinanceiros({
    escrow_amount: 33.80, escrow_amount_after_adjustment: 27.34, total_adjustment_amount: -6.46,
  });
  eq("14. usa o valor APOS o ajuste como repasse final", c.escrowAmount, 27.34);
  eq("15. preserva o bruto para auditoria", c.escrowBruto, 33.80);
  eq("16. guarda o ajuste que explica a diferenca", c.adjustmentAmount, -6.46);
  eq("17. bruto + ajuste = final", round2(c.escrowBruto + c.adjustmentAmount), c.escrowAmount);
  eq("18. fallback para escrow_amount quando nao ha after_adjustment",
     extrairCamposFinanceiros({ escrow_amount: 10 }).escrowAmount, 10);
  eq("19. after_adjustment ZERO nao cai no fallback (0 e valor valido)",
     extrairCamposFinanceiros({ escrow_amount: 10, escrow_amount_after_adjustment: 0 }).escrowAmount, 0);
}

console.log("\n=== D. escrow zero e negativo sao VALIDOS ===\n");
{
  // 260704R9CDDBG9 real: cancelado, escrow 0, seller_return_refund -10,98
  const cancel = extrairCamposFinanceiros({
    original_cost_of_goods_sold: 10.98, order_selling_price: 0,
    escrow_amount: 0, escrow_amount_after_adjustment: 0, seller_return_refund: -10.98,
  });
  const s = snapUm(cancel, AGORA);
  eq("20. cancelado: escrow zero e gravado como zero", s.escrow_amount, 0);
  eq("21. has_income_data TRUE mesmo com escrow zero", s.has_income_data, true);
  eq("22. reembolso negativo preservado", s.seller_return_refund, -10.98);
  ok("23. assinatura de cancelamento/devolucao detectada", ehCancelamentoOuDevolucao(cancel));

  const neg = extrairCamposFinanceiros({ escrow_amount: 1.5, escrow_amount_after_adjustment: -3.07 });
  const sn = snapUm(neg, AGORA);
  eq("24. escrow NEGATIVO e gravado como negativo", sn.escrow_amount, -3.07);
  eq("25. has_income_data TRUE com escrow negativo", sn.has_income_data, true);

  const normal = extrairCamposFinanceiros({ escrow_amount: 5.76, escrow_amount_after_adjustment: 5.76 });
  ok("26. pedido normal NAO e marcado como cancelamento", !ehCancelamentoOuDevolucao(normal));
  ok("27. escrow zero SEM reembolso nao e assinatura de devolucao",
     !ehCancelamentoOuDevolucao(extrairCamposFinanceiros({ escrow_amount: 0 })));
}

console.log("\n=== E. transaction_fee vem de credit_card_transaction_fee ===\n");
{
  eq("28. usa credit_card_transaction_fee",
     extrairCamposFinanceiros({ credit_card_transaction_fee: 1.23, seller_transaction_fee: 0 }).transactionFee, 1.23);
  eq("29. cai para seller_transaction_fee quando o de cartao nao vem",
     extrairCamposFinanceiros({ seller_transaction_fee: 0.99 }).transactionFee, 0.99);
  eq("30. cai para transaction_fee em ultimo caso",
     extrairCamposFinanceiros({ transaction_fee: 0.5 }).transactionFee, 0.5);
  eq("31. sem nenhum dos tres, zero", extrairCamposFinanceiros({}).transactionFee, 0);
}

console.log("\n=== F. pesos e rateio exato em centavos ===\n");
{
  eq("32. dois itens iguais pesam meio a meio", pesosDoPedido([50, 50]), [0.5, 0.5]);
  eq("33. item de 25 em pedido de 100 pesa 1/4", pesosDoPedido([25, 25, 25, 25])[0], 0.25);
  eq("34. pedido de item unico pesa 100%", pesosDoPedido([30]), [1]);
  eq("35. subtotal ZERO divide igualmente (sem divisao por zero)", pesosDoPedido([0, 0, 0, 0]), [0.25,0.25,0.25,0.25]);
  ok("36. peso nunca e NaN nem Infinity", pesosDoPedido([0,0,0]).every(Number.isFinite));
  eq("37. zero linhas devolve lista vazia", pesosDoPedido([]), []);

  // ratearCentavos: o coracao da correcao
  eq("38. valor divisivel fecha exato", ratearCentavos(100, [0.6, 0.4]), [60, 40]);
  eq("39. valor NAO divisivel fecha exato mesmo assim",
     round2(ratearCentavos(10, [1/3, 1/3, 1/3]).reduce((s,v)=>s+v,0)), 10);
  eq("40. o centavo sobrando vai para a maior parte fracionaria",
     ratearCentavos(10, [1/3, 1/3, 1/3]), [3.34, 3.33, 3.33]);
  eq("41. lista vazia devolve vazio", ratearCentavos(50, []), []);
  eq("42. valor zero gera tudo zero", ratearCentavos(0, [0.5, 0.5]), [0, 0]);
}

console.log("\n=== F2. soma EXATA para 1, 2, 3, 7 e 18 linhas ===\n");
{
  // income real com muitos campos simultaneos, inclusive negativos
  const income = {
    escrow_amount: 56.95, escrow_amount_after_adjustment: 56.95, buyer_total_amount: 104.45,
    commission_fee: 19.11, net_commission_fee: 16.95, service_fee: 30.12, net_service_fee: 26.96,
    order_ams_commission_fee: 7.13, credit_card_transaction_fee: 1.37, campaign_fee: 0.91,
    voucher_from_seller: 4.50, voucher_from_shopee: 5.32, seller_product_rebate: 3.77,
    seller_return_refund: -13.03, total_adjustment_amount: -6.46, shopee_shipping_rebate: 30.00,
  };
  const c = extrairCamposFinanceiros(income);
  const CAMPOS: Array<[string, number]> = [
    ["escrow_amount", c.escrowAmount], ["escrow_amount_bruto", c.escrowBruto],
    ["buyer_paid_amount", c.buyerTotal], ["commission_fee", c.commissionFee],
    ["net_commission_fee", c.netCommissionFee], ["service_fee", c.serviceFee],
    ["net_service_fee", c.netServiceFee], ["order_ams_commission_fee", c.amsCommissionFee],
    ["transaction_fee", c.transactionFee], ["campaign_fee", c.campaignFee],
    ["voucher_from_seller", c.voucherSeller], ["voucher_from_shopee", c.voucherShopee],
    ["seller_product_rebate", c.productRebate], ["seller_return_refund", c.returnRefund],
    ["total_adjustment_amount", c.adjustmentAmount], ["shopee_shipping_rebate", c.shippingRebate],
  ];
  // subtotais realistas, propositalmente irregulares (geram fracoes "feias")
  const CENARIOS: Array<[string, number[]]> = [
    ["1 linha",   [12.19]],
    ["2 linhas",  [49.79, 45.98]],
    ["3 linhas",  [13.76, 11.80, 11.49]],
    ["7 linhas",  [14.89, 12.99, 12.90, 13.60, 14.32, 11.29, 30.69]],
    ["18 linhas", [6.69,7.13,8.91,9.37,10.28,10.98,11.29,11.50,11.82,12.19,12.78,12.89,13.60,14.32,16.94,21.98,29.90,45.98]],
    ["iguais",    [10, 10, 10]],
    ["total zero",[0, 0, 0, 0, 0]],
  ];
  let n = 43;
  for (const [rot, subs] of CENARIOS) {
    const snaps = snapN(c, subs);
    let piorDif = 0, piorCampo = "";
    for (const [nome, oficial] of CAMPOS) {
      const soma = round2(snaps.reduce((s, x) => s + Number((x as any)[nome]), 0));
      const dif = Math.abs(soma - round2(oficial));
      if (dif > piorDif) { piorDif = dif; piorCampo = nome; }
    }
    eq(`${n}. ${rot}: soma de TODOS os 16 campos fecha exato (dif ${piorDif} em ${piorCampo || "-"})`, piorDif, 0);
    n++;
    eq(`${n}. ${rot}: numero de snapshots = numero de linhas`, snaps.length, subs.length);
    n++;
  }
}

console.log("\n=== F3. determinismo e ordenacao estavel ===\n");
{
  const c = extrairCamposFinanceiros({ escrow_amount: 10, commission_fee: 3.33, seller_return_refund: -1.01 });
  const linhas = [
    { id: "L003", item_subtotal: 11.29 },
    { id: "L001", item_subtotal: 49.79 },
    { id: "L002", item_subtotal: 30.69 },
  ];
  const a = montarSnapshotsFinanceirosDoPedido(c, linhas, AGORA);
  const b = montarSnapshotsFinanceirosDoPedido(c, [...linhas].reverse(), AGORA);
  const cc = montarSnapshotsFinanceirosDoPedido(c, [linhas[1], linhas[2], linhas[0]], AGORA);
  eq("57. ordem de entrada invertida produz a MESMA alocacao", a, b);
  eq("58. terceira ordem de entrada produz a MESMA alocacao", a, cc);
  eq("59. saida sai ordenada por id", a.map(x => x.id), ["L001","L002","L003"]);
  eq("60. a linha de maior subtotal recebe a maior fatia",
     Number(a[0].escrow_amount) > Number(a[1].escrow_amount) && Number(a[1].escrow_amount) > Number(a[2].escrow_amount), true);
  eq("61. reexecucao identica byte a byte", JSON.stringify(a), JSON.stringify(montarSnapshotsFinanceirosDoPedido(c, linhas, AGORA)));
}

console.log("\n=== F4. valores negativos e proporcionalidade ===\n");
{
  eq("62. refund negativo fecha exato",
     round2(ratearCentavos(-13.03, pesosDoPedido([14.89,12.99,12.90,13.60,14.32,11.29,30.69])).reduce((s,v)=>s+v,0)), -13.03);
  eq("63. ajuste negativo fecha exato em 18 linhas",
     round2(ratearCentavos(-6.46, pesosDoPedido(Array.from({length:18},(_,i)=>i+1))).reduce((s,v)=>s+v,0)), -6.46);
  eq("64. escrow negativo fecha exato",
     round2(ratearCentavos(-3.07, pesosDoPedido([10, 20, 30])).reduce((s,v)=>s+v,0)), -3.07);
  const neg = ratearCentavos(-10, [0.5, 0.5]);
  eq("65. valor negativo dividido igualmente", neg, [-5, -5]);
  ok("66. nenhuma parte negativa vira positiva por engano", neg.every(v => v <= 0));
  // proporcionalidade: cada linha fica a no maximo 1 centavo do valor exato
  const pesos = pesosDoPedido([14.89,12.99,12.90,13.60,14.32,11.29,30.69]);
  const partes = ratearCentavos(19.11, pesos);
  const desvios = partes.map((v, i) => Math.abs(v - 19.11 * pesos[i]));
  ok("67. cada linha fica a no maximo 1 centavo do proporcional exato", desvios.every(d => d <= 0.01 + 1e-9),
     `maior desvio ${Math.max(...desvios)}`);
}

console.log("\n=== G. idempotencia ===\n");
{
  const income = {
    escrow_amount: 33.80, escrow_amount_after_adjustment: 27.34,
    commission_fee: 8.51, service_fee: 4.95, total_adjustment_amount: -6.46, voucher_from_seller: 2.50,
  };
  const c = extrairCamposFinanceiros(income);
  const a = snapUm(c, AGORA);
  const b = snapUm(c, AGORA);
  eq("41. mesma entrada produz snapshot identico", a, b);

  // simula "gravar duas vezes": o snapshot SUBSTITUI, nunca soma
  const linhaNoBanco: Record<string, unknown> = { id: "x", escrow_amount: 999, commission_fee: 999 };
  const dep1 = { ...linhaNoBanco, ...a };
  const dep2 = { ...dep1, ...snapUm(c, AGORA) };
  eq("42. segunda gravacao nao acumula escrow", dep2.escrow_amount, 27.34);
  eq("43. segunda gravacao nao acumula comissao", dep2.commission_fee, 8.51);
  eq("44. segunda gravacao nao acumula ajuste", dep2.total_adjustment_amount, -6.46);
  eq("45. segunda gravacao nao acumula voucher", dep2.voucher_from_seller, 2.50);
  ok("46. nenhum campo do snapshot depende do valor anterior",
     Object.keys(a).every(k => JSON.stringify((a as any)[k]) === JSON.stringify((dep2 as any)[k])));

  const c2 = extrairCamposFinanceiros({ ...income, escrow_amount_after_adjustment: 20 });
  eq("47. valor oficial mais recente SUBSTITUI o antigo",
     snapUm(c2, AGORA).escrow_amount, 20);
}

console.log("\n=== H. metadados de reconciliacao ===\n");
{
  const s = snapUm(extrairCamposFinanceiros({ escrow_amount: 1 }), AGORA);
  eq("48. carimba financial_reconciled_at", s.financial_reconciled_at, AGORA);
  eq("49. registra a origem do dado", s.financial_source, FINANCIAL_SOURCE);
  eq("50. origem e get_escrow_detail", FINANCIAL_SOURCE, "get_escrow_detail");
  eq("51. registra a versao da regra", s.financial_version, FINANCIAL_VERSION);
  eq("52. versao da regra de rateio exato e 2", FINANCIAL_VERSION, 2);
}

console.log("\n=== I. robustez de entrada ===\n");
{
  ok("53. income null nao quebra", extrairCamposFinanceiros(null).escrowAmount === 0);
  ok("54. income undefined nao quebra", extrairCamposFinanceiros(undefined).escrowAmount === 0);
  ok("55. objeto vazio nao quebra", extrairCamposFinanceiros({}).commissionFee === 0);
  eq("56. string numerica e convertida", extrairCamposFinanceiros({ escrow_amount: "12.34" }).escrowAmount, 12.34);
  eq("57. valor nao numerico vira 0, nunca NaN", extrairCamposFinanceiros({ escrow_amount: "abc" }).escrowAmount, 0);
  const c = extrairCamposFinanceiros({ escrow_amount: "abc", commission_fee: null });
  ok("58. nenhum campo do snapshot e NaN",
     Object.values(snapUm(c, AGORA)).every(v => typeof v !== "number" || Number.isFinite(v)));
  eq("59a. round2 arredonda para centavos", round2(2.345), 2.35);
  eq("59b. round2 elimina ruido de ponto flutuante", round2(0.1 + 0.2), 0.3);
  eq("59c. round2 nao inventa precisao alem de centavos", round2(3.0149999999999997), 3.01);
  eq("60. round2 preserva negativo", round2(-3.071), -3.07);
}

console.log("\n=== J. o snapshot NAO toca faturamento nem custo ===\n");
{
  const s = snapUm(extrairCamposFinanceiros({ escrow_amount: 10 }), AGORA);
  for (const proibido of ["item_subtotal","faturamento","qtd","custo","imposto","tarifa_venda","status","data_pagamento","margem_contrib"])
    ok(`61. snapshot nao escreve ${proibido}`, !(proibido in s));
}

console.log("\n" + "=".repeat(64));
console.log(`  RESULTADO: ${passou} passaram, ${falhou} falharam (${passou + falhou} asserts)`);
if (falhou) { console.log("  FALHAS:"); for (const f of falhas) console.log(`    - ${f}`); }
console.log("=".repeat(64) + "\n");
process.exit(falhou ? 1 : 0);
