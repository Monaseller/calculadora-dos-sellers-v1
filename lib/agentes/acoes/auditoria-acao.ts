/**
 * O registro DURAVEL de uma ACAO de dominio — I3B.
 *
 * ── O que ele e ─────────────────────────────────────────────────────
 *
 * A unica porta de escrita de `agente_acao_execucoes`. Duas primitivas,
 * uma por FORMA de linha: abertura e desfecho. A tabela e append-only, e
 * este modulo nunca faz update nem delete — nem teria a quem pedir:
 * `service_role` so tem SELECT e INSERT.
 *
 * ── O que ele NAO e ─────────────────────────────────────────────────
 *
 * Nao e auditoria de Funcao. `agente_funcao_chamadas` continua
 * registrando CADA execucao de Funcao, e uma varredura de duas paginas
 * produz 1 abertura de acao + 2 aberturas de Funcao. As duas tabelas
 * respondem perguntas diferentes e nenhuma reescreve a outra.
 *
 * Nao e API generica de escrita de acao. `acao_id` nao e parametro
 * livre: ele vem de `ACOES_AUDITAVEIS`, lista fechada neste arquivo. Uma
 * acao nova precisa passar por aqui — e por uma revisao — antes de
 * conseguir gravar uma linha.
 *
 * ── Por que o resumo e TIPADO, e nao um objeto qualquer ─────────────
 *
 * `registro.ts` aceita objeto arbitrario e reprojeta so os escalares,
 * porque o `entrada_resumo` de Funcao e aberto por natureza — cada
 * Funcao tem a sua forma. Aqui a forma e UMA, conhecida e curta: as
 * metricas da varredura. Entao a fronteira pode ser mais forte que
 * "somente escalares": ela e uma ALLOWLIST DE CHAVES, declarada abaixo.
 * Chave que nao esta nela nao entra, mesmo sendo escalar.
 *
 * E por isso este modulo NAO reusa `entradaResumoSegura`: reusar seria
 * trocar uma cerca fechada por uma mais larga, e ainda obrigaria a
 * exportar uma funcao privada de um modulo ja publicado em producao.
 */
import "server-only";

import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";

const TABELA_ACOES = "agente_acao_execucoes";

/**
 * As acoes que podem ser auditadas. LISTA FECHADA.
 *
 * Mora aqui, e nao no servico, para que o servico possa importar sem
 * criar ciclo — e para que a identidade da acao seja propriedade de quem
 * grava a linha, nunca de quem pede a gravacao.
 */
export const ACAO_SINCRONIZAR_PERGUNTAS = "sincronizar_perguntas";

const ACOES_AUDITAVEIS = [ACAO_SINCRONIZAR_PERGUNTAS] as const;
export type AcaoAuditavel = (typeof ACOES_AUDITAVEIS)[number];

// ─── O vocabulario, espelhado do CHECK ────────────────────────────────

/**
 * O MESMO mapa da constraint `agente_acao_execucoes_codigo_por_status`.
 *
 * E uma segunda copia, e isso e assumido: TypeScript nao le CHECK de
 * Postgres. O que impede as duas de divergirem nao e disciplina — e um
 * invariante da suite estrutural, que recorta o `case` do SQL e compara
 * com esta tabela. Divergir reprova.
 */
export const CODIGOS_POR_STATUS = {
  sucesso: [],
  parcial: ["backlog_truncado", "descartes_na_varredura", "auditoria_funcao_incompleta"],
  aguardando_aprovacao: ["aprovacao_necessaria"],
  negado: [
    "funcao_inexistente", "permissao_ausente",
    "permissao_bloqueada", "conexao_ausente",
  ],
  erro: [
    "provedor_falhou", "contrato_violado",
    "autoridade_divergente", "autoridade_indisponivel",
    "persistencia_negada", "persistencia_recusada", "persistencia_falhou",
    "auditoria_funcao_falhou", "erro_interno",
  ],
} as const satisfies Readonly<Record<string, readonly string[]>>;

export type StatusTerminalAcao = keyof typeof CODIGOS_POR_STATUS;

/** O par (status, codigo) que o banco aceita — amarrado em TIPO, para
 *  que uma combinacao invalida nao chegue a ser escrita. */
