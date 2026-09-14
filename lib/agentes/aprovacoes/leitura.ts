/**
 * APPROVAL-UI-API-A1 — a fila de aprovacoes do DONO, so leitura.
 *
 * ── O que esta funcao faz, e o que ela deliberadamente nao faz ───────
 *
 * Ela responde uma pergunta so: "quais pedidos de autorizacao ainda
 * esperam por mim, agora?". Nao decide, nao consome, nao retoma, nao
 * expira nada. Nenhuma das tres RPCs de aprovacao aparece aqui, e
 * nenhuma escrita tambem — `decidirAprovacao`, `consumirAprovacaoEAbrir`
 * e `retomarAprovacao` continuam sem chamador de produto, porque o
 * estagio que as consome ainda nao existe.
 *
 * ── Por que a fila NAO materializa expiracao ────────────────────────
 *
 * `aprovacao_decidir` e `aprovacao_consumir_e_abrir` mudam `pendente`
 * para `expirada` antes de qualquer prova — elas precisam, porque vao
 * escrever. Uma LISTA nao precisa: ela apenas nao devolve o que ja
 * venceu. Fazer um GET gravar seria transformar abrir a tela num efeito
 * colateral, e uma tela aberta duas vezes teria escrito duas vezes. A
 * linha vencida continua `pendente` no banco ate uma RPC autorizada
 * tocar nela — e isso e correto, nao divida: o estado persistido nao
 * mente, ele so ainda nao foi visitado por quem tem direito de mudar.
 *
 * ── Duas leituras, nunca N+1 ────────────────────────────────────────
 *
 * A tabela de aprovacao guarda `agente_id`, nao o nome do agente — e
 * nao deveria guardar: nome muda, e duplica-lo criaria duas verdades.
 * O nome vem de uma SEGUNDA leitura, em lote, sobre os ids que a
 * primeira ja devolveu. Uma consulta por aprovacao daria o mesmo
 * resultado e custaria uma ida ao banco por linha da fila.
 *
 * ── Fail-closed no agente ausente ───────────────────────────────────
 *
 * A FK composta `(agente_id, user_id)` torna aprovacao orfa impossivel
 * por estrutura. Se mesmo assim a segunda leitura nao trouxer o nome de
 * alguma aprovacao, isto aqui devolve erro — nao "Agente desconhecido".
 * Um rotulo inventado esconderia uma inconsistencia real atras de texto
 * plausivel, e a fila e justamente onde alguem decide com base no que le.
 */
import "server-only";

import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";
import type { ResultadoLista } from "@/lib/agentes/tipos";

const TABELA_APROVACOES = "agente_funcao_aprovacoes";
const TABELA_AGENTES = "agentes";

/**
 * Projecao EXPLICITA, nunca `*` — a mesma regra de `capability.ts`.
 *
 * Ficam de fora, e cada um por um motivo proprio: `user_id` e a sessao
 * de quem perguntou; `argumentos_hash` e `fingerprint` sao a identidade
 * de deduplicacao e entregariam de graca como forjar uma colisao;
 * `request_id_solicitacao` e `request_id_consumo` sao correlacao
 * interna; `conexao_loja_id` e id de recurso do dono que a fila nao
 * precisa; `decidido_por`, `cancelado_por` e `motivo_recusa` descrevem
 * decisoes que esta fila nem lista. Coluna nova na tabela nao passa a
 * vazar sozinha por aqui.
 */
const COLUNAS_APROVACAO =
  "id, agente_id, tarefa_id, funcao_id, revisao_funcao, acesso, estado, " +
  "criado_em, expira_em, argumentos, conexao_plataforma, conexao_recurso";

const COLUNAS_AGENTE_NOME = "id, nome";

/** Teto da fila. Nao ha paginacao neste P0: uma fila de decisao humana
 *  com mais de cinquenta itens ja e um problema diferente, e devolver
 *  coleccao ilimitada por causa disso seria trocar um problema de
 *  produto por um de memoria. */
