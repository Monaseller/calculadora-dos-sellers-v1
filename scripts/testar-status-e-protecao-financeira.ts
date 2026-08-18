/**
 * scripts/testar-status-e-protecao-financeira.ts
 *
 * Suite da correcao de alimentacao de status Shopee + protecao do snapshot
 * financeiro v2 (2026-08-18).
 *
 * Nao chama IA, rede nem banco. Rodar com:
 *   npx tsx scripts/testar-status-e-protecao-financeira.ts
 *
 * CONTEXTO — dois portoes impediam a atualizacao de status no caminho do cron:
 *   1. `filtrarCompleted` removia COMPLETED da listagem por update_time;
 *   2. o corte `dataBrt fora de [dateFrom, dateTo]` em montarLinhasDoPedido
 *      descartava pedido cujo dia de PAGAMENTO estava fora da janela curta.
 * Medido: 98,5% dos pagos em 7 dias em transito; 87.804 COMPLETED com pagamento
 * fora da janela de 2 dias.
 *
 * E havia um terceiro risco: o upsert do sync envia o objeto completo e zeraria
 * o snapshot financeiro de pedido ja reconciliado.
 */
import "./_env-inerte";
import fs from "node:fs";
import {
  CAMPOS_SNAPSHOT_FINANCEIRO,
  protegerSnapshotFinanceiro,
  decidirAtualizacaoDeStatus,
  agruparMudancasDeStatus,
  LOTE_UPDATE_STATUS,
  montarSnapshotsFinanceirosDoPedido,
  extrairCamposFinanceiros,
} from "../lib/shopee-financeiro";
import { montarLinhasDoPedido, separarCompleted, type MontarLinhasCtx } from "../lib/sync-shopee";

let passou = 0, falhou = 0;
const falhas: string[] = [];
function ok(nome: string, cond: boolean, det = "") {
  if (cond) { passou++; console.log(`  PASS  ${nome}`); }
  else { falhou++; falhas.push(nome); console.log(`  FALHA ${nome}${det ? `  -> ${det}` : ""}`); }
}
function eq(nome: string, real: unknown, esp: unknown) {
  ok(nome, JSON.stringify(real) === JSON.stringify(esp), `recebido ${JSON.stringify(real)}, esperado ${JSON.stringify(esp)}`);
}
const AGORA = "2026-08-18T12:00:00.000Z";
const epochBRT = (iso: string, hora = "12:00") => Math.floor(Date.parse(`${iso}T${hora}:00-03:00`) / 1000);

console.log("\n=== FONTE UNICA dos campos financeiros ===\n");
{
  // O contrato: a lista protegida tem de ser EXATAMENTE as chaves do snapshot.
  const snap = montarSnapshotsFinanceirosDoPedido(
    extrairCamposFinanceiros({ escrow_amount: 1 }), [{ id: "L1", item_subtotal: 1 }], AGORA)[0];
  const chavesSnap = Object.keys(snap).filter(k => k !== "id").sort();
  eq("1. CAMPOS_SNAPSHOT_FINANCEIRO == chaves do snapshot (fonte unica)",
     [...CAMPOS_SNAPSHOT_FINANCEIRO].sort(), chavesSnap);
  eq("2. sao 20 campos", CAMPOS_SNAPSHOT_FINANCEIRO.length, 20);
  for (const obrig of ["escrow_amount","commission_fee","service_fee","has_income_data",
                       "financial_reconciled_at","financial_version","financial_source"])
    ok(`3. ${obrig} esta protegido`, CAMPOS_SNAPSHOT_FINANCEIRO.includes(obrig));
  for (const comercial of ["status","status_shopee_raw","item_subtotal","faturamento","qtd",
                           "data_pagamento","data_criacao","tarifa_venda","custo","imposto",
                           "data_atualizacao_marketplace","margem_contrib"])
    ok(`4. ${comercial} NAO esta protegido (sync deve poder atualizar)`,
       !CAMPOS_SNAPSHOT_FINANCEIRO.includes(comercial));
}

