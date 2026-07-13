/**
 * Erro de integridade de loja_id — usado por sync-shopee.ts e sync-ml.ts
 * quando loja_id não pôde ser resolvido com segurança (ver docs/DECISIONS.md,
 * regra aprovada 2026-07-11: "ausência de loja_id é erro de integridade,
 * não um fallback aceitável").
 *
 * Extraído para módulo próprio em 2026-07-11 (redesenho do sync_jobs):
 * antes vivia como classe local dentro de syncMLForUserV2, inacessível
 * fora daquela função. app/api/internal/sync/executar/route.ts precisa
 * de `instanceof` para classificar o erro como PERMANENTE (não gera
 * retry) vs. um erro transitório qualquer (rede/timeout, que deve
 * incrementar tentativas em sync_jobs) — ver scripts/sync-worker.mjs.
 */
export class LojaIdIntegrityError extends Error {}
