/**
 * O ÚNICO ponto de rede da área de IA — SKILL-1D.ui-consumer-C.
 *
 * ── Por que existe um arquivo só para isto ──────────────────────────
 *
 * Até esta frente a área inteira (`lib/ia`, `components/ia`,
 * `app/(app)/ia`) era desenhada sem back-end: cinco suítes provavam que
 * ali não havia rede, banco, ambiente nem segredo. Isso deixou de ser
 * verdade no dia em que a tela passou a ter APIs reais com quem falar —
 * mas continua valendo para tudo o que não seja este módulo.
 *
 * A regra é essa: nenhum componente visual conversa com a API. Eles
 * recebem dados já interpretados. Assim o endereço, o método e o
 * tratamento de status vivem num lugar só, e uma mudança de contrato
 * não precisa ser caçada em cinco telas.
 *
 * ── O que este módulo NÃO faz ───────────────────────────────────────
 *
 * Não tem React, hook nem estado visual. Não conhece o domínio: não
 * importa a camada de agentes do servidor, não diagnostica nada e não
 * abre banco — ele só fala HTTP e lê a resposta. O nome
 * `obterDiagnostico` é deliberado: `diagnosticarAgente` pertence ao
 * servidor, e reaproveitar o nome aqui sugeriria que a tela consegue
 * julgar por conta própria.
 *
 * ── Autenticação ───────────────────────────────────────────────────
 *
 * Nada é enviado. A sessão viaja no cookie same-origin que o navegador
 * já anexa; não há cabeçalho de autorização, não há identificador de
 * quem pergunta no corpo ou na URL, e não há relógio do cliente. Quem
 * decide as três coisas é o servidor.
 *
 * ── Falhar fechado ─────────────────────────────────────────────────
 *
 * Todo retorno é discriminado. "Não consegui carregar" NUNCA vira lista
 * vazia: sessão expirada e falha de leitura têm estados próprios,
 * porque uma tela que mostra "você não tem agentes" quando na verdade
 * não conseguiu perguntar é pior do que uma que assume o erro.
 */
import { TIPOS_AGENTE_UI } from "@/lib/ia/contratos";
import type { AgenteUI, TipoAgenteUI } from "@/lib/ia/contratos";
import type { Diagnostico } from "@/lib/ia/skills/diagnostico";
import type { RequisitoConexao } from "@/lib/ia/skills/contrato";

const ROTA_BASE = "/api/agentes";
const ROTA_SUFIXO_DIAGNOSTICO = "/diagnostico";
const ROTA_SUFIXO_CONVERSA = "/conversa";

/**
 * Um diagnóstico e a identidade de quem foi diagnosticado.
 *
 * `(skillId, versao)` é o par: duas versões da mesma Skill podem estar
 * associadas ao mesmo agente, e a tela precisa distingui-las.
 */
export interface DiagnosticoDeSkillUI {
  skillId: string;
  versao: string;
  diagnostico: Diagnostico;
}

/** Lista de agentes do dono da sessão. */
export type RespostaAgentes =
  | { estado: "ok"; agentes: readonly AgenteUI[] }
  | { estado: "nao_autenticado" }
  | { estado: "falha" };

/**
 * Criação de UM agente.
 *
 * `dados_invalidos` existe separado de `falha` porque as duas pedem
 * coisas diferentes do usuário: uma ele corrige e reenvia, a outra ele
 * só pode tentar de novo. A `mensagem` é sempre uma das frases fixas
 * que o servidor publica — nunca texto desconhecido repassado adiante.
 */
export type RespostaCriacao =
  | { estado: "ok"; agente: AgenteUI }
  | { estado: "dados_invalidos"; mensagem: string }
  | { estado: "nao_autenticado" }
  | { estado: "falha" };

/** Os campos que a tela preenche. Três, e nenhum a mais: dono, id,
 *  `ativo` e datas são autoridade do servidor. */
export interface NovoAgente {
  nome: string;
  tipo: TipoAgenteUI;
  instrucoes: string | null;
}

