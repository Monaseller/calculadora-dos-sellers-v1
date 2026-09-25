/**
 * OBS-2 — a saude dos buckets do agendador, PURA.
 *
 * Recebe a intencao declarada (OBS-1), o instante atual e as linhas do
 * ledger que o futuro monitor tiver carregado. Devolve, por bucket
 * fechado, o que aconteceu. Nao consulta banco, nao escreve alerta, nao
 * executa nada.
 *
 * ── AUSENCIA NAO E FALHA, E FALHA NAO E AUSENCIA ────────────────────
 *
 * Reduzir tudo a "bucket sem sucesso" apagaria a diferenca entre tres
 * causas com respostas operacionais opostas: o agendador nao disparou
 * (`MISSING` — problema no n8n ou no cron), disparou e nao terminou
 * (`INCOMPLETE` — timeout, processo morto), terminou mal (`FAILED` —
 * problema do CDS ou do provider). Quem for acordado as tres da manha
 * precisa saber qual das tres.
 *
 * ── SUCESSO COM BACKLOG PENDENTE CONTINUA SUCESSO ───────────────────
 *
 * `continuacao_pendente = true` NAO torna o bucket incompleto. O cursor
 * e duravel: o que sobrou e retomado pela proxima travessia, de onde
 * parou. Chamar isso de incompleto faria backlog saudavel virar alerta,
 * que e exatamente o erro que o I4P4 mandou evitar. A pendencia viaja no
 * resumo para quem cuida de PRESSAO de backlog (OBS-3), nao aqui.
 *
 * Puro: sem banco, sem rede, sem `server-only`.
 */
import { CADENCIA_MS } from "./fronteira-bucket";
import {
  bucketDoInstante,
  bucketsNoIntervalo,
  lerIdentidadeDeAcaoDoScheduler,
  type TipoDeTentativa,
} from "./scheduler-bucket";

/**
 * A folga ate um bucket poder ser cobrado, em ms.
 *
 * Derivada no I4P4 dos contratos reais: a admissao tolera 120 s de
 * atraso e o `executionTimeout` do workflow e 120 s, entao o pior caso
 * legitimo ate o terminal e 240 s. Os 300 s alinham o julgamento a
 * fronteira do bucket seguinte e absorvem desvio de relogio entre n8n,
 * Vercel e Postgres, que nao foi medido.
 */
export const FOLGA_DE_FECHAMENTO_MS = 300_000;

/**
 * Quantos buckets fechados o detector examina.
 *
 * O maior limiar e `3+` consecutivos. Ver 3 prova o `3`; provar que a
 * sequencia COMECOU dentro da janela exige um quarto bucket saudavel
 * antes dela. Os dois restantes sao margem para que um bucket ainda
 * ABERTO na borda nao consuma a evidencia da fronteira. Seis buckets sao
 * trinta minutos e seis linhas — o detector responde o estado ATUAL, nao
 * faz historiografia.
 */
export const JANELA_DE_BUSCA_EM_BUCKETS = 6;

/** Os statuses terminais que contam como travessia entregue. */
const SUCESSO: ReadonlySet<string> = new Set(["sucesso", "parcial"]);

export interface LinhaDoLedger {
  readonly userId: string;
  readonly requestId: string;
  readonly fase: string;
  readonly status: string;
  readonly idempotencyKey: string | null;
  readonly criadoEm: string;
  readonly codigoDesfecho?: string | null;
  // As metricas abaixo JA existem em `entrada_resumo` do desfecho; elas
  // viajam aqui para que o OBS-3 nao precise reabrir o ledger.
  readonly continuacaoPendente?: boolean | null;
  readonly deslocamentoInicial?: number | null;
  readonly truncado?: boolean | null;
  readonly limiteAtingido?: boolean | null;
  readonly orcamentoEsgotado?: boolean | null;
}

export type EstadoEsperado =
  | { readonly estado: "configurado_ativo"; readonly esperadoDesde: string }
  | { readonly estado: "configurado_inativo" }
  | { readonly estado: "configuracao_ausente" }
  | { readonly estado: "falhou_leitura" };

export interface ResumoDaTentativa {
  readonly tipo: TipoDeTentativa;
  readonly operationId: string;
  readonly status: string | null;
  readonly codigoDesfecho: string | null;
  readonly continuacaoPendente: boolean | null;
  readonly deslocamentoInicial: number | null;
  readonly truncado: boolean | null;
  readonly limiteAtingido: boolean | null;
  readonly orcamentoEsgotado: boolean | null;
  readonly temTerminal: boolean;
}

export type ClassificacaoDeBucket =
  | "BUCKET_OPEN"
  | "BUCKET_MISSING"
  | "BUCKET_INCOMPLETE"
  | "BUCKET_FAILED"
  | "BUCKET_SUCCEEDED"
  | "BUCKET_RECOVERED";

