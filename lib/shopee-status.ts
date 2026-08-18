/**
 * lib/shopee-status.ts — SYNC DE STATUS Shopee, dirigido pelo BANCO (2026-08-18).
 *
 * ── POR QUE ESTE MODULO EXISTE ───────────────────────────────────────────────
 * A etapa 1.6 de `lib/sync-shopee.ts` corrige status de pedido existente usando
 * o subproduto do `get_order_list`. Medido em producao no teste de 18/08: a
 * listagem de UM dia por `update_time` consumiu 54,3 s em 30 paginas e NAO
 * terminou — a etapa 1.6 nunca foi alcancada. O gargalo nao e a correcao de
 * status; e a varredura da qual ela depende.
 *
 * E ela nao precisa dessa varredura. `decidirAtualizacaoDeStatus` DESCARTA tudo
 * que nao esta no banco (`if (!noBanco.has(...)) continue`). A pergunta util e a
 * inversa: "dado um pedido que ja conheco, qual o status dele agora?" —
 * respondida por `get_order_detail`, que aceita 50 order_sn por chamada e roda
 * com 10 chamadas concorrentes.
 *
 * ── A GARANTIA DE COBERTURA ──────────────────────────────────────────────────
 * Espaco de buckets FIXO (B=1024) + janela contigua escolhida pelo RELOGIO.
 *
 *   bucket(pedido) = f(order_id)          determinístico e IMUTAVEL
 *   janela(tick)   = K buckets contiguos  a partir de (tick mod (B/K)) * K
 *
 * Como K divide B, ao longo de B/K ticks consecutivos os inicios percorrem
 * 0, K, 2K, ..., B-K — cada bucket em EXATAMENTE um ciclo. Logo todo pedido
 * nao-terminal e consultado ao menos uma vez a cada B/K execucoes.
 *
 * NAO HA `LIMIT` E NAO HA `OFFSET`. Essa e a diferenca que sustenta a prova:
 *   - `LIMIT` dentro do bucket reintroduz starvation silenciosa — os mesmos N
 *     voltariam sempre e o excedente nunca;
 *   - `OFFSET` sobre conjunto mutavel PULA linhas (pedidos saem do conjunto
 *     enquanto se pagina). Este projeto ja foi mordido por isso.
 * O tamanho do bucket nao aparece em nenhum passo da prova: afeta so a DURACAO,
 * governada por K e protegida por TETO_POR_EXECUCAO, que ABORTA em vez de
 * truncar. Execucao que nao cabe vira erro visivel, nunca cobertura parcial
 * disfarcada de sucesso.
 *
 * ── POR QUE B E FIXO E K E O BOTAO ───────────────────────────────────────────
 * `md5(order_id) % B` reembaralha TODAS as atribuicoes quando B muda. Se B
 * fosse dimensionado dinamicamente (a partir de um COUNT vivo, que encolhe a
 * cada execucao), um pedido poderia trocar de bucket a cada ciclo e nunca ser
 * alcancado. Por isso B e CONGELADO e a carga se ajusta por K, que muda a
 * largura da janela sem mexer em quem pertence a que bucket.
 *
 * ── O QUE ESTE MODULO PODE ESCREVER ──────────────────────────────────────────
 * `status` e `status_shopee_raw`. Mais nada. Nao ha upsert, nao ha objeto
 * completo, nao ha `montarLinhasDoPedido`, nao ha rateio. A protecao do
 * snapshot financeiro v2 aqui nao e uma verificacao — e impossibilidade
 * estrutural: os campos nao existem na instrucao.
 */
import {
  DETAIL_BATCH,
  DETAIL_CONCURRENCY,
  DETAIL_FIELDS,
} from "@/lib/sync-shopee";
import {
  decidirAtualizacaoDeStatus,
  agruparMudancasDeStatus,
  LOTE_UPDATE_STATUS,
  type GrupoDeStatus,
} from "@/lib/shopee-financeiro";

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Numero de buckets. CONGELADO — mudar este valor reembaralha a atribuicao de
 * todos os pedidos e invalida a garantia de cobertura durante a transicao.
 * Potencia de 2 para que todo K da escada (1,2,4,...,1024) divida B.
 */
export const BUCKETS = 1024;

/** Duracao de um ciclo. 1 hora: com K=32 o sweep completo leva 32 h. */
export const INTERVALO_CICLO_MS = 3_600_000;

