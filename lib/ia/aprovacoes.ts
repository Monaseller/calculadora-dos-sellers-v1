/**
 * CDS IA — contrato visual de uma solicitacao de aprovacao.
 *
 * ── A separacao que este arquivo existe para impor ──────────────────
 *
 *   ACAO CANONICA  capability + argumentos ja validados  ← o que executa
 *   MOTIVO         "ACOS atingiu 7,8%"                   ← justificativa
 *   RISCO          classificacao                         ← contexto
 *   CONEXAO        conta onde o efeito acontece          ← escopo
 *
 * Sao quatro coisas, e a tela nao pode fundi-las numa frase. O usuario
 * aprova a ACAO; o texto do modelo e contexto para decidir. Se o botao
 * autorizasse "o que esta escrito", quem escolheria o proprio escopo
 * seria o modelo — exatamente o que "IA nao e autoridade" proibe.
 *
 * ── Por que nao existe campo para payload bruto ─────────────────────
 *
 * `AcaoCanonica.argumentos` e uma lista de pares JA legiveis. Nao ha
 * campo `entrada`, `payload` nem `args: Record<string, unknown>` neste
 * contrato — a allowlist e aplicada na ORIGEM, e o que chega a tela ja
 * passou por ela. Um campo cru aqui seria renderizado por alguem, algum
 * dia, "so para depurar".
 *
 * ── O que este arquivo NAO e ────────────────────────────────────────
 *
 * Nao e schema, nao ha tabela de aprovacoes, nao ha decisao registrada.
 * Sao tipos de apresentacao e funcoes puras. Nada aqui aprova nada.
 */
import type { EstadoConexao, NivelAutonomia, Procedencia, Risco } from "@/lib/ia/conceitos";

// ── A acao proposta ───────────────────────────────────────────────────

/** Um argumento ja sanitizado: rotulo humano + valor legivel. */
export interface ArgumentoExibivel {
  rotulo: string;
  valor: string;
}

export interface AcaoCanonica {
  /** Identificador tecnico, exibido discreto: `ads.campanha.pausar`. */
  capabilityId: string;
  /** O que o usuario le: "Pausar campanha". */
  rotulo: string;
  acesso: "leitura" | "escrita";
  /**
   * `true` quando desfazer nao e trivial. NAO e o mesmo que risco alto:
   * risco mede o tamanho do estrago; irreversivel mede se da para voltar.
   * Os dois juntos e que decidem a confirmacao secundaria — ver
   * `exigeConfirmacao`.
   */
  irreversivel: boolean;
  argumentos: readonly ArgumentoExibivel[];
}

// ── A conexao onde o efeito acontece ──────────────────────────────────

/**
 * Sem `seller_id`, `shop_id`, `partner_id` ou credencial — o contrato
 * nao tem esses campos, entao nao ha o que esconder na renderizacao.
 * `null` quando a acao nao depende de conta externa.
 */
export interface ConexaoDaAprovacao {
  rotulo: string;
  conta: string;
  estado: EstadoConexao;
}

// ── A solicitacao ─────────────────────────────────────────────────────

export interface AprovacaoUI {
  id: string;
  agenteId: string;
  agenteNome: string;
  /** Id da tarefa que ficou parada. No modelo real, uma aprovacao E uma
   *  tarefa em `aguardando_aprovacao` — nunca um segundo estado paralelo. */
  tarefaId: string;
  acao: AcaoCanonica;
  /** Justificativa do agente. Contexto, NUNCA autoridade. */
  motivo: string;
  /** Efeito esperado, em uma frase. Ajuda a decidir; nao autoriza. */
  impacto: string;
  risco: Risco;
  conexao: ConexaoDaAprovacao | null;
  solicitadaEm: string;
  /** Sempre `aprovacao`: e a configuracao que trouxe a tarefa ate aqui. */
  nivelExigido: NivelAutonomia;
  procedencia: Procedencia;
}

