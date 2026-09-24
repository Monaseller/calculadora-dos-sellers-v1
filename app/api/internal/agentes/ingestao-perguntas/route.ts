/**
 * POST /api/internal/agentes/ingestao-perguntas — M2-I1-A8B-I4C.
 *
 * A porta AGENDADA da ingestao de perguntas. UMA capacidade, e so ela.
 *
 * ── Por que nao usar a ponte generica ───────────────────────────────
 *
 * `/api/internal/agentes/acoes` existe e funciona, e seria tentador
 * registrar mais uma acao no catalogo dela. Nao se faz isso aqui, por
 * tres razoes que nao sao de estilo:
 *
 *   1. AUTORIDADE. A ponte generica recebe `agenteId` do corpo — e o
 *      resolve no banco, mas quem escolhe QUAL agente e quem chama. Uma
 *      varredura agendada nao tem chamador humano para escolher: o
 *      agente e de configuracao, e aceita-lo do corpo daria ao portador
 *      do segredo o poder de varrer a conta de qualquer dono.
 *
 *   2. RECONCILIACAO. A ponte devolve `already_processed` sem dizer o que
 *      aconteceu na primeira vez, porque ela nao tem um registro de ACAO
 *      para consultar — o ledger dela e de Funcao. Sob Schedule, "ja
 *      processado" sem desfecho e inutil: o agendador precisa saber se
 *      deve continuar, repetir ou parar.
 *
 *   3. SUPERFICIE. A ponte carrega catalogo, argumentos por acao e
 *      traducao acao->Funcao. Nada disso existe aqui: nao ha o que
 *      escolher, entao nao ha o que validar, entao nao ha o que burlar.
 *
 * As duas portas continuam separadas, com segredos separados, e a
 * generica continua SEM alcancar `sincronizar_perguntas` — o catalogo
 * dela nao registra essa acao, e ha suite provando que continua assim.
 *
 * ── O que o chamador diz, e o que ele NAO diz ───────────────────────
 *
 * Ele diz DUAS coisas: qual e a intencao (`operationId`) e qual e a
 * execucao dele (`executionId`). Nada mais. O corpo e fechado: uma
 * terceira chave, qualquer que seja, recusa com 400.
 *
 * Recusar em vez de ignorar importa. Aceitar e ignorar `lojaId` ensinaria
 * o cliente a manda-lo, e um dia alguem o leria.
 *
 * O agente, o dono, a loja, a Funcao, a acao, o deslocamento e o prazo
 * sao TODOS do CDS. O deslocamento em particular: ele vem do cursor
 * duravel em `agente_perguntas_continuacao`, nunca do corpo — e por isso
 * a resposta diz apenas SE ha mais, jamais A PARTIR DE ONDE.
 *
 * ── `executionId` e observabilidade, e nada alem ────────────────────
 *
 * Ele nao entra na chave de idempotencia, nao escolhe agente, nao move
 * cursor e nao autoriza tentativa. Duas chamadas com o mesmo
 * `operationId` e `executionId` diferentes sao a MESMA intencao — que e
 * precisamente o caso do retry de transporte, o motivo de a chave ser
 * derivada do `operationId`.
 *
 * ── A ordem: reconciliar ANTES de trabalhar ─────────────────────────
 *
 * Toda chamada le o ledger antes de qualquer coisa que custe. Quando a
 * operacao ja terminou, a resposta vem das linhas — zero provider, zero
 * inbox, zero cursor. Quando ela esta aberta e jovem, a resposta e "esta
 * rodando", e tambem nao custa nada.
 *
 * A corrida entre duas primeiras chamadas NAO e resolvida por essa
 * leitura — as duas podem ler "nao iniciada" no mesmo instante. Quem
 * resolve e o indice unico da abertura, e a perdedora volta a reconciliar
 * em vez de devolver um generico.
 */
import { NextResponse } from "next/server";

