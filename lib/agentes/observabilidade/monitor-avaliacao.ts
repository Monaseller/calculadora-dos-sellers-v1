/**
 * OBS-5 — a traducao: do que os detectores VIRAM para o que o ciclo de
 * vida ENTENDE. Pura.
 *
 * ── Por que existe uma camada so para isto ──────────────────────────
 *
 * Se a rota montasse alerta por conta propria, a semantica ficaria
 * espalhada por um handler HTTP e ninguem conseguiria testa-la sem
 * banco. Aqui e funcao de dados para dados: entra o que foi observado,
 * sai `ObservacaoDeAlerta[]`. Sem rede, sem banco, sem `server-only`.
 *
 * ── SAUDAVEL NAO E SILENCIO ─────────────────────────────────────────
 *
 * O erro mais facil de cometer aqui seria emitir observacao SO quando ha
 * problema. O ciclo de vida do OBS-4 resolve um incidente por evidencia
 * SAUDAVEL distinta — sem elas, um `scheduler_gap` aberto ficaria aberto
 * para sempre mesmo depois do agendador voltar ao normal. Entao cada
 * dimensao aplicavel produz ATIVA ou SAUDAVEL, nunca nada.
 *
 * ── MAS SAUDAVEL TAMBEM NAO E CHUTE ─────────────────────────────────
 *
 * Emitir saude que nao foi observada e pior do que nao emitir. Duas
 * regras seguram isso:
 *
 *   config INATIVA  — "nao esperamos agendador agora" nao e "o agendador
 *                     provou recuperacao". Nenhuma observacao derivada do
 *                     agendador sai daqui nesse caso; os incidentes
 *                     antigos ficam preservados ate haver evidencia real.
 *   ledger TRUNCADO — se a carga bateu no teto, a classificacao dos
 *                     buckets pode estar errada por falta de linha. Entao
 *                     nada derivado dela e emitido: sai apenas o alerta
 *                     de dado incompleto, que e a verdade daquele ciclo.
 *
 * ── INCERTEZA CONHECIDA NAO E CEGUEIRA ──────────────────────────────
 *
 * `uncertain` por contaminacao conhecida — um `diag` mexeu no cursor —
 * significa que o dado esta INTEIRO e a conclusao e que nao da para
 * atribuir. Isso nao abre alerta de dado incompleto; abre, ao contrario,
 * a evidencia SAUDAVEL de que a observabilidade esta completa.
 */

import {
  calcularSequenciaDeBucketsDegradados,
  detectarSaudeDosBuckets,
  recomendarSeveridade,
  type EstadoEsperado,
  type LinhaDoLedger,
  type SaudeDoBucket,
  type Severidade,
} from "./gap";
import {
  analisarProgressoDoCursor,
  BUCKETS_PARA_PRESSAO_ALERT,
  BUCKETS_PARA_PRESSAO_WARNING,
  BUCKETS_PARA_TRAVAMENTO,
  type AnaliseDoCursor,
  type CursorAtual,
} from "./cursor-progresso";
import type { EvidenciaDeMutacaoDoCursor } from "./provenancia-cursor";
import {
  fatoAtivo,
  fatoSaudavel,
  sujeitoDoBucket,
  SUJEITO_DA_CONFIGURACAO,
  SUJEITO_DA_OBSERVABILIDADE,
  type EscopoDoAlerta,
  type ObservacaoDeAlerta,
  type SeveridadeDoAlerta,
  type TipoDeAlerta,
} from "./alerta";

/** O que a consulta do ledger entregou para UMA janela. */
export interface CargaDoLedger {
  readonly linhas: readonly LinhaDoLedger[];
  /** TODAS as acoes capazes de escrever o cursor na janela, nao so as do agendador. */
  readonly mutacoes: readonly EvidenciaDeMutacaoDoCursor[];
  /** A consulta bateu no teto: o que veio NAO e a janela inteira. */
  readonly truncada: boolean;
}

export type LeituraDoCursorDoMonitor =
  | { readonly estado: "encontrado"; readonly cursor: CursorAtual }
  /** Legitimo antes da primeira varredura; suspeito depois de uma entrega. */
  | { readonly estado: "ausente" }
  | { readonly estado: "falhou" };

