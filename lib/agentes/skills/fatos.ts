/**
 * Leitura autorizada das Skills de um agente — SKILL-1D.f.2.
 *
 * ── A pergunta que este modulo responde ─────────────────────────────
 *
 *   "Que conhecimento operacional ESTE agente usa?"
 *
 * Ate aqui `lib/ia/skills/formato.ts` sabia LER uma Skill de arquivo, a
 * SKILL-1D.f.1 criou onde guardar, e ninguem sabia CARREGAR. Esta e a
 * primeira fonte real de `Skill[]`.
 *
 * ── Autoridade ──────────────────────────────────────────────────────
 *
 * `(agente_id, user_id)` na QUERY 1 e `user_id` de novo na QUERY 2 —
 * ambas na propria instrucao, nunca comparacao em memoria depois de ler.
 *
 * O segundo filtro nao e redundancia: a FK composta garante que o par
 * (skill, dono) e coerente, nao que ele seja o par do dono da sessao. Um
 * `IN (ids)` sozinho aceitaria um uuid alheio que tivesse vazado.
 *
 * Agente de outro dono, agente inexistente e agente sem Skill produzem o
 * MESMO resultado — `[]` com coleta `ok` — de proposito: distinguir
 * viraria um oraculo de existencia de ids alheios. Mesma decisao ja
 * tomada em `capability.ts` e nos resolvedores de conexao e permissao.
 *
 * ── Duas queries, nunca N+1 ─────────────────────────────────────────
 *
 * O embed do PostgREST resolveria em uma, mas a FK daqui e COMPOSTA
 * `(skill_id, user_id) -> skills(id, user_id)`, e embedding sobre FK
 * composta pode exigir dica explicita de constraint. Duas leituras em
 * lote sao previsiveis e nao dependem de comportamento nao verificado.
 * Nunca uma query por Skill.
 *
 * ── O que este modulo NAO faz ───────────────────────────────────────
 *
 * Nao escreve. Nao filtra por `vigente` — a associacao pinna um `id`, e
 * uma Skill continua valendo depois que outra versao e promovida; filtrar
 * faria o agente perder a Skill sozinho. Nao resolve versao, nao troca
 * uuid, nao usa slug. Nao mescla manifestos, nao une requisitos, nao
 * escolhe Skill principal — isso e do agregador futuro.
 */
import "server-only";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";
import {
  filtrosAssociacoesDoAgente,
  filtrosSkillsDoDono,
  montarSkills,
  ordenarAssociacoes,
  type LinhaAssociacao,
  type LinhaSkill,
} from "@/lib/agentes/skills/estado";
import type { Skill } from "@/lib/ia/skills/contrato";

/**
 * Projecoes MINIMAS.
 *
 * QUERY 1 nao traz `agente_id` nem `user_id`: sao a autoridade da
 * instrucao, e devolve-los so ofereceria a tentacao de reconfirmar em
 * memoria o que ela ja garantiu.
 *
 * QUERY 2 traz `id` apenas para casar o mapa — ele nao sai no retorno
 * publico. `conteudo_hash`, `slug`, `versao`, `nome`, `origem` e
 * `vigente` ficam de fora: `Skill` nao os tem, e os quatro do meio ja
 * vivem DENTRO do manifesto (os CHECKs de equivalencia garantem que
 * coluna e manifesto dizem a mesma coisa).
 */
const COLUNAS_ASSOCIACAO = "skill_id, criado_em";
const COLUNAS_SKILL = "id, manifesto, corpo";

/**
 * O que o resolvedor recebe. Dois campos, e a lista curta e a defesa:
 * nao ha `skillId`, `slug`, `lojaId`, token nem credencial — nada disso e
 * autoridade, e nada disso e fornecido de fora.
 */
export interface EntradaSkillsDoAgente {
  userId: string;
  agenteId: string;
}

/**
 * Como a coleta terminou — separado das Skills, de proposito.
 *
 *   ok                a pergunta foi respondida; lista vazia e ausencia real
 *   falha_leitura     nao foi possivel montar a resposta INTEIRA
 *   entrada_invalida  faltou autoridade; nem houve o que perguntar
 *
 * ── Por que linha invalida derruba TUDO ─────────────────────────────
 *
 * Em `permissoes` uma linha invalida e descartada: o efeito e o da
 * ausencia, ausencia significa bloqueado, e falhar para o lado seguro se
 * corrige sozinho.
 *
 * Aqui nao. Descartar uma Skill invalida faria o agente PERDER capacidade
 * que o dono configurou, com a coleta ainda dizendo `ok`. Por isso
 * qualquer inconsistencia — manifesto fora do contrato, corpo ausente,
 * `id` repetido, ou associacao sem Skill correspondente — devolve
 * `falha_leitura` com lista vazia. Nunca resultado parcial.
 */
