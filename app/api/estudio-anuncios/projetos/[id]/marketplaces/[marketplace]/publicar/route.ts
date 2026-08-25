/**
 * POST .../marketplaces/[marketplace]/publicar
 *
 * **CRIA UM ANÚNCIO REAL** no Mercado Livre (`POST /items`), 2026-08-31.
 * É a única rota do módulo que produz um recurso público, e a única que
 * o usuário não pode desfazer sozinho.
 *
 * O payload publicado é o MESMO que passou pelo `/items/validate` — lido
 * da linha de validação, não remontado. As imagens vão pelos mesmos
 * `ml_picture_id` já validados; nenhuma sobe de novo.
 *
 * PROTEÇÃO CONTRA SEGUNDO ANÚNCIO, no servidor: antes de qualquer
 * chamada externa, uma RESERVA é gravada e protegida por índice UNIQUE
 * parcial. Duplo clique, requisições concorrentes e retry manual
 * esbarram nela. Desabilitar o botão na UI não seria suficiente.
 *
 * NÃO EDITA, NÃO PAUSA, NÃO FECHA, NÃO EXCLUI, NÃO SINCRONIZA.
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
import { buscarValidacoesDoProjeto } from "@/lib/estudio-anuncios/compliance/validacao-oficial";
import { buscarPicturesMapeadas } from "@/lib/estudio-anuncios/compliance/pictures-ml";
import { montarPayloadPublicacaoMercadoLivre } from "@/lib/estudio-anuncios/compliance/payload-ml";
import { publicarNoMercadoLivre } from "@/lib/estudio-anuncios/compliance/publicacao-ml";

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
    return NextResponse.json({ ok: false, erro: "Publicação disponível apenas para o Mercado Livre." }, { status: 404 });
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

    const servico = getSupabaseServidor();
    // SEC-1c-4: 1o argumento migrado para service_role. `servico` (4o)
    // ja era service_role e PERMANECE inalterado.
    const compliance = (await buscarComplianceDoProjeto(getSupabaseServidor(), params.id, projeto.nome_produto, servico))
      .find(c => c.marketplace === marketplace) ?? null;

    // Hash do payload de AGORA, montado do mesmo jeito que o GET do
    // projeto monta — inclusive com os picture ids vindos do mapa. É ele
    // que prova que nada mudou desde a validação.
    let hashPayloadAtual: string | null = null;
    if (compliance && !compliance.desatualizado && compliance.resultado?.payload && (canal as any).loja_id) {
      const picturesML = await buscarPicturesMapeadas(
        servico,
        (canal as any).loja_id,
        ((compliance.resultado.payload as any)?.pictures ?? []).map((i: any) => ({
          imagemGeradaId: i.imagem_gerada_id, checksum: i.checksum ?? null,
        }))
      );
      hashPayloadAtual = montarPayloadPublicacaoMercadoLivre({
        payloadCompliance: compliance.resultado.payload,
        lojaId: (canal as any).loja_id,
        versaoAprovadaId: compliance.resultado.fonteEditorial?.versaoAprovadaId ?? null,
        modelo: (compliance.resultado.payload as any)?.modelo_publicacao ?? null,
        familyName: (compliance.resultado.payload as any)?.family_name ?? null,
        picturesML,
      }).hashPayload;
    }

    const validacao = (await buscarValidacoesDoProjeto(
      supabase, params.id, new Map(hashPayloadAtual ? [[marketplace, hashPayloadAtual]] : [])
    )).find(v => v.marketplace === marketplace) ?? null;

    const r = await publicarNoMercadoLivre(supabase, servico, {
      projetoId: params.id,
      projetoMarketplaceId: (canal as any).id,
      marketplace,
      lojaId: (canal as any).loja_id ?? null,
      userId,
      compliance,
      validacao,
      hashPayloadAtual,
    });

    if ("erro" in r) {
      // 409 para conflito de estado, 422 para pré-condição não atendida.
      // Nunca 500: são recusas legítimas, não falhas do servidor.
      const status = r.codigo === "ja_publicado" ? 409 : 422;
      return NextResponse.json({ ok: false, erro: r.erro, codigo: r.codigo }, { status });
    }

    return NextResponse.json(
      {
        ok: true,
        publicacao: r.publicacao,
        // O item real, como o Mercado Livre o devolve. Sem credencial.
        item: r.itemReal,
        divergencias: r.divergencias,
      },
      { status: r.publicacao.status === "publicado" ? 201 : 200 }
    );
  } catch (err: any) {
    console.error("[POST .../publicar] falhou:", err?.message);
    return NextResponse.json({ ok: false, erro: "Falha ao publicar o anúncio." }, { status: 500 });
  }
}
