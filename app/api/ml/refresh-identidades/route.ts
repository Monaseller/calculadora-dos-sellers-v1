import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";
import { autenticarRequisicao, lerCookie } from "@/lib/autenticacao";
import { LOJA_ML_INVALIDA, ML_STORE_SELECTION_REQUIRED, referenciaDeLojaML, resolverLojaCatalogoML, respostaSelecaoLojaML } from "@/lib/ml-loja-catalogo";
import { codificarCursorRefresh, ErroRefreshIdentidades } from "@/lib/anuncios/refresh-identidades";
import { refrescarIdentidadesML } from "@/lib/anuncios/refresh-identidades-ml";

let clienteServidor: SupabaseClient | null = null;
function supabase(): SupabaseClient {
  return (clienteServidor ??= getSupabaseServidor());
}

/**
 * POST /api/ml/refresh-identidades — CDS V2 Fase 2H-D: refresh de IDENTIDADES CONHECIDAS da loja ML, por
 * id (on-demand; sem agendamento). UMA fatia por request; a tela repete com `loja_id` + `cursor` até
 * `parcial: false`. Só observação (visto_em + status RAW quando o ML o traz) — nunca `ativo`, nunca
 * status por ausência/404. Contadores próprios (não são importados/atualizados/ignorados).
 */
export async function POST(request: Request) {
  const inicioMs = Date.now();
  const auth = await autenticarRequisicao(request);
  const userId = auth.autenticado ? auth.uid : null;
  if (!userId) {
    return NextResponse.json({ erro: true, mensagem: "Sessão inválida." }, { status: 401 });
  }
  // Loja na BORDA, ANTES do provider (mesmo contrato do catálogo): referência validada por dono + ML +
  // ativa; sem referência, só a loja ML única; 2+ sem referência → ML_STORE_SELECTION_REQUIRED.
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
    const r = await refrescarIdentidadesML({ banco: supabase(), userId, lojaId, cursor: corpo?.cursor, inicioMs });
    return NextResponse.json({
      parcial: r.parcial, cursor: r.cursor, loja_id: lojaId,
      conhecidos: r.conhecidos, consultados: r.consultados, observados: r.observados, nao_observados: r.naoObservados,
      linhas_observadas: r.linhasObservadas, ids_invalidos: r.idsInvalidos, nao_observados_por_motivo: r.naoObservadosPorMotivo,
    });
  } catch (e) {
    if (!(e instanceof ErroRefreshIdentidades)) throw e;
    console.error(`[ml/refresh-identidades] fatia interrompida (${e.codigo}${e.motivo ? `/${e.motivo}` : ""}): ${e.message}`);
    if (e.codigo === "CURSOR") {
      return NextResponse.json({ erro: true, codigo: e.motivo ?? "CURSOR_INVALIDO",
        mensagem: "Não foi possível continuar a atualização (marcador inválido). Inicie novamente." }, { status: 400 });
    }
    if (e.codigo === "LOJA" || e.codigo === "TOKEN") {
      return NextResponse.json({ erro: true, codigo: e.codigo === "TOKEN" ? "TOKEN_ML" : "LOJA_ML",
        mensagem: e.codigo === "TOKEN" ? "Token ML expirado." : "Conta do ML não conectada." }, { status: 401 });
    }
    return NextResponse.json({ erro: true, codigo: e.codigo === "PROVIDER" ? "FALHA_ML" : "FALHA_BANCO",
      loja_id: lojaId, cursor: e.ultimoConcluido ? codificarCursorRefresh("ML", lojaId, e.ultimoConcluido) : null,
      mensagem: e.codigo === "PROVIDER"
        ? "O Mercado Livre recusou ou não respondeu a uma consulta. O que já foi observado foi mantido; tente novamente."
        : "Não foi possível gravar parte das observações agora. O que já foi gravado foi mantido; tente novamente." }, { status: 502 });
  }
}
