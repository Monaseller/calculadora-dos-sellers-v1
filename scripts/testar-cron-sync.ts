/**
 * Testes da autenticação do CRON de sincronização.
 *
 * A rota `/api/sync` varre `lojas` de TODOS os usuários ativos e dispara
 * sync contra Shopee e Mercado Livre. Ela é, de longe, o endpoint mais
 * caro do sistema — e até 2026-09-01 ficava ABERTA quando `CRON_SECRET`
 * não estava configurada, porque a guarda era
 * `if (process.env.CRON_SECRET && auth !== ...)`.
 *
 * Estes testes existem para que esse erro não volte.
 *
 * **NENHUM sync é executado aqui.** A autenticação é a primeira coisa que
 * a rota faz, então o teste chama o handler real e verifica que ele para
 * em 401 antes de tocar em banco ou marketplace. O único caso em que a
 * autenticação passa é verificado por leitura do código, não por
 * execução — rodar o sync de verdade num teste seria disparar chamadas
 * reais a dois marketplaces.
 *
 * Uso: npx tsx scripts/testar-cron-sync.ts
 */
// Ver nota em _server-only-inerte.ts: a capability de credenciais é
// `server-only`, que lança fora da condição `react-server`.
import "./_server-only-inerte";
import fs from "node:fs";
import path from "node:path";

