/**
 * POST /api/sync/manual
 * Sync manual autenticado por sessão (histórico mês a mês).
 * Body: { dateFrom: "YYYY-MM-DD", dateTo: "YYYY-MM-DD", marketplace?: "ML" | "Shopee" | "todos" }
 */
import { NextResponse } from "next/server";
import { getUserId } from "@/lib/session";
import { getShopeeLojaAtiva } from "@/lib/shopee-auth";
import { getMLLojaAtiva } from "@/lib/ml-auth";
import { syncShopeeForUser } from "@/lib/sync-shopee";
import { syncMLForUser } from "@/lib/sync-ml";

export const maxDuration = 60; // Vercel Pro: 60s por chamada (1 mês por request)

export async function POST(request: Request) {
  const userId = getUserId(request);
  if (!userId) {
    return NextResponse.json({ erro: true, mensagem: "Sessão inválida." }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const { dateFrom, dateTo, marketplace = "todos" } = body as {
    dateFrom?: string; dateTo?: string; marketplace?: "ML" | "Shopee" | "todos";
  };

  if (!dateFrom || !dateTo) {
    return NextResponse.json({ erro: true, mensagem: "dateFrom e dateTo são obrigatórios." }, { status: 400 });
  }

  const results: { ml?: number; shopee?: number; mlErro?: string; shopeeErro?: string } = {};

  await Promise.all([
    // ── Mercado Livre ────────────────────────────────────────────────────────
    (marketplace === "todos" || marketplace === "ML")
      ? getMLLojaAtiva(userId)
          .then(loja => loja
            ? syncMLForUser(userId, dateFrom, dateTo)
                .then(n => { results.ml = n; })
                .catch(e => { results.mlErro = String(e?.message ?? e); })
            : void (results.mlErro = "ML não conectada")
          )
      : Promise.resolve(),

    // ── Shopee ───────────────────────────────────────────────────────────────
    (marketplace === "todos" || marketplace === "Shopee")
      ? getShopeeLojaAtiva(userId)
          .then(loja => loja
            ? syncShopeeForUser(userId, dateFrom, dateTo)
                .then(n => { results.shopee = n; })
                .catch(e => { results.shopeeErro = String(e?.message ?? e); })
            : void (results.shopeeErro = "Shopee não conectada")
          )
      : Promise.resolve(),
  ]);

  return NextResponse.json({ ok: true, dateFrom, dateTo, ...results });
}
