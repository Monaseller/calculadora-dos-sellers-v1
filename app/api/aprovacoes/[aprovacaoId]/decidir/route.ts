/**
 * POST /api/aprovacoes/[aprovacaoId]/decidir — APPROVAL-DECISION-A3.
 *
 * A decisao humana, e so ela. Esta rota e o primeiro consumidor de
 * producao de `decidirAprovacao` desde que o wrapper nasceu.
 *
 * ── Aprovar NAO executa nada, e isso e o desenho ────────────────────
 *
 * O `200` daqui significa uma coisa exata: a decisao esta gravada. A
 * tarefa continua em `aguardando_aprovacao` com o ponteiro intacto, e e
 * exatamente esse par que a lane Resume do worker — ativa em producao
 * desde o D0 — descobre sozinha no proximo minuto. Chamar o Resume aqui
 * transformaria um clique de autorizacao numa requisicao que espera uma
 * Funcao inteira rodar, com o teto do serverless no meio.
 *
 * Por isso a lista de ausencias e verificada por tripwire, nao apenas
 * pretendida: zero `executarRetomada`, zero `executarSlotRetomada`, zero
 * `aprovacao_consumir_e_abrir`, zero `iniciarRetomadaAprovacao`, zero
 * claim, zero executor de Funcao ou de Tool Call.
 *
 * ── Rejeitar tambem e so decisao ────────────────────────────────────
 *
 * Quem cancela a tarefa e limpa o ponteiro e a transacao do D4, na mesma
 * RPC e sob os mesmos locks. Uma segunda mutacao daqui poderia rodar
 * depois de a primeira ter falhado, e ai a aprovacao estaria terminal com
 * a tarefa viva — o defeito que o D4 existe para eliminar.
 *
 * ── Adapter, nao dominio ────────────────────────────────────────────
 *
 * Autentica, valida a forma, traduz codigo em status. Nao abre banco, nao
 * nomeia RPC, nao interpreta estado. `decidirAprovacao` e o unico dono da
 * chamada, e o `p_user_id` que ela recebe e o da sessao — a RPC deriva
 * `decidido_por` dele, entao nao existe caminho para registrar um decisor
 * diferente do dono autenticado.
 *
 * ── `cancelar` existe no D4 e NAO sai daqui ─────────────────────────
 *
 * A RPC aceita tres decisoes; a pessoa tem duas. `cancelar` e cancelamento
 * TECNICO, usado pela reconciliacao da retomada, e expo-lo como terceira
 * opcao humana daria ao dono um botao cujo efeito ele nao tem como prever.
 * O enum e fechado por INCLUSAO antes de o wrapper ser chamado.
 */
import { NextResponse } from "next/server";
import { autenticarRequisicao } from "@/lib/autenticacao";
import { decidirAprovacao } from "@/lib/agentes/aprovacoes/persistencia";

/** Decisao muda estado do dono a cada chamada. Nunca cacheada. */
export const dynamic = "force-dynamic";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** As duas decisoes HUMANAS. `cancelar` nao esta aqui de proposito. */
const DECISOES_HUMANAS = ["aprovar", "rejeitar"] as const;
type DecisaoHumana = (typeof DECISOES_HUMANAS)[number];

