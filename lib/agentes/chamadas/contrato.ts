/**
 * Contrato de uma chamada de Funcao — TOOL-CALL-B.
 *
 * ── O que este modulo e ─────────────────────────────────────────────
 *
 * O vocabulario estavel de uma Tool Call e a validacao do envelope que
 * um executor devolve. Nada alem.
 *
 * Modulo PURO: sem Supabase, sem `fetch`, sem env, sem filesystem e sem
 * `import "server-only"` — mesma escolha de `guard.ts`, e pelo mesmo
 * motivo. Nao ha segredo nem identificador de dono aqui, e em troca a
 * suite executa o validador DE VERDADE, sem banco. Um contrato que so
 * pudesse ser testado por leitura de fonte seria um contrato nao
 * testado.
 *
 * ── Duas fases, e a razao delas ─────────────────────────────────────
 *
 * O executor pode produzir efeito FORA da CDS, e o n8n nao guarda
 * execution de Tool curta — `saveDataSuccessExecution` e
 * `saveDataErrorExecution` sao `"none"` por obrigacao de seguranca.
 * Registrar depois de executar deixaria uma janela em que o efeito
 * acontece e ninguem sabe. Por isso a ABERTURA nasce antes do executor,
 * e o DESFECHO e uma linha nova — nunca um UPDATE.
 *
 * ── O que NAO mora aqui ─────────────────────────────────────────────
 *
 * Codigo HTTP, cliente, retry, timeout e qualquer nocao de n8n. O
 * envelope tem `executionId` opcional porque um executor externo PODE
 * devolver um, mas o contrato nao pressupoe nenhum executor especifico:
 * a primeira Funcao real roda em processo.
 */
import { CODIGOS_NEGACAO, type CodigoNegacao } from "@/lib/agentes/funcoes/guard";

// ─── Fases ────────────────────────────────────────────────────────────

/**
 * `abertura` significa uma coisa exata e verificavel: o executor vai ser
 * chamado agora. Validacao de argumento acontece ANTES dela — validar
 * localmente nao causa efeito externo, e uma abertura para uma entrada
 * que nunca chegou ao executor diria o contrario.
 */
export const FASES_CHAMADA = ["abertura", "desfecho"] as const;
export type FaseChamada = (typeof FASES_CHAMADA)[number];

// ─── Status ───────────────────────────────────────────────────────────

/**
 * Cinco, e nenhum a mais.
 *
 * NAO ha `requested`, `authorized` nem `running` separados: `executando`
 * ja quer dizer "guard passou, entrada validada, executor prestes a
 * rodar". NAO ha `cancelado`: nao existe quem cancele.
 *
 * `aguardando_aprovacao` repete o nome que `agente_tarefas.status` usa
 * desde a fundacao — nenhum enum paralelo foi criado.
 */
export const STATUS_CHAMADA = [
  "executando",
  "sucesso",
  "erro",
  "negado",
  "aguardando_aprovacao",
] as const;
export type StatusChamada = (typeof STATUS_CHAMADA)[number];

/** Os quatro status que encerram a tentativa. `executando` e o unico
 *  que nao encerra — e ele e sempre a abertura. */
export const STATUS_TERMINAIS = STATUS_CHAMADA.filter((s) => s !== "executando");

/** A fase e derivada do status, nunca escolhida em separado: escolher as
 *  duas coisas permitiria que discordassem. O CHECK do banco cobra o
 *  mesmo bicondicional. */
export function faseDoStatus(status: StatusChamada): FaseChamada {
  return status === "executando" ? "abertura" : "desfecho";
}

// ─── Codigos ──────────────────────────────────────────────────────────

/**
 * Falhas da EXECUCAO. Cinco, curtos, e nenhum deles duplica taxonomia
 * existente: `TIPOS_ERRO_TAREFA` e da fila (`handler_falhou`) e
 * `TipoErroIA` e de provedor de modelo.
 *
 * `http_error`, `network_error`, `settings_drift` e afins NAO entram:
 * pertencem ao executor externo, que nao existe. Categoria sem produtor
 * e categoria que ninguem sabe quando usar.
 */
export const CODIGOS_EXECUCAO = [
  "entrada_invalida",
  "executor_falhou",
  "saida_invalida",
  "timeout",
  "erro_interno",
] as const;
export type CodigoExecucao = (typeof CODIGOS_EXECUCAO)[number];

/**
 * Reexportado do `guard.ts`, nunca recopiado.
 *
 * Os cinco codigos de negacao ja sao contrato la — o docblock deles diz
 * que renomear um e mudanca de contrato, nao refatoracao. Declarar a
 * mesma uniao aqui criaria duas listas que precisariam concordar para
 * sempre, e listas assim acabam discordando.
 */
export { CODIGOS_NEGACAO };
export type { CodigoNegacao };

/** Tudo que pode explicar um desfecho: uma decisao ou uma falha. */
export type CodigoDesfecho = CodigoNegacao | CodigoExecucao;

/**
 * `aprovacao_necessaria` e EXCLUSIVO de `aguardando_aprovacao`.
 *
 * Ele esta em `CODIGOS_NEGACAO` porque, do ponto de vista do guard, e
 * um motivo de nao executar. Mas `negado` significa "nada muda isso
 * sozinho" e `aguardando_aprovacao` significa "alguem pode aprovar" —
 * decisoes opostas para quem le depois. Deixa-lo valer nos dois
 * colapsaria a diferenca.
 */
