/**
 * scripts/testar-sync-shopee-recuperacao.ts
 *
 * Suite standalone da correcao de lacuna de sync da Shopee (2026-08-18).
 *
 * NAO chama IA, rede nem banco. `filtrarOrderSnsAusentes` recebe um consultor
 * injetado; `montarLinhasDoPedido` e pura. Rodar com:
 *
 *   npx tsx scripts/testar-sync-shopee-recuperacao.ts
 *
 * Cobre o que a auditoria provou: existiam DOIS portoes descartando pedido no
 * caminho do cron (update_time) — o filtro de COMPLETED na listagem e o corte
 * `dataBrt fora da janela` na montagem da linha. Corrigir so um nao resolvia.
 */
// PRIMEIRA linha de import, obrigatoriamente: lib/sync-shopee puxa
// lib/shopee-auth, que constroi o cliente Supabase no carregamento do modulo.
// Nenhum teste aqui faz IO — o consultor de banco e injetado.
import "./_env-inerte";
import {
  separarCompleted,
  lotesDeOrderSn,
  filtrarOrderSnsAusentes,
  montarLinhasDoPedido,
  LOTE_CONSULTA_ORDER_SN,
  type MontarLinhasCtx,
} from "../lib/sync-shopee";

let passou = 0;
let falhou = 0;
const falhas: string[] = [];

function ok(nome: string, condicao: boolean, detalhe = "") {
  if (condicao) { passou++; console.log(`  PASS  ${nome}`); }
  else { falhou++; falhas.push(nome); console.log(`  FALHA ${nome}${detalhe ? `  -> ${detalhe}` : ""}`); }
}
function eq(nome: string, real: unknown, esperado: unknown) {
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  ok(nome, a === b, `recebido ${a}, esperado ${b}`);
}

// ── util: epoch BRT a partir de "AAAA-MM-DD HH:MM" ────────────────────────
const epochBRT = (iso: string, hora = "12:00") =>
  Math.floor(Date.parse(`${iso}T${hora}:00-03:00`) / 1000);

const CTX_BASE: Omit<MontarLinhasCtx, "dateFrom" | "dateTo"> = {
  userId: "u1",
  lojaId: "loja1",
  nickname: "loja teste",
  noBuffer: false, // caminho do cron
  mapaAnuncios: new Map(),
};

function pedido(over: Record<string, any> = {}) {
  return {
    order_sn: "260724HJ4EA1T5",
    order_status: "COMPLETED",
    create_time: epochBRT("2026-07-24", "11:46"),
    pay_time:    epochBRT("2026-07-24", "11:47"),
    update_time: epochBRT("2026-07-27", "09:29"),
    total_amount: 20,
    item_list: [{
      item_id: 111, model_id: 222, item_sku: "SKU-A", item_name: "Produto A",
      model_discounted_price: 20, model_original_price: 25, model_quantity_purchased: 1,
    }],
    ...over,
  };
}
function montar(order: any, dateFrom: string, dateTo: string, recuperados?: Set<string>) {
  return montarLinhasDoPedido(order, {
    ...CTX_BASE, dateFrom, dateTo,
    ...(recuperados ? { orderSnsRecuperados: recuperados } : {}),
  });
}

console.log("\n=== A. separarCompleted (portao 1) ===\n");
{
  const lista = [
    { order_sn: "A1", order_status: "COMPLETED" },
    { order_sn: "A2", order_status: "PROCESSED" },
    { order_sn: "A3", order_status: "COMPLETED" },
    { order_sn: "A4", order_status: "SHIPPED" },
  ];
  const cron = separarCompleted(lista, true);
  eq("1. cron separa COMPLETED em completedSns", cron.completedSns, ["A1", "A3"]);
  eq("2. cron mantem os demais em orderSns", cron.orderSns, ["A2", "A4"]);
  ok("3. nenhum order_sn e perdido no caminho do cron",
     cron.orderSns.length + cron.completedSns.length === lista.length);

  const hist = separarCompleted(lista, false);
  eq("4. historico (filtrarCompleted=false) nao segrega nada", hist.completedSns, []);
  eq("5. historico devolve todos em orderSns", hist.orderSns, ["A1", "A2", "A3", "A4"]);

  eq("6. status ausente nao e tratado como COMPLETED",
     separarCompleted([{ order_sn: "B1" }], true).orderSns, ["B1"]);
  eq("7. lista vazia nao quebra", separarCompleted([], true), { orderSns: [], completedSns: [] });
}

