/**
 * GET  .../marketplaces/[marketplace]/lojas   → contas conectadas do usuário
 * POST .../marketplaces/[marketplace]/lojas   → vincula uma conta ao canal
 *
 * NUNCA EXPÕE TOKEN. O SELECT não pede `access_token`/`refresh_token`, e
 * a resposta só carrega id, nome, apelido e seller_id.
 *
 * A checagem de propriedade acontece DUAS vezes: aqui (a listagem já
 * filtra `user_id` da sessão) e dentro da RPC, que recusa loja de outro
 * usuário, de outro marketplace ou inativa. Isso importa porque
 * `getMLLojaById()` — a função de token que o CDS já tinha — **não checa
 * dono**: ela nasceu para o Worker. Sem a dupla checagem, um `lojaId`
 * forjado carregaria token alheio.
 */
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { autenticarRequisicao } from "@/lib/autenticacao";
import { buscarProjetoPorId } from "@/lib/estudio-anuncios/projetos";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";
import { resolverMarketplacePorSlug } from "@/lib/estudio-anuncios/compliance/tipos";
import { listarLojasConectadasDoDono } from "@/lib/marketplace/credenciais";
import { resolverModeloDaConta } from "@/lib/estudio-anuncios/compliance/validacao-oficial";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function autorizar(request: Request, params: { id: string; marketplace: string }) {
  const auth = await autenticarRequisicao(request);
  const userId = auth.autenticado ? auth.uid : null;
  if (!userId) return { erro: NextResponse.json({ ok: false, erro: "Não autenticado." }, { status: 401 }) };
  if (!UUID_REGEX.test(params.id)) {
    return { erro: NextResponse.json({ ok: false, erro: "id inválido." }, { status: 400 }) };
  }
  const marketplace = resolverMarketplacePorSlug(params.marketplace);
  if (!marketplace) {
    return { erro: NextResponse.json({ ok: false, erro: "Marketplace não encontrado." }, { status: 404 }) };
  }
  const projeto = await buscarProjetoPorId(supabase, userId, params.id);
  if (!projeto) {
    return { erro: NextResponse.json({ ok: false, erro: "Projeto não encontrado." }, { status: 404 }) };
  }
  return { erro: null as null, userId, marketplace };
}

export async function GET(request: Request, { params }: { params: { id: string; marketplace: string } }) {
  try {
    const auth = await autorizar(request, params);
    if (auth.erro) return auth.erro;

    // Só contas DO USUÁRIO, DO marketplace pedido, ativas e com token.
    // `access_token` não entra no select — nem para checar.
    // LOJAS-ANON-SELECT: era leitura com o cliente ANON. `access_token`
    // continua fora da projecao — entra so no filtro, dentro do banco.
    const { linhas: data, erro: error } = await listarLojasConectadasDoDono(
      auth.userId,
      auth.marketplace
    );
    if (error) throw new Error("Falha ao listar as contas conectadas.");

    return NextResponse.json({
      ok: true,
      lojas: (data ?? []).map((l: any) => ({
        id: l.id,
        nome: l.nome ?? l.nickname ?? "Conta",
        nickname: l.nickname ?? "",
        sellerId: l.seller_id ?? "",
      })),
    });
  } catch (err: any) {
    console.error("[GET .../lojas] falhou:", err?.message);
    return NextResponse.json({ ok: false, erro: "Falha ao listar contas." }, { status: 500 });
  }
}

export async function POST(request: Request, { params }: { params: { id: string; marketplace: string } }) {
  let corpo: any;
  try {
    corpo = await request.json();
  } catch {
    return NextResponse.json({ ok: false, erro: "Corpo inválido." }, { status: 400 });
  }

  try {
    const auth = await autorizar(request, params);
    if (auth.erro) return auth.erro;

    const lojaId = corpo?.lojaId;
    if (lojaId !== null && (typeof lojaId !== "string" || !UUID_REGEX.test(lojaId))) {
      return NextResponse.json({ ok: false, erro: "lojaId inválido." }, { status: 400 });
    }

    // A RPC revalida dono, marketplace e estado da loja. `p_user_id` vem
    // da SESSÃO — nunca do corpo.
    const { data, error } = await getSupabaseServidor().rpc("estudio_anuncios_vincular_loja_marketplace", {
      p_projeto_id: params.id,
      p_marketplace: auth.marketplace,
      p_loja_id: lojaId,
      p_user_id: auth.userId,
    });

    if (error) {
      const m = error.message ?? "";
      if (/LOJA_DE_OUTRO_USUARIO|PROJETO_DE_OUTRO_USUARIO|LOJA_NAO_ENCONTRADA/.test(m)) {
        // Mesmo 404 para "não existe" e "não é sua" — não vaza a diferença.
        return NextResponse.json({ ok: false, erro: "Conta não encontrada." }, { status: 404 });
      }
      if (/LOJA_DE_OUTRO_MARKETPLACE/.test(m)) {
        return NextResponse.json({ ok: false, erro: "Esta conta é de outro marketplace." }, { status: 400 });
      }
      if (/LOJA_INATIVA/.test(m)) {
        return NextResponse.json({ ok: false, erro: "Esta conta está inativa." }, { status: 400 });
      }
      if (/CANAL_NAO_ENCONTRADO/.test(m)) {
        return NextResponse.json({ ok: false, erro: "Canal não encontrado neste projeto." }, { status: 404 });
      }
      throw new Error(m);
    }

    const canal = data as any;

    // Vincular é o momento em que se sabe QUAL conta é — então é aqui
    // que o modelo de publicação é resolvido. Deixar isso só para a
    // validação criaria um impasse: o compliance bloqueia por falta de
    // modelo, e a validação não roda enquanto o compliance bloqueia.
    // Melhor-esforço: se a API não responder, a validação tenta de novo.
    let modelo: string | null = null;
    if (canal.loja_id) {
      const r = await resolverModeloDaConta(supabase, getSupabaseServidor(), {
        projetoMarketplaceId: canal.id,
        lojaId: canal.loja_id,
        userId: auth.userId,
        marketplace: auth.marketplace,
      });
      if (!("erro" in r)) modelo = r.modelo;
    }

    return NextResponse.json({
      ok: true,
      // Nenhum campo de token sai daqui.
      vinculo: { lojaId: canal.loja_id ?? null, vinculadaEm: canal.loja_vinculada_em ?? null, modeloPublicacao: modelo },
    });
  } catch (err: any) {
    console.error("[POST .../lojas] falhou:", err?.message);
    return NextResponse.json({ ok: false, erro: "Falha ao vincular a conta." }, { status: 500 });
  }
}
