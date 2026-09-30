/**
 * AGENT-FACTORY-F4 — a primeira conversa REAL com ferramenta.
 *
 * ── Esta suite GASTA DINHEIRO e vai a rede ──────────────────────────
 *
 * Diferente de toda a familia `testar-agentes-*`, ela chama Anthropic e
 * Google de verdade. Nao roda sozinha em nenhum fluxo: e invocada a mao,
 * num gate que autoriza o custo. Usa SOMENTE `calculadora.calcular` —
 * deterministica, sem banco, sem arquivo, sem marketplace, sem efeito
 * colateral. Se um dia ela passar a tocar planilha ou Funcao conectada,
 * deixou de ser esta suite.
 *
 * ── O que ela prova, e o que NAO prova ──────────────────────────────
 *
 * PROVA: o provedor recebe a declaracao, emite uma chamada de
 * ferramenta de verdade, recebe o resultado de volta e conclui a
 * conversa com aquele numero.
 *
 * NAO PROVA: a perna de banco de `executarFuncao` (abertura, desfecho,
 * auditoria em Postgres). A porta usada aqui roda o guard REAL e a
 * Funcao REAL, mas nao tem banco. Isso e limite declarado, nao
 * resultado escondido.
 *
 * ── Segredo ─────────────────────────────────────────────────────────
 *
 * Nenhuma chave e impressa. Toda saida passa por `limpar()`, que corta
 * qualquer coisa com a forma de credencial antes de chegar ao console.
 *
 * Rodar:
 *   ANTHROPIC_MODEL_AGENTE=... GOOGLE_AI_MODEL_AGENTE=... \
 *   npx tsx scripts/testar-agentes-live-tool-call.ts
 */
import "./_server-only-inerte";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { FUNCOES, resolverFuncao, type ContextoFuncao } from "@/lib/agentes/funcoes/registry";
import { autorizarFuncao } from "@/lib/agentes/funcoes/guard";
import { declararFerramentas } from "@/lib/agentes/ia/ferramentas";
import { conversarComFerramentas } from "@/lib/agentes/ia/laco-ferramentas";
import type { AdaptadorIAComFerramentas, MensagemDoDialogo } from "@/lib/agentes/ia/ferramentas";
import { chamarClaudeComFerramentas } from "@/lib/ai-gateway/provedores/anthropic-ferramentas";
import { MENSAGEM_DE_BLOQUEIO } from "@/lib/agentes/ia/falhas-de-ferramenta";
import { chamarGeminiComFerramentas } from "@/lib/ai-gateway/provedores/google-ferramentas";
import type { FatoConexao, FatoFuncao, FatoPermissao } from "@/lib/ia/skills/diagnostico";

const ID_CALC = "calculadora.calcular";
const DONO = "dono-do-teste-f4";
const CONTEXTO: ContextoFuncao = Object.freeze({ userId: DONO, conexao: null });

// ─── Saida sem segredo ────────────────────────────────────────────────
//
// Fail-closed: a lista abaixo nao depende de reconhecer o formato de
// cada provedor. Toda variavel de ambiente que PARECE credencial e
// substituida por marcador, venha ela de onde vier — inclusive de
// dentro de uma mensagem de erro do SDK.

function valoresSensiveis(): string[] {
  const fora: string[] = [];
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== "string" || v.length < 12) continue;
    if (/KEY|SECRET|TOKEN|PASSWORD|SENHA|CREDENTIAL|AUTH/i.test(k)) fora.push(v);
  }
  return fora;
}
const SENSIVEIS = valoresSensiveis();