export interface SaudeDoBucket {
  readonly canonicalBucketId: string;
  readonly bucketEm: number;
  readonly classificacao: ClassificacaoDeBucket;
  readonly motivo: string;
  readonly tentativas: readonly ResumoDaTentativa[];
}

export type DiagnosticoDoLedger =
  | "desfecho_orfao"
  | "abertura_duplicada"
  | "desfecho_duplicado"
  | "chave_invalida";

export interface AchadoDoLedger {
  readonly diagnostico: DiagnosticoDoLedger;
  readonly detalhe: string;
}

export type ResultadoDaDeteccao =
  | { readonly resultado: "MONITOR_CONFIGURATION_MISSING" }
  | { readonly resultado: "MONITOR_NOT_EXPECTED" }
  | { readonly resultado: "MONITOR_CONFIG_UNREADABLE" }
  | {
      readonly resultado: "AVALIADO";
      readonly buckets: readonly SaudeDoBucket[];
      readonly achados: readonly AchadoDoLedger[];
    };

export interface Sequencias {
  readonly consecutiveMissing: number;
  readonly consecutiveIncomplete: number;
  readonly consecutiveFailed: number;
  readonly consecutiveAnyDegraded: number;
  /** A sequencia preenche toda a janela — o comeco dela nao foi visto. */
  readonly truncadaPelaJanela: boolean;
}

export type Severidade = "nenhuma" | "warning" | "alert" | "critical";

// ─── Junção das duas fases ────────────────────────────────────────────

interface Execucao {
  readonly userId: string;
  readonly requestId: string;
  readonly abertura: LinhaDoLedger;
  readonly terminal: LinhaDoLedger | null;
}

/**
 * Associa abertura e desfecho por `(user_id, request_id)`.
 *
 * NAO por `request_id` sozinho: o banco garante unicidade por
 * `(user_id, request_id)` DENTRO de cada fase, e nada impede dois donos
 * de terem o mesmo `request_id`. Juntar so pelo request faria o desfecho
 * de um tenant fechar a abertura de outro — um heartbeat falso, e do
 * tipo mais dificil de enxergar depois.
 */
function juntarFases(linhas: readonly LinhaDoLedger[]): {
  readonly execucoes: readonly Execucao[];
  readonly achados: readonly AchadoDoLedger[];
} {
  const aberturas = new Map<string, LinhaDoLedger>();
  const terminais = new Map<string, LinhaDoLedger>();
  const achados: AchadoDoLedger[] = [];
  // `JSON.stringify` do par, e nao concatenacao com separador: com um
  // separador comum, ("a b","c") e ("a","b c") dariam a MESMA chave e o
  // join cruzaria execucoes de tenants diferentes — exatamente o que ele
  // existe para impedir. E evita byte de controle no fonte.
  const chave = (l: LinhaDoLedger) => JSON.stringify([l.userId, l.requestId]);

  for (const l of linhas) {
    if (l.fase === "abertura") {
      if (aberturas.has(chave(l))) {
        achados.push({ diagnostico: "abertura_duplicada", detalhe: l.requestId });
        continue;
      }
      aberturas.set(chave(l), l);
      continue;
    }
    if (l.fase === "desfecho") {
      if (terminais.has(chave(l))) {
        achados.push({ diagnostico: "desfecho_duplicado", detalhe: l.requestId });
        continue;
      }
      terminais.set(chave(l), l);
    }
  }

  const execucoes: Execucao[] = [];
  for (const [k, abertura] of aberturas) {
    execucoes.push({
      userId: abertura.userId,
      requestId: abertura.requestId,
      abertura,
      terminal: terminais.get(k) ?? null,
    });
  }
  // Desfecho sem abertura NAO vira execucao: um terminal orfao nao prova
  // que houve travessia, e conta-lo como sucesso seria heartbeat falso.
  for (const k of terminais.keys()) {
    if (!aberturas.has(k)) {
      achados.push({ diagnostico: "desfecho_orfao", detalhe: terminais.get(k)!.requestId });
    }
  }
  return { execucoes, achados };
}

// ─── Classificação ────────────────────────────────────────────────────

