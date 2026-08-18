/**
 * lib/shopee-financeiro.ts
 *
 * Camada financeira Shopee — regra PURA de leitura de `order_income`
 * (/api/v2/payment/get_escrow_detail) e montagem do snapshot que vai para
 * `pedidos`.
 *
 * Vive fora de `app/api/.../route.ts` por dois motivos:
 *   1. Next.js proibe export extra em route.ts (o arquivo gerado em
 *      .next/types tipa qualquer nome desconhecido como `never` -> TS2344);
 *   2. sendo pura, e testavel sem rede, sem banco e sem env.
 *
 * Ver supabase/migrations/20260818_camada_financeira_shopee.sql para o contrato
 * das colunas e o porque de cada campo ter sido escolhido.
 */

/**
 * Estados em que o escrow da Shopee ja e DEFINITIVO.
 *
 * Pedido em transito (PROCESSED, SHIPPED, READY_TO_SHIP, TO_CONFIRM_RECEIVE)
 * tem valores provisorios — reconcilia-lo agora seria refeito quando concluir.
 * Na janela de 30 dias auditada em 2026-08-18 isso era 23.387 de 31.463 linhas.
 *
 * CANCELLED entra de proposito: escrow 0 com seller_return_refund negativo e
 * dado financeiro REAL (a venda existiu, o repasse foi zerado), nao ausencia.
 */
export const ELEGIVEIS_FINANCEIRO: readonly string[] = ["COMPLETED", "CANCELLED"];

/** Origem do dado financeiro gravado. Hoje ha uma so. */
export const FINANCIAL_SOURCE = "get_escrow_detail";

/**
 * Versao da REGRA de reconciliacao.
 *   1 = 2026-08-18. Escrow final = escrow_amount_after_adjustment com fallback
 *       para escrow_amount; transaction_fee de credit_card_transaction_fee;
 *       rateio por round2(valor * peso) linha a linha.
 *   2 = 2026-08-18. Mesma leitura de campos; rateio passa a ser por MAIOR RESTO
 *       em centavos inteiros, com ordenacao estavel por `id`. A soma das linhas
 *       agora fecha EXATAMENTE no valor oficial do pedido — antes acumulava ate
 *       N x 0,005 de residuo (R$ 0,0200 medidos num pedido de 7 linhas).
 *
 * Subir este numero permite reprocessar so o que ficou gravado por regra antiga:
 *   where financial_version < 2
 */
export const FINANCIAL_VERSION = 2;

