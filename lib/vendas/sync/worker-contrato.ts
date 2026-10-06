/**
 * Contrato do WORKER canonico (SALES-SYNC-A1) — puro, sem I/O.
 *
 * O worker NAO decide regra de negocio: pega um job, identifica o tipo
 * aqui, chama o motor correto, persiste progresso/status (os motores ja
 * fazem isso no proprio sync_jobs) e sai. O que precisa existir e decidido
 * pelo coordenador.
 *
 *   ML_DATE_CLOSED         marketplace ML + campo_tempo date_closed
 *                          → lib/mercado-livre/ingestao executarFatiaML
 *   SHOPEE_CREATE_TIME     marketplace Shopee + campo_tempo create_time
 *                          → lib/shopee/ingestao executarFatiaShopee
 *   SHOPEE_ESCROW_CATCHUP  Shopee, sem campo/janela, checkpoint do motor
 *                          com modo escrow_catchup → executarFatiaCatchUpEscrow
 *   NAO_CANONICO           todo o resto (jobs do sync LEGADO, que tem
 *                          campo/janela/checkpoint NULL, e janelas de
 *                          update_time, que nunca provam cobertura):
 *                          o worker canonico NUNCA executa.
 *
 * Por que importa: `claim_next_sync_job()` (migration 20260711) pega
 * QUALQUER job pendente por ordem de criacao — legado e canonico — e hoje
 * so o worker LOCAL legado (scripts/sync-worker.mjs) a usa, mandando tudo
 * para o sync legado. O worker canonico precisa reivindicar SO os seus
 * (ver CLAIM_CANONICO abaixo) e nunca deixar o legado pegar um canonico.
 */

export type TipoTrabalhoCanonico = "ML_DATE_CLOSED" | "SHOPEE_CREATE_TIME" | "SHOPEE_ESCROW_CATCHUP" | "NAO_CANONICO";

export interface LinhaJobParaWorker {
  marketplace: string;
  campo_tempo: string | null;
  janela_inicio: string | null;
  janela_fim: string | null;
  checkpoint: unknown;
}

export function classificarJobParaWorker(j: LinhaJobParaWorker): TipoTrabalhoCanonico {
  if (j.marketplace === "ML" && j.campo_tempo === "date_closed" && j.janela_inicio && j.janela_fim) return "ML_DATE_CLOSED";
  if (j.marketplace === "Shopee" && j.campo_tempo === "create_time" && j.janela_inicio && j.janela_fim) return "SHOPEE_CREATE_TIME";
  const ck = j.checkpoint as { modo?: unknown } | null;
  if (j.marketplace === "Shopee" && j.campo_tempo === null && j.janela_inicio === null && ck && typeof ck === "object" && ck.modo === "escrow_catchup") return "SHOPEE_ESCROW_CATCHUP";
  return "NAO_CANONICO";
}

/**
 * Reivindicacao canonica SEM migration (para o gate do worker): selecionar
 * candidatos pendentes canonicos (filtro abaixo) e reivindicar com UPDATE
 * condicional por id `.eq("id", x).eq("status", "pendente")` → status
 * "rodando", heartbeat. 0 linhas atualizadas = outro worker ganhou.
 * O indice de 1 ativo por loja continua valendo.
 */
export const CLAIM_CANONICO = {
  filtroPendentes: "status = 'pendente' AND (campo_tempo IN ('date_closed','create_time') OR (campo_tempo IS NULL AND checkpoint->>'modo' = 'escrow_catchup'))",
} as const;
