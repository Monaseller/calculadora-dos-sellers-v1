/**
 * Fakes deterministicos para o motor de ingestao Shopee (S2-D2).
 * Sem rede, sem banco, sem token. Usados por scripts/testar-shopee-ingestao.ts.
 *
 * ShopeeFake: API com pedidos em memoria, cursor KEYSET (a proxima pagina
 * comeca depois do ultimo (tempo, order_sn) devolvido — pressuposto sobre o
 * cursor real da Shopee, documentado no relatorio), relogio compartilhado
 * que anda a cada chamada, e ganchos para injetar falha/mutacao.
 * RepoFake: as tabelas shopee_pedidos/pedidos/sync_jobs em memoria, com a
 * mesma semantica de upsert por coluna da persistencia real.
 */
import {
  ErroShopee, type CampoTempo, type CheckpointShopee, type EscrowPedido, type ItemEscrow, type LinhaItemDetalhe,
  type LinhaItemEscrow, type LinhaPedidoDetalhe, type LinhaPedidoEscrow, type PaginaListagem, type PedidoDetalhe,
  type ProgressoShopee, type Relogio, type Repositorio, type ShopeeApi,
} from "../../lib/shopee/ingestao/tipos";

export interface ItemFake { itemId: string; modelId: string | null; preco: number; qtd: number; vs: number; vsh: number; coin: number }
export interface PedidoFake {
  orderSn: string; createTime: number; updateTime: number; payTime: number | null; status: string;
  cancelBy?: string | null; cancelReason?: string | null; totalAmount: number;
  osd: number; pix: number; itens: ItemFake[];
}

export class RelogioFake implements Relogio {
  constructor(public t: number) {}
  agoraMs() { return this.t; }
  andar(ms: number) { this.t += ms; }
}

export class ShopeeFake implements ShopeeApi {
  pedidos = new Map<string, PedidoFake>();
  chamadas = { listar: 0, detalhes: 0, escrow: 0 };
  /** antes de responder uma pagina: pode lancar ErroShopee ou mutar pedidos (corrida). */
  onListar?: (chamada: number) => ErroShopee | void;
  onDetalhes?: (chamada: number, sns: string[]) => ErroShopee | void;
  onEscrow?: (sn: string, chamada: number) => ErroShopee | void;
  /** order_sn → quantas vezes ainda omitir do detail (Infinity = sempre). */
  omitirDetalhe = new Map<string, number>();
  /** order_sn → itens de escrow alternativos (para quebrar o 1:1). */
  escrowItens = new Map<string, ItemEscrow[]>();
  passoMs = 500;
  constructor(public relogio: RelogioFake, pedidos: PedidoFake[] = []) { for (const p of pedidos) this.pedidos.set(p.orderSn, structuredClone(p)); }

  async listarPagina(a: { campoTempo: CampoTempo; de: number; ate: number; cursor: string | null; tamanhoPagina: number }): Promise<PaginaListagem> {
    this.relogio.andar(this.passoMs);
    const n = ++this.chamadas.listar;
    const e = this.onListar?.(n); if (e) throw e;
    const campo = (p: PedidoFake) => (a.campoTempo === "update_time" ? p.updateTime : p.createTime);
    const todos = [...this.pedidos.values()].filter((p) => campo(p) * 1000 >= a.de && campo(p) * 1000 <= a.ate)
      .map((p) => ({ t: campo(p), sn: p.orderSn })).sort((x, y) => x.t - y.t || x.sn.localeCompare(y.sn));
    const [ct, csn] = a.cursor ? [Number(a.cursor.split("|")[0]), a.cursor.split("|")[1]] : [-Infinity, ""];
    const depois = todos.filter((x) => x.t > ct || (x.t === ct && x.sn > csn));
    const pagina = depois.slice(0, a.tamanhoPagina);
    const mais = depois.length > pagina.length;
    const ult = pagina[pagina.length - 1];
    return { pedidos: pagina.map((x) => ({ orderSn: x.sn })), mais, proximoCursor: mais ? `${ult.t}|${ult.sn}` : null };
  }

  async detalhes(sns: string[]): Promise<PedidoDetalhe[]> {
    this.relogio.andar(this.passoMs);
    const n = ++this.chamadas.detalhes;
    if (sns.length > 50) throw new ErroShopee("permanente", "order_sn_list > 50");
    const e = this.onDetalhes?.(n, sns); if (e) throw e;
    const out: PedidoDetalhe[] = [];
    for (const sn of sns) {
      const omit = this.omitirDetalhe.get(sn) ?? 0;
      if (omit > 0) { this.omitirDetalhe.set(sn, omit - 1); continue; }
      const p = this.pedidos.get(sn); if (!p) continue;
      out.push({ orderSn: sn, status: p.status, createTime: p.createTime, updateTime: p.updateTime, payTime: p.payTime,
        cancelBy: p.cancelBy ?? null, cancelReason: p.cancelReason ?? null, totalAmount: p.totalAmount,
        itens: p.itens.map((i) => ({ itemId: i.itemId, modelId: i.modelId, nome: `N${i.itemId}`, sku: null, precoDescontado: i.preco, precoOriginal: i.preco * 2, quantidade: i.qtd })) });
    }
    return out;
  }

