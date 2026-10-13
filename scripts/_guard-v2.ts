/**
 * GUARD V2 — invariantes estruturais compartilhadas (CDS V2, Fase 0B).
 *
 * Substituem as cercas "arquivo X não mudou desde o commit Y" (+ 13 camadas de exceção) por
 * regras que valem em QUALQUER commit:
 *
 *   I1  o canônico (worker/coordenador/planner/intraday/ingestão/canônico/rotas internas de
 *       vendas-sync) NUNCA alcança o legado (sync-shopee/sync-ml, rotas /api/sync e
 *       /api/internal/sync, sync-worker.mjs) — única ligação permitida, nominal:
 *       lib/shopee/ingestao/normalizar.ts ← { mapStatus } de lib/sync-shopee.ts (função pura);
 *   I2  só lib/vendas/sync/** manipula job CANÔNICO (janela/campo_tempo/listagem_completa/checkpoint
 *       de sync_jobs) — o legado nunca cria nem muta job canônico;
 *   I3  nenhuma seleção implícita de loja nova: Shopee "mais recente" = 0 chamadores; os usos ML
 *       ainda existentes (dívida da Fase 1) são uma lista FECHADA — chamador novo = falha;
 *   I4  toda rota em app/api/internal/** exige segredo (CRON_SECRET ou x-worker-secret);
 *   I5  ML_SKU_SYNC_NEVER_READS_OR_WRITES_SHOPEE_ROWS (Fase 0C → 2D): em TODO runtime que fala com o ML (detectado),
 *       toda leitura/escrita de anuncios filtra marketplace = "ML" E loja_id, e a leitura é paginada —
 *       row Shopee nunca chega ao provider ML nem é escrita por ele, e lojas ML do dono não se misturam;
 *   I6  I6_STORE_IDENTITY_IS_EXPLICIT (Fase 1A): o fallback técnico "<Marketplace> <id>" só nasce em
 *       lib/lojas/identidade.ts; nome de loja só é gravado via camposDeNomeParaGravar na capability
 *       (nunca por rota/navegador, nunca dados.nome cru); callbacks extraem nome só pelos parsers
 *       canônicos; o callback Shopee não troca a loja em uso; nenhum runtime decide por
 *       shop_id/seller_id literal nem traz nome de loja embutido ("mais recente" segue em I3);
 *   I7  I7_ML_CREDENTIALS_ARE_STORE_SCOPED (Fase 1B): cookie de token ML não é fonte nem destino de
 *       credencial (só DELETE legado); nenhum seletor implícito tem chamador; toda rota ML resolve a conta
 *       por loja no servidor; loja única só por opt-in; sync ML exige loja; vendas legadas multi-ML
 *       falham fechado antes de provider/escrita; catálogo multi-ML liberado (Fase 2F) com a loja da
 *       ação validada no servidor antes de provider/banco; item-thumbnails exige sessão;
 *   I8  I8_ML_CATALOG_IS_STORE_SCOPED (Fase 2D): leitura/escrita ML com loja_id; todo INSERT com loja_id
 *       explícito (runtime não depende da ponte do trigger); Import ML V2 com loja obrigatória e cursor preso
 *       à loja; mapa de custo loja|item|variação; manual ML sem identidade do provider e com loja do
 *       servidor; identidade imutável no PATCH; Meus Produtos agrupa por marketplace|loja_id|item; a ação leva a loja;
 *   Z   ZONAS PROTEGIDAS sem suíte comportamental própria (telas legadas de Vendas/Dashboard,
 *       constantes financeiras, supabase/**, vercel.json, .env.example, sync-worker.mjs): mudar
 *       exige re-baseline EXPLÍCITO de scripts/zonas-protegidas.json (aparece no diff), nunca
 *       uma camada de exceção nem um commit-base.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const RAIZ_V2 = join(__dirname, "..");
const lf = (s: string) => s.replace(/\r\n/g, "\n");
const ler = (raiz: string, rel: string) => lf(readFileSync(join(raiz, rel), "utf8"));
const listar = (raiz: string, ...caminhos: string[]) =>
  execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", ...caminhos], { cwd: raiz, encoding: "utf8" })
    .split(/\r?\n/).filter((f) => f && existsSync(join(raiz, f)));

// ── I1: grafo de imports ──────────────────────────────────────────────
type Aresta = { de: string; para: string; simbolos: string[] | null };
function resolver(raiz: string, de: string, spec: string): string | null {
  let base: string | null = null;
  if (spec.startsWith("@/")) base = spec.slice(2);
  else if (spec.startsWith(".")) base = join(de, "..", spec).replace(/\\/g, "/");
  if (base === null) return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}.mjs`, `${base}.js`]) if (existsSync(join(raiz, c)) && /\.(ts|tsx|mjs|js)$/.test(c)) return c;
  return null;
}
export function arestas(raiz: string, arquivo: string): Aresta[] {
  const s = ler(raiz, arquivo).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const out: Aresta[] = [];
  for (const m of s.matchAll(/import\s+(type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/g)) {
    if (m[1]) continue;                                                  // import type não executa nada
    const para = resolver(raiz, arquivo, m[3]); if (!para) continue;
    const chaves = /\{([\s\S]*?)\}/.exec(m[2]);
    const simbolos = chaves && !/^\s*\*/.test(m[2]) && !/^\s*\w+\s*,/.test(m[2])
      ? chaves[1].split(",").map((x) => x.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]).filter(Boolean) : null;
    out.push({ de: arquivo, para, simbolos });
  }
  for (const m of s.matchAll(/(?:import|require)\(\s*["']([^"']+)["']\s*\)/g)) {
    const para = resolver(raiz, arquivo, m[1]); if (para) out.push({ de: arquivo, para, simbolos: null });
  }
  for (const m of s.matchAll(/^\s*import\s+["']([^"']+)["'];?/gm)) {
    const para = resolver(raiz, arquivo, m[1]); if (para) out.push({ de: arquivo, para, simbolos: null });
  }
  return out;
}
export const RAIZES_CANONICAS = ["lib/vendas", "lib/shopee/ingestao", "lib/mercado-livre/ingestao", "app/api/internal/vendas-sync"];
export const LEGADO = (f: string) => f === "lib/sync-shopee.ts" || f === "lib/sync-ml.ts" || f === "scripts/sync-worker.mjs"
  || f.startsWith("app/api/sync/") || f.startsWith("app/api/internal/sync/");
