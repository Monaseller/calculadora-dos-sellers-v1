/**
 * Suite de execucao deterministica — AGENTES-FASE1C.
 *
 * SEM rede, SEM banco, SEM IA. A prova que EXIGE banco (claim atomico,
 * concorrencia, retry, orfa) mora em
 * `scripts/testar-agentes-execucao-banco.ts`.
 *
 * ── O que esta suite prova ──────────────────────────────────────────
 *  1. MIGRATION, por leitura estatica: 1 indice, 3 funcoes, zero tabela,
 *     zero ALTER TABLE, e as marcas do claim (FOR UPDATE SKIP LOCKED,
 *     agente ativo, orfa de 5 min, tentativas < max_tentativas).
 *  2. GRANTS na migration: os REVOKE de anon/authenticated existem
 *     EXPLICITAMENTE nas tres — `REVOKE FROM PUBLIC` nao cobre esses
 *     dois papeis neste projeto (bug SEC1).
 *  3. REGISTRY: resolve `teste_fundacao`, LANCA em desconhecido.
 *  4. HANDLER: deterministico, puro, sem efeito externo.
 *  5. ISOLAMENTO ESTATICO: nenhuma IA/rede/SDK importada; o worker
 *     `.mjs` nao importa `.ts`; logs sem identificador.
 *  6. A 1B CONTINUA INTACTA: `tipos.ts` e `capability.ts` nao foram
 *     tocados por esta fase.
 *
 * ── Anti-vacuidade ─────────────────────────────────────────────────
 * Toda varredura prova primeiro que ACHOU o alvo, e so entao que ele e
 * o unico. Assert de ausencia sobre texto vazio passa sempre.
 */
import "./_server-only-inerte";
import "./_env-inerte";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

import {
  HANDLERS,
  TIPOS_REGISTRADOS,
  resolverHandler,
  ErroTipoTarefaDesconhecido,
} from "../lib/agentes/handlers/registry";
import {
  handlerTesteFundacao,
  TIPO_TESTE_FUNDACAO,
} from "../lib/agentes/handlers/teste-fundacao";
// AGENTES-FASE1D-b: a classe mudou de casa. Importar daqui e parte da
// prova — se `teste-fundacao.ts` voltar a defini-la ou a reexporta-la,
// os asserts da secao M quebram.
import { ErroEntradaTarefa } from "../lib/agentes/erros";
// AGENT-VERTICAL-SLICE-V1: o terceiro handler. Importado como VALOR
// porque a secao P o EXECUTA com doubles — os casos centrais deste gate
// nao podem depender de grep de fonte.
import {
  criarHandlerConversa,
  prepararPedidoConversa,
  validarRespostaConversa,
  INSTRUCAO_MINIMA_CONVERSA,
  TIPO_CONVERSA,
} from "../lib/agentes/handlers/conversa";
// O seam de teste que JA existe. Nenhum provedor real e alcancado: o
// fake nao tem rede, nao tem SDK e nao le env.
import { criarAdaptadorFake } from "../lib/agentes/ia/fake";
import type { LinhaAgente } from "../lib/agentes/tipos";
import { TIPOS_ERRO_TAREFA, type ContextoTarefa } from "../lib/agentes/tipos-execucao";
import { INTERVALO_HEARTBEAT_MS } from "../lib/agentes/executar-tarefa";
import {
  decidirAcesso,
  ROTAS_COM_SEGREDO,
  ROTAS_PUBLICAS,
  PAGINAS_PUBLICAS,
} from "../lib/middleware-rotas";
import { transicaoTarefaPermitida, STATUS_TAREFA } from "../lib/agentes/tipos";

const RAIZ = join(__dirname, "..");
const fonte = (rel: string) => readFileSync(join(RAIZ, rel), "utf8");

