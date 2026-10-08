/**
 * GET /api/vendas/resumo-canonico — D16 (Dashboard first).
 *
 * Os 4 cards principais do Dashboard (Faturamento, Pedidos, Unidades, Ticket)
 * lidos da camada canonica (consultarVendasCanonicas). O dono e SEMPRE a
 * sessao; `loja_id` so restringe dentro das lojas desse dono.
 *
 *   ?marketplace=mercado_livre|shopee|todos  &de=AAAA-MM-DD  &ate=AAAA-MM-DD  [&loja_id=uuid]
 *
 * So leitura: nenhuma chamada a ML/Shopee, nenhum sync_job, nenhum worker.
 */
import { NextResponse } from "next/server";
import { autenticarRequisicao } from "@/lib/autenticacao";
import { ErroVendasCanonicas } from "@/lib/vendas/canonico/service";
import { consultarResumoVendasDashboard, lerFiltroResumoDashboard, statusDoErroResumo } from "@/lib/vendas/canonico/dashboard-resumo";

export async function GET(request: Request) {
  const auth = await autenticarRequisicao(request);
  const userId = auth.autenticado ? auth.uid : null;
  if (!userId) return NextResponse.json({ erro: "Não autenticado." }, { status: 401 });

  const filtro = lerFiltroResumoDashboard(new URL(request.url).searchParams);
  if (!filtro) return NextResponse.json({ erro: "Parâmetros inválidos." }, { status: 400 });

  try {
    return NextResponse.json(await consultarResumoVendasDashboard(userId, filtro));
  } catch (e) {
    if (e instanceof ErroVendasCanonicas) {
      return NextResponse.json({ erro: e.codigo }, { status: statusDoErroResumo(e) });
    }
    console.error("[GET /api/vendas/resumo-canonico] falha:", e instanceof Error ? e.message : String(e));
    return NextResponse.json({ erro: "Não foi possível carregar o resumo de vendas." }, { status: 500 });
  }
}