console.log("\n=== B. lotesDeOrderSn ===\n");
{
  const sns = Array.from({ length: 450 }, (_, i) => `SN${i}`);
  const lotes = lotesDeOrderSn(sns);
  eq("8. 450 order_sn viram 3 lotes com o tamanho padrao", lotes.map(l => l.length), [200, 200, 50]);
  ok("9. tamanho padrao e 200", LOTE_CONSULTA_ORDER_SN === 200);
  eq("10. lista vazia gera zero lotes", lotesDeOrderSn([]), []);
  ok("11. nenhum order_sn se perde no loteamento",
     lotes.flat().length === sns.length && lotes.flat().every((s, i) => s === sns[i]));
  let lancou = false;
  try { lotesDeOrderSn(["X"], 0); } catch { lancou = true; }
  ok("12. tamanho de lote invalido lanca", lancou);
}

console.log("\n=== D. portao 2: corte por janela em montarLinhasDoPedido ===\n");
{
  // Cenario real provado: pago 24/07, concluido 27/07, cron rodando o dia 27/07.
  const p = pedido();
  const semRecuperacao = montar(p, "2026-07-27", "2026-07-27");
  eq("19. sem recuperacao, pedido pago fora da janela e descartado (comportamento antigo)",
     semRecuperacao.length, 0);

  const comRecuperacao = montar(p, "2026-07-27", "2026-07-27", new Set(["260724HJ4EA1T5"]));
  ok("20. COMPLETED ausente encontrado via update_time e processado", comRecuperacao.length === 1);
  eq("21. recuperado mantem data_pagamento do pay_time, nao da janela do sync",
     comRecuperacao[0]?.data_pagamento, "2026-07-24");
  eq("22. recuperado mantem data_criacao do create_time", comRecuperacao[0]?.data_criacao, "2026-07-24");
  eq("23. recuperado grava item_subtotal correto", comRecuperacao[0]?.item_subtotal, 20);
  eq("24. recuperado mapeia COMPLETED para status paid", comRecuperacao[0]?.status, "paid");
  eq("25. recuperado preserva o status bruto da Shopee",
     comRecuperacao[0]?.status_shopee_raw, "COMPLETED");

  // O conjunto de recuperados NAO pode liberar o corte para os outros pedidos.
  const outro = pedido({ order_sn: "OUTRO123" });
  eq("26. corte por janela continua valendo para pedido NAO recuperado",
     montar(outro, "2026-07-27", "2026-07-27", new Set(["260724HJ4EA1T5"])).length, 0);
  eq("27. pedido dentro da janela entra normalmente, com ou sem conjunto",
     montar(outro, "2026-07-24", "2026-07-24", new Set(["260724HJ4EA1T5"])).length, 1);
}

console.log("\n=== E. idempotencia: a chave da linha ===\n");
{
  const p = pedido();
  const a = montar(p, "2026-07-24", "2026-07-24");
  const b = montar(p, "2026-07-24", "2026-07-24");
  eq("28. mesma entrada produz a mesma chave id (upsert atualiza, nao duplica)",
     a[0]?.id, b[0]?.id);
  eq("29. id e deterministico a partir de user+order+item+variacao",
     a[0]?.id, "u1_SHOPEE_260724HJ4EA1T5_111_222");

  // recuperado depois vira caminho normal: a chave nao pode mudar
  const rec = montar(p, "2026-07-27", "2026-07-27", new Set(["260724HJ4EA1T5"]));
  eq("30. pedido recuperado gera a MESMA chave do caminho normal", rec[0]?.id, a[0]?.id);

  // multi-SKU: uma linha por item, chaves distintas
  const multi = pedido({ item_list: [
    { item_id: 111, model_id: 222, item_sku: "A", item_name: "A", model_discounted_price: 10, model_original_price: 10, model_quantity_purchased: 1 },
    { item_id: 333, model_id: 444, item_sku: "B", item_name: "B", model_discounted_price: 10, model_original_price: 10, model_quantity_purchased: 2 },
  ]});
  const linhasMulti = montar(multi, "2026-07-24", "2026-07-24");
  eq("31. pedido com 2 SKUs gera 2 linhas", linhasMulti.length, 2);
  ok("32. as 2 linhas tem chaves distintas", linhasMulti[0].id !== linhasMulti[1].id);
  eq("33. as 2 linhas compartilham o mesmo order_id",
     new Set(linhasMulti.map(l => l.order_id)).size, 1);

  // item sem variacao usa sufixo estavel "nv"
  const semVar = pedido({ item_list: [
    { item_id: 111, item_sku: "A", item_name: "A", model_discounted_price: 10, model_original_price: 10, model_quantity_purchased: 1 },
  ]});
  ok("34. item sem variacao usa sufixo estavel (nunca undefined na chave)",
     String(montar(semVar, "2026-07-24", "2026-07-24")[0]?.id).endsWith("_nv"));
}

