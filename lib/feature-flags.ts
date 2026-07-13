/**
 * Feature flags do projeto.
 *
 * ENABLE_ASYNC_SYNC_JOBS (aprovado 2026-07-13, ver docs/DECISIONS.md):
 * liga/desliga a arquitetura nova de sincronização (sync_jobs + worker +
 * polling, ver docs/ROADMAP.md "Redesenho do botão Sincronizar"). Motivo de
 * existir: manter todo o código da fila de jobs versionado no GitHub (não
 * perder o trabalho só porque ainda não está pronto pra produção), sem
 * arriscar ativá-lo em produção antes de existir um PROCESSADOR PERMANENTE
 * de jobs — hoje scripts/sync-worker.mjs é um processo manual local, que só
 * roda enquanto alguém deixa um terminal aberto. Não existe nada no Vercel
 * (serverless, sem processo de longa duração) que chame
 * claim_next_sync_job(). Ligar esta flag em produção sem um worker rodando
 * em algum lugar cria jobs em sync_jobs que ficam presos em "pendente" para
 * sempre — não quebra nada, mas também não sincroniza nada.
 *
 * DEFAULT: false (string "true" é o único valor que ativa). Ficará false
 * até a migração da sincronização virar sua própria etapa de roadmap, com
 * infraestrutura de processamento, monitoramento e plano de rollback
 * definidos (decisão explícita do usuário, 2026-07-13 — não é esquecimento).
 *
 * Precisa ser NEXT_PUBLIC_ porque app/(app)/vendas/page.tsx (client
 * component) usa este valor para decidir, no clique do botão "Sincronizar",
 * entre o fluxo antigo (sync inline via ?sync=1) e o fluxo novo (criar job
 * + polling) — essa decisão acontece no browser, não só no servidor. Não é
 * um segredo (é só um booleano de comportamento), então expor no bundle do
 * cliente não é um risco de segurança.
 */
export const ASYNC_SYNC_JOBS_ENABLED =
  process.env.NEXT_PUBLIC_ENABLE_ASYNC_SYNC_JOBS === "true";
