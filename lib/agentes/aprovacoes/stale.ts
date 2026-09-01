/**
 * O detector de aberturas STALE originadas de aprovacao — APPROVAL-B1D-D1.
 *
 * ── A pergunta que este modulo responde ─────────────────────────────
 *
 *   "Quais chamadas abertas pelo consumo de uma aprovacao nunca foram
 *    fechadas, e ja passaram do prazo em que isso deixa de ser normal?"
 *
 * ── E a pergunta que ele NAO responde ───────────────────────────────
 *
 * "Quais executores morreram." Essa nao tem resposta no runtime atual, e
 * fingir que tem seria o erro mais caro possivel aqui.
 *
 * Nao existe timeout de Funcao, nao existe lease, nao existe heartbeat e
 * nao existe marca de "o executor comecou". A linha de abertura registra
 * QUANDO ela foi gravada, nao quando o executor parou. Logo, para
 * qualquer idade X, uma execucao lenta e viva com idade maior que X e
 * indistinguivel de uma morta. E a mesma limitacao que a migration de
 * `claim_next_agente_tarefa` ja declara para tarefas — la resolvida com
 * heartbeat, que aqui nao existe.
 *
 * Por isso o vocabulario deste modulo e `stale`, e nunca "orfa
 * confirmada":
 *
 *   stale = abertura FORA DO SLA OPERACIONAL, ainda sem desfecho.
 *           E um sinal para olhar, nao um veredito sobre o processo.
 *
 * ── O que este modulo faz, e so ─────────────────────────────────────
 *
 * SELECT. Tres deles. Nada mais.
 *
 * Ele NAO executa Funcao, NAO reexecuta nada, NAO abre chamada, NAO
 * fecha chamada, NAO consome aprovacao, NAO chama RPC e NAO escreve em
 * lugar nenhum. A politica do B1D e AT-MOST-ONCE preservado: uma
 * chamada que ficou aberta permanece aberta ate que alguem decida, com
 * informacao, o que fazer com ela. Este modulo produz essa informacao.
 *
 * ── Observacao temporal, nao verdade corrente ───────────────────────
 *
 * O resultado significa "isto estava stale durante ESTA coleta". Como o
 * PostgREST e stateless e nao ha transacao atravessando as tres
 * leituras, um desfecho gravado entre a primeira e a ultima remove a
 * candidata — e um desfecho gravado DEPOIS da ultima torna o item
 * obsoleto no instante seguinte. Isso e aceitavel exatamente porque
 * nada aqui escreve: um item obsoleto custa uma releitura, nunca um
 * efeito.
 */
import "server-only";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";

// ─── Constantes operacionais ──────────────────────────────────────────

/**
 * A idade a partir da qual uma abertura sem desfecho passa a ser
 * OBSERVADA.
 *
 * ── O que este numero e, e o que ele nao e ──────────────────────────
 *
 * E SLA operacional: ele decide quando alertar. Nao e timeout
 * comprovado, nao afirma que o executor morreu, nao autoriza fechar a
 * chamada e nao autoriza reexecutar coisa alguma.
 *
 * 15 minutos porque nao ha SLA real a copiar: o heartbeat de tarefa
 * (5 min) mede prova de vida, que aqui nao existe, e o timeout do worker
 * (60 s) e de requisicao, nao de execucao. A unica Funcao publicada faz
 * no maximo 51 consultas paginadas sem chamada externa, entao 15 minutos
 * e folgado o suficiente para nao acusar uma leitura lenta legitima.
 */
export const IDADE_STALE_APROVACAO_MS = 15 * 60 * 1000;

/** Aberturas-fonte processadas por chamada. A consulta pede uma linha a
 *  mais — ver `listarAberturasStale`. */
export const PAGINA_STALE = 100;

const TABELA_CHAMADAS = "agente_funcao_chamadas";
const TABELA_APROVACOES = "agente_funcao_aprovacoes";

/** Os tres de `agente_funcao_chamadas_nivel_valido`. `null` e legitimo
 *  na tabela; valor FORA desta lista e bug, e vira falha de leitura. */
const NIVEIS_DE_CHAMADA = ["automatico", "aprovacao", "bloqueado"] as const;
type NivelDeChamada = (typeof NIVEIS_DE_CHAMADA)[number];

