/**
 * GET /api/sync/status?job_id=...   (uso primário — polling ativo da tela)
 * GET /api/sync/status?loja_id=...  (uso secundário — exibição passiva,
 *                                     ex: "última sincronização"; retorna
 *                                     o job mais recente daquela loja)
 *
 * Regra aprovada 2026-07-11: o polling disparado pela tela SEMPRE usa
 * job_id (o retornado pelo POST /api/sync/iniciar que a própria tela
 * chamou), nunca loja_id — uma loja pode ter jobs concluídos/antigos, e
 * consultar só por loja_id poderia misturar a execução nova com uma
 * anterior.
 */
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { autenticarRequisicao } from "@/lib/autenticacao";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export async function GET(request: Request) {
  const auth = await autenticarRequisicao(request);
  const userId = auth.autenticado ? auth.uid : null;
  if (!userId) {
    return NextResponse.json({ ok: false, erro: "Sessão inválida." }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const jobId  = searchParams.get("job_id");
  const lojaId = searchParams.get("loja_id");

  if (!jobId && !lojaId) {
    return NextResponse.json({ ok: false, erro: "job_id ou loja_id é obrigatório." }, { status: 400 });
  }

  let query = supabase
    .from("sync_jobs")
    .select("id, user_id, loja_id, marketplace, tipo, status, tentativas, max_tentativas, erro_mensagem, criado_em, iniciado_em, concluido_em, heartbeat_em");

  if (jobId) {
    query = query.eq("id", jobId);
  } else {
    query = query.eq("loja_id", lojaId!).order("criado_em", { ascending: false }).limit(1);
  }

  const { data: job, error } = await query.maybeSingle();

  if (error) {
    return NextResponse.json({ ok: false, erro: "Erro ao consultar status: " + error.message }, { status: 500 });
  }
  if (!job) {
    // Nenhum job ainda para esta loja — não é erro, é "idle".
    return NextResponse.json({ ok: true, status: "idle" });
  }

  // Ownership: nunca devolver status de job de outro usuário, mesmo que
  // alguém adivinhe/manipule um job_id.
  if (String(job.user_id) !== String(userId)) {
    return NextResponse.json({ ok: false, erro: "Job não encontrado." }, { status: 404 });
  }

  return NextResponse.json({
    ok:           true,
    job_id:       job.id,
    loja_id:      job.loja_id,
    marketplace:  job.marketplace,
    tipo:         job.tipo,
    status:       job.status,
    tentativas:   job.tentativas,
    maxTentativas: job.max_tentativas,
    erroMensagem: job.erro_mensagem,
    criadoEm:     job.criado_em,
    iniciadoEm:   job.iniciado_em,
    concluidoEm:  job.concluido_em,
    heartbeatEm:  job.heartbeat_em,
  });
}
