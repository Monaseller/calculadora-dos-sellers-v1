/**
 * O executor de Funcoes — TOOL-EXEC-B.
 *
 * ── A pergunta que este modulo responde ─────────────────────────────
 *
 *   "Este agente pode executar esta Funcao agora, e o que aconteceu?"
 *
 * Ele e o primeiro consumidor de producao do catalogo, do guard e da
 * auditoria append-only: ate aqui as tres pecas existiam publicadas e
 * INERTES, sem ninguem que as ligasse.
 *
 * ── A janela que ele existe para fechar ─────────────────────────────
 *
 * Uma Funcao pode produzir efeito FORA da CDS. Registrar depois de
 * executar deixaria uma janela em que o efeito acontece e ninguem sabe.
 * Por isso a ABERTURA e gravada antes da chamada, e ela significa uma
 * coisa exata e verificavel: o executor vai ser chamado AGORA. Tudo que
 * pode recusar a tentativa — posse, catalogo, permissao, conexao, guard,
 * argumentos — acontece antes dela.
 *
 * ── Por que nao ha `if (funcaoId === ...)` em lugar nenhum ──────────
 *
 * Um `switch` por Tool faria deste arquivo uma segunda registry de
 * comportamento, e a existencia de uma Funcao voltaria a ser algo que
 * alguem escreve em dois lugares. Tudo que e especifico de uma Funcao
 * — validar o argumento, executar, ler o resultado — mora na
 * `DefinicaoFuncao` dela. Este modulo so orquestra.
 *
 * Foi exatamente esse limite que interrompeu a primeira tentativa desta
 * frente: `vendas.consultar` sinaliza falha POR VALOR
 * (`{ erro: "erro_consulta_vendas" }`), e sem `interpretarSaida` o
 * executor generico chamaria isso de sucesso. O contrato nasceu daquela
 * parada.
 *
 * ── O que este modulo NAO faz ───────────────────────────────────────
 *
 * Nao expoe endpoint, nao fala com n8n nem com marketplace, nao tem
 * `fetch`, nao faz retry, nao faz replay, nao recupera abertura orfa,
 * nao aplica timeout, nao toca `agente_tarefas` e nao persiste a saida
 * da Funcao. Cada um desses e gate proprio.
 *
 * ── Sem porta de injecao ────────────────────────────────────────────
 *
 * A assinatura publica e `executarFuncao(entrada)` e nada mais. Nao ha
 * segundo parametro de dependencias, nao ha `skipGuard`, nao ha registry
 * substituivel. Quem chama nao escolhe quem decide. As suites provam o
 * caminho por interceptacao de modulo NO HARNESS — o mesmo mecanismo de
 * `scripts/_server-only-inerte.ts` —, sem que producao ganhe uma
 * fresta.
 */
import "server-only";
import { randomUUID } from "node:crypto";
import type { ControleDeTempo } from "@/lib/controle-tempo";

import { lerAgenteDoDono, lerTarefaDoDono } from "@/lib/agentes/capability";
import { resolverConexoesDoAgente } from "@/lib/agentes/conexoes/agregador";
import { confirmarCoberturaDosFatos } from "@/lib/agentes/conexoes/cobertura-remota";
import {
  envelopeValido,
  VERSAO_CONTRATO,
  type EnvelopeErro,
  type EnvelopeSucesso,
} from "@/lib/agentes/chamadas/contrato";
import {
  registrarAbertura,
  registrarDesfechoDeExecucao,
  registrarDesfechoSemExecucao,
  type EntradaDesfechoDeExecucao,
  type EntradaDesfechoSemExecucao,
} from "@/lib/agentes/chamadas/registro";
import {
  consumirAprovacaoEAbrir,
  criarAprovacao,
  type CodigoAprovacao,
} from "@/lib/agentes/aprovacoes/persistencia";
import { autorizarFuncao, type CodigoNegacao } from "@/lib/agentes/funcoes/guard";
import {
  FUNCOES,
  funcaoExiste,
  type ContextoFuncao,
  type DefinicaoFuncao,
} from "@/lib/agentes/funcoes/registry";
import { resolverFatosPermissoes } from "@/lib/agentes/permissoes/fatos";
import type { FatoConexao, FatoPermissao } from "@/lib/ia/skills/diagnostico";

// ─── Vocabulario ──────────────────────────────────────────────────────

/**
 * As negacoes que ENCERRAM a tentativa.
 *
 * Derivado de `CodigoNegacao`, nunca recopiado: `aprovacao_necessaria`
 * sai porque ela nao encerra nada — alguem pode aprovar, e o resultado
 * publico dela e variante propria. O guard continua tratando as cinco
 * como negativas, que e correto para ele; a diferenca e para quem le
 * depois, e o banco ja a impoe (`negado` recusa `aprovacao_necessaria`).
 */
export type CodigoNegacaoTerminal = Exclude<CodigoNegacao, "aprovacao_necessaria">;

/**
 * A forma canonica de um id de Funcao — a MESMA de
 * `agente_permissoes_funcao_id_formato` e do CHECK da auditoria. Uma
 * quarta forma obrigaria traducao, e traducao entre autoridades e onde
 * erro de escopo se esconde.
 */
const FORMA_FUNCAO_ID = /^[a-z0-9]+(\.[a-z0-9_]+)+$/;

/**
 * Entrada publica. A lista curta e a defesa.
 *
 * NAO ha `requestId`, `acesso`, `idempotente`, `conexaoNecessaria`,
 * `nivel`, nem snapshot de permissao ou de conexao. Todos eles sao
 * resolvidos aqui dentro, do catalogo e do banco — aceitar qualquer um
 * de fora seria deixar o chamador descrever a propria autorizacao.
 *
 * `lojaId`, `plataforma` e `recurso` tambem nao entram: qual conta
 * atende um requisito e decisao de quem resolve a conexao do agente.
 *
 * `userId` DEVE vir de uma camada server-side ja autenticada — o
 * precedente e `autenticarRequisicao` nas rotas. Nunca do corpo da
 * requisicao, nunca de argumento de Funcao, nunca do modelo. Este
 * modulo nao cria autenticacao nova e nao tem como verificar a
 * procedencia: as FKs compostas da auditoria sao defesa ADICIONAL,
 * jamais substituto.
 */
export interface EntradaExecucaoFuncao {
  userId: string;
  agenteId: string;
  /**
   * O controle de tempo da ACAO — OPCIONAL e INTERNO. I4B3.
   *
   * Quem nao o passa se comporta exatamente como antes: sem limite
   * compartilhado, cada chamada externa usa o teto proprio dela e as
   * idas ao banco nao sao canceladas por ninguem.
   *
   * Ele NAO vem da rota, do n8n nem dos argumentos — e criado por quem
   * orquestra a acao. Os dois relogios servem a coisas diferentes: o do
   * provider corta o marketplace, o rigido corta a acao inteira. Cortar
   * o marketplace NAO pode cancelar a auditoria que explica o corte, e e
   * por isso que sao dois.
   */
  controleTempo?: ControleDeTempo;
  tarefaId?: string | null;
  funcaoId: unknown;
  argumentos: unknown;
  /**
   * Chave de deduplicacao da ABERTURA - M2-I1-A8.
   *
   * OPCIONAL, e os callers anteriores seguem omitindo: sem ela o
   * comportamento e exatamente o de antes, que era passar `null`.
   *
   * Quem a fornece e quem sabe o que conta como `a mesma chamada` na
   * camada dele. O executor nao deriva chave nenhuma: derivar aqui
   * exigiria conhecer a semantica do chamador, e ela muda por caminho.
   *
   * O banco ja a cobrava em ESCRITA e sempre a aceitou em LEITURA - o
   * indice unico parcial passa a valer assim que ela existe.
   */
  idempotencyKey?: string | null;
}

