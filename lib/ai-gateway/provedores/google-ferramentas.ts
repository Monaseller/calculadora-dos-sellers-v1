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
 * ── ACHADO F4, e a CORRECAO dele no F7b.4 ──────────────────────────
 *
 * O F4 mediu que o segundo turno (devolver o resultado) era recusado com
 * 400 em sete variantes de forma, e que so funcionava com
 * `previous_interaction_id` + `store: true`. Concluiu: a API exige
 * continuacao server-side, e `store: false` fecha a porta.
 *
 * A conclusao estava ERRADA. O F7b.4 mediu de novo, contra a mesma API,
 * e isolou o que faltava:
 *
 *   o passo `function_call` que o modelo devolve carrega um campo
 *   `signature` — string opaca de algumas centenas de caracteres.
 *
 * Reconstruir o passo com `{type, id, name, arguments}` descarta a
 * assinatura, e e isso que produz o 400. Devolver o MESMO passo com a
 * assinatura preservada fecha o ciclo com `store: false`:
 *
 *   user_input + function_call(com signature) + function_result
 *     -> 200, e a resposta final cita o valor que a Tool calculou.
 *
 * Duas coisas mais, tambem medidas:
 *
 *   - `function_result` exige `name`. Sem ele: 400
 *     "function_response.name: Name cannot be empty".
 *   - o passo `thought` tambem traz assinatura, e NAO e necessario: o
 *     eco do `function_call` sozinho basta.
 *
 * `store: false` segue intacto. Nao houve decisao de privacidade nova —
 * houve um campo que ninguem tinha visto.
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
  | {
      type: "function_call";
      id: string;
      name: string;
      arguments: Record<string, unknown>;
      /** Assinatura OPACA do modelo. Sem ela o turno seguinte leva 400. */
      signature?: string;
    }
  | {
      type: "function_result";
      call_id: string;
      /** OBRIGATORIO. Medido: sem `name`, a API responde
       *  "function_response.name: Name cannot be empty". */
      name: string;
      result: string;
      is_error: boolean;
    };

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
  // `function_result` exige `name`, e `RespostaDeFerramenta` so carrega
  // `id`. O nome vem do `function_call` que abriu aquele id — amarrar
  // pelo id e mais seguro que passar o nome adiante por mais uma camada,
  // porque o id e justamente o que a API usa para casar os dois.
  const nomePorId = new Map<string, string>();
  for (const m of mensagens) {
    if (m.papel === "assistente") {
      for (const p of m.pedidos) nomePorId.set(p.id, p.nome);
    }
  }
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
          // Devolvida VERBATIM quando existe. Omitida quando nao — o
          // primeiro turno nao tem assinatura para preservar, e mandar
          // string vazia seria pior que nao mandar campo.
          ...(p.assinatura !== undefined ? { signature: p.assinatura } : {}),
        });
      }
      continue;
    }
    for (const r of m.respostas) {
      passos.push({
        type: "function_result",
        call_id: r.id,
        // Sem nome conhecido o pedido seria recusado pela API de todo
        // jeito; string vazia falha com mensagem clara em vez de virar
        // um 400 generico.
        name: nomePorId.get(r.id) ?? "",
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
      signature?: unknown;
    };
    if (s.type === "model_output") {
      for (const c of s.content ?? []) {
        if (c.type === "text" && typeof c.text === "string" && c.text !== "") {
          texto = texto === null ? c.text : texto + "\n" + c.text;
        }
      }
    } else if (s.type === "function_call" && typeof s.id === "string" && typeof s.name === "string") {
      pedidos.push({
        id: s.id,
        nome: s.name,
        argumentos: s.arguments ?? {},
        // Opaca: guardada sem ser lida, para voltar identica no proximo
        // turno. O passo `thought` tambem traz uma, e NAO e necessaria —
        // medido: eco do `function_call` sozinho fecha o ciclo.
        ...(typeof s.signature === "string" ? { assinatura: s.signature } : {}),
      });
    }
  }
  return { texto, pedidos };
}

/**
 * `escolhaDeFerramenta` -> `generation_config.tool_choice`.
 *
 * Na Interactions API a escolha NAO fica ao lado de `tools`: ela mora
 * dentro de `generation_config`, e a forma de exigir UMA ferramenta e
 * `allowed_tools` com `mode: "any"` mais a lista de nomes — outra forma
 * que so o tipo real do SDK revela (`AllowedTools`, genai.d.ts:254).
 *
 * `"auto"` nao manda nada: e o default da API.
 */
export function montarEscolhaGoogle(
  escolha: PedidoIAComFerramentas["escolhaDeFerramenta"]
): { generation_config?: { tool_choice: { allowed_tools: { mode: string; tools: string[] } } } } {
  if (escolha === undefined || escolha === "auto") return {};
  return {
    generation_config: {
      tool_choice: { allowed_tools: { mode: "any", tools: [escolha.nome] } },
    },
  };
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
/**
 * APOSENTADO no F7b.4 — mantido como marcador historico.
 *
 * Este codigo era lancado no segundo turno, porque o F4 concluiu que a
 * Interactions API so fechava o ciclo de ferramenta com `store: true`. A
 * conclusao estava ERRADA, e o F7b.4 mostrou onde: o que faltava era a
 * `signature` do `function_call`, nao a retencao remota.
 *
 * A constante continua exportada porque as suites verificam que este
 * arquivo NAO voltou a barrar o segundo turno — um nome que desaparece
 * nao pode ser cobrado. Nenhum caminho de codigo o lanca.
 */
export const CODIGO_RETORNO_BLOQUEADO = "google_tool_result_exige_store";

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
        ...montarEscolhaGoogle(pedido.escolhaDeFerramenta),
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
