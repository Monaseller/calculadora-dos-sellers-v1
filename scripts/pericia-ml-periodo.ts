/**
 * A aritmetica de periodo da pericia do Mercado Livre — F7b.4.8.4-R2.
 *
 * PURO: sem rede, sem banco, sem IA, sem arquivo. Um lugar so decide o que
 * pertence a um periodo, e e esse lugar que os testes cobrem.
 *
 * ── O bug que criou este modulo ─────────────────────────────────────
 *
 * MEDIDO: a API devolve TODA data com offset `-04:00`. O gerador do
 * artefato testava o dia **como escrito** nesse offset antes de converter
 * para America/Sao_Paulo, e dois pedidos reais de setembro ficaram fora:
 *
 *   order 2000018219592150  date_closed 2026-08-31T23:33:10-04:00
 *                           em Sao Paulo: 2026-09-01 00:33
 *   order 2000018219744892  date_closed 2026-08-31T23:48:12-04:00
 *                           em Sao Paulo: 2026-09-01 00:48
 *
 * Os dois estao no relatorio oficial do Mercado Livre como vendas de
 * 01/09. Juntos valem R$ 80,70 e 3 unidades.
 *
 * A correcao NAO e uma excecao para esses dois ids. E uma regra: toda
 * decisao de pertencimento converte PRIMEIRO para America/Sao_Paulo, e so
 * depois compara. `diaComoEscrito` existe neste arquivo apenas como
 * diagnostico de borda — ela NUNCA entra numa candidata.
 */

/**
 * O Brasil nao tem horario de verao desde 2019, entao o fuso de Sao Paulo
 * e aritmetica fixa de -3h. Mesma conversao de `sync-ml.ts` e de
 * `lib/mercado-livre-vendas.ts`; um segundo numero aqui faria a pericia
 * discordar da producao por construcao.
 */
export const FUSO_SAO_PAULO_HORAS = -3;

/** O instante em Sao Paulo, como `AAAA-MM-DDTHH:MM:SS`, ou `null`. */
export function instanteEmSaoPaulo(iso: string | null | undefined): string | null {
  if (typeof iso !== "string" || iso === "") return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return new Date(t + FUSO_SAO_PAULO_HORAS * 60 * 60 * 1000)
    .toISOString().slice(0, 19);
}

/** O dia civil de Sao Paulo, `AAAA-MM-DD`. */
export function diaEmSaoPaulo(iso: string | null | undefined): string | null {
  const i = instanteEmSaoPaulo(iso);
  return i === null ? null : i.slice(0, 10);
}

/** O minuto em Sao Paulo, `AAAA-MM-DD HH:MM` — para casar com o oficial. */
export function minutoEmSaoPaulo(iso: string | null | undefined): string {
  const i = instanteEmSaoPaulo(iso);
  return i === null ? "" : i.slice(0, 16).replace("T", " ");
}

/**
 * O dia COMO ESCRITO no payload, sem conversao.
 *
 * DIAGNOSTICO DE BORDA, e nao criterio. Existe para a planilha poder
 * mostrar lado a lado o dia escrito e o dia em Sao Paulo, que foi o que
 * revelou a perda. Qualquer uso dela numa candidata e bug.
 */
export function diaComoEscrito(iso: string | null | undefined): string | null {
  return typeof iso === "string" && iso.length >= 10 ? iso.slice(0, 10) : null;
}

export function dentroDoPeriodo(
  dia: string | null, de: string, ate: string
): boolean {
  return dia !== null && dia >= de && dia <= ate;
}

// ─── A forma coletada ────────────────────────────────────────────────

