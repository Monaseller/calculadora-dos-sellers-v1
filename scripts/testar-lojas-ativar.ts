/**
 * `POST /api/lojas/ativar` — PR #2b-3.
 *
 * ── O que esta suíte fecha ──────────────────────────────────────────
 * A rota lia `select("*")` com o cliente ANON. O `*` trazia
 * `refresh_token`, `partner_key` e `token_expires_at` — que a rota
 * NUNCA usou — para dentro da memória do processo. E o `error` do
 * Supabase era descartado, então banco fora do ar respondia 404,
 * indistinguível de "a loja não é sua".
 *
 * ── O que estes testes provam ───────────────────────────────────────
 * A PROJEÇÃO e o EFEITO, não o texto da resposta. O duplo do Supabase
 * registra a string literal de cada `.select()` e cada `.eq()`, então
 * uma regressão para `*`, ou a perda do filtro de dono, quebra aqui —
 * não numa inspeção de fonte que casaria com prosa em comentário.
 *
 * Sem rede, sem banco real, sem credencial: todos os valores são
 * marcadores em `<colchetes>`.
 *
 * Uso: npx tsx scripts/testar-lojas-ativar.ts
 */
// Primeiro import, antes de qualquer `lib/`: a capability é marcada
// `server-only` e o pacote LANÇA fora da condição `react-server`.
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
// `getSupabaseServidor()` é fail-closed: sem esta variável ele LANÇA.
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "chave-de-teste-invalida";

const UID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UID_OUTRO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const LOJA_ML = "11111111-1111-4111-8111-111111111111";       // ML, de A, com token
const LOJA_ML_SEM_TOKEN = "33333333-3333-4333-8333-333333333333";
const LOJA_SHOPEE = "44444444-4444-4444-8444-444444444444";
const LOJA_ALHEIA = "22222222-2222-4222-8222-222222222222";
const LOJA_INEXISTENTE = "99999999-9999-4999-8999-999999999999";

interface Linha {
  id: string; user_id: string | null; marketplace: string; ativo: boolean;
  nome: string | null; nickname: string | null;
  seller_id: string | null; shop_id: string | null;
  partner_id: string | null; partner_key: string | null;
  access_token: string | null; refresh_token: string | null; token_expires_at: string | null;
}

let linhas: Linha[] = [];

function semear() {
  const base = {
    nome: "Loja", nickname: "apelido", seller_id: "<seller>", shop_id: null,
    partner_id: null, partner_key: "<partner-key>",
    access_token: "<access>", refresh_token: "<refresh>",
    token_expires_at: "2026-12-31T00:00:00Z",
  };
  linhas = [
    { id: LOJA_ML, user_id: UID_A, marketplace: "ML", ativo: true, ...base },
    { id: LOJA_ML_SEM_TOKEN, user_id: UID_A, marketplace: "ML", ativo: true, ...base, access_token: null },
    { id: LOJA_ALHEIA, user_id: UID_OUTRO, marketplace: "ML", ativo: true, ...base },
    { id: LOJA_SHOPEE, user_id: UID_A, marketplace: "Shopee", ativo: true, ...base,
      shop_id: "<shop>", partner_id: "<partner-id>" },
  ];
}

interface Consulta { tabela: string; tipo: "select" | "update"; projecao: string; filtros: Record<string, unknown> }
let consultas: Consulta[] = [];
let erroDeBanco: { message: string } | null = null;

function casa(l: Linha, filtros: Record<string, unknown>) {
  return Object.entries(filtros).every(([c, v]) => (l as any)[c] === v);
}

/**
 * Devolve só as colunas pedidas na projeção. É isso que torna a
 * projeção OBSERVÁVEL: se a rota voltar a pedir `*`, os campos
 * sensíveis reaparecem no objeto e os testes de ausência quebram.
 */
function projetar(l: Linha, projecao: string): Record<string, unknown> {
  if (projecao.trim() === "*") return { ...l };
  const saida: Record<string, unknown> = {};
  for (const c of projecao.split(",").map(s => s.trim()).filter(Boolean)) {
    saida[c] = (l as any)[c];
  }
  return saida;
}

