/**
 * Suite da fundacao de agentes — AGENTES-FASE1B.
 *
 * SEM rede, SEM banco, SEM IA — como todas as suites deste projeto.
 * A prova que EXIGE banco (a FK composta recusando tarefa cross-tenant)
 * mora em `scripts/testar-agentes-isolamento-banco.ts`, separada de
 * proposito para que esta aqui continue rodando a custo zero.
 *
 * ── Cinco instrumentos, deliberadamente distintos ───────────────────
 *  1. INSPECAO DA MIGRATION. Conta e proibe: 2 CREATE TABLE, 1 CREATE
 *     INDEX, zero CASCADE/GRANT/REVOKE/RLS/ALTER DEFAULT PRIVILEGES.
 *     Sempre sobre a fonte SEM COMENTARIOS — este projeto documenta
 *     fartamente o que decidiu NAO fazer, e uma busca ingenua por
 *     "CASCADE" casaria com a explicacao de por que ele nao esta la,
 *     falhando pelo motivo errado.
 *  2. COERENCIA tipos.ts <-> migration. Os dominios fechados existem em
 *     dois lugares; divergir nao da erro de tipo, da 23514 em runtime.
 *  3. INSPECAO DA CAPABILITY. server-only, ausencia de anon key,
 *     ausencia de `select("*")`, `user_id` nas 7 operacoes, ausencia de
 *     spread do input.
 *  4. FUNCOES PURAS executadas de verdade — `derivarStatusAgente` e a
 *     maquina de transicao.
 *  5. EXECUTOR EM MEMORIA que reproduz `.eq()` encadeado e consome os
 *     MESMOS objetos de filtro que a producao aplica.
 *
 * ── Anti-vacuidade ─────────────────────────────────────────────────
 * Toda varredura prova PRIMEIRO que encontrou o alvo, e so entao que o
 * alvo e o unico. Um assert de ausencia sobre um texto vazio passa
 * sempre — foi assim que o assert 92 da SEC-1c-1 virou vacuo sem que
 * nada acusasse.
 */
import "./_server-only-inerte";
import "./_env-inerte";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

import {
  TIPOS_AGENTE,
  STATUS_TAREFA,
  STATUS_TAREFA_TERMINAIS,
  TRANSICOES_TAREFA,
  derivarStatusAgente,
  transicaoTarefaPermitida,
  ehTipoAgente,
  ehStatusTarefa,
  type LinhaAgente,
  type LinhaTarefa,
} from "../lib/agentes/tipos";
import {
  filtrosAgenteDoDono,
  filtrosAgentesDoDono,
  filtrosTarefaDoDono,
  filtrosTarefasDoAgente,
  criarAgente,
  listarAgentesDoDono,
  lerAgenteDoDono,
  atualizarAgenteDoDono,
  criarTarefa,
  listarTarefasDoAgente,
  lerTarefaDoDono,
} from "../lib/agentes/capability";

const RAIZ = join(__dirname, "..");
const fonte = (rel: string) => readFileSync(join(RAIZ, rel), "utf8");

/** Fonte TS sem comentarios. */
const codigo = (rel: string) =>
  fonte(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

/** Fonte SQL sem comentarios `--`. */
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
  if (condicao) {
    passou++;
  } else {
    falhou++;
    console.error(`  x ${nome}`);
  }
}

const conta = (texto: string, re: RegExp) => (texto.match(re) ?? []).length;

/**
 * Corpo de uma funcao exportada, delimitado pelo PROXIMO `export` de
 * topo — nunca ate o fim do arquivo. Fatiar ate EOF e o que torna
 * asserts fragilmente dependentes da ordem das funcoes: acrescentar
 * codigo no fim do modulo muda o resultado de um assert que fala de
 * outra funcao. Ja aconteceu (asserts 42/43 de
 * `testar-credenciais-marketplace.ts`), e nao se repete aqui.
 */
function corpoDaFuncao(texto: string, nome: string): string {
  const inicio = texto.search(new RegExp(`export\\s+(async\\s+)?function\\s+${nome}\\s*\\(`));
  if (inicio === -1) return "";
  const resto = texto.slice(inicio);
  const proximo = resto.slice(1).search(/\nexport\s+(async\s+)?function\s/);
  return proximo === -1 ? resto : resto.slice(0, proximo + 1);
}

const MIGRATION = "supabase/migrations/20260916_agentes_fundacao.sql";
/**
 * A migration FORWARD que acrescentou o setimo perfil.
 *
 * A autoridade do vocabulario de `tipo` deixou de ser um arquivo so na
 * SKILL-1D.agent-custom-type-B: a fundacional registra o que o schema
 * FOI (seis tipos, no dia em que nasceu) e esta registra o que ele E.
 * A suite le as duas — reescrever a fundacional para caber uma decisao
 * de hoje apagaria a historia que ela existe para guardar.
 */
const MIGRATION_TIPO_PERSONALIZADO =
  "supabase/migrations/20260926_agentes_tipo_personalizado.sql";
const CAPABILITY = "lib/agentes/capability.ts";
const TIPOS = "lib/agentes/tipos.ts";

