/**
 * CDS IA — SKILL-1D.agent-source-C. Suite do boundary `/api/agentes`.
 *
 * Os handlers `GET` e `POST` REAIS sao executados, e com eles a
 * capability real: `listarAgentesDoDono` e `criarAgente` rodam de
 * verdade contra um cliente DUPLADO **com estado** — o `insert` guarda
 * a linha, o `select` devolve o que foi guardado, filtrando por
 * `user_id` como o Postgres faria. Nenhuma das duas e substituida por
 * callback: o que se afirma nao e "o mock devolveu o esperado", e sim
 * que o pipeline real escreveu uma vez, leu uma vez, e que o agente
 * criado por A nunca aparece para B.
 *
 * ── Por que o duplo tem estado ──────────────────────────────────────
 *
 * A propriedade central desta frente e uma CADEIA: criar produz um uuid
 * real, listar devolve esse uuid, e ele serve de `agenteId` para o
 * diagnostico. Um fake sem memoria provaria as tres pontas isoladas e
 * nenhuma ligacao entre elas.
 *
 * ── Ordem de import ─────────────────────────────────────────────────
 *
 * `capability.ts` e server-only e abre o cliente Supabase no topo das
 * funcoes. O duplo de `Module.prototype.require` precisa estar
 * instalado ANTES de qualquer import de producao — por isso a rota
 * entra por `await import` dentro de `principal()`.
 *
 * Rodar:  npx tsx scripts/testar-ia-agentes-api.ts
 * Sem rede, sem banco, sem `--confirmo`. `SESSION_SECRET` e sintetico.
 */
import "./_server-only-inerte";

import Module from "node:module";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

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
const ROTA_REL = "app/api/agentes/route.ts";
const ler = (rel: string) => readFileSync(join(RAIZ, rel), "utf8");
const semComentarios = (f: string) =>
  f.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const CODIGO_ROTA = semComentarios(ler(ROTA_REL));

// ─── O duplo COM ESTADO ───────────────────────────────────────────────

interface Operacao {
  tabela: string;
  tipo: "leitura" | "escrita";
  filtros: Record<string, unknown>;
  payload?: Record<string, unknown>;
  /** APPROVAL-UI-API-A1: ordem e teto passaram a ser afirmaveis. Antes
   *  `order()` era no-op e `limit()` nem existia, entao uma fila sem
   *  limite teria passado. */
  ordens: { coluna: string; asc: boolean }[];
  limite: number | null;
  select: string;
  /** M1-I1-V2: as expressoes `or=(...)` acumuladas, cru como a producao
   *  as montou. Sao ANDadas entre si e com os `.eq()`, como no PostgREST. */
  ors: string[];
}

// ─── Avaliador minimo de expressao PostgREST ──────────────────────────
//
// Sem ele, `.or()` seria `undefined` no duplo e a rota devolveria 500 —
// falha honesta, mas inutil. Com um `or()` que apenas GUARDA a string e
// nao filtra, seria pior: a suite provaria "o conjunto e limitado"
// contra um filtro que nao filtra nada. Entao o duplo INTERPRETA a
// expressao que a producao realmente montou, termo a termo.
//
// Formas suportadas — as que o PostgREST aceita e que este projeto usa:
// `col.op.valor`, `col.in.(a,b,c)`, `and(...)` e `or(...)` aninhados.

function separarTermos(expressao: string): string[] {
  const termos: string[] = [];
  let profundidade = 0;
  let atual = "";
  for (const ch of expressao) {
    if (ch === "(") profundidade += 1;
    if (ch === ")") profundidade -= 1;
    if (ch === "," && profundidade === 0) {
      termos.push(atual);
      atual = "";
      continue;
    }
    atual += ch;
  }
  if (atual.length > 0) termos.push(atual);
  return termos;
}

function avaliarTermo(termo: string, linha: Record<string, unknown>): boolean {
  if (termo.startsWith("and(") && termo.endsWith(")")) {
    return separarTermos(termo.slice(4, -1)).every((t) => avaliarTermo(t, linha));
  }
  if (termo.startsWith("or(") && termo.endsWith(")")) {
    return separarTermos(termo.slice(3, -1)).some((t) => avaliarTermo(t, linha));
  }
  const primeiro = termo.indexOf(".");
  const segundo = termo.indexOf(".", primeiro + 1);
  if (primeiro === -1 || segundo === -1) return false;
  const coluna = termo.slice(0, primeiro);
  const operador = termo.slice(primeiro + 1, segundo);
  const valor = termo.slice(segundo + 1);
  const conteudo = linha[coluna];

  if (operador === "in") {
    return valor.replace(/^\(|\)$/g, "").split(",").includes(String(conteudo));
  }
  // Tres valores, como no Postgres: NULL nunca satisfaz comparacao.
  if (conteudo === null || conteudo === undefined) return operador === "is" && valor === "null";
  if (operador === "is") return valor !== "null";
  const atual = String(conteudo);
  if (operador === "eq") return atual === valor;
  if (operador === "gte") return atual >= valor;
  if (operador === "gt") return atual > valor;
  if (operador === "lte") return atual <= valor;
  if (operador === "lt") return atual < valor;
  return false;
}

/** A "tabela" `agentes` em memoria. */
let linhas: Record<string, unknown>[] = [];
let operacoes: Operacao[] = [];
/** Quando setado, a proxima operacao devolve este erro. */
let erroInjetado: Record<string, unknown> | null = null;

function limpar(): void {
  operacoes = [];
  erroInjetado = null;
}

function construtor(tabela: string): unknown {
  const op: Operacao = {
    tabela,
    tipo: "leitura",
    filtros: {},
    ordens: [],
    limite: null,
    select: "",
    ors: [],
  };
  let pendente: Record<string, unknown> | null = null;
  /** O payload de um UPDATE. Separado de `pendente` porque INSERT cria
   *  linha e UPDATE altera as que casarem os filtros. */
  let alteracao: Record<string, unknown> | null = null;
  /** O payload de um UPSERT e as colunas do `onConflict`. PERMISSOES-
   *  FUNCTION-V1-A: o upsert nao filtra por `.eq()` — ele identifica a
   *  linha pelo ALVO DO CONFLITO, e por isso precisa do proprio canal. */
  let conflito: { valores: Record<string, unknown>; chaves: string[] } | null = null;

  const executar = (): { data: unknown; error: unknown } => {
    operacoes.push(op);
    if (erroInjetado) {
      const e = erroInjetado;
      erroInjetado = null;
      return { data: null, error: e };
    }
    if (op.tipo === "escrita" && pendente) {
      // O banco preenche o que o cliente nao manda: uuid e timestamps.
      //
      // AGENT-VERTICAL-SLICE-V1-I2: os DEFAULT sao por TABELA, como no
      // Postgres. `agente_tarefas` nasce `pendente` com progresso 0 e
      // tentativas 0 (migration 20260916); `agentes` nasce `ativo`. Sem
      // isto o `status` inicial viria `undefined` e a suite provaria o
      // 202 contra um campo que o banco real sempre preenche.
      const padroes =
        op.tabela === "agente_tarefas"
          ? {
              status: "pendente",
              progresso: 0,
              tentativas: 0,
              max_tentativas: 3,
              resultado: null,
              erro_tipo: null,
              erro_mensagem: null,
            }
          : { ativo: true };
      const gravada = {
        id: randomUUID(),
        ...padroes,
        criado_em: new Date().toISOString(),
        atualizado_em: new Date().toISOString(),
        ...pendente,
      };
      linhas.push(gravada);
      return { data: gravada, error: null };
    }
    // PERMISSOES-FUNCTION-V1-A: `UPSERT ... ON CONFLICT (...) DO UPDATE`.
    //
    // Modelado de verdade, e nao como "devolva o esperado": a linha e
    // procurada pelo ALVO DO CONFLITO. Achou, o payload e aplicado SOBRE
    // ela — entao `criado_em`, que nao esta no payload, sobrevive. Nao
    // achou, nasce linha nova com o DEFAULT do banco. Sem isto a suite
    // provaria idempotencia e preservacao de `criado_em` contra um duplo
    // que nunca persistiu nada.
    if (op.tipo === "escrita" && conflito !== null) {
      const alvo = conflito.chaves.length === 0
        ? undefined
        : linhas.find(
            (l) =>
              l.__tabela === op.tabela &&
              conflito!.chaves.every((c) => l[c] === conflito!.valores[c])
          );
      if (alvo) {
        Object.assign(alvo, conflito.valores);
        return { data: alvo, error: null };
      }
      const criada = {
        __tabela: op.tabela,
        criado_em: new Date().toISOString(),
        ...conflito.valores,
      };
      linhas.push(criada);
      return { data: criada, error: null };
    }
    const encontradas = linhas.filter((l) =>
      // `__tabela` so existe nas linhas que o upsert criou. As fixtures
      // antigas seguem sem marca, e continuam casando como sempre.
      (l.__tabela === undefined || l.__tabela === op.tabela) &&
      Object.entries(op.filtros).every(([c, v]) => {
        if (v !== null && typeof v === "object" && "__in" in (v as object)) {
          return (v as { __in: unknown[] }).__in.includes(l[c]);
        }
        // APPROVAL-UI-API-A1: `.gt()` comparado de verdade. Modelar
        // como igualdade faria a fila devolver a linha VENCIDA e o
        // teste de expiracao passaria sobre um filtro que nao filtra.
        if (v !== null && typeof v === "object" && "__gt" in (v as object)) {
          return String(l[c]) > String((v as { __gt: unknown }).__gt);
        }
        return l[c] === v;
      }) &&
      // `or=(...)` e mais um AND em relacao aos `.eq()`, nunca um
      // substituto deles: o recorte por dono continua valendo.
      op.ors.every((expressao) => avaliarTermo(`or(${expressao})`, l))
    );
    // EDITAR-AGENTE-V1: `UPDATE ... WHERE ... RETURNING`, modelado com a
    // mesma economia do INSERT acima. Sem aplicar a alteracao, a rota
    // devolveria a linha ANTIGA e a suite provaria a persistencia contra
    // um valor que nunca mudou — verde por acidente.
    if (op.tipo === "escrita" && alteracao !== null) {
      for (const l of encontradas) Object.assign(l, alteracao);
    }

    // Ordem e teto aplicados de verdade, na ordem em que o Postgres os
    // aplica: ORDER BY primeiro, LIMIT depois. Limitar antes devolveria
    // as N primeiras da tabela em vez das N primeiras da ORDEM.
    let saida = encontradas;
    if (op.ordens.length > 0) {
      saida = [...saida].sort((a, b2) => {
        for (const { coluna, asc } of op.ordens) {
          const va = String(a[coluna] ?? "");
          const vb = String(b2[coluna] ?? "");
          if (va === vb) continue;
          return (va < vb ? -1 : 1) * (asc ? 1 : -1);
        }
        return 0;
      });
    }
    if (op.limite !== null) saida = saida.slice(0, op.limite);
    return { data: saida, error: null };
  };

  const b: Record<string, unknown> = {
    select(colunas?: string) { op.select = typeof colunas === "string" ? colunas : ""; return b; },
    eq(coluna: string, valor: unknown) { op.filtros[coluna] = valor; return b; },
    gt(coluna: string, valor: unknown) { op.filtros[coluna] = { __gt: valor }; return b; },
    // PERMISSOES-FUNCTION-V1-A: `resolverFatosPermissoes` fecha a
    // consulta nas Funcoes pedidas com `.in("funcao_id", ids)`. Sem
    // modelar isto o duplo lancava, a leitura virava `falha_leitura` e a
    // rota devolvia 500 — falha honesta, e foi assim que apareceu.
    in(coluna: string, valores: readonly unknown[]) {
      op.filtros[coluna] = { __in: [...valores] };
      return b;
    },
    or(expressao: string) {
      op.ors.push(expressao);
      return b;
    },
    order(coluna: string, opcoes?: { ascending?: boolean }) {
      op.ordens.push({ coluna, asc: opcoes?.ascending !== false });
      return b;
    },
    limit(n: number) { op.limite = n; return b; },
    insert(v: Record<string, unknown>) {
      op.tipo = "escrita";
      op.payload = v;
      pendente = v;
      return b;
    },
    update(v: Record<string, unknown>) {
      op.tipo = "escrita";
      op.payload = v;
      alteracao = v;
      return b;
    },
    upsert(v: Record<string, unknown>, opcoes?: { onConflict?: string }) {
      op.tipo = "escrita";
      op.payload = v;
      conflito = {
        valores: v,
        chaves: String(opcoes?.onConflict ?? "").split(",").map((c) => c.trim()).filter(Boolean),
      };
      return b;
    },
    delete() { op.tipo = "escrita"; return b; },
    maybeSingle() {
      return {
        then: (fn: (v: { data: unknown; error: unknown }) => void) => {
          const r = executar();
          fn({ data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error });
        },
      };
    },
    then(fn: (v: { data: unknown; error: unknown }) => void) { fn(executar()); },
  };
  return b;
}

let rpcs = 0;
/** Resposta programavel da RPC. O DEFAULT e o de sempre — `{ data: null,
 *  error: null }` —, entao todas as secoes anteriores, que so contam
 *  `rpcs`, continuam vendo exatamente o que viam. Quem precisa de um
 *  codigo especifico a define e a devolve ao default em seguida. */
let respostaRpc: { data: unknown; error: unknown } = { data: null, error: null };
const RPC_PADRAO: { data: unknown; error: unknown } = { data: null, error: null };
/** O que a ultima chamada recebeu, para provar que a rota passou o
 *  `p_user_id` da SESSAO e nao um id vindo do cliente. */
let ultimaRpc: { nome: string; args: Record<string, unknown> } | null = null;
const clienteFake = {
  from: (t: string) => construtor(t),
  rpc: (nome?: string, args?: Record<string, unknown>) => {
    rpcs++;
    ultimaRpc = { nome: nome ?? "", args: args ?? {} };
    return Promise.resolve(respostaRpc);
  },
};

const requireOriginal = (Module as unknown as { prototype: { require: (id: string) => unknown } }).prototype.require;
let interceptou = false;
(Module as unknown as { prototype: { require: unknown } }).prototype.require = function (this: unknown, id: string) {
  if (typeof id === "string" && id.includes("supabase-servidor")) {
    interceptou = true;
    return { getSupabaseServidor: () => clienteFake };
  }
  // eslint-disable-next-line prefer-rest-params
  return requireOriginal.apply(this, arguments as unknown as [string]);
};

// ─── Fixtures ─────────────────────────────────────────────────────────

const SEGREDO_TESTE = "segredo-sintetico-de-teste-agentes-api-0123456789";
process.env.SESSION_SECRET = SEGREDO_TESTE;

/** `uid` PRECISA ser uuid: `assinarSessao` recusa qualquer outra coisa. */
const USER_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAMPOS_PUBLICOS = ["ativo", "criado_em", "id", "instrucoes", "nome", "tipo"];
/**
 * M1-I1-V2: o GET da LISTA ganhou dois campos, e so ele.
 *
 * `POST` e `PATCH` continuam devolvendo os seis — por isso sao duas
 * constantes, e nao uma que cresceu. Um snapshot vazando para a resposta
 * de criacao seria estado operacional afirmado sobre um agente que ainda
 * nao tem tarefa nenhuma.
 */
const CAMPOS_PUBLICOS_COM_SNAPSHOT = [
  "atividade", "ativo", "criado_em", "id", "instrucoes", "nome", "sinais", "tipo",
];

function requisicao(cookie: string | undefined, corpo?: string): Request {
  return new Request("http://localhost/api/agentes", {
    method: corpo === undefined ? "GET" : "POST",
    headers: cookie ? { cookie } : {},
    ...(corpo === undefined ? {} : { body: corpo }),
  });
}

/** Uma linha como o banco a devolveria. */
const linhaAgente = (userId: string, nome: string, extra: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  user_id: userId,
  nome,
  tipo: "mensagens",
  instrucoes: null,
  ativo: true,
  criado_em: "2026-08-01T00:00:00.000Z",
  atualizado_em: "2026-08-01T00:00:00.000Z",
  ...extra,
});

/**
 * Uma linha de `agente_tarefas`, como o banco a devolveria.
 *
 * `__tabela` e obrigatorio aqui: sem ele a linha casaria tambem com a
 * consulta de `agentes`, e o teste mediria um banco que nao existe.
 */
const linhaTarefa = (
  userId: string,
  agenteId: string,
  extra: Record<string, unknown> = {}
) => ({
  __tabela: "agente_tarefas",
  id: randomUUID(),
  agente_id: agenteId,
  user_id: userId,
  tipo: "analise_vendas",
  entrada: { dias: 7 },
  status: "rodando",
  progresso: 0,
  resultado: null,
  erro_tipo: null,
  erro_mensagem: null,
  tentativas: 0,
  max_tentativas: 3,
  criado_em: "2026-09-01T00:00:00.000Z",
  iniciado_em: null,
  concluido_em: null,
  heartbeat_em: null,
  ...extra,
});

const escritas = () => operacoes.filter((o) => o.tipo === "escrita").length;
const leituras = () => operacoes.filter((o) => o.tipo === "leitura").length;

console.log("\n══ CDS IA — SKILL-1D.agent-source-C: /api/agentes ══");

// ─── A. Fronteira estatica ────────────────────────────────────────────

secao("A. A rota delega — e so isso");

