import "server-only";

/**
 * A OpenAI no MESMO runtime de agente — AGENT-FACTORY-F7b.4.2.
 *
 * Terceiro adaptador, mesmo contrato dos outros dois: recebe
 * `PedidoIAComFerramentas`, devolve `RespostaIAComFerramentas`. O laco
 * (`conversarComFerramentas`) e o guard nao mudam, e nao existe runtime
 * paralelo.
 *
 * ── Medido contra a API real em 2026-09-30, com gpt-5.2 ─────────────
 *
 * A forma saiu da RESPOSTA, nao de suposicao. O F4 concluiu algo sobre o
 * protocolo do Gemini sem isolar a forma verdadeira e custou dois gates
 * para ser desfeito; aqui cada afirmacao abaixo foi observada:
 *
 *   turno 1  POST /v1/responses com `tools: [{type:"function", name,
 *            description, parameters}]` e `store: false` -> 200.
 *
 *            O item devolvido e
 *              {id, type:"function_call", status, arguments, call_id, name}
 *
 *            `arguments` vem como STRING de JSON, e nao objeto. Passar
 *            essa string adiante como se fosse objeto entregaria ao guard
 *            um argumento que nenhuma Funcao entende.
 *
 *   turno 2  `{type:"function_call_output", call_id, output}` fecha o
 *            ciclo, e a resposta final cita o valor que a Tool calculou.
 *
 *   turno 3  Nova pergunta com o historico completo: o modelo pede a
 *            ferramenta de novo, com o RESULTADO anterior no argumento.
 *
 * ── Diferenca importante em relacao ao Gemini ───────────────────────
 *
 * Um `function_call` RECONSTRUIDO e aceito. Medido: a variante que
 * remontava `{type, call_id, name, arguments}` devolveu 200, igual a que
 * ecoava o item verbatim.
 *
 * Isso e o oposto do Gemini, onde falta a `signature` derruba o turno com
 * 400. Por isso este adaptador NAO precisa de campo opaco de continuacao,
 * e `PedidoDeFerramenta.assinatura` fica sem uso aqui.
 *
 * ── `store: false`, como nos outros ─────────────────────────────────
 *
 * Mesma regra de privacidade do resto do repositorio: nenhum provedor
 * retem o dialogo desta aplicacao.
 *
 * ── Nome de ferramenta: o mesmo mapa injetivo da Anthropic ──────────
 *
 * `funcao_id` da CDS tem PONTO (`calculadora.calcular`) e a gramatica de
 * nome de ferramenta dos provedores nao aceita. Em vez de testar se a
 * OpenAI aceita — o que mudaria com a versao da API — este adaptador
 * reusa `sanitizarNome`/`mapearNomes`, que ja estao provados e que
 * LANCAM em colisao. Mapear e seguro nos dois mundos; nao mapear so e
 * seguro em um.
 *
 * O nome volta a ser `funcao_id` antes de qualquer coisa chegar ao guard.
 *
 * ── Limite de 3 RPM nesta conta ─────────────────────────────────────
 *
 * Medido. `429` de rate limit NAO e o mesmo que `429` de saldo, e
 * `mapearErroOpenAI` os separa: um pede espera, o outro pede dinheiro.
 */
import { ErroProvedorIA } from "../erros";
import {
  mapearNomes, sanitizarNome, type MapaDeNomes,
} from "./anthropic-ferramentas";
import {
  classificarRespostaDaOpenAI,
} from "./openai-disponibilidade";
import type {
  FerramentaDeclarada,
  MensagemDoDialogo,
  PedidoDeFerramenta,
  PedidoIAComFerramentas,
  RespostaIAComFerramentas,
} from "@/lib/agentes/ia/ferramentas";

const BASE = "https://api.openai.com/v1";
const TIMEOUT_MS = 120_000;

/** Unico ponto que le o modelo desta capacidade. Sem fallback. */
export function obterModeloOpenAI(): string {
  const modelo = process.env.OPENAI_MODEL_AGENTE?.trim() ?? "";
  if (modelo === "") {
    throw new ErroProvedorIA(
      "validation",
      "OPENAI_MODEL_AGENTE ausente ou vazio — configure antes de usar ferramentas."
    );
  }
  return modelo;
}

function chave(): string {
  const k = process.env.OPENAI_API_KEY?.trim() ?? "";
  if (k === "") {
    throw new ErroProvedorIA(
      "validation",
      "OPENAI_API_KEY ausente ou vazia — configure antes de usar ferramentas."
    );
  }
  return k;
}

// ─── Nivel de trabalho -> `reasoning.effort` ──────────────────────────

/**
 * Os valores que gpt-5.2 ACEITA, medidos um por um.
 *
 * `minimal` responde 400 "Unsupported value: 'minimal' is not supported
 * with the 'gpt-5.2' model" — por isso ele NAO esta aqui. Oferecer um
 * nivel que a API recusa seria prometer capacidade nao provada, e a tela
 * le este mapa justamente para nao fazer isso.
 */
