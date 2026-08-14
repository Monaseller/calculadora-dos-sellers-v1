/**
 * GET /api/estudio-anuncios/projetos/[id]/marketplaces/[marketplace]/categorias?q=…
 *
 * Sugestão de categoria do Mercado Livre a partir de texto (2026-08-24).
 * Usa o *category predictor* oficial (`domain_discovery/search`), que é
 * **público** — verificado em 2026-08-24, responde 200 sem OAuth.
 *
 * Isto é SUGESTÃO PARA UMA PESSOA ESCOLHER, nunca aplicação automática:
 * a rota só devolve opções; gravar acontece no PATCH, e lá a categoria é
 * verificada de novo contra `GET /categories/{id}`.
 *
 * Somente leitura. Não publica, não cria anúncio, não usa token.
 */
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { autenticarRequisicao } from "@/lib/autenticacao";
import { buscarProjetoPorId } from "@/lib/estudio-anuncios/projetos";
import { resolverMarketplacePorSlug } from "@/lib/estudio-anuncios/compliance/tipos";
import {
  buscarCategoriaML,
  ErroCatalogoML,
  REGEX_CATEGORY_ID_ML,
  sugerirCategoriasML,
} from "@/lib/estudio-anuncios/compliance/ml-catalogo";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
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
    return NextResponse.json({ ok: false, erro: "Busca de categoria disponível apenas para o Mercado Livre." }, { status: 404 });
  }

  const q = (new URL(request.url).searchParams.get("q") ?? "").trim();
  if (q.length < 3) {
    return NextResponse.json({ ok: false, erro: "Informe ao menos 3 caracteres." }, { status: 400 });
  }

  try {
    const projeto = await buscarProjetoPorId(supabase, userId, params.id);
    if (!projeto) {
      return NextResponse.json({ ok: false, erro: "Projeto não encontrado." }, { status: 404 });
    }

    // Quando o usuário digita um id (`MLB…`), resolver direto é mais
    // honesto que devolver sugestões parecidas: ou aquele id existe, ou não.
    if (REGEX_CATEGORY_ID_ML.test(q.toUpperCase())) {
      const cat = await buscarCategoriaML(q);
      return NextResponse.json({
        ok: true,
        sugestoes: cat
          ? [{ categoryId: cat.id, categoriaNome: cat.nome, caminho: cat.caminho, ehFolha: cat.ehFolha, permitePublicar: cat.settings.listingAllowed !== false }]
          : [],
      });
    }

    const sugestoes = await sugerirCategoriasML(q);
    return NextResponse.json({
      ok: true,
      sugestoes: sugestoes.map(s => ({
        categoryId: s.categoryId,
        categoriaNome: s.categoriaNome,
        caminho: s.dominioNome ? `${s.dominioNome} › ${s.categoriaNome}` : s.categoriaNome,
        ehFolha: null,
        permitePublicar: null,
      })),
    });
  } catch (err: any) {
    if (err instanceof ErroCatalogoML) {
      return NextResponse.json(
        { ok: false, erro: "Não foi possível consultar as categorias do Mercado Livre agora." },
        { status: 502 }
      );
    }
    console.error("[GET .../marketplaces/[marketplace]/categorias] falhou:", err?.message);
    return NextResponse.json({ ok: false, erro: "Falha ao buscar categorias." }, { status: 500 });
  }
}
