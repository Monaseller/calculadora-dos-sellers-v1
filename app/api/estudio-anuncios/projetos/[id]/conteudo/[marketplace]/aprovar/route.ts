/**
 * POST /api/estudio-anuncios/projetos/[id]/conteudo/[marketplace]/aprovar
 *
 * Aprova uma versão editorial (2026-08-20). Rota separada da criação de
 * propósito: **editar não é aprovar**. Salvar cria rascunho; aprovar é
 * uma decisão explícita e distinta.
 *
 * APROVAR NÃO PUBLICA. Significa apenas "esta versão foi aprovada para
 * uso". Exportação/publicação é tarefa futura e não existe aqui.
 *
 * A troca da versão aprovada (rebaixar a anterior + promover a nova) é
 * ATÔMICA, dentro da RPC — nunca dois UPDATEs independentes, que
 * deixariam uma janela com zero ou duas aprovadas. O banco ainda garante
 * "no máximo uma aprovada por canal" com índice único parcial.
 *
 * Mesma ordem de segurança do resto do módulo; `aprovado_por` vem SEMPRE
 * da sessão, nunca do corpo. Não toca em Pipeline, jobs,
 * `resultados_pipeline`, score ou imagens.
 */
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getUserId } from "@/lib/session";
import { buscarProjetoPorId } from "@/lib/estudio-anuncios/projetos";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";
import {
  aprovarVersaoEditorial,
  buscarCanalDoProjeto,
  buscarVersaoDoCanal,
} from "@/lib/estudio-anuncios/conteudo-editorial";

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
  const versaoId = body?.versaoId;
  if (typeof versaoId !== "string" || !UUID_REGEX.test(versaoId)) {
    return NextResponse.json({ ok: false, erro: "versaoId inválido." }, { status: 400 });
  }

  try {
    const projeto = await buscarProjetoPorId(supabase, userId, params.id);
    if (!projeto) {
      return NextResponse.json({ ok: false, erro: "Projeto não encontrado." }, { status: 404 });
    }

    const canal = await buscarCanalDoProjeto(supabase, params.id, decodeURIComponent(params.marketplace));
    if (!canal) {
      return NextResponse.json({ ok: false, erro: "Marketplace não pertence a este projeto." }, { status: 404 });
    }

    // A versão precisa ser DESTE canal — impede aprovar, por id, uma
    // versão de outro marketplace ou de outro projeto.
    const versao = await buscarVersaoDoCanal(supabase, canal.id, versaoId);
    if (!versao) {
      return NextResponse.json({ ok: false, erro: "Versão não encontrada neste marketplace." }, { status: 404 });
    }

    const aprovada = await aprovarVersaoEditorial(getSupabaseServidor(), versaoId, userId);
    return NextResponse.json({ ok: true, versao: aprovada });
  } catch (err: any) {
    console.error("[POST .../conteudo/[marketplace]/aprovar] falhou:", err?.message);
    return NextResponse.json({ ok: false, erro: "Falha ao aprovar a versão." }, { status: 500 });
  }
}
