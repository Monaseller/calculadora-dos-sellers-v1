/**
 * CDS IA — TODOS os dados simulados da interface. Nao ha mock em nenhum
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
 * Quando passar de ~400 linhas, dividir em `lib/ia/mocks/` por dominio,
 * mantendo o prefixo `MOCK_` e a regra de nenhum fake fora da pasta.
 *
 * ── Por que os ids nao parecem UUID ─────────────────────────────────
 *
 * Sao `ag-atendimento`, `tf-1`. Um UUID falso e indistinguivel de um
 * UUID real em screenshot, em log e em copia de suporte. Estes ids
 * anunciam que sao ficticios. Eles tambem sao a chave da rota
 * `/ia/agentes/[id]` durante a fase visual — o que funciona porque a
 * resolucao e feita AQUI, nunca por consulta.
 *
 * ── O que NAO existe aqui, e nao pode passar a existir ──────────────
 *
 *   user_id · loja_id · seller_id · shop_id · token · credencial
 *   API key · pedido real · nome de cliente real · valor financeiro real
 *
 * Os nomes sao de funcao ("Atendimento", "Campanhas"), nunca de pessoa.
 */
import type { AgenteUI, TarefaUI } from "@/lib/ia/contratos";
import type { ConexaoUI, FuncaoUI, PermissaoUI } from "@/lib/ia/conceitos";

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
 *
 * ── Sobre `entrada` ─────────────────────────────────────────────────
 *
 * E `jsonb` no banco. Aqui ela carrega so os numeros que o titulo
 * legivel consome (`lib/ia/tarefas.ts`), porque a tela le chaves
 * conhecidas uma a uma e nunca serializa o objeto.
 */
