/**
 * Guard de schema de `public.anuncios` (SEC-3-B3.3).
 *
 * ── A falha que isto fecha ──────────────────────────────────────────
 * O SEC-3-B2 montou a projeção de GET /api/anuncios a partir da interface
 * TypeScript `Anuncio`, que tem campos derivados (`lucro_liquido`,
 * `margem_contribuicao`) inexistentes na tabela. O PostgREST recusou o
 * SELECT, a rota respondeu 500 e Meus Produtos ficou vazio no Preview. A
 * suite do B2 não pegou porque o banco dela era um duplo que aceita
 * qualquer coluna.
 *
 * ── A fonte de verdade ──────────────────────────────────────────────
 * `docs/schema/anuncios.colunas.json` — snapshot versionado do
 * information_schema (a tabela foi criada fora das migrations do repo).
 * Nada aqui usa duplo de banco: tudo é comparado com esse snapshot.
 *
 *  1. DB_ANUNCIO_COLUMNS == colunas do snapshot
 *  2. DERIVED_UI_FIELDS não são colunas
 *  3. projeções (tela, dashboard) ⊆ snapshot; a da tela sem user_id e sem loja_id
 *  4. whitelist de escrita ⊆ snapshot
 *  5. TODA cadeia `.from("anuncios")` do código (app/lib/components):
 *     colunas de select(...) literal e de filtros/ordem ⊆ snapshot
 *  6. auto-teste do scanner com violações sintéticas
 *
 * Uso: npx tsx scripts/testar-anuncios-esquema.ts
 */
import "./_server-only-inerte";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// ANUNCIOS SHOPEE MULTI-STORE V1B: colunas da migration pendente, so se ela for byte-exata
import { colunasPendentesAprovadasAnuncios } from "./_excecao-anuncios-multi-store";

let passou = 0, falhou = 0;
function t(nome: string, fn: () => void) {
  try { fn(); passou++; console.log(`  PASS  ${nome}`); }
  catch (e: any) { falhou++; console.log(`  FALHA ${nome} -> ${e?.message ?? e}`); }
}
function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }

const RAIZ = join(__dirname, "..");
const SNAPSHOT = JSON.parse(readFileSync(join(RAIZ, "docs/schema/anuncios.colunas.json"), "utf8"));
const COLUNAS = new Set<string>(SNAPSHOT.colunas.map((c: { nome: string }) => c.nome));
// ANUNCIOS SHOPEE MULTI-STORE V1B: o snapshot continua sendo o de PRODUCAO. As cadeias
// do codigo (#5) tambem aceitam as colunas da migration PENDENTE da fase 1 (loja_id) —
// SO via excecao exata (migration byte-exata por sha256); listas/projecoes (#1-#4) nao.
const COLUNAS_COM_PENDENTES = new Set<string>([...COLUNAS, ...colunasPendentesAprovadasAnuncios(RAIZ)]);

// ── Scanner: cadeias `.from("anuncios")` ─────────────────────────────

const FILTROS = ["eq", "neq", "in", "is", "not", "gt", "gte", "lt", "lte", "like", "ilike", "order", "contains", "filter"];

/** Colunas de uma lista de select do PostgREST ("a, b:c, d::text"). `*` = todas. */
function colunasDoSelect(lista: string): string[] {
  const saida: string[] = [];
  let nivel = 0, atual = "";
  for (const ch of lista) {
    if (ch === "(") nivel++;
    if (ch === ")") nivel--;
    if (ch === "," && nivel === 0) { saida.push(atual); atual = ""; continue; }
    atual += ch;
  }
  saida.push(atual);
  return saida.map((s) => s.trim()).filter((s) => s && s !== "*").map((s) => {
    // cast `col::tipo` sai primeiro; depois alias `apelido:col`. Relação
    // embutida `x(...)` aparece inteira, e é reprovada (anuncios não tem).
    const semCast = s.split("::")[0].trim();
    return semCast.includes(":") && !semCast.includes("(") ? semCast.split(":").pop()!.trim() : semCast;
  });
}

interface Achado { arquivo: string; linha: number; coluna: string; onde: string }

