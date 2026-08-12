/**
 * POST /api/estudio-anuncios/projetos/[id]/compliance/[marketplace]
 *
 * Valida a PRÉ-PUBLICAÇÃO de um canal (2026-08-23). O parecer corrente de
 * todos os canais vem junto com o GET do projeto — não há rota de
 * listagem paralela.
 *
 * NÃO PUBLICA, NÃO CRIA NEM ALTERA ANÚNCIO, NÃO CHAMA API DE MARKETPLACE,
 * NÃO FAZ OAUTH, NÃO CHAMA IA. Toda a validação é local e determinística;
 * a única escrita é a linha imutável de auditoria do próprio compliance.
 *
 * Mesma ordem de segurança imutável do módulo:
 *   1) getUserId(request) — 401 se ausente;
 *   2) formato UUID do projeto — 400 se inválido;
 *   3) slug de marketplace conhecido — 404 se não (não vaza a lista);
 *   4) buscarProjetoPorId(anon, userId, id) — inexistente e "de outro
 *      usuário" devolvem o MESMO 404;
 *   5) só então o service role entra, e apenas na RPC de registro.
 * `criado_por` vem SEMPRE da sessão, nunca do corpo.
 */
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getUserId } from "@/lib/session";
import { buscarProjetoPorId } from "@/lib/estudio-anuncios/projetos";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";
import {
  montarEntradaCompliance,
  registrarCompliance,
  validarCompliance,
} from "@/lib/estudio-anuncios/compliance/compliance";
import { motivoNaoPublicavel, podePublicarMarketplace } from "@/lib/estudio-anuncios/compliance/registry";
import { resolverMarketplacePorSlug } from "@/lib/estudio-anuncios/compliance/tipos";

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

  const marketplace = resolverMarketplacePorSlug(params.marketplace);
  if (!marketplace) {
    return NextResponse.json({ ok: false, erro: "Marketplace não encontrado." }, { status: 404 });
  }

  try {
    const projeto = await buscarProjetoPorId(supabase, userId, params.id);
    if (!projeto) {
      return NextResponse.json({ ok: false, erro: "Projeto não encontrado." }, { status: 404 });
    }

    // O service role entra SÓ para ler os bytes das imagens no Storage e
    // calcular o checksum — a checagem de dono já aconteceu acima.
    const entrada = await montarEntradaCompliance(
      supabase,
      { projetoId: params.id, nomeProduto: projeto.nome_produto, marketplace },
      getSupabaseServidor()
    );
    const resultado = validarCompliance(entrada);

    const { registro, reaproveitado } = await registrarCompliance(getSupabaseServidor(), {
      projetoId: params.id,
      resultado,
      criadoPor: userId,
    });

    // `bloqueado` e `nao_implementado` NÃO são erro HTTP: a validação
    // rodou e o parecer é o produto. Responder 4xx aqui faria a UI tratar
    // um resultado legítimo como falha.
    return NextResponse.json(
      {
        ok: true,
        compliance: registro,
        reaproveitado,
        podePublicar: podePublicarMarketplace(registro.resultado),
        motivo: motivoNaoPublicavel(registro.resultado),
      },
      { status: reaproveitado ? 200 : 201 }
    );
  } catch (err: any) {
    console.error("[POST .../compliance/[marketplace]] falhou:", err?.message);
    return NextResponse.json({ ok: false, erro: "Falha ao validar a pré-publicação." }, { status: 500 });
  }
}
