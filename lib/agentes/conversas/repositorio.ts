/**
 * Leitura e escrita de conversas — AGENT-FACTORY-F7a.
 *
 * ── A porta, pela mesma razao do F5 e do F6 ─────────────────────────
 *
 * O que precisa ser provado e ISOLAMENTO — conversa de outro dono nao
 * e lida, mensagem nao vaza entre conversas, historico de A nao aparece
 * em B. Isso e logica, e o idioma do projeto para testar sem banco ja
 * existe (`PortaDeFontes`, `PortaDeMemorias`).
 *
 * O default e a implementacao real, que filtra `user_id` em TODA
 * operacao; embaixo dela, a FK composta torna o vinculo cruzado
 * impossivel.
 *
 * ── `ordem` e calculada no servidor, nunca recebida ─────────────────
 *
 * O cliente nao manda posicao. Se mandasse, duas abas do mesmo chat
 * escreveriam na mesma posicao e uma sobrescreveria a outra — ou o
 * UNIQUE (conversa_id, ordem) recusaria a segunda e o usuario perderia
 * a mensagem sem entender. Aqui a proxima posicao e lida na hora.
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  Conversa, Mensagem, PapelDeMensagem, PassoRegistrado,
} from "@/lib/agentes/conversas/tipos";

const TAB_CONVERSAS = "agente_conversas";
const TAB_MENSAGENS = "agente_mensagens";

const COL_CONVERSA = "id,user_id,agente_id,titulo,arquivada,criado_em,atualizado_em";
const COL_MENSAGEM =
  "id,user_id,conversa_id,papel,conteudo,ordem,passos,provedor,modelo," +
  "tokens_entrada,tokens_saida,tempo_ms,criado_em";

interface LinhaConversa {
  id: string; user_id: string; agente_id: string; titulo: string | null;
  arquivada: boolean; criado_em: string; atualizado_em: string;
}
interface LinhaMensagem {
  id: string; user_id: string; conversa_id: string; papel: string; conteudo: string;
  ordem: number; passos: PassoRegistrado[] | null; provedor: string | null;
  modelo: string | null; tokens_entrada: number | null; tokens_saida: number | null;
  tempo_ms: number | null; criado_em: string;
}

function daConversa(l: LinhaConversa): Conversa {
  return {
    id: l.id, userId: l.user_id, agenteId: l.agente_id, titulo: l.titulo,
    arquivada: l.arquivada, criadoEm: l.criado_em, atualizadoEm: l.atualizado_em,
  };
}
function daMensagem(l: LinhaMensagem): Mensagem {
  return {
    id: l.id, userId: l.user_id, conversaId: l.conversa_id,
    papel: l.papel as PapelDeMensagem, conteudo: l.conteudo, ordem: l.ordem,
    passos: l.passos, provedor: l.provedor, modelo: l.modelo,
    tokensEntrada: l.tokens_entrada, tokensSaida: l.tokens_saida,
    tempoMs: l.tempo_ms, criadoEm: l.criado_em,
  };
}

export interface NovaMensagem {
  readonly userId: string;
  readonly conversaId: string;
  readonly papel: PapelDeMensagem;
  readonly conteudo: string;
  readonly passos?: readonly PassoRegistrado[] | null;
  readonly provedor?: string | null;
  readonly modelo?: string | null;
  readonly tokensEntrada?: number | null;
  readonly tokensSaida?: number | null;
  readonly tempoMs?: number | null;
}

/**
 * A porta.
 *
 * `userId` e o PRIMEIRO argumento de tudo. Nao existe
 * `obterConversa(id)` nem `listarMensagens(conversaId)` sem dono — a
 * assinatura nao permite.
 */
export interface PortaDeConversas {
  criarConversa(userId: string, agenteId: string, titulo: string | null): Promise<Conversa>;
  obterConversa(userId: string, conversaId: string): Promise<Conversa | null>;
  listarConversas(userId: string, agenteId: string): Promise<readonly Conversa[]>;
  arquivarConversa(userId: string, conversaId: string): Promise<boolean>;
  listarMensagens(userId: string, conversaId: string): Promise<readonly Mensagem[]>;
  anexarMensagem(nova: NovaMensagem): Promise<Mensagem>;
}