/**
 * O resultado publico. Sete variantes, e cada uma espelha um estado
 * persistido — ou a ausencia deliberada dele.
 *
 * ── Por que `aprovacao_indisponivel` e variante propria ─────────────
 *
 * Ela cobre a retomada que NAO aconteceu: aprovacao vencida, rejeitada,
 * cancelada, ja consumida, desatualizada, ou autoridade que mudou
 * durante a espera. Nenhuma dessas e negacao do guard — o guard nem
 * roda na retomada — e nenhuma e falha da Funcao, que nunca foi
 * chamada. Enfia-las em `negado` ou `erro` obrigaria a inventar um
 * codigo que o vocabulario daquelas variantes nao tem, e a devolver
 * `auditoria` sobre uma linha que ninguem tentou gravar.
 *
 * Ela tambem e a unica que NAO grava nada: na retomada recusada nao ha
 * chamada aberta para explicar, e a propria aprovacao ja e o registro
 * do que aconteceu.
 *
 * `erro` e falha da TOOL; `falha_auditoria` e falha da nossa
 * infraestrutura de registro. Colapsar as duas faria o chamador tratar
 * "a consulta falhou" e "nao consegui registrar o que fiz" como a mesma
 * coisa, e a segunda e a unica que pede intervencao humana.
 *
 * ── Por que `erro` TAMBEM carrega `auditoria` ───────────────────────
 *
 * As duas coisas podem falhar na mesma tentativa: a Funcao falha E o
 * desfecho nao grava. Um `erro` sem esse campo obrigaria o chamador a
 * supor que a linha foi escrita, e o achado A1 do TOOL-EXEC-R1 mostrou
 * a consequencia: um erro de dominio com `retryable: true` cujo
 * desfecho se perdeu convidaria a repetir um efeito possivelmente
 * ocorrido, no dia em que escrita executar.
 *
 * Trocar `erro` por `falha_auditoria` nesse caso seria pior — apagaria
 * QUAL falha aconteceu. As duas verdades cabem juntas, e e assim que
 * elas sao devolvidas.
 */
export type ResultadoExecucaoFuncao =
  | {
      tipo: "sucesso";
      requestId: string;
      envelope: EnvelopeSucesso;
      auditoria: "completa" | "incompleta";
      /**
       * A autoridade REAL desta execucao — INTERNA.
       *
       * Existe para um caso so: quem executou uma Funcao de leitura e
       * precisa PERSISTIR o que leu tem de gravar na MESMA conta que a
       * leitura usou. Resolver o binding uma segunda vez abriria uma
       * janela entre buscar e gravar, e nessa janela o vinculo pode
       * mudar — o dado de uma conta acabaria na outra.
       *
       * `lojaId` aqui e o MESMO valor que `contextoDaFuncao` entregou a
       * Funcao como `contexto.conexao.lojaId`: os dois saem do mesmo
       * `snapshot`, de uma unica resolucao. Nao ha como divergirem.
       *
       * `null` quando a Funcao nao exige conexao.
       *
       * NAO atravessa a ponte: `mapear` em `acoes/route.ts` monta a
       * resposta campo a campo, e nenhum consumidor espalha o resultado.
       */
      autoridade: { readonly lojaId: string | null };
    }
  | { tipo: "negado"; requestId: string; codigo: CodigoNegacaoTerminal }
  | {
      tipo: "aguardando_aprovacao";
      requestId: string;
      codigo: "aprovacao_necessaria";
      /** Onde a espera vive. Sem ele quem chamou nao tem o que aprovar. */
      aprovacaoId: string;
      /** `reutilizada` quando a mesma acao ja tinha pedido ativo. */
      estadoAprovacao: "criada" | "reutilizada";
    }
  | { tipo: "aprovacao_indisponivel"; requestId: string; codigo: CodigoAprovacao }
  | { tipo: "erro"; requestId: string; envelope: EnvelopeErro; auditoria: "completa" | "incompleta" }
  | {
      tipo: "falha_auditoria";
      requestId: string;
      etapa: "abertura" | "desfecho";
      reexecutavel: false;
      /**
       * Por que a abertura nao foi registrada - M2-I1-A8.
       *
       * `"duplicada"` SO aparece quando `registrarAbertura` devolveu
       * exatamente `duplicada`, isto e, quando a chave de idempotencia
       * colidiu com uma abertura que ja existe. Falha de SQL, FK, erro
       * desconhecido e timeout NAO produzem este motivo.
       *
       * Campo OPCIONAL de proposito: uma oitava variante no union
       * quebraria os tres `switch` exaustivos que terminam em `never`,
       * dois deles em modulos que este slice nao toca. Quem discrimina
       * por `tipo` continua vendo sete variantes.
       *
       * Ele descreve o REGISTRO, nao o resultado da Funcao: a Funcao nao
       * rodou, e por isso o lugar disto continua sendo `falha_auditoria`.
       */
      motivo?: "duplicada";
    }
  | { tipo: "indisponivel"; requestId: string };

/** O sub-tipo que os dois auxiliares de erro devolvem. Derivado, nunca
 *  recopiado: acrescentar campo a variante `erro` chega aqui sozinho. */
type ResultadoErro = Extract<ResultadoExecucaoFuncao, { tipo: "erro" }>;

/**
 * O que uma linha de chamada carrega, sem os campos de RESULTADO.
 *
 * Derivado de `EntradaDesfechoDeExecucao`, nunca redigitado: a forma de
 * uma linha e propriedade de `registro.ts`, e escrever a lista de campos
 * a mao aqui criaria um segundo contrato de auditoria que precisaria
 * concordar para sempre. Coluna nova chega ate aqui sozinha.
 */
type SnapshotChamada = Omit<
  EntradaDesfechoDeExecucao,
  "status" | "codigo" | "mensagem" | "latenciaMs"
>;

// ─── Auxiliares puros ─────────────────────────────────────────────────

/**
 * Normaliza o id ANTES de qualquer decisao.
 *
 *   `canonico`    forma valida E presente no catalogo.
 *   `desconhecido` forma valida, ausente do catalogo. O id e PRESERVADO
 *                  na auditoria: saber o que alguem tentou invocar e o
 *                  sinal de seguranca mais interessante desta tabela.
 *   `malformado`   vazio, forma invalida, ou nem string. Vai NULL.
 *
 * `funcaoExiste` usa `hasOwnProperty`, nao `in` — `constructor` e
 * `toString` nao "existem" no catalogo.
 */
