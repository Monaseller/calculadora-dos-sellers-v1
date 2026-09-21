/**
 * A camada que fala com as aprovacoes — APPROVAL-B1B.
 *
 * ── O que este modulo e ─────────────────────────────────────────────
 *
 * A UNICA chamadora das tres RPCs de `agente_funcao_aprovacoes`. Nao ha
 * INSERT nem UPDATE direto na tabela em lugar nenhum de `lib/` ou
 * `app/`, e a suite prova isso por varredura de fonte.
 *
 * ── O que ele NAO faz ───────────────────────────────────────────────
 *
 * Nao executa Funcao. `consumirAprovacaoEAbrir` consome a aprovacao e
 * grava a abertura da Tool Call — atomicamente, dentro da RPC — e para
 * ali. Quem chama o executor e gate posterior. Nesta fase nada no
 * runtime chama estas funcoes: a fundacao nasce INERTE de proposito,
 * para que a integracao seja uma decisao visivel e nao um efeito
 * colateral.
 *
 * ── A fronteira de confianca ────────────────────────────────────────
 *
 * A API publica aceita `userId`, `agenteId`, `tarefaId?`, `funcaoId` e
 * `argumentos`. Nada mais. `revisao`, `acesso` e o requisito de conexao
 * sao DERIVADOS do catalogo aqui dentro — aceitar qualquer um deles de
 * fora seria deixar o chamador descrever a propria autorizacao, o mesmo
 * limite que `EntradaExecucaoFuncao` ja impoe.
 *
 * `userId` DEVE vir de camada server-side ja autenticada, como nas
 * rotas. Este modulo nao cria autenticacao e nao tem como verificar
 * procedencia; as FKs compostas e as revalidacoes dentro das RPCs sao
 * defesa ADICIONAL, jamais substituto.
 */
import "server-only";
import { randomUUID } from "node:crypto";

import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";
import { resolverConexoesDoAgente } from "@/lib/agentes/conexoes/agregador";
import { confirmarCoberturaDosFatos } from "@/lib/agentes/conexoes/cobertura-remota";
import { FUNCOES, funcaoExiste, type DefinicaoFuncao } from "@/lib/agentes/funcoes/registry";
import { ErroArgumentoNaoCanonico, hashDeArgumentos, impressaoDaAcao } from "@/lib/agentes/aprovacoes/identidade";

// ─── Vocabulario de retorno ───────────────────────────────────────────

/**
 * Codigos seguros. Nenhum deriva de mensagem do driver: `message`,
 * `details`, `hint` e o texto da constraint vazam nome de coluna e as
 * vezes VALOR, e acabam em log e em resposta HTTP.
 */
export type CodigoAprovacao =
  | "criada"
  | "reutilizada"
  | "aprovada"
  | "rejeitada"
  | "cancelada"
  | "consumida"
  | "ja_aprovada"
  | "ja_rejeitada"
  | "ja_cancelada"
  | "ja_consumida"
  | "aprovacao_pendente"
  | "expirada"
  | "aprovacao_inexistente"
  | "aprovacao_desatualizada"
  | "decisao_invalida"
  | "entrada_invalida"
  | "argumentos_invalidos"
  | "funcao_inexistente"
  | "agente_indisponivel"
  | "tarefa_indisponivel"
  // APPROVAL-DECISION-RESUME-D4: a decisao e elegivel, mas a tarefa causal
  // nao esta esperando por ESTA aprovacao (sumiu, mudou de status, ou o
  // ponteiro aponta para outra). Nada foi escrito — nem na aprovacao, nem
  // na tarefa. Rejeitar a aprovacao e deixar a tarefa encalhada e o defeito
  // que o D4 existe para eliminar; reproduzi-lo sob mismatch seria o mesmo
  // bug com outra roupa.
  | "tarefa_incompativel"
  | "permissao_ausente"
  | "permissao_bloqueada"
  | "permissao_nao_exige_aprovacao"
  | "conexao_indisponivel"
  | "escrita_nao_suportada"
  | "conflito_nao_resolvido"
  | "falha_persistencia";