export function criarPortaDeConversas(supabase: SupabaseClient): PortaDeConversas {
  async function proximaOrdem(userId: string, conversaId: string): Promise<number> {
    const { data, error } = await supabase.from(TAB_MENSAGENS)
      .select("ordem").eq("user_id", userId).eq("conversa_id", conversaId)
      .order("ordem", { ascending: false }).limit(1).maybeSingle();
    if (error) throw new Error(`Falha ao ler a ordem: ${error.message}`);
    return data ? ((data as { ordem: number }).ordem + 1) : 0;
  }

  return {
    async criarConversa(userId, agenteId, titulo) {
      const { data, error } = await supabase.from(TAB_CONVERSAS)
        .insert({ user_id: userId, agente_id: agenteId, titulo })
        .select(COL_CONVERSA).single();
      if (error) throw new Error(`Falha ao criar conversa: ${error.message}`);
      return daConversa(data as unknown as LinhaConversa);
    },

    async obterConversa(userId, conversaId) {
      const { data, error } = await supabase.from(TAB_CONVERSAS).select(COL_CONVERSA)
        .eq("user_id", userId).eq("id", conversaId).maybeSingle();
      if (error) throw new Error(`Falha ao ler conversa: ${error.message}`);
      return data ? daConversa(data as unknown as LinhaConversa) : null;
    },

    async listarConversas(userId, agenteId) {
      const { data, error } = await supabase.from(TAB_CONVERSAS).select(COL_CONVERSA)
        .eq("user_id", userId).eq("agente_id", agenteId).eq("arquivada", false)
        .order("atualizado_em", { ascending: false });
      if (error) throw new Error(`Falha ao listar conversas: ${error.message}`);
      return ((data ?? []) as unknown as LinhaConversa[]).map(daConversa);
    },

    async arquivarConversa(userId, conversaId) {
      // Arquiva, nao apaga: o historico continua explicavel. Apagar de
      // verdade e acao do dono, e ai o CASCADE leva as mensagens.
      const { data, error } = await supabase.from(TAB_CONVERSAS)
        .update({ arquivada: true, atualizado_em: new Date().toISOString() })
        .eq("user_id", userId).eq("id", conversaId).eq("arquivada", false)
        .select("id");
      if (error) throw new Error(`Falha ao arquivar: ${error.message}`);
      return (data ?? []).length === 1;
    },

    async listarMensagens(userId, conversaId) {
      const { data, error } = await supabase.from(TAB_MENSAGENS).select(COL_MENSAGEM)
        .eq("user_id", userId).eq("conversa_id", conversaId)
        .order("ordem", { ascending: true });
      if (error) throw new Error(`Falha ao ler mensagens: ${error.message}`);
      return ((data ?? []) as unknown as LinhaMensagem[]).map(daMensagem);
    },

    async anexarMensagem(nova) {
      const ordem = await proximaOrdem(nova.userId, nova.conversaId);
      const { data, error } = await supabase.from(TAB_MENSAGENS).insert({
        user_id: nova.userId, conversa_id: nova.conversaId, papel: nova.papel,
        conteudo: nova.conteudo, ordem,
        passos: nova.passos ?? null,
        provedor: nova.provedor ?? null, modelo: nova.modelo ?? null,
        tokens_entrada: nova.tokensEntrada ?? null,
        tokens_saida: nova.tokensSaida ?? null,
        tempo_ms: nova.tempoMs ?? null,
      }).select(COL_MENSAGEM).single();
      if (error) throw new Error(`Falha ao gravar mensagem: ${error.message}`);

      // A conversa sobe na lista. Sem trigger: o projeto nao tem esse
      // padrao, e quem escreve atualiza a mao.
      await supabase.from(TAB_CONVERSAS)
        .update({ atualizado_em: new Date().toISOString() })
        .eq("user_id", nova.userId).eq("id", nova.conversaId);

      return daMensagem(data as unknown as LinhaMensagem);
    },
  };
}
