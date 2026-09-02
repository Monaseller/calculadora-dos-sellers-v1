/**
 * Handler `conversa` — AGENT-VERTICAL-SLICE-V1.
 *
 * ── O que esta etapa prova ──────────────────────────────────────────
 *
 * Que a execucao de uma tarefa chama a IA com as instrucoes DO AGENTE
 * QUE O USUARIO CRIOU — nao de um agente qualquer, nao de um default do
 * codigo, nao de algo que veio na entrada da tarefa. Agente A conversa
 * com as instrucoes de A; agente B, com as de B.
 *
 * ── Por que o handler le o agente, e nao o contexto ─────────────────
 *
 * `ContextoTarefa` continua com os MESMOS 7 campos desde a 1C, e nao
 * ganha um oitavo aqui. Acrescentar `instrucoesAgente` obrigaria todo
 * construtor de contexto — producao e suites — a saber de instrucoes, e
 * o tripwire G8b existe justamente para impedir esse alargamento. Alem
 * disso, carregar instrucoes no executor faria TODO handler pagar por
 * uma leitura que so este precisa.
 *
 * O contexto ja carrega `agenteId` e `userId`. Isso basta: o ALVO vem
 * do contexto, o PODER vem da closure. O handler recebe uma leitura ja
 * amarrada a um dono so — ela tem aridade 1 e nao aceita `userId` —,
 * entao nao existe assinatura pela qual ele peca o agente de outro
 * tenant.
 *
 * ── Onde mora o contrato de saida, e por que aqui ───────────────────
 *
 * `PedidoIA` exige que QUEM CHAMA entregue schema e validador: o
 * adaptador nunca decide o contrato de saida. `contrato-analise.ts` faz
 * isso para `analise_vendas`; este arquivo faz o mesmo para `conversa`.
 * Um modulo novo em `lib/agentes/ia/` seria a casa mais simetrica, mas
 * o gate autoriza 6 paths nomeados e nenhum deles fica la — e um
 * contrato de 1 campo nao justifica gastar o unico path restante.
 *
 * ── Uma tarefa, uma troca ───────────────────────────────────────────
 *
 * Sem historico, sem thread, sem `conversationId`. Uma tarefa
 * `conversa` e uma pergunta e uma resposta. Se isso for pouco, a
 * decisao vem depois do primeiro teste manual — nao antes dele.
 *
 * ── Sem tools, sem Function, sem Approval ───────────────────────────
 *
 * O `AdaptadorIA` nao tem `tools` nem `tool_choice` por construcao. Um
 * modelo sem tools nao alcanca dado que o chamador nao lhe entregou —
 * e o que este handler entrega e a instrucao do agente e a mensagem do
 * usuario, nada mais.
 */
import { ErroProvedorIA } from "@/lib/ai-gateway/erros";

import { ErroEntradaTarefa } from "@/lib/agentes/erros";
// Import de TIPO apenas: o handler nao conhece cliente de banco, nao
// monta filtro, nao le env e nao escolhe provedor.
import type { AdaptadorIA, PedidoIA } from "@/lib/agentes/ia/tipos";
import type { LinhaAgente, ResultadoLeitura } from "@/lib/agentes/tipos";
import type {
  ContextoTarefa,
  HandlerTarefa,
  RelatarProgresso,
} from "@/lib/agentes/tipos-execucao";

export const TIPO_CONVERSA = "conversa";

/**
 * A leitura do agente, ja restrita ao dono por quem a construiu.
 *
 * A aridade e 1 de proposito. Uma leitura que aceitasse `(agenteId,
 * userId)` deixaria o handler escolher tenant, e a fronteira voltaria a
 * depender de disciplina em vez de assinatura.
 */
export type LeituraDoAgente = (agenteId: string) => Promise<ResultadoLeitura<LinhaAgente>>;

/**
 * Como o handler obtem o adaptador de IA.
 *
 * Recebe o CONTEXTO, e nao uma identidade ja montada, para que o
 * handler nao precise importar `observabilidade-ia` — modulo que fala
 * com Supabase. Quem monta a identidade contabil e a camada de
 * ativacao, que ja o faz para `analise_vendas`.
 *
 * `Promise` porque a fabrica real carrega o SDK por import DINAMICO: com
 * o provedor desligado, o SDK nao entra sequer em `require.cache`.
 */
export type ObterAdaptadorDeConversa = (contexto: ContextoTarefa) => Promise<AdaptadorIA>;

// ── Contrato de entrada ─────────────────────────────────────────────

/**
 * A entrada e FECHADA: so `mensagem`.
 *
 * Recusar chave desconhecida — em vez de ignora-la — e o que torna
 * `{ mensagem, instrucoes: "MALICIOSA" }` um erro visivel em vez de um
 * campo silenciosamente descartado. Descartar em silencio ensina quem
 * chama que o campo existe e nao faz nada, que e a pior das duas
 * respostas.
 *
 * `instrucoes`, `userId`, `agenteId`, `provider`, `model` e `tools` caem
 * todos aqui. Nenhum deles tem autoridade sobre nada: identidade vem do
 * contexto, instrucao vem do banco, provedor vem do ambiente.
 */
