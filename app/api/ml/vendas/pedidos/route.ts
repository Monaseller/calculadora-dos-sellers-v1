/**
 * GET /api/ml/vendas/pedidos — Vendas A3.4 (Parte B): a tabela de vendas do Mercado Livre lida do PROVIDER, paginada
 * no servidor (lib/vendas/ml-tabela-provider.ts), com o financeiro LIVE (A3.4-C) só das linhas desta página. Só GET
 * no provider; nada é gravado. Prazo do provider contado do início da requisição (Vercel 60 s).
 *
 *   ?loja_id=uuid&de=AAAA-MM-DD&ate=AAAA-MM-DD&visao=fechamento|pago[&cursor=AAAA-MM-DD:offset]
 */
import { NextResponse } from "next/server";
import { autenticarRequisicao } from "@/lib/autenticacao";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";
import { lojaMLDaRequisicao } from "@/lib/vendas/ml-loja-requisicao";
import { cursorTabelaMLParaTexto, lerCursorTabelaML, lerPaginaTabelaML, type VisaoTabelaML } from "@/lib/vendas/ml-tabela-provider";

const DIA = /^\d{4}-\d{2}-\d{2}$/;
/** Teto padrão de app/api/** (vercel.json); o provider só começa chamadas até JANELA_PROVIDER_MS (40 s). */
export const maxDuration = 60;

export async function GET(request: Request) {
  const inicioMs = Date.now();
  const auth = await autenticarRequisicao(request);
  const userId = auth.autenticado ? auth.uid : null;
  if (!userId) return NextResponse.json({ erro: "Não autenticado." }, { status: 401 });

  const q = new URL(request.url).searchParams;
  const de = q.get("de") ?? "", ate = q.get("ate") ?? "";
  const visao: VisaoTabelaML | null = q.get("visao") === "pago" ? "pago" : (q.get("visao") ?? "fechamento") === "fechamento" ? "fechamento" : null;
  const cursor = lerCursorTabelaML(q.get("cursor"));
  if (!DIA.test(de) || !DIA.test(ate) || de > ate || !visao || cursor === "INVALIDO") {
    return NextResponse.json({ erro: "Parâmetros inválidos." }, { status: 400 });
  }

  const loja = await lojaMLDaRequisicao(userId, q.get("loja_id"));
  if (!loja.ok) return NextResponse.json(loja.corpo, { status: loja.status });
  if (!loja.credencialUtilizavel) return NextResponse.json({ erro: "credencial_ausente", lojaId: loja.lojaId }, { status: 409 });

  const pagina = await lerPaginaTabelaML({ userId, lojaId: loja.lojaId, de, ate, visao, cursor }, { cliente: getSupabaseServidor(), inicioMs });
  if (pagina.erro === "periodo_invalido" || pagina.erro === "cursor_invalido") return NextResponse.json({ erro: "Parâmetros inválidos." }, { status: 400 });
  return NextResponse.json({ lojaId: loja.lojaId, ...pagina, proximoCursor: cursorTabelaMLParaTexto(pagina.proximoCursor) },
    { status: pagina.erro !== null && pagina.linhas.length === 0 ? 502 : 200 });
}
