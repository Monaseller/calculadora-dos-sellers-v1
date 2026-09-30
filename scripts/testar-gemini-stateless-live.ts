/**
 * AGENT-FACTORY-F7b.4 — Gemini stateless com `store: false`, PROVADO.
 *
 * ── O que esta suite existe para corrigir ───────────────────────────
 *
 * O F4 concluiu que a Interactions API nao fechava o ciclo de ferramenta
 * sem `previous_interaction_id`, e portanto sem `store: true`. A
 * conclusao estava errada. O que faltava era um campo:
 *
 *   `function_call.signature` — string opaca que o modelo emite e que
 *   precisa voltar VERBATIM no turno seguinte.
 *
 * Reconstruir o passo com `{type, id, name, arguments}` descarta a
 * assinatura e a API responde 400 "Request contains an invalid
 * argument". Com a assinatura preservada, o ciclo fecha.
 *
 * ── Rede REAL, e por que tem de ser ─────────────────────────────────
 *
 * O erro do F4 foi de PROTOCOLO, e protocolo nao se prova com mock: um
 * mock aceitaria exatamente o corpo que eu escrevesse. Esta suite fala
 * com a API de verdade.
 *
 * Custo: quatro chamadas curtas.
 *
 * ── E o guard participa ─────────────────────────────────────────────
 *
 * O numero nao vem do modelo. A porta abaixo roda `autorizarFuncao` e
 * `resolverFuncao` de verdade — o mesmo guard das Functions CDS — e a
 * suite exige que o valor final tenha saido da calculadora.
 *
 * Roda com: npx tsx scripts/testar-gemini-stateless-live.ts
 */
import "./_server-only-inerte";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { FUNCOES, resolverFuncao, type ContextoFuncao } from "@/lib/agentes/funcoes/registry";
import { autorizarFuncao } from "@/lib/agentes/funcoes/guard";
import { declararFerramentas } from "@/lib/agentes/ia/ferramentas";
import { conversarComFerramentas } from "@/lib/agentes/ia/laco-ferramentas";
import { chamarGeminiComFerramentas, montarPassos } from "@/lib/ai-gateway/provedores/google-ferramentas";
import type { FatoConexao, FatoFuncao, FatoPermissao } from "@/lib/ia/skills/diagnostico";

const ID_CALC = "calculadora.calcular";
const DONO = "dono-f7b4-stateless";
const CONTEXTO: ContextoFuncao = Object.freeze({ userId: DONO, conexao: null });

const A = "184530.20";
const B = "137810.55";
/** 184530.20 - 137810.55. Conferido a mao, nao pelo modelo. */
const ESPERADO = "46719.65";

// ─── Saida sem segredo ────────────────────────────────────────────────

function valoresSensiveis(): string[] {
  const fora: string[] = [];
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== "string" || v.length < 12) continue;
    if (/KEY|SECRET|TOKEN|PASSWORD|SENHA|CREDENTIAL|DATABASE_URL|DIRECT_URL/i.test(k)) {
      fora.push(v);
    }
  }
  return fora;
}
function limpar(t: string): string {
  let saida = t;
  for (const v of valoresSensiveis()) saida = saida.split(v).join("[REDIGIDO]");
  return saida;
}
function log(t: string): void { console.log(limpar(t)); }

let passou = 0;
let falhou = 0;
function ok(nome: string, cond: boolean, detalhe = ""): void {
  if (cond) { passou++; log(`  PASS  ${nome}`); }
  else { falhou++; log(`  FAIL  ${nome}${detalhe ? ` — ${detalhe}` : ""}`); }
}
function secao(t: string): void { log(`\n${t}`); }

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
    } catch { /* tenta o proximo */ }
  }
  return false;
}

// ─── A porta: guard REAL, sem auditoria em producao ───────────────────
//
// Nao usa `executarFuncao` porque ele grava em `agente_funcao_chamadas`,
// que e append-only e nao pode ser limpa pela aplicacao. O guard e o
// executor sao os de verdade; o que nao acontece e a escrita de auditoria.

