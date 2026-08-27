/**
 * CDS IA — TODOS os dados simulados da UI-1B. Nao ha mock em nenhum
 * outro arquivo, e nao deve haver.
 *
 * ── Por que um arquivo so ───────────────────────────────────────────
 *
 * Mock espalhado por componente e mock que sobrevive a troca para dado
 * real: um `const AGENTES = [...]` esquecido dentro de uma tela continua
 * renderizando bonito e ninguem percebe que aquela tela nunca leu o
 * banco. Concentrando tudo aqui, "apagar os mocks" e uma operacao
 * verificavel — e a suite verifica.
 *
 * ── Por que os ids nao parecem UUID ─────────────────────────────────
 *
 * Sao `ag-atendimento`, `tf-1`. Um UUID falso e indistinguivel de um
 * UUID real em screenshot, em log e em copia de suporte. Estes ids
 * anunciam que sao ficticios.
 *
 * ── O que NAO existe aqui, e nao pode passar a existir ──────────────
 *
 *   user_id · loja_id · seller_id · shop_id · token · credencial
 *   API key · pedido real · nome de cliente real · valor financeiro real
 *
 * Os nomes sao de funcao ("Atendimento", "Campanhas"), nunca de pessoa.
 */
import type { AgenteUI, TarefaUI } from "@/lib/ia/contratos";

/** Texto obrigatorio na tela enquanto a area roda com simulacao. */
export const MOCK_AVISO = "Dados simulados";

/**
 * Sete agentes de proposito, nao seis.
 *
 * Seis cobririam os seis tipos do CHECK; o setimo existe para provar
 * duas coisas ao mesmo tempo: que o grid nao quebra ao passar de seis
 * estacoes, e que `tipo` nao e unico por agente (o banco tambem nao
 * exige que seja).
 */
export const MOCK_AGENTES: readonly AgenteUI[] = [
  { id: "ag-atendimento", nome: "Atendimento", tipo: "mensagens", ativo: true, criado_em: "2026-08-01T09:00:00.000Z" },
  { id: "ag-campanhas", nome: "Campanhas", tipo: "ads", ativo: true, criado_em: "2026-08-01T09:05:00.000Z" },
  { id: "ag-imagens", nome: "Imagens", tipo: "fotos", ativo: true, criado_em: "2026-08-02T10:00:00.000Z" },
  { id: "ag-anuncios", nome: "Anúncios", tipo: "anuncios", ativo: true, criado_em: "2026-08-02T10:30:00.000Z" },
  { id: "ag-financeiro", nome: "Financeiro", tipo: "financeiro", ativo: true, criado_em: "2026-08-03T08:00:00.000Z" },
  { id: "ag-gerente", nome: "Gerente", tipo: "gerente", ativo: true, criado_em: "2026-08-03T08:10:00.000Z" },
  { id: "ag-noturno", nome: "Atendimento noturno", tipo: "mensagens", ativo: false, criado_em: "2026-08-04T22:00:00.000Z" },
];

/**
 * `ancoraMs` e o instante em que a TELA MONTOU — nao "agora".
 *
 * ── A distincao que um bug tornou obrigatoria ───────────────────────
 *
 * Os timestamps sao relativos a ancora. Se a ancora fosse reavaliada a
 * cada tique do relogio, uma tarefa "encerrada ha 2s" continuaria
 * encerrada ha 2s para sempre — e `concluido`, que e TRANSITORIO por
 * definicao, viraria permanente. Foi exatamente o que aconteceu na
 * primeira versao deste arquivo.
 *
 * O contrato correto e o mesmo do banco: as LINHAS sao fixas, quem anda
 * e o relogio. Entao a tela chama `MOCK_TAREFAS` uma unica vez, com o
 * instante da montagem, e depois so avanca o relogio que avalia o
 * estado. Timestamp fixo no arquivo tambem nao serviria: o flash nunca
 * seria visto, porque a data ja teria passado ha meses.
 *
 * Continua deterministica: mesma ancora, mesma saida. Nenhuma chamada a
 * `Date.now()` acontece aqui dentro.
 */
export function MOCK_TAREFAS(ancoraMs: number): readonly TarefaUI[] {
  const iso = (deslocamentoMs: number) => new Date(ancoraMs + deslocamentoMs).toISOString();
  const s = 1_000;
  const min = 60 * s;

  return [
    {
      id: "tf-1", agente_id: "ag-atendimento", tipo: "responder_perguntas",
      titulo: "Respondendo 12 perguntas de compradores",
      status: "rodando", progresso: 35,
      criado_em: iso(-18 * min), concluido_em: null,
    },
    {
      id: "tf-2", agente_id: "ag-campanhas", tipo: "ajustar_lances",
      titulo: "Ajustando lances de 4 campanhas",
      status: "rodando", progresso: 80,
      criado_em: iso(-42 * min), concluido_em: null,
    },
    {
      // Encerrada ha 2s: dentro da janela, entao pinta o flash verde e
      // depois o agente volta sozinho para `ocioso`. E o unico estado
      // que se desfaz com a passagem do tempo, sem ninguem limpar nada.
      id: "tf-3", agente_id: "ag-imagens", tipo: "tratar_imagens",
      titulo: "21 imagens tratadas e aprovadas",
      status: "concluido", progresso: 100,
      criado_em: iso(-25 * min), concluido_em: iso(-2 * s),
    },
    {
      id: "tf-4", agente_id: "ag-anuncios", tipo: "gerar_anuncios",
      titulo: "3 anúncios prontos para revisão",
      status: "aguardando_aprovacao", progresso: 60,
      criado_em: iso(-8 * min), concluido_em: null,
    },
    {
      id: "tf-5", agente_id: "ag-gerente", tipo: "distribuir_fila",
      titulo: "Falha ao distribuir a fila de tarefas",
      status: "erro", progresso: 45,
      criado_em: iso(-3 * min), concluido_em: null,
    },
    {
      // O agente desativado mantem historico: `desativado` vence tudo na
      // precedencia, entao esta tarefa NAO pode colorir o estado dele.
      // Ela esta aqui exatamente para provar isso na tela.
      id: "tf-6", agente_id: "ag-noturno", tipo: "responder_perguntas",
      titulo: "Turno encerrado",
      status: "concluido", progresso: 100,
      criado_em: iso(-14 * 60 * min), concluido_em: iso(-12 * 60 * min),
    },
  ];
}

/**
 * Contagens para os badges da subnav.
 *
 * Derivadas das MESMAS tarefas, nunca digitadas a mao — numero escrito
 * em dois lugares e numero que diverge. E calculadas sobre um instante
 * FIXO porque as contagens dependem so de `status`, nao do relogio:
 * assim o valor e identico no servidor e no cliente, e a subnav nao
 * precisa esperar a montagem para aparecer.
 */
const REFERENCIA_MS = Date.parse("2026-08-20T12:00:00.000Z");

export const MOCK_CONTAGENS = {
  trabalhando: MOCK_TAREFAS(REFERENCIA_MS).filter(
    (t) => t.status === "rodando" || t.status === "pendente"
  ).length,
  aguardandoAprovacao: MOCK_TAREFAS(REFERENCIA_MS).filter(
    (t) => t.status === "aguardando_aprovacao"
  ).length,
} as const;

// Nao existe helper "tarefas do agente": as duas telas ja filtram a
// lista que carregam, e um terceiro caminho para a mesma leitura seria
// so mais um lugar onde a ancora poderia ser passada errada.
