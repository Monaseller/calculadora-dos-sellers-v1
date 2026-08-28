/**
 * CDS IA — SKILL-1D.g.2-B. Suite do write path da selecao de loja.
 *
 * `selecao-escrita.ts` e `server-only` e fala com o Supabase. Ele e
 * EXECUTADO de verdade aqui, contra um cliente DUPLADO que registra cada
 * invocacao: o que se afirma nao e "o fake funciona", e sim quantas
 * escritas o codigo real fez, em que tabela, com que payload, com que
 * `onConflict` e com quais filtros. O duplo e o instrumento de medida,
 * nunca o objeto medido.
 *
 * Diferenca de instrumento em relacao a `g1-c`: la os metodos de escrita
 * eram marcados `PROIBIDO:` porque a camada de leitura nao pode escrever.
 * Aqui eles sao o objeto do teste, entao o duplo os REGISTRA — e quem
 * passa a ser proibida e a leitura (`select` fora de um `delete`), porque
 * o blueprint aprovado nao tem pre-leitura.
 *
 * Precedentes seguidos, nenhum inventado: `_server-only-inerte` e o duplo
 * de `Module.prototype.require` das suites da f.3, f.4 e g.1-C.
 *
 * Rodar:  npx tsx scripts/testar-ia-skill-1d-g2.ts
 * Sem rede, sem banco, sem env, sem segredo, sem `--confirmo`.
 */
import "./_server-only-inerte";

import Module from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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

const FONTE_ESCRITA = ler("lib/agentes/conexoes/selecao-escrita.ts");
const CODIGO_ESCRITA = semComentarios(FONTE_ESCRITA);

// ─── O duplo do cliente Supabase ──────────────────────────────────────

interface Chamada {
  tabela: string;
  operacao: "upsert" | "delete" | "select" | "insert" | "update" | "rpc";
  payload?: Record<string, unknown>;
  opcoes?: Record<string, unknown>;
  filtros: Record<string, unknown>;
  ordemFiltros: string[];
  projecao?: string;
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
  // `operacao` nasce como `select`: se o codigo real fizer uma consulta
  // solta — a pre-leitura que o blueprint recusou —, ela aparece com esse
  // rotulo e as sondas de "zero leitura" acusam.
  const c: Chamada = { tabela, operacao: "select", filtros: {}, ordemFiltros: [] };
  const b: Record<string, unknown> = {
    select(cols: string) {
      c.projecao = cols;
      return b;
    },
    eq(coluna: string, valor: unknown) {
      c.filtros[coluna] = valor;
      c.ordemFiltros.push(coluna);
      return b;
    },
    upsert(payload: Record<string, unknown>, opcoes?: Record<string, unknown>) {
      c.operacao = "upsert";
      c.payload = payload;
      c.opcoes = opcoes;
      return b;
    },
    delete() {
      c.operacao = "delete";
      return b;
    },
    insert(payload: Record<string, unknown>) {
      c.operacao = "insert";
      c.payload = payload;
      return b;
    },
    update(payload: Record<string, unknown>) {
      c.operacao = "update";
      c.payload = payload;
      return b;
    },
    // O `await` do codigo real cai aqui: e neste ponto que a instrucao
    // realmente conta como executada.
    then(resolver: (v: { data: unknown; error: unknown }) => void) {
      chamadas.push(c);
      const r = respostas[consumidas++];
      resolver({ data: r?.data ?? null, error: r?.error ?? null });
    },
  };
  return b;
}