const codigo = (rel: string) =>
  fonte(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const sql = (rel: string) =>
  fonte(rel)
    .split("\n")
    .map((l) => {
      const i = l.indexOf("--");
      return i === -1 ? l : l.slice(0, i);
    })
    .join("\n");

let passou = 0;
let falhou = 0;
function ok(nome: string, condicao: boolean) {
  if (condicao) passou++;
  else {
    falhou++;
    console.error(`  x ${nome}`);
  }
}
const conta = (t: string, re: RegExp) => (t.match(re) ?? []).length;

const MIGRATION = "supabase/migrations/20260917_agentes_execucao.sql";
const REGISTRY = "lib/agentes/handlers/registry.ts";
const HANDLER = "lib/agentes/handlers/teste-fundacao.ts";
const EXECUTOR = "lib/agentes/executar-tarefa.ts";
const CAP_WORKER = "lib/agentes/capability-worker.ts";
const ROTA = "app/api/internal/agentes/executar/route.ts";
const WORKER = "scripts/agentes-worker.mjs";
const TIPOS_EXEC = "lib/agentes/tipos-execucao.ts";

const AS_3_RPCS = ["claim_next_agente_tarefa", "concluir_tarefa", "falhar_tarefa"];

function contexto(entrada: Record<string, unknown>): ContextoTarefa {
  return {
    tarefaId: "11111111-1111-1111-1111-111111111111",
    agenteId: "22222222-2222-2222-2222-222222222222",
    userId: "user-teste",
    tipo: TIPO_TESTE_FUNDACAO,
    entrada,
    tentativa: 1,
    maxTentativas: 3,
  };
}
const semProgresso = () => {};

async function main() {
  const mig = sql(MIGRATION);
  const migBruta = fonte(MIGRATION);
  const reg = codigo(REGISTRY);
  const han = codigo(HANDLER);
  const exe = codigo(EXECUTOR);
  const capw = codigo(CAP_WORKER);
  const capwBruta = fonte(CAP_WORKER);
  const rota = codigo(ROTA);
  const wrk = codigo(WORKER);
  const tex = codigo(TIPOS_EXEC);

  // ═══ A. MIGRATION — forma e proibicoes ════════════════════════════
  console.log("\nA. Migration — forma");
  ok("A0  migration sem comentarios tem corpo", mig.trim().length > 800);
  ok("A0b o strip removeu comentarios de fato", migBruta.length > mig.length * 1.5);

  ok("A1  exatamente 1 CREATE INDEX", conta(mig, /CREATE\s+INDEX/gi) === 1);
  ok("A2  o indice e idx_agente_tarefas_fila parcial",
     /idx_agente_tarefas_fila[\s\S]*?WHERE\s+status\s+IN\s*\(\s*'pendente'\s*,\s*'rodando'\s*\)/i.test(mig));
  ok("A3  exatamente 3 CREATE FUNCTION", conta(mig, /CREATE\s+OR\s+REPLACE\s+FUNCTION/gi) === 3);
  ok("A4  ZERO CREATE TABLE", conta(mig, /CREATE\s+TABLE/gi) === 0);
  ok("A5  ZERO ALTER TABLE", conta(mig, /ALTER\s+TABLE/gi) === 0);
  ok("A6  ZERO ADD COLUMN", conta(mig, /ADD\s+COLUMN/gi) === 0);
  ok("A7  ZERO CREATE TRIGGER", conta(mig, /CREATE\s+TRIGGER/gi) === 0);
  ok("A8  ZERO ROW LEVEL SECURITY", conta(mig, /ROW\s+LEVEL\s+SECURITY/gi) === 0);
  ok("A9  ZERO POLICY", conta(mig, /\bPOLICY\b/gi) === 0);
  ok("A10 ZERO ALTER DEFAULT PRIVILEGES", conta(mig, /ALTER\s+DEFAULT\s+PRIVILEGES/gi) === 0);
  ok("A11 ZERO DROP executavel", conta(mig, /\bDROP\b/gi) === 0);
  ok("A12 ZERO CASCADE", conta(mig, /CASCADE/gi) === 0);
  ok("A13 ZERO INSERT/UPDATE/DELETE fora das funcoes",
     conta(mig, /\bDELETE\s+FROM\b/gi) === 0 && conta(mig, /\bINSERT\s+INTO\b/gi) === 0);
  ok("A14 rollback documentado so em comentario",
     /DROP FUNCTION IF EXISTS public\.claim_next_agente_tarefa/.test(migBruta));
  ok("A15 as 3 funcoes tem nome esperado", AS_3_RPCS.every((f) => new RegExp(`FUNCTION\\s+public\\.${f}\\s*\\(`).test(mig)));

  // ═══ B. MIGRATION — seguranca das 3 RPCs ══════════════════════════
  console.log("B. Migration — seguranca das RPCs");
  ok("B0  ha REVOKEs a inspecionar (anti-vacuidade)", conta(mig, /REVOKE\s+EXECUTE/gi) >= 9);
  for (const fn of AS_3_RPCS) {
    const corpoFn = mig.slice(mig.indexOf(`FUNCTION public.${fn}(`));
    const bloco = corpoFn.slice(0, corpoFn.indexOf("CREATE OR REPLACE FUNCTION", 10) + 1 || undefined);
    ok(`B1 ${fn}: SECURITY INVOKER`, /SECURITY\s+INVOKER/i.test(bloco));
    ok(`B2 ${fn}: SET search_path = public`, /SET\s+search_path\s*=\s*public/i.test(bloco));
  }
  // Os 3 REVOKE explicitos por funcao — o de PUBLIC nao cobre anon nem
  // authenticated neste projeto (bug SEC1, ver cabecalho da migration).
  for (const fn of AS_3_RPCS) {
    ok(`B3 ${fn}: REVOKE FROM PUBLIC`, new RegExp(`REVOKE\\s+EXECUTE[\\s\\S]{0,120}?${fn}[\\s\\S]{0,80}?FROM\\s+PUBLIC`, "i").test(mig));
    ok(`B4 ${fn}: REVOKE FROM anon`, new RegExp(`REVOKE\\s+EXECUTE[\\s\\S]{0,120}?${fn}[\\s\\S]{0,80}?FROM\\s+anon`, "i").test(mig));
    ok(`B5 ${fn}: REVOKE FROM authenticated`, new RegExp(`REVOKE\\s+EXECUTE[\\s\\S]{0,120}?${fn}[\\s\\S]{0,80}?FROM\\s+authenticated`, "i").test(mig));
    ok(`B6 ${fn}: GRANT TO service_role`, new RegExp(`GRANT\\s+EXECUTE[\\s\\S]{0,120}?${fn}[\\s\\S]{0,80}?TO\\s+service_role`, "i").test(mig));
  }
  ok("B7  nenhum GRANT para anon", !/GRANT\s+EXECUTE[\s\S]{0,160}?TO\s+anon/i.test(mig));
  ok("B8  nenhum GRANT para authenticated", !/GRANT\s+EXECUTE[\s\S]{0,160}?TO\s+authenticated/i.test(mig));
  ok("B9  3 REVOKE FROM anon (um por funcao)", conta(mig, /REVOKE\s+EXECUTE[\s\S]{0,160}?FROM\s+anon/gi) === 3);
  ok("B10 3 REVOKE FROM authenticated", conta(mig, /REVOKE\s+EXECUTE[\s\S]{0,160}?FROM\s+authenticated/gi) === 3);
  ok("B11 3 GRANT TO service_role", conta(mig, /GRANT\s+EXECUTE[\s\S]{0,160}?TO\s+service_role/gi) === 3);

  // ═══ C. MIGRATION — o claim, condicao por condicao ════════════════
  console.log("C. Migration — o claim");
  const claim = mig.slice(mig.indexOf("FUNCTION public.claim_next_agente_tarefa"),
                          mig.indexOf("FUNCTION public.concluir_tarefa"));
  ok("C0  o corpo do claim foi isolado (anti-vacuidade)", claim.length > 300);
  ok("C1  FOR UPDATE ... SKIP LOCKED", /FOR\s+UPDATE\s+OF\s+t\s+SKIP\s+LOCKED/i.test(claim));
  ok("C2  trava SO agente_tarefas (OF t)", /FOR\s+UPDATE\s+OF\s+t\b/i.test(claim) && !/FOR\s+UPDATE\s+SKIP/i.test(claim));
  ok("C3  filtra agente ATIVO", /JOIN\s+public\.agentes/i.test(claim) && /a\.ativo/i.test(claim));
  ok("C4  o JOIN usa o PAR (id, user_id)",
     /a\.id\s*=\s*t\.agente_id/i.test(claim) && /a\.user_id\s*=\s*t\.user_id/i.test(claim));
  ok("C5  tentativas < max_tentativas", /t\.tentativas\s*<\s*t\.max_tentativas/i.test(claim));
  ok("C6  considera pendente", /t\.status\s*=\s*'pendente'/i.test(claim));
  ok("C7  recupera orfa em rodando", /t\.status\s*=\s*'rodando'/i.test(claim));
  ok("C8  limite de orfa e 5 minutos", /interval\s*'5 minutes'/i.test(claim));
  ok("C9  compara heartbeat com now() - limite", /heartbeat_em\s*<\s*now\(\)\s*-/i.test(claim));
  ok("C10 incrementa tentativas NO CLAIM", /tentativas\s*=\s*tentativas\s*\+\s*1/i.test(claim));
  ok("C11 poe em rodando", /status\s*=\s*'rodando'/i.test(claim));
  ok("C12 grava iniciado_em e heartbeat_em", /iniciado_em\s*=\s*now\(\)/i.test(claim) && /heartbeat_em\s*=\s*now\(\)/i.test(claim));
  ok("C13 ORDER BY criado_em (FIFO)", /ORDER\s+BY\s+t\.criado_em/i.test(claim));
  ok("C14 devolve NULL quando nao acha", /IF\s+NOT\s+FOUND\s+THEN\s+RETURN\s+NULL/i.test(claim.replace(/\s+/g, " ")));
  ok("C15 o claim NAO cancela tarefa de agente inativo",
     !/status\s*=\s*'cancelado'/i.test(claim) && !/DELETE/i.test(claim));

  // ═══ D. MIGRATION — concluir e falhar ═════════════════════════════
  console.log("D. Migration — conclusao e falha");
  const concl = mig.slice(mig.indexOf("FUNCTION public.concluir_tarefa"), mig.indexOf("FUNCTION public.falhar_tarefa"));
  const falha = mig.slice(mig.indexOf("FUNCTION public.falhar_tarefa"));
  ok("D0  corpos isolados (anti-vacuidade)", concl.length > 200 && falha.length > 200);
  ok("D1  concluir exige status rodando", /status\s*=\s*'rodando'/i.test(concl));
  ok("D2  concluir forca progresso 100", /progresso\s*=\s*100/i.test(concl));
  ok("D3  concluir persiste resultado", /resultado\s*=\s*COALESCE\(p_resultado/i.test(concl));
  ok("D4  concluir LANCA fora de ordem", /RAISE\s+EXCEPTION/i.test(concl));
  ok("D5  falhar exige status rodando", /status\s*=\s*'rodando'/i.test(falha));
  ok("D6  falhar decide pendente vs erro por tentativas",
     /tentativas\s*<\s*t?\.?max_tentativas[\s\S]{0,40}THEN\s*'pendente'/i.test(falha.replace(/\s+/g, " ")));
  ok("D7  falhar grava erro_tipo nos dois casos", /erro_tipo\s*=\s*btrim\(p_erro_tipo\)/i.test(falha));
  ok("D8  falhar exige erro_tipo nao vazio", /p_erro_tipo\s+IS\s+NULL\s+OR\s+length\(btrim\(p_erro_tipo\)\)\s*=\s*0/i.test(falha));
  ok("D9  falhar trunca a mensagem", /left\(COALESCE\(p_erro_mensagem/i.test(falha));
  ok("D10 falhar LANCA fora de ordem", /RAISE\s+EXCEPTION/i.test(falha));
  ok("D11 nenhuma das duas aceita user_id do chamador",
     !/p_user_id/i.test(concl) && !/p_user_id/i.test(falha) && !/p_user_id/i.test(claim));

  // ═══ E. REGISTRY ══════════════════════════════════════════════════
  console.log("E. Registry");
  ok("E0  ha o que inspecionar (anti-vacuidade)", reg.length > 200);
  // AGENTES-FASE1D-d: `resolverHandler` devolve FABRICA, nao handler.
  // Resolver depende do tipo; construir depende do dono.
  ok("E1  resolve teste_fundacao como FABRICA", typeof resolverHandler(TIPO_TESTE_FUNDACAO) === "function");
  ok("E1a a fabrica de teste_fundacao devolve o handler existente",
     resolverHandler(TIPO_TESTE_FUNDACAO)("dono-qualquer") === handlerTesteFundacao);
  ok("E1b a fabrica de teste_fundacao IGNORA o dono (aridade 0)",
     resolverHandler(TIPO_TESTE_FUNDACAO).length === 0);
  ok("E1c dois donos diferentes recebem o MESMO handler de teste_fundacao (nao ha capability)",
     resolverHandler(TIPO_TESTE_FUNDACAO)("a") === resolverHandler(TIPO_TESTE_FUNDACAO)("b"));
  ok("E1d resolve analise_vendas como FABRICA", typeof resolverHandler("analise_vendas") === "function");
  ok("E1e a fabrica de analise_vendas RECEBE o dono (aridade 1)",
     resolverHandler("analise_vendas").length === 1);
  // AGENT-VERTICAL-SLICE-V1: entrou `conversa`. A allowlist ganhou um
  // membro NOMEADO — nao foi afrouxada para `includes`, nem para um piso
  // `>= 3`, nem para wildcard. Continua reprovando tipo A MENOS e tipo A
  // MAIS, que e a unica forma de um registry novo nao passar
  // despercebido por esta suite.
  const TIPOS_ESPERADOS = "analise_vendas,conversa,teste_fundacao";
  const uniaoDeTipos = (tipos: readonly string[]) => [...tipos].sort().join(",");
  ok("E2  exatamente 3 tipos registrados", TIPOS_REGISTRADOS.length === 3);
  ok("E3  os tipos sao teste_fundacao, analise_vendas e conversa",
     uniaoDeTipos(TIPOS_REGISTRADOS) === TIPOS_ESPERADOS);
  ok("E3a CONTROLE NEGATIVO: o oraculo reprova tipo A MENOS",
     uniaoDeTipos(["analise_vendas", "teste_fundacao"]) !== TIPOS_ESPERADOS);
  ok("E3b CONTROLE NEGATIVO: o oraculo reprova tipo A MAIS",
     uniaoDeTipos(["analise_vendas", "conversa", "teste_fundacao", "x"]) !== TIPOS_ESPERADOS);
  ok("E3c CONTROLE NEGATIVO: o oraculo reprova tipo TROCADO",
     uniaoDeTipos(["analise_vendas", "conversas", "teste_fundacao"]) !== TIPOS_ESPERADOS);
  ok("E3d o oraculo aprova o conjunto certo em ordem embaralhada",
     uniaoDeTipos(["conversa", "teste_fundacao", "analise_vendas"]) === TIPOS_ESPERADOS);
  ok("E3e a constante do handler e a chave usada no registry",
     TIPO_CONVERSA === "conversa" && TIPOS_REGISTRADOS.includes(TIPO_CONVERSA));

  // conversa e FABRICA por dono, como analise_vendas. Um handler global
  // compartilhado leria o agente do PRIMEIRO dono que passasse por aqui.
  ok("E3f resolve conversa como FABRICA", typeof resolverHandler("conversa") === "function");
  ok("E3g a fabrica de conversa RECEBE o dono (aridade 1)", resolverHandler("conversa").length === 1);
  {
    const construirConversa = resolverHandler("conversa");
    const cA = construirConversa("dono-A");
    const cB = construirConversa("dono-B");
    ok("E3h donos diferentes produzem handlers de conversa DIFERENTES", cA !== cB);
    ok("E3i o handler de conversa mantem 2 parametros", cA.length === 2 && cB.length === 2);
    ok("E3j nem o mesmo dono reaproveita instancia global", construirConversa("dono-A") !== cA);
  }
  ok("E4  LANCA em tipo desconhecido (fechado)", (() => {
       try { resolverHandler("nao_existe"); return false; } catch (e) { return e instanceof ErroTipoTarefaDesconhecido; }
     })());
  ok("E5  LANCA em tipo nao-string", (() => {
       try { resolverHandler(42); return false; } catch (e) { return e instanceof ErroTipoTarefaDesconhecido; }
     })());
  ok("E6  LANCA em undefined/null", (() => {
       let n = 0;
       for (const v of [undefined, null]) { try { resolverHandler(v); } catch { n++; } }
       return n === 2;
     })());
  // Poluicao de prototipo: `toString` existe em Object.prototype e nao
  // pode ser confundida com handler registrado.
  ok("E7  LANCA em chave herdada do prototipo (toString)", (() => {
       try { resolverHandler("toString"); return false; } catch (e) { return e instanceof ErroTipoTarefaDesconhecido; }
     })());
  ok("E8  o mapa e congelado", Object.isFrozen(HANDLERS));
  ok("E9  registry nao importa IA/gateway/SDK",
     !/ai-gateway|anthropic|@google\/genai|openai/i.test(reg));

  // ═══ F. HANDLER — determinismo e pureza ═══════════════════════════
  console.log("F. Handler teste_fundacao");
  const r1 = await handlerTesteFundacao(contexto({ mensagem: "teste" }), semProgresso);
  ok("F1  resultado exato do contrato",
     JSON.stringify(r1) === JSON.stringify({ eco: "teste", executado: true }));
  const r2 = await handlerTesteFundacao(contexto({ mensagem: "teste" }), semProgresso);
  ok("F2  deterministico entre chamadas", JSON.stringify(r1) === JSON.stringify(r2));
  ok("F3  deterministico em 100 execucoes", await (async () => {
       for (let i = 0; i < 100; i++) {
         const r = await handlerTesteFundacao(contexto({ mensagem: "x" }), semProgresso);
         if (JSON.stringify(r) !== JSON.stringify({ eco: "x", executado: true })) return false;
       }
       return true;
     })());
  ok("F4  NAO muta a entrada", await (async () => {
       const entrada = { mensagem: "teste", extra: { a: 1 } };
       const antes = JSON.stringify(entrada);
       await handlerTesteFundacao(contexto(entrada), semProgresso);
       return JSON.stringify(entrada) === antes;
     })());
  ok("F5  devolve objeto NOVO (nao referencia a entrada)", await (async () => {
       const entrada = { mensagem: "teste" };
       const r = await handlerTesteFundacao(contexto(entrada), semProgresso);
       return r !== (entrada as unknown);
     })());
  ok("F6  progresso 0 -> 50 -> 100", await (async () => {
       const vistos: number[] = [];
       await handlerTesteFundacao(contexto({ mensagem: "t" }), (p) => vistos.push(p));
       return JSON.stringify(vistos) === JSON.stringify([0, 50, 100]);
     })());
  ok("F7  entrada invalida LANCA ErroEntradaTarefa", await (async () => {
       let n = 0;
       for (const e of [{}, { mensagem: 123 }, { mensagem: "" }, { mensagem: null }]) {
         try { await handlerTesteFundacao(contexto(e as Record<string, unknown>), semProgresso); }
         catch (err) { if (err instanceof ErroEntradaTarefa) n++; }
       }
       return n === 4;
     })());
  ok("F8  handler sem fetch/rede/SDK/env/banco",
     !/fetch\(|axios|https?:\/\/|process\.env|createClient|supabase/i.test(han));
  ok("F9  handler sem Date.now nem Math.random", !/Date\.now|Math\.random|new Date/.test(han));
  ok("F10 idempotencia documentada no handler", /IDEMPOTENTE|idempotente/i.test(fonte(HANDLER)));

  // ═══ G. ISOLAMENTO ESTATICO ═══════════════════════════════════════
  console.log("G. Isolamento");
  const proibidosIA = /ai-gateway|anthropic|@google\/genai|openai|gerarConteudoFake|provedores\//i;
  for (const [nome, txt] of [["registry", reg], ["handler", han], ["executor", exe],
                             ["capability-worker", capw], ["rota", rota], ["tipos-execucao", tex]] as const) {
    ok(`G1 ${nome}: zero IA/gateway`, !proibidosIA.test(txt));
  }
  ok("G2  executor nao chama rede diretamente", !/fetch\(|axios/i.test(exe));
  ok("G3  worker .mjs NAO importa .ts", !/from\s+["'][^"']*\.ts["']|require\(["'][^"']*\.ts["']\)/.test(wrk));
  ok("G4  worker .mjs nao importa lib/ da aplicacao", !/from\s+["']\.\.\/lib\//.test(wrk));
  ok("G5  worker usa segredo PROPRIO", /AGENTES_WORKER_INTERNAL_SECRET/.test(wrk));
  ok("G6  worker NAO usa o segredo do Estudio", !/ESTUDIO_ANUNCIOS_WORKER_INTERNAL_SECRET/.test(wrk));
  ok("G7  worker sem loop de fila", !/while\s*\(\s*true\s*\)|setInterval|for\s*\(\s*;;/.test(wrk));
  ok("G8  worker chama o claim de agentes", /claim_next_agente_tarefa/.test(wrk));
  ok("G9  rota usa segredo proprio e fail-closed",
     /AGENTES_WORKER_INTERNAL_SECRET/.test(rota) && /!segredoEsperado/.test(rota));
  ok("G10 rota nao aceita user_id do chamador", !/user_id/.test(rota));
  ok("G11 capability-worker e server-only",
     /^\s*import\s+"server-only";/m.test(capwBruta.replace(/\/\*[\s\S]*?\*\//, "").trimStart()));
  ok("G12 capability-worker sem select(\"*\")", !/select\(\s*["'`]\s*\*/.test(capw));
  ok("G13 capability-worker nao expoe SupabaseClient", !/SupabaseClient/.test(capw));
  ok("G14 handler NAO recebe SupabaseClient", !/SupabaseClient/.test(tex) && !/supabase/i.test(tex));
  ok("G15 executor chama EXATAMENTE uma das 2 RPCs terminais",
     conta(exe, /await\s+concluirTarefa\(/g) === 1 && conta(exe, /await\s+falharTarefa\(/g) === 1);
  ok("G16 executor nao usa UPDATE direto de status", !/\.update\(/.test(exe));
  ok("G17 justificativa da ausencia de user_id esta escrita",
     /JUSTIFICATIVA DA AUSENCIA DE `user_id`/.test(capwBruta));
  ok("G18 at-least-once documentado na migration", /AT-LEAST-ONCE/.test(migBruta));
  ok("G19 nunca chamado de exactly-once sem negacao",
     !/exactly-once/i.test(migBruta) || /NAO E exactly-once/i.test(migBruta));

  // Logs: nenhum identificador nos modulos server-side.
  //
  // A anti-vacuidade e do GRUPO, nao de cada arquivo: o executor tem
  // ZERO logs de proposito. Quem loga e quem CONHECE a falha — a
  // capability-worker sabe que foi o banco, a rota sabe que foi excecao
  // nao tratada. O executor so orquestra, e logar ali duplicaria a mesma
  // falha em duas linhas. Exigir >=1 log por arquivo mediria estilo, nao
  // vazamento.
  const argsPorModulo = ([["executor", exe], ["capability-worker", capw], ["rota", rota]] as const).map(
    ([nome, txt]) =>
      [nome, (txt.match(/console\.(?:error|log|warn|info)\(([^)]*)\)/g) ?? []).map((l) =>
        l.slice(l.indexOf("(") + 1, -1)
      )] as const
  );
  const todosOsArgs = argsPorModulo.flatMap(([, a]) => a);
  ok("G20 ha logs a inspecionar no conjunto (anti-vacuidade)", todosOsArgs.length >= 5);
  ok("G20b o executor nao duplica log de falha", (argsPorModulo.find(([n]) => n === "executor")?.[1].length ?? -1) === 0);
  for (const [nome, args] of argsPorModulo) {
    ok(`G21 ${nome}: nenhum log com identificador`,
       args.every((a) => !/tarefaId|agenteId|userId|user_id|tarefa\.id/.test(a)));
  }
  ok("G21b nenhum log do conjunto carrega interpolacao de id",
     todosOsArgs.every((a) => !/\$\{\s*(tarefa|agente|user)/i.test(a)));

  // ═══ H. A FASE 1B CONTINUA INTACTA ════════════════════════════════
  console.log("H. Integridade da FASE 1B");
  const tip = codigo("lib/agentes/tipos.ts");
  const cap = codigo("lib/agentes/capability.ts");
  const proibidos1B = /\bn8n\b|ai-gateway|anthropic|@google\/genai|claim_next|worker|memoria_agente|agente_memoria|agente_tools|agente_chat/i;
  ok("H0  os dois arquivos da 1B existem (anti-vacuidade)", tip.length > 500 && cap.length > 1000);
  ok("H1  tipos.ts continua sem worker/claim (assert J2 da 1B)", !proibidos1B.test(tip));
  ok("H2  capability.ts continua sem worker/claim (assert J1 da 1B)", !proibidos1B.test(cap));
  ok("H3  capability.ts continua com 7 operacoes", conta(cap, /export\s+async\s+function\s/g) === 7);
  ok("H4  tipos.ts continua sem server-only", !/import\s+"server-only"/.test(tip));
  ok("H5  a maquina de transicao da 1B segue valendo",
     transicaoTarefaPermitida("pendente", "rodando") &&
     transicaoTarefaPermitida("rodando", "concluido") &&
     transicaoTarefaPermitida("rodando", "erro") &&
     transicaoTarefaPermitida("rodando", "pendente") &&
     !transicaoTarefaPermitida("pendente", "concluido"));
  ok("H6  aguardando_aprovacao NAO e produzido pela 1C",
     !/aguardando_aprovacao/.test(exe) && !/aguardando_aprovacao/.test(mig) && !/aguardando_aprovacao/.test(wrk));
  ok("H7  cancelado NAO e produzido pela 1C",
     !/'cancelado'/.test(mig) && !/cancelado/.test(exe));
  ok("H8  os 6 estados da 1B seguem intactos", STATUS_TAREFA.length === 6);
  ok("H9  as 4 categorias de erro sao fechadas", TIPOS_ERRO_TAREFA.length === 4);

  // ═══ I. GUARDA DE BUNDLE ══════════════════════════════════════════
  console.log("I. Guarda de bundle");
  const clientes: string[] = [];
  const varrer = (dir: string) => {
    let itens: string[];
    try { itens = readdirSync(dir); } catch { return; }
    for (const item of itens) {
      if (item === "node_modules" || item === ".next" || item === ".git") continue;
      const caminho = join(dir, item);
      let info; try { info = statSync(caminho); } catch { continue; }
      if (info.isDirectory()) varrer(caminho);
      else if (/\.(ts|tsx)$/.test(item)) {
        const t = readFileSync(caminho, "utf8");
        if (/^\s*["']use client["']/m.test(t)) clientes.push(caminho);
      }
    }
  };
  varrer(join(RAIZ, "app"));
  varrer(join(RAIZ, "components"));
  varrer(join(RAIZ, "lib"));
  ok("I0  a varredura achou 'use client' (anti-vacuidade)", clientes.length >= 5);
  ok("I1  nenhum Client Component importa capability-worker",
     clientes.every((c) => !/agentes\/capability-worker/.test(readFileSync(c, "utf8"))));
  ok("I2  nenhum Client Component importa executar-tarefa",
     clientes.every((c) => !/agentes\/executar-tarefa/.test(readFileSync(c, "utf8"))));
  ok("I3  tipos-execucao NAO importa server-only (e puro)", !/import\s+"server-only"/.test(tex));

  // ═══ J. /dev/ai-office INTOCADO ═══════════════════════════════════
  console.log("J. /dev/ai-office intocado");
  // Sobre o CODIGO, nao sobre os comentarios: o cabecalho de
  // `office.tsx` declara "zero fetch, zero Supabase, zero credencial"
  // — uma busca ingenua casaria com a propria declaracao de ausencia e
  // falharia pelo motivo errado. Mesmo falso positivo que ja apareceu
  // nas frentes SEC.
  const officeBruto = fonte("app/dev/ai-office/office.tsx");
  const office = codigo("app/dev/ai-office/office.tsx");
  ok("J0  o arquivo existe (anti-vacuidade)", officeBruto.length > 1000);
  ok("J0b o strip removeu comentarios de fato", officeBruto.length > office.length);
  ok("J1  ai-office nao importa nada de agentes", !/lib\/agentes/.test(office));
  ok("J2  ai-office continua sem fetch/banco (no CODIGO)",
     !/fetch\(|createClient|supabase/i.test(office));
  ok("J3  ai-office continua 100% mock", /const AGENTES\s*(:|=)/.test(office));

  // ═══ K. HEARTBEAT PERIODICO ═══════════════════════════════════════
  //
  // Existe porque a migration AFIRMA "20 batidas perdidas antes de
  // considerar a tarefa abandonada". Antes desta correcao a afirmacao
  // era falsa: o heartbeat so acontecia quando o handler relatava
  // progresso, e um handler silencioso por 6 minutos seria reivindicado
  // por outro worker estando vivo. Estes asserts existem para que a
  // afirmacao nao possa voltar a ser falsa em silencio.
  console.log("K. Heartbeat periodico");

  ok("K0  o executor tem corpo a inspecionar (anti-vacuidade)", exe.length > 1500);
  // O VALOR, nao um regex sobre a fonte: a constante e importada.
  ok("K1  INTERVALO_HEARTBEAT_MS === 15000", INTERVALO_HEARTBEAT_MS === 15_000);
  ok("K2  o executor arma um setInterval", /setInterval\s*\(/.test(exe));
  ok("K3  o intervalo usado e a constante (nao um literal solto)",
     /setInterval\([\s\S]{0,140}?INTERVALO_HEARTBEAT_MS\s*\)/.test(exe));
  ok("K4  clearInterval existe", /clearInterval\s*\(\s*timerHeartbeat\s*\)/.test(exe));
  // `finally` OBRIGATORIO: um clear so no caminho feliz deixaria o timer
  // vivo justamente quando o handler lanca.
  ok("K5  clearInterval esta dentro de um finally",
     /finally\s*\{[^}]*clearInterval\s*\(\s*timerHeartbeat\s*\)[^}]*\}/.test(exe));
  ok("K6  o batimento periodico reenvia o ULTIMO progresso conhecido",
     /setInterval\(\s*\(\)\s*=>\s*\{\s*void\s+bater\(progressoAtual\)/.test(exe));
  ok("K7  bate mesmo sem o progresso mudar (nao consulta ultimoPersistido no timer)",
     !/setInterval\([\s\S]{0,160}?ultimoPersistido/.test(exe));
  ok("K8  ha guarda de chamada concorrente", /baticaoEmVoo/.test(exe));
  ok("K9  a guarda impede reentrada", /if\s*\(\s*baticaoEmVoo\s*\)\s*return;/.test(exe));
  ok("K10 a guarda e liberada em finally",
     /finally\s*\{\s*baticaoEmVoo\s*=\s*false;\s*\}/.test(exe));
  ok("K11 nenhuma promise rejection escapa (await dentro de try/catch)",
     /try\s*\{[\s\S]{0,220}?await\s+registrarProgresso[\s\S]{0,220}?\}\s*catch\s*\{/.test(exe));
  ok("K12 o timer nao segura o event loop (unref)", /unref\?\.\(\)/.test(exe));
  ok("K13 falha de heartbeat NAO interrompe o handler",
     /best-effort/i.test(fonte(EXECUTOR)));

  // A relacao 20x entre heartbeat e limite de orfa. Os dois numeros
  // vivem em arquivos diferentes; e exatamente por isso que precisam ser
  // comparados aqui.
  const minutosOrfa = Number(mig.match(/interval\s*'(\d+)\s*minutes'/i)?.[1] ?? 0);
  ok("K14 o limite de orfa foi lido da migration (anti-vacuidade)", minutosOrfa > 0);
  ok("K15 orfa continua em 5 minutos", minutosOrfa === 5);
  ok("K16 a relacao heartbeat:orfa e de 20x",
     (minutosOrfa * 60_000) / INTERVALO_HEARTBEAT_MS === 20);
  ok("K17 o heartbeat e MUITO menor que o limite de orfa",
     INTERVALO_HEARTBEAT_MS * 4 < minutosOrfa * 60_000);
  ok("K18 a migration atribui o heartbeat ao EXECUTOR, nao ao worker",
     /executar-tarefa\.ts[\s\S]{0,200}?setInterval/i.test(migBruta));

  // O worker continua execucao unica — a correcao NAO pode ter vazado
  // para la.
  ok("K19 worker SEM setInterval", !/setInterval/.test(wrk));
  ok("K20 worker sem loop de fila (reafirmado)",
     !/while\s*\(\s*true\s*\)|for\s*\(\s*;;|setImmediate\s*\(\s*main/.test(wrk));
  ok("K21 o unico setTimeout do worker e o do AbortController",
     (wrk.match(/setTimeout\s*\(/g) ?? []).length === 1 && /controlador\.abort\(\)/.test(wrk));
  ok("K22 setInterval NAO aparece na capability-worker", !/setInterval/.test(capw));
  ok("K23 setInterval NAO aparece no handler", !/setInterval/.test(han));

  // Validacao do timeout HTTP do worker.
  ok("K24 worker valida o timeout com funcao dedicada", /function\s+lerTimeoutHttp\s*\(/.test(wrk));
  ok("K25 exige numero finito", /Number\.isFinite/.test(wrk));
  ok("K26 exige > 0", /valor\s*<=\s*0/.test(wrk));
  ok("K27 tem teto", /TIMEOUT_HTTP_TETO_MS/.test(wrk));
  ok("K28 fallback seguro com aviso", /console\.warn/.test(wrk) && /TIMEOUT_HTTP_PADRAO_MS/.test(wrk));
  ok("K29 o padrao e 60000", /TIMEOUT_HTTP_PADRAO_MS\s*=\s*60000/.test(wrk));

  // ═══ L. ROTA INTERNA ↔ POLITICA DO MIDDLEWARE ═════════════════════
  //
  // Existe por causa de um FAIL real. No primeiro smoke da FASE 1C a
  // rota interna estava perfeita — segredo proprio, fail-closed, UUID
  // validado — e mesmo assim o worker levou 401. O 401 nao era dela: o
  // MIDDLEWARE bloqueava a requisicao antes, porque
  // `/api/internal/agentes/executar` nunca foi registrada em
  // `ROTAS_COM_SEGREDO`.
  //
  // Nenhuma suite pegou: a offline auditava a rota ISOLADA, e a de banco
  // chama as RPCs sem passar por HTTP. Uma rota interna so funciona se
  // DUAS coisas forem verdadeiras ao mesmo tempo, e ate aqui so uma
  // delas era verificada.
  //
  // Os asserts abaixo amarram as duas pontas NOS DOIS SENTIDOS:
  //   - tirar a rota da politica  -> L2/L3 quebram
  //   - tirar o segredo do handler mantendo a rota liberada -> L7 quebra
  //     (seria um endpoint aberto, que e pior que a fila parada)
  const CAMINHO_ROTA = "/api/internal/agentes/executar";
  console.log("L. Rota interna x politica do middleware");

  ok("L0  a politica foi carregada (anti-vacuidade)", Object.keys(ROTAS_COM_SEGREDO).length > 0);
  ok("L1  a rota esta em ROTAS_COM_SEGREDO", CAMINHO_ROTA in ROTAS_COM_SEGREDO);
  ok("L2  declarada SOMENTE para POST",
     JSON.stringify(ROTAS_COM_SEGREDO[CAMINHO_ROTA]) === JSON.stringify(["POST"]));
  // O que o middleware DECIDE, nao o que a lista parece dizer.
  ok("L3  POST sem cookie -> liberar", decidirAcesso(CAMINHO_ROTA, "POST", false) === "liberar");
  ok("L4  GET sem cookie -> bloquear_api", decidirAcesso(CAMINHO_ROTA, "GET", false) === "bloquear_api");
  ok("L5  demais metodos sem cookie -> bloquear_api",
     ["PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].every(
       (m) => decidirAcesso(CAMINHO_ROTA, m, false) === "bloquear_api"));
  ok("L6  a rota NAO e publica",
     !(CAMINHO_ROTA in ROTAS_PUBLICAS) && !PAGINAS_PUBLICAS.has(CAMINHO_ROTA));
  // O outro sentido: liberada no middleware EXIGE autenticacao propria.
  ok("L7  liberada no middleware => o handler autentica sozinho",
     /AGENTES_WORKER_INTERNAL_SECRET/.test(rota) &&
       /x-worker-secret/.test(rota) &&
       /!segredoEsperado/.test(rota));
  ok("L8  o caminho da politica e o caminho REAL do arquivo de rota",
     require("fs").existsSync(join(RAIZ, "app" + CAMINHO_ROTA.replace("/api", "/api") + "/route.ts")));
  ok("L9  o worker chama exatamente esse caminho", wrk.includes(CAMINHO_ROTA));
  ok("L10 o segredo do middleware e o mesmo que o worker envia",
     /x-worker-secret/.test(wrk) && /AGENTES_WORKER_INTERNAL_SECRET/.test(wrk));

  // ═══ M. AGENTES-FASE1D-b — casa neutra do erro e contrato novo ════
  //
  // A classe saiu de `handlers/teste-fundacao.ts` porque o EXECUTOR —
  // codigo de producao — a importava de um handler de TESTE. Andaime
  // nao pode ser dependencia de codigo real: o dia em que
  // `teste_fundacao` for removido, o motor nao pode quebrar junto.
  console.log("M. FASE 1D-b: erros.ts e ConstruirHandler");

  const erros = codigo("lib/agentes/erros.ts");
  const errosBruta = fonte("lib/agentes/erros.ts");
  const han2 = codigo(HANDLER);
  const exe2 = codigo(EXECUTOR);

  ok("M0  erros.ts foi lido (anti-vacuidade)", erros.length > 100);
  // UMA definicao de runtime, e ela esta em erros.ts.
  ok("M1  erros.ts DEFINE ErroEntradaTarefa", /export class ErroEntradaTarefa extends Error/.test(erros));
  ok("M2  teste-fundacao NAO define mais a classe", !/class ErroEntradaTarefa/.test(han2));
  ok("M3  teste-fundacao NAO reexporta a classe",
     !/export\s*\{[^}]*ErroEntradaTarefa/.test(han2) && !/export .*from .*erros/.test(han2));
  ok("M4  definicao unica em toda a lib", (() => {
       let n = 0;
       for (const rel of ["lib/agentes/erros.ts", "lib/agentes/handlers/teste-fundacao.ts",
                          "lib/agentes/executar-tarefa.ts", "lib/agentes/tipos-execucao.ts",
                          "lib/agentes/handlers/registry.ts"]) {
         n += conta(codigo(rel), /class ErroEntradaTarefa/g);
       }
       return n === 1;
     })());
  // Quem consome, consome da casa nova.
  ok("M5  teste-fundacao importa de @/lib/agentes/erros",
     /import \{ ErroEntradaTarefa \} from "@\/lib\/agentes\/erros"/.test(han2));
  ok("M6  executor importa de @/lib/agentes/erros",
     /import \{ ErroEntradaTarefa \} from "@\/lib\/agentes\/erros"/.test(exe2));
  ok("M7  executor NAO importa mais de handlers/teste-fundacao",
     !/from "@\/lib\/agentes\/handlers\/teste-fundacao"/.test(exe2));
  // erros.ts precisa ser PURO: o executor e server-only, o handler nao.
  ok("M8  erros.ts nao importa server-only", !/import\s+"server-only"/.test(errosBruta));
  ok("M9  erros.ts nao toca SDK/banco/env/rede",
     !/createClient|supabase|process\.env|fetch\(|\.from\(/i.test(erros));
  ok("M10 erros.ts nao tem import algum", conta(erros, /^import\s/gm) === 0);
  // Comportamento preservado: a classe ainda e o que o executor espera.
  ok("M11 a classe continua sendo Error", new ErroEntradaTarefa("x") instanceof Error);
  ok("M12 name continua ErroEntradaTarefa", new ErroEntradaTarefa("x").name === "ErroEntradaTarefa");
  ok("M13 a mensagem e preservada", new ErroEntradaTarefa("abc").message === "abc");
  ok("M14 o executor ainda mapeia para entrada_invalida",
     /err instanceof ErroEntradaTarefa\) return "entrada_invalida"/.test(exe2));

  // O contrato novo: tipo, sem canal de dependencia no handler.
  ok("M15 ConstruirHandler existe em tipos-execucao",
     /export type ConstruirHandler = \(userId: string\) => HandlerTarefa;/.test(tex));
  ok("M16 HandlerTarefa continua com 2 parametros", (() => {
       const bloco = tex.slice(tex.indexOf("export type HandlerTarefa"));
       const ate = bloco.slice(0, bloco.indexOf(";") + 1);
       return /contexto: ContextoTarefa/.test(ate) && /relatarProgresso: RelatarProgresso/.test(ate)
         && !/dados/.test(ate) && conta(ate, /:/g) === 2;
     })());
  ok("M17 tipos-execucao NAO ganhou LeiturasDeAgente nem dados?",
     !/LeiturasDeAgente/.test(tex) && !/dados\?/.test(tex));
  ok("M18 tipos-execucao continua sem valor de runtime alem dos const de dominio",
     !/class /.test(tex));

  // AGENTES-FASE1D-d: o contrato da 1D-b passou a ser CONSUMIDO. Os
  // asserts M19..M23 afirmavam "ainda nao" — premissa que esta fase
  // torna falsa de proposito. Reformulados para a arquitetura nova.
  ok("M19 o registry guarda ConstruirHandler, nao handler pronto",
     /HANDLERS: Readonly<Record<string, ConstruirHandler>>/.test(reg));
  ok("M20 o registry NAO guarda mais HandlerTarefa pronto",
     !/Record<string,\s*HandlerTarefa>/.test(reg));
  ok("M21 o executor consome a fabrica", /resolverHandler\(tarefa\.tipo\)/.test(exe2) && /construirHandler\(tarefa\.user_id\)/.test(exe2));
  ok("M22 o executor ainda chama handler(contexto, relatarProgresso)",
     /await handler\(contexto, relatarProgresso\)/.test(exe2));
  ok("M23 exatamente 3 handlers registrados", TIPOS_REGISTRADOS.length === 3);

  // ═══ N. WIRING DE TENANT — AGENTES-FASE1D-d ═══════════════════════
  console.log("N. Wiring de tenant");

  // ── N1..N5: o dono vem da TAREFA, e de mais lugar nenhum ─────────
  const blocoExec = exe2.slice(exe2.indexOf("const construirHandler"), exe2.indexOf("await handler(contexto"));
  ok("N0  o trecho de binding foi localizado (anti-vacuidade)", blocoExec.length > 40 && blocoExec.includes("construirHandler"));
  ok("N1  o binding usa tarefa.user_id", /construirHandler\(tarefa\.user_id\)/.test(blocoExec));
  ok("N2  o binding NAO usa contexto.entrada", !/contexto\.entrada/.test(blocoExec));
  ok("N3  o binding NAO usa agenteId nem agente_id", !/agente_?[Ii]d/.test(blocoExec));
  ok("N4  o executor inteiro nao tem fallback de dono", !/user_id\s*(\?\?|\|\|)/.test(exe2) && !/entrada\.userId/.test(exe2));
  ok("N5  a rota interna nao le user_id do corpo",
     !/user_id/.test(codigo("app/api/internal/agentes/executar/route.ts").replace(/tarefa_id/g, "")));

  // ── N6..N9: entrada nao escolhe tenant, na PRATICA ───────────────
  {
    // Duas construcoes com donos diferentes tem de produzir handlers
    // DIFERENTES. Se o registry guardasse um handler global, seriam o
    // mesmo objeto — e o segundo tenant leria dados do primeiro.
    const construir = resolverHandler("analise_vendas");
    const hA = construir("dono-A");
    const hB = construir("dono-B");
    ok("N6  tenants diferentes produzem handlers DIFERENTES", hA !== hB);
    ok("N7  cada handler continua com 2 parametros", hA.length === 2 && hB.length === 2);
    // Mesmo dono, duas construcoes: tambem objetos distintos — nada e
    // memoizado num escopo de modulo onde pudesse vazar entre tenants.
    ok("N8  nem o mesmo dono reaproveita instancia global", construir("dono-A") !== hA);
  }
  ok("N9  ContextoTarefa nao ganhou userId proprio: segue vindo da linha",
     /userId: tarefa\.user_id/.test(exe2));

  // ── N10..N14: least-capability na composicao ─────────────────────
  const blocoMapa = reg.slice(reg.indexOf("export const HANDLERS"), reg.indexOf("export const TIPOS_REGISTRADOS"));
  ok("N10 o mapa do registry foi localizado (anti-vacuidade)", blocoMapa.includes("TIPO_ANALISE_VENDAS") && blocoMapa.includes("TIPO_TESTE_FUNDACAO"));
  ok("N11 analise_vendas recebe SO a leitura de vendas",
     /criarHandlerAnaliseVendas\(\s*criarLeiturasDeVendas\(userId\)\s*\)/.test(blocoMapa.replace(/\s+/g, " ")));
  ok("N12 o registry nao passa SupabaseClient nem getSupabaseServidor",
     !/SupabaseClient|getSupabaseServidor/.test(reg));
  ok("N13 o registry nao monta objeto generico de dependencias",
     !/dependencies|LeiturasDeAgente|servicos|container/i.test(reg));
  ok("N14 teste_fundacao nao recebe capability alguma",
     /\[TIPO_TESTE_FUNDACAO\]:\s*\(\)\s*=>\s*handlerTesteFundacao/.test(blocoMapa.replace(/\s+/g, " ")));

  // ── N15..N17: o handler permanece puro ───────────────────────────
  const srcAnalise = codigo("lib/agentes/handlers/analise-vendas.ts");
  ok("N15 o handler segue sem userId", !/userId|user_id/.test(srcAnalise));
  ok("N16 o handler segue sem SupabaseClient/env/fetch",
     !/SupabaseClient|process\.env|\bfetch\s*\(/.test(srcAnalise));
  ok("N17 o handler importa dados/vendas SO como tipo",
     /import type \{[\s\S]*?\} from "@\/lib\/agentes\/dados\/vendas"/.test(srcAnalise) &&
     !/(^|\n)import \{[^}]*\} from "@\/lib\/agentes\/dados\/vendas"/.test(srcAnalise));

  // ═══ P. HANDLER conversa — AGENT-VERTICAL-SLICE-V1 ════════════════
  //
  // Os casos centrais EXECUTAM o handler real com doubles das
  // dependencias externas. Nenhum provedor real e alcancado: o
  // adaptador vem de `criarAdaptadorFake`, que nao tem rede, SDK nem
  // env — e o espiao `chamadas` e o que permite afirmar, e nao supor, o
  // que a IA recebeu.
  console.log("P. Handler conversa");
  {
    const DONO = "dono-U";
    const ID_A = "aaaaaaaa-1111-1111-1111-111111111111";
    const ID_B = "bbbbbbbb-2222-2222-2222-222222222222";
    const RESPOSTA_FAKE = "[fake] resposta de teste";

    const agente = (id: string, instrucoes: string | null, ativo = true): LinhaAgente => ({
      id,
      user_id: DONO,
      nome: id === ID_A ? "Agente A" : "Agente B",
      tipo: "mensagens",
      instrucoes,
      ativo,
      criado_em: "2026-09-01T00:00:00Z",
      atualizado_em: "2026-09-01T00:00:00Z",
    });

    /** Leitura fake + espiao do que foi pedido. */
    const leitura = (mapa: Record<string, LinhaAgente>, erro: string | null = null) => {
      const pedidos: string[] = [];
      return {
        pedidos,
        fn: async (agenteId: string) => {
          pedidos.push(agenteId);
          if (erro) return { linha: null, erro };
          return { linha: mapa[agenteId] ?? null, erro: null };
        },
      };
    };

    /** Adaptador fake + contagem de quantas vezes foi OBTIDO. */
    const adaptador = (resposta = RESPOSTA_FAKE) => {
      const fake = criarAdaptadorFake({ bruto: { resposta } });
      const obtencoes: number[] = [];
      return {
        chamadas: fake.chamadas,
        obtencoes,
        obter: async () => {
          obtencoes.push(1);
          return fake.adaptador;
        },
      };
    };

    const ctx = (agenteId: string, entrada: Record<string, unknown>): ContextoTarefa => ({
      tarefaId: "cccccccc-3333-3333-3333-333333333333",
      agenteId,
      userId: DONO,
      tipo: TIPO_CONVERSA,
      entrada,
      tentativa: 1,
      maxTentativas: 3,
    });

    const capturar = async (fn: () => Promise<unknown>): Promise<unknown> => {
      try {
        await fn();
        return null;
      } catch (e) {
        return e;
      }
    };

    const AMBOS = { [ID_A]: agente(ID_A, "INSTRUCAO_A"), [ID_B]: agente(ID_B, "INSTRUCAO_B") };

    // ── P1..P6: o caminho feliz e o mapeamento semantico ────────────
    const lA = leitura(AMBOS);
    const aA = adaptador();
    const rA = await criarHandlerConversa(lA.fn, aA.obter)(
      ctx(ID_A, { mensagem: "Ola" }),
      semProgresso
    );

    ok("P1  a leitura foi chamada EXATAMENTE uma vez", lA.pedidos.length === 1);
    ok("P2  a leitura recebeu o agenteId DO CONTEXTO", lA.pedidos[0] === ID_A);
    ok("P3  a IA foi chamada exatamente uma vez", aA.chamadas.length === 1);
    ok("P4  `instrucao` recebe as instrucoes do agente, VERBATIM",
       aA.chamadas[0]?.instrucao === "INSTRUCAO_A");
    ok("P5  `dados` recebe a mensagem da tarefa", aA.chamadas[0]?.dados === "Ola");
    ok("P6  instrucao e mensagem NAO foram concatenadas",
       !aA.chamadas[0]?.instrucao.includes("Ola") && !aA.chamadas[0]?.dados.includes("INSTRUCAO_A"));

    // ── P7..P9: o resultado minimo ──────────────────────────────────
    ok("P7  o resultado devolve a resposta do adaptador",
       (rA as Record<string, unknown>).resposta === RESPOSTA_FAKE);
    ok("P8  o resultado tem SO a chave `resposta` (sem metadado)",
       Object.keys(rA).join(",") === "resposta");
    ok("P9  o resultado nao carrega provedor/modelo/tokens",
       !("provedor" in rA) && !("modelo" in rA) && !("tokensEntrada" in rA));

    // ── P10..P13: A PROVA CENTRAL — identidade comportamental ───────
    const lB = leitura(AMBOS);
    const aB = adaptador();
    await criarHandlerConversa(lB.fn, aB.obter)(ctx(ID_B, { mensagem: "Ola" }), semProgresso);

    ok("P10 o agente B foi pedido pelo id de B", lB.pedidos[0] === ID_B);
    ok("P11 a chamada de B recebe as instrucoes DE B",
       aB.chamadas[0]?.instrucao === "INSTRUCAO_B");
    ok("P12 as duas chamadas receberam instrucoes DIFERENTES",
       aA.chamadas[0]?.instrucao !== aB.chamadas[0]?.instrucao);
    ok("P13 CONTROLE NEGATIVO: as fixtures sao mesmo distintas",
       AMBOS[ID_A].instrucoes !== AMBOS[ID_B].instrucoes);

    // ── P14..P17: agente AUSENTE — zero chamadas de IA ──────────────
    {
      const l = leitura({});
      const a = adaptador();
      const e = await capturar(() =>
        criarHandlerConversa(l.fn, a.obter)(ctx(ID_A, { mensagem: "Ola" }), semProgresso)
      );
      ok("P14 agente ausente LANCA", e instanceof Error);
      ok("P15 agente ausente NAO e entrada_invalida", !(e instanceof ErroEntradaTarefa));
      ok("P16 agente ausente: ZERO chamadas de IA", a.chamadas.length === 0);
      ok("P17 agente ausente: o adaptador nem chegou a ser obtido", a.obtencoes.length === 0);
    }

    // ── P18..P21: falha de LEITURA — zero chamadas de IA ────────────
    {
      const l = leitura(AMBOS, "erro_consulta_agente");
      const a = adaptador();
      const e = await capturar(() =>
        criarHandlerConversa(l.fn, a.obter)(ctx(ID_A, { mensagem: "Ola" }), semProgresso)
      );
      ok("P18 erro de leitura LANCA", e instanceof Error);
      ok("P19 erro de leitura: ZERO chamadas de IA", a.chamadas.length === 0);
      ok("P20 erro de leitura: adaptador nao obtido", a.obtencoes.length === 0);
      ok("P21 a mensagem nao vaza erro cru de banco",
         e instanceof Error &&
         !/SQLSTATE|PGRST|relation|column|duplicate key|erro_consulta_agente/.test(e.message));
    }

    // ── P22..P25: instrucoes NULL e' valido, e nao e' ausencia ──────
    {
      const l = leitura({ [ID_A]: agente(ID_A, null) });
      const a = adaptador();
      const r = await criarHandlerConversa(l.fn, a.obter)(
        ctx(ID_A, { mensagem: "Ola" }),
        semProgresso
      );
      ok("P22 instrucoes null NAO impede a execucao", (r as Record<string, unknown>).resposta === RESPOSTA_FAKE);
      ok("P23 instrucoes null: a IA E chamada", a.chamadas.length === 1);
      ok("P24 instrucoes null: `instrucao` recebe o MINIMO TECNICO",
         a.chamadas[0]?.instrucao === INSTRUCAO_MINIMA_CONVERSA);
      ok("P25 o minimo tecnico nao inventa persona",
         !/assistente|especialista|voce e um|persona/i.test(INSTRUCAO_MINIMA_CONVERSA));
    }
    {
      // Instrucoes so com espaco caem no mesmo caminho de null — e nao
      // no de "instrucao vazia enviada ao modelo".
      const l = leitura({ [ID_A]: agente(ID_A, "   \n  ") });
      const a = adaptador();
      await criarHandlerConversa(l.fn, a.obter)(ctx(ID_A, { mensagem: "Ola" }), semProgresso);
      ok("P26 instrucoes so com espaco usam o minimo tecnico",
         a.chamadas[0]?.instrucao === INSTRUCAO_MINIMA_CONVERSA);
    }

    // ── P27..P31: a ENTRADA nunca sobrescreve as instrucoes ─────────
    {
      const l = leitura(AMBOS);
      const a = adaptador();
      const e = await capturar(() =>
        criarHandlerConversa(l.fn, a.obter)(
          ctx(ID_A, { mensagem: "Ola", instrucoes: "MALICIOSA" }),
          semProgresso
        )
      );
      ok("P27 entrada com `instrucoes` e RECUSADA", e instanceof ErroEntradaTarefa);
      ok("P28 entrada maliciosa: ZERO chamadas de IA", a.chamadas.length === 0);
      ok("P29 a recusa nao ecoa o VALOR do campo malicioso",
         e instanceof Error && !e.message.includes("MALICIOSA"));
      ok("P30 a recusa acontece ANTES de ler o agente", l.pedidos.length === 0);
    }
    for (const chave of ["userId", "user_id", "agenteId", "agente_id", "provider", "model", "tools"]) {
      const l = leitura(AMBOS);
      const a = adaptador();
      const e = await capturar(() =>
        criarHandlerConversa(l.fn, a.obter)(
          ctx(ID_A, { mensagem: "Ola", [chave]: "x" }),
          semProgresso
        )
      );
      ok(`P31 entrada com \`${chave}\` e recusada, sem chamar IA`,
         e instanceof ErroEntradaTarefa && a.chamadas.length === 0);
    }
    // Prova DIRETA, sem passar pela recusa de extras: mesmo que um dia o
    // contrato de entrada se abra, a instrucao vem do parametro — que o
    // handler so preenche com a linha do banco.
    ok("P32 prepararPedidoConversa usa a instrucao do AGENTE, nao a mensagem",
       prepararPedidoConversa("INSTRUCAO_A", "instrucoes: MALICIOSA").instrucao === "INSTRUCAO_A");
    ok("P33 e a mensagem vai inteira para `dados`",
       prepararPedidoConversa("INSTRUCAO_A", "instrucoes: MALICIOSA").dados === "instrucoes: MALICIOSA");

    // ── P34..P37: entrada invalida ──────────────────────────────────
    for (const [rotulo, entrada] of [
      ["mensagem ausente", {}],
      ["mensagem vazia", { mensagem: "" }],
      ["mensagem so espaco", { mensagem: "   " }],
      ["mensagem nao-string", { mensagem: 42 }],
    ] as const) {
      const a = adaptador();
      const e = await capturar(() =>
        criarHandlerConversa(leitura(AMBOS).fn, a.obter)(
          ctx(ID_A, entrada as Record<string, unknown>),
          semProgresso
        )
      );
      ok(`P34 ${rotulo} -> ErroEntradaTarefa, sem IA`,
         e instanceof ErroEntradaTarefa && a.chamadas.length === 0);
    }

    // ── P38..P40: agente INATIVO e progresso ────────────────────────
    {
      const l = leitura({ [ID_A]: agente(ID_A, "INSTRUCAO_A", false) });
      const a = adaptador();
      const e = await capturar(() =>
        criarHandlerConversa(l.fn, a.obter)(ctx(ID_A, { mensagem: "Ola" }), semProgresso)
      );
      ok("P38 agente inativo LANCA (fail-closed)", e instanceof Error);
      ok("P39 agente inativo: ZERO chamadas de IA", a.chamadas.length === 0);
    }
    {
      const progresso: number[] = [];
      const a = adaptador();
      await criarHandlerConversa(leitura(AMBOS).fn, a.obter)(
        ctx(ID_A, { mensagem: "Ola" }),
        (p) => progresso.push(p)
      );
      ok("P40 o progresso vai 0 -> 25 -> 50 -> 100", progresso.join(",") === "0,25,50,100");
    }

    // ── P41..P45: o contrato de saida e NOSSO, e recusa de verdade ──
    ok("P41 o validador aceita a forma certa",
       validarRespostaConversa({ resposta: "ok" }).resposta === "ok");
    for (const [rotulo, bruto] of [
      ["resposta ausente", {}],
      ["chave a mais", { resposta: "ok", extra: 1 }],
      ["resposta nao-string", { resposta: 42 }],
      ["resposta vazia", { resposta: "   " }],
      ["array", []],
      ["null", null],
    ] as const) {
      let recusou = false;
      try {
        validarRespostaConversa(bruto);
      } catch {
        recusou = true;
      }
      ok(`P42 o validador recusa: ${rotulo}`, recusou);
    }
    {
      // O fake roda `pedido.validar` de verdade — entao um bruto fora do
      // contrato faz a TAREFA falhar, e nao vira resultado degradado.
      const fake = criarAdaptadorFake({ bruto: { resumo: "forma da analise" } });
      const a = { obter: async () => fake.adaptador };
      const e = await capturar(() =>
        criarHandlerConversa(leitura(AMBOS).fn, a.obter)(
          ctx(ID_A, { mensagem: "Ola" }),
          semProgresso
        )
      );
      ok("P43 resposta fora do contrato faz a tarefa FALHAR", e instanceof Error);
      ok("P44 e nao devolve resultado parcial", e !== null);
    }

    // ── P45..P52: fonte — o que o handler NAO pode fazer ────────────
    const srcConversa = codigo("lib/agentes/handlers/conversa.ts");
    ok("P45 a fonte foi carregada (anti-vacuidade)",
       srcConversa.length > 400 && /criarHandlerConversa/.test(srcConversa));
    ok("P46 o handler NAO fala com Supabase", !/getSupabaseServidor|SupabaseClient|createClient|\.from\(/.test(srcConversa));
    ok("P47 o handler NAO le env (a camada canonica e ativacao-ia)", !/process\.env/.test(srcConversa));
    ok("P48 o handler NAO le as flags de IA por conta propria",
       !/AGENTES_IA_INTERPRETACAO_ENABLED|AGENTES_IA_PROVIDER_REAL_ENABLED/.test(srcConversa));
    ok("P49 o handler NAO importa Function/Approval",
       !/execucao-funcoes|aprovacoes|executarFuncao|retomarAprovacao/.test(srcConversa));
    ok("P50 o handler NAO instancia SDK de provedor",
       !/@anthropic|@google\/genai|openai|adaptador-anthropic/i.test(srcConversa));
    ok("P51 o handler NAO loga", !/console\./.test(srcConversa));
    ok("P52 CONTROLE NEGATIVO: as sondas acusam quando o padrao existe",
       /process\.env/.test("process.env.X") && /console\./.test("console.log(1)"));

    // ── P53..P57: o wiring do dono, na fonte do registry ────────────
    const regC = codigo(REGISTRY);
    ok("P53 o registry passa agenteId E userId para a capability",
       /lerAgenteDoDono\(agenteId, userId\)/.test(regC.replace(/\s+/g, " ")));
    ok("P54 a leitura entregue ao handler tem aridade 1",
       /criarHandlerConversa\(\s*\(agenteId: string\) =>/.test(regC.replace(/\s+/g, " ")));
    ok("P55 o dono NAO e passado direto ao handler", !/criarHandlerConversa\(userId/.test(regC));
    ok("P56 CONTROLE NEGATIVO: P55 reprova se o dono for repassado",
       /criarHandlerConversa\(userId/.test("criarHandlerConversa(userId, x)"));
    ok("P57 o registry usa a fabrica canonica de adaptador",
       /criarAdaptadorDeConversa\(\)/.test(regC) &&
       /from "@\/lib\/agentes\/ativacao-ia"/.test(regC));

    // ── P58..P60: os handlers anteriores nao mudaram ────────────────
    ok("P58 teste_fundacao nao passou a ler agente",
       !/lerAgenteDoDono|instrucoes/.test(codigo(HANDLER)));
    ok("P59 analise_vendas nao passou a ler agente",
       !/lerAgenteDoDono|agente\.instrucoes/.test(codigo("lib/agentes/handlers/analise-vendas.ts")));
    ok("P60 conversa nao criou historico/thread/conversationId",
       !/conversationId|threadId|historico|mensagens\b/i.test(srcConversa));
  }

  const total = passou + falhou;
  console.log(`\n${"=".repeat(58)}`);
  console.log(`AGENTES-FASE1C — execucao:  ${passou}/${total} passaram`);
  if (falhou > 0) { console.log(`${falhou} FALHARAM`); process.exitCode = 1; }
  else console.log("TODOS OS ASSERTS PASSARAM");
  console.log("=".repeat(58));
}

main().catch((e) => {
  console.error("ERRO NAO TRATADO:", e instanceof Error ? e.message.slice(0, 300) : "desconhecido");
  process.exitCode = 1;
});
