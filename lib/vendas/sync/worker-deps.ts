/**
 * Portas REAIS do worker canonico (SALES-SYNC-B1). Separado de worker.ts
 * para que o fluxo (claim → fatia → transicao) seja testavel com dubles.
 *
 *   ML      transporte = varredura homologada por date_closed; repo ml_pedidos.
 *   Shopee  credencial pelo PAR (loja, dono) via getShopeeLojaById — o mesmo
 *           caminho do app (pode renovar o access token da loja, como o sync
 *           legado ja faz); repositorio do motor oficial Shopee.
 */
import "server-only";
import { getSupabaseServidor } from "@/lib/estudio-anuncios/supabase-servidor";
import { criarRepositorioML } from "@/lib/mercado-livre/ingestao/persistencia";
import { criarTransporteML } from "@/lib/mercado-livre/ingestao/transporte";
import { getShopeeLojaById } from "@/lib/shopee-auth";
import { criarRepositorioSupabase } from "@/lib/shopee/ingestao/persistencia";
import { criarTransporteShopee } from "@/lib/shopee/ingestao/transporte";
import type { DepsWorker } from "./worker";

export function criarDepsWorkerReais(): DepsWorker {
  const cliente = getSupabaseServidor();
  return {
    cliente,
    relogio: { agoraMs: () => Date.now() },
    portasML: async () => ({ transporte: criarTransporteML(), repo: criarRepositorioML(cliente) }),
    portasShopee: async (job) => {
      const c = await getShopeeLojaById(job.lojaId, job.userId);
      if (!c || !c.accessToken) return null;
      return {
        api: criarTransporteShopee({ partnerId: c.partnerId, partnerKey: c.partnerKey, accessToken: c.accessToken, shopId: c.shopId }),
        repo: criarRepositorioSupabase(cliente),
      };
    },
  };
}
