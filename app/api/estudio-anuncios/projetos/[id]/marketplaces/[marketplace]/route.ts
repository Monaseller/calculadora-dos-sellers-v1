/**
 * PATCH /api/estudio-anuncios/projetos/[id]/marketplaces/[marketplace]
 * GET   .../marketplaces/[marketplace]/categorias?q=…  (rota irmã)
 *
 * Configuração de PUBLICAÇÃO de um canal (2026-08-24): categoria, preço,
 * estoque, condição, tipo de anúncio e atributos.
 *
 * NÃO PUBLICA, NÃO CRIA NEM ALTERA ANÚNCIO, NÃO FAZ OAuth. As únicas
 * chamadas externas são `GET` públicos do catálogo do Mercado Livre, e
 * existem justamente para **não aceitar categoria inventada**.
 *
 * NÃO MEXE EM CONTEÚDO. Configuração de publicação e edição de conteúdo
 * são coisas separadas: nada aqui toca `conteudo_versoes`, imagens,
 * Pipeline ou score.
 *
 * Mesma ordem de segurança imutável do módulo:
 *   1) autenticarRequisicao(request) — 401 se ausente;
 *   2) UUID do projeto — 400 se inválido;
 *   3) slug de marketplace conhecido — 404 se não;
 *   4) buscarProjetoPorId(anon, userId, id) — 404 igual para inexistente
 *      e "de outro usuário";
 *   5) só então o service role, e apenas na RPC.
 * `publicacao_atualizada_por` vem SEMPRE da sessão, nunca do corpo.
 */
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { autenticarRequisicao } from "@/lib/autenticacao";
import { buscarProjetoPorId } from "@/lib/estudio-anuncios/projetos";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";
import { resolverMarketplacePorSlug } from "@/lib/estudio-anuncios/compliance/tipos";
import {
  salvarConfiguracaoPublicacao,
  validarConfiguracaoPublicacao,
} from "@/lib/estudio-anuncios/compliance/configuracao-marketplace";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(
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
  if (!marketplace) {
    return NextResponse.json({ ok: false, erro: "Marketplace não encontrado." }, { status: 404 });
  }

  let corpo: unknown;
  try {
    corpo = await request.json();
  } catch {
    return NextResponse.json({ ok: false, erro: "Corpo da requisição inválido (JSON esperado)." }, { status: 400 });
  }

  try {
    const projeto = await buscarProjetoPorId(supabase, userId, params.id);
    if (!projeto) {
      return NextResponse.json({ ok: false, erro: "Projeto não encontrado." }, { status: 404 });
    }

    // O canal precisa existir NESTE projeto — um marketplace válido que o
    // projeto não usa também é 404.
    const { data: canal } = await supabase
      .from("estudio_anuncios_projetos_marketplace")
      .select("id, categoria_settings, tipos_anuncio_disponiveis")
      .eq("projeto_id", params.id)
      .eq("marketplace", marketplace)
      .maybeSingle();
    if (!canal) {
      return NextResponse.json({ ok: false, erro: "Canal não encontrado neste projeto." }, { status: 404 });
    }

    // Os settings JÁ SALVOS entram na validação: sem eles, uma condição
    // inválida passaria quando a categoria tivesse sido salva antes.
    const validacao = await validarConfiguracaoPublicacao(
      corpo,
      marketplace,
      (canal as any).categoria_settings ?? null,
      Array.isArray((canal as any).tipos_anuncio_disponiveis)
        ? (canal as any).tipos_anuncio_disponiveis.map((t: any) => String(t?.id ?? t)).filter(Boolean)
        : null
    );
    if (!validacao.valido || !validacao.dados) {
      return NextResponse.json({ ok: false, erro: validacao.erro }, { status: 400 });
    }

    const salvo = await salvarConfiguracaoPublicacao(getSupabaseServidor(), {
      projetoId: params.id,
      marketplace,
      dados: validacao.dados,
      atualizadoPor: userId,
    });

    // O parecer de compliance NÃO é recalculado aqui: mudar os dados muda
    // o hash da entrada, então o parecer corrente passa a estar
    // desatualizado e a UI pede revalidação. Nenhum parecer é alterado.
    return NextResponse.json({ ok: true, publicacao: salvo });
  } catch (err: any) {
    console.error("[PATCH .../marketplaces/[marketplace]] falhou:", err?.message);
    return NextResponse.json({ ok: false, erro: "Falha ao salvar os dados de publicação." }, { status: 500 });
  }
}
