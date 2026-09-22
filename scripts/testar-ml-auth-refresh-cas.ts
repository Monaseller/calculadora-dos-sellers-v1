/**
 * A2-C2 — renovacao de credencial ML sob concorrencia.
 *
 * ── O defeito ───────────────────────────────────────────────────────
 *
 * `getMLLojaById` e `getMLLojaAtiva` renovam token vencido e gravam com
 * `saveTokensToDB(lojaId, userId, result)` — TRES argumentos. O quarto,
 * `refreshTokenAnterior`, e o que liga o compare-and-swap que ja existe
 * em `gravarCredencialML`. Sem ele a escrita e CEGA.
 *
 * Duas execucoes que leem a mesma linha vencida chamam o ML com o MESMO
 * refresh_token. O ML rotaciona. Quem escreve por ultimo apaga a
 * credencial de quem escreveu primeiro — e o refresh_token sobrescrito
 * pode ja nao valer mais no provider. A conta cai.
 *
 * ── Por que o duplo do banco precisa honrar o CAS ───────────────────
 *
 * Um mock que aceite todo `update` provaria o contrario do que
 * queremos: o teste passaria com e sem o fix. Entao a tabela em memoria
 * implementa a escrita CONDICIONAL de verdade — `update` so atinge as
 * linhas que casam com TODOS os `.eq()`, inclusive `refresh_token`, e
 * `.select("id")` devolve exatamente as linhas atingidas.
 *
 * Zero rede real, zero banco real, zero credencial real.
 *
 * Rodar:  npx tsx scripts/testar-ml-auth-refresh-cas.ts
 */
import "./_server-only-inerte";

import Module from "node:module";

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

// ─── Identidades sinteticas ───────────────────────────────────────────

const USER = "user-sintetico-a2c2";
const LOJA = "bbbbbbbb-0000-4000-8000-00000000000b";
const HORA_MS = 3_600_000;
const vencido = () => new Date(Date.now() - 10 * HORA_MS).toISOString();
const valido = () => new Date(Date.now() + 5 * HORA_MS).toISOString();

// ─── Tabela `lojas` em memoria, com escrita CONDICIONAL real ──────────

interface Linha {
  id: string;
  user_id: string;
  marketplace: string;
  ativo: boolean;
  nickname: string | null;
  seller_id: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
}

let tabela: Linha[] = [];
let leituras = 0;
let escritasTentadas = 0;
let escritasEfetivas = 0;