console.log("\n=== F. dia atual: busca por update_time, exibicao por data_pagamento ===\n");
{
  // criado ontem, pago hoje — janela de busca = hoje
  const ontemPagoHoje = pedido({
    order_sn: "ONTEM01", order_status: "PROCESSED",
    create_time: epochBRT("2026-08-17", "22:10"),
    pay_time:    epochBRT("2026-08-18", "00:40"),
    update_time: epochBRT("2026-08-18", "00:40"),
  });
  const r1 = montar(ontemPagoHoje, "2026-08-18", "2026-08-18");
  ok("35. criado ontem e pago hoje entra na visao de hoje", r1.length === 1);
  eq("36. ...com data_pagamento = hoje", r1[0]?.data_pagamento, "2026-08-18");
  eq("37. ...e data_criacao preservada em ontem", r1[0]?.data_criacao, "2026-08-17");

  // criado hoje e pago hoje continua entrando
  const hojeHoje = pedido({
    order_sn: "HOJE01", order_status: "PROCESSED",
    create_time: epochBRT("2026-08-18", "09:00"),
    pay_time:    epochBRT("2026-08-18", "09:01"),
    update_time: epochBRT("2026-08-18", "09:01"),
  });
  const r2 = montar(hojeHoje, "2026-08-18", "2026-08-18");
  ok("38. criado hoje e pago hoje continua entrando", r2.length === 1);
  eq("39. ...com data_pagamento = hoje", r2[0]?.data_pagamento, "2026-08-18");

  // criado hoje e NAO pago: entra na base, mas sem data_pagamento
  const naoPago = pedido({
    order_sn: "NAOPAGO1", order_status: "UNPAID",
    create_time: epochBRT("2026-08-18", "10:00"),
    pay_time: undefined,
    update_time: epochBRT("2026-08-18", "10:00"),
  });
  const r3 = montar(naoPago, "2026-08-18", "2026-08-18");
  ok("40. criado hoje e nao pago ainda entra na base", r3.length === 1);
  eq("41. ...mas com data_pagamento NULL (nunca fallback para create_time)",
     r3[0]?.data_pagamento, null);
  eq("42. ...e status pending", r3[0]?.status, "pending");
  eq("43. ...com data_criacao preenchida (visao operacional preservada)",
     r3[0]?.data_criacao, "2026-08-18");
}

console.log("\n=== G. cancelado preserva pagamento ===\n");
{
  const cancelado = pedido({
    order_sn: "CANC01", order_status: "CANCELLED",
    create_time: epochBRT("2026-08-14", "08:00"),
    pay_time:    epochBRT("2026-08-14", "08:05"),
    update_time: epochBRT("2026-08-16", "15:00"),
    cancel_by: "buyer", cancel_reason: "CHANGE_MIND",
  });
  const r = montar(cancelado, "2026-08-14", "2026-08-14");
  ok("44. cancelado pago continua sendo gravado", r.length === 1);
  eq("45. cancelado preserva data_pagamento", r[0]?.data_pagamento, "2026-08-14");
  eq("46. cancelado mapeia para status cancelled", r[0]?.status, "cancelled");
  eq("47. cancelado preserva o motivo", r[0]?.cancel_reason, "CHANGE_MIND");

  // cancelado nunca pago: sem data_pagamento
  const canceladoSemPag = pedido({
    order_sn: "CANC02", order_status: "CANCELLED",
    create_time: epochBRT("2026-08-14", "08:00"), pay_time: undefined,
    update_time: epochBRT("2026-08-14", "09:00"),
  });
  eq("48. cancelado nunca pago fica com data_pagamento NULL",
     montar(canceladoSemPag, "2026-08-14", "2026-08-14")[0]?.data_pagamento, null);
}

