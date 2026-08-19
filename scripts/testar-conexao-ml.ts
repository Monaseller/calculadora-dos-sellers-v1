/**
 * Resolvedor server-side de conta ML + `GET /api/ml/conexao` — F0.c.5, A+B.
 *
 * ── O que estas suítes provam ───────────────────────────────────────
 * 1. PROPRIEDADE: `user_id`, `marketplace` e `ativo` entram em TODA
 *    consulta de resolução, e `id` apenas se soma a eles. O duplo do
 *    Supabase registra cada `.eq()`, então o teste falha se um refactor
 *    futuro remover o filtro de dono — mesmo que o retorno continue igual.
 * 2. MÚLTIPLAS LOJAS: duas lojas sem escolha explícita nunca viram uma
 *    escolha arbitrária.
 * 3. REFRESH: acontece só quando precisa, é persistido, e falha vira
 *    PRECISA_RECONECTAR — nunca credencial apagada.
 * 4. NENHUM TOKEN NA RESPOSTA HTTP, varrendo todos os ramos.
 *
 * ── Sem rede, sem banco, sem credencial real ────────────────────────
 * `@supabase/supabase-js` e `globalThis.fetch` são substituídos por
 * duplos. Nenhum token real é usado ou impresso: todos os valores são
 * marcadores em `<colchetes>`. Nada publica, sincroniza ou executa OAuth.
 *
 * Uso: npx tsx scripts/testar-conexao-ml.ts
 */
// Ver nota em testar-ownership-ml.ts: a capability de credenciais é
// `server-only`, que lança fora da condição `react-server`.
import "./_server-only-inerte";
import Module from "node:module";

let ok = 0, falhou = 0;
let fila: Promise<void> = Promise.resolve();
function t(nome: string, fn: () => void | Promise<void>) {
  fila = fila.then(async () => {
    try { await fn(); ok++; console.log(`  PASS  ${nome}`); }
    catch (e: any) { falhou++; console.log(`  FALHA ${nome} -> ${e?.message ?? e}`); }
  });
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }
/** Cabeçalho na FILA — fora dela, imprimiria antes de todos os testes. */
function secao(titulo: string) { fila = fila.then(() => { console.log(titulo); }); }

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder-de-teste.invalid";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "chave-de-teste-invalida";
// PR #1: ver nota em testar-ownership-ml.ts — o caminho de credencial
// passou pelo cliente privilegiado, que é fail-closed. O duplo de
// `@supabase/supabase-js` continua sendo o que responde às consultas.
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "chave-de-teste-invalida";
process.env.ML_CLIENT_ID ??= "ficticio";
process.env.ML_CLIENT_SECRET ??= "ficticio";
// Segredo só deste processo, para emitir cookie de sessão nos testes da rota.
process.env.SESSION_SECRET ??= "segredo-de-teste-com-mais-de-32-bytes-000000";

const UID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const UID_SEM_LOJA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const LOJA_A1 = "11111111-1111-4111-8111-111111111111";
const LOJA_A2 = "1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a";
const LOJA_B1 = "22222222-2222-4222-8222-222222222222";
const LOJA_INATIVA = "33333333-3333-4333-8333-333333333333";
const LOJA_SHOPEE = "44444444-4444-4444-8444-444444444444";
const LOJA_INEXISTENTE = "99999999-9999-4999-8999-999999999999";

const daquiA = (ms: number) => new Date(Date.now() + ms).toISOString();
const HORA = 3600_000;

/** Mesmo seller em donos diferentes — o caso real medido no banco. */
const SELLER_COMPARTILHADO = "<seller-compartilhado>";

interface Linha {
  id: string; user_id: string | null; marketplace: string; ativo: boolean;
  nickname: string | null; seller_id: string | null;
  access_token: string | null; refresh_token: string | null; token_expires_at: string | null;
  created_at: string;
}

let linhas: Linha[] = [];