export type ColetaSkills = "ok" | "falha_leitura" | "entrada_invalida";

export interface ResultadoSkillsDoAgente {
  skills: readonly Skill[];
  coleta: ColetaSkills;
}

const VAZIO: ResultadoSkillsDoAgente = Object.freeze({
  skills: Object.freeze([]) as readonly Skill[],
  coleta: "ok",
});

const ENTRADA_INVALIDA: ResultadoSkillsDoAgente = Object.freeze({
  skills: Object.freeze([]) as readonly Skill[],
  coleta: "entrada_invalida",
});

const FALHA: ResultadoSkillsDoAgente = Object.freeze({
  skills: Object.freeze([]) as readonly Skill[],
  coleta: "falha_leitura",
});

/** Aplica o mapa de filtros como `.eq()` encadeados — mesmo padrao de
 *  `capability.ts`, para que o filtro PURO seja o que de fato vai a
 *  consulta, e nao uma copia decorativa dela. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function aplicarFiltros(consulta: any, filtros: Record<string, unknown>): any {
  let q = consulta;
  for (const [coluna, valor] of Object.entries(filtros)) q = q.eq(coluna, valor);
  return q;
}

/**
 * Todas as Skills associadas a UM agente, na ordem em que foram
 * associadas.
 *
 * Entrada sem autoridade NAO toca o banco: sem `userId` ou sem
 * `agenteId` nao ha pergunta a fazer, e responder "ok, nenhuma Skill"
 * seria afirmar algo sobre um agente que ninguem identificou.
 */
export async function resolverSkillsDoAgente(
  entrada: EntradaSkillsDoAgente
): Promise<ResultadoSkillsDoAgente> {
  const { userId, agenteId } = entrada;

  if (!userId || !agenteId) return ENTRADA_INVALIDA;

  // ── QUERY 1 — as associacoes, em ordem deterministica ─────────────
  //
  // A ordem tambem e reimposta em memoria por `ordenarAssociacoes`. Nao
  // e redundancia inutil: e o que torna a ordem provavel sem banco e o
  // que impede a ordem do driver de decidir qualquer coisa.
  const r1 = await aplicarFiltros(
    getSupabaseServidor().from("agente_skills").select(COLUNAS_ASSOCIACAO),
    filtrosAssociacoesDoAgente(agenteId, userId)
  )
    .order("criado_em", { ascending: true })
    .order("skill_id", { ascending: true });

  if (r1.error) {
    // Sem `error.message`: mensagem de driver vaza nome de coluna, de
    // constraint e as vezes de valor, e acaba em log e em resposta HTTP.
    console.error("[skills] falha ao ler associacoes do agente");
    return FALHA;
  }

  const associacoes = ordenarAssociacoes((r1.data ?? []) as LinhaAssociacao[]);
  if (associacoes === null) {
    console.error("[skills] associacao estruturalmente invalida");
    return FALHA;
  }

  // Nenhuma associacao e ausencia REAL, nao falha. QUERY 2 nao roda.
  if (associacoes.length === 0) return VAZIO;

  // ── QUERY 2 — as Skills, em lote e fechadas por dono ──────────────
  const r2 = await aplicarFiltros(
    getSupabaseServidor().from("skills").select(COLUNAS_SKILL),
    filtrosSkillsDoDono(userId)
  ).in("id", associacoes.map((a) => a.skillId));

  if (r2.error) {
    console.error("[skills] falha ao ler skills do dono");
    return FALHA;
  }

  const skills = montarSkills(associacoes, (r2.data ?? []) as LinhaSkill[]);
  if (skills === null) {
    // Manifesto fora do contrato, corpo ausente, id repetido, ou
    // associacao sem Skill. Conta-se nada: nem manifesto nem corpo vao
    // para o log.
    console.error("[skills] colecao inconsistente — nenhuma Skill devolvida");
    return FALHA;
  }

  return { skills, coleta: "ok" };
}
