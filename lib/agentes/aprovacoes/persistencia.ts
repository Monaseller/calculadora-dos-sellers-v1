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
  /**
   * As Funcoes EXTERNAS do agente — AGENT-FACTORY-F7b.4.3.
   *
   * A MESMA costura de `executarFuncao`, e ela precisa existir aqui pelo
   * mesmo motivo: sem isto, `funcaoExiste` recusa toda acao externa e o
   * nivel `aprovacao` fica inalcancavel para elas — o guard mandaria
   * pedir aprovacao e a criacao do pedido responderia `funcao_inexistente`.
   *
   * Foi exatamente o que o teste live acusou antes desta correcao.
   *
   * `revisao` da definicao externa e a versao do catalogo do provedor, e e
   * ela que entra na impressao da acao: aprovar a versao "1" e executar a
   * "2" seria executar outra acao sob a mesma autorizacao.
   */
  definicoesExternas?: Readonly<Record<string, DefinicaoFuncao>>;
  /**
   * De onde esta aprovacao veio, quando veio de um CHAT — F7b.4.4 §6.
   *
   * Os dois andam juntos ou nenhum anda: sem `pedidoId` o dialogo nao
   * remonta, e o CHECK do banco recusa o par incompleto. Aprovacao de
   * Tarefa continua sem nada disso, e e por isso que sao opcionais.
   *
   * Nao e o cliente que os fornece: quem chama e o runtime da conversa,
   * que ja tem `conversaId` da sessao e `pedidoId` do provedor.
   */
  origem?: {
    readonly conversaId: string;
    /** O id do `tool_use`/`function_call` que ficou pendente. */
    readonly pedidoId: string;
    /** O que o modelo disse junto do pedido. `null` e comum e valido. */
    readonly textoAssistente: string | null;
  };
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
  /**
   * As Funcoes EXTERNAS do agente — F7b.4.4 §24.
   *
   * A MESMA costura de `executarFuncao` e `criarAprovacao`, e ela precisa
   * existir aqui pelo terceiro e ultimo motivo: sem ela, `funcaoExiste`
   * recusa na RETOMADA, e uma acao externa aprovada nunca executaria.
   *
   * Quem monta este mapa e `retomarTurnoAprovado`, a partir dos VINCULOS
   * de AGORA. Isso tem um efeito que vale nomear: uma ferramenta removida
   * entre a aprovacao e o clique nao esta mais no mapa, e a retomada
   * recusa. Permissao aprovada nao ressuscita ferramenta removida —
   * a mesma regra do §6, agora tambem no caminho da aprovacao.
   */
  definicoesExternas?: Readonly<Record<string, DefinicaoFuncao>>;
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

  // O registry PRIMEIRO, e o mapa de externas depois. Mesma ordem e mesmo
  // motivo de `executarFuncao`: uma externa nunca pode sombrear uma Funcao
  // da CDS.
  const externas = entrada.definicoesExternas;
  const definicaoResolvida: DefinicaoFuncao | undefined = funcaoExiste(funcaoId)
    ? FUNCOES[funcaoId]
    : externas !== undefined &&
        Object.prototype.hasOwnProperty.call(externas, funcaoId)
      ? externas[funcaoId]
      : undefined;
  if (definicaoResolvida === undefined) return { codigo: "funcao_inexistente" };

  const definicao: DefinicaoFuncao = definicaoResolvida;

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

    // ── A origem vai num UPDATE proprio, e nao dentro da RPC ────────
    //
    // A RPC de criacao carrega a deduplicacao pelo indice unico parcial e
    // a revalidacao de posse; mexer na assinatura dela para acrescentar
    // tres campos de UI arriscaria a parte que protege. O UPDATE e
    // escopado por `(id, user_id)` — o mesmo par que a RPC ja validou.
    //
    // `reutilizada` TAMBEM atualiza: a mesma acao pedida de outra conversa
    // deve retomar na conversa de AGORA, e nao naquela em que o pedido
    // nasceu. O indice unico garante que ha uma aprovacao viva so.
    //
    // Falhar aqui NAO derruba a aprovacao: ela continua valida e visivel
    // na fila de `/ia/aprovacoes`, que e exatamente o comportamento
    // anterior a este gate. A degradacao e para o estado antigo, nunca
    // para um estado pior.
    if (entrada.origem !== undefined) {
      const { error } = await getSupabaseServidor()
        .from(TABELA)
        .update({
          conversa_id: entrada.origem.conversaId,
          pedido_id: entrada.origem.pedidoId,
          texto_assistente: entrada.origem.textoAssistente,
        })
        .eq("id", id)
        .eq("user_id", userId);
      if (error) {
        // O SQLSTATE entra, a mensagem nao: o codigo diz o que aconteceu
        // sem nomear coluna nem constraint.
        console.error(
          `[aprovacoes] falha ao gravar a origem da conversa (sqlstate ${
            (error as { code?: string }).code ?? "desconhecido"})`);
      }
    }

    return { codigo, aprovacaoId: id };
  }
  return { codigo: codigo as Exclude<CodigoAprovacao, "criada" | "reutilizada"> };
}

