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

/**
 * CAMPOS_SNAPSHOT_FINANCEIRO — FONTE UNICA das colunas que pertencem ao snapshot
 * financeiro v2. Derivada do proprio retorno de
 * `montarSnapshotsFinanceirosDoPedido` (menos `id`), e um teste garante que as
 * duas listas nunca divergem — se alguem adicionar um campo ao snapshot e
 * esquecer daqui, o teste quebra.
 *
 * Por que precisa existir (2026-08-18): o upsert do sync comercial envia o
 * OBJETO COMPLETO da linha. Sem `income_distribution` — que e o caso do sync,
 * que nunca chama get_escrow_detail — esses campos vao a ZERO. Rebuscar um
 * pedido ja reconciliado APAGARIA seu snapshot oficial.
 *
 * Hoje isso nao acontece por acidente: o cron filtra justamente os COMPLETED,
 * que sao os pedidos reconciliados. Ao remover esse filtro, a protecao passa a
 * ser obrigatoria.
 */
export const CAMPOS_SNAPSHOT_FINANCEIRO: readonly string[] = [
  "escrow_amount", "escrow_amount_bruto", "buyer_paid_amount",
  "voucher_from_seller", "voucher_from_shopee",
  "commission_fee", "net_commission_fee",
  "service_fee", "net_service_fee",
  "order_ams_commission_fee", "transaction_fee", "campaign_fee",
  "seller_product_rebate", "seller_return_refund", "total_adjustment_amount",
  "shopee_shipping_rebate",
  "has_income_data",
  "financial_reconciled_at", "financial_source", "financial_version",
];

/**
 * protegerSnapshotFinanceiro — remove de uma linha a gravar TODOS os campos do
 * snapshot financeiro, quando aquela linha ja foi reconciliada.
 *
 * Nao bloqueia a linha inteira de proposito: `status`, `status_shopee_raw`,
 * `data_atualizacao_marketplace` e os demais campos comerciais continuam sendo
 * atualizados normalmente. O sync comercial mantem sua funcao; so perde o
 * direito de escrever sobre dado financeiro oficial.
 *
 * PURA: nao muta a entrada, devolve um objeto novo.
 */
export function protegerSnapshotFinanceiro<T extends Record<string, unknown>>(
  linha: T, jaReconciliada: boolean
): Partial<T> {
  if (!jaReconciliada) return { ...linha };
  const saida: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(linha)) {
    if (!CAMPOS_SNAPSHOT_FINANCEIRO.includes(k)) saida[k] = v;
  }
  return saida as Partial<T>;
}

/**
 * decidirAtualizacaoDeStatus — dado o que a LISTAGEM devolveu e o que o banco
 * tem, decide quais pedidos existentes precisam de correcao de status.
 *
 * Por que existe (2026-08-18): `get_order_list` ja devolve `order_status` junto
 * de `order_sn` (o sync pede `response_optional_fields: "order_status"`), e as
 * paginas dessa listagem JA sao buscadas. Corrigir o status de um pedido que ja
 * existe no banco nao custa NENHUMA chamada extra a Shopee — nem listagem, nem
 * detalhe.
 *
 * Isso resolve os dois portoes de uma vez, sem passar pelo upsert:
 *   - o pedido COMPLETED deixa de desaparecer;
 *   - o corte `dataBrt fora de [dateFrom, dateTo]` de montarLinhasDoPedido nao
 *     se aplica, porque nao ha montagem de linha — e um UPDATE dirigido de
 *     status. `data_pagamento` e `data_criacao` nao sao tocadas.
 *
 * Devolve so os que REALMENTE mudaram, para nao gerar escrita inutil.
 */
export function decidirAtualizacaoDeStatus(
  listados: Array<{ order_sn: string; order_status: string }>,
  noBanco: Map<string, string | null>,
): Array<{ order_sn: string; de: string | null; para: string }> {
  const mudancas: Array<{ order_sn: string; de: string | null; para: string }> = [];
  const vistos = new Set<string>();
  for (const l of listados) {
    if (!l?.order_sn || !l?.order_status) continue;
    if (!noBanco.has(l.order_sn)) continue;          // nao existe: nao e caso de correcao
    if (vistos.has(l.order_sn)) continue;            // mesmo pedido em 2 paginas: uma vez so
    const atual = noBanco.get(l.order_sn) ?? null;
    if (atual === l.order_status) continue;          // nada mudou
    vistos.add(l.order_sn);
    mudancas.push({ order_sn: l.order_sn, de: atual, para: l.order_status });
  }
  return mudancas;
}

/**
 * Quantos order_id por UPDATE em lote. 200 e o mesmo tamanho ja usado em
 * `LOTE_CONSULTA_ORDER_SN` aqui e em `LOTE_MAXIMO_IDS` de
 * app/(app)/anuncios/paginacao.ts — mantido igual de proposito, para o projeto
 * ter um unico numero de referencia.
 *
 * Dimensionamento: order_sn tem 14 caracteres, entao 200 deles geram ~3,4 KB de
 * querystring no `.in()`. O HTTP 400 por URL longa que este projeto ja sofreu
 * aconteceu perto de 40 KB — folga de mais de 10x.
 */
