/**
 * Janela do sync Shopee — decisoes PURAS. SHOPEE-SYNC-TIMEOUT1a.
 *
 * ── Por que este modulo existe separado ─────────────────────────────
 * `lib/sync-shopee.ts` fala com a Shopee e com o Supabase. As regras que
 * decidem QUAL JANELA pedir e SE O CURSOR PODE AVANCAR nao precisam de
 * nada disso — sao aritmetica e comparacao. Isoladas aqui, a suite as
 * exercita sem rede, sem banco, sem env e sem shim de `server-only`.
 *
 * Este arquivo NAO importa nada. Nem `server-only`, nem tipo do sync.
 * Essa ausencia e o ponto: e o que torna as mutacoes detectaveis por
 * teste direto, em vez de por inspecao de fonte.
 *
 * ── O que ele NAO faz ───────────────────────────────────────────────
 * Nao le cursor (isso e a capability), nao grava cursor (idem), nao
 * chama Shopee, nao decide o modo do chamador.
 */

/**
 * Sobreposicao aplicada ao `time_from` incremental.
 *
 * ── Por que 15 minutos, e nao um numero redondo qualquer ────────────
 * A janela pedida a Shopee tem bordas INCLUSIVAS (o codigo atual pede
 * `00:00:00` a `23:59:59` justamente por isso), entao reler a borda e
 * comportamento esperado, nao anomalia. O overlap cobre tres folgas
 * distintas, e precisa ser maior que a soma pratica delas:
 *
 *   - a duracao da propria execucao. A execucao real medida no cron
 *     levou 55s; um pedido que mude durante a listagem pode nao
 *     aparecer na pagina ja percorrida.
 *   - latencia entre o update na Shopee e sua visibilidade em
 *     get_order_list.
 *   - clock skew entre este servidor e o relogio da Shopee.
 *
 * 5 minutos foi descartado: e da mesma ordem de grandeza da execucao.
 * 30 minutos nao foi escolhido porque nao ha evidencia de deriva dessa
 * ordem, e o overlap e custo pago em TODA execucao.
 *
 * O custo real: reler 15 min em vez de reler 17h. O upsert absorve a
 * repeticao — reler e sempre seguro, NAO reler nao e.
 */
export const SHOPEE_SYNC_OVERLAP_MS = 15 * 60 * 1000;

/**
 * Maior span que um unico chunk pode pedir, em segundos.
 *
 * Espelha exatamente o que `gerarChunks()` ja produz hoje no caminho de
 * intervalo: `addDays(cur, 13)`, de `00:00:00` a `23:59:59` — ou seja
 * 14 dias corridos menos 1 segundo. O valor esta amarrado ao limite da
 * API, nao a uma preferencia nossa, e por isso e o mesmo dos dois lados.
 */
export const MAX_SEGUNDOS_POR_CHUNK = 14 * 86400 - 1;

/**
 * Modo de operacao do sync.
 *
 *   "intervalo"    — comportamento historico. A janela vem de duas datas
 *                    (`YYYY-MM-DD`) que o chamador escolheu. NAO le e NAO
 *                    avanca cursor. E o default, e continua sendo o que
 *                    cron, GET e botao manual usam.
 *
 *   "incremental"  — a janela vem do cursor de cobertura da loja. Le o
 *                    cursor no inicio e o avanca no fim, mas SOMENTE se a
 *                    execucao cobriu a janela inteira.
 */
export type ModoSyncShopee = "intervalo" | "incremental";

export interface OpcoesSyncShopee {
  /** Ausente = "intervalo". O default preserva todo chamador atual. */
  modo?: ModoSyncShopee;
}

/** Janela absoluta, em epoch de SEGUNDOS — que e o que a Shopee aceita. */
export interface JanelaEpoch {
  de: number;
  ate: number;
}

/**
 * Converte instante absoluto para o epoch em segundos que a Shopee espera.
 *
 * ── Por que isto e mais seguro que o caminho atual ──────────────────
 * O caminho de intervalo monta `"2026-08-24T00:00:00-03:00"` e converte.
 * Funciona, mas embute `-03:00` como constante: o dia em que o Brasil
 * voltar a ter horario de verao, a janela erra em uma hora e ninguem
 * percebe, porque o sync continua "funcionando".
 *
 * O incremental nunca formata data. O cursor e um instante absoluto que
 * sai do Postgres como `timestamptz` e volta como epoch. Nao existe
 * string de meia-noite no meio, entao nao existe off-by-3h possivel.
 */
export function paraEpochSegundos(instante: Date): number {
  return Math.floor(instante.getTime() / 1000);
}

/**
 * Calcula a janela incremental a partir do cursor.
 *
 * Devolve `null` quando NAO ha cursor — o chamador deve entao usar a
 * janela de bootstrap (ontem+hoje). Devolver `null` em vez de inventar
 * um periodo e deliberado: a decisao de bootstrap e do chamador, que e
 * quem sabe que datas sao "ontem" e "hoje" no fuso do negocio.
 *
 * `coberturaAte` e capturado UMA VEZ, no inicio da execucao, e usado
 * como `time_to` em todos os chunks. Recalcular `Date.now()` por chunk
 * criaria uma janela movel cujo fim nunca se pode provar: pedidos que
 * mudassem durante a execucao entrariam ou nao conforme o acaso da
 * paginacao. Com o teto congelado, o que mudar depois de `coberturaAte`
 * fica, por construcao, para a proxima rodada.
 */
