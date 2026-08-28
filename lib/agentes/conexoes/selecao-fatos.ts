/**
 * Leitura autorizada da selecao explicita de loja — SKILL-1D.g.1-C.
 *
 * ── A pergunta que este modulo responde ─────────────────────────────
 *
 *   "para cada requisito de conexao, QUAL loja o dono escolheu?"
 *
 * E o elo que faltava. `resolverFatoConexao` EXIGE um `lojaId` e se
 * recusa, por escrito, a escolher — "a selecao pertence a camada de
 * cima". Ate agora ninguem persistia essa escolha, e por isso a
 * SKILL-1D.e nao conseguia montar `FatoConexao[]`.
 *
 * ── O que este modulo NAO faz ───────────────────────────────────────
 *
 * Nao escreve: nao ha `.insert(`, `.update(`, `.upsert(` nem `.delete(`
 * — o write path e fase propria. Nao chama `resolverFatoConexao`: dizer
 * QUAL loja e outra pergunta que dizer se ela FUNCIONA, e compor as duas
 * e do agregador futuro. Nao le token, `access_token`, `refresh_token`
 * nem `partner_key`: esta camada resolve configuracao, nao credencial, e
 * o segredo nao tem por que passar por aqui.
 *
 * E, acima de tudo, nao ESCOLHE. Nenhuma loja "compativel", nenhuma
 * "primeira", nenhuma "unica". Ausencia persistida continua ausencia.
 *
 * ── Autoridade fechada duas vezes ───────────────────────────────────
 *
 * QUERY 1 filtra `agente_id` + `user_id`. QUERY 2 filtra `user_id` DE
 * NOVO, alem do `IN (ids)`. O segundo filtro nao e redundancia: a FK
 * composta garante que o par (loja, dono) e coerente, nao que ele seja o
 * par do dono da sessao. Um `IN (ids)` sozinho aceitaria um uuid alheio
 * que tivesse vazado.
 */
import "server-only";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";
import {
  confirmarLojas,
  filtrosLojasDoDono,
  filtrosSelecoesDoAgente,
  lojaIdsDistintos,
  ordenarSelecoes,
  type ColetaSelecoes,
  type LinhaLoja,
  type LinhaSelecao,
  type Selecao,
} from "@/lib/agentes/conexoes/selecao-estado";

/**
 * Projecoes MINIMAS.
 *
 * QUERY 1 traz `agente_id` e `user_id` — ao contrario de `skills/fatos`,
 * onde eles ficam de fora. A diferenca e proposital: aqui eles voltam
 * para serem CONFERIDOS em `ordenarSelecoes`, como defesa em
 * profundidade sobre o que o cliente devolveu. `criado_em` e
 * `alterado_em` nao entram: nenhuma decisao desta camada depende deles.
 *
 * QUERY 2 traz `id` e `user_id`, e nada mais. Sem `access_token`,
 * `token_expires_at`, `marketplace` ou `ativo` — tudo isso e insumo de
 * `resolverFatoConexao`, e projetar credencial numa camada que nao
 * precisa dela seria criar exposicao sem motivo.
 */
const COLUNAS_SELECAO = "agente_id, user_id, plataforma, recurso, loja_id";
const COLUNAS_LOJA = "id, user_id";

/**
 * Dois campos, e a lista curta e a defesa: nao ha `lojaId`, `plataforma`,
 * `recurso`, token nem credencial — nada disso e autoridade, e nada
 * disso e fornecido de fora.
 */
export interface EntradaSelecoesDoAgente {
  userId: string;
  agenteId: string;
}

export interface ResultadoSelecoesDoAgente {
  selecoes: readonly Selecao[];
  coleta: ColetaSelecoes;
}

const VAZIO: ResultadoSelecoesDoAgente = Object.freeze({
  selecoes: Object.freeze([]) as readonly Selecao[],
  coleta: "ok",
});

const ENTRADA_INVALIDA: ResultadoSelecoesDoAgente = Object.freeze({
  selecoes: Object.freeze([]) as readonly Selecao[],
  coleta: "entrada_invalida",
});

const FALHA: ResultadoSelecoesDoAgente = Object.freeze({
  selecoes: Object.freeze([]) as readonly Selecao[],
  coleta: "falha_leitura",
});

/** Aplica o mapa de filtros como `.eq()` encadeados — mesmo padrao de
 *  `skills/fatos.ts`, para que o filtro PURO seja o que de fato vai a
 *  consulta, e nao uma copia decorativa dela. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function aplicarFiltros(consulta: any, filtros: Record<string, unknown>): any {
  let q = consulta;
  for (const [coluna, valor] of Object.entries(filtros)) q = q.eq(coluna, valor);
  return q;
}

/**
 * Todas as selecoes de loja de UM agente.
 *
 * Entrada sem autoridade NAO toca o banco: sem `userId` ou sem
 * `agenteId` nao ha pergunta a fazer, e responder "ok, nenhuma selecao"
 * seria afirmar algo sobre um agente que ninguem identificou.
 */
export async function resolverSelecoesDoAgente(
  entrada: EntradaSelecoesDoAgente
): Promise<ResultadoSelecoesDoAgente> {
  const { userId, agenteId } = entrada;

  if (!userId || !agenteId) return ENTRADA_INVALIDA;

  // ── QUERY 1 — as selecoes persistidas ─────────────────────────────
  const r1 = await aplicarFiltros(
    getSupabaseServidor().from("agente_conexoes").select(COLUNAS_SELECAO),
    filtrosSelecoesDoAgente(agenteId, userId)
  );

  if (r1.error) {
    // Sem `error.message`: mensagem de driver vaza nome de coluna, de
    // constraint e as vezes de valor, e acaba em log e em resposta HTTP.
    console.error("[conexoes] falha ao ler selecoes do agente");
    return FALHA;
  }

  const selecoes = ordenarSelecoes((r1.data ?? []) as LinhaSelecao[], agenteId, String(userId));
  if (selecoes === null) {
    console.error("[conexoes] selecao estruturalmente invalida");
    return FALHA;
  }

  // Nenhuma selecao e ausencia REAL, nao falha. QUERY 2 nao roda — nao
  // ha loja a confirmar, e uma consulta com lista vazia seria um round
  // trip para responder o que ja se sabe.
  if (selecoes.length === 0) return VAZIO;

  // ── QUERY 2 — as lojas, em lote e fechadas por dono ───────────────
  //
  // `lojaIdsDistintos` deduplica: duas capacidades apontando para a
  // MESMA loja e o caso normal, e pedir o mesmo uuid duas vezes so
  // aumentaria o `IN` sem mudar a resposta.
  const r2 = await aplicarFiltros(
    getSupabaseServidor().from("lojas").select(COLUNAS_LOJA),
    filtrosLojasDoDono(userId)
  ).in("id", lojaIdsDistintos(selecoes));

  if (r2.error) {
    console.error("[conexoes] falha ao confirmar lojas selecionadas");
    return FALHA;
  }

  const confirmadas = confirmarLojas(selecoes, (r2.data ?? []) as LinhaLoja[], String(userId));
  if (confirmadas === null) {
    // Loja ausente, repetida ou de outro dono. Nada e devolvido em
    // parcial: uma lista sem uma das selecoes seria dizer "estas sao as
    // escolhas do dono" omitindo uma que ele fez.
    console.error("[conexoes] colecao inconsistente — nenhuma selecao devolvida");
    return FALHA;
  }

  return { selecoes: confirmadas, coleta: "ok" };
}
