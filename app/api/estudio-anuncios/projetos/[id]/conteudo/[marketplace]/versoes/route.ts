/**
 * POST /api/estudio-anuncios/projetos/[id]/conteudo/[marketplace]/versoes
 *
 * Cria uma NOVA versão editorial do conteúdo de um marketplace
 * (2026-08-20). Rota explícita e REST-like, seguindo a convenção do
 * módulo — nunca um endpoint genérico com campo "action".
 *
 * Segurança, na mesma ordem imutável do resto do módulo:
 *   1) getUserId(request) — 401 se ausente;
 *   2) formato UUID de params.id — 400 se inválido;
 *   3) buscarProjetoPorId(anon, userId, id) — inexistente e "de outro
 *      usuário" devolvem o MESMO 404;
 *   4) o marketplace precisa pertencer AO PROJETO — 404 caso contrário;
 *   5) só DEPOIS de tudo isso o service role é usado, exclusivamente
 *      para a RPC restrita.
 * `criado_por` vem SEMPRE da sessão — nunca do corpo da requisição.
 *
 * APPEND-ONLY: isto nunca faz UPDATE de versão anterior, e **nunca**
 * toca em `resultados_pipeline`, `jobs`, Pipeline, score ou imagens.
 * Salvar cria rascunho; aprovar é uma ação separada e explícita.
 */
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getUserId } from "@/lib/session";
import { buscarProjetoPorId } from "@/lib/estudio-anuncios/projetos";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";
import { buscarResultadosPipelinePorProjeto } from "@/lib/estudio-anuncios/resultados";
import {
  buscarCanalDoProjeto,
  conteudoDaAdaptacao,
  criarVersaoEditorial,
  validarConteudoEditorial,
} from "@/lib/estudio-anuncios/conteudo-editorial";
import type { EnvelopeAdaptacaoMarketplace } from "@/lib/estudio-anuncios/adaptacao-marketplace-tipos";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  request: Request,
  { params }: { params: { id: string; marketplace: string } }
) {
  const userId = getUserId(request);
  if (!userId) {
    return NextResponse.json({ ok: false, erro: "Não autenticado." }, { status: 401 });
  }
  if (!UUID_REGEX.test(params.id)) {
    return NextResponse.json({ ok: false, erro: "id inválido." }, { status: 400 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, erro: "Corpo da requisição inválido (JSON esperado)." }, { status: 400 });
  }

  const validacao = validarConteudoEditorial(body?.conteudo);
  if (!validacao.valido || !validacao.dados) {
    return NextResponse.json({ ok: false, erro: validacao.erro }, { status: 400 });
  }
  const requestId = typeof body?.requestId === "string" && body.requestId.length <= 100 ? body.requestId : null;

  try {
    const projeto = await buscarProjetoPorId(supabase, userId, params.id);
    if (!projeto) {
      return NextResponse.json({ ok: false, erro: "Projeto não encontrado." }, { status: 404 });
    }

    const marketplace = decodeURIComponent(params.marketplace);
    const canal = await buscarCanalDoProjeto(supabase, params.id, marketplace);
    if (!canal) {
      return NextResponse.json({ ok: false, erro: "Marketplace não pertence a este projeto." }, { status: 404 });
    }

    // A versão 1 (snapshot da IA) é materializada lazily pela RPC, e só
    // pode nascer da adaptação REAL deste canal. Sem adaptação, não há
    // camada editorial — nunca se fabrica uma base vazia.
    const resultados = await buscarResultadosPipelinePorProjeto(supabase, params.id);
    const linhaAdaptacao = resultados.get("adaptacao_marketplace");
    const envelope = linhaAdaptacao?.resultado as EnvelopeAdaptacaoMarketplace | undefined;
    const adaptacao = (envelope?.saida?.adaptacoes ?? []).find(a => a.marketplace === marketplace);
    if (!adaptacao) {
      return NextResponse.json(
        { ok: false, erro: "Conteúdo ainda não disponível para edição neste marketplace." },
        { status: 409 }
      );
    }

    const versao = await criarVersaoEditorial(getSupabaseServidor(), {
      projetoMarketplaceId: canal.id,
      conteudo: validacao.dados,
      origem: "edicao_manual",
      criadoPor: userId,
      requestId,
      baseConteudo: conteudoDaAdaptacao(adaptacao),
      baseResultadoId: linhaAdaptacao?.id ?? null,
    });

    return NextResponse.json({ ok: true, versao }, { status: 201 });
  } catch (err: any) {
    console.error("[POST .../conteudo/[marketplace]/versoes] falhou:", err?.message);
    return NextResponse.json({ ok: false, erro: "Falha ao salvar a nova versão." }, { status: 500 });
  }
}
