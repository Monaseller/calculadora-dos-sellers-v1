/**
 * APPROVAL-DECISION-RESUME-D5-C3-I1 — o executor da lane de RETOMADA.
 *
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  MODULO DORMENTE. Compila, e nao tem chamador de producao.       ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * ── O que esta peca faz, em uma frase ───────────────────────────────
 *
 * Pega UMA aprovacao ja decidida por um humano e termina o trabalho que
 * a tarefa tinha comecado: consome a aprovacao, executa a Funcao
 * aprovada e encerra a tarefa — sem nunca voltar para o caminho
 * generico, que nao conhece o marcador da retomada.
 *
 * ── As duas lanes sao disjuntas POR CONSTRUCAO ──────────────────────
 *
 * A lane normal exige `retomada_request_id IS NULL`; esta exige
 * igualdade com um request nao vazio. Nenhuma linha satisfaz as duas.
 * E por isso que este arquivo nao importa `executar-tarefa.ts` nem
 * `capability-worker.ts`: os terminalizadores de la cercam por
 * `(id, status, tentativas)` e NAO conhecem o marcador — como a
 * retomada PRESERVA a tentativa N, uma tarefa retomada satisfaz as tres
 * cercas deles e seria aceita em silencio.
 *
 * ── A ordem NAO e estilo ────────────────────────────────────────────
 *
 *   pre-read da Approval  ─┐
 *   tipo da Task           │  nada disso mutou nada ainda;
 *   contrato do tipo       │  desistir aqui nao custa aprovacao,
 *   validacao local        │  nao abre Tool Call e nao move tarefa
 *   preparar entrada      ─┘
 *   gerar R               ── so agora existe uma correlacao
 *   iniciarRetomada       ── A PARTIR DAQUI a aprovacao foi gasta
 *   read-back da abertura  ─┐
 *   read de N por R        │  contexto causal; sem ele NAO se executa
 *   heartbeat             ─┘
 *   executarFuncaoAprovada
 *   mapper
 *   clearInterval           (encerra o AGENDAMENTO; ver a secao 11)
 *   terminalizador dedicado
 *
 * ── PROVENIENCIA DOS ARGUMENTOS — D5-C3-I1-A0-F1 ────────────────────
 *
 * `prepararEntrada` recebe `aprovacao.argumentos`, e SO isso. Nao
 * `tarefa.entrada`, nao um contexto reconstruido.
 *
 * O motivo e que `agente_funcao_aprovacoes.argumentos` e o snapshot que
 * o humano aprovou e que a RPC de inicio recompara por revisao. A
 * entrada da tarefa descreve o PEDIDO; os argumentos descrevem a ACAO
 * AUTORIZADA, e e a acao autorizada que a retomada existe para
 * terminar.
 *
 * O docblock de `ContratoResume.prepararEntrada` diz "le a entrada crua
 * da linha da tarefa" porque, quando foi escrito, o caminho automatico
 * era a unica proveniencia existente. Para `consultar_vendas` as duas
 * formas coincidem: o handler automatico monta
 * `{ dataInicio, dataFim, marketplace }`, que sao exatamente as tres
 * chaves aceitas pelo leitor, e a forma normalizada passa nele
 * produzindo o mesmo objeto. Essa coincidencia NAO e garantida pelo
 * contrato, e por isso ela e REQUISITO DE TESTE enquanto o achado
 * D5-C3-I1-A0-F1 estiver aberto: a suite compara o payload de negocio
 * dos dois caminhos. Alinhar aquele docblock e divida documental
 * registrada a parte — os modulos de contrato estao congelados aqui.
 *
 * ── HIGIENE DE ERRO, vinculante ─────────────────────────────────────
 *
 * `err.message` NAO e lido. Nem `details`, nem `hint`, nem `stack`, nem
 * `cause`, nem `envelope.error.*`. A classificacao usa a uniao
 * DISCRIMINADA `ResultadoExecucaoFuncao` e `instanceof` — as duas
 * fechadas — e toda mensagem persistida e literal fixo ou reconstruida
 * a partir de valor conferido por membership.
 *
 * Isso existe porque `ErroEnvelope.code` e `string` aberto: ele nasce
 * em `ResultadoInterpretacaoSaida.codigo`, que nasce em
 * `ResultadoVendas.erro` — tres camadas seguidas sem vocabulario. Uma
 * whitelist por FORMATO aceitaria `funcao_erro:<qualquer_coisa>`; nao
 * ler o texto fecha a classe inteira de problema em vez de filtra-la.
 */
