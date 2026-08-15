/**
 * Fluxo OAuth do Mercado Livre — F0.c.6c + 6d.
 *
 * ── O que estas suítes provam ───────────────────────────────────────
 * Não o texto da resposta, e sim o EFEITO: quais chamadas saíram para o
 * Mercado Livre, quais linhas do banco mudaram, e o que foi (ou não)
 * para a URL. Os duplos registram tudo, então uma implementação que
 * responda "sucesso" sem gravar, ou que grave na linha errada, quebra.
 *
 * ── Cenário do banco ────────────────────────────────────────────────
 * Reproduz a realidade medida em produção: o MESMO seller aparece em
 * linhas de donos diferentes e em linhas ÓRFÃS. É o caso que faz uma
 * busca por `seller_id` sem dono gravar credencial no registro errado.
 *
 * Sem rede, sem banco real, sem credencial: todo valor é marcador em
 * `<colchetes>`. Nenhum OAuth real é executado.
 *
 * Uso: npx tsx scripts/testar-oauth-ml.ts
 */
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
process.env.ML_CLIENT_ID ??= "ficticio";
process.env.ML_CLIENT_SECRET ??= "ficticio";
process.env.ML_REDIRECT_URI ??= "https://www.exemplo.test/api/auth/mercadolivre/callback";
process.env.SESSION_SECRET ??= "segredo-de-teste-com-mais-de-32-bytes-000000";

const SEGREDO = process.env.SESSION_SECRET!;

const UID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const LOJA_A = "11111111-1111-4111-8111-111111111111";  // de A, seller COMPARTILHADO
const LOJA_A2 = "1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a"; // de A, seller próprio
const LOJA_B = "22222222-2222-4222-8222-222222222222";  // de B, MESMO seller de LOJA_A
const LOJA_ORFA = "33333333-3333-4333-8333-333333333333"; // user_id NULL, mesmo seller
const LOJA_DUP1 = "d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1"; // de A, seller duplicado
const LOJA_DUP2 = "d2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2"; // de A, MESMO seller de DUP1
const LOJA_INEXISTENTE = "99999999-9999-4999-8999-999999999999";

const SELLER_COMPARTILHADO = "744240004";
const SELLER_A2 = "111222333";
const SELLER_DUPLICADO = "555666777";
const SELLER_NOVO = "999888777";

const ACCESS_NOVO = "<access-novo-do-ml>";
const REFRESH_NOVO = "<refresh-novo-do-ml>";

interface Linha {
  id: string; user_id: string | null; marketplace: string; ativo: boolean;
  nickname: string | null; nome: string | null; seller_id: string | null;
  access_token: string | null; refresh_token: string | null; token_expires_at: string | null;
}

let linhas: Linha[] = [];
let idsCriados = 0;

function semear() {
  idsCriados = 0;
  const base = { nome: "Loja", access_token: "<access-antigo>", refresh_token: "<refresh-antigo>", token_expires_at: "2026-01-01T00:00:00Z" };
  linhas = [
    { id: LOJA_A,   user_id: UID_A, marketplace: "ML", ativo: true, nickname: "LojaA", seller_id: SELLER_COMPARTILHADO, ...base },
    { id: LOJA_A2,  user_id: UID_A, marketplace: "ML", ativo: true, nickname: "LojaA2", seller_id: SELLER_A2, ...base },
    { id: LOJA_B,   user_id: UID_B, marketplace: "ML", ativo: true, nickname: "LojaB", seller_id: SELLER_COMPARTILHADO, ...base },
    { id: LOJA_ORFA, user_id: null, marketplace: "ML", ativo: true, nickname: "Orfa", seller_id: SELLER_COMPARTILHADO, ...base },
    { id: LOJA_DUP1, user_id: UID_A, marketplace: "ML", ativo: true, nickname: "Dup1", seller_id: SELLER_DUPLICADO, ...base },
    { id: LOJA_DUP2, user_id: UID_A, marketplace: "ML", ativo: true, nickname: "Dup2", seller_id: SELLER_DUPLICADO, ...base },
  ];
}

interface Consulta { tabela: string; tipo: "select" | "update" | "insert"; filtros: Record<string, unknown> }
let consultas: Consulta[] = [];
let erroDeBanco: { message: string } | null = null;

