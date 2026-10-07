/**
 * Auth das duas rotas internas canonicas de vendas (SALES-SYNC-D8.2).
 *
 *   GET /api/internal/vendas-sync/coordenador
 *   GET /api/internal/vendas-sync/worker
 *
 * Aceita, por igualdade EXATA do header `Authorization`:
 *   A. `Bearer <CRON_SECRET>` — o que a Vercel envia aos Cron Jobs (primeira
 *      classe; nada muda para os crons atuais nem para os futuros);
 *   B. `Bearer <CANONICAL_SALES_SYNC_MANUAL_SECRET>` — credencial SEPARADA,
 *      so destas duas rotas, para smoke/operacao manual controlada sem
 *      precisar ler/rotacionar o CRON_SECRET (que e "sensitive" na Vercel).
 *
 * Forma de uso (a guarda padrao das rotas internas — invariante 38 de
 * scripts/testar-middleware.ts):
 *
 *   const segredo = process.env.CRON_SECRET;
 *   const auth = request.headers.get("authorization");
 *   if (!segredo || !auth || auth !== cabecalhoEsperadoSalesSync(auth, segredo)) → 401
 *
 * Devolve o header ACEITO que a requisicao apresentou (A ou B); senao,
 * `Bearer <CRON_SECRET>` — que, por construcao, difere do recebido, e a
 * guarda recusa. Fail-closed: sem CRON_SECRET a guarda ja recusou antes;
 * o segredo manual so vale configurado e nao vazio. Nada de query string,
 * cookie ou comparacao parcial. Nenhum valor e logado ou devolvido. Lido a
 * cada chamada (sem constante de modulo).
 */
import "server-only";

export const VARIAVEL_SEGREDO_MANUAL_SYNC_CANONICO = "CANONICAL_SALES_SYNC_MANUAL_SECRET";

export function cabecalhoEsperadoSalesSync(recebido: string, cronSecret: string): string {
  const doCron = `Bearer ${cronSecret}`;
  if (recebido === doCron) return doCron;
  const manual = process.env.CANONICAL_SALES_SYNC_MANUAL_SECRET;
  if (manual && recebido === `Bearer ${manual}`) return `Bearer ${manual}`;
  return doCron;
}
