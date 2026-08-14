/**
 * Arquivo (ZIP) de um pacote de exportação — 2026-08-22.
 *
 *   POST  .../exportacao/{pacoteId}/arquivo   → materializa (idempotente)
 *   GET   .../exportacao/{pacoteId}/arquivo   → URL assinada de download
 *
 * NÃO PUBLICA EM MARKETPLACE, NÃO CHAMA IA, NÃO ENVIA NADA PARA FORA. O
 * ZIP é montado a partir do pacote CONGELADO e vai para um bucket
 * privado; o download é sempre por URL assinada curta gerada na hora.
 *
 * Mesma ordem de segurança imutável do módulo:
 *   1) autenticarRequisicao(request) — 401 se ausente;
 *   2) formato UUID dos DOIS ids — 400 se inválido;
 *   3) buscarProjetoPorId(anon, userId, id) — inexistente e "de outro
 *      usuário" devolvem o MESMO 404;
 *   4) buscarPacoteDoProjeto(projetoId, pacoteId) — pacote de outro
 *      projeto também é 404, nunca 403;
 *   5) só então o service role entra, e apenas para Storage/RPC.
 *
 * `storage_path` NUNCA aparece na resposta: o DTO público é montado por
 * `paraDTOPublico()`, que remove caminho e bucket.
 */
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { autenticarRequisicao } from "@/lib/autenticacao";
import { buscarProjetoPorId } from "@/lib/estudio-anuncios/projetos";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";
import { buscarPacoteDoProjeto, paraDTOPublico } from "@/lib/estudio-anuncios/exportacao";
import type { PacoteExportacaoUI } from "@/lib/estudio-anuncios/exportacao";
import {
  ErroChecksumDivergente,
  gerarLinkDownload,
  materializarPacote,
  nomeDownload,
} from "@/lib/estudio-anuncios/exportacao-arquivo";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Params = { params: { id: string; pacoteId: string } };

type Autorizacao =
  | { erro: NextResponse }
  | { erro: null; userId: string; pacote: PacoteExportacaoUI };

/** Passos 1–4 acima, uma vez só, para POST e GET não divergirem. */
async function autorizar(request: Request, params: Params["params"]): Promise<Autorizacao> {
  const auth = await autenticarRequisicao(request);
  const userId = auth.autenticado ? auth.uid : null;
  if (!userId) return { erro: NextResponse.json({ ok: false, erro: "Não autenticado." }, { status: 401 }) };
  if (!UUID_REGEX.test(params.id) || !UUID_REGEX.test(params.pacoteId)) {
    return { erro: NextResponse.json({ ok: false, erro: "id inválido." }, { status: 400 }) };
  }
  const projeto = await buscarProjetoPorId(supabase, userId, params.id);
  if (!projeto) {
    return { erro: NextResponse.json({ ok: false, erro: "Projeto não encontrado." }, { status: 404 }) };
  }
  const pacote = await buscarPacoteDoProjeto(supabase, params.id, params.pacoteId);
  if (!pacote) {
    return { erro: NextResponse.json({ ok: false, erro: "Pacote não encontrado." }, { status: 404 }) };
  }
  return { erro: null, userId, pacote };
}

export async function POST(request: Request, { params }: Params) {
  try {
    const auth = await autorizar(request, params);
    if (auth.erro) return auth.erro;

    const r = await materializarPacote(getSupabaseServidor(), {
      pacote: auth.pacote,
      userId: auth.userId,
      projetoId: params.id,
    });

    return NextResponse.json(
      {
        ok: true,
        pacote: paraDTOPublico(r.pacote),
        reaproveitado: r.reaproveitado,
        rematerializado: r.rematerializado,
      },
      { status: r.reaproveitado || r.rematerializado ? 200 : 201 }
    );
  } catch (err: any) {
    if (err instanceof ErroChecksumDivergente) {
      // 409: o pacote existe, mas rematerializar produziria bytes
      // diferentes dos registrados. Nada foi enviado ao Storage.
      return NextResponse.json(
        { ok: false, erro: "O arquivo reconstruído não confere com o registrado. Nada foi alterado." },
        { status: 409 }
      );
    }
    console.error("[POST .../exportacao/[pacoteId]/arquivo] falhou:", err?.message);
    return NextResponse.json({ ok: false, erro: "Falha ao gerar o arquivo do pacote." }, { status: 500 });
  }
}

export async function GET(request: Request, { params }: Params) {
  try {
    const auth = await autorizar(request, params);
    if (auth.erro) return auth.erro;

    const link = await gerarLinkDownload(getSupabaseServidor(), auth.pacote);
    if (!link) {
      // Sem arquivo ainda (ou falha ao assinar): a UI oferece gerar.
      return NextResponse.json(
        { ok: false, erro: "Este pacote ainda não tem arquivo gerado." },
        { status: 409 }
      );
    }

    return NextResponse.json({
      ok: true,
      url: link.url,
      expiraEmSegundos: link.expiraEmSegundos,
      nomeArquivo: nomeDownload(auth.pacote),
    });
  } catch (err: any) {
    console.error("[GET .../exportacao/[pacoteId]/arquivo] falhou:", err?.message);
    return NextResponse.json({ ok: false, erro: "Falha ao gerar o link de download." }, { status: 500 });
  }
}
