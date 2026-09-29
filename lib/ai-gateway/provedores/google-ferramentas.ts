/**
 * Google com FERRAMENTAS — AGENT-FACTORY-F1.
 *
 * ── ACHADO: aqui NAO existe `functionDeclarations` ──────────────────
 *
 * A forma `tools: [{ functionDeclarations: [...] }]` pertence a API
 * ANTIGA (`models.generateContent`). Este repositorio fala com o Gemini
 * pela Interactions API (`client.interactions.create`), por regra de
 * privacidade — e o `store: false` que impede o Google de reter dados
 * do cliente por ate 55 dias. E na Interactions API a declaracao e
 * OUTRA: cada ferramenta e um objeto CHATO
 *
 *     { type: "function", name, description, parameters }
 *
 * verificado em `@google/genai@2.15.0`, tipo `FunctionT` (genai.d.ts
 * linha 4984) e `CreateModelInteraction.tools` (linha 2578). Escrever
 * `functionDeclarations` aqui produziria um corpo que a API ignora ou
 * recusa — o modelo simplesmente nunca veria ferramenta alguma.
 *
 * O dialogo tambem muda de forma: a Anthropic usa `messages` com blocos
 * dentro do papel; o Gemini usa `input` como uma lista de PASSOS
 * (`user_input`, `model_output`, `function_call`, `function_result`),
 * cada um no topo. Por isso os dois provedores tem mapeadores proprios e
 * nenhum `if (provedor === ...)` no meio de uma funcao so.
 *
 * ── As tres conversoes sao PURAS e exportadas ───────────────────────
 *
 * `montarFerramentasGoogle`, `montarPassos` e `lerPassos` nao tocam
 * rede. Sao testadas direto, sem chave e sem custo.
 */
import { ErroProvedorIA } from "../erros";
import { mapearErroGoogle, obterClienteGoogle } from "./google";
import type {
  FerramentaDeclarada,
  MensagemDoDialogo,
  PedidoDeFerramenta,
  PedidoIAComFerramentas,
  RespostaIAComFerramentas,
} from "@/lib/agentes/ia/ferramentas";

const TIMEOUT_MS = 120_000;

/** Unico ponto que le o modelo desta capacidade. Sem fallback. */
export function obterModeloFerramentasGoogle(): string {
  const modelo = process.env.GOOGLE_AI_MODEL_AGENTE?.trim() ?? "";
  if (!modelo) {
    throw new ErroProvedorIA(
      "auth",
      "GOOGLE_AI_MODEL_AGENTE ausente ou vazia — configure antes de usar ferramentas."
    );
  }
  return modelo;
}

// ─── Conversoes puras ─────────────────────────────────────────────────

/** Catalogo -> `tools` da Interactions API. Ver o cabecalho: sem wrapper. */
export function montarFerramentasGoogle(
  ferramentas: readonly FerramentaDeclarada[]
): { type: "function"; name: string; description: string; parameters: object }[] {
  return ferramentas.map((f) => ({
    type: "function" as const,
    name: f.nome,
    description: f.descricao,
    parameters: f.schemaEntrada,
  }));
}

/** Um passo da Interactions API, na forma minima que usamos. */
export type PassoDeInteracao =
  | { type: "user_input"; content: { type: "text"; text: string }[] }
  | { type: "model_output"; content: { type: "text"; text: string }[] }
  | { type: "function_call"; id: string; name: string; arguments: Record<string, unknown> }
  | { type: "function_result"; call_id: string; result: string; is_error: boolean };

/**
 * Dialogo -> `input` da Interactions API.
 *
 * Um turno de assistente com texto E pedidos vira MAIS DE UM passo: o
 * `model_output` do texto e um `function_call` por pedido. Nao ha passo
 * que carregue os dois, e achatar os pedidos num texto perderia o `id`
 * que amarra chamada e resultado.
 *
 * `arguments` e obrigatorio e precisa ser objeto; um pedido sem
 * argumento vira objeto vazio, nunca `null`.
 */