let ok = 0, falhou = 0;
async function t(nome: string, fn: () => void | Promise<void>) {
  try { await fn(); ok++; console.log(`  PASS  ${nome}`); }
  catch (e: any) { falhou++; console.log(`  FALHA ${nome} -> ${e?.message ?? e}`); }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

const SEGREDO = "segredo-de-teste-nunca-real";

/**
 * A rota cria o cliente Supabase no escopo do módulo, então precisa de
 * URL e chave só para IMPORTAR. Estes valores são propositalmente
 * inválidos: se a autenticação deixasse de recusar primeiro, a consulta
 * seguinte falharia contra um host que não existe — ou seja, o
 * placebo aqui é parte da prova de que nada de banco acontece antes do
 * 401.
 */
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder-de-teste.invalid";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "chave-de-teste-invalida";
const ROTA = path.join(process.cwd(), "app/api/sync/route.ts");
const FONTE = fs.readFileSync(ROTA, "utf-8");
/** Fonte sem comentários — a guarda antiga aparece citada num deles. */
const CODIGO = FONTE.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

/**
 * Chama o handler real com o ambiente controlado.
 *
 * O módulo é importado com `?t=` diferente a cada vez para o ESM não
 * reaproveitar a instância anterior — `process.env` é lido no topo do
 * arquivo em alguns pontos, e um cache silencioso faria o teste medir a
 * configuração errada.
 */
async function chamar(env: { segredo?: string; authorization?: string }): Promise<number> {
  const antes = process.env.CRON_SECRET;
  if (env.segredo === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = env.segredo;
  try {
    const mod = await import(`../app/api/sync/route.ts?t=${Date.now()}${Math.random()}`);
    const headers = new Headers();
    if (env.authorization) headers.set("authorization", env.authorization);
    const res = await mod.GET(new Request("https://exemplo.test/api/sync", { headers }));
    return res.status;
  } finally {
    if (antes === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = antes;
  }
}

async function rodar() {
  console.log("\n[autenticação do cron — fail closed]");

  await t("1. CRON_SECRET ausente → 401, mesmo com Authorization válido-parecido", async () => {
    // Este é o caso que estava quebrado: sem a variável, a guarda inteira
    // era pulada e a rota respondia normalmente.
    assert(await chamar({}) === 401, "sem segredo configurado deveria recusar");
    assert(await chamar({ authorization: `Bearer ${SEGREDO}` }) === 401,
      "sem segredo configurado, nenhum header pode autorizar");
  });
  await t("2. Authorization ausente → 401", async () => {
    assert(await chamar({ segredo: SEGREDO }) === 401, "sem header deveria recusar");
  });
  await t("3. Bearer incorreto → 401", async () => {
    assert(await chamar({ segredo: SEGREDO, authorization: "Bearer errado" }) === 401, "segredo errado deveria recusar");
    assert(await chamar({ segredo: SEGREDO, authorization: SEGREDO }) === 401, "sem o prefixo Bearer deveria recusar");
    assert(await chamar({ segredo: SEGREDO, authorization: `bearer ${SEGREDO}` }) === 401,
      "a comparação é exata — `bearer` minúsculo não passa");
    assert(await chamar({ segredo: SEGREDO, authorization: `Bearer ${SEGREDO}x` }) === 401,
      "sufixo extra não passa");
    // Espaço no fim NÃO é testado de propósito: a própria API `Headers`
    // normaliza o valor antes de o handler vê-lo, então o teste mediria o
    // runtime, não a guarda.
  });
  await t("4. Bearer correto passa da autenticação", () => {
    // Verificado por LEITURA: executar aqui dispararia sync real contra
    // Shopee e Mercado Livre para todos os usuários ativos.
    assert(/auth !== `Bearer \$\{segredo\}`/.test(CODIGO), "a comparação deveria ser Bearer + segredo");
    const guarda = CODIGO.slice(CODIGO.indexOf("const segredo"), CODIGO.indexOf("searchParams"));
    assert(/status: 401/.test(guarda), "a guarda deveria responder 401");
    assert(/if \(!segredo \|\| !auth \|\| auth !== /.test(guarda),
      "a guarda precisa recusar segredo ausente, header ausente e header errado");
  });
  await t("5. o segredo NUNCA aparece na resposta", async () => {
    const mod = await import(`../app/api/sync/route.ts?t=${Date.now()}b`);
    process.env.CRON_SECRET = SEGREDO;
    const res = await mod.GET(new Request("https://exemplo.test/api/sync"));
    const corpo = await res.text();
    delete process.env.CRON_SECRET;
    assert(!corpo.includes(SEGREDO), "o segredo vazou no corpo da resposta");
    assert(corpo === JSON.stringify({ erro: true }), `resposta deveria ser genérica: ${corpo}`);
  });
  await t("6. o segredo NUNCA é logado", () => {
    assert(!/console\.[a-z]+\([^)]*CRON_SECRET/.test(CODIGO), "CRON_SECRET aparece em log");
    assert(!/console\.[a-z]+\([^)]*segredo/.test(CODIGO), "o segredo aparece em log");
    assert(!/console\.[a-z]+\([^)]*auth\b/.test(CODIGO), "o header de autorização aparece em log");
  });
  await t("7. o cron declarado em vercel.json continua compatível", () => {
    const vercel = JSON.parse(fs.readFileSync(path.join(process.cwd(), "vercel.json"), "utf-8"));
    const cron = (vercel.crons ?? []).find((c: any) => c.path === "/api/sync");
    assert(!!cron, "o cron de /api/sync sumiu do vercel.json");
    assert(typeof cron.schedule === "string" && cron.schedule.length > 0, "o cron precisa de schedule");
    // O agendador do Vercel manda `Authorization: Bearer <CRON_SECRET>`
    // sozinho quando a variável existe. Nenhum header próprio foi
    // inventado — inventar um criaria uma segunda porta para manter
    // fechada.
    assert(/authorization/i.test(CODIGO), "a rota deveria ler o header oficial");
    assert(!/x-cron|cron_token|searchParams\.get\("secret"\)|cookies\(\)/i.test(CODIGO),
      "há mecanismo de autenticação alternativo além do oficial");
  });
  await t("8. nenhuma rota vizinha contorna a guarda", () => {
    const dir = path.join(process.cwd(), "app/api/sync");
    const rotas: string[] = [];
    const varrer = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) varrer(full);
        else if (e.name === "route.ts") rotas.push(full);
      }
    };
    varrer(dir);
    assert(rotas.length >= 2, "varredura das rotas de sync falhou");
    for (const r of rotas) {
      if (r === ROTA) continue;
      const f = fs.readFileSync(r, "utf-8").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
      const rel = path.relative(process.cwd(), r).replace(/\\/g, "/");
      // Toda irmã exige sessão de usuário; nenhuma roda sync global sem dono.
      assert(/autenticarRequisicao\(/.test(f), `${rel} não exige sessão`);
    }
    // E a rota interna do worker também falha fechada.
    const interna = fs.readFileSync(path.join(process.cwd(), "app/api/internal/sync/executar/route.ts"), "utf-8");
    assert(/if \(!segredoEsperado \|\| !segredoRecebido/.test(interna), "a rota interna não falha fechada");
  });
  await t("9. a guarda antiga (fail open) não voltou", () => {
    // `if (process.env.CRON_SECRET && ...)` é exatamente o padrão que
    // deixava a rota aberta por omissão de configuração.
    assert(!/if \(\s*process\.env\.CRON_SECRET\s*&&/.test(CODIGO), "a guarda fail-open voltou");
  });
}

rodar().then(() => {
  console.log(`\n=== RESULTADO: ${ok} passaram, ${falhou} falharam ===\n`);
  process.exitCode = falhou > 0 ? 1 : 0;
});
