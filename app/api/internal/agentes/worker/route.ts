/**
 * GET /api/internal/agentes/worker — FUNCTION-RUNTIME-V1-B1.
 *
 * O DISPATCHER da fila de agentes. Alvo do Vercel Cron.
 *
 * ── O problema que ele resolve ──────────────────────────────────────
 *
 * `criarTarefa` faz a tarefa nascer `pendente`; `executarTarefa` so
 * aceita `rodando`; e a unica transicao entre os dois e
 * `claim_next_agente_tarefa()`. Ate aqui, o unico chamador dessa RPC
 * era `scripts/agentes-worker.mjs` — manual, execucao unica, exigindo
 * um terminal aberto. Na pratica: toda tarefa enfileirada ficava parada
 * ate alguem rodar o script a mao, inclusive as do Chat ja publicado.
 *
 * Esta rota fecha esse buraco sem migration: a RPC ja existe, ja esta
 * aplicada e ja tem os grants certos.
 *
 * ── Por que o claim GLOBAL e correto AQUI ───────────────────────────
 *
 * `claim_next_agente_tarefa()` devolve a tarefa elegivel mais antiga de
 * QUALQUER dono. Isso seria um defeito grave numa rota de usuario — o
 * clique de um reivindicaria a tarefa de outro. E e exatamente o que se
 * quer de um dispatcher: drenar a fila por ordem de chegada, sem
 * privilegiar quem clicou por ultimo. A fronteira e esta rota, e a
 * porta e o `CRON_SECRET`.
 *
 * O tenant nao se perde no caminho: o claim so devolve o `id`, e
 * `executarTarefa` le a LINHA e passa `tarefa.user_id` ao registry, que
 * o fecha na closure do handler.
 *
 * ── Precedente ──────────────────────────────────────────────────────
 *
 * `app/api/internal/estudio-anuncios/worker/route.ts`, deployado e
 * observado em producao a cada 60 s: mesma auth por `Bearer`, mesmo
 * laco com orcamento temporal, claim e execucao no MESMO processo.
 * Nada aqui e padrao novo.
 *
 * ── O que esta rota NAO faz ─────────────────────────────────────────
 *
 * Nao bate em `/api/internal/agentes/executar` (um salto de rede e um
 * segundo timeout dentro do orcamento, sem ganho). Nao mantem
 * heartbeat: `executarTarefa` ja e a autoridade disso. Nao recupera
 * orfa: o proprio claim ja considera `rodando` com batimento vencido ha
 * mais de 5 minutos. Nao trava nada em memoria: serverless nao garante
 * processo unico, e quem impede claim duplo e o `FOR UPDATE SKIP
 * LOCKED` da RPC. E nao decide Approval.
 *
 * ── Por que o laco NAO foi extraido para uma funcao injetavel ───────
 *
 * A tentativa foi feita no F1: `drenarFila(reivindicar, executar)`
 * exportada daqui, para que a suite executasse a rodada com dubles em
 * vez de conferir a fonte. O Next 14 RECUSA — MEDIDO, nao suposto:
 *
 *     .next/types/.../worker/route.ts: Property 'drenarFila' is
 *     incompatible with index signature. Type '(...)' is not
 *     assignable to type 'never'.
 *
 * Um modulo de producao novo so para o seam foi descartado por estar
 * fora do escopo autorizado do F1. A propriedade NO SAME-RUN RETRY fica
 * provada por ESTRUTURA do fluxo (secao S2 de
 * `scripts/testar-agentes-execucao.ts`: ha um unico ponto de claim, ele
 * antecede a guarda, nada depois dela reivindica, e nao existe
 * `continue` no arquivo) mais a sonda de mutacao que troca `break` por
 * `continue` e exige a suite vermelha.
 */
import { NextResponse } from "next/server";

import { reivindicarProximaTarefa } from "@/lib/agentes/capability-worker";
import { executarTarefa } from "@/lib/agentes/executar-tarefa";
import { executarSlotRetomada } from "@/lib/agentes/retomada/executar-retomada";

/** Mesmo teto do worker do Estudio, ja aceito e operando neste projeto
 *  (plano Pro). `vercel.json` repete o valor — os dois tem de casar. */
export const maxDuration = 300;

/**
 * Orcamento do laco: 80% do teto. Os 60 s restantes cobrem cold start,
 * resolucao de rede, encerramento e o overhead da plataforma. Nunca
 * consumir 100% do limite.
 */
const ORCAMENTO_MS = 240_000;

/**
 * Folga exigida ANTES de reivindicar a proxima tarefa.
 *
 * E o custo estimado da tarefa mais cara que o runtime produz hoje:
 * `vendas.consultar` pode paginar ate 50 paginas de 1000 linhas. A
 * folga cobre o PIOR caso, nao o medido — reivindicar sem ela deixaria
 * a tarefa em `rodando` com a funcao cortada no meio, e ela so voltaria
 * a fila 5 minutos depois.
 */
const FOLGA_MINIMA_MS = 90_000;