export type ResultadoCriacao =
  | { codigo: "criada" | "reutilizada"; aprovacaoId: string }
  | { codigo: Exclude<CodigoAprovacao, "criada" | "reutilizada"> };

export type ResultadoDecisao = { codigo: CodigoAprovacao };

/**
 * O nivel que a Tool Call registrou no INSTANTE da abertura.
 *
 * Os mesmos tres de `agente_permissoes_nivel_valido`. NULL nao entra:
 * na retomada a RPC so abre depois de provar que existe nivel, entao
 * uma abertura sem ele e sinal de bug, nao de dono desconfigurado.
 */
const NIVEIS_DE_CHAMADA = ["automatico", "aprovacao", "bloqueado"] as const;
type NivelDeChamada = (typeof NIVEIS_DE_CHAMADA)[number];

/**
 * O que o executor precisa para retomar — e nada alem disso.
 *
 * Todo campo aqui nasce SERVER-SIDE: da aprovacao travada, do catalogo
 * ou da propria abertura que a RPC acabou de gravar. Quem chama a
 * retomada informa `userId` e `aprovacaoId`, e o resto e consequencia.
 *
 * Nao ha credencial, nao ha token e nao ha nada da conexao alem do alvo
 * ja congelado: resolver credencial e trabalho de quem executa a
 * Funcao, no instante em que executa.
 */
export interface ContextoRetomada {
  agenteId: string;
  tarefaId: string | null;
  funcaoId: string;
  definicao: DefinicaoFuncao;
  acesso: "leitura" | "escrita";
  plataforma: string | null;
  recurso: string | null;
  lojaId: string | null;
  /** Lido da linha de abertura, nunca recalculado. Ver `lerNivelDaAbertura`. */
  nivelNoMomento: NivelDeChamada;
  /** O snapshot congelado na criacao. Nunca vem de quem retoma. */
  argumentos: unknown;
}

/**
 * `abertura_ilegivel` NAO e estado de aprovacao — e por isso que ele
 * fica FORA de `CodigoAprovacao`.
 *
 * Ele descreve o unico ponto em que a retomada pode falhar DEPOIS do
 * consumo: a RPC gravou a abertura e nao conseguimos le-la de volta.
 * A aprovacao ja foi gasta e a chamada ja esta aberta, entao o
 * `requestId` vem junto — sem ele quem investiga nao acha a linha orfa.
 */
export type ResultadoConsumo =
  | { codigo: "consumida"; requestId: string; contexto: ContextoRetomada }
  | { codigo: "abertura_ilegivel"; requestId: string }
  | { codigo: Exclude<CodigoAprovacao, "consumida"> };

// ─── Entradas publicas ────────────────────────────────────────────────

export interface EntradaCriarAprovacao {
  userId: string;
  agenteId: string;
  tarefaId?: string | null;
  funcaoId: string;
  argumentos: unknown;
}

export interface EntradaDecidirAprovacao {
  userId: string;
  aprovacaoId: string;
  decisao: "aprovar" | "rejeitar" | "cancelar";
  motivo?: string | null;
}

export interface EntradaConsumirAprovacao {
  userId: string;
  aprovacaoId: string;
}

// ─── Auxiliares ───────────────────────────────────────────────────────

const TABELA = "agente_funcao_aprovacoes";

/** Lida SOMENTE por select, e so na retomada. Quem grava nesta tabela
 *  continua sendo `chamadas/registro.ts` no TypeScript e a RPC de
 *  consumo no banco — este modulo nao insere, nao atualiza, nao apaga. */
const TABELA_CHAMADAS = "agente_funcao_chamadas";

const RPC_CRIAR = "aprovacao_criar";
const RPC_DECIDIR = "aprovacao_decidir";
const RPC_CONSUMIR = "aprovacao_consumir_e_abrir";