export interface ItemPericia {
  readonly quantity: number | null;
  readonly unit_price: number | null;
  readonly gross_price: number | null;
}
export interface PagamentoPericia {
  readonly id: string;
  readonly status: string | null;
  readonly status_detail: string | null;
  readonly date_approved: string | null;
  readonly date_created: string | null;
  readonly transaction_amount: number | null;
  readonly total_paid_amount: number | null;
  readonly shipping_cost: number | null;
  readonly taxes_amount: number | null;
  readonly coupon_amount: number | null;
  readonly overpaid_amount: number | null;
  readonly transaction_amount_refunded: number | null;
  readonly installments: number | null;
  readonly payment_type: string | null;
  readonly operation_type: string | null;
}
export interface PedidoPericia {
  readonly id: string;
  readonly status: string | null;
  readonly status_detail: string | null;
  readonly date_created: string | null;
  readonly date_closed: string | null;
  readonly last_updated: string | null;
  readonly total_amount: number | null;
  readonly paid_amount: number | null;
  readonly coupon_amount: number | null;
  readonly taxes_amount: number | null;
  readonly cancel_group: string | null;
  readonly cancel_code: string | null;
  readonly cancel_date: string | null;
  readonly mediacoes: number;
  readonly pack_id: string | null;
  readonly fulfilled: boolean | null;
  readonly tags: readonly string[];
  readonly itens: readonly ItemPericia[];
  readonly pagamentos: readonly PagamentoPericia[];
}

