/**
 * Capability de agentes — AGENTES-FASE1B.
 *
 * ── A invariante que este modulo torna estrutural ───────────────────
 *
 *   "Nenhuma operacao de agente ou de tarefa alcanca uma linha sem que
 *    o `user_id` do dono entre na PROPRIA instrucao enviada ao banco."
 *
 * O `userId` nao precisa ser PROVADO pelo chamador — ele RESTRINGE a
 * consulta. Par coerente devolve a linha; par forjado devolve `null` ou
 * lista vazia. Nao ha caminho em que comparar `user_id` em memoria,
 * depois de ler, seja a unica defesa.
 *
 * ── Duas camadas independentes, de propositos diferentes ────────────
 * Este modulo e a camada de APLICACAO. A camada de BANCO e a FK composta
 * `(agente_id, user_id) REFERENCES agentes (id, user_id)`, que torna
 * impossivel uma tarefa do usuario B apontar para um agente do usuario A
 * — inclusive por SQL direto com service_role, sem passar por aqui.
 *
 * As duas nao se substituem. A FK garante COERENCIA do par; ela nao sabe
 * quem e o dono da sessao. Quem sabe disso e a rota, e o filtro abaixo e
 * o que transforma esse conhecimento em restricao de consulta.
 *
 * ── Superficie privilegiada ─────────────────────────────────────────
 * Este modulo NAO exporta e NAO recebe `SupabaseClient`. Quem o usa
 * ganha 7 capacidades NOMEADAS, nunca a capacidade generica de consultar
 * qualquer tabela com service_role. E a mesma decisao de
 * `lib/marketplace/credenciais.ts`, tomada pelo mesmo motivo: o dia em
 * que um parametro `supabase: SupabaseClient` existe, rastrear qual
 * cliente chega ali vira auditoria de cadeia de chamada — foi assim que
 * `ml-conta.ts` enganou a auditoria da LOJAS-ANON-SELECT.
 *
 * ── `import "server-only"` ──────────────────────────────────────────
 * Primeira linha, e e uma barreira de COMPILACAO, nao uma convencao: se
 * um Client Component importar este modulo, ainda que indiretamente, o
 * BUILD quebra em vez de embarcar a service_role no bundle do browser.
 * `getSupabaseServidor()` e fail-closed e lanca sem
 * `SUPABASE_SERVICE_ROLE_KEY` — variavel que, sem prefixo
 * `NEXT_PUBLIC_`, e `undefined` em qualquer bundle de cliente. Duas
 * barreiras, em momentos diferentes.
 *
 * ── O que NAO existe aqui, e nao e esquecimento ─────────────────────
 * Sem IA, sem worker, sem `claim`, sem RPC, sem n8n, sem mensagens, sem
 * memoria/chat/tools. Nenhuma transicao de estado de tarefa: transicao
 * sob concorrencia e trabalho de RPC atomica, e TypeScript nao roda em
 * transacao. As 7 operacoes abaixo sao CRUD, e so.
 */
import "server-only";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";
import {
  ehTipoAgente,
  type CamposAtualizacaoAgente,
  type CamposNovaTarefa,
  type CamposNovoAgente,
  type LinhaAgente,
  type LinhaTarefa,
  type ResultadoLeitura,
  type ResultadoLista,
} from "@/lib/agentes/tipos";

/**
 * Projecoes EXPLICITAS, nunca `*`. Alem de nao trazer coluna a toa, e o
 * que mantem estas consultas compativeis com um futuro GRANT coluna a
 * coluna — e o que faz uma coluna nova nao vazar sozinha para todas as
 * telas no dia em que for criada.
 */
const COLUNAS_AGENTE = "id, user_id, nome, tipo, instrucoes, ativo, criado_em, atualizado_em";
const COLUNAS_TAREFA =
  "id, agente_id, user_id, tipo, entrada, status, progresso, resultado, erro_tipo, " +
  "erro_mensagem, tentativas, max_tentativas, criado_em, iniciado_em, concluido_em, heartbeat_em";