export interface EntradaDaAvaliacao {
  readonly agora: number;
  readonly escopo: EscopoDoAlerta;
  readonly configuracao: EstadoEsperado;
  /** Ausente quando a configuracao nao mandou avaliar o agendador. */
  readonly carga?: CargaDoLedger | null;
  readonly cursor?: LeituraDoCursorDoMonitor | null;
}

export interface Avaliacao {
  readonly observacoes: readonly ObservacaoDeAlerta[];
  /** Codigos curtos, para log. Nunca conteudo comercial. */
  readonly diagnosticos: readonly string[];
}

/** Severidade de `monitor_configuration_missing`: acionavel, nao emergencia. */
const SEVERIDADE_DA_CONFIGURACAO: SeveridadeDoAlerta = "alert";
/** Severidade de dado de observabilidade faltando: o vigia nao prova saude. */
const SEVERIDADE_DO_DADO_INCOMPLETO: SeveridadeDoAlerta = "alert";
/** Cursor andando para tras. Nao e perda; e releitura. */
const SEVERIDADE_DA_REGRESSAO: SeveridadeDoAlerta = "alert";

/** `nenhuma` nunca vira observacao ativa: ativo exige severidade. */
function comoSeveridade(s: Severidade): SeveridadeDoAlerta {
  return s === "nenhuma" ? "warning" : s;
}

/**
 * Travamento: `alert` a partir do limiar do detector, `critical` quando
 * a duracao chega ao limiar de pressao ja congelado (12 buckets = 1h).
 *
 * As duas constantes sao REUSADAS de proposito. Inventar um numero novo
 * aqui seria fixar em codigo uma fronteira que ninguem mediu.
 */
function severidadeDoTravamento(stuckStreak: number): SeveridadeDoAlerta {
  if (stuckStreak >= BUCKETS_PARA_PRESSAO_ALERT) return "critical";
  return stuckStreak >= BUCKETS_PARA_TRAVAMENTO ? "alert" : "warning";
}

function severidadeDoOrcamento(budgetStreak: number): SeveridadeDoAlerta {
  return budgetStreak >= BUCKETS_PARA_PRESSAO_WARNING ? "alert" : "warning";
}

/** Um bucket chegou a entregar alguma coisa nesta janela? */
function houveEntrega(buckets: readonly SaudeDoBucket[]): boolean {
  return buckets.some(
    (b) => b.classificacao === "BUCKET_SUCCEEDED" || b.classificacao === "BUCKET_RECOVERED"
  );
}

/** A incerteza foi EXPLICADA por contaminacao conhecida? */
function contaminacaoConhecida(analise: AnaliseDoCursor): boolean {
  return analise.diagnosticos.some(
    (d) => d.startsWith("transicao_contaminada") || d === "cursor_atual_contaminado"
  );
}

const DETERMINADOS = new Set(["progress", "complete", "idle"]);

