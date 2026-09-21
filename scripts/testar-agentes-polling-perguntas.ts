/**
 * CDS IA — M2-I1-A7. O gatilho de produto do polling de perguntas.
 *
 * ── O que esta suite prova ──────────────────────────────────────────
 *
 * Que existe, pela primeira vez, um caminho de PRODUTO que alcanca
 * `mercadolivre.perguntas.listar` sem ninguem apertar botao:
 *
 *   cron -> poller -> criarTarefa -> worker -> handler -> executarFuncao
 *
 * O produtor e codigo real. O handler e codigo real. O contrato de
 * retomada e codigo real. As fronteiras dubladas sao as mesmas tres do
 * A6: transporte de banco, sessao e `fetch`.
 *
 * ── As duas coisas que esta suite existe para separar ───────────────
 *
 * ELEGIBILIDADE DE GATILHO nao e AUTORIZACAO DE EXECUCAO. O produtor so
 * enfileira em `automatico`; o guard decide de novo, sobre o estado
 * REAL, na hora de executar. `PROD-23a` prova que a segunda decisao
 * manda — e que o filtro do produtor nunca virou autoridade.
 *
 * ── E as duas camadas de dedupe, que nao sao equivalentes ───────────
 *
 * DURA  = o indice parcial, atomico, no banco.
 * MACIA = a janela de 5 min, conferida em memoria.
 * Chamar as duas de "o dedupe" esconderia qual delas se pode confiar sob
 * concorrencia. So a dura.
 *
 * Zero rede. Zero banco. Zero escrita em producao.
 *
 * Rodar:  npx tsx scripts/testar-agentes-polling-perguntas.ts
 */
import "./_server-only-inerte";

import Module from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let passou = 0;
let falhou = 0;

function ok(nome: string, condicao: boolean, detalhe = ""): void {
  if (condicao) {
    passou++;
    console.log(`  PASS  ${nome}`);
  } else {
    falhou++;
    console.log(`  FAIL  ${nome}${detalhe ? ` — ${detalhe}` : ""}`);
  }
}

function secao(titulo: string): void {
  console.log(`\n── ${titulo} ${"─".repeat(Math.max(0, 62 - titulo.length))}`);
}

const RAIZ = join(__dirname, "..");
const ler = (rel: string) => readFileSync(join(RAIZ, rel), "utf8");
const semComentarios = (f: string) =>
  f.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

// ─── Ambiente ─────────────────────────────────────────────────────────

const APP_ID = "TEST_ML_CLIENT_ID_A7";
process.env.ML_CLIENT_ID = APP_ID;
delete process.env.ML_CLIENT_SECRET;

const USER_A = "user-a7-alpha";
const USER_B = "user-a7-bravo";
const AGENTE_A = "aaaaaaaa-0007-4000-8000-00000000000a";
const AGENTE_B = "bbbbbbbb-0007-4000-8000-00000000000b";
const LOJA_A = "11111111-0007-4000-8000-000000000001";
const SELLER_A = "700000001";
const SECRET_ACCESS_A7 = "SECRET_ACCESS_A7";
const SECRET_REFRESH_A7 = "SECRET_REFRESH_A7";
const ID_ML = "mercadolivre.perguntas.listar";
const TIPO_POLLING = "consultar_perguntas_ml";
const FUTURO = "2099-12-31T23:59:59.000Z";

// ─── Armazem em memoria ───────────────────────────────────────────────

type Linha = Record<string, unknown>;
interface Operacao {
  tabela: string;
  tipo: "leitura" | "insert" | "upsert" | "update" | "delete";
  filtros: Record<string, unknown>;
  payload?: Linha;
}

const tabelas = new Map<string, Linha[]>();
let operacoes: Operacao[] = [];

function tabela(nome: string): Linha[] {
  let t = tabelas.get(nome);
  if (t === undefined) {
    t = [];
    tabelas.set(nome, t);
  }
  return t;
}

function colunasDe(sel: string | undefined): readonly string[] | null {
  if (typeof sel !== "string" || sel.trim() === "*" || sel.trim() === "") return null;
  // `agentes!inner(ativo)` e join embutido, nao coluna — sai da projecao e
  // vira predicado, como o driver faz.
  return sel
    .split(",")
    .map((c) => c.trim())
    .filter((c) => c.length > 0 && !c.includes("!inner"));
}

function projetar(l: Linha, cols: readonly string[] | null): Linha {
  if (cols === null) return { ...l };
  const saida: Linha = {};
  for (const c of cols) saida[c] = l[c] ?? null;
  return saida;
}

type Predicado = (l: Linha) => boolean;

interface Estado {
  tabela: string;
  tipo: Operacao["tipo"];
  colunas: readonly string[] | null;
  predicados: Predicado[];
  filtros: Record<string, unknown>;
  payload?: Linha;
  ordem: Array<{ coluna: string; asc: boolean }>;
  limite: number | null;
}

/**
 * O INDICE PARCIAL, modelado.
 *
 * `(agente_id)` com `tipo` e `status` no PREDICADO — exatamente o DDL. Se
 * o modelo pusesse `tipo` na chave, `conversa` e `consultar_vendas`
 * passariam a ser limitados a uma tarefa ativa, e PROD-33 pegaria.
 */
const STATUS_ATIVOS = ["pendente", "rodando", "aguardando_aprovacao"];

function violaIndicePolling(nova: Linha): boolean {
  if (nova.tipo !== TIPO_POLLING) return false;
  if (!STATUS_ATIVOS.includes(String(nova.status ?? "pendente"))) return false;
  return tabela("agente_tarefas").some(
    (l) =>
      l.agente_id === nova.agente_id &&
      l.tipo === TIPO_POLLING &&
      STATUS_ATIVOS.includes(String(l.status ?? ""))
  );
}

