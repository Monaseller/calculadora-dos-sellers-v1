import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";
import { autenticarRequisicao, lerCookie } from "@/lib/autenticacao";
import { LOJA_ML_INVALIDA, ML_STORE_SELECTION_REQUIRED, referenciaDeLojaML, resolverLojaCatalogoML, respostaSelecaoLojaML } from "@/lib/ml-loja-catalogo";
import { codificarCursorML, ErroImportacaoML, importarCatalogoML } from "@/lib/anuncios/importacao-ml";

// SEC-3-B1: dados sensiveis (SEC-3) so por service_role, server-side.
// O cliente nasce sob demanda — nunca no import — a partir do helper
// oficial; o isolamento por dono e da propria rota, nao do banco.
let clienteServidor: SupabaseClient | null = null;
function supabase(): SupabaseClient {
  return (clienteServidor ??= getSupabaseServidor());
}

/**
 * POST /api/ml/importar-anuncios — IMPORT ML V2 (CDS V2 Fase 2D/2F): UMA fatia por request, da loja ML
 * resolvida AQUI (na borda); o motor recebe `lojaId` explicito, revalida dono + marketplace + loja e
 * resolve a credencial daquela loja. A tela repete com `loja_id` + `cursor` ate `parcial: false`.
 */
export async function POST(request: Request) {
  const inicioMs = Date.now();   // o orcamento da fatia conta a request inteira
  // A sessão vem PRIMEIRO: o token do ML só é resolvido para uma loja que
  // pertence a este usuário (F0.c.4).
  const auth        = await autenticarRequisicao(request);
  const userId      = auth.autenticado ? auth.uid : null;
  if (!userId) {
    return NextResponse.json({ erro: true, mensagem: "Sessão inválida." }, { status: 401 });
  }
  // CDS V2 Fase 2F: loja na BORDA, ANTES de provider/escrita. `loja_id` da ação (ou o contexto
  // loja_ativa_id) é só referência, validada por dono + ML + ativa; sem referência, só a loja ML
  // ÚNICA; 2+ lojas sem referência → ML_STORE_SELECTION_REQUIRED. O motor nunca escolhe loja.
  const corpo = await request.json().catch(() => ({})) as { cursor?: unknown; loja_id?: unknown };
  const loja = await resolverLojaCatalogoML(userId, referenciaDeLojaML(corpo, lerCookie(request, "loja_ativa_id")));
  if (!loja.ok) {
    if (loja.motivo === ML_STORE_SELECTION_REQUIRED || loja.motivo === LOJA_ML_INVALIDA) {
      const { status, corpo: recusa } = respostaSelecaoLojaML(loja);
      return NextResponse.json(recusa, { status });
    }
    return NextResponse.json({ erro: true, mensagem: "Conta do ML não conectada." }, { status: 401 });
  }
  const lojaId = loja.conta.lojaId;

  try {
    const r = await importarCatalogoML({ banco: supabase(), userId, lojaId, cursor: corpo?.cursor, inicioMs });
    return NextResponse.json({
      parcial: r.parcial, cursor: r.cursor, loja_id: lojaId,
      importados: r.importados, atualizados: r.atualizados, ignorados: r.ignorados,
      itens_processados: r.itensProcessados, total: r.total,
    });
  } catch (e) {
    if (!(e instanceof ErroImportacaoML)) throw e;
    // Progresso ja gravado fica. `cursor` = ultimo lote COMPLETO e gravado (retomavel dali).
    console.error(`[ml/importar-anuncios] fatia interrompida (${e.codigo}${e.motivo ? `/${e.motivo}` : ""}): ${e.message}`);
    if (e.codigo === "CURSOR") {
      return NextResponse.json({ erro: true, codigo: e.motivo ?? "CURSOR_INVALIDO",
        mensagem: "Não foi possível continuar a importação (marcador inválido). Inicie a importação novamente." }, { status: 400 });
    }
    if (e.codigo === "LOJA" || e.codigo === "TOKEN") {
      return NextResponse.json({ erro: true, codigo: e.codigo === "TOKEN" ? "TOKEN_ML" : "LOJA_ML",
        mensagem: e.codigo === "TOKEN" ? "Token ML expirado." : "Conta do ML não conectada." }, { status: 401 });
    }
    return NextResponse.json({ erro: true, codigo: e.codigo === "PROVIDER" ? "FALHA_ML" : "FALHA_BANCO",
      loja_id: lojaId, cursor: e.ultimoConcluido ? codificarCursorML(lojaId, e.ultimoConcluido) : null,
      mensagem: e.codigo === "PROVIDER"
        ? "O Mercado Livre recusou ou não respondeu a uma consulta de anúncios. O que já foi importado foi mantido; tente novamente."
        : "Não foi possível gravar parte dos anúncios agora. O que já foi importado foi mantido; tente novamente." }, { status: 502 });
  }
}
