/**
 * Leitura e escrita de fontes — AGENT-FACTORY-F5.
 *
 * ── A PORTA existe para que a prova nao dependa de Postgres ─────────
 *
 * O que precisa ser provado aqui e ISOLAMENTO: fonte de outro dono nao
 * e lida, fonte de outro agente nao e lida, fonte desativada nao e
 * lida. Isso e logica, e o idioma do projeto para testa-la sem banco ja
 * existe — `PortasSincronizacao`, `criarLeiturasDeVendas`,
 * `ObterAdaptadorDeConversa`.
 *
 * O que mantem a porta honesta e o DEFAULT ser a implementacao real e
 * ela SEMPRE filtrar por `user_id`. E, abaixo dela, o banco tem a
 * segunda tranca: a FK composta `(user_id, agente_id)` torna o vinculo
 * cruzado impossivel, nao apenas proibido.
 *
 * ── `caminhoObjeto` nao sobe para o dominio ─────────────────────────
 *
 * As consultas trazem o caminho porque o resolvedor precisa dele para
 * baixar os bytes — e ele morre ali. `Fonte` (o tipo de dominio) nao
 * tem esse campo, entao nao existe caminho para vazar em resposta de
 * Tool, em log ou em prompt: o tipo nao permite.
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  baixarObjetoDaFonte,
  enviarObjetoDaFonte,
  montarCaminhoDaFonte,
} from "@/lib/agentes/fontes/armazenamento";
import type { EscopoDeFonte, Fonte, TipoDeFonte } from "@/lib/agentes/fontes/tipos";

const TABELA = "agente_fontes";

/** A fonte com o endereco fisico — SO dentro desta camada. */
export interface FonteComCaminho extends Fonte {
  readonly caminhoObjeto: string;
}

export interface NovaFonte {
  readonly userId: string;
  readonly escopo: EscopoDeFonte;
  readonly agenteId: string | null;
  readonly conversaId: string | null;
  readonly nome: string;
  readonly descricao: string | null;
  readonly papel: string | null;
  readonly tipo: TipoDeFonte;
  readonly mime: string;
  readonly bytes: Uint8Array;
  readonly hashSha256: string;
  readonly substituiId: string | null;
}

/**
 * A porta.
 *
 * Toda operacao leva `userId` como PRIMEIRO argumento, de proposito: a
 * assinatura nao permite uma leitura sem dono. Nao existe
 * `obterFonte(id)`.
 */
export interface PortaDeFontes {
  /** Fonte ATIVA do dono, opcionalmente presa a um agente. */
  obterAtiva(
    userId: string,
    fonteId: string,
    vinculo?: { readonly agenteId: string } | { readonly conversaId: string }
  ): Promise<FonteComCaminho | null>;
  listarDoAgente(userId: string, agenteId: string): Promise<readonly Fonte[]>;
  listarDaConversa(userId: string, conversaId: string): Promise<readonly Fonte[]>;
  criar(nova: NovaFonte): Promise<Fonte>;
  desativar(userId: string, fonteId: string): Promise<boolean>;
  lerBytes(caminhoObjeto: string): Promise<Uint8Array>;
}

const COLUNAS =
  "id,user_id,agente_id,conversa_id,escopo,nome,descricao,papel,tipo,mime," +
  "tamanho_bytes,hash_sha256,caminho_objeto,ativo,substitui_id,criado_em";

interface LinhaFonte {
  id: string; user_id: string; agente_id: string | null; conversa_id: string | null;
  escopo: string; nome: string; descricao: string | null; papel: string | null;
  tipo: string; mime: string; tamanho_bytes: number; hash_sha256: string;
  caminho_objeto: string; ativo: boolean; substitui_id: string | null; criado_em: string;
}

function daLinha(l: LinhaFonte): FonteComCaminho {
  return {
    id: l.id, userId: l.user_id, agenteId: l.agente_id, conversaId: l.conversa_id,
    escopo: l.escopo as EscopoDeFonte, nome: l.nome, descricao: l.descricao,
    papel: l.papel, tipo: l.tipo as TipoDeFonte, mime: l.mime,
    tamanhoBytes: l.tamanho_bytes, hashSha256: l.hash_sha256,
    caminhoObjeto: l.caminho_objeto, ativo: l.ativo, substituiId: l.substitui_id,
    criadoEm: l.criado_em,
  };
}