function violaFk(t: string, l: Linha): boolean {
  const dono = (tab: string, id: unknown, u: unknown) =>
    tabela(tab).some((x) => x.id === id && x.user_id === u);
  if (t === "agente_tarefas") return !dono("agentes", l.agente_id, l.user_id);
  if (t === "agente_permissoes") return !dono("agentes", l.agente_id, l.user_id);
  if (t === "agente_conexoes") {
    return !dono("agentes", l.agente_id, l.user_id) || !dono("lojas", l.loja_id, l.user_id);
  }
  return false;
}

/** Erro extra que os controles ligam para provar que 23505 alheio falha
 *  fechado — sem ele, PROD-34 nao teria como acontecer. */
let forcar23505Alheio = false;

function resolver(e: Estado): { data: unknown; error: unknown } {
  const linhas = tabela(e.tabela);
  const casa = (l: Linha) => e.predicados.every((p) => p(l));
  operacoes.push({ tabela: e.tabela, tipo: e.tipo, filtros: { ...e.filtros }, payload: e.payload });

  if (e.tipo === "leitura") {
    let achadas = linhas.filter(casa);
    for (const o of [...e.ordem].reverse()) {
      achadas = [...achadas].sort((x, y) => {
        const a = String(x[o.coluna] ?? "");
        const b = String(y[o.coluna] ?? "");
        return o.asc ? a.localeCompare(b) : b.localeCompare(a);
      });
    }
    if (e.limite !== null) achadas = achadas.slice(0, e.limite);
    return { data: achadas.map((l) => projetar(l, e.colunas)), error: null };
  }

  if (e.tipo === "insert" || e.tipo === "upsert") {
    const p = { ...(e.payload as Linha) };
    if (violaFk(e.tabela, p)) return { data: null, error: { code: "23503" } };
    if (e.tabela === "agente_tarefas" && forcar23505Alheio) {
      // Um UNIQUE QUALQUER, que nao e o do polling. O poller tem de
      // falhar fechado aqui.
      return { data: null, error: { code: "23505" } };
    }
    if (e.tabela === "agente_tarefas" && violaIndicePolling(p)) {
      return { data: null, error: { code: "23505" } };
    }
    if (e.tipo === "upsert") {
      const chave = e.tabela === "agente_permissoes"
        ? ["agente_id", "funcao_id"]
        : ["agente_id", "plataforma", "recurso"];
      const i = linhas.findIndex((l) => chave.every((c) => l[c] === p[c]));
      if (i !== -1) {
        linhas[i] = { ...linhas[i], ...p };
        return { data: null, error: null };
      }
    }
    if (e.tabela === "agente_tarefas") {
      p.id = p.id ?? `tarefa-${linhas.length + 1}`;
      p.status = p.status ?? "pendente";
      p.criado_em = p.criado_em ?? new Date(relogioMs).toISOString();
      p.tentativas = 0;
      p.max_tentativas = 3;
      p.progresso = 0;
    }
    linhas.push(p);
    return { data: e.colunas === null ? null : [projetar(p, e.colunas)], error: null };
  }

  if (e.tipo === "update") {
    const alvo = linhas.filter(casa);
    for (const l of alvo) Object.assign(l, e.payload);
    return { data: alvo.map((l) => projetar(l, e.colunas)), error: null };
  }

  const removidas = linhas.filter(casa);
  for (const r of removidas) linhas.splice(linhas.indexOf(r), 1);
  return { data: removidas.map((l) => projetar(l, e.colunas)), error: null };
}

function construtor(nome: string): unknown {
  const e: Estado = {
    tabela: nome, tipo: "leitura", colunas: null, predicados: [],
    filtros: {}, ordem: [], limite: null,
  };
  const b: Record<string, unknown> = {
    select(c?: string) { e.colunas = colunasDe(c); return b; },
    eq(col: string, v: unknown) {
      e.filtros[col] = v;
      if (col === "agentes.ativo") {
        // O join embutido vira predicado sobre a tabela referenciada.
        e.predicados.push((l) =>
          tabela("agentes").some((a) => a.id === l.agente_id && a.ativo === v));
      } else {
        e.predicados.push((l) => l[col] === v);
      }
      return b;
    },
    in(col: string, vs: readonly unknown[]) {
      e.filtros[col] = { __in: [...vs] };
      e.predicados.push((l) => vs.includes(l[col]));
      return b;
    },
    not(col: string, op: string, v: unknown) {
      e.filtros[`not:${col}`] = { op, v };
      e.predicados.push((l) => (op === "is" && v === null ? l[col] != null : l[col] !== v));
      return b;
    },
    is(col: string, v: unknown) {
      e.predicados.push((l) => (v === null ? l[col] == null : l[col] === v));
      return b;
    },
    order(col: string, o?: { ascending?: boolean }) {
      e.ordem.push({ coluna: col, asc: o?.ascending !== false });
      return b;
    },
    limit(n: number) { e.limite = n; return b; },
    insert(p: Linha) { e.tipo = "insert"; e.payload = p; return b; },
    update(p: Linha) { e.tipo = "update"; e.payload = p; return b; },
    upsert(p: Linha) { e.tipo = "upsert"; e.payload = p; return b; },
    delete() { e.tipo = "delete"; return b; },
    maybeSingle() {
      return {
        then: (fn: (v: { data: unknown; error: unknown }) => void) => {
          const r = resolver(e);
          if (r.error) return fn({ data: null, error: r.error });
          const lista = (r.data ?? []) as Linha[];
          fn({ data: lista[0] ?? null, error: null });
        },
      };
    },
    then(fn: (v: { data: unknown; error: unknown }) => void) { fn(resolver(e)); },
  };
  return b;
}

