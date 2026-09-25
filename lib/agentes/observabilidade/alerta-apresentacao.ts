/**
 * I4P10 — o que o OPERADOR ve de um incidente. Puro.
 *
 * ── A fronteira de minimizacao mora aqui ────────────────────────────
 *
 * Esta e a unica porta entre a linha do banco e a tela. Nenhum campo
 * chega ao navegador sem passar por `projetarIncidente`, e o que ela nao
 * lista nao sai: `user_id` e a propria sessao de quem perguntou,
 * `ultima_evidencia_chave` e vocabulario interno do reducer, e
 * `detalhes` inteiro seria despejo de diagnostico numa tela de operacao.
 *
 * ── ZERO INCIDENTES NAO E SAUDE ─────────────────────────────────────
 *
 * A regra mais importante deste arquivo, e a mais facil de quebrar sem
 * perceber. "Nenhum alerta aberto" responde UMA pergunta: nao ha
 * incidente registrado. Nao responde se o vigia rodou, se o agendador
 * executou, se a ingestao capturou pergunta alguma.
 *
 * Um monitor que nunca rodou tambem tem zero alertas — e e o pior estado
 * possivel, nao o melhor. Por isso esta camada NAO emite veredito de
 * saude, e `VEREDICTO_DE_SAUDE` existe para que quem for consumir isto
 * amanha tropece na constante antes de inventar um.
 *
 * ── SEVERIDADE NAO E RECALCULADA ────────────────────────────────────
 *
 * As tres severidades vem do dominio, prontas. A tela ordena e pinta;
 * nunca deriva. Uma quarta severidade aqui seria uma segunda verdade.
 */

import { TIPOS_DE_ALERTA, type SeveridadeDoAlerta, type TipoDeAlerta } from "./alerta";

/**
 * Esta superficie NAO conclui saude. Ver o cabecalho.
 *
 * O dia em que existir prova suficiente — vigia com atividade recente,
 * configuracao ativa e agendador observado —, o veredito nasce em outro
 * lugar e com nome proprio, nunca da ausencia de linha.
 */
export const VEREDICTO_DE_SAUDE = "indisponivel" as const;

/** Ordem explicita: comparar texto daria `alert` antes de `critical`. */
const RANKING: Readonly<Record<SeveridadeDoAlerta, number>> = Object.freeze({
  critical: 0,
  alert: 1,
  warning: 2,
});

export interface RotuloDeTipo {
  /** A manchete. Frase humana, nunca o enum. */
  readonly titulo: string;
  /** Uma linha explicando o que aquilo significa na pratica. */
  readonly explicacao: string;
}

export const ROTULOS_DE_TIPO: Readonly<Record<TipoDeAlerta, RotuloDeTipo>> = Object.freeze({
  scheduler_gap: {
    titulo: "Agendador sem execução esperada",
    explicacao: "Uma janela de cinco minutos deveria ter sido varrida e não foi, ou não terminou.",
  },
  cursor_stuck: {
    titulo: "Sincronização sem avanço",
    explicacao: "As varreduras estão acontecendo, mas a posição de leitura não sai do lugar.",
  },
  backlog_pressure: {
    titulo: "Fila de perguntas sob pressão",
    explicacao: "Sobra trabalho além do que cada janela consegue varrer.",
  },
  budget_pressure: {
    titulo: "Limite de processamento atingido",
    explicacao: "A varredura está parando por tempo antes de terminar a janela.",
  },
  cursor_regression: {
    titulo: "Leitura voltou para uma posição inesperada",
    explicacao: "A posição de leitura recuou sem um caminho conhecido que justifique.",
  },
  monitor_configuration_missing: {
    titulo: "Monitor ainda não configurado",
    explicacao: "Ninguém declarou se esta ingestão deveria estar sendo acompanhada.",
  },
  observability_data_incomplete: {
    titulo: "Monitor sem dados suficientes",
    explicacao: "Faltou informação para provar que está tudo certo — e não provar não é o mesmo que estar errado.",
  },
});

/**
 * As causas, por extenso.
 *
 * As tres do agendador precisam ficar DISTINTAS: "não apareceu",
 * "começou e não terminou" e "terminou com falha" pedem investigações
 * diferentes, e chamar as três de "o cron caiu" manda o operador para o
 * lugar errado duas vezes em três.
 */
export const ROTULOS_DE_CAUSA: Readonly<Record<string, string>> = Object.freeze({
  missing: "A execução esperada não apareceu",
  incomplete: "A execução começou e não terminou",
  failed: "A execução terminou com falha",
  stuck: "Entregou sem mover a posição de leitura",
  regression: "A posição de leitura recuou",
  pressao: "Ficou trabalho além da janela",
  orcamento: "A varredura parou por tempo",
  ausente: "Não há configuração declarada",
  ledger_truncado: "O histórico da janela não coube na leitura",
  cursor_ausente_apos_entrega: "Houve varredura e não há posição de leitura",
  cursor_de_outro_escopo: "A posição de leitura não é deste agente",
});

/**
 * As UNICAS chaves de `detalhes` que chegam ao operador.
 *
 * `detalhes` ja e sanitizado por allowlist na ESCRITA. Reprojetar na
 * leitura e a mesma disciplina de `projetarResumoDaAcao`: o que sai hoje
 * e o vocabulario de hoje, mesmo que a linha tenha sido gravada por
 * outra versao. E o recorte aqui e menor de proposito — a tela precisa
 * de QUAL janela e de QUANTO tempo, nao do diagnostico inteiro.
 */
const CHAVES_VISIVEIS = ["canonicalBucketId", "streak", "stuckStreak", "pressureStreak", "budgetStreak"] as const;