/**
 * Um fato de conexao SERVE quando esta conectada e a cobertura foi
 * confirmada.
 *
 * ── Duplicacao declarada ────────────────────────────────────────────
 *
 * A autoridade desta regra e `conexaoServe`, em
 * `lib/agentes/funcoes/guard.ts` — que e privada ao modulo. Repeti-la
 * aqui cria um segundo lugar que precisa concordar para sempre, e este
 * repositorio ja pagou por divergencias assim. A mitigacao e um assert
 * nominal na suite comparando os dois predicados termo a termo: a
 * duplicacao fica CONFERIDA, nao silenciosa.
 *
 * Consequencia conhecida e herdada do guard: `coberturaDoRecurso()`
 * devolve HOJE `nao_verificavel` para todo recurso, entao nenhuma Funcao
 * com requisito de conexao passa por aqui. `vendas.consultar` nao e
 * afetada — `conexaoNecessaria` e `null`.
 */
function conexaoServe(fato: { estado: string; cobertura: string }): boolean {
  return fato.estado === "conectada" && fato.cobertura === "confirmada";
}

/** Erro do driver vira codigo seguro. O SQLSTATE pode ir para o log do
 *  servidor — a mensagem, nunca. Mesmo padrao de `chamadas/registro.ts`. */
function logarFalha(origem: string, erro: unknown): void {
  const sqlstate = (erro as { code?: string } | null)?.code;
  console.error(`[aprovacoes] ${origem} falhou (sqlstate ${sqlstate ?? "desconhecido"})`);
}

function falha(origem: string, erro: unknown): { codigo: "falha_persistencia" } {
  logarFalha(origem, erro);
  return { codigo: "falha_persistencia" };
}

/** O retorno das RPCs e um codigo fechado; qualquer outra coisa e bug
 *  nosso, e vira falha em vez de virar sucesso por omissao. */
function comoCodigo(bruto: unknown): CodigoAprovacao | null {
  return typeof bruto === "string" && bruto.length > 0 ? (bruto as CodigoAprovacao) : null;
}

interface AlvoConexao {
  plataforma: string | null;
  recurso: string | null;
  lojaId: string | null;
}

const SEM_CONEXAO: AlvoConexao = Object.freeze({ plataforma: null, recurso: null, lojaId: null });

/**
 * Resolve o alvo concreto de conexao para o requisito de uma Funcao.
 *
 * ── UMA leitura, e uma autoridade so ────────────────────────────────
 *
 * Ate a M2-I1 esta funcao fazia duas: `resolverConexoesDoAgente` para
 * "esta conexao esta utilizavel?" e `resolverSelecoesDoAgente` para
 * "qual loja o dono escolheu?". A segunda saiu quando o agregador passou
 * a publicar `bindings`.
 *
 * O motivo nao foi custo — foi CORRECAO. A selecao crua responde qual
 * loja o dono apontou, e nada mais: `agente_conexoes` nao tem invariante
 * de banco ligando `plataforma` ao marketplace da loja, entao a linha
 * `(mercado_livre, perguntas, <loja Shopee do mesmo dono>)` e
 * estruturalmente possivel e sai de la como selecao valida. Ler o
 * `lojaId` dali dava ao congelamento da aprovacao uma conta que a camada
 * de fatos ja havia recusado, e criava duas verdades sobre a mesma
 * pergunta. O binding ja nasce reconciliado com o fato.
 *
 * Sem fallback: seleção ausente para o par exigido nao vira "escolhe
 * outra qualquer", e selecao de outro provedor nao vira nada.
 */
