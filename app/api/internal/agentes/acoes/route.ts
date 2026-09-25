/**
 * POST /api/internal/agentes/acoes — EM QUARENTENA (M2-I1-A8B-I4O2).
 *
 * Esta rota foi a ponte generica entre um orquestrador externo e as
 * Funcoes de produto. Ela nao e mais isso. O que resta aqui e uma
 * superficie TERMINAL, mantida no ar por uma janela de observacao antes
 * da remocao definitiva.
 *
 * ── Por que aposentar ───────────────────────────────────────────────
 *
 * O I4O1 auditou a superficie inteira e nao achou consumidor:
 *
 *   `consultar_perguntas` foi substituida por
 *   `/api/internal/agentes/ingestao-perguntas`, que faz estritamente
 *   mais — cursor duravel, idempotencia com reconciliacao, persistencia
 *   na inbox, admissao temporal — e foi validada em runtime no I4L3.
 *
 *   `consultar_vendas` nunca precisou desta porta: a UI dispara pela
 *   rota propria `/api/agentes/[agenteId]/consultar-vendas`, que cria
 *   TAREFA, e quem executa a Funcao e o dispatcher da fila.
 *
 *   Zero callers de runtime no repositorio. Zero workflows ativos.
 *   O unico caller n8n restante era um harness de prova de idempotencia,
 *   inativo, cujo objeto de prova era justamente esta ponte.
 *
 * ── Por que a superficie era ampla demais ───────────────────────────
 *
 * O chamador escolhia `agenteId`, e o dono era derivado DAQUELE agente.
 * A leitura era por `id`, sem escopo de usuario: quem tivesse o segredo
 * da ponte podia pedir uma acao em nome do agente de qualquer usuario.
 * Permissao e conexao seguravam o resto, mas isso e defesa em
 * profundidade, nao escopo.
 *
 * ── O que a quarentena faz, e o que NAO faz ─────────────────────────
 *
 * Autenticacao continua exatamente como era, fail-closed, com a mesma
 * resposta generica. Ela e preservada de proposito: sem ela, nao ha como
 * distinguir um scanner anonimo de um consumidor legitimo que ainda
 * possua o segredo.
 *
 * Depois da autenticacao valida, nada comercial acontece. Nao se le o
 * corpo, nao se resolve acao, nao se carrega agente, nao se executa
 * Funcao, nao se toca provider, ledger, aprovacao ou idempotencia. Os
 * imports desses modulos foram REMOVIDOS deste arquivo — a ausencia de
 * alcance e estrutural, nao uma promessa de fluxo.
 *
 * ── O sinal que a janela produz ─────────────────────────────────────
 *
 * Uma requisicao autenticada devolve 410. O codigo 410 nao e usado em
 * nenhum outro lugar desta aplicacao, o que faz dele um sentinela sem
 * ruido: um unico 410 nos logs de producao significa que alguem ainda
 * detem o segredo da ponte e a esta chamando. Enquanto for zero, a
 * ausencia de consumidor deixa de ser inferida do codigo e passa a ser
 * observada em producao.
 *
 * 410 e nao 404 porque a diferenca importa para quem chama: o recurso
 * existiu, foi removido deliberadamente, e nao vai voltar. 404 diria
 * "nunca existiu" e convidaria a retentar.
 *
 * ── Fase 2 ──────────────────────────────────────────────────────────
 *
 * Depois da janela: remover esta rota, o harness de replay, a entrada em
 * `ROTAS_COM_SEGREDO` e `N8N_BRIDGE_INTERNAL_SECRET`. O catalogo de
 * acoes e as Funcoes de dominio NAO sao apagados por isso — aposentar a
 * superficie generica e apagar capacidade sao decisoes distintas, e as
 * duas Funcoes seguem alcancaveis pelos caminhos proprios.
 */
import { NextResponse } from "next/server";

/**
 * O evento da janela de observacao.
 *
 * Nome proprio e estavel porque e o que se procura no log. Sanitizado
 * por construcao: nao ha corpo para vazar, e nenhum campo do pedido
 * alem do metodo, do caminho e de um recorte curto do `user-agent`
 * entra aqui. Sem `agenteId`, sem `operationId`, sem argumentos, sem
 * header de autorizacao, sem cookie, sem IP.
 */
const EVENTO_QUARENTENA = "MAIN_GENERIC_QUARANTINE_HIT";

/** Teto do recorte de `user-agent` que vai para o log. */
const LIMITE_USER_AGENT = 60;

function responder(corpo: unknown, status: number): NextResponse {
  return NextResponse.json(corpo, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: Request) {
  // ── Auth fail-closed ──────────────────────────────────────────────
  //
  // Segredo PROPRIO. `CRON_SECRET` daria ao portador o poder de acionar
  // o worker; `AGENTES_WORKER_INTERNAL_SECRET`, o de executar tarefa
  // arbitraria por id. Nenhum dos dois e o que esta ponte precisa, e
  // reusar qualquer um desfaria o isolamento entre os dominios — mesma
  // razao escrita em `app/api/internal/agentes/executar/route.ts`.
  //
  // Resposta generica: nao revela se o que faltou foi a configuracao do
  // servidor ou o header de quem chamou.
  //
  // PRESERVADO NA QUARENTENA, e nao por inercia: sem autenticacao a
  // janela de observacao nao distingue scanner de consumidor real, e o
  // sinal que ela existe para produzir deixaria de ter valor.
  const segredo = process.env.N8N_BRIDGE_INTERNAL_SECRET;
  const recebido = request.headers.get("x-worker-secret");
  if (!segredo || !recebido || recebido !== segredo) {
    return responder({ ok: false, erro: "nao_autorizado" }, 401);
  }

  // ── Daqui para baixo, nada comercial ──────────────────────────────
  //
  // O corpo NAO e lido. Ler para descartar ensinaria o chamador que o
  // contrato antigo ainda vale, e criaria um ramo onde um campo do
  // pedido poderia influenciar a resposta. Nenhum campo influencia:
  // `acao`, `agenteId`, `operationId`, `argumentos` e qualquer outro
  // terminam aqui, iguais.
  const agente = request.headers.get("user-agent");
  console.warn(
    JSON.stringify({
      evento: EVENTO_QUARENTENA,
      quando: new Date().toISOString(),
      metodo: "POST",
      caminho: "/api/internal/agentes/acoes",
      userAgent: typeof agente === "string" ? agente.slice(0, LIMITE_USER_AGENT) : null,
    })
  );

  return responder(
    { ok: false, estado: "indisponivel", codigo: "main_generico_em_aposentadoria" },
    410
  );
}