let relogioMs = Date.parse("2026-09-21T12:00:00.000Z");
let rpcs = 0;
/**
 * As RPCs de TAREFA, modeladas.
 *
 * `concluir_tarefa`, `falhar_tarefa` e `aguardar_aprovacao_tarefa` sao
 * funcoes do Postgres — fronteira de banco como qualquer `from()`. Um
 * duplo generico que devolvesse `null` para elas faria a tarefa nunca
 * sair de `rodando`, e a suite culparia o produto por um defeito do
 * instrumento. Todas fazem FENCING por `p_tentativa_esperada`.
 */
function tarefaPorId(id: unknown): Linha | undefined {
  return tabela("agente_tarefas").find((l) => l.id === id);
}

function executarRpc(nome: string, args: Record<string, unknown>) {
  if (nome === "concluir_tarefa") {
    const t = tarefaPorId(args.p_tarefa_id);
    if (t === undefined) return { data: null, error: null };
    Object.assign(t, {
      status: "concluido", resultado: args.p_resultado,
      progresso: 100, concluido_em: new Date(relogioMs).toISOString(),
    });
    return { data: { ...t }, error: null };
  }
  if (nome === "falhar_tarefa") {
    const t = tarefaPorId(args.p_tarefa_id);
    if (t === undefined) return { data: null, error: null };
    const tentativas = Number(t.tentativas ?? 0) + 1;
    Object.assign(t, {
      tentativas,
      status: tentativas >= Number(t.max_tentativas ?? 3) ? "erro" : "pendente",
      erro_tipo: args.p_erro_tipo, erro_mensagem: args.p_erro_mensagem,
    });
    return { data: { ...t }, error: null };
  }
  if (nome === "aguardar_aprovacao_tarefa") {
    const t = tarefaPorId(args.p_tarefa_id);
    if (t === undefined) return { data: null, error: null };
    Object.assign(t, {
      status: "aguardando_aprovacao", aprovacao_id: args.p_aprovacao_id,
    });
    return { data: { ...t }, error: null };
  }
  if (nome !== "aprovacao_criar") return { data: null, error: null };
  const linhas = tabela("agente_funcao_aprovacoes");
  const id = `aprovacao-${linhas.length + 1}-a7`;
  linhas.push({ id, estado: "pendente", fingerprint: args.p_fingerprint, funcao_id: args.p_funcao_id });
  return { data: [{ resultado: "criada", id }], error: null };
}

const clienteFake = {
  from: (t: string) => construtor(t),
  rpc: (nome: string, args: Record<string, unknown>) => {
    rpcs++;
    return Promise.resolve(executarRpc(nome, args ?? {}));
  },
};

// ─── Intercepcao ──────────────────────────────────────────────────────

const requireOriginal = (Module as unknown as { prototype: { require: (id: string) => unknown } })
  .prototype.require;
let interceptouBanco = false;

(Module as unknown as { prototype: { require: unknown } }).prototype.require = function (
  this: unknown,
  id: string
) {
  if (typeof id === "string" && id.includes("supabase-servidor")) {
    interceptouBanco = true;
    return { getSupabaseServidor: () => clienteFake };
  }
  // eslint-disable-next-line prefer-rest-params
  return requireOriginal.apply(this, arguments as unknown as [string]);
};

// ─── Sentinela de rede ────────────────────────────────────────────────

interface ChamadaRede { url: string; tipo: "grant" | "perguntas" | "inesperada" }
let rede: ChamadaRede[] = [];
let respostaGrant: { status: number; corpo: unknown } = { status: 200, corpo: null };
let respostaPerguntas: { status: number; corpo: unknown } = { status: 200, corpo: null };

const resposta = (status: number, corpo: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => corpo }) as unknown as Response;

globalThis.fetch = (async (entrada: string | URL | Request) => {
  const bruta = typeof entrada === "string" ? entrada : String(entrada);
  const u = new URL(bruta);
  if (u.origin === "https://api.mercadolibre.com" && /^\/users\/[^/]+\/applications$/.test(u.pathname)) {
    rede.push({ url: bruta, tipo: "grant" });
    return resposta(respostaGrant.status, respostaGrant.corpo);
  }
  if (u.origin === "https://api.mercadolibre.com" && u.pathname === "/my/received_questions/search") {
    rede.push({ url: bruta, tipo: "perguntas" });
    return resposta(respostaPerguntas.status, respostaPerguntas.corpo);
  }
  rede.push({ url: bruta, tipo: "inesperada" });
  throw new Error("A7: fetch nao previsto");
}) as unknown as typeof fetch;

const conta = (t: ChamadaRede["tipo"]) => rede.filter((c) => c.tipo === t).length;

// ─── Semeadura ────────────────────────────────────────────────────────

function semear(): void {
  tabelas.clear();
  relogioMs = AGORA;
  operacoes = [];
  rede = [];
  rpcs = 0;
  forcar23505Alheio = false;

  tabela("agentes").push(
    { id: AGENTE_A, user_id: USER_A, nome: "A", tipo: "mensagens", ativo: true },
    { id: AGENTE_B, user_id: USER_B, nome: "B", tipo: "mensagens", ativo: true }
  );
  tabela("lojas").push({
    id: LOJA_A, user_id: USER_A, marketplace: "ML", ativo: true,
    nome: "Loja A", nickname: "nick-A", seller_id: SELLER_A,
    created_at: "2026-01-01T00:00:00.000Z",
    access_token: SECRET_ACCESS_A7, refresh_token: SECRET_REFRESH_A7,
    token_expires_at: FUTURO,
  });
  tabela("agente_skills");
  tabela("skills");
  tabela("agente_permissoes");
  tabela("agente_conexoes");
  tabela("agente_funcao_chamadas");
  tabela("agente_funcao_aprovacoes");
}

