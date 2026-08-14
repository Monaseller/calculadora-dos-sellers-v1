/**
 * Cutover das 4 rotas ML de Meus Produtos — F0.c.5.
 *
 * ── A inconsistência que estas suítes fecham ────────────────────────
 * Depois da fase C, a tela pergunta ao SERVIDOR se há conexão. Mas as
 * rotas que as ações da tela chamam ainda resolviam credencial pelo
 * cookie `ml_access_token`, de 6 horas. Resultado possível: a tela diz
 * CONECTADO e toda ação falha — pior de diagnosticar que o problema
 * original, porque não há nada na interface indicando a causa.
 *
 * ── Como estes testes provam ────────────────────────────────────────
 * Não pelo texto da resposta, e sim pelo **header `Authorization` que
 * cada rota efetivamente envia ao Mercado Livre**. O duplo de `fetch`
 * registra toda chamada; os testes exigem que o token usado seja o da
 * loja certa, resolvido no banco. Uma rota que voltasse a preferir o
 * cookie quebraria aqui mesmo continuando a responder 200.
 *
 * Sem rede, sem banco, sem credencial real: todo valor é um marcador em
 * `<colchetes>`. Nada publica, importa de verdade, sincroniza ou executa
 * OAuth.
 *
 * Uso: npx tsx scripts/testar-cutover-rotas-ml.ts
 */
import Module from "node:module";

let ok = 0, falhou = 0;
let fila: Promise<void> = Promise.resolve();

/**
 * O placar sai pelo `console.log` ORIGINAL. Durante a execução, o
 * `console` global é desviado para um coletor (ver `principal`), porque as
 * rotas reais são falantes — `/api/anuncio` sozinha imprime uma dúzia de
 * linhas por chamada. Nada se perde: é justamente esse coletor que o
 * teste J2 inspeciona para provar que credencial nenhuma é registrada.
 */
const imprimir = console.log.bind(console);

function t(nome: string, fn: () => void | Promise<void>) {
  fila = fila.then(async () => {
    try { await fn(); ok++; imprimir(`  PASS  ${nome}`); }
    catch (e: any) { falhou++; imprimir(`  FALHA ${nome} -> ${e?.message ?? e}`); }
  });
}
function secao(titulo: string) { fila = fila.then(() => { imprimir(titulo); }); }
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder-de-teste.invalid";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "chave-de-teste-invalida";
process.env.ML_CLIENT_ID ??= "ficticio";
process.env.ML_CLIENT_SECRET ??= "ficticio";
process.env.SESSION_SECRET ??= "segredo-de-teste-com-mais-de-32-bytes-000000";

const UID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UID_OUTRO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** Duas lojas ML do MESMO usuário — o cenário cross-store. */
const LOJA_A = "11111111-1111-4111-8111-111111111111";
const LOJA_B = "22222222-2222-4222-8222-222222222222";
/** Loja de outro dono. */
const LOJA_ALHEIA = "33333333-3333-4333-8333-333333333333";
const LOJA_INEXISTENTE = "99999999-9999-4999-8999-999999999999";

const TOKEN_A = "<access-da-loja-A>";
const TOKEN_B = "<access-da-loja-B>";
const TOKEN_ALHEIO = "<access-da-loja-alheia>";
const TOKEN_RENOVADO = "<access-renovado-pelo-servidor>";

const REFRESH_ANTIGO = "<refresh-antigo-que-ficou-no-navegador>";
const REFRESH_NOVO = "<refresh-rotacionado-no-banco>";

const daquiA = (ms: number) => new Date(Date.now() + ms).toISOString();
const HORA = 3600_000;

interface Loja {
  id: string; user_id: string | null; marketplace: string; ativo: boolean;
  nickname: string | null; seller_id: string | null;
  access_token: string | null; refresh_token: string | null; token_expires_at: string | null;
  created_at: string;
}

let lojas: Loja[] = [];
let anuncios: any[] = [];