import {
  ACAO_SINCRONIZAR_PERGUNTAS,
  type StatusTerminalAcao,
} from "@/lib/agentes/acoes/auditoria-acao";
import { chaveDeIdempotencia } from "@/lib/agentes/acoes/catalogo";
import {
  lerEstadoDaAcaoPorIdempotencia,
  type DesfechoDuravel,
  type EstadoDaAcao,
} from "@/lib/agentes/acoes/leitura-acao";
import { lerAgenteParaAcaoInterna } from "@/lib/agentes/capability-worker";
import { lerIdentidadeDaOperacao } from "@/lib/agentes/ingestao/identidade-operacao";
import { sincronizarPerguntas } from "@/lib/agentes/ingestao/sincronizar-perguntas";

/**
 * O teto do servidor. O orcamento da acao (38 s) cabe dentro com folga —
 * e e ele, nao este numero, que garante o retorno.
 */
export const maxDuration = 60;

/**
 * O provedor, no namespace de idempotencia.
 *
 * O MESMO valor da ponte generica, e adicionado no MESMO lugar: dentro de
 * `chaveDeIdempotencia`. Um `operationId` que ja trouxesse `n8n:` geraria
 * `n8n:n8n:...` — chave que parece certa e nao colide com a primeira —, e
 * e por isso que a gramatica de `identidade-operacao.ts` proibe `:` no
 * bucket. Ha exatamente UMA adicao de namespace em todo o caminho.
 */
const PROVEDOR = "n8n";

/** Teto do `executionId`. Mesmo numero e mesma razao da ponte generica. */
const LIMITE_EXECUTION_ID = 128;

/** As DUAS chaves aceitas, e nenhuma outra. */
const CHAVES_DO_CORPO = ["executionId", "operationId"] as const;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A fronteira entre "ainda pode estar viva" e "nao pode mais".
 *
 * 120 s = duas vezes o corte duro de 60 s do servidor. Acima disso
 * nenhuma execucao daquela abertura pode continuar existindo, porque a
 * plataforma ja a teria matado.
 *
 * NAO e derivada do orcamento de 38 s da acao, e reduzi-la para 38 s
 * seria errado: o orcamento mede o trabalho DEPOIS da abertura, e entre
 * a abertura e o fim do processo ainda cabem a finalizacao e a propria
 * latencia de rede. Encurtar a janela faria uma execucao viva ser
 * declarada desconhecida, e o chamador cunharia uma operacao nova para
 * trabalho que ainda esta acontecendo.
 */
const LIMITE_DA_ORFA_MS = 120_000;

