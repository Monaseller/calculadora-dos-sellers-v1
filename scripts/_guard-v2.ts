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
 *   I9  I9_MARKETPLACE_OBSERVATION_IS_SEPARATE_FROM_ATIVO (Fase 2H-C): só lib/anuncios/observacao-marketplace.ts
 *       monta/grava { status_marketplace?, visto_em } — status RAW intocado, sem status → sem a chave, nunca
 *       NULL; observação só de identidade presente na resposta; gravação em lote por ids + dono + marketplace
 *       + loja, confirmando todas as rows; existentes lidos sem filtro de ativo; escrita de observação antes
 *       do cursor e fail-closed; Shopee sem status (não infere NORMAL); provider nunca escreve ativo;
 *   I10 I10_KNOWN_ID_REFRESH_IS_STORE_SCOPED (Fase 2H-D): refresh de identidades conhecidas — fonte por dono +
 *       marketplace + loja + item não nulo (sem filtro de ativo/status/visto), dedup por item da loja, cursor
 *       preso a marketplace + loja + tipo "refresh" antes do provider, credencial da loja, positivo só com id
 *       pedido == id devolvido (ML code 200), sem inferência de 404/ausência, variação/model só se voltou,
 *       escrita só pelo helper de observação, checkpoint depois da escrita;
 *   I11 I11_MARKETPLACE_STATUS_UI_IS_READ_ONLY (Fase 2H-E): fora do helper (I9), status_marketplace/visto_em
 *       só em leitores NOMINAIS (projeção da tela; módulo puro de apresentação, com o tipo readonly); a apresentação
 *       não grava, não faz I/O, não lê/deriva `ativo`, não usa relógio nem infere estado (NULL ≠ inativo,
 *       Shopee NULL ≠ NORMAL); só os cards a usam (fora de filtro/agrupamento/ordem); card nunca some e
 *       não dispara escrita nova; o browser não grava os campos (CAMPOS_GRAVAVEIS);
 *   I12 I12_SALES_STORE_SCOPE_IS_EXPLICIT (Vendas A2): toda cadeia de `pedidos` filtra dono + loja, ou é uma
 *       forma de uma lista FECHADA (escrita/detecção por id, update de seleção escopada, enumeração admin,
 *       agregado do dono); /api/ml/vendas lê só a loja EXPLÍCITA validada no servidor (sem loja → falha fechado;
 *       2+ sem escolha → 409 seleção, Vendas A5); sync Shopee de B nunca lê/atualiza/sobrescreve A;
 *   I13 I13_SALES_COST_COMES_FROM_MEUS_PRODUTOS (Vendas A3): custo da venda vem AO VIVO de Meus Produtos por um
 *       único serviço — leitura paginada por dono + marketplace + loja, sem `ativo`, chave exata
 *       marketplace|loja|item|variação (sem SKU, sem fallback entre variações); sem custo / sem produto /
 *       identidade incompleta → pendente, nunca 0; nada grava (sem snapshot/backfill); um lookup por
 *       requisição (sem N+1); a venda segue visível; a tela de Vendas exibe só o cálculo ao vivo;
 *   I14 I14_ML_SALE_ITEM_IDENTITY_IS_EXACT (Vendas A4-B): o writer ML grava a variação EXATA do provider; id
 *       novo com loja + variação; legada reaproveitada/adotada só pela loja, mesma identidade, e adoção de
 *       variação só com UMA variação do item no pedido; 2+ → ambígua preservada (sem chute, sem dupla
 *       contagem); SKU/nome/preço fora da identidade; erro de gravação falha o sync; histórico não é preenchido;
 *   I15 I15_ML_SALE_IDENTITY_IS_DB_UNIQUE (Vendas A4-C): existe migration com UNIQUE parcial ML em pedidos sobre
 *       (loja_id, order_id, ml_item_id, coalesce(variation_id, '')), sem SKU/pedidos.id na identidade, com
 *       prechecks fail-closed e sem escrita de dados (UPDATE/DELETE/INSERT), NOT NULL, DROP ou CONCURRENTLY;
 *   I16 I16_ML_VENDAS_STORE_IS_EXPLICIT (Vendas A5): Vendas ML mostra UMA loja escolhida (seleção, não agregação):
 *       a rota usa só `?loja_id` (validada: dono + ML + ativa) ou a única; sem cookie, sem "primeira/mais recente",
 *       sem fallback para outra loja, sem `.in("loja_id")`; inválida → 404 LOJA_ML_INVALIDA; a tela envia a loja,
 *       descarta resposta de outra loja, não escolhe por ordem e o sync (job e manual) leva a loja escolhida;
 *       sync manual com ML e 2+ lojas sem escolha é BLOQUEADO na tela antes de qualquer request (A5-B.1);
 *       vendas-hoje mantém a barreira e o helper/constante seguem em lib/ml-conexao.ts;
 *   I17 I17_ML_FINANCIAL_RECONCILIATION_IS_REAL (Vendas A3.2-B): líquido ML = receita − tarifa LÍQUIDA − frete do
 *       vendedor (senders.cost), sem rebate/desconto de novo, sem receiver.cost nem gross_amount; ACTUAL só com
 *       billing conferido; envio compartilhado → PENDING (frete 1× por envio); tarifa com proveniência; coletor só
 *       GET e fora das rotas; código da venda ML = pack_id ?? order_id; migration aditiva (fechamento: SEC-3);
 *       A3.2-C: o financeiro é coletado NO core do sync (todo caminho) após gravar os pedidos, mesma loja;
 *       TRANSIENT (429/502/503/504/timeout) repete com backoff, INTEGRATION é logado e não repete às cegas;
 *       pedido completo não é reconsultado; GET de Vendas só marca pendentes; retry por rota própria (mesma
 *       loja, só pendentes, limite) e uma rodada por carga da tela;
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
export const ROTAS_CATALOGO_ML = ["app/api/ml/importar-anuncios/route.ts", "app/api/ml/sync-precos/route.ts", "app/api/ml/sync-skus/route.ts", "app/api/ml/refresh-identidades/route.ts"];
export const HELPER_LOJA_CATALOGO_ML = "lib/ml-loja-catalogo.ts";
/**
 * Rotas de vendas ML que AINDA falham fechado com 2+ contas ML (MULTI_ML_VENDAS_BLOCKED). Vendas A5: a rota
 * principal (/api/ml/vendas) saiu daqui — a loja é explícita e validada (I16); vendas-hoje continua barrada (A6).
 */
export const ROTAS_VENDAS_LEGADAS_ML = ["app/api/ml/vendas-hoje/route.ts"];
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

// ── I9: observação do marketplace separada de `ativo` (Fase 2H-C) ─────────
export const HELPER_OBSERVACAO = "lib/anuncios/observacao-marketplace.ts";
/** Fase 2H-E: os ÚNICOS leitores de status_marketplace/visto_em fora do helper — somente leitura (I11). */
export const UI_OBSERVACAO = "app/(app)/anuncios/observacao.ts";
export const LEITORES_OBSERVACAO = ["lib/anuncios/colunas.ts", UI_OBSERVACAO];
const MOTORES_OBSERVACAO: Array<{ arquivo: string; marketplace: "ML" | "Shopee" }> = [
  { arquivo: "lib/anuncios/importacao-ml.ts", marketplace: "ML" },
  { arquivo: "lib/anuncios/importacao-shopee.ts", marketplace: "Shopee" },
];
/**
 * I9_MARKETPLACE_OBSERVATION_IS_SEPARATE_FROM_ATIVO: `status_marketplace`/`visto_em` só pelo helper de
 * observação; status RAW (sem transformação) e só quando presente (sem status → sem a chave; nunca NULL);
 * observação só de identidade que VOLTOU na resposta (ausência não escreve); gravação em lote por ids +
 * dono + marketplace + loja que confirma TODAS as rows; existentes lidos sem filtro de `ativo` (row
 * soft-deleted segue observável); escrita de observação depois do negócio e ANTES do cursor, falha →
 * erro; Shopee nunca passa status (não infere NORMAL); nenhum writer do provider grava `ativo` em UPDATE.
 */
