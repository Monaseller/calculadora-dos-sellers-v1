/**
 * CDS IA — mocks: agentes
 *
 * Quem existe no escritorio. Os ids daqui sao a chave da rota
 * `/ia/agentes/[id]` durante a fase visual — a resolucao acontece em
 * memoria, nunca por consulta. *
 * Regras da pasta `lib/ia/mocks/` (ver `index.ts`): todo export usa o
 * prefixo `MOCK_`, todo id e obviamente ficticio, e nao existe dado real
 * de cliente, credencial ou identificador externo.
 */
import type { AgenteUI } from "@/lib/ia/contratos";

/**
 * Sete agentes de proposito, nao seis.
 *
 * Seis cobririam os seis tipos do CHECK; o setimo existe para provar
 * duas coisas ao mesmo tempo: que o grid nao quebra ao passar de seis
 * estacoes, e que `tipo` nao e unico por agente (o banco tambem nao
 * exige que seja).
 */
export const MOCK_AGENTES: readonly AgenteUI[] = [
  {
    id: "ag-atendimento", nome: "Atendimento", tipo: "mensagens", ativo: true,
    instrucoes: "Responda em português, com tom cordial e objetivo. Nunca prometa prazo de entrega que não esteja na página do anúncio.",
    criado_em: "2026-08-01T09:00:00.000Z",
  },
  {
    id: "ag-campanhas", nome: "Campanhas", tipo: "ads", ativo: true,
    instrucoes: "Acompanhe o ACOS diariamente. Priorize campanhas com maior investimento.",
    criado_em: "2026-08-01T09:05:00.000Z",
  },
  {
    id: "ag-imagens", nome: "Imagens", tipo: "fotos", ativo: true,
    instrucoes: null,
    criado_em: "2026-08-02T10:00:00.000Z",
  },
  {
    id: "ag-anuncios", nome: "Anúncios", tipo: "anuncios", ativo: true,
    instrucoes: "Todo dado do anúncio precisa vir da ficha do produto. Sem evidência, deixe o campo vazio.",
    criado_em: "2026-08-02T10:30:00.000Z",
  },
  {
    id: "ag-financeiro", nome: "Financeiro", tipo: "financeiro", ativo: true,
    instrucoes: "Número financeiro vem de API oficial e cálculo determinístico. Nunca estime.",
    criado_em: "2026-08-03T08:00:00.000Z",
  },
  {
    id: "ag-gerente", nome: "Gerente", tipo: "gerente", ativo: true,
    instrucoes: null,
    criado_em: "2026-08-03T08:10:00.000Z",
  },
  {
    id: "ag-noturno", nome: "Atendimento noturno", tipo: "mensagens", ativo: false,
    instrucoes: "Ativo apenas entre 22h e 6h.",
    criado_em: "2026-08-04T22:00:00.000Z",
  },
];


/**
 * Resolucao do agente por id, no proprio conjunto de mocks.
 *
 * A rota dinamica usa isto — nao consulta, nao busca, nao chama nada.
 * `undefined` quando o id nao existe, e a tela trata como "Agente nao
 * encontrado" em vez de quebrar.
 */
export function MOCK_AGENTE_POR_ID(id: string): AgenteUI | undefined {
  return MOCK_AGENTES.find((a) => a.id === id);
}