export const LOTE_UPDATE_STATUS = 200;

/**
 * separarStatusDesconhecidos — barreira contra gravar `status = "unknown"`.
 *
 * DEFEITO QUE ISTO CORRIGE (2026-08-18): `mapStatus` devolve "unknown" para
 * qualquer raw fora dos 16 conhecidos — corretamente, porque nao inventa
 * mapeamento. Mas `agruparMudancasDeStatus` gravava esse "unknown" na coluna
 * `status`. Um pedido PAGO cujo raw a Shopee renomeasse sumiria de todo filtro
 * `status='paid'` — Dashboard, Vendas e faturamento subnotificados, sem erro
 * nenhum aparecendo. O dado da Shopee estaria certo e o nosso, errado.
 *
 * A protecao vive AQUI, na camada compartilhada, e nao no consumidor: assim
 * valem de uma vez o sync de status novo (lib/shopee-status.ts) E a etapa 1.6
 * ja publicada em lib/sync-shopee.ts.
 *
 * Nao havendo o que gravar com seguranca, a escolha e NAO GRAVAR. O pedido
 * continua com o status que tinha, e a ocorrencia e contada por raw.
 */
export function separarStatusDesconhecidos(
  mudancas: Array<{ order_sn: string; para: string }>,
  mapear: (raw: string) => string,
): { conhecidas: Array<{ order_sn: string; para: string }>; desconhecidos: Record<string, number> } {
  const conhecidas: Array<{ order_sn: string; para: string }> = [];
  const desconhecidos: Record<string, number> = {};
  for (const m of mudancas ?? []) {
    if (!m?.order_sn || !m?.para) continue;
    if (mapear(m.para) === "unknown") {
      desconhecidos[m.para] = (desconhecidos[m.para] ?? 0) + 1;
      continue;
    }
    conhecidas.push(m);
  }
  return { conhecidas, desconhecidos };
}

export interface GrupoDeStatus {
  /** Valor a gravar em `status` (comercial, derivado do raw). */
  statusComercial: string;
  /** Valor a gravar em `status_shopee_raw` (bruto da Shopee). */
  statusRaw: string;
  /** order_id deste chunk. Nunca maior que LOTE_UPDATE_STATUS. */
  orderSns: string[];
}

/**
 * agruparMudancasDeStatus — transforma N mudancas individuais em poucos UPDATEs
 * em lote.
 *
 * POR QUE AGRUPAR PELO PAR (statusComercial, statusRaw) e nao so pelo raw:
 *   `mapStatus` COLAPSA 16 status brutos da Shopee em 5 comerciais — seis raws
 *   diferentes (READY_TO_SHIP, RETRY_SHIP, PROCESSED, SHIPPED,
 *   TO_CONFIRM_RECEIVE, COMPLETED) viram todos "paid". Agrupar apenas pelo
 *   comercial gravaria o raw errado; agrupar apenas pelo raw funcionaria, mas o
 *   par deixa explicito que os dois valores gravados vem da mesma origem.
 *
 * POR QUE ISSO IMPORTA: antes era 1 round-trip ao Supabase por pedido alterado.
 * No cenario medido (1.075 candidatos num sync de 1 dia) isso seriam 1.075
 * requests em serie — estourando o `maxDuration` de 60 s da rota. Agrupado, o
 * mesmo volume cabe em (grupos x chunks) requests.
 *
 * PURA e DETERMINISTICA: ordena os grupos e os order_sn, entao a mesma entrada
 * sempre produz os mesmos chunks, na mesma ordem. `mapear` e injetado para que
 * o teste use exatamente o `mapStatus` de producao, sem copia.
 */
export function agruparMudancasDeStatus(
  mudancas: Array<{ order_sn: string; para: string }>,
  mapear: (raw: string) => string,
  tamanhoChunk: number = LOTE_UPDATE_STATUS,
): GrupoDeStatus[] {
  if (tamanhoChunk < 1) throw new Error("agruparMudancasDeStatus: tamanho de chunk deve ser >= 1");
  const { conhecidas, desconhecidos } = separarStatusDesconhecidos(mudancas, mapear);
  if (Object.keys(desconhecidos).length > 0) {
    // Nao e fallback silencioso: o pedido fica INTACTO e a ocorrencia aparece
    // no log com a contagem por raw (nunca com order_id).
    console.warn("[shopee-status] status bruto desconhecido — pedidos ignorados, nada gravado:", desconhecidos);
  }
  const porRaw = new Map<string, string[]>();
  for (const m of conhecidas) {
    if (!m?.order_sn || !m?.para) continue;
    if (!porRaw.has(m.para)) porRaw.set(m.para, []);
    porRaw.get(m.para)!.push(m.order_sn);
  }
  const grupos: GrupoDeStatus[] = [];
  for (const raw of [...porRaw.keys()].sort()) {
    const sns = [...new Set(porRaw.get(raw)!)].sort();
    for (let i = 0; i < sns.length; i += tamanhoChunk) {
      grupos.push({
        statusComercial: mapear(raw),
        statusRaw: raw,
        orderSns: sns.slice(i, i + tamanhoChunk),
      });
    }
  }
  return grupos;
}
