/**
 * Uma memoria — AGENT-FACTORY-F7a.
 *
 * PATCH   edita conteudo/tipo/ordem, ou liga/desliga
 * DELETE  remove
 *
 * O servico ja amarra dono E agente na consulta; aqui a porta amarra o
 * agente ao dono da sessao. Memoria de outro dono devolve 404 — a
 * mesma resposta de uma que nao existe.
 */
import { atravessarPorta, lerCorpo, responder, UUID_REGEX } from "@/lib/agentes/api/porta";
import { criarPortaDeMemorias } from "@/lib/agentes/memorias/repositorio";
import { atualizarMemoria, removerMemoria } from "@/lib/agentes/memorias/servico";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";

export const dynamic = "force-dynamic";

const FALHA = "Nao foi possivel alterar a memoria.";

export async function PATCH(
  request: Request,
  { params }: { params: { agenteId: string; memoriaId: string } }
) {
  try {
    const porta = await atravessarPorta(request, params.agenteId, FALHA);
    if (!porta.ok) return porta.resposta;
    if (!UUID_REGEX.test(params.memoriaId)) {
      return responder({ ok: false, erro: "memoriaId inválido." }, 400);
    }

    const corpo = await lerCorpo(request);
    if (corpo === null) return responder({ ok: false, erro: "Corpo inválido." }, 400);

    // Allowlist: so estes quatro campos sao alteraveis. Um `user_id` ou
    // `agente_id` no corpo e IGNORADO — nao existe caminho para o
    // cliente mover uma memoria de dono.
    const mudanca: Record<string, unknown> = {};
    if (typeof corpo.conteudo === "string") mudanca.conteudo = corpo.conteudo.trim();
    if (corpo.tipo === null || typeof corpo.tipo === "string") {
      mudanca.tipo = corpo.tipo === null ? null : String(corpo.tipo).trim();
    }
    if (typeof corpo.ordem === "number") mudanca.ordem = corpo.ordem;
    if (typeof corpo.ativo === "boolean") mudanca.ativo = corpo.ativo;

    if (Object.keys(mudanca).length === 0) {
      return responder({ ok: false, erro: "Nada para alterar." }, 400);
    }

    const r = await atualizarMemoria(
      criarPortaDeMemorias(getSupabaseServidor()),
      porta.userId, porta.agenteId, params.memoriaId, mudanca);

    if (!r.ok) {
      return responder({ ok: false, erro: r.mensagem, codigo: r.codigo },
        r.codigo === "memoria_nao_encontrada" ? 404 : 400);
    }
    return responder({
      ok: true,
      memoria: {
        id: r.memoria.id, conteudo: r.memoria.conteudo, tipo: r.memoria.tipo,
        ordem: r.memoria.ordem, ativo: r.memoria.ativo,
        atualizadoEm: r.memoria.atualizadoEm,
      },
    }, 200);
  } catch {
    return responder({ ok: false, erro: FALHA }, 500);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: { agenteId: string; memoriaId: string } }
) {
  try {
    const porta = await atravessarPorta(request, params.agenteId, FALHA);
    if (!porta.ok) return porta.resposta;
    if (!UUID_REGEX.test(params.memoriaId)) {
      return responder({ ok: false, erro: "memoriaId inválido." }, 400);
    }

    const r = await removerMemoria(
      criarPortaDeMemorias(getSupabaseServidor()),
      porta.userId, porta.agenteId, params.memoriaId);

    return responder({ ok: r.ok }, r.ok ? 200 : 404);
  } catch {
    return responder({ ok: false, erro: FALHA }, 500);
  }
}
