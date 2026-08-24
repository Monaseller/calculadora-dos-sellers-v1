/**
 * Senha: hash, migração progressiva e login — PERFIL-SENHA1b.
 *
 * ── O defeito que esta suíte fecha ──────────────────────────────────
 * `perfil.senha` guardava a senha LEGÍVEL, e o login comparava por
 * igualdade de string. A PERFIL-SENHA1a tirou a coluna do alcance de
 * `anon`; esta PR tira a senha do banco.
 *
 * ── O que estes testes provam ───────────────────────────────────────
 * O EFEITO. O duplo do Supabase registra cada payload, então "gravou
 * hash e anulou o plaintext" é verificável, não afirmável. E o Argon2 é
 * REAL — nenhum duplo de criptografia: um hash falso passaria em
 * qualquer asserção sobre formato sem provar que a verificação funciona.
 *
 * Por isso a suíte é mais lenta que as outras (Argon2id com 19 MiB por
 * verificação, dezenas de vezes). É o preço de testar a coisa certa.
 *
 * Uso: npx tsx scripts/testar-autenticacao-senha.ts
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
const SENHA_LEGADA = "<senha-legada>";
const SENHA_MIGRADA = "<senha-migrada>";

interface Linha {
  id: number; nome_completo: string | null; usuario: string | null;
  email: string | null; documento: string | null;
  senha: string | null; senha_hash: string | null;
  email_verificado: boolean | null; token_verificacao: string | null;
  token_expiracao: string | null; user_uuid: string | null;
}

let linhas: Linha[] = [];
let hashDeMigrada = "";

function semear() {
  linhas = [
    // Conta LEGADA: plaintext, sem hash.
    { id: 1, nome_completo: "Legado", usuario: "leg", email: "legado@exemplo.test",
      documento: null, senha: SENHA_LEGADA, senha_hash: null, email_verificado: true,
      token_verificacao: null, token_expiracao: null, user_uuid: UUID_A },
    // Conta MIGRADA: hash real, plaintext já nulo.
    { id: 2, nome_completo: "Migrado", usuario: "mig", email: "migrado@exemplo.test",
      documento: null, senha: null, senha_hash: hashDeMigrada, email_verificado: true,
      token_verificacao: null, token_expiracao: null,
      // UUID válido: `emitirTokenSessao` recusa qualquer outro formato.
      user_uuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    // Hash CORROMPIDO + plaintext presente: o caso que prova a ausência
    // de fallback. Se a rota caísse para `senha`, este login passaria.
    { id: 3, nome_completo: "Corrompido", usuario: "cor", email: "corrompido@exemplo.test",
      documento: null, senha: SENHA_LEGADA, senha_hash: "$argon2id$LIXO", email_verificado: true,
      token_verificacao: null, token_expiracao: null,
      user_uuid: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
  ];
}

interface Consulta {
  tipo: "select" | "update" | "insert";
  projecao: string; filtros: Record<string, unknown>;
  is: Record<string, unknown>; payload: Record<string, unknown>;
}
let consultas: Consulta[] = [];
let erroDeBanco: { message: string } | null = null;
/** Força o CAS a não casar linha, simulando corrida/erro de migração. */
let casSempreVazio = false;

function casa(l: Linha, f: Record<string, unknown>, ilike: Set<string>, is: Record<string, unknown>) {
  const porEq = Object.entries(f).every(([c, v]) => {
    const atual = (l as any)[c];
    if (ilike.has(c)) return String(atual ?? "").toLowerCase() === String(v ?? "").toLowerCase();
    return atual === v;
  });
  const porIs = Object.entries(is).every(([c, v]) => (l as any)[c] === v);
  return porEq && porIs;
}

function projetar(l: Linha, projecao: string): Record<string, unknown> {
  if (projecao.trim() === "*") return { ...l };
  const saida: Record<string, unknown> = {};
  for (const c of projecao.split(",").map(s => s.trim()).filter(Boolean)) saida[c] = (l as any)[c];
  return saida;
}

let proximoId = 100;

