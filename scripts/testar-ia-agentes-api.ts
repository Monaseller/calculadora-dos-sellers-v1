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
  const op: Operacao = { tabela, tipo: "leitura", filtros: {} };
  let pendente: Record<string, unknown> | null = null;

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
    const encontradas = linhas.filter((l) =>
      Object.entries(op.filtros).every(([c, v]) => l[c] === v)
    );
    return { data: encontradas, error: null };
  };

  const b: Record<string, unknown> = {
    select() { return b; },
    eq(coluna: string, valor: unknown) { op.filtros[coluna] = valor; return b; },
    order() { return b; },
    insert(v: Record<string, unknown>) {
      op.tipo = "escrita";
      op.payload = v;
      pendente = v;
      return b;
    },
    update() { op.tipo = "escrita"; return b; },
    upsert() { op.tipo = "escrita"; return b; },
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
const clienteFake = {
  from: (t: string) => construtor(t),
  rpc: () => { rpcs++; return Promise.resolve({ data: null, error: null }); },
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
  ok("D4  TOTAL 1 leitura, zero escrita — a rota nao acrescenta consulta",
    leituras() === 1 && escritas() === 0, `${leituras()}/${escritas()}`);
  ok("D5  a leitura foi escopada ao dono da sessao",
    operacoes[0]?.filtros.user_id === USER_A, JSON.stringify(operacoes[0]?.filtros));
  ok("D6  nenhum agente de B aparece",
    bN.agentes.every((a: { nome: string }) => a.nome.startsWith("A-")));
  ok("D7  o inativo TAMBEM vem — a tela precisa poder reativa-lo",
    bN.agentes.some((a: { ativo: boolean }) => a.ativo === false));
  ok("D8  ordem preservada da capability, sem reordenar na rota",
    JSON.stringify(bN.agentes.map((a: { nome: string }) => a.nome)) ===
      JSON.stringify(["A-um", "A-dois-inativo"]));
  ok("D9  shape publico: exatamente 6 campos",
    bN.agentes.every((a: object) => JSON.stringify(Object.keys(a).sort()) === JSON.stringify(CAMPOS_PUBLICOS)),
    JSON.stringify(Object.keys(bN.agentes[0] ?? {}).sort()));
  ok("D10 user_id e atualizado_em NAO saem pela API",
    !/user_id|atualizado_em/.test(JSON.stringify(bN)));
  ok("D11 zero escrita em todo o GET", escritas() === 0 && rpcs === 0);

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

  console.log(`\n══ ${passou} PASS / ${falhou} FAIL ══\n`);
  process.exitCode = falhou === 0 ? 0 : 1;
}

principal().catch((e) => {
  console.log(`  FAIL  excecao nao tratada — ${String(e).slice(0, 300)}`);
  process.exitCode = 1;
});
