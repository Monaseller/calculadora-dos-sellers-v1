/**
 * OBS-3 — o cursor esta ANDANDO?, PURO.
 *
 * ── NAO HA SERIE HISTORICA DO CURSOR ────────────────────────────────
 *
 * A tabela de continuacao guarda UMA linha, o estado de agora. Nao ha
 * snapshot por bucket, e este slice nao cria nenhum. A progressao e
 * RECONSTRUIDA do que ja existe:
 *
 *   inicio(B)  = `deslocamento_inicial` do desfecho da tentativa BASE
 *   fim(B)     = inicio(B+1), quando B+1 e o bucket nominal seguinte
 *   fim(ultimo)= `proximo_deslocamento` do cursor atual, e SO quando o
 *                `alterado_em` dele cai na janela daquele bucket
 *
 * A segunda regra existe porque o cursor e global: uma execucao manual,
 * de outro caminho ou fora da janela pode te-lo movido depois. Atribuir
 * esse movimento ao ultimo bucket inventaria progresso que ninguem
 * observou.
 *
 * ── BACKLOG SAUDAVEL NAO E TRAVAMENTO ───────────────────────────────
 *
 * `100 -> 200 -> 300` e drenagem funcionando, nao defeito. Travamento e
 * o cursor ficar no MESMO valor nao-zero apesar de entregas. E `0 -> 0`
 * e o repouso normal de quem nao tem backlog — jamais alerta.
 *
 * ── INCERTEZA NAO VIRA DIAGNOSTICO ──────────────────────────────────
 *
 * O cursor e escrito ANTES do desfecho da acao. Uma execucao pode mover
 * o cursor e morrer sem registrar terminal — e por isso um bucket
 * degradado no meio torna a transicao seguinte inatribuivel. Nesses
 * casos o resultado e `uncertain`, nunca `stuck`: acusar travamento sem
 * poder atribuir o movimento seria inventar defeito.
 *
 * Puro: sem banco, sem rede, sem `server-only`.
 */
import { CADENCIA_MS } from "./fronteira-bucket";
import {
  FOLGA_DE_FECHAMENTO_MS,
  type ClassificacaoDeBucket,
  type SaudeDoBucket,
} from "./gap";

/** Quantos buckets entregues sem avanco caracterizam travamento. */
export const BUCKETS_PARA_TRAVAMENTO = 3;

/** Pressao sustentada por este numero de buckets vira `warning`. */
export const BUCKETS_PARA_PRESSAO_WARNING = 3;
/** E por este, `alert`. */
export const BUCKETS_PARA_PRESSAO_ALERT = 12;

export interface EscopoDaAnalise {
  readonly agenteId: string;
  readonly plataforma: string;
  readonly recurso: string;
}

export interface CursorAtual {
  readonly agenteId: string;
  readonly plataforma: string;
  readonly recurso: string;
  readonly proximoDeslocamento: number;
  readonly versao: number;
  /** ISO 8601. */
  readonly alteradoEm: string;
}

export type EvidenciaDeEntrega = "limpa" | "degradada" | "ausente" | "nao_fechado";

export type OrigemDoFim = "PROXIMO_BUCKET" | "CURSOR_ATUAL" | "INDISPONIVEL";

export type Certeza = "DETERMINADA" | "INCERTA";

export interface TransicaoDoCursor {
  readonly canonicalBucketId: string;
  readonly bucketEm: number;
  readonly inicio: number | null;
  readonly fim: number | null;
  readonly origemDoFim: OrigemDoFim;
  readonly certeza: Certeza;
  readonly evidencia: EvidenciaDeEntrega;
  readonly motivo: string;
}

export type EstadoDoCursor =
  | "idle"
  | "progress"
  | "complete"
  | "stuck"
  | "regression"
  | "uncertain";

export type SeveridadeDePressao = "nenhuma" | "warning" | "alert";

export interface AnaliseDoCursor {
  readonly estado: EstadoDoCursor;
  readonly motivo: string;
  readonly transicoes: readonly TransicaoDoCursor[];
  readonly stuckStreak: number;
  readonly pressureStreak: number;
  readonly severidadeDePressao: SeveridadeDePressao;
  readonly budgetPressure: boolean;
  readonly budgetStreak: number;
  readonly latestKnownOffset: number | null;
  readonly diagnosticos: readonly string[];
}

/** Que tipo de evidencia de entrega uma classificacao do OBS-2 fornece. */
export function evidenciaDaClassificacao(c: ClassificacaoDeBucket): EvidenciaDeEntrega {
  if (c === "BUCKET_SUCCEEDED") return "limpa";
  // RECOVERED entregou: houve pelo menos uma travessia bem-sucedida, e o
  // cursor teve chance de se mover. Continua degradado para o OBS-2 — as
  // duas coisas nao se anulam.
  if (c === "BUCKET_RECOVERED") return "degradada";
  if (c === "BUCKET_OPEN") return "nao_fechado";
  return "ausente";
}

