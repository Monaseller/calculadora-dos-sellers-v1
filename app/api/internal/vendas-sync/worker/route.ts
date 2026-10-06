/**
 * GET /api/internal/vendas-sync/worker — WORKER canonico de vendas (SALES-SYNC-B1).
 *
 * Separado do sync legado (/api/sync, /api/internal/sync/executar,
 * claim_next_sync_job, scripts/sync-worker.mjs — nenhum deles muda). Uma
 * chamada = no maximo UM job canonico e UMA fatia (lib/vendas/sync/worker.ts).
 *
 * Auth fail-closed, mesmo padrao dos alvos de Vercel Cron deste projeto:
 * `Authorization: Bearer <CRON_SECRET>`; sem a variavel no ambiente a rota
 * fica fechada (guarda identica a dos demais alvos de cron — e a forma que o
 * invariante 38 de scripts/testar-middleware.ts reconhece). O segredo nunca
 * e logado nem devolvido.
 *
 * NAO ha entrada em `crons` (vercel.json): agendar e outro gate. Com
 * ENABLE_ASYNC_SYNC_JOBS desligada (padrao), a rota responde DESABILITADO
 * sem ler nem escrever nada.
 */
import { NextResponse } from "next/server";
import { executarWorkerCanonico } from "@/lib/vendas/sync/worker";
import { criarDepsWorkerReais } from "@/lib/vendas/sync/worker-deps";

/** Teto padrao de app/api/** em vercel.json. Subir exige entrada propria la. */
export const maxDuration = 60;
/** Orcamento interno: 75% do teto — sobra para cold start e fechar a resposta. */
const ORCAMENTO_MS = 45_000;

function responder(corpo: unknown, status: number): NextResponse {
  return NextResponse.json(corpo, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: Request) {
  const segredo = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization");
  if (!segredo || !auth || auth !== `Bearer ${segredo}`) {
    return responder({ ok: false, erro: "nao_autorizado" }, 401);
  }
  try {
    const relatorio = await executarWorkerCanonico(criarDepsWorkerReais, { orcamentoMs: ORCAMENTO_MS });
    console.log(JSON.stringify({ evento: "vendas_sync_worker", ...relatorio }));
    return responder({ ok: relatorio.resultado !== "ERRO", ...relatorio }, 200);
  } catch {
    // Falha de infraestrutura (banco/ambiente): resposta generica, nada do erro vaza.
    console.error(JSON.stringify({ evento: "vendas_sync_worker", resultado: "FALHA_INFRA" }));
    return responder({ ok: false, erro: "falha_interna" }, 500);
  }
}
