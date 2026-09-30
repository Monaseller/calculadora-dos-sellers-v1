/**
 * AGENT-FACTORY-F7b.4.2 — OpenAI no runtime de agente, PROVADA.
 *
 * ── O que esta suite exige ──────────────────────────────────────────
 *
 *   OpenAI -> function call -> CDS Guard -> calculadora.calcular
 *          -> 46719.65 -> function_call_output -> OpenAI -> resposta
 *
 * E depois um turno NOVO que leve o resultado anterior adiante.
 *
 * O numero nao pode vir do modelo. A porta abaixo roda `autorizarFuncao`
 * e `resolverFuncao` de verdade, e a suite exige que `46719.65` tenha
 * saido da calculadora.
 *
 * ── RITMO: esta conta tem 3 RPM em gpt-5.2 ──────────────────────────
 *
 * Medido. Um ciclo de ferramenta gasta DUAS chamadas; dois ciclos gastam
 * quatro, e a quarta leva 429 dentro do mesmo minuto. Por isso ha espera
 * explicita entre os ciclos.
 *
 * Isso nao e contornar o limite: e respeitar um limite real. Um teste que
 * o ignorasse falharia por rate limit e alguem concluiria que a
 * integracao esta quebrada.
 *
 * Roda com: npx tsx scripts/testar-openai-runtime-live.ts
 */
import "./_server-only-inerte";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { FUNCOES, resolverFuncao, type ContextoFuncao } from "@/lib/agentes/funcoes/registry";
import { autorizarFuncao } from "@/lib/agentes/funcoes/guard";
import { declararFerramentas } from "@/lib/agentes/ia/ferramentas";
import { conversarComFerramentas } from "@/lib/agentes/ia/laco-ferramentas";
import {
  ESFORCO_POR_NIVEL, chamarOpenAIComFerramentas, lerSaidaOpenAI,
  montarEsforco, montarFerramentasOpenAI, montarItensOpenAI,
} from "@/lib/ai-gateway/provedores/openai-ferramentas";
import { mapearNomes } from "@/lib/ai-gateway/provedores/anthropic-ferramentas";
import type { FatoConexao, FatoFuncao, FatoPermissao } from "@/lib/ia/skills/diagnostico";

const ID_CALC = "calculadora.calcular";
const DONO = "dono-f742-openai";
const CONTEXTO: ContextoFuncao = Object.freeze({ userId: DONO, conexao: null });

const A = "184530.20";
const B = "137810.55";
/** Conferido a mao, nao pelo modelo. */
const ESPERADO = "46719.65";

/** 3 RPM medidos. Um minuto entre ciclos, com folga. */
const ESPERA_ENTRE_CICLOS_MS = 65000;

let passou = 0;
let falhou = 0;

function valoresSensiveis(): string[] {
  const fora: string[] = [];
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string" && v.length >= 12 &&
        /KEY|SECRET|TOKEN|PASSWORD|SENHA|CREDENTIAL|DATABASE_URL|DIRECT_URL/i.test(k)) {
      fora.push(v);
    }
  }
  return fora;
}
function limpar(t: string): string {
  let s = t;
  for (const v of valoresSensiveis()) s = s.split(v).join("[REDIGIDO]");
  return s;
}
function log(t: string): void { console.log(limpar(t)); }
function ok(nome: string, cond: boolean, detalhe = ""): void {
  if (cond) { passou++; log(`  PASS  ${nome}`); }
  else { falhou++; log(`  FAIL  ${nome}${detalhe ? ` — ${detalhe}` : ""}`); }
}
function secao(t: string): void { log(`\n${t}`); }
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

