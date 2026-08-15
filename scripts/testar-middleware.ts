/**
 * Política de alcance do middleware — testes de F0.b.
 *
 * ── O defeito que originou esta suíte ───────────────────────────────
 * `middleware.ts` mantinha `"/"` na lista de rotas públicas e testava
 * com `startsWith`. Como todo caminho começa com `/`, a condição era
 * sempre verdadeira: o middleware liberava TUDO. As rotas internas e os
 * dois crons funcionavam justamente por causa desse defeito.
 *
 * Por isso o primeiro bloco daqui é o mais importante: ele prova que
 * corrigir o alcance NÃO derruba cron nem worker. Um cron bloqueado pelo
 * middleware receberia 307 para /login e registraria sucesso — falha
 * silenciosa, o modo de falha que já custou 54 dias de fila parada neste
 * repositório.
 *
 * NENHUM teste chama IA, rede ou banco. Só o bloco de assets lê disco
 * (lista `public/`), sem abrir conteúdo.
 *
 * Uso: npx tsx scripts/testar-middleware.ts
 */
import fs from "node:fs";
import path from "node:path";
import {
  decidirAcesso,
  PAGINAS_PUBLICAS,
  ASSETS_PUBLICOS,
  CLASSIFICACAO_ASSETS_PUBLIC,
  ROTAS_PUBLICAS,
  ROTAS_COM_SEGREDO,
  EXCECOES_TEMPORARIAS_F0C,
  type Decisao,
} from "../lib/middleware-rotas";