function classificarFuncaoId(
  bruto: unknown
): { forma: "canonico"; id: string } | { forma: "desconhecido"; id: string } | { forma: "malformado" } {
  if (typeof bruto !== "string" || !FORMA_FUNCAO_ID.test(bruto)) return { forma: "malformado" };
  return funcaoExiste(bruto) ? { forma: "canonico", id: bruto } : { forma: "desconhecido", id: bruto };
}

/** Mensagem estavel e propria da CDS. Nunca deriva de erro de driver,
 *  de provedor ou de stack — nenhum deles chega ate aqui. */
function envelopeDeErro(
  requestId: string,
  code: string,
  message: string,
  retryable: boolean
): EnvelopeErro {
  return { contrato: VERSAO_CONTRATO, ok: false, request_id: requestId, error: { code, message, retryable } };
}

/**
 * O envelope de erro que SAI daqui — sempre validado.
 *
 * ── O buraco que isto fecha (achado A3 do R1) ───────────────────────
 *
 * Dois codigos de erro nao sao constantes nossas: `validacao.codigo`
 * vem do validador da Funcao e `leitura.codigo` vem do interpretador
 * dela. Uma Funcao mal escrita devolvendo `""` produzia um envelope que
 * reprova em `envelopeValido` e saia assim mesmo — o contrato publico
 * garantido por uma peca que ninguem checava.
 *
 * `envelopeValido` (de `contrato.ts`) continua a UNICA autoridade: aqui
 * nao ha segunda validacao, so a chamada dela.
 *
 * Candidato reprovado nao e consertado nem devolvido: vira
 * `erro_interno`, porque quem falhou em montar o contrato publico foi a
 * CDS. `degradado` avisa quem chama para tambem corrigir o codigo que
 * vai para a auditoria — a linha nao pode dizer `saida_invalida` quando
 * o que quebrou foi a nossa montagem.
 *
 * A mensagem do fallback e constante. Nada do candidato entra nela.
 */
function envelopeDeErroSeguro(
  requestId: string,
  code: string,
  message: string,
  retryable: boolean
): { envelope: EnvelopeErro; degradado: boolean } {
  const candidato = envelopeDeErro(requestId, code, message, retryable);
  if (envelopeValido(candidato)) return { envelope: candidato, degradado: false };
  return { envelope: envelopeDeErro(requestId, "erro_interno", MSG_CONTRATO, false), degradado: true };
}

const MSG_ENTRADA = "Os argumentos enviados nao sao validos para esta funcao.";
const MSG_INTERNO = "Nao foi possivel preparar a execucao desta funcao.";
const MSG_EXECUTOR = "A funcao falhou durante a execucao.";
const MSG_SAIDA = "A funcao respondeu fora do formato esperado.";
const MSG_ESCRITA = "Funcoes de escrita ainda nao sao executaveis.";
const MSG_CONTRATO = "A resposta desta funcao nao pode ser entregue no contrato publico.";

/**
 * Finaliza um erro que aconteceu ANTES da abertura.
 *
 * Os cinco caminhos pre-abertura repetiam o mesmo par — gravar o
 * desfecho isolado e montar o envelope — e nenhum deles olhava o
 * resultado da gravacao. Um lugar so, e a regra vale para todos.
 *
 * `codigo` e a CATEGORIA de infraestrutura que vai para a Tool Call;
 * `envelopeCode` e o codigo de DOMINIO que vai para quem chamou. Sao
 * camadas diferentes de proposito: `entrada_invalida` na linha,
 * `janela_excedida` no envelope.
 */
async function erroSemExecucao(
  linha: Omit<EntradaDesfechoSemExecucao, "status" | "codigo" | "mensagem">,
  codigo: "entrada_invalida" | "erro_interno",
  envelopeCode: string,
  mensagem: string,
  retryable: boolean
): Promise<ResultadoErro> {
  // O envelope e resolvido ANTES da gravacao: se o candidato reprovar,
  // a linha precisa dizer `erro_interno`, e nao a categoria que a
  // montagem quebrada sugeria.
  const seguro = envelopeDeErroSeguro(linha.requestId, envelopeCode, mensagem, retryable);

  const registro = await registrarDesfechoSemExecucao({
    ...linha,
    status: "erro",
    codigo: seguro.degradado ? "erro_interno" : codigo,
    mensagem: seguro.degradado ? MSG_CONTRATO : mensagem,
  });

  return {
    tipo: "erro",
    requestId: linha.requestId,
    envelope: seguro.envelope,
    auditoria: registro.estado === "registrada" ? "completa" : "incompleta",
  };
}

/**
 * Finaliza um erro que aconteceu DEPOIS da abertura — os cinco
 * caminhos do achado A1.
 *
 * ── A regra que este auxiliar existe para nao perder ────────────────
 *
 * A Funcao falhou E o desfecho pode nao ter gravado. Nao ha nova
 * tentativa de escrita, nao ha `request_id` novo e nao ha retry: a
 * abertura orfa fica de proposito, e e ela que o indice parcial
 * `WHERE status='executando'` existe para encontrar.
 *
 * Em LEITURA o envelope verdadeiro do erro e devolvido com
 * `auditoria: "incompleta"` — apagar QUAL falha ocorreu seria pior que
 * o registro perdido.
 *
 * Em ESCRITA, nao. Um efeito externo pode ter acontecido e o registro
 * dele se perdeu: devolver um erro comum convidaria a repetir. O
 * resultado vira `falha_auditoria` com `reexecutavel: false`, que e a
 * unica resposta honesta. Esse ramo NAO e alcancavel hoje — escrita
 * para antes da abertura —, e existe para que habilitar escrita seja
 * uma decisao de gate, nunca um efeito colateral.
 */
async function erroDeExecucao(
  snapshot: SnapshotChamada,
  latenciaMs: number,
  codigo: "executor_falhou" | "saida_invalida" | "erro_interno",
  envelopeCode: string,
  mensagem: string,
  retryable: boolean
): Promise<ResultadoExecucaoFuncao> {
  const seguro = envelopeDeErroSeguro(snapshot.requestId, envelopeCode, mensagem, retryable);

  const registro = await registrarDesfechoDeExecucao({
    ...snapshot,
    status: "erro",
    codigo: seguro.degradado ? "erro_interno" : codigo,
    mensagem: seguro.degradado ? MSG_CONTRATO : mensagem,
    latenciaMs,
  });

  if (registro.estado !== "registrada" && snapshot.acesso === "escrita") {
    return { tipo: "falha_auditoria", requestId: snapshot.requestId, etapa: "desfecho", reexecutavel: false };
  }

  return {
    tipo: "erro",
    requestId: snapshot.requestId,
    envelope: seguro.envelope,
    auditoria: registro.estado === "registrada" ? "completa" : "incompleta",
  };
}