export function MOCK_TAREFAS(ancoraMs: number): readonly TarefaUI[] {
  const iso = (deslocamentoMs: number) => new Date(ancoraMs + deslocamentoMs).toISOString();
  const s = 1_000;
  const min = 60 * s;
  const h = 60 * min;

  return [
    {
      id: "tf-1", agente_id: "ag-atendimento", tipo: "responder_perguntas",
      entrada: { quantidade: 12 },
      status: "rodando", progresso: 35, tentativas: 1, max_tentativas: 3,
      erro_tipo: null, erro_mensagem: null,
      criado_em: iso(-19 * min), iniciado_em: iso(-18 * min), concluido_em: null,
      heartbeat_em: iso(-10 * s),
    },
    {
      id: "tf-2", agente_id: "ag-campanhas", tipo: "ajustar_lances",
      entrada: { campanhas: 4 },
      status: "rodando", progresso: 80, tentativas: 2, max_tentativas: 3,
      erro_tipo: null, erro_mensagem: null,
      criado_em: iso(-45 * min), iniciado_em: iso(-42 * min), concluido_em: null,
      heartbeat_em: iso(-8 * s),
    },
    {
      // Encerrada ha 2s: dentro da janela, entao pinta o flash verde e
      // depois o agente volta sozinho para `ocioso`. E o unico estado
      // que se desfaz com a passagem do tempo, sem ninguem limpar nada.
      id: "tf-3", agente_id: "ag-imagens", tipo: "tratar_imagens",
      entrada: { quantidade: 21 },
      status: "concluido", progresso: 100, tentativas: 1, max_tentativas: 3,
      erro_tipo: null, erro_mensagem: null,
      criado_em: iso(-26 * min), iniciado_em: iso(-25 * min), concluido_em: iso(-2 * s),
      heartbeat_em: null,
    },
    {
      id: "tf-4", agente_id: "ag-anuncios", tipo: "gerar_anuncios",
      entrada: { quantidade: 3 },
      status: "aguardando_aprovacao", progresso: 60, tentativas: 1, max_tentativas: 3,
      erro_tipo: null, erro_mensagem: null,
      criado_em: iso(-9 * min), iniciado_em: iso(-8 * min), concluido_em: null,
      heartbeat_em: null,
    },
    {
      id: "tf-5", agente_id: "ag-gerente", tipo: "distribuir_fila",
      entrada: {},
      status: "erro", progresso: 45, tentativas: 3, max_tentativas: 3,
      erro_tipo: "quota",
      erro_mensagem: "Limite de uso do provedor atingido para este período.",
      criado_em: iso(-4 * min), iniciado_em: iso(-3 * min), concluido_em: null,
      heartbeat_em: null,
    },
    {
      // O agente desativado mantem historico: `desativado` vence tudo na
      // precedencia, entao esta tarefa NAO pode colorir o estado dele.
      // Ela esta aqui exatamente para provar isso na tela.
      id: "tf-6", agente_id: "ag-noturno", tipo: "responder_perguntas",
      entrada: { quantidade: 31 },
      status: "concluido", progresso: 100, tentativas: 1, max_tentativas: 3,
      erro_tipo: null, erro_mensagem: null,
      criado_em: iso(-14 * h), iniciado_em: iso(-14 * h + min), concluido_em: iso(-12 * h),
      heartbeat_em: null,
    },

    // ── Historico, para a aba Tarefas ter o que mostrar ─────────────
    {
      id: "tf-7", agente_id: "ag-atendimento", tipo: "responder_perguntas",
      entrada: { quantidade: 1 },
      status: "concluido", progresso: 100, tentativas: 1, max_tentativas: 3,
      erro_tipo: null, erro_mensagem: null,
      criado_em: iso(-3 * h), iniciado_em: iso(-3 * h + 40 * s), concluido_em: iso(-3 * h + 4 * min),
      heartbeat_em: null,
    },
    {
      id: "tf-8", agente_id: "ag-atendimento", tipo: "responder_perguntas",
      entrada: { quantidade: 7 },
      status: "erro", progresso: 20, tentativas: 2, max_tentativas: 3,
      erro_tipo: "rede",
      erro_mensagem: "Tempo esgotado ao contatar o provedor.",
      criado_em: iso(-6 * h), iniciado_em: iso(-6 * h + 12 * s), concluido_em: null,
      heartbeat_em: null,
    },
    {
      id: "tf-9", agente_id: "ag-atendimento", tipo: "analise_vendas",
      entrada: { dias: 7 },
      status: "pendente", progresso: 0, tentativas: 0, max_tentativas: 3,
      erro_tipo: null, erro_mensagem: null,
      criado_em: iso(-2 * min), iniciado_em: null, concluido_em: null,
      heartbeat_em: null,
    },
    {
      id: "tf-10", agente_id: "ag-atendimento", tipo: "responder_perguntas",
      entrada: { quantidade: 4 },
      status: "cancelado", progresso: 0, tentativas: 1, max_tentativas: 3,
      erro_tipo: null, erro_mensagem: null,
      criado_em: iso(-26 * h), iniciado_em: null, concluido_em: iso(-25 * h),
      heartbeat_em: null,
    },
    {
      // `rodando` com heartbeat parado ha mais de 5 minutos: e o que o
      // `claim` do banco considera orfa e devolve para a fila.
      id: "tf-11", agente_id: "ag-campanhas", tipo: "ajustar_lances",
      entrada: { campanhas: 2 },
      status: "rodando", progresso: 15, tentativas: 1, max_tentativas: 3,
      erro_tipo: null, erro_mensagem: null,
      criado_em: iso(-40 * min), iniciado_em: iso(-38 * min), concluido_em: null,
      heartbeat_em: iso(-22 * min),
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

// ── Resumos de configuracao (Visao Geral) ─────────────────────────────
//
// Estes tres NAO representam nada persistido. Cada item carrega sua
// `procedencia`, e a tela e obrigada a exibi-la: e o que impede um
// resumo simulado de parecer configuracao real.

export const MOCK_CONEXOES: readonly ConexaoUI[] = [
  { id: "cx-ml", tipo: "mercado_livre", rotulo: "Mercado Livre", conta: "Conta principal", ativa: true, procedencia: "simulado" },
  { id: "cx-shopee", tipo: "shopee", rotulo: "Shopee", conta: "Loja principal", ativa: true, procedencia: "simulado" },
];

export const MOCK_FUNCOES: readonly FuncaoUI[] = [
  {
    id: "vendas.consultar", rotulo: "Consultar vendas",
    descricao: "Lê vendas de um período limitado, já filtradas pelo dono.",
    conexaoNecessaria: null, acesso: "leitura", risco: "baixo",
    // A unica com lastro real: existe handler `analise_vendas` no
    // runtime, com janela limitada e dono fechado por closure.
    procedencia: "disponivel",
  },
  {
    id: "anuncio.consultar", rotulo: "Consultar anúncios",
    descricao: "Lê os anúncios publicados na conta conectada.",
    conexaoNecessaria: "cx-ml", acesso: "leitura", risco: "baixo",
    procedencia: "em_breve",
  },
  {
    id: "ads.metricas.ler", rotulo: "Ler métricas de campanha",
    descricao: "Lê investimento, ACOS e conversão das campanhas.",
    conexaoNecessaria: "cx-ml", acesso: "leitura", risco: "baixo",
    procedencia: "em_breve",
  },
  {
    id: "ads.campanha.pausar", rotulo: "Pausar campanha",
    descricao: "Interrompe a veiculação de uma campanha ativa.",
    conexaoNecessaria: "cx-ml", acesso: "escrita", risco: "alto",
    procedencia: "em_breve",
  },
];

export const MOCK_PERMISSOES: readonly PermissaoUI[] = [
  { funcaoId: "vendas.consultar", concedida: true, autonomia: "automatico", procedencia: "simulado" },
  { funcaoId: "ads.metricas.ler", concedida: true, autonomia: "automatico", procedencia: "em_breve" },
  { funcaoId: "ads.campanha.pausar", concedida: true, autonomia: "aprovacao", procedencia: "em_breve" },
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
