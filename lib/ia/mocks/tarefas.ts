/**
 * CDS IA — mocks: tarefas
 *
 * A fila de trabalho dos agentes, ancorada no instante da montagem da
 * tela — ver o cabecalho de `MOCK_TAREFAS`. *
 * Regras da pasta `lib/ia/mocks/` (ver `index.ts`): todo export usa o
 * prefixo `MOCK_`, todo id e obviamente ficticio, e nao existe dado real
 * de cliente, credencial ou identificador externo.
 */
import type { TarefaUI } from "@/lib/ia/contratos";

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
      // Falha TERMINAL, e o mock agora reflete o que o banco produz.
      //
      // `falhar_tarefa` decide o desfecho assim:
      //
      //   tentativas < max_tentativas -> 'pendente'  (retry, concluido_em NULL)
      //   caso contrario              -> 'erro'      (concluido_em = now())
      //
      // Ou seja: `status = 'erro'` implica DUAS coisas ao mesmo tempo —
      // tentativas esgotadas E `concluido_em` preenchido. Este mock tinha
      // `concluido_em: null`, um estado que a RPC nao consegue gerar, e o
      // efeito colateral era invisivel ate a Atividade existir: a
      // derivacao (corretamente) exige o timestamp, entao a falha nunca
      // virava evento e o filtro "Erros" ficava sempre vazio.
      id: "tf-5", agente_id: "ag-gerente", tipo: "distribuir_fila",
      entrada: {},
      status: "erro", progresso: 45, tentativas: 3, max_tentativas: 3,
      erro_tipo: "quota",
      erro_mensagem: "Limite de uso do provedor atingido para este período.",
      criado_em: iso(-4 * min), iniciado_em: iso(-3 * min), concluido_em: iso(-2 * min),
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
      // Falha TRANSITORIA, aguardando nova tentativa.
      //
      // Este mock dizia `status: "erro"` com `tentativas 2 < max 3` — um
      // estado que a RPC nao produz: com tentativas sobrando,
      // `falhar_tarefa` devolve a tarefa para `pendente`, e nao para
      // `erro`.
      //
      // O detalhe que importa: `erro_tipo` e `erro_mensagem` FICAM
      // preenchidos mesmo assim. O SQL grava os dois "nos DOIS caminhos,
      // inclusive no retry", justamente para a causa nao se perder. Ou
      // seja, erro preenchido NAO implica `status = 'erro'` — pode ser
      // uma tarefa de volta na fila carregando a falha anterior.
      //
      // E o unico mock que cobre esse estado, e ele existe para impedir
      // que alguem derive "falhou" da mera presenca de `erro_tipo`.
      id: "tf-8", agente_id: "ag-atendimento", tipo: "responder_perguntas",
      entrada: { quantidade: 7 },
      status: "pendente", progresso: 20, tentativas: 2, max_tentativas: 3,
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

/**
 * Quantas tarefas contam como "trabalhando" para o badge da subnav.
 *
 * Derivada aqui, no dominio dono do dado, e nao no `index`: quem sabe o
 * que conta como trabalho e este arquivo. `REFERENCIA_MS` continua
 * privado — o instante fixo e detalhe interno, nao API de mock.
 */
export const MOCK_CONTAGEM_TRABALHANDO = MOCK_TAREFAS(REFERENCIA_MS).filter(
  (t) => t.status === "rodando" || t.status === "pendente"
).length;