const OPERACOES_LEITURA = [
  "listarAgentesDoDono",
  "lerAgenteDoDono",
  "atualizarAgenteDoDono",
  "listarTarefasDoAgente",
  "lerTarefaDoDono",
];
const OPERACOES_ESCRITA = ["criarAgente", "criarTarefa"];
const AS_7_OPERACOES = [...OPERACOES_LEITURA, ...OPERACOES_ESCRITA];

// ── Executor em memoria ───────────────────────────────────────────────
// Reproduz `.eq()` encadeado: a linha so passa se TODOS os filtros
// baterem. Mesma regra que `aplicarFiltros` aplica na producao.
type Linha = Record<string, unknown>;
function selecionar(tabela: Linha[], filtros: Record<string, unknown>): Linha[] {
  return tabela.filter((linha) =>
    Object.entries(filtros).every(([coluna, valor]) => String(linha[coluna]) === String(valor))
  );
}

const USUARIO_A = "user-aaaa";
const USUARIO_B = "user-bbbb";
const AGENTE_A = "11111111-1111-1111-1111-111111111111";
const AGENTE_B = "22222222-2222-2222-2222-222222222222";
const TAREFA_A = "33333333-3333-3333-3333-333333333333";
const TAREFA_B = "44444444-4444-4444-4444-444444444444";

const AGENTES: Linha[] = [
  { id: AGENTE_A, user_id: USUARIO_A, nome: "Mensagens A", tipo: "mensagens", ativo: true },
  { id: AGENTE_B, user_id: USUARIO_B, nome: "Mensagens B", tipo: "mensagens", ativo: true },
];
const TAREFAS: Linha[] = [
  { id: TAREFA_A, agente_id: AGENTE_A, user_id: USUARIO_A, status: "pendente" },
  { id: TAREFA_B, agente_id: AGENTE_B, user_id: USUARIO_B, status: "pendente" },
];

