/**
 * Fluxo OAuth do Mercado Livre — PR #2b-4.
 *
 * ── O bypass que esta suíte fecha ───────────────────────────────────
 * As duas rotas do fluxo (`/api/auth/mercadolivre` e o callback) eram os
 * ÚLTIMOS lugares do repositório a montar `.from("lojas")` com o cliente
 * ANON — e o callback era o único `INSERT` anon que existia. Agora a
 * leitura e a escrita vivem na capability server-only.
 *
 * ── O que estes testes provam ───────────────────────────────────────
 * O EFEITO, não o texto. O duplo do Supabase registra cada projeção,
 * cada `.eq()` e cada payload de escrita; o duplo de `fetch` responde
 * pelo Mercado Livre sem rede. Uma regressão que perca o filtro de dono,
 * que grave `refresh_token: null` ou que redirecione como sucesso sem
 * gravar quebra aqui.
 *
 * `lib/estado-oauth.ts` é usado DE VERDADE — state e PKCE reais,
 * assinados e verificados. Não há duplo para eles de propósito: são a
 * parte que esta PR não pode alterar, e testá-los de mentira esconderia
 * exatamente a regressão que importa.
 *
 * Sem rede, sem banco, sem credencial real: todos os valores são
 * marcadores em `<colchetes>`.
 *
 * Uso: npx tsx scripts/testar-ml-callback.ts
 */
import "./_server-only-inerte";
import Module from "node:module";

let ok = 0, falhou = 0;
let fila: Promise<void> = Promise.resolve();
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
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "chave-de-teste-invalida";
process.env.SESSION_SECRET ??= "segredo-de-teste-com-mais-de-32-bytes-000000";
process.env.ML_CLIENT_ID ??= "<client-id>";
process.env.ML_CLIENT_SECRET ??= "<client-secret>";
process.env.ML_REDIRECT_URI ??= "https://exemplo.test/api/auth/mercadolivre/callback";

const UID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UID_OUTRO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const LOJA_A = "11111111-1111-4111-8111-111111111111";       // ML de A, seller S1
const LOJA_A_INATIVA = "33333333-3333-4333-8333-333333333333";
const LOJA_ALHEIA = "22222222-2222-4222-8222-222222222222";  // ML de OUTRO, seller S1
const LOJA_SHOPEE = "44444444-4444-4444-8444-444444444444";
const LOJA_DUP_1 = "55555555-5555-4555-8555-555555555555";
const LOJA_DUP_2 = "66666666-6666-4666-8666-666666666666";
const LOJA_INEXISTENTE = "99999999-9999-4999-8999-999999999999";

const SELLER_1 = "1111111111";
const SELLER_DUP = "2222222222";
const SELLER_NOVO = "7777777777";

interface Linha {
  id: string; user_id: string | null; marketplace: string; ativo: boolean;
  nome: string | null; nickname: string | null; seller_id: string | null;
  shop_id: string | null; partner_id: string | null; partner_key: string | null;
  access_token: string | null; refresh_token: string | null; token_expires_at: string | null;
}

let linhas: Linha[] = [];

function semear() {
  const base = {
    nome: "Loja", nickname: "apelido", shop_id: null, partner_id: null, partner_key: null,
    access_token: "<access-antigo>", refresh_token: "<refresh-antigo>",
    token_expires_at: "2020-01-01T00:00:00Z",
  };
  linhas = [
    { id: LOJA_A, user_id: UID_A, marketplace: "ML", ativo: true, seller_id: SELLER_1, ...base },
    { id: LOJA_A_INATIVA, user_id: UID_A, marketplace: "ML", ativo: false, seller_id: "3333333333", ...base },
    { id: LOJA_ALHEIA, user_id: UID_OUTRO, marketplace: "ML", ativo: true, seller_id: SELLER_1, ...base },
    { id: LOJA_SHOPEE, user_id: UID_A, marketplace: "Shopee", ativo: true, seller_id: SELLER_1, ...base,
      partner_key: "<partner-key>" },
    { id: LOJA_DUP_1, user_id: UID_A, marketplace: "ML", ativo: true, seller_id: SELLER_DUP, ...base },
    { id: LOJA_DUP_2, user_id: UID_A, marketplace: "ML", ativo: true, seller_id: SELLER_DUP, ...base },
  ];
}

interface Consulta {
  tabela: string; tipo: "select" | "update" | "insert";
  projecao: string; filtros: Record<string, unknown>; payload: Record<string, unknown>;
}
let consultas: Consulta[] = [];
let erroDeBanco: { message: string } | null = null;