async function resolverAlvo(
  userId: string,
  agenteId: string,
  requisito: { plataforma: string; recurso: string },
  acesso: "leitura" | "escrita"
): Promise<AlvoConexao | { codigo: "conexao_indisponivel" }> {
  const resolvido = await resolverConexoesDoAgente({ userId, agenteId, agoraMs: Date.now() });
  if (resolvido.coleta !== "ok") return { codigo: "conexao_indisponivel" };

  // O BINDING primeiro, e o fato depois. A ordem importa: sem vinculo
  // escolhido nao ha o que avaliar, e perguntar "a conta serve?" antes de
  // saber se existe conta escolhida e a pergunta na ordem errada — ela
  // custaria trabalho para responder sobre algo que ninguem configurou.
  const binding = resolvido.bindings.find(
    (b) => b.plataforma === requisito.plataforma && b.recurso === requisito.recurso
  );
  if (binding === undefined) return { codigo: "conexao_indisponivel" };

  // A cobertura REMOTA entra entre o binding e o `conexaoServe`, e a
  // ordem e o ponto: sem binding nao ha conta contra a qual provar, e
  // perguntar ao Mercado Livre antes disso gastaria rede para descobrir
  // algo que a selecao ja respondia. Ver `cobertura-remota.ts`.
  const elevados = await confirmarCoberturaDosFatos({
    userId,
    requisito,
    lojaId: binding.lojaId,
    acesso,
    conexoes: resolvido.conexoes,
  });

  const fato = elevados.conexoes.find(
    (c) => c.plataforma === requisito.plataforma && c.recurso === requisito.recurso
  );
  if (!fato || !conexaoServe(fato)) return { codigo: "conexao_indisponivel" };

  return { plataforma: requisito.plataforma, recurso: requisito.recurso, lojaId: binding.lojaId };
}

/**
 * O nivel do instante, lido da ABERTURA — nunca recalculado.
 *
 * ── Por que nao reler `agente_permissoes` ───────────────────────────
 *
 * A RPC de consumo resolve o nivel DENTRO da transacao e o grava na
 * abertura. Reler a permissao aqui seria uma segunda leitura, em outro
 * instante, que pode discordar da primeira — e o desfecho passaria a
 * afirmar sobre a chamada um nivel diferente do que a abertura dela
 * afirma. As duas linhas do mesmo `request_id` contam UMA historia.
 *
 * A abertura e a autoridade porque e o registro do instante. Ela nao
 * decide nada — nao autoriza, nao libera, nao muda caminho —, so e
 * espelhada no desfecho que a acompanha.
 *
 * Sem fallback: nivel ausente, valor fora do vocabulario, erro de
 * leitura ou linha nao encontrada devolvem `null`, e quem chama para.
 * Preencher um nivel plausivel aqui seria inventar o unico dado que
 * esta funcao existe para nao inventar.
 */
async function lerNivelDaAbertura(
  cliente: ReturnType<typeof getSupabaseServidor>,
  userId: string,
  requestId: string
): Promise<NivelDeChamada | null> {
  // `maybeSingle` tambem recusa resultado ambiguo: mais de uma linha
  // volta como erro em vez de virar "a primeira serve".
  const r = await cliente
    .from(TABELA_CHAMADAS)
    .select("nivel_no_momento")
    .eq("user_id", userId)
    .eq("request_id", requestId)
    .eq("fase", "abertura")
    .maybeSingle();

  if (r.error) {
    logarFalha("leitura_abertura", r.error);
    return null;
  }

  const bruto = (r.data as { nivel_no_momento?: unknown } | null)?.nivel_no_momento;
  return (NIVEIS_DE_CHAMADA as readonly unknown[]).includes(bruto)
    ? (bruto as NivelDeChamada)
    : null;
}

// ─── Criar ────────────────────────────────────────────────────────────

/**
 * Cria — ou reencontra — o pedido de aprovacao de uma acao concreta.
 *
 * A ordem importa: o argumento e validado pela propria Funcao ANTES de
 * virar snapshot, porque congelar um argumento invalido produziria uma
 * aprovacao que nunca poderia ser consumida.
 */
