/**
 * Suite do cursor de cobertura do sync Shopee — SHOPEE-SYNC-TIMEOUT1a.
 *
 * Prova a invariante:
 *
 *   "O cursor representa ate que instante uma execucao COMPLETA cobriu —
 *    nunca o que ela por acaso encontrou, e nunca menos do que ja valia."
 *
 * ── Instrumentos ────────────────────────────────────────────────────
 * Sem rede, sem banco, sem IA. Tres, deliberadamente distintos:
 *
 *  1. FUNCOES PURAS de `lib/sync-shopee-janela.ts`, chamadas direto. O
 *     modulo nao importa nada — nem `server-only` — entao a suite o
 *     exercita sem shim e sem env. E o que torna as mutacoes A, B e D
 *     detectaveis por comportamento, e nao por leitura de fonte.
 *  2. EXECUTOR EM MEMORIA que reproduz o `WHERE` do compare-and-swap,
 *     no mesmo espirito do executor de `testar-credenciais-marketplace`.
 *     E onde a concorrencia e simulada.
 *  3. INSPECAO DE FONTE, padrao ja usado no projeto, para travar o que
 *     nao se observa por chamada: que a condicao monotonica esta na
 *     INSTRUCAO e nao em JavaScript, e que os chamadores reais nao
 *     ativaram incremental.
 *
 * LIMITE DECLARADO: o round-trip real contra o PostgREST nao e exercido
 * aqui — exigiria banco, e a hierarquia da §19 poe banco depois dos
 * testes puros. O que se prova e o CONTRATO. A equivalencia entre a
 * regra pura (`deveAvancarCursor`) e o filtro enviado ao banco e
 * assertada explicitamente (testes 30-33), justamente porque sao duas
 * expressoes da mesma regra e poderiam divergir em silencio.
 */
import { readFileSync } from "fs";
import { join } from "path";

import {
  SHOPEE_SYNC_OVERLAP_MS,
  MAX_SEGUNDOS_POR_CHUNK,
  paraEpochSegundos,
  calcularJanelaIncremental,
  fatiarJanelaEmChunks,
  deveAvancarCursor,
  syncCobriuJanelaCompletamente,
} from "../lib/sync-shopee-janela";

const RAIZ = join(__dirname, "..");
const fonte = (rel: string) => readFileSync(join(RAIZ, rel), "utf8");

/**
 * Fonte SEM comentarios. Asserção de AUSENCIA precisa disto: este
 * projeto documenta fartamente o que decidiu NAO fazer, e uma busca
 * ingenua por `incremental` ou `synced_at` casaria com a explicacao de
 * por que eles nao estao la — passando ou falhando pelo motivo errado.
 */
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

const MIGRATION = "supabase/migrations/20260910_shopee_sync_cursor.sql";
const CAPABILITY = "lib/marketplace/credenciais.ts";
const JANELA = "lib/sync-shopee-janela.ts";
const SYNC = "lib/sync-shopee.ts";

const iso = (s: string) => new Date(s).toISOString();
const T14 = iso("2026-08-24T14:00:00Z");
const T15 = iso("2026-08-24T15:00:00Z");
const T1505 = iso("2026-08-24T15:05:00Z");