let ok = 0, falhou = 0;
function t(nome: string, fn: () => void) {
  try { fn(); ok++; console.log(`  PASS  ${nome}`); }
  catch (e: any) { falhou++; console.log(`  FALHA ${nome} -> ${e?.message ?? e}`); }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

/** Sem sessão — o caso que interessa em toda esta suíte. */
const sem = (caminho: string, metodo = "GET"): Decisao => decidirAcesso(caminho, metodo, false);
/** Com sessão (presença de cookie apenas — F0.b não valida força). */
const com = (caminho: string, metodo = "GET"): Decisao => decidirAcesso(caminho, metodo, true);

const UUID = "11111111-1111-1111-1111-111111111111";

// ────────────────────────────────────────────────────────────────────
console.log("\n[1. crons e workers continuam funcionando — BLOQUEANTE]");
// Se qualquer um destes falhar, a fila de produção para em silêncio.

t("1. GET /api/sync (cron 3h) passa sem cookie", () => {
  assert(sem("/api/sync") === "liberar", "cron de sync seria bloqueado pelo middleware");
});

t("2. GET /api/internal/estudio-anuncios/worker (cron 1min) passa sem cookie", () => {
  assert(sem("/api/internal/estudio-anuncios/worker") === "liberar",
    "cron do Estudio seria bloqueado — fila pararia sem sintoma");
});

t("3. POST /api/internal/estudio-anuncios/executar passa sem cookie", () => {
  assert(sem("/api/internal/estudio-anuncios/executar", "POST") === "liberar",
    "worker local perderia acesso a rota interna");
});

t("4. POST /api/internal/sync/executar passa sem cookie", () => {
  assert(sem("/api/internal/sync/executar", "POST") === "liberar", "worker de sync bloqueado");
});

t("5. metodo errado numa rota com segredo NAO e liberado", () => {
  // O middleware não inventa método: worker é GET, executar é POST.
  assert(sem("/api/internal/estudio-anuncios/worker", "POST") === "bloquear_api",
    "POST no worker deveria cair no default deny");
  assert(sem("/api/internal/estudio-anuncios/executar", "GET") === "bloquear_api",
    "GET no executar deveria cair no default deny");
});

t("6. as 4 rotas com segredo estao declaradas, nem uma a mais", () => {
  assert(Object.keys(ROTAS_COM_SEGREDO).length === 4,
    `esperado 4 rotas com segredo, encontrado ${Object.keys(ROTAS_COM_SEGREDO).length}`);
});

// ────────────────────────────────────────────────────────────────────
console.log("\n[2. APIs protegidas devolvem 401]");

t("7. GET /api/estudio-anuncios/projetos sem cookie e bloqueada", () => {
  assert(sem("/api/estudio-anuncios/projetos") === "bloquear_api", "rota do Estudio ficou aberta");
});

t("8. GET /api/dashboard/resumo sem cookie e bloqueada", () => {
  assert(sem("/api/dashboard/resumo") === "bloquear_api", "dashboard ficou aberto");
});

t("9. POST publicar (acao irreversivel no ML) sem cookie e bloqueada", () => {
  assert(sem(`/api/estudio-anuncios/projetos/${UUID}/marketplaces/mercado-livre/publicar`, "POST")
    === "bloquear_api", "rota de publicacao ficou aberta");
});

t("10. rotas administrativas sem cookie sao bloqueadas", () => {
  for (const r of [
    "/api/admin/backfill-resumos-diarios",
    "/api/admin/shopee/reconciliar-financeiro",
    "/api/admin/shopee/backfill-pedidos-0707",
  ]) assert(sem(r) === "bloquear_api", `${r} ficou aberta`);
});

t("11. as mesmas rotas com COOKIE PRESENTE sao liberadas", () => {
  // "cookie presente", nunca "sessao valida": em F0.b o middleware nao
  // verifica assinatura, expiracao nem o valor legado "1". Isso e F0.c.
  assert(com("/api/estudio-anuncios/projetos") === "liberar", "cookie presente foi bloqueado");
  assert(com("/api/dashboard/resumo") === "liberar", "cookie presente foi bloqueado");
  assert(com("/api/admin/backfill-resumos-diarios") === "liberar", "cookie presente foi bloqueado");
});

t("12. caminho de API desconhecido cai no default DENY", () => {
  assert(sem("/api/rota-que-nao-existe") === "bloquear_api", "default deveria ser negar");
  assert(sem("/api/") === "bloquear_api", "default deveria ser negar");
});

// ────────────────────────────────────────────────────────────────────
console.log("\n[3. paginas: redirect, nao 401]");

t("13. /dashboard sem cookie redireciona", () => {
  assert(sem("/dashboard") === "redirecionar", "pagina protegida deveria redirecionar");
});

t("14. pagina profunda do Estudio sem cookie redireciona", () => {
  assert(sem(`/central-ia/estudio-anuncios/${UUID}`) === "redirecionar",
    "pagina protegida deveria redirecionar");
});

t("15. paginas publicas passam sem cookie", () => {
  for (const p of ["/", "/login", "/verificar-email"])
    assert(sem(p) === "liberar", `${p} deveria ser publica`);
  assert(PAGINAS_PUBLICAS.size === 3, "conjunto de paginas publicas mudou sem revisao");
});

t("16. pagina nunca recebe bloquear_api e API nunca recebe redirecionar", () => {
  assert(sem("/qualquer/pagina") === "redirecionar", "pagina deveria redirecionar");
  assert(sem("/api/qualquer") === "bloquear_api", "API deveria devolver 401");
});

// ────────────────────────────────────────────────────────────────────
console.log("\n[4. shopee/debug bloqueada]");

t("17. GET /api/auth/shopee/debug sem cookie e bloqueada", () => {
  // Rota devolve partner_id, tamanho da chave, fragmentos dela e
  // assinaturas HMAC validas. Remocao definitiva em F0.d.
  assert(sem("/api/auth/shopee/debug") === "bloquear_api", "debug da Shopee continua publica");
});

t("18. shopee/debug nao consta em nenhuma das listas de excecao", () => {
  const alvo = "/api/auth/shopee/debug";
  assert(!(alvo in ROTAS_PUBLICAS), "debug listada como publica");
  assert(!(alvo in ROTAS_COM_SEGREDO), "debug listada como rota com segredo");
  assert(!(alvo in EXCECOES_TEMPORARIAS_F0C), "debug listada como excecao temporaria");
  assert(!PAGINAS_PUBLICAS.has(alvo) && !ASSETS_PUBLICOS.has(alvo), "debug listada como publica");
});

// ────────────────────────────────────────────────────────────────────
console.log("\n[5. rotas legadas: duas mantidas, /api/anuncio migrada]");

t("19. /api/anuncio PASSA A EXIGIR sessao (cutover F0.c.5)", () => {
  // Era a terceira excecao temporaria. Saiu da lista porque a rota agora
  // resolve a credencial do ML no servidor, e isso exige userId confiavel.
  assert(sem("/api/anuncio") === "bloquear_api",
    "/api/anuncio continua publica — a excecao nao foi removida");
  assert(!("/api/anuncio" in EXCECOES_TEMPORARIAS_F0C),
    "/api/anuncio ainda consta na excecao temporaria");
});

t("19b. sem sessao, /api/anuncio recebe 401 de API e NAO redirect HTML", () => {
  // Distincao que importa para o fetch do FormAnuncio: um redirect 307
  // para /login devolveria HTML e o `res.json()` da tela quebraria com
  // erro de parse em vez de uma mensagem util.
  assert(sem("/api/anuncio") !== "redirecionar", "rota de API caiu no fluxo de redirect de pagina");
});

t("20. /api/auth/status continua acessivel sem cds_session", () => {
  assert(sem("/api/auth/status") === "liberar", "comportamento legado foi alterado em F0.b");
});

t("21. /api/ml/item-thumbnails continua acessivel sem cds_session", () => {
  assert(sem("/api/ml/item-thumbnails") === "liberar", "comportamento legado foi alterado em F0.b");
});

t("22. a excecao temporaria tem EXATAMENTE 2 entradas", () => {
  // Trava contra crescimento silencioso. F0.c so termina com este objeto
  // vazio. 3 → 2 no cutover de Meus Produtos: so /api/anuncio saiu.
  const n = Object.keys(EXCECOES_TEMPORARIAS_F0C).length;
  assert(n === 2, `excecao temporaria tem ${n} — o cutover F0.c.5 autorizou 2`);
});

// ────────────────────────────────────────────────────────────────────
console.log("\n[6. OAuth exatamente como antes]");

const OAUTH_PUBLICAS: [string, string][] = [
  ["/api/auth/login", "POST"],
  ["/api/auth/logout", "POST"],
  ["/api/auth/logout", "GET"],          // href em precificacao/page.tsx (segue 405 na rota)
  ["/api/auth/verificar-email", "GET"],
  ["/api/auth/verificar-email", "POST"],
  ["/api/auth/mercadolivre", "GET"],
  ["/api/auth/mercadolivre/callback", "GET"],
  ["/api/auth/mercadolivre/callback", "POST"],
  ["/api/auth/shopee", "GET"],
  ["/api/auth/shopee", "POST"],
  ["/api/auth/shopee/callback", "GET"],
];

t("23. as 11 combinacoes de auth/OAuth passam sem cookie", () => {
  // 12 → 11 em F0.c.6d: `/api/auth/relay` foi DELETADA. O callback do ML
  // passou a persistir sozinho, e ela era o unico consumidor.
  for (const [caminho, metodo] of OAUTH_PUBLICAS)
    assert(sem(caminho, metodo) === "liberar", `${metodo} ${caminho} foi bloqueada`);
});

t("24. as rotas publicas sao exatamente as 7 previstas", () => {
  // 8 → 7 em F0.c.6d, pela remocao do relay.
  const n = Object.keys(ROTAS_PUBLICAS).length;
  assert(n === 7, `esperado 7 rotas publicas, encontrado ${n}`);
});

t("24b. o relay nao existe mais em lugar nenhum", () => {
  // Ele aceitava access_token e refresh_token por QUERY STRING. Enquanto
  // o arquivo existir, alguem pode reativa-lo sem perceber o que ele fazia.
  assert(!("/api/auth/relay" in ROTAS_PUBLICAS), "relay ainda listado como rota publica");
  assert(!fs.existsSync(path.join(process.cwd(), "app", "api", "auth", "relay", "route.ts")),
    "o arquivo do relay continua no repositorio");
});

t("25. /api/auth/status-session NAO e publica (nao tem consumidor)", () => {
  assert(sem("/api/auth/status-session") === "bloquear_api", "status-session ficou aberta");
});

// ────────────────────────────────────────────────────────────────────
console.log("\n[7. assets de public/ classificados um a um]");

t("26. nenhum asset e publico hoje — e isso e deliberado", () => {
  // logo-cds.png so aparece em components/Sidebar.tsx, dentro do layout
  // autenticado. Quem o pede ja tem cookie.
  assert(ASSETS_PUBLICOS.size === 0,
    "algum asset foi liberado sem registro do motivo em CLASSIFICACAO_ASSETS_PUBLIC");
});

t("27. logo-cds.png sem cookie e tratado como conteudo autenticado", () => {
  assert(sem("/logo-cds.png") === "redirecionar", "asset autenticado deveria seguir a regra de pagina");
  assert(com("/logo-cds.png") === "liberar", "asset deveria carregar para quem tem sessao");
});

t("28. todo arquivo de public/ esta classificado no middleware", () => {
  const dir = path.join(process.cwd(), "public");
  const arquivos = fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true, recursive: true } as any)
        .filter((d: any) => d.isFile())
        .map((d: any) => "/" + path.relative(dir, path.join(d.parentPath ?? d.path ?? dir, d.name)).split(path.sep).join("/"))
    : [];

  const classificados = new Set(Object.keys(CLASSIFICACAO_ASSETS_PUBLIC));
  const novos = arquivos.filter(a => !classificados.has(a));
  assert(novos.length === 0,
    `Novo asset em public/ precisa ser classificado no middleware: ${novos.join(", ")} ` +
    `— decida em lib/middleware-rotas.ts se e "publico" (e some a ASSETS_PUBLICOS) ou "autenticado".`);

  const sumidos = [...classificados].filter(c => !arquivos.includes(c));
  assert(sumidos.length === 0,
    `Asset classificado que nao existe mais em public/: ${sumidos.join(", ")} — remover da classificacao.`);
});

