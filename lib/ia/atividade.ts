/**
 * CDS IA — o feed de atividade: contrato, vocabulario e derivacao.
 *
 * ── A regra que governa este arquivo ────────────────────────────────
 *
 * `agente_tarefas` e tabela de ESTADO, e estado sobrescreve. A auditoria
 * da UI-1D.b encontrou tres mecanismos que APAGAM historia:
 *
 *   claim ............ `iniciado_em = now()` a cada tentativa
 *   concluir_tarefa .. zera `erro_tipo` e `erro_mensagem`
 *   falhar_tarefa .... no retry, devolve `concluido_em` para NULL
 *
 * Uma tarefa que falhou duas vezes por motivos diferentes e depois
 * concluiu deixa apenas `tentativas = 3` — sem quando, sem por que.
 *
 * Por isso este arquivo deriva SOMENTE o que a fonte sustenta, e a
 * ausencia e deliberada: e melhor a timeline nao ter uma linha do que
 * ter uma linha inventada. Nao existe `tarefa.iniciada` aqui, e nao deve
 * passar a existir enquanto `iniciado_em` for sobrescrito.
 *
 * ── Evento nao e status ─────────────────────────────────────────────
 *
 * `StatusTarefa`, `EstadoVisual` e `EstadoConexao` descrevem o AGORA.
 * Um evento e um fato datado que nao muda mais. Reaproveitar aqueles
 * tipos como vocabulario de evento faria "concluido" significar duas
 * coisas diferentes na mesma area.
 */
import type { Procedencia } from "@/lib/ia/conceitos";
import type { AgenteUI, TarefaUI } from "@/lib/ia/contratos";
import type { AprovacaoUI } from "@/lib/ia/aprovacoes";
import { mensagemDeErro, tituloDaTarefa } from "@/lib/ia/tarefas";

// ── Vocabulario ───────────────────────────────────────────────────────

/**
 * Seis tipos, e cada um tem lastro:
 *
 *   tarefa.criada ......... `criado_em`, NOT NULL, nunca reescrito
 *   tarefa.concluida ...... `concluido_em` no desfecho bem-sucedido
 *   tarefa.falhou ......... `concluido_em` + `erro_*` no desfecho terminal
 *   ia.chamada ............ `agentes_ia_chamadas`, append-only de verdade
 *   aprovacao.solicitada .. `status = 'aguardando_aprovacao'`
 *   agente.alterado ....... `agentes.atualizado_em`
 *
 * O que NAO esta aqui, e por que: `tarefa.iniciada` e `tarefa.retry`
 * (fonte sobrescrita), `aprovacao.aprovada`/`recusada` (nao existe
 * registro de decisao), `agente.ativado`/`desativado` (nao da para
 * distinguir de outra alteracao), `conexao.*` e `permissao.*` (nao ha
 * modelo). Cada ausencia e uma decisao, nao um esquecimento.
 */
export const TIPOS_EVENTO = [
  "tarefa.criada",
  "tarefa.concluida",
  "tarefa.falhou",
  "ia.chamada",
  "aprovacao.solicitada",
  "agente.alterado",
] as const;
export type TipoEvento = (typeof TIPOS_EVENTO)[number];

/** Quanto o evento pede atencao. Eixo proprio: um erro e sempre `erro`,
 *  mas nem todo evento de tarefa e `info`. */
export const SEVERIDADES = ["info", "atencao", "erro"] as const;
export type Severidade = (typeof SEVERIDADES)[number];

/**
 * Quem causou. Tres origens com significados diferentes para quem le:
 * "o agente errou" nao e "o sistema tentou de novo" nem "eu autorizei".
 *
 * `usuario` existe no contrato e hoje NAO tem ocorrencia: nao ha
 * registro de decisao humana em lugar nenhum. Ter o eixo desde agora
 * evita reclassificar todo evento ja renderizado quando houver.
 */
export const TIPOS_ATOR = ["agente", "usuario", "sistema"] as const;
export type TipoAtor = (typeof TIPOS_ATOR)[number];

export const VOCABULARIO_EVENTO: Record<TipoEvento, { rotulo: string; icone: string }> = {
  "tarefa.criada": { rotulo: "Tarefa criada", icone: "+" },
  "tarefa.concluida": { rotulo: "Tarefa concluída", icone: "✓" },
  "tarefa.falhou": { rotulo: "Falha", icone: "✕" },
  "ia.chamada": { rotulo: "Chamada de IA", icone: "◇" },
  "aprovacao.solicitada": { rotulo: "Aprovação solicitada", icone: "!" },
  "agente.alterado": { rotulo: "Agente alterado", icone: "⚙" },
};