/**
 * Teto NOMINAL, alem do temporal.
 *
 * O orcamento sozinho nao basta: `teste_fundacao` roda em
 * milissegundos, e uma unica invocacao drenaria a fila inteira. Com
 * cron de 1 minuto, 5 tarefas por rodada sao 300/hora — ordens de
 * grandeza acima do uso atual, e ainda assim um limite revisavel.
 *
 * Sem env configuravel nesta versao: comportamento deterministico vale
 * mais do que flexibilidade que ninguem pediu.
 */
const MAX_TASKS_PER_RUN = 5;

/**
 * O teto de TURNOS, e por que ele e derivado.
 *
 * `processados` conta trabalho DURAVEL, e existe turno que nao produz
 * nenhum: a fila de retomada pode ter candidatas que todas recusam
 * abrir, e a lane normal pode vir vazia. Sem um segundo teto, uma
 * rodada em que as duas lanes alternam sem produzir nada rodaria ate o
 * orcamento acabar — girando, nao trabalhando.
 *
 * Duas voltas completas por vaga e o suficiente: cada vaga de trabalho
 * tem direito a uma tentativa de cada lane. Derivado de
 * `MAX_TASKS_PER_RUN` de proposito — um literal `10` seria uma segunda
 * fonte que envelheceria sozinha se a primeira mudasse.
 */
const MAX_TURNOS_PER_RUN = 2 * MAX_TASKS_PER_RUN;