function semear() {
  lojas = [
    { id: LOJA_A, user_id: UID_A, marketplace: "ML", ativo: true, nickname: "LojaA", seller_id: "<seller-A>",
      access_token: TOKEN_A, refresh_token: "<refresh-A>", token_expires_at: daquiA(HORA), created_at: "2026-01-01" },
    { id: LOJA_B, user_id: UID_A, marketplace: "ML", ativo: true, nickname: "LojaB", seller_id: "<seller-B>",
      access_token: TOKEN_B, refresh_token: "<refresh-B>", token_expires_at: daquiA(HORA), created_at: "2026-02-01" },
    { id: LOJA_ALHEIA, user_id: UID_OUTRO, marketplace: "ML", ativo: true, nickname: "Alheia", seller_id: "<seller-X>",
      access_token: TOKEN_ALHEIO, refresh_token: "<refresh-X>", token_expires_at: daquiA(HORA), created_at: "2026-01-05" },
  ];
  // Um anúncio para `sync-precos` chegar ao fim da rota (e portanto à
  // emissão de cookie de compatibilidade).
  anuncios = [{
    id: "an-1", user_id: UID_A, marketplace: "ML", ativo: true, ml_item_id: "MLB111", nome: "Produto",
    preco_anuncio: 100, sku: null, custo_produto: 10, imposto: 0.1, custo_frete: 0,
  }];
}

/** Deixa o usuário com UMA loja ML, no estado pedido. */
function apenasLojaA(estado: Partial<Loja> = {}) {
  reiniciar();
  lojas = lojas.filter(l => l.id !== LOJA_B);
  Object.assign(lojas.find(l => l.id === LOJA_A)!, estado);
}

// ── Duplo do banco ───────────────────────────────────────────────────
function casa(linha: any, filtros: Record<string, unknown>) {
  return Object.entries(filtros).every(([c, v]) => linha[c] === v);
}

