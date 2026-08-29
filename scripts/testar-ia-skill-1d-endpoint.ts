/**
 * CDS IA — SKILL-1D.endpoint-B. Suite do endpoint de diagnostico.
 *
 * O handler `GET` REAL e executado, e com ele o compositor real e o
 * pipeline inteiro por baixo: `resolverSkillsDoAgente`,
 * `resolverConexoesDoAgente` e `resolverFatosPermissoes` rodam de
 * verdade contra um cliente DUPLADO que registra cada leitura. A
 * autenticacao tambem e real — o cookie e assinado por
 * `emitirTokenSessao`, nunca por HMAC copiado a mao.
 *
 * ── O que esta suite existe para provar ─────────────────────────────
 *
 * Que a rota e um ADAPTER: autentica, valida, le o relogio e delega.
 * Duas propriedades sao travadas por numero, nao por observacao:
 *
 *   1. o QUERY BUDGET de dominio — a rota nao acrescenta consulta
 *      nenhuma, e 401/400 custam ZERO;
 *   2. o IDOR — sessao de A pedindo agente de B custa UMA consulta e
 *      devolve exatamente o mesmo 200 vazio de um agente inexistente.
 *
 * ── Ordem de import ─────────────────────────────────────────────────
 *
 * O compositor alcanca `funcoes/registry.ts`, que e server-only e chega
 * aos executores. O duplo de `Module.prototype.require` precisa estar
 * instalado ANTES de qualquer import de producao — por isso a rota entra
 * por `await import` dentro de `principal()`.
 *
 * Rodar:  npx tsx scripts/testar-ia-skill-1d-endpoint.ts
 * Sem rede, sem banco, sem `--confirmo`. `SESSION_SECRET` e sintetico e
 * definido aqui dentro.
 */
import "./_server-only-inerte";

import Module from "node:module";
import { readFileSync, existsSync, readdirSync } from "node:fs";
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
const ROTA_REL = "app/api/agentes/[agenteId]/diagnostico/route.ts";
const ler = (rel: string) => readFileSync(join(RAIZ, rel), "utf8");
const semComentarios = (f: string) =>
  f.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const CODIGO_ROTA = semComentarios(ler(ROTA_REL));

// ─── O duplo do cliente Supabase ──────────────────────────────────────

interface Chamada {
  tabela: string;
  filtros: Record<string, unknown>;
  inValores?: readonly unknown[];
  escrita: boolean;
}

interface Resposta {
  data?: unknown;
  error?: Record<string, unknown> | null;
}

let respostas: Resposta[] = [];
let chamadas: Chamada[] = [];
let consumidas = 0;

function roteiro(...rs: Resposta[]): void {
  respostas = rs;
  chamadas = [];
  consumidas = 0;
}

function construtor(tabela: string): unknown {
  const c: Chamada = { tabela, filtros: {}, escrita: false };
  const resolver = (fn: (v: { data: unknown; error: unknown }) => void) => {
    chamadas.push(c);
    const r = respostas[consumidas++];
    fn({ data: r?.data ?? null, error: r?.error ?? null });
  };
  const b: Record<string, unknown> = {
    select() { return b; },
    eq(coluna: string, valor: unknown) { c.filtros[coluna] = valor; return b; },
    in(_coluna: string, valores: readonly unknown[]) { c.inValores = valores; return b; },
    order() { return b; },
    insert() { c.escrita = true; return b; },
    update() { c.escrita = true; return b; },
    upsert() { c.escrita = true; return b; },
    delete() { c.escrita = true; return b; },
    maybeSingle() {
      return { then: (fn: (v: { data: unknown; error: unknown }) => void) => resolver(fn) };
    },
    then(fn: (v: { data: unknown; error: unknown }) => void) { resolver(fn); },
  };
  return b;
}