/** Ponto unico de saida: nenhum branch pode esquecer o `no-store`. */
function responder(corpo: unknown, status: number): NextResponse {
  return NextResponse.json(corpo, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

/** Mensagens publicas, fixas e minimas. Nenhuma carrega SQL, SQLSTATE,
 *  stack, id interno, argumento ou estado de outro dono. */
const ERRO_NAO_AUTENTICADO = "Não autenticado.";
const ERRO_ENTRADA = "Entrada inválida.";
const ERRO_NAO_ENCONTRADA = "Aprovação não encontrada.";
const ERRO_INDISPONIVEL = "A aprovação não está mais disponível para essa decisão.";
const ERRO_FALHA = "Não foi possível registrar a decisão.";

/** O estado publico que cada decisao bem-sucedida deixa na aprovacao. */
const ESTADO_DE: Record<DecisaoHumana, "aprovada" | "rejeitada"> = {
  aprovar: "aprovada",
  rejeitar: "rejeitada",
};

/**
 * O corpo, fechado por INCLUSAO.
 *
 * Exatamente UMA chave, e ela tem de ser `decisao`. Aceitar chave a mais
 * seria aceitar que um cliente futuro mande `userId` ou `tarefaId` junto e
 * que alguem, um dia, resolva le-los. Array e primitivo tambem caem: um
 * `["aprovar"]` que passasse viraria decisao por posicao.
 */
async function decisaoDoCorpo(
  request: Request
): Promise<{ ok: true; decisao: DecisaoHumana } | { ok: false }> {
  let bruto: unknown;
  try {
    bruto = await request.json();
  } catch {
    return { ok: false };
  }

  if (typeof bruto !== "object" || bruto === null || Array.isArray(bruto)) {
    return { ok: false };
  }

  const chaves = Object.keys(bruto);
  if (chaves.length !== 1 || chaves[0] !== "decisao") return { ok: false };

  const { decisao } = bruto as { decisao?: unknown };
  if (typeof decisao !== "string") return { ok: false };
  if (decisao !== "aprovar" && decisao !== "rejeitar") return { ok: false };

  return { ok: true, decisao };
}

export async function POST(
  request: Request,
  { params }: { params: { aprovacaoId: string } }
) {
  try {
    // 1) Sessao. `auth.uid` e a UNICA autoridade de identidade — nenhum
    //    dono, agente, tarefa ou actor chega por corpo, query ou header.
    const auth = await autenticarRequisicao(request);
    if (!auth.autenticado) {
      return responder({ ok: false, erro: ERRO_NAO_AUTENTICADO }, 401);
    }

    // 2) A aprovacao vem do SEGMENTO, nunca do corpo.
    const { aprovacaoId } = params;
    if (!UUID_REGEX.test(aprovacaoId)) {
      return responder({ ok: false, erro: ERRO_ENTRADA }, 400);
    }

    // 3) Corpo antes do banco: payload invalido nao merece uma transacao.
    const corpo = await decisaoDoCorpo(request);
    if (!corpo.ok) {
      return responder({ ok: false, erro: ERRO_ENTRADA }, 400);
    }
    const { decisao } = corpo;

    // 4) A UNICA chamada. Sem cliente Supabase, sem nome de RPC, sem
    //    segunda mutacao.
    const { codigo } = await decidirAprovacao({
      userId: auth.uid,
      aprovacaoId,
      decisao,
      motivo: null,
    });

    // ── 5) TRADUCAO EXAUSTIVA DOS CODIGOS DO D4 ──────────────────────

    // Decisao gravada agora.
    if (codigo === "aprovada" || codigo === "rejeitada") {
      return responder({ ok: true, decisao, estado: ESTADO_DE[decisao] }, 200);
    }

    // IDEMPOTENTE vs CONFLITO — a distincao que o codigo sozinho nao faz.
    //
    // O D4 devolve `ja_aprovada` tanto para quem repetiu "aprovar" quanto
    // para quem tentou "rejeitar" uma aprovacao ja aprovada. Sao situacoes
    // opostas: a primeira e a mesma decisao chegando duas vezes — um
    // duplo-clique, um retry de rede — e deve terminar igual a primeira; a
    // segunda e uma decisao CONTRARIA a que ja esta gravada, e responder
    // `200` ali diria que a rejeicao foi aceita quando a aprovacao e que
    // vale. A rota resolve sem tocar no D4 porque ela sabe o que enviou.
    if (codigo === "ja_aprovada") {
      return decisao === "aprovar"
        ? responder({ ok: true, decisao, estado: "aprovada" }, 200)
        : responder({ ok: false, erro: ERRO_INDISPONIVEL }, 409);
    }
    if (codigo === "ja_rejeitada") {
      return decisao === "rejeitar"
        ? responder({ ok: true, decisao, estado: "rejeitada" }, 200)
        : responder({ ok: false, erro: ERRO_INDISPONIVEL }, 409);
    }

    // Terminais que nenhuma decisao humana reabre. `cancelada` entra aqui
    // mesmo sendo inalcancavel pelo enum desta rota: se o D4 devolve-lo, a
    // aprovacao esta encerrada, e falhar fechado e a leitura certa.
    if (
      codigo === "ja_cancelada" ||
      codigo === "ja_consumida" ||
      codigo === "cancelada" ||
      codigo === "expirada" ||
      codigo === "tarefa_incompativel"
    ) {
      return responder({ ok: false, erro: ERRO_INDISPONIVEL }, 409);
    }

    // Inexistente e de-outro-dono sao O MESMO 404 — a RPC ja os torna
    // indistinguiveis, e diferenciar aqui devolveria a enumeracao que ela
    // fechou.
    if (codigo === "aprovacao_inexistente") {
      return responder({ ok: false, erro: ERRO_NAO_ENCONTRADA }, 404);
    }

    // Defesa em profundidade: a validacao acima ja deveria ter barrado
    // estes dois. Chegar aqui significa divergencia entre o que a rota
    // aceita e o que a RPC aceita, e isso e 400, nao 500.
    if (codigo === "entrada_invalida" || codigo === "decisao_invalida") {
      return responder({ ok: false, erro: ERRO_ENTRADA }, 400);
    }

    // `falha_persistencia` cobre erro de transporte e as violacoes de
    // invariante que a RPC levanta como SQLSTATE 55000. Fail-closed: 503,
    // e a UI mantem o card.
    return responder({ ok: false, erro: ERRO_FALHA }, 503);
  } catch {
    // `autenticarRequisicao` LANCA se `SESSION_SECRET` faltar. O
    // fail-closed da camada de sessao chega aqui como 503, nunca como
    // decisao silenciosamente perdida.
    return responder({ ok: false, erro: ERRO_FALHA }, 503);
  }
}