export const ESFORCO_POR_NIVEL: Readonly<Record<string, string>> = Object.freeze({
  rapido: "none",
  equilibrado: "low",
  avancado: "medium",
  maximo: "high",
});

/**
 * `reasoning` para o corpo do pedido.
 *
 * Nivel desconhecido NAO vira um default silencioso: ele simplesmente nao
 * manda `reasoning`, e a API usa o proprio default. Traduzir "avancado"
 * para um valor chutado seria pior que nao traduzir.
 */
export function montarEsforco(
  nivel: string | undefined
): { reasoning?: { effort: string } } {
  if (nivel === undefined) return {};
  const efeito = ESFORCO_POR_NIVEL[nivel];
  return efeito === undefined ? {} : { reasoning: { effort: efeito } };
}

// ─── Conversoes PURAS ─────────────────────────────────────────────────

export interface FerramentaOpenAI {
  readonly type: "function";
  readonly name: string;
  readonly description: string;
  readonly parameters: object;
}

/**
 * `FerramentaDeclarada[]` -> `tools` da Responses API.
 *
 * Forma PLANA: `{type, name, description, parameters}` no topo, e nao
 * `{type:"function", function:{...}}` como em `/chat/completions`. As duas
 * APIs tem formas diferentes, e usar a da outra devolve 400.
 */
export function montarFerramentasOpenAI(
  ferramentas: readonly FerramentaDeclarada[],
  mapa?: MapaDeNomes
): FerramentaOpenAI[] {
  return ferramentas.map((f) => ({
    type: "function" as const,
    name: mapa?.paraApi.get(f.nome) ?? sanitizarNome(f.nome),
    description: f.descricao,
    parameters: f.schemaEntrada,
  }));
}

/** Um item de `input`, na forma minima que usamos. */
export type ItemDaOpenAI =
  | { role: "user" | "assistant"; content: string }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

/**
 * Dialogo -> `input` da Responses API.
 *
 * `arguments` vai como STRING de JSON porque e assim que a API o devolve e
 * e assim que ela o espera. Mandar objeto produz 400.
 */
export function montarItensOpenAI(
  mensagens: readonly MensagemDoDialogo[],
  mapa?: MapaDeNomes
): ItemDaOpenAI[] {
  const itens: ItemDaOpenAI[] = [];
  for (const m of mensagens) {
    if (m.papel === "usuario") {
      itens.push({ role: "user", content: m.texto });
      continue;
    }
    if (m.papel === "assistente") {
      if (m.texto) itens.push({ role: "assistant", content: m.texto });
      for (const p of m.pedidos) {
        itens.push({
          type: "function_call",
          call_id: p.id,
          name: mapa?.paraApi.get(p.nome) ?? sanitizarNome(p.nome),
          // Objeto vira string aqui; string ja serializada passa direto.
          // Serializar duas vezes produziria `"{\"a\":1}"`, que a API
          // aceita e o modelo le como texto, nao como argumento.
          arguments: typeof p.argumentos === "string"
            ? p.argumentos
            : JSON.stringify(p.argumentos ?? {}),
        });
      }
      continue;
    }
    for (const r of m.respostas) {
      itens.push({ type: "function_call_output", call_id: r.id, output: r.conteudo });
    }
  }
  return itens;
}

/**
 * `output` da Responses API -> texto + pedidos.
 *
 * `arguments` chega como string de JSON. Ele e PARSEADO aqui, porque o
 * resto do sistema — validacao de entrada da Funcao, guard, auditoria —
 * trabalha com objeto. Uma string que nao parseia vira objeto vazio e a
 * validacao da Funcao recusa com codigo proprio: melhor que lancar, que
 * derrubaria o turno inteiro por um argumento torto.
 */
export function lerSaidaOpenAI(
  output: readonly unknown[] | undefined,
  mapa?: MapaDeNomes
): { texto: string | null; pedidos: PedidoDeFerramenta[] } {
  let texto: string | null = null;
  const pedidos: PedidoDeFerramenta[] = [];

  for (const bruto of output ?? []) {
    const o = bruto as {
      type?: string;
      name?: string;
      call_id?: string;
      arguments?: unknown;
      content?: unknown;
    };

    if (Array.isArray(o.content)) {
      for (const parte of o.content as { type?: string; text?: unknown }[]) {
        if (typeof parte.text === "string" && parte.text !== "") {
          texto = texto === null ? parte.text : texto + "\n" + parte.text;
        }
      }
      continue;
    }

    if (o.type === "function_call" &&
        typeof o.call_id === "string" && typeof o.name === "string") {
      let argumentos: unknown = {};
      if (typeof o.arguments === "string") {
        try { argumentos = JSON.parse(o.arguments); } catch { argumentos = {}; }
      } else if (typeof o.arguments === "object" && o.arguments !== null) {
        argumentos = o.arguments;
      }
      pedidos.push({
        id: o.call_id,
        // De volta ao `funcao_id` da CDS ANTES de qualquer coisa chegar ao
        // guard. Sem isto o guard receberia `calculadora_calcular`, que
        // nao existe no registry, e negaria uma Funcao legitima.
        nome: mapa?.paraFuncao.get(o.name) ?? o.name,
        argumentos,
      });
    }
  }

  return { texto, pedidos };
}

