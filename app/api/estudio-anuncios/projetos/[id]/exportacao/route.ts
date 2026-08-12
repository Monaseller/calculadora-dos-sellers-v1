/**
 * POST /api/estudio-anuncios/projetos/[id]/exportacao
 *
 * Gera um pacote de exportação a partir do conteúdo APROVADO do projeto
 * (2026-08-21). O histórico de pacotes é devolvido pelo GET do projeto —
 * não há rota de listagem separada, para não criar endpoint paralelo.
 *
 * NÃO PUBLICA, NÃO EXPORTA ARQUIVO, NÃO CHAMA SERVIÇO EXTERNO. Gerar um
 * pacote é congelar dados estruturados no banco.
 *
 * Mesma ordem de segurança imutável do módulo:
 *   1) getUserId(request) — 401 se ausente;
 *   2) formato UUID — 400 se inválido;
 *   3) buscarProjetoPorId(anon, userId, id) — inexistente e "de outro
 *      usuário" devolvem o MESMO 404;
 *   4) só depois disso o service role é usado, exclusivamente na RPC.
 * `gerado_por` vem SEMPRE da sessão, nunca do corpo.
 *
 * 409 quando NENHUM canal tem versão aprovada: não se gera pacote vazio,
 * e nunca há fallback para versão não aprovada.
 */
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getUserId } from "@/lib/session";
import { buscarProjetoPorId } from "@/lib/estudio-anuncios/projetos";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";
import {
  calcularHashConteudo,
  gerarPacoteExportacao,
  montarItensIncluidos,
  statusDoPacote,
  temAlgumCanalExportavel,
} from "@/lib/estudio-anuncios/exportacao";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  const userId = getUserId(request);
  if (!userId) {
    return NextResponse.json({ ok: false, erro: "Não autenticado." }, { status: 401 });
  }
  if (!UUID_REGEX.test(params.id)) {
    return NextResponse.json({ ok: false, erro: "id inválido." }, { status: 400 });
  }

  try {
    const projeto = await buscarProjetoPorId(supabase, userId, params.id);
    if (!projeto) {
      return NextResponse.json({ ok: false, erro: "Projeto não encontrado." }, { status: 404 });
    }

    const itens = await montarItensIncluidos(supabase, params.id, projeto.nome_produto);

    if (!temAlgumCanalExportavel(itens)) {
      return NextResponse.json(
        { ok: false, erro: "Nenhum canal tem versão aprovada — aprove ao menos uma versão antes de exportar." },
        { status: 409 }
      );
    }

    const hashConteudo = calcularHashConteudo(itens);
    const pacote = await gerarPacoteExportacao(getSupabaseServidor(), {
      projetoId: params.id,
      itens,
      hashConteudo,
      status: statusDoPacote(itens),
      geradoPor: userId,
    });

    // `reaproveitado` diz à UI que nada mudou desde o último pacote — a
    // requisição foi idempotente, não houve duplicação.
    const reaproveitado = pacote.itens?.geradoEm !== itens.geradoEm;
    return NextResponse.json({ ok: true, pacote, reaproveitado }, { status: reaproveitado ? 200 : 201 });
  } catch (err: any) {
    console.error("[POST /api/estudio-anuncios/projetos/[id]/exportacao] falhou:", err?.message);
    return NextResponse.json({ ok: false, erro: "Falha ao gerar o pacote de exportação." }, { status: 500 });
  }
}
