/**
 * OBS-4 — o ciclo de vida de um incidente, PURO.
 *
 * Este modulo e a VERDADE do lifecycle. O repositorio so aplica o que ele
 * decide; nenhuma regra de abrir, escalar ou resolver vive no SQL.
 *
 * ── REAVALIAR NAO E OBSERVAR DE NOVO ────────────────────────────────
 *
 * O vigia roda a cada minuto; o agendador, a cada cinco. Cinco leituras
 * do MESMO fato nao sao cinco evidencias — sao a mesma evidencia lida
 * cinco vezes. Contar chamadas do monitor faria um incidente escalar
 * sozinho e, pior, faria um alerta se resolver sem que o agendador
 * tivesse produzido nada de novo.
 *
 * ── MAS O MESMO BUCKET PODE TRAZER FATO NOVO (I4P8-R1) ──────────────
 *
 * A reciproca tambem e falsa: chave igual ao bucket canonico confundiria
 * duas coisas diferentes. As 13h05 o bucket B esta INCOMPLETE — ha
 * abertura e nao ha terminal. As 13h11 o terminal atrasado chega e o
 * MESMO bucket B fica SUCCEEDED. Isso nao e releitura; e fato novo sobre
 * a mesma unidade. Com a chave igual ao bucket, essa recuperacao nao
 * seria contada e o incidente ficaria aberto para sempre.
 *
 * Entao a evidencia tem duas partes:
 *
 *   SUJEITO — a unidade logica observada: o bucket, a configuracao, o
 *             input de observabilidade. Muda quando a observacao passa a
 *             falar de OUTRA coisa.
 *   FATO    — o que se sabe sobre ela agora, ja marcado como ativo
 *             (`a:`) ou saudavel (`h:`). Muda quando o conhecimento muda.
 *
 * A chave e `sujeito#fato`, e disso saem tres transicoes — so tres:
 *
 *   REPETICAO    — sujeito e fato iguais. O vigia passou de novo pelo
 *                  mesmo fato. Nao conta nada.
 *   REFINAMENTO  — mesmo sujeito, mesma classe, fato diferente. MISSING
 *                  virando INCOMPLETE no mesmo bucket e o mesmo
 *                  incidente ficando mais nitido, nao um incidente novo.
 *   NOVA UNIDADE — o sujeito mudou, ou a classe virou (ativo <-> saudavel).
 *                  E o UNICO caso que conta ocorrencia ou recuperacao.
 *
 * A classe dentro do fato e o que permite o terminal tardio do PROPRIO
 * bucket valer como primeira evidencia saudavel e, ao mesmo tempo,
 * impede que dois fatos saudaveis sobre o MESMO bucket resolvam sozinhos
 * um alerta cuja politica exige dois buckets saudaveis.
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

// ── Identidade da evidencia ──────────────────────────────────────────

export const SEPARADOR_DA_EVIDENCIA = "#";
export const LIMITE_DO_PEDACO = 48;

/** Sujeitos que nao vem de bucket: a condicao existe fora do agendador. */
export const SUJEITO_DA_CONFIGURACAO = "cfg";
export const SUJEITO_DA_OBSERVABILIDADE = "obs";

const MARCA_ATIVA = "a";
const MARCA_SAUDAVEL = "h";

/**
 * So enum, codigo curto e contador entram numa chave de evidencia.
 * Qualquer outro caractere vira `_`.
 *
 * A chave e guardada por tempo indeterminado e lida por gente. Deixar
 * texto livre passar faria dela a porta por onde pergunta de comprador,
 * identificador de conta ou pedaco de header entrariam sem ninguem
 * notar — a mesma razao pela qual `detalhes` tem allowlist.
 */
const FORA_DO_ALFABETO = /[^A-Za-z0-9_.:-]+/g;

export function normalizarPedacoDaEvidencia(bruto: unknown): string {
  if (typeof bruto !== "string" || bruto.length === 0) return "_";
  return bruto.replace(FORA_DO_ALFABETO, "_").slice(0, LIMITE_DO_PEDACO);
}