export function numero(v: number | null | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
export function unidadesDoPedido(p: PedidoPericia): number {
  return p.itens.reduce((a, it) => a + numero(it.quantity), 0);
}

/** Os status de pagamento que a regra de HOJE aceita. */
export const STATUS_DE_PAGAMENTO_QUE_CONTA = Object.freeze(
  ["approved", "partially_refunded"] as const);

function contaComoPago(status: string | null): boolean {
  return status !== null &&
    (STATUS_DE_PAGAMENTO_QUE_CONTA as readonly string[]).includes(status);
}

/** O pagamento aprovado MAIS ANTIGO — a regra de hoje do agente. */
export function pagamentoDoAgente(p: PedidoPericia): PagamentoPericia | null {
  let escolhido: PagamentoPericia | null = null;
  let melhor = Infinity;
  for (const pg of p.pagamentos) {
    if (!contaComoPago(pg.status)) continue;
    if (pg.date_approved === null) continue;
    const t = new Date(pg.date_approved).getTime();
    if (!Number.isFinite(t)) continue;
    if (t < melhor) { melhor = t; escolhido = pg; }
  }
  return escolhido;
}

// ─── As candidatas, com identidade ───────────────────────────────────

export interface EixoData {
  readonly id: string;
  readonly rotulo: string;
  /** SEMPRE em Sao Paulo. Nenhum eixo usa o dia como escrito. */
  readonly dia: (p: PedidoPericia) => string | null;
  /** O instante em Sao Paulo, para a prova ao minuto contra o oficial. */
  readonly minuto: (p: PedidoPericia) => string;
}
export interface EixoPopulacao {
  readonly id: string;
  readonly rotulo: string;
  readonly inclui: (p: PedidoPericia) => boolean;
}
export interface EixoValor {
  readonly id: string;
  readonly rotulo: string;
  readonly valor: (p: PedidoPericia) => number;
}

export const EIXOS_DE_DATA: readonly EixoData[] = Object.freeze([
  {
    id: "fechamento_sp",
    rotulo: "order.date_closed convertido para America/Sao_Paulo",
    dia: (p) => diaEmSaoPaulo(p.date_closed),
    minuto: (p) => minutoEmSaoPaulo(p.date_closed),
  },
  {
    id: "criacao_sp",
    rotulo: "order.date_created convertido para America/Sao_Paulo",
    dia: (p) => diaEmSaoPaulo(p.date_created),
    minuto: (p) => minutoEmSaoPaulo(p.date_created),
  },
  {
    id: "pagamento_sp",
    rotulo: "payments[].date_approved mais antigo, em America/Sao_Paulo (regra de hoje)",
    dia: (p) => diaEmSaoPaulo(pagamentoDoAgente(p)?.date_approved ?? null),
    minuto: (p) => minutoEmSaoPaulo(pagamentoDoAgente(p)?.date_approved ?? null),
  },
]);

export const EIXOS_DE_POPULACAO: readonly EixoPopulacao[] = Object.freeze([
  {
    id: "sem_pack_splitted",
    // MEDIDO: os 134 pedidos com este codigo aparecem ZERO vezes no
    // relatorio oficial de setembro, e nenhum tem irmao vivo no mesmo
    // `pack_id`. O proprio Mercado Livre desfez e recriou o pedido.
    rotulo: "todos menos os cancelados com cancel_code = pack_splitted",
    inclui: (p) => p.cancel_code !== "pack_splitted",
  },
  { id: "todos", rotulo: "todos os pedidos, sem filtro", inclui: () => true },
  {
    id: "com_pagamento_que_conta",
    rotulo: "tem pagamento approved/partially_refunded (regra de hoje)",
    inclui: (p) => pagamentoDoAgente(p) !== null,
  },
  {
    id: "nao_cancelado",
    rotulo: "todos menos status = cancelled",
    inclui: (p) => p.status !== "cancelled",
  },
]);

export const EIXOS_DE_VALOR: readonly EixoValor[] = Object.freeze([
  {
    id: "total_amount", rotulo: "soma de order.total_amount",
    valor: (p) => numero(p.total_amount),
  },
  {
    id: "paid_amount", rotulo: "soma de order.paid_amount (regra de hoje)",
    valor: (p) => numero(p.paid_amount),
  },
  {
    id: "itens_unit_x_qtd", rotulo: "soma de (unit_price x quantity)",
    valor: (p) => p.itens.reduce(
      (a, it) => a + numero(it.unit_price) * numero(it.quantity), 0),
  },
  {
    id: "itens_gross", rotulo: "soma de gross_price (preco de tabela)",
    valor: (p) => p.itens.reduce((a, it) => a + numero(it.gross_price), 0),
  },
  {
    id: "pag_transaction",
    rotulo: "soma de transaction_amount dos pagamentos que contam",
    valor: (p) => p.pagamentos.filter((pg) => contaComoPago(pg.status))
      .reduce((a, pg) => a + numero(pg.transaction_amount), 0),
  },
  {
    id: "pag_total_paid",
    rotulo: "soma de total_paid_amount dos pagamentos que contam",
    valor: (p) => p.pagamentos.filter((pg) => contaComoPago(pg.status))
      .reduce((a, pg) => a + numero(pg.total_paid_amount), 0),
  },
  {
    id: "total_mais_frete", rotulo: "total_amount + frete pago pelo comprador",
    valor: (p) => numero(p.total_amount) +
      p.pagamentos.filter((pg) => contaComoPago(pg.status))
        .reduce((a, pg) => a + numero(pg.shipping_cost), 0),
  },
  {
    id: "total_mais_cupom", rotulo: "total_amount + coupon.amount",
    valor: (p) => numero(p.total_amount) + numero(p.coupon_amount),
  },
  {
    id: "paid_menos_estorno", rotulo: "paid_amount menos o estornado",
    valor: (p) => numero(p.paid_amount) -
      p.pagamentos.reduce((a, pg) => a + numero(pg.transaction_amount_refunded), 0),
  },
]);

/**
 * Uma candidata — identidade estavel, e nao posicao numa lista.
 *
 * O §6 exige saber de onde cada numero veio. Com `id` no formato
 * `data|populacao|valor`, qualquer celula de qualquer planilha se liga ao
 * eixo que a produziu, e a decomposicao nao pode mais apresentar uma
 * candidata sem dizer qual e.
 */
export interface Candidata {
  readonly id: string;
  readonly data: EixoData;
  readonly populacao: EixoPopulacao;
  readonly valor: EixoValor;
}

export function montarCandidatas(): readonly Candidata[] {
  const todas: Candidata[] = [];
  for (const data of EIXOS_DE_DATA) {
    for (const populacao of EIXOS_DE_POPULACAO) {
      for (const valor of EIXOS_DE_VALOR) {
        todas.push({ id: `${data.id}|${populacao.id}|${valor.id}`, data, populacao, valor });
      }
    }
  }
  return todas;
}

export interface Apuracao {
  readonly candidataId: string;
  readonly ids: readonly string[];
  readonly pedidos: number;
  readonly unidades: number;
  readonly total: number;
  readonly medioPorVenda: number;
  readonly medioPorUnidade: number;
}

export function apurar(
  c: Candidata, pedidos: readonly PedidoPericia[], de: string, ate: string
): Apuracao {
  const dentro = pedidos.filter((p) =>
    c.populacao.inclui(p) && dentroDoPeriodo(c.data.dia(p), de, ate));
  const total = dentro.reduce((a, p) => a + c.valor.valor(p), 0);
  const unidades = dentro.reduce((a, p) => a + unidadesDoPedido(p), 0);
  return {
    candidataId: c.id,
    ids: dentro.map((p) => p.id),
    pedidos: dentro.length,
    unidades,
    total,
    medioPorVenda: dentro.length === 0 ? 0 : total / dentro.length,
    medioPorUnidade: unidades === 0 ? 0 : total / unidades,
  };
}

// ─── Anti-vacuidade ─────────────────────────────────────────────────

export interface FalhaDeCobertura {
  readonly candidataId: string;
  readonly orderId: string;
  readonly campoDeData: string;
  readonly instanteOriginal: string;
  readonly instanteEmSaoPaulo: string;
  readonly diaComoEscrito: string;
  readonly diaEmSaoPaulo: string;
  readonly motivoDeInclusao: string;
}

/**
 * Todo pedido usado por QUALQUER candidata existe no raw entregue?
 *
 * ── Por que este controle precisou existir ──────────────────────────
 *
 * O controle antigo media `ids unicos >= paging.total` por dia de
 * CRIACAO. Ele prova que cada dia foi paginado inteiro e nao prova nada
 * sobre o artefato: nunca compara contra a populacao-alvo. Dois pedidos
 * sairam da planilha e ele continuou verde.
 *
 * Este compara os dois conjuntos. Se uma candidata soma um pedido que nao
 * esta no raw, o numero dela nao e auditavel — e isso e FALHA, nao nota de
 * rodape.
 */
export function conferirCobertura(
  apuracoes: readonly Apuracao[],
  candidatasPorId: ReadonlyMap<string, Candidata>,
  pedidosPorId: ReadonlyMap<string, PedidoPericia>,
  idsNoRaw: ReadonlySet<string>
): readonly FalhaDeCobertura[] {
  const falhas: FalhaDeCobertura[] = [];
  for (const a of apuracoes) {
    const c = candidatasPorId.get(a.candidataId);
    if (c === undefined) continue;
    for (const id of a.ids) {
      if (idsNoRaw.has(id)) continue;
      const p = pedidosPorId.get(id);
      const original = c.data.id === "fechamento_sp" ? p?.date_closed
        : c.data.id === "criacao_sp" ? p?.date_created
          : pagamentoDoAgente(p as PedidoPericia)?.date_approved ?? null;
      falhas.push({
        candidataId: a.candidataId,
        orderId: id,
        campoDeData: c.data.id,
        instanteOriginal: original ?? "",
        instanteEmSaoPaulo: minutoEmSaoPaulo(original ?? null),
        diaComoEscrito: diaComoEscrito(original ?? null) ?? "",
        diaEmSaoPaulo: diaEmSaoPaulo(original ?? null) ?? "",
        motivoDeInclusao: `${c.data.rotulo} dentro do periodo e ${c.populacao.rotulo}`,
      });
    }
  }
  return falhas;
}

/**
 * A populacao que o ARTEFATO bruto precisa cobrir.
 *
 * Uniao de todas as candidatas, e nao um filtro proprio. Era um filtro
 * proprio — escrito com o dia como escrito — que perdeu os dois pedidos.
 * Derivar do mesmo registro de candidatas torna a divergencia impossivel.
 */
export function populacaoDoRaw(
  pedidos: readonly PedidoPericia[], de: string, ate: string
): readonly PedidoPericia[] {
  const candidatas = montarCandidatas();
  const necessarios = new Set<string>();
  for (const c of candidatas) {
    for (const p of pedidos) {
      if (c.populacao.inclui(p) && dentroDoPeriodo(c.data.dia(p), de, ate)) {
        necessarios.add(p.id);
      }
    }
  }
  return pedidos.filter((p) => necessarios.has(p.id));
}
