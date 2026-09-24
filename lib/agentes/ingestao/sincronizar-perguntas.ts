/**
 * `sincronizar_perguntas` — o serviço de domínio da ingestão. I1/I3B.
 *
 * ── O que ele e ─────────────────────────────────────────────────────
 *
 * A peca que fica ENTRE a acao de produto e a inbox. Ela resolve o dono
 * pelo agente, ABRE o registro duravel da acao, manda o CDS executar a
 * Funcao de leitura pagina a pagina, grava o que e apto, e FECHA o
 * registro com um desfecho que diz a verdade.
 *
 * ── O que ele NAO e ─────────────────────────────────────────────────
 *
 * Nao e rota, nao e acao registrada e nao e alcancavel de fora. Nada
 * neste arquivo aparece em `lib/agentes/acoes/catalogo.ts`, entao o
 * webhook generico da ponte nao tem como chegar aqui: `resolverAcao`
 * devolve `null` para o que nao esta no mapa, e a rota responde
 * `acao_desconhecida`. A exposicao e um gate proprio.
 *
 * ── Buscar e gravar usam a MESMA autoridade ────────────────────────
 *
 * A conta em que se grava e a conta de onde se leu, e isso NAO e
 * disciplina: `executarFuncao` devolve, no sucesso, o `lojaId` do mesmo
 * `snapshot` que alimentou a Funcao. Nao ha segunda resolucao de
 * binding, entao nao ha janela entre buscar e gravar em que o vinculo
 * pudesse mudar e o dado de uma conta acabar na outra.
 *
 * ── `lojaId` nao existe neste arquivo ───────────────────────────────
 *
 * Nem como parametro, nem como variavel de entrada. A conta vem do
 * binding, dentro do executor. O mesmo vale para `userId`: ele e LIDO do
 * agente, nunca recebido.
 *
 * ── A ordem do ciclo de vida, e por que ela e essa ─────────────────
 *
 *   resolver e conferir o agente
 *     -> sem dono autoritativo nao ha linha que o banco aceite
 *   exigir a chave da tentativa
 *     -> sem ela a abertura nao entra no indice unico, e a mesma
 *        tentativa iria ao provider duas vezes
 *   ABRIR a acao
 *     -> e so aqui que a varredura passa a existir para quem le depois
 *   pagina 1, pagina 2
 *   gravar na inbox
 *   FECHAR a acao
 *
 * Nenhuma ida ao provider acontece antes da abertura. Nao e otimizacao:
 * uma varredura que o marketplace viu e que nenhum registro menciona e
 * exatamente o que esta frente existe para impedir.
 */
import {
  ACAO_SINCRONIZAR_PERGUNTAS,
  registrarAberturaAcao,
  registrarDesfechoAcao,
  type DesfechoDaAcao,
  type ResumoDaAcao,
} from "@/lib/agentes/acoes/auditoria-acao";
import { lerAgenteParaAcaoInterna } from "@/lib/agentes/capability-worker";
import {
  avancarContinuacao,
  iniciarContinuacao,
  lerContinuacao,
  reapontarContinuacao,
  reiniciarContinuacao,
  type Continuacao,
} from "@/lib/agentes/dados/continuacao-perguntas";
import {
  gravarPerguntasNaInbox,
  type LinhaParaInbox,
  type MetricasPersistencia,
} from "@/lib/agentes/dados/perguntas-inbox";
import type { PerguntaRecebida } from "@/lib/agentes/dados/perguntas";
import { LIMITE_MAXIMO_PERGUNTAS } from "@/lib/agentes/dados/perguntas";
import { executarFuncao } from "@/lib/agentes/execucao-funcoes/executar";
import { FUNCAO_ID as FUNCAO_PERGUNTAS_ML } from "@/lib/agentes/handlers/consultar-perguntas-ml-contrato";
import { randomUUID } from "node:crypto";

/**
 * O nome publico da acao — REEXPORTADO de `auditoria-acao.ts`.
 *
 * A identidade e propriedade de quem GRAVA a linha, nao de quem pede a
 * gravacao: la ela e uma lista fechada, e um `acao_id` que nao esteja
 * nela nem chega ao banco. Aqui ela continua exportada porque o nome e
 * vocabulario de produto e varias suites o citam.
 */
export { ACAO_SINCRONIZAR_PERGUNTAS };

/**
 * O unico status que vira item NOVO de trabalho.
 *
 * O provider publica sete rotulos (ANSWERED, UNANSWERED, BANNED,
 * CLOSED_UNANSWERED, DELETED, DISABLED, UNDER_REVIEW) e pode publicar um
 * oitavo amanha. A inbox nao tenta interpretar todos: ela ingere o que
 * pediu, conta o que veio diferente, e nao inventa trabalho a partir de
 * rotulo que ninguem auditou.
 */
export const STATUS_INGERIVEL = "UNANSWERED";

/**
 * ISO 8601 com data, hora e fuso — o que o Mercado Livre devolve em
 * `date_created`, e o que `timestamptz` aceita sem ambiguidade.
 *
 * Deliberadamente estreita. `Date.parse` sozinho aceitaria `"2026"` e
 * varias formas locais que o Postgres leria de outro jeito, ou nao
 * leria. Uma pergunta recusada aqui apenas nao e ingerida NESTE ciclo e
 * aparece no contador; uma pergunta aceita aqui e depois recusada pelo
 * cast da RPC derrubaria o LOTE INTEIRO. Entre os dois erros, este e o
 * barato.
 */
const ISO_8601_COM_FUSO =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * A data serve para virar `criada_em_provider`?
 *
 * ── Por que a validacao mora AQUI, e nao em `normalizarPergunta` ────
 *
 * Aquele normalizador e compartilhado com `consultar_perguntas`, que ja
 * esta em producao. Apertar a regra la mudaria o que uma Funcao
 * implantada devolve — uma pergunta com data estranha deixaria de ser
 * listada. Aqui a pergunta e outra: "esta observacao esta APTA a virar
 * linha da inbox?". E essa pergunta e da ingestao.
 */
function dataUtilizavel(criadaEm: string): boolean {
  if (!ISO_8601_COM_FUSO.test(criadaEm)) return false;
  return Number.isFinite(Date.parse(criadaEm));
}

/**
 * `PerguntaRecebida` -> a linha que a RPC espera.
 *
 * Cinco chaves, e so elas. `user_id` e `loja_id` NAO entram na linha:
 * eles sao parametros da RPC, um por chamada. Uma linha carregando a
 * propria autoridade abriria a porta para um lote com duas.
 */
function comoLinha(p: PerguntaRecebida): LinhaParaInbox {
  return {
    id_externo: p.id,
    anuncio_id_externo: p.anuncioId,
    texto: p.texto,
    provider_status: p.status,
    criada_em_provider: p.criadaEm,
  };
}

// ─── O resultado ──────────────────────────────────────────────────────

/**
 * A saude do REGISTRO duravel desta acao. ORTOGONAL ao resultado.
 *
 * `incompleta` diz que a linha de desfecho nao entrou — ou porque a
 * gravacao falhou, ou porque outra sessao ja havia fechado esta mesma
 * execucao. Nos dois casos a abertura permanece sem desfecho, e essa
 * orfa e evidencia duravel, encontravel pelo indice parcial.
 *
 * Ela NAO substitui o resultado. Um erro de provider cujo desfecho nao
 * gravou continua sendo um erro de provider: causa primaria e saude do
 * registro sao dimensoes diferentes, e colapsa-las apagaria qual das
 * duas pede intervencao.
 */