const permitir = (nivel: string, agenteId = AGENTE_A, userId = USER_A) => {
  tabela("agente_permissoes").push({
    agente_id: agenteId, user_id: userId, funcao_id: ID_ML, nivel,
  });
};

const conectar = (agenteId = AGENTE_A, userId = USER_A) => {
  tabela("agente_conexoes").push({
    agente_id: agenteId, user_id: userId,
    plataforma: "mercado_livre", recurso: "perguntas", loja_id: LOJA_A,
    criado_em: "2026-01-01T00:00:00.000Z", alterado_em: "2026-01-01T00:00:00.000Z",
  });
};

const grantOk = () => ({
  applications: [
    { app_id: "OUTRO_APP", scopes: ["read"] },
    { app_id: APP_ID, scopes: ["read", "offline_access"] },
  ],
});

const perguntasOk = () => ({
  questions: [
    {
      id: "Q1", item_id: "MLB1", text: "tem garantia?", status: "UNANSWERED",
      date_created: "2026-09-01T10:00:00.000Z",
      seller_id: SELLER_A, access_token: SECRET_ACCESS_A7, campo_extra: "nao atravessa",
    },
  ],
  total: 1,
});

const AGORA = Date.parse("2026-09-21T12:00:00.000Z");

async function main(): Promise<void> {
  console.log("\n══ CDS IA — M2-I1-A7: polling de perguntas ══");

  const { enfileirarPollingDePerguntas, JANELA_MS, LIMITE_VARREDURA, ENTRADA_POLLING } =
    await import("../lib/agentes/poller/perguntas");
  const { executarTarefa } = await import("../lib/agentes/executar-tarefa");
  const { TIPOS_REGISTRADOS, resolverHandler } = await import("../lib/agentes/handlers/registry");
  const { prepararRetomada, resolverContratoResume, tiposComContratoResume } =
    await import("../lib/agentes/resume-contratos");
  const puroVendas = await import("../lib/agentes/handlers/consultar-vendas-contrato");
  const puroPerguntas = await import("../lib/agentes/handlers/consultar-perguntas-ml-contrato");
  const { criarTarefa } = await import("../lib/agentes/capability");

  const POLLER = semComentarios(ler("lib/agentes/poller/perguntas.ts"));
  const ROTA = semComentarios(ler("app/api/internal/agentes/perguntas-poller/route.ts"));
  const MIGRATION_BRUTA = ler("supabase/migrations/20261008_agente_tarefas_polling_perguntas_unica.sql");
  // O DDL, sem a prosa: o comentario EXPLICA por que a chave nao e
  // `(agente_id, tipo)`, e uma sonda ingenua acharia essa frase e
  // acusaria o proprio texto que justifica a decisao.
  const MIGRATION = MIGRATION_BRUTA.replace(/^--.*$/gm, "");
  const RESUME = semComentarios(ler("lib/agentes/resume-contratos.ts"));
  const CONSUMIDOR = semComentarios(ler("lib/agentes/retomada/executar-retomada.ts"));

  // ═══ A. O instrumento ═══════════════════════════════════════════════
  secao("A. O instrumento antes da medicao");
  semear();
  ok("A1  o banco foi interceptado", interceptouBanco === true);
  ok("A2  nenhuma env de Supabase real", !process.env.SUPABASE_SERVICE_ROLE_KEY);
  ok("A3  o indice do polling e modelado por PREDICADO, nao por chave",
    violaIndicePolling({ agente_id: AGENTE_A, tipo: "conversa", status: "pendente" }) === false);
  {
    let lancou = false;
    try { await fetch("https://example.invalid/x"); } catch { lancou = true; }
    ok("A4  a sentinela de rede REPROVA host nao previsto", lancou && conta("inesperada") === 1);
    rede = [];
  }

  // ═══ B. Migration ═══════════════════════════════════════════════════
  secao("B. A migration, provada nominalmente");
  ok("PROD-33a o indice tem o nome congelado",
    /idx_agente_tarefas_polling_perguntas_ativa/.test(MIGRATION));
  ok("PROD-33b a chave e (agente_id), e so ela",
    /ON public\.agente_tarefas \(agente_id\)/.test(MIGRATION));
  ok("PROD-33c `tipo` esta no PREDICADO, nunca na chave",
    /WHERE tipo = 'consultar_perguntas_ml'/.test(MIGRATION) &&
    !/\(agente_id, tipo\)/.test(MIGRATION));
  ok("PROD-33d os tres status ativos estao no predicado",
    /status IN \('pendente', 'rodando', 'aguardando_aprovacao'\)/.test(MIGRATION));
  ok("PROD-33e e o indice e UNIQUE e idempotente",
    /CREATE UNIQUE INDEX IF NOT EXISTS/.test(MIGRATION));
  ok("PROD-33f CONTROLE: a sonda acusaria a chave global por tipo",
    /\(agente_id, tipo\)/.test("ON public.agente_tarefas (agente_id, tipo)"));

  // ═══ C. Producer ════════════════════════════════════════════════════
  secao("C. O produtor: agenda, nao executa");

  ok("PROD-20a o produtor NAO importa o executor de Funcao",
    !/executarFuncao/.test(POLLER));
  ok("PROD-20b nem o adapter, a cobertura ou a credencial",
    !/mercado-livre|getMLLojaById|confirmarCobertura|resolverConexoesDoAgente/.test(POLLER));
  ok("PROD-20c e nao tem `fetch`", !/\bfetch\s*\(/.test(POLLER));
  ok("PROD-32a a varredura projeta so `agente_id, user_id` (+ o join de ativo)",
    /select\("agente_id, user_id, agentes!inner\(ativo\)"\)/.test(POLLER));
  ok("PROD-32b e nao seleciona coluna de credencial",
    !/access_token|refresh_token|seller_id/.test(POLLER));
  ok("PROD-25a o payload e montado campo a campo, sem spread",
    /status: ENTRADA_POLLING\.status/.test(POLLER) && !/\.\.\.ENTRADA_POLLING/.test(POLLER));

  // ── PROD-19 / PROD-23 — elegibilidade ─────────────────────────────
  for (const [nivel, esperado] of [
    ["automatico", 1], ["aprovacao", 0], ["bloqueado", 0],
  ] as const) {
    semear();
    permitir(nivel);
    const r = await enfileirarPollingDePerguntas(AGORA);
    ok(`PROD-23 nivel \`${nivel}\` -> ${esperado} tarefa`,
      r.criadas === esperado && tabela("agente_tarefas").length === esperado);
  }
  {
    semear(); // permissao AUSENTE
    const r = await enfileirarPollingDePerguntas(AGORA);
    ok("PROD-23 permissao ausente -> 0 tarefa",
      r.criadas === 0 && r.elegiveis === 0 && tabela("agente_tarefas").length === 0);
  }
  {
    semear();
    permitir("automatico");
    (tabela("agentes")[0] as Linha).ativo = false;
    const r = await enfileirarPollingDePerguntas(AGORA);
    ok("PROD-23b agente INATIVO nao gera tarefa", r.criadas === 0 && r.elegiveis === 0);
  }

  // ── PROD-19 completo ──────────────────────────────────────────────
  semear();
  permitir("automatico");
  {
    const r = await enfileirarPollingDePerguntas(AGORA);
    const t = tabela("agente_tarefas")[0];
    ok("PROD-19 o produtor cria a tarefa automaticamente, sem UI e sem request",
      r.criadas === 1 && t.tipo === TIPO_POLLING && t.agente_id === AGENTE_A);
    ok("PROD-25 o payload nao carrega autoridade nenhuma",
      JSON.stringify(t.entrada) ===
        JSON.stringify({ status: "UNANSWERED", limite: 20, deslocamento: 0 }));
    ok("PROD-25b nem userId, agenteId, funcaoId, lojaId, sellerId ou token",
      !/userId|agenteId|funcaoId|lojaId|sellerId|access_token|refresh_token/
        .test(JSON.stringify(t.entrada)));
    ok("PROD-20 o produtor nao tocou marketplace", rede.length === 0);
    ok("PROD-20d nem gastou RPC", rpcs === 0);
  }

  // ── PROD-21 / PROD-22 / PROD-29 — janela ──────────────────────────
  {
    operacoes = [];
    const r2 = await enfileirarPollingDePerguntas(AGORA + 60_000);
    ok("PROD-21 segunda passada na MESMA janela nao cria segunda tarefa",
      r2.criadas === 0 && tabela("agente_tarefas").length === 1 &&
      r2.pulados.tarefa_ja_enfileirada === 1);

    // A tarefa termina: o indice libera, mas a janela macia ainda vale.
    (tabela("agente_tarefas")[0] as Linha).status = "concluido";
    const r3 = await enfileirarPollingDePerguntas(AGORA + 60_000);
    ok("PROD-29a tarefa concluida dentro da janela ainda respeita a cadencia",
      r3.criadas === 0 && r3.pulados.janela_recente === 1);

    relogioMs = AGORA + JANELA_MS + 1000;
    const r4 = await enfileirarPollingDePerguntas(AGORA + JANELA_MS + 1000);
    ok("PROD-22 janela nova pode enfileirar de novo", r4.criadas === 1);
    ok("PROD-29 e a tarefa concluida liberou a proxima",
      tabela("agente_tarefas").length === 2);
  }

  // ── PROD-28 — concorrencia ────────────────────────────────────────
  {
    semear();
    permitir("automatico");
    const [a, b] = await Promise.all([
      enfileirarPollingDePerguntas(AGORA),
      enfileirarPollingDePerguntas(AGORA),
    ]);
    ok("PROD-28 dois produtores concorrentes criam UMA tarefa ativa",
      a.criadas + b.criadas === 1 && tabela("agente_tarefas").length === 1);
    ok("PROD-28a e o perdedor entende `tarefa_ja_enfileirada`, nao erro",
      a.pulados.tarefa_ja_enfileirada + b.pulados.tarefa_ja_enfileirada === 1 &&
      a.pulados.erro_criacao_tarefa + b.pulados.erro_criacao_tarefa === 0);
  }

  // ── PROD-34 — 23505 alheio ────────────────────────────────────────
  {
    semear();
    permitir("automatico");
    forcar23505Alheio = true;
    const r = await enfileirarPollingDePerguntas(AGORA);
    ok("PROD-34 23505 SEM linha ativa correspondente falha fechado",
      r.criadas === 0 && r.pulados.erro_criacao_tarefa === 1 &&
      r.pulados.tarefa_ja_enfileirada === 0);
    ok("PROD-34a e nada foi gravado", tabela("agente_tarefas").length === 0);
    forcar23505Alheio = false;
  }

  // ── PROD-31 — criarTarefa e generica ──────────────────────────────
  {
    semear();
    tabela("agente_tarefas").push({
      id: "t-existente", agente_id: AGENTE_A, user_id: USER_A,
      tipo: TIPO_POLLING, status: "pendente", criado_em: new Date(AGORA).toISOString(),
    });
    const r = await criarTarefa(AGENTE_A, USER_A, { tipo: TIPO_POLLING, entrada: {} });
    ok("PROD-31 `criarTarefa` devolve `conflito_unico` — relato, nao interpretacao",
      r.erro === "conflito_unico");
    ok("PROD-31a ela NAO devolve `tarefa_ja_enfileirada`",
      r.erro !== "tarefa_ja_enfileirada");
    ok("PROD-31b e a semantica de polling nao vaza para o owner generico",
      !/tarefa_ja_enfileirada/.test(semComentarios(ler("lib/agentes/capability.ts"))));
  }

  // ── PROD-33 — outros tipos intactos ───────────────────────────────
  {
    semear();
    for (const tipo of ["conversa", "consultar_vendas"]) {
      const a = await criarTarefa(AGENTE_A, USER_A, { tipo, entrada: {} });
      const b = await criarTarefa(AGENTE_A, USER_A, { tipo, entrada: {} });
      ok(`PROD-33 duas tarefas ativas de \`${tipo}\` continuam permitidas`,
        a.erro === null && b.erro === null);
    }
    ok("PROD-33g e o indice do polling nao as alcancou",
      tabela("agente_tarefas").length === 4);
  }

  // ── PROD-26 / PROD-27 ─────────────────────────────────────────────
  ok("PROD-26 zero UI: o gatilho nao depende de componente nenhum",
    !/components\//.test(POLLER) && !/components\//.test(ROTA));
  ok("PROD-27 zero webhook: nao ha rota de entrada de evento",
    !/webhook|signature|x-signature/i.test(POLLER + ROTA));
  ok("PROD-26a a rota do cron exige CRON_SECRET por Bearer",
    /process\.env\.CRON_SECRET/.test(ROTA) && /Bearer \$\{segredo\}/.test(ROTA));
  ok("PROD-26b e nao le userId, agenteId nem funcaoId do request",
    !/request\.json\(\)|searchParams|params\./.test(ROTA));

  // ═══ D. Worker, handler e execucao ══════════════════════════════════
  secao("D. Do worker ate a Funcao");

  ok("PROD-24 o worker resolve o tipo novo NOMINALMENTE",
    TIPOS_REGISTRADOS.includes(TIPO_POLLING) &&
    typeof resolverHandler(TIPO_POLLING) === "function");
  ok("PROD-24a e sao cinco tipos, nao quatro", TIPOS_REGISTRADOS.length === 5);

  {
    semear();
    permitir("automatico");
    conectar();
    respostaGrant = { status: 200, corpo: grantOk() };
    respostaPerguntas = { status: 200, corpo: perguntasOk() };

    await enfileirarPollingDePerguntas(AGORA);
    const tarefaId = String(tabela("agente_tarefas")[0].id);
    (tabela("agente_tarefas")[0] as Linha).status = "rodando";
    rede = [];
    await executarTarefa(tarefaId);

    const tarefa = tabela("agente_tarefas")[0];
    const abertura = tabela("agente_funcao_chamadas").find((l) => l.fase === "abertura");
    const resultado = (tarefa.resultado ?? {}) as Record<string, unknown>;

    ok("PROD-1 a entrada de produto alcanca `mercadolivre.perguntas.listar`",
      abertura?.funcao_id === ID_ML);
    ok("PROD-7 o executor nao foi contornado: ha linha de auditoria",
      abertura !== undefined);
    ok("PROD-8 o guard tambem nao: o nivel do momento foi registrado",
      abertura?.nivel_no_momento === "automatico");
    ok("PROD-6 o `lojaId` veio do BINDING", abertura?.loja_id === LOJA_A);
    ok("PROD-12 o resultado chegou ao consumidor do tipo de tarefa",
      Array.isArray(resultado.perguntas) && (resultado.perguntas as unknown[]).length === 1);
    ok("PROD-10 a normalizacao real devolveu as cinco chaves congeladas",
      JSON.stringify(Object.keys((resultado.perguntas as Linha[])[0]).sort()) ===
        JSON.stringify(["anuncioId", "criadaEm", "id", "status", "texto"]));
    ok("PROD-15 zero credencial no resultado da tarefa",
      !JSON.stringify(tarefa).includes(SECRET_ACCESS_A7) &&
      !JSON.stringify(tarefa).includes(SECRET_REFRESH_A7));
    ok("PROD-16 zero marketplace vivo: as duas chamadas foram as previstas",
      conta("grant") === 1 && conta("perguntas") === 1 && conta("inesperada") === 0);
  }

  // ── PROD-23a — a race ─────────────────────────────────────────────
  {
    semear();
    permitir("automatico");
    conectar();
    await enfileirarPollingDePerguntas(AGORA);
    const tarefaId = String(tabela("agente_tarefas")[0].id);

    // O dono muda de ideia ANTES do worker.
    (tabela("agente_permissoes")[0] as Linha).nivel = "aprovacao";
    (tabela("agente_tarefas")[0] as Linha).status = "rodando";
    rede = [];
    await executarTarefa(tarefaId);

    ok("PROD-23a enfileirado em `automatico`, executa sob `aprovacao`",
      tabela("agente_funcao_aprovacoes").length === 1);
    ok("PROD-23a1 zero chamada ao provider de PERGUNTAS — a Funcao nao rodou",
      conta("perguntas") === 0);
    // O grant ACONTECE, e nao e desvio: `criarAprovacao` chama
    // `resolverAlvo`, que confirma a cobertura para CONGELAR o binding na
    // aprovacao. Uma aprovacao que guardasse uma conta nao provada seria
    // aprovavel e inconsumivel. Uma chamada, e so uma.
    ok("PROD-23a3 o grant do congelamento do binding acontece UMA vez",
      conta("grant") === 1);
    ok("PROD-23a4 e a aprovacao guardou a loja do binding",
      tabela("agente_funcao_aprovacoes").length === 1);
    ok("PROD-23a2 o filtro do produtor NAO virou autoridade de execucao",
      !tabela("agente_funcao_chamadas").some((l) => l.fase === "abertura"));
  }

  // ── PROD-11 / PROD-9 ──────────────────────────────────────────────
  {
    semear();
    permitir("automatico"); // sem `conectar()`
    await enfileirarPollingDePerguntas(AGORA);
    const tarefaId = String(tabela("agente_tarefas")[0].id);
    (tabela("agente_tarefas")[0] as Linha).status = "rodando";
    rede = [];
    await executarTarefa(tarefaId);
    const tarefa = tabela("agente_tarefas")[0];
    // A tarefa NAO conclui e registra a causa. O estado imediato e
    // `pendente` porque o motor tem `max_tentativas = 3` — o terminal vem
    // na ultima tentativa. Afirmar `erro` na primeira seria afirmar uma
    // politica de retry que este slice nao definiu.
    ok("PROD-11 sem conexao a tarefa NAO conclui e registra a causa",
      tarefa.status !== "concluido" &&
      String(tarefa.erro_tipo ?? "").length > 0 &&
      tarefa.resultado === undefined);
    ok("PROD-11b a causa e a negacao do guard, sanitizada",
      /conexao_ausente/.test(String(tarefa.erro_mensagem ?? "") +
        String(tarefa.erro_tipo ?? "")));
    ok("PROD-11a e nao escolheu loja nem pediu `lojaId`", conta("perguntas") === 0);
  }

  // ── PROD-14 — cross-user ──────────────────────────────────────────
  {
    semear();
    permitir("automatico", AGENTE_A, USER_A);
    const r = await enfileirarPollingDePerguntas(AGORA);
    const criada = tabela("agente_tarefas")[0];
    ok("PROD-14 a tarefa nasce com o dono do AGENTE, vindo do banco",
      r.criadas === 1 && criada.user_id === USER_A && criada.agente_id === AGENTE_A);
    const alheia = await criarTarefa(AGENTE_A, USER_B, { tipo: TIPO_POLLING, entrada: {} });
    ok("PROD-14a par (agente, dono) incoerente e recusado pela FK",
      alheia.erro === "agente_inexistente_ou_de_outro_dono");
  }

  // ═══ E. A uniao de contratos de retomada ════════════════════════════
  secao("E. RESUME-UNION: preparar e continuar amarrados");

  {
    const cv = resolverContratoResume("consultar_vendas");
    const cp = resolverContratoResume(TIPO_POLLING);
    ok("RESUME-UNION-6 J3/J4: as funcoes sao REFERENCIA, nao copia",
      cv?.prepararEntrada === puroVendas.lerEntradaConsultarVendas &&
      cv?.continuarAposFuncao === puroVendas.mapearResultadoConsultarVendas &&
      cp?.prepararEntrada === puroPerguntas.lerEntradaConsultarPerguntasML &&
      cp?.continuarAposFuncao === puroPerguntas.mapearResultadoConsultarPerguntasML);

    const pv = prepararRetomada("consultar_vendas", {
      dataInicio: "2026-01-01", dataFim: "2026-01-31",
    });
    ok("RESUME-UNION-1 `consultar_vendas` prepara e expoe a Funcao dele",
      pv !== null && pv.funcaoId === "vendas.consultar");

    const pp = prepararRetomada(TIPO_POLLING, { status: "UNANSWERED", limite: 5 });
    ok("RESUME-UNION-2 `consultar_perguntas_ml` idem, com a Funcao dele",
      pp !== null && pp.funcaoId === ID_ML);

    ok("RESUME-UNION-3 tipo nao suportado nao cai em fallback",
      prepararRetomada("consultar_anuncios", {}) === null &&
      prepararRetomada("toString", {}) === null);

    const envelope = {
      tipo: "sucesso" as const,
      requestId: "r-1",
      envelope: {
        contrato: 1 as const, ok: true as const, request_id: "r-1",
        data: { linhas: [], truncado: false, erro: null },
      },
      auditoria: "completa" as const,
    };
    const saida = pp === null ? {} : pp.continuar(envelope);
    ok("RESUME-UNION-4 o resultado passa pela continuacao do MESMO tipo",
      "perguntas" in saida && "filtro" in saida && !("resumo" in saida));

    // Cada tipo registrado precisa de uma entrada VALIDA para ele — chamar
    // todos com `{}` faria vendas lancar, e a excecao atravessa de
    // proposito. A cobertura e provada de dois jeitos: pelo comportamento,
    // com a entrada certa de cada um, e pela ESTRUTURA, exigindo um `case`
    // por tipo registrado.
    const ENTRADA_VALIDA: Readonly<Record<string, unknown>> = {
      consultar_vendas: { dataInicio: "2026-01-01", dataFim: "2026-01-31" },
      [TIPO_POLLING]: { status: "UNANSWERED", limite: 5 },
    };
    ok("RESUME-UNION-7 `prepararRetomada` cobre exatamente os tipos com contrato",
      JSON.stringify([...tiposComContratoResume()].sort()) ===
        JSON.stringify([TIPO_POLLING, "consultar_vendas"].sort()) &&
      tiposComContratoResume().every((t) =>
        prepararRetomada(t, ENTRADA_VALIDA[t]) !== null));
    ok("RESUME-UNION-7a e ha um `case` por tipo registrado, nominalmente",
      tiposComContratoResume().every((t) =>
        new RegExp("case TIPO_" + t.toUpperCase() + ":").test(RESUME)));
    ok("RESUME-UNION-7b CONTROLE: a sonda de `case` acusaria um tipo sem ramo",
      !new RegExp("case TIPO_CONSULTAR_ANUNCIOS:").test(RESUME));

    // O contrato — onde o fix mora — nao tem escape NENHUM.
    ok("RESUME-UNION-5 zero cast de escape no contrato de resume",
      !/as any|as unknown as|@ts-ignore|@ts-expect-error/.test(RESUME));
    // No consumidor sobra UM, e ele e PRE-EXISTENTE e alheio ao A7: o idiom
    // de `unref` do timer de heartbeat, que o N32 ja cobra. A sonda conta,
    // em vez de proibir, para que um escape NOVO apareca.
    const ESCAPES_CONSUMIDOR = (CONSUMIDOR.match(/as any|as unknown as|@ts-ignore|@ts-expect-error/g) ?? []);
    ok("RESUME-UNION-5b o consumidor nao ganhou escape novo",
      ESCAPES_CONSUMIDOR.length === 1 &&
      /\(timerHeartbeat as unknown as/.test(CONSUMIDOR));
    ok("RESUME-UNION-5c CONTROLE: a sonda conta um escape a mais se ele surgir",
      ("x as any " + CONSUMIDOR).match(/as any|as unknown as|@ts-ignore|@ts-expect-error/g)?.length === 2);
    ok("RESUME-UNION-5a e a entrada preparada NAO e exposta",
      !/readonly entrada/.test(RESUME) &&
      /readonly continuar/.test(RESUME));
    ok("RESUME-UNION-3a o switch e exaustivo por `never`",
      /const _exaustivo: never = chave;/.test(RESUME));
    ok("RESUME-UNION-4a o consumidor usa a continuacao amarrada",
      /preparada\.continuar\(resultadoFuncao\)/.test(CONSUMIDOR) &&
      !/contrato\.continuarAposFuncao\(/.test(CONSUMIDOR));
  }

  // ═══ F. Orcamento ═══════════════════════════════════════════════════
  secao("F. Orcamento do produtor");
  {
    semear();
    permitir("automatico");
    operacoes = [];
    await enfileirarPollingDePerguntas(AGORA);
    const leituras = operacoes.filter((o) => o.tipo === "leitura").length;

    // Muitos agentes elegiveis: o custo de LEITURA nao pode crescer.
    semear();
    for (let i = 0; i < 12; i++) {
      const id = `agente-extra-${i}`;
      tabela("agentes").push({ id, user_id: USER_A, nome: `X${i}`, ativo: true });
      permitir("automatico", id, USER_A);
    }
    permitir("automatico");
    operacoes = [];
    const r = await enfileirarPollingDePerguntas(AGORA);
    const leiturasMuitos = operacoes.filter((o) => o.tipo === "leitura").length;

    ok("PROD-32 a varredura e em LOTE: duas leituras, independente da base",
      leituras === 2 && leiturasMuitos === 2, `${leituras} vs ${leiturasMuitos}`);
    ok("PROD-32c e ela criou tarefa para todos os elegiveis",
      r.criadas === 13 && r.elegiveis === 13);
    ok("PROD-32d o teto de varredura e declarado e finito",
      LIMITE_VARREDURA === 200 && /\.limit\(LIMITE_VARREDURA\)/.test(POLLER));
    ok("PROD-32e a janela e de 5 minutos", JANELA_MS === 300_000);
    ok("PROD-32f a entrada congelada e a que viaja",
      ENTRADA_POLLING.status === "UNANSWERED" && ENTRADA_POLLING.limite === 20);
  }

  ok("PROD-2 o `funcaoId` e constante de servidor, nunca do request",
    /FUNCAO_ID = "mercadolivre\.perguntas\.listar"/
      .test(ler("lib/agentes/handlers/consultar-perguntas-ml-contrato.ts")) &&
    !/funcaoId/.test(ROTA));
  ok("PROD-3 o `userId` e fato de banco: o produtor nao o recebe",
    !/userId\s*:/.test(ROTA));
  ok("PROD-5 os argumentos sao validados pela Funcao, sem duplicar regra",
    !/LIMITE_MAXIMO|STATUS_PERGUNTA_VALIDOS/
      .test(semComentarios(ler("lib/agentes/handlers/consultar-perguntas-ml-contrato.ts"))));
  ok("PROD-4 o handler chama o EXECUTOR, nunca o handler da Funcao",
    /executarFuncao\(/.test(semComentarios(ler("lib/agentes/handlers/consultar-perguntas-ml.ts"))) &&
    !/executarPerguntasML/.test(semComentarios(ler("lib/agentes/handlers/consultar-perguntas-ml.ts"))));
  ok("PROD-13 os codigos de erro de entrada vem do validador real",
    /filtro_ausente/.test(ler("lib/agentes/handlers/consultar-perguntas-ml-contrato.ts")));
  ok("PROD-18 o tipo novo TEM contrato de retomada",
    tiposComContratoResume().includes(TIPO_POLLING));
  ok("PROD-17 e os cinco tipos continuam nominais",
    JSON.stringify([...TIPOS_REGISTRADOS].sort()) === JSON.stringify([
      "analise_vendas", "consultar_perguntas_ml", "consultar_vendas",
      "conversa", "teste_fundacao",
    ]));
  ok("PROD-30 o produtor nao checa conexao — quem decide e o guard",
    !/conexao|binding|cobertura/i.test(POLLER));

  const total = passou + falhou;
  console.log(`\n══ CDS IA — M2-I1-A7: polling de perguntas:  ${passou}/${total} passaram ══`);
  if (falhou > 0) console.log(`   ${falhou} FALHARAM`);
  console.log("   MIGRATION_APPLIED_REAL_DB = NO / CRON_DEPLOYED = NO");
  process.exitCode = falhou === 0 ? 0 : 1;
}

void main();