/**
 * Roda o validador da Funcao e classifica o que aconteceu.
 *
 * Dois caminhos precisam desta mesma leitura — o automatico, antes da
 * abertura, e o de aprovacao, antes de congelar o argumento. A logica e
 * curta, mas a regra que ela carrega nao e obvia: um THROW do validador
 * e bug NOSSO, nao prova de que o argumento estava errado, e por isso
 * vira `erro_interno` em vez de `entrada_invalida`. Escrita duas vezes,
 * essa distincao sobreviveria enquanto os dois lados fossem lembrados
 * juntos.
 *
 * A funcao nao decide o que fazer com o resultado, e nao grava nada:
 * cada ramo continua respondendo do seu jeito, na sua posicao.
 */
type LeituraDeArgumentos =
  | { tipo: "valida" }
  | { tipo: "invalida"; codigo: string }
  | { tipo: "erro_interno" };

/**
 * O contexto do executor, derivado do SNAPSHOT — nunca da entrada.
 *
 * ── Por que a fonte e o snapshot ────────────────────────────────────
 *
 * Ele e o mesmo valor que a auditoria grava e que o guard autorizou. Ler
 * a conexao de qualquer outro lugar aqui abriria a porta para autorizar
 * uma conta e agir contra outra — e `EntradaExecucaoFuncao` nem tem os
 * campos, entao o `tsc` recusa a tentativa antes de qualquer teste.
 *
 * ── Fail-closed, e a assimetria e proposital ────────────────────────
 *
 * Sem requisito, `conexao` e `null` e pronto: `vendas.consultar` continua
 * recebendo exatamente o que sempre recebeu, mais um campo nulo que ela
 * nao le.
 *
 * COM requisito, os tres campos precisam estar presentes. `null` aqui
 * nao e "siga sem conexao": e recusa. Um `lojaId` faltando significa que
 * o binding nao chegou, e executar assim escolheria conta por omissao.
 *
 * `plataforma` e `recurso` vem do snapshot, nao de `conexaoNecessaria`:
 * os dois ja foram provados iguais — na criacao da aprovacao e no
 * consumo — e usar a mesma fonte do `lojaId` mantem o trio coerente.
 */
function contextoDaFuncao(
  snapshot: SnapshotChamada,
  definicao: DefinicaoFuncao,
  controle?: ControleDeTempo
): ContextoFuncao | null {
  // SO o limite do provider atravessa. O rigido fica desta camada: uma
  // Funcao nao tem o que fazer com o relogio da persistencia, e
  // entrega-lo abriria a porta para um executor cancelar a auditoria
  // que explica o proprio cancelamento.
  const limiteDoProvider = controle?.limiteDoProvider;

  if (definicao.conexaoNecessaria === null) {
    return { userId: snapshot.userId, conexao: null, limiteDoProvider };
  }

  const { plataforma, recurso, lojaId } = snapshot;
  if (!plataforma || !recurso || !lojaId) return null;

  return {
    userId: snapshot.userId,
    conexao: { plataforma, recurso, lojaId },
    limiteDoProvider,
  };
}

function validarArgumentos(definicao: DefinicaoFuncao, argumentos: unknown): LeituraDeArgumentos {
  let validacao;
  try {
    validacao = definicao.validarEntrada(argumentos);
  } catch {
    return { tipo: "erro_interno" };
  }
  return validacao.valida ? { tipo: "valida" } : { tipo: "invalida", codigo: validacao.codigo };
}

/**
 * O que fazer quando pedir a aprovacao NAO deu certo.
 *
 * Os codigos vem de `criarAprovacao` e a maioria descreve uma CORRIDA:
 * entre o guard dizer "precisa de aprovacao" e a RPC revalidar, o dono
 * pode ter mudado a permissao, apagado o agente ou trocado a conexao.
 * Nenhuma delas pode virar execucao, e nenhuma pode virar silencio.
 *
 * As tres primeiras reusam categorias que ja existem e ja significam a
 * mesma coisa neste modulo. Todo o resto — inclusive o que "nao deveria
 * acontecer" — cai em `erro_interno`, fail-closed: uma corrida de
 * autoridade que nao sabemos nomear nao vira permissao.
 */
async function recusaDeCriacao(
  snapshot: SnapshotChamada,
  codigo: Exclude<CodigoAprovacao, "criada" | "reutilizada">
): Promise<ResultadoExecucaoFuncao> {
  if (codigo === "agente_indisponivel" || codigo === "tarefa_indisponivel") {
    // Mesma resposta do inicio de `executarFuncao`, e pelo mesmo
    // motivo: sem posse nao ha tenant para sustentar a linha.
    return { tipo: "indisponivel", requestId: snapshot.requestId };
  }

  if (codigo === "permissao_ausente") {
    await registrarDesfechoSemExecucao({ ...snapshot, status: "negado", codigo });
    return { tipo: "negado", requestId: snapshot.requestId, codigo };
  }

  if (codigo === "conexao_indisponivel") {
    // O vocabulario da Tool Call chama isto de `conexao_ausente`; a
    // traducao acontece aqui, uma vez, e nao vira codigo novo no banco.
    await registrarDesfechoSemExecucao({ ...snapshot, status: "negado", codigo: "conexao_ausente" });
    return { tipo: "negado", requestId: snapshot.requestId, codigo: "conexao_ausente" };
  }

  return erroSemExecucao(snapshot, "erro_interno", "erro_interno", MSG_INTERNO, false);
}

// ─── O pos-abertura ───────────────────────────────────────────────────

/**
 * Tudo que acontece DEPOIS de a abertura estar gravada.
 *
 * ── Por que isto e uma funcao, e nao um trecho ──────────────────────
 *
 * A abertura de uma chamada tem DOIS escritores. Um e `registrarAbertura`,
 * logo abaixo. O outro e a RPC `aprovacao_consumir_e_abrir`, que grava a
 * abertura na mesma transacao em que consome a aprovacao — porque
 * consumir e abrir precisam ser atomicos, e TypeScript nao roda em
 * transacao.
 *
 * O que vem depois da abertura precisa ser o MESMO nos dois casos:
 * mesma execucao, mesma interpretacao, mesmo envelope, mesmo
 * fechamento, mesma politica de auditoria incompleta. Duas copias
 * divergiriam no primeiro conserto feito so de um lado — e a que
 * divergisse em silencio seria a que registra o que aconteceu.
 *
 * ── O que ela deliberadamente NAO faz ───────────────────────────────
 *
 * Nao abre chamada e nao gera `request_id`. Ela recebe uma chamada JA
 * aberta e a fecha pelo MESMO `snapshot.requestId`: um id novo aqui
 * produziria um desfecho que nao encontra sua abertura, e uma abertura
 * que nunca e fechada. Quem abriu escolhe a correlacao; quem fecha a
 * respeita.
 */