  async escrow(sn: string): Promise<EscrowPedido> {
    this.relogio.andar(this.passoMs);
    const n = ++this.chamadas.escrow;
    const e = this.onEscrow?.(sn, n); if (e) throw e;
    const p = this.pedidos.get(sn);
    if (!p || p.payTime === null) throw new ErroShopee("permanente", `escrow inexistente ${sn}`);
    return { orderSn: sn, originalShopeeDiscount: p.osd, pixDiscount: p.pix,
      itens: this.escrowItens.get(sn) ?? p.itens.map((i) => ({ itemId: i.itemId, modelId: i.modelId, voucherVendedor: i.vs, voucherShopee: i.vsh, moedas: i.coin })) };
  }
}

export interface JobFake {
  id: string; user_id: string; loja_id: string; campo_tempo: CampoTempo; janela_inicio: string; janela_fim: string;
  checkpoint: CheckpointShopee | null; progresso: ProgressoShopee | null; listagem_completa: boolean | null; status: string; erro_mensagem: string | null;
  historicoStatus: string[];
  /** Toda gravacao de listagem_completa, com o estado do cursor naquele momento. */
  historicoListagem: { completa: boolean; terminou: boolean; paginas: number }[];
}

export class RepoFake implements Repositorio {
  lojas: { id: string; user_id: string }[] = [];
  pedidos = new Map<string, Record<string, unknown>>(); // loja|sn
  itens = new Map<string, Record<string, unknown>>();   // id
  jobs = new Map<string, JobFake>();

  async lojaDoDono(userId: string, lojaId: string) { return this.lojas.some((l) => l.id === lojaId && l.user_id === userId); }
  async idsDeOutraLoja(userId: string, lojaId: string, ids: string[]) {
    return new Set(ids.filter((id) => { const r = this.itens.get(id); return r && r.user_id === userId && r.loja_id !== lojaId; }));
  }
  async gravarDetalhes(pedidos: LinhaPedidoDetalhe[], itens: LinhaItemDetalhe[]) {
    for (const p of pedidos) { const k = `${p.loja_id}|${p.order_sn}`; this.pedidos.set(k, { ...(this.pedidos.get(k) ?? {}), ...structuredClone(p) }); }
    for (const i of itens) this.itens.set(i.id, { ...(this.itens.get(i.id) ?? {}), ...structuredClone(i) });
  }
  async estadoEscrow(userId: string, lojaId: string, sns: string[]) {
    const m = new Map<string, string | null>();
    for (const sn of sns) { const p = this.pedidos.get(`${lojaId}|${sn}`); if (p && p.user_id === userId) m.set(sn, (p.escrow_update_time as string) ?? null); }
    return m;
  }
  async pedidoParaEscrow(userId: string, lojaId: string, sn: string) {
    const p = this.pedidos.get(`${lojaId}|${sn}`);
    if (!p || p.user_id !== userId) return null;
    const itens = [...this.itens.values()].filter((i) => i.user_id === userId && i.loja_id === lojaId && i.order_id === sn)
      .map((i) => ({ id: String(i.id), itemId: String(i.ml_item_id), modelId: (i.variation_id as string | null) ?? null }));
    return { updateTime: String(p.update_time), itens };
  }
  async gravarEscrow(pedido: LinhaPedidoEscrow, itens: LinhaItemEscrow[]) {
    for (const i of itens) {
      const r = this.itens.get(i.id);
      if (!r || r.user_id !== i.user_id || r.loja_id !== i.loja_id) throw new Error("escrow de item fora do dono");
      Object.assign(r, { escrow_voucher_seller: i.escrow_voucher_seller, escrow_voucher_shopee: i.escrow_voucher_shopee, escrow_coin: i.escrow_coin });
    }
    const p = this.pedidos.get(`${pedido.loja_id}|${pedido.order_sn}`);
    if (!p || p.user_id !== pedido.user_id) throw new Error("escrow de pedido fora do dono");
    Object.assign(p, { original_shopee_discount: pedido.original_shopee_discount, pix_discount: pedido.pix_discount,
      escrow_fetched_at: pedido.escrow_fetched_at, escrow_update_time: pedido.escrow_update_time });
  }
  async salvarJob(job: { id: string; userId: string; lojaId: string }, patch: Parameters<Repositorio["salvarJob"]>[1]) {
    const j = this.jobs.get(job.id);
    if (!j || j.user_id !== job.userId || j.loja_id !== job.lojaId) throw new Error("job fora do dono");
    j.checkpoint = structuredClone(patch.checkpoint); j.progresso = structuredClone(patch.progresso);
    if (patch.listagemCompleta !== undefined) {
      j.listagem_completa = patch.listagemCompleta;
      j.historicoListagem.push({ completa: patch.listagemCompleta, terminou: patch.checkpoint.listagemTerminou, paginas: patch.checkpoint.paginasLidas });
    }
    if (patch.janelaFim !== undefined) j.janela_fim = patch.janelaFim;
    if (patch.status !== undefined) { j.status = patch.status; j.historicoStatus.push(patch.status); }
    if (patch.erroMensagem !== undefined) j.erro_mensagem = patch.erroMensagem;
  }
  criarJob(j: { id: string; userId: string; lojaId: string; campoTempo: CampoTempo; inicio: string; fim: string }) {
    this.jobs.set(j.id, { id: j.id, user_id: j.userId, loja_id: j.lojaId, campo_tempo: j.campoTempo, janela_inicio: j.inicio, janela_fim: j.fim,
      checkpoint: null, progresso: null, listagem_completa: null, status: "pendente", erro_mensagem: null, historicoStatus: [], historicoListagem: [] });
  }
}