export const LIMITE_FILA_APROVACOES = 50;

/** O requisito de conexao, quando existe. `null` para Funcao que nao
 *  depende de conta externa — `vendas.consultar` e uma delas. Sem
 *  `loja_id`, sem conta, sem credencial: nada disso e lido. */
export interface ConexaoDaAprovacaoPendente {
  plataforma: string;
  recurso: string;
}

/**
 * Uma aprovacao pendente, ja pronta para a fila.
 *
 * `estado` esta aqui mesmo sendo sempre `"pendente"` nesta consulta: e
 * o contrato do dado, e omiti-lo obrigaria quem le a supor. `tarefaId`
 * e `string | null` porque a coluna e nullable — Funcao sem tarefa
 * existe, e assumir non-null so porque `vendas.consultar` sempre tem
 * uma criaria um tipo que mente sobre o schema.
 */
export interface AprovacaoPendente {
  id: string;
  agenteId: string;
  agenteNome: string;
  tarefaId: string | null;
  funcaoId: string;
  revisaoFuncao: string;
  acesso: string;
  estado: string;
  criadoEm: string;
  expiraEm: string;
  argumentos: Record<string, unknown>;
  conexao: ConexaoDaAprovacaoPendente | null;
}

interface LinhaAprovacaoBruta {
  id: unknown;
  agente_id: unknown;
  tarefa_id: unknown;
  funcao_id: unknown;
  revisao_funcao: unknown;
  acesso: unknown;
  estado: unknown;
  criado_em: unknown;
  expira_em: unknown;
  argumentos: unknown;
  conexao_plataforma: unknown;
  conexao_recurso: unknown;
}

const texto = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

/**
 * Le uma linha bruta com checagem de runtime.
 *
 * O `select` nominal diz quais colunas pedimos; ele nao prova o que
 * voltou. Uma linha deformada vira `null` aqui e a leitura inteira
 * falha fechada — meia fila seria pior que fila nenhuma, porque quem
 * decide nao teria como saber que faltou item.
 */
function lerAprovacao(bruta: unknown): Omit<AprovacaoPendente, "agenteNome"> | null {
  if (bruta === null || typeof bruta !== "object") return null;
  const l = bruta as LinhaAprovacaoBruta;

  const id = texto(l.id);
  const agenteId = texto(l.agente_id);
  const funcaoId = texto(l.funcao_id);
  const revisaoFuncao = texto(l.revisao_funcao);
  const acesso = texto(l.acesso);
  const estado = texto(l.estado);
  const criadoEm = texto(l.criado_em);
  const expiraEm = texto(l.expira_em);
  if (
    id === null || agenteId === null || funcaoId === null ||
    revisaoFuncao === null || acesso === null || estado === null ||
    criadoEm === null || expiraEm === null
  ) {
    return null;
  }

  // Nullable de verdade: ausencia e valor legitimo, nao defeito.
  const tarefaId = l.tarefa_id === null || l.tarefa_id === undefined
    ? null
    : texto(l.tarefa_id);
  if (tarefaId === null && l.tarefa_id !== null && l.tarefa_id !== undefined) return null;

  // O CHECK `argumentos_objeto` garante objeto no banco; conferir aqui
  // e o que impede um array ou um escalar de virar `argumentos` na
  // resposta se a leitura vier de outro lugar um dia.
  const argumentos = l.argumentos;
  if (argumentos === null || typeof argumentos !== "object" || Array.isArray(argumentos)) {
    return null;
  }

  // Requisito de conexao e tudo-ou-nada no banco (`par_requisito_conexao`).
  // Meia conexao aqui descreveria um alvo que nao existe.
  const plataforma = texto(l.conexao_plataforma);
  const recurso = texto(l.conexao_recurso);
  if ((plataforma === null) !== (recurso === null)) return null;

  return {
    id,
    agenteId,
    tarefaId,
    funcaoId,
    revisaoFuncao,
    acesso,
    estado,
    criadoEm,
    expiraEm,
    argumentos: argumentos as Record<string, unknown>,
    conexao: plataforma === null || recurso === null ? null : { plataforma, recurso },
  };
}

