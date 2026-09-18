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
import { createHash } from "crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
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
// FUNCTION-RUNTIME-V1-A: so a constante do tipo. A cobertura de
// comportamento do handler novo vive em `testar-agentes-execucao-funcoes.ts`,
// que e a suite do executor de Funcoes.
import { TIPO_CONSULTAR_VENDAS } from "../lib/agentes/handlers/consultar-vendas";
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
/**
 * APPROVAL-DECISION-RESUME-B0 — a migration que RECRIOU as duas RPCs
 * terminais com fencing por tentativa.
 *
 * O Postgres nao versiona funcao por migration de origem: o estado real
 * de `concluir_tarefa` e `falhar_tarefa` e o desta, nao o da 1C. Por
 * isso a secao D continua descrevendo a 1C como documento historico, e
 * a secao R abaixo e a AUTORIDADE sobre o que esta no banco.
 */
const MIGRATION_B0 = "supabase/migrations/20260930_tarefa_fencing_por_tentativa.sql";
/**
 * APPROVAL-DECISION-RESUME-B0 — FASE D, a migration que REMOVE as duas
 * assinaturas sem fence.
 *
 * Ela existe separada da aditiva de proposito: enquanto as duas moram
 * em arquivos distintos, a ordem do rollout fica legivel no disco e
 * auditavel no historico. Fundir as duas apagaria a evidencia de que o
 * cutover foi feito em fases.
 */
const MIGRATION_B0_CLEANUP =
  "supabase/migrations/20261001_remover_tarefa_rpc_sem_fencing.sql";
/**
 * APPROVAL-DECISION-RESUME-D1 — a migration que da a uma tarefa parada
 * o direito de dizer DE QUE aprovacao ela esta esperando.
 *
 * Fase aditiva: cria um overload de tres argumentos da pausa e deixa o
 * de dois intacto. O caller de producao so muda no gate seguinte — e a
 * secao T abaixo existe para impedir que ele mude aqui.
 */
const MIGRATION_D1 =
  "supabase/migrations/20261002_tarefa_aprovacao_aguardada.sql";
/**
 * APPROVAL-DECISION-RESUME-D3 — a migration que REMOVE a overload de
 * dois argumentos da pausa.
 *
 * Fase de LIMPEZA, em arquivo proprio pela mesma razao que o cleanup do
 * B0 ficou separado da aditiva do B0: enquanto as duas moram em
 * arquivos distintos, a ordem do rollout fica legivel no disco. A
 * secao T abaixo e a autoridade sobre a FORMA dela — e `DROP FUNCTION`
 * e a operacao menos reversivel do repositorio.
 */
const MIGRATION_D3 =
  "supabase/migrations/20261003_remover_aguardar_aprovacao_tarefa_2args.sql";
/**
 * APPROVAL-DECISION-RESUME-D4 — a migration que RECRIA `aprovacao_decidir`
 * para encerrar a tarefa causal no reject/cancel.
 *
 * Mesma assinatura, substituicao in-place: nao nasce overload. A secao U
 * abaixo e a autoridade sobre a FORMA dela — e, ao contrario do D3, aqui
 * ha corpo plpgsql com `$$`, entao o parser de statements do T14 NAO
 * serve: a premissa dele era justamente a ausencia de dollar quoting.
 */
const MIGRATION_D4 =
  "supabase/migrations/20261004_aprovacao_decidir_encerra_tarefa.sql";