function classificarTentativas(
  canonicalBucketId: string,
  bucketEm: number,
  tentativas: readonly ResumoDaTentativa[]
): SaudeDoBucket {
  const comTerminal = tentativas.filter((t) => t.temTerminal);
  const semTerminal = tentativas.filter((t) => !t.temTerminal);

  if (comTerminal.length === 0) {
    return {
      canonicalBucketId,
      bucketEm,
      classificacao: "BUCKET_INCOMPLETE",
      motivo: "abertura sem desfecho apos a folga",
      tentativas,
    };
  }

  const bemSucedidas = comTerminal.filter((t) => t.status !== null && SUCESSO.has(t.status));
  const malSucedidas = comTerminal.filter((t) => t.status === null || !SUCESSO.has(t.status));

  if (bemSucedidas.length === 0) {
    return {
      canonicalBucketId,
      bucketEm,
      classificacao: "BUCKET_FAILED",
      motivo: "nenhuma tentativa entregou: " + malSucedidas.map((t) => t.status).join(","),
      tentativas,
    };
  }

  // Mistura: a janela foi entregue, mas nao pelo caminho feliz. Isso e
  // uma diferenca operacional real — um bucket que precisou de retry, ou
  // cuja continuacao falhou, merece ser visto sem virar alerta de falha.
  if (malSucedidas.length > 0 || semTerminal.length > 0) {
    return {
      canonicalBucketId,
      bucketEm,
      classificacao: "BUCKET_RECOVERED",
      motivo:
        "entregue com " +
        malSucedidas.length +
        " tentativa(s) malsucedida(s) e " +
        semTerminal.length +
        " sem terminal",
      tentativas,
    };
  }

  return {
    canonicalBucketId,
    bucketEm,
    classificacao: "BUCKET_SUCCEEDED",
    motivo: "todas as tentativas entregaram",
    tentativas,
  };
}

// ─── O detector ───────────────────────────────────────────────────────

/**
 * A saude dos buckets fechados, do mais antigo para o mais recente.
 *
 * `agenteId` filtra o escopo: buckets de outro agente nao entram, mesmo
 * que estejam nas linhas recebidas.
 */
export function detectarSaudeDosBuckets(entrada: {
  readonly configuracao: EstadoEsperado;
  readonly agora: number;
  readonly agenteId: string;
  readonly linhas: readonly LinhaDoLedger[];
  readonly janelaEmBuckets?: number;
}): ResultadoDaDeteccao {
  const { configuracao, agora, agenteId } = entrada;

  if (configuracao.estado === "configuracao_ausente") {
    return { resultado: "MONITOR_CONFIGURATION_MISSING" };
  }
  if (configuracao.estado === "falhou_leitura") {
    return { resultado: "MONITOR_CONFIG_UNREADABLE" };
  }
  if (configuracao.estado === "configurado_inativo") {
    return { resultado: "MONITOR_NOT_EXPECTED" };
  }

  const desde = Date.parse(configuracao.esperadoDesde);
  if (!Number.isFinite(desde)) return { resultado: "MONITOR_CONFIG_UNREADABLE" };

  const janela = entrada.janelaEmBuckets ?? JANELA_DE_BUSCA_EM_BUCKETS;
  // So e COBRAVEL o bucket cujo prazo ja venceu; a janela de busca conta
  // a partir dele, para tras.
  const ultimoFechado = Math.floor((agora - FOLGA_DE_FECHAMENTO_MS) / CADENCIA_MS) * CADENCIA_MS;
  const inicioDaJanela = Math.max(desde, ultimoFechado - (janela - 1) * CADENCIA_MS);
  // O ultimo bucket NOMINAL entra tambem, mesmo ainda dentro da folga:
  // quem consome precisa distinguir "ainda pode acontecer" de "nao
  // aconteceu", e omitir o bucket aberto faria os dois parecerem iguais.
  const ultimoNominal = Math.floor(agora / CADENCIA_MS) * CADENCIA_MS;
  const esperados = bucketsNoIntervalo(inicioDaJanela, Math.max(ultimoFechado, ultimoNominal));

  const { execucoes, achados } = juntarFases(entrada.linhas);
  const achadosTodos: AchadoDoLedger[] = [...achados];

  // Agrupa por (bucket canonico, agente). O tenant ja esta implicito: a
  // juncao so uniu fases do mesmo `user_id`.
  const porBucket = new Map<string, ResumoDaTentativa[]>();
  for (const e of execucoes) {
    const leitura = lerIdentidadeDeAcaoDoScheduler(e.abertura.idempotencyKey);
    if (!leitura.ok) {
      if (leitura.resultado === "invalida") {
        achadosTodos.push({ diagnostico: "chave_invalida", detalhe: leitura.motivo });
      }
      continue; // `diag-*` e outros provedores simplesmente nao contam.
    }
    if (leitura.identidade.agenteId !== agenteId) continue;

    const t = e.terminal;
    const resumo: ResumoDaTentativa = {
      tipo: leitura.identidade.tipoDeTentativa,
      operationId: leitura.identidade.operationId,
      status: t ? t.status : null,
      codigoDesfecho: t ? t.codigoDesfecho ?? null : null,
      continuacaoPendente: t ? t.continuacaoPendente ?? null : null,
      deslocamentoInicial: t ? t.deslocamentoInicial ?? null : null,
      truncado: t ? t.truncado ?? null : null,
      limiteAtingido: t ? t.limiteAtingido ?? null : null,
      orcamentoEsgotado: t ? t.orcamentoEsgotado ?? null : null,
      temTerminal: t !== null,
    };
    const lista = porBucket.get(leitura.identidade.canonicalBucketId);
    if (lista) lista.push(resumo);
    else porBucket.set(leitura.identidade.canonicalBucketId, [resumo]);
  }

  const buckets: SaudeDoBucket[] = [];
  for (const bucketEm of esperados) {
    const id = bucketDoInstante(bucketEm);
    if (agora < bucketEm + FOLGA_DE_FECHAMENTO_MS) {
      buckets.push({
        canonicalBucketId: id,
        bucketEm,
        classificacao: "BUCKET_OPEN",
        motivo: "ainda dentro da folga de fechamento",
        tentativas: porBucket.get(id) ?? [],
      });
      continue;
    }
    const tentativas = porBucket.get(id);
    if (tentativas === undefined || tentativas.length === 0) {
      buckets.push({
        canonicalBucketId: id,
        bucketEm,
        classificacao: "BUCKET_MISSING",
        motivo: "nenhuma abertura apos o prazo",
        tentativas: [],
      });
      continue;
    }
    buckets.push(classificarTentativas(id, bucketEm, tentativas));
  }

  return { resultado: "AVALIADO", buckets, achados: achadosTodos };
}