export type DesfechoDaAcao = {
  [S in StatusTerminalAcao]: (typeof CODIGOS_POR_STATUS)[S] extends readonly []
    ? { readonly status: S; readonly codigo: null }
    : { readonly status: S; readonly codigo: (typeof CODIGOS_POR_STATUS)[S][number] };
}[StatusTerminalAcao];

// ─── O resumo ─────────────────────────────────────────────────────────

/**
 * As metricas escalares de uma varredura. NENHUMA delas identifica
 * pergunta, anuncio, conta de marketplace ou pessoa.
 *
 * Tudo opcional: um desfecho que aconteceu antes da varredura nao tem
 * contagem nenhuma para dar, e inventar zero afirmaria uma medicao que
 * ninguem fez.
 */
export interface ResumoDaAcao {
  readonly paginas?: number;
  readonly provider_recebidas?: number;
  readonly normalizadas?: number;
  readonly descartadas_normalizacao?: number;
  readonly descartadas_ingestao?: number;
  readonly status_inesperados?: number;
  readonly ingeriveis?: number;
  readonly recebidas?: number;
  readonly unicas?: number;
  readonly duplicadas_no_lote?: number;
  readonly novas?: number;
  readonly atualizadas?: number;
  readonly reobservadas?: number;
  readonly truncado?: boolean;
  readonly limite_atingido?: boolean;
  /** A varredura parou por RELOGIO, nao por teto de paginas. */
  readonly orcamento_esgotado?: boolean;
  readonly auditoria_funcao_incompleta?: boolean;
  /** Onde a varredura COMECOU. Escalar de orquestracao, nao de negocio. */
  readonly deslocamento_inicial?: number;
  /** Ha trabalho alem da janela varrida. */
  readonly continuacao_pendente?: boolean;
  /** O cursor duravel avancou nesta acao. */
  readonly cursor_atualizado?: boolean;
  /** A conta mudou debaixo do cursor e ele voltou ao zero. */
  readonly cursor_reiniciado?: boolean;
}

/** A allowlist, em runtime. Uma chave a mais no tipo sem uma chave a
 *  mais aqui simplesmente nao e gravada — fail-closed, nunca "deixa
 *  passar porque e escalar". */
const CHAVES_DO_RESUMO: ReadonlyArray<keyof ResumoDaAcao> = [
  "paginas", "provider_recebidas", "normalizadas",
  "descartadas_normalizacao", "descartadas_ingestao", "status_inesperados",
  "ingeriveis", "recebidas", "unicas", "duplicadas_no_lote",
  "novas", "atualizadas", "reobservadas",
  "truncado", "limite_atingido", "orcamento_esgotado",
  "auditoria_funcao_incompleta",
  "deslocamento_inicial", "continuacao_pendente",
  "cursor_atualizado", "cursor_reiniciado",
];

/**
 * Projeta o resumo. Chave fora da allowlist nao entra; valor que nao e
 * numero finito nem booleano nao entra.
 *
 * O resultado e sempre um OBJETO, inclusive vazio — o CHECK
 * `jsonb_typeof(entrada_resumo) = 'object'` recusaria qualquer outra
 * coisa, e devolver um objeto vazio e mais honesto que omitir a coluna.
 */
function resumoSeguro(bruto: ResumoDaAcao | undefined): Record<string, number | boolean> {
  if (bruto === undefined || bruto === null) return {};
  const destino: Record<string, number | boolean> = {};
  for (const chave of CHAVES_DO_RESUMO) {
    const valor = bruto[chave];
    if (typeof valor === "boolean") { destino[chave] = valor; continue; }
    if (typeof valor === "number" && Number.isFinite(valor)) destino[chave] = valor;
  }
  return destino;
}

// ─── Resultado ────────────────────────────────────────────────────────

/**
 * `duplicada` e a resposta do INDICE, nunca de um select antes do
 * insert. Duas sessoes com a mesma tentativa produzem uma vencedora e
 * uma 23505; ler antes de escrever teria uma janela, e nessa janela as
 * duas veriam "nao existe".
 */
