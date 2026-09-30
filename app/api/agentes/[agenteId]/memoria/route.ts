/**
 * A memoria de longo prazo de UM agente — AGENT-FACTORY-F7b.4.
 *
 * GET    o estado: ligada?, configurada no ambiente?, o que ela lembra
 * PATCH  liga ou desliga
 *
 * ── Rota propria, pelo mesmo motivo de `/ativacao` ──────────────────
 *
 * `/agentes/[id]` aceita SO `nome` e `instrucoes`, e a suite cobra essa
 * allowlist. Alargá-la para caber `memoria_ativa` tiraria a prova de que
 * `ativo`, `tipo` e `user_id` nao tem caminho de escrita por ali.
 *
 * ── Ligar memoria NAO e conceder permissao ──────────────────────────
 *
 * Esta rota escreve UM booleano. Ela nao toca `agente_permissoes`, nao
 * declara ferramenta e nao muda nivel — e a suite verifica isso por
 * inspecao. Memoria e contexto; autoridade continua no guard.
 */
import { atravessarPorta, lerCorpo, responder } from "@/lib/agentes/api/porta";
import { atualizarAgenteDoDono, lerAgenteDoDono } from "@/lib/agentes/capability";
import { memoriaConfigurada } from "@/lib/agentes/memoria/zep";
import { recuperarContexto } from "@/lib/agentes/memoria/automatica";

export const dynamic = "force-dynamic";

const FALHA = "Nao foi possivel carregar a memoria deste agente.";

export async function GET(request: Request, { params }: { params: { agenteId: string } }) {
  try {
    const porta = await atravessarPorta(request, params.agenteId, FALHA);
    if (!porta.ok) return porta.resposta;

    const { linha } = await lerAgenteDoDono(porta.agenteId, porta.userId);
    if (!linha) return responder({ ok: false, erro: "Agente não encontrado." }, 404);

    // `conversaId` opcional: sem ela nao ha thread para consultar, e o
    // GET serve apenas para mostrar o estado.
    const url = new URL(request.url);
    const conversaId = url.searchParams.get("conversaId");

    let contexto: string | null = null;
    let desfecho: string = linha.memoria_ativa ? "sem_conversa" : "desligada";
    if (linha.memoria_ativa && conversaId !== null && conversaId !== "") {
      const r = await recuperarContexto({
        userId: porta.userId, agenteId: porta.agenteId,
        conversaId, memoriaAtiva: true,
      });
      contexto = r.texto;
      desfecho = r.desfecho;
    }

    return responder({
      ok: true,
      memoriaAtiva: linha.memoria_ativa,
      // Diz se o AMBIENTE tem o motor, sem revelar nada da credencial.
      motorConfigurado: memoriaConfigurada(),
      desfecho,
      contexto,
    }, 200);
  } catch {
    return responder({ ok: false, erro: FALHA }, 500);
  }
}

export async function PATCH(request: Request, { params }: { params: { agenteId: string } }) {
  try {
    const porta = await atravessarPorta(request, params.agenteId, FALHA);
    if (!porta.ok) return porta.resposta;

    const corpo = await lerCorpo(request);
    // Allowlist de UM campo. Uma chave a mais reprova o pedido inteiro.
    if (corpo === null || Object.keys(corpo).length !== 1 ||
        typeof corpo.memoriaAtiva !== "boolean") {
      return responder(
        { ok: false, erro: "Informe `memoriaAtiva` como true ou false." }, 400);
    }

    const { linha, erro } = await atualizarAgenteDoDono(
      porta.agenteId, porta.userId, { memoriaAtiva: corpo.memoriaAtiva });
    if (erro !== null || !linha) {
      return responder({ ok: false, erro: FALHA }, erro === null ? 404 : 500);
    }

    // O estado vem LIDO da linha, nunca ecoado do pedido.
    return responder({ ok: true, memoriaAtiva: linha.memoria_ativa }, 200);
  } catch {
    return responder({ ok: false, erro: FALHA }, 500);
  }
}