async function executarComAberturaFeita(
  snapshot: SnapshotChamada,
  definicao: DefinicaoFuncao,
  argumentos: unknown,
  controle?: ControleDeTempo
): Promise<ResultadoExecucaoFuncao> {
  // ── Execucao ──────────────────────────────────────────────────────
  //
  // O relogio mede a FUNCAO, nao a orquestracao: interpretador, envelope
  // e auditoria ficam de fora.
  // ── O UNICO ponto em que o contexto do executor e montado ─────────
  //
  // Os dois caminhos — automatico e pos-Approval — passam por aqui, e e
  // por isso que a montagem mora nesta funcao e nao em cada chamador.
  // Duas construcoes divergiriam no primeiro conserto feito so de um
  // lado, e a que divergisse seria a que decide contra QUAL conta agir.
  const contexto = contextoDaFuncao(snapshot, definicao, controle);
  if (contexto === null) {
    // Requisito de conexao sem binding no snapshot e defeito NOSSO, nao
    // pedido malformado: o guard ja autorizou, entao o vinculo tinha de
    // estar la. Recusa fechada ANTES do relogio — a Funcao nao rodou, e
    // `executor_falhou` afirmaria que rodou.
    return erroDeExecucao(snapshot, 0, "erro_interno", "erro_interno", MSG_INTERNO, false);
  }

  const inicio = performance.now();
  let saida: unknown;
  try {
    saida = await definicao.executor(contexto, argumentos);
  } catch {
    const latenciaMs = Math.round(performance.now() - inicio);
    return erroDeExecucao(snapshot, latenciaMs, "executor_falhou", "executor_falhou", MSG_EXECUTOR, false);
  }
  const latenciaMs = Math.round(performance.now() - inicio);

  // ── Interpretacao ─────────────────────────────────────────────────
  let leitura;
  try {
    leitura = definicao.interpretarSaida(saida);
  } catch {
    // Throw do interpretador e bug INTERNO, nao prova de saida invalida.
    return erroDeExecucao(snapshot, latenciaMs, "erro_interno", "erro_interno", MSG_INTERNO, false);
  }

  if (leitura.tipo === "invalida") {
    return erroDeExecucao(snapshot, latenciaMs, "saida_invalida", "saida_invalida", MSG_SAIDA, false);
  }

  if (leitura.tipo === "erro") {
    // A Funcao rodou e reportou falha de DOMINIO: categoria
    // `executor_falhou` na auditoria, codigo especifico no envelope.
    return erroDeExecucao(
      snapshot,
      latenciaMs,
      "executor_falhou",
      leitura.codigo,
      leitura.mensagem,
      leitura.retryable
    );
  }

  // ── Envelope ──────────────────────────────────────────────────────
  //
  // Duas camadas: `interpretarSaida` e o contrato da Funcao,
  // `envelopeValido` e o contrato generico da CDS. Sem `execution_id` —
  // este executor roda em processo.
  const envelope: EnvelopeSucesso = {
    contrato: VERSAO_CONTRATO,
    ok: true,
    request_id: snapshot.requestId,
    data: leitura.data,
  };

  if (!envelopeValido(envelope)) {
    return erroDeExecucao(snapshot, latenciaMs, "saida_invalida", "saida_invalida", MSG_SAIDA, false);
  }

  // ── Desfecho ──────────────────────────────────────────────────────
  //
  // A saida NAO e persistida: a auditoria guarda o que aconteceu, nunca
  // o dado do cliente.
  const desfecho = await registrarDesfechoDeExecucao({ ...snapshot, status: "sucesso", latenciaMs });

  // Leitura idempotente cujo desfecho nao gravou: o resultado e
  // verdadeiro e devolve-lo e honesto — mas a auditoria fica incompleta,
  // e quem chama precisa saber disso. A abertura orfa permanece, e e
  // exatamente o sinal que o indice parcial `WHERE status='executando'`
  // existe para encontrar.
  //
  // Para ESCRITA a politica e outra — `falha_auditoria`, sem devolver
  // resultado —, e ela nao e alcancavel aqui porque escrita nao executa.
  return {
    tipo: "sucesso",
    requestId: snapshot.requestId,
    envelope,
    auditoria: desfecho.estado === "registrada" ? "completa" : "incompleta",
    // Do MESMO snapshot que alimentou `contextoDaFuncao`. Nao e uma
    // segunda leitura: e o mesmo valor, devolvido.
    autoridade: { lojaId: snapshot.lojaId ?? null },
  };
}

// ─── O executor ───────────────────────────────────────────────────────

/**
 * A ordem NAO e estilistica — cada passo depende de o anterior ter sido
 * provado, e o ultimo antes da abertura e o que a torna honesta.
 *
 * 1. `request_id` nasce antes de tudo: ele identifica UMA TENTATIVA de
 *    invocar uma Funcao, e existe mesmo quando o executor nunca roda.
 * 2. Posse do agente (e da tarefa) ANTES de permissao e conexao: os dois
 *    resolvers consultam o banco em nome do agente, e descobrir no
 *    INSERT que ele e de outro dono seria trabalhar por um tenant que
 *    nao existe. Sem posse nao ha nem `agente_id` tenant-safe para
 *    sustentar a linha — por isso `indisponivel` nao grava nada.
 * 3. Catalogo antes de permissao: perguntar o nivel de uma Funcao que
 *    nao existe mandaria o dono liberar uma ferramenta inexistente.
 * 4. Guard depois dos fatos, com metadados vindos SO da definicao.
 * 5. Validacao depois do guard: validar localmente nao causa efeito
 *    externo, e uma abertura para um argumento que nunca chegou ao
 *    executor diria o contrario.
 */