// ─── Sequências ───────────────────────────────────────────────────────

const DEGRADADO: ReadonlySet<ClassificacaoDeBucket> = new Set([
  "BUCKET_MISSING",
  "BUCKET_INCOMPLETE",
  "BUCKET_FAILED",
]);

/**
 * Conta sequencias a partir do bucket fechado MAIS RECENTE, para tras.
 *
 * A contagem e por bucket canonico distinto — nunca por linha, requestId
 * ou tentativa. `BUCKET_OPEN` nao interrompe nem conta: ele ainda nao
 * teve chance de acontecer.
 */
export function calcularSequenciaDeBucketsDegradados(
  buckets: readonly SaudeDoBucket[]
): Sequencias {
  const fechados = buckets
    .filter((b) => b.classificacao !== "BUCKET_OPEN")
    .sort((a, b) => b.bucketEm - a.bucketEm);

  const contar = (aceita: (c: ClassificacaoDeBucket) => boolean): number => {
    let n = 0;
    for (const b of fechados) {
      if (!aceita(b.classificacao)) break;
      n++;
    }
    return n;
  };

  const degradados = contar((c) => DEGRADADO.has(c));
  return {
    consecutiveMissing: contar((c) => c === "BUCKET_MISSING"),
    consecutiveIncomplete: contar((c) => c === "BUCKET_INCOMPLETE"),
    consecutiveFailed: contar((c) => c === "BUCKET_FAILED"),
    consecutiveAnyDegraded: degradados,
    // A sequencia comeu a janela inteira: o inicio dela ficou fora do que
    // foi observado, e dizer "exatamente N" seria afirmar o que nao se viu.
    truncadaPelaJanela: degradados > 0 && degradados === fechados.length,
  };
}

/**
 * Recomendacao de severidade. NAO persiste nem notifica — quem decide o
 * ciclo de vida do alerta e o OBS-4.
 *
 * `MISSING` segue a escala do I4P4: um bucket perdido nao tem
 * consequencia de dado sob a garantia eventual, entao nao pode acordar
 * ninguem. `INCOMPLETE` e `FAILED` NAO herdam essa escala — os dois
 * significam que o CDS ou o provider responderam mal, e um unico caso ja
 * merece ser visto; o que os diferencia e que `INCOMPLETE` pode ser
 * processo morto no meio da escrita, o que e mais grave mais cedo.
 */
export function recomendarSeveridade(s: Sequencias): {
  readonly missing: Severidade;
  readonly incomplete: Severidade;
  readonly failed: Severidade;
} {
  const escalaAusencia = (n: number): Severidade =>
    n >= 3 ? "critical" : n === 2 ? "alert" : n === 1 ? "warning" : "nenhuma";
  const escalaFalha = (n: number): Severidade =>
    n >= 3 ? "critical" : n >= 1 ? "alert" : "nenhuma";
  const escalaIncompleta = (n: number): Severidade =>
    n >= 2 ? "critical" : n >= 1 ? "alert" : "nenhuma";

  return {
    missing: escalaAusencia(s.consecutiveMissing),
    incomplete: escalaIncompleta(s.consecutiveIncomplete),
    failed: escalaFalha(s.consecutiveFailed),
  };
}