/**
 * Status que ainda podem mudar. COMPLETED e CANCELLED sao terminais e ficam de
 * fora. `status_shopee_raw IS NULL` (102.014 pedidos legados, todos sem
 * `data_pagamento`) e divida tecnica SEPARADA e nao entra nesta fila.
 */
export const STATUS_NAO_TERMINAIS: readonly string[] = [
  "UNPAID", "READY_TO_SHIP", "PROCESSED", "RETRY_SHIP",
  "SHIPPED", "TO_CONFIRM_RECEIVE", "IN_CANCEL", "TO_RETURN",
];

/** Fronteira entre Faixa A (recentes) e Faixa B (rotacao), em dias. */
export const IDADE_FAIXA_A_DIAS = 2;

/**
 * Teto de pedidos por execucao. Default conservador: com 8 ondas a 5 s/onda
 * (pior latencia hipotetica) sao 40 s, dentro do maxDuration de 60. Ao ser
 * excedido a execucao ABORTA antes de qualquer chamada a Shopee.
 */
export const TETO_POR_EXECUCAO_PADRAO = 4000;

/** Reexportado para quem monta a rota nao precisar importar de dois lugares. */
export { DETAIL_BATCH, DETAIL_CONCURRENCY, DETAIL_FIELDS, LOTE_UPDATE_STATUS };

// ─────────────────────────────────────────────────────────────────────────────
// BUCKET — expressao unica, sem copia divergente
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A AUTORIDADE do bucket e esta expressao SQL: a selecao e um `WHERE` sobre
 * dezenas de milhares de linhas e nao pode ser calculada em memoria.
 *
 * `md5` de proposito — funcao padrao e estavel entre versoes do Postgres.
 * `hashtext` NAO serve: e interna e sem garantia de estabilidade.
 *
 * `get_byte` devolve 0..255, sempre nao-negativo. Isso evita a armadilha do
 * idioma comum `abs(('x'||md5(id))::bit(32)::int)`, que ESTOURA quando os 8
 * primeiros hex sao exatamente 80000000: `abs(-2147483648)` lanca
 * "integer out of range". Raro (~1 em 4 bilhoes por pedido), mas erro duro.
 */
export const SQL_BUCKET =
  `((get_byte(decode(md5(order_id), 'hex'), 0) * 256` +
  ` + get_byte(decode(md5(order_id), 'hex'), 1)) % ${BUCKETS})`;

/**
 * Espelho em TypeScript da expressao acima — os dois primeiros bytes do md5,
 * big-endian, modulo BUCKETS. Existe para TESTE e diagnostico; a producao usa
 * `SQL_BUCKET`. Equivalencia entre os dois e verificavel contra o banco com uma
 * consulta somente-leitura (ver cabecalho da suite).
 */
export function bucketDoPedido(orderId: string): number {
  // require dinamico: mantem o modulo utilizavel em runtime Edge, onde
  // `node:crypto` nao existe — a producao nunca chama esta funcao.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  const hex = createHash("md5").update(orderId).digest("hex");
  const b0 = parseInt(hex.slice(0, 2), 16);
  const b1 = parseInt(hex.slice(2, 4), 16);
  return (b0 * 256 + b1) % BUCKETS;
}

// ─────────────────────────────────────────────────────────────────────────────
// RELOGIO — funcoes puras, sem Date.now() interno
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Indice do ciclo. `agoraMs` e PARAMETRO, nunca `Date.now()` interno — mesmo
 * padrao de `agoraEmSegundos` em lib/autenticacao.ts. Sem isso o teste de
 * cobertura dependeria do relogio da maquina.
 */
export function tickDoCiclo(agoraMs: number): number {
  if (!Number.isFinite(agoraMs)) throw new Error(`tickDoCiclo: agoraMs invalido: ${agoraMs}`);
  return Math.floor(agoraMs / INTERVALO_CICLO_MS);
}

/**
 * Os K buckets contiguos deste ciclo.
 *
 * `K` precisa dividir `B`. Nao e capricho: e o que torna a prova de cobertura
 * uma linha. Com K | B os inicios percorrem 0, K, 2K, ..., B-K e cada bucket
 * cai em EXATAMENTE um ciclo do sweep. Com K arbitrario os inicios andariam em
 * multiplos de gcd(K,B), gerando sobreposicao e periodo maior — ainda cobriria,
 * mas a garantia deixaria de ser obvia, e garantia que precisa de demonstracao
 * longa e garantia que ninguem confere.
 */
