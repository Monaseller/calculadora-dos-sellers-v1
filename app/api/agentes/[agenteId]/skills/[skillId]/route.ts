/**
 * Uma Skill vinculada — AGENT-FACTORY-F7a.
 *
 * DELETE  desvincula do agente
 *
 * Desvincular NAO apaga a Skill: ela continua na biblioteca do dono e
 * pode ser vinculada a outro agente. O que morre e o vinculo — que e o
 * que a etapa "Skills" da Factory manipula.
 */
import { atravessarPorta, responder, UUID_REGEX } from "@/lib/agentes/api/porta";
import { desassociarSkillDoAgente } from "@/lib/agentes/skills/escrita";

export const dynamic = "force-dynamic";

export async function DELETE(
  request: Request,
  { params }: { params: { agenteId: string; skillId: string } }
) {
  try {
    const porta = await atravessarPorta(request, params.agenteId);
    if (!porta.ok) return porta.resposta;
    if (!UUID_REGEX.test(params.skillId)) {
      return responder({ ok: false, erro: "skillId inválido." }, 400);
    }

    const { estado } = await desassociarSkillDoAgente({
      userId: porta.userId, agenteId: porta.agenteId, skillId: params.skillId,
    });

    const status = estado === "desassociada" ? 200
      : estado === "nao_associada" ? 404
      : estado === "entrada_invalida" ? 400 : 500;

    return responder({ ok: status < 400, estado }, status);
  } catch {
    return responder({ ok: false, erro: "Nao foi possivel desvincular a Skill." }, 500);
  }
}
