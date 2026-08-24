/**
 * Capability de perfil — PERFIL-SENHA1a.
 *
 * ── O que esta suíte fecha ──────────────────────────────────────────
 * Medido em produção: `anon` tinha SELECT, INSERT e UPDATE em
 * `public.perfil`, tabela sem RLS. A chave anon é pública — vai no
 * bundle do navegador. Qualquer visitante lia a senha de todos, criava
 * perfis e editava perfis alheios.
 *
 * ── O que estes testes provam ───────────────────────────────────────
 * O EFEITO, não o texto: o duplo do Supabase registra cada projeção,
 * cada `.eq()` e cada payload. Perder o filtro `user_uuid` no UPDATE,
 * projetar `senha` onde não deve, ou aceitar campo fora da lista
 * fechada quebra aqui.
 *
 * ESCOPO: esta PR é migração de PRIVILÉGIO. `senha` continua plaintext
 * e continua comparada na rota de login — hash é a PERFIL-SENHA1b.
 * Os testes travam o comportamento ATUAL para provar que a migração
 * não o alterou.
 *
 * Sem rede, sem banco: todos os valores são marcadores em `<colchetes>`.
 *
 * Uso: npx tsx scripts/testar-perfil-capability.ts
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
process.env.RESEND_API_KEY ??= "chave-de-teste-invalida";

const UUID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UUID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKEN_VERIF = "token-de-verificacao-a";

interface Linha {
  id: number; nome_completo: string | null; usuario: string | null;
  email: string | null; documento: string | null; senha: string | null;
  email_verificado: boolean | null; token_verificacao: string | null;
  token_expiracao: string | null; user_uuid: string | null;
}

let linhas: Linha[] = [];

function semear() {
  linhas = [
    { id: 1, nome_completo: "Usuário A", usuario: "usera", email: "a@exemplo.test",
      documento: "<doc-a>", senha: "<senha-a>", email_verificado: true,
      token_verificacao: null, token_expiracao: null, user_uuid: UUID_A },
    { id: 2, nome_completo: "Usuário B", usuario: "userb", email: "b@exemplo.test",
      documento: "<doc-b>", senha: "<senha-b>", email_verificado: true,
      token_verificacao: null, token_expiracao: null, user_uuid: UUID_B },
    { id: 3, nome_completo: "Não verificado", usuario: "userc", email: "c@exemplo.test",
      documento: null, senha: "<senha-c>", email_verificado: false,
      token_verificacao: TOKEN_VERIF, token_expiracao: "2099-01-01T00:00:00Z", user_uuid: "cccc" },
  ];
}

interface Consulta {
  tabela: string; tipo: "select" | "update" | "insert";
  projecao: string; filtros: Record<string, unknown>; payload: Record<string, unknown>;
}
let consultas: Consulta[] = [];
let erroDeBanco: { message: string } | null = null;

/** `.eq()` e `.ilike()` — o segundo compara sem diferenciar caixa. */
function casa(l: Linha, filtros: Record<string, unknown>, ilike: Set<string>) {
  return Object.entries(filtros).every(([c, v]) => {
    const atual = (l as any)[c];
    if (ilike.has(c)) {
      return String(atual ?? "").toLowerCase() === String(v ?? "").toLowerCase();
    }
    return atual === v;
  });
}

function projetar(l: Linha, projecao: string): Record<string, unknown> {
  if (projecao.trim() === "*") return { ...l };
  const saida: Record<string, unknown> = {};
  for (const c of projecao.split(",").map(s => s.trim()).filter(Boolean)) saida[c] = (l as any)[c];
  return saida;
}

let proximoId = 100;

