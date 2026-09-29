/**
 * Skills de um agente — AGENT-FACTORY-F7a.
 *
 * GET   as Skills VINCULADAS a este agente
 * POST  vincula uma Skill do dono a este agente
 *
 * ── Esta rota NAO cria Skill ────────────────────────────────────────
 *
 * Criar/importar Skill ja tem caminho proprio
 * (`importarEPersistirSkill`), com manifesto, versao, slug e validacao
 * de formato — regras que existem desde a 20260922 e que uma rota nova
 * nao vai reimplementar pela metade. Aqui so se VINCULA o que ja
 * existe, que e o que a etapa "Skills" da Factory precisa.
 *
 * O servico de vinculo ja recusa Skill de outro dono (`nao_disponivel`);
 * a porta amarra o agente ao dono da sessao. As duas cercas, mais a FK
 * composta no banco.
 */
import { atravessarPorta, lerCorpo, responder, UUID_REGEX } from "@/lib/agentes/api/porta";
import { associarSkillAoAgente } from "@/lib/agentes/skills/escrita";
import { resolverSkillsDoAgente } from "@/lib/agentes/skills/fatos";

export const dynamic = "force-dynamic";

const FALHA = "Nao foi possivel carregar as Skills.";

export async function GET(request: Request, { params }: { params: { agenteId: string } }) {
  try {
    const porta = await atravessarPorta(request, params.agenteId, FALHA);
    if (!porta.ok) return porta.resposta;

    const { skills, coleta } = await resolverSkillsDoAgente({
      userId: porta.userId, agenteId: porta.agenteId,
    });
    // Falha de leitura NAO vira "este agente nao tem Skill": um banco
    // fora do ar apareceria como escolha deliberada do dono.
    if (coleta !== "ok") return responder({ ok: false, erro: FALHA }, 500);

    return responder({
      ok: true,
      skills: skills.map((s) => ({
        id: s.manifesto.id,
        nome: s.manifesto.nome,
        versao: s.manifesto.versao,
        descricao: s.manifesto.descricao,
        quandoUsar: s.manifesto.quando_usar,
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
    const skillId = corpo?.skillId;
    if (typeof skillId !== "string" || !UUID_REGEX.test(skillId)) {
      return responder({ ok: false, erro: "skillId inválido." }, 400);
    }

    const { estado } = await associarSkillAoAgente({
      userId: porta.userId, agenteId: porta.agenteId, skillId,
    });

    // `nao_disponivel` = a Skill nao existe OU nao e deste dono. As duas
    // respondem igual, pelo mesmo motivo de sempre.
    const status = estado === "associada" ? 201
      : estado === "ja_associada" ? 200
      : estado === "nao_disponivel" ? 404
      : estado === "entrada_invalida" ? 400 : 500;

    return responder({ ok: status < 400, estado }, status);
  } catch {
    return responder({ ok: false, erro: "Nao foi possivel vincular a Skill." }, 500);
  }
}
