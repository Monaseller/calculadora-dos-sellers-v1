/**
 * Executor de UMA tarefa de agente — AGENTES-FASE1C.
 *
 * ── A regra central, herdada do Estudio ─────────────────────────────
 * Esta peca NAO decide sequencia. Nao existe "proxima tarefa": um
 * agente nao tem pipeline. Ela valida, executa UM handler e chama
 * EXATAMENTE UMA das duas RPCs terminais — `concluir_tarefa` ou
 * `falhar_tarefa`, nunca as duas, nunca nenhuma.
 *
 * A garantia de "nunca as duas" nao depende do cuidado deste arquivo:
 * as RPCs exigem `status = 'rodando'` e LANCAM fora disso, entao a
 * primeira a rodar tira a tarefa do estado e a segunda falharia. O
 * fluxo abaixo tem um unico ponto de saida por caminho, e o banco e a
 * rede de seguranca.
 *
 * ── Sem IA, sem rede, sem marketplace ───────────────────────────────
 * Nenhum import de `ai-gateway`, provedor, SDK ou cliente HTTP. Os
 * handlers desta fase sao deterministicos e offline. A suite prova isso
 * por varredura de import, nao por confianca.
 *
 * ── HEARTBEAT PERIODICO — e por que ele mora AQUI ───────────────────
 * O claim considera orfa toda tarefa em `rodando` cujo `heartbeat_em`
 * passou de 5 minutos, e a devolve a fila. Para que isso signifique
 * "o worker morreu" — e nao "o handler esta demorando" — alguem precisa
 * bater o heartbeat DURANTE a execucao, em intervalo fixo.
 *
 * Esse alguem e este modulo, nao o worker. O worker e execucao unica:
 * ele reivindica, chama esta rota por HTTP e espera. Enquanto espera,
 * ele nao tem como saber que o handler ainda esta vivo. Quem sabe e
 * quem esta com o handler na mao.
 *
 *   HEARTBEAT (15 s, fixo)  — prova de vida. Continua mesmo quando o
 *                             progresso NAO muda.
 *   PROGRESSO (0/50/100)    — informacao do handler. Muda quando ele diz.
 *
 * Sao conceitos RELACIONADOS, nao identicos: os dois viajam na mesma
 * escrita (`registrarProgresso` grava `heartbeat_em` + `progresso`),
 * mas o batimento nao depende de o progresso ter mudado. Antes desta
 * correcao o heartbeat so acontecia quando o handler relatava progresso
 * — e um handler que trabalhasse 6 minutos sem relatar nada seria
 * reivindicado por outro worker estando vivo, quebrando exatamente a
 * premissa que a protecao de orfa documenta.
 *
 * O timer e best-effort e nunca derruba o handler: falha de escrita e
 * registrada e ignorada, a promise e sempre consumida (nada de rejection
 * nao tratada), e uma batida nao comeca se a anterior ainda estiver em
 * voo. `clearInterval` acontece em `finally` — inclusive quando o
 * handler lanca.
 */
import "server-only";
import {
  concluirTarefa,
  falharTarefa,
  lerTarefaParaExecucao,
  registrarProgresso,
} from "@/lib/agentes/capability-worker";
import { ErroTipoTarefaDesconhecido, resolverHandler } from "@/lib/agentes/handlers/registry";
// AGENTES-FASE1D-b: a classe saiu de `handlers/teste-fundacao.ts` para
// uma casa neutra. O executor nao pode depender de um handler de teste.
import { ErroEntradaTarefa } from "@/lib/agentes/erros";
import type {
  ContextoTarefa,
  ResultadoExecucao,
  TipoErroTarefa,
} from "@/lib/agentes/tipos-execucao";

export interface RespostaExecucao {
  status: number;
  corpo: ResultadoExecucao | { ok: false; erro: string };
}