/** Violacao de FK. E o codigo que a FK composta devolve quando a tarefa
 *  aponta para um agente que nao existe OU que e de outro dono — o
 *  Postgres nao distingue os dois casos, e nos tambem nao devemos. */
const SQLSTATE_VIOLACAO_FK = "23503";

// ─── Construtores de filtro ───────────────────────────────────────────
//
// Exportados de proposito: sao funcoes PURAS, e e sobre elas que a suite
// prova a invariante. Um teste que afirme "toda operacao carrega
// `user_id`" precisa inspecionar o filtro; inspecionar o filtro e
// barato, inspecionar a query montada exigiria banco.
//
// `String(userId)` porque as duas colunas sao TEXT: comparar sem
// normalizar viraria recusa silenciosa por tipo.

export function filtrosAgenteDoDono(agenteId: string, userId: string): Record<string, unknown> {
  return { id: agenteId, user_id: String(userId) };
}

export function filtrosAgentesDoDono(userId: string): Record<string, unknown> {
  return { user_id: String(userId) };
}

export function filtrosTarefaDoDono(tarefaId: string, userId: string): Record<string, unknown> {
  return { id: tarefaId, user_id: String(userId) };
}

/**
 * Tarefas de UM agente. `user_id` entra mesmo sendo redundante diante da
 * FK composta — a FK garante que o par e coerente, nao que ele seja o
 * par do dono da sessao. Sem `user_id` aqui, um `agenteId` alheio
 * vazado devolveria as tarefas dele.
 */
export function filtrosTarefasDoAgente(agenteId: string, userId: string): Record<string, unknown> {
  return { agente_id: agenteId, user_id: String(userId) };
}

/** Aplica um mapa de filtros como `.eq()` encadeados. */
function aplicarFiltros(consulta: any, filtros: Record<string, unknown>): any {
  let q = consulta;
  for (const [coluna, valor] of Object.entries(filtros)) q = q.eq(coluna, valor);
  return q;
}

// ─── Agentes ──────────────────────────────────────────────────────────

/**
 * Cria um agente para o dono informado.
 *
 * `user_id` vem do PARAMETRO, nunca de `dados` — `CamposNovoAgente` nao
 * tem esse campo, e e por isso que ele nao tem: um chamador nao pode
 * pedir a criacao de agente em nome de outro.
 */
export async function criarAgente(
  userId: string,
  dados: CamposNovoAgente
): Promise<ResultadoLeitura<LinhaAgente>> {
  if (!userId) return { linha: null, erro: "user_id_ausente" };

  const nome = typeof dados?.nome === "string" ? dados.nome.trim() : "";
  if (!nome) return { linha: null, erro: "nome_invalido" };
  if (!ehTipoAgente(dados?.tipo)) return { linha: null, erro: "tipo_invalido" };

  // Copia campo a campo. Nunca `...dados` — spread deixaria qualquer
  // chave extra do chamador (inclusive `user_id`, `id`, `criado_em`)
  // chegar ao INSERT.
  const novo = {
    user_id: String(userId),
    nome,
    tipo: dados.tipo,
    instrucoes: typeof dados?.instrucoes === "string" ? dados.instrucoes : null,
  };

  const { data, error } = await getSupabaseServidor()
    .from("agentes")
    .insert(novo)
    .select(COLUNAS_AGENTE)
    .maybeSingle();

  if (error) {
    console.error("[agentes] falha ao criar agente");
    return { linha: null, erro: "erro_criacao_agente" };
  }
  return { linha: (data as LinhaAgente | null) ?? null, erro: null };
}

/**
 * Os agentes do dono — ativos E inativos.
 *
 * Nao filtra `ativo`: a tela precisa listar o desativado para poder
 * reativa-lo. Quem quiser so os ativos filtra em memoria, sobre um
 * conjunto que e de uma dezena de linhas por dono.
 */
export async function listarAgentesDoDono(userId: string): Promise<ResultadoLista<LinhaAgente>> {
  if (!userId) return { linhas: [], erro: null };

  const { data, error } = await aplicarFiltros(
    getSupabaseServidor().from("agentes").select(COLUNAS_AGENTE),
    filtrosAgentesDoDono(userId)
  ).order("criado_em");

  if (error) {
    console.error("[agentes] falha ao listar agentes do dono");
    return { linhas: [], erro: "erro_consulta_agente" };
  }
  return { linhas: (Array.isArray(data) ? data : []) as LinhaAgente[], erro: null };
}