/**
 * Diagnóstico de UM agente.
 *
 * `semSelecao` chega separado e assim permanece: requisito que existe e
 * ainda não tem loja escolhida não é a mesma coisa que requisito cuja
 * conta não serve, e o servidor já mantém essa distinção.
 */
export type RespostaDiagnostico =
  | {
      estado: "ok";
      diagnosticos: readonly DiagnosticoDeSkillUI[];
      semSelecao: readonly RequisitoConexao[];
      coleta: "ok";
    }
  | { estado: "nao_autenticado" }
  | { estado: "entrada_invalida" }
  | { estado: "falha" };

const ehObjeto = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const ehTipoUI = (v: unknown): v is TipoAgenteUI =>
  typeof v === "string" && (TIPOS_AGENTE_UI as readonly string[]).includes(v);

/**
 * Um agente do corpo da resposta — campo a campo, nunca `as AgenteUI`.
 *
 * A validação existe para que uma resposta com formato inesperado vire
 * FALHA, e não uma lista silenciosamente incompleta. Devolve `null` no
 * primeiro campo que não confere.
 */
function agenteDaResposta(bruto: unknown): AgenteUI | null {
  if (!ehObjeto(bruto)) return null;
  const { id, nome, tipo, instrucoes, ativo, criado_em } = bruto;
  if (typeof id !== "string" || id.length === 0) return null;
  if (typeof nome !== "string") return null;
  if (!ehTipoUI(tipo)) return null;
  if (instrucoes !== null && typeof instrucoes !== "string") return null;
  if (typeof ativo !== "boolean") return null;
  if (typeof criado_em !== "string") return null;
  return { id, nome, tipo, instrucoes, ativo, criado_em };
}

function itemDiagnosticoDaResposta(bruto: unknown): DiagnosticoDeSkillUI | null {
  if (!ehObjeto(bruto)) return null;
  const { skillId, versao, diagnostico } = bruto;
  if (typeof skillId !== "string" || typeof versao !== "string") return null;
  if (!ehObjeto(diagnostico) || typeof diagnostico.estadoGeral !== "string") return null;
  return { skillId, versao, diagnostico: diagnostico as unknown as Diagnostico };
}

/** Corpo lido com tolerância: resposta ilegível não derruba a tela. */
async function corpoDe(resposta: Response): Promise<unknown> {
  try {
    return await resposta.json();
  } catch {
    return null;
  }
}

/**
 * Os agentes do dono da sessão.
 *
 * Uma chamada, sem corpo e sem cabeçalho: o cookie same-origin é toda a
 * credencial, e o servidor filtra pelo dono. A lista traz ativos e
 * inativos — a tela precisa enxergar o desligado para poder religá-lo.
 */
export async function listarAgentes(signal?: AbortSignal): Promise<RespostaAgentes> {
  let resposta: Response;
  try {
    resposta = await fetch(ROTA_BASE, { signal });
  } catch {
    // Inclui o abort: quem cancelou não quer mais a resposta, e um
    // estado de falha é descartado junto com o efeito que o pediu.
    return { estado: "falha" };
  }

  if (resposta.status === 401) return { estado: "nao_autenticado" };

  const corpo = await corpoDe(resposta);
  if (!resposta.ok || !ehObjeto(corpo) || corpo.ok !== true || !Array.isArray(corpo.agentes)) {
    return { estado: "falha" };
  }

  const agentes: AgenteUI[] = [];
  for (const bruto of corpo.agentes) {
    const agente = agenteDaResposta(bruto);
    // Um item malformado condena a resposta inteira: meia lista
    // apresentada como lista completa é o modo de falha que este
    // retorno discriminado existe para impedir.
    if (agente === null) return { estado: "falha" };
    agentes.push(agente);
  }
  return { estado: "ok", agentes };
}

/**
 * As frases de erro que o servidor publica para corpo inválido.
 *
 * A allowlist existe para que a tela nunca mostre texto que não tenha
 * sido escrito aqui: mensagem desconhecida vira a genérica, e uma
 * mudança no servidor não vaza redação nova para o usuário.
 */