export const ROTULO_ATOR: Record<TipoAtor, string> = {
  agente: "Agente",
  usuario: "Você",
  sistema: "Sistema",
};

// ── Contrato ──────────────────────────────────────────────────────────

export interface AtorEvento {
  tipo: TipoAtor;
  nome: string;
}

export interface LinkEvento {
  href: string;
  rotulo: string;
}

/**
 * Um fato datado.
 *
 * `detalhe` e `null` quando nao ha informacao adicional segura — e ai a
 * tela NAO renderiza um `<details>` vazio. Nunca carrega payload,
 * `entrada`, prompt, resposta do modelo, stack, SQL ou credencial: o
 * contrato simplesmente nao tem campo para isso.
 */
export interface EventoAtividade {
  id: string;
  tipo: TipoEvento;
  severidade: Severidade;
  ator: AtorEvento;
  agenteId: string;
  agenteNome: string;
  /** ISO. */
  instante: string;
  /** A frase que o usuario le. Ja montada, ja segura. */
  frase: string;
  detalhe: string | null;
  link: LinkEvento | null;
  procedencia: Procedencia;
}

// ── Ordenacao ─────────────────────────────────────────────────────────

/**
 * Mais recentes primeiro — o contrario de Aprovacoes, e a diferenca nao
 * e estetica: fila e trabalho a fazer, e quem espera ha mais tempo tem
 * prioridade; feed e o que acabou de acontecer, e o topo e o presente.
 *
 * `maisRecentesPrimeiro` de `lib/ia/tarefas.ts` esta tipada para
 * `TarefaUI`. Generaliza-la exigiria afrouxar aquele contrato para
 * acomodar um caso que nao e dele — entao aqui ha uma funcao propria,
 * pequena, com desempate DETERMINISTICO por id. Sem o desempate, dois
 * eventos no mesmo milissegundo trocariam de lugar entre renders.
 */
export function maisRecentesPrimeiro(
  eventos: readonly EventoAtividade[]
): EventoAtividade[] {
  return [...eventos].sort((a, b) => {
    const ta = Date.parse(a.instante);
    const tb = Date.parse(b.instante);
    const ia = Number.isNaN(ta) ? 0 : ta;
    const ib = Number.isNaN(tb) ? 0 : tb;
    if (ib !== ia) return ib - ia;
    return b.id.localeCompare(a.id);
  });
}

/**
 * Limite do feed.
 *
 * Aplicado de verdade — nao e paginacao simulada: a tela mostra os 30
 * mais recentes e diz isso. Quando houver leitura real, a consulta usa
 * cursor KEYSET `(criado_em DESC, id DESC)`, que e o mesmo criterio de
 * ordenacao acima; offset em feed que cresce degrada e chega a repetir
 * linhas entre paginas. Nao ha botao "Carregar mais" nesta fase porque
 * nao ha o que carregar.
 */
export const LIMITE_FEED = 30;

// ── Filtros ───────────────────────────────────────────────────────────

export const FILTROS = ["tudo", "tarefas", "aprovacoes", "erros"] as const;
export type Filtro = (typeof FILTROS)[number];

export const ROTULO_FILTRO: Record<Filtro, string> = {
  tudo: "Tudo",
  tarefas: "Tarefas",
  aprovacoes: "Aprovações",
  erros: "Erros",
};

/**
 * Nao existe filtro "Sistema": retry e tarefa orfa sao inferencias sobre
 * estado atual, nao eventos — nao ha o que filtrar. `ia.chamada` e
 * `agente.alterado` aparecem apenas em "Tudo", de proposito: criar uma
 * aba para cada tipo transformaria quatro filtros uteis em seis pouco
 * usados.
 */
export function aplicarFiltro(
  eventos: readonly EventoAtividade[],
  filtro: Filtro
): EventoAtividade[] {
  switch (filtro) {
    case "tarefas":
      return eventos.filter((e) => e.tipo.startsWith("tarefa."));
    case "aprovacoes":
      return eventos.filter((e) => e.tipo.startsWith("aprovacao."));
    case "erros":
      return eventos.filter((e) => e.severidade === "erro");
    case "tudo":
    default:
      return [...eventos];
  }
}

// ── Derivacao ─────────────────────────────────────────────────────────

const linkTarefas = (agenteId: string): LinkEvento => ({
  href: `/ia/agentes/${agenteId}?aba=tarefas`,
  rotulo: "Ver tarefas",
});