t("29. asset marcado 'publico' precisa constar em ASSETS_PUBLICOS", () => {
  for (const [caminho, classe] of Object.entries(CLASSIFICACAO_ASSETS_PUBLIC)) {
    if (classe === "publico")
      assert(ASSETS_PUBLICOS.has(caminho), `${caminho} classificado como publico mas nao liberado`);
    else
      assert(!ASSETS_PUBLICOS.has(caminho), `${caminho} classificado como autenticado mas esta liberado`);
  }
});

// ────────────────────────────────────────────────────────────────────
console.log("\n[8. cobertura: as 50 rotas do inventario F0.a]");

/** caminho, metodo, decisao esperada SEM sessao. */
const INVENTARIO: [string, string, Decisao][] = [
  // — publicas (7; era 8 ate o relay ser deletado em F0.c.6d)
  ["/api/auth/login", "POST", "liberar"],
  ["/api/auth/logout", "POST", "liberar"],
  ["/api/auth/verificar-email", "GET", "liberar"],
  ["/api/auth/mercadolivre", "GET", "liberar"],
  ["/api/auth/mercadolivre/callback", "GET", "liberar"],
  ["/api/auth/shopee", "GET", "liberar"],
  ["/api/auth/shopee/callback", "GET", "liberar"],
  // — com segredo proprio (4)
  ["/api/sync", "GET", "liberar"],
  ["/api/internal/estudio-anuncios/worker", "GET", "liberar"],
  ["/api/internal/estudio-anuncios/executar", "POST", "liberar"],
  ["/api/internal/sync/executar", "POST", "liberar"],
  // — excecoes temporarias F0.c (2, era 3 ate o cutover F0.c.5)
  ["/api/auth/status", "GET", "liberar"],
  ["/api/ml/item-thumbnails", "GET", "liberar"],
  // — migrada em F0.c.5: exige sessao como qualquer rota de API
  ["/api/anuncio", "GET", "bloquear_api"],
  // — protegidas: auth e perfil (3)
  ["/api/auth/me", "GET", "bloquear_api"],
  ["/api/auth/status-session", "GET", "bloquear_api"],
  ["/api/auth/shopee/debug", "GET", "bloquear_api"],
  // — protegidas: admin (3)
  ["/api/admin/backfill-resumos-diarios", "GET", "bloquear_api"],
  ["/api/admin/shopee/reconciliar-financeiro", "GET", "bloquear_api"],
  ["/api/admin/shopee/backfill-pedidos-0707", "GET", "bloquear_api"],
  // — protegidas: dados e lojas (5)
  ["/api/dashboard/resumo", "GET", "bloquear_api"],
  ["/api/lojas", "GET", "bloquear_api"],
  ["/api/lojas/ativar", "POST", "bloquear_api"],
  ["/api/lojas/desconectar", "POST", "bloquear_api"],
  ["/api/perfil", "GET", "bloquear_api"],
  // — protegidas: marketplaces (7)
  ["/api/ml/vendas", "GET", "bloquear_api"],
  ["/api/ml/vendas-hoje", "GET", "bloquear_api"],
  ["/api/ml/importar-anuncios", "POST", "bloquear_api"],
  ["/api/ml/sync-precos", "POST", "bloquear_api"],
  ["/api/ml/sync-skus", "POST", "bloquear_api"],
  ["/api/shopee/vendas", "GET", "bloquear_api"],
  ["/api/shopee/importar-anuncios", "POST", "bloquear_api"],
  // — protegidas: sync (3)
  ["/api/sync/iniciar", "POST", "bloquear_api"],
  ["/api/sync/manual", "POST", "bloquear_api"],
  ["/api/sync/status", "GET", "bloquear_api"],
  // — protegidas: Estudio (15)
  ["/api/estudio-anuncios/projetos", "GET", "bloquear_api"],
  [`/api/estudio-anuncios/projetos/${UUID}`, "GET", "bloquear_api"],
  [`/api/estudio-anuncios/projetos/${UUID}/fotos`, "POST", "bloquear_api"],
  [`/api/estudio-anuncios/projetos/${UUID}/pipeline/iniciar`, "POST", "bloquear_api"],
  [`/api/estudio-anuncios/projetos/${UUID}/pipeline/retomar`, "POST", "bloquear_api"],
  [`/api/estudio-anuncios/projetos/${UUID}/compliance/mercado-livre`, "POST", "bloquear_api"],
  [`/api/estudio-anuncios/projetos/${UUID}/conteudo/mercado-livre/versoes`, "POST", "bloquear_api"],
  [`/api/estudio-anuncios/projetos/${UUID}/conteudo/mercado-livre/aprovar`, "POST", "bloquear_api"],
  [`/api/estudio-anuncios/projetos/${UUID}/marketplaces/mercado-livre`, "PATCH", "bloquear_api"],
  [`/api/estudio-anuncios/projetos/${UUID}/marketplaces/mercado-livre/categorias`, "GET", "bloquear_api"],
  [`/api/estudio-anuncios/projetos/${UUID}/marketplaces/mercado-livre/lojas`, "GET", "bloquear_api"],
  [`/api/estudio-anuncios/projetos/${UUID}/marketplaces/mercado-livre/validacao-oficial`, "POST", "bloquear_api"],
  [`/api/estudio-anuncios/projetos/${UUID}/marketplaces/mercado-livre/publicar`, "POST", "bloquear_api"],
  [`/api/estudio-anuncios/projetos/${UUID}/exportacao`, "POST", "bloquear_api"],
  [`/api/estudio-anuncios/projetos/${UUID}/exportacao/${UUID}/arquivo`, "GET", "bloquear_api"],
];

