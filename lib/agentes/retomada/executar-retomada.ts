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
  cancelarAprovacaoRetomadaIncompativel,
  concluirTarefaRetomada,
  descobrirAprovacoesParaRetomada,
  descobrirCandidatasRetomadaStale,
  falharTarefaRetomada,
  iniciarRetomadaAprovacao,
  lerTentativaDaRetomada,
  recuperarRetomadaStale,
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
    }
  /**
   * A guarda de orcamento recusou ABRIR a Tool Call.
   *
   * E uma variante de TOPO, e nao um `MotivoSemInicio`, por uma razao
   * de significado: todo motivo de `sem_inicio` descreve algo que o
   * BANCO ou uma prova local respondeu. Aqui ninguem respondeu nada —
   * a RPC de inicio nem chegou a ser chamada. Colapsar os dois faria
   * o slot confundir "a fila recusou" com "nao havia tempo".
   */
  | { readonly tipo: "orcamento_insuficiente" };

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
 *
 * ── Por que a guarda de orcamento e OBRIGATORIA ─────────────────────
 *
 * `podeIniciarRetomada` nao tem default, e isso e deliberado. Um
 * `= () => true` faria toda chamada futura que esquecesse o argumento
 * COMPILAR e abrir a Tool Call sem folga nenhuma — o modo de falha
 * mais caro desta lane, porque a aprovacao ja foi gasta quando o tempo
 * acaba. Sem default, esquecer nao compila.
 *
 * A guarda e uma funcao, e nao um numero, porque este arquivo nao tem
 * relogio: quem sabe quanto resta e o worker, e ele responde no
 * instante em que a pergunta e feita. Aqui so se pergunta.
 */