export function observacaoMisturadaComAtivo(raiz = RAIZ_V2): string[] {
  const erros: string[] = [];
  if (!existsSync(join(raiz, HELPER_OBSERVACAO))) return [`${HELPER_OBSERVACAO} ausente`];
  const h = tiraComentarios(ler(raiz, HELPER_OBSERVACAO));
  const pos = corpoDe(h, /export function observacaoPositiva\(/) ?? "";
  if (!/const obs: ObservacaoMarketplace = \{ visto_em: observadoEm\.toISOString\(\) \};/.test(pos)) erros.push("helper: visto_em não é o instante da observação");
  if (!/if \(typeof statusRaw === "string" && statusRaw\.trim\(\) !== ""\) obs\.status_marketplace = statusRaw;/.test(pos)) erros.push("helper: status não é RAW, ou entra sem estar presente");
  if (/status_marketplace\s*[:=]\s*null|toLowerCase|toUpperCase|normaliz|canonic/i.test(pos)) erros.push("helper: status transformado ou anulado");
  const grava = corpoDe(h, /export async function gravarObservacoes\(/) ?? "";
  if (!/\.update\(obs\)\s*\.in\("id", lote\)\.eq\("user_id", alvo\.userId\)\.eq\("marketplace", alvo\.marketplace\)\.eq\("loja_id", alvo\.lojaId\)\.select\("id"\)/.test(grava)) erros.push("helper: gravação sem ids + dono + marketplace + loja");
  if (!/if \(error \|\| \(data \?\? \[\]\)\.length !== lote\.length\) return false;/.test(grava)) erros.push("helper: gravação aceita confirmação parcial");
  // Fase 2H-E: os LEITORES nominais (projeção, tipo, apresentação) podem citar os campos — e só eles;
  // que eles só LEEM é provado por I11 (observacaoNaUiNaoSoLeitura).
  const runtime = listar(raiz, "app", "lib", "components").filter((f) => /\.(ts|tsx)$/.test(f) && f !== HELPER_OBSERVACAO && !LEITORES_OBSERVACAO.includes(f));
  for (const f of runtime) {
    const src = tiraComentarios(ler(raiz, f));
    if (/\b(status_marketplace|visto_em)\b/.test(src)) erros.push(`${f}: grava/monta status_marketplace/visto_em fora do helper de observação`);
  }
  for (const { arquivo, marketplace } of MOTORES_OBSERVACAO) {
    const m = tiraComentarios(ler(raiz, arquivo));
    if (/\bupd\.ativo\b|\.update\(\{[^)]*\bativo\b/.test(m)) erros.push(`${arquivo}: writer do provider grava ativo`);
    const existentes = /const existentes = await lerTodasAsPaginas[\s\S]*?\);/.exec(m)?.[0] ?? "";
    if (!existentes || /\.eq\("ativo"/.test(existentes)) erros.push(`${arquivo}: existentes filtrados por ativo (soft-deleted deixa de ser observável)`);
    if (!/observacoes\.push\(\{ id: existente\.id, obs \}\);/.test(m)) erros.push(`${arquivo}: linha existente sem observação`);
    const iGrava = m.search(/if \(observacoes\.length > 0 && !\(await gravarObservacoes\(banco, \{ userId, lojaId, marketplace: "(ML|Shopee)" \}, observacoes\)\)\) \{\s*throw new ErroImportacao/);
    const iCursor = m.search(marketplace === "ML" ? /cursorItem = lote\[lote\.length - 1\];/ : /if \(k > 0\) cursorItem = lote\[k - 1\];/);
    if (iGrava < 0) erros.push(`${arquivo}: escrita de observação ausente ou sem falhar fechado`);
    else if (!/marketplace: "(ML|Shopee)"/.exec(m.slice(iGrava))?.[0].includes(marketplace)) erros.push(`${arquivo}: observação com marketplace errado`);
    if (iCursor < 0 || iGrava < 0 || iGrava > iCursor) erros.push(`${arquivo}: cursor avança antes da escrita de observação`);
    const iUltimaEscritaNegocio = Math.max(m.lastIndexOf(".insert(novas)"), m.lastIndexOf(".update(m.upd)"));
    if (iGrava >= 0 && iUltimaEscritaNegocio > iGrava) erros.push(`${arquivo}: observação antes das escritas de negócio`);
  }
  const ml = tiraComentarios(ler(raiz, MOTORES_OBSERVACAO[0].arquivo));
  const iPula = ml.search(/if \(!item\) continue;/), iObs = ml.search(/const obs = observacaoPositiva\(instante, item\.status\);/);
  if (iObs < 0 || iPula < 0 || iPula > iObs) erros.push("ML: observação fora de item presente na resposta (ou status não é o RAW de item.status)");
  const sp = tiraComentarios(ler(raiz, MOTORES_OBSERVACAO[1].arquivo));
  const chamadasObs = [...sp.matchAll(/observacaoPositiva\(([^;]*?)\);/g)].map((x) => x[1]);
  if (chamadasObs.length !== 1 || chamadasObs[0] !== "observadoEm()") erros.push(`Shopee: observação passa status (não provado) — ${chamadasObs.join(" | ")}`);
  if ((sp.match(/"NORMAL"/g) ?? []).length !== 1 || !/item_status: "NORMAL" \}, "get_item_list"/.test(sp)) erros.push("Shopee: NORMAL fora do filtro da listagem");
  return erros;
}

// ── I10: refresh de identidades conhecidas, por loja (Fase 2H-D) ─────────
export const REFRESH_COMUM = "lib/anuncios/refresh-identidades.ts";
const REFRESH_MOTORES: Array<{ arquivo: string; m: "ML" | "Shopee" }> = [
  { arquivo: "lib/anuncios/refresh-identidades-ml.ts", m: "ML" },
  { arquivo: "lib/anuncios/refresh-identidades-shopee.ts", m: "Shopee" },
];
/**
 * I10_KNOWN_ID_REFRESH_IS_STORE_SCOPED: o refresh lê a fonte por dono + marketplace + loja + item não nulo (sem
 * filtro de ativo/status/visto), agrupa só linhas da loja, valida o cursor (marketplace + loja + "refresh")
 * ANTES do provider, usa a credencial da loja, só observa resposta positiva com o MESMO id pedido, não infere
 * nada de 404/ausência, só observa variação/model que voltou, escreve só pelo helper e avança o checkpoint
 * depois da escrita (falha → erro).
 */
export function refreshDeIdentidadesForaDaLoja(raiz = RAIZ_V2): string[] {
  const erros: string[] = [];
  for (const f of [REFRESH_COMUM, ...REFRESH_MOTORES.map((x) => x.arquivo)]) if (!existsSync(join(raiz, f))) return [`${f} ausente`];
  const c = tiraComentarios(ler(raiz, REFRESH_COMUM));
  if (!/c\.k !== "refresh" \|\| c\.m !== m/.test(c) || !/if \(c\.l !== lojaId\) return \{ ok: false, motivo: "CURSOR_DE_OUTRA_LOJA" \};/.test(c)) erros.push("cursor do refresh sem tipo/marketplace/loja");
  if (!/if \(row\.loja_id !== lojaId\) throw new ErroRefreshIdentidades/.test(c)) erros.push("fonte do refresh aceita linha de outra loja");
  if (/\b(deleted|closed|inactive|paused|NORMAL|UNLIST|BANNED)\b/.test(c)) erros.push("refresh comum menciona status inferido");
  for (const { arquivo, m } of REFRESH_MOTORES) {
    const s = tiraComentarios(ler(raiz, arquivo));
    const fonte = /const leitura = await lerTodasAsPaginas[\s\S]*?\)\);/.exec(s)?.[0] ?? "";
    if (!new RegExp(`\\.eq\\("marketplace", "${m}"\\)\\s*\\.eq\\("user_id", userId\\)\\s*\\.eq\\("loja_id", lojaId\\)\\s*\\.not\\("ml_item_id", "is", null\\)`).test(fonte)) erros.push(`${arquivo}: fonte fora de dono + ${m} + loja + item`);
    if (/\.eq\("(ativo|status_marketplace|visto_em)"|\.is\("(status_marketplace|visto_em)"/.test(fonte)) erros.push(`${arquivo}: fonte filtra ativo/status/visto (soft-deleted deixa de ser refrescável)`);
    if (!new RegExp(`agruparFonte\\(leitura\\.linhas, lojaId, "${m}"\\)`).test(s)) erros.push(`${arquivo}: fonte não agrupada pela loja`);
    const iCursor = s.indexOf(`lerCursorRefresh(args.cursor, "${m}", lojaId)`);
    const iProvider = s.search(m === "ML" ? /resolverContaML\(|await getML\(/ : /await chamarShopee\(/);
    if (iCursor < 0 || iProvider < 0 || iCursor > iProvider) erros.push(`${arquivo}: cursor validado depois do provider (ou ausente)`);
    if (/\b(deleted|closed|inactive|paused|NORMAL|UNLIST|BANNED)\b|\b404\b/.test(s)) erros.push(`${arquivo}: inferência de status/404`);
    if (/\b(status_marketplace|visto_em|ativo)\s*:/.test(s)) erros.push(`${arquivo}: escreve campo de observação/ativo fora do helper`);
    const iGrava = s.search(new RegExp(`if \\(pares\\.length > 0 && !\\(await gravarObservacoes\\(banco, \\{ userId, lojaId, marketplace: "${m}" \\}, pares\\)\\)\\) \\{\\s*throw new ErroRefreshIdentidades`));
    const iCk = s.search(m === "ML" ? /cursorItem = lote\[lote\.length - 1\];/ : /if \(k > 0\) cursorItem = lote\[k - 1\];/);
    if (iGrava < 0 || iCk < 0 || iGrava > iCk) erros.push(`${arquivo}: checkpoint antes da escrita (ou escrita sem falhar fechado)`);
    if (m === "ML") {
      if (!/const conta = await resolverContaML\(userId, lojaId\);/.test(s) || /permitirUnica/.test(s) || !/if \(conta\.lojaId !== lojaId\) throw/.test(s)) erros.push(`${arquivo}: credencial não é a da loja`);
      if (!/if \(id === null \|\| !lote\.includes\(id\)\) continue;/.test(s) || !/if \(x\.code === 200\) positivos\.set\(id, x\.body\);/.test(s)) erros.push(`${arquivo}: positivo sem code 200 + id pedido`);
      if ((s.match(/observacaoPositiva\(/g) ?? []).length !== 1 || !/observacaoPositiva\(instante, body\.status\)/.test(s)) erros.push(`${arquivo}: status não é o RAW de body.status`);
      if (!/voltaram\.has\(String\(r\.variation_id\)\)/.test(s)) erros.push(`${arquivo}: variação observada sem ter voltado`);
    } else {
      const obs = [...s.matchAll(/observacaoPositiva\(([^;]*?)\);/g)].map((x) => x[1]);
      if (obs.length !== 1 || obs[0] !== "observadoEm()") erros.push(`${arquivo}: Shopee passa status (não provado)`);
      if (!/lote\.includes\(String\(it\.item_id\)\)/.test(s)) erros.push(`${arquivo}: item fora do lote pedido aceito`);
      if (!/voltaram\.has\(String\(x\.variation_id\)\)/.test(s)) erros.push(`${arquivo}: model observado sem ter voltado`);
    }
  }
  const rotaSP = tiraComentarios(ler(raiz, "app/api/shopee/refresh-identidades/route.ts"));
  const iSel = rotaSP.search(/selecionarLojaShopee\(userId, \{[\s\S]{0,200}usarCookie: false/), iCred = rotaSP.search(/getShopeeLojaById\(lojaId, userId\)/), iMot = rotaSP.search(/refrescarIdentidadesShopee\(/);
  if (iSel < 0 || iCred < iSel || iMot < iCred) erros.push("rota Shopee do refresh: loja explícita → credencial da loja → motor fora de ordem");
  if (!ROTAS_CATALOGO_ML.includes("app/api/ml/refresh-identidades/route.ts")) erros.push("rota ML do refresh fora das rotas de catálogo (I7)");
  return erros;
}

// ── I11: observação do marketplace na UI é SOMENTE LEITURA (Fase 2H-E) ─────
export const CARDS_OBSERVACAO = ["app/(app)/anuncios/CardAnuncio.tsx", "app/(app)/anuncios/CardAnuncioVariacoes.tsx"];
/** Única escrita que um card dispara (anterior à 2H-E): vendas do dia do anúncio. */
const FETCH_DOS_CARDS: Record<string, RegExp[]> = {
  "app/(app)/anuncios/CardAnuncio.tsx": [/^fetch\(`\/api\/anuncios\/\$\{encodeURIComponent\(a\.id\)\}\/vendas-dia`/],
  "app/(app)/anuncios/CardAnuncioVariacoes.tsx": [],
};
const CAMPO_OBS = /\b(status_marketplace|visto_em)\b/g;
/**
 * I11_MARKETPLACE_STATUS_UI_IS_READ_ONLY: (a) a projeção da tela cita os campos só dentro de
 * DB_ANUNCIO_COLUMNS; (b) o tipo de leitura vive só na apresentação, opcional e readonly; (c) a apresentação é pura — sem import, I/O,
 * escrita, atribuição/montagem dos campos, `ativo`, relógio ou palavra de estado inferido (NULL ≠
 * inativo/offline/removido; Shopee NULL ≠ NORMAL; visto_em antigo ≠ stale); (d) só os cards a usam
 * (página/filtro/agrupamento/ordem nunca); (e) card nunca some, não toca `ativo` e não dispara escrita
 * além da que já existia; (f) o browser não grava os campos (CAMPOS_GRAVAVEIS).
 */
export function observacaoNaUiNaoSoLeitura(raiz = RAIZ_V2): string[] {
  const erros: string[] = [];
  for (const f of [UI_OBSERVACAO, ...CARDS_OBSERVACAO]) if (!existsSync(join(raiz, f))) return [`${f} ausente`];
  // (a) projeção
  const col = tiraComentarios(ler(raiz, "lib/anuncios/colunas.ts"));
  const lista = /export const DB_ANUNCIO_COLUMNS = \[([\s\S]*?)\] as const;/.exec(col)?.[1] ?? "";
  if (!/"status_marketplace", "visto_em"/.test(lista)) erros.push("colunas: projeção da tela sem os campos de observação (leitura cega)");
  if ((col.match(CAMPO_OBS) ?? []).length !== (lista.match(CAMPO_OBS) ?? []).length) erros.push("colunas: campo de observação fora de DB_ANUNCIO_COLUMNS");
  // (b) tipo de leitura: só no módulo de apresentação, só opcional e readonly
  const ui0 = tiraComentarios(ler(raiz, UI_OBSERVACAO));
  const decl = /export interface ObservacaoLida \{([\s\S]*?)\}/.exec(ui0)?.[1].split(/\r?\n/).map((l) => l.trim()).filter(Boolean) ?? [];
  if (JSON.stringify(decl) !== JSON.stringify(["readonly status_marketplace?: string | null;", "readonly visto_em?: string | null;"])) erros.push(`${UI_OBSERVACAO}: tipo de leitura da observação não é opcional/readonly (${decl.join(" | ")})`);
  // (c) apresentação pura
  const ui = tiraComentarios(ler(raiz, UI_OBSERVACAO));
  if (/^\s*import\b|\brequire\(|\bimport\(/m.test(ui)) erros.push(`${UI_OBSERVACAO}: importa módulo (a apresentação é pura)`);
  if (/\bfetch\(|\.from\(|\.(update|insert|upsert|delete|rpc)\(|supabase|localStorage|sessionStorage|XMLHttpRequest|sendBeacon/.test(ui)) erros.push(`${UI_OBSERVACAO}: I/O ou escrita`);
  if (/\b(status_marketplace|visto_em)\s*(:|=(?!=))/.test(ui)) erros.push(`${UI_OBSERVACAO}: atribui/monta campo de observação`);
  if (/\bativo\b/.test(ui)) erros.push(`${UI_OBSERVACAO}: observação lê/deriva ativo`);
  if (/Date\.now\(|new Date\(\s*\)|performance\.now\(/.test(ui)) erros.push(`${UI_OBSERVACAO}: relógio na apresentação (visto_em vira decisão de idade)`);
  if (/\b(inactive|inativ\w*|offline|online|deleted|removid\w*|exclu\w*|stale|antig\w*|vencid\w*|NORMAL|UNLIST\w*|BANNED|paused|pausad\w*|closed|encerrad\w*)\b/i.test(ui)) erros.push(`${UI_OBSERVACAO}: estado inferido da observação`);
  // (d) só os cards usam a apresentação
  const runtime = listar(raiz, "app", "lib", "components").filter((f) => /\.(ts|tsx)$/.test(f));
  const importadores = runtime.filter((f) => arestas(raiz, f).some((a) => a.para === UI_OBSERVACAO)).sort();
  if (JSON.stringify(importadores) !== JSON.stringify([...CARDS_OBSERVACAO].sort())) erros.push(`apresentação da observação usada fora dos cards: ${importadores.join(", ") || "(nenhum)"}`);
  // (e) cards
  for (const f of CARDS_OBSERVACAO) {
    const s = tiraComentarios(ler(raiz, f));
    if (/\bif\s*\([^\n]*\bobs\w*\b[^\n]*\)\s*\{?\s*return\b|\bobs\w*\b[^\n]*\?\s*null\s*:/.test(s)) erros.push(`${f}: card some conforme a observação (observação não decide visibilidade)`);
    if (/\bativo\b/.test(s)) erros.push(`${f}: card toca ativo`);
    const fetches = [...s.matchAll(/\bfetch\([^\n]*/g)].map((m) => m[0]);
    const permitidos = FETCH_DOS_CARDS[f];
    if (fetches.length !== permitidos.length || !fetches.every((x, i) => permitidos[i].test(x))) erros.push(`${f}: escrita/fetch fora da lista fechada (${fetches.length})`);
  }
  // (f) o browser não grava os campos
  const serv = tiraComentarios(ler(raiz, "lib/anuncios/servico.ts"));
  const grav = /export const CAMPOS_GRAVAVEIS[^{]*\{([\s\S]*?)\};/.exec(serv)?.[1] ?? "";
  if (!grav || /\b(status_marketplace|visto_em)\b/.test(grav)) erros.push("servico: campos de observação graváveis pelo browser");
  return erros;
}

// ── I12: escopo de loja EXPLÍCITO nas leituras/escritas de vendas (Vendas A2) ─────
/** Toda cadeia `.from("<tabela>")...;` (até o fim do comando), sem comentários. */
function cadeiasDe(raiz: string, arquivo: string, tabela: string): string[] {
  const src = tiraComentarios(ler(raiz, arquivo));
  return [...src.matchAll(new RegExp(`\\.from\\(\\s*["']${tabela}["']\\s*\\)`, "g"))].map((m) => {
    const fim = src.indexOf(";", m.index!);
    return src.slice(m.index!, fim < 0 ? undefined : fim);
  });
}
/**
 * Cadeias de `pedidos` SEM filtro de loja — lista FECHADA, por arquivo e por forma. Nenhuma representa
 * "uma loja" por leitura: é escrita por id (a linha já carrega loja_id; id sem loja = dívida A4),
 * detecção por id do dono (precisa VER as outras lojas para não sobrescrevê-las), update por ids vindos
 * de seleção escopada, enumeração admin de lojas, ou o AGREGADO do dono (agente).
 */
export const PEDIDOS_SEM_LOJA_PERMITIDOS: Record<string, RegExp[]> = {
  "lib/sync-ml.ts": [/^\.from\("pedidos"\)\s*\.upsert\(resolvidas\.slice\(i, i \+ UPSERT_BATCH\), \{ onConflict: "id" \}\)$/],
  "lib/sync-shopee.ts": [
    /^\.from\("pedidos"\)\s*\.select\("id, loja_id, financial_reconciled_at"\)\s*\.eq\("user_id", userId\)\s*\.in\("id", lote\)$/,
    /^\.from\("pedidos"\)\s*\.upsert\(rows\.slice\(i, i \+ UPSERT_BATCH\), \{ onConflict: "id" \}\)$/,
  ],
  "lib/shopee/ingestao/persistencia.ts": [
    /^\.from\("pedidos"\)\.select\("id"\)\.eq\("user_id", userId\)\.in\("id", legados\.slice\(i, i \+ LOTE\)\)$/,
    /^\.from\("pedidos"\)\.upsert\(itens\.slice\(i, i \+ LOTE\), \{ onConflict: "id" \}\)$/,
  ],
  "app/api/admin/shopee/backfill-pedidos-0707/route.ts": [/^\.from\("pedidos"\)\.upsert\(lote, \{ onConflict: "id" \}\)$/],
  "app/api/admin/shopee/reconciliar-financeiro/route.ts": [/^\.from\("pedidos"\)\.update\(campos\)\.eq\("id", id\)$/],
  "app/api/admin/backfill-resumos-diarios/route.ts": [
    /^\.from\("pedidos"\)\s*\.select\("loja_id"\)\s*\.gte\("data_pagamento", data\)\s*\.lt\("data_pagamento", proximoDia\)\s*\.not\("loja_id", "is", null\)$/,
    /^\.from\("pedidos"\)\s*\.select\("loja_id"\)\s*\.gte\("data_criacao", data\)\s*\.lt\("data_criacao", proximoDia\)\s*\.not\("loja_id", "is", null\)$/,
  ],
  // AGREGADO do dono (agente): intencionalmente sem filtro de loja — nunca vira "uma loja" implícita.
  "lib/agentes/dados/vendas.ts": [/^\.from\("pedidos"\)\.select\(COLUNAS_LEITURA_INTERNA\), filtros\)\s*\.gte\("data_pagamento", filtro\.dataInicio\)\s*\.lte\("data_pagamento", filtro\.dataFim\)$/],
};
/**
 * I12_SALES_STORE_SCOPE_IS_EXPLICIT: (a) toda cadeia de `pedidos` no runtime filtra dono + loja
 * (`.eq("user_id", …)` e `.eq("loja_id", …)`), ou é uma das formas FECHADAS acima (cada arquivo com
 * exatamente essas); (b) /api/ml/vendas: a loja da leitura sai do resolvedor do servidor (conta
 * resolvida, ou a loja da credencial vencida); sem loja → falha fechado ANTES de qualquer `pedidos`;
 * cache, frescor de hoje e páginas com `loja_id = lojaLeitura`; a barreira multi-ML continua antes da
 * resolução (Vendas A5: no lugar da barreira, loja explícita ou 409 seleção — ver I16); (c) sync Shopee: "já existe" exige loja; leitura/UPDATE de status com loja; row existente de
 * OUTRA loja do dono nunca entra no upsert; (d) o agregado do dono (agente) é por dono (closure) e não
 * filtra loja — continua agregado, nunca single-store implícito.
 */
export function vendasSemEscopoDeLoja(raiz = RAIZ_V2): string[] {
  const erros: string[] = [];
  // (a)
  const runtime = listar(raiz, "app", "lib", "components").filter((f) => /\.(ts|tsx)$/.test(f));
  let escopadas = 0;
  for (const f of runtime) {
    const semLoja: string[] = [];
    for (const c of cadeiasDe(raiz, f, "pedidos")) {
      if (/\.eq\(\s*"loja_id",/.test(c) && /\.eq\(\s*"user_id",/.test(c)) { escopadas++; continue; }
      semLoja.push(c.trim());
    }
    const sobra = [...(PEDIDOS_SEM_LOJA_PERMITIDOS[f] ?? [])];
    for (const c of semLoja) {
      const i = sobra.findIndex((r) => r.test(c));
      if (i < 0) erros.push(`${f}: pedidos sem dono+loja fora da lista fechada — ${c.replace(/\s+/g, " ").slice(0, 120)}`);
      else sobra.splice(i, 1);
    }
    if (sobra.length) erros.push(`${f}: forma permitida ausente (lista fechada desatualizada): ${sobra.length}`);
  }
  for (const f of Object.keys(PEDIDOS_SEM_LOJA_PERMITIDOS)) if (!runtime.includes(f)) erros.push(`${f}: arquivo da lista fechada ausente`);
  if (escopadas < 10) erros.push(`ANCORA: só ${escopadas} cadeias de pedidos com dono+loja (detector cego?)`);
  // (b) /api/ml/vendas
  const rota = "app/api/ml/vendas/route.ts";
  const todo = tiraComentarios(ler(raiz, rota));
  const src = todo.slice(Math.max(0, todo.search(/export async function GET\(/)));
  // Vendas A5: no lugar da barreira multi-ML, a loja é EXPLÍCITA e validada antes de qualquer `pedidos`
  // (pedido `?loja_id` → resolverContaML sem fallback; sem pedido → só a loja única; 2+ → 409 seleção).
  const iConta = src.search(/const contaML = lojaPedida\s*\?\s*await resolverContaML\(userId, lojaPedida\)\s*:\s*await resolverContaML\(userId, null, \{ permitirUnica: true \}\);/);
  const iSelecao = src.search(/if \(!contaML\.ok && contaML\.motivo === "LOJA_NAO_DEFINIDA"\) \{[\s\S]{0,300}?return NextResponse\.json\(corpo, \{ status \}\);/);
  const iLoja = src.search(/const lojaLeitura: string \| null = contaML\.ok\s*\?\s*contaML\.lojaId\s*:\s*contaML\.motivo === "PRECISA_RECONECTAR" \? contaML\.loja\.id : null;/);
  const iFalha = src.search(/if \(!lojaLeitura\) \{\s*return NextResponse\.json\(/);
  const iPedidos = src.search(/\.from\("pedidos"\)/);
  if (iConta < 0 || iSelecao < iConta || iPedidos < iSelecao) erros.push(`${rota}: loja explícita/validada (ou seleção 409) não precede a leitura de pedidos`);
  if (iLoja < 0 || iLoja < iConta) erros.push(`${rota}: loja da leitura não sai do resolvedor do servidor`);
  if (iFalha < 0 || iFalha < iLoja || iPedidos < 0 || iFalha > iPedidos) erros.push(`${rota}: sem loja resolvida não falha fechado antes de ler pedidos`);
  const cadeiasRota = cadeiasDe(raiz, rota, "pedidos");
  if (cadeiasRota.length !== 3 || !cadeiasRota.every((c) => /\.eq\("user_id", userId\)\s*\.eq\("marketplace", "ML"\)\s*\.eq\("loja_id", lojaLeitura\)/.test(c))) erros.push(`${rota}: cache/frescor/página sem user_id + ML + loja_id = lojaLeitura`);
  // (c) sync Shopee
  const sp = tiraComentarios(ler(raiz, "lib/sync-shopee.ts"));
  if (!/export async function filtrarOrderSnsAusentes\(\s*userId: string,\s*lojaId: string,/.test(sp) || !/filtrarOrderSnsAusentes\(userId, lojaId, /.test(sp)) erros.push("sync-shopee: \"já existe\" sem a loja da execução");
  if (!/\.select\("order_id, status_shopee_raw"\)\s*\.eq\("user_id", userId\)\s*\.eq\("marketplace", "Shopee"\)\s*\.eq\("loja_id", lojaId\)/.test(sp)) erros.push("sync-shopee: leitura de status sem a loja");
  if (!/\.update\(\{ status: g\.statusComercial, status_shopee_raw: g\.statusRaw \}\)\s*\.eq\("user_id", userId\)\s*\.eq\("marketplace", "Shopee"\)\s*\.eq\("loja_id", lojaId\)/.test(sp)) erros.push("sync-shopee: UPDATE de status sem a loja (sync de B alcança A)");
  if (!/export function classificarExistentesShopee\([\s\S]{0,400}?if \(e\.loja_id !== null && e\.loja_id !== lojaId\) \{ deOutraLoja\.add\(e\.id\); continue; \}/.test(sp)) erros.push("sync-shopee: row de outra loja não é separada");
  const iClass = sp.search(/classificarExistentesShopee\(existentes, lojaId\)/), iSplice = sp.search(/if \(deOutraLoja\.has\(rows\[i\]\.id\)\) \{ rows\.splice\(i, 1\);/), iUpsert = sp.search(/\.upsert\(rows\.slice\(i, i \+ UPSERT_BATCH\), \{ onConflict: "id" \}\)/);
  if (iClass < 0 || iSplice < iClass || iUpsert < iSplice) erros.push("sync-shopee: row de outra loja pode entrar no upsert");
  // (d) agregado do dono
  const ag = tiraComentarios(ler(raiz, "lib/agentes/dados/vendas.ts"));
  const filtros = corpoDe(ag, /export function filtrosVendas\(/) ?? "";
  if (!/user_id: String\(userId\)/.test(filtros) || /loja/.test(filtros) || !/export function criarLeiturasDeVendas\(userId: string\)/.test(ag)) erros.push("agente: agregado do dono deixou de ser por dono, ou virou single-store implícito");
  return erros;
}

// ── I13: custo da venda vem AO VIVO de Meus Produtos (Vendas A3) ─────────
export const SERVICO_CUSTO_VENDA = "lib/vendas/custo-produto.ts";
export const ROTAS_VENDAS_CUSTO_LIVE: Array<{ arquivo: string; marketplace: "ML" | "Shopee"; loja: string }> = [
  { arquivo: "app/api/ml/vendas/route.ts", marketplace: "ML", loja: "lojaLeitura" },
  { arquivo: "app/api/shopee/vendas/route.ts", marketplace: "Shopee", loja: "lojaId" },
];
export const TELA_VENDAS = "app/(app)/vendas/page.tsx";
/**
 * I13_SALES_COST_COMES_FROM_MEUS_PRODUTOS: (a) um único serviço lê `anuncios` para custo de venda — por
 * dono + marketplace + loja, paginado (todas as páginas), SEM `ativo`, só identidade + campos do usuário
 * (nunca SKU); (b) chave exata marketplace|loja|item|variação; venda com variação → só a linha exata; ML sem
 * variação → só item de UMA linha sem variação, senão identidade incompleta (sem primeira/ativa/irmã);
 * (c) custo cadastrado = custo_produto > 0; sem custo / sem produto / incompleto → custo e lucro null
 * (pendente), nunca 0; frete do anúncio fora; (d) o serviço não grava (sem snapshot/backfill) e não lê o
 * custo persistido da venda; (e) cada rota carrega o mapa UMA vez, fora do laço, pela loja da leitura, e
 * não esconde venda por custo; (f) a tela de Vendas exibe custo/imposto/lucro/margem só de `financeiro`.
 */
export function custoDeVendaForaDeMeusProdutos(raiz = RAIZ_V2): string[] {
  const erros: string[] = [];
  if (!existsSync(join(raiz, SERVICO_CUSTO_VENDA))) return [`${SERVICO_CUSTO_VENDA} ausente`];
  const s = tiraComentarios(ler(raiz, SERVICO_CUSTO_VENDA));
  // (a) leitura
  const cadeias = cadeiasDe(raiz, SERVICO_CUSTO_VENDA, "anuncios");
  if (cadeias.length !== 1) erros.push(`serviço: ${cadeias.length} leituras de anuncios (esperado 1)`);
  const c = cadeias[0] ?? "";
  if (!/\.select\(COLUNAS_CUSTO_PRODUTO\)\s*\.eq\("user_id", userId\)\s*\.eq\("marketplace", marketplace\)\s*\.eq\("loja_id", lojaId\)/.test(c)) erros.push("serviço: leitura de custo sem dono + marketplace + loja");
  if (/ativo/.test(c) || /\.limit\(|\.range\(/.test(c)) erros.push("serviço: leitura de custo filtra ativo ou corta páginas");
  if (!/lerTodasAsPaginas<ProdutoDeCusto>\(\(\) => cliente\s*\.from\("anuncios"\)/.test(s)) erros.push("serviço: leitura de custo não paginada (PostgREST corta em 1000)");
  if (/\bativo\b/.test(s)) erros.push("serviço: custo acoplado a ativo");
  if (/\bsku\b/i.test(s)) erros.push("serviço: SKU no lookup de custo");
  if (!/export const COLUNAS_CUSTO_PRODUTO = "id, marketplace, loja_id, ml_item_id, variation_id, custo_produto, imposto, insumos";/.test(s)) erros.push("serviço: colunas do lookup fora do contrato");
  // (b) chave e resolução
  if (!/return `\$\{marketplace\}\|\$\{lojaId\}\|\$\{itemId\}\|\$\{variacaoId \?\? ""\}`;/.test(s)) erros.push("serviço: chave sem marketplace|loja|item|variação");
  const resolver = corpoDe(s, /export function resolverCustoProduto\(/) ?? "";
  if (!/if \(id\.variacaoInformada\) \{\s*const p = mapa\.exatos\.get\(chaveCustoProduto\(/.test(resolver)) erros.push("serviço: venda com variação não usa só a chave exata");
  if (!/if \(doItem\.length === 1 && !doItem\[0\]\.variation_id\) return encontrado\(mapa, doItem\[0\]\);/.test(resolver)
    || (resolver.match(/doItem\[/g) ?? []).length !== 2 || /\.find\(|\.sort\(|\.filter\(|\[doItem\.length/.test(resolver)
    || !/status: "PRODUCT_IDENTITY_INCOMPLETE"/.test(resolver)) erros.push("serviço: variação desconhecida escolhe uma linha (fallback)");
  // (c) presença e pendência
  if (!/export const custoCadastrado = \(p: ProdutoDeCusto\): boolean => \(numero\(p\.custo_produto\) \?\? 0\) > 0;/.test(s)) erros.push("serviço: presença de custo fora de custo_produto > 0");
  const fin = corpoDe(s, /export function financeiroDaVenda\(/) ?? "";
  if (!/const custoProduto = comCusto \? [^;]+ : null;/.test(fin) || !/const comCusto = resultado\.status === "PRODUCT_FOUND_WITH_COST" && p !== null;/.test(fin)) erros.push("serviço: custo sem cadastro vira número");
  if (!/let lucro: number \| null = null;\s*if \(pendencias\.length === 0 && custoProduto !== null && imposto !== null\) \{/.test(fin)) erros.push("serviço: lucro calculado com pendência");
  // A3.1: base financeira em ordem (repasse real → repasse legado → componentes ML → sem base) e SEM dupla
  // contagem: com repasse, só custo do produto e imposto saem; tarifa/frete/descontos já estão no repasse.
  if (!/\? \(venda\.has_income_data === true \? \(venda\.financial_reconciled_at \? "REPASSE_REAL" : "REPASSE_LEGADO"\) : "SEM_BASE"\)\s*: "COMPONENTES_ESTIMADOS";/.test(fin)
    || !/const qualidadeFinanceira: QualidadeFinanceira = base === "REPASSE_REAL" \? "ACTUAL" : base === "SEM_BASE" \? "PENDING" : "ESTIMATED";/.test(fin)) erros.push("serviço: base/qualidade financeira fora da ordem aprovada (ACTUAL só com repasse reconciliado)");
  if (!/const liquidoDaVenda = porRepasse \? \(numero\(venda\.escrow_amount\) \?\? 0\) : faturamento - tarifa;\s*lucro = liquidoDaVenda - custoProduto - imposto;/.test(fin)
    || (fin.match(/- tarifa\b/g) ?? []).length !== 1) erros.push("serviço: dupla contagem (repasse − tarifa/frete) ou base de lucro fora do contrato");
  if (!/const tarifa = shopee \? \(numero\(venda\.tarifa_venda\) \?\? 0\) : \(numero\(venda\.tarifa_venda\) \?\? 0\) \* qtd;/.test(fin)) erros.push("serviço: tarifa ML (sale_fee por unidade) sem × qtd");
  if (/pendencias\.push\("frete"\)/.test(fin)) erros.push("serviço: regra global frete ausente → lucro pendente voltou");
  // A3.2-B: frete REAL do ML só pelo envio reconciliado (ml-financeiro.ts, I17); nunca o do anúncio nem o legado da venda.
  if (/custo_frete|\bvenda\.frete_|\bp!?\.frete_/.test(s)) erros.push("serviço: frete do anúncio/legado no cálculo");
  // (d) sem escrita, sem custo persistido
  if (/\.(update|insert|upsert|delete|rpc)\(/.test(s)) erros.push("serviço: grava (snapshot/backfill proibido)");
  if (/venda\.(custo|imposto|lucro|lucro_liquido|margem_contrib|insumos|cadastrado)\b/.test(s)) erros.push("serviço: usa custo/lucro persistido da venda como autoridade");
  // (e) rotas
  for (const { arquivo, marketplace, loja } of ROTAS_VENDAS_CUSTO_LIVE) {
    const r = tiraComentarios(ler(raiz, arquivo));
    const cargas = r.match(/carregarMapaCustoProduto\(/g) ?? [];
    const iCarga = r.search(new RegExp(`const mapaCusto = await carregarMapaCustoProduto\\(supabase\\(\\), userId, "${marketplace}", ${loja}\\);`));
    // A3.2-B: a rota ML passa o financeiro REAL do pedido (lido do banco, mesma loja) como 3º argumento.
    const iRows = marketplace === "ML"
      ? r.search(/let rows = \(pedidos \?\? \[\]\)\.map\(\(p: any\) => \(\{\s*\.\.\.pedidoToRow\(p\),\s*packId: financeiroML\.get\(String\(p\.order_id\)\)\?\.pedido\.pack_id \?\? null,\s*financeiro: mapaCusto\.ok \? financeiroDaVenda\(p, resolverCustoProduto\(mapaCusto\.mapa, identidadeDaVenda\(p\)\), financeiroML\.get\(String\(p\.order_id\)\) \?\? null\) : null,\s*\}\)\);/)
      : r.search(/let rows = \(pedidos \?\? \[\]\)\.map\(\(p: any\) => \(\{\s*\.\.\.pedidoToRow\(p\),\s*financeiro: mapaCusto\.ok \? financeiroDaVenda\(p, resolverCustoProduto\(mapaCusto\.mapa, identidadeDaVenda\(p\)\)\) : null,\s*\}\)\);/);
    if (cargas.length !== 1 || iCarga < 0 || iRows < 0 || iCarga > iRows) erros.push(`${arquivo}: lookup de custo fora do contrato (uma carga por requisição, pela loja da leitura, antes das linhas)`);
    if (/\.filter\([^)]*(financeiro|custoStatus)/.test(r)) erros.push(`${arquivo}: venda escondida por estado de custo`);
    if (/from\(\s*["']anuncios["']\s*\)/.test(r)) erros.push(`${arquivo}: rota lê anuncios por fora do serviço de custo`);
  }
  // (f) tela
  const tela = tiraComentarios(ler(raiz, TELA_VENDAS)).replace(/interface VendaRow \{[\s\S]*?\n\}/, "");
  if (/\br\.(custo|imposto|margemContrib|mcPercent|cadastrado|freteComprador|freteVendedor)\b|totais\.(custo|imposto|margemContrib)\b/.test(tela)) erros.push("Vendas (tela): exibe custo/lucro LEGADO persistido");
  if (!/const live = totaisLive\(/.test(tela) || !/avisoCustoLive\(r\.financeiro\)/.test(tela)) erros.push("Vendas (tela): sem o cálculo ao vivo / sem aviso de custo pendente");
  return erros;
}

// ── I14: identidade EXATA da linha de venda ML (Vendas A4-B) ─────────────
/**
 * I14_ML_SALE_ITEM_IDENTITY_IS_EXACT: (a) o laço de order_items lê a variação do PROVIDER
 * (`variacaoDoItemML(orderItem)` ← `orderItem.item.variation_id`) e a grava na linha — nunca `variation_id:
 * null` forçado nem variação vinda do anúncio; uma linha por item (quantidade não vira linhas) e receita =
 * valorUnit × qtd; (b) id NOVO com loja e variação; (c) resolução: só existentes da MESMA loja; legada
 * reaproveitada pela identidade exata; adoção de variação só com UMA variação do item e UMA legada; 2+ →
 * ambígua, não gravada; nada de SKU/nome/preço/posição; (d) existentes lidos por dono + ML + loja; erro de
 * leitura/gravação lança e o sync não devolve sucesso; (e) A3 usa o caminho exato quando há variação.
 */
export function identidadeVendaMLNaoExata(raiz = RAIZ_V2): string[] {
  const erros: string[] = [];
  const s = tiraComentarios(ler(raiz, "lib/sync-ml.ts"));
  // (a) laço de itens
  const iLaco = s.search(/for \(const orderItem of \(order\.order_items \?\? \[\]\)\) \{/);
  const laco = iLaco < 0 ? "" : s.slice(iLaco, s.indexOf("rows.push({", iLaco) + 2400);
  if (!laco) erros.push("sync-ml: laço de order_items não encontrado (detector cego)");
  if (!/const variationId\s+= variacaoDoItemML\(orderItem\);/.test(laco) || !/variation_id:\s+variationId,/.test(laco)) erros.push("sync-ml: variação do provider não gravada na linha");
  if (/variation_id:\s+null\b|variation_id:\s+anuncio/.test(laco)) erros.push("sync-ml: variação forçada a null ou vinda do anúncio");
  if (!/loja_id:\s+lojaId,/.test(laco)) erros.push("sync-ml: linha ML sem loja_id");
  if (!/const faturamento\s+= valorUnit \* qtd;/.test(laco) || /for \(let \w+ = 0; \w+ < qtd|Array\.from\(\{ length: qtd/.test(s)) erros.push("sync-ml: receita fora de valorUnit × qtd ou quantidade vira linhas");
  const variacao = corpoDe(s, /export function variacaoDoItemML\(/) ?? "";
  if (!/const v = orderItem\?\.item\?\.variation_id;/.test(variacao) || /sku|title|price|anuncio/.test(variacao)) erros.push("sync-ml: variação não vem de orderItem.item.variation_id");
  // (b) id novo
  if (!/return `\$\{userId\}_ML_\$\{lojaId\}_\$\{orderId\}_\$\{itemId\}_\$\{variationId \?\? "nv"\}`;/.test(s) || !/id:\s+idPedidoML\(userId, lojaId, String\(order\.id\), mlItemId, variationId\),/.test(laco)) erros.push("sync-ml: id novo sem loja/variação");
  // (c) resolução
  const res = (() => { const i = s.indexOf("export function resolverIdsPedidosML"); return i < 0 ? "" : s.slice(i, s.indexOf("\nexport ", i + 10) < 0 ? undefined : s.indexOf("\n}\n", i) + 3); })();
  if (!/const daLoja = existentes\.filter\(\(e\) => e\.loja_id === lojaId\);/.test(res)) erros.push("resolução: existentes de outra loja podem ser adotados");
  if (!/if \(variacoes\.size === 1 && legados\.length === 1\) \{ saida\.push\(\{ \.\.\.l, id: legados\[0\]\.id \}\); continue; \}/.test(res)
    || !/ambiguas\.set\(k, \{[^}]*\}\);\s*continue;/.test(res)) erros.push("resolução: adoção de variação sem exigir UMA variação/UMA legada, ou ambígua gravada");
  if (/sku|nome|preco|valor_unit|anuncio|title|\.sort\(\)\[0\]|variacoes\]\[0\]/i.test(res.replace(/variacoes: \[\.\.\.variacoes\]\.sort\(\)/, ""))) erros.push("resolução: SKU/nome/preço/posição na identidade");
  // (d) leitura e gravação
  const leit = corpoDe(s, /async function lerPedidosMLExistentesDaLoja\(/) ?? "";
  if (!/\.eq\("user_id", userId\)\s*\.eq\("marketplace", "ML"\)\s*\.eq\("loja_id", lojaId\)\s*\.in\("order_id"/.test(leit) || !/if \(error\) throw new ErroGravacaoPedidosML/.test(leit)) erros.push("sync-ml: leitura de existentes sem dono+ML+loja ou sem falhar");
  const iRes = s.search(/const \{ linhas: resolvidas, ambiguas \} = resolverIdsPedidosML\(lojaId, rows, existentes\);/);
  const iUp = s.search(/\.upsert\(resolvidas\.slice\(i, i \+ UPSERT_BATCH\), \{ onConflict: "id" \}\);\s*if \(error\) throw new ErroGravacaoPedidosML/);
  const iRet = s.search(/return \{ found, inserted: resolvidas\.length/);
  if (iRes < 0 || iUp < iRes || iRet < iUp) erros.push("sync-ml: gravação fora da resolução, erro de gravação ignorado ou sucesso antes da gravação");
  // (e) A3
  const cp = tiraComentarios(ler(raiz, SERVICO_CUSTO_VENDA));
  if (!/variacaoInformada: venda\.variation_id !== null && venda\.variation_id !== undefined && venda\.variation_id !== ""/.test(cp)) erros.push("A3: venda ML com variação não usa o caminho exato");
  return erros;
}

// ── I15: identidade da linha de venda ML garantida pelo BANCO (Vendas A4-C) ──────
/**
 * I15_ML_SALE_IDENTITY_IS_DB_UNIQUE: localizada pelo CONTEÚDO (não pelo nome do arquivo), existe UMA migration
 * em supabase/migrations que cria o UNIQUE parcial ML de pedidos sobre (loja_id, order_id, ml_item_id,
 * coalesce(variation_id, '')) WHERE marketplace = 'ML' (+ loja e item não nulos), sem SKU e sem pedidos.id na
 * identidade; o arquivo tem prechecks fail-closed (índice já existente, duplicata, sentinel '') e não escreve
 * dados (UPDATE/DELETE/INSERT), não muda nulabilidade, não derruba nada e não usa CONCURRENTLY (aplicação
 * transacional). Fórmula financeira segue sob I13; a barreira multi-ML de vendas-hoje, sob I7.
 */
export function identidadeVendaMLNaoNoBanco(raiz = RAIZ_V2): string[] {
  const erros: string[] = [];
  const semComentario = (s: string) => s.replace(/--[^\n]*/g, "");
  const migracoes = listar(raiz, "supabase/migrations").filter((f) => f.endsWith(".sql"))
    .map((f) => ({ f, sql: semComentario(ler(raiz, f)).toLowerCase().replace(/\s+/g, " ") }))
    .filter((m) => /create unique index \w+ on public\.pedidos \(/.test(m.sql) && /marketplace = 'ml'/.test(m.sql));
  if (migracoes.length !== 1) return [`${migracoes.length} migration(s) com UNIQUE ML em pedidos (esperado 1)`];
  const { f, sql } = migracoes[0];
  const idx = /create unique index (\w+) on public\.pedidos \(([^;]*?)\) where ([^;]*);/.exec(sql);
  if (!idx) return [`${f}: UNIQUE ML de pedidos fora da forma (colunas + where)`];
  if (idx[2].trim() !== "loja_id, order_id, ml_item_id, coalesce(variation_id, '')") erros.push(`${f}: identidade do índice ≠ (loja_id, order_id, ml_item_id, coalesce(variation_id, '')) — ${idx[2]}`);
  if (idx[3].trim() !== "marketplace = 'ml' and loja_id is not null and ml_item_id is not null") erros.push(`${f}: predicado do índice fora do contrato — ${idx[3]}`);
  if (/\bsku\b|\bid\b(?!_)/.test(idx[2])) erros.push(`${f}: SKU ou pedidos.id na identidade`);
  const semStrings = sql.replace(/'[^']*'/g, "''");
  if (/\b(update|delete|insert|truncate)\s/.test(semStrings) || /set not null|\bdrop\b|concurrently/.test(semStrings)) erros.push(`${f}: escrita de dados, NOT NULL, DROP ou CONCURRENTLY na migration`);
  const iIdx = sql.indexOf(`create unique index ${idx[1]}`);
  const pre = sql.slice(0, iIdx);
  if (!/indexname = '\w+'.*if n <> 0 then raise exception/.test(pre) || !/having count\(\*\) > 1\) d; if n <> 0 then raise exception/.test(pre) || !/variation_id = ''; if n <> 0 then raise exception/.test(pre)) erros.push(`${f}: prechecks fail-closed ausentes antes do índice (existente / duplicata / sentinel)`);
  return erros;
}

/** Corpo de `function nome(...) { ... }` por balanceamento de chaves (sem comentários). */
function corpoDaFuncao(src: string, nome: string): string | null {
  const m = new RegExp(`function ${nome}\\([^)]*\\)[^\\n]*\\{\\n`).exec(src);   // a { que fecha a assinatura, não a do tipo de retorno
  if (!m) return null;
  let n = 1, i = m.index + m[0].length;
  for (; i < src.length && n > 0; i++) { if (src[i] === "{") n++; else if (src[i] === "}") n--; }
  return src.slice(m.index + m[0].length, i - 1);
}
/**
 * A3.3.1 (tela): a página de Vendas NÃO tem mais o fluxo legado de "Histórico" (sync manual por janela/mês via
 * /api/sync/manual, sync rápido/personalizado, teste rápido, onboarding de histórico). O único sync da tela é
 * `dispararSincronizar` (jobs/inline); o endpoint /api/sync/manual segue no servidor (núcleo compartilhado).
 * Substitui a regra A5-B.1 (plano do sync manual) — sem chamador na tela, não há janela a planejar.
 */
export function syncManualSemPlano(pg: string): string[] {
  const erros: string[] = [];
  if (/\/api\/sync\/manual/.test(pg)) erros.push("tela de Vendas volta a chamar /api/sync/manual (fluxo legado de histórico)");
  for (const [re, oque] of [[/\bsyncJanela\b|\bplanoSyncOuAviso\b|\bplanoSyncManual\b/, "plano/janela do sync manual"], [/\biniciarHistorico\b|\breprocessarErros\b|\bhistoricoOpen\b|historico_concluido_v1/, "fluxo de histórico"], [/\biniciarSyncRapido\b|\btestarSync\b/, "sync rápido/teste rápido"], [/🗂 Histórico|Sincronizar Histórico|Configure seu histórico/, "botão/texto de histórico"]] as const) {
    if (re.test(pg)) erros.push(`tela de Vendas com ${oque} legado`);
  }
  return erros;
}

// ── I16: loja ML EXPLÍCITA na tela/rota de Vendas (Vendas A5) ─────────────────────
export const PAGINA_VENDAS = "app/(app)/vendas/page.tsx";
export const HELPER_LOJA_ML_VENDAS = "app/(app)/vendas/loja-ml.ts";
/**
 * I16_ML_VENDAS_STORE_IS_EXPLICIT: (rota) a loja vem de `?loja_id` (resolverContaML SEM opt-in de única —
 * inválida/inativa/de outro dono nunca cai para outra) ou, sem pedido, só da ÚNICA; 2+ → 409 com as lojas do
 * PRÓPRIO dono; inválida → 404 LOJA_ML_INVALIDA antes de qualquer `pedidos`; sem cookie, sem getMLLojaAtiva,
 * sem contagem/barreira, sem `.in("loja_id")` (agregação); sync e custo com a loja resolvida. (sync manual)
 * `loja_id_ml` resolve SÓ essa loja (sem cookie, sem única). (tela) helper puro de seleção; `loja_id` em toda
 * leitura ML; leitura ML só com a loja decidida; resposta de outra loja descartada; 409/404 tratados sem
 * fallback; job de sync e sync manual com a loja escolhida; nada de `lojas[0]`/ordem para 2+. (helper) a salva
 * só vale se estiver na lista; `[0]` só com UMA loja. vendas-hoje mantém a barreira; helper e constante em
 * lib/ml-conexao.ts permanecem.
 */
export function lojaMLVendasNaoExplicita(raiz = RAIZ_V2): string[] {
  const erros: string[] = [];
  const rota = "app/api/ml/vendas/route.ts";
  const todo = tiraComentarios(ler(raiz, rota));
  const r = todo.slice(Math.max(0, todo.search(/export async function GET\(/)));
  const iPedidos = r.search(/\.from\("pedidos"\)/);
  // 1. loja pedida pela query; a pedida nunca tem opt-in de única (sem fallback)
  if (!/const lojaPedida = url\.searchParams\.get\("loja_id"\);/.test(r)) erros.push(`${rota}: loja não vem de ?loja_id`);
  const chamadas = [...r.matchAll(/resolverContaML\(([^;]*?)\)(?=\s*[:;])/g)].map((m) => m[1].replace(/\s+/g, " ").trim());
  if (chamadas.length !== 2 || chamadas[0] !== "userId, lojaPedida" || chamadas[1] !== "userId, null, { permitirUnica: true }") erros.push(`${rota}: resolverContaML fora do contrato (pedida sem fallback | única sem pedido): ${JSON.stringify(chamadas)}`);
  // 2. sem cookie / "mais recente" / barreira / agregação / ordem
  if (/lerCookie|loja_ativa_id|cookies\(\)/.test(r)) erros.push(`${rota}: cookie usado como identidade da loja`);
  if (/getMLLojaAtiva\(|contarLojasMLAtivasDoDono|MULTI_ML_VENDAS_NOT_READY/.test(todo)) erros.push(`${rota}: "mais recente"/contagem/barreira multi-ML de volta na rota principal`);
  if (/\.in\(\s*"loja_id"/.test(todo) || /lojas\[\d\]/.test(r)) erros.push(`${rota}: agregação ou escolha de loja por ordem`);
  // 3. 409 com as lojas do próprio dono; 404 inválida — ambos antes de pedidos
  const i409 = r.search(/motivo: ML_STORE_SELECTION_REQUIRED,\s*lojas: contaML\.lojas\.map\(/);
  const i404 = r.search(/if \(!contaML\.ok && contaML\.motivo === "LOJA_INVALIDA"\) \{\s*const \{ status, corpo \} = respostaSelecaoLojaML\(\{ ok: false, motivo: LOJA_ML_INVALIDA \}\);\s*return NextResponse\.json\(corpo, \{ status \}\);/);
  if (i409 < 0 || iPedidos < 0 || i409 > iPedidos) erros.push(`${rota}: 409 de seleção não usa as lojas do dono antes de pedidos`);
  if (i404 < 0 || iPedidos < 0 || i404 > iPedidos) erros.push(`${rota}: loja inválida/inativa não vira 404 LOJA_ML_INVALIDA antes de pedidos`);
  // 4. sync e custo com a loja resolvida
  const syncs = [...r.matchAll(/syncMLForUser\(([^)]*)\)/g)].map((m) => m[1].trim());
  if (syncs.length < 1 || !syncs.every((a) => /, lojaML$/.test(a))) erros.push(`${rota}: sync ML sem a loja resolvida`);
  if (!/carregarMapaCustoProduto\(supabase\(\), userId, "ML", lojaLeitura\)/.test(r)) erros.push(`${rota}: custo ao vivo fora da loja da leitura`);
  // 5. sync manual: loja_id_ml resolve SÓ ela
  const sm = tiraComentarios(ler(raiz, "app/api/sync/manual/route.ts"));
  if (!/\.loja_id_ml\s*\?\s*resolverContaML\(userId, \(body as \{ loja_id_ml\?: string \}\)\.loja_id_ml\)\s*:/.test(sm)) erros.push("app/api/sync/manual/route.ts: loja_id_ml não resolve SÓ a loja escolhida (sem cookie/única)");
  // 6. tela
  const pg = tiraComentarios(ler(raiz, PAGINA_VENDAS));
  if (!/from "\.\/loja-ml";/.test(pg)) erros.push(`${PAGINA_VENDAS}: não usa o helper puro de loja ML`);
  if (!/if \(mkt === "ML" && !prontoMLRef\.current\) return/.test(pg)) erros.push(`${PAGINA_VENDAS}: lê ML antes de a loja estar decidida`);
  const iSet = pg.search(/if \(mkt === "ML" && lojaDaChamada\) params\.set\("loja_id", lojaDaChamada\);/);
  const iUrl = pg.search(/`\/api\/ml\/vendas\?\$\{params\}`/);
  if (iSet < 0 || iUrl < 0 || iSet > iUrl) erros.push(`${PAGINA_VENDAS}: leitura ML sem loja_id antes da URL`);
  if ((pg.match(/\/api\/ml\/vendas[?`"]/g) ?? []).length !== 1) erros.push(`${PAGINA_VENDAS}: chamada a /api/ml/vendas fora de lerMarketplace`);
  if (!/if \(lojaMLRef\.current !== lojaDaChamada\) return \{ falhou: true, data: null \};/.test(pg)) erros.push(`${PAGINA_VENDAS}: resposta de outra loja não é descartada`);
  if (!/data\?\.codigo === "ML_STORE_SELECTION_REQUIRED"/.test(pg) || !/data\?\.codigo === "LOJA_ML_INVALIDA"[\s\S]{0,200}?lojaMLRef\.current = null;/.test(pg)) erros.push(`${PAGINA_VENDAS}: 409/404 de loja sem tratamento (ou com fallback)`);
  if (!/const lojaId = mkt === "ML" \? lojaMLRef\.current : shopeeLojaId;/.test(pg)) erros.push(`${PAGINA_VENDAS}: job de sync ML sem a loja escolhida`);
  // A3.3.1: sem o fluxo legado de histórico (nenhum sync manual por janela na tela)
  for (const v of syncManualSemPlano(pg)) erros.push(`${PAGINA_VENDAS}: ${v}`);
  if (/lojasML\[\d\]|lojas\[\d\]/.test(pg)) erros.push(`${PAGINA_VENDAS}: loja ML escolhida por ordem`);
  // 7. helper puro
  const h = tiraComentarios(ler(raiz, HELPER_LOJA_ML_VENDAS));
  if (/^import /m.test(h) || /fetch\(|localStorage\./.test(h)) erros.push(`${HELPER_LOJA_ML_VENDAS}: helper não é puro`);
  if (!/if \(lojas\.length === 1\) return \{ lojaId: lojas\[0\]\.id/.test(h) || (h.match(/\[\d\]/g) ?? []).length !== 2 || !/const valida = salva !== null && lojas\.some\(\(l\) => l\.id === salva\);/.test(h)) erros.push(`${HELPER_LOJA_ML_VENDAS}: escolha inicial fora do contrato (única | salva na lista | escolha)`);
  if (/planoSyncManual|AVISO_SELECIONE_LOJA_ML_SYNC/.test(h)) erros.push(`${HELPER_LOJA_ML_VENDAS}: plano do sync manual legado de volta`);
  // 8. vendas-hoje e helper legado preservados
  const mc = tiraComentarios(ler(raiz, "lib/ml-conexao.ts"));
  if (!/export const MULTI_ML_VENDAS_NOT_READY = "MULTI_ML_VENDAS_NOT_READY";/.test(mc) || !/export async function contarLojasMLAtivasDoDono\(/.test(mc)) erros.push("lib/ml-conexao.ts: helper/constante da barreira removidos");
  if (!/MULTI_ML_VENDAS_NOT_READY/.test(tiraComentarios(ler(raiz, "app/api/ml/vendas-hoje/route.ts")))) erros.push("app/api/ml/vendas-hoje/route.ts: barreira multi-ML removida");
  return erros;
}

// ── I17: financeiro REAL do Mercado Livre (Vendas A3.2-B) ───────────────────────────
export const MODULO_FIN_ML = "lib/vendas/ml-financeiro.ts";
export const COLETOR_FIN_ML = "lib/vendas/ml-financeiro-coleta.ts";
export const LEITOR_FIN_ML = "lib/vendas/ml-financeiro-leitura.ts";
export const MIGRACAO_FIN_ML = "supabase/migrations/20261115_ml_financeiro.sql";
/**
 * I17_ML_FINANCIAL_RECONCILIATION_IS_REAL: líquido ML = receita − tarifa LÍQUIDA (Σ sale_fee × qtd) − frete do
 * vendedor (Σ senders[].cost), nada somado de volta (rebate já na tarifa, desconto do vendedor já no preço),
 * sem receiver.cost (comprador) nem gross_amount; ACTUAL só com billing CONFERIDO; envio compartilhado (sem
 * rateio do provider) → PENDING; frete gravado UMA vez por envio; tarifa com proveniência (sync: PROVIDER |
 * ESTIMATE, estimativa POR UNIDADE); legado segue ESTIMATED; coletor só GET e fora das rotas; a rota só lê o
 * banco (dono + loja); código da venda ML = pack_id ?? order_id; migration aditiva (fechamento provado nas SEC-3).
 */
export function financeiroMLNaoReal(raiz = RAIZ_V2): string[] {
  const erros: string[] = [];
  for (const f of [MODULO_FIN_ML, COLETOR_FIN_ML, LEITOR_FIN_ML, MIGRACAO_FIN_ML]) if (!existsSync(join(raiz, f))) return [`${f} ausente`];
  const m = tiraComentarios(ler(raiz, MODULO_FIN_ML));
  // líquido
  const liq = corpoDaFuncao(m, "liquidoPedidoML") ?? "";
  if (!/const liquido = cent\(p\.receita_produto - p\.tarifa_venda - envio\.frete_vendedor\);/.test(liq) || (liq.match(/[-+] /g) ?? []).length !== 2) erros.push("líquido ML fora de receita − tarifa líquida − frete do vendedor");
  if (/desconto|rebate|frete_comprador|frete_bruto|gross/.test(liq)) erros.push("líquido ML soma/subtrai desconto, rebate, frete do comprador ou bruto (dupla contagem)");
  if (!/qualidade: p\.billing_status === "CONFERIDO" \? "ACTUAL" : "ESTIMATED"/.test(liq) || (liq.match(/"ACTUAL"/g) ?? []).length !== 1) erros.push("ACTUAL sem billing CONFERIDO");
  if (!/if \(!envio\.pedidos \|\| envio\.pedidos\.length !== 1 \|\| envio\.pedidos\[0\] !== p\.order_id\) return \{ liquido: null, freteVendedor: null, qualidade: "PENDING", motivo: "frete_compartilhado" \};/.test(liq)) erros.push("envio compartilhado sem rateio vira número (frete duplicado/inventado)");
  if (!/if \(p\.tarifa_origem !== "PROVIDER" \|\| p\.tarifa_venda === null\) return \{ liquido: null, freteVendedor: null, qualidade: "PENDING", motivo: "tarifa" \};/.test(liq)) erros.push("tarifa ausente/não-provider vira líquido");
  // extração
  const env = corpoDaFuncao(m, "extrairEnvioFinanceiroML") ?? "";
  if (!/senders\.reduce\(\(a, s\) => a \+ \(s\.cost as number\), 0\)/.test(env) || !/frete_comprador: custos \? num\(custos\?\.receiver\?\.cost\) : null/.test(env) || !/frete_bruto_referencia: custos \? num\(custos\?\.gross_amount\) : null/.test(env) || (env.match(/gross_amount/g) ?? []).length !== 1) erros.push("frete do vendedor fora de senders[].cost (ou bruto/receiver usados como custo)");
  const ped = corpoDaFuncao(m, "extrairPedidoFinanceiroML") ?? "";
  if (!/if \(fee === null\) tarifaCompleta = false; else tarifa \+= fee \* qtd;/.test(ped) || !/tarifa_origem: tarifaCompleta \? "PROVIDER" : "AUSENTE"/.test(ped) || !/receita \+= \(num\(i\?\.unit_price\) \?\? 0\) \* qtd;/.test(ped)) erros.push("tarifa/receita do pedido fora de Σ sale_fee × qtd / Σ unit_price × qtd (com proveniência)");
  // sync: proveniência + estimativa por unidade
  const sy = tiraComentarios(ler(raiz, "lib/sync-ml.ts"));
  if (!/const tarifaOrigem: "PROVIDER" \| "ESTIMATE" = saleFeeML !== null \? "PROVIDER" : "ESTIMATE";/.test(sy) || !/tarifaVenda = valorUnit \* comissaoRate;/.test(sy) || !/tarifa_origem:\s*tarifaOrigem,/.test(sy) || /faturamento \* comissaoRate/.test(sy)) erros.push("sync-ml: tarifa sem proveniência ou estimativa da LINHA (× qtd de novo)");
  // serviço: real só pelo pedido reconciliado; legado continua ESTIMATED (I13)
  const s = tiraComentarios(ler(raiz, SERVICO_CUSTO_VENDA));
  const real = corpoDaFuncao(s, "financeiroRealML") ?? "";
  if (!/const liq = liquidoPedidoML\(ml\.pedido, ml\.envio\);/.test(real) || !/qualidadeFinanceira: liq\.qualidade,/.test(real) || /"ACTUAL"/.test(real)) erros.push("serviço: qualidade ML real fora do líquido reconciliado");
  if (!/const real = !shopee && ml && ml\.pedido\.itens === 1 && Math\.abs\(ml\.pedido\.receita_produto - faturamento\) <= 0\.01 \? ml : null;/.test(s)) erros.push("serviço: financeiro real aplicado a linha de pedido com várias linhas (rateio inventado)");
  // coletor: só GET, envio 1×, fora das rotas
  const c = tiraComentarios(ler(raiz, COLETOR_FIN_ML));
  if (!/method: "GET"/.test(c) || /method:\s*"(POST|PUT|PATCH|DELETE)"|\.(post|put|patch|delete)\(/i.test(c)) erros.push("coletor: chamada ao provider que não é GET");
  if (!/if \(!envios\.has\(shipment_id\)\) envios\.set\(shipment_id, \(async \(\) => \{/.test(c) || (c.match(/getML\(`\/shipments\//g) ?? []).length !== 1 || !/await envios\.get\(shipment_id\);/.test(c) || !/if \(!s \|\| enviosVistos\.has\(s\) \|\| !envios\.has\(s\)\) continue;/.test(c)) erros.push("coletor: custo do envio buscado/gravado por pedido (frete duplicado)");
  // A3.2-C: SÓ a rota de retry importa o motor (o GET de Vendas e a tela nunca chamam o provider)
  const ROTA_RETRY_FIN_ML = "app/api/ml/vendas/financeiro/route.ts";
  for (const f of listar(raiz, "app").filter((x) => /\.(ts|tsx)$/.test(x))) if (f !== ROTA_RETRY_FIN_ML && /ml-financeiro-coleta/.test(ler(raiz, f))) erros.push(`${f}: provider financeiro chamado em rota/tela (só no sync e no retry)`);
  // A3.2-C FINANCIAL_ON_SYNC: o core do sync (todo caminho passa por syncMLForUserV2) coleta o financeiro DEPOIS
  // de gravar os pedidos, com a MESMA loja/credencial e o payload já trazido; erro financeiro é logado, não some.
  const iUpsert = sy.search(/\.from\("pedidos"\)\s*\.upsert\(resolvidas/);
  const iFin = sy.search(/financeiro = await coletarFinanceiroML\(\s*\{ userId, lojaId, accessToken: token \},\s*\{ pedidos: allOrders\.filter\(\(o\) => o\._status === "paid" && gravados\.has\(String\(o\.id\)\)\) \},\s*depsFinanceiroML\(userId, lojaId\),\s*\{ ate: inicioSync \+ JANELA_PROVIDER_MS \},\s*\);/);
  if (iUpsert < 0 || iFin < iUpsert) erros.push("sync-ml: financeiro não coletado no core do sync depois de gravar os pedidos (mesma loja/credencial/payload)");
  if (!/console\.error\(`\[ml-financeiro\] ERRO enriquecimento loja=\$\{lojaId\}/.test(sy)) erros.push("sync-ml: falha do enriquecimento financeiro silenciosa");
  if ((sy.match(/coletarFinanceiroML\(/g) ?? []).length !== 1) erros.push("sync-ml: motor financeiro chamado fora do ponto único do core");
  // INTEGRATION_ERROR não é silencioso nem transitório; ACTUAL não é reconsultado; orçamento explícito
  const cls = corpoDaFuncao(m, "classificarHttpML") ?? "";
  if (!/if \(status === 0 \|\| status === 429 \|\| status === 502 \|\| status === 503 \|\| status === 504\) return "TRANSIENT_ERROR";/.test(cls) || !/return "INTEGRATION_ERROR";/.test(cls)) erros.push("classificação TRANSIENT/INTEGRATION fora do contrato (404/4xx viraria retry)");
  if (!/if \(classe === "TRANSIENT_ERROR"\) \{[^\n]*continue; \}/.test(c) || !/if \(t > 0\) await deps\.esperar\(BACKOFF_BASE_MS \* 2 \*\* \(t - 1\)\);/.test(c) || !/signal: ctrl\.signal/.test(c)) erros.push("coletor: retry/backoff/timeout fora do contrato (só transitório repete)");
  // logs do motor: com contexto (loja, pedido, pack, envio, etapa, HTTP) e SEM token/comprador — só as linhas log(`...`)
  const linhasLog = c.match(/log\(`[^`]*`\)/g) ?? [];
  if (!/log\(`\[ml-financeiro\] \$\{g\.classe\} loja=\$\{conta\.lojaId\} order=\$\{g\.order_id\} pack=/.test(c) || linhasLog.length < 3 || linhasLog.some((l) => /token|buyer|receiver|nickname|email/i.test(l))) erros.push("coletor: falha sem log sanitizado (ou log com token/comprador)");
  const plano = corpoDaFuncao(m, "planoRecuperacaoML") ?? "";
  if (!/const fila = ids\.filter\(\(id\) => planos\.get\(id\)!\.tipo !== "SKIP"\)/.test(c) || !/if \(financeiroPendenteElegivel\(p, envio\) === null\) return \{ tipo: "SKIP", etapas: \[\] \};/.test(plano)) erros.push("coletor: pedido completo (ACTUAL) consultado de novo");
  // A3.2-C.1: SEM teto por quantidade — TODA venda do lote é tentada; a única proteção de tempo é o PRAZO, checado
  // antes de CADA chamada ao provider (inclusive retry); o que não coube é DEFERRED_BY_RUNTIME_BUDGET (não é erro da API)
  if (/orcamento\.pedidos|alvo\.slice\(0,|\bLIMITE_|ORCAMENTO_/.test(c) || !/if \(agoraMs\(\) >= ate\) return \{ status, corpo: null, classe: t === 0 \? DEFERIDO : "TRANSIENT_ERROR" \};/.test(c) || /Promise\.all\((?!Array\.from\(\{ length: Math\.min\(limite)/.test(c)) erros.push("coletor: teto por quantidade, prazo fora de cada chamada ou concorrência ilimitada");
  const iPayload = c.search(/if \(order && precisa\(id, "pedido"\)\) ob\.pedido = extrairPedidoFinanceiroML\(order, null\);/), iDesc = c.search(/const d = await getML\(`\/orders\/\$\{encodeURIComponent\(id\)\}\/discounts`\);/);
  if (!/if \(f\.classe === DEFERIDO\) \{/.test(c) || !/deferred_by_runtime_budget=\$\{r\.adiados\}/.test(c) || iPayload < 0 || iDesc < iPayload) erros.push("coletor: adiamento por prazo não distinguido de erro do provider, ou venda adiada sem registro pendente");
  if (!/const inicioSync = Date\.now\(\);/.test(sy) || !/\{ ate: inicioSync \+ JANELA_PROVIDER_MS \},/.test(sy)) erros.push("sync-ml: prazo do financeiro fora do início do sync");
  // TARGETED_RETRY_ON_REFRESH: GET só marca pendentes (banco); retry por rota própria, mesma loja, só pendentes
  const rg = tiraComentarios(ler(raiz, "app/api/ml/vendas/route.ts"));
  if (!/financeiroPendente: candidatosRecuperacaoFinanceiraML\(\(pedidos \?\? \[\]\)\.map\(/.test(rg) || !/\{ de: dateFrom, ate: dateTo, campo: dateField \}\)\.length,/.test(rg) || /coletarFinanceiroML|ml-financeiro-coleta/.test(rg)) erros.push("GET de Vendas: sem contagem de recuperação da janela ou com trabalho de provider na leitura");
  const rr = existsSync(join(raiz, ROTA_RETRY_FIN_ML)) ? tiraComentarios(ler(raiz, ROTA_RETRY_FIN_ML)) : "";
  if (!/\? await resolverContaML\(userId, lojaPedida\)\s*: await resolverContaML\(userId, null, \{ permitirUnica: true \}\);/.test(rr) || /lerCookie|loja_ativa_id/.test(rr)) erros.push(`${ROTA_RETRY_FIN_ML}: loja fora do contrato explícito (ou cookie)`);
  // A3.2-C.3 CARÊNCIA: só subrecurso financeiro (nunca "order"), só 404/200 incompleto, só venda < 5 min pelo relógio
  // do PROVIDER; transitório intocado; nenhuma espera artificial; resumo distingue PROVIDER_DATA_NOT_READY
  const car = corpoDaFuncao(m, "classeComCarenciaML") ?? "";
  if (!/if \(classe !== "INTEGRATION_ERROR"\) return classe;/.test(car) || !/if \(http !== 404 && http !== 200\) return classe;/.test(car) || !/if \(idadeMs === null \|\| idadeMs < -60_000 \|\| idadeMs >= CARENCIA_PROVIDER_ML_MS\) return classe;/.test(car)
    || !/export const CARENCIA_PROVIDER_ML_MS = 5 \* 60_000;/.test(m) || /ETAPAS_COM_CARENCIA_ML = \[[^\]]*"order"/.test(m) || !/const ref = order\?\.date_closed \?\? order\?\.date_created;/.test(m)) erros.push("carência: escopo fora do contrato (etapa order, HTTP além de 404/200, venda antiga ou relógio local)");
  if (/CARENCIA_PROVIDER_ML_MS|esperar\(\s*5\s*\*\s*60/.test(c) || !/classe: f\.classe === "INTEGRATION_ERROR" \? classeComCarenciaML\(f\.classe, f\.etapa, f\.http, idade\) : f\.classe/.test(c) || !/provider_data_not_ready=\$\{r\.naoProntos\}/.test(c)) erros.push("coletor: espera artificial pela carência, carência fora do registro único ou resumo sem PROVIDER_DATA_NOT_READY");
  // A3.2-C.2 HISTÓRICO: o SERVIDOR escolhe os candidatos (dono + loja + ML + pagas + janela; sem linha financeira OU
  // pendente) — o cliente nunca manda a lista de pedidos; mais recentes primeiro; só o prazo limita o trabalho
  if (/order_ids/.test(rr) || !/\.from\("pedidos"\)\s*\.select\("order_id, status, data, data_pagamento, data_criacao"\)\s*\.eq\("user_id", userId\)\.eq\("marketplace", "ML"\)\.eq\("loja_id", lojaId\)\.eq\("status", "paid"\)/.test(rr)
    || !/const existentes = await lerFinanceiroRealML\(supabase\(\), userId, lojaId,/.test(rr) || !/const alvo = candidatosRecuperacaoFinanceiraML\(vendas, existentes, \{ de, ate, campo \}\);/.test(rr)
    || !/\}, \{ ate: inicio \+ JANELA_PROVIDER_MS \}\)/.test(rr) || /LIMITE_|MAX_IDS|\.slice\(0,/.test(rr) || !/coletarFinanceiroML\(\{ userId, lojaId, accessToken: contaML\.accessToken \}, alvo,/.test(rr)) erros.push(`${ROTA_RETRY_FIN_ML}: recuperação sem seleção no servidor (dono + loja + janela), com lista do cliente, teto ou sem prazo`);
  const cand = corpoDaFuncao(m, "candidatosRecuperacaoFinanceiraML") ?? "";
  if (!/if \(v\.status !== "paid"\) continue;/.test(cand) || !/return !f \|\| financeiroPendenteElegivel\(f\.pedido, f\.envio\) !== null;/.test(cand) || !/\.sort\(\(a, b\) => \(a\[1\] < b\[1\] \? 1 :/.test(cand)) erros.push("recuperação: venda sem linha financeira não elegível, não-paga elegível ou ordem não é mais-recentes-primeiro");
  const elg = corpoDaFuncao(m, "financeiroPendenteElegivel") ?? "";
  // A3.2-D: DIVERGENTE só entra pela reavaliação ÚNICA de versão antiga (a versão atual nunca é reconsultada em loop)
  const elgSemVersao = elg.replace(/if \(p\.billing_status === "DIVERGENTE" && \(p\.fonte_versao \?\? FONTE_VERSAO_ML_FINANCEIRO\) < FONTE_VERSAO_ML_FINANCEIRO\) return "versao";/, "");
  if (/"CONFERIDO"|SEM_PERMISSAO|DIVERGENTE/.test(elgSemVersao) || !/if \(p\.billing_status === "PENDENTE"\) return "billing";/.test(elg) || elgSemVersao === elg) erros.push("elegibilidade do retry inclui pedido completo, erro de integração ou DIVERGENTE da versão atual (loop de consulta)");
  // A3.2-D BILLING: sale_fee.net do provider é a fonte; fallback só CVV* (nunca CFFE/frete); ±1 centavo
  const cb = corpoDaFuncao(m, "conferirBillingML") ?? "";
  if (!/let total: number \| null = num\(doPedido\?\.sale_fee\?\.net\);/.test(cb) || !/if \(total === null\) \{/.test(cb) || !/sub\.startsWith\("CVV"\)/.test(cb) || /CFFE|CVVML|CVVPRC|CVVFNU/.test(cb.replace(/\/\/.*$/gm, "")) || !/Math\.abs\(total - tarifa\) <= 0\.01/.test(cb)) erros.push("billing: fonte fora de sale_fee.net, fallback fora de CVV*, allowlist fechada ou tolerância alterada");
  // A3.2-D DESCONTOS: discount_not_found = sem desconto (exato); desconto_meli = só rebate da tarifa (funding sale_fee)
  if (!/const semDesconto = d\.status === 404 && d\.corpo\?\.error === "discount_not_found";/.test(c) || !/if \(d\.classe !== "OK" && !semDesconto\) registrar\(/.test(c)) erros.push("descontos: 404 sem o código discount_not_found tratado como sem desconto (ou o código virou erro)");
  const dsc = corpoDaFuncao(m, "extrairDescontosML") ?? "";
  if (!/if \(d\?\.supplier\?\.funding_mode === "sale_fee"\) meli \+= total - seller;/.test(dsc) || !/const desc = extrairDescontosML\(descontos\);/.test(ped)) erros.push("descontos: desconto_meli soma cupom/benefício além do rebate da tarifa");
  // A3.2-E STAGE-AWARE + MONOTÔNICO (fix forward 182af4e): plano por pedido, fila P0..P3, micro-lote com o billing DO
  // lote (sem cauda global), gravação só por merge com a linha existente, qualidade do estado final, leitura estrita
  const loop = /for \(let i = 0; i < fila\.length; i \+= MICRO_LOTE_ML\) \{\s*const lote = fila\.slice\(i, i \+ MICRO_LOTE_ML\);\s*r\.lotes\+\+;\s*await emParalelo\(lote, CONCORRENCIA_ML, etapasDoPedido\);\s*await billingDoLote\(lote\);\s*await mesclarLote\(lote\);\s*if \(agoraMs\(\) < ate\) await gravar\(\);\s*\}/;
  const bl = corpoDaFuncao(c, "billingDoLote") ?? "";
  if (!loop.test(c) || (c.match(/\/billing\/integration\//g) ?? []).length !== 1 || !/\/billing\/integration\//.test(bl) || !/export const MICRO_LOTE_ML = LOTE_BILLING_ML;/.test(c) || !/export const LOTE_BILLING_ML = 20;/.test(c)
    || !/const alvoB = lote\.filter\(\(id\) => precisa\(id, "billing"\)/.test(bl)) erros.push("coletor: billing fora do micro-lote (cauda global), micro-lote ≠ lote do billing ou billing de pedido sem a etapa no plano");
  if ((c.match(/deps\.gravarPedidos\(/g) ?? []).length !== 1 || (c.match(/deps\.gravarEnvios\(/g) ?? []).length !== 1 || !/const m = mesclarPedidoFinanceiroML\(ex, obtidos\.get\(id\) \?\? \{\}\);/.test(c)
    || !/if \(!ex \|\| !iguais\(ex, m, CAMPOS_PEDIDO\)\) paraGravar\.pedidos\.push\(\{ \.\.\.m, \.\.\.base, /.test(c) || !/return mesclarEnvioFinanceiroML\(noBanco, envio\);/.test(c)) erros.push("coletor: gravação de linha inteira sem merge com a existente (NULL/PENDENTE sobrescreve valor confirmado)");
  // A3.2-F DISJUNTOR: lote de billing que esgotou as tentativas com 429 abre o disjuntor; com ele aberto nenhum billing
  // novo é chamado (o próximo lote não é "testado"); 429 nunca vira erro de integração
  const iPula = bl.search(/if \(billingLimitado\) \{ r\.limitados \+= alvoB\.length; return; \}/), iCall = bl.search(/const b = await getML\(`\/billing\/integration\//);
  if (iPula < 0 || iCall < iPula || !/if \(b\.classe === "TRANSIENT_ERROR" && b\.status === 429\) \{\s*billingLimitado = true;/.test(bl)) erros.push("billing: sem disjuntor de 429 por execução (lotes seguidos batendo 429 até o prazo)");
  // A3.2-F BILLING 200 VAZIO: resposta válida sem cobrança do pedido = PROVIDER_DATA_NOT_READY em QUALQUER idade;
  // resposta sem `results` = erro de integração
  if (!/else if \(conf0\.billing_status === "PENDENTE"\) registrar\(\{ \.\.\.ctx, etapa: "billing", classe: "PROVIDER_DATA_NOT_READY", http: 200 \}\);/.test(bl) || !/const estruturaInvalida = b\.classe === "OK" && !Array\.isArray\(b\.corpo\?\.results\);/.test(bl)) erros.push("billing: 200 sem cobrança tratado como erro de integração (o ML lança o billing depois de 5 min) ou estrutura inválida aceita");
  // A3.2-F LOGS: linha por pedido só como AMOSTRA (constante pequena); resumo SEMPRE, uma vez, no finally do wrapper
  const wrap = corpoDaFuncao(c, "coletarFinanceiroML") ?? "";
  const logsPorPedido = c.match(/log\(`\[ml-financeiro\] \$\{(g\.classe|DEFERIDO)\}/g) ?? [];
  if (!/export const AMOSTRAS_LOG_ML = 5;/.test(c) || logsPorPedido.length !== 2 || (c.match(/if \(amostra\((g\.classe|DEFERIDO)\)\) log\(`\[ml-financeiro\] \$\{(g\.classe|DEFERIDO)\}/g) ?? []).length !== 2
    || !/\} finally \{[\s\S]*log\(`\[ml-financeiro\] resumo /.test(wrap) || (c.match(/\[ml-financeiro\] resumo /g) ?? []).length !== 1) erros.push("coletor: log por pedido sem amostragem (O(n) linhas) ou resumo que pode não sair");
  // A3.3 VOLUME ML (auditado): datas = dia BRT do INSTANTE (o ML manda −04:00 — truncar a string é proibido); pagamento só
  // de estados com aprovação comprovada (approved, partially_refunded, in_mediation); cancelamento no buffer atualiza a
  // linha (status não congela); pack_splitted fora das vendas brutas; vendas brutas SEMPRE por criação no GET
  const vm = existsSync(join(raiz, "lib/vendas/metricas-ml.ts")) ? tiraComentarios(ler(raiz, "lib/vendas/metricas-ml.ts")) : "";
  if (!/export const STATUS_PAGAMENTO_APROVADO_ML = \["approved", "partially_refunded", "in_mediation"\] as const;/.test(vm)
    || !/return Number\.isFinite\(t\) \? new Date\(t - BRT_MS\)\.toISOString\(\)\.slice\(0, 10\) : null;/.test(vm)
    || !/if \(cd\?\.code === "pack_splitted"\) return "pack_dividido";/.test(vm)
    || !/export const STATUS_VENDA_BRUTA_ML: readonly StatusPedidoML\[\] = \["paid", "cancelled", "devolucao", "cancelado_interno"\];/.test(vm)
    || !/export const STATUS_CANCELADA_ML: readonly StatusPedidoML\[\] = \["cancelled", "devolucao"\];/.test(vm)) erros.push("volume ML: data fora do dia BRT, pagamento de estado não comprovado, pack_splitted como venda ou canceladas fora do painel");
  if (/date_created[^\n]*split\("T"\)|date_approved[^\n]*split\("T"\)|getTime\(\) - 3 \* 60 \* 60 \* 1000/.test(sy) || !/const dataCriacaoML = dataBRT\(order\.date_created\);/.test(sy)
    || !/const dataPagamentoML = dataBRT\(pagamentoAprovadoML\(order\.payments\)\?\.date_approved\);/.test(sy) || !/o\._status = statusPedidoML\(o\._rawStatus, o\);/.test(sy)
    || !/if \(\(dataPedido < dateFrom \|\| dataPedido > dateTo\) && !cancelado\) continue;/.test(sy)
    || !/export const ML_STATUS_RECHECK_WINDOW_HOURS = 168;/.test(sy) || !/const dateFetchFrom = noBuffer \? dateFrom : addDias\(dateFrom, -ML_STATUS_RECHECK_WINDOW_HOURS \/ 24\);/.test(sy)) erros.push("sync-ml: janela de rechecagem ≠ 168 h, data truncada da string do provider, pagamento fora do critério comprovado ou cancelamento do buffer descartado (status congelado)");
  if (!/let linhasCriacao: any\[\] = dateField === "criacao" \? pedidos : \[\];/.test(rg) || !/buildPedidosQuery\("order_id, status, qtd, faturamento", undefined, "criacao"\)/.test(rg) || !/metricasML = \{ base: "criacao", \.\.\.metricasBrutasML\(linhasCriacao\) \};/.test(rg)) erros.push("GET de Vendas: vendas brutas ML fora da data de criação");
  const mp = corpoDaFuncao(m, "mesclarPedidoFinanceiroML") ?? "", me = corpoDaFuncao(m, "mesclarEnvioFinanceiroML") ?? "";
  if (!/if \(b && b\.billing_status !== "PENDENTE"\) \{/.test(mp) || !/\} else if \(b && base\.billing_status === "PENDENTE"\) \{\s*base\.billing_tarifa = b\.billing_tarifa \?\? base\.billing_tarifa;/.test(mp)
    || !/if \(obtido\.descontos\) \{/.test(mp) || /descontos_status = "INDISPONIVEL"/.test(mp) || !/if \(o\.tarifa_origem === "PROVIDER" && o\.tarifa_venda !== null\)/.test(mp)
    || !/frete_vendedor: obtido\.frete_vendedor \?\? existente\.frete_vendedor,/.test(me) || !/pedidos: obtido\.pedidos \?\? existente\.pedidos,/.test(me)) erros.push("merge: estado confirmado pode ser rebaixado (billing → PENDENTE, descontos → INDISPONIVEL, frete/tarifa → NULL)");
  const pr = corpoDaFuncao(m, "prioridadeRecuperacaoML") ?? "";
  if (!/if \(tipo === "BILLING_ONLY"\) return 0;/.test(pr) || !/if \(tipo === "FULL_PIPELINE"\) return 3;/.test(pr) || !/\.sort\(\(a, b\) => a\.p - b\.p \|\| a\.i - b\.i\)/.test(c)) erros.push("fila: billing-only sem prioridade sobre o histórico sem linha, ou ordem de recência perdida");
  if (!/for \(const \[id, p\] of finais\) \{\s*const envio = p\.shipment_id \? enviosBanco\.get\(p\.shipment_id\) \?\? existentes\.get\(id\)\?\.envio \?\? null : null;\s*if \(liquidoPedidoML\(p, envio\)\.qualidade === "ACTUAL"\)/.test(c)) erros.push("coletor: qualidade calculada só pelo resultado desta execução (não pelo estado final mesclado)");
  if (!/catch \{\s*log\(`\[ml-financeiro\] ERRO leitura do financeiro existente loja=\$\{conta\.lojaId\}[^`]*`\);\s*return;\s*\}/.test(c) || !/lerFinanceiroRealML\(supabase\(\), userId, lojaId, ids, \{ estrito: true \}\)/.test(sy) || !/\{ estrito: true \}\)\.catch\(\(\) => null\);\s*if \(!existentes\) return NextResponse\.json\(\{ ok: false, tentados: 0 \}\);/.test(rr)) erros.push("coletor: leitura do estado existente falha em silêncio (mapa vazio → regravação por cima)");
  if (!/export const FONTE_VERSAO_ML_FINANCEIRO = 2;/.test(m)) erros.push("versão da lógica financeira não avançou com a correção de billing/descontos");
  // uma rodada automática por carga da página (sem loop)
  const pgr = tiraComentarios(ler(raiz, PAGINA_VENDAS));
  const fl = tiraComentarios(ler(raiz, "app/(app)/vendas/financeiro-live.ts"));
  const decide = corpoDaFuncao(fl, "deveRecuperarFinanceiroML") ?? "";
  // A3.2-F: carga que já sincronizou (o sync tentou o financeiro) NÃO dispara a recuperação — uma fonte por carga
  if (!/return !r\.falhou && !r\.rodadaUsada && r\.financeiroTentadoNoSync !== true && typeof r\.financeiroPendente === "number" && r\.financeiroPendente > 0;/.test(decide)
    || !/if \(!falhou && data\.financeiroTentadoNoSync === true\) retryFinanceiroRef\.current = true;/.test(pgr)
    || !/financeiroTentadoNoSync = !!lojaML;/.test(rg) || (rg.match(/financeiroTentadoNoSync = !!lojaML;/g) ?? []).length !== (rg.match(/await \(lojaML && syncMLForUser\(/g) ?? []).length) erros.push("tela: recuperação financeira disparada na mesma carga de um sync que já tentou o financeiro (rajada de billing)");
  if (!/if \(deveRecuperarFinanceiroML\(\{ falhou, rodadaUsada: retryFinanceiroRef\.current, financeiroPendente: data\?\.financeiroPendente, financeiroTentadoNoSync: data\?\.financeiroTentadoNoSync \}\)\) \{\s*retryFinanceiroRef\.current = true;/.test(pgr) || /retryFinanceiroRef\.current = false/.test(pgr) || /order_ids/.test(pgr) || (pgr.match(/\/api\/ml\/vendas\/financeiro/g) ?? []).length !== 1) erros.push("tela: recuperação sem trava de uma rodada por carga (loop), com lista de pedidos ou fora do ponto único");
  // leitor: dono + loja
  const l = tiraComentarios(ler(raiz, LEITOR_FIN_ML));
  if ((l.match(/\.eq\("user_id", userId\)\.eq\("loja_id", lojaId\)\.in\(/g) ?? []).length !== 2 || /fetch\(|mercadoli/.test(l)) erros.push("leitor: financeiro sem dono + loja, ou chama provider");
  // código da venda
  const cv = tiraComentarios(ler(raiz, "app/(app)/vendas/codigos-venda.ts"));
  if (!/return \(r\.marketplace === "ML" \? limpo\(r\.packId\) : null\) \?\? limpo\(r\.orderId\);/.test(cv)) erros.push("código da venda ML fora de pack_id ?? order_id");
  // migration
  const sql = ler(raiz, MIGRACAO_FIN_ML).replace(/--[^\n]*/g, "").toLowerCase().replace(/\s+/g, " ");
  if (!/primary key \(loja_id, order_id\)/.test(sql) || !/primary key \(loja_id, shipment_id\)/.test(sql)) erros.push("migration: grão pedido/envio fora de (loja, order) / (loja, shipment)");
  if ((sql.match(/foreign key \(loja_id, user_id\) references public\.lojas \(id, user_id\)/g) ?? []).length !== 2) erros.push("migration: tabela sem FK de dono da loja");
  // fechamento das tabelas (privilégios revogados + RLS sem policy): provado linha a linha pelas suítes SEC-3
  // (sec3-b1 K2 / sec3-b2 M2, linhas exatas) e por testar-vendas-ml-financeiro FIN2-16 — fora deste guard,
  // que é varrido pelo scan de mudança de banco.
  if (/\b(update|delete|insert|truncate)\s/.test(sql.replace(/'[^']*'/g, "''")) || /\bdrop\b|set not null|concurrently/.test(sql)) erros.push("migration: escrita de dados, DROP, NOT NULL ou CONCURRENTLY");
  if (!/alter table public\.pedidos add column tarifa_origem text null;/.test(sql)) erros.push("migration: proveniência da tarifa ausente/obrigatória");
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
  for (const v of observacaoMisturadaComAtivo(raiz)) erros.push(`I9 I9_MARKETPLACE_OBSERVATION_IS_SEPARATE_FROM_ATIVO: ${v}`);
  for (const v of refreshDeIdentidadesForaDaLoja(raiz)) erros.push(`I10 I10_KNOWN_ID_REFRESH_IS_STORE_SCOPED: ${v}`);
  for (const v of observacaoNaUiNaoSoLeitura(raiz)) erros.push(`I11 I11_MARKETPLACE_STATUS_UI_IS_READ_ONLY: ${v}`);
  for (const v of vendasSemEscopoDeLoja(raiz)) erros.push(`I12 I12_SALES_STORE_SCOPE_IS_EXPLICIT: ${v}`);
  for (const v of custoDeVendaForaDeMeusProdutos(raiz)) erros.push(`I13 I13_SALES_COST_COMES_FROM_MEUS_PRODUTOS: ${v}`);
  for (const v of identidadeVendaMLNaoExata(raiz)) erros.push(`I14 I14_ML_SALE_ITEM_IDENTITY_IS_EXACT: ${v}`);
  for (const v of identidadeVendaMLNaoNoBanco(raiz)) erros.push(`I15 I15_ML_SALE_IDENTITY_IS_DB_UNIQUE: ${v}`);
  for (const v of lojaMLVendasNaoExplicita(raiz)) erros.push(`I16 I16_ML_VENDAS_STORE_IS_EXPLICIT: ${v}`);
  for (const v of financeiroMLNaoReal(raiz)) erros.push(`I17 I17_ML_FINANCIAL_RECONCILIATION_IS_REAL: ${v}`);
  if (opcoes.zonas !== false) for (const v of verificarZonas(raiz)) erros.push(`Z zona protegida sem re-baseline: ${v}`);
  return erros;
}