export async function executarFuncao(
  entrada: EntradaExecucaoFuncao
): Promise<ResultadoExecucaoFuncao> {
  const requestId = randomUUID();
  const { userId, agenteId, argumentos } = entrada;
  const tarefaId = entrada.tarefaId ?? null;

  if (!userId || !agenteId) return { tipo: "indisponivel", requestId };

  // ── 2. Posse ──────────────────────────────────────────────────────
  //
  // "Nao existe" e "e de outro dono" dao o MESMO resultado, de
  // proposito: distingui-los seria um oraculo de existencia de recurso
  // alheio. Mesma escolha das FKs da auditoria, onde as causas chegam
  // indistinguiveis.
  const agente = await lerAgenteDoDono(agenteId, userId);
  if (agente.erro !== null || agente.linha === null) return { tipo: "indisponivel", requestId };

  if (tarefaId !== null) {
    const tarefa = await lerTarefaDoDono(tarefaId, userId);
    if (tarefa.erro !== null || tarefa.linha === null) return { tipo: "indisponivel", requestId };
  }

  const base = { userId, agenteId, requestId, tarefaId };

  // ── 3. Catalogo ───────────────────────────────────────────────────
  const classificacao = classificarFuncaoId(entrada.funcaoId);
  if (classificacao.forma !== "canonico") {
    // `acesso` fica NULL porque nao houve Funcao a resolver — e o CHECK
    // do banco amarra exatamente essa condicao.
    await registrarDesfechoSemExecucao({
      ...base,
      funcaoId: classificacao.forma === "desconhecido" ? classificacao.id : null,
      status: "negado",
      codigo: "funcao_inexistente",
      acesso: null,
    });
    return { tipo: "negado", requestId, codigo: "funcao_inexistente" };
  }

  const funcaoId = classificacao.id;
  const definicao: DefinicaoFuncao = FUNCOES[funcaoId];
  const comFuncao = { ...base, funcaoId, acesso: definicao.acesso };

  // ── 4a. Permissao ─────────────────────────────────────────────────
  //
  // Coleta que falha NAO vira `permissao_ausente`: isso afirmaria que o
  // dono nunca configurou, quando na verdade nao conseguimos ler. Sao
  // fatos diferentes e pedem acoes diferentes.
  // Um ramo ou o outro. Nunca os dois.
  //
  // `resolverConexoesDoAgente` le `agente_permissoes` do catalogo inteiro
  // para montar o feed de requisitos, e publica o que leu. Quando ha
  // requisito, reler aqui seria a MESMA tabela, na MESMA requisicao, sem
  // fato novo. Quando nao ha requisito o resolver nem e chamado, e a
  // leitura curta — um id so — continua sendo a certa.
  let fatosPermissao: readonly FatoPermissao[];

  // ── 4b. Conexao ───────────────────────────────────────────────────
  //
  // Sem requisito, o resolver NAO e chamado: consultar as conexoes de
  // quem nao precisa delas seria trabalho e superficie a toa.
  let conexoes: readonly FatoConexao[] = [];
  let plataforma: string | null = null;
  let recurso: string | null = null;
  let lojaId: string | null = null;

  const requisito = definicao.conexaoNecessaria;
  if (requisito !== null) {
    plataforma = requisito.plataforma;
    recurso = requisito.recurso;

    const resultado = await resolverConexoesDoAgente({ userId, agenteId, agoraMs: Date.now() });
    if (resultado.coleta !== "ok") {
      return erroSemExecucao(
        // `plataforma` e `recurso` vem do CATALOGO — nao do cliente, nao
        // da entrada. Falha de coleta nao vira nivel nenhum: o snapshot
        // sai com `nivelNoMomento` NULL, jamais `bloqueado`.
        { ...comFuncao, nivelNoMomento: null, plataforma, recurso },
        "erro_interno",
        "erro_interno",
        MSG_INTERNO,
        false
      );
    }
    // Do catalogo INTEIRO. A decisao continua sendo sobre UM fato.
    fatosPermissao = resultado.permissoes;
    conexoes = resultado.conexoes;

    // ── De onde o `lojaId` VEM, e de onde ele nunca pode vir ────────
    //
    // Do binding VALIDADO, casado pelo par exato. Nunca da selecao crua,
    // nunca dos argumentos da Funcao, nunca da entrada da Tarefa, nunca
    // do cliente: `agente_conexoes` nao tem invariante de banco ligando
    // `plataforma` ao marketplace da loja, entao uma linha
    // `(mercado_livre, perguntas, <loja Shopee>)` e estruturalmente
    // possivel — e so a derivacao por fatos a descarta.
    //
    // Ausencia aqui e `null`, e `null` nao bloqueia por si: quem nega e
    // o guard, ao nao encontrar fato utilizavel para o requisito.
    lojaId =
      resultado.bindings.find((b) => b.plataforma === plataforma && b.recurso === recurso)
        ?.lojaId ?? null;

  } else {
    const permissoes = await resolverFatosPermissoes({ userId, agenteId, funcaoIds: [funcaoId] });
    if (permissoes.coleta !== "ok") {
      return erroSemExecucao(comFuncao, "erro_interno", "erro_interno", MSG_INTERNO, false);
    }
    fatosPermissao = permissoes.fatos;
  }

  // NOMINAL, e so isto. O array pode ter um fato ou o catalogo inteiro: a
  // busca e por `funcaoId`, nunca por posicao, contagem, ordem ou por um
  // `some()` global. Uma Funcao vizinha em `automatico` nao pode liberar
  // esta, e uma vizinha `bloqueado` nao pode negar.
  const fatoPermissao: FatoPermissao | undefined =
    fatosPermissao.find((p) => p.funcaoId === funcaoId);
  const nivelNoMomento = fatoPermissao?.nivel ?? null;

  // ── 4c. Cobertura REMOTA do requisito em execucao ─────────────────
  //
  // `coberturaDoRecurso` devolve `nao_verificavel` constante, entao sem
  // este passo NENHUMA Funcao conectada executaria. Aqui o fato do
  // requisito ATUAL — e so dele — pode ser elevado a `confirmada`.
  //
  // ── Por que DEPOIS do nivel, e nao dentro do bloco de conexao ─────
  //
  // O guard decide permissao ANTES de conexao: em `bloqueado`, `ausente`
  // ou `aprovacao` ele nem le `conexoes`. Confirmar cobertura nesses
  // ramos seria perguntar ao Mercado Livre antes de o dono ter decidido —
  // custo e superficie por uma resposta que ninguem ia ler. No ramo de
  // aprovacao quem confirma e `resolverAlvo`, dentro de `criarAprovacao`,
  // ja depois da decisao humana.
  //
  // `lojaId !== null` fecha o resto: sem binding validado nao ha conta
  // contra a qual provar nada, e selecao cross-provider nao produz
  // binding.
  //
  // O executor continua sem conhecer endpoint, token ou HTTP — ele chama
  // um dono de estado e recebe fatos.
  if (requisito !== null && nivelNoMomento === "automatico" && lojaId !== null) {
    const elevados = await confirmarCoberturaDosFatos(
      {
        userId,
        requisito,
        lojaId,
        // Do CATALOGO. O `acesso` amarra o HARD BOUND de leitura la na
        // ponta: escrita nunca confirma, por mais valido que esteja o resto.
        acesso: definicao.acesso,
        conexoes,
      },
      undefined,
      // A cobertura divide o MESMO orcamento do provider com a busca de
      // perguntas. Sem isto ela abriria 20 s proprios e a pagina
      // seguinte comecaria ja fora do prazo.
      entrada.controleTempo?.limiteDoProvider
    );
    conexoes = elevados.conexoes;
  }

  const snapshot = { ...comFuncao, nivelNoMomento, plataforma, recurso, lojaId };

  // ── 5. Guard ──────────────────────────────────────────────────────
  //
  // `conexaoNecessaria` vem da DEFINICAO, nunca da entrada — e o tipo de
  // `EntradaExecucaoFuncao` nem tem o campo, entao o `tsc` recusa antes
  // de qualquer teste. `agentes.tipo` nao participa: perfil e rotulo.
  const decisao = autorizarFuncao({
    funcaoId,
    conexaoNecessaria: definicao.conexaoNecessaria,
    funcoes: [{ id: funcaoId, existe: true }],
    permissoes: fatosPermissao,
    conexoes,
  });

  if (!decisao.permitido) {
    if (decisao.estado === "aguardando_aprovacao") {
      // ── Validar ANTES de pedir aprovacao ──────────────────────────
      //
      // Localizado neste ramo de proposito: no caminho automatico a
      // validacao continua onde sempre esteve, logo antes da abertura.
      // Aqui ela precisa vir antes porque congelar um argumento
      // invalido produziria uma aprovacao que o dono poderia aprovar e
      // que NUNCA poderia ser consumida — o consumo revalida.
      const antesDeCongelar = validarArgumentos(definicao, argumentos);
      if (antesDeCongelar.tipo === "erro_interno") {
        return erroSemExecucao(snapshot, "erro_interno", "erro_interno", MSG_INTERNO, false);
      }
      if (antesDeCongelar.tipo === "invalida") {
        return erroSemExecucao(snapshot, "entrada_invalida", antesDeCongelar.codigo, MSG_ENTRADA, false);
      }

      const pedido = await criarAprovacao({ userId, agenteId, tarefaId, funcaoId, argumentos });

      if (pedido.codigo === "criada" || pedido.codigo === "reutilizada") {
        // ── E aqui a Tool Call NAO nasce ──────────────────────────
        //
        // Ate o TOOL-EXEC-B este ramo gravava um desfecho isolado
        // dizendo "esperando". Agora a espera tem lugar proprio, com
        // dono, prazo, argumentos congelados e decisao registrada — a
        // aprovacao E o registro. Manter as duas seria contar a mesma
        // espera em dois lugares, e o segundo envelheceria sozinho.
        return {
          tipo: "aguardando_aprovacao",
          requestId,
          codigo: "aprovacao_necessaria",
          aprovacaoId: pedido.aprovacaoId,
          estadoAprovacao: pedido.codigo,
        };
      }

      return recusaDeCriacao(snapshot, pedido.codigo);
    }

    const codigo = decisao.codigo as CodigoNegacaoTerminal;
    await registrarDesfechoSemExecucao({ ...snapshot, status: "negado", codigo });
    return { tipo: "negado", requestId, codigo };
  }

  // ── 6. Escrita: fail-closed ───────────────────────────────────────
  //
  // Depois do guard, de proposito: uma Funcao de escrita sem permissao
  // continua registrando a negacao verdadeira, e so uma que SERIA
  // permitida cai aqui.
  //
  // Nao ha politica de `idempotency_key`, de replay nem de recuperacao
  // para escrita, e o CHECK do banco exige a chave na abertura. Inventar
  // uma seria criar dedup sem contrato — e a chave errada faz um efeito
  // externo acontecer duas vezes.
  if (definicao.acesso === "escrita") {
    return erroSemExecucao(snapshot, "erro_interno", "escrita_nao_suportada", MSG_ESCRITA, false);
  }

  // ── 7. Argumentos ─────────────────────────────────────────────────
  //
  // Mesma posicao de sempre, imediatamente antes da abertura. O ramo de
  // aprovacao valida mais cedo, no lugar dele, e os dois usam a MESMA
  // leitura — ver `validarArgumentos`.
  const validacao = validarArgumentos(definicao, argumentos);

  if (validacao.tipo === "erro_interno") {
    return erroSemExecucao(snapshot, "erro_interno", "erro_interno", MSG_INTERNO, false);
  }

  if (validacao.tipo === "invalida") {
    // `envelopeCode` preserva o codigo de DOMINIO (`janela_excedida`); a
    // categoria de infraestrutura fica so na Tool Call.
    return erroSemExecucao(snapshot, "entrada_invalida", validacao.codigo, MSG_ENTRADA, false);
  }

  // ── 8. Abertura ───────────────────────────────────────────────────
  //
  // Qualquer estado diferente de `registrada` impede o executor —
  // inclusive em leitura. Executar sem auditoria e exatamente o que
  // esta frente existe para impedir, e `duplicada` nao ganha um
  // `request_id` novo: colisao de UUID e sinal de bug ou replay, e
  // regerar esconderia o sinal.
  const abertura = await registrarAbertura({
    ...snapshot,
    idempotencyKey: entrada.idempotencyKey ?? null,
  });
  if (abertura.estado !== "registrada") {
    // `duplicada` ATRAVESSA, e so ela. O estado vinha sendo descartado
    // aqui: quem pediu com chave de idempotencia nao tinha como
    // distinguir `ja foi feito` de `o registro quebrou`, e sao coisas
    // diferentes que pedem acoes diferentes de quem chamou.
    return {
      tipo: "falha_auditoria",
      requestId,
      etapa: "abertura",
      reexecutavel: false,
      ...(abertura.estado === "duplicada" ? { motivo: "duplicada" as const } : {}),
    };
  }

  // ── 9. Execucao, interpretacao, envelope e desfecho ───────────────
  //
  // Daqui para a frente a chamada JA esta aberta, e o que acontece nao
  // depende de como ela foi aberta. Uma implementacao so — a mesma que
  // fecha uma abertura vinda da RPC de aprovacao.
  return executarComAberturaFeita(snapshot, definicao, argumentos, entrada.controleTempo);
}

