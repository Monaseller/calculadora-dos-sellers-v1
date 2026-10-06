/**
 * Persistencia do motor ML — Supabase service_role. Toda leitura/escrita
 * leva `user_id` E `loja_id`. `ml_pedidos`: upsert por (loja_id, order_id)
 * — a PK inclui a loja (mesmo order_id em outra loja e outra linha) e a FK
 * (loja_id, user_id) → lojas impede linha em loja de outro dono. Antes de
 * gravar, toda linha e conferida contra o (dono, loja) do job: nada cruza.
 * Nunca toca `pedidos` (legado).
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { limitesDaJanela } from "./janelas";
import type { LinhaPedidoML, RepositorioML } from "./tipos";

const LOTE = 200;

export class ErroIsolamentoML extends Error {}

export function criarRepositorioML(cliente: SupabaseClient): RepositorioML {
  const falha = (op: string, e: { message?: string } | null) => { if (e) throw new Error(`persistencia_ml:${op}:${e.message ?? "erro"}`); };
  return {
    async lojaDoDono(userId, lojaId) {
      const { data, error } = await cliente.from("lojas").select("id")
        .eq("id", lojaId).eq("user_id", userId).eq("marketplace", "ML").eq("ativo", true).maybeSingle();
      falha("lojaDoDono", error);
      return !!data;
    },
    async gravarPedidos(userId, lojaId, linhas: LinhaPedidoML[]) {
      const fora = linhas.filter((l) => l.user_id !== userId || l.loja_id !== lojaId);
      if (fora.length) throw new ErroIsolamentoML(`linha_de_outro_dono_ou_loja:${fora.length}`);
      if (!linhas.length) return { novas: 0 };
      const existentes = new Set<string>();
      for (let i = 0; i < linhas.length; i += LOTE) {
        const { data, error } = await cliente.from("ml_pedidos").select("order_id")
          .eq("user_id", userId).eq("loja_id", lojaId).in("order_id", linhas.slice(i, i + LOTE).map((l) => l.order_id));
        falha("existentes", error);
        for (const r of (data ?? []) as { order_id: string }[]) existentes.add(r.order_id);
      }
      for (let i = 0; i < linhas.length; i += LOTE) {
        const { error } = await cliente.from("ml_pedidos").upsert(linhas.slice(i, i + LOTE), { onConflict: "loja_id,order_id" });
        falha("ml_pedidos", error);
      }
      return { novas: linhas.filter((l) => !existentes.has(l.order_id)).length };
    },
    async salvarJob(job, patch) {
      const linha: Record<string, unknown> = { checkpoint: patch.checkpoint, progresso: patch.progresso, heartbeat_em: new Date().toISOString() };
      if (patch.status !== undefined) linha.status = patch.status;
      if (patch.listagemCompleta !== undefined) linha.listagem_completa = patch.listagemCompleta;
      if (patch.erroMensagem !== undefined) linha.erro_mensagem = patch.erroMensagem;
      if (patch.status === "concluido" || patch.status === "erro") linha.concluido_em = new Date().toISOString();
      const { error } = await cliente.from("sync_jobs").update(linha)
        .eq("id", job.id).eq("user_id", job.userId).eq("loja_id", job.lojaId).eq("marketplace", "ML").eq("campo_tempo", "date_closed");
      falha("salvarJob", error);
    },
  };
}

/**
 * Cria o sync_job de DESCOBERTA de uma janela fechada (dias civis de SP).
 * campo_tempo='date_closed'; listagem_completa nasce false.
 */
export async function criarJobFechamentoML(cliente: SupabaseClient, a: { userId: string; lojaId: string; de: string; ate: string }): Promise<string> {
  const lim = limitesDaJanela(a.de, a.ate);
  if (!lim) throw new Error("janela_invalida");
  const { data, error } = await cliente.from("sync_jobs").insert({
    user_id: a.userId, loja_id: a.lojaId, marketplace: "ML", tipo: "backfill", date_from: a.de, date_to: a.ate,
    status: "pendente", campo_tempo: "date_closed", janela_inicio: lim.inicio.toISOString(), janela_fim: lim.fim.toISOString(),
    listagem_completa: false,
  }).select("id").single();
  if (error) throw new Error(`criar_job_ml:${error.message}`);
  return (data as { id: string }).id;
}