function varrer(arquivos: Map<string, string>, colunas: Set<string>): Achado[] {
  const achados: Achado[] = [];
  for (const [arquivo, bruto] of arquivos) {
    // comentários saem (preservando as quebras de linha, para o número da
    // linha continuar certo): documentação citando uma consulta não é consulta.
    const fonte = bruto
      .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "))
      .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
    const re = /\.from\(\s*["'`]anuncios["'`]\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(fonte))) {
      const linha = fonte.slice(0, m.index).split("\n").length;
      // a cadeia vai até o fim do statement
      const fim = fonte.indexOf(";", m.index);
      const cadeia = fonte.slice(m.index, fim < 0 ? undefined : fim);
      for (const s of cadeia.matchAll(/\.select\(\s*(["'`])([^"'`]*)\1/g)) {
        for (const c of colunasDoSelect(s[2])) {
          if (!colunas.has(c)) achados.push({ arquivo, linha, coluna: c, onde: "select" });
        }
      }
      for (const f of cadeia.matchAll(new RegExp(`\\.(${FILTROS.join("|")})\\(\\s*["'\`]([\\w.]+)["'\`]`, "g"))) {
        const c = f[2].split(".")[0];
        if (!colunas.has(c)) achados.push({ arquivo, linha, coluna: c, onde: f[1] });
      }
    }
  }
  return achados;
}

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: RAIZ, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const arquivos = new Map(
  [...new Set(git("ls-files", "--cached", "--others", "--exclude-standard", "app", "lib", "components")
    .split(/\r?\n/).filter((f) => /\.(ts|tsx|js|mjs)$/.test(f)))]
    .map((f) => [f, readFileSync(join(RAIZ, f), "utf8")] as [string, string]),
);

async function principal() {
  const colunas = await import("../lib/anuncios/colunas");
  const servico = await import("../lib/anuncios/servico");

  console.log("\n[1-4. listas e projeções contra o snapshot]");
  t("0. o snapshot é de public.anuncios e tem colunas", () => {
    assert(SNAPSHOT.tabela === "public.anuncios" && COLUNAS.size >= 20, `${SNAPSHOT.tabela} ${COLUNAS.size}`);
  });
  t("1. DB_ANUNCIO_COLUMNS é exatamente o conjunto do snapshot", () => {
    const lista = [...colunas.DB_ANUNCIO_COLUMNS].sort();
    const snap = [...COLUNAS].sort();
    assert(JSON.stringify(lista) === JSON.stringify(snap), `lista=${lista} snapshot=${snap}`);
  });
  t("2. DERIVED_UI_FIELDS não são colunas (e incluem os dois que quebraram o B2)", () => {
    for (const d of colunas.DERIVED_UI_FIELDS) assert(!COLUNAS.has(d), `${d} é coluna`);
    assert(colunas.DERIVED_UI_FIELDS.includes("lucro_liquido") && colunas.DERIVED_UI_FIELDS.includes("margem_contribuicao"), "derivados");
  });
  t("3a. projeção da TELA ⊆ snapshot e sem user_id", () => {
    const cols = colunasDoSelect(servico.COLUNAS_ANUNCIO_TELA);
    const fora = cols.filter((c) => !COLUNAS.has(c));
    assert(fora.length === 0, `fora do schema: ${fora}`);
    assert(!cols.includes("user_id"), "tela devolve user_id");
  });
  t("3d. loja_id e coluna (DB_ANUNCIO_COLUMNS) mas NAO vai a tela: projecao sem user_id e sem loja_id", () => {
    assert((colunas.DB_ANUNCIO_COLUMNS as readonly string[]).includes("loja_id"), "DB_ANUNCIO_COLUMNS sem loja_id");
    const cols = colunasDoSelect(servico.COLUNAS_ANUNCIO_TELA);
    assert(!cols.includes("user_id") && !cols.includes("loja_id"), `tela expoe: ${cols.filter((c) => c === "user_id" || c === "loja_id")}`);
    // tudo o mais continua na tela (payload inalterado): DB − {user_id, loja_id}, na ordem do banco
    assert(cols.join() === colunas.DB_ANUNCIO_COLUMNS.filter((c) => c !== "user_id" && c !== "loja_id").join(), "projecao da tela mudou");
  });
  t("3b. projeção do DASHBOARD ⊆ snapshot", () => {
    const fora = colunasDoSelect(servico.COLUNAS_ANUNCIO_DASHBOARD).filter((c) => !COLUNAS.has(c));
    assert(fora.length === 0, `fora do schema: ${fora}`);
  });
  t("3c. as projeções vêm de ./colunas, não da interface Anuncio", () => {
    const s = readFileSync(join(RAIZ, "lib/anuncios/servico.ts"), "utf8");
    assert(/from "\.\/colunas"/.test(s), "servico não usa ./colunas");
    assert(!/from "@\/lib\/supabase"/.test(s), "servico importa lib/supabase");
  });
  t("4. whitelist de escrita (CAMPOS_GRAVAVEIS) ⊆ snapshot e sem derivados", () => {
    const fora = Object.keys(servico.CAMPOS_GRAVAVEIS).filter((c) => !COLUNAS.has(c));
    assert(fora.length === 0, `fora do schema: ${fora}`);
  });

  console.log("\n[5. toda cadeia .from(\"anuncios\") do código]");
  t("5. nenhuma coluna fora do schema em select literal, filtro ou ordem", () => {
    const achados = varrer(arquivos, COLUNAS_COM_PENDENTES);
    assert(achados.length === 0, achados.map((a) => `${a.arquivo}:${a.linha} ${a.onde}(${a.coluna})`).join(" | "));
  });
  t("5c. snapshot = PRODUCAO com a fase 1 aplicada: loja_id uuid, nulo, sem default, ultima coluna; nada pendente fora do snapshot", () => {
    const loja = SNAPSHOT.colunas.find((c: { nome: string }) => c.nome === "loja_id");
    assert(loja && loja.tipo === "uuid" && loja.nulo === true && loja.default === false, JSON.stringify(loja));
    assert(SNAPSHOT.colunas[SNAPSHOT.colunas.length - 1].nome === "loja_id", "loja_id fora da posicao do banco (25, ultima)");
    // a excecao da migration (ainda pinada) nao acrescenta nada alem do snapshot real
    const pend = colunasPendentesAprovadasAnuncios(RAIZ);
    assert(pend.every((c) => COLUNAS.has(c)), `pendente fora do snapshot: ${pend}`);
  });
  t("5b. o scanner de fato encontrou as cadeias conhecidas (não está cego)", () => {
    const comCadeia = [...arquivos].filter(([, s]) => /\.from\(\s*["'`]anuncios["'`]\s*\)/.test(s)).map(([f]) => f);
    for (const f of ["lib/anuncios/servico.ts", "app/api/ml/importar-anuncios/route.ts", "app/api/shopee/importar-anuncios/route.ts", "lib/sync-ml.ts"]) {
      assert(comCadeia.includes(f), `${f} não varrido`);
    }
  });

  console.log("\n[6. auto-teste do scanner]");
  t("6a. select(\"coluna_que_nao_existe\") é pego, com arquivo e linha", () => {
    const a = varrer(new Map([["app/api/x/route.ts", `\n\nawait c.from("anuncios").select("id, coluna_que_nao_existe").eq("user_id", u);`]]), COLUNAS);
    assert(a.length === 1 && a[0].coluna === "coluna_que_nao_existe" && a[0].linha === 3 && a[0].onde === "select", JSON.stringify(a));
  });
  t("6b. os dois campos derivados do B2 em select são pegos", () => {
    const a = varrer(new Map([["lib/y.ts", `c.from('anuncios').select('id, lucro_liquido, margem_contribuicao');`]]), COLUNAS);
    assert(a.map((x) => x.coluna).sort().join() === "lucro_liquido,margem_contribuicao", JSON.stringify(a));
  });
  t("6c. filtro e ordem por coluna inexistente são pegos", () => {
    // (loja_id deixou de ser o exemplo negativo: e coluna do contrato multi-loja — migration pendente)
    const a = varrer(new Map([["lib/z.ts", `c.from("anuncios").select("id").eq("coluna_inexistente_guard_test", x).order("atualizado_em", { ascending: false });`]]), COLUNAS_COM_PENDENTES);
    assert(a.map((x) => `${x.onde}:${x.coluna}`).sort().join() === "eq:coluna_inexistente_guard_test,order:atualizado_em", JSON.stringify(a));
  });
  t("6d. alias, cast e * são aceitos; outras tabelas são ignoradas", () => {
    const a = varrer(new Map([["lib/w.ts",
      `c.from("anuncios").select("*, titulo:nome, preco_anuncio::text").eq("ativo", true);\nc.from("pedidos").select("coluna_de_outra_tabela");`]]), COLUNAS);
    assert(a.length === 0, JSON.stringify(a));
  });

  console.log(`\n${falhou === 0 ? "✓" : "✗"} ANUNCIOS-ESQUEMA — ${passou} passaram, ${falhou} falharam`);
  process.exit(falhou === 0 ? 0 : 1);
}

principal().catch((e) => { console.error("ERRO FATAL", e); process.exit(1); });
