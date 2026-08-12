/**
 * Testes do TRATAMENTO DE ERRO de `/api/lojas` e `/api/perfil`.
 *
 * Por que esta suíte existe: as duas rotas devolviam **HTTP 200 em falha
 * de infraestrutura** — `/api/lojas` respondia `{erro:true, mensagem}`
 * sem `status`, e `/api/perfil` descartava o erro do Supabase na
 * desestruturação e respondia `{}`. Isso manteve invisível por ~54 dias
 * uma `NEXT_PUBLIC_SUPABASE_URL` malformada em produção: nenhum
 * monitoramento acusa 200, e todo consumidor lia o resultado como
 * "nenhuma loja" / "perfil sem dados".
 *
 * A regra que estes testes protegem é uma só:
 *
 *   **falha de infraestrutura nunca responde 200 — e ausência legítima
 *   de dado nunca responde 5xx.**
 *
 * O Supabase é substituído por um duplo controlável, então nenhum teste
 * toca banco, rede ou credencial.
 *
 * Uso: npx tsx scripts/testar-rotas-erro.ts
 */
import fs from "node:fs";
import path from "node:path";
import Module from "node:module";

let ok = 0, falhou = 0;
async function t(nome: string, fn: () => void | Promise<void>) {
  try { await fn(); ok++; console.log(`  PASS  ${nome}`); }
  catch (e: any) { falhou++; console.log(`  FALHA ${nome} -> ${e?.message ?? e}`); }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

// As rotas criam o cliente no escopo do módulo; valores inválidos de
// propósito — nenhuma consulta real deve sair daqui.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder-de-teste.invalid";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "chave-de-teste-invalida";

/** Resultado que o duplo do Supabase vai devolver na próxima consulta. */
let proximaResposta: { data: unknown; error: { message: string } | null } | (() => never) = { data: [], error: null };

/**
 * Duplo do `createClient`. Encadeia como o cliente real (`.from().select()
 * .eq()...`) e resolve com o que o teste programou — inclusive lançando,
 * para exercitar o caminho de exceção inesperada.
 */
function clienteFalso() {
  const encadeia: any = new Proxy(function () {} as any, {
    get(_t, prop) {
      if (prop === "then") {
        return (resolve: any, reject: any) => {
          try {
            if (typeof proximaResposta === "function") proximaResposta();
            resolve(proximaResposta);
          } catch (e) { reject(e); }
        };
      }
      return () => encadeia;
    },
    apply() { return encadeia; },
  });
  return { from: () => encadeia };
}

// Intercepta o `@supabase/supabase-js` antes de as rotas serem importadas.
const requireOriginal = (Module as any).prototype.require;
(Module as any).prototype.require = function (id: string) {
  if (id === "@supabase/supabase-js") return { createClient: () => clienteFalso() };
  return requireOriginal.apply(this, arguments as any);
};

const COOKIE = "cds_session=d35ebb79-f37f-4a42-b7a2-ba1986c6d600";

async function chamarGET(rota: "lojas" | "perfil", comSessao: boolean) {
  const mod = await import(`../app/api/${rota}/route.ts?t=${Date.now()}${Math.random()}`);
  const headers = new Headers();
  if (comSessao) headers.set("cookie", COOKIE);
  const res = await mod.GET(new Request(`https://exemplo.test/api/${rota}`, { headers }));
  let corpo: any = null;
  try { corpo = await res.clone().json(); } catch { }
  return { status: res.status, corpo };
}

async function rodar() {
  console.log("\n[/api/lojas — status por classe de resultado]");

  await t("1. sem sessão → 401, e o corpo não finge lista vazia", async () => {
    proximaResposta = { data: [], error: null };
    const r = await chamarGET("lojas", false);
    assert(r.status === 401, `esperado 401, veio ${r.status}`);
    assert(!Array.isArray(r.corpo), "401 com array parece 'você não tem lojas'");
  });
  await t("2. sucesso com dados → 200 e array", async () => {
    proximaResposta = { data: [{ id: "l1", nome: "Loja" }], error: null };
    const r = await chamarGET("lojas", true);
    assert(r.status === 200, `esperado 200, veio ${r.status}`);
    assert(Array.isArray(r.corpo) && r.corpo.length === 1, "deveria devolver o array");
  });
  await t("3. lista vazia LEGÍTIMA → 200 com [] (nunca 5xx)", async () => {
    proximaResposta = { data: [], error: null };
    const r = await chamarGET("lojas", true);
    assert(r.status === 200, `zero lojas é sucesso, veio ${r.status}`);
    assert(Array.isArray(r.corpo) && r.corpo.length === 0, "deveria ser array vazio");
  });
  await t("4. falha do Supabase → 5xx, NUNCA 200", async () => {
    proximaResposta = { data: null, error: { message: 'relation "lojas" does not exist' } };
    const r = await chamarGET("lojas", true);
    assert(r.status >= 500, `falha de infraestrutura deveria ser 5xx, veio ${r.status}`);
    assert(!Array.isArray(r.corpo), "erro não pode vir como array");
  });
  await t("5. a mensagem crua do Supabase não vaza ao cliente", async () => {
    proximaResposta = { data: null, error: { message: 'relation "lojas" does not exist' } };
    const r = await chamarGET("lojas", true);
    const txt = JSON.stringify(r.corpo);
    assert(!/relation|does not exist|column|schema/i.test(txt), `detalhe de esquema vazou: ${txt}`);
  });
  await t("6. exceção inesperada → 5xx, não 200", async () => {
    proximaResposta = () => { throw new Error("socket hang up"); };
    const r = await chamarGET("lojas", true);
    assert(r.status >= 500, `exceção deveria ser 5xx, veio ${r.status}`);
    assert(!/socket hang up/.test(JSON.stringify(r.corpo)), "detalhe interno vazou");
  });

  console.log("\n[/api/perfil — status por classe de resultado]");

  await t("7. sem sessão → 401 (antes era 200 com {})", async () => {
    proximaResposta = { data: null, error: null };
    const r = await chamarGET("perfil", false);
    assert(r.status === 401, `esperado 401, veio ${r.status}`);
  });
  await t("8. sucesso → 200 com o perfil", async () => {
    proximaResposta = { data: { id: "p1", nome_completo: "Fulano" }, error: null };
    const r = await chamarGET("perfil", true);
    assert(r.status === 200, `esperado 200, veio ${r.status}`);
    assert(r.corpo?.nome_completo === "Fulano", "perfil não veio");
  });
  await t("9. perfil AUSENTE → 200 com {} (ausência legítima, não erro)", async () => {
    proximaResposta = { data: null, error: null };
    const r = await chamarGET("perfil", true);
    assert(r.status === 200, `perfil inexistente não é falha, veio ${r.status}`);
    assert(r.corpo && Object.keys(r.corpo).length === 0, "deveria ser objeto vazio");
  });
  await t("10. falha do Supabase → 5xx, NUNCA 200 com {}", async () => {
    proximaResposta = { data: null, error: { message: "connection refused" } };
    const r = await chamarGET("perfil", true);
    assert(r.status >= 500, `falha de infraestrutura deveria ser 5xx, veio ${r.status}`);
  });
  await t("11. a mensagem crua não vaza, e {} não é usado como erro", async () => {
    proximaResposta = { data: null, error: { message: "connection refused to db.host" } };
    const r = await chamarGET("perfil", true);
    const txt = JSON.stringify(r.corpo);
    assert(!/connection refused|db\.host/i.test(txt), `detalhe interno vazou: ${txt}`);
    assert(txt !== "{}", "erro não pode ser indistinguível de perfil vazio");
  });
  await t("12. exceção inesperada → 5xx", async () => {
    proximaResposta = () => { throw new Error("boom"); };
    const r = await chamarGET("perfil", true);
    assert(r.status >= 500, `exceção deveria ser 5xx, veio ${r.status}`);
    assert(!/boom/.test(JSON.stringify(r.corpo)), "detalhe interno vazou");
  });

  console.log("\n[regressão do anti-pattern]");

  await t("13. o padrão 'erro com 200' não voltou ao código", () => {
    for (const rel of ["app/api/lojas/route.ts", "app/api/perfil/route.ts"]) {
      const f = fs.readFileSync(path.join(process.cwd(), rel), "utf-8")
        .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
      // `NextResponse.json({ erro... })` sem `status` volta 200 por omissão.
      const semStatus = [...f.matchAll(/NextResponse\.json\(\s*\{[^}]*erro[^}]*\}\s*\)/g)];
      assert(semStatus.length === 0, `${rel} devolve erro sem status (=200): ${semStatus[0]?.[0]}`);
      // E a mensagem do Supabase não pode ir ao cliente.
      assert(!/mensagem:\s*error\.message/.test(f), `${rel} vaza error.message`);
    }
  });
  await t("14. os consumidores checam res.ok antes de usar o corpo", () => {
    const casos: [string, RegExp][] = [
      ["components/TopBar.tsx", /res\.ok \? await res\.json\(\) : null/],
      ["components/TopBar.tsx", /perfilRes\.ok \? await perfilRes\.json\(\) : null/],
      ["app/(app)/configuracoes/page.tsx", /res\.ok \? await res\.json\(\) : null/],
      ["app/(app)/dashboard/page.tsx", /r\.ok \? r\.json\(\)/],
    ];
    for (const [rel, re] of casos) {
      const f = fs.readFileSync(path.join(process.cwd(), rel), "utf-8");
      assert(re.test(f), `${rel} não confere res.ok — falha viraria lista/perfil vazio`);
    }
  });
  await t("15. nenhuma das duas rotas virou escrita ou marketplace", () => {
    for (const rel of ["app/api/lojas/route.ts", "app/api/perfil/route.ts"]) {
      const f = fs.readFileSync(path.join(process.cwd(), rel), "utf-8");
      assert(!/api\.mercadolibre|\/items/.test(f), `${rel} fala com marketplace`);
      assert(!/SERVICE_ROLE/.test(f), `${rel} passou a usar service role`);
    }
    const lojas = fs.readFileSync(path.join(process.cwd(), "app/api/lojas/route.ts"), "utf-8");
    assert(!/\.(insert|update|upsert|delete)\(/.test(lojas), "GET /api/lojas passou a escrever");
  });

  console.log("\n[normalização das demais rotas — 2026-09-03]");

  await t("16. as 4 rotas de diagnóstico sem consumidor foram removidas", () => {
    for (const rel of ["app/api/ml/debug-item", "app/api/ml/test-collections",
                       "app/api/shopee/ping", "app/api/shopee/status"]) {
      assert(!fs.existsSync(path.join(process.cwd(), rel)), `${rel} voltou a existir`);
    }
    // As rotas Shopee/ML LEGÍTIMAS continuam de pé — a limpeza não pode
    // ter levado junto o que o produto usa.
    for (const rel of ["app/api/shopee/vendas", "app/api/ml/vendas", "app/api/ml/sync-precos"]) {
      assert(fs.existsSync(path.join(process.cwd(), rel)), `${rel} foi removida por engano`);
    }
  });

  await t("17. sessão inválida responde 401, não 200", () => {
    for (const rel of ["app/api/ml/sync-precos/route.ts", "app/api/ml/sync-skus/route.ts"]) {
      const f = fs.readFileSync(path.join(process.cwd(), rel), "utf-8");
      const linha = f.split("\n").find(l => l.includes("Sessão inválida"));
      assert(!!linha, `${rel}: não achei o caso de sessão inválida`);
      assert(/status: 401/.test(linha!), `${rel} não devolve 401 para sessão inválida`);
    }
  });

  await t("18. entrada inválida responde 400, não 200", () => {
    const anuncio = fs.readFileSync(path.join(process.cwd(), "app/api/anuncio/route.ts"), "utf-8");
    assert((anuncio.match(/status: 400/g) ?? []).length >= 2, "/api/anuncio deveria usar 400 para entrada inválida");
    const cb = fs.readFileSync(path.join(process.cwd(), "app/api/auth/mercadolivre/callback/route.ts"), "utf-8");
    const linha = cb.split("\n").find(l => l.includes("Code não recebido"));
    assert(!!linha && /status: 400/.test(linha), "callback deveria usar 400 quando falta o code");
  });

  await t("19. falha do Supabase em sync-precos é 5xx e não vaza a mensagem", () => {
    const f = fs.readFileSync(path.join(process.cwd(), "app/api/ml/sync-precos/route.ts"), "utf-8");
    assert(/status: 503/.test(f), "falha de banco deveria ser 5xx");
    assert(!/Erro Supabase/.test(f), "ainda vaza a mensagem crua do Supabase");
    assert(/console\.error\("\[POST \/api\/ml\/sync-precos\]/.test(f), "o diagnóstico deveria ir para o log");
  });

  await t("20. estado de NEGÓCIO segue 200 — não virou erro HTTP", () => {
    // "Conta não conectada" e "token expirado" são estados legítimos do
    // usuário, com flags que a tela consome (`semConexao`, `tokenExpirado`).
    // Transformá-los em 4xx/5xx quebraria o consumidor e mentiria sobre a
    // natureza do problema: não há falha nenhuma no servidor.
    for (const rel of ["app/api/ml/vendas/route.ts", "app/api/ml/vendas-hoje/route.ts",
                       "app/api/shopee/vendas/route.ts"]) {
      const f = fs.readFileSync(path.join(process.cwd(), rel), "utf-8");
      // Especificamente a linha de "não conectada". `ml/vendas` também
      // usa `semConexao` num 401 de sessão inválida — que está CERTO, e
      // não pode ser confundido com este caso.
      const linha = f.split("\n").find(l => l.includes("semConexao: true") && /n[ãa]o conectada/i.test(l));
      assert(!!linha, `${rel}: não achei o caso de conta não conectada`);
      assert(!/status: [45]/.test(linha!), `${rel} transformou estado de negócio em erro HTTP`);
    }
  });
}

rodar().then(() => {
  console.log(`\n=== RESULTADO: ${ok} passaram, ${falhou} falharam ===\n`);
  process.exitCode = falhou > 0 ? 1 : 0;
});
