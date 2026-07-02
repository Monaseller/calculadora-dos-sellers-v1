/**
 * GET /api/sync
 * Cron horário do Vercel — sincroniza últimos 7 dias de todos os usuários ativos.
 * Também pode ser chamado manualmente com ?userId=xxx para um usuário específico.
 */
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { syncShopeeForUser } from "@/lib/sync-shopee";
import { syncMLForUser } from "@/lib/sync-ml";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

function brtDate(offsetDays = 0): string {
  const d = new Date(Date.now() - 3 * 60 * 60 * 1000);
  d.setDate(d.getDate() - offsetDays);
  return d.toISOString().split("T")[0];
}

export const maxDuration = 300; // Vercel Pro: até 5 min

export async function GET(request: Request) {
  // Verifica secret do cron (Vercel injeta automaticamente)
  const auth = request.headers.get("authorization");
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ erro: true }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const targetUserId = searchParams.get("userId"); // opcional: sync de um usuário específico

  const hoje  = brtDate(0);
  const from7 = brtDate(7);   // janela de 7 dias

  // Busca todos os usuários com loja ativa
  const { data: lojas } = await supabase
    .from("lojas")
    .select("user_id, marketplace")
    .eq("ativo", true)
    .not("user_id", "is", null);

  if (!lojas?.length) {
    return NextResponse.json({ ok: true, mensagem: "Nenhum usuário ativo" });
  }

  // Agrupa marketplaces por userId
  const userMap = new Map<string, Set<string>>();
  for (const l of lojas) {
    if (!l.user_id) continue;
    if (targetUserId && l.user_id !== targetUserId) continue;
    if (!userMap.has(l.user_id)) userMap.set(l.user_id, new Set());
    userMap.get(l.user_id)!.add(l.marketplace);
  }

  const results: Record<string, any> = {};

  for (const [userId, marketplaces] of userMap) {
    results[userId] = {};

    // Shopee e ML em paralelo por usuário
    await Promise.all([
      marketplaces.has("Shopee")
        ? syncShopeeForUser(userId, from7, hoje)
            .then(n  => { results[userId].shopee = n; })
            .catch(e => { results[userId].shopee_err = String(e?.message ?? e); })
        : Promise.resolve(),

      marketplaces.has("ML")
        ? syncMLForUser(userId, from7, hoje)
            .then(n  => { results[userId].ml = n; })
            .catch(e => { results[userId].ml_err = String(e?.message ?? e); })
        : Promise.resolve(),
    ]);
  }

  return NextResponse.json({ ok: true, from: from7, to: hoje, synced: results });
}
