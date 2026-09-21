/**
 * GET /api/internal/agentes/perguntas-poller — M2-I1-A7.
 *
 * ── O que esta rota e ───────────────────────────────────────────────
 *
 * O gatilho de produto do Agente de Mensagens. Ela ENFILEIRA tarefas de
 * consulta de perguntas; nao executa nenhuma. Quem executa e o worker
 * que ja existe, drenando a fila com o claim atomico de sempre.
 *
 * ── Por que rota SEPARADA do worker ─────────────────────────────────
 *
 * Produzir e consumir sao responsabilidades diferentes, e junta-las
 * custaria duas coisas concretas: a varredura passaria a comer do
 * orcamento de drenagem, e uma falha ao listar agentes derrubaria a
 * execucao de tarefas que nada tem a ver com perguntas. Separadas, cada
 * cron tem a sua cadencia e a sua falha.
 *
 * ── O que ela NAO aceita ────────────────────────────────────────────
 *
 * Nada. Nao le corpo, nao le query, nao le cookie. `userId`, `agenteId`,
 * `funcaoId`, `lojaId` e `sellerId` nao entram por lugar nenhum — todos
 * sao fatos de banco ou constantes de servidor. Quem chama e o cron, e a
 * unica coisa que ele apresenta e o segredo.
 *
 * ── Zero rede de marketplace ────────────────────────────────────────
 *
 * Esta rota e o owner que ela chama nao tocam o Mercado Livre, nao
 * resolvem credencial e nao resolvem conexao. A primeira chamada externa
 * do fluxo acontece bem depois, dentro de `executarFuncao`, quando o
 * worker executar a tarefa.
 */
import { NextResponse } from "next/server";

import { enfileirarPollingDePerguntas } from "@/lib/agentes/poller/perguntas";

/**
 * Teto BAIXO de proposito.
 *
 * A varredura e duas consultas em lote mais um insert por agente
 * elegivel, com teto de 200. Ela nao pagina marketplace e nao espera
 * provedor. Declarar 300 aqui, como o worker faz, sugeriria um trabalho
 * longo que esta rota nao tem — e `docs/BUGS.md` ja registra que a
 * Vercel Hobby corta em 60 s de qualquer forma.
 */
export const maxDuration = 60;

function responder(corpo: unknown, status: number): NextResponse {
  return NextResponse.json(corpo, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function GET(request: Request) {
  // ── Auth fail-closed ──────────────────────────────────────────────
  //
  // Mesma guarda do worker de agentes, do worker do Estudio e de
  // `/api/sync`: resposta generica, sem revelar se o que faltou foi a
  // configuracao do servidor ou o header de quem chamou. Somente
  // `Authorization: Bearer` — nao aceita segredo por query, por body nem
  // por `x-worker-secret`.
  const segredo = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization");
  if (!segredo || !auth || auth !== `Bearer ${segredo}`) {
    return responder({ ok: false, erro: "nao_autorizado" }, 401);
  }

  try {
    const resultado = await enfileirarPollingDePerguntas(Date.now());

    if (resultado.coleta !== "ok") {
      // "Nao consegui ler" nunca vira "nao havia o que fazer": a segunda
      // afirmacao produziria uma rodada limpa sobre uma verdade que
      // ninguem apurou.
      return responder({ ok: false, erro: "falha_leitura" }, 500);
    }

    // Contadores, e so contadores. Nenhum `agente_id`, nenhum `user_id`,
    // nenhuma lista — o corpo desta resposta vai para log de plataforma,
    // e identificador de tenant nao tem o que fazer la.
    return responder(
      {
        ok: true,
        elegiveis: resultado.elegiveis,
        criadas: resultado.criadas,
        pulados: resultado.pulados,
      },
      200
    );
  } catch {
    // Sem inspecionar nem logar o erro: qualquer detalhe daqui e
    // material de reconhecimento.
    return responder({ ok: false, erro: "falha_poller" }, 500);
  }
}