/**
 * Intervalo do heartbeat, em milissegundos.
 *
 * 15 s contra um limite de orfa de 5 min (`interval '5 minutes'` em
 * `20260917_agentes_execucao.sql`) — 20 batidas perdidas antes de a
 * tarefa ser considerada abandonada. A folga e proposital: como a
 * semantica e AT-LEAST-ONCE, ressuscitar cedo demais significa executar
 * duas vezes.
 *
 * Exportado para que a suite verifique o VALOR, nao um regex sobre a
 * fonte. Alterar este numero sem alterar o limite da migration quebra a
 * relacao 20x — e a suite falha, de proposito.
 */
export const INTERVALO_HEARTBEAT_MS = 15_000;

/** Traduz a excecao do handler numa das 4 categorias fechadas. */
function classificarErro(err: unknown): TipoErroTarefa {
  if (err instanceof ErroTipoTarefaDesconhecido) return "tipo_desconhecido";
  if (err instanceof ErroEntradaTarefa) return "entrada_invalida";
  if (err instanceof Error) return "handler_falhou";
  return "erro_interno";
}

/** Mensagem segura: truncada e sem objeto cru. */
function mensagemSegura(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 300);
  return "erro desconhecido";
}

/**
 * Executa a tarefa `tarefaId`, que o worker ACABOU de reivindicar.
 *
 * O contrato de entrada e estreito de proposito: um id, e so. Nao
 * recebe `user_id` (o worker nao tem sessao) nem cliente Supabase (a
 * capability interna resolve isso).
 */