import "server-only";
import { randomUUID } from "node:crypto";

import {
  lerAprovacaoParaRetomada,
  lerNivelDaAberturaDeRetomada,
  type DetalheRecusaAprovacao,
} from "@/lib/agentes/aprovacoes/persistencia";
import { lerTarefaDoDono } from "@/lib/agentes/capability";
import { ErroEntradaTarefa, PausaPorAprovacao } from "@/lib/agentes/erros";
import {
  executarFuncaoAprovada,
  type ResultadoExecucaoFuncao,
} from "@/lib/agentes/execucao-funcoes/executar";
import { FUNCOES, funcaoExiste } from "@/lib/agentes/funcoes/registry";
import {
  concluirTarefaRetomada,
  falharTarefaRetomada,
  iniciarRetomadaAprovacao,
  lerTentativaDaRetomada,
  registrarHeartbeatRetomada,
  type CodigoRetomadaInicio,
} from "@/lib/agentes/retomada/persistencia-retomada";
import { resolverContratoResume } from "@/lib/agentes/resume-contratos";
import type { TipoErroTarefa } from "@/lib/agentes/tipos-execucao";

// ─── Contrato de saida ────────────────────────────────────────────────

/**
 * Por que os motivos sao uniao fechada, e nao `string`.
 *
 * Os 16 codigos de recusa do banco sao DERIVADOS de
 * `CodigoRetomadaInicio`, nunca redigitados: um codigo novo na RPC
 * chega aqui sozinho. Os locais levam prefixo `local_` para nao colidir
 * com homonimos do banco — `conexao_indisponivel` existe dos dois
 * lados, e sao fatos diferentes: um e a usabilidade que a aplicacao
 * julgou, o outro e o vinculo que o lock reconferiu.
 */
export type MotivoSemInicio =
  | Exclude<CodigoRetomadaInicio, "consumida">
  | "contrato_desconhecido"
  | "tarefa_ausente"
  | "tipo_ilegivel"
  | "aprovacao_ilegivel"
  | "local_funcao_desconhecida"
  | "local_revisao_divergente"
  | "local_acesso_divergente"
  | "local_conexao_divergente"
  | "local_conexao_indisponivel"
  | "local_argumentos_invalidos"
  | "rpc_entrada_invalida"
  | "rpc_fora_de_contrato";

/**
 * O desfecho de UMA retomada.
 *
 * `sem_inicio` e `inicio_ambiguo` sao coisas MUITO diferentes e por
 * isso nao se colapsam: no primeiro, nada aconteceu e a aprovacao
 * continua la; no segundo, nao se sabe se a RPC commitou, e por isso
 * nenhuma Funcao roda e nenhum terminalizador e chamado.
 *
 * `indisponivel` significa que a Funcao JA rodou e o desfecho da tarefa
 * nao pode ser registrado — a tarefa fica em `rodando` com o marcador,
 * que e exatamente o estado que `retomada_recuperar_tarefa_stale`
 * existe para observar depois de 5 minutos.
 */
