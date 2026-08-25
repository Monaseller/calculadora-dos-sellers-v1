/**
 * Tipos e regras PURAS da fundacao de agentes — AGENTES-FASE1B.
 *
 * ── Por que este arquivo NAO importa "server-only" ──────────────────
 * Deliberado, e o contraste com `capability.ts` e o ponto. Aqui nao ha
 * `createClient`, nao ha env, nao ha rede, nao ha banco: so tipos e
 * funcoes puras. A UI vai precisar de `derivarStatusAgente` e dos nomes
 * de estado, e marcar este modulo como server-only impediria isso sem
 * proteger nada — nao ha o que vazar.
 *
 * A barreira `server-only` mora onde existe segredo a proteger: em
 * `capability.ts`, que instancia a `service_role`.
 *
 * ── A regra que este arquivo carrega sozinho ────────────────────────
 * `agentes` NAO tem coluna `status`. O estado operacional do agente e
 * DERIVADO das tarefas dele, por `derivarStatusAgente`. Duas fontes de
 * verdade para a mesma pergunta podem divergir e o banco nao teria como
 * impedir; uma derivacao nunca diverge.
 */

// ─── Dominio fechado ──────────────────────────────────────────────────
//
// As listas abaixo sao a MESMA verdade que os CHECK da migration
// `20260916_agentes_fundacao.sql`. Divergir delas nao produz bug de
// tipo — produz erro 23514 em runtime, no INSERT. A suite compara as
// duas fontes literalmente, para que a divergencia apareca no teste e
// nao em producao.

export const TIPOS_AGENTE = [
  "mensagens",
  "ads",
  "fotos",
  "anuncios",
  "financeiro",
  "gerente",
] as const;
export type TipoAgente = (typeof TIPOS_AGENTE)[number];

export const STATUS_TAREFA = [
  "pendente",
  "rodando",
  "aguardando_aprovacao",
  "concluido",
  "erro",
  "cancelado",
] as const;
export type StatusTarefa = (typeof STATUS_TAREFA)[number];

/** Terminais: nada sai daqui. Usado pela maquina de transicao e pela UI. */
export const STATUS_TAREFA_TERMINAIS: readonly StatusTarefa[] = ["concluido", "cancelado"];

export function ehTipoAgente(valor: unknown): valor is TipoAgente {
  return typeof valor === "string" && (TIPOS_AGENTE as readonly string[]).includes(valor);
}

export function ehStatusTarefa(valor: unknown): valor is StatusTarefa {
  return typeof valor === "string" && (STATUS_TAREFA as readonly string[]).includes(valor);
}

// ─── Linhas ───────────────────────────────────────────────────────────

/** `agentes` — 8 colunas. NAO ha `status`: ver cabecalho. */
export interface LinhaAgente {
  id: string;
  user_id: string;
  nome: string;
  tipo: string;
  instrucoes: string | null;
  ativo: boolean;
  criado_em: string;
  atualizado_em: string;
}

/** `agente_tarefas` — 16 colunas. */
export interface LinhaTarefa {
  id: string;
  agente_id: string;
  user_id: string;
  tipo: string;
  entrada: Record<string, unknown>;
  status: string;
  progresso: number;
  resultado: Record<string, unknown> | null;
  erro_tipo: string | null;
  erro_mensagem: string | null;
  tentativas: number;
  max_tentativas: number;
  criado_em: string;
  iniciado_em: string | null;
  concluido_em: string | null;
  heartbeat_em: string | null;
}

// ─── Entradas de escrita ──────────────────────────────────────────────
//
// Interfaces FECHADAS, nunca `Record<string, unknown>`. A capability
// copia campo a campo a partir delas; nao ha spread do input em lugar
// nenhum. Um campo que nao esta aqui nao chega ao banco, mesmo que o
// chamador o envie.

export interface CamposNovoAgente {
  nome: string;
  tipo: TipoAgente;
  instrucoes?: string | null;
}

/** Tudo opcional: e um PATCH. `user_id` NAO esta aqui, e nunca estara —
 *  trocar o dono de um agente e exatamente o que a FK composta proibe. */
export interface CamposAtualizacaoAgente {
  nome?: string;
  tipo?: TipoAgente;
  instrucoes?: string | null;
  ativo?: boolean;
}

export interface CamposNovaTarefa {
  tipo: string;
  entrada?: Record<string, unknown>;
  max_tentativas?: number;
}