export const CAMPOS_ENTRADA_CONVERSA = new Set(["mensagem"]);

// ── Contrato de saida ───────────────────────────────────────────────

export interface RespostaConversaIA {
  resposta: string;
}

/**
 * ── Por que NAO existe teto de tamanho aqui ─────────────────────────
 *
 * Existiu, em 4000 caracteres, e era um bug. Nenhum contrato deste
 * caminho pede esse numero: `agente_tarefas.resultado` e `jsonb` sem
 * constraint de tamanho, `PedidoIA`/`AdaptadorIA` nao declaram limite,
 * e o provedor roda com `max_tokens: 16000` — cerca de treze vezes
 * mais. O efeito observavel do teto era so falso negativo: uma resposta
 * legitima de 4001 caracteres virava `handler_falhou` DEPOIS de a
 * chamada ja ter sido paga e contabilizada, e `max_tentativas` a
 * repetia.
 *
 * O `LIMITE_RESUMO_CARACTERES` da analise nao servia de precedente: la
 * o limite e editorial — um resumo executivo que passa de 1200
 * caracteres deixou de ser resumo. Uma conversa nao tem esse contrato.
 *
 * O bound real ja existe uma camada abaixo e e explicito: quando o
 * modelo estoura o orcamento, o provedor devolve
 * `stop_reason === "max_tokens"` e o gateway lanca dizendo isso. Somar
 * aqui uma segunda barreira, mais estrita e nao publicada, so
 * introduziria recusa de resposta boa.
 */

/** Schema declarado ao provedor. Sugestao, nunca garantia. */
export const SCHEMA_RESPOSTA_CONVERSA = {
  type: "object",
  properties: {
    resposta: { type: "string" },
  },
  required: ["resposta"],
  additionalProperties: false,
} as const;

function recusar(motivo: string): never {
  throw new ErroProvedorIA("validation", `Resposta de IA fora do contrato: ${motivo}`);
}

function ehObjetoSimples(valor: unknown): valor is Record<string, unknown> {
  if (valor === null || typeof valor !== "object") return false;
  if (Array.isArray(valor)) return false;
  const proto = Object.getPrototypeOf(valor);
  return proto === Object.prototype || proto === null;
}

/**
 * A validacao e NOSSA e roda SEMPRE, mesmo com schema aceito pelo
 * provedor — o schema e dele, a validacao e nossa. Lanca; nunca devolve
 * `null` nem um objeto "quase certo".
 */
export function validarRespostaConversa(bruto: unknown): RespostaConversaIA {
  if (bruto === undefined) recusar("resposta ausente.");
  if (!ehObjetoSimples(bruto)) {
    const tipo = bruto === null ? "null" : Array.isArray(bruto) ? "array" : typeof bruto;
    recusar(`esperava objeto simples, veio ${tipo}.`);
  }

  const recebidas = Object.keys(bruto);
  const inesperadas = recebidas.filter((chave) => chave !== "resposta");
  if (inesperadas.length > 0) {
    recusar(`chave(s) nao prevista(s) no contrato: ${inesperadas.join(", ")}.`);
  }
  if (!recebidas.includes("resposta")) recusar('chave obrigatoria ausente: "resposta".');

  const valor = bruto.resposta;
  if (typeof valor !== "string") {
    recusar(`"resposta" deveria ser string, veio ${valor === null ? "null" : typeof valor}.`);
  }
  // `trim` aqui serve para DETECTAR a resposta vazia — nao para cortar
  // conteudo. Devolver a versao aparada segue o mesmo comportamento de
  // `validarTexto` em `contrato-analise.ts`: o que sai e o que entrou,
  // menos o espaco das pontas. Nao ha `slice` nem `substring` neste
  // caminho, e uma resposta valida viaja inteira.
  const aparada = valor.trim();
  if (aparada.length === 0) recusar('"resposta" veio vazia ou so com espacos.');

  return { resposta: aparada };
}

/**
 * A instrucao usada quando o agente NAO tem instrucoes configuradas.
 *
 * `instrucoes = null` e estado VALIDO — nao e agente ausente e nao e
 * erro. Mas `PedidoIA.instrucao` e `string` nao-opcional, entao alguma
 * coisa precisa ir ali, e essa coisa nao pode ser uma persona
 * inventada: preencher com "voce e um assistente prestativo" seria
 * atribuir ao agente do cliente um comportamento que ele nunca
 * configurou.
 *
 * O texto abaixo e o MINIMO TECNICO: diz o que fazer com a mensagem e
 * proibe assumir papel. Nao e persistido em lugar nenhum — vive so no
 * pedido daquela chamada.
 */
export const INSTRUCAO_MINIMA_CONVERSA = [
  "Responda a mensagem do usuario de forma direta e objetiva.",
  "Este agente nao tem instrucoes configuradas: nao assuma papel, tom,",
  "especialidade nem identidade que nao tenham sido pedidos.",
].join("\n");