// ─── O que a RETOMADA DE CONVERSA precisa — F7b.4.4 ──────────────────
//
// Nomes proprios de proposito. `AprovacaoParaRetomada` e
// `lerAprovacaoParaRetomada` ja existem mais abaixo e servem ao CONSUMO:
// elas carregam requisito de conexao, revisao e alvo, que e o que a RPC
// atomica revalida. O que esta secao le e outra coisa — de qual CONVERSA
// a aprovacao veio e qual pedido do modelo ficou pendente.
//
// Fundir as duas faria uma leitura carregar campos que a outra nao usa, e
// e justamente a lista curta que torna cada uma auditavel.

export interface AprovacaoDaConversa {
  readonly aprovacaoId: string;
  readonly agenteId: string;
  readonly conversaId: string;
  readonly pedidoId: string;
  readonly textoAssistente: string | null;
  readonly funcaoId: string;
  readonly argumentos: unknown;
  readonly estado: string;
}

export type ResultadoLeituraDaConversa =
  | { readonly leitura: "ok"; readonly aprovacao: AprovacaoDaConversa }
  /** Nao existe, nao e desta pessoa, ou nao veio de uma conversa. */
  | { readonly leitura: "nao_encontrada" }
  | { readonly leitura: "falha" };

/**
 * A aprovacao, para remontar o turno.
 *
 * Escopada por `user_id` na PROPRIA consulta: "nao existe" e "e de outra
 * pessoa" devolvem o mesmo resultado, pela mesma razao de sempre —
 * distingui-los seria um oraculo de existencia de recurso alheio (§23).
 *
 * `argumentos` vem da linha CONGELADA, e nao de quem chama. E isso que
 * impede trocar `funcaoId` ou argumento depois de a aprovacao existir.
 */
export async function lerAprovacaoDaConversaParaRetomada(entrada: {
  readonly userId: string;
  readonly aprovacaoId: string;
}): Promise<ResultadoLeituraDaConversa> {
  const { userId, aprovacaoId } = entrada;
  if (!userId || !aprovacaoId) return { leitura: "nao_encontrada" };

  const { data, error } = await getSupabaseServidor()
    .from(TABELA)
    .select("id, agente_id, conversa_id, pedido_id, texto_assistente, funcao_id, argumentos, estado")
    .eq("id", aprovacaoId)
    .eq("user_id", userId)
    .limit(1);

  if (error) {
    console.error("[aprovacoes] falha ao ler aprovacao para retomada");
    return { leitura: "falha" };
  }
  const linha = (data ?? [])[0] as Record<string, unknown> | undefined;
  if (linha === undefined) return { leitura: "nao_encontrada" };

  // Sem conversa nao ha turno para retomar. Aprovacao de Tarefa cai aqui,
  // e cair aqui e o certo: ela tem a fila propria dela.
  if (typeof linha.conversa_id !== "string" || typeof linha.pedido_id !== "string") {
    return { leitura: "nao_encontrada" };
  }
  if (typeof linha.agente_id !== "string" || typeof linha.funcao_id !== "string") {
    return { leitura: "falha" };
  }

  return {
    leitura: "ok",
    aprovacao: {
      aprovacaoId,
      agenteId: linha.agente_id,
      conversaId: linha.conversa_id,
      pedidoId: linha.pedido_id,
      textoAssistente:
        typeof linha.texto_assistente === "string" ? linha.texto_assistente : null,
      funcaoId: linha.funcao_id,
      argumentos: linha.argumentos,
      estado: typeof linha.estado === "string" ? linha.estado : "",
    },
  };
}

/**
 * A aprovacao ainda VIVA de uma conversa, se houver.
 *
 * E o que faz o cartao reaparecer depois de um refresh (§11): o estado
 * mora no banco, e nao na memoria da tela.
 *
 * `consumida`, `rejeitada`, `expirada` e `cancelada` nao voltam — o
 * indice parcial do banco cobre os mesmos dois estados, e as duas
 * definicoes de "viva" precisam concordar.
 */
