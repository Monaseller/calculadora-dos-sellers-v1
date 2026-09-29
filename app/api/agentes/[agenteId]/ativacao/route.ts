/**
 * Ativar e desativar um agente — F7b.1.
 *
 * GET    o que falta para ativar (a tela "Revisar" le daqui)
 * PATCH  liga ou desliga
 *
 * ── Rota propria, e nao um campo no PATCH existente ─────────────────
 *
 * `app/api/agentes/[agenteId]/route.ts` aceita SO `nome` e `instrucoes`,
 * e a suite cobra essa allowlist. Alargá-la para caber `ativo` tiraria
 * a prova de que `ativo`, `tipo` e `user_id` nao tem caminho de escrita
 * por ali — uma garantia que nao vale trocar por um campo a mais.
 *
 * Aqui o unico campo e `ativo`, e ele passa por validacao propria.
 *
 * ── Ativar NAO e salvar ─────────────────────────────────────────────
 *
 * O wizard salva a cada etapa, com o agente em rascunho. Ativar e um ato
 * separado, com regra propria: se falta permissao explicita em alguma
 * Funcao de uma Tool escolhida, NAO ativa — ver
 * `lib/agentes/factory/ativacao.ts`.
 *
 * DESATIVAR nunca e barrado. Desligar tem de ser sempre possivel, mesmo
 * com configuracao pela metade.
 */
import { atravessarPorta, lerCorpo, responder } from "@/lib/agentes/api/porta";
import { atualizarAgenteDoDono, lerAgenteDoDono } from "@/lib/agentes/capability";
import { FUNCOES } from "@/lib/agentes/funcoes/registry";
import { resolverFatosPermissoes } from "@/lib/agentes/permissoes/fatos";
import { validarParaAtivacao } from "@/lib/agentes/factory/ativacao";
import { estadoDosPacks } from "@/lib/agentes/factory/catalogo-ui";

export const dynamic = "force-dynamic";

const FALHA = "Nao foi possivel carregar o estado do agente.";

/**
 * Qual provedor este ambiente tem para agente com ferramenta.
 *
 * Nao ha coluna de modelo em `agentes`: o provedor e resolvido pelo
 * gateway a partir de env, e hoje so a Anthropic fecha o ida-e-volta de
 * ferramenta. Guardar uma escolha por agente sem ter uma segunda opcao
 * compativel seria criar uma coluna para um seletor de um item — e o dia
 * em que houver a segunda, ela nasce junto com a decisao de como
 * persistir.
 */
function provedorDisponivel(): string | null {
  return process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_MODEL_AGENTE?.trim()
    ? "anthropic" : null;
}

function modeloDisponivel(): string | null {
  return process.env.ANTHROPIC_MODEL_AGENTE?.trim() || null;
}

async function montarEstado(userId: string, agenteId: string) {
  const [{ linha }, permissoes] = await Promise.all([
    lerAgenteDoDono(agenteId, userId),
    resolverFatosPermissoes({ userId, agenteId, funcaoIds: Object.keys(FUNCOES) }),
  ]);
  if (!linha) return null;
  if (permissoes.coleta !== "ok") return "falha_leitura" as const;

  const fatos = permissoes.fatos.map((p) => ({ funcaoId: p.funcaoId, nivel: p.nivel }));
  return {
    linha,
    fatos,
    validacao: validarParaAtivacao({
      nome: linha.nome,
      instrucoes: linha.instrucoes,
      provedor: provedorDisponivel(),
      permissoes: fatos,
    }),
    packs: estadoDosPacks(fatos),
  };
}

export async function GET(request: Request, { params }: { params: { agenteId: string } }) {
  try {
    const porta = await atravessarPorta(request, params.agenteId, FALHA);
    if (!porta.ok) return porta.resposta;

    const estado = await montarEstado(porta.userId, porta.agenteId);
    if (estado === null) return responder({ ok: false, erro: "Agente não encontrado." }, 404);
    if (estado === "falha_leitura") return responder({ ok: false, erro: FALHA }, 500);

    return responder({
      ok: true,
      // O resumo lateral e a tela Revisar leem exatamente isto.
      resumo: {
        nome: estado.linha.nome,
        ativo: estado.linha.ativo,
        temInstrucoes: (estado.linha.instrucoes ?? "").trim() !== "",
        modelo: modeloDisponivel(),
        provedor: provedorDisponivel(),
        temFerramentas: estado.validacao.temFerramentas,
      },
      // Sem `funcao_id` na superficie: a pessoa escolheu packs.
      ferramentas: estado.packs
        .filter((p) => p.selecionado)
        .map((p) => ({
          id: p.pack.id, nome: p.pack.nome,
          completo: p.completo, nivel: p.nivelUniforme,
          faltando: p.semPermissao.length,
        })),
      podeAtivar: estado.validacao.podeAtivar,
      impedimentos: estado.validacao.impedimentos,
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
    if (corpo === null || typeof corpo.ativo !== "boolean") {
      return responder({ ok: false, erro: "Informe `ativo` como true ou false." }, 400);
    }

    // DESLIGAR nao passa por validacao: parar tem de ser sempre possivel.
    if (corpo.ativo === false) {
      const { linha, erro } = await atualizarAgenteDoDono(
        porta.agenteId, porta.userId, { ativo: false });
      if (erro !== null || !linha) return responder({ ok: false, erro: FALHA }, 500);
      return responder({ ok: true, ativo: false }, 200);
    }

    const estado = await montarEstado(porta.userId, porta.agenteId);
    if (estado === null) return responder({ ok: false, erro: "Agente não encontrado." }, 404);
    if (estado === "falha_leitura") return responder({ ok: false, erro: FALHA }, 500);

    // A cerca do §27: sem permissao explicita em TODA Funcao de Tool
    // escolhida, nao ativa. `bloqueado` conta como decidido.
    if (!estado.validacao.podeAtivar) {
      return responder({
        ok: false,
        erro: "Este agente ainda não pode ser ativado.",
        impedimentos: estado.validacao.impedimentos,
      }, 409);
    }

    const { linha, erro } = await atualizarAgenteDoDono(
      porta.agenteId, porta.userId, { ativo: true });
    if (erro !== null || !linha) return responder({ ok: false, erro: FALHA }, 500);

    return responder({ ok: true, ativo: true }, 200);
  } catch {
    return responder({ ok: false, erro: FALHA }, 500);
  }
}