/** Ligações canônico → legado permitidas, NOMINAIS (arquivo de origem, alvo, símbolos). */
export const PONTES_PERMITIDAS = [{ de: "lib/shopee/ingestao/normalizar.ts", para: "lib/sync-shopee.ts", simbolos: ["mapStatus"] }];

/** Violações de I1: caminhos canônico → legado fora das pontes nominais (BFS sem entrar no legado). */
export function canonicoAlcancaLegado(raiz = RAIZ_V2): string[] {
  const raizes = listar(raiz, ...RAIZES_CANONICAS).filter((f) => /\.(ts|tsx)$/.test(f));
  const visto = new Set<string>(raizes), fila = [...raizes], via = new Map<string, string>();
  const violacoes: string[] = [];
  while (fila.length) {
    const atual = fila.shift()!;
    for (const a of arestas(raiz, atual)) {
      if (LEGADO(a.para)) {
        const ponte = PONTES_PERMITIDAS.find((p) => p.de === a.de && p.para === a.para);
        if (!ponte || a.simbolos === null || !a.simbolos.every((x) => ponte.simbolos.includes(x))) {
          let cam = a.de; const cad = [a.para, a.de]; while (via.has(cam)) { cam = via.get(cam)!; cad.push(cam); }
          violacoes.push(cad.reverse().join(" → ") + (a.simbolos ? ` {${a.simbolos.join(",")}}` : " {*}"));
        }
        continue;                                                          // nunca atravessa o legado
      }
      if (!visto.has(a.para)) { visto.add(a.para); via.set(a.para, atual); fila.push(a.para); }
    }
  }
  return violacoes;
}

// ── I2: o legado nunca cria nem muta job canônico ──────────────────────
/** Domínio canônico: aqui job canônico é legítimo. */
export const DOMINIO_CANONICO = (f: string) => f.startsWith("lib/vendas/") || f.startsWith("lib/shopee/ingestao/")
  || f.startsWith("lib/mercado-livre/ingestao/") || f.startsWith("app/api/internal/vendas-sync/");
export const CAMPOS_JOB_CANONICO = /\b(janela_inicio|janela_fim|campo_tempo|listagem_completa)\s*:/;
/**
 * Fora do domínio canônico, nenhuma escrita em sync_jobs DEFINE campo de job canônico.
 * (Que o worker legado só REIVINDICA job legado — claim_next_sync_job cercado por
 * campo_tempo/checkpoint IS NULL — é provado linha a linha por testar-sync-legacy-fence.)
 */
