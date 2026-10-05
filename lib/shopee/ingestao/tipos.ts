/**
 * Motor de ingestao Shopee (CDS-STABILIZATION S2-D2) — contratos.
 *
 * Camadas, cada uma num arquivo:
 *   transporte.ts   — chamadas a API Shopee (porta `ShopeeApi`), retry/backoff
 *   normalizar.ts   — detail/escrow → linhas de shopee_pedidos e pedidos (puro)
 *   persistencia.ts — upserts e estado de job no Supabase (porta `Repositorio`)
 *   janelas.ts      — planejamento de janelas de listagem (puro)
 *   motor.ts        — orquestracao LIST → DETAIL → ESCROW por fatia + checkpoint
 *
 * O motor so ARMAZENA componentes e evidencias (janelas, timestamps,
 * checkpoint/progresso). Quem decide COMPLETE/PARTIAL/FAILED e quem calcula
 * Vendas e o servico canonico (lib/vendas/canonico/shopee.ts).
 */

export type CampoTempo = "update_time" | "create_time";

// ── Respostas da API (somente os campos usados) ──────────────────────

export interface PaginaListagem {
  pedidos: { orderSn: string }[];
  /** Ha proxima pagina? (`more` da Shopee). */
  mais: boolean;
  proximoCursor: string | null;
}

export interface ItemDetalhe {
  itemId: string;
  /** "0"/vazio = sem variacao (mesma regra do sync atual). */
  modelId: string | null;
  nome: string | null;
  sku: string | null;
  precoDescontado: number | null;
  precoOriginal: number | null;
  quantidade: number;
}

export interface PedidoDetalhe {
  orderSn: string;
  status: string | null;
  createTime: number;   // epoch s
  updateTime: number;   // epoch s
  payTime: number | null;
  cancelBy: string | null;
  cancelReason: string | null;
  totalAmount: number | null;
  itens: ItemDetalhe[];
}

export interface ItemEscrow {
  itemId: string;
  modelId: string | null;
  voucherVendedor: number;
  voucherShopee: number;
  moedas: number;
}

export interface EscrowPedido {
  orderSn: string;
  originalShopeeDiscount: number;
  pixDiscount: number;
  itens: ItemEscrow[];
}

/** Porta de transporte. Implementacao real em transporte.ts; fakes nos testes. */
export interface ShopeeApi {
  listarPagina(args: { campoTempo: CampoTempo; de: number; ate: number; cursor: string | null; tamanhoPagina: number }): Promise<PaginaListagem>;
  /** Pode devolver MENOS pedidos que os pedidos — quem chama trata a falta. */
  detalhes(orderSns: string[]): Promise<PedidoDetalhe[]>;
  escrow(orderSn: string): Promise<EscrowPedido>;
}

export type TipoErro = "rate_limit" | "transitorio" | "permanente";

export class ErroShopee extends Error {
  constructor(public tipo: TipoErro, mensagem: string) { super(mensagem); }
}

// ── Linhas persistidas ───────────────────────────────────────────────

/** shopee_pedidos — campos do DETAIL (escrow fica fora: outra fase). */
export interface LinhaPedidoDetalhe {
  user_id: string; loja_id: string; order_sn: string;
  create_time: string; update_time: string; pay_time: string | null;
  order_status: string | null; cancel_by: string | null; cancel_reason: string | null;
  total_amount: number | null;
  detail_fetched_at: string;
}

/** shopee_pedidos — campos do ESCROW. */
export interface LinhaPedidoEscrow {
  user_id: string; loja_id: string; order_sn: string;
  original_shopee_discount: number; pix_discount: number;
  escrow_fetched_at: string; escrow_update_time: string;
}

/** pedidos (grao item) — campos do DETAIL + compatibilidade atual. */
export interface LinhaItemDetalhe {
  id: string; user_id: string; marketplace: "Shopee"; order_id: string; loja_id: string;
  ml_item_id: string; variation_id: string | null; anuncio: string; sku: string | null;
  status: string; status_shopee_raw: string | null;
  valor_unit: number; qtd: number; item_subtotal: number;
  data: string | null; data_criacao: string | null; data_pagamento: string | null;
  data_atualizacao_marketplace: string; synced_at: string;
}