// ─── A retomada ───────────────────────────────────────────────────────

/**
 * A entrada mais curta deste modulo, e a lista curta E a defesa.
 *
 * Quem retoma nao diz QUAL Funcao, nao diz com QUE argumentos, nao diz
 * por qual agente nem contra qual loja. Tudo isso foi decidido quando a
 * aprovacao nasceu e congelado nela; repetir qualquer um desses campos
 * aqui abriria a porta para aprovar uma acao e executar outra.
 *
 * `userId` DEVE vir de camada server-side ja autenticada — mesmo
 * precedente de `EntradaExecucaoFuncao`.
 */
export interface EntradaRetomadaAprovacao {
  userId: string;
  aprovacaoId: string;
}

/**
 * Executa o que um humano ja aprovou.
 *
 * ── Quem abre a Tool Call aqui NAO e este modulo ────────────────────
 *
 * `consumirAprovacaoEAbrir` consome a aprovacao E grava a abertura na
 * MESMA transacao — as duas coisas precisam acontecer juntas, e
 * TypeScript nao roda em transacao. Por isso esta funcao nunca chama
 * `registrarAbertura` e nunca gera `request_id` para a chamada: os dois
 * ja aconteceram no banco quando ela recebe o controle.
 *
 * ── A unica porta para o executor ───────────────────────────────────
 *
 * Somente `codigo === "consumida"` chega a `executarComAberturaFeita`.
 * Todo o resto retorna antes — inclusive `ja_consumida`, que significa
 * que OUTRO chamador venceu a corrida e ja esta executando. Reaproveitar
 * o contexto lido antes da RPC nesse caso executaria a Funcao duas vezes
 * contra uma unica abertura.
 *
 * ── A janela que continua aberta ────────────────────────────────────
 *
 * Se o processo cair entre o COMMIT do consumo e o fim da execucao, a
 * aprovacao fica `consumida`, a chamada fica `executando` e a Funcao
 * nunca rodou. Nao ha recuperacao aqui: nao ha retry, nao ha timeout e
 * nao ha caminho de volta de `consumida`. A abertura orfa e encontravel
 * pelo indice parcial `WHERE status='executando'`, e essa divida so e
 * aceitavel enquanto esta funcao nao tem chamador de producao — ligar
 * uma rota, uma Task ou um worker a ela exige resolver isso antes.
 */