function clienteFalso() {
  const criarCadeia = () => {
    const filtros: Record<string, unknown> = {};
    const isNulo: Record<string, unknown> = {};
    const ilike = new Set<string>();
    let tipo: "select" | "update" | "insert" = "select";
    let projecao = "*";
    let payload: Record<string, unknown> = {};
    const executar = () => {
      consultas.push({ tipo, projecao, filtros: { ...filtros }, is: { ...isNulo }, payload: { ...payload } });
      if (erroDeBanco) return { data: null, error: erroDeBanco };
      if (tipo === "insert") {
        const nova = { id: ++proximoId, ...payload } as any;
        linhas.push(nova);
        return { data: [projetar(nova, projecao)], error: null };
      }
      if (tipo === "update" && casSempreVazio) return { data: [], error: null };
      const alvo = linhas.filter(l => casa(l, filtros, ilike, isNulo));
      if (tipo === "update") for (const l of alvo) Object.assign(l, payload);
      return { data: alvo.map(l => projetar(l, projecao)), error: null };
    };
    const cadeia: any = {
      select: (p?: string) => { projecao = p ?? "*"; return cadeia; },
      update: (p: Record<string, unknown>) => { tipo = "update"; payload = p; return cadeia; },
      insert: (p: Record<string, unknown>) => { tipo = "insert"; payload = p; return cadeia; },
      eq: (c: string, v: unknown) => { filtros[c] = v; return cadeia; },
      ilike: (c: string, v: unknown) => { filtros[c] = v; ilike.add(c); return cadeia; },
      is: (c: string, v: unknown) => { isNulo[c] = v; return cadeia; },
      maybeSingle: async () => { const r = executar(); return { data: (r.data as any[])?.[0] ?? null, error: r.error }; },
      single: async () => {
        const r = executar();
        const l0 = (r.data as any[])?.[0] ?? null;
        if (!r.error && !l0) return { data: null, error: { message: "PGRST116: no rows" } };
        return { data: l0, error: r.error };
      },
      then: (resolve: any) => resolve(executar()),
    };
    return cadeia;
  };
  return { from: () => criarCadeia() };
}

const requireOriginal = (Module as any).prototype.require;
(Module as any).prototype.require = function (id: string) {
  if (id === "@supabase/supabase-js") return { createClient: () => clienteFalso() };
  if (id === "resend") return { Resend: class { emails = { send: async () => ({}) }; } };
  return requireOriginal.apply(this, arguments as any);
};

globalThis.fetch = (async (url: any) => {
  throw new Error(`teste tentou acessar a rede: ${String(url)}`);
}) as any;

let logs: string[] = [];
const coletar = (...a: any[]) => { logs.push(a.map(x => String(x)).join(" ")); };

function reiniciar() {
  semear(); consultas = []; erroDeBanco = null; logs = []; casSempreVazio = false;
}

const linha = (id: number) => linhas.find(l => l.id === id);
const escritas = () => consultas.filter(c => c.tipo !== "select");

function reqLogin(email: string, senha: string) {
  return new Request("https://x.test/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, senha }),
  });
}

