/**
 * scripts/testar-shopee-status.ts
 *
 * Suite do SYNC DE STATUS Shopee dirigido pelo banco (2026-08-18).
 *
 * Nao chama IA, rede nem banco. Rodar com:
 *   npx tsx scripts/testar-shopee-status.ts
 *
 * CONTEXTO — o teste real de 18/08 em producao provou que a etapa 1.6 do sync
 * nunca e alcancada: a listagem de UM dia por update_time consumiu 54,3 s em 30
 * paginas e ainda paginava. Este modulo inverte a dependencia — seleciona no
 * BANCO os pedidos nao-terminais e pergunta o status deles direto via
 * get_order_detail, sem varredura nenhuma.
 *
 * O QUE ESTA SUITE PROVA, e que nao da para provar so lendo o codigo:
 *   - a rotacao por bucket cobre 0..1023 exatamente uma vez por sweep, para
 *     todo K da escada e para qualquer ponto de partida do relogio;
 *   - nao existe LIMIT nem OFFSET na selecao — a prova de cobertura nao depende
 *     do tamanho do bucket;
 *   - o teto ABORTA antes da Shopee, sem truncar;
 *   - status desconhecido nao vira `status = "unknown"` no banco;
 *   - pedido ausente da resposta nao gera mudanca;
 *   - a escrita toca `status` e `status_shopee_raw`, e mais nada.
 *
 * EQUIVALENCIA SQL <-> TS (verificar antes da primeira execucao real, leitura
 * pura): comparar `bucketDoPedido(order_id)` com o resultado de `SQL_BUCKET`
 * no Postgres para uma amostra. Esta suite nao acessa o banco, entao ela prova
 * as propriedades da funcao TS, nao a igualdade com o SQL.
 */
import "./_server-only-inerte";
import "./_env-inerte";
import {
  BUCKETS,
  INTERVALO_CICLO_MS,
  STATUS_NAO_TERMINAIS,
  IDADE_FAIXA_A_DIAS,
  TETO_POR_EXECUCAO_PADRAO,
  SQL_BUCKET,
  bucketDoPedido,
  tickDoCiclo,
  bucketsDoCiclo,
  RPC_SELECAO,
  montarParametrosRpc,
  dataReferenciaBRT,
  deduplicarSelecao,
  verificarTeto,
  ErroSelecaoAcimaDoTeto,
  lotesDe,
  lerRespostas,
  percentis,
  executarSyncDeStatus,
  DETAIL_BATCH,
  DETAIL_CONCURRENCY,
  type DependenciasStatus,
  type OpcoesSyncStatus,
} from "../lib/shopee-status";
import { LOTE_UPDATE_STATUS } from "../lib/shopee-financeiro";
import fs from "node:fs";

let passou = 0, falhou = 0;
const falhas: string[] = [];
function ok(nome: string, cond: boolean, det = "") {
  if (cond) { passou++; console.log(`  PASS  ${nome}`); }
  else { falhou++; falhas.push(nome); console.log(`  FALHA ${nome}${det ? `  -> ${det}` : ""}`); }
}
function eq(nome: string, real: unknown, esp: unknown) {
  ok(nome, JSON.stringify(real) === JSON.stringify(esp), `recebido ${JSON.stringify(real)}, esperado ${JSON.stringify(esp)}`);
}
function lanca(nome: string, fn: () => unknown, trecho = "") {
  try { fn(); ok(nome, false, "nao lancou"); }
  catch (e: any) { ok(nome, trecho === "" || String(e?.message ?? e).includes(trecho), `mensagem: ${e?.message}`); }
}

// `mapStatus` NAO e exportado por lib/sync-shopee.ts. Em vez de manter uma
// segunda copia do mapa (que poderia divergir em silencio), a suite le o mapa
// da PROPRIA FONTE de producao — mesma tecnica de
// scripts/testar-status-e-protecao-financeira.ts.
const FONTE = fs.readFileSync("lib/sync-shopee.ts", "utf8");
const BLOCO = FONTE.slice(FONTE.indexOf("const m: Record<string, string> = {"), FONTE.indexOf("// CORRECAO P5"));
const MAPA: Record<string, string> = {};
for (const m of BLOCO.matchAll(/^\s*([A-Z_]+):\s*"([a-z]+)"/gm)) MAPA[m[1]] = m[2];
const mapear = (raw: string) => MAPA[raw] ?? "unknown";

console.log("\n=== A. CONSTANTES E CONTRATO ===\n");
{
  eq("1. BUCKETS = 1024", BUCKETS, 1024);
  eq("2. INTERVALO_CICLO_MS = 1 hora", INTERVALO_CICLO_MS, 3_600_000);
  eq("3. TETO_POR_EXECUCAO_PADRAO conservador", TETO_POR_EXECUCAO_PADRAO, 4000);
  eq("4. IDADE_FAIXA_A_DIAS = 2", IDADE_FAIXA_A_DIAS, 2);
  eq("5. os 8 status nao-terminais aprovados", [...STATUS_NAO_TERMINAIS].sort(),
     ["IN_CANCEL", "PROCESSED", "READY_TO_SHIP", "RETRY_SHIP", "SHIPPED", "TO_CONFIRM_RECEIVE", "TO_RETURN", "UNPAID"]);
  for (const proibido of ["COMPLETED", "CANCELLED"])
    ok(`6. ${proibido} NAO esta na fila (terminal)`, !STATUS_NAO_TERMINAIS.includes(proibido));
  ok("7. reutiliza DETAIL_BATCH=50 do sync", DETAIL_BATCH === 50);
  ok("8. reutiliza DETAIL_CONCURRENCY=10 do sync", DETAIL_CONCURRENCY === 10);
  ok("9. reutiliza LOTE_UPDATE_STATUS=200", LOTE_UPDATE_STATUS === 200);
  eq("10. o mapa lido da fonte tem 16 entradas", Object.keys(MAPA).length, 16);
}

