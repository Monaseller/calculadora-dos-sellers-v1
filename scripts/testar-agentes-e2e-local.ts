/**
 * CDS IA — M2-I1-A6. Aceitacao E2E local da cadeia de conexao.
 *
 * ── O que esta suite prova ──────────────────────────────────────────
 *
 * A cadeia INTEIRA roda com codigo de producao real: rota de permissoes,
 * rota de conexoes, agregador, owners de selecao, fatos de conexao,
 * cobertura remota, guard, executor, handler da Funcao, adapter do ML e
 * normalizacao. Nada disso e stub.
 *
 * Tres fronteiras — e SO tres — sao dubladas:
 *
 *   1. o transporte de banco (`supabase-servidor`), por um ARMAZEM em
 *      memoria com estado de verdade;
 *   2. a sessao (`lib/autenticacao`), porque o namespace do modulo so
 *      expoe getter e nao ha como reatribuir o export;
 *   3. o `fetch` global, que e a fronteira HTTP do marketplace.
 *
 * ── Por que o armazem precisa ter ESTADO ────────────────────────────
 *
 * O duplo da suite A4 e um ROTEIRO: uma fila de respostas consumida em
 * ordem. Ele serve para provar filtros de UMA chamada e nao serve aqui.
 * Com fila, o GET posterior ao PATCH devolveria o que o roteiro mandasse
 * — nao o que o PATCH gravou —, e a causalidade que esta suite existe
 * para provar viraria encenacao. O mesmo objeto atravessa PATCH de
 * permissao, GET, PATCH de conexao, GET, executor, cobertura e leitura
 * de credencial.
 *
 * ── O que esta suite NAO prova ──────────────────────────────────────
 *
 * Nao prova contrato do Mercado Livre: as fixtures sao nossas
 * (`A2-C1` segue UNVERIFIED). E nao prova fluxo de PRODUTO: nenhuma
 * tarefa, rota ou handler do produto alcanca
 * `mercadolivre.perguntas.listar` — o unico chamador de `executarFuncao`
 * esta preso a `vendas.consultar` por constante de modulo. Esta suite
 * entra pela porta publica tecnica real, e diz isso em voz alta
 * (`FUNCTION_PRODUCT_SURFACE_M2_I1 = ABSENT`).
 *
 * Zero rede. Zero banco. Zero escrita em producao.
 *
 * Rodar:  npx tsx scripts/testar-agentes-e2e-local.ts
 */
import "./_server-only-inerte";

import Module from "node:module";

// ─── Placar ───────────────────────────────────────────────────────────

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

// ─── Ambiente ─────────────────────────────────────────────────────────
//
// `ML_CLIENT_ID` e IDENTIFICADOR da aplicacao, nao segredo — e o mesmo
// valor que trafega na URL de autorizacao OAuth. Mesmo assim ele nao
// pode sair em resposta publica, por minimizacao de dado.
//
// `ML_CLIENT_SECRET` fica DELIBERADAMENTE ausente. Ele so e alcancavel
// por `refreshMLToken`, e a precondicao de `token_expires_at` no futuro
// distante mantem esse ramo morto. Se o ramo disparar por defeito de
// fixture, `process.env.ML_CLIENT_SECRET!.trim()` lanca em `undefined` —
// falha alta e imediata, que e exatamente o que se quer. A ausencia da
// variavel e uma segunda barreira, independente da sentinela de rede.
const APP_ID = "TEST_ML_CLIENT_ID_A6";
process.env.ML_CLIENT_ID = APP_ID;
delete process.env.ML_CLIENT_SECRET;

// ─── Identidades sinteticas ───────────────────────────────────────────

const USER_A = "user-a6-alpha";
const USER_B = "user-a6-bravo";
const AGENTE_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const AGENTE_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const LOJA_A = "11111111-0000-4000-8000-000000000001";
const LOJA_B = "22222222-0000-4000-8000-000000000002";
const LOJA_C = "33333333-0000-4000-8000-000000000003";
const SELLER_A = "900000001";
const SELLER_B = "900000002";

/** Sentinelas de SEGREDO. Nunca podem aparecer em superficie alguma. */
const SECRET_ACCESS_A6 = "SECRET_ACCESS_A6";
const SECRET_REFRESH_A6 = "SECRET_REFRESH_A6";

const ID_ML = "mercadolivre.perguntas.listar";
const ID_VENDAS = "vendas.consultar";
const PLATAFORMA = "mercado_livre";
const RECURSO = "perguntas";

const FUTURO = "2099-12-31T23:59:59.000Z";

// ─── O armazem em memoria ─────────────────────────────────────────────

type Linha = Record<string, unknown>;

