/**
 * CDS IA — M2-I1-A8a. A ponte de orquestracao externa.
 *
 * ── O que esta suite prova ──────────────────────────────────────────
 *
 * Que um orquestrador externo consegue acionar o CDS com seguranca, e que
 * NADA da autoridade do CDS atravessa a fronteira no caminho:
 *
 *   requisicao falsa de n8n
 *   -> rota REAL, autenticada por segredo proprio
 *   -> dono resolvido no CDS, a partir do agente
 *   -> catalogo FECHADO traduz acao em Funcao
 *   -> `executarFuncao` real: permissao, binding, cobertura, guard
 *   -> adapter real, provider dublado
 *   -> resultado sanitizado
 *
 * ── O que esta suite NAO prova ──────────────────────────────────────
 *
 * Nao ha n8n de verdade. A requisicao e construida aqui, e o que se prova
 * e o CONTRATO da porta — nao que algum workflow real saiba usa-la.
 *
 * ── Aprovacao TERMINA ───────────────────────────────────────────────
 *
 * Nesta versao a ponte devolve `aguardando_aprovacao` e acaba. Nao ha
 * retomada, callback nem polling de decisao — e a suite prova que o
 * provider nao e chamado nesse ramo.
 *
 * Zero rede. Zero banco. Zero escrita em producao.
 *
 * Rodar:  npx tsx scripts/testar-agentes-ponte-n8n.ts
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

const SEGREDO = "SEGREDO_PONTE_A8_SINTETICO";
const APP_ID = "TEST_ML_CLIENT_ID_A8";
process.env.N8N_BRIDGE_INTERNAL_SECRET = SEGREDO;
process.env.ML_CLIENT_ID = APP_ID;
delete process.env.ML_CLIENT_SECRET;

const USER_A = "user-a8-alpha";
const USER_B = "user-a8-bravo";
const AGENTE_A = "aaaaaaaa-0008-4000-8000-00000000000a";
const AGENTE_B = "bbbbbbbb-0008-4000-8000-00000000000b";
const AGENTE_OFF = "cccccccc-0008-4000-8000-00000000000c";
const LOJA_A = "11111111-0008-4000-8000-000000000001";
const SELLER_A = "800000001";
const SECRET_ACCESS_A8 = "SECRET_ACCESS_A8";
const SECRET_REFRESH_A8 = "SECRET_REFRESH_A8";
const ID_ML = "mercadolivre.perguntas.listar";
const ACAO = "consultar_perguntas";
const FUTURO = "2099-12-31T23:59:59.000Z";

// ─── Armazem em memoria ───────────────────────────────────────────────

type Linha = Record<string, unknown>;
interface Operacao {
  tabela: string;
  tipo: "leitura" | "insert" | "upsert" | "update" | "delete";
  colunas: readonly string[] | null;
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
  return sel.split(",").map((c) => c.trim()).filter((c) => c.length > 0);
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
 * O INDICE UNICO PARCIAL de idempotencia, modelado.
 *
 * `(user_id, funcao_id, idempotency_key) WHERE fase='abertura' AND
 * idempotency_key IS NOT NULL`. E ele — e nao o TypeScript — que impede a
 * segunda abertura da mesma execucao.
 */
function violaIdempotencia(nova: Linha): boolean {
  if (nova.fase !== "abertura") return false;
  const chave = nova.idempotency_key;
  if (chave === null || chave === undefined) return false;
  return tabela("agente_funcao_chamadas").some(
    (l) =>
      l.fase === "abertura" &&
      l.idempotency_key === chave &&
      l.user_id === nova.user_id &&
      l.funcao_id === nova.funcao_id
  );
}

function violaFk(t: string, l: Linha): boolean {
  const dono = (tab: string, id: unknown, u: unknown) =>
    tabela(tab).some((x) => x.id === id && x.user_id === u);
  if (t === "agente_tarefas" || t === "agente_permissoes") {
    return !dono("agentes", l.agente_id, l.user_id);
  }
  if (t === "agente_conexoes") {
    return !dono("agentes", l.agente_id, l.user_id) || !dono("lojas", l.loja_id, l.user_id);
  }
  return false;
}

