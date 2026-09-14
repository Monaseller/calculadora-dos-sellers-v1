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
// O vocabulário canônico dos três níveis. Importado, nunca recopiado:
// uma segunda lista aqui envelheceria em relação à original no dia em
// que um quarto nível entrasse.
import { NIVEIS_AUTONOMIA } from "@/lib/ia/conceitos";
import type { NivelAutonomia } from "@/lib/ia/conceitos";
import type { Diagnostico } from "@/lib/ia/skills/diagnostico";
import type { RequisitoConexao } from "@/lib/ia/skills/contrato";

const ROTA_BASE = "/api/agentes";
const ROTA_SUFIXO_DIAGNOSTICO = "/diagnostico";
const ROTA_SUFIXO_CONVERSA = "/conversa";
const ROTA_SUFIXO_CONSULTAR_VENDAS = "/consultar-vendas";

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
 * Edição de UM agente — EDITAR-AGENTE-V1.
 *
 * Mesma forma discriminada da criação, e pelo mesmo motivo: o usuário
 * corrige `dados_invalidos` e reenvia; `falha` ele só pode tentar de
 * novo. `nao_encontrado` é próprio porque pede uma terceira coisa —
 * voltar para a lista.
 */
export type RespostaEdicao =
  | { estado: "ok"; agente: AgenteUI }
  | { estado: "dados_invalidos"; mensagem: string }
  | { estado: "nao_autenticado" }
  | { estado: "nao_encontrado" }
  | { estado: "falha" };

/**
 * O que a tela pode alterar. DOIS campos, ambos opcionais.
 *
 * `tipo` não está aqui e `ativo` também não: o primeiro é escolha de
 * partida que a edição não revisita, e desligar um agente para a fila
 * de tarefas dele — é decisão com consequência própria, não um campo de
 * formulário. `id`, dono e datas são do servidor.
 *
 * `instrucoes: null` é pedido explícito de limpar as instruções.
 */
export interface AlteracaoAgente {
  nome?: string;
  instrucoes?: string | null;
}

/**
 * A permissão de UMA Function, como a tela a recebe.
 *
 * `nivel: null` é **ausência de linha**, e continua sendo `null` até a
 * tela — nunca `"bloqueado"`. As duas coisas negam, mas o servidor as
 * separa de propósito ("o dono nunca configurou" contra "o dono
 * proibiu"), e colapsá-las aqui apagaria a intenção dele na única tela
 * onde ela aparece.
 *
 * O catálogo é do servidor: esta interface descreve o que chega, e não
 * uma lista de Functions que a UI conheça por conta própria.
 */
export interface PermissaoDeFuncaoUI {
  id: string;
  acesso: "leitura" | "escrita";
  idempotente: boolean;
  conexaoNecessaria: { plataforma: string; recurso: string } | null;
  nivel: NivelAutonomia | null;
}

/** As permissões de um agente — uma entrada por Function registrada. */
export type RespostaPermissoes =
  | { estado: "ok"; permissoes: readonly PermissaoDeFuncaoUI[] }
  | { estado: "nao_autenticado" }
  | { estado: "nao_encontrado" }
  | { estado: "falha" };

/**
 * Definição do nível de UMA Function.
 *
 * `dados_invalidos` existe separado de `falha` pelo mesmo motivo da
 * criação e da edição: uma o usuário corrige, a outra ele só pode
 * tentar de novo.
 */
export type RespostaDefinicaoPermissao =
  | { estado: "ok"; funcaoId: string; nivel: NivelAutonomia }
  | { estado: "dados_invalidos"; mensagem: string }
  | { estado: "nao_autenticado" }
  | { estado: "nao_encontrado" }
  | { estado: "falha" };

/** O que a tela pode definir. Dois campos, e o servidor recusa qualquer
 *  chave a mais — inclusive `user_id`, `agente_id` e `revisao`. */
