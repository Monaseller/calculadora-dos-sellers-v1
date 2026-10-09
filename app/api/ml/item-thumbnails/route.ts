import { NextResponse } from "next/server";
import { autenticarRequisicao, lerCookie } from "@/lib/autenticacao";
import { resolverContaML } from "@/lib/ml-conexao";

// GET /api/ml/item-thumbnails?ids=MLB1,MLB2,...[&loja_id=<uuid>]
// Retorna { MLB1: "https://...", MLB2: "https://..." }
//
// CDS V2 Fase 1B: era a última rota ANÔNIMA que autorizava pelo cookie `ml_access_token`.
// Agora exige sessão; a loja vem de `?loja_id` ou do contexto `loja_ativa_id` (sempre
// revalidados por dono + marketplace ML no servidor), ou é a loja ML ÚNICA por opt-in
// explícito. Loja de outro dono, Shopee ou id inválido é recusada ANTES do provider.
export async function GET(request: Request) {
  const auth = await autenticarRequisicao(request);
  if (!auth.autenticado) return NextResponse.json({}, { status: 401 });

  const { searchParams } = new URL(request.url);
  const lojaIndicada = searchParams.get("loja_id") || lerCookie(request, "loja_ativa_id");
  const conta = await resolverContaML(auth.uid, lojaIndicada, { permitirUnica: true });
  if (!conta.ok) return NextResponse.json({}, { status: conta.motivo === "LOJA_NAO_DEFINIDA" ? 409 : 403 });
  const token = conta.accessToken;

  const ids = (searchParams.get("ids") ?? "").split(",").map(s => s.trim()).filter(Boolean);
  if (!ids.length) return NextResponse.json({});

  // ML aceita até 20 IDs por chamada
  const CHUNK = 20;
  const result: Record<string, string> = {};

  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    try {
      const res = await fetch(
        `https://api.mercadolibre.com/items?ids=${chunk.join(",")}&attributes=id,thumbnail`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!res.ok) continue;
      const data: Array<{ code: number; body: { id: string; thumbnail?: string } }> = await res.json();
      for (const item of data) {
        if (item.code === 200 && item.body?.thumbnail) {
          result[item.body.id] = item.body.thumbnail.replace("http://", "https://");
        }
      }
    } catch {
      // ignora erros parciais
    }
  }

  return NextResponse.json(result);
}
