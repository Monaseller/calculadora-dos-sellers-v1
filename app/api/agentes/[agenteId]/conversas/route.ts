/**
 * Conversas de um agente — AGENT-FACTORY-F7a.
 *
 * GET   lista as conversas nao arquivadas
 * POST  abre uma conversa nova
 *
 * ── Abrir conversa NAO gasta IA ─────────────────────────────────────
 *
 * Criar so insere a linha. O titulo vem do dono ou fica nulo — gerar um
 * com modelo seria uma chamada paga escondida atras de um botao que a
 * pessoa acha que e local.
 *
 * ── Conversa nova zera o ASSUNTO, e nao o agente ────────────────────
 *
 * Fontes, memorias e Skills continuam valendo: elas sao do agente, e
 * nao da conversa. O que recomeca e o fio. A suite prova isso.
 */
import { atravessarPorta, lerCorpo, responder } from "@/lib/agentes/api/porta";
import { criarPortaDeConversas } from "@/lib/agentes/conversas/repositorio";
import { validarTitulo } from "@/lib/agentes/conversas/tipos";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";

export const dynamic = "force-dynamic";

const FALHA = "Nao foi possivel carregar as conversas.";

export async function GET(request: Request, { params }: { params: { agenteId: string } }) {
  try {
    const porta = await atravessarPorta(request, params.agenteId, FALHA);
    if (!porta.ok) return porta.resposta;

    const conversas = await criarPortaDeConversas(getSupabaseServidor())
      .listarConversas(porta.userId, porta.agenteId);

    return responder({
      ok: true,
      conversas: conversas.map((c) => ({
        id: c.id, titulo: c.titulo, criadoEm: c.criadoEm, atualizadoEm: c.atualizadoEm,
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
    const titulo = corpo?.titulo;
    const v = validarTitulo(titulo);
    if (!v.ok) return responder({ ok: false, erro: v.mensagem }, 400);

    const conversa = await criarPortaDeConversas(getSupabaseServidor()).criarConversa(
      porta.userId, porta.agenteId,
      typeof titulo === "string" ? titulo.trim() : null
    );

    return responder({
      ok: true,
      conversa: { id: conversa.id, titulo: conversa.titulo, criadoEm: conversa.criadoEm },
    }, 201);
  } catch {
    return responder({ ok: false, erro: "Nao foi possivel abrir a conversa." }, 500);
  }
}