/** Tira o caminho fisico antes de a fonte sair desta camada. */
export function semCaminho(f: FonteComCaminho): Fonte {
  const { caminhoObjeto, ...resto } = f;
  void caminhoObjeto;
  return resto;
}

export function criarPortaDeFontes(supabase: SupabaseClient): PortaDeFontes {
  return {
    async obterAtiva(userId, fonteId, vinculo) {
      // `user_id` e `ativo` SEMPRE na consulta. Nao ha caminho de codigo
      // que leia uma fonte sem os dois.
      let q = supabase.from(TABELA).select(COLUNAS)
        .eq("user_id", userId).eq("id", fonteId).eq("ativo", true);
      if (vinculo && "agenteId" in vinculo) q = q.eq("agente_id", vinculo.agenteId);
      if (vinculo && "conversaId" in vinculo) q = q.eq("conversa_id", vinculo.conversaId);
      const { data, error } = await q.maybeSingle();
      if (error) throw new Error(`Falha ao ler fonte: ${error.message}`);
      return data ? daLinha(data as unknown as LinhaFonte) : null;
    },

    async listarDoAgente(userId, agenteId) {
      const { data, error } = await supabase.from(TABELA).select(COLUNAS)
        .eq("user_id", userId).eq("agente_id", agenteId)
        .eq("escopo", "agente").eq("ativo", true)
        .order("criado_em", { ascending: true });
      if (error) throw new Error(`Falha ao listar fontes: ${error.message}`);
      return ((data ?? []) as unknown as LinhaFonte[]).map((l) => semCaminho(daLinha(l)));
    },

    async listarDaConversa(userId, conversaId) {
      const { data, error } = await supabase.from(TABELA).select(COLUNAS)
        .eq("user_id", userId).eq("conversa_id", conversaId)
        .eq("escopo", "conversa").eq("ativo", true)
        .order("criado_em", { ascending: true });
      if (error) throw new Error(`Falha ao listar anexos: ${error.message}`);
      return ((data ?? []) as unknown as LinhaFonte[]).map((l) => semCaminho(daLinha(l)));
    },

    async criar(nova) {
      // Ordem deliberada: a LINHA nasce primeiro, com o caminho que ela
      // mesma determina, e so entao os bytes sobem. Se o upload falhar,
      // sobra uma linha sem objeto — detectavel e limpavel. O inverso
      // (subir antes) deixaria bytes orfaos que ninguem sabe que
      // existem, e e o pior dos dois lados.
      const id = crypto.randomUUID();
      const caminho = montarCaminhoDaFonte({
        userId: nova.userId,
        escopo: nova.escopo,
        vinculoId: (nova.agenteId ?? nova.conversaId) as string,
        fonteId: id,
        nomeOriginal: nova.nome,
        tipo: nova.tipo,
      });

      const { data, error } = await supabase.from(TABELA).insert({
        id, user_id: nova.userId, agente_id: nova.agenteId, conversa_id: nova.conversaId,
        escopo: nova.escopo, nome: nova.nome, descricao: nova.descricao, papel: nova.papel,
        tipo: nova.tipo, mime: nova.mime, tamanho_bytes: nova.bytes.length,
        hash_sha256: nova.hashSha256, caminho_objeto: caminho, ativo: true,
        substitui_id: nova.substituiId,
      }).select(COLUNAS).single();
      if (error) throw new Error(`Falha ao registrar fonte: ${error.message}`);

      await enviarObjetoDaFonte(supabase, caminho, nova.bytes, nova.tipo);
      return semCaminho(daLinha(data as unknown as LinhaFonte));
    },

    async desativar(userId, fonteId) {
      // Desativa, NAO apaga. Um total calculado ontem continua
      // explicavel: o hash e o registro seguem la. Ver secao 5 da
      // migration.
      const { data, error } = await supabase.from(TABELA)
        .update({ ativo: false, atualizado_em: new Date().toISOString() })
        .eq("user_id", userId).eq("id", fonteId).eq("ativo", true)
        .select("id");
      if (error) throw new Error(`Falha ao desativar fonte: ${error.message}`);
      return (data ?? []).length === 1;
    },

    async lerBytes(caminhoObjeto) {
      return baixarObjetoDaFonte(supabase, caminhoObjeto);
    },
  };
}