function main() {
  const mig = sql(MIGRATION);
  const migBruta = fonte(MIGRATION);
  const cap = codigo(CAPABILITY);
  const capBruta = fonte(CAPABILITY);
  const tip = codigo(TIPOS);

  // ═══ A. MIGRATION — contagem e proibicoes ══════════════════════════
  console.log("\nA. Migration");

  // A0. ANTI-VACUIDADE: o strip de comentarios nao pode ter comido tudo.
  ok("A0  migration sem comentarios ainda tem corpo", mig.trim().length > 400);
  ok("A0b strip removeu de fato os comentarios", migBruta.length > mig.length * 2);

  ok("A1  exatamente 2 CREATE TABLE", conta(mig, /CREATE\s+TABLE/gi) === 2);
  ok("A2  as 2 sao IF NOT EXISTS", conta(mig, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS/gi) === 2);
  ok("A3  cria public.agentes", /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+public\.agentes\b/i.test(mig));
  ok("A4  cria public.agente_tarefas", /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+public\.agente_tarefas\b/i.test(mig));
  ok("A5  exatamente 1 CREATE INDEX", conta(mig, /CREATE\s+INDEX/gi) === 1);
  ok("A6  o indice e idx_agente_tarefas_agente", /idx_agente_tarefas_agente/i.test(mig));
  ok("A7  o indice e (agente_id, criado_em DESC)", /\(\s*agente_id\s*,\s*criado_em\s+DESC\s*\)/i.test(mig));
  ok("A8  nenhum CREATE UNIQUE INDEX avulso", conta(mig, /CREATE\s+UNIQUE\s+INDEX/gi) === 0);

  // Proibicoes absolutas — regras 8, 12..16 do escopo autorizado.
  ok("A9  zero CASCADE", conta(mig, /CASCADE/gi) === 0);
  ok("A10 zero GRANT", conta(mig, /\bGRANT\b/gi) === 0);
  ok("A11 zero REVOKE", conta(mig, /\bREVOKE\b/gi) === 0);
  ok("A12 zero ALTER DEFAULT PRIVILEGES", conta(mig, /ALTER\s+DEFAULT\s+PRIVILEGES/gi) === 0);
  ok("A13 zero ROW LEVEL SECURITY", conta(mig, /ROW\s+LEVEL\s+SECURITY/gi) === 0);
  ok("A14 zero CREATE POLICY", conta(mig, /CREATE\s+POLICY/gi) === 0);
  ok("A15 zero DROP executavel", conta(mig, /\bDROP\b/gi) === 0);
  ok("A16 zero CREATE FUNCTION", conta(mig, /CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/gi) === 0);
  ok("A17 zero CREATE TRIGGER", conta(mig, /CREATE\s+TRIGGER/gi) === 0);
  ok("A18 zero ALTER TABLE", conta(mig, /ALTER\s+TABLE/gi) === 0);
  // O rollback existe, mas SO como comentario.
  ok("A19 rollback documentado (so em comentario)", /DROP TABLE IF EXISTS public\.agente_tarefas/.test(migBruta));
  ok("A20 rollback na ordem certa (filha antes da mae)",
     migBruta.indexOf("DROP TABLE IF EXISTS public.agente_tarefas") <
     migBruta.indexOf("DROP TABLE IF EXISTS public.agentes;"));

  // ═══ B. MIGRATION — forma das tabelas ══════════════════════════════
  console.log("B. Migration — constraints e colunas");

  ok("B1  agentes NAO tem coluna status", !/^\s*status\s+text[^;]*$/mi.test(
       mig.slice(mig.indexOf("public.agentes"), mig.indexOf("public.agente_tarefas"))));
  ok("B2  agentes tem ativo boolean NOT NULL DEFAULT true",
     /ativo\s+boolean\s+NOT\s+NULL\s+DEFAULT\s+true/i.test(mig));
  ok("B3  UNIQUE (user_id, id) — nesta ordem",
     /CONSTRAINT\s+agentes_id_por_dono\s+UNIQUE\s*\(\s*user_id\s*,\s*id\s*\)/i.test(mig));
  ok("B4  FK composta (agente_id, user_id)",
     /FOREIGN\s+KEY\s*\(\s*agente_id\s*,\s*user_id\s*\)/i.test(mig));
  ok("B5  FK referencia agentes (id, user_id)",
     /REFERENCES\s+public\.agentes\s*\(\s*id\s*,\s*user_id\s*\)/i.test(mig));
  ok("B6  ON DELETE RESTRICT", /ON\s+DELETE\s+RESTRICT/i.test(mig));
  ok("B7  ON UPDATE RESTRICT", /ON\s+UPDATE\s+RESTRICT/i.test(mig));
  ok("B8  agente_id NOT NULL", /agente_id\s+uuid\s+NOT\s+NULL/i.test(mig));
  ok("B9  user_id NOT NULL nas duas tabelas", conta(mig, /user_id\s+text\s+NOT\s+NULL/gi) === 2);
  ok("B10 user_id continua text (nunca uuid)", conta(mig, /user_id\s+uuid/gi) === 0);
  ok("B11 exatamente 2 PRIMARY KEY", conta(mig, /PRIMARY\s+KEY/gi) === 2);
  ok("B12 exatamente 9 CONSTRAINT nomeadas", conta(mig, /\bCONSTRAINT\s+\w+/gi) === 9);
  ok("B13 exatamente 1 FOREIGN KEY", conta(mig, /FOREIGN\s+KEY/gi) === 1);
  ok("B14 exatamente 1 UNIQUE", conta(mig, /\bUNIQUE\b/gi) === 1);
  ok("B15 exatamente 7 CHECK", conta(mig, /\bCHECK\s*\(/gi) === 7);
  // `NOT NULL` de COLUNA. O total bruto inclui o `IS NOT NULL` do CHECK
  // `agente_tarefas_erro_explicado`, que nao e declaracao de coluna —
  // contar os dois juntos mediria outra coisa.
  const notNullBruto = conta(mig, /\bNOT\s+NULL\b/gi);
  const isNotNull = conta(mig, /\bIS\s+NOT\s+NULL\b/gi);
  ok("B16a o CHECK usa exatamente 1 IS NOT NULL (anti-vacuidade)", isNotNull === 1);
  ok("B16b exatamente 15 NOT NULL de coluna", notNullBruto - isNotNull === 15);
  ok("B17 CHECK condicional de erro explicado",
     /status\s*<>\s*'erro'\s+OR\s+erro_tipo\s+IS\s+NOT\s+NULL/i.test(mig));
  ok("B18 CHECK condicional de conclusao completa",
     /status\s*<>\s*'concluido'\s+OR\s+progresso\s*=\s*100/i.test(mig));
  ok("B19 heartbeat_em existe (coluna, sem indice nesta fase)", /heartbeat_em\s+timestamptz/i.test(mig));
  ok("B20 nenhum indice de fila/heartbeat nesta fase",
     !/idx_agente_tarefas_(fila|heartbeat)/i.test(mig));

  // ═══ C. tipos.ts <-> migration ═════════════════════════════════════
  console.log("C. Coerencia tipos.ts <-> migration");

  const tiposDoCheck = (texto: string): string[] => {
    const bloco = texto.match(/tipo\s+IN\s*\(([^)]*)\)/i)?.[1] ?? "";
    return (bloco.match(/'([^']+)'/g) ?? []).map((s) => s.replace(/'/g, ""));
  };

  // HISTORIA: o que a fundacional criou. Continua sendo seis, e continua
  // sendo cobrado — nao se reescreve o passado para um teste passar.
  const tiposFundacionais = tiposDoCheck(mig);
  ok("C0  o CHECK de tipo foi encontrado (anti-vacuidade)", tiposFundacionais.length > 0);
  ok(`C0b a fundacional segue registrando os SEIS tipos originais (${tiposFundacionais.join(",")})`,
     tiposFundacionais.length === 6 && !tiposFundacionais.includes("personalizado"));

  // EVOLUCAO: a forward troca a constraint inteira, entao o vocabulario
  // VIGENTE e o dela. Se um dia surgir outra forward, este e o ponto que
  // precisa aprender a ler a mais recente.
  const migForward = sql(MIGRATION_TIPO_PERSONALIZADO);
  const tiposNoBanco = tiposDoCheck(migForward);
  ok("C0c a forward de `personalizado` existe e recria a constraint",
     /ALTER TABLE public\.agentes/i.test(migForward) &&
     /DROP CONSTRAINT IF EXISTS agentes_tipo_valido/i.test(migForward) &&
     /ADD CONSTRAINT agentes_tipo_valido/i.test(migForward));
  ok("C0d e ela nao mexe em dado nem em mais nada do schema",
     !/(update|insert|delete|truncate|upsert)/i.test(migForward) &&
     (migForward.match(/ALTER TABLE/gi) ?? []).length === 2 &&
     !/ADD COLUMN|DROP COLUMN|ALTER COLUMN|CREATE INDEX|CREATE TRIGGER|REFERENCES/i.test(migForward));

  // VIGENTE: a autoridade que o codigo precisa espelhar.
  ok("C1  TIPOS_AGENTE == CHECK vigente do banco",
     JSON.stringify([...TIPOS_AGENTE].sort()) === JSON.stringify([...tiposNoBanco].sort()));
  ok("C2  sao 7 tipos vigentes",
     TIPOS_AGENTE.length === 7 && tiposNoBanco.length === 7);
  ok("C2b `personalizado` esta nos dois lados",
     (TIPOS_AGENTE as readonly string[]).includes("personalizado") &&
     tiposNoBanco.includes("personalizado"));
  ok("C2c e e o PRIMEIRO — a ordem da autoridade e a que a tela oferece",
     TIPOS_AGENTE[0] === "personalizado");

  const checkStatus = mig.match(/status\s+IN\s*\(([\s\S]*?)\)/i)?.[1] ?? "";
  const statusNoBanco = (checkStatus.match(/'([^']+)'/g) ?? []).map((s) => s.replace(/'/g, ""));
  ok("C3  o CHECK de status foi encontrado (anti-vacuidade)", statusNoBanco.length > 0);
  ok("C4  STATUS_TAREFA == CHECK do banco",
     JSON.stringify([...STATUS_TAREFA].sort()) === JSON.stringify([...statusNoBanco].sort()));
  ok("C5  sao os 6 estados aprovados", STATUS_TAREFA.length === 6 && statusNoBanco.length === 6);
  ok("C6  aguardando_aprovacao esta entre eles", STATUS_TAREFA.includes("aguardando_aprovacao"));
  ok("C7  tipos.ts nao persiste status de agente",
     !/status\s*:\s*string/.test(tip.slice(tip.indexOf("interface LinhaAgente"),
                                            tip.indexOf("interface LinhaTarefa"))));
  ok("C8  LinhaAgente tem exatamente 8 campos",
     conta(tip.slice(tip.indexOf("interface LinhaAgente"), tip.indexOf("interface LinhaTarefa")),
           /^\s{2}\w+[?]?:/gm) === 8);
  ok("C9  thinking/using_tool nao existem no dominio",
     !/thinking|using_tool/i.test(tip));
  ok("C10 ehTipoAgente recusa desconhecido", ehTipoAgente("mensagens") && !ehTipoAgente("zzz"));
  ok("C10b ehTipoAgente aceita o setimo perfil, pelo mesmo caminho",
     ehTipoAgente("personalizado") && !ehTipoAgente("Personalizado") && !ehTipoAgente("custom"));
  ok("C11 ehStatusTarefa recusa desconhecido", ehStatusTarefa("pendente") && !ehStatusTarefa("zzz"));

  // ═══ D. Capability — inspecao de fonte ═════════════════════════════
  console.log("D. Capability — barreiras");

  ok("D0  a fonte foi lida (anti-vacuidade)", cap.length > 1000);
  ok("D1  primeira instrucao e import server-only",
     /^\s*import\s+"server-only";/m.test(capBruta.replace(/\/\*[\s\S]*?\*\//, "").trimStart()));
  ok("D2  usa getSupabaseServidor", /getSupabaseServidor\(\)/.test(cap));
  ok("D3  zero mencao a NEXT_PUBLIC_SUPABASE_ANON_KEY", !/NEXT_PUBLIC_SUPABASE_ANON_KEY/.test(capBruta));
  ok("D4  zero createClient proprio", !/createClient/.test(cap));
  ok("D5  zero select(\"*\")", conta(cap, /select\(\s*["'`]\s*\*/g) === 0);
  ok("D6  nao recebe nem exporta SupabaseClient", !/SupabaseClient/.test(cap));
  ok("D7  projecao de agente e explicita e sem *", /COLUNAS_AGENTE\s*=\s*"id, user_id/.test(cap));
  ok("D8  projecao de tarefa e explicita e sem *", /COLUNAS_TAREFA\s*=/.test(cap) && !/COLUNAS_TAREFA\s*=\s*"\*"/.test(cap));

  // Log: nenhum identificador pode viajar para o console.
  // Inspeciona os ARGUMENTOS, nao a chamada inteira: `console.error`
  // contem a palavra "error" no proprio nome do metodo e casaria com a
  // busca por vazamento de objeto de erro, falhando pelo motivo errado.
  const argsDeLog = (cap.match(/console\.(?:error|log|warn|info)\(([^)]*)\)/g) ?? []).map((l) =>
    l.slice(l.indexOf("(") + 1, -1)
  );
  ok("D9  ha logs a inspecionar (anti-vacuidade)", argsDeLog.length >= 5);
  ok("D9b os argumentos foram extraidos (anti-vacuidade)",
     argsDeLog.every((a) => a.trim().length > 0));
  ok("D10 nenhum log carrega identificador, interpolacao ou objeto de erro",
     argsDeLog.every((a) => !/agenteId|userId|tarefaId|user_id|erro\b|error|\$\{|\+/.test(a)));
  ok("D10b todo log e string literal estatica",
     argsDeLog.every((a) => /^"[^"]*"$/.test(a.trim())));
  ok("D11 nenhum error.message vaza", !/error\.message/.test(cap));

  // ═══ E. Capability — user_id nas 7 operacoes ═══════════════════════
  console.log("E. Capability — user_id nas 7 operacoes");

  // Anti-vacuidade: as 7 precisam EXISTIR antes de se afirmar algo delas.
  const corpos = new Map(AS_7_OPERACOES.map((n) => [n, corpoDaFuncao(cap, n)]));
  ok("E0  as 7 operacoes foram localizadas na fonte",
     AS_7_OPERACOES.every((n) => (corpos.get(n) ?? "").length > 80));
  ok("E1  a capability exporta EXATAMENTE 7 operacoes async",
     conta(cap, /export\s+async\s+function\s/g) === 7);

  for (const nome of OPERACOES_LEITURA) {
    const corpo = corpos.get(nome) ?? "";
    ok(`E2 ${nome}: usa construtor de filtro com user_id`,
       /filtros(AgenteDoDono|AgentesDoDono|TarefaDoDono|TarefasDoAgente)\(/.test(corpo));
  }
  for (const nome of OPERACOES_ESCRITA) {
    const corpo = corpos.get(nome) ?? "";
    ok(`E3 ${nome}: grava user_id vindo do parametro`,
       /user_id:\s*String\(userId\)/.test(corpo));
  }
  // E4 e COMPOSTO, e nao uma busca por texto. Uma leitura como
  // `listarAgentesDoDono` nao contem `user_id` literal no corpo — ela
  // chama `filtrosAgentesDoDono(userId)`, e e o construtor que produz a
  // coluna. Procurar a string no corpo mediria estilo de escrita, nao a
  // invariante. Aqui os construtores sao EXECUTADOS: o que vale e o
  // objeto de filtro que eles realmente devolvem.
  const CONSTRUTORES: Record<string, Record<string, unknown>> = {
    filtrosAgenteDoDono: filtrosAgenteDoDono(AGENTE_A, USUARIO_A),
    filtrosAgentesDoDono: filtrosAgentesDoDono(USUARIO_A),
    filtrosTarefaDoDono: filtrosTarefaDoDono(TAREFA_A, USUARIO_A),
    filtrosTarefasDoAgente: filtrosTarefasDoAgente(AGENTE_A, USUARIO_A),
  };
  ok("E4a os 4 construtores produzem user_id (anti-vacuidade)",
     Object.values(CONSTRUTORES).length === 4 &&
       Object.values(CONSTRUTORES).every((f) => "user_id" in f));
  ok("E4b user_id chega a instrucao nas 7 operacoes",
     AS_7_OPERACOES.every((n) => {
       const corpo = corpos.get(n) ?? "";
       if (/user_id:\s*String\(userId\)/.test(corpo)) return true;
       return Object.entries(CONSTRUTORES).some(
         ([construtor, filtros]) => corpo.includes(`${construtor}(`) && "user_id" in filtros
       );
     }));

  // Os 4 construtores de filtro carregam user_id — provado EXECUTANDO.
  ok("E5  filtrosAgenteDoDono carrega id + user_id",
     JSON.stringify(filtrosAgenteDoDono(AGENTE_A, USUARIO_A)) ===
       JSON.stringify({ id: AGENTE_A, user_id: USUARIO_A }));
  ok("E6  filtrosAgentesDoDono carrega user_id", "user_id" in filtrosAgentesDoDono(USUARIO_A));
  ok("E7  filtrosTarefaDoDono carrega id + user_id",
     "id" in filtrosTarefaDoDono(TAREFA_A, USUARIO_A) && "user_id" in filtrosTarefaDoDono(TAREFA_A, USUARIO_A));
  ok("E8  filtrosTarefasDoAgente carrega agente_id + user_id",
     "agente_id" in filtrosTarefasDoAgente(AGENTE_A, USUARIO_A) &&
       "user_id" in filtrosTarefasDoAgente(AGENTE_A, USUARIO_A));
  ok("E9  filtros normalizam user_id com String()",
     filtrosAgenteDoDono(AGENTE_A, 123 as unknown as string).user_id === "123");

  // Escrita nunca faz spread do input.
  ok("E10 criarAgente nao faz spread de dados", !/\.\.\.\s*dados/.test(corpos.get("criarAgente") ?? ""));
  ok("E11 criarTarefa nao faz spread de dados", !/\.\.\.\s*dados/.test(corpos.get("criarTarefa") ?? ""));
  ok("E12 atualizarAgenteDoDono nao faz spread de campos",
     !/\.\.\.\s*campos/.test(corpos.get("atualizarAgenteDoDono") ?? ""));
  ok("E13 atualizarAgenteDoDono nao aceita user_id nem id",
     !/alteracoes\.(user_id|id)\s*=/.test(corpos.get("atualizarAgenteDoDono") ?? ""));
  ok("E14 criarTarefa nao aceita status nem progresso do chamador",
     !/\bstatus:\s/.test(corpos.get("criarTarefa") ?? "") &&
       !/\bprogresso:\s/.test(corpos.get("criarTarefa") ?? ""));

  // Aridade: nenhuma operacao pode ser chamada sem o par.
  ok("E15 lerAgenteDoDono exige 2 argumentos", lerAgenteDoDono.length === 2);
  ok("E16 lerTarefaDoDono exige 2 argumentos", lerTarefaDoDono.length === 2);
  ok("E17 listarTarefasDoAgente exige 2 argumentos", listarTarefasDoAgente.length === 2);
  ok("E18 atualizarAgenteDoDono exige 3 argumentos", atualizarAgenteDoDono.length === 3);
  ok("E19 criarTarefa exige 3 argumentos", criarTarefa.length === 3);
  ok("E20 criarAgente exige 2 argumentos", criarAgente.length === 2);
  ok("E21 listarAgentesDoDono exige 1 argumento", listarAgentesDoDono.length === 1);

  // ═══ F. Isolamento cross-tenant (executor em memoria) ══════════════
  console.log("F. Isolamento cross-tenant");

  ok("F0  o executor enxerga as duas linhas (anti-vacuidade)",
     selecionar(AGENTES, { user_id: USUARIO_A }).length === 1 &&
       selecionar(AGENTES, { user_id: USUARIO_B }).length === 1);
  ok("F1  agente de A com dono A -> encontra",
     selecionar(AGENTES, filtrosAgenteDoDono(AGENTE_A, USUARIO_A)).length === 1);
  ok("F2  agente de A com dono B -> vazio",
     selecionar(AGENTES, filtrosAgenteDoDono(AGENTE_A, USUARIO_B)).length === 0);
  ok("F3  lista de A nao contem agente de B",
     selecionar(AGENTES, filtrosAgentesDoDono(USUARIO_A)).every((l) => l.id !== AGENTE_B));
  ok("F4  tarefa de A com dono B -> vazio",
     selecionar(TAREFAS, filtrosTarefaDoDono(TAREFA_A, USUARIO_B)).length === 0);
  ok("F5  tarefas do agente de A pedidas por B -> vazio",
     selecionar(TAREFAS, filtrosTarefasDoAgente(AGENTE_A, USUARIO_B)).length === 0);
  ok("F6  tarefas do agente de A pedidas por A -> encontra",
     selecionar(TAREFAS, filtrosTarefasDoAgente(AGENTE_A, USUARIO_A)).length === 1);

  // ═══ G. derivarStatusAgente ════════════════════════════════════════
  console.log("G. derivarStatusAgente");

  const ativo = { ativo: true } as Pick<LinhaAgente, "ativo">;
  const inativo = { ativo: false } as Pick<LinhaAgente, "ativo">;
  const t = (s: string) => ({ status: s }) as Pick<LinhaTarefa, "status">;

  ok("G1  sem tarefas -> idle", derivarStatusAgente(ativo, []) === "idle");
  ok("G2  so concluidas -> idle", derivarStatusAgente(ativo, [t("concluido"), t("cancelado")]) === "idle");
  ok("G3  pendente -> ocupado", derivarStatusAgente(ativo, [t("pendente")]) === "ocupado");
  ok("G4  rodando -> ocupado", derivarStatusAgente(ativo, [t("rodando")]) === "ocupado");
  ok("G5  aguardando_aprovacao vence ocupado",
     derivarStatusAgente(ativo, [t("rodando"), t("aguardando_aprovacao")]) === "aguardando_aprovacao");
  ok("G6  erro vence aguardando_aprovacao",
     derivarStatusAgente(ativo, [t("aguardando_aprovacao"), t("erro")]) === "erro");
  ok("G7  erro vence ocupado", derivarStatusAgente(ativo, [t("rodando"), t("erro")]) === "erro");
  ok("G8  desativado vence TUDO",
     derivarStatusAgente(inativo, [t("erro"), t("rodando"), t("aguardando_aprovacao")]) === "desativado");
  ok("G9  desativado mesmo sem tarefas", derivarStatusAgente(inativo, []) === "desativado");
  ok("G10 e pura: nao muta a entrada", (() => {
       const entrada = [t("rodando")];
       const antes = JSON.stringify(entrada);
       derivarStatusAgente(ativo, entrada);
       return JSON.stringify(entrada) === antes;
     })());
  ok("G11 e determinista: 2 chamadas iguais dao o mesmo",
     derivarStatusAgente(ativo, [t("erro")]) === derivarStatusAgente(ativo, [t("erro")]));
  ok("G12 status desconhecido nao vira ocupado por engano",
     derivarStatusAgente(ativo, [t("status_que_nao_existe")]) === "idle");

  // ═══ H. Maquina de transicao ═══════════════════════════════════════
  console.log("H. Transicoes de tarefa");

  ok("H1  pendente -> rodando", transicaoTarefaPermitida("pendente", "rodando"));
  ok("H2  pendente -> cancelado", transicaoTarefaPermitida("pendente", "cancelado"));
  ok("H3  pendente -> concluido PROIBIDO", !transicaoTarefaPermitida("pendente", "concluido"));
  ok("H4  rodando -> concluido", transicaoTarefaPermitida("rodando", "concluido"));
  ok("H5  rodando -> erro", transicaoTarefaPermitida("rodando", "erro"));
  ok("H6  rodando -> aguardando_aprovacao", transicaoTarefaPermitida("rodando", "aguardando_aprovacao"));
  ok("H7  rodando -> pendente (retry)", transicaoTarefaPermitida("rodando", "pendente"));
  ok("H8  erro -> pendente (retry)", transicaoTarefaPermitida("erro", "pendente"));
  ok("H9  concluido e terminal", TRANSICOES_TAREFA.concluido.length === 0);
  ok("H10 cancelado e terminal", TRANSICOES_TAREFA.cancelado.length === 0);
  ok("H11 nada sai de concluido", STATUS_TAREFA.every((s) => !transicaoTarefaPermitida("concluido", s)));
  ok("H12 nada sai de cancelado", STATUS_TAREFA.every((s) => !transicaoTarefaPermitida("cancelado", s)));
  ok("H13 status desconhecido e recusado (fechado)",
     !transicaoTarefaPermitida("zzz", "rodando") && !transicaoTarefaPermitida("rodando", "zzz"));
  ok("H14 todo destino declarado e um status valido",
     STATUS_TAREFA.every((de) => TRANSICOES_TAREFA[de].every((para) => ehStatusTarefa(para))));
  ok("H15 os terminais declarados batem com a tabela",
     STATUS_TAREFA_TERMINAIS.every((s) => TRANSICOES_TAREFA[s].length === 0));
  ok("H16 a tabela cobre os 6 estados", Object.keys(TRANSICOES_TAREFA).length === 6);

  // ═══ I. Guarda de bundle ═══════════════════════════════════════════
  console.log("I. Guarda de bundle");

  const arquivosCliente: string[] = [];
  const varrer = (dir: string) => {
    let itens: string[];
    try {
      itens = readdirSync(dir);
    } catch {
      return;
    }
    for (const item of itens) {
      if (item === "node_modules" || item === ".next" || item === ".git") continue;
      const caminho = join(dir, item);
      let info;
      try {
        info = statSync(caminho);
      } catch {
        continue;
      }
      if (info.isDirectory()) varrer(caminho);
      else if (/\.(ts|tsx)$/.test(item)) {
        const texto = readFileSync(caminho, "utf8");
        if (/^\s*["']use client["']/m.test(texto)) arquivosCliente.push(caminho);
      }
    }
  };
  varrer(join(RAIZ, "app"));
  varrer(join(RAIZ, "components"));
  varrer(join(RAIZ, "lib"));

  ok("I0  a varredura achou arquivos 'use client' (anti-vacuidade)", arquivosCliente.length >= 5);
  ok("I1  nenhum Client Component importa lib/agentes/capability",
     arquivosCliente.every((c) => !/agentes\/capability/.test(readFileSync(c, "utf8"))));
  ok("I2  tipos.ts nao importa server-only (proposital)", !/import\s+"server-only"/.test(tip));
  ok("I3  tipos.ts nao toca banco nem env", !/createClient|process\.env|supabase/i.test(tip));

  // ═══ J. Escopo — o que a FASE 1B nao pode ter trazido junto ════════
  console.log("J. Escopo da fase");

  const proibidos = /\bn8n\b|ai-gateway|anthropic|@google\/genai|claim_next|worker|memoria_agente|agente_memoria|agente_tools|agente_chat/i;
  ok("J1  capability sem IA/worker/n8n/claim", !proibidos.test(cap));
  ok("J2  tipos sem IA/worker/n8n/claim", !proibidos.test(tip));
  ok("J3  migration nao toca central_ia_consumo", !/central_ia_consumo/i.test(mig));
  ok("J4  migration nao cria tabela de memoria/chat/tools",
     !/agente_(memoria|chat|tools|ferramentas)/i.test(mig));
  ok("J5  capability nao declara provedor/modelo/tools/politica",
     !/provedor|modelo|tools_permitidas|politica_aprovacao/i.test(cap));
  ok("J6  migration nao declara provedor/modelo/tools/politica",
     !/provedor|modelo|tools_permitidas|politica_aprovacao/i.test(mig));

  // ═══ K. Perfil NAO e poder ═════════════════════════════════════════
  //
  // A invariavel que a SKILL-1D.agent-custom-type-B formalizou, e que
  // vale desde a fundacao: `agentes.tipo` e ROTULO. Ele nomeia um ponto
  // de partida e nao concede Skill, Funcao, conexao, permissao nem
  // comportamento privilegiado.
  //
  // Isto e invariavel de DOMINIO, nao regra de formulario — por isso
  // mora aqui. No dia em que alguem escrever
  // `if (agente.tipo === "financeiro") liberar(...)`, o sistema ganha
  // uma segunda autoridade de permissao: invisivel, sem tabela e sem
  // auditoria.
  //
  // As sondas miram a FORMA de conceder poder, nao as palavras. A
  // primeira versao delas varria os valores canonicos soltos e acusava
  // `"fotos"` e `"anuncios"` do Estudio, `typeof dados?.tipo ===
  // "string"` da capability e o `tipo` de pendencia do diagnostico —
  // tres dominios que so compartilham vocabulario. Sonda que acusa o
  // inocente e trocada, nunca tolerada.
  console.log("K. Perfil nao e poder");

  const arquivosDeProducao = (): string[] => {
    const saida: string[] = [];
    const caminhar = (rel: string) => {
      for (const nome of readdirSync(join(RAIZ, rel), { withFileTypes: true })) {
        const filho = `${rel}/${nome.name}`;
        if (nome.isDirectory()) {
          if (!/node_modules|\.next/.test(nome.name)) caminhar(filho);
        } else if (/\.tsx?$/.test(nome.name)) saida.push(filho);
      }
    };
    for (const raiz of ["lib", "app", "components"]) caminhar(raiz);
    return saida.sort();
  };

  const PRODUCAO = arquivosDeProducao();
  ok("K0  ANCORA: a varredura leu producao de verdade",
     PRODUCAO.length > 100 && PRODUCAO.includes(TIPOS));

  // 1. Ramificar por um valor canonico DE AGENTE. `\.tipo === "<valor>"`
  //    e a forma exata; `typeof x.tipo === "string"` nao casa.
  const RAMIFICA =
    /\.tipo\s*===\s*"(personalizado|mensagens|ads|fotos|anuncios|financeiro|gerente)"|switch\s*\(\s*agente\.tipo/;
  const ramificam = PRODUCAO.filter((a) => RAMIFICA.test(codigo(a)));
  ok(`K1  ninguem ramifica por perfil de agente (${ramificam.join(", ") || "nenhum"})`,
     ramificam.length === 0);

  // 2. Mapa exaustivo por perfil. Metadata visual e legitima e vive em
  //    autoridades nominais; qualquer outro `Record<Tipo...>` e o mapa
  //    perigoso nascendo.
  const AUTORIDADES_DE_TIPO = [
    "lib/agentes/tipos.ts",   // canonica do servidor
    "lib/ia/contratos.ts",    // canonica da tela
    "lib/ia/conceitos.ts",    // DESCRICAO_TIPO — apresentacao
    "lib/ia/design.ts",       // CORES_TIPO — apresentacao
  ];
  const mapas = PRODUCAO.filter((a) => /Record<Tipo(Agente|AgenteUI)\b/.test(codigo(a)));
  ok(`K2  mapas exaustivos por perfil so nas autoridades declaradas (${mapas.join(", ")})`,
     mapas.every((a) => AUTORIDADES_DE_TIPO.includes(a)));

  // 3. O nome que esse mapa teria. Pega a intencao antes do conteudo.
  const NOME_PERIGOSO =
    /(tools?|skills?|permissoes|conexoes|capabilidades|capabilities)PorTipo|porTipoDeAgente|TIPO_(PARA|CONCEDE)_/i;
  const batizados = PRODUCAO.filter((a) => NOME_PERIGOSO.test(codigo(a)));
  ok(`K3  ninguem batiza um mapa perfil -> capacidade (${batizados.join(", ") || "nenhum"})`,
     batizados.length === 0);

  // 4. E o perfil nao entra nas leituras que decidem o que o agente pode.
  // O que caracteriza "ler o perfil": tocar o campo do agente ou a
  // autoridade do vocabulario. Nenhum decisor precisa de nenhum dos dois.
  const LE_PERFIL = /\bagente\.tipo\b|TipoAgente\b|TIPOS_AGENTE\b/;
  const DECISORES = [
    "lib/agentes/diagnostico/compositor.ts",
    "lib/agentes/skills/fatos.ts",
    "lib/agentes/conexoes/agregador.ts",
    "lib/agentes/permissoes/fatos.ts",
    "lib/ia/skills/diagnostico.ts",
  ].filter((a) => PRODUCAO.includes(a));
  ok("K4  ANCORA: os cinco decisores existem", DECISORES.length === 5);
  const decisoresSujos = DECISORES.filter((a) => LE_PERFIL.test(codigo(a)));
  ok(`K5  nenhum decisor le o perfil do agente (${decisoresSujos.join(", ") || "nenhum"})`,
     decisoresSujos.length === 0);

  // Validar e LISTAR seguem legitimos — a guarda separa as duas coisas.
  ok("K6  validacao e listagem continuam permitidas",
     /TIPOS_AGENTE as readonly string\[\]\)\.includes/.test(codigo(TIPOS)) &&
     ehTipoAgente("personalizado") && !ehTipoAgente("zzz"));

  ok("K7  CONTROLE: as sondas acusam o padrao que proibem",
     RAMIFICA.test('if (agente.tipo === "financeiro") liberar()') &&
     /Record<Tipo(Agente|AgenteUI)\b/.test("const m: Record<TipoAgente, Tool[]> = {}") &&
     NOME_PERIGOSO.test("const toolsPorTipo = {}"));
  ok("K8  CONTROLE: e NAO acusam o inocente",
     !RAMIFICA.test('typeof dados?.tipo === "string"') &&
     !RAMIFICA.test('if (prompt.tipo === "capa_principal")') &&
     !NOME_PERIGOSO.test("const DESCRICAO_TIPO = {}"));

  // ═══ Placar ════════════════════════════════════════════════════════
  const total = passou + falhou;
  console.log(`\n${"=".repeat(58)}`);
  console.log(`AGENTES-FASE1B — fundacao:  ${passou}/${total} passaram`);
  if (falhou > 0) {
    console.log(`${falhou} FALHARAM`);
    process.exitCode = 1;
  } else {
    console.log("TODOS OS ASSERTS PASSARAM");
  }
  console.log("=".repeat(58));
}

main();