export async function criarAprovacao(entrada: EntradaCriarAprovacao): Promise<ResultadoCriacao> {
  const { userId, agenteId, funcaoId, argumentos } = entrada;
  const tarefaId = entrada.tarefaId ?? null;

  if (!userId || !agenteId || !funcaoId) return { codigo: "entrada_invalida" };
  if (!funcaoExiste(funcaoId)) return { codigo: "funcao_inexistente" };

  const definicao: DefinicaoFuncao = FUNCOES[funcaoId];

  let validacao;
  try {
    validacao = definicao.validarEntrada(argumentos);
  } catch {
    // O contrato diz que o validador nao lanca. Se lancar, e bug nosso —
    // nao prova de que o argumento estava errado.
    return { codigo: "falha_persistencia" };
  }
  if (!validacao.valida) return { codigo: "argumentos_invalidos" };

  let argumentosHash: string;
  try {
    argumentosHash = hashDeArgumentos(argumentos);
  } catch (e) {
    if (e instanceof ErroArgumentoNaoCanonico) return { codigo: "argumentos_invalidos" };
    throw e;
  }

  let alvo: AlvoConexao = SEM_CONEXAO;
  const requisito = definicao.conexaoNecessaria;
  if (requisito !== null) {
    const resolvido = await resolverAlvo(userId, agenteId, requisito, definicao.acesso);
    if ("codigo" in resolvido) return { codigo: resolvido.codigo };
    alvo = resolvido;
  }

  const fingerprint = impressaoDaAcao({
    userId,
    agenteId,
    tarefaId,
    funcaoId,
    revisaoFuncao: definicao.revisao,
    conexaoLojaId: alvo.lojaId,
    argumentosHash,
  });

  const r = await getSupabaseServidor().rpc(RPC_CRIAR, {
    p_user_id: userId,
    p_agente_id: agenteId,
    p_tarefa_id: tarefaId,
    p_funcao_id: funcaoId,
    p_revisao_funcao: definicao.revisao,
    p_acesso: definicao.acesso,
    p_conexao_plataforma: alvo.plataforma,
    p_conexao_recurso: alvo.recurso,
    p_conexao_loja_id: alvo.lojaId,
    p_argumentos: argumentos,
    p_argumentos_hash: argumentosHash,
    p_fingerprint: fingerprint,
  });

  if (r.error) return falha(RPC_CRIAR, r.error);

  const linha = Array.isArray(r.data) ? r.data[0] : r.data;
  const codigo = comoCodigo((linha as { resultado?: unknown } | null)?.resultado);
  const id = (linha as { id?: unknown } | null)?.id;

  if (codigo === null) return { codigo: "falha_persistencia" };
  if (codigo === "criada" || codigo === "reutilizada") {
    if (typeof id !== "string" || id.length === 0) return { codigo: "falha_persistencia" };
    return { codigo, aprovacaoId: id };
  }
  return { codigo: codigo as Exclude<CodigoAprovacao, "criada" | "reutilizada"> };
}

// ─── Decidir ──────────────────────────────────────────────────────────

/**
 * Registra a decisao humana. `decidido_por` nao e parametro: a RPC o
 * deriva de `p_user_id`, entao nao existe caminho para registrar um
 * decisor diferente do dono autenticado.
 *
 * Decidir NAO executa e NAO consome. Se a execucao falhar depois, a
 * decisao permanece gravada e a aprovacao continua retomavel ate
 * expirar.
 */
export async function decidirAprovacao(entrada: EntradaDecidirAprovacao): Promise<ResultadoDecisao> {
  const { userId, aprovacaoId, decisao } = entrada;

  if (!userId || !aprovacaoId) return { codigo: "entrada_invalida" };
  if (decisao !== "aprovar" && decisao !== "rejeitar" && decisao !== "cancelar") {
    return { codigo: "decisao_invalida" };
  }

  const r = await getSupabaseServidor().rpc(RPC_DECIDIR, {
    p_user_id: userId,
    p_aprovacao_id: aprovacaoId,
    p_decisao: decisao,
    p_motivo: entrada.motivo ?? null,
  });

  if (r.error) return falha(RPC_DECIDIR, r.error);

  const codigo = comoCodigo(r.data);
  return { codigo: codigo ?? "falha_persistencia" };
}

// ─── Pre-leitura da aprovacao — FONTE UNICA das duas lanes ─────

/**
 * A aprovacao congelada, ja conferida contra o catalogo.
 *
 * ── O que NAO esta aqui, e por que ─────────────────────────
 *
 * `DefinicaoFuncao` nao viaja: quem executa resolve do catalogo, e
 * entregar a definicao aqui deixaria o chamador escolher qual delas
 * usar. `nivelNoMomento` tambem nao: ele nasce na ABERTURA, que ainda
 * nao existe quando esta leitura acontece — devolve-lo seria inventar
 * o unico dado que a lane de retomada existe para ler de volta. E o
 * cliente Supabase fica dentro: expo-lo daria a capacidade generica de
 * consultar qualquer tabela com o papel mais privilegiado do projeto.
 *
 * `plataforma`, `recurso` e `acesso` saem do CATALOGO, nao da linha —
 * os tres ja foram provados iguais antes de chegar aqui, e a definicao
 * e a autoridade do requisito.
 */