function semear() {
  linhas = [
    { id: LOJA_A1, user_id: UID_A, marketplace: "ML", ativo: true, nickname: "LojaA1", seller_id: SELLER_COMPARTILHADO,
      access_token: "<access-A1>", refresh_token: "<refresh-A1>", token_expires_at: daquiA(HORA), created_at: "2026-01-01" },
    { id: LOJA_A2, user_id: UID_A, marketplace: "ML", ativo: true, nickname: "LojaA2", seller_id: "<seller-A2>",
      access_token: "<access-A2>", refresh_token: "<refresh-A2>", token_expires_at: daquiA(HORA), created_at: "2026-02-01" },
    { id: LOJA_B1, user_id: UID_B, marketplace: "ML", ativo: true, nickname: "LojaB1", seller_id: SELLER_COMPARTILHADO,
      access_token: "<access-B1>", refresh_token: "<refresh-B1>", token_expires_at: daquiA(HORA), created_at: "2026-01-15" },
    { id: LOJA_INATIVA, user_id: UID_A, marketplace: "ML", ativo: false, nickname: "Desativada", seller_id: "<seller-inativa>",
      access_token: "<access-inativa>", refresh_token: "<refresh-inativa>", token_expires_at: daquiA(HORA), created_at: "2026-01-02" },
    { id: LOJA_SHOPEE, user_id: UID_A, marketplace: "Shopee", ativo: true, nickname: "ShopeeA", seller_id: "<seller-shopee>",
      access_token: "<access-shopee>", refresh_token: "<refresh-shopee>", token_expires_at: daquiA(HORA), created_at: "2026-01-03" },
  ];
}

interface Consulta { tabela: string; tipo: "select" | "update"; filtros: Record<string, unknown> }
let consultas: Consulta[] = [];
let erroDeBanco: { message: string } | null = null;

// ── Duplo do Mercado Livre ───────────────────────────────────────────
let chamadasML: string[] = [];
/** Resposta do próximo refresh. `null` = ML recusou. */
let respostaRefresh: { access_token: string; refresh_token?: string; expires_in?: number } | null = null;
/** Quando definido, o refresh só resolve depois que este gatilho for puxado. */
let segurarRefresh: (() => void) | null = null;

function reset() {
  semear();
  consultas = [];
  chamadasML = [];
  erroDeBanco = null;
  respostaRefresh = null;
  segurarRefresh = null;
}

/**
 * Deixa só uma loja ML ativa para A, no estado pedido.
 *
 * Chama `reset()` — e não apenas `semear()` — porque os contadores de
 * chamada ao ML precisam zerar junto. Sem isso, um teste herda as chamadas
 * do anterior e asserções sobre "quantas vezes renovou" viram ruído.
 */
function apenasUmaLojaA(estado: Partial<Linha>) {
  reset();
  linhas = linhas.filter(l => l.id !== LOJA_A2);
  Object.assign(linhas.find(l => l.id === LOJA_A1)!, estado);
}

function casa(l: Linha, filtros: Record<string, unknown>) {
  return Object.entries(filtros).every(([c, v]) => (l as any)[c] === v);
}

function clienteFalso() {
  const criarCadeia = (tabela: string) => {
    const filtros: Record<string, unknown> = {};
    let tipo: "select" | "update" = "select";
    let patch: Record<string, unknown> = {};

    const executar = () => {
      consultas.push({ tabela, tipo, filtros: { ...filtros } });
      if (erroDeBanco) return { data: null, error: erroDeBanco };
      const alvo = linhas.filter(l => casa(l, filtros));
      if (tipo === "select") return { data: alvo, error: null };
      for (const l of alvo) Object.assign(l, patch);
      // `update(...).select("id")` devolve as linhas realmente afetadas —
      // é o que torna o compare-and-swap observável.
      return { data: alvo.map(l => ({ id: l.id })), error: null };
    };

    const cadeia: any = {
      select: () => cadeia,
      update: (p: Record<string, unknown>) => { tipo = "update"; patch = p; return cadeia; },
      eq: (c: string, v: unknown) => { filtros[c] = v; return cadeia; },
      order: () => cadeia,
      limit: () => cadeia,
      maybeSingle: async () => {
        const r = executar();
        if (r.error) return { data: null, error: r.error };
        return { data: (r.data as any[])[0] ?? null, error: null };
      },
      then: (resolve: any) => resolve(executar()),
    };
    return cadeia;
  };
  return { from: (tabela: string) => criarCadeia(tabela) };
}