export function ehElegivelParaFinanceiro(statusShopeeRaw: string | null | undefined): boolean {
  return ELEGIVEIS_FINANCEIRO.includes(statusShopeeRaw ?? "");
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export interface CamposFinanceirosShopee {
  /** Repasse FINAL: after_adjustment quando existir, senao escrow_amount. */
  escrowAmount: number;
  /** Repasse ANTES do ajuste — preserva o bruto para auditoria. */
  escrowBruto: number;
  buyerTotal: number;
  voucherSeller: number;
  voucherShopee: number;
  commissionFee: number;
  netCommissionFee: number;
  serviceFee: number;
  netServiceFee: number;
  amsCommissionFee: number;
  transactionFee: number;
  campaignFee: number;
  productRebate: number;
  returnRefund: number;
  adjustmentAmount: number;
  shippingRebate: number;
}

/**
 * extrairCamposFinanceiros — le o `order_income` cru e devolve so o que o CDS
 * persiste. Campo ausente vira 0; nunca lanca.
 *
 * Decisoes que NAO sao obvias, todas medidas em 770 pedidos reais (04/07/2026):
 *
 *  - `escrow_amount_after_adjustment` tem prioridade sobre `escrow_amount`.
 *    Sao diferentes de verdade: no agregado do dia, 9.445,53 contra 9.587,13.
 *  - `transaction_fee` vem de `credit_card_transaction_fee`.
 *    `seller_transaction_fee` veio 0 em 770/770; o encadeamento antigo fica no
 *    fim para nao perder um campo que a Shopee possa voltar a usar.
 *  - NENHUMA soma de taxas reconstroi o escrow: a melhor combinacao testada
 *    errou -3,79%. Por isso o repasse e LIDO, nunca derivado, e as taxas
 *    servem para explicar, nao para calcular.
 */
export function extrairCamposFinanceiros(income: any): CamposFinanceirosShopee {
  const i = income ?? {};
  return {
    escrowAmount:     num(i.escrow_amount_after_adjustment ?? i.escrow_amount),
    escrowBruto:      num(i.escrow_amount),
    buyerTotal:       num(i.buyer_total_amount),
    voucherSeller:    num(i.voucher_from_seller),
    voucherShopee:    num(i.voucher_from_shopee),
    commissionFee:    num(i.commission_fee),
    netCommissionFee: num(i.net_commission_fee),
    serviceFee:       num(i.service_fee),
    netServiceFee:    num(i.net_service_fee),
    amsCommissionFee: num(i.order_ams_commission_fee),
    transactionFee:   num(i.credit_card_transaction_fee ?? i.seller_transaction_fee ?? i.transaction_fee),
    campaignFee:      num(i.campaign_fee),
    productRebate:    num(i.seller_product_rebate),
    returnRefund:     num(i.seller_return_refund),
    adjustmentAmount: num(i.total_adjustment_amount),
    shippingRebate:   num(i.shopee_shipping_rebate),
  };
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * pesosDoPedido — peso de cada linha no rateio, proporcional a `item_subtotal`.
 *
 * O escrow vem por PEDIDO; a tabela `pedidos` guarda uma linha por item.
 * Quando o pedido inteiro soma 0 (cancelado antes de precificar, por exemplo),
 * todas as linhas pesam igual — evita divisao por zero e evita concentrar tudo
 * numa linha.
 */
export function pesosDoPedido(subtotais: number[]): number[] {
  const n = subtotais.length;
  if (n === 0) return [];
  const total = subtotais.reduce((s, v) => s + num(v), 0);
  if (total > 0) return subtotais.map(v => num(v) / total);
  return subtotais.map(() => 1 / n);
}

/**
 * ratearCentavos — divide um valor monetario entre N linhas de modo que a soma
 * das partes seja EXATAMENTE igual ao valor original, ja arredondado a centavos.
 *
 * POR QUE NAO round2(valor * peso) POR LINHA (regra ate 2026-08-18):
 *   cada arredondamento erra ate meio centavo, e os erros NAO se cancelam. Com
 *   N linhas o residuo chega a N x 0,005 — medido em producao: R$ 0,0200 num
 *   pedido de 7 linhas, e o universo tem pedidos de ate 18 linhas (teto teorico
 *   R$ 0,09). A soma das linhas simplesmente nao reconstruia o valor oficial.
 *
 * POR QUE NAO "ultima linha absorve o residuo":
 *   fecha a conta, mas joga ate N/2 centavos numa unica linha escolhida por
 *   posicao. Numa consulta por item isso vira distorcao visivel — justamente o
 *   "concentrar valor artificialmente" que queremos evitar.
 *
 * ALGORITMO ADOTADO — maior resto (Hare/Hamilton), em centavos INTEIROS:
 *   1. alvo   = round(valor * 100)                  -> inteiro, pode ser negativo
 *   2. bruto_i = alvo * peso_i                       -> fracionario
 *   3. base_i  = floor(bruto_i)                      -> floor tambem para negativo
 *   4. resto   = alvo - soma(base_i)                 -> inteiro em [0, N)
 *   5. distribui `resto` centavos, +1 cada, para as linhas de maior parte
 *      fracionaria; empate resolvido pela ORDEM DE ENTRADA (ja ordenada por id)
 *
 * Propriedades:
 *   - soma exata por construcao (passo 4 mede o que falta e o passo 5 devolve);
 *   - cada linha fica a no maximo 1 centavo do seu valor proporcional exato —
 *     e o desvio minimo possivel para qualquer divisao que feche em centavos;
 *   - funciona com valor negativo (refund, ajuste, escrow negativo) porque
 *     `floor` empurra para baixo e o resto devolvido e sempre positivo;
 *   - deterministico: mesma entrada, mesma saida, sempre.
 */
export function ratearCentavos(valor: number, pesos: number[]): number[] {
  const n = pesos.length;
  if (n === 0) return [];
  const alvo = Math.round(num(valor) * 100);
  const bruto = pesos.map(p => alvo * num(p));
  const base = bruto.map(b => Math.floor(b));
  const resto = alvo - base.reduce((s, v) => s + v, 0);
  // indices ordenados por parte fracionaria decrescente; empate = ordem de entrada
  const ordem = bruto
    .map((b, i) => ({ i, frac: b - Math.floor(b) }))
    .sort((a, b) => (b.frac - a.frac) || (a.i - b.i));
  const extra = new Array(n).fill(0);
  for (let k = 0; k < resto; k++) extra[ordem[k % n].i] += 1;
  return base.map((b, i) => (b + extra[i]) / 100);
}

/** Uma linha de `pedidos` do ponto de vista do rateio. */
export interface LinhaParaRateio {
  id: string;
  item_subtotal: number | string | null;
}

/**
 * montarSnapshotsFinanceirosDoPedido — recebe TODAS as linhas de um order_id e
 * devolve o snapshot de cada uma, com a soma fechando exatamente em cada campo.
 *
 * Trabalha com o pedido inteiro de proposito: fechar a conta exige conhecer
 * todas as partes ao mesmo tempo. Uma funcao linha-a-linha nao tem como saber
 * quanto de residuo sobrou para as outras.
 *
 * ORDENACAO: as linhas sao ordenadas por `id` ANTES do rateio. `id` e a chave
 * primaria, imutavel e unica (`{user}_SHOPEE_{order_sn}_{item}_{variacao}`) — nao
 * depende da ordem que o banco devolveu. Reconciliar o mesmo pedido duas vezes,
 * com as linhas em qualquer ordem de entrada, produz a MESMA alocacao.
 *
 * IDEMPOTENTE: o retorno depende so de (campos, linhas, instante) e SUBSTITUI o
 * valor anterior. Nao existe `+=` em lugar nenhum.
 */
export function montarSnapshotsFinanceirosDoPedido(
  campos: CamposFinanceirosShopee,
  linhas: LinhaParaRateio[],
  agoraISO: string,
): Array<Record<string, unknown> & { id: string }> {
  const ordenadas = [...linhas].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const pesos = pesosDoPedido(ordenadas.map(l => num(l.item_subtotal)));
  const r = (valor: number) => ratearCentavos(valor, pesos);

  const escrow      = r(campos.escrowAmount);
  const escrowBruto = r(campos.escrowBruto);
  const buyer       = r(campos.buyerTotal);
  const vchSeller   = r(campos.voucherSeller);
  const vchShopee   = r(campos.voucherShopee);
  const comm        = r(campos.commissionFee);
  const netComm     = r(campos.netCommissionFee);
  const serv        = r(campos.serviceFee);
  const netServ     = r(campos.netServiceFee);
  const ams         = r(campos.amsCommissionFee);
  const tx          = r(campos.transactionFee);
  const camp        = r(campos.campaignFee);
  const rebate      = r(campos.productRebate);
  const refund      = r(campos.returnRefund);
  const ajuste      = r(campos.adjustmentAmount);
  const frete       = r(campos.shippingRebate);

  return ordenadas.map((l, i) => ({
    id:                       String(l.id),
    escrow_amount:            escrow[i],
    escrow_amount_bruto:      escrowBruto[i],
    buyer_paid_amount:        buyer[i],
    voucher_from_seller:      vchSeller[i],
    voucher_from_shopee:      vchShopee[i],
    commission_fee:           comm[i],
    net_commission_fee:       netComm[i],
    service_fee:              serv[i],
    net_service_fee:          netServ[i],
    order_ams_commission_fee: ams[i],
    transaction_fee:          tx[i],
    campaign_fee:             camp[i],
    seller_product_rebate:    rebate[i],
    seller_return_refund:     refund[i],
    total_adjustment_amount:  ajuste[i],
    shopee_shipping_rebate:   frete[i],
    // TRUE sempre que a Shopee devolveu um order_income valido. NAO depende de
    // escrow > 0: devolucao total tem escrow 0 e e dado financeiro real.
    has_income_data:          true,
    financial_reconciled_at:  agoraISO,
    financial_source:         FINANCIAL_SOURCE,
    financial_version:        FINANCIAL_VERSION,
  }));
}

/**
 * ehCancelamentoOuDevolucao — assinatura financeira, independente do `status`
 * gravado no banco. Serve para DIAGNOSTICO (os ~298 status defasados conhecidos),
 * nunca para alterar status: essa correcao e frente propria.
 */
export function ehCancelamentoOuDevolucao(campos: CamposFinanceirosShopee): boolean {
  return campos.escrowAmount === 0 && campos.returnRefund < 0;
}