/** O bucket canonico como sujeito: `b:w5m-20260926T1300Z`. */
export function sujeitoDoBucket(canonicalBucketId: string): string {
  return "b:" + normalizarPedacoDaEvidencia(canonicalBucketId);
}

function montarFato(marca: string, codigo: string, contagem?: number): string {
  const base = marca + ":" + normalizarPedacoDaEvidencia(codigo);
  if (contagem === undefined) return base;
  // Contador invalido NAO some em silencio: vira `n?`, visivel em
  // qualquer leitura. Descartar o pedaco fundiria dois fatos distintos
  // numa chave so, que e exatamente o erro que este modulo evita.
  const n = Number.isSafeInteger(contagem) && contagem >= 0 ? String(contagem) : "?";
  return base + ":n" + n;
}

/** O fato de a condicao estar valendo: `a:missing`, `a:stuck:n3`. */
export function fatoAtivo(codigo: string, contagem?: number): string {
  return montarFato(MARCA_ATIVA, codigo, contagem);
}

/** O fato de a condicao ter cedido: `h:succeeded`, `h:sem_pressao`. */
export function fatoSaudavel(codigo: string, contagem?: number): string {
  return montarFato(MARCA_SAUDAVEL, codigo, contagem);
}

export function chaveDaEvidencia(sujeito: string, fato: string): string {
  return (
    normalizarPedacoDaEvidencia(sujeito) +
    SEPARADOR_DA_EVIDENCIA +
    normalizarPedacoDaEvidencia(fato)
  );
}

export type ClasseDaEvidencia = "ativa" | "saudavel" | "indefinida";

export interface LeituraDaEvidencia {
  readonly sujeito: string;
  readonly fato: string;
  readonly classe: ClasseDaEvidencia;
}

/**
 * Le a chave guardada de volta nas duas partes.
 *
 * Nao ha coluna nova para o sujeito: `#` esta fora do alfabeto dos
 * pedacos, entao a chave e decomponivel sem ambiguidade e
 * `ultima_evidencia_chave` continua bastando.
 */
export function lerChaveDaEvidencia(chave: unknown): LeituraDaEvidencia | null {
  if (typeof chave !== "string") return null;
  const i = chave.indexOf(SEPARADOR_DA_EVIDENCIA);
  if (i <= 0 || i === chave.length - 1) return null;
  const fato = chave.slice(i + 1);
  const classe: ClasseDaEvidencia = fato.startsWith(MARCA_ATIVA + ":")
    ? "ativa"
    : fato.startsWith(MARCA_SAUDAVEL + ":")
      ? "saudavel"
      : "indefinida";
  return { sujeito: chave.slice(0, i), fato, classe };
}

export type TransicaoDaEvidencia = "repeticao" | "refinamento" | "nova_unidade";

