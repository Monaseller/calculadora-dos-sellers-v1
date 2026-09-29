/**
 * Anthropic com FERRAMENTAS — AGENT-FACTORY-F1.
 *
 * ── Por que arquivo proprio, e nao `chamarClaudeTexto` alargado ─────
 *
 * `chamarClaudeTexto` faz UMA pergunta com `output_config` de
 * `json_schema` e devolve texto. A forma de ferramenta e outra: o corpo
 * leva `tools`, as mensagens sao uma LISTA com papeis, a resposta pode
 * conter blocos `tool_use` em vez de texto, e `stop_reason` passa a ter
 * o valor `tool_use`, que naquele caminho seria erro. Espremer as duas
 * na mesma funcao faria cada `if` servir a dois contratos.
 *
 * Os dois compartilham cliente, timeout, mapeamento de erro e teto de
 * tokens — nada disso e reescrito aqui.
 *
 * ── As tres conversoes sao PURAS e exportadas ───────────────────────
 *
 * `montarFerramentas`, `montarMensagens` e `lerResposta` nao tocam
 * rede. Sao elas que carregam o risco real — um bloco `tool_use` lido
 * errado vira ferramenta errada — e por isso sao testadas diretamente,
 * sem chave e sem custo. A funcao que fala com a rede so as costura.
 */
import Anthropic from "@anthropic-ai/sdk";

import { ErroProvedorIA } from "../erros";
import { mapearErroAnthropic } from "./anthropic";
import type {
  FerramentaDeclarada,
  MensagemDoDialogo,
  PedidoDeFerramenta,
  PedidoIAComFerramentas,
  RespostaIAComFerramentas,
} from "@/lib/agentes/ia/ferramentas";

const TIMEOUT_MS = 120_000;
const MAX_TOKENS = 8_000;

let clienteCache: Anthropic | null = null;

function obterCliente(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new ErroProvedorIA("auth", "ANTHROPIC_API_KEY ausente — nao e possivel chamar a Anthropic.");
  }
  if (!clienteCache) {
    clienteCache = new Anthropic({ apiKey, timeout: TIMEOUT_MS, maxRetries: 0 });
  }
  return clienteCache;
}

/** Unico ponto que le o modelo desta capacidade. Sem fallback. */
export function obterModeloFerramentas(): string {
  const modelo = process.env.ANTHROPIC_MODEL_AGENTE?.trim() ?? "";
  if (!modelo) {
    throw new ErroProvedorIA(
      "auth",
      "ANTHROPIC_MODEL_AGENTE ausente ou vazio — configure antes de usar ferramentas."
    );
  }
  return modelo;
}

// ─── Conversoes puras ─────────────────────────────────────────────────

/**
 * Catalogo -> `tools` da Anthropic.
 *
 * `input_schema` recebe o schema tal como declarado. Nao ha traducao de
 * nome: `nome` ja e o `funcaoId`, e inventar um alias criaria um mapa a
 * mais onde um pedido pode virar outra Funcao.
 */
export function montarFerramentas(
  ferramentas: readonly FerramentaDeclarada[]
): { name: string; description: string; input_schema: object }[] {
  return ferramentas.map((f) => ({
    name: f.nome,
    description: f.descricao,
    input_schema: f.schemaEntrada,
  }));
}

/**
 * Dialogo -> `messages` da Anthropic.
 *
 * Papel `ferramenta` vira `role: "user"` com blocos `tool_result`: e
 * assim que a API espera o retorno, e nao ha papel proprio para isso.
 * `tool_use_id` amarra a resposta ao pedido — sem ele o modelo nao sabe
 * qual resultado pertence a qual chamada quando houve mais de uma.
 */
