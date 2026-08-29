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