export interface AprovacaoParaRetomada {
  readonly agenteId: string;
  readonly tarefaId: string | null;
  readonly funcaoId: string;
  readonly acesso: "leitura" | "escrita";
  readonly plataforma: string | null;
  readonly recurso: string | null;
  readonly lojaId: string | null;
  readonly argumentos: unknown;
  readonly revisao: string;
}

/**
 * O motivo FINO da recusa.
 *
 * Existe porque `CodigoAprovacao` colapsa cinco causas distintas em
 * `aprovacao_desatualizada`, e o caminho generico DEPENDE desse
 * colapso — mudar o codigo publico mudaria o contrato dele. A lane de
 * retomada precisa da granularidade para dizer, no retorno, o que
 * exatamente impediu o inicio. Os dois viajam juntos: `codigo` e o
 * contrato publico, `detalhe` e o diagnostico.
 */
export type DetalheRecusaAprovacao =
  | "entrada_invalida"
  | "leitura_indisponivel"
  | "inexistente"
  | "identidade_invalida"
  | "funcao_desconhecida"
  | "revisao_divergente"
  | "acesso_divergente"
  | "conexao_divergente"
  | "argumentos_invalidos"
  | "conexao_indisponivel";

export type ResultadoAprovacaoParaRetomada =
  | { readonly ok: true; readonly aprovacao: AprovacaoParaRetomada }
  | {
      readonly ok: false;
      readonly codigo: Exclude<CodigoAprovacao, "consumida">;
      readonly detalhe: DetalheRecusaAprovacao;
    };

/**
 * Le a aprovacao e prova, contra o catalogo, que ela ainda descreve a
 * MESMA acao que o humano aprovou. Nao muta nada.
 *
 * ── Uma fonte, dois consumidores ────────────────────────
 *
 * Este corpo era o inicio de `consumirAprovacaoEAbrir`. Ele saiu de la
 * por EXTRACAO, sem mudar a ordem das recusas nem o codigo devolvido, e
 * aquela funcao passou a chama-lo. A lane de retomada precisa
 * exatamente destas provas ANTES de gerar o `request_id`, e copia-las
 * criaria duas listas de colunas e duas sequencias de igualdade que
 * teriam de concordar para sempre.
 *
 * A ORDEM das recusas e contrato, nao estilo: recusar conexao antes de
 * revisao mudaria qual codigo o chamador de hoje recebe.
 */