const MENSAGENS_DE_DADOS: readonly string[] = [
  "nome inválido.",
  "tipo inválido.",
];
const MENSAGEM_GENERICA = "Não foi possível criar o agente com esses dados.";

/**
 * Cria UM agente para o dono da sessão.
 *
 * ── O que NÃO viaja ─────────────────────────────────────────────────
 *
 * O corpo é montado campo a campo, com três chaves. Nunca
 * `JSON.stringify(formulario)`: um objeto de formulário pode ganhar
 * chave nova sem ninguém notar, e `id`, dono, `ativo` e datas são do
 * servidor. Aqui a proteção não depende do tipo — depende de o objeto
 * ser escrito à mão.
 *
 * ── Por que não há AbortSignal ──────────────────────────────────────
 *
 * Abortar uma escrita no navegador não desfaz o que o servidor gravou.
 * Aceitar um sinal aqui daria à tela a ilusão de cancelamento
 * transacional que o HTTP não tem.
 */
export async function criarAgenteViaApi(dados: NovoAgente): Promise<RespostaCriacao> {
  let resposta: Response;
  try {
    resposta = await fetch(ROTA_BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nome: dados.nome,
        tipo: dados.tipo,
        instrucoes: dados.instrucoes,
      }),
    });
  } catch {
    return { estado: "falha" };
  }

  if (resposta.status === 401) return { estado: "nao_autenticado" };

  const corpo = await corpoDe(resposta);

  if (resposta.status === 400) {
    const bruta = ehObjeto(corpo) && typeof corpo.erro === "string" ? corpo.erro : "";
    return {
      estado: "dados_invalidos",
      mensagem: MENSAGENS_DE_DADOS.includes(bruta) ? bruta : MENSAGEM_GENERICA,
    };
  }

  if (!resposta.ok || !ehObjeto(corpo) || corpo.ok !== true) return { estado: "falha" };

  const agente = agenteDaResposta(corpo.agente);
  // Resposta com formato inesperado e FALHA, nunca um agente meio
  // montado entrando na lista como se fosse real.
  if (agente === null) return { estado: "falha" };

  return { estado: "ok", agente };
}

/**
 * O diagnóstico de UM agente.
 *
 * `agenteId` é o único identificador que trafega, e vai no caminho.
 * Nada de relógio, nada de dono, nada de corpo — o servidor é a
 * autoridade das três coisas.
 */
export async function obterDiagnostico(
  agenteId: string,
  signal?: AbortSignal
): Promise<RespostaDiagnostico> {
  let resposta: Response;
  try {
    resposta = await fetch(
      `${ROTA_BASE}/${encodeURIComponent(agenteId)}${ROTA_SUFIXO_DIAGNOSTICO}`,
      { signal }
    );
  } catch {
    return { estado: "falha" };
  }

  if (resposta.status === 401) return { estado: "nao_autenticado" };
  if (resposta.status === 400) return { estado: "entrada_invalida" };

  const corpo = await corpoDe(resposta);
  if (
    !resposta.ok ||
    !ehObjeto(corpo) ||
    corpo.ok !== true ||
    !Array.isArray(corpo.diagnosticos) ||
    !Array.isArray(corpo.semSelecao)
  ) {
    return { estado: "falha" };
  }

  const diagnosticos: DiagnosticoDeSkillUI[] = [];
  for (const bruto of corpo.diagnosticos) {
    const item = itemDiagnosticoDaResposta(bruto);
    if (item === null) return { estado: "falha" };
    // Sem deduplicar por `skillId`: duas versões da mesma Skill são
    // dois itens, e agrupá-las esconderia justamente a diferença.
    diagnosticos.push(item);
  }

  return {
    estado: "ok",
    diagnosticos,
    semSelecao: corpo.semSelecao as readonly RequisitoConexao[],
    coleta: "ok",
  };
}