const casa = (l: Linha, f: Record<string, unknown>) =>
  Object.entries(f).every(([c, v]) => (l as any)[c] === v);

function projetar(l: Linha, projecao: string): Record<string, unknown> {
  if (projecao.trim() === "*") return { ...l };
  const saida: Record<string, unknown> = {};
  for (const c of projecao.split(",").map(s => s.trim()).filter(Boolean)) saida[c] = (l as any)[c];
  return saida;
}

let proximoId = 0;

function clienteFalso() {
  const criarCadeia = (tabela: string) => {
    const filtros: Record<string, unknown> = {};
    let tipo: "select" | "update" | "insert" = "select";
    let projecao = "*";
    let payload: Record<string, unknown> = {};
    const executar = () => {
      consultas.push({ tabela, tipo, projecao, filtros: { ...filtros }, payload: { ...payload } });
      if (erroDeBanco) return { data: null, error: erroDeBanco };
      if (tipo === "insert") {
        const nova = { id: `novo-${++proximoId}`, ...payload } as any;
        linhas.push(nova);
        return { data: [projetar(nova, projecao)], error: null };
      }
      const alvo = linhas.filter(l => casa(l, filtros));
      if (tipo === "update") for (const l of alvo) Object.assign(l, payload);
      return { data: alvo.map(l => projetar(l, projecao)), error: null };
    };
    const cadeia: any = {
      select: (p?: string) => { projecao = p ?? "*"; return cadeia; },
      update: (p: Record<string, unknown>) => { tipo = "update"; payload = p; return cadeia; },
      insert: (p: Record<string, unknown>) => { tipo = "insert"; payload = p; return cadeia; },
      upsert: () => { throw new Error("🔴 usou upsert em `lojas`"); },
      delete: () => { throw new Error("🔴 usou delete em `lojas`"); },
      eq: (c: string, v: unknown) => { filtros[c] = v; return cadeia; },
      maybeSingle: async () => { const r = executar(); return { data: (r.data as any[])?.[0] ?? null, error: r.error }; },
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

// ── Duplo do Mercado Livre ──────────────────────────────────────────
// Nenhuma requisição sai da máquina. Qualquer URL não prevista lança —
// é assim que uma chamada de rede acidental aparece como falha.
let respostaToken: { ok: boolean; status: number; corpo: any } =
  { ok: true, status: 200, corpo: { access_token: "<access-novo>", refresh_token: "<refresh-novo>", expires_in: 21600 } };
let respostaMe: { ok: boolean; status: number; corpo: any } =
  { ok: true, status: 200, corpo: { id: SELLER_1, nickname: "LOJA-TESTE" } };
let chamadasToken = 0;

globalThis.fetch = (async (url: any, init?: any) => {
  const alvo = String(url);
  const responder = (r: { ok: boolean; status: number; corpo: any }) =>
    ({ ok: r.ok, status: r.status, json: async () => r.corpo }) as any;
  if (alvo.includes("/oauth/token")) {
    chamadasToken++;
    // O `code` é de uso único: a segunda troca do mesmo code falha.
    const corpo = String(init?.body ?? "");
    if (corpo.includes("code=USADO")) return responder({ ok: false, status: 400, corpo: { error: "invalid_grant" } });
    return responder(respostaToken);
  }
  if (alvo.includes("/users/me")) return responder(respostaMe);
  throw new Error(`teste tentou acessar a rede: ${alvo}`);
}) as any;

let logs: string[] = [];
const coletar = (...a: any[]) => { logs.push(a.map(x => String(x)).join(" ")); };

function reiniciar() {
  semear();
  consultas = [];
  erroDeBanco = null;
  logs = [];
  chamadasToken = 0;
  respostaToken = { ok: true, status: 200, corpo: { access_token: "<access-novo>", refresh_token: "<refresh-novo>", expires_in: 21600 } };
  respostaMe = { ok: true, status: 200, corpo: { id: SELLER_1, nickname: "LOJA-TESTE" } };
}

let inicioGET: (req: Request) => Promise<Response>;
let callbackGET: (req: Request) => Promise<Response>;
let tokenA = "";
let tokenOutro = "";
let assinarEstado: any, calcularCodeChallenge: any, gerarCodeVerifier: any, nomeCookiePkce: any, agoraEmSegundos: any;

const linha = (id: string) => linhas.find(l => l.id === id);
const escritas = () => consultas.filter(c => c.tipo === "update" || c.tipo === "insert");
const leituras = () => consultas.filter(c => c.tipo === "select");
const destino = (res: Response) => res.headers.get("location") ?? "";
const codigoErro = (res: Response) => new URL(destino(res), "https://exemplo.test").searchParams.get("ml_erro");

/** Monta uma tentativa completa: verifier + challenge + state assinado. */
async function tentativa(uid: string, dados: any) {
  const verifier = gerarCodeVerifier();
  const chal = await calcularCodeChallenge(verifier);
  const state = await assinarEstado(uid, { ...dados, chal }, {
    segredo: process.env.SESSION_SECRET!,
    agoraSegundos: agoraEmSegundos(),
  });
  return { verifier, chal, state };
}

function reqCallback(params: Record<string, string>, cookies: Record<string, string>) {
  const url = new URL("https://exemplo.test/api/auth/mercadolivre/callback");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  return new Request(url, { headers: cookie ? { cookie } : {} });
}

async function chamarCallback(uid: string, dados: any, extras: {
  code?: string | null; sessao?: string | null; semPkce?: boolean; pkceErrado?: boolean; state?: string | null;
} = {}) {
  const { verifier, chal, state } = await tentativa(uid, dados);
  const params: Record<string, string> = {};
  const code = extras.code === undefined ? "CODE-OK" : extras.code;
  if (code !== null) params.code = code;
  const st = extras.state === undefined ? state : extras.state;
  if (st !== null) params.state = st;

  const cookies: Record<string, string> = {};
  const sessao = extras.sessao === undefined ? tokenA : extras.sessao;
  if (sessao !== null) cookies.cds_session = sessao;
  if (!extras.semPkce) {
    cookies[nomeCookiePkce(chal)] = extras.pkceErrado ? gerarCodeVerifier() : verifier;
  }
  return { res: await callbackGET(reqCallback(params, cookies)), chal, state };
}

async function principal() {
  console.log = coletar;
  console.error = coletar;

  ({ GET: inicioGET } = await import("../app/api/auth/mercadolivre/route") as any);
  ({ GET: callbackGET } = await import("../app/api/auth/mercadolivre/callback/route") as any);
  const auth = await import("../lib/autenticacao");
  const oauth = await import("../lib/estado-oauth");
  ({ assinarEstado, calcularCodeChallenge, gerarCodeVerifier, nomeCookiePkce } = oauth as any);
  agoraEmSegundos = auth.agoraEmSegundos;
  tokenA = (await auth.emitirTokenSessao(UID_A)).token;
  tokenOutro = (await auth.emitirTokenSessao(UID_OUTRO)).token;
  // Importado AQUI, não perto da seção que o usa: os callbacks de `t()`
  // entram numa cadeia de microtasks que começa a rodar antes do fim
  // desta função, e uma `const` declarada mais abaixo cairia em TDZ.
  const cap = await import("../lib/marketplace/credenciais");

  secao("\n[1. rota de início]");

  t("1. início exige sessão válida", async () => {
    reiniciar();
    const res = await inicioGET(new Request("https://exemplo.test/api/auth/mercadolivre"));
    assert(destino(res).includes("/login"), `não mandou ao login: ${destino(res)}`);
    assert(consultas.length === 0, "🔴 consultou o banco sem sessão");
  });

  t("2. início: reconexão de loja ALHEIA é recusada", async () => {
    reiniciar();
    const res = await inicioGET(new Request(
      `https://exemplo.test/api/auth/mercadolivre?loja_id=${LOJA_ALHEIA}`,
      { headers: { cookie: `cds_session=${tokenA}` } }
    ));
    assert(codigoErro(res) === "loja_nao_pertence_usuario", `veio ${codigoErro(res)}`);
  });

  t("3. início: loja INATIVA continua recusada (somenteAtiva preservado)", async () => {
    reiniciar();
    const res = await inicioGET(new Request(
      `https://exemplo.test/api/auth/mercadolivre?loja_id=${LOJA_A_INATIVA}`,
      { headers: { cookie: `cds_session=${tokenA}` } }
    ));
    assert(codigoErro(res) === "loja_nao_pertence_usuario", `veio ${codigoErro(res)}`);
    const f = leituras()[0].filtros;
    assert(f.ativo === true, "🔴 perdeu o filtro ativo=true no início");
  });

  t("4. início: reconexão própria segue para o Mercado Livre com PKCE", async () => {
    reiniciar();
    const res = await inicioGET(new Request(
      `https://exemplo.test/api/auth/mercadolivre?loja_id=${LOJA_A}`,
      { headers: { cookie: `cds_session=${tokenA}` } }
    ));
    assert(destino(res).includes("auth.mercadolivre.com.br"), `não redirecionou ao ML: ${destino(res)}`);
    assert(destino(res).includes("code_challenge_method=S256"), "perdeu o PKCE S256");
    const f = leituras()[0].filtros;
    assert(f.id === LOJA_A && f.user_id === UID_A && f.marketplace === "ML", "filtros incompletos");
  });

  t("5. início: leitura projeta só id e seller_id, nunca credencial", async () => {
    reiniciar();
    await inicioGET(new Request(
      `https://exemplo.test/api/auth/mercadolivre?loja_id=${LOJA_A}`,
      { headers: { cookie: `cds_session=${tokenA}` } }
    ));
    const p = leituras()[0].projecao;
    assert(p === "id, seller_id", `projeção inesperada: ${p}`);
    for (const c of ["access_token", "refresh_token", "partner_key", "token_expires_at"]) {
      assert(!p.includes(c), `🔴 projetou ${c}`);
    }
  });

  secao("\n[2. callback — porta de entrada]");

  t("6. callback exige sessão válida", async () => {
    reiniciar();
    const { res } = await chamarCallback(UID_A, { intent: "connect" }, { sessao: null });
    assert(codigoErro(res) === "sessao_invalida", `veio ${codigoErro(res)}`);
    assert(consultas.length === 0 && chamadasToken === 0, "🔴 seguiu sem sessão");
  });

  t("7. code ausente -> 400, sem tocar banco nem ML", async () => {
    reiniciar();
    const { res } = await chamarCallback(UID_A, { intent: "connect" }, { code: null });
    assert(res.status === 400, `esperado 400, veio ${res.status}`);
    assert(chamadasToken === 0, "🔴 gastou o code endpoint");
  });

  t("8. state ausente -> state_invalido", async () => {
    reiniciar();
    const { res } = await chamarCallback(UID_A, { intent: "connect" }, { state: null });
    assert(codigoErro(res) === "state_invalido", `veio ${codigoErro(res)}`);
    assert(chamadasToken === 0, "🔴 gastou o code sem state");
  });

  t("9. state adulterado -> state_invalido", async () => {
    reiniciar();
    const { state } = await tentativa(UID_A, { intent: "connect" });
    const rompido = state.slice(0, -3) + "AAA";
    const { res } = await chamarCallback(UID_A, { intent: "connect" }, { state: rompido });
    assert(codigoErro(res) === "state_invalido", `veio ${codigoErro(res)}`);
    assert(chamadasToken === 0, "🔴 gastou o code com state adulterado");
  });

  t("10. state expirado -> state_expirado", async () => {
    reiniciar();
    const verifier = gerarCodeVerifier();
    const chal = await calcularCodeChallenge(verifier);
    const antigo = await assinarEstado(UID_A, { intent: "connect", chal }, {
      segredo: process.env.SESSION_SECRET!,
      agoraSegundos: agoraEmSegundos() - 4000,
    });
    const res = await callbackGET(reqCallback(
      { code: "CODE-OK", state: antigo },
      { cds_session: tokenA, [nomeCookiePkce(chal)]: verifier }
    ));
    assert(codigoErro(res) === "state_expirado", `veio ${codigoErro(res)}`);
    assert(chamadasToken === 0, "🔴 gastou o code com state vencido");
  });

  t("11. state.uid != auth.uid -> state_invalido", async () => {
    reiniciar();
    const { res } = await chamarCallback(UID_OUTRO, { intent: "connect" }, { sessao: tokenA });
    assert(codigoErro(res) === "state_invalido", `veio ${codigoErro(res)}`);
    assert(chamadasToken === 0, "🔴 gastou o code com binding quebrado");
  });

  t("12. PKCE ausente -> pkce_cookie_ausente, antes de gastar o code", async () => {
    reiniciar();
    const { res } = await chamarCallback(UID_A, { intent: "connect" }, { semPkce: true });
    assert(codigoErro(res) === "pkce_cookie_ausente", `veio ${codigoErro(res)}`);
    assert(chamadasToken === 0, "🔴 gastou o code sem PKCE");
  });

  t("13. PKCE incorreto -> pkce_invalido, antes de gastar o code", async () => {
    reiniciar();
    const { res } = await chamarCallback(UID_A, { intent: "connect" }, { pkceErrado: true });
    assert(codigoErro(res) === "pkce_invalido", `veio ${codigoErro(res)}`);
    assert(chamadasToken === 0, "🔴 gastou o code com PKCE errado");
  });

  secao("\n[3. reconnect]");

  t("14. reconnect: ownership é checado ANTES de gastar o code", async () => {
    reiniciar();
    const { res } = await chamarCallback(UID_A, { intent: "reconnect", loja: LOJA_ALHEIA });
    assert(codigoErro(res) === "loja_nao_pertence_usuario", `veio ${codigoErro(res)}`);
    assert(chamadasToken === 0, "🔴 gastou o code antes de checar a loja");
  });

  t("15. reconnect: loja Shopee não é alcançável pelo fluxo ML", async () => {
    reiniciar();
    const { res } = await chamarCallback(UID_A, { intent: "reconnect", loja: LOJA_SHOPEE });
    assert(codigoErro(res) === "loja_nao_pertence_usuario", `veio ${codigoErro(res)}`);
    assert(leituras()[0].filtros.marketplace === "ML", "perdeu o filtro de marketplace");
  });

  t("16. reconnect do mesmo tenant grava e devolve reconnected", async () => {
    reiniciar();
    const { res } = await chamarCallback(UID_A, { intent: "reconnect", loja: LOJA_A });
    assert(destino(res).includes("ml=reconnected"), `veio ${destino(res)}`);
    const l = linha(LOJA_A)!;
    assert(l.access_token === "<access-novo>", "não gravou o token novo");
    assert(l.ativo === true, "não reativou a loja");
  });

  t("17. reconnect com conta ML diferente -> conta_ml_diferente, sem gravar", async () => {
    reiniciar();
    respostaMe = { ok: true, status: 200, corpo: { id: "OUTRO-SELLER", nickname: "X" } };
    const { res } = await chamarCallback(UID_A, { intent: "reconnect", loja: LOJA_A });
    assert(codigoErro(res) === "conta_ml_diferente", `veio ${codigoErro(res)}`);
    assert(linha(LOJA_A)!.access_token === "<access-antigo>", "🔴 gravou credencial de outra conta");
  });

  t("18. reconnect: UPDATE carrega id E user_id", async () => {
    reiniciar();
    await chamarCallback(UID_A, { intent: "reconnect", loja: LOJA_A });
    const w = escritas();
    assert(w.length === 1 && w[0].tipo === "update", `escritas: ${w.length}`);
    assert(w[0].filtros.id === LOJA_A, "sem filtro de id");
    assert(w[0].filtros.user_id === UID_A, "🔴 UPDATE SEM filtro de dono");
  });

  secao("\n[4. connect]");

  t("19. primeira conexão cria loja com user_id da SESSÃO", async () => {
    reiniciar();
    respostaMe = { ok: true, status: 200, corpo: { id: SELLER_NOVO, nickname: "NOVA" } };
    const { res } = await chamarCallback(UID_A, { intent: "connect" });
    assert(destino(res).includes("ml=connected"), `veio ${destino(res)}`);
    const w = escritas();
    assert(w.length === 1 && w[0].tipo === "insert", `esperava insert, veio ${w[0]?.tipo}`);
    assert(w[0].payload.user_id === UID_A, "🔴 INSERT sem user_id da sessão");
    assert(w[0].payload.marketplace === "ML" && w[0].payload.seller_id === SELLER_NOVO, "payload incorreto");
    assert(w[0].payload.ativo === true, "não marcou ativo");
  });

  t("20. seller já existente do MESMO tenant atualiza, não duplica", async () => {
    reiniciar();
    const antes = linhas.length;
    const { res } = await chamarCallback(UID_A, { intent: "connect" });
    assert(destino(res).includes("ml=connected"), `veio ${destino(res)}`);
    assert(linhas.length === antes, "🔴 criou linha duplicada");
    const w = escritas();
    assert(w[0].tipo === "update" && w[0].filtros.id === LOJA_A, "não atualizou a loja existente");
  });

  t("21. seller igual em OUTRO tenant não cruza — cria a própria", async () => {
    reiniciar();
    // UID_OUTRO tem LOJA_ALHEIA com SELLER_1; UID_A também tem LOJA_A com
    // SELLER_1. Conectar como OUTRO não pode alcançar a loja de A.
    const { res } = await chamarCallback(UID_OUTRO, { intent: "connect" }, { sessao: tokenOutro });
    assert(destino(res).includes("ml=connected"), `veio ${destino(res)}`);
    assert(linha(LOJA_A)!.access_token === "<access-antigo>", "🔴 tocou a loja do outro tenant");
    const f = leituras()[0].filtros;
    assert(f.user_id === UID_OUTRO, "🔴 busca por seller sem escopo de dono");
  });

  t("22. duplicidade interna (>1) -> duplicidade_loja, fail-closed", async () => {
    reiniciar();
    respostaMe = { ok: true, status: 200, corpo: { id: SELLER_DUP, nickname: "DUP" } };
    const { res } = await chamarCallback(UID_A, { intent: "connect" });
    assert(codigoErro(res) === "duplicidade_loja", `veio ${codigoErro(res)}`);
    assert(escritas().length === 0, "🔴 gravou apesar da duplicidade");
  });

  t("23. a busca por seller NUNCA usa maybeSingle (duplicidade some)", async () => {
    reiniciar();
    respostaMe = { ok: true, status: 200, corpo: { id: SELLER_DUP, nickname: "DUP" } };
    const { res } = await chamarCallback(UID_A, { intent: "connect" });
    // Se a capability usasse maybeSingle, >1 linha nunca chegaria à rota
    // como duplicidade — viraria erro ou linha arbitrária.
    assert(codigoErro(res) === "duplicidade_loja", "🔴 duplicidade deixou de ser detectável");
  });

  secao("\n[5. refresh_token]");

  t("24. refresh_token presente é gravado", async () => {
    reiniciar();
    await chamarCallback(UID_A, { intent: "reconnect", loja: LOJA_A });
    assert(linha(LOJA_A)!.refresh_token === "<refresh-novo>", "não gravou o refresh novo");
  });

  t("25. refresh_token AUSENTE é OMITIDO — nunca vira null", async () => {
    reiniciar();
    respostaToken = { ok: true, status: 200, corpo: { access_token: "<access-novo>", expires_in: 21600 } };
    await chamarCallback(UID_A, { intent: "reconnect", loja: LOJA_A });
    const w = escritas()[0];
    assert(!("refresh_token" in w.payload), "🔴 escreveu refresh_token quando o ML não devolveu");
    assert(linha(LOJA_A)!.refresh_token === "<refresh-antigo>",
      "🔴 destruiu o refresh_token de longa duração");
  });

  t("26. INSERT sem refresh também OMITE a coluna", async () => {
    reiniciar();
    respostaToken = { ok: true, status: 200, corpo: { access_token: "<access-novo>", expires_in: 21600 } };
    respostaMe = { ok: true, status: 200, corpo: { id: SELLER_NOVO, nickname: "NOVA" } };
    await chamarCallback(UID_A, { intent: "connect" });
    assert(!("refresh_token" in escritas()[0].payload), "🔴 INSERT gravou refresh_token nulo");
  });

  t("27. escrita nunca toca colunas da Shopee", async () => {
    reiniciar();
    respostaMe = { ok: true, status: 200, corpo: { id: SELLER_NOVO, nickname: "NOVA" } };
    await chamarCallback(UID_A, { intent: "connect" });
    for (const c of ["partner_key", "partner_id", "shop_id"]) {
      assert(!(c in escritas()[0].payload), `🔴 escreveu ${c}`);
    }
  });

  secao("\n[6. falhas — nunca falso sucesso]");

  t("28. troca de token falha -> token_exchange_falhou, sem gravar", async () => {
    reiniciar();
    respostaToken = { ok: false, status: 400, corpo: { error: "invalid_grant" } };
    const { res } = await chamarCallback(UID_A, { intent: "connect" });
    assert(codigoErro(res) === "token_exchange_falhou", `veio ${codigoErro(res)}`);
    assert(escritas().length === 0, "🔴 gravou com a troca falhando");
  });

  t("29. identidade falha -> identidade_falhou, sem gravar", async () => {
    reiniciar();
    respostaMe = { ok: false, status: 401, corpo: {} };
    const { res } = await chamarCallback(UID_A, { intent: "connect" });
    assert(codigoErro(res) === "identidade_falhou", `veio ${codigoErro(res)}`);
    assert(escritas().length === 0, "🔴 gravou sem identidade");
  });

  t("30. erro de banco na busca -> persistencia_falhou", async () => {
    reiniciar();
    erroDeBanco = { message: 'relation "lojas" does not exist' };
    const { res } = await chamarCallback(UID_A, { intent: "connect" });
    erroDeBanco = null;
    assert(codigoErro(res) === "persistencia_falhou", `veio ${codigoErro(res)}`);
    assert(!destino(res).includes("ml=connected"), "🔴 falso sucesso com o banco fora");
  });

  t("31. UPDATE que não casa linha devolve `nenhuma_linha`, nunca sucesso", async () => {
    // Exercitado NA CAPABILITY, de propósito: pela rota, uma loja ausente
    // é barrada antes na leitura e o teste passaria pelo motivo errado —
    // "não é sua" em vez de "zero linhas alteradas". Aqui o UPDATE roda
    // de fato e não casa nada.
    reiniciar();
    const r = await cap.registrarCredencialMLOAuth(UID_A, {
      lojaId: LOJA_INEXISTENTE,
      sellerId: SELLER_1,
      nickname: "X",
      accessToken: "<access-novo>",
      refreshToken: null,
      expiraEm: "2027-01-01T00:00:00Z",
    });
    assert(r.lojaId === null, "🔴 devolveu id sem ter alterado linha");
    assert(r.erro === "nenhuma_linha", `esperava nenhuma_linha, veio ${r.erro}`);
    const w = escritas();
    assert(w.length === 1 && w[0].tipo === "update", "não chegou a tentar o UPDATE");
  });

  t("31b. loja alheia: UPDATE não alcança linha de outro dono", async () => {
    reiniciar();
    const r = await cap.registrarCredencialMLOAuth(UID_A, {
      lojaId: LOJA_ALHEIA,
      sellerId: SELLER_1,
      nickname: "X",
      accessToken: "<access-novo>",
      refreshToken: null,
      expiraEm: "2027-01-01T00:00:00Z",
    });
    assert(r.lojaId === null && r.erro === "nenhuma_linha", "🔴 alcançou loja de outro dono");
    assert(linha(LOJA_ALHEIA)!.access_token === "<access-antigo>", "🔴 alterou loja alheia");
  });

  t("32. code reutilizado falha (uso único do ML)", async () => {
    reiniciar();
    const { res } = await chamarCallback(UID_A, { intent: "connect" }, { code: "USADO" });
    assert(codigoErro(res) === "token_exchange_falhou", `veio ${codigoErro(res)}`);
    assert(escritas().length === 0, "🔴 gravou com code reutilizado");
  });

  secao("\n[7. segredos]");

  const SENSIVEIS = /<access-novo>|<refresh-novo>|<client-secret>|CODE-OK|access_token|refresh_token/;

  t("33. nenhum token, code ou state aparece no redirect", async () => {
    reiniciar();
    const { res, state } = await chamarCallback(UID_A, { intent: "reconnect", loja: LOJA_A });
    const loc = destino(res);
    assert(!SENSIVEIS.test(loc), `🔴 credencial no Location: ${loc}`);
    assert(!loc.includes(state), "🔴 state ecoado no Location");
  });

  t("34. nenhum segredo nos logs, em nenhum caminho de erro", async () => {
    for (const preparar of [
      () => { respostaToken = { ok: false, status: 400, corpo: { error: "invalid_grant" } }; },
      () => { respostaMe = { ok: false, status: 401, corpo: {} }; },
      () => { erroDeBanco = { message: 'relation "lojas" does not exist' }; },
    ]) {
      reiniciar();
      preparar();
      await chamarCallback(UID_A, { intent: "connect" });
      erroDeBanco = null;
      const texto = logs.join("\n");
      assert(!SENSIVEIS.test(texto), `🔴 segredo no log: ${texto.slice(0, 200)}`);
    }
  });

  t("35. o texto cru do Postgres NÃO aparece no log", async () => {
    reiniciar();
    erroDeBanco = { message: 'could not connect to server (host=db.interno port=5432)' };
    await chamarCallback(UID_A, { intent: "connect" });
    erroDeBanco = null;
    const texto = logs.join("\n");
    for (const frag of ["could not connect", "db.interno", "5432", "host="]) {
      assert(!texto.includes(frag), `🔴 fragmento do banco no log: ${frag}`);
    }
  });

  t("36. o log de erro é ESTÁTICO — igual para erros diferentes", async () => {
    const capturas: string[] = [];
    for (const m of ['relation "lojas" does not exist', "permission denied for table lojas"]) {
      reiniciar();
      erroDeBanco = { message: m };
      await chamarCallback(UID_A, { intent: "connect" });
      erroDeBanco = null;
      capturas.push(logs.join("\n"));
    }
    assert(capturas[0] === capturas[1], `🔴 o log varia com o erro:\n${capturas.join("\n---\n")}`);
  });

  t("37. o log não identifica tenant nem loja", async () => {
    reiniciar();
    erroDeBanco = { message: "x" };
    await chamarCallback(UID_A, { intent: "reconnect", loja: LOJA_A });
    erroDeBanco = null;
    const texto = logs.join("\n");
    assert(!texto.includes(UID_A), "🔴 userId no log");
    assert(!texto.includes(LOJA_A), "🔴 lojaId no log");
    assert(!texto.includes(SELLER_1), "🔴 sellerId no log");
  });

  secao("\n[8. fronteira da capability]");

  const fs = await import("node:fs");
  const codigo = (c: string) =>
    fs.readFileSync(c, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  const INICIO = "app/api/auth/mercadolivre/route.ts";
  const CALLBACK = "app/api/auth/mercadolivre/callback/route.ts";

  for (const [nome, caminho] of [["início", INICIO], ["callback", CALLBACK]] as const) {
    t(`38.${nome}: sem createClient, sem ANON key, sem SDK`, async () => {
      const src = codigo(caminho);
      assert(!/createClient/.test(src), "🔴 cria cliente próprio");
      assert(!/NEXT_PUBLIC_SUPABASE_ANON_KEY/.test(src), "🔴 usa a chave anon");
      assert(!/@supabase\/supabase-js/.test(src), "🔴 importa o SDK");
    });

    t(`39.${nome}: sem .from("lojas") direto`, async () => {
      assert(!/\.from\(/.test(codigo(caminho)), "🔴 monta query direta");
    });

    t(`40.${nome}: não loga error.message`, async () => {
      assert(!/error\.message|erroBusca\.message|erroInsert\.message/.test(codigo(caminho)),
        "🔴 voltou a logar mensagem crua do banco");
    });
  }

  t("41. estado-oauth e PKCE permanecem INTACTOS", async () => {
    const src = codigo("lib/estado-oauth.ts");
    assert(/VERSAO_ESTADO = 2/.test(src), "🔴 versão do state mudou");
    assert(/TTL_PADRAO_SEGUNDOS = 600/.test(src), "🔴 TTL do state mudou");
    assert(/PREFIXO_COOKIE_PKCE = "ml_pkce_"/.test(src), "🔴 nome do cookie PKCE mudou");
    assert(/S-?256|SHA-256/.test(src), "🔴 método do challenge mudou");
  });

  t("42. a capability usa service_role encapsulada, nunca anon", async () => {
    const src = codigo("lib/marketplace/credenciais.ts");
    assert(/getSupabaseServidor\(\)/.test(src), "não usa getSupabaseServidor");
    assert(!/NEXT_PUBLIC_SUPABASE_ANON_KEY/.test(src), "🔴 a capability usa chave anon");
    assert(/import "server-only"/.test(src), "🔴 perdeu a barreira server-only");
  });

  t("43. as três capabilities exigem dono", async () => {
    assert(cap.lerLojaMLDoDonoParaReconexao.length === 3, "aridade inesperada (lojaId, userId, opcoes)");
    assert(cap.listarLojasMLDoDonoPorSeller.length === 2, "aridade inesperada");
    assert(cap.registrarCredencialMLOAuth.length === 2, "aridade inesperada");
  });

  t("44. argumento vazio não alcança o banco", async () => {
    reiniciar();
    await cap.lerLojaMLDoDonoParaReconexao("", UID_A);
    await cap.lerLojaMLDoDonoParaReconexao(LOJA_A, "");
    await cap.listarLojasMLDoDonoPorSeller("", SELLER_1);
    await cap.listarLojasMLDoDonoPorSeller(UID_A, "");
    assert(consultas.length === 0, "🔴 argumento vazio chegou ao banco");
  });

  t("45. registrarCredencialMLOAuth sem userId não escreve", async () => {
    reiniciar();
    const r = await cap.registrarCredencialMLOAuth("", {
      sellerId: SELLER_1, nickname: "X", accessToken: "<a>", refreshToken: null, expiraEm: "2027-01-01",
    });
    assert(r.lojaId === null && r.erro !== null, "🔴 aceitou escrita sem dono");
    assert(consultas.length === 0, "🔴 tocou o banco sem dono");
  });

  await fila;
  imprimir(`\n=== RESULTADO: ${ok} passaram, ${falhou} falharam ===\n`);
  if (falhou > 0) process.exit(1);
}

void principal();