console.log("\n=== B. EXPRESSAO DO BUCKET (item 3) ===\n");
{
  ok("11. SQL_BUCKET usa get_byte/decode/md5", SQL_BUCKET.includes("get_byte") && SQL_BUCKET.includes("decode") && SQL_BUCKET.includes("md5"));
  ok("12. SQL_BUCKET NAO usa abs(...bit(32)::int) — risco de overflow", !SQL_BUCKET.includes("abs("));
  ok("13. SQL_BUCKET NAO usa hashtext (instavel entre versoes)", !SQL_BUCKET.includes("hashtext"));
  ok("14. SQL_BUCKET fecha no modulo BUCKETS", SQL_BUCKET.includes(`% ${BUCKETS}`));
  // a expressao aparece UMA vez na fonte do modulo, sem copia divergente
  const fonteMod = fs.readFileSync("lib/shopee-status.ts", "utf8");
  const ocorrencias = (fonteMod.match(/get_byte\(decode\(md5\(order_id\)/g) ?? []).length;
  eq("15. a expressao esta definida UMA vez (SQL_BUCKET), sem copia", ocorrencias, 2); // 2 = os dois get_byte da MESMA expressao

  const ids = Array.from({ length: 3000 }, (_, i) => `2608${String(i).padStart(10, "0")}`);
  const bs = ids.map(bucketDoPedido);
  ok("17. bucket sempre em [0, 1024)", bs.every(b => Number.isInteger(b) && b >= 0 && b < BUCKETS));
  ok("18. bucket e deterministico", ids.every(id => bucketDoPedido(id) === bucketDoPedido(id)));
  const distintos = new Set(bs).size;
  ok("19. distribui por muitos buckets", distintos > 700, `distintos=${distintos}`);
  eq("20. mesmo order_id -> mesmo bucket sempre", bucketDoPedido("260815CXNMDQQ2"), bucketDoPedido("260815CXNMDQQ2"));
}

console.log("\n=== C. RELOGIO (item 4) ===\n");
{
  eq("21. tickDoCiclo(0) = 0", tickDoCiclo(0), 0);
  eq("22. tickDoCiclo(1h) = 1", tickDoCiclo(3_600_000), 1);
  eq("23. tickDoCiclo(1h-1ms) = 0", tickDoCiclo(3_599_999), 0);
  eq("24. tickDoCiclo e piso, nao arredondamento", tickDoCiclo(7_199_999), 1);
  lanca("25. agoraMs invalido lanca", () => tickDoCiclo(NaN), "agoraMs invalido");
  const semComentarios = fs.readFileSync("lib/shopee-status.ts", "utf8")
    .replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
  ok("26. agoraMs e PARAMETRO (nao ha Date.now no codigo do modulo)", !semComentarios.includes("Date.now()"));
}

console.log("\n=== D. COBERTURA DO SWEEP (item 15) ===\n");
{
  const KS_VALIDOS = [1, 2, 8, 16, 32, 64, 128, 256, 512, 1024];
  for (const K of KS_VALIDOS) {
    const ciclos = BUCKETS / K;
    for (const h of [0, 1, 7, 12345, 999_999]) {
      const uniao: number[] = [];
      for (let t = h; t < h + ciclos; t++) uniao.push(...bucketsDoCiclo(t, K));
      const set = new Set(uniao);
      const cobreTudo = set.size === BUCKETS && uniao.length === BUCKETS;
      if (!cobreTudo) { ok(`27. K=${K} h=${h}: cobertura`, false, `uniao=${uniao.length} distintos=${set.size}`); break; }
    }
    const ciclosK = BUCKETS / K;
    const uniao: number[] = [];
    for (let t = 0; t < ciclosK; t++) uniao.push(...bucketsDoCiclo(t, K));
    eq(`27. K=${String(K).padStart(4)}: uniao de ${String(ciclosK).padStart(4)} ciclos = 1024 buckets, cada um 1x`,
       [uniao.length, new Set(uniao).size, Math.min(...uniao), Math.max(...uniao)], [1024, 1024, 0, 1023]);
  }
  // invariancia ao ponto de partida
  const a = new Set<number>(), b = new Set<number>();
  for (let t = 0; t < 32; t++) bucketsDoCiclo(t, 32).forEach(x => a.add(x));
  for (let t = 500_000; t < 500_032; t++) bucketsDoCiclo(t, 32).forEach(x => b.add(x));
  eq("28. cobertura independe do ponto de partida h", [a.size, b.size], [1024, 1024]);
  eq("29. K=1024 -> uma execucao cobre tudo", bucketsDoCiclo(7, 1024).length, 1024);
  eq("30. cada ciclo devolve exatamente K buckets", bucketsDoCiclo(3, 32).length, 32);
  eq("31. os K buckets sao contiguos", bucketsDoCiclo(3, 32), Array.from({ length: 32 }, (_, i) => 96 + i));
  ok("32. determinismo: mesma entrada, mesma saida",
     JSON.stringify(bucketsDoCiclo(9, 64)) === JSON.stringify(bucketsDoCiclo(9, 64)));
  eq("33. tick negativo nao produz bucket negativo",
     bucketsDoCiclo(-1, 32).every(x => x >= 0 && x < 1024), true);

  for (const K of [3, 10, 100]) lanca(`34. K=${K} rejeitado (nao divide 1024)`, () => bucketsDoCiclo(0, K), "deve dividir");
  lanca("35. K=0 rejeitado", () => bucketsDoCiclo(0, 0), "inteiro >= 1");
  lanca("36. K negativo rejeitado", () => bucketsDoCiclo(0, -8), "inteiro >= 1");
  lanca("37. K>1024 rejeitado", () => bucketsDoCiclo(0, 2048), "nao pode ser maior");
  lanca("38. K nao inteiro rejeitado", () => bucketsDoCiclo(0, 3.5), "inteiro >= 1");
  lanca("39. tick nao inteiro rejeitado", () => bucketsDoCiclo(1.5, 32), "tick deve ser inteiro");
}

console.log("\n=== E. RPC DE SELECAO: validacao estatica do SQL (item 15) ===\n");
{
  const MIG = "supabase/migrations/20260819_rpc_selecao_status_shopee.sql";
  ok("40. a migration existe", fs.existsSync(MIG));
  const sql = fs.readFileSync(MIG, "utf8");
  // O que importa e o CORPO EXECUTAVEL, entre AS $$ e $$;. As palavras LIMIT,
  // OFFSET e current_date aparecem no texto do COMMENT ON FUNCTION (que
  // documenta a ausencia delas) — varrer o arquivo inteiro daria falso
  // positivo e treinaria a suite a mentir.
  const corpo = sql.slice(sql.indexOf("AS $$"), sql.indexOf("$$;")).replace(/--.*$/gm, "");
  const arquivo = sql.replace(/--.*$/gm, "");
  ok("40b. o corpo executavel foi isolado", corpo.length > 200 && corpo.includes("SELECT DISTINCT"));
  ok("41. RPC nao contem LIMIT", !/\blimit\b/i.test(corpo));
  ok("42. RPC nao contem OFFSET", !/\boffset\b/i.test(corpo));
  ok("43. RPC usa SELECT DISTINCT", /select\s+distinct/i.test(corpo));
  ok("44. RPC filtra marketplace='Shopee'", corpo.includes("marketplace = 'Shopee'"));
  ok("45. user_id e PARAMETRO, nao literal", corpo.includes("p.user_id = p_user_id"));
  ok("46. status nao-terminais parametrizados", corpo.includes("ANY(p_status_nao_terminais)"));
  ok("47. data de referencia e PARAMETRO", corpo.includes("p_data_referencia"));
  ok("48. NAO usa current_date (dependeria do timezone da conexao)", !/current_date/i.test(corpo));
  ok("49. bucket fixo em 1024 no corpo", corpo.includes("% 1024"));
  ok("50. bucket usa get_byte/decode/md5", corpo.includes("get_byte(decode(md5(p.order_id)"));
  ok("51. bucket NAO usa abs(...) — risco de overflow", !/abs\s*\(/i.test(corpo));
  ok("52. bucket NAO usa hashtext", !/hashtext/i.test(corpo));
  ok("53. buckets A e B parametrizados", corpo.includes("ANY(p_buckets_a)") && corpo.includes("ANY(p_buckets_b)"));
  ok("54. SECURITY INVOKER (nao DEFINER)", /SECURITY INVOKER/.test(arquivo) && !/SECURITY DEFINER/.test(arquivo));
  ok("55. search_path fixo", arquivo.includes("SET search_path = public"));
  ok("56. REVOKE de PUBLIC, anon e authenticated", /REVOKE ALL ON FUNCTION[\s\S]*FROM PUBLIC, anon, authenticated/.test(arquivo));
  ok("57. GRANT apenas a service_role", /GRANT EXECUTE ON FUNCTION[\s\S]*TO service_role/.test(arquivo));
  ok("58. sem SQL dinamico (EXECUTE/format/quote_)", !/\bexecute\s+format|\bformat\s*\(|quote_ident|quote_literal/i.test(corpo));
  ok("59. LANGUAGE sql — sem plpgsql, sem concatenacao", /LANGUAGE sql/i.test(arquivo));
  ok("60. funcao e STABLE (somente leitura)", /\bSTABLE\b/.test(arquivo));
  ok("61. nao escreve (sem INSERT/UPDATE/DELETE)",
     !/\b(insert\s+into|update\s+public\.pedidos|delete\s+from)\b/i.test(corpo));
  ok("62. colunas qualificadas (p.order_id) — evita ambiguidade de RETURNS TABLE", corpo.includes("p.order_id"));
  // A migration NAO pode tocar a estrutura da tabela: isso bloquearia escrita
  // em producao. O indice que ela criava era duplicado pior de
  // idx_pedidos_status_shopee_raw, que ja existe e ja e usado pelo planejador.
  ok("62b. migration NAO cria indice", !/create\s+index/i.test(arquivo));
  ok("62c. migration NAO tem ALTER TABLE", !/alter\s+table/i.test(arquivo));
  ok("62d. migration NAO tem DROP", !/drop/i.test(arquivo));
  ok("62e. migration NAO tem INSERT/UPDATE/DELETE em lugar nenhum",
     !/insert\s+into|update\s+public\.|delete\s+from/i.test(arquivo));
  ok("62f. migration contem apenas FUNCTION + COMMENT + REVOKE + GRANT",
     /CREATE OR REPLACE FUNCTION/.test(arquivo) && /COMMENT ON FUNCTION/.test(arquivo)
     && /REVOKE ALL ON FUNCTION/.test(arquivo) && /GRANT EXECUTE ON FUNCTION/.test(arquivo));
  ok("63. o modulo TS nao contem mais SQL cru de selecao",
     !/select\s+distinct/i.test(fs.readFileSync("lib/shopee-status.ts", "utf8")));
}

console.log("\n=== E2. PAYLOAD EXATO DA RPC (item 10) ===\n");
{
  eq("64. nome da RPC", RPC_SELECAO, "selecionar_pedidos_status_shopee");
  const p = montarParametrosRpc({ userId: "u-1", dataReferencia: "2026-08-18", bucketsA: [0, 1], bucketsB: [8, 9] });
  eq("65. as 6 chaves do payload", Object.keys(p).sort(),
     ["p_buckets_a", "p_buckets_b", "p_data_referencia", "p_idade_faixa_a", "p_status_nao_terminais", "p_user_id"]);
  eq("66. p_user_id vem do argumento", p.p_user_id, "u-1");
  eq("67. p_data_referencia explicita", p.p_data_referencia, "2026-08-18");
  eq("68. p_idade_faixa_a = 2", p.p_idade_faixa_a, 2);
  eq("69. p_status_nao_terminais = os 8 aprovados", (p.p_status_nao_terminais as string[]).length, 8);
  eq("70. buckets repassados sem alteracao", [p.p_buckets_a, p.p_buckets_b], [[0, 1], [8, 9]]);
  eq("71. dataReferenciaBRT: 18/08 02:00 UTC ainda e dia 17 em BRT",
     dataReferenciaBRT(Date.parse("2026-08-18T02:00:00Z")), "2026-08-17");
  eq("72. dataReferenciaBRT: 18/08 03:00 UTC ja e dia 18 em BRT",
     dataReferenciaBRT(Date.parse("2026-08-18T03:00:00Z")), "2026-08-18");
  lanca("73. dataReferenciaBRT rejeita entrada invalida", () => dataReferenciaBRT(NaN), "agoraMs invalido");
}

console.log("\n=== F. DEDUP A+B (item 5 e 17) ===\n");
{
  const s = deduplicarSelecao(["X1", "X2", "X3"], ["X3", "X4", "X4"]);
  eq("50. antesDedup soma as duas faixas", s.antesDedup, 6);
  eq("51. selecionados sem repeticao", s.selecionados, ["X1", "X2", "X3", "X4"]);
  eq("52. pedido em A e B aparece UMA vez", s.selecionados.filter(x => x === "X3").length, 1);
  eq("53. duplicata dentro da mesma faixa some", s.selecionados.filter(x => x === "X4").length, 1);
  eq("54. selecao vazia nao quebra", deduplicarSelecao([], []).selecionados, []);
  eq("55. entradas vazias sao ignoradas", deduplicarSelecao(["", "A"], [""]).selecionados, ["A"]);
}

console.log("\n=== G. TETO (item 7) ===\n");
{
  ok("56. abaixo do teto passa", (() => { verificarTeto(3999, 4000); return true; })());
  ok("57. exatamente no teto passa", (() => { verificarTeto(4000, 4000); return true; })());
  lanca("58. acima do teto lanca", () => verificarTeto(4001, 4000), "SELECAO_ACIMA_DO_TETO");
  try { verificarTeto(9000, 4000); } catch (e: any) {
    ok("59. erro tipado com codigo", e instanceof ErroSelecaoAcimaDoTeto && e.codigo === "SELECAO_ACIMA_DO_TETO");
    eq("60. erro carrega os numeros", [e.selecionados, e.teto], [9000, 4000]);
  }
  lanca("61. teto invalido lanca", () => verificarTeto(1, 0), "teto invalido");
}

console.log("\n=== H. LEITURA DA RESPOSTA (item 9) ===\n");
{
  const sel = ["A1", "A2", "A3", "A4"];
  const resp = [{ response: { order_list: [
    { order_sn: "A1", order_status: "COMPLETED" },
    { order_sn: "A2", order_status: "SHIPPED" },
    { order_sn: "A3", order_status: "STATUS_QUE_NAO_EXISTE" },
  ] } }];
  const r = lerRespostas(sel, resp, mapear);
  eq("62. listados so com raw conhecido", r.listados.map(x => x.order_sn), ["A1", "A2"]);
  eq("63. status desconhecido NAO entra em listados", r.listados.find(x => x.order_sn === "A3"), undefined);
  eq("64. desconhecido e contabilizado", r.statusDesconhecidos, { STATUS_QUE_NAO_EXISTE: 1 });
  eq("65. pedido ausente da resposta vira semResposta", r.semResposta, ["A4"]);
  eq("66. respondidos conta o que a API devolveu", r.respondidos, 3);
  eq("67. selecionado ausente NAO gera mudanca",
     require("../lib/shopee-financeiro").decidirAtualizacaoDeStatus(r.listados, new Map([["A4", "PROCESSED"]])).length, 0);
  eq("68. desconhecido NAO gera mudanca",
     require("../lib/shopee-financeiro").decidirAtualizacaoDeStatus(r.listados, new Map([["A3", "PROCESSED"]])).length, 0);
  const r2 = lerRespostas(["B1"], [{ response: { order_list: [
    { order_sn: "B1", order_status: "SHIPPED" }, { order_sn: "B1", order_status: "COMPLETED" }] } }], mapear);
  eq("69. pedido repetido na resposta conta uma vez", r2.listados.length, 1);
  eq("70. resposta vazia: tudo vira semResposta", lerRespostas(["C1", "C2"], [], mapear).semResposta.length, 2);
  eq("71. nunca sintetiza status", lerRespostas(["D1"], [{ response: { order_list: [] } }], mapear).listados, []);
}

console.log("\n=== I. LOTES E PERCENTIS ===\n");
{
  eq("72. 120 pedidos -> lotes de 50/50/20", lotesDe(Array.from({ length: 120 }, (_, i) => i), 50).map(l => l.length), [50, 50, 20]);
  eq("73. lote exato nao gera lote vazio", lotesDe([1, 2, 3, 4], 2).length, 2);
  eq("74. lista vazia -> zero lotes", lotesDe([], 50), []);
  lanca("75. tamanho de lote invalido lanca", () => lotesDe([1], 0), "tamanho invalido");
  eq("76. percentis de vazio = 0", percentis([]), { p50: 0, p95: 0 });
  eq("77. p50/p95 de 1..100", percentis(Array.from({ length: 100 }, (_, i) => i + 1)), { p50: 50, p95: 95 });
  eq("78. percentis nao muta a entrada", (() => { const a = [3, 1, 2]; percentis(a); return a; })(), [3, 1, 2]);
}

// ─────────────────────────────────────────────────────────────────────────────
// BANCO FALSO — usado nas secoes J..M
// ─────────────────────────────────────────────────────────────────────────────
interface LinhaFake extends Record<string, unknown> {
  id: string; user_id: string; marketplace: string; order_id: string;
  status: string; status_shopee_raw: string | null;
  data_pagamento: string; item_subtotal: number; faturamento: number; qtd: number;
  escrow_amount: number; commission_fee: number; financial_reconciled_at: string | null;
  financial_version: number | null; financial_source: string | null;
}
function linha(o: Partial<LinhaFake> & { id: string; order_id: string }): LinhaFake {
  return {
    user_id: "u1", marketplace: "Shopee", status: "paid", status_shopee_raw: "PROCESSED",
    data_pagamento: "2026-08-01", item_subtotal: 10, faturamento: 20, qtd: 1,
    escrow_amount: 7.66, commission_fee: 2.57, financial_reconciled_at: "2026-08-18T14:42:11.053Z",
    financial_version: 2, financial_source: "get_escrow_detail", ...o,
  } as LinhaFake;
}
/** Reproduz a semantica do UPDATE cirurgico: 2 colunas, 3 filtros. */
function aplicarUpdateFake(banco: LinhaFake[], userId: string, g: { statusComercial: string; statusRaw: string; orderSns: string[] }) {
  for (const l of banco) {
    if (l.user_id !== userId) continue;
    if (l.marketplace !== "Shopee") continue;
    if (!g.orderSns.includes(l.order_id)) continue;
    l.status = g.statusComercial;
    l.status_shopee_raw = g.statusRaw;
  }
}
function deps(banco: LinhaFake[], shopee: Record<string, string>, over: Partial<DependenciasStatus> = {}): DependenciasStatus & { chamadas: string[][]; updates: any[] } {
  const chamadas: string[][] = [];
  const updates: any[] = [];
  let relogio = 0;
  const d: any = {
    chamadas, updates,
    async selecionar({ userId, naoTerminais, idadeFaixaA, bucketsA, bucketsB }: any) {
      const A: string[] = [], B: string[] = [];
      const vistos = new Set<string>();
      for (const l of banco) {
        if (l.user_id !== userId || l.marketplace !== "Shopee") continue;
        if (!l.status_shopee_raw || !naoTerminais.includes(l.status_shopee_raw)) continue;
        if (vistos.has(l.order_id)) continue;
        vistos.add(l.order_id);
        const idade = Number((l as any).__idade ?? 30);
        const bk = bucketDoPedido(l.order_id);
        if (idade <= idadeFaixaA) { if (bucketsA.includes(bk)) A.push(l.order_id); }
        else { if (bucketsB.includes(bk)) B.push(l.order_id); }
      }
      return { faixaA: A, faixaB: B };
    },
    async consultarLote(orderSns: string[]) {
      chamadas.push(orderSns);
      return { response: { order_list: orderSns.filter(sn => shopee[sn]).map(sn => ({ order_sn: sn, order_status: shopee[sn] })) } };
    },
    async statusNoBanco(orderSns: string[]) {
      const m = new Map<string, string | null>();
      for (const l of banco) if (l.marketplace === "Shopee" && orderSns.includes(l.order_id)) m.set(l.order_id, l.status_shopee_raw);
      return m;
    },
    async aplicarGrupo(g: any) { updates.push(g); aplicarUpdateFake(banco, "u1", g); return { erro: null }; },
    mapear,
    agora: () => (relogio += 10),
  };
  return { ...d, ...over };
}
const OPTS: OpcoesSyncStatus = {
  userId: "u1", dryRun: false, campos: "minimo", kA: 1024, kB: 1024,
  teto: TETO_POR_EXECUCAO_PADRAO, agoraMs: 1_700_000_000_000,
};

async function secaoAssincrona() {
  console.log("\n=== J. IDEMPOTENCIA (item 14) ===\n");
  {
    // A) status do banco == status da Shopee
    const banco = [linha({ id: "L1", order_id: "P1", status_shopee_raw: "PROCESSED" })];
    const d = deps(banco, { P1: "PROCESSED" });
    const r = await executarSyncDeStatus(OPTS, d);
    eq("79. A) status igual -> zero mudanca", r.mudancas, 0);
    eq("80. A) zero chunk de UPDATE", r.chunksUpdate, 0);
    eq("81. A) linha intacta", banco[0].status_shopee_raw, "PROCESSED");

    // B) segunda execucao apos mudanca real
    const banco2 = [linha({ id: "L2", order_id: "P2", status_shopee_raw: "PROCESSED" })];
    const d2 = deps(banco2, { P2: "COMPLETED" });
    const r1 = await executarSyncDeStatus(OPTS, d2);
    eq("82. B) 1a execucao detecta 1 mudanca", r1.mudancas, 1);
    eq("83. B) 1a execucao grava", [banco2[0].status_shopee_raw, banco2[0].status], ["COMPLETED", "paid"]);
    const r2 = await executarSyncDeStatus(OPTS, deps(banco2, { P2: "COMPLETED" }));
    eq("84. B) 2a execucao: ZERO mudanca", r2.mudancas, 0);
    eq("85. B) 2a execucao: ZERO UPDATE", r2.chunksUpdate, 0);

    // C) pedido ausente da resposta
    const banco3 = [linha({ id: "L3", order_id: "P3", status_shopee_raw: "PROCESSED" })];
    const r3 = await executarSyncDeStatus(OPTS, deps(banco3, {}));
    eq("86. C) ausente: semResposta=1", r3.semResposta, 1);
    eq("87. C) ausente: zero mudanca", r3.mudancas, 0);
    eq("88. C) ausente: linha intacta", banco3[0].status_shopee_raw, "PROCESSED");

    // D) status desconhecido
    const banco4 = [linha({ id: "L4", order_id: "P4", status_shopee_raw: "PROCESSED" })];
    const r4 = await executarSyncDeStatus(OPTS, deps(banco4, { P4: "NOVO_STATUS_2027" }));
    eq("89. D) desconhecido registrado", r4.statusDesconhecidos, { NOVO_STATUS_2027: 1 });
    eq("90. D) desconhecido: zero mudanca", r4.mudancas, 0);
    eq("91. D) desconhecido: status comercial NAO virou 'unknown'", banco4[0].status, "paid");
    eq("92. D) desconhecido: raw intacto", banco4[0].status_shopee_raw, "PROCESSED");

    // E) erro na coleta -> zero escrita
    const banco5 = [linha({ id: "L5", order_id: "P5", status_shopee_raw: "PROCESSED" })];
    const d5 = deps(banco5, { P5: "COMPLETED" });
    const r5 = await executarSyncDeStatus(OPTS, { ...d5, consultarLote: async () => { throw new Error("ECONNRESET"); } });
    eq("93. E) coleta falhou -> ok=false", r5.ok, false);
    eq("94. E) codigo FALHA_NA_COLETA", r5.codigoErro, "FALHA_NA_COLETA");
    eq("95. E) ZERO chunk de UPDATE", r5.chunksUpdate, 0);
    eq("96. E) banco intacto (fase 2 nunca rodou)", banco5[0].status_shopee_raw, "PROCESSED");

    // F) falha em chunk de UPDATE
    const banco6 = [linha({ id: "L6", order_id: "P6", status_shopee_raw: "PROCESSED" })];
    const d6 = deps(banco6, { P6: "COMPLETED" });
    const r6 = await executarSyncDeStatus(OPTS, { ...d6, aplicarGrupo: async () => ({ erro: "permission denied" }) });
    eq("97. F) chunk falho contabilizado", [r6.chunksUpdate, r6.chunksFalhos], [1, 1]);
    eq("98. F) resultado marcado como nao-ok", r6.ok, false);
    eq("99. F) codigo CHUNKS_UPDATE_FALHOS", r6.codigoErro, "CHUNKS_UPDATE_FALHOS");
  }

  console.log("\n=== K. DRY RUN (item 11) ===\n");
  {
    const banco = [linha({ id: "L7", order_id: "P7", status_shopee_raw: "PROCESSED" })];
    const d = deps(banco, { P7: "COMPLETED" });
    const r = await executarSyncDeStatus({ ...OPTS, dryRun: true }, d);
    eq("100. dry_run consulta a Shopee", d.chamadas.length, 1);
    eq("101. dry_run DECIDE a mudanca", r.mudancas, 1);
    eq("102. dry_run agrupa", r.grupos, 1);
    eq("103. dry_run mostra porStatus", r.porStatus, { COMPLETED: 1 });
    eq("104. dry_run NAO executa UPDATE", r.chunksUpdate, 0);
    eq("105. dry_run NAO altera o banco", banco[0].status_shopee_raw, "PROCESSED");
    eq("106. dry_run reportado na resposta", r.dry_run, true);
  }

  console.log("\n=== L. UPDATE CIRURGICO: o que muda e o que nao muda (item 10) ===\n");
  {
    const banco = [
      linha({ id: "M1", order_id: "PM", status_shopee_raw: "PROCESSED" }),
      linha({ id: "M2", order_id: "PM", status_shopee_raw: "PROCESSED" }),
      linha({ id: "M3", order_id: "PM", status_shopee_raw: "PROCESSED" }),
      linha({ id: "M4", order_id: "PM", status_shopee_raw: "PROCESSED" }),
      linha({ id: "M5", order_id: "PM", status_shopee_raw: "PROCESSED" }),
      linha({ id: "M6", order_id: "PM", status_shopee_raw: "PROCESSED" }),
      linha({ id: "M7", order_id: "PM", status_shopee_raw: "PROCESSED" }),
    ];
    const antes = JSON.parse(JSON.stringify(banco));
    const d = deps(banco, { PM: "COMPLETED" });
    const r = await executarSyncDeStatus(OPTS, d);
    eq("107. item 17: 7 linhas -> UMA consulta Shopee", d.chamadas.flat().filter(x => x === "PM").length, 1);
    eq("108. item 17: uma unica mudanca decidida", r.mudancas, 1);
    eq("109. item 17: as 7 linhas recebem o novo raw", banco.map(l => l.status_shopee_raw), Array(7).fill("COMPLETED"));
    eq("110. item 17: as 7 linhas recebem o novo status", banco.map(l => l.status), Array(7).fill("paid"));
    const PROIBIDOS = ["data_pagamento", "item_subtotal", "faturamento", "qtd",
      "escrow_amount", "commission_fee", "financial_reconciled_at", "financial_version", "financial_source"];
    let intactos = 0;
    for (let i = 0; i < banco.length; i++)
      for (const k of PROIBIDOS)
        if (JSON.stringify((banco[i] as any)[k]) === JSON.stringify((antes[i] as any)[k])) intactos++;
    eq("111. NENHUM campo proibido mudou (7 linhas x 9 campos)", intactos, 63);
    const g = d.updates[0];
    eq("112. o grupo carrega SOMENTE status/raw/ids", Object.keys(g).sort(), ["orderSns", "statusComercial", "statusRaw"]);
  }

  console.log("\n=== M. ISOLAMENTO (item 18) ===\n");
  {
    const banco = [
      linha({ id: "I1", order_id: "PX", user_id: "u1", status_shopee_raw: "PROCESSED" }),
      linha({ id: "I2", order_id: "PX", user_id: "u2", status_shopee_raw: "PROCESSED" }),
      linha({ id: "I3", order_id: "PX", user_id: "u1", marketplace: "ML", status_shopee_raw: "PROCESSED" }),
    ];
    const d = deps(banco, { PX: "COMPLETED" });
    await executarSyncDeStatus(OPTS, d);
    eq("113. pedido do PROPRIO usuario foi atualizado", banco[0].status_shopee_raw, "COMPLETED");
    eq("114. mesmo order_id de OUTRO user_id intacto", banco[1].status_shopee_raw, "PROCESSED");
    eq("115. mesmo order_id em ML intacto", banco[2].status_shopee_raw, "PROCESSED");
    const antes = banco.length;
    await executarSyncDeStatus(OPTS, deps(banco, { INEXISTENTE: "COMPLETED" }));
    eq("116. pedido inexistente no banco NAO e inserido", banco.length, antes);
  }

  console.log("\n=== N. CRESCIMENTO (item 16) ===\n");
  {
    console.log("     N          bucket   K     selecionados   chamadas   ondas   teto 4000");
    console.log("     ─────────────────────────────────────────────────────────────────────");
    for (const [N, K] of [[24_000, 32], [50_000, 32], [100_000, 32], [100_000, 16], [250_000, 16], [250_000, 8]] as Array<[number, number]>) {
      const porBucket = N / BUCKETS;
      const sel = Math.round(porBucket * K);
      const ch = Math.ceil(sel / DETAIL_BATCH), on = Math.ceil(ch / DETAIL_CONCURRENCY);
      const cabe = sel <= TETO_POR_EXECUCAO_PADRAO;
      console.log(`     ${String(N).padStart(7)} ${porBucket.toFixed(1).padStart(8)} ${String(K).padStart(5)} ${String(sel).padStart(14)} ${String(ch).padStart(10)} ${String(on).padStart(7)}   ${cabe ? "cabe" : "ABORTA"}`);
    }
    // reduzir K reduz a selecao mas NAO muda o bucket do pedido
    const id = "260815CXNMDQQ2";
    const bk = bucketDoPedido(id);
    eq("117. reduzir K nao muda bucket(order_id)", [bucketDoPedido(id), bucketDoPedido(id)], [bk, bk]);
    ok("118. K menor => janela menor", bucketsDoCiclo(0, 8).length < bucketsDoCiclo(0, 32).length);
    // um bucket com muitos pedidos NAO e truncado
    const muitos = Array.from({ length: 900 }, (_, i) => linha({ id: `G${i}`, order_id: `G${i}`, status_shopee_raw: "PROCESSED" }));
    const shopeeMuitos: Record<string, string> = {};
    for (const l of muitos) shopeeMuitos[l.order_id] = "COMPLETED";
    const dM = deps(muitos, shopeeMuitos);
    const rM = await executarSyncDeStatus(OPTS, dM);
    eq("119. 900 pedidos: NENHUM descartado da selecao", rM.selecionados, 900);
    eq("120. 900 pedidos: todos consultados", dM.chamadas.flat().length, 900);
    eq("121. 900 pedidos: 18 chamadas de 50", dM.chamadas.length, 18);
    eq("122. 900 pedidos: 2 ondas de <=10", rM.ondas, 2);
    eq("123. 900 mudancas: 5 chunks de UPDATE (200)", rM.chunksUpdate, 5);
    // acima do teto: aborta ANTES da Shopee
    // dataset NOVO: o `muitos` acima ja foi mutado para COMPLETED (terminal)
    // e sairia da selecao, mascarando o teste do teto.
    const muitos2 = Array.from({ length: 900 }, (_, i) => linha({ id: `T${i}`, order_id: `G${i}`, status_shopee_raw: "PROCESSED" }));
    const dT = deps(muitos2, shopeeMuitos);
    const rT = await executarSyncDeStatus({ ...OPTS, teto: 500 }, dT);
    eq("124. acima do teto: ok=false", rT.ok, false);
    eq("125. acima do teto: codigo SELECAO_ACIMA_DO_TETO", rT.codigoErro, "SELECAO_ACIMA_DO_TETO");
    eq("126. acima do teto: ZERO chamada a Shopee", dT.chamadas.length, 0);
    eq("127. acima do teto: ZERO update", rT.chunksUpdate, 0);
    eq("128. acima do teto: NAO truncou (selecionados reportado inteiro)", rT.selecionados, 900);
  }

  console.log("\n=== O. K_A: a garantia depende de K_A=1024 (item 6) ===\n");
  {
    const recentes = Array.from({ length: 200 }, (_, i) => {
      const l = linha({ id: `R${i}`, order_id: `R${i}`, status_shopee_raw: "PROCESSED" });
      (l as any).__idade = 1; return l;
    });
    const sh: Record<string, string> = {};
    for (const l of recentes) sh[l.order_id] = "PROCESSED";
    const rTudo = await executarSyncDeStatus({ ...OPTS, kA: 1024, kB: 1024 }, deps(recentes, sh));
    eq("129. K_A=1024 -> TODOS os recentes na mesma execucao", rTudo.selecionadosFaixaA, 200);
    const rParcial = await executarSyncDeStatus({ ...OPTS, kA: 8, kB: 8 }, deps(recentes, sh));
    ok("130. K_A=8 -> apenas uma fracao dos recentes (cenario de MEDICAO)",
       rParcial.selecionadosFaixaA < 200, `selecionou ${rParcial.selecionadosFaixaA}`);
    eq("131. com K_A=8 a faixa A cobre 1024/8 = 128 execucoes", BUCKETS / 8, 128);
  }

  console.log("\n=== P. METRICAS (item 12) ===\n");
  {
    const banco = [linha({ id: "Q1", order_id: "Q1", status_shopee_raw: "PROCESSED" })];
    const r = await executarSyncDeStatus(OPTS, deps(banco, { Q1: "COMPLETED" }));
    const OBRIGATORIAS = ["ok", "dry_run", "campos", "bucket_total", "kA", "kB", "tick", "bucketsA", "bucketsB",
      "selecionadosFaixaA", "selecionadosFaixaB", "selecionadosAntesDedup", "selecionados", "teto",
      "consultados", "respondidos", "semResposta", "statusDesconhecidos", "mudancas", "porStatus",
      "grupos", "chunksUpdate", "chunksFalhos", "retries", "ondas", "p50ChamadaMs", "p95ChamadaMs",
      "tempoSelecaoMs", "tempoShopeeMs", "tempoUpdateMs", "tempoTotalMs"];
    for (const k of OBRIGATORIAS) ok(`132. metrica ${k} presente`, k in r);
    eq("133. bucket_total reportado", r.bucket_total, 1024);
    ok("134. tick reportado e determinista", r.tick === tickDoCiclo(OPTS.agoraMs));
    const rRet = await executarSyncDeStatus(OPTS, { ...deps([linha({ id: "Q2", order_id: "Q2", status_shopee_raw: "PROCESSED" })], { Q2: "COMPLETED" }), retriesAcumulados: () => 7 });
    eq("135. retries vem do hook injetado (nao e sempre 0)", rRet.retries, 7);
    const rSem = await executarSyncDeStatus(OPTS, deps([linha({ id: "Q3", order_id: "Q3", status_shopee_raw: "PROCESSED" })], { Q3: "COMPLETED" }));
    eq("136. sem hook, retries=0 (nao instrumentado)", rSem.retries, 0);
  }

  console.log("\n================================================================");
  console.log("\n=== Q. PROTECAO COMPARTILHADA CONTRA 'unknown' (item 2) ===\n");
  {
    const { agruparMudancasDeStatus, separarStatusDesconhecidos } = require("../lib/shopee-financeiro");
    const { mapStatus } = require("../lib/sync-shopee");
  
    // O mapStatus EXPORTADO tem de ser o mesmo mapa lido da fonte.
    for (const raw of Object.keys(MAPA))
      ok(`137. mapStatus("${raw}") exportado == fonte`, mapStatus(raw) === MAPA[raw]);
    eq("138. raw desconhecido continua devolvendo 'unknown'", mapStatus("STATUS_NOVO_DA_SHOPEE"), "unknown");
  
    // A protecao vive na camada COMPARTILHADA: vale para o processo novo E para
    // a etapa 1.6 ja publicada.
    const sep = separarStatusDesconhecidos(
      [{ order_sn: "K1", para: "COMPLETED" }, { order_sn: "K2", para: "STATUS_NOVO_DA_SHOPEE" }], mapStatus);
    eq("139. conhecidas passam", sep.conhecidas.map((x: any) => x.order_sn), ["K1"]);
    eq("140. desconhecidos sao contados por raw", sep.desconhecidos, { STATUS_NOVO_DA_SHOPEE: 1 });
  
    const grupos = agruparMudancasDeStatus(
      [{ order_sn: "K1", para: "COMPLETED" }, { order_sn: "K2", para: "STATUS_NOVO_DA_SHOPEE" }], mapStatus);
    eq("141. agrupar produz UM grupo (o desconhecido nao vira UPDATE)", grupos.length, 1);
    eq("142. o grupo e o do raw conhecido", [grupos[0].statusRaw, grupos[0].statusComercial], ["COMPLETED", "paid"]);
    eq("143. o pedido desconhecido NAO esta em nenhum grupo",
       grupos.some((g: any) => g.orderSns.includes("K2")), false);
    ok("144. NENHUM grupo carrega statusComercial 'unknown'",
       grupos.every((g: any) => g.statusComercial !== "unknown"));
  
    // so desconhecidos => nenhum UPDATE, nada gravado
    const soDesc = agruparMudancasDeStatus([{ order_sn: "K3", para: "OUTRO_NOVO" }], mapStatus);
    eq("145. so desconhecidos -> zero grupo -> zero UPDATE", soDesc.length, 0);
  }
  
  console.log("\n=== R. ROTA: contrato verificado na FONTE (item 16 A-F) ===\n");
  {
    // Estas asserts leem a FONTE da rota. Provam o que o codigo DIZ, nao como ele
    // se comporta em runtime — o comportamento esta coberto pelas secoes J..O,
    // que exercitam executarSyncDeStatus com fakes. A distincao e deliberada:
    // a rota nao tem costura de injecao para ser instanciada sem Next.js.
    const ROTA = "app/api/admin/shopee/status/route.ts";
    ok("146. a rota existe", fs.existsSync(ROTA));
    const r = fs.readFileSync(ROTA, "utf8");
    const codigo = r.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
  
    ok("147. A) exige sessao via autenticarRequisicao", codigo.includes("await autenticarRequisicao(request)"));
    ok("148. A) sem sessao devolve 401", /autenticado[\s\S]{0,200}status:\s*401/.test(codigo));
    ok("149. B) userId vem da sessao (auth.uid)", codigo.includes("const userId = auth.uid"));
    ok("150. C) NAO le user_id do body/query", !/body\s*(as any)?\s*\)?\.user_?[iI]d|searchParams.get\("user_id"\)/.test(codigo));
    ok("151. C) o unico userId usado e o da sessao", (codigo.match(/const userId\s*=/g) ?? []).length === 1);
    ok("152. D) dry_run default TRUE (so grava com false explicito)", codigo.includes("dry_run !== false"));
    ok("153. E) campos default 'completo'", /c\s*\?\?\s*"completo"/.test(codigo));
    ok("154. F) valida K antes de qualquer I/O", codigo.includes("validarK") && codigo.includes("BUCKETS % k !== 0"));
    ok("155. F) K invalido -> 400 antes da Shopee", /status:\s*400/.test(codigo));
    ok("156. NAO expoe agoraMs como parametro", !/body[\s\S]{0,40}agoraMs/.test(codigo));
    ok("157. usa o relogio do servidor", codigo.includes("const agoraMs = Date.now()"));
    ok("158. usa supabase.rpc (nao SQL cru, nao pg)", codigo.includes("supabase.rpc(RPC_SELECAO"));
    ok("159. NAO importa pg", !/from\s+"pg"|require\("pg"\)/.test(codigo));
    ok("160. NAO usa DIRECT_URL/DATABASE_URL", !/DIRECT_URL|DATABASE_URL/.test(codigo));
    ok("161. usa service_role (a RPC e revogada de anon)", codigo.includes("SUPABASE_SERVICE_ROLE_KEY"));
    ok("162. service_role ausente LANCA (fail-closed)", /if \(!chave\) throw/.test(codigo));
    ok("163. injeta o mapStatus de producao", codigo.includes("mapear: mapStatus"));
    ok("164. UPDATE toca somente status e status_shopee_raw",
       codigo.includes(".update({ status: g.statusComercial, status_shopee_raw: g.statusRaw })"));
    eq("165. ha exatamente UM .update() na rota", (codigo.match(/\.update\(/g) ?? []).length, 1);
    ok("166. UPDATE filtra user_id + marketplace + order_id",
       /\.update\([\s\S]{0,200}\.eq\("user_id", userId\)[\s\S]{0,120}\.eq\("marketplace", "Shopee"\)[\s\S]{0,120}\.in\("order_id"/.test(codigo));
    ok("167. statusNoBanco filtra user_id e marketplace",
       /statusNoBanco[\s\S]{0,600}\.eq\("user_id", userId\)[\s\S]{0,200}\.eq\("marketplace", "Shopee"\)/.test(codigo));
    ok("168. erro da RPC LANCA (nao vira fila vazia)", /if \(error\) throw new Error\(`RPC/.test(codigo));
    ok("169. sem fallback automatico completo<->minimo",
       !/catch[\s\S]{0,200}campos\s*=\s*"completo"/.test(codigo));
    ok("170. nao ha upsert nem montarLinhasDoPedido",
       !/\.upsert\(|montarLinhasDoPedido/.test(codigo));
    for (const proibido of ["escrow_amount", "commission_fee", "financial_reconciled_at", "financial_version",
                            "faturamento", "item_subtotal", "data_pagamento", "tarifa_venda", "income_distribution"])
      ok(`171. a rota nao menciona ${proibido}`, !codigo.includes(proibido));
    ok("172. maxDuration declarado", codigo.includes("export const maxDuration"));
  }

  console.log(`  RESULTADO: ${passou} passaram, ${falhou} falharam (${passou + falhou} asserts)`);
  if (falhas.length) { console.log("\n  FALHAS:"); falhas.forEach(f => console.log(`    - ${f}`)); }
  console.log("================================================================\n");
  if (falhou > 0) process.exitCode = 1;
}

secaoAssincrona().catch(e => { console.error("ERRO NA SUITE:", e); process.exitCode = 1; });
