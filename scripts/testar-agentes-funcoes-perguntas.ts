/**
 * CDS IA — M2-I1-A2. A primeira Funcao conectada, ponta a ponta de dominio.
 *
 * ── O que esta suite prova, e o que ela nao prova ───────────────────
 *
 * Prova o dominio, o adapter, o executor da Funcao e a integracao real
 * entre executor e agregador. NAO prova cobertura remota, grant do
 * DevCenter nem chamada viva ao Mercado Livre — nada disso existe neste
 * slice, e afirmar o contrario seria inventar prova.
 *
 * ── Zero rede, zero banco, zero escrita ─────────────────────────────
 *
 * `fetch` e a resolucao de credencial entram por PORTAS injetaveis do
 * adapter. O cliente Supabase e duplado por interceptacao de modulo, no
 * mesmo mecanismo das demais suites. Nenhum token real e lido, nenhuma
 * linha e gravada, nenhum host externo e tocado.
 *
 * ── Por que ela roda contra o registry REAL ─────────────────────────
 *
 * O acceptance do A1 registrou `A1-O2`: o feed de requisitos so tinha
 * prova contra catalogo DUBLADO, porque a unica Funcao real nao exigia
 * conexao. Agora existe uma que exige, e o feed passa a ser exercitado
 * com o catalogo de producao — que e o unico jeito de `A1-O4` deixar de
 * ser vacuo.
 *
 * Rodar:  npx tsx scripts/testar-agentes-funcoes-perguntas.ts
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

// ─── O duplo do cliente Supabase ──────────────────────────────────────

interface Chamada {
  tabela: string;
  escrita: boolean;
  filtros: Record<string, unknown>;
  inColuna?: string;
  inValores?: readonly unknown[];
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
  const c: Chamada = { tabela, escrita: false, filtros: {} };
  const resolver = (fn: (v: { data: unknown; error: unknown }) => void) => {
    chamadas.push(c);
    const r = respostas[consumidas++];
    fn({ data: r?.data ?? null, error: r?.error ?? null });
  };
  const b: Record<string, unknown> = {
    select() { return b; },
    eq(coluna: string, valor: unknown) { c.filtros[coluna] = valor; return b; },
    in(coluna: string, valores: readonly unknown[]) { c.inColuna = coluna; c.inValores = valores; return b; },
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

/**
 * SENTINELA DE REDE.
 *
 * A M2-I1-A3 ligou a cobertura remota no executor, e o caminho conectado
 * desta suite passa por ela. O `fetch` global vira uma armadilha: se
 * qualquer coisa tentar rede, o teste QUEBRA com nome proprio em vez de
 * passar por acidente.
 *
 * Sem isto, a secao I dependia de `ML_CLIENT_ID` estar ausente no
 * ambiente para nao chamar o Mercado Livre — uma garantia de ambiente,
 * nao de codigo. Garantia de ambiente nao e garantia.
 */
let tentativasDeRede = 0;
globalThis.fetch = (async (url: string | URL | Request) => {
  tentativasDeRede++;
  throw new Error(`suite sem rede: fetch proibido (${String(url).slice(0, 60)})`);
}) as unknown as typeof fetch;

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

const USER = "user-sintetico-a2";
const AGENTE = "22222222-3333-4444-5555-666666666666";
const LOJA_ML = "dddddddd-0000-4000-8000-000000000001";
const LOJA_SHOPEE = "dddddddd-0000-4000-8000-000000000002";
const ID_ML = "mercadolivre.perguntas.listar";
const ID_VENDAS = "vendas.consultar";
const TOKEN_SINTETICO = "token-sintetico-nunca-deve-vazar";

/** Um item de pergunta na forma que se espera do provider. */
const itemBruto = (extra: Record<string, unknown> = {}) => ({
  id: 9001,
  item_id: "MLB123",
  text: "O produto acompanha manual?",
  status: "UNANSWERED",
  date_created: "2026-09-10T12:00:00.000Z",
  ...extra,
});