export interface SaudeDaAuditoria {
  readonly auditoria: "completa" | "incompleta";
}

/** De onde veio o codigo de um `erro`. Declarada na FONTE, para que
 *  ninguem precise inferir procedencia pelo estado em volta. */
export type OrigemDoErro =
  /** `envelope.error.code` da Funcao — provider, executor ou contrato dela. */
  | "funcao"
  /** O proprio servico julgou a saida da Funcao inutilizavel. */
  | "contrato"
  /** O ledger de Funcao nao gravou. */
  | "auditoria_funcao"
  /** O cliente da inbox falhou ou devolveu forma estranha. */
  | "persistencia"
  /** O cursor duravel nao pode ser lido, e sem ele nao se sabe onde comecar. */
  | "continuacao";

/**
 * Tudo que pode acontecer DEPOIS que a acao foi aberta.
 *
 * Separado do resto do union de proposito: so o que esta aqui ganha
 * `SaudeDaAuditoria`, porque so aqui existe um desfecho a gravar.
 */
export type ResultadoPosAbertura =
  | {
      readonly tipo: "sincronizado";
      /** O `request_id` da ACAO — o mesmo da abertura e do desfecho. */
      readonly requestId: string;
      /** INTERNO. Nao atravessa a ponte nem o n8n. */
      readonly perguntas: readonly PerguntaRecebida[];
      /** O que a INGESTAO observou e filtrou. */
      readonly metricas: MetricasSincronizacao;
      /** O que a RPC de fato gravou. Fonte unica, inclusive no lote vazio. */
      readonly persistencia: MetricasPersistencia;
      /** O provider indicou que ha mais alem desta pagina. */
      readonly providerTruncado: boolean;
    }
  /**
   * Varredura que bateu no teto de paginas COM o provider ainda
   * indicando backlog. O que coube foi gravado; a varredura NAO
   * terminou, e chamar isso de sucesso esconderia o que ficou de fora.
   */
  | {
      readonly tipo: "backlog_truncado";
      readonly requestId: string;
      readonly perguntas: readonly PerguntaRecebida[];
      readonly metricas: MetricasSincronizacao;
      readonly persistencia: MetricasPersistencia;
      readonly providerTruncado: boolean;
    }
  /** Duas paginas vieram de contas diferentes. ZERO gravacao. */
  | { readonly tipo: "autoridade_divergente"; readonly requestId: string; readonly codigo: string }
  /** A RPC recusou por contrato. Nada foi gravado — ela e atomica. */
  | { readonly tipo: "persistencia_recusada"; readonly requestId: string; readonly codigo: string }
  | { readonly tipo: "negado"; readonly requestId: string; readonly codigo: string }
  | { readonly tipo: "aguardando_aprovacao"; readonly requestId: string; readonly aprovacaoId: string }
  | {
      readonly tipo: "erro";
      readonly requestId: string;
      readonly codigo: string;
      readonly origem: OrigemDoErro;
    }
  | { readonly tipo: "indisponivel"; readonly requestId: string }
  /**
   * O cursor apontava para uma conta e a execucao devolveu outra.
   *
   * Nada foi gravado: o deslocamento guardado valia para a conta
   * ANTERIOR, e aplicar aquela pagina seria afirmar que se varreu a
   * conta nova a partir de uma posicao que nunca foi percorrida nela. O
   * cursor foi reapontado para o zero da conta nova, e a proxima
   * operacao comeca limpa.
   */
  | {
      readonly tipo: "cursor_reiniciado";
      readonly requestId: string;
      readonly lojaAnterior: string;
      readonly lojaAtual: string;
    };

export type ResultadoSincronizacao =
  // ── Antes da abertura: ZERO linha de acao, ZERO provider ──────────
  | { readonly tipo: "agente_indisponivel"; readonly motivo: "inexistente" | "inativo" | "falha_leitura" }
  /** Chamada sem chave de tentativa. Acao duravel exige identidade. */
  | { readonly tipo: "chave_ausente" }
  /** A mesma tentativa ja abriu esta varredura. O indice unico decidiu. */
  | { readonly tipo: "ja_processado"; readonly requestId: string }
  /** A abertura nao gravou por falha tecnica. FAIL_CLOSED_BEFORE_PROVIDER. */
  | { readonly tipo: "abertura_falhou"; readonly requestId: string }
  // ── Depois da abertura ────────────────────────────────────────────
  | (ResultadoPosAbertura & SaudeDaAuditoria);

/**
 * A entrada. DOIS campos, e nenhum deles escolhe autoridade.
 *
 * `agenteId` diz QUEM age; o dono sai do banco. `idempotencyKey` deixou
 * de ser opcional no I3B: uma acao com registro duravel PRECISA de
 * identidade de tentativa, senao a abertura nao entra no indice unico e
 * a mesma tentativa varre o marketplace duas vezes. O tipo cobra em
 * compilacao; `sincronizarPerguntas` cobra de novo em runtime, porque
 * tipo some na compilacao e um `as` em chamador futuro passaria direto.
 */
export interface EntradaSincronizarPerguntas {
  readonly agenteId: string;
  readonly idempotencyKey: string;
}

/**
 * As portas injetaveis, com o caminho REAL como padrao.
 *
 * Existem para que a suite prove comportamento sem banco e sem rede. O
 * padrao e o de producao: esquecer de injetar nao silencia nada, executa
 * de verdade.
 */
export interface PortasSincronizacao {
  readonly lerAgente: typeof lerAgenteParaAcaoInterna;
  readonly executar: typeof executarFuncao;
  readonly gravar: typeof gravarPerguntasNaInbox;
  readonly abrirAcao: typeof registrarAberturaAcao;
  readonly fecharAcao: typeof registrarDesfechoAcao;
  readonly lerCursor: typeof lerContinuacao;
  readonly iniciarCursor: typeof iniciarContinuacao;
  readonly avancarCursor: typeof avancarContinuacao;
  readonly reiniciarCursor: typeof reiniciarContinuacao;
  readonly reapontarCursor: typeof reapontarContinuacao;
}

const PORTAS_REAIS: PortasSincronizacao = {
  lerAgente: lerAgenteParaAcaoInterna,
  executar: executarFuncao,
  gravar: gravarPerguntasNaInbox,
  abrirAcao: registrarAberturaAcao,
  fecharAcao: registrarDesfechoAcao,
  lerCursor: lerContinuacao,
  iniciarCursor: iniciarContinuacao,
  avancarCursor: avancarContinuacao,
  reiniciarCursor: reiniciarContinuacao,
  reapontarCursor: reapontarContinuacao,
};

/** A forma que a Funcao de perguntas devolve em `envelope.data`. */
function lerDados(data: unknown): {
  linhas: readonly PerguntaRecebida[];
  truncado: boolean;
  providerRecebidas: number;
  descartadasNormalizacao: number;
} | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const o = data as Record<string, unknown>;
  if (!Array.isArray(o.linhas)) return null;
  if (typeof o.truncado !== "boolean") return null;
  const inteiro = (v: unknown): number | null =>
    typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
  const providerRecebidas = inteiro(o.providerRecebidas);
  const descartadasNormalizacao = inteiro(o.descartadasNormalizacao);
  if (providerRecebidas === null || descartadasNormalizacao === null) return null;
  return {
    linhas: o.linhas as readonly PerguntaRecebida[],
    truncado: o.truncado,
    providerRecebidas,
    descartadasNormalizacao,
  };
}

