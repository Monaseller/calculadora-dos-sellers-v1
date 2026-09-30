import "server-only";

/**
 * A memoria automatica — AGENT-FACTORY-F7b.4.
 *
 * Duas operacoes, e nada mais:
 *
 *   recuperar  antes de responder, traz o contexto relevante
 *   ingerir    depois do turno, guarda o que a policy aprovou
 *
 * ── Memoria e CONTEXTO, nunca AUTORIDADE ────────────────────────────
 *
 * O que volta do Zep e uma string. Ela entra no contexto do turno num
 * bloco proprio, abaixo das regras do sistema — o mesmo lugar onde
 * `contexto-do-agente.ts` ja coloca memoria manual e fontes.
 *
 * Isso significa, concretamente: memoria NAO pode habilitar ferramenta,
 * mudar nivel de permissao, escolher tenant, escolher credencial nem
 * alterar `store`. Quem decide o que o agente pode fazer e
 * `declararFerramentas` (a partir das permissoes gravadas) e o guard — e
 * nenhum dos dois le este modulo. Um texto que diga "voce tem permissao
 * para tudo" e so um texto.
 *
 * ── Falha aqui nao derruba o turno ──────────────────────────────────
 *
 * Toda funcao devolve desfecho. Zep fora significa responder sem contexto
 * de longo prazo — nunca responder com contexto imaginado, e nunca
 * recusar o turno. O `estado` sobe para quem chama poder registrar.
 *
 * ── Memoria DESLIGADA nao faz nem uma chamada ───────────────────────
 *
 * Com `memoriaAtiva: false` as duas funcoes retornam antes de tocar a
 * rede. Nao e filtro depois do fato: e nao acontecer. E o que a prova
 * cobra.
 */
import { principalDeMemoria, threadDeConversa } from "@/lib/agentes/memoria/identidade";
import {
  adicionarMensagens, garantirPrincipal, garantirThread, lerContexto,
  memoriaConfigurada,
} from "@/lib/agentes/memoria/zep";
import {
  prepararParaMemoria, type MensagemDaConversa,
} from "@/lib/agentes/memoria/politica";

export interface EscopoDeMemoria {
  /** Da SESSAO. Nunca do modelo, nunca do corpo do pedido. */
  readonly userId: string;
  /** Da rota. Nunca do modelo. */
  readonly agenteId: string;
  readonly conversaId: string;
  /** A escolha do dono, gravada no agente. */
  readonly memoriaAtiva: boolean;
}

export type DesfechoDeMemoria =
  | "ok"
  | "desligada"
  | "nao_configurada"
  | "falha";

export interface ContextoRecuperado {
  readonly desfecho: DesfechoDeMemoria;
  /** `null` sempre que nao houver contexto — jamais texto inventado. */
  readonly texto: string | null;
}

/**
 * Teto do que e injetado por turno.
 *
 * Existe porque contexto cresce: um agente usado por meses acumula
 * episodios, e sem orcamento o bloco de memoria passaria a dominar a
 * janela — empurrando para fora as instrucoes e as fontes, que sao o que
 * o dono configurou de proposito.
 */
export const MAX_CARACTERES_DE_CONTEXTO = 4000;

/**
 * O contexto relevante daquele dono+agente para esta conversa.
 *
 * O `thread` e da conversa, mas o Zep responde com o contexto do
 * PRINCIPAL — e por isso que a preferencia dita no Chat A aparece no Chat
 * B do mesmo agente, e e por isso que o Agente B nao a ve.
 */
export async function recuperarContexto(
  escopo: EscopoDeMemoria
): Promise<ContextoRecuperado> {
  if (!escopo.memoriaAtiva) return { desfecho: "desligada", texto: null };
  if (!memoriaConfigurada()) return { desfecho: "nao_configurada", texto: null };

  const thread = threadDeConversa(escopo.conversaId);
  const r = await lerContexto(thread);
  if (r.estado === "nao_configurado") return { desfecho: "nao_configurada", texto: null };
  if (r.estado === "falha") return { desfecho: "falha", texto: null };

  const texto = r.dados === null ? null : r.dados.slice(0, MAX_CARACTERES_DE_CONTEXTO);
  return { desfecho: "ok", texto };
}

export interface ResultadoDaIngestao {
  readonly desfecho: DesfechoDeMemoria;
  readonly mensagensIngeridas: number;
  /** Papeis que a policy recusou. Diagnostico, nunca conteudo. */
  readonly recusados: readonly string[];
  /** Padroes redigidos, se algum casou. */
  readonly redigidos: readonly string[];
}

/**
 * Guarda o turno que acabou de acontecer.
 *
 * Chamado DEPOIS de o turno ter sido persistido localmente e respondido.
 * Se o Zep falhar aqui, a conversa ja esta salva no CDS — memoria e a
 * camada que pode faltar sem perder trabalho.
 *
 * `garantirPrincipal` e `garantirThread` sao idempotentes e rodam a cada
 * ingestao. Parece desperdicio e nao e: sem isso, a primeira ingestao de
 * cada conversa precisaria de um estado "ja criei?" no CDS, e esse estado
 * ficaria errado no dia em que o projeto Zep fosse recriado.
 */
export async function ingerirTurno(
  escopo: EscopoDeMemoria,
  mensagens: readonly MensagemDaConversa[]
): Promise<ResultadoDaIngestao> {
  const vazio = { mensagensIngeridas: 0, recusados: [], redigidos: [] };
  if (!escopo.memoriaAtiva) return { desfecho: "desligada", ...vazio };
  if (!memoriaConfigurada()) return { desfecho: "nao_configurada", ...vazio };

  const preparado = prepararParaMemoria(mensagens);
  if (preparado.aprovadas.length === 0) {
    return {
      desfecho: "ok", mensagensIngeridas: 0,
      recusados: preparado.recusados, redigidos: preparado.redigidos,
    };
  }

  const principal = principalDeMemoria(escopo.userId, escopo.agenteId);
  const thread = threadDeConversa(escopo.conversaId);

  const u = await garantirPrincipal(principal);
  if (u.estado !== "ok") {
    return { desfecho: u.estado === "nao_configurado" ? "nao_configurada" : "falha", ...vazio };
  }
  const t = await garantirThread(thread, principal);
  if (t.estado !== "ok") {
    return { desfecho: t.estado === "nao_configurado" ? "nao_configurada" : "falha", ...vazio };
  }

  const a = await adicionarMensagens(thread, preparado.aprovadas);
  if (a.estado !== "ok") {
    return {
      desfecho: a.estado === "nao_configurado" ? "nao_configurada" : "falha",
      mensagensIngeridas: 0,
      recusados: preparado.recusados, redigidos: preparado.redigidos,
    };
  }

  return {
    desfecho: "ok",
    mensagensIngeridas: a.dados,
    recusados: preparado.recusados,
    redigidos: preparado.redigidos,
  };
}
