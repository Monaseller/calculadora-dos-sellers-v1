/**
 * Uma fonte — AGENT-FACTORY-F7a.
 *
 * DELETE  desativa
 *
 * ── Desativa, nao apaga ─────────────────────────────────────────────
 *
 * O registro e o hash ficam. Um total calculado ontem so continua
 * explicavel se der para dizer QUAL arquivo foi lido — e uma fonte
 * apagada de vez levaria essa resposta junto. Some da lista, some do
 * contexto, some do resolvedor; a linha permanece.
 */
import { atravessarPorta, responder, UUID_REGEX } from "@/lib/agentes/api/porta";
import { criarPortaDeFontes } from "@/lib/agentes/fontes/repositorio";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";

export const dynamic = "force-dynamic";

export async function DELETE(
  request: Request,
  { params }: { params: { agenteId: string; fonteId: string } }
) {
  try {
    const porta = await atravessarPorta(request, params.agenteId);
    if (!porta.ok) return porta.resposta;
    if (!UUID_REGEX.test(params.fonteId)) {
      return responder({ ok: false, erro: "fonteId inválido." }, 400);
    }

    const portaF = criarPortaDeFontes(getSupabaseServidor());

    // Confere que a fonte e DESTE agente antes de desativar. `desativar`
    // sozinho amarra o dono, mas nao o agente — sem esta checagem, um
    // dono com dois agentes poderia desligar a fonte do outro pela rota
    // errada.
    const doAgente = await portaF.obterAtiva(
      porta.userId, params.fonteId, { agenteId: porta.agenteId });
    if (!doAgente) return responder({ ok: false, erro: "Fonte não encontrada." }, 404);

    const ok = await portaF.desativar(porta.userId, params.fonteId);
    return responder({ ok }, ok ? 200 : 404);
  } catch {
    return responder({ ok: false, erro: "Nao foi possivel remover a fonte." }, 500);
  }
}
