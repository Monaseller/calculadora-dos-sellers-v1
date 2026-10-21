/**
 * GET /api/vendas/shopee/pedidos — Etapa 3 / V1: lista canonica de pedidos Shopee, 50 por pagina, so leitura
 * (lib/vendas/listagem/shopee-pedidos.ts). O dono e SEMPRE a sessao; `loja_ids` so restringe dentro das lojas
 * Shopee desse dono. Nunca le o cookie da loja ativa, nunca sincroniza, nunca grava, nunca chama a Shopee.
 *
 *   ?de=AAAA-MM-DD&ate=AAAA-MM-DD[&loja_ids=uuid,uuid][&cursor=…&direcao=proximo|anterior]
 */
import { NextResponse } from "next/server";
import { autenticarRequisicao } from "@/lib/autenticacao";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";
import { ErroListaVendasShopee, listarPedidosShopee } from "@/lib/vendas/listagem/shopee-pedidos";

export const dynamic = "force-dynamic";

const SEM_CACHE = { "Cache-Control": "no-store" };

const STATUS: Record<ErroListaVendasShopee["codigo"], number> = {
  PARAMETRO_INVALIDO: 400, CURSOR_INVALIDO: 400, LOJA_FORA_DO_OWNER: 404, LEITURA_FALHOU: 503,
};

export async function GET(request: Request) {
  const auth = await autenticarRequisicao(request);
  const userId = auth.autenticado ? auth.uid : null;
  if (!userId) return NextResponse.json({ erro: "NAO_AUTENTICADO" }, { status: 401, headers: SEM_CACHE });

  const q = new URL(request.url).searchParams;
  const lojas = q.get("loja_ids");
  const direcao = q.get("direcao");
  if (direcao !== null && direcao !== "proximo" && direcao !== "anterior") {
    return NextResponse.json({ erro: "PARAMETRO_INVALIDO" }, { status: 400, headers: SEM_CACHE });
  }
  try {
    const pagina = await listarPedidosShopee({
      userId, de: q.get("de") ?? "", ate: q.get("ate") ?? "",
      lojaIds: lojas === null ? null : lojas.split(",").map((x) => x.trim()),
      cursor: q.get("cursor"), direcao,
    }, { cliente: getSupabaseServidor() });
    return NextResponse.json(pagina, { headers: SEM_CACHE });
  } catch (e) {
    if (e instanceof ErroListaVendasShopee) {
      // 5xx: so o codigo e a etapa — nunca filtro, dono, loja, pedido ou valor
      if (e.codigo === "LEITURA_FALHOU") console.error(`[GET /api/vendas/shopee/pedidos] LEITURA_FALHOU ${e.detalhe ?? ""}`.trim());
      return NextResponse.json({ erro: e.codigo }, { status: STATUS[e.codigo], headers: SEM_CACHE });
    }
    console.error("[GET /api/vendas/shopee/pedidos] falha:", e instanceof Error ? e.message : String(e));
    return NextResponse.json({ erro: "LEITURA_FALHOU" }, { status: 503, headers: SEM_CACHE });
  }
}
