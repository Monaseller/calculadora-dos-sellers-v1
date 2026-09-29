/**
 * CRUD de memoria — AGENT-FACTORY-F6.
 *
 * ── A porta, pelo mesmo motivo do F5 ────────────────────────────────
 *
 * O que precisa ser provado e ISOLAMENTO — memoria de outro dono nao e
 * lida, de outro agente nao e lida, desativada nao entra — e isso e
 * logica. O idioma do projeto para testar sem banco ja existe
 * (`PortaDeFontes`, `PortasSincronizacao`, `criarLeiturasDeVendas`).
 *
 * O que mantem honesto: o default e a implementacao real, ela filtra
 * `user_id` e `agente_id` em TODA operacao, e abaixo dela a FK composta
 * torna o vinculo cruzado impossivel.
 *
 * ── Toda ESCRITA aqui e do dono, nunca do agente ────────────────────
 *
 * Este modulo nao e alcancado por nenhum executor de Function — nao
 * existe `memoria.criar` no registry, e a suite reprova se aparecer. O
 * caminho de escrita e a UI/API, com sessao.
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Memoria } from "@/lib/agentes/memorias/tipos";

const TABELA = "agente_memorias";
const COLUNAS = "id,user_id,agente_id,conteudo,tipo,ordem,ativo,criado_em,atualizado_em";

interface LinhaMemoria {
  id: string; user_id: string; agente_id: string; conteudo: string;
  tipo: string | null; ordem: number; ativo: boolean;
  criado_em: string; atualizado_em: string;
}

export function daLinhaDeMemoria(l: LinhaMemoria): Memoria {
  return {
    id: l.id, userId: l.user_id, agenteId: l.agente_id, conteudo: l.conteudo,
    tipo: l.tipo, ordem: l.ordem, ativo: l.ativo,
    criadoEm: l.criado_em, atualizadoEm: l.atualizado_em,
  };
}

export interface NovaMemoria {
  readonly userId: string;
  readonly agenteId: string;
  readonly conteudo: string;
  readonly tipo: string | null;
  readonly ordem: number;
}

export interface AlteracaoDeMemoria {
  readonly conteudo?: string;
  readonly tipo?: string | null;
  readonly ordem?: number;
  readonly ativo?: boolean;
}

/**
 * A porta.
 *
 * `userId` e `agenteId` sao os DOIS primeiros argumentos de tudo que le
 * ou escreve, de proposito: a assinatura nao permite uma operacao sem
 * dono e sem agente. Nao existe `obterMemoria(id)`.
 */
export interface PortaDeMemorias {
  listarAtivas(userId: string, agenteId: string): Promise<readonly Memoria[]>;
  listarTodas(userId: string, agenteId: string): Promise<readonly Memoria[]>;
  criar(nova: NovaMemoria): Promise<Memoria>;
  atualizar(
    userId: string, agenteId: string, memoriaId: string, mudanca: AlteracaoDeMemoria
  ): Promise<Memoria | null>;
  remover(userId: string, agenteId: string, memoriaId: string): Promise<boolean>;
}

export function criarPortaDeMemorias(supabase: SupabaseClient): PortaDeMemorias {
  return {
    async listarAtivas(userId, agenteId) {
      const { data, error } = await supabase.from(TABELA).select(COLUNAS)
        .eq("user_id", userId).eq("agente_id", agenteId).eq("ativo", true)
        // A ordem do DONO primeiro; data so como desempate estavel.
        .order("ordem", { ascending: true })
        .order("criado_em", { ascending: true });
      if (error) throw new Error(`Falha ao ler memorias: ${error.message}`);
      return ((data ?? []) as unknown as LinhaMemoria[]).map(daLinhaDeMemoria);
    },

    async listarTodas(userId, agenteId) {
      const { data, error } = await supabase.from(TABELA).select(COLUNAS)
        .eq("user_id", userId).eq("agente_id", agenteId)
        .order("ordem", { ascending: true })
        .order("criado_em", { ascending: true });
      if (error) throw new Error(`Falha ao ler memorias: ${error.message}`);
      return ((data ?? []) as unknown as LinhaMemoria[]).map(daLinhaDeMemoria);
    },

    async criar(nova) {
      const { data, error } = await supabase.from(TABELA).insert({
        user_id: nova.userId, agente_id: nova.agenteId, conteudo: nova.conteudo,
        tipo: nova.tipo, ordem: nova.ordem, ativo: true,
      }).select(COLUNAS).single();
      if (error) throw new Error(`Falha ao criar memoria: ${error.message}`);
      return daLinhaDeMemoria(data as unknown as LinhaMemoria);
    },

    async atualizar(userId, agenteId, memoriaId, mudanca) {
      const campos: Record<string, unknown> = { atualizado_em: new Date().toISOString() };
      if (mudanca.conteudo !== undefined) campos.conteudo = mudanca.conteudo;
      if (mudanca.tipo !== undefined) campos.tipo = mudanca.tipo;
      if (mudanca.ordem !== undefined) campos.ordem = mudanca.ordem;
      if (mudanca.ativo !== undefined) campos.ativo = mudanca.ativo;

      const { data, error } = await supabase.from(TABELA).update(campos)
        .eq("user_id", userId).eq("agente_id", agenteId).eq("id", memoriaId)
        .select(COLUNAS).maybeSingle();
      if (error) throw new Error(`Falha ao atualizar memoria: ${error.message}`);
      return data ? daLinhaDeMemoria(data as unknown as LinhaMemoria) : null;
    },

    async remover(userId, agenteId, memoriaId) {
      // Apaga de verdade, diferente de `agente_fontes`. A razao e a
      // diferenca entre as duas coisas: um total calculado a partir de
      // uma FONTE precisa que a fonte continue explicavel, enquanto uma
      // preferencia removida nao explica numero nenhum. Guardar texto
      // que o dono mandou apagar seria guardar por guardar.
      const { data, error } = await supabase.from(TABELA).delete()
        .eq("user_id", userId).eq("agente_id", agenteId).eq("id", memoriaId)
        .select("id");
      if (error) throw new Error(`Falha ao remover memoria: ${error.message}`);
      return (data ?? []).length === 1;
    },
  };
}