export async function lerAprovacaoParaRetomada(
  entrada: EntradaConsumirAprovacao
): Promise<ResultadoAprovacaoParaRetomada> {
  const { userId, aprovacaoId } = entrada;
  if (!userId || !aprovacaoId) {
    return { ok: false, codigo: "entrada_invalida", detalhe: "entrada_invalida" };
  }

  const leitura = await getSupabaseServidor()
    .from(TABELA)
    .select("id, funcao_id, revisao_funcao, acesso, conexao_plataforma, conexao_recurso, conexao_loja_id, argumentos, agente_id, tarefa_id")
    .eq("id", aprovacaoId)
    .eq("user_id", userId)
    .maybeSingle();

  if (leitura.error) {
    logarFalha("leitura_aprovacao", leitura.error);
    return { ok: false, codigo: "falha_persistencia", detalhe: "leitura_indisponivel" };
  }

  const ap = leitura.data as {
    funcao_id?: unknown;
    revisao_funcao?: unknown;
    acesso?: unknown;
    conexao_plataforma?: unknown;
    conexao_recurso?: unknown;
    conexao_loja_id?: unknown;
    argumentos?: unknown;
    agente_id?: unknown;
    tarefa_id?: unknown;
  } | null;

  // Inexistente e de outro dono chegam iguais, porque o filtro ja
  // escopou por `user_id`.
  if (!ap) return { ok: false, codigo: "aprovacao_inexistente", detalhe: "inexistente" };

  // Forma das colunas de identidade. Elas sao NOT NULL / uuid no banco,
  // entao um valor fora da forma e bug nosso — nao situacao de negocio —
  // e vira falha em vez de virar `null` por interpretacao.
  const agenteId = ap.agente_id;
  if (typeof agenteId !== "string" || agenteId.length === 0) {
    return { ok: false, codigo: "falha_persistencia", detalhe: "identidade_invalida" };
  }

  const tarefaId = ap.tarefa_id ?? null;
  if (tarefaId !== null && typeof tarefaId !== "string") {
    return { ok: false, codigo: "falha_persistencia", detalhe: "identidade_invalida" };
  }

  const lojaId = ap.conexao_loja_id ?? null;
  if (lojaId !== null && typeof lojaId !== "string") {
    return { ok: false, codigo: "falha_persistencia", detalhe: "identidade_invalida" };
  }

  const funcaoId = ap.funcao_id;
  if (typeof funcaoId !== "string" || !funcaoExiste(funcaoId)) {
    return { ok: false, codigo: "aprovacao_desatualizada", detalhe: "funcao_desconhecida" };
  }
  const definicao: DefinicaoFuncao = FUNCOES[funcaoId];

  // A definicao precisa ser a MESMA que o humano aprovou.
  if (ap.revisao_funcao !== definicao.revisao) {
    return { ok: false, codigo: "aprovacao_desatualizada", detalhe: "revisao_divergente" };
  }

  // Defensivo: `acesso` e o requisito de conexao sao versionados pela
  // revisao, entao divergirem com a mesma revisao significa que alguem
  // mudou a definicao sem bump. Recusar e o unico caminho honesto.
  if (ap.acesso !== definicao.acesso) {
    return { ok: false, codigo: "aprovacao_desatualizada", detalhe: "acesso_divergente" };
  }

  const requisito = definicao.conexaoNecessaria;
  const platEsperada = requisito === null ? null : requisito.plataforma;
  const recEsperado = requisito === null ? null : requisito.recurso;
  if (ap.conexao_plataforma !== platEsperada || ap.conexao_recurso !== recEsperado) {
    return { ok: false, codigo: "aprovacao_desatualizada", detalhe: "conexao_divergente" };
  }

  // O argumento congelado precisa continuar valido para a definicao
  // atual. Nao adaptar, nao normalizar: recusar.
  let validacao;
  try {
    validacao = definicao.validarEntrada(ap.argumentos);
  } catch {
    return { ok: false, codigo: "falha_persistencia", detalhe: "argumentos_invalidos" };
  }
  if (!validacao.valida) {
    return { ok: false, codigo: "aprovacao_desatualizada", detalhe: "argumentos_invalidos" };
  }

  // A conexao precisa estar utilizavel AGORA, e apontando para a MESMA
  // loja congelada. A RPC reconfirma o vinculo atomicamente; aqui o que
  // se prova e a usabilidade, que o banco nao sabe julgar.
  if (requisito !== null) {
    const alvo = await resolverAlvo(userId, agenteId, requisito, definicao.acesso);
    if ("codigo" in alvo) {
      return { ok: false, codigo: alvo.codigo, detalhe: "conexao_indisponivel" };
    }
    if (alvo.lojaId !== lojaId) {
      return { ok: false, codigo: "conexao_indisponivel", detalhe: "conexao_indisponivel" };
    }
  }

  return {
    ok: true,
    aprovacao: {
      agenteId,
      tarefaId,
      funcaoId,
      acesso: definicao.acesso,
      // Do CATALOGO, nao da linha: os dois ja foram provados iguais
      // acima, e a definicao e a autoridade do requisito.
      plataforma: platEsperada,
      recurso: recEsperado,
      lojaId,
      argumentos: ap.argumentos,
      revisao: definicao.revisao,
    },
  };
}