export type ResultadoRetomada =
  | { readonly tipo: "concluida" }
  | { readonly tipo: "falhou"; readonly erroTipo: TipoErroTarefa }
  | { readonly tipo: "sem_inicio"; readonly motivo: MotivoSemInicio }
  | {
      readonly tipo: "inicio_ambiguo";
      readonly motivo: "rpc_indisponivel" | "resposta_invalida";
    }
  | {
      readonly tipo: "contexto_incompleto";
      readonly motivo: "abertura_ilegivel" | "tarefa_ilegivel";
    }
  | {
      readonly tipo: "indisponivel";
      readonly motivo: "conclusao_nao_registrada" | "falha_nao_registrada";
    };

// ─── Mensagens persistidas — TODAS fixas ──────────────────────────────
//
// Elas vao para `agente_tarefas.erro_mensagem`. Nenhuma carrega texto
// de excecao, de Funcao ou de driver; nenhuma carrega id, argumento ou
// resultado. `approvalId` deliberadamente NAO aparece na mensagem de
// pausa: o vinculo ja e `agente_funcao_aprovacoes.tarefa_id`.

const MSG_PAUSA = "retomada: pausa por aprovacao apos consumo";
const MSG_ENTRADA = "retomada: entrada aprovada invalida";
const MSG_FUNCAO_ERRO = "retomada: funcao retornou erro";
const MSG_BOUNDARY = "retomada: boundary recusou a entrada";
const MSG_DRIFT = "retomada: resultado fora do contrato";
const MSG_INTERNA = "retomada: falha interna inesperada";

// ─── Etapas de auditoria: membership REAL, com prova de exaustividade ─

/** Derivada do tipo publico, nunca redigitada. */
type EtapaAuditoria = Extract<
  ResultadoExecucaoFuncao,
  { tipo: "falha_auditoria" }
>["etapa"];

const ETAPAS_AUDITORIA = ["abertura", "desfecho"] as const satisfies readonly EtapaAuditoria[];

/**
 * A prova que o `satisfies` sozinho NAO da.
 *
 * `satisfies readonly EtapaAuditoria[]` garante que todo item da lista
 * pertence ao tipo — mas nao que a lista COBRE o tipo. Uma terceira
 * etapa nasceria sem quebrar nada, e a reconstrucao abaixo passaria a
 * recusar em silencio um valor legitimo.
 *
 * `EtapasNaoCobertas` fica `never` enquanto a cobertura for total.
 * `Exato<T extends never>` so aceita `never`, entao uma terceira etapa
 * futura NAO COMPILA aqui — que e o alarme que se quer.
 */
type EtapasNaoCobertas = Exclude<EtapaAuditoria, (typeof ETAPAS_AUDITORIA)[number]>;
type Exato<T extends never> = T;
type _ProvaDeCoberturaDasEtapas = Exato<EtapasNaoCobertas>;

/**
 * Membership de RUNTIME, e nao apenas de tipo.
 *
 * O compilador afirma que `resultado.etapa` e uma das duas; o runtime
 * nao. Uma resposta fabricada chega como string qualquer, e sem esta
 * checagem ela seria interpolada direto na coluna persistida.
 */
function etapaConhecida(valor: unknown): valor is EtapaAuditoria {
  return typeof valor === "string" && (ETAPAS_AUDITORIA as readonly string[]).includes(valor);
}

// ─── Traducao das recusas do pre-read ─────────────────────────────────

/**
 * O `detalhe` fino do pre-read vira motivo desta lane.
 *
 * `Record<DetalheRecusaAprovacao, ...>` e obrigatorio e nao decorativo:
 * um detalhe novo no helper compartilhado deixa este mapa incompleto e
 * o arquivo para de compilar, em vez de cair num `default` silencioso.
 */
