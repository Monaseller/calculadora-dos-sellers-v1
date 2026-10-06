/**
 * Transporte REAL do motor ML: a varredura homologada por FECHAMENTO
 * (`varrerFechamentosDoDiaML` → `varrerDias`: paginacao completa, 429 com
 * espera, releitura do dia curto, conferencia contra `paging.total`).
 * Nenhuma segunda implementacao de paginacao. Credencial resolvida pelo
 * PAR (loja, dono) dentro da varredura; `portas` permite injetar fetch e
 * resolvedor (testes e prova live sem renovar token).
 */
import "server-only";
import { varrerFechamentosDoDiaML, type PortasVendasML } from "@/lib/mercado-livre-vendas";
import type { DiaFechadoML, TransporteML } from "./tipos";

export function criarTransporteML(portas?: PortasVendasML): TransporteML {
  return {
    async listarDiaFechado({ userId, lojaId, dia }): Promise<DiaFechadoML> {
      return varrerFechamentosDoDiaML({ userId, lojaId, dia, portas });
    },
  };
}
