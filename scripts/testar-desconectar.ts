/**
 * `POST /api/lojas/desconectar` — F0.c.6a.
 *
 * ── O bug que estes testes fecham ───────────────────────────────────
 * A rota ficou no mecanismo de sessão V1: lia `cds_session` cru e o
 * comparava com a coluna `user_id`. Desde o cutover `5933332` o cookie
 * carrega um token assinado, então o filtro nunca casava — e o retorno
 * era `{ ok: true }` sem checar erro nem linhas afetadas. A tela dizia
 * "Loja desconectada." e nada acontecia.
 *
 * ── O que estes testes provam ───────────────────────────────────────
 * O EFEITO NO BANCO, não o texto da resposta: o duplo do Supabase aplica
 * o update numa tabela em memória, registra cada `.eq()` e conta as
 * linhas afetadas. Uma versão que responda 200 sem alterar linha alguma
 * quebra aqui.
 *
 * Sem rede, sem banco real, sem credencial: todos os valores são
 * marcadores em `<colchetes>`. Nenhuma loja de produção é tocada.
 *
 * ── PR #2b-2 ───────────────────────────────────────────────────────
 * A rota deixou de falar com o banco: quem escreve é
 * `desconectarLojaDoDono()`, na capability server-only. Os testes de
 * EFEITO abaixo não mudaram uma linha — e é esse o ponto, porque provam
 * que a migração preservou o comportamento. Os testes novos (26–33)
 * guardam a fronteira nova.
 *
 * O duplo de `@supabase/supabase-js` continua valendo: a capability usa
 * `getSupabaseServidor()`, que chama o mesmo `createClient` interceptado
 * aqui. Muda o chamador, não o ponto de interceptação.
 *
 * Uso: npx tsx scripts/testar-desconectar.ts
 */
// Primeiro import do arquivo, antes de qualquer `lib/`: a capability é
// marcada `server-only` e o pacote LANÇA fora da condição `react-server`.
// O duplo de `require` instalado abaixo encadeia sobre este.
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
process.env.SESSION_SECRET ??= "segredo-de-teste-com-mais-de-32-bytes-000000";
// `getSupabaseServidor()` é fail-closed: sem esta variável ele LANÇA antes
// de qualquer consulta. Valor inválido de propósito — o cliente real nunca
// chega a ser construído, porque `createClient` está interceptado.
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "chave-de-teste-invalida";

const UID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UID_OUTRO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const LOJA_A = "11111111-1111-4111-8111-111111111111";  // ML, de A, selecionada
const LOJA_A2 = "1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a"; // ML, de A, não selecionada
const LOJA_SHOPEE_A = "44444444-4444-4444-8444-444444444444";
const LOJA_ALHEIA = "22222222-2222-4222-8222-222222222222";
const LOJA_JA_DESCONECTADA = "55555555-5555-4555-8555-555555555555";
const LOJA_INEXISTENTE = "99999999-9999-4999-8999-999999999999";

interface Linha {
  id: string; user_id: string | null; marketplace: string; ativo: boolean;
  nickname: string | null; seller_id: string | null; shop_id: string | null;
  partner_id: string | null; partner_key: string | null;
  access_token: string | null; refresh_token: string | null; token_expires_at: string | null;
}

let linhas: Linha[] = [];

function semear() {
  const base = {
    nickname: "Loja", seller_id: "<seller>", shop_id: null, partner_id: null, partner_key: null,
    access_token: "<access>", refresh_token: "<refresh>", token_expires_at: "2026-12-31T00:00:00Z",
  };
  linhas = [
    { id: LOJA_A, user_id: UID_A, marketplace: "ML", ativo: true, ...base },
    { id: LOJA_A2, user_id: UID_A, marketplace: "ML", ativo: true, ...base },
    { id: LOJA_ALHEIA, user_id: UID_OUTRO, marketplace: "ML", ativo: true, ...base },
    { id: LOJA_JA_DESCONECTADA, user_id: UID_A, marketplace: "ML", ativo: false,
      ...base, access_token: null, refresh_token: null, token_expires_at: null },
    { id: LOJA_SHOPEE_A, user_id: UID_A, marketplace: "Shopee", ativo: true, ...base,
      shop_id: "<shop>", partner_id: "<partner-id>", partner_key: "<partner-key>" },
  ];
}