/**
 * `escolhaDeFerramenta` -> `tool_choice`.
 *
 * `"auto"` nao manda nada: e o default. Exigir UMA ferramenta e
 * `{type:"function", name}`.
 */
export function montarEscolhaOpenAI(
  escolha: PedidoIAComFerramentas["escolhaDeFerramenta"],
  mapa?: MapaDeNomes
): { tool_choice?: { type: "function"; name: string } } {
  if (escolha === undefined || escolha === "auto") return {};
  const nome = mapa?.paraApi.get(escolha.nome) ?? sanitizarNome(escolha.nome);
  return { tool_choice: { type: "function", name: nome } };
}

// ─── Erro classificado ────────────────────────────────────────────────

/**
 * Erro da OpenAI -> `ErroProvedorIA` das seis categorias do repositorio.
 *
 * Reusa `classificarRespostaDaOpenAI`, que separa o `429` de saldo do
 * `429` de rate limit. Sem essa separacao, um operador esperaria por uma
 * cota que nao volta.
 */
export function mapearErroOpenAI(status: number, corpo: string): ErroProvedorIA {
  const estado = classificarRespostaDaOpenAI(status, corpo);
  switch (estado) {
    case "auth_falhou":
      return new ErroProvedorIA("auth", "Credencial da OpenAI recusada.");
    case "billing_necessario":
      return new ErroProvedorIA("auth", "Conta da OpenAI sem credito.");
    case "permissao_negada":
      return new ErroProvedorIA("auth", "Projeto da OpenAI sem acesso a este modelo.");
    case "modelo_indisponivel":
      return new ErroProvedorIA("validation", "Modelo da OpenAI indisponivel.");
    default:
      // Rate limit cai aqui: e transitorio, e o job decide se repete.
      return new ErroProvedorIA("rate_limit", "OpenAI indisponivel agora.");
  }
}

// ─── A chamada ────────────────────────────────────────────────────────

export async function chamarOpenAIComFerramentas(
  pedido: PedidoIAComFerramentas
): Promise<RespostaIAComFerramentas> {
  const modelo = obterModeloOpenAI();
  const k = chave();
  const mapa = mapearNomes(pedido.ferramentas);
  const inicio = Date.now();

  const controle = new AbortController();
  const relogio = setTimeout(() => controle.abort(), TIMEOUT_MS);

  let status = 0;
  let corpo = "";
  try {
    const r = await fetch(`${BASE}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${k}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        model: modelo,
        // A instrucao de sistema vai em `instructions`, fora de `input`:
        // ela e comportamento, e nao um turno do dialogo.
        instructions: pedido.instrucao,
        input: montarItensOpenAI(pedido.mensagens, mapa),
        tools: montarFerramentasOpenAI(pedido.ferramentas, mapa),
        store: false,
        ...montarEscolhaOpenAI(pedido.escolhaDeFerramenta, mapa),
        ...montarEsforco(pedido.nivelDeTrabalho),
      }),
      signal: controle.signal,
      cache: "no-store",
    });
    status = r.status;
    corpo = await r.text();
  } catch (err) {
    // `TipoErroIA` tem SEIS categorias, e `timeout`/`network` nao estao
    // entre elas. As duas sao `transient`: o job decide se repete, e e
    // ele quem tem o contador de tentativas.
    const nome = (err as { name?: string }).name;
    throw new ErroProvedorIA(
      "transient",
      nome === "AbortError" ? "OpenAI nao respondeu no prazo." : "Falha de rede na OpenAI."
    );
  } finally {
    clearTimeout(relogio);
  }

  if (status < 200 || status >= 300) throw mapearErroOpenAI(status, corpo);

  let corpoJson: {
    output?: unknown[];
    model?: unknown;
    usage?: { input_tokens?: unknown; output_tokens?: unknown };
  };
  try {
    corpoJson = JSON.parse(corpo);
  } catch {
    throw new ErroProvedorIA("validation", "Resposta da OpenAI ilegivel.");
  }

  const { texto, pedidos } = lerSaidaOpenAI(corpoJson.output, mapa);

  if (texto === null && pedidos.length === 0) {
    throw new ErroProvedorIA(
      "validation",
      "OpenAI nao devolveu texto nem pedido de ferramenta — resposta vazia ou bloqueada."
    );
  }

  return {
    texto,
    pedidos,
    provedor: "openai",
    // O modelo REAL devolvido pela API, e nao o alias pedido: `gpt-5.2`
    // responde `gpt-5.2-2025-12-11`, e e essa a versao que respondeu.
    modelo: typeof corpoJson.model === "string" ? corpoJson.model : modelo,
    tokensEntrada: typeof corpoJson.usage?.input_tokens === "number"
      ? corpoJson.usage.input_tokens : 0,
    tokensSaida: typeof corpoJson.usage?.output_tokens === "number"
      ? corpoJson.usage.output_tokens : 0,
    tempoMs: Date.now() - inicio,
  };
}