// ── Elegibilidade ─────────────────────────────────────────────────────

/**
 * O fluxo de decisao ainda nao existe: nao ha tabela de aprovacoes, nem
 * transicao que retome a tarefa, nem registro de quem decidiu.
 *
 * Esta constante e a fonte UNICA desse fato para a interface. Quando o
 * backend existir, ela vira `true` num lugar so — e nao ha um segundo
 * lugar dizendo o contrario.
 */
export const FLUXO_APROVACAO_CONECTADO = false;

export const MOTIVOS_INELEGIVEL = ["fluxo_nao_conectado", "conexao_invalida"] as const;
export type MotivoInelegivel = (typeof MOTIVOS_INELEGIVEL)[number];

export const EXPLICACAO_INELEGIVEL: Record<MotivoInelegivel, string> = {
  fluxo_nao_conectado:
    "Disponível quando o fluxo de aprovação estiver conectado. Aprovar e recusar ainda não registram decisão em lugar nenhum.",
  conexao_invalida:
    "Reconecte a conta antes de aprovar esta ação — a autorização da conexão não está válida.",
};

/** Conexao em qualquer estado que nao seja `conectada` impede o efeito. */
export function conexaoValida(conexao: ConexaoDaAprovacao | null): boolean {
  if (conexao === null) return true; // acao que nao depende de conta externa
  return conexao.estado === "conectada";
}

export interface Elegibilidade {
  /** `true` só quando NENHUM motivo impede. Hoje nunca é `true`. */
  podeDecidir: boolean;
  motivos: readonly MotivoInelegivel[];
}

/**
 * Acumula TODOS os motivos, em vez de devolver o primeiro.
 *
 * Uma solicitacao pode estar bloqueada por duas razoes ao mesmo tempo, e
 * mostrar so uma faria o usuario reconectar a conta para descobrir que
 * ainda assim nao da para aprovar. Dizer as duas de uma vez custa o
 * mesmo e evita a segunda frustracao.
 */
export function elegibilidade(aprovacao: Pick<AprovacaoUI, "conexao">): Elegibilidade {
  const motivos: MotivoInelegivel[] = [];
  if (!FLUXO_APROVACAO_CONECTADO) motivos.push("fluxo_nao_conectado");
  if (!conexaoValida(aprovacao.conexao)) motivos.push("conexao_invalida");
  return { podeDecidir: motivos.length === 0, motivos };
}

/**
 * Preparado, nao usado: enquanto Aprovar estiver desabilitado, nao ha o
 * que confirmar. Existe aqui para que a regra ja esteja escrita — risco
 * alto OU efeito irreversivel — em vez de ser inventada as pressas
 * quando os botoes forem ligados. Confirmar TUDO ensinaria o usuario a
 * confirmar sem ler.
 */
export function exigeConfirmacao(aprovacao: Pick<AprovacaoUI, "risco" | "acao">): boolean {
  return aprovacao.risco === "alto" || aprovacao.acao.irreversivel;
}

// ── Tempo ─────────────────────────────────────────────────────────────

/**
 * "há 2 min", "há 3 h", "há 2 d". Sem biblioteca de data.
 *
 * Futuro ou data invalida devolvem "—", nunca "há -5 min": relogio do
 * cliente adiantado e coisa banal, e um numero negativo na fila parece
 * defeito do sistema.
 */
export function desdeQuando(iso: string, agoraMs: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const ms = agoraMs - t;
  if (ms < 0) return "—";
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "agora há pouco";
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h} h`;
  return `há ${Math.floor(h / 24)} d`;
}

/** Mais antigas primeiro: quem espera ha mais tempo aparece no topo. */
export function maisAntigasPrimeiro(aprovacoes: readonly AprovacaoUI[]): AprovacaoUI[] {
  return [...aprovacoes].sort(
    (a, b) => (Date.parse(a.solicitadaEm) || 0) - (Date.parse(b.solicitadaEm) || 0)
  );
}