function resolver(e: Estado): { data: unknown; error: unknown } {
  const linhas = tabela(e.tabela);
  const casa = (l: Linha) => e.predicados.every((p) => p(l));
  operacoes.push({
    tabela: e.tabela, tipo: e.tipo, colunas: e.colunas,
    filtros: { ...e.filtros }, payload: e.payload,
  });

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
    if (e.tabela === "agente_funcao_chamadas" && violaIdempotencia(p)) {
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
    p.id = p.id ?? `${e.tabela}-${linhas.length + 1}`;
    p.criado_em = p.criado_em ?? new Date().toISOString();
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
    eq(col: string, v: unknown) { e.filtros[col] = v; e.predicados.push((l) => l[col] === v); return b; },
    in(col: string, vs: readonly unknown[]) {
      e.filtros[col] = { __in: [...vs] };
      e.predicados.push((l) => vs.includes(l[col]));
      return b;
    },
    not(col: string, op: string, v: unknown) {
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
    upsert(p: Linha) { e.tipo = "upsert"; e.payload = p; return b; },
    update(p: Linha) { e.tipo = "update"; e.payload = p; return b; },
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

let rpcs = 0;
function executarRpc(nome: string, args: Record<string, unknown>) {
  if (nome !== "aprovacao_criar") return { data: null, error: null };
  const linhas = tabela("agente_funcao_aprovacoes");
  const id = `aprovacao-${linhas.length + 1}-a8`;
  linhas.push({ id, estado: "pendente", funcao_id: args.p_funcao_id, fingerprint: args.p_fingerprint });
  return { data: [{ resultado: "criada", id }], error: null };
}

const clienteFake = {
  from: (t: string) => construtor(t),
  rpc: (nome: string, args: Record<string, unknown>) => {
    rpcs++;
    return Promise.resolve(executarRpc(nome, args ?? {}));
  },
};

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
  throw new Error("A8: fetch nao previsto");
}) as unknown as typeof fetch;

const conta = (t: ChamadaRede["tipo"]) => rede.filter((c) => c.tipo === t).length;
const aberturas = () =>
  tabela("agente_funcao_chamadas").filter((l) => l.fase === "abertura").length;

// ─── Semeadura ────────────────────────────────────────────────────────

function semear(): void {
  tabelas.clear();
  operacoes = [];
  rede = [];
  rpcs = 0;

  tabela("agentes").push(
    { id: AGENTE_A, user_id: USER_A, ativo: true, nome: "A", tipo: "mensagens", instrucoes: "segredo interno" },
    { id: AGENTE_B, user_id: USER_B, ativo: true, nome: "B", tipo: "mensagens", instrucoes: null },
    { id: AGENTE_OFF, user_id: USER_A, ativo: false, nome: "OFF", tipo: "mensagens", instrucoes: null }
  );
  tabela("lojas").push({
    id: LOJA_A, user_id: USER_A, marketplace: "ML", ativo: true,
    nome: "Loja A", nickname: "nick-A", seller_id: SELLER_A,
    created_at: "2026-01-01T00:00:00.000Z",
    access_token: SECRET_ACCESS_A8, refresh_token: SECRET_REFRESH_A8,
    token_expires_at: FUTURO,
  });
  tabela("agente_skills");
  tabela("skills");
  tabela("agente_permissoes");
  tabela("agente_conexoes");
  tabela("agente_tarefas");
  tabela("agente_funcao_chamadas");
  tabela("agente_funcao_aprovacoes");
}

const permitir = (nivel: string, agenteId = AGENTE_A, userId = USER_A) => {
  tabela("agente_permissoes").push({ agente_id: agenteId, user_id: userId, funcao_id: ID_ML, nivel });
};
const conectar = (agenteId = AGENTE_A, userId = USER_A) => {
  tabela("agente_conexoes").push({
    agente_id: agenteId, user_id: userId, plataforma: "mercado_livre",
    recurso: "perguntas", loja_id: LOJA_A,
    criado_em: "2026-01-01T00:00:00.000Z", alterado_em: "2026-01-01T00:00:00.000Z",
  });
};

const grantOk = () => ({
  applications: [
    { app_id: "OUTRO", scopes: ["read"] },
    { app_id: APP_ID, scopes: ["read", "offline_access"] },
  ],
});
const perguntasOk = () => ({
  questions: [{
    id: "Q1", item_id: "MLB1", text: "tem garantia?", status: "UNANSWERED",
    date_created: "2026-09-01T10:00:00.000Z",
    seller_id: SELLER_A, access_token: SECRET_ACCESS_A8, campo_extra: "nao atravessa",
  }],
  total: 1,
});

// ─── Requisicao ───────────────────────────────────────────────────────

const req = (corpo: unknown, segredo: string | null = SEGREDO) =>
  new Request("http://localhost/api/internal/agentes/acoes", {
    method: "POST",
    headers: segredo === null
      ? { "Content-Type": "application/json" }
      : { "Content-Type": "application/json", "x-worker-secret": segredo },
    body: typeof corpo === "string" ? corpo : JSON.stringify(corpo),
  });

const corpoValido = (extra: Record<string, unknown> = {}, execId = "exec-1") => ({
  agenteId: AGENTE_A,
  acao: ACAO,
  argumentos: { status: "UNANSWERED", limite: 20, deslocamento: 0 },
  executionId: execId,
  ...extra,
});

async function main(): Promise<void> {
  console.log("\n══ CDS IA — M2-I1-A8a: ponte de orquestracao externa ══");

  const rota = await import("../app/api/internal/agentes/acoes/route");
  const { resolverAcao, acoesRegistradas, chaveDeIdempotencia } =
    await import("../lib/agentes/acoes/catalogo");
  const { lerAgenteParaAcaoInterna } = await import("../lib/agentes/capability-worker");

  const ROTA = semComentarios(ler("app/api/internal/agentes/acoes/route.ts"));
  const CATALOGO = semComentarios(ler("lib/agentes/acoes/catalogo.ts"));
  const WORKER = semComentarios(ler("lib/agentes/capability-worker.ts"));

  const POST = (corpo: unknown, segredo: string | null = SEGREDO) =>
    rota.POST(req(corpo, segredo));

  // ═══ A. Autenticacao ════════════════════════════════════════════════
  secao("A. Autenticacao de servico");
  semear();

  ok("N8N-BRIDGE-1 auth correta atravessa a porta",
    (await POST(corpoValido())).status !== 401);
  ok("N8N-BRIDGE-2 segredo errado e negado com 401",
    (await POST(corpoValido(), "errado")).status === 401);
  ok("N8N-BRIDGE-2a header ausente e negado com 401",
    (await POST(corpoValido(), null)).status === 401);
  {
    const guardado = process.env.N8N_BRIDGE_INTERNAL_SECRET;
    delete process.env.N8N_BRIDGE_INTERNAL_SECRET;
    const r = await POST(corpoValido());
    process.env.N8N_BRIDGE_INTERNAL_SECRET = guardado;
    ok("N8N-BRIDGE-2b sem a variavel configurada, FAIL-CLOSED", r.status === 401);
  }
  ok("N8N-SEC-1 o segredo e proprio — nao reusa CRON nem o do worker",
    /N8N_BRIDGE_INTERNAL_SECRET/.test(ROTA) &&
    !/CRON_SECRET|AGENTES_WORKER_INTERNAL_SECRET/.test(ROTA));
  ok("N8N-BRIDGE-26 a rota NAO declara `maxDuration` proprio",
    !/export const maxDuration/.test(ROTA));

  // ═══ B. Catalogo fechado ════════════════════════════════════════════
  secao("B. O catalogo de acoes");

  ok("N8N-BRIDGE-3 a acao conhecida mapeia para a Funcao EXATA",
    resolverAcao(ACAO) === ID_ML);
  ok("N8N-BRIDGE-3a e ha exatamente UMA acao registrada",
    JSON.stringify(acoesRegistradas()) === JSON.stringify([ACAO]));
  ok("N8N-BRIDGE-4 acao desconhecida nao resolve",
    resolverAcao("consultar_anuncios") === null);
  ok("N8N-MUT-10 chaves de PROTOTIPO nao resolvem acao",
    resolverAcao("toString") === null &&
    resolverAcao("constructor") === null &&
    resolverAcao("__proto__") === null &&
    resolverAcao("hasOwnProperty") === null);
  ok("N8N-BRIDGE-4a CONTROLE: acesso direto ao mapa acharia `toString`",
    typeof ({} as Record<string, unknown>)["toString"] === "function");
  ok("N8N-SEC-2 o catalogo usa `hasOwnProperty` e `Object.freeze`",
    /Object\.prototype\.hasOwnProperty\.call/.test(CATALOGO) &&
    /Object\.freeze/.test(CATALOGO));
  ok("N8N-BRIDGE-3b a string da Funcao nao e redigitada no catalogo",
    /FUNCAO_ID as FUNCAO_PERGUNTAS_ML/.test(ler("lib/agentes/acoes/catalogo.ts")) &&
    !/"mercadolivre\.perguntas\.listar"/.test(CATALOGO));
  {
    const r = await POST(corpoValido({ acao: "consultar_anuncios" }));
    ok("N8N-BRIDGE-4b a rota recusa acao desconhecida com 400", r.status === 400);
  }

  // ═══ C. Corpo fechado ═══════════════════════════════════════════════
  secao("C. Autoridade recusada na entrada");

  for (const proibida of [
    "funcaoId", "userId", "lojaId", "sellerId", "accessToken",
    "refreshToken", "requestId", "permission", "nivel", "idempotencyKey",
  ]) {
    const r = await POST(corpoValido({ [proibida]: "x" }));
    ok(`N8N-SEC/${proibida} no corpo e recusado com 400`, r.status === 400);
  }
  {
    const r = await POST(corpoValido({
      argumentos: { status: "UNANSWERED", lojaId: LOJA_A },
    }));
    ok("N8N-BRIDGE-7 `lojaId` dentro de `argumentos` tambem e recusado",
      r.status === 400);
  }
  ok("N8N-BRIDGE-22 `executionId` ausente e 400",
    (await POST({ agenteId: AGENTE_A, acao: ACAO, argumentos: {} })).status === 400);
  ok("N8N-BRIDGE-22a `executionId` vazio e 400",
    (await POST(corpoValido({}, ""))).status === 400);
  ok("N8N-BRIDGE-28 `executionId` acima de 128 caracteres e 400",
    (await POST(corpoValido({}, "x".repeat(129)))).status === 400);
  ok("N8N-BRIDGE-28a e 128 exatos e aceito",
    (await POST(corpoValido({}, "x".repeat(128)))).status !== 400);
  ok("N8N-BRIDGE-22b corpo que nao e objeto e 400",
    (await POST("[]")).status === 400 && (await POST("nao-json")).status === 400);

  // ═══ D. Resolucao de dono ═══════════════════════════════════════════
  secao("D. O dono vem do banco");

  {
    semear();
    operacoes = [];
    const r = await lerAgenteParaAcaoInterna(AGENTE_A);
    const leitura = operacoes.find((o) => o.tabela === "agentes");
    ok("N8N-BRIDGE-9 o dono e resolvido no CDS, a partir do agente",
      r.agente?.userId === USER_A && r.agente?.agenteId === AGENTE_A);
    ok("N8N-BRIDGE-21 a projecao tem EXATAMENTE tres colunas",
      JSON.stringify([...(leitura?.colunas ?? [])].sort()) ===
        JSON.stringify(["ativo", "id", "user_id"]));
    ok("N8N-MUT-11 e nao usa `COLUNAS_AGENTE` nem `select(\"*\")`",
      /COLUNAS_AGENTE_ACAO_INTERNA/.test(WORKER) &&
      !/\.select\(COLUNAS_AGENTE\)[\s\S]{0,80}lerAgenteParaAcaoInterna/.test(WORKER));
    ok("N8N-MUT-17 `normalizarLinha(data)` continua com QUATRO ocorrencias",
      (WORKER.match(/normalizarLinha\(data\)/g) ?? []).length === 4);
    ok("N8N-BRIDGE-20 agente inexistente: `null` sem erro — fail-closed",
      (await lerAgenteParaAcaoInterna("00000000-0000-4000-8000-000000000000")).agente === null);
    ok("N8N-BRIDGE-20a e a rota responde 404",
      (await POST(corpoValido({ agenteId: "00000000-0000-4000-8000-000000000000" }))).status === 404);
    ok("N8N-BRIDGE-19 agente INATIVO e recusado com 409",
      (await POST(corpoValido({ agenteId: AGENTE_OFF }))).status === 409);
    ok("N8N-MUT-12 e a Funcao nao chegou a rodar", aberturas() === 0);
    ok("N8N-BRIDGE-9a `instrucoes` do agente nao volta na projecao",
      !JSON.stringify(r.agente).includes("segredo interno"));
  }

  // ═══ E. Execucao feliz ══════════════════════════════════════════════
  secao("E. A cadeia real, ponta a ponta");

  let requestIdPrimeira: unknown = null;
  {
    semear();
    permitir("automatico");
    conectar();
    respostaGrant = { status: 200, corpo: grantOk() };
    respostaPerguntas = { status: 200, corpo: perguntasOk() };
    rede = [];

    const r = await POST(corpoValido());
    const corpo = await r.json();
    requestIdPrimeira = corpo.requestId;
    const abertura = tabela("agente_funcao_chamadas").find((l) => l.fase === "abertura");

    ok("N8N-BRIDGE-10 o guard REAL rodou: ha abertura com o nivel do momento",
      abertura?.nivel_no_momento === "automatico");
    ok("N8N-BRIDGE-11 o binding REAL forneceu a loja",
      abertura?.loja_id === LOJA_A && abertura?.plataforma === "mercado_livre");
    ok("N8N-BRIDGE-3c a Funcao despachada e a do catalogo",
      abertura?.funcao_id === ID_ML);
    ok("N8N-BRIDGE-12 o resultado e sanitizado — cinco chaves",
      corpo.ok === true && corpo.estado === "executada" &&
      JSON.stringify(Object.keys(corpo.resultado.linhas[0]).sort()) ===
        JSON.stringify(["anuncioId", "criadaEm", "id", "status", "texto"]));
    ok("N8N-BRIDGE-13 o `requestId` do CDS volta na resposta",
      typeof corpo.requestId === "string" && corpo.requestId.length > 0);
    ok("N8N-BRIDGE-16 zero credencial na resposta",
      !JSON.stringify(corpo).includes(SECRET_ACCESS_A8) &&
      !JSON.stringify(corpo).includes(SECRET_REFRESH_A8) &&
      !JSON.stringify(corpo).includes(SELLER_A));
    ok("N8N-BRIDGE-17 ZERO tarefa criada", tabela("agente_tarefas").length === 0);
    ok("N8N-BRIDGE-17a e nenhum path do motor de tarefas foi tocado",
      !operacoes.some((o) => o.tabela === "agente_tarefas"));
    ok("N8N-BRIDGE-16a as duas chamadas ao ML foram as previstas",
      conta("grant") === 1 && conta("perguntas") === 1 && conta("inesperada") === 0);
    ok("N8N-SEC-13 `requestId` enviado no corpo foi recusado antes de tudo",
      (await POST(corpoValido({ requestId: "forjado" }))).status === 400);
  }

  // ═══ F. Replay ══════════════════════════════════════════════════════
  secao("F. Replay da mesma execucao");

  {
    const aberturasAntes = aberturas();
    const perguntasAntes = conta("perguntas");
    const r2 = await POST(corpoValido());
    const corpo2 = await r2.json();

    ok("N8N-BRIDGE-14 replay devolve `already_processed`",
      corpo2.estado === "already_processed" && corpo2.ok === true);
    ok("N8N-BRIDGE-23 e NAO cria segunda abertura",
      aberturas() === aberturasAntes && aberturasAntes === 1);
    ok("N8N-MUT-7 o provider NAO foi chamado de novo",
      conta("perguntas") === perguntasAntes);
    ok("N8N-BRIDGE-27 o `requestId` do replay e `null`, nao um id novo",
      corpo2.requestId === null && requestIdPrimeira !== null);
    ok("N8N-MUT-15 e a resposta nao contem o id da primeira",
      corpo2.requestId !== requestIdPrimeira);
  }
  {
    // NAO-VACUIDADE: execucao diferente precisa executar de novo.
    const perguntasAntes = conta("perguntas");
    const r3 = await POST(corpoValido({}, "exec-2"));
    const corpo3 = await r3.json();
    ok("N8N-BRIDGE-24 `executionId` diferente executa normalmente",
      corpo3.estado === "executada" && aberturas() === 2);
    ok("N8N-BRIDGE-24a e o provider foi chamado de novo",
      conta("perguntas") === perguntasAntes + 1);
  }
  {
    const chave = chaveDeIdempotencia("n8n", "exec-1", ACAO, AGENTE_A);
    ok("N8N-MUT-9 a chave e DERIVADA no servidor, com prefixo de provedor",
      chave === `n8n:exec-1:${ACAO}:${AGENTE_A}`);
    ok("N8N-SEC-10 e a rota a deriva, nunca a recebe",
      /chaveDeIdempotencia\(/.test(ROTA) && !/idempotencyKey:\s*corpo\./.test(ROTA));
    const gravada = tabela("agente_funcao_chamadas").find((l) => l.fase === "abertura");
    ok("N8N-SEC-10a e ela foi de fato gravada na abertura",
      gravada?.idempotency_key === chave);
  }

  // ═══ G. Aprovacao e negacao ═════════════════════════════════════════
  secao("G. Aprovacao termina, bloqueio nega");

  {
    semear();
    permitir("aprovacao");
    conectar();
    respostaGrant = { status: 200, corpo: grantOk() };
    rede = [];

    const r = await POST(corpoValido({}, "exec-aprov"));
    const corpo = await r.json();
    ok("N8N-BRIDGE-15 aprovacao devolve `aguardando_aprovacao` + `aprovacaoId`",
      corpo.estado === "aguardando_aprovacao" &&
      typeof corpo.aprovacaoId === "string" && corpo.aprovacaoId.length > 0);
    ok("N8N-BRIDGE-15a e `estadoAprovacao` e o real",
      corpo.estadoAprovacao === "criada" || corpo.estadoAprovacao === "reutilizada");
    ok("N8N-MUT-14 ZERO chamada ao provider de perguntas", conta("perguntas") === 0);
    ok("N8N-BRIDGE-15b ZERO tarefa criada", tabela("agente_tarefas").length === 0);
    ok("N8N-BRIDGE-15c a aprovacao existe de verdade",
      tabela("agente_funcao_aprovacoes").length === 1);
    ok("N8N-BRIDGE-15d a ponte NAO tenta continuar: sem retomada no codigo",
      !/retomarAprovacao|executarFuncaoAprovada|consumirAprovacao/.test(ROTA));
  }
  {
    semear();
    permitir("bloqueado");
    conectar();
    rede = [];
    const corpo = await (await POST(corpoValido({}, "exec-bloq"))).json();
    ok("N8N-BRIDGE-10a nivel bloqueado: o guard nega",
      corpo.ok === false && corpo.estado === "negado" &&
      corpo.codigo === "permissao_bloqueada");
    ok("N8N-MUT-4 e zero chamada ao marketplace", rede.length === 0);
  }
  {
    semear();
    permitir("automatico"); // sem conexao
    rede = [];
    const corpo = await (await POST(corpoValido({}, "exec-sem-conexao"))).json();
    ok("N8N-BRIDGE-11a sem binding, o guard nega `conexao_ausente`",
      corpo.estado === "negado" && corpo.codigo === "conexao_ausente");
    ok("N8N-BRIDGE-11b e a ponte nao escolheu loja nenhuma", conta("perguntas") === 0);
  }

  // ═══ H. Fronteiras estaticas ════════════════════════════════════════
  secao("H. O que a ponte nao pode conter");

  ok("N8N-MUT-5 a ponte nao chama o handler da Funcao nem o adapter",
    !/executarPerguntasML|criarLeiturasDePerguntas|buscarPerguntasRecebidasML/.test(ROTA));
  ok("N8N-SEC-9 ela chama `executarFuncao`, e so",
    /executarFuncao\(/.test(ROTA));
  ok("N8N-MUT-1 nao ha `funcaoId` vindo do corpo",
    !/corpo\.funcaoId|o\.funcaoId/.test(ROTA));
  ok("N8N-SEC-4 nem `userId`",
    !/corpo\.userId|o\.userId/.test(ROTA) && /agente\.userId/.test(ROTA));
  ok("N8N-SEC-7 a ponte nao resolve credencial nem token",
    !/access_token|refresh_token|getMLLojaById/.test(ROTA));
  ok("N8N-MUT-3 e nao monta `lojaId`", !/lojaId:/.test(ROTA));
  ok("N8N-BRIDGE-18a zero `criarTarefa` no codigo da ponte",
    !/criarTarefa|executarTarefa|claim_next/.test(ROTA));
  {
    // NOMINAL, e nao contagem: o arquivo tem OUTRO union (`valida` /
    // `invalida` / `erro_interno`), e contar `tipo: "` no arquivo inteiro
    // media os dois juntos. O recorte pega so o bloco do union publico.
    const EXEC = semComentarios(ler("lib/agentes/execucao-funcoes/executar.ts"));
    const inicio = EXEC.indexOf("export type ResultadoExecucaoFuncao =");
    const bloco = EXEC.slice(inicio, EXEC.indexOf("\n\n", inicio));
    const variantes = [...bloco.matchAll(/tipo:\s*"([a-z_]+)"/g)].map((m) => m[1]);
    const SETE = [
      "aguardando_aprovacao", "aprovacao_indisponivel", "erro",
      "falha_auditoria", "indisponivel", "negado", "sucesso",
    ];
    ok("N8N-MUT-16 o executor continua com as SETE variantes nominais",
      JSON.stringify([...variantes].sort()) === JSON.stringify(SETE));
    ok("N8N-MUT-16a CONTROLE: uma oitava variante reprovaria",
      JSON.stringify([...variantes, "duplicada"].sort()) !== JSON.stringify(SETE));
  }
  ok("N8N-MUT-13 `motivo: \"duplicada\"` so nasce do estado `duplicada`",
    /abertura\.estado === "duplicada" \? \{ motivo: "duplicada" as const \} : \{\}/
      .test(ler("lib/agentes/execucao-funcoes/executar.ts")));
  ok("N8N-BRIDGE-25 zero banco real e zero rede inesperada",
    interceptouBanco === true && conta("inesperada") === 0);

  const total = passou + falhou;
  console.log(`\n══ CDS IA — M2-I1-A8a: ponte de orquestracao:  ${passou}/${total} passaram ══`);
  if (falhou > 0) console.log(`   ${falhou} FALHARAM`);
  console.log("   N8N_REAL_CONNECTED = NO / MARKETPLACE_LIVE = NO / REAL_DB_WRITE = NO");
  process.exitCode = falhou === 0 ? 0 : 1;
}

void main();