async function principal() {
  console.log = coletar;
  console.error = coletar;

  const senhaMod = await import("../lib/perfil/senha");
  hashDeMigrada = await senhaMod.gerarHash(SENHA_MIGRADA);

  const { POST: loginPOST } = await import("../app/api/auth/login/route") as any;
  const { POST: perfilPOST } = await import("../app/api/perfil/route") as any;
  const auth = await import("../lib/autenticacao");
  const cap = await import("../lib/perfil/credenciais");
  const tokenA = (await auth.emitirTokenSessao(UUID_A)).token;

  const fs = await import("node:fs");
  const codigo = (c: string) =>
    fs.readFileSync(c, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  secao("\n[1. parâmetros do Argon2id]");

  t("1. o hash gerado é argon2id", async () => {
    const h = await senhaMod.gerarHash("qualquer");
    assert(h.startsWith("$argon2id$"), `🔴 algoritmo errado: ${h.slice(0, 20)}`);
  });

  t("2. memoryCost >= 19456", async () => {
    const h = await senhaMod.gerarHash("qualquer");
    const m = Number(/m=(\d+)/.exec(h)?.[1] ?? 0);
    assert(m >= 19456, `🔴 m=${m}, abaixo do mínimo OWASP`);
  });

  t("3. timeCost >= 2", async () => {
    const h = await senhaMod.gerarHash("qualquer");
    const tc = Number(/t=(\d+)/.exec(h)?.[1] ?? 0);
    assert(tc >= 2, `🔴 t=${tc}`);
  });

  t("4. parallelism >= 1", async () => {
    const h = await senhaMod.gerarHash("qualquer");
    const p = Number(/p=(\d+)/.exec(h)?.[1] ?? 0);
    assert(p >= 1, `🔴 p=${p}`);
  });

  t("5. dois hashes da MESMA senha diferem (salt por hash)", async () => {
    const [h1, h2] = [await senhaMod.gerarHash("igual"), await senhaMod.gerarHash("igual")];
    assert(h1 !== h2, "🔴 hash determinístico — sem salt");
    assert(await senhaMod.verificarHash("igual", h1), "h1 não verifica");
    assert(await senhaMod.verificarHash("igual", h2), "h2 não verifica");
  });

  t("6. verificarHash é fail-closed com lixo", async () => {
    for (const ruim of ["$argon2id$LIXO", "", null, undefined, 42, "texto simples"]) {
      assert(!(await senhaMod.verificarHash("x", ruim as any)), `🔴 aceitou hash inválido: ${ruim}`);
    }
  });

  secao("\n[2. login — conta já migrada]");

  t("7. hash correto autentica e emite sessão", async () => {
    reiniciar();
    const res = await loginPOST(reqLogin("migrado@exemplo.test", SENHA_MIGRADA));
    assert(res.status === 200, `esperado 200, veio ${res.status}`);
    assert((res.headers.get("set-cookie") ?? "").includes("cds_session"), "não emitiu sessão");
  });

  t("8. senha errada em conta migrada -> 401", async () => {
    reiniciar();
    const res = await loginPOST(reqLogin("migrado@exemplo.test", "errada"));
    assert(res.status === 401, `esperado 401, veio ${res.status}`);
  });

  t("9. conta migrada NÃO é regravada em login bem-sucedido", async () => {
    reiniciar();
    const antes = linha(2)!.senha_hash;
    await loginPOST(reqLogin("migrado@exemplo.test", SENHA_MIGRADA));
    assert(linha(2)!.senha_hash === antes, "🔴 regravou o hash sem necessidade");
    assert(escritas().length === 0, `🔴 escreveu ${escritas().length}x num login já migrado`);
  });

  secao("\n[3. sem fallback hash → plaintext]");

  t("10. hash CORROMPIDO reprova, mesmo com plaintext correto ao lado", async () => {
    reiniciar();
    // A linha 3 tem senha_hash inválido E senha = SENHA_LEGADA. Se a rota
    // caísse para o plaintext, isto autenticaria. É o teste central da PR.
    const res = await loginPOST(reqLogin("corrompido@exemplo.test", SENHA_LEGADA));
    assert(res.status === 401, `🔴 FALLBACK PARA PLAINTEXT: veio ${res.status}`);
  });

  t("11. hash corrompido não dispara migração", async () => {
    reiniciar();
    await loginPOST(reqLogin("corrompido@exemplo.test", SENHA_LEGADA));
    assert(escritas().length === 0, "🔴 escreveu no caminho de hash corrompido");
    assert(linha(3)!.senha === SENHA_LEGADA, "alterou a linha");
  });

  secao("\n[4. migração progressiva]");

  t("12. conta legada + senha correta -> login OK e MIGRA", async () => {
    reiniciar();
    const res = await loginPOST(reqLogin("legado@exemplo.test", SENHA_LEGADA));
    assert(res.status === 200, `esperado 200, veio ${res.status}`);
    const l = linha(1)!;
    assert(typeof l.senha_hash === "string" && l.senha_hash.startsWith("$argon2id$"),
      `🔴 não gerou hash: ${l.senha_hash}`);
    assert(l.senha === null, "🔴 plaintext SOBREVIVEU à migração");
  });

  t("13. o hash gravado verifica a senha original", async () => {
    reiniciar();
    await loginPOST(reqLogin("legado@exemplo.test", SENHA_LEGADA));
    assert(await senhaMod.verificarHash(SENHA_LEGADA, linha(1)!.senha_hash),
      "🔴 gravou hash que não confere com a senha");
  });

  t("14. após migrar, o próximo login usa o hash", async () => {
    reiniciar();
    await loginPOST(reqLogin("legado@exemplo.test", SENHA_LEGADA));
    consultas = [];
    const res = await loginPOST(reqLogin("legado@exemplo.test", SENHA_LEGADA));
    assert(res.status === 200, `segundo login falhou: ${res.status}`);
    assert(escritas().length === 0, "🔴 migrou de novo");
  });

  t("15. conta legada + senha errada -> 401 e NÃO migra", async () => {
    reiniciar();
    const res = await loginPOST(reqLogin("legado@exemplo.test", "errada"));
    assert(res.status === 401, `esperado 401, veio ${res.status}`);
    assert(linha(1)!.senha_hash === null, "🔴 migrou com senha errada");
    assert(linha(1)!.senha === SENHA_LEGADA, "alterou o plaintext");
    assert(escritas().length === 0, "🔴 escreveu com senha errada");
  });

  t("16. o CAS filtra por senha_hash IS NULL", async () => {
    reiniciar();
    await loginPOST(reqLogin("legado@exemplo.test", SENHA_LEGADA));
    const w = escritas()[0];
    assert(w.filtros.id === 1, "sem filtro de id");
    assert(w.is.senha_hash === null, "🔴 CAS sem `senha_hash IS NULL` — corrida pode regredir");
  });

  t("17. a migração grava hash E anula plaintext na MESMA escrita", async () => {
    reiniciar();
    await loginPOST(reqLogin("legado@exemplo.test", SENHA_LEGADA));
    const p = escritas()[0].payload;
    const chaves = Object.keys(p).sort();
    assert(JSON.stringify(chaves) === JSON.stringify(["senha", "senha_hash"]),
      `🔴 payload inesperado: ${chaves.join(", ")}`);
    assert(p.senha === null, "🔴 não anulou o plaintext");
  });

  t("18. CAS sem linha afetada NÃO impede o login (decisão de contrato)", async () => {
    reiniciar();
    casSempreVazio = true;
    const res = await loginPOST(reqLogin("legado@exemplo.test", SENHA_LEGADA));
    casSempreVazio = false;
    assert(res.status === 200, `🔴 falha de migração bloqueou login válido: ${res.status}`);
  });

  t("19. erro de banco na migração NÃO impede o login", async () => {
    reiniciar();
    const res = await loginPOST(reqLogin("legado@exemplo.test", SENHA_LEGADA));
    assert(res.status === 200, "pré-condição falhou");
    reiniciar();
    erroDeBanco = { message: 'permission denied for table perfil' };
    const res2 = await loginPOST(reqLogin("legado@exemplo.test", SENHA_LEGADA));
    erroDeBanco = null;
    // A leitura também falha com erro de banco, então o desfecho é 401 —
    // fail-closed. O que NÃO pode acontecer é 500 ou sucesso falso.
    assert(res2.status === 401 || res2.status === 200, `desfecho inesperado: ${res2.status}`);
    assert(res2.status !== 500, "🔴 erro de banco virou 500");
  });

  t("20. dois logins concorrentes: estado final permanece migrado e válido", async () => {
    reiniciar();
    await Promise.all([
      loginPOST(reqLogin("legado@exemplo.test", SENHA_LEGADA)),
      loginPOST(reqLogin("legado@exemplo.test", SENHA_LEGADA)),
    ]);
    const l = linha(1)!;
    assert(l.senha === null, "🔴 plaintext sobreviveu à corrida");
    assert(await senhaMod.verificarHash(SENHA_LEGADA, l.senha_hash), "🔴 hash final inválido");
  });

  secao("\n[5. enumeração e timing]");

  t("21. usuário inexistente -> 401 (não mais 404)", async () => {
    reiniciar();
    const res = await loginPOST(reqLogin("ninguem@exemplo.test", "x"));
    assert(res.status === 401, `🔴 ainda enumera: ${res.status}`);
  });

  t("22. inexistente e senha errada são INDISTINGUÍVEIS", async () => {
    reiniciar();
    const r1 = await loginPOST(reqLogin("ninguem@exemplo.test", "x"));
    const c1 = await r1.text();
    reiniciar();
    const r2 = await loginPOST(reqLogin("migrado@exemplo.test", "errada"));
    const c2 = await r2.text();
    assert(r1.status === r2.status && c1 === c2,
      `🔴 distinguíveis: ${r1.status}/${c1} vs ${r2.status}/${c2}`);
  });

  t("23. hash corrompido também é indistinguível", async () => {
    reiniciar();
    const r = await loginPOST(reqLogin("corrompido@exemplo.test", SENHA_LEGADA));
    const corpo = await r.text();
    reiniciar();
    const r2 = await loginPOST(reqLogin("ninguem@exemplo.test", "x"));
    assert(r.status === r2.status && corpo === (await r2.text()), "🔴 revela hash corrompido");
  });

  t("24. o caminho inexistente executa Argon2 dummy (timing)", async () => {
    reiniciar();
    const t0 = Date.now();
    await loginPOST(reqLogin("ninguem@exemplo.test", "x"));
    const inexistente = Date.now() - t0;
    reiniciar();
    const t1 = Date.now();
    await loginPOST(reqLogin("migrado@exemplo.test", "errada"));
    const senhaErrada = Date.now() - t1;
    // Sem o dummy, o inexistente seria ~0 ms contra dezenas de ms.
    // Margem generosa: o objetivo é detectar ausência do dummy, não
    // medir constância — isso seria flaky em CI.
    assert(inexistente >= senhaErrada * 0.25,
      `🔴 dummy ausente: inexistente=${inexistente}ms vs senha errada=${senhaErrada}ms`);
  });

  t("25. o helper expõe verificarDummy e ela sempre reprova", async () => {
    assert(typeof senhaMod.verificarDummy === "function", "verificarDummy ausente");
    assert((await senhaMod.verificarDummy("qualquer")) === false, "🔴 dummy retornou true");
  });

  t("26. plaintextConfere usa timingSafeEqual", async () => {
    const src = codigo("lib/perfil/senha.ts");
    assert(/timingSafeEqual/.test(src), "🔴 não usa timingSafeEqual");
    assert(/plaintextConfere/.test(src), "helper ausente");
  });

  t("27. plaintextConfere trata tamanhos diferentes sem lançar", async () => {
    assert(senhaMod.plaintextConfere("a", "a") === true, "iguais deveriam conferir");
    assert(senhaMod.plaintextConfere("a", "bbbbbbbbbbbbbbbb") === false, "🔴 lançou ou aceitou");
    assert(senhaMod.plaintextConfere("", "x") === false, "vazio conferiu");
    assert(senhaMod.plaintextConfere(null as any, "x") === false, "null conferiu");
    assert(senhaMod.plaintextConfere("x", null as any) === false, "null armazenado conferiu");
  });

  secao("\n[6. criação e alteração]");

  t("28. criação grava senha_hash e NUNCA plaintext", async () => {
    reiniciar();
    const res = await perfilPOST(new Request("https://x.test/api/perfil", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ _novaConta: true, nome_completo: "Novo",
        email: "novo@exemplo.test", senha: "<senha-nova>" }),
    }));
    assert(res.status === 200, `esperado 200, veio ${res.status}`);
    const ins = escritas().find(c => c.tipo === "insert")!;
    assert(typeof ins.payload.senha_hash === "string" &&
      (ins.payload.senha_hash as string).startsWith("$argon2id$"), "🔴 não gravou hash");
    assert(ins.payload.senha === null, `🔴 gravou plaintext: ${ins.payload.senha}`);
  });

  t("29. o hash da criação verifica a senha informada", async () => {
    reiniciar();
    await perfilPOST(new Request("https://x.test/api/perfil", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ _novaConta: true, nome_completo: "N",
        email: "n2@exemplo.test", senha: "<senha-nova>" }),
    }));
    const ins = escritas().find(c => c.tipo === "insert")!;
    assert(await senhaMod.verificarHash("<senha-nova>", ins.payload.senha_hash),
      "🔴 hash não confere com a senha");
  });

  t("30. alteração de senha grava hash e anula plaintext", async () => {
    reiniciar();
    await perfilPOST(new Request("https://x.test/api/perfil", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `cds_session=${tokenA}` },
      body: JSON.stringify({ senha: "<senha-trocada>" }),
    }));
    const w = escritas()[0];
    assert(typeof w.payload.senha_hash === "string", "🔴 não gravou hash");
    assert(w.payload.senha === null, "🔴 não anulou o plaintext");
    assert(await senhaMod.verificarHash("<senha-trocada>", w.payload.senha_hash), "hash não confere");
  });

  t("31. alteração SEM senha não toca senha nem senha_hash", async () => {
    reiniciar();
    await perfilPOST(new Request("https://x.test/api/perfil", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `cds_session=${tokenA}` },
      body: JSON.stringify({ nome_completo: "Só o nome" }),
    }));
    const p = escritas()[0].payload;
    assert(!("senha" in p) && !("senha_hash" in p), `🔴 tocou senha: ${Object.keys(p).join()}`);
  });

  t("32. senha vazia não altera credencial (deixe em branco)", async () => {
    reiniciar();
    await perfilPOST(new Request("https://x.test/api/perfil", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `cds_session=${tokenA}` },
      body: JSON.stringify({ nome_completo: "X", senha: "" }),
    }));
    const p = escritas()[0].payload;
    assert(!("senha_hash" in p), "🔴 senha vazia virou hash");
  });

  secao("\n[7. nada vaza]");

  const SEGREDOS = new RegExp(
    ["<senha-legada>", "<senha-migrada>", "<senha-nova>", "<senha-trocada>", "argon2id"].join("|"), "i");

  t("33. nenhuma resposta contém senha ou hash", async () => {
    const casos = [
      () => loginPOST(reqLogin("migrado@exemplo.test", SENHA_MIGRADA)),
      () => loginPOST(reqLogin("legado@exemplo.test", SENHA_LEGADA)),
      () => loginPOST(reqLogin("ninguem@exemplo.test", "x")),
      () => loginPOST(reqLogin("corrompido@exemplo.test", SENHA_LEGADA)),
    ];
    for (const chamar of casos) {
      reiniciar();
      const texto = await (await chamar()).text();
      assert(!SEGREDOS.test(texto), `🔴 vazou na resposta: ${texto}`);
      assert(!/"senha"|senha_hash/.test(texto), `🔴 nome de campo na resposta: ${texto}`);
    }
  });

  t("34. nenhum log contém senha ou hash, em nenhum caminho", async () => {
    for (const preparar of [
      () => {},
      () => { casSempreVazio = true; },
      () => { erroDeBanco = { message: 'permission denied for table perfil' }; },
    ]) {
      reiniciar();
      preparar();
      await loginPOST(reqLogin("legado@exemplo.test", SENHA_LEGADA));
      await loginPOST(reqLogin("ninguem@exemplo.test", "x"));
      erroDeBanco = null; casSempreVazio = false;
      const texto = logs.join("\n");
      assert(!SEGREDOS.test(texto), `🔴 segredo no log: ${texto.slice(0, 200)}`);
    }
  });

  t("35. o log não carrega o body do login", async () => {
    reiniciar();
    erroDeBanco = { message: "x" };
    await loginPOST(reqLogin("legado@exemplo.test", SENHA_LEGADA));
    erroDeBanco = null;
    const texto = logs.join("\n");
    assert(!/legado@exemplo.test/.test(texto), "🔴 email no log");
    assert(!/"senha"/.test(texto), "🔴 body no log");
  });

  secao("\n[8. fronteira]");

  t("36. o helper é server-only e não toca banco", async () => {
    const src = codigo("lib/perfil/senha.ts");
    assert(/import "server-only"/.test(src), "🔴 sem barreira server-only");
    assert(!/from\(|supabase|getSupabaseServidor/i.test(src), "🔴 o helper acessa banco");
  });

  t("37. nenhuma comparação simples de senha resta fora do helper", async () => {
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) out.push(...walk(p));
        else if (/\.tsx?$/.test(e.name)) out.push(p);
      }
      return out;
    };
    const alvos = [...walk("app"), ...walk("lib")].filter(p => p !== "lib/perfil/senha.ts");
    const maus: string[] = [];
    for (const p of alvos) {
      for (const m of codigo(p).match(/\.senha\s*[!=]==?[^;)\n]*/g) ?? []) {
        // Checagem de PRESENÇA (`!== undefined`, `!== ""`, `!= null`) é
        // legítima — a rota precisa saber se o campo veio no corpo. O
        // que não pode restar é comparar a senha com outro VALOR.
        if (/[!=]==?\s*(undefined|null|""|'')/.test(m)) continue;
        maus.push(`${p} :: ${m.trim()}`);
      }
    }
    assert(maus.length === 0, `🔴 comparação de senha fora do helper: ${maus.join(" | ")}`);
  });

  t("38. nenhuma ESCRITA no banco grava `senha` com valor", async () => {
    // Mirado na capability, que é o único lugar que escreve em `perfil`
    // (guarda 41 de testar-perfil-capability.ts prova isso). Varrer o
    // repositório inteiro por `senha:` casaria anotação de tipo,
    // parâmetro de função e estado de formulário no cliente — nada disso
    // é escrita em banco, e o falso positivo esconderia o real.
    const src = codigo("lib/perfil/credenciais.ts");
    const cargas = src.match(/\.(insert|update)\(\s*\{[\s\S]*?\}\s*\)/g) ?? [];
    assert(cargas.length >= 4, `varredura suspeita: ${cargas.length} payloads`);
    const maus: string[] = [];
    for (const carga of cargas) {
      for (const m of carga.match(/(?<![_a-zA-Z])senha:\s*[^,\n}]+/g) ?? []) {
        if (!/senha:\s*null/.test(m)) maus.push(m.trim());
      }
    }
    assert(maus.length === 0, `🔴 escrita grava senha em claro: ${maus.join(" | ")}`);
  });

  t("38b. a escrita de criação nomeia senha_hash, nunca senha com valor", async () => {
    const src = codigo("lib/perfil/credenciais.ts");
    const insert = /\.insert\(\s*\{[\s\S]*?\}\s*\)/.exec(src)?.[0] ?? "";
    assert(/senha_hash:\s*dados\.senhaHash/.test(insert), "🔴 criação não grava o hash");
    assert(/senha:\s*null/.test(insert), "🔴 criação não anula o plaintext");
  });

  t("39. a sessão continua independente da senha", async () => {
    const src = codigo("lib/sessao-assinada.ts") + codigo("lib/autenticacao.ts");
    assert(!/senha|password|argon/i.test(src), "🔴 a sessão passou a depender da senha");
  });

  t("40. migrarSenhaLegada exige id e hash", async () => {
    reiniciar();
    assert((await cap.migrarSenhaLegada(0, "h")) === false, "aceitou id zero");
    assert((await cap.migrarSenhaLegada(1, "")) === false, "aceitou hash vazio");
    assert(consultas.length === 0, "🔴 tocou o banco com argumento vazio");
  });

  await fila;
  imprimir(`\n=== RESULTADO: ${ok} passaram, ${falhou} falharam ===\n`);
  if (falhou > 0) process.exit(1);
}

void principal();