export function calcularJanelaIncremental(
  cursorIso: string | null | undefined,
  coberturaAte: Date
): JanelaEpoch | null {
  if (!cursorIso) return null;

  const cursorMs = new Date(cursorIso).getTime();
  if (!Number.isFinite(cursorMs)) return null;

  const de = paraEpochSegundos(new Date(cursorMs - SHOPEE_SYNC_OVERLAP_MS));
  const ate = paraEpochSegundos(coberturaAte);

  // Cursor no futuro em relacao a `coberturaAte` (clock skew, ou cursor
  // gravado por outra execucao mais adiantada). Janela vazia e invalida:
  // pedir `time_from > time_to` a Shopee e erro, nao no-op. Sem janela,
  // o chamador nao lista e o cursor nao avanca — fail-closed.
  if (de > ate) return null;

  return { de, ate };
}

/**
 * Fatia uma janela em chunks que respeitam o limite da API.
 *
 * ── O que esta funcao NAO faz, e por que importa ────────────────────
 * Ela nao TRUNCA. Uma versao anterior do blueprint propunha limitar
 * `time_from` a `agora - 14 dias`; revalidando, isso descarta em
 * silencio todo backlog mais antigo — exatamente o modo de falha que o
 * cursor existe para impedir. Um cursor 20 dias atrasado gera DOIS
 * chunks e cobre os 20 dias; nao gera um chunk e perde seis.
 *
 * Se o volume acumulado for grande demais para uma execucao, o remedio
 * e deadline (PR propria) — que NAO avanca o cursor e portanto nao
 * perde nada. O remedio nunca e encurtar a janela.
 */
export function fatiarJanelaEmChunks(janela: JanelaEpoch): JanelaEpoch[] {
  const chunks: JanelaEpoch[] = [];
  let inicio = janela.de;

  while (inicio <= janela.ate) {
    const fim = Math.min(inicio + MAX_SEGUNDOS_POR_CHUNK, janela.ate);
    chunks.push({ de: inicio, ate: fim });
    inicio = fim + 1;
  }

  return chunks;
}

/**
 * O cursor pode avancar de `atual` para `coberturaAte`?
 *
 * Esta e a MESMA regra que a capability impoe no `WHERE` do UPDATE. Ter
 * as duas e proposital: a do banco e a que vale sob concorrencia, e esta
 * e a que a suite consegue exercitar sem banco. O teste compara as duas.
 *
 * NULL avanca (loja no bootstrap). Igual NAO avanca — nada a fazer, e
 * tambem nao e erro.
 */
export function deveAvancarCursor(
  atualIso: string | null | undefined,
  coberturaAteIso: string
): boolean {
  const novo = new Date(coberturaAteIso).getTime();
  if (!Number.isFinite(novo)) return false;
  if (!atualIso) return true;

  const atual = new Date(atualIso).getTime();
  // Cursor atual ilegivel: nao ha como afirmar monotonicidade. Fail-closed.
  if (!Number.isFinite(atual)) return false;

  return novo > atual;
}

/**
 * Forma minima do resultado do sync que esta decisao precisa enxergar.
 * Declarada aqui, estruturalmente, para o modulo seguir sem imports.
 */
export interface ResultadoParaCobertura {
  syncIncompleto?: boolean;
  upsertErrors?: number;
  statusIncompleto?: boolean;
}

/**
 * A execucao cobriu a janela INTEIRA?
 *
 * So um `true` aqui autoriza o cursor a avancar. A funcao e fail-closed
 * por construcao: qualquer sinal de incompletude reprova, e o custo de
 * reprovar por engano e reler uma janela (barato, idempotente), enquanto
 * o custo de aprovar por engano e perder pedidos para sempre.
 *
 * Os tres sinais, e por que cada um conta:
 *
 *   `syncIncompleto`   — o sync ja declara hoje que abortou: janela de
 *                        listagem que falhou (etapa 1) ou protecao
 *                        financeira indisponivel (etapa 4.5). Nao e
 *                        conceito novo, e reaproveitamento do que o
 *                        codigo ja afirma sobre si mesmo.
 *
 *   `upsertErrors`     — lote de gravacao que falhou. Os pedidos foram
 *                        listados e detalhados, mas nao chegaram ao
 *                        banco. Avancar aqui e a perda silenciosa
 *                        classica: a Shopee nao vai devolve-los de novo
 *                        se a janela seguinte comecar depois deles.
 *
 *   `statusIncompleto` — chunk de correcao de status que falhou. Esses
 *                        pedidos so voltam a ser vistos se a janela os
 *                        incluir de novo.
 *
 * ── O que deliberadamente NAO conta ─────────────────────────────────
 * `resumoPendente`. O resumo e agregacao DERIVADA, recalculada a partir
 * dos pedidos ja gravados; ele nao diz nada sobre a cobertura da janela.
 * A execucao real do cron terminou com `resumoPendente: true` e mesmo
 * assim gravou as 888 linhas corretamente. Se o resumo bloqueasse o
 * cursor, o incremental nunca avancaria — o resumo e adiado com
 * frequencia, e por motivo que nada tem a ver com a Shopee.
 *
 * Completude dos PEDIDOS e completude do RESUMO sao coisas diferentes.
 * O cursor mede a primeira.
 */
export function syncCobriuJanelaCompletamente(
  resultado: ResultadoParaCobertura | null | undefined
): boolean {
  if (!resultado) return false;
  if (resultado.syncIncompleto === true) return false;
  if ((resultado.upsertErrors ?? 0) > 0) return false;
  if (resultado.statusIncompleto === true) return false;
  return true;
}
