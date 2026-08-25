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
  ErroEntradaTarefa,
} from "../lib/agentes/handlers/teste-fundacao";
import { TIPOS_ERRO_TAREFA, type ContextoTarefa } from "../lib/agentes/tipos-execucao";
import { INTERVALO_HEARTBEAT_MS } from "../lib/agentes/executar-tarefa";
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
  ok("E1  resolve teste_fundacao", resolverHandler(TIPO_TESTE_FUNDACAO) === handlerTesteFundacao);
  ok("E2  exatamente 1 tipo registrado", TIPOS_REGISTRADOS.length === 1);
  ok("E3  o tipo e teste_fundacao", TIPOS_REGISTRADOS[0] === "teste_fundacao");
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
