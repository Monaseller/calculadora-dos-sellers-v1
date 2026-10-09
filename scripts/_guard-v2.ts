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
 *   I5  ML_SKU_SYNC_NEVER_READS_OR_WRITES_SHOPEE_ROWS (Fase 0C/0C.1): toda leitura paginada de anuncios dos
 *       caminhos ML e todo UPDATE do sync-skus filtram marketplace = "ML" — row Shopee nunca chega ao provider ML nem é escrita por ele;
 *   I6  I6_STORE_IDENTITY_IS_EXPLICIT (Fase 1A): o fallback técnico "<Marketplace> <id>" só nasce em
 *       lib/lojas/identidade.ts; nome de loja só é gravado via camposDeNomeParaGravar na capability
 *       (nunca por rota/navegador, nunca dados.nome cru); callbacks extraem nome só pelos parsers
 *       canônicos; o callback Shopee não troca a loja em uso; nenhum runtime decide por
 *       shop_id/seller_id literal nem traz nome de loja embutido ("mais recente" segue em I3);
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
/** Dívida ML conhecida (Fase 1 remove) — arquivo → nº de usos. Shopee implícito: nenhum. */
export const SELETORES_IMPLICITOS_CONHECIDOS: Record<string, number> = {
  "app/api/ml/vendas/route.ts": 1,      // lerIdLojaMLAtivaMaisRecenteDoDono
  "app/api/sync/manual/route.ts": 1,    // getMLLojaAtiva
  "lib/sync-ml.ts": 1,                  // getMLLojaAtiva
  "lib/ml-auth.ts": 2,                  // dentro de getMLLojaAtiva (definição)
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

// ── I5: leitores ML (e escritor sync-skus) de anuncios filtram marketplace no banco ──
export const LEITORES_ML_ANUNCIOS = ["app/api/ml/sync-skus/route.ts", "app/api/ml/sync-precos/route.ts",
  "app/api/ml/importar-anuncios/route.ts", "lib/sync-ml.ts"];
export const ESCRITORES_ML_ANUNCIOS = ["app/api/ml/sync-skus/route.ts"];
export function leitoresMLSemMarketplace(raiz = RAIZ_V2): string[] {
  const erros: string[] = [];
  for (const f of LEITORES_ML_ANUNCIOS) {
    const blocos = (ler(raiz, f).match(/lerTodasAsPaginas<\w+>\(\(\) => [\s\S]*?\)\);/g) ?? [])
      .filter((b) => b.includes('.from("anuncios")'));
    if (!blocos.length) erros.push(`${f}: nenhuma leitura paginada de anuncios encontrada`);
    for (const b of blocos) if (!b.includes('.eq("marketplace", "ML")')) erros.push(`${f}: leitura de anuncios sem marketplace = "ML"`);
  }
  // WRITE (Fase 0C.1): todo UPDATE de anuncios do sync-skus ML exige marketplace = "ML"
  for (const f of ESCRITORES_ML_ANUNCIOS) {
    const escritas = ler(raiz, f).match(/\.from\("anuncios"\)\s*\.update\([\s\S]*?;/g) ?? [];
    if (!escritas.length) erros.push(`${f}: nenhum UPDATE de anuncios encontrado`);
    for (const w of escritas) if (!w.includes('.eq("marketplace", "ML")')) erros.push(`${f}: UPDATE de anuncios sem marketplace = "ML"`);
  }
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
  // resolvedor explícito: sem ordenação/limite; loja única só sob opt-in
  const resolver = semComentarios(ler(raiz, "lib/lojas/resolver.ts"));
  if (/\.order\(|\.limit\(|created_at|\.sort\(/.test(resolver)) erros.push("lib/lojas/resolver.ts: resolvedor ordena/limita (seleção implícita)");
  if ((resolver.match(/doMarketplace\[0\]/g) ?? []).length !== 1 || !/pedido\.permitirUnica && doMarketplace\.length === 1\) return \{ ok: true, loja: paraResolvida\(doMarketplace\[0\]/.test(resolver))
    erros.push("lib/lojas/resolver.ts: loja escolhida sem pedido explícito");
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

/** Pacote usado pelos guards reescritos: [] = tudo íntegro. */
export function invariantesV2(raiz = RAIZ_V2, opcoes: { zonas?: boolean } = {}): string[] {
  const erros: string[] = [];
  for (const v of canonicoAlcancaLegado(raiz)) erros.push(`I1 canônico→legado: ${v}`);
  for (const v of legadoMexeEmJobCanonico(raiz)) erros.push(`I2 job canônico fora de lib/vendas/sync: ${v}`);
  for (const v of seletoresImplicitosNovos(raiz)) erros.push(`I3 seleção implícita nova: ${v}`);
  for (const v of rotasInternasSemSegredo(raiz)) erros.push(`I4 rota interna sem segredo: ${v}`);
  for (const v of leitoresMLSemMarketplace(raiz)) erros.push(`I5 ML_SKU_SYNC_NEVER_READS_OR_WRITES_SHOPEE_ROWS: ${v}`);
  for (const v of identidadeDeLojaNaoExplicita(raiz)) erros.push(`I6 I6_STORE_IDENTITY_IS_EXPLICIT: ${v}`);
  if (opcoes.zonas !== false) for (const v of verificarZonas(raiz)) erros.push(`Z zona protegida sem re-baseline: ${v}`);
  return erros;
}