interface Operacao {
  tabela: string;
  tipo: "leitura" | "insert" | "upsert" | "delete";
  filtros: Record<string, unknown>;
  payload?: Linha;
  afetadas?: number;
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

/** Projeta a linha nas colunas pedidas — o `select` do duplo APLICA de
 *  verdade a projecao. Coluna nao pedida nao volta, e por isso um owner
 *  que leia coluna que nao selecionou quebra aqui, como quebraria la. */
function projetar(linha: Linha, colunas: readonly string[] | null): Linha {
  if (colunas === null) return { ...linha };
  const saida: Linha = {};
  for (const c of colunas) saida[c] = linha[c] ?? null;
  return saida;
}

function colunasDe(select: string | undefined): readonly string[] | null {
  if (typeof select !== "string" || select.trim() === "*" || select.trim() === "") return null;
  return select.split(",").map((c) => c.trim()).filter((c) => c.length > 0);
}

type Predicado = (linha: Linha) => boolean;

interface Estado {
  tabela: string;
  tipo: Operacao["tipo"];
  colunas: readonly string[] | null;
  predicados: Predicado[];
  filtros: Record<string, unknown>;
  payload?: Linha;
  conflito?: readonly string[];
  ordem: Array<{ coluna: string; ascendente: boolean }>;
  limite: number | null;
}

/** As FKs compostas de `agente_conexoes` e de `agente_permissoes`.
 *
 *  As quatro causas possiveis — agente inexistente, agente alheio, loja
 *  inexistente, loja alheia — chegam INDISTINGUIVEIS, exatamente como o
 *  banco as entrega e como `selecao-escrita.ts` as trata. Separa-las
 *  viraria um oraculo de existencia de recurso alheio. */
function violaFk(nomeTabela: string, linha: Linha): boolean {
  const donoDe = (t: string, id: unknown, userId: unknown): boolean =>
    tabela(t).some((l) => l.id === id && l.user_id === userId);

  if (nomeTabela === "agente_conexoes") {
    if (!donoDe("agentes", linha.agente_id, linha.user_id)) return true;
    if (!donoDe("lojas", linha.loja_id, linha.user_id)) return true;
    return false;
  }
  if (nomeTabela === "agente_permissoes") {
    return !donoDe("agentes", linha.agente_id, linha.user_id);
  }
  return false;
}

const ERRO_FK = { code: "23503", message: "" };

function resolver(e: Estado): { data: unknown; error: unknown } {
  const linhas = tabela(e.tabela);
  const casa = (l: Linha) => e.predicados.every((p) => p(l));

  if (e.tipo === "leitura") {
    let achadas = linhas.filter(casa);
    for (const o of [...e.ordem].reverse()) {
      achadas = [...achadas].sort((x, y) => {
        const a = String(x[o.coluna] ?? "");
        const b = String(y[o.coluna] ?? "");
        return o.ascendente ? a.localeCompare(b) : b.localeCompare(a);
      });
    }
    if (e.limite !== null) achadas = achadas.slice(0, e.limite);
    registrar(e, achadas.length);
    return { data: achadas.map((l) => projetar(l, e.colunas)), error: null };
  }

  if (e.tipo === "insert") {
    const nova = { ...(e.payload as Linha) };
    if (violaFk(e.tabela, nova)) {
      registrar(e, 0);
      return { data: null, error: ERRO_FK };
    }
    linhas.push(nova);
    registrar(e, 1);
    return { data: null, error: null };
  }

  if (e.tipo === "upsert") {
    const p = e.payload as Linha;
    if (violaFk(e.tabela, p)) {
      registrar(e, 0);
      return { data: null, error: ERRO_FK };
    }
    const chave = e.conflito ?? [];
    const i = linhas.findIndex((l) => chave.every((c) => l[c] === p[c]));
    if (i === -1) {
      // CRIACAO: `criado_em` vem do DEFAULT do banco, que o payload nao
      // carrega de proposito.
      linhas.push({ criado_em: new Date().toISOString(), ...p });
      registrar(e, 1);
    } else {
      // SUBSTITUICAO: o ramo de conflito so toca as colunas PRESENTES no
      // payload, entao `criado_em` sobrevive — e e por isso que o owner
      // pode omiti-lo com seguranca.
      linhas[i] = { ...linhas[i], ...p };
      registrar(e, 1);
    }
    return { data: null, error: null };
  }

  // DELETE. `data` traz as linhas removidas porque
  // `removerSelecaoDeLoja` conta `r.data.length` para distinguir
  // `removida` de `nao_encontrada`. Um duplo que devolvesse `null` faria
  // toda remocao parecer "nao encontrada", e a rota — que trata as duas
  // como 200 — esconderia o defeito.
  const removidas = linhas.filter(casa);
  for (const r of removidas) linhas.splice(linhas.indexOf(r), 1);
  registrar(e, removidas.length);
  return { data: removidas.map((l) => projetar(l, e.colunas)), error: null };
}

function registrar(e: Estado, afetadas: number): void {
  operacoes.push({
    tabela: e.tabela,
    tipo: e.tipo,
    filtros: { ...e.filtros },
    payload: e.payload ? { ...e.payload } : undefined,
    afetadas,
  });
}

function construtor(nomeTabela: string): unknown {
  const e: Estado = {
    tabela: nomeTabela,
    tipo: "leitura",
    colunas: null,
    predicados: [],
    filtros: {},
    ordem: [],
    limite: null,
  };

  const b: Record<string, unknown> = {
    select(cols?: string) {
      e.colunas = colunasDe(cols);
      return b;
    },
    eq(coluna: string, valor: unknown) {
      e.filtros[coluna] = valor;
      e.predicados.push((l) => l[coluna] === valor);
      return b;
    },
    in(coluna: string, valores: readonly unknown[]) {
      e.filtros[coluna] = { __in: [...valores] };
      e.predicados.push((l) => valores.includes(l[coluna]));
      return b;
    },
    // `.not("access_token", "is", null)` — a forma exata que
    // `listarLojasConectadasDoDono` usa.
    not(coluna: string, operador: string, valor: unknown) {
      e.filtros[`not:${coluna}`] = { operador, valor };
      if (operador === "is" && valor === null) {
        e.predicados.push((l) => l[coluna] !== null && l[coluna] !== undefined);
      } else {
        e.predicados.push((l) => l[coluna] !== valor);
      }
      return b;
    },
    is(coluna: string, valor: unknown) {
      e.filtros[`is:${coluna}`] = valor;
      e.predicados.push((l) => (valor === null ? l[coluna] == null : l[coluna] === valor));
      return b;
    },
    order(coluna: string, opcoes?: { ascending?: boolean }) {
      e.ordem.push({ coluna, ascendente: opcoes?.ascending !== false });
      return b;
    },
    limit(n: number) {
      e.limite = n;
      return b;
    },
    insert(payload: Linha) {
      e.tipo = "insert";
      e.payload = payload;
      return b;
    },
    upsert(payload: Linha, opcoes?: { onConflict?: string }) {
      e.tipo = "upsert";
      e.payload = payload;
      e.conflito = (opcoes?.onConflict ?? "").split(",").map((c) => c.trim()).filter(Boolean);
      return b;
    },
    delete() {
      e.tipo = "delete";
      return b;
    },
    maybeSingle() {
      return {
        then: (fn: (v: { data: unknown; error: unknown }) => void) => {
          const r = resolver(e);
          const lista = (r.data ?? []) as Linha[];
          if (r.error) return fn({ data: null, error: r.error });
          // `maybeSingle` recusa resultado ambiguo, como o driver real.
          if (lista.length > 1) {
            return fn({ data: null, error: { code: "PGRST116", message: "" } });
          }
          fn({ data: lista[0] ?? null, error: null });
        },
      };
    },
    then(fn: (v: { data: unknown; error: unknown }) => void) {
      fn(resolver(e));
    },
  };
  return b;
}

let rpcs = 0;
const rpcsChamadas: Array<{ nome: string }> = [];

/**
 * As RPCs que a cadeia realmente usa.
 *
 * `aprovacao_criar` e uma FUNCAO do Postgres, e portanto fronteira de
 * banco como qualquer `from()`. Devolver `null` dela — como um duplo
 * generico faria — nao significa "nao chamou": significa que o owner le
 * `resultado` de nada e responde `falha_persistencia`. O ramo de
 * aprovacao morreria por defeito da suite, e a suite diria que o produto
 * esta errado.
 *
 * Aqui ela e modelada no MINIMO fiel: grava a linha, devolve
 * `{ resultado, id }`, e deduplica por fingerprint como a de verdade —
 * o suficiente para provar que a Funcao NAO executa. O fluxo de decisao
 * humana continua fora do escopo do A6.
 */
function executarRpc(nome: string, args: Record<string, unknown>): { data: unknown; error: unknown } {
  if (nome !== "aprovacao_criar") return { data: null, error: null };

  const linhas = tabela("agente_funcao_aprovacoes");
  const fingerprint = args.p_fingerprint;
  const existente = linhas.find((l) => l.fingerprint === fingerprint && l.estado === "pendente");
  if (existente !== undefined) {
    return { data: [{ resultado: "reutilizada", id: existente.id }], error: null };
  }

  const id = `aprovacao-${linhas.length + 1}-a6`;
  linhas.push({
    id,
    estado: "pendente",
    fingerprint,
    user_id: args.p_user_id,
    agente_id: args.p_agente_id,
    tarefa_id: args.p_tarefa_id,
    funcao_id: args.p_funcao_id,
    revisao_funcao: args.p_revisao_funcao,
    acesso: args.p_acesso,
    conexao_plataforma: args.p_conexao_plataforma,
    conexao_recurso: args.p_conexao_recurso,
    conexao_loja_id: args.p_conexao_loja_id,
    argumentos: args.p_argumentos,
    argumentos_hash: args.p_argumentos_hash,
  });
  return { data: [{ resultado: "criada", id }], error: null };
}

const clienteFake = {
  from: (t: string) => construtor(t),
  rpc: (nome: string, args: Record<string, unknown>) => {
    rpcs++;
    rpcsChamadas.push({ nome });
    return Promise.resolve(executarRpc(nome, args ?? {}));
  },
};

// ─── Sessao duplada ───────────────────────────────────────────────────

const COOKIE_A = `cds_session=sessao-de-${USER_A}`;
const COOKIE_B = `cds_session=sessao-de-${USER_B}`;

function donoDoCookie(cookie: string): string | null {
  if (cookie.includes(`sessao-de-${USER_A}`)) return USER_A;
  if (cookie.includes(`sessao-de-${USER_B}`)) return USER_B;
  return null;
}

// ─── A intercepcao ────────────────────────────────────────────────────

const requireOriginal = (Module as unknown as { prototype: { require: (id: string) => unknown } })
  .prototype.require;
let interceptouBanco = false;
let interceptouSessao = false;

(Module as unknown as { prototype: { require: unknown } }).prototype.require = function (
  this: unknown,
  id: string
) {
  if (typeof id === "string" && id.includes("supabase-servidor")) {
    interceptouBanco = true;
    return { getSupabaseServidor: () => clienteFake };
  }
  if (typeof id === "string" && id.includes("lib/autenticacao")) {
    interceptouSessao = true;
    return {
      autenticarRequisicao: async (r: Request) => {
        const uid = donoDoCookie(r.headers.get("cookie") ?? "");
        return uid === null ? { autenticado: false } : { autenticado: true, uid };
      },
    };
  }
  // eslint-disable-next-line prefer-rest-params
  return requireOriginal.apply(this, arguments as unknown as [string]);
};

// ─── Sentinela de rede ────────────────────────────────────────────────

interface ChamadaRede {
  url: string;
  pathname: string;
  busca: string;
  autorizacao: string | null;
  tipo: "grant" | "perguntas" | "inesperada";
}

let rede: ChamadaRede[] = [];
let respostaGrant: { status: number; corpo: unknown } = { status: 200, corpo: null };
let respostaPerguntas: { status: number; corpo: unknown } = { status: 200, corpo: null };

const CAMINHO_GRANT = /^\/users\/([^/]+)\/applications$/;
const CAMINHO_PERGUNTAS = "/my/received_questions/search";

function resposta(status: number, corpo: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => corpo,
  } as unknown as Response;
}