export interface IncidenteParaOperador {
  readonly id: string;
  /** Para navegar entre agentes. Nao e dado comercial. */
  readonly agenteId: string;
  readonly tipo: TipoDeAlerta;
  readonly titulo: string;
  readonly explicacao: string;
  readonly estado: "aberto" | "resolvido";
  readonly severidadeAtual: SeveridadeDoAlerta;
  readonly severidadeMaxima: SeveridadeDoAlerta;
  /** O codigo tecnico, para quem for investigar. Pode faltar. */
  readonly causaAtual: string | null;
  /** A mesma causa por extenso. `null` quando o codigo e desconhecido. */
  readonly causaTitulo: string | null;
  readonly abertoEm: string;
  readonly ultimoVistoEm: string;
  readonly ultimaAvaliacaoEm: string;
  readonly resolvidoEm: string | null;
  readonly ocorrencias: number;
  /** A janela de cinco minutos a que o incidente se refere, se houver. */
  readonly janela: string | null;
  /** Quantas janelas seguidas sustentam a condicao, se houver. */
  readonly sequencia: number | null;
}

const TIPOS: ReadonlySet<string> = new Set(TIPOS_DE_ALERTA);
const SEVERIDADES: ReadonlySet<string> = new Set(["warning", "alert", "critical"]);

function texto(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Projeta UMA linha do banco para a tela.
 *
 * `null` quando a linha nao tem o minimo para ser exibida com honestidade.
 * Descartar e melhor que mostrar meia verdade: um incidente sem tipo ou
 * sem severidade nao tem o que dizer ao operador.
 */
export function projetarIncidente(bruta: unknown): IncidenteParaOperador | null {
  if (typeof bruta !== "object" || bruta === null) return null;
  const o = bruta as Record<string, unknown>;

  const id = texto(o.id);
  const agenteId = texto(o.agente_id);
  const tipo = texto(o.tipo);
  const estado = texto(o.estado);
  const atual = texto(o.severidade_atual);
  const maxima = texto(o.severidade_maxima);
  const abertoEm = texto(o.aberto_em);
  const ultimoVistoEm = texto(o.ultimo_visto_em);
  const ultimaAvaliacaoEm = texto(o.ultima_avaliacao_em);
  const ocorrencias = o.ocorrencias;

  if (id === null || agenteId === null || abertoEm === null) return null;
  if (tipo === null || !TIPOS.has(tipo)) return null;
  if (estado !== "aberto" && estado !== "resolvido") return null;
  if (atual === null || !SEVERIDADES.has(atual)) return null;
  if (maxima === null || !SEVERIDADES.has(maxima)) return null;
  if (ultimoVistoEm === null || ultimaAvaliacaoEm === null) return null;
  if (typeof ocorrencias !== "number" || !Number.isInteger(ocorrencias)) return null;

  const rotulo = ROTULOS_DE_TIPO[tipo as TipoDeAlerta];
  const causaAtual = texto(o.causa_atual);

  const detalhes = typeof o.detalhes === "object" && o.detalhes !== null
    ? (o.detalhes as Record<string, unknown>)
    : {};
  let janela: string | null = null;
  let sequencia: number | null = null;
  for (const chave of CHAVES_VISIVEIS) {
    const v = detalhes[chave];
    if (chave === "canonicalBucketId") {
      if (typeof v === "string" && v.length > 0 && v.length <= 40) janela = v;
      continue;
    }
    if (sequencia === null && typeof v === "number" && Number.isInteger(v) && v >= 0) {
      sequencia = v;
    }
  }

  return {
    id,
    agenteId,
    tipo: tipo as TipoDeAlerta,
    titulo: rotulo.titulo,
    explicacao: rotulo.explicacao,
    estado,
    severidadeAtual: atual as SeveridadeDoAlerta,
    severidadeMaxima: maxima as SeveridadeDoAlerta,
    causaAtual,
    causaTitulo: causaAtual !== null ? ROTULOS_DE_CAUSA[causaAtual] ?? null : null,
    abertoEm,
    ultimoVistoEm,
    ultimaAvaliacaoEm,
    resolvidoEm: texto(o.resolvido_em),
    ocorrencias,
    janela,
    sequencia,
  };
}

/**
 * Mais grave primeiro; entre iguais, o mais antigo primeiro.
 *
 * O mais ANTIGO, e nao o mais recente: um incidente que ja dura horas e
 * mais urgente que um que acabou de nascer com a mesma severidade.
 */
export function ordenarIncidentes(
  lista: readonly IncidenteParaOperador[]
): readonly IncidenteParaOperador[] {
  return [...lista].sort((a, b) => {
    const porGravidade = RANKING[a.severidadeAtual] - RANKING[b.severidadeAtual];
    if (porGravidade !== 0) return porGravidade;
    return Date.parse(a.abertoEm) - Date.parse(b.abertoEm);
  });
}

/** O que a superficie sabe sobre o vigia daquele agente. */
export type AtividadeDoMonitor =
  | {
      readonly estado: "observada";
      /** Quando o vigia adquiriu, pela ultima vez, o direito de avaliar. */
      readonly adquiridaEm: string;
      /** Quando terminou aquela passagem, se ela terminou normalmente. */
      readonly liberadaEm: string | null;
    }
  /** Nunca houve uma passagem: o vigia pode nem estar implantado. */
  | { readonly estado: "nunca_observada" }
  | { readonly estado: "desconhecida" };

export type ConfiguracaoParaOperador =
  | "ativo"
  | "inativo"
  | "nao_configurado"
  | "desconhecido";

export interface MonitorDeUmAgente {
  readonly agenteId: string;
  readonly configuracao: ConfiguracaoParaOperador;
  readonly atividade: AtividadeDoMonitor;
}
