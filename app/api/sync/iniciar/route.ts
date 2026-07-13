/**
 * POST /api/sync/iniciar
 *
 * Cria um job de sincronização INCREMENTAL (ontem..hoje) para uma loja
 * específica. Chamado pelo botão "Sincronizar" da tela Vendas.
 *
 * Regras aprovadas em 2026-07-11 (docs/DECISIONS.md):
 *   - Body aceita SOMENTE { loja_id }. date_from/date_to NÃO vêm do
 *     cliente — o servidor sempre calcula ontem..hoje (America/Sao_Paulo).
 *     Um período maior (backfill/histórico) é outro tipo de job, não
 *     criado por esta rota.
 *   - marketplace vem de lojas.marketplace no banco, nunca do cliente.
 *   - loja_id deve pertencer ao usuário da sessão — senão 400, nenhum
 *     job é criado.
 *   - Não usa fire-and-forget: esta rota só grava uma linha em
 *     sync_jobs e responde. Quem executa o sync de fato é
 *     scripts/sync-worker.mjs, um processo separado.
 *   - Duas chamadas para a mesma loja com um job já ativo (pendente ou
 *     rodando) não criam um segundo job — o índice único parcial em
 *     sync_jobs rejeita o INSERT (23505) e esta rota retorna o job já
 *     em andamento.
 */
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getUserId } from "@/lib/session";
import { ASYNC_SYNC_JOBS_ENABLED } from "@/lib/feature-flags";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// "Ontem" e "hoje" em America/Sao_Paulo (mesmo padrão -3h já usado em todo
// o projeto — ver sync-shopee.ts/sync-ml.ts/api de vendas).
function hojeBrt(): string {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().split("T")[0];
}
function ontemBrt(): string {
  const d = new Date(Date.now() - 3 * 60 * 60 * 1000);
  d.setDate(d.getDate() - 1);
  return d.toISOString().split("T")[0];
}

export async function POST(request: Request) {
  // Feature flag (aprovado 2026-07-13, ver docs/DECISIONS.md): com a flag
  // desligada, esta rota NUNCA cria job — nenhum código chama este
  // endpoint quando ENABLE_ASYNC_SYNC_JOBS=false (o front usa o fluxo
  // antigo, ?sync=1 direto nas rotas de leitura), mas o check aqui é
  // defesa em profundidade: garante "não criar jobs" mesmo que a rota
  // seja chamada diretamente por engano.
  if (!ASYNC_SYNC_JOBS_ENABLED) {
    return NextResponse.json({ ok: false, disabled: true, erro: "Sincronização assíncrona desativada (ENABLE_ASYNC_SYNC_JOBS=false)." });
  }

  const userId = getUserId(request);
  if (!userId) {
    return NextResponse.json({ ok: false, erro: "Sessão inválida." }, { status: 401 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, erro: "Body inválido." }, { status: 400 });
  }

  const lojaId = body?.loja_id;
  if (!lojaId || typeof lojaId !== "string") {
    return NextResponse.json({ ok: false, erro: "loja_id é obrigatório." }, { status: 400 });
  }

  // Ownership: loja precisa existir E pertencer ao usuário da sessão.
  // Nunca confiar em loja_id do cliente sem checar isso — regra aprovada
  // 2026-07-11 ("validar que loja_id pertence ao usuário").
  const { data: loja, error: lojaErr } = await supabase
    .from("lojas")
    .select("id, user_id, marketplace, ativo")
    .eq("id", lojaId)
    .maybeSingle();

  if (lojaErr) {
    return NextResponse.json({ ok: false, erro: "Erro ao validar loja: " + lojaErr.message }, { status: 500 });
  }
  if (!loja || String(loja.user_id) !== String(userId)) {
    return NextResponse.json({ ok: false, erro: "Loja não encontrada ou não pertence ao usuário." }, { status: 400 });
  }
  if (loja.marketplace !== "ML" && loja.marketplace !== "Shopee") {
    return NextResponse.json({ ok: false, erro: "Loja com marketplace desconhecido." }, { status: 400 });
  }

  const dateFrom = ontemBrt();
  const dateTo   = hojeBrt();

  const { data: job, error: insertErr } = await supabase
    .from("sync_jobs")
    .insert({
      user_id:     userId,
      loja_id:     lojaId,
      marketplace: loja.marketplace,
      tipo:        "incremental",
      date_from:   dateFrom,
      date_to:     dateTo,
    })
    .select("id")
    .single();

  if (insertErr) {
    // 23505 = violação do índice único parcial (já existe job
    // pendente/rodando para esta loja) — não é erro, é o caminho
    // esperado de "já está sincronizando".
    if (insertErr.code === "23505") {
      const { data: existente } = await supabase
        .from("sync_jobs")
        .select("id")
        .eq("loja_id", lojaId)
        .in("status", ["pendente", "rodando"])
        .order("criado_em", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (existente) {
        return NextResponse.json({ ok: true, status: "em_andamento", job_id: existente.id });
      }
      // Corrida rara: o job que causou o conflito já terminou entre o
      // INSERT falhar e este SELECT rodar. Trata como sucesso "tente de
      // novo" sem gerar erro para o usuário.
      return NextResponse.json({ ok: false, erro: "Conflito momentâneo, tente novamente." }, { status: 409 });
    }
    return NextResponse.json({ ok: false, erro: "Erro ao criar job: " + insertErr.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, status: "iniciado", job_id: job.id });
}