const requireOriginal = (Module as any).prototype.require;
(Module as any).prototype.require = function (id: string) {
  if (id === "@supabase/supabase-js") return { createClient: () => clienteFalso() };
  return requireOriginal.apply(this, arguments as any);
};

globalThis.fetch = (async (url: any) => {
  const alvo = String(url);
  chamadasML.push(alvo);
  // Qualquer destino fora do ML significa que um teste escapou do duplo.
  if (!alvo.includes("api.mercadolibre.com")) {
    throw new Error(`teste tentou acessar a rede: ${alvo}`);
  }
  if (segurarRefresh) {
    await new Promise<void>(liberar => {
      const anterior = segurarRefresh!;
      segurarRefresh = () => { anterior(); liberar(); };
    });
  }
  if (!respostaRefresh) {
    return { ok: false, status: 400, json: async () => ({ error: "invalid_grant" }) } as any;
  }
  const corpo = respostaRefresh;
  return { ok: true, status: 200, json: async () => corpo } as any;
}) as any;

type Mod = typeof import("../lib/ml-conexao");
let M: Mod;
let rotaGET: (req: Request) => Promise<Response>;
let emitirTokenSessao: (uid: string) => Promise<{ token: string }>;

function req(cookies: Record<string, string>) {
  const valor = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  return new Request("https://exemplo.test/api/ml/conexao",
    valor ? { headers: { cookie: valor } } : undefined);
}

/** Qualquer marcador de credencial dos dados de teste. */
const MARCADORES_DE_TOKEN = /<access-|<refresh-|access_token|refresh_token|authorization|client_secret/i;