function clienteFalso() {
  const criarCadeia = (tabela: string) => {
    const filtros: Record<string, unknown> = {};
    let tipo: "select" | "update" = "select";
    let projecao = "*";
    const executar = () => {
      consultas.push({ tabela, tipo, projecao, filtros: { ...filtros } });
      if (erroDeBanco) return { data: null, error: erroDeBanco };
      const alvo = linhas.filter(l => casa(l, filtros));
      return { data: alvo.map(l => projetar(l, projecao)), error: null };
    };
    const cadeia: any = {
      select: (p?: string) => { projecao = p ?? "*"; return cadeia; },
      update: () => { throw new Error("🔴 a ativação tentou ESCREVER em `lojas`"); },
      delete: () => { throw new Error("🔴 a ativação tentou DELETAR de `lojas`"); },
      eq: (c: string, v: unknown) => { filtros[c] = v; return cadeia; },
      maybeSingle: async () => { const r = executar(); return { data: (r.data as any[])?.[0] ?? null, error: r.error }; },
      single: async () => {
        const r = executar();
        const linha0 = (r.data as any[])?.[0] ?? null;
        // Semântica real do PostgREST: zero linhas é ERRO em `single()`.
        if (!r.error && !linha0) return { data: null, error: { message: "PGRST116: no rows" } };
        return { data: linha0, error: r.error };
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

function req(lojaId: unknown, cookies: Record<string, string>) {
  const valor = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  return new Request("https://exemplo.test/api/lojas/ativar", {
    method: "POST",
    headers: { "content-type": "application/json", ...(valor ? { cookie: valor } : {}) },
    body: JSON.stringify({ loja_id: lojaId }),
  });
}

const setCookies = (res: Response) => {
  const varios = (res.headers as any).getSetCookie?.();
  return Array.isArray(varios) && varios.length ? varios.join("\n") : (res.headers.get("set-cookie") ?? "");
};
const leituras = () => consultas.filter(c => c.tipo === "select");

async function principal() {
  console.log = coletar;
  console.error = coletar;

  ({ POST: rotaPOST } = await import("../app/api/lojas/ativar/route") as any);
  const { emitirTokenSessao } = await import("../lib/autenticacao");
  tokenA = (await emitirTokenSessao(UID_A)).token;

  secao("\n[1. sessão]");

  t("1. sessão válida -> 200", async () => {
    reiniciar();
    const res = await rotaPOST(req(LOJA_ML, { cds_session: tokenA }));
    assert(res.status === 200, `esperado 200, veio ${res.status}`);
    assert((await res.json()).ok === true, "não devolveu ok:true");
  });

  t("2. sem cookie de sessão -> 401 e nenhuma consulta", async () => {
    reiniciar();
    const res = await rotaPOST(req(LOJA_ML, {}));
    assert(res.status === 401, `esperado 401, veio ${res.status}`);
    assert(consultas.length === 0, "🔴 consultou o banco sem sessão");
  });

  t("3. cookie de sessão FORJADO (uid cru) -> 401", async () => {
    reiniciar();
    const res = await rotaPOST(req(LOJA_ML, { cds_session: UID_A }));
    assert(res.status === 401, `sessão forjada aceita: ${res.status}`);
    assert(consultas.length === 0, "🔴 consultou o banco com sessão forjada");
  });

  secao("\n[2. propriedade e ausência]");

  t("4. loja inexistente -> 404", async () => {
    reiniciar();
    const res = await rotaPOST(req(LOJA_INEXISTENTE, { cds_session: tokenA }));
    assert(res.status === 404, `esperado 404, veio ${res.status}`);
  });

  t("5. loja de OUTRO tenant -> 404 e nenhum cookie emitido", async () => {
    reiniciar();
    const res = await rotaPOST(req(LOJA_ALHEIA, { cds_session: tokenA }));
    assert(res.status === 404, `esperado 404, veio ${res.status}`);
    assert(setCookies(res) === "", "🔴 emitiu cookie para loja alheia");
  });

  t("6. alheia e inexistente são indistinguíveis (sem enumeração)", async () => {
    reiniciar();
    const r1 = await rotaPOST(req(LOJA_INEXISTENTE, { cds_session: tokenA }));
    const c1 = await r1.text();
    reiniciar();
    const r2 = await rotaPOST(req(LOJA_ALHEIA, { cds_session: tokenA }));
    const c2 = await r2.text();
    assert(r1.status === r2.status && c1 === c2,
      `respostas distinguíveis: ${r1.status}/${c1} vs ${r2.status}/${c2}`);
  });

  t("7. a leitura carrega id E user_id na MESMA query", async () => {
    reiniciar();
    await rotaPOST(req(LOJA_ML, { cds_session: tokenA }));
    const l = leituras();
    assert(l.length === 1, `esperava 1 leitura, houve ${l.length}`);
    assert(l[0].filtros.id === LOJA_ML, "perdeu o filtro de id");
    assert(l[0].filtros.user_id === UID_A, "🔴 leitura SEM filtro de dono");
  });

  secao("\n[3. projeção mínima]");

  t("8. projeção é EXATAMENTE as 5 colunas necessárias", async () => {
    reiniciar();
    await rotaPOST(req(LOJA_ML, { cds_session: tokenA }));
    const cols = leituras()[0].projecao.split(",").map(s => s.trim()).sort();
    assert(JSON.stringify(cols) === JSON.stringify(
      ["access_token", "id", "marketplace", "nickname", "nome"]),
      `🔴 projeção mudou: ${cols.join(", ")}`);
  });

  t("9. a projeção NÃO é select(\"*\")", async () => {
    reiniciar();
    await rotaPOST(req(LOJA_ML, { cds_session: tokenA }));
    assert(!/\*/.test(leituras()[0].projecao), "🔴 voltou a usar select(\"*\")");
  });

  for (const col of ["refresh_token", "partner_key", "token_expires_at"]) {
    t(`10.${col}: nunca entra na projeção`, async () => {
      reiniciar();
      await rotaPOST(req(LOJA_SHOPEE, { cds_session: tokenA }));
      assert(!leituras()[0].projecao.includes(col),
        `🔴 a ativação leu ${col}, que nunca usou`);
    });
  }

  t("11. seller_id, shop_id, user_id e created_at também ficam fora", async () => {
    reiniciar();
    await rotaPOST(req(LOJA_SHOPEE, { cds_session: tokenA }));
    const p = leituras()[0].projecao;
    for (const col of ["seller_id", "shop_id", "user_id", "created_at", "partner_id"]) {
      assert(!p.includes(col), `🔴 projetou ${col} sem necessidade`);
    }
  });

  t("12. a ativação NUNCA escreve em lojas", async () => {
    // O duplo lança em `.update()`/`.delete()`; aqui confirmamos o tipo.
    reiniciar();
    await rotaPOST(req(LOJA_ML, { cds_session: tokenA }));
    assert(consultas.every(c => c.tipo === "select"), "🔴 a ativação escreveu");
  });

  secao("\n[4. fronteira da capability]");

  const fsMod = await import("node:fs");
  const codigo = (caminho: string) =>
    fsMod.readFileSync(caminho, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");

  const ROTA = "app/api/lojas/ativar/route.ts";

  t("13. a rota não constrói cliente Supabase nem usa a chave anon", async () => {
    const fonte = codigo(ROTA);
    assert(!/createClient/.test(fonte), "🔴 a rota cria cliente próprio");
    assert(!/NEXT_PUBLIC_SUPABASE_ANON_KEY/.test(fonte), "🔴 a rota usa a chave anon");
    assert(!/@supabase\/supabase-js/.test(fonte), "🔴 a rota importa o SDK do Supabase");
  });

  t("14. a rota não acessa .from(\"lojas\")", async () => {
    assert(!/\.from\(/.test(codigo(ROTA)), "🔴 a rota monta query direta");
  });

  t("15. a rota lê pela capability", async () => {
    assert(/lerLojaParaAtivacao/.test(codigo(ROTA)), "a rota não usa a capability");
  });

  const { lerLojaParaAtivacao } = await import("../lib/marketplace/credenciais");

  t("16. a capability exige os DOIS argumentos", async () => {
    assert(lerLojaParaAtivacao.length === 2,
      `🔴 aridade ${lerLojaParaAtivacao.length} permite chamada sem dono`);
  });

  t("17. argumento vazio não alcança o banco", async () => {
    for (const [loja, dono] of [[LOJA_ML, ""], ["", UID_A], ["", ""]] as [string, string][]) {
      reiniciar();
      const r = await lerLojaParaAtivacao(loja, dono);
      assert(r.loja === null && r.erro === null, `🔴 retornou algo para ${loja}/${dono}`);
      assert(consultas.length === 0, "🔴 argumento vazio chegou ao banco");
    }
  });

  t("18. a capability devolve só as 5 chaves, nunca a linha inteira", async () => {
    reiniciar();
    const { loja } = await lerLojaParaAtivacao(LOJA_SHOPEE, UID_A);
    assert(loja !== null, "não encontrou a loja");
    const chaves = Object.keys(loja!).sort();
    assert(JSON.stringify(chaves) === JSON.stringify(
      ["access_token", "id", "marketplace", "nickname", "nome"]),
      `🔴 objeto devolvido tem chaves demais: ${chaves.join(", ")}`);
  });

  secao("\n[5. contrato 404 vs 503]");

  t("19. loja null SEM erro -> 404", async () => {
    reiniciar();
    const r = await lerLojaParaAtivacao(LOJA_INEXISTENTE, UID_A);
    assert(r.loja === null && r.erro === null, "capability não devolveu {null,null}");
    const res = await rotaPOST(req(LOJA_INEXISTENTE, { cds_session: tokenA }));
    assert(res.status === 404, `esperado 404, veio ${res.status}`);
  });

  t("20. erro real de banco -> 503, nunca 404", async () => {
    reiniciar();
    erroDeBanco = { message: 'relation "lojas" does not exist' };
    const res = await rotaPOST(req(LOJA_ML, { cds_session: tokenA }));
    erroDeBanco = null;
    assert(res.status === 503, `🔴 erro de banco virou ${res.status}`);
  });

  t("21. no 503 nenhum cookie é emitido", async () => {
    reiniciar();
    erroDeBanco = { message: 'connection refused' };
    const res = await rotaPOST(req(LOJA_ML, { cds_session: tokenA }));
    erroDeBanco = null;
    assert(setCookies(res) === "", "🔴 emitiu cookie com o banco fora do ar");
  });

  t("22. a mensagem interna do banco NÃO vaza na resposta", async () => {
    reiniciar();
    erroDeBanco = { message: 'relation "lojas" does not exist' };
    const res = await rotaPOST(req(LOJA_ML, { cds_session: tokenA }));
    erroDeBanco = null;
    const texto = await res.text();
    assert(!/relation|does not exist|lojas/i.test(texto), `🔴 vazou detalhe do banco: ${texto}`);
    assert(!/erro_consulta_loja/.test(texto), "🔴 vazou o código interno da capability");
  });

  secao("\n[6. resposta]");

  t("23. resposta traz apenas metadata pública", async () => {
    reiniciar();
    const res = await rotaPOST(req(LOJA_ML, { cds_session: tokenA }));
    const corpo = await res.json();
    const chaves = Object.keys(corpo.loja).sort();
    assert(JSON.stringify(chaves) === JSON.stringify(["id", "marketplace", "nickname", "nome"]),
      `🔴 resposta mudou: ${chaves.join(", ")}`);
  });

  t("24. access_token NUNCA aparece no corpo da resposta", async () => {
    for (const alvo of [LOJA_ML, LOJA_SHOPEE, LOJA_ML_SEM_TOKEN]) {
      reiniciar();
      const res = await rotaPOST(req(alvo, { cds_session: tokenA }));
      const texto = await res.text();
      assert(!/<access>|access_token/.test(texto), `🔴 token no corpo de ${alvo}: ${texto}`);
    }
  });

  secao("\n[7. cookies — comportamento preservado]");

  t("25. Shopee emite shopee_loja_id", async () => {
    reiniciar();
    const sc = setCookies(await rotaPOST(req(LOJA_SHOPEE, { cds_session: tokenA })));
    assert(sc.includes(`shopee_loja_id=${LOJA_SHOPEE}`), `não emitiu shopee_loja_id: ${sc}`);
  });

  t("26. Shopee NUNCA emite ml_access_token", async () => {
    reiniciar();
    const sc = setCookies(await rotaPOST(req(LOJA_SHOPEE, { cds_session: tokenA })));
    assert(!sc.includes("ml_access_token"), "🔴 loja Shopee recebeu cookie de token do ML");
  });

  t("27. Shopee NÃO emite loja_ativa_id", async () => {
    reiniciar();
    const sc = setCookies(await rotaPOST(req(LOJA_SHOPEE, { cds_session: tokenA })));
    assert(!sc.includes("loja_ativa_id"), "🔴 Shopee derrubou a seleção do ML");
  });

  t("28. ML emite loja_ativa_id", async () => {
    reiniciar();
    const sc = setCookies(await rotaPOST(req(LOJA_ML, { cds_session: tokenA })));
    assert(sc.includes(`loja_ativa_id=${LOJA_ML}`), `não emitiu loja_ativa_id: ${sc}`);
  });

  t("29. ML COM access_token emite ml_access_token", async () => {
    reiniciar();
    const sc = setCookies(await rotaPOST(req(LOJA_ML, { cds_session: tokenA })));
    const linhaCookie = sc.split("\n").find(l => l.startsWith("ml_access_token=")) ?? "";
    assert(linhaCookie !== "", `não emitiu ml_access_token: ${sc}`);
    // O valor trafega percent-encoded (`<` → `%3C`), como já era antes.
    const valor = decodeURIComponent(linhaCookie.split(";")[0].slice("ml_access_token=".length));
    assert(valor === "<access>", `🔴 valor do token mudou: ${valor}`);
  });

  t("30. ML SEM access_token não emite ml_access_token, mas mantém loja_ativa_id", async () => {
    reiniciar();
    const sc = setCookies(await rotaPOST(req(LOJA_ML_SEM_TOKEN, { cds_session: tokenA })));
    assert(!sc.includes("ml_access_token"), "🔴 emitiu cookie de token vazio");
    assert(sc.includes(`loja_ativa_id=${LOJA_ML_SEM_TOKEN}`), "perdeu loja_ativa_id");
  });

  t("31. flags e maxAge preservados — ml_access_token", async () => {
    reiniciar();
    const sc = setCookies(await rotaPOST(req(LOJA_ML, { cds_session: tokenA })));
    const linhaCookie = sc.split("\n").find(l => l.startsWith("ml_access_token=")) ?? "";
    assert(/httponly/i.test(linhaCookie), "🔴 ml_access_token perdeu HttpOnly");
    assert(/max-age=21600/i.test(linhaCookie), `maxAge mudou: ${linhaCookie}`);
    assert(/samesite=lax/i.test(linhaCookie), "sameSite mudou");
    assert(/path=\//i.test(linhaCookie), "path mudou");
  });

  t("32. flags e maxAge preservados — loja_ativa_id e shopee_loja_id", async () => {
    reiniciar();
    const scML = setCookies(await rotaPOST(req(LOJA_ML, { cds_session: tokenA })));
    const cML = scML.split("\n").find(l => l.startsWith("loja_ativa_id=")) ?? "";
    assert(!/httponly/i.test(cML), "🔴 loja_ativa_id virou HttpOnly (a UI o lê)");
    assert(/max-age=2592000/i.test(cML), `maxAge de loja_ativa_id mudou: ${cML}`);

    reiniciar();
    const scSh = setCookies(await rotaPOST(req(LOJA_SHOPEE, { cds_session: tokenA })));
    const cSh = scSh.split("\n").find(l => l.startsWith("shopee_loja_id=")) ?? "";
    assert(!/httponly/i.test(cSh), "🔴 shopee_loja_id virou HttpOnly");
    assert(/max-age=2592000/i.test(cSh), `maxAge de shopee_loja_id mudou: ${cSh}`);
  });

  secao("\n[8. segurança]");

  const MARCADORES = /<refresh>|<partner-key>|refresh_token|partner_key|cds_session/i;

  t("33. nenhuma resposta contém credencial não pública", async () => {
    for (const alvo of [LOJA_ML, LOJA_SHOPEE, LOJA_ALHEIA, LOJA_INEXISTENTE]) {
      reiniciar();
      const texto = await (await rotaPOST(req(alvo, { cds_session: tokenA }))).text();
      assert(!MARCADORES.test(texto), `🔴 credencial na resposta de ${alvo}: ${texto}`);
    }
  });

  t("34. nenhum log contém credencial, nem no caminho de erro", async () => {
    reiniciar();
    erroDeBanco = { message: 'relation "lojas" does not exist' };
    await rotaPOST(req(LOJA_ML, { cds_session: tokenA }));
    erroDeBanco = null;
    const texto = logs.join("\n");
    assert(!MARCADORES.test(texto), `🔴 credencial no log: ${texto.slice(0, 200)}`);
    assert(!/<access>/.test(texto), "🔴 access_token no log");
  });

  // A mensagem crua do Postgres nomeia tabela, coluna, esquema e às
  // vezes detalhe de conexão. Log de produção é superfície de leitura
  // como qualquer outra — o texto do banco não pode chegar lá.
  const ERROS_DE_BANCO = [
    'relation "lojas" does not exist',
    'permission denied for table lojas',
    'could not connect to server: Connection refused (host=db.interno.local port=5432)',
  ];

  t("35. o texto cru do Postgres NÃO aparece no log", async () => {
    for (const mensagem of ERROS_DE_BANCO) {
      reiniciar();
      erroDeBanco = { message: mensagem };
      await rotaPOST(req(LOJA_ML, { cds_session: tokenA }));
      erroDeBanco = null;
      const texto = logs.join("\n");
      assert(!texto.includes(mensagem), `🔴 mensagem crua no log: ${mensagem}`);
      // Fragmentos distintivos, um a um. "loja" solto NÃO entra na lista:
      // a mensagem estática legítima contém a palavra.
      for (const trecho of ["relation", "does not exist", '"lojas"', "permission denied",
                            "Connection refused", "db.interno.local", "5432", "port="]) {
        assert(!texto.includes(trecho), `🔴 fragmento do banco no log: "${trecho}" em ${texto}`);
      }
    }
  });

  t("36. o texto cru do Postgres NÃO aparece na resposta", async () => {
    for (const mensagem of ERROS_DE_BANCO) {
      reiniciar();
      erroDeBanco = { message: mensagem };
      const texto = await (await rotaPOST(req(LOJA_ML, { cds_session: tokenA }))).text();
      erroDeBanco = null;
      assert(!texto.includes(mensagem), `🔴 mensagem crua na resposta: ${mensagem}`);
      for (const trecho of ["relation", "does not exist", "permission denied",
                            "Connection refused", "db.interno.local", "5432"]) {
        assert(!texto.includes(trecho), `🔴 fragmento do banco na resposta: "${trecho}"`);
      }
    }
  });

  t("37. o log de erro não identifica o tenant (nem lojaId, nem userId)", async () => {
    reiniciar();
    erroDeBanco = { message: 'relation "lojas" does not exist' };
    await rotaPOST(req(LOJA_ML, { cds_session: tokenA }));
    erroDeBanco = null;
    const texto = logs.join("\n");
    assert(!texto.includes(LOJA_ML), "🔴 lojaId no log");
    assert(!texto.includes(UID_A), "🔴 userId no log");
    assert(!texto.includes(tokenA), "🔴 token de sessão no log");
  });

  t("38. o log de erro é uma linha ESTÁTICA — igual para erros diferentes", async () => {
    const capturas: string[] = [];
    for (const mensagem of ERROS_DE_BANCO) {
      reiniciar();
      erroDeBanco = { message: mensagem };
      await rotaPOST(req(LOJA_ML, { cds_session: tokenA }));
      erroDeBanco = null;
      capturas.push(logs.join("\n"));
    }
    assert(capturas.every(c => c === capturas[0]),
      `🔴 o log varia com o erro do banco — logo carrega conteúdo dele:\n${capturas.join("\n---\n")}`);
    assert(capturas[0].trim() !== "", "o caminho de erro deixou de registrar qualquer coisa");
  });

  await fila;
  imprimir(`\n=== RESULTADO: ${ok} passaram, ${falhou} falharam ===\n`);
  if (falhou > 0) process.exit(1);
}

void principal();
