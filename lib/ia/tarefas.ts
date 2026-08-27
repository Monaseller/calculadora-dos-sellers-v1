/**
 * CDS IA — apresentacao de tarefas. Funcoes PURAS sobre `TarefaUI`.
 *
 * ── A regra central: nada aqui inventa dado ─────────────────────────
 *
 * Tudo o que este arquivo produz e DERIVADO das colunas que
 * `agente_tarefas` ja tem. Nenhuma funcao pede coluna nova, e o titulo
 * legivel — a maior tentacao — e calculado de `tipo` + `entrada`, nao
 * armazenado.
 *
 * ── Status de TAREFA nao e estado de AGENTE ─────────────────────────
 *
 * Sao seis status de tarefa (`pendente`, `rodando`,
 * `aguardando_aprovacao`, `concluido`, `erro`, `cancelado`) e cinco
 * estados visuais de agente. Relacionados, diferentes: um agente com
 * quatro tarefas tem UM estado; cada tarefa tem o seu. Este arquivo
 * cuida do primeiro conjunto e nao importa nada de `estados.ts`, para
 * que a separacao seja estrutural e nao apenas uma promessa.
 */
import type { StatusTarefaUI, TarefaUI } from "@/lib/ia/contratos";

// ── Vocabulario de status de TAREFA ───────────────────────────────────

export const VOCABULARIO_STATUS_TAREFA: Record<
  StatusTarefaUI,
  { rotulo: string; icone: string }
> = {
  pendente: { rotulo: "Na fila", icone: "…" },
  rodando: { rotulo: "Em execução", icone: "▶" },
  aguardando_aprovacao: { rotulo: "Requer aprovação", icone: "!" },
  concluido: { rotulo: "Concluída", icone: "✓" },
  erro: { rotulo: "Falhou", icone: "✕" },
  cancelado: { rotulo: "Cancelada", icone: "—" },
};

/** Terminais: nada sai daqui. Espelha `STATUS_TAREFA_TERMINAIS`. */
const TERMINAIS: readonly StatusTarefaUI[] = ["concluido", "cancelado"];

// ── Titulo legivel, derivado ──────────────────────────────────────────

/**
 * Le APENAS chaves conhecidas de `entrada`, uma a uma, e so aceita
 * numero finito. Nunca varre o objeto, nunca imprime valor
 * desconhecido, nunca serializa `entrada`.
 *
 * Isso e uma escolha de seguranca, nao de estilo: `entrada` e `jsonb`
 * livre, e um dia alguem vai gravar ali algo que nao deveria aparecer na
 * tela. Uma allowlist envelhece bem; um `JSON.stringify` nao.
 */
function numeroDe(entrada: Record<string, unknown>, chave: string): number | null {
  const bruto = entrada[chave];
  return typeof bruto === "number" && Number.isFinite(bruto) ? bruto : null;
}

function plural(n: number, singular: string, plural_: string): string {
  return `${n} ${n === 1 ? singular : plural_}`;
}

export function tituloDaTarefa(tarefa: Pick<TarefaUI, "tipo" | "entrada">): string {
  const e = tarefa.entrada ?? {};

  switch (tarefa.tipo) {
    case "responder_perguntas": {
      const n = numeroDe(e, "quantidade");
      return n === null
        ? "Respondendo perguntas de compradores"
        : `Respondendo ${plural(n, "pergunta", "perguntas")} de compradores`;
    }
    case "ajustar_lances": {
      const n = numeroDe(e, "campanhas");
      return n === null
        ? "Ajustando lances de campanhas"
        : `Ajustando lances de ${plural(n, "campanha", "campanhas")}`;
    }
    case "tratar_imagens": {
      const n = numeroDe(e, "quantidade");
      return n === null ? "Tratando imagens" : `Tratando ${plural(n, "imagem", "imagens")}`;
    }
    case "gerar_anuncios": {
      const n = numeroDe(e, "quantidade");
      return n === null ? "Gerando anúncios" : `Gerando ${plural(n, "anúncio", "anúncios")}`;
    }
    case "analise_vendas": {
      const n = numeroDe(e, "dias");
      return n === null
        ? "Analisando vendas do período"
        : `Analisando vendas dos últimos ${plural(n, "dia", "dias")}`;
    }
    case "distribuir_fila":
      return "Distribuindo a fila de tarefas";
    default:
      // Tipo desconhecido nao vira "[object Object]" nem despejo de
      // `entrada`: vira o proprio tipo, legivel. A tela degrada, o dado
      // nao vaza.
      return humanizar(tarefa.tipo);
  }
}

function humanizar(tipo: string): string {
  const limpo = tipo.replace(/[_-]+/g, " ").trim();
  if (limpo.length === 0) return "Tarefa";
  return limpo.charAt(0).toUpperCase() + limpo.slice(1);
}

// ── Derivacoes de tempo ───────────────────────────────────────────────

function instante(iso: string | null): number | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Quanto a tarefa levou executando.
 *
 * Terminou -> `concluido_em − iniciado_em`.
 * Ainda rodando -> `agoraMs − iniciado_em`, que e duracao PARCIAL.
 * Nunca iniciou -> `null`, nao zero: "nao comecou" e "levou 0ms" sao
 * coisas diferentes, e zero mentiria na tabela.
 */
export function duracaoMs(
  tarefa: Pick<TarefaUI, "iniciado_em" | "concluido_em">,
  agoraMs: number
): number | null {
  const inicio = instante(tarefa.iniciado_em);
  if (inicio === null) return null;
  const fim = instante(tarefa.concluido_em) ?? agoraMs;
  const total = fim - inicio;
  return total >= 0 ? total : null;
}

