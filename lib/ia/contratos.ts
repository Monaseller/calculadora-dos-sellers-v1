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

/**
 * Espelha o CHECK vigente de `agentes.tipo`. Sete valores, nao um a
 * mais — `personalizado` entrou pela migration forward
 * `20260926_agentes_tipo_personalizado.sql`.
 *
 * A ORDEM importa: e a ordem em que a tela oferece os perfis, e o
 * primeiro item e o estado inicial do seletor. `personalizado` vem
 * primeiro porque os outros seis sao atalhos para funcoes conhecidas, e
 * comecar exigindo que o dono escolha uma delas seria pedir uma decisao
 * que ele ainda nao tem como tomar.
 *
 * Perfil e ROTULO, nunca poder: nenhum destes valores concede Skill,
 * Funcao, conexao ou permissao.
 */
export const TIPOS_AGENTE_UI = [
  "personalizado",
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
  /** Espelha `agentes.instrucoes`: texto livre, nullable. E CONFIGURACAO
   *  do agente, nunca autoridade — o que ele PODE fazer vive em
   *  permissao/autonomia, nao aqui. Ver `lib/ia/conceitos.ts`. */
  instrucoes: string | null;
  ativo: boolean;
  criado_em: string;
}

/**
 * Espelha `agente_tarefas` — o subconjunto que a tela desenha.
 *
 * ── Nao existe `titulo`, e isso e deliberado ────────────────────────
 *
 * Uma versao anterior deste contrato tinha `titulo: string`, preenchido
 * pelo mock. Era uma coluna inventada: o banco nao tem esse campo e nao
 * deve ganha-lo. A frase legivel e APRESENTACAO, derivada de `tipo` +
 * `entrada` por `tituloDaTarefa()` em `lib/ia/tarefas.ts`.
 *
 * A diferenca importa porque um campo aqui viraria, mais cedo ou mais
 * tarde, um pedido de `ALTER TABLE`.
 *
 * `entrada` e `jsonb` no banco e chega como objeto arbitrario. Ele NUNCA
 * e renderizado inteiro: a apresentacao le chaves conhecidas, uma a uma.
 * Despejar `entrada` na tela e como despejar payload de API — funciona
 * ate o dia em que alguem coloca algo sensivel la dentro.
 */
export interface TarefaUI {
  id: string;
  agente_id: string;
  tipo: string;
  entrada: Record<string, unknown>;
  status: StatusTarefaUI;
  progresso: number;
  tentativas: number;
  max_tentativas: number;
  erro_tipo: string | null;
  erro_mensagem: string | null;
  criado_em: string;
  iniciado_em: string | null;
  concluido_em: string | null;
  heartbeat_em: string | null;
}
