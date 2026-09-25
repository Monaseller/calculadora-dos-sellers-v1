/**
 * OBS-4 — o ciclo de vida de um incidente, PURO.
 *
 * Este modulo e a VERDADE do lifecycle. O repositorio so aplica o que ele
 * decide; nenhuma regra de abrir, escalar ou resolver vive no SQL.
 *
 * ── REAVALIAR NAO E OBSERVAR DE NOVO ────────────────────────────────
 *
 * O vigia roda a cada minuto; o agendador, a cada cinco. Cinco leituras
 * do MESMO bucket nao sao cinco evidencias — sao a mesma evidencia lida
 * cinco vezes. Contar chamadas do monitor faria um incidente escalar
 * sozinho e, pior, faria um alerta se resolver sem que o agendador
 * tivesse produzido nada de novo.
 *
 * Por isso toda observacao carrega uma `chaveDaEvidencia`, e o incidente
 * guarda a ultima que viu. Chave repetida atualiza o relogio de
 * avaliacao e mais nada.
 *
 * ── INCERTEZA TEM DUAS CAUSAS, E SO UMA E ALERTA ────────────────────
 *
 * Contaminacao CONHECIDA — um `diag` escreveu o cursor entre dois
 * buckets — e explicavel: fica no diagnostico e nao abre incidente.
 *
 * Falta de dado de observabilidade e outra coisa: significa que o vigia
 * NAO CONSEGUE provar saude. Isso tem tipo proprio, porque um watchdog
 * que nao sabe se esta cego e pior do que nao ter watchdog.
 *
 * Puro: sem banco, sem rede, sem `server-only`.
 */

export const TIPOS_DE_ALERTA = [
  "scheduler_gap",
  "cursor_stuck",
  "backlog_pressure",
  "budget_pressure",
  "cursor_regression",
  "monitor_configuration_missing",
  "observability_data_incomplete",
] as const;

export type TipoDeAlerta = (typeof TIPOS_DE_ALERTA)[number];

export type SeveridadeDoAlerta = "warning" | "alert" | "critical";

/** Ordem explicita: comparar texto daria `alert > critical`. */
const PESO: Readonly<Record<SeveridadeDoAlerta, number>> = Object.freeze({
  warning: 1,
  alert: 2,
  critical: 3,
});

export function severidadeMaior(
  a: SeveridadeDoAlerta,
  b: SeveridadeDoAlerta
): SeveridadeDoAlerta {
  return PESO[a] >= PESO[b] ? a : b;
}

/**
 * Quantas EVIDENCIAS saudaveis DISTINTAS resolvem cada tipo.
 *
 * Os cinco primeiros dependem de evidencia do agendador: duas evidencias
 * distintas sao dois buckets, dez minutos, o suficiente para nao oscilar
 * na fronteira sem atrasar demais a resolucao.
 *
 * Os dois ultimos nao dependem do agendador. `monitor_configuration_missing`
 * some no instante em que a configuracao aparece, e
 * `observability_data_incomplete` some no instante em que o input volta a
 * ser completo — as duas condicoes sao diretamente observaveis pelo
 * proprio vigia, e exigir corroboracao de um tick futuro deixaria um
 * alerta aberto sem motivo.
 */
export const EVIDENCIAS_PARA_RESOLVER: Readonly<Record<TipoDeAlerta, number>> =
  Object.freeze({
    scheduler_gap: 2,
    cursor_stuck: 2,
    backlog_pressure: 2,
    budget_pressure: 2,
    cursor_regression: 2,
    monitor_configuration_missing: 1,
    observability_data_incomplete: 1,
  });

export interface EscopoDoAlerta {
  readonly userId: string;
  readonly agenteId: string;
  readonly plataforma: string;
  readonly recurso: string;
}

export interface ObservacaoDeAlerta {
  readonly tipo: TipoDeAlerta;
  readonly escopo: EscopoDoAlerta;
  /** A condicao esta valendo AGORA? */
  readonly ativo: boolean;
  /** Obrigatoria quando `ativo`. */
  readonly severidade?: SeveridadeDoAlerta | null;
  /** A causa dentro do tipo: `missing`, `incomplete`, `failed`… */
  readonly causa?: string | null;
  /** O que torna esta observacao NOVA. Tipicamente o bucket canonico. */
  readonly chaveDaEvidencia: string;
  readonly detalhes?: unknown;
  /** Epoch ms. */
  readonly observadoEm: number;
}