// ══════════════════════════════════════════════════════════════════════
// 1-6 — MIGRATION
// ══════════════════════════════════════════════════════════════════════
{
  const sql = fonte(MIGRATION);
  const statements = sql
    .replace(/--.*$/gm, "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

  ok("1. migration tem exatamente UM statement executavel", statements.length === 1);
  ok(
    "2. o statement e ADD COLUMN IF NOT EXISTS na tabela lojas",
    /^ALTER TABLE public\.lojas\s+ADD COLUMN IF NOT EXISTS shopee_sincronizado_ate timestamptz$/i.test(
      statements[0]?.replace(/\s+/g, " ") ?? ""
    )
  );
  ok("3. tipo e timestamptz", /shopee_sincronizado_ate\s+timestamptz/i.test(statements[0] ?? ""));
  ok("4. sem NOT NULL — NULL e o sinal de bootstrap", !/NOT NULL/i.test(statements[0] ?? ""));
  ok("5. sem DEFAULT — default faria toda loja mentir cobertura", !/DEFAULT/i.test(statements[0] ?? ""));
  ok(
    "6. sem index/constraint/grant/revoke/policy/function",
    !/(CREATE INDEX|ADD CONSTRAINT|GRANT |REVOKE |POLICY|CREATE (OR REPLACE )?FUNCTION|ALTER DEFAULT)/i.test(
      sql.replace(/--.*$/gm, "")
    )
  );
  ok(
    "6b. rollback existe, mas apenas comentado",
    /--\s*ALTER TABLE public\.lojas/i.test(sql) && !/^\s*ALTER TABLE[\s\S]*DROP COLUMN/im.test(sql.replace(/--.*$/gm, ""))
  );
}

// ══════════════════════════════════════════════════════════════════════
// 7-12 — CAPABILITY: leitura e tenant
// ══════════════════════════════════════════════════════════════════════
{
  const src = codigo(CAPABILITY);

  ok("7. lerCursorSyncShopee existe e e exportada", /export async function lerCursorSyncShopee/.test(src));
  ok("8. avancarCursorSyncShopee existe e e exportada", /export async function avancarCursorSyncShopee/.test(src));

  const corpoLer = src.slice(src.indexOf("export async function lerCursorSyncShopee"));
  const corpoLerFim = corpoLer.slice(0, corpoLer.indexOf("export async function avancarCursorSyncShopee"));

  ok("9. leitura e tenant-aware (usa o par id+user_id)", /filtrosGravacaoPorLojaEDono\(lojaId, userId\)/.test(corpoLerFim));
  ok("10. leitura filtra marketplace Shopee", /marketplace: MARKETPLACE_SHOPEE/.test(corpoLerFim));
  ok(
    "11. leitura projeta SO a coluna do cursor, nunca `*`",
    /\.select\(COLUNA_CURSOR_SHOPEE\)/.test(corpoLerFim) && !/\.select\("\*"\)/.test(corpoLerFim)
  );
  ok(
    "12. erro de leitura nao vaza texto do Postgres nem identificadores",
    /return \{ cursor: null, erro: "erro_leitura_cursor_shopee" \}/.test(corpoLerFim) &&
      !/error\.message/.test(corpoLerFim) &&
      !/console\.error\([^)]*lojaId/.test(corpoLerFim)
  );
}

// ══════════════════════════════════════════════════════════════════════
// 13-18 — CAPABILITY: o compare-and-swap esta na INSTRUCAO
// ══════════════════════════════════════════════════════════════════════
{
  const src = codigo(CAPABILITY);
  const corpo = src.slice(src.indexOf("export async function avancarCursorSyncShopee"));

  // MUTACAO C: trocar o `.or(...)` por um UPDATE simples faz 13 e 14
  // reprovarem. E a unica forma de detectar isso sem banco — a condicao
  // e avaliada pelo Postgres, nao por codigo que a suite possa chamar.
  ok(
    "13. avanco usa .or() com IS NULL + menor-que (compare-and-swap)",
    /\.or\(`\$\{COLUNA_CURSOR_SHOPEE\}\.is\.null,\$\{COLUNA_CURSOR_SHOPEE\}\.lt\.\$\{alvo\}`\)/.test(corpo)
  );
  ok(
    "14. NAO existe SELECT-comparar-UPDATE (TOCTOU) no avanco",
    !/lerCursorSyncShopee/.test(corpo) && !/deveAvancarCursor/.test(corpo)
  );
  ok("15. avanco e tenant-aware", /filtrosGravacaoPorLojaEDono\(lojaId, userId\)/.test(corpo));
  ok("16. avanco filtra marketplace Shopee", /marketplace: MARKETPLACE_SHOPEE/.test(corpo));
  ok(
    "17. zero linhas afetadas NAO e erro",
    /avancou: Array\.isArray\(data\) && data\.length > 0/.test(corpo) && /erro: null/.test(corpo)
  );
  ok(
    "18. alvo usa toISOString (sufixo Z: sem virgula e sem + no filtro or)",
    /coberturaAte\.toISOString\(\)/.test(corpo) && iso(T15).endsWith("Z")
  );
}

// ══════════════════════════════════════════════════════════════════════
// 19-23 — OVERLAP
// ══════════════════════════════════════════════════════════════════════
{
  ok("19. overlap e exatamente 15 minutos", SHOPEE_SYNC_OVERLAP_MS === 15 * 60 * 1000);

  const coberturaAte = new Date("2026-08-24T17:00:00Z");
  const j = calcularJanelaIncremental(iso("2026-08-24T16:00:00Z"), coberturaAte)!;

  // MUTACAO B: zerar o overlap faz 20 e 21 reprovarem.
  ok("20. time_from recua o overlap a partir do cursor", j.de === paraEpochSegundos(new Date("2026-08-24T15:45:00Z")));
  ok("21. time_from e ANTERIOR ao cursor (overlap nao foi removido)", j.de < paraEpochSegundos(new Date("2026-08-24T16:00:00Z")));
  ok("22. time_to e exatamente coberturaAte", j.ate === paraEpochSegundos(coberturaAte));

  // Pedido na BORDA: mudou 10 min antes do cursor anterior. Sem overlap
  // seria perdido; com overlap de 15 min, entra na janela.
  const borda = paraEpochSegundos(new Date("2026-08-24T15:52:00Z"));
  ok("23. pedido na borda do overlap NAO e perdido", borda >= j.de && borda <= j.ate);
}

// ══════════════════════════════════════════════════════════════════════
// 24-29 — JANELA: bootstrap, teto congelado, fail-closed
// ══════════════════════════════════════════════════════════════════════
{
  const agora = new Date("2026-08-24T17:00:00Z");

  ok("24. cursor null -> null (chamador cai no bootstrap)", calcularJanelaIncremental(null, agora) === null);
  ok("25. cursor undefined -> null", calcularJanelaIncremental(undefined, agora) === null);
  ok("26. cursor ilegivel -> null (fail-closed, nao vira epoch 0)", calcularJanelaIncremental("nao-e-data", agora) === null);
  ok(
    "27. cursor no futuro -> null (nunca pede time_from > time_to)",
    calcularJanelaIncremental(iso("2026-08-25T00:00:00Z"), agora) === null
  );

  // Teto congelado: duas chamadas com o MESMO coberturaAte dao o mesmo
  // time_to, ainda que o relogio real tenha andado entre elas.
  const a = calcularJanelaIncremental(T14, agora)!;
  const b = calcularJanelaIncremental(T14, agora)!;
  ok("28. time_to e congelado (mesmo instante -> mesma janela)", a.ate === b.ate && a.de === b.de);

  // Update que ocorre DEPOIS de coberturaAte fica para a proxima rodada.
  const depois = paraEpochSegundos(new Date("2026-08-24T17:00:30Z"));
  ok("29. update posterior a coberturaAte fica fora desta janela", depois > a.ate);
}

// ══════════════════════════════════════════════════════════════════════
// 30-37 — MONOTONICIDADE + CONCORRENCIA (executor em memoria)
// ══════════════════════════════════════════════════════════════════════
{
  // Reproduz o WHERE do compare-and-swap:
  //   (col IS NULL OR col < alvo)
  // Escrito a partir da SEMANTICA SQL, nao chamando `deveAvancarCursor`
  // — se chamasse, os testes 30-33 seriam tautologia.
  let linha: { shopee_sincronizado_ate: string | null } = { shopee_sincronizado_ate: null };
  function updateCas(alvo: string): boolean {
    const atual = linha.shopee_sincronizado_ate;
    const passa = atual === null || new Date(atual).getTime() < new Date(alvo).getTime();
    if (passa) linha = { shopee_sincronizado_ate: alvo };
    return passa;
  }

  // A regra pura e o WHERE precisam concordar — sao duas expressoes da
  // mesma decisao e poderiam divergir em silencio.
  linha = { shopee_sincronizado_ate: null };
  ok("30. NULL avanca — pura e SQL concordam", updateCas(T14) === true && deveAvancarCursor(null, T14) === true);
  ok("31. avanco normal para instante maior", updateCas(T15) === true && deveAvancarCursor(T14, T15) === true);
  ok("32. instante IGUAL nao avanca (e nao e erro)", updateCas(T15) === false && deveAvancarCursor(T15, T15) === false);
  ok("33. instante MENOR nao avanca", updateCas(T14) === false && deveAvancarCursor(T15, T14) === false);
  ok("34. o cursor ficou no maior valor, nao no ultimo escrito", linha.shopee_sincronizado_ate === T15);

  // MUTACAO C: com UPDATE simples, `linha` terminaria em T15 (o ultimo a
  // escrever), regredindo o cursor. Com CAS, termina em T1505.
  linha = { shopee_sincronizado_ate: T14 };
  const bTerminouPrimeiro = updateCas(T1505); // execucao B, cobriu ate 15:05
  const aTerminouDepois = updateCas(T15); // execucao A, cobriu ate 15:00
  ok("35. concorrentes fora de ordem: B avanca", bTerminouPrimeiro === true);
  ok("36. concorrentes fora de ordem: A NAO regride", aTerminouDepois === false);
  ok("37. cursor final e o MAIOR, nunca o ultimo", linha.shopee_sincronizado_ate === T1505);

  ok("37b. cursor atual ilegivel -> fail-closed", deveAvancarCursor("lixo", T15) === false);
  ok("37c. coberturaAte ilegivel -> fail-closed", deveAvancarCursor(T14, "lixo") === false);
}

// ══════════════════════════════════════════════════════════════════════
// 38-45 — COMPLETUDE: o que autoriza o cursor a avancar
// ══════════════════════════════════════════════════════════════════════
{
  // MUTACAO D (usar MAX(pedidos.synced_at)) morre aqui: com zero pedidos
  // nao ha `synced_at` nenhum, e mesmo assim o cursor DEVE avancar.
  ok(
    "38. ZERO pedidos + sync completo -> cobertura completa",
    syncCobriuJanelaCompletamente({ upsertErrors: 0 }) === true
  );
  ok(
    "39. resumo pendente NAO bloqueia (resumo e derivado, nao cobertura)",
    syncCobriuJanelaCompletamente({ upsertErrors: 0, syncIncompleto: false } as any) === true
  );

  // MUTACAO A (avancar antes de terminar) morre aqui.
  ok("40. syncIncompleto -> NAO cobriu", syncCobriuJanelaCompletamente({ syncIncompleto: true }) === false);
  ok("41. upsertErrors > 0 -> NAO cobriu", syncCobriuJanelaCompletamente({ upsertErrors: 1 }) === false);
  ok("42. statusIncompleto -> NAO cobriu", syncCobriuJanelaCompletamente({ statusIncompleto: true }) === false);
  ok("43. resultado nulo -> NAO cobriu", syncCobriuJanelaCompletamente(null) === false);
  ok("44. resultado undefined -> NAO cobriu", syncCobriuJanelaCompletamente(undefined) === false);
  ok(
    "45. sync completo com pedidos -> cobriu",
    syncCobriuJanelaCompletamente({ found: 10, inserted: 10, upsertErrors: 0 } as any) === true
  );
}

// ══════════════════════════════════════════════════════════════════════
// 46-52 — BACKLOG: chunks cobrem TUDO, sem truncar
// ══════════════════════════════════════════════════════════════════════
{
  const agora = new Date("2026-08-24T17:00:00Z");

  // Caso normal: 1h15 de janela -> um unico chunk.
  const curto = fatiarJanelaEmChunks(calcularJanelaIncremental(iso("2026-08-24T16:00:00Z"), agora)!);
  ok("46. janela curta gera exatamente 1 chunk", curto.length === 1);

  // Backlog de 20 dias — o caso que o roteiro exigiu.
  const janela20 = calcularJanelaIncremental(iso("2026-08-04T17:00:00Z"), agora)!;
  const chunks20 = fatiarJanelaEmChunks(janela20);

  ok("47. backlog de 20 dias gera mais de um chunk", chunks20.length === 2);
  ok("48. o primeiro chunk comeca no INICIO da janela (nada foi truncado)", chunks20[0].de === janela20.de);
  ok("49. o ultimo chunk termina em coberturaAte", chunks20[chunks20.length - 1].ate === janela20.ate);
  ok(
    "50. nenhum chunk excede o limite da API",
    chunks20.every((c) => c.ate - c.de <= MAX_SEGUNDOS_POR_CHUNK)
  );
  ok(
    "51. chunks sao contiguos — nenhum segundo fica descoberto",
    chunks20.every((c, i) => i === 0 || c.de === chunks20[i - 1].ate + 1)
  );
  // A trava contra a versao errada do blueprint (teto em agora-14d).
  const diasCobertos = (janela20.ate - chunks20[0].de) / 86400;
  ok("52. os 20 dias inteiros sao cobertos, nao so os ultimos 14", diasCobertos > 19.9);
}

// ══════════════════════════════════════════════════════════════════════
// 53-62 — CHAMADORES: producao continua em modo intervalo
// ══════════════════════════════════════════════════════════════════════
{
  const src = codigo(SYNC);

  ok("53. o default do modo e intervalo", /\(opcoes\?\.modo \?\? "intervalo"\) === "intervalo"/.test(src));
  ok(
    "54. modo intervalo delega sem tocar cursor",
    /=== "intervalo"\) \{\s*return executarSyncShopee\(userId, dateFrom, dateTo, noBuffer, lojaOverride\);/.test(
      src.replace(/\s+/g, " ").replace(/ \{ /g, " { ")
    ) || /return executarSyncShopee\(userId, dateFrom, dateTo, noBuffer, lojaOverride\);/.test(src)
  );
  ok("55. o motor nao le cursor (quem decide cobertura e o chamador)", !/executarSyncShopee[\s\S]*lerCursorSyncShopee/.test(src.slice(src.indexOf("async function executarSyncShopee"))));
  ok(
    "56. o avanco so ocorre sob syncCobriuJanelaCompletamente",
    /if \(syncCobriuJanelaCompletamente\(resultado\)\) \{[\s\S]{0,200}avancarCursorSyncShopee/.test(src)
  );
  ok(
    "57. nenhum uso de MAX(synced_at) como cursor",
    !/max\s*\(\s*synced_at/i.test(src) && !/synced_at[\s\S]{0,40}cursor/i.test(src)
  );

  // Os tres chamadores reais. Nenhum pode ter ganhado `modo`.
  const chamadores = [
    ["app/api/sync/route.ts", "cron"],
    ["app/api/shopee/vendas/route.ts", "GET"],
    ["app/api/internal/sync/executar/route.ts", "worker/manual"],
  ] as const;

  let n = 58;
  for (const [arquivo, papel] of chamadores) {
    const c = codigo(arquivo);
    ok(
      `${n}. ${papel} (${arquivo}) NAO ativa incremental`,
      !/modo:\s*["']incremental["']/.test(c)
    );
    n++;
  }

  ok(
    "61. nenhum arquivo de producao passa modo incremental",
    !/modo:\s*["']incremental["']/.test(codigo(SYNC)) &&
      !/modo:\s*["']incremental["']/.test(codigo(CAPABILITY))
  );
  ok(
    "62. o wrapper legado syncShopeeForUser tambem nao passa opcoes",
    /syncShopeeForUserV2\(userId, dateFrom, dateTo, noBuffer, lojaOverride\);/.test(src)
  );
}

// ══════════════════════════════════════════════════════════════════════
// 63-66 — MODULO PURO e vazamento
// ══════════════════════════════════════════════════════════════════════
{
  const src = fonte(JANELA);
  ok("63. sync-shopee-janela nao importa nada (puro, testavel offline)", !/^\s*import\s/m.test(src));
  ok("64. o modulo nao toca supabase", !/supabase/i.test(codigo(JANELA)));

  const capSrc = codigo(CAPABILITY);
  const corpoCursor = capSrc.slice(capSrc.indexOf("const COLUNA_CURSOR_SHOPEE"));
  ok(
    "65. logs do cursor nao expoem token/credencial/segredo",
    !/(access_token|refresh_token|partner_key|partnerKey|token)/i.test(
      (corpoCursor.match(/console\.(error|log|warn)\([\s\S]*?\)/g) ?? []).join(" ")
    )
  );
  ok("66. o nome da coluna vive num lugar so", (capSrc.match(/"shopee_sincronizado_ate"/g) ?? []).length === 1);
}

console.log(`\n${falhou === 0 ? "✓" : "✗"} cursor de sync Shopee — ${passou} passaram, ${falhou} falharam`);
process.exit(falhou === 0 ? 0 : 1);