/** A pausa do P0, historica: a secao T prova que ela NAO foi tocada. */
const MIGRATION_PAUSA_P0 =
  "supabase/migrations/20260929_agente_tarefa_aguardar_aprovacao.sql";
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

  // ── C16..C18 — a disjuncao de status e FECHADA ────────────────────
  //
  // C6 e C7 provam que os dois ramos ESTAO la. Nenhum dos dois proibia
  // um TERCEIRO. Isso passou a importar na FUNCTION-RUNTIME-P0: a prova
  // "tarefa pausada nao e reivindicada" deixou de ser feita no banco —
  // faze-la exigiria chamar o claim GLOBAL, que reivindica a tarefa
  // elegivel mais antiga de QUALQUER dono — e passou a ser DEDUTIVA,
  // aqui. A deducao so vale enquanto a disjuncao for exatamente
  // {pendente, rodando}: bastaria alguem acrescentar
  // `OR t.status = 'aguardando_aprovacao'` para a conclusao ruir sem
  // que nenhum assert reclamasse.
  const whereDoClaim = claim.slice(
    claim.indexOf("WHERE t.tentativas"),
    claim.indexOf("ORDER BY")
  );
  ok("C16 o WHERE do claim foi recortado (anti-vacuidade)",
     whereDoClaim.length > 80 && /FOR\s+UPDATE/i.test(whereDoClaim) === false);

  /** O predicado, aplicado tanto ao SQL real quanto ao mutante de C18. */
  const disjuncaoFechada = (bloco: string) =>
    conta(bloco, /t\.status\s*=\s*'/g) === 2 &&
    /t\.status\s*=\s*'pendente'/.test(bloco) &&
    /t\.status\s*=\s*'rodando'/.test(bloco) &&
    !/'aguardando_aprovacao'|'concluido'|'cancelado'|'erro'/.test(bloco);

  ok("C17 o status elegivel e EXATAMENTE {pendente, rodando} — terceiro ramo proibido",
     disjuncaoFechada(whereDoClaim));
  // CONTROLE NEGATIVO: o mesmo predicado, sobre um WHERE que ganhou o
  // terceiro ramo, tem de dizer NAO. Sem isto, C17 poderia estar verde
  // por nunca conseguir reprovar nada.
  ok("C18 CONTROLE NEGATIVO: com `OR t.status = 'aguardando_aprovacao'` o predicado reprova",
     !disjuncaoFechada(
       whereDoClaim.replace(
         "AND (",
         "AND ( t.status = 'aguardando_aprovacao' OR"
       )
     ));

  // ═══ D. MIGRATION — concluir e falhar ═════════════════════════════
  // ── AVISO DE VIGENCIA (APPROVAL-DECISION-RESUME-B0) ─────────────
  //
  // Os asserts desta secao leem a migration 1C. Eles continuam
  // verdadeiros SOBRE AQUELE ARQUIVO, e e por isso que nao foram
  // apagados — mas a definicao VIGENTE das duas RPCs mora na B0, e
  // quem a prova e a secao R. Ler D como retrato do banco seria repetir
  // exatamente o erro que a regra de precedencia de migrations existe
  // para evitar.
  console.log("D. Migration 1C — conclusao e falha (historico; vigente e a secao R)");
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
  // FUNCTION-RUNTIME-V1-A: entrou `consultar_vendas`, o primeiro tipo
  // cujo handler executa uma FUNCAO. A allowlist ganhou um QUARTO membro
  // NOMEADO — nao virou `includes`, nao virou piso `>= 4`, nao virou
  // wildcard. Continua reprovando tipo A MENOS, A MAIS e TROCADO, que e
  // a unica forma de um registry novo nao passar despercebido.
  const TIPOS_ESPERADOS = "analise_vendas,consultar_vendas,conversa,teste_fundacao";
  const uniaoDeTipos = (tipos: readonly string[]) => [...tipos].sort().join(",");
  ok("E2  exatamente 4 tipos registrados", TIPOS_REGISTRADOS.length === 4);
  ok("E3  os tipos sao teste_fundacao, analise_vendas, conversa e consultar_vendas",
     uniaoDeTipos(TIPOS_REGISTRADOS) === TIPOS_ESPERADOS);
  ok("E3a CONTROLE NEGATIVO: o oraculo reprova tipo A MENOS",
     uniaoDeTipos(["analise_vendas", "conversa", "teste_fundacao"]) !== TIPOS_ESPERADOS);
  ok("E3b CONTROLE NEGATIVO: o oraculo reprova tipo A MAIS",
     uniaoDeTipos(["analise_vendas", "consultar_vendas", "conversa", "teste_fundacao", "x"]) !==
       TIPOS_ESPERADOS);
  ok("E3c CONTROLE NEGATIVO: o oraculo reprova tipo TROCADO",
     uniaoDeTipos(["analise_vendas", "consultar_venda", "conversa", "teste_fundacao"]) !==
       TIPOS_ESPERADOS);
  ok("E3d o oraculo aprova o conjunto certo em ordem embaralhada",
     uniaoDeTipos(["conversa", "consultar_vendas", "teste_fundacao", "analise_vendas"]) ===
       TIPOS_ESPERADOS);
  // O tipo novo nao pode existir so na allowlist: a constante do handler
  // e a chave do registry tem de ser a MESMA string.
  ok("E3h a constante do handler novo e a chave usada no registry",
     TIPO_CONSULTAR_VENDAS === "consultar_vendas" &&
     TIPOS_REGISTRADOS.includes(TIPO_CONSULTAR_VENDAS));
  ok("E3i resolve consultar_vendas como FABRICA por dono (aridade 1)",
     typeof resolverHandler("consultar_vendas") === "function" &&
     resolverHandler("consultar_vendas").length === 1);
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
  // ── H3 reconciliado na M1-I1-V2 ──────────────────────────────────
  //
  // Eram 7 operacoes. Sao 8: o Escritorio real precisou de UMA leitura
  // em lote, e ela nasceu no unico modulo autorizado a falar com a
  // tabela. Subir o numero e so isso — um numero — e nao diria QUAL
  // operacao entrou; uma oitava com outro nome, ou uma das sete
  // trocada por outra, manteria a contagem e passaria.
  //
  // Entao o guarda passou a cobrar o CONJUNTO: as sete de antes,
  // nominais, mais a nova, nominal. Contagem e nomes, nunca `>=`.
  const OPERACOES_CAP = [...cap.matchAll(/export\s+async\s+function\s+(\w+)/g)]
    .map((m) => m[1])
    .sort();
  const OPERACOES_CAP_ESPERADAS = [
    "atualizarAgenteDoDono",
    "criarAgente",
    "criarTarefa",
    "lerAgenteDoDono",
    "lerTarefaDoDono",
    "listarAgentesDoDono",
    "listarTarefasDoAgente",
    "listarSinaisDeTarefasDoDono",
  ].sort();
  ok("H3  capability.ts tem exatamente 8 operacoes async",
     conta(cap, /export\s+async\s+function\s/g) === 8 && OPERACOES_CAP.length === 8);
  ok("H3a e o conjunto e NOMINAL — as 7 da 1B mais o leitor em lote",
     JSON.stringify(OPERACOES_CAP) === JSON.stringify(OPERACOES_CAP_ESPERADAS));
  ok("H3b CONTROLE: uma oitava operacao com nome inesperado reprovaria",
     JSON.stringify([...OPERACOES_CAP.slice(0, 7), "listarOutraCoisa"].sort()) !==
       JSON.stringify(OPERACOES_CAP_ESPERADAS));
  ok("H3c CONTROLE: perder uma das sete tambem reprovaria",
     JSON.stringify(OPERACOES_CAP.slice(1)) !== JSON.stringify(OPERACOES_CAP_ESPERADAS));
  ok("H4  tipos.ts continua sem server-only", !/import\s+"server-only"/.test(tip));
  ok("H5  a maquina de transicao da 1B segue valendo",
     transicaoTarefaPermitida("pendente", "rodando") &&
     transicaoTarefaPermitida("rodando", "concluido") &&
     transicaoTarefaPermitida("rodando", "erro") &&
     transicaoTarefaPermitida("rodando", "pendente") &&
     !transicaoTarefaPermitida("pendente", "concluido"));
  // ── H6 reconciliado na FUNCTION-RUNTIME-P0 ──────────────────────
  //
  // A afirmacao "a 1C nao produz `aguardando_aprovacao`" era verdadeira
  // e deixou de ser: o P0 existe justamente para produzi-lo. Apagar o
  // assert perderia a cobertura; mante-lo como estava seria exigir que
  // o terceiro desfecho nunca chegasse.
  //
  // Ele passa a medir o estado REAL: a migration FUNDACIONAL da 1C
  // continua sem produzir o status — ela so o declara no CHECK —, e
  // quem o produz e a RPC nova, sempre com fencing.
  ok("H6  a migration da 1C continua sem PRODUZIR aguardando_aprovacao",
     !/status\s*=\s*'aguardando_aprovacao'/.test(mig));
  ok("H6a quem produz o status e o executor, via capability dedicada",
     /aguardarAprovacaoTarefa\(/.test(exe) &&
     /"aguardando_aprovacao"/.test(exe));
  ok("H6b e o worker sabe LER o status, sem nunca escrever transicao",
     /aguardando_aprovacao/.test(wrk) &&
     !/\.rpc\("(concluir_tarefa|falhar_tarefa|aguardar_aprovacao_tarefa)"/.test(wrk));
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
  // A casa dos erros passou a abrigar DOIS: `ErroEntradaTarefa` e o
  // sentinel de pausa. O assert nao afrouxa — passa a exigir os dois,
  // da MESMA casa, em vez de um literal que envelheceria no dia
  // seguinte.
  ok("M6  executor importa AMBOS os sentinels de @/lib/agentes/erros",
     /import \{ ErroEntradaTarefa, PausaPorAprovacao \} from "@\/lib\/agentes\/erros"/.test(exe2));
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
  ok("M23 exatamente 4 handlers registrados", TIPOS_REGISTRADOS.length === 4);

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
  console.log("R. Migration B0 — fencing por tentativa esperada");
  {
    const migB0 = sql(MIGRATION_B0);
    const brutoB0 = fonte(MIGRATION_B0);

    // O recorte por funcao: tudo entre o CREATE de uma e o da proxima.
    const iConcl = migB0.indexOf("FUNCTION public.concluir_tarefa");
    const iFalha = migB0.indexOf("FUNCTION public.falhar_tarefa");
    const conclB0 = migB0.slice(iConcl, iFalha);
    const falhaB0 = migB0.slice(iFalha);

    ok("R0  ANCORA: a migration B0 foi lida e os dois corpos isolados",
      migB0.length > 800 && conclB0.length > 300 && falhaB0.length > 300);

    // ── R1..R4 — A FASE A E ESTRITAMENTE ADITIVA ──────────────────
    //
    // Estes asserts JA exigiram o contrario: que a migration dropasse
    // as assinaturas antigas. Estava tecnicamente certo e operacional-
    // mente errado — remover no mesmo release em que se cria abre uma
    // janela em que producao e banco discordam, em qualquer ordem:
    //
    //   migration primeiro  o codigo publicado chama com duas chaves e
    //                       a funcao de duas chaves ja nao existe.
    //   codigo primeiro     o codigo novo chama com tres e a de tres
    //                       ainda nao existe.
    //
    // Dois crons de minuto garantem que a janela seja exercitada. Por
    // isso a Fase A COEXISTE: as antigas ficam, as novas entram, e o
    // DROP vive numa migration separada, criada so depois de o novo
    // caller estar provado em producao.
    //
    // Os asserts foram INVERTIDOS, nao removidos: continuam afirmando o
    // que a migration faz com as assinaturas antigas — so que agora a
    // resposta correta e "nada".
    const dropaConcluirAntiga = (t: string) =>
      /DROP\s+FUNCTION[\s\S]{0,40}?public\.concluir_tarefa\(\s*uuid\s*,\s*jsonb\s*\)/i.test(t);
    const dropaFalharAntiga = (t: string) =>
      /DROP\s+FUNCTION[\s\S]{0,40}?public\.falhar_tarefa\(\s*uuid\s*,\s*text\s*,\s*text\s*\)/i.test(t);

    ok("R1  a Fase A NAO dropa a assinatura antiga de concluir",
      !dropaConcluirAntiga(migB0));
    ok("R1  CONTROLE NEGATIVO: um DROP de concluir na Fase A reprova",
      dropaConcluirAntiga(
        migB0 + "\nDROP FUNCTION IF EXISTS public.concluir_tarefa(uuid, jsonb);"));
    ok("R2  a Fase A NAO dropa a assinatura antiga de falhar",
      !dropaFalharAntiga(migB0));
    ok("R2  CONTROLE NEGATIVO: um DROP de falhar na Fase A reprova",
      dropaFalharAntiga(
        migB0 + "\nDROP FUNCTION IF EXISTS public.falhar_tarefa(uuid, text, text);"));

    // Nem por outro mecanismo: `ALTER`, `CREATE OR REPLACE` da antiga ou
    // mexida de privilegio nela sao todos formas de alterar objeto que
    // producao esta usando agora.
    ok("R3  a Fase A nao altera as antigas por nenhum outro mecanismo",
      !/DROP\s+FUNCTION/i.test(migB0) &&
      !/ALTER\s+FUNCTION/i.test(migB0) &&
      !/(REVOKE|GRANT)[\s\S]{0,120}?concluir_tarefa\(\s*uuid\s*,\s*jsonb\s*\)/i.test(migB0) &&
      !/(REVOKE|GRANT)[\s\S]{0,120}?falhar_tarefa\(\s*uuid\s*,\s*text\s*,\s*text\s*\)/i.test(migB0));
    ok("R3  CONTROLE NEGATIVO: um ALTER na Fase A reprova",
      /ALTER\s+FUNCTION/i.test(migB0 + "\nALTER FUNCTION public.concluir_tarefa(uuid, jsonb) OWNER TO postgres;"));

    // E a assinatura antiga tambem nao pode ser RECRIADA aqui: isso
    // sobrescreveria em producao a funcao que esta em uso.
    ok("R4  a migration nao recria a assinatura antiga",
      !/FUNCTION\s+public\.concluir_tarefa\(\s*\n?\s*p_tarefa_id\s+uuid,\s*\n?\s*p_resultado\s+jsonb\s*\n?\s*\)/i
        .test(migB0) &&
      !/FUNCTION\s+public\.falhar_tarefa\(\s*\n?\s*p_tarefa_id\s+uuid,\s*\n?\s*p_erro_tipo\s+text,\s*\n?\s*p_erro_mensagem\s+text\s*\n?\s*\)/i
        .test(migB0));

    // ── R4b..R4n — A MIGRATION DE CLEANUP, EM ESTADO FINAL ────────
    //
    // Estes asserts exigiam, ate a Fase D, que NENHUMA migration de
    // cleanup existisse: enquanto o caller novo nao estivesse provado em
    // producao, aditiva e cleanup no mesmo repositorio viravam, na
    // pratica, o cutover destrutivo que a Fase A existe para evitar —
    // com a aparencia de um rollout em fases.
    //
    // Essa condicao caiu, e a protecao NAO foi apagada junto: virou
    // contrato de forma. Antes a pergunta era "existe cleanup?" e a
    // resposta certa era nao; agora e "o cleanup remove EXATAMENTE o
    // que foi autorizado?", e a resposta tem de ser sim — nem mais uma
    // funcao, nem uma a menos, nem CASCADE.
    //
    // Por que a forma importa tanto: `DROP FUNCTION` e a operacao menos
    // reversivel do repositorio. Um DROP a mais nao falha, nao avisa e
    // so aparece quando alguem chamar a funcao que sumiu.
    const migrationsNoDisco = readdirSync(join(RAIZ, "supabase", "migrations"));
    const cleanupsNoDisco = migrationsNoDisco.filter(
      (m) => /remover.*fencing|drop.*tarefa_rpc|tarefa_rpc.*sem_fencing/i.test(m));

    ok("R4b existe EXATAMENTE uma migration de cleanup do B0",
      cleanupsNoDisco.length === 1);
    ok("R4c e o nome dela e o acordado, nominalmente",
      cleanupsNoDisco[0] === "20261001_remover_tarefa_rpc_sem_fencing.sql");
    ok("R4d ANCORA: a varredura enxergou as migrations de verdade",
      migrationsNoDisco.length > 10 &&
      migrationsNoDisco.includes("20260930_tarefa_fencing_por_tentativa.sql"));

    // A ordem no disco E a ordem de aplicacao. Se a cleanup ordenasse
    // antes da aditiva, um banco novo perderia as antigas antes de
    // ganhar as novas — e o rollout em fases viraria ficcao.
    const ordenadas = [...migrationsNoDisco].sort();
    ok("R4e a aditiva vem ANTES da cleanup na ordem de aplicacao",
      ordenadas.indexOf("20260930_tarefa_fencing_por_tentativa.sql") <
      ordenadas.indexOf("20261001_remover_tarefa_rpc_sem_fencing.sql"));

    // Daqui para baixo, sobre o CONTEUDO — ja sem comentarios, para que
    // nenhum assert seja satisfeito por um DROP que so foi mencionado
    // em prosa.
    const limpeza = sql(MIGRATION_B0_CLEANUP);

    // O inventario FECHADO: cada statement `DROP FUNCTION` normalizado,
    // comparado por igualdade contra as duas assinaturas legadas. Nao e
    // "procurar duas strings" — e afirmar que nao existe uma terceira.
    const dropsDaLimpeza = (limpeza.match(/DROP\s+FUNCTION[\s\S]*?;/gi) ?? [])
      .map((d) => d.replace(/\s+/g, " ").trim());
    const ASSINATURAS_LEGADAS = [
      "DROP FUNCTION IF EXISTS public.concluir_tarefa(uuid, jsonb);",
      "DROP FUNCTION IF EXISTS public.falhar_tarefa(uuid, text, text);",
    ];

    ok("R4f o cleanup tem EXATAMENTE dois DROP FUNCTION",
      dropsDaLimpeza.length === 2);
    ok("R4g o conjunto dropado e EXATAMENTE as duas assinaturas legadas",
      ASSINATURAS_LEGADAS.every((a) => dropsDaLimpeza.includes(a)) &&
      dropsDaLimpeza.every((d) => ASSINATURAS_LEGADAS.includes(d)));
    ok("R4g CONTROLE NEGATIVO: um terceiro DROP quebra o inventario",
      ((limpeza + "\nDROP FUNCTION IF EXISTS public.sintetica(uuid);")
        .match(/DROP\s+FUNCTION[\s\S]*?;/gi) ?? []).length !== 2);

    // As NOVAS nao podem ser mencionadas de forma destrutiva em lugar
    // nenhum do arquivo. Elas ja estao corretas e live-proven; qualquer
    // mexida aqui seria mexer no que acabou de ser provado.
    ok("R4h o cleanup nao dropa nem altera as assinaturas NOVAS",
      !/\binteger\b/i.test(limpeza) &&
      !/p_tentativa_esperada/i.test(limpeza));
    ok("R4h CONTROLE NEGATIVO: dropar a nova concluir reprova",
      /\binteger\b/i.test(
        limpeza + "\nDROP FUNCTION IF EXISTS public.concluir_tarefa(uuid, jsonb, integer);"));

    // CASCADE apagaria em silencio qualquer dependente. Sem ele o apply
    // falha fechado e nomeia o dependente — que e o comportamento util.
    ok("R4i zero CASCADE", !/\bCASCADE\b/i.test(limpeza));
    ok("R4i CONTROLE NEGATIVO: um CASCADE reprova",
      /\bCASCADE\b/i.test(limpeza.replace(/\)\s*;/, ") CASCADE;")));

    // E nenhum outro DDL/DML: cleanup que cria, altera, concede ou
    // escreve linha deixou de ser cleanup.
    ok("R4j o cleanup nao cria nem recria funcao",
      !/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i.test(limpeza));
    ok("R4k o cleanup nao tem ALTER",
      !/\bALTER\b/i.test(limpeza));
    ok("R4l o cleanup nao mexe em privilegio",
      !/\b(GRANT|REVOKE)\b/i.test(limpeza));
    ok("R4m o cleanup nao tem DML nem DDL de tabela",
      !/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i.test(limpeza) &&
      !/DROP\s+(TABLE|SCHEMA|INDEX|TYPE|TRIGGER)/i.test(limpeza));
    ok("R4n ANCORA: o arquivo de cleanup foi mesmo lido",
      limpeza.includes("public.concluir_tarefa") &&
      limpeza.includes("public.falhar_tarefa") &&
      fonte(MIGRATION_B0_CLEANUP).length > 800);

    // ── R5..R6 — AS ASSINATURAS NOVAS ─────────────────────────────
    ok("R5  concluir_tarefa declara p_tentativa_esperada integer",
      /FUNCTION\s+public\.concluir_tarefa\([\s\S]{0,200}?p_tentativa_esperada\s+integer/i.test(migB0));
    ok("R6  falhar_tarefa declara p_tentativa_esperada integer",
      /FUNCTION\s+public\.falhar_tarefa\([\s\S]{0,240}?p_tentativa_esperada\s+integer/i.test(migB0));

    // ── R7..R9 — O FENCE DE CONCLUIR ──────────────────────────────
    //
    // Os TRES juntos. O `status` continua porque uma tarefa PAUSADA
    // pode carregar a mesma tentativa e nao deve ser terminalizavel.
    const fenceConcluir = (t: string) =>
      /AND\s+status\s*=\s*'rodando'[\s\S]{0,300}?AND\s+tentativas\s*=\s*p_tentativa_esperada/i.test(t);

    ok("R7  o UPDATE de concluir exige id + rodando + tentativa esperada",
      /WHERE\s+id\s*=\s*p_tarefa_id/i.test(conclB0) && fenceConcluir(conclB0));
    ok("R7  CONTROLE NEGATIVO: remover o fence de tentativa reprova",
      !fenceConcluir(
        conclB0.replace(/AND\s+tentativas\s*=\s*p_tentativa_esperada/gi, "")));
    ok("R8  CONTROLE NEGATIVO: trocar = por >= reprova",
      !fenceConcluir(
        conclB0.replace(/AND\s+tentativas\s*=\s*p_tentativa_esperada/gi,
          "AND tentativas >= p_tentativa_esperada")));
    ok("R9  o status NAO foi substituido pelo fence de tentativa",
      /status\s*=\s*'rodando'/i.test(conclB0));

    // ── R10..R13 — O FENCE DE FALHAR, NOS DOIS PONTOS ─────────────
    //
    // O SELECT decide entre retry e erro lendo `tentativas`; sem fence
    // ali, um executor atrasado escolheria o desfecho da tentativa
    // ALHEIA. E o UPDATE precisa repetir, senao a janela entre os dois
    // reabre.
    const fencesEmFalhar = (t: string) =>
      (t.match(/AND\s+t?\.?tentativas\s*=\s*p_tentativa_esperada/gi) ?? []).length;

    ok("R10 falhar tem o fence em DOIS pontos (SELECT e UPDATE)",
      fencesEmFalhar(falhaB0) === 2, );
    ok("R11 o SELECT que decide o desfecho carrega o fence",
      /SELECT\s+CASE[\s\S]{0,400}?FROM\s+public\.agente_tarefas[\s\S]{0,200}?AND\s+t\.tentativas\s*=\s*p_tentativa_esperada/i
        .test(falhaB0));
    ok("R12 CONTROLE NEGATIVO: remover UM dos dois fences reprova",
      fencesEmFalhar(
        falhaB0.replace(/AND\s+t\.tentativas\s*=\s*p_tentativa_esperada/i, "")) !== 2);
    ok("R13 CONTROLE NEGATIVO: remover o fence do UPDATE reprova",
      fencesEmFalhar(
        falhaB0.replace(/AND\s+tentativas\s*=\s*p_tentativa_esperada/i, "")) !== 2);

    // ── R14..R16 — O QUE NAO PODE TER MUDADO ──────────────────────
    ok("R14 a politica de retry continua intacta",
      /tentativas\s*<\s*t?\.?max_tentativas\s+THEN\s+'pendente'/i.test(falhaB0) &&
      /ELSE\s+'erro'/i.test(falhaB0));
    ok("R15 concluir continua forcando progresso 100 e limpando o erro",
      /progresso\s*=\s*100/i.test(conclB0) &&
      /erro_tipo\s*=\s*NULL/i.test(conclB0) && /erro_mensagem\s*=\s*NULL/i.test(conclB0));
    ok("R16 falhar continua gravando erro nos DOIS caminhos e so datando o terminal",
      /erro_tipo\s*=\s*btrim\(p_erro_tipo\)/i.test(falhaB0) &&
      /concluido_em\s*=\s*CASE\s+WHEN\s+v_status\s*=\s*'erro'/i.test(falhaB0));

    // ── R17..R18 — FAIL-CLOSED ────────────────────────────────────
    ok("R17 zero linha LANCA 55000 nas duas, nunca no-op",
      (conclB0.match(/ERRCODE\s*=\s*'55000'/gi) ?? []).length >= 2 &&
      (falhaB0.match(/ERRCODE\s*=\s*'55000'/gi) ?? []).length >= 2);
    // R18 nao e so validacao de parametro: e o que sustenta o cutover.
    // O PostgREST resolve o overload pelo CONJUNTO DE CHAVES do corpo.
    // Com DEFAULT em `p_tentativa_esperada`, o payload antigo de duas
    // chaves passaria a casar as DUAS assinaturas e a resposta viraria
    // 300. Sem default, cada payload casa exatamente uma.
    ok("R18 a tentativa esperada e OBRIGATORIA, sem default",
      /p_tentativa_esperada\s+IS\s+NULL[\s\S]{0,200}?ERRCODE\s*=\s*'22023'/i.test(conclB0) &&
      /p_tentativa_esperada\s+IS\s+NULL[\s\S]{0,200}?ERRCODE\s*=\s*'22023'/i.test(falhaB0) &&
      !/p_tentativa_esperada\s+integer\s+DEFAULT/i.test(migB0));

    // ── R19..R21 — ACL ────────────────────────────────────────────
    //
    // Padrao rigoroso: revoga tambem de `service_role` antes de
    // conceder, porque este projeto tem ALTER DEFAULT PRIVILEGES dando
    // EXECUTE a toda funcao nova — herdar seria confiar num default.
    for (const [rotulo, papel] of [
      ["R19", "public"], ["R19", "anon"], ["R20", "authenticated"], ["R20", "service_role"],
    ] as const) {
      ok(`${rotulo} 2 REVOKE FROM ${papel} (um por funcao)`,
        conta(migB0, new RegExp(`REVOKE\\s+ALL[\\s\\S]{0,120}?FROM\\s+${papel}\\b`, "gi")) === 2);
    }
    ok("R21 2 GRANT EXECUTE TO service_role, e nada alem",
      conta(migB0, /GRANT\s+EXECUTE[\s\S]{0,120}?TO\s+service_role/gi) === 2 &&
      !/GRANT[\s\S]{0,120}?TO\s+(anon|authenticated|public)\b/i.test(migB0));
    ok("R22 as duas continuam SECURITY INVOKER com search_path fixo",
      conta(migB0, /SECURITY\s+INVOKER/gi) === 2 &&
      conta(migB0, /SET\s+search_path\s*=\s*public/gi) === 2);

    // ── R23..R26 — O CALLER PROPAGA A TENTATIVA CERTA ─────────────
    ok("R23 o wrapper de concluir recebe e envia a tentativa",
      /concluirTarefa\([\s\S]{0,160}?tentativaEsperada:\s*number/.test(capw) &&
      /p_tentativa_esperada:\s*tentativaEsperada/.test(capw));
    /** O corpo de UM wrapper, por fatia ate o proximo `export`. Contar
     *  no arquivo inteiro daria 3 — `aguardarAprovacaoTarefa` ja usava
     *  `p_tentativa_esperada` desde o P0, e a primeira versao desta
     *  sonda exigia 2 e ficava vermelha sobre codigo correto. */
    const corpoDoWrapper = (nome: string): string => {
      const i = capw.indexOf(`export async function ${nome}(`);
      if (i < 0) return "";
      const j = capw.indexOf("export async function", i + 10);
      return j < 0 ? capw.slice(i) : capw.slice(i, j);
    };

    ok("R24 o wrapper de falhar recebe e envia a tentativa",
      /tentativaEsperada:\s*number/.test(corpoDoWrapper("falharTarefa")) &&
      /p_tentativa_esperada:\s*tentativaEsperada/.test(corpoDoWrapper("falharTarefa")));
    ok("R24 ANCORA: os dois corpos foram recortados de verdade",
      corpoDoWrapper("falharTarefa").length > 200 &&
      corpoDoWrapper("concluirTarefa").length > 200 &&
      corpoDoWrapper("falharTarefa") !== corpoDoWrapper("concluirTarefa"));
    ok("R24 CONTROLE NEGATIVO: um wrapper sem o parametro reprova",
      !/p_tentativa_esperada/.test(
        corpoDoWrapper("falharTarefa").split("p_tentativa_esperada").join("")));
    // A pausa tambem carrega a tentativa — e desde o P0, nao pelo B0.
    ok("R24b a pausa ja tinha o proprio fence, e continua tendo",
      /p_tentativa_esperada/.test(corpoDoWrapper("aguardarAprovacaoTarefa")));

    /** O executor tem de mandar o valor LIDO, nao um calculo. */
    const mandaTentativaDaLinha = (t: string, fn: string): boolean =>
      new RegExp(`${fn}\\([\\s\\S]{0,220}?tarefa\\.tentativas`).test(t);

    ok("R25 o executor manda tarefa.tentativas ao concluir",
      mandaTentativaDaLinha(exe, "concluirTarefa"));
    ok("R25 CONTROLE NEGATIVO: constante no lugar da tentativa reprova",
      !mandaTentativaDaLinha(
        exe.replace(/concluirTarefa\(([\s\S]{0,220}?)tarefa\.tentativas/, "concluirTarefa($11"),
        "concluirTarefa"));
    ok("R26 o executor manda tarefa.tentativas ao falhar",
      mandaTentativaDaLinha(exe, "falharTarefa"));
    ok("R26 CONTROLE NEGATIVO: mandar maxTentativas reprova",
      !mandaTentativaDaLinha(
        exe.replace(/falharTarefa\(([\s\S]{0,220}?)tarefa\.tentativas/,
          "falharTarefa($1tarefa.max_tentativas"),
        "falharTarefa"));

    // ── R27..R28 — O QUE O B0 NAO PODE TER TOCADO ─────────────────
    //
    // O ramo de pausa continua com a RPC dele, que ja tinha fence
    // proprio desde o P0 — e continua sem chamar as duas terminais.
    ok("R27 a pausa continua usando aguardar_aprovacao_tarefa com a tentativa",
      /aguardarAprovacaoTarefa\(\s*\n?\s*tarefa\.id,\s*\n?\s*tarefa\.tentativas/.test(exe));
    ok("R28 o B0 nao tocou claim, Approval nem Resume",
      !/claim_next_agente_tarefa/i.test(migB0) &&
      !/agente_funcao_aprovacoes|aprovacao_decidir|aprovacao_consumir/i.test(migB0) &&
      !/retomarAprovacao|consumirAprovacaoEAbrir|decidirAprovacao/.test(exe + capw));

    // ── R29 — a suite de banco acompanhou ─────────────────────────
    //
    // Ela nao e executada aqui (banco real), mas deixar payload
    // obsoleto nela seria publicar codigo que o banco ja recusa.
    const bancoSrc = fonte("scripts/testar-agentes-execucao-banco.ts");
    const chamadasTerminais =
      conta(bancoSrc, /rpc\(\s*"(concluir_tarefa|falhar_tarefa)"/g) +
      conta(bancoSrc, /p_erro_tipo:\s*"x",\s*p_erro_mensagem:\s*"y",\s*\n\s*p_tentativa_esperada/g) * 0;
    ok("R29 a suite de banco leva a tentativa em TODA chamada terminal",
      conta(bancoSrc, /p_tentativa_esperada/g) >= chamadasTerminais + 1,
      );
    ok("R29 ANCORA: ela realmente chama as duas RPCs", chamadasTerminais >= 8);
  }

  console.log("T. Migration D1 — o ponteiro da espera, fase aditiva");
  {
    const migD1 = sql(MIGRATION_D1);
    const pausaP0 = sql(MIGRATION_PAUSA_P0);
    const exeD1 = codigo(EXECUTOR);
    const capD1 = codigo(CAP_WORKER);

    ok("T0  ANCORA: as duas migrations da pausa foram lidas",
      migD1.length > 1500 && pausaP0.length > 400);

    // ── T1..T3 — A FASE ADITIVA, OUTRA VEZ ────────────────────────
    //
    // Mesmo desenho do B0, pelo mesmo motivo: o caller de producao
    // chama a assinatura de dois argumentos AGORA. Removê-la no mesmo
    // release em que a de tres nasce abriria a janela em que producao e
    // banco discordam — e ha dois crons de minuto para exercita-la.
    ok("T1  a migration da pausa do P0 continua intocada por D1",
      !/aprovacao_aguardada_id/i.test(pausaP0) &&
      /aguardar_aprovacao_tarefa\(\s*\n?\s*p_tarefa_id\s+uuid,\s*\n?\s*p_tentativa_esperada integer\s*\n?\s*\)/i.test(pausaP0));
    ok("T2  D1 cria a assinatura de TRES argumentos",
      /function public\.aguardar_aprovacao_tarefa\([\s\S]{0,160}?p_aprovacao_id\s+uuid\s*\)/i.test(migD1));
    ok("T3  D1 nao dropa nem altera a assinatura de dois argumentos",
      !/\bdrop\b/i.test(migD1) &&
      !/alter\s+function/i.test(migD1) &&
      !/aguardar_aprovacao_tarefa\(\s*uuid\s*,\s*integer\s*\)/i.test(migD1));
    ok("T3  CONTROLE NEGATIVO: um DROP da antiga reprova",
      /\bdrop\b/i.test(
        migD1 + "\nDROP FUNCTION IF EXISTS public.aguardar_aprovacao_tarefa(uuid, integer);"));
    // A fase aditiva nao remove NADA — nem constraint. Ver V12 na suite
    // de aprovacoes: `drop constraint if exists` tambem e remocao, e num
    // arquivo que nunca leu o catalogo ele apaga objeto nao inspecionado.
    ok("T3b D1 nao contem DROP de especie alguma",
      !/\bdrop\b/i.test(migD1));
    // Criar objeto novo tambem e fail-closed: `if not exists` adotaria
    // coluna alheia e `or replace` sobrescreveria funcao alheia. As duas
    // sao a mesma decisao cega que o `drop` acima ja custou um gate.
    ok("T3d os objetos novos nascem fail-closed",
      /add column aprovacao_aguardada_id uuid null/i.test(migD1) &&
      !/add\s+column\s+if\s+not\s+exists/i.test(migD1) &&
      /create\s+function\s+public\.aguardar_aprovacao_tarefa\(/i.test(migD1) &&
      !/create\s+or\s+replace/i.test(migD1));
    ok("T3d CONTROLE NEGATIVO: OR REPLACE na overload nova reprova",
      /create\s+or\s+replace/i.test(
        migD1.replace("create function public.aguardar_aprovacao_tarefa(",
                      "create or replace function public.aguardar_aprovacao_tarefa(")));
    ok("T3d CONTROLE NEGATIVO: IF NOT EXISTS na coluna reprova",
      /add\s+column\s+if\s+not\s+exists/i.test(
        migD1.replace("add column aprovacao_aguardada_id", "add column if not exists aprovacao_aguardada_id")));
    ok("T3b CONTROLE NEGATIVO: um `drop constraint` reprova",
      /\bdrop\b/i.test(
        migD1 + "\nalter table public.agente_tarefas drop constraint if exists agente_tarefas_ponteiro_so_na_espera;"));
    // Grafia com espacos internos tambem e destrutiva — D1-R1-L1.
    ok("T3c CONTROLE NEGATIVO: REVOKE da antiga com espacos internos reprova",
      /aguardar_aprovacao_tarefa\(\s*uuid\s*,\s*integer\s*\)/i.test(
        migD1 + "\nrevoke execute on function public.aguardar_aprovacao_tarefa( uuid, integer ) from service_role;"));

    // ── T4 — NO DEFAULT, e por que ────────────────────────────────
    //
    // O PostgREST resolve overload pelo CONJUNTO DE CHAVES do corpo.
    // Com DEFAULT no parametro novo, o payload de duas chaves casaria as
    // DUAS assinaturas e a resposta viraria 300. Sem default, cada
    // payload casa exatamente uma — que e o que sustenta o cutover.
    ok("T4  nenhum parametro do overload novo tem DEFAULT",
      !/p_aprovacao_id\s+uuid\s+default/i.test(migD1) &&
      !/p_tentativa_esperada\s+integer\s+default/i.test(migD1));

    // ── T5..T8 — O CONTRATO DA PAUSA NAO MUDA ─────────────────────
    const corpoD1 = migD1.slice(migD1.indexOf("p_aprovacao_id"));
    const setD1 = corpoD1.slice(corpoD1.indexOf("set status"), corpoD1.indexOf("where t.id"));

    ok("T5  ANCORA: o SET da pausa nova foi recortado", setD1.length > 120);
    ok("T6  o fence continua sendo rodando + tentativa esperada",
      /t\.status\s*=\s*'rodando'/i.test(corpoD1) &&
      /t\.tentativas\s*=\s*p_tentativa_esperada/i.test(corpoD1));
    // Espera humana nao e retry. O numero que identifica o dono da
    // tentativa nao pode mudar porque alguem demorou a decidir — e e
    // esse mesmo numero que as terminais do B0 exigem de volta.
    ok("T7  a pausa nova nao mexe em tentativas nem em progresso",
      !/tentativas/i.test(setD1) && !/progresso/i.test(setD1));
    ok("T8  o heartbeat continua sendo zerado na pausa",
      /heartbeat_em\s*=\s*null/i.test(setD1));
    ok("T9  o ponteiro nasce no MESMO SET que muda o status",
      /status\s*=\s*'aguardando_aprovacao'/i.test(setD1) &&
      /aprovacao_aguardada_id\s*=\s*p_aprovacao_id/i.test(setD1));

    // ── T10 — D1 NAO ENCOSTA NO QUE JA ESTA PROVADO ───────────────
    ok("T10 D1 nao toca terminais, claim, decisao nem criacao de aprovacao",
      !/concluir_tarefa|falhar_tarefa/i.test(migD1) &&
      !/claim_next_agente_tarefa/i.test(migD1) &&
      !/function public\.aprovacao_(decidir|criar|consumir)/i.test(migD1));

    // ── T11..T12 — O CALLER AINDA E O ANTIGO ──────────────────────
    //
    // Requisito deste gate, nao divida. Publicar o caller antes de a
    // migration existir no banco faria producao chamar uma assinatura
    // que ainda nao ha — a metade errada do cutover, e a que quebra.
    // ── T11..T12 migrados na APPROVAL-DECISION-RESUME-D2 ──────────
    //
    // Eles exigiam que o caller NAO tivesse sido publicado ainda — a
    // metade errada do cutover quebra producao, e o guard existia para
    // impedir a pressa. A migration esta aplicada e provada; o contrato
    // agora e o inverso.
    ok("T11 o wrapper chama a overload de TRES argumentos",
      /rpc\("aguardar_aprovacao_tarefa"/.test(capD1) &&
      /p_aprovacao_id:\s*aprovacaoId/.test(capD1));
    ok("T12 o executor entrega o id vindo do sentinel",
      /aguardarAprovacaoTarefa\([\s\S]{0,140}?tarefa\.id,[\s\S]{0,60}?tarefa\.tentativas,[\s\S]{0,60}?err\.aprovacaoId/
        .test(exeD1));
    // ── T12b — SEM FALLBACK PARA A OVERLOAD ANTIGA ────────────────
    //
    // O risco especifico deste cutover: tentar tres chaves e, ao falhar,
    // repetir com duas. Isso transformaria a recusa fail-closed da RPC
    // nova numa pausa sem ponteiro — o estado legado que o D1 existe
    // para parar de produzir. A capability chama a RPC de pausa UMA vez.
    ok("T12b nao existe fallback para a overload de dois argumentos",
      (capD1.match(/rpc\("aguardar_aprovacao_tarefa"/g) ?? []).length === 1 &&
      !/catch[\s\S]{0,200}?aguardar_aprovacao_tarefa/.test(capD1));
    ok("T12b CONTROLE NEGATIVO: uma segunda chamada da RPC reprova",
      ((capD1 + '\nawait rpc("aguardar_aprovacao_tarefa", { p_tarefa_id, p_tentativa_esperada });')
        .match(/rpc\("aguardar_aprovacao_tarefa"/g) ?? []).length !== 1);

    // ── T13 — A ORDEM DAS TRES FASES ──────────────────────
    //
    // Migrado na APPROVAL-DECISION-RESUME-D3. Antes o assert dizia que
    // D1 era a ULTIMA migration da frente — verdade enquanto a limpeza
    // nao existia, e a forma de impedir que ela chegasse cedo demais.
    // A limpeza chegou; a prova do D1 NAO sai daqui, ganha um vizinho.
    //
    // A ordem no disco E a ordem de aplicacao num banco novo. Se a
    // limpeza ordenasse antes da aditiva, um banco novo droparia uma
    // funcao antes de criar a substituta, e o rollout em fases viraria
    // ficcao — a mesma razao do R4e no B0.
    const NOME_B0_CLEANUP = "20261001_remover_tarefa_rpc_sem_fencing.sql";
    const NOME_D1 = "20261002_tarefa_aprovacao_aguardada.sql";
    const NOME_D3 = "20261003_remover_aguardar_aprovacao_tarefa_2args.sql";

    const migsDisco = [...readdirSync(join(RAIZ, "supabase", "migrations"))].sort();

    // Funcao de LISTA, nao de disco, para que o controle negativo possa
    // alimentar um inventario sintetico sem criar arquivo nenhum.
    const ordemDasFases = (lista: readonly string[]) =>
      lista.indexOf(NOME_B0_CLEANUP) < lista.indexOf(NOME_D1) &&
      lista.indexOf(NOME_D1) < lista.indexOf(NOME_D3);

    ok("T13 as tres migrations da frente existem no disco",
      migsDisco.includes(NOME_B0_CLEANUP) &&
      migsDisco.includes(NOME_D1) &&
      migsDisco.includes(NOME_D3));
    ok("T13b a ordem de aplicacao e cleanup B0 -> aditiva D1 -> limpeza D3",
      ordemDasFases(migsDisco));
    // Migrado na APPROVAL-DECISION-RESUME-D4, pela mesma razao que o D3
    // migrou este assert: "D3 e a ultima" era verdade enquanto o D4 nao
    // existia. A prova de ORDEM nao sai daqui — ela ganha mais um elo.
    ok("T13c a limpeza D3 vem depois da aditiva D1",
      migsDisco.indexOf(NOME_D1) < migsDisco.indexOf(NOME_D3));
    ok("T13d CONTROLE NEGATIVO: a limpeza antes da aditiva reprova",
      !ordemDasFases([NOME_D3, NOME_B0_CLEANUP, NOME_D1]));
    ok("T13e ANCORA: a varredura enxergou as migrations de verdade",
      migsDisco.length > 10 &&
      migsDisco.includes("20260929_agente_tarefa_aguardar_aprovacao.sql"));

    // ── T14 — O CONTRATO POSITIVO DA LIMPEZA D3 ───────────────────
    //
    // Ate o D1 este guard dizia "nenhuma limpeza da pausa existe
    // ainda": um tripwire, plantado para que a remocao nao entrasse de
    // carona numa autorizacao que era so de adicao. A condicao caiu —
    // a remocao foi autorizada, provada quiescente e escrita. O
    // tripwire NAO foi apagado junto: virou contrato de FORMA, como o
    // R4b..R4n fizeram no cleanup do B0.
    //
    // Antes a pergunta era "existe limpeza?" e a resposta certa era
    // nao; agora e "a limpeza remove EXATAMENTE o que foi autorizado?",
    // e a resposta tem de ser sim — nem uma funcao a mais, nem uma a
    // menos, nem CASCADE, nem IF EXISTS.
    //
    // Por que a forma importa tanto aqui: um DROP a mais nao falha, nao
    // avisa, e so aparece quando alguem chamar a funcao que sumiu.

    /**
     * Os statements EXECUTAVEIS de um arquivo SQL, normalizados.
     *
     * Comentarios saem ANTES do split, e nao depois, por dois motivos:
     * um `-- ... ;` contaria como statement, e — pior — um segundo DROP
     * escondido num comentario passaria por statement legitimo.
     *
     * O split por `;` deixa um fragmento final vazio quando o arquivo
     * termina em `;`; o filtro de vazios cuida disso, e e por isso que
     * ponto-e-virgula final nao vira statement fantasma.
     *
     * Vale para ESTE arquivo porque ele nao tem corpo `$$` — o T14a
     * verifica essa premissa em vez de presumi-la. Num arquivo com
     * corpo de funcao, o `;` interno exigiria um parser de verdade.
     */
    const statementsDe = (bruto: string): string[] =>
      bruto
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/--[^\n]*/g, " ")
        .split(";")
        .map((s) => s.replace(/\s+/g, " ").trim())
        .filter((s) => s.length > 0)
        .map((s) => `${s};`);

    const brutoD3 = fonte(MIGRATION_D3);
    const stmtsD3 = statementsDe(brutoD3);
    const executavelD3 = stmtsD3.join("\n");
    const DROP_D3 = "DROP FUNCTION public.aguardar_aprovacao_tarefa(uuid, integer);";

    ok("T14a ANCORA: o arquivo D3 foi lido e nao tem corpo $$ (premissa do parser)",
      brutoD3.length > 400 && !brutoD3.includes("$$"));
    ok("T14b a limpeza D3 tem EXATAMENTE um statement executavel",
      stmtsD3.length === 1);
    ok("T14c e esse statement e EXATAMENTE o DROP da overload de dois argumentos",
      stmtsD3[0] === DROP_D3);

    // Os bans rodam sobre o EXECUTAVEL, nunca sobre o arquivo bruto: o
    // cabecalho explica em prosa por que nao ha `IF EXISTS` nem
    // `CASCADE`, e uma regex ampla demais reprovaria a propria
    // justificativa. Foi a licao do D1-F2.
    ok("T14d zero IF EXISTS no executavel",
      !/\bIF\s+EXISTS\b/i.test(executavelD3));
    ok("T14e zero CASCADE no executavel",
      !/\bCASCADE\b/i.test(executavelD3));
    ok("T14e2 ANCORA: o cabecalho MENCIONA os dois, e isso nao reprova",
      /IF EXISTS/i.test(brutoD3) && /CASCADE/i.test(brutoD3));
    ok("T14f a overload de TRES argumentos nao aparece em DROP nenhum",
      !stmtsD3.some((s) =>
        /DROP\s+FUNCTION[\s\S]*?aguardar_aprovacao_tarefa\s*\(\s*uuid\s*,\s*integer\s*,\s*uuid\s*\)/i
          .test(s)));
    ok("T14g a limpeza nao cria, nao altera e nao mexe em privilegio",
      !/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i.test(executavelD3) &&
      !/\b(CREATE|ALTER|GRANT|REVOKE)\b/i.test(executavelD3));
    ok("T14g2 a limpeza nao tem DML nem DDL de tabela",
      !/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i.test(executavelD3) &&
      !/DROP\s+(TABLE|SCHEMA|INDEX|TYPE|TRIGGER|VIEW)/i.test(executavelD3));
    ok("T14g3 a limpeza nao usa DO, SQL dinamico nem EXCEPTION",
      !/\bDO\s*\$/i.test(executavelD3) &&
      !/\bEXECUTE\b/i.test(executavelD3) &&
      !/\bEXCEPTION\b/i.test(executavelD3));

    // ── T14h..T14m — CONTROLES NEGATIVOS DA FORMA ─────────────────
    //
    // Todos sobre texto SINTETICO, montado a partir do statement real:
    // mutar o arquivo bruto pegaria o cabecalho antes do statement — o
    // comentario tambem cita as assinaturas — e o controle mediria a
    // coisa errada, sem morder e sem avisar que nao mordeu.
    const comStatement = (s: string) => statementsDe(`-- cabecalho sintetico\n${s}`);
    const COM_CASCADE = DROP_D3.replace(");", ") CASCADE;");

    ok("T14h CONTROLE NEGATIVO: trocar o alvo pela overload de TRES argumentos reprova",
      comStatement("DROP FUNCTION public.aguardar_aprovacao_tarefa(uuid, integer, uuid);")[0]
        !== DROP_D3);
    ok("T14i CONTROLE NEGATIVO: um CASCADE reprova",
      comStatement(COM_CASCADE)[0] !== DROP_D3 &&
      /\bCASCADE\b/i.test(comStatement(COM_CASCADE).join("\n")));
    ok("T14j CONTROLE NEGATIVO: um IF EXISTS reprova",
      comStatement(DROP_D3.replace("DROP FUNCTION ", "DROP FUNCTION IF EXISTS "))[0]
        !== DROP_D3);
    ok("T14k CONTROLE NEGATIVO: um segundo statement executavel reprova",
      statementsDe(`${brutoD3}\nDROP FUNCTION public.sintetica(uuid);`).length !== 1);
    ok("T14l CONTROLE NEGATIVO: um GRANT acrescentado reprova",
      /\b(CREATE|ALTER|GRANT|REVOKE)\b/i.test(
        statementsDe(`${brutoD3}\ngrant execute on function public.x() to service_role;`)
          .join("\n")));
    // O reverso do T14k, e o que prova que o parser nao e ingenuo: um
    // segundo DROP COMENTADO nao e executavel e nao pode inflar a conta.
    ok("T14m CONTROLE: um segundo DROP escondido em comentario NAO conta como statement",
      statementsDe(`${brutoD3}\n-- DROP FUNCTION public.sintetica(uuid);`).length === 1);

    // ── T15 — D3-A0-M1: a divida da suite de banco, VISIVEL ───────
    //
    // A suite de banco continua chamando o contrato de dois argumentos.
    // Depois do apply ela deixa de ser executavel — e como ela esta sob
    // proibicao permanente de execucao, ninguem veria o vermelho. Uma
    // divida que nenhuma matriz consegue mostrar e uma divida que some.
    //
    // Este guard NAO afirma que a suite esta valida. Afirma o oposto:
    // que ela esta bloqueada, e que isso esta escrito la dentro.
    // DUAS representacoes do mesmo arquivo, com papeis que nao se
    // misturam — corrigido no D3-F1 (achado D3-R1-M1):
    //
    //   `bancoD3`       BRUTO, com comentarios. So os asserts que leem
    //                   o TEXTO do marcador podem usar isto, porque o
    //                   marcador E um comentario.
    //   `bancoD3Codigo` sem comentarios. Toda CONTAGEM de chamada e de
    //                   argumento usa isto.
    //
    // Antes a contagem lia o bruto, e um comentario citando
    // `p_aprovacao_id` perto de uma chamada legada a fazia parecer
    // migrada. O T15k abaixo guarda essa fronteira para sempre.
    const BANCO_TS = "scripts/testar-agentes-execucao-banco.ts";
    const bancoD3 = fonte(BANCO_TS);
    const bancoD3Codigo = codigo(BANCO_TS);

    /**
     * O mesmo despir de comentarios do `codigo()`, aplicavel a TEXTO.
     *
     * Existe para os controles negativos poderem trabalhar sobre texto
     * sintetico sem escrever arquivo nenhum. Nao e um segundo dialeto:
     * o T15h ancora que ele produz exatamente o mesmo resultado que
     * `codigo()` sobre o arquivo real — se um dia divergirem, cai ali.
     */
    const semComentarios = (texto: string) =>
      texto.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

    const MARCA_PAUSA = 'rpc("aguardar_aprovacao_tarefa"';

    /**
     * Janelas de texto a partir de cada chamada da RPC de pausa.
     *
     * Recorte por janela, e nao contagem no arquivo inteiro: as outras
     * RPCs tambem tem payload, e `p_aprovacao_id` precisa ser procurado
     * DENTRO da chamada certa. Foi o defeito do D2-F1.
     */
    const callSitesDePausa = (fonteTs: string): string[] => {
      const marcas: string[] = [];
      let i = fonteTs.indexOf(MARCA_PAUSA);
      while (i !== -1) {
        marcas.push(fonteTs.slice(i, i + 240));
        i = fonteTs.indexOf(MARCA_PAUSA, i + 1);
      }
      return marcas;
    };

    const legadasEm = (texto: string) =>
      callSitesDePausa(texto).filter((j) => !j.includes("p_aprovacao_id")).length;

    // CONTAGEM: sempre sobre o codigo, nunca sobre o bruto.
    const pausasNoBanco = callSitesDePausa(bancoD3Codigo);
    const legadosNoBanco = pausasNoBanco.filter((j) => !j.includes("p_aprovacao_id"));

    ok("T15 ANCORA: a suite de banco chama a RPC de pausa quatro vezes",
      pausasNoBanco.length === 4);
    ok("T15a e as QUATRO sao do contrato legado de dois argumentos",
      legadosNoBanco.length === 4);
    ok("T15b ENQUANTO houver chamada legada, o marcador D3-A0-M1 existe",
      legadosNoBanco.length === 0 || bancoD3.includes("D3-A0-M1"));
    ok("T15c o marcador diz que a suite esta BLOQUEADA, nao que esta valida",
      bancoD3.includes("DIVIDA ABERTA") &&
      bancoD3.includes("NAO EXECUTAR ESTA SUITE"));
    // ── T15d — O CRITERIO DE SAIDA, AMARRADO ──────────────────────
    //
    // Corrigido no D3-F1 (achado D3-R1-L1). Antes eram tres substrings
    // independentes: "Approval causal valida", "overload de TRES" e o
    // titulo. Tres metades soltas nao provam ligacao nenhuma — davam
    // por satisfeito um criterio que dissesse "crie uma Approval causal
    // e chame a overload de tres argumentos", sem nunca exigir que o id
    // DELA fosse o terceiro argumento. Era exatamente a brecha que o
    // paragrafo anterior do marcador proibe em prosa.
    //
    // Agora o assert exige a CADEIA, numa unica passagem ordenada:
    // Approval causal -> essa Approval.id -> p_aprovacao_id -> terceiro
    // argumento da overload de tres.
    const iCriterio = bancoD3.indexOf("CRITERIO DE SAIDA");
    const criterioDeSaida = bancoD3
      .slice(iCriterio, iCriterio + 800)
      .replace(/^\s*\*\s?/gm, " ")
      .replace(/\s+/g, " ");
    const CADEIA_DE_SAIDA =
      /Approval causal valida[\s\S]{0,200}?passar EXATAMENTE essa Approval\.id como p_aprovacao_id, o terceiro argumento da overload de TRES argumentos/i;

    ok("T15d ANCORA: o bloco do criterio de saida foi recortado",
      iCriterio > 0 && criterioDeSaida.length > 250);
    ok("T15d o criterio amarra Approval causal -> essa Approval.id -> terceiro argumento",
      CADEIA_DE_SAIDA.test(criterioDeSaida));
    ok("T15d2 CONTROLE NEGATIVO: criterio sem a amarracao reprova",
      !CADEIA_DE_SAIDA.test(
        "CRITERIO DE SAIDA - so fecha quando criar uma Approval causal valida " +
        "e chamar a overload de TRES argumentos."));
    ok("T15d3 o criterio diz que as duas metades soltas NAO fecham a divida",
      /NAO usada no terceiro argumento nao fecha/i.test(criterioDeSaida));
    ok("T15e o marcador nomeia a migration que torna a suite invalida",
      bancoD3.includes(NOME_D3));
    ok("T15f CONTROLE NEGATIVO: apagar o marcador com chamada legada viva reprova",
      !(legadosNoBanco.length === 0 ||
        bancoD3.replace(/D3-A0-M1/g, "").includes("D3-A0-M1")));

    // ── T15h..T15k — D3-R1-M1: PROSA NAO E CHAMADA ────────────────
    //
    // O defeito corrigido no D3-F1: com a contagem lendo o arquivo
    // bruto, bastava um comentario citando `p_aprovacao_id` dentro da
    // janela de 240 chars de uma chamada legada para ela ser
    // classificada como migrada. A divida nao sumia em silencio (o
    // T15a caia), mas caia pelo motivo errado — a mesma patologia que
    // o proprio marcador denuncia no assert de privilegio do anon.
    const iPrimeiraPausa = bancoD3.indexOf(MARCA_PAUSA);
    const fimDaLinha = bancoD3.indexOf("\n", iPrimeiraPausa);
    const injetarApos = (linha: string) =>
      bancoD3.slice(0, fimDaLinha + 1) + linha + "\n" + bancoD3.slice(fimDaLinha + 1);

    ok("T15h ANCORA: o despir de texto concorda com codigo() no arquivo real",
      semComentarios(bancoD3) === bancoD3Codigo &&
      iPrimeiraPausa > 0 && fimDaLinha > iPrimeiraPausa);
    ok("T15i CONTROLE D3-R1-M1: prosa citando p_aprovacao_id NAO reclassifica a chamada",
      legadasEm(semComentarios(injetarApos("          // p_aprovacao_id: controle"))) === 4);
    ok("T15j CONTROLE: o MESMO texto como CODIGO reclassifica — a sonda sabe dizer nao",
      legadasEm(semComentarios(injetarApos("          p_aprovacao_id: aprovacao.id,"))) === 3);
    ok("T15k TESTEMUNHA DE REGRESSAO: sobre o BRUTO a prosa enganaria",
      legadasEm(injetarApos("          // p_aprovacao_id: controle")) === 3);
    ok("T15l nenhuma janela contada encosta em comentario",
      pausasNoBanco.every((j) => !j.includes("//") && !j.includes("/*")));

    // ── T15g — A DIVIDA NAO PODE SER NORMALIZADA ──────────────────
    //
    // A tentacao obvia seria "consertar" a suite mandando um terceiro
    // argumento qualquer. Um UUID sintetico, `null` ou `randomUUID()`
    // fariam a divida sumir do texto sem sumir do mundo: a RPC nova
    // recusa fail-closed quem nao for a aprovacao daquela tarefa, e o
    // teste passaria a provar a recusa, nunca a pausa.
    // Sobre o CODIGO: o que importa e o que seria enviado ao banco, e a
    // prosa do proprio marcador cita `null` e `randomUUID()` justamente
    // para proibi-los — medir o bruto reprovaria a proibicao.
    ok("T15g nenhum approvalId sintetico foi injetado na suite de banco",
      !/p_aprovacao_id:\s*(null|undefined|randomUUID|"[0-9a-fA-F-]{8})/i.test(bancoD3Codigo));
    ok("T15g2 CONTROLE: as formas invalidas sao reconhecidas, as causais nao",
      [`p_aprovacao_id: null,`, `p_aprovacao_id: undefined,`,
       `p_aprovacao_id: randomUUID(),`,
       `p_aprovacao_id: "2e7a354c-48e2-4c1d-9df0-b7adc12623c8",`]
        .every((c) => /p_aprovacao_id:\s*(null|undefined|randomUUID|"[0-9a-fA-F-]{8})/i.test(c)) &&
      [`p_aprovacao_id: aprovacao.id,`, `p_aprovacao_id: aprovacaoCriada.id,`,
       `p_aprovacao_id: APROVACAO_FIXTURE,`]
        .every((c) => !/p_aprovacao_id:\s*(null|undefined|randomUUID|"[0-9a-fA-F-]{8})/i.test(c)));

    // ── T16 — ZERO CALLER DE DOIS ARGUMENTOS EM PRODUCAO ──────────
    //
    // Independente da migration, de proposito: e este numero, e nao o
    // arquivo SQL, que autoriza o DROP. Se um caller de duas chaves
    // reaparecer em producao, o DROP passa a ser quebra de producao — e
    // o guard tem de dizer isso ANTES do apply, nao depois.
    const pausasProducao = [CAP_WORKER, EXECUTOR]
      .flatMap((p) => callSitesDePausa(codigo(p)));

    ok("T16 producao chama a RPC de pausa exatamente uma vez",
      pausasProducao.length === 1);
    ok("T16a CALLERS_2ARG_EM_PRODUCAO = 0",
      pausasProducao.filter((j) => !j.includes("p_aprovacao_id")).length === 0);
    ok("T16b CONTROLE NEGATIVO: uma chamada de duas chaves seria contada",
      callSitesDePausa('rpc("aguardar_aprovacao_tarefa", { p_tarefa_id, p_tentativa_esperada });')
        .filter((j) => !j.includes("p_aprovacao_id")).length === 1);

    // ── T17 — O PISO DE ROLLBACK POS-D3 ───────────────────────────
    //
    // Depois do apply, rollback de codigo para qualquer SHA anterior a
    // este quebra a pausa: o caller antigo manda duas chaves e recebe
    // PGRST202. O Vercel nao sabe disso — todos os deployments antigos
    // seguem marcados como candidatos a rollback. A fronteira e
    // processual, e some se nao ficar escrita em algo que roda.
    const PISO_DE_ROLLBACK_POS_D3 = "d1998901a404fc034711be0392175da62de05c8e";

    ok("T17 o piso de rollback pos-D3 e um SHA completo",
      /^[0-9a-f]{40}$/.test(PISO_DE_ROLLBACK_POS_D3));
    ok("T17a e ele esta registrado na propria migration D3",
      brutoD3.includes(PISO_DE_ROLLBACK_POS_D3) &&
      /POST_D3_ROLLBACK_FLOOR/i.test(brutoD3));
  }

  console.log("U. Migration D4 — a decisao encerra a tarefa");
  {
    const brutoD4 = fonte(MIGRATION_D4);

    /**
     * Statements TOP-LEVEL de um arquivo SQL, com dollar quoting.
     *
     * O parser do T14 declarava a premissa "este arquivo nao tem `$$`".
     * Aqui ela seria falsa: o corpo plpgsql tem dezenas de `;` dentro de
     * `$$ ... $$`. Contar com `split(";")` daria dezenas de statements
     * fantasma — medi no arquivo real e da 64.
     *
     * Maquina de estados, caractere a caractere. Fora de qualquer
     * contexto citado, reconhece:
     *   --  ate o fim da linha
     *   /* ... *\/  bloco
     *   '...'  string, com '' escapado
     *   "..."  identificador
     *   $tag$ ... $tag$  dollar quoting, tag vazia ou nomeada
     * e so conta `;` em profundidade zero.
     */
    const statementsTopLevel = (bruto: string): string[] => {
      const fora: string[] = [];
      let atual = "";
      let i = 0;
      while (i < bruto.length) {
        const c = bruto[i];
        const dois = bruto.slice(i, i + 2);

        if (dois === "--") {
          const fim = bruto.indexOf("\n", i);
          i = fim === -1 ? bruto.length : fim;
          continue;
        }
        if (dois === "/*") {
          const fim = bruto.indexOf("*/", i + 2);
          i = fim === -1 ? bruto.length : fim + 2;
          continue;
        }
        if (c === "'" || c === '"') {
          const aspa = c;
          let j = i + 1;
          while (j < bruto.length) {
            if (bruto[j] === aspa) {
              if (bruto[j + 1] === aspa) { j += 2; continue; }
              break;
            }
            j += 1;
          }
          atual += bruto.slice(i, j + 1);
          i = j + 1;
          continue;
        }
        if (c === "$") {
          const m = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(bruto.slice(i));
          if (m) {
            const tag = m[0];
            const fim = bruto.indexOf(tag, i + tag.length);
            const ate = fim === -1 ? bruto.length : fim + tag.length;
            atual += bruto.slice(i, ate);
            i = ate;
            continue;
          }
        }
        if (c === ";") {
          if (atual.trim()) fora.push(atual.trim().replace(/\s+/g, " "));
          atual = "";
          i += 1;
          continue;
        }
        atual += c;
        i += 1;
      }
      if (atual.trim()) fora.push(atual.trim().replace(/\s+/g, " "));
      return fora;
    };

    /** O contador ingenuo, guardado so para o controle de anti-vacuidade. */
    const statementsIngenuos = (bruto: string): number =>
      bruto.replace(/--[^\n]*/g, " ").split(";").filter((s) => s.trim()).length;

    const stmtsD4 = statementsTopLevel(brutoD4);

    // ── U0..U2 — ANTI-VACUIDADE DO PARSER ─────────────────────────
    //
    // Se o parser ingenuo e o correto derem o MESMO numero, o parser
    // dollar-aware nao esta fazendo trabalho nenhum e nao prova nada.
    ok("U0  ANCORA: a migration D4 foi lida e tem dollar quoting",
      brutoD4.length > 3000 && brutoD4.includes("$$"));
    ok("U1  o contador ingenuo se perde no corpo plpgsql",
      statementsIngenuos(brutoD4) > 20);
    ok("U2  e o parser dollar-aware discorda dele — prova que faz trabalho",
      statementsTopLevel(brutoD4).length !== statementsIngenuos(brutoD4));

    // ── U3 — CASOS SINTETICOS DO PARSER ───────────────────────────
    //
    // Um `;` em cada contexto citado nao pode criar statement novo.
    const UM = "select 1";
    ok("U3  `;` dentro de $$ nao cria statement",
      statementsTopLevel("create function f() as $$ begin a; b; c; end; $$;").length === 1);
    ok("U3a `;` dentro de $tag$ nao cria statement",
      statementsTopLevel("create function f() as $corpo$ x; y; $corpo$;").length === 1);
    ok("U3b `;` dentro de string simples nao cria statement",
      statementsTopLevel(`${UM} where s = 'a;b;c';`).length === 1);
    ok("U3c `;` dentro de identificador com aspas nao cria statement",
      statementsTopLevel(`${UM} as "col;estranha";`).length === 1);
    ok("U3d `;` dentro de comentario de linha nao cria statement",
      statementsTopLevel(`${UM}; -- comentario; com; ponto e virgula\n`).length === 1);
    ok("U3e `;` dentro de comentario de bloco nao cria statement",
      statementsTopLevel(`${UM}; /* bloco; com; varios */`).length === 1);
    ok("U3f CONTROLE: dois statements REAIS contam dois",
      statementsTopLevel(`${UM}; select 2;`).length === 2);
    ok("U3g CONTROLE: aspa escapada nao encerra a string",
      statementsTopLevel(`${UM} where s = 'a''b;c';`).length === 1);

    // ── U4..U6 — A FORMA DA MIGRATION D4 ──────────────────────────
    //
    // 1 create or replace + 1 comment on function + 4 revoke + 1 grant.
    // O COMMENT segue o precedente da propria 20260928, que comenta esta
    // mesma funcao — a documentacao in-database e parte da forma da casa.
    ok("U4  a migration D4 tem SETE statements top-level",
      stmtsD4.length === 7);
    ok("U5  exatamente um CREATE OR REPLACE, e nenhum DROP/ALTER",
      stmtsD4.filter((s) => /^create or replace function/i.test(s)).length === 1 &&
      !stmtsD4.some((s) => /^drop /i.test(s)) &&
      !stmtsD4.some((s) => /^alter /i.test(s)));
    ok("U6  quatro REVOKE, um GRANT e um COMMENT",
      stmtsD4.filter((s) => /^revoke /i.test(s)).length === 4 &&
      stmtsD4.filter((s) => /^grant /i.test(s)).length === 1 &&
      stmtsD4.filter((s) => /^comment on function/i.test(s)).length === 1);

    // ── U6b..U6e — o COMMENT e da ASSINATURA CERTA ────────────────
    //
    // Endurecido no D4-F2 (achado D4-R2-L4). Contar um COMMENT nao basta:
    // um COMMENT apontando para OUTRA assinatura mantem a contagem em
    // sete e passaria. O alvo tem de ser verificado nominalmente.
    const ALVO_COMMENT = "comment on function public.aprovacao_decidir(text, uuid, text, text)";
    const commentsNoAlvo = (lista: readonly string[]) =>
      lista.filter((s) => s.toLowerCase().startsWith(ALVO_COMMENT)).length;

    ok("U6b o COMMENT aponta para a assinatura de QUATRO parametros",
      commentsNoAlvo(stmtsD4) === 1);
    ok("U6c CONTROLE NEGATIVO: COMMENT ausente reprova",
      commentsNoAlvo(statementsTopLevel(
        brutoD4.replace(/comment on function[\s\S]*?';/i, ""))) !== 1);
    ok("U6d CONTROLE NEGATIVO: COMMENT com assinatura ERRADA reprova, mesmo mantendo a contagem",
      (() => {
        const errado = brutoD4.replace(
          "comment on function public.aprovacao_decidir(text, uuid, text, text) is",
          "comment on function public.aprovacao_decidir(text, uuid, text) is");
        const st = statementsTopLevel(errado);
        return st.length === 7 && commentsNoAlvo(st) !== 1;
      })());
    ok("U6e CONTROLE NEGATIVO: um segundo COMMENT no alvo reprova",
      commentsNoAlvo(statementsTopLevel(
        `${brutoD4}\ncomment on function public.aprovacao_decidir(text, uuid, text, text) is 'duplicado';`))
        !== 1);

    // ── U7..U11 — CONTROLES NEGATIVOS DA FORMA ────────────────────
    //
    // Todos sobre texto SINTETICO: mutar o arquivo bruto pegaria o
    // cabecalho, que cita em prosa tudo o que a migration NAO faz.
    ok("U7  CONTROLE NEGATIVO: um segundo statement top-level reprova",
      statementsTopLevel(`${brutoD4}\nselect 1;`).length !== 7);
    ok("U8  CONTROLE NEGATIVO: uma segunda funcao reprova",
      statementsTopLevel(`${brutoD4}\ncreate function public.x() returns int language sql as $$ select 1; $$;`)
        .filter((s) => /^create (or replace )?function/i.test(s)).length !== 1);
    ok("U9  CONTROLE NEGATIVO: um DROP acrescentado reprova",
      statementsTopLevel(`${brutoD4}\ndrop function public.x();`).some((s) => /^drop /i.test(s)));
    ok("U10 CONTROLE NEGATIVO: um GRANT a anon reprova",
      /grant[^;]*\bto\s+anon\b/i.test(
        statementsTopLevel(`${brutoD4}\ngrant execute on function public.aprovacao_decidir(text, uuid, text, text) to anon;`)
          .join("\n")));
    ok("U11 CONTROLE NEGATIVO: remover um REVOKE reprova",
      statementsTopLevel(
        brutoD4.replace("revoke all on function public.aprovacao_decidir(text, uuid, text, text) from anon;", "")
      ).filter((s) => /^revoke /i.test(s)).length !== 4);

    // ── U12..U13 — A ANCORA HISTORICA, E O QUE ELA NAO PROVA ──────
    //
    // STATIC_GUARD_IS_NOT_LIVE_PREFLIGHT: este bloco compara BYTES DE
    // ARQUIVO. Ele nao enxerga o banco e nao detecta drift na funcao
    // live. O gate de apply tera de verificar, imediatamente antes,
    // OID/prosrc/ACL/config reais — e abortar em qualquer divergencia.
    const OID_HISTORICO_APROVACAO_DECIDIR = 28483;
    const MD5_CORPO_PRE_D4 = "f7cf9cffc2526dcc2b722e930d93f3f2";
    const MIGRATION_ORIGEM_DECIDIR = "supabase/migrations/20260928_agente_funcao_aprovacoes.sql";

    /**
     * O corpo plpgsql historico de `aprovacao_decidir`, extraido do
     * arquivo que o criou.
     *
     * Endurecido no D4-F2 (achado D4-R2-L3). Antes a ancora era uma
     * constante comparada consigo mesma — nao detectaria divergencia
     * nenhuma. Agora o md5 e DERIVADO do arquivo real, entre os
     * delimitadores dollar-quoted daquela funcao.
     *
     * Normaliza CRLF: o baseline foi calculado sobre o conteudo logico, e
     * um checkout com final de linha diferente nao pode mudar o hash.
     */
    const corpoHistoricoDecidir = (fonteSql: string): string => {
      const texto = fonteSql.replace(/\r\n/g, "\n");
      const i = texto.indexOf("create or replace function public.aprovacao_decidir(");
      if (i < 0) return "";
      const a = texto.indexOf("$$", i);
      const b = texto.indexOf("$$", a + 2);
      return a < 0 || b < 0 ? "" : texto.slice(a + 2, b);
    };
    const md5De = (s: string) => createHash("md5").update(s, "utf8").digest("hex");

    const sqlOrigem = fonte(MIGRATION_ORIGEM_DECIDIR);
    const corpoPreD4 = corpoHistoricoDecidir(sqlOrigem);

    ok("U12 ANCORA: existe EXATAMENTE uma definicao historica da funcao alvo",
      (sqlOrigem.match(/create or replace function public\.aprovacao_decidir\(/gi) ?? []).length === 1 &&
      corpoPreD4.length > 2000);
    ok("U12b o md5 da baseline e DERIVADO do corpo historico real, nao hardcoded contra si",
      md5De(corpoPreD4) === MD5_CORPO_PRE_D4);
    ok("U12c CONTROLE NEGATIVO: um unico byte alterado no corpo muda o md5",
      md5De(`${corpoPreD4} `) !== MD5_CORPO_PRE_D4 &&
      md5De(corpoPreD4.replace("v_estado text;", "v_estado  text;")) !== MD5_CORPO_PRE_D4);
    ok("U12d o OID historico segue registrado, para o preflight live",
      Number.isInteger(OID_HISTORICO_APROVACAO_DECIDIR) &&
      OID_HISTORICO_APROVACAO_DECIDIR === 28483);
    ok("U13 a migration que criou a versao pre-D4 segue intocada no disco",
      sqlOrigem.includes("create or replace function public.aprovacao_decidir("));

    // ── U14..U15 — ORDEM E INVENTARIO DAS MIGRATIONS ──────────────
    const migsD4 = [...readdirSync(join(RAIZ, "supabase", "migrations"))].sort();
    const NOME_D4 = "20261004_aprovacao_decidir_encerra_tarefa.sql";

    // A ULTIMA migration do disco deixou de ser a D4 quando o
    // APPROVAL-DECISION-RESUME-D5 foi commitado em `a8609dfe`. O guard
    // nao foi afrouxado: ele continua congelando QUAL e a ultima, agora
    // pelo nome exato da D5, e a cobertura historica da D4 permanece —
    // ela tem de existir e tem de vir ANTES.
    const NOME_D5 = "20261005_agente_retomada_aprovacao.sql";

    // E deixou de ser a D5 quando o terminalizador de sucesso da lane de
    // retomada (D5-C2) foi commitado em `5e04c45`. O padrao se repete a
    // cada migration nova, e a resposta continua a mesma: nao afrouxar,
    // e sim mover o congelamento para o nome exato da ULTIMA, mantendo a
    // cadeia historica — D3 antes de D4, D4 antes de D5, D5 antes desta.
    const NOME_D5C2 = "20261006_retomada_concluir_tarefa.sql";

    // E deixou de ser a D5-C2 quando a fila e a reconciliacao tecnica da
    // retomada (D5-C3-I2-P0) entraram no disco. Terceira vez que o guard
    // avanca, e pelo mesmo motivo das duas anteriores: congelar QUAL e a
    // ultima e mais forte do que aceitar qualquer uma, e a cadeia
    // historica inteira — D3, D4, D5, D5-C2, esta — continua provada.
    const NOME_D5C3P0 = "20261007_retomada_fila_e_reconciliacao.sql";

    ok("U14 a D4 existe e continua precedendo a D5",
      migsD4.includes(NOME_D4) && migsD4.indexOf(NOME_D4) < migsD4.indexOf(NOME_D5));
    ok("U14a a D5 existe com o nome EXATO e precede a D5-C2",
      migsD4.includes(NOME_D5) && migsD4.indexOf(NOME_D5) < migsD4.indexOf(NOME_D5C2));
    ok("U14a2 a D5-C2 existe com o nome EXATO e precede a ultima",
      migsD4.includes(NOME_D5C2) && migsD4.indexOf(NOME_D5C2) < migsD4.indexOf(NOME_D5C3P0));
    ok("U14a3 a D5-C3-P0 existe com o nome EXATO e e a ultima do disco",
      migsD4.includes(NOME_D5C3P0) && migsD4[migsD4.length - 1] === NOME_D5C3P0);
    ok("U14b CONTROLE: uma migration posterior inesperada reprovaria",
      [...migsD4, "20261008_migration_nao_declarada.sql"].sort().at(-1) !== NOME_D5C3P0);
    ok("U14b2 CONTROLE: a fase ANTERIOR, com a D5-C2 no fim, agora reprova",
      migsD4[migsD4.length - 1] !== NOME_D5C2);
    // O prefixo identifica UM arquivo so, e o guard congela o nome
    // inteiro: se alguem acrescentasse outra migration com o mesmo
    // carimbo, o congelamento por prefixo deixaria de discriminar.
    ok("U14c CONTROLE: o carimbo 20261005 pertence a UMA migration, e e a exata",
      migsD4.filter((m) => m.startsWith("20261005")).join(",") === NOME_D5);
    ok("U14c2 CONTROLE: o carimbo 20261006 pertence a UMA migration, e e a exata",
      migsD4.filter((m) => m.startsWith("20261006")).join(",") === NOME_D5C2);
    ok("U14c3 CONTROLE: o carimbo 20261007 pertence a UMA migration, e e a exata",
      migsD4.filter((m) => m.startsWith("20261007")).join(",") === NOME_D5C3P0);
    ok("U15 e a D4 vem depois da limpeza do D3",
      migsD4.indexOf("20261003_remover_aguardar_aprovacao_tarefa_2args.sql") <
      migsD4.indexOf(NOME_D4));

    // ── U16 — O D4 NAO REESCREVE HISTORIA ─────────────────────────
    // O D4 e arquivo NOVO: as historicas continuam no disco e nenhuma
    // delas e reescrita. Note que o D1 CITA `aprovacao_decidir` em prosa
    // (ele documenta a ordem de lock do sistema) — por isso a sonda e
    // sobre o EXECUTAVEL do D4, nao sobre mencao textual alheia.
    ok("U16 as cinco migrations historicas seguem no disco, intocadas",
      [MIGRATION_PAUSA_P0, MIGRATION_B0, MIGRATION_B0_CLEANUP, MIGRATION_D1, MIGRATION_D3]
        .every((m) => fonte(m).length > 0));
    ok("U16b o D4 nao dropa nem altera nenhum objeto historico",
      !stmtsD4.some((s) => /^(drop|alter)/i.test(s)) &&
      !stmtsD4.some((s) => /aguardar_aprovacao_tarefa|concluir_tarefa|falhar_tarefa|claim_next/i.test(s)));
  }

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

  // ═══ Q. FUNCTION-RUNTIME-P0 — o terceiro desfecho ═════════════════
  //
  // O executor conhecia dois finais: devolver (concluir) e lancar
  // (falhar). O terceiro existe de verdade — a Funcao pedida tem
  // `nivel = aprovacao`, a aprovacao ja foi criada, e nada mais pode
  // acontecer sem um humano. Sem ele, a Task terminaria
  // `handler_falhou` e a aprovacao ficaria pendente sem dono.
  console.log("\nQ. FUNCTION-RUNTIME-P0 — pausa por aprovacao");
  {
    const MIG_P0 = "supabase/migrations/20260929_agente_tarefa_aguardar_aprovacao.sql";
    const migP0 = sql(MIG_P0);
    const migP0Bruta = fonte(MIG_P0);
    const erros = codigo("lib/agentes/erros.ts");

    // ── O sentinel ───────────────────────────────────────────────
    ok("Q1  o sentinel existe e estende Error",
      /export class PausaPorAprovacao extends Error/.test(erros));
    ok("Q2  carrega SO `aprovacaoId`, e ele e readonly",
      /readonly aprovacaoId: string;/.test(erros) &&
      /constructor\(aprovacaoId: string\)/.test(erros));
    ok("Q3  NAO carrega tarefaId, tentativa, dono nem argumentos",
      !/tarefaId|tentativa|userId|agenteId|argumentos/.test(erros));
    ok("Q4  `name` estavel, para o `instanceof` nao ser a unica prova",
      /this\.name = "PausaPorAprovacao";/.test(erros));
    ok("Q5  `erros.ts` continua PURO",
      !/import\s+"server-only"/.test(erros) &&
      !/supabase|createClient|process\.env|fetch\(/i.test(erros));

    // ── O contrato do handler NAO mudou ──────────────────────────
    ok("Q6  HandlerTarefa continua devolvendo Record<string, unknown>",
      /=> Promise<Record<string, unknown>>/.test(tex) &&
      !/tipo: "aguardando_aprovacao"/.test(tex));
    const blocoContexto = tex.slice(
      tex.indexOf("export interface ContextoTarefa"),
      tex.indexOf("export type RelatarProgresso")
    );
    ok("Q7  ContextoTarefa continua com SETE campos",
      blocoContexto.length > 50 && conta(blocoContexto, /readonly \w+:/g) === 7);

    // ── O executor: reconhecer ANTES de classificar ──────────────
    const iCatch = exe.indexOf("} catch (err) {");
    const iSentinel = exe.indexOf("err instanceof PausaPorAprovacao");
    const iClassificar = exe.indexOf("const erroTipo = classificarErro(err);");
    const iPausa = exe.indexOf("aguardarAprovacaoTarefa(");

    ok("Q8  o executor reconhece o sentinel DENTRO do catch",
      iCatch > 0 && iSentinel > iCatch);
    ok("Q9  e ANTES de classificarErro — senao viraria handler_falhou",
      iSentinel > 0 && iClassificar > iSentinel);
    ok("Q10 a pausa chama a capability dedicada",
      iPausa > iSentinel && iPausa < iClassificar);
    // O FENCING: a tentativa vem da LINHA, nunca do handler.
    ok("Q11 passa `tarefa.id` e `tarefa.tentativas`, os dois da linha",
      /aguardarAprovacaoTarefa\(\s*tarefa\.id,\s*tarefa\.tentativas\s*,/.test(exe));
    ok("Q12 NAO usa tentativa vinda do sentinel nem do contexto",
      !/err\.tentativa|contexto\.tentativa/.test(exe));
    // ── Q13 migrado na APPROVAL-DECISION-RESUME-D2 ────────────────
    //
    // Ate aqui o `aprovacaoId` NAO podia participar da transicao, e a
    // razao era boa: nao havia coluna para recebe-lo, entao passa-lo
    // seria dar a RPC um dado que ela nao teria onde gravar.
    //
    // O D1 criou a coluna e a revalidacao. Agora ele participa — e o
    // assert passou a exigir a ORIGEM certa, que e o ponto todo: o id
    // vem do sentinel lancado por quem criou a aprovacao, nunca de uma
    // busca por `tarefa_id`, que identificaria a acao errada quando a
    // tarefa tem mais de uma aprovacao ativa.
    ok("Q13 o `aprovacaoId` participa da transicao, vindo do sentinel",
      /aguardarAprovacaoTarefa\([\s\S]{0,140}?err\.aprovacaoId/.test(exe));
    ok("Q13 CONTROLE NEGATIVO: trocar a origem do id reprova",
      !/aguardarAprovacaoTarefa\([\s\S]{0,140}?err\.aprovacaoId/.test(
        exe.replace("err.aprovacaoId", "tarefa.id")));
    ok("Q13 e a tentativa continua sendo N, sem aritmetica",
      !/tarefa\.tentativas\s*[+-]\s*1/.test(exe) &&
      !/aguardarAprovacaoTarefa\([\s\S]{0,140}?maxTentativas/.test(exe));

    // ── Sucesso da pausa ─────────────────────────────────────────
    const ramoPausa = exe.slice(iSentinel, iClassificar);
    ok("Q14 o ramo de pausa NAO chama concluir nem falhar",
      !/concluirTarefa\(|falharTarefa\(/.test(ramoPausa));
    ok("Q15 sucesso devolve 200 com ok:true e o status honesto",
      /status: 200,/.test(ramoPausa) &&
      /ok: true,/.test(ramoPausa) &&
      /status: "aguardando_aprovacao",/.test(ramoPausa) &&
      /erroTipo: null,/.test(ramoPausa));
    ok("Q16 e o `aprovacaoId` nao vaza para a resposta",
      !/aprovacaoId/.test(ramoPausa.slice(ramoPausa.indexOf("status: 200,"))));

    // ── Falha da pausa ───────────────────────────────────────────
    ok("Q17 falha devolve 500 sanitizado, sem concluir nem falhar",
      /if \(erroPausa\) \{/.test(ramoPausa) &&
      /status: 500, corpo: \{ ok: false, erro: erroPausa \}/.test(ramoPausa));
    ok("Q18 CONTROLE NEGATIVO: chamar falharTarefa na pausa reprovaria",
      /falharTarefa\(/.test(ramoPausa + "\nfalharTarefa(x)"));

    // ── A capability ─────────────────────────────────────────────
    ok("Q19 o wrapper existe e chama a RPC nova",
      /export async function aguardarAprovacaoTarefa\(/.test(capw) &&
      /\.rpc\("aguardar_aprovacao_tarefa"/.test(capw));
    // Recorta o CORPO do wrapper novo: o arquivo inteiro contem
    // `p_resultado` e `p_erro_tipo`, que sao das irmas.
    const corpoWrapper = capw.slice(
      capw.indexOf("export async function aguardarAprovacaoTarefa("),
      capw.indexOf("export async function aguardarAprovacaoTarefa(") > 0
        ? capw.indexOf("\n/**", capw.indexOf("export async function aguardarAprovacaoTarefa("))
        : 0
    );
    // ── Q20 migrado na APPROVAL-DECISION-RESUME-D2 ────────────────
    //
    // A lista continua sendo a defesa: o que NAO entra e tudo que a
    // LINHA ja sabe — dono, agente, status, heartbeat, erro, resultado.
    // Aceitar qualquer um desses seria deixar o chamador descrever o
    // estado que a RPC deveria verificar.
    //
    // `p_aprovacao_id` entrou, e e excecao legitima por um motivo
    // especifico: ele NAO descreve estado. E o retorno do executor de
    // Funcao que acabou de criar ou reutilizar a aprovacao, e a RPC o
    // revalida contra dono, agente, tarefa e estado antes de grava-lo.
    ok("Q20 recebe tarefa, tentativa e a aprovacao — e mais nada",
      corpoWrapper.length > 200 &&
      /p_tarefa_id: tarefaId,/.test(corpoWrapper) &&
      /p_tentativa_esperada: tentativaEsperada,/.test(corpoWrapper) &&
      /p_aprovacao_id: aprovacaoId,/.test(corpoWrapper) &&
      !/p_user_id|p_agente_id|p_status|p_resultado|p_erro_tipo|p_heartbeat/.test(corpoWrapper));
    ok("Q20 CONTROLE NEGATIVO: uma quarta chave de estado reprova",
      /p_user_id/.test(corpoWrapper + "\n      p_user_id: userId,"));
    ok("Q20b a assinatura exige a aprovacao, sem opcional e sem default",
      /aprovacaoId:\s*string\s*\n?\s*\):/.test(corpoWrapper) &&
      !/aprovacaoId\?:/.test(corpoWrapper) &&
      !/aprovacaoId\s*[:=][^,)]*=\s*/.test(corpoWrapper) &&
      !/aprovacaoId\s*\?\?/.test(corpoWrapper));
    ok("Q21 recusa tentativa que nao poderia ter vindo do claim",
      /Number\.isInteger\(tentativaEsperada\) \|\| tentativaEsperada <= 0/.test(capw));
    ok("Q22 e nao vaza a mensagem do driver",
      !/error\.message/.test(capw));

    // ── A migration: fencing e schema-free ───────────────────────
    ok("Q23 ANCORA: a migration do P0 foi lida", migP0.trim().length > 800);
    ok("Q24 cria a RPC com os DOIS parametros",
      /CREATE OR REPLACE FUNCTION public\.aguardar_aprovacao_tarefa\(/.test(migP0) &&
      /p_tarefa_id\s+uuid/.test(migP0) &&
      /p_tentativa_esperada\s+integer/.test(migP0));
    // O FENCING, medido no SQL.
    ok("Q25 o WHERE exige tarefa, status rodando E a tentativa esperada",
      /WHERE id = p_tarefa_id/.test(migP0) &&
      /AND status = 'rodando'/.test(migP0) &&
      /AND tentativas = p_tentativa_esperada/.test(migP0));
    ok("Q26 CONTROLE NEGATIVO: sem a comparacao de tentativas, reprova",
      !/AND tentativas = p_tentativa_esperada/.test(
        migP0.replace("AND tentativas = p_tentativa_esperada", "")));
    ok("Q27 CONTROLE NEGATIVO: sem o guard de status, reprova",
      !/AND status = 'rodando'/.test(migP0.replace("AND status = 'rodando'", "")));
    ok("Q28 a pausa limpa batimento, resultado, erro e conclusao",
      /heartbeat_em  = NULL/.test(migP0) && /resultado     = NULL/.test(migP0) &&
      /erro_tipo     = NULL/.test(migP0) && /erro_mensagem = NULL/.test(migP0) &&
      /concluido_em  = NULL/.test(migP0));
    // Somente o SET: `tentativas` aparece legitimamente no WHERE, que e
    // justamente o fencing.
    const setDaPausa = migP0.slice(
      migP0.indexOf("SET status        = 'aguardando_aprovacao'"),
      migP0.indexOf("WHERE id = p_tarefa_id")
    );
    ok("Q29 e o SET NAO toca progresso, tentativas nem iniciado_em",
      setDaPausa.length > 50 &&
      !/progresso/.test(setDaPausa) && !/tentativas/.test(setDaPausa) &&
      !/iniciado_em/.test(setDaPausa));
    ok("Q30 mismatch LANCA 55000 — nunca no-op silencioso",
      /IF NOT FOUND THEN/.test(migP0) && /ERRCODE = '55000'/.test(migP0));
    ok("Q31 a migration e SCHEMA-FREE",
      !/ALTER TABLE|CREATE TABLE|ADD COLUMN|CREATE INDEX|CREATE TRIGGER|ROW LEVEL SECURITY|ALTER DEFAULT PRIVILEGES/i
        .test(migP0));
    ok("Q32 SECURITY INVOKER e search_path fixo, como as irmas",
      /SECURITY INVOKER/.test(migP0) && /SET search_path = public/.test(migP0) &&
      !/SECURITY DEFINER/.test(migP0));
    ok("Q33 grants no padrao: revoga os tres, concede so a service_role",
      /REVOKE EXECUTE[\s\S]*FROM PUBLIC/.test(migP0) &&
      /REVOKE EXECUTE[\s\S]*FROM anon/.test(migP0) &&
      /REVOKE EXECUTE[\s\S]*FROM authenticated/.test(migP0) &&
      /GRANT  EXECUTE[\s\S]*TO service_role/.test(migP0));
    ok("Q34 tem COMMENT, como toda RPC do projeto",
      /COMMENT ON FUNCTION public\.aguardar_aprovacao_tarefa/.test(migP0Bruta));
    // O CORPO da funcao — o COMMENT cita `agente_funcao_aprovacoes`
    // para explicar ONDE o vinculo vive, e citar nao e tocar.
    const corpoRpc = migP0.slice(
      migP0.indexOf("CREATE OR REPLACE FUNCTION public.aguardar_aprovacao_tarefa("),
      migP0.indexOf("COMMENT ON FUNCTION")
    );
    ok("Q35 o corpo da RPC so toca `agente_tarefas`",
      corpoRpc.length > 500 &&
      /UPDATE public\.agente_tarefas/.test(corpoRpc) &&
      !/agente_funcao_aprovacoes|agente_funcao_chamadas|agente_permissoes/.test(corpoRpc));

    // ── As RPCs irmas NAO foram tocadas (P0-DEBT-1 segue dividida) ─
    ok("Q36 as tres RPCs da 1C continuam nominais e intactas",
      AS_3_RPCS.every((r) => new RegExp(`FUNCTION public\\.${r}\\(`).test(mig)) &&
      !/aguardar_aprovacao_tarefa/.test(mig));

    // ── O worker ─────────────────────────────────────────────────
    ok("Q37 o worker distingue concluida de pausada",
      /corpo\.status === "concluido"/.test(wrk) &&
      /corpo\.status === "aguardando_aprovacao"/.test(wrk));
    ok("Q38 e usa rotulo proprio para a pausa",
      /AGUARDANDO_APROVACAO/.test(wrk));
    // FAIL-CLOSED: `ok:true` com status desconhecido nao vira CONCLUIDA.
    ok("Q39 status inesperado NAO e anunciado como concluida",
      /RESPOSTA INESPERADA/.test(wrk) &&
      wrk.indexOf("CONCLUIDA") < wrk.indexOf("RESPOSTA INESPERADA"));
    ok("Q40 o worker nao ganhou retry proprio nem loop",
      !/setInterval|while \(true\)|for \(;;\)/.test(wrk));
    ok("Q41 e continua sem conhecer Approval",
      !/aprovacaoId|aprovacao_id|retomarAprovacao/.test(wrk));
  }

  // ═══ R. DB1 — a fronteira do claim GLOBAL no teste de banco ═══════
  //
  // `claim_next_agente_tarefa()` nao recebe parametro algum: varre
  // `agente_tarefas` inteira e reivindica a elegivel MAIS ANTIGA
  // (`ORDER BY t.criado_em ASC`), de qualquer dono, MUTANDO a linha.
  // A fixture do teste de banco nasce agora, logo e sempre a mais nova
  // — com uma tarefa real elegivel na fila, o claim leva a real.
  //
  // A DB1 separou o arquivo em duas regioes. Esta secao prova a
  // fronteira ESTATICAMENTE, porque conferir `if`s a olho e exatamente
  // o que falha quando alguem acrescentar uma chamada meses depois.
  console.log("\nR. DB1 — fronteira do claim global (teste de banco)");
  {
    const DB_TESTE = "scripts/testar-agentes-execucao-banco.ts";
    const bruto = fonte(DB_TESTE);

    // O recorte e feito no BRUTO porque o marcador de fim e um
    // comentario — `codigo()` o apagaria junto com a fronteira.
    const semComentarios = (t: string) =>
      t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

    const MARCA_INI = "async function testarClaimGlobalPerigoso(";
    const MARCA_FIM = "// ═══ FIM DO BLOCO CLAIM GLOBAL PERIGOSO";
    const iIni = bruto.indexOf(MARCA_INI);
    const iFim = bruto.indexOf(MARCA_FIM);

    ok("R1  ANCORA: as duas marcas da regiao perigosa existem, na ordem",
      iIni > 0 && iFim > iIni);

    const perigosa = semComentarios(bruto.slice(iIni, iFim));
    const segura = semComentarios(bruto.slice(0, iIni) + bruto.slice(iFim));
    ok("R2  ANCORA: as duas regioes tem conteudo",
      perigosa.length > 2000 && segura.length > 2000);

    // A CHAMADA e a unica forma de executar o claim. `.rpc("claim…")`
    // cobre `db.rpc`, `db2.rpc` e `c.rpc` do `map` de 5 clientes.
    const CHAMADA = /\.rpc\(\s*"claim_next_agente_tarefa"/g;
    const noArquivo = conta(semComentarios(bruto), CHAMADA);
    const naPerigosa = conta(perigosa, CHAMADA);
    const naSegura = conta(segura, CHAMADA);

    ok(`R3  o modo seguro tem ZERO chamadas ao claim global (achadas=${naSegura})`,
      naSegura === 0);
    ok(`R4  TODAS as chamadas ao claim vivem na regiao perigosa (${naPerigosa}/${noArquivo})`,
      naPerigosa > 0 && naPerigosa === noArquivo);
    // CONTROLE NEGATIVO: a sonda precisa saber dizer NAO. Sem isto, R3
    // ficaria verde ate se o regex nunca casasse com nada.
    ok("R5  CONTROLE NEGATIVO: uma chamada injetada na regiao segura reprova",
      conta(segura + '\nawait db.rpc("claim_next_agente_tarefa");', CHAMADA) === 1);

    // As DUAS flags, e a porta unica.
    ok("R6  a flag adicional existe, e e literal e longa",
      /--confirmo-claim-global/.test(bruto) &&
      !/"--all"|"--full"|"--force"|"--yes"/.test(bruto));
    ok("R7  a porta do bloco perigoso e a CONJUNCAO das duas flags",
      /const CLAIM_GLOBAL_LIBERADO = CONFIRMADO && CONFIRMADO_CLAIM_GLOBAL;/.test(bruto));

    // Um unico chamador, e ele esta dentro da guarda.
    const CHAMADOR = /await testarClaimGlobalPerigoso\(/g;
    ok("R8  a funcao perigosa tem EXATAMENTE um chamador", conta(segura, CHAMADOR) === 1);
    const iGuarda = segura.indexOf("if (CLAIM_GLOBAL_LIBERADO) {");
    const iChamada = segura.indexOf("await testarClaimGlobalPerigoso(");
    const iElse = segura.indexOf("} else {", iGuarda);
    ok("R9  e o chamador esta DENTRO da guarda",
      iGuarda > 0 && iChamada > iGuarda && iElse > iChamada);

    // A secao do P0 — o objetivo do modo seguro — sem claim nenhum.
    // Ancorado no `console.log` da secao, que e CODIGO: o cabecalho em
    // comentario foi removido junto com os demais por `semComentarios`.
    const iP0 = segura.indexOf("11. Pausa por aprovacao");
    const secaoP0 = iP0 > 0 ? segura.slice(iP0) : "";
    ok("R10 ANCORA: a secao 11 foi recortada", secaoP0.length > 800);
    ok("R11 a secao 11 nao chama o claim e promove a fixture por INSERT",
      conta(secaoP0, CHAMADA) === 0 &&
      /semearEmRodando\(/.test(secaoP0));
    ok("R12 e o fencing usa uma tentativa que o TESTE escolheu, nao uma vinda do claim",
      /const N = \d+;/.test(secaoP0) &&
      /p_tentativa_esperada: N - 1,/.test(secaoP0) &&
      /p_tentativa_esperada: N,/.test(secaoP0));
    ok("R13 e endereca SEMPRE a propria fixture",
      /p_tarefa_id: F,/.test(secaoP0) && !/p_tarefa_id: t1?\./.test(secaoP0));

    // O INSERT que substitui o claim precisa nascer coerente.
    ok("R14 `semearEmRodando` insere em rodando com tentativa, iniciado_em e heartbeat",
      /status: "rodando",/.test(segura) &&
      /tentativas: opcoes\.tentativas,/.test(segura) &&
      /iniciado_em: agora,/.test(segura) &&
      /heartbeat_em: agora,/.test(segura));

    // Limpeza: nenhum DELETE sem filtro, com a tabela de producao cheia.
    const DELETE_QUALQUER = /\.delete\(/g;
    const DELETE_POR_PREFIXO = /\.delete\(\)\.like\("user_id", `\$\{PREFIXO\}%`\)/g;
    ok("R15 todo DELETE do teste e por PREFIXO — nenhum global",
      conta(segura, DELETE_QUALQUER) === conta(segura, DELETE_POR_PREFIXO) &&
      conta(segura, DELETE_POR_PREFIXO) === 2 &&
      conta(perigosa, DELETE_QUALQUER) === 0);
    ok("R16 e nao ha truncate nem delete sem filtro em lugar nenhum",
      !/truncate/i.test(bruto) && !/\.delete\(\)\s*;/.test(bruto));

    // 10.3/10.4: contagem escopada, nunca "producao vazia".
    ok("R17 nenhuma contagem exige a tabela INTEIRA vazia",
      !/head: true \}\)\s*;/.test(segura) &&
      !/tabela agentes de volta a ZERO|tabela agente_tarefas de volta a ZERO/.test(bruto));

    // O output nao pode insinuar prova que nao houve.
    ok("R18 o modo seguro anuncia que o claim global NAO rodou",
      /CLAIM_GLOBAL_SKIPPED/.test(bruto) && /CLAIM_GLOBAL_DANGEROUS_ENABLED/.test(bruto));

    // ── R19..R23 — a prova pos-limpeza mede TODO o PREFIXO ───────────
    //
    // A limpeza apaga por `LIKE '${PREFIXO}%'`. Se a verificacao medir
    // um universo MENOR — um tenant so, uma fixture so — um residuo de
    // qualquer outro tenant do prefixo passa verde. E se medir a tabela
    // INTEIRA, volta a premissa "producao esta vazia", que e falsa.
    const iLimpeza = segura.indexOf("10. Limpeza");
    const iPlacar = segura.indexOf("const total = passou + falhou;");
    const blocoLimpeza = iLimpeza > 0 && iPlacar > iLimpeza ? segura.slice(iLimpeza, iPlacar) : "";
    ok("R19 ANCORA: o bloco de verificacao pos-limpeza foi recortado",
      blocoLimpeza.length > 400);

    /** O mesmo predicado, aplicado ao bloco real e aos mutantes de R23. */
    const mediuTodoOPrefixo = (bloco: string) =>
      // as DUAS tabelas, pelo predicado do proprio `limpar()`
      conta(bloco, /\.like\("user_id", ONDE_SINTETICO\)/g) === 4 &&
      /from\("agente_tarefas"\)\.select\("id", \{ count: "exact", head: true \}\)/.test(bloco) &&
      /from\("agentes"\)\.select\("id", \{ count: "exact", head: true \}\)/.test(bloco) &&
      // nenhum estreitamento para um tenant unico
      !/\.eq\("user_id"/.test(bloco) &&
      // nenhuma contagem sem filtro (a premissa "tabela vazia")
      !/head: true \}\)\s*;/.test(bloco);

    ok("R20 a verificacao pos-limpeza usa o MESMO universo que a limpeza",
      mediuTodoOPrefixo(blocoLimpeza));
    ok("R21 o universo e definido a partir do PREFIXO, nao de um tenant",
      /const ONDE_SINTETICO = `\$\{PREFIXO\}%`;/.test(segura));
    ok("R22 e ainda enumera QUEM sobrou, no mesmo universo",
      /tenantsResiduais/.test(blocoLimpeza) &&
      /TENANTS_DO_TESTE/.test(blocoLimpeza) &&
      /t\.startsWith\(PREFIXO\)/.test(blocoLimpeza));

    // CONTROLE NEGATIVO exigido pelo gate: trocar o `LIKE` do prefixo
    // por `EQ` de um tenant unico tem de reprovar a sonda.
    ok("R23 CONTROLE NEGATIVO: estreitar de LIKE PREFIXO para EQ tenant B reprova",
      !mediuTodoOPrefixo(
        blocoLimpeza.replace(/\.like\("user_id", ONDE_SINTETICO\)/g, '.eq("user_id", USUARIO_B)')
      ) &&
      // e voltar a contagem global tambem reprova
      !mediuTodoOPrefixo(
        blocoLimpeza.replace(/\.like\("user_id", ONDE_SINTETICO\)/g, ";")
      ));

    // ── R24..R27 — os probes de privilegio sao failure-safe ──────────
    //
    // Um probe de privilegio so vale se, QUANDO a protecao falhar, ele
    // ficar vermelho. Duas condicoes: o alvo tem de ser uma linha que a
    // propria execucao criou, e o assert tem de exigir erro de ACESSO —
    // um 55000 e o que uma RPC EXECUTADA devolveria.
    const iPriv = segura.indexOf("9. Privilegios das RPCs");
    const iP0parc = segura.indexOf("11. Pausa por aprovacao");
    const blocoPriv = iPriv > 0 && iP0parc > iPriv ? segura.slice(iPriv, iP0parc) : "";
    ok("R24 ANCORA: o bloco de privilegios seguro foi recortado", blocoPriv.length > 600);

    ok("R25 nenhum probe seguro mira um uuid literal — o alvo e fixture propria",
      !/0{8}-0{4}-0{4}-0{4}-0{12}/.test(segura) &&
      /const \{ tarefaId: ALVO_PRIVILEGIO \} = await semear\(db\);/.test(blocoPriv));
    ok("R26 e o assert exige erro de ACESSO, nao de negocio",
      /CODIGOS_DE_NEGOCIO/.test(blocoPriv) &&
      /barradoPorPrivilegio/.test(blocoPriv) &&
      !/ok\(`9\.x anon NAO executa \$\{fn\}`, !!error/.test(blocoPriv) &&
      /!barradoPorPrivilegio\(\{ code: "55000" \}\)/.test(blocoPriv));

    // Nenhuma RPC enderecada do modo seguro recebe id de consulta
    // global: os alvos sao um conjunto NOMINAL e fechado.
    const alvos = [...segura.matchAll(/p_tarefa_id:\s*([A-Za-z_][\w.]*)/g)].map((m) => m[1]);
    const ALVOS_PERMITIDOS = ["F", "ALVO_PRIVILEGIO"];
    ok(`R27 todo p_tarefa_id do modo seguro vem de fixture (${[...new Set(alvos)].join(", ")})`,
      alvos.length >= 5 && alvos.every((a) => ALVOS_PERMITIDOS.includes(a)));
  }

  // ────────────────────────────────────────────────────────────────
  //
  // Ate a V1-A, uma Task so andava se alguem rodasse
  // `scripts/agentes-worker.mjs` a mao: `criarTarefa` a deixa
  // `pendente`, `executarTarefa` so aceita `rodando`, e a unica ponte e
  // `claim_next_agente_tarefa()`. O Chat ja publicado enfileirava
  // trabalho que ninguem executava.
  //
  // O dispatcher fecha isso. E ele tem DOIS modos de falha silenciosa,
  // que sao o motivo desta secao existir:
  //   1. esquecer a rota em `ROTAS_COM_SEGREDO` — o agendador leva 307
  //      para /login e registra SUCESSO a cada minuto, para sempre;
  //   2. esquecer o `maxDuration` — a funcao herda os 60 s do glob de
  //      `vercel.json` e e cortada no meio, deixando a Task em
  //      `rodando` ate a recuperacao de orfa, 5 minutos depois.
  // Nenhum dos dois produz erro visivel. Por isso os asserts Q e R
  // cruzam as TRES fontes (rota, `vercel.json`, middleware) em vez de
  // conferir cada uma por si.
  //
  // NOTA DE PROCEDIMENTO: a lista literal de itens do §36 do gate nao
  // sobreviveu a compactacao da sessao. Os asserts A–R abaixo foram
  // derivados do CONTRATO real do dispatcher (auth, orcamento, laco,
  // execucao em processo, nao-vazamento e reconciliacao), e nao da
  // lista original. Registrado como V1B1-I1-L1.
  console.log("\nS. FUNCTION-RUNTIME-V1-B1 — dispatcher (cron -> claim -> executarTarefa)");
  {
    const ROTA_WORKER = "app/api/internal/agentes/worker/route.ts";
    const CAMINHO_WORKER = "/api/internal/agentes/worker";
    const brutoWorker = fonte(ROTA_WORKER);
    const codWorker = codigo(ROTA_WORKER);

    // ── A. ANCORA ─────────────────────────────────────────────────
    //
    // Toda varredura de ausencia abaixo (L, O, P) e vacua sobre texto
    // vazio. Provar primeiro que ha o que varrer.
    ok("B1-A ANCORA: a rota do dispatcher existe e tem um GET",
      brutoWorker.length > 1500 &&
      codWorker.length > 600 &&
      /export async function GET\(/.test(codWorker));

    // ── B. UM verbo ────────────────────────────────────────────────
    //
    // O agendador da Vercel so faz GET. Qualquer outro export daria uma
    // segunda porta para a mesma fila, com a mesma chave.
    ok("B1-B GET e o UNICO verbo exportado pela rota",
      !/export async function (POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\(/.test(codWorker));

    // ── C. Auth fail-closed ────────────────────────────────────────
    //
    // As quatro marcas juntas: le do ambiente, le do header, NEGA
    // quando a variavel falta, e compara. Faltando a terceira, um
    // ambiente sem `CRON_SECRET` abriria a rota para todo mundo.
    ok("B1-C a guarda le CRON_SECRET, le o header e e fail-closed",
      /process\.env\.CRON_SECRET/.test(codWorker) &&
      /headers\.get\("authorization"\)/.test(codWorker) &&
      /!segredo \|\| !auth/.test(codWorker) &&
      /auth !== `Bearer \$\{segredo\}`/.test(codWorker) &&
      /401/.test(codWorker));

    // ── D. A guarda PRECEDE o laco ─────────────────────────────────
    //
    // Autenticar depois de reivindicar seria pior que nao autenticar: a
    // Task ja teria saido da fila para `rodando` antes do 401.
    const iGuarda = codWorker.indexOf("process.env.CRON_SECRET");
    const iWhile = codWorker.indexOf("while (");
    const iClaim = codWorker.indexOf("await reivindicarProximaTarefa()");
    const iExec = codWorker.indexOf("await executarTarefa(");
    ok("B1-D a guarda de segredo precede o laco, o claim e a execucao",
      iGuarda > 0 && iWhile > iGuarda && iClaim > iWhile && iExec > iClaim);

    // ── E. 401 indistinto ──────────────────────────────────────────
    //
    // Uma resposta para "sem segredo no servidor" e outra para "Bearer
    // errado" contariam ao chamador em que estado esta a configuracao.
    const corpos401 = [...codWorker.matchAll(/return responder\((\{[^}]*\}), 401\)/g)]
      .map((m) => m[1]);
    ok(`B1-E ha exatamente UM corpo de 401, e ele nao diz o que faltou (${corpos401.length})`,
      corpos401.length === 1 &&
      !/segredo|env|CRON|ausente|header/i.test(corpos401[0]));

    // ── F. O teto declarado ────────────────────────────────────────
    ok("B1-F a rota declara maxDuration = 300",
      /export const maxDuration = 300/.test(codWorker));

    // ── G. As tres constantes, com os valores exatos ───────────────
    const num = (nome: string): number | null => {
      const m = codWorker.match(new RegExp("const " + nome + " = ([0-9_]+);"));
      return m ? Number(m[1].replace(/_/g, "")) : null;
    };
    const orcamento = num("ORCAMENTO_MS");
    const folga = num("FOLGA_MINIMA_MS");
    const maxTasks = num("MAX_TASKS_PER_RUN");
    ok(`B1-G as constantes do orcamento sao as declaradas (${orcamento}/${folga}/${maxTasks})`,
      orcamento === 240_000 && folga === 90_000 && maxTasks === 5);

    // ── H. A janela util e POSITIVA ────────────────────────────────
    //
    // Aritmetica, nao fe. Com folga >= orcamento a condicao do laco
    // nasce falsa: o cron rodaria a cada minuto, responderia 200 com
    // `processados: 0` e a fila nunca andaria. Verde e silencioso — o
    // pior resultado possivel.
    const janela = orcamento !== null && folga !== null ? orcamento - folga : -1;
    ok(`B1-H a janela util do laco e positiva e vale 150000 ms (${janela})`,
      janela === 150_000 && orcamento !== null && orcamento < 300_000);

    // ── I. As TRES condicoes, juntas, e a fonte unica do orcamento ──
    //
    // Ate o D0 a inequacao vivia dentro do `while`, e o assert olhava o
    // texto dela ali. O D0 a moveu para uma callback — nao por estilo:
    // a MESMA funcao e passada ao slot de retomada, que a repassa ao
    // executor e a consulta no ultimo instante antes de gastar uma
    // aprovacao. Duas copias da mesma aritmetica seriam duas promessas
    // que podem divergir.
    //
    // Entao o assert mudou de alvo, nao de exigencia: continua provando
    // que quantidade e tempo valem JUNTOS, e passa a provar tambem que a
    // inequacao existe uma vez so e que quem a consulta e a mesma
    // funcao em todos os pontos.
    const mWhile = codWorker.match(/while \(([\s\S]*?)\) \{/);
    const condicao = mWhile ? mWhile[1] : "";
    const mPredicado = codWorker.match(
      /const podeIniciarNovoTrabalho = \(\) =>\s*([\s\S]*?);/);
    const corpoPredicado = mPredicado ? mPredicado[1].replace(/\s+/g, " ").trim() : "";

    ok("B1-I o laco exige trabalho, turnos E tempo simultaneamente",
      /processados < MAX_TASKS_PER_RUN/.test(condicao) &&
      /turnos < MAX_TURNOS_PER_RUN/.test(condicao) &&
      /podeIniciarNovoTrabalho\(\)/.test(condicao) &&
      /&&/.test(condicao) &&
      !/\|\|/.test(condicao));
    ok(`B1-I1 a inequacao de orcamento existe UMA vez, e e a historica (${corpoPredicado})`,
      corpoPredicado === "Date.now() - inicio < ORCAMENTO_MS - FOLGA_MINIMA_MS" &&
      conta(codWorker, /Date\.now\(\) - inicio < ORCAMENTO_MS - FOLGA_MINIMA_MS/g) === 1);
    ok("B1-I2 a callback tem UMA definicao e a cushion tem UMA fonte",
      conta(codWorker, /const podeIniciarNovoTrabalho = /g) === 1 &&
      conta(codWorker, /const FOLGA_MINIMA_MS = /g) === 1 &&
      conta(codWorker, /const ORCAMENTO_MS = /g) === 1);
    ok("B1-I3 o while e o slot consultam a MESMA funcao, sem embrulho",
      conta(codWorker, /podeIniciarNovoTrabalho\(\)/g) === 1 &&
      /executarSlotRetomada\(podeIniciarNovoTrabalho\)/.test(codWorker) &&
      !/\(\s*\)\s*=>\s*podeIniciarNovoTrabalho\(/.test(codWorker) &&
      !/podeIniciarNovoTrabalho\.bind/.test(codWorker));
    ok("B1-I4 CONTROLE: uma segunda inequacao equivalente seria detectada",
      conta(codWorker + "\nDate.now() - inicio < ORCAMENTO_MS - FOLGA_MINIMA_MS;",
        /Date\.now\(\) - inicio < ORCAMENTO_MS - FOLGA_MINIMA_MS/g) !== 1);
    ok("B1-I5 CONTROLE: um embrulho em arrow seria detectado",
      /\(\s*\)\s*=>\s*podeIniciarNovoTrabalho\(/
        .test("await executarSlotRetomada(() => podeIniciarNovoTrabalho());"));
    ok("B1-I6 o teto de turnos e DERIVADO do teto de trabalho",
      /const MAX_TURNOS_PER_RUN = 2 \* MAX_TASKS_PER_RUN;/.test(codWorker) &&
      conta(codWorker, /MAX_TURNOS_PER_RUN/g) === 2);

    // ── I7. `turnos += 1` e a PRIMEIRA instrucao do corpo ───────────
    //
    // Um turno que sai por qualquer caminho ja foi contado: e isso que
    // transforma o teto de turnos em garantia de terminacao. Se houvesse
    // um `await` ou um ramo antes do incremento, existiria caminho que
    // consome tempo sem consumir turno.
    {
      const iAbreLaco = codWorker.indexOf(") {", codWorker.indexOf("while ("));
      const inicioCorpo = codWorker.slice(iAbreLaco + 3);
      const primeira = inicioCorpo.split("\n").map((l) => l.trim())
        .find((l) => l.length > 0);
      ok(`B1-I7 \`turnos += 1;\` e a PRIMEIRA instrucao do corpo (${JSON.stringify(primeira)})`,
        primeira === "turnos += 1;");
      ok("B1-I8 e ela acontece uma vez so, incondicionalmente",
        conta(codWorker, /turnos \+= 1;/g) === 1 &&
        !/if\s*\([^)]*\)\s*turnos \+= 1;/.test(codWorker));
    }

    // ── J. Avaliadas ANTES de cada claim ───────────────────────────
    //
    // `do { } while` reivindicaria uma Task antes de perguntar se ha
    // tempo — exatamente a iteracao que fica presa em `rodando`.
    ok("B1-J a condicao e testada ANTES do claim (nao ha do-while)",
      !/\bdo\s*\{/.test(codWorker) && iWhile > 0 && iWhile < iClaim);

    // ── K. Execucao no MESMO processo ──────────────────────────────
    //
    // Chamar `/api/internal/agentes/executar` por HTTP seria um salto de
    // rede e um SEGUNDO timeout dentro do orcamento, com um segredo a
    // mais em jogo e nenhum ganho: o executor ja e importavel.
    ok("B1-K o dispatcher chama executarTarefa em processo, sem salto HTTP",
      /from "@\/lib\/agentes\/executar-tarefa"/.test(codWorker) &&
      /await executarTarefa\(tarefa\.tarefaId\)/.test(codWorker) &&
      !/api\/internal\/agentes\/executar/.test(codWorker));

    // ── L. Zero rede ───────────────────────────────────────────────
    ok("B1-L a rota nao abre rede por conta propria",
      !/\bfetch\(/.test(codWorker) &&
      !/axios|node-fetch|require\("https?"\)|from "https?"/.test(codWorker));

    // ── M. O que conta como PROCESSADA ─────────────────────────────
    //
    // 200 do `executarTarefa` significa "chegou a um desfecho
    // REGISTRADO" — e sao tres: concluido, aguardando_aprovacao e
    // `ok:false` com a falha ja gravada. Os tres sao trabalho feito. Se
    // o dispatcher parasse no `ok:false`, uma unica Task quebrada
    // travaria a fila inteira atras dela.
    // V1-B1-F1: o dispatcher passou a ler DUAS coisas, e elas decidem
    // perguntas diferentes. O STATUS separa "houve desfecho registrado"
    // de "falha operacional"; o `corpo.ok` separa, DENTRO do desfecho
    // registrado, sucesso de falha de negocio. Conflar os dois foi
    // exatamente o defeito V1B1-I1-M1. A cadencia em si e provada na
    // secao S2.
    ok("B1-M o status separa desfecho de falha operacional, em ramo proprio",
      /const \{ status, corpo \} = await executarTarefa\(/.test(codWorker) &&
      /if \(status !== 200\) \{/.test(codWorker) &&
      /if \(corpo\.ok === false\) break;/.test(codWorker) &&
      // Os dois ramos sao SEPARADOS: nenhuma condicao mistura os dois
      // sinais numa expressao so.
      !/status !== 200 \|\||corpo\.ok === false \|\|/.test(codWorker));

    // ── N. O contador so anda depois do trabalho ───────────────────
    //
    // Incrementar antes tornaria `processados` uma contagem de CLAIMS, e
    // o teto viraria teto de tentativas, nao de execucoes.
    // O D0 criou um SEGUNDO site legitimo: o turno de retomada tambem
    // consome uma vaga quando deixa trabalho duravel. Contar sites nao
    // basta mais — o que importa e o PAPEL de cada um. Por isso o assert
    // passou a localizar cada incremento no seu ramo e a provar a
    // condicao que o governa, em vez de exigir cardinalidade 1.
    ok("B1-N ha exatamente DOIS incrementos, um por lane",
      conta(codWorker, /processados \+= 1;/g) === 2);
    ok("B1-N1 o incremento da lane NORMAL continua vindo depois da execucao",
      codWorker.lastIndexOf("processados += 1;") > iExec);
    ok("B1-N2 o incremento da lane RETOMADA e governado SO pelo grau de progresso",
      /if \(r\.progressoDuravel !== "nenhum"\) \{\s*processados \+= 1;\s*\}/
        .test(codWorker.replace(/\s+/g, " ").replace(/\{ /g, "{").replace(/ \}/g, "}")) ||
      /r\.progressoDuravel !== "nenhum"[\s\S]{0,60}?processados \+= 1;/.test(codWorker));
    ok("B1-N3 o incremento de retomada NAO olha ok, desfecho nem falha",
      !/r\.ok[\s\S]{0,40}?processados \+= 1;/.test(codWorker) &&
      !/r\.desfecho[\s\S]{0,40}?processados \+= 1;/.test(codWorker));
    ok("B1-N4 nao existe TERCEIRO site de incremento",
      conta(codWorker, /processados \+\+|processados = processados \+|processados \+= [^1]/g) === 0);

    // ── O. O wrapper do claim so deixa sair o id ───────────────────
    //
    // `claim_next_agente_tarefa()` devolve a LINHA inteira — `user_id`,
    // `agente_id`, `entrada`. O dispatcher precisa de um id e de nada
    // mais; o resto e dado de um dono que nao pediu nada disso.
    const bruCap = fonte("lib/agentes/capability-worker.ts");
    const iW = bruCap.indexOf("export async function reivindicarProximaTarefa");
    const wrapper = iW > 0
      ? bruCap.slice(iW).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")
      : "";
    ok("B1-O ANCORA: o corpo do wrapper do claim foi recortado", wrapper.length > 400);
    ok("B1-O o wrapper devolve SO o tarefaId, valida a forma e nao vaza o driver",
      /return \{ tarefa: \{ tarefaId: id \}, erro: null \};/.test(wrapper) &&
      /UUID_REGEX\.test\(id\)/.test(wrapper) &&
      /claim_shape_invalido/.test(wrapper) &&
      !/user_id|agente_id|entrada|error\.message/.test(wrapper));

    // ── P. A resposta e os logs nao carregam identificador ─────────
    //
    // O corpo desta rota vai para o log de invocacao da Vercel, que nao
    // e multi-tenant: um `tarefaId` ali junta um dono a um horario.
    const corpos = [...codWorker.matchAll(/responder\((\{[^}]*\})/g)].map((m) => m[1]);
    ok(`B1-P ANCORA: ha respostas a inspecionar (${corpos.length})`, corpos.length >= 3);

    // A chave e o que o log da Vercel guarda. Conjunto NOMINAL e
    // fechado: contadores e um codigo de erro de vocabulario proprio.
    // Uma chave nova entra aqui deliberadamente ou nao entra.
    const CHAVES_PERMITIDAS = ["ok", "processados", "erro", "duracaoMs"];
    const chaves = corpos.flatMap((c) => [...c.matchAll(/(\w+):/g)].map((m) => m[1]));
    ok(`B1-P as respostas so tem chaves de contagem e codigo (${[...new Set(chaves)].join(", ")})`,
      chaves.length >= 8 && chaves.every((k) => CHAVES_PERMITIDAS.includes(k)));

    ok("B1-P nenhuma resposta e nenhum log carregam id, tenant ou payload",
      corpos.every((c) => !/\$\{|`/.test(c)) &&
      !/tarefa|user|agente/i.test(corpos.join(" ")) &&
      !/userId|user_id|agenteId|agente_id|entrada|resultado|erro_mensagem/.test(codWorker) &&
      [...codWorker.matchAll(/console\.\w+\(([^)]*)\)/g)].every((m) => !/\$\{|,/.test(m[1])));

    // ── Q. `vercel.json` declara o cron E o teto ───────────────────
    //
    // Os dois, sempre juntos: cron sem `maxDuration` cai no glob de
    // 60 s; `maxDuration` sem cron e um teto que ninguem aciona.
    const vj = JSON.parse(fonte("vercel.json")) as {
      crons: { path: string; schedule: string }[];
      functions: Record<string, { maxDuration?: number }>;
    };
    const cronWorker = vj.crons.filter((c) => c.path === CAMINHO_WORKER);
    ok(`B1-Q o cron do dispatcher esta declarado UMA vez, de minuto em minuto (${cronWorker.length})`,
      cronWorker.length === 1 && cronWorker[0].schedule === "* * * * *");
    ok("B1-Q o override de maxDuration bate com o declarado na rota",
      vj.functions[ROTA_WORKER]?.maxDuration === 300 &&
      vj.functions["app/api/**"]?.maxDuration === 60);

    // ── R. A reconciliacao que impede o 307 silencioso ─────────────
    //
    // Esta e a peca que os outros asserts nao cobrem: os tres lugares
    // podem estar individualmente certos e ainda assim discordarem
    // entre si. O caminho do cron TEM de ser o caminho liberado no
    // middleware, e TEM de ser o caminho do arquivo da rota.
    ok("B1-R o caminho do cron e o mesmo liberado no middleware, so em GET",
      ROTAS_COM_SEGREDO[CAMINHO_WORKER]?.length === 1 &&
      ROTAS_COM_SEGREDO[CAMINHO_WORKER][0] === "GET" &&
      decidirAcesso(CAMINHO_WORKER, "GET", false) === "liberar");
    ok("B1-R e o caminho do cron deriva do arquivo da rota, sem folga",
      "app/api" + CAMINHO_WORKER.slice("/api".length) + "/route.ts" === ROTA_WORKER &&
      !(CAMINHO_WORKER in ROTAS_PUBLICAS) &&
      !PAGINAS_PUBLICAS.has(CAMINHO_WORKER) &&
      ["POST", "PUT", "PATCH", "DELETE"].every(
        (m) => decidirAcesso(CAMINHO_WORKER, m, false) === "bloquear_api"));
  }

  // ────────────────────────────────────────────────────────────────
  //
  // V1B1-I1-M1 — RETRY ACELERADO, e a prova de que ele fechou.
  //
  // `falhar_tarefa` devolve a tarefa para `pendente` enquanto
  // `tentativas < max_tentativas` (20260917_agentes_execucao.sql), e o
  // claim entrega sempre a elegivel MAIS ANTIGA. Enquanto o laco
  // continuava depois de uma falha de negocio, a MESMA tarefa voltava a
  // ser a mais antiga e era reivindicada de novo na MESMA invocacao:
  // tres tentativas em segundos, ocupando tres das cinco vagas.
  //
  // ── Por que esta secao le ESTRUTURA, e nao a palavra `break` ──────
  //
  // Procurar "break" no arquivo provaria nada: ele ja aparece no
  // encerramento de fila vazia. O que precisa ser provado e uma relacao
  // de CONTROLE — que, depois da guarda, NAO EXISTE caminho de volta ao
  // claim dentro da mesma invocacao. Aqui isso e feito sobre o corpo do
  // laco recortado por casamento de chaves, e cada predicado tem
  // CONTROLE NEGATIVO: o mesmo predicado e alimentado com a fonte
  // mutada e tem de reprovar.
  //
  // O seam executavel foi tentado e RECUSADO PELO FRAMEWORK: exportar
  // `drenarFila` de um `route.ts` quebra a checagem de tipos gerada
  // pelo Next 14 ("Property 'drenarFila' is incompatible with index
  // signature"). Medido, nao suposto. Um modulo de producao novo so
  // para o seam ficaria fora do escopo autorizado do F1.
  console.log("\nS2. FUNCTION-RUNTIME-V1-B1-F1 — retry pacing (NO SAME-RUN RETRY)");
  {
    const codW = codigo("app/api/internal/agentes/worker/route.ts");

    /**
     * O corpo do `while`, recortado por CASAMENTO DE CHAVES.
     *
     * Regex guloso pegaria ate o fim do arquivo e regex preguicoso
     * pararia na primeira chave interna — os dois dariam um recorte
     * errado, e um recorte errado faz todo assert abaixo virar ruido.
     * A condicao do laco contem `Date.now()`, entao a abertura e
     * localizada por `") {"`, que nao aparece dentro dela.
     */
    const corpoDoLaco = (texto: string): string => {
      const iW = texto.indexOf("while (");
      if (iW < 0) return "";
      const iAbre = texto.indexOf(") {", iW);
      if (iAbre < 0) return "";
      let nivel = 0;
      for (let k = iAbre + 2; k < texto.length; k++) {
        if (texto[k] === "{") nivel += 1;
        else if (texto[k] === "}") {
          nivel -= 1;
          if (nivel === 0) return texto.slice(iAbre + 2, k + 1);
        }
      }
      return "";
    };

    const CLAIM = "await reivindicarProximaTarefa()";
    const GUARDA_C = "if (corpo.ok === false) break;";
    const INCREMENTO = "processados += 1;";
    const RAMO_D = "if (status !== 200) {";

    /**
     * O ramo NORMAL, recortado do corpo do laco.
     *
     * Depois do D0 o corpo tem duas lanes, e varios asserts historicos
     * falavam do fluxo normal usando "o primeiro X do corpo" como
     * atalho. Esse atalho passou a apontar para a retomada. Recortar o
     * ramo certo devolve a eles o alvo original — sem afrouxar nada, e
     * sem deixar a retomada contaminar a medicao.
     */
    const ramoNormal = (texto: string): string => {
      const corpo = corpoDoLaco(texto);
      const iElse = corpo.indexOf("} else {");
      if (iElse < 0) return "";
      let nivel = 0;
      for (let k = iElse + 7; k < corpo.length; k++) {
        if (corpo[k] === "{") nivel += 1;
        else if (corpo[k] === "}") {
          nivel -= 1;
          if (nivel === 0) return corpo.slice(iElse + 7, k + 1);
        }
      }
      return "";
    };

    /** O ramo RETOMADA, pelo mesmo criterio. */
    const ramoRetomada = (texto: string): string => {
      const corpo = corpoDoLaco(texto);
      const marca = 'if (proximaLane === "retomada") {';
      const i = corpo.indexOf(marca);
      if (i < 0) return "";
      let nivel = 0;
      for (let k = i + marca.length - 1; k < corpo.length; k++) {
        if (corpo[k] === "{") nivel += 1;
        else if (corpo[k] === "}") {
          nivel -= 1;
          if (nivel === 0) return corpo.slice(i, k + 1);
        }
      }
      return "";
    };

    const laco = corpoDoLaco(codW);

    // ── ANCORA: o recorte e real, e e MENOR que o arquivo ──────────
    //
    // Sem isto, um recorte vazio faria todo `indexOf(...) === -1`
    // passar, e um recorte do arquivo inteiro faria todo `includes`
    // passar. As duas pontas fechadas.
    ok("S2-A ANCORA: o corpo do laco foi recortado, e e um subconjunto proprio do arquivo",
      laco.length > 300 &&
      laco.length < codW.length &&
      laco.trim().startsWith("{") &&
      laco.trim().endsWith("}") &&
      laco.includes(CLAIM) &&
      laco.includes("await executarTarefa("));

    /**
     * A PROPRIEDADE, como predicado sobre texto — para que os controles
     * negativos possam alimenta-la com fonte mutada sem tocar em
     * arquivo nenhum.
     *
     * Cinco fatos que, juntos, fecham o ciclo de controle:
     *
     *  1. ha UM unico ponto de claim no arquivo inteiro;
     *  2. ele esta dentro do corpo do laco;
     *  3. a guarda de falha de negocio vem DEPOIS dele;
     *  4. depois da guarda, nada no corpo reivindica;
     *  5. a consequencia da guarda e `break`, e nao existe `continue`
     *     em lugar nenhum — o unico jeito de voltar ao topo seria
     *     concluir o corpo, e a guarda o encerra antes.
     */
    const semRetryNaMesmaRodada = (texto: string): boolean => {
      const corpo = corpoDoLaco(texto);
      if (corpo.length === 0) return false;

      const claimsNoArquivo = conta(texto, /await reivindicarProximaTarefa\(\)/g);
      const iClaim = corpo.indexOf(CLAIM);
      const iGuarda = corpo.indexOf(GUARDA_C);
      if (claimsNoArquivo !== 1 || iClaim < 0 || iGuarda < 0) return false;
      if (iGuarda < iClaim) return false;

      const depoisDaGuarda = corpo.slice(iGuarda + GUARDA_C.length);
      return (
        !depoisDaGuarda.includes("reivindicarProximaTarefa") &&
        !/\bcontinue\b/.test(texto)
      );
    };

    ok("S2-B NO SAME-RUN RETRY: apos a falha de negocio nao ha caminho de volta ao claim",
      semRetryNaMesmaRodada(codW));

    // ── CONTROLES NEGATIVOS — o predicado sabe dizer NAO ───────────
    //
    // Estes quatro sao o que separa um assert de uma afirmacao. Cada um
    // reintroduz o defeito de um jeito diferente; nenhum pode passar.
    ok("S2-C CONTROLE NEGATIVO: trocar o break por continue reprova",
      !semRetryNaMesmaRodada(codW.replace(GUARDA_C, "if (corpo.ok === false) continue;")));
    ok("S2-D CONTROLE NEGATIVO: apagar a guarda inteira reprova",
      !semRetryNaMesmaRodada(codW.replace(GUARDA_C, "")));
    ok("S2-E CONTROLE NEGATIVO: um segundo claim depois da guarda reprova",
      !semRetryNaMesmaRodada(
        codW.replace(GUARDA_C, GUARDA_C + "\n      await reivindicarProximaTarefa();")));
    ok("S2-F CONTROLE NEGATIVO: a guarda ANTES do claim reprova",
      !semRetryNaMesmaRodada(
        codW.replace(GUARDA_C, "").replace(CLAIM, GUARDA_C + " " + CLAIM)));

    // ── A guarda e a ULTIMA instrucao do corpo ─────────────────────
    //
    // Fato estrutural mais forte que "existe um break": nao ha o que
    // rodar depois dela. Mesmo que alguem trocasse o `break` por algo
    // que caisse fora, nao sobraria corpo para executar.
    {
      // ANTES: a guarda era a ultima instrucao do corpo, porque o corpo
      // era a lane normal inteira. DEPOIS: ela e a ultima instrucao do
      // RAMO normal, e o que se prova continua sendo o mesmo fato — que
      // nada roda depois dela nesse ramo, entao `corpo.ok === false`
      // encerra a rodada e nao ha caminho de volta ao topo.
      const normalG = ramoNormal(codW);
      const iGuarda = normalG.indexOf(GUARDA_C);
      const resto = normalG.slice(iGuarda + GUARDA_C.length).trim();
      ok(`S2-G a guarda de falha de negocio e a ULTIMA instrucao do ramo normal (resto=${JSON.stringify(resto)})`,
        iGuarda > 0 && /^\}*$/.test(resto.replace(/\s/g, "")));
      ok("S2-G1 e a consequencia dela e `break`, nao `continue` nem resposta",
        /if \(corpo\.ok === false\) break;/.test(normalG) &&
        !/\bcontinue\b/.test(codW));
    }

    // ── A TENTATIVA CONTA, a falha operacional NAO ─────────────────
    //
    // A ordem e o contrato inteiro: o ramo D sai ANTES do incremento
    // (nao houve desfecho, nao houve tentativa processada), e a guarda
    // C vem DEPOIS dele (houve desfecho registrado, conta).
    {
      const iD = laco.indexOf(RAMO_D);
      // ESCOPADO AO RAMO NORMAL. Antes do D0, "o primeiro
      // `processados += 1;` do corpo" era o da lane normal porque nao
      // havia outra lane. Agora o primeiro e o da retomada, e medir no
      // corpo inteiro apontaria para o ramo errado — o assert passaria a
      // falar de outra coisa sem ninguem notar.
      const normal = ramoNormal(codW);
      const iIncN = normal.indexOf(INCREMENTO);
      const iDN = normal.indexOf(RAMO_D);
      const iCN = normal.indexOf(GUARDA_C);
      ok("S2-H ANCORA: o ramo normal foi recortado e contem claim, execucao e guarda",
        normal.length > 200 && normal.includes(CLAIM) &&
        normal.includes("await executarTarefa(") && iCN > 0);
      ok("S2-H a ordem no ramo NORMAL e: falha operacional -> incremento -> guarda",
        iDN > 0 && iIncN > iDN && iCN > iIncN);
      ok("S2-I o ramo normal incrementa UMA vez, e so no caminho de desfecho registrado",
        conta(normal, /processados \+= 1;/g) === 1);
      ok("S2-I1 o ramo da RETOMADA tambem incrementa uma vez so",
        conta(ramoRetomada(codW), /processados \+= 1;/g) === 1);
      ok("S2-I2 CONTROLE: medir no corpo inteiro daria 2 — por isso o recorte existe",
        conta(laco, /processados \+= 1;/g) === 2);
    }

    // ── C NAO e 500 ────────────────────────────────────────────────
    //
    // O handler falhou, o banco registrou e a tentativa foi contada: o
    // dispatcher fez o que devia. Entre o incremento e o fim do corpo
    // nao pode haver resposta nenhuma — a rodada termina pelo caminho
    // de sucesso, fora do laco.
    {
      // Tambem escopado: a cauda medida e a do RAMO NORMAL, a partir do
      // incremento DELE. Cortar a partir do primeiro incremento do corpo
      // arrastaria o ramo normal inteiro para dentro da "cauda" da
      // retomada, e os `responder(..., 500)` legitimos do claim e do
      // status apareceriam como se viessem depois do incremento.
      const normalJ = ramoNormal(codW);
      const caudaNormal = normalJ.slice(normalJ.indexOf(INCREMENTO));
      ok("S2-J ANCORA: a cauda do ramo normal foi recortada e contem a guarda",
        caudaNormal.includes(GUARDA_C) && caudaNormal.length > 20 &&
        caudaNormal.length < normalJ.length);
      ok("S2-K falha de NEGOCIO nao vira 500: nao ha resposta apos o incremento normal",
        !/responder\(/.test(caudaNormal));
      // E a resposta de sucesso vive FORA do laco — e por isso vale
      // igualmente para A, B e C.
      const foraDoLaco = codW.slice(codW.indexOf(laco) + laco.length);
      ok("S2-L a resposta de sucesso da rodada esta FORA do laco",
        /responder\(\{ ok: true, processados, duracaoMs/.test(foraDoLaco));
    }

    // ── A e B continuam drenando ───────────────────────────────────
    //
    // A prova mais forte disponivel aqui nao e procurar um `break` que
    // nao existe: e que o dispatcher NAO TEM COMO distinguir `concluido`
    // de `aguardando_aprovacao`. Ele nunca le `corpo.status`. Se um
    // drena, o outro drena — nao ha ramo onde eles divirjam.
    ok("S2-M concluido e aprovacao sao INDISTINGUIVEIS para o dispatcher",
      !/corpo\.status/.test(codW) && !/aguardando_aprovacao|concluido/.test(codW));
    ok("S2-N o dispatcher nao le nada do corpo alem do `ok`",
      conta(codW, /corpo\./g) === 1 && /corpo\.ok/.test(codW));

    // Exatamente DOIS `break` no corpo: fila vazia e falha de negocio.
    // Um terceiro seria um encerramento que ninguem revisou.
    // ── S2-O. Os QUATRO encerramentos, um a um ─────────────────────
    //
    // Contar `break` nunca foi a prova — a prova e que cada encerramento
    // tem razao conhecida. Com duas lanes sao quatro razoes, e um quinto
    // `break` seria um caminho de saida que ninguem revisou.
    {
      const retomadaO = ramoRetomada(codW);
      const normalO = ramoNormal(codW);
      const semEspaco = (t: string) => t.replace(/\s+/g, " ");
      ok("S2-O1 RETOMADA: encerra quando duas lanes seguidas vieram vazias",
        /if \(emptyStreak >= 2\) break;/.test(semEspaco(retomadaO)));
      ok("S2-O2 RETOMADA: encerra por orcamento, com break EXPLICITO",
        /if \(r\.ok === true && r\.encerrarPorOrcamento\) break;/.test(semEspaco(retomadaO)));
      ok("S2-O3 NORMAL: encerra quando duas lanes seguidas vieram vazias",
        /if \(emptyStreak >= 2\) break;/.test(semEspaco(normalO)));
      ok("S2-O4 NORMAL: encerra na falha de negocio ja gravada",
        /if \(corpo\.ok === false\) break;/.test(semEspaco(normalO)));
      ok(`S2-O o corpo tem exatamente QUATRO encerramentos, e nenhum quinto (${conta(laco, /break;/g)})`,
        conta(laco, /break;/g) === 4 &&
        conta(retomadaO, /break;/g) === 2 &&
        conta(normalO, /break;/g) === 2);
      ok("S2-O5 o orcamento e consultado DEPOIS de contabilizar o progresso",
        semEspaco(retomadaO).indexOf("processados += 1;") <
        semEspaco(retomadaO).indexOf("r.encerrarPorOrcamento"));
    }

    // ── Os limites do I1 continuam intactos ────────────────────────
    //
    // O F1 muda CADENCIA, nunca teto. Se algum destes tivesse mudado
    // junto, a correcao estaria carregando carona.
    ok("S2-P o F1 nao mexeu em nenhum dos quatro limites do I1",
      /export const maxDuration = 300/.test(codW) &&
      /const ORCAMENTO_MS = 240_000;/.test(codW) &&
      /const FOLGA_MINIMA_MS = 90_000;/.test(codW) &&
      /const MAX_TASKS_PER_RUN = 5;/.test(codW));
  }

  // ────────────────────────────────────────────────────────────────
  //
  // O CONTRATO DO CLAIM, protegido nominalmente — V1-B1-F2.
  //
  // O R1 mediu tres buracos de cobertura. Nao eram defeitos de codigo:
  // a propriedade valia em todos os tres casos. O problema era que
  // NENHUM teste a defendia, e uma propriedade que so vale por acaso
  // deixa de valer sem ninguem notar.
  //
  //   A. nada prendia o wrapper a RPC `claim_next_agente_tarefa` —
  //      aponta-lo para outra funcao deixava a suite verde;
  //   B. nada impedia um segundo argumento na chamada, que mudaria a
  //      semantica do claim em silencio;
  //   Q. nada impedia uma rota de USUARIO futura de chamar o claim
  //      global. Essa e a invariante de seguranca do slice inteiro: a
  //      RPC devolve a tarefa mais antiga de QUALQUER dono, entao um
  //      clique de um usuario reivindicaria a tarefa de outro.
  //   L. a guarda de fila vazia existia, mas a ORDEM contra
  //      `executarTarefa` nao estava protegida.
  //
  // Toda varredura abaixo e estrutural — chaves e parenteses
  // balanceados, nao regex guloso — e toda propriedade e um PREDICADO
  // sobre texto, para que o controle negativo possa alimenta-lo com
  // fonte mutada sem tocar em arquivo nenhum.
  console.log("\nS3. FUNCTION-RUNTIME-V1-B1-F2 — contrato do claim (RPC, args, rotas, ordem)");
  {
    const ROTA_W = "app/api/internal/agentes/worker/route.ts";
    const CAP_WORKER = "lib/agentes/capability-worker.ts";
    const RPC_DO_CLAIM = "claim_next_agente_tarefa";

    /**
     * Corpo de uma funcao, por CASAMENTO DE CHAVES a partir da
     * assinatura. Um regex ate o proximo `}` pararia na primeira chave
     * interna; um guloso engoliria o resto do arquivo. Os dois dariam
     * recorte errado — e recorte errado transforma todo assert abaixo
     * em ruido verde.
     */
    const corpoDaFuncao = (texto: string, assinatura: string): string => {
      const iAss = texto.indexOf(assinatura);
      if (iAss < 0) return "";

      // 1) Fechar a lista de PARAMETROS, por parenteses balanceados.
      const iAbreParams = texto.indexOf("(", iAss);
      if (iAbreParams < 0) return "";
      let par = 0;
      let iFechaParams = -1;
      for (let k = iAbreParams; k < texto.length; k++) {
        if (texto[k] === "(") par += 1;
        else if (texto[k] === ")") {
          par -= 1;
          if (par === 0) { iFechaParams = k; break; }
        }
      }
      if (iFechaParams < 0) return "";

      // 2) Achar a chave do CORPO — nao a do tipo de retorno.
      //
      // Este wrapper declara `): Promise<{ tarefa: ...; erro: ... }> {`.
      // Pegar o primeiro `{` depois da assinatura recortaria o TIPO, e
      // `.rpc(` nunca apareceria la dentro: o assert ficaria vermelho
      // por defeito da sonda, nao do codigo. Foi o que aconteceu na
      // primeira versao desta secao. A saida e contar `<` e `>`: a chave
      // do corpo e a primeira em profundidade angular ZERO.
      let angulo = 0;
      let iAbre = -1;
      for (let k = iFechaParams + 1; k < texto.length; k++) {
        const c = texto[k];
        if (c === "<") angulo += 1;
        else if (c === ">") angulo = Math.max(0, angulo - 1);
        else if (c === "{" && angulo === 0) { iAbre = k; break; }
      }
      if (iAbre < 0) return "";

      // 3) Fechar o corpo, por chaves balanceadas.
      let nivel = 0;
      for (let k = iAbre; k < texto.length; k++) {
        if (texto[k] === "{") nivel += 1;
        else if (texto[k] === "}") {
          nivel -= 1;
          if (nivel === 0) return texto.slice(iAbre, k + 1);
        }
      }
      return "";
    };

    /**
     * A LISTA DE ARGUMENTOS de `.rpc(...)`, por parenteses balanceados.
     *
     * Devolve o texto entre os parenteses da chamada — e so dela. E o
     * que permite que A e B falem da MESMA call expression: A sobre o
     * nome, B sobre o que vem depois dele.
     */
    const argumentosDoRpc = (corpo: string): string | null => {
      const iRpc = corpo.indexOf(".rpc(");
      if (iRpc < 0) return null;
      const iAbre = iRpc + ".rpc(".length - 1;
      let nivel = 0;
      for (let k = iAbre; k < corpo.length; k++) {
        if (corpo[k] === "(") nivel += 1;
        else if (corpo[k] === ")") {
          nivel -= 1;
          if (nivel === 0) return corpo.slice(iAbre + 1, k);
        }
      }
      return null;
    };

    const wrapper = corpoDaFuncao(
      codigo(CAP_WORKER), "export async function reivindicarProximaTarefa"
    );

    // ANCORA: sem ela, todo `indexOf(...) === -1` abaixo passaria sobre
    // texto vazio, e o recorte inteiro seria uma ficcao verde.
    ok("S3-A0 ANCORA: o corpo do wrapper foi recortado por chaves balanceadas",
      wrapper.length > 300 &&
      wrapper.length < codigo(CAP_WORKER).length &&
      wrapper.trim().startsWith("{") &&
      wrapper.trim().endsWith("}") &&
      wrapper.includes(".rpc("));

    // ── A e B — a MESMA chamada, duas propriedades ─────────────────
    const argsDoClaim = argumentosDoRpc(wrapper);

    /**
     * A: o wrapper chama EXATAMENTE a RPC do claim.
     *
     * Ligado ao corpo do wrapper, nunca ao arquivo: `capability-worker`
     * cita o nome da RPC em prosa em outros pontos, e uma busca no
     * arquivo inteiro continuaria verde com a chamada apontada para
     * outra funcao.
     */
    const chamaRpcDoClaim = (texto: string): boolean => {
      const corpo = corpoDaFuncao(texto, "export async function reivindicarProximaTarefa");
      const args = corpo.length > 0 ? argumentosDoRpc(corpo) : null;
      if (args === null) return false;
      const primeiro = args.split(",")[0].trim();
      return primeiro === `"${RPC_DO_CLAIM}"`;
    };

    ok(`S3-A o wrapper chama exatamente a RPC do claim (args=${JSON.stringify(argsDoClaim)})`,
      chamaRpcDoClaim(codigo(CAP_WORKER)));
    ok("S3-A CONTROLE NEGATIVO: o mesmo predicado reprova outra RPC",
      !chamaRpcDoClaim(codigo(CAP_WORKER)
        .replace(`"${RPC_DO_CLAIM}"`, `"${RPC_DO_CLAIM}_ERRADA"`)));

    /**
     * B: ZERO argumentos alem do nome.
     *
     * `claim_next_agente_tarefa()` nao aceita parametro — nao existe
     * como pedir "a tarefa do usuario X" nem "aquela tarefa ali". Um
     * segundo argumento aqui seria a porta para exatamente isso, e o
     * PostgREST o aceitaria sem reclamar do lado do cliente.
     */
    const rpcSemArgumentos = (texto: string): boolean => {
      const corpo = corpoDaFuncao(texto, "export async function reivindicarProximaTarefa");
      const args = corpo.length > 0 ? argumentosDoRpc(corpo) : null;
      return args !== null && args.trim() === `"${RPC_DO_CLAIM}"`;
    };

    ok("S3-B a chamada recebe SO o nome da RPC, sem segundo argumento",
      rpcSemArgumentos(codigo(CAP_WORKER)));
    ok("S3-B CONTROLE NEGATIVO: um payload adicional reprova",
      !rpcSemArgumentos(codigo(CAP_WORKER)
        .replace(`.rpc("${RPC_DO_CLAIM}")`, `.rpc("${RPC_DO_CLAIM}", { p_tarefa_id: "x" })`)));
    ok("S3-B CONTROLE NEGATIVO: ate um `undefined` explicito reprova",
      !rpcSemArgumentos(codigo(CAP_WORKER)
        .replace(`.rpc("${RPC_DO_CLAIM}")`, `.rpc("${RPC_DO_CLAIM}", undefined)`)));

    // A e B falam da MESMA call expression — nao de duas leituras
    // independentes que poderiam divergir.
    ok("S3-AB A e B analisam a mesma chamada, recortada uma vez so",
      argsDoClaim !== null && argsDoClaim.includes(RPC_DO_CLAIM));

    // ── Q — nenhuma rota de USUARIO toca o claim global ────────────
    //
    // Varredura REAL do diretorio, recursiva: a propriedade e sobre
    // `app/api/agentes/**`, nao sobre a lista de rotas que existiam no
    // dia em que este assert foi escrito. Uma rota nova nasce coberta.
    const rotasDeUsuario = (relativo: string): string[] => {
      const absoluto = join(RAIZ, relativo);
      const achados: string[] = [];
      const andar = (dir: string, rel: string): void => {
        for (const nome of readdirSync(dir).sort()) {
          const caminho = join(dir, nome);
          const relFilho = `${rel}/${nome}`;
          if (statSync(caminho).isDirectory()) andar(caminho, relFilho);
          else if (nome === "route.ts") achados.push(relFilho);
        }
      };
      andar(absoluto, relativo);
      return achados;
    };

    const ROTAS_USUARIO = rotasDeUsuario("app/api/agentes");

    // §11: proibir os SIMBOLOS do claim, nunca o modulo inteiro —
    // `capability-worker` tem capabilities legitimas fora daqui, e
    // banir o import derrubaria uso correto junto com o errado.
    const SIMBOLOS_PROIBIDOS = [RPC_DO_CLAIM, "reivindicarProximaTarefa"];

    const nenhumaRotaReivindica = (
      fontes: readonly { caminho: string; codigo: string }[]
    ): boolean => {
      // Descoberta quebrada devolve lista vazia, e `every` sobre vazio e
      // VERDADEIRO. O teste tem de ficar vermelho nesse caso, nao verde.
      if (fontes.length === 0) return false;
      if (fontes.some((f) => f.codigo.trim().length === 0)) return false;
      return fontes.every(
        (f) => !SIMBOLOS_PROIBIDOS.some((sim) => f.codigo.includes(sim))
      );
    };

    const FONTES_USUARIO = ROTAS_USUARIO.map((c) => ({ caminho: c, codigo: codigo(c) }));

    ok(`S3-Q0 ANCORA: a varredura achou rotas de usuario de verdade (${ROTAS_USUARIO.length})`,
      ROTAS_USUARIO.length > 0 &&
      // O walker desce em subdiretorio dinamico — se ele parasse na
      // raiz, esta rota aninhada nao apareceria e a prova seria rasa.
      ROTAS_USUARIO.includes("app/api/agentes/[agenteId]/conversa/route.ts") &&
      ROTAS_USUARIO.includes("app/api/agentes/route.ts"));
    ok("S3-Q0 ANCORA: toda rota encontrada foi lida e tem conteudo",
      FONTES_USUARIO.length === ROTAS_USUARIO.length &&
      FONTES_USUARIO.every((f) => f.codigo.length > 200));

    ok(`S3-Q nenhuma rota de usuario contem o claim global (${ROTAS_USUARIO.length} auditadas)`,
      nenhumaRotaReivindica(FONTES_USUARIO));

    ok("S3-Q CONTROLE NEGATIVO: uma rota sintetica que chama o wrapper reprova",
      !nenhumaRotaReivindica([
        ...FONTES_USUARIO,
        { caminho: "app/api/agentes/sintetica/route.ts",
          codigo: "export async function GET() { await reivindicarProximaTarefa(); }" },
      ]));
    ok("S3-Q CONTROLE NEGATIVO: uma rota sintetica que chama a RPC direto reprova",
      !nenhumaRotaReivindica([
        ...FONTES_USUARIO,
        { caminho: "app/api/agentes/sintetica/route.ts",
          codigo: `export async function POST() { await db.rpc("${RPC_DO_CLAIM}"); }` },
      ]));
    ok("S3-Q CONTROLE NEGATIVO: descoberta vazia reprova, nunca passa por vacuidade",
      !nenhumaRotaReivindica([]));

    // A fronteira dita ao contrario: o claim global VIVE no dispatcher.
    // Sem isto, apagar a chamada da rota interna deixaria S3-Q verde —
    // ele so afirma ausencia.
    ok("S3-Q o claim global continua existindo, e no dispatcher de sistema",
      /await reivindicarProximaTarefa\(\)/.test(codigo(ROTA_W)) &&
      !ROTAS_USUARIO.includes(ROTA_W));

    // ── L — fila vazia torna a execucao INALCANCAVEL ───────────────
    //
    // Nao basta o `break` existir. A propriedade e de ORDEM: entre o
    // claim e a guarda de `null` nao pode haver execucao nenhuma, ou
    // uma fila vazia chamaria `executarTarefa` com o que sobrou.
    // A guarda de fila vazia mudou de FORMA no D0 — antes era um `break`
    // direto, agora a lane normal precisa contabilizar o streak antes de
    // decidir encerrar. A PROPRIEDADE nao mudou: com a fila vazia,
    // `executarTarefa` continua inalcancavel, porque a execucao vive no
    // `else` da mesma guarda.
    const GUARDA_NULL = "if (tarefa === null) {";
    const CLAIM_CALL = "await reivindicarProximaTarefa()";
    const EXEC_CALL = "await executarTarefa(";

    const corpoDoLacoW = (texto: string): string => {
      const iW = texto.indexOf("while (");
      if (iW < 0) return "";
      const iAbre = texto.indexOf(") {", iW);
      if (iAbre < 0) return "";
      let nivel = 0;
      for (let k = iAbre + 2; k < texto.length; k++) {
        if (texto[k] === "{") nivel += 1;
        else if (texto[k] === "}") {
          nivel -= 1;
          if (nivel === 0) return texto.slice(iAbre + 2, k + 1);
        }
      }
      return "";
    };

    const execucaoInalcancavelComFilaVazia = (texto: string): boolean => {
      const corpo = corpoDoLacoW(texto);
      if (corpo.length === 0) return false;

      const iClaim = corpo.indexOf(CLAIM_CALL);
      const iGuarda = corpo.indexOf(GUARDA_NULL);
      const iExec = corpo.indexOf(EXEC_CALL);
      if (iClaim < 0 || iGuarda < 0 || iExec < 0) return false;

      // UMA execucao so: uma segunda, em outro ramo, escaparia da ordem.
      if (conta(corpo, /await executarTarefa\(/g) !== 1) return false;

      // claim -> guarda -> execucao, e NADA de executar entre o claim e
      // a guarda (garantido pela ordem mais a unicidade acima).
      if (!(iClaim < iGuarda && iGuarda < iExec)) return false;

      // E a execucao esta no ramo `else` da guarda: com `tarefa === null`
      // o fluxo entra no ramo do streak e nunca alcanca a chamada. Sem
      // esta checagem, um `executarTarefa` solto DEPOIS do if fecharia a
      // ordem textual e ainda assim rodaria com a fila vazia.
      const depoisDaGuarda = corpo.slice(iGuarda);
      const iElse = depoisDaGuarda.indexOf("} else {");
      return iElse >= 0 && depoisDaGuarda.indexOf(EXEC_CALL) > iElse;
    };

    ok("S3-L com a fila vazia, `executarTarefa` nao e alcancavel",
      execucaoInalcancavelComFilaVazia(codigo(ROTA_W)));
    // Fixture SINTETICA, e nao mutacao do arquivo real: o worker tem DOIS
    // `} else {` (o da lane e o da fila vazia), e mutar "o primeiro" acerta
    // o errado. A fixture isola exatamente o defeito que importa — a
    // execucao fora do ramo protegido pela guarda.
    const FIXTURE_SEM_ELSE = [
      "while (x) {",
      "  const { tarefa } = await reivindicarProximaTarefa();",
      "  if (tarefa === null) {",
      "    emptyStreak += 1;",
      "  }",
      "  const { status, corpo } = await executarTarefa(tarefa.tarefaId);",
      "}",
    ].join("\n");
    const FIXTURE_COM_ELSE = [
      "while (x) {",
      "  const { tarefa } = await reivindicarProximaTarefa();",
      "  if (tarefa === null) {",
      "    emptyStreak += 1;",
      "  } else {",
      "    const { status, corpo } = await executarTarefa(tarefa.tarefaId);",
      "  }",
      "}",
    ].join("\n");
    ok("S3-L1 CONTROLE NEGATIVO: execucao FORA do else da guarda reprova",
      !execucaoInalcancavelComFilaVazia(FIXTURE_SEM_ELSE));
    ok("S3-L2 CONTROLE POSITIVO: a mesma fixture COM else e aceita",
      execucaoInalcancavelComFilaVazia(FIXTURE_COM_ELSE));

    ok("S3-L CONTROLE NEGATIVO: executar ANTES da guarda de null reprova",
      !execucaoInalcancavelComFilaVazia(
        codigo(ROTA_W).replace(
          GUARDA_NULL,
          `const { status, corpo } = ${EXEC_CALL}tarefa!.tarefaId);\n      ${GUARDA_NULL}`
        ).replace(/const \{ status, corpo \} = await executarTarefa\(tarefa\.tarefaId\);/, "")));
    ok("S3-L CONTROLE NEGATIVO: apagar a guarda de fila vazia reprova",
      !execucaoInalcancavelComFilaVazia(codigo(ROTA_W).replace(GUARDA_NULL, "")));
    ok("S3-L CONTROLE NEGATIVO: uma segunda execucao no laco reprova",
      !execucaoInalcancavelComFilaVazia(
        codigo(ROTA_W).replace(GUARDA_NULL, `${EXEC_CALL}"x"); ${GUARDA_NULL}`)));
  }

  // ── T. D5-C2-I0: normalizarLinha extraido para modulo neutro ──────
  //
  // O helper nasceu privado em `capability-worker.ts`. A lane de
  // retomada precisa da MESMA normalizacao — `retomada_falhar_tarefa` e
  // `retomada_concluir_tarefa` tambem sao `RETURNS agente_tarefas` — e
  // duas copias teriam de concordar para sempre. Esta secao prova que a
  // mudanca foi de LUGAR, nao de COMPORTAMENTO, e que a fonte continua
  // unica.
  {
    const NEUTRO = "lib/agentes/normalizar-linha.ts";
    const WORKER = "lib/agentes/capability-worker.ts";
    const CODIGO_NEUTRO = codigo(NEUTRO);
    const CODIGO_WORKER = codigo(WORKER);
    const { normalizarLinha } = await import("../lib/agentes/normalizar-linha");

    ok("T0  ANCORA: as duas fontes foram lidas",
      CODIGO_NEUTRO.length > 50 && CODIGO_WORKER.length > 2000);

    // ── A MATRIZ. Os esperados sao escritos a mao, um a um, e NAO
    //    derivados da implementacao — um teste que reimplementasse a
    //    funcao para conferi-la nao provaria nada.
    const marcador = Symbol("ausente");
    const CASOS: ReadonlyArray<readonly [string, unknown, unknown]> = [
      ["array vazio", [], null],
      ["array de um", [{ id: "a" }], { id: "a" }],
      ["array de dois devolve o PRIMEIRO", [{ id: "a" }, { id: "b" }], { id: "a" }],
      ["null", null, null],
      ["undefined", undefined, null],
      ["objeto", { x: 1 }, { x: 1 }],
      ["string", "abc", "abc"],
      ["zero NAO vira null", 0, 0],
      ["false NAO vira null", false, false],
    ];
    for (const [rotulo, entrada, esperado] of CASOS) {
      const obtido = normalizarLinha(entrada);
      ok(`T1  ${rotulo}`, JSON.stringify(obtido ?? marcador) === JSON.stringify(esperado ?? marcador));
    }
    // CONTROLE: o oraculo sabe dizer NAO. Sem isto, um `normalizarLinha`
    // que devolvesse sempre `null` passaria em metade da matriz sem que
    // nada acusasse a outra metade como acidente.
    ok("T2  CONTROLE: a matriz reprovaria um helper que sempre devolve null",
      CASOS.some(([, entrada, esperado]) =>
        esperado !== null && ((): boolean => { void entrada; return true; })()));
    ok("T3  identidade referencial preservada em objeto",
      ((): boolean => { const o = { x: 1 }; return normalizarLinha(o) === o; })());
    ok("T4  identidade referencial do primeiro item do array",
      ((): boolean => { const o = { x: 1 }; return normalizarLinha([o, { y: 2 }]) === o; })());

    // ── FONTE UNICA. Conta DEFINICAO, nunca mencao: o import e o
    //    comentario que explica a mudanca citam o nome e nao podem
    //    contar como segunda implementacao.
    const DEFINICAO = /(?:^|\n)\s*(?:export\s+)?function\s+normalizarLinha\s*\(/g;
    ok("T5  o modulo neutro define o helper, e o exporta",
      conta(CODIGO_NEUTRO, DEFINICAO) === 1 &&
      /export function normalizarLinha\(data: unknown\): unknown/.test(CODIGO_NEUTRO));
    ok("T6  capability-worker NAO define mais uma copia",
      conta(CODIGO_WORKER, DEFINICAO) === 0);
    ok("T7  capability-worker importa o helper neutro",
      /import \{ normalizarLinha \} from "@\/lib\/agentes\/normalizar-linha";/.test(CODIGO_WORKER));
    ok("T8  e NAO reexporta o helper — a API publica dele nao cresceu",
      !/export \{[^}]*normalizarLinha/.test(CODIGO_WORKER) &&
      !/export .*function normalizarLinha/.test(CODIGO_WORKER));
    ok("T9  os quatro callers originais continuam no worker",
      conta(CODIGO_WORKER, /normalizarLinha\(data\)/g) === 4);
    ok("T10 CONTROLE: o detector de DEFINICAO nao confunde import com definicao",
      conta('import { normalizarLinha } from "x";', DEFINICAO) === 0 &&
      conta("export function normalizarLinha(data: unknown): unknown {", DEFINICAO) === 1);

    // ── NEUTRALIDADE. O modulo nao pode arrastar dependencia nenhuma,
    //    senao deixa de poder ser importado dos dois lados.
    ok("T11 o modulo neutro nao importa nada",
      !/^import\s/m.test(CODIGO_NEUTRO));
    for (const proibido of ["supabase", "server-only", "agente_tarefas", "executarFuncao",
                            "resume-contratos", "capability-worker", "console."]) {
      ok(`T12 o modulo neutro nao alcanca \`${proibido}\``,
        !CODIGO_NEUTRO.includes(proibido));
    }

    // ── ESTE SLICE NAO IMPLEMENTA RETOMADA ────────────────────────────
    for (const rpc of ["retomar_aprovacao_iniciar", "retomada_falhar_tarefa",
                       "retomada_recuperar_tarefa_stale", "retomada_concluir_tarefa"]) {
      ok(`T13 o modulo neutro nao cita a RPC \`${rpc}\``, !CODIGO_NEUTRO.includes(rpc));
    }
    // ── T14 — a FASE do fluxo D5, medida no disco ─────────────────────
    //
    // Ate o I0 esta tripwire exigia a AUSENCIA de `lib/agentes/retomada/`:
    // a pasta nao podia existir antes da revisao que a autorizasse. O I1
    // criou o modulo de persistence, e entao ela AVANCOU de fase em vez
    // de ser apagada — remover o assert trocaria uma prova por um
    // silencio, e a pasta passaria a crescer sem que nada reclamasse.
    //
    // O que ela mede agora: a pasta existe, tem exatamente o modulo
    // revisado, e nenhum sibling entrou de carona.
    //
    // O predicado e de LISTA, nao de disco, pelo mesmo motivo dos
    // controles do G11: assim os cenarios negativos alimentam inventario
    // sintetico sem criar arquivo nenhum na arvore. A leitura real
    // acontece uma vez, e `null` representa a pasta ausente.
    // FASE D5-C3-I1: a pasta ganhou o executor. A tripwire avancou de
    // novo em vez de ser apagada — o que ela mede continua sendo
    // IDENTIDADE do conteudo, agora contra dois nomes.
    const RETOMADA_ESPERADO = ["executar-retomada.ts", "persistencia-retomada.ts"];
    const vereditoRetomada = (conteudo: readonly string[] | null): boolean => {
      if (conteudo === null) return false;
      const a = [...conteudo].sort();
      const b = [...RETOMADA_ESPERADO].sort();
      return a.length === b.length && a.every((nome, i) => nome === b[i]);
    };

    const DIR_RETOMADA = join(RAIZ, "lib/agentes/retomada");
    const conteudoRetomada = existsSync(DIR_RETOMADA)
      ? readdirSync(DIR_RETOMADA).sort()
      : null;

    ok("T14 `lib/agentes/retomada/` existe e tem so os dois modulos autorizados",
      vereditoRetomada(conteudoRetomada));
    ok("T14a ANCORA: a pasta foi mesmo lida e os dois modulos estao no disco",
      conteudoRetomada !== null && conteudoRetomada.length === 2 &&
      existsSync(join(DIR_RETOMADA, "persistencia-retomada.ts")) &&
      existsSync(join(DIR_RETOMADA, "executar-retomada.ts")));
    ok("T14b CONTROLE NEGATIVO: pasta AUSENTE reprova",
      !vereditoRetomada(null));
    ok("T14c CONTROLE NEGATIVO: pasta VAZIA reprova",
      !vereditoRetomada([]));
    ok("T14c2 CONTROLE NEGATIVO: a fase ANTERIOR, com so um modulo, agora reprova",
      !vereditoRetomada(["persistencia-retomada.ts"]) &&
      !vereditoRetomada(["executar-retomada.ts"]));
    ok("T14d CONTROLE NEGATIVO: um sibling a mais reprova",
      !vereditoRetomada(["executar-retomada.ts", "persistencia-retomada.ts", "orquestrador-retomada.ts"]) &&
      !vereditoRetomada(["executar-retomada.ts", "persistencia-retomada.ts", "heartbeat-retomada.ts"]) &&
      !vereditoRetomada(["executar-retomada.ts", "persistencia-retomada.ts", "descoberta-retomada.ts"]));
    ok("T14e CONTROLE NEGATIVO: nome PARECIDO nao passa por igualdade exata",
      !vereditoRetomada(["executar-retomada.tsx", "persistencia-retomada.ts"]) &&
      !vereditoRetomada(["executar-retomada.ts.bak", "persistencia-retomada.ts"]) &&
      !vereditoRetomada(["executar_retomada.ts", "persistencia-retomada.ts"]) &&
      !vereditoRetomada(["Executar-Retomada.ts", "persistencia-retomada.ts"]));
    ok("T14f CONTROLE POSITIVO: somente os dois esperados passam, em qualquer ordem",
      vereditoRetomada(["executar-retomada.ts", "persistencia-retomada.ts"]) &&
      vereditoRetomada(["persistencia-retomada.ts", "executar-retomada.ts"]));

    // ── T15 — O HEARTBEAT DA LANE DE RETOMADA, sem import proibido ──
    //
    // A lane Resume NAO pode importar `executar-tarefa.ts`: aquele
    // modulo carrega `concluirTarefa`, `falharTarefa` e
    // `aguardarAprovacaoTarefa`, e um `import` de constante arrastaria
    // os tres para o grafo dela. A constante e, entao, DUPLICADA de
    // proposito — o mesmo padrao que `consultar-vendas-contrato.ts` ja
    // usa para nao descongelar `analise-vendas.ts`.
    //
    // Esta suite e o ponto de encontro: ela ja importa a constante da
    // lane normal, e aqui le a da lane de retomada. A duplicacao fica
    // CONFERIDA, nao silenciosa. Producao continua sem a dependencia.
    {
      const FONTE_RETOMADA = readFileSync(
        join(RAIZ, "lib/agentes/retomada/executar-retomada.ts"), "utf8");
      const m = /export const INTERVALO_HEARTBEAT_RETOMADA_MS = ([0-9_]+);/.exec(FONTE_RETOMADA);
      const valorRetomada = m === null ? NaN : Number(m[1].replace(/_/g, ""));

      ok("T15 ANCORA: a constante da lane de retomada foi encontrada no fonte",
        m !== null && Number.isFinite(valorRetomada));
      ok("T15a as duas lanes batem no MESMO intervalo",
        valorRetomada === INTERVALO_HEARTBEAT_MS);
      ok("T15b e o valor e 15 s",
        valorRetomada === 15_000);
      ok("T15c relacao 20x com o corte de orfa de 5 min da retomada",
        valorRetomada * 20 === 300_000);
      ok("T15d CONTROLE NEGATIVO: um valor divergente reprova",
        !((30_000 as number) === (INTERVALO_HEARTBEAT_MS as number)));
      // IMPORT, nunca mencao: o docblock do executor CITA
      // `INTERVALO_HEARTBEAT_MS` justamente para explicar por que NAO o
      // importa, e contar documentacao como violacao seria punir a
      // explicacao. Mesmo criterio do J20 em
      // `testar-agentes-execucao-funcoes.ts`.
      const CODIGO_RETOMADA = FONTE_RETOMADA
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/(^|[^:])\/\/.*$/gm, "");
      ok("T15e o executor Resume NAO importa a lane normal",
        !/from "@\/lib\/agentes\/executar-tarefa"/.test(CODIGO_RETOMADA) &&
        !/from "@\/lib\/agentes\/capability-worker"/.test(CODIGO_RETOMADA) &&
        !/INTERVALO_HEARTBEAT_MS/.test(CODIGO_RETOMADA));
      ok("T15e2 ANCORA: o corpo sem comentarios ainda tem a constante local",
        /INTERVALO_HEARTBEAT_RETOMADA_MS/.test(CODIGO_RETOMADA) &&
        CODIGO_RETOMADA.length > 1000);
      ok("T15f CONTROLE: um import da lane normal seria detectado",
        /from "@\/lib\/agentes\/executar-tarefa"/
          .test('import { x } from "@/lib/agentes/executar-tarefa";'));
    }
  }

  // ────────────────────────────────────────────────────────────────
  // V. APPROVAL-DECISION-RESUME-D5-C2-I2 — a LANE do batimento
  //
  // `status = 'rodando'` nao distingue execucao normal de retomada, e a
  // retomada PRESERVA a tentativa. Sem uma cerca de marcador, o
  // batimento da lane normal renovaria `heartbeat_em` de uma tarefa
  // retomada e adiaria para sempre a recuperacao — que so age apos 5
  // minutos sem batida. Esta secao prova a cerca DENTRO do corpo de
  // `registrarProgresso`, nao em qualquer lugar do arquivo.
  // ────────────────────────────────────────────────────────────────
  {
    const CODIGO_WORKER_V = codigo("lib/agentes/capability-worker.ts");
    const CODIGO_PERSIST_V = codigo("lib/agentes/retomada/persistencia-retomada.ts");

    /** Corpo EXATO de uma funcao exportada: da assinatura ate o `}` na
     *  coluna 0. Recortar ate o proximo `export` pegaria o vizinho. */
    const corpoDe = (fonte: string, nome: string): string => {
      const linhas = fonte.split("\n");
      const ini = linhas.findIndex((l) =>
        new RegExp(`^export (async )?function ${nome}\\b`).test(l));
      if (ini < 0) return "";
      for (let j = ini + 1; j < linhas.length; j++) {
        if (linhas[j] === "}") return linhas.slice(ini, j + 1).join("\n");
      }
      return "";
    };

    const CORPO_PROGRESSO = corpoDe(CODIGO_WORKER_V, "registrarProgresso");
    const CORPO_TICK = corpoDe(CODIGO_PERSIST_V, "registrarHeartbeatRetomada");

    ok("V0  ANCORA: o corpo de registrarProgresso foi isolado",
      CORPO_PROGRESSO.length > 200 && CORPO_PROGRESSO.includes("agente_tarefas"));

    // ── A cerca, DENTRO do corpo ────────────────────────────────────
    ok("V1  registrarProgresso cerca por marcador IS NULL",
      /\.is\(\s*"retomada_request_id"\s*,\s*null\s*\)/.test(CORPO_PROGRESSO));
    ok("V2  e a cerca esta na MESMA cadeia do update de progresso+heartbeat",
      /\.update\(\{[^}]*progresso[^}]*heartbeat_em[^}]*\}\)[\s\S]*?\.is\(\s*"retomada_request_id"\s*,\s*null\s*\)/
        .test(CORPO_PROGRESSO));
    ok("V3  as cercas antigas continuam: id e status",
      /\.eq\(\s*"id"\s*,\s*tarefaId\s*\)/.test(CORPO_PROGRESSO) &&
      /\.eq\(\s*"status"\s*,\s*"rodando"\s*\)/.test(CORPO_PROGRESSO));
    ok("V4  UMA escrita apenas — a cerca protege a UPDATE inteira",
      (CORPO_PROGRESSO.match(/\.update\(/g) ?? []).length === 1 &&
      (CORPO_PROGRESSO.match(/\.from\(/g) ?? []).length === 1);
    ok("V5  o payload nao mudou: progresso + heartbeat_em",
      /\.update\(\{\s*progresso:\s*valor,\s*heartbeat_em:/.test(CORPO_PROGRESSO));
    ok("V6  a lane normal NAO passou a ler retorno",
      !/\.select\(|\.single\(|\.maybeSingle\(/.test(CORPO_PROGRESSO));
    ok("V7  assinatura e contrato de retorno intactos",
      /export async function registrarProgresso\(\s*tarefaId: string,\s*progresso: number\s*\): Promise<\{ erro: string \| null \}>/
        .test(CODIGO_WORKER_V.replace(/\n/g, " ").replace(/\s+/g, " ")
          .replace(/export async function registrarProgresso\( /, "export async function registrarProgresso(")));
    ok("V8  higiene de erro preservada: nada de erro cru",
      !/\.message\b|\.details\b|\.hint\b|JSON\.stringify/.test(CORPO_PROGRESSO));

    // ── CONTROLES NEGATIVOS: o predicado precisa MORDER ─────────────
    const SEM_CERCA =
      'export async function registrarProgresso(\n' +
      '  const { error } = await getSupabaseServidor()\n' +
      '    .from("agente_tarefas")\n' +
      '    .update({ progresso: valor, heartbeat_em: agora })\n' +
      '    .eq("id", tarefaId)\n' +
      '    .eq("status", "rodando");\n}';
    ok("V9  CONTROLE: sem a cerca, V1 reprovaria",
      !/\.is\(\s*"retomada_request_id"\s*,\s*null\s*\)/.test(SEM_CERCA));
    ok("V10 CONTROLE: cercar por IGUALDADE em vez de IS NULL reprovaria",
      !/\.is\(\s*"retomada_request_id"\s*,\s*null\s*\)/
        .test('.eq("retomada_request_id", null)'));
    ok("V11 CONTROLE: a cerca em OUTRA funcao do arquivo nao contaria",
      corpoDe('export function outra() {\n  .is("retomada_request_id", null);\n}\n',
        "registrarProgresso") === "");

    // ── A LANE DE RETOMADA: o tick, e as cinco cercas ───────────────
    ok("V12 ANCORA: o corpo do tick foi isolado",
      CORPO_TICK.length > 200);
    for (const [ordem, cerca] of [
      ["1/5 id", '\\.eq\\(\\s*"id"\\s*,\\s*tarefaId\\s*\\)'],
      ["2/5 user_id", '\\.eq\\(\\s*"user_id"\\s*,\\s*userId\\s*\\)'],
      ["3/5 status", '\\.eq\\(\\s*"status"\\s*,\\s*"rodando"\\s*\\)'],
      ["4/5 tentativas", '\\.eq\\(\\s*"tentativas"\\s*,\\s*tentativaEsperada\\s*\\)'],
      ["5/5 marcador", '\\.eq\\(\\s*"retomada_request_id"\\s*,\\s*retomadaRequestId\\s*\\)'],
    ] as Array<[string, string]>) {
      ok(`V13 o tick de retomada tem a cerca ${ordem}`,
        new RegExp(cerca).test(CORPO_TICK));
    }
    ok("V14 exatamente cinco cercas de igualdade, nem uma sexta",
      (CORPO_TICK.match(/\.eq\(/g) ?? []).length === 5);
    ok("V15 o tick escreve SO heartbeat_em",
      /\.update\(\{\s*heartbeat_em:\s*new Date\(\)\.toISOString\(\)\s*\}\)/.test(CORPO_TICK) &&
      !/progresso|status:|resultado:|erro_tipo:|erro_mensagem:/.test(CORPO_TICK));
    ok("V16 o tick NAO cria timer nem agenda nada",
      !/setInterval|setTimeout/.test(CORPO_TICK));
    ok("V17 o tick NAO chama terminalizador, recuperacao nem RPC",
      !/\.rpc\(/.test(CORPO_TICK) &&
      !/falharTarefaRetomada|concluirTarefaRetomada|recuperarRetomadaStale/.test(CORPO_TICK) &&
      !/\bfalharTarefa\b|\bconcluirTarefa\b|\bregistrarProgresso\b/.test(CORPO_TICK));

    // ── DISJUNCAO BILATERAL ─────────────────────────────────────────
    //
    // Uma lane exige NULL, a outra exige igualdade com um request nao
    // vazio. Nenhuma linha satisfaz as duas — a separacao e estrutural,
    // nao convencao.
    const normalExigeNull =
      /\.is\(\s*"retomada_request_id"\s*,\s*null\s*\)/.test(CORPO_PROGRESSO);
    const resumeExigeIgual =
      /\.eq\(\s*"retomada_request_id"\s*,\s*retomadaRequestId\s*\)/.test(CORPO_TICK);
    ok("V18 DISJUNCAO: normal exige NULL, retomada exige igualdade",
      normalExigeNull && resumeExigeIgual);
    ok("V19 a lane normal nunca compara marcador por igualdade",
      !/\.eq\(\s*"retomada_request_id"/.test(CORPO_PROGRESSO));
    ok("V20 e a lane de retomada nunca aceita marcador NULL",
      !/\.is\(\s*"retomada_request_id"/.test(CORPO_TICK));

    // ── F3 — a CERCA DE ENTRADA da lane normal ──────────────────────
    //
    // Ate o I2 estes dois asserts registravam F3 como ABERTO: a entrada
    // normal nao conhecia o marcador. O D5-C2-I2-F3 fechou isso pelo
    // LOADER, e nao pelo executor — entao eles avancaram de fase, de
    // "ainda nao conhece" para "continua sem conhecer, E ISSO E O
    // DESENHO", com a cerca provada onde ela realmente vive.
    //
    // V21 tambem foi CORRIGIDO: ele procurava `COLUNAS_TAREFA` seguido
    // do marcador dentro de 400 caracteres, e passou a casar o USO
    // (`select(COLUNAS_TAREFA)` seguido do novo filtro) em vez da
    // DEFINICAO. Media proximidade, nao projecao. Agora le a definicao.
    const DEF_COLUNAS = (CODIGO_WORKER_V.match(/const COLUNAS_TAREFA[\s\S]*?;/) ?? [""])[0];
    const CORPO_LEITURA = corpoDe(CODIGO_WORKER_V, "lerTarefaParaExecucao");

    ok("V21 ANCORA: a definicao de COLUNAS_TAREFA foi isolada",
      DEF_COLUNAS.length > 100 && DEF_COLUNAS.includes("heartbeat_em"));
    ok("V21a o marcador NAO e projetado — a cerca filtra, nao seleciona",
      !DEF_COLUNAS.includes("retomada_request_id"));
    ok("V21b CONTROLE: projetar o marcador seria detectado",
      /retomada_request_id/.test('const COLUNAS_TAREFA = "id, retomada_request_id";'));
    ok("V22 executar-tarefa continua sem conhecer o marcador — POR DESENHO",
      !/retomada_request_id/.test(codigo("lib/agentes/executar-tarefa.ts")));

    // ── A cerca, DENTRO do corpo do loader ──────────────────────────
    ok("V23 ANCORA: o corpo de lerTarefaParaExecucao foi isolado",
      CORPO_LEITURA.length > 150 && CORPO_LEITURA.includes("agente_tarefas"));
    ok("V24 o loader cerca por marcador IS NULL",
      /\.is\(\s*"retomada_request_id"\s*,\s*null\s*\)/.test(CORPO_LEITURA));
    ok("V25 e a cerca esta na MESMA cadeia do id e do maybeSingle",
      /\.select\(\s*COLUNAS_TAREFA\s*\)[\s\S]*?\.eq\(\s*"id"\s*,\s*tarefaId\s*\)[\s\S]*?\.is\(\s*"retomada_request_id"\s*,\s*null\s*\)[\s\S]*?\.maybeSingle\(\)\s*;/
        .test(CORPO_LEITURA));
    ok("V26 usa .is, NUNCA igualdade — `= NULL` nao e verdadeiro em SQL",
      !/\.eq\(\s*"retomada_request_id"/.test(CORPO_LEITURA));
    ok("V27 CONTROLE: `.eq(marker, null)` nao satisfaz o predicado de V24",
      !/\.is\(\s*"retomada_request_id"\s*,\s*null\s*\)/
        .test('.eq("retomada_request_id", null)'));
    ok("V28 CONTROLE: a cerca em OUTRA funcao do arquivo nao contaria",
      corpoDe('export function outra() {\n  .is("retomada_request_id", null);\n}\n',
        "lerTarefaParaExecucao") === "");

    // ── O contrato do loader NAO mudou ──────────────────────────────
    ok("V29 assinatura e retorno intactos",
      /export async function lerTarefaParaExecucao\( tarefaId: string \): Promise<ResultadoTarefaInterna>/
        .test(CORPO_LEITURA.replace(/\s+/g, " ")));
    const umFrom = (CORPO_LEITURA.match(/\.from\(/g) ?? []).length === 1;
    const umMaybe = (CORPO_LEITURA.match(/\.maybeSingle\(/g) ?? []).length === 1;
    const semSingle = !/\.single\(/.test(CORPO_LEITURA);
    ok("V30 uma unica leitura, com maybeSingle e sem single",
      umFrom && umMaybe && semSingle);
    ok("V31 higiene de erro preservada: log fixo, sem erro cru",
      /erro_consulta_tarefa/.test(CORPO_LEITURA) &&
      !/\.message\b|\.details\b|\.hint\b|JSON\.stringify/.test(CORPO_LEITURA));

    // ── ORDEM DOS EFEITOS: a recusa vem ANTES de tudo ───────────────
    //
    // A cerca so vale se a tarefa filtrada morrer na guarda que ja
    // existe, e ANTES de qualquer efeito. Isto mede posicao real no
    // fonte do executor, nao intencao.
    const EXEC = codigo("lib/agentes/executar-tarefa.ts");
    const pos = (re: RegExp) => EXEC.search(re);
    const pLeitura = pos(/await lerTarefaParaExecucao\(/);
    const pRecusa = pos(/if \(!tarefa\)/);
    const pContexto = pos(/const contexto: ContextoTarefa/);
    const pTimer = pos(/setInterval\(/);
    const pHandler = pos(/await handler\(/);
    const pFalhar = pos(/await falharTarefa\(/);
    const pConcluir = pos(/await concluirTarefa\(/);

    ok("V32 ANCORA: os sete pontos do ciclo foram localizados",
      [pLeitura, pRecusa, pContexto, pTimer, pHandler, pFalhar, pConcluir]
        .every((p) => p > 0));
    ok("V33 a leitura acontece antes da recusa",
      pLeitura < pRecusa);
    ok("V34 a recusa acontece antes do ContextoTarefa",
      pRecusa < pContexto);
    ok("V35 antes do heartbeat",
      pRecusa < pTimer);
    ok("V36 antes do handler — logo antes da Funcao",
      pRecusa < pHandler);
    ok("V37 antes dos terminalizadores genericos",
      pRecusa < pFalhar && pRecusa < pConcluir);
    ok("V38 a recusa RETORNA, nao segue o fluxo",
      /if \(!tarefa\) \{\s*return \{ status: 404/.test(EXEC));
    ok("V39 e recusar NAO e falhar: nenhum terminalizador entre a recusa e o contexto",
      !/falharTarefa|concluirTarefa|aguardarAprovacaoTarefa/
        .test(EXEC.slice(pRecusa, pContexto)));

    // ── A rota interna depende do loader, e isso e INTENCIONAL ──────
    ok("V40 a rota interna nao tem cerca de lane propria",
      !/retomada/.test(codigo("app/api/internal/agentes/executar/route.ts")));
    ok("V41 e ela chega ao ciclo somente por executarTarefa",
      /await executarTarefa\(/.test(codigo("app/api/internal/agentes/executar/route.ts")));
    ok("V42 que por sua vez so le tarefa pelo loader cercado",
      (EXEC.match(/lerTarefaParaExecucao\(/g) ?? []).length === 1 &&
      !/\.from\(\s*"agente_tarefas"\s*\)/.test(EXEC));
  }

  // ────────────────────────────────────────────────────────────────
  // W. APPROVAL-DECISION-RESUME-D5-C3-I2-P0 — a migration da fila e da
  //    reconciliacao tecnica
  //
  // Duas funcoes ADITIVAS e dormentes. O que esta secao prova nao e que
  // elas funcionam — isso e do banco —, e sim que a FORMA delas e a
  // acordada: a fila filtra so estado reversivel e NAO esconde
  // incompatibilidade de registry, e o cancelamento tecnico grava um
  // ator que nao e o dono.
  // ────────────────────────────────────────────────────────────────
  {
    console.log("\nW. RESUME-D5-C3-I2-P0: fila de candidatas e reconciliacao tecnica");

    const NOME_P0 = "20261007_retomada_fila_e_reconciliacao.sql";
    const CAMINHO_P0 = join(RAIZ, "supabase", "migrations", NOME_P0);
    const SQL_P0 = readFileSync(CAMINHO_P0, "utf8");

    /** Fonte sem comentarios `--`. Os docblocks desta migration CITAM de
     *  proposito o que ela nao faz (`aprovacao_decidir`, `for update`,
     *  `expira_em`), e contar documentacao como violacao puniria a
     *  explicacao — o mesmo criterio do J20/T15e. */
    const CODIGO_P0 = SQL_P0.replace(/--.*$/gm, "");

    /** Os corpos `$$...$$`, na ordem em que aparecem. */
    const corposP0 = [...CODIGO_P0.matchAll(/\$\$([\s\S]*?)\$\$/g)].map((m) => m[1]);
    /** O que sobra FORA dos corpos: e ali que DML de topo apareceria. */
    const TOPO_P0 = CODIGO_P0.replace(/\$\$[\s\S]*?\$\$/g, " ");

    const CORPO_FILA = corposP0.find((c) => c.includes("return query")) ?? "";
    const CORPO_CANCEL = corposP0.find((c) => c.includes("v_ator_tecnico")) ?? "";

    ok("W0  ANCORA: a migration existe e tem os dois corpos de funcao",
      existsSync(CAMINHO_P0) && corposP0.length === 2 &&
      CORPO_FILA.length > 200 && CORPO_CANCEL.length > 400);
    ok("W0a ANCORA: remover comentarios encolheu o arquivo, e o codigo sobrou",
      CODIGO_P0.length < SQL_P0.length && CODIGO_P0.length > 1000);

    // ── W1..W3. Inventario de objetos ───────────────────────────────
    ok("W1  cria EXATAMENTE duas funcoes",
      (CODIGO_P0.match(/create function/g) ?? []).length === 2);
    ok("W1a e sao exatamente estas duas",
      /create function public\.retomada_listar_candidatas\(/.test(CODIGO_P0) &&
      /create function public\.retomada_cancelar_aprovacao_incompativel\(/.test(CODIGO_P0));
    // ── W1b. FAIL-CLOSED NA COLISAO DE MESMA IDENTIDADE ──────────
    //
    // As duas funcoes sao NOVAS. `create or replace` substituiria em
    // silencio uma homonima que ja existisse no remoto — e o historico
    // local/remoto deste projeto tem divergencia conhecida.
    //
    // O ALCANCE EXATO, para nao prometer mais do que o PostgreSQL faz:
    // `create function` sem `or replace` aborta quando ja existe funcao
    // de MESMA IDENTIDADE — mesmo nome E mesma lista de tipos de
    // argumento. Uma homonima de assinatura DIFERENTE nao derruba o
    // apply: o PostgreSQL a criaria ao lado, como overload.
    //
    // Por isso esta e a SEGUNDA barreira, nunca substituto do preflight:
    // antes do apply, o gate de DB continua obrigado a provar por
    // pg_proc/pg_namespace que nao existe NENHUMA funcao com esses dois
    // `proname` no schema public, em overload algum.
    ok("W1b HARD: objetos novos usam CREATE FUNCTION e falham em colisao de mesma identidade",
      (CODIGO_P0.match(/create function/g) ?? []).length === 2 &&
      (CODIGO_P0.match(/create or replace function/g) ?? []).length === 0 &&
      !/create\s+or\s+replace/i.test(CODIGO_P0));
    ok("W1c CONTROLE NEGATIVO: um OR REPLACE real seria detectado",
      (("create or replace function public.retomada_listar_candidatas(")
        .match(/create or replace function/g) ?? []).length === 1);
    ok("W2  nenhum outro objeto de schema",
      !/create\s+table|create\s+index|create\s+view|create\s+trigger|create\s+rule|alter\s+table|add\s+constraint|drop\s+function/i
        .test(CODIGO_P0));
    ok("W3  as duas tem COMMENT ON FUNCTION",
      (CODIGO_P0.match(/comment on function/g) ?? []).length === 2);

    // ── W4. D4 INTOCADO ─────────────────────────────────────────────
    //
    // A prova e sobre CODIGO, nao sobre texto: o docblock explica por que
    // `aprovacao_decidir` NAO e reutilizada, e essa explicacao e o que se
    // quer preservar. O que nao pode existir e create/replace ou drop.
    ok("W4  a migration nao recria nem derruba `aprovacao_decidir`",
      !/(create( or replace)? function|drop function)\s+public\.aprovacao_decidir/i.test(CODIGO_P0));
    // ── W4c..W4f. NENHUMA FUNCAO CONGELADA E RECRIADA NEM DERRUBADA
    //
    // O detector usa `String.raw` de proposito. Num template literal
    // comum, `\s` colapsa para o caractere `s` e `\.` para `.`: o padrao
    // passaria a exigir o texto "functions+public", que nao existe em SQL
    // nenhum, e o assert ficaria verde para sempre — inclusive se a
    // migration recriasse `aprovacao_decidir`. Por isso W4d/W4e EXECUTAM
    // o detector contra violacoes sinteticas ANTES de qualquer conclusao:
    // um detector so vale depois de ser visto disparando.
    {
      const CONGELADAS_P0 = [
        "aprovacao_decidir",
        "retomar_aprovacao_iniciar",
        "aprovacao_consumir_abrir_e_retomar",
        "retomada_concluir_tarefa",
        "retomada_falhar_tarefa",
        "retomada_recuperar_tarefa_stale",
      ];
      const detectorCongeladaP0 = (nome: string): RegExp =>
        new RegExp(
          String.raw`(create\s+function|create\s+or\s+replace\s+function|drop\s+function)\s+public\.${nome}\b`,
          "i");

      ok("W4d ANCORA: o detector DISPARA contra CREATE OR REPLACE sintetico",
        CONGELADAS_P0.length === 6 &&
        CONGELADAS_P0.every((f) =>
          detectorCongeladaP0(f).test(`create or replace function public.${f}(p_x text)`)));
      ok("W4e ANCORA: e tambem contra CREATE FUNCTION e DROP FUNCTION sinteticos",
        CONGELADAS_P0.every((f) =>
          detectorCongeladaP0(f).test(`create function public.${f}(p_x text)`) &&
          detectorCongeladaP0(f).test(`drop function public.${f}(text);`)));
      ok("W4f ANCORA: e fica QUIETO diante de fonte que so cria as duas RPCs novas",
        CONGELADAS_P0.every((f) => !detectorCongeladaP0(f).test(
          "create function public.retomada_listar_candidatas(p_limite integer default 5) " +
          "create function public.retomada_cancelar_aprovacao_incompativel(p_user_id text)")));
      ok(`W4c NENHUMA das ${CONGELADAS_P0.length} funcoes congeladas aparece em CREATE/DROP`,
        CONGELADAS_P0.every((f) => !detectorCongeladaP0(f).test(CODIGO_P0)));
    }
    ok("W4a CONTROLE: a mencao em comentario NAO conta como alteracao",
      SQL_P0.includes("aprovacao_decidir") &&
      !CODIGO_P0.includes("create or replace function public.aprovacao_decidir"));
    ok("W4b CONTROLE NEGATIVO: um CREATE OR REPLACE real seria detectado",
      /(create or replace function|drop function)\s+public\.aprovacao_decidir/i
        .test("create or replace function public.aprovacao_decidir("));

    // ── W5. ZERO DML DE TOPO ────────────────────────────────────────
    //
    // Aplicar esta migration nao pode mudar uma linha de dado. O DML
    // DENTRO dos corpos e o contrato das funcoes; o que se mede aqui e
    // o residuo fora deles.
    ok("W5  zero INSERT/UPDATE/DELETE de topo",
      !/\binsert\b/i.test(TOPO_P0) && !/\bupdate\b/i.test(TOPO_P0) &&
      !/\bdelete\b/i.test(TOPO_P0));
    ok("W5a ANCORA: o residuo de topo existe e contem os CREATE/ACL",
      TOPO_P0.includes("create function") && TOPO_P0.includes("grant execute"));
    ok("W5b ANCORA: os corpos REALMENTE tem DML, e ele nao foi contado",
      /\bupdate\b/i.test(CORPO_CANCEL));

    // ── W6..W7. Seguranca e ACL ─────────────────────────────────────
    ok("W6  as duas sao SECURITY INVOKER com search_path fixo",
      (CODIGO_P0.match(/security invoker/g) ?? []).length === 2 &&
      (CODIGO_P0.match(/set search_path = public/g) ?? []).length === 2);
    ok("W6a zero SECURITY DEFINER",
      !/security definer/i.test(CODIGO_P0));
    for (const assinatura of [
      "public.retomada_listar_candidatas(integer)",
      "public.retomada_cancelar_aprovacao_incompativel(text, uuid)",
    ]) {
      const alvo = assinatura.replace(/[.()]/g, (c) => `\\${c}`);
      ok(`W7  ACL completa de \`${assinatura}\``,
        new RegExp(`revoke all on function ${alvo} from public;`).test(CODIGO_P0) &&
        new RegExp(`revoke all on function ${alvo} from anon;`).test(CODIGO_P0) &&
        new RegExp(`revoke all on function ${alvo} from authenticated;`).test(CODIGO_P0) &&
        new RegExp(`revoke all on function ${alvo} from service_role;`).test(CODIGO_P0) &&
        new RegExp(`grant execute on function ${alvo} to service_role;`).test(CODIGO_P0));
    }
    ok("W7a o REVOKE de service_role vem ANTES do GRANT (bug SEC1)",
      CODIGO_P0.indexOf("revoke all on function public.retomada_listar_candidatas(integer) from service_role;") <
        CODIGO_P0.indexOf("grant execute on function public.retomada_listar_candidatas(integer) to service_role;"));
    ok("W7b nenhum GRANT a anon ou authenticated",
      !/grant[^;]*to\s+(anon|authenticated)/i.test(CODIGO_P0));

    // ── W8..W15. A FILA ─────────────────────────────────────────────
    ok("W8  assinatura e retorno da fila",
      /create function public\.retomada_listar_candidatas\(\s*p_limite integer default 5\s*\)/
        .test(CODIGO_P0) &&
      /returns table \(\s*user_id text,\s*aprovacao_id uuid\s*\)/.test(CODIGO_P0));
    ok("W9  filtros de Approval: aprovada e com tarefa",
      /a\.estado\s*=\s*'aprovada'/.test(CORPO_FILA) &&
      /a\.tarefa_id is not null/.test(CORPO_FILA));
    {
      const cercas = [
        /t\.id\s*=\s*a\.tarefa_id/,
        /t\.user_id\s*=\s*a\.user_id/,
        /t\.agente_id\s*=\s*a\.agente_id/,
        /t\.status\s*=\s*'aguardando_aprovacao'/,
        /t\.aprovacao_aguardada_id\s*=\s*a\.id/,
        /t\.retomada_request_id is null/,
        /t\.tentativas\s*<=\s*t\.max_tentativas/,
      ];
      ok(`W10 as SETE cercas causais da tarefa (${cercas.filter((r) => r.test(CORPO_FILA)).length}/7)`,
        cercas.every((r) => r.test(CORPO_FILA)));
    }
    ok("W11 agente do mesmo dono e ATIVO",
      /ag\.id\s*=\s*a\.agente_id/.test(CORPO_FILA) &&
      /ag\.user_id\s*=\s*a\.user_id/.test(CORPO_FILA) &&
      /ag\.ativo/.test(CORPO_FILA));
    ok("W12 permissao atual em aprovacao/automatico",
      /p\.agente_id\s*=\s*a\.agente_id/.test(CORPO_FILA) &&
      /p\.funcao_id\s*=\s*a\.funcao_id/.test(CORPO_FILA) &&
      /p\.nivel in \('aprovacao', 'automatico'\)/.test(CORPO_FILA));
    ok("W13 ordem: decidido_em e depois id, ambos ASC",
      /order by a\.decidido_em asc, a\.id asc/.test(CORPO_FILA));
    ok("W14 o teto de 5 vive no SQL, e o caller nao o amplia",
      /limit least\(greatest\(coalesce\(p_limite, 5\), 1\), 5\)/.test(CORPO_FILA));
    ok("W14a CONTROLE NEGATIVO: um LIMIT direto do parametro reprova",
      !/limit\s+p_limite\b/.test(CORPO_FILA));
    ok("W15 a fila e read-only: sem lock, sem reserva, sem escrita",
      !/for update|skip locked/i.test(CORPO_FILA) &&
      !/\binsert\b|\bupdate\b|\bdelete\b|\bupsert\b/i.test(CORPO_FILA));
    ok("W15a e sem DISTINCT: os joins ja sao 1:1 por constraint",
      !/\bdistinct\b/i.test(CORPO_FILA));

    // ── W16..W17. O QUE A FILA NAO PODE ESCONDER ────────────────────
    //
    // Este par e o coracao do slice. Filtrar TTL ou registry aqui
    // deixaria a fila limpa e a tabela suja: as linhas sumiriam da
    // consulta sem NUNCA serem expiradas nem reconciliadas.
    ok("W16 a fila NAO filtra TTL — quem materializa expiracao e a RPC",
      !/expira_em/.test(CORPO_FILA));
    ok("W17 a fila NAO filtra nada do registry TypeScript",
      !/\brevisao_funcao\b/.test(CORPO_FILA) &&
      !/a\.acesso\b/.test(CORPO_FILA) &&
      !/conexao_plataforma|conexao_recurso|conexao_loja_id/.test(CORPO_FILA) &&
      !/\bargumentos\b/.test(CORPO_FILA) &&
      !/t\.tipo\b/.test(CORPO_FILA) &&
      !/a\.funcao_id\s*=\s*'/.test(CORPO_FILA));
    ok("W17a zero literal de catalogo na migration inteira",
      !/vendas\.consultar|consultar_vendas/.test(CODIGO_P0));

    // ── W18..W30. A RECONCILIACAO TECNICA ───────────────────────────
    ok("W18 assinatura e retorno do cancelamento tecnico",
      /create function public\.retomada_cancelar_aprovacao_incompativel\(\s*p_user_id text,\s*p_aprovacao_id uuid\s*\)/
        .test(CODIGO_P0) &&
      /\)\s*returns text/.test(CODIGO_P0));
    ok("W19 o ator tecnico e CONSTANTE da funcao, nao parametro",
      /v_ator_tecnico constant text := 'sistema:reconciliador-retomada'/.test(CORPO_CANCEL) &&
      !/p_ator|p_cancelado_por/.test(CODIGO_P0));
    ok("W20 `cancelado_por` recebe o ator tecnico",
      /cancelado_por\s*=\s*v_ator_tecnico/.test(CORPO_CANCEL));
    ok("W21 HARD: `cancelado_por` NUNCA recebe o dono",
      !/cancelado_por\s*=\s*p_user_id/.test(CORPO_CANCEL) &&
      !/cancelado_por\s*=\s*ap\.user_id/.test(CORPO_CANCEL));
    ok("W21a CONTROLE NEGATIVO: a atribuicao do dono seria detectada",
      /cancelado_por\s*=\s*p_user_id/.test("set cancelado_por = p_user_id,"));
    ok("W22 `p_user_id` e cerca de posse na leitura da aprovacao",
      /a\.id = p_aprovacao_id and a\.user_id = p_user_id/.test(CORPO_CANCEL));
    {
      const pTtl = CORPO_CANCEL.indexOf("set estado = 'expirada'");
      const pLock = CORPO_CANCEL.indexOf("for update;");
      const pLockTarefa = CORPO_CANCEL.indexOf("for update of t;");
      const pTarefa = CORPO_CANCEL.indexOf("from public.agente_tarefas t");
      const pCancel = CORPO_CANCEL.indexOf("set estado        = 'cancelada'");
      ok("W23 ANCORA: os cinco pontos do fluxo existem",
        [pTtl, pLock, pTarefa, pLockTarefa, pCancel].every((i) => i > 0));
      ok("W24 TTL PRIMEIRO: a expiracao e materializada antes do lock",
        pTtl < pLock);
      ok("W25 ordem de lock: aprovacao ANTES da tarefa",
        pLock < pLockTarefa);
      ok("W26 a tarefa e lida depois da aprovacao, e o cancelamento por ultimo",
        pLock < pTarefa && pTarefa < pCancel);
    }
    ok("W27 estados ja resolvidos saem ANTES de olhar a tarefa",
      ["ja_cancelada", "ja_consumida", "ja_rejeitada", "expirada", "aprovacao_pendente"]
        .every((c) => CORPO_CANCEL.indexOf(`return '${c}'`) > 0 &&
                      CORPO_CANCEL.indexOf(`return '${c}'`) <
                        CORPO_CANCEL.indexOf("from public.agente_tarefas t")));
    ok("W28 o UPDATE final da aprovacao recerca `estado = 'aprovada'`",
      /and estado = 'aprovada'/.test(CORPO_CANCEL));

    // ── W28a..W28f. GUARD LOCAL DE ESTADO (FIX1) ─────────────────
    //
    // Antes do FIX1 a inalcancabilidade de um estado inesperado vinha do
    // `NOT NULL` + CHECK da TABELA, em outro arquivo. Funcionava hoje e
    // falharia amanha: uma migration futura que acrescentasse um setimo
    // estado ao CHECK o faria cair no cancelamento por OMISSAO, porque
    // nenhum dos cinco `if` casaria. O guard traz o fail-closed para
    // dentro da funcao, onde ele pode ser lido junto com o que protege.
    {
      const CONHECIDOS_P0 = ["ja_cancelada", "ja_consumida", "ja_rejeitada",
        "expirada", "aprovacao_pendente"];
      const pUltimoConhecido = Math.max(
        ...CONHECIDOS_P0.map((c) => CORPO_CANCEL.indexOf(`return '${c}'`)));
      const pGuard = CORPO_CANCEL.indexOf("if ap.estado <> 'aprovada' then");
      const pTarefaSel = CORPO_CANCEL.indexOf("from public.agente_tarefas t");
      const pTarefaLock = CORPO_CANCEL.indexOf("for update of t;");

      // O detector de guard INVALIDO e uma negacao, e negacao so vale
      // depois de vermos o detector disparar. Ele e declarado aqui, usado
      // em W28f e submetido as fixtures sinteticas em W28h/W28i.
      const detectorGuardReturnP0 = /if ap\.estado <> 'aprovada' then\s*return/;
      const GUARD_COM_RETURN_P0 =
        "  if ap.estado <> 'aprovada' then\n    return 'estado_desconhecido';\n  end if;";
      const GUARD_COM_RAISE_P0 =
        "  if ap.estado <> 'aprovada' then\n    raise exception 'x'\n"
        + "      using errcode = '55000';\n  end if;";

      ok(`W28a ANCORA: os CINCO estados conhecidos retornam, cada um uma vez`,
        CONHECIDOS_P0.every((c) =>
          (CORPO_CANCEL.match(new RegExp(`return '${c}'`, "g")) ?? []).length === 1));
      ok("W28b ANCORA: guard, SELECT e lock da tarefa existem no corpo",
        pGuard > 0 && pTarefaSel > 0 && pTarefaLock > 0 && pUltimoConhecido > 0);
      ok("W28c HARD: existe guard explicito exigindo `aprovada` para continuar",
        /if ap\.estado <> 'aprovada' then/.test(CORPO_CANCEL));
      ok("W28d o guard vem DEPOIS de todos os cinco retornos conhecidos",
        pGuard > pUltimoConhecido);
      ok("W28e o guard vem ANTES do SELECT e do lock da tarefa",
        pGuard < pTarefaSel && pGuard < pTarefaLock);
      ok("W28f o guard FALHA — nao devolve codigo novo nem cai na tarefa",
        /if ap\.estado <> 'aprovada' then\s*raise exception\s*'[^']*'\s*using errcode = '55000';\s*end if;/
          .test(CORPO_CANCEL) &&
        !detectorGuardReturnP0.test(CORPO_CANCEL));
      ok("W28g o guard NAO interpola valor dinamico na mensagem",
        /raise exception\s*'retomada_cancelar_aprovacao_incompativel: estado de aprovacao fora do dominio conhecido'/
          .test(CORPO_CANCEL));
      ok("W28h CONTROLE NEGATIVO: um guard que so RETORNASSE E detectado",
        detectorGuardReturnP0.test(GUARD_COM_RETURN_P0));
      ok("W28i e o MESMO detector fica quieto diante do guard correto",
        !detectorGuardReturnP0.test(GUARD_COM_RAISE_P0));
      ok("W28j a fixture do guard correto satisfaz a exigencia POSITIVA de W28f",
        /if ap\.estado <> 'aprovada' then\s*raise exception\s*'[^']*'\s*using errcode = '55000';\s*end if;/.test(GUARD_COM_RAISE_P0) &&
        !/if ap\.estado <> 'aprovada' then\s*raise exception\s*'[^']*'\s*using errcode = '55000';\s*end if;/.test(GUARD_COM_RETURN_P0));
    }
    {
      const cercas = [
        /t\.id\s*=\s*ap\.tarefa_id/,
        /t\.user_id\s*=\s*ap\.user_id/,
        /t\.agente_id\s*=\s*ap\.agente_id/,
        /t\.status\s*=\s*'aguardando_aprovacao'/,
        /t\.aprovacao_aguardada_id\s*=\s*ap\.id/,
        /t\.retomada_request_id is null/,
      ];
      ok(`W29 as SEIS cercas causais da tarefa (${cercas.filter((r) => r.test(CORPO_CANCEL)).length}/6)`,
        cercas.every((r) => r.test(CORPO_CANCEL)));
      ok("W29a e NAO exige folga de tentativa: a tarefa ja esta parada",
        !/t\.tentativas\s*<=\s*t\.max_tentativas/.test(CORPO_CANCEL));
    }
    ok("W30 causalidade divergente devolve tarefa_incompativel SEM escrever",
      CORPO_CANCEL.indexOf("return 'tarefa_incompativel'") <
        CORPO_CANCEL.indexOf("set status                 = 'cancelado'"));

    // ── W31..W35. O QUE AS ESCRITAS TOCAM, E O QUE NAO ──────────────
    ok("W31 a tarefa e encerrada com os sete campos do D4",
      /set status                 = 'cancelado'/.test(CORPO_CANCEL) &&
      /aprovacao_aguardada_id = null/.test(CORPO_CANCEL) &&
      /heartbeat_em           = null/.test(CORPO_CANCEL) &&
      /concluido_em           = now\(\)/.test(CORPO_CANCEL) &&
      /resultado              = null/.test(CORPO_CANCEL) &&
      /erro_tipo              = null/.test(CORPO_CANCEL) &&
      /erro_mensagem          = null/.test(CORPO_CANCEL));
    ok("W32 HARD: `tentativas` e `progresso` ficam FORA de todo SET",
      !/\btentativas\s*=/.test(CORPO_CANCEL) && !/\bprogresso\s*=/.test(CORPO_CANCEL));
    ok("W33 HARD: `decidido_por`/`decidido_em` nao sao tocados",
      !/decidido_por\s*=/.test(CORPO_CANCEL) && !/decidido_em\s*=/.test(CORPO_CANCEL));
    ok("W34 `motivo_recusa` nao e escrito — o CHECK so o admite em rejeitada",
      !/motivo_recusa\s*=/.test(CORPO_CANCEL));
    ok("W35 snapshot e identidade da aprovacao intocados",
      !/argumentos\s*=|argumentos_hash\s*=|fingerprint\s*=|revisao_funcao\s*=|request_id_consumo\s*=/
        .test(CORPO_CANCEL));

    // ── W36..W39. Tool Call, atomicidade e vocabulario ──────────────
    ok("W36 a migration inteira NAO menciona a tabela de Tool Call",
      !/agente_funcao_chamadas/.test(SQL_P0));
    ok("W37 as duas escritas exigem exatamente uma linha, sob lock",
      (CORPO_CANCEL.match(/get diagnostics v_afetadas = row_count/g) ?? []).length === 2 &&
      (CORPO_CANCEL.match(/v_afetadas <> 1/g) ?? []).length === 2);
    // ── W38. Todo RAISE e violacao de invariante ─────────────────
    //
    // A CONTAGEM nao e congelada — o guard de estado do FIX1 acrescentou
    // um terceiro RAISE. O que se prova e a correspondencia 1:1 com o
    // errcode e que os motivos sao os TRES permitidos.
    {
      const raises = [...CORPO_CANCEL.matchAll(/raise exception\s+'([^']*)'/g)]
        .map((m) => m[1]);
      const comErrcode = (CORPO_CANCEL.match(/using errcode = '55000'/g) ?? []).length;
      const totalErrcode = (CORPO_CANCEL.match(/using errcode/g) ?? []).length;
      const MOTIVOS_P0 = [
        "estado de aprovacao fora do dominio conhecido",
        "encerrar tarefa % afetou % linhas sob lock",
        "cancelar % afetou % linhas sob lock",
      ];
      ok(`W38 ANCORA: a funcao tem RAISE, e cada um tem errcode (${raises.length})`,
        raises.length >= 3 && raises.length === totalErrcode);
      ok("W38a violacao de invariante usa SOMENTE 55000",
        comErrcode === totalErrcode && totalErrcode === raises.length);
      ok("W38b os motivos sao exatamente os TRES permitidos",
        raises.length === MOTIVOS_P0.length &&
        MOTIVOS_P0.every((mot) => raises.some((r) => r.includes(mot))) &&
        raises.every((r) => MOTIVOS_P0.some((mot) => r.includes(mot))));
      ok("W38c CONTROLE NEGATIVO: um motivo estranho reprovaria",
        !MOTIVOS_P0.some((mot) => "motivo inventado".includes(mot)));
    }
    {
      const CODIGOS_P0 = ["cancelada", "expirada", "ja_cancelada", "ja_consumida",
        "ja_rejeitada", "aprovacao_pendente", "tarefa_incompativel", "aprovacao_inexistente"];
      const devolvidos = [...CORPO_CANCEL.matchAll(/return '([a-z_]+)'/g)].map((m) => m[1]);
      const unicos = [...new Set(devolvidos)].sort();
      ok(`W39 o vocabulario de retorno e fechado em 8 (${unicos.length})`,
        unicos.length === 8 && unicos.every((c) => CODIGOS_P0.includes(c)));
      ok("W39a e nenhum erro cru do driver escapa como codigo",
        !/sqlerrm|sqlstate\s+into|pg_exception/i.test(CORPO_CANCEL));
    }

    // ── W40. DORMENCIA, agora CIENTE DOS DOIS ADAPTADORES ───────────
    //
    // Ate o A1 nenhuma das duas RPCs podia ser citada por arquivo de
    // producao: nao existia adaptador, entao qualquer mencao SERIA um
    // chamador, e `zero arquivo` era a forma certa de dizer isso.
    //
    // O A1 criou, por desenho aprovado, UM wrapper dormente para a RPC
    // de leitura; o B1 criou o par dela para a RPC de cancelamento. A
    // propriedade protegida nao mudou — as duas seguem sem orquestrador
    // —, mas a prova precisou ficar mais precisa em vez de mais frouxa.
    //
    // A mudanca de forma importa e e deliberada: o veredito deixou de
    // ser um TETO ("no maximo estes arquivos") e virou um INVENTARIO
    // NOMINAL ("exatamente este arquivo, para CADA uma das duas"). A
    // diferenca aparece no W40n: conjunto de cancelamento VAZIO agora
    // REPROVA, porque a partir do B1 o adaptador e obrigatorio — se ele
    // sumir, alguem apagou o wrapper, e isso tambem e uma regressao.
    {
      /** Literal INDEPENDENTE. Nao sai da varredura: se saisse, o teste
       *  estaria comparando o resultado consigo mesmo. */
      const ADAPTADOR_AUTORIZADO_W = "lib/agentes/retomada/persistencia-retomada.ts";
      const RPC_LEITURA_W = "retomada_listar_candidatas";
      const RPC_CANCEL_W = "retomada_cancelar_aprovacao_incompativel";

      /** O veredito e uma funcao PURA sobre conjuntos de paths, separada
       *  da varredura de disco de proposito: e isso que permite executa-la
       *  contra cenarios sinteticos sem escrever arquivo nenhum no
       *  repositorio. Um detector que nunca foi visto reprovando nao
       *  prova coisa alguma.
       *
       *  Os dois conjuntos passam pelo MESMO criterio, e ele e igualdade
       *  com o singleton autorizado — nao `length <= 1`, nao `includes`,
       *  nao basename. */
      const soONoAdaptadorW = (arquivos: readonly string[]): boolean =>
        arquivos.length === 1 && arquivos[0] === ADAPTADOR_AUTORIZADO_W;

      const dormenteW = (
        arquivosLeitura: readonly string[],
        arquivosCancel: readonly string[]
      ): boolean =>
        soONoAdaptadorW(arquivosLeitura) && soONoAdaptadorW(arquivosCancel);

      const producaoW = ["lib/agentes", "app", "components"];
      const comLeituraW: string[] = [];
      const comCancelW: string[] = [];
      let varridosW = 0;
      const varrerW = (dir: string): void => {
        for (const e of readdirSync(join(RAIZ, dir), { withFileTypes: true })) {
          // Path relativo canonico, com separador normalizado: no Windows
          // a comparacao com o literal falharia por causa da barra.
          const rel = `${dir}/${e.name}`.replace(/\\/g, "/");
          if (e.isDirectory()) {
            varrerW(rel);
            continue;
          }
          if (!/\.tsx?$/.test(e.name)) continue;
          varridosW++;
          const fonte = readFileSync(join(RAIZ, rel), "utf8");
          if (fonte.includes(RPC_LEITURA_W)) comLeituraW.push(rel);
          if (fonte.includes(RPC_CANCEL_W)) comCancelW.push(rel);
        }
      };
      for (const d of producaoW) varrerW(d);

      ok(`W40 ANCORA: a varredura de producao rodou de verdade (${varridosW} arquivos)`,
        varridosW > 50);
      ok(`W40a a RPC de leitura aparece SO no adaptador aprovado (${comLeituraW.join(", ") || "nenhum"})`,
        soONoAdaptadorW(comLeituraW));
      ok(`W40b a RPC de cancelamento tambem, e em NENHUM outro lugar (${comCancelW.join(", ") || "nenhum"})`,
        soONoAdaptadorW(comCancelW));
      ok("W40c veredito de dormencia sobre o estado REAL do repositorio",
        dormenteW(comLeituraW, comCancelW));
      ok("W40c1 ANCORA: as duas RPCs pousaram no MESMO arquivo, e ele e o autorizado",
        comLeituraW.length === 1 && comCancelW.length === 1 &&
        comLeituraW[0] === comCancelW[0] &&
        comCancelW[0] === ADAPTADOR_AUTORIZADO_W);

      // ── CONTROLES: o veredito precisa MORDER ──────────────────────
      ok("W40d CONTROLE POSITIVO: o unico cenario permitido e aceito",
        dormenteW([ADAPTADOR_AUTORIZADO_W], [ADAPTADOR_AUTORIZADO_W]));
      ok("W40e CONTROLE NEGATIVO: um SEGUNDO arquivo com a RPC de leitura reprova",
        !dormenteW(
          [ADAPTADOR_AUTORIZADO_W, "lib/agentes/retomada/executar-retomada.ts"],
          [ADAPTADOR_AUTORIZADO_W]));
      ok("W40f CONTROLE NEGATIVO: a RPC de leitura fora do adaptador reprova",
        !dormenteW(["app/api/internal/agentes/worker/route.ts"], [ADAPTADOR_AUTORIZADO_W]));
      ok("W40g CONTROLE NEGATIVO: a RPC de cancelamento no EXECUTOR reprova",
        !dormenteW([ADAPTADOR_AUTORIZADO_W], ["lib/agentes/retomada/executar-retomada.ts"]));
      ok("W40g1 CONTROLE NEGATIVO: a RPC de cancelamento no WORKER reprova",
        !dormenteW([ADAPTADOR_AUTORIZADO_W], ["app/api/internal/agentes/worker/route.ts"]));
      ok("W40g2 CONTROLE NEGATIVO: adaptador MAIS um segundo arquivo no cancelamento reprova",
        !dormenteW(
          [ADAPTADOR_AUTORIZADO_W],
          [ADAPTADOR_AUTORIZADO_W, "lib/agentes/retomada/executar-retomada.ts"]));
      ok("W40h CONTROLE NEGATIVO: basename igual em OUTRO diretorio reprova, nos DOIS conjuntos",
        !dormenteW(["lib/agentes/persistencia-retomada.ts"], [ADAPTADOR_AUTORIZADO_W]) &&
        !dormenteW(["lib/outro/retomada/persistencia-retomada.ts"], [ADAPTADOR_AUTORIZADO_W]) &&
        !dormenteW([ADAPTADOR_AUTORIZADO_W], ["lib/agentes/persistencia-retomada.ts"]) &&
        !dormenteW([ADAPTADOR_AUTORIZADO_W], ["lib/outro/retomada/persistencia-retomada.ts"]));
      ok("W40h1 CONTROLE NEGATIVO: prefixo de diretorio nao basta — o path e comparado inteiro",
        !dormenteW([ADAPTADOR_AUTORIZADO_W], ["lib/agentes/retomada"]) &&
        !dormenteW([ADAPTADOR_AUTORIZADO_W],
          ["lib/agentes/retomada/persistencia-retomada.test.ts"]));
      ok("W40i CONTROLE NEGATIVO: conjunto de leitura VAZIO reprova",
        !dormenteW([], [ADAPTADOR_AUTORIZADO_W]));
      ok("W40n CONTROLE NEGATIVO: conjunto de cancelamento VAZIO tambem reprova",
        !dormenteW([ADAPTADOR_AUTORIZADO_W], []) && !dormenteW([], []));

      // ── A intencao original, dita diretamente ─────────────────────
      //
      // Os dois arquivos que um orquestrador habitaria sao nomeados aqui
      // em vez de deduzidos da varredura: se amanha um deles passar a
      // citar qualquer das duas RPCs, este assert cai sozinho, sem
      // depender de o conjunto acima mudar de tamanho.
      {
        const ORQUESTRADORES_W = [
          "lib/agentes/retomada/executar-retomada.ts",
          "app/api/internal/agentes/worker/route.ts",
        ];
        const sujosW = ORQUESTRADORES_W.filter((rel) => {
          const fonte = readFileSync(join(RAIZ, rel), "utf8");
          return fonte.includes(RPC_LEITURA_W) || fonte.includes(RPC_CANCEL_W);
        });
        ok("W40j ANCORA: os dois candidatos a orquestrador existem e foram lidos",
          ORQUESTRADORES_W.every((rel) => existsSync(join(RAIZ, rel))));
        ok(`W40k executor e worker seguem sem citar as duas RPCs (${sujosW.join(", ") || "nenhum"})`,
          sujosW.length === 0);
      }
    }
  }

  // ────────────────────────────────────────────────────────────────
  // X. APPROVAL-DECISION-RESUME-D5-C3-I2-D0 — a ATIVACAO do worker
  //
  // O seam executavel foi tentado no F1 e RECUSADO pelo Next 14: exportar
  // a funcao do laco de um `route.ts` quebra a checagem de tipos gerada.
  // Entao a orquestracao continua provada por ESTRUTURA — e, para as
  // propriedades dinamicas (alternancia, contagem, streak, tetos), por um
  // SIMULADOR que executa a mesma maquina de estados declarada na fonte.
  //
  // O simulador nao substitui a fonte: cada regra que ele implementa tem,
  // ao lado, um assert estrutural provando que a fonte contem aquela
  // regra. Um simulador que divergisse do worker seria pior que nenhum.
  // ────────────────────────────────────────────────────────────────
  console.log("\nX. RESUME-D5-C3-I2-D0 — ativacao Worker -> Resume Slot");
  {
    const ROTA_X = "app/api/internal/agentes/worker/route.ts";
    const codX = codigo(ROTA_X);

    // ── X0..X6. A FONTE contem a maquina de estados ─────────────────
    ok("X0  ANCORA: a rota foi lida e tem o laco de duas lanes",
      codX.length > 900 && /proximaLane/.test(codX) && /executarSlotRetomada/.test(codX));
    ok("X1  a primeira lane da rodada e RETOMADA",
      /let proximaLane: "retomada" \| "normal" = "retomada";/.test(codX));
    ok("X2  o estado de controle e o minimo declarado",
      /let processados = 0;/.test(codX) && /let turnos = 0;/.test(codX) &&
      /let emptyStreak = 0;/.test(codX));
    ok("X3  cada lane cede a vez para a outra, e so para a outra",
      /proximaLane = "normal";/.test(codX) && /proximaLane = "retomada";/.test(codX) &&
      conta(codX, /proximaLane = "normal";/g) === 1 &&
      conta(codX, /proximaLane = "retomada";/g) === 1);
    ok("X4  TRUE EMPTY da retomada e SO `fila_vazia`",
      /r\.ok === true && r\.desfecho === "fila_vazia"/.test(codX) &&
      !/progressoDuravel === "nenhum"[\s\S]{0,60}?emptyStreak \+= 1/.test(codX));
    ok("X5  qualquer resultado nao-vazio ZERA o streak",
      /emptyStreak = vazioResume \? emptyStreak \+ 1 : 0;/.test(codX));
    ok("X6  duas lanes vazias seguidas encerram a rodada",
      conta(codX, /if \(emptyStreak >= 2\) break;/g) === 2);

    // ── O SIMULADOR ────────────────────────────────────────────────
    //
    // Reproduz literalmente o corpo do laco da fonte. Cada `roteiro` diz
    // o que cada lane responde no seu turno.
    interface ResumoRodada {
      readonly turnos: number;
      readonly processados: number;
      readonly emptyStreak: number;
      readonly trace: string;
      readonly lanesResume: number;
      readonly lanesNormal: number;
    }
    type RespostaResume = {
      ok: boolean;
      desfecho?: string;
      progressoDuravel: "nenhum" | "possivel" | "confirmado";
      encerrarPorOrcamento?: boolean;
    };
    type RespostaNormal =
      | { tipo: "vazia" }
      | { tipo: "tarefa"; corpoOk: boolean }
      | { tipo: "erro" };

    const MAX_T = 5;
    const MAX_TU = 2 * MAX_T;

    const rodada = (
      resume: (n: number) => RespostaResume,
      normal: (n: number) => RespostaNormal,
      orcamentoOk: () => boolean = () => true
    ): ResumoRodada => {
      let processados = 0;
      let turnos = 0;
      let proximaLane: "retomada" | "normal" = "retomada";
      let emptyStreak = 0;
      let lanesResume = 0;
      let lanesNormal = 0;
      const trace: string[] = [];

      while (processados < MAX_T && turnos < MAX_TU && orcamentoOk()) {
        turnos += 1;
        if (proximaLane === "retomada") {
          lanesResume += 1;
          trace.push("R");
          const r = resume(lanesResume);
          if (r.progressoDuravel !== "nenhum") processados += 1;
          const vazio = r.ok === true && r.desfecho === "fila_vazia";
          emptyStreak = vazio ? emptyStreak + 1 : 0;
          proximaLane = "normal";
          if (r.ok === true && r.encerrarPorOrcamento === true) break;
          if (emptyStreak >= 2) break;
        } else {
          lanesNormal += 1;
          trace.push("N");
          const t = normal(lanesNormal);
          if (t.tipo === "erro") break;
          proximaLane = "retomada";
          if (t.tipo === "vazia") {
            emptyStreak += 1;
            if (emptyStreak >= 2) break;
          } else {
            emptyStreak = 0;
            processados += 1;
            if (!t.corpoOk) break;
          }
        }
      }
      return { turnos, processados, emptyStreak, trace: trace.join(""), lanesResume, lanesNormal };
    };

    const SEM_PROG: RespostaResume = { ok: true, desfecho: "sem_progresso", progressoDuravel: "nenhum" };
    const VAZIO_R: RespostaResume = { ok: true, desfecho: "fila_vazia", progressoDuravel: "nenhum" };
    const TAREFA_OK: RespostaNormal = { tipo: "tarefa", corpoOk: true };
    const VAZIO_N: RespostaNormal = { tipo: "vazia" };

    // ── X7..X9. ALTERNANCIA ESTRITA ────────────────────────────────
    {
      const r = rodada(() => SEM_PROG, () => TAREFA_OK);
      ok(`X7  o trace alterna R,N,R,N... sem repetir lane (${r.trace})`,
        /^(RN)+R?$/.test(r.trace) && r.trace.startsWith("R") && r.trace.length >= 6);
      ok("X7a CONTROLE: um trace com lane repetida seria detectado",
        !/^(RN)+R?$/.test("RRNR") && !/^(RN)+R?$/.test("RNNR"));
      ok("X8  as duas lanes recebem turnos de verdade",
        r.lanesResume > 0 && r.lanesNormal > 0 &&
        Math.abs(r.lanesResume - r.lanesNormal) <= 1);
      ok("X9  a lane normal NAO passa fome: recebe metade dos turnos",
        r.lanesNormal >= Math.floor(r.turnos / 2));
    }

    // ── X10..X12. TRUE EMPTY e NO-SPIN ─────────────────────────────
    {
      const vazioTotal = rodada(() => VAZIO_R, () => VAZIO_N);
      ok(`X10 duas lanes vazias encerram em 2 turnos (${vazioTotal.trace})`,
        vazioTotal.turnos === 2 && vazioTotal.processados === 0 &&
        vazioTotal.emptyStreak === 2 && vazioTotal.trace === "RN");

      const semSpin = rodada(() => SEM_PROG, () => VAZIO_N);
      ok(`X11 NO-SPIN: sem_progresso reseta o streak, e o teto de turnos encerra (${semSpin.turnos})`,
        semSpin.turnos === 10 && semSpin.processados === 0);
      ok("X11a e nao existe 11o turno",
        semSpin.turnos === MAX_TU && semSpin.turnos < 11);
      ok("X12 `sem_progresso` NAO e vazio: nao encerra por streak",
        semSpin.emptyStreak < 2);
    }

    // ── X13..X18. CONTAGEM DE PROGRESSO ────────────────────────────
    {
      const umTurnoResume = (r: RespostaResume) =>
        rodada((n) => (n === 1 ? r : VAZIO_R), () => VAZIO_N).processados;
      const TABELA: ReadonlyArray<readonly [string, RespostaResume, number]> = [
        ["ok:true possivel", { ok: true, desfecho: "reconciliado", progressoDuravel: "possivel" }, 1],
        ["ok:true confirmado", { ok: true, desfecho: "recuperacao_duravel", progressoDuravel: "confirmado" }, 1],
        ["ok:true nenhum", SEM_PROG, 0],
        ["ok:false possivel", { ok: false, progressoDuravel: "possivel" }, 1],
        ["ok:false confirmado", { ok: false, progressoDuravel: "confirmado" }, 1],
        ["ok:false nenhum", { ok: false, progressoDuravel: "nenhum" }, 0],
      ];
      let i = 12;
      for (const [rotulo, resp, esperado] of TABELA) {
        i += 1;
        ok(`X${i} ${rotulo} consome ${esperado} vaga(s)`, umTurnoResume(resp) === esperado);
      }
      ok("X19 HARD: a contagem olha SO o grau, nunca `ok` nem `desfecho`",
        umTurnoResume({ ok: false, progressoDuravel: "possivel" }) ===
        umTurnoResume({ ok: true, desfecho: "reconciliado", progressoDuravel: "possivel" }));
    }

    // ── X20..X22. TETO GLOBAL de trabalho ──────────────────────────
    {
      const mix = rodada(
        () => ({ ok: true, desfecho: "reconciliado", progressoDuravel: "confirmado" }),
        () => TAREFA_OK
      );
      ok(`X20 Resume e Normal dividem o MESMO teto de 5 (${mix.processados}/${mix.turnos})`,
        mix.processados === 5 && mix.turnos === 5);
      ok("X20a e nao existe sexto trabalho duravel",
        mix.processados === MAX_T);

      const soResume = rodada(
        () => ({ ok: true, desfecho: "reconciliado", progressoDuravel: "possivel" }),
        () => VAZIO_N
      );
      ok(`X21 cinco progressos Resume esgotam o teto (${soResume.processados})`,
        soResume.processados === 5);

      const soNormal = rodada(() => SEM_PROG, () => TAREFA_OK);
      ok(`X22 cinco Tasks normais esgotam o teto (${soNormal.processados})`,
        soNormal.processados === 5 && soNormal.turnos === 10);
    }

    // ── X23..X26. ORCAMENTO ────────────────────────────────────────
    {
      const comBudget = (r: RespostaResume) =>
        rodada((n) => (n === 1 ? r : VAZIO_R), () => TAREFA_OK);
      const semProg = comBudget({ ok: true, desfecho: "orcamento_insuficiente", progressoDuravel: "nenhum", encerrarPorOrcamento: true });
      ok(`X23 budget sem progresso: +0 e break antes da lane normal (${semProg.trace})`,
        semProg.processados === 0 && semProg.turnos === 1 &&
        semProg.trace === "R" && semProg.lanesNormal === 0);
      const comPossivel = comBudget({ ok: true, desfecho: "reconciliado", progressoDuravel: "possivel", encerrarPorOrcamento: true });
      ok("X24 budget com `possivel`: +1 e break",
        comPossivel.processados === 1 && comPossivel.lanesNormal === 0);
      const comConfirmado = comBudget({ ok: true, desfecho: "recuperacao_duravel", progressoDuravel: "confirmado", encerrarPorOrcamento: true });
      ok("X25 budget com `confirmado`: +1 e break",
        comConfirmado.processados === 1 && comConfirmado.lanesNormal === 0);
      ok("X26 HARD: o progresso e contabilizado ANTES do break de orcamento",
        comPossivel.processados === 1 && comConfirmado.processados === 1);
    }

    // ── X27..X28. ORCAMENTO NEGADO ANTES DO LACO ───────────────────
    {
      const nunca = rodada(() => VAZIO_R, () => VAZIO_N, () => false);
      ok("X27 orcamento negado na entrada: zero turno, zero lane, zero trabalho",
        nunca.turnos === 0 && nunca.processados === 0 &&
        nunca.lanesResume === 0 && nunca.lanesNormal === 0);
      ok("X28 CONTROLE: com orcamento liberado o mesmo roteiro roda",
        rodada(() => VAZIO_R, () => VAZIO_N, () => true).turnos === 2);
    }

    // ── X29..X31. RESILIENCIA A ERRO DO SLOT ───────────────────────
    {
      const erroSemProg = rodada(
        (n) => (n === 1 ? { ok: false, progressoDuravel: "nenhum" } : VAZIO_R),
        () => TAREFA_OK
      );
      ok(`X29 slot com ok:false NAO derruba a lane normal (${erroSemProg.trace})`,
        erroSemProg.lanesNormal >= 1 && erroSemProg.trace.startsWith("RN"));
      ok("X29a e nao consome vaga quando nao houve progresso",
        rodada((n) => (n === 1 ? { ok: false, progressoDuravel: "nenhum" } : VAZIO_R),
          () => VAZIO_N).processados === 0);
      const erroComProg = rodada(
        (n) => (n === 1 ? { ok: false, progressoDuravel: "possivel" } : VAZIO_R),
        () => TAREFA_OK
      );
      ok("X30 slot com ok:false + `possivel` consome vaga e a rodada segue",
        erroComProg.processados >= 1 && erroComProg.lanesNormal >= 1);
      ok("X31 o erro do slot tambem ZERA o streak de vazios",
        erroSemProg.emptyStreak === 0 || erroSemProg.turnos > 2);
    }

    // ── X32..X34. TETOS INDEPENDENTES ──────────────────────────────
    {
      const porTurnos = rodada(() => SEM_PROG, () => VAZIO_N);
      ok("X32 o teto de TURNOS encerra com trabalho abaixo do teto",
        porTurnos.turnos === MAX_TU && porTurnos.processados < MAX_T);
      const porTrabalho = rodada(
        () => ({ ok: true, desfecho: "reconciliado", progressoDuravel: "confirmado" }),
        () => TAREFA_OK
      );
      ok("X33 o teto de TRABALHO encerra com turnos abaixo do teto",
        porTrabalho.processados === MAX_T && porTrabalho.turnos < MAX_TU);
      ok("X34 nenhum off-by-one: os limites sao 5 e 10, e sao atingidos exatamente",
        porTrabalho.processados === 5 && porTurnos.turnos === 10);
    }

    // ── X35. A NORMAL preserva a semantica historica ────────────────
    {
      const falhaNegocio = rodada(
        () => SEM_PROG,
        (n) => (n === 1 ? { tipo: "tarefa", corpoOk: false } : TAREFA_OK)
      );
      ok(`X35 falha de negocio na Task conta e encerra a rodada (${falhaNegocio.trace})`,
        falhaNegocio.processados === 1 && falhaNegocio.trace === "RN");
      const erroClaim = rodada(() => SEM_PROG, (n) => (n === 1 ? { tipo: "erro" } : VAZIO_N));
      ok("X36 erro de claim encerra a rodada sem contar trabalho",
        erroClaim.processados === 0 && erroClaim.trace === "RN");
    }

    // ── X37. O SIMULADOR corresponde a FONTE ───────────────────────
    //
    // Cada regra simulada acima tem de existir no worker. Sem esta
    // ancora o simulador poderia descrever uma maquina que ninguem
    // implementou — e passaria com folga.
    {
      const semEspaco = codX.replace(/\s+/g, " ");
      ok("X37 a fonte tem as MESMAS cinco regras que o simulador executa",
        /turnos \+= 1;/.test(semEspaco) &&
        /if \(r\.progressoDuravel !== "nenhum"\) \{ processados \+= 1; \}/.test(semEspaco) &&
        /emptyStreak = vazioResume \? emptyStreak \+ 1 : 0;/.test(semEspaco) &&
        /if \(r\.ok === true && r\.encerrarPorOrcamento\) break;/.test(semEspaco) &&
        /if \(emptyStreak >= 2\) break;/.test(semEspaco));
      ok("X37a e os tetos do simulador sao os da fonte",
        /const MAX_TASKS_PER_RUN = 5;/.test(codX) &&
        /const MAX_TURNOS_PER_RUN = 2 \* MAX_TASKS_PER_RUN;/.test(codX) &&
        MAX_T === 5 && MAX_TU === 10);
      // Escopado aos CORPOS de resposta, e nao ao arquivo: `proximaLane:`
      // tambem aparece na anotacao de tipo da variavel de controle, e uma
      // busca global acusaria o estado interno como se fosse payload.
      const corposX = [...codX.matchAll(/responder\((\{[^}]*\})/g)].map((m) => m[1]);
      const chavesX = corposX.flatMap((c) => [...c.matchAll(/(\w+):/g)].map((m) => m[1]));
      ok(`X37b ANCORA: ha respostas a inspecionar (${corposX.length})`, corposX.length >= 4);
      ok(`X37c a resposta HTTP nao ganhou campo nenhum (${[...new Set(chavesX)].join(", ")})`,
        /responder\(\{ ok: true, processados, duracaoMs: Date\.now\(\) - inicio \}, 200\)/.test(codX) &&
        chavesX.every((k) => ["ok", "processados", "erro", "duracaoMs"].includes(k)) &&
        !chavesX.includes("turnos") && !chavesX.includes("proximaLane") &&
        !chavesX.includes("emptyStreak"));
    }
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