const MOTIVO_POR_DETALHE: Record<DetalheRecusaAprovacao, MotivoSemInicio> = {
  entrada_invalida: "entrada_invalida",
  leitura_indisponivel: "aprovacao_ilegivel",
  inexistente: "aprovacao_ilegivel",
  identidade_invalida: "aprovacao_ilegivel",
  funcao_desconhecida: "local_funcao_desconhecida",
  revisao_divergente: "local_revisao_divergente",
  acesso_divergente: "local_acesso_divergente",
  conexao_divergente: "local_conexao_divergente",
  argumentos_invalidos: "local_argumentos_invalidos",
  conexao_indisponivel: "local_conexao_indisponivel",
};

// ─── Heartbeat ────────────────────────────────────────────────────────

/**
 * 15 s, contra o corte de orfa de 5 minutos da lane de retomada
 * (`interval '5 minutes'` em `retomada_recuperar_tarefa_stale`) — 20
 * batidas perdidas antes de a retomada ser considerada abandonada.
 *
 * ── Por que NAO importar `INTERVALO_HEARTBEAT_MS` ───────────────────
 *
 * Porque aquela constante mora em `executar-tarefa.ts`, junto de
 * `concluirTarefa`, `falharTarefa` e `aguardarAprovacaoTarefa`.
 * Importa-la traria os tres para o grafo de modulos desta lane — e a
 * lista de imports proibidos existe exatamente para impedir isso. Um
 * `import` de constante e uma dependencia de verdade, nao um detalhe.
 *
 * A duplicacao e DECLARADA, no mesmo padrao que
 * `consultar-vendas-contrato.ts` ja usa para nao descongelar
 * `analise-vendas.ts`: a suite compara os dois valores e reprova se
 * divergirem. A duplicacao fica conferida, nao silenciosa.
 *
 * Exportada para que a suite verifique o VALOR, e nao um regex sobre a
 * fonte.
 */
export const INTERVALO_HEARTBEAT_RETOMADA_MS = 15_000;

// ─── O executor ───────────────────────────────────────────────────────

/**
 * Retoma UMA aprovacao aprovada por um humano.
 *
 * Contrato de entrada estreito de proposito: o dono e a aprovacao. Nem
 * tarefa, nem tentativa, nem Funcao, nem definicao — tudo isso e
 * consequencia, e aceitar qualquer um deles de quem chama seria deixar
 * o chamador descrever o proprio fencing.
 */
