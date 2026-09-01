/**
 * Persistencia append-only de chamadas de Funcao — TOOL-CALL-B.
 *
 * ── O que este modulo faz, e so ─────────────────────────────────────
 *
 * INSERT. Tres deles, um por forma de linha. Nada mais.
 *
 * Ele NAO executa Funcao, NAO chama o guard, NAO resolve o registry,
 * NAO resolve permissao, NAO resolve conexao, NAO fala com n8n nem com
 * marketplace, NAO tem `fetch`, NAO atualiza linha, NAO apaga linha e
 * NAO faz upsert. A tabela nem concede UPDATE/DELETE ao `service_role`
 * — o modulo e o banco dizem a mesma coisa, e o banco tem a palavra
 * final.
 *
 * A separacao nao e organizacional. Um modulo que grave auditoria E
 * decida execucao acaba, na primeira pressa, gravando o que decidiu em
 * vez do que aconteceu.
 *
 * ── Snapshot nao e autoridade ───────────────────────────────────────
 *
 * `acesso`, `nivelNoMomento`, `plataforma`, `recurso` e `lojaId` chegam
 * ja RESOLVIDOS por quem tinha autoridade para resolve-los, e sao
 * gravados como fotografia do instante. Nenhum deles e lido de volta
 * para decidir coisa alguma — `registry.ts` continua a autoridade de
 * `acesso`, `agente_permissoes` a de `nivel`, `agente_conexoes` a de
 * conexao. Ler um snapshot para autorizar seria criar uma segunda
 * autoridade, escondida e sem dono.
 *
 * ── `userId` vem do servidor ────────────────────────────────────────
 *
 * Como em todo modulo de escrita desta area (`selecao-escrita.ts`,
 * `skills/escrita.ts`), ele e parametro explicito e a camada de cima o
 * obtem da sessao autenticada. Nunca do corpo da requisicao, nunca de
 * argumento de Funcao, nunca do modelo. As tres FKs COMPOSTAS sao
 * defesa adicional — nao substituto: elas impedem apontar para agente,
 * tarefa ou loja de outro dono, mas nao sabem se `userId` foi bem
 * obtido.
 *
 * ── Colisao nao e "ja estava assim" ─────────────────────────────────
 *
 * `23505` em `(user_id, request_id, fase)` significa que a mesma
 * tentativa foi registrada duas vezes na mesma fase — duas aberturas ou
 * duas finalizacoes concorrentes. E evento SEMANTICO e volta
 * classificado. Engoli-lo com `onConflict ignore` faria uma finalizacao
 * dupla parecer sucesso, que e o comeco de um retry que ninguem pediu.
 */
import "server-only";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";
import { truncarMensagem } from "@/lib/agentes/funcoes/sanitizar";
import {
  faseDoStatus,
  type CodigoDesfecho,
  type CodigoExecucao,
  type CodigoNegacao,
  type StatusChamada,
} from "@/lib/agentes/chamadas/contrato";

const TABELA_CHAMADAS = "agente_funcao_chamadas";

/** Unicidade de `(user_id, request_id, fase)` violada. */
const SQLSTATE_UNICO = "23505";

/** Qualquer das tres FKs compostas. As seis causas possiveis (agente,
 *  tarefa ou loja inexistente, ou qualquer das tres de outro dono)
 *  chegam INDISTINGUIVEIS de proposito: separa-las viraria um oraculo
 *  de existencia de recurso alheio. Mesmo tratamento de
 *  `definirSelecaoDeConexao`. */
const SQLSTATE_FK = "23503";

/** Constraint de dominio violada — algum CHECK da tabela. Significa bug
 *  nosso, nao situacao de negocio: a combinacao gravada nao existe no
 *  contrato. */
const SQLSTATE_CHECK = "23514";

// ─── Resultado ────────────────────────────────────────────────────────

/**
 * Estados possiveis de UMA gravacao.
 *
 * `duplicada` e separado de `falha_escrita` porque as duas pedem coisas
 * diferentes de quem chama: a primeira diz que outra execucao ja passou
 * por aqui, a segunda diz que o banco nao respondeu.
 *
 * `nao_disponivel` cobre as FKs: o agente, a tarefa ou a loja nao
 * existem, ou nao sao do dono.
 */