/** Espera entre criar e comecar. `null` enquanto nao comecou. */
export function esperaNaFilaMs(
  tarefa: Pick<TarefaUI, "criado_em" | "iniciado_em">
): number | null {
  const criado = instante(tarefa.criado_em);
  const inicio = instante(tarefa.iniciado_em);
  if (criado === null || inicio === null) return null;
  const espera = inicio - criado;
  return espera >= 0 ? espera : null;
}

/**
 * Limite de orfa do worker: 5 minutos sem heartbeat. Nao e escolha da
 * UI — e o valor de `claim_next_agente_tarefa`, e existe aqui so para a
 * tela poder dizer "parada ha tempo demais" com o mesmo criterio que o
 * banco usa para reivindicar a tarefa de volta.
 */
export const LIMITE_ORFA_MS = 5 * 60 * 1000;

export function pareceOrfa(
  tarefa: Pick<TarefaUI, "status" | "heartbeat_em">,
  agoraMs: number
): boolean {
  if (tarefa.status !== "rodando") return false;
  const bat = instante(tarefa.heartbeat_em);
  if (bat === null) return false;
  return agoraMs - bat > LIMITE_ORFA_MS;
}

/**
 * `false` para status terminal, mesmo com tentativas sobrando: de
 * `concluido` e `cancelado` nao sai transicao nenhuma.
 */
export function podeTentarNovamente(
  tarefa: Pick<TarefaUI, "status" | "tentativas" | "max_tentativas">
): boolean {
  if (TERMINAIS.includes(tarefa.status)) return false;
  return tarefa.tentativas < tarefa.max_tentativas;
}

// ── Formatacao ────────────────────────────────────────────────────────

/** "1h 12min", "3min 20s", "820ms". Sem biblioteca de data. */
export function formatarDuracao(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const min = Math.floor(s / 60);
  if (min < 60) {
    const resto = s % 60;
    return resto === 0 ? `${min}min` : `${min}min ${resto}s`;
  }
  const h = Math.floor(min / 60);
  const restoMin = min % 60;
  return restoMin === 0 ? `${h}h` : `${h}h ${restoMin}min`;
}

/**
 * Data por extenso curta, em pt-BR, com hora. Datas em tabela precisam
 * ser compreensiveis sem decodificacao: "27/08 14:32" e melhor que um
 * ISO cru para quem esta olhando a fila.
 */
export function formatarInstante(iso: string | null): string {
  const ms = instante(iso);
  if (ms === null) return "—";
  const d = new Date(ms);
  const dois = (n: number) => String(n).padStart(2, "0");
  return `${dois(d.getDate())}/${dois(d.getMonth() + 1)} ${dois(d.getHours())}:${dois(d.getMinutes())}`;
}

/**
 * Mensagem de erro apresentavel.
 *
 * Limita a 200 caracteres e colapsa quebras de linha — mensagem de
 * driver traz nome de coluna, de constraint e as vezes valor, e stack
 * inteira numa celula de tabela nao ajuda ninguem. O `erro_tipo` ao lado
 * ja da a categoria; esta e a explicacao curta.
 */
export const LIMITE_MENSAGEM_ERRO = 200;

export function mensagemDeErro(
  tarefa: Pick<TarefaUI, "erro_mensagem">
): string | null {
  if (tarefa.erro_mensagem === null) return null;
  const limpa = tarefa.erro_mensagem.replace(/\s+/g, " ").trim();
  if (limpa.length === 0) return null;
  return limpa.length > LIMITE_MENSAGEM_ERRO
    ? `${limpa.slice(0, LIMITE_MENSAGEM_ERRO)}…`
    : limpa;
}

/** Ordena da mais recente para a mais antiga, por `criado_em`. */
export function maisRecentesPrimeiro(tarefas: readonly TarefaUI[]): TarefaUI[] {
  return [...tarefas].sort((a, b) => (instante(b.criado_em) ?? 0) - (instante(a.criado_em) ?? 0));
}

/**
 * A tarefa "atual" — a que o agente esta fazendo agora.
 *
 * Ordem de interesse, nao ordem do array: `rodando` vence
 * `aguardando_aprovacao`, que vence `pendente`. Um agente com uma tarefa
 * rodando e outra falhada nao esta "falhando"; ele esta trabalhando, e a
 * falha pertence ao historico. Sem essa precedencia, a tarefa exibida
 * dependeria de como o banco devolveu as linhas.
 *
 * `erro` NAO entra: e desfecho, nao trabalho em andamento. Ele aparece
 * na aba Tarefas e colore o estado do agente por outro caminho.
 */
const PRECEDENCIA_ATUAL: readonly StatusTarefaUI[] = [
  "rodando",
  "aguardando_aprovacao",
  "pendente",
];

export function tarefaAtual(tarefas: readonly TarefaUI[]): TarefaUI | null {
  for (const status of PRECEDENCIA_ATUAL) {
    const achada = tarefas.find((t) => t.status === status && t.concluido_em === null);
    if (achada) return achada;
  }
  return null;
}

/** Instante da atividade mais recente do agente, para a Visao Geral. */
export function ultimaAtividade(tarefas: readonly TarefaUI[]): string | null {
  let melhor: string | null = null;
  let melhorMs = -Infinity;
  for (const t of tarefas) {
    for (const candidato of [t.concluido_em, t.iniciado_em, t.criado_em]) {
      const ms = instante(candidato);
      if (ms !== null && ms > melhorMs) {
        melhorMs = ms;
        melhor = candidato;
      }
    }
  }
  return melhor;
}