export function avaliarIngestao(entrada: EntradaDaAvaliacao): Avaliacao {
  const { agora, escopo, configuracao } = entrada;
  const observacoes: ObservacaoDeAlerta[] = [];
  const diagnosticos: string[] = [];

  const ativa = (
    tipo: TipoDeAlerta,
    severidade: SeveridadeDoAlerta,
    causa: string,
    sujeito: string,
    fato: string,
    detalhes: unknown
  ) => {
    observacoes.push({
      tipo, escopo, ativo: true, severidade, causa,
      sujeitoDaEvidencia: sujeito, fatoDaEvidencia: fato,
      detalhes, observadoEm: agora,
    });
  };
  const sadia = (tipo: TipoDeAlerta, sujeito: string, fato: string, detalhes: unknown) => {
    observacoes.push({
      tipo, escopo, ativo: false,
      sujeitoDaEvidencia: sujeito, fatoDaEvidencia: fato,
      detalhes, observadoEm: agora,
    });
  };

  // ── 1. A configuracao, que decide se ha o que avaliar ──────────────
  if (configuracao.estado === "falhou_leitura") {
    // O orquestrador nao deveria chegar aqui: leitura falha e falha de
    // plataforma, e plataforma nao se monitora a si mesma. Se chegar,
    // NAO inventa observacao nenhuma.
    return { observacoes: [], diagnosticos: ["configuracao_ilegivel"] };
  }

  if (configuracao.estado === "configuracao_ausente") {
    ativa(
      "monitor_configuration_missing", SEVERIDADE_DA_CONFIGURACAO, "ausente",
      SUJEITO_DA_CONFIGURACAO, fatoAtivo("ausente"),
      { diagnostico: "sem_linha_de_estado_esperado" }
    );
    return { observacoes, diagnosticos: ["configuracao_ausente"] };
  }

  if (configuracao.estado === "configurado_inativo") {
    // A configuracao EXISTE — isso resolve o alerta de configuracao. Mas
    // "nao esperamos agendador" nao prova recuperacao de nada: nenhuma
    // observacao derivada do agendador sai daqui.
    sadia("monitor_configuration_missing", SUJEITO_DA_CONFIGURACAO, fatoSaudavel("inativo"),
      { diagnostico: "configuracao_declarada_inativa" });
    return { observacoes, diagnosticos: ["configuracao_inativa"] };
  }

  sadia("monitor_configuration_missing", SUJEITO_DA_CONFIGURACAO, fatoSaudavel("ativo"),
    { diagnostico: "configuracao_declarada_ativa" });

  const carga = entrada.carga ?? null;
  const cursor = entrada.cursor ?? null;
  if (carga === null || cursor === null) {
    // Config ativa sem carga e erro de chamada, nao estado do sistema.
    return { observacoes, diagnosticos: [...diagnosticos, "carga_ausente"] };
  }

  // ── 2. Os buckets ─────────────────────────────────────────────────
  const deteccao = detectarSaudeDosBuckets({
    configuracao, agora, agenteId: escopo.agenteId, linhas: carga.linhas,
  });
  if (deteccao.resultado !== "AVALIADO") {
    return { observacoes, diagnosticos: [...diagnosticos, "deteccao_" + deteccao.resultado] };
  }
  const buckets = deteccao.buckets;
  for (const a of deteccao.achados) diagnosticos.push("ledger_" + a.diagnostico);

  // ── 3. O cursor ───────────────────────────────────────────────────
  const cursorAtual = cursor.estado === "encontrado" ? cursor.cursor : null;
  const analise = analisarProgressoDoCursor({
    escopo: { agenteId: escopo.agenteId, plataforma: escopo.plataforma, recurso: escopo.recurso },
    buckets, cursorAtual, mutacoes: carga.mutacoes,
  });

  // ── 4. O dado de observabilidade esta inteiro? ────────────────────
  //
  // So sinal EXPLICITO conta. `uncertain` por bucket sem entrega NAO
  // entra aqui: aquilo e culpa do agendador e ja vira `scheduler_gap`.
  // Confundir os dois faria o vigia acusar cegueira propria toda vez que
  // o agendador falhasse.
  const faltas: string[] = [];
  if (carga.truncada) faltas.push("ledger_truncado");
  if (cursor.estado === "ausente" && houveEntrega(buckets)) faltas.push("cursor_ausente_apos_entrega");
  if (analise.diagnosticos.includes("cursor_de_outro_escopo")) faltas.push("cursor_de_outro_escopo");

  if (faltas.length > 0) {
    ativa(
      "observability_data_incomplete", SEVERIDADE_DO_DADO_INCOMPLETO, faltas[0],
      SUJEITO_DA_OBSERVABILIDADE, fatoAtivo(faltas[0], faltas.length),
      { diagnostico: faltas.join("|").slice(0, 120) }
    );
    diagnosticos.push(...faltas);
  } else {
    sadia("observability_data_incomplete", SUJEITO_DA_OBSERVABILIDADE, fatoSaudavel("completo"),
      { estadoDoCursor: analise.estado });
  }

  // Ledger truncado invalida a classificacao dos buckets: nada derivado
  // dela e emitido. Um `scheduler_gap` fabricado por linha faltante
  // seria exatamente o alarme falso que destroi a confianca no vigia.
  if (carga.truncada) return { observacoes, diagnosticos };

  // ── 5. scheduler_gap ──────────────────────────────────────────────
  const fechados = buckets.filter((b) => b.classificacao !== "BUCKET_OPEN");
  const ultimo = fechados.length > 0 ? fechados[fechados.length - 1] : null;

  if (ultimo === null) {
    // Janela so com bucket aberto: nao ha evidencia a favor nem contra.
    // Omitir e a resposta certa — nao ha o que afirmar.
    diagnosticos.push("sem_bucket_fechado");
    return { observacoes, diagnosticos };
  }

  const sujeito = sujeitoDoBucket(ultimo.canonicalBucketId);
  const comum = {
    canonicalBucketId: ultimo.canonicalBucketId,
    bucketEm: ultimo.bucketEm,
    classificacao: ultimo.classificacao,
  };
  const sev = recomendarSeveridade(calcularSequenciaDeBucketsDegradados(buckets));

  if (ultimo.classificacao === "BUCKET_MISSING") {
    ativa("scheduler_gap", comoSeveridade(sev.missing), "missing", sujeito, fatoAtivo("missing"), comum);
  } else if (ultimo.classificacao === "BUCKET_INCOMPLETE") {
    ativa("scheduler_gap", comoSeveridade(sev.incomplete), "incomplete", sujeito, fatoAtivo("incomplete"), comum);
  } else if (ultimo.classificacao === "BUCKET_FAILED") {
    ativa("scheduler_gap", comoSeveridade(sev.failed), "failed", sujeito, fatoAtivo("failed"), comum);
  } else {
    sadia("scheduler_gap", sujeito,
      fatoSaudavel(ultimo.classificacao === "BUCKET_RECOVERED" ? "recovered" : "succeeded"), comum);
  }

  // ── 6. As dimensoes do cursor ─────────────────────────────────────
  //
  // Cursor de outro escopo ja foi acusado como dado incompleto; derivar
  // travamento ou pressao dele seria construir conclusao sobre entrada
  // que acabamos de declarar suspeita.
  if (faltas.includes("cursor_de_outro_escopo") || faltas.includes("cursor_ausente_apos_entrega")) {
    return { observacoes, diagnosticos };
  }

  const detalheDoCursor = {
    ...comum,
    estadoDoCursor: analise.estado,
    stuckStreak: analise.stuckStreak,
    pressureStreak: analise.pressureStreak,
    budgetStreak: analise.budgetStreak,
  };
  const determinado = DETERMINADOS.has(analise.estado);

  if (analise.estado === "stuck") {
    ativa("cursor_stuck", severidadeDoTravamento(analise.stuckStreak), "stuck",
      sujeito, fatoAtivo("stuck", analise.stuckStreak), detalheDoCursor);
  } else if (determinado) {
    sadia("cursor_stuck", sujeito, fatoSaudavel(analise.estado), detalheDoCursor);
  }

  if (analise.estado === "regression") {
    ativa("cursor_regression", SEVERIDADE_DA_REGRESSAO, "regression",
      sujeito, fatoAtivo("regression"), detalheDoCursor);
  } else if (determinado) {
    sadia("cursor_regression", sujeito, fatoSaudavel(analise.estado), detalheDoCursor);
  }

  if (analise.estado === "uncertain") {
    diagnosticos.push(contaminacaoConhecida(analise) ? "incerteza_conhecida" : "incerteza_sem_causa_nomeada");
  }

  // ── 7. Pressao ────────────────────────────────────────────────────
  //
  // `severidadeDePressao` nao tem `critical` no tipo: BACKLOG_CRITICAL_RULE
  // continua adiada, e a garantia e estrutural, nao disciplina.
  if (analise.severidadeDePressao !== "nenhuma") {
    ativa("backlog_pressure", analise.severidadeDePressao, "pressao",
      sujeito, fatoAtivo("pressao", analise.pressureStreak), detalheDoCursor);
  } else if (determinado) {
    sadia("backlog_pressure", sujeito, fatoSaudavel("sem_pressao"), detalheDoCursor);
  }

  if (analise.budgetPressure) {
    ativa("budget_pressure", severidadeDoOrcamento(analise.budgetStreak), "orcamento",
      sujeito, fatoAtivo("orcamento", analise.budgetStreak), detalheDoCursor);
  } else if (determinado) {
    sadia("budget_pressure", sujeito, fatoSaudavel("sem_orcamento_esgotado"), detalheDoCursor);
  }

  return { observacoes, diagnosticos };
}