function construtor(nomeTabela: string): unknown {
  const filtros: Record<string, unknown> = {};
  let campos: Record<string, unknown> | null = null;

  const casam = () =>
    nomeTabela !== "lojas"
      ? []
      : tabela.filter((l) =>
          Object.entries(filtros).every(
            ([c, v]) => (l as unknown as Record<string, unknown>)[c] === v
          )
        );

  const aplicar = () => {
    escritasTentadas++;
    const alvo = casam();
    for (const l of alvo) Object.assign(l, campos);
    if (alvo.length > 0) escritasEfetivas++;
    return alvo.map((l) => ({ id: l.id }));
  };

  const b: Record<string, unknown> = {
    select() { return b; },
    update(c: Record<string, unknown>) { campos = c; return b; },
    eq(coluna: string, valor: unknown) { filtros[coluna] = valor; return b; },
    order() { return b; },
    limit() { return b; },
    maybeSingle() {
      leituras++;
      const r = casam();
      return { then: (fn: (v: { data: unknown; error: unknown }) => void) =>
        fn({ data: r[0] ?? null, error: null }) };
    },
    then(fn: (v: { data: unknown; error: unknown }) => void) {
      if (campos !== null) { fn({ data: aplicar(), error: null }); return; }
      leituras++;
      fn({ data: casam(), error: null });
    },
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

// ─── O `fetch` do /oauth/token ────────────────────────────────────────

let chamadasOauth = 0;
/** Cada chamada devolve um par DIFERENTE — e assim que o ML rotaciona. */
let paresDeRotacao: { access: string; refresh: string | null }[] = [];
/** Barreira: solta so quando N chamadas chegaram, forcando a corrida. */
let barreiraAlvo = 0;
let barreiraChegadas = 0;
let soltarBarreira: (() => void) | null = null;
let barreira: Promise<void> | null = null;

function armarBarreira(n: number): void {
  barreiraAlvo = n;
  barreiraChegadas = 0;
  barreira = n > 0 ? new Promise<void>((r) => { soltarBarreira = r; }) : null;
}

/**
 * Portoes por INDICE de chamada ao OAuth.
 *
 * O MODEL 1 precisa de uma ordem exata: o perdedor falha, le uma vez e
 * so DEPOIS o vencedor persiste. Sem controlar isso, o teste dependeria
 * de quem ganha a corrida de microtasks — e passaria ou falharia por
 * sorte. O portao e uma condicao sobre o estado observavel do duplo
 * (quantas leituras ja aconteceram), nunca um `sleep`.
 */
let portoes: Record<number, () => boolean> = {};
async function esperarPortao(indice: number): Promise<void> {
  const cond = portoes[indice];
  if (!cond) return;
  while (!cond()) await new Promise((r) => setImmediate(r));
}

globalThis.fetch = (async (url: string | URL | Request) => {
  const alvo = String(url);
  if (!alvo.includes("/oauth/token")) {
    throw new Error(`suite sem rede: fetch inesperado (${alvo.slice(0, 60)})`);
  }
  const indice = chamadasOauth++;

  await esperarPortao(indice);

  if (barreira !== null) {
    barreiraChegadas++;
    if (barreiraChegadas >= barreiraAlvo) soltarBarreira?.();
    await barreira;
  }

  const par = paresDeRotacao[indice];
  if (par === undefined) return { ok: false, status: 400, json: async () => ({}) } as unknown as Response;
  return {
    ok: true,
    status: 200,
    json: async () => ({
      access_token: par.access,
      refresh_token: par.refresh ?? undefined,
      expires_in: 21600,
    }),
  } as unknown as Response;
}) as unknown as typeof fetch;

// ─── Cenario ──────────────────────────────────────────────────────────

function semear(opcoes: Partial<Linha> = {}): void {
  tabela = [{
    id: LOJA,
    user_id: USER,
    marketplace: "ML",
    ativo: true,
    nickname: "LOJA SINTETICA",
    seller_id: "seller-sintetico",
    access_token: "A0",
    refresh_token: "R0",
    token_expires_at: vencido(),
    ...opcoes,
  }];
  leituras = 0;
  escritasTentadas = 0;
  escritasEfetivas = 0;
  chamadasOauth = 0;
  portoes = {};
  armarBarreira(0);
}

const linha = () => tabela[0];

async function principal(): Promise<void> {
  console.log("\n══ CDS — A2-C2: renovacao de credencial ML sob concorrencia ══");

  // `refreshMLToken` faz `process.env.ML_CLIENT_ID!.trim()`. Ausentes, o
  // `!` estoura TypeError, o catch engole e tudo vira "refresh falhou" —
  // os casos de corrida nunca aconteceriam e a suite passaria vazia.
  process.env.ML_CLIENT_ID = "app-sintetico";
  process.env.ML_CLIENT_SECRET = "segredo-sintetico";

  const auth = await import("../lib/ml-auth");
  ok("SETUP  o cliente Supabase foi interceptado", interceptou);

  // ── CASE A ────────────────────────────────────────────────────────
  secao("CASE A — token valido: nenhum refresh, nenhuma escrita");
  semear({ token_expires_at: valido(), access_token: "A0" });
  const a = await auth.getMLLojaById(LOJA, USER);
  ok("A1  devolveu credencial", a !== null);
  ok("A2  o access token e o do banco", a?.accessToken === "A0", String(a?.accessToken));
  ok("A3  ZERO chamadas ao /oauth/token", chamadasOauth === 0, String(chamadasOauth));
  ok("A4  ZERO escritas", escritasTentadas === 0, String(escritasTentadas));

  // ── CASE B ────────────────────────────────────────────────────────
  secao("CASE B — token vencido, execucao unica: 1 refresh, CAS vence");
  semear();
  paresDeRotacao = [{ access: "A1", refresh: "R1" }];
  const b = await auth.getMLLojaById(LOJA, USER);
  ok("B1  UMA chamada ao /oauth/token", chamadasOauth === 1, String(chamadasOauth));
  ok("B2  a credencial nova foi persistida", linha().refresh_token === "R1", String(linha().refresh_token));
  ok("B3  o access token novo foi persistido", linha().access_token === "A1");
  ok("B4  a validade avancou", new Date(linha().token_expires_at!).getTime() > Date.now());
  ok("B5  devolveu o access token novo", b?.accessToken === "A1", String(b?.accessToken));

  // ── CASE C + §15 ──────────────────────────────────────────────────
  secao("CASE C — DUAS execucoes concorrentes leem R0 [CORRIDA]");
  semear();
  paresDeRotacao = [{ access: "A1", refresh: "R1" }, { access: "A2", refresh: "R2" }];
  armarBarreira(2);   // nenhuma persiste antes de as duas terem lido
  const [c1, c2] = await Promise.all([
    auth.getMLLojaById(LOJA, USER),
    auth.getMLLojaById(LOJA, USER),
  ]);

  const devolvidos = [c1?.accessToken, c2?.accessToken];
  const vencedor = linha().access_token;
  const refreshFinal = linha().refresh_token;

  ok("C1  as duas chamaram o /oauth/token (o CAS NAO impede isso)",
    chamadasOauth === 2, String(chamadasOauth));
  ok("C2  TWO_CONCURRENT_CALLERS", c1 !== null || c2 !== null);
  ok("C3  CAS_WINNERS = 1 — exatamente UMA escrita foi efetiva",
    escritasEfetivas === 1, `efetivas=${escritasEfetivas} de ${escritasTentadas} tentativas`);
  ok("C4  CAS_LOSERS = 1", escritasTentadas - escritasEfetivas === 1,
    String(escritasTentadas - escritasEfetivas));
  ok("C5  DB_FINAL_REFRESH e o do VENCEDOR (R1), nao o do perdedor (R2)",
    refreshFinal === "R1", String(refreshFinal));
  ok("C6  DB_FINAL_ACCESS coerente com o vencedor",
    vencedor === "A1", String(vencedor));
  ok("C7  LOSER_RETURNED_REFRESH: os DOIS devolvem a credencial do banco",
    devolvidos.every((t) => t === vencedor), JSON.stringify(devolvidos));
  ok("C8  o perdedor NAO devolveu a propria credencial perdida (A2)",
    !devolvidos.includes("A2"), JSON.stringify(devolvidos));
  ok("C9  SECOND_PERSIST_ATTEMPT_BY_LOSER = 0 — no maximo 2 tentativas",
    escritasTentadas === 2, String(escritasTentadas));
  ok("C10 UNBOUNDED_RETRY = 0 — nenhum segundo /oauth/token apos o CAS perdido",
    chamadasOauth === 2, String(chamadasOauth));

  // ── CASE D ────────────────────────────────────────────────────────
  secao("CASE D — CAS perdido, releitura devolve credencial VALIDA");
  ok("D1  coberto por C7: o perdedor usou a credencial relida e valida",
    devolvidos.every((t) => t === "A1"), JSON.stringify(devolvidos));

  // ── CASE E ────────────────────────────────────────────────────────
  secao("CASE E — CAS perdido e a linha relida continua invalida");
  semear();
  paresDeRotacao = [{ access: "A1", refresh: "R1" }];
  // O `refresh_token` muda por baixo (outro processo venceu), mas a
  // linha que sobra NAO serve: sem access_token. Fail closed.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const r = await (originalFetch as unknown as (u: unknown) => Promise<Response>)(url);
    linha().refresh_token = "R-DE-OUTRO";
    linha().access_token = null;
    return r;
  }) as unknown as typeof fetch;
  const e = await auth.getMLLojaById(LOJA, USER);
  globalThis.fetch = originalFetch;
  ok("E1  o CAS perdeu (nenhuma escrita efetiva)", escritasEfetivas === 0, String(escritasEfetivas));
  ok("E2  FAIL CLOSED — devolveu null", e === null, JSON.stringify(e));
  ok("E3  e NAO tentou renovar de novo", chamadasOauth === 1, String(chamadasOauth));

  // ── CASE F ────────────────────────────────────────────────────────
  secao("CASE F — refresh remoto falha");
  semear();
  paresDeRotacao = [];   // sem par -> o fake devolve 400
  const f = await auth.getMLLojaById(LOJA, USER);
  ok("F1  tentou renovar uma vez", chamadasOauth === 1, String(chamadasOauth));
  ok("F2  NENHUMA persistencia", escritasTentadas === 0, String(escritasTentadas));
  ok("F3  a linha segue intacta", linha().refresh_token === "R0" && linha().access_token === "A0");
  ok("F4  FAIL CLOSED — nao devolve token vencido", f === null, JSON.stringify(f));

  // ── CASE G ────────────────────────────────────────────────────────
  secao("CASE G — refresh sem novo refresh_token: preserva o anterior");
  semear();
  paresDeRotacao = [{ access: "A1", refresh: null }];
  const g = await auth.getMLLojaById(LOJA, USER);
  ok("G1  o access token novo foi persistido", linha().access_token === "A1");
  ok("G2  o refresh_token ANTERIOR foi preservado", linha().refresh_token === "R0",
    String(linha().refresh_token));
  ok("G3  devolveu o access token novo", g?.accessToken === "A1");

  // ── CASE H ────────────────────────────────────────────────────────
  secao("CASE H — loja inativa / outro dono / outro marketplace");
  semear({ marketplace: "Shopee", token_expires_at: valido() });
  ok("H1  outro marketplace -> null", (await auth.getMLLojaById(LOJA, USER)) === null);
  semear({ token_expires_at: valido() });
  ok("H2  outro dono -> null", (await auth.getMLLojaById(LOJA, "outro-dono")) === null);
  semear({ access_token: null, token_expires_at: valido() });
  ok("H3  sem access_token -> null", (await auth.getMLLojaById(LOJA, USER)) === null);
  ok("H4  e nenhuma dessas tentou rede", chamadasOauth === 0, String(chamadasOauth));

  // ── CASE I ────────────────────────────────────────────────────────
  secao("CASE I — getMLLojaAtiva: mesma classe de corrida");
  semear();
  paresDeRotacao = [{ access: "A1", refresh: "R1" }, { access: "A2", refresh: "R2" }];
  armarBarreira(2);
  const [i1, i2] = await Promise.all([
    auth.getMLLojaAtiva(USER),
    auth.getMLLojaAtiva(USER),
  ]);
  ok("I1  CAS_WINNERS = 1", escritasEfetivas === 1, String(escritasEfetivas));
  ok("I2  DB_FINAL_REFRESH = R1", linha().refresh_token === "R1", String(linha().refresh_token));
  ok("I3  os dois devolvem a credencial do banco",
    i1?.accessToken === "A1" && i2?.accessToken === "A1",
    JSON.stringify([i1?.accessToken, i2?.accessToken]));
  ok("I4  nenhum segundo /oauth/token", chamadasOauth === 2, String(chamadasOauth));

  // ── MODEL 1: o desfecho que a DOCUMENTACAO sustenta ───────────────
  //
  // `refresh_token` e de uso unico. Duas execucoes partindo de R0 nao
  // renovam as duas: uma renova, a outra leva `invalid_grant`. Este e o
  // caso REAL de producao — e era exatamente o que o fix anterior nao
  // cobria: o perdedor remoto morria antes de qualquer releitura.

  secao("CASE J — MODEL 1: perdedor falha ANTES de o vencedor gravar");
  semear();
  // indice 0 = B (sem par -> 400); indice 1 = A (sucesso), e A so resolve
  // depois que B ja tiver feito a PRIMEIRA leitura de recuperacao.
  paresDeRotacao = [];
  paresDeRotacao[1] = { access: "A1", refresh: "R1" };
  portoes = { 1: () => leituras > 2 };   // 2 = uma leitura inicial por chamador
  const [jB, jA] = await Promise.all([
    auth.getMLLojaById(LOJA, USER),
    auth.getMLLojaById(LOJA, USER),
  ]);
  ok("J1  MODEL1_CALLERS = 2, MODEL1_OAUTH_CALLS = 2", chamadasOauth === 2, String(chamadasOauth));
  ok("J2  MODEL1_DB_WRITES_EFFECTIVE = 1", escritasEfetivas === 1, String(escritasEfetivas));
  ok("J3  MODEL1_WINNER = A — o banco ficou com R1", linha().refresh_token === "R1",
    String(linha().refresh_token));
  ok("J4  o vencedor devolveu a propria credencial", jA?.accessToken === "A1", String(jA?.accessToken));
  ok("J5  MODEL1_LOSER_RETURN = credencial do VENCEDOR", jB?.accessToken === "A1",
    String(jB?.accessToken));
  ok("J6  MODEL1_LOSER_READS = 2 — a primeira ainda via R0", leituras >= 4, `leituras=${leituras}`);
  ok("J7  MODEL1_SECOND_OAUTH_BY_LOSER = 0", chamadasOauth === 2, String(chamadasOauth));
  ok("J8  MODEL1_OLD_CREDENTIAL_ACCEPTED = NO", jB?.accessToken !== "A0", String(jB?.accessToken));
  ok("J9  o perdedor NAO gravou — 1 tentativa de escrita ao todo", escritasTentadas === 1,
    String(escritasTentadas));

  secao("CASE K — MODEL 1 com o vencedor JA visivel: uma leitura basta");
  semear();
  paresDeRotacao = [];                      // o unico OAuth falha
  portoes = { 0: () => { linha().access_token = "A1"; linha().refresh_token = "R1";
                         linha().token_expires_at = valido(); return true; } };
  const k = await auth.getMLLojaById(LOJA, USER);
  ok("K1  devolveu a credencial do vencedor", k?.accessToken === "A1", String(k?.accessToken));
  ok("K2  UM OAuth, que falhou", chamadasOauth === 1, String(chamadasOauth));
  ok("K3  nenhuma escrita", escritasTentadas === 0, String(escritasTentadas));
  ok("K4  nao esgotou o limite de leituras", leituras <= 2, String(leituras));

  secao("CASE L — falha genuina, NENHUM vencedor: nao reaceita R0");
  semear();
  paresDeRotacao = [];
  const l = await auth.getMLLojaById(LOJA, USER);
  ok("L1  FAIL CLOSED", l === null, JSON.stringify(l));
  ok("L2  OLD_REFRESH_REACCEPTED = NO", linha().refresh_token === "R0" && l === null);
  ok("L3  esgotou o limite, sem laco", leituras === 3, String(leituras));
  ok("L4  UM unico OAuth, sem retry", chamadasOauth === 1, String(chamadasOauth));
  ok("L5  nenhuma escrita", escritasTentadas === 0, String(escritasTentadas));

  secao("CASE M — refresh DIFERENTE porem credencial invalida: nao aceita");
  semear();
  paresDeRotacao = [];
  portoes = { 0: () => { linha().refresh_token = "R9"; linha().access_token = "A9";
                         linha().token_expires_at = vencido(); return true; } };
  ok("M1  rotacionou mas esta VENCIDA -> nao aceita",
    (await auth.getMLLojaById(LOJA, USER)) === null);
  semear();
  paresDeRotacao = [];
  portoes = { 0: () => { linha().refresh_token = "R9"; linha().access_token = null;
                         linha().token_expires_at = valido(); return true; } };
  ok("M2  rotacionou mas SEM access_token -> nao aceita",
    (await auth.getMLLojaById(LOJA, USER)) === null);

  secao("CASE N — nenhum chamador renova duas vezes");
  semear();
  paresDeRotacao = [{ access: "A1", refresh: "R1" }];
  await auth.getMLLojaById(LOJA, USER);
  ok("N1  caminho feliz: MAX_OAUTH_ATTEMPTS_PER_CALL = 1", chamadasOauth === 1, String(chamadasOauth));
  ok("N2  e sem releitura no caminho feliz", leituras === 1, String(leituras));
  semear();
  paresDeRotacao = [];
  await auth.getMLLojaById(LOJA, USER);
  ok("N3  caminho de falha: ainda UM unico OAuth", chamadasOauth === 1, String(chamadasOauth));

  secao("CASE I2 — getMLLojaAtiva no MODEL 1");
  semear();
  paresDeRotacao = [];
  paresDeRotacao[1] = { access: "A1", refresh: "R1" };
  portoes = { 1: () => leituras > 2 };
  const [i2B, i2A] = await Promise.all([
    auth.getMLLojaAtiva(USER),
    auth.getMLLojaAtiva(USER),
  ]);
  ok("I5  GET_ML_LOJA_ATIVA_MODEL1: o banco ficou com R1", linha().refresh_token === "R1",
    String(linha().refresh_token));
  ok("I6  os dois devolvem a credencial do vencedor",
    i2A?.accessToken === "A1" && i2B?.accessToken === "A1",
    JSON.stringify([i2A?.accessToken, i2B?.accessToken]));
  ok("I7  UMA escrita efetiva", escritasEfetivas === 1, String(escritasEfetivas));
  ok("I8  nenhum terceiro OAuth", chamadasOauth === 2, String(chamadasOauth));

  console.log(`\n── placar ${"─".repeat(54)}`);
  console.log(`  PASS ${passou}   FAIL ${falhou}\n`);
  if (falhou > 0) process.exitCode = 1;
}

void principal();
