import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";
import { autenticarRequisicao, lerCookie } from "@/lib/autenticacao";
import { contarLojasMLAtivasDoDono, MULTI_ML_CATALOG_NOT_READY, resolverContaML } from "@/lib/ml-conexao";
import { codificarCursorML, ErroImportacaoML, importarCatalogoML } from "@/lib/anuncios/importacao-ml";

// SEC-3-B1: dados sensiveis (SEC-3) so por service_role, server-side.
// O cliente nasce sob demanda — nunca no import — a partir do helper
// oficial; o isolamento por dono e da propria rota, nao do banco.
let clienteServidor: SupabaseClient | null = null;
function supabase(): SupabaseClient {
  return (clienteServidor ??= getSupabaseServidor());
}

/**
 * POST /api/ml/importar-anuncios — IMPORT ML V2 (CDS V2 Fase 2D): UMA fatia por request, da loja ML
 * resolvida AQUI (na borda); o motor recebe `lojaId` explicito, revalida dono + marketplace + loja e
 * resolve a credencial daquela loja. A tela repete com `cursor` ate `parcial: false`.
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
  // CDS V2 Fase 1B/2D: o catalogo ja e escopado por loja, mas 2+ contas ML do dono seguem barradas
  // (Fase 2F, depois do estado 4) ANTES de provider/escrita — mesmo com loja_ativa_id apontando uma delas.
  if (await contarLojasMLAtivasDoDono(userId) > 1) {
    return NextResponse.json({ erro: true, codigo: MULTI_ML_CATALOG_NOT_READY,
      mensagem: "Catálogo com mais de uma conta do Mercado Livre ainda não é suportado." }, { status: 409 });
  }
  // Loja na BORDA: contexto validado (loja_ativa_id, conferido por dono + ML) ou a loja ML única
  // por opt-in explícito. O motor nunca escolhe loja.
  const conta = await resolverContaML(userId, lerCookie(request, "loja_ativa_id"), { permitirUnica: true });
  if (!conta.ok) {
    return NextResponse.json({
      erro: true,
      mensagem: conta.motivo === "LOJA_NAO_DEFINIDA"
        ? "Selecione a loja do Mercado Livre."
        : "Conta do ML não conectada.",
    }, { status: 401 });
  }
  const lojaId = conta.lojaId;
  const corpo = await request.json().catch(() => ({})) as { cursor?: unknown };

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
