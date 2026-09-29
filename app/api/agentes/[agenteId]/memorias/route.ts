/**
 * Memorias de um agente — AGENT-FACTORY-F7a.
 *
 * GET   lista (todas, com o `ativo` de cada uma)
 * POST  cria
 *
 * ── Escrita MANUAL, e so por aqui ───────────────────────────────────
 *
 * Esta rota e o UNICO caminho de escrita de memoria, e ela exige
 * sessao. O agente nao a alcanca: nao existe Function de memoria no
 * registry, e a suite reprova se aparecer. Memoria e configuracao do
 * dono, feita pela interface.
 */
import { atravessarPorta, lerCorpo, responder } from "@/lib/agentes/api/porta";
import { criarPortaDeMemorias } from "@/lib/agentes/memorias/repositorio";
import { criarMemoria, listarMemorias } from "@/lib/agentes/memorias/servico";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";

export const dynamic = "force-dynamic";

const FALHA = "Nao foi possivel carregar as memorias.";

export async function GET(request: Request, { params }: { params: { agenteId: string } }) {
  try {
    const porta = await atravessarPorta(request, params.agenteId, FALHA);
    if (!porta.ok) return porta.resposta;

    const memorias = await listarMemorias(
      criarPortaDeMemorias(getSupabaseServidor()), porta.userId, porta.agenteId);

    return responder({
      ok: true,
      memorias: memorias.map((m) => ({
        id: m.id, conteudo: m.conteudo, tipo: m.tipo, ordem: m.ordem,
        ativo: m.ativo, criadoEm: m.criadoEm, atualizadoEm: m.atualizadoEm,
      })),
    }, 200);
  } catch {
    return responder({ ok: false, erro: FALHA }, 500);
  }
}

export async function POST(request: Request, { params }: { params: { agenteId: string } }) {
  try {
    const porta = await atravessarPorta(request, params.agenteId, FALHA);
    if (!porta.ok) return porta.resposta;

    const corpo = await lerCorpo(request);
    if (corpo === null) return responder({ ok: false, erro: "Corpo inválido." }, 400);

    const r = await criarMemoria(criarPortaDeMemorias(getSupabaseServidor()), {
      userId: porta.userId, agenteId: porta.agenteId,
      conteudo: corpo.conteudo, tipo: corpo.tipo, ordem: corpo.ordem,
    });
    if (!r.ok) {
      // `memoria_duplicada` e 409: nao e erro do sistema nem entrada
      // malformada — e a pessoa mandando de novo o que ja esta la.
      return responder({ ok: false, erro: r.mensagem, codigo: r.codigo },
        r.codigo === "memoria_duplicada" ? 409 : 400);
    }

    return responder({
      ok: true,
      memoria: {
        id: r.memoria.id, conteudo: r.memoria.conteudo, tipo: r.memoria.tipo,
        ordem: r.memoria.ordem, ativo: r.memoria.ativo, criadoEm: r.memoria.criadoEm,
      },
    }, 201);
  } catch {
    return responder({ ok: false, erro: "Nao foi possivel salvar a memoria." }, 500);
  }
}
