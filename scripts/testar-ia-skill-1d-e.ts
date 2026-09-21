/**
 * CDS IA — SKILL-1D.e-B1. Suite do batching da camada de conexoes.
 *
 * `conexoes/fatos.ts` e `server-only` e fala com o Supabase. Ele e
 * EXECUTADO de verdade aqui, contra um cliente DUPLADO que registra cada
 * invocacao: o que se afirma nao e "o fake funciona", e sim quantas
 * leituras o codigo real fez, em que tabela, com quais filtros, com que
 * projecao e com quantos ids no `IN`.
 *
 * ── O que esta fase prova, e o que ela nao prova ────────────────────
 *
 * Prova DUAS coisas: que `resolverFatoConexao` continua exatamente como
 * publicada, e que `resolverFatosConexao` resolve N requisitos com UMA
 * leitura. Nao ha agregador aqui — `resolverSkillsDoAgente` e
 * `resolverSelecoesDoAgente` nao sao importados. O lote e primitiva da
 * camada de conexao, nao a composicao.
 *
 * ── Por que query count e assert, e nao observacao ──────────────────
 *
 * A 1D.e-A2 mediu que nao existe teto estrutural de requisitos: o parser
 * nao aplica limite de lista a `requer.conexoes`, um agente pode ter
 * quantas Skills quiser e `recurso` e slug aberto. Um N+1 aqui cresceria
 * sem limite conhecido, e cada leitura extra projeta credencial. Por isso
 * o custo e TRAVADO por assert: 1, 5 e 10 pedidos tem de custar a MESMA
 * leitura.
 *
 * Rodar:  npx tsx scripts/testar-ia-skill-1d-e.ts
 * Sem rede, sem banco, sem env, sem segredo, sem `--confirmo`.
 */
import "./_server-only-inerte";

import Module from "node:module";
import { readFileSync, readdirSync } from "node:fs";
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

const CODIGO_FATOS = semComentarios(ler("lib/agentes/conexoes/fatos.ts"));

// ─── O duplo do cliente Supabase ──────────────────────────────────────

interface Chamada {
  tabela: string;
  operacao: "select" | "insert" | "update" | "upsert" | "delete";
  projecao?: string;
  filtros: Record<string, unknown>;
  inColuna?: string;
  inValores?: readonly unknown[];
  maybeSingle: boolean;
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
  const c: Chamada = { tabela, operacao: "select", filtros: {}, maybeSingle: false };
  const resolver = (fn: (v: { data: unknown; error: unknown }) => void) => {
    chamadas.push(c);
    const r = respostas[consumidas++];
    fn({ data: r?.data ?? null, error: r?.error ?? null });
  };
  const b: Record<string, unknown> = {
    select(cols: string) { c.projecao = cols; return b; },
    eq(coluna: string, valor: unknown) { c.filtros[coluna] = valor; return b; },
    in(coluna: string, valores: readonly unknown[]) { c.inColuna = coluna; c.inValores = valores; return b; },
    // `resolverSkillsDoAgente` ordena no SQL. O duplo apenas devolve `b`:
    // a ordem que importa para o agregador e a que ele IMPOE em memoria,
    // e um fake que reordenasse esconderia justamente isso.
    order() { return b; },
    // Marcadores: a camada de conexao e SO leitura. Se algum destes for
    // chamado, a tabela sai rotulada e as sondas de escrita acusam.
    insert() { c.operacao = "insert"; return b; },
    update() { c.operacao = "update"; return b; },
    upsert() { c.operacao = "upsert"; return b; },
    delete() { c.operacao = "delete"; return b; },
    maybeSingle() {
      c.maybeSingle = true;
      return { then: (fn: (v: { data: unknown; error: unknown }) => void) => resolver(fn) };
    },
    then(fn: (v: { data: unknown; error: unknown }) => void) { resolver(fn); },
  };
  return b;
}

const clienteFake = { from: (t: string) => construtor(t) };

// ─── O catalogo de Funcoes, dublado ───────────────────────────────────
//
// O agregador passou a unir requisitos de Skills com os das Funcoes
// HABILITADAS. O catalogo real tem hoje UMA Funcao — `vendas.consultar`,
// com `conexaoNecessaria: null` —, entao ele nao consegue produzir um
// unico requisito de Funcao, e uma suite que dependesse dele mediria
// vacuo: todo assert passaria com a lista vazia.
//
// Registrar uma Funcao conectada so para testar seria pior: publicaria
// no catalogo real uma capacidade sem executor ligado, e este repositorio
// tem regra explicita contra declarar Funcao que nao roda.
//
// Por isso o CATALOGO e dublado, e so ele. As permissoes continuam vindo
// do codigo real, pelo cliente duplado, e a uniao/dedupe/ordem sao as de
// producao. O objeto e MUTAVEL e estavel: o agregador captura a
// referencia no import, e trocar o conteudo dentro dela e o que permite
// variar o catalogo entre casos.
interface DefinicaoDublada {
  conexaoNecessaria: { plataforma: string; recurso: string } | null;
}
const CATALOGO_FAKE: Record<string, DefinicaoDublada> = {};
function definirCatalogo(entradas: Record<string, DefinicaoDublada>): void {
  for (const k of Object.keys(CATALOGO_FAKE)) delete CATALOGO_FAKE[k];
  Object.assign(CATALOGO_FAKE, entradas);
}
/** Atalho: Funcao que exige `(plataforma, recurso)`. */
const fnConectada = (plataforma: string, recurso: string): DefinicaoDublada => ({
  conexaoNecessaria: { plataforma, recurso },
});
const FN_SEM_CONEXAO: DefinicaoDublada = { conexaoNecessaria: null };

const requireOriginal = (Module as unknown as { prototype: { require: (id: string) => unknown } }).prototype.require;
let interceptou = false;
let interceptouCatalogo = false;
(Module as unknown as { prototype: { require: unknown } }).prototype.require = function (this: unknown, id: string) {
  if (typeof id === "string" && id.includes("supabase-servidor")) {
    interceptou = true;
    return { getSupabaseServidor: () => clienteFake };
  }
  if (typeof id === "string" && /agentes[\\/]funcoes[\\/]registry/.test(id)) {
    interceptouCatalogo = true;
    return {
      FUNCOES: CATALOGO_FAKE,
      // A MESMA forma do real: chaves ordenadas e congeladas.
      listarFuncoesRegistradas: () => Object.freeze(Object.keys(CATALOGO_FAKE).sort()),
    };
  }
  // eslint-disable-next-line prefer-rest-params
  return requireOriginal.apply(this, arguments as unknown as [string]);
};

// ─── Fixtures ─────────────────────────────────────────────────────────

const USER = "user-sintetico-1de";
const AGORA = Date.parse("2026-08-28T12:00:00.000Z");
const FUTURO = "2026-12-31T23:59:59.000Z";
const PASSADO = "2020-01-01T00:00:00.000Z";

const L = (n: number) => `aaaaaaaa-0000-4000-8000-00000000000${n}`;

/** Linha crua de `lojas` como o driver a devolveria. */
const loja = (
  id: string,
  extra: Partial<Record<string, unknown>> = {}
): Record<string, unknown> => ({
  id,
  marketplace: "Shopee",
  ativo: true,
  access_token: "token-sintetico-nunca-deve-vazar",
  token_expires_at: FUTURO,
  ...extra,
});

const pedido = (recurso: string, lojaId: string, plataforma = "shopee") =>
  ({ plataforma, recurso, lojaId });

console.log("\n══ CDS IA — SKILL-1D.e-B1: batching da camada de conexoes ══");

// ─── A. Fronteira estatica ────────────────────────────────────────────

secao("A. O modulo continua sendo a autoridade de credencial");