// ─── Conversa — AGENT-VERTICAL-SLICE-V1-I3 ────────────────────────────
//
// O que entra aqui: transporte e leitura do CONTRATO publicado no V1-I2,
// mais as funcoes puras que interpretam esse contrato. O que NAO entra:
// `useState`, `useEffect`, temporizador, ciclo de vida de componente ou
// JSX — polling e desmontagem sao assunto do `ChatAgente`, e misturar as
// duas coisas tornaria esta fronteira intestavel sem um DOM.
//
// Este arquivo continua sendo o unico ponto de rede da area de IA, e e
// por isso que a aba Chat fala com a API atraves dele em vez de chamar
// `fetch` por conta propria.

/** Os estados que a tarefa pode assumir, conforme o CHECK do banco. */
export const STATUS_CONVERSA = [
  "pendente",
  "rodando",
  "aguardando_aprovacao",
  "concluido",
  "erro",
  "cancelado",
] as const;

export type StatusConversa = (typeof STATUS_CONVERSA)[number];

/** O modo de IA que a API reporta — configuracao do instante, jamais
 *  proveniencia da execucao. O nome do campo na API diz isso, e o tipo
 *  aqui nao acrescenta nenhuma promessa. */
export type ModoIa = "fake" | "real";

/**
 * O marcador que o adaptador fake carimba na propria resposta.
 *
 * Serve como SEGUNDA evidencia visual. A autoridade sobre o modo continua
 * sendo o campo que a API devolve — texto de resposta e conteudo, nao
 * configuracao.
 */
export const MARCADOR_FAKE = "[fake]";

export interface TarefaConversaUI {
  id: string;
  status: StatusConversa;
  resposta: string | null;
  erroTipo: string | null;
}

export type RespostaEnvioConversa =
  | { estado: "ok"; tarefaId: string; status: StatusConversa; modo: ModoIa }
  | { estado: "nao_autenticado" }
  | { estado: "nao_encontrado" }
  | { estado: "agente_inativo" }
  | { estado: "entrada_invalida" }
  | { estado: "falha" };

export type RespostaConsultaConversa =
  | { estado: "ok"; tarefa: TarefaConversaUI; modo: ModoIa }
  | { estado: "nao_autenticado" }
  | { estado: "nao_encontrado" }
  | { estado: "entrada_invalida" }
  | { estado: "falha" };

const ehModo = (v: unknown): v is ModoIa => v === "fake" || v === "real";

/** Status vindo da API, validado contra o vocabulario conhecido. Um valor
 *  fora da lista NAO e convertido para nada: quem chama decide o que
 *  fazer, e a UI para em vez de supor sucesso. */
export function ehStatusConhecido(bruto: unknown): bruto is StatusConversa {
  return typeof bruto === "string" && (STATUS_CONVERSA as readonly string[]).includes(bruto);
}

/**
 * Terminal significa: nao adianta perguntar de novo.
 *
 * `aguardando_aprovacao` entra como TERMINAL de propósito. Conversa V1
 * nao usa Funcoes e nao deveria produzir esse estado; se produzir, ficar
 * perguntando para sempre seria o pior desfecho — a UI para e mostra o
 * que viu.
 */
export function ehStatusTerminal(status: StatusConversa): boolean {
  return status !== "pendente" && status !== "rodando";
}

/**
 * As condicoes OPERACIONAIS do piloto com IA real.
 *
 * Isto NAO e proveniencia: nada persiste com que provedor a tarefa foi
 * atendida. O que esta funcao afirma e mais modesto e verificavel — a
 * configuracao estava em `real` no envio, continuava em `real` na ultima
 * consulta, a tarefa concluiu e a resposta nao carrega o marcador do
 * fake. Sob flag estavel, isso basta para o primeiro teste manual,
 * porque o provedor real falha fechado: com ele ligado, erro do provedor
 * derruba a tarefa em vez de cair para o fake.
 */