// ─── Vocabulario publico ──────────────────────────────────────────────

/**
 * Posicao de leitura — e SOMENTE isso.
 *
 * O cursor nao carrega autoridade: ele nao escolhe o SLA, nao escolhe o
 * tenant e nao amplia o que pode ser visto. Ele apenas diz onde a
 * varredura anterior parou, dentro de um conjunto que ja foi filtrado
 * por `user_id`.
 */
export interface CursorStale {
  criadoEm: string;
  requestId: string;
}

export interface AberturaStale {
  requestId: string;
  aprovacaoId: string;
  agenteId: string;
  tarefaId: string | null;
  funcaoId: string;
  revisaoFuncao: string;
  nivelNoMomento: NivelDeChamada | null;
  criadoEm: string;
  idadeMs: number;
  /** Sempre `"approval"` nesta fase: o detector so enxerga chamadas
   *  abertas pelo consumo de aprovacao. Chamada automatica de
   *  `executarFuncao` tambem pode ficar sem desfecho, mas e escopo de
   *  outro gate — ampliar em silencio seria ampliar sem decisao. */
  origem: "approval";
}

export type ColetaStale = "ok" | "falha_leitura" | "entrada_invalida";

/**
 * `coleta` e a primeira coisa a ler.
 *
 * Erro de leitura NUNCA vira lista vazia bem-sucedida: as duas coisas
 * dizem o oposto uma da outra, e confundi-las transformaria um banco
 * indisponivel em "nao ha nada errado". Quando `coleta !== "ok"`, o
 * `nextCursor` tambem perde sentido e vem `null` — quem chama nao pode
 * ler isso como fim de paginacao.
 */
export interface ResultadoAberturasStale {
  itens: readonly AberturaStale[];
  coleta: ColetaStale;
  /** Instante logico da coleta. Mesmo relogio que produziu o corte de
   *  idade e as idades dos itens. Nao e persistido. */
  capturadoEm: string;
  /** `null` significa fim da varredura; qualquer outro valor significa
   *  que ha mais fonte a percorrer — inclusive quando `itens` esta
   *  vazio. */
  nextCursor: CursorStale | null;
}

export interface EntradaAberturasStale {
  userId: string;
  cursor?: CursorStale | null;
}

// ─── Auxiliares puros ─────────────────────────────────────────────────

/** O corte de idade, derivado de UM instante logico. Puro de proposito:
 *  e o unico jeito de testar a fronteira sem esperar o relogio, e sem
 *  transformar a idade em parametro publico. */
export function calcularCutoff(agoraMs: number): string {
  return new Date(agoraMs - IDADE_STALE_APROVACAO_MS).toISOString();
}

/**
 * A forma de um timestamp aceito.
 *
 * Cobre o que o Postgres devolve (`2026-09-01T14:15:29.123456+00:00`) e
 * o que `toISOString` produz (`...Z`). Ela nao serve so para validar
 * entrada: e a mesma sonda que recusa um `criado_em` deformado vindo do
 * banco, porque uma idade calculada sobre lixo viraria `NaN` silencioso.
 */
const FORMA_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:?\d{2})?$/;

/** `request_id` nasce de `randomUUID()`. A forma restrita nao e
 *  cosmetica: ela e o que garante que os dois unicos valores
 *  interpolados na expressao de continuacao nao possam carregar
 *  delimitador do PostgREST. */
const FORMA_REQUEST_ID = /^[A-Za-z0-9_-]{1,100}$/;

function textoUtil(valor: unknown): valor is string {
  return typeof valor === "string" && valor.trim().length > 0;
}

function timestampValido(valor: unknown): valor is string {
  return typeof valor === "string" && FORMA_TIMESTAMP.test(valor) && Number.isFinite(Date.parse(valor));
}

function cursorValido(cursor: CursorStale): boolean {
  return timestampValido(cursor.criadoEm) && FORMA_REQUEST_ID.test(cursor.requestId ?? "");
}