/**
 * Separa o que e apto do que apenas foi observado.
 *
 * Nenhum item observado desaparece da contabilidade: ou entra em
 * `ingeriveis`, ou e contado em `status_inesperados`, ou em
 * `descartadas`. A soma fecha com `recebidas`, e ha invariante na suite
 * provando isso.
 */
function filtrarIngeriveis(linhas: readonly PerguntaRecebida[]): {
  aptas: PerguntaRecebida[];
  statusInesperados: number;
  descartadas: number;
} {
  const aptas: PerguntaRecebida[] = [];
  let statusInesperados = 0;
  let descartadas = 0;

  for (const linha of linhas) {
    if (linha.status !== STATUS_INGERIVEL) {
      statusInesperados += 1;
      continue;
    }
    if (!dataUtilizavel(linha.criadaEm)) {
      descartadas += 1;
      continue;
    }
    aptas.push(linha);
  }

  return { aptas, statusInesperados, descartadas };
}

/**
 * A janela de paginacao. Fixa, e por isso auditavel.
 *
 * `PAGE_LIMIT` no teto do dominio (`LIMITE_MAXIMO_PERGUNTAS`) porque uma
 * pagina maior significa menos idas ao provider dentro do mesmo
 * orcamento. `MAX_PAGINAS` em 2 e uma cerca ESTRUTURAL do I3A: ela nao
 * promete caber em orcamento de orquestrador nenhum, porque ainda nao
 * existe rota. Ver `WALL_CLOCK_BUDGET`, adiado.
 */
export const PAGE_LIMIT = LIMITE_MAXIMO_PERGUNTAS;
export const MAX_PAGINAS = 2;
export const MAX_JANELA_PROVIDER = PAGE_LIMIT * MAX_PAGINAS;

/**
 * ── O ORCAMENTO DE RELOGIO DA ACAO ─────────────────────────────────
 *
 * Os numeros abaixo NAO sao estimativa de latencia — ninguem mediu
 * essas chamadas em producao, e inventar uma media seria pior que nao
 * ter. Eles saem dos limites DUROS de fora para dentro:
 *
 *   corte do servidor (vercel.json, `app/api/**`)  = 60 s
 *   timeout HTTP de quem chama (n8n)               = 45 s
 *
 * Para operacao desassistida o que vale e o MENOR: uma acao que passa de
 * 45 s termina sozinha do lado de la, e quem chamou nao aprende o
 * desfecho. Entao o teto e 38 s — 7 s de folga contra o chamador e 22 s
 * contra o corte do servidor.
 *
 * ── Por que existe RESERVA ─────────────────────────────────────────
 *
 * Depois da ULTIMA ida ao provider ainda falta gravar: a RPC da inbox, o
 * desfecho da acao e a resposta. Um orcamento que so contasse as idas ao
 * marketplace gastaria tudo nelas e deixaria a varredura sem onde
 * registrar o que coletou — que e exatamente o defeito que a auditoria
 * duravel existe para nao ter. A reserva e tempo SEPARADO, e nenhuma
 * pagina pode consumi-la.
 *
 * ── Por que o minimo de pagina e 20 s ──────────────────────────────
 *
 * E o teto de UMA chamada externa limitada deste caminho — os mesmos
 * 20 s de `mercado-livre-concessoes.ts`, `mercado-livre-perguntas.ts` e
 * agora `refreshMLToken`. Comecar uma pagina com menos que isso seria
 * comecar sabendo que ao menos uma das chamadas dela nao cabe no proprio
 * teto; o desfecho provavel seria um timeout classificado como falha de
 * provider, trocando um parcial honesto por um erro que nao aconteceu.
 */
export const ORCAMENTO_TOTAL_MS = 38_000;
export const RESERVA_FINALIZACAO_MS = 8_000;
export const ORCAMENTO_EXTERNO_MS = ORCAMENTO_TOTAL_MS - RESERVA_FINALIZACAO_MS;
export const CUSTO_MINIMO_DE_PAGINA_MS = 20_000;

/**
 * O relogio das decisoes de orcamento e MONOTONICO.
 *
 * `Date.now()` anda para tras num acerto de NTP, e um orcamento que
 * dependesse dele poderia concluir que sobram 30 s quando ja se
 * passaram 30. `performance.now()` nao volta.
 */
function agoraMonotonico(): number {
  return performance.now();
}

/**
 * O deslocamento da pagina `n`. FIXO — nunca derivado do que sobrou.
 *
 * Se o offset avancasse pelo numero de linhas NORMALIZADAS, uma pagina
 * com 3 itens malformados iria de 0 para 47 e releria 3 itens que ja
 * passaram. Descarte de forma nao pode mover a janela do provider.
 */
export function deslocamentoDaPagina(indice: number): number {
  return indice * PAGE_LIMIT;
}

/**
 * A chave de idempotencia de UMA pagina.
 *
 * Deterministica: mesma tentativa e mesma pagina dao sempre a mesma
 * chave; paginas diferentes dao chaves diferentes; tentativas
 * diferentes tambem. Nenhum uuid e sorteado aqui — sortear tornaria
 * todo retry uma execucao nova, que e exatamente o que a chave existe
 * para impedir.
 *
 * Sufixo, e nao prefixo: a chave da tentativa ja carrega provedor, acao
 * e agente, e manter esse comeco intacto preserva a separacao de
 * namespace que `chaveDeIdempotencia` construiu. E o prefixo intacto e o
 * que liga a acao as suas paginas em `agente_funcao_chamadas`.
 *
 * Sem risco de estouro: `idempotency_key` e `text` no banco, e
 * `registrarAbertura` nao impoe comprimento. A chave da ponte ja tem
 * ~190 caracteres no pior caso; `:p0` acrescenta tres.
 */
export function chaveDaPagina(chaveDaTentativa: string, indice: number): string {
  return `${chaveDaTentativa}:p${indice}`;
}

/** O que a ingestao contou na varredura INTEIRA. Somente escalares. */
export interface MetricasSincronizacao {
  readonly paginas: number;
  /** Itens que o provider devolveu, ANTES da normalizacao. */
  readonly provider_recebidas: number;
  /** Itens que sobreviveram a `normalizarPerguntas`. */
  readonly normalizadas: number;
  /** Recusados pela normalizacao, por forma. */
  readonly descartadas_normalizacao: number;
  /** Recusados pelo filtro de INGESTAO — hoje, data invalida. */
  readonly descartadas_ingestao: number;
  /** Normalizados cujo status nao vira item novo de trabalho. */
  readonly status_inesperados: number;
  /** Aptos a virar linha da inbox. */
  readonly ingeriveis: number;
  /** O provider indicou que ha mais ALEM da janela varrida. */
  readonly truncado: boolean;
  /** A varredura parou por bater em `MAX_PAGINAS`. */
  readonly limite_atingido: boolean;
  /**
   * A varredura parou porque o ORCAMENTO DE RELOGIO nao comportava mais
   * uma pagina.
   *
   * Separado de `limite_atingido` de proposito: os dois terminam a
   * varredura com backlog, e o desfecho dos dois e o mesmo, mas a acao
   * de quem opera e oposta. Teto de paginas pede continuacao; orcamento
   * esgotado pede olhar latencia. Colapsa-los mandaria procurar no lugar
   * errado.
   */
  readonly orcamento_esgotado: boolean;
  /**
   * Alguma pagina rodou com sucesso e teve o desfecho de FUNCAO perdido.
   *
   * O dado do provider e verdadeiro e a inbox recebe tudo — mas a
   * abertura daquela Funcao fica orfa em `executando`. Sem este
   * escalar, a varredura terminaria como sucesso limpo e a orfa nao
   * teria quem a explicasse.
   */
  readonly auditoria_funcao_incompleta: boolean;
  /** Onde ESTA varredura comecou. Vem do cursor, nunca do chamador. */
  readonly deslocamento_inicial: number;
  /** Ha trabalho alem da janela varrida, e o cursor o registrou. */
  readonly continuacao_pendente: boolean;
  /** O cursor avancou de forma duravel nesta acao. */
  readonly cursor_atualizado: boolean;
  /** A conta mudou debaixo do cursor e ele voltou ao zero. */
  readonly cursor_reiniciado: boolean;
}