async function principal() {
  M = await import("../lib/ml-conexao");
  ({ emitirTokenSessao } = await import("../lib/autenticacao"));
  ({ GET: rotaGET } = await import("../app/api/ml/conexao/route") as any);

  const tokenA = (await emitirTokenSessao(UID_A)).token;
  const tokenB = (await emitirTokenSessao(UID_B)).token;
  const tokenSemLoja = (await emitirTokenSessao(UID_SEM_LOJA)).token;

  secao("\n[1. seleção de loja]");

  t("A. usuário sem nenhuma loja -> SEM_LOJA", async () => {
    reset();
    const r = await M.resolverContaML(UID_SEM_LOJA);
    assert(!r.ok && r.motivo === "SEM_LOJA", `esperado SEM_LOJA, veio ${JSON.stringify(r)}`);
  });

  t("B. exatamente 1 loja válida -> resolve a própria, sem lojaId", async () => {
    apenasUmaLojaA({});
    const r = await M.resolverContaML(UID_A);
    assert(r.ok, `esperado ok, veio ${JSON.stringify(r)}`);
    assert(r.ok && r.lojaId === LOJA_A1 && r.accessToken === "<access-A1>", "resolveu loja/token errados");
  });

  t("C. 2 lojas e nenhum lojaId -> LOJA_NAO_DEFINIDA, sem escolher sozinho", async () => {
    reset();
    const r = await M.resolverContaML(UID_A);
    assert(!r.ok && r.motivo === "LOJA_NAO_DEFINIDA", `esperado LOJA_NAO_DEFINIDA, veio ${JSON.stringify(r)}`);
    assert(!r.ok && r.motivo === "LOJA_NAO_DEFINIDA" && r.lojas.length === 2, "deveria listar as 2 lojas");
    assert(!MARCADORES_DE_TOKEN.test(JSON.stringify(r)), "a lista de lojas carregou credencial");
  });

  t("D. lojaId da própria loja -> resolve exatamente aquela", async () => {
    reset();
    const r = await M.resolverContaML(UID_A, LOJA_A2);
    assert(r.ok && r.lojaId === LOJA_A2 && r.accessToken === "<access-A2>", `resolveu errado: ${JSON.stringify(r)}`);
  });

  secao("\n[2. propriedade — o que nunca pode resolver]");

  t("E. lojaId de OUTRO usuário -> nega, sem credencial alheia", async () => {
    reset();
    const r = await M.resolverContaML(UID_A, LOJA_B1);
    assert(!r.ok && r.motivo === "LOJA_INVALIDA", `VAZAMENTO: ${JSON.stringify(r)}`);
    assert(!MARCADORES_DE_TOKEN.test(JSON.stringify(r)), "recusa carregou credencial");
    assert(chamadasML.length === 0, "chamou o Mercado Livre por loja alheia");
  });

  t("E2. simétrico: B pedindo a loja de A -> nega", async () => {
    reset();
    const r = await M.resolverContaML(UID_B, LOJA_A1);
    assert(!r.ok && r.motivo === "LOJA_INVALIDA", `VAZAMENTO: ${JSON.stringify(r)}`);
  });

  t("F. lojaId inexistente -> nega", async () => {
    reset();
    const r = await M.resolverContaML(UID_A, LOJA_INEXISTENTE);
    assert(!r.ok && r.motivo === "LOJA_INVALIDA", `aceitou loja inexistente: ${JSON.stringify(r)}`);
  });

  t("G. loja do próprio usuário em outro marketplace -> nega", async () => {
    reset();
    const r = await M.resolverContaML(UID_A, LOJA_SHOPEE);
    assert(!r.ok && r.motivo === "LOJA_INVALIDA", `usou loja Shopee como ML: ${JSON.stringify(r)}`);
  });

  t("H. loja própria mas inativa -> nega", async () => {
    reset();
    const r = await M.resolverContaML(UID_A, LOJA_INATIVA);
    assert(!r.ok && r.motivo === "LOJA_INVALIDA", `usou loja inativa: ${JSON.stringify(r)}`);
  });

  t("H2. lojaId malformado -> nega SEM tocar no banco", async () => {
    for (const mau of ["nao-e-uuid", "1", "'; DROP TABLE lojas;--", LOJA_A1 + "x"]) {
      reset();
      const r = await M.resolverContaML(UID_A, mau);
      assert(!r.ok && r.motivo === "LOJA_INVALIDA", `id malformado aceito: ${mau}`);
      assert(consultas.length === 0, `id malformado chegou ao banco: ${mau}`);
    }
  });

  t("H3. userId vazio -> nega sem consultar o banco", async () => {
    reset();
    const r = await M.resolverContaML("", LOJA_A1);
    assert(!r.ok, "userId vazio foi aceito");
    assert(consultas.length === 0, "consultou o banco sem usuário");
  });

  t("Q. mesmo seller_id em usuários diferentes -> cada um resolve a SUA linha", async () => {
    reset();
    const rA = await M.resolverContaML(UID_A, LOJA_A1);
    const rB = await M.resolverContaML(UID_B, LOJA_B1);
    assert(rA.ok && rA.accessToken === "<access-A1>", "A resolveu a linha errada");
    assert(rB.ok && rB.accessToken === "<access-B1>", "B resolveu a linha errada");
    assert(linhas.find(l => l.id === LOJA_A1)!.seller_id === linhas.find(l => l.id === LOJA_B1)!.seller_id,
      "o cenário deixou de exercitar seller compartilhado");
  });

  secao("\n[3. contrato da consulta — o que o refactor não pode perder]");

  t("T1. TODA consulta de leitura a `lojas` carrega user_id, marketplace e ativo", async () => {
    reset();
    await M.resolverContaML(UID_A, LOJA_A1);
    await M.resolverContaML(UID_A);
    const leituras = consultas.filter(c => c.tabela === "lojas" && c.tipo === "select");
    assert(leituras.length > 0, "nenhuma leitura registrada");
    for (const c of leituras) {
      assert(c.filtros.user_id === UID_A, `🔴 leitura SEM filtro de dono: ${JSON.stringify(c.filtros)}`);
      assert(c.filtros.marketplace === "ML", `leitura sem filtro de marketplace: ${JSON.stringify(c.filtros)}`);
      assert(c.filtros.ativo === true, `leitura sem filtro de ativo: ${JSON.stringify(c.filtros)}`);
    }
  });

  t("T2. lojaId SOMA-SE aos filtros de dono, nunca os substitui", async () => {
    reset();
    await M.resolverContaML(UID_A, LOJA_A1);
    const leitura = consultas.find(c => c.tipo === "select")!;
    assert(leitura.filtros.id === LOJA_A1, "não filtrou pelo id indicado");
    assert(leitura.filtros.user_id === UID_A, "🔴 filtrou só por id — a falha de F0.c.4 voltou");
  });

  secao("\n[4. credencial e refresh]");

  t("I. access válido -> usa e NÃO chama o Mercado Livre", async () => {
    apenasUmaLojaA({});
    const r = await M.resolverContaML(UID_A, LOJA_A1);
    assert(r.ok && r.accessToken === "<access-A1>", "não usou o token válido");
    assert(chamadasML.length === 0, "renovou um token que ainda valia");
  });

  t("W. vencendo dentro da margem de 5 min -> renova mesmo assim", async () => {
    apenasUmaLojaA({ token_expires_at: daquiA(60_000) });
    respostaRefresh = { access_token: "<access-renovado>", expires_in: 21600 };
    const r = await M.resolverContaML(UID_A, LOJA_A1);
    assert(chamadasML.length === 1, `não renovou dentro da margem (${chamadasML.length} chamadas)`);
    assert(r.ok && r.accessToken === "<access-renovado>", "não usou o token novo");
  });

  t("X. sem token_expires_at -> tratado como expirado (não confia no desconhecido)", async () => {
    apenasUmaLojaA({ token_expires_at: null });
    respostaRefresh = { access_token: "<access-renovado>" };
    const r = await M.resolverContaML(UID_A, LOJA_A1);
    assert(chamadasML.length === 1, `usou token de validade desconhecida sem renovar (${chamadasML.length})`);
    assert(r.ok, "deveria resolver após renovar");
  });

  t("J. access expirado + refresh válido -> renova server-side", async () => {
    apenasUmaLojaA({ token_expires_at: daquiA(-HORA) });
    respostaRefresh = { access_token: "<access-renovado>", expires_in: 21600 };
    const r = await M.resolverContaML(UID_A, LOJA_A1);
    assert(chamadasML.length === 1, `esperava 1 chamada ao ML, houve ${chamadasML.length}`);
    assert(chamadasML[0].includes("/oauth/token"), "chamou endpoint errado do ML");
    assert(r.ok && r.accessToken === "<access-renovado>", `não devolveu o token novo: ${JSON.stringify(r)}`);
  });

  t("K. o access_token novo é PERSISTIDO", async () => {
    apenasUmaLojaA({ token_expires_at: daquiA(-HORA) });
    respostaRefresh = { access_token: "<access-renovado>", expires_in: 21600 };
    await M.resolverContaML(UID_A, LOJA_A1);
    const linha = linhas.find(l => l.id === LOJA_A1)!;
    assert(linha.access_token === "<access-renovado>", "não gravou o access_token novo");
    assert(new Date(linha.token_expires_at!).getTime() > Date.now(), "não gravou a nova expiração");
  });

  t("L. o refresh_token novo é persistido QUANDO o ML devolve um", async () => {
    apenasUmaLojaA({ token_expires_at: daquiA(-HORA) });
    respostaRefresh = { access_token: "<access-renovado>", refresh_token: "<refresh-rotacionado>" };
    await M.resolverContaML(UID_A, LOJA_A1);
    assert(linhas.find(l => l.id === LOJA_A1)!.refresh_token === "<refresh-rotacionado>",
      "não gravou o refresh_token rotacionado");
  });

  t("L2. sem refresh_token novo, o anterior é mantido (nunca apagado)", async () => {
    apenasUmaLojaA({ token_expires_at: daquiA(-HORA) });
    respostaRefresh = { access_token: "<access-renovado>" };
    await M.resolverContaML(UID_A, LOJA_A1);
    assert(linhas.find(l => l.id === LOJA_A1)!.refresh_token === "<refresh-A1>",
      "perdeu o refresh_token anterior");
  });

  t("M. refresh recusado pelo ML -> PRECISA_RECONECTAR, sem apagar credencial", async () => {
    apenasUmaLojaA({ token_expires_at: daquiA(-HORA) });
    respostaRefresh = null;
    const r = await M.resolverContaML(UID_A, LOJA_A1);
    assert(!r.ok && r.motivo === "PRECISA_RECONECTAR", `esperado PRECISA_RECONECTAR: ${JSON.stringify(r)}`);
    const linha = linhas.find(l => l.id === LOJA_A1)!;
    assert(linha.refresh_token === "<refresh-A1>" && linha.access_token === "<access-A1>",
      "apagou/alterou credencial ao falhar o refresh");
  });

  t("N. access expirado e SEM refresh_token -> PRECISA_RECONECTAR, sem chamar o ML", async () => {
    apenasUmaLojaA({ token_expires_at: daquiA(-HORA), refresh_token: null });
    const r = await M.resolverContaML(UID_A, LOJA_A1);
    assert(!r.ok && r.motivo === "PRECISA_RECONECTAR", `esperado PRECISA_RECONECTAR: ${JSON.stringify(r)}`);
    assert(chamadasML.length === 0, `tentou renovar sem refresh_token (${chamadasML.length} chamadas)`);
  });

  t("N2. PRECISA_RECONECTAR identifica a loja, sem credencial", async () => {
    apenasUmaLojaA({ token_expires_at: daquiA(-HORA), refresh_token: null });
    const r = await M.resolverContaML(UID_A, LOJA_A1);
    assert(!r.ok && r.motivo === "PRECISA_RECONECTAR" && r.loja.id === LOJA_A1, "não identificou a loja");
    assert(!MARCADORES_DE_TOKEN.test(JSON.stringify(r)), "vazou credencial no PRECISA_RECONECTAR");
  });

  secao("\n[5. concorrência de refresh]");

  t("U. duas resoluções simultâneas da MESMA loja -> UMA chamada ao ML", async () => {
    apenasUmaLojaA({ token_expires_at: daquiA(-HORA) });
    respostaRefresh = { access_token: "<access-renovado>", refresh_token: "<refresh-rotacionado>" };
    segurarRefresh = () => {};
    const p1 = M.resolverContaML(UID_A, LOJA_A1);
    const p2 = M.resolverContaML(UID_A, LOJA_A1);
    await new Promise(r => setImmediate(r));
    segurarRefresh!();          // libera o refresh represado
    segurarRefresh = null;
    const [r1, r2] = await Promise.all([p1, p2]);
    assert(chamadasML.length === 1, `coalescência falhou: ${chamadasML.length} chamadas ao ML`);
    assert(r1.ok && r2.ok, "alguma das duas ficou sem credencial");
    assert(r1.ok && r2.ok && r1.accessToken === r2.accessToken, "as duas receberam tokens diferentes");
  });

  t("V. escrita perdida (refresh_token já rotacionado por outro) -> releitura recupera", async () => {
    // Simula o perdedor da corrida: quando ele vai gravar, a linha já tem
    // outro refresh_token, então o compare-and-swap não casa. O resolvedor
    // precisa reler e usar o que o vencedor deixou — não mandar reconectar.
    apenasUmaLojaA({ token_expires_at: daquiA(-HORA) });
    respostaRefresh = { access_token: "<access-do-perdedor>", refresh_token: "<refresh-do-perdedor>" };
    segurarRefresh = () => {};
    const p = M.resolverContaML(UID_A, LOJA_A1);
    await new Promise(r => setImmediate(r));
    // O "vencedor" grava enquanto o refresh do perdedor está em voo.
    Object.assign(linhas.find(l => l.id === LOJA_A1)!, {
      access_token: "<access-do-vencedor>",
      refresh_token: "<refresh-do-vencedor>",
      token_expires_at: daquiA(6 * HORA),
    });
    segurarRefresh!();
    segurarRefresh = null;
    const r = await p;
    assert(r.ok, `perdeu a corrida e declarou desconexão: ${JSON.stringify(r)}`);
    assert(r.ok && r.accessToken === "<access-do-vencedor>", "usou o token do perdedor");
    assert(linhas.find(l => l.id === LOJA_A1)!.access_token === "<access-do-vencedor>",
      "o perdedor sobrescreveu a credencial do vencedor");
  });

  secao("\n[6. contrato HTTP de GET /api/ml/conexao]");

  t("P. sem cookie de sessão -> 401 e nenhuma chamada ao ML", async () => {
    reset();
    const res = await rotaGET(req({}));
    assert(res.status === 401, `esperado 401, veio ${res.status}`);
    assert(chamadasML.length === 0, "chamou o ML sem sessão");
    assert(consultas.length === 0, "consultou o banco sem sessão");
  });

  t("P2. cookie de sessão forjado (uid cru) -> 401", async () => {
    reset();
    const res = await rotaGET(req({ cds_session: UID_A }));
    assert(res.status === 401, `sessão forjada aceita: ${res.status}`);
    assert(consultas.length === 0, "consultou o banco com sessão forjada");
  });

  t("R. cookie loja_ativa_id apontando para loja alheia -> nenhuma credencial alheia", async () => {
    reset();
    const res = await rotaGET(req({ cds_session: tokenA, loja_ativa_id: LOJA_B1 }));
    const corpo = await res.json();
    assert(res.status === 200, `esperado 200, veio ${res.status}`);
    assert(corpo.conectado === false && corpo.motivo === "LOJA_INVALIDA",
      `esperado recusa, veio ${JSON.stringify(corpo)}`);
    assert(!MARCADORES_DE_TOKEN.test(JSON.stringify(corpo)), "🔴 credencial alheia na resposta");
    assert(chamadasML.length === 0, "chamou o ML pela loja alheia");
  });

  t("R2. sem fallback: loja alheia NÃO cai para a loja do próprio usuário", async () => {
    reset();
    const res = await rotaGET(req({ cds_session: tokenB, loja_ativa_id: LOJA_A1 }));
    const corpo = await res.json();
    assert(corpo.conectado === false, "caiu em fallback para outra loja");
    assert(corpo.loja === undefined, `identificou alguma loja: ${JSON.stringify(corpo)}`);
  });

  t("O. NENHUM ramo da resposta HTTP contém token", async () => {
    const cenarios: Array<[string, Record<string, string>, () => void]> = [
      ["conectado",          { cds_session: tokenA, loja_ativa_id: LOJA_A1 }, () => apenasUmaLojaA({})],
      ["sem loja",           { cds_session: tokenSemLoja },                   () => reset()],
      ["loja não definida",  { cds_session: tokenA },                         () => reset()],
      ["loja inválida",      { cds_session: tokenA, loja_ativa_id: LOJA_B1 }, () => reset()],
      ["precisa reconectar", { cds_session: tokenA, loja_ativa_id: LOJA_A1 },
        () => apenasUmaLojaA({ token_expires_at: daquiA(-HORA), refresh_token: null })],
      ["após renovar",       { cds_session: tokenA, loja_ativa_id: LOJA_A1 },
        () => { apenasUmaLojaA({ token_expires_at: daquiA(-HORA) }); respostaRefresh = { access_token: "<access-renovado>" }; }],
    ];
    for (const [nome, cookies, preparar] of cenarios) {
      preparar();
      const res = await rotaGET(req(cookies));
      const texto = await res.text();
      assert(!MARCADORES_DE_TOKEN.test(texto), `🔴 token na resposta do cenário "${nome}": ${texto}`);
      assert(!/set-cookie/i.test([...res.headers.keys()].join(",")),
        `o cenário "${nome}" emitiu Set-Cookie — esta rota não escreve cookie`);
    }
  });

  t("O2. o resolvedor devolve accessToken; a projeção HTTP não o carrega", async () => {
    apenasUmaLojaA({});
    const interno = await M.resolverContaML(UID_A, LOJA_A1);
    assert(interno.ok && interno.accessToken === "<access-A1>", "o uso interno perdeu o token");
    const publico = M.montarRespostaConexao(interno);
    assert(!MARCADORES_DE_TOKEN.test(JSON.stringify(publico)), "a projeção vazou credencial");
    assert(!("accessToken" in publico), "campo accessToken presente na resposta");
  });

  t("O3. campo novo no resolvedor NÃO aparece sozinho na resposta", async () => {
    // Prova que a projeção é escrita campo a campo e não por espalhamento.
    const comCampoExtra = {
      ok: true, lojaId: LOJA_A1, accessToken: "<access-A1>", sellerId: "x", nickname: "LojaA1",
      campoNovoQualquer: "<refresh-vazado>",
    } as any;
    const publico = M.montarRespostaConexao(comCampoExtra);
    assert(!("campoNovoQualquer" in publico), "a projeção copia campos desconhecidos — espalhamento");
    assert(!MARCADORES_DE_TOKEN.test(JSON.stringify(publico)), "vazou pelo campo extra");
  });

  t("estado: LOJA_NAO_DEFINIDA não é desconexão", async () => {
    reset();
    const res = await rotaGET(req({ cds_session: tokenA }));
    const corpo = await res.json();
    assert(corpo.conectado === false && corpo.precisaReconectar === false && corpo.motivo === "LOJA_NAO_DEFINIDA",
      `estado errado: ${JSON.stringify(corpo)}`);
    assert(Array.isArray(corpo.lojas) && corpo.lojas.length === 2, "não ofereceu as lojas para escolha");
  });

  t("estado: conectado traz a loja, sem seller_id", async () => {
    apenasUmaLojaA({});
    const res = await rotaGET(req({ cds_session: tokenA, loja_ativa_id: LOJA_A1 }));
    const corpo = await res.json();
    assert(corpo.conectado === true && corpo.precisaReconectar === false, `estado errado: ${JSON.stringify(corpo)}`);
    assert(corpo.loja.id === LOJA_A1 && corpo.loja.marketplace === "ML", "loja mal identificada");
    assert(!("seller_id" in corpo.loja) && !("sellerId" in corpo.loja), "expôs seller_id");
  });

  t("Y. falha de banco -> 503, nunca 200 com `conectado: false`", async () => {
    reset();
    erroDeBanco = { message: "relation \"lojas\" does not exist" };
    const res = await rotaGET(req({ cds_session: tokenA, loja_ativa_id: LOJA_A1 }));
    const corpo = await res.json();
    assert(res.status === 503, `esperado 503, veio ${res.status}`);
    assert(corpo.conectado === undefined, "infraestrutura quebrada respondeu como estado de conexão");
    assert(!/relation|lojas|does not exist/i.test(JSON.stringify(corpo)),
      `detalhe interno do banco vazou: ${JSON.stringify(corpo)}`);
    erroDeBanco = null;
  });

  await fila;
  console.log(`\n=== RESULTADO: ${ok} passaram, ${falhou} falharam ===\n`);
  if (falhou > 0) process.exit(1);
}

void principal();