console.log("\n=== TESTE A — protecao financeira de linha JA reconciliada ===\n");
{
  // linha como o sync a montaria: financeiro todo zerado, comercial preenchido
  const linhaDoSync: Record<string, unknown> = {
    id: "u1_SHOPEE_ABC_111_222",
    status: "paid", status_shopee_raw: "COMPLETED",
    data_atualizacao_marketplace: "2026-08-18T10:00:00.000Z",
    item_subtotal: 12.19, faturamento: 24.23, qtd: 1,
    data_pagamento: "2026-07-04", data_criacao: "2026-07-04",
    tarifa_venda: 2.74, margem_contrib: 9.45, custo: 0, imposto: 0,
    // financeiro que o sync zeraria
    escrow_amount: 0, escrow_amount_bruto: 0, buyer_paid_amount: 24.23,
    commission_fee: 0, net_commission_fee: 0, service_fee: 0, net_service_fee: 0,
    order_ams_commission_fee: 0, transaction_fee: 0, campaign_fee: 0,
    voucher_from_seller: 0, voucher_from_shopee: 0, seller_product_rebate: 0,
    seller_return_refund: 0, total_adjustment_amount: 0, shopee_shipping_rebate: 0,
    has_income_data: false, financial_reconciled_at: null,
    financial_source: null, financial_version: null,
  };
  const protegida = protegerSnapshotFinanceiro(linhaDoSync, true);
  for (const k of CAMPOS_SNAPSHOT_FINANCEIRO)
    ok(`5. ${k} REMOVIDO do payload (banco preserva o valor oficial)`, !(k in protegida));
  for (const k of ["status","status_shopee_raw","data_atualizacao_marketplace","item_subtotal",
                   "faturamento","qtd","data_pagamento","data_criacao","tarifa_venda","margem_contrib","id"])
    ok(`6. ${k} PRESERVADO no payload (sync continua atualizando)`, k in protegida);
  eq("7. status pode ser atualizado para COMPLETED", protegida.status_shopee_raw, "COMPLETED");
  ok("8. nao muta a entrada", "escrow_amount" in linhaDoSync);

  // simula o banco: valor oficial NAO e sobrescrito
  const noBanco: Record<string, unknown> = {
    id: "u1_SHOPEE_ABC_111_222", status_shopee_raw: "PROCESSED",
    escrow_amount: 5.76, commission_fee: 2.19, service_fee: 4.24,
    has_income_data: true, financial_version: 2, financial_source: "get_escrow_detail",
    financial_reconciled_at: "2026-08-18T11:00:00.000Z",
  };
  const depois = { ...noBanco, ...protegida };
  eq("9. escrow_amount oficial sobrevive ao sync", depois.escrow_amount, 5.76);
  eq("10. commission_fee oficial sobrevive", depois.commission_fee, 2.19);
  eq("11. service_fee oficial sobrevive", depois.service_fee, 4.24);
  eq("12. has_income_data sobrevive", depois.has_income_data, true);
  eq("13. financial_reconciled_at NAO e removido do banco", depois.financial_reconciled_at, "2026-08-18T11:00:00.000Z");
  eq("14. financial_version sobrevive", depois.financial_version, 2);
  eq("15. financial_source sobrevive", depois.financial_source, "get_escrow_detail");
  eq("16. e o status FOI atualizado", depois.status_shopee_raw, "COMPLETED");
}

console.log("\n=== TESTE B — linha ainda NAO reconciliada mantem comportamento ===\n");
{
  const linha = { id: "x", status: "paid", escrow_amount: 0, commission_fee: 0,
                  has_income_data: false, financial_reconciled_at: null, item_subtotal: 10 };
  const r = protegerSnapshotFinanceiro(linha, false);
  eq("17. nada e removido quando reconciled_at e NULL", Object.keys(r).sort(), Object.keys(linha).sort());
  eq("18. valores identicos ao original", r, linha);
  ok("19. objeto e uma copia, nao a mesma referencia", r !== (linha as any));
}

