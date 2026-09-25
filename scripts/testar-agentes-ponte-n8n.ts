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
/** M2-I1-A8B: a segunda acao. `vendas.consultar` tem `conexaoNecessaria:
 *  null`, e e por isso que ela serve de caminho de prova de idempotencia
 *  sem binding e sem marketplace. */
const ID_VENDAS = "vendas.consultar";
const ACAO_VENDAS = "consultar_vendas";
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

/**
 * O corpo padrao. `execId` e `opId` sao parametros SEPARADOS de proposito
 * — M2-I1-A8B: a suite precisa poder variar um sem o outro, que e
 * exatamente a distincao que a fase A8B introduziu. Repetir `opId` com
 * `execId` novo e replay; trocar `opId` e intencao nova.
 */
const corpoValido = (
  extra: Record<string, unknown> = {},
  execId = "exec-1",
  opId = "op-1"
) => ({
  agenteId: AGENTE_A,
  acao: ACAO,
  argumentos: { status: "UNANSWERED", limite: 20, deslocamento: 0 },
  executionId: execId,
  operationId: opId,
  ...extra,
});

/** Corpo da acao de VENDAS, com o contrato de argumentos dela. */
const corpoVendas = (
  extra: Record<string, unknown> = {},
  execId = "exec-v1",
  opId = "op-v1"
) => ({
  agenteId: AGENTE_A,
  acao: ACAO_VENDAS,
  argumentos: { dataInicio: "2027-01-01", dataFim: "2027-01-01" },
  executionId: execId,
  operationId: opId,
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
    resolverAcao(ACAO)?.funcaoId === ID_ML);
  // MUT-9: a acao de vendas tem de resolver `vendas.consultar`, e nao
  // qualquer outra — trocar o alvo aqui executaria a Funcao errada com
  // os argumentos certos, que e o pior desfecho possivel.
  ok("N8N-BRIDGE-3g `consultar_vendas` mapeia para `vendas.consultar`",
    resolverAcao(ACAO_VENDAS)?.funcaoId === ID_VENDAS);
  ok("N8N-A8B-MUT-9 CONTROLE NEGATIVO: as duas acoes nao apontam para a mesma Funcao",
    resolverAcao(ACAO)?.funcaoId !== resolverAcao(ACAO_VENDAS)?.funcaoId);
  // ANTI-VACUIDADE: conjunto EXATO, nunca `includes` nem `>= 2`. Uma
  // terceira acao que ninguem revisou reprova aqui.
  ok("N8N-BRIDGE-3a e ha exatamente DUAS acoes registradas",
    JSON.stringify([...acoesRegistradas()].sort()) ===
      JSON.stringify([ACAO_VENDAS, ACAO].sort()));
  ok("N8N-BRIDGE-3h CONTROLE NEGATIVO: o oraculo reprova uma acao a mais",
    JSON.stringify([...acoesRegistradas(), "consultar_anuncios"].sort()) !==
      JSON.stringify([ACAO_VENDAS, ACAO].sort()));

  // ─── Contratos de argumento, por acao ───────────────────────────────
  //
  // MUT-11/MUT-12: o cruzamento e o defeito que esta separacao existe
  // para impedir. Uma whitelist global seria a UNIAO das duas listas, e
  // `dataInicio` passaria em `consultar_perguntas` sem que nada acusasse.
  ok("N8N-BRIDGE-3d perguntas aceita EXATAMENTE status/limite/deslocamento",
    JSON.stringify([...(resolverAcao(ACAO)?.argumentos ?? [])].sort()) ===
      JSON.stringify(["deslocamento", "limite", "status"]));
  ok("N8N-BRIDGE-3e vendas aceita EXATAMENTE dataInicio/dataFim/marketplace",
    JSON.stringify([...(resolverAcao(ACAO_VENDAS)?.argumentos ?? [])].sort()) ===
      JSON.stringify(["dataFim", "dataInicio", "marketplace"]));
  ok("N8N-BRIDGE-3f os dois contratos sao DISJUNTOS",
    (resolverAcao(ACAO)?.argumentos ?? []).every(
      (k) => !(resolverAcao(ACAO_VENDAS)?.argumentos ?? []).includes(k)));
  ok("N8N-A8B-MUT-10a nao existe whitelist GLOBAL de argumentos na rota",
    !/CHAVES_DOS_ARGUMENTOS/.test(ROTA));
  // MUT-10: se `vendas.consultar` passar a exigir conexao, o caminho de
  // prova sem binding deixa de existir — em silencio.
  ok("N8N-A8B-MUT-10b `vendas.consultar` segue com `conexaoNecessaria: null`",
    /"vendas\.consultar":\s*Object\.freeze\(\{[\s\S]*?conexaoNecessaria:\s*null/
      .test(semComentarios(ler("lib/agentes/funcoes/registry.ts"))));
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
  ok("N8N-SEC-3a e a de vendas tambem vem por import, nao redigitada",
    /FUNCAO_ID as FUNCAO_VENDAS/.test(ler("lib/agentes/acoes/catalogo.ts")) &&
    !/"vendas\.consultar"/.test(CATALOGO));
  {
    // I4O2: nao ha mais "acao desconhecida" para recusar. A rota termina
    // antes de olhar a acao, entao conhecida e desconhecida sao iguais.
    const r = await POST(corpoValido({ acao: "consultar_anuncios" }));
    ok("N8N-BRIDGE-4b acao desconhecida termina igual: 410", r.status === 410);
  }

  // ═══ C. Quarentena da superficie generica ═════════════════
  //
  // I4O2. As secoes C a G desta suite provavam o COMPORTAMENTO COMERCIAL
  // da ponte: corpo fechado, dono vindo do banco, cadeia ponta a ponta,
  // replay da mesma intencao, aprovacao e bloqueio. Esse comportamento
  // deixou de existir — a rota entrou em quarentena e termina antes de
  // ler o corpo.
  //
  // O que entra no lugar nao e menos, e mais forte. Antes se provava que
  // cada campo de autoridade era RECUSADO com 400; agora se prova que
  // campo nenhum tem EFEITO, porque nenhum e lido. E onde havia um 400
  // vindo do catalogo ha um 410 terminal alcancado sem carregar agente,
  // sem executar Funcao, sem abrir ledger e sem tocar rede.
  secao("C. Quarentena da superficie generica");
  semear();

  const QUARENTENA = 410;
  const COD_QUARENTENA = "main_generico_em_aposentadoria";

  {
    rede = [];
    const antes = aberturas();
    const r = await POST(corpoValido());
    const corpo = await r.json();
    ok("I4O2-Q1 um corpo comercial PERFEITO termina em 410", r.status === QUARENTENA);
    ok("I4O2-Q2 o desfecho e terminal e nomeado",
      corpo.ok === false && corpo.estado === "indisponivel" && corpo.codigo === COD_QUARENTENA);
    ok("I4O2-Q3 nenhuma abertura de ledger nasceu", aberturas() === antes);
    ok("I4O2-Q4 nenhuma chamada de rede saiu", rede.length === 0);
    ok("I4O2-Q5 nenhuma chamada ao provider de perguntas", conta("perguntas") === 0);
  }

  {
    // O ponto central da aposentadoria: o `agenteId` do corpo era a
    // superficie ampla — dono derivado de QUALQUER agente, sem escopo de
    // usuario. Agora ele nao leva a lugar nenhum.
    rede = [];
    const antes = aberturas();
    const alheio = "11111111-2222-4333-8444-555555555555";
    const r = await POST(corpoValido({ agenteId: alheio }));
    ok("I4O2-Q6 agenteId arbitrario nao muda nada: 410", r.status === QUARENTENA);
    ok("I4O2-Q7 e nenhum agente foi carregado do banco", aberturas() === antes);
    ok("I4O2-Q8 e nada saiu para rede", rede.length === 0);
  }

  for (const proibida of [
    "funcaoId", "userId", "lojaId", "sellerId", "accessToken",
    "refreshToken", "requestId", "permission", "nivel", "idempotencyKey",
  ]) {
    rede = [];
    const r = await POST(corpoValido({ [proibida]: "x" }));
    ok(`I4O2-Q/${proibida} no corpo nao tem efeito algum: 410`,
      r.status === QUARENTENA && rede.length === 0);
  }

  {
    // Prova de que o corpo nao e PARSEADO, e nao apenas ignorado: uma
    // requisicao sem corpo nenhum atravessa igual. Se houvesse
    // `await request.json()` no caminho, isto lancaria.
    const semCorpo = new Request("http://localhost/api/internal/agentes/acoes", {
      method: "POST",
      headers: { "x-worker-secret": SEGREDO },
    });
    const r = await rota.POST(semCorpo);
    ok("I4O2-Q9 sem corpo nenhum, ainda 410 — o corpo nao e lido",
      r.status === QUARENTENA);
  }

  {
    // Replay: a mesma INTENCAO duas vezes. Antes isto era o coracao da
    // idempotencia; agora as duas terminam iguais e nenhuma chave nasce.
    rede = [];
    const antes = aberturas();
    const a = await POST(corpoValido({}, "exec-r1", "op-replay"));
    const b = await POST(corpoValido({}, "exec-r2", "op-replay"));
    ok("I4O2-Q10 replay da mesma operationId: as duas em 410",
      a.status === QUARENTENA && b.status === QUARENTENA);
    ok("I4O2-Q11 e nenhuma chave de idempotencia comercial nasceu",
      aberturas() === antes);
  }

  {
    // Aprovacao: a ponte nao cria mais nenhuma.
    const antesAprov = tabela("agente_funcao_aprovacoes").length;
    await POST(corpoValido({}, "exec-aprov", "op-aprov"));
    ok("I4O2-Q12 nenhuma aprovacao foi criada",
      tabela("agente_funcao_aprovacoes").length === antesAprov);
  }

  ok("I4O2-Q13 auth continua ANTES da quarentena — sem segredo e 401, nao 410",
    (await POST(corpoValido(), "errado")).status === 401);

  // ═══ H. Fronteiras estaticas ════════════════════════════════════════
  secao("H. O que a ponte nao pode conter");

  ok("N8N-MUT-5 a ponte nao chama o handler da Funcao nem o adapter",
    !/executarPerguntasML|criarLeiturasDePerguntas|buscarPerguntasRecebidasML/.test(ROTA));
  ok("N8N-SEC-9 I4O2: a ponte NAO chama mais `executarFuncao`",
    !/executarFuncao/.test(ROTA));
  ok("N8N-MUT-1 nao ha `funcaoId` vindo do corpo",
    !/corpo\.funcaoId|o\.funcaoId/.test(ROTA));
  ok("N8N-SEC-4 nem `userId` — e agora nem sequer deriva dono nenhum",
    !/corpo\.userId|o\.userId/.test(ROTA) && !/agente\.userId/.test(ROTA));
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
  ok("I4O2-H1 a rota nao importa NADA comercial",
    !/acoes\/catalogo|capability-worker|execucao-funcoes/.test(ROTA));
  ok("I4O2-H2 o unico import e o do framework",
    (ROTA.match(/^import /gm) || []).length === 1 && /from "next\/server"/.test(ROTA));
  ok("I4O2-H3 a rota nao le o corpo do pedido",
    !/request\.json\(\)|await request\.text\(\)/.test(ROTA));
  ok("I4O2-H4 o desfecho terminal esta nomeado no codigo",
    /main_generico_em_aposentadoria/.test(ROTA) && /410/.test(ROTA));
  ok("I4O2-H5 o evento da janela de observacao existe e e sanitizado",
    /MAIN_GENERIC_QUARANTINE_HIT/.test(ROTA) &&
    !/agenteId|operationId|argumentos|x-worker-secret|cookie/i.test(
      (ROTA.match(/console\.warn\([\s\S]*?\);/) || [""])[0]));
  ok("N8N-BRIDGE-25 zero banco real e zero rede inesperada",
    interceptouBanco === true && conta("inesperada") === 0);

  const total = passou + falhou;
  console.log(`\n══ CDS IA — M2-I1-A8a: ponte de orquestracao:  ${passou}/${total} passaram ══`);
  if (falhou > 0) console.log(`   ${falhou} FALHARAM`);
  console.log("   N8N_REAL_CONNECTED = NO / MARKETPLACE_LIVE = NO / REAL_DB_WRITE = NO");
  process.exitCode = falhou === 0 ? 0 : 1;
}

void main();
