/**
 * Suite da frente LOJAS-ANON-SELECT.
 *
 * Prova a invariante:
 *
 *   "Nenhum codigo de runtime le `public.lojas` com o cliente ANON."
 *
 * ── Por que esta invariante e a que importa ─────────────────────────
 * A tabela `lojas` nao tem RLS, nao tem policy e nao tem ACL de coluna.
 * O GRANT de SELECT a `anon` e, portanto, irrestrito: linha inteira,
 * coluna inteira — `access_token`, `refresh_token` e `partner_key` de
 * TODOS os tenants. E a chave anon nao e segredo: o Next a inlina nos
 * chunks client (confirmado: 2 arquivos em `.next/static/`).
 *
 * Enquanto UM leitor de runtime depender de `anon`, o
 * `REVOKE SELECT ... FROM anon` nao pode ser executado. Esta suite existe
 * para que essa dependencia nao volte por descuido — e para que o REVOKE,
 * quando acontecer, nao quebre producao.
 *
 * ── Instrumento ─────────────────────────────────────────────────────
 * Inspecao de fonte, sem rede e sem banco. E o instrumento CORRETO aqui:
 * a invariante e sobre QUAL CLIENTE o codigo usa, e isso e propriedade
 * estatica do texto — nao se observa chamando a funcao.
 *
 * LIMITE DECLARADO: a suite nao prova que o GRANT foi revogado. Isso e
 * fato do banco, verificado por probe em gate proprio, e permanece
 * PENDENTE nesta etapa — por decisao explicita: o codigo vai primeiro.
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

const RAIZ = join(__dirname, "..");
const fonte = (rel: string) => readFileSync(join(RAIZ, rel), "utf8");

/** Fonte SEM comentarios — este projeto documenta o que decidiu NAO fazer. */
const codigo = (rel: string) =>
  fonte(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

let passou = 0;
let falhou = 0;
function ok(nome: string, condicao: boolean) {
  if (condicao) {
    passou++;
  } else {
    falhou++;
    console.error(`  ✗ ${nome}`);
  }
}

const CAPABILITY = "lib/marketplace/credenciais.ts";
const SERVIDOR = "lib/estudio-anuncios/supabase-servidor.ts";

/** Varre app/ e lib/ recursivamente. `scripts/` fica de fora: nao e runtime. */
function arquivosRuntime(): string[] {
  const out: string[] = [];
  for (const base of ["app", "lib"]) {
    const pilha = [join(RAIZ, base)];
    while (pilha.length) {
      const dir = pilha.pop()!;
      for (const nome of readdirSync(dir)) {
        const p = join(dir, nome);
        if (statSync(p).isDirectory()) {
          if (nome !== "node_modules") pilha.push(p);
        } else if (/\.tsx?$/.test(nome)) {
          out.push(relative(RAIZ, p).replace(/\\/g, "/"));
        }
      }
    }
  }
  return out;
}

const RUNTIME = arquivosRuntime();

// ══════════════════════════════════════════════════════════════════════
// 1-3 — A INVARIANTE CENTRAL
// ══════════════════════════════════════════════════════════════════════
{
  const tocam = RUNTIME.filter((f) => /\.from\("lojas"\)/.test(codigo(f)));

  ok(
    "1. exatamente UM arquivo de runtime acessa `lojas`",
    tocam.length === 1 && tocam[0] === CAPABILITY
  );
  if (tocam.length !== 1 || tocam[0] !== CAPABILITY) {
    console.error(`     acessos fora da capability: ${tocam.filter((f) => f !== CAPABILITY).join(", ")}`);
  }

  // A capability usa `service_role` e NUNCA a chave anon.
  const cap = codigo(CAPABILITY);
  ok("2. a capability usa getSupabaseServidor()", /getSupabaseServidor\(\)/.test(cap));
  ok("3. a capability NAO menciona a chave anon", !/NEXT_PUBLIC_SUPABASE_ANON_KEY/.test(cap));
}

// ══════════════════════════════════════════════════════════════════════
// 4-12 — OS 9 CALL SITES MIGRADOS, um assert cada
// ══════════════════════════════════════════════════════════════════════
{
  // A lista e literal de proposito: se alguem reintroduzir o acesso em
  // qualquer um destes, o assert 1 pega — mas estes nomeiam o culpado.
  const MIGRADOS = [
    "app/api/sync/route.ts",
    "app/api/sync/iniciar/route.ts",
    "app/api/lojas/route.ts",
    "app/api/ml/vendas/route.ts",
    "app/api/admin/backfill-resumos-diarios/route.ts",
    "app/api/estudio-anuncios/projetos/[id]/marketplaces/[marketplace]/lojas/route.ts",
    "lib/ml-auth.ts",
    "lib/sync-ml.ts",
    "lib/estudio-anuncios/compliance/ml-conta.ts",
  ] as const;

  let n = 4;
  for (const f of MIGRADOS) {
    ok(`${n}. ${f} nao acessa mais \`lojas\` diretamente`, !/\.from\("lojas"\)/.test(codigo(f)));
    n++;
  }
}

// ══════════════════════════════════════════════════════════════════════
// 13-16 — O CRON entra explicitamente (TIMEOUT1b nao o protege daqui)
// ══════════════════════════════════════════════════════════════════════
{
  const cron = codigo("app/api/sync/route.ts");

  ok("13. cron usa a capability de leitura para o agrupamento", /listarLojasAtivasParaCron\(\)/.test(cron));
  ok("14. cron NAO instancia mais cliente anon", !/NEXT_PUBLIC_SUPABASE_ANON_KEY/.test(cron));
  ok("15. cron NAO importa createClient", !/import \{ createClient \}/.test(cron));
  // A TIMEOUT1b continua ativa neste mesmo arquivo — as duas frentes
  // coexistem e nenhuma pode apagar a outra.
  ok("16. o modo incremental da TIMEOUT1b permanece intacto", /modo:\s*["']incremental["']/.test(cron));
}

// ══════════════════════════════════════════════════════════════════════
// 17-20 — HELPER SERVER-ONLY
// ══════════════════════════════════════════════════════════════════════
{
  const src = fonte(SERVIDOR);
  const cod = codigo(SERVIDOR);

  ok("17. supabase-servidor tem `import \"server-only\"`", /^import "server-only";$/m.test(src));
  ok("18. a credencial e SUPABASE_SERVICE_ROLE_KEY", /const chave = process\.env\.SUPABASE_SERVICE_ROLE_KEY/.test(cod));
  ok(
    "19. NEXT_PUBLIC_* nunca e usado como CREDENCIAL (so como URL)",
    !/NEXT_PUBLIC_[A-Z_]*KEY/.test(cod)
  );
  ok(
    "20. fail-closed: lanca se a service role faltar",
    /if \(!chave\) \{[\s\S]{0,200}throw new Error/.test(cod)
  );
}

// ══════════════════════════════════════════════════════════════════════
// 21-30 — CONTRATO DAS CAPABILITIES NOVAS
// ══════════════════════════════════════════════════════════════════════
{
  const cap = codigo(CAPABILITY);
  const corpo = (nome: string) => {
    const i = cap.indexOf(`export async function ${nome}`);
    if (i < 0) return "";
    const resto = cap.slice(i + 1);
    const j = resto.indexOf("\nexport ");
    return resto.slice(0, j < 0 ? undefined : j);
  };

  const NOVAS = [
    "listarLojasAtivasParaCron",
    "lerLojaParaValidacaoDeJob",
    "listarLojasAtivasDoDono",
    "lerIdLojaMLAtivaMaisRecenteDoDono",
    "listarLojasDoDonoPorIds",
    "listarLojasConectadasDoDono",
    "lerLojaParaPublicacaoML",
  ] as const;

  ok("21. as 7 operacoes novas existem e sao exportadas", NOVAS.every((f) => corpo(f) !== ""));

  ok(
    "22. NENHUMA operacao nova projeta coluna de credencial",
    NOVAS.every((f) => !/(access_token|refresh_token|partner_key|partner_id)\s*[,"]/.test(
      (corpo(f).match(/\.select\([^)]*\)/g) ?? []).join(" ")
    ))
  );
  ok(
    "23. NENHUMA operacao nova usa select(\"*\")",
    NOVAS.every((f) => !/\.select\(\s*["'`]\*/.test(corpo(f)))
  );
  ok(
    "24. NENHUMA operacao nova vaza error.message",
    NOVAS.every((f) => !/error\.message/.test(corpo(f)))
  );
  ok(
    "25. TODAS devolvem codigo estavel em erro",
    NOVAS.every((f) => /erro: "erro_consulta_loja"/.test(corpo(f)))
  );
  ok(
    "26. TODAS logam linha estatica, sem lojaId/userId",
    NOVAS.every((f) => {
      const logs = (corpo(f).match(/console\.error\([^)]*\)/g) ?? []).join(" ");
      return logs === "" || (!/lojaId/.test(logs) && !/userId/.test(logs) && !/\$\{/.test(logs));
    })
  );

  // Tenant scoping: seis filtram por dono; a do cron NAO, e isso e requisito.
  const TENANT = NOVAS.filter((f) => f !== "listarLojasAtivasParaCron");
  ok(
    "27. as 6 operacoes tenant-scoped filtram por user_id DENTRO da query",
    TENANT.every((f) => /user_id|filtrosGravacaoPorLojaEDono|filtrosMLAtivaDoDono/.test(corpo(f)))
  );
  ok(
    "28. a operacao do cron e a UNICA cross-tenant",
    !/user_id["']\s*,\s*String/.test(corpo("listarLojasAtivasParaCron"))
  );
  ok(
    "29. a operacao do cron projeta so (user_id, marketplace)",
    /\.select\("user_id, marketplace"\)/.test(corpo("listarLojasAtivasParaCron"))
  );
  ok(
    "30. a listagem de conectadas filtra por token sem projeta-lo",
    /\.not\("access_token", "is", null\)/.test(corpo("listarLojasConectadasDoDono")) &&
      !/\.select\("[^"]*access_token/.test(corpo("listarLojasConectadasDoDono"))
  );
}

// ══════════════════════════════════════════════════════════════════════
// 31-35 — ml-conta.ts: comportamento preservado
// ══════════════════════════════════════════════════════════════════════
{
  const cod = codigo("lib/estudio-anuncios/compliance/ml-conta.ts");
  const fn = cod.slice(cod.indexOf("export async function carregarContaML"));

  ok("31. usa a capability nova", /lerLojaParaPublicacaoML\(params\.lojaId, params\.userId\)/.test(fn));
  // Opcao (a) aprovada: a assinatura NAO muda nesta PR.
  ok("32. o parametro `supabase` permanece na assinatura", /supabase: SupabaseClient/.test(fn));
  // As tres checagens sao defesa em profundidade — o filtro na query e
  // camada NOVA, nao substituta.
  ok("33. checagem de user_id preservada", /String\(loja\.user_id\) !== params\.userId/.test(fn));
  ok("34. checagens de marketplace e ativo preservadas",
    /loja\.marketplace !== params\.marketplace/.test(fn) && /loja\.ativo !== true/.test(fn));
  // Erro de banco NAO pode virar "loja nao encontrada".
  ok("35. erro de banco continua sendo throw, nunca `return null`", /if \(erro\) throw new Error/.test(fn));
}

// ══════════════════════════════════════════════════════════════════════
// 36-38 — CLASSE A: capabilities existentes, sem ampliar projecao
// ══════════════════════════════════════════════════════════════════════
{
  ok(
    "36. ml-auth usa lerCredencialMLPorLojaEDono (capability existente)",
    /lerCredencialMLPorLojaEDono\(lojaIdBruto, userId\)/.test(codigo("lib/ml-auth.ts"))
  );
  ok(
    "37. sync-ml usa listarLojasMLDoDonoPorSeller (capability existente)",
    /listarLojasMLDoDonoPorSeller\(userId, sellerId\)/.test(codigo("lib/sync-ml.ts"))
  );
  // A projecao de credencial nao pode ter crescido para acomodar ninguem.
  ok(
    "38. COLUNAS_ML permanece inalterada",
    /const COLUNAS_ML = "id, nickname, seller_id, access_token, refresh_token, token_expires_at";/.test(
      codigo(CAPABILITY)
    )
  );
}

console.log(`\n${falhou === 0 ? "✓" : "✗"} LOJAS-ANON-SELECT — ${passou} passaram, ${falhou} falharam`);
process.exit(falhou === 0 ? 0 : 1);