export interface IncidenteAberto {
  readonly tipo: TipoDeAlerta;
  readonly severidadeAtual: SeveridadeDoAlerta;
  readonly severidadeMaxima: SeveridadeDoAlerta;
  readonly causaAtual: string | null;
  readonly ocorrencias: number;
  readonly ultimaEvidenciaChave: string | null;
  readonly evidenciasSaudaveisConsecutivas: number;
}

export interface CamposDeAtualizacao {
  readonly severidadeAtual?: SeveridadeDoAlerta;
  readonly severidadeMaxima?: SeveridadeDoAlerta;
  readonly causaAtual?: string | null;
  readonly ocorrencias?: number;
  readonly ultimaEvidenciaChave?: string;
  readonly evidenciasSaudaveisConsecutivas?: number;
  readonly ultimoVistoEm?: number;
  readonly ultimaAvaliacaoEm: number;
  readonly detalhes?: Record<string, string | number | boolean>;
}

export interface NovoIncidente {
  readonly tipo: TipoDeAlerta;
  readonly escopo: EscopoDoAlerta;
  readonly severidadeAtual: SeveridadeDoAlerta;
  readonly severidadeMaxima: SeveridadeDoAlerta;
  readonly causaAtual: string | null;
  readonly ocorrencias: 1;
  readonly ultimaEvidenciaChave: string;
  readonly evidenciasSaudaveisConsecutivas: 0;
  readonly abertoEm: number;
  readonly ultimoVistoEm: number;
  readonly ultimaAvaliacaoEm: number;
  readonly detalhes: Record<string, string | number | boolean>;
}

export type IntencaoDoAlerta =
  | { readonly acao: "NOOP"; readonly motivo: string }
  | { readonly acao: "OPEN"; readonly incidente: NovoIncidente }
  | { readonly acao: "UPDATE"; readonly campos: CamposDeAtualizacao; readonly motivo: string }
  | {
      readonly acao: "RESOLVE";
      readonly campos: CamposDeAtualizacao;
      readonly resolvidoEm: number;
      readonly motivo: string;
    };

/**
 * As UNICAS chaves que podem ir para `detalhes`.
 *
 * Um alerta e lido por gente e guardado por tempo indeterminado. Nada de
 * texto de pergunta, comprador, token, credencial, header, corpo HTTP ou
 * argumento comercial encosta aqui. O que entra e diagnostico: qual
 * bucket, quanto tempo, quanta sequencia, qual certeza.
 */
const CHAVES_DE_DETALHE = [
  "canonicalBucketId",
  "bucketEm",
  "streak",
  "stuckStreak",
  "pressureStreak",
  "budgetStreak",
  "offsetInicial",
  "offsetFinal",
  "certeza",
  "origemDoFim",
  "evidencia",
  "diagnostico",
  "classificacao",
  "estadoDoCursor",
  "buckets",
] as const;

/**
 * Projeta `detalhes` pela allowlist. Chave fora da lista nao entra;
 * valor que nao e texto curto, numero finito ou booleano nao entra.
 */
export function sanitizarDetalhesDoAlerta(
  bruto: unknown
): Record<string, string | number | boolean> {
  const saida: Record<string, string | number | boolean> = {};
  if (typeof bruto !== "object" || bruto === null || Array.isArray(bruto)) return saida;
  const origem = bruto as Record<string, unknown>;
  for (const chave of CHAVES_DE_DETALHE) {
    const v = origem[chave];
    if (typeof v === "boolean") { saida[chave] = v; continue; }
    if (typeof v === "number" && Number.isFinite(v)) { saida[chave] = v; continue; }
    // Texto so em tamanho de diagnostico: um campo longo seria a porta
    // por onde conteudo comercial entraria sem ser notado.
    if (typeof v === "string" && v.length > 0 && v.length <= 120) saida[chave] = v;
  }
  return saida;
}