/** pedidos (grao item) — componentes de escrow POR ITEM. */
export interface LinhaItemEscrow {
  id: string; user_id: string; loja_id: string;
  escrow_voucher_seller: number; escrow_voucher_shopee: number; escrow_coin: number;
}

// ── Job, checkpoint e progresso ──────────────────────────────────────

export type Fase = "LIST" | "DETAIL" | "ESCROW" | "DONE";

/** Conteudo de sync_jobs.checkpoint. So dado operacional — nunca token. */
export interface CheckpointShopee {
  versao: 1;
  fase: Fase;
  /** Instante (ISO) em que a listagem COMECOU. A janela nunca passa dele. */
  listagemIniciadaEm: string | null;
  /** Cursor da PROXIMA pagina a ler (null = primeira). */
  cursor: string | null;
  paginasLidas: number;
  listagemTerminou: boolean;
  /** Listados aguardando detail. */
  pendentesDetalhe: string[];
  /** Tentativas por order_sn que vieram faltando no detail. */
  tentativasDetalhe: Record<string, number>;
  /** Desistidos no detail (pedido listado que nao materializou). */
  falhasDetalhe: string[];
  /** Pagos aguardando escrow. */
  pendentesEscrow: string[];
  tentativasEscrow: Record<string, number>;
  falhasEscrow: Record<string, string>;
}

/** Conteudo de sync_jobs.progresso — auditavel. */
export interface ProgressoShopee {
  paginas: number;
  listados: number;
  detail_solicitados: number;
  detail_concluidos: number;
  detail_falhos: number;
  escrow_necessarios: number;
  escrow_concluidos: number;
  escrow_falhos: number;
  pedidos_gravados: number;
  itens_gravados: number;
  erros_listagem: number;
  ultimo_erro: string | null;
}

export interface JobShopee {
  id: string;
  userId: string;
  lojaId: string;
  campoTempo: CampoTempo;
  janelaInicio: string;
  janelaFim: string;
  checkpoint: CheckpointShopee | null;
  progresso: ProgressoShopee | null;
}

/** Porta de persistencia. Implementacao real em persistencia.ts. */
export interface Repositorio {
  /** A loja existe, e Shopee, esta ativa e pertence ao usuario? */
  lojaDoDono(userId: string, lojaId: string): Promise<boolean>;
  /**
   * Ids de item que JA existem com OUTRA loja. A chave de item existente nao
   * inclui a loja; sem esta checagem um upsert moveria a linha de loja.
   */
  idsDeOutraLoja(userId: string, lojaId: string, ids: string[]): Promise<Set<string>>;
  gravarDetalhes(pedidos: LinhaPedidoDetalhe[], itens: LinhaItemDetalhe[]): Promise<void>;
  /** escrow_update_time atual por order_sn (null = nunca lido). */
  estadoEscrow(userId: string, lojaId: string, orderSns: string[]): Promise<Map<string, string | null>>;
  /** Pedido (update_time vigente) + chaves dos itens gravados. */
  pedidoParaEscrow(userId: string, lojaId: string, orderSn: string): Promise<{ updateTime: string; itens: { id: string; itemId: string; modelId: string | null }[] } | null>;
  gravarEscrow(pedido: LinhaPedidoEscrow, itens: LinhaItemEscrow[]): Promise<void>;
  salvarJob(job: { id: string; userId: string; lojaId: string }, patch: {
    checkpoint: CheckpointShopee; progresso: ProgressoShopee;
    listagemCompleta?: boolean; janelaFim?: string; status?: "rodando" | "concluido" | "erro"; erroMensagem?: string | null;
  }): Promise<void>;
}

export interface Relogio { agoraMs(): number }