function casa(l: Linha, filtros: Record<string, unknown>) {
  return Object.entries(filtros).every(([c, v]) => (l as any)[c] === v);
}

function clienteFalso() {
  const criarCadeia = (tabela: string) => {
    const filtros: Record<string, unknown> = {};
    let tipo: "select" | "update" | "insert" = "select";
    let patch: Record<string, unknown> = {};

    const executar = () => {
      consultas.push({ tabela, tipo, filtros: { ...filtros } });
      if (erroDeBanco) return { data: null, error: erroDeBanco };
      if (tipo === "insert") {
        const nova: Linha = {
          id: `novo-${++idsCriados}`, user_id: null, marketplace: "", ativo: false,
          nickname: null, nome: null, seller_id: null,
          access_token: null, refresh_token: null, token_expires_at: null,
          ...(patch as any),
        };
        linhas.push(nova);
        return { data: [{ id: nova.id }], error: null };
      }
      const alvo = linhas.filter(l => casa(l, filtros));
      if (tipo === "select") return { data: alvo, error: null };
      for (const l of alvo) Object.assign(l, patch);
      return { data: alvo.map(l => ({ id: l.id })), error: null };
    };

    const cadeia: any = {
      select: () => cadeia,
      update: (p: Record<string, unknown>) => { tipo = "update"; patch = p; return cadeia; },
      insert: (p: Record<string, unknown>) => { tipo = "insert"; patch = p; return cadeia; },
      delete: () => { throw new Error("🔴 o fluxo tentou DELETAR uma linha de `lojas`"); },
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

// ── Duplo do Mercado Livre ───────────────────────────────────────────
interface ChamadaML { url: string; grant: string | null }
let chamadasML: ChamadaML[] = [];
let respostaToken: { access_token?: string; refresh_token?: string; expires_in?: number } | null = null;
let statusToken = 200;
let sellerDevolvido: string | null = null;
let statusUsersMe = 200;

globalThis.fetch = (async (url: any, init?: any) => {
  const alvo = String(url);
  let grant: string | null = null;
  if (alvo.includes("/oauth/token")) {
    grant = new URLSearchParams(String(init?.body ?? "")).get("grant_type");
  }
  chamadasML.push({ url: alvo, grant });

  if (!alvo.includes("mercadolibre.com")) throw new Error(`teste tentou acessar a rede: ${alvo}`);

  if (alvo.includes("/oauth/token")) {
    if (statusToken !== 200) return { ok: false, status: statusToken, json: async () => ({ error: "x" }) } as any;
    return { ok: true, status: 200, json: async () => respostaToken ?? {} } as any;
  }
  if (alvo.includes("/users/me")) {
    if (statusUsersMe !== 200) return { ok: false, status: statusUsersMe, json: async () => ({}) } as any;
    return { ok: true, status: 200, json: async () => ({ id: Number(sellerDevolvido), nickname: "CONTA-ML" }) } as any;
  }
  return { ok: false, status: 404, json: async () => ({}) } as any;
}) as any;

let logs: string[] = [];
function coletar(...args: any[]) { logs.push(args.map(a => String(a)).join(" ")); }

function reiniciar() {
  semear();
  consultas = [];
  chamadasML = [];
  erroDeBanco = null;
  statusToken = 200;
  statusUsersMe = 200;
  respostaToken = { access_token: ACCESS_NOVO, refresh_token: REFRESH_NOVO, expires_in: 21600 };
  sellerDevolvido = SELLER_COMPARTILHADO;
  logs = [];
}

let rotaInicio: (req: Request) => Promise<Response>;
let rotaCallback: (req: Request) => Promise<Response>;
let assinarEstado: any;
let emitirTokenSessao: any;
let tokenA = "", tokenB = "";

const linha = (id: string) => linhas.find(l => l.id === id)!;
const trocasDeToken = () => chamadasML.filter(c => c.grant === "authorization_code");
const escritas = () => consultas.filter(c => c.tipo === "update" || c.tipo === "insert");

function reqInicio(cookies: Record<string, string>, lojaId?: string) {
  const valor = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  const qs = lojaId === undefined ? "" : `?loja_id=${encodeURIComponent(lojaId)}`;
  return new Request(`https://exemplo.test/api/auth/mercadolivre${qs}`,
    valor ? { headers: { cookie: valor } } : undefined);
}

function reqCallback(cookies: Record<string, string>, params: Record<string, string>) {
  const valor = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  const qs = new URLSearchParams(params).toString();
  return new Request(`https://exemplo.test/api/auth/mercadolivre/callback?${qs}`,
    valor ? { headers: { cookie: valor } } : undefined);
}

const destino = (res: Response) => res.headers.get("location") ?? "";
const paramDe = (res: Response, chave: string) => {
  try { return new URL(destino(res)).searchParams.get(chave); } catch { return null; }
};

async function stateDe(uid: string, dados: any, ttl?: number, agora?: number) {
  const { agoraEmSegundos } = await import("../lib/autenticacao");
  return assinarEstado(uid, dados, {
    segredo: SEGREDO,
    agoraSegundos: agora ?? agoraEmSegundos(),
    ttlSegundos: ttl,
  });
}

async function principal() {
  console.log = coletar;
  console.error = coletar;

  ({ GET: rotaInicio } = await import("../app/api/auth/mercadolivre/route") as any);
  ({ GET: rotaCallback } = await import("../app/api/auth/mercadolivre/callback/route") as any);
  ({ assinarEstado } = await import("../lib/estado-oauth"));
  ({ emitirTokenSessao } = await import("../lib/autenticacao"));

  tokenA = (await emitirTokenSessao(UID_A)).token;
  tokenB = (await emitirTokenSessao(UID_B)).token;

  // ══════════════════════════════════════════════════════════════════
  secao("\n[1. início do OAuth]");

  t("1. sem sessão -> vai para /login, NÃO para o Mercado Livre", async () => {
    reiniciar();
    const res = await rotaInicio(reqInicio({}));
    assert(destino(res).includes("/login"), `destino inesperado: ${destino(res)}`);
    assert(!destino(res).includes("mercadolivre"), "🔴 iniciou OAuth sem sessão");
    assert(consultas.length === 0, "consultou o banco sem sessão");
  });

  t("2. sessão forjada (uid cru) -> /login", async () => {
    reiniciar();
    const res = await rotaInicio(reqInicio({ cds_session: UID_A }));
    assert(destino(res).includes("/login"), "sessão forjada iniciou OAuth");
  });

  t("3. CONNECT: redireciona ao ML com state assinado e sem loja", async () => {
    reiniciar();
    const res = await rotaInicio(reqInicio({ cds_session: tokenA }));
    const url = destino(res);
    assert(url.startsWith("https://auth.mercadolivre.com.br/authorization"), `destino: ${url}`);
    const state = new URL(url).searchParams.get("state");
    assert(!!state, "sem state na URL de autorização");
    const { verificarEstado } = await import("../lib/estado-oauth");
    const { agoraEmSegundos } = await import("../lib/autenticacao");
    const v = await verificarEstado(state, { segredo: SEGREDO, agoraSegundos: agoraEmSegundos() });
    assert(v !== null && v.intent === "connect" && v.uid === UID_A, `state errado: ${JSON.stringify(v)}`);
  });

  t("4. RECONNECT da loja própria: state carrega a loja", async () => {
    reiniciar();
    const res = await rotaInicio(reqInicio({ cds_session: tokenA }, LOJA_A));
    const state = new URL(destino(res)).searchParams.get("state");
    const { verificarEstado } = await import("../lib/estado-oauth");
    const { agoraEmSegundos } = await import("../lib/autenticacao");
    const v: any = await verificarEstado(state, { segredo: SEGREDO, agoraSegundos: agoraEmSegundos() });
    assert(v?.intent === "reconnect" && v.loja === LOJA_A, `state errado: ${JSON.stringify(v)}`);
  });

  t("5. RECONNECT de loja ALHEIA -> nem chega ao Mercado Livre", async () => {
    reiniciar();
    const res = await rotaInicio(reqInicio({ cds_session: tokenA }, LOJA_B));
    assert(!destino(res).includes("mercadolivre"), "🔴 iniciou OAuth para loja alheia");
    assert(paramDe(res, "ml_erro") === "loja_nao_pertence_usuario", `erro: ${destino(res)}`);
  });

  t("6. RECONNECT de loja inexistente ou malformada -> recusa idêntica", async () => {
    for (const alvo of [LOJA_INEXISTENTE, "nao-e-uuid", "'; DROP TABLE lojas;--"]) {
      reiniciar();
      const res = await rotaInicio(reqInicio({ cds_session: tokenA }, alvo));
      assert(paramDe(res, "ml_erro") === "loja_nao_pertence_usuario", `"${alvo}": ${destino(res)}`);
      assert(!destino(res).includes("mercadolivre"), `"${alvo}" chegou ao ML`);
    }
  });

  t("7. RECONNECT de loja ÓRFÃ -> negado (não é de ninguém)", async () => {
    reiniciar();
    const res = await rotaInicio(reqInicio({ cds_session: tokenA }, LOJA_ORFA));
    assert(paramDe(res, "ml_erro") === "loja_nao_pertence_usuario", `erro: ${destino(res)}`);
  });

  // ══════════════════════════════════════════════════════════════════
  secao("\n[2. callback: tudo que reprova ANTES de gastar o code]");

  const semTroca = (nome: string) =>
    assert(trocasDeToken().length === 0, `🔴 ${nome}: trocou o code por token mesmo assim`);

  t("8. callback sem sessão -> sessao_invalida, sem troca", async () => {
    reiniciar();
    const state = await stateDe(UID_A, { intent: "connect" });
    const res = await rotaCallback(reqCallback({}, { code: "CODE", state }));
    assert(paramDe(res, "ml_erro") === "sessao_invalida", `erro: ${destino(res)}`);
    semTroca("sem sessão");
  });

  t("9. usuário cancelou no ML -> oauth_cancelado, sem troca", async () => {
    reiniciar();
    const res = await rotaCallback(reqCallback({ cds_session: tokenA }, { error: "access_denied" }));
    assert(paramDe(res, "ml_erro") === "oauth_cancelado", `erro: ${destino(res)}`);
    semTroca("cancelado");
  });

  t("10. state AUSENTE -> state_invalido, sem troca", async () => {
    reiniciar();
    const res = await rotaCallback(reqCallback({ cds_session: tokenA }, { code: "CODE" }));
    assert(paramDe(res, "ml_erro") === "state_invalido", `erro: ${destino(res)}`);
    semTroca("state ausente");
  });

  t("11. state ADULTERADO -> state_invalido, sem troca", async () => {
    reiniciar();
    const state = await stateDe(UID_A, { intent: "connect" });
    const [p, a] = state.split(".");
    const res = await rotaCallback(reqCallback({ cds_session: tokenA },
      { code: "CODE", state: `${p}.${a[0] === "A" ? "B" : "A"}${a.slice(1)}` }));
    assert(paramDe(res, "ml_erro") === "state_invalido", `erro: ${destino(res)}`);
    semTroca("state adulterado");
  });

  t("12. state EXPIRADO -> state_expirado, sem troca", async () => {
    reiniciar();
    const { agoraEmSegundos } = await import("../lib/autenticacao");
    const state = await stateDe(UID_A, { intent: "connect" }, 600, agoraEmSegundos() - 3600);
    const res = await rotaCallback(reqCallback({ cds_session: tokenA }, { code: "CODE", state }));
    assert(paramDe(res, "ml_erro") === "state_expirado", `erro: ${destino(res)}`);
    semTroca("state expirado");
  });

  t("13. state de OUTRO usuário -> state_invalido, sem troca", async () => {
    reiniciar();
    const state = await stateDe(UID_B, { intent: "connect" });
    const res = await rotaCallback(reqCallback({ cds_session: tokenA }, { code: "CODE", state }));
    assert(paramDe(res, "ml_erro") === "state_invalido", `🔴 binding não verificado: ${destino(res)}`);
    semTroca("user mismatch");
  });

  t("14. RECONNECT com loja alheia no state -> negado, sem troca", async () => {
    reiniciar();
    const state = await stateDe(UID_A, { intent: "reconnect", loja: LOJA_B });
    const res = await rotaCallback(reqCallback({ cds_session: tokenA }, { code: "CODE", state }));
    assert(paramDe(res, "ml_erro") === "loja_nao_pertence_usuario", `erro: ${destino(res)}`);
    semTroca("loja alheia");
    assert(linha(LOJA_B).access_token === "<access-antigo>", "🔴 tocou a loja alheia");
  });

  // ══════════════════════════════════════════════════════════════════
  secao("\n[3. CONNECT]");

  t("15. seller INEXISTENTE para o usuário -> INSERT", async () => {
    reiniciar();
    sellerDevolvido = SELLER_NOVO;
    const state = await stateDe(UID_A, { intent: "connect" });
    const antes = linhas.length;
    const res = await rotaCallback(reqCallback({ cds_session: tokenA }, { code: "CODE", state }));
    assert(paramDe(res, "ml") === "connected", `esperado sucesso: ${destino(res)}`);
    assert(linhas.length === antes + 1, "não criou linha");
    const nova = linhas[linhas.length - 1];
    assert(nova.user_id === UID_A, "criou sem dono correto");
    assert(nova.seller_id === SELLER_NOVO && nova.access_token === ACCESS_NOVO, "dados errados");
    assert(nova.refresh_token === REFRESH_NOVO, "não gravou o refresh");
  });

  t("16. seller com UMA linha própria -> UPDATE dessa linha", async () => {
    reiniciar();
    sellerDevolvido = SELLER_A2;
    const state = await stateDe(UID_A, { intent: "connect" });
    const antes = linhas.length;
    const res = await rotaCallback(reqCallback({ cds_session: tokenA }, { code: "CODE", state }));
    assert(paramDe(res, "ml") === "connected", `esperado sucesso: ${destino(res)}`);
    assert(linhas.length === antes, "criou linha em vez de atualizar");
    assert(linha(LOJA_A2).access_token === ACCESS_NOVO, "não atualizou a linha certa");
  });

  t("17. seller com DUAS linhas próprias -> FAIL CLOSED, zero escrita", async () => {
    reiniciar();
    sellerDevolvido = SELLER_DUPLICADO;
    const state = await stateDe(UID_A, { intent: "connect" });
    const antes = linhas.length;
    const res = await rotaCallback(reqCallback({ cds_session: tokenA }, { code: "CODE", state }));
    assert(paramDe(res, "ml_erro") === "duplicidade_loja", `esperado duplicidade: ${destino(res)}`);
    assert(linhas.length === antes, "🔴 criou linha apesar da duplicidade");
    assert(linha(LOJA_DUP1).access_token === "<access-antigo>", "🔴 escreveu na Dup1");
    assert(linha(LOJA_DUP2).access_token === "<access-antigo>", "🔴 escreveu na Dup2");
    assert(escritas().length === 0, `🔴 houve escrita: ${JSON.stringify(escritas())}`);
  });

  t("18. seller que existe só para OUTRO usuário -> cria linha PRÓPRIA", async () => {
    // Regra aprovada: não há unicidade global de seller. Completar o
    // OAuth prova controle da conta ML; o que não pode é tocar a linha
    // alheia.
    reiniciar();
    sellerDevolvido = SELLER_COMPARTILHADO;
    const state = await stateDe(UID_B, { intent: "connect" });
    // B já tem LOJA_B com esse seller → é o caso "uma linha própria".
    const res = await rotaCallback(reqCallback({ cds_session: tokenB }, { code: "CODE", state }));
    assert(paramDe(res, "ml") === "connected", `esperado sucesso: ${destino(res)}`);
    assert(linha(LOJA_B).access_token === ACCESS_NOVO, "não atualizou a loja de B");
    assert(linha(LOJA_A).access_token === "<access-antigo>", "🔴 tocou a loja de A");
    assert(linha(LOJA_ORFA).access_token === "<access-antigo>", "🔴 tocou a órfã");
  });

  t("19. órfã com o mesmo seller NUNCA é adotada", async () => {
    reiniciar();
    sellerDevolvido = SELLER_COMPARTILHADO;
    // Usuário sem nenhuma linha para esse seller: deve CRIAR, não adotar.
    const uidNovo = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const tokenNovo = (await emitirTokenSessao(uidNovo)).token;
    const state = await stateDe(uidNovo, { intent: "connect" });
    const res = await rotaCallback(reqCallback({ cds_session: tokenNovo }, { code: "CODE", state }));
    assert(paramDe(res, "ml") === "connected", `esperado sucesso: ${destino(res)}`);
    const orfa = linha(LOJA_ORFA);
    assert(orfa.user_id === null && orfa.access_token === "<access-antigo>",
      "🔴 a órfã foi adotada ou alterada");
    const nova = linhas[linhas.length - 1];
    assert(nova.user_id === uidNovo, "não criou linha para o usuário novo");
  });

  t("20. TODA leitura de lojas no CONNECT carrega user_id", async () => {
    reiniciar();
    sellerDevolvido = SELLER_A2;
    const state = await stateDe(UID_A, { intent: "connect" });
    await rotaCallback(reqCallback({ cds_session: tokenA }, { code: "CODE", state }));
    for (const c of consultas.filter(c => c.tabela === "lojas" && c.tipo === "select")) {
      assert(c.filtros.user_id === UID_A, `🔴 leitura sem dono: ${JSON.stringify(c.filtros)}`);
    }
  });

  // ══════════════════════════════════════════════════════════════════
  secao("\n[4. RECONNECT]");

  t("21. loja própria + seller correto -> UPDATE daquela loja", async () => {
    reiniciar();
    sellerDevolvido = SELLER_COMPARTILHADO;
    const state = await stateDe(UID_A, { intent: "reconnect", loja: LOJA_A });
    const res = await rotaCallback(reqCallback({ cds_session: tokenA }, { code: "CODE", state }));
    assert(paramDe(res, "ml") === "reconnected", `esperado reconnected: ${destino(res)}`);
    assert(paramDe(res, "loja") === LOJA_A, "loja errada no retorno");
    assert(linha(LOJA_A).access_token === ACCESS_NOVO, "não atualizou a loja alvo");
    assert(linha(LOJA_B).access_token === "<access-antigo>", "🔴 tocou a loja de B (mesmo seller)");
    assert(linha(LOJA_ORFA).access_token === "<access-antigo>", "🔴 tocou a órfã (mesmo seller)");
  });

  t("22. loja própria + seller DIFERENTE -> zero escrita", async () => {
    reiniciar();
    sellerDevolvido = SELLER_NOVO;   // autorizou outra conta ML
    const state = await stateDe(UID_A, { intent: "reconnect", loja: LOJA_A });
    const antes = { ...linha(LOJA_A) };
    const res = await rotaCallback(reqCallback({ cds_session: tokenA }, { code: "CODE", state }));
    assert(paramDe(res, "ml_erro") === "conta_ml_diferente", `erro: ${destino(res)}`);
    const depois = linha(LOJA_A);
    assert(depois.access_token === antes.access_token, "🔴 sobrescreveu a credencial");
    assert(depois.seller_id === antes.seller_id, "🔴 transformou a loja em outra conta ML");
    assert(escritas().length === 0, `🔴 houve escrita: ${JSON.stringify(escritas())}`);
  });

  t("23. a escrita do RECONNECT carrega id E user_id", async () => {
    reiniciar();
    const state = await stateDe(UID_A, { intent: "reconnect", loja: LOJA_A });
    await rotaCallback(reqCallback({ cds_session: tokenA }, { code: "CODE", state }));
    const w = escritas();
    assert(w.length === 1, `esperava 1 escrita, houve ${w.length}`);
    assert(w[0].filtros.id === LOJA_A && w[0].filtros.user_id === UID_A,
      `🔴 escrita sem os dois filtros: ${JSON.stringify(w[0].filtros)}`);
  });

  // ══════════════════════════════════════════════════════════════════
  secao("\n[5. refresh_token]");

  t("24. ML sem refresh_token NÃO destrói o refresh existente", async () => {
    reiniciar();
    respostaToken = { access_token: ACCESS_NOVO, expires_in: 21600 };  // sem refresh
    const state = await stateDe(UID_A, { intent: "reconnect", loja: LOJA_A });
    const res = await rotaCallback(reqCallback({ cds_session: tokenA }, { code: "CODE", state }));
    assert(paramDe(res, "ml") === "reconnected", `esperado sucesso: ${destino(res)}`);
    assert(linha(LOJA_A).access_token === ACCESS_NOVO, "não atualizou o access");
    assert(linha(LOJA_A).refresh_token === "<refresh-antigo>",
      "🔴 apagou um refresh_token válido por causa de resposta sem refresh");
  });

  t("25. ML com refresh_token novo SUBSTITUI o antigo", async () => {
    reiniciar();
    const state = await stateDe(UID_A, { intent: "reconnect", loja: LOJA_A });
    await rotaCallback(reqCallback({ cds_session: tokenA }, { code: "CODE", state }));
    assert(linha(LOJA_A).refresh_token === REFRESH_NOVO, "não rotacionou o refresh");
  });

  t("26. INSERT sem refresh_token nasce sem a coluna, não com lixo", async () => {
    reiniciar();
    sellerDevolvido = SELLER_NOVO;
    respostaToken = { access_token: ACCESS_NOVO, expires_in: 21600 };
    const state = await stateDe(UID_A, { intent: "connect" });
    await rotaCallback(reqCallback({ cds_session: tokenA }, { code: "CODE", state }));
    const nova = linhas[linhas.length - 1];
    assert(nova.refresh_token === null, `refresh inesperado: ${nova.refresh_token}`);
    assert(nova.access_token === ACCESS_NOVO, "não gravou o access");
  });

  // ══════════════════════════════════════════════════════════════════
  secao("\n[6. falhas — nunca sucesso falso]");

  t("27. troca de code falha -> token_exchange_falhou, zero escrita", async () => {
    reiniciar();
    statusToken = 400;
    const state = await stateDe(UID_A, { intent: "reconnect", loja: LOJA_A });
    const res = await rotaCallback(reqCallback({ cds_session: tokenA }, { code: "CODE", state }));
    assert(paramDe(res, "ml_erro") === "token_exchange_falhou", `erro: ${destino(res)}`);
    assert(escritas().length === 0, "escreveu apesar da falha");
  });

  t("28. resposta sem access_token -> token_exchange_falhou", async () => {
    reiniciar();
    respostaToken = { refresh_token: REFRESH_NOVO };
    const state = await stateDe(UID_A, { intent: "reconnect", loja: LOJA_A });
    const res = await rotaCallback(reqCallback({ cds_session: tokenA }, { code: "CODE", state }));
    assert(paramDe(res, "ml_erro") === "token_exchange_falhou", `erro: ${destino(res)}`);
  });

  t("29. /users/me falha -> identidade_falhou, zero escrita", async () => {
    reiniciar();
    statusUsersMe = 500;
    const state = await stateDe(UID_A, { intent: "reconnect", loja: LOJA_A });
    const res = await rotaCallback(reqCallback({ cds_session: tokenA }, { code: "CODE", state }));
    assert(paramDe(res, "ml_erro") === "identidade_falhou", `erro: ${destino(res)}`);
    assert(escritas().length === 0, "escreveu sem saber quem autorizou");
  });

  t("30. erro de banco -> persistencia_falhou, nunca sucesso", async () => {
    reiniciar();
    erroDeBanco = { message: 'relation "lojas" does not exist' };
    const state = await stateDe(UID_A, { intent: "reconnect", loja: LOJA_A });
    const res = await rotaCallback(reqCallback({ cds_session: tokenA }, { code: "CODE", state }));
    assert(paramDe(res, "ml_erro") === "persistencia_falhou", `erro: ${destino(res)}`);
    assert(paramDe(res, "ml") === null, "🔴 sinalizou sucesso com o banco fora do ar");
    erroDeBanco = null;
  });

  t("31. update que não afeta linha -> persistencia_falhou", async () => {
    reiniciar();
    const state = await stateDe(UID_A, { intent: "reconnect", loja: LOJA_A });
    // A loja some entre a revalidação e a escrita.
    const original = linha(LOJA_A);
    let removida = false;
    const fetchAntigo = globalThis.fetch;
    globalThis.fetch = (async (u: any, i?: any) => {
      const r = await (fetchAntigo as any)(u, i);
      if (String(u).includes("/users/me") && !removida) {
        removida = true;
        linhas = linhas.filter(l => l.id !== LOJA_A);
      }
      return r;
    }) as any;
    const res = await rotaCallback(reqCallback({ cds_session: tokenA }, { code: "CODE", state }));
    globalThis.fetch = fetchAntigo;
    assert(paramDe(res, "ml_erro") === "persistencia_falhou", `erro: ${destino(res)}`);
    assert(paramDe(res, "ml") === null, "🔴 sucesso com zero linhas alteradas");
    void original;
  });

  // ══════════════════════════════════════════════════════════════════
  secao("\n[7. credenciais nunca saem]");

  const MARCADORES = /<access|<refresh|access_token|refresh_token|client_secret|Bearer/i;

  t("32. nenhum Location contém credencial, em nenhum desfecho", async () => {
    const cenarios: Array<[string, () => Promise<Response>]> = [
      ["connect ok", async () => { reiniciar(); sellerDevolvido = SELLER_A2;
        return rotaCallback(reqCallback({ cds_session: tokenA }, { code: "C", state: await stateDe(UID_A, { intent: "connect" }) })); }],
      ["reconnect ok", async () => { reiniciar();
        return rotaCallback(reqCallback({ cds_session: tokenA }, { code: "C", state: await stateDe(UID_A, { intent: "reconnect", loja: LOJA_A }) })); }],
      ["seller diferente", async () => { reiniciar(); sellerDevolvido = SELLER_NOVO;
        return rotaCallback(reqCallback({ cds_session: tokenA }, { code: "C", state: await stateDe(UID_A, { intent: "reconnect", loja: LOJA_A }) })); }],
      ["duplicidade", async () => { reiniciar(); sellerDevolvido = SELLER_DUPLICADO;
        return rotaCallback(reqCallback({ cds_session: tokenA }, { code: "C", state: await stateDe(UID_A, { intent: "connect" }) })); }],
      ["token falhou", async () => { reiniciar(); statusToken = 400;
        return rotaCallback(reqCallback({ cds_session: tokenA }, { code: "C", state: await stateDe(UID_A, { intent: "connect" }) })); }],
      ["início connect", async () => { reiniciar(); return rotaInicio(reqInicio({ cds_session: tokenA })); }],
    ];
    for (const [nome, executar] of cenarios) {
      const res = await executar();
      const loc = destino(res);
      assert(!MARCADORES.test(loc), `🔴 credencial no Location de "${nome}": ${loc}`);
      const corpo = await res.text();
      assert(!MARCADORES.test(corpo), `🔴 credencial no corpo de "${nome}"`);
    }
  });

  t("33. nenhum Set-Cookie carrega credencial do Mercado Livre", async () => {
    reiniciar();
    const state = await stateDe(UID_A, { intent: "reconnect", loja: LOJA_A });
    const res = await rotaCallback(reqCallback({ cds_session: tokenA }, { code: "C", state }));
    const sc = ((res.headers as any).getSetCookie?.() ?? [res.headers.get("set-cookie")]).filter(Boolean).join("\n");
    assert(!/ml_access_token|ml_refresh_token/.test(sc), `🔴 emitiu cookie de credencial: ${sc}`);
  });

  t("34. nenhum log contém credencial, nem no caminho de erro", async () => {
    reiniciar();
    statusToken = 500;
    const state = await stateDe(UID_A, { intent: "reconnect", loja: LOJA_A });
    await rotaCallback(reqCallback({ cds_session: tokenA }, { code: "CODE-SECRETO", state }));
    const tudo = logs.join("\n");
    assert(!MARCADORES.test(tudo), `🔴 credencial no log: ${tudo.slice(0, 200)}`);
    assert(!tudo.includes("CODE-SECRETO"), "🔴 o code apareceu no log");
  });

  t("35. o relay não existe e ninguém o referencia", async () => {
    const fs = await import("node:fs");
    assert(!fs.existsSync("app/api/auth/relay/route.ts"), "🔴 o relay continua no repositório");
    for (const f of [
      "app/api/auth/mercadolivre/callback/route.ts",
      "app/api/auth/mercadolivre/route.ts",
      "lib/middleware-rotas.ts",
    ]) {
      const fonte = fs.readFileSync(f, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      assert(!/auth\/relay/.test(fonte), `🔴 ${f} ainda referencia o relay`);
    }
  });

  await fila;
  imprimir(`\n=== RESULTADO: ${ok} passaram, ${falhou} falharam ===\n`);
  if (falhou > 0) process.exit(1);
}

void principal();