/**
 * A expressao de continuacao keyset, em sintaxe PostgREST.
 *
 * ── Por que keyset, e nao OFFSET ────────────────────────────────────
 *
 * Mesma razao ja documentada em `lib/agentes/dados/vendas.ts`: cada
 * pagina e uma REQUISICAO separada, o PostgREST e stateless, e qualquer
 * linha que entre ou saia do conjunto elegivel entre a pagina N e a N+1
 * desloca todos os offsets seguintes.
 *
 * ── Por que ordenar por `criado_em`, e nao por `request_id` ─────────
 *
 * A elegibilidade e MONOTONA nesta ordem. Uma abertura so entra no
 * conjunto quando `criado_em < cutoff`, e o cutoff avanca; logo toda
 * linha recem-elegivel tem o MAIOR `criado_em` entre as elegiveis, e
 * aparece depois do cursor — nunca antes dele. Ordenar por `request_id`
 * (uuid) perderia essa propriedade: uma linha nova cairia em qualquer
 * posicao, inclusive antes do ponto ja lido.
 *
 * ── Os valores vao entre aspas ──────────────────────────────────────
 *
 * `.` e `:` sao significativos para o parser do PostgREST, e um
 * timestamp tem os dois. As aspas duplas sao a forma documentada de
 * passar valor com caractere reservado. `JSON.stringify` produz
 * exatamente isso e ainda escapa aspa e barra — e os dois valores ja
 * passaram por `cursorValido`, entao nao ha fragmento livre aqui.
 */
export function expressaoDeContinuacao(cursor: CursorStale): string {
  const quando = JSON.stringify(cursor.criadoEm);
  const qual = JSON.stringify(cursor.requestId);
  return `criado_em.gt.${quando},and(criado_em.eq.${quando},request_id.gt.${qual})`;
}

/** Erro do driver vira categoria. O SQLSTATE pode ir para o log do
 *  servidor — a mensagem, nunca. Mesmo padrao de `persistencia.ts`. */
function logarFalha(origem: string, erro: unknown): void {
  const sqlstate = (erro as { code?: string } | null)?.code;
  console.error(`[aprovacoes/stale] ${origem} falhou (sqlstate ${sqlstate ?? "desconhecido"})`);
}

// ─── Linhas cruas ─────────────────────────────────────────────────────

interface LinhaAbertura {
  requestId: string;
  agenteId: string;
  tarefaId: string | null;
  funcaoId: string;
  criadoEm: string;
  nivelNoMomento: NivelDeChamada | null;
}

/** Estrutura ou nada. Uma linha deformada nao vira item com campo
 *  "aproximado": ela derruba a coleta inteira, porque observabilidade
 *  que inventa dado e pior que observabilidade ausente. */
function lerAbertura(bruta: unknown): LinhaAbertura | null {
  const l = bruta as Record<string, unknown> | null;
  if (!l) return null;

  const requestId = l.request_id;
  const agenteId = l.agente_id;
  const funcaoId = l.funcao_id;
  const criadoEm = l.criado_em;
  const tarefaId = l.tarefa_id ?? null;
  const nivel = l.nivel_no_momento ?? null;

  if (!textoUtil(requestId) || !textoUtil(agenteId) || !textoUtil(funcaoId)) return null;
  if (!timestampValido(criadoEm)) return null;
  if (tarefaId !== null && !textoUtil(tarefaId)) return null;
  if (nivel !== null && !(NIVEIS_DE_CHAMADA as readonly unknown[]).includes(nivel)) return null;

  return {
    requestId,
    agenteId,
    tarefaId: tarefaId as string | null,
    funcaoId,
    criadoEm,
    nivelNoMomento: nivel as NivelDeChamada | null,
  };
}

interface LinhaAprovacao {
  aprovacaoId: string;
  requestIdConsumo: string;
  funcaoId: string;
  revisaoFuncao: string;
  agenteId: string;
  tarefaId: string | null;
}

function lerAprovacao(bruta: unknown): LinhaAprovacao | null {
  const l = bruta as Record<string, unknown> | null;
  if (!l) return null;

  const aprovacaoId = l.id;
  const requestIdConsumo = l.request_id_consumo;
  const funcaoId = l.funcao_id;
  const revisaoFuncao = l.revisao_funcao;
  const agenteId = l.agente_id;
  const tarefaId = l.tarefa_id ?? null;

  if (!textoUtil(aprovacaoId) || !textoUtil(requestIdConsumo)) return null;
  if (!textoUtil(funcaoId) || !textoUtil(revisaoFuncao) || !textoUtil(agenteId)) return null;
  if (tarefaId !== null && !textoUtil(tarefaId)) return null;

  return {
    aprovacaoId,
    requestIdConsumo,
    funcaoId,
    revisaoFuncao,
    agenteId,
    tarefaId: tarefaId as string | null,
  };
}