export type ResultadoRegistroAcao =
  | { readonly estado: "registrada" }
  | { readonly estado: "duplicada" }
  | { readonly estado: "entrada_invalida" }
  | { readonly estado: "falhou" };

const REGISTRADA = { estado: "registrada" } as const;
const DUPLICADA = { estado: "duplicada" } as const;
const ENTRADA_INVALIDA = { estado: "entrada_invalida" } as const;
const FALHOU = { estado: "falhou" } as const;

const SQLSTATE_UNICO = "23505";
const SQLSTATE_FK = "23503";
const SQLSTATE_CHECK = "23514";

const TETO_MENSAGEM = 300;

function textoUtil(valor: unknown): valor is string {
  return typeof valor === "string" && valor.trim().length > 0;
}

function codigoDe(erro: unknown): string | null {
  if (typeof erro !== "object" || erro === null) return null;
  const c = (erro as { code?: unknown }).code;
  return typeof c === "string" ? c : null;
}

/**
 * Trunca em 300 — o mesmo teto do CHECK e o mesmo de
 * `agente_funcao_chamadas`. Mensagem e resumo, nao transcricao: corpo de
 * erro de terceiro ecoa path, e stack traz caminho de arquivo.
 */
function mensagemOuNull(bruta: string | null | undefined): string | null {
  if (!textoUtil(bruta)) return null;
  const limpa = bruta.trim();
  return limpa.length <= TETO_MENSAGEM ? limpa : limpa.slice(0, TETO_MENSAGEM);
}

/** O UNICO ponto que fala com o banco. Privado: a API exportada e por
 *  FORMA de linha, para que uma combinacao invalida seja dificil de
 *  escrever antes mesmo de o CHECK reprova-la. */
async function inserir(linha: Record<string, unknown>): Promise<ResultadoRegistroAcao> {
  const r = await getSupabaseServidor().from(TABELA_ACOES).insert(linha);

  if (r.error) {
    const codigo = codigoDe(r.error);
    if (codigo === SQLSTATE_UNICO) return DUPLICADA;
    if (codigo === SQLSTATE_FK) {
      // Agente ou loja que nao e deste dono. Nao ha tenant para
      // sustentar a linha, e insistir seria gravar por um dono que nao
      // existe.
      console.error("[acoes] linha recusada por FK composta — tenant invalido");
      return FALHOU;
    }
    if (codigo === SQLSTATE_CHECK) {
      // Combinacao que o contrato nao tem. E bug nosso, e merece log
      // proprio para nao se confundir com banco indisponivel.
      console.error("[acoes] combinacao recusada por CHECK — contrato violado no codigo");
      return FALHOU;
    }
    console.error(`[acoes] falha ao registrar (sqlstate ${codigo ?? "desconhecido"})`);
    return FALHOU;
  }

  // Sem `.select()`: ausencia de erro E a prova de que a linha existe.
  return REGISTRADA;
}

// ─── API ──────────────────────────────────────────────────────────────

export interface EntradaAberturaAcao {
  readonly userId: string;
  readonly agenteId: string;
  readonly acaoId: AcaoAuditavel;
  readonly requestId: string;
  /** A chave da TENTATIVA. OBRIGATORIA — ver o docblock abaixo. */
  readonly idempotencyKey: string;
}

/**
 * Abre a acao. Uma linha, `fase='abertura'`, `status='executando'`.
 *
 * ── `loja_id` nao e parametro, e essa ausencia e a garantia ─────────
 *
 * A conta autoritativa so existe depois que uma execucao de Funcao
 * devolve `autoridade`. Aceitar `lojaId` aqui convidaria a resolver o
 * binding so para preencher auditoria — uma SEGUNDA resolucao, que e
 * exatamente o que o I2 eliminou para fechar o TOCTOU entre buscar e
 * gravar. A coluna vai NULL, e o banco aceita porque a FK composta e
 * `match simple`.
 *
 * ── A chave e obrigatoria ──────────────────────────────────────────
 *
 * Sem ela o indice unico parcial nao cobre a linha, e a mesma tentativa
 * abriria a varredura duas vezes — cada uma indo ao provider. O tipo
 * cobra em compilacao, esta funcao cobra em runtime, e o CHECK
 * `abertura_exige_chave` cobra no banco. Tres cercas para o mesmo fato,
 * porque o custo de errar e uma varredura duplicada no marketplace.
 */