export function bucketsDoCiclo(tick: number, K: number, B: number = BUCKETS): number[] {
  if (!Number.isInteger(K) || K < 1) throw new Error(`bucketsDoCiclo: K deve ser inteiro >= 1, recebido ${K}`);
  if (!Number.isInteger(B) || B < 1) throw new Error(`bucketsDoCiclo: B deve ser inteiro >= 1, recebido ${B}`);
  if (K > B) throw new Error(`bucketsDoCiclo: K (${K}) nao pode ser maior que B (${B})`);
  if (B % K !== 0) throw new Error(`bucketsDoCiclo: K deve dividir B — K=${K}, B=${B}`);
  if (!Number.isInteger(tick)) throw new Error(`bucketsDoCiclo: tick deve ser inteiro, recebido ${tick}`);
  const ciclos = B / K;
  // `((tick % ciclos) + ciclos) % ciclos` mantem o resultado nao-negativo para
  // tick negativo (datas anteriores a 1970 em teste).
  const inicio = (((tick % ciclos) + ciclos) % ciclos) * K;
  return Array.from({ length: K }, (_, i) => (inicio + i) % B);
}

// ─────────────────────────────────────────────────────────────────────────────
// SELECAO
// ─────────────────────────────────────────────────────────────────────────────

export type ModoCampos = "completo" | "minimo";

export interface OpcoesSyncStatus {
  userId: string;
  dryRun: boolean;
  campos: ModoCampos;
  kA: number;
  kB: number;
  teto: number;
  agoraMs: number;
}

/**
 * Nome da RPC de selecao. O criterio vive no BANCO
 * (supabase/migrations/20260819_rpc_selecao_status_shopee.sql) porque PostgREST
 * nao computa expressao em filtro — e o bucket e uma expressao sobre md5.
 *
 * A alternativa seria trazer a populacao nao-terminal inteira para a aplicacao
 * e filtrar em memoria: dezenas de requisicoes por execucao, crescendo com a
 * base. A RPC resolve em UMA chamada e mantem o criterio onde da para audita-lo.
 */
export const RPC_SELECAO = "selecionar_pedidos_status_shopee";

/**
 * Payload EXATO enviado a RPC. Funcao pura — existe para que o teste verifique
 * o payload sem precisar de banco, e para que nao haja um segundo lugar
 * montando esses nomes de parametro.
 *
 * `p_data_referencia` e explicita de proposito: `current_date` dentro da RPC
 * dependeria do timezone da conexao Postgres, silenciosamente.
 */
export function montarParametrosRpc(args: {
  userId: string; dataReferencia: string; bucketsA: number[]; bucketsB: number[];
}): Record<string, unknown> {
  return {
    p_user_id: args.userId,
    p_status_nao_terminais: [...STATUS_NAO_TERMINAIS],
    p_data_referencia: args.dataReferencia,
    p_idade_faixa_a: IDADE_FAIXA_A_DIAS,
    p_buckets_a: args.bucketsA,
    p_buckets_b: args.bucketsB,
  };
}

