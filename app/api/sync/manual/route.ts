/**
 * POST /api/sync/manual
 * Sync manual autenticado por sessão (histórico mês a mês).
 * Body: { dateFrom: "YYYY-MM-DD", dateTo: "YYYY-MM-DD", marketplace?: "ML" | "Shopee" | "todos" }
 */
import { NextResponse } from "next/server";
import { autenticarRequisicao, lerCookie } from "@/lib/autenticacao";
import { getShopeeLojaById } from "@/lib/shopee-auth";
import { NOME_COOKIE_LOJA_SHOPEE, selecionarLojaShopee } from "@/lib/shopee-loja-selecao";
import { getMLLojaAtiva } from "@/lib/ml-auth";
import { syncShopeeForUser } from "@/lib/sync-shopee";
import { syncMLForUser } from "@/lib/sync-ml";

export const maxDuration = 60; // Vercel Pro: 60s por chamada (1 mês por request)

export async function POST(request: Request) {
  const auth = await autenticarRequisicao(request);
  const userId = auth.autenticado ? auth.uid : null;
  if (!userId) {
    return NextResponse.json({ erro: true, mensagem: "Sessão inválida." }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const { dateFrom, dateTo, marketplace = "todos", noBuffer = false } = body as {
    dateFrom?: string; dateTo?: string; marketplace?: "ML" | "Shopee" | "todos"; noBuffer?: boolean;
  };

  if (!dateFrom || !dateTo) {
    return NextResponse.json({ erro: true, mensagem: "dateFrom e dateTo são obrigatórios." }, { status: 400 });
  }

  const results: { ml?: number; shopee?: number; mlErro?: string; shopeeErro?: string } = {};

  // MULTI-LOJA V1: Shopee so na loja EXPLICITA (body.loja_id) ou no "Usar esta" re-conferido,
  // ou na UNICA ativa — nunca "a mais recente". Ambiguidade vira STORE_SELECTION_REQUIRED.
  const lojaShopee = async () => {
    const sel = await selecionarLojaShopee(userId, {
      lojaIdExplicito: (body as { loja_id?: string }).loja_id ?? null, lojaIdCookie: lerCookie(request, NOME_COOKIE_LOJA_SHOPEE), usarCookie: true,
    });
    if (!sel.ok) { if (sel.motivo !== "SEM_LOJA_SHOPEE") results.shopeeErro = sel.motivo; return null; }
    return getShopeeLojaById(sel.lojaId, userId);
  };

  try {
    await Promise.all([
      // ── Mercado Livre ────────────────────────────────────────────────────────
      (marketplace === "todos" || marketplace === "ML")
        ? getMLLojaAtiva(userId)
            .then(loja => loja
              ? syncMLForUser(userId, dateFrom, dateTo, undefined, noBuffer)
                  .then(n => { results.ml = n; })
                  .catch(e => { results.mlErro = String(e?.message ?? e); })
              : void (results.mlErro = "ML não conectada")
            )
            .catch(e => { results.mlErro = String(e?.message ?? e); })
        : Promise.resolve(),

      // ── Shopee ───────────────────────────────────────────────────────────────
      (marketplace === "todos" || marketplace === "Shopee")
        ? lojaShopee()
            .then(loja => {
              if (!loja) { results.shopeeErro = results.shopeeErro ?? "Shopee não conectada"; return; }
              // Timeout global 55s: máximo seguro no Vercel Hobby (maxDuration=60).
              // Passa loja direto p/ evitar 2ª chamada getShopeeLojaAtiva (~800ms).
              const limitTimer = new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error("Shopee sync timeout (55s)")), 55000)
              );
              return Promise.race([syncShopeeForUser(userId, dateFrom, dateTo, noBuffer, loja), limitTimer])
                .then(n => { results.shopee = n as number; })
                .catch(e => { results.shopeeErro = String(e?.message ?? e); });
            })
            .catch(e => { results.shopeeErro = String(e?.message ?? e); })
        : Promise.resolve(),
    ]);
  } catch (fatalErr: any) {
    // Nunca deve cair aqui, mas garante JSON mesmo em erro inesperado
    return NextResponse.json({
      ok: false,
      erro: true,
      mensagem: String(fatalErr?.message ?? fatalErr),
      dateFrom,
      dateTo,
    }, { status: 500 });
  }

  return NextResponse.json({ ok: true, dateFrom, dateTo, ml: results.ml, shopee: results.shopee, mlErro: results.mlErro, shopeeErro: results.shopeeErro });
}