console.log("\n=== H. regressao do caminho create_time (historico/backfill) ===\n");
{
  const ctxHist = { ...CTX_BASE, noBuffer: true };
  const montarHist = (order: any, de: string, ate: string) =>
    montarLinhasDoPedido(order, { ...ctxHist, dateFrom: de, dateTo: ate });

  // No historico o corte usa create_time, nao pay_time.
  const p = pedido({
    order_sn: "HIST01",
    create_time: epochBRT("2026-07-24", "11:00"),
    pay_time:    epochBRT("2026-07-26", "09:00"),
  });
  eq("49. historico corta pela data de CRIACAO (janela = dia da criacao)",
     montarHist(p, "2026-07-24", "2026-07-24").length, 1);
  eq("50. historico NAO usa pay_time para o corte",
     montarHist(p, "2026-07-26", "2026-07-26").length, 0);
  eq("51. historico preserva data_pagamento do pay_time mesmo assim",
     montarHist(p, "2026-07-24", "2026-07-24")[0]?.data_pagamento, "2026-07-26");
  eq("52. historico preserva data_criacao",
     montarHist(p, "2026-07-24", "2026-07-24")[0]?.data_criacao, "2026-07-24");
  eq("53. sem conjunto de recuperados, comportamento do historico e o de sempre",
     montarHist(pedido({ order_sn: "HIST02" }), "2026-07-24", "2026-07-24").length, 1);
}

console.log("\n=== I. pedido sem item_list nao e perdido ===\n");
{
  const semItens = pedido({ order_sn: "NOITEM1", item_list: [] });
  const r = montar(semItens, "2026-07-24", "2026-07-24");
  eq("54. pedido sem item_list gera 1 linha minima", r.length, 1);
  ok("55. ...com chave _NOITEM estavel", String(r[0]?.id).endsWith("_NOITEM"));
  eq("56. ...preservando data_pagamento", r[0]?.data_pagamento, "2026-07-24");

  const semItensRec = montar(semItens, "2026-07-27", "2026-07-27", new Set(["NOITEM1"]));
  eq("57. pedido sem item_list tambem e recuperavel", semItensRec.length, 1);
}

console.log("\n=== J. isolamento: nada fora de Shopee/pedidos ===\n");
{
  const r = montar(pedido(), "2026-07-24", "2026-07-24");
  eq("58. marketplace sempre Shopee", r[0]?.marketplace, "Shopee");
  ok("59. linha nao carrega nenhum campo de anuncio (sem risco de reativar soft-delete)",
     !("ativo" in r[0]) && !("anuncio_id" in r[0]));
  ok("60. montarLinhasDoPedido e pura: nao retorna promessa nem toca IO",
     Array.isArray(r) && !(r as any).then);
}

/**
 * Secao assincrona por ultimo: o transform CJS do tsx nao aceita top-level
 * await, entao ela roda dentro de uma funcao e o placar sai no .then().
 */
async function secaoAssincrona() {
  console.log("\n=== K. filtrarOrderSnsAusentes ===\n");

  const chamadas: string[][] = [];
  const existentesNoBanco = new Set(["A1", "A3"]);
  const consultor = async (lote: string[]) => {
    chamadas.push(lote);
    return lote.filter(sn => existentesNoBanco.has(sn));
  };
  eq("61. devolve apenas os que nao existem no banco",
     await filtrarOrderSnsAusentes("u1", ["A1", "A2", "A3", "A4"], consultor), ["A2", "A4"]);
  eq("62. uma unica consulta para lote pequeno", chamadas.length, 1);

  eq("63. lista vazia nao consulta o banco",
     await filtrarOrderSnsAusentes("u1", [], async () => { throw new Error("nao deveria consultar"); }), []);

  const chamadas2: string[][] = [];
  const muitos = Array.from({ length: 500 }, (_, i) => `S${i}`);
  const todosAusentes = await filtrarOrderSnsAusentes("u1", muitos, async (l) => { chamadas2.push(l); return []; });
  eq("64. 500 order_sn geram 3 consultas em lote", chamadas2.length, 3);
  eq("65. todos ausentes quando o banco nao tem nenhum", todosAusentes.length, 500);

  let propagou = false;
  try {
    await filtrarOrderSnsAusentes("u1", ["A1"], async () => { throw new Error("banco fora"); });
  } catch { propagou = true; }
  ok("66. erro de consulta LANCA (nunca vira 'esta ausente')", propagou);
}

secaoAssincrona().then(() => {
  console.log("\n" + "=".repeat(64));
  console.log(`  RESULTADO: ${passou} passaram, ${falhou} falharam (${passou + falhou} asserts)`);
  if (falhou) { console.log("  FALHAS:"); for (const f of falhas) console.log(`    - ${f}`); }
  console.log("=".repeat(64) + "\n");
  process.exit(falhou ? 1 : 0);
});