/** Uma pagina lida com sucesso, ja separada pelo filtro de ingestao. */
interface PaginaColetada {
  readonly aptas: readonly PerguntaRecebida[];
  readonly providerRecebidas: number;
  readonly normalizadas: number;
  readonly descartadasNormalizacao: number;
  readonly descartadasIngestao: number;
  readonly statusInesperados: number;
  readonly haMais: boolean;
  /** `incompleta` quando o ledger de Funcao desta pagina nao gravou. */
  readonly auditoriaDaFuncao: "completa" | "incompleta";
}

// ─── Os mapas de desfecho ─────────────────────────────────────────────

/**
 * `envelope.error.code` da Funcao -> desfecho da ACAO.
 *
 * FECHADO para o que e defeito NOSSO, e so isso. O resto — que e o
 * vocabulario do provider (`conexao_invalida`, `credencial_ausente`,
 * `nao_autorizado`, `limite_excedido`, `indisponivel`,
 * `resposta_invalida`, e o que o adapter publicar amanha) mais
 * `executor_falhou` — cai em `provedor_falhou` pelo padrao declarado
 * abaixo. Nao e catch-all cego: e a afirmacao de que tudo que a Funcao
 * reporta e nao esta nesta tabela veio do lado de la.
 */
const DESFECHO_POR_CODIGO_DA_FUNCAO: Readonly<Record<string, DesfechoDaAcao>> = Object.freeze({
  // A Funcao rompeu o proprio contrato de saida.
  saida_invalida: { status: "erro", codigo: "contrato_violado" },
  // Defeito nosso: o executor nao conseguiu montar contexto, o
  // interpretador lancou, ou o envelope degradou.
  erro_interno: { status: "erro", codigo: "erro_interno" },
  // Os quatro de `validarFiltroPerguntas`. Este servico monta os
  // argumentos por literal, entao sao inalcancaveis — e se aparecerem,
  // quem errou fomos nos, nao o marketplace.
  filtro_ausente: { status: "erro", codigo: "erro_interno" },
  status_invalido: { status: "erro", codigo: "erro_interno" },
  limite_invalido: { status: "erro", codigo: "erro_interno" },
  deslocamento_invalido: { status: "erro", codigo: "erro_interno" },
  // Fail-closed de escrita. A Funcao de perguntas e leitura, entao isto
  // tambem e inalcancavel daqui.
  escrita_nao_suportada: { status: "erro", codigo: "erro_interno" },
});

const DESFECHO_PADRAO_DA_FUNCAO: DesfechoDaAcao =
  Object.freeze({ status: "erro", codigo: "provedor_falhou" } as const);

/**
 * O codigo da persistencia -> desfecho da ACAO. FECHADO, sem padrao.
 *
 * Chave desconhecida aqui significa que o vocabulario do cliente da
 * inbox mudou e este mapa nao acompanhou. Isso e defeito nosso, e vira
 * `erro_interno` — nunca um `persistencia_falhou` de conveniencia, que
 * mandaria procurar problema no banco.
 */
const DESFECHO_POR_CODIGO_DA_PERSISTENCIA: Readonly<Record<string, DesfechoDaAcao>> =
  Object.freeze({
    // 42501: a loja nao existe, e de outro dono, ou nao e ML. Pede
    // religar a conta — acao diferente de investigar dado.
    "42501": { status: "erro", codigo: "persistencia_negada" },
    // 22023: lote invalido ou identidade do provider divergente.
    "22023": { status: "erro", codigo: "persistencia_recusada" },
    // 25000: lote incompleto sob concorrencia.
    "25000": { status: "erro", codigo: "persistencia_recusada" },
    falha_rpc: { status: "erro", codigo: "persistencia_falhou" },
    resposta_rpc_fora_de_forma: { status: "erro", codigo: "persistencia_falhou" },
  });

const DESFECHO_INTERNO: DesfechoDaAcao =
  Object.freeze({ status: "erro", codigo: "erro_interno" } as const);

/** O guard publica quatro codigos terminais, e a acao os adota inteiros.
 *  Um quinto que apareca sem passar por aqui vira `erro_interno`, que e
 *  fail-closed — nunca uma negacao inventada. */
const NEGACOES_CONHECIDAS: ReadonlySet<string> = new Set([
  "funcao_inexistente", "permissao_ausente", "permissao_bloqueada", "conexao_ausente",
]);

// ─── A leitura de uma pagina ──────────────────────────────────────────

/**
 * Traduz o desfecho de UMA pagina.
 *
 * Desfecho que nao e sucesso atravessa quase intacto: recusa de
 * permissao, aprovacao pendente e erro de provider sao fatos do CDS, e
 * reembrulha-los num vocabulario proprio criaria uma segunda verdade
 * para manter. Qualquer um deles aborta a varredura ANTES de qualquer
 * gravacao.
 *
 * ── A classificacao viaja JUNTO com a parada ────────────────────────
 *
 * Cada ramo devolve, ao mesmo tempo, o que o servico responde e o
 * desfecho que a acao registra. Deixar a classificacao para depois
 * obrigaria a reconstituir a procedencia a partir de uma string, e foi
 * exatamente assim que `resposta_fora_de_forma` passou a significar
 * duas coisas.
 */
type LeituraDePagina =
  | { tipo: "ok"; pagina: PaginaColetada; lojaId: string }
  | { tipo: "parar"; saida: ResultadoPosAbertura; desfecho: DesfechoDaAcao; mensagem?: string };