/** O offset em que a tentativa BASE do bucket comecou, ou `null`. */
function inicioDoBucket(b: SaudeDoBucket): number | null {
  // A base e quem define o comeco da janela do bucket: uma continuacao
  // ja parte do cursor que a base deixou, e usar `min` sobre todas as
  // tentativas confundiria as duas.
  const base = b.tentativas.find((t) => t.tipo === "base");
  const v = base?.deslocamentoInicial;
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

function temPressao(b: SaudeDoBucket): boolean {
  return b.tentativas.some(
    (t) => t.continuacaoPendente === true || t.truncado === true || t.limiteAtingido === true
  );
}
function temPressaoDeOrcamento(b: SaudeDoBucket): boolean {
  return b.tentativas.some((t) => t.orcamentoEsgotado === true);
}

/**
 * Reconstroi as transicoes e diz o que o cursor esta fazendo.
 *
 * `buckets` vem do OBS-2, no mesmo escopo. `cursorAtual` pode faltar —
 * nesse caso a ultima transicao fica indisponivel em vez de inventada.
 */
export function analisarProgressoDoCursor(entrada: {
  readonly escopo: EscopoDaAnalise;
  readonly buckets: readonly SaudeDoBucket[];
  readonly cursorAtual?: CursorAtual | null;
}): AnaliseDoCursor {
  const diagnosticos: string[] = [];
  const cursor = entrada.cursorAtual ?? null;

  // ── Escopo: nunca cruzar agente, plataforma ou recurso ────────────
  let cursorUtil = cursor;
  if (cursor !== null) {
    const mesmo =
      cursor.agenteId === entrada.escopo.agenteId &&
      cursor.plataforma === entrada.escopo.plataforma &&
      cursor.recurso === entrada.escopo.recurso;
    if (!mesmo) {
      diagnosticos.push("cursor_de_outro_escopo");
      cursorUtil = null;
    }
  }

  const ordenados = [...entrada.buckets].sort((a, b) => a.bucketEm - b.bucketEm);
  const vistos = new Set<string>();
  for (const b of ordenados) {
    if (vistos.has(b.canonicalBucketId)) diagnosticos.push("bucket_duplicado");
    vistos.add(b.canonicalBucketId);
  }

  const fechados = ordenados.filter((b) => b.classificacao !== "BUCKET_OPEN");
  const transicoes: TransicaoDoCursor[] = [];

  for (let i = 0; i < fechados.length; i++) {
    const b = fechados[i];
    const evidencia = evidenciaDaClassificacao(b.classificacao);
    const inicio = inicioDoBucket(b);
    const seguinte = fechados[i + 1] ?? null;

    let fim: number | null = null;
    let origemDoFim: OrigemDoFim = "INDISPONIVEL";
    let certeza: Certeza = "INCERTA";
    let motivo = "";

    if (seguinte !== null) {
      const adjacente = seguinte.bucketEm - b.bucketEm === CADENCIA_MS;
      const fimCandidato = inicioDoBucket(seguinte);
      if (!adjacente) {
        motivo = "bucket seguinte nao e o nominal imediato";
      } else if (fimCandidato === null) {
        motivo = "o bucket seguinte nao expos deslocamento inicial";
      } else {
        fim = fimCandidato;
        origemDoFim = "PROXIMO_BUCKET";
        // O cursor e escrito ANTES do desfecho: um bucket sem entrega
        // pode te-lo movido e nao ter registrado terminal. Atribuir o
        // movimento a ele seria inventar causa.
        certeza = evidencia === "ausente" ? "INCERTA" : "DETERMINADA";
        motivo = certeza === "DETERMINADA" ? "fim = inicio do bucket seguinte" : "bucket sem entrega no intervalo";
      }
    } else if (cursorUtil !== null) {
      const t = Date.parse(cursorUtil.alteradoEm);
      const dentro =
        Number.isFinite(t) && t >= b.bucketEm && t <= b.bucketEm + FOLGA_DE_FECHAMENTO_MS;
      if (dentro) {
        fim = cursorUtil.proximoDeslocamento;
        origemDoFim = "CURSOR_ATUAL";
        certeza = evidencia === "ausente" ? "INCERTA" : "DETERMINADA";
        motivo = "fim = cursor atual, alterado dentro da janela deste bucket";
      } else {
        motivo = "cursor atual foi alterado fora da janela deste bucket";
        diagnosticos.push("cursor_alterado_fora_da_janela");
      }
    } else {
      motivo = "sem cursor atual e sem bucket seguinte";
    }

    if (inicio === null && evidencia !== "ausente") diagnosticos.push("deslocamento_inicial_ausente");

    transicoes.push({
      canonicalBucketId: b.canonicalBucketId,
      bucketEm: b.bucketEm,
      inicio,
      fim,
      origemDoFim,
      certeza: inicio === null ? "INCERTA" : certeza,
      evidencia,
      motivo,
    });
  }

  // ── Pressao: independente de travamento ───────────────────────────
  let pressureStreak = 0;
  for (let i = fechados.length - 1; i >= 0; i--) {
    if (!temPressao(fechados[i])) break;
    pressureStreak++;
  }
  let budgetStreak = 0;
  for (let i = fechados.length - 1; i >= 0; i--) {
    if (!temPressaoDeOrcamento(fechados[i])) break;
    budgetStreak++;
  }
  const severidadeDePressao: SeveridadeDePressao =
    pressureStreak >= BUCKETS_PARA_PRESSAO_ALERT
      ? "alert"
      : pressureStreak >= BUCKETS_PARA_PRESSAO_WARNING
        ? "warning"
        : "nenhuma";

  // ── O estado, lido das transicoes mais recentes ───────────────────
  const uteis = transicoes.filter((t) => t.inicio !== null && t.fim !== null);
  const latestKnownOffset =
    cursorUtil !== null
      ? cursorUtil.proximoDeslocamento
      : uteis.length > 0
        ? uteis[uteis.length - 1].fim
        : null;

  const base = {
    transicoes,
    stuckStreak: 0,
    pressureStreak,
    severidadeDePressao,
    budgetPressure: budgetStreak > 0,
    budgetStreak,
    latestKnownOffset,
    diagnosticos,
  };

  if (uteis.length === 0) {
    return { ...base, estado: "uncertain", motivo: "nenhuma transicao pode ser reconstruida" };
  }

  // Regressao para valor nao-zero menor: nao ha caminho legitimo. O unico
  // recuo que o codigo faz e para ZERO — `reiniciarContinuacao` ao fim da
  // lista e `reapontarContinuacao` quando a conta muda.
  for (const t of uteis) {
    if (t.certeza === "DETERMINADA" && t.fim! < t.inicio! && t.fim! !== 0) {
      return {
        ...base,
        estado: "regression",
        motivo: `o cursor recuou de ${t.inicio} para ${t.fim} em ${t.canonicalBucketId}`,
      };
    }
  }

  const ultima = uteis[uteis.length - 1];
  if (ultima.certeza === "INCERTA") {
    return { ...base, estado: "uncertain", motivo: "a transicao mais recente nao e atribuivel" };
  }

  // ── Travamento ────────────────────────────────────────────────────
  //
  // Exige entrega nos tres, transicoes determinadas, mesmo offset > 0 e
  // nenhuma conclusao de travessia no meio. Sem qualquer uma dessas, o
  // que ha e incerteza ou backlog — nao defeito.
  let stuckStreak = 0;
  for (let i = uteis.length - 1; i >= 0; i--) {
    const t = uteis[i];
    const parado = t.inicio === t.fim && t.inicio! > 0;
    const entregou = t.evidencia === "limpa" || t.evidencia === "degradada";
    if (!parado || !entregou || t.certeza !== "DETERMINADA") break;
    stuckStreak++;
  }
  if (stuckStreak >= BUCKETS_PARA_TRAVAMENTO) {
    return {
      ...base,
      estado: "stuck",
      stuckStreak,
      motivo: `${stuckStreak} buckets entregues sem mover o cursor de ${ultima.inicio}`,
    };
  }

  if (ultima.fim === 0 && ultima.inicio! > 0) {
    return { ...base, stuckStreak, estado: "complete", motivo: "a travessia terminou e o cursor voltou ao inicio" };
  }
  if (ultima.inicio === 0 && ultima.fim === 0) {
    return { ...base, stuckStreak, estado: "idle", motivo: "sem backlog: a travessia comeca e termina no inicio" };
  }
  if (ultima.fim! > ultima.inicio!) {
    return { ...base, stuckStreak, estado: "progress", motivo: `o cursor avancou de ${ultima.inicio} para ${ultima.fim}` };
  }
  // Entregou e nao moveu o cursor. Nao e incerteza — e observacao certa
  // de um CANDIDATO a travamento, que so vira diagnostico ao repetir. O
  // `stuckStreak` carrega quantos ja se acumularam.
  return {
    ...base,
    stuckStreak,
    estado: "uncertain",
    motivo:
      "entregou sem mover o cursor de " + ultima.inicio +
      " — candidato a travamento, " + stuckStreak + " de " + BUCKETS_PARA_TRAVAMENTO,
  };
}