export function montarMensagens(
  mensagens: readonly MensagemDoDialogo[]
): Anthropic.MessageParam[] {
  const saida: Anthropic.MessageParam[] = [];
  for (const m of mensagens) {
    if (m.papel === "usuario") {
      saida.push({ role: "user", content: m.texto });
      continue;
    }
    if (m.papel === "assistente") {
      const blocos: unknown[] = [];
      if (m.texto) blocos.push({ type: "text", text: m.texto });
      for (const p of m.pedidos) {
        blocos.push({ type: "tool_use", id: p.id, name: p.nome, input: p.argumentos ?? {} });
      }
      // Turno vazio nao existe na API; um assistente sem texto e sem
      // pedido seria recusado com 400. Pular e mais honesto que enviar
      // um bloco de texto vazio que mudaria o significado do turno.
      if (blocos.length > 0) {
        saida.push({ role: "assistant", content: blocos as Anthropic.ContentBlockParam[] });
      }
      continue;
    }
    saida.push({
      role: "user",
      content: m.respostas.map((r) => ({
        type: "tool_result" as const,
        tool_use_id: r.id,
        content: r.conteudo,
        is_error: r.erro,
      })) as Anthropic.ContentBlockParam[],
    });
  }
  return saida;
}

/**
 * Resposta da Anthropic -> texto + pedidos.
 *
 * `stop_reason === "tool_use"` NAO e erro aqui — e o caminho normal. O
 * que continua sendo erro e `refusal` e `max_tokens`, pelas mesmas
 * razoes do caminho de texto: no primeiro o `content` pode vir vazio, e
 * no segundo o `input` de uma ferramenta pode estar truncado, o que
 * produziria uma chamada com argumento pela metade.
 */
export function lerResposta(resposta: {
  content: readonly unknown[];
  stop_reason?: string | null;
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number } | null;
}): { texto: string | null; pedidos: PedidoDeFerramenta[] } {
  if (resposta.stop_reason === "refusal") {
    throw new ErroProvedorIA(
      "conteudo_rejeitado",
      "Claude recusou a requisicao por politica de seguranca (stop_reason=refusal)."
    );
  }
  if (resposta.stop_reason === "max_tokens") {
    throw new ErroProvedorIA(
      "validation",
      "Resposta truncada por max_tokens — um pedido de ferramenta pode estar incompleto."
    );
  }

  let texto: string | null = null;
  const pedidos: PedidoDeFerramenta[] = [];
  for (const bruto of resposta.content) {
    const b = bruto as { type?: string; text?: string; id?: string; name?: string; input?: unknown };
    if (b.type === "text" && typeof b.text === "string" && b.text !== "") {
      texto = texto === null ? b.text : `${texto}\n${b.text}`;
    } else if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
      pedidos.push({ id: b.id, nome: b.name, argumentos: b.input ?? {} });
    }
  }
  return { texto, pedidos };
}

// ─── O adaptador ──────────────────────────────────────────────────────

/**
 * Um TURNO. Nao executa ferramenta e nao conhece guard — quem faz isso
 * e o laco. Aqui so se fala com o provedor e se traduz a resposta.
 */
export async function chamarClaudeComFerramentas(
  pedido: PedidoIAComFerramentas
): Promise<RespostaIAComFerramentas> {
  const cliente = obterCliente();
  const modelo = obterModeloFerramentas();
  const inicio = Date.now();

  try {
    const resposta = await cliente.messages.create({
      model: modelo,
      max_tokens: MAX_TOKENS,
      system: pedido.instrucao,
      messages: montarMensagens(pedido.mensagens),
      tools: montarFerramentas(pedido.ferramentas) as Anthropic.ToolUnion[],
    } as Anthropic.MessageCreateParamsNonStreaming);

    const { texto, pedidos } = lerResposta(
      resposta as unknown as Parameters<typeof lerResposta>[0]);

    return {
      texto,
      pedidos,
      provedor: "anthropic",
      modelo: resposta.model,
      tokensEntrada: resposta.usage?.input_tokens ?? 0,
      tokensSaida: resposta.usage?.output_tokens ?? 0,
      tempoMs: Date.now() - inicio,
    };
  } catch (err) {
    if (err instanceof ErroProvedorIA) throw err;
    throw mapearErroAnthropic(err);
  }
}