function lerPagina(
  resultado: Awaited<ReturnType<typeof executarFuncao>>,
  requestIdDaAcao: string
): LeituraDePagina {
  switch (resultado.tipo) {
    case "sucesso": {
      const dados = lerDados(resultado.envelope.data);
      if (dados === null) {
        // A Funcao devolveu algo fora da forma. Falha fechada: adivinhar
        // a forma aqui e o comeco de ingerir lixo.
        return {
          tipo: "parar",
          saida: {
            tipo: "erro",
            requestId: requestIdDaAcao,
            codigo: "resposta_funcao_fora_de_forma",
            origem: "contrato",
          },
          desfecho: { status: "erro", codigo: "contrato_violado" },
          mensagem: "a Funcao devolveu `data` fora da forma esperada",
        };
      }

      // A autoridade da GRAVACAO vem da EXECUCAO que buscou. Sem ela nao
      // ha onde gravar, e inventar uma seria escolher conta por conta
      // propria — exatamente o que este servico existe para nao fazer.
      const lojaId = resultado.autoridade.lojaId;
      if (lojaId === null) {
        return {
          tipo: "parar",
          saida: {
            tipo: "erro",
            requestId: requestIdDaAcao,
            codigo: "autoridade_ausente",
            origem: "contrato",
          },
          desfecho: { status: "erro", codigo: "contrato_violado" },
          mensagem: "sucesso de Funcao sem conta autoritativa",
        };
      }

      const { aptas, statusInesperados, descartadas } = filtrarIngeriveis(dados.linhas);
      return {
        tipo: "ok",
        lojaId,
        pagina: {
          aptas,
          providerRecebidas: dados.providerRecebidas,
          normalizadas: dados.linhas.length,
          descartadasNormalizacao: dados.descartadasNormalizacao,
          descartadasIngestao: descartadas,
          statusInesperados,
          // BRUTO. Uma pagina cheia de itens malformados continua sendo
          // uma pagina cheia — medir pelo que sobrou faria o descarte
          // parecer fim de lista.
          haMais: dados.truncado,
          // NAO e descartado: e a unica evidencia de que o ledger de
          // Funcao daquela pagina ficou pela metade.
          auditoriaDaFuncao: resultado.auditoria,
        },
      };
    }

    case "negado": {
      const conhecida = NEGACOES_CONHECIDAS.has(resultado.codigo);
      return {
        tipo: "parar",
        saida: { tipo: "negado", requestId: requestIdDaAcao, codigo: resultado.codigo },
        desfecho: conhecida
          ? { status: "negado", codigo: resultado.codigo as "permissao_ausente" }
          : DESFECHO_INTERNO,
      };
    }

    case "aguardando_aprovacao":
      return {
        tipo: "parar",
        saida: {
          tipo: "aguardando_aprovacao",
          requestId: requestIdDaAcao,
          aprovacaoId: resultado.aprovacaoId,
        },
        desfecho: { status: "aguardando_aprovacao", codigo: "aprovacao_necessaria" },
      };

    case "erro": {
      // So o CODIGO. A frase do envelope nao viaja: o adapter ja
      // descartou corpo, header e status do provider.
      const codigo = resultado.envelope.error.code;
      return {
        tipo: "parar",
        saida: { tipo: "erro", requestId: requestIdDaAcao, codigo, origem: "funcao" },
        desfecho: DESFECHO_POR_CODIGO_DA_FUNCAO[codigo] ?? DESFECHO_PADRAO_DA_FUNCAO,
      };
    }

    case "falha_auditoria":
      // `duplicada` nao e mais alcancavel por aqui: a chave de pagina
      // deriva da chave da tentativa, e uma repeticao da mesma tentativa
      // colide no indice de ABERTURA DE ACAO antes de chegar ao
      // provider. Se chegar, o invariante quebrou — e `erro_interno`
      // fail-closed e a resposta, nao silencio.
      return {
        tipo: "parar",
        saida: {
          tipo: "erro",
          requestId: requestIdDaAcao,
          codigo: "falha_auditoria",
          origem: "auditoria_funcao",
        },
        desfecho: resultado.motivo === "duplicada"
          ? DESFECHO_INTERNO
          : { status: "erro", codigo: "auditoria_funcao_falhou" },
        mensagem: `o ledger de Funcao nao gravou na etapa ${resultado.etapa}`,
      };

    case "aprovacao_indisponivel":
      // Inalcancavel por `executarFuncao` — so `retomarAprovacao` a
      // produz. O ramo existe por exaustividade de tipo.
      return {
        tipo: "parar",
        saida: {
          tipo: "erro",
          requestId: requestIdDaAcao,
          codigo: resultado.codigo,
          origem: "funcao",
        },
        desfecho: DESFECHO_INTERNO,
      };

    case "indisponivel":
      return {
        tipo: "parar",
        saida: { tipo: "indisponivel", requestId: requestIdDaAcao },
        desfecho: { status: "erro", codigo: "autoridade_indisponivel" },
      };

    default: {
      // Exaustividade: uma variante nova do executor deixa de compilar aqui.
      const _exaustivo: never = resultado;
      return _exaustivo;
    }
  }
}

// ─── O ciclo de vida ──────────────────────────────────────────────────

/** Tudo que o fechamento precisa saber, resolvido UMA vez na abertura. */
interface ContextoDaAcao {
  readonly userId: string;
  readonly agenteId: string;
  readonly requestId: string;
  /** Monotonico, de `performance.now()`. Nunca `Date.now()`. */
  readonly inicio: number;
}

/**
 * Varre ate `MAX_PAGINAS`, coleta tudo, grava UMA vez, e fecha a acao.
 *
 * ── Por que a autoridade e CONGELADA na primeira pagina ─────────────
 *
 * Cada `executarFuncao` resolve o binding de novo. Entao a pagina 2
 * pode, em tese, vir de outra conta — se o vinculo mudou no meio. Um
 * lote com paginas de contas diferentes seria dado de uma conta gravado
 * na outra, e nenhum contador denunciaria.
 *
 * Como `COLLECT_THEN_WRITE` so grava no fim, dar com a divergencia
 * durante a varredura ainda permite abortar com ZERO escrita. Por isso
 * a primeira pagina congela a autoridade e as seguintes so podem
 * confirma-la.
 */