/**
 * A decisao. Recebe o incidente ABERTO (ou `null`) e uma observacao, e
 * devolve a intencao — nunca toca banco.
 */
export function reduzirEstadoDoAlerta(
  atual: IncidenteAberto | null,
  obs: ObservacaoDeAlerta
): IntencaoDoAlerta {
  const detalhes = sanitizarDetalhesDoAlerta(obs.detalhes);
  const mesmaEvidencia =
    atual !== null && atual.ultimaEvidenciaChave === obs.chaveDaEvidencia;

  // ── Condicao ATIVA ────────────────────────────────────────────────
  if (obs.ativo) {
    const severidade = obs.severidade ?? "warning";

    if (atual === null) {
      return {
        acao: "OPEN",
        incidente: {
          tipo: obs.tipo,
          escopo: obs.escopo,
          severidadeAtual: severidade,
          severidadeMaxima: severidade,
          causaAtual: obs.causa ?? null,
          ocorrencias: 1,
          ultimaEvidenciaChave: obs.chaveDaEvidencia,
          evidenciasSaudaveisConsecutivas: 0,
          abertoEm: obs.observadoEm,
          ultimoVistoEm: obs.observadoEm,
          ultimaAvaliacaoEm: obs.observadoEm,
          detalhes,
        },
      };
    }

    if (mesmaEvidencia) {
      // A MESMA evidencia relida. Nao ha novidade: nao conta ocorrencia,
      // nao escala por repeticao. Mas zera a recuperacao, porque a
      // condicao continua valendo.
      return {
        acao: "UPDATE",
        motivo: "mesma evidencia ainda ativa",
        campos: {
          evidenciasSaudaveisConsecutivas: 0,
          causaAtual: obs.causa ?? null,
          severidadeAtual: severidade,
          severidadeMaxima: severidadeMaior(atual.severidadeMaxima, severidade),
          ultimaAvaliacaoEm: obs.observadoEm,
          detalhes,
        },
      };
    }

    return {
      acao: "UPDATE",
      motivo: "nova evidencia ativa",
      campos: {
        ocorrencias: atual.ocorrencias + 1,
        evidenciasSaudaveisConsecutivas: 0,
        ultimaEvidenciaChave: obs.chaveDaEvidencia,
        causaAtual: obs.causa ?? null,
        severidadeAtual: severidade,
        severidadeMaxima: severidadeMaior(atual.severidadeMaxima, severidade),
        ultimoVistoEm: obs.observadoEm,
        ultimaAvaliacaoEm: obs.observadoEm,
        detalhes,
      },
    };
  }

  // ── Condicao AUSENTE ──────────────────────────────────────────────
  if (atual === null) {
    return { acao: "NOOP", motivo: "nada ativo e nenhum incidente aberto" };
  }

  if (mesmaEvidencia) {
    // Saude relida sobre a MESMA evidencia nao e recuperacao nova. Sem
    // isto, um monitor de um minuto resolveria qualquer incidente em dois
    // minutos sem o agendador ter produzido bucket algum.
    return {
      acao: "UPDATE",
      motivo: "mesma evidencia saudavel reavaliada",
      campos: { ultimaAvaliacaoEm: obs.observadoEm },
    };
  }

  const saudaveis = atual.evidenciasSaudaveisConsecutivas + 1;
  const exigidas = EVIDENCIAS_PARA_RESOLVER[obs.tipo];

  if (saudaveis >= exigidas) {
    return {
      acao: "RESOLVE",
      resolvidoEm: obs.observadoEm,
      motivo: `${saudaveis} evidencia(s) saudavel(is) distinta(s), exigidas ${exigidas}`,
      campos: {
        evidenciasSaudaveisConsecutivas: saudaveis,
        ultimaEvidenciaChave: obs.chaveDaEvidencia,
        ultimaAvaliacaoEm: obs.observadoEm,
      },
    };
  }

  return {
    acao: "UPDATE",
    motivo: `recuperacao em andamento: ${saudaveis} de ${exigidas}`,
    campos: {
      evidenciasSaudaveisConsecutivas: saudaveis,
      ultimaEvidenciaChave: obs.chaveDaEvidencia,
      ultimaAvaliacaoEm: obs.observadoEm,
    },
  };
}