// ─── O detector ───────────────────────────────────────────────────────

/**
 * Lista uma pagina de aberturas stale originadas de aprovacao.
 *
 * ── A ordem das tres leituras nao e estilistica ─────────────────────
 *
 *   L1  as candidatas, e a FONTE DO CURSOR: aberturas do dono, ainda
 *       `executando`, mais velhas que o corte.
 *   L2  a prova de origem: aprovacao CONSUMIDA cujo `request_id_consumo`
 *       e o `request_id` da abertura. Chamada automatica nao tem par e
 *       cai fora aqui.
 *   L3  a confirmacao final, e ela e a ULTIMA de proposito: quanto mais
 *       tarde perguntamos "ja fechou?", menor a janela em que a resposta
 *       envelhece antes de sair daqui.
 *
 * ── Por que o cursor sai de L1, e nao do resultado ──────────────────
 *
 * Uma pagina pode nao conter nenhuma stale — todas as candidatas eram
 * automaticas, ou todas ja tinham desfecho — e mesmo assim existir mais
 * fonte adiante. Se o cursor viesse da ultima stale RETORNADA, uma
 * pagina vazia devolveria `null` e a varredura pararia antes do fim,
 * deixando registros permanentemente inalcancaveis. O cursor descreve
 * ate onde LEMOS, nao o que encontramos.
 */