export async function sincronizarPerguntas(
  entrada: EntradaSincronizarPerguntas,
  portas: PortasSincronizacao = PORTAS_REAIS
): Promise<ResultadoSincronizacao> {
  // ── 1. O dono, e ele vem do BANCO ─────────────────────────────────
  const { agente, erro } = await portas.lerAgente(entrada.agenteId);
  if (erro !== null) return { tipo: "agente_indisponivel", motivo: "falha_leitura" };
  // Inexistente e alheio dao a MESMA resposta: distingui-las seria um
  // oraculo de existencia de recurso de terceiro.
  if (agente === null) return { tipo: "agente_indisponivel", motivo: "inexistente" };
  if (!agente.ativo) return { tipo: "agente_indisponivel", motivo: "inativo" };

  // ── 2. A chave da tentativa, ANTES de qualquer coisa duravel ──────
  //
  // O tipo ja a exige, e mesmo assim ela e conferida aqui: tipo some na
  // compilacao. Sem chave nao ha abertura, e sem abertura nao ha
  // varredura — nunca o contrario.
  const chave = entrada.idempotencyKey;
  if (typeof chave !== "string" || chave.trim().length === 0) {
    return { tipo: "chave_ausente" };
  }

  // ── 3. A identidade da EXECUCAO da acao, gerada no SERVIDOR ───────
  //
  // Nunca recebida: nem do n8n, nem do chamador, nem dos argumentos.
  // Mesma disciplina de `executarFuncao`, que gera o dele antes de tudo.
  const requestId = randomUUID();

  // ── 4. A abertura. Daqui para tras nada tocou o marketplace ───────
  const abertura = await portas.abrirAcao({
    userId: agente.userId,
    agenteId: agente.agenteId,
    acaoId: ACAO_SINCRONIZAR_PERGUNTAS,
    requestId,
    idempotencyKey: chave,
  });

  if (abertura.estado === "duplicada") {
    // O INDICE decidiu, nao um `select` antes do `insert`. A varredura
    // desta tentativa ja existe; repetir iria ao provider de novo.
    return { tipo: "ja_processado", requestId };
  }
  if (abertura.estado !== "registrada") {
    // FAIL_CLOSED_BEFORE_PROVIDER. Uma varredura que o marketplace ve e
    // que nenhum registro menciona e pior do que uma varredura que nao
    // aconteceu.
    return { tipo: "abertura_falhou", requestId };
  }

  const ctx: ContextoDaAcao = {
    userId: agente.userId,
    agenteId: agente.agenteId,
    requestId,
    // O relogio comeca depois da ABERTURA: o orcamento e sobre o
    // trabalho que a acao vai fazer, e a abertura ja aconteceu.
    inicio: agoraMonotonico(),
  };

  // ── 5. O CURSOR: onde esta varredura comeca ───────────────────────
  //
  // Ler o cursor NAO e resolver vinculo. E ler o nosso proprio estado de
  // controle: um numero e a conta para a qual ele vale. A autoridade
  // continua vindo de `resultado.autoridade.lojaId`, da execucao que de
  // fato buscar — e e a COMPARACAO entre as duas que torna a troca de
  // vinculo segura.
  const leituraCursor = await portas.lerCursor({
    userId: agente.userId,
    agenteId: agente.agenteId,
  });
  if (leituraCursor.estado === "falhou") {
    // Fail-closed ANTES do provider. Sem cursor legivel nao se sabe onde
    // comecar, e comecar do zero por conta propria reingeriria tudo a
    // cada leitura que falhasse.
    return fechar(
      portas,
      ctx,
      { tipo: "erro", requestId, codigo: "cursor_ilegivel", origem: "continuacao" },
      { status: "erro", codigo: "erro_interno" },
      { lojaId: null, mensagem: "o cursor de continuacao nao pode ser lido", resumo: {} }
    );
  }
  const cursor: Continuacao | null =
    leituraCursor.estado === "encontrada" ? leituraCursor.continuacao : null;
  const deslocamentoInicial = cursor?.proximoDeslocamento ?? 0;

  // ── 6. As paginas ─────────────────────────────────────────────────
  const coletadas: PaginaColetada[] = [];
  let lojaCongelada: string | null = null;
  let haMais = false;
  let orcamentoEsgotado = false;

  for (let indice = 0; indice < MAX_PAGINAS; indice += 1) {
    // ── A regra de INICIO de pagina ────────────────────────────────
    //
    // Vale da SEGUNDA pagina em diante. A primeira comeca logo depois da
    // abertura, entao o restante e o orcamento inteiro por construcao e
    // nao ha decisao a tomar — e recusa-la deixaria a acao sem varredura
    // nenhuma, que nao e um desfecho que este vocabulario saiba contar.
    //
    // A regra e sobre COMECAR. Uma pagina ja em voo nao e interrompida
    // por ela: o deadline nao alcanca dentro de `executarFuncao`, e
    // dizer que alcanca seria a mentira que este gate existe para nao
    // contar. O que ela garante e que a acao nunca INICIA trabalho que
    // nao cabe no que sobrou — e que a reserva de finalizacao chega
    // intacta ao fim.
    if (indice > 0) {
      const restante = ORCAMENTO_EXTERNO_MS - (agoraMonotonico() - ctx.inicio);
      if (restante < CUSTO_MINIMO_DE_PAGINA_MS) {
        orcamentoEsgotado = true;
        break;
      }
    }

    const resultado = await portas.executar({
      // Do BANCO. Nunca da entrada deste servico, que nao tem esse campo.
      userId: agente.userId,
      agenteId: agente.agenteId,
      // Do CONTRATO da Funcao. O literal nao e redigitado aqui.
      funcaoId: FUNCAO_PERGUNTAS_ML,
      argumentos: {
        status: STATUS_INGERIVEL,
        limite: PAGE_LIMIT,
        // A janela comeca onde o CURSOR parou. `deslocamentoDaPagina`
        // continua cuidando so do passo DENTRO desta varredura.
        deslocamento: deslocamentoInicial + deslocamentoDaPagina(indice),
      },
      // Derivada da chave da TENTATIVA. O prefixo intacto e o que liga a
      // acao as paginas dela em `agente_funcao_chamadas`.
      idempotencyKey: chaveDaPagina(chave, indice),
    });

    const pagina = lerPagina(resultado, requestId);
    if (pagina.tipo !== "ok") {
      return fechar(portas, ctx, pagina.saida, pagina.desfecho, {
        // Nada foi gravado, entao nao ha conta sobre a qual esta acao
        // tenha agido. Ver o docblock de `fechar`.
        lojaId: null,
        mensagem: pagina.mensagem ?? null,
        resumo: resumoParcial(coletadas),
      });
    }

    // ── A cerca do CURSOR contra a conta REAL ───────────────────────
    //
    // O cursor dizia `A`; a execucao devolveu `B`. O deslocamento
    // guardado valia para A e nao significa nada em B — aplica-lo
    // saltaria, em silencio, as primeiras perguntas de B.
    //
    // A pagina ja buscada e DESCARTADA de proposito: ela veio de B na
    // posicao que era de A, entao persisti-la afirmaria uma varredura de
    // B que nunca comecou. O cursor e reapontado para o zero de B, e a
    // proxima operacao comeca limpa.
    if (cursor !== null && cursor.lojaId !== null && pagina.lojaId !== cursor.lojaId) {
      const troca = await portas.reapontarCursor(cursor, pagina.lojaId);
      return fechar(
        portas,
        ctx,
        {
          tipo: "cursor_reiniciado",
          requestId,
          lojaAnterior: cursor.lojaId,
          lojaAtual: pagina.lojaId,
        },
        { status: "erro", codigo: "autoridade_divergente" },
        {
          // Nenhuma conta foi tocada: nada entrou na inbox.
          lojaId: null,
          mensagem: "a conta do cursor mudou; a janela foi reiniciada",
          resumo: {
            deslocamento_inicial: deslocamentoInicial,
            cursor_reiniciado: true,
            // `perdida` aqui significa que outra execucao ja reapontou o
            // mesmo cursor. O resultado dela e igualmente valido, e
            // insistir seria sobrescrever trabalho alheio.
            cursor_atualizado: troca.estado === "aplicada",
          },
        }
      );
    }

    // ── A cerca de autoridade entre paginas ─────────────────────────
    if (lojaCongelada === null) {
      lojaCongelada = pagina.lojaId;
    } else if (pagina.lojaId !== lojaCongelada) {
      // Nada foi gravado ainda, e nada sera. Misturar paginas de contas
      // diferentes num lote so e o defeito que esta cerca existe para
      // tornar impossivel.
      return fechar(
        portas,
        ctx,
        {
          tipo: "autoridade_divergente",
          requestId,
          codigo: "autoridade_divergente_entre_paginas",
        },
        { status: "erro", codigo: "autoridade_divergente" },
        {
          lojaId: null,
          mensagem: "duas paginas da mesma varredura vieram de contas diferentes",
          resumo: resumoParcial(coletadas),
        }
      );
    }

    coletadas.push(pagina.pagina);
    haMais = pagina.pagina.haMais;

    // Pagina que nao encheu significa fim de lista: pedir a seguinte
    // seria uma ida ao provider que ninguem precisa.
    if (!haMais) break;
  }

  if (lojaCongelada === null) {
    // Nao houve pagina alguma — so acontece se `MAX_PAGINAS` for zero.
    return fechar(
      portas,
      ctx,
      { tipo: "erro", requestId, codigo: "autoridade_ausente", origem: "contrato" },
      { status: "erro", codigo: "contrato_violado" },
      { lojaId: null, mensagem: "nenhuma pagina foi varrida", resumo: resumoParcial(coletadas) }
    );
  }

  const aptas = coletadas.flatMap((p) => [...p.aptas]);
  const soma = (f: (p: PaginaColetada) => number) =>
    coletadas.reduce((acc, p) => acc + f(p), 0);

  // Bateu no teto E o provider ainda indica mais: a varredura NAO
  // terminou, e dizer "sucesso" aqui esconderia backlog.
  //
  // `orcamentoEsgotado` so pode ser verdadeiro com backlog: o laco so
  // chega a uma segunda volta quando `haMais` e verdadeiro.
  const limiteAtingido = coletadas.length === MAX_PAGINAS && haMais;
  const auditoriaFuncaoIncompleta = coletadas.some((p) => p.auditoriaDaFuncao === "incompleta");

  const metricas: MetricasSincronizacao = {
    paginas: coletadas.length,
    provider_recebidas: soma((p) => p.providerRecebidas),
    normalizadas: soma((p) => p.normalizadas),
    descartadas_normalizacao: soma((p) => p.descartadasNormalizacao),
    descartadas_ingestao: soma((p) => p.descartadasIngestao),
    status_inesperados: soma((p) => p.statusInesperados),
    ingeriveis: aptas.length,
    truncado: haMais,
    limite_atingido: limiteAtingido,
    orcamento_esgotado: orcamentoEsgotado,
    auditoria_funcao_incompleta: auditoriaFuncaoIncompleta,
    deslocamento_inicial: deslocamentoInicial,
    // Preenchidos depois da persistencia: enquanto a inbox nao gravou,
    // nao ha pedaco consumido e o cursor nao se move.
    continuacao_pendente: haMais,
    cursor_atualizado: false,
    cursor_reiniciado: false,
  };

  // ── 6. COLLECT_THEN_WRITE: so agora, e uma vez so ─────────────────
  //
  // Duplicata ENTRE paginas chega junta ao mesmo lote, e quem decide o
  // que fazer com ela e a RPC — que ja prova colapso de duplicata exata
  // e recusa de duplicata divergente. Uma segunda politica de dedupe em
  // TypeScript criaria uma segunda verdade para manter.
  const gravacao = await portas.gravar(
    { userId: agente.userId, lojaId: lojaCongelada },
    aptas.map(comoLinha)
  );

  if (gravacao.tipo !== "gravado") {
    const codigo = gravacao.codigo;
    const saida: ResultadoPosAbertura = gravacao.tipo === "recusado"
      ? { tipo: "persistencia_recusada", requestId, codigo }
      : { tipo: "erro", requestId, codigo, origem: "persistencia" };
    return fechar(
      portas,
      ctx,
      saida,
      DESFECHO_POR_CODIGO_DA_PERSISTENCIA[codigo] ?? DESFECHO_INTERNO,
      {
        // NULL, e por duas razoes que apontam para o mesmo lugar.
        //
        // Semantica: `loja_id` no desfecho significa "a conta sobre a
        // qual esta acao AGIU". Recusa da RPC e atomica — nada entrou —,
        // entao nao houve conta sobre a qual agir.
        //
        // Estrutura: no caso 42501 a recusa e JUSTAMENTE porque a loja
        // nao e deste dono. Escreve-la aqui esbarraria na FK composta
        // `(loja_id, user_id)` e o desfecho nao gravaria — a acao
        // ficaria orfa exatamente no caso em que mais precisa de
        // explicacao. A conta que a varredura chegou a usar continua
        // recuperavel pelas linhas de Funcao, via `<tentativa>:p0`.
        lojaId: null,
        mensagem: `a inbox recusou o lote (${codigo})`,
        resumo: { ...resumoDaVarredura(metricas) },
      }
    );
  }

  // ── 7. O CURSOR avanca — e so agora ───────────────────────────────
  //
  // ── A ordem, e por que ela nao e negociavel ──────────────────────
  //
  //   1. inbox   2. cursor   3. desfecho da acao
  //
  // Nao ha transacao distribuida aqui, entao o que resta e escolher QUAL
  // falha e barata. Quebrar entre 1 e 2 deixa o cursor velho: a proxima
  // varredura relê o mesmo pedaco e a chave natural `(loja_id,
  // id_externo)` da inbox absorve — custa uma ida ao provider. Quebrar
  // na ordem inversa deixaria o cursor adiante de um pedaco que NUNCA
  // foi gravado, e nenhuma releitura traria aquelas perguntas de volta.
  // Uma das falhas repete trabalho; a outra perde dado.
  //
  // Quebrar entre 2 e 3 deixa o cursor certo e a acao orfa — e orfa e
  // justamente o que a reconciliacao de operacao sabe reportar.
  //
  // ── Teto de paginas e orcamento avancam IGUAL ────────────────────
  //
  // Os dois significam a mesma coisa para o cursor: este pedaco foi
  // consumido de forma duravel e sobrou trabalho. Deixar o cursor parado
  // em qualquer um deles faria a proxima operacao varrer de novo a mesma
  // janela, para sempre.
  const janelaConsumida = coletadas.length * PAGE_LIMIT;
  let cursorAtualizado = false;

  if (cursor === null) {
    // Primeiro ciclo deste agente. `perdida` significa que outra
    // execucao criou a linha primeiro — o resultado dela vale tanto
    // quanto o nosso, e sobrescrever seria desfazer trabalho alheio.
    const criado = await portas.iniciarCursor({
      userId: agente.userId,
      agenteId: agente.agenteId,
      lojaId: lojaCongelada,
      proximoDeslocamento: haMais ? deslocamentoInicial + janelaConsumida : 0,
    });
    cursorAtualizado = criado.estado === "aplicada";
  } else if (haMais) {
    const avanco = await portas.avancarCursor(
      cursor, lojaCongelada, deslocamentoInicial + janelaConsumida);
    cursorAtualizado = avanco.estado === "aplicada";
  } else {
    // Fim de lista: a travessia terminou e a proxima comeca do zero, na
    // MESMA conta. E este reinicio periodico que limita o estrago da
    // mutacao de offset do provider — o que foi pulado numa travessia
    // reaparece na seguinte.
    const reinicio = await portas.reiniciarCursor(cursor, lojaCongelada);
    cursorAtualizado = reinicio.estado === "aplicada";
  }

  const metricasFinais: MetricasSincronizacao = {
    ...metricas,
    cursor_atualizado: cursorAtualizado,
  };

  // ── 8. O desfecho de uma varredura que terminou ───────────────────
  const resumo: ResumoDaAcao = {
    ...resumoDaVarredura(metricasFinais),
    recebidas: gravacao.metricas.recebidas,
    unicas: gravacao.metricas.unicas,
    duplicadas_no_lote: gravacao.metricas.duplicadas_no_lote,
    novas: gravacao.metricas.novas,
    atualizadas: gravacao.metricas.atualizadas,
    reobservadas: gravacao.metricas.reobservadas,
  };

  const saida: ResultadoPosAbertura = {
    // Teto de paginas ou orcamento: os dois deixam backlog para tras, e
    // os dois sao a mesma coisa para quem le o resultado — a varredura
    // nao terminou. A CAUSA fica nos escalares.
    tipo: limiteAtingido || orcamentoEsgotado ? "backlog_truncado" : "sincronizado",
    requestId,
    perguntas: aptas,
    metricas: metricasFinais,
    persistencia: gravacao.metricas,
    providerTruncado: haMais,
  };

  return fechar(portas, ctx, saida, desfechoDeVarreduraCompleta(metricasFinais), {
    lojaId: lojaCongelada,
    mensagem: null,
    resumo,
  });
}