export async function lerAprovacaoVivaDaConversa(entrada: {
  readonly userId: string;
  readonly conversaId: string;
}): Promise<
  | { readonly leitura: "ok"; readonly aprovacao: AprovacaoDaConversa | null }
  | { readonly leitura: "falha" }
> {
  const { userId, conversaId } = entrada;
  if (!userId || !conversaId) return { leitura: "ok", aprovacao: null };

  const { data, error } = await getSupabaseServidor()
    .from(TABELA)
    .select("id, agente_id, conversa_id, pedido_id, texto_assistente, funcao_id, argumentos, estado")
    .eq("user_id", userId)
    .eq("conversa_id", conversaId)
    .in("estado", ["pendente", "aprovada"])
    .order("criado_em", { ascending: false })
    .limit(1);

  if (error) {
    console.error("[aprovacoes] falha ao ler aprovacao viva da conversa");
    return { leitura: "falha" };
  }
  const linha = (data ?? [])[0] as Record<string, unknown> | undefined;
  if (linha === undefined) return { leitura: "ok", aprovacao: null };
  if (typeof linha.id !== "string" || typeof linha.pedido_id !== "string") {
    return { leitura: "falha" };
  }

  return {
    leitura: "ok",
    aprovacao: {
      aprovacaoId: linha.id,
      agenteId: String(linha.agente_id ?? ""),
      conversaId,
      pedidoId: linha.pedido_id,
      textoAssistente:
        typeof linha.texto_assistente === "string" ? linha.texto_assistente : null,
      funcaoId: String(linha.funcao_id ?? ""),
      argumentos: linha.argumentos,
      estado: typeof linha.estado === "string" ? linha.estado : "",
    },
  };
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
  /** A definicao ja resolvida — do registry OU do mapa de externas. */
  readonly definicao: DefinicaoFuncao;
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
  if (typeof funcaoId !== "string") {
    return { ok: false, codigo: "aprovacao_desatualizada", detalhe: "funcao_desconhecida" };
  }
  // O registry PRIMEIRO, e o mapa de externas depois — mesma ordem e mesmo
  // motivo dos outros dois pontos: uma externa nunca sombreia uma Funcao
  // da CDS.
  const externasAqui = entrada.definicoesExternas;
  const resolvida: DefinicaoFuncao | undefined = funcaoExiste(funcaoId)
    ? FUNCOES[funcaoId]
    : externasAqui !== undefined &&
        Object.prototype.hasOwnProperty.call(externasAqui, funcaoId)
      ? externasAqui[funcaoId]
      : undefined;
  if (resolvida === undefined) {
    // Cai aqui tambem quando a ferramenta foi REMOVIDA do agente depois de
    // a aprovacao ter sido criada. Recusar e o certo: a autorizacao era
    // para uma ferramenta que o agente nao tem mais.
    return { ok: false, codigo: "aprovacao_desatualizada", detalhe: "funcao_desconhecida" };
  }
  const definicao: DefinicaoFuncao = resolvida;

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
      // A definicao RESOLVIDA vai junto — F7b.4.4.
      //
      // Quem consome precisava dela e a buscava de novo em `FUNCOES`, o
      // que quebrava toda Funcao EXTERNA (o mapa de externas nao chega
      // la). Publicar a que ja foi conferida contra a revisao aprovada
      // elimina a segunda resolucao e a chance de as duas divergirem.
      definicao,
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
  const cliente = getSupabaseServidor();

  const requestId = randomUUID();

  const r = await cliente.rpc(RPC_CONSUMIR, {
    p_user_id: userId,
    p_aprovacao_id: aprovacaoId,
    p_request_id: requestId,
    // Do que `lerAprovacaoParaRetomada` JA resolveu, e nao de `FUNCOES`
    // outra vez. Reresolver aqui quebrava toda Funcao EXTERNA — o mapa de
    // externas nao chega a esta linha, e `FUNCOES[id]` vinha `undefined`.
    //
    // E mesmo para Funcao interna a releitura era ruim: duas resolucoes da
    // mesma definicao no mesmo fluxo podem divergir, e a que vale e a que
    // foi conferida contra a revisao aprovada logo acima.
    p_revisao_atual: ap.revisao,
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
      definicao: ap.definicao,
      acesso: ap.acesso,
      plataforma: ap.plataforma,
      recurso: ap.recurso,
      lojaId: ap.lojaId,
      nivelNoMomento,
      argumentos: ap.argumentos,
    },
  };
}