interface Consulta { tabela: string; tipo: "select" | "update"; filtros: Record<string, unknown>; patch: Record<string, unknown> }
let consultas: Consulta[] = [];
let erroDeBanco: { message: string } | null = null;

function casa(l: Linha, filtros: Record<string, unknown>) {
  return Object.entries(filtros).every(([c, v]) => (l as any)[c] === v);
}

function clienteFalso() {
  const criarCadeia = (tabela: string) => {
    const filtros: Record<string, unknown> = {};
    let tipo: "select" | "update" = "select";
    let patch: Record<string, unknown> = {};
    const executar = () => {
      consultas.push({ tabela, tipo, filtros: { ...filtros }, patch: { ...patch } });
      if (erroDeBanco) return { data: null, error: erroDeBanco };
      const alvo = linhas.filter(l => casa(l, filtros));
      if (tipo === "select") return { data: alvo, error: null };
      for (const l of alvo) Object.assign(l, patch);
      return { data: alvo.map(l => ({ id: l.id })), error: null };
    };
    const cadeia: any = {
      select: () => cadeia,
      update: (p: Record<string, unknown>) => { tipo = "update"; patch = p; return cadeia; },
      delete: () => { throw new Error("🔴 a rota tentou DELETAR uma linha de `lojas`"); },
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

/** Rede é proibida nesta rota — se algo tentar sair, o teste acusa. */
globalThis.fetch = (async (url: any) => {
  throw new Error(`teste tentou acessar a rede: ${String(url)}`);
}) as any;

let logs: string[] = [];
function coletar(...args: any[]) { logs.push(args.map(a => String(a)).join(" ")); }

function reiniciar() {
  semear();
  consultas = [];
  erroDeBanco = null;
  logs = [];
}

let rotaPOST: (req: Request) => Promise<Response>;
let tokenA = "";

function req(lojaId: unknown, cookies: Record<string, string>, corpoBruto?: string) {
  const valor = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  return new Request("https://exemplo.test/api/lojas/desconectar", {
    method: "POST",
    headers: { "content-type": "application/json", ...(valor ? { cookie: valor } : {}) },
    body: corpoBruto ?? JSON.stringify({ loja_id: lojaId }),
  });
}

const linha = (id: string) => linhas.find(l => l.id === id)!;
const setCookies = (res: Response) => {
  const varios = (res.headers as any).getSetCookie?.();
  return Array.isArray(varios) && varios.length ? varios.join("\n") : (res.headers.get("set-cookie") ?? "");
};
const escritas = () => consultas.filter(c => c.tipo === "update");

async function principal() {
  console.log = coletar;
  console.error = coletar;

  ({ POST: rotaPOST } = await import("../app/api/lojas/desconectar/route") as any);
  const { emitirTokenSessao } = await import("../lib/autenticacao");
  tokenA = (await emitirTokenSessao(UID_A)).token;

  secao("\n[1. sessão]");

  t("1. sem cookie de sessão -> 401 e nenhuma escrita", async () => {
    reiniciar();
    const res = await rotaPOST(req(LOJA_A, {}));
    assert(res.status === 401, `esperado 401, veio ${res.status}`);
    assert(consultas.length === 0, "consultou o banco sem sessão");
  });

  t("2. cookie de sessão FORJADO (uid cru) -> 401", async () => {
    // O caso exato do bug: a versão antiga tratava este valor como user_id.
    reiniciar();
    const res = await rotaPOST(req(LOJA_A, { cds_session: UID_A }));
    assert(res.status === 401, `sessão forjada aceita: ${res.status}`);
    assert(linha(LOJA_A).ativo === true, "🔴 desconectou com sessão forjada");
  });

  secao("\n[2. validação de entrada]");

  t("3. loja_id malformado -> 400 sem tocar no banco", async () => {
    for (const mau of ["nao-e-uuid", "1", "'; DROP TABLE lojas;--", LOJA_A + "x", ""]) {
      reiniciar();
      const res = await rotaPOST(req(mau, { cds_session: tokenA }));
      assert(res.status === 400, `id "${mau}" devolveu ${res.status}`);
      assert(consultas.length === 0, `id malformado chegou ao banco: ${mau}`);
    }
  });

  t("4. loja_id ausente ou de outro tipo -> 400", async () => {
    for (const corpo of ['{}', '{"loja_id":123}', '{"loja_id":null}', '{"loja_id":{"a":1}}']) {
      reiniciar();
      const res = await rotaPOST(req(undefined, { cds_session: tokenA }, corpo));
      assert(res.status === 400, `corpo ${corpo} devolveu ${res.status}`);
      assert(consultas.length === 0, "chegou ao banco sem loja_id válido");
    }
  });

  t("5. body não-JSON -> 400, sem estourar", async () => {
    reiniciar();
    const res = await rotaPOST(req(undefined, { cds_session: tokenA }, "isto não é json"));
    assert(res.status === 400, `esperado 400, veio ${res.status}`);
    assert(consultas.length === 0, "chegou ao banco com body inválido");
  });

  secao("\n[3. propriedade]");

  t("6. loja de OUTRO usuário -> 404 e ZERO escrita efetiva", async () => {
    reiniciar();
    const res = await rotaPOST(req(LOJA_ALHEIA, { cds_session: tokenA }));
    assert(res.status === 404, `esperado 404, veio ${res.status}`);
    const alheia = linha(LOJA_ALHEIA);
    assert(alheia.ativo === true && alheia.access_token === "<access>",
      "🔴 alterou a loja de outro usuário");
  });

  t("7. loja inexistente -> 404, mesma resposta da alheia (sem enumeração)", async () => {
    reiniciar();
    const r1 = await rotaPOST(req(LOJA_INEXISTENTE, { cds_session: tokenA }));
    const c1 = await r1.text();
    reiniciar();
    const r2 = await rotaPOST(req(LOJA_ALHEIA, { cds_session: tokenA }));
    const c2 = await r2.text();
    assert(r1.status === r2.status && c1 === c2,
      `respostas distinguíveis: ${r1.status}/${c1} vs ${r2.status}/${c2}`);
  });

  t("8. TODA escrita carrega id E user_id juntos", async () => {
    reiniciar();
    await rotaPOST(req(LOJA_A, { cds_session: tokenA }));
    const w = escritas();
    assert(w.length === 1, `esperava 1 escrita, houve ${w.length}`);
    assert(w[0].filtros.id === LOJA_A, "escrita sem filtro de id");
    assert(w[0].filtros.user_id === UID_A, "🔴 escrita SEM filtro de dono");
  });

  secao("\n[4. efeito no banco]");

  t("9. loja própria -> 200 e EXATAMENTE uma linha alterada", async () => {
    reiniciar();
    const res = await rotaPOST(req(LOJA_A, { cds_session: tokenA }));
    assert(res.status === 200, `esperado 200, veio ${res.status}`);
    assert((await res.json()).ok === true, "não devolveu ok:true");
    const afetadas = linhas.filter(l => l.ativo === false && l.access_token === null);
    assert(afetadas.length === 2, // a alvo + a que já estava desconectada
      `linhas desconectadas: ${afetadas.length}`);
    assert(linha(LOJA_A2).ativo === true, "🔴 desconectou a outra loja do mesmo usuário");
  });

  t("10. ativo vira false", async () => {
    reiniciar();
    await rotaPOST(req(LOJA_A, { cds_session: tokenA }));
    assert(linha(LOJA_A).ativo === false, "ativo continua true");
  });

  t("11. access_token é limpo", async () => {
    reiniciar();
    await rotaPOST(req(LOJA_A, { cds_session: tokenA }));
    assert(linha(LOJA_A).access_token === null, "access_token sobreviveu");
  });

  t("12. refresh_token é limpo", async () => {
    reiniciar();
    await rotaPOST(req(LOJA_A, { cds_session: tokenA }));
    assert(linha(LOJA_A).refresh_token === null,
      "🔴 refresh_token sobreviveu à desconexão — credencial de longa duração");
  });

  t("13. token_expires_at é limpo", async () => {
    reiniciar();
    await rotaPOST(req(LOJA_A, { cds_session: tokenA }));
    assert(linha(LOJA_A).token_expires_at === null, "token_expires_at sobreviveu");
  });

  t("14. a linha NÃO é deletada", async () => {
    // O duplo lança se `.delete()` for chamado; aqui confirmamos o efeito.
    reiniciar();
    const antes = linhas.length;
    await rotaPOST(req(LOJA_A, { cds_session: tokenA }));
    assert(linhas.length === antes, "🔴 a linha sumiu — histórico de pedidos referencia loja_id");
    assert(!!linha(LOJA_A), "a loja alvo desapareceu");
  });

  t("15. identidade da loja é PRESERVADA (seller_id, shop_id, partner_*)", async () => {
    // `partner_key` é chave de aplicação da Shopee, lida do banco para
    // assinar requisições. Não volta por reautorização: apagá-la
    // impediria reconectar.
    reiniciar();
    await rotaPOST(req(LOJA_SHOPEE_A, { cds_session: tokenA }));
    const l = linha(LOJA_SHOPEE_A);
    assert(l.ativo === false, "não desconectou a loja Shopee");
    assert(l.partner_key === "<partner-key>", "🔴 apagou partner_key — impede reconectar");
    assert(l.partner_id === "<partner-id>" && l.shop_id === "<shop>", "apagou identidade da loja");
    assert(l.seller_id === "<seller>", "apagou seller_id");
  });

  secao("\n[5. resultado real — nunca falso sucesso]");

  t("16. zero linhas alteradas NUNCA vira ok:true", async () => {
    reiniciar();
    const res = await rotaPOST(req(LOJA_ALHEIA, { cds_session: tokenA }));
    const corpo = await res.json();
    assert(res.status !== 200, `🔴 respondeu ${res.status} sem alterar nada`);
    assert(corpo.ok !== true, "🔴 ok:true com zero linhas alteradas");
  });

  t("17. falha de banco -> 503, nunca ok:true", async () => {
    reiniciar();
    erroDeBanco = { message: 'relation "lojas" does not exist' };
    const res = await rotaPOST(req(LOJA_A, { cds_session: tokenA }));
    const corpo = await res.json();
    assert(res.status === 503, `esperado 503, veio ${res.status}`);
    assert(corpo.ok !== true, "🔴 ok:true com o banco fora do ar");
    assert(!/relation|does not exist/i.test(JSON.stringify(corpo)), "vazou detalhe do banco");
    erroDeBanco = null;
  });

  t("18. desconectar DUAS VEZES -> segunda não é falso sucesso", async () => {
    reiniciar();
    const primeira = await rotaPOST(req(LOJA_A, { cds_session: tokenA }));
    assert(primeira.status === 200, `primeira falhou: ${primeira.status}`);
    const segunda = await rotaPOST(req(LOJA_A, { cds_session: tokenA }));
    assert(segunda.status === 404, `🔴 segunda desconexão respondeu ${segunda.status}`);
    assert((await segunda.json()).ok !== true, "🔴 falso sucesso na segunda desconexão");
  });

  t("19. loja já desconectada -> 404, sem reescrever", async () => {
    reiniciar();
    const res = await rotaPOST(req(LOJA_JA_DESCONECTADA, { cds_session: tokenA }));
    assert(res.status === 404, `esperado 404, veio ${res.status}`);
  });

  secao("\n[6. cookies]");

  t("20. loja SELECIONADA -> limpa loja_ativa_id e os cookies ML", async () => {
    reiniciar();
    const res = await rotaPOST(req(LOJA_A, {
      cds_session: tokenA, loja_ativa_id: LOJA_A,
      ml_access_token: "<access>", ml_refresh_token: "<refresh>",
    }));
    const sc = setCookies(res);
    for (const nome of ["loja_ativa_id", "ml_access_token", "ml_refresh_token"]) {
      assert(sc.includes(nome), `não limpou ${nome}`);
    }
    assert(/max-age=0/i.test(sc), "não expirou os cookies");
  });

  t("21. loja NÃO selecionada -> não derruba a seleção de outra loja", async () => {
    reiniciar();
    const res = await rotaPOST(req(LOJA_A2, { cds_session: tokenA, loja_ativa_id: LOJA_A }));
    assert(res.status === 200, `esperado 200, veio ${res.status}`);
    assert(!setCookies(res).includes("loja_ativa_id"),
      "🔴 limpou a seleção de uma loja que continua conectada");
  });

  t("22. loja Shopee selecionada -> limpa só os cookies da Shopee", async () => {
    reiniciar();
    const res = await rotaPOST(req(LOJA_SHOPEE_A, {
      cds_session: tokenA, shopee_loja_id: LOJA_SHOPEE_A, loja_ativa_id: LOJA_A,
    }));
    const sc = setCookies(res);
    assert(sc.includes("shopee_loja_id") && sc.includes("shopee_access_token"), "não limpou cookies da Shopee");
    assert(!sc.includes("loja_ativa_id"), "🔴 derrubou a seleção do ML ao desconectar Shopee");
  });

  secao("\n[7. segurança]");

  const MARCADORES = /<access>|<refresh>|<partner-key>|access_token|refresh_token|partner_key|cds_session/i;

  t("23. nenhuma resposta contém credencial", async () => {
    for (const alvo of [LOJA_A, LOJA_ALHEIA, LOJA_INEXISTENTE]) {
      reiniciar();
      const res = await rotaPOST(req(alvo, { cds_session: tokenA, ml_access_token: "<access>" }));
      const texto = await res.text();
      assert(!MARCADORES.test(texto), `🔴 credencial na resposta de ${alvo}: ${texto}`);
    }
  });

  t("24. nenhum log contém credencial, nem no caminho de erro", async () => {
    reiniciar();
    erroDeBanco = { message: 'relation "lojas" does not exist' };
    await rotaPOST(req(LOJA_A, { cds_session: tokenA, ml_access_token: "<access>" }));
    erroDeBanco = null;
    assert(!MARCADORES.test(logs.join("\n")), `🔴 credencial no log: ${logs.join(" | ").slice(0, 200)}`);
  });

  t("25. a rota não lê o cookie de sessão por conta própria", async () => {
    const fs = await import("node:fs");
    const fonte = fs.readFileSync("app/api/lojas/desconectar/route.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    assert(!/cds_session/.test(fonte), "🔴 voltou a interpretar o cookie de sessão à mão");
    assert(/autenticarRequisicao/.test(fonte), "não usa a camada oficial de autenticação");
  });

  secao("\n[8. fronteira da capability — PR #2b-2]");

  const fs = await import("node:fs");
  /** Fonte sem comentários: evita casar com prosa em vez de código. */
  const codigo = (caminho: string) =>
    fs.readFileSync(caminho, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");

  const ROTA = "app/api/lojas/desconectar/route.ts";
  const CAP = "lib/marketplace/credenciais.ts";

  t("26. a rota NÃO constrói mais cliente Supabase", async () => {
    const fonte = codigo(ROTA);
    assert(!/@supabase\/supabase-js/.test(fonte), "🔴 a rota voltou a importar o SDK do Supabase");
    assert(!/createClient/.test(fonte), "🔴 a rota voltou a criar cliente próprio");
    assert(!/ANON_KEY/.test(fonte), "🔴 a rota voltou a usar a chave anon");
    assert(!/\.from\(/.test(fonte), "🔴 a rota voltou a consultar tabela diretamente");
  });

  t("27. a rota escreve pela capability", async () => {
    assert(/desconectarLojaDoDono/.test(codigo(ROTA)), "a rota não usa a capability");
  });

  t("28. a capability continua marcada server-only", async () => {
    assert(/import\s+["']server-only["']/.test(codigo(CAP)),
      "🔴 a barreira server-only sumiu da capability");
  });

  t("29. o UPDATE altera EXATAMENTE os 4 campos de sessão", async () => {
    reiniciar();
    await rotaPOST(req(LOJA_SHOPEE_A, { cds_session: tokenA }));
    const w = escritas();
    assert(w.length === 1, `esperava 1 escrita, houve ${w.length}`);
    const chaves = Object.keys(w[0].patch).sort();
    assert(JSON.stringify(chaves) === JSON.stringify(
      ["access_token", "ativo", "refresh_token", "token_expires_at"]),
      `🔴 o patch mudou: ${chaves.join(", ")}`);
  });

  t("30. o UPDATE filtra por id, user_id E ativo=true", async () => {
    reiniciar();
    await rotaPOST(req(LOJA_A, { cds_session: tokenA }));
    const f = escritas()[0].filtros;
    assert(f.id === LOJA_A, "perdeu o filtro de id");
    assert(f.user_id === UID_A, "🔴 perdeu o filtro de dono");
    assert(f.ativo === true, "🔴 perdeu `ativo=true` — desconexão dupla vira falso sucesso");
  });

  t("31. o patch NUNCA menciona identidade da loja", async () => {
    reiniciar();
    await rotaPOST(req(LOJA_SHOPEE_A, { cds_session: tokenA }));
    const patch = escritas()[0].patch;
    for (const proibido of ["partner_key", "partner_id", "seller_id", "shop_id",
                            "user_id", "marketplace", "nome", "nickname"]) {
      assert(!(proibido in patch), `🔴 a desconexão escreveu em ${proibido}`);
    }
  });

  const { desconectarLojaDoDono } = await import("../lib/marketplace/credenciais");

  t("32. a capability exige os DOIS argumentos", async () => {
    assert(desconectarLojaDoDono.length === 2,
      `🔴 assinatura permite chamada sem dono: aridade ${desconectarLojaDoDono.length}`);
  });

  t("33. userId vazio não alcança o banco (nem desconecta nada)", async () => {
    for (const [loja, dono] of [[LOJA_A, ""], ["", UID_A], ["", ""]] as [string, string][]) {
      reiniciar();
      const r = await desconectarLojaDoDono(loja, dono);
      assert(r.desconectadas === 0, `🔴 desconectou com argumento vazio: ${loja}/${dono}`);
      assert(consultas.length === 0, "🔴 argumento vazio chegou ao banco");
      assert(linha(LOJA_A).ativo === true, "🔴 alterou linha com argumento vazio");
    }
  });

  t("34. erro de banco vira `erro` preenchido, nunca desconexão silenciosa", async () => {
    reiniciar();
    erroDeBanco = { message: 'relation "lojas" does not exist' };
    const r = await desconectarLojaDoDono(LOJA_A, UID_A);
    erroDeBanco = null;
    assert(r.erro !== null, "🔴 engoliu o erro do banco");
    assert(r.desconectadas === 0, "🔴 contou linhas com o banco em erro");
  });

  await fila;
  imprimir(`\n=== RESULTADO: ${ok} passaram, ${falhou} falharam ===\n`);
  if (falhou > 0) process.exit(1);
}

void principal();