export interface ResultadoRegistro {
  estado: "registrada" | "duplicada" | "nao_disponivel" | "entrada_invalida" | "falha_escrita";
}

const REGISTRADA: ResultadoRegistro = Object.freeze({ estado: "registrada" as const });
const DUPLICADA: ResultadoRegistro = Object.freeze({ estado: "duplicada" as const });
const NAO_DISPONIVEL: ResultadoRegistro = Object.freeze({ estado: "nao_disponivel" as const });
const ENTRADA_INVALIDA: ResultadoRegistro = Object.freeze({ estado: "entrada_invalida" as const });
const FALHA: ResultadoRegistro = Object.freeze({ estado: "falha_escrita" as const });

// ─── Entradas ─────────────────────────────────────────────────────────

/**
 * O que toda linha carrega. Campos tipados um a um: nao existe objeto
 * de colunas e nao existe campo livre — o que chega aqui e contrato,
 * nao payload.
 */
interface BaseChamada {
  userId: string;
  agenteId: string;
  requestId: string;
  /** `null` SOMENTE quando a tentativa foi malformada. Um id
   *  bem-formado porem desconhecido e preservado. */
  funcaoId: string | null;
  tarefaId?: string | null;
  /** Snapshot. `null` quando a Funcao nao foi resolvida. */
  acesso?: "leitura" | "escrita" | null;
  /** Snapshot. `null` quando nenhum nivel foi resolvido. */
  nivelNoMomento?: "automatico" | "aprovacao" | "bloqueado" | null;
  plataforma?: string | null;
  recurso?: string | null;
  lojaId?: string | null;
  /** JA projetado por allowlist pelo chamador. Ver o docblock de
   *  `entradaResumoSegura`. */
  entradaResumo?: Record<string, string | number | boolean | null>;
}

/** Desfecho isolado: o executor nunca foi engajado. */
export interface EntradaDesfechoSemExecucao extends BaseChamada {
  status: "negado" | "aguardando_aprovacao" | "erro";
  /**
   * Os cinco de negacao, mais os DOIS codigos de execucao que podem
   * acontecer antes de o executor ser engajado:
   *
   *   entrada_invalida  o argumento nao passou na validacao da Funcao.
   *   erro_interno      uma coleta nossa falhou (permissao, conexao).
   *                     Registrar `permissao_ausente` ali mentiria sobre
   *                     a configuracao do dono.
   *
   * `executor_falhou`, `saida_invalida` e `timeout` ficam de FORA por
   * tipo: os tres descrevem uma tentativa em que o executor rodou — ou
   * pode ter rodado —, e essa so existe depois de uma abertura.
   *
   * O CHECK do banco NAO faz essa distincao: ele aceita qualquer um dos
   * cinco em `status='erro'`, com ou sem abertura. A separacao entre
   * pre e pos-execucao e invariante de TypeScript, provada pelo `tsc`.
   */
  codigo: CodigoNegacao | Extract<CodigoExecucao, "entrada_invalida" | "erro_interno">;
  mensagem?: string | null;
}

/** Abertura: a ultima coisa antes do executor. */
export interface EntradaAbertura extends BaseChamada {
  /** Obrigatoria quando `acesso === "escrita"`. O CHECK do banco cobra
   *  o mesmo, e este tipo nao consegue expressar a condicao. */
  idempotencyKey?: string | null;
}

/** Desfecho de uma execucao que teve abertura. */
export interface EntradaDesfechoDeExecucao extends BaseChamada {
  status: "sucesso" | "erro";
  codigo?: CodigoExecucao | null;
  mensagem?: string | null;
  latenciaMs?: number | null;
}

// ─── Auxiliares ───────────────────────────────────────────────────────

/** Codigo SQLSTATE do erro do PostgREST, sem tocar em `message` — a
 *  mensagem do driver vaza nome de coluna, de constraint e as vezes de
 *  VALOR, e acaba em log e em resposta HTTP. */
