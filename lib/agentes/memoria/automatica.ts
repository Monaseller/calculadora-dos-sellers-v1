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
  buscarFatosDoPrincipal,
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
 * O contexto DESTA conversa. Nao e memoria cross-chat.
 *
 * ── A correcao de uma afirmacao errada — F7b.4.5 ────────────────────
 *
 * Este docblock dizia: "o Zep responde com o contexto do PRINCIPAL — e
 * por isso que a preferencia dita no Chat A aparece no Chat B". Isso era
 * SUPOSICAO, e era falsa.
 *
 * MEDIDO em `scripts/medir-zep-cross-chat.ts`, contra a API real:
 *
 *   thread A, depois de ingerir "Meu nome e Douglas":
 *     `/threads/A/context` cita Douglas apos ~15 s.
 *
 *   thread B, NOVA, do MESMO principal:
 *     `/threads/B/context` continua VAZIO apos 15 s, 45 s, 90 s e 150 s.
 *
 * Ou seja: contexto de thread e memoria DA CONVERSA. Foi essa suposicao
 * que fez o Rodrigo dizer o nome num chat e o agente nao saber no
 * seguinte — e ela sobreviveu a uma suite inteira porque a suite media o
 * modulo, e nao o caminho do usuario.
 *
 * O recall entre conversas esta em `recuperarMemoriaDoDono`, que consulta
 * o GRAFO do principal.
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

/** Um fato lembrado, ja em frase. */
export interface LembrancaDoDono {
  readonly fato: string;
}

export interface MemoriaDoDono {
  readonly desfecho: DesfechoDeMemoria;
  readonly lembrancas: readonly LembrancaDoDono[];
}

/**
 * Quantos fatos entram por turno.
 *
 * Poucos de proposito: o grafo cresce sem limite, e despejar tudo faria a
 * memoria ocupar a janela que pertence as instrucoes e as fontes.
 */
export const MAX_LEMBRANCAS = 6;

/**
 * O que o agente lembra DO DONO — a memoria que atravessa conversas.
 *
 * ── Por que `pergunta` entra aqui ───────────────────────────────────
 *
 * O grafo e buscado por relevancia. Mandar a pergunta do turno e o que
 * traz "qual e meu nome?" -> o fato do nome, em vez dos seis fatos mais
 * recentes sobre qualquer coisa.
 *
 * ── E por que o resultado distingue VAZIO de DESLIGADO ──────────────
 *
 * Sao situacoes diferentes e pedem frases diferentes (§11):
 *
 *   `desligada`  o dono nao ligou memoria. O agente deve dizer isso.
 *   `ok` + zero  a memoria esta ligada e ainda nao ha o que lembrar —
 *                inclusive porque o Zep processa o grafo de forma
 *                ASSINCRONA, e um fato dito ha segundos pode nao estar
 *                indexado. Dizer "nao tenho memoria" aqui seria errado.
 *
 * Nunca inventar lembranca: sem fato, a lista volta vazia.
 */
export async function recuperarMemoriaDoDono(
  escopo: EscopoDeMemoria,
  pergunta: string
): Promise<MemoriaDoDono> {
  if (!escopo.memoriaAtiva) return { desfecho: "desligada", lembrancas: [] };
  if (!memoriaConfigurada()) return { desfecho: "nao_configurada", lembrancas: [] };

  const principal = principalDeMemoria(escopo.userId, escopo.agenteId);
  const r = await buscarFatosDoPrincipal(principal, pergunta, MAX_LEMBRANCAS);
  if (r.estado === "nao_configurado") return { desfecho: "nao_configurada", lembrancas: [] };
  if (r.estado === "falha") return { desfecho: "falha", lembrancas: [] };

  // Deduplicado por frase: o grafo pode devolver o mesmo fato por mais de
  // uma aresta, e repetir a mesma linha tres vezes so gasta janela.
  const vistas = new Set<string>();
  const lembrancas: LembrancaDoDono[] = [];
  for (const f of r.dados) {
    const chave = f.fato.toLowerCase();
    if (vistas.has(chave)) continue;
    vistas.add(chave);
    lembrancas.push({ fato: f.fato });
  }
  return { desfecho: "ok", lembrancas };
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
