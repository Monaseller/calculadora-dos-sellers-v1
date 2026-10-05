/**
 * Persistencia do motor de ingestao Shopee (S2-D2) — Supabase service_role.
 *
 * Toda escrita/leitura carrega `user_id` E `loja_id`. Upserts:
 *   shopee_pedidos  onConflict (loja_id, order_sn) — mesma ordem, nunca duplica;
 *   pedidos         onConflict id                   — chave de item existente.
 * Upserts sao por COLUNA: o DETAIL nao toca campos de escrow e o ESCROW nao
 * toca campos de detail; colunas antigas de `pedidos` (custos, financeiro
 * legado) ficam intactas. Nada aqui apaga pedido.
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { chaveItemLoja, idItem, resolverIdsDeItens } from "./normalizar";
import type { LinhaItemDetalhe, LinhaItemEscrow, LinhaPedidoDetalhe, LinhaPedidoEscrow, Repositorio } from "./tipos";

const LOTE = 200;

export function criarRepositorioSupabase(cliente: SupabaseClient): Repositorio {
  const falha = (op: string, e: { message?: string } | null) => { if (e) throw new Error(`persistencia:${op}:${e.message ?? "erro"}`); };
  return {
    async lojaDoDono(userId, lojaId) {
      const { data, error } = await cliente.from("lojas").select("id")
        .eq("id", lojaId).eq("user_id", userId).eq("marketplace", "Shopee").eq("ativo", true).maybeSingle();
      falha("lojaDoDono", error);
      return !!data;
    },
    async gravarDetalhes(pedidos: LinhaPedidoDetalhe[], itensBrutos: LinhaItemDetalhe[]) {
      for (let i = 0; i < pedidos.length; i += LOTE) {
        const { error } = await cliente.from("shopee_pedidos").upsert(pedidos.slice(i, i + LOTE), { onConflict: "loja_id,order_sn" });
        falha("shopee_pedidos", error);
      }
      if (itensBrutos.length === 0) return;
      // Um job = uma loja (o motor garante): todos os itens tem o mesmo dono/loja.
      const { user_id: userId, loja_id: lojaId } = itensBrutos[0];
      // 1) linhas JA existentes desta loja, pela chave (pedido, item, variacao)
      const existentes = new Map<string, string>();
      const sns = [...new Set(itensBrutos.map((i) => i.order_id))];
      for (let i = 0; i < sns.length; i += LOTE) {
        const { data, error } = await cliente.from("pedidos").select("id, order_id, ml_item_id, variation_id")
          .eq("user_id", userId).eq("marketplace", "Shopee").eq("loja_id", lojaId).in("order_id", sns.slice(i, i + LOTE));
        falha("itensExistentes", error);
        for (const r of (data ?? []) as { id: string; order_id: string; ml_item_id: string; variation_id: string | null }[]) {
          existentes.set(chaveItemLoja(lojaId, r.order_id, String(r.ml_item_id), r.variation_id ?? null), r.id);
        }
      }
      // 2) ids legados ja ocupados (por outra loja do mesmo dono)
      const legados = itensBrutos
        .filter((it) => !existentes.has(chaveItemLoja(lojaId, it.order_id, it.ml_item_id, it.variation_id)))
        .map((it) => idItem(userId, it.order_id, it.ml_item_id, it.variation_id));
      const ocupados = new Set<string>();
      for (let i = 0; i < legados.length; i += LOTE) {
        const { data, error } = await cliente.from("pedidos").select("id").eq("user_id", userId).in("id", legados.slice(i, i + LOTE));
        falha("idsOcupados", error);
        for (const r of (data ?? []) as { id: string }[]) ocupados.add(r.id);
      }
      // 3) upsert por id ja resolvido pela chave da loja: nunca move linha de loja
      const itens = resolverIdsDeItens(itensBrutos, existentes, ocupados);
      for (let i = 0; i < itens.length; i += LOTE) {
        const { error } = await cliente.from("pedidos").upsert(itens.slice(i, i + LOTE), { onConflict: "id" });
        falha("pedidos", error);
      }
    },
    async pendentesEscrow(userId, lojaId, apos, limite) {
      let q = cliente.from("shopee_pedidos").select("order_sn")
        .eq("user_id", userId).eq("loja_id", lojaId).eq("escrow_pendente", true);
      if (apos !== null) q = q.gt("order_sn", apos);
      const { data, error } = await q.order("order_sn", { ascending: true }).limit(limite);
      falha("pendentesEscrow", error);
      return ((data ?? []) as { order_sn: string }[]).map((r) => r.order_sn);
    },
    async estadoEscrow(userId, lojaId, orderSns) {
      const out = new Map<string, string | null>();
      for (let i = 0; i < orderSns.length; i += LOTE) {
        const { data, error } = await cliente.from("shopee_pedidos").select("order_sn, escrow_update_time")
          .eq("user_id", userId).eq("loja_id", lojaId).in("order_sn", orderSns.slice(i, i + LOTE));
        falha("estadoEscrow", error);
        for (const r of (data ?? []) as { order_sn: string; escrow_update_time: string | null }[]) out.set(r.order_sn, r.escrow_update_time);
      }
      return out;
    },
    async pedidoParaEscrow(userId, lojaId, orderSn) {
      const { data: p, error } = await cliente.from("shopee_pedidos").select("update_time")
        .eq("user_id", userId).eq("loja_id", lojaId).eq("order_sn", orderSn).maybeSingle();
      falha("pedidoParaEscrow", error);
      if (!p) return null;
      const { data: its, error: e2 } = await cliente.from("pedidos").select("id, ml_item_id, variation_id")
        .eq("user_id", userId).eq("loja_id", lojaId).eq("marketplace", "Shopee").eq("order_id", orderSn);
      falha("itensParaEscrow", e2);
      return {
        updateTime: String((p as { update_time: string }).update_time),
        itens: ((its ?? []) as { id: string; ml_item_id: string; variation_id: string | null }[])
          .map((r) => ({ id: r.id, itemId: String(r.ml_item_id), modelId: r.variation_id ?? null })),
      };
    },
    async gravarEscrow(pedido: LinhaPedidoEscrow, itens: LinhaItemEscrow[]) {
      // itens primeiro: o pedido so fica "com escrow atual" depois que os
      // componentes por item ja estao gravados.
      for (const it of itens) {
        const { error } = await cliente.from("pedidos")
          .update({ escrow_voucher_seller: it.escrow_voucher_seller, escrow_voucher_shopee: it.escrow_voucher_shopee, escrow_coin: it.escrow_coin })
          .eq("id", it.id).eq("user_id", it.user_id).eq("loja_id", it.loja_id);
        falha("escrowItem", error);
      }
      const { error } = await cliente.from("shopee_pedidos")
        .update({ original_shopee_discount: pedido.original_shopee_discount, pix_discount: pedido.pix_discount,
          escrow_fetched_at: pedido.escrow_fetched_at, escrow_update_time: pedido.escrow_update_time })
        .eq("user_id", pedido.user_id).eq("loja_id", pedido.loja_id).eq("order_sn", pedido.order_sn);
      falha("escrowPedido", error);
    },
    async salvarJob(job, patch) {
      const linha: Record<string, unknown> = {
        checkpoint: patch.checkpoint, progresso: patch.progresso, heartbeat_em: new Date().toISOString(),
      };
      if (patch.listagemCompleta !== undefined) linha.listagem_completa = patch.listagemCompleta;
      if (patch.janelaFim !== undefined) linha.janela_fim = patch.janelaFim;
      if (patch.status !== undefined) linha.status = patch.status;
      if (patch.erroMensagem !== undefined) linha.erro_mensagem = patch.erroMensagem;
      if (patch.status === "concluido" || patch.status === "erro") linha.concluido_em = new Date().toISOString();
      const { error } = await cliente.from("sync_jobs").update(linha)
        .eq("id", job.id).eq("user_id", job.userId).eq("loja_id", job.lojaId).eq("marketplace", "Shopee");
      falha("salvarJob", error);
    },
  };
}