/** UM agente do dono. Par incoerente devolve `linha: null`, nunca a linha alheia. */
export async function lerAgenteDoDono(
  agenteId: string,
  userId: string
): Promise<ResultadoLeitura<LinhaAgente>> {
  if (!agenteId || !userId) return { linha: null, erro: null };

  const { data, error } = await aplicarFiltros(
    getSupabaseServidor().from("agentes").select(COLUNAS_AGENTE),
    filtrosAgenteDoDono(agenteId, userId)
  ).maybeSingle();

  if (error) {
    console.error("[agentes] falha ao ler agente do dono");
    return { linha: null, erro: "erro_consulta_agente" };
  }
  return { linha: (data as LinhaAgente | null) ?? null, erro: null };
}

/**
 * Atualiza campos de configuracao de um agente do dono.
 *
 * ── Lista fechada, copiada campo a campo ────────────────────────────
 * `user_id` e `id` NAO estao entre os campos aceitos, e nao e omissao:
 * trocar o dono de um agente e exatamente a inconsistencia que o
 * `ON UPDATE RESTRICT` da FK composta existe para proibir. Se um dia
 * alguem acrescentar `user_id` a `CamposAtualizacaoAgente`, o banco
 * ainda recusa — mas o pedido nem chega la.
 *
 * PATCH vazio nao vira UPDATE: sem isto, `{}` tocaria `atualizado_em` de
 * graca e devolveria "sucesso" para uma operacao que nao pediu nada.
 */
export async function atualizarAgenteDoDono(
  agenteId: string,
  userId: string,
  campos: CamposAtualizacaoAgente
): Promise<ResultadoLeitura<LinhaAgente>> {
  if (!agenteId || !userId) return { linha: null, erro: null };

  const alteracoes: Record<string, unknown> = {};

  if (campos?.nome !== undefined) {
    const nome = typeof campos.nome === "string" ? campos.nome.trim() : "";
    if (!nome) return { linha: null, erro: "nome_invalido" };
    alteracoes.nome = nome;
  }
  if (campos?.tipo !== undefined) {
    if (!ehTipoAgente(campos.tipo)) return { linha: null, erro: "tipo_invalido" };
    alteracoes.tipo = campos.tipo;
  }
  if (campos?.instrucoes !== undefined) {
    alteracoes.instrucoes = typeof campos.instrucoes === "string" ? campos.instrucoes : null;
  }
  if (campos?.ativo !== undefined) {
    if (typeof campos.ativo !== "boolean") return { linha: null, erro: "ativo_invalido" };
    alteracoes.ativo = campos.ativo;
  }

  if (Object.keys(alteracoes).length === 0) return { linha: null, erro: "nenhum_campo_valido" };

  // Nao ha trigger nesta fase — `atualizado_em` e mantido aqui.
  alteracoes.atualizado_em = new Date().toISOString();

  const { data, error } = await aplicarFiltros(
    getSupabaseServidor().from("agentes").update(alteracoes),
    filtrosAgenteDoDono(agenteId, userId)
  )
    .select(COLUNAS_AGENTE)
    .maybeSingle();

  if (error) {
    console.error("[agentes] falha ao atualizar agente do dono");
    return { linha: null, erro: "erro_atualizacao_agente" };
  }
  // `null` aqui = nenhuma linha casou o par (id, user_id). Nao e falha de
  // infraestrutura: e recusa cross-tenant, e o chamador precisa
  // distinguir uma da outra.
  return { linha: (data as LinhaAgente | null) ?? null, erro: null };
}

// ─── Tarefas ──────────────────────────────────────────────────────────

