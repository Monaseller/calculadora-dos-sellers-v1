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

// ══ A fila REAL (APPROVAL-UI-API-A2) ══════════════════════════════════
//
// Tudo acima descreve a era do mock e continua servindo `Timeline`, o
// Escritorio e o que mais ainda simula. O que vem abaixo e outra coisa:
// e o contrato que `GET /api/aprovacoes` publica de verdade, e ele e
// MENOR.
//
// A diferenca nao e detalhe. `AprovacaoUI` tem `motivo`, `impacto`,
// `risco`, `procedencia`, `acao.rotulo` e `acao.irreversivel`; a
// infraestrutura real nao tem nenhum dos seis, e nao ha de onde
// deriva-los. Reaproveitar aquele tipo obrigaria a preencher esses
// campos com algo — e "algo" numa tela de autorizacao e exatamente o que
// nao pode existir. Por isso sao dois tipos, e nao um flexibilizado.

/** O requisito de conexao de uma Approval real. Dois rotulos, e so.
 *  Sem conta, sem id de loja, sem estado — o contrato nao os tem. */
export interface ConexaoDaAprovacaoReal {
  plataforma: string;
  recurso: string;
}

/**
 * Uma Approval pendente como o servidor a entrega.
 *
 * Os doze campos do contrato A1, nem um a mais. `estado` e sempre
 * `"pendente"` — a rota so devolve pendentes ainda validas —, mas vem
 * no tipo porque e o contrato, e omiti-lo obrigaria quem le a supor.
 */
export interface AprovacaoRealUI {
  id: string;
  agenteId: string;
  agenteNome: string;
  tarefaId: string | null;
  funcaoId: string;
  revisaoFuncao: string;
  acesso: string;
  estado: string;
  criadoEm: string;
  expiraEm: string;
  argumentos: Record<string, unknown>;
  conexao: ConexaoDaAprovacaoReal | null;
}

// ── Rotulo da Funcao ──────────────────────────────────────────────────

/**
 * Nome humano por Funcao conhecida.
 *
 * Mapa fechado de propósito: Funcao nova aparece pelo proprio id ate
 * alguem escrever o rotulo dela. Um gerador automatico — trocar ponto
 * por espaco, capitalizar — produziria "Vendas Consultar" e coisas
 * piores, com cara de texto revisado.
 */
const ROTULO_FUNCAO: Readonly<Record<string, string>> = {
  "vendas.consultar": "Consultar vendas",
};

/** O rotulo, ou o proprio id quando nao ha rotulo. Nunca uma descricao
 *  inventada a partir do id. */
export function rotuloDaFuncao(funcaoId: string): string {
  return ROTULO_FUNCAO[funcaoId] ?? funcaoId;
}

// ── Argumentos, por Funcao ────────────────────────────────────────────

/**
 * Um par rotulo/valor ja pronto para a tela. Mesmo formato do
 * `ArgumentoExibivel` da era mock, mas produzido por um renderer
 * NOMINAL por Funcao — nunca por varredura de chaves.
 */
export interface DetalheArgumento {
  rotulo: string;
  valor: string;
}

/**
 * `null` significa "nao sei mostrar isto com honestidade".
 *
 * Tres caminhos levam a `null`, e todos sao desejaveis: Funcao sem
 * renderer; argumentos com forma inesperada; valor fora do vocabulario.
 * Em nenhum deles a tela cai para JSON cru — despejar o objeto seria
 * transformar a falta de um renderer em vazamento de forma interna, e
 * quem decide nao teria como distinguir o que e dado do que e estrutura.
 */
export type DetalhesDaSolicitacao = readonly DetalheArgumento[] | null;

/**
 * `2026-09-12` -> `12/09/2026`, por CORTE de string.
 *
 * Nada de `new Date("2026-09-12")`: essa forma e interpretada como UTC
 * meia-noite e, em qualquer fuso a oeste de Greenwich — o Brasil
 * inteiro —, `getDate()` devolve o dia ANTERIOR. O periodo consultado
 * apareceria deslocado em um dia na tela de autorizacao.
 */
export function dataCivil(iso: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (m === null) return null;
  const [, ano, mes, dia] = m;
  const nMes = Number(mes);
  const nDia = Number(dia);
  if (nMes < 1 || nMes > 12 || nDia < 1 || nDia > 31) return null;
  return `${dia}/${mes}/${ano}`;
}

/** O vocabulario real de marketplace de `vendas.consultar`. Ausente e
 *  `null` significam "Todos"; qualquer outro valor NAO e traduzido. */
const ROTULO_MARKETPLACE: Readonly<Record<string, string>> = {
  Shopee: "Shopee",
  ML: "Mercado Livre",
};

export function rotuloDeMarketplace(bruto: unknown): string | null {
  if (bruto === undefined || bruto === null) return "Todos";
  if (typeof bruto !== "string") return null;
  return ROTULO_MARKETPLACE[bruto] ?? null;
}

/**
 * Os detalhes de `vendas.consultar`: periodo e marketplace.
 *
 * Allowlist de TRES campos. Um quarto campo que a Funcao passe a aceitar
 * nao aparece aqui sozinho — e isso e a propriedade, nao uma limitacao.
 */
function detalhesDeConsultarVendas(argumentos: Record<string, unknown>): DetalhesDaSolicitacao {
  const inicio = argumentos.dataInicio;
  const fim = argumentos.dataFim;
  if (typeof inicio !== "string" || typeof fim !== "string") return null;

  const de = dataCivil(inicio);
  const ate = dataCivil(fim);
  if (de === null || ate === null) return null;

  const marketplace = rotuloDeMarketplace(argumentos.marketplace);
  if (marketplace === null) return null;

  return [
    { rotulo: "Período", valor: `${de} a ${ate}` },
    { rotulo: "Marketplace", valor: marketplace },
  ];
}

/** O registro de renderers. Fechado: Funcao ausente daqui devolve
 *  `null`, e a tela diz que nao sabe mostrar. */
const RENDERERS: Readonly<
  Record<string, (a: Record<string, unknown>) => DetalhesDaSolicitacao>
> = {
  "vendas.consultar": detalhesDeConsultarVendas,
};

export function detalhesDaSolicitacao(aprovacao: AprovacaoRealUI): DetalhesDaSolicitacao {
  const renderer = RENDERERS[aprovacao.funcaoId];
  if (renderer === undefined) return null;
  return renderer(aprovacao.argumentos);
}

/** Texto unico para os tres casos de "nao da para mostrar". Um so,
 *  porque distinguir "Funcao desconhecida" de "argumento estranho" na
 *  tela nao ajuda quem decide e descreve o nosso codigo, nao o pedido. */
export const SEM_DETALHES = "Detalhes da solicitação indisponíveis para esta função.";

// ── Expiracao ─────────────────────────────────────────────────────────

/**
 * A API so devolve Approval ainda valida NO INSTANTE do GET. Uma aba
 * aberta por horas continua exibindo o que era verdade quando carregou.
 *
 * Isto NAO escreve nada e nao pede nada ao servidor: apenas compara, e a
 * tela para de apresentar a linha como decidivel. Fingir validade
 * enquanto o relogio passou seria oferecer uma decisao que o banco ja
 * recusaria.
 */
export function expirouLocalmente(aprovacao: Pick<AprovacaoRealUI, "expiraEm">, agoraMs: number): boolean {
  const t = Date.parse(aprovacao.expiraEm);
  if (Number.isNaN(t)) return false;
  return agoraMs >= t;
}