export async function executarRetomada(
  userId: string,
  aprovacaoId: string
): Promise<ResultadoRetomada> {
  // ── 1. Pre-read da Approval ────────────────────────────────────────
  //
  // Mesma fonte que o caminho generico usa. As provas locais (catalogo,
  // revisao, acesso, requisito de conexao, argumentos, usabilidade da
  // conexao) acontecem LA DENTRO — repeti-las aqui criaria o segundo
  // validador que o D5-C3-I1-A0-R1 recusou.
  const pre = await lerAprovacaoParaRetomada({ userId, aprovacaoId });
  if (!pre.ok) return { tipo: "sem_inicio", motivo: MOTIVO_POR_DETALHE[pre.detalhe] };
  const ap = pre.aprovacao;

  // ── 2. A retomada exige tarefa causal ──────────────────────────────
  //
  // Funcao sem tarefa e caso legitimo do caminho generico, mas nao aqui:
  // nao ha o que retomar. A RPC tambem recusaria, com
  // `tarefa_incompativel`; parar antes evita gastar a aprovacao.
  if (ap.tarefaId === null) return { tipo: "sem_inicio", motivo: "tarefa_ausente" };
  const tarefaId = ap.tarefaId;

  // ── 3. O TIPO da tarefa, lido da LINHA CAUSAL ──────────────────────
  //
  // Nunca derivado de `funcaoId`: `funcaoId -> tipo` nao e injetivo por
  // contrato, e um registry reverso mentiria no dia em que dois tipos
  // usassem a mesma Funcao. `lerTarefaDoDono` cerca por `id` e
  // `user_id` e NAO tem a cerca de marcador da lane normal.
  //
  // O valor lido aqui e EXPECTED VALUE. A autoridade e a RPC, sob lock:
  // se a tarefa mudar entre esta leitura e o start, o bloco 10 daquela
  // funcao devolve `tarefa_incompativel` antes de qualquer escrita.
  const tarefa = await lerTarefaDoDono(tarefaId, userId);
  if (tarefa.erro !== null || tarefa.linha === null) {
    return { tipo: "sem_inicio", motivo: "tipo_ilegivel" };
  }
  const tipoTarefa = tarefa.linha.tipo;
  if (typeof tipoTarefa !== "string" || tipoTarefa.length === 0) {
    return { tipo: "sem_inicio", motivo: "tipo_ilegivel" };
  }

  // ── 4. O contrato daquele tipo ─────────────────────────────────────
  const contrato = resolverContratoResume(tipoTarefa);
  if (contrato === null) return { tipo: "sem_inicio", motivo: "contrato_desconhecido" };

  // ── 5. A definicao, do CATALOGO ────────────────────────────────────
  //
  // O pre-read ja provou existencia e igualdade de revisao/acesso. As
  // duas conferencias abaixo sao CRUZADAS: elas comparam o que o helper
  // devolveu contra o catalogo lido aqui, e quebram se as duas fontes
  // deixarem de concordar.
  if (!funcaoExiste(ap.funcaoId)) {
    return { tipo: "sem_inicio", motivo: "local_funcao_desconhecida" };
  }
  const definicao = FUNCOES[ap.funcaoId];
  if (ap.revisao !== definicao.revisao) {
    return { tipo: "sem_inicio", motivo: "local_revisao_divergente" };
  }
  if (ap.acesso !== definicao.acesso) {
    return { tipo: "sem_inicio", motivo: "local_acesso_divergente" };
  }

  // ── 6. A entrada aprovada, preparada ANTES do start ────────────────
  //
  // Se `prepararEntrada` recusar, nada foi consumido: sem aprovacao
  // gasta, sem Tool Call, sem tarefa movida.
  let entradaPreparada;
  try {
    entradaPreparada = contrato.prepararEntrada(ap.argumentos);
  } catch {
    return { tipo: "sem_inicio", motivo: "local_argumentos_invalidos" };
  }

  // ── 7. So agora existe uma correlacao ──────────────────────────────
  //
  // R vira, ao mesmo tempo, `agente_funcao_aprovacoes.request_id_consumo`,
  // `agente_funcao_chamadas.request_id` e
  // `agente_tarefas.retomada_request_id`. Nao ha Tool Call UUID: a
  // identidade E o R.
  const requestId = randomUUID();

  const inicio = await iniciarRetomadaAprovacao(
    userId,
    aprovacaoId,
    requestId,
    definicao.revisao,
    tipoTarefa,
    contrato.funcaoId
  );

  if (!inicio.ok) {
    // `rpc_indisponivel` e `resposta_invalida` sao AMBIGUOS: a RPC pode
    // ter commitado. Nenhuma Funcao, nenhum terminalizador, nenhum
    // retry — a recuperacao de stale observa depois.
    if (inicio.falha === "rpc_indisponivel" || inicio.falha === "resposta_invalida") {
      console.error("[agentes-retomada] inicio de retomada ficou ambiguo");
      return { tipo: "inicio_ambiguo", motivo: inicio.falha };
    }
    // 22023 e 55000 abortam a transacao inteira: nada commitou.
    return { tipo: "sem_inicio", motivo: inicio.falha };
  }
  if (inicio.codigo !== "consumida") {
    return { tipo: "sem_inicio", motivo: inicio.codigo };
  }

  // ══ A PARTIR DAQUI a aprovacao FOI GASTA e a Tool Call esta aberta ══

  // ── 8. Read-back causal da abertura ────────────────────────────────
  //
  // O nivel vem da ABERTURA, nunca de `agente_permissoes`: reler a
  // permissao seria uma segunda leitura, em outro instante, e o desfecho
  // passaria a afirmar sobre a chamada um nivel diferente do que a
  // abertura dela afirma.
  const nivelNoMomento = await lerNivelDaAberturaDeRetomada(userId, requestId);
  if (nivelNoMomento === null) {
    console.error("[agentes-retomada] abertura da retomada ilegivel");
    return { tipo: "contexto_incompleto", motivo: "abertura_ilegivel" };
  }

  // ── 9. N autoritativo, cercado pelo R deste ciclo ──────────────────
  const leituraN = await lerTentativaDaRetomada(tarefaId, userId, requestId);
  if (!leituraN.ok) {
    console.error("[agentes-retomada] tentativa da retomada ilegivel");
    return { tipo: "contexto_incompleto", motivo: "tarefa_ilegivel" };
  }
  const tentativas = leituraN.tentativas;

  // ══ CONTEXTO CAUSAL COMPLETO. So agora se executa. ══════════════════

  // ── 10. Heartbeat ──────────────────────────────────────────────────
  let baticaoEmVoo = false;
  const bater = async (): Promise<void> => {
    if (baticaoEmVoo) return;
    baticaoEmVoo = true;
    try {
      // O wrapper ja captura e classifica; aqui so garantimos que
      // NENHUMA rejeicao escape. Os tres desfechos possiveis
      // (`renovado`, `sem_correspondencia`, `indisponivel`) sao
      // OBSERVACIONAIS: batimento nunca terminaliza, nunca re-tenta e
      // nunca interrompe a Funcao.
      await registrarHeartbeatRetomada(tarefaId, userId, tentativas, requestId);
    } catch {
      /* best-effort: batida perdida nao interrompe a execucao */
    } finally {
      baticaoEmVoo = false;
    }
  };

  const timerHeartbeat: ReturnType<typeof setInterval> = setInterval(() => {
    void bater();
  }, INTERVALO_HEARTBEAT_RETOMADA_MS);
  (timerHeartbeat as unknown as { unref?: () => void }).unref?.();

  // ── 11. A Funcao, pela boundary aprovada ───────────────────────────
  //
  // `try/finally` para que o AGENDAMENTO pare no instante em que a
  // Funcao termina, e nao so no fim da funcao inteira.
  //
  // ── O que `clearInterval` faz, e o que ele NAO faz ───────────
  //
  // Ele impede NOVOS ticks. Ele NAO interrompe um tick que ja comecou:
  // se `baticaoEmVoo` estiver true neste ponto, aquele
  // `registrarHeartbeatRetomada` continua em voo e pode alcancar o
  // banco DEPOIS do terminalizador. Dizer que o batimento "terminou
  // antes da transicao" seria afirmar mais do que o cancelamento
  // entrega.
  //
  // ── Por que o tick tardio e inofensivo ────────────────────
  //
  // O UPDATE do heartbeat tem UM campo no SET (`heartbeat_em`) e cinco
  // cercas no WHERE: tarefa, dono, `status = 'rodando'`, N e R. Logo:
  //
  //   terminalizador primeiro   o status deixa de ser `rodando` e o tick
  //                             casa ZERO linhas (`sem_correspondencia`).
  //   tick primeiro             renova `heartbeat_em` com a tarefa ainda
  //                             em `rodando`; o terminalizador casa
  //                             normalmente logo depois.
  //
  // O bloqueio de linha do Postgres serializa os dois. Em nenhuma das
  // ordens o tick reabre a tarefa ou altera status, resultado, erro ou
  // marcador — nada disso esta no SET, e as tres colunas causais so
  // aparecem no WHERE.
  //
  // ── O unico efeito residual, e o limite dele ────────────────
  //
  // Se o terminalizador dedicado FALHAR e o tick tardio vencer, a
  // tarefa fica em `rodando` com `heartbeat_em` renovado, e a janela de
  // 5 minutos de `retomada_recuperar_tarefa_stale` passa a contar
  // daquele instante. E no maximo UM tick ja iniciado — mas QUANTO
  // tempo ele leva para terminar depende da latencia real da escrita, e
  // nao existe timeout provado nesta lane. O limite TEMPORAL fica
  // registrado como NAO PROVADO; a corrida e aceita como segura porque
  // o estado terminal nunca e corrompido, nao porque seja curta.
  //
  // Aguardar o tick antes de terminalizar foi recusado de proposito:
  // acoplaria a terminalizacao a uma escrita OBSERVACIONAL e criaria um
  // bloqueio pior que a corrida que evitaria.
  //
  // A boundary e dona do desfecho da Tool Call; este executor NAO chama
  // `registrarDesfechoDeExecucao`.
  let resultadoFuncao: ResultadoExecucaoFuncao | null = null;
  try {
    resultadoFuncao = await executarFuncaoAprovada({
      userId,
      agenteId: ap.agenteId,
      tarefaId,
      funcaoId: contrato.funcaoId,
      lojaId: ap.lojaId,
      nivelNoMomento,
      requestId,
      argumentos: ap.argumentos,
    });
  } catch {
    // A boundary nao lanca hoje. Se lancar, isto nao vira excecao solta:
    // a tarefa ja esta em `rodando` com o marcador e PRECISA ser
    // encerrada pela lane dela.
    resultadoFuncao = null;
  } finally {
    clearInterval(timerHeartbeat);
  }

  if (resultadoFuncao === null) {
    return terminalizarFalha(tarefaId, userId, "erro_interno", MSG_INTERNA, tentativas, requestId);
  }

  // ── 12. O MESMO mapper do caminho automatico ───────────────────────
  let payload: Record<string, unknown> | null = null;
  let falha: { erroTipo: TipoErroTarefa; mensagem: string } | null = null;
  try {
    payload = contrato.continuarAposFuncao(resultadoFuncao, entradaPreparada);
  } catch (err) {
    falha = classificarFalha(resultadoFuncao, err);
  }

  // Devolver sem ser sucesso e quebra de contrato do mapper: as seis
  // outras variantes LANCAM. Aceitar o payload aqui concluiria uma
  // tarefa cuja Funcao nao teve sucesso.
  if (falha === null && resultadoFuncao.tipo !== "sucesso") {
    falha = { erroTipo: "erro_interno", mensagem: MSG_DRIFT };
  }

  if (falha !== null) {
    return terminalizarFalha(
      tarefaId,
      userId,
      falha.erroTipo,
      falha.mensagem,
      tentativas,
      requestId
    );
  }

  // ── 13. Sucesso, pelo terminalizador DEDICADO ──────────────────────
  const conclusao = await concluirTarefaRetomada(
    tarefaId,
    userId,
    payload ?? {},
    tentativas,
    requestId
  );
  if (!conclusao.ok) {
    // Sem fallback generico. `concluir_tarefa` nao conhece o marcador e
    // aceitaria esta linha em silencio — o CHECK do banco admite
    // `concluido` com marcador nao-nulo.
    console.error("[agentes-retomada] conclusao da retomada nao registrada");
    return { tipo: "indisponivel", motivo: "conclusao_nao_registrada" };
  }
  return { tipo: "concluida" };
}