export function legadoMexeEmJobCanonico(raiz = RAIZ_V2): string[] {
  const erros: string[] = [];
  for (const f of listar(raiz, "app", "lib", "scripts/sync-worker.mjs").filter((x) => /\.(ts|tsx|mjs)$/.test(x) && !DOMINIO_CANONICO(x))) {
    const s = ler(raiz, f);
    for (const m of s.matchAll(/\.from\(\s*["']sync_jobs["']\s*\)([\s\S]*?);/g)) {
      if (/\.(insert|update|upsert)\(/.test(m[1]) && CAMPOS_JOB_CANONICO.test(m[1])) erros.push(`${f}: escrita define campo de job canônico`);
    }
  }
  return erros;
}

// ── I3: seleção implícita de loja ──────────────────────────────────────
export const SELETOR_IMPLICITO = /\b(getShopeeLojaAtiva|getMLLojaAtiva|lerCredencialMLAtivaDoDono|lerIdLojaMLAtivaMaisRecenteDoDono)\(|resolverCredencialShopee\([^,()]+,\s*null\b/g;
/**
 * Arquivo → nº de usos tolerados. CDS V2 Fase 2G: a dívida ML zerou (getMLLojaAtiva,
 * lerCredencialMLAtivaDoDono e lerIdLojaMLAtivaMaisRecenteDoDono foram REMOVIDAS) — qualquer uso
 * ML volta a falhar. Shopee: só a definição de getShopeeLojaAtiva (0 chamadores).
 */
export const SELETORES_IMPLICITOS_CONHECIDOS: Record<string, number> = {
  "lib/shopee-auth.ts": 1,              // dentro de getShopeeLojaAtiva (definição, 0 chamadores)
};
export function seletoresImplicitos(raiz = RAIZ_V2): Record<string, number> {
  const r: Record<string, number> = {};
  for (const f of listar(raiz, "app", "lib", "components").filter((x) => /\.(ts|tsx)$/.test(x))) {
    const s = ler(raiz, f).replace(/^\s*export (async )?function \w+[\s\S]*?\{/gm, "");   // a declaração não conta como uso
    const n = (s.match(SELETOR_IMPLICITO) ?? []).length;
    if (n) r[f] = n;
  }
  return r;
}
export function seletoresImplicitosNovos(raiz = RAIZ_V2): string[] {
  const atual = seletoresImplicitos(raiz);
  return Object.entries(atual).filter(([f, n]) => n > (SELETORES_IMPLICITOS_CONHECIDOS[f] ?? 0)).map(([f, n]) => `${f}: ${n}`);
}

// ── I4: rotas internas exigem segredo ─────────────────────────────────
export function rotasInternasSemSegredo(raiz = RAIZ_V2): string[] {
  return listar(raiz, "app/api/internal").filter((f) => /route\.ts$/.test(f))
    .filter((f) => !/CRON_SECRET|x-worker-secret|autenticarRotaInterna|validarSegredo/.test(ler(raiz, f)));
}

// ── I5: ML nunca toca row Shopee; leitura/escrita operacional ML exige marketplace + LOJA (Fase 0C → 2D) ──
const tiraComentarios = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
/** Runtime (app, lib) que fala com o Mercado Livre — DETECTADO pelo conteúdo, não por lista. */
export function arquivosQueFalamComML(raiz = RAIZ_V2): string[] {
  return listar(raiz, "app", "lib").filter((f) => /\.(ts|tsx)$/.test(f))
    .filter((f) => /api\.mercadolibre\.com|\bresolverContaML\(|\bgetMLLojaById\(/.test(tiraComentarios(ler(raiz, f))));
}
export type CadeiaAnuncios = { arquivo: string; texto: string; tipo: "select" | "update" | "insert" | "upsert" | "delete" | "?"; paginada: boolean };
/** Toda cadeia `.from("anuncios")...;` de um arquivo (até o fim do comando). */
export function cadeiasAnuncios(raiz: string, arquivo: string): CadeiaAnuncios[] {
  const src = tiraComentarios(ler(raiz, arquivo));
  const out: CadeiaAnuncios[] = [];
  for (const m of src.matchAll(/\.from\(\s*["']anuncios["']\s*\)/g)) {
    const fim = src.indexOf(";", m.index!);
    const texto = src.slice(m.index!, fim < 0 ? undefined : fim);
    const tipo = (/^\.from\([^)]*\)\s*\.(select|update|insert|upsert|delete)\(/.exec(texto)?.[1] ?? "?") as CadeiaAnuncios["tipo"];
    out.push({ arquivo, texto, tipo, paginada: /lerTodasAsPaginas<\w+>\(\(\)\s*=>\s*[\w.]+\(?\)?\s*$/.test(src.slice(Math.max(0, m.index! - 80), m.index!)) });
  }
  return out;
}
export function leitoresMLSemMarketplace(raiz = RAIZ_V2): string[] {
  const erros: string[] = [];
  const arquivos = arquivosQueFalamComML(raiz);
  let cadeias = 0;
  for (const f of arquivos) {
    for (const c of cadeiasAnuncios(raiz, f)) {
      cadeias++;
      if (c.tipo === "insert") continue;                                        // INSERT: ver I8 (loja_id explícito)
      if (!c.texto.includes('.eq("marketplace", "ML")')) erros.push(`${f}: ${c.tipo} de anuncios sem marketplace = "ML" (row Shopee alcançável pelo ML)`);
      if (!/\.eq\("loja_id",/.test(c.texto)) erros.push(`${f}: ${c.tipo} de anuncios sem loja_id (lojas ML do mesmo dono se misturam)`);
      if (c.tipo === "select" && !c.paginada) erros.push(`${f}: leitura operacional de anuncios sem leitura paginada (PostgREST corta em 1000)`);
    }
  }
  if (!arquivos.length || cadeias === 0) erros.push("ANCORA: nenhum acesso operacional ML a anuncios encontrado (detector cego)");
  return erros;
}

// ── I6: identidade de loja explícita ─────────────────────────────────────
const semComentarios = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
export const ARQUIVO_IDENTIDADE = "lib/lojas/identidade.ts";
export const CALLBACK_SHOPEE = "app/api/auth/shopee/callback/route.ts";
export const CALLBACK_ML = "app/api/auth/mercadolivre/callback/route.ts";
export const CAPABILITY_LOJAS = "lib/marketplace/credenciais.ts";
/** Superfícies de identidade/seleção: aqui não pode haver nome nem id de loja embutido. */
export const SUPERFICIES_IDENTIDADE = [ARQUIVO_IDENTIDADE, "lib/lojas/resolver.ts", CAPABILITY_LOJAS, "lib/shopee-loja-selecao.ts",
  CALLBACK_SHOPEE, CALLBACK_ML, "app/api/lojas/route.ts", "app/api/lojas/ativar/route.ts", "components/TopBar.tsx", "app/(app)/configuracoes/page.tsx"];
export function identidadeDeLojaNaoExplicita(raiz = RAIZ_V2): string[] {
  const erros: string[] = [];
  const runtime = listar(raiz, "app", "lib", "components").filter((f) => /\.(ts|tsx)$/.test(f));
  for (const f of runtime) {
    const src = semComentarios(ler(raiz, f));
    if (f !== ARQUIVO_IDENTIDADE && /`(Shopee|Mercado Livre) \$\{/.test(src)) erros.push(`${f}: monta fallback técnico fora de ${ARQUIVO_IDENTIDADE}`);
    if (/\b(shop_?[iI]d|seller_?[iI]d)\s*[!=]==?\s*["'\d]/.test(src)) erros.push(`${f}: decisão por shop_id/seller_id literal`);
    if (f.startsWith("app/") && /\.from\(["']lojas["']\)/.test(src)) erros.push(`${f}: rota acessa lojas fora da capability`);
    if (f !== ARQUIVO_IDENTIDADE && /\.shop_name\b/.test(src)) erros.push(`${f}: lê shop_name fora do parser canônico`);
    // browser nunca dita nome real: só os callbacks OAuth (metadata vinda do provider) chamam registro/refresh de nome
    if (f.startsWith("app/") && f !== CALLBACK_SHOPEE && f !== CALLBACK_ML && /\b(atualizarMetadataDaLoja|registrarLojaShopeeOAuth|registrarCredencialMLOAuth)\(/.test(src))
      erros.push(`${f}: rota grava nome de loja (navegador não é autoridade de nome)`);
  }
  for (const f of SUPERFICIES_IDENTIDADE) {
    if (/monamor|r\.d\.|\b\d{8,}\b/i.test(semComentarios(ler(raiz, f)))) erros.push(`${f}: nome/id de loja embutido`);
  }
  const cap = semComentarios(ler(raiz, CAPABILITY_LOJAS));
  if (/\b(nome|nickname)\s*:\s*dados\./.test(cap)) erros.push(`${CAPABILITY_LOJAS}: grava nome de loja cru (fora de camposDeNomeParaGravar)`);
  if ((cap.match(/camposDeNomeParaGravar\(/g) ?? []).length < 5) erros.push(`${CAPABILITY_LOJAS}: registro/refresh de nome não passa por camposDeNomeParaGravar`);
  const cbS = semComentarios(ler(raiz, CALLBACK_SHOPEE)), cbM = semComentarios(ler(raiz, CALLBACK_ML));
  if (!/extrairNomeLojaShopee\(/.test(cbS)) erros.push(`${CALLBACK_SHOPEE}: nome sem o parser canônico`);
  if (!/extrairMetadataContaML\(/.test(cbM)) erros.push(`${CALLBACK_ML}: metadata sem o parser canônico`);
  if (/cookies\.set\(\s*["'](shopee_loja_id|loja_ativa_id)["']/.test(cbS)) erros.push(`${CALLBACK_SHOPEE}: conectar troca a loja em uso`);
  // metadata owner- e marketplace-scoped (leitura e escrita pelo par id+user_id; escrita também por marketplace)
  const iMeta = cap.indexOf("export async function atualizarMetadataDaLoja(");
  const meta = iMeta < 0 ? "" : cap.slice(iMeta, cap.indexOf("\nexport ", iMeta + 1));
  if (!meta) erros.push(`${CAPABILITY_LOJAS}: atualizarMetadataDaLoja ausente`);
  else {
    if ((meta.match(/\.eq\("user_id", dono\)/g) ?? []).length < 2) erros.push(`${CAPABILITY_LOJAS}: metadata sem escopo de dono na leitura e na escrita`);
    if (!/\.update\(campos\)[\s\S]{0,200}\.eq\("marketplace", marketplace\)/.test(meta)) erros.push(`${CAPABILITY_LOJAS}: escrita de metadata sem escopo de marketplace`);
  }
  // EXTERNAL_IDENTITY_IS_MARKETPLACE_SCOPED (Fase 1A-SCHEMA): seller_id é id externo POR marketplace
  for (const v of identidadeExternaSemMarketplace(raiz)) erros.push(`EXTERNAL_IDENTITY_IS_MARKETPLACE_SCOPED: ${v}`);
  // resolvedor explícito: sem ordenação/limite; loja única só sob opt-in
  const resolver = semComentarios(ler(raiz, "lib/lojas/resolver.ts"));
  if (/\.order\(|\.limit\(|created_at|\.sort\(/.test(resolver)) erros.push("lib/lojas/resolver.ts: resolvedor ordena/limita (seleção implícita)");
  if ((resolver.match(/doMarketplace\[0\]/g) ?? []).length !== 1 || !/pedido\.permitirUnica && doMarketplace\.length === 1\) return \{ ok: true, loja: paraResolvida\(doMarketplace\[0\]/.test(resolver))
    erros.push("lib/lojas/resolver.ts: loja escolhida sem pedido explícito");
  return erros;
}

/**
 * Identidade externa de loja = (user_id, marketplace, seller_id). Ids de marketplaces diferentes são
 * namespaces diferentes: nenhuma busca por seller_id sem marketplace, nenhum ON CONFLICT por seller_id,
 * nenhuma UNIQUE nova em lojas com seller_id sem marketplace — e a identidade escopada precisa existir.
 */
export function identidadeExternaSemMarketplace(raiz = RAIZ_V2): string[] {
  const erros: string[] = [];
  for (const f of listar(raiz, "app", "lib", "components").filter((x) => /\.(ts|tsx)$/.test(x))) {
    const src = semComentarios(ler(raiz, f));
    for (const m of src.matchAll(/\.from\(["']lojas["']\)[\s\S]*?;/g))
      if (/\.eq\(\s*["']seller_id["']/.test(m[0]) && !/\.eq\(\s*["']marketplace["']/.test(m[0])) erros.push(`${f}: busca loja por seller_id sem marketplace`);
    if (/onConflict\s*:\s*["'`][^"'`]*seller_id/.test(src)) erros.push(`${f}: ON CONFLICT por seller_id (identidade global)`);
  }
  const colunasUnicasLojas: string[][] = [];
  for (const f of listar(raiz, "supabase/migrations").filter((x) => x.endsWith(".sql"))) {
    const sql = ler(raiz, f).replace(/--.*$/gm, "");
    for (const m of sql.matchAll(/create\s+unique\s+index\s+(?:if\s+not\s+exists\s+)?\w+\s+on\s+(?:public\.)?lojas\s*\(([^)]*)\)/gi)) colunasUnicasLojas.push(m[1].split(",").map((c) => c.trim().toLowerCase()));
    for (const m of sql.matchAll(/alter\s+table\s+(?:public\.)?lojas[\s\S]*?unique\s*\(([^)]*)\)/gi)) colunasUnicasLojas.push(m[1].split(",").map((c) => c.trim().toLowerCase()));
  }
  for (const cols of colunasUnicasLojas) if (cols.includes("seller_id") && !cols.includes("marketplace")) erros.push(`migration cria UNIQUE em lojas (${cols.join(", ")}) sem marketplace`);
  if (!colunasUnicasLojas.some((c) => c.join(",") === "user_id,marketplace,seller_id")) erros.push("identidade (user_id, marketplace, seller_id) não declarada nas migrations");
  return erros;
}

// ── Z: zonas protegidas ────────────────────────────────────────────────
export const ARQUIVO_ZONAS = "scripts/zonas-protegidas.json";
export const ZONAS = ["app/(app)/dashboard/page.tsx", "app/(app)/vendas/page.tsx", "lib/comissoes-shopee.ts", "lib/comissoes-mercado-livre.ts",
  "lib/tabela-frete-ml.ts", "lib/shopee-financeiro.ts", "vercel.json", ".env.example", "scripts/sync-worker.mjs", "supabase"];
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export function calcularZonas(raiz = RAIZ_V2): Record<string, string> {
  const m: Record<string, string> = {};
  for (const f of listar(raiz, ...ZONAS).sort()) m[f] = sha(ler(raiz, f));
  return m;
}
export function verificarZonas(raiz = RAIZ_V2): string[] {
  const p = join(raiz, ARQUIVO_ZONAS);
  if (!existsSync(p)) return ["zonas-protegidas.json ausente"];
  const gravado: Record<string, string> = JSON.parse(readFileSync(p, "utf8")).arquivos ?? {};
  const atual = calcularZonas(raiz), dif: string[] = [];
  for (const f of Object.keys(atual)) if (!(f in gravado)) dif.push(`NOVO: ${f}`); else if (gravado[f] !== atual[f]) dif.push(`ALTERADO: ${f}`);
  for (const f of Object.keys(gravado)) if (!(f in atual)) dif.push(`APAGADO: ${f}`);
  return dif;
}
export function rebaselinarZonas(raiz = RAIZ_V2): void {
  writeFileSync(join(raiz, ARQUIVO_ZONAS), JSON.stringify({ versao: 1, zonas: ZONAS, arquivos: calcularZonas(raiz) }, null, 2) + "\n");
}

/**
 * MUDANÇA DE BANCO NUNCA ENTRA SEM REVISÃO (Fase 1A-SCHEMA; contrato único de sec3-b1 K1 e sec3-b2 M1).
 * Violações: (1) arquivo de supabase/ fora do baseline de zonas — arquivo novo/alterado só passa com
 * re-baseline explícito de scripts/zonas-protegidas.json (aparece no diff); (2) migration .sql nova desde
 * `base` (rastreada ou não) que nenhuma suíte scripts/testar-*.ts cita pelo nome (contrato próprio).
 * `opcoes` existe para os controles negativos: baseline sem um arquivo, migrations extras simuladas.
 */
export function mudancasDeBancoSemRevisao(raiz: string, base: string, opcoes: { gravado?: Record<string, string>; extras?: string[] } = {}): string[] {
  const erros: string[] = [];
  const atual = calcularZonas(raiz);
  if (!Object.keys(atual).some((f) => f.startsWith("supabase/migrations/"))) erros.push("ANCORA: supabase/ fora das zonas protegidas");
  const gravado = opcoes.gravado ?? (JSON.parse(readFileSync(join(raiz, ARQUIVO_ZONAS), "utf8")).arquivos ?? {});
  for (const f of Object.keys(atual)) if (f.startsWith("supabase/") && gravado[f] !== atual[f]) erros.push(`supabase/ fora do baseline de zonas: ${f}`);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: raiz, encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
  const novas = [...new Set([...git("diff", "--name-only", base, "--", "supabase"), ...git("ls-files", "--others", "--exclude-standard", "--", "supabase"), ...(opcoes.extras ?? [])])]
    .filter((f) => f.endsWith(".sql"));
  const suites = listar(raiz, "scripts").filter((f) => /^scripts\/testar-.*\.ts$/.test(f)).map((f) => ler(raiz, f));
  for (const f of novas) { const nome = f.split("/").pop()!; if (!suites.some((s) => s.includes(nome))) erros.push(`migration sem contrato/teste próprio: ${f}`); }
  return erros;
}

// ── I7: credenciais ML escopadas por loja (Fase 1B; catálogo multi-ML liberado na Fase 2F) ─────
/**
 * Rotas de catálogo ML. Fase 2F (estado 4): multi-ML PERMITIDO (MULTI_ML_CATALOG_ALLOWED) — no lugar da
 * barreira, a loja sai SÓ de lib/ml-loja-catalogo.ts, antes de provider/banco.
 */
export const ROTAS_CATALOGO_ML = ["app/api/ml/importar-anuncios/route.ts", "app/api/ml/sync-precos/route.ts", "app/api/ml/sync-skus/route.ts"];
export const HELPER_LOJA_CATALOGO_ML = "lib/ml-loja-catalogo.ts";
/** Rotas de vendas legadas ML (cache/dados não escopados por loja): 2+ contas ML falham fechado (MULTI_ML_VENDAS_BLOCKED). */
export const ROTAS_VENDAS_LEGADAS_ML = ["app/api/ml/vendas/route.ts", "app/api/ml/vendas-hoje/route.ts"];
/**
 * I7_ML_CREDENTIALS_ARE_STORE_SCOPED: o cookie de token ML não é fonte nem destino de credencial (só
 * DELETE legado em desconectar); nenhum seletor implícito ("mais recente"/primeira ativa) tem chamador;
 * toda rota que fala com o ML resolve a conta no servidor por loja; a loja única é opt-in; o sync ML
 * exige loja explícita; vendas legadas multi-ML falham fechado antes de provider/escrita; catálogo
 * multi-ML (Fase 2F): sem barreira, loja da ação/contexto validada no servidor pelo helper ANTES de
 * provider/banco, seleção explícita nunca cai para a loja única, 2+ sem seleção → ML_STORE_SELECTION_REQUIRED;
 * item-thumbnails exige sessão; resposta HTTP nunca carrega accessToken/refreshToken.
 */
export function credenciaisMLNaoEscopadasPorLoja(raiz = RAIZ_V2): string[] {
  const erros: string[] = [];
  const runtime = listar(raiz, "app", "lib", "components").filter((f) => /\.(ts|tsx)$/.test(f));
  if (existsSync(join(raiz, "middleware.ts"))) runtime.push("middleware.ts");
  for (const f of runtime) {
    const src = semComentarios(ler(raiz, f));
    const semDelete = src.replace(/limparCookie\(\s*\w+\s*,\s*["']ml_(access|refresh)_token["']\s*\)/g, "");
    if (/ml_(access|refresh)_token/.test(semDelete)) erros.push(`${f}: lê/grava cookie de token ML (só DELETE legado é permitido)`);
    if (/\b(getMLToken|applyMLCookies)\b/.test(src)) erros.push(`${f}: helper de cookie de token ML voltou`);
    for (const m of src.matchAll(/\b(getMLLojaAtiva|lerIdLojaMLAtivaMaisRecenteDoDono)\(/g)) {
      const antes = src.slice(Math.max(0, m.index! - 30), m.index!);
      if (!/function\s+$/.test(antes)) erros.push(`${f}: chama seletor implícito ${m[1]}`);
    }
    // Fase 2G: os seletores "loja ML mais recente" foram removidos — nem definição volta (sem exceção por arquivo).
    if (/\b(lerCredencialMLAtivaDoDono|lerIdLojaMLAtivaMaisRecenteDoDono|getMLLojaAtiva)\b/.test(src)) erros.push(`${f}: seletor implícito "loja ML mais recente" voltou`);
    if (f.startsWith("app/api/") && /NextResponse\.json\(\s*\{[^;]*\b(accessToken|refreshToken|access_token|refresh_token)\b\s*[:,}]/.test(src)) erros.push(`${f}: resposta HTTP carrega credencial`);
  }
  for (const f of listar(raiz, "app/api/ml", "app/api/anuncio", "app/api/sync").filter((x) => /route\.ts$/.test(x))) {
    const src = semComentarios(ler(raiz, f));
    if (/api\.mercadolibre\.com|syncMLForUser/.test(src) && !/resolverContaML\(|getMLLojaById\(|resolverLojaCatalogoML\(/.test(src)) erros.push(`${f}: fala com o ML sem resolver a conta por loja no servidor`);
  }
  const conexao = semComentarios(ler(raiz, "lib/ml-conexao.ts"));
  if (!/opcoes\.permitirUnica !== true/.test(conexao)) erros.push("lib/ml-conexao.ts: loja única deixou de ser opt-in explícito");
  if (!/lojaIndicada \? "LOJA_INVALIDA"/.test(conexao)) erros.push("lib/ml-conexao.ts: loja indicada inválida pode cair para outra");
  const sync = semComentarios(ler(raiz, "lib/sync-ml.ts"));
  if (!/if \(!lojaOverride\?\.lojaId \|\| !lojaOverride\.accessToken\) \{\s*throw new LojaIdIntegrityError/.test(sync)) erros.push("lib/sync-ml.ts: sync ML sem loja explícita não falha fechado");
  const parametrosToken = (sync.match(/_semTokenDeCookie\?:/g) ?? []).length;
  if (parametrosToken !== 2 || (sync.match(/_semTokenDeCookie\?:\s*undefined\b/g) ?? []).length !== parametrosToken) erros.push("lib/sync-ml.ts: sync ML voltou a aceitar token do navegador");
  const barreira = (f: string, codigo: string) => {
    const todo = semComentarios(ler(raiz, f));
    const iHandler = todo.search(/export async function (GET|POST)\(/);
    if (iHandler < 0) { erros.push(`${f}: handler não encontrado`); return; }
    const src = todo.slice(iHandler);   // só o fluxo do handler (helpers acima não são efeito ainda)
    const iBarreira = src.search(new RegExp(`contarLojasMLAtivasDoDono\\(userId\\) > 1\\) \\{\\s*return NextResponse\\.json\\(\\{ erro: true, codigo: ${codigo}`));
    if (iBarreira < 0) { erros.push(`${f}: sem barreira ${codigo}`); return; }
    const iPrimeiroEfeito = src.search(/resolverContaML\(|fetch\(|\.update\(|\.insert\(|\.upsert\(|syncMLForUser\(/);
    if (iPrimeiroEfeito >= 0 && iPrimeiroEfeito < iBarreira) erros.push(`${f}: provider/escrita antes da barreira ${codigo}`);
  };
  for (const f of ROTAS_VENDAS_LEGADAS_ML) barreira(f, "MULTI_ML_VENDAS_NOT_READY");
  // Catálogo multi-ML (Fase 2F): a barreira não existe mais em runtime; a loja vem do helper, antes de tudo.
  for (const f of runtime) if (/MULTI_ML_CATALOG_NOT_READY/.test(semComentarios(ler(raiz, f)))) erros.push(`${f}: barreira multi-ML do catálogo voltou (MULTI_ML_CATALOG_ALLOWED)`);
  for (const f of ROTAS_CATALOGO_ML) {
    const todo = semComentarios(ler(raiz, f));
    const iHandler = todo.search(/export async function POST\(/);
    if (iHandler < 0) { erros.push(`${f}: handler não encontrado`); continue; }
    const src = todo.slice(iHandler);
    if (/contarLojasMLAtivasDoDono|resolverContaML\(/.test(todo)) erros.push(`${f}: catálogo resolve/conta lojas fora de ${HELPER_LOJA_CATALOGO_ML}`);
    const iAuth = src.search(/autenticarRequisicao\(/);
    const iLoja = src.search(/resolverLojaCatalogoML\(userId, referenciaDeLojaML\(\w+, lerCookie\(request, "loja_ativa_id"\)\)\)/);
    if (iLoja < 0) { erros.push(`${f}: loja do catálogo não resolvida pelo helper (ação/contexto validados no servidor)`); continue; }
    if (iAuth < 0 || iAuth > iLoja) erros.push(`${f}: loja resolvida antes da sessão`);
    const iEfeito = src.search(/fetch\(|\.from\(|\.update\(|\.insert\(|\.upsert\(|importarCatalogoML\(/);
    if (iEfeito >= 0 && iEfeito < iLoja) erros.push(`${f}: provider/banco antes da validação da loja`);
    if (!/const loja = await resolverLojaCatalogoML\([\s\S]{0,80}\n\s*if \(!loja\.ok\) \{[\s\S]{0,500}?\n\s*return NextResponse\.json\([^;]*;\s*\n\s*\}/.test(src)) erros.push(`${f}: recusa da loja não encerra a rota`);
  }
  // Fase 2G: consulta de link (/api/anuncio, só leitura): `?loja_id` é referência EXPLÍCITA (sem loja
  // única; inválida → 404 antes do provider); sem referência, só a loja única; 2+ → sem credencial.
  {
    const a = semComentarios(ler(raiz, "app/api/anuncio/route.ts"));
    const iH = a.search(/export async function GET\(/);
    const g = iH < 0 ? "" : a.slice(iH);
    const iRef = g.search(/const conta = referencia\s*\?\s*await resolverContaML\(userId, referencia\)\s*:\s*await resolverContaML\(userId, null, \{ permitirUnica: true \}\);/);
    const iRecusa = g.search(/if \(lojaDoAnuncio && !conta\.ok && conta\.motivo === "LOJA_INVALIDA"\) \{\s*return NextResponse\.json\(/);
    const iProvider = g.search(/fetchItem\(|fetch\(/);
    if (iRef < 0 || (g.match(/resolverContaML\(/g) ?? []).length !== 2) erros.push("app/api/anuncio/route.ts: referência explícita com loja única implícita, ou conta fora dos dois ramos");
    if (!/const lojaDoAnuncio = url\.searchParams\.get\("loja_id"\);\s*const referencia = lojaDoAnuncio \|\| lerCookie\(request, "loja_ativa_id"\);/.test(g)) erros.push("app/api/anuncio/route.ts: referência de loja fora do contrato (loja do anúncio > contexto)");
    if (iRecusa < 0 || iRecusa < iRef || (iProvider >= 0 && iProvider < iRecusa)) erros.push("app/api/anuncio/route.ts: loja do anúncio inválida não é recusada antes do provider");
  }
  const helper = existsSync(join(raiz, HELPER_LOJA_CATALOGO_ML)) ? semComentarios(ler(raiz, HELPER_LOJA_CATALOGO_ML)) : "";
  if (!helper) erros.push(`${HELPER_LOJA_CATALOGO_ML} ausente`);
  else {
    if (!/referencia\s*\?\s*await resolverContaML\(userId, referencia\)\s*:\s*await resolverContaML\(userId, null, \{ permitirUnica: true \}\)/.test(helper)) erros.push(`${HELPER_LOJA_CATALOGO_ML}: seleção explícita com loja única implícita, ou sem seleção sem opt-in`);
    if ((helper.match(/resolverContaML\(/g) ?? []).length !== 2) erros.push(`${HELPER_LOJA_CATALOGO_ML}: resolução de conta fora dos dois ramos`);
    if (!/conta\.motivo === "LOJA_NAO_DEFINIDA"\) \{\s*return \{ ok: false, motivo: ML_STORE_SELECTION_REQUIRED/.test(helper)) erros.push(`${HELPER_LOJA_CATALOGO_ML}: 2+ lojas sem seleção não exige escolha`);
    if (!/conta\.motivo === "LOJA_INVALIDA"\) return \{ ok: false, motivo: LOJA_ML_INVALIDA \}/.test(helper)) erros.push(`${HELPER_LOJA_CATALOGO_ML}: loja indicada inválida não é recusada`);
    if (/\.lojas\[0\]|linhas\[0\]|contarLojas|order\(|limit\(|created_at/.test(helper)) erros.push(`${HELPER_LOJA_CATALOGO_ML}: seleção implícita de loja`);
  }
  const thumbs = semComentarios(ler(raiz, "app/api/ml/item-thumbnails/route.ts"));
  const iAuth = thumbs.search(/autenticarRequisicao\(/), iConta = thumbs.search(/resolverContaML\(/), iFetch = thumbs.search(/fetch\(/);
  if (!(iAuth >= 0 && iConta > iAuth && iFetch > iConta)) erros.push("app/api/ml/item-thumbnails/route.ts: sessão → conta por loja → provider fora de ordem");
  if (/item-thumbnails/.test(semComentarios(ler(raiz, "lib/middleware-rotas.ts")))) erros.push("lib/middleware-rotas.ts: item-thumbnails voltou a ser exceção anônima");
  return erros;
}

/** Pacote usado pelos guards reescritos: [] = tudo íntegro. */
// ── I8: catálogo ML escopado por LOJA (Fase 2D) ───────────────────────────
export const MOTOR_IMPORT_ML = "lib/anuncios/importacao-ml.ts";
/** Corpo de uma função nomeada (contagem de chaves a partir da 1ª `{` após a assinatura). */
function corpoDe(src: string, assinatura: RegExp): string | null {
  const m = assinatura.exec(src); if (!m) return null;
  let profundidade = 0, k = m.index + m[0].length - 1;
  for (; k < src.length; k++) { if (src[k] === "(") profundidade++; else if (src[k] === ")" && --profundidade === 0) break; }
  const abre = src.indexOf("{", src.indexOf(")", k));
  let n = 0;
  for (let i = abre; i < src.length; i++) { if (src[i] === "{") n++; else if (src[i] === "}" && --n === 0) return src.slice(abre, i + 1); }
  return null;
}
/**
 * I8_ML_CATALOG_IS_STORE_SCOPED: (a) toda cadeia de anuncios do runtime que filtra marketplace ML
 * filtra loja_id; (b) todo INSERT em anuncios grava loja_id explícito (runtime nunca depende da ponte
 * transitória do trigger); (c) Import ML V2: loja obrigatória, cursor preso à loja validado antes do
 * provider, credencial resolvida no motor SEM loja única implícita; (d) mapa de custo ML chaveado por
 * loja|item|variação; (e) criação manual só com loja resolvida no servidor, sem identidade do provider;
 * (f) PATCH: identidade técnica imutável e loja/dono não graváveis; (g) Meus Produtos agrupa por
 * marketplace|loja_id|item com a loja real (sem identidade paralela); (h) Fase 2F: a ação da tela leva
 * a loja (import 1ª fatia + continuação, sync-precos, sync-skus) e a escolha repete a ação com a loja.
 */
export function catalogoMLNaoEscopadoPorLoja(raiz = RAIZ_V2): string[] {
  const erros: string[] = [];
  const runtime = listar(raiz, "app", "lib", "components").filter((f) => /\.(ts|tsx)$/.test(f));
  let inserts = 0;
  for (const f of runtime) {
    const src = tiraComentarios(ler(raiz, f));
    if (!/\.from\(\s*["']anuncios["']\s*\)/.test(src)) continue;
    for (const c of cadeiasAnuncios(raiz, f)) {
      if (/\.eq\("marketplace",\s*"ML"\)/.test(c.texto) && !/\.eq\("loja_id",/.test(c.texto)) erros.push(`${f}: ${c.tipo} ML de anuncios sem loja_id`);
      if (c.tipo === "insert" || c.tipo === "upsert") {
        inserts++;
        const arg = /\.(?:insert|upsert)\(\s*([\s\S]*)$/.exec(c.texto)?.[1] ?? "";
        if (arg.trimStart().startsWith("{")) { if (!/\bloja_id\s*[:,}]/.test(arg)) erros.push(`${f}: INSERT em anuncios sem loja_id explícito`); }
        else {
          const nome = /^\s*(\w+)/.exec(arg)?.[1] ?? "";
          const pushes = nome ? [...src.matchAll(new RegExp(`\\b${nome}\\.push\\(\\{([\\s\\S]*?)\\}\\);`, "g"))] : [];
          if (!pushes.length) erros.push(`${f}: INSERT em anuncios com payload não rastreável (${nome || "?"})`);
          for (const p of pushes) if (!/\bloja_id\s*:/.test(p[1])) erros.push(`${f}: linha de INSERT em lote (${nome}.push) sem loja_id`);
        }
      }
    }
  }
  if (inserts === 0) erros.push("ANCORA: nenhum INSERT em anuncios encontrado (detector cego)");

  // (c) motor Import ML V2
  if (!existsSync(join(raiz, MOTOR_IMPORT_ML))) erros.push(`${MOTOR_IMPORT_ML} ausente`);
  else {
    const m = tiraComentarios(ler(raiz, MOTOR_IMPORT_ML));
    const corpo = corpoDe(m, /export\s+async\s+function\s+importarCatalogoML\s*\(/) ?? "";
    if (!corpo) erros.push("motor: importarCatalogoML ausente");
    const iCursor = corpo.indexOf("lerCursorML("), iConta = corpo.indexOf("resolverContaML("), iFetch = corpo.search(/getML\(|fetch\(/);
    if (iCursor < 0 || iConta < 0 || iCursor > iConta || (iFetch >= 0 && iFetch < iConta)) erros.push("motor: cursor e loja precisam ser validados ANTES do provider");
    if (/permitirUnica/.test(m)) erros.push("motor: loja única implícita (permitirUnica) dentro do motor");
    if (!/resolverContaML\(userId,\s*lojaId\)/.test(corpo)) erros.push("motor: credencial não resolvida pela loja explícita");
    if (!/c\.l\s*!==\s*lojaId[\s\S]{0,40}CURSOR_DE_OUTRA_LOJA/.test(m)) erros.push("motor: cursor não preso à loja");
  }
  // (d) mapa de custo ML
  const sync = tiraComentarios(ler(raiz, "lib/sync-ml.ts"));
  if (!/export function chaveAnuncioML\(lojaId: string, mlItemId: string, variationId/.test(sync)) erros.push("lib/sync-ml.ts: chave do mapa de custo ML sem loja|item|variação");
  if (/mapaAnuncios\.(set|get)\((a\.ml_item_id|mlItemId)\b/.test(sync)) erros.push("lib/sync-ml.ts: mapa de custo ML chaveado só por item");
  for (const f of runtime) for (const c of tiraComentarios(ler(raiz, f)).matchAll(/carregarMapaAnunciosML\(([^)]*)\)/g)) {
    if (!/,/.test(c[1])) erros.push(`${f}: carregarMapaAnunciosML sem loja`);
  }
  // (e) criação manual / (f) PATCH
  const serv = tiraComentarios(ler(raiz, "lib/anuncios/servico.ts"));
  const grav = /export const CAMPOS_GRAVAVEIS[^{]*\{([\s\S]*?)\};/.exec(serv)?.[1] ?? "";
  if (!grav || /\b(loja_id|user_id)\s*:/.test(grav)) erros.push("servico: loja_id/user_id graváveis pelo browser");
  const montar = corpoDe(serv, /export function montarCamposGravaveis\(/) ?? "";
  if (!/campos\.marketplace === "ML"[\s\S]{0,200}ml_item_id[\s\S]{0,120}variation_id[\s\S]{0,200}ML_PROVIDER_IDENTITY_MANUAL_CREATE_NOT_ALLOWED/.test(montar)) erros.push("servico: POST manual ML aceita identidade do provider");
  for (const f of runtime) for (const c of tiraComentarios(ler(raiz, f)).matchAll(/\bawait\s+criarAnuncio\(([^;]*?)\);/g)) {
    if (c[1].split(",").length < 4) erros.push(`${f}: criarAnuncio sem loja resolvida no servidor`);
  }
  const atualizar = corpoDe(serv, /export async function atualizarAnuncioDoDono\(/) ?? "";
  if (!/"identidade_recusada"/.test(atualizar) || !/ml_item_id, variation_id/.test(atualizar)) erros.push("servico: PATCH não compara a identidade ML com a do banco");
  // (g) apresentação
  const tela = tiraComentarios(ler(raiz, "app/(app)/anuncios/page.tsx"));
  // a tela agrupa SÓ pelas funções puras da chave por loja — nenhum Map próprio de anúncios
  if (/\.(get|set)\(a\.ml_item_id\b/.test(tela) || /new Map<string,\s*Anuncio\[\]>/.test(tela)
    || !/idsDuplicadosAntigos\(anuncios\)/.test(tela) || !/agruparVariacoes\(anunciosFiltrados\)/.test(tela)) erros.push("Meus Produtos: agrupamento fora da chave marketplace|loja_id|item");
  const agrup = tiraComentarios(ler(raiz, "app/(app)/anuncios/agrupamento.ts"));
  if (!agrup.includes("`${a.marketplace ?? \"\"}|${a.loja_id ?? \"\"}|${a.ml_item_id}`")) erros.push("Meus Produtos: chave de grupo sem marketplace|loja_id|item");
  if ((agrup.match(/const chave = chaveDeGrupoAnuncio\(a\);/g) ?? []).length < 2) erros.push("Meus Produtos: funções de agrupamento sem a chave por loja");
  for (const f of runtime) if (/loja_ref|lojaRef/.test(tiraComentarios(ler(raiz, f)))) erros.push(`${f}: identidade paralela de loja (loja_ref)`);
  // (h) Fase 2F: a AÇÃO da tela leva a loja — import (1ª fatia e continuação) e syncs com `loja_id`;
  // a escolha (409 ML_STORE_SELECTION_REQUIRED) repete a MESMA ação com a loja escolhida.
  const uiImport = tiraComentarios(ler(raiz, "app/(app)/anuncios/importacao-ml.ts"));
  if (!/let corpo: Record<string, unknown> = lojaId \? \{ loja_id: lojaId \} : \{\};/.test(uiImport)
    || !/corpo = \{ loja_id: d\.loja_id, cursor: d\.cursor \};/.test(uiImport)) erros.push("importacao-ml (tela): fatia sem loja_id");
  if (!/d\?\.codigo !== "ML_STORE_SELECTION_REQUIRED"/.test(uiImport)) erros.push("importacao-ml (tela): escolha de conta ML ignorada");
  if (!/importarMLEmFatias\([\s\S]*?,\s*lojaId\);/.test(tela)) erros.push("Meus Produtos: import ML perde a loja escolhida");
  for (const r of ["sync-precos", "sync-skus"]) {
    if (!new RegExp(`fetch\\("/api/ml/${r}", \\{ method: "POST", headers: \\{ "Content-Type": "application/json" \\}, body: corpoLojaML\\(lojaId\\) \\}\\)`).test(tela)) erros.push(`Meus Produtos: ${r} sem loja_id da ação`);
  }
  if (!/const corpoLojaML = \(lojaId\?: string\) => JSON\.stringify\(lojaId \? \{ loja_id: lojaId \} : \{\}\);/.test(tela)) erros.push("Meus Produtos: corpo da ação sem loja_id");
  if (!/escolhaLojaML\.acao === "importar" \? importarDoML\(l\.id\)\s*: escolhaLojaML\.acao === "precos" \? sincronizarPrecos\(l\.id\) : atualizarSkus\(l\.id\)/.test(tela)) erros.push("Meus Produtos: escolha da conta ML não repete a ação com a loja");
  return erros;
}

export function invariantesV2(raiz = RAIZ_V2, opcoes: { zonas?: boolean } = {}): string[] {
  const erros: string[] = [];
  for (const v of canonicoAlcancaLegado(raiz)) erros.push(`I1 canônico→legado: ${v}`);
  for (const v of legadoMexeEmJobCanonico(raiz)) erros.push(`I2 job canônico fora de lib/vendas/sync: ${v}`);
  for (const v of seletoresImplicitosNovos(raiz)) erros.push(`I3 seleção implícita nova: ${v}`);
  for (const v of rotasInternasSemSegredo(raiz)) erros.push(`I4 rota interna sem segredo: ${v}`);
  for (const v of leitoresMLSemMarketplace(raiz)) erros.push(`I5 ML_SKU_SYNC_NEVER_READS_OR_WRITES_SHOPEE_ROWS: ${v}`);
  for (const v of identidadeDeLojaNaoExplicita(raiz)) erros.push(`I6 I6_STORE_IDENTITY_IS_EXPLICIT: ${v}`);
  for (const v of credenciaisMLNaoEscopadasPorLoja(raiz)) erros.push(`I7 I7_ML_CREDENTIALS_ARE_STORE_SCOPED: ${v}`);
  for (const v of catalogoMLNaoEscopadoPorLoja(raiz)) erros.push(`I8 I8_ML_CATALOG_IS_STORE_SCOPED: ${v}`);
  if (opcoes.zonas !== false) for (const v of verificarZonas(raiz)) erros.push(`Z zona protegida sem re-baseline: ${v}`);
  return erros;
}
