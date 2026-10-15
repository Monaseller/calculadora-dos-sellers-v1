/**
 * /api/ml/vendas/metricas — Vendas A3.4 (Parte A): Vendas / Unidades / Vendas brutas do Mercado Livre na tela de
 * Vendas, SÓ do serviço canônico (lib/vendas/ml-metricas-hibridas.ts). Nunca lê o legado `pedidos`.
 *
 *   GET  ?loja_id=uuid&de=AAAA-MM-DD&ate=AAAA-MM-DD   estado COMPLETE | PARTIAL | FAILED (+ estadoEm, fonte); fora de
 *        COMPLETE_FRESH pede revalidação ao coordenador existente (no máximo um sync_job por loja).
 *   POST mesmo corpo em JSON — atualização EXPLÍCITA (o usuário pediu): revalida mesmo se já fresco.
 */
import { NextResponse } from "next/server";
import { autenticarRequisicao } from "@/lib/autenticacao";
import { ErroVendasCanonicas } from "@/lib/vendas/canonico/service";
import { statusDoErroResumo } from "@/lib/vendas/canonico/dashboard-resumo";
import { lojaMLDaRequisicao } from "@/lib/vendas/ml-loja-requisicao";
import { metricasHibridasML } from "@/lib/vendas/ml-metricas-hibridas";

const DIA = /^\d{4}-\d{2}-\d{2}$/;

async function responder(request: Request, p: { loja_id: string | null; de: string; ate: string }, revalidar: boolean) {
  const auth = await autenticarRequisicao(request);
  const userId = auth.autenticado ? auth.uid : null;
  if (!userId) return NextResponse.json({ erro: "Não autenticado." }, { status: 401 });
  if (!DIA.test(p.de) || !DIA.test(p.ate) || p.de > p.ate) return NextResponse.json({ erro: "Parâmetros inválidos." }, { status: 400 });

  const loja = await lojaMLDaRequisicao(userId, p.loja_id);
  if (!loja.ok) return NextResponse.json(loja.corpo, { status: loja.status });
  try {
    return NextResponse.json({ lojaId: loja.lojaId, ...(await metricasHibridasML({ userId, lojaId: loja.lojaId, de: p.de, ate: p.ate, revalidar })) });
  } catch (e) {
    if (e instanceof ErroVendasCanonicas) return NextResponse.json({ erro: e.codigo }, { status: statusDoErroResumo(e) });
    console.error("[ml/vendas/metricas] falha:", e instanceof Error ? e.message : String(e));
    return NextResponse.json({ erro: "Não foi possível carregar as métricas do Mercado Livre." }, { status: 500 });
  }
}

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  return responder(request, { loja_id: q.get("loja_id"), de: q.get("de") ?? "", ate: q.get("ate") ?? "" }, false);
}

export async function POST(request: Request) {
  const corpo = await request.json().catch(() => null) as Record<string, unknown> | null;
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  return responder(request, { loja_id: s(corpo?.loja_id) || null, de: s(corpo?.de), ate: s(corpo?.ate) }, true);
}