interface Contadores {
  guardChecks: number;
  execucoes: number;
  resultados: string[];
}

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
    // A uniao real e `sucesso | erro | invalida` — nao `ok`. Uma
    // comparacao com string que nao existe no tipo passa silenciosa em
    // JS; aqui o `tsc` a pegou.
    if (interp.tipo === "invalida") {
      return { tipo: "erro" as const, requestId: `req-${id}`, codigo: "contrato", retryable: false };
    }
    if (interp.tipo === "erro") {
      return { tipo: "erro" as const, requestId: `req-${id}`,
               codigo: interp.codigo, retryable: interp.retryable };
    }
    const dados = interp.data as { resultado?: string };
    if (typeof dados.resultado === "string") c.resultados.push(dados.resultado);
    return {
      tipo: "sucesso" as const, requestId: `req-${id}`,
      envelope: { data: interp.data }, auditoria: "completa" as const,
    };
  };
}

/** Aceita 46719.65 e 46.719,65: o modelo formata em pt-BR. */
function citaOValor(texto: string | null, valor: string): boolean {
  if (texto === null) return false;
  return texto.replace(/[^0-9]/g, "").includes(valor.replace(/[^0-9]/g, ""));
}

async function main(): Promise<void> {
  log("\n== CDS IA — AGENT-FACTORY-F7b.4: Gemini stateless (rede REAL) ==");
  const temEnv = carregarEnvLocal();
  log(`env carregado: ${temEnv ? "sim (.env.local)" : "NAO"}`);

  // ─── A. As conversoes puras, sem rede ──────────────────────────────

  secao("A. A conversao preserva o que a API exige (puro, sem rede)");
  {
    const passos = montarPassos([
      { papel: "usuario", texto: "quanto e 2-1?" },
      {
        papel: "assistente", texto: null,
        pedidos: [{ id: "c1", nome: ID_CALC, argumentos: { expressao: "2-1" },
                    assinatura: "ASSINATURA-OPACA-DE-TESTE" }],
      },
      { papel: "ferramenta", respostas: [{ id: "c1", conteudo: "1", erro: false }] },
    ]);

    const call = passos.find((p) => p.type === "function_call") as
      { signature?: string; id: string; name: string } | undefined;
    const res = passos.find((p) => p.type === "function_result") as
      { call_id: string; name: string } | undefined;

    ok("A1  a assinatura do pedido vira `signature` no passo",
      call?.signature === "ASSINATURA-OPACA-DE-TESTE");
    ok("A2  o `function_result` leva `call_id` do pedido",
      res?.call_id === "c1");
    ok("A3  e leva `name` — sem ele a API recusa por nome vazio",
      res?.name === ID_CALC);

    // Sem assinatura o campo NAO e enviado: string vazia seria pior.
    const semAss = montarPassos([
      { papel: "usuario", texto: "x" },
      { papel: "assistente", texto: null,
        pedidos: [{ id: "c9", nome: ID_CALC, argumentos: {} }] },
    ]);
    const call2 = semAss.find((p) => p.type === "function_call") as Record<string, unknown>;
    ok("A4  pedido SEM assinatura nao inventa o campo",
      !("signature" in call2));
    ok("A5  CONTROLE: a sonda de A1 acusaria a perda da assinatura",
      call?.signature !== undefined && call2.signature === undefined);
  }

  // ─── B. O ciclo REAL ───────────────────────────────────────────────

  secao("B. O ciclo completo contra a API real, com store:false");
  if (!process.env.GOOGLE_AI_API_KEY) {
    log("  GOOGLE_AI_API_KEY ausente — secao B nao pode rodar");
    ok("B0  GOOGLE_AI_API_KEY presente", false, "ausente");
  } else {
    const permissoes: FatoPermissao[] = [{ funcaoId: ID_CALC, nivel: "automatico" }];
    const ferramentas = declararFerramentas({
      catalogo: FUNCOES, permissoes,
    }).filter((f) => f.nome === ID_CALC);

    ok("B1  a calculadora esta declarada como automatica",
      ferramentas.length === 1);

    const c: Contadores = { guardChecks: 0, execucoes: 0, resultados: [] };
    const saida = await conversarComFerramentas({
      userId: DONO, agenteId: "ag-f7b4",
      instrucao:
        "Voce ajuda um lojista com contas. Use as ferramentas para QUALQUER calculo: " +
        "nunca faca a conta de cabeca. Responda em portugues, curto.",
      mensagemDoUsuario: `Quanto e ${A} - ${B}?`,
      ferramentas,
      adaptador: chamarGeminiComFerramentas,
      executar: criarPorta(permissoes, c) as never,
      escolhaDeFerramenta: { nome: ID_CALC },
      maxPassos: 4,
    });

    ok("B2  o laco concluiu, sem bloqueio",
      saida.motivo === "concluido", `motivo=${saida.motivo}`);
    ok("B3  houve mais de UM turno — o segundo turno nao foi recusado",
      saida.uso.turnos >= 2, `turnos=${saida.uso.turnos}`);
    ok("B4  o guard foi consultado",
      c.guardChecks >= 1, `checks=${c.guardChecks}`);
    ok("B5  a calculadora executou de verdade",
      c.execucoes >= 1, `execucoes=${c.execucoes}`);
    ok("B6  e o valor saiu da TOOL, nao do modelo",
      c.resultados.includes(ESPERADO), c.resultados.join(","));
    ok("B7  a resposta final cita o valor calculado",
      citaOValor(saida.texto, ESPERADO), JSON.stringify((saida.texto ?? "").slice(0, 90)));
    ok("B8  o provedor foi o google",
      saida.uso.provedor === "google", String(saida.uso.provedor));
    ok("B9  usage foi capturado",
      saida.uso.tokensEntrada > 0 && saida.uso.tokensSaida > 0,
      `in=${saida.uso.tokensEntrada} out=${saida.uso.tokensSaida}`);
    ok("B10 houve exatamente um passo de ferramenta, e ele executou",
      saida.passos.length === 1 && saida.passos[0].executou === true,
      JSON.stringify(saida.passos.map((p) => `${p.funcaoId}:${p.desfecho}`)));

    // ─── C. Multi-turno DEPOIS do ciclo ─────────────────────────────
    secao("C. Multi-turno depois do ciclo de ferramenta");
    const c2: Contadores = { guardChecks: 0, execucoes: 0, resultados: [] };
    const saida2 = await conversarComFerramentas({
      userId: DONO, agenteId: "ag-f7b4",
      instrucao: "Use as ferramentas para QUALQUER calculo. Responda curto.",
      mensagemDoUsuario: "Agora some 1000 ao resultado anterior.",
      ferramentas,
      historico: saida.mensagens,
      adaptador: chamarGeminiComFerramentas,
      executar: criarPorta(permissoes, c2) as never,
      maxPassos: 4,
    });
    ok("C1  o turno seguinte conclui, com o historico do ciclo anterior",
      saida2.motivo === "concluido", `motivo=${saida2.motivo}`);
    ok("C2  e o modelo levou o resultado anterior adiante",
      c2.resultados.some((r) => r.replace(/[^0-9]/g, "").includes("4771965")) ||
        citaOValor(saida2.texto, "47719.65"),
      `resultados=${c2.resultados.join(",")} texto=${JSON.stringify((saida2.texto ?? "").slice(0, 70))}`);
  }

  // ─── D. store:false segue intacto ──────────────────────────────────

  secao("D. A regra de privacidade nao foi trocada por um caminho verde");
  {
    const fonte = readFileSync(
      join(__dirname, "..", "lib", "ai-gateway", "provedores", "google-ferramentas.ts"), "utf-8");
    const semComentario = fonte
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    ok("D1  `store: false` continua no corpo da chamada",
      /store:\s*false/.test(semComentario));
    ok("D2  e `store: true` NAO aparece em codigo",
      !/store:\s*true/.test(semComentario));
    ok("D3  nem `previous_interaction_id`",
      !/previous_interaction_id/.test(semComentario));
    ok("D4  o portao do F4 nao lanca mais",
      !/throw new ErroProvedorIA\([\s\S]{0,80}CODIGO_RETORNO_BLOQUEADO/.test(semComentario));
  }

  log("\n-- placar ------------------------------------------------------");
  log(`  PASS ${passou}   FAIL ${falhou}`);
  if (falhou > 0) process.exitCode = 1;
}

void main().catch((e) => {
  log(`erro fatal: ${limpar(String((e as Error).message ?? "")).slice(0, 300)}`);
  process.exitCode = 1;
});