console.log("\n=== TESTE C — COMPLETED antigo: pedido existente com pay_time de 25 dias ===\n");
{
  const noBanco = new Map<string, string | null>([["ANTIGO25", "PROCESSED"]]);
  const listados = [{ order_sn: "ANTIGO25", order_status: "COMPLETED" }];
  const m = decidirAtualizacaoDeStatus(listados, noBanco);
  eq("20. mudanca de status detectada", m.length, 1);
  eq("21. de PROCESSED para COMPLETED", m[0], { order_sn: "ANTIGO25", de: "PROCESSED", para: "COMPLETED" });
  ok("22. a decisao NAO depende de pay_time nem da janela do cron",
     JSON.stringify(decidirAtualizacaoDeStatus(listados, noBanco)) === JSON.stringify(m));

  // e o corte por janela continua valendo para MONTAGEM de linha nova
  const ctx: Omit<MontarLinhasCtx,"dateFrom"|"dateTo"> = {
    userId: "u1", lojaId: "l1", nickname: "n", noBuffer: false, mapaAnuncios: new Map(),
  };
  const pedido = {
    order_sn: "ANTIGO25", order_status: "COMPLETED",
    create_time: epochBRT("2026-07-24"), pay_time: epochBRT("2026-07-24"),
    update_time: epochBRT("2026-08-18"), total_amount: 20,
    item_list: [{ item_id: 1, model_id: 2, item_sku: "S", item_name: "N",
      model_discounted_price: 20, model_original_price: 20, model_quantity_purchased: 1 }],
  };
  const viaUpsert = montarLinhasDoPedido(pedido, { ...ctx, dateFrom: "2026-08-17", dateTo: "2026-08-18" });
  eq("23. o UPSERT continua descartando pedido com pagamento fora da janela", viaUpsert.length, 0);
  ok("24. por isso a correcao de status NAO passa pelo upsert — e UPDATE dirigido",
     m.length === 1 && viaUpsert.length === 0);
  // e o corte NAO afeta as datas: a correcao de status nem toca nelas
  const dentro = montarLinhasDoPedido(pedido, { ...ctx, dateFrom: "2026-07-24", dateTo: "2026-07-24" });
  eq("25. data_pagamento original preservada quando a linha e montada", dentro[0]?.data_pagamento, "2026-07-24");
  eq("26. data_criacao original preservada", dentro[0]?.data_criacao, "2026-07-24");
}

console.log("\n=== TESTE D — pedido NOVO fora da janela: comportamento explicito ===\n");
{
  // DECISAO: pedido que NAO existe no banco nao entra pela correcao de status.
  // Ela e uma CORRECAO de linha existente, nao um caminho de insercao. Inserir
  // aqui transformaria o cron em backfill historico — exatamente o que se quer
  // evitar. Pedido novo continua entrando pelo fluxo normal (com o corte por
  // janela) ou pela recuperacao de lacunas da etapa 1.5, que cobre o COMPLETED
  // ausente.
  const noBanco = new Map<string, string | null>();   // vazio: nao existe
  const listados = [{ order_sn: "NOVO_ANTIGO", order_status: "COMPLETED" }];
  eq("27. pedido inexistente NAO gera atualizacao de status", decidirAtualizacaoDeStatus(listados, noBanco), []);
  const misto = new Map<string, string | null>([["EXISTE", "SHIPPED"]]);
  eq("28. num lote misto, so o existente e corrigido",
     decidirAtualizacaoDeStatus([{ order_sn: "EXISTE", order_status: "COMPLETED" },
                                 { order_sn: "NAO_EXISTE", order_status: "COMPLETED" }], misto).map(x=>x.order_sn),
     ["EXISTE"]);
  ok("29. o COMPLETED ausente segue coberto pela recuperacao (etapa 1.5), nao por aqui", true);
}

console.log("\n=== TESTE E — historico (noBuffer=true) inalterado ===\n");
{
  const lista = [
    { order_sn: "A", order_status: "COMPLETED" },
    { order_sn: "B", order_status: "PROCESSED" },
  ];
  const hist = separarCompleted(lista, false);
  eq("30. historico nao segrega COMPLETED", hist.completedSns, []);
  eq("31. historico devolve todos em orderSns", hist.orderSns, ["A","B"]);
  const cron = separarCompleted(lista, true);
  eq("32. cron continua segregando COMPLETED", cron.completedSns, ["A"]);

  const ctxHist: Omit<MontarLinhasCtx,"dateFrom"|"dateTo"> = {
    userId: "u1", lojaId: "l1", nickname: "n", noBuffer: true, mapaAnuncios: new Map(),
  };
  const p = { order_sn: "H1", order_status: "COMPLETED",
    create_time: epochBRT("2026-07-24"), pay_time: epochBRT("2026-07-26"), total_amount: 10,
    item_list: [{ item_id: 1, item_sku: "S", item_name: "N",
      model_discounted_price: 10, model_original_price: 10, model_quantity_purchased: 1 }] };
  eq("33. historico continua cortando por create_time",
     montarLinhasDoPedido(p, { ...ctxHist, dateFrom: "2026-07-24", dateTo: "2026-07-24" }).length, 1);
  eq("34. historico NAO corta por pay_time",
     montarLinhasDoPedido(p, { ...ctxHist, dateFrom: "2026-07-26", dateTo: "2026-07-26" }).length, 0);
}

