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

import { lerAgenteDoDono, lerTarefaDoDono } from "@/lib/agentes/capability";
import { resolverConexoesDoAgente } from "@/lib/agentes/conexoes/agregador";
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
import { autorizarFuncao, type CodigoNegacao } from "@/lib/agentes/funcoes/guard";
import { FUNCOES, funcaoExiste, type DefinicaoFuncao } from "@/lib/agentes/funcoes/registry";
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
  tarefaId?: string | null;
  funcaoId: unknown;
  argumentos: unknown;
}

/**
 * O resultado publico. Seis variantes, e cada uma espelha um estado
 * persistido — ou a ausencia deliberada dele.
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
  | { tipo: "sucesso"; requestId: string; envelope: EnvelopeSucesso; auditoria: "completa" | "incompleta" }
  | { tipo: "negado"; requestId: string; codigo: CodigoNegacaoTerminal }
  | { tipo: "aguardando_aprovacao"; requestId: string; codigo: "aprovacao_necessaria" }
  | { tipo: "erro"; requestId: string; envelope: EnvelopeErro; auditoria: "completa" | "incompleta" }
  | { tipo: "falha_auditoria"; requestId: string; etapa: "abertura" | "desfecho"; reexecutavel: false }
  | { tipo: "indisponivel"; requestId: string };

/** O sub-tipo que os dois auxiliares de erro devolvem. Derivado, nunca
 *  recopiado: acrescentar campo a variante `erro` chega aqui sozinho. */
type ResultadoErro = Extract<ResultadoExecucaoFuncao, { tipo: "erro" }>;

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
  snapshot: Omit<EntradaDesfechoDeExecucao, "status" | "codigo" | "mensagem" | "latenciaMs">,
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
  const permissoes = await resolverFatosPermissoes({ userId, agenteId, funcaoIds: [funcaoId] });
  if (permissoes.coleta !== "ok") {
    return erroSemExecucao(comFuncao, "erro_interno", "erro_interno", MSG_INTERNO, false);
  }

  const fatoPermissao: FatoPermissao | undefined = permissoes.fatos.find((p) => p.funcaoId === funcaoId);
  const nivelNoMomento = fatoPermissao?.nivel ?? null;

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
        { ...comFuncao, nivelNoMomento, plataforma, recurso },
        "erro_interno",
        "erro_interno",
        MSG_INTERNO,
        false
      );
    }
    conexoes = resultado.conexoes;
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
    permissoes: permissoes.fatos,
    conexoes,
  });

  if (!decisao.permitido) {
    if (decisao.estado === "aguardando_aprovacao") {
      await registrarDesfechoSemExecucao({
        ...snapshot,
        status: "aguardando_aprovacao",
        codigo: "aprovacao_necessaria",
      });
      return { tipo: "aguardando_aprovacao", requestId, codigo: "aprovacao_necessaria" };
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
  let validacao;
  try {
    validacao = definicao.validarEntrada(argumentos);
  } catch {
    // O contrato diz que o validador nao lanca. Se lancar, e bug nosso —
    // nao prova de que o argumento estava errado.
    return erroSemExecucao(snapshot, "erro_interno", "erro_interno", MSG_INTERNO, false);
  }

  if (!validacao.valida) {
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
  const abertura = await registrarAbertura({ ...snapshot, idempotencyKey: null });
  if (abertura.estado !== "registrada") {
    return { tipo: "falha_auditoria", requestId, etapa: "abertura", reexecutavel: false };
  }

  // ── 9. Execucao ───────────────────────────────────────────────────
  //
  // O relogio mede a FUNCAO, nao a orquestracao: interpretador, envelope
  // e auditoria ficam de fora.
  const inicio = performance.now();
  let saida: unknown;
  try {
    saida = await definicao.executor({ userId }, argumentos);
  } catch {
    const latenciaMs = Math.round(performance.now() - inicio);
    return erroDeExecucao(snapshot, latenciaMs, "executor_falhou", "executor_falhou", MSG_EXECUTOR, false);
  }
  const latenciaMs = Math.round(performance.now() - inicio);

  // ── 10. Interpretacao ─────────────────────────────────────────────
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

  // ── 11. Envelope ──────────────────────────────────────────────────
  //
  // Duas camadas: `interpretarSaida` e o contrato da Funcao,
  // `envelopeValido` e o contrato generico da CDS. Sem `execution_id` —
  // este executor roda em processo.
  const envelope: EnvelopeSucesso = {
    contrato: VERSAO_CONTRATO,
    ok: true,
    request_id: requestId,
    data: leitura.data,
  };

  if (!envelopeValido(envelope)) {
    return erroDeExecucao(snapshot, latenciaMs, "saida_invalida", "saida_invalida", MSG_SAIDA, false);
  }

  // ── 12. Desfecho ──────────────────────────────────────────────────
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
    requestId,
    envelope,
    auditoria: desfecho.estado === "registrada" ? "completa" : "incompleta",
  };
}