export function montarPassos(
  mensagens: readonly MensagemDoDialogo[]
): PassoDeInteracao[] {
  const passos: PassoDeInteracao[] = [];
  for (const m of mensagens) {
    if (m.papel === "usuario") {
      passos.push({ type: "user_input", content: [{ type: "text", text: m.texto }] });
      continue;
    }
    if (m.papel === "assistente") {
      if (m.texto) {
        passos.push({ type: "model_output", content: [{ type: "text", text: m.texto }] });
      }
      for (const p of m.pedidos) {
        passos.push({
          type: "function_call",
          id: p.id,
          name: p.nome,
          arguments:
            typeof p.argumentos === "object" && p.argumentos !== null && !Array.isArray(p.argumentos)
              ? (p.argumentos as Record<string, unknown>)
              : {},
        });
      }
      continue;
    }
    for (const r of m.respostas) {
      passos.push({
        type: "function_result",
        call_id: r.id,
        result: r.conteudo,
        is_error: r.erro,
      });
    }
  }
  return passos;
}

/**
 * `steps` da resposta -> texto + pedidos.
 *
 * Le SOMENTE os passos novos do modelo. `user_input` e `function_result`
 * que a API devolva sao eco do que enviamos: trata-los como resposta
 * faria o laco reexecutar uma ferramenta ja executada.
 *
 * `thought` e ignorado de proposito — raciocinio nao e texto para o
 * usuario e nao e pedido.
 */
export function lerPassos(
  steps: readonly unknown[] | undefined
): { texto: string | null; pedidos: PedidoDeFerramenta[] } {
  let texto: string | null = null;
  const pedidos: PedidoDeFerramenta[] = [];

  for (const bruto of steps ?? []) {
    const s = bruto as {
      type?: string;
      content?: { type?: string; text?: string }[];
      id?: string;
      name?: string;
      arguments?: unknown;
    };
    if (s.type === "model_output") {
      for (const c of s.content ?? []) {
        if (c.type === "text" && typeof c.text === "string" && c.text !== "") {
          texto = texto === null ? c.text : texto + "\n" + c.text;
        }
      }
    } else if (s.type === "function_call" && typeof s.id === "string" && typeof s.name === "string") {
      pedidos.push({ id: s.id, nome: s.name, argumentos: s.arguments ?? {} });
    }
  }
  return { texto, pedidos };
}

// ─── O adaptador ──────────────────────────────────────────────────────

/**
 * Um TURNO. Nao executa ferramenta e nao conhece guard — quem faz isso
 * e o laco.
 *
 * `store: false` nao e otimizacao: e a mesma regra de privacidade das
 * outras chamadas deste repositorio, e aqui pesa mais, porque o
 * historico enviado carrega resultado de Funcao do lojista.
 */
export async function chamarGeminiComFerramentas(
  pedido: PedidoIAComFerramentas
): Promise<RespostaIAComFerramentas> {
  const cliente = obterClienteGoogle();
  const modelo = obterModeloFerramentasGoogle();
  const inicio = Date.now();

  try {
    const interacao = await cliente.interactions.create(
      {
        model: modelo,
        system_instruction: pedido.instrucao,
        input: montarPassos(pedido.mensagens),
        tools: montarFerramentasGoogle(pedido.ferramentas),
        store: false,
        stream: false,
      },
      { timeout: TIMEOUT_MS }
    );

    const { texto, pedidos } = lerPassos((interacao as { steps?: unknown[] }).steps);

    // `output_text` e conveniencia do SDK sobre o ultimo model_output.
    // Serve de rede so quando nao houve pedido algum e a leitura de
    // passos veio vazia — nunca no lugar dela, porque ele nao carrega
    // function_call.
    const textoFinal =
      texto ?? (pedidos.length === 0 ? (interacao.output_text ?? null) : null);

    if (textoFinal === null && pedidos.length === 0) {
      throw new ErroProvedorIA(
        "validation",
        "Gemini nao devolveu texto nem pedido de ferramenta — resposta vazia ou bloqueada."
      );
    }

    return {
      texto: textoFinal,
      pedidos,
      provedor: "google",
      modelo,
      tokensEntrada: interacao.usage?.total_input_tokens ?? 0,
      tokensSaida: interacao.usage?.total_output_tokens ?? 0,
      tempoMs: Date.now() - inicio,
    };
  } catch (err) {
    if (err instanceof ErroProvedorIA) throw err;
    throw mapearErroGoogle(err);
  }
}