// ─── Contratos de retorno ─────────────────────────────────────────────
//
// Mesma forma de `lib/marketplace/credenciais.ts`: devolver `{ dado, erro }`
// em vez de lancar ou engolir. `erro` e um CODIGO ESTAVEL nosso, nunca
// `error.message` do Postgres — mensagem de driver vaza nome de coluna,
// de constraint e as vezes de valor, e vai parar em log e em resposta HTTP.

export interface ResultadoLeitura<T> {
  linha: T | null;
  erro: string | null;
}

export interface ResultadoLista<T> {
  linhas: T[];
  erro: string | null;
}

// ─── Estado operacional DERIVADO ──────────────────────────────────────

export const STATUS_AGENTE_DERIVADO = [
  "desativado",
  "erro",
  "aguardando_aprovacao",
  "ocupado",
  "idle",
] as const;
export type StatusAgenteDerivado = (typeof STATUS_AGENTE_DERIVADO)[number];

/** Estados de tarefa que ocupam o agente. `pendente` conta: ha trabalho
 *  enfileirado para ele, ainda que nenhum worker o tenha pego. */
const STATUS_QUE_OCUPAM: readonly string[] = ["pendente", "rodando"];

/**
 * O estado operacional do agente, em funcao de `ativo` e das tarefas.
 *
 * Funcao PURA — sem banco, sem I/O, sem relogio. E o que a torna
 * testavel offline e o que a torna a unica fonte de verdade: nao existe
 * caminho pelo qual o "status persistido" divirja deste calculo, porque
 * nao existe status persistido.
 *
 * ── Precedencia, e por que nesta ordem ──────────────────────────────
 *  1. `!ativo` -> `desativado`. Vence tudo: um agente desligado nao
 *     "esta com erro" nem "esta ocupado" — ele esta fora de operacao.
 *     Tarefas antigas dele continuam existindo (ON DELETE RESTRICT
 *     preserva historico) e nao devem colorir o estado.
 *  2. `erro` -> `erro`. Vence `aguardando_aprovacao` e `ocupado`: e a
 *     condicao que pede intervencao humana com mais urgencia.
 *  3. `aguardando_aprovacao`. Tambem pede humano, mas e fluxo normal.
 *     Vence `ocupado` porque senao ficaria invisivel enquanto houvesse
 *     qualquer outra tarefa rodando — e aprovacao que ninguem ve nao
 *     acontece.
 *  4. `pendente`/`rodando` -> `ocupado`.
 *  5. resto -> `idle`.
 *
 * `thinking`/`using_tool` NAO aparecem: sao apresentacao, derivada de
 * `progresso` na UI, e nunca estado persistido.
 *
 * Aceita `Pick<>` em vez das linhas inteiras de proposito — quem chama
 * nao precisa carregar `entrada`/`resultado` (jsonb, potencialmente
 * grandes) so para pintar um badge.
 */
export function derivarStatusAgente(
  agente: Pick<LinhaAgente, "ativo">,
  tarefas: readonly Pick<LinhaTarefa, "status">[]
): StatusAgenteDerivado {
  if (!agente.ativo) return "desativado";

  const status = tarefas.map((t) => t.status);

  if (status.includes("erro")) return "erro";
  if (status.includes("aguardando_aprovacao")) return "aguardando_aprovacao";
  if (status.some((s) => STATUS_QUE_OCUPAM.includes(s))) return "ocupado";
  return "idle";
}

// ─── Maquina de transicao de tarefa ───────────────────────────────────

/**
 * Transicoes permitidas. Ainda NAO ha worker — esta tabela existe para
 * que a regra seja escrita e testada uma vez, e para que o `claim` da
 * FASE 1C seja construido contra um contrato ja fixado em vez de
 * inventa-lo.
 *
 * `rodando -> pendente` e `erro -> pendente` sao o retry, decidido pelo
 * job via `tentativas`/`max_tentativas` — nunca pelo provedor.
 */
export const TRANSICOES_TAREFA: Readonly<Record<StatusTarefa, readonly StatusTarefa[]>> = {
  pendente: ["rodando", "cancelado"],
  rodando: ["concluido", "erro", "aguardando_aprovacao", "pendente"],
  aguardando_aprovacao: ["concluido", "cancelado", "rodando"],
  erro: ["pendente", "cancelado"],
  concluido: [],
  cancelado: [],
};

/** `false` para transicao proibida E para status desconhecido — recusa
 *  fechada, nunca no-op silencioso. */
export function transicaoTarefaPermitida(de: unknown, para: unknown): boolean {
  if (!ehStatusTarefa(de) || !ehStatusTarefa(para)) return false;
  return TRANSICOES_TAREFA[de].includes(para);
}
