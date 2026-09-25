/**
 * OBS-2 — a identidade de uma acao do AGENDADOR, lida de volta.
 *
 * A rota grava `idempotency_key` na abertura e nunca mais a interpreta.
 * Um vigia precisa do caminho inverso: dada a chave, dizer de qual
 * JANELA aquela execucao era, e se ela era a base, uma continuacao ou
 * uma retentativa.
 *
 * ── TENTATIVA NAO E BUCKET ──────────────────────────────────────────
 *
 * `w5m-…`, `w5m-…:c1` e `w5m-…:r2` sao TRES chaves e UM bucket. Contar
 * chaves como buckets faria um retry parecer um tick a mais e esconderia
 * justamente a falha que o motivou. A normalizacao vem da gramatica
 * REAL (`lerIdentidadeDaOperacao`), nao de um `split(":")` — o parser ja
 * recusa sufixo desconhecido, ordem trocada, `r1` redundante e tentativa
 * acima do teto, e reescrever essas regras aqui criaria uma segunda
 * verdade que envelheceria sozinha.
 *
 * ── NADA LANCA ──────────────────────────────────────────────────────
 *
 * Esta camada le ledger HISTORICO, que contem linhas de versoes
 * anteriores do sistema e de origens que nem sao do agendador. Uma
 * excecao aqui derrubaria o vigia por causa de um dado antigo. Tudo o
 * que nao e reconhecido vira resultado tipado.
 *
 * Puro: sem banco, sem rede, sem `server-only`.
 */
import { lerIdentidadeDaOperacao } from "@/lib/agentes/ingestao/identidade-operacao";

import { alinhadoAoBucket, CADENCIA_MS } from "./fronteira-bucket";

/** O provedor que a rota dedicada carimba. Constante, nunca do corpo. */
export const PROVEDOR_AGENDADOR = "n8n";

/** O prefixo que o `Identidade Schedule` do workflow produz. */
export const PREFIXO_BUCKET = "w5m-";

/** `w5m-YYYYMMDDTHHMMZ`. Estrito de proposito. */
const FORMA_BUCKET = /^w5m-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})Z$/;

export type TipoDeTentativa = "base" | "continuacao" | "retentativa";

export interface IdentidadeDeAcaoDoScheduler {
  readonly canonicalBucketId: string;
  /** O instante nominal do bucket, em epoch ms UTC. */
  readonly bucketEm: number;
  readonly operationId: string;
  readonly tipoDeTentativa: TipoDeTentativa;
  readonly continuacao: number;
  readonly tentativa: number;
  readonly acaoId: string;
  readonly agenteId: string;
}

export type LeituraDaIdentidade =
  | { readonly ok: true; readonly identidade: IdentidadeDeAcaoDoScheduler }
  /** A chave e valida, mas nao e do agendador: `diag-*`, outro provedor. */
  | { readonly ok: false; readonly resultado: "nao_e_do_agendador"; readonly motivo: string }
  /** A chave nao casa com contrato nenhum que este modulo conheca. */
  | { readonly ok: false; readonly resultado: "invalida"; readonly motivo: string };

const naoE = (motivo: string): LeituraDaIdentidade =>
  ({ ok: false, resultado: "nao_e_do_agendador", motivo });
const invalida = (motivo: string): LeituraDaIdentidade =>
  ({ ok: false, resultado: "invalida", motivo });

/**
 * O instante nominal de um bucket canonico, ou `null`.
 *
 * `Date.parse` sozinho nao serve: ele aceita normalizacao silenciosa —
 * um "mes 13" vira janeiro do ano seguinte, e um bucket impossivel
 * passaria a existir. Cada campo e conferido contra o calendario e o
 * resultado e reconstruido; so casa quem sobrevive a ida e volta.
 *
 * O minuto tambem precisa cair na cadencia, e a checagem final delega a
 * `alinhadoAoBucket` para que exista UMA regra de fronteira no projeto.
 */
