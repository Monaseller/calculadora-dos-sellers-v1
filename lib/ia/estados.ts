/**
 * CDS IA — os 5 estados visuais canonicos e o UNICO ponto de traducao.
 *
 * ── A regra que este arquivo existe para cumprir ────────────────────
 *
 * O produto fala 5 estados:
 *
 *   ocioso · trabalhando · aguardando_aprovacao · concluido · erro
 *
 * O backend deriva outros 5 (`STATUS_AGENTE_DERIVADO`):
 *
 *   idle · ocupado · aguardando_aprovacao · erro · desativado
 *
 * Nenhum componente visual pode conhecer "ocupado" ou "idle". A traducao
 * acontece AQUI, uma vez, e em lugar nenhum mais. Isso nao e vocabulario
 * paralelo: e uma fronteira. Vocabulario paralelo seria cada componente
 * decidir sozinho como chamar cada coisa.
 *
 * ── Por que reusar `derivarStatusAgente` em vez de reimplementar ────
 *
 * A precedencia (`desativado > erro > aguardando_aprovacao > ocupado >
 * idle`) ja esta decidida, comentada e testada em `lib/agentes/tipos.ts`.
 * Reescreve-la aqui criaria duas regras que precisariam concordar para
 * sempre — e elas divergiriam na primeira mudanca. Importamos a funcao.
 *
 * `lib/agentes/tipos.ts` e um modulo PURO: zero imports, e o cabecalho
 * dele documenta explicitamente que nao importa "server-only" justamente
 * para que a UI possa consumi-lo. Este e o uso pretendido.
 *
 * ── Como a exaustividade e garantida ────────────────────────────────
 *
 * `TRADUCAO` e um `Record<StatusAgenteDerivado, ...>`. Se alguem
 * acrescentar um sexto estado derivado no backend, ESTE ARQUIVO PARA DE
 * COMPILAR. E o comportamento desejado: a UI nunca deve descobrir um
 * estado novo em producao, pintando-o de branco por omissao.
 */
import { derivarStatusAgente, type StatusAgenteDerivado } from "@/lib/agentes/tipos";
import type { AgenteUI, TarefaUI } from "@/lib/ia/contratos";

// ── Os 5 estados canonicos ────────────────────────────────────────────

export const ESTADOS_VISUAIS = [
  "ocioso",
  "trabalhando",
  "aguardando_aprovacao",
  "concluido",
  "erro",
] as const;
export type EstadoVisual = (typeof ESTADOS_VISUAIS)[number];

/**
 * Rotulo e icone de cada estado.
 *
 * O icone NAO e decoracao: e o que faz o estado ser legivel sem depender
 * de cor. Daltonismo, monitor ruim e screenshot em preto e branco sao
 * todos o mesmo problema, e a cor sozinha falha nos tres.
 */
export const VOCABULARIO_ESTADO: Record<EstadoVisual, { rotulo: string; icone: string }> = {
  ocioso: { rotulo: "Ocioso", icone: "···" },
  trabalhando: { rotulo: "Trabalhando", icone: "▶" },
  aguardando_aprovacao: { rotulo: "Aguardando aprovação", icone: "!" },
  concluido: { rotulo: "Concluído", icone: "✓" },
  erro: { rotulo: "Erro", icone: "✕" },
};

/** Rotulo do modificador. NUNCA e o rotulo de `ocioso`. */
export const ROTULO_FORA_DE_OPERACAO = "Fora de operação";

// ── Traducao backend -> UI ────────────────────────────────────────────

/**
 * `desativado` NAO vira um sexto estado.
 *
 * Ele mapeia para a POSICAO de `ocioso` — o agente desligado fica na
 * copa, fora da estacao, porque nao esta produzindo nada. Mas ele nunca
 * mostra a PALAVRA "Ocioso": quem decide o texto e `rotuloDe()`, que
 * troca o rotulo por "Fora de operação" quando o modificador esta ligado.
 *
 * Posicao compartilhada, identidade separada. E o que permite atender
 * "nao deve ser confundido com ocioso" sem inventar o sexto estado.
 */