export interface DefinicaoDePermissao {
  funcaoId: string;
  nivel: NivelAutonomia;
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
 * As frases que o servidor publica e que o usuário consegue AGIR sobre.
 *
 * Só `nome inválido.` entra: é o único 400 da edição que se corrige
 * digitando de novo. `Alteração inválida.` e `Corpo da requisição
 * inválido` descrevem um cliente mandando o que não devia — mostrá-las
 * pediria ao usuário que consertasse um defeito nosso.
 */
const MENSAGENS_DE_EDICAO: readonly string[] = ["nome inválido."];
const MENSAGEM_GENERICA_EDICAO = "Não foi possível salvar essas alterações.";

/**
 * Altera UM agente do dono da sessão — EDITAR-AGENTE-V1.
 *
 * ── O único PATCH da área ───────────────────────────────────────────
 *
 * A área deixou de só criar. A abertura é estreita de propósito: um
 * recurso, dois campos, um verbo. PUT e DELETE continuam sem função
 * aqui — substituir o recurso inteiro reabriria por omissão os campos
 * que este corpo fecha.
 *
 * ── O que NÃO viaja ─────────────────────────────────────────────────
 *
 * O corpo é montado chave a chave, e só entra o que veio pedido.
 * Nunca `JSON.stringify(formulario)`: `ativo`, `tipo`, `id`, dono e
 * datas não têm por onde chegar ao servidor, e a proteção não depende
 * do tipo — depende de o objeto ser escrito à mão.
 *
 * ── Por que não há AbortSignal ──────────────────────────────────────
 *
 * Mesma razão da criação: abortar uma escrita no navegador não desfaz
 * o que o servidor gravou.
 */
export async function atualizarAgenteViaApi(
  agenteId: string,
  alteracao: AlteracaoAgente
): Promise<RespostaEdicao> {
  // CHAVE A CHAVE. Campo ausente no pedido fica ausente no corpo — não
  // vira `undefined` serializado nem `null` acidental.
  const corpoEnviado: { nome?: string; instrucoes?: string | null } = {};
  if (alteracao.nome !== undefined) corpoEnviado.nome = alteracao.nome;
  if (alteracao.instrucoes !== undefined) corpoEnviado.instrucoes = alteracao.instrucoes;

  let resposta: Response;
  try {
    resposta = await fetch(`${ROTA_BASE}/${encodeURIComponent(agenteId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(corpoEnviado),
    });
  } catch {
    return { estado: "falha" };
  }

  if (resposta.status === 401) return { estado: "nao_autenticado" };
  if (resposta.status === 404) return { estado: "nao_encontrado" };

  const corpo = await corpoDe(resposta);

  if (resposta.status === 400) {
    const bruta = ehObjeto(corpo) && typeof corpo.erro === "string" ? corpo.erro : "";
    return {
      estado: "dados_invalidos",
      mensagem: MENSAGENS_DE_EDICAO.includes(bruta) ? bruta : MENSAGEM_GENERICA_EDICAO,
    };
  }

  if (!resposta.ok || !ehObjeto(corpo) || corpo.ok !== true) return { estado: "falha" };

  const agente = agenteDaResposta(corpo.agente);
  // Resposta com formato inesperado é FALHA. A tela precisa da linha
  // PERSISTIDA para se atualizar; sem ela, exibir o que foi digitado
  // seria afirmar uma gravação que não foi confirmada.
  if (agente === null) return { estado: "falha" };

  return { estado: "ok", agente };
}

/**
 * O sufixo vai INLINE, e não numa constante como os dois vizinhos.
 *
 * Não é inconsistência por descuido: uma sonda das suítes da área caça
 * declarações `const *_AGENTES|_TAREFAS|_CONEXOES|_FUNCOES|_PERMISSOES`
 * fora de `lib/ia/mocks/`, porque é assim que um catálogo simulado
 * costuma se chamar. Um sufixo de rota não é dado falso, mas a sonda não
 * tem como distinguir — e afrouxá-la para acomodar uma string de URL
 * seria pagar com cobertura real. Quem for "restaurar a consistência"
 * aqui vai reprovar K1/J9.
 */
const caminhoDasPermissoes = (agenteId: string) =>
  `${ROTA_BASE}/${encodeURIComponent(agenteId)}/permissoes`;

const ehNivel = (v: unknown): v is NivelAutonomia =>
  typeof v === "string" && (NIVEIS_AUTONOMIA as readonly string[]).includes(v);

/**
 * Uma permissão do corpo da resposta — campo a campo, nunca `as`.
 *
 * `nivel` distingue três coisas que um validador frouxo confundiria:
 * `null` (ausência legítima), um dos três níveis conhecidos, e qualquer
 * outra coisa — que é resposta fora do contrato e vira `null` de
 * retorno, condenando a lista inteira.
 */
function permissaoDaResposta(bruto: unknown): PermissaoDeFuncaoUI | null {
  if (!ehObjeto(bruto)) return null;
  const { id, acesso, idempotente, conexaoNecessaria, nivel } = bruto;
  if (typeof id !== "string" || id.length === 0) return null;
  if (acesso !== "leitura" && acesso !== "escrita") return null;
  if (typeof idempotente !== "boolean") return null;
  if (nivel !== null && !ehNivel(nivel)) return null;

  let conexao: { plataforma: string; recurso: string } | null = null;
  if (conexaoNecessaria !== null) {
    if (!ehObjeto(conexaoNecessaria)) return null;
    const { plataforma, recurso } = conexaoNecessaria;
    if (typeof plataforma !== "string" || typeof recurso !== "string") return null;
    conexao = { plataforma, recurso };
  }

  return { id, acesso, idempotente, conexaoNecessaria: conexao, nivel };
}

/**
 * As permissões de Function de UM agente.
 *
 * Leitura pura: não define nada, não cria linha e não executa Function
 * nenhuma. `agenteId` é o único identificador que trafega, e vai no
 * caminho.
 *
 * A lista inteira vem do servidor, que a deriva do registry real — a
 * tela não conhece Function alguma por conta própria, e uma Function
 * nova aparece aqui sem que este arquivo mude.
 */
export async function listarPermissoesDoAgente(
  agenteId: string,
  signal?: AbortSignal
): Promise<RespostaPermissoes> {
  let resposta: Response;
  try {
    resposta = await fetch(caminhoDasPermissoes(agenteId), { signal });
  } catch {
    // Inclui o abort: quem cancelou não quer mais a resposta.
    return { estado: "falha" };
  }

  if (resposta.status === 401) return { estado: "nao_autenticado" };
  if (resposta.status === 404) return { estado: "nao_encontrado" };

  const corpo = await corpoDe(resposta);
  if (!resposta.ok || !ehObjeto(corpo) || corpo.ok !== true || !Array.isArray(corpo.permissoes)) {
    return { estado: "falha" };
  }

  const permissoes: PermissaoDeFuncaoUI[] = [];
  for (const bruto of corpo.permissoes) {
    const permissao = permissaoDaResposta(bruto);
    // Um item malformado condena a resposta inteira: meia lista
    // apresentada como lista completa é exatamente o modo de falha que
    // este retorno discriminado existe para impedir — e aqui ela diria
    // ao dono que uma Function não existe quando ela existe.
    if (permissao === null) return { estado: "falha" };
    permissoes.push(permissao);
  }
  return { estado: "ok", permissoes };
}

/**
 * As frases que o servidor publica e sobre as quais o usuário consegue AGIR.
 *
 * Nenhuma, hoje: os 400 desta rota — `função inválida.`, `nível
 * inválido.`, `Definição inválida.` — descrevem um cliente mandando o
 * que não devia, e a tela só oferece os três níveis válidos e os ids que
 * o próprio servidor listou. Se um deles aparecer, o defeito é nosso.
 * A lista existe vazia, e não ausente, para que publicar uma frase
 * acionável no futuro seja acrescentar um item, não reescrever o ramo.
 */
const MENSAGENS_DE_PERMISSAO: readonly string[] = [];
const MENSAGEM_GENERICA_PERMISSAO = "Não foi possível salvar este nível.";

/**
 * Define o nível de autonomia de UMA Function do agente.
 *
 * ── O que NÃO viaja ─────────────────────────────────────────────────
 *
 * O corpo é montado chave a chave, com duas chaves. Nunca
 * `JSON.stringify(selecao)`: `user_id`, `agente_id` e `revisao` não têm
 * por onde chegar ao servidor — e a rota os recusa de qualquer forma,
 * o que faz desta camada uma segunda barreira, não a única.
 *
 * ── Por que não há AbortSignal ──────────────────────────────────────
 *
 * Mesma razão da criação e da edição: abortar uma escrita no navegador
 * não desfaz o que o servidor gravou.
 *
 * ── O nível confirmado é o do SERVIDOR ──────────────────────────────
 *
 * O retorno traz `funcaoId` e `nivel` lidos da resposta, não ecoados do
 * argumento. A tela precisa disso para atualizar o que está PERSISTIDO
 * sem afirmar uma gravação que não foi confirmada.
 */
export async function definirPermissaoDeFuncao(
  agenteId: string,
  definicao: DefinicaoDePermissao
): Promise<RespostaDefinicaoPermissao> {
  let resposta: Response;
  try {
    resposta = await fetch(caminhoDasPermissoes(agenteId), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ funcaoId: definicao.funcaoId, nivel: definicao.nivel }),
    });
  } catch {
    return { estado: "falha" };
  }

  if (resposta.status === 401) return { estado: "nao_autenticado" };
  if (resposta.status === 404) return { estado: "nao_encontrado" };

  const corpo = await corpoDe(resposta);

  if (resposta.status === 400) {
    const bruta = ehObjeto(corpo) && typeof corpo.erro === "string" ? corpo.erro : "";
    return {
      estado: "dados_invalidos",
      mensagem: MENSAGENS_DE_PERMISSAO.includes(bruta) ? bruta : MENSAGEM_GENERICA_PERMISSAO,
    };
  }

  if (!resposta.ok || !ehObjeto(corpo) || corpo.ok !== true) return { estado: "falha" };

  const permissao = corpo.permissao;
  if (!ehObjeto(permissao)) return { estado: "falha" };
  const { funcaoId, nivel } = permissao;
  // Shape divergente e FALHA, nunca um nivel meio confirmado entrando na
  // tela como se tivesse sido gravado.
  if (typeof funcaoId !== "string" || funcaoId.length === 0) return { estado: "falha" };
  if (!ehNivel(nivel)) return { estado: "falha" };

  return { estado: "ok", funcaoId, nivel };
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


// ─── Consulta de vendas — FUNCTION-RUNTIME-V1-B2B ─────────────────────
//
// O par abaixo espelha `enviarMensagemAoAgente`/`consultarConversaDoAgente`
// de proposito: e o mesmo formato de trabalho — POST cria a tarefa e
// devolve 202, GET acompanha ate um estado terminal. O que muda e a
// Funcao por tras, e ela e FIXA no servidor.
//
// Nao ha `funcaoId` em lugar nenhum daqui. Um transporte que aceitasse o
// identificador da Funcao pelo chamador transformaria a escolha do que
// executar em entrada da UI — e a autorizacao dessa escolha vive em
// `executarFuncao`, no runtime, nao no browser.

/** O periodo pedido, como a tarefa o registrou. */
export interface PeriodoConsultaVendas {
  dataInicio: string;
  dataFim: string;
  marketplace: string | null;
}

/**
 * O total do periodo. SEIS campos.
 *
 * ── Por que este tipo e o do balde sao DIFERENTES ───────────────────
 *
 * Porque o handler os publica diferentes: `ResumoConsultarVendas` tem
 * seis campos e `BucketMarketplace` tem quatro. Ticket medio e SKUs
 * distintos existem SO no total — dividir faturamento por pedidos
 * dentro de um balde daria um ticket por marketplace que o handler
 * nunca calculou, e contar SKU por balde exigiria um conjunto que ele
 * nao mantem.
 *
 * A primeira versao deste transporte tinha UM tipo para os dois e o
 * validador de seis campos era aplicado tambem aos baldes. O efeito
 * apareceu na primeira execucao real: `marketplaces.Shopee.ticketMedio`
 * chegava `undefined`, o validador devolvia `null`, e a tela dizia "o
 * resultado nao pode ser exibido" sobre uma consulta que tinha
 * funcionado perfeitamente — 252 pedidos lidos e agregados.
 */
export interface ResumoConsultaVendasUI {
  linhas: number;
  pedidos: number;
  unidades: number;
  faturamento: number;
  ticketMedio: number;
  skusDistintos: number;
}

/** O recorte de UM marketplace. QUATRO campos — e a ausencia dos dois
 *  do total e o contrato, nao uma falta. */
export interface BucketMarketplaceUI {
  linhas: number;
  pedidos: number;
  unidades: number;
  faturamento: number;
}

/**
 * O resultado BOUNDED da tarefa.
 *
 * Tres baldes FIXOS, nunca chave dinamica: o tamanho nao cresce com o
 * volume consultado, e por isso ele pode viajar inteiro ate a tela. Nao
 * existe linha de pedido aqui, e nao deve passar a existir.
 */
export interface ResultadoConsultaVendasUI {
  periodo: PeriodoConsultaVendas;
  resumo: ResumoConsultaVendasUI;
  marketplaces: {
    Shopee: BucketMarketplaceUI;
    ML: BucketMarketplaceUI;
    outros: BucketMarketplaceUI;
  };
  /** O periodo tinha MAIS dados do que couberam na paginacao. Quem mostra
   *  o resumo precisa dizer isso — calar entregaria um total incompleto
   *  com cara de completo. */
  truncado: boolean;
}

export interface TarefaConsultaVendasUI {
  id: string;
  status: StatusConversa;
  resultado: ResultadoConsultaVendasUI | null;
  erroTipo: string | null;
  criadoEm: string | null;
  iniciadoEm: string | null;
  concluidoEm: string | null;
}

/** O marketplace que o formulario pode pedir. `null` e "todos" — e e o
 *  mesmo pedido que omitir a chave, conforme a API. */
export type MarketplaceConsultaVendas = "Shopee" | "ML" | null;

export type RespostaCriacaoConsultaVendas =
  | { estado: "ok"; tarefaId: string; status: StatusConversa }
  | { estado: "nao_autenticado" }
  | { estado: "nao_encontrado" }
  | { estado: "agente_inativo" }
  | { estado: "entrada_invalida"; codigo: string | null }
  | { estado: "falha" };

export type RespostaConsultaVendas =
  | { estado: "ok"; tarefa: TarefaConsultaVendasUI }
  | { estado: "nao_autenticado" }
  | { estado: "nao_encontrado" }
  | { estado: "entrada_invalida" }
  | { estado: "falha" };

const caminhoDaConsultaVendas = (agenteId: string) =>
  `${ROTA_BASE}/${encodeURIComponent(agenteId)}${ROTA_SUFIXO_CONSULTAR_VENDAS}`;

/**
 * Le uma lista NOMINAL de campos numericos.
 *
 * `Number.isFinite` e deliberado: `NaN` e `Infinity` chegariam como
 * `null` pelo JSON, mas um numero invalido vindo por outro caminho
 * viraria "R$ NaN" na tela. Recusar e melhor que exibir.
 *
 * As chaves entram por parametro justamente para que as duas formas nao
 * voltem a compartilhar uma lista so.
 */
function numerosNominais(
  bruto: unknown,
  chaves: readonly string[]
): Record<string, number> | null {
  if (!ehObjeto(bruto)) return null;
  const saida: Record<string, number> = {};
  for (const chave of chaves) {
    const valor = bruto[chave];
    if (typeof valor !== "number" || !Number.isFinite(valor)) return null;
    saida[chave] = valor;
  }
  return saida;
}

const CAMPOS_RESUMO = [
  "linhas",
  "pedidos",
  "unidades",
  "faturamento",
  "ticketMedio",
  "skusDistintos",
] as const;

/** O balde NAO tem `ticketMedio` nem `skusDistintos`, e exigi-los aqui
 *  reprovaria todo resultado real. Ver o docblock de
 *  `ResumoConsultaVendasUI`. */
const CAMPOS_BUCKET = ["linhas", "pedidos", "unidades", "faturamento"] as const;

function resumoDaResposta(bruto: unknown): ResumoConsultaVendasUI | null {
  const lido = numerosNominais(bruto, CAMPOS_RESUMO);
  return lido === null ? null : (lido as unknown as ResumoConsultaVendasUI);
}

function bucketMarketplaceDaResposta(bruto: unknown): BucketMarketplaceUI | null {
  const lido = numerosNominais(bruto, CAMPOS_BUCKET);
  return lido === null ? null : (lido as unknown as BucketMarketplaceUI);
}

/**
 * Valida o resultado ANTES de deixa-lo chegar a tela.
 *
 * Sem `as any` e sem cast cego: `resultado` e `jsonb` do banco, e o que
 * a tela pode acessar sem checar e exatamente o que um dia vai quebrar
 * com um `undefined`. Shape divergente vira `null`, e o componente
 * mostra "resultado indisponivel" em vez de estourar.
 */
function resultadoDaResposta(bruto: unknown): ResultadoConsultaVendasUI | null {
  if (!ehObjeto(bruto)) return null;

  const { periodo, resumo, marketplaces, truncado } = bruto;
  if (typeof truncado !== "boolean") return null;

  if (!ehObjeto(periodo)) return null;
  const { dataInicio, dataFim, marketplace } = periodo;
  if (typeof dataInicio !== "string" || typeof dataFim !== "string") return null;
  if (marketplace !== null && typeof marketplace !== "string") return null;

  const totais = resumoDaResposta(resumo);
  if (totais === null) return null;

  if (!ehObjeto(marketplaces)) return null;
  const shopee = bucketMarketplaceDaResposta(marketplaces.Shopee);
  const ml = bucketMarketplaceDaResposta(marketplaces.ML);
  const outros = bucketMarketplaceDaResposta(marketplaces.outros);
  if (shopee === null || ml === null || outros === null) return null;

  return {
    periodo: { dataInicio, dataFim, marketplace },
    resumo: totais,
    marketplaces: { Shopee: shopee, ML: ml, outros: outros },
    truncado,
  };
}

function tarefaDeVendasDaResposta(bruto: unknown): TarefaConsultaVendasUI | null {
  if (!ehObjeto(bruto)) return null;
  const { id, status, resultado, erroTipo, criadoEm, iniciadoEm, concluidoEm } = bruto;
  if (typeof id !== "string" || id.length === 0) return null;
  if (!ehStatusConhecido(status)) return null;
  if (erroTipo !== null && typeof erroTipo !== "string") return null;

  const instante = (v: unknown): string | null => (typeof v === "string" ? v : null);

  // `resultado` so existe em `concluido`. Nos demais estados a API manda
  // `null`, e um objeto invalido tambem vira `null` — a tela distingue
  // "ainda nao ha" de "veio quebrado" pelo status, nao pelo campo.
  return {
    id,
    status,
    resultado: resultado === null ? null : resultadoDaResposta(resultado),
    erroTipo,
    criadoEm: instante(criadoEm),
    iniciadoEm: instante(iniciadoEm),
    concluidoEm: instante(concluidoEm),
  };
}

/**
 * Cria UMA tarefa `consultar_vendas`.
 *
 * O corpo leva SOMENTE o filtro. Dono, agente, tipo, Funcao, tentativas
 * e estado sao decididos no servidor, e a API recusa qualquer chave a
 * mais. `marketplace` so viaja quando ha escolha: omitir e mandar `null`
 * sao o mesmo pedido, e omitir mantem o corpo minimo.
 */
export async function criarConsultaVendasDoAgente(
  agenteId: string,
  filtro: { dataInicio: string; dataFim: string; marketplace: MarketplaceConsultaVendas },
  signal?: AbortSignal
): Promise<RespostaCriacaoConsultaVendas> {
  const corpoEnviado: Record<string, string> = {
    dataInicio: filtro.dataInicio,
    dataFim: filtro.dataFim,
  };
  if (filtro.marketplace !== null) corpoEnviado.marketplace = filtro.marketplace;

  let resposta: Response;
  try {
    resposta = await fetch(caminhoDaConsultaVendas(agenteId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(corpoEnviado),
      signal,
    });
  } catch {
    return { estado: "falha" };
  }

  if (resposta.status === 401) return { estado: "nao_autenticado" };
  if (resposta.status === 404) return { estado: "nao_encontrado" };
  if (resposta.status === 409) return { estado: "agente_inativo" };

  const corpo = await corpoDe(resposta);

  // 400 carrega o codigo ESTAVEL do validador de dominio
  // (`janela_excedida`, `data_invalida`, ...). E a unica informacao de
  // erro que atravessa, e ela existe porque o dono precisa saber o que
  // corrigir. Qualquer outra forma vira `null`.
  if (resposta.status === 400) {
    const codigo = ehObjeto(corpo) && typeof corpo.erro === "string" ? corpo.erro : null;
    return { estado: "entrada_invalida", codigo };
  }

  if (!resposta.ok || !ehObjeto(corpo) || corpo.ok !== true) return { estado: "falha" };
  // Shape divergente e FALHA, nunca uma tarefa meio montada entrando no
  // acompanhamento com um id que talvez nao exista.
  if (typeof corpo.tarefaId !== "string" || corpo.tarefaId.length === 0) return { estado: "falha" };
  if (!ehStatusConhecido(corpo.status)) return { estado: "falha" };

  return { estado: "ok", tarefaId: corpo.tarefaId, status: corpo.status };
}

/** Consulta UMA tarefa de vendas. Leitura pura: nao cria nada, nao
 *  reexecuta e nao aciona o dispatcher. */
export async function consultarConsultaVendasDoAgente(
  agenteId: string,
  tarefaId: string,
  signal?: AbortSignal
): Promise<RespostaConsultaVendas> {
  const consulta = new URLSearchParams({ tarefaId });
  let resposta: Response;
  try {
    resposta = await fetch(`${caminhoDaConsultaVendas(agenteId)}?${consulta.toString()}`, { signal });
  } catch {
    return { estado: "falha" };
  }

  if (resposta.status === 401) return { estado: "nao_autenticado" };
  if (resposta.status === 404) return { estado: "nao_encontrado" };
  if (resposta.status === 400) return { estado: "entrada_invalida" };

  const corpo = await corpoDe(resposta);
  if (!resposta.ok || !ehObjeto(corpo) || corpo.ok !== true) return { estado: "falha" };

  const tarefa = tarefaDeVendasDaResposta(corpo.tarefa);
  if (tarefa === null) return { estado: "falha" };

  return { estado: "ok", tarefa };
}