const clienteFake = {
  from: (t: string) => construtor(t),
  rpc: () => Promise.resolve({ data: null, error: null }),
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

/** Sintetico, com 32+ bytes — o minimo que `sessao-assinada` exige. */
const SEGREDO_TESTE = "segredo-sintetico-de-teste-1d-endpoint-0123456789";
process.env.SESSION_SECRET = SEGREDO_TESTE;

/** `uid` PRECISA ser uuid: `assinarSessao` recusa qualquer outra coisa. */
const USER_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const AGENTE = "11111111-2222-4333-8444-555555555555";
const AGENTE_DE_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const FUTURO = "2026-12-31T23:59:59.000Z";
const LOJA = "cccccccc-0000-4000-8000-cccccccccccc";

type Req = { plataforma: string; recurso: string; obrigatoria: boolean };

const manifesto = (id: string, requer?: { conexoes?: Req[] }) => ({
  formato: 1,
  id,
  nome: `Skill ${id}`,
  versao: "1.0.0",
  descricao: "Fixture do endpoint.",
  quando_usar: ["quando o teste pedir"],
  origem: "importada",
  ...(requer ? { requer } : {}),
});

const assoc = (skillId: string) => ({ skill_id: skillId, criado_em: "2026-08-01T00:00:00.000Z" });
const linhaSkill = (uuid: string, man: unknown) => ({ id: uuid, manifesto: man, corpo: "corpo" });
const linhaSelecao = (plataforma: string, recurso: string) =>
  ({ agente_id: AGENTE, user_id: USER_A, plataforma, recurso, loja_id: LOJA });
const linhaLojaDona = () => ({ id: LOJA, user_id: USER_A });
const loja = () => ({
  id: LOJA, marketplace: "Shopee", ativo: true,
  access_token: "token-sintetico-nunca-deve-vazar", token_expires_at: FUTURO,
});

/** Uma requisicao como o Next entrega ao handler. */
function requisicao(cookie?: string, url = "http://localhost/api/agentes/x/diagnostico"): Request {
  return new Request(url, {
    method: "GET",
    headers: cookie ? { cookie } : {},
  });
}

const tabelas = () => chamadas.map((c) => c.tabela).join(" > ");

console.log("\n══ CDS IA — SKILL-1D.endpoint-B: endpoint de diagnostico ══");

// ─── A. Fronteira estatica da rota ────────────────────────────────────

secao("A. A rota e um adapter — e so isso");

ok("A1  o path autorizado existe no disco", existsSync(join(RAIZ, ROTA_REL)));
ok("A2  exporta GET e mais nenhum verbo",
  /export async function GET\(/.test(CODIGO_ROTA) &&
    !/export async function (POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\(/.test(CODIGO_ROTA));
ok("A3  declara force-dynamic",
  /export const dynamic = "force-dynamic"/.test(CODIGO_ROTA));
ok("A4  nao declara runtime Edge", !/runtime\s*=\s*"edge"/.test(CODIGO_ROTA));
ok("A5  zero Supabase direto",
  !/getSupabaseServidor|createClient|\.from\(|\.select\(|\.eq\(|supabase/i.test(CODIGO_ROTA));
ok("A6  zero resolver inferior — so o compositor",
  !/resolverSkillsDoAgente|resolverConexoesDoAgente|resolverFatosPermissoes|diagnosticarSkill|funcaoExiste/
    .test(CODIGO_ROTA));
ok("A7  zero nome de tabela — nenhuma consulta manual de propriedade",
  !/"agentes"|"skills"|"lojas"|"agente_skills"|"agente_permissoes"|"agente_conexoes"/.test(CODIGO_ROTA));
ok("A8  zero write",
  !/\.insert\(|\.update\(|\.upsert\(|\.delete\(|\.rpc\(/.test(CODIGO_ROTA));
ok("A9  zero leitura de corpo", !/request\.json\(|request\.formData\(|request\.text\(/.test(CODIGO_ROTA));
ok("A10 zero token/credencial",
  !/access_token|refresh_token|partner_key|service_role|x-worker-secret/.test(CODIGO_ROTA));
ok("A11 nao serializa a sessao nem o motivo da recusa",
  !/auth\.motivo|motivo:|uid:|cookie:/.test(CODIGO_ROTA));
ok("A12 zero logging", !/console\.(log|error|warn|info)/.test(CODIGO_ROTA));
ok("A13 o relogio e do servidor",
  /const agoraMs = Date\.now\(\)/.test(CODIGO_ROTA));
// Sem lookahead: `agoraMs\s*=\s*(?!Date)` casaria por backtracking — o
// `\s*` final aceita vazio e o lookahead passa no espaco antes de `Date`.
// Contar as atribuicoes e exato, e nao depende de como o motor recua.
ok("A14 nao le agoraMs de URL, header ou corpo",
  !/searchParams|nextUrl|new URL\(/.test(CODIGO_ROTA) &&
    (CODIGO_ROTA.match(/agoraMs\s*=/g) ?? []).length === 1);
ok("A15 o userId vem de auth.uid, e de lugar nenhum mais",
  /userId:\s*auth\.uid/.test(CODIGO_ROTA) &&
    (CODIGO_ROTA.match(/userId/g) ?? []).length === 1);
ok("A16 valida o agenteId como uuid antes de delegar",
  /UUID_REGEX\.test\(agenteId\)/.test(CODIGO_ROTA) &&
    CODIGO_ROTA.indexOf("UUID_REGEX.test") < CODIGO_ROTA.indexOf("diagnosticarAgente({"));
ok("A17 ha catch boundary", /}\s*catch\b/.test(CODIGO_ROTA));
ok("A18 params NAO e tratado como Promise (Next 14)",
  !/await params|params:\s*Promise/.test(CODIGO_ROTA));
ok("A19 CONTROLE: as sondas acusam quando o padrao existe",
  /\.from\(/.test('x.from("t")') && /console\.log/.test("console.log(1)"));

// ─── B–H. Comportamento real ──────────────────────────────────────────

async function principal(): Promise<void> {
  const { GET } = await import("../app/api/agentes/[agenteId]/diagnostico/route");
  const { emitirTokenSessao, COOKIE_SESSAO } = await import("../lib/autenticacao");

  const { token } = await emitirTokenSessao(USER_A);
  const COOKIE_VALIDO = `${COOKIE_SESSAO}=${token}`;

  const chamar = async (cookie: string | undefined, agenteId: string, url?: string) =>
    GET(requisicao(cookie, url), { params: { agenteId } });

  secao("B. O instrumento de medida esta instalado");

  ok("B1  ANCORA: o duplo interceptou o cliente Supabase", interceptou);
  const carregados = Object.keys(require.cache).map((p) => p.replace(/\\/g, "/"));
  ok("B2  ANCORA: a rota real esta no grafo",
    carregados.some((p) => p.includes("/app/api/agentes/[agenteId]/diagnostico/route.ts")));
  ok("B3  ANCORA: o compositor real foi carregado junto",
    carregados.some((p) => p.includes("/lib/agentes/diagnostico/compositor.ts")));
  ok("B4  nenhum cliente Supabase real carregado",
    !carregados.some((p) => /@supabase|supabase-servidor/.test(p)));
  ok("B5  ANCORA: o cookie de teste foi emitido pela camada real",
    token.length > 0 && token.split(".").length >= 2);

  // ── C. Autenticacao ────────────────────────────────────────────────

  secao("C. Sem sessao valida nao ha dominio");

  roteiro();
  const rSemCookie = await chamar(undefined, AGENTE);
  const bSemCookie = await rSemCookie.json();
  ok("C1  sem cookie -> 401", rSemCookie.status === 401, String(rSemCookie.status));
  ok("C2  payload sanitizado, sem motivo nem uid",
    bSemCookie.ok === false && bSemCookie.erro === "Não autenticado." &&
      Object.keys(bSemCookie).length === 2,
    JSON.stringify(bSemCookie));
  ok("C3  e ZERO query de dominio", chamadas.length === 0, tabelas());

  roteiro();
  const rForjado = await chamar(`cds_session=nao.e.um.token.valido`, AGENTE);
  const bForjado = await rForjado.json();
  ok("C4  cookie forjado -> 401", rForjado.status === 401, String(rForjado.status));
  ok("C5  e nao revela token_invalido",
    !/token_invalido|sem_cookie|assinatura|hmac/i.test(JSON.stringify(bForjado)));
  ok("C6  e ZERO query de dominio", chamadas.length === 0, tabelas());

  // ── D. agenteId ────────────────────────────────────────────────────

  secao("D. O agenteId e validado na fronteira");

  for (const [nome, valor] of [
    ["D1  nao-uuid", "nao-e-uuid"],
    ["D2  uuid truncado", "11111111-2222-4333-8444"],
    ["D3  injecao", "' or 1=1 --"],
  ] as [string, string][]) {
    roteiro();
    const r = await chamar(COOKIE_VALIDO, valor);
    const b = await r.json();
    ok(`${nome} -> 400 + 0 query`,
      r.status === 400 && b.ok === false && b.erro === "agenteId inválido." &&
        chamadas.length === 0,
      `${r.status} / ${chamadas.length}`);
  }

  // ── E. Sucesso e query budget ──────────────────────────────────────

  secao("E. Sucesso, e o budget de dominio que a rota nao aumenta");

  roteiro({ data: [] });
  const rVazio = await chamar(COOKIE_VALIDO, AGENTE);
  const bVazio = await rVazio.json();
  ok("E1  agente sem Skills -> 200", rVazio.status === 200, String(rVazio.status));
  ok("E2  corpo completo e vazio",
    bVazio.ok === true && Array.isArray(bVazio.diagnosticos) && bVazio.diagnosticos.length === 0 &&
      Array.isArray(bVazio.semSelecao) && bVazio.semSelecao.length === 0 && bVazio.coleta === "ok",
    JSON.stringify(bVazio));
  ok("E3  TOTAL 1 query de dominio — a rota nao acrescenta nenhuma",
    chamadas.length === 1, `${chamadas.length} · ${tabelas()}`);
  ok("E4  e a leitura foi escopada ao dono da sessao",
    chamadas[0]?.filtros.user_id === USER_A && chamadas[0]?.filtros.agente_id === AGENTE,
    JSON.stringify(chamadas[0]?.filtros));

  const REQ: Req = { plataforma: "shopee", recurso: "chat", obrigatoria: true };
  const manConexao = manifesto("skill-c", { conexoes: [REQ] });
  roteiro(
    { data: [assoc("s1")] }, { data: [linhaSkill("s1", manConexao)] },
    { data: [assoc("s1")] }, { data: [linhaSkill("s1", manConexao)] },
    { data: [linhaSelecao("shopee", "chat")] },
    { data: [linhaLojaDona()] },
    { data: [loja()] }
  );
  const rCheio = await chamar(COOKIE_VALIDO, AGENTE);
  const bCheio = await rCheio.json();
  ok("E5  1 Skill com conexao selecionada -> 200", rCheio.status === 200);
  ok("E6  TOTAL 7 queries — o budget publicado do compositor, intacto",
    chamadas.length === 7, `${chamadas.length} · ${tabelas()}`);
  ok("E7  o diagnostico chega inteiro, sem mapping",
    bCheio.diagnosticos.length === 1 && bCheio.diagnosticos[0].skillId === "skill-c" &&
      bCheio.diagnosticos[0].versao === "1.0.0" &&
      typeof bCheio.diagnosticos[0].diagnostico?.estadoGeral === "string",
    JSON.stringify(bCheio.diagnosticos[0] ?? {}));
  ok("E8  zero credencial na resposta",
    !/token|secret|senha|credencial|user_id/i.test(JSON.stringify(bCheio)));

  // ── F. semSelecao ──────────────────────────────────────────────────

  secao("F. semSelecao atravessa sem ser reinterpretado");

  const manSemSelecao = manifesto("skill-s", { conexoes: [REQ] });
  roteiro(
    { data: [assoc("s1")] }, { data: [linhaSkill("s1", manSemSelecao)] },
    { data: [assoc("s1")] }, { data: [linhaSkill("s1", manSemSelecao)] },
    { data: [] }
  );
  const rSem = await chamar(COOKIE_VALIDO, AGENTE);
  const bSem = await rSem.json();
  ok("F1  requisito sem selecao -> 200 com semSelecao preenchido",
    rSem.status === 200 && bSem.semSelecao.length === 1 &&
      bSem.semSelecao[0].plataforma === "shopee" && bSem.semSelecao[0].recurso === "chat",
    JSON.stringify(bSem.semSelecao));
  ok("F2  zero FALTA_SELECAO — a rota nao inventa estado",
    !/FALTA_SELECAO/.test(JSON.stringify(bSem)) && !/FALTA_SELECAO/.test(CODIGO_ROTA));
  ok("F3  e o diagnostico continua dizendo FALTA_CONEXAO",
    bSem.diagnosticos[0]?.diagnostico.bloqueios[0]?.estado === "FALTA_CONEXAO",
    JSON.stringify(bSem.diagnosticos[0]?.diagnostico.bloqueios ?? []));

  // ── G. IDOR ────────────────────────────────────────────────────────

  secao("G. Agente de outro dono e agente inexistente sao a MESMA resposta");

  roteiro({ data: [] });
  const rIdor = await chamar(COOKIE_VALIDO, AGENTE_DE_B);
  const bIdor = await rIdor.json();
  ok("G1  sessao de A + agente de B -> 200 vazio", rIdor.status === 200 && bIdor.ok === true);
  ok("G2  nada de B no corpo",
    bIdor.diagnosticos.length === 0 && bIdor.semSelecao.length === 0 && bIdor.coleta === "ok",
    JSON.stringify(bIdor));
  ok("G3  custa 1 query — nenhuma consulta extra de propriedade",
    chamadas.length === 1, `${chamadas.length} · ${tabelas()}`);
  ok("G4  e a leitura levou o user da SESSAO, nao o dono do agente",
    chamadas[0]?.filtros.user_id === USER_A);
  ok("G5  indistinguivel do agente inexistente — nem 403 nem 404",
    rIdor.status === rVazio.status && JSON.stringify(bIdor) === JSON.stringify(bVazio));

  // ── H. Falha e cache ───────────────────────────────────────────────

  secao("H. Falha sanitizada, e nada disso pode ser cacheado");

  roteiro({ error: { message: "connection refused para postgres://user:senha@host/db", hint: "verifique a rede", details: "linha 42" } });
  const rFalha = await chamar(COOKIE_VALIDO, AGENTE);
  const bFalha = await rFalha.json();
  ok("H1  falha de leitura -> 500", rFalha.status === 500, String(rFalha.status));
  ok("H2  frase fixa, sem detalhe interno",
    bFalha.ok === false && bFalha.erro === "Falha ao obter o diagnóstico." &&
      Object.keys(bFalha).length === 2,
    JSON.stringify(bFalha));
  ok("H3  zero vazamento do erro do driver",
    !/connection refused|postgres:\/\/|senha|hint|details|linha 42/i.test(JSON.stringify(bFalha)));
  ok("H4  falha NAO vira 200 vazio", rFalha.status !== 200);

  ok("H5  sucesso responde no-store", rVazio.headers.get("cache-control") === "no-store");
  ok("H6  401 tambem responde no-store", rSemCookie.headers.get("cache-control") === "no-store");
  ok("H7  400 e 500 tambem", rFalha.headers.get("cache-control") === "no-store");

  ok("H8  nenhuma escrita foi tentada em todo o pipeline",
    chamadas.every((c) => !c.escrita));

  // Segredo ausente: `autenticarRequisicao` LANCA, e o catch responde.
  const segredoOriginal = process.env.SESSION_SECRET;
  try {
    delete process.env.SESSION_SECRET;
    roteiro();
    const rSemSegredo = await chamar(COOKIE_VALIDO, AGENTE);
    const bSemSegredo = await rSemSegredo.json();
    ok("H9  SESSION_SECRET ausente -> 500 sanitizado, sem stack",
      rSemSegredo.status === 500 && bSemSegredo.erro === "Falha ao obter o diagnóstico." &&
        !/SESSION_SECRET|Erro|at \w+ \(/.test(JSON.stringify(bSemSegredo)),
      JSON.stringify(bSemSegredo));
    ok("H10 e ZERO query de dominio", chamadas.length === 0, tabelas());
  } finally {
    process.env.SESSION_SECRET = segredoOriginal;
  }

  // ── I. Fronteira da fase ───────────────────────────────────────────

  secao("I. Uma exposicao HTTP, e nenhuma UI");

  const rotas: string[] = [];
  const varrer = (dir: string): void => {
    for (const e of readdirSync(join(RAIZ, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) { if (!/node_modules|\.next/.test(e.name)) varrer(rel); }
      else if (e.name === "route.ts" && /diagnosticarAgente/.test(semComentarios(ler(rel)))) {
        rotas.push(rel);
      }
    }
  };
  varrer("app");
  ok("I1  exatamente UMA rota expoe o compositor",
    JSON.stringify(rotas) === JSON.stringify([ROTA_REL]), rotas.join(", "));

  const clientes: string[] = [];
  const varrerUi = (dir: string): void => {
    for (const e of readdirSync(join(RAIZ, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) { if (!/node_modules|\.next/.test(e.name)) varrerUi(rel); }
      else if (/\.tsx$/.test(e.name) && /diagnosticarAgente|\/diagnostico/.test(semComentarios(ler(rel)))) {
        clientes.push(rel);
      }
    }
  };
  varrerUi("app");
  ok("I2  nenhuma UI consome o endpoint nesta frente", clientes.length === 0, clientes.join(", "));
  ok("I3  ANCORA: a varredura leu rotas de verdade",
    existsSync(join(RAIZ, "app/api/internal/agentes/executar/route.ts")));
  ok("I4  CONTROLE: uma segunda rota reprovaria",
    JSON.stringify([ROTA_REL, "app/api/outra/route.ts"]) !== JSON.stringify([ROTA_REL]));

  console.log(`\n══ ${passou} PASS / ${falhou} FAIL ══\n`);
  process.exitCode = falhou === 0 ? 0 : 1;
}

principal().catch((e) => {
  console.log(`  FAIL  excecao nao tratada — ${String(e).slice(0, 300)}`);
  process.exitCode = 1;
});
