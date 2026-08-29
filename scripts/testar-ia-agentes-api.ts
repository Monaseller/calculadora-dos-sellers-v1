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
      const gravada = {
        id: randomUUID(),
        ativo: true,
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

  console.log(`\n══ ${passou} PASS / ${falhou} FAIL ══\n`);
  process.exitCode = falhou === 0 ? 0 : 1;
}

principal().catch((e) => {
  console.log(`  FAIL  excecao nao tratada — ${String(e).slice(0, 300)}`);
  process.exitCode = 1;
});