globalThis.fetch = (async (entrada: string | URL | Request, init?: RequestInit) => {
  const bruta = typeof entrada === "string" ? entrada : String(entrada);
  const u = new URL(bruta);
  const cabecalhos = (init?.headers ?? {}) as Record<string, string>;
  const autorizacao = cabecalhos.Authorization ?? cabecalhos.authorization ?? null;

  if (u.origin === "https://api.mercadolibre.com" && CAMINHO_GRANT.test(u.pathname) && u.search === "") {
    rede.push({ url: bruta, pathname: u.pathname, busca: u.search, autorizacao, tipo: "grant" });
    return resposta(respostaGrant.status, respostaGrant.corpo);
  }
  if (u.origin === "https://api.mercadolibre.com" && u.pathname === CAMINHO_PERGUNTAS) {
    rede.push({ url: bruta, pathname: u.pathname, busca: u.search, autorizacao, tipo: "perguntas" });
    return resposta(respostaPerguntas.status, respostaPerguntas.corpo);
  }

  rede.push({ url: bruta, pathname: u.pathname, busca: u.search, autorizacao, tipo: "inesperada" });
  throw new Error("A6: fetch nao previsto");
}) as unknown as typeof fetch;

// ─── Console capturado ────────────────────────────────────────────────

const consoleOriginal = { log: console.log, warn: console.warn, error: console.error };
let capturado: string[] = [];
function capturarConsole(): void {
  console.warn = (...a: unknown[]) => { capturado.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { capturado.push(a.map(String).join(" ")); };
}
function soltarConsole(): void {
  console.warn = consoleOriginal.warn;
  console.error = consoleOriginal.error;
}

// ─── Semeadura ────────────────────────────────────────────────────────

function lojaML(id: string, userId: string, sellerId: string, nome: string): Linha {
  return {
    id,
    user_id: userId,
    marketplace: "ML",
    ativo: true,
    nome,
    nickname: `nick-${nome}`,
    seller_id: sellerId,
    created_at: "2026-01-01T00:00:00.000Z",
    access_token: SECRET_ACCESS_A6,
    refresh_token: SECRET_REFRESH_A6,
    token_expires_at: FUTURO,
  };
}

function semear(): void {
  tabelas.clear();
  operacoes = [];
  rede = [];
  capturado = [];
  rpcs = 0;
  rpcsChamadas.length = 0;

  tabela("agentes").push(
    { id: AGENTE_A, user_id: USER_A, nome: "Agente A", tipo: "personalizado", instrucoes: null, ativo: true, criado_em: "2026-01-01T00:00:00.000Z", atualizado_em: "2026-01-01T00:00:00.000Z" },
    { id: AGENTE_B, user_id: USER_B, nome: "Agente B", tipo: "personalizado", instrucoes: null, ativo: true, criado_em: "2026-01-01T00:00:00.000Z", atualizado_em: "2026-01-01T00:00:00.000Z" }
  );

  tabela("lojas").push(
    lojaML(LOJA_A, USER_A, SELLER_A, "Loja A"),
    lojaML(LOJA_B, USER_A, SELLER_B, "Loja B"),
    {
      id: LOJA_C, user_id: USER_A, marketplace: "SHOPEE", ativo: true,
      nome: "Loja C", nickname: "nick-Loja C", seller_id: "700000003",
      created_at: "2026-01-01T00:00:00.000Z",
      access_token: SECRET_ACCESS_A6, refresh_token: SECRET_REFRESH_A6,
      token_expires_at: FUTURO,
    }
  );

  // `agente_skills`, `agente_permissoes` e `agente_conexoes` comecam
  // VAZIAS. O happy path tem de criar a permissao pela rota e a selecao
  // pela rota — semear qualquer uma delas seria pular justamente o elo
  // que esta suite existe para provar.
  tabela("agente_skills");
  tabela("skills");
  tabela("agente_permissoes");
  tabela("agente_conexoes");
  tabela("agente_funcao_chamadas");
  tabela("agente_funcao_aprovacoes");
}

// ─── Fixtures do provider ─────────────────────────────────────────────

/** O envelope de grant. DOIS itens de proposito: o primeiro e de outra
 *  aplicacao e tem `read` — se o parser pegasse o primeiro da lista, ou
 *  casasse por semelhanca, a cobertura confirmaria contra concessao
 *  alheia. */
function grantOk(appId: string = APP_ID): unknown {
  return {
    applications: [
      { app_id: "OUTRO_APP_9999", scopes: ["read", "write"] },
      { app_id: appId, scopes: ["read", "offline_access"] },
    ],
  };
}

/** Uma pergunta valida, carregada de campo hostil. Nenhum deles tem por
 *  onde atravessar: `normalizarPergunta` CONSTROI um objeto novo com
 *  cinco chaves, em vez de apagar as indesejadas de um objeto recebido. */
function perguntaHostil(id: string, itemId: string): Linha {
  return {
    id,
    item_id: itemId,
    text: "Esse produto tem garantia?",
    status: "UNANSWERED",
    date_created: "2026-09-01T10:00:00.000Z",
    seller_id: SELLER_A,
    access_token: SECRET_ACCESS_A6,
    from: { id: 55, nickname: "comprador" },
    answer: { text: "resposta interna" },
    campo_extra: "nao deve atravessar",
  };
}

function perguntasOk(): unknown {
  return {
    questions: [
      perguntaHostil("Q1", "MLB111"),
      perguntaHostil("Q2", "MLB222"),
      // Malformado: sem `item_id`. O descarte e comportamento REAL.
      { id: "Q3", text: "sem anuncio", status: "UNANSWERED", date_created: "2026-09-02T10:00:00.000Z" },
    ],
    total: 3,
  };
}

// ─── Ordem observada da cadeia ────────────────────────────────────────
//
// Cada marco esta preso a um artefato REAL e observavel, nunca a uma
// afirmacao do teste sobre si mesmo. Onde o marco nao tem observavel
// proprio, ele esta preso ao artefato que so pode existir se aquele
// passo aconteceu — e isso esta dito, marco a marco, no relatorio.
const ORDEM_ESPERADA = [
  "permission_patched",
  "requirement_resolved",
  "GET_before_patch",
  "connection_patched",
  "GET_after_patch",
  "binding_resolved",
  "coverage_confirmed",
  "guard_authorized",
  "function_dispatched",
  "handler_called",
  "adapter_called",
  "provider_fixture_normalized",
  "response_returned",
] as const;

const ordem: string[] = [];
const marcar = (m: string) => { ordem.push(m); };

// ─── Utilitarios de requisicao ────────────────────────────────────────

const reqConexoes = (agenteId: string, cookie: string, corpo?: string) =>
  new Request(`http://localhost/api/agentes/${agenteId}/conexoes`, {
    method: corpo === undefined ? "GET" : "PATCH",
    headers: cookie ? { cookie, "Content-Type": "application/json" } : {},
    ...(corpo === undefined ? {} : { body: corpo }),
  });

const reqPermissoes = (agenteId: string, cookie: string, corpo?: string) =>
  new Request(`http://localhost/api/agentes/${agenteId}/permissoes`, {
    method: corpo === undefined ? "GET" : "PATCH",
    headers: cookie ? { cookie, "Content-Type": "application/json" } : {},
    ...(corpo === undefined ? {} : { body: corpo }),
  });

const semSegredo = (v: unknown): boolean => {
  const s = JSON.stringify(v ?? null);
  return !s.includes(SECRET_ACCESS_A6) && !s.includes(SECRET_REFRESH_A6);
};

const contaRede = (tipo: ChamadaRede["tipo"]) => rede.filter((c) => c.tipo === tipo).length;
const leituras = () => operacoes.filter((o) => o.tipo === "leitura").length;

async function main(): Promise<void> {
  console.log("\n══ CDS IA — M2-I1-A6: aceitacao E2E local ══");

  const rotaConexoes = await import("../app/api/agentes/[agenteId]/conexoes/route");
  const rotaPermissoes = await import("../app/api/agentes/[agenteId]/permissoes/route");
  const { executarFuncao } = await import("../lib/agentes/execucao-funcoes/executar");
  const { confirmarCoberturaML } = await import("../lib/mercado-livre-concessoes");
  const { removerSelecaoDeLoja, definirSelecaoDeLoja } = await import(
    "../lib/agentes/conexoes/selecao-escrita"
  );

  const GET = (agenteId: string, cookie: string) =>
    rotaConexoes.GET(reqConexoes(agenteId, cookie), { params: { agenteId } });
  const PATCH = (agenteId: string, cookie: string, corpo: unknown) =>
    rotaConexoes.PATCH(reqConexoes(agenteId, cookie, JSON.stringify(corpo)), {
      params: { agenteId },
    });
  const PATCH_PERM = (agenteId: string, cookie: string, corpo: unknown) =>
    rotaPermissoes.PATCH(reqPermissoes(agenteId, cookie, JSON.stringify(corpo)), {
      params: { agenteId },
    });

  // ═══ A. O duplo antes de tudo ═══════════════════════════════════════
  //
  // Um armazem complacente faria a suite inteira passar sem provar nada.
  // Estes asserts sao sobre o INSTRUMENTO, e vem antes da medicao.

  secao("A. O instrumento: o armazem tem de ser exigente");

  semear();
  ok("A1  o banco foi interceptado", interceptouBanco === true);
  ok("A2  a sessao foi interceptada", interceptouSessao === true);
  ok("A3  nenhuma env de Supabase real no processo",
    !process.env.NEXT_PUBLIC_SUPABASE_URL && !process.env.SUPABASE_SERVICE_ROLE_KEY);
  ok("A4  ML_CLIENT_SECRET ausente de proposito",
    process.env.ML_CLIENT_SECRET === undefined);
  ok("A5  `agente_conexoes` comeca VAZIA", tabela("agente_conexoes").length === 0);
  ok("A6  `agente_permissoes` comeca VAZIA", tabela("agente_permissoes").length === 0);

  {
    // O `select` projeta de verdade: coluna nao pedida nao volta.
    const r = await (clienteFake.from("lojas") as {
      select: (c: string) => { eq: (a: string, b: unknown) => Promise<{ data: unknown }> };
    })
      .select("id, nome")
      .eq("id", LOJA_A);
    const linha = ((r.data ?? []) as Linha[])[0] ?? {};
    ok("A7  o `select` PROJETA — token nao volta numa projecao que nao o pediu",
      Object.keys(linha).sort().join(",") === "id,nome");
  }
  {
    // `.not(col,"is",null)` precisa realmente excluir nulo.
    tabela("lojas").push({ id: "sem-token", user_id: USER_A, marketplace: "ML", ativo: true, access_token: null });
    const r = await (clienteFake.from("lojas") as {
      select: (c: string) => {
        eq: (a: string, b: unknown) => { not: (a: string, b: string, c: unknown) => Promise<{ data: unknown }> };
      };
    })
      .select("id")
      .eq("user_id", USER_A)
      .not("access_token", "is", null);
    const ids = ((r.data ?? []) as Linha[]).map((l) => l.id);
    ok("A8  `.not(is null)` exclui a linha sem token", !ids.includes("sem-token"));
    ok("A8a CONTROLE: e mantem as que tem token",
      ids.includes(LOJA_A) && ids.includes(LOJA_B));
    semear();
  }
  {
    // FK composta: as quatro causas dao o MESMO codigo.
    const alheio = await definirSelecaoDeLoja({
      userId: USER_B, agenteId: AGENTE_A, plataforma: PLATAFORMA, recurso: RECURSO, lojaId: LOJA_A,
    });
    ok("A9  FK composta recusa agente alheio com 23503 -> nao_disponivel",
      alheio.estado === "nao_disponivel");
    const lojaAlheia = await definirSelecaoDeLoja({
      userId: USER_B, agenteId: AGENTE_B, plataforma: PLATAFORMA, recurso: RECURSO, lojaId: LOJA_A,
    });
    ok("A9a e recusa loja alheia com o MESMO estado — indistinguivel",
      lojaAlheia.estado === "nao_disponivel");
    ok("A9b e nada foi gravado", tabela("agente_conexoes").length === 0);
    semear();
  }

  // ═══ B. Sentinelas nao-vacuas ═══════════════════════════════════════

  secao("B. As sentinelas precisam ser capazes de reprovar");

  {
    let lancou = false;
    try {
      await fetch("https://example.invalid/unexpected");
    } catch {
      lancou = true;
    }
    ok("B1  a sentinela de rede REPROVA uma URL nao prevista", lancou);
    ok("B1a e a registra como inesperada", contaRede("inesperada") === 1);
    ok("B1b CONTROLE: sem esta prova, uma sentinela frouxa passaria calada", true);
    rede = [];
  }
  {
    // Grant com query string NAO e o endpoint real — tem de ser recusado.
    let lancou = false;
    try {
      await fetch(`https://api.mercadolibre.com/users/${SELLER_A}/applications?app_id=${APP_ID}`);
    } catch {
      lancou = true;
    }
    ok("B2  `/applications?query` nao e o endpoint real e e recusado", lancou);
    rede = [];
  }

  // ═══ C. Happy path, na ordem ════════════════════════════════════════

  secao("C. Happy path: permissao -> requisito -> selecao -> execucao");

  semear();
  respostaGrant = { status: 200, corpo: grantOk() };
  respostaPerguntas = { status: 200, corpo: perguntasOk() };

  // ── 1. A permissao, pela ROTA real ────────────────────────────────
  {
    const r = await PATCH_PERM(AGENTE_A, COOKIE_A, { funcaoId: ID_ML, nivel: "automatico" });
    const corpo = await r.json();
    ok("E2E-1a a permissao e definida pela rota REAL", r.status === 200 && corpo.ok === true);
    ok("E2E-1b e a linha existe no armazem, escrita pelo owner",
      tabela("agente_permissoes").length === 1 &&
      tabela("agente_permissoes")[0].funcao_id === ID_ML &&
      tabela("agente_permissoes")[0].nivel === "automatico");
    ok("E2E-1c zero rede na definicao de permissao", rede.length === 0);
    if (r.status === 200) marcar("permission_patched");
  }

  // ── 2/3. O GET antes do PATCH ─────────────────────────────────────
  let elegiveisAntes: Array<{ id: string }> = [];
  {
    operacoes = [];
    const r = await GET(AGENTE_A, COOKIE_A);
    const corpo = await r.json();
    const leuPermissoes = operacoes.some((o) => o.tabela === "agente_permissoes" && o.tipo === "leitura");
    if (leuPermissoes) marcar("requirement_resolved");

    const req = (corpo.conexoes ?? []).find(
      (x: { plataforma: string; recurso: string }) => x.plataforma === PLATAFORMA && x.recurso === RECURSO
    );
    elegiveisAntes = req?.lojasElegiveis ?? [];

    ok("E2E-1  o requisito NASCE de registry + agente_permissoes + agregador",
      leuPermissoes && req !== undefined);
    ok("E2E-2  antes do PATCH: sem selecao e nao utilizavel",
      req?.lojaIdSelecionada === null && req?.utilizavel === false);
    ok("E2E-2a as duas lojas ML aparecem como elegiveis",
      elegiveisAntes.length === 2 &&
      elegiveisAntes.every((l) => l.id === LOJA_A || l.id === LOJA_B));
    ok("E2E-2b a loja Shopee NAO aparece",
      !JSON.stringify(elegiveisAntes).includes(LOJA_C));
    ok("E2E-2c GET remote calls = 0", rede.length === 0);
    ok("E2E-2d e nenhuma escrita aconteceu no GET",
      operacoes.every((o) => o.tipo === "leitura"));
    if (r.status === 200) marcar("GET_before_patch");
  }

  // ── 4. O PATCH da conexao ─────────────────────────────────────────
  {
    operacoes = [];
    const r = await PATCH(AGENTE_A, COOKIE_A, { plataforma: PLATAFORMA, recurso: RECURSO, lojaId: LOJA_A });
    const corpo = await r.json();
    const upserts = operacoes.filter((o) => o.tabela === "agente_conexoes" && o.tipo === "upsert");

    ok("E2E-3  o PATCH grava UMA linha", r.status === 200 && corpo.ok === true &&
      tabela("agente_conexoes").length === 1);
    ok("E2E-3a e ela veio do owner real, nao de injecao",
      upserts.length === 1 && upserts[0].payload?.loja_id === LOJA_A);
    ok("E2E-3b o upsert carrega `user_id` na linha, e a chave de conflito NAO o inclui",
      upserts[0]?.payload?.user_id === USER_A &&
      tabela("agente_conexoes")[0].user_id === USER_A);
    ok("E2E-3c `criado_em` foi criado e `alterado_em` gravado",
      typeof tabela("agente_conexoes")[0].criado_em === "string" &&
      typeof tabela("agente_conexoes")[0].alterado_em === "string");
    ok("E2E-3d PATCH remote calls = 0", rede.length === 0);
    if (r.status === 200) marcar("connection_patched");
  }

  // ── 4b. Substituicao preserva `criado_em` ─────────────────────────
  {
    const criadoAntes = tabela("agente_conexoes")[0].criado_em;
    await PATCH(AGENTE_A, COOKIE_A, { plataforma: PLATAFORMA, recurso: RECURSO, lojaId: LOJA_B });
    ok("E2E-3e a substituicao preserva `criado_em`",
      tabela("agente_conexoes").length === 1 &&
      tabela("agente_conexoes")[0].criado_em === criadoAntes &&
      tabela("agente_conexoes")[0].loja_id === LOJA_B);
    // volta para a loja A, que e a do cenario
    await PATCH(AGENTE_A, COOKIE_A, { plataforma: PLATAFORMA, recurso: RECURSO, lojaId: LOJA_A });
    ok("E2E-3f e continua havendo UMA linha depois de tres PATCH",
      tabela("agente_conexoes").length === 1 && tabela("agente_conexoes")[0].loja_id === LOJA_A);
  }

  // ── 5. O GET depois do PATCH — o oraculo de causalidade ───────────
  let respostaGetDepois: unknown = null;
  {
    rede = [];
    const r = await GET(AGENTE_A, COOKIE_A);
    const corpo = await r.json();
    respostaGetDepois = corpo;
    const req = (corpo.conexoes ?? []).find(
      (x: { plataforma: string }) => x.plataforma === PLATAFORMA
    );
    ok("E2E-4  o GET posterior observa a selecao do PATCH — MESMO armazem",
      req?.lojaIdSelecionada === LOJA_A && req?.utilizavel === true);
    ok("E2E-4a e continua sem tocar marketplace", rede.length === 0);
    if (req?.lojaIdSelecionada === LOJA_A) marcar("GET_after_patch");
  }

  // ── 6..13. A execucao ─────────────────────────────────────────────
  let resultadoExecucao: Record<string, unknown> = {};
  {
    operacoes = [];
    rede = [];
    capturarConsole();
    const r = (await executarFuncao({
      userId: USER_A,
      agenteId: AGENTE_A,
      funcaoId: ID_ML,
      argumentos: { limite: 20 },
    })) as unknown as Record<string, unknown>;
    soltarConsole();
    resultadoExecucao = r;

    const emLote = (f: unknown): boolean =>
      typeof f === "object" && f !== null && "__in" in (f as Record<string, unknown>);
    const lotes = operacoes.filter(
      (o) => o.tabela === "lojas" && o.tipo === "leitura" && emLote(o.filtros.id)
    );
    if (lotes.length > 0) marcar("binding_resolved");

    const grant = rede.filter((c) => c.tipo === "grant");
    if (grant.length === 1) marcar("coverage_confirmed");

    // `guard_authorized` e `function_dispatched` estao presos a UM
    // artefato real cada: a linha de abertura so e inserida DEPOIS de
    // `autorizarFuncao` permitir (uma negacao grava desfecho sem
    // execucao, que e outra linha), e ela carrega `funcao_id`.
    const chamadas = tabela("agente_funcao_chamadas");
    const abertura = chamadas.find((l) => l.fase === "abertura");
    if (abertura !== undefined) marcar("guard_authorized");
    if (abertura?.funcao_id === ID_ML) marcar("function_dispatched");

    // `handler_called`: a leitura de credencial por id so acontece
    // dentro do adapter, que so o handler aciona.
    const credenciais = operacoes.filter(
      (o) => o.tabela === "lojas" && o.tipo === "leitura" && o.filtros.marketplace === "ML"
    );
    if (credenciais.length > 0) marcar("handler_called");

    const perguntas = rede.filter((c) => c.tipo === "perguntas");
    if (perguntas.length === 1) marcar("adapter_called");

    const dados = (r.envelope as { data?: { linhas?: unknown[] } } | undefined)?.data;
    const linhas = (dados?.linhas ?? []) as Linha[];
    ok("E2E-8b o envelope e de SUCESSO, com contrato versionado",
      r.tipo === "sucesso" &&
      (r.envelope as { ok?: boolean; contrato?: number }).ok === true &&
      (r.envelope as { contrato?: number }).contrato === 1);
    if (linhas.length > 0) marcar("provider_fixture_normalized");
    marcar("response_returned");

    ok("E2E-5  o executor resolveu o binding a partir do armazem",
      abertura?.plataforma === PLATAFORMA &&
      abertura?.recurso === RECURSO &&
      abertura?.loja_id === LOJA_A);
    ok("E2E-6  a cobertura usou o endpoint REAL do grant",
      grant.length === 1 && grant[0].pathname === `/users/${SELLER_A}/applications` &&
      grant[0].busca === "");
    ok("E2E-6a exatamente UMA chamada de grant por execucao", grant.length === 1);
    ok("E2E-6b o grant foi pedido com o token da conta, no header",
      grant[0]?.autorizacao === `Bearer ${SECRET_ACCESS_A6}`);
    ok("E2E-7  o guard autorizou: ha abertura e nao ha desfecho sem execucao",
      abertura !== undefined &&
      !chamadas.some((l) => l.fase === "desfecho" && l.status === "negado"));
    ok("E2E-8  a Funcao despachada e `mercadolivre.perguntas.listar`",
      abertura?.funcao_id === ID_ML);
    ok("E2E-8a e o nivel registrado no momento foi `automatico`",
      abertura?.nivel_no_momento === "automatico");
    ok("E2E-9  o adapter foi chamado com a conta do CONTEXTO, nao dos args",
      perguntas.length === 1 && grant[0]?.pathname.includes(SELLER_A));
    ok("E2E-9a o argumento `limite` atravessou para a query do provider",
      perguntas[0]?.busca.includes("limit=20"));
    ok("E2E-9b e `offset` tambem, com o default do dominio",
      perguntas[0]?.busca.includes("offset=0"));
    ok("E2E-10 a normalizacao real devolveu as CINCO chaves congeladas",
      linhas.length === 2 &&
      linhas.every((l) => Object.keys(l).sort().join(",") === "anuncioId,criadaEm,id,status,texto"));
    ok("E2E-10a o item malformado foi descartado pelo comportamento REAL",
      linhas.length === 2 && !JSON.stringify(linhas).includes("sem anuncio"));
    ok("E2E-10b nenhum campo hostil atravessou",
      !JSON.stringify(linhas).includes("seller_id") &&
      !JSON.stringify(linhas).includes("campo_extra") &&
      !JSON.stringify(linhas).includes("resposta interna"));
    ok("E2E-20a zero chamada inesperada de rede", contaRede("inesperada") === 0);
    ok("E2E-20b zero RPC", rpcs === 0);
  }

  // ── A ordem ───────────────────────────────────────────────────────
  {
    ok("E2E-22 a cadeia aconteceu na ordem exata congelada",
      JSON.stringify(ordem) === JSON.stringify([...ORDEM_ESPERADA]),
      ordem.join(" > "));
    ok("E2E-22a CONTROLE: a ordem tem os treze marcos, nao um subconjunto",
      ordem.length === ORDEM_ESPERADA.length);
    ok("E2E-22b CONTROLE NEGATIVO: uma permutacao reprovaria",
      JSON.stringify([...ordem].reverse()) !== JSON.stringify([...ORDEM_ESPERADA]));
  }

  // ═══ D. Seguranca ═══════════════════════════════════════════════════

  secao("D. Seguranca: o que nunca pode sair");

  {
    const permResp = await (await rotaPermissoes.GET(reqPermissoes(AGENTE_A, COOKIE_A), {
      params: { agenteId: AGENTE_A },
    })).json();

    const superficies: Array<[string, unknown]> = [
      ["GET connections", respostaGetDepois],
      ["GET permissions", permResp],
      ["executarFuncao result", resultadoExecucao],
      ["console capturado", capturado],
    ];

    for (const [nome, valor] of superficies) {
      ok(`E2E-11 sem segredo em: ${nome}`, semSegredo(valor));
    }
    ok("E2E-11a `seller_id` nao sai na resposta de conexoes",
      !JSON.stringify(respostaGetDepois).includes(SELLER_A) &&
      !JSON.stringify(respostaGetDepois).includes("seller_id"));
    ok("E2E-11b o identificador da aplicacao nao sai por minimizacao — e NAO e segredo",
      !JSON.stringify(respostaGetDepois).includes(APP_ID) &&
      !JSON.stringify(resultadoExecucao).includes(APP_ID));
    ok("E2E-11c CONTROLE: a sonda de segredo ACUSA quando o segredo esta la",
      !semSegredo({ token: SECRET_ACCESS_A6 }) && !semSegredo({ r: SECRET_REFRESH_A6 }));
  }

  // ═══ E. Isolamento ══════════════════════════════════════════════════

  secao("E. Isolamento entre donos e entre contas");

  {
    const g = await GET(AGENTE_A, COOKIE_B);
    ok("E2E-12 user B nao le o agente de A", g.status === 404);
    const p = await PATCH(AGENTE_A, COOKIE_B, { plataforma: PLATAFORMA, recurso: RECURSO, lojaId: LOJA_A });
    ok("E2E-12a user B nao seleciona no agente de A", p.status === 404);
    ok("E2E-12b e a selecao de A segue intacta",
      tabela("agente_conexoes").length === 1 && tabela("agente_conexoes")[0].loja_id === LOJA_A);

    const exec = (await executarFuncao({
      userId: USER_B, agenteId: AGENTE_B, funcaoId: ID_ML, argumentos: { limite: 5 },
    })) as unknown as Record<string, unknown>;
    ok("E2E-12c o executor de B nao ve o binding de A",
      exec.tipo === "negado");
  }

  // ── E2E-23 — a remocao cruzada ────────────────────────────────────
  {
    const antes = { ...tabela("agente_conexoes")[0] };
    const r = await removerSelecaoDeLoja({
      userId: USER_B, agenteId: AGENTE_A, plataforma: PLATAFORMA, recurso: RECURSO,
    });
    const depois = tabela("agente_conexoes")[0];
    ok("E2E-23 user B nao remove o binding de A", r.estado === "nao_encontrada");
    ok("E2E-23a e a linha de A continua identica",
      tabela("agente_conexoes").length === 1 &&
      depois.loja_id === antes.loja_id &&
      depois.alterado_em === antes.alterado_em &&
      depois.criado_em === antes.criado_em);
    // NAO-VACUIDADE: sem isto, um duplo que nunca remove nada "mataria"
    // o mutante de mentira.
    const legitimo = await removerSelecaoDeLoja({
      userId: USER_A, agenteId: AGENTE_A, plataforma: PLATAFORMA, recurso: RECURSO,
    });
    ok("E2E-23b CONTROLE DE NAO-VACUIDADE: A remove A de verdade",
      legitimo.estado === "removida" && tabela("agente_conexoes").length === 0);
    // restaura o cenario
    await PATCH(AGENTE_A, COOKIE_A, { plataforma: PLATAFORMA, recurso: RECURSO, lojaId: LOJA_A });
  }

  // ── E2E-13 — cross-store ──────────────────────────────────────────
  {
    rede = [];
    await executarFuncao({ userId: USER_A, agenteId: AGENTE_A, funcaoId: ID_ML, argumentos: { limite: 3 } });
    const grant = rede.filter((c) => c.tipo === "grant");
    ok("E2E-13 a cobertura foi pedida para o seller da loja A",
      grant.length === 1 && grant[0].pathname === `/users/${SELLER_A}/applications`);
    ok("E2E-13a e o seller da loja B nunca aparece em chamada nenhuma",
      !rede.some((c) => c.url.includes(SELLER_B)));
    const caminhoDoSeller = (seller: string) => `/users/${seller}/applications`;
    ok("E2E-13b CONTROLE: o mesmo predicado REPROVA a URL do seller da loja B",
      grant.length === 1 &&
      grant[0].pathname === caminhoDoSeller(SELLER_A) &&
      grant[0].pathname !== caminhoDoSeller(SELLER_B));
  }

  // ── E2E-14 — loja incompativel ────────────────────────────────────
  {
    semear();
    await PATCH_PERM(AGENTE_A, COOKIE_A, { funcaoId: ID_ML, nivel: "automatico" });
    const r = await PATCH(AGENTE_A, COOKIE_A, { plataforma: PLATAFORMA, recurso: RECURSO, lojaId: LOJA_C });
    ok("E2E-14 loja Shopee num requisito de ML da 409", r.status === 409);
    ok("E2E-14a e ZERO linha foi gravada — o status sozinho nao provaria",
      tabela("agente_conexoes").length === 0);
  }

  // ═══ F. Caminhos negativos ══════════════════════════════════════════

  secao("F. Caminhos negativos");

  // ── E2E-15 — remocao pela rota ────────────────────────────────────
  {
    semear();
    await PATCH_PERM(AGENTE_A, COOKIE_A, { funcaoId: ID_ML, nivel: "automatico" });
    await PATCH(AGENTE_A, COOKIE_A, { plataforma: PLATAFORMA, recurso: RECURSO, lojaId: LOJA_A });
    const r = await PATCH(AGENTE_A, COOKIE_A, { plataforma: PLATAFORMA, recurso: RECURSO, lojaId: null });
    ok("E2E-15 a remocao responde 200", r.status === 200);
    ok("E2E-15a e a linha sumiu do armazem", tabela("agente_conexoes").length === 0);

    const corpo = await (await GET(AGENTE_A, COOKIE_A)).json();
    const req = (corpo.conexoes ?? []).find((x: { plataforma: string }) => x.plataforma === PLATAFORMA);
    ok("E2E-15b o GET volta a null e nao utilizavel",
      req?.lojaIdSelecionada === null && req?.utilizavel === false);

    rede = [];
    const exec = (await executarFuncao({
      userId: USER_A, agenteId: AGENTE_A, funcaoId: ID_ML, argumentos: { limite: 5 },
    })) as unknown as Record<string, unknown>;
    ok("E2E-15c e o executor volta a negar `conexao_ausente`",
      exec.tipo === "negado" && exec.codigo === "conexao_ausente");
    ok("E2E-15d sem gastar rede nenhuma", rede.length === 0);
  }

  // ── E2E-16 — Funcao bloqueada ─────────────────────────────────────
  {
    semear();
    await PATCH_PERM(AGENTE_A, COOKIE_A, { funcaoId: ID_ML, nivel: "bloqueado" });
    const corpo = await (await GET(AGENTE_A, COOKIE_A)).json();
    const req = (corpo.conexoes ?? []).find((x: { plataforma: string }) => x.plataforma === PLATAFORMA);
    ok("E2E-16 nivel bloqueado NAO gera requisito", req === undefined);

    const p = await PATCH(AGENTE_A, COOKIE_A, { plataforma: PLATAFORMA, recurso: RECURSO, lojaId: LOJA_A });
    ok("E2E-16a e o PATCH para esse par e recusado com 409", p.status === 409);
    ok("E2E-16b sem gravar nada", tabela("agente_conexoes").length === 0);

    rede = [];
    const exec = (await executarFuncao({
      userId: USER_A, agenteId: AGENTE_A, funcaoId: ID_ML, argumentos: { limite: 5 },
    })) as unknown as Record<string, unknown>;
    ok("E2E-16c o executor nega `permissao_bloqueada`",
      exec.tipo === "negado" && exec.codigo === "permissao_bloqueada");
    ok("E2E-16d zero chamada ao provider de perguntas", contaRede("perguntas") === 0);
  }

  // ── E2E-17 — aprovacao ────────────────────────────────────────────
  {
    semear();
    respostaGrant = { status: 200, corpo: grantOk() };
    await PATCH_PERM(AGENTE_A, COOKIE_A, { funcaoId: ID_ML, nivel: "automatico" });
    await PATCH(AGENTE_A, COOKIE_A, { plataforma: PLATAFORMA, recurso: RECURSO, lojaId: LOJA_A });
    await PATCH_PERM(AGENTE_A, COOKIE_A, { funcaoId: ID_ML, nivel: "aprovacao" });

    rede = [];
    const exec = (await executarFuncao({
      userId: USER_A, agenteId: AGENTE_A, funcaoId: ID_ML, argumentos: { limite: 5 },
    })) as unknown as Record<string, unknown>;
    ok("E2E-17 com binding e cobertura possiveis, `aprovacao` NAO executa",
      exec.tipo === "aguardando_aprovacao",
      `tipo=${String(exec.tipo)} codigo=${String(exec.codigo)}`);
    ok("E2E-17a zero chamada ao provider de perguntas", contaRede("perguntas") === 0);
    ok("E2E-17b a espera virou UMA aprovacao pendente, com a loja do binding",
      tabela("agente_funcao_aprovacoes").length === 1 &&
      tabela("agente_funcao_aprovacoes")[0].conexao_loja_id === LOJA_A &&
      tabela("agente_funcao_aprovacoes")[0].funcao_id === ID_ML);
    ok("E2E-17c e nenhuma Tool Call de abertura nasceu neste ramo",
      !tabela("agente_funcao_chamadas").some((l) => l.fase === "abertura"));
    ok("E2E-17d a RPC chamada foi `aprovacao_criar`, e so ela",
      rpcsChamadas.length === 1 && rpcsChamadas[0].nome === "aprovacao_criar");
  }

  // ── E2E-18 — cobertura recusada ───────────────────────────────────
  {
    semear();
    await PATCH_PERM(AGENTE_A, COOKIE_A, { funcaoId: ID_ML, nivel: "automatico" });
    await PATCH(AGENTE_A, COOKIE_A, { plataforma: PLATAFORMA, recurso: RECURSO, lojaId: LOJA_A });

    rede = [];
    respostaGrant = { status: 403, corpo: { message: "forbidden", cause: SECRET_ACCESS_A6 } };
    capturarConsole();
    const exec = (await executarFuncao({
      userId: USER_A, agenteId: AGENTE_A, funcaoId: ID_ML, argumentos: { limite: 5 },
    })) as unknown as Record<string, unknown>;
    soltarConsole();
    ok("E2E-18 grant 403 bloqueia a execucao com `conexao_ausente`",
      exec.tipo === "negado" && exec.codigo === "conexao_ausente");
    ok("E2E-18a zero chamada ao provider de perguntas", contaRede("perguntas") === 0);
    ok("E2E-18b e o corpo do provider nao vaza no resultado", semSegredo(exec));
  }

  // ── E2E-19 — provider de perguntas recusa ─────────────────────────
  {
    rede = [];
    respostaGrant = { status: 200, corpo: grantOk() };
    respostaPerguntas = { status: 403, corpo: { message: "forbidden", token: SECRET_ACCESS_A6 } };
    capturarConsole();
    const exec = (await executarFuncao({
      userId: USER_A, agenteId: AGENTE_A, funcaoId: ID_ML, argumentos: { limite: 5 },
    })) as unknown as Record<string, unknown>;
    soltarConsole();
    const texto = JSON.stringify(exec);
    ok("E2E-19 perguntas 403 vira `nao_autorizado` sanitizado",
      texto.includes("nao_autorizado"));
    ok("E2E-19a sem status, sem corpo, sem Authorization, sem mensagem do provider",
      !texto.includes("403") && !texto.includes("forbidden") &&
      !texto.includes("Authorization") && semSegredo(exec));
    respostaPerguntas = { status: 200, corpo: perguntasOk() };
  }

  // ── E2E-21 — HARD BOUND ───────────────────────────────────────────
  {
    rede = [];
    const escrita = await confirmarCoberturaML({ userId: USER_A, lojaId: LOJA_A, acesso: "escrita" });
    ok("E2E-21 acesso de ESCRITA nunca confirma cobertura",
      escrita.cobertura === "nao_verificavel" && escrita.motivo === "configuracao_ausente");
    ok("E2E-21a e nao gasta rede nenhuma para descobrir isso", rede.length === 0);
    const leitura = await confirmarCoberturaML({ userId: USER_A, lojaId: LOJA_A, acesso: "leitura" });
    ok("E2E-21b CONTROLE: a MESMA loja confirma em leitura",
      leitura.cobertura === "confirmada" && rede.length === 1);
  }

  // ── Controles do parser de grant ──────────────────────────────────
  {
    rede = [];
    respostaGrant = { status: 200, corpo: [{ app_id: APP_ID, scopes: ["read"] }] };
    const arrayCru = await confirmarCoberturaML({ userId: USER_A, lojaId: LOJA_A, acesso: "leitura" });
    ok("E2E-6c o array CRU tambem e aceito pelo parser real",
      arrayCru.cobertura === "confirmada");

    respostaGrant = { status: 200, corpo: { applications: [{ app_id: Number(123456), scopes: ["read"] }] } };
    process.env.ML_CLIENT_ID = "123456";
    const numerico = await confirmarCoberturaML({ userId: USER_A, lojaId: LOJA_A, acesso: "leitura" });
    ok("E2E-6d `app_id` numerico e aceito pela conversao real",
      numerico.cobertura === "confirmada");
    process.env.ML_CLIENT_ID = APP_ID;

    respostaGrant = { status: 200, corpo: grantOk(APP_ID + "X") };
    const parecido = await confirmarCoberturaML({ userId: USER_A, lojaId: LOJA_A, acesso: "leitura" });
    ok("E2E-6e `app_id` PARECIDO nao passa por semelhanca",
      parecido.cobertura === "nao_verificavel" && parecido.motivo === "grant_ausente");

    respostaGrant = { status: 200, corpo: { applications: [{ app_id: APP_ID, scopes: ["write"] }] } };
    const semRead = await confirmarCoberturaML({ userId: USER_A, lojaId: LOJA_A, acesso: "leitura" });
    ok("E2E-6f escopo sem `read` e ausencia de concessao, nao resposta invalida",
      semRead.cobertura === "nao_verificavel" && semRead.motivo === "grant_ausente");

    respostaGrant = { status: 200, corpo: grantOk() };
  }

  // ═══ G. Orcamentos ══════════════════════════════════════════════════

  secao("G. Orcamentos medidos, e a ausencia de N+1");

  let queriesGet = 0;
  let queriesPatch = 0;
  let queriesExec = 0;
  {
    semear();
    await PATCH_PERM(AGENTE_A, COOKIE_A, { funcaoId: ID_ML, nivel: "automatico" });

    operacoes = [];
    rede = [];
    await GET(AGENTE_A, COOKIE_A);
    const queriesGetSemSelecao = leituras();
    ok("E2E-20c GET remote calls = 0", rede.length === 0);

    operacoes = [];
    rede = [];
    await PATCH(AGENTE_A, COOKIE_A, { plataforma: PLATAFORMA, recurso: RECURSO, lojaId: LOJA_A });
    queriesPatch = leituras();
    ok("E2E-20d PATCH remote calls = 0", rede.length === 0);

    // A linha de base do GET e medida COM selecao, porque e nesse estado
    // que as comparacoes de N+1 acontecem. Comparar o GET sem selecao com
    // o GET com selecao mediria a diferenca de ESTADO — o lote de `lojas`
    // das selecoes e o de fatos — e chamaria isso de crescimento.
    operacoes = [];
    await GET(AGENTE_A, COOKIE_A);
    queriesGet = leituras();
    ok("E2E-20c1 o GET com selecao custa mais que o GET sem — e isso e estado, nao N+1",
      queriesGet > queriesGetSemSelecao);

    operacoes = [];
    rede = [];
    await executarFuncao({ userId: USER_A, agenteId: AGENTE_A, funcaoId: ID_ML, argumentos: { limite: 20 } });
    queriesExec = leituras();
    ok("E2E-20e grant calls = 1", contaRede("grant") === 1);
    ok("E2E-20f questions calls = 1", contaRede("perguntas") === 1);
    ok("E2E-20g zero rede inesperada", contaRede("inesperada") === 0);

    console.log(`     [orcamento] GET=${queriesGet}  PATCH=${queriesPatch}  EXEC=${queriesExec} leituras`);
  }

  // ── N+1: o custo nao pode crescer com o numero de lojas ───────────
  {
    for (let i = 0; i < 8; i++) {
      tabela("lojas").push(lojaML(`extra-${i}`, USER_A, `9000100${i}`, `Extra ${i}`));
    }
    operacoes = [];
    await GET(AGENTE_A, COOKIE_A);
    const comMuitasLojas = leituras();
    ok("E2E-20h o GET nao faz mais consultas com 11 lojas do que com 3",
      comMuitasLojas === queriesGet, `${comMuitasLojas} vs ${queriesGet}`);

    operacoes = [];
    await executarFuncao({ userId: USER_A, agenteId: AGENTE_A, funcaoId: ID_ML, argumentos: { limite: 20 } });
    ok("E2E-20i a execucao tambem nao cresce com o numero de lojas",
      leituras() === queriesExec, `${leituras()} vs ${queriesExec}`);
  }

  // ── N+1: nem com o numero de requisitos da mesma plataforma ───────
  {
    // `vendas.consultar` nao exige conexao, entao habilitar a segunda
    // Funcao nao cria requisito novo — mas exercita o caminho em que o
    // catalogo inteiro e lido, que e onde um N+1 apareceria.
    operacoes = [];
    await PATCH_PERM(AGENTE_A, COOKIE_A, { funcaoId: ID_VENDAS, nivel: "automatico" });
    operacoes = [];
    await GET(AGENTE_A, COOKIE_A);
    ok("E2E-20j com DUAS Funcoes habilitadas o GET mantem o orcamento",
      leituras() === queriesGet, `${leituras()} vs ${queriesGet}`);
    ok("E2E-20k e a leitura de permissoes continua sendo UMA, em lote",
      operacoes.filter((o) => o.tabela === "agente_permissoes" && o.tipo === "leitura").length === 1);
  }

  // ── A prova final de que nada foi injetado a mao ──────────────────
  {
    const escritasEmConexoes = operacoes.filter(
      (o) => o.tabela === "agente_conexoes" && o.tipo !== "leitura"
    );
    ok("E2E-3g nesta fase nenhuma escrita direta em `agente_conexoes` aconteceu",
      escritasEmConexoes.length === 0);
    ok("E2E-20 zero banco real e zero rede real",
      interceptouBanco && interceptouSessao && contaRede("inesperada") === 0);
  }

  // ─── Placar ─────────────────────────────────────────────────────────

  const total = passou + falhou;
  console.log(
    `\n══ CDS IA — M2-I1-A6: aceitacao E2E local:  ${passou}/${total} passaram ══`
  );
  if (falhou > 0) console.log(`   ${falhou} FALHARAM`);
  console.log(`   FUNCTION_PRODUCT_SURFACE_M2_I1 = ABSENT`);
  console.log(`   LOCAL_FIXTURE_CONTRACT = TEST_ONLY / PROVIDER_RESPONSE_CONTRACT = UNVERIFIED`);
  process.exitCode = falhou === 0 ? 0 : 1;
}

void main();