t("30. as 50 rotas do inventario caem na classe correta", () => {
  // 51 → 50 em F0.c.6d: `/api/auth/relay` deixou de existir.
  assert(INVENTARIO.length === 50, `inventario tem ${INVENTARIO.length} rotas, esperado 50`);
  for (const [caminho, metodo, esperado] of INVENTARIO) {
    const obtido = sem(caminho, metodo);
    assert(obtido === esperado, `${metodo} ${caminho}: esperado ${esperado}, obtido ${obtido}`);
  }
});

t("31. toda rota do inventario e liberada com cookie presente", () => {
  for (const [caminho, metodo] of INVENTARIO)
    assert(com(caminho, metodo) === "liberar", `${metodo} ${caminho} bloqueada com cookie presente`);
});

t("32. nenhum caminho aparece em duas listas ao mesmo tempo", () => {
  const listas: [string, string[]][] = [
    ["ROTAS_PUBLICAS", Object.keys(ROTAS_PUBLICAS)],
    ["ROTAS_COM_SEGREDO", Object.keys(ROTAS_COM_SEGREDO)],
    ["EXCECOES_TEMPORARIAS_F0C", Object.keys(EXCECOES_TEMPORARIAS_F0C)],
    ["PAGINAS_PUBLICAS", [...PAGINAS_PUBLICAS]],
    ["ASSETS_PUBLICOS", [...ASSETS_PUBLICOS]],
  ];
  const visto = new Map<string, string>();
  for (const [nome, caminhos] of listas)
    for (const c of caminhos) {
      const antes = visto.get(c);
      assert(!antes, `"${c}" esta em ${antes} E em ${nome}`);
      visto.set(c, nome);
    }
});