/** Log sem detalhe do banco: `message`, `details` e `hint` do Supabase
 *  podem carregar fragmento de consulta, e log tambem e superficie. */
function logarFalha(etapa: string): void {
  console.error(`[aprovacoes] falha ao ${etapa}`);
}

/**
 * As aprovacoes que ainda esperam por este dono.
 *
 * `estado = 'pendente'` E `expira_em > agora`, as duas no DATASTORE —
 * filtrar depois em JavaScript traria para a memoria do servidor linhas
 * que o dono nao pode ver, e bastaria um `return` esquecido para elas
 * saírem. Mais recentes primeiro, com `id` como desempate estavel para
 * que duas leituras do mesmo instante nao alternem a ordem.
 */
export async function listarAprovacoesPendentesDoDono(
  userId: string
): Promise<ResultadoLista<AprovacaoPendente>> {
  if (!userId) return { linhas: [], erro: null };

  // Um instante logico so para toda a leitura.
  const agora = new Date().toISOString();
  const cliente = getSupabaseServidor();

  const r1 = await cliente
    .from(TABELA_APROVACOES)
    .select(COLUNAS_APROVACAO)
    .eq("user_id", String(userId))
    .eq("estado", "pendente")
    .gt("expira_em", agora)
    .order("criado_em", { ascending: false })
    .order("id", { ascending: false })
    .limit(LIMITE_FILA_APROVACOES);

  if (r1.error) {
    logarFalha("listar aprovacoes pendentes");
    return { linhas: [], erro: "erro_consulta_aprovacao" };
  }

  const brutas = Array.isArray(r1.data) ? r1.data : [];
  const parciais: Omit<AprovacaoPendente, "agenteNome">[] = [];
  for (const bruta of brutas) {
    const linha = lerAprovacao(bruta);
    if (linha === null) {
      logarFalha("ler aprovacao deformada");
      return { linhas: [], erro: "erro_consulta_aprovacao" };
    }
    parciais.push(linha);
  }

  if (parciais.length === 0) return { linhas: [], erro: null };

  // ── Os nomes, em UMA leitura ──────────────────────────────────────
  //
  // `user_id` entra mesmo diante da FK composta: a FK garante que o par
  // e coerente, nao que ele seja o par do dono da sessao. E o conjunto
  // de ids vem SO da consulta anterior, que ja estava escopada — nada
  // aqui e escolhido por quem chamou.
  const ids = [...new Set(parciais.map((p) => p.agenteId))];
  const r2 = await cliente
    .from(TABELA_AGENTES)
    .select(COLUNAS_AGENTE_NOME)
    .eq("user_id", String(userId))
    .in("id", ids);

  if (r2.error) {
    logarFalha("listar nomes dos agentes");
    return { linhas: [], erro: "erro_consulta_aprovacao" };
  }

  const nomePorId = new Map<string, string>();
  for (const bruta of Array.isArray(r2.data) ? r2.data : []) {
    const linha = bruta as { id: unknown; nome: unknown };
    const id = texto(linha.id);
    const nome = texto(linha.nome);
    if (id !== null && nome !== null) nomePorId.set(id, nome);
  }

  const linhas: AprovacaoPendente[] = [];
  for (const parcial of parciais) {
    const agenteNome = nomePorId.get(parcial.agenteId);
    if (agenteNome === undefined) {
      // Fail-closed. Ver o cabecalho: nao ha rotulo inventado.
      logarFalha("resolver o nome do agente da aprovacao");
      return { linhas: [], erro: "erro_consulta_aprovacao" };
    }
    linhas.push({ ...parcial, agenteNome });
  }

  return { linhas, erro: null };
}