const TRADUCAO: Record<StatusAgenteDerivado, EstadoVisual> = {
  idle: "ocioso",
  ocupado: "trabalhando",
  aguardando_aprovacao: "aguardando_aprovacao",
  erro: "erro",
  desativado: "ocioso",
};

/**
 * Janela do feedback transitorio de conclusao.
 *
 * `concluido` nao e estado de agente e nunca e persistido: e um flash
 * derivado de `agente_tarefas.concluido_em`. Passada a janela, ele
 * simplesmente deixa de ser verdade — nao ha nada para "limpar" depois,
 * que e o que torna esta abordagem segura.
 */
export const JANELA_CONCLUIDO_MS = 8_000;

export interface AparenciaAgente {
  /** Um dos 5 canonicos. Decide posicao, cor e icone. */
  estado: EstadoVisual;
  /** Modificador ortogonal: dessatura e troca o rotulo. */
  foraDeOperacao: boolean;
}

/**
 * O estado visual de um agente.
 *
 * `agoraMs` entra por parametro de proposito: sem relogio interno, a
 * funcao e pura e o flash de conclusao pode ser testado sem esperar 8
 * segundos.
 *
 * Ordem das decisoes:
 *   1. delega a precedencia ao backend (`derivarStatusAgente`);
 *   2. traduz para o vocabulario da UI;
 *   3. SOMENTE se o resultado for `ocioso` e o agente estiver ativo,
 *      um encerramento recente vira o flash `concluido`.
 *
 * O passo 3 nunca sobrepoe erro, aprovacao pendente ou trabalho em
 * andamento — celebrar conclusao por cima de um erro seria mentir.
 */
export function aparenciaDoAgente(
  agente: Pick<AgenteUI, "ativo">,
  tarefas: readonly Pick<TarefaUI, "status" | "concluido_em">[],
  agoraMs: number
): AparenciaAgente {
  const derivado = derivarStatusAgente(agente, tarefas);
  const foraDeOperacao = derivado === "desativado";
  const estado = TRADUCAO[derivado];

  if (estado === "ocioso" && !foraDeOperacao && concluiuRecentemente(tarefas, agoraMs)) {
    return { estado: "concluido", foraDeOperacao: false };
  }

  return { estado, foraDeOperacao };
}

/** `concluido_em` ausente ou nao parseavel nunca produz flash. */
function concluiuRecentemente(
  tarefas: readonly Pick<TarefaUI, "status" | "concluido_em">[],
  agoraMs: number
): boolean {
  return tarefas.some((t) => {
    if (t.status !== "concluido" || t.concluido_em === null) return false;
    const fim = Date.parse(t.concluido_em);
    if (Number.isNaN(fim)) return false;
    const decorrido = agoraMs - fim;
    return decorrido >= 0 && decorrido < JANELA_CONCLUIDO_MS;
  });
}

/** O texto que o usuario le. O modificador vence o estado. */
export function rotuloDe(aparencia: AparenciaAgente): string {
  return aparencia.foraDeOperacao
    ? ROTULO_FORA_DE_OPERACAO
    : VOCABULARIO_ESTADO[aparencia.estado].rotulo;
}

/** Fora de operacao tambem troca o icone — senao "▶" contradiria o texto. */
export function iconeDe(aparencia: AparenciaAgente): string {
  return aparencia.foraDeOperacao ? "⏻" : VOCABULARIO_ESTADO[aparencia.estado].icone;
}

/** `true` quando o agente deve ser desenhado na estacao, sentado. */
export function estaNaEstacao(aparencia: AparenciaAgente): boolean {
  if (aparencia.foraDeOperacao) return false;
  return aparencia.estado !== "ocioso";
}