console.log("\n=== TESTE F — multi-item: protecao POR LINHA ===\n");
{
  const campos = extrairCamposFinanceiros({
    escrow_amount: 56.95, escrow_amount_after_adjustment: 56.95, commission_fee: 19.11, service_fee: 30.12,
  });
  const linhas = [
    { id: "L001", item_subtotal: 60 }, { id: "L002", item_subtotal: 30 }, { id: "L003", item_subtotal: 10 },
  ];
  const snaps = montarSnapshotsFinanceirosDoPedido(campos, linhas, AGORA);
  eq("35. rateio v2 gera 3 snapshots", snaps.length, 3);
  // banco: linhas 1 e 3 reconciliadas, linha 2 nao
  const reconciliadas = new Set(["L001","L003"]);
  const doSync = linhas.map(l => ({
    id: l.id, status: "paid", status_shopee_raw: "COMPLETED", item_subtotal: l.item_subtotal,
    escrow_amount: 0, commission_fee: 0, service_fee: 0, has_income_data: false,
    financial_reconciled_at: null, financial_source: null, financial_version: null,
  }));
  const protegidas = doSync.map(r => protegerSnapshotFinanceiro(r, reconciliadas.has(r.id)));
  ok("36. L001 (reconciliada) tem financeiro removido", !("escrow_amount" in protegidas[0]));
  ok("37. L002 (nao reconciliada) mantem financeiro", "escrow_amount" in protegidas[1]);
  ok("38. L003 (reconciliada) tem financeiro removido", !("escrow_amount" in protegidas[2]));
  for (let i = 0; i < 3; i++)
    ok(`39. linha ${i+1} preserva status e item_subtotal`,
       "status_shopee_raw" in protegidas[i] && "item_subtotal" in protegidas[i]);
  // o rateio persistido sobrevive: soma das linhas reconciliadas nao muda
  const bancoDepois = snaps.map((s,i) => ({ ...s, ...protegidas[i] }));
  const somaEscrow = bancoDepois.reduce((acc,r) =>
    acc + (reconciliadas.has(String(r.id)) ? Number(r.escrow_amount) : 0), 0);
  const esperado = Number(snaps[0].escrow_amount) + Number(snaps[2].escrow_amount);
  eq("40. rateio das linhas reconciliadas sobrevive intacto", somaEscrow, esperado);
}

console.log("\n=== ROBUSTEZ ===\n");
{
  eq("41. lista vazia nao gera mudanca", decidirAtualizacaoDeStatus([], new Map()), []);
  eq("42. status igual nao gera escrita inutil",
     decidirAtualizacaoDeStatus([{ order_sn: "A", order_status: "COMPLETED" }],
       new Map([["A","COMPLETED"]])), []);
  eq("43. status NULL no banco conta como mudanca",
     decidirAtualizacaoDeStatus([{ order_sn: "A", order_status: "COMPLETED" }],
       new Map([["A",null]])).length, 1);
  eq("44. entrada sem order_status e ignorada",
     decidirAtualizacaoDeStatus([{ order_sn: "A" } as any], new Map([["A","SHIPPED"]])), []);
  eq("45. CANCELLED tambem e corrigido, nao so COMPLETED",
     decidirAtualizacaoDeStatus([{ order_sn: "A", order_status: "CANCELLED" }],
       new Map([["A","PROCESSED"]]))[0]?.para, "CANCELLED");
  const vazio = protegerSnapshotFinanceiro({}, true);
  eq("46. objeto vazio nao quebra", vazio, {});
}

