/**
 * POST /api/internal/estudio-anuncios/executar
 *
 * Executa UM job já reivindicado do Pipeline. Rota INTERNA: a
 * autorização é exclusivamente o segredo compartilhado, nunca dado
 * enviado pelo chamador — nenhum `user_id` do corpo é aceito.
 *
 * AJUSTE (2026-09-04): toda a lógica de validação e execução saiu daqui
 * para `lib/estudio-anuncios/processar-job.ts`. O motivo é concreto: o
 * cron de produção precisava do mesmo comportamento, e reimplementá-lo
 * criaria duas versões das ~15 checagens de coerência entre job,
 * pipeline e catálogo — que divergiriam na primeira mudança. Esta rota
 * ficou sendo o que sempre deveria ter sido: autenticação, validação de
 * entrada e tradução do resultado em HTTP.
 *
 * O contrato com `scripts/estudio-anuncios-worker.mjs` **não mudou**:
 * mesmo método, mesmo header, mesmo corpo, mesmas respostas.
 *
 * FAIL CLOSED: sem `ESTUDIO_ANUNCIOS_WORKER_INTERNAL_SECRET` no
 * ambiente, a rota recusa tudo. Ausência de configuração nunca abre.
 */
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { UUID_REGEX } from "@/lib/estudio-anuncios/jobs";
import { processarJobDoPipeline } from "@/lib/estudio-anuncios/processar-job";

const supabaseServico = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

function respostaErro(status: number, erro: string) {
  // Nunca inclui stack trace nem detalhe interno além da mensagem já
  // controlada — todo texto que chega aqui já foi truncado/sanitizado.
  return NextResponse.json({ ok: false, erro }, { status });
}

export async function POST(request: Request) {
  const segredoEsperado = process.env.ESTUDIO_ANUNCIOS_WORKER_INTERNAL_SECRET;
  const segredoRecebido = request.headers.get("x-worker-secret");

  if (!segredoEsperado || !segredoRecebido || segredoRecebido !== segredoEsperado) {
    return respostaErro(401, "Não autorizado.");
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return respostaErro(400, "Body inválido.");
  }

  const jobId = body?.job_id;
  if (!jobId || typeof jobId !== "string") return respostaErro(400, "job_id é obrigatório.");
  if (!UUID_REGEX.test(jobId)) return respostaErro(400, "job_id não é um UUID válido.");

  try {
    const { status, corpo } = await processarJobDoPipeline(supabaseServico, jobId);
    return NextResponse.json(corpo, { status });
  } catch (err: any) {
    // Última rede de segurança — nunca deixa exceção crua chegar na
    // resposta. Não tenta marcar job/pipeline aqui: se algo chegou até
    // este catch, não há garantia de qual etapa falhou, então não
    // arrisca um estado parcial extra.
    const mensagem = (err?.message ?? "Erro desconhecido").toString().slice(0, 300);
    console.error("[internal/estudio-anuncios/executar] falhou:", mensagem);
    return respostaErro(500, mensagem);
  }
}
