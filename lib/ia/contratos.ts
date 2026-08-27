/**
 * CDS IA — contratos visuais da UI.
 *
 * ── Por que espelhar as linhas do banco, e nao inventar uma forma ────
 *
 * Estes tipos existem para que a UI-1B rode com mock HOJE e passe a ler
 * banco DEPOIS sem reescrever componente. Por isso cada campo tem o mesmo
 * nome e o mesmo tipo da coluna correspondente em `agentes` e
 * `agente_tarefas` — inclusive `snake_case`, que nao e o estilo do resto
 * da UI mas e o que a linha do Postgres devolve.
 *
 * Um campo com nome diferente aqui viraria um `map()` de traducao em
 * algum lugar no futuro, e esse lugar seria descoberto por bug.
 *
 * ── O que NAO esta aqui, de proposito ───────────────────────────────
 *
 * `user_id` nao aparece em nenhum contrato. A UI nao precisa dele para
 * desenhar: quem filtra por dono e a camada de leitura, no servidor, e
 * ela ainda nao existe. Campo que a tela nao usa e campo que vaza em
 * `console.log`, em prop drilling e em screenshot de suporte.
 *
 * Tambem nao ha `entrada`, `resultado` (jsonb potencialmente grandes),
 * `tentativas`, `heartbeat_em` nem credencial de especie alguma.
 */

/** Espelha o CHECK de `agentes.tipo`. Seis valores, nao um a mais. */
export const TIPOS_AGENTE_UI = [
  "mensagens",
  "ads",
  "fotos",
  "anuncios",
  "financeiro",
  "gerente",
] as const;
export type TipoAgenteUI = (typeof TIPOS_AGENTE_UI)[number];

/** Espelha o CHECK de `agente_tarefas.status`. */
export const STATUS_TAREFA_UI = [
  "pendente",
  "rodando",
  "aguardando_aprovacao",
  "concluido",
  "erro",
  "cancelado",
] as const;
export type StatusTarefaUI = (typeof STATUS_TAREFA_UI)[number];

/**
 * Espelha `agentes` — sem `user_id`, sem `instrucoes`.
 *
 * NAO ha campo `status`: no banco tambem nao ha. O estado do agente e
 * derivado de `ativo` + tarefas, e quem deriva e `lib/ia/estados.ts`.
 * Guardar um `status` aqui criaria uma segunda verdade que poderia
 * divergir da primeira — exatamente o que a ausencia da coluna evita.
 */
export interface AgenteUI {
  id: string;
  nome: string;
  tipo: TipoAgenteUI;
  ativo: boolean;
  criado_em: string;
}

/**
 * Espelha `agente_tarefas` — o subconjunto que a tela desenha.
 *
 * `titulo` e o unico campo que NAO existe no banco: e a frase legivel da
 * tarefa. Hoje vem do mock; quando houver leitura real, sera derivada de
 * `tipo` + `entrada` por uma funcao de apresentacao, nunca uma coluna
 * nova. Fica marcado aqui para que ninguem crie a coluna por engano.
 */
export interface TarefaUI {
  id: string;
  agente_id: string;
  tipo: string;
  titulo: string;
  status: StatusTarefaUI;
  progresso: number;
  criado_em: string;
  concluido_em: string | null;
}
