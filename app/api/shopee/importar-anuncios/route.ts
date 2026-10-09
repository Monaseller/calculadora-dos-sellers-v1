import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";
import { codificarCursor, ErroImportacaoShopee, importarFatiaShopee, lerCursor } from "@/lib/anuncios/importacao-shopee";
import { autenticarRequisicao } from "@/lib/autenticacao";
import { getShopeeLojaById } from "@/lib/shopee-auth";
import { corpoSelecaoRecusada, selecionarLojaShopee } from "@/lib/shopee-loja-selecao";

// SEC-3-B1: dados sensiveis (SEC-3) so por service_role, server-side.
// O cliente nasce sob demanda — nunca no import — a partir do helper
// oficial; o isolamento por dono e da propria rota, nao do banco.
let clienteServidor: SupabaseClient | null = null;
function supabase(): SupabaseClient {
  return (clienteServidor ??= getSupabaseServidor());
}

export async function POST(request: Request) {
  const inicioMs = Date.now();   // o orcamento da fatia conta a request inteira
  const auth = await autenticarRequisicao(request);
  const userId = auth.autenticado ? auth.uid : null;
  if (!userId) {
    return NextResponse.json({ erro: true, mensagem: "Sessão inválida." }, { status: 401 });
  }

  // MULTI-LOJA V1: importa de UMA loja EXPLICITA (loja_id no corpo ou na query),
  // conferida contra as lojas Shopee ATIVAS do dono. Com uma unica loja ativa o
  // fluxo direto continua; com duas ou mais e sem loja_id → 409
  // STORE_SELECTION_REQUIRED (a tela pergunta qual). O cookie "Usar esta" NAO decide aqui.
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
  // ANUNCIOS MULTI-LOJA: anuncio Shopee historico SEM loja_id (backfill ambiguo)
  // ainda nao tem dono de loja definido. Importar agora criaria uma segunda
  // linha do mesmo item ao lado dela → recusa ANTES de qualquer chamada a Shopee.
  const { count: semLoja, error: erroSemLoja } = await supabase()
    .from("anuncios").select("id", { count: "exact", head: true })
    .eq("user_id", userId).eq("marketplace", "Shopee").is("loja_id", null);
  if (erroSemLoja) {
    return NextResponse.json({ erro: true, mensagem: "Não foi possível ler seus anúncios agora." }, { status: 503 });
  }
  if ((semLoja ?? 0) > 0) {
    return NextResponse.json({ erro: true, codigo: "ANUNCIOS_SEM_LOJA",
      mensagem: "Há anúncios Shopee antigos ainda sem loja associada. A importação fica bloqueada até essa associação ser concluída." }, { status: 409 });
  }
  // IMPORT V2 (fatias retomaveis): o cursor e validado ANTES de qualquer
  // chamada a Shopee — invalido ou de outra loja → 400, nada importado.
  const cursorLido = lerCursor(corpoPedido.cursor, selecao.lojaId);
  if (!cursorLido.ok) {
    return NextResponse.json({ erro: true, codigo: cursorLido.motivo,
      mensagem: "Não foi possível continuar a importação (marcador inválido). Inicie a importação novamente." }, { status: 400 });
  }
  // Busca a loja ESCOLHIDA com refresh automático de token
  const lojaAtiva = await getShopeeLojaById(selecao.lojaId, userId);
  if (!lojaAtiva) {
    return NextResponse.json({ erro: true, semConexao: true, mensagem: "Conta Shopee não conectada." }, { status: 401 });
  }

  // Uma FATIA por request (orcamento de tempo, item atomico, cursor por item_id
  // concluido): a tela repete com `cursor` ate `parcial: false`.
  const lojaId = selecao.lojaId;
  try {
    const r = await importarFatiaShopee({ banco: supabase(), userId, lojaId, cred: lojaAtiva, ultimoItem: cursorLido.ultimoItem, inicioMs });
    return NextResponse.json({
      parcial: r.parcial, cursor: r.cursor, loja_id: lojaId,
      importados: r.importados, atualizados: r.atualizados, ignorados: r.ignorados,
      itens_processados: r.itensProcessados, total: r.total,
    });
  } catch (e) {
    // Progresso ja gravado fica. `cursor` = ultimo item COMPLETO e gravado (retomavel dali).
    if (e instanceof ErroImportacaoShopee) {
      console.error(`[importar-anuncios] fatia interrompida (${e.codigo}): ${e.message}`);
      return NextResponse.json({ erro: true, codigo: e.codigo === "PROVIDER" ? "FALHA_SHOPEE" : "FALHA_BANCO",
        loja_id: lojaId, cursor: e.ultimoConcluido ? codificarCursor(lojaId, e.ultimoConcluido) : null,
        mensagem: e.codigo === "PROVIDER"
          ? "A Shopee recusou ou não respondeu a uma consulta de produtos. O que já foi importado foi mantido; tente novamente."
          : "Não foi possível gravar parte dos anúncios agora. O que já foi importado foi mantido; tente novamente." }, { status: 502 });
    }
    throw e;
  }
}