function responder(corpo: unknown, status: number): NextResponse {
  return NextResponse.json(corpo, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

type LeituraCorpo =
  | { ok: true; operationId: string; executionId: string }
  | { ok: false };

/**
 * Le a FORMA do corpo. Fechado nos dois sentidos.
 *
 * A gramatica do `operationId` mora em `identidade-operacao.ts` e e
 * aplicada aqui: um `operationId` sintaticamente valido mas com tentativa
 * acima do teto e recusado pelo MESMO caminho de um corpo malformado —
 * 400, sem trabalho nenhum. O teto e do CDS, e nao depende de o n8n se
 * comportar.
 */
function lerCorpo(bruto: unknown): LeituraCorpo {
  if (typeof bruto !== "object" || bruto === null || Array.isArray(bruto)) {
    return { ok: false };
  }

  const o = bruto as Record<string, unknown>;
  const chaves = Object.keys(o).sort();
  if (JSON.stringify(chaves) !== JSON.stringify([...CHAVES_DO_CORPO])) {
    return { ok: false };
  }

  const executionId = o.executionId;
  if (typeof executionId !== "string") return { ok: false };
  if (executionId.length === 0 || executionId.length > LIMITE_EXECUTION_ID) {
    return { ok: false };
  }

  const identidade = lerIdentidadeDaOperacao(o.operationId);
  if (!identidade.ok) return { ok: false };

  return { ok: true, operationId: identidade.identidade.operationId, executionId };
}

/** O vocabulario de `estado`, derivado do status DURAVEL. Uma traducao so. */
const ESTADO_POR_STATUS: Readonly<Record<StatusTerminalAcao, string>> = {
  sucesso: "executada",
  parcial: "parcial",
  aguardando_aprovacao: "aguardando_aprovacao",
  negado: "negada",
  erro: "erro",
};

/**
 * `ok` diz se a acao FEZ o que se pediu, nao se o HTTP deu certo.
 *
 * `parcial` e `true`: houve varredura, houve gravacao, e sobrou backlog —
 * chamar isso de falha faria o agendador tratar progresso como erro e
 * gastar tentativa a toa.
 */
const OK_POR_STATUS: Readonly<Record<StatusTerminalAcao, boolean>> = {
  sucesso: true,
  parcial: true,
  aguardando_aprovacao: true,
  negado: false,
  erro: false,
};

/**
 * As metricas que ATRAVESSAM a porta.
 *
 * ── Mais estreita que a allowlist do banco, de proposito ────────────
 *
 * `entrada_resumo` guarda escalares de ORQUESTRACAO junto com os de
 * contagem, e os de orquestracao nao podem sair daqui:
 *
 *   `deslocamento_inicial`  e o OFFSET de onde a varredura comecou. O
 *                           CDS e a autoridade de posicao, e o contrato
 *                           diz que a resposta informa SE ha mais, nunca
 *                           A PARTIR DE ONDE. Devolver o numero ensinaria
 *                           quem orquestra a conhece-lo — e o passo
 *                           seguinte, um dia, seria alguem mandar de volta.
 *   `cursor_atualizado`     estado interno do cursor.
 *   `cursor_reiniciado`     idem.
 *   `continuacao_pendente`  ja viaja em `continuacao.pendente`. Repetir
 *                           criaria dois lugares que precisariam
 *                           concordar para sempre.
 *
 * O que fica sao as contagens da varredura e as bandeiras que explicam o
 * desfecho. Nenhuma identifica pergunta, anuncio, conta ou pessoa.
 *
 * A mesma lista vale AO VIVO e no REPLAY, porque a projecao e a mesma
 * funcao — e por isso a equivalencia entre as duas respostas nao depende
 * de ninguem lembrar dela.
 */
const METRICAS_EXPOSTAS: readonly string[] = [
  "paginas", "provider_recebidas", "normalizadas",
  "descartadas_normalizacao", "descartadas_ingestao", "status_inesperados",
  "ingeriveis", "recebidas", "unicas", "duplicadas_no_lote",
  "novas", "atualizadas", "reobservadas",
  "truncado", "limite_atingido", "orcamento_esgotado",
  "auditoria_funcao_incompleta",
];

function metricasVisiveis(
  resumo: Record<string, number | boolean>
): Record<string, number | boolean> {
  const saida: Record<string, number | boolean> = {};
  for (const chave of METRICAS_EXPOSTAS) {
    const valor = resumo[chave];
    if (typeof valor === "number" || typeof valor === "boolean") saida[chave] = valor;
  }
  return saida;
}

/**
 * A UNICA funcao que monta a resposta de um desfecho.
 *
 * AO VIVO ela recebe o par que o servico acabou de gravar; no REPLAY, o
 * par que a leitura trouxe do banco. Sendo a mesma funcao sobre a mesma
 * forma, as duas respostas nao tem como divergir — e a equivalencia
 * exigida pelo contrato deixa de depender de alguem lembrar dela.
 */
function respostaDoDesfecho(
  requestId: string,
  desfecho: DesfechoDuravel,
  replay: boolean
): { corpo: Record<string, unknown>; status: number } {
  const corpo: Record<string, unknown> = {
    ok: OK_POR_STATUS[desfecho.status],
    estado: ESTADO_POR_STATUS[desfecho.status],
    requestId,
    // SEM deslocamento, SEM loja, SEM versao do cursor. O CDS e a
    // autoridade de onde a proxima varredura comeca, e dizer o numero
    // convidaria alguem a devolve-lo um dia.
    continuacao: { pendente: desfecho.resumo.continuacao_pendente === true },
  };
  if (desfecho.codigo !== null) corpo.codigo = desfecho.codigo;
  const metricas = metricasVisiveis(desfecho.resumo);
  if (Object.keys(metricas).length > 0) corpo.metricas = metricas;
  if (replay) corpo.replay = true;
  return { corpo, status: 200 };
}

/** A orfa, classificada pela IDADE do carimbo duravel. */
function respostaDaOrfa(idadeMs: number): { corpo: Record<string, unknown>; status: number } {
  const viva = idadeMs < LIMITE_DA_ORFA_MS;
  return {
    corpo: {
      ok: false,
      estado: viva ? "em_andamento" : "resultado_desconhecido",
      replay: true,
    },
    status: 200,
  };
}

/** Traduz um estado reconciliado em resposta. `nao_iniciada` nao passa por aqui. */
function respostaDaReconciliacao(
  estado: Exclude<EstadoDaAcao, { estado: "nao_iniciada" }>
): { corpo: Record<string, unknown>; status: number } {
  switch (estado.estado) {
    case "concluida":
      return respostaDoDesfecho(estado.requestId, estado.desfecho, true);
    case "aberta":
      return respostaDaOrfa(estado.idadeMs);
    case "conflito":
      // O motivo NAO viaja: ele descreve a forma interna do ledger.
      console.error(`[ingestao-rota] ledger inconsistente (${estado.motivo})`);
      return { corpo: { ok: false, estado: "conflito" }, status: 409 };
    case "falhou_leitura":
      return { corpo: { ok: false, estado: "falha_interna" }, status: 500 };
    default: {
      const _exaustivo: never = estado;
      return _exaustivo;
    }
  }
}

export async function POST(request: Request) {
  // ── 1. Auth fail-closed, com segredo PROPRIO ──────────────────────
  //
  // `N8N_BRIDGE_INTERNAL_SECRET` daria ao portador a ponte generica
  // inteira; `CRON_SECRET`, o worker de tarefas. Nenhum dos dois e o que
  // esta porta precisa, e reusar qualquer um desfaria o isolamento que
  // justifica ela existir.
  //
  // Resposta generica: nao revela se faltou a configuracao do servidor ou
  // o header de quem chamou.
  const segredo = process.env.N8N_INGESTAO_INTERNAL_SECRET;
  const recebido = request.headers.get("x-worker-secret");
  if (!segredo || !recebido || recebido !== segredo) {
    return responder({ ok: false, estado: "nao_autorizado" }, 401);
  }

  let bruto: unknown;
  try {
    bruto = await request.json();
  } catch {
    return responder({ ok: false, estado: "corpo_invalido" }, 400);
  }

  const corpo = lerCorpo(bruto);
  if (!corpo.ok) return responder({ ok: false, estado: "corpo_invalido" }, 400);

  try {
    // ── 2. O AGENTE vem do ambiente, e e revalidado no banco ────────
    //
    // Do ambiente porque quem agenda nao escolhe agente. Revalidado
    // porque uma variavel de ambiente diz um id, nao um fato: o agente
    // pode ter sido apagado ou desligado depois do deploy, e agir por um
    // agente desligado e exatamente o que `ativo` existe para impedir.
    //
    // Toda falha aqui e NOSSA, de configuracao, e nao de quem chamou —
    // por isso 500, e nao 400 nem 404. Um 404 ainda diria a quem chama
    // algo sobre a existencia de um recurso que nao e dele.
    const agenteDoAmbiente = process.env.N8N_INGESTAO_AGENT_ID;
    if (!agenteDoAmbiente || !UUID_REGEX.test(agenteDoAmbiente)) {
      console.error("[ingestao-rota] N8N_INGESTAO_AGENT_ID ausente ou malformada");
      return responder({ ok: false, estado: "configuracao_invalida" }, 500);
    }

    const { agente, erro } = await lerAgenteParaAcaoInterna(agenteDoAmbiente);
    if (erro !== null) {
      console.error("[ingestao-rota] falha ao ler o agente de ingestao");
      return responder({ ok: false, estado: "falha_interna" }, 500);
    }
    if (agente === null || !agente.ativo) {
      console.error("[ingestao-rota] agente de ingestao inexistente ou inativo");
      return responder({ ok: false, estado: "configuracao_invalida" }, 500);
    }

    // ── 3. A chave: UMA composicao, no servidor ─────────────────────
    //
    // A acao e constante deste arquivo — nao ha `resolverAcao(body.acao)`
    // aqui, e nao ha catalogo a consultar. O agente e o do ambiente. So o
    // `operationId` veio de fora, e ele ja passou pela gramatica.
    const chave = chaveDeIdempotencia(
      PROVEDOR,
      corpo.operationId,
      ACAO_SINCRONIZAR_PERGUNTAS,
      agente.agenteId
    );

    const identidadeDaAcao = {
      userId: agente.userId,
      acaoId: ACAO_SINCRONIZAR_PERGUNTAS,
      idempotencyKey: chave,
    } as const;

    // ── 4. Reconciliar ANTES de qualquer trabalho ───────────────────
    const antes = await lerEstadoDaAcaoPorIdempotencia(identidadeDaAcao);
    if (antes.estado !== "nao_iniciada") {
      const { corpo: saida, status } = respostaDaReconciliacao(antes);
      return responder(saida, status);
    }

    // ── 5. Executar. O prazo e criado LA DENTRO ─────────────────────
    //
    // Quem chama nao escolhe deadline: `sincronizarPerguntas` cria os dois
    // relogios a partir de constantes proprias. Um prazo vindo do corpo
    // permitiria pedir uma janela maior que o corte do servidor, e a acao
    // morreria no meio da finalizacao.
    const resultado = await sincronizarPerguntas({
      agenteId: agente.agenteId,
      idempotencyKey: chave,
    });

    if (resultado.tipo === "agente_indisponivel" || resultado.tipo === "chave_ausente") {
      // O agente foi lido e estava ativo ha um instante, e a chave foi
      // montada aqui. Chegar neste ramo e defeito nosso, nao do chamador.
      console.error(`[ingestao-rota] recusa anterior a abertura (${resultado.tipo})`);
      return responder({ ok: false, estado: "falha_interna" }, 500);
    }

    if (resultado.tipo === "abertura_falhou") {
      // FAIL_CLOSED_BEFORE_PROVIDER: nenhuma linha entrou, entao um retry
      // HTTP com o MESMO `operationId` pode tentar de novo — nao ha
      // abertura para bloquea-lo.
      return responder({ ok: false, estado: "abertura_falhou" }, 500);
    }

    if (resultado.tipo === "ja_processado") {
      // ── A CORRIDA ────────────────────────────────────────────────
      //
      // Duas primeiras chamadas leram "nao iniciada" no mesmo instante e
      // as duas tentaram abrir. O indice unico escolheu uma; esta e a
      // outra. O `requestId` que vem aqui e o que ESTA execucao gerou, e
      // nao serve para nada: a execucao real tem outro.
      //
      // Reconciliar de novo e o que transforma a perdedora numa resposta
      // util. Devolver `ja_processado` seria contar que houve corrida,
      // que e um fato sobre NOS, quando o que se perguntou foi sobre a
      // operacao.
      const depois = await lerEstadoDaAcaoPorIdempotencia(identidadeDaAcao);
      if (depois.estado === "nao_iniciada") {
        // A abertura existia o bastante para colidir e nao esta mais
        // visivel. Nao ha leitura que explique isso.
        console.error("[ingestao-rota] colisao sem abertura correspondente");
        return responder({ ok: false, estado: "conflito" }, 409);
      }
      const { corpo: saida, status } = respostaDaReconciliacao(depois);
      return responder(saida, status);
    }

    // ── 6. Desfecho de dominio: 200, inclusive quando `ok` e falso ──
    //
    // Um provider que recusou, uma permissao que falta ou um orcamento
    // que venceu sao RESULTADOS — a rota funcionou e tem o que dizer.
    // Transforma-los em 500 faria o agendador tratar como falha de
    // infraestrutura algo que um retry nao resolve.
    const { corpo: saida, status } = respostaDoDesfecho(
      resultado.requestId,
      resultado.desfechoDuravel,
      false
    );
    return responder(saida, status);
  } catch {
    // Sem inspecionar nem logar o erro: qualquer detalhe daqui e material
    // de reconhecimento.
    return responder({ ok: false, estado: "falha_interna" }, 500);
  }
}