export const CODIGOS_NEGACAO_TERMINAL = CODIGOS_NEGACAO.filter(
  (c) => c !== "aprovacao_necessaria"
);

/** O conjunto de codigos que cada status admite. Espelha exatamente o
 *  CHECK `agente_funcao_chamadas_codigo_por_status`. */
export function codigoValidoParaStatus(status: StatusChamada, codigo: unknown): boolean {
  const ehNegacaoTerminal = (CODIGOS_NEGACAO_TERMINAL as readonly string[]).includes(
    codigo as string
  );
  const ehExecucao = (CODIGOS_EXECUCAO as readonly string[]).includes(codigo as string);

  switch (status) {
    case "executando":
    case "sucesso":
      return codigo === null || codigo === undefined;
    case "aguardando_aprovacao":
      return codigo === "aprovacao_necessaria";
    case "negado":
      return ehNegacaoTerminal;
    case "erro":
      return ehExecucao;
  }
}

// ─── Envelope ─────────────────────────────────────────────────────────

/** Versao do envelope. Numero, nao string: comparacao exata, sem
 *  tolerancia a `"1"`, `" 1"` ou `1.0`. */
export const VERSAO_CONTRATO = 1;

/** Limite de `executionId`. Ele e correlacao AUXILIAR — pode nao existir
 *  no erro, pode nao ser resolvivel depois, e nunca e ponteiro
 *  garantido. Um valor absurdamente longo e sinal de que algo errado
 *  esta sendo ecoado para dentro. */
export const LIMITE_EXECUTION_ID = 128;

export interface ErroEnvelope {
  code: string;
  message: string;
  retryable: boolean;
}

export interface EnvelopeSucesso {
  contrato: typeof VERSAO_CONTRATO;
  ok: true;
  request_id: string;
  execution_id?: string;
  data: unknown;
}

export interface EnvelopeErro {
  contrato: typeof VERSAO_CONTRATO;
  ok: false;
  request_id: string;
  execution_id?: string;
  error: ErroEnvelope;
}

export type Envelope = EnvelopeSucesso | EnvelopeErro;

// ─── Validacao ────────────────────────────────────────────────────────

/**
 * `true` somente para objeto simples — literal ou `Object.create(null)`.
 *
 * Mesma regra de `sanitizar.ts`, e reescrita aqui de proposito: aquele
 * helper e privado do modulo dele, e exporta-lo exigiria editar um
 * arquivo publicado fora desta allowlist. Recusar `Request`, `Headers`,
 * `Map`, `Date`, array e instancia de classe na porta transforma o
 * atalho perigoso ("passa a resposta inteira") em recusa explicita.
 */
function ehObjetoSimples(valor: unknown): valor is Record<string, unknown> {
  if (typeof valor !== "object" || valor === null) return false;
  const proto = Object.getPrototypeOf(valor);
  return proto === Object.prototype || proto === null;
}

function ehTextoUtil(valor: unknown): valor is string {
  return typeof valor === "string" && valor.trim().length > 0;
}

/**
 * O envelope veio no formato, ou nao veio.
 *
 * ── Por que shape hibrido e recusado ────────────────────────────────
 *
 * `ok: true` com `error`, ou `ok: false` com `data`, sao a forma exata
 * de um executor que respondeu duas coisas ao mesmo tempo. Aceitar o
 * ramo "que parece certo" e escolher em qual metade acreditar — e o
 * palpite ficaria gravado como fato. Recusar inteiro e a unica leitura
 * honesta: `saida_invalida`.
 *
 * ── Estrutural, e nao "tem os campos" ───────────────────────────────
 *
 * `retryable` precisa ser boolean de verdade. Uma string `"false"` e
 * truthy, e um retry decidido por ela repetiria uma escrita externa —
 * exatamente o acidente que o contrato existe para impedir.
 */
export function envelopeValido(bruto: unknown): bruto is Envelope {
  if (!ehObjetoSimples(bruto)) return false;
  if (bruto.contrato !== VERSAO_CONTRATO) return false;
  if (typeof bruto.ok !== "boolean") return false;
  if (!ehTextoUtil(bruto.request_id)) return false;

  if ("execution_id" in bruto) {
    const id = bruto.execution_id;
    if (!ehTextoUtil(id) || id.length > LIMITE_EXECUTION_ID) return false;
  }

  if (bruto.ok) {
    // Ausencia de `data` reprova, mas `data: null` passa: `null` e uma
    // resposta, ausencia e um contrato quebrado. E `error` presente num
    // envelope de sucesso e o shape hibrido.
    if (!("data" in bruto)) return false;
    if ("error" in bruto) return false;
    return true;
  }

  if ("data" in bruto) return false;
  const erro = bruto.error;
  if (!ehObjetoSimples(erro)) return false;
  if (!ehTextoUtil(erro.code)) return false;
  if (typeof erro.message !== "string") return false;
  if (typeof erro.retryable !== "boolean") return false;
  return true;
}

/** `true` quando o envelope e valido E anuncia sucesso. Existe para que
 *  quem chama nao precise repetir a checagem de `ok` depois de validar
 *  — e para que ninguem leia `data` de um envelope de erro. */
export function envelopeDeSucesso(bruto: unknown): bruto is EnvelopeSucesso {
  return envelopeValido(bruto) && bruto.ok === true;
}