export function instanteDoBucket(canonical: string): number | null {
  if (typeof canonical !== "string") return null;
  const m = FORMA_BUCKET.exec(canonical);
  if (m === null) return null;
  const [, ano, mes, dia, hora, minuto] = m.map(Number) as unknown as number[];
  if (mes < 1 || mes > 12) return null;
  if (dia < 1 || dia > 31) return null;
  if (hora > 23 || minuto > 59) return null;

  const t = Date.UTC(ano, mes - 1, dia, hora, minuto, 0, 0);
  const d = new Date(t);
  // Ida e volta: `31 de fevereiro` volta como marco e reprova aqui.
  if (
    d.getUTCFullYear() !== ano ||
    d.getUTCMonth() !== mes - 1 ||
    d.getUTCDate() !== dia ||
    d.getUTCHours() !== hora ||
    d.getUTCMinutes() !== minuto
  ) {
    return null;
  }
  if (!alinhadoAoBucket(d.toISOString())) return null;
  return t;
}

/**
 * Le `provedor:operationId:acao:agenteId`.
 *
 * O `operationId` PODE conter `:` (`w5m-…:c1`), entao um `split` por
 * posicao da esquerda quebraria. `acao` casa `^[a-z][a-z0-9_]{2,63}$` e
 * `agenteId` e UUID — nenhum dos dois tem `:`. Por isso a leitura ancora
 * nas PONTAS e devolve o miolo como `operationId`.
 */
export function lerIdentidadeDeAcaoDoScheduler(chave: unknown): LeituraDaIdentidade {
  if (typeof chave !== "string" || chave.length === 0) return invalida("chave_ausente");
  if (chave !== chave.trim()) return invalida("espaco_nas_pontas");

  const partes = chave.split(":");
  if (partes.length < 4) return invalida("forma_inesperada");

  const provedor = partes[0];
  const agenteId = partes[partes.length - 1];
  const acaoId = partes[partes.length - 2];
  const operationId = partes.slice(1, partes.length - 2).join(":");

  if (provedor !== PROVEDOR_AGENDADOR) return naoE("outro_provedor");
  if (operationId.length === 0) return invalida("operation_id_ausente");
  if (!/^[a-z][a-z0-9_]{2,63}$/.test(acaoId)) return invalida("acao_id_invalida");
  if (agenteId.length === 0) return invalida("agente_id_ausente");

  const leitura = lerIdentidadeDaOperacao(operationId);
  if (!leitura.ok) return invalida("operation_id:" + leitura.motivo);

  const { bucket, continuacao, tentativa } = leitura.identidade;

  // `diag-38` e uma operacao VALIDA pela gramatica — ela so nao e do
  // agendador. A diferenca importa: invalida denuncia dado corrompido,
  // "nao e do agendador" e apenas uma linha que este vigia ignora.
  if (!bucket.startsWith(PREFIXO_BUCKET)) return naoE("bucket_sem_prefixo_do_agendador");

  const bucketEm = instanteDoBucket(bucket);
  if (bucketEm === null) return invalida("bucket_fora_do_formato");

  const tipoDeTentativa: TipoDeTentativa =
    continuacao > 0 ? "continuacao" : tentativa > 1 ? "retentativa" : "base";

  return {
    ok: true,
    identidade: {
      canonicalBucketId: bucket,
      bucketEm,
      operationId,
      tipoDeTentativa,
      continuacao,
      tentativa,
      acaoId,
      agenteId,
    },
  };
}

/** Os buckets nominais no intervalo `[de, ate]`, inclusivo nas duas pontas. */
export function bucketsNoIntervalo(de: number, ate: number): readonly number[] {
  if (!Number.isFinite(de) || !Number.isFinite(ate) || ate < de) return [];
  const primeiro = Math.ceil(de / CADENCIA_MS) * CADENCIA_MS;
  const saida: number[] = [];
  for (let t = primeiro; t <= ate; t += CADENCIA_MS) saida.push(t);
  return saida;
}

/** O identificador canonico de um instante de bucket. Inverso de `instanteDoBucket`. */
export function bucketDoInstante(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    PREFIXO_BUCKET +
    d.getUTCFullYear() +
    p(d.getUTCMonth() + 1) +
    p(d.getUTCDate()) +
    "T" +
    p(d.getUTCHours()) +
    p(d.getUTCMinutes()) +
    "Z"
  );
}