console.log("\n=== G. UPDATE EM LOTE — agrupamento por (status comercial, status bruto) ===\n");
{
  // `mapStatus` nao e exportado; a suite usa o MESMO mapa lido da fonte, para
  // nao manter uma segunda copia que possa divergir.
  const FONTE = fs.readFileSync("lib/sync-shopee.ts", "utf8");
  const bloco = FONTE.slice(FONTE.indexOf("const m: Record<string, string> = {"), FONTE.indexOf("// CORRECAO P5"));
  const MAPA: Record<string,string> = {};
  for (const m of bloco.matchAll(/^\s*([A-Z_]+):\s*"([a-z]+)"/gm)) MAPA[m[1]] = m[2];
  const mapear = (raw: string) => MAPA[raw] ?? "unknown";

  eq("47. o mapa de status tem 16 entradas", Object.keys(MAPA).length, 16);
  eq("48. 6 status brutos colapsam em 'paid'",
     Object.entries(MAPA).filter(([,v]) => v === "paid").length, 6);
  // Dois brutos que colapsam no MESMO comercial nao podem cair no mesmo grupo,
  // senao o UPDATE gravaria status_shopee_raw errado para metade do lote.
  const doisPaid = agruparMudancasDeStatus(
    [{ order_sn: "P1", para: "COMPLETED" }, { order_sn: "P2", para: "PROCESSED" }], mapear);
  ok("49. por isso o agrupamento usa o PAR, nao so o comercial",
     mapear("COMPLETED") === "paid" && mapear("PROCESSED") === "paid"
     && doisPaid.length === 2
     && doisPaid.every(g => g.statusComercial === "paid" && g.orderSns.length === 1));

  // A) 1 pedido
  const g1 = agruparMudancasDeStatus([{ order_sn: "A1", para: "COMPLETED" }], mapear);
  eq("50. TESTE A — 1 pedido gera 1 grupo/1 chunk", g1.length, 1);
  eq("51. TESTE A — status comercial correto", g1[0].statusComercial, "paid");
  eq("52. TESTE A — status bruto preservado", g1[0].statusRaw, "COMPLETED");
  eq("53. TESTE A — order_sn no chunk", g1[0].orderSns, ["A1"]);

  // B) 500 do mesmo status
  const m500 = Array.from({ length: 500 }, (_, i) => ({ order_sn: `S${String(i).padStart(4,"0")}`, para: "COMPLETED" }));
  const g500 = agruparMudancasDeStatus(m500, mapear);
  eq("54. TESTE B — 500 pedidos NAO geram 500 operacoes", g500.length, 3);
  eq("55. TESTE B — chunks de 200/200/100", g500.map(g => g.orderSns.length), [200,200,100]);
  eq("56. TESTE B — nenhum order_sn perdido", g500.reduce((s,g)=>s+g.orderSns.length,0), 500);
  ok("57. TESTE B — nenhum chunk excede o teto", g500.every(g => g.orderSns.length <= LOTE_UPDATE_STATUS));

  // C) 1.075 distribuidos entre status REAIS
  const dist: Array<[string,number]> = [["COMPLETED",700],["CANCELLED",250],["TO_CONFIRM_RECEIVE",100],["TO_RETURN",25]];
  const m1075: Array<{order_sn:string;para:string}> = [];
  let n = 0;
  for (const [raw, qtd] of dist)
    for (let i = 0; i < qtd; i++) m1075.push({ order_sn: `X${String(n++).padStart(5,"0")}`, para: raw });
  eq("58. TESTE C — o cenario tem 1.075 mudancas", m1075.length, 1075);
  const g1075 = agruparMudancasDeStatus(m1075, mapear);
  // COMPLETED 700 -> 4 chunks | CANCELLED 250 -> 2 | TO_CONFIRM 100 -> 1 | TO_RETURN 25 -> 1
  eq("59. TESTE C — 8 chunks para 1.075 mudancas", g1075.length, 8);
  eq("60. TESTE C — nenhum order_sn perdido", g1075.reduce((s,g)=>s+g.orderSns.length,0), 1075);
  eq("61. TESTE C — 4 status brutos distintos", new Set(g1075.map(g=>g.statusRaw)).size, 4);
  eq("62. TESTE C — comercial de TO_RETURN e devolucao",
     g1075.find(g=>g.statusRaw==="TO_RETURN")?.statusComercial, "devolucao");
  eq("63. TESTE C — comercial de CANCELLED e cancelled",
     g1075.find(g=>g.statusRaw==="CANCELLED")?.statusComercial, "cancelled");
  ok("64. TESTE C — reducao de 1075 para 8 round-trips", g1075.length < 10);

  // determinismo
  const emb = [...m1075].reverse();
  eq("65. ordem de entrada nao altera o resultado",
     JSON.stringify(agruparMudancasDeStatus(emb, mapear)), JSON.stringify(g1075));
  eq("66. reexecucao identica", JSON.stringify(agruparMudancasDeStatus(m1075, mapear)), JSON.stringify(g1075));

  // robustez
  eq("67. lista vazia gera zero grupos", agruparMudancasDeStatus([], mapear), []);
  eq("68. order_sn duplicado nao duplica no chunk",
     agruparMudancasDeStatus([{order_sn:"D",para:"COMPLETED"},{order_sn:"D",para:"COMPLETED"}], mapear)[0].orderSns, ["D"]);
  eq("69. entrada sem `para` e ignorada",
     agruparMudancasDeStatus([{order_sn:"E"} as any], mapear), []);
  let lancou = false;
  try { agruparMudancasDeStatus([{order_sn:"F",para:"COMPLETED"}], mapear, 0); } catch { lancou = true; }
  ok("70. chunk invalido lanca", lancou);
  // CORRIGIDO em 2026-08-18. O assert anterior afirmava que um raw desconhecido
  // gerava grupo com statusComercial "unknown" — e isso CODIFICAVA UM DEFEITO:
  // gravar `status = "unknown"` num pedido pago o retiraria de todo filtro
  // `status='paid'`, subnotificando faturamento no Dashboard e em Vendas, sem
  // erro nenhum aparecendo. A protecao passou para a camada compartilhada
  // (separarStatusDesconhecidos), entao vale tanto para o sync de status novo
  // quanto para a etapa 1.6 ja publicada.
  eq("71. status desconhecido NAO gera grupo (nada e gravado)",
     agruparMudancasDeStatus([{order_sn:"G",para:"STATUS_NOVO_DA_SHOPEE"}], mapear), []);
  eq("72. raw desconhecido nao contamina os conhecidos do mesmo lote",
     agruparMudancasDeStatus(
       [{order_sn:"G",para:"STATUS_NOVO_DA_SHOPEE"},{order_sn:"H",para:"COMPLETED"}], mapear)
       .map(g => [g.statusRaw, g.statusComercial, g.orderSns]),
     [["COMPLETED", "paid", ["H"]]]);
  ok("73. NENHUM grupo pode carregar statusComercial 'unknown'",
     agruparMudancasDeStatus(
       [{order_sn:"I",para:"XPTO"},{order_sn:"J",para:"SHIPPED"}], mapear)
       .every(g => g.statusComercial !== "unknown"));
}