function clienteFalso() {
  const criarCadeia = (tabela: string) => {
    const filtros: Record<string, unknown> = {};
    let tipo: "select" | "update" = "select";
    let patch: Record<string, unknown> = {};

    const linhasDe = () => (tabela === "lojas" ? lojas : anuncios) as any[];

    const executar = () => {
      const alvo = linhasDe().filter(l => casa(l, filtros));
      if (tipo === "select") return { data: alvo, error: null };
      for (const l of alvo) Object.assign(l, patch);
      return { data: alvo.map(l => ({ id: l.id })), error: null };
    };

    const cadeia: any = {
      select: () => cadeia,
      update: (p: Record<string, unknown>) => { tipo = "update"; patch = p; return cadeia; },
      upsert: () => cadeia,
      insert: () => cadeia,
      eq: (c: string, v: unknown) => { filtros[c] = v; return cadeia; },
      // Filtros que este duplo não precisa interpretar para o que se testa.
      not: () => cadeia,
      or: () => cadeia,
      in: () => cadeia,
      order: () => cadeia,
      limit: () => cadeia,
      single: async () => { const r = executar(); return { data: (r.data as any[])[0] ?? null, error: null }; },
      maybeSingle: async () => { const r = executar(); return { data: (r.data as any[])[0] ?? null, error: null }; },
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

// ── Duplo do Mercado Livre ───────────────────────────────────────────
interface ChamadaML { url: string; autorizacao: string | null; refreshEnviado: string | null }
let chamadas: ChamadaML[] = [];
/** Resposta do refresh; `null` = o ML recusa. */
let respostaRefresh: { access_token: string; refresh_token?: string } | null = null;
/**
 * Ids devolvidos por `/items/search`. Vazio por padrão: `importar-anuncios`
 * tem retorno antecipado quando a conta não tem anúncios ativos (e, aí,
 * nem chega a emitir o cookie de compatibilidade — comportamento que já
 * existia antes do cutover).
 */
let resultadosBusca: string[] = [];

function cabecalho(init: any, nome: string): string | null {
  const h = init?.headers;
  if (!h) return null;
  if (typeof h.get === "function") return h.get(nome);
  for (const [k, v] of Object.entries(h as Record<string, string>)) {
    if (k.toLowerCase() === nome.toLowerCase()) return v;
  }
  return null;
}

globalThis.fetch = (async (url: any, init?: any) => {
  const alvo = String(url);
  const auth = cabecalho(init, "Authorization");
  let refreshEnviado: string | null = null;

  let grant: string | null = null;
  if (alvo.includes("/oauth/token")) {
    const corpo = new URLSearchParams(String(init?.body ?? ""));
    refreshEnviado = corpo.get("refresh_token");
    grant = corpo.get("grant_type");
  }
  chamadas.push({ url: alvo, autorizacao: auth, refreshEnviado });

  if (!alvo.includes("mercadolibre.com") && !alvo.includes("mercadolivre.com")) {
    throw new Error(`teste tentou acessar a rede: ${alvo}`);
  }

  if (alvo.includes("/oauth/token")) {
    // `client_credentials` é o APP TOKEN de `/api/anuncio` — mecanismo
    // próprio da rota, sem relação com a credencial do usuário. Confundir
    // os dois grants faria um marcador de usuário aparecer no cache do app
    // token e contaminar os testes seguintes.
    if (grant === "client_credentials") {
      return { ok: true, status: 200, json: async () => ({ access_token: "<app-token>", expires_in: 21600 }) } as any;
    }
    if (!respostaRefresh) return { ok: false, status: 400, json: async () => ({ error: "invalid_grant" }) } as any;
    const c = respostaRefresh;
    return { ok: true, status: 200, json: async () => ({ ...c, expires_in: 21600 }) } as any;
  }
  if (alvo.includes("/users/me")) {
    return { ok: true, status: 200, json: async () => ({ id: 12345 }) } as any;
  }
  if (alvo.includes("/items/search")) {
    return { ok: true, status: 200, json: async () => ({ results: resultadosBusca }) } as any;
  }
  // Qualquer outra chamada falha: os testes olham o Authorization enviado,
  // não o sucesso da operação no marketplace.
  return { ok: false, status: 404, text: async () => "", json: async () => ({}) } as any;
}) as any;

// ── Coletor de log ───────────────────────────────────────────────────
// Ligado durante toda a execução (ver `principal`): silencia a conversa
// das rotas e, de quebra, torna o conteúdo inspecionável pelo teste J2.
let logs: string[] = [];
function coletar(...args: any[]) { logs.push(args.map(a => String(a)).join(" ")); }
async function capturarLogs<T>(fn: () => Promise<T>): Promise<T> {
  logs = [];
  return fn();
}

function reiniciar() {
  semear();
  chamadas = [];
  respostaRefresh = null;
  resultadosBusca = [];
  logs = [];
}

type Handler = (req: Request) => Promise<Response>;
const rotas: Record<string, Handler> = {};
let tokenSessaoA = "";
let tokenSessaoOutro = "";

/** Requisição para a rota, com os cookies que o cliente controla. */
function req(caminho: string, cookies: Record<string, string>, metodo = "POST") {
  const valor = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  return new Request(`https://exemplo.test${caminho}`, {
    method: metodo,
    ...(valor ? { headers: { cookie: valor } } : {}),
  });
}

/**
 * Id direto — a mesma forma que `FormAnuncio` envia ao reabrir um anúncio
 * já salvo (`inicial.ml_item_id`). É entrada de produção, não sintética.
 */
const LINK_ML = "MLB111111111";

/** `Set-Cookie` pode vir por `getSetCookie()` ou pelo header simples. */
function lerSetCookie(res: Response): string {
  const varios = (res.headers as any).getSetCookie?.();
  if (Array.isArray(varios) && varios.length) return varios.join("\n");
  return res.headers.get("set-cookie") ?? "";
}
function reqAnuncio(cookies: Record<string, string>) {
  const valor = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  return new Request(`https://exemplo.test/api/anuncio?link=${encodeURIComponent(LINK_ML)}`,
    valor ? { headers: { cookie: valor } } : undefined);
}

/** As quatro rotas do cutover, com a requisição de cada uma. */
const AS_QUATRO: Array<[string, (cookies: Record<string, string>) => Promise<Response>]> = [
  ["/api/ml/sync-skus",         c => rotas["sync-skus"](req("/api/ml/sync-skus", c))],
  ["/api/ml/importar-anuncios", c => rotas["importar"](req("/api/ml/importar-anuncios", c))],
  ["/api/ml/sync-precos",       c => rotas["sync-precos"](req("/api/ml/sync-precos", c))],
  ["/api/anuncio",              c => rotas["anuncio"](reqAnuncio(c))],
];

/** Marcador do app token (`client_credentials`), que não é de usuário. */
const APP_TOKEN = "<app-token>";

/** Tokens que apareceram em algum header Authorization. */
function tokensUsados(): string[] {
  return chamadas
    .map(c => c.autorizacao)
    .filter((a): a is string => !!a)
    .map(a => a.replace(/^Bearer\s+/i, ""));
}

/**
 * Só as credenciais DE USUÁRIO.
 *
 * `/api/anuncio` também usa um app token de `client_credentials` para
 * resolver catálogo — mecanismo próprio da rota, anterior a este cutover,
 * que não representa conta de ninguém (o próprio código anota que "user
 * token e sem token causam 403" naquele endpoint). Misturar os dois faria
 * os testes de identidade de loja falharem por um motivo que nada tem a
 * ver com o que eles verificam.
 */
function tokensDeUsuario(): string[] {
  return tokensUsados().filter(x => x !== APP_TOKEN);
}

async function principal() {
  console.log = coletar;
  console.error = coletar;

  ({ POST: rotas["sync-skus"] } = await import("../app/api/ml/sync-skus/route") as any);
  ({ POST: rotas["importar"] } = await import("../app/api/ml/importar-anuncios/route") as any);
  ({ POST: rotas["sync-precos"] } = await import("../app/api/ml/sync-precos/route") as any);
  ({ GET: rotas["anuncio"] } = await import("../app/api/anuncio/route") as any);

  const { emitirTokenSessao } = await import("../lib/autenticacao");
  tokenSessaoA = (await emitirTokenSessao(UID_A)).token;
  tokenSessaoOutro = (await emitirTokenSessao(UID_OUTRO)).token;

  // ══════════════════════════════════════════════════════════════════
  secao("\n[A. sem cookie ML + banco válido — o bug original]");

  for (const [nome, chamar] of AS_QUATRO) {
    t(`A. ${nome} usa a credencial do BANCO sem nenhum cookie ML`, async () => {
      apenasLojaA();
      await chamar({ cds_session: tokenSessaoA });   // sem ml_access_token, sem loja_ativa_id
      const usados = tokensDeUsuario();
      assert(usados.length > 0, "não chegou a falar com o Mercado Livre — resolveu credencial nenhuma");
      assert(usados.every(x => x === TOKEN_A), `usou token inesperado: ${usados.join(", ")}`);
    });
  }

  // ══════════════════════════════════════════════════════════════════
  secao("\n[B. cross-store: cookie da loja A + loja_ativa_id = B]");

  for (const [nome, chamar] of AS_QUATRO) {
    t(`B. ${nome} opera B, nunca A`, async () => {
      reiniciar();
      await chamar({ cds_session: tokenSessaoA, loja_ativa_id: LOJA_B, ml_access_token: TOKEN_A });
      const usados = tokensDeUsuario();
      assert(usados.length > 0, "não falou com o ML");
      assert(!usados.includes(TOKEN_A), `🔴 operou a loja A: ${usados.join(", ")}`);
      assert(usados.every(x => x === TOKEN_B), `não operou B: ${usados.join(", ")}`);
    });
  }

  t("B2. o cookie ml_access_token não é usado nem quando a loja bate", async () => {
    // Cookie com um valor DIFERENTE do banco, apontando para a mesma loja:
    // se a rota preferisse o cookie, este marcador apareceria.
    reiniciar();
    for (const [nome, chamar] of AS_QUATRO) {
      chamadas = [];
      await chamar({ cds_session: tokenSessaoA, loja_ativa_id: LOJA_A, ml_access_token: "<cookie-obsoleto>" });
      assert(!tokensDeUsuario().includes("<cookie-obsoleto>"), `🔴 ${nome} usou o cookie como credencial`);
    }
  });

  // ══════════════════════════════════════════════════════════════════
  secao("\n[C/D. seleção de loja]");

  for (const [nome, chamar] of AS_QUATRO) {
    t(`C. ${nome}: 1 loja e sem loja_ativa_id -> usa a única`, async () => {
      apenasLojaA();
      await chamar({ cds_session: tokenSessaoA });
      assert(tokensDeUsuario().every(x => x === TOKEN_A) && tokensDeUsuario().length > 0, "não usou a única loja");
    });
  }

  for (const [nome, chamar] of AS_QUATRO) {
    t(`D. ${nome}: 2 lojas e sem loja_ativa_id -> não escolhe sozinha`, async () => {
      reiniciar();
      const res = await chamar({ cds_session: tokenSessaoA });
      assert(tokensDeUsuario().length === 0, `🔴 escolheu uma loja arbitrariamente: ${tokensDeUsuario().join(", ")}`);
      if (nome !== "/api/anuncio") {
        const corpo = await res.json();
        assert(corpo.erro === true && /selecione a loja/i.test(corpo.mensagem ?? ""),
          `mensagem não orienta a escolher: ${JSON.stringify(corpo)}`);
      }
    });
  }

  // ══════════════════════════════════════════════════════════════════
  secao("\n[E/F. loja alheia e loja inválida]");

  for (const [nome, chamar] of AS_QUATRO) {
    t(`E. ${nome}: loja_ativa_id de OUTRO usuário -> nega, sem tocar no ML`, async () => {
      reiniciar();
      await chamar({ cds_session: tokenSessaoA, loja_ativa_id: LOJA_ALHEIA });
      assert(tokensDeUsuario().length === 0, `🔴 usou credencial alheia: ${tokensDeUsuario().join(", ")}`);
      assert(!tokensDeUsuario().includes(TOKEN_ALHEIO), "🔴 vazou o token da loja alheia");
    });
  }

  for (const [nome, chamar] of AS_QUATRO) {
    t(`F. ${nome}: loja_ativa_id inexistente ou malformado -> nega, sem fallback`, async () => {
      for (const mau of [LOJA_INEXISTENTE, "nao-e-uuid", "'; DROP TABLE lojas;--"]) {
        reiniciar();
        await chamar({ cds_session: tokenSessaoA, loja_ativa_id: mau });
        assert(tokensDeUsuario().length === 0,
          `🔴 caiu em fallback para outra loja com "${mau}": ${tokensDeUsuario().join(", ")}`);
      }
    });
  }

  // ══════════════════════════════════════════════════════════════════
  secao("\n[G. refresh já rotacionado por /api/ml/conexao]");

  for (const [nome, chamar] of AS_QUATRO) {
    t(`G. ${nome} renova pelo refresh do BANCO, nunca pelo do navegador`, async () => {
      // O estado depois de a tela ter carregado: /api/ml/conexao renovou,
      // gravou REFRESH_NOVO no banco e não tocou nos cookies. O navegador
      // ainda carrega REFRESH_ANTIGO, que o ML já considera gasto.
      apenasLojaA({ token_expires_at: daquiA(-HORA), refresh_token: REFRESH_NOVO });
      respostaRefresh = { access_token: TOKEN_RENOVADO, refresh_token: "<refresh-mais-novo-ainda>" };

      await chamar({
        cds_session: tokenSessaoA,
        ml_refresh_token: REFRESH_ANTIGO,
        ml_access_token: "<cookie-vencido>",
      });

      const refreshsEnviados = chamadas.map(c => c.refreshEnviado).filter(Boolean);
      assert(!refreshsEnviados.includes(REFRESH_ANTIGO),
        "🔴 tentou renovar com o refresh_token velho do navegador");
      assert(refreshsEnviados.includes(REFRESH_NOVO),
        `não renovou pelo refresh do banco: ${refreshsEnviados.join(", ")}`);
      assert(tokensDeUsuario().every(x => x === TOKEN_RENOVADO),
        `não usou o token recém-renovado: ${tokensDeUsuario().join(", ")}`);
      assert(lojas.find(l => l.id === LOJA_A)!.access_token === TOKEN_RENOVADO,
        "não persistiu o token novo");
    });
  }

  // ══════════════════════════════════════════════════════════════════
  secao("\n[H/I. /api/anuncio e a sessão]");

  t("H. /api/anuncio SEM sessão -> 401 e nenhuma chamada ao ML", async () => {
    reiniciar();
    const res = await rotas["anuncio"](reqAnuncio({}));
    assert(res.status === 401, `esperado 401, veio ${res.status}`);
    assert(chamadas.length === 0, "falou com o Mercado Livre sem sessão");
  });

  t("H2. /api/anuncio com sessão forjada (uid cru) -> 401", async () => {
    reiniciar();
    const res = await rotas["anuncio"](reqAnuncio({ cds_session: UID_A }));
    assert(res.status === 401, `sessão forjada aceita: ${res.status}`);
    assert(chamadas.length === 0, "falou com o ML com sessão forjada");
  });

  t("H3. /api/anuncio não responde antes de autenticar, nem com link inválido", async () => {
    reiniciar();
    const res = await rotas["anuncio"](
      new Request("https://exemplo.test/api/anuncio?link=lixo-sem-id"));
    assert(res.status === 401, `respondeu ${res.status} sobre o link a um não-autenticado`);
  });

  t("I. /api/anuncio COM sessão usa a credencial do banco", async () => {
    apenasLojaA();
    const res = await rotas["anuncio"](reqAnuncio({ cds_session: tokenSessaoA }));
    assert(res.status !== 401, "sessão válida foi recusada");
    const usados = tokensDeUsuario();
    assert(usados.includes(TOKEN_A), `não usou o token do banco: ${usados.join(", ")}`);
  });

  t("I2. sem credencial no banco, /api/anuncio mantém o caminho público", async () => {
    // Comportamento preservado: sem conta ML utilizável a rota ainda tenta
    // o caminho público/scraping (e o app token de `client_credentials`,
    // que é mecanismo próprio da rota e não credencial de usuário). O que
    // não pode mais acontecer é isso ocorrer por cookie vencido HAVENDO
    // credencial no banco — é o que o teste A cobre.
    apenasLojaA({ access_token: null, refresh_token: null, token_expires_at: null });
    const res = await rotas["anuncio"](reqAnuncio({ cds_session: tokenSessaoA }));
    assert(res.status !== 401, "recusou a sessão válida");
    const deUsuario = tokensDeUsuario().filter(x => x.startsWith("<access-"));
    assert(deUsuario.length === 0, `usou credencial de usuário inexistente: ${deUsuario.join(", ")}`);
    assert(chamadas.length > 0, "não tentou sequer o caminho público");
  });

  // ══════════════════════════════════════════════════════════════════
  secao("\n[J. nenhuma credencial em resposta ou log]");

  const MARCADORES = /<access-|<refresh-|<cookie-|access_token|refresh_token|authorization|client_secret/i;

  t("J. nenhuma das quatro rotas devolve credencial no corpo", async () => {
    const combinacoes: Record<string, string>[] = [
      { cds_session: tokenSessaoA },
      { cds_session: tokenSessaoA, loja_ativa_id: LOJA_B, ml_access_token: TOKEN_A },
      { cds_session: tokenSessaoA, loja_ativa_id: LOJA_ALHEIA },
    ];
    for (const [nome, chamar] of AS_QUATRO) {
      for (const cookies of combinacoes) {
        reiniciar();
        const res = await chamar(cookies);
        const texto = await res.text();
        assert(!MARCADORES.test(texto), `🔴 credencial no corpo de ${nome}: ${texto.slice(0, 200)}`);
      }
    }
  });

  t("J2. nenhuma das quatro rotas imprime credencial no log", async () => {
    for (const [nome, chamar] of AS_QUATRO) {
      reiniciar();
      await capturarLogs(() => chamar({ cds_session: tokenSessaoA, loja_ativa_id: LOJA_A, ml_access_token: TOKEN_A }));
      const tudo = logs.join("\n");
      assert(!MARCADORES.test(tudo), `🔴 credencial no log de ${nome}: ${tudo.slice(0, 200)}`);
    }
  });

  // ══════════════════════════════════════════════════════════════════
  secao("\n[K. compatibilidade de cookie — decisão 2]");

  t("K. o Set-Cookie de compatibilidade carrega o token RESOLVIDO, não o antigo", async () => {
    apenasLojaA();
    resultadosBusca = ["MLB111"];   // sem anúncios a rota retorna antes do cookie
    const res = await rotas["importar"](req("/api/ml/importar-anuncios",
      { cds_session: tokenSessaoA, ml_access_token: "<cookie-obsoleto>" }));
    const setCookie = lerSetCookie(res);
    assert(setCookie.includes("ml_access_token"),
      `parou de emitir o cookie de compatibilidade — headers: ${[...res.headers.keys()].join(", ")}`);
    assert(!setCookie.includes("<cookie-obsoleto>"), "reemitiu o cookie velho");
  });

  t("K2. cookie já correto -> nenhum Set-Cookie desnecessário", async () => {
    apenasLojaA();
    resultadosBusca = ["MLB111"];
    const res = await rotas["importar"](req("/api/ml/importar-anuncios",
      { cds_session: tokenSessaoA, ml_access_token: TOKEN_A }));
    assert(!lerSetCookie(res).includes("ml_access_token"),
      "reescreveu credencial no navegador sem necessidade");
  });

  // ══════════════════════════════════════════════════════════════════
  secao("\n[L. o cookie deixou de ser fonte de credencial no código]");

  t("L. nenhuma das quatro rotas lê ml_access_token ou ml_refresh_token", async () => {
    const fs = await import("node:fs");
    // `emiteCookieCompat` distingue as duas rotas que, por decisão 2 do
    // cutover, AINDA emitem o cookie por compatibilidade — nelas uma única
    // menção é legítima (a comparação que evita Set-Cookie redundante).
    const arquivos: Array<{ caminho: string; emiteCookieCompat: boolean }> = [
      { caminho: "app/api/ml/sync-skus/route.ts",          emiteCookieCompat: false },
      { caminho: "app/api/anuncio/route.ts",               emiteCookieCompat: false },
      { caminho: "app/api/ml/importar-anuncios/route.ts",  emiteCookieCompat: true  },
      { caminho: "app/api/ml/sync-precos/route.ts",        emiteCookieCompat: true  },
    ];
    for (const { caminho, emiteCookieCompat } of arquivos) {
      const fonte = fs.readFileSync(caminho, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      assert(!/ml_refresh_token/.test(fonte), `🔴 ${caminho} lê o refresh do navegador`);
      assert(!/getMLToken/.test(fonte), `🔴 ${caminho} ainda resolve credencial por getMLToken`);
      assert(/resolverContaML/.test(fonte), `${caminho} não usa o resolvedor server-side`);

      const usos = (fonte.match(/ml_access_token/g) ?? []).length;
      if (emiteCookieCompat) {
        assert(usos <= 1, `🔴 ${caminho} menciona o cookie ${usos} vezes — mais que a comparação de compatibilidade`);
      } else {
        assert(usos === 0, `🔴 ${caminho} ainda lê o cookie de credencial`);
      }
    }
  });

  await fila;
  imprimir(`\n=== RESULTADO: ${ok} passaram, ${falhou} falharam ===\n`);
  if (falhou > 0) process.exit(1);
}

void principal();