export async function executarTarefa(tarefaId: string): Promise<RespostaExecucao> {
  const inicio = Date.now();

  const { linha: tarefa, erro: erroLeitura } = await lerTarefaParaExecucao(tarefaId);

  if (erroLeitura) {
    // Falha de infraestrutura ANTES de saber o que executar. Nao chama
    // `falhar_tarefa`: sem ter lido a tarefa, nao ha garantia de que ela
    // esteja em `rodando`, e chamar a RPC lancaria por cima do erro
    // real. A tarefa fica em `rodando` e a recuperacao de orfa a
    // devolve a fila em 5 minutos — que e exatamente o caso para o qual
    // aquele mecanismo existe.
    return { status: 500, corpo: { ok: false, erro: erroLeitura } };
  }
  if (!tarefa) {
    return { status: 404, corpo: { ok: false, erro: "tarefa_nao_encontrada" } };
  }

  // O claim ja pos a tarefa em `rodando`. Qualquer outro estado aqui
  // significa que alguem chamou esta rota fora do ciclo — recusa
  // fechada, sem tocar no estado.
  if (tarefa.status !== "rodando") {
    return { status: 409, corpo: { ok: false, erro: "tarefa_nao_esta_em_rodando" } };
  }

  const contexto: ContextoTarefa = {
    tarefaId: tarefa.id,
    agenteId: tarefa.agente_id,
    // Vem da LINHA, nunca do chamador. A FK composta da 1B ja garantiu
    // que este `user_id` e o dono do agente.
    userId: tarefa.user_id,
    tipo: tarefa.tipo,
    entrada: (tarefa.entrada ?? {}) as Record<string, unknown>,
    tentativa: tarefa.tentativas,
    maxTentativas: tarefa.max_tentativas,
  };

  // ── Heartbeat + progresso ────────────────────────────────────────
  // `progressoAtual` e o ULTIMO valor conhecido: e ele que o batimento
  // periodico reenvia quando o handler nao relatou nada. Sem isso o
  // heartbeat teria de inventar um numero, ou nao existir.
  let progressoAtual = 0;
  let ultimoPersistido = -1;
  // Guarda de reentrada: se a escrita anterior ainda nao voltou, a
  // proxima batida e PULADA em vez de enfileirada. Sem isso, um banco
  // lento acumularia UPDATEs concorrentes na mesma linha.
  let baticaoEmVoo = false;

  const bater = async (valor: number): Promise<void> => {
    if (baticaoEmVoo) return;
    baticaoEmVoo = true;
    try {
      // A capability ja captura e classifica o erro; aqui so garantimos
      // que NENHUMA rejeicao escape — uma unhandled rejection derrubaria
      // o processo por causa de um batimento perdido.
      await registrarProgresso(tarefa.id, valor);
    } catch {
      /* best-effort: heartbeat perdido nunca interrompe o handler */
    } finally {
      baticaoEmVoo = false;
    }
  };

  const relatarProgresso = (progresso: number) => {
    const valor = Math.trunc(progresso);
    progressoAtual = valor;
    // So escreve quando o valor MUDA — o batimento periodico cuida do
    // resto. `void` explicito: a promise e deliberadamente nao aguardada.
    if (valor === ultimoPersistido) return;
    ultimoPersistido = valor;
    void bater(valor);
  };

  // Comeca IMEDIATAMENTE antes do handler e bate a cada 15 s enquanto
  // ele durar, mudando o progresso ou nao.
  const timerHeartbeat: ReturnType<typeof setInterval> = setInterval(() => {
    void bater(progressoAtual);
  }, INTERVALO_HEARTBEAT_MS);
  // Nao segura o event loop do Node: se o processo quiser encerrar, um
  // timer pendente nao deve adiar isso.
  (timerHeartbeat as unknown as { unref?: () => void }).unref?.();

  let resultado: Record<string, unknown>;
  try {
    // `try/finally` ANINHADO de proposito: o timer e limpo no instante
    // em que o handler termina — com sucesso OU lancando —, ANTES de
    // qualquer RPC terminal. Um `finally` la fora deixaria o batimento
    // vivo durante `falharTarefa`/`concluirTarefa`, e uma batida
    // atrasada chegaria depois da transicao.
    try {
      // ── BINDING DE TENANT — AGENTES-FASE1D-d ──────────────────────
      // Resolver depende do TIPO; construir depende do DONO. O registry
      // devolve uma fabrica, e o dono entra AQUI.
      //
      // `tarefa.user_id` vem da LINHA que o claim reivindicou, validada
      // pela FK composta da 1B. Nunca de `contexto.entrada`, nunca de um
      // `user_id` enviado no corpo, nunca de query.
      //
      // A rota interna usa SOMENTE `tarefa_id` como dado de selecao da
      // execucao. Campo extra que venha no JSON simplesmente nao
      // participa de nada aqui — nao ha caminho pelo qual ele alcance o
      // binding de tenant. Note a diferenca: ele e IGNORADO, nao
      // rejeitado; a rota nao valida a forma do corpo alem de exigir um
      // `tarefa_id` que passe no `UUID_REGEX`.
      //
      // Nao ha fallback: se o dono faltasse, a capability recusa com
      // `user_id_ausente` em vez de ler dado de alguem.
      const construirHandler = resolverHandler(tarefa.tipo);
      const handler = construirHandler(tarefa.user_id);
      resultado = await handler(contexto, relatarProgresso);
    } finally {
      clearInterval(timerHeartbeat);
    }
  } catch (err) {
    const erroTipo = classificarErro(err);
    const { linha, erro: erroRpc } = await falharTarefa(tarefa.id, erroTipo, mensagemSegura(err));

    if (erroRpc) {
      return { status: 500, corpo: { ok: false, erro: erroRpc } };
    }
    // 200 com `ok: false`: a falha do HANDLER foi registrada com
    // sucesso. O worker precisa distinguir "a tarefa falhou e o banco
    // sabe disso" de "nao consegui nem registrar a falha".
    return {
      status: 200,
      corpo: {
        ok: false,
        tarefaId: tarefa.id,
        status: linha?.status ?? "erro",
        erroTipo,
        tempoMs: Date.now() - inicio,
      },
    };
  }

  const { linha, erro: erroConclusao } = await concluirTarefa(tarefa.id, resultado);
  if (erroConclusao) {
    return { status: 500, corpo: { ok: false, erro: erroConclusao } };
  }

  return {
    status: 200,
    corpo: {
      ok: true,
      tarefaId: tarefa.id,
      status: linha?.status ?? "concluido",
      erroTipo: null,
      tempoMs: Date.now() - inicio,
    },
  };
}