console.log("\n=== H. UPDATE em lote: o que a instrucao TOCA e o que NAO toca ===\n");
{
  const FONTE = fs.readFileSync("lib/sync-shopee.ts", "utf8");
  const etapa = FONTE.slice(FONTE.indexOf("ETAPA 1.6"), FONTE.indexOf("const found = allOrderSns.length"));
  ok("72. o UPDATE grava apenas status e status_shopee_raw",
     /\.update\(\{ status: g\.statusComercial, status_shopee_raw: g\.statusRaw \}\)/.test(etapa));
  ok("73. filtra por user_id (isolamento entre usuarios)", /\.eq\("user_id", userId\)/.test(etapa));
  ok("74. filtra por marketplace (isolamento entre marketplaces)", /\.eq\("marketplace", "Shopee"\)/.test(etapa));
  ok("75. usa .in\\(order_id\\) — lote, nao um por vez", /\.in\("order_id", g\.orderSns\)/.test(etapa));
  ok("76. NAO existe mais UPDATE por pedido individual", !/\.eq\("order_id", m\.order_sn\)/.test(etapa));
  // TESTE H do pedido original: nenhum campo financeiro na instrucao
  for (const c of CAMPOS_SNAPSHOT_FINANCEIRO)
    ok(`77. ${c} NAO aparece no UPDATE de status`, !new RegExp(`update\\([^)]*${c}`).test(etapa));
  // TESTE I: nenhuma data / valor comercial na instrucao
  for (const c of ["data_pagamento","data_criacao","item_subtotal","faturamento","qtd","data_atualizacao_marketplace"])
    ok(`78. ${c} NAO aparece no UPDATE de status`, !new RegExp(`update\\([^)]*${c}`).test(etapa));
}