function clienteFalso() {
  const criarCadeia = (tabela: string) => {
    const filtros: Record<string, unknown> = {};
    const ilike = new Set<string>();
    let tipo: "select" | "update" | "insert" = "select";
    let projecao = "*";
    let payload: Record<string, unknown> = {};
    const executar = () => {
      consultas.push({ tabela, tipo, projecao, filtros: { ...filtros }, payload: { ...payload } });
      if (erroDeBanco) return { data: null, error: erroDeBanco };
      if (tipo === "insert") {
        const nova = { id: ++proximoId, ...payload } as any;
        linhas.push(nova);
        return { data: [projetar(nova, projecao)], error: null };
      }
      const alvo = linhas.filter(l => casa(l, filtros, ilike));
      if (tipo === "update") for (const l of alvo) Object.assign(l, payload);
      return { data: alvo.map(l => projetar(l, projecao)), error: null };
    };
    const cadeia: any = {
      select: (p?: string) => { projecao = p ?? "*"; return cadeia; },
      update: (p: Record<string, unknown>) => { tipo = "update"; payload = p; return cadeia; },
      insert: (p: Record<string, unknown>) => { tipo = "insert"; payload = p; return cadeia; },
      upsert: () => { throw new Error("🔴 usou upsert em `perfil`"); },
      delete: () => { throw new Error("🔴 usou delete em `perfil`"); },
      eq: (c: string, v: unknown) => { filtros[c] = v; return cadeia; },
      ilike: (c: string, v: unknown) => { filtros[c] = v; ilike.add(c); return cadeia; },
      maybeSingle: async () => { const r = executar(); return { data: (r.data as any[])?.[0] ?? null, error: r.error }; },
      single: async () => {
        const r = executar();
        const l0 = (r.data as any[])?.[0] ?? null;
        // Semântica real do PostgREST: zero linhas é ERRO em `single()`.
        if (!r.error && !l0) return { data: null, error: { message: "PGRST116: no rows" } };
        return { data: l0, error: r.error };
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
  // O reenvio de verificação dispara email — neutralizado aqui.
  if (id === "resend") return { Resend: class { emails = { send: async () => ({}) }; } };
  return requireOriginal.apply(this, arguments as any);
};

globalThis.fetch = (async (url: any) => {
  throw new Error(`teste tentou acessar a rede: ${String(url)}`);
}) as any;

let logs: string[] = [];
const coletar = (...a: any[]) => { logs.push(a.map(x => String(x)).join(" ")); };

function reiniciar() { semear(); consultas = []; erroDeBanco = null; logs = []; }

const linha = (id: number) => linhas.find(l => l.id === id);
const escritas = () => consultas.filter(c => c.tipo !== "select");
const leituras = () => consultas.filter(c => c.tipo === "select");

let loginPOST: any, mePOST: any, verificarGET: any, verificarPOST: any, perfilGET: any, perfilPOST: any;
let tokenA = "";

function req(url: string, opcoes: { corpo?: any; cookie?: string; metodo?: string } = {}) {
  return new Request(url, {
    method: opcoes.metodo ?? (opcoes.corpo !== undefined ? "POST" : "GET"),
    headers: {
      "content-type": "application/json",
      ...(opcoes.cookie ? { cookie: opcoes.cookie } : {}),
    },
    ...(opcoes.corpo !== undefined ? { body: JSON.stringify(opcoes.corpo) } : {}),
  });
}

async function principal() {
  console.log = coletar;
  console.error = coletar;

  ({ POST: loginPOST } = await import("../app/api/auth/login/route") as any);
  ({ GET: mePOST } = await import("../app/api/auth/me/route") as any);
  ({ GET: verificarGET, POST: verificarPOST } = await import("../app/api/auth/verificar-email/route") as any);
  ({ GET: perfilGET, POST: perfilPOST } = await import("../app/api/perfil/route") as any);
  const auth = await import("../lib/autenticacao");
  const cap = await import("../lib/perfil/credenciais");
  tokenA = (await auth.emitirTokenSessao(UUID_A)).token;

  secao("\n[1. fronteira — nenhuma rota toca `perfil` direto]");

  const fs = await import("node:fs");
  const codigo = (c: string) =>
    fs.readFileSync(c, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  const ROTAS = [
    ["login", "app/api/auth/login/route.ts"],
    ["me", "app/api/auth/me/route.ts"],
    ["verificar-email", "app/api/auth/verificar-email/route.ts"],
    ["api/perfil", "app/api/perfil/route.ts"],
  ] as const;

  for (const [nome, caminho] of ROTAS) {
    t(`1.${nome}: sem createClient e sem ANON_KEY`, async () => {
      const src = codigo(caminho);
      assert(!/createClient/.test(src), "🔴 cria cliente próprio");
      assert(!/NEXT_PUBLIC_SUPABASE_ANON_KEY/.test(src), "🔴 usa a chave anon");
      assert(!/@supabase\/supabase-js/.test(src), "🔴 importa o SDK");
    });
    t(`2.${nome}: sem .from("perfil") direto`, async () => {
      assert(!/\.from\("perfil"\)/.test(codigo(caminho)), "🔴 monta query direta");
    });
  }

  t("3. a capability é server-only e usa service_role", async () => {
    const src = codigo("lib/perfil/credenciais.ts");
    assert(/import "server-only"/.test(src), "🔴 perdeu a barreira server-only");
    assert(/getSupabaseServidor\(\)/.test(src), "não usa getSupabaseServidor");
    assert(!/NEXT_PUBLIC_SUPABASE_ANON_KEY/.test(src), "🔴 a capability usa chave anon");
    assert(!/createClient/.test(src), "🔴 a capability cria cliente próprio");
  });

  t("4. a capability não expõe nem aceita SupabaseClient", async () => {
    const src = codigo("lib/perfil/credenciais.ts");
    assert(!/:\s*SupabaseClient/.test(src), "🔴 recebe SupabaseClient como parâmetro");
    assert(!/export .*SupabaseClient/.test(src), "🔴 exporta SupabaseClient");
  });

  t("5. a capability nunca usa select(\"*\")", async () => {
    assert(!/\.select\(\s*["'`]\s*\*\s*["'`]\s*\)/.test(codigo("lib/perfil/credenciais.ts")),
      "🔴 projeção aberta");
  });

  secao("\n[2. login — comportamento preservado]");

  t("6. login correto devolve ok e emite cookie de sessão", async () => {
    reiniciar();
    const res = await loginPOST(req("https://x.test/api/auth/login",
      { corpo: { email: "a@exemplo.test", senha: "<senha-a>" } }));
    assert(res.status === 200, `esperado 200, veio ${res.status}`);
    assert((await res.json()).ok === true, "não devolveu ok");
    assert((res.headers.get("set-cookie") ?? "").includes("cds_session"), "não emitiu sessão");
  });

  t("7. email é case-insensitive (ilike preservado)", async () => {
    reiniciar();
    const res = await loginPOST(req("https://x.test/api/auth/login",
      { corpo: { email: "A@EXEMPLO.TEST", senha: "<senha-a>" } }));
    assert(res.status === 200, `🔴 perdeu o ilike: ${res.status}`);
  });

  t("8. senha errada -> 401 (comportamento atual preservado)", async () => {
    reiniciar();
    const res = await loginPOST(req("https://x.test/api/auth/login",
      { corpo: { email: "a@exemplo.test", senha: "errada" } }));
    assert(res.status === 401, `esperado 401, veio ${res.status}`);
  });

  t("9. usuário inexistente -> 401 (enumeração corrigida na 1b)", async () => {
    // Na 1a este teste exigia 404, travando o comportamento de então.
    // A PERFIL-SENHA1b corrigiu a enumeração: inexistente e senha errada
    // passam a devolver o MESMO 401. A cobertura profunda desse contrato
    // está em testar-autenticacao-senha.ts (testes 21–24).
    reiniciar();
    const res = await loginPOST(req("https://x.test/api/auth/login",
      { corpo: { email: "ninguem@exemplo.test", senha: "x" } }));
    assert(res.status === 401, `🔴 esperado 401, veio ${res.status}`);
  });

  t("10. login projeta apenas as 7 colunas necessárias", async () => {
    // `senha_hash` entrou na PERFIL-SENHA1b — é o campo que decide entre
    // o caminho de hash e o legado. `senha` permanece enquanto houver
    // conta não migrada.
    reiniciar();
    await loginPOST(req("https://x.test/api/auth/login",
      { corpo: { email: "a@exemplo.test", senha: "<senha-a>" } }));
    const cols = leituras()[0].projecao.split(",").map(s => s.trim()).sort();
    assert(JSON.stringify(cols) === JSON.stringify(
      ["email", "email_verificado", "id", "nome_completo", "senha", "senha_hash", "user_uuid"]),
      `🔴 projeção mudou: ${cols.join(", ")}`);
  });

  t("11. email não verificado -> 403 preservado", async () => {
    reiniciar();
    const res = await loginPOST(req("https://x.test/api/auth/login",
      { corpo: { email: "c@exemplo.test", senha: "<senha-c>" } }));
    assert(res.status === 403, `esperado 403, veio ${res.status}`);
  });

  t("12. user_uuid ausente é gerado e gravado", async () => {
    reiniciar();
    linha(1)!.user_uuid = null;
    const res = await loginPOST(req("https://x.test/api/auth/login",
      { corpo: { email: "a@exemplo.test", senha: "<senha-a>" } }));
    assert(res.status === 200, `esperado 200, veio ${res.status}`);
    assert(typeof linha(1)!.user_uuid === "string" && linha(1)!.user_uuid!.length > 10,
      "🔴 não gravou o user_uuid");
    const w = escritas();
    assert(w.length === 1 && Object.keys(w[0].payload).join() === "user_uuid",
      `🔴 escreveu além do user_uuid: ${Object.keys(w[0].payload).join()}`);
  });

  secao("\n[3. auth/me]");

  t("13. sessão válida devolve os 3 campos, sem senha", async () => {
    reiniciar();
    const res = await mePOST(req("https://x.test/api/auth/me", { cookie: `cds_session=${tokenA}` }));
    assert(res.status === 200, `esperado 200, veio ${res.status}`);
    const corpo = await res.json();
    assert(JSON.stringify(Object.keys(corpo).sort()) === JSON.stringify(["email", "nome", "userId"]),
      `🔴 resposta mudou: ${Object.keys(corpo).join()}`);
    assert(leituras()[0].projecao === "user_uuid, nome_completo, email", "projeção mudou");
  });

  t("14. sem sessão -> 401 sem tocar o banco", async () => {
    reiniciar();
    const res = await mePOST(req("https://x.test/api/auth/me"));
    assert(res.status === 401, `esperado 401, veio ${res.status}`);
    assert(consultas.length === 0, "🔴 consultou sem sessão");
  });

  t("15. sessão de perfil inexistente -> 401", async () => {
    reiniciar();
    const auth2 = await import("../lib/autenticacao");
    // `emitirTokenSessao` exige UUID válido — a sessão é bem-formada,
    // o que não existe é o perfil correspondente.
    const tk = (await auth2.emitirTokenSessao("dddddddd-dddd-4ddd-8ddd-dddddddddddd")).token;
    const res = await mePOST(req("https://x.test/api/auth/me", { cookie: `cds_session=${tk}` }));
    assert(res.status === 401, `esperado 401, veio ${res.status}`);
  });

  secao("\n[4. verificação de email — fluxo sem sessão]");

  t("16. token válido verifica e QUEIMA o token", async () => {
    reiniciar();
    const res = await verificarGET(req(`https://x.test/api/auth/verificar-email?token=${TOKEN_VERIF}`));
    assert(res.status === 200, `esperado 200, veio ${res.status}`);
    const l = linha(3)!;
    assert(l.email_verificado === true, "não marcou verificado");
    assert(l.token_verificacao === null && l.token_expiracao === null,
      "🔴 token sobreviveu ao uso — deixaria de ser de uso único");
  });

  t("17. token inexistente -> 400", async () => {
    reiniciar();
    const res = await verificarGET(req("https://x.test/api/auth/verificar-email?token=nao-existe"));
    assert(res.status === 400, `esperado 400, veio ${res.status}`);
  });

  t("18. token expirado -> 400 e NÃO verifica", async () => {
    reiniciar();
    linha(3)!.token_expiracao = "2000-01-01T00:00:00Z";
    const res = await verificarGET(req(`https://x.test/api/auth/verificar-email?token=${TOKEN_VERIF}`));
    assert(res.status === 400, `esperado 400, veio ${res.status}`);
    assert(linha(3)!.email_verificado === false, "🔴 verificou com token expirado");
  });

  t("19. reenvio grava novo token, só as 2 colunas", async () => {
    reiniciar();
    const res = await verificarPOST(req("https://x.test/api/auth/verificar-email",
      { corpo: { email: "c@exemplo.test" } }));
    assert(res.status === 200, `esperado 200, veio ${res.status}`);
    const w = escritas();
    assert(w.length === 1, `esperava 1 escrita, houve ${w.length}`);
    const chaves = Object.keys(w[0].payload).sort();
    assert(JSON.stringify(chaves) === JSON.stringify(["token_expiracao", "token_verificacao"]),
      `🔴 escreveu além do token: ${chaves.join()}`);
  });

  t("20. reenvio para email inexistente -> 404", async () => {
    reiniciar();
    const res = await verificarPOST(req("https://x.test/api/auth/verificar-email",
      { corpo: { email: "ninguem@exemplo.test" } }));
    assert(res.status === 404, `esperado 404, veio ${res.status}`);
  });

  secao("\n[5. api/perfil — GET, criação, edição]");

  t("21. GET projeta 7 campos e NUNCA senha", async () => {
    reiniciar();
    const res = await perfilGET(req("https://x.test/api/perfil", { cookie: `cds_session=${tokenA}` }));
    assert(res.status === 200, `esperado 200, veio ${res.status}`);
    const texto = JSON.stringify(await res.json());
    assert(!/senha|<senha-a>/.test(texto), `🔴 senha na resposta: ${texto}`);
    assert(!leituras()[0].projecao.includes("senha"), "🔴 projetou senha");
  });

  t("22. GET sem sessão -> 401 sem tocar o banco", async () => {
    reiniciar();
    const res = await perfilGET(req("https://x.test/api/perfil"));
    assert(res.status === 401, `esperado 401, veio ${res.status}`);
    assert(consultas.length === 0, "🔴 consultou sem sessão");
  });

  t("23. GET com erro de banco -> 503, nunca 200", async () => {
    reiniciar();
    erroDeBanco = { message: 'relation "perfil" does not exist' };
    const res = await perfilGET(req("https://x.test/api/perfil", { cookie: `cds_session=${tokenA}` }));
    erroDeBanco = null;
    assert(res.status === 503, `🔴 erro de banco virou ${res.status}`);
    const texto = await res.text();
    assert(!/relation|does not exist/.test(texto), "🔴 vazou detalhe do banco");
  });

  t("24. GET de perfil ausente -> 200 com {} (ausência legítima)", async () => {
    reiniciar();
    const auth2 = await import("../lib/autenticacao");
    const tk = (await auth2.emitirTokenSessao("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee")).token;
    const res = await perfilGET(req("https://x.test/api/perfil", { cookie: `cds_session=${tk}` }));
    assert(res.status === 200, `esperado 200, veio ${res.status}`);
    assert(JSON.stringify(await res.json()) === "{}", "não devolveu objeto vazio");
  });

  t("25. criação grava exatamente os 10 campos esperados", async () => {
    reiniciar();
    const res = await perfilPOST(req("https://x.test/api/perfil", {
      corpo: { _novaConta: true, nome_completo: "Novo", usuario: "novo",
               email: "novo@exemplo.test", documento: "<doc>", senha: "<senha-nova>" },
    }));
    assert(res.status === 200, `esperado 200, veio ${res.status}`);
    const w = escritas().filter(c => c.tipo === "insert");
    assert(w.length === 1, `esperava 1 insert, houve ${w.length}`);
    const chaves = Object.keys(w[0].payload).sort();
    // PERFIL-SENHA1b: `senha_hash` entrou e `senha` continua na lista —
    // mas agora gravada como `null` explícito (ver teste 25b).
    assert(JSON.stringify(chaves) === JSON.stringify(
      ["documento", "email", "email_verificado", "nome_completo", "senha", "senha_hash",
       "token_expiracao", "token_verificacao", "user_uuid", "usuario"]),
      `🔴 payload mudou: ${chaves.join(", ")}`);
  });

  t("25b. a criação NUNCA grava plaintext — senha entra como null", async () => {
    reiniciar();
    await perfilPOST(req("https://x.test/api/perfil", {
      corpo: { _novaConta: true, nome_completo: "Novo", usuario: "novo",
               email: "novo2@exemplo.test", documento: "<doc>", senha: "<senha-nova>" },
    }));
    const p = escritas().find(c => c.tipo === "insert")!.payload;
    assert(p.senha === null, `🔴 gravou plaintext: ${p.senha}`);
    assert(typeof p.senha_hash === "string" && (p.senha_hash as string).startsWith("$argon2id$"),
      "🔴 não gravou hash Argon2id");
  });

  t("26. criação força email_verificado=false, mesmo se o cliente mandar true", async () => {
    reiniciar();
    await perfilPOST(req("https://x.test/api/perfil", {
      corpo: { _novaConta: true, nome_completo: "X", email: "y@exemplo.test",
               senha: "<s>", email_verificado: true },
    }));
    const ins = escritas().find(c => c.tipo === "insert")!;
    assert(ins.payload.email_verificado === false,
      "🔴 aceitou email_verificado do corpo — burlaria a verificação");
  });

  t("27. email duplicado -> 409 sem inserir", async () => {
    reiniciar();
    const res = await perfilPOST(req("https://x.test/api/perfil", {
      corpo: { _novaConta: true, nome_completo: "X", email: "a@exemplo.test", senha: "<s>" },
    }));
    assert(res.status === 409, `esperado 409, veio ${res.status}`);
    assert(escritas().length === 0, "🔴 inseriu apesar da duplicidade");
  });

  secao("\n[6. tenant isolation na edição]");

  t("28. UPDATE carrega user_uuid no filtro da PRÓPRIA escrita", async () => {
    reiniciar();
    await perfilPOST(req("https://x.test/api/perfil",
      { corpo: { nome_completo: "Renomeado" }, cookie: `cds_session=${tokenA}` }));
    const w = escritas();
    assert(w.length === 1 && w[0].tipo === "update", `escritas: ${w.length}`);
    assert(w[0].filtros.user_uuid === UUID_A, "🔴 UPDATE SEM filtro de dono");
  });

  t("29. usuário A não altera o perfil de B", async () => {
    reiniciar();
    await perfilPOST(req("https://x.test/api/perfil",
      { corpo: { nome_completo: "Invadido" }, cookie: `cds_session=${tokenA}` }));
    assert(linha(2)!.nome_completo === "Usuário B", "🔴 alterou o perfil alheio");
    // `reiniciar()` re-semeia, então o valor esperado é o desta rodada.
    assert(linha(1)!.nome_completo === "Invadido", "não alterou o próprio");
  });

  t("30. UPDATE ignora campos fora da lista fechada", async () => {
    reiniciar();
    await perfilPOST(req("https://x.test/api/perfil", {
      corpo: {
        nome_completo: "Ok",
        user_uuid: UUID_B,              // sequestro de identidade
        email_verificado: true,          // burlar verificação
        token_verificacao: "forjado",    // forjar link de verificação
        id: 999,
      },
      cookie: `cds_session=${tokenA}`,
    }));
    const p = escritas()[0].payload;
    for (const proibido of ["user_uuid", "email_verificado", "token_verificacao", "id"]) {
      assert(!(proibido in p), `🔴 aceitou campo proibido: ${proibido}`);
    }
    assert(linha(1)!.user_uuid === UUID_A, "🔴 sequestrou o user_uuid");
  });

  t("31. edição sem sessão -> 401 sem escrever", async () => {
    reiniciar();
    const res = await perfilPOST(req("https://x.test/api/perfil", { corpo: { nome_completo: "X" } }));
    assert(res.status === 401, `esperado 401, veio ${res.status}`);
    assert(escritas().length === 0, "🔴 escreveu sem sessão");
  });

  t("32. erro de banco na edição -> 500, nunca ok", async () => {
    reiniciar();
    erroDeBanco = { message: 'permission denied for table perfil' };
    const res = await perfilPOST(req("https://x.test/api/perfil",
      { corpo: { nome_completo: "X" }, cookie: `cds_session=${tokenA}` }));
    erroDeBanco = null;
    assert(res.status === 500, `esperado 500, veio ${res.status}`);
    const texto = await res.text();
    // "perfil" sozinho não serve: a mensagem pública legítima é
    // "Não foi possível salvar o perfil.". Miro no texto CRU do banco.
    assert(!/permission denied|for table/.test(texto), `🔴 vazou detalhe: ${texto}`);
  });

  secao("\n[7. senha nunca vaza]");

  const MARCADORES = /<senha-a>|<senha-b>|<senha-c>|<senha-nova>/;

  t("33. nenhuma resposta fora do login carrega senha", async () => {
    const casos: Array<() => Promise<Response>> = [
      () => mePOST(req("https://x.test/api/auth/me", { cookie: `cds_session=${tokenA}` })),
      () => perfilGET(req("https://x.test/api/perfil", { cookie: `cds_session=${tokenA}` })),
      () => verificarGET(req(`https://x.test/api/auth/verificar-email?token=${TOKEN_VERIF}`)),
    ];
    for (const chamar of casos) {
      reiniciar();
      const texto = await (await chamar()).text();
      assert(!MARCADORES.test(texto) && !/"senha"/.test(texto), `🔴 senha na resposta: ${texto}`);
    }
  });

  t("34. o login também não devolve senha na resposta", async () => {
    reiniciar();
    const texto = await (await loginPOST(req("https://x.test/api/auth/login",
      { corpo: { email: "a@exemplo.test", senha: "<senha-a>" } }))).text();
    assert(!MARCADORES.test(texto), `🔴 senha ecoada: ${texto}`);
  });

  t("35. nenhum log contém senha, em nenhum caminho de erro", async () => {
    for (const preparar of [
      () => { erroDeBanco = { message: 'relation "perfil" does not exist' }; },
      () => { erroDeBanco = null; },
    ]) {
      reiniciar();
      preparar();
      await loginPOST(req("https://x.test/api/auth/login",
        { corpo: { email: "a@exemplo.test", senha: "<senha-a>" } }));
      await perfilPOST(req("https://x.test/api/perfil",
        { corpo: { senha: "<senha-nova>" }, cookie: `cds_session=${tokenA}` }));
      erroDeBanco = null;
      const texto = logs.join("\n");
      assert(!MARCADORES.test(texto), `🔴 senha no log: ${texto.slice(0, 200)}`);
      assert(!/senha=|"senha"/.test(texto), `🔴 body com senha no log: ${texto.slice(0, 200)}`);
    }
  });

  t("36. o texto cru do Postgres não aparece no log", async () => {
    reiniciar();
    erroDeBanco = { message: 'could not connect (host=db.interno port=5432)' };
    await perfilGET(req("https://x.test/api/perfil", { cookie: `cds_session=${tokenA}` }));
    erroDeBanco = null;
    const texto = logs.join("\n");
    for (const frag of ["could not connect", "db.interno", "5432", "host="]) {
      assert(!texto.includes(frag), `🔴 fragmento do banco no log: ${frag}`);
    }
  });

  secao("\n[8. capability — contrato direto]");

  t("37. argumento vazio nunca alcança o banco", async () => {
    reiniciar();
    await cap.lerCredencialDeLogin("");
    await cap.lerPerfilDaSessao("");
    await cap.lerPerfilDoDono("");
    await cap.lerPerfilPorTokenVerificacao("");
    await cap.lerPerfilPorEmailParaReenvio("");
    await cap.emailJaCadastrado("");
    assert(consultas.length === 0, "🔴 argumento vazio chegou ao banco");
  });

  t("38. atualizarPerfilDoDono sem dono não escreve", async () => {
    reiniciar();
    const r = await cap.atualizarPerfilDoDono("", { nome_completo: "X" });
    assert(r.atualizado === false && r.erro !== null, "🔴 aceitou escrita sem dono");
    assert(consultas.length === 0, "🔴 tocou o banco sem dono");
  });

  t("39. gravarUserUuid e marcarEmailVerificado exigem id", async () => {
    reiniciar();
    assert((await cap.gravarUserUuid(0, "x")) === false, "aceitou id zero");
    assert((await cap.marcarEmailVerificado(0)) === false, "aceitou id zero");
    assert((await cap.gravarTokenVerificacao(0, "t", "e")) === false, "aceitou id zero");
    assert(consultas.length === 0, "🔴 tocou o banco sem id");
  });

  t("40. só lerCredencialDeLogin projeta a coluna senha", async () => {
    const src = codigo("lib/perfil/credenciais.ts");
    const projecoes = src.match(/const COLUNAS_[A-Z]+ = "[^"]+"/g) ?? [];
    const comSenha = projecoes.filter(p => /\bsenha\b/.test(p));
    assert(comSenha.length === 1, `🔴 ${comSenha.length} projeções trazem senha: ${comSenha.join(" | ")}`);
    assert(/COLUNAS_LOGIN/.test(comSenha[0]), `🔴 a projeção com senha não é a do login: ${comSenha[0]}`);
  });

  secao("\n[9. guarda global]");

  t("41. nenhum runtime toca `perfil` fora da capability", async () => {
    const CAP = "lib/perfil/credenciais.ts";
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) out.push(...walk(p));
        else if (/\.tsx?$/.test(e.name)) out.push(p);
      }
      return out;
    };
    const alvos = [...walk("app"), ...walk("lib")].filter(p => p !== CAP);
    // Regra simples de propósito: QUALQUER `.from("perfil")` fora da
    // capability reprova. Sem janela de distância, sem lista manual —
    // é o que evita o ponto cego da guarda 91 (lojas).
    const infratores = alvos.filter(p => /\.from\("perfil"\)/.test(codigo(p)));
    assert(infratores.length === 0, `🔴 acesso direto: ${infratores.join(" | ")}`);
    assert(alvos.length > 100, `varredura suspeita: só ${alvos.length} arquivos`);
  });

  await fila;
  imprimir(`\n=== RESULTADO: ${ok} passaram, ${falhou} falharam ===\n`);
  if (falhou > 0) process.exit(1);
}

void principal();