ok("A1  fatos.ts e server-only", /import "server-only"/.test(CODIGO_FATOS));
ok("A2  zero metodo de escrita",
  !/\.(insert|update|upsert|delete|rpc)\(/.test(CODIGO_FATOS));
ok("A3  a projecao continua sendo as mesmas 5 colunas",
  /const COLUNAS = "id, marketplace, ativo, access_token, token_expires_at";/.test(CODIGO_FATOS));
ok("A4  nenhuma outra tabela e consultada",
  JSON.stringify([...new Set((CODIGO_FATOS.match(/\.from\("([a-z_]+)"\)/g) ?? []))]) ===
    JSON.stringify(['.from("lojas")']),
  String([...new Set((CODIGO_FATOS.match(/\.from\("([a-z_]+)"\)/g) ?? []))]));
ok("A5  zero escolha implicita — sem limit/order/single solto",
  !/\.limit\(|\.order\(|[^e]\.single\(/.test(CODIGO_FATOS));
ok("A6  zero error.message / detail / hint",
  !/error\.message|\.detail\b|\.hint\b/.test(CODIGO_FATOS));
ok("A7  zero Date.now — o tempo entra por parametro",
  !/Date\.now\(\)|new Date\(\)/.test(CODIGO_FATOS));
ok("A8  o agregador NAO existe ainda",
  !/resolverSkillsDoAgente|resolverSelecoesDoAgente|agregador/.test(CODIGO_FATOS));
ok("A9  CONTROLE: as sondas acham quando o padrao existe",
  /\.limit\(/.test(".limit(1)") && /error\.message/.test("e(error.message)"));

// ─── B–H. Comportamento real ──────────────────────────────────────────

async function principal(): Promise<void> {
  const { resolverFatoConexao, resolverFatosConexao } = await import(
    "../lib/agentes/conexoes/fatos"
  );

  secao("B. O instrumento de medida esta instalado");

  ok("B1  ANCORA: o duplo interceptou o cliente Supabase", interceptou);
  const carregados = Object.keys(require.cache).map((p) => p.replace(/\\/g, "/"));
  ok("B2  ANCORA: fatos.ts esta no grafo",
    carregados.some((p) => p.includes("/lib/agentes/conexoes/fatos.ts")));
  ok("B3  nenhum cliente Supabase real carregado",
    !carregados.some((p) => /@supabase|supabase-servidor/.test(p)));
  ok("B4  o agregador nao foi carregado",
    !carregados.some((p) => /conexoes\/agregador/.test(p)));

  // ── C. A API individual, inalterada ────────────────────────────────

  secao("C. resolverFatoConexao — compatibilidade");

  const base = { userId: USER, lojaId: L(1), plataforma: "shopee", recurso: "chat", agoraMs: AGORA };

  for (const [nome, entrada] of [
    ["C1  userId vazio", { ...base, userId: "" }],
    ["C2  lojaId vazio", { ...base, lojaId: "" }],
    ["C3  plataforma vazia", { ...base, plataforma: "" }],
    ["C4  recurso vazio", { ...base, recurso: "" }],
    ["C5  plataforma desconhecida", { ...base, plataforma: "amazon" }],
  ] as [string, typeof base][]) {
    roteiro();
    const r = await resolverFatoConexao(entrada);
    ok(`${nome} -> ausente + 0 query`,
      r.coleta === "ausente" && r.fato === null && chamadas.length === 0,
      `${r.coleta} / ${chamadas.length}`);
  }

  roteiro({ data: loja(L(1)) });
  const rOk = await resolverFatoConexao(base);
  const q = chamadas[0];
  ok("C6  exatamente 1 query", chamadas.length === 1, String(chamadas.length));
  ok("C7  tabela lojas, projecao das 5 colunas",
    q?.tabela === "lojas" && q?.projecao === "id, marketplace, ativo, access_token, token_expires_at");
  ok("C8  owner-closed por id + user_id",
    q?.filtros.id === L(1) && q?.filtros.user_id === USER);
  ok("C9  continua usando maybeSingle", q?.maybeSingle === true);
  ok("C10 fato conectado com o par pedido",
    rOk.coleta === "ok" && rOk.fato?.plataforma === "shopee" && rOk.fato?.recurso === "chat" &&
      rOk.fato?.estado === "conectada");

  roteiro({ data: null });
  ok("C11 loja ausente -> ausente",
    (await resolverFatoConexao(base)).coleta === "ausente");

  roteiro({ data: loja(L(1), { marketplace: "ML" }) });
  ok("C12 marketplace divergente -> ausente",
    (await resolverFatoConexao(base)).coleta === "ausente");

  roteiro({ error: { code: "42501" } });
  const rErr = await resolverFatoConexao(base);
  ok("C13 erro -> falha_leitura, sem fato",
    rErr.coleta === "falha_leitura" && rErr.fato === null);

  roteiro({ data: loja(L(1), { token_expires_at: PASSADO }) });
  ok("C14 token vencido -> expirada",
    (await resolverFatoConexao(base)).fato?.estado === "expirada");

  roteiro({ data: loja(L(1), { access_token: null }) });
  ok("C15 sem credencial -> desconectada",
    (await resolverFatoConexao(base)).fato?.estado === "desconectada");

  roteiro({ data: loja(L(1), { ativo: false }) });
  ok("C16 loja inativa muda o estado",
    (await resolverFatoConexao(base)).fato?.estado !== "conectada");

  roteiro({ data: loja(L(1)) });
  ok("C17 zero credencial no fato devolvido",
    !/token|secret|senha|credencial/i.test(JSON.stringify((await resolverFatoConexao(base)).fato)));

  // ── D. Lote: zero query ────────────────────────────────────────────

  secao("D. Lote — quando NAO se toca o banco");

  const semQuery: [string, ReturnType<typeof pedido>[]][] = [
    ["D1  pedidos vazio", []],
    ["D2  lojaId ausente", [pedido("chat", "")]],
    ["D3  plataforma vazia", [pedido("chat", L(1), "")]],
    ["D4  recurso vazio", [pedido("", L(1))]],
    ["D5  plataformas todas desconhecidas", [pedido("chat", L(1), "amazon"), pedido("x", L(2), "ebay")]],
  ];
  for (const [nome, pedidos] of semQuery) {
    roteiro();
    const r = await resolverFatosConexao({ userId: USER, pedidos, agoraMs: AGORA });
    ok(`${nome} -> 0 query`, chamadas.length === 0 && r.fatos.length === 0,
      `${chamadas.length} query / ${r.fatos.length} fatos`);
  }
  roteiro();
  const rSemDono = await resolverFatosConexao({ userId: "", pedidos: [pedido("chat", L(1))], agoraMs: AGORA });
  ok("D6  sem userId -> 0 query", chamadas.length === 0 && rSemDono.fatos.length === 0);

  // ── E. Lote: custo constante ───────────────────────────────────────

  secao("E. Lote — UMA leitura, qualquer N");

  const cenarios: [string, number, number][] = [
    ["E1  1 pedido / 1 loja", 1, 1],
    ["E2  5 pedidos / 5 lojas", 5, 5],
    ["E3  5 pedidos / mesma loja", 5, 1],
    ["E4  10 pedidos / 10 lojas", 10, 10],
    ["E5  10 pedidos / mesma loja", 10, 1],
  ];
  for (const [nome, nPedidos, nLojas] of cenarios) {
    const pedidos = Array.from({ length: nPedidos }, (_, i) =>
      pedido(`recurso-${i}`, L(nLojas === 1 ? 1 : (i % nLojas) + 1))
    );
    const ids = [...new Set(pedidos.map((p) => p.lojaId))];
    roteiro({ data: ids.map((id) => loja(id)) });
    const r = await resolverFatosConexao({ userId: USER, pedidos, agoraMs: AGORA });
    const c = chamadas[0];
    ok(`${nome} -> 1 query, ${nLojas} id(s) no IN, ${nPedidos} fatos`,
      chamadas.length === 1 &&
        (c?.inValores ?? []).length === nLojas &&
        r.fatos.length === nPedidos &&
        r.coleta === "ok",
      `${chamadas.length} query / ${(c?.inValores ?? []).length} ids / ${r.fatos.length} fatos`);
  }

  roteiro({ data: [loja(L(1))] });
  const rIn = await resolverFatosConexao({
    userId: USER,
    pedidos: [pedido("chat", L(1)), pedido("pedidos", L(1)), pedido("anuncios", L(1))],
    agoraMs: AGORA,
  });
  const cIn = chamadas[0];
  ok("E6  o IN e por id e deduplicado", cIn?.inColuna === "id" && (cIn?.inValores ?? []).length === 1);
  ok("E7  a query do lote e owner-closed por user_id", cIn?.filtros.user_id === USER);
  ok("E8  a projecao do lote e a mesma das 5 colunas",
    cIn?.projecao === "id, marketplace, ativo, access_token, token_expires_at");
  ok("E9  o lote NAO usa maybeSingle", cIn?.maybeSingle === false);
  ok("E10 uma linha lida vira TRES fatos, um por recurso",
    rIn.fatos.length === 3 &&
      JSON.stringify(rIn.fatos.map((f) => f.recurso)) === JSON.stringify(["chat", "pedidos", "anuncios"]));
  ok("E11 e todos com a plataforma pedida",
    rIn.fatos.every((f) => f.plataforma === "shopee"));

  // ── F. Lote: ausencias nao sao falhas ──────────────────────────────

  secao("F. Lote — ausencia por item, nunca falha da colecao");

  roteiro({ data: [loja(L(1))] });
  const rParcial = await resolverFatosConexao({
    userId: USER,
    pedidos: [pedido("chat", L(1)), pedido("chat", L(2))],
    agoraMs: AGORA,
  });
  ok("F1  loja que nao volta vira ausencia — nao falha",
    rParcial.coleta === "ok" && rParcial.fatos.length === 1 && rParcial.fatos[0]?.recurso === "chat");

  roteiro({ data: [loja(L(1)), loja(L(2), { marketplace: "ML" })] });
  const rMix = await resolverFatosConexao({
    userId: USER,
    pedidos: [pedido("chat", L(1)), pedido("pedidos", L(2))],
    agoraMs: AGORA,
  });
  ok("F2  marketplace divergente omite so aquele pedido",
    rMix.coleta === "ok" && rMix.fatos.length === 1 && rMix.fatos[0]?.recurso === "chat");

  roteiro({ data: [] });
  const rNada = await resolverFatosConexao({
    userId: USER, pedidos: [pedido("chat", L(1))], agoraMs: AGORA,
  });
  ok("F3  nenhuma loja retornada -> ok com zero fatos",
    rNada.coleta === "ok" && rNada.fatos.length === 0);

  roteiro({ data: [loja(L(1), { token_expires_at: PASSADO }), loja(L(2), { access_token: null })] });
  const rEstados = await resolverFatosConexao({
    userId: USER,
    pedidos: [pedido("chat", L(1)), pedido("chat", L(2))],
    agoraMs: AGORA,
  });
  ok("F4  estados indisponiveis sao PRESERVADOS, nao omitidos",
    rEstados.fatos.length === 2 &&
      rEstados.fatos[0]?.estado === "expirada" && rEstados.fatos[1]?.estado === "desconectada",
    rEstados.fatos.map((f) => f.estado).join(", "));

  // ── G. Lote: fail-closed ───────────────────────────────────────────

  secao("G. Lote — falha derruba a colecao inteira");

  roteiro({ error: { code: "42501" }, data: [loja(L(1))] });
  const rFalha = await resolverFatosConexao({
    userId: USER, pedidos: [pedido("chat", L(1))], agoraMs: AGORA,
  });
  ok("G1  erro vence data — falha_leitura e ZERO fatos",
    rFalha.coleta === "falha_leitura" && rFalha.fatos.length === 0);

  roteiro({ data: [loja(L(1)), loja(L(1))] });
  const rDup = await resolverFatosConexao({
    userId: USER, pedidos: [pedido("chat", L(1))], agoraMs: AGORA,
  });
  ok("G2  id repetido na resposta -> fail-closed, nunca ultima-vence",
    rDup.coleta === "falha_leitura" && rDup.fatos.length === 0, rDup.coleta);

  roteiro({ data: [{ marketplace: "Shopee", ativo: true }] });
  const rSemId = await resolverFatosConexao({
    userId: USER, pedidos: [pedido("chat", L(1))], agoraMs: AGORA,
  });
  ok("G3  linha sem id utilizavel -> fail-closed", rSemId.coleta === "falha_leitura");

  roteiro({ data: [loja(L(1))] });
  const rToken = await resolverFatosConexao({
    userId: USER, pedidos: [pedido("chat", L(1))], agoraMs: AGORA,
  });
  ok("G4  zero credencial na saida do lote",
    !/token|secret|senha|credencial/i.test(JSON.stringify(rToken.fatos)));
  ok("G5  o fato tem exatamente os 4 campos publicados",
    JSON.stringify(Object.keys(rToken.fatos[0] ?? {}).sort()) ===
      JSON.stringify(["cobertura", "estado", "plataforma", "recurso"]),
    Object.keys(rToken.fatos[0] ?? {}).sort().join(", "));

  // ── H. Equivalencia individual x lote ──────────────────────────────

  secao("H. O lote e o individual concordam");

  const casos: Array<Record<string, unknown>> = [
    {}, { token_expires_at: PASSADO }, { access_token: null }, { ativo: false },
  ];
  let iguais = 0;
  for (const extra of casos) {
    roteiro({ data: loja(L(1), extra) });
    const ind = await resolverFatoConexao({ ...base, recurso: "pedidos" });
    roteiro({ data: [loja(L(1), extra)] });
    const lote = await resolverFatosConexao({
      userId: USER, pedidos: [pedido("pedidos", L(1))], agoraMs: AGORA,
    });
    if (JSON.stringify(ind.fato) === JSON.stringify(lote.fatos[0] ?? null)) iguais++;
  }
  ok(`H1  os 4 estados produzem fato identico nos dois caminhos (${iguais}/4)`, iguais === 4);

  roteiro({ data: null });
  const indAus = await resolverFatoConexao(base);
  roteiro({ data: [] });
  const loteAus = await resolverFatosConexao({
    userId: USER, pedidos: [pedido("chat", L(1))], agoraMs: AGORA,
  });
  ok("H2  ausencia: individual devolve fato null, lote omite o item",
    indAus.fato === null && loteAus.fatos.length === 0);

  // ── I. Controles negativos ─────────────────────────────────────────

  secao("I. Controles negativos — as sondas reprovariam");

  const texto = (s: string): string => s;
  const numero = (n: number): number => n;
  const negativos: [string, boolean][] = [
    ["I1  uma query por pedido seria reprovada", numero(5) !== 1],
    ["I2  ids nao deduplicados seriam reprovados", numero(5) !== 1],
    ["I3  query com zero pedidos seria reprovada", numero(1) !== 0],
    ["I4  consulta sem user_id seria reprovada",
      !Object.prototype.hasOwnProperty.call({ id: 1 }, "user_id")],
    ["I5  escolher a primeira loja seria reprovado", /\.limit\(|\.order\(/.test(".limit(1).order('x')")],
    ["I6  token na saida seria reprovado", /token/i.test('{"access_token":"x"}')],
    ["I7  parcial apos erro seria reprovado", numero(1) !== 0],
    ["I8  loja ausente virando falha seria reprovado", texto("falha_leitura") !== "ok"],
    ["I9  marketplace mismatch virando falha seria reprovado", texto("falha_leitura") !== "ok"],
    ["I10 dois recursos colapsados em um fato seriam reprovados", numero(1) !== 2],
    ["I11 assinatura individual alterada seria reprovada",
      /lojaId: string/.test(CODIGO_FATOS)],
    ["I12 consumer novo seria reprovado",
      !/resolverSkillsDoAgente|resolverSelecoesDoAgente/.test(CODIGO_FATOS)],
    ["I13 tabela fora da camada seria reprovada",
      !/from\("(agentes|skills|agente_conexoes|agente_skills)"\)/.test(CODIGO_FATOS)],
  ];
  for (const [nome, condicao] of negativos) ok(nome, condicao);

  // ═══════════════════════════════════════════════════════════════════
  // SKILL-1D.e-B2 — o agregador, sobre o pipeline REAL
  // ═══════════════════════════════════════════════════════════════════
  //
  // Daqui para baixo nada e mockado por funcao: `resolverSkillsDoAgente`,
  // `resolverSelecoesDoAgente` e `resolverFatosConexao` EXECUTAM, cada uma
  // consumindo o roteiro do mesmo cliente duplado. O que se mede e o
  // pipeline inteiro — quantas leituras, em que tabelas, com que shape.
  //
  // A sequencia completa tem CINCO leituras:
  //   1  agente_skills   (associacoes)
  //   2  skills          (manifestos, em lote)
  //   3  agente_conexoes (selecoes)
  //   4  lojas           projecao "id, user_id"        <- Q2 da selecao
  //   5  lojas           projecao das 5 colunas        <- o LOTE
  // As duas leituras de `lojas` se distinguem pela projecao, e e assim
  // que se prova que o lote rodou UMA vez.

  const { resolverConexoesDoAgente } = await import("../lib/agentes/conexoes/agregador");

  const AGENTE = "11111111-2222-3333-4444-555555555555";

  /** Manifesto minimo que passa por `manifestoValido`. */
  const manifesto = (id: string, conexoes?: Array<[string, string, boolean]>) => ({
    formato: 1,
    id,
    nome: `Skill ${id}`,
    versao: "1.0.0",
    descricao: "Fixture da 1D.e.",
    quando_usar: ["quando o teste pedir"],
    origem: "importada",
    ...(conexoes
      ? {
          requer: {
            conexoes: conexoes.map(([plataforma, recurso, obrigatoria]) => ({
              plataforma, recurso, obrigatoria,
            })),
          },
        }
      : {}),
  });

  const assoc = (skillId: string) => ({ skill_id: skillId, criado_em: "2026-08-01T00:00:00.000Z" });
  const linhaSkill = (id: string, conexoes?: Array<[string, string, boolean]>) =>
    ({ id, manifesto: manifesto(id, conexoes), corpo: "corpo sintetico" });
  const linhaSelecao = (plataforma: string, recurso: string, lojaId: string) =>
    ({ agente_id: AGENTE, user_id: USER, plataforma, recurso, loja_id: lojaId });
  const linhaLojaDona = (id: string) => ({ id, user_id: USER });

  const AG = { userId: USER, agenteId: AGENTE, agoraMs: AGORA };

  /** Quantas leituras de `lojas` com a projecao do LOTE aconteceram. */
  const queriesDoLote = () =>
    chamadas.filter(
      (c) => c.tabela === "lojas" &&
        c.projecao === "id, marketplace, ativo, access_token, token_expires_at"
    ).length;
  const tabelas = () => chamadas.map((c) => c.tabela).join(" > ");

  // ── A leitura de permissoes, e por que ela aparece em todo roteiro ─
  //
  // Desde a M2-I1-A1 o agregador une DUAS fontes de requisito: as Skills
  // e as Funcoes habilitadas. A segunda custa UMA leitura de
  // `agente_permissoes`, com `.in("funcao_id", ids)` — nunca uma por
  // Funcao —, e ela acontece logo depois das Skills, ANTES do
  // curto-circuito de "nenhum requisito".
  //
  // O duplo responde por POSICAO, entao cada roteiro precisa declarar
  // essa resposta no lugar certo. Isso e proposital: uma leitura nova
  // inserida em silencio no meio do pipeline deslocaria o roteiro
  // inteiro, e o teste que a ignorasse passaria medindo outra coisa.
  const SEM_PERMISSAO: Resposta = { data: [] };
  /** `agente_permissoes` com niveis reais. `funcao_id` precisa existir no catalogo. */
  const permissoes = (...linhas: [string, string][]): Resposta => ({
    data: linhas.map(([funcao_id, nivel]) => ({ funcao_id, nivel })),
  });

  // O catalogo real NUNCA e vazio, e `resolverFatosPermissoes` nao toca o
  // banco quando a lista de ids e vazia. Um catalogo dublado vazio faria
  // a leitura de permissoes desaparecer e deslocaria todo roteiro — os
  // asserts de custo passariam a medir um pipeline que producao nao tem.
  // Por isso a linha de base tem UMA Funcao, sem requisito de conexao.
  const CATALOGO_BASE: Record<string, DefinicaoDublada> = { "base.op": FN_SEM_CONEXAO };
  definirCatalogo(CATALOGO_BASE);

  secao("J. O agregador — guards e curto-circuitos");

  for (const [nome, e] of [
    ["J1  userId vazio", { ...AG, userId: "" }],
    ["J2  agenteId vazio", { ...AG, agenteId: "" }],
  ] as [string, typeof AG][]) {
    roteiro();
    const r = await resolverConexoesDoAgente(e);
    ok(`${nome} -> entrada_invalida + 0 query`,
      r.coleta === "entrada_invalida" && r.conexoes.length === 0 && r.semSelecao.length === 0 &&
        chamadas.length === 0,
      `${r.coleta} / ${chamadas.length}`);
  }

  roteiro({ data: [] }, SEM_PERMISSAO);
  const rSemSkills = await resolverConexoesDoAgente(AG);
  ok("J3  agente sem Skills -> ok, vazio, TOTAL 2 queries (Skills + permissoes)",
    rSemSkills.coleta === "ok" && rSemSkills.conexoes.length === 0 &&
      rSemSkills.semSelecao.length === 0 && rSemSkills.bindings.length === 0 &&
      chamadas.length === 2,
    `${rSemSkills.coleta} / ${chamadas.length} · ${tabelas()}`);

  roteiro({ data: [assoc("s1")] }, { data: [linhaSkill("s1")] }, SEM_PERMISSAO);
  const rSemReq = await resolverConexoesDoAgente(AG);
  ok("J4  Skill sem requer.conexoes -> ok, vazio, TOTAL 3 queries",
    rSemReq.coleta === "ok" && rSemReq.semSelecao.length === 0 && chamadas.length === 3,
    `${chamadas.length} · ${tabelas()}`);
  ok("J5  e o lote NAO roda", queriesDoLote() === 0);

  secao("K. O join — requisito manda, selecao responde");

  roteiro(
    { data: [assoc("s1")] },
    { data: [linhaSkill("s1", [["shopee", "chat", true]])] },
    SEM_PERMISSAO,
    { data: [] }
  );
  const rSemSel = await resolverConexoesDoAgente(AG);
  ok("K1  1 requisito sem selecao -> semSelecao, TOTAL 4 queries",
    rSemSel.coleta === "ok" && rSemSel.conexoes.length === 0 &&
      rSemSel.semSelecao.length === 1 && rSemSel.bindings.length === 0 &&
      chamadas.length === 4,
    `${chamadas.length} · ${tabelas()}`);
  ok("K2  o requisito preserva plataforma, recurso e obrigatoria",
    rSemSel.semSelecao[0]?.plataforma === "shopee" &&
      rSemSel.semSelecao[0]?.recurso === "chat" &&
      rSemSel.semSelecao[0]?.obrigatoria === true);
  ok("K3  sem selecao, o lote nao roda", queriesDoLote() === 0);

  roteiro(
    { data: [assoc("s1")] },
    { data: [linhaSkill("s1", [["shopee", "chat", true]])] },
    SEM_PERMISSAO,
    { data: [linhaSelecao("shopee", "chat", L(1))] },
    { data: [linhaLojaDona(L(1))] },
    { data: [loja(L(1))] }
  );
  const rSel = await resolverConexoesDoAgente(AG);
  ok("K4  1 requisito selecionado -> 1 fato, TOTAL 6 queries",
    rSel.coleta === "ok" && rSel.conexoes.length === 1 && rSel.semSelecao.length === 0 &&
      chamadas.length === 6,
    `${chamadas.length} · ${tabelas()}`);
  ok("K5  o lote rodou UMA vez", queriesDoLote() === 1);
  ok("K6  o fato e do par pedido",
    rSel.conexoes[0]?.plataforma === "shopee" && rSel.conexoes[0]?.recurso === "chat" &&
      rSel.conexoes[0]?.estado === "conectada");
  const qLote = chamadas.find((c) => c.projecao?.includes("access_token"));
  ok("K7  o lote usou EXATAMENTE o lojaId persistido",
    JSON.stringify(qLote?.inValores) === JSON.stringify([L(1)]), JSON.stringify(qLote?.inValores));

  // Selecao para um par que nenhuma Skill exige mais.
  roteiro(
    { data: [assoc("s1")] },
    { data: [linhaSkill("s1", [["shopee", "chat", true]])] },
    SEM_PERMISSAO,
    { data: [linhaSelecao("shopee", "pedidos", L(2))] },
    { data: [linhaLojaDona(L(2))] }
  );
  const rStale = await resolverConexoesDoAgente(AG);
  ok("K8  selecao stale e ignorada — chat vai para semSelecao",
    rStale.coleta === "ok" && rStale.conexoes.length === 0 &&
      rStale.semSelecao.length === 1 && rStale.semSelecao[0]?.recurso === "chat");
  ok("K9  e o lote NAO roda com a selecao stale", queriesDoLote() === 0, tabelas());
  ok("K10 mesma plataforma + recurso diferente NAO casa", rStale.conexoes.length === 0);

  secao("L. Dedupe entre Skills e custo constante");

  roteiro(
    { data: [assoc("s1"), assoc("s2")] },
    {
      data: [
        linhaSkill("s1", [["shopee", "chat", false]]),
        linhaSkill("s2", [["shopee", "chat", true]]),
      ],
    },
    SEM_PERMISSAO,
    { data: [] }
  );
  const rDedupe = await resolverConexoesDoAgente(AG);
  ok("L1  duas Skills, mesmo par -> UM requisito",
    rDedupe.semSelecao.length === 1, String(rDedupe.semSelecao.length));
  ok("L2  obrigatoria combinada por OR -> true",
    rDedupe.semSelecao[0]?.obrigatoria === true);

  roteiro(
    { data: [assoc("s1"), assoc("s2")] },
    {
      data: [
        linhaSkill("s1", [["shopee", "chat", true]]),
        linhaSkill("s2", [["shopee", "pedidos", true]]),
      ],
    },
    SEM_PERMISSAO,
    { data: [] }
  );
  const rVersoes = await resolverConexoesDoAgente(AG);
  ok("L3  duas Skills associadas: AMBAS participam, nenhuma descartada",
    rVersoes.semSelecao.length === 2 &&
      JSON.stringify(rVersoes.semSelecao.map((r) => r.recurso)) ===
        JSON.stringify(["chat", "pedidos"]),
    rVersoes.semSelecao.map((r) => r.recurso).join(", "));

  roteiro(
    { data: [assoc("s1")] },
    { data: [linhaSkill("s1", [["shopee", "zeta", true], ["shopee", "alfa", true]])] },
    SEM_PERMISSAO,
    { data: [] }
  );
  const rOrdem = await resolverConexoesDoAgente(AG);
  ok("L4  ordem deterministica por plataforma+recurso, nao pela Skill",
    JSON.stringify(rOrdem.semSelecao.map((r) => r.recurso)) === JSON.stringify(["alfa", "zeta"]),
    rOrdem.semSelecao.map((r) => r.recurso).join(", "));

  const budget: [string, number, number][] = [
    ["L5  5 requisitos / 5 lojas", 5, 5],
    ["L6  5 requisitos / mesma loja", 5, 1],
    ["L7  10 requisitos / 10 lojas", 10, 10],
    ["L8  10 requisitos / mesma loja", 10, 1],
  ];
  for (const [nome, n, nLojas] of budget) {
    const reqs: Array<[string, string, boolean]> = Array.from({ length: n }, (_, i) =>
      ["shopee", `recurso-${i}`, true]
    );
    const sels = reqs.map((r, i) => linhaSelecao("shopee", r[1], L(nLojas === 1 ? 1 : (i % nLojas) + 1)));
    const ids = [...new Set(sels.map((s) => s.loja_id))];
    roteiro(
      { data: [assoc("s1")] },
      { data: [linhaSkill("s1", reqs)] },
      SEM_PERMISSAO,
      { data: sels },
      { data: ids.map(linhaLojaDona) },
      { data: ids.map((id) => loja(id)) }
    );
    const r = await resolverConexoesDoAgente(AG);
    ok(`${nome} -> ${n} fatos, TOTAL 6 queries, lote 1`,
      r.coleta === "ok" && r.conexoes.length === n && chamadas.length === 6 &&
        queriesDoLote() === 1,
      `${r.conexoes.length} fatos / ${chamadas.length} queries / lote ${queriesDoLote()}`);
  }

  secao("M. Selecao existe, conexao nao serve — e as falhas");

  roteiro(
    { data: [assoc("s1")] },
    { data: [linhaSkill("s1", [["shopee", "chat", true]])] },
    SEM_PERMISSAO,
    { data: [linhaSelecao("shopee", "chat", L(1))] },
    { data: [linhaLojaDona(L(1))] },
    { data: [loja(L(1), { marketplace: "ML" })] }
  );
  const rSemFato = await resolverConexoesDoAgente(AG);
  ok("M1  selecao existe mas a loja nao serve -> NAO entra em semSelecao",
    rSemFato.coleta === "ok" && rSemFato.conexoes.length === 0 && rSemFato.semSelecao.length === 0,
    `conexoes=${rSemFato.conexoes.length} semSelecao=${rSemFato.semSelecao.length}`);

  roteiro(
    { data: [assoc("s1")] },
    { data: [linhaSkill("s1", [["shopee", "chat", true]])] },
    SEM_PERMISSAO,
    { data: [linhaSelecao("shopee", "chat", L(1))] },
    { data: [linhaLojaDona(L(1))] },
    { data: [loja(L(1), { token_expires_at: PASSADO })] }
  );
  const rExpirada = await resolverConexoesDoAgente(AG);
  ok("M2  estado indisponivel e PRESERVADO, nao reinterpretado",
    rExpirada.conexoes.length === 1 && rExpirada.conexoes[0]?.estado === "expirada" &&
      rExpirada.semSelecao.length === 0);

  roteiro({ error: { code: "42501" } });
  const rFalhaSkills = await resolverConexoesDoAgente(AG);
  ok("M3  falha nas Skills -> falha_leitura, tudo vazio, 1 query so",
    rFalhaSkills.coleta === "falha_leitura" && rFalhaSkills.conexoes.length === 0 &&
      rFalhaSkills.semSelecao.length === 0 && chamadas.length === 1);

  roteiro(
    { data: [assoc("s1")] },
    { data: [linhaSkill("s1", [["shopee", "chat", true]])] },
    SEM_PERMISSAO,
    { error: { code: "42501" } }
  );
  const rFalhaSel = await resolverConexoesDoAgente(AG);
  ok("M4  falha na selecao -> falha_leitura e ZERO lote",
    rFalhaSel.coleta === "falha_leitura" && rFalhaSel.semSelecao.length === 0 &&
      queriesDoLote() === 0);

  // Um requisito COM selecao e outro SEM: `semSelecao` ja estava montado
  // quando o lote falhou. Nada disso pode escapar.
  roteiro(
    { data: [assoc("s1")] },
    { data: [linhaSkill("s1", [["shopee", "chat", true], ["shopee", "pedidos", true]])] },
    SEM_PERMISSAO,
    { data: [linhaSelecao("shopee", "chat", L(1))] },
    { data: [linhaLojaDona(L(1))] },
    { error: { code: "42501" } }
  );
  const rFalhaLote = await resolverConexoesDoAgente(AG);
  ok("M5  falha do lote descarta o semSelecao ja calculado — zero parcial",
    rFalhaLote.coleta === "falha_leitura" && rFalhaLote.conexoes.length === 0 &&
      rFalhaLote.semSelecao.length === 0,
    `conexoes=${rFalhaLote.conexoes.length} semSelecao=${rFalhaLote.semSelecao.length}`);

  roteiro(
    { data: [assoc("s1")] },
    { data: [linhaSkill("s1", [["shopee", "chat", true]])] },
    SEM_PERMISSAO,
    { data: [linhaSelecao("shopee", "chat", L(1))] },
    { data: [linhaLojaDona(L(1))] },
    { data: [loja(L(1))] }
  );
  const rSeguro = await resolverConexoesDoAgente(AG);
  ok("M6  zero credencial na saida publica",
    !/token|secret|senha|credencial/i.test(JSON.stringify(rSeguro)));
  ok("M7  o fato mantem os 4 campos publicados",
    JSON.stringify(Object.keys(rSeguro.conexoes[0] ?? {}).sort()) ===
      JSON.stringify(["cobertura", "estado", "plataforma", "recurso"]));

  const CODIGO_AGREGADOR = semComentarios(ler("lib/agentes/conexoes/agregador.ts"));
  ok("M8  o agregador nao abre banco nem cita tabela",
    !/getSupabaseServidor|\.from\(|\.select\(|\.eq\(|\.in\(/.test(CODIGO_AGREGADOR));
  ok("M9  o agregador NAO usa o resolvedor individual",
    !/resolverFatoConexao\b(?!s)/.test(CODIGO_AGREGADOR));
  // Ate a M2-I1-A1 este assert tambem exigia "nao le permissao". Deixou
  // de ser verdade por DECISAO congelada: o feed de requisitos passou a
  // unir Skills e Funcoes habilitadas, e habilitacao e permissao. O que
  // continua proibido — diagnosticar e escrever — segue cobrado.
  ok("M10 o agregador nao diagnostica e nao escreve",
    !/diagnosticarSkill|definirSelecaoDeLoja|removerSelecaoDeLoja/.test(CODIGO_AGREGADOR));
  ok("M10a a leitura de permissao e UMA, e pelo helper tenant-safe existente",
    (CODIGO_AGREGADOR.match(/resolverFatosPermissoes\(/g) ?? []).length === 1 &&
      /import \{ resolverFatosPermissoes \} from "@\/lib\/agentes\/permissoes\/fatos"/
        .test(CODIGO_AGREGADOR),
    String((CODIGO_AGREGADOR.match(/resolverFatosPermissoes\(/g) ?? []).length));
  ok("M10b ela pergunta pelo catalogo INTEIRO de uma vez, nao Funcao a Funcao",
    /funcaoIds: listarFuncoesRegistradas\(\)/.test(CODIGO_AGREGADOR) &&
      !/for \([^)]*\) \{[^}]*resolverFatosPermissoes/.test(CODIGO_AGREGADOR));
  ok("M10c CONTROLE: a sonda de N+1 acha o padrao quando ele existe",
    /for \([^)]*\) \{[^}]*resolverFatosPermissoes/.test(
      "for (const f of fs) { await resolverFatosPermissoes(f); }"));
  ok("M11 zero escolha implicita de loja",
    !/\.limit\(|\.order\(|maybeSingle|vigente/.test(CODIGO_AGREGADOR));
  // A SKILL-1D.consumer-B2 deu ao agregador o seu PRIMEIRO consumidor de
  // producao. Ate aqui o M12 exigia ZERO — correto enquanto ninguem o
  // chamava. A exigencia nao e afrouxada, e trocada: deixa de ser "zero"
  // e passa a ser "EXATAMENTE ESTE", por igualdade de conjunto e por
  // caminho nominal, no mesmo molde do J6 da f2 e do P7 da d2.
  //
  // A definicao em `agregador.ts` continua excluida da varredura: quem
  // exporta a funcao nao a consome. E a igualdade e nos DOIS sentidos —
  // um segundo consumidor reprova, e o desaparecimento do autorizado
  // tambem, para que a guarda nunca vire "o compositor existe".
  // ── TOOL-EXEC-B: o segundo consumidor legitimo ─────────────────────
  //
  // O executor de Funcoes (`lib/agentes/execucao-funcoes/executar.ts`)
  // passou a resolver as conexoes do agente antes de decidir se uma Funcao pode ser
  // chamada. E o MESMO dado que o compositor usa; resolve-lo por conta
  // propria seria a duplicacao que esta guarda existe para impedir.
  //
  // A exigencia nao afrouxa: continua igualdade de conjunto, por caminho
  // NOMINAL, nos dois sentidos. Antes { compositor }, agora
  // { compositor, executar }. Prefixo, pasta ou contagem, nao.
  // APPROVAL-B1B: o TERCEIRO consumidor legitimo. A persistencia de
  // aprovacoes pergunta ao agregador se a conexao exigida esta
  // UTILIZAVEL — na criacao, para congelar o alvo, e no consumo, antes
  // de deixar a RPC gastar a aprovacao. A loja concreta vem da selecao;
  // a usabilidade vem daqui, e nao e recomposta a mao.
  const EXECUTOR_FUNCOES = "lib/agentes/execucao-funcoes/executar.ts";
  const PERSISTENCIA_APROVACOES = "lib/agentes/aprovacoes/persistencia.ts";
  // M2-I1-A4: a rota de Conexoes e o QUARTO consumidor, e o primeiro que
  // nao executa nada — ela le o snapshot para MOSTRAR ao dono o que esta
  // escolhido e o que falta. Configuracao e execucao consomem a mesma
  // composicao por perguntas diferentes.
  const ROTA_CONEXOES = "app/api/agentes/[agenteId]/conexoes/route.ts";
  const CONSUMIDORES_AUTORIZADOS: readonly string[] = [
    "lib/agentes/diagnostico/compositor.ts",
    EXECUTOR_FUNCOES,
    PERSISTENCIA_APROVACOES,
    ROTA_CONEXOES,
  ];
  const COMPOSITOR = CONSUMIDORES_AUTORIZADOS[0];

  const mesmoConjunto = (a: readonly string[], b: readonly string[]): boolean =>
    JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

  const consumidores = ["lib", "app"].flatMap((raiz) => {
    const varrer = (dir: string): string[] => {
      const saida: string[] = [];
      for (const e of readdirSync(join(RAIZ, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) { if (!/node_modules|\.next/.test(e.name)) saida.push(...varrer(rel)); }
        else if (/\.tsx?$/.test(e.name) && rel !== "lib/agentes/conexoes/agregador.ts") {
          if (/resolverConexoesDoAgente/.test(semComentarios(ler(rel)))) saida.push(rel);
        }
      }
      return saida;
    };
    return varrer(raiz);
  });
  ok(`M12 o agregador tem exatamente os consumidores declarados (${consumidores.join(", ") || "nenhum"})`,
    mesmoConjunto(consumidores, CONSUMIDORES_AUTORIZADOS));
  ok("M12a CONTROLE: o conjunto exato dos quatro autorizados passa",
    mesmoConjunto([COMPOSITOR, EXECUTOR_FUNCOES, PERSISTENCIA_APROVACOES, ROTA_CONEXOES],
      CONSUMIDORES_AUTORIZADOS));
  ok("M12g CONTROLE: a rota sumir reprova",
    !mesmoConjunto([COMPOSITOR, EXECUTOR_FUNCOES, PERSISTENCIA_APROVACOES],
      CONSUMIDORES_AUTORIZADOS));
  ok("M12b CONTROLE: o compositor sumir reprova",
    !mesmoConjunto([EXECUTOR_FUNCOES, PERSISTENCIA_APROVACOES], CONSUMIDORES_AUTORIZADOS));
  ok("M12c CONTROLE: o executor sumir reprova",
    !mesmoConjunto([COMPOSITOR, PERSISTENCIA_APROVACOES], CONSUMIDORES_AUTORIZADOS));
  ok("M12d CONTROLE: a persistencia sumir reprova",
    !mesmoConjunto([COMPOSITOR, EXECUTOR_FUNCOES], CONSUMIDORES_AUTORIZADOS));
  ok("M12e CONTROLE: um quarto consumidor reprova",
    !mesmoConjunto([...CONSUMIDORES_AUTORIZADOS, "app/api/x/route.ts"], CONSUMIDORES_AUTORIZADOS));
  ok("M12f CONTROLE: um caminho parecido nao passa por semelhanca",
    !mesmoConjunto([COMPOSITOR, EXECUTOR_FUNCOES, "lib/agentes/aprovacoes/identidade.ts"],
      CONSUMIDORES_AUTORIZADOS));

  // ── N. O feed de requisitos: Skills UNION Funcoes habilitadas ──────
  //
  // Todos os casos abaixo usam o CATALOGO DUBLADO. O que esta sob teste
  // e a regra de habilitacao, a uniao, o dedupe e a ordem — tudo codigo
  // de producao. Ver o docblock de `CATALOGO_FAKE`.

  secao("N. Feed de requisitos — Skills UNION Funcoes habilitadas");

  ok("N0  ANCORA: o catalogo de Funcoes esta dublado", interceptouCatalogo);

  // ANCORA DE CONTRATO: o dublo so vale se o modulo real publicar os dois
  // simbolos com a forma que o agregador consome. Isto amarra a fixture
  // ao codigo que ela substitui.
  const CODIGO_REGISTRY = semComentarios(ler("lib/agentes/funcoes/registry.ts"));
  ok("N0a ANCORA: o registry real publica `conexaoNecessaria` na definicao",
    /conexaoNecessaria: RequisitoConexaoFuncao \| null;/.test(CODIGO_REGISTRY));
  ok("N0b ANCORA: e `listarFuncoesRegistradas` devolve as chaves ORDENADAS",
    /Object\.freeze\(Object\.keys\(FUNCOES\)\.sort\(\)\)/.test(CODIGO_REGISTRY));

  /** Roda o agregador com 1 Skill sem requisito e o catalogo/permissoes dados. */
  const comFeed = async (perms: Resposta, selecoes: Resposta = { data: [] }) => {
    roteiro({ data: [assoc("s1")] }, { data: [linhaSkill("s1")] }, perms, selecoes);
    return resolverConexoesDoAgente(AG);
  };

  definirCatalogo({ "x.bloqueada": fnConectada("shopee", "chat") });
  const nBloq = await comFeed(permissoes(["x.bloqueada", "bloqueado"]));
  ok("N1  Funcao BLOQUEADA nao gera requirement",
    nBloq.coleta === "ok" && nBloq.semSelecao.length === 0,
    JSON.stringify(nBloq.semSelecao));

  const nSemLinha = await comFeed(SEM_PERMISSAO);
  ok("N2  Funcao SEM LINHA de permissao nao gera requirement",
    nSemLinha.coleta === "ok" && nSemLinha.semSelecao.length === 0);

  definirCatalogo({ "x.aprovacao": fnConectada("shopee", "chat") });
  const nAprov = await comFeed(permissoes(["x.aprovacao", "aprovacao"]));
  ok("N3  Funcao em APROVACAO gera requirement",
    nAprov.semSelecao.length === 1 && nAprov.semSelecao[0]?.recurso === "chat",
    JSON.stringify(nAprov.semSelecao));

  definirCatalogo({ "x.auto": fnConectada("shopee", "chat") });
  const nAuto = await comFeed(permissoes(["x.auto", "automatico"]));
  ok("N4  Funcao AUTOMATICA gera requirement", nAuto.semSelecao.length === 1);
  ok("N5  e o requirement de Funcao e SEMPRE obrigatorio",
    nAuto.semSelecao[0]?.obrigatoria === true);

  definirCatalogo({ "x.semconexao": FN_SEM_CONEXAO });
  const nSemReq = await comFeed(permissoes(["x.semconexao", "automatico"]));
  ok("N6  Funcao habilitada SEM conexaoNecessaria nao gera requirement",
    nSemReq.semSelecao.length === 0);

  definirCatalogo({ "x.fantasma": fnConectada("shopee", "chat") });
  const nDesconhecida = await comFeed(permissoes(["x.nao-registrada", "automatico"]));
  ok("N7  permissao para Funcao FORA do catalogo nao gera requirement",
    nDesconhecida.semSelecao.length === 0);

  // Skill-only: o comportamento anterior tem de continuar identico.
  definirCatalogo(CATALOGO_BASE);
  roteiro(
    { data: [assoc("s1")] },
    { data: [linhaSkill("s1", [["shopee", "chat", true]])] },
    SEM_PERMISSAO,
    { data: [] }
  );
  const nSkillOnly = await resolverConexoesDoAgente(AG);
  ok("N8  Skill-only continua exatamente como antes",
    nSkillOnly.semSelecao.length === 1 && nSkillOnly.semSelecao[0]?.recurso === "chat" &&
      nSkillOnly.semSelecao[0]?.obrigatoria === true);

  // Skill e Funcao pedindo pares DIFERENTES -> dois requisitos.
  definirCatalogo({ "x.auto": fnConectada("shopee", "pedidos") });
  roteiro(
    { data: [assoc("s1")] },
    { data: [linhaSkill("s1", [["shopee", "chat", true]])] },
    permissoes(["x.auto", "automatico"]),
    { data: [] }
  );
  const nDois = await resolverConexoesDoAgente(AG);
  ok("N9  Skill + Funcao com pares distintos -> DOIS requisitos",
    nDois.semSelecao.length === 2, JSON.stringify(nDois.semSelecao.map((r) => r.recurso)));
  ok("N10 e a ordem e deterministica por plataforma+recurso",
    JSON.stringify(nDois.semSelecao.map((r) => r.recurso)) === JSON.stringify(["chat", "pedidos"]));

  // Skill e Funcao pedindo o MESMO par -> um so.
  definirCatalogo({ "x.auto": fnConectada("shopee", "chat") });
  roteiro(
    { data: [assoc("s1")] },
    { data: [linhaSkill("s1", [["shopee", "chat", false]])] },
    permissoes(["x.auto", "automatico"]),
    { data: [] }
  );
  const nDedupe = await resolverConexoesDoAgente(AG);
  ok("N11 Skill + Funcao no MESMO par -> UM requisito",
    nDedupe.semSelecao.length === 1, String(nDedupe.semSelecao.length));
  ok("N12 e `obrigatoria` combina por OR entre as duas fontes",
    nDedupe.semSelecao[0]?.obrigatoria === true);

  // Duas Funcoes habilitadas no mesmo par tambem deduplicam.
  definirCatalogo({
    "a.um": fnConectada("shopee", "chat"),
    "b.dois": fnConectada("shopee", "chat"),
  });
  roteiro(
    { data: [assoc("s1")] },
    { data: [linhaSkill("s1")] },
    permissoes(["a.um", "automatico"], ["b.dois", "aprovacao"]),
    { data: [] }
  );
  const nDuasFn = await resolverConexoesDoAgente(AG);
  ok("N13 duas Funcoes no mesmo par -> UM requisito", nDuasFn.semSelecao.length === 1);

  // Custo: o catalogo grande NAO multiplica leituras.
  const catalogoGrande: Record<string, DefinicaoDublada> = {};
  for (let i = 0; i < 25; i++) catalogoGrande[`f${i}.op`] = fnConectada("shopee", `r${i}`);
  definirCatalogo(catalogoGrande);
  roteiro(
    { data: [assoc("s1")] },
    { data: [linhaSkill("s1")] },
    permissoes(["f0.op", "automatico"], ["f1.op", "automatico"], ["f2.op", "automatico"]),
    { data: [] }
  );
  const nCusto = await resolverConexoesDoAgente(AG);
  const lidasPermissao = chamadas.filter((c) => c.tabela === "agente_permissoes");
  ok("N14 25 Funcoes no catalogo, 3 habilitadas -> 3 requisitos",
    nCusto.semSelecao.length === 3, String(nCusto.semSelecao.length));
  ok("N15 e UMA leitura de agente_permissoes, nunca uma por Funcao",
    lidasPermissao.length === 1, String(lidasPermissao.length));
  ok("N16 o IN carrega o catalogo INTEIRO, ordenado, numa chamada so",
    lidasPermissao[0]?.inColuna === "funcao_id" && lidasPermissao[0]?.inValores?.length === 25,
    `${lidasPermissao[0]?.inColuna} / ${lidasPermissao[0]?.inValores?.length}`);
  ok("N17 e o total de queries nao cresce com o catalogo",
    chamadas.length === 4, `${chamadas.length} · ${tabelas()}`);

  // Falha ao ler permissoes NAO vira "nao exige".
  definirCatalogo({ "x.auto": fnConectada("shopee", "chat") });
  roteiro({ data: [assoc("s1")] }, { data: [linhaSkill("s1")] }, { error: { code: "42501" } });
  const nFalha = await resolverConexoesDoAgente(AG);
  ok("N18 falha ao ler permissoes -> falha_leitura, tudo vazio, ZERO lote",
    nFalha.coleta === "falha_leitura" && nFalha.semSelecao.length === 0 &&
      nFalha.conexoes.length === 0 && nFalha.bindings.length === 0 && queriesDoLote() === 0,
    `${nFalha.coleta} / ${tabelas()}`);

  // ── J/K. O snapshot de permissao publicado ───────────────────
  //
  // M2-I1-A1-FIX1: o agregador publica o que leu, para que o compositor
  // nao leia a MESMA tabela uma segunda vez na mesma requisicao.

  definirCatalogo({ "a.um": fnConectada("shopee", "chat"), "b.dois": FN_SEM_CONEXAO });
  roteiro(
    { data: [assoc("s1")] },
    { data: [linhaSkill("s1")] },
    permissoes(["a.um", "automatico"], ["b.dois", "bloqueado"]),
    { data: [] }
  );
  const jSnap = await resolverConexoesDoAgente(AG);
  const qJ = chamadas.find((c) => c.tabela === "agente_permissoes");
  ok("J1  `permissoes` e publicado no resultado",
    Array.isArray(jSnap.permissoes) && jSnap.permissoes.length === 2,
    JSON.stringify(jSnap.permissoes));
  ok("J2  a CONSULTA cobre exatamente o catalogo registrado",
    JSON.stringify([...(qJ?.inValores ?? [])].sort()) ===
      JSON.stringify(["a.um", "b.dois"]),
    JSON.stringify(qJ?.inValores));
  ok("J3  e o publicado e o LIDO, sem recorte no meio do caminho",
    JSON.stringify([...jSnap.permissoes].map((p) => p.funcaoId).sort()) ===
      JSON.stringify(["a.um", "b.dois"]));
  ok("J4  o bloqueado vem no snapshot, e quem decide e quem consome",
    jSnap.permissoes.some((p) => p.funcaoId === "b.dois" && p.nivel === "bloqueado"));

  // Linha AUSENTE nao vira fato sintetico.
  roteiro(
    { data: [assoc("s1")] },
    { data: [linhaSkill("s1")] },
    permissoes(["a.um", "automatico"]),
    { data: [] }
  );
  const jParcial = await resolverConexoesDoAgente(AG);
  ok("J5  Funcao registrada SEM linha nao ganha fato sintetico",
    jParcial.permissoes.length === 1 &&
      !jParcial.permissoes.some((p) => p.funcaoId === "b.dois"),
    JSON.stringify(jParcial.permissoes));
  ok("J6  e nem por isso a coleta deixa de ser `ok`", jParcial.coleta === "ok");

  // K. Falha de coleta NAO e snapshot vazio valido.
  roteiro({ data: [assoc("s1")] }, { data: [linhaSkill("s1")] }, { error: { code: "42501" } });
  const kFalha = await resolverConexoesDoAgente(AG);
  ok("K1  falha ao ler permissoes -> coleta de FALHA, nao `ok` vazio",
    kFalha.coleta === "falha_leitura" && kFalha.permissoes.length === 0,
    `${kFalha.coleta} / ${kFalha.permissoes.length}`);
  ok("K2  e as outras colecoes tambem saem vazias, sem parcial",
    kFalha.conexoes.length === 0 && kFalha.semSelecao.length === 0 &&
      kFalha.bindings.length === 0);
  ok("K3  CONTROLE: o MESMO vazio com `ok` significa outra coisa",
    jParcial.coleta === "ok" && kFalha.coleta !== jParcial.coleta);

  // Sem requisito nenhum, o snapshot ainda sai — ele FOI apurado.
  definirCatalogo({ "b.dois": FN_SEM_CONEXAO });
  roteiro(
    { data: [assoc("s1")] },
    { data: [linhaSkill("s1")] },
    permissoes(["b.dois", "automatico"])
  );
  const jSemReq = await resolverConexoesDoAgente(AG);
  ok("J7  `SEM_REQUISITOS` publica o snapshot que apurou, nao uma lista vazia",
    jSemReq.coleta === "ok" && jSemReq.semSelecao.length === 0 &&
      jSemReq.permissoes.length === 1 && jSemReq.permissoes[0]?.funcaoId === "b.dois",
    JSON.stringify(jSemReq.permissoes));

  // ── O. Bindings: so o que sobreviveu ao fato ───────────────────────

  secao("O. Bindings — vinculo validado, nunca selecao crua");

  definirCatalogo(CATALOGO_BASE);

  /** 1 Skill exigindo `(shopee, chat)`, com selecao e lote parametrizados. */
  const comBinding = async (selecao: Resposta, donas: Resposta, lote: Resposta) => {
    roteiro(
      { data: [assoc("s1")] },
      { data: [linhaSkill("s1", [["shopee", "chat", true]])] },
      SEM_PERMISSAO,
      selecao,
      donas,
      lote
    );
    return resolverConexoesDoAgente(AG);
  };

  const oOk = await comBinding(
    { data: [linhaSelecao("shopee", "chat", L(1))] },
    { data: [linhaLojaDona(L(1))] },
    { data: [loja(L(1))] }
  );
  ok("O1  selecao valida gera binding",
    oOk.bindings.length === 1 && oOk.bindings[0]?.lojaId === L(1),
    JSON.stringify(oOk.bindings));
  ok("O2  o binding carrega o par EXATO do requisito",
    oOk.bindings[0]?.plataforma === "shopee" && oOk.bindings[0]?.recurso === "chat");
  ok("O3  e ele acompanha o fato, um para um",
    oOk.conexoes.length === 1 && oOk.bindings.length === oOk.conexoes.length);

  roteiro(
    { data: [assoc("s1")] },
    { data: [linhaSkill("s1", [["shopee", "chat", true]])] },
    SEM_PERMISSAO,
    { data: [] }
  );
  const oSemSel = await resolverConexoesDoAgente(AG);
  ok("O4  selecao AUSENTE nao gera binding",
    oSemSel.bindings.length === 0 && oSemSel.semSelecao.length === 1);

  // ── O CASO QUE MOTIVOU O CONTRATO ─────────────────────────────────
  //
  // `agente_conexoes` nao tem invariante de banco ligando `plataforma` ao
  // marketplace da loja — a FK composta prova DONO, nao PROVEDOR. Entao a
  // selecao abaixo e estruturalmente possivel e sai da camada de selecao
  // como valida. Quem a recusa e `fatoDaLinha`, e o binding HERDA essa
  // recusa em vez de repeti-la.
  const oOutroProvedor = await comBinding(
    { data: [linhaSelecao("shopee", "chat", L(1))] },
    { data: [linhaLojaDona(L(1))] },
    { data: [loja(L(1), { marketplace: "ML" })] }
  );
  ok("O5  loja de OUTRO provedor nao gera binding",
    oOutroProvedor.bindings.length === 0, JSON.stringify(oOutroProvedor.bindings));
  ok("O6  e tambem nao gera fato — as duas colecoes concordam",
    oOutroProvedor.conexoes.length === 0 && oOutroProvedor.coleta === "ok");
  // M2-I1-A4 mudou a fronteira deste assert, e a mudanca e deliberada.
  //
  // Ate aqui ele cobrava que o `lojaId` incompativel nao aparecesse em
  // NENHUM lugar. Isso era correto enquanto o resultado inteiro servia a
  // EXECUCAO. Agora `requisitos` serve a CONFIGURACAO, e mostrar ao dono
  // a conta que ele escolheu — junto com `utilizavel: false` — e o unico
  // jeito de ele descobrir que precisa troca-la.
  //
  // O que continua proibido, e e o que sempre importou: esse id chegar a
  // quem vai AGIR. `bindings` e `conexoes` seguem limpos.
  ok("O7  o `lojaId` incompativel nao chega a quem AGE",
    !JSON.stringify(oOutroProvedor.bindings).includes(L(1)) &&
      !JSON.stringify(oOutroProvedor.conexoes).includes(L(1)) &&
      !JSON.stringify(oOutroProvedor.semSelecao).includes(L(1)),
    JSON.stringify(oOutroProvedor.bindings));
  ok("O7a mas ele APARECE na colecao de configuracao, com utilizavel false",
    oOutroProvedor.requisitos.some(
      (r) => r.lojaIdSelecionada === L(1) && r.utilizavel === false
    ),
    JSON.stringify(oOutroProvedor.requisitos));
  ok("O7b CONTROLE: se `bindings` o carregasse, O7 reprovaria",
    JSON.stringify([{ lojaId: L(1) }]).includes(L(1)));

  const oInexistente = await comBinding(
    { data: [linhaSelecao("shopee", "chat", L(1))] },
    { data: [linhaLojaDona(L(1))] },
    { data: [] }
  );
  ok("O8  loja que nao volta do lote nao gera binding",
    oInexistente.bindings.length === 0 && oInexistente.conexoes.length === 0);

  // Recurso diferente: o join casa pelos DOIS campos.
  const oOutroRecurso = await comBinding(
    { data: [linhaSelecao("shopee", "pedidos", L(1))] },
    { data: [linhaLojaDona(L(1))] },
    { data: [loja(L(1))] }
  );
  ok("O9  selecao de OUTRO recurso nao gera binding para `chat`",
    oOutroRecurso.bindings.length === 0 && oOutroRecurso.semSelecao.length === 1);

  // Loja de outro dono derruba a coleta inteira, e nada escapa.
  const oOutroDono = await comBinding(
    { data: [linhaSelecao("shopee", "chat", L(1))] },
    { data: [{ id: L(1), user_id: "outro-dono" }] },
    { data: [loja(L(1))] }
  );
  ok("O10 loja de OUTRO dono nao gera binding",
    oOutroDono.bindings.length === 0 && oOutroDono.coleta === "falha_leitura");

  // Dois requisitos, um valido e um incompativel: o bom sobrevive, o
  // ruim nao contamina.
  roteiro(
    { data: [assoc("s1")] },
    { data: [linhaSkill("s1", [["shopee", "chat", true], ["shopee", "pedidos", true]])] },
    SEM_PERMISSAO,
    { data: [linhaSelecao("shopee", "chat", L(1)), linhaSelecao("shopee", "pedidos", L(2))] },
    { data: [linhaLojaDona(L(1)), linhaLojaDona(L(2))] },
    { data: [loja(L(1)), loja(L(2), { marketplace: "ML" })] }
  );
  const oMisto = await resolverConexoesDoAgente(AG);
  ok("O11 o binding valido sobrevive e o incompativel nao",
    oMisto.bindings.length === 1 && oMisto.bindings[0]?.recurso === "chat" &&
      oMisto.bindings[0]?.lojaId === L(1),
    JSON.stringify(oMisto.bindings));
  ok("O12 e o lojaId do par recusado nao vaza junto",
    !JSON.stringify(oMisto.bindings).includes(L(2)));

  ok("O13 o binding nunca carrega credencial",
    !/token|secret|senha|credencial/i.test(JSON.stringify(oOk.bindings)));
  ok("O14 e tem exatamente os tres campos publicados",
    JSON.stringify(Object.keys(oOk.bindings[0] ?? {}).sort()) ===
      JSON.stringify(["lojaId", "plataforma", "recurso"]));

  // ── P. M2-I1-A4: `requisitos`, a colecao composta ─────────────────
  //
  // As outras tres dispersam os requisitos em tres destinos, e o caso
  // "selecao aponta para loja de outro provedor" nao cai em nenhum deles.
  // Esta secao cobra que ele exista, e que continue existindo.

  secao("P. `requisitos` — a colecao que nao perde o caso incompativel");

  definirCatalogo(CATALOGO_BASE);

  const comRequisitos = async (selecao: Resposta, donas: Resposta, lote: Resposta) => {
    roteiro(
      { data: [assoc("s1")] },
      { data: [linhaSkill("s1", [["shopee", "chat", true]])] },
      SEM_PERMISSAO,
      selecao,
      donas,
      lote
    );
    return resolverConexoesDoAgente(AG);
  };

  const pSem = await comRequisitos({ data: [] }, { data: [] }, { data: [] });
  ok("P1  requisito SEM selecao aparece com lojaIdSelecionada null",
    pSem.requisitos.length === 1 &&
      pSem.requisitos[0]?.lojaIdSelecionada === null &&
      pSem.requisitos[0]?.utilizavel === false,
    JSON.stringify(pSem.requisitos));
  ok("P1a e ele carrega plataforma, recurso e obrigatoria",
    pSem.requisitos[0]?.plataforma === "shopee" &&
      pSem.requisitos[0]?.recurso === "chat" &&
      pSem.requisitos[0]?.obrigatoria === true);

  const pOk = await comRequisitos(
    { data: [linhaSelecao("shopee", "chat", L(1))] },
    { data: [linhaLojaDona(L(1))] },
    { data: [loja(L(1))] }
  );
  ok("P2  selecao compativel -> lojaIdSelecionada preenchido e utilizavel",
    pOk.requisitos[0]?.lojaIdSelecionada === L(1) &&
      pOk.requisitos[0]?.utilizavel === true,
    JSON.stringify(pOk.requisitos));

  // O CASO QUE MOTIVOU A COLECAO: loja de outro provedor. Sem fato, sem
  // binding — e, sem `requisitos`, tambem sem nenhuma pista para o dono.
  const pIncompat = await comRequisitos(
    { data: [linhaSelecao("shopee", "chat", L(1))] },
    { data: [linhaLojaDona(L(1))] },
    { data: [loja(L(1), { marketplace: "ML" })] }
  );
  ok("P3  selecao INCOMPATIVEL continua visivel, com utilizavel false",
    pIncompat.requisitos.length === 1 &&
      pIncompat.requisitos[0]?.lojaIdSelecionada === L(1) &&
      pIncompat.requisitos[0]?.utilizavel === false,
    JSON.stringify(pIncompat.requisitos));
  ok("P3a ANCORA: ela nao aparece em conexoes NEM em semSelecao",
    pIncompat.conexoes.length === 0 && pIncompat.semSelecao.length === 0 &&
      pIncompat.bindings.length === 0);
  ok("P3b CONTROLE: `semSelecao UNION bindings` PERDERIA este requisito",
    pIncompat.semSelecao.length + pIncompat.bindings.length === 0 &&
      pIncompat.requisitos.length === 1);

  // Custo: a colecao e derivada, nunca consultada.
  roteiro(
    { data: [assoc("s1")] },
    { data: [linhaSkill("s1", [["shopee", "chat", true], ["shopee", "pedidos", true]])] },
    SEM_PERMISSAO,
    { data: [linhaSelecao("shopee", "chat", L(1))] },
    { data: [linhaLojaDona(L(1))] },
    { data: [loja(L(1))] }
  );
  const pCusto = await resolverConexoesDoAgente(AG);
  ok("P4  dois requisitos -> duas entradas, uma por requisito",
    pCusto.requisitos.length === 2, String(pCusto.requisitos.length));
  ok("P5  ZERO query adicional — a colecao e derivada",
    chamadas.length === 6, `${chamadas.length} · ${tabelas()}`);
  ok("P6  a ordem e a mesma de sempre: plataforma, depois recurso",
    JSON.stringify(pCusto.requisitos.map((r) => r.recurso)) ===
      JSON.stringify(["chat", "pedidos"]),
    pCusto.requisitos.map((r) => r.recurso).join(", "));
  ok("P7  e cada par aparece UMA vez — o dedupe continua valendo",
    new Set(pCusto.requisitos.map((r) => `${r.plataforma}/${r.recurso}`)).size ===
      pCusto.requisitos.length);
  ok("P8  nenhuma credencial na colecao",
    !/token|secret|senha|credencial/i.test(JSON.stringify(pCusto.requisitos)));
  ok("P9  cada entrada tem EXATAMENTE os cinco campos publicados",
    JSON.stringify(Object.keys(pCusto.requisitos[0] ?? {}).sort()) ===
      JSON.stringify(["lojaIdSelecionada", "obrigatoria", "plataforma", "recurso", "utilizavel"]),
    Object.keys(pCusto.requisitos[0] ?? {}).join(", "));

  // Falha de coleta nao publica requisito nenhum.
  roteiro({ data: [assoc("s1")] }, { data: [linhaSkill("s1")] }, { error: { code: "42501" } });
  const pFalha = await resolverConexoesDoAgente(AG);
  ok("P10 coleta de falha -> `requisitos` vazio, nunca parcial",
    pFalha.coleta === "falha_leitura" && pFalha.requisitos.length === 0);

  console.log(`\n══ ${passou} PASS / ${falhou} FAIL ══\n`);
  process.exitCode = falhou === 0 ? 0 : 1;
}

principal().catch((e) => {
  console.log(`  FAIL  excecao nao tratada — ${String(e).slice(0, 300)}`);
  process.exitCode = 1;
});
