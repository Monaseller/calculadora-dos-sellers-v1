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
  "tokens_entrada,tokens_saida,tempo_ms,envio_id,criado_em";

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
  /**
   * A identidade do ENVIO — F7b.4.8.3 §29.
   *
   * Vem do navegador, e por isso NAO e autoridade de nada: ela so serve
   * para reconhecer um reenvio do MESMO envio. O dono continua saindo da
   * sessao, e o indice unico inclui `user_id` justamente porque um id
   * gerado no cliente nao pode colidir entre pessoas.
   */
  readonly envioId?: string | null;
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
  /**
   * Grava o ASSUNTO — e SO se a conversa ainda nao tiver um — F7b.4.8.
   *
   * `is("titulo", null)` no WHERE e a idempotencia: a segunda mensagem da
   * conversa nao reescreve o assunto, e duas mensagens simultaneas nao
   * disputam. O assunto de uma conversa e o que a abriu; deixar a decima
   * mensagem redefini-lo faria a retomada citar um trecho do meio.
   */
  definirAssuntoSeVazio(
    userId: string, conversaId: string, assunto: string
  ): Promise<boolean>;
  listarMensagens(userId: string, conversaId: string): Promise<readonly Mensagem[]>;
  anexarMensagem(nova: NovaMensagem): Promise<Mensagem>;
  /**
   * O turno de um ENVIO, se ele ja existe — F7b.4.8.3 §29/§30.
   *
   * Devolve a fala do usuario e, quando ja houver, a resposta do agente.
   * `usuario: null` significa que este envio nunca chegou.
   *
   * E o que permite reenviar sem duplicar: o mesmo `envioId` encontra o
   * turno em vez de criar um segundo.
   */
  lerTurnoDoEnvio(
    userId: string, conversaId: string, envioId: string
  ): Promise<{ usuario: Mensagem | null; assistente: Mensagem | null }>;
}

/**
 * O MESMO envio chegou duas vezes — F7b.4.8.3 §30.
 *
 * Classe propria, e nao um `Error` com texto: quem trata precisa decidir
 * por identidade, e comparar mensagem de erro seria contrato por string.
 */
export class ErroEnvioDuplicado extends Error {
  readonly envioId: string;
  constructor(envioId: string) {
    super("Este envio ja criou um turno.");
    this.name = "ErroEnvioDuplicado";
    this.envioId = envioId;
  }
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

    async definirAssuntoSeVazio(userId, conversaId, assunto) {
      if (assunto.trim() === "") return false;
      const { data, error } = await supabase.from(TAB_CONVERSAS)
        .update({ titulo: assunto })
        .eq("user_id", userId).eq("id", conversaId).is("titulo", null)
        .select("id");
      // Falha aqui NAO derruba o turno: o assunto e conforto de
      // retomada, e a conversa vale sem ele.
      if (error) return false;
      return (data ?? []).length === 1;
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

    async lerTurnoDoEnvio(userId, conversaId, envioId) {
      if (!userId || !conversaId || !envioId) return { usuario: null, assistente: null };
      // O `envio_id` marca UMA linha, e so pode marcar uma: o indice unico
      // parcial `(user_id, conversa_id, envio_id)` existe justamente para
      // que dois pedidos do mesmo envio nao virem dois turnos. Ele fica na
      // fala do usuario, que e gravada primeiro.
      const { data, error } = await supabase.from(TAB_MENSAGENS).select(COL_MENSAGEM)
        .eq("user_id", userId).eq("conversa_id", conversaId).eq("envio_id", envioId)
        .order("ordem", { ascending: true }).limit(1).maybeSingle();
      // Falha de leitura NAO e ausencia: dizer "este envio nao existe"
      // sobre um banco que nao respondeu faria o turno rodar de novo — e
      // rodar de novo e exatamente o que este caminho existe para evitar.
      if (error) throw new Error(`Falha ao ler o envio: ${error.message}`);
      if (data === null) return { usuario: null, assistente: null };
      const usuario = daMensagem(data as unknown as LinhaMensagem);
      if (usuario.papel !== "usuario") return { usuario: null, assistente: null };

      // ── A resposta NAO carrega o envio, e nao pode ──────────────────
      //
      // Ela e a linha seguinte. `agente_mensagens` e append-only e a ordem
      // e estritamente crescente, entao "a resposta deste envio" e a
      // primeira mensagem depois dele — se for do assistente.
      //
      // Se a proxima for do usuario, este turno nao produziu resposta: ele
      // morreu, e herdar a resposta de outro turno seria pior que admitir
      // a ausencia.
      const seguinte = await supabase.from(TAB_MENSAGENS).select(COL_MENSAGEM)
        .eq("user_id", userId).eq("conversa_id", conversaId)
        .gt("ordem", usuario.ordem)
        .order("ordem", { ascending: true }).limit(1).maybeSingle();
      if (seguinte.error) {
        throw new Error(`Falha ao ler a resposta do envio: ${seguinte.error.message}`);
      }
      const proxima = seguinte.data === null
        ? null
        : daMensagem(seguinte.data as unknown as LinhaMensagem);
      return {
        usuario,
        assistente: proxima !== null && proxima.papel === "assistente" ? proxima : null,
      };
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
        envio_id: nova.envioId ?? null,
      }).select(COL_MENSAGEM).single();
      // ── O envio repetido nao e erro de gravacao ───────────────────
      //
      // `23505` no indice parcial de `envio_id` significa uma coisa so:
      // OUTRO pedido do MESMO envio ja criou este turno. Quem chamou
      // precisa reconciliar, e nao ver "falha ao gravar" — que e a frase
      // que este gate existe para nao dizer mais.
      //
      // A corrida e estreita e real: a tela reenvia o mesmo `envioId`
      // depois de uma falha de transporte, e esse reenvio pode chegar
      // antes de o primeiro pedido ter gravado a fala do usuario. O indice
      // e que impede o turno duplo; este erro tipado e o que permite a
      // rota responder direito quando ele age.
      if (error !== null && error.code === "23505" && nova.envioId) {
        throw new ErroEnvioDuplicado(nova.envioId);
      }
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