export async function registrarAberturaAcao(
  entrada: EntradaAberturaAcao
): Promise<ResultadoRegistroAcao> {
  if (!textoUtil(entrada.userId) || !textoUtil(entrada.agenteId)) return ENTRADA_INVALIDA;
  if (!textoUtil(entrada.requestId)) return ENTRADA_INVALIDA;
  if (!textoUtil(entrada.idempotencyKey)) return ENTRADA_INVALIDA;
  if (!(ACOES_AUDITAVEIS as readonly string[]).includes(entrada.acaoId)) {
    return ENTRADA_INVALIDA;
  }

  return inserir({
    user_id: entrada.userId,
    agente_id: entrada.agenteId,
    loja_id: null,
    acao_id: entrada.acaoId,
    request_id: entrada.requestId,
    fase: "abertura",
    status: "executando",
    codigo_desfecho: null,
    mensagem_desfecho: null,
    idempotency_key: entrada.idempotencyKey,
    entrada_resumo: {},
    latencia_ms: null,
  });
}

export type EntradaDesfechoAcao = {
  readonly userId: string;
  readonly agenteId: string;
  readonly acaoId: AcaoAuditavel;
  /** O MESMO da abertura. E por ele que as duas linhas se encontram. */
  readonly requestId: string;
  /** A conta REAL da varredura, quando ela chegou a existir. */
  readonly lojaId?: string | null;
  readonly mensagem?: string | null;
  readonly latenciaMs?: number | null;
  readonly resumo?: ResumoDaAcao;
} & DesfechoDaAcao;

/**
 * Fecha a acao. Linha NOVA — a abertura permanece intacta e legivel.
 *
 * `idempotency_key` vai NULL de proposito: o que torna o desfecho unico
 * e `idx_agente_acao_execucoes_desfecho_unico`, sobre
 * `(user_id, request_id)`. Repetir a chave da tentativa aqui a faria
 * colidir com a propria abertura no indice de tentativa.
 */
export async function registrarDesfechoAcao(
  entrada: EntradaDesfechoAcao
): Promise<ResultadoRegistroAcao> {
  if (!textoUtil(entrada.userId) || !textoUtil(entrada.agenteId)) return ENTRADA_INVALIDA;
  if (!textoUtil(entrada.requestId)) return ENTRADA_INVALIDA;
  if (!(ACOES_AUDITAVEIS as readonly string[]).includes(entrada.acaoId)) {
    return ENTRADA_INVALIDA;
  }

  // O par (status, codigo) e conferido AQUI tambem, e nao so pelo tipo:
  // o tipo some na compilacao, e um `as` em algum chamador futuro
  // passaria direto. A falha volta classificada em vez de virar um
  // 23514 generico.
  const aceitos = CODIGOS_POR_STATUS[entrada.status] as readonly string[] | undefined;
  if (aceitos === undefined) return ENTRADA_INVALIDA;
  if (aceitos.length === 0) {
    if (entrada.codigo !== null) return ENTRADA_INVALIDA;
  } else if (entrada.codigo === null || !aceitos.includes(entrada.codigo)) {
    return ENTRADA_INVALIDA;
  }

  const latencia = entrada.latenciaMs;
  if (latencia !== undefined && latencia !== null) {
    if (!Number.isInteger(latencia) || latencia < 0) return ENTRADA_INVALIDA;
  }

  return inserir({
    user_id: entrada.userId,
    agente_id: entrada.agenteId,
    loja_id: entrada.lojaId ?? null,
    acao_id: entrada.acaoId,
    request_id: entrada.requestId,
    fase: "desfecho",
    status: entrada.status,
    codigo_desfecho: entrada.codigo,
    // Sucesso limpo nao tem o que explicar, e o CHECK recusaria a frase.
    mensagem_desfecho: entrada.status === "sucesso" ? null : mensagemOuNull(entrada.mensagem),
    idempotency_key: null,
    entrada_resumo: resumoSeguro(entrada.resumo),
    latencia_ms: latencia ?? null,
  });
}