function responder(corpo: unknown, status: number): NextResponse {
  return NextResponse.json(corpo, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function GET(request: Request) {
  // ── Auth fail-closed ──────────────────────────────────────────────
  //
  // Mesma guarda de `/api/sync` e do worker do Estudio: resposta
  // generica, sem revelar se o que faltou foi a configuracao do
  // servidor ou o header de quem chamou. Somente `Authorization:
  // Bearer` — esta rota nao aceita segredo por query, por body nem por
  // `x-worker-secret`.
  const segredo = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization");
  if (!segredo || !auth || auth !== `Bearer ${segredo}`) {
    return responder({ ok: false, erro: "nao_autorizado" }, 401);
  }

  const inicio = Date.now();

  /**
   * A UNICA fonte de orcamento da rodada.
   *
   * A inequacao existe uma vez so, e por dois motivos. O primeiro e
   * obvio: duas copias divergem. O segundo e o que importa — esta mesma
   * funcao e passada ao slot de retomada, que a repassa ao executor e a
   * consulta no ultimo instante antes de gastar uma aprovacao. Se o
   * `while` perguntasse por uma formula e o slot por outra, o worker
   * estaria prometendo uma folga que o executor nao teria.
   *
   * E uma FUNCAO, e nao um numero, porque a resposta muda com o tempo:
   * quem pergunta quer saber se ha folga AGORA, nao quanto havia quando
   * a rodada comecou.
   */
  const podeIniciarNovoTrabalho = () =>
    Date.now() - inicio < ORCAMENTO_MS - FOLGA_MINIMA_MS;

  let processados = 0;
  let turnos = 0;
  /** A rodada abre pela RETOMADA. Uma tarefa em `rodando` com marcador
   *  ocupa vaga e nao anda; comecar por trabalho novo seria preferir a
   *  fila cheia a fila travada. */
  let proximaLane: "retomada" | "normal" = "retomada";
  /** Quantas lanes consecutivas responderam TRUE EMPTY. Com alternancia
   *  estrita, duas seguidas provam que as duas filas estao vazias. */
  let emptyStreak = 0;

  try {
    // ── O laco, limitado por TRABALHO, por TURNOS e por TEMPO ────────
    //
    // Os tres valem juntos. `processados` limita trabalho durável;
    // `turnos` impede a rodada de girar sem produzir; o orcamento impede
    // que ela comece algo que nao ha tempo de terminar. As tres sao
    // avaliadas ANTES de cada turno — nunca depois.
    while (
      processados < MAX_TASKS_PER_RUN &&
      turnos < MAX_TURNOS_PER_RUN &&
      podeIniciarNovoTrabalho()
    ) {
      // PRIMEIRA instrucao do corpo, sem ramo e sem `await` antes dela.
      // Um turno que sai por qualquer caminho ja foi contado — e e isso
      // que torna o teto de turnos uma garantia de terminacao, e nao uma
      // intencao.
      turnos += 1;

      if (proximaLane === "retomada") {
        // ── LANE RETOMADA ─────────────────────────────────────────
        //
        // O slot recebe a MESMA referencia que o `while` consulta. Um
        // `() => podeIniciarNovoTrabalho()` aqui pareceria inofensivo e
        // criaria uma segunda funcao com a mesma aritmetica — que e
        // exatamente o que o D0 existe para nao ter.
        const r = await executarSlotRetomada(podeIniciarNovoTrabalho);

        // Trabalho DURAVEL consome uma vaga, e a decisao olha SO o grau
        // de progresso. `ok:false` com progresso `possivel` consumiu
        // vaga tanto quanto um sucesso: a RPC pode ter commitado, e
        // contar zero faria a rodada repetir trabalho que talvez exista.
        if (r.progressoDuravel !== "nenhum") {
          processados += 1;
        }

        // TRUE EMPTY da retomada e um unico desfecho. `sem_progresso`
        // NAO e vazio: havia candidatas, elas foram examinadas, e
        // nenhuma produziu trabalho — confundir os dois encerraria a
        // rodada com a fila normal ainda cheia.
        const vazioResume =
          r.ok === true && r.desfecho === "fila_vazia";
        emptyStreak = vazioResume ? emptyStreak + 1 : 0;

        proximaLane = "normal";

        // BREAK EXPLICITO. `Date.now()` e relogio de parede, nao
        // monotonico: confiar na proxima avaliacao do `while` seria
        // apostar que o relogio nao andou para tras. O slot ja disse que
        // nao ha folga; a rodada acaba aqui.
        if (r.ok === true && r.encerrarPorOrcamento) break;

        if (emptyStreak >= 2) break;
      } else {
        // ── LANE NORMAL — semantica historica preservada ───────────
        const { tarefa, erro: erroClaim } = await reivindicarProximaTarefa();

        if (erroClaim) {
          // Falha do claim: nao ha tarefa reivindicada e nada a executar.
          // Parar — insistir no mesmo erro dentro da mesma invocacao nao
          // muda o resultado, e a proxima rodada do cron tenta de novo.
          return responder({ ok: false, processados, erro: "dispatcher_falhou" }, 500);
        }

        proximaLane = "retomada";

        if (tarefa === null) {
          // Fila vazia: encerramento NORMAL, sem execucao e sem retry.
          emptyStreak += 1;
          if (emptyStreak >= 2) break;
        } else {
          emptyStreak = 0;

          const { status, corpo } = await executarTarefa(tarefa.tarefaId);

          // ── OS QUATRO DESFECHOS, e o que cada um decide ─────────
          //
          // `executarTarefa` devolve 200 sempre que a tarefa chegou a um
          // desfecho REGISTRADO no banco. Sao tres, e eles NAO se
          // comportam igual:
          //
          //   A. 200, `ok: true`,  `concluido`            -> conta, CONTINUA
          //   B. 200, `ok: true`,  `aguardando_aprovacao` -> conta, CONTINUA
          //   C. 200, `ok: false`  (falha ja gravada)     -> conta, ENCERRA
          //   D. 404 / 409 / 500                          -> falha OPERACIONAL
          //
          // A e B drenam a fila: a tarefa saiu dela. A pausada some do
          // predicado do claim por conta propria — o dispatcher nao
          // aprova, nao rejeita, nao consome e nao retoma.
          if (status !== 200) {
            // D. 404 (tarefa sumiu), 409 (nao estava em `rodando`) ou 500
            // (infra): o executor nao levou a tarefa a desfecho nenhum. A
            // tentativa NAO conta, e a rodada para sem reivindicar outra.
            return responder({ ok: false, processados, erro: "dispatcher_falhou" }, 500);
          }

          // Chegou a um desfecho registrado. Vale para A, B e C —
          // inclusive C, onde a falha do handler ja esta gravada.
          processados += 1;

          // ── C: a rodada acaba AQUI (V1B1-I1-M1) ───────────────
          //
          // `falhar_tarefa` devolve a tarefa para `pendente` enquanto
          // `tentativas < max_tentativas`, e o claim entrega sempre a
          // elegivel MAIS ANTIGA. Continuando o laco, a mesma tarefa
          // voltava a ser a mais antiga e era reivindicada de novo na
          // MESMA invocacao:
          //
          //     claim tentativa 1 -> falha -> pendente
          //     claim tentativa 2 -> falha -> pendente
          //     claim tentativa 3 -> falha -> erro      (tudo em segundos)
          //
          // Tres tentativas numa rajada de segundos, ocupando tres das
          // cinco vagas da rodada. A correcao NAO e reconhecer a tarefa
          // repetida: quando desse para reconhece-la, ela ja teria sido
          // reivindicada e `tentativas` ja teria incrementado. E encerrar
          // a rodada. O proximo cron, ~1 minuto depois, tenta de novo se
          // ela voltou a `pendente`, ou segue para a proxima se ela
          // terminou em `erro`.
          //
          // A garantia e NO SAME-RUN RETRY, nunca "60 s exatos entre
          // tentativas": backlog e atraso do agendador mexem no
          // intervalo, nao na propriedade.
          //
          // E isto NAO e falha do dispatcher: o handler falhou, o banco
          // registrou a consequencia, a tentativa foi contada. A rodada
          // termina com sucesso operacional. Virar 500 encheria o log de
          // alarme falso e esconderia D, que e o unico erro de verdade.
          if (corpo.ok === false) break;
        }
      }
    }

    return responder({ ok: true, processados, duracaoMs: Date.now() - inicio }, 200);
  } catch {
    // Nada do erro atravessa: mensagem de driver carrega nome de
    // coluna, de constraint e as vezes de valor. A resposta nao leva
    // tarefaId, userId, agenteId, entrada, resultado nem stack.
    console.error("[internal/agentes/worker] falha inesperada no dispatcher");
    return responder({ ok: false, processados, erro: "dispatcher_falhou" }, 500);
  }
}