/** Porta de credencial que NUNCA toca banco. */
const credencialOk = async () => ({ accessToken: TOKEN_SINTETICO });
const credencialAusente = async () => null;

/** Porta de rede: devolve o que o cenario mandar, registrando a chamada. */
let requisicoes: { url: string; init?: RequestInit }[] = [];
const rede = (status: number, corpo: unknown, opcoes: { json?: boolean } = {}) =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    requisicoes.push({ url: String(url), init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (opcoes.json === false) throw new Error("corpo nao e json");
        return corpo;
      },
      text: async () => JSON.stringify(corpo),
    } as unknown as Response;
  }) as unknown as typeof fetch;

const redeQueCai = (async () => {
  throw new Error("ECONNRESET");
}) as unknown as typeof fetch;

type ResolverCredencial = (
  lojaId: string,
  userId: string
) => Promise<{ accessToken: string } | null>;
const portas = (buscar: typeof fetch, resolverCredencial: ResolverCredencial = credencialOk) =>
  ({ buscar, resolverCredencial });

const linhaPermissao = (funcaoId: string, nivel: string) => ({ funcao_id: funcaoId, nivel });
const linhaSelecao = (plataforma: string, recurso: string, lojaId: string) =>
  ({ agente_id: AGENTE, user_id: USER, plataforma, recurso, loja_id: lojaId });
const linhaLojaDona = (id: string) => ({ id, user_id: USER });
const lojaBruta = (id: string, marketplace: string) => ({
  id,
  marketplace,
  ativo: true,
  access_token: TOKEN_SINTETICO,
  token_expires_at: "2026-12-31T23:59:59.000Z",
});

console.log("\n══ CDS IA — M2-I1-A2: mercadolivre.perguntas.listar ══");

// ─── A. Fronteiras estaticas ──────────────────────────────────────────

const CODIGO_ADAPTER = semComentarios(ler("lib/mercado-livre-perguntas.ts"));
const CODIGO_DOMINIO = semComentarios(ler("lib/agentes/dados/perguntas.ts"));
const CODIGO_FUNCAO = semComentarios(ler("lib/agentes/funcoes/mercadolivre-perguntas.ts"));

secao("A. Quem pode ver credencial, e quem nao pode");

ok("A1  o adapter e server-only", /import "server-only"/.test(CODIGO_ADAPTER));
ok("A2  e e o UNICO dos tres que resolve credencial",
  /getMLLojaById/.test(CODIGO_ADAPTER) &&
    !/getMLLojaById|access_token|accessToken/.test(CODIGO_DOMINIO) &&
    !/getMLLojaById|access_token|accessToken/.test(CODIGO_FUNCAO));