function codigoDe(erro: unknown): string | undefined {
  return (erro as { code?: string } | null)?.code;
}

function textoUtil(valor: unknown): valor is string {
  return typeof valor === "string" && valor.trim().length > 0;
}

/**
 * A fronteira de `entrada_resumo`, e ela e fail-closed.
 *
 * Nao existe aqui uma API que aceite objeto arbitrario e grave: o
 * chamador entrega um objeto JA projetado por allowlist — e mesmo assim
 * este modulo reprojeta, aceitando somente escalares. Duas razoes: o
 * chamador pode errar, e uma allowlist nunca pode chegar de fora
 * (modelo, request, API) sob pena de virar "permita tudo".
 *
 * Ausencia vira `{}`, que e o comportamento padrao desta fundacao
 * enquanto nao existir projetor canonico por Funcao.
 */
function entradaResumoSegura(bruto: BaseChamada["entradaResumo"]): Record<string, unknown> {
  if (bruto === undefined || bruto === null) return {};
  const destino: Record<string, string | number | boolean | null> = {};
  for (const chave of Object.keys(bruto)) {
    const valor = bruto[chave];
    if (valor === null) {
      destino[chave] = null;
      continue;
    }
    const t = typeof valor;
    if (t === "string" || t === "boolean") {
      destino[chave] = valor;
      continue;
    }
    if (t === "number" && Number.isFinite(valor)) destino[chave] = valor;
  }
  return destino;
}

/** As colunas comuns. `criado_em` fica de fora: o DEFAULT do banco e a
 *  hora real da gravacao, e um carimbo vindo do processo poderia
 *  discordar dele. */
function colunasBase(entrada: BaseChamada): Record<string, unknown> {
  return {
    user_id: entrada.userId,
    agente_id: entrada.agenteId,
    request_id: entrada.requestId,
    funcao_id: entrada.funcaoId,
    tarefa_id: entrada.tarefaId ?? null,
    acesso: entrada.acesso ?? null,
    nivel_no_momento: entrada.nivelNoMomento ?? null,
    plataforma: entrada.plataforma ?? null,
    recurso: entrada.recurso ?? null,
    loja_id: entrada.lojaId ?? null,
    entrada_resumo: entradaResumoSegura(entrada.entradaResumo),
  };
}

function identidadeValida(entrada: BaseChamada): boolean {
  return (
    textoUtil(entrada.userId) &&
    textoUtil(entrada.agenteId) &&
    textoUtil(entrada.requestId)
  );
}

/** O unico ponto que fala com o banco. Privado de proposito: a API
 *  exportada e por FORMA de linha, para que uma combinacao invalida
 *  seja difícil de escrever antes mesmo de o CHECK reprova-la. */
async function inserir(linha: Record<string, unknown>): Promise<ResultadoRegistro> {
  const r = await getSupabaseServidor().from(TABELA_CHAMADAS).insert(linha);

  if (r.error) {
    const codigo = codigoDe(r.error);

    if (codigo === SQLSTATE_UNICO) return DUPLICADA;
    if (codigo === SQLSTATE_FK) return NAO_DISPONIVEL;

    // CHECK violado e bug nosso: a combinacao gravada nao existe no
    // contrato. Merece log proprio para nao se confundir com
    // indisponibilidade do banco.
    if (codigo === SQLSTATE_CHECK) {
      console.error("[chamadas] combinacao recusada por CHECK — contrato violado no codigo");
      return FALHA;
    }

    console.error(`[chamadas] falha ao registrar (sqlstate ${codigo ?? "desconhecido"})`);
    return FALHA;
  }

  // Sem `.select()`: ausencia de erro E a prova de que a linha existe.
  return REGISTRADA;
}

// ─── API ──────────────────────────────────────────────────────────────

