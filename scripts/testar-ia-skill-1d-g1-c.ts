/**
 * CDS IA — SKILL-1D.g.1-C. Suite da leitura da selecao de loja.
 *
 * `selecao-estado.ts` e puro e por isso e IMPORTADO e EXECUTADO — a
 * regra que decide o que as linhas significam roda de verdade aqui.
 *
 * `selecao-fatos.ts` e `server-only` e fala com o Supabase. Ele tambem e
 * executado, contra um cliente DUPLADO que registra cada invocacao: o
 * que se afirma nao e "o fake funciona", e sim quantas queries o codigo
 * real fez, em que tabela, com quais filtros e com que projecao. O duplo
 * e o instrumento de medida, nunca o objeto medido.
 *
 * Precedentes seguidos, nenhum inventado: `_server-only-inerte` e o
 * duplo de `Module.prototype.require` das suites da f.3 e f.4.
 *
 * Rodar:  npx tsx scripts/testar-ia-skill-1d-g1-c.ts
 * Sem rede, sem banco, sem env, sem segredo, sem `--confirmo`.
 */
import "./_server-only-inerte";

import Module from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  confirmarLojas,
  filtrosLojasDoDono,
  filtrosSelecoesDoAgente,
  lojaIdsDistintos,
  ordenarSelecoes,
  plataformaConhecida,
  recursoValido,
  type LinhaLoja,
  type LinhaSelecao,
} from "../lib/agentes/conexoes/selecao-estado";

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

const FONTE_ESTADO = ler("lib/agentes/conexoes/selecao-estado.ts");
const CODIGO_ESTADO = semComentarios(FONTE_ESTADO);
const FONTE_FATOS = ler("lib/agentes/conexoes/selecao-fatos.ts");
const CODIGO_FATOS = semComentarios(FONTE_FATOS);

// ─── O duplo do cliente Supabase ──────────────────────────────────────

interface Chamada {
  tabela: string;
  colunas?: string;
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
  const c: Chamada = { tabela, filtros: {} };
  const b: Record<string, unknown> = {
    select(cols: string) { c.colunas = cols; return b; },
    eq(coluna: string, valor: unknown) { c.filtros[coluna] = valor; return b; },
    in(coluna: string, valores: readonly unknown[]) { c.inColuna = coluna; c.inValores = valores; return b; },
    insert() { c.tabela = `PROIBIDO:insert:${tabela}`; return b; },
    update() { c.tabela = `PROIBIDO:update:${tabela}`; return b; },
    upsert() { c.tabela = `PROIBIDO:upsert:${tabela}`; return b; },
    delete() { c.tabela = `PROIBIDO:delete:${tabela}`; return b; },
    // O `await` do codigo real cai aqui: e neste ponto que a query
    // realmente conta como executada.
    then(resolver: (v: { data: unknown; error: unknown }) => void) {
      chamadas.push(c);
      const r = respostas[consumidas++];
      resolver({ data: r?.data ?? null, error: r?.error ?? null });
    },
  };
  return b;
}

const clienteFake = { from: (t: string) => construtor(t) };

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

const USER = "user-sintetico-g1c";
const OUTRO = "user-sintetico-alheio";
const AGENTE = "11111111-2222-3333-4444-555555555555";
const L1 = "aaaaaaaa-0000-4000-8000-000000000001";
const L2 = "aaaaaaaa-0000-4000-8000-000000000002";

const S = (plataforma: string, recurso: string, loja_id: string, p: Partial<LinhaSelecao> = {}): LinhaSelecao =>
  ({ agente_id: AGENTE, user_id: USER, plataforma, recurso, loja_id, ...p });

const LJ = (id: string, user_id: unknown = USER): LinhaLoja => ({ id, user_id });

console.log("\n══ CDS IA — SKILL-1D.g.1-C: selecao explicita de loja ══");

// ─── A. Os dois modulos ───────────────────────────────────────────────

secao("A. Estado puro, fatos server-only");

ok("A1  selecao-estado.ts existe", existsSync(join(RAIZ, "lib/agentes/conexoes/selecao-estado.ts")));
ok("A2  selecao-fatos.ts existe", existsSync(join(RAIZ, "lib/agentes/conexoes/selecao-fatos.ts")));
ok("A3  estado NAO e server-only (por isso esta suite o executa)",
  !/server-only/.test(CODIGO_ESTADO));