/**
 * Eventos que uma tarefa sustenta. Zero, um ou dois — nunca um por
 * tentativa.
 *
 *   sempre ................ `tarefa.criada`
 *   se concluiu ........... `tarefa.concluida`
 *   se falhou em terminal . `tarefa.falhou`
 *
 * `cancelado` nao gera evento: nao ha tipo para ele no vocabulario, e
 * nada no runtime produz esse status hoje. Melhor omitir que inventar.
 *
 * A procedencia e `disponivel` porque `criado_em` e `concluido_em` sao
 * colunas reais que nao sao reescritas nesses dois desfechos.
 */
export function eventosDeTarefa(
  tarefa: TarefaUI,
  agente: Pick<AgenteUI, "id" | "nome">
): EventoAtividade[] {
  const base = {
    ator: { tipo: "agente" as const, nome: agente.nome },
    agenteId: agente.id,
    agenteNome: agente.nome,
    link: linkTarefas(agente.id),
    procedencia: "disponivel" as const,
  };

  const eventos: EventoAtividade[] = [
    {
      ...base,
      id: `ev-${tarefa.id}-criada`,
      tipo: "tarefa.criada",
      severidade: "info",
      instante: tarefa.criado_em,
      frase: `Recebeu a tarefa “${tituloDaTarefa(tarefa)}”.`,
      detalhe: null,
    },
  ];

  if (tarefa.status === "concluido" && tarefa.concluido_em !== null) {
    eventos.push({
      ...base,
      id: `ev-${tarefa.id}-concluida`,
      tipo: "tarefa.concluida",
      severidade: "info",
      instante: tarefa.concluido_em,
      frase: `Concluiu “${tituloDaTarefa(tarefa)}”.`,
      detalhe: null,
    });
  }

  if (tarefa.status === "erro" && tarefa.concluido_em !== null) {
    eventos.push({
      ...base,
      id: `ev-${tarefa.id}-falhou`,
      tipo: "tarefa.falhou",
      severidade: "erro",
      instante: tarefa.concluido_em,
      frase: `Falhou em “${tituloDaTarefa(tarefa)}”.`,
      // Mensagem ja sanitizada pela funcao que a aba Tarefas usa —
      // espacos colapsados, truncada, sem stack e sem payload.
      detalhe: mensagemDeErro(tarefa),
    });
  }

  return eventos;
}

/**
 * Uma solicitacao de aprovacao vira UMA linha, com link para a fila —
 * nunca uma copia do card. O feed diz que aconteceu; a fila e onde se
 * decide.
 *
 * Procedencia `em_breve`, e nao `disponivel`: nada no runtime produz
 * `aguardando_aprovacao` hoje, entao nem "solicitou aprovacao" e
 * observavel de verdade.
 */
export function eventosDeAprovacao(aprovacao: AprovacaoUI): EventoAtividade[] {
  return [
    {
      id: `ev-${aprovacao.id}-solicitada`,
      tipo: "aprovacao.solicitada",
      severidade: "atencao",
      ator: { tipo: "agente", nome: aprovacao.agenteNome },
      agenteId: aprovacao.agenteId,
      agenteNome: aprovacao.agenteNome,
      instante: aprovacao.solicitadaEm,
      frase: `Pediu autorização para “${aprovacao.acao.rotulo}”.`,
      detalhe: aprovacao.motivo,
      link: { href: "/ia/aprovacoes", rotulo: "Ver aprovações" },
      procedencia: "em_breve",
    },
  ];
}

/**
 * Monta o feed: deriva o que tem fonte, junta o que nao tem, ordena e
 * corta no limite.
 *
 * Recebe tudo por parametro e nao importa mock nenhum — e a mesma funcao
 * que serve para DTOs reais quando a leitura existir. E o ponto da
 * estrategia hibrida: a derivacao sobrevive a troca dos mocks.
 */
export function montarFeed(entrada: {
  tarefas: readonly TarefaUI[];
  agentes: readonly Pick<AgenteUI, "id" | "nome">[];
  aprovacoes: readonly AprovacaoUI[];
  /** Eventos que nenhuma fonte atual sustenta. */
  extras: readonly EventoAtividade[];
}): EventoAtividade[] {
  const porId = new Map(entrada.agentes.map((a) => [a.id, a]));

  const deTarefas = entrada.tarefas.flatMap((t) => {
    const agente = porId.get(t.agente_id);
    // Tarefa de agente desconhecido nao vira evento sem dono: preferimos
    // perder a linha a exibir "agente indefinido".
    return agente ? eventosDeTarefa(t, agente) : [];
  });

  const deAprovacoes = entrada.aprovacoes.flatMap(eventosDeAprovacao);

  return maisRecentesPrimeiro([...deTarefas, ...deAprovacoes, ...entrada.extras])
    .slice(0, LIMITE_FEED);
}