// ────────────────────────────────────────────────────────────────────
console.log("\n[9. matcher: o que NEM CHEGA ao middleware]");
//
// `decidirAcesso()` só é consultada para caminhos que o matcher deixa
// passar. Provar a política sem provar o matcher deixaria de fora
// exatamente a camada onde apareceu o achado do `_next` (F0.b.1).
//
// O matcher precisa ser um LITERAL em middleware.ts (o Next extrai
// `config.matcher` estaticamente no build), então ele não pode ser
// importado daqui. A alternativa honesta é ler o arquivo e validar o
// literal — assim uma edição futura no middleware quebra este teste em
// vez de passar despercebida.

const FONTE_MIDDLEWARE = fs.readFileSync(path.join(process.cwd(), "middleware.ts"), "utf8");
const MATCHER_ESPERADO = "/((?!_next|favicon.ico).*)";

function extrairMatcher(fonte: string): string[] {
  const bloco = fonte.match(/matcher:\s*\[([\s\S]*?)\]/);
  if (!bloco) throw new Error("nao encontrei config.matcher em middleware.ts");
  return [...bloco[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
}

const MATCHERS = extrairMatcher(FONTE_MIDDLEWARE);

/** Semântica do Next para padrão simples: casamento ancorado no pathname inteiro. */
function matcherCasa(caminho: string): boolean {
  return MATCHERS.some(p => new RegExp(`^${p}$`).test(caminho));
}

t("33. middleware.ts declara exatamente o matcher esperado", () => {
  assert(MATCHERS.length === 1, `esperado 1 matcher, encontrado ${MATCHERS.length}`);
  assert(MATCHERS[0] === MATCHER_ESPERADO,
    `matcher divergente.\n  esperado: ${MATCHER_ESPERADO}\n  encontrado: ${MATCHERS[0]}`);
});

t("34. infraestrutura interna do Next fica FORA do middleware", () => {
  for (const caminho of [
    "/_next/static/chunks/main-app.js",
    "/_next/static/css/app.css",
    "/_next/static/media/fonte.woff2",
    "/_next/image",
    "/_next/webpack-hmr",
    "/_next/data/build/pagina.json",
    "/favicon.ico",
  ]) assert(!matcherCasa(caminho), `${caminho} NAO deveria entrar no middleware`);
});

t("35. caminhos da CDS continuam ENTRANDO no middleware", () => {
  for (const caminho of [
    "/", "/login", "/verificar-email", "/dashboard",
    `/central-ia/estudio-anuncios/${UUID}`,
    "/api/dashboard/resumo",
    "/api/estudio-anuncios/projetos",
    "/api/internal/estudio-anuncios/worker",
    "/api/sync",
    "/logo-cds.png",
  ]) assert(matcherCasa(caminho), `${caminho} DEVERIA entrar no middleware`);
});

t("36. o matcher nao usa mais a forma antiga (dois casos de _next)", () => {
  assert(!FONTE_MIDDLEWARE.includes("_next/static|_next/image"),
    "matcher ainda excluindo apenas _next/static e _next/image");
});

// ────────────────────────────────────────────────────────────────────
// 10. INTEGRAÇÃO HTTP — cadeia real: matcher → middleware → decidirAcesso
//
// Opt-in: só roda com um servidor local de pé.
//   Terminal 1:  npm run dev
//   Terminal 2:  MIDDLEWARE_HTTP_BASE=http://localhost:3000 npx tsx scripts/testar-middleware.ts
//
// Sem cookie em nenhuma requisição. Nada é escrito; só GET.
const BASE = process.env.MIDDLEWARE_HTTP_BASE;

type CasoHttp = { caminho: string; esperado: "passou" | "redirect_login" | "401_json"; nota: string };

const CASOS_HTTP: CasoHttp[] = [
  // fora do middleware — o Next responde o que responder (200/400/404),
  // mas NUNCA um redirect para /login
  { caminho: "/_next/static/chunks/nao-existe.js", esperado: "passou", nota: "matcher exclui _next" },
  { caminho: "/_next/image?url=%2Flogo-cds.png&w=64&q=75", esperado: "passou", nota: "matcher exclui _next" },
  { caminho: "/_next/webpack-hmr", esperado: "passou", nota: "matcher exclui _next" },
  { caminho: "/favicon.ico", esperado: "passou", nota: "matcher exclui favicon" },
  // dentro do middleware
  { caminho: "/login", esperado: "passou", nota: "pagina publica" },
  { caminho: "/dashboard", esperado: "redirect_login", nota: "pagina protegida" },
  { caminho: "/api/dashboard/resumo", esperado: "401_json", nota: "API protegida" },
];

async function rodarHttp(base: string) {
  console.log(`\n[10. integracao HTTP contra ${base} — cadeia real]`);
  for (const caso of CASOS_HTTP) {
    const nome = `${caso.caminho}  (${caso.nota})`;
    try {
      const res = await fetch(base + caso.caminho, { redirect: "manual", headers: { cookie: "" } });
      const location = res.headers.get("location") ?? "";
      const ehRedirectLogin = (res.status === 307 || res.status === 302) && location.includes("/login");

      if (caso.esperado === "passou") {
        assert(!ehRedirectLogin, `interceptado pelo middleware (status ${res.status} -> ${location})`);
      } else if (caso.esperado === "redirect_login") {
        assert(ehRedirectLogin, `esperava redirect para /login, veio status ${res.status}`);
        assert(location.includes("redirect=%2Fdashboard") || location.includes("redirect=/dashboard"),
          `redirect sem preservar o destino: ${location}`);
      } else {
        assert(res.status === 401, `esperava 401, veio ${res.status}`);
        const tipo = res.headers.get("content-type") ?? "";
        assert(tipo.includes("application/json"), `esperava JSON, veio "${tipo}"`);
        const corpo: any = await res.json();
        assert(corpo?.erro === true, "corpo 401 sem { erro: true }");
      }
      ok++; console.log(`  PASS  ${nome}`);
    } catch (e: any) {
      falhou++; console.log(`  FALHA ${nome} -> ${e?.message ?? e}`);
    }
  }
}

async function principal() {
  if (BASE) {
    await rodarHttp(BASE);
  } else {
    console.log("\n[10. integracao HTTP] SKIP — defina MIDDLEWARE_HTTP_BASE com `npm run dev` no ar");
    console.log("     ex.: MIDDLEWARE_HTTP_BASE=http://localhost:3000 npx tsx scripts/testar-middleware.ts");
  }

  console.log(`\n=== RESULTADO: ${ok} passaram, ${falhou} falharam ===\n`);
  if (falhou > 0) process.exit(1);
}

void principal();
