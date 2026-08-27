/**
 * CDS IA — mocks: conexoes
 *
 * As contas/fontes disponiveis e quais funcoes dependem de cada uma.
 * O contrato `ConexaoUI` nao tem campo de credencial nem de id externo,
 * entao nao ha o que vazar aqui. *
 * Regras da pasta `lib/ia/mocks/` (ver `index.ts`): todo export usa o
 * prefixo `MOCK_`, todo id e obviamente ficticio, e nao existe dado real
 * de cliente, credencial ou identificador externo.
 */
import type { ConexaoUI, FuncaoUI } from "@/lib/ia/conceitos";
import { MOCK_FUNCOES } from "@/lib/ia/mocks/capabilities";

/**
 * Tres conexoes de proposito, cobrindo os casos que a tela precisa
 * distinguir: uma conectada e atribuida, uma com autorizacao vencida, e
 * uma perfeitamente conectada que simplesmente NAO foi dada a este
 * agente — o caso que prova que "existe no CDS" e "atribuida ao agente"
 * sao coisas diferentes.
 *
 * Contas com nome inequivocamente ficticio. Nenhum `seller_id`,
 * `shop_id` ou `partner_id`: o contrato nem tem esses campos.
 */
export const MOCK_CONEXOES: readonly ConexaoUI[] = [
  {
    id: "cx-ml", tipo: "mercado_livre", rotulo: "Mercado Livre",
    conta: "Loja Exemplo", estado: "conectada", atribuida: true,
    ultimaSincronizacao: "2026-08-27T09:14:00.000Z", procedencia: "simulado",
  },
  {
    id: "cx-shopee", tipo: "shopee", rotulo: "Shopee",
    conta: "Loja Exemplo", estado: "expirada", atribuida: true,
    ultimaSincronizacao: "2026-08-24T18:02:00.000Z", procedencia: "simulado",
  },
  {
    id: "cx-ml-2", tipo: "mercado_livre", rotulo: "Mercado Livre",
    conta: "Segunda conta", estado: "conectada", atribuida: false,
    ultimaSincronizacao: null, procedencia: "simulado",
  },
];


/** Funcoes que dependem de uma conexao — o "Usada por" do card. */
export function MOCK_FUNCOES_DA_CONEXAO(conexaoId: string): readonly FuncaoUI[] {
  return MOCK_FUNCOES.filter((f) => f.conexaoNecessaria === conexaoId);
}