/**
 * O nivel da abertura, para quem NAO tem cliente Supabase na mao.
 *
 * `lerNivelDaAbertura` continua privada e continua recebendo o cliente:
 * ela e chamada DENTRO do consumo, com o mesmo cliente daquele fluxo.
 * Este invólucro existe para a lane de retomada, que abre a chamada por
 * OUTRA RPC e precisa ler a mesma linha depois — e que nao pode receber
 * o cliente, porque isso lhe daria a capacidade generica de consultar
 * qualquer tabela com o papel mais privilegiado do projeto.
 *
 * Os filtros sao os mesmos: `user_id`, `request_id` e `fase`. NAO ha
 * filtro de `status`: `unique (user_id, request_id, fase)` ja e a
 * identidade da linha, e exigir `executando` faria uma abertura ja
 * desfechada parecer inexistente.
 */
export async function lerNivelDaAberturaDeRetomada(
  userId: string,
  requestId: string
): Promise<"automatico" | "aprovacao" | "bloqueado" | null> {
  if (!userId || !requestId) return null;
  return lerNivelDaAbertura(getSupabaseServidor(), userId, requestId);
}

// ─── Consumir ─────────────────────────────────────────────────────────

/**
 * Consome a aprovacao e abre a Tool Call, atomicamente.
 *
 * ── Por que revalidar em TypeScript se a RPC tambem revalida ────────
 *
 * As duas camadas provam coisas diferentes. A RPC nao conhece o catalogo
 * TypeScript: ela nao sabe a revisao atual da definicao, nao sabe rodar
 * `validarEntrada` e nao sabe julgar se uma conexao esta utilizavel. A
 * aplicacao sabe tudo isso e nao sabe travar linha nem garantir
 * atomicidade. Nenhuma substitui a outra.
 *
 * `requestId` nasce AQUI, com `randomUUID()`, e nao e parametro publico:
 * quem chama nao escolhe a correlacao. Ele so e devolvido se o consumo
 * realmente aconteceu.
 */
export async function consumirAprovacaoEAbrir(
  entrada: EntradaConsumirAprovacao
): Promise<ResultadoConsumo> {
  const { userId, aprovacaoId } = entrada;

  // As provas locais vivem em `lerAprovacaoParaRetomada`, que este
  // caminho e a lane de retomada COMPARTILHAM. `detalhe` nao e lido
  // aqui: o contrato publico desta funcao e `codigo`, e traduzi-lo
  // mudaria o que os chamadores de hoje recebem.
  const pre = await lerAprovacaoParaRetomada(entrada);
  if (!pre.ok) return { codigo: pre.codigo };

  const ap = pre.aprovacao;
  const definicao: DefinicaoFuncao = FUNCOES[ap.funcaoId];
  const cliente = getSupabaseServidor();

  const requestId = randomUUID();

  const r = await cliente.rpc(RPC_CONSUMIR, {
    p_user_id: userId,
    p_aprovacao_id: aprovacaoId,
    p_request_id: requestId,
    p_revisao_atual: definicao.revisao,
  });

  if (r.error) return falha(RPC_CONSUMIR, r.error);

  const codigo = comoCodigo(r.data);
  if (codigo === null) return { codigo: "falha_persistencia" };
  if (codigo !== "consumida") return { codigo: codigo as Exclude<CodigoAprovacao, "consumida"> };

  // ── Daqui para baixo a aprovacao JA foi gasta ─────────────────────
  //
  // O `requestId` deixa de ser um id que propusemos e passa a ser o da
  // chamada aberta pela RPC. Ele so aparece no retorno a partir deste
  // ponto, e por isso: antes do consumo nao existe chamada nenhuma para
  // ele nomear.
  const nivelNoMomento = await lerNivelDaAbertura(cliente, userId, requestId);
  if (nivelNoMomento === null) return { codigo: "abertura_ilegivel", requestId };

  return {
    codigo,
    requestId,
    contexto: {
      agenteId: ap.agenteId,
      tarefaId: ap.tarefaId,
      funcaoId: ap.funcaoId,
      definicao,
      acesso: ap.acesso,
      plataforma: ap.plataforma,
      recurso: ap.recurso,
      lojaId: ap.lojaId,
      nivelNoMomento,
      argumentos: ap.argumentos,
    },
  };
}
