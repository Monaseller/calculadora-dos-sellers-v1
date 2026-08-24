/**
 * GET /api/sync
 * Cron horário do Vercel — sincroniza últimos 7 dias de todos os usuários ativos.
 * Também pode ser chamado manualmente com ?userId=xxx para um usuário específico.
 */
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { syncShopeeForUserV2 } from "@/lib/sync-shopee";
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
  // ── Autenticação do cron — FAIL CLOSED (2026-09-01) ────────────────
  //
  // A versão anterior era `if (process.env.CRON_SECRET && auth !== ...)`.
  // O `&&` fazia a guarda inteira desaparecer quando a variável não
  // estava configurada: sem segredo, a condição era falsa e a rota ficava
  // ABERTA. E ela não é inofensiva — varre `lojas` de TODOS os usuários
  // ativos e dispara sync contra Shopee e Mercado Livre para cada um.
  //
  // Agora a ausência de configuração é o caso mais seguro, não o mais
  // permissivo: sem `CRON_SECRET`, ninguém entra — nem o cron. Isso é
  // deliberado. Uma sincronização que não roda é um incidente visível e
  // reversível; uma rota multi-tenant aberta, não.
  //
  // O formato é o OFICIAL do Vercel Cron: quando `CRON_SECRET` existe nas
  // variáveis do projeto, o agendador envia `Authorization: Bearer <ela>`
  // sozinho. Por isso não há header próprio, query param nem cookie aqui
  // — inventar um só criaria uma segunda porta para manter fechada.
  const segredo = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization");

  // Resposta genérica e idêntica nos três casos: quem chama não precisa
  // saber se o que faltou foi a configuração do servidor ou o header
  // dele.
  if (!segredo || !auth || auth !== `Bearer ${segredo}`) {
    return NextResponse.json({ erro: true }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const targetUserId = searchParams.get("userId"); // opcional: sync de um usuário específico

  const hoje  = brtDate(0);
  const ontem = brtDate(1);   // janela de 2 dias (ontem + hoje)
  // Com update_time no sync Shopee, 2 dias bastam: pedidos pagos ontem
  // ou hoje são capturados diretamente pelo update_time da confirmação de pagamento.

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
      // ── TIMEOUT1b — o cron passa a operar em modo INCREMENTAL ────────
      // Antes: `syncShopeeForUser(userId, ontem, hoje)`. Aquele wrapper é
      // um adaptador puro — duas linhas, `await` da V2 e `return
      // result.inserted`. Não resolve loja, não altera `noBuffer`, não
      // normaliza data, não trata erro. Os cinco primeiros argumentos
      // abaixo são os MESMOS que ele repassava (`noBuffer` chegava
      // `false` pelo default; aqui é explícito), então a única mudança
      // de comportamento é o 6º argumento.
      //
      // Por que chamar a V2 direto em vez de dar `opcoes` ao wrapper: o
      // wrapper é COMPARTILHADO com o botão manual (`/api/sync/manual`),
      // que precisa continuar em modo intervalo. Mexer nele ativaria os
      // dois de uma vez.
      //
      // `undefined` em `lojaOverride` é deliberado e igual ao de antes:
      // o cron não escolhe loja, quem resolve é `getShopeeLojaAtiva`.
      marketplaces.has("Shopee")
        ? syncShopeeForUserV2(userId, ontem, hoje, false, undefined, { modo: "incremental" })
            .then(r  => { results[userId].shopee = r.inserted; })
            .catch(e => { results[userId].shopee_err = String(e?.message ?? e); })
        : Promise.resolve(),

      marketplaces.has("ML")
        ? syncMLForUser(userId, ontem, hoje)
            .then(n  => { results[userId].ml = n; })
            .catch(e => { results[userId].ml_err = String(e?.message ?? e); })
        : Promise.resolve(),
    ]);
  }

  return NextResponse.json({ ok: true, from: ontem, to: hoje, synced: results });
}
