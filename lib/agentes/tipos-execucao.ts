/**
 * Tipos de EXECUCAO de tarefa — AGENTES-FASE1C.
 *
 * ── Por que estes tipos nao moram em `tipos.ts` ─────────────────────
 * Decisao deliberada, e nao organizacao arbitraria.
 *
 * `lib/agentes/tipos.ts` e o vocabulario que a UI tambem vai consumir:
 * nomes de estado, `derivarStatusAgente`, a maquina de transicao. A
 * suite da FASE 1B prova, no assert J2, que aquele arquivo NAO menciona
 * `worker` nem `claim_next` — porque um tipo de infraestrutura de
 * execucao vazando para o vocabulario de dominio e o primeiro passo
 * para um componente de tela importar o motor.
 *
 * Poderia ter enfraquecido o assert. Nao enfraqueci: os tipos de
 * execucao ficam aqui, `tipos.ts` continua intocado, e a suite da 1B
 * segue valendo palavra por palavra.
 *
 * Este arquivo tambem e PURO — sem `server-only`, sem banco, sem env.
 * Ele descreve o CONTRATO do handler; quem o executa e outro modulo.
 */
import type { LinhaTarefa } from "@/lib/agentes/tipos";

/**
 * Tudo que um handler recebe. Contexto MINIMO, e a palavra e literal.
 *
 * ── O que NAO esta aqui, e nao e esquecimento ───────────────────────
 * Nao ha `SupabaseClient`. Nao ha service_role. Nao ha `fetch`. Um
 * handler nao consulta o banco, nao chama rede e nao decide o proprio
 * estado — ele recebe dados, devolve dados. Quem persiste e o executor.
 *
 * E a mesma decisao de `lib/marketplace/credenciais.ts` e da capability
 * da 1B: entregar capacidades nomeadas, nunca a capacidade generica de
 * consultar qualquer tabela com o papel mais privilegiado do projeto.
 *
 * `userId` viaja junto porque um handler futuro pode precisar saber DE
 * QUEM e o trabalho — mas ele o recebe ja validado pela FK composta, e
 * nao tem como usa-lo para alcancar dado alheio: nao tem cliente.
 */
export interface ContextoTarefa {
  readonly tarefaId: string;
  readonly agenteId: string;
  readonly userId: string;
  readonly tipo: string;
  readonly entrada: Record<string, unknown>;
  readonly tentativa: number;
  readonly maxTentativas: number;
}

/** Progresso 0..100. O executor decide se e quando persistir. */
export type RelatarProgresso = (progresso: number) => void;

/**
 * O handler devolve o `resultado` que sera persistido em
 * `agente_tarefas.resultado`. Devolver e o unico caminho — nao existe
 * handler que "grave o proprio resultado".
 *
 * LANCAR e o caminho de falha. O executor traduz a excecao em
 * `falhar_tarefa()`. Um handler nunca chama RPC.
 */
export type HandlerTarefa = (
  contexto: ContextoTarefa,
  relatarProgresso: RelatarProgresso
) => Promise<Record<string, unknown>>;

/** Categorias fechadas de falha. Texto livre em log vira grep frágil. */
export const TIPOS_ERRO_TAREFA = [
  "tipo_desconhecido",
  "entrada_invalida",
  "handler_falhou",
  "erro_interno",
] as const;
export type TipoErroTarefa = (typeof TIPOS_ERRO_TAREFA)[number];

/** Resultado da execucao, como o executor o devolve a rota interna. */
export interface ResultadoExecucao {
  ok: boolean;
  tarefaId: string;
  status: string;
  erroTipo: TipoErroTarefa | null;
  tempoMs: number;
}

/** Uma tarefa reivindicada, como o claim a devolve. */
export type TarefaReivindicada = LinhaTarefa;
