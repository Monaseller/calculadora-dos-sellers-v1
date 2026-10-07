/**
 * GET /api/internal/vendas-sync/coordenador — TICK do coordenador canonico de vendas (SALES-SYNC-D1).
 *
 * Planeja/cria; quem executa e o worker (/api/internal/vendas-sync/worker).
 * Uma chamada avalia todas as lojas ativas ML/Shopee e garante no maximo UM
 * job novo por loja (lib/vendas/sync/coordenador-tick.ts). Nao chama
 * marketplace, nao resolve credencial, nao executa motor.
 *
 * Separado do sync legado (/api/sync, /api/internal/sync/executar — nenhum
 * muda). Auth fail-closed, mesmo padrao do worker e dos alvos de Vercel Cron:
 * `Authorization: Bearer <CRON_SECRET>`; sem a variavel a rota fica fechada.
 * O segredo nunca e logado nem devolvido.
 *
 * NAO ha entrada em `crons` (vercel.json): agendar e outro gate.
 *
 * Auth (SALES-SYNC-D8.2): `Bearer CRON_SECRET` (Vercel Cron) OU `Bearer
 * CANONICAL_SALES_SYNC_MANUAL_SECRET` (operacao manual) — helper unico
 * lib/vendas/sync/auth-interna.ts; CRON_SECRET ausente = fechado.
 *
 * Flag (SALES-SYNC-D6): SO a server-only ENABLE_CANONICAL_SALES_SYNC
 * (lib/vendas/sync/flag-canonica.ts), lida a cada chamada DEPOIS da auth.
 * Desligada (padrao), responde DESABILITADO sem criar cliente, sem ler nem
 * escrever nada. A NEXT_PUBLIC_ENABLE_ASYNC_SYNC_JOBS (tela Vendas) nao
 * liga esta rota.
 */
import { NextResponse } from "next/server";
import { criarDepsTickReais, executarTickCoordenador } from "@/lib/vendas/sync/coordenador-tick";
import { cabecalhoEsperadoSalesSync } from "@/lib/vendas/sync/auth-interna";
import { syncCanonicoVendasHabilitado } from "@/lib/vendas/sync/flag-canonica";

/** Teto padrao de app/api/** em vercel.json. */
export const maxDuration = 60;
/** Orcamento interno: 75% do teto. So leituras de banco + no maximo um insert por loja. */
const ORCAMENTO_MS = 45_000;

function responder(corpo: unknown, status: number): NextResponse {
  return NextResponse.json(corpo, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: Request) {
  const segredo = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization");
  if (!segredo || !auth || auth !== cabecalhoEsperadoSalesSync(auth, segredo)) {
    return responder({ ok: false, erro: "nao_autorizado" }, 401);
  }
  try {
    const relatorio = await executarTickCoordenador(criarDepsTickReais, { orcamentoMs: ORCAMENTO_MS, habilitado: syncCanonicoVendasHabilitado() });
    return responder({ ok: relatorio.resultado !== "ERRO", ...relatorio }, 200);
  } catch {
    // Falha de infraestrutura (listar lojas/ambiente): resposta generica, nada do erro vaza.
    console.error(JSON.stringify({ evento: "COORDINATOR_TICK_DONE", resultado: "FALHA_INFRA" }));
    return responder({ ok: false, erro: "falha_interna" }, 500);
  }
}