export function condicoesIaRealAtendidas(entrada: {
  status: StatusConversa;
  modoNoEnvio: ModoIa | null;
  modoAtual: ModoIa | null;
  resposta: string | null;
}): boolean {
  if (entrada.status !== "concluido") return false;
  if (entrada.modoNoEnvio !== "real" || entrada.modoAtual !== "real") return false;
  if (entrada.modoNoEnvio !== entrada.modoAtual) return false;
  if (typeof entrada.resposta !== "string") return false;
  return !entrada.resposta.includes(MARCADOR_FAKE);
}

function tarefaDaResposta(bruto: unknown): TarefaConversaUI | null {
  if (!ehObjeto(bruto)) return null;
  const { id, status, resposta, erroTipo } = bruto;
  if (typeof id !== "string" || id.length === 0) return null;
  if (!ehStatusConhecido(status)) return null;
  if (resposta !== null && typeof resposta !== "string") return null;
  if (erroTipo !== null && typeof erroTipo !== "string") return null;
  return { id, status, resposta, erroTipo };
}

const caminhoDaConversa = (agenteId: string) =>
  `${ROTA_BASE}/${encodeURIComponent(agenteId)}${ROTA_SUFIXO_CONVERSA}`;

/**
 * Cria UMA tarefa de conversa. O corpo leva SOMENTE a mensagem: dono,
 * agente, tipo, provedor e tentativas sao decididos pelo servidor, e a
 * API recusa qualquer chave a mais.
 */
export async function enviarMensagemAoAgente(
  agenteId: string,
  mensagem: string,
  signal?: AbortSignal
): Promise<RespostaEnvioConversa> {
  let resposta: Response;
  try {
    resposta = await fetch(caminhoDaConversa(agenteId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mensagem }),
      signal,
    });
  } catch {
    return { estado: "falha" };
  }

  if (resposta.status === 401) return { estado: "nao_autenticado" };
  if (resposta.status === 404) return { estado: "nao_encontrado" };
  if (resposta.status === 409) return { estado: "agente_inativo" };
  if (resposta.status === 400) return { estado: "entrada_invalida" };

  const corpo = await corpoDe(resposta);
  if (!resposta.ok || !ehObjeto(corpo) || corpo.ok !== true) return { estado: "falha" };
  // Shape divergente e FALHA, nunca uma tarefa meio montada entrando no
  // acompanhamento com um id que talvez nao exista.
  if (typeof corpo.tarefaId !== "string" || corpo.tarefaId.length === 0) return { estado: "falha" };
  if (!ehStatusConhecido(corpo.status)) return { estado: "falha" };
  if (!ehModo(corpo.modoIaConfiguradoAgora)) return { estado: "falha" };

  return {
    estado: "ok",
    tarefaId: corpo.tarefaId,
    status: corpo.status,
    modo: corpo.modoIaConfiguradoAgora,
  };
}

/** Consulta UMA tarefa de conversa. Leitura pura: nao cria nada, nao
 *  reexecuta e nao aciona o worker. */
export async function consultarConversaDoAgente(
  agenteId: string,
  tarefaId: string,
  signal?: AbortSignal
): Promise<RespostaConsultaConversa> {
  const consulta = new URLSearchParams({ tarefaId });
  let resposta: Response;
  try {
    resposta = await fetch(`${caminhoDaConversa(agenteId)}?${consulta.toString()}`, { signal });
  } catch {
    return { estado: "falha" };
  }

  if (resposta.status === 401) return { estado: "nao_autenticado" };
  if (resposta.status === 404) return { estado: "nao_encontrado" };
  if (resposta.status === 400) return { estado: "entrada_invalida" };

  const corpo = await corpoDe(resposta);
  if (!resposta.ok || !ehObjeto(corpo) || corpo.ok !== true) return { estado: "falha" };
  if (!ehModo(corpo.modoIaConfiguradoAgora)) return { estado: "falha" };

  const tarefa = tarefaDaResposta(corpo.tarefa);
  if (tarefa === null) return { estado: "falha" };

  return { estado: "ok", tarefa, modo: corpo.modoIaConfiguradoAgora };
}