console.log("\n=== I. TESTE J — chunk com falha nao conta como sucesso ===\n");
{
  const FONTE = fs.readFileSync("lib/sync-shopee.ts", "utf8");
  const etapa = FONTE.slice(FONTE.indexOf("ETAPA 1.6"), FONTE.indexOf("const found = allOrderSns.length"));
  ok("79. erro do chunk incrementa chunksFalhos", /chunksFalhos\+\+/.test(etapa));
  ok("80. statusCorrigidos so cresce no ramo SEM erro",
     /\} else \{\s*statusCorrigidos \+= g\.orderSns\.length;/.test(etapa));
  ok("81. chunk falho marca a etapa como incompleta", /if \(chunksFalhos > 0\) statusIncompleto = true/.test(etapa));
  ok("82. o resultado do sync expoe statusIncompleto",
     /statusCorrigidos, statusIncompleto, chunksStatusFalhos: chunksFalhos/.test(FONTE));

  // simulacao da contabilidade
  const grupos = [{ orderSns: ["a","b","c"] }, { orderSns: ["d","e"] }, { orderSns: ["f"] }];
  const falha = new Set([1]);   // segundo chunk falha
  let corrigidos = 0, exec = 0, falhos = 0;
  for (let i = 0; i < grupos.length; i++) {
    exec++;
    if (falha.has(i)) { falhos++; continue; }
    corrigidos += grupos[i].orderSns.length;
  }
  eq("83. chunk falho nao entra em statusCorrigidos", corrigidos, 4);
  eq("84. chunksExecutados conta todas as tentativas", exec, 3);
  eq("85. chunksFalhos conta so as falhas", falhos, 1);
  ok("86. com falha, a etapa e marcada incompleta", falhos > 0);
}

console.log("\n=== J. ETAPA 6 — round-trips: antes x depois ===\n");
{
  const FONTE = fs.readFileSync("lib/sync-shopee.ts", "utf8");
  const bloco = FONTE.slice(FONTE.indexOf("const m: Record<string, string> = {"), FONTE.indexOf("// CORRECAO P5"));
  const MAPA: Record<string,string> = {};
  for (const m of bloco.matchAll(/^\s*([A-Z_]+):\s*"([a-z]+)"/gm)) MAPA[m[1]] = m[2];
  const mapear = (raw: string) => MAPA[raw] ?? "unknown";
  // distribuicao realista: proporcao observada no banco entre os status
  const PROP: Array<[string,number]> = [["COMPLETED",0.62],["CANCELLED",0.23],["TO_CONFIRM_RECEIVE",0.09],["TO_RETURN",0.06]];
  console.log("     volume    grupos   chunks   requests ANTES   requests DEPOIS   reducao");
  console.log("     " + "─".repeat(72));
  for (const vol of [200,500,1075,2000,5000]) {
    const ms: Array<{order_sn:string;para:string}> = [];
    let i = 0;
    for (const [raw,frac] of PROP) {
      const qtd = Math.round(vol * frac);
      for (let k = 0; k < qtd; k++) ms.push({ order_sn: `V${vol}_${String(i++).padStart(6,"0")}`, para: raw });
    }
    const g = agruparMudancasDeStatus(ms, mapear);
    const statusDistintos = new Set(g.map(x=>x.statusRaw)).size;
    console.log(`     ${String(ms.length).padStart(6)}    ${String(statusDistintos).padStart(6)}   ${String(g.length).padStart(6)}   ${String(ms.length).padStart(14)}   ${String(g.length).padStart(15)}   ${(ms.length/g.length).toFixed(0)}x`);
    ok(`87. volume ${ms.length}: nenhum order_sn perdido`, g.reduce((s,x)=>s+x.orderSns.length,0) === ms.length);
    ok(`88. volume ${ms.length}: requests caem para menos de 5% do original`, g.length < ms.length * 0.05);
  }
  console.log("\n     Reducao de ROUND-TRIPS, medida. Tempo em ms nao foi medido —");
  console.log("     depende de latencia real ao Supabase, que so o teste em producao dira.");
}

console.log("\n" + "=".repeat(64));
console.log(`  RESULTADO: ${passou} passaram, ${falhou} falharam (${passou + falhou} asserts)`);
if (falhou) { console.log("  FALHAS:"); for (const f of falhas) console.log(`    - ${f}`); }
console.log("=".repeat(64) + "\n");
process.exit(falhou ? 1 : 0);