export function compararEvidencias(
  anterior: string | null,
  atual: string
): TransicaoDaEvidencia {
  if (anterior === atual) return "repeticao";
  const a = lerChaveDaEvidencia(anterior);
  const b = lerChaveDaEvidencia(atual);
  // Chave anterior ausente ou ilegivel conta como unidade nova. Errar
  // para cima aqui infla uma contagem; errar para baixo esconderia uma
  // reincidencia — e reincidencia e a primeira coisa que alguem procura
  // as tres da manha.
  if (a === null || b === null) return "nova_unidade";
  if (a.sujeito !== b.sujeito) return "nova_unidade";
  // Classe virada (ativo <-> saudavel) e sempre unidade nova: e a
  // recuperacao, ou a recaida. `indefinida` tambem, por nao ser
  // comparavel com seguranca.
  if (a.classe !== b.classe || a.classe === "indefinida") return "nova_unidade";
  return "refinamento";
}

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
  /** A unidade logica observada. `sujeitoDoBucket(...)` ou um dos fixos. */
  readonly sujeitoDaEvidencia: string;
  /** O que se sabe sobre ela: `fatoAtivo(...)` ou `fatoSaudavel(...)`. */
  readonly fatoDaEvidencia: string;
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
  const chave = chaveDaEvidencia(obs.sujeitoDaEvidencia, obs.fatoDaEvidencia);
  const transicao: TransicaoDaEvidencia =
    atual === null ? "nova_unidade" : compararEvidencias(atual.ultimaEvidenciaChave, chave);

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
          ultimaEvidenciaChave: chave,
          evidenciasSaudaveisConsecutivas: 0,
          abertoEm: obs.observadoEm,
          ultimoVistoEm: obs.observadoEm,
          ultimaAvaliacaoEm: obs.observadoEm,
          detalhes,
        },
      };
    }

    if (transicao === "repeticao") {
      // O MESMO fato relido. Nao ha novidade: nao conta ocorrencia, nao
      // escala por repeticao, nao avanca `ultimoVistoEm` — releitura nao
      // e observacao. Mas zera a recuperacao, porque a condicao continua
      // valendo, e ainda deixa a severidade acompanhar o que veio.
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

    const comuns = {
      evidenciasSaudaveisConsecutivas: 0,
      ultimaEvidenciaChave: chave,
      causaAtual: obs.causa ?? null,
      severidadeAtual: severidade,
      severidadeMaxima: severidadeMaior(atual.severidadeMaxima, severidade),
      // Fato novo sobre condicao ativa: a condicao FOI vista de novo,
      // com informacao nova. Isso avanca `ultimoVistoEm` mesmo quando e
      // so refinamento.
      ultimoVistoEm: obs.observadoEm,
      ultimaAvaliacaoEm: obs.observadoEm,
      detalhes,
    };

    if (transicao === "refinamento") {
      // MISSING virando INCOMPLETE no MESMO bucket e o mesmo incidente
      // ficando mais nitido. Contar ocorrencia aqui inflaria a
      // reincidencia com o proprio detalhamento do incidente.
      return {
        acao: "UPDATE",
        motivo: "mesmo sujeito, fato ativo novo: refinamento",
        campos: comuns,
      };
    }

    return {
      acao: "UPDATE",
      motivo: "nova unidade de evidencia ativa",
      campos: { ...comuns, ocorrencias: atual.ocorrencias + 1 },
    };
  }

  // ── Condicao AUSENTE ──────────────────────────────────────────────
  if (atual === null) {
    return { acao: "NOOP", motivo: "nada ativo e nenhum incidente aberto" };
  }

  if (transicao === "repeticao") {
    // Saude relida sobre o MESMO fato nao e recuperacao nova. Sem isto,
    // um monitor de um minuto resolveria qualquer incidente em dois
    // minutos sem o agendador ter produzido bucket algum.
    return {
      acao: "UPDATE",
      motivo: "mesma evidencia saudavel reavaliada",
      campos: { ultimaAvaliacaoEm: obs.observadoEm },
    };
  }

  if (transicao === "refinamento") {
    // Dois fatos saudaveis sobre o MESMO sujeito sao a mesma recuperacao
    // vista com mais nitidez. Conta-los como dois resolveria com UM
    // bucket um alerta cuja politica exige dois.
    return {
      acao: "UPDATE",
      motivo: "refinamento da mesma evidencia saudavel",
      campos: { ultimaEvidenciaChave: chave, ultimaAvaliacaoEm: obs.observadoEm },
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
        ultimaEvidenciaChave: chave,
        ultimaAvaliacaoEm: obs.observadoEm,
      },
    };
  }

  return {
    acao: "UPDATE",
    motivo: `recuperacao em andamento: ${saudaveis} de ${exigidas}`,
    campos: {
      evidenciasSaudaveisConsecutivas: saudaveis,
      ultimaEvidenciaChave: chave,
      ultimaAvaliacaoEm: obs.observadoEm,
    },
  };
}