ok("A3  so o adapter tem `fetch`",
  /buscar\(/.test(CODIGO_ADAPTER) && !/fetch\s*\(/.test(CODIGO_DOMINIO) &&
    !/fetch\s*\(/.test(CODIGO_FUNCAO));
ok("A4  o adapter NAO grava nada",
  !/\.(insert|update|upsert|delete|rpc)\(/.test(CODIGO_ADAPTER));
ok("A5  e nao cria tabela nem storage de segredo",
  !/from\("/.test(CODIGO_ADAPTER) && !/createClient/.test(CODIGO_ADAPTER));
ok("A6  o metodo HTTP e leitura: sem POST/PUT/PATCH/DELETE",
  !/method:\s*"(POST|PUT|PATCH|DELETE)"/i.test(CODIGO_ADAPTER));
ok("A7  o endereco e literal do modulo, nunca do chamador",
  /const BASE_ML = "https:\/\/api\.mercadolibre\.com"/.test(CODIGO_ADAPTER) &&
    !/baseUrl|endpoint\?|url:\s*string/.test(CODIGO_ADAPTER));
ok("A8  as portas injetaveis sao DUAS, e nenhuma delas e token",
  /resolverCredencial\?:/.test(CODIGO_ADAPTER) && /buscar\?:/.test(CODIGO_ADAPTER) &&
    !/token\?:|accessToken\?:/.test(CODIGO_ADAPTER));
ok("A9  zero retry dentro do cliente",
  !/withRetry|retry|tentativas/i.test(CODIGO_ADAPTER));
ok("A10 CONTROLE: as sondas acham os padroes quando eles existem",
  /fetch\s*\(/.test("fetch(x)") && /\.insert\(/.test("q.insert({})"));

// ─── B–H. Comportamento ───────────────────────────────────────────────

async function principal(): Promise<void> {
  const dominio = await import("../lib/agentes/dados/perguntas");
  const funcao = await import("../lib/agentes/funcoes/mercadolivre-perguntas");
  const adapter = await import("../lib/mercado-livre-perguntas");
  const registry = await import("../lib/agentes/funcoes/registry");
  const { resolverConexoesDoAgente } = await import("../lib/agentes/conexoes/agregador");

  secao("B. O instrumento esta instalado");

  ok("B1  ANCORA: o cliente Supabase foi duplado", interceptou);
  ok("B2  ANCORA: o registry real carregou", registry.listarFuncoesRegistradas().length > 0);

  // ─── C. O registry REAL ────────────────────────────────────────────

  secao("C. O catalogo real tem as duas Funcoes (A1-O2)");

  const IDS = registry.listarFuncoesRegistradas();
  ok("C1  o conjunto de ids e exatamente o publicado",
    JSON.stringify([...IDS].sort()) === JSON.stringify([ID_ML, ID_VENDAS].sort()),
    IDS.join(", "));
  ok("C2  e a resolucao NAO depende de posicao",
    registry.funcaoExiste(ID_ML) && registry.funcaoExiste(ID_VENDAS) &&
      !registry.funcaoExiste("intrusa.funcao"));

  const defML = registry.FUNCOES[ID_ML];
  ok("C3  revisao `1`", defML.revisao === "1", defML.revisao);
  ok("C4  acesso leitura", defML.acesso === "leitura", defML.acesso);
  ok("C5  idempotente", defML.idempotente === true);
  ok("C6  requisito de conexao = mercado_livre/perguntas",
    JSON.stringify(defML.conexaoNecessaria) ===
      JSON.stringify({ plataforma: "mercado_livre", recurso: "perguntas" }),
    JSON.stringify(defML.conexaoNecessaria));
  ok("C7  o executor e o do modulo proprio, nao o de vendas",
    defML.executor === funcao.executarPerguntasML &&
      defML.validarEntrada === funcao.validarEntradaPerguntasML &&
      defML.interpretarSaida === funcao.interpretarSaidaPerguntasML);
  ok("C8  e `vendas.consultar` NAO ganhou requisito de conexao",
    registry.FUNCOES[ID_VENDAS].conexaoNecessaria === null &&
      registry.FUNCOES[ID_VENDAS].acesso === "leitura" &&
      registry.FUNCOES[ID_VENDAS].revisao === "1");
  ok("C9  os dois executores sao FUNCOES DIFERENTES",
    registry.FUNCOES[ID_VENDAS].executor !== defML.executor);
  ok("C10 o id respeita o CHECK do banco (primeiro segmento sem underscore)",
    /^[a-z0-9]+(\.[a-z0-9_]+)+$/.test(ID_ML));
  ok("C11 CONTROLE: `mercado_livre.perguntas.listar` NAO respeitaria",
    !/^[a-z0-9]+(\.[a-z0-9_]+)+$/.test("mercado_livre.perguntas.listar"));

  // ─── D. Validacao de argumentos ────────────────────────────────────

  secao("D. Os argumentos que o agente pode mandar");

  const val = (a: unknown) => funcao.validarEntradaPerguntasML(a);
  ok("D1  objeto vazio e valido", val({}).valida === true);
  ok("D2  status conhecido e valido", val({ status: "UNANSWERED" }).valida === true);
  ok("D3  status desconhecido reprova",
    val({ status: "DELETED" }).valida === false &&
      (val({ status: "DELETED" }) as { codigo: string }).codigo === "status_invalido");
  ok("D4  nao-objeto reprova",
    val(null).valida === false && val("x").valida === false && val([]).valida === false);
  ok("D5  limite acima do teto reprova",
    val({ limite: dominio.LIMITE_MAXIMO_PERGUNTAS + 1 }).valida === false);
  ok("D6  limite zero/negativo/fracionario reprova",
    val({ limite: 0 }).valida === false && val({ limite: -1 }).valida === false &&
      val({ limite: 1.5 }).valida === false);
  ok("D7  deslocamento negativo reprova", val({ deslocamento: -1 }).valida === false);
  ok("D8  deslocamento grande e legitimo", val({ deslocamento: 5000 }).valida === true);
  ok("D9  `lojaId` nos argumentos NAO e aceito como seletor de conta",
    !/lojaId|loja_id|sellerId|seller_id/.test(
      CODIGO_DOMINIO.slice(
        CODIGO_DOMINIO.indexOf("interface FiltroPerguntas"),
        CODIGO_DOMINIO.indexOf("interface ResultadoPerguntas")
      )
    ));
  ok("D10 e nao ha url/path/query livre no filtro",
    !/url|path|query|endpoint/i.test(
      CODIGO_DOMINIO.slice(
        CODIGO_DOMINIO.indexOf("interface FiltroPerguntas"),
        CODIGO_DOMINIO.indexOf("interface ResultadoPerguntas")
      )
    ));

  // ─── E. Normalizacao ───────────────────────────────────────────────

  secao("E. O que chega ao agente, e o que nao chega");

  const normal = dominio.normalizarPergunta(itemBruto());
  ok("E1  item completo vira PerguntaRecebida", normal !== null);
  ok("E2  com EXATAMENTE os cinco campos publicados",
    JSON.stringify(Object.keys(normal ?? {}).sort()) ===
      JSON.stringify(["anuncioId", "criadaEm", "id", "status", "texto"]),
    Object.keys(normal ?? {}).join(", "));
  ok("E3  `id` numerico vira string estavel", normal?.id === "9001");
  for (const [campo, nome] of [
    ["id", "id"], ["item_id", "anuncio"], ["text", "texto"],
    ["status", "status"], ["date_created", "data"],
  ] as const) {
    const semCampo = { ...itemBruto() } as Record<string, unknown>;
    delete semCampo[campo];
    ok(`E4  item sem ${nome} e DESCARTADO, nunca preenchido`,
      dominio.normalizarPergunta(semCampo) === null);
  }
  ok("E5  campo extra do provider NAO atravessa",
    dominio.normalizarPergunta(itemBruto({ from: { id: 777 }, answer: { text: "oi" } }))
      ?.hasOwnProperty("from") !== true);
  ok("E6  e nenhum vestigio de credencial sobrevive",
    !/token|secret|senha|credencial|seller/i.test(
      JSON.stringify(dominio.normalizarPergunta(itemBruto({ access_token: TOKEN_SINTETICO })))));

  // ─── F. O adapter, contra rede duplada ─────────────────────────────

  secao("F. O adapter: uma chamada, sem token vazando");

  const entradaML = {
    userId: USER, lojaId: LOJA_ML, status: null, limite: 20, deslocamento: 0,
  };

  requisicoes = [];
  const fOk = await adapter.buscarPerguntasRecebidasML(
    entradaML,
    portas(rede(200, { questions: [itemBruto()], total: 1 }))
  );
  ok("F1  200 -> itens e erro nulo", fOk.erro === null && fOk.itens.length === 1);
  ok("F2  UMA requisicao, nunca retry", requisicoes.length === 1, String(requisicoes.length));
  ok("F3  o endereco e `/my/received_questions/search` em api.mercadolibre.com",
    requisicoes[0]?.url.startsWith("https://api.mercadolibre.com/my/received_questions/search"),
    requisicoes[0]?.url);
  ok("F4  sem `seller_id` no endereco — o `/my/` o dispensa",
    !/seller_id|user_id/.test(requisicoes[0]?.url ?? ""));
  ok("F5  o token viaja no header, e SO nele",
    (requisicoes[0]?.init?.headers as Record<string, string>)?.Authorization ===
      `Bearer ${TOKEN_SINTETICO}` && !requisicoes[0]!.url.includes(TOKEN_SINTETICO));
  ok("F6  ha timeout declarado", requisicoes[0]?.init?.signal !== undefined);
  ok("F7  `total` maior que a pagina -> haMais",
    (await adapter.buscarPerguntasRecebidasML(
      entradaML, portas(rede(200, { questions: [itemBruto()], total: 99 }))
    )).haMais === true);
  ok("F8  `total` ausente -> pagina cheia ainda sinaliza haMais",
    (await adapter.buscarPerguntasRecebidasML(
      { ...entradaML, limite: 1 }, portas(rede(200, { questions: [itemBruto()] }))
    )).haMais === true);

  // ─── G. Erros ──────────────────────────────────────────────────────

  secao("G. Erros: codigo fechado, nunca corpo do provider");

  const casos: [string, () => Promise<{ erro: string | null }>, string][] = [
    ["G1  credencial ausente",
      () => adapter.buscarPerguntasRecebidasML(entradaML, portas(rede(200, {}), credencialAusente)),
      "credencial_ausente"],
    ["G2  401 -> nao_autorizado",
      () => adapter.buscarPerguntasRecebidasML(entradaML, portas(rede(401, { message: "invalid token abc123" }))),
      "nao_autorizado"],
    ["G3  403 -> nao_autorizado (ambiguo demais para diagnostico proprio)",
      () => adapter.buscarPerguntasRecebidasML(entradaML, portas(rede(403, { message: "forbidden" }))),
      "nao_autorizado"],
    ["G4  429 -> limite_excedido",
      () => adapter.buscarPerguntasRecebidasML(entradaML, portas(rede(429, {}))),
      "limite_excedido"],
    ["G5  500 -> indisponivel",
      () => adapter.buscarPerguntasRecebidasML(entradaML, portas(rede(500, {}))),
      "indisponivel"],
    ["G6  queda de rede -> indisponivel",
      () => adapter.buscarPerguntasRecebidasML(entradaML, portas(redeQueCai)),
      "indisponivel"],
    ["G7  corpo nao-json -> resposta_invalida",
      () => adapter.buscarPerguntasRecebidasML(entradaML, portas(rede(200, {}, { json: false }))),
      "resposta_invalida"],
    ["G8  `questions` ausente -> resposta_invalida",
      () => adapter.buscarPerguntasRecebidasML(entradaML, portas(rede(200, { outra: [] }))),
      "resposta_invalida"],
  ];
  for (const [nome, executar, esperado] of casos) {
    const r = await executar();
    ok(nome, r.erro === esperado, String(r.erro));
  }

  const r401 = await adapter.buscarPerguntasRecebidasML(
    entradaML, portas(rede(401, { message: "invalid token abc123", cause: "expired" }))
  );
  ok("G9  o corpo do provider NAO sobe junto",
    !JSON.stringify(r401).includes("abc123") && !JSON.stringify(r401).includes("invalid token"),
    JSON.stringify(r401));
  ok("G10 e o erro nunca vira lista vazia com sucesso",
    r401.erro !== null && r401.itens.length === 0);

  // Cada codigo tem mensagem propria e `retryable` coerente.
  const interpretado = (erro: string) =>
    funcao.interpretarSaidaPerguntasML({ linhas: [], truncado: false, erro });
  ok("G11 `nao_autorizado` NAO e repetivel",
    (interpretado("nao_autorizado") as { retryable: boolean }).retryable === false);
  ok("G12 `limite_excedido` e `indisponivel` sao repetiveis",
    (interpretado("limite_excedido") as { retryable: boolean }).retryable === true &&
      (interpretado("indisponivel") as { retryable: boolean }).retryable === true);
  ok("G13 nenhuma mensagem publica cita status HTTP nem token",
    !["conexao_invalida", "credencial_ausente", "nao_autorizado", "limite_excedido",
      "indisponivel", "resposta_invalida"]
      .some((c) => /\b(401|403|429|500|token|bearer)\b/i.test(
        (interpretado(c) as { mensagem: string }).mensagem)));

  // ─── H. O executor da Funcao ───────────────────────────────────────

  secao("H. A loja vem do CONTEXTO, e de nenhum outro lugar");

  const CONEXAO_OK = { plataforma: "mercado_livre", recurso: "perguntas", lojaId: LOJA_ML };

  const semConexao = await funcao.executarPerguntasML({ userId: USER, conexao: null }, {});
  ok("H1  sem conexao -> `conexao_invalida`, e zero rede",
    semConexao.erro === "conexao_invalida" && semConexao.linhas.length === 0);

  const outroProvedor = await funcao.executarPerguntasML(
    { userId: USER, conexao: { ...CONEXAO_OK, plataforma: "shopee" } }, {}
  );
  ok("H2  binding de outro provedor -> `conexao_invalida`",
    outroProvedor.erro === "conexao_invalida");

  const outroRecurso = await funcao.executarPerguntasML(
    { userId: USER, conexao: { ...CONEXAO_OK, recurso: "mensagens" } }, {}
  );
  ok("H3  binding de outro recurso -> `conexao_invalida`", outroRecurso.erro === "conexao_invalida");

  ok("H4  o executor NAO le loja dos argumentos",
    !/argumentos\.\s*lojaId|args\.lojaId|argumentos\["lojaId"\]/.test(CODIGO_FUNCAO));
  ok("H5  a unica origem de loja e `contexto.conexao.lojaId`",
    (CODIGO_FUNCAO.match(/conexao\.lojaId/g) ?? []).length >= 1 &&
      !/lojas\[0\]|primeira|\.at\(0\)/.test(CODIGO_FUNCAO));
  ok("H6  CONTROLE: a sonda de H4 acha o padrao proibido",
    /argumentos\.\s*lojaId/.test("const l = argumentos.lojaId;"));

  // ─── I. Executor real -> agregador REAL (A1-O3) ────────────────────

  secao("I. Executor real sobre o agregador REAL (A1-O3)");

  const { executarFuncao } = await import("../lib/agentes/execucao-funcoes/executar");

  // Roteiro do agregador real: skills(1) + permissoes(1) + selecao(2) + lote(1).
  // A Funcao ML esta `automatico`; `vendas.consultar` esta `bloqueado` —
  // e e por isso que o cenario prova isolamento, nao coincidencia.
  const roteiroConectado = (marketplaceDaLoja: string) => [
    { data: { id: AGENTE, user_id: USER, nome: "A", tipo: "personalizado", ativo: true } },
    { data: [] },
    { data: [linhaPermissao(ID_ML, "automatico"), linhaPermissao(ID_VENDAS, "bloqueado")] },
    { data: [linhaSelecao("mercado_livre", "perguntas", LOJA_ML)] },
    { data: [linhaLojaDona(LOJA_ML)] },
    { data: [lojaBruta(LOJA_ML, marketplaceDaLoja)] },
    { data: null },
  ];

  roteiro(...roteiroConectado("ML"));
  const rConectado = await executarFuncao({
    userId: USER, agenteId: AGENTE, funcaoId: ID_ML, argumentos: {},
  });
  const lidasPermissao = chamadas.filter((c) => c.tabela === "agente_permissoes");
  ok("I1  ANCORA: o agregador REAL rodou — leu skills, permissoes e lojas",
    chamadas.some((c) => c.tabela === "agente_skills") &&
      chamadas.some((c) => c.tabela === "agente_permissoes") &&
      chamadas.some((c) => c.tabela === "lojas"),
    chamadas.map((c) => c.tabela).join(" > "));
  ok("I2  UMA leitura de agente_permissoes", lidasPermissao.length === 1,
    String(lidasPermissao.length));
  ok("I3  e ela cobre o CATALOGO INTEIRO (A1-O4)",
    JSON.stringify([...(lidasPermissao[0]?.inValores ?? [])].sort()) ===
      JSON.stringify([ID_ML, ID_VENDAS].sort()),
    JSON.stringify(lidasPermissao[0]?.inValores));
  ok("I4  mesmo com ZERO Skill declarando qualquer Funcao",
    chamadas.filter((c) => c.tabela === "agente_skills").length >= 1);
  ok("I5  a leitura de permissoes e fechada no par (agente, dono)",
    lidasPermissao[0]?.filtros.agente_id === AGENTE &&
      lidasPermissao[0]?.filtros.user_id === USER);
  // A auditoria GRAVA, e tem de gravar: uma tentativa negada sem linha de
  // desfecho seria exatamente a janela que `chamadas/registro.ts` existe
  // para fechar. O que nao pode e escrita em tabela de DOMINIO — e nada
  // toca banco real: o cliente inteiro e duplado.
  const escritas = chamadas.filter((c) => c.escrita);
  ok("I6  a unica escrita e a AUDITORIA, em nenhuma tabela de dominio",
    escritas.length > 0 &&
      escritas.every((c) => c.tabela === "agente_funcao_chamadas"),
    escritas.map((c) => c.tabela).join(", ") || "nenhuma");
  ok("I5a ZERO tentativa de rede no caminho conectado inteiro",
    tentativasDeRede === 0, String(tentativasDeRede));
  ok("I6a zero escrita em lojas, agente_conexoes, agente_permissoes ou pedidos",
    !escritas.some((c) =>
      ["lojas", "agente_conexoes", "agente_permissoes", "pedidos", "agentes"]
        .includes(c.tabela)));
  // `vendas.consultar` esta bloqueado no MESMO snapshot e nao interfere:
  // a Funcao ML passou do guard de permissao e chegou a avaliacao de
  // conexao — que nega, porque `coberturaDoRecurso` ainda e constante.
  ok("I7  a Funcao ML NAO foi negada por permissao",
    !(rConectado.tipo === "negado" &&
      ["permissao_bloqueada", "permissao_ausente"].includes(
        (rConectado as { codigo?: string }).codigo ?? "")),
    `${rConectado.tipo}/${(rConectado as { codigo?: string }).codigo}`);
  ok("I8  ela para em `conexao_ausente` — cobertura remota NAO existe neste slice",
    rConectado.tipo === "negado" &&
      (rConectado as { codigo?: string }).codigo === "conexao_ausente",
    `${rConectado.tipo}/${(rConectado as { codigo?: string }).codigo}`);

  // A Funcao BLOQUEADA do mesmo snapshot continua bloqueada — prova de
  // que o snapshot ALL nao virou permissao para ninguem.
  // `vendas.consultar` nao tem requisito de conexao, entao o executor usa
  // o ramo CURTO: agente -> permissoes da Funcao atual. Sequencia diferente,
  // roteiro diferente — reaproveitar o do ramo conectado mediria outra coisa.
  roteiro(
    { data: { id: AGENTE, user_id: USER, nome: "A", tipo: "personalizado", ativo: true } },
    { data: [linhaPermissao(ID_VENDAS, "bloqueado")] },
    { data: null }
  );
  const rVendas = await executarFuncao({
    userId: USER, agenteId: AGENTE, funcaoId: ID_VENDAS, argumentos: {},
  });
  ok("I9  a Funcao vizinha BLOQUEADA continua negada",
    rVendas.tipo === "negado" &&
      (rVendas as { codigo?: string }).codigo === "permissao_bloqueada",
    `${rVendas.tipo}/${(rVendas as { codigo?: string }).codigo}`);
  ok("I10 e ela nao paga leitura de conexao — `conexaoNecessaria` e null",
    chamadas.filter((c) => c.tabela === "agente_conexoes").length === 0 &&
      chamadas.filter((c) => c.tabela === "agente_skills").length === 0,
    chamadas.map((c) => c.tabela).join(" > "));
  ok("I10a e a leitura curta pergunta SO por ela",
    JSON.stringify(
      chamadas.find((c) => c.tabela === "agente_permissoes")?.inValores
    ) === JSON.stringify([ID_VENDAS]),
    JSON.stringify(chamadas.find((c) => c.tabela === "agente_permissoes")?.inValores));

  // Selecao cross-provider: loja Shopee escolhida para requisito ML.
  roteiro(
    { data: { id: AGENTE, user_id: USER, nome: "A", tipo: "personalizado", ativo: true } },
    { data: [] },
    { data: [linhaPermissao(ID_ML, "automatico")] },
    { data: [linhaSelecao("mercado_livre", "perguntas", LOJA_SHOPEE)] },
    { data: [linhaLojaDona(LOJA_SHOPEE)] },
    { data: [lojaBruta(LOJA_SHOPEE, "Shopee")] },
    { data: null }
  );
  requisicoes = [];
  const rCross = await executarFuncao({
    userId: USER, agenteId: AGENTE, funcaoId: ID_ML, argumentos: {},
  });
  ok("I11 selecao de loja Shopee para requisito ML -> negado",
    rCross.tipo === "negado" &&
      (rCross as { codigo?: string }).codigo === "conexao_ausente");
  ok("I12 e ZERO chamada externa foi disparada", requisicoes.length === 0);
  ok("I13 o `lojaId` incompativel nao aparece em lugar nenhum da saida",
    !JSON.stringify(rCross).includes(LOJA_SHOPEE));

  // ─── J. Feed de requisitos com o registry REAL (A1-O2) ─────────────

  secao("J. O feed de requisitos, contra o catalogo de producao");

  const AG = { userId: USER, agenteId: AGENTE, agoraMs: Date.parse("2026-09-18T12:00:00.000Z") };

  const feed = async (nivelML: string | null) => {
    roteiro(
      { data: [] },
      { data: nivelML === null ? [] : [linhaPermissao(ID_ML, nivelML)] },
      { data: [] }
    );
    return resolverConexoesDoAgente(AG);
  };

  const jAuto = await feed("automatico");
  ok("J1  ML `automatico` gera requirement, sem Skill nenhuma",
    jAuto.semSelecao.length === 1 &&
      jAuto.semSelecao[0]?.plataforma === "mercado_livre" &&
      jAuto.semSelecao[0]?.recurso === "perguntas" &&
      jAuto.semSelecao[0]?.obrigatoria === true,
    JSON.stringify(jAuto.semSelecao));
  ok("J2  ML `aprovacao` tambem gera", (await feed("aprovacao")).semSelecao.length === 1);
  ok("J3  ML `bloqueado` NAO gera", (await feed("bloqueado")).semSelecao.length === 0);
  ok("J4  linha AUSENTE nao gera", (await feed(null)).semSelecao.length === 0);
  ok("J5  e `vendas.consultar` nunca gera requirement por acidente",
    (await feed("automatico")).semSelecao.every((r) => r.plataforma === "mercado_livre"));

  // A1-O4: a query cobre ALL mesmo com o subset das Skills vazio.
  const qFeed = chamadas.find((c) => c.tabela === "agente_permissoes");
  ok("J6  a consulta do feed cobre os DOIS ids do catalogo (A1-O4)",
    JSON.stringify([...(qFeed?.inValores ?? [])].sort()) ===
      JSON.stringify([ID_ML, ID_VENDAS].sort()),
    JSON.stringify(qFeed?.inValores));
  ok("J7  e agora ALL != subset: o subset das Skills esta VAZIO",
    (qFeed?.inValores ?? []).length === 2);
  ok("J8  o snapshot publicado traz o fato lido",
    jAuto.permissoes.some((p) => p.funcaoId === ID_ML && p.nivel === "automatico"));
  ok("J9  ausencia de linha nao vira fato sintetico",
    !jAuto.permissoes.some((p) => p.funcaoId === ID_VENDAS));

  console.log(`\n══ ${passou} PASS / ${falhou} FAIL ══\n`);
  process.exitCode = falhou === 0 ? 0 : 1;
}

principal().catch((e) => {
  console.log(`  FAIL  excecao nao tratada — ${String(e).slice(0, 300)}`);
  process.exitCode = 1;
});