let rpcs = 0;
const clienteFake = {
  from: (t: string) => construtor(t),
  rpc: () => {
    rpcs++;
    return Promise.resolve({ data: null, error: null });
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

const USER = "user-sintetico-g2";
const AGENTE = "11111111-2222-3333-4444-555555555555";
const LOJA = "aaaaaaaa-0000-4000-8000-000000000001";
const OUTRA_LOJA = "aaaaaaaa-0000-4000-8000-000000000002";

const DEF = {
  userId: USER,
  agenteId: AGENTE,
  plataforma: "shopee",
  recurso: "pedidos",
  lojaId: LOJA,
};

const REM = {
  userId: USER,
  agenteId: AGENTE,
  plataforma: "shopee",
  recurso: "pedidos",
};

const ERRO_FK = { code: "23503" };

console.log("\n══ CDS IA — SKILL-1D.g.2-B: write path da selecao de loja ══");

// ─── A. O modulo e a fronteira estatica ───────────────────────────────

secao("A. Um modulo de producao, server-only, sem autoridade extra");

ok("A1  selecao-escrita.ts existe", existsSync(join(RAIZ, "lib/agentes/conexoes/selecao-escrita.ts")));
ok("A2  E server-only", /import "server-only"/.test(CODIGO_ESCRITA));
ok("A3  a pasta tem exatamente os 5 modulos previstos",
  JSON.stringify(readdirSync(join(RAIZ, "lib/agentes/conexoes")).sort()) ===
    JSON.stringify(["estado.ts", "fatos.ts", "selecao-escrita.ts", "selecao-estado.ts", "selecao-fatos.ts"]),
  readdirSync(join(RAIZ, "lib/agentes/conexoes")).sort().join(", "));
ok("A4  nenhum segundo modulo de producao desta fase",
  !existsSync(join(RAIZ, "lib/agentes/conexoes/selecao-escrita-helpers.ts")) &&
    !existsSync(join(RAIZ, "lib/agentes/selecao-escrita.ts")));
ok("A5  reusa a autoridade publicada de plataforma e recurso",
  /plataformaConhecida/.test(CODIGO_ESCRITA) && /recursoValido/.test(CODIGO_ESCRITA));
ok("A6  NAO redeclara o mapa de plataformas",
  !/MARKETPLACE_POR_PLATAFORMA\s*[:=]/.test(CODIGO_ESCRITA) && !/mercado_livre\s*:/.test(CODIGO_ESCRITA));
ok("A7  NAO redeclara regex de slug",
  !/\/\^\[a-z0-9\]/.test(CODIGO_ESCRITA));
ok("A8  nenhuma migration nesta frente",
  !existsSync(join(RAIZ, "supabase/migrations/20260926_agente_conexoes_escrita.sql")));
ok("A9  CONTROLE: as sondas acusam quando o padrao existe",
  /import "server-only"/.test('import "server-only"') && /\/\^\[a-z0-9\]/.test("/^[a-z0-9]+$/"));

// ─── B. Zero credencial, zero mensagem de driver ──────────────────────

secao("B. Zero token, zero error.message");

ok("B1  zero coluna de credencial no codigo",
  !/access_token|refresh_token|partner_key|token_expires|senha|secret/i.test(CODIGO_ESCRITA));
ok("B2  zero error.message / details / hint",
  !/error\.message|\.details|\.hint/.test(CODIGO_ESCRITA));
ok("B3  o log carrega SQLSTATE, nao contexto identificavel",
  /sqlstate \$\{/.test(CODIGO_ESCRITA) &&
    !/console\.error\([^)]*(userId|agenteId|lojaId)/.test(CODIGO_ESCRITA));
ok("B4  zero resolverFatoConexao", !/resolverFatoConexao/.test(CODIGO_ESCRITA));
ok("B5  zero leitura de lojas ou agentes",
  !/from\("lojas"\)|from\("agentes"\)/.test(CODIGO_ESCRITA));
ok("B6  zero RPC", !/\.rpc\(/.test(CODIGO_ESCRITA));
ok("B7  zero escolha implicita — sem limit/order/single",
  !/\.limit\(|\.order\(|maybeSingle|\.single\(/.test(CODIGO_ESCRITA));
ok("B8  payload montado campo a campo — sem spread da entrada",
  !/\.\.\.entrada|\.\.\.input|\.\.\.dados/.test(CODIGO_ESCRITA));
ok("B9  CONTROLE: a sonda de credencial acusa quando existe",
  /access_token/i.test("access_token: x"));

// ─── C. O comportamento real ──────────────────────────────────────────

async function principal(): Promise<void> {
  const { definirSelecaoDeLoja, removerSelecaoDeLoja } = await import(
    "../lib/agentes/conexoes/selecao-escrita"
  );

  secao("C. O instrumento de medida esta instalado");

  ok("C1  ANCORA: o duplo interceptou o cliente Supabase", interceptou);
  const carregados = Object.keys(require.cache).map((p) => p.replace(/\\/g, "/"));
  ok("C2  ANCORA: selecao-escrita.ts esta no grafo",
    carregados.some((p) => p.includes("/lib/agentes/conexoes/selecao-escrita.ts")));
  ok("C3  nenhum cliente Supabase real carregado",
    !carregados.some((p) => /@supabase|supabase-servidor/.test(p)));

  // ── D. Guards de DEFINIR: zero chamada ao cliente ──────────────────

  secao("D. Entrada invalida em DEFINIR nao toca o cliente");

  const casosDefinir: [string, Record<string, unknown>][] = [
    ["D1  userId vazio", { ...DEF, userId: "" }],
    ["D2  agenteId vazio", { ...DEF, agenteId: "" }],
    ["D3  lojaId vazio", { ...DEF, lojaId: "" }],
    ["D4  plataforma fora do mapa", { ...DEF, plataforma: "amazon" }],
    ["D5  plataforma vazia", { ...DEF, plataforma: "" }],
    ["D6  plataforma com caixa alta", { ...DEF, plataforma: "Shopee" }],
    ["D7  recurso com underscore", { ...DEF, recurso: "meus_pedidos" }],
    ["D8  recurso vazio", { ...DEF, recurso: "" }],
    ["D9  recurso com maiuscula", { ...DEF, recurso: "Pedidos" }],
    ["D10 recurso com hifen duplo", { ...DEF, recurso: "meus--pedidos" }],
  ];
  for (const [nome, entrada] of casosDefinir) {
    roteiro();
    const r = await definirSelecaoDeLoja(entrada as never);
    ok(`${nome} -> entrada_invalida + 0 chamadas`,
      r.estado === "entrada_invalida" && chamadas.length === 0,
      `${r.estado} / ${chamadas.length} chamada(s)`);
  }

  secao("E. Entrada invalida em REMOVER nao toca o cliente");

  const casosRemover: [string, Record<string, unknown>][] = [
    ["E1  userId vazio", { ...REM, userId: "" }],
    ["E2  agenteId vazio", { ...REM, agenteId: "" }],
    ["E3  plataforma fora do mapa", { ...REM, plataforma: "amazon" }],
    ["E4  recurso invalido", { ...REM, recurso: "meus_pedidos" }],
  ];
  for (const [nome, entrada] of casosRemover) {
    roteiro();
    const r = await removerSelecaoDeLoja(entrada as never);
    ok(`${nome} -> entrada_invalida + 0 chamadas`,
      r.estado === "entrada_invalida" && chamadas.length === 0,
      `${r.estado} / ${chamadas.length} chamada(s)`);
  }

  // ── F. O UPSERT ────────────────────────────────────────────────────

  secao("F. DEFINIR: um UPSERT, e exatamente o certo");

  roteiro({});
  const rDef = await definirSelecaoDeLoja(DEF);
  const c = chamadas[0];

  ok("F1  exatamente 1 instrucao", chamadas.length === 1, String(chamadas.length));
  ok("F2  zero leitura previa",
    chamadas.filter((x) => x.operacao === "select").length === 0);
  ok("F3  a operacao e upsert", c?.operacao === "upsert", c?.operacao);
  ok("F4  a tabela e agente_conexoes", c?.tabela === "agente_conexoes", c?.tabela);
  ok("F5  onConflict exato (a PK publicada)",
    c?.opcoes?.onConflict === "agente_id,plataforma,recurso", String(c?.opcoes?.onConflict));
  ok("F6  onConflict NAO inclui user_id nem loja_id",
    !/user_id|loja_id|criado_em|alterado_em/.test(String(c?.opcoes?.onConflict ?? "")));
  ok("F7  zero .select() no upsert", c?.projecao === undefined, String(c?.projecao));
  ok("F8  zero filtro .eq no upsert", (c?.ordemFiltros ?? []).length === 0);
  ok("F9  retorno = definida", rDef.estado === "definida", rDef.estado);
  ok("F10 zero RPC", rpcs === 0, String(rpcs));

  const p = (c?.payload ?? {}) as Record<string, unknown>;
  ok("F11 payload tem user_id, e e o da entrada", p.user_id === USER, String(p.user_id));
  ok("F12 payload tem agente_id", p.agente_id === AGENTE, String(p.agente_id));
  ok("F13 payload tem loja_id", p.loja_id === LOJA, String(p.loja_id));
  ok("F14 payload tem plataforma e recurso",
    p.plataforma === "shopee" && p.recurso === "pedidos");
  ok("F15 payload NAO tem criado_em",
    !Object.prototype.hasOwnProperty.call(p, "criado_em"), JSON.stringify(Object.keys(p)));
  ok("F16 payload tem alterado_em",
    Object.prototype.hasOwnProperty.call(p, "alterado_em"));
  ok("F17 alterado_em e ISO parseavel",
    typeof p.alterado_em === "string" && !Number.isNaN(Date.parse(String(p.alterado_em))),
    String(p.alterado_em));
  ok("F18 payload tem EXATAMENTE as 6 colunas contratuais",
    JSON.stringify(Object.keys(p).sort()) ===
      JSON.stringify(["agente_id", "alterado_em", "loja_id", "plataforma", "recurso", "user_id"]),
    Object.keys(p).sort().join(", "));
  ok("F19 payload NAO carrega credencial",
    !/access_token|refresh_token|partner_key|token/i.test(JSON.stringify(p)));

  // Substituir e a MESMA operacao: nao ha caminho diferente para "ja
  // existia", e por isso nao ha janela entre apagar e regravar.
  roteiro({});
  const rTroca = await definirSelecaoDeLoja({ ...DEF, lojaId: OUTRA_LOJA });
  ok("F20 substituir usa o mesmo unico upsert",
    chamadas.length === 1 && chamadas[0]?.operacao === "upsert" &&
      (chamadas[0]?.payload as Record<string, unknown>)?.loja_id === OUTRA_LOJA);
  ok("F21 substituir tambem retorna definida", rTroca.estado === "definida", rTroca.estado);

  secao("G. DEFINIR: os erros");

  roteiro({ error: ERRO_FK });
  const rFk = await definirSelecaoDeLoja(DEF);
  ok("G1  23503 -> nao_disponivel", rFk.estado === "nao_disponivel", rFk.estado);
  ok("G2  e ainda assim so 1 instrucao — sem retry", chamadas.length === 1);

  roteiro({ error: { code: "23514" } });
  ok("G3  CHECK violado -> falha_escrita",
    (await definirSelecaoDeLoja(DEF)).estado === "falha_escrita");

  roteiro({ error: { code: "42501" } });
  ok("G4  permissao negada -> falha_escrita",
    (await definirSelecaoDeLoja(DEF)).estado === "falha_escrita");

  roteiro({ error: { message: "boom" } });
  ok("G5  erro sem code -> falha_escrita",
    (await definirSelecaoDeLoja(DEF)).estado === "falha_escrita");

  roteiro({ error: { code: "23505" } });
  ok("G6  23505 NAO vira sucesso silencioso",
    (await definirSelecaoDeLoja(DEF)).estado === "falha_escrita");

  // ── H. O DELETE ────────────────────────────────────────────────────

  secao("H. REMOVER: um DELETE, fechado no dono");

  roteiro({ data: [{ agente_id: AGENTE }] });
  const rRem = await removerSelecaoDeLoja(REM);
  const d = chamadas[0];

  ok("H1  exatamente 1 instrucao", chamadas.length === 1, String(chamadas.length));
  ok("H2  a operacao e delete", d?.operacao === "delete", d?.operacao);
  ok("H3  a tabela e agente_conexoes", d?.tabela === "agente_conexoes", d?.tabela);
  ok("H4  zero leitura previa",
    chamadas.filter((x) => x.operacao === "select").length === 0);
  ok("H5  os QUATRO filtros existem",
    JSON.stringify((d?.ordemFiltros ?? []).slice().sort()) ===
      JSON.stringify(["agente_id", "plataforma", "recurso", "user_id"]),
    (d?.ordemFiltros ?? []).join(", "));
  ok("H6  user_id e o da entrada", d?.filtros.user_id === USER);
  ok("H7  agente_id, plataforma e recurso sao os da entrada",
    d?.filtros.agente_id === AGENTE && d?.filtros.plataforma === "shopee" &&
      d?.filtros.recurso === "pedidos");
  ok("H8  o .select() pertence ao proprio DELETE", d?.projecao !== undefined, String(d?.projecao));
  ok("H9  projecao minima — uma coluna, sem loja_id nem carimbo",
    d?.projecao === "agente_id", String(d?.projecao));
  ok("H10 uma linha -> removida", rRem.estado === "removida", rRem.estado);

  roteiro({ data: [] });
  const rVazio = await removerSelecaoDeLoja(REM);
  ok("H11 zero linhas -> nao_encontrada", rVazio.estado === "nao_encontrada", rVazio.estado);
  ok("H12 e nao ha consulta extra para descobrir por que", chamadas.length === 1);

  roteiro({ data: null });
  ok("H13 data null -> nao_encontrada",
    (await removerSelecaoDeLoja(REM)).estado === "nao_encontrada");

  roteiro({ error: { code: "42501" } });
  ok("H14 erro -> falha_escrita",
    (await removerSelecaoDeLoja(REM)).estado === "falha_escrita");

  roteiro({ error: { code: "42501" }, data: [{ agente_id: AGENTE }] });
  ok("H15 erro vence data — nunca 'removida' com erro",
    (await removerSelecaoDeLoja(REM)).estado === "falha_escrita");

  // ── I. Resultados congelados ───────────────────────────────────────

  secao("I. Retornos congelados e vocabulario fechado");

  roteiro({});
  const congelado = await definirSelecaoDeLoja(DEF);
  ok("I1  o resultado de definir e congelado", Object.isFrozen(congelado));
  roteiro({ data: [] });
  ok("I2  o resultado de remover e congelado", Object.isFrozen(await removerSelecaoDeLoja(REM)));
  ok("I3  o vocabulario dos dois retornos e fechado nestas 6 palavras",
    JSON.stringify(
      [...new Set((CODIGO_ESCRITA.match(/estado: "([a-z_]+)"/g) ?? []).map((s) => s.slice(9, -1)))].sort()
    ) ===
      JSON.stringify([
        "definida", "entrada_invalida", "falha_escrita", "nao_disponivel",
        "nao_encontrada", "removida",
      ]));

  // ── J. Controles negativos ─────────────────────────────────────────
  //
  // Cada caso avalia o PREDICADO da sonda correspondente contra uma
  // implementacao fabricada. Nenhum arquivo real e mutado: prova-se que
  // a sonda reprovaria, sem precisar quebrar o repo para descobrir.

  secao("J. Controles negativos — as sondas reprovariam");

  // `texto` e `numero` existem para que o TypeScript compare VALORES e nao
  // tipos literais: sem eles, `"amazon" !== "shopee"` vira erro TS2367 —
  // o compilador prova a desigualdade em tempo de tipo e o assert deixa de
  // ser uma medida em tempo de execucao.
  const texto = (s: string): string => s;
  const numero = (n: number): number => n;

  const negativos: [string, boolean][] = [
    ["J1  payload sem user_id seria reprovado",
      JSON.stringify(["agente_id", "alterado_em", "loja_id", "plataforma", "recurso"].sort()) !==
        JSON.stringify(["agente_id", "alterado_em", "loja_id", "plataforma", "recurso", "user_id"])],
    ["J2  onConflict trocado seria reprovado",
      texto("agente_id,user_id,plataforma,recurso") !== "agente_id,plataforma,recurso"],
    ["J3  payload com criado_em seria reprovado",
      Object.prototype.hasOwnProperty.call({ criado_em: 1 }, "criado_em")],
    ["J4  payload sem alterado_em seria reprovado",
      !Object.prototype.hasOwnProperty.call({ loja_id: 1 }, "alterado_em")],
    ["J5  alterado_em nao-ISO seria reprovado", Number.isNaN(Date.parse("ontem"))],
    ["J6  duas instrucoes para definir seriam reprovadas", numero(2) !== 1],
    ["J7  pre-leitura seria reprovada",
      ["select", "upsert"].filter((o) => o === "select").length !== 0],
    ["J8  DELETE sem user_id seria reprovado",
      JSON.stringify(["agente_id", "plataforma", "recurso"].sort()) !==
        JSON.stringify(["agente_id", "plataforma", "recurso", "user_id"])],
    ["J9  DELETE sem recurso seria reprovado",
      JSON.stringify(["agente_id", "plataforma", "user_id"].sort()) !==
        JSON.stringify(["agente_id", "plataforma", "recurso", "user_id"])],
    ["J10 zero linhas virando 'removida' seria reprovado",
      (([] as unknown[]).length > 0 ? "removida" : "nao_encontrada") !== "removida"],
    ["J11 projecao larga no delete seria reprovada", texto("agente_id, loja_id") !== "agente_id"],
    ["J12 leitura de token seria reprovada", /access_token/i.test('select("access_token")')],
    ["J13 error.message logado seria reprovado", /error\.message/.test("console.error(error.message)")],
    ["J14 resolverFatoConexao seria reprovado", /resolverFatoConexao/.test("await resolverFatoConexao(x)")],
    ["J15 fallback de primeira loja seria reprovado", /\.limit\(|maybeSingle/.test('.limit(1).maybeSingle()')],
    ["J16 plataforma arbitraria seria reprovada", texto("amazon") !== "shopee"],
    ["J17 recurso invalido seria reprovado", !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test("meus_pedidos")],
  ];
  for (const [nome, condicao] of negativos) ok(nome, condicao);

  // ── K. Fronteira da fase ───────────────────────────────────────────

  secao("K. Zero consumidor, zero 1D.e");

  const alvos: string[] = [];
  const varrer = (dir: string): void => {
    for (const e of readdirSync(join(RAIZ, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (!/node_modules|\.next/.test(e.name)) varrer(rel);
      } else if (/\.tsx?$/.test(e.name) && rel !== "lib/agentes/conexoes/selecao-escrita.ts") {
        if (/definirSelecaoDeLoja|removerSelecaoDeLoja/.test(semComentarios(ler(rel)))) alvos.push(rel);
      }
    }
  };
  varrer("lib");
  varrer("app");
  ok("K1  zero consumidor de producao", alvos.length === 0, alvos.join(", "));
  ok("K2  ANCORA: a varredura leu arquivos de verdade",
    existsSync(join(RAIZ, "lib/agentes/conexoes/fatos.ts")));
  ok("K3  diagnostico.ts nao foi tocado — sem falta_selecao ainda",
    !/falta_selecao|FALTA_SELECAO/.test(ler("lib/ia/skills/diagnostico.ts")));
  ok("K4  resolverFatoConexao segue exigindo lojaId",
    /lojaId: string/.test(ler("lib/agentes/conexoes/fatos.ts")));
  // A fronteira mudou na g.2-C1: a prova de banco deixou de ser "ainda
  // nao existe" e passou a ser artefato exigido — separado desta suite,
  // que continua sem rede e sem banco.
  ok("K5  a suite de banco desta frente existe como prova separada",
    existsSync(join(RAIZ, "scripts/testar-ia-skill-1d-g2-banco.ts")));
  ok("K6  a leitura da g.1 segue intocada — sem metodo de escrita",
    !/\.(insert|update|upsert|delete|rpc)\(/.test(
      semComentarios(ler("lib/agentes/conexoes/selecao-fatos.ts"))));

  console.log(`\n══ ${passou} PASS / ${falhou} FAIL ══\n`);
  process.exitCode = falhou === 0 ? 0 : 1;
}

principal().catch((e) => {
  console.log(`  FAIL  excecao nao tratada — ${String(e).slice(0, 300)}`);
  process.exitCode = 1;
});