/**
 * A PRECEDENCIA dos parciais, num lugar so e total.
 *
 * Ordem: backlog vence descartes, que vence auditoria incompleta. Os
 * dois primeiros falam do que o NEGOCIO deixou de fazer, e isso vem
 * antes do que o REGISTRO deixou de anotar.
 *
 * O que perde a precedencia NAO se perde: os tres fatos continuam no
 * `entrada_resumo` como escalares, e e de la que se le a historia
 * inteira.
 */
function desfechoDeVarreduraCompleta(m: MetricasSincronizacao): DesfechoDaAcao {
  // `backlog_truncado` cobre as DUAS causas de varredura interrompida
  // com backlog. Nao houve codigo novo, e por isso nao houve migration:
  // o vocabulario do banco ja dizia a verdade ("a varredura parou e
  // sobrou trabalho"), e o que faltava era distinguir POR QUE — que e
  // papel de escalar, nao de classificacao.
  if (m.limite_atingido || m.orcamento_esgotado) {
    return { status: "parcial", codigo: "backlog_truncado" };
  }
  const descartes =
    m.descartadas_normalizacao + m.descartadas_ingestao + m.status_inesperados;
  if (descartes > 0) return { status: "parcial", codigo: "descartes_na_varredura" };
  if (m.auditoria_funcao_incompleta) {
    return { status: "parcial", codigo: "auditoria_funcao_incompleta" };
  }
  return { status: "sucesso", codigo: null };
}

