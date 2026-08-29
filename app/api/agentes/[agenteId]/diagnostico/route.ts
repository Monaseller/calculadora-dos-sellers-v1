/**
 * GET /api/agentes/[agenteId]/diagnostico — SKILL-1D.endpoint-B.
 *
 * A primeira exposicao HTTP do compositor de diagnostico. Responde, para
 * o dono da sessao: "cada Skill deste agente esta pronta para operar, e
 * o que falta?".
 *
 * ── Adapter, nao compositor 2 ───────────────────────────────────────
 *
 * Esta rota faz QUATRO coisas e nenhuma a mais: autentica, valida o
 * `agenteId`, le o relogio e chama `diagnosticarAgente` UMA vez. Ela nao
 * abre banco, nao conhece Skill, loja, permissao nem Funcao, e nao
 * reimplementa nenhuma regra que ja viva abaixo dela — a tentacao de
 * "melhorar" a resposta aqui e exatamente como duas verdades divergentes
 * nascem.
 *
 * ── Por que NAO fica em /api/internal ───────────────────────────────
 *
 * `app/api/internal/` e o namespace do worker: as rotas de la se
 * autenticam por `x-worker-secret` e nenhuma tem sessao. Esta e chamada
 * pelo NAVEGADOR do dono, com cookie. Misturar as duas autoridades num
 * mesmo namespace faria a proxima pessoa procurar o segredo errado.
 *
 * ── Propriedade: garantida ABAIXO, nunca aqui ───────────────────────
 *
 * Nao ha consulta de "este agente e seu?". Cada leitura do pipeline
 * filtra `(agente_id, user_id)` na propria instrucao, entao o agente de
 * OUTRO dono simplesmente nao tem Skills: a resposta e 200 com
 * `diagnosticos: []`, idêntica a de um agente que nao existe. As duas
 * situacoes sao indistinguiveis DE PROPOSITO — 404 aqui contaria ao
 * atacante quais ids existem, e ainda custaria uma consulta so para
 * isso.
 *
 * ── O que nunca sai daqui ───────────────────────────────────────────
 *
 * Nenhum branch serializa `uid`, cookie, token, `auth.motivo` ou erro
 * interno. Falha de leitura vira UMA frase fixa: quem chama nao precisa
 * saber se foi o driver, a rede ou o esquema, e a diferenca so ajudaria
 * quem esta sondando.
 */
import { NextResponse } from "next/server";
import { autenticarRequisicao } from "@/lib/autenticacao";
import { diagnosticarAgente } from "@/lib/agentes/diagnostico/compositor";

/**
 * O diagnostico e privado e muda a cada conexao expirada. `no-store` em
 * TODA resposta — inclusive nos erros — impede que um intermediario
 * guarde a resposta de um dono e a sirva a outro.
 *
 * `force-dynamic` diz a mesma coisa ao Next: esta rota nunca e estatica.
 */
export const dynamic = "force-dynamic";

/** Mesma forma local usada pelas demais rotas do repo. Sem helper global,
 *  sem dependencia nova. */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ponto unico de saida: nenhum branch pode esquecer o `no-store`. */
function responder(corpo: unknown, status: number): NextResponse {
  return NextResponse.json(corpo, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function GET(
  request: Request,
  { params }: { params: { agenteId: string } }
) {
  try {
    // 1) Sessao. `motivo` fica no objeto e morre aqui: para quem chama,
    //    401 e 401 — distinguir "sem cookie" de "token invalido" so
    //    ajudaria quem esta testando cookies.
    const auth = await autenticarRequisicao(request);
    if (!auth.autenticado) {
      return responder({ ok: false, erro: "Não autenticado." }, 401);
    }

    // 2) O `agenteId` e uuid no banco. Sem esta validacao, uma string
    //    qualquer chegaria ao Postgres e voltaria como erro de driver —
    //    um 500 de infraestrutura para o que e erro do cliente.
    const { agenteId } = params;
    if (!UUID_REGEX.test(agenteId)) {
      return responder({ ok: false, erro: "agenteId inválido." }, 400);
    }

    // 3) O relogio e do servidor. O compositor se recusa a ter autoridade
    //    temporal propria, e o cliente nao pode ter nenhuma: aceitar
    //    `agoraMs` da requisicao deixaria qualquer um declarar que um
    //    token expirado ainda vale.
    const agoraMs = Date.now();

    // 4) UMA chamada de dominio. O `userId` vem da sessao assinada e de
    //    lugar nenhum mais — a rota nao le `userId` de query, header,
    //    path nem corpo, e nao ha corpo para ler.
    const resultado = await diagnosticarAgente({
      userId: auth.uid,
      agenteId,
      agoraMs,
    });

    if (resultado.coleta === "entrada_invalida") {
      // Inalcancavel depois do guard de uuid — o segmento dinamico nunca
      // casa vazio. Mapeado mesmo assim: se um dia for alcancavel, e
      // erro do cliente, e nunca um 200 fingindo sucesso.
      return responder({ ok: false, erro: "agenteId inválido." }, 400);
    }

    if (resultado.coleta === "falha_leitura") {
      return responder({ ok: false, erro: "Falha ao obter o diagnóstico." }, 500);
    }

    // Lista vazia e resposta COMPLETA, nao ausencia de resposta: agente
    // sem Skills, e agente que nao e seu, terminam os dois aqui.
    return responder(
      {
        ok: true,
        diagnosticos: resultado.diagnosticos,
        semSelecao: resultado.semSelecao,
        coleta: resultado.coleta,
      },
      200
    );
  } catch {
    // `autenticarRequisicao` LANCA quando `SESSION_SECRET` falta — e
    // indisponibilidade e melhor que autenticar sem verificar. O erro
    // nao e inspecionado nem logado: qualquer detalhe daqui e material
    // de reconhecimento, e engoli-lo num 200 vazio seria pior ainda.
    return responder({ ok: false, erro: "Falha ao obter o diagnóstico." }, 500);
  }
}
