/**
 * CDS IA — SKILL-1D.consumer-B2. Suite do compositor de diagnostico.
 *
 * O compositor e EXECUTADO de verdade, e com ele o pipeline inteiro:
 * `resolverSkillsDoAgente`, `resolverConexoesDoAgente` (que por dentro
 * chama de novo as Skills, as selecoes e o lote de conexoes) e
 * `resolverFatosPermissoes` rodam de verdade, contra um cliente DUPLADO
 * que registra cada leitura. Nenhuma das tres e substituida por callback:
 * o que se afirma nao e "o mock devolveu o esperado", e sim quantas
 * consultas o pipeline real fez, em que tabelas e em que ordem.
 *
 * ── Por que query budget e assert, e nao observacao ─────────────────
 *
 * O compositor existe para resolver fatos UMA vez por agente e reusa-los
 * em todas as Skills. Se alguem passar a resolver por Skill, o resultado
 * continua correto e o custo cresce em silencio. Por isso o numero de
 * leituras e TRAVADO por cenario.
 *
 * ── Ordem de import ─────────────────────────────────────────────────
 *
 * `funcoes/registry.ts` e `server-only` e alcanca os executores, que
 * importam `dados/vendas.ts`. O duplo de `Module.prototype.require`
 * precisa estar instalado ANTES de qualquer import de producao — por
 * isso o compositor entra por `await import` dentro de `principal()`.
 *
 * Rodar:  npx tsx scripts/testar-ia-skill-1d-consumer.ts
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

const CODIGO_COMPOSITOR = semComentarios(ler("lib/agentes/diagnostico/compositor.ts"));

// ─── O duplo do cliente Supabase ──────────────────────────────────────

interface Chamada {
  tabela: string;
  projecao?: string;
  filtros: Record<string, unknown>;
  inColuna?: string;
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
    select(cols: string) { c.projecao = cols; return b; },
    eq(coluna: string, valor: unknown) { c.filtros[coluna] = valor; return b; },
    in(coluna: string, valores: readonly unknown[]) { c.inColuna = coluna; c.inValores = valores; return b; },
    order() { return b; },
    // O compositor e READ-ONLY. Se alguma camada tentar escrever, a
    // chamada sai marcada e a sonda estrutural acusa.
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

const USER = "user-sintetico-consumer";
const AGENTE = "11111111-2222-3333-4444-555555555555";
const AGORA = Date.parse("2026-08-28T12:00:00.000Z");
const FUTURO = "2026-12-31T23:59:59.000Z";
const L = (n: number) => `aaaaaaaa-0000-4000-8000-00000000000${n}`;

/** A unica Funcao realmente registrada hoje — descoberta em runtime para
 *  a suite nao envelhecer se o catalogo crescer. */
let FUNCAO_REAL = "";

type Req = { plataforma: string; recurso: string; obrigatoria: boolean };

const manifesto = (
  id: string,
  versao: string,
  requer?: { funcoes?: string[]; funcoes_opcionais?: string[]; conexoes?: Req[] }
) => ({
  formato: 1,
  id,
  nome: `Skill ${id}`,
  versao,
  descricao: "Fixture do compositor.",
  quando_usar: ["quando o teste pedir"],
  origem: "importada",
  ...(requer ? { requer } : {}),
});

const assoc = (skillId: string) => ({ skill_id: skillId, criado_em: "2026-08-01T00:00:00.000Z" });
const linhaSkill = (uuid: string, man: unknown) => ({ id: uuid, manifesto: man, corpo: "corpo" });
const linhaSelecao = (plataforma: string, recurso: string, lojaId: string) =>
  ({ agente_id: AGENTE, user_id: USER, plataforma, recurso, loja_id: lojaId });
const linhaLojaDona = (id: string) => ({ id, user_id: USER });
const loja = (id: string, extra: Record<string, unknown> = {}) => ({
  id, marketplace: "Shopee", ativo: true,
  access_token: "token-sintetico-nunca-deve-vazar", token_expires_at: FUTURO, ...extra,
});
const linhaPermissao = (funcaoId: string, nivel: string) =>
  ({ funcao_id: funcaoId, nivel });