/** As metricas da varredura viram resumo sem traducao: os nomes das
 *  chaves ja sao os mesmos dos dois lados, de proposito. */
function resumoDaVarredura(m: MetricasSincronizacao): ResumoDaAcao {
  return {
    paginas: m.paginas,
    provider_recebidas: m.provider_recebidas,
    normalizadas: m.normalizadas,
    descartadas_normalizacao: m.descartadas_normalizacao,
    descartadas_ingestao: m.descartadas_ingestao,
    status_inesperados: m.status_inesperados,
    ingeriveis: m.ingeriveis,
    truncado: m.truncado,
    limite_atingido: m.limite_atingido,
    orcamento_esgotado: m.orcamento_esgotado,
    auditoria_funcao_incompleta: m.auditoria_funcao_incompleta,
    deslocamento_inicial: m.deslocamento_inicial,
    continuacao_pendente: m.continuacao_pendente,
    cursor_atualizado: m.cursor_atualizado,
    cursor_reiniciado: m.cursor_reiniciado,
  };
}

/**
 * O resumo do que ja se sabia quando a varredura parou no meio.
 *
 * Uma varredura abortada na pagina 2 ja tem os numeros da pagina 1, e
 * joga-los fora tornaria o desfecho mais pobre do que precisa. Sem
 * pagina nenhuma, o unico fato disponivel e que nenhuma auditoria de
 * Funcao ficou incompleta — e `false` ali e medicao, nao suposicao.
 */
function resumoParcial(coletadas: readonly PaginaColetada[]): ResumoDaAcao {
  const soma = (f: (p: PaginaColetada) => number) =>
    coletadas.reduce((acc, p) => acc + f(p), 0);
  return {
    paginas: coletadas.length,
    provider_recebidas: soma((p) => p.providerRecebidas),
    normalizadas: soma((p) => p.normalizadas),
    descartadas_normalizacao: soma((p) => p.descartadasNormalizacao),
    descartadas_ingestao: soma((p) => p.descartadasIngestao),
    status_inesperados: soma((p) => p.statusInesperados),
    ingeriveis: soma((p) => p.aptas.length),
    auditoria_funcao_incompleta: coletadas.some((p) => p.auditoriaDaFuncao === "incompleta"),
  };
}

/**
 * Fecha a acao e devolve o resultado com a SAUDE do registro.
 *
 * ── Por que o desfecho nunca substitui o resultado ─────────────────
 *
 * Se o `insert` do desfecho falhar, o resultado de negocio continua o
 * mesmo — o provider falhou, ou a inbox recebeu as perguntas, conforme o
 * caso. O que muda e `auditoria`, que passa a `incompleta`. Trocar um
 * erro de provider por "falha de auditoria" apagaria QUAL falha
 * aconteceu, e trocar um sucesso de ingestao por erro mandaria alguem
 * reprocessar dado que ja esta gravado.
 *
 * `duplicada` tambem da `incompleta`: outra sessao ja fechou esta
 * execucao, e a linha dela e a verdade duravel. Nao ha `update`, nao ha
 * segunda verdade — ha o aviso de que ESTE chamador nao registrou o que
 * viu.
 *
 * ── A regra do `lojaId`, e ela e UMA so ────────────────────────────
 *
 * O desfecho leva conta APENAS quando a inbox aceitou a escrita. Em todo
 * o resto — recusa da RPC, divergencia de autoridade, falha de Funcao,
 * agente sumido — vai NULL.
 *
 * `loja_id` significa "a conta sobre a qual esta acao AGIU". Uma
 * varredura que nao gravou nada nao agiu sobre conta nenhuma, e escrever
 * a conta congelada faria quem le acreditar que ela foi tocada.
 *
 * A regra tambem e a unica estruturalmente segura. No caso 42501 a
 * recusa e porque a loja nao e deste dono; escreve-la esbarraria na FK
 * composta `(loja_id, user_id)` e o desfecho simplesmente nao gravaria.
 * A acao ficaria orfa no caso em que mais precisa de explicacao — uma
 * regra por caso teria esse buraco, e uma regra so nao tem.
 *
 * A conta que a varredura chegou a usar continua recuperavel pelas
 * linhas de Funcao, que a chave `<tentativa>:p0` correlaciona.
 */
async function fechar(
  portas: PortasSincronizacao,
  ctx: ContextoDaAcao,
  saida: ResultadoPosAbertura,
  desfecho: DesfechoDaAcao,
  extras: {
    lojaId: string | null;
    mensagem: string | null;
    resumo: ResumoDaAcao;
  }
): Promise<ResultadoSincronizacao> {
  const registro = await portas.fecharAcao({
    userId: ctx.userId,
    agenteId: ctx.agenteId,
    acaoId: ACAO_SINCRONIZAR_PERGUNTAS,
    requestId: ctx.requestId,
    lojaId: extras.lojaId,
    mensagem: extras.mensagem,
    // Monotonica, pela mesma razao do orcamento: uma latencia negativa
    // por acerto de relogio seria recusada pelo CHECK do banco, e o
    // desfecho inteiro se perderia por causa de um numero.
    latenciaMs: Math.max(0, Math.round(agoraMonotonico() - ctx.inicio)),
    resumo: extras.resumo,
    ...desfecho,
  });

  return {
    ...saida,
    auditoria: registro.estado === "registrada" ? "completa" : "incompleta",
  };
}
