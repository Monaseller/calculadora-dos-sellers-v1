import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";
import { autenticarRequisicao, lerCookie } from "@/lib/autenticacao";
import { contarLojasMLAtivasDoDono, MULTI_ML_VENDAS_NOT_READY, resolverContaML } from "@/lib/ml-conexao";

// SEC-3-B1: dados sensiveis (SEC-3) so por service_role, server-side.
// O cliente nasce sob demanda — nunca no import — a partir do helper
// oficial; o isolamento por dono e da propria rota, nao do banco.
let clienteServidor: SupabaseClient | null = null;
function supabase(): SupabaseClient {
  return (clienteServidor ??= getSupabaseServidor());
}

// ── Helpers ────────────────────────────────────────────────────────────────

function hojeISO() {
  // Retorna YYYY-MM-DD no horário de Brasília (UTC-3)
  const now = new Date();
  const brasilia = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  return brasilia.toISOString().split("T")[0];
}

// ── GET /api/ml/vendas-hoje ────────────────────────────────────────────────
export async function GET(request: Request) {
  // ── SEC-3-B1: sessão OBRIGATÓRIA ──────────────────────────────────
  // Era opcional ("`userId` só refina a consulta"): sem sessão, a busca de
  // anúncios saía SEM filtro de dono — custos e anúncios de todos — e o
  // `vendas_dia` era gravado para eles. Com service_role o banco não
  // filtra nada, então o dono vem SEMPRE da sessão, antes de qualquer coisa.
  const auth = await autenticarRequisicao(request);
  if (!auth.autenticado) {
    return NextResponse.json({ erro: true, mensagem: "Sessao invalida." }, { status: 401 });
  }
  const userId = auth.uid;

  // CDS V2 Fase 1B: credencial por loja, resolvida no servidor (nunca o cookie de token).
  // `vendas_dia` é gravado por anúncio e `anuncios` ML ainda não tem loja_id (Fase 2):
  // com 2+ contas ML do dono, falha fechado antes de provider/escrita.
  if (await contarLojasMLAtivasDoDono(userId) > 1) {
    return NextResponse.json({ erro: true, codigo: MULTI_ML_VENDAS_NOT_READY,
      mensagem: "Vendas com mais de uma conta do Mercado Livre ainda não são suportadas." }, { status: 409 });
  }
  const conta = await resolverContaML(userId, lerCookie(request, "loja_ativa_id"), { permitirUnica: true });
  if (!conta.ok) {
    return NextResponse.json({ erro: true, semConexao: true, mensagem: "Conta do Mercado Livre não conectada." });
  }
  const token = conta.accessToken;

  // 1. Busca dados do usuário ML para obter o seller_id
  const meRes = await fetch("https://api.mercadolibre.com/users/me", {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!meRes.ok) {
    return NextResponse.json({ erro: true, tokenExpirado: true, mensagem: "Sessão do Mercado Livre expirada. Reconecte." });
  }

  const me = await meRes.json();
  const sellerId: number = me.id;

  // 2. Datas de hoje no formato ISO 8601 com timezone
  const hoje = hojeISO();
  const dataInicio = `${hoje}T00:00:00.000-03:00`;
  const dataFim    = `${hoje}T23:59:59.999-03:00`;

  // 3. Busca pedidos pagos de hoje
  const ordersUrl = `https://api.mercadolibre.com/orders/search?seller=${sellerId}&order.status=paid&order.date_created.from=${encodeURIComponent(dataInicio)}&order.date_created.to=${encodeURIComponent(dataFim)}&limit=50`;

  const ordersRes = await fetch(ordersUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!ordersRes.ok) {
    const errData = await ordersRes.json().catch(() => ({}));
    return NextResponse.json({
      erro: true,
      mensagem: `Erro ao buscar pedidos (${ordersRes.status}): ${(errData as any).message ?? ""}`,
    });
  }

  const ordersData = await ordersRes.json();
  const orders: any[] = ordersData.results ?? [];

  if (orders.length === 0) {
    return NextResponse.json({ hoje, totalPedidos: 0, itens: [], faturamentoTotal: 0, lucroTotal: 0 });
  }

  // 4. Busca anúncios cadastrados no Supabase
  let anunciosQuery = supabase()
    .from("anuncios")
    .select("id, ml_item_id, nome, preco_ideal, custo_produto, insumos, custo_frete, frete_gratis, imposto, margem_desejada")
    .eq("ativo", true)
    .not("ml_item_id", "is", null);
  // Filtro de dono INCONDICIONAL: `userId` vem da sessão (acima).
  anunciosQuery = anunciosQuery.eq("user_id", userId);
  const { data: anuncios } = await anunciosQuery;

  const mapa = new Map<string, any>();
  for (const a of (anuncios ?? [])) {
    if (a.ml_item_id) mapa.set(a.ml_item_id, a);
  }

  // 5. Processa cada pedido
  type ItemVenda = {
    anuncioId: string;
    mlItemId: string;
    nome: string;
    unidades: number;
    precoUnitario: number;
    faturamento: number;
    lucro: number;
    cadastrado: boolean;
  };

  const itensPorAnuncio = new Map<string, ItemVenda>();

  for (const order of orders) {
    for (const orderItem of (order.order_items ?? [])) {
      const mlItemId: string = orderItem.item?.id ?? "";
      const unidades: number = orderItem.quantity ?? 1;
      const precoUnitario: number = orderItem.unit_price ?? 0;
      const faturamento = precoUnitario * unidades;

      const anuncio = mapa.get(mlItemId);

      const chave = mlItemId;
      const existing = itensPorAnuncio.get(chave);

      if (existing) {
        existing.unidades   += unidades;
        existing.faturamento += faturamento;
        if (anuncio) existing.lucro += faturamento * (anuncio.margem_desejada / 100);
      } else {
        const lucro = anuncio
          ? faturamento * (anuncio.margem_desejada / 100)
          : 0;

        itensPorAnuncio.set(chave, {
          anuncioId:    anuncio?.id ?? "",
          mlItemId,
          nome:         anuncio?.nome ?? (orderItem.item?.title ?? mlItemId),
          unidades,
          precoUnitario,
          faturamento,
          lucro,
          cadastrado:   !!anuncio,
        });
      }
    }
  }

  const itens = Array.from(itensPorAnuncio.values());
  const faturamentoTotal = itens.reduce((s, i) => s + i.faturamento, 0);
  const lucroTotal       = itens.reduce((s, i) => s + i.lucro, 0);

  // 6. Salva/atualiza vendas_dia no Supabase para anúncios cadastrados
  for (const item of itens.filter(i => i.cadastrado && i.anuncioId)) {
    await supabase().from("vendas_dia").upsert({
      anuncio_id: item.anuncioId,
      data: hoje,
      unidades_vendidas: item.unidades,
      faturamento: item.faturamento,
      lucro: item.lucro,
    }, { onConflict: "anuncio_id,data" });
  }

  return NextResponse.json({
    hoje,
    sellerId,
    totalPedidos: orders.length,
    itens,
    faturamentoTotal,
    lucroTotal,
  });
}
