/**
 * POST .../marketplaces/[marketplace]/validacao-oficial
 *
 * Submete o payload congelado ao validador OFICIAL do Mercado Livre
 * (`POST /items/validate`) e persiste o parecer (2026-08-25).
 *
 * **NENHUM ANÚNCIO É CRIADO.** `/items/validate` é o validador que a
 * própria documentação recomenda antes de publicar; não existe
 * `POST /items` nesta rota nem em nenhum arquivo deste módulo.
 *
 * O payload submetido é o MESMO artefato que a publicação futura vai
 * consumir — produzido por `montarPayloadPublicacaoMercadoLivre()` a
 * partir do parecer de compliance corrente, nunca remontado.
 *
 * Ordem de segurança imutável: sessão → UUID → slug → propriedade do
 * projeto → canal do projeto → só então service role e token (que nunca
 * sai do servidor).
 */
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { autenticarRequisicao } from "@/lib/autenticacao";
import { buscarProjetoPorId } from "@/lib/estudio-anuncios/projetos";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";
import { resolverMarketplacePorSlug } from "@/lib/estudio-anuncios/compliance/tipos";
import { buscarComplianceDoProjeto } from "@/lib/estudio-anuncios/compliance/compliance";
import {
  atualizarTiposAnuncioDaConta,
  executarValidacaoOficial,
} from "@/lib/estudio-anuncios/compliance/validacao-oficial";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  request: Request,
  { params }: { params: { id: string; marketplace: string } }
) {
  const auth = await autenticarRequisicao(request);
  const userId = auth.autenticado ? auth.uid : null;
  if (!userId) {
    return NextResponse.json({ ok: false, erro: "Não autenticado." }, { status: 401 });
  }
  if (!UUID_REGEX.test(params.id)) {
    return NextResponse.json({ ok: false, erro: "id inválido." }, { status: 400 });
  }
  const marketplace = resolverMarketplacePorSlug(params.marketplace);
  if (marketplace !== "ML") {
    return NextResponse.json({ ok: false, erro: "Validação oficial disponível apenas para o Mercado Livre." }, { status: 404 });
  }

  try {
    const projeto = await buscarProjetoPorId(supabase, userId, params.id);
    if (!projeto) {
      return NextResponse.json({ ok: false, erro: "Projeto não encontrado." }, { status: 404 });
    }

    const { data: canal } = await supabase
      .from("estudio_anuncios_projetos_marketplace")
      .select("id, loja_id")
      .eq("projeto_id", params.id)
      .eq("marketplace", marketplace)
      .maybeSingle();
    if (!canal) {
      return NextResponse.json({ ok: false, erro: "Canal não encontrado neste projeto." }, { status: 404 });
    }

    // SEC-1c-4: 1o argumento migrado para service_role. O 4o ja era
    // service_role e PERMANECE.
    const compliance = (await buscarComplianceDoProjeto(getSupabaseServidor(), params.id, projeto.nome_produto, getSupabaseServidor()))
      .find(c => c.marketplace === marketplace) ?? null;

    const r = await executarValidacaoOficial(supabase, getSupabaseServidor(), {
      projetoId: params.id,
      projetoMarketplaceId: (canal as any).id,
      marketplace,
      lojaId: (canal as any).loja_id ?? null,
      userId,
      compliance,
    });

    if ("erro" in r) {
      // Pré-condição não atendida — 409, não 500: o pedido é válido, o
      // estado é que ainda não permite.
      return NextResponse.json({ ok: false, erro: r.erro, codigo: r.codigo }, { status: 409 });
    }

    // Com a conta vinculada, os tipos de anúncio da CONTA passam a ser
    // verificáveis. Melhor-esforço: falhar aqui não invalida a validação
    // que acabou de ser feita.
    try {
      await atualizarTiposAnuncioDaConta(supabase, getSupabaseServidor(), {
        projetoMarketplaceId: (canal as any).id,
        lojaId: (canal as any).loja_id,
        userId,
        marketplace,
      });
    } catch { /* registrado como dívida, não quebra o fluxo */ }

    return NextResponse.json({
      ok: true,
      validacao: r.validacao,
      reaproveitada: r.reaproveitada,
      // O payload submetido volta para a UI poder mostrar exatamente o
      // que foi enviado. Nenhum token, nenhum segredo — só o item.
      payloadEnviado: r.artefato.payload,
      imagensReferenciadas: r.artefato.imagensReferenciadas,
    });
  } catch (err: any) {
    console.error("[POST .../validacao-oficial] falhou:", err?.message);
    return NextResponse.json({ ok: false, erro: "Falha ao validar no Mercado Livre." }, { status: 500 });
  }
}
