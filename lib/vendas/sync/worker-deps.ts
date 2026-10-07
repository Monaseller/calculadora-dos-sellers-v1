/**
 * Portas REAIS do worker canonico (SALES-SYNC-B1). Separado de worker.ts
 * para que o fluxo (claim → fatia → transicao) seja testavel com dubles.
 *
 *   ML      transporte = varredura homologada por date_closed; repo ml_pedidos.
 *   Shopee  credencial pelo PAR (loja, dono) via resolverCredencialShopee em
 *           modo CANONICO (lease → CAS; lease ausente = fail-closed); contencao
 *           vira transitorio; repositorio do motor oficial Shopee.
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";
import { criarRepositorioML } from "@/lib/mercado-livre/ingestao/persistencia";
import { criarTransporteML } from "@/lib/mercado-livre/ingestao/transporte";
import { resolverCredencialShopee, type InjecaoAuthShopee } from "@/lib/shopee-auth";
import { criarRepositorioSupabase } from "@/lib/shopee/ingestao/persistencia";
import { criarTransporteShopee } from "@/lib/shopee/ingestao/transporte";
import type { DepsWorker, JobReivindicado } from "./worker";

export function criarDepsWorkerReais(): DepsWorker {
  const cliente = getSupabaseServidor();
  return {
    cliente,
    relogio: { agoraMs: () => Date.now() },
    portasML: async () => ({ transporte: criarTransporteML(), repo: criarRepositorioML(cliente) }),
    portasShopee: (job) => portasShopeeCanonicas(job, cliente),
  };
}

/**
 * Portas Shopee do worker CANONICO (SALES-SYNC-C6): contrato detalhado em modo
 * canonico — lease ausente/erro e fail-closed; contencao e infra voltam como
 * transitorio (job ADIADO, sem erro); so indisponibilidade REAL vira null
 * (erro de auth). `inj` existe so para a suite (padrao: banco e endpoint reais).
 */
export async function portasShopeeCanonicas(job: JobReivindicado, cliente: SupabaseClient, inj: InjecaoAuthShopee = {}) {
  const r = await resolverCredencialShopee(job.userId, job.lojaId, "canonico", { ...inj, cliente: inj.cliente ?? cliente });
  if (r.status === "REFRESH_EM_ANDAMENTO") return { transitorio: "refresh_em_andamento" as const, retryAfterMs: r.retryAfterMs };
  if (r.status === "LEASE_INDISPONIVEL") return { transitorio: "lease_indisponivel" as const, retryAfterMs: r.retryAfterMs };
  if (r.status !== "OK") return null;
  const c = r.credencial;
  return {
    api: criarTransporteShopee({ partnerId: c.partnerId, partnerKey: c.partnerKey, accessToken: c.accessToken, shopId: c.shopId }),
    repo: criarRepositorioSupabase(cliente),
  };
}
