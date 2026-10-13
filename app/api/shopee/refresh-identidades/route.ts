import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";
import { autenticarRequisicao } from "@/lib/autenticacao";
import { getShopeeLojaById } from "@/lib/shopee-auth";
import { corpoSelecaoRecusada, selecionarLojaShopee } from "@/lib/shopee-loja-selecao";
import { codificarCursorRefresh, ErroRefreshIdentidades } from "@/lib/anuncios/refresh-identidades";
import { refrescarIdentidadesShopee } from "@/lib/anuncios/refresh-identidades-shopee";

let clienteServidor: SupabaseClient | null = null;
function supabase(): SupabaseClient {
  return (clienteServidor ??= getSupabaseServidor());
}

/**
 * POST /api/shopee/refresh-identidades — CDS V2 Fase 2H-D: refresh de IDENTIDADES CONHECIDAS de UMA loja
 * Shopee, por id (on-demand; sem agendamento). SÓ visto_em (status Shopee não provado em resposta gravada —
 * nunca NORMAL por inferência). Loja EXPLÍCITA (loja_id no corpo/query) conferida contra as lojas Shopee
 * ativas do dono, credencial DAQUELA loja — tudo antes de qualquer chamada à Shopee.
 */
export async function POST(request: Request) {
  const inicioMs = Date.now();
  const auth = await autenticarRequisicao(request);
  const userId = auth.autenticado ? auth.uid : null;
  if (!userId) {
    return NextResponse.json({ erro: true, mensagem: "Sessão inválida." }, { status: 401 });
  }
  const corpoPedido = await request.json().catch(() => ({})) as { loja_id?: string; cursor?: unknown };
  const selecao = await selecionarLojaShopee(userId, {
    lojaIdExplicito: corpoPedido.loja_id ?? new URL(request.url).searchParams.get("loja_id"), usarCookie: false,
  });
  if (!selecao.ok) {
    if (selecao.motivo === "SEM_LOJA_SHOPEE") {
      return NextResponse.json({ erro: true, semConexao: true, mensagem: "Conta Shopee não conectada." }, { status: 401 });
    }
    const { status, corpo } = corpoSelecaoRecusada(selecao);
    return NextResponse.json(corpo, { status });
  }
  const lojaId = selecao.lojaId;
  const cred = await getShopeeLojaById(lojaId, userId);
  if (!cred) {
    return NextResponse.json({ erro: true, semConexao: true, mensagem: "Conta Shopee não conectada." }, { status: 401 });
  }

  try {
    const r = await refrescarIdentidadesShopee({ banco: supabase(), userId, lojaId, cred, cursor: corpoPedido.cursor, inicioMs });
    return NextResponse.json({
      parcial: r.parcial, cursor: r.cursor, loja_id: lojaId,
      conhecidos: r.conhecidos, consultados: r.consultados, observados: r.observados, nao_observados: r.naoObservados,
      linhas_observadas: r.linhasObservadas, ids_invalidos: r.idsInvalidos, nao_observados_por_motivo: r.naoObservadosPorMotivo,
    });
  } catch (e) {
    if (!(e instanceof ErroRefreshIdentidades)) throw e;
    console.error(`[shopee/refresh-identidades] fatia interrompida (${e.codigo}${e.motivo ? `/${e.motivo}` : ""}): ${e.message}`);
    if (e.codigo === "CURSOR") {
      return NextResponse.json({ erro: true, codigo: e.motivo ?? "CURSOR_INVALIDO",
        mensagem: "Não foi possível continuar a atualização (marcador inválido). Inicie novamente." }, { status: 400 });
    }
    return NextResponse.json({ erro: true, codigo: e.codigo === "PROVIDER" ? "FALHA_SHOPEE" : "FALHA_BANCO",
      loja_id: lojaId, cursor: e.ultimoConcluido ? codificarCursorRefresh("Shopee", lojaId, e.ultimoConcluido) : null,
      mensagem: e.codigo === "PROVIDER"
        ? "A Shopee recusou ou não respondeu a uma consulta. O que já foi observado foi mantido; tente novamente."
        : "Não foi possível gravar parte das observações agora. O que já foi gravado foi mantido; tente novamente." }, { status: 502 });
  }
}