export async function executarRetomada(
  userId: string,
  aprovacaoId: string,
  podeIniciarRetomada: () => boolean
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

  // ══ ULTIMO PONTO DE ABORTO SEGURO ═══════════════════════════════════
  //
  // Daqui para tras NADA mutou: as duas leituras acima sao `select`
  // puros e `randomUUID` nao sai do processo. A proxima linha e a que
  // GASTA a aprovacao e abre a Tool Call, e depois dela nao existe mais
  // desistir — so terminalizar.
  //
  // Por isso a guarda e consultada AQUI, e nao no topo da funcao: no
  // topo ela responderia sobre um instante que ja passou, e as oito
  // idas ao banco entre um ponto e outro cabem inteiras dentro da
  // diferenca. Perguntar no ultimo instante possivel e o que transforma
  // a resposta em garantia para todo o pipeline pos-abertura.
  if (!podeIniciarRetomada()) {
    return { tipo: "orcamento_insuficiente" };
  }

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

// ─── O SLOT DE RETOMADA ───────────────────────────────────────────────
//
// ╔══════════════════════════════════════════════════════════════════╗
// ║  DORMENTE. Compila, e nao tem chamador de producao.              ║
// ╚══════════════════════════════════════════════════════════════════╝
//
// O executor acima retoma UMA aprovacao. O slot decide QUAL, e o que
// fazer com as que nao dao para retomar. Ele e a unidade que uma rodada
// de worker vai gastar — por isso tudo aqui e limitado por constante, e
// nao por condicao de parada.

/**
 * Quanto trabalho DURAVEL este slot deixou no banco.
 *
 * Ternario, e nao booleano, porque existe um terceiro estado honesto: a
 * RPC pode ter commitado sem que a resposta chegue. Colapsar `possivel`
 * em `nenhum` faria o worker repetir trabalho ja feito; colapsar em
 * `confirmado` faria contar trabalho que talvez nao exista. Os dois
 * erros sao piores que carregar a duvida.
 */
export type ProgressoDuravelRetomada = "nenhum" | "possivel" | "confirmado";

/** A ordem semantica, e a unica fonte dela. */
const ESCALA_PROGRESSO = ["nenhum", "possivel", "confirmado"] as const;

/**
 * Eleva por MAXIMO, nunca por atribuicao.
 *
 * Toda atualizacao de progresso do slot passa por aqui. E a forma de
 * tornar a monotonicidade uma propriedade do CODIGO e nao da disciplina
 * de quem escreve: nao existe caminho em que `confirmado` volte a
 * `possivel` ou a `nenhum`, porque nao existe atribuicao direta.
 */
function elevarProgresso(
  atual: ProgressoDuravelRetomada,
  novo: ProgressoDuravelRetomada
): ProgressoDuravelRetomada {
  return ESCALA_PROGRESSO.indexOf(novo) > ESCALA_PROGRESSO.indexOf(atual) ? novo : atual;
}

/**
 * As 11 falhas do slot. Nenhuma carrega erro de driver.
 *
 * Elas descrevem ONDE o slot parou, nunca o que o Postgres disse: o
 * adaptador ja reduziu tudo a quatro rotulos e nenhum texto cru
 * atravessa esta camada.
 */
export type FalhaSlotRetomada =
  /** A descoberta de retomadas travadas nao respondeu. */
  | "descoberta_stale_indisponivel"
  /** A recuperacao abortou a transacao: 22023, 55000 ou entrada recusada. */
  | "recuperacao_fora_de_contrato"
  /** A recuperacao pode ter commitado sem responder. */
  | "recuperacao_indisponivel"
  /** A descoberta de aprovacoes candidatas nao respondeu. */
  | "descoberta_aprovacoes_indisponivel"
  /** O cancelamento tecnico abortou a transacao: nada commitou. */
  | "cancelamento_fora_de_contrato"
  /** O cancelamento tecnico pode ter commitado sem responder. */
  | "cancelamento_indisponivel"
  /** A abertura da Tool Call ficou ambigua. */
  | "inicio_ambiguo"
  /** Pos-abertura: um read-back causal nao pode ser lido. */
  | "contexto_incompleto"
  /** Pos-execucao: o desfecho da tarefa nao pode ser registrado. */
  | "desfecho_nao_registrado"
  /** Indisponibilidade de conexao — transitoria, nao reconciliavel. */
  | "motivo_transitorio"
  /** Motivo terminal, ilegivel ou fora do dominio conhecido. */
  | "motivo_fora_do_dominio";

/**
 * O desfecho de UMA rodada de slot.
 *
 * `encerrarPorOrcamento` vive SO no ramo de sucesso, e isso nao e
 * esquecimento: a guarda de orcamento retorna do executor antes de
 * qualquer operacao seguinte, entao o slot encerra com `ok:true` no
 * mesmo instante. Nao ha caminho em que uma falha seja observada DEPOIS
 * de a guarda ter recusado — os dois eventos sao mutuamente exclusivos
 * no tempo, e um campo opcional so esconderia isso.
 */
export type ResultadoSlotRetomada =
  | {
      readonly ok: true;
      readonly desfecho:
        | "retomada_concluida"
        | "retomada_falhou"
        | "recuperacao_duravel"
        | "reconciliado"
        | "sem_progresso"
        | "orcamento_insuficiente"
        | "fila_vazia";
      readonly progressoDuravel: ProgressoDuravelRetomada;
      readonly encerrarPorOrcamento: boolean;
    }
  | {
      readonly ok: false;
      readonly falha: FalhaSlotRetomada;
      readonly progressoDuravel: ProgressoDuravelRetomada;
    };

// ─── Os limites, todos constantes ─────────────────────────────────────
//
// Nenhum deles e condicao de parada calculada: sao tetos. Um `while`
// com condicao e o que permitiria a rodada nao terminar, e a lane de
// retomada nao tem onde absorver isso.

/** Uma candidata travada por rodada. A fila esta ordenada por batimento
 *  mais antigo primeiro, entao a primeira e sempre a mais parada. */
const LIMITE_DESCOBERTA_STALE = 1;
/** Uma recuperacao por rodada, e so. A segunda seria trabalho novo. */
const MAX_RECUPERACOES_POR_SLOT = 1;
/** Cinco aprovacoes examinadas por rodada. */
const LIMITE_DESCOBERTA_APROVACOES = 5;

/**
 * Os 9 motivos que descrevem INCOMPATIBILIDADE PERMANENTE entre a
 * aprovacao e a tarefa dona dela.
 *
 * So estes autorizam o cancelamento tecnico, e o criterio e estreito: o
 * mundo teria de voltar atras para que a retomada passasse a funcionar
 * — o catalogo mudou, a revisao mudou, o acesso mudou, os argumentos
 * nao servem mais. Nada disso se resolve esperando.
 */
const MOTIVOS_RECONCILIAVEIS: ReadonlySet<string> = new Set([
  "contrato_desconhecido",
  "local_funcao_desconhecida",
  "funcao_incompativel",
  "local_revisao_divergente",
  "aprovacao_desatualizada",
  "local_acesso_divergente",
  "escrita_nao_suportada",
  "local_conexao_divergente",
  "local_argumentos_invalidos",
]);

/**
 * Os 12 motivos que NUNCA podem virar cancelamento.
 *
 * Duas familias moram aqui. Uns sao reversiveis — permissao revogada,
 * agente fora do ar, aprovacao ainda pendente: amanha funcionam.
 * Outros sao terminais ja resolvidos por outra mao — `ja_consumida`,
 * `ja_cancelada`, `expirada`: cancelar seria escrever por cima de uma
 * decisao que ja existe. Nos dois casos o slot observa e segue.
 */
const MOTIVOS_SEM_CANCELAMENTO: ReadonlySet<string> = new Set([
  "aprovacao_inexistente",
  "agente_indisponivel",
  "tarefa_indisponivel",
  "aprovacao_pendente",
  "ja_consumida",
  "ja_rejeitada",
  "ja_cancelada",
  "expirada",
  "permissao_ausente",
  "permissao_bloqueada",
  "tarefa_incompativel",
  "tarefa_ausente",
]);

/**
 * Os 2 motivos de conexao indisponivel.
 *
 * Fora de `MOTIVOS_RECONCILIAVEIS` de proposito: uma conexao fora do ar
 * volta, e cancelar por causa dela destruiria uma aprovacao legitima.
 * Encerram a rodada porque a indisponibilidade tende a ser global — a
 * proxima candidata bateria na mesma parede.
 *
 * Hoje sao INALCANCAVEIS: o unico contrato Resume tem
 * `conexaoNecessaria: null`. Existem para que o segundo contrato nao
 * nasca sem politica.
 */
const MOTIVOS_TRANSITORIOS: ReadonlySet<string> = new Set([
  "conexao_indisponivel",
  "local_conexao_indisponivel",
]);

/**
 * Retoma ate uma aprovacao, e reconcilia o que encontrar no caminho.
 *
 * ── O que ele recebe, e por que so isso ─────────────────────────────
 *
 * `podeIniciarRetomada` e a UNICA dependencia de quem chama. Nao ha
 * deadline, nem instante de inicio, nem orcamento: este arquivo nao
 * tem relogio, e o slot repassa a MESMA referencia ao executor, sem
 * embrulhar. Um `() => podeIniciarRetomada()` no meio pareceria
 * inofensivo e romperia a identidade que a suite verifica.
 *
 * ── A ordem, e por que ela e essa ───────────────────────────────────
 *
 * Primeiro o que ja esta em curso e travou, depois o que espera na
 * fila. Retomada travada e uma tarefa em `rodando` com marcador: ela
 * ocupa lugar e nao anda. Deixar para depois seria preferir comecar
 * trabalho novo a destravar o antigo.
 */
export async function executarSlotRetomada(
  podeIniciarRetomada: () => boolean
): Promise<ResultadoSlotRetomada> {
  let progressoDuravel: ProgressoDuravelRetomada = "nenhum";
  let houveRecuperacaoDuravel = false;
  let houveReconciliacao = false;

  /** O desfecho de manutencao, quando nenhuma retomada completou. A
   *  precedencia e a mesma em todos os pontos de saida, entao ela mora
   *  em um lugar so. */
  const desfechoDeManutencao = (
    semTrabalho: "sem_progresso" | "fila_vazia"
  ): "reconciliado" | "recuperacao_duravel" | "sem_progresso" | "fila_vazia" => {
    if (houveReconciliacao) return "reconciliado";
    if (houveRecuperacaoDuravel) return "recuperacao_duravel";
    return semTrabalho;
  };

  // ── 1. Retomadas travadas, no maximo uma ───────────────────────────
  const travadas = await descobrirCandidatasRetomadaStale(LIMITE_DESCOBERTA_STALE);
  if (!travadas.ok) {
    // ERRO NAO E FILA VAZIA. Seguir para a fila de aprovacoes aqui
    // trataria "nao consegui olhar" como "nao ha nada", e a rodada
    // comecaria trabalho novo sobre um banco que acabou de recusar uma
    // leitura.
    return { ok: false, falha: "descoberta_stale_indisponivel", progressoDuravel };
  }

  if (travadas.candidatas.length > 0) {
    const travada = travadas.candidatas[0];
    const recuperacao = await recuperarRetomadaStale(
      travada.tarefaId,
      travada.userId,
      travada.tentativa,
      travada.retomadaRequestId
    );

    if (!recuperacao.ok) {
      if (
        recuperacao.falha === "rpc_indisponivel" ||
        recuperacao.falha === "resposta_invalida"
      ) {
        // A RPC de recuperacao MUTA. Sem resposta util, nao se sabe se
        // ela commitou — e o worker precisa dessa duvida para nao
        // contar a rodada como estéril.
        progressoDuravel = elevarProgresso(progressoDuravel, "possivel");
        return { ok: false, falha: "recuperacao_indisponivel", progressoDuravel };
      }
      // 22023 e 55000 abortam a transacao inteira: nada commitou.
      return { ok: false, falha: "recuperacao_fora_de_contrato", progressoDuravel };
    }

    if (
      recuperacao.codigo === "execucao_incerta" ||
      recuperacao.codigo === "execucao_ja_ocorrida_resultado_indisponivel"
    ) {
      // Os dois terminalizaram a tarefa travada. O trabalho ficou no
      // banco, e ficou por conta DESTA rodada.
      progressoDuravel = elevarProgresso(progressoDuravel, "confirmado");
      houveRecuperacaoDuravel = true;
    }
    // `entrada_invalida`, `nao_stale` e `causal_incompativel` nao
    // escreveram nada. Nenhuma segunda candidata e buscada: o teto e um,
    // e a fila esta ordenada pelo batimento mais antigo — se a primeira
    // nao estava travada pelo relogio do BANCO, nenhuma atras dela esta.
  }

  // ── 2. Aprovacoes candidatas, no maximo cinco ──────────────────────
  const fila = await descobrirAprovacoesParaRetomada(LIMITE_DESCOBERTA_APROVACOES);
  if (!fila.ok) {
    // FALHA TARDIA NAO APAGA PROGRESSO: se a recuperacao acima gravou,
    // isso continua verdade mesmo que a fila nao responda.
    return { ok: false, falha: "descoberta_aprovacoes_indisponivel", progressoDuravel };
  }

  if (fila.candidatas.length === 0) {
    return {
      ok: true,
      desfecho: desfechoDeManutencao("fila_vazia"),
      progressoDuravel,
      encerrarPorOrcamento: false,
    };
  }

  // ── 3. Caminhada limitada pelas candidatas, na ordem recebida ──────
  //
  // `for…of` sobre uma lista que ja veio limitada pelo banco: nao ha
  // condicao de parada para calcular errado, nao ha cursor, nao ha
  // segunda descoberta. O teto e o tamanho da lista.
  for (const candidata of fila.candidatas) {
    const resultado = await executarRetomada(
      candidata.userId,
      candidata.aprovacaoId,
      podeIniciarRetomada
    );

    // ── 3a. A Tool Call abriu e o ciclo terminou ────────────────────
    if (resultado.tipo === "concluida") {
      progressoDuravel = elevarProgresso(progressoDuravel, "confirmado");
      return {
        ok: true,
        desfecho: "retomada_concluida",
        progressoDuravel,
        encerrarPorOrcamento: false,
      };
    }
    if (resultado.tipo === "falhou") {
      // Falha da TAREFA e desfecho registrado, nao falha do slot: a
      // tentativa foi consumida e o banco sabe disso.
      progressoDuravel = elevarProgresso(progressoDuravel, "confirmado");
      return {
        ok: true,
        desfecho: "retomada_falhou",
        progressoDuravel,
        encerrarPorOrcamento: false,
      };
    }
    if (resultado.tipo === "contexto_incompleto") {
      progressoDuravel = elevarProgresso(progressoDuravel, "confirmado");
      return { ok: false, falha: "contexto_incompleto", progressoDuravel };
    }
    if (resultado.tipo === "indisponivel") {
      progressoDuravel = elevarProgresso(progressoDuravel, "confirmado");
      return { ok: false, falha: "desfecho_nao_registrado", progressoDuravel };
    }

    // ── 3b. A abertura ficou ambigua ────────────────────────────────
    if (resultado.tipo === "inicio_ambiguo") {
      // Pode haver uma Tool Call aberta que ninguem vai fechar nesta
      // rodada. Tentar a proxima candidata arriscaria uma SEGUNDA
      // abertura sobre um banco em estado desconhecido, e a recuperacao
      // de travadas existe exatamente para observar isso depois.
      progressoDuravel = elevarProgresso(progressoDuravel, "possivel");
      return { ok: false, falha: "inicio_ambiguo", progressoDuravel };
    }

    // ── 3c. A guarda recusou abrir ──────────────────────────────────
    if (resultado.tipo === "orcamento_insuficiente") {
      // Nada mutou nesta candidata. O que ja tinha sido feito antes
      // continua valendo, e e ele que nomeia o desfecho.
      return {
        ok: true,
        desfecho: houveReconciliacao
          ? "reconciliado"
          : houveRecuperacaoDuravel
            ? "recuperacao_duravel"
            : "orcamento_insuficiente",
        progressoDuravel,
        encerrarPorOrcamento: true,
      };
    }

    // ── 3d. Nao abriu, e a aprovacao continua la ────────────────────
    const motivo: string = resultado.motivo;

    if (MOTIVOS_SEM_CANCELAMENTO.has(motivo)) {
      // Reversivel ou ja resolvido por outra mao. Observa e segue.
      continue;
    }

    if (MOTIVOS_TRANSITORIOS.has(motivo)) {
      return { ok: false, falha: "motivo_transitorio", progressoDuravel };
    }

    if (!MOTIVOS_RECONCILIAVEIS.has(motivo)) {
      // FAIL-CLOSED, e nao `continue`. Um motivo que nao esta em
      // nenhum dos tres conjuntos e um motivo sem politica — inclusive
      // um que ainda nao existe. Seguir a caminhada seria decidir por
      // omissao o que este gate existe para decidir por escrito.
      return { ok: false, falha: "motivo_fora_do_dominio", progressoDuravel };
    }

    // ── 3e. Incompatibilidade permanente: reconciliar ───────────────
    const cancelamento = await cancelarAprovacaoRetomadaIncompativel(
      candidata.userId,
      candidata.aprovacaoId
    );

    if (!cancelamento.ok) {
      if (
        cancelamento.falha === "rpc_indisponivel" ||
        cancelamento.falha === "resposta_invalida"
      ) {
        progressoDuravel = elevarProgresso(progressoDuravel, "possivel");
        return { ok: false, falha: "cancelamento_indisponivel", progressoDuravel };
      }
      return { ok: false, falha: "cancelamento_fora_de_contrato", progressoDuravel };
    }

    if (cancelamento.codigo === "cancelada") {
      progressoDuravel = elevarProgresso(progressoDuravel, "confirmado");
      houveReconciliacao = true;
    } else if (cancelamento.codigo === "expirada") {
      // AMBIGUO POR CONSTRUCAO: a RPC expira por TTL antes de decidir, e
      // devolve o mesmo codigo tanto quando ela propria acabou de
      // escrever quanto quando a linha ja estava expirada. Sem forma de
      // separar os dois, `possivel` e a unica leitura honesta.
      progressoDuravel = elevarProgresso(progressoDuravel, "possivel");
      houveReconciliacao = true;
    }
    // Os outros seis codigos sao observacao de estado terminal ou de
    // corrida: ninguem escreveu nada NESTA chamada. Segue a caminhada.
  }

  // ── 4. A lista acabou sem completar retomada nenhuma ───────────────
  //
  // `sem_progresso` e nao `fila_vazia`: havia trabalho para olhar, e ele
  // foi olhado. A distincao importa para o worker, que trata fila vazia
  // como motivo para parar a rodada.
  return {
    ok: true,
    desfecho: desfechoDeManutencao("sem_progresso"),
    progressoDuravel,
    encerrarPorOrcamento: false,
  };
}