function carregarEnvLocal(): boolean {
  for (const caminho of [
    join(__dirname, "..", ".env.local"),
    join("C:", "Users", "USER", "Desktop", "calculadora-dos-sellers-v1", ".env.local"),
  ]) {
    try {
      for (const linha of readFileSync(caminho, "utf-8").split("\n")) {
        const l = linha.trim();
        if (!l || l.startsWith("#")) continue;
        const i = l.indexOf("=");
        if (i <= 0) continue;
        const k = l.slice(0, i).trim();
        if (!process.env[k]) process.env[k] = l.slice(i + 1).trim().replace(/^["']|["']$/g, "");
      }
      return true;
    } catch { /* proximo */ }
  }
  return false;
}

interface Contadores { guardChecks: number; execucoes: number; resultados: string[] }

/** Guard REAL, sem auditoria em producao. */
function criarPorta(permissoes: readonly FatoPermissao[], c: Contadores) {
  const funcoes: FatoFuncao[] = Object.keys(FUNCOES).map((id) => ({ id, existe: true }));
  const conexoes: readonly FatoConexao[] = [];
  return async (entrada: { funcaoId: unknown; argumentos: unknown }) => {
    const id = String(entrada.funcaoId);
    const def = Object.prototype.hasOwnProperty.call(FUNCOES, id) ? FUNCOES[id] : undefined;
    c.guardChecks += 1;
    const g = autorizarFuncao({
      funcaoId: entrada.funcaoId,
      conexaoNecessaria: def?.conexaoNecessaria ?? null,
      funcoes, permissoes, conexoes,
    });
    if (!g.permitido) {
      return g.estado === "aguardando_aprovacao"
        ? { tipo: "aguardando_aprovacao" as const, requestId: `req-${id}`, codigo: g.codigo }
        : { tipo: "negado" as const, requestId: `req-${id}`, codigo: g.codigo };
    }
    const definicao = resolverFuncao(id);
    const v = definicao.validarEntrada(entrada.argumentos);
    if (!v.valida) {
      return { tipo: "erro" as const, requestId: `req-${id}`, codigo: v.codigo, retryable: false };
    }
    c.execucoes += 1;
    const bruto = await definicao.executor(CONTEXTO, entrada.argumentos);
    const interp = definicao.interpretarSaida(bruto);
    if (interp.tipo === "invalida") {
      return { tipo: "erro" as const, requestId: `req-${id}`, codigo: "contrato", retryable: false };
    }
    if (interp.tipo === "erro") {
      return { tipo: "erro" as const, requestId: `req-${id}`,
               codigo: interp.codigo, retryable: interp.retryable };
    }
    const dados = interp.data as { resultado?: string };
    if (typeof dados.resultado === "string") c.resultados.push(dados.resultado);
    return { tipo: "sucesso" as const, requestId: `req-${id}`,
             envelope: { data: interp.data }, auditoria: "completa" as const };
  };
}

/** Aceita 46719.65 e 46.719,65. */
function citaOValor(texto: string | null, valor: string): boolean {
  if (texto === null) return false;
  return texto.replace(/[^0-9]/g, "").includes(valor.replace(/[^0-9]/g, ""));
}

async function main(): Promise<void> {
  log("\n== CDS IA — AGENT-FACTORY-F7b.4.2: OpenAI no runtime (rede REAL) ==");
  log(`env carregado: ${carregarEnvLocal() ? "sim" : "NAO"}`);

  // ─── A. As conversoes, sem rede ────────────────────────────────────

  secao("A. As conversoes puras carregam o que a API exige");
  {
    const ferramentas = declararFerramentas({
      catalogo: FUNCOES, permissoes: [{ funcaoId: ID_CALC, nivel: "automatico" }],
    }).filter((f) => f.nome === ID_CALC);
    const mapa = mapearNomes(ferramentas);

    const tools = montarFerramentasOpenAI(ferramentas, mapa);
    ok("A1  `tools` tem a forma PLANA da Responses API",
      tools.length === 1 && tools[0].type === "function" &&
        typeof tools[0].name === "string" && "parameters" in tools[0]);
    ok("A2  e o nome vai SEM ponto — a gramatica dos provedores nao aceita",
      !tools[0].name.includes("."), tools[0].name);

    const itens = montarItensOpenAI([
      { papel: "usuario", texto: "quanto e 2-1?" },
      { papel: "assistente", texto: null,
        pedidos: [{ id: "call_1", nome: ID_CALC, argumentos: { expressao: "2-1" } }] },
      { papel: "ferramenta", respostas: [{ id: "call_1", conteudo: "1", erro: false }] },
    ], mapa);

    const call = itens.find((i) => "type" in i && i.type === "function_call") as
      { call_id: string; name: string; arguments: string } | undefined;
    const saida = itens.find((i) => "type" in i && i.type === "function_call_output") as
      { call_id: string; output: string } | undefined;

    ok("A3  `arguments` vai como STRING de JSON — objeto produz 400",
      typeof call?.arguments === "string" &&
        JSON.stringify(JSON.parse(call.arguments)) === '{"expressao":"2-1"}');
    ok("A4  o resultado volta por `function_call_output` com o mesmo call_id",
      saida?.call_id === "call_1" && saida.output === "1");
    ok("A5  e o nome da chamada tambem e mapeado",
      call?.name === mapa.paraApi.get(ID_CALC));

    // Argumento que JA e string nao e serializado duas vezes.
    const jaString = montarItensOpenAI([
      { papel: "assistente", texto: null,
        pedidos: [{ id: "c", nome: ID_CALC, argumentos: '{"expressao":"9-8"}' }] },
    ], mapa);
    const c2 = jaString[0] as { arguments: string };
    ok("A6  string ja serializada NAO e serializada de novo",
      c2.arguments === '{"expressao":"9-8"}');

    // A volta: o nome do provedor vira `funcao_id` ANTES do guard.
    const lida = lerSaidaOpenAI([
      { type: "function_call", call_id: "x", name: mapa.paraApi.get(ID_CALC),
        arguments: '{"expressao":"1+1"}' },
      { content: [{ type: "output_text", text: "pronto" }] },
    ], mapa);
    ok("A7  o nome volta a ser `funcao_id` antes do guard",
      lida.pedidos[0]?.nome === ID_CALC, String(lida.pedidos[0]?.nome));
    ok("A8  e `arguments` e PARSEADO para objeto",
      JSON.stringify(lida.pedidos[0]?.argumentos) === '{"expressao":"1+1"}');
    ok("A9  o texto tambem e lido",
      lida.texto === "pronto", String(lida.texto));
    ok("A10 argumento ilegivel vira objeto vazio, e nao derruba o turno",
      (() => {
        const r = lerSaidaOpenAI([
          { type: "function_call", call_id: "y", name: "calculadora_calcular",
            arguments: "{isso nao e json" },
        ], mapa);
        return JSON.stringify(r.pedidos[0]?.argumentos) === "{}";
      })());
  }

  // ─── B. Nivel de trabalho: so o que a API aceita ────────────────────

  secao("B. Nivel de trabalho traduzido para valor REAL");
  {
    ok("B1  os quatro rotulos da CDS tem traducao",
      ["rapido", "equilibrado", "avancado", "maximo"]
        .every((n) => typeof ESFORCO_POR_NIVEL[n] === "string"));
    ok("B2  e os valores sao os MEDIDOS: none/low/medium/high",
      ESFORCO_POR_NIVEL.rapido === "none" &&
        ESFORCO_POR_NIVEL.equilibrado === "low" &&
        ESFORCO_POR_NIVEL.avancado === "medium" &&
        ESFORCO_POR_NIVEL.maximo === "high");
    // `minimal` responde 400 neste modelo. Nao pode aparecer.
    ok("B3  `minimal` NAO e oferecido — a API o recusa em gpt-5.2",
      !Object.values(ESFORCO_POR_NIVEL).includes("minimal"));
    ok("B4  nivel desconhecido nao manda `reasoning`, e nao chuta default",
      JSON.stringify(montarEsforco("inventado")) === "{}" &&
        JSON.stringify(montarEsforco(undefined)) === "{}");
    ok("B5  e nivel conhecido manda o valor certo",
      JSON.stringify(montarEsforco("maximo")) === '{"reasoning":{"effort":"high"}}');
  }

  // ─── C. O ciclo REAL ───────────────────────────────────────────────

  secao("C. O ciclo completo contra a API real");
  if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_MODEL_AGENTE) {
    ok("C0  OPENAI_API_KEY e OPENAI_MODEL_AGENTE presentes", false,
      "configure OPENAI_MODEL_AGENTE para rodar esta secao");
  } else {
    const permissoes: FatoPermissao[] = [{ funcaoId: ID_CALC, nivel: "automatico" }];
    const ferramentas = declararFerramentas({
      catalogo: FUNCOES, permissoes,
    }).filter((f) => f.nome === ID_CALC);

    const c: Contadores = { guardChecks: 0, execucoes: 0, resultados: [] };
    const saida = await conversarComFerramentas({
      userId: DONO, agenteId: "ag-f742",
      instrucao:
        "Voce ajuda um lojista com contas. Use as ferramentas para QUALQUER calculo: " +
        "nunca faca a conta de cabeca. Responda em portugues, curto.",
      mensagemDoUsuario: `Quanto e ${A} - ${B}?`,
      ferramentas,
      adaptador: chamarOpenAIComFerramentas,
      executar: criarPorta(permissoes, c) as never,
      escolhaDeFerramenta: { nome: ID_CALC },
      maxPassos: 4,
    });

    ok("C1  o laco concluiu, sem bloqueio",
      saida.motivo === "concluido", `motivo=${saida.motivo}`);
    ok("C2  houve mais de UM turno — o resultado voltou ao modelo",
      saida.uso.turnos >= 2, `turnos=${saida.uso.turnos}`);
    ok("C3  o guard foi consultado", c.guardChecks >= 1, String(c.guardChecks));
    ok("C4  a calculadora executou", c.execucoes >= 1, String(c.execucoes));
    ok(`C5  e o valor ${ESPERADO} saiu da TOOL, nao do modelo`,
      c.resultados.includes(ESPERADO), c.resultados.join(","));
    ok("C6  a resposta final cita o valor calculado",
      citaOValor(saida.texto, ESPERADO), JSON.stringify((saida.texto ?? "").slice(0, 90)));
    ok("C7  o provedor foi a openai",
      saida.uso.provedor === "openai", String(saida.uso.provedor));
    ok("C8  usage foi capturado",
      saida.uso.tokensEntrada > 0 && saida.uso.tokensSaida > 0,
      `in=${saida.uso.tokensEntrada} out=${saida.uso.tokensSaida}`);
    ok("C9  o modelo relatado e a versao CONCRETA que respondeu",
      typeof saida.uso.modelo === "string" && saida.uso.modelo !== "",
      String(saida.uso.modelo));
    ok("C10 houve exatamente um passo de ferramenta, e ele executou",
      saida.passos.length === 1 && saida.passos[0].executou === true,
      JSON.stringify(saida.passos.map((p) => `${p.funcaoId}:${p.desfecho}`)));

    // ─── D. Multi-turno ─────────────────────────────────────────────
    secao("D. Multi-turno depois do ciclo (esperando o limite de 3 RPM)");
    await esperar(ESPERA_ENTRE_CICLOS_MS);

    const c2: Contadores = { guardChecks: 0, execucoes: 0, resultados: [] };
    const saida2 = await conversarComFerramentas({
      userId: DONO, agenteId: "ag-f742",
      instrucao: "Use as ferramentas para QUALQUER calculo. Responda curto.",
      mensagemDoUsuario: "Agora some 1000 ao resultado anterior.",
      ferramentas,
      historico: saida.mensagens,
      adaptador: chamarOpenAIComFerramentas,
      executar: criarPorta(permissoes, c2) as never,
      maxPassos: 4,
    });
    ok("D1  o turno seguinte conclui com o historico do ciclo anterior",
      saida2.motivo === "concluido", `motivo=${saida2.motivo}`);
    ok("D2  e o modelo levou o resultado anterior adiante",
      c2.resultados.some((r) => r.replace(/[^0-9]/g, "").includes("4771965")) ||
        citaOValor(saida2.texto, "47719.65"),
      `resultados=${c2.resultados.join(",")} texto=${JSON.stringify((saida2.texto ?? "").slice(0, 70))}`);

    // ─── E. Fail-closed ─────────────────────────────────────────────
    secao("E. Fail-closed: bloqueado fecha o turno, sem improviso");
    await esperar(ESPERA_ENTRE_CICLOS_MS);

    const bloqueadas: FatoPermissao[] = [{ funcaoId: ID_CALC, nivel: "bloqueado" }];
    const c3: Contadores = { guardChecks: 0, execucoes: 0, resultados: [] };
    const saida3 = await conversarComFerramentas({
      userId: DONO, agenteId: "ag-f742",
      instrucao: "Use as ferramentas para QUALQUER calculo. Nunca calcule de cabeca.",
      mensagemDoUsuario: `Quanto e ${A} - ${B}?`,
      // A Funcao BLOQUEADA continua DECLARADA — F7b.0. E o guard que e a
      // cerca; nao declarar deixaria o modelo responder de cabeca.
      ferramentas: declararFerramentas({
        catalogo: FUNCOES, permissoes: bloqueadas,
      }).filter((f) => f.nome === ID_CALC),
      adaptador: chamarOpenAIComFerramentas,
      executar: criarPorta(bloqueadas, c3) as never,
      escolhaDeFerramenta: { nome: ID_CALC },
      maxPassos: 4,
    });
    ok("E1  o turno fecha por bloqueio de ferramenta",
      saida3.motivo === "bloqueado_por_ferramenta", `motivo=${saida3.motivo}`);
    ok("E2  a calculadora NUNCA executou",
      c3.execucoes === 0, String(c3.execucoes));
    ok("E3  e o guard foi quem negou",
      c3.guardChecks >= 1 && saida3.bloqueio?.desfecho === "negado",
      JSON.stringify(saida3.bloqueio));
    ok("E4  a resposta NAO traz o numero — nao houve improviso",
      !citaOValor(saida3.texto, ESPERADO),
      JSON.stringify((saida3.texto ?? "").slice(0, 80)));
  }

  // ─── F. Nada de runtime paralelo ───────────────────────────────────

  secao("F. Mesmo runtime, mesma cerca");
  {
    const ad = readFileSync(join(__dirname, "..", "lib", "ai-gateway", "provedores",
      "openai-ferramentas.ts"), "utf-8");
    const semCom = ad.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

    ok("F1  o adaptador NAO importa guard nem registry",
      !/autorizarFuncao|resolverFuncao|FUNCOES/.test(semCom));
    ok("F2  e nao tem laco proprio",
      !/conversarComFerramentas|for \(let passo/.test(semCom));
    ok("F3  `store: false` como nos outros provedores",
      /store: false/.test(semCom));
    ok("F4  e server-only", /^import "server-only";/m.test(ad));
    ok("F5  a chave e lida de UM lugar so",
      (ad.match(/process\.env\.OPENAI_API_KEY/g) ?? []).length === 1);
    ok("F6  o modelo vem de env, sem fallback embutido",
      /OPENAI_MODEL_AGENTE/.test(semCom) &&
        !/gpt-5|gpt-4/.test(semCom));
    ok("F7  reusa o mapa de nomes ja provado, em vez de um novo",
      /mapearNomes|sanitizarNome/.test(semCom));
  }

  log("\n-- placar ------------------------------------------------------");
  log(`  PASS ${passou}   FAIL ${falhou}`);
  if (falhou > 0) process.exitCode = 1;
}

void main().catch((e) => {
  log(`erro fatal: ${limpar(String((e as Error).message ?? "")).slice(0, 300)}`);
  process.exitCode = 1;
});
