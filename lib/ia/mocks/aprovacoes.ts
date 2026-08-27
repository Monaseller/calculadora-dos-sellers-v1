/**
 * CDS IA — mocks: aprovacoes
 *
 * A fila de decisao humana. Nenhuma das acoes existe no backend: todas
 * carregam `procedencia: "em_breve"` e a tela exibe "Cenario futuro". *
 * Regras da pasta `lib/ia/mocks/` (ver `index.ts`): todo export usa o
 * prefixo `MOCK_`, todo id e obviamente ficticio, e nao existe dado real
 * de cliente, credencial ou identificador externo.
 */
import type { AprovacaoUI } from "@/lib/ia/aprovacoes";

// ── Fila de aprovacoes ────────────────────────────────────────────────
//
// ── Por que a fila NAO esta cruzada com `MOCK_TAREFAS` ──────────────
//
// No modelo real uma aprovacao E uma tarefa em `aguardando_aprovacao`.
// Cruzar as duas listas aqui exigiria criar tarefas nesse status para os
// agentes envolvidos — e isso mudaria o que o Escritorio e a aba Tarefas
// exibem, telas fora do escopo desta fase. Entao a fila e um conjunto
// proprio, com `tarefaId` ficticio, e o cruzamento acontece quando a
// leitura real entrar.
//
// Nenhuma das acoes abaixo existe no backend. Todas carregam
// `procedencia: "em_breve"`, e a tela exibe "Cenário futuro" — a UX fica
// demonstravel sem afirmar que a capability funciona.

export const MOCK_APROVACOES: readonly AprovacaoUI[] = [
  {
    id: "ap-1", agenteId: "ag-campanhas", agenteNome: "Campanhas", tarefaId: "tf-ap-1",
    acao: {
      capabilityId: "ads.campanha.pausar", rotulo: "Pausar campanha",
      acesso: "escrita", irreversivel: false,
      argumentos: [
        { rotulo: "Campanha", valor: "Produto X — Verão" },
        { rotulo: "Investimento diário", valor: "R$ 120,00" },
      ],
    },
    motivo: "O ACOS chegou a 7,8%, acima do limite de 5% definido nas instruções deste agente.",
    impacto: "A campanha para de veicular imediatamente. Retomar depois é um clique, mas o histórico do período fica com a lacuna.",
    risco: "alto",
    conexao: { rotulo: "Mercado Livre", conta: "Loja Exemplo", estado: "conectada" },
    solicitadaEm: "2026-08-27T11:58:00.000Z",
    nivelExigido: "aprovacao", procedencia: "em_breve",
  },
  {
    id: "ap-2", agenteId: "ag-atendimento", agenteNome: "Atendimento", tarefaId: "tf-ap-2",
    acao: {
      capabilityId: "mensagens.responder", rotulo: "Responder comprador",
      acesso: "escrita", irreversivel: true,
      argumentos: [
        { rotulo: "Perguntas", valor: "3 perguntas sobre prazo de entrega" },
        { rotulo: "Tom da resposta", valor: "Cordial e objetivo" },
      ],
    },
    motivo: "Três perguntas sem resposta há mais de duas horas, todas sobre o mesmo anúncio.",
    impacto: "As mensagens são enviadas ao comprador e não podem ser retiradas depois.",
    risco: "medio",
    // Conexao expirada: alem do bloqueio global, esta solicitacao tem um
    // segundo motivo proprio para nao poder ser aprovada.
    conexao: { rotulo: "Shopee", conta: "Loja Exemplo", estado: "expirada" },
    solicitadaEm: "2026-08-27T10:41:00.000Z",
    nivelExigido: "aprovacao", procedencia: "em_breve",
  },
  {
    id: "ap-3", agenteId: "ag-anuncios", agenteNome: "Anúncios", tarefaId: "tf-ap-3",
    acao: {
      capabilityId: "anuncio.titulo.atualizar", rotulo: "Atualizar título do anúncio",
      acesso: "escrita", irreversivel: false,
      argumentos: [
        { rotulo: "Anúncio", valor: "Kit Organizador — 6 peças" },
        { rotulo: "Título proposto", valor: "Kit Organizador de Gavetas 6 Peças Dobrável" },
      ],
    },
    motivo: "O título atual não usa os termos mais buscados para esta categoria.",
    impacto: "O título muda na página do anúncio. O anterior fica registrado no histórico.",
    risco: "baixo",
    conexao: { rotulo: "Mercado Livre", conta: "Loja Exemplo", estado: "conectada" },
    solicitadaEm: "2026-08-27T09:15:00.000Z",
    nivelExigido: "aprovacao", procedencia: "em_breve",
  },
];