ok("A4  estado nao le banco, env nem rede",
  !/getSupabaseServidor|createClient|process\.env|\bfetch\s*\(/.test(CODIGO_ESTADO));
ok("A5  estado nao loga", !/console\./.test(CODIGO_ESTADO));
ok("A6  fatos E server-only", /import "server-only"/.test(CODIGO_FATOS));
ok("A7  CONTROLE: as sondas acusam quando o padrao existe",
  /server-only/.test('import "server-only"') && /console\./.test("console.log(1)"));

// ─── B. A regra pura ──────────────────────────────────────────────────

secao("B. Vocabulario de plataforma e formato de recurso");

ok("B1  shopee e plataforma conhecida", plataformaConhecida("shopee"));
ok("B2  mercado_livre tambem — a autoridade e MARKETPLACE_POR_PLATAFORMA",
  plataformaConhecida("mercado_livre"));
for (const v of ["Shopee", "amazon", "", "shopee ", null, 1, {}]) {
  ok(`B3 plataforma ${JSON.stringify(v)} NAO e conhecida`, !plataformaConhecida(v));
}
ok("B4  o vocabulario nao e lista manual — vem do mapa publicado",
  /MARKETPLACE_POR_PLATAFORMA/.test(CODIGO_ESTADO) &&
  !/\["shopee", ?"mercado_livre"\]/.test(CODIGO_ESTADO));

for (const [v, esperado] of [
  ["chat", true], ["pedidos", true], ["mercado-livre", true], ["a1", true],
  ["", false], ["Chat", false], ["full_control", false], ["com espaco", false],
  ["-x", false], ["x-", false],
] as const) {
  ok(`B5 recurso ${JSON.stringify(v)} -> ${esperado ? "valido" : "invalido"}`, recursoValido(v) === esperado);
}
ok("B6  recurso nao tem vocabulario fechado",
  !/recurso === "chat"|\["chat"/.test(CODIGO_ESTADO));

secao("C. ordenarSelecoes — fail-closed e ordem canonica");

ok("C1  lista vazia e lista vazia, nao falha",
  JSON.stringify(ordenarSelecoes([], AGENTE, USER)) === "[]");
ok("C2  ordem canonica por plataforma depois recurso",
  JSON.stringify(ordenarSelecoes(
    [S("shopee", "pedidos", L1), S("mercado_livre", "chat", L2), S("shopee", "chat", L1)],
    AGENTE, USER
  )?.map((s) => `${s.plataforma}/${s.recurso}`)) ===
    JSON.stringify(["mercado_livre/chat", "shopee/chat", "shopee/pedidos"]));
ok("C3  a ordem NAO depende da ordem de entrada",
  JSON.stringify(ordenarSelecoes([S("shopee", "chat", L1), S("shopee", "pedidos", L1)], AGENTE, USER)) ===
  JSON.stringify(ordenarSelecoes([S("shopee", "pedidos", L1), S("shopee", "chat", L1)], AGENTE, USER)));

for (const [rot, linha] of [
  ["agente errado", S("shopee", "chat", L1, { agente_id: "outro-agente" })],
  ["user_id errado", S("shopee", "chat", L1, { user_id: OUTRO })],
  ["plataforma desconhecida", S("amazon", "chat", L1)],
  ["plataforma vazia", S("", "chat", L1)],
  ["recurso invalido", S("shopee", "Chat", L1)],
  ["recurso vazio", S("shopee", "", L1)],
  ["loja_id vazio", S("shopee", "chat", "")],
  ["loja_id nao-string", S("shopee", "chat", L1, { loja_id: 7 })],
] as const) {
  ok(`C4 ${rot} -> null (coleta inteira invalida)`,
    ordenarSelecoes([linha], AGENTE, USER) === null);
}
ok("C5  duplicata de (plataforma,recurso) -> null, nunca last-wins",
  ordenarSelecoes([S("shopee", "chat", L1), S("shopee", "chat", L2)], AGENTE, USER) === null);
ok("C6  MESMA loja em capacidades diferentes e VALIDO",
  ordenarSelecoes([S("shopee", "chat", L1), S("shopee", "pedidos", L1)], AGENTE, USER)?.length === 2);
ok("C7  uma linha invalida derruba TODAS, sem resultado parcial",
  ordenarSelecoes([S("shopee", "chat", L1), S("amazon", "x", L2)], AGENTE, USER) === null);

secao("D. confirmarLojas e deduplicacao");

const sel2 = ordenarSelecoes([S("shopee", "chat", L1), S("shopee", "pedidos", L1)], AGENTE, USER)!;
ok("D1  lojaIds deduplicados", JSON.stringify(lojaIdsDistintos(sel2)) === JSON.stringify([L1]));
ok("D2  duas lojas distintas geram dois ids",
  lojaIdsDistintos(ordenarSelecoes([S("shopee", "chat", L1), S("shopee", "pedidos", L2)], AGENTE, USER)!).length === 2);
ok("D3  loja presente e do dono -> confirma", confirmarLojas(sel2, [LJ(L1)], USER)?.length === 2);
ok("D4  loja AUSENTE -> null", confirmarLojas(sel2, [], USER) === null);
ok("D5  loja de OUTRO dono -> null", confirmarLojas(sel2, [LJ(L1, OUTRO)], USER) === null);
ok("D6  loja com id invalido -> null", confirmarLojas(sel2, [LJ("", USER)], USER) === null);
ok("D7  loja repetida na resposta -> null", confirmarLojas(sel2, [LJ(L1), LJ(L1)], USER) === null);

secao("E. Filtros puros — a autoridade que vai a consulta");

ok("E1  filtro de selecoes fecha por agente_id + user_id",
  JSON.stringify(filtrosSelecoesDoAgente(AGENTE, USER)) ===
    JSON.stringify({ agente_id: AGENTE, user_id: USER }));
ok("E2  filtro de lojas fecha por user_id", JSON.stringify(filtrosLojasDoDono(USER)) ===
  JSON.stringify({ user_id: USER }));

// ─── F. O modulo server-only, executado ───────────────────────────────

async function principal(): Promise<void> {
  const { resolverSelecoesDoAgente } = await import("../lib/agentes/conexoes/selecao-fatos");

  secao("F. O instrumento de medida esta instalado");

  ok("F1  ANCORA: o duplo interceptou o cliente Supabase", interceptou);
  const carregados = Object.keys(require.cache).map((p) => p.replace(/\\/g, "/"));
  ok("F2  ANCORA: selecao-fatos.ts esta no grafo",
    carregados.some((p) => p.includes("/lib/agentes/conexoes/selecao-fatos.ts")));
  ok("F3  nenhum cliente Supabase real carregado",
    !carregados.some((p) => /@supabase|supabase-servidor/.test(p)));

  roteiro({ data: [S("shopee", "chat", L1)] }, { data: [LJ(L1)] });
  const controle = await resolverSelecoesDoAgente({ userId: USER, agenteId: AGENTE });
  ok("F4  CONTROLE POSITIVO: caminho feliz registra 2 queries",
    controle.coleta === "ok" && chamadas.length === 2);

  secao("G. Guards — sem autoridade nao ha query");

  for (const [rot, ent] of [
    ["userId vazio", { userId: "", agenteId: AGENTE }],
    ["agenteId vazio", { userId: USER, agenteId: "" }],
    ["ambos vazios", { userId: "", agenteId: "" }],
  ] as const) {
    roteiro();
    const r = await resolverSelecoesDoAgente(ent);
    ok(`G1 ${rot} -> entrada_invalida`, r.coleta === "entrada_invalida");
    ok(`G2 ${rot} -> ZERO query`, chamadas.length === 0);
    ok(`G3 ${rot} -> zero selecoes`, r.selecoes.length === 0);
  }

  secao("H. QUERY 1 — tabela, autoridade e projecao");

  roteiro({ data: [S("shopee", "chat", L1)] }, { data: [LJ(L1)] });
  await resolverSelecoesDoAgente({ userId: USER, agenteId: AGENTE });

  ok("H1  QUERY 1 le agente_conexoes", chamadas[0]?.tabela === "agente_conexoes");
  ok("H2  fechada por agente_id E user_id",
    JSON.stringify(chamadas[0]?.filtros) === JSON.stringify({ agente_id: AGENTE, user_id: USER }));
  ok("H3  projecao minima, sem timestamps",
    chamadas[0]?.colunas === "agente_id, user_id, plataforma, recurso, loja_id");
  ok("H4  nao carrega criado_em/alterado_em",
    !/criado_em|alterado_em/.test(String(chamadas[0]?.colunas)));

  secao("I. QUERY 2 — lote, dono e ZERO token");

  ok("I1  QUERY 2 le lojas", chamadas[1]?.tabela === "lojas");
  ok("I2  fechada por user_id DE NOVO",
    JSON.stringify(chamadas[1]?.filtros) === JSON.stringify({ user_id: USER }));
  ok("I3  usa .in('id', ...) em lote", chamadas[1]?.inColuna === "id");
  ok("I4  projeta somente id e user_id", chamadas[1]?.colunas === "id, user_id");
  ok("I5  NAO projeta access_token nem qualquer credencial",
    !/access_token|refresh_token|partner_key|token_expires_at|secret/i.test(String(chamadas[1]?.colunas)));
  ok("I6  CONTROLE: a sonda de token acharia se estivesse la",
    /access_token/i.test("id, user_id, access_token"));

  secao("J. Contagem de queries — nunca N+1");

  roteiro({ data: [] });
  const vazio = await resolverSelecoesDoAgente({ userId: USER, agenteId: AGENTE });
  ok("J1  zero selecoes -> coleta ok", vazio.coleta === "ok");
  ok("J2  zero selecoes -> lista vazia", vazio.selecoes.length === 0);
  ok("J3  zero selecoes -> EXATAMENTE 1 query (QUERY 2 nao roda)", chamadas.length === 1);

  roteiro({ data: [S("shopee", "chat", L1)] }, { data: [LJ(L1)] });
  await resolverSelecoesDoAgente({ userId: USER, agenteId: AGENTE });
  ok("J4  1 selecao -> EXATAMENTE 2 queries", chamadas.length === 2);

  const muitas: LinhaSelecao[] = [];
  const lojas: LinhaLoja[] = [];
  for (let i = 0; i < 10; i++) {
    const lid = `aaaaaaaa-0000-4000-8000-00000000${String(10 + i).padStart(4, "0")}`;
    muitas.push(S("shopee", `recurso-${i}`, lid));
    lojas.push(LJ(lid));
  }
  roteiro({ data: muitas }, { data: lojas });
  const r10 = await resolverSelecoesDoAgente({ userId: USER, agenteId: AGENTE });
  ok("J5  10 selecoes -> EXATAMENTE 2 queries", chamadas.length === 2);
  ok("J6  e as 10 voltam", r10.selecoes.length === 10);
  ok("J7  o .in levou os 10 ids em UMA lista", chamadas[1]?.inValores?.length === 10);

  roteiro({ data: [S("shopee", "chat", L1), S("shopee", "pedidos", L1)] }, { data: [LJ(L1)] });
  const mesmaLoja = await resolverSelecoesDoAgente({ userId: USER, agenteId: AGENTE });
  ok("J8  duas capacidades na MESMA loja -> valido", mesmaLoja.coleta === "ok" && mesmaLoja.selecoes.length === 2);
  ok("J9  e o .in leva UM id so — deduplicado", chamadas[1]?.inValores?.length === 1);

  secao("K. Falhas — fail-closed sem resultado parcial");

  roteiro({ error: { code: "42501" } });
  const e1 = await resolverSelecoesDoAgente({ userId: USER, agenteId: AGENTE });
  ok("K1  erro na QUERY 1 -> falha_leitura", e1.coleta === "falha_leitura");
  ok("K2  e a QUERY 2 nao roda", chamadas.length === 1);
  ok("K3  zero selecoes devolvidas", e1.selecoes.length === 0);

  roteiro({ data: [S("shopee", "chat", L1)] }, { error: { code: "08006" } });
  const e2 = await resolverSelecoesDoAgente({ userId: USER, agenteId: AGENTE });
  ok("K4  erro na QUERY 2 -> falha_leitura", e2.coleta === "falha_leitura");
  ok("K5  a selecao da QUERY 1 NAO vira resultado valido", e2.selecoes.length === 0);

  for (const [rot, q1, q2] of [
    ["loja ausente", [S("shopee", "chat", L1)], []],
    ["loja de outro dono", [S("shopee", "chat", L1)], [LJ(L1, OUTRO)]],
    ["plataforma desconhecida", [S("amazon", "chat", L1)], [LJ(L1)]],
    ["recurso invalido", [S("shopee", "Chat", L1)], [LJ(L1)]],
    ["duplicata de requisito", [S("shopee", "chat", L1), S("shopee", "chat", L2)], [LJ(L1), LJ(L2)]],
    ["agente errado na linha", [S("shopee", "chat", L1, { agente_id: "x" })], [LJ(L1)]],
    ["user_id errado na linha", [S("shopee", "chat", L1, { user_id: OUTRO })], [LJ(L1)]],
  ] as const) {
    roteiro({ data: q1 }, { data: q2 });
    const r = await resolverSelecoesDoAgente({ userId: USER, agenteId: AGENTE });
    ok(`K6 ${rot} -> falha_leitura`, r.coleta === "falha_leitura");
    ok(`K7 ${rot} -> zero selecoes (sem parcial)`, r.selecoes.length === 0);
  }

  secao("L. Ordem e ausencia");

  roteiro(
    { data: [S("shopee", "pedidos", L2), S("mercado_livre", "chat", L1), S("shopee", "chat", L1)] },
    { data: [LJ(L1), LJ(L2)] }
  );
  const ord = await resolverSelecoesDoAgente({ userId: USER, agenteId: AGENTE });
  ok("L1  saida em ordem deterministica",
    JSON.stringify(ord.selecoes.map((s) => `${s.plataforma}/${s.recurso}`)) ===
      JSON.stringify(["mercado_livre/chat", "shopee/chat", "shopee/pedidos"]));
  ok("L2  cada selecao devolve so plataforma/recurso/lojaId",
    JSON.stringify(Object.keys(ord.selecoes[0]).sort()) ===
      JSON.stringify(["lojaId", "plataforma", "recurso"]));
  ok("L3  ausencia NAO e diagnostico — coleta ok com lista vazia, e nada mais",
    vazio.coleta === "ok" && !("estado" in vazio) && !("pendencias" in vazio));

  secao("M. O que o modulo NAO faz");

  ok("M1  zero .insert(/.update(/.upsert(/.delete(",
    !/\.(insert|update|upsert|delete)\(/.test(CODIGO_FATOS));
  ok("M2  CONTROLE: a sonda de write acharia", /\.(insert|update)\(/.test('.insert({a:1})'));
  ok("M3  nenhuma chamada PROIBIDA foi registrada pelo duplo",
    !chamadas.some((c) => c.tabela.startsWith("PROIBIDO:")));
  ok("M4  zero resolverFatoConexao", !/resolverFatoConexao/.test(CODIGO_FATOS));
  ok("M5  zero escolha automatica de loja",
    !/\[0\]|\.first\(|\.single\(|\.maybeSingle\(|limit\(1\)|order\(/.test(CODIGO_FATOS));
  ok("M6  CONTROLE: a sonda de escolha automatica acharia",
    /\[0\]|\.maybeSingle\(/.test("const loja = data[0]"));
  ok("M7  exatamente DUAS chamadas .from( no modulo",
    (CODIGO_FATOS.match(/\.from\(/g) ?? []).length === 2);
  ok("M8  nunca le error.message", !/error\.(message|details|hint)/.test(CODIGO_FATOS));
  ok("M9  nenhum token e projetado",
    !/access_token|refresh_token|partner_key/.test(CODIGO_FATOS));
  ok("M10 zero funcao de escrita exportada",
    !/export async function (definir|salvar|upsert|remover|deletar)/i.test(CODIGO_FATOS));

  secao("N. Fronteira — nada de producao consome isto");

  const alvos: string[] = [];
  const varrer = (dir: string): void => {
    for (const e of readdirSync(join(RAIZ, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (!/node_modules|\.next/.test(e.name)) varrer(rel);
      } else if (/\.tsx?$/.test(e.name) && !rel.startsWith("lib/agentes/conexoes/selecao-")) {
        if (/resolverSelecoesDoAgente|selecao-fatos/.test(ler(rel))) alvos.push(rel);
      }
    }
  };
  varrer("lib");
  varrer("app");
  ok("N1  zero consumidor de producao", alvos.length === 0, alvos.join(", "));
  ok("N2  ANCORA: a varredura leu arquivos de verdade",
    existsSync(join(RAIZ, "lib/agentes/conexoes/fatos.ts")));
  ok("N3  diagnostico.ts nao foi tocado — sem falta_selecao ainda",
    !/falta_selecao|FALTA_SELECAO/.test(ler("lib/ia/skills/diagnostico.ts")));
  ok("N4  resolverFatoConexao segue exigindo lojaId",
    /lojaId: string/.test(ler("lib/agentes/conexoes/fatos.ts")));

  console.log(`\n══ ${passou} PASS / ${falhou} FAIL ══\n`);
  process.exitCode = falhou === 0 ? 0 : 1;
}

principal().catch((e) => {
  console.log(`  FAIL  excecao nao tratada — ${String(e).slice(0, 300)}`);
  process.exitCode = 1;
});