const AG = { userId: USER, agenteId: AGENTE, agoraMs: AGORA };

const tabelas = () => chamadas.map((c) => c.tabela).join(" > ");
const queriesEm = (t: string) => chamadas.filter((c) => c.tabela === t).length;

console.log("\n══ CDS IA — SKILL-1D.consumer-B2: compositor de diagnostico ══");

// ─── A. Fronteira estatica ────────────────────────────────────────────

secao("A. O compositor compoe — e so isso");

ok("A1  e server-only", /import "server-only"/.test(CODIGO_COMPOSITOR));
ok("A2  zero Supabase direto",
  !/getSupabaseServidor|createClient|\.from\(|\.select\(|\.eq\(|\.in\(/.test(CODIGO_COMPOSITOR));
ok("A3  zero nome de tabela",
  !/"lojas"|"skills"|"agente_skills"|"agente_permissoes"|"agente_conexoes"/.test(CODIGO_COMPOSITOR));
ok("A4  zero credencial",
  !/access_token|refresh_token|partner_key|service_role/.test(CODIGO_COMPOSITOR));
ok("A5  zero write",
  !/\.insert\(|\.update\(|\.upsert\(|\.delete\(|\.rpc\(|definirSelecaoDeLoja|removerSelecaoDeLoja/
    .test(CODIGO_COMPOSITOR));
ok("A6  zero escolha de vigente",
  !/vigente|latest|\.limit\(|\.order\(/.test(CODIGO_COMPOSITOR));
ok("A7  zero branch de marketplace — o dominio ja chega canonicalizado",
  !/"shopee"|"mercado_livre"|switch \(plataforma/.test(CODIGO_COMPOSITOR));
ok("A8  zero autoridade temporal propria",
  !/Date\.now\(|new Date\(/.test(CODIGO_COMPOSITOR));
ok("A9  nao alcanca APIs internas do agregador",
  !/resolverSelecoesDoAgente|resolverFatoConexao|resolverFatosConexao/.test(CODIGO_COMPOSITOR));
ok("A10 zero estado de diagnostico novo",
  !/FALTA_SELECAO|PLATAFORMA_INVALIDA|PLATAFORMA_NAO_SUPORTADA/.test(CODIGO_COMPOSITOR));
ok("A11 nao executa Funcao — so pergunta se existe",
  /funcaoExiste/.test(CODIGO_COMPOSITOR) && !/resolverFuncao/.test(CODIGO_COMPOSITOR));
ok("A12 nao passa `configuracoes` ao motor",
  !/configuracoes/.test(CODIGO_COMPOSITOR));
ok("A13 CONTROLE: as sondas acusam quando o padrao existe",
  /\.from\(/.test('x.from("t")') && /vigente/.test("eq('vigente', true)"));

// ─── B–J. Comportamento real ──────────────────────────────────────────

async function principal(): Promise<void> {
  const { diagnosticarAgente } = await import("../lib/agentes/diagnostico/compositor");
  const { listarFuncoesRegistradas } = await import("../lib/agentes/funcoes/registry");
  FUNCAO_REAL = listarFuncoesRegistradas()[0] ?? "";

  secao("B. O instrumento de medida esta instalado");

  ok("B1  ANCORA: o duplo interceptou o cliente Supabase", interceptou);
  const carregados = Object.keys(require.cache).map((p) => p.replace(/\\/g, "/"));
  ok("B2  ANCORA: o compositor esta no grafo",
    carregados.some((p) => p.includes("/lib/agentes/diagnostico/compositor.ts")));
  ok("B3  nenhum cliente Supabase real carregado",
    !carregados.some((p) => /@supabase|supabase-servidor/.test(p)));
  ok("B4  ANCORA: o registry real foi carregado e tem ao menos uma Funcao",
    FUNCAO_REAL.length > 0, FUNCAO_REAL);

  // ── C. Guards e curto-circuitos ────────────────────────────────────

  secao("C. Entrada invalida e agente sem Skills");

  for (const [nome, e] of [
    ["C1  userId vazio", { ...AG, userId: "" }],
    ["C2  agenteId vazio", { ...AG, agenteId: "" }],
  ] as [string, typeof AG][]) {
    roteiro();
    const r = await diagnosticarAgente(e);
    ok(`${nome} -> entrada_invalida + 0 query`,
      r.coleta === "entrada_invalida" && r.diagnosticos.length === 0 &&
        r.semSelecao.length === 0 && chamadas.length === 0,
      `${r.coleta} / ${chamadas.length}`);
  }

  roteiro({ data: [] });
  const rSemSkills = await diagnosticarAgente(AG);
  ok("C3  agente sem Skills -> ok, vazio, TOTAL 1 query",
    rSemSkills.coleta === "ok" && rSemSkills.diagnosticos.length === 0 &&
      rSemSkills.semSelecao.length === 0 && chamadas.length === 1,
    `${rSemSkills.coleta} / ${chamadas.length} · ${tabelas()}`);
  ok("C4  zero Skills nao aciona agregador, permissoes nem motor",
    queriesEm("lojas") === 0 && queriesEm("agente_conexoes") === 0 &&
      queriesEm("agente_permissoes") === 0);

  // ── D. Query budget ────────────────────────────────────────────────

  secao("D. Query budget — travado por cenario");

  // 1 Skill sem requisito nenhum: Skills(2) + agregador(2) + permissoes(0)
  roteiro(
    { data: [assoc("s1")] },
    { data: [linhaSkill("s1", manifesto("skill-a", "1.0.0"))] },
    { data: [assoc("s1")] },
    { data: [linhaSkill("s1", manifesto("skill-a", "1.0.0"))] }
  );
  const rSemReq = await diagnosticarAgente(AG);
  ok("D1  1 Skill sem requisitos -> TOTAL 4 queries",
    chamadas.length === 4 && rSemReq.coleta === "ok" && rSemReq.diagnosticos.length === 1,
    `${chamadas.length} · ${tabelas()}`);
  ok("D2  permissoes com lista vazia -> 0 query",
    queriesEm("agente_permissoes") === 0);
  ok("D3  sem requisito de conexao, o agregador nao le selecoes",
    queriesEm("agente_conexoes") === 0);

  // 1 Skill so com funcao: Skills(2) + agregador(2) + permissoes(1)
  const manFuncao = manifesto("skill-f", "1.0.0", { funcoes: [FUNCAO_REAL] });
  roteiro(
    { data: [assoc("s1")] }, { data: [linhaSkill("s1", manFuncao)] },
    { data: [assoc("s1")] }, { data: [linhaSkill("s1", manFuncao)] },
    { data: [linhaPermissao(FUNCAO_REAL, "automatico")] }
  );
  const rFuncao = await diagnosticarAgente(AG);
  ok("D4  1 Skill so com Funcao -> TOTAL 5 queries",
    chamadas.length === 5, `${chamadas.length} · ${tabelas()}`);
  ok("D5  permissoes chamada UMA vez, com o id requerido",
    queriesEm("agente_permissoes") === 1 &&
      JSON.stringify(chamadas.find((c) => c.tabela === "agente_permissoes")?.inValores) ===
        JSON.stringify([FUNCAO_REAL]));
  ok("D6  Funcao registrada + nivel automatico -> Skill pronta",
    rFuncao.diagnosticos[0]?.diagnostico.pronto === true,
    rFuncao.diagnosticos[0]?.diagnostico.estadoGeral);

  // 1 conexao selecionada, zero funcao: Skills(2) + agregador(5) + perm(0)
  const REQ: Req = { plataforma: "shopee", recurso: "chat", obrigatoria: true };
  const manConexao = manifesto("skill-c", "1.0.0", { conexoes: [REQ] });
  const roteiroConexao = (extraLoja: Record<string, unknown> = {}) => [
    { data: [assoc("s1")] }, { data: [linhaSkill("s1", manConexao)] },
    { data: [assoc("s1")] }, { data: [linhaSkill("s1", manConexao)] },
    { data: [linhaSelecao("shopee", "chat", L(1))] },
    { data: [linhaLojaDona(L(1))] },
    { data: [loja(L(1), extraLoja)] },
  ];
  roteiro(...roteiroConexao());
  const rConexao = await diagnosticarAgente(AG);
  ok("D7  1 conexao selecionada, zero Funcao -> TOTAL 7 queries",
    chamadas.length === 7, `${chamadas.length} · ${tabelas()}`);
  ok("D8  e permissoes continua com 0 query", queriesEm("agente_permissoes") === 0);
  // Conta conectada e valida NAO produz PRONTO: `coberturaDoRecurso`
  // devolve `nao_verificavel` para todo recurso, porque a CDS ainda nao
  // sabe afirmar que uma autorizacao cobre um recurso especifico. O motor
  // se recusa a chutar — nem otimismo (PRONTO) nem pessimismo
  // (FALTA_CONEXAO) — e como o requisito e obrigatorio a pendencia
  // bloqueia. O compositor apenas transporta esse veredito.
  const dConexao = rConexao.diagnosticos[0]?.diagnostico;
  ok("D9  conexao conectada + cobertura nao_verificavel -> NAO_VERIFICAVEL bloqueante",
    dConexao?.estadoGeral === "NAO_VERIFICAVEL" && dConexao?.pronto === false &&
      dConexao?.bloqueios.length === 1 &&
      dConexao?.bloqueios[0]?.estado === "NAO_VERIFICAVEL" &&
      dConexao?.bloqueios[0]?.tipo === "conexao" &&
      dConexao?.bloqueios[0]?.alvo === "shopee/chat",
    `${dConexao?.estadoGeral} · ${JSON.stringify(dConexao?.bloqueios)}`);

  // 1 conexao + 1 funcao: 2 + 5 + 1 = 8
  const manCheia = manifesto("skill-x", "1.0.0", { funcoes: [FUNCAO_REAL], conexoes: [REQ] });
  roteiro(
    { data: [assoc("s1")] }, { data: [linhaSkill("s1", manCheia)] },
    { data: [assoc("s1")] }, { data: [linhaSkill("s1", manCheia)] },
    { data: [linhaSelecao("shopee", "chat", L(1))] },
    { data: [linhaLojaDona(L(1))] },
    { data: [loja(L(1))] },
    { data: [linhaPermissao(FUNCAO_REAL, "automatico")] }
  );
  const rCheia = await diagnosticarAgente(AG);
  ok("D10 1 conexao + 1 Funcao -> TOTAL 8 queries",
    chamadas.length === 8, `${chamadas.length} · ${tabelas()}`);
  // Mesma razao de D9: a Funcao esta liberada (nao aparece em bloqueios
  // nem limitacoes) e mesmo assim a Skill nao fica pronta, porque a
  // conexao continua NAO_VERIFICAVEL. O unico bloqueio e o da conexao.
  const dCheia = rCheia.diagnosticos[0]?.diagnostico;
  ok("D11 Funcao liberada + conexao nao verificavel -> unico bloqueio e a conexao",
    dCheia?.pronto === false && dCheia?.estadoGeral === "NAO_VERIFICAVEL" &&
      dCheia?.bloqueios.length === 1 && dCheia?.bloqueios[0]?.tipo === "conexao" &&
      dCheia?.limitacoes.length === 0 &&
      JSON.stringify(dCheia?.funcoesUtilizaveis) === JSON.stringify([FUNCAO_REAL]),
    `${dCheia?.estadoGeral} · ${JSON.stringify(dCheia?.bloqueios)}`);

  // N Skills / 5 conexoes / funcao compartilhada: continua 8
  const cinco: Req[] = Array.from({ length: 5 }, (_, i) =>
    ({ plataforma: "shopee", recurso: `recurso-${i}`, obrigatoria: true }));
  const manA = manifesto("skill-a", "1.0.0", { funcoes: [FUNCAO_REAL], conexoes: cinco.slice(0, 3) });
  const manB = manifesto("skill-b", "1.0.0", { funcoes: [FUNCAO_REAL], conexoes: cinco.slice(3) });
  const skillsAB = [linhaSkill("s1", manA), linhaSkill("s2", manB)];
  const selecoes5 = cinco.map((r) => linhaSelecao("shopee", r.recurso, L(1)));
  const roteiroAB = () => [
    { data: [assoc("s1"), assoc("s2")] }, { data: skillsAB },
    { data: [assoc("s1"), assoc("s2")] }, { data: skillsAB },
    { data: selecoes5 },
    { data: [linhaLojaDona(L(1))] },
    { data: [loja(L(1))] },
    { data: [linhaPermissao(FUNCAO_REAL, "automatico")] },
  ];
  roteiro(...roteiroAB());
  const rAB = await diagnosticarAgente(AG);
  ok("D12 2 Skills / 5 conexoes / Funcao compartilhada -> TOTAL 8 queries",
    chamadas.length === 8, `${chamadas.length} · ${tabelas()}`);
  ok("D13 o custo NAO cresce por Skill — agregador e permissoes 1x cada",
    queriesEm("agente_conexoes") === 1 && queriesEm("agente_permissoes") === 1 &&
      queriesEm("lojas") === 2, tabelas());
  ok("D14 2 Skills -> 2 diagnosticos", rAB.diagnosticos.length === 2);
  ok("D15 zero RPC em todo o pipeline", rpcs === 0);

  // ── E. Funcoes ─────────────────────────────────────────────────────

  secao("E. Funcoes — dedupe, opcionais e existencia");

  const INEXISTENTE = "funcao.que.nao.existe";
  const manDedupe = manifesto("skill-a", "1.0.0", {
    funcoes: [FUNCAO_REAL], funcoes_opcionais: [INEXISTENTE],
  });
  const manDedupe2 = manifesto("skill-b", "1.0.0", { funcoes: [FUNCAO_REAL] });
  const skillsD = [linhaSkill("s1", manDedupe), linhaSkill("s2", manDedupe2)];
  roteiro(
    { data: [assoc("s1"), assoc("s2")] }, { data: skillsD },
    { data: [assoc("s1"), assoc("s2")] }, { data: skillsD },
    { data: [linhaPermissao(FUNCAO_REAL, "automatico")] }
  );
  const rDedupe = await diagnosticarAgente(AG);
  const qPerm = chamadas.find((c) => c.tabela === "agente_permissoes");
  ok("E1  ids de Funcao deduplicados entre Skills",
    (qPerm?.inValores ?? []).length === 2, JSON.stringify(qPerm?.inValores));
  ok("E2  funcoes_opcionais TAMBEM entram na coleta",
    (qPerm?.inValores as string[] ?? []).includes(INEXISTENTE));
  ok("E3  a lista enviada e ordenada, nao depende da ordem das Skills",
    JSON.stringify(qPerm?.inValores) ===
      JSON.stringify([FUNCAO_REAL, INEXISTENTE].sort((a, b) => a.localeCompare(b))));
  ok("E4  Funcao inexistente vira FALTA_FUNCAO (limitacao, pois e opcional)",
    rDedupe.diagnosticos[0]?.diagnostico.limitacoes.some(
      (p) => p.estado === "FALTA_FUNCAO" && p.alvo === INEXISTENTE),
    JSON.stringify(rDedupe.diagnosticos[0]?.diagnostico.limitacoes));
  ok("E5  a Skill que NAO pediu a Funcao inexistente nao herda a pendencia",
    rDedupe.diagnosticos[1]?.diagnostico.limitacoes.length === 0 &&
      rDedupe.diagnosticos[1]?.diagnostico.bloqueios.length === 0,
    JSON.stringify(rDedupe.diagnosticos[1]?.diagnostico));

  // ── F. Multiplas Skills e versoes ──────────────────────────────────

  secao("F. Multiplas Skills, multiplas versoes, ordem");

  const v1 = linhaSkill("s1", manifesto("atendimento", "1.0.0"));
  const v2 = linhaSkill("s2", manifesto("atendimento", "2.0.0"));
  roteiro(
    { data: [assoc("s1"), assoc("s2")] }, { data: [v1, v2] },
    { data: [assoc("s1"), assoc("s2")] }, { data: [v1, v2] }
  );
  const rVers = await diagnosticarAgente(AG);
  ok("F1  duas versoes associadas -> DOIS diagnosticos",
    rVers.diagnosticos.length === 2, String(rVers.diagnosticos.length));
  ok("F2  mesmo skillId, versoes distintas — nenhuma escolha de vigente",
    rVers.diagnosticos[0]?.skillId === "atendimento" &&
      rVers.diagnosticos[1]?.skillId === "atendimento" &&
      rVers.diagnosticos[0]?.versao === "1.0.0" &&
      rVers.diagnosticos[1]?.versao === "2.0.0",
    rVers.diagnosticos.map((d) => `${d.skillId}@${d.versao}`).join(", "));
  ok("F3  skillId vem do manifesto, nao do uuid da linha",
    !rVers.diagnosticos.some((d) => d.skillId === "s1" || d.skillId === "s2"));

  const zA = linhaSkill("s1", manifesto("zeta", "1.0.0"));
  const zB = linhaSkill("s2", manifesto("alfa", "1.0.0"));
  roteiro(
    { data: [assoc("s1"), assoc("s2")] }, { data: [zA, zB] },
    { data: [assoc("s1"), assoc("s2")] }, { data: [zA, zB] }
  );
  const rOrdem = await diagnosticarAgente(AG);
  ok("F4  a ordem e a publicada pela leitura de Skills, nao alfabetica",
    JSON.stringify(rOrdem.diagnosticos.map((d) => d.skillId)) ===
      JSON.stringify(["zeta", "alfa"]),
    rOrdem.diagnosticos.map((d) => d.skillId).join(", "));

  // ── G. semSelecao e selected-no-fact ───────────────────────────────

  secao("G. semSelecao transportado, selected-no-fact preservado");

  roteiro(
    { data: [assoc("s1")] }, { data: [linhaSkill("s1", manConexao)] },
    { data: [assoc("s1")] }, { data: [linhaSkill("s1", manConexao)] },
    { data: [] }
  );
  const rSemSel = await diagnosticarAgente(AG);
  ok("G1  requisito sem selecao -> semSelecao transportado",
    rSemSel.coleta === "ok" && rSemSel.semSelecao.length === 1 &&
      rSemSel.semSelecao[0]?.plataforma === "shopee" &&
      rSemSel.semSelecao[0]?.recurso === "chat" &&
      rSemSel.semSelecao[0]?.obrigatoria === true,
    JSON.stringify(rSemSel.semSelecao));
  ok("G2  e o diagnostico ainda diz FALTA_CONEXAO pela ausencia do fato",
    rSemSel.diagnosticos[0]?.diagnostico.estadoGeral === "FALTA_CONEXAO",
    rSemSel.diagnosticos[0]?.diagnostico.estadoGeral);
  ok("G3  zero FALTA_SELECAO — nenhum estado novo foi inventado",
    !JSON.stringify(rSemSel).includes("FALTA_SELECAO"));

  // Selecao EXISTE, mas a loja e de outro marketplace: o lote nao produz
  // fato, e o requisito NAO volta para semSelecao.
  roteiro(...roteiroConexao({ marketplace: "ML" }));
  const rSemFato = await diagnosticarAgente(AG);
  ok("G4  selecao existente sem fato NAO vira semSelecao",
    rSemFato.coleta === "ok" && rSemFato.semSelecao.length === 0,
    JSON.stringify(rSemFato.semSelecao));
  ok("G5  e o diagnostico e o mesmo FALTA_CONEXAO — a distincao vive fora do motor",
    rSemFato.diagnosticos[0]?.diagnostico.estadoGeral === "FALTA_CONEXAO");

  // ── H. Fail-closed ─────────────────────────────────────────────────

  secao("H. Falha em qualquer coleta derruba tudo");

  roteiro({ error: { code: "42501" } });
  const rFalhaSkills = await diagnosticarAgente(AG);
  ok("H1  falha nas Skills -> falha_leitura, tudo vazio, 1 query so",
    rFalhaSkills.coleta === "falha_leitura" && rFalhaSkills.diagnosticos.length === 0 &&
      rFalhaSkills.semSelecao.length === 0 && chamadas.length === 1);

  roteiro(
    { data: [assoc("s1")] }, { data: [linhaSkill("s1", manConexao)] },
    { data: [assoc("s1")] }, { error: { code: "42501" } }
  );
  const rFalhaCon = await diagnosticarAgente(AG);
  ok("H2  falha no agregador -> falha_leitura e ZERO permissoes",
    rFalhaCon.coleta === "falha_leitura" && rFalhaCon.diagnosticos.length === 0 &&
      queriesEm("agente_permissoes") === 0);

  // O caso mais perigoso: `semSelecao` ja calculado quando permissoes falham.
  roteiro(
    { data: [assoc("s1")] }, { data: [linhaSkill("s1", manCheia)] },
    { data: [assoc("s1")] }, { data: [linhaSkill("s1", manCheia)] },
    { data: [] },
    { error: { code: "42501" } }
  );
  const rFalhaPerm = await diagnosticarAgente(AG);
  ok("H3  falha nas permissoes descarta semSelecao ja obtido — zero parcial",
    rFalhaPerm.coleta === "falha_leitura" && rFalhaPerm.diagnosticos.length === 0 &&
      rFalhaPerm.semSelecao.length === 0,
    `${rFalhaPerm.coleta} / semSelecao=${rFalhaPerm.semSelecao.length}`);

  roteiro(
    { data: [assoc("s1")] }, { data: [linhaSkill("s1", manifesto("skill-a", "1.0.0"))] },
    { data: [assoc("s1")] }, { data: [linhaSkill("s1", manifesto("skill-a", "1.0.0"))] }
  );
  const rSeguro = await diagnosticarAgente(AG);
  ok("H4  zero credencial na saida publica",
    !/token|secret|senha|credencial/i.test(JSON.stringify(rSeguro)));
  ok("H5  nenhuma escrita foi tentada em todo o pipeline",
    chamadas.every((c) => !c.escrita));

  // ── I. Guardas nominais de consumer ────────────────────────────────
  //
  // `resolverConexoesDoAgente` e `diagnosticarSkill` nao tinham guarda
  // historica: ate esta frente nao havia consumidor nenhum. As duas
  // nascem aqui na forma FORTE — allowlist nominal, igualdade de
  // conjunto — para que um segundo consumidor reprove, e para que o
  // desaparecimento do autorizado tambem reprove.

  secao("I. Somente o compositor consome as camadas superiores");

  const CONSUMIDOR_AUTORIZADO = "lib/agentes/diagnostico/compositor.ts";

  const consumidoresDe = (simbolo: string, definicao: string): string[] => {
    const achados: string[] = [];
    const varrer = (dir: string): void => {
      for (const e of readdirSync(join(RAIZ, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) {
          if (!/node_modules|\.next/.test(e.name)) varrer(rel);
        } else if (/\.tsx?$/.test(e.name) && rel !== definicao) {
          if (new RegExp(simbolo).test(semComentarios(ler(rel)))) achados.push(rel);
        }
      }
    };
    varrer("lib");
    varrer("app");
    return achados.sort();
  };

  const consCon = consumidoresDe("resolverConexoesDoAgente", "lib/agentes/conexoes/agregador.ts");
  ok("I1  so o compositor consome resolverConexoesDoAgente",
    JSON.stringify(consCon) === JSON.stringify([CONSUMIDOR_AUTORIZADO]), consCon.join(", "));

  const consDiag = consumidoresDe("diagnosticarSkill", "lib/ia/skills/diagnostico.ts");
  ok("I2  so o compositor consome diagnosticarSkill",
    JSON.stringify(consDiag) === JSON.stringify([CONSUMIDOR_AUTORIZADO]), consDiag.join(", "));

  ok("I3  ANCORA: a varredura leu arquivos de verdade",
    consumidoresDe("resolverSkillsDoAgente", "lib/agentes/skills/fatos.ts").length > 0);
  ok("I4  CONTROLE: um segundo consumidor reprovaria",
    JSON.stringify([CONSUMIDOR_AUTORIZADO, "app/api/x/route.ts"].sort()) !==
      JSON.stringify([CONSUMIDOR_AUTORIZADO]));
  ok("I5  CONTROLE: o desaparecimento do autorizado tambem reprovaria",
    JSON.stringify([]) !== JSON.stringify([CONSUMIDOR_AUTORIZADO]));

  // ── J. Fronteira da fase ───────────────────────────────────────────

  secao("J. Zero consumidor acima do compositor");

  // A SKILL-1D.endpoint-B deu ao compositor o seu PRIMEIRO consumidor de
  // producao. O J1 exigia ZERO — correto enquanto ninguem o chamava. A
  // exigencia nao afrouxa: passa de "zero" para "EXATAMENTE ESTE", por
  // igualdade de conjunto e caminho nominal, como J6/P7/M12 ja fazem.
  //
  // Vale nos dois sentidos: um segundo consumidor reprova, a rota sumir
  // reprova, e uma copia sob `app/api/internal/` — que autentica por
  // segredo de worker, nao por sessao — reprova por nao estar na lista.
  const ROTA_AUTORIZADA = "app/api/agentes/[agenteId]/diagnostico/route.ts";
  const acima = consumidoresDe("diagnosticarAgente", "lib/agentes/diagnostico/compositor.ts");
  ok("J1  so a rota autorizada consome diagnosticarAgente",
    JSON.stringify(acima) === JSON.stringify([ROTA_AUTORIZADA]), acima.join(", "));
  ok("J2  a pasta do compositor tem exatamente 1 modulo",
    JSON.stringify(readdirSync(join(RAIZ, "lib/agentes/diagnostico")).sort()) ===
      JSON.stringify(["compositor.ts"]),
    readdirSync(join(RAIZ, "lib/agentes/diagnostico")).sort().join(", "));
  // O J3 media `app/api/` de topo, e passaria VERDE por acidente agora
  // que o topo novo e `agentes` — assert verde com intencao falsa e pior
  // que assert vermelho. Ele deixa de medir "existe pasta diagnostico" e
  // passa a medir a LOCALIZACAO autorizada.
  //
  // Divisao de trabalho com o J1: o J1 protege quem CHAMA o simbolo; o
  // J3 protege ONDE a fronteira HTTP pode existir. Um arquivo que apenas
  // repassa a chamada por outro nome escaparia do J1 e cairia aqui.
  const exposicoes: string[] = [];
  const varrerRotas = (dir: string): void => {
    for (const e of readdirSync(join(RAIZ, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) { if (!/node_modules|\.next/.test(e.name)) varrerRotas(rel); }
      else if (e.name === "route.ts" && /diagnostico/.test(rel)) exposicoes.push(rel);
    }
  };
  varrerRotas("app");
  ok("J3  a unica exposicao HTTP do diagnostico e a rota autorizada",
    JSON.stringify(exposicoes.sort()) === JSON.stringify([ROTA_AUTORIZADA]),
    exposicoes.join(", ") || "nenhuma");

  console.log(`\n══ ${passou} PASS / ${falhou} FAIL ══\n`);
  process.exitCode = falhou === 0 ? 0 : 1;
}

principal().catch((e) => {
  console.log(`  FAIL  excecao nao tratada — ${String(e).slice(0, 300)}`);
  process.exitCode = 1;
});