ok("A1  o path autorizado existe", existsSync(join(RAIZ, ROTA_REL)));
ok("A2  exporta GET e POST, e mais nenhum verbo",
  /export async function GET\(/.test(CODIGO_ROTA) &&
    /export async function POST\(/.test(CODIGO_ROTA) &&
    !/export async function (PUT|PATCH|DELETE|HEAD|OPTIONS)\(/.test(CODIGO_ROTA));
ok("A3  declara force-dynamic", /export const dynamic = "force-dynamic"/.test(CODIGO_ROTA));
ok("A4  nao declara runtime Edge", !/runtime\s*=\s*"edge"/.test(CODIGO_ROTA));
ok("A5  zero Supabase direto",
  !/getSupabaseServidor|createClient|\.from\(|\.insert\(|\.upsert\(|\.rpc\(|supabase/i.test(CODIGO_ROTA));
ok("A6  zero nome de tabela", !/"agentes"|"lojas"|"agente_/.test(CODIGO_ROTA));
ok("A7  usa exatamente as duas APIs publicadas",
  /listarAgentesDoDono\(/.test(CODIGO_ROTA) && /criarAgente\(/.test(CODIGO_ROTA));
ok("A8  nao duplica a lista canonica de tipos",
  !/"mensagens"|"ads"|"fotos"|"anuncios"|"financeiro"|"gerente"/.test(CODIGO_ROTA));
ok("A9  zero spread do corpo — montagem campo a campo",
  !/\.\.\.\s*(corpo|campos|body)/.test(CODIGO_ROTA));
ok("A10 zero spread da linha do banco",
  !/\.\.\.\s*(linha|resultado\.linha)/.test(CODIGO_ROTA));
ok("A11 o dono vem so da sessao",
  /criarAgente\(auth\.uid/.test(CODIGO_ROTA) && /listarAgentesDoDono\(auth\.uid\)/.test(CODIGO_ROTA) &&
    !/campos\.user_id|campos\.userId|campos\.uid|body\.user_id/.test(CODIGO_ROTA));
ok("A12 nao gera uuid nem timestamp",
  !/randomUUID|crypto\.|Date\.now\(|new Date\(/.test(CODIGO_ROTA));
ok("A13 `ativo` nao e input", !/ativo:\s*campos|campos\.ativo/.test(CODIGO_ROTA));
ok("A14 zero logging", !/console\.(log|error|warn|info)/.test(CODIGO_ROTA));
ok("A15 zero Location, zero 409, zero idempotencia",
  !/Location|409|[Ii]dempot/.test(CODIGO_ROTA));
ok("A16 nao vaza codigo interno de erro na resposta",
  !/erro:\s*resultado\.erro|erro:\s*`|erro_criacao_agente"\s*\}/.test(CODIGO_ROTA));
ok("A17 zero credencial", !/access_token|service_role|partner_key|x-worker-secret/.test(CODIGO_ROTA));
ok("A18 CONTROLE: as sondas acusam quando o padrao existe",
  /\.from\(/.test('x.from("t")') && /\.\.\.\s*corpo/.test("{ ...corpo }"));

// ─── B–I. Comportamento real ──────────────────────────────────────────

async function principal(): Promise<void> {
  const rota = await import("../app/api/agentes/route");
  const { emitirTokenSessao, COOKIE_SESSAO } = await import("../lib/autenticacao");

  const cookieDe = async (uid: string) =>
    `${COOKIE_SESSAO}=${(await emitirTokenSessao(uid)).token}`;
  const COOKIE_A = await cookieDe(USER_A);
  const COOKIE_B = await cookieDe(USER_B);

  const get = (cookie?: string) => rota.GET(requisicao(cookie));
  const post = (cookie: string | undefined, corpo: string) => rota.POST(requisicao(cookie, corpo));

  secao("B. O instrumento de medida esta instalado");

  ok("B1  ANCORA: o duplo interceptou o cliente Supabase", interceptou);
  const carregados = Object.keys(require.cache).map((p) => p.replace(/\\/g, "/"));
  ok("B2  ANCORA: a rota real esta no grafo",
    carregados.some((p) => p.includes("/app/api/agentes/route.ts")));
  ok("B3  ANCORA: a capability real foi carregada junto",
    carregados.some((p) => p.includes("/lib/agentes/capability.ts")));
  ok("B4  nenhum cliente Supabase real carregado",
    !carregados.some((p) => /@supabase|supabase-servidor/.test(p)));

  // ── C. GET: autenticacao ───────────────────────────────────────────

  secao("C. GET — sem sessao valida nao ha dominio");

  linhas = []; limpar();
  const rSem = await get(undefined);
  const bSem = await rSem.json();
  ok("C1  sem cookie -> 401", rSem.status === 401);
  ok("C2  payload sanitizado, sem motivo nem uid",
    bSem.ok === false && bSem.erro === "Não autenticado." && Object.keys(bSem).length === 2,
    JSON.stringify(bSem));
  ok("C3  e ZERO operacao de dominio", operacoes.length === 0);

  limpar();
  const rForjado = await get("cds_session=nao.e.token");
  ok("C4  cookie forjado -> 401 e zero dominio",
    rForjado.status === 401 && operacoes.length === 0);
  ok("C5  nao revela o motivo da recusa",
    !/token_invalido|sem_cookie|hmac/i.test(JSON.stringify(await rForjado.json())));

  // ── D. GET: listagem ───────────────────────────────────────────────

  secao("D. GET — o dono, todos os seus agentes, uma leitura");

  linhas = []; limpar();
  const rVazio = await get(COOKIE_A);
  const bVazio = await rVazio.json();
  ok("D1  zero agentes -> 200 com lista vazia",
    rVazio.status === 200 && bVazio.ok === true && Array.isArray(bVazio.agentes) &&
      bVazio.agentes.length === 0, JSON.stringify(bVazio));
  ok("D2  e custa exatamente 1 leitura", leituras() === 1 && escritas() === 0);

  linhas = [
    linhaAgente(USER_A, "A-um"),
    linhaAgente(USER_B, "B-um"),
    linhaAgente(USER_A, "A-dois-inativo", { ativo: false }),
    linhaAgente(USER_B, "B-dois"),
  ];
  limpar();
  const rN = await get(COOKIE_A);
  const bN = await rN.json();
  ok("D3  N agentes -> 200 com todos os do dono",
    rN.status === 200 && bN.agentes.length === 2,
    JSON.stringify(bN.agentes?.map((a: { nome: string }) => a.nome)));
  // M1-I1-V2: sao DUAS leituras agora — agentes e, uma unica vez, os
  // sinais de TODOS eles. Duas e o teto, e o assert e por igualdade:
  // uma terceira consulta reprova, e a segunda sumir tambem.
  ok("D4  TOTAL 2 leituras, zero escrita — uma de agentes, UMA de sinais",
    leituras() === 2 && escritas() === 0, `${leituras()}/${escritas()}`);
  ok("D5  a leitura foi escopada ao dono da sessao",
    operacoes[0]?.filtros.user_id === USER_A, JSON.stringify(operacoes[0]?.filtros));
  ok("D6  nenhum agente de B aparece",
    bN.agentes.every((a: { nome: string }) => a.nome.startsWith("A-")));
  ok("D7  o inativo TAMBEM vem — a tela precisa poder reativa-lo",
    bN.agentes.some((a: { ativo: boolean }) => a.ativo === false));
  ok("D8  ordem preservada da capability, sem reordenar na rota",
    JSON.stringify(bN.agentes.map((a: { nome: string }) => a.nome)) ===
      JSON.stringify(["A-um", "A-dois-inativo"]));
  ok("D9  shape publico: os 6 campos antigos MAIS os 2 do snapshot",
    bN.agentes.every((a: object) =>
      JSON.stringify(Object.keys(a).sort()) === JSON.stringify(CAMPOS_PUBLICOS_COM_SNAPSHOT)),
    JSON.stringify(Object.keys(bN.agentes[0] ?? {}).sort()));
  ok("D9a os 6 antigos nao mudaram de nome, tipo nem semantica",
    bN.agentes.every((a: Record<string, unknown>) =>
      CAMPOS_PUBLICOS.every((c) => c in a)) &&
    bN.agentes[0].id.length > 0 && typeof bN.agentes[0].ativo === "boolean" &&
    typeof bN.agentes[0].nome === "string" && typeof bN.agentes[0].criado_em === "string");
  ok("D9b sem tarefa, o snapshot e vazio e explicito — nunca ausente",
    bN.agentes.every((a: Record<string, unknown>) =>
      Array.isArray(a.sinais) && (a.sinais as unknown[]).length === 0 && a.atividade === null));
  ok("D10 user_id e atualizado_em NAO saem pela API",
    !/user_id|atualizado_em/.test(JSON.stringify(bN)));
  ok("D11 zero escrita em todo o GET", escritas() === 0 && rpcs === 0);
  ok("D12 a leitura de sinais tambem foi escopada ao dono da sessao",
    operacoes[1]?.tabela === "agente_tarefas" && operacoes[1]?.filtros.user_id === USER_A,
    JSON.stringify(operacoes[1]?.filtros));
  ok("D13 e recortada pelos ids dos agentes JA do dono",
    JSON.stringify((operacoes[1]?.filtros.agente_id as { __in: string[] })?.__in) ===
      JSON.stringify(bN.agentes.map((a: { id: string }) => a.id)));

  // ── D14..D16 — zero agentes nao custa consulta de tarefa ──────────
  linhas = []; limpar();
  const rSemAgente = await get(COOKIE_A);
  const bSemAgente = await rSemAgente.json();
  ok("D14 sem agentes: UMA leitura so, a de agentes",
    leituras() === 1 && operacoes.every((o) => o.tabela !== "agente_tarefas"),
    `${leituras()}`);
  ok("D15 e a resposta continua completa, com lista vazia",
    bSemAgente.ok === true && bSemAgente.agentes.length === 0);
  // ══ D17..D40 — M1-I1-V2: o SNAPSHOT OPERACIONAL ══════════════════
  //
  // A rota passou a responder duas perguntas novas por agente, e as duas
  // sao derivadas: `sinais` (o minimo para o cliente derivar os cinco
  // estados) e `atividade` (o que a estacao e a barra ja existentes
  // mostram). O que NAO pode acontecer e a tarefa vazar junto.
  secao("D'. GET — o snapshot operacional, derivado e sem Task crua");

  const { aparenciaDoAgente } = await import("../lib/ia/estados");
  const agora = Date.now();
  const emIso = (deltaMs: number) => new Date(agora + deltaMs).toISOString();

  {
    const ag = linhaAgente(USER_A, "A-com-tarefa");
    const alheio = linhaAgente(USER_B, "B-com-tarefa");
    linhas = [
      ag,
      alheio,
      linhaTarefa(USER_A, ag.id as string, {
        status: "rodando", tipo: "analise_vendas", entrada: { dias: 7 },
        progresso: 42, criado_em: "2026-09-10T00:00:00.000Z",
      }),
      linhaTarefa(USER_A, ag.id as string, {
        status: "pendente", tipo: "tratar_imagens", entrada: { quantidade: 3 },
        progresso: 0, criado_em: "2026-09-11T00:00:00.000Z",
      }),
      linhaTarefa(USER_B, alheio.id as string, {
        status: "rodando", tipo: "analise_vendas", entrada: { dias: 99 }, progresso: 88,
      }),
    ];
    limpar();
    const r = await get(COOKIE_A);
    const b = await r.json();
    const meu = b.agentes.find((a: { nome: string }) => a.nome === "A-com-tarefa");

    ok("D17 a atividade e a tarefa EM ANDAMENTO, escolhida pela precedencia",
      meu.atividade !== null && meu.atividade.titulo === "Analisando vendas dos últimos 7 dias",
      JSON.stringify(meu.atividade));
    ok("D18 o titulo e derivado no SERVIDOR — a entrada nao atravessa",
      !/"entrada"|"dias"|"quantidade"/.test(JSON.stringify(b)));
    ok("D19 o progresso e o REAL da linha, nunca zero de conveniencia",
      meu.atividade.progresso === 42);
    ok("D20 a atividade tem exatamente dois campos",
      JSON.stringify(Object.keys(meu.atividade).sort()) === JSON.stringify(["progresso", "titulo"]));
    ok("D21 nenhum id de Task, resultado ou mensagem de erro sai pela rota",
      !/"resultado"|"erro_tipo"|"erro_mensagem"|"tentativas"|"heartbeat_em"|"tarefa_id"/
        .test(JSON.stringify(b)));
    ok("D21a e nenhum id das tarefas aparece no corpo",
      (linhas.filter((l) => l.__tabela === "agente_tarefas") as { id: string }[])
        .every((t) => !JSON.stringify(b).includes(t.id)));
    ok("D22 os sinais sao os dois status abertos, deduplicados",
      JSON.stringify(meu.sinais.map((s: { status: string }) => s.status).sort()) ===
        JSON.stringify(["pendente", "rodando"]),
      JSON.stringify(meu.sinais));
    ok("D23 cada sinal tem exatamente status + concluido_em",
      meu.sinais.every((s: object) =>
        JSON.stringify(Object.keys(s).sort()) === JSON.stringify(["concluido_em", "status"])));
    ok("D24 a tarefa do OUTRO dono nao contaminou o snapshot",
      !JSON.stringify(b).includes("99") && meu.atividade.progresso !== 88);
    ok("D25 TOTAL 2 leituras mesmo com tarefas — sem N+1",
      leituras() === 2 && escritas() === 0, `${leituras()}`);

    // O progresso acompanha a linha: mudou no banco, muda na resposta.
    (linhas[2] as { progresso: number }).progresso = 77;
    limpar();
    const b2 = await (await get(COOKIE_A)).json();
    ok("D26 CONTROLE: progresso fixo reprovaria — 42 virou 77 na resposta",
      b2.agentes.find((a: { nome: string }) => a.nome === "A-com-tarefa").atividade.progresso === 77);
  }

  // ── D27..D31 — precedencia e desempate deterministico ─────────────
  {
    const ag = linhaAgente(USER_A, "A-precedencia");
    const espera = linhaTarefa(USER_A, ag.id as string, {
      status: "aguardando_aprovacao", tipo: "responder_perguntas", entrada: { quantidade: 1 },
      criado_em: "2026-09-20T00:00:00.000Z",
    });
    const fila = linhaTarefa(USER_A, ag.id as string, {
      status: "pendente", tipo: "distribuir_fila", entrada: {},
      criado_em: "2026-09-21T00:00:00.000Z",
    });
    linhas = [ag, espera, fila];
    limpar();
    const b = await (await get(COOKIE_A)).json();
    ok("D27 aguardando_aprovacao vence pendente, mesmo sendo mais antiga",
      b.agentes[0].atividade.titulo === "Respondendo 1 pergunta de compradores",
      JSON.stringify(b.agentes[0].atividade));

    const rodando = linhaTarefa(USER_A, ag.id as string, {
      status: "rodando", tipo: "gerar_anuncios", entrada: { quantidade: 2 },
      criado_em: "2026-09-19T00:00:00.000Z",
    });
    linhas = [ag, espera, fila, rodando];
    limpar();
    const b2 = await (await get(COOKIE_A)).json();
    ok("D28 e rodando vence as duas — a precedencia e a do helper, nao a da consulta",
      b2.agentes[0].atividade.titulo === "Gerando 2 anúncios");

    // Mesmo status, criado_em diferente: a mais nova vence.
    linhas = [
      ag,
      linhaTarefa(USER_A, ag.id as string, {
        status: "rodando", tipo: "analise_vendas", entrada: { dias: 3 },
        criado_em: "2026-09-01T00:00:00.000Z",
      }),
      linhaTarefa(USER_A, ag.id as string, {
        status: "rodando", tipo: "analise_vendas", entrada: { dias: 5 },
        criado_em: "2026-09-02T00:00:00.000Z",
      }),
    ];
    limpar();
    const b3 = await (await get(COOKIE_A)).json();
    ok("D29 dentro do mesmo status, a mais NOVA vence",
      b3.agentes[0].atividade.titulo === "Analisando vendas dos últimos 5 dias",
      JSON.stringify(b3.agentes[0].atividade));

    // Empate EXATO de criado_em: quem decide e o id, e sempre o mesmo.
    const MENOR = "11111111-1111-4111-8111-111111111111";
    const MAIOR = "99999999-9999-4999-8999-999999999999";
    const empate = (id: string, dias: number) =>
      linhaTarefa(USER_A, ag.id as string, {
        id, status: "rodando", tipo: "analise_vendas", entrada: { dias },
        criado_em: "2026-09-03T00:00:00.000Z",
      });
    linhas = [ag, empate(MENOR, 3), empate(MAIOR, 5)];
    limpar();
    const b4 = await (await get(COOKIE_A)).json();
    linhas = [ag, empate(MAIOR, 5), empate(MENOR, 3)];
    limpar();
    const b5 = await (await get(COOKIE_A)).json();
    ok("D30 empate exato de criado_em: id DESC decide, e decide sempre igual",
      b4.agentes[0].atividade.titulo === "Analisando vendas dos últimos 5 dias" &&
      b5.agentes[0].atividade.titulo === b4.agentes[0].atividade.titulo,
      `${b4.agentes[0].atividade.titulo} | ${b5.agentes[0].atividade.titulo}`);
    ok("D30a CONTROLE: a ordem das linhas no banco FOI de fato invertida",
      (linhas[1] as { id: string }).id === MAIOR);

    // Tipo desconhecido degrada legivel, sem despejar `entrada`.
    linhas = [
      ag,
      linhaTarefa(USER_A, ag.id as string, {
        status: "rodando", tipo: "tipo_ainda_nao_conhecido", entrada: { segredo: "x" },
      }),
    ];
    limpar();
    const b6 = await (await get(COOKIE_A)).json();
    ok("D31 tipo desconhecido vira frase legivel, e `entrada` continua dentro",
      b6.agentes[0].atividade.titulo === "Tipo ainda nao conhecido" &&
      !/segredo/.test(JSON.stringify(b6)),
      b6.agentes[0].atividade.titulo);
  }

  // ── D32..D36 — a janela de concluido, e o que NAO e carregado ─────
  {
    const ag = linhaAgente(USER_A, "A-janela");
    const recente = linhaTarefa(USER_A, ag.id as string, {
      status: "concluido", progresso: 100, concluido_em: emIso(-1_000),
      criado_em: "2026-09-15T00:00:00.000Z",
    });
    const antiga = linhaTarefa(USER_A, ag.id as string, {
      status: "concluido", progresso: 100, concluido_em: emIso(-60_000),
      criado_em: "2026-09-14T00:00:00.000Z",
    });
    linhas = [ag, recente, antiga];
    limpar();
    const b = await (await get(COOKIE_A)).json();
    ok("D32 a conclusao DENTRO da janela chega como sinal",
      b.agentes[0].sinais.length === 1 &&
      b.agentes[0].sinais[0].status === "concluido" &&
      b.agentes[0].sinais[0].concluido_em === recente.concluido_em,
      JSON.stringify(b.agentes[0].sinais));
    ok("D33 a conclusao ANTIGA nao e carregada — o conjunto e limitado",
      !JSON.stringify(b).includes(String(antiga.concluido_em)));
    ok("D34 conclusao nao e atividade: o agente nao tem tarefa em andamento",
      b.agentes[0].atividade === null);
    ok("D35 o cliente e quem decide o flash, e com este sinal ele decide `concluido`",
      aparenciaDoAgente({ ativo: true }, b.agentes[0].sinais, agora).estado === "concluido");
    ok("D35a e, passada a janela, o MESMO sinal deixa de acender",
      aparenciaDoAgente({ ativo: true }, b.agentes[0].sinais, agora + 9_000).estado === "ocioso");

    // Cancelada nao e sinal de nada, e nao pode ser carregada.
    linhas = [ag, linhaTarefa(USER_A, ag.id as string, {
      status: "cancelado", concluido_em: emIso(-500),
    })];
    limpar();
    const b2 = await (await get(COOKIE_A)).json();
    ok("D36 tarefa cancelada nao vira sinal nem atividade",
      b2.agentes[0].sinais.length === 0 && b2.agentes[0].atividade === null);
  }

  // ── D37..D40 — dedup: historico grande, snapshot pequeno ──────────
  {
    const ag = linhaAgente(USER_A, "A-historico");
    const muitas: Record<string, unknown>[] = [];
    for (let i = 0; i < 200; i += 1) {
      const status = ["pendente", "rodando", "aguardando_aprovacao", "erro"][i % 4];
      muitas.push(linhaTarefa(USER_A, ag.id as string, {
        status,
        tipo: "tratar_imagens",
        entrada: { quantidade: i },
        concluido_em: status === "erro" ? emIso(-500_000) : null,
        criado_em: `2026-07-${String((i % 27) + 1).padStart(2, "0")}T00:00:00.000Z`,
      }));
    }
    linhas = [ag, ...muitas];
    limpar();
    const b = await (await get(COOKIE_A)).json();
    const sinais = b.agentes[0].sinais as { status: string; concluido_em: string | null }[];

    ok("D37 200 linhas relevantes produzem no maximo 5 sinais", sinais.length <= 5,
      String(sinais.length));
    ok("D37a e sao os quatro status abertos, um de cada",
      JSON.stringify(sinais.map((s) => s.status).sort()) ===
        JSON.stringify(["aguardando_aprovacao", "erro", "pendente", "rodando"]));
    ok("D38 ANCORA: o historico usado e realmente grande", muitas.length === 200);

    // Equivalencia: deduplicar nao pode mudar o estado que o cliente
    // deriva. O oraculo e o conjunto NAO deduplicado, nao o esperado
    // escrito a mao.
    const cru = muitas.map((t) => ({
      status: t.status as never,
      concluido_em: t.concluido_em as string | null,
    }));
    ok("D39 o estado derivado dos 5 sinais e o mesmo derivado das 200 linhas",
      aparenciaDoAgente({ ativo: true }, sinais as never, agora).estado ===
        aparenciaDoAgente({ ativo: true }, cru, agora).estado);
    ok("D39a e, com o agente desligado, tambem",
      aparenciaDoAgente({ ativo: false }, sinais as never, agora).foraDeOperacao ===
        aparenciaDoAgente({ ativo: false }, cru, agora).foraDeOperacao);
    ok("D40 e continua custando 2 leituras, nao 200", leituras() === 2, `${leituras()}`);

    // ── O INSTRUMENTO nao pode ser um filtro que nao filtra ─────────
    //
    // Toda a prova de "conjunto limitado" depende de o duplo INTERPRETAR
    // a expressao `or=(...)`. Um `or()` que so guardasse a string
    // deixaria D33 verde sem que nada fosse filtrado. Os controles
    // abaixo pegam a expressao que a PRODUCAO acabou de montar e
    // mostram que ela discrimina.
    const expressaoReal = operacoes[1]?.ors[0] ?? "";
    ok("D40a ANCORA: a rota realmente mandou uma expressao de corte",
      /status\.in\.\(pendente,rodando,aguardando_aprovacao,erro\)/.test(expressaoReal) &&
      /and\(status\.eq\.concluido,concluido_em\.gte\./.test(expressaoReal),
      expressaoReal);
    const aplicar = (linha: Record<string, unknown>) =>
      avaliarTermo(`or(${expressaoReal})`, linha);
    ok("D40b o corte ACEITA aberta e conclusao recente",
      aplicar({ status: "rodando", concluido_em: null }) &&
      aplicar({ status: "erro", concluido_em: emIso(-900_000) }) &&
      aplicar({ status: "concluido", concluido_em: emIso(-1_000) }));
    ok("D40c e RECUSA conclusao antiga e status que nao interessa",
      !aplicar({ status: "concluido", concluido_em: emIso(-60_000) }) &&
      !aplicar({ status: "concluido", concluido_em: null }) &&
      !aplicar({ status: "cancelado", concluido_em: emIso(-1_000) }));
    ok("D40d CONTROLE do leak: a sonda de `entrada` acusaria o campo de volta",
      /"entrada"|"dias"|"quantidade"/.test('{"id":"x","entrada":{"dias":7}}') &&
      /"entrada"|"dias"|"quantidade"/.test('{"titulo":"x","quantidade":3}'));
  }

  linhas = [];

  // ── E. POST: autenticacao e corpo ──────────────────────────────────

  secao("E. POST — sessao, corpo e validacao antes de qualquer escrita");

  linhas = []; limpar();
  const pSem = await post(undefined, JSON.stringify({ nome: "x", tipo: "mensagens" }));
  ok("E1  sem cookie -> 401 e ZERO escrita",
    pSem.status === 401 && escritas() === 0 && operacoes.length === 0);

  limpar();
  const pJson = await post(COOKIE_A, "{ isso nao e json");
  const bJson = await pJson.json();
  ok("E2  JSON invalido -> 400 e ZERO escrita",
    pJson.status === 400 && bJson.erro === "Corpo da requisição inválido (JSON esperado)." &&
      escritas() === 0, `${pJson.status} · ${JSON.stringify(bJson)}`);

  for (const [nome, corpo] of [
    ["E3  corpo `null`", "null"],
    ["E4  corpo numero", "42"],
    ["E5  corpo array", "[]"],
  ] as [string, string][]) {
    limpar();
    const r = await post(COOKIE_A, corpo);
    ok(`${nome} -> 400 e ZERO escrita`,
      r.status === 400 && escritas() === 0, `${r.status}/${escritas()}`);
  }

  for (const [nome, corpo, erro] of [
    ["E6  nome ausente", { tipo: "mensagens" }, "nome inválido."],
    ["E7  nome vazio", { nome: "   ", tipo: "mensagens" }, "nome inválido."],
    ["E8  nome nao-string", { nome: 7, tipo: "mensagens" }, "nome inválido."],
    ["E9  tipo ausente", { nome: "Ok" }, "tipo inválido."],
    ["E10 tipo fora do vocabulario", { nome: "Ok", tipo: "vendedor" }, "tipo inválido."],
    ["E11 tipo nao-string", { nome: "Ok", tipo: 3 }, "tipo inválido."],
  ] as [string, object, string][]) {
    limpar();
    const r = await post(COOKIE_A, JSON.stringify(corpo));
    const b = await r.json();
    ok(`${nome} -> 400 "${erro}" e ZERO escrita`,
      r.status === 400 && b.ok === false && b.erro === erro && escritas() === 0,
      `${r.status} · ${b.erro} · ${escritas()}`);
  }

  // ── F. POST: criacao ───────────────────────────────────────────────

  secao("F. POST — o uuid real nasce no banco, e o dono e a sessao");

  linhas = []; limpar();
  const pOk = await post(COOKIE_A, JSON.stringify({
    nome: "  Atendimento  ", tipo: "mensagens", instrucoes: "Responder rapido.",
  }));
  const bOk = await pOk.json();
  ok("F1  POST valido -> 201", pOk.status === 201, String(pOk.status));
  ok("F2  TOTAL 1 escrita, zero leitura extra", escritas() === 1 && leituras() === 0,
    `${escritas()}/${leituras()}`);
  ok("F3  shape publico: exatamente os mesmos 6 campos do GET",
    JSON.stringify(Object.keys(bOk.agente ?? {}).sort()) === JSON.stringify(CAMPOS_PUBLICOS),
    JSON.stringify(Object.keys(bOk.agente ?? {}).sort()));
  ok("F4  user_id e atualizado_em NAO saem pela API",
    !/user_id|atualizado_em/.test(JSON.stringify(bOk)));
  ok("F5  o id devolvido e um uuid canonico", RE_UUID.test(bOk.agente?.id ?? ""), bOk.agente?.id);
  ok("F6  `nome` chegou aparado pela capability",
    operacoes[0]?.payload?.nome === "Atendimento", String(operacoes[0]?.payload?.nome));
  ok("F7  o INSERT levou o dono da SESSAO", operacoes[0]?.payload?.user_id === USER_A);
  ok("F8  o INSERT tem exatamente 4 colunas — nada de id/ativo/timestamps",
    JSON.stringify(Object.keys(operacoes[0]?.payload ?? {}).sort()) ===
      JSON.stringify(["instrucoes", "nome", "tipo", "user_id"]),
    JSON.stringify(Object.keys(operacoes[0]?.payload ?? {}).sort()));
  ok("F9  o agente nasce ativo, por autoridade do servidor", bOk.agente?.ativo === true);
  ok("F10 instrucoes ausente vira null, sem regra nova na rota", await (async () => {
    limpar();
    const r = await post(COOKIE_A, JSON.stringify({ nome: "Sem instrucoes", tipo: "ads" }));
    return (await r.json()).agente?.instrucoes === null;
  })());
  ok("F11 instrucoes nao-string tambem vira null, sem crash",
    await (async () => {
      limpar();
      const r = await post(COOKIE_A, JSON.stringify({ nome: "Instr numero", tipo: "ads", instrucoes: 42 }));
      return r.status === 201 && (await r.json()).agente?.instrucoes === null;
    })());

  // ── G. Mass assignment ─────────────────────────────────────────────

  secao("G. O corpo nao decide dono, id, estado nem tempo");

  linhas = []; limpar();
  const ID_ATACANTE = "00000000-dead-4bee-8000-000000000000";
  const pMass = await post(COOKIE_A, JSON.stringify({
    nome: "Invasor", tipo: "gerente",
    id: ID_ATACANTE,
    user_id: USER_B, userId: USER_B, uid: USER_B,
    ativo: false,
    criado_em: "1999-01-01T00:00:00.000Z",
    atualizado_em: "1999-01-01T00:00:00.000Z",
  }));
  const bMass = await pMass.json();
  ok("G1  o request e aceito — reservados sao IGNORADOS, nao rejeitados",
    pMass.status === 201, String(pMass.status));
  ok("G2  o INSERT continua com as MESMAS 4 colunas",
    JSON.stringify(Object.keys(operacoes[0]?.payload ?? {}).sort()) ===
      JSON.stringify(["instrucoes", "nome", "tipo", "user_id"]),
    JSON.stringify(Object.keys(operacoes[0]?.payload ?? {}).sort()));
  ok("G3  o dono e A, nunca o B que o corpo pediu",
    operacoes[0]?.payload?.user_id === USER_A);
  ok("G4  o id NAO e o do atacante", bMass.agente?.id !== ID_ATACANTE && RE_UUID.test(bMass.agente?.id));
  ok("G5  `ativo:false` do corpo nao venceu o default do servidor",
    bMass.agente?.ativo === true);
  ok("G6  os timestamps forjados nao entraram",
    bMass.agente?.criado_em !== "1999-01-01T00:00:00.000Z");

  // ── H. A cadeia criar -> listar ────────────────────────────────────

  secao("H. Criar e listar: a cadeia que a UI vai precisar");

  linhas = []; limpar();
  const pCadeia = await post(COOKIE_A, JSON.stringify({ nome: "Cadeia", tipo: "financeiro" }));
  const idCriado = (await pCadeia.json()).agente?.id;

  limpar();
  const gA = await (await get(COOKIE_A)).json();
  ok("H1  o agente criado por A aparece no GET de A",
    gA.agentes.length === 1 && gA.agentes[0].id === idCriado, JSON.stringify(gA.agentes));
  ok("H2  e o id e o MESMO uuid devolvido pelo POST", RE_UUID.test(idCriado));

  limpar();
  const gB = await (await get(COOKIE_B)).json();
  ok("H3  B NAO enxerga o agente de A", gB.ok === true && gB.agentes.length === 0,
    JSON.stringify(gB.agentes));
  ok("H4  a leitura de B levou o user_id de B", operacoes[0]?.filtros.user_id === USER_B);

  // O contrato de identidade que o diagnostico ja publicou: o id serve
  // como `agenteId` sem transformacao nenhuma. A regra e relida do
  // codigo da rota publicada, nao reescrita aqui.
  const RE_DIAGNOSTICO = semComentarios(ler("app/api/agentes/[agenteId]/diagnostico/route.ts"))
    .match(/const UUID_REGEX = (\/[^\n]+\/i);/)?.[1];
  ok("H5  ANCORA: a regra de uuid do diagnostico foi lida do codigo publicado",
    typeof RE_DIAGNOSTICO === "string" && RE_DIAGNOSTICO.length > 20, RE_DIAGNOSTICO ?? "nao achou");
  ok("H6  o id criado passa na MESMA validacao que o diagnostico exige",
    new RegExp(RE_DIAGNOSTICO!.slice(1, -2), "i").test(idCriado), idCriado);

  // ── I. Falha e fronteira ───────────────────────────────────────────

  secao("I. Falha sanitizada, e nada de UI nesta frente");

  const VENENO = {
    message: "connection refused para postgres://user:senha@host/db",
    hint: "verifique a rede", details: "linha 42", code: "08006",
  };

  linhas = []; limpar();
  erroInjetado = VENENO;
  const gErro = await get(COOKIE_A);
  const bgErro = await gErro.json();
  ok("I1  falha de leitura -> 500 com frase fixa",
    gErro.status === 500 && bgErro.erro === "Falha ao listar os agentes." &&
      Object.keys(bgErro).length === 2, JSON.stringify(bgErro));
  ok("I2  zero vazamento do erro do driver no GET",
    !/connection refused|postgres:\/\/|senha|hint|details|08006|linha 42/i.test(JSON.stringify(bgErro)));

  limpar();
  erroInjetado = VENENO;
  const pErro = await post(COOKIE_A, JSON.stringify({ nome: "Falha", tipo: "fotos" }));
  const bpErro = await pErro.json();
  ok("I3  falha de escrita -> 500 com frase fixa",
    pErro.status === 500 && bpErro.erro === "Falha ao criar o agente." &&
      Object.keys(bpErro).length === 2, JSON.stringify(bpErro));
  ok("I4  zero vazamento do erro do driver no POST",
    !/connection refused|postgres:\/\/|senha|hint|details|08006/i.test(JSON.stringify(bpErro)));
  ok("I5  falha NAO vira 200 vazio", gErro.status !== 200 && pErro.status !== 200);

  ok("I6  toda resposta responde no-store",
    [rSem, rVazio, rN, pJson, pOk, pMass, gErro, pErro]
      .every((r) => r.headers.get("cache-control") === "no-store"));
  ok("I7  zero RPC em todo o pipeline", rpcs === 0);

  // Fronteira com a UI. Nasceu na agent-source-C provando que AQUELA
  // frente nao havia criado consumidor nenhum — a area de IA era, na
  // epoca, desenhada sem rede. A SKILL-1D.ui-consumer-C deu a ela UM
  // transporte nominal, e a premissa literal "zero rede" deixou de ser
  // verdadeira. A guarda nao sai: passa a proteger a EXCLUSIVIDADE
  // desse boundary, por igualdade de conjunto e caminho nominal.
  const areaIa = ["lib/ia", "components/ia", "app/(app)/ia"];
  const TRANSPORTE_AUTORIZADO = ["lib/ia/agentes-http.ts"];
  const comFetch: string[] = [];
  const varrer = (dir: string): void => {
    for (const e of readdirSync(join(RAIZ, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) varrer(rel);
      else if (/\.tsx?$/.test(e.name) && /\bfetch\s*\(|\/api\/agentes/.test(semComentarios(ler(rel)))) {
        comFetch.push(rel);
      }
    }
  };
  for (const d of areaIa) varrer(d);
  // Igualdade nos DOIS sentidos: um segundo arquivo com rede reprova, e
  // o transporte sumir ou mudar de lugar tambem — guarda que so olha um
  // lado passa verde no dia em que o boundary deixa de existir.
  ok("I8  so o transporte nominal da UI tem rede e cita a rota de agentes",
    JSON.stringify(comFetch.slice().sort()) === JSON.stringify(TRANSPORTE_AUTORIZADO),
    comFetch.join(", ") || "nenhum");
  ok("I9  nenhuma UI foi criada para esta rota",
    !existsSync(join(RAIZ, "app/(app)/ia/agentes/NovoAgente.tsx")) &&
      readdirSync(join(RAIZ, "app/api/agentes")).sort().join(", ") === "[agenteId], route.ts");

  // ─── J..P. A surface de conversa — AGENT-VERTICAL-SLICE-V1-I2 ───────
  //
  // Os handlers REAIS de `app/api/agentes/[agenteId]/conversa` rodam,
  // com as capabilities reais (`lerAgenteDoDono`, `criarTarefa`,
  // `lerTarefaDoDono`) contra o mesmo duplo com estado. Nenhum provedor
  // e alcancado: a rota nunca executa tarefa.
  {
    const conversa = await import("../app/api/agentes/[agenteId]/conversa/route");

    const AGENTE_A = randomUUID();
    const AGENTE_OUTRO = randomUUID();

    const req = (
      agenteId: string,
      cookie: string | undefined,
      opcoes: { corpo?: string; query?: string } = {}
    ) =>
      new Request(
        `http://localhost/api/agentes/${agenteId}/conversa${opcoes.query ?? ""}`,
        {
          method: opcoes.corpo === undefined ? "GET" : "POST",
          headers: cookie ? { cookie } : {},
          ...(opcoes.corpo === undefined ? {} : { body: opcoes.corpo }),
        }
      );

    const post = (agenteId: string, cookie: string | undefined, corpo: string) =>
      conversa.POST(req(agenteId, cookie, { corpo }), { params: { agenteId } });
    const get = (agenteId: string, cookie: string | undefined, query: string) =>
      conversa.GET(req(agenteId, cookie, { query }), { params: { agenteId } });

    const linhaAgenteConversa = (id: string, userId: string, ativo = true) => ({
      id,
      user_id: userId,
      nome: "Agente de conversa",
      tipo: "mensagens",
      instrucoes: "RESPONDA_COM_A",
      ativo,
      criado_em: new Date().toISOString(),
      atualizado_em: new Date().toISOString(),
    });

    const linhaTarefa = (extra: Record<string, unknown>) => ({
      id: randomUUID(),
      agente_id: AGENTE_A,
      user_id: USER_A,
      tipo: "conversa",
      entrada: { mensagem: "Ola" },
      status: "pendente",
      progresso: 0,
      resultado: null,
      erro_tipo: null,
      erro_mensagem: null,
      tentativas: 0,
      max_tentativas: 3,
      criado_em: new Date().toISOString(),
      iniciado_em: null,
      concluido_em: null,
      heartbeat_em: null,
      ...extra,
    });

    const escritasDeTarefa = () =>
      operacoes.filter((o) => o.tabela === "agente_tarefas" && o.tipo === "escrita");

    secao("J. POST conversa — sessao");

    linhas = [linhaAgenteConversa(AGENTE_A, USER_A)];
    limpar();
    const semSessao = await post(AGENTE_A, undefined, JSON.stringify({ mensagem: "Ola" }));
    ok("J1  sem cookie -> 401", semSessao.status === 401, String(semSessao.status));
    ok("J2  401 nao consulta nem escreve nada", operacoes.length === 0, String(operacoes.length));

    limpar();
    const tokenRuim = await post(AGENTE_A, `${COOKIE_SESSAO}=lixo.invalido`, JSON.stringify({ mensagem: "Ola" }));
    ok("J3  token invalido -> 401", tokenRuim.status === 401, String(tokenRuim.status));
    ok("J4  e tambem sem tocar o banco", operacoes.length === 0);

    limpar();
    const idRuim = await post("nao-e-uuid", COOKIE_A, JSON.stringify({ mensagem: "Ola" }));
    ok("J5  agenteId nao-uuid -> 400", idRuim.status === 400, String(idRuim.status));
    ok("J6  400 de id nao toca o banco", operacoes.length === 0);

    secao("K. POST conversa — dono do agente");

    limpar();
    const outroDono = await post(AGENTE_A, COOKIE_B, JSON.stringify({ mensagem: "Ola" }));
    ok("K1  agente de A, sessao B -> 404", outroDono.status === 404, String(outroDono.status));
    ok("K2  cross-tenant NAO cria tarefa", escritasDeTarefa().length === 0);
    ok("K3  404 nao revela existencia",
      JSON.stringify(await outroDono.clone().json()).includes("Agente não encontrado"));

    limpar();
    const inexistente = await post(AGENTE_OUTRO, COOKIE_A, JSON.stringify({ mensagem: "Ola" }));
    ok("K4  agente inexistente -> 404 (mesma resposta)", inexistente.status === 404);
    ok("K5  e nao cria tarefa", escritasDeTarefa().length === 0);

    linhas = [linhaAgenteConversa(AGENTE_A, USER_A, false)];
    limpar();
    const inativo = await post(AGENTE_A, COOKIE_A, JSON.stringify({ mensagem: "Ola" }));
    ok("K6  agente inativo -> 409", inativo.status === 409, String(inativo.status));
    ok("K7  inativo NAO cria tarefa", escritasDeTarefa().length === 0);
    ok("K8  o codigo do erro e agente_inativo",
      ((await inativo.clone().json()) as { erro?: string }).erro === "agente_inativo");

    secao("L. POST conversa — corpo fechado");

    linhas = [linhaAgenteConversa(AGENTE_A, USER_A)];
    for (const [rotulo, corpo] of [
      ["corpo ausente", ""],
      ["objeto vazio", "{}"],
      ["mensagem vazia", '{"mensagem":""}'],
      ["mensagem so espaco", '{"mensagem":"   "}'],
      ["mensagem nao-string", '{"mensagem":42}'],
      ["array", "[]"],
      ["string JSON", '"Ola"'],
      ["JSON invalido", "{mensagem:}"],
      ["campo extra", '{"mensagem":"Ola","extra":1}'],
      ["userId", '{"mensagem":"Ola","userId":"x"}'],
      ["user_id", '{"mensagem":"Ola","user_id":"x"}'],
      ["agenteId", '{"mensagem":"Ola","agenteId":"x"}'],
      ["tipo", '{"mensagem":"Ola","tipo":"analise_vendas"}'],
      ["instrucoes", '{"mensagem":"Ola","instrucoes":"MALICIOSA"}'],
      ["provider", '{"mensagem":"Ola","provider":"anthropic"}'],
      ["model", '{"mensagem":"Ola","model":"x"}'],
      ["tools", '{"mensagem":"Ola","tools":[]}'],
      ["maxTentativas", '{"mensagem":"Ola","maxTentativas":99}'],
      ["status", '{"mensagem":"Ola","status":"concluido"}'],
      ["resultado", '{"mensagem":"Ola","resultado":{"resposta":"x"}}'],
    ] as const) {
      limpar();
      const r = await post(AGENTE_A, COOKIE_A, corpo);
      ok(`L  ${rotulo} -> 400 e zero tarefa criada`,
        r.status === 400 && escritasDeTarefa().length === 0,
        `${r.status}`);
    }

    secao("M. POST conversa — criacao");

    linhas = [linhaAgenteConversa(AGENTE_A, USER_A)];
    limpar();
    const rpcsAntes = rpcs;
    const criada = await post(AGENTE_A, COOKIE_A, JSON.stringify({ mensagem: "  Ola  " }));
    const corpoCriada = (await criada.clone().json()) as Record<string, unknown>;
    const escrita = escritasDeTarefa()[0];
    const payload = (escrita?.payload ?? {}) as Record<string, unknown>;

    ok("M1  POST valido -> 202", criada.status === 202, String(criada.status));
    ok("M2  ANCORA: houve exatamente UMA escrita em agente_tarefas", escritasDeTarefa().length === 1);
    ok("M3  o insert foi na tabela agente_tarefas", escrita?.tabela === "agente_tarefas");
    ok("M4  o payload tem EXATAMENTE 4 chaves",
      Object.keys(payload).sort().join(",") === "agente_id,entrada,tipo,user_id",
      Object.keys(payload).sort().join(","));
    ok("M5  user_id = auth.uid", payload.user_id === USER_A);
    ok("M6  agente_id = id da rota", payload.agente_id === AGENTE_A);
    ok("M7  tipo e FIXADO em conversa (o caller nao escolhe)", payload.tipo === "conversa");
    ok("M8  entrada guarda somente a mensagem, aparada",
      JSON.stringify(payload.entrada) === JSON.stringify({ mensagem: "Ola" }));
    ok("M9  max_tentativas NAO viaja (DEFAULT do banco manda)", !("max_tentativas" in payload));
    ok("M10 tarefaId devolvido e o uuid REAL da linha gravada",
      typeof corpoCriada.tarefaId === "string" && RE_UUID.test(corpoCriada.tarefaId as string) &&
        linhas.some((l) => l.id === corpoCriada.tarefaId));
    ok("M11 status inicial REAL do banco (pendente)", corpoCriada.status === "pendente", String(corpoCriada.status));
    ok("M12 a resposta nao vaza userId/instrucoes/linha crua",
      !("userId" in corpoCriada) && !("user_id" in corpoCriada) &&
        !("instrucoes" in corpoCriada) && !("entrada" in corpoCriada));
    ok("M13 POST NAO executa: zero RPC", rpcs === rpcsAntes);
    ok("M14 a resposta tem so as 4 chaves do contrato",
      Object.keys(corpoCriada).sort().join(",") === "modoIaConfiguradoAgora,ok,status,tarefaId",
      Object.keys(corpoCriada).sort().join(","));

    secao("N. GET conversa — leitura tenant-scoped");

    const T_PENDENTE = linhaTarefa({});
    // Tarefa de B, no agente de B. A FK composta
    // `agente_tarefas(agente_id, user_id) -> agentes(id, user_id)` torna
    // impossivel uma tarefa de B apontar para o agente de A, entao o
    // fixture cross-tenant precisa ter os DOIS campos de B — senao a
    // suite provaria o 404 contra um estado que o banco nunca produz.
    const T_OUTRO_DONO = linhaTarefa({ user_id: USER_B, agente_id: AGENTE_OUTRO });
    const T_OUTRO_AGENTE = linhaTarefa({ agente_id: AGENTE_OUTRO });
    const T_OUTRO_TIPO = linhaTarefa({ tipo: "analise_vendas" });
    const T_OK = linhaTarefa({ status: "concluido", progresso: 100, resultado: { resposta: "PONG: Ola" } });
    const T_RESULTADO_RUIM = linhaTarefa({ status: "concluido", progresso: 100, resultado: { resumo: "forma da analise" } });
    const T_FALHOU = linhaTarefa({
      status: "erro",
      erro_tipo: "handler_falhou",
      erro_mensagem: "agente da tarefa nao encontrado",
    });
    // AGENT-VERTICAL-SLICE-V1-I2-F1 — fixtures adversariais de LEITURA.
    //
    // Nenhuma delas e produzivel pelo escritor TypeScript de hoje
    // (`classificarErro` fecha o vocabulario, e o handler grava so
    // `{resposta}`). Mas todas SAO produziveis pelo schema: `erro_tipo`
    // e `text` sem CHECK de pertencimento e `resultado` e `jsonb` livre.
    // A fronteira de leitura tem de se defender do que o banco aceita,
    // nao do que o nosso codigo costuma escrever.
    const T_ERRO_DESCONHECIDO = linhaTarefa({
      status: "erro",
      erro_tipo: "valor_futuro_ou_corrompido",
      erro_mensagem: "detalhe interno que nao deve sair",
    });
    const T_RESULTADO_EXTRA = linhaTarefa({
      status: "concluido",
      progresso: 100,
      resultado: { resposta: "ok", segredo: "NAO_DEVE_PASSAR" },
    });
    const T_RESULTADO_VAZIO = linhaTarefa({ status: "concluido", progresso: 100, resultado: {} });
    const T_RESULTADO_ARRAY = linhaTarefa({ status: "concluido", progresso: 100, resultado: [] });

    linhas = [
      linhaAgenteConversa(AGENTE_A, USER_A),
      T_PENDENTE, T_OUTRO_DONO, T_OUTRO_AGENTE, T_OUTRO_TIPO, T_OK, T_RESULTADO_RUIM, T_FALHOU,
      T_ERRO_DESCONHECIDO, T_RESULTADO_EXTRA, T_RESULTADO_VAZIO, T_RESULTADO_ARRAY,
    ];

    limpar();
    const getSemSessao = await get(AGENTE_A, undefined, `?tarefaId=${T_PENDENTE.id}`);
    ok("N1  GET sem cookie -> 401", getSemSessao.status === 401);
    ok("N2  401 nao le a tarefa", operacoes.length === 0);

    limpar();
    ok("N3  tarefaId ausente -> 400", (await get(AGENTE_A, COOKIE_A, "")).status === 400);
    ok("N4  tarefaId nao-uuid -> 400", (await get(AGENTE_A, COOKIE_A, "?tarefaId=abc")).status === 400);
    ok("N5  400 de tarefaId nao le nada", operacoes.length === 0);

    limpar();
    const rpcsGet = rpcs;
    const pendente = await get(AGENTE_A, COOKIE_A, `?tarefaId=${T_PENDENTE.id}`);
    const corpoPendente = (await pendente.clone().json()) as { tarefa?: Record<string, unknown> };
    ok("N6  tarefa pendente -> 200", pendente.status === 200, String(pendente.status));
    ok("N7  status real devolvido", corpoPendente.tarefa?.status === "pendente");
    ok("N8  resposta e null enquanto nao concluiu", corpoPendente.tarefa?.resposta === null);
    ok("N9  GET NAO executa: zero RPC e zero escrita",
      rpcs === rpcsGet && operacoes.every((o) => o.tipo === "leitura"));

    limpar();
    // A sessao e de A; a tarefa e de B. `lerTarefaDoDono` filtra por
    // `user_id`, entao ela nem chega a ser lida — e o 404 e o mesmo de
    // "nao existe", sem vazar status nem existencia.
    const alheia = await get(AGENTE_A, COOKIE_A, `?tarefaId=${T_OUTRO_DONO.id}`);
    ok("N10 tarefa de OUTRO dono -> 404", alheia.status === 404, String(alheia.status));
    ok("N10a e a resposta e indistinguivel de inexistente",
      JSON.stringify(await alheia.clone().json()).includes("Conversa não encontrada"));
    limpar();
    ok("N11 tarefa do mesmo dono, OUTRO agente -> 404",
      (await get(AGENTE_A, COOKIE_A, `?tarefaId=${T_OUTRO_AGENTE.id}`)).status === 404);
    limpar();
    ok("N12 tarefa do mesmo agente, OUTRO tipo -> 404",
      (await get(AGENTE_A, COOKIE_A, `?tarefaId=${T_OUTRO_TIPO.id}`)).status === 404);
    limpar();
    const naoExiste = await get(AGENTE_A, COOKIE_A, `?tarefaId=${randomUUID()}`);
    ok("N13 tarefa inexistente -> 404 (mesma resposta das outras tres)",
      naoExiste.status === 404 &&
        JSON.stringify(await naoExiste.clone().json()).includes("Conversa não encontrada"));

    limpar();
    const concluida = await get(AGENTE_A, COOKIE_A, `?tarefaId=${T_OK.id}`);
    const corpoOk = (await concluida.clone().json()) as { tarefa?: Record<string, unknown> };
    ok("N14 tarefa concluida -> 200", concluida.status === 200);
    ok("N15 a resposta EXATA do resultado atravessa", corpoOk.tarefa?.resposta === "PONG: Ola");
    ok("N16 a tarefa exposta tem so 4 campos",
      Object.keys(corpoOk.tarefa ?? {}).sort().join(",") === "erroTipo,id,resposta,status",
      Object.keys(corpoOk.tarefa ?? {}).sort().join(","));
    ok("N17 GET nao expoe user_id, entrada nem resultado cru",
      !JSON.stringify(corpoOk).includes(USER_A) && !JSON.stringify(corpoOk).includes("entrada"));

    limpar();
    const ruim = await get(AGENTE_A, COOKIE_A, `?tarefaId=${T_RESULTADO_RUIM.id}`);
    ok("N18 concluida com resultado fora do contrato -> 500", ruim.status === 500, String(ruim.status));
    ok("N19 e NAO devolve o objeto cru nem '[object Object]'",
      !JSON.stringify(await ruim.clone().json()).includes("forma da analise") &&
        !JSON.stringify(await ruim.clone().json()).includes("[object Object]"));

    limpar();
    const falhou = await get(AGENTE_A, COOKIE_A, `?tarefaId=${T_FALHOU.id}`);
    const corpoFalhou = (await falhou.clone().json()) as { tarefa?: Record<string, unknown> };
    ok("N20 tarefa falhada -> 200 (a consulta funcionou)", falhou.status === 200);
    ok("N21 status e erroTipo (vocabulario fechado) sao expostos",
      corpoFalhou.tarefa?.status === "erro" && corpoFalhou.tarefa?.erroTipo === "handler_falhou");
    ok("N22 erro_mensagem NAO e exposto",
      !JSON.stringify(corpoFalhou).includes("agente da tarefa nao encontrado"));

    // ── N23..N29 — F1: o output e FECHADO nos dois contratos ────────

    limpar();
    const desconhecido = await get(AGENTE_A, COOKIE_A, `?tarefaId=${T_ERRO_DESCONHECIDO.id}`);
    const corpoDesconhecido = (await desconhecido.clone().json()) as { tarefa?: Record<string, unknown> };
    const textoDesconhecido = JSON.stringify(corpoDesconhecido);
    ok("N23 erro_tipo fora do vocabulario -> 200 (a consulta funcionou)", desconhecido.status === 200);
    ok("N24 o status real continua sendo repassado", corpoDesconhecido.tarefa?.status === "erro");
    ok("N25 erroTipo desconhecido vira null", corpoDesconhecido.tarefa?.erroTipo === null,
      String(corpoDesconhecido.tarefa?.erroTipo));
    ok("N26 a string desconhecida NAO aparece em campo nenhum",
      !textoDesconhecido.includes("valor_futuro_ou_corrompido"));
    ok("N27 e o desconhecido NAO e mapeado para um tipo conhecido",
      !textoDesconhecido.includes("erro_interno") && !textoDesconhecido.includes("handler_falhou"));
    ok("N28 erro_mensagem segue oculto tambem aqui",
      !textoDesconhecido.includes("detalhe interno que nao deve sair"));
    ok("N29 CONTROLE NEGATIVO: o tipo CONHECIDO continua atravessando",
      corpoFalhou.tarefa?.erroTipo === "handler_falhou");

    // ── N30..N35 — resultado concluido com chaves EXATAS ────────────

    limpar();
    const extra = await get(AGENTE_A, COOKIE_A, `?tarefaId=${T_RESULTADO_EXTRA.id}`);
    const textoExtra = JSON.stringify(await extra.clone().json());
    ok("N30 resultado com chave a mais -> 500", extra.status === 500, String(extra.status));
    ok("N31 o valor extra NAO vaza", !textoExtra.includes("NAO_DEVE_PASSAR"));
    ok("N32 e a resposta valida junto dele tambem nao sai parcialmente",
      !textoExtra.includes('"resposta"') || !textoExtra.includes('"ok"'));

    limpar();
    ok("N33 resultado {} -> 500",
      (await get(AGENTE_A, COOKIE_A, `?tarefaId=${T_RESULTADO_VAZIO.id}`)).status === 500);
    limpar();
    ok("N34 resultado array -> 500",
      (await get(AGENTE_A, COOKIE_A, `?tarefaId=${T_RESULTADO_ARRAY.id}`)).status === 500);
    limpar();
    ok("N35 CONTROLE NEGATIVO: o resultado no contrato exato continua 200 com a resposta",
      (await (await get(AGENTE_A, COOKIE_A, `?tarefaId=${T_OK.id}`)).json() as { tarefa?: Record<string, unknown> })
        .tarefa?.resposta === "PONG: Ola");

    secao("O. Modo de IA configurado — sem mentir sobre proveniencia");

    const FLAG_REAL = "AGENTES_IA_PROVIDER_REAL_ENABLED";
    const flagAntes = process.env[FLAG_REAL];
    const tinhaFlag = Object.prototype.hasOwnProperty.call(process.env, FLAG_REAL);
    try {
      linhas = [linhaAgenteConversa(AGENTE_A, USER_A), T_OK];

      delete process.env[FLAG_REAL];
      limpar();
      const fakePost = (await (await post(AGENTE_A, COOKIE_A, JSON.stringify({ mensagem: "Ola" }))).json()) as Record<string, unknown>;
      ok("O1  flag ausente -> modoIaConfiguradoAgora = fake", fakePost.modoIaConfiguradoAgora === "fake");

      process.env[FLAG_REAL] = "true";
      limpar();
      const realPost = (await (await post(AGENTE_A, COOKIE_A, JSON.stringify({ mensagem: "Ola" }))).json()) as Record<string, unknown>;
      ok("O2  flag 'true' -> modoIaConfiguradoAgora = real", realPost.modoIaConfiguradoAgora === "real");

      limpar();
      const realGet = (await (await get(AGENTE_A, COOKIE_A, `?tarefaId=${T_OK.id}`)).json()) as Record<string, unknown>;
      ok("O3  o GET tambem reporta o modo atual", realGet.modoIaConfiguradoAgora === "real");

      process.env[FLAG_REAL] = "1";
      limpar();
      const quase = (await (await post(AGENTE_A, COOKIE_A, JSON.stringify({ mensagem: "Ola" }))).json()) as Record<string, unknown>;
      ok("O4  fail-closed: '1' NAO liga o provedor real", quase.modoIaConfiguradoAgora === "fake");
    } finally {
      if (tinhaFlag) process.env[FLAG_REAL] = flagAntes as string;
      else delete process.env[FLAG_REAL];
    }

    secao("P. A rota nao faz o que nao deve");

    const CODIGO_CONVERSA = semComentarios(ler("app/api/agentes/[agenteId]/conversa/route.ts"));
    ok("P1  ANCORA: a fonte da rota foi lida", CODIGO_CONVERSA.length > 400 && /export async function POST/.test(CODIGO_CONVERSA));
    ok("P2  zero Supabase direto na rota", !/\.from\(|getSupabaseServidor|SupabaseClient|createClient/.test(CODIGO_CONVERSA));
    ok("P3  a rota NAO executa tarefa", !/executarTarefa|claim_next_agente_tarefa/.test(CODIGO_CONVERSA));
    ok("P4  zero Function/Approval/resume", !/executarFuncao|retomarAprovacao|aprovacoes/.test(CODIGO_CONVERSA));
    ok("P5  o userId vem SO de auth.uid", /auth\.uid/.test(CODIGO_CONVERSA) && !/body\.userId|corpo\.userId|searchParams\.get\("userId"\)/.test(CODIGO_CONVERSA));
    ok("P6  o tipo e fixado pela constante do handler, nao por string solta",
      /TIPO_CONVERSA/.test(CODIGO_CONVERSA) && !/tipo:\s*"conversa"/.test(CODIGO_CONVERSA));
    ok("P7  o modo vem da funcao canonica, nao do texto da resposta",
      /provedorRealHabilitado\(\)/.test(CODIGO_CONVERSA) && !/includes\("\[fake\]"\)/.test(CODIGO_CONVERSA));
    ok("P8  a leitura de tarefa e a tenant-scoped, nao a do executor",
      /lerTarefaDoDono/.test(CODIGO_CONVERSA) && !/lerTarefaParaExecucao/.test(CODIGO_CONVERSA));
    ok("P9  nenhuma tabela de mensagens foi criada",
      !/conversas|mensagens|threads|sessions|historico/i.test(CODIGO_CONVERSA));
    // F1: as duas afirmacoes que o R1 derrubou.
    ok("P11 erroTipo e fechado pelo vocabulario CANONICO, importado",
      /TIPOS_ERRO_TAREFA/.test(CODIGO_CONVERSA) &&
        /from "@\/lib\/agentes\/tipos-execucao"/.test(CODIGO_CONVERSA));
    ok("P12 a lista de tipos NAO foi reescrita a mao na rota",
      !/"tipo_desconhecido"/.test(CODIGO_CONVERSA) && !/"handler_falhou"/.test(CODIGO_CONVERSA));
    ok("P13 o comentario falso sobre CHECK do banco sumiu",
      !/VOCABULARIO FECHADO — o CHECK do banco/.test(ler("app/api/agentes/[agenteId]/conversa/route.ts")));
    ok("P14 o resultado concluido exige chave unica",
      /chaves\.length !== 1 \|\| chaves\[0\] !== "resposta"/.test(CODIGO_CONVERSA));
    ok("P15 nenhuma coercao String() entrou no caminho", !/String\(/.test(CODIGO_CONVERSA));
    ok("P10 nenhuma migration entrou nesta frente",
      !existsSync(join(RAIZ, "supabase/migrations/20260929_conversas.sql")));
  }

  // ─── Q. PATCH /api/agentes/[agenteId] — EDITAR-AGENTE-V1 ───────────
  //
  // A rota REAL roda contra o mesmo duplo com estado, com a capability
  // real (`atualizarAgenteDoDono`). O que se prova aqui nao e "o mock
  // devolveu o esperado": e que o CONTRATO e fechado, que a fronteira de
  // dono e o proprio UPDATE, e que nenhuma chave alem de `nome` e
  // `instrucoes` alcanca o payload.
  {
    const edicao = await import("../app/api/agentes/[agenteId]/route");
    const CODIGO_EDICAO = semComentarios(ler("app/api/agentes/[agenteId]/route.ts"));

    const patch = (agenteId: string, cookie: string | undefined, corpo?: string) =>
      edicao.PATCH(
        new Request(`http://localhost/api/agentes/${agenteId}`, {
          method: "PATCH",
          headers: cookie ? { cookie } : {},
          ...(corpo === undefined ? {} : { body: corpo }),
        }),
        { params: { agenteId } }
      );

    /** O payload do ULTIMO UPDATE observado. `null` = nenhum houve. */
    const ultimoPayload = (): Record<string, unknown> | null => {
      const escrita = operacoes.filter((o) => o.tipo === "escrita").pop();
      return escrita?.payload ?? null;
    };

    /** Uma linha nova do dono A, plantada direto na "tabela". */
    const plantar = (extra: Record<string, unknown> = {}) => {
      const l = linhaAgente(USER_A, "Antes", extra);
      linhas = [l];
      limpar();
      return l;
    };

    secao("Q. PATCH — sessao e identidade do recurso");

    linhas = []; limpar();
    const qSem = await patch(randomUUID(), undefined, '{"nome":"X"}');
    const bQSem = await qSem.json();
    ok("Q1  sem cookie -> 401", qSem.status === 401);
    ok("Q2  payload sanitizado, sem motivo nem uid",
      bQSem.ok === false && bQSem.erro === "Não autenticado." && Object.keys(bQSem).length === 2,
      JSON.stringify(bQSem));
    ok("Q3  e ZERO operacao de dominio", operacoes.length === 0);

    limpar();
    const qIdTorto = await patch("nao-e-uuid", COOKIE_A, '{"nome":"X"}');
    ok("Q4  agenteId fora de uuid -> 400 e zero dominio",
      qIdTorto.status === 400 && operacoes.length === 0);

    secao("Q. PATCH — o contrato e FECHADO");

    // Cada recusa e medida com ZERO escrita: o contrato barra antes do
    // banco, nao depois.
    const recusa = async (corpo: string | undefined, rotulo: string, erroEsperado: string) => {
      plantar();
      const r = await patch(linhas[0].id as string, COOKIE_A, corpo);
      const b = await r.json();
      ok(`Q5  ${rotulo} -> 400, sem escrita`,
        r.status === 400 && b.ok === false && b.erro === erroEsperado && escritas() === 0,
        `${r.status} · ${JSON.stringify(b)} · escritas=${escritas()}`);
    };

    const CORPO_INVALIDO = "Corpo da requisição inválido (JSON esperado).";
    const ALTERACAO_INVALIDA = "Alteração inválida.";
    const NOME_INVALIDO = "nome inválido.";

    await recusa(undefined, "sem corpo", CORPO_INVALIDO);
    await recusa("nao e json", "corpo ilegivel", CORPO_INVALIDO);
    await recusa('"texto"', "corpo string", CORPO_INVALIDO);
    await recusa("[]", "corpo array", CORPO_INVALIDO);
    await recusa("null", "corpo null", CORPO_INVALIDO);
    await recusa("{}", "objeto vazio", ALTERACAO_INVALIDA);
    await recusa('{"ativo":false}', "ativo isolado", ALTERACAO_INVALIDA);
    await recusa('{"tipo":"ads"}', "tipo isolado", ALTERACAO_INVALIDA);
    await recusa('{"user_id":"outro"}', "user_id", ALTERACAO_INVALIDA);
    await recusa('{"id":"outro"}', "id", ALTERACAO_INVALIDA);
    await recusa('{"criado_em":"2020-01-01"}', "criado_em", ALTERACAO_INVALIDA);
    await recusa('{"atualizado_em":"2020-01-01"}', "atualizado_em", ALTERACAO_INVALIDA);
    // O caso que uma allowlist frouxa deixaria passar: a chave proibida
    // vem ACOMPANHADA de uma chave valida.
    await recusa('{"nome":"Novo","ativo":false}', "nome + ativo", ALTERACAO_INVALIDA);
    await recusa('{"nome":"Novo","tipo":"ads"}', "nome + tipo", ALTERACAO_INVALIDA);
    await recusa('{"instrucoes":"ok","user_id":"outro"}', "instrucoes + user_id", ALTERACAO_INVALIDA);
    await recusa('{"nome":"   "}', "nome so com espaco", NOME_INVALIDO);
    await recusa('{"nome":""}', "nome vazio", NOME_INVALIDO);
    await recusa('{"nome":123}', "nome nao-string", NOME_INVALIDO);
    await recusa('{"nome":null}', "nome null", NOME_INVALIDO);
    // O ponto que a capability sozinha NAO cobre: ela converteria estes
    // em `null` e APAGARIA as instrucoes em silencio.
    await recusa('{"instrucoes":123}', "instrucoes numero", ALTERACAO_INVALIDA);
    await recusa('{"instrucoes":true}', "instrucoes booleano", ALTERACAO_INVALIDA);
    await recusa('{"instrucoes":{"a":1}}', "instrucoes objeto", ALTERACAO_INVALIDA);
    await recusa('{"instrucoes":[]}', "instrucoes array", ALTERACAO_INVALIDA);

    secao("Q. PATCH — a alteracao valida persiste, e volta projetada");

    {
      const l = plantar({ nome: "Antes", instrucoes: "velha" });
      const r = await patch(l.id as string, COOKIE_A, '{"nome":"Depois"}');
      const b = await r.json();
      ok("Q6  so nome -> 200 com a linha persistida",
        r.status === 200 && b.ok === true && b.agente.nome === "Depois" &&
          b.agente.instrucoes === "velha",
        JSON.stringify(b));
      ok("Q6a a projecao publica tem os SEIS campos, nem um a mais",
        JSON.stringify(Object.keys(b.agente).sort()) === JSON.stringify(CAMPOS_PUBLICOS),
        Object.keys(b.agente).sort().join(", "));
      ok("Q6b `user_id` e `atualizado_em` NAO saem na resposta",
        !("user_id" in b.agente) && !("atualizado_em" in b.agente));
      ok("Q6c uma unica escrita, e nenhuma leitura previa (nada de TOCTOU)",
        escritas() === 1 && leituras() === 0, `escritas=${escritas()} leituras=${leituras()}`);
      ok("Q6d a escrita foi na tabela `agentes`",
        operacoes[0]?.tabela === "agentes", operacoes[0]?.tabela);
      ok("Q6e o filtro e o PAR (id, user_id), na propria instrucao",
        JSON.stringify(operacoes[0]?.filtros) ===
          JSON.stringify({ id: l.id, user_id: USER_A }),
        JSON.stringify(operacoes[0]?.filtros));
    }

    {
      const l = plantar({ nome: "Antes", instrucoes: "velha" });
      const r = await patch(l.id as string, COOKIE_A, '{"instrucoes":"nova"}');
      const b = await r.json();
      ok("Q7  so instrucoes -> 200, e o nome nao e tocado",
        r.status === 200 && b.agente.instrucoes === "nova" && b.agente.nome === "Antes",
        JSON.stringify(b.agente));
      ok("Q7a o payload NAO carrega `nome` quando ele nao foi pedido",
        !("nome" in (ultimoPayload() ?? {})), JSON.stringify(ultimoPayload()));
    }

    {
      const l = plantar({ nome: "Antes", instrucoes: "velha" });
      const r = await patch(l.id as string, COOKIE_A, '{"nome":"N","instrucoes":"I"}');
      const b = await r.json();
      ok("Q8  os dois campos juntos -> 200",
        r.status === 200 && b.agente.nome === "N" && b.agente.instrucoes === "I",
        JSON.stringify(b.agente));
    }

    {
      const l = plantar({ nome: "Antes", instrucoes: "velha" });
      const r = await patch(l.id as string, COOKIE_A, '{"instrucoes":null}');
      const b = await r.json();
      ok("Q9  `instrucoes: null` LIMPA as instrucoes -> 200",
        r.status === 200 && b.agente.instrucoes === null, JSON.stringify(b.agente));
    }

    {
      const l = plantar({ nome: "Antes" });
      await patch(l.id as string, COOKIE_A, '{"nome":"  Aparado  "}');
      ok("Q10 o nome chega APARADO ao payload",
        ultimoPayload()?.nome === "Aparado", JSON.stringify(ultimoPayload()));
    }

    secao("Q. PATCH — o corpo nao decide dono, id, estado nem tempo");

    {
      const l = plantar({ nome: "Antes", instrucoes: "velha" });
      await patch(l.id as string, COOKIE_A, '{"nome":"N","instrucoes":"I"}');
      const payload = ultimoPayload() ?? {};
      const chaves = Object.keys(payload).sort();
      // Igualdade de conjunto: `atualizado_em` e da capability, os dois
      // outros sao o pedido. Uma chave a mais reprova, e uma a menos
      // tambem — allowlist que so olha um lado morre em silencio.
      ok("Q11 o UPDATE leva EXATAMENTE nome, instrucoes e atualizado_em",
        JSON.stringify(chaves) === JSON.stringify(["atualizado_em", "instrucoes", "nome"]),
        chaves.join(", "));
      ok("Q11a nenhuma chave reservada alcanca o UPDATE",
        ["user_id", "id", "ativo", "tipo", "criado_em"].every((c) => !(c in payload)));
      ok("Q11b a linha gravada continua do dono A, com o id original",
        linhas[0].user_id === USER_A && linhas[0].id === l.id);
      ok("Q11c e `ativo`/`tipo`/`criado_em` seguem intactos na linha",
        linhas[0].ativo === true && linhas[0].tipo === "mensagens" &&
          linhas[0].criado_em === "2026-08-01T00:00:00.000Z");
      ok("Q11d CONTROLE: a sonda de payload enxerga chave de verdade",
        "nome" in payload && "instrucoes" in payload);
    }

    secao("Q. PATCH — a fronteira de dono, e a mesma 404 para os dois casos");

    {
      // Agente REAL, de OUTRO dono. Nada casa o par (id, user_id).
      const alheio = linhaAgente(USER_B, "Do outro dono", { instrucoes: "intocada" });
      linhas = [alheio];
      limpar();
      const rOutro = await patch(alheio.id as string, COOKIE_A, '{"nome":"Invadido"}');
      const bOutro = await rOutro.json();
      ok("Q12 agente de OUTRO dono -> 404", rOutro.status === 404);
      ok("Q12a a linha alheia NAO foi tocada",
        linhas[0].nome === "Do outro dono" && linhas[0].instrucoes === "intocada");

      limpar();
      const rFantasma = await patch(randomUUID(), COOKIE_A, '{"nome":"Invadido"}');
      const bFantasma = await rFantasma.json();
      ok("Q13 agente INEXISTENTE -> 404", rFantasma.status === 404);
      // A resposta precisa ser indistinguivel: qualquer diferenca — status,
      // corpo, chaves — viraria um oraculo de existencia de ids alheios.
      ok("Q13a as duas 404 sao BYTE A BYTE iguais",
        rOutro.status === rFantasma.status &&
          JSON.stringify(bOutro) === JSON.stringify(bFantasma),
        `${JSON.stringify(bOutro)} vs ${JSON.stringify(bFantasma)}`);
      ok("Q13b e a mensagem nao distingue os dois casos",
        bOutro.erro === "Agente não encontrado." && Object.keys(bOutro).length === 2);
    }

    secao("Q. PATCH — falha de infraestrutura, sanitizada");

    {
      const l = plantar();
      erroInjetado = { code: "42P01", message: "relation agentes does not exist", details: "x" };
      const rErro = await patch(l.id as string, COOKIE_A, '{"nome":"N"}');
      const bErro = await rErro.json();
      ok("Q14 erro do banco -> 500", rErro.status === 500);
      ok("Q14a e nada do erro interno vaza",
        bErro.ok === false && bErro.erro === "Falha ao atualizar o agente." &&
          Object.keys(bErro).length === 2 &&
          !/42P01|relation|does not exist/i.test(JSON.stringify(bErro)),
        JSON.stringify(bErro));
    }

    secao("Q. PATCH — a rota nao faz o que nao deve");

    ok("Q15 ANCORA: a fonte da rota foi lida", CODIGO_EDICAO.length > 800);
    ok("Q16 a rota real esta no grafo",
      Object.keys(require.cache)
        .map((p) => p.replace(/\\/g, "/"))
        .some((p) => p.includes("/app/api/agentes/[agenteId]/route.ts")));
    ok("Q17 UM verbo, e e PATCH",
      /export async function PATCH\(/.test(CODIGO_EDICAO) &&
        !/export async function (GET|POST|PUT|DELETE|HEAD|OPTIONS)\(/.test(CODIGO_EDICAO));
    ok("Q18 zero Supabase direto na rota",
      !/getSupabaseServidor|createClient|service_role|\.from\(/.test(CODIGO_EDICAO));
    ok("Q19 zero spread do corpo externo",
      !/\.\.\.\s*(corpo|campos|bruto|body|leitura)/.test(CODIGO_EDICAO));
    ok("Q20 o objeto entregue ao dominio e montado campo a campo",
      /campos\.nome = /.test(CODIGO_EDICAO) && /campos\.instrucoes = /.test(CODIGO_EDICAO));
    ok("Q21 a allowlist de chaves e nominal e fechada",
      /CAMPOS_ALTERACAO = new Set\(\["nome", "instrucoes"\]\)/.test(CODIGO_EDICAO));
    ok("Q22 o userId vem SO de auth.uid",
      (CODIGO_EDICAO.match(/auth\.uid/g) ?? []).length === 1 &&
        !/\buserId\b\s*=|corpo\.user_id|campos\.user_id/.test(CODIGO_EDICAO));
    ok("Q23 o agenteId vem do CAMINHO, nunca do corpo",
      /params\.agenteId/.test(CODIGO_EDICAO) && !/corpo\.(id|agenteId|agente_id)/.test(CODIGO_EDICAO));
    ok("Q24 a rota NAO executa tarefa, Function, Approval nem provedor",
      !/executarTarefa|executarFuncao|retomarAprovacao|aprovacoes|AdaptadorIA|anthropic/i
        .test(CODIGO_EDICAO));
    ok("Q25 a rota nao cria nem apaga nada",
      !/criarAgente\b|criarTarefa|\bdelete\b/i.test(CODIGO_EDICAO));
    ok("Q26 toda resposta sai com no-store",
      /"Cache-Control": "no-store"/.test(CODIGO_EDICAO) &&
        (CODIGO_EDICAO.match(/NextResponse\.json\(/g) ?? []).length === 1);
    ok("Q27 nenhuma migration entrou nesta frente",
      !existsSync(join(RAIZ, "supabase/migrations/20260929_agentes_edicao.sql")));
    ok("Q28 a capability de atualizacao e a tenant-scoped, nao outra",
      /atualizarAgenteDoDono/.test(CODIGO_EDICAO) &&
        /from "@\/lib\/agentes\/capability"/.test(CODIGO_EDICAO));
    ok("Q29 nenhuma coercao String() entrou no caminho", !/String\(/.test(CODIGO_EDICAO));
    ok("Q30 `ativo` e `tipo` nao aparecem como campo aceito",
      !/campos\.(ativo|tipo)/.test(CODIGO_EDICAO) &&
        !/CAMPOS_ALTERACAO\.add/.test(CODIGO_EDICAO));
  }

  // ─── R–T. /permissoes — PERMISSOES-FUNCTION-V1-A ───────────────────
  //
  // A rota REAL roda contra o mesmo duplo com estado, com o registry
  // real e a capability real de escrita. O que se prova nao e "o mock
  // devolveu o esperado": e que o catalogo sai do REGISTRY, que ausencia
  // continua sendo `null` e nunca "bloqueado", que o contrato e fechado
  // nos DOIS sentidos, e que o UPSERT persiste de verdade — preservando
  // `criado_em` e avancando `alterado_em`.
  {
    const permissoesRota = await import("../app/api/agentes/[agenteId]/permissoes/route");
    const { listarFuncoesRegistradas } = await import("../lib/agentes/funcoes/registry");
    const { NIVEIS_AUTONOMIA } = await import("../lib/ia/conceitos");
    const CODIGO_PERM = semComentarios(ler("app/api/agentes/[agenteId]/permissoes/route.ts"));
    const CODIGO_ESCRITA = semComentarios(ler("lib/agentes/permissoes/escrita.ts"));

    const FUNCOES_REAIS = [...listarFuncoesRegistradas()].sort();
    /** A primeira Funcao REAL do registry. Nunca um id escrito a mao: se
     *  o catalogo mudar, a suite acompanha sem ninguem editar aqui. */
    const FUNCAO = FUNCOES_REAIS[0];

    const reqPerm = (agenteId: string, cookie: string | undefined, corpo?: string) =>
      new Request(`http://localhost/api/agentes/${agenteId}/permissoes`, {
        method: corpo === undefined ? "GET" : "PATCH",
        headers: cookie ? { cookie } : {},
        ...(corpo === undefined ? {} : { body: corpo }),
      });

    const getPerm = (agenteId: string, cookie?: string) =>
      permissoesRota.GET(reqPerm(agenteId, cookie), { params: { agenteId } });
    const patchPerm = (agenteId: string, cookie: string | undefined, corpo?: string) =>
      permissoesRota.PATCH(reqPerm(agenteId, cookie, corpo ?? "{}"), { params: { agenteId } });
    // Um PATCH SEM corpo precisa de Request proprio: `corpo ?? "{}"`
    // acima existe so para forcar o metodo.
    const patchSemCorpo = (agenteId: string, cookie: string) =>
      permissoesRota.PATCH(
        new Request(`http://localhost/api/agentes/${agenteId}/permissoes`, {
          method: "PATCH",
          headers: { cookie },
        }),
        { params: { agenteId } }
      );

    /** Um agente do dono A, plantado direto na "tabela". */
    const plantarAgente = () => {
      const l = linhaAgente(USER_A, "Com permissoes");
      linhas = [l];
      limpar();
      return l.id as string;
    };

    /** A linha de permissao persistida, se houver. */
    const linhaPermissao = (agenteId: string, funcaoId: string) =>
      linhas.find(
        (l) =>
          l.__tabela === "agente_permissoes" &&
          l.agente_id === agenteId &&
          l.funcao_id === funcaoId
      );

    const ultimoPayloadPerm = (): Record<string, unknown> | null =>
      operacoes.filter((o) => o.tipo === "escrita").pop()?.payload ?? null;

    secao("R. GET permissoes — sessao, identidade e fronteira de dono");

    linhas = []; limpar();
    const rPermSem = await getPerm(randomUUID());
    const bPermSem = await rPermSem.json();
    ok("R1  sem cookie -> 401", rPermSem.status === 401);
    ok("R2  payload sanitizado", bPermSem.ok === false &&
      bPermSem.erro === "Não autenticado." && Object.keys(bPermSem).length === 2);
    ok("R3  e ZERO operacao de dominio", operacoes.length === 0);

    limpar();
    ok("R4  agenteId fora de uuid -> 400 e zero dominio",
      (await getPerm("nao-e-uuid", COOKIE_A)).status === 400 && operacoes.length === 0);

    {
      const alheio = linhaAgente(USER_B, "Do outro dono");
      linhas = [alheio];
      limpar();
      const rOutro = await getPerm(alheio.id as string, COOKIE_A);
      const bOutro = await rOutro.json();
      limpar();
      const rFantasma = await getPerm(randomUUID(), COOKIE_A);
      const bFantasma = await rFantasma.json();
      ok("R5  agente de OUTRO dono -> 404", rOutro.status === 404);
      ok("R6  agente INEXISTENTE -> 404", rFantasma.status === 404);
      ok("R7  as duas 404 sao BYTE A BYTE iguais",
        rOutro.status === rFantasma.status &&
          JSON.stringify(bOutro) === JSON.stringify(bFantasma),
        `${JSON.stringify(bOutro)} vs ${JSON.stringify(bFantasma)}`);
      ok("R8  e nenhuma delas leu permissao alguma",
        operacoes.every((o) => o.tabela !== "agente_permissoes"));
    }

    secao("R. GET permissoes — o catalogo sai do REGISTRY, e ausencia e null");

    {
      const ag = plantarAgente();
      const r = await getPerm(ag, COOKIE_A);
      const b = await r.json();
      ok("R9  200 com uma entrada por Funcao REGISTRADA", r.status === 200 && b.ok === true &&
        Array.isArray(b.permissoes) && b.permissoes.length === FUNCOES_REAIS.length,
        `${b.permissoes?.length} vs ${FUNCOES_REAIS.length}`);
      // ── A guarda contra Funcao nova esquecida pela API ─────────────
      //
      // Igualdade de CONJUNTO com o registry, nos dois sentidos. Se
      // amanha entrar uma Funcao nova e a rota nao a projetar, reprova;
      // se a rota inventar um id que o registry nao tem, reprova
      // tambem. Nenhum catalogo duplicado nesta suite.
      ok("R10 os ids projetados sao EXATAMENTE os do registry",
        JSON.stringify(b.permissoes.map((p: { id: string }) => p.id).sort()) ===
          JSON.stringify(FUNCOES_REAIS),
        b.permissoes.map((p: { id: string }) => p.id).join(", "));
      ok("R10a CONTROLE NEGATIVO: uma Funcao a MENOS reprovaria",
        JSON.stringify(FUNCOES_REAIS.slice(1)) !== JSON.stringify(FUNCOES_REAIS));
      ok("R10b CONTROLE NEGATIVO: uma Funcao a MAIS reprovaria",
        JSON.stringify([...FUNCOES_REAIS, "zzz.nova"].sort()) !== JSON.stringify(FUNCOES_REAIS));
      ok("R10c ANCORA: o registry tem Funcao de verdade",
        FUNCOES_REAIS.length >= 1 && typeof FUNCAO === "string" && FUNCAO.includes("."));

      const entrada = b.permissoes.find((p: { id: string }) => p.id === FUNCAO);
      // O ponto central: sem linha gravada, `nivel` e `null`. NUNCA
      // "bloqueado" (apagaria a distincao que o guard mantem) e nunca
      // "automatico" (concederia o que ninguem concedeu).
      ok("R11 permissao AUSENTE vem como `nivel: null`", entrada.nivel === null,
        JSON.stringify(entrada));
      ok("R11a e nao vira `bloqueado` nem `automatico`",
        entrada.nivel !== "bloqueado" && entrada.nivel !== "automatico");
      ok("R12 a projecao tem EXATAMENTE os cinco campos publicos",
        JSON.stringify(Object.keys(entrada).sort()) ===
          JSON.stringify(["acesso", "conexaoNecessaria", "id", "idempotente", "nivel"]),
        Object.keys(entrada).sort().join(", "));
      ok("R13 nenhum campo interno do registry vaza",
        !("executor" in entrada) && !("validarEntrada" in entrada) &&
          !("interpretarSaida" in entrada) && !("revisao" in entrada));
      ok("R14 nenhum campo interno da permissao vaza",
        !("user_id" in entrada) && !("criado_em" in entrada) && !("alterado_em" in entrada));
      ok("R15 os metadados vem do registry real",
        entrada.acesso === "leitura" && entrada.idempotente === true &&
          entrada.conexaoNecessaria === null);
      ok("R16 a leitura foi em `agente_permissoes`, e ZERO escrita",
        operacoes.some((o) => o.tabela === "agente_permissoes" && o.tipo === "leitura") &&
          escritas() === 0);
      const filtrosPerm = (operacoes.find((o) => o.tabela === "agente_permissoes")?.filtros ??
        {}) as Record<string, unknown>;
      ok("R17 e a leitura carrega o PAR (agente, dono) na propria instrucao",
        filtrosPerm.agente_id === ag && filtrosPerm.user_id === USER_A,
        JSON.stringify(Object.keys(filtrosPerm).sort()));
      // A consulta e FECHADA nas Funcoes do registry: nao varre a tabela
      // inteira e nao devolve permissao de Funcao que deixou de existir.
      ok("R17a e e fechada nas Funcoes do registry",
        JSON.stringify((filtrosPerm.funcao_id as { __in: string[] } | undefined)?.__in) ===
          JSON.stringify(FUNCOES_REAIS),
        JSON.stringify(filtrosPerm.funcao_id));
    }

    secao("S. PATCH permissoes — o contrato e FECHADO nos dois sentidos");

    const recusaPerm = async (corpo: string, rotulo: string, erroEsperado: string) => {
      const ag = plantarAgente();
      const r = await patchPerm(ag, COOKIE_A, corpo);
      const b = await r.json();
      const escritasEmPermissoes = operacoes.filter(
        (o) => o.tipo === "escrita" && o.tabela === "agente_permissoes"
      ).length;
      ok(`S1  ${rotulo} -> 400, sem escrita`,
        r.status === 400 && b.ok === false && b.erro === erroEsperado &&
          escritasEmPermissoes === 0,
        `${r.status} · ${JSON.stringify(b)} · escritas=${escritasEmPermissoes}`);
    };

    const CORPO_INVALIDO = "Corpo da requisição inválido (JSON esperado).";
    const DEFINICAO_INVALIDA = "Definição inválida.";
    const FUNCAO_INVALIDA = "função inválida.";
    const NIVEL_INVALIDO = "nível inválido.";

    await recusaPerm("nao e json", "corpo ilegivel", CORPO_INVALIDO);
    await recusaPerm('"texto"', "corpo string", CORPO_INVALIDO);
    await recusaPerm("[]", "corpo array", CORPO_INVALIDO);
    await recusaPerm("null", "corpo null", CORPO_INVALIDO);
    await recusaPerm("42", "corpo numero", CORPO_INVALIDO);
    await recusaPerm("{}", "objeto vazio", DEFINICAO_INVALIDA);
    // SUBSET tambem reprova: meia definicao nao e decisao.
    await recusaPerm(`{"funcaoId":"${FUNCAO}"}`, "so funcaoId", DEFINICAO_INVALIDA);
    await recusaPerm('{"nivel":"automatico"}', "so nivel", DEFINICAO_INVALIDA);
    await recusaPerm(`{"funcaoId":"${FUNCAO}","nivel":"automatico","x":1}`,
      "chave extra", DEFINICAO_INVALIDA);
    await recusaPerm(`{"funcaoId":"${FUNCAO}","nivel":"automatico","user_id":"outro"}`,
      "user_id no corpo", DEFINICAO_INVALIDA);
    await recusaPerm(`{"funcaoId":"${FUNCAO}","nivel":"automatico","agente_id":"outro"}`,
      "agente_id no corpo", DEFINICAO_INVALIDA);
    await recusaPerm(`{"funcaoId":"${FUNCAO}","nivel":"automatico","revisao":"1"}`,
      "revisao no corpo", DEFINICAO_INVALIDA);
    await recusaPerm('{"funcaoId":123,"nivel":"automatico"}', "funcaoId nao-string", FUNCAO_INVALIDA);
    await recusaPerm('{"funcaoId":null,"nivel":"automatico"}', "funcaoId null", FUNCAO_INVALIDA);
    await recusaPerm('{"funcaoId":"","nivel":"automatico"}', "funcaoId vazio", FUNCAO_INVALIDA);
    // Forma valida pelo CHECK do banco, mas inexistente no registry.
    await recusaPerm('{"funcaoId":"vendas.inexistente","nivel":"automatico"}',
      "Funcao fora do registry", FUNCAO_INVALIDA);
    await recusaPerm('{"funcaoId":"constructor","nivel":"automatico"}',
      "id do prototipo NAO existe", FUNCAO_INVALIDA);
    await recusaPerm(`{"funcaoId":"${FUNCAO}","nivel":123}`, "nivel nao-string", NIVEL_INVALIDO);
    await recusaPerm(`{"funcaoId":"${FUNCAO}","nivel":"AUTOMATICO"}`,
      "nivel em maiuscula", NIVEL_INVALIDO);
    await recusaPerm(`{"funcaoId":"${FUNCAO}","nivel":" automatico "}`,
      "nivel com espaco", NIVEL_INVALIDO);
    await recusaPerm(`{"funcaoId":"${FUNCAO}","nivel":"liberado"}`,
      "nivel fora do vocabulario", NIVEL_INVALIDO);

    {
      const ag = plantarAgente();
      const r = await patchSemCorpo(ag, COOKIE_A);
      ok("S2  PATCH sem corpo -> 400", r.status === 400 &&
        (await r.json()).erro === CORPO_INVALIDO);
    }

    secao("S. PATCH permissoes — sessao e fronteira de dono");

    linhas = []; limpar();
    ok("S3  sem cookie -> 401 e zero dominio",
      (await patchPerm(randomUUID(), undefined, `{"funcaoId":"${FUNCAO}","nivel":"automatico"}`))
        .status === 401 && operacoes.length === 0);
    limpar();
    ok("S4  agenteId fora de uuid -> 400 e zero dominio",
      (await patchPerm("nao-e-uuid", COOKIE_A, `{"funcaoId":"${FUNCAO}","nivel":"automatico"}`))
        .status === 400 && operacoes.length === 0);

    {
      const alheio = linhaAgente(USER_B, "Do outro dono");
      linhas = [alheio];
      limpar();
      const corpo = `{"funcaoId":"${FUNCAO}","nivel":"automatico"}`;
      const rOutro = await patchPerm(alheio.id as string, COOKIE_A, corpo);
      const bOutro = await rOutro.json();
      const escritasOutro = operacoes.filter((o) => o.tipo === "escrita").length;
      limpar();
      const rFantasma = await patchPerm(randomUUID(), COOKIE_A, corpo);
      const bFantasma = await rFantasma.json();
      ok("S5  agente de OUTRO dono -> 404, sem escrita",
        rOutro.status === 404 && escritasOutro === 0);
      ok("S6  agente INEXISTENTE -> 404", rFantasma.status === 404);
      ok("S7  as duas 404 sao BYTE A BYTE iguais",
        JSON.stringify(bOutro) === JSON.stringify(bFantasma));
      ok("S8  nenhuma linha de permissao nasceu para o agente alheio",
        linhas.every((l) => l.__tabela !== "agente_permissoes"));
    }

    secao("S. PATCH permissoes — os tres niveis PERSISTEM, e bloqueado grava linha");

    for (const nivel of NIVEIS_AUTONOMIA) {
      const ag = plantarAgente();
      const r = await patchPerm(ag, COOKIE_A, `{"funcaoId":"${FUNCAO}","nivel":"${nivel}"}`);
      const b = await r.json();
      const linha = linhaPermissao(ag, FUNCAO);
      ok(`S9  nivel \`${nivel}\` -> 200 e linha persistida`,
        r.status === 200 && b.ok === true &&
          b.permissao.funcaoId === FUNCAO && b.permissao.nivel === nivel &&
          linha?.nivel === nivel,
        `${r.status} · ${JSON.stringify(b)} · linha=${JSON.stringify(linha?.nivel)}`);
      ok(`S9a \`${nivel}\`: a resposta expoe SO funcaoId e nivel`,
        JSON.stringify(Object.keys(b.permissao).sort()) ===
          JSON.stringify(["funcaoId", "nivel"]),
        Object.keys(b.permissao).sort().join(", "));
    }
    // O ponto ratificado: bloquear GRAVA, nao apaga. Uma linha com
    // `bloqueado` e o que separa `permissao_bloqueada` de
    // `permissao_ausente` no guard.
    {
      const ag = plantarAgente();
      await patchPerm(ag, COOKIE_A, `{"funcaoId":"${FUNCAO}","nivel":"bloqueado"}`);
      ok("S10 `bloqueado` deixa LINHA no banco — nao e ausencia",
        linhaPermissao(ag, FUNCAO)?.nivel === "bloqueado" &&
          linhas.filter((l) => l.__tabela === "agente_permissoes").length === 1);
      ok("S10a e o GET passa a devolver `bloqueado`, nao `null`",
        await (async () => {
          const b = await (await getPerm(ag, COOKIE_A)).json();
          return b.permissoes.find((p: { id: string }) => p.id === FUNCAO)?.nivel === "bloqueado";
        })());
    }

    secao("S. PATCH permissoes — o UPSERT persiste: uma linha, criado_em preservado");

    {
      const ag = plantarAgente();
      await patchPerm(ag, COOKIE_A, `{"funcaoId":"${FUNCAO}","nivel":"bloqueado"}`);
      const primeira = linhaPermissao(ag, FUNCAO)!;
      const criadoOriginal = primeira.criado_em;
      const alteradoPrimeiro = primeira.alterado_em;
      const payloadPrimeiro = ultimoPayloadPerm() ?? {};

      // ── O payload, por igualdade de conjunto ───────────────────────
      ok("S11 o UPSERT leva EXATAMENTE cinco colunas",
        JSON.stringify(Object.keys(payloadPrimeiro).sort()) ===
          JSON.stringify(["agente_id", "alterado_em", "funcao_id", "nivel", "user_id"]),
        Object.keys(payloadPrimeiro).sort().join(", "));
      ok("S11a `criado_em` NAO entra no payload",
        !("criado_em" in payloadPrimeiro));
      ok("S11b nenhuma chave reservada alcanca o banco",
        ["id", "revisao", "agenteId", "funcaoId"].every((c) => !(c in payloadPrimeiro)));
      ok("S11c o dono gravado e o da SESSAO",
        payloadPrimeiro.user_id === USER_A && payloadPrimeiro.agente_id === ag);
      ok("S11d CONTROLE: a sonda de payload enxerga chave de verdade",
        "nivel" in payloadPrimeiro && "funcao_id" in payloadPrimeiro);

      // Segunda definicao, nivel DIFERENTE, mesmo agente e mesma Funcao.
      await new Promise((r) => setTimeout(r, 5));
      await patchPerm(ag, COOKIE_A, `{"funcaoId":"${FUNCAO}","nivel":"aprovacao"}`);
      const segunda = linhaPermissao(ag, FUNCAO)!;

      ok("S12 a segunda definicao ATUALIZA a mesma linha — nao cria outra",
        linhas.filter((l) => l.__tabela === "agente_permissoes").length === 1 &&
          segunda.nivel === "aprovacao");
      ok("S12a `criado_em` PRESERVADO — a data da primeira definicao sobrevive",
        segunda.criado_em === criadoOriginal, String(segunda.criado_em));
      ok("S12b `alterado_em` AVANCOU",
        typeof segunda.alterado_em === "string" &&
          String(segunda.alterado_em) > String(alteradoPrimeiro),
        `${alteradoPrimeiro} -> ${segunda.alterado_em}`);
      ok("S12c o alvo do conflito e a PK publicada",
        operacoes.filter((o) => o.tipo === "escrita").length === 2);

      // Repetir o MESMO nivel: estado final identico.
      await patchPerm(ag, COOKIE_A, `{"funcaoId":"${FUNCAO}","nivel":"aprovacao"}`);
      const terceira = linhaPermissao(ag, FUNCAO)!;
      ok("S13 repetir o mesmo nivel e IDEMPOTENTE no estado final",
        linhas.filter((l) => l.__tabela === "agente_permissoes").length === 1 &&
          terceira.nivel === "aprovacao" && terceira.criado_em === criadoOriginal);

      ok("S14 e o GET reflete o nivel corrente",
        await (async () => {
          const b = await (await getPerm(ag, COOKIE_A)).json();
          return b.permissoes.find((p: { id: string }) => p.id === FUNCAO)?.nivel === "aprovacao";
        })());
    }

    secao("S. PATCH permissoes — falha de infraestrutura, sanitizada");

    {
      const ag = plantarAgente();
      // O primeiro `from()` da rota e a leitura do agente. Injetar aqui
      // exercita o 500 da PORTA, que e o caminho que a rota controla.
      erroInjetado = { code: "42P01", message: "relation agentes does not exist" };
      const r = await patchPerm(ag, COOKIE_A, `{"funcaoId":"${FUNCAO}","nivel":"automatico"}`);
      const b = await r.json();
      ok("S15 erro do banco -> 500", r.status === 500);
      ok("S15a e nada do erro interno vaza",
        b.ok === false && b.erro === "Falha ao definir a permissão." &&
          Object.keys(b).length === 2 &&
          !/42P01|relation|does not exist/i.test(JSON.stringify(b)));

      limpar();
      erroInjetado = { code: "42P01", message: "relation agente_permissoes does not exist" };
      const rG = await getPerm(ag, COOKIE_A);
      const bG = await rG.json();
      ok("S16 GET com erro do banco -> 500 sanitizado",
        rG.status === 500 && bG.erro === "Falha ao ler as permissões." &&
          !/42P01|relation/i.test(JSON.stringify(bG)));
    }

    // A capability sozinha, contra a violacao da FK composta: o caminho
    // que a rota nao alcanca porque a porta ja barrou o agente alheio.
    {
      const { definirPermissaoDeFuncaoDoAgente } = await import(
        "../lib/agentes/permissoes/escrita"
      );
      linhas = []; limpar();
      erroInjetado = { code: "23503", message: "violates foreign key constraint" };
      const r = await definirPermissaoDeFuncaoDoAgente({
        userId: USER_A, agenteId: randomUUID(), funcaoId: FUNCAO, nivel: "automatico",
      });
      ok("S17 a capability mapeia 23503 para `nao_disponivel`",
        r.estado === "nao_disponivel", r.estado);

      limpar();
      const rFuncao = await definirPermissaoDeFuncaoDoAgente({
        userId: USER_A, agenteId: randomUUID(), funcaoId: "vendas.inexistente", nivel: "automatico",
      });
      ok("S18 Funcao fora do registry nao chega ao banco",
        rFuncao.estado === "entrada_invalida" && operacoes.length === 0);
      limpar();
      const rNivel = await definirPermissaoDeFuncaoDoAgente({
        userId: USER_A, agenteId: randomUUID(), funcaoId: FUNCAO, nivel: "liberado",
      });
      ok("S19 nivel fora do vocabulario nao chega ao banco",
        rNivel.estado === "entrada_invalida" && operacoes.length === 0);
      limpar();
      const rDono = await definirPermissaoDeFuncaoDoAgente({
        userId: "", agenteId: randomUUID(), funcaoId: FUNCAO, nivel: "automatico",
      });
      ok("S20 sem dono nao ha escrita", rDono.estado === "entrada_invalida" &&
        operacoes.length === 0);
    }

    secao("T. A rota CONFIGURA — e nao executa");

    ok("T1  ANCORA: as duas fontes foram lidas",
      CODIGO_PERM.length > 900 && CODIGO_ESCRITA.length > 700);
    ok("T2  a rota real esta no grafo",
      Object.keys(require.cache).map((p) => p.replace(/\\/g, "/"))
        .some((p) => p.includes("/app/api/agentes/[agenteId]/permissoes/route.ts")));
    ok("T3  DOIS verbos, e sao GET e PATCH",
      /export async function GET\(/.test(CODIGO_PERM) &&
        /export async function PATCH\(/.test(CODIGO_PERM) &&
        !/export async function (POST|PUT|DELETE|HEAD|OPTIONS)\(/.test(CODIGO_PERM));
    ok("T4  zero Supabase direto na rota",
      !/getSupabaseServidor|createClient|service_role|\.from\(/.test(CODIGO_PERM));
    ok("T5  zero spread do corpo externo",
      !/\.\.\.\s*(corpo|bruto|body|leitura|entrada)/.test(CODIGO_PERM));
    ok("T6  o catalogo sai do REGISTRY, nunca de lista propria ou mock",
      /listarFuncoesRegistradas\(\)/.test(CODIGO_PERM) &&
        !/"vendas\.consultar"/.test(CODIGO_PERM) && !/MOCK_/.test(CODIGO_PERM));
    ok("T7  a leitura reusa `resolverFatosPermissoes`, sem segunda query",
      /resolverFatosPermissoes/.test(CODIGO_PERM) &&
        !/agente_permissoes/.test(CODIGO_PERM));
    ok("T8  `falha_leitura` NAO vira lista sem nivel",
      /coleta !== "ok"/.test(CODIGO_PERM));
    // DUAS ocorrencias, e as duas sao a MESMA fonte: a porta usa
    // `auth.uid` para provar a propriedade do agente e o repassa adiante.
    // O que o assert protege nao e a contagem — e que nao exista uma
    // TERCEIRA origem para o dono.
    //
    // Contagem seria fragil e diria pouco. O que se afirma e a CADEIA:
    // a porta produz `userId` a partir de `auth.uid`, e todo consumidor
    // recebe `porta.userId`. Qualquer `userId:` com terceira origem
    // reprova, porque a lista de valores e fechada.
    // A declaracao de TIPO (`userId: string;`) sai antes: ela nao e uma
    // origem de valor, e mante-la faria a lista fechada aceitar o token
    // `string` — que nao significa nada em runtime.
    const VALORES_DE_DONO = CODIGO_PERM.replace(/userId: string;/g, "");
    const origensDeDono = [...VALORES_DE_DONO.matchAll(/userId:\s*([A-Za-z.]+)/g)].map((m) => m[1]);
    ok("T9  todo `userId` vem da porta, e a porta vem de auth.uid",
      /userId: auth\.uid/.test(CODIGO_PERM) &&
        origensDeDono.length >= 3 &&
        origensDeDono.every((o) => o === "auth.uid" || o === "porta.userId") &&
        !/corpo\.user_id|body\.user_id|bruto\.user_id/.test(CODIGO_PERM),
      origensDeDono.join(", "));
    ok("T9a CONTROLE: a sonda de origem enxerga uma TERCEIRA fonte",
      [...("userId: corpo.user_id".matchAll(/userId:\s*([A-Za-z.]+)/g))]
        .map((m) => m[1])
        .some((o) => o !== "auth.uid" && o !== "porta.userId"));
    ok("T9c CONTROLE: a sonda acusaria um dono vindo do corpo",
      /corpo\.user_id/.test("const u = corpo.user_id;"));
    ok("T9b a Funcao e conferida contra o REGISTRY antes do dominio",
      /funcaoExiste\(bruto\.funcaoId\)/.test(CODIGO_PERM) &&
        /funcaoExiste\(/.test(CODIGO_ESCRITA));
    ok("T10 o agenteId vem do CAMINHO, nunca do corpo",
      /params\.agenteId/.test(CODIGO_PERM) &&
        !/corpo\.(agenteId|agente_id)/.test(CODIGO_PERM));
    // CONFIGURAR nao e EXECUTAR: a fronteira inteira desta fase.
    ok("T11 zero execucao de Function na rota",
      !/executarFuncao|autorizarFuncao|resolverFuncao\(.*\)\.executor|criarTarefa/.test(CODIGO_PERM));
    ok("T12 zero Approval e zero Tool Call na rota",
      !/aprovacao|aprovacoes|chamadas\/registro|registrarAbertura/i.test(CODIGO_PERM));
    ok("T13 zero worker, provider e conexao na rota",
      !/worker|anthropic|AdaptadorIA|conexoes|selecao/i.test(CODIGO_PERM));
    ok("T14 a mesma fronteira vale para a capability de escrita",
      !/executarFuncao|autorizarFuncao|criarTarefa|aprovacao/i.test(CODIGO_ESCRITA));
    ok("T15 nenhum DELETE em lugar nenhum desta frente",
      !/\.delete\(/.test(CODIGO_ESCRITA) && !/\.delete\(/.test(CODIGO_PERM) &&
        !/"DELETE"/.test(CODIGO_PERM));
    ok("T16 toda resposta sai com no-store",
      /"Cache-Control": "no-store"/.test(CODIGO_PERM) &&
        (CODIGO_PERM.match(/NextResponse\.json\(/g) ?? []).length === 1);
    ok("T17 nenhuma migration entrou nesta frente",
      !existsSync(join(RAIZ, "supabase/migrations/20260930_agente_permissoes_escrita.sql")));
    ok("T18 e nenhuma RPC foi criada para gravar permissao",
      !/\.rpc\(/.test(CODIGO_ESCRITA) && !/\.rpc\(/.test(CODIGO_PERM));
    ok("T19 nenhuma coercao String() no caminho da rota", !/String\(/.test(CODIGO_PERM));
  }

  // ── V. FUNCTION-RUNTIME-V1-B2A — a API de consultar_vendas ───────
  //
  // A primeira superficie publica que enfileira uma Funcao REAL. Duas
  // propriedades a defendem, e nenhuma e obvia por leitura casual:
  //
  //  1. ela e PRODUTORA, nunca executora. Se um dia chamar
  //     `executarFuncao` ou `executarTarefa` direto, a autorizacao de
  //     Funcao passaria a ter dois donos — e duas autoridades divergem.
  //
  //  2. o GET tem TRES pernas de binding: dono, agente e TIPO. A
  //     terceira e a menos obvia e a mais perigosa de perder: sem ela,
  //     um `tarefaId` de conversa lido por esta rota devolveria o
  //     resultado de uma conversa como se fosse resumo de vendas.
  //
  // Os controles negativos alimentam os MESMOS predicados com fonte
  // mutada — sem eles, um assert de ausencia fica verde por nao saber
  // dizer nao.
  {
    secao("V. B2A — API dedicada de consultar_vendas");

    const ROTA_VENDAS = "app/api/agentes/[agenteId]/consultar-vendas/route.ts";
    const CV = semComentarios(ler(ROTA_VENDAS));

    ok("V1  ANCORA: a fonte da rota foi lida e expoe os dois verbos",
      CV.length > 800 &&
      /export async function POST\(/.test(CV) &&
      /export async function GET\(/.test(CV));
    ok("V2  nenhum outro verbo e exportado",
      !/export async function (PUT|PATCH|DELETE|HEAD|OPTIONS)\(/.test(CV));

    // ── Corpo fechado ─────────────────────────────────────────────
    ok("V3  o corpo aceita EXATAMENTE as tres chaves do filtro",
      /CAMPOS_ENTRADA = new Set\(\["dataInicio", "dataFim", "marketplace"\]\)/.test(CV) &&
      /if \(!CAMPOS_ENTRADA\.has\(chave\)\) return \{ ok: false \};/.test(CV));
    ok("V4  `entrada` e montada campo a campo, nunca por spread",
      !/\.\.\.corpo/.test(CV) &&
      !/\.\.\.body/.test(CV) &&
      /entrada: Record<string, unknown> = \{/.test(CV) &&
      /dataInicio: corpo\.filtro\.dataInicio,/.test(CV));
    ok("V5  o chamador nao escolhe tipo, estado, dono nem retry",
      !/tipo:\s*(corpo|body)/.test(CV) &&
      !/status:\s*(corpo|body)/.test(CV) &&
      !/progresso/.test(CV) &&
      !/max_tentativas/.test(CV) &&
      !/funcaoId/.test(CV));

    // ── A validacao e REUTILIZADA, nao recopiada ──────────────────
    //
    // Se a regra de janela ou o enum de marketplace fossem reescritos
    // aqui, existiriam duas versoes da mesma regra e elas divergiriam
    // no primeiro dia em que uma mudasse.
    ok("V6  usa `validarFiltroVendas` e nao duplica a regra de dominio",
      /import \{ validarFiltroVendas/.test(CV) &&
      /validarFiltroVendas\(corpo\.filtro\)/.test(CV) &&
      !/JANELA_MAXIMA_DIAS/.test(CV) &&
      !/14/.test(CV) &&
      !/"Shopee"/.test(CV) &&
      !/"ML"/.test(CV));
    ok("V7  input invalido vira 400 com o codigo estavel de dominio",
      /if \(validacao\.erro\) \{/.test(CV) &&
      /responder\(\{ ok: false, erro: validacao\.erro \}, 400\)/.test(CV));

    /**
     * A ORDEM importa: validar DEPOIS de criar a tarefa deixaria uma
     * `consultar_vendas` no banco so para falhar um minuto depois.
     */
    const criaDepoisDeValidar = (texto: string): boolean => {
      const iValida = texto.indexOf("validarFiltroVendas(corpo.filtro)");
      const iCria = texto.indexOf("await criarTarefa(");
      return iValida > 0 && iCria > iValida;
    };
    ok("V8  a validacao precede a criacao da tarefa", criaDepoisDeValidar(CV));
    ok("V8  CONTROLE NEGATIVO: validar depois de criar reprova",
      !criaDepoisDeValidar(
        CV.replace("validarFiltroVendas(corpo.filtro)", "__VALIDACAO_MOVIDA__")));

    // ── Producao de tarefa, nunca execucao ────────────────────────
    ok("V9  a tarefa nasce pela capability publicada, com tipo FIXADO",
      /import \{ criarTarefa, lerAgenteDoDono, lerTarefaDoDono \}/.test(CV) &&
      /tipo: TIPO_CONSULTAR_VENDAS,/.test(CV) &&
      !/tipo:\s*"consultar_vendas"/.test(CV));
    ok("V10 zero Supabase direto na rota",
      !/\.from\(|getSupabaseServidor|SupabaseClient|createClient|\.rpc\(/.test(CV));

    /** A invariante que separa produtor de executor. */
    const soProduz = (texto: string): boolean =>
      !/executarFuncao/.test(texto) &&
      !/executarTarefa/.test(texto) &&
      !/claim_next_agente_tarefa/.test(texto) &&
      !/reivindicarProximaTarefa/.test(texto) &&
      !/internal\/agentes/.test(texto) &&
      !/\bfetch\(/.test(texto);
    ok("V11 a rota PRODUZ tarefa e nao executa nada", soProduz(CV));
    ok("V11 CONTROLE NEGATIVO: uma chamada a executarTarefa reprova",
      !soProduz(CV + "\nawait executarTarefa(tarefa.id);"));
    ok("V11 CONTROLE NEGATIVO: uma chamada a executarFuncao reprova",
      !soProduz(CV + "\nawait executarFuncao(FUNCAO_ID, {});"));

    // ── Permissao NAO e decidida aqui ─────────────────────────────
    //
    // `executarFuncao` ja produz negado/aguardando_aprovacao/sucesso.
    // Um segundo guarda nesta rota nao somaria seguranca: criaria uma
    // resposta que pode discordar da do runtime.
    ok("V12 a rota nao consulta nem importa permissao como autoridade",
      !/agente_permissoes/.test(CV) &&
      !/permissoes/.test(CV) &&
      !/NivelAutonomia|nivel/.test(CV));

    ok("V13 sucesso e 202 com a projecao minima",
      /responder\(\{ ok: true, tarefaId: tarefa\.id, status: tarefa\.status \}, 202\)/.test(CV));

    // ── GET: as tres pernas ───────────────────────────────────────
    ok("V14 o GET exige tarefaId e recusa identificador malformado",
      /searchParams\.get\("tarefaId"\)/.test(CV) &&
      /if \(!UUID_REGEX\.test\(tarefaId\)\)/.test(CV));
    ok("V15 a leitura e tenant-scoped, nunca a do executor",
      /lerTarefaDoDono\(tarefaId, auth\.uid\)/.test(CV) &&
      !/lerTarefaParaExecucao/.test(CV));

    /**
     * As TRES pernas, e o mesmo 404 nas tres. Perder qualquer uma e
     * IDOR ou confusao de tipo; responder diferente em alguma delas e
     * um oraculo de existencia.
     */
    const bindingCompleto = (texto: string): boolean => {
      const temDono = /lerTarefaDoDono\(tarefaId, auth\.uid\)/.test(texto);
      const temAgente = /if \(tarefa\.agente_id !== agenteId\)/.test(texto);
      const temTipo = /if \(tarefa\.tipo !== TIPO_CONSULTAR_VENDAS\)/.test(texto);
      if (!temDono || !temAgente || !temTipo) return false;

      // As recusas do GET sao indistinguiveis: mesmo corpo, mesmo 404.
      // O recorte e obrigatorio — o POST tem 404 proprios ("Agente nao
      // encontrado"), e conta-los junto compararia recusas de rotas
      // diferentes. Foi o que a primeira versao desta sonda fez.
      const get = texto.slice(texto.indexOf("export async function GET("));
      const recusas = [...get.matchAll(/responder\((\{[^}]*\}), 404\)/g)].map((m) => m[1]);
      return recusas.length === 3 && new Set(recusas).size === 1;
    };
    ok("V16 owner + agente + tipo, com 404 indistinguivel nos tres",
      bindingCompleto(CV));
    ok("V16 CONTROLE NEGATIVO: sem a perna do AGENTE reprova (IDOR)",
      !bindingCompleto(CV.replace("if (tarefa.agente_id !== agenteId)", "if (false)")));
    ok("V16 CONTROLE NEGATIVO: sem a perna do TIPO reprova (confusao de tipo)",
      !bindingCompleto(CV.replace("if (tarefa.tipo !== TIPO_CONSULTAR_VENDAS)", "if (false)")));
    ok("V16 CONTROLE NEGATIVO: um 404 com corpo diferente reprova",
      !bindingCompleto(
        CV.replace('if (tarefa.agente_id !== agenteId) {\n      return responder({ ok: false, erro: "Consulta não encontrada." }, 404);',
                   'if (tarefa.agente_id !== agenteId) {\n      return responder({ ok: false, erro: "Agente divergente." }, 404);')));

    // ── Projecao por allowlist ────────────────────────────────────
    const corpoDoGet = CV.slice(CV.indexOf("export async function GET("));
    ok("V17 ANCORA: o corpo do GET foi recortado", corpoDoGet.length > 500);
    ok("V18 a resposta nao carrega tenant, payload nem relogio interno",
      !/user_id:/.test(corpoDoGet) &&
      !/entrada/.test(corpoDoGet) &&
      !/heartbeat_em:/.test(corpoDoGet) &&
      !/erro_mensagem/.test(corpoDoGet) &&
      !/tentativas/.test(corpoDoGet));
    ok("V19 `erro_tipo` sai PROJETADO pelo vocabulario do codigo",
      /TIPOS_ERRO_TAREFA/.test(CV) &&
      /erroTipo: erroTipoConhecido\(tarefa\.erro_tipo\)/.test(CV) &&
      /return \(TIPOS_ERRO_TAREFA as readonly string\[\]\)\.includes\(bruto\) \? bruto : null;/.test(CV));

    ok("V20 resultado so existe quando a tarefa concluiu",
      /if \(tarefa\.status === "concluido"\)/.test(CV) &&
      /let resultado: Record<string, unknown> \| null = null;/.test(CV));
    ok("V21 o resultado e PROJETADO do que ja esta persistido, sem reconsulta",
      !/agregar|lerVendas|criarLeiturasDeVendas|pedidos/.test(CV));

    ok("V22 nenhuma acao de Approval e nenhum cancelamento",
      !/aprovar|rejeitar|retomarAprovacao|consumir/.test(CV) &&
      !/export async function DELETE/.test(CV) &&
      !/cancelad/.test(CV));

    ok("V23 nada de runner generico: a Funcao e fixa no servidor",
      !/req\.body\.funcaoId|corpo\.funcaoId|params\.funcaoId/.test(CV) &&
      !/jsonSchema|JSONSchema|renderArgs/.test(CV));

    ok("V24 o userId vem SO de auth.uid",
      /auth\.uid/.test(CV) &&
      !/corpo\.userId|body\.userId|searchParams\.get\("userId"\)/.test(CV));
  }

  // ── W. GET /api/aprovacoes — a fila real do dono ─────────────────
  //
  // APPROVAL-UI-API-A1. A rota REAL roda contra o duplo com estado, e
  // com ela o helper real: a consulta e montada por
  // `listarAprovacoesPendentesDoDono`, nao por callback de mock.
  //
  // O que esta secao existe para provar e, em ordem de importancia:
  // que a fila de A nunca alcanca a de B; que aprovacao vencida nao
  // aparece; que NADA e escrito ao abrir a tela; e que nenhum campo
  // interno atravessa — as fixtures abaixo carregam `fingerprint`,
  // `argumentos_hash` e `request_id_solicitacao` de proposito, para
  // que a prova de projecao nao seja vacua.
  secao("W. GET /api/aprovacoes — leitura owner-scoped, bounded e sem escrita");
  {
    const aprovacoesRota = await import("../app/api/aprovacoes/route");

    const AG_A = "cccccccc-3333-4333-8333-cccccccccccc";
    const AG_B = "eeeeeeee-5555-4555-8555-eeeeeeeeeeee";
    const ONTEM = "2026-09-13T21:00:00.000Z";
    const DAQUI_A_UM_DIA = new Date(Date.now() + 24 * 3600_000).toISOString();
    const JA_VENCEU = new Date(Date.now() - 3600_000).toISOString();

    const aprovacao = (
      id: string,
      userId: string,
      agenteId: string,
      extra: Record<string, unknown> = {}
    ) => ({
      __tabela: "agente_funcao_aprovacoes",
      id,
      user_id: userId,
      agente_id: agenteId,
      tarefa_id: "dddddddd-4444-4444-8444-dddddddddddd",
      funcao_id: "vendas.consultar",
      revisao_funcao: "1",
      acesso: "leitura",
      estado: "pendente",
      criado_em: ONTEM,
      expira_em: DAQUI_A_UM_DIA,
      argumentos: { dataInicio: "2026-09-12", dataFim: "2026-09-13" },
      conexao_plataforma: null,
      conexao_recurso: null,
      // Internos, deliberadamente presentes no datastore.
      argumentos_hash: "a".repeat(64),
      fingerprint: "b".repeat(64),
      request_id_solicitacao: "req-solicitacao-interno",
      request_id_consumo: null,
      conexao_loja_id: null,
      decidido_por: null,
      ...extra,
    });

    const agente = (id: string, userId: string, nome: string) => ({
      __tabela: "agentes",
      id,
      user_id: userId,
      nome,
    });

    const pedirAprovacoes = (cookie?: string) =>
      aprovacoesRota.GET(
        new Request("http://localhost/api/aprovacoes", {
          method: "GET",
          headers: cookie ? { cookie } : {},
        })
      );

    const semearFila = (): void => {
      linhas = [
        agente(AG_A, USER_A, "Teste Chat IA Real"),
        agente(AG_B, USER_B, "Agente do outro dono"),
        aprovacao("11111111-1111-4111-8111-111111111111", USER_A, AG_A),
        aprovacao("22222222-2222-4222-8222-222222222222", USER_B, AG_B),
      ];
      limpar();
    };

    // ── W1..W3 — autenticacao ─────────────────────────────────────
    semearFila();
    const semSessao = await pedirAprovacoes();
    ok("W1  sem sessao a fila nao abre", semSessao.status === 401);
    ok("W2  e nenhuma leitura chegou ao banco", operacoes.length === 0);

    semearFila();
    const forjado = await pedirAprovacoes("cds_session=nao.e.token");
    ok("W3  cookie forjado tambem e 401", forjado.status === 401);

    // ── W4..W8 — a fila do dono, e so dele ────────────────────────
    semearFila();
    const filaA = await pedirAprovacoes(COOKIE_A);
    const corpoA = (await filaA.json()) as {
      ok: boolean;
      aprovacoes: Record<string, unknown>[];
    };

    ok("W4  200 com envelope ok", filaA.status === 200 && corpoA.ok === true);
    ok("W5  a fila de A traz exatamente a aprovacao de A",
      corpoA.aprovacoes.length === 1 &&
      corpoA.aprovacoes[0]?.id === "11111111-1111-4111-8111-111111111111",
      String(corpoA.aprovacoes.length));
    ok("W6  ISOLAMENTO: a aprovacao de B nao aparece para A",
      JSON.stringify(corpoA.aprovacoes).indexOf("22222222") === -1);
    ok("W7  o filtro de dono foi ao DATASTORE, nao aplicado depois",
      operacoes.some(
        (o) => o.tabela === "agente_funcao_aprovacoes" && o.filtros["user_id"] === USER_A
      ));

    const filaB = await pedirAprovacoes(COOKIE_B);
    const corpoB = (await filaB.json()) as { aprovacoes: Record<string, unknown>[] };
    ok("W8  e a fila de B traz somente a de B",
      corpoB.aprovacoes.length === 1 &&
      corpoB.aprovacoes[0]?.id === "22222222-2222-4222-8222-222222222222");

    // ── W9..W12 — projecao bounded ────────────────────────────────
    const item = corpoA.aprovacoes[0] ?? {};
    ok("W9  a resposta expoe exatamente os doze campos publicos",
      JSON.stringify(Object.keys(item).sort()) ===
        JSON.stringify([
          "acesso", "agenteId", "agenteNome", "argumentos", "conexao", "criadoEm",
          "estado", "expiraEm", "funcaoId", "id", "revisaoFuncao", "tarefaId",
        ]),
      Object.keys(item).join(", "));
    ok("W10 o nome do agente e o REAL, lido da tabela de agentes",
      item.agenteNome === "Teste Chat IA Real");

    const textoA = JSON.stringify(corpoA);
    ok("W11 NENHUM campo interno atravessa, em nenhuma grafia",
      !/user_id|userId/.test(textoA) &&
      !/argumentos_hash|argumentosHash/.test(textoA) &&
      !/fingerprint/.test(textoA) &&
      !/request_id|requestId/.test(textoA) &&
      !/conexao_loja_id|conexaoLojaId|loja_id|lojaId/.test(textoA) &&
      !/decidido|cancelado|motivo_recusa|motivoRecusa/.test(textoA),
      textoA.slice(0, 160));
    ok("W12 CONTROLE: os internos EXISTEM no datastore — a prova nao e vacua",
      linhas.some((l) => typeof l.fingerprint === "string" && typeof l.argumentos_hash === "string"));

    // ── W13..W15 — argumentos ─────────────────────────────────────
    ok("W13 argumentos chegam como OBJETO, nao como texto serializado",
      typeof item.argumentos === "object" && item.argumentos !== null &&
      (item.argumentos as Record<string, unknown>).dataInicio === "2026-09-12");
    ok("W14 e nao sao transformados, completados nem inferidos",
      JSON.stringify(item.argumentos) ===
        JSON.stringify({ dataInicio: "2026-09-12", dataFim: "2026-09-13" }));
    ok("W15 `estado` e sempre pendente nesta fila", item.estado === "pendente");

    // ── W16..W18 — vencida nao aparece, e nao e reescrita ─────────
    linhas = [
      agente(AG_A, USER_A, "Teste Chat IA Real"),
      aprovacao("33333333-3333-4333-8333-333333333333", USER_A, AG_A, {
        expira_em: JA_VENCEU,
      }),
    ];
    limpar();
    const comVencida = await pedirAprovacoes(COOKIE_A);
    const corpoVencida = (await comVencida.json()) as { aprovacoes: unknown[] };

    ok("W16 aprovacao VENCIDA nao entra na fila", corpoVencida.aprovacoes.length === 0);
    ok("W17 e ela continua `pendente` no banco — GET nao materializa expiracao",
      linhas.some((l) => l.id === "33333333-3333-4333-8333-333333333333" && l.estado === "pendente"));
    ok("W18 nenhuma escrita aconteceu ao abrir a fila",
      operacoes.every((o) => o.tipo === "leitura") && rpcs === 0,
      `escritas=${operacoes.filter((o) => o.tipo === "escrita").length} rpcs=${rpcs}`);

    // ── W19 — decidida nao aparece ────────────────────────────────
    linhas = [
      agente(AG_A, USER_A, "Teste Chat IA Real"),
      aprovacao("44444444-4444-4444-8444-444444444444", USER_A, AG_A, { estado: "aprovada" }),
    ];
    limpar();
    const comAprovada = await pedirAprovacoes(COOKIE_A);
    ok("W19 aprovacao ja decidida nao entra na fila de pendentes",
      ((await comAprovada.json()) as { aprovacoes: unknown[] }).aprovacoes.length === 0);

    // ── W20..W22 — ordem e teto ───────────────────────────────────
    linhas = [agente(AG_A, USER_A, "Teste Chat IA Real")];
    for (let i = 0; i < 60; i++) {
      linhas.push(
        aprovacao(
          `5${String(i).padStart(7, "0")}-6666-4666-8666-666666666666`,
          USER_A,
          AG_A,
          { criado_em: `2026-09-${String(10 + (i % 5)).padStart(2, "0")}T0${i % 10}:00:00.000Z` }
        )
      );
    }
    limpar();
    const cheia = await pedirAprovacoes(COOKIE_A);
    const corpoCheia = (await cheia.json()) as { aprovacoes: { criadoEm: string }[] };

    ok("W20 a fila e BOUNDED em 50, mesmo com 60 pendentes",
      corpoCheia.aprovacoes.length === 50, String(corpoCheia.aprovacoes.length));
    ok("W21 e o limite chegou ao datastore, nao foi cortado depois",
      operacoes.some((o) => o.tabela === "agente_funcao_aprovacoes" && o.limite === 50));
    const datas = corpoCheia.aprovacoes.map((a) => a.criadoEm);
    ok("W22 mais recente primeiro",
      JSON.stringify(datas) === JSON.stringify([...datas].sort().reverse()));

    // ── W23..W25 — fail-closed ────────────────────────────────────
    linhas = [
      // Agente do dono AUSENTE de proposito: a FK impede isso no banco,
      // e se mesmo assim acontecer a fila nao inventa rotulo.
      aprovacao("77777777-7777-4777-8777-777777777777", USER_A, AG_A),
    ];
    limpar();
    const semAgente = await pedirAprovacoes(COOKIE_A);
    const corpoSemAgente = await semAgente.text();
    ok("W23 agente ausente vira 500, nunca `Agente desconhecido`",
      semAgente.status === 500 && !/desconhecid/i.test(corpoSemAgente));

    semearFila();
    erroInjetado = { message: 'select * from agente_funcao_aprovacoes where user_id = ...', code: "42P01", hint: "tabela" };
    const comErro = await pedirAprovacoes(COOKIE_A);
    const corpoErro = await comErro.text();
    ok("W24 falha do banco vira 500", comErro.status === 500);
    ok("W25 e o texto bruto do Supabase NAO vaza para o cliente",
      !/select |from agente_funcao|42P01|hint/i.test(corpoErro), corpoErro.slice(0, 120));

    // ── W26 — fila vazia e resposta completa ──────────────────────
    linhas = [agente(AG_A, USER_A, "Teste Chat IA Real")];
    limpar();
    const vazia = await pedirAprovacoes(COOKIE_A);
    const corpoVazio = (await vazia.json()) as { ok: boolean; aprovacoes: unknown[] };
    ok("W26 fila vazia e 200 com lista vazia, nao 404",
      vazia.status === 200 && corpoVazio.ok === true && corpoVazio.aprovacoes.length === 0);

    // ── W27..W32 — a FONTE da rota ────────────────────────────────
    const AP = semComentarios(ler("app/api/aprovacoes/route.ts"));

    ok("W27 a rota exporta SOMENTE GET",
      JSON.stringify([...AP.matchAll(/export async function ([A-Z]+)\(/g)].map((m) => m[1])) ===
        JSON.stringify(["GET"]));
    ok("W28 CONTROLE: um segundo metodo reprovaria",
      JSON.stringify(
        [...(AP + "\nexport async function POST(").matchAll(/export async function ([A-Z]+)\(/g)]
          .map((m) => m[1])
      ) !== JSON.stringify(["GET"]));
    ok("W29 a identidade vem SO de auth.uid",
      /auth\.uid/.test(AP) &&
      !/searchParams|request\.json\(\)|headers\.get\("x-user/.test(AP));
    ok("W30 a rota nao abre banco nem escreve",
      !/getSupabaseServidor|\.from\(|\.rpc\(|\.insert\(|\.update\(|\.delete\(/.test(AP));
    ok("W31 nao importa decisao, consumo nem retomada",
      !/decidirAprovacao|consumirAprovacaoEAbrir|retomarAprovacao|criarAprovacao/.test(AP));
    ok("W32 a resposta e no-store e dinamica",
      /"Cache-Control": "no-store"/.test(AP) &&
      /export const dynamic = "force-dynamic"/.test(AP));
  }

  // ── X. POST /api/aprovacoes/[id]/decidir — a decisao humana ──────
  //
  // APPROVAL-DECISION-A3. A rota REAL roda, e com ela o wrapper REAL de
  // `decidirAprovacao`: o que e simulado e so a RESPOSTA da RPC, que e
  // exatamente a fronteira que esta suite nao atravessa.
  //
  // A tabela de traducao e o coracao da secao. Cada codigo que o D4 sabe
  // devolver tem um status, e dois deles dependem TAMBEM do que foi
  // pedido: `ja_aprovada` e sucesso idempotente para quem repetiu
  // "aprovar" e conflito para quem tentou "rejeitar". Os expected sao
  // literais, escritos a mao — deriva-los do switch da rota provaria
  // apenas que a rota concorda consigo mesma.
  secao("X. POST /api/aprovacoes/[id]/decidir — decisao, e nada alem");
  {
    const decidirRota = await import("../app/api/aprovacoes/[aprovacaoId]/decidir/route");
    const AP_ID = "77777777-7777-4777-8777-777777777777";

    const pedir = (
      corpo: unknown,
      opts: { cookie?: string; id?: string; cru?: string } = {}
    ) =>
      decidirRota.POST(
        new Request(`http://localhost/api/aprovacoes/${opts.id ?? AP_ID}/decidir`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(opts.cookie ? { cookie: opts.cookie } : {}),
          },
          body: opts.cru !== undefined ? opts.cru : JSON.stringify(corpo),
        }),
        { params: { aprovacaoId: opts.id ?? AP_ID } }
      );

    /** Roda uma decisao com a RPC programada para devolver `codigo`. */
    const comCodigo = async (
      codigo: string,
      decisao: "aprovar" | "rejeitar"
    ): Promise<{ status: number; corpo: Record<string, unknown> }> => {
      respostaRpc = { data: codigo, error: null };
      const r = await pedir({ decisao }, { cookie: COOKIE_A });
      respostaRpc = RPC_PADRAO;
      return { status: r.status, corpo: (await r.json()) as Record<string, unknown> };
    };

    // ── X1..X3 — sessao ───────────────────────────────────────────
    {
      const rpcsAntes = rpcs;
      const r = await pedir({ decisao: "aprovar" });
      const c = (await r.json()) as Record<string, unknown>;
      ok("X1  sem cookie e 401", r.status === 401);
      ok("X1a e o corpo nao vaza motivo", c.ok === false && c.erro === "Não autenticado.");
      ok("X2  401 nao chega a tocar a RPC", rpcs === rpcsAntes);
    }
    ok("X3  cookie invalido tambem e 401",
      (await pedir({ decisao: "aprovar" }, { cookie: "cds_session=lixo" })).status === 401);

    // ── X4..X10 — o corpo, fechado por INCLUSAO ───────────────────
    const ENTRADA = "Entrada inválida.";
    const corpo400 = async (cru: string, rotulo: string) => {
      const rpcsAntes = rpcs;
      const r = await pedir(undefined, { cookie: COOKIE_A, cru });
      const c = (await r.json()) as Record<string, unknown>;
      ok(rotulo, r.status === 400 && c.erro === ENTRADA && rpcs === rpcsAntes);
    };
    await corpo400("{", "X4  JSON malformado e 400, sem tocar a RPC");
    await corpo400("null", "X5  `null` e 400");
    await corpo400('["aprovar"]', "X6  array e 400 — decisao por posicao nao existe");
    await corpo400('"aprovar"', "X7  primitivo e 400");
    await corpo400('{"decisao":"aprovar","userId":"outro"}', "X8  chave a mais e 400");
    await corpo400('{"acao":"aprovar"}', "X9  chave errada e 400");
    await corpo400('{"decisao":"talvez"}', "X10 enum invalido e 400");
    await corpo400('{"decisao":"cancelar"}', "X10a `cancelar` NAO e decisao humana");
    await corpo400('{"decisao":123}', "X10b decisao nao-string e 400");
    await corpo400("{}", "X10c corpo vazio e 400");

    // ── X11 — o id vem do segmento, e e validado ──────────────────
    {
      const rpcsAntes = rpcs;
      const r = await pedir({ decisao: "aprovar" }, { cookie: COOKIE_A, id: "nao-e-uuid" });
      ok("X11 aprovacaoId fora de UUID e 400, sem tocar a RPC",
        r.status === 400 && rpcs === rpcsAntes);
    }

    // ── X12..X13 — sucesso ────────────────────────────────────────
    {
      const r = await comCodigo("aprovada", "aprovar");
      ok("X12 aprovar + `aprovada` e 200",
        r.status === 200 && r.corpo.ok === true &&
        r.corpo.decisao === "aprovar" && r.corpo.estado === "aprovada");
    }
    {
      const r = await comCodigo("rejeitada", "rejeitar");
      ok("X13 rejeitar + `rejeitada` e 200",
        r.status === 200 && r.corpo.ok === true &&
        r.corpo.decisao === "rejeitar" && r.corpo.estado === "rejeitada");
    }

    // ── X14 — a identidade e a da SESSAO ──────────────────────────
    {
      respostaRpc = { data: "aprovada", error: null };
      await pedir({ decisao: "aprovar" }, { cookie: COOKIE_A });
      respostaRpc = RPC_PADRAO;
      const args = (ultimaRpc?.args ?? {}) as Record<string, unknown>;
      ok("X14 a RPC recebe o dono da SESSAO, o id do segmento e a decisao",
        ultimaRpc?.nome === "aprovacao_decidir" &&
        args.p_user_id === USER_A &&
        args.p_aprovacao_id === AP_ID &&
        args.p_decisao === "aprovar");
      ok("X14a e nenhum id causal extra viaja para a RPC",
        Object.keys(args).sort().join(",") === "p_aprovacao_id,p_decisao,p_motivo,p_user_id");
    }

    // ── X15..X18 — idempotente vs conflito ────────────────────────
    {
      const r = await comCodigo("ja_aprovada", "aprovar");
      ok("X15 `ja_aprovada` + aprovar e 200 IDEMPOTENTE",
        r.status === 200 && r.corpo.ok === true && r.corpo.estado === "aprovada");
    }
    {
      const r = await comCodigo("ja_aprovada", "rejeitar");
      ok("X16 `ja_aprovada` + rejeitar e 409 — decisao CONTRARIA nao passa",
        r.status === 409 && r.corpo.ok === false);
    }
    {
      const r = await comCodigo("ja_rejeitada", "rejeitar");
      ok("X17 `ja_rejeitada` + rejeitar e 200 IDEMPOTENTE",
        r.status === 200 && r.corpo.ok === true && r.corpo.estado === "rejeitada");
    }
    {
      const r = await comCodigo("ja_rejeitada", "aprovar");
      ok("X18 `ja_rejeitada` + aprovar e 409",
        r.status === 409 && r.corpo.ok === false);
    }

    // ── X19..X23 — terminais ──────────────────────────────────────
    const INDISPONIVEL = "A aprovação não está mais disponível para essa decisão.";
    {
      const TERMINAIS = ["ja_cancelada", "ja_consumida", "expirada", "tarefa_incompativel", "cancelada"];
      let i = 19;
      for (const codigo of TERMINAIS) {
        const r = await comCodigo(codigo, "aprovar");
        ok(`X${i} \`${codigo}\` e 409 com mensagem publica`,
          r.status === 409 && r.corpo.ok === false && r.corpo.erro === INDISPONIVEL);
        i += 1;
      }
    }

    // ── X24 — 404 indistinguivel ──────────────────────────────────
    {
      const r = await comCodigo("aprovacao_inexistente", "aprovar");
      ok("X24 `aprovacao_inexistente` e 404",
        r.status === 404 && r.corpo.ok === false &&
        r.corpo.erro === "Aprovação não encontrada.");
      ok("X24a e a mensagem NAO revela dono, existencia nem estado",
        !/dono|owner|outro|pertence|existe/i.test(String(r.corpo.erro)));
    }

    // ── X25..X26 — defesa em profundidade ─────────────────────────
    {
      let i = 25;
      for (const codigo of ["entrada_invalida", "decisao_invalida"]) {
        const r = await comCodigo(codigo, "aprovar");
        ok(`X${i} \`${codigo}\` vindo do D4 e 400`,
          r.status === 400 && r.corpo.erro === ENTRADA);
        i += 1;
      }
    }

    // ── X27..X29 — falha fecha ────────────────────────────────────
    {
      const r = await comCodigo("falha_persistencia", "aprovar");
      ok("X27 `falha_persistencia` e 503, nunca 200",
        r.status === 503 && r.corpo.ok === false &&
        r.corpo.erro === "Não foi possível registrar a decisão.");
    }
    {
      // Erro de transporte: o wrapper o traduz para `falha_persistencia`, e
      // o SQLSTATE 55000 das invariantes da RPC chega por aqui.
      respostaRpc = {
        data: null,
        error: {
          code: "55000",
          message: "aprovacao_decidir: aprovar X afetou 2 linhas sob lock",
          details: "detalhe interno",
          hint: "dica interna",
        },
      };
      const r = await pedir({ decisao: "aprovar" }, { cookie: COOKIE_A });
      respostaRpc = RPC_PADRAO;
      const c = (await r.json()) as Record<string, unknown>;
      ok("X28 erro cru do banco vira 503 e NAO atravessa", r.status === 503);
      ok("X28a nem SQLSTATE, nem message, nem details, nem hint na resposta",
        !/55000|afetou|sob lock|detalhe interno|dica interna/i.test(JSON.stringify(c)));
    }
    {
      const r = await comCodigo("um_codigo_que_nao_existe", "aprovar");
      ok("X29 codigo nao inventariado cai no 503, nunca em sucesso",
        r.status === 503 && r.corpo.ok !== true);
    }

    // ── X30..X31 — forma e privacidade da resposta ────────────────
    {
      const r = await comCodigo("aprovada", "aprovar");
      ok("X30 o 200 tem EXATAMENTE ok/decisao/estado",
        Object.keys(r.corpo).sort().join(",") === "decisao,estado,ok");
      ok("X30a e nao carrega id, tarefa, agente nem argumentos",
        !/tarefaId|agenteId|funcaoId|user_id|argumentos|conexao/i.test(JSON.stringify(r.corpo)));
    }
    {
      respostaRpc = { data: "aprovada", error: null };
      const r = await pedir({ decisao: "aprovar" }, { cookie: COOKIE_A });
      respostaRpc = RPC_PADRAO;
      ok("X31 a resposta e no-store", r.headers.get("Cache-Control") === "no-store");
    }

    // ── X32..X36 — a FONTE: uma chamada, e nenhuma retomada ───────
    const DEC = semComentarios(ler("app/api/aprovacoes/[aprovacaoId]/decidir/route.ts"));
    ok("X32 a rota chama `decidirAprovacao` exatamente uma vez",
      (DEC.match(/(?<![.\w])decidirAprovacao\(/g) ?? []).length === 1 &&
      (DEC.match(/import \{ decidirAprovacao \}/g) ?? []).length === 1);
    ok("X33 e nao abre banco por conta propria",
      !/getSupabaseServidor|\.rpc\(|\.from\(|aprovacao_decidir/.test(DEC));
    ok("X34 ZERO Resume, Worker, Funcao ou Tool Call",
      !/executarRetomada|executarSlotRetomada|iniciarRetomadaAprovacao/.test(DEC) &&
      !/aprovacao_consumir_e_abrir|consumirAprovacaoEAbrir/.test(DEC) &&
      !/reivindicarProximaTarefa|executarTarefa|executarFuncao/.test(DEC) &&
      !/internal\/agentes\/worker/.test(DEC));
    ok("X35 so existe POST — nem GET, nem PATCH, nem PUT, nem DELETE",
      /export async function POST\(/.test(DEC) &&
      !/export async function (GET|PATCH|PUT|DELETE)\(/.test(DEC));
    ok("X36 a identidade vem SO de auth.uid",
      /auth\.uid/.test(DEC) && !/searchParams|headers\.get\("x-user/.test(DEC));
    ok("X36a e a rota e dinamica",
      /export const dynamic = "force-dynamic"/.test(DEC));
  }

  console.log(`\n══ ${passou} PASS / ${falhou} FAIL ══\n`);
  process.exitCode = falhou === 0 ? 0 : 1;
}

principal().catch((e) => {
  console.log(`  FAIL  excecao nao tratada — ${String(e).slice(0, 300)}`);
  process.exitCode = 1;
});