/**
 * Cria uma tarefa para um agente do dono.
 *
 * ── Por que NAO se le o agente antes ────────────────────────────────
 * Seria uma checagem TOCTOU: entre o SELECT e o INSERT, nada garante que
 * o agente continue sendo daquele dono. A FK composta faz a verificacao
 * DENTRO da mesma instrucao, de forma atomica — e por SQLSTATE 23503
 * sabemos exatamente que foi ela que recusou.
 *
 * O codigo devolvido nao distingue "agente inexistente" de "agente de
 * outro dono", e isso e proposital: sao a mesma resposta para quem
 * pergunta, e distinguir viraria um oraculo de existencia de ids alheios.
 *
 * `status` e `progresso` NAO sao aceitos do chamador — toda tarefa nasce
 * `pendente`/`0` pelo DEFAULT do banco. Transicao e trabalho da RPC da
 * FASE 1C, nunca de um INSERT vindo de fora.
 */
export async function criarTarefa(
  agenteId: string,
  userId: string,
  dados: CamposNovaTarefa
): Promise<ResultadoLeitura<LinhaTarefa>> {
  if (!agenteId || !userId) return { linha: null, erro: "parametros_ausentes" };

  const tipo = typeof dados?.tipo === "string" ? dados.tipo.trim() : "";
  if (!tipo) return { linha: null, erro: "tipo_invalido" };

  const entrada =
    dados?.entrada && typeof dados.entrada === "object" && !Array.isArray(dados.entrada)
      ? dados.entrada
      : {};

  const nova: Record<string, unknown> = {
    agente_id: agenteId,
    user_id: String(userId),
    tipo,
    entrada,
  };

  // So viaja se o chamador realmente pediu — senao o DEFAULT 3 do banco
  // continua sendo a fonte unica desse numero.
  if (dados?.max_tentativas !== undefined) {
    const max = Number(dados.max_tentativas);
    if (!Number.isInteger(max) || max < 1) return { linha: null, erro: "max_tentativas_invalido" };
    nova.max_tentativas = max;
  }

  const { data, error } = await getSupabaseServidor()
    .from("agente_tarefas")
    .insert(nova)
    .select(COLUNAS_TAREFA)
    .maybeSingle();

  if (error) {
    if ((error as { code?: string })?.code === SQLSTATE_VIOLACAO_FK) {
      return { linha: null, erro: "agente_inexistente_ou_de_outro_dono" };
    }
    console.error("[agentes] falha ao criar tarefa");
    return { linha: null, erro: "erro_criacao_tarefa" };
  }
  return { linha: (data as LinhaTarefa | null) ?? null, erro: null };
}

/** Tarefas de um agente do dono, da mais recente para a mais antiga —
 *  a ordem que `idx_agente_tarefas_agente` serve diretamente. */
export async function listarTarefasDoAgente(
  agenteId: string,
  userId: string
): Promise<ResultadoLista<LinhaTarefa>> {
  if (!agenteId || !userId) return { linhas: [], erro: null };

  const { data, error } = await aplicarFiltros(
    getSupabaseServidor().from("agente_tarefas").select(COLUNAS_TAREFA),
    filtrosTarefasDoAgente(agenteId, userId)
  ).order("criado_em", { ascending: false });

  if (error) {
    console.error("[agentes] falha ao listar tarefas do agente");
    return { linhas: [], erro: "erro_consulta_tarefa" };
  }
  return { linhas: (Array.isArray(data) ? data : []) as LinhaTarefa[], erro: null };
}

/** UMA tarefa do dono, sem passar pelo agente. Par incoerente devolve `null`. */
export async function lerTarefaDoDono(
  tarefaId: string,
  userId: string
): Promise<ResultadoLeitura<LinhaTarefa>> {
  if (!tarefaId || !userId) return { linha: null, erro: null };

  const { data, error } = await aplicarFiltros(
    getSupabaseServidor().from("agente_tarefas").select(COLUNAS_TAREFA),
    filtrosTarefaDoDono(tarefaId, userId)
  ).maybeSingle();

  if (error) {
    console.error("[agentes] falha ao ler tarefa do dono");
    return { linha: null, erro: "erro_consulta_tarefa" };
  }
  return { linha: (data as LinhaTarefa | null) ?? null, erro: null };
}
