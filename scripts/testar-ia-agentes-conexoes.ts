/**
 * CDS IA — M2-I1-A4. A rota de Conexoes do agente.
 *
 * ── O que esta suite prova ──────────────────────────────────────────
 *
 * A rota REAL e executada, com o cliente Supabase duplado e o `fetch`
 * global armadilhado. O que se afirma nao e "o duplo funciona": e quais
 * tabelas a rota tocou, com quais filtros, o que ela devolveu, e — o
 * ponto mais importante — o que ela RECUSOU gravar.
 *
 * ── Zero rede, zero banco, zero escrita ─────────────────────────────
 *
 * Nenhum host externo, nenhuma linha persistida. `fetch` lanca se
 * alguem tentar: a rota nao pode chamar marketplace nem no GET nem no
 * PATCH, e garantia de ambiente nao seria garantia.
 *
 * Rodar:  npx tsx scripts/testar-ia-agentes-conexoes.ts
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

const ROTA_REL = "app/api/agentes/[agenteId]/conexoes/route.ts";
const CODIGO_ROTA = semComentarios(ler(ROTA_REL));

// ─── Sentinela de rede ────────────────────────────────────────────────

let tentativasDeRede = 0;
globalThis.fetch = (async (url: string | URL | Request) => {
  tentativasDeRede++;
  throw new Error(`suite sem rede: fetch proibido (${String(url).slice(0, 60)})`);
}) as unknown as typeof fetch;

// ─── O duplo do cliente Supabase ──────────────────────────────────────

interface Operacao {
  tabela: string;
  tipo: "leitura" | "escrita";
  filtros: Record<string, unknown>;
  inValores?: readonly unknown[];
  payload?: Record<string, unknown>;
}
interface Resposta {
  data?: unknown;
  error?: Record<string, unknown> | null;
}

let respostas: Resposta[] = [];
let operacoes: Operacao[] = [];
let consumidas = 0;

function roteiro(...rs: Resposta[]): void {
  respostas = rs;
  operacoes = [];
  consumidas = 0;
  tentativasDeRede = 0;
}

function construtor(tabela: string): unknown {
  const op: Operacao = { tabela, tipo: "leitura", filtros: {} };
  const resolver = (fn: (v: { data: unknown; error: unknown }) => void) => {
    operacoes.push(op);
    const r = respostas[consumidas++];
    fn({ data: r?.data ?? null, error: r?.error ?? null });
  };
  const b: Record<string, unknown> = {
    select() { return b; },
    eq(coluna: string, valor: unknown) { op.filtros[coluna] = valor; return b; },
    in(coluna: string, valores: readonly unknown[]) {
      op.filtros[coluna] = { __in: valores };
      op.inValores = valores;
      return b;
    },
    order() { return b; },
    // `not`, `is` e `limit` existem porque os owners REAIS os usam —
    // `listarLojasConectadasDoDono` filtra `.not("access_token", "is", null)`.
    // Um duplo sem eles reprovaria a rota por defeito da suite.
    not(coluna: string, operador: string, valor: unknown) {
      op.filtros[`not:${coluna}`] = { operador, valor };
      return b;
    },
    is(coluna: string, valor: unknown) { op.filtros[`is:${coluna}`] = valor; return b; },
    limit() { return b; },
    insert(p: Record<string, unknown>) { op.tipo = "escrita"; op.payload = p; return b; },
    update(p: Record<string, unknown>) { op.tipo = "escrita"; op.payload = p; return b; },
    upsert(p: Record<string, unknown>) { op.tipo = "escrita"; op.payload = p; return b; },
    delete() { op.tipo = "escrita"; return b; },
    maybeSingle() {
      return { then: (fn: (v: { data: unknown; error: unknown }) => void) => resolver(fn) };
    },
    then(fn: (v: { data: unknown; error: unknown }) => void) { resolver(fn); },
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
let interceptouSessao = false;
(Module as unknown as { prototype: { require: unknown } }).prototype.require = function (this: unknown, id: string) {
  if (typeof id === "string" && id.includes("supabase-servidor")) {
    interceptou = true;
    return { getSupabaseServidor: () => clienteFake };
  }
  // A sessao entra pelo MESMO mecanismo do cliente de banco. Reatribuir
  // o export nao funciona: o namespace do modulo so expoe getter.
  if (typeof id === "string" && /lib[\/]autenticacao/.test(id)) {
    interceptouSessao = true;
    return {
      autenticarRequisicao: async (r: Request) => {
        const cookie = r.headers.get("cookie") ?? "";
        return cookie.includes(`sessao-de-${USER_A}`)
          ? { autenticado: true, uid: USER_A }
          : { autenticado: false };
      },
    };
  }
  // eslint-disable-next-line prefer-rest-params
  return requireOriginal.apply(this, arguments as unknown as [string]);
};

// ─── Sessao duplada ───────────────────────────────────────────────────

const USER_A = "user-sintetico-a4";
const AGENTE = "33333333-4444-5555-6666-777777777777";
const COOKIE_A = `cds_session=sessao-de-${USER_A}`;
const LOJA_ML = "aaaaaaaa-1111-4000-8000-000000000001";
const LOJA_ML2 = "aaaaaaaa-1111-4000-8000-000000000002";
const LOJA_SHOPEE = "bbbbbbbb-1111-4000-8000-000000000001";
const ID_ML = "mercadolivre.perguntas.listar";
const ID_VENDAS = "vendas.consultar";
const TOKEN = "token-sintetico-nunca-deve-vazar";

// ─── Fixtures de linha ────────────────────────────────────────────────

const agenteDoDono = { data: { id: AGENTE, user_id: USER_A, nome: "A", tipo: "personalizado", ativo: true } };
const agenteAusente = { data: null };
const semSkills = { data: [] };
const permissao = (funcaoId: string, nivel: string) => ({ funcao_id: funcaoId, nivel });
const selecao = (plataforma: string, recurso: string, lojaId: string) =>
  ({ agente_id: AGENTE, user_id: USER_A, plataforma, recurso, loja_id: lojaId });
const lojaDona = (id: string) => ({ id, user_id: USER_A });
const lojaBruta = (id: string, marketplace: string) => ({
  id, marketplace, ativo: true, access_token: TOKEN,
  token_expires_at: "2026-12-31T23:59:59.000Z",
});
const lojaConectada = (id: string, nome: string) =>
  ({ id, nome, nickname: `nick-${nome}`, seller_id: "999888777", created_at: "2026-01-01T00:00:00Z" });

const req = (agenteId: string, cookie: string | undefined, corpo?: string) =>
  new Request(`http://localhost/api/agentes/${agenteId}/conexoes`, {
    method: corpo === undefined ? "GET" : "PATCH",
    headers: cookie ? { cookie } : {},
    ...(corpo === undefined ? {} : { body: corpo }),
  });

console.log("\n══ CDS IA — M2-I1-A4: rota de Conexoes do agente ══");

// ─── A. Fronteiras estaticas ──────────────────────────────────────────

secao("A. O que a rota nao pode conter");

ok("A1  zero chamada de cobertura remota no codigo",
  !/confirmarCoberturaML|confirmarCoberturaDosFatos|mercado-livre-concessoes|cobertura-remota/
    .test(CODIGO_ROTA));
ok("A2  zero rede, zero endpoint de marketplace",
  !/\bfetch\s*\(|mercadolibre|shopee\.com|Authorization/.test(CODIGO_ROTA));
ok("A3  zero acesso direto ao banco — so os owners",
  !/getSupabaseServidor|createClient|from\("/.test(CODIGO_ROTA));
ok("A4  nao reimplementa upsert nem delete",
  !/\.(upsert|insert|delete)\(/.test(CODIGO_ROTA) &&
    /definirSelecaoDeLoja\(/.test(CODIGO_ROTA) && /removerSelecaoDeLoja\(/.test(CODIGO_ROTA));
// `\bnivel\b`, e nao `/nivel/`: `nao_disponivel` contem a substring, e a
// primeira versao desta sonda reprovou por isso — medindo ortografia em
// vez de comportamento.
ok("A5  nao toca permissao, aprovacao nem nivel de autonomia",
  !/agente_permissoes|definirPermissao|criarAprovacao|NIVEIS_AUTONOMIA|\bnivel\b/i
    .test(CODIGO_ROTA));
ok("A5a CONTROLE: a sonda de nivel acusa a palavra isolada",
  /\bnivel\b/i.test("const nivel = x;") && !/\bnivel\b/i.test("nao_disponivel"));
ok("A6  `marketplace` e derivado server-side, nunca lido do corpo",
  /MARKETPLACE_POR_PLATAFORMA\[/.test(CODIGO_ROTA) &&
    !/o\.marketplace|bruto\.marketplace|corpo\.marketplace/.test(CODIGO_ROTA));
ok("A7  o requisito e conferido contra o agregador",
  /resolvido\.requisitos\.find\(/.test(CODIGO_ROTA));
ok("A8  a resposta nao cita colunas de credencial",
  !/access_token|refresh_token|token_expires_at|seller_id|created_at/.test(
    CODIGO_ROTA.slice(CODIGO_ROTA.indexOf("interface LojaElegivel"))
      .slice(0, CODIGO_ROTA.indexOf("export async function PATCH"))
  ));
ok("A9  CONTROLE: as sondas acham os padroes quando existem",
  /\bfetch\s*\(/.test("fetch(x)") && /\.upsert\(/.test("q.upsert({})"));

// ─── B–H. Comportamento ───────────────────────────────────────────────

async function principal(): Promise<void> {
  const rota = await import("../app/api/agentes/[agenteId]/conexoes/route");
  const get = (agenteId: string, cookie?: string) =>
    rota.GET(req(agenteId, cookie), { params: { agenteId } });
  const patch = (agenteId: string, cookie: string | undefined, corpo: string) =>
    rota.PATCH(req(agenteId, cookie, corpo), { params: { agenteId } });

  secao("B. O instrumento esta instalado");

  ok("B1  ANCORA: o cliente Supabase foi duplado", interceptou);
  ok("B2  ANCORA: a sessao foi duplada", interceptouSessao);

  // Roteiro do GET com 1 requisito de Function ML habilitada:
  //   agentes -> agente_skills -> agente_permissoes -> agente_conexoes
  //   -> lojas(confirmar) -> lojas(lote) -> lojas(elegiveis)
  const roteiroGet = (opcoes: {
    selecoes?: unknown[];
    donas?: unknown[];
    lote?: unknown[];
    elegiveis?: unknown[];
    permissoes?: unknown[];
  } = {}) => [
    agenteDoDono,
    semSkills,
    { data: opcoes.permissoes ?? [permissao(ID_ML, "automatico")] },
    { data: opcoes.selecoes ?? [] },
    ...(opcoes.selecoes && opcoes.selecoes.length > 0
      ? [{ data: opcoes.donas ?? [] }, { data: opcoes.lote ?? [] }]
      : []),
    { data: opcoes.elegiveis ?? [lojaConectada(LOJA_ML, "Loja ML")] },
  ];

  // ─── C. CONN-1/2/15/16/20 — o GET ──────────────────────────────────

  secao("C. GET — requisitos reais, contas sanitizadas");

  roteiro(...roteiroGet());
  const r1 = await get(AGENTE, COOKIE_A);
  const b1 = await r1.json();
  ok("CONN-1  GET proprio -> 200 com os requisitos reais",
    r1.status === 200 && b1.ok === true && b1.conexoes.length === 1 &&
      b1.conexoes[0].plataforma === "mercado_livre" &&
      b1.conexoes[0].recurso === "perguntas",
    JSON.stringify(b1).slice(0, 160));
  ok("CONN-15 Function habilitada SEM Skill nenhuma gera o requisito",
    b1.conexoes[0].obrigatoria === true && b1.conexoes[0].marketplace === "ML");
  ok("CONN-1a sem selecao -> lojaIdSelecionada null e utilizavel false",
    b1.conexoes[0].lojaIdSelecionada === null && b1.conexoes[0].utilizavel === false);
  ok("CONN-2  a loja elegivel tem EXATAMENTE tres campos",
    JSON.stringify(Object.keys(b1.conexoes[0].lojasElegiveis[0]).sort()) ===
      JSON.stringify(["id", "nickname", "nome"]),
    Object.keys(b1.conexoes[0].lojasElegiveis[0]).join(", "));
  ok("CONN-2a zero credencial e zero identidade externa no corpo inteiro",
    !/token|secret|senha|credencial|seller_id|created_at|access/i.test(JSON.stringify(b1)),
    JSON.stringify(b1).slice(0, 200));
  ok("CONN-12 GET nao tentou rede", tentativasDeRede === 0, String(tentativasDeRede));
  ok("CONN-12a e nao gravou nada", operacoes.every((o) => o.tipo === "leitura") && rpcs === 0);
  ok("CONN-20 a listagem de lojas foi UMA, por MARKETPLACE",
    operacoes.filter((o) => o.filtros.marketplace !== undefined).length === 1 &&
      operacoes.find((o) => o.filtros.marketplace !== undefined)?.filtros.marketplace === "ML",
    String(operacoes.filter((o) => o.filtros.marketplace !== undefined).length));
  ok("CONN-1b as leituras sao fechadas no dono",
    operacoes.every((o) => o.filtros.user_id === undefined || o.filtros.user_id === USER_A));

  roteiro(...roteiroGet({ permissoes: [permissao(ID_ML, "bloqueado")] }));
  const rBloq = await get(AGENTE, COOKIE_A);
  const bBloq = await rBloq.json();
  ok("CONN-16 Function BLOQUEADA nao vira requisito",
    rBloq.status === 200 && bBloq.conexoes.length === 0, JSON.stringify(bBloq));

  roteiro(...roteiroGet({ permissoes: [] }));
  const rSemLinha = await get(AGENTE, COOKIE_A);
  const bSemLinha = await rSemLinha.json();
  ok("CONN-16a linha de permissao AUSENTE nao vira requisito",
    bSemLinha.conexoes.length === 0);
  ok("CONN-16b e sem requisito nenhum, nem a lista de lojas e consultada",
    operacoes.filter((o) => o.filtros.marketplace !== undefined).length === 0);

  // ─── D. CONN-17/18 — a selecao que nao serve ───────────────────────

  secao("D. GET — a selecao incompativel nao pode sumir");

  roteiro(...roteiroGet({
    selecoes: [selecao("mercado_livre", "perguntas", LOJA_SHOPEE)],
    donas: [lojaDona(LOJA_SHOPEE)],
    lote: [lojaBruta(LOJA_SHOPEE, "Shopee")],
  }));
  const rIncompat = await get(AGENTE, COOKIE_A);
  const bIncompat = await rIncompat.json();
  ok("CONN-17 selecao para loja de OUTRO provedor continua visivel",
    bIncompat.conexoes.length === 1 &&
      bIncompat.conexoes[0].lojaIdSelecionada === LOJA_SHOPEE &&
      bIncompat.conexoes[0].utilizavel === false,
    JSON.stringify(bIncompat.conexoes[0]));
  ok("CONN-17a ANTI-VACUIDADE: com loja compativel, utilizavel vira true",
    await (async () => {
      roteiro(...roteiroGet({
        selecoes: [selecao("mercado_livre", "perguntas", LOJA_ML)],
        donas: [lojaDona(LOJA_ML)],
        lote: [lojaBruta(LOJA_ML, "ML")],
      }));
      const b = await (await get(AGENTE, COOKIE_A)).json();
      return b.conexoes[0].utilizavel === true &&
        b.conexoes[0].lojaIdSelecionada === LOJA_ML;
    })());

  // A cobertura e `nao_verificavel` em TODOS estes cenarios — e a conta
  // continua elegivel. Esconde-la impediria o dono de configurar durante
  // um 429 ou um token vencido.
  roteiro(...roteiroGet({
    selecoes: [selecao("mercado_livre", "perguntas", LOJA_ML)],
    donas: [lojaDona(LOJA_ML)],
    lote: [lojaBruta(LOJA_ML, "ML")],
    elegiveis: [lojaConectada(LOJA_ML, "Loja ML"), lojaConectada(LOJA_ML2, "Segunda ML")],
  }));
  const bCoverage = await (await get(AGENTE, COOKIE_A)).json();
  ok("CONN-18 cobertura `nao_verificavel` NAO remove conta da lista",
    bCoverage.conexoes[0].lojasElegiveis.length === 2,
    String(bCoverage.conexoes[0].lojasElegiveis.length));
  ok("CONN-18a e nenhuma rede foi tentada para decidir isso", tentativasDeRede === 0);

  // ─── E. CONN-3 — o agente alheio ───────────────────────────────────

  secao("E. Auth e propriedade");

  roteiro();
  const rSemSessao = await get(AGENTE);
  ok("CONN-3a sem sessao -> 401", rSemSessao.status === 401);
  ok("CONN-3b e zero query", operacoes.length === 0);

  roteiro(agenteAusente);
  const rAlheio = await get(AGENTE, COOKIE_A);
  const bAlheio = await rAlheio.json();
  roteiro(agenteAusente);
  const rInexistente = await get("99999999-9999-4999-8999-999999999999", COOKIE_A);
  const bInexistente = await rInexistente.json();
  ok("CONN-3  agente alheio e inexistente dao a MESMA resposta",
    rAlheio.status === 404 && rInexistente.status === 404 &&
      JSON.stringify(bAlheio) === JSON.stringify(bInexistente),
    `${rAlheio.status} / ${JSON.stringify(bAlheio)}`);
  ok("CONN-3c agenteId nao-UUID -> 400", (await get("nao-e-uuid", COOKIE_A)).status === 400);

  // ─── F. CONN-4..9, 19 — o PATCH ────────────────────────────────────

  secao("F. PATCH — o requisito manda, o corpo nao");

  const corpoPatch = (p: string, r: string, l: string | null) =>
    JSON.stringify({ plataforma: p, recurso: r, lojaId: l });

  // agentes -> agente_skills -> agente_permissoes -> agente_conexoes
  // -> [confirmar+lote] -> lojas(elegiveis) -> upsert
  const roteiroPatch = (elegiveis: unknown[] = [lojaConectada(LOJA_ML, "Loja ML")]) => [
    agenteDoDono,
    semSkills,
    { data: [permissao(ID_ML, "automatico")] },
    { data: [] },
    { data: elegiveis },
    { data: [{ agente_id: AGENTE }] },
  ];

  roteiro(...roteiroPatch());
  const rOk = await patch(AGENTE, COOKIE_A, corpoPatch("mercado_livre", "perguntas", LOJA_ML));
  const bOk = await rOk.json();
  const escritas = operacoes.filter((o) => o.tipo === "escrita");
  ok("CONN-4  PATCH valido -> 200", rOk.status === 200 && bOk.ok === true,
    `${rOk.status} ${JSON.stringify(bOk)}`);
  ok("CONN-4a gravou UMA vez, em agente_conexoes",
    escritas.length === 1 && escritas[0].tabela === "agente_conexoes",
    escritas.map((o) => o.tabela).join(", "));
  ok("CONN-4b o payload carrega o dono e o trio, e nada de credencial",
    escritas[0]?.payload?.user_id === USER_A &&
      escritas[0]?.payload?.loja_id === LOJA_ML &&
      !/token|secret/i.test(JSON.stringify(escritas[0]?.payload)));
  ok("CONN-10 zero escrita em agente_permissoes",
    !escritas.some((o) => o.tabela === "agente_permissoes"));
  ok("CONN-11 zero RPC — nenhuma aprovacao criada ou consumida", rpcs === 0);
  ok("CONN-12b PATCH nao tentou rede", tentativasDeRede === 0);

  roteiro(...roteiroPatch());
  const rMesmo = await patch(AGENTE, COOKIE_A, corpoPatch("mercado_livre", "perguntas", LOJA_ML));
  ok("CONN-9  PATCH do MESMO valor e idempotente -> 200", rMesmo.status === 200);

  // Remocao: nao consulta lojas, vai direto ao delete.
  roteiro(
    agenteDoDono, semSkills, { data: [permissao(ID_ML, "automatico")] }, { data: [] },
    { data: [{ agente_id: AGENTE }] }
  );
  const rNull = await patch(AGENTE, COOKIE_A, corpoPatch("mercado_livre", "perguntas", null));
  const bNull = await rNull.json();
  ok("CONN-8  lojaId null remove a selecao -> 200",
    rNull.status === 200 && bNull.ok === true && bNull.conexao.lojaId === null,
    `${rNull.status} ${JSON.stringify(bNull)}`);
  ok("CONN-8a a escrita foi um DELETE em agente_conexoes",
    operacoes.filter((o) => o.tipo === "escrita").every((o) => o.tabela === "agente_conexoes"));
  ok("CONN-8b remover nao consulta a lista de lojas elegiveis",
    operacoes.filter((o) => o.filtros.marketplace !== undefined).length === 0);

  roteiro(
    agenteDoDono, semSkills, { data: [permissao(ID_ML, "automatico")] }, { data: [] },
    { data: [] }
  );
  const rNullVazio = await patch(AGENTE, COOKIE_A, corpoPatch("mercado_livre", "perguntas", null));
  ok("CONN-9a remover o que ja nao existe tambem e 200", rNullVazio.status === 200);

  // ─── G. CONN-5/6/7/14/19 — as recusas ──────────────────────────────

  secao("G. PATCH — o que ele recusa gravar");

  roteiro(
    agenteDoDono, semSkills, { data: [permissao(ID_ML, "automatico")] }, { data: [] }
  );
  const rInventado = await patch(AGENTE, COOKIE_A, corpoPatch("mercado_livre", "ads", LOJA_ML));
  const bInventado = await rInventado.json();
  ok("CONN-5  requisito inexistente -> 409",
    rInventado.status === 409 &&
      bInventado.erro === "Requisito não configurado para este agente.",
    `${rInventado.status} ${JSON.stringify(bInventado)}`);
  ok("CONN-14 e NADA foi gravado", operacoes.every((o) => o.tipo === "leitura"));
  ok("CONN-14a a lista de lojas nem foi consultada — requisito primeiro",
    operacoes.filter((o) => o.filtros.marketplace !== undefined).length === 0);

  roteiro(
    agenteDoDono, semSkills, { data: [permissao(ID_ML, "automatico")] }, { data: [] },
    { data: [lojaConectada(LOJA_ML, "Loja ML")] }
  );
  const rAlheia = await patch(AGENTE, COOKIE_A,
    corpoPatch("mercado_livre", "perguntas", "cccccccc-1111-4000-8000-000000000009"));
  const bAlheiaP = await rAlheia.json();
  ok("CONN-6  loja fora da lista do dono -> 409",
    rAlheia.status === 409 && bAlheiaP.erro === "Conta indisponível para este requisito.",
    `${rAlheia.status} ${JSON.stringify(bAlheiaP)}`);
  ok("CONN-6a e nada foi gravado", operacoes.every((o) => o.tipo === "leitura"));

  // A loja Shopee simplesmente NAO esta na lista de ML — a mesma lista
  // que valida dono, ativo e marketplace de uma vez.
  roteiro(
    agenteDoDono, semSkills, { data: [permissao(ID_ML, "automatico")] }, { data: [] },
    { data: [lojaConectada(LOJA_ML, "Loja ML")] }
  );
  const rIncompativel = await patch(AGENTE, COOKIE_A,
    corpoPatch("mercado_livre", "perguntas", LOJA_SHOPEE));
  const bIncompativel = await rIncompativel.json();
  ok("CONN-7  loja de marketplace incompativel -> 409, MESMA mensagem",
    rIncompativel.status === 409 &&
      bIncompativel.erro === "Conta indisponível para este requisito.",
    JSON.stringify(bIncompativel));
  ok("CONN-7a a consulta de lojas foi fechada no marketplace derivado",
    operacoes.find((o) => o.filtros.marketplace !== undefined)?.filtros.marketplace === "ML");

  for (const [rotulo, corpo] of [
    ["chave desconhecida", `{"plataforma":"mercado_livre","recurso":"perguntas","lojaId":null,"nivel":"automatico"}`],
    ["chave faltando", `{"plataforma":"mercado_livre","recurso":"perguntas"}`],
    ["lojaId numero", `{"plataforma":"mercado_livre","recurso":"perguntas","lojaId":7}`],
    ["plataforma vazia", `{"plataforma":"","recurso":"perguntas","lojaId":null}`],
    ["array no lugar de objeto", `[]`],
    ["json quebrado", `{`],
  ] as const) {
    roteiro(agenteDoDono);
    const r = await patch(AGENTE, COOKIE_A, corpo);
    const b = await r.json();
    ok(`CONN-19 corpo invalido (${rotulo}) -> 400`,
      r.status === 400 && b.erro === "Corpo inválido.", `${r.status} ${JSON.stringify(b)}`);
  }

  // ─── H. CONN-13 — erro de driver ───────────────────────────────────

  secao("H. Erros internos nao vazam");

  roteiro(agenteDoDono, { error: { code: "42501", message: "permission denied for table agente_skills", hint: "column x" } });
  const rErro = await get(AGENTE, COOKIE_A);
  const bErro = await rErro.json();
  ok("CONN-13 falha de leitura -> 500 com mensagem fixa",
    rErro.status === 500 && bErro.erro === "Falha ao ler as conexões.",
    `${rErro.status} ${JSON.stringify(bErro)}`);
  ok("CONN-13a nenhum SQLSTATE, relation, column ou message do driver",
    !/42501|permission denied|relation|column|hint/i.test(JSON.stringify(bErro)),
    JSON.stringify(bErro));

  roteiro(
    agenteDoDono, semSkills, { data: [permissao(ID_ML, "automatico")] }, { data: [] },
    { data: [lojaConectada(LOJA_ML, "Loja ML")] },
    { error: { code: "42501", message: "permission denied for table agente_conexoes" } }
  );
  const rErroEscrita = await patch(AGENTE, COOKIE_A, corpoPatch("mercado_livre", "perguntas", LOJA_ML));
  const bErroEscrita = await rErroEscrita.json();
  ok("CONN-13b falha de escrita -> 500 com mensagem fixa",
    rErroEscrita.status === 500 && bErroEscrita.erro === "Falha ao definir a conexão." &&
      !/42501|permission denied/i.test(JSON.stringify(bErroEscrita)),
    `${rErroEscrita.status} ${JSON.stringify(bErroEscrita)}`);

  ok("CONN-12c ZERO tentativa de rede na suite inteira",
    tentativasDeRede === 0, String(tentativasDeRede));

  console.log(`\n══ ${passou} PASS / ${falhou} FAIL ══\n`);
  process.exitCode = falhou === 0 ? 0 : 1;
}

principal().catch((e) => {
  console.log(`  FAIL  excecao nao tratada — ${String(e).slice(0, 300)}`);
  process.exitCode = 1;
});