function limpar(texto: string): string {
  let s = texto;
  for (const v of SENSIVEIS) s = s.split(v).join("«REDIGIDO»");
  // Rede de seguranca por FORMA, para o que nao veio do ambiente.
  s = s.replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, "«REDIGIDO»");
  s = s.replace(/AIza[A-Za-z0-9_-]{20,}/g, "«REDIGIDO»");
  s = s.replace(/Bearer\s+[A-Za-z0-9._-]{12,}/gi, "Bearer «REDIGIDO»");
  return s;
}
function log(...partes: unknown[]): void {
  console.log(limpar(partes.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")));
}

let passou = 0;
let falhou = 0;
function ok(nome: string, cond: boolean, detalhe?: string): void {
  if (cond) { passou += 1; log(`  PASS  ${nome}`); }
  else { falhou += 1; log(`  FAIL  ${nome}${detalhe ? ` — ${detalhe}` : ""}`); }
}
function secao(t: string): void {
  log(`\n── ${t} ${"─".repeat(Math.max(2, 60 - t.length))}`);
}

// ─── Ambiente ─────────────────────────────────────────────────────────
//
// O worktree nao tem `.env.local` (nao e versionado e vive so no repo
// principal). Carrega de la, sem NUNCA sobrescrever o que ja veio do
// processo — quem passou na linha de comando manda.

function carregarEnvLocal(): string {
  for (const caminho of [
    join(__dirname, "..", ".env.local"),
    join("C:", "Users", "USER", "Desktop", "calculadora-dos-sellers-v1", ".env.local"),
  ]) {
    try {
      const bruto = readFileSync(caminho, "utf-8");
      for (const linha of bruto.split("\n")) {
        const l = linha.trim();
        if (!l || l.startsWith("#")) continue;
        const i = l.indexOf("=");
        if (i === -1) continue;
        const k = l.slice(0, i).trim();
        let v = l.slice(i + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
        if (!(k in process.env)) process.env[k] = v;
      }
      return caminho;
    } catch { /* tenta o proximo */ }
  }
  return "(nenhum)";
}

// ─── A porta: guard REAL + Funcao REAL ────────────────────────────────

interface Contadores {
  pedidosDeFerramentaDoProvedor: number;
  guardChecks: number;
  functionExecutions: number;
  nomesPedidos: string[];
  resultadosDaTool: string[];
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
    c.functionExecutions += 1;
    const bruto = await definicao.executor(CONTEXTO, entrada.argumentos);
    const interp = definicao.interpretarSaida(bruto);
    if (interp.tipo === "invalida") {
      return { tipo: "erro" as const, requestId: `req-${id}`, codigo: "contrato", retryable: false };
    }
    if (interp.tipo === "erro") {
      return { tipo: "erro" as const, requestId: `req-${id}`, codigo: interp.codigo, retryable: interp.retryable };
    }
    const dados = interp.data as { resultado?: string };
    if (typeof dados.resultado === "string") c.resultadosDaTool.push(dados.resultado);
    return {
      tipo: "sucesso" as const, requestId: `req-${id}`,
      envelope: { data: interp.data }, auditoria: "completa" as const,
    };
  };
}

/** Envolve o adaptador real para contar o que o PROVEDOR pediu. */
function espiar(adaptador: AdaptadorIAComFerramentas, c: Contadores): AdaptadorIAComFerramentas {
  return async (pedido) => {
    const r = await adaptador(pedido);
    c.pedidosDeFerramentaDoProvedor += r.pedidos.length;
    for (const p of r.pedidos) c.nomesPedidos.push(p.nome);
    return r;
  };
}

const PERMITE_CALC: FatoPermissao[] = [{ funcaoId: ID_CALC, nivel: "automatico" }];

interface Uso {
  provedor: string | null; modelo: string | null;
  tokensEntrada: number; tokensSaida: number; tempoMs: number; turnos: number;
}
const usos: { rotulo: string; uso: Uso }[] = [];

interface Rodada {
  rotulo: string;
  adaptador: AdaptadorIAComFerramentas;
  mensagem: string;
  forcar: boolean;
  permissoes: readonly FatoPermissao[];
  historico?: readonly MensagemDoDialogo[];
  maxPassos?: number;
}

async function rodar(r: Rodada) {
  const c: Contadores = {
    pedidosDeFerramentaDoProvedor: 0, guardChecks: 0, functionExecutions: 0,
    nomesPedidos: [], resultadosDaTool: [],
  };
  const ferramentas = declararFerramentas({
    catalogo: FUNCOES, permissoes: [{ funcaoId: ID_CALC, nivel: "automatico" }],
  }).filter((f) => f.nome === ID_CALC);

  const saida = await conversarComFerramentas({
    userId: DONO, agenteId: "ag-f4",
    instrucao:
      "Voce ajuda um lojista com contas. Use as ferramentas para QUALQUER calculo: " +
      "nunca faca a conta de cabeca. Responda em portugues, curto.",
    mensagemDoUsuario: r.mensagem,
    ferramentas,
    historico: r.historico,
    adaptador: espiar(r.adaptador, c),
    executar: criarPorta(r.permissoes, c) as never,
    escolhaDeFerramenta: r.forcar ? { nome: ID_CALC } : "auto",
    maxPassos: r.maxPassos ?? 4,
  });
  usos.push({ rotulo: r.rotulo, uso: saida.uso as unknown as Uso });
  return { c, saida };
}

async function main(): Promise<void> {
  const origem = carregarEnvLocal();
  log("\n══ CDS IA — AGENT-FACTORY-F4: chamada REAL com ferramenta ══");
  log(`env carregado de: ${origem === "(nenhum)" ? "(nenhum)" : "(.env.local do repo principal)"}`);

  // ═══════════════════════════════════════════════════════════════════
  secao("1. Configuracao dos provedores (presenca, nunca valor)");
  // ═══════════════════════════════════════════════════════════════════
  const temChaveAnthropic = Boolean(process.env.ANTHROPIC_API_KEY);
  const temModeloAnthropic = Boolean(process.env.ANTHROPIC_MODEL_AGENTE?.trim());
  const temChaveGoogle = Boolean(process.env.GOOGLE_AI_API_KEY);
  const temModeloGoogle = Boolean(process.env.GOOGLE_AI_MODEL_AGENTE?.trim());

  log(`  ANTHROPIC_API_KEY        ${temChaveAnthropic ? "PRESENTE" : "AUSENTE"}`);
  log(`  ANTHROPIC_MODEL_AGENTE   ${temModeloAnthropic ? `= ${process.env.ANTHROPIC_MODEL_AGENTE}` : "AUSENTE"}`);
  log(`  GOOGLE_AI_API_KEY        ${temChaveGoogle ? "PRESENTE" : "AUSENTE"}`);
  log(`  GOOGLE_AI_MODEL_AGENTE   ${temModeloGoogle ? `= ${process.env.GOOGLE_AI_MODEL_AGENTE}` : "AUSENTE"}`);

  const rodarAnthropic = temChaveAnthropic && temModeloAnthropic;
  const rodarGoogle = temChaveGoogle && temModeloGoogle;

  // A conta que o modelo NAO pode fazer sozinho e acertar por acaso.
  const A = "184530.20";
  const B = "137810.55";
  const ESPERADO = "46719.65";

  // ═══════════════════════════════════════════════════════════════════
  secao("2. Controle: a Tool REAL produz o numero esperado");
  // ═══════════════════════════════════════════════════════════════════
  {
    const def = resolverFuncao(ID_CALC);
    const bruto = (await def.executor(CONTEXTO,
      { operacao: "subtract", valores: [A, B] })) as { resultado?: string };
    ok(`2.1 ${A} - ${B} = ${ESPERADO} pela Funcao real`,
      bruto.resultado === ESPERADO, String(bruto.resultado));
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("3. ANTHROPIC — protocolo (ferramenta FORCADA)");
  // ═══════════════════════════════════════════════════════════════════
  if (!rodarAnthropic) {
    log("  PULADO: chave ou modelo ausente.");
  } else {
    try {
      const { c, saida } = await rodar({
        rotulo: "anthropic/forcado", adaptador: chamarClaudeComFerramentas,
        mensagem: `Quanto sobra de R$ ${A} menos R$ ${B}?`,
        forcar: true, permissoes: PERMITE_CALC,
      });
      ok("3.1 o provedor emitiu ao menos UMA chamada de ferramenta",
        c.pedidosDeFerramentaDoProvedor >= 1, String(c.pedidosDeFerramentaDoProvedor));
      ok(`3.2 e o nome pedido e ${ID_CALC}`,
        c.nomesPedidos.every((n) => n === ID_CALC) && c.nomesPedidos.length >= 1,
        c.nomesPedidos.join(","));
      ok("3.3 o guard foi consultado", c.guardChecks >= 1, String(c.guardChecks));
      ok("3.4 a Funcao real executou", c.functionExecutions >= 1, String(c.functionExecutions));
      ok("3.5 nunca houve execucao sem guard",
        c.functionExecutions <= c.guardChecks, `${c.functionExecutions} <= ${c.guardChecks}`);
      ok(`3.6 o resultado da Tool e ${ESPERADO}`,
        c.resultadosDaTool.includes(ESPERADO), c.resultadosDaTool.join(","));
      ok("3.7 o resultado voltou ao provedor (ha turno de ferramenta no dialogo)",
        saida.mensagens.some((m) => m.papel === "ferramenta"));
      ok("3.8 o modelo produziu resposta final depois da ferramenta",
        typeof saida.texto === "string" && saida.texto.length > 0,
        String(saida.texto).slice(0, 80));
      // A prova que importa: o numero da resposta e o da Tool.
      const numeros: string[] = (saida.texto ?? "").replace(/\./g, "").replace(/,/g, ".")
        .match(/\d+\.\d{2}/g) ?? [];
      const semPontuacao = (saida.texto ?? "").replace(/[.,\s]/g, "");
      ok(`3.9 TOOL_RESULT == FINAL_NUMERIC_RESULT (${ESPERADO})`,
        numeros.includes(ESPERADO) || semPontuacao.includes(ESPERADO.replace(".", "")),
        `texto=${String(saida.texto).slice(0, 120)}`);
      log(`  resposta final: ${String(saida.texto).slice(0, 160)}`);
    } catch (e) {
      falhou += 1;
      log(`  FAIL  3.x Anthropic forcado lancou: ${String((e as Error).message).slice(0, 300)}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("4. ANTHROPIC — selecao NATURAL (sem forcar)");
  // ═══════════════════════════════════════════════════════════════════
  let anthropicNatural = "NOT_TESTED";
  if (rodarAnthropic) {
    try {
      const { c, saida } = await rodar({
        rotulo: "anthropic/natural", adaptador: chamarClaudeComFerramentas,
        mensagem:
          "Use suas ferramentas para calcular exatamente quanto sobra se eu tiver " +
          "R$ 184.530,20 de entradas e R$ 137.810,55 de saidas. Nao faca a conta mentalmente.",
        forcar: false, permissoes: PERMITE_CALC,
      });
      anthropicNatural = c.nomesPedidos.includes(ID_CALC) ? "PROVEN"
        : c.nomesPedidos.length > 0 ? "OTHER" : "NOT_SELECTED";
      log(`  MODEL_SELECTED_TOOL = ${c.nomesPedidos.join(",") || "NONE"}`);
      ok("4.1 o modelo escolheu a ferramenta sozinho",
        anthropicNatural === "PROVEN", anthropicNatural);
      if (anthropicNatural === "PROVEN") {
        ok("4.2 e o guard continuou no caminho",
          c.guardChecks >= 1 && c.functionExecutions <= c.guardChecks);
        ok(`4.3 o numero final e ${ESPERADO}`,
          (saida.texto ?? "").replace(/[.,\s]/g, "").includes(ESPERADO.replace(".", "")),
          String(saida.texto).slice(0, 120));
      }
      log(`  resposta final: ${String(saida.texto).slice(0, 160)}`);
    } catch (e) {
      log(`  ERRO natural Anthropic: ${String((e as Error).message).slice(0, 200)}`);
    }
  } else log("  PULADO.");

  // ═══════════════════════════════════════════════════════════════════
  secao("5. GOOGLE — protocolo (turno 1) e o limite do retorno");
  // ═══════════════════════════════════════════════════════════════════
  //
  // `maxPassos: 1` de proposito. O turno 2 do Gemini nao e bloqueado
  // por bug nosso: a Interactions API so aceita resultado de ferramenta
  // via `previous_interaction_id`, que exige `store: true` — e
  // `store: false` e regra de privacidade deste repositorio. Ver o
  // cabecalho de `google-ferramentas.ts`, secao ACHADO F4.
  //
  // Entao aqui se prova o que E provavel sem quebrar a regra: a
  // declaracao e aceita, o modelo emite chamada de verdade, o guard
  // roda e a Funcao real executa.
  let googleTurno1 = "NOT_TESTED";
  if (!rodarGoogle) {
    log("  PULADO: chave ou modelo ausente.");
  } else {
    try {
      const { c } = await rodar({
        rotulo: "google/forcado", adaptador: chamarGeminiComFerramentas,
        mensagem: `Quanto sobra de R$ ${A} menos R$ ${B}?`,
        forcar: true, permissoes: PERMITE_CALC, maxPassos: 1,
      });
      googleTurno1 = c.pedidosDeFerramentaDoProvedor >= 1 ? "PROVEN" : "FAILED";
      ok("5.1 a Interactions API ACEITOU a forma {type:function,name,description,parameters}",
        c.pedidosDeFerramentaDoProvedor >= 1, String(c.pedidosDeFerramentaDoProvedor));
      ok(`5.2 e o nome pedido e ${ID_CALC} — o Gemini aceita o ponto`,
        c.nomesPedidos.every((n) => n === ID_CALC) && c.nomesPedidos.length >= 1,
        c.nomesPedidos.join(","));
      ok("5.3 guard consultado", c.guardChecks >= 1, String(c.guardChecks));
      ok("5.4 Funcao real executou", c.functionExecutions >= 1, String(c.functionExecutions));
      ok("5.5 nunca houve execucao sem guard", c.functionExecutions <= c.guardChecks);
      ok(`5.6 resultado da Tool = ${ESPERADO}`,
        c.resultadosDaTool.includes(ESPERADO), c.resultadosDaTool.join(","));
    } catch (e) {
      falhou += 1;
      log(`  FAIL  5.x Google turno 1 lancou: ${String((e as Error).message).slice(0, 300)}`);
    }

    // ── 5.7 reconciliado na AGENT-FACTORY-F7b.4 ──────────────────────
    //
    // ANTES este bloco exigia que o segundo turno LANCASSE, porque o F4
    // concluiu que a Interactions API nao fechava o ciclo sem
    // `store: true`. O diagnostico estava errado: faltava devolver a
    // `signature` do `function_call`.
    //
    // Agora cobra-se o oposto — o ciclo FECHA — e mantem-se a exigencia
    // que nunca mudou: `store: false`. A prova completa, com guard e
    // multi-turno, vive em `testar-gemini-stateless-live.ts`; aqui fica o
    // caso minimo, para que esta suite nao volte a afirmar o contrario.
    //
    // O `id` e a `assinatura` sao SINTETICOS de proposito: eles provam
    // que a forma do corpo e aceita. Uma assinatura falsa e recusada pela
    // API, entao este caso usa um pedido SEM assinatura — que a API
    // aceita quando o `function_call` nao veio de um turno anterior real.
    try {
      const r = await chamarGeminiComFerramentas({
        instrucao: "Responda curto, em portugues.",
        mensagens: [
          { papel: "usuario", texto: "quanto e 2-1? Use a ferramenta." },
          { papel: "assistente", texto: null,
            pedidos: [{ id: "c1", nome: ID_CALC, argumentos: { expressao: "2-1" } }] },
          { papel: "ferramenta", respostas: [{ id: "c1", conteudo: "1", erro: false }] },
        ],
        ferramentas: declararFerramentas({
          catalogo: FUNCOES, permissoes: [{ funcaoId: ID_CALC, nivel: "automatico" }],
        }).filter((f) => f.nome === ID_CALC),
      });
      ok("5.7 devolver resultado ao Gemini NAO e mais barrado",
        r.texto !== null || r.pedidos.length > 0,
        `texto=${JSON.stringify((r.texto ?? "").slice(0, 80))}`);
      ok("5.8 e o provedor devolveu uso, sem exigir store:true",
        r.provedor === "google" && r.tokensEntrada > 0,
        `in=${r.tokensEntrada}`);
    } catch (e) {
      const m = String((e as Error).message);
      // Uma falha aqui NAO deve ser silenciada: se voltar a ser
      // impossivel, o relatorio tem de dizer, com a mensagem real.
      ok("5.7 devolver resultado ao Gemini NAO e mais barrado", false, m.slice(0, 180));
      ok("5.8 e o provedor devolveu uso, sem exigir store:true", false, "nao houve resposta");
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  secao("6. GOOGLE — selecao NATURAL (turno 1)");
  // ═══════════════════════════════════════════════════════════════════
  let googleNatural = "NOT_TESTED";
  if (rodarGoogle) {
    try {
      const { c } = await rodar({
        rotulo: "google/natural", adaptador: chamarGeminiComFerramentas,
        mensagem:
          "Use suas ferramentas para calcular exatamente quanto sobra se eu tiver " +
          "R$ 184.530,20 de entradas e R$ 137.810,55 de saidas. Nao faca a conta mentalmente.",
        forcar: false, permissoes: PERMITE_CALC, maxPassos: 1,
      });
      googleNatural = c.nomesPedidos.includes(ID_CALC) ? "PROVEN"
        : c.nomesPedidos.length > 0 ? "OTHER" : "NOT_SELECTED";
      log(`  MODEL_SELECTED_TOOL = ${c.nomesPedidos.join(",") || "NONE"}`);
      ok("6.1 o modelo escolheu a ferramenta sozinho",
        googleNatural === "PROVEN", googleNatural);
      ok(`6.2 e a Tool produziu ${ESPERADO} sem o modelo fazer a conta`,
        c.resultadosDaTool.includes(ESPERADO), c.resultadosDaTool.join(","));
    } catch (e) {
      log(`  ERRO natural Google: ${String((e as Error).message).slice(0, 200)}`);
    }
  } else log("  PULADO.");

  // ═══════════════════════════════════════════════════════════════════
  secao("7. NEGATIVO — provedor pede, mas NAO ha permissao");
  // ═══════════════════════════════════════════════════════════════════
  if (rodarAnthropic) {
    try {
      const { c, saida } = await rodar({
        rotulo: "anthropic/negativo", adaptador: chamarClaudeComFerramentas,
        mensagem: `Quanto sobra de R$ ${A} menos R$ ${B}?`,
        forcar: true, permissoes: [],           // NENHUMA permissao
      });
      ok("7.1 o provedor REALMENTE pediu a ferramenta",
        c.pedidosDeFerramentaDoProvedor >= 1, String(c.pedidosDeFerramentaDoProvedor));
      ok("7.2 o guard foi consultado", c.guardChecks >= 1, String(c.guardChecks));
      ok("7.3 functionExecutions = 0 — a Tool NAO rodou",
        c.functionExecutions === 0, String(c.functionExecutions));
      ok("7.4 nenhum resultado de Tool foi produzido",
        c.resultadosDaTool.length === 0, c.resultadosDaTool.join(","));
      // AGENT-FACTORY-F4.1: era aqui que o modelo REAL respondia
      // "a ferramenta nao esta disponivel, mas a conta da R$ 46.719,65".
      // Agora o turno FECHA e ele nao e chamado de novo.
      ok("7.5 o runtime FECHOU o turno — o modelo nao foi chamado outra vez",
        saida.motivo === "bloqueado_por_ferramenta", String(saida.motivo));
      ok("7.6 a recusa viajou no dialogo, para auditoria",
        saida.mensagens.some((m) => m.papel === "ferramenta"));
      ok("7.7 o texto final e do RUNTIME", saida.texto === MENSAGEM_DE_BLOQUEIO);
      ok(`7.8 e ${ESPERADO} NAO aparece em lugar nenhum da conversa`,
        !JSON.stringify(saida.mensagens).includes(ESPERADO) &&
          !(saida.texto ?? "").includes(ESPERADO),
        String(saida.texto).slice(0, 100));
      log(`  resposta final: ${String(saida.texto).slice(0, 160)}`);
    } catch (e) {
      falhou += 1;
      log(`  FAIL  7.x negativo lancou: ${String((e as Error).message).slice(0, 300)}`);
    }
  } else log("  PULADO.");

  // ═══════════════════════════════════════════════════════════════════
  secao("8. MULTI-TURNO real");
  // ═══════════════════════════════════════════════════════════════════
  if (rodarAnthropic) {
    try {
      const t1 = await rodar({
        rotulo: "anthropic/multi-1", adaptador: chamarClaudeComFerramentas,
        mensagem: "Calcule 1000 - 250 usando a calculadora.",
        forcar: true, permissoes: PERMITE_CALC,
      });
      ok("8.1 turno 1 devolveu 750.00",
        t1.c.resultadosDaTool.includes("750.00"), t1.c.resultadosDaTool.join(","));

      const t2 = await rodar({
        rotulo: "anthropic/multi-2", adaptador: chamarClaudeComFerramentas,
        mensagem: "Agora tire mais 100 daquele resultado.",
        forcar: false, permissoes: PERMITE_CALC,
        historico: t1.saida.mensagens,        // o dialogo inteiro do turno 1
      });
      ok("8.2 turno 2 usou a ferramenta de novo",
        t2.c.functionExecutions >= 1, String(t2.c.functionExecutions));
      ok("8.3 e chegou a 650.00 — o modelo LEMBROU do 750",
        t2.c.resultadosDaTool.includes("650.00"), t2.c.resultadosDaTool.join(","));
      ok("8.4 o guard valeu nos dois turnos",
        t2.c.functionExecutions <= t2.c.guardChecks);
      log(`  resposta final: ${String(t2.saida.texto).slice(0, 160)}`);
    } catch (e) {
      log(`  ERRO multi-turno: ${String((e as Error).message).slice(0, 200)}`);
    }
  } else log("  PULADO.");

  // ═══════════════════════════════════════════════════════════════════
  secao("9. Uso e custo (o que o provedor devolveu)");
  // ═══════════════════════════════════════════════════════════════════
  let algumUso = false;
  for (const { rotulo, uso } of usos) {
    const temNumeros = uso.tokensEntrada > 0 || uso.tokensSaida > 0;
    if (temNumeros) algumUso = true;
    log(`  ${rotulo.padEnd(22)} ${String(uso.provedor).padEnd(10)} ` +
        `${String(uso.modelo).padEnd(28)} in=${uso.tokensEntrada} out=${uso.tokensSaida} ` +
        `${uso.tempoMs}ms turnos=${uso.turnos}`);
  }
  ok("9.1 PROVIDER_USAGE_RECEIVED: ao menos uma rodada trouxe tokens",
    algumUso, String(usos.length));

  log(`\n── placar ${"─".repeat(54)}`);
  log(`  PASS ${passou}   FAIL ${falhou}`);
  log(`  ANTHROPIC_NATURAL = ${anthropicNatural}   GOOGLE_NATURAL = ${googleNatural}`);
  log(`  GOOGLE_TURNO_1 = ${googleTurno1}   (retorno de ferramenta: BLOQUEADO por store:false)`);
}

void main().then(
  () => process.exit(falhou > 0 ? 1 : 0),
  (e) => { console.error("ERRO NAO TRATADO:", limpar(String((e as Error).message ?? e))); process.exit(1); }
);
