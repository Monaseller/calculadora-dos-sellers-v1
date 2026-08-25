/**
 * POST /api/internal/agentes/executar
 *
 * Executa UMA tarefa de agente ja reivindicada pelo worker.
 *
 * ── Rota INTERNA: autorizacao e o segredo, e nada mais ──────────────
 * Nenhum `user_id` do corpo e aceito — nem lido. O unico parametro e
 * `tarefa_id`, e mesmo ele nao e escolhido livremente: o worker o
 * recebeu de `claim_next_agente_tarefa()`, que decide sozinha no banco.
 *
 * ── SEGREDO PROPRIO, nao o do Estudio ───────────────────────────────
 * `AGENTES_WORKER_INTERNAL_SECRET`, distinto de
 * `ESTUDIO_ANUNCIOS_WORKER_INTERNAL_SECRET`. Reaproveitar o segredo
 * desfaria metade do isolamento entre os dois motores: quem tivesse o
 * do Estudio passaria a poder acionar o de agentes, e vice-versa. Dois
 * dominios, dois segredos, comprometimento de um nao alcanca o outro.
 *
 * ── FAIL CLOSED ─────────────────────────────────────────────────────
 * Sem a variavel no ambiente, a rota recusa TUDO. Ausencia de
 * configuracao nunca abre — mesma regra da rota interna do Estudio.
 *
 * ── Esta rota nao decide nada sobre a tarefa ────────────────────────
 * Autentica, valida a entrada e traduz o resultado em HTTP. A decisao
 * de concluir ou falhar e de `executarTarefa`, e a transicao em si e
 * das RPCs atomicas — TypeScript nao roda em transacao.
 */
import { NextResponse } from "next/server";
import { executarTarefa } from "@/lib/agentes/executar-tarefa";

/** Mesmo formato aceito em `agente_tarefas.id` (uuid). */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function respostaErro(status: number, erro: string) {
  // Nunca stack trace, nunca objeto de erro cru — todo texto que chega
  // aqui ja foi truncado e classificado.
  return NextResponse.json({ ok: false, erro }, { status });
}

export async function POST(request: Request) {
  const segredoEsperado = process.env.AGENTES_WORKER_INTERNAL_SECRET;
  const segredoRecebido = request.headers.get("x-worker-secret");

  if (!segredoEsperado || !segredoRecebido || segredoRecebido !== segredoEsperado) {
    return respostaErro(401, "Nao autorizado.");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return respostaErro(400, "Body invalido.");
  }

  const tarefaId = (body as { tarefa_id?: unknown } | null)?.tarefa_id;
  if (!tarefaId || typeof tarefaId !== "string") {
    return respostaErro(400, "tarefa_id e obrigatorio.");
  }
  if (!UUID_REGEX.test(tarefaId)) {
    return respostaErro(400, "tarefa_id nao e um UUID valido.");
  }

  try {
    const { status, corpo } = await executarTarefa(tarefaId);
    return NextResponse.json(corpo, { status });
  } catch (err: unknown) {
    // Ultima rede de seguranca. NAO tenta marcar a tarefa aqui: se algo
    // chegou a este catch, nao ha garantia de em que ponto o ciclo
    // parou, e uma escrita extra so criaria um estado parcial pior. A
    // recuperacao de orfa devolve a tarefa a fila em 5 minutos.
    const mensagem = err instanceof Error ? err.message.slice(0, 300) : "Erro desconhecido";
    console.error("[internal/agentes/executar] falhou:", mensagem);
    return respostaErro(500, mensagem);
  }
}