export async function retomarAprovacao(
  entrada: EntradaRetomadaAprovacao
): Promise<ResultadoExecucaoFuncao> {
  const { userId, aprovacaoId } = entrada;

  // Uma recusa nao tem chamada aberta para nomear, e mesmo assim
  // precisa de um id — pelo mesmo motivo que `executarFuncao` gera o
  // dele antes de tudo: ele identifica A TENTATIVA. O id da CHAMADA,
  // quando existe, vem da RPC e nunca daqui.
  const correlacao = randomUUID();

  if (!userId || !aprovacaoId) return { tipo: "indisponivel", requestId: correlacao };

  const consumo = await consumirAprovacaoEAbrir({ userId, aprovacaoId });

  if (consumo.codigo === "abertura_ilegivel") {
    // A aprovacao foi gasta e a chamada esta aberta, mas nao sabemos o
    // que a abertura registrou. Executar produziria um desfecho que
    // discorda da propria abertura; nao executar deixa uma linha orfa,
    // que e o dano menor e o unico honesto. `reexecutavel: false`
    // porque a aprovacao nao volta.
    return {
      tipo: "falha_auditoria",
      requestId: consumo.requestId,
      etapa: "abertura",
      reexecutavel: false,
    };
  }

  if (consumo.codigo !== "consumida") {
    return { tipo: "aprovacao_indisponivel", requestId: correlacao, codigo: consumo.codigo };
  }

  // O snapshot do desfecho e o MESMO que a RPC gravou na abertura: os
  // valores vem da aprovacao travada e o nivel vem da propria linha de
  // abertura. Nada aqui e recalculado, e nada vem de quem chamou —
  // exceto `userId`, que ja foi usado para escopar tudo acima.
  const { contexto } = consumo;
  const snapshot: SnapshotChamada = {
    userId,
    agenteId: contexto.agenteId,
    requestId: consumo.requestId,
    tarefaId: contexto.tarefaId,
    funcaoId: contexto.funcaoId,
    acesso: contexto.acesso,
    nivelNoMomento: contexto.nivelNoMomento,
    plataforma: contexto.plataforma,
    recurso: contexto.recurso,
    lojaId: contexto.lojaId,
  };

  return executarComAberturaFeita(snapshot, contexto.definicao, contexto.argumentos);
}

// ─── A porta da lane de RETOMADA ──────────────────────────────────────

/**
 * O que esta camada precisa saber para executar uma Funcao cuja abertura
 * JA existe — e nada alem disso.
 *
 * A lista curta e a defesa, pelo mesmo motivo de
 * `EntradaExecucaoFuncao`. Nao entram, e a ausencia e deliberada:
 *
 *   `aprovacaoId`   — a aprovacao ja cumpriu o papel dela antes desta
 *                     camada; quem executa nao decide autorizacao.
 *   `tentativas`/`N`— fencing token do ciclo de vida da TAREFA. Quem
 *                     termina a tarefa precisa dele; quem roda a Funcao,
 *                     nao. Aceita-lo aqui misturaria as duas camadas.
 *   `maxTentativas` — mesma razao.
 *   estado da tarefa, heartbeat — idem.
 *
 * `acesso`, `plataforma` e `recurso` tambem NAO entram: vem da
 * DEFINICAO, como no caminho automatico. Aceita-los de fora deixaria o
 * chamador descrever a propria autorizacao.
 */
export interface EntradaExecucaoFuncaoAprovada {
  userId: string;
  agenteId: string;
  tarefaId: string | null;
  /** Id canonico da Funcao aprovada. A definicao vem do CATALOGO. */
  funcaoId: string;
  lojaId: string | null;
  /** Lido da linha de ABERTURA, nunca recalculado aqui. */
  nivelNoMomento: "automatico" | "aprovacao" | "bloqueado";
  /** O `request_id` do ciclo — o R. Nunca gerado nem trocado aqui. */
  requestId: string;
  /** O snapshot congelado na criacao da aprovacao. */
  argumentos: unknown;
}

/**
 * Executa uma Funcao cuja abertura ja foi gravada, e registra o desfecho.
 *
 * ── Por que esta porta existe ───────────────────────────────────────
 *
 * `executarFuncao` carrega o ciclo inteiro — permissao, aprovacao,
 * abertura — e por isso e da lane normal. `retomarAprovacao` consome a
 * aprovacao pela RPC generica e NAO estabelece o marcador causal da
 * tarefa, entao tambem nao serve a retomada do D5. O que a lane de
 * retomada precisa e do miolo: executar e registrar o desfecho de uma
 * abertura que o start ja criou atomicamente.
 *
 * Esta funcao expoe exatamente esse miolo, e nada mais.
 *
 * ── O que ela NAO faz ───────────────────────────────────────────────
 *
 * Nao abre Tool Call, nao consome aprovacao, nao chama o start, nao
 * mantem heartbeat e nao terminaliza tarefa. Recebe o contexto de uma
 * abertura confirmada e devolve o resultado da execucao; quem chamou
 * decide o que fazer com a TAREFA.
 *
 * ── O R nao e negociavel ────────────────────────────────────────────
 *
 * `requestId` chega pronto e viaja intacto ate o desfecho. Gerar um id
 * aqui gravaria o desfecho numa chamada que nao existe: a unicidade e
 * `(user_id, request_id, fase)`, e um R diferente simplesmente nao
 * encontra a abertura que o start criou.
 *
 * ── `SnapshotChamada` continua privado ──────────────────────────────
 *
 * Ele e montado AQUI dentro. Expo-lo convidaria a forjar snapshot a mao
 * e gravar desfecho sobre chamada alheia — e a forma da linha de
 * auditoria e propriedade de `registro.ts`, nao do chamador.
 */
export async function executarFuncaoAprovada(
  entrada: EntradaExecucaoFuncaoAprovada
): Promise<ResultadoExecucaoFuncao> {
  const { userId, agenteId, funcaoId, requestId } = entrada;

  // Recusa fechada, e sem inventar id: o `requestId` devolvido e o que
  // veio, mesmo vazio. Gerar um aqui criaria correlacao falsa.
  if (!userId || !agenteId || !requestId || !funcaoExiste(funcaoId)) {
    return { tipo: "indisponivel", requestId };
  }

  // Do CATALOGO, como no caminho automatico. A revisao ja foi conferida
  // contra a aprovacao pelo start; aqui a definicao e a autoridade do
  // acesso e do requisito de conexao.
  const definicao: DefinicaoFuncao = FUNCOES[funcaoId];
  const requisito = definicao.conexaoNecessaria;

  const snapshot: SnapshotChamada = {
    userId,
    agenteId,
    requestId,
    tarefaId: entrada.tarefaId,
    funcaoId,
    acesso: definicao.acesso,
    nivelNoMomento: entrada.nivelNoMomento,
    plataforma: requisito === null ? null : requisito.plataforma,
    recurso: requisito === null ? null : requisito.recurso,
    lojaId: entrada.lojaId,
  };

  return executarComAberturaFeita(snapshot, definicao, entrada.argumentos);
}