/**
 * Tentativa que NAO chegou ao executor.
 *
 * `negado`, `aguardando_aprovacao` e `erro/entrada_invalida`. As tres
 * nascem sem abertura, e e essa ausencia que torna a tabela honesta:
 * nenhuma linha afirma que uma Funcao rodou quando ela nao rodou.
 *
 * Nao ha `idempotencyKey` no tipo: sem efeito, nao ha o que deduplicar.
 * O CHECK `idem_so_na_abertura` cobra o mesmo do lado do banco.
 */
export async function registrarDesfechoSemExecucao(
  entrada: EntradaDesfechoSemExecucao
): Promise<ResultadoRegistro> {
  if (!identidadeValida(entrada)) return ENTRADA_INVALIDA;
  if (!textoUtil(entrada.codigo)) return ENTRADA_INVALIDA;

  return inserir({
    ...colunasBase(entrada),
    fase: faseDoStatus(entrada.status),
    status: entrada.status,
    codigo_desfecho: entrada.codigo as CodigoDesfecho,
    mensagem_desfecho: mensagemOuNull(entrada.mensagem),
    idempotency_key: null,
    latencia_ms: null,
  });
}

/**
 * A ultima coisa antes do executor.
 *
 * Depois do guard e depois da validacao dos argumentos — validar
 * localmente nao causa efeito externo, e abrir antes disso faria
 * `abertura` significar algo mais fraco que "o executor vai rodar
 * agora".
 */
export async function registrarAbertura(entrada: EntradaAbertura): Promise<ResultadoRegistro> {
  if (!identidadeValida(entrada)) return ENTRADA_INVALIDA;

  // O banco tambem cobra, e de proposito nos dois lugares: aqui a falha
  // volta classificada em vez de virar um 23514 generico.
  if (entrada.acesso === "escrita" && !textoUtil(entrada.idempotencyKey)) {
    return ENTRADA_INVALIDA;
  }

  return inserir({
    ...colunasBase(entrada),
    fase: "abertura",
    status: "executando" satisfies StatusChamada,
    codigo_desfecho: null,
    mensagem_desfecho: null,
    idempotency_key: entrada.idempotencyKey ?? null,
    latencia_ms: null,
  });
}

/**
 * O desfecho de uma execucao que teve abertura.
 *
 * A linha e NOVA. A abertura correspondente permanece intacta e
 * legivel: as duas juntas contam o que foi tentado e o que aconteceu, e
 * nenhuma reescreve a outra.
 *
 * `latenciaMs` e opcional de proposito. Nao ha produtor confiavel de
 * medicao neste gate, e um zero inventado para preencher a coluna
 * afirmaria uma medida que ninguem fez.
 */
export async function registrarDesfechoDeExecucao(
  entrada: EntradaDesfechoDeExecucao
): Promise<ResultadoRegistro> {
  if (!identidadeValida(entrada)) return ENTRADA_INVALIDA;
  if (entrada.status === "erro" && !textoUtil(entrada.codigo)) return ENTRADA_INVALIDA;
  if (entrada.status === "sucesso" && entrada.codigo != null) return ENTRADA_INVALIDA;

  const latencia = entrada.latenciaMs;
  if (latencia !== undefined && latencia !== null) {
    if (!Number.isInteger(latencia) || latencia < 0) return ENTRADA_INVALIDA;
  }

  return inserir({
    ...colunasBase(entrada),
    fase: "desfecho",
    status: entrada.status,
    codigo_desfecho: entrada.codigo ?? null,
    mensagem_desfecho: entrada.status === "sucesso" ? null : mensagemOuNull(entrada.mensagem),
    idempotency_key: null,
    latencia_ms: latencia ?? null,
  });
}

/**
 * Trunca em 300 pela mesma funcao que o resto da area usa.
 *
 * Mensagem de terceiro e superficie de vazamento: o corpo de um 404 do
 * n8n ecoa o path do webhook, e um stack traz caminho de arquivo.
 * Truncar nao sanitiza sozinho — mas limita o estrago do que passar, e
 * o CHECK do banco recusa qualquer coisa acima do limite.
 */
function mensagemOuNull(bruta: unknown): string | null {
  const texto = truncarMensagem(bruta);
  return texto.length > 0 ? texto : null;
}