export async function listarAberturasStale(
  entrada: EntradaAberturasStale
): Promise<ResultadoAberturasStale> {
  // Um instante logico so: o corte de idade, as idades dos itens e o
  // `capturadoEm` precisam concordar entre si.
  const agoraMs = Date.now();
  const capturadoEm = new Date(agoraMs).toISOString();

  const encerrar = (
    coleta: ColetaStale,
    itens: readonly AberturaStale[] = [],
    nextCursor: CursorStale | null = null
  ): ResultadoAberturasStale => Object.freeze({ itens: Object.freeze(itens), coleta, capturadoEm, nextCursor });

  const { userId } = entrada;
  if (!textoUtil(userId)) return encerrar("entrada_invalida");

  // Cursor malformado NAO vira "primeira pagina": isso reiniciaria a
  // varredura em silencio e faria quem paginava perder o lugar.
  const cursor = entrada.cursor ?? null;
  if (cursor !== null && !cursorValido(cursor)) return encerrar("entrada_invalida");

  const cliente = getSupabaseServidor();

  // ── L1. Candidatas ────────────────────────────────────────────────
  let consulta = cliente
    .from(TABELA_CHAMADAS)
    .select("request_id, agente_id, tarefa_id, funcao_id, criado_em, nivel_no_momento")
    .eq("user_id", userId)
    .eq("fase", "abertura")
    .eq("status", "executando")
    .lt("criado_em", calcularCutoff(agoraMs));

  if (cursor !== null) consulta = consulta.or(expressaoDeContinuacao(cursor));

  const r1 = await consulta
    .order("criado_em", { ascending: true })
    .order("request_id", { ascending: true })
    .limit(PAGINA_STALE + 1);

  if (r1.error) {
    logarFalha("leitura_aberturas", r1.error);
    return encerrar("falha_leitura");
  }

  const brutas = Array.isArray(r1.data) ? r1.data : [];
  const lidas: LinhaAbertura[] = [];
  for (const bruta of brutas) {
    const linha = lerAbertura(bruta);
    if (linha === null) {
      logarFalha("abertura_deformada", null);
      return encerrar("falha_leitura");
    }
    lidas.push(linha);
  }

  // A linha extra existe SO para provar continuacao. Ela nao entra em
  // L2 nem em L3 nesta chamada — quem a alcanca e a proxima.
  const excedeu = lidas.length > PAGINA_STALE;
  const fonte = excedeu ? lidas.slice(0, PAGINA_STALE) : lidas;
  const ultima = fonte[fonte.length - 1];
  const proximo: CursorStale | null =
    excedeu && ultima !== undefined
      ? { criadoEm: ultima.criadoEm, requestId: ultima.requestId }
      : null;

  if (fonte.length === 0) return encerrar("ok", [], proximo);

  // ── L2. Origem aprovacao ──────────────────────────────────────────
  //
  // `argumentos` NAO entra no select. O detector nao precisa deles, e o
  // que nao e lido nao pode vazar em log, em retorno nem em tela.
  const r2 = await cliente
    .from(TABELA_APROVACOES)
    .select("id, request_id_consumo, funcao_id, revisao_funcao, agente_id, tarefa_id")
    .eq("user_id", userId)
    .eq("estado", "consumida")
    .in(
      "request_id_consumo",
      fonte.map((f) => f.requestId)
    );

  if (r2.error) {
    logarFalha("leitura_aprovacoes", r2.error);
    return encerrar("falha_leitura");
  }

  const porRequestId = new Map<string, LinhaAprovacao>();
  for (const bruta of Array.isArray(r2.data) ? r2.data : []) {
    const linha = lerAprovacao(bruta);
    if (linha === null) {
      logarFalha("aprovacao_deformada", null);
      return encerrar("falha_leitura");
    }
    porRequestId.set(linha.requestIdConsumo, linha);
  }

  // ── Divergencia estrutural para antes de tudo ─────────────────────
  //
  // A RPC de consumo grava a abertura com os valores da LINHA TRAVADA.
  // Se a abertura e a aprovacao discordarem, uma das duas esta errada —
  // e isso e mais grave que um stale. Devolver o item como se fosse um
  // atraso comum esconderia a corrupcao atras de um alerta banal.
  const candidatas: Array<{ abertura: LinhaAbertura; aprovacao: LinhaAprovacao }> = [];
  let divergentes = 0;
  for (const abertura of fonte) {
    const aprovacao = porRequestId.get(abertura.requestId);
    if (aprovacao === undefined) continue;

    if (
      aprovacao.agenteId !== abertura.agenteId ||
      aprovacao.tarefaId !== abertura.tarefaId ||
      aprovacao.funcaoId !== abertura.funcaoId
    ) {
      divergentes++;
      continue;
    }
    candidatas.push({ abertura, aprovacao });
  }

  if (divergentes > 0) {
    console.error(`[aprovacoes/stale] ${divergentes} abertura(s) divergem da aprovacao vinculada`);
    return encerrar("falha_leitura");
  }

  if (candidatas.length === 0) return encerrar("ok", [], proximo);

  // ── L3. Ja fechou? ────────────────────────────────────────────────
  const r3 = await cliente
    .from(TABELA_CHAMADAS)
    .select("request_id")
    .eq("user_id", userId)
    .eq("fase", "desfecho")
    .in(
      "request_id",
      candidatas.map((c) => c.abertura.requestId)
    );

  if (r3.error) {
    logarFalha("leitura_desfechos", r3.error);
    return encerrar("falha_leitura");
  }

  const finalizadas = new Set<string>();
  for (const bruta of Array.isArray(r3.data) ? r3.data : []) {
    const id = (bruta as { request_id?: unknown } | null)?.request_id;
    if (textoUtil(id)) finalizadas.add(id);
  }

  const itens: AberturaStale[] = [];
  for (const { abertura, aprovacao } of candidatas) {
    if (finalizadas.has(abertura.requestId)) continue;
    itens.push({
      requestId: abertura.requestId,
      aprovacaoId: aprovacao.aprovacaoId,
      agenteId: abertura.agenteId,
      tarefaId: abertura.tarefaId,
      funcaoId: abertura.funcaoId,
      revisaoFuncao: aprovacao.revisaoFuncao,
      nivelNoMomento: abertura.nivelNoMomento,
      criadoEm: abertura.criadoEm,
      idadeMs: agoraMs - Date.parse(abertura.criadoEm),
      origem: "approval",
    });
  }

  // Mais antiga primeiro — o que a operacao quer olhar. O desempate por
  // `requestId` repete a ordem total da consulta, para que duas coletas
  // do mesmo conjunto nunca devolvam ordens diferentes.
  itens.sort((a, b) =>
    a.criadoEm === b.criadoEm
      ? a.requestId.localeCompare(b.requestId)
      : a.criadoEm.localeCompare(b.criadoEm)
  );

  return encerrar("ok", itens, proximo);
}
