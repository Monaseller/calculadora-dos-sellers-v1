/**
 * Biblioteca de Skills do dono — F7b.1.
 *
 * GET   lista as Skills do usuario
 * POST  cria uma Skill a partir dos campos da UI
 *
 * ── Esta rota e ADAPTADOR, e nada mais ──────────────────────────────
 *
 * Ela nao gera slug, nao escolhe versao, nao monta manifesto, nao
 * calcula hash, nao varre segredo e nao escreve no banco. Ela:
 *
 *   1. confere a sessao;
 *   2. compoe o documento (`comporDocumentoDeSkill`, puro);
 *   3. entrega a `importarEPersistirSkill`, que faz tudo o resto.
 *
 * O §18 do gate pedia exatamente isso, e o motivo e concreto: as regras
 * de formato sao de 20260922 e tem oito passos em ordem, incluindo a
 * varredura de segredo. Uma rota que reimplementasse metade seria uma
 * segunda verdade que divergiria na primeira mudanca.
 *
 * ── Skill NAO e por agente ──────────────────────────────────────────
 *
 * Ela pertence ao DONO e pode ser vinculada a varios agentes — por isso
 * esta rota nao mora sob `/agentes/[agenteId]`. O vinculo tem rota
 * propria, criada no F7a.
 */
import { NextResponse } from "next/server";

import { autenticarRequisicao } from "@/lib/autenticacao";
import { importarEPersistirSkill } from "@/lib/agentes/skills/escrita";
import { comporDocumentoDeSkill } from "@/lib/agentes/skills/compor";
import { filtrosSkillsDoDono } from "@/lib/agentes/skills/estado";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";

export const dynamic = "force-dynamic";

function responder(corpo: unknown, status: number): NextResponse {
  return NextResponse.json(corpo, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: Request) {
  try {
    const auth = await autenticarRequisicao(request);
    if (!auth.autenticado) return responder({ ok: false, erro: "Não autenticado." }, 401);

    // `filtrosSkillsDoDono` e o mesmo filtro que a suite da 1D.d cobra —
    // reusado para nao existir uma segunda forma de "as Skills do dono".
    const filtros = filtrosSkillsDoDono(auth.uid);
    let q = getSupabaseServidor().from("skills")
      .select("id,slug,versao,nome,manifesto,vigente,criado_em");
    for (const [coluna, valor] of Object.entries(filtros)) q = q.eq(coluna, valor);

    const { data, error } = await q.order("criado_em", { ascending: false });
    if (error) return responder({ ok: false, erro: "Nao foi possivel carregar as Skills." }, 500);

    return responder({
      ok: true,
      skills: (data ?? []).map((l) => {
        const linha = l as {
          id: string; slug: string; versao: string; nome: string;
          manifesto: { descricao?: string; quando_usar?: string[] } | null;
          vigente: boolean; criado_em: string;
        };
        return {
          id: linha.id,
          nome: linha.nome,
          versao: linha.versao,
          descricao: linha.manifesto?.descricao ?? null,
          quandoUsar: linha.manifesto?.quando_usar ?? [],
          vigente: linha.vigente,
          criadoEm: linha.criado_em,
        };
      }),
    }, 200);
  } catch {
    return responder({ ok: false, erro: "Nao foi possivel carregar as Skills." }, 500);
  }
}

export async function POST(request: Request) {
  try {
    const auth = await autenticarRequisicao(request);
    if (!auth.autenticado) return responder({ ok: false, erro: "Não autenticado." }, 401);

    let corpo: Record<string, unknown>;
    try {
      const bruto: unknown = await request.json();
      if (typeof bruto !== "object" || bruto === null || Array.isArray(bruto)) {
        return responder({ ok: false, erro: "Corpo inválido." }, 400);
      }
      corpo = bruto as Record<string, unknown>;
    } catch {
      return responder({ ok: false, erro: "Corpo inválido." }, 400);
    }

    const composto = comporDocumentoDeSkill({
      nome: corpo.nome,
      quandoUsar: corpo.quandoUsar,
      instrucoes: corpo.instrucoes,
      descricao: corpo.descricao,
    });
    if (!composto.ok) {
      return responder({ ok: false, erro: composto.mensagem, codigo: composto.codigo }, 400);
    }

    // O dono vem da SESSAO. O corpo nao pode dizer de quem e a Skill.
    const r = await importarEPersistirSkill({ userId: auth.uid, texto: composto.texto });

    // `ja_existia` NAO e erro: e a pessoa salvando duas vezes o mesmo
    // documento, e o serviço e idempotente por hash. Devolver 200 com o
    // id deixa a UI seguir para "adicionar ao agente" em vez de mostrar
    // um erro que nao aconteceu.
    if (r.estado === "criada" || r.estado === "ja_existia") {
      return responder(
        { ok: true, skillId: r.skillId, slug: composto.slug, novaSkill: r.estado === "criada" },
        r.estado === "criada" ? 201 : 200);
    }

    // Os estados sao os REAIS do serviço, nao inventados aqui.
    const porEstado: Record<string, { status: number; erro: string }> = {
      recusada: { status: 400, erro: "A Skill não passou na validação de formato." },
      conflito_versao: {
        status: 409,
        erro: "Você já tem uma Skill com este nome numa versão diferente.",
      },
      entrada_invalida: { status: 400, erro: "Dados inválidos." },
      falha_escrita: { status: 500, erro: "Nao foi possivel salvar a Skill." },
    };
    const mapeado = porEstado[r.estado] ?? { status: 500, erro: "Nao foi possivel salvar." };

    return responder({
      ok: false,
      estado: r.estado,
      erro: mapeado.erro,
      // Os motivos ajudam a pessoa a corrigir. Sao codigos do FORMATO
      // (`segredo_encontrado`, `campo_invalido`…), nunca o conteudo que
      // foi recusado — em especial nunca o segredo que ele achou.
      motivos: r.estado === "recusada" ? r.motivos : undefined,
    }, mapeado.status);
  } catch {
    return responder({ ok: false, erro: "Nao foi possivel salvar a Skill." }, 500);
  }
}
