/**
 * Flag SERVER-ONLY da automacao canonica de vendas (SALES-SYNC-D6).
 *
 * Liga SO as duas rotas internas canonicas:
 *   GET /api/internal/vendas-sync/coordenador  (planeja/cria)
 *   GET /api/internal/vendas-sync/worker       (executa)
 *
 * Por que NAO e `NEXT_PUBLIC_ENABLE_ASYNC_SYNC_JOBS` (lib/feature-flags.ts):
 * aquela flag tambem troca o botao Sincronizar da tela Vendas para o fluxo
 * legado de jobs (/api/sync/iniciar → job com campo_tempo/checkpoint NULL,
 * que nenhum worker de producao processa e que ocupa
 * idx_sync_jobs_loja_ativo, travando o canonico da loja); e, por ser
 * NEXT_PUBLIC_, e inlinada no build e visivel no browser. As duas flags sao
 * INDEPENDENTES: ligar esta nao muda a Vendas; ligar aquela nao liga esta.
 *
 * Leitura: a cada chamada (nenhuma constante de modulo). Isso NAO torna a
 * flag um botao instantaneo — na Vercel, mudar uma variavel so vale para
 * deployments que a recebem; parada rapida = Instant Rollback.
 *
 * Valor: SO a string exata "true" liga (mesma convencao de
 * lib/feature-flags.ts). Ausente, "", "false", "1", "TRUE", " true" → OFF.
 */
import "server-only";

export const VARIAVEL_SYNC_CANONICO_VENDAS = "ENABLE_CANONICAL_SALES_SYNC";

export function syncCanonicoVendasHabilitado(): boolean {
  return process.env.ENABLE_CANONICAL_SALES_SYNC === "true";
}