// ─── Classificacao de falha ───────────────────────────────────────────

/**
 * Traduz o que aconteceu num par (erroTipo, mensagem) SEGURO.
 *
 * ── A regra que este corpo existe para nao violar ───────────────────
 *
 * `err.message` nao e lido. A decisao vem de `resultado.tipo` — uniao
 * discriminada fechada — e de `instanceof` sobre duas classes nossas.
 * O unico texto que nao e literal fixo e `falha_auditoria:${etapa}`,
 * reconstruido a partir de um valor conferido por membership real.
 *
 * A precedencia e contrato: `PausaPorAprovacao` primeiro, porque ela
 * pode subir de um resultado de SUCESSO e nao e falha do mapper.
 */
function classificarFalha(
  resultado: ResultadoExecucaoFuncao,
  err: unknown
): { erroTipo: TipoErroTarefa; mensagem: string } {
  // A. Pausa pedida DEPOIS do consumo. Nao se cria segunda aprovacao,
  //    nao se pausa a tarefa de novo: a acao ja foi autorizada e ja
  //    rodou. E erro terminal desta lane.
  if (err instanceof PausaPorAprovacao) {
    return { erroTipo: "handler_falhou", mensagem: MSG_PAUSA };
  }

  switch (resultado.tipo) {
    case "erro":
      // B/C. `ErroEntradaTarefa` e o veredicto do validador
      //      autoritativo, ja classificado pelo mapper. O codigo dele
      //      NAO e copiado: ele viaja em `err.message`, e essa lane nao
      //      le mensagem de excecao.
      return err instanceof ErroEntradaTarefa
        ? { erroTipo: "entrada_invalida", mensagem: MSG_ENTRADA }
        : { erroTipo: "handler_falhou", mensagem: MSG_FUNCAO_ERRO };

    case "falha_auditoria":
      // D. A etapa importa e e vocabulario fechado, provado por
      //    membership de runtime. Valor fora do conjunto nao vira texto.
      return etapaConhecida(resultado.etapa)
        ? { erroTipo: "handler_falhou", mensagem: `falha_auditoria:${resultado.etapa}` }
        : { erroTipo: "erro_interno", mensagem: MSG_INTERNA };

    case "indisponivel":
      // E. A boundary recusou a entrada fail-closed. Depois de um start
      //    confirmado isso e defeito nosso, nao situacao de negocio.
      return { erroTipo: "erro_interno", mensagem: MSG_BOUNDARY };

    case "negado":
    case "aguardando_aprovacao":
    case "aprovacao_indisponivel":
      // F. Inalcancaveis pela boundary: nascem em `executarFuncao`,
      //    antes da abertura. Aparecer aqui e DRIFT de contrato, e
      //    dar-lhes representacao fiel seria normalizar a quebra.
      return { erroTipo: "erro_interno", mensagem: MSG_DRIFT };

    case "sucesso":
      // G. O mapper lancou algo que nao e pausa sobre um resultado de
      //    sucesso — saida fora do contrato da Funcao, por exemplo.
      return { erroTipo: "erro_interno", mensagem: MSG_INTERNA };

    default: {
      // H. Exaustividade: uma oitava variante para de compilar aqui.
      const _exaustivo: never = resultado;
      void _exaustivo;
      return { erroTipo: "erro_interno", mensagem: MSG_INTERNA };
    }
  }
}

// ─── Terminalizacao dedicada ──────────────────────────────────────────

/**
 * Encerra em `erro` pela RPC da lane, e por nenhuma outra.
 *
 * `falharTarefa` esta fora de alcance de proposito: ele devolveria a
 * tarefa para `pendente` enquanto houvesse tentativa, e o caminho
 * generico criaria uma aprovacao nova para uma acao JA EXECUTADA — ou a
 * executaria direto, se a permissao tiver virado `automatico`. Vale
 * igual para `N < max` e para `N == max`.
 */
async function terminalizarFalha(
  tarefaId: string,
  userId: string,
  erroTipo: TipoErroTarefa,
  mensagem: string,
  tentativas: number,
  requestId: string
): Promise<ResultadoRetomada> {
  const r = await falharTarefaRetomada(
    tarefaId,
    userId,
    erroTipo,
    mensagem,
    tentativas,
    requestId
  );
  if (!r.ok) {
    console.error("[agentes-retomada] falha da retomada nao registrada");
    return { tipo: "indisponivel", motivo: "falha_nao_registrada" };
  }
  return { tipo: "falhou", erroTipo };
}