/**
 * Monta o pedido. Funcao pura e exportada para que a suite prove o
 * mapeamento semantico sem precisar de banco nem de adaptador.
 *
 * ── O mapeamento, que e o ponto do gate ─────────────────────────────
 *
 *   agente.instrucoes  ->  `instrucao`  (comportamento do sistema)
 *   mensagem da tarefa ->  `dados`      (conteudo do usuario)
 *
 * Os dois NAO sao concatenados: o contrato ja separa os campos, e junta-
 * los apagaria a fronteira entre "o que o dono configurou" e "o que o
 * usuario digitou" — que e exatamente a fronteira que impede a mensagem
 * de se passar por instrucao.
 */
export function prepararPedidoConversa(
  instrucoesDoAgente: string | null,
  mensagem: string
): PedidoIA<RespostaConversaIA> {
  const instrucoes =
    typeof instrucoesDoAgente === "string" ? instrucoesDoAgente.trim() : "";

  return {
    // VERBATIM quando existe. Nada de prefixo, sufixo ou moldura nossa:
    // se o dono escreveu "RESPONDA_COM_A", e isso que o modelo recebe.
    instrucao: instrucoes.length > 0 ? instrucoes : INSTRUCAO_MINIMA_CONVERSA,
    dados: mensagem,
    schema: SCHEMA_RESPOSTA_CONVERSA,
    validar: validarRespostaConversa,
  };
}

/** Le a mensagem da entrada, com o contrato fechado. LANCA em desvio. */
function mensagemDaEntrada(entrada: Record<string, unknown>): string {
  if (entrada === null || typeof entrada !== "object" || Array.isArray(entrada)) {
    throw new ErroEntradaTarefa("entrada deveria ser um objeto");
  }

  for (const chave of Object.keys(entrada)) {
    if (!CAMPOS_ENTRADA_CONVERSA.has(chave)) {
      // O NOME da chave recusada e seguro (veio de uma allowlist curta);
      // o VALOR nunca aparece — seria justamente o texto malicioso.
      throw new ErroEntradaTarefa(`campo nao previsto na entrada: ${chave}`);
    }
  }

  const mensagem = entrada.mensagem;
  if (typeof mensagem !== "string" || mensagem.trim().length === 0) {
    throw new ErroEntradaTarefa("entrada.mensagem deve ser uma string nao vazia");
  }
  return mensagem.trim();
}

/**
 * Constroi o handler de `conversa` com a leitura e o adaptador ja
 * vinculados.
 *
 * ── Toda recusa acontece ANTES da IA ────────────────────────────────
 *
 * Entrada invalida, agente ausente, leitura falha e agente inativo
 * lancam sem que o adaptador seja sequer obtido. Isso e requisito, nao
 * consequencia: chamar o modelo para depois descobrir que o agente nao
 * existe gastaria credito do dono por uma tarefa que nunca poderia ter
 * rodado.
 *
 * ── Sem try/catch em volta da IA ────────────────────────────────────
 *
 * Erro de provedor, timeout e resposta fora do contrato sobem inteiros e
 * o executor os classifica como `handler_falhou`. Nao existe queda para
 * uma resposta inventada: uma tarefa que termina `concluida` com texto
 * fabricado seria pior que uma que falha.
 */
export function criarHandlerConversa(
  lerAgente: LeituraDoAgente,
  obterAdaptador: ObterAdaptadorDeConversa
): HandlerTarefa {
  return async function handlerConversa(
    contexto: ContextoTarefa,
    relatarProgresso: RelatarProgresso
  ): Promise<Record<string, unknown>> {
    relatarProgresso(0);

    const mensagem = mensagemDaEntrada(contexto.entrada);

    // Vem da LINHA da tarefa, nunca da entrada. Vazio aqui e defeito
    // nosso, nao entrada malformada do usuario — por isso nao e
    // `ErroEntradaTarefa`.
    if (!contexto.agenteId) throw new Error("contexto sem agenteId");

    relatarProgresso(25);

    const { linha, erro } = await lerAgente(contexto.agenteId);
    // A capability ja registrou o SQLSTATE. Aqui so sobe a categoria —
    // erro cru de driver nao viaja para `erro_mensagem`.
    if (erro) throw new Error("falha ao ler o agente da tarefa");
    // Agente AUSENTE nao e agente sem instrucoes: sao estados
    // diferentes e param em lugares diferentes.
    if (!linha) throw new Error("agente da tarefa nao encontrado");
    // O claim ja recusa tarefa de agente inativo. Reafirmar aqui e
    // defesa em profundidade — este handler nao depende de aquele
    // predicado estar certo para nao rodar um agente desligado.
    if (!linha.ativo) throw new Error("agente inativo");

    relatarProgresso(50);

    const adaptador = await obterAdaptador(contexto);
    const resposta = await adaptador(prepararPedidoConversa(linha.instrucoes, mensagem));

    relatarProgresso(100);

    // Resultado MINIMO. Provedor, modelo e tokens ja sao contabilizados
    // pelo adaptador observavel — repeti-los aqui poria metadado de
    // infraestrutura dentro do resultado que o usuario le.
    return { resposta: resposta.conteudo.resposta };
  };
}