/** Data de referencia em BRT (America/Sao_Paulo), formato YYYY-MM-DD. */
export function dataReferenciaBRT(agoraMs: number): string {
  if (!Number.isFinite(agoraMs)) throw new Error(`dataReferenciaBRT: agoraMs invalido: ${agoraMs}`);
  return new Date(agoraMs - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export interface Selecao {
  faixaA: string[];
  faixaB: string[];
  antesDedup: number;
  selecionados: string[];
}

/**
 * Dedup final. Um pedido presente nas duas faixas e consultado UMA vez.
 * O `DISTINCT` do SQL ja cobre isso; este Set e a segunda tranca — barato, e
 * uma consulta duplicada custa chamada de API a toa.
 */
export function deduplicarSelecao(faixaA: string[], faixaB: string[]): Selecao {
  const vistos = new Set<string>();
  const selecionados: string[] = [];
  for (const sn of [...faixaA, ...faixaB]) {
    if (!sn || vistos.has(sn)) continue;
    vistos.add(sn);
    selecionados.push(sn);
  }
  return { faixaA, faixaB, antesDedup: faixaA.length + faixaB.length, selecionados };
}

export class ErroSelecaoAcimaDoTeto extends Error {
  readonly codigo = "SELECAO_ACIMA_DO_TETO";
  constructor(readonly selecionados: number, readonly teto: number) {
    super(`SELECAO_ACIMA_DO_TETO: ${selecionados} pedidos selecionados excedem o teto de ${teto}`);
    this.name = "ErroSelecaoAcimaDoTeto";
  }
}

/**
 * Verifica o teto ANTES de qualquer chamada a Shopee. Lanca — nao trunca, nao
 * pega os primeiros N, nao segue parcialmente. Truncar seria starvation
 * silenciosa; abortar e sinal operacional visivel.
 */
export function verificarTeto(selecionados: number, teto: number): void {
  if (!Number.isInteger(teto) || teto < 1) throw new Error(`verificarTeto: teto invalido: ${teto}`);
  if (selecionados > teto) throw new ErroSelecaoAcimaDoTeto(selecionados, teto);
}

/** Fatia em lotes de `tamanho`. Usado com DETAIL_BATCH (50). */
export function lotesDe<T>(itens: T[], tamanho: number): T[][] {
  if (!Number.isInteger(tamanho) || tamanho < 1) throw new Error(`lotesDe: tamanho invalido: ${tamanho}`);
  const lotes: T[][] = [];
  for (let i = 0; i < itens.length; i += tamanho) lotes.push(itens.slice(i, i + tamanho));
  return lotes;
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERPRETACAO DA RESPOSTA
// ─────────────────────────────────────────────────────────────────────────────

export interface LeituraDasRespostas {
  /** SOMENTE pedidos efetivamente devolvidos pela Shopee, com raw conhecido. */
  listados: Array<{ order_sn: string; order_status: string }>;
  respondidos: number;
  semResposta: string[];
  /** raw fora do mapa -> contagem. Pedido correspondente fica INTACTO. */
  statusDesconhecidos: Record<string, number>;
}

/**
 * Le as respostas de `get_order_detail`.
 *
 * DUAS regras que existem para nao inventar dado:
 *
 * 1. `listados` e construido SOMENTE com o que a API devolveu. Pedido
 *    selecionado que nao voltou na resposta entra em `semResposta` e NAO gera
 *    mudanca — ausencia de resposta nunca vira "mudou" nem "continua igual".
 *
 * 2. Status cujo raw nao esta no mapa e REMOVIDO de `listados` e contado em
 *    `statusDesconhecidos`. Sem isso, `mapStatus` devolveria "unknown" e o
 *    UPDATE gravaria `status = "unknown"` num pedido pago — que sumiria de todo
 *    filtro `status='paid'` e subnotificaria o faturamento. O pedido fica
 *    intacto e a ocorrencia aparece no diagnostico.
 */
export function lerRespostas(
  selecionados: string[],
  respostas: Array<{ response?: { order_list?: Array<{ order_sn?: string; order_status?: string }> } }>,
  mapear: (raw: string) => string,
): LeituraDasRespostas {
  const listados: Array<{ order_sn: string; order_status: string }> = [];
  const statusDesconhecidos: Record<string, number> = {};
  const devolvidos = new Set<string>();

  for (const r of respostas ?? []) {
    for (const o of r?.response?.order_list ?? []) {
      if (!o?.order_sn || !o?.order_status) continue;
      if (devolvidos.has(o.order_sn)) continue;
      devolvidos.add(o.order_sn);
      if (mapear(o.order_status) === "unknown") {
        statusDesconhecidos[o.order_status] = (statusDesconhecidos[o.order_status] ?? 0) + 1;
        continue;
      }
      listados.push({ order_sn: o.order_sn, order_status: o.order_status });
    }
  }
  const semResposta = selecionados.filter(sn => !devolvidos.has(sn));
  return { listados, respondidos: devolvidos.size, semResposta, statusDesconhecidos };
}

/** p50/p95 das duracoes das chamadas individuais. Array vazio -> 0. */
export function percentis(duracoesMs: number[]): { p50: number; p95: number } {
  if (duracoesMs.length === 0) return { p50: 0, p95: 0 };
  const ord = [...duracoesMs].sort((a, b) => a - b);
  const em = (p: number) => ord[Math.min(ord.length - 1, Math.max(0, Math.ceil(p * ord.length) - 1))];
  return { p50: em(0.5), p95: em(0.95) };
}

// ─────────────────────────────────────────────────────────────────────────────
// ORQUESTRACAO
// ─────────────────────────────────────────────────────────────────────────────

export interface DependenciasStatus {
  /** Executa `sqlSelecao()`. Devolve os order_id ja separados por faixa. */
  selecionar(opts: {
    userId: string; naoTerminais: readonly string[]; idadeFaixaA: number;
    bucketsA: number[]; bucketsB: number[];
  }): Promise<{ faixaA: string[]; faixaB: string[] }>;

  /** Uma chamada de get_order_detail para um lote de <= DETAIL_BATCH order_sn. */
  consultarLote(orderSns: string[], campos: string): Promise<any>;

  /** status_shopee_raw atual dos pedidos, direto do banco. */
  statusNoBanco(orderSns: string[]): Promise<Map<string, string | null>>;

  /** UPDATE de UM grupo. Devolve `erro` preenchido em caso de falha. */
  aplicarGrupo(grupo: GrupoDeStatus): Promise<{ erro: string | null }>;

  /** `mapStatus` de producao, injetado — nunca uma copia do mapa. */
  mapear(raw: string): string;

  /** Relogio injetado, para o teste nao depender de Date.now(). */
  agora(): number;

  /**
   * Quantos retries de rede aconteceram ate agora. Opcional: quem monta a rota
   * liga isto ao callback `onRetry` de `withRetry` (lib/sync-shopee.ts). Ausente
   * => a metrica sai 0, o que significa "nao instrumentado", nao "zero falhas
   * transitorias" — a diferenca importa ao ler o diagnostico.
   */
  retriesAcumulados?(): number;
}

export interface ResultadoSyncStatus {
  ok: boolean;
  erro: string | null;
  codigoErro: string | null;
  dry_run: boolean;
  campos: ModoCampos;
  bucket_total: number;
  kA: number;
  kB: number;
  tick: number;
  bucketsA: number;
  bucketsB: number;
  selecionadosFaixaA: number;
  selecionadosFaixaB: number;
  selecionadosAntesDedup: number;
  selecionados: number;
  teto: number;
  consultados: number;
  respondidos: number;
  semResposta: number;
  statusDesconhecidos: Record<string, number>;
  mudancas: number;
  porStatus: Record<string, number>;
  grupos: number;
  chunksUpdate: number;
  chunksFalhos: number;
  retries: number;
  ondas: number;
  p50ChamadaMs: number;
  p95ChamadaMs: number;
  tempoSelecaoMs: number;
  tempoShopeeMs: number;
  tempoUpdateMs: number;
  tempoTotalMs: number;
}

/**
 * Executa um ciclo do sync de status.
 *
 * DUAS FASES, e a separacao e deliberada:
 *
 *   FASE 1 — coleta TODAS as respostas da Shopee.
 *   FASE 2 — so entao aplica os UPDATEs.
 *
 * Falha de rede no meio da coleta aborta ANTES de qualquer escrita, em vez de
 * deixar metade dos pedidos atualizados e metade nao. Nao ha custo real: os
 * order_sn ja estao todos em memoria e a coleta e read-only na Shopee.
 *
 * O que NAO se pode afirmar: atomicidade ENTRE chunks de UPDATE. Cada chunk e
 * uma instrucao independente — ou aplica os <=200 ids dele por inteiro, ou
 * nenhum. Se o chunk 3 falhar, os chunks 1 e 2 permanecem aplicados. Isso e
 * seguro porque a operacao e idempotente: a proxima passagem daquele intervalo
 * de buckets reconsulta tudo e so grava o que ainda diverge.
 */
export async function executarSyncDeStatus(
  opts: OpcoesSyncStatus,
  deps: DependenciasStatus,
): Promise<ResultadoSyncStatus> {
  const t0 = deps.agora();
  const tick = tickDoCiclo(opts.agoraMs);
  const bucketsA = bucketsDoCiclo(tick, opts.kA);
  const bucketsB = bucketsDoCiclo(tick, opts.kB);

  const base = {
    dry_run: opts.dryRun, campos: opts.campos, bucket_total: BUCKETS,
    kA: opts.kA, kB: opts.kB, tick,
    bucketsA: bucketsA.length, bucketsB: bucketsB.length, teto: opts.teto,
  };
  const vazio = (erro: string | null, codigo: string | null, extra: Partial<ResultadoSyncStatus> = {}): ResultadoSyncStatus => ({
    ok: erro === null, erro, codigoErro: codigo, ...base,
    selecionadosFaixaA: 0, selecionadosFaixaB: 0, selecionadosAntesDedup: 0, selecionados: 0,
    consultados: 0, respondidos: 0, semResposta: 0, statusDesconhecidos: {},
    mudancas: 0, porStatus: {}, grupos: 0, chunksUpdate: 0, chunksFalhos: 0,
    retries: deps.retriesAcumulados?.() ?? 0, ondas: 0, p50ChamadaMs: 0, p95ChamadaMs: 0,
    tempoSelecaoMs: 0, tempoShopeeMs: 0, tempoUpdateMs: 0,
    tempoTotalMs: deps.agora() - t0, ...extra,
  });

  // ── SELECAO ────────────────────────────────────────────────────────────────
  const tSel = deps.agora();
  const bruta = await deps.selecionar({
    userId: opts.userId, naoTerminais: STATUS_NAO_TERMINAIS,
    idadeFaixaA: IDADE_FAIXA_A_DIAS, bucketsA, bucketsB,
  });
  const sel = deduplicarSelecao(bruta.faixaA, bruta.faixaB);
  const tempoSelecaoMs = deps.agora() - tSel;

  const parciais = {
    selecionadosFaixaA: sel.faixaA.length, selecionadosFaixaB: sel.faixaB.length,
    selecionadosAntesDedup: sel.antesDedup, selecionados: sel.selecionados.length,
    tempoSelecaoMs,
  };

  // ── TETO: aborta ANTES da Shopee ───────────────────────────────────────────
  try {
    verificarTeto(sel.selecionados.length, opts.teto);
  } catch (e: any) {
    return vazio(e?.message ?? String(e), e?.codigo ?? "ERRO_TETO", parciais);
  }
  if (sel.selecionados.length === 0) return vazio(null, null, parciais);

  // ── FASE 1: coleta ─────────────────────────────────────────────────────────
  const camposReq = opts.campos === "minimo" ? "order_status" : DETAIL_FIELDS;
  const lotes = lotesDe(sel.selecionados, DETAIL_BATCH);
  const respostas: any[] = [];
  const duracoes: number[] = [];
  let ondas = 0;
  const tShopee = deps.agora();
  try {
    for (let i = 0; i < lotes.length; i += DETAIL_CONCURRENCY) {
      const grupo = lotes.slice(i, i + DETAIL_CONCURRENCY);
      ondas++;
      const res = await Promise.all(grupo.map(async lote => {
        const ini = deps.agora();
        // SEM fallback automatico: `minimo` que falhar sobe o erro real. Trocar
        // para `completo` num catch mascararia timeout, 429 e erro de auth.
        const r = await deps.consultarLote(lote, camposReq);
        duracoes.push(deps.agora() - ini);
        return r;
      }));
      respostas.push(...res);
    }
  } catch (e: any) {
    // Coleta incompleta => NENHUMA escrita. Ver comentario das duas fases.
    return vazio(String(e?.message ?? e), "FALHA_NA_COLETA", {
      ...parciais, ondas, tempoShopeeMs: deps.agora() - tShopee,
      consultados: sel.selecionados.length,
      p50ChamadaMs: percentis(duracoes).p50, p95ChamadaMs: percentis(duracoes).p95,
    });
  }
  const tempoShopeeMs = deps.agora() - tShopee;
  const leitura = lerRespostas(sel.selecionados, respostas, deps.mapear);

  // ── DECISAO ────────────────────────────────────────────────────────────────
  const noBanco = await deps.statusNoBanco(sel.selecionados);
  const mudancas = decidirAtualizacaoDeStatus(leitura.listados, noBanco);
  const grupos = agruparMudancasDeStatus(mudancas, deps.mapear, LOTE_UPDATE_STATUS);
  const porStatus: Record<string, number> = {};
  for (const g of grupos) porStatus[g.statusRaw] = (porStatus[g.statusRaw] ?? 0) + g.orderSns.length;

  const p = percentis(duracoes);
  const comuns = {
    ...parciais, ondas, tempoShopeeMs,
    consultados: sel.selecionados.length,
    respondidos: leitura.respondidos,
    semResposta: leitura.semResposta.length,
    statusDesconhecidos: leitura.statusDesconhecidos,
    mudancas: mudancas.length, porStatus, grupos: grupos.length,
    p50ChamadaMs: p.p50, p95ChamadaMs: p.p95,
  };

  // ── FASE 2: escrita ────────────────────────────────────────────────────────
  if (opts.dryRun) return vazio(null, null, comuns);

  const tUpd = deps.agora();
  let chunksUpdate = 0, chunksFalhos = 0;
  for (const g of grupos) {
    const { erro } = await deps.aplicarGrupo(g);
    chunksUpdate++;
    if (erro) chunksFalhos++;
  }
  return vazio(
    chunksFalhos > 0 ? `${chunksFalhos} de ${chunksUpdate} chunks de UPDATE falharam` : null,
    chunksFalhos > 0 ? "CHUNKS_UPDATE_FALHOS" : null,
    { ...comuns, chunksUpdate, chunksFalhos, tempoUpdateMs: deps.agora() - tUpd },
  );
}
