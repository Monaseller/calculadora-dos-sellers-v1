/**
 * CDS V2 — Vendas A3.2-B: financeiro REAL do Mercado Livre (pedido + envio) e o contrato da migration
 * supabase/migrations/20261115_ml_financeiro.sql (NÃO aplicada).
 *
 * Venda golden auditada no provider (respostas SANITIZADAS — só ids e valores, nada do comprador):
 *   pack 2000015516685373 → order 2000018971279352, item MLB3710315405, shipment 48253763834
 *   41,24 − 4,19 (sale_fee LÍQUIDA) − 6,95 (senders[].cost) = 30,10
 *   rebate 0,76 (já na tarifa) e desconto do vendedor 0,52 (já no preço) NÃO entram de novo.
 *
 * Coletor exercitado com provider FALSO (nenhuma rede): só GET, envio buscado 1× por shipment, billing 429 →
 * PENDENTE (nunca ACTUAL). Guard: I17_ML_FINANCIAL_RECONCILIATION_IS_REAL.
 *
 * Uso: npx tsx scripts/testar-vendas-ml-financeiro.ts
 */
import "./_server-only-inerte";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let ok = 0, falhou = 0;
let fila: Promise<void> = Promise.resolve();
const imprimir = console.log.bind(console);
function t(nome: string, fn: () => void | Promise<void>) {
  fila = fila.then(async () => {
    try { await fn(); ok++; imprimir(`  PASS  ${nome}`); }
    catch (e: any) { falhou++; imprimir(`  FALHA ${nome} -> ${e?.message ?? e}`); }
  });
}
function secao(s: string) { fila = fila.then(() => { imprimir(s); }); }
function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const c = (v: number | null | undefined) => (v == null ? null : Math.round(v * 100));

// ── fixtures sanitizadas (formato das respostas reais do provider) ─────────────
const PACK = "2000015516685373", ORDER = "2000018971279352", ITEM = "MLB3710315405", SHIP = "48253763834";
const ORDER_GOLDEN = {
  id: Number(ORDER), status: "paid", pack_id: Number(PACK), total_amount: 41.24, paid_amount: 41.24, shipping: { id: Number(SHIP) },
  order_items: [{ item: { id: ITEM, variation_id: null }, quantity: 1, unit_price: 41.24, full_unit_price: null, sale_fee: 4.19 }],
  payments: [{ status: "approved", transaction_amount: 41.24, shipping_cost: 0, marketplace_fee: 0 }],
};
const DESCONTOS_GOLDEN = { details: [{ type: "discount", items: [{ id: ITEM, amounts: { seller: 0.52, total: 1.28 } }], supplier: { funding_mode: "sale_fee" } }] };
const CUSTOS_GOLDEN = { gross_amount: 16.92, receiver: { cost: 6.99, compensation: 0 }, senders: [{ cost: 6.95, compensation: 0, discounts: [{ type: "mandatory", promoted_amount: 2.98 }] }] };
const PACK_GOLDEN = { id: Number(PACK), orders: [{ id: Number(ORDER) }], shipment: { id: Number(SHIP) } };
const billing = (orderIds: string[]) => ({ results: [{ details: orderIds.flatMap((o) => [
  { charge_info: { detail_type: "CHARGE", detail_sub_type: "CVVML", detail_amount: o === ORDER ? 4.16 : 4.0 }, sales_info: [{ order_id: Number(o) }] },
  { charge_info: { detail_type: "CHARGE", detail_sub_type: "CVVPRC", detail_amount: o === ORDER ? 0.03 : 0.19 }, sales_info: [{ order_id: Number(o) }] },
]) }] });

async function principal() {
  const F = await import("../lib/vendas/ml-financeiro");
  const K = await import("../lib/vendas/ml-financeiro-coleta");
  const S = await import("../lib/vendas/custo-produto");
  const V = await import("../app/(app)/vendas/codigos-venda");
  const G2 = await import("./_guard-v2");

  const golden = () => {
    const p = F.extrairPedidoFinanceiroML(ORDER_GOLDEN, DESCONTOS_GOLDEN);
    const b = F.conferirBillingML(ORDER, p.tarifa_venda, 200, billing([ORDER]));
    return { pedido: { ...p, ...b }, envio: F.extrairEnvioFinanceiroML(SHIP, PACK, CUSTOS_GOLDEN, [ORDER]) };
  };
  const ref = { anuncioId: "an", marketplace: "ML" as const, lojaId: "l", itemId: ITEM, variacaoId: null, exata: true };
  const comCusto = (custo: number, imposto = 0) => ({ status: "PRODUCT_FOUND_WITH_COST" as const, produto: { id: "an", custo_produto: custo, imposto, insumos: 0 } as any, ref });
  const vendaLinha = (extra: Record<string, unknown> = {}) => ({ marketplace: "ML", ml_item_id: ITEM, variation_id: null, qtd: 1, faturamento: 41.24, tarifa_venda: 4.19, ...extra });

  secao("\n[1. venda golden — líquido real sem dupla contagem]");
  t("FIN2-1. golden: 41,24 − 4,19 − 6,95 = 30,10, ACTUAL (billing conferido 4,16 + 0,03)", () => {
    const g = golden();
    const l = F.liquidoPedidoML(g.pedido, g.envio);
    assert(c(g.pedido.receita_produto) === 4124 && c(g.pedido.tarifa_venda) === 419 && g.pedido.tarifa_origem === "PROVIDER", JSON.stringify(g.pedido));
    assert(g.pedido.billing_status === "CONFERIDO" && c(g.pedido.billing_tarifa) === 419, `billing ${g.pedido.billing_status} ${g.pedido.billing_tarifa}`);
    assert(c(l.liquido) === 3010 && l.qualidade === "ACTUAL" && l.motivo === "ok", JSON.stringify(l));
  });
  t("FIN2-2. rebate 0,76 (desconto ML, funding sale_fee) registrado mas NÃO somado de novo", () => {
    const g = golden(); const l = F.liquidoPedidoML(g.pedido, g.envio);
    assert(c(g.pedido.desconto_meli) === 76, `desconto_meli ${g.pedido.desconto_meli}`);
    assert(c(l.liquido) !== 3086, "rebate somado de novo (30,86)");
  });
  t("FIN2-3. desconto do vendedor 0,52 registrado mas NÃO subtraído de novo", () => {
    const g = golden(); const l = F.liquidoPedidoML(g.pedido, g.envio);
    assert(c(g.pedido.desconto_vendedor) === 52 && c(l.liquido) !== 2958, `desconto ${g.pedido.desconto_vendedor} líquido ${l.liquido}`);
  });
  t("FIN2-4. frete do vendedor = Σ senders[].cost (6,95)", () => {
    const g = golden();
    assert(c(g.envio.frete_vendedor) === 695 && c(F.liquidoPedidoML(g.pedido, g.envio).freteVendedor) === 695, JSON.stringify(g.envio));
  });
  t("FIN2-5. receiver.cost 6,99 (comprador) guardado como referência, NUNCA subtraído do vendedor", () => {
    const g = golden(); const l = F.liquidoPedidoML(g.pedido, g.envio);
    assert(c(g.envio.frete_comprador) === 699 && c(l.liquido) !== 2311 && c(l.liquido) !== 1616, `líquido ${l.liquido}`);
  });
  t("FIN2-6. gross_amount 16,92 só referência — nunca custo do vendedor", () => {
    const g = golden(); const l = F.liquidoPedidoML(g.pedido, g.envio);
    assert(c(g.envio.frete_bruto_referencia) === 1692 && c(l.liquido) !== 2013 && c(l.freteVendedor) !== 1692, `líquido ${l.liquido}`);
  });

  secao("\n[2. código da venda]");
  t("FIN2-7. ML em pack: código exibido = pack_id (o do painel)", () => {
    assert(V.codigoVenda({ marketplace: "ML", orderId: ORDER, packId: PACK }) === PACK, "pack não exibido");
  });
  t("FIN2-8. ML sem pack: order_id; Shopee: order_sn (pack ignorado)", () => {
    assert(V.codigoVenda({ marketplace: "ML", orderId: ORDER, packId: null }) === ORDER, "sem pack");
    assert(V.codigoVenda({ marketplace: "Shopee", orderId: "2410ABC", packId: PACK }) === "2410ABC", "Shopee usou pack");
  });

  secao("\n[3. proveniência da tarifa]");
  t("FIN2-9. tarifa do provider marcada real (pedido PROVIDER; linha nova 'PROVIDER' → real)", () => {
    assert(golden().pedido.tarifa_origem === "PROVIDER", "pedido sem proveniência");
    const f = S.financeiroDaVenda(vendaLinha({ tarifa_origem: "PROVIDER" }), comCusto(10));
    assert(f.tarifaOrigem === "real" && f.qualidadeFinanceira === "ESTIMATED", `${f.tarifaOrigem}/${f.qualidadeFinanceira}`);
  });
  t("FIN2-10. estimativa marcada: linha 'ESTIMATE' → estimada (por unidade × qtd, sem dupla); item sem sale_fee → AUSENTE/PENDING", () => {
    const f = S.financeiroDaVenda(vendaLinha({ tarifa_origem: "ESTIMATE", qtd: 2, faturamento: 82.48, tarifa_venda: 5 }), comCusto(10));
    assert(f.tarifaOrigem === "estimada" && c(f.tarifa) === 1000, `${f.tarifaOrigem} ${f.tarifa}`);
    const semFee = F.extrairPedidoFinanceiroML({ ...ORDER_GOLDEN, order_items: [{ ...ORDER_GOLDEN.order_items[0], sale_fee: undefined }] }, null);
    assert(semFee.tarifa_origem === "AUSENTE" && semFee.tarifa_venda === null && semFee.descontos_status === "INDISPONIVEL", JSON.stringify(semFee));
    const l = F.liquidoPedidoML({ ...semFee, billing_status: "CONFERIDO", billing_tarifa: 4.19 }, golden().envio);
    assert(l.qualidade === "PENDING" && l.liquido === null && l.motivo === "tarifa", JSON.stringify(l));
  });

  secao("\n[4. coletor — provider FALSO, só GET]");
  const fakeProvider = (opts: { pedidos: Record<string, any>; billing429?: boolean; pack?: any; custos?: any }) => {
    const chamadas: Array<{ metodo: string; caminho: string }> = [];
    const fetch = (async (url: any, init?: any) => {
      const u = new URL(String(url)); const caminho = u.pathname + u.search;
      chamadas.push({ metodo: init?.method ?? "GET", caminho });
      const resp = (status: number, corpo: unknown) => ({ status, ok: status === 200, json: async () => corpo }) as any;
      if (/^\/orders\/\d+$/.test(u.pathname)) { const o = opts.pedidos[u.pathname.split("/")[2]]; return o ? resp(200, o) : resp(404, {}); }
      if (/^\/orders\/\d+\/discounts$/.test(u.pathname)) return resp(200, DESCONTOS_GOLDEN);
      if (/^\/packs\//.test(u.pathname)) return resp(200, opts.pack ?? PACK_GOLDEN);
      if (/^\/shipments\/\d+\/costs$/.test(u.pathname)) return resp(200, opts.custos ?? CUSTOS_GOLDEN);
      if (u.pathname.startsWith("/billing/")) return opts.billing429 ? resp(429, { message: "local_rate_limited" }) : resp(200, billing((u.searchParams.get("order_ids") ?? "").split(",")));
      return resp(404, {});
    }) as unknown as typeof globalThis.fetch;
    const gravados = { envios: [] as any[], pedidos: [] as any[] };
    const esperas: number[] = [];
    const deps = { fetch, esperar: async (ms: number) => { esperas.push(ms); }, gravarEnvios: async (l: any[]) => { gravados.envios.push(...l); }, gravarPedidos: async (l: any[]) => { gravados.pedidos.push(...l); }, agora: () => new Date("2026-10-14T16:00:00Z") };
    return { deps, chamadas, gravados, esperas };
  };
  const conta = { userId: "u1", lojaId: "50165b6f-5185-4da7-991a-07c0c6bc8f39", accessToken: "<TOKEN_FALSO>" };

  t("FIN2-11. pack com 2 pedidos e UM envio: custo do envio buscado/gravado 1×; os 2 pedidos ficam PENDING (sem rateio)", async () => {
    const O2 = "2000018971279999";
    const p2 = { ...ORDER_GOLDEN, id: Number(O2), order_items: [{ ...ORDER_GOLDEN.order_items[0], unit_price: 30, sale_fee: 4.19 }] };
    const f = fakeProvider({ pedidos: { [ORDER]: ORDER_GOLDEN, [O2]: p2 }, pack: { ...PACK_GOLDEN, orders: [{ id: Number(ORDER) }, { id: Number(O2) }] } });
    const r = await K.coletarFinanceiroML(conta, [ORDER, O2], f.deps);
    assert(f.chamadas.filter((x) => /\/shipments\/\d+\/costs/.test(x.caminho)).length === 1 && f.gravados.envios.length === 1 && r.envios === 1, `envios ${f.gravados.envios.length}`);
    assert(JSON.stringify(f.gravados.envios[0].pedidos) === JSON.stringify([ORDER, O2].sort()), JSON.stringify(f.gravados.envios[0].pedidos));
    for (const p of f.gravados.pedidos) {
      const l = F.liquidoPedidoML(p, f.gravados.envios[0]);
      assert(l.qualidade === "PENDING" && l.motivo === "frete_compartilhado" && l.liquido === null, `${p.order_id}: ${JSON.stringify(l)}`);
    }
    assert(f.chamadas.every((x) => x.metodo === "GET"), "chamada não-GET");
    assert(f.gravados.pedidos.every((p) => p.loja_id === conta.lojaId && p.user_id === "u1") && f.gravados.envios.every((e) => e.loja_id === conta.lojaId), "linha sem loja/dono");
  });
  t("FIN2-12. billing 429: retry com backoff, pedido gravado com billing PENDENTE → ESTIMATED, nunca ACTUAL", async () => {
    const f = fakeProvider({ pedidos: { [ORDER]: ORDER_GOLDEN }, billing429: true });
    const r = await K.coletarFinanceiroML(conta, [ORDER], f.deps);
    assert(f.chamadas.filter((x) => x.caminho.startsWith("/billing/")).length === K.TENTATIVAS_ML && f.esperas.length >= K.TENTATIVAS_ML - 1, `billing ${f.chamadas.length} esperas ${f.esperas}`);
    assert(r.billingPendente === 1 && f.gravados.pedidos[0].billing_status === "PENDENTE", JSON.stringify(f.gravados.pedidos[0]));
    const l = F.liquidoPedidoML(f.gravados.pedidos[0], f.gravados.envios[0]);
    assert(l.qualidade === "ESTIMATED" && c(l.liquido) === 3010, JSON.stringify(l));
    const fin = S.financeiroDaVenda(vendaLinha(), comCusto(10), { pedido: f.gravados.pedidos[0], envio: f.gravados.envios[0] });
    assert(fin.qualidadeFinanceira === "ESTIMATED" && fin.baseFinanceira === "ML_RECONCILIADO", `${fin.qualidadeFinanceira}/${fin.baseFinanceira}`);
    // sem billing nem pack: o coletor real grava o golden reconciliado como o provider devolveu
    const ok = fakeProvider({ pedidos: { [ORDER]: ORDER_GOLDEN } });
    await K.coletarFinanceiroML(conta, [ORDER], ok.deps);
    assert(F.liquidoPedidoML(ok.gravados.pedidos[0], ok.gravados.envios[0]).qualidade === "ACTUAL", "golden coletado não ficou ACTUAL");
  });

  secao("\n[5. tela/serviço — legado e real]");
  t("FIN2-13. legado (sem registro) segue ESTIMATED; pedido com 2+ linhas também (sem rateio entre linhas)", () => {
    const leg = S.financeiroDaVenda(vendaLinha(), comCusto(10));
    assert(leg.qualidadeFinanceira === "ESTIMATED" && leg.baseFinanceira === "COMPONENTES_ESTIMADOS" && leg.freteStatus === "nao_incluido", `${leg.qualidadeFinanceira}/${leg.baseFinanceira}`);
    const g = golden();
    const multi = S.financeiroDaVenda(vendaLinha(), comCusto(10), { pedido: { ...g.pedido, itens: 2 }, envio: g.envio });
    assert(multi.baseFinanceira === "COMPONENTES_ESTIMADOS", `multi-linha virou ${multi.baseFinanceira}`);
  });
  t("FIN2-14. golden na tela: Líquido ML 30,10, lucro = 30,10 − custo − imposto, ACTUAL, detalhe informativo", () => {
    const g = golden();
    const f = S.financeiroDaVenda(vendaLinha(), comCusto(10, 10), g);
    assert(f.qualidadeFinanceira === "ACTUAL" && c(f.liquidoMarketplace) === 3010 && c(f.freteVendedor) === 695 && c(f.tarifa) === 419, JSON.stringify(f));
    assert(c(f.lucro) === Math.round((30.10 - 10 - 4.124) * 100), `lucro ${f.lucro}`);
    assert(f.detalheML?.packId === PACK && c(f.detalheML?.freteComprador) === 699 && c(f.detalheML?.descontoMeli) === 76, JSON.stringify(f.detalheML));
  });

  secao("\n[6. guard + migration]");
  t("FIN2-15. I17 limpo; migration 20261115_ml_financeiro.sql aditiva/fechada (contrato próprio); invariantes V2 limpos", () => {
    const v = G2.financeiroMLNaoReal();
    assert(v.length === 0, v.join(" | "));
    const inv = G2.invariantesV2(undefined, { zonas: false });
    assert(inv.length === 0, inv.join(" | "));
  });

  t("FIN2-16. migration FECHADA ao browser/anon: as 2 tabelas com REVOKE de PUBLIC/anon/authenticated + RLS sem policy/grant; pedidos só ganha coluna nula", () => {
    const sql = readFileSync(join(process.cwd(), "supabase/migrations/20261115_ml_financeiro.sql"), "utf8").replace(/\r\n/g, "\n");
    const codigo = sql.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
    for (const tab of ["ml_financeiro_pedidos", "ml_financeiro_envios"]) {
      assert(codigo.includes(`REVOKE ALL PRIVILEGES ON TABLE public.${tab} FROM PUBLIC, anon, authenticated;`), `${tab}: sem REVOKE de PUBLIC/anon/authenticated`);
      assert(codigo.includes(`ALTER TABLE public.${tab} ENABLE ROW LEVEL SECURITY;`), `${tab}: RLS desligada`);
    }
    assert(!/\bGRANT\b/i.test(codigo) && !/\b(CREATE|ALTER)\s+POLICY\b/i.test(codigo) && !/DISABLE\s+ROW\s+LEVEL/i.test(codigo), "GRANT/POLICY/RLS desligada na migration");
    const pedidos = codigo.match(/ALTER TABLE public\.pedidos [^;]+;/g) ?? [];
    assert(pedidos.length === 2 && pedidos[0] === "ALTER TABLE public.pedidos ADD COLUMN tarifa_origem text NULL;" && /^ALTER TABLE public\.pedidos ADD CONSTRAINT pedidos_tarifa_origem_check CHECK \(tarifa_origem IS NULL OR /.test(pedidos[1]), `pedidos alterado além da coluna aditiva: ${pedidos.join(" | ")}`);
    assert(!/\b(UPDATE|DELETE|INSERT|TRUNCATE)\s|\bDROP\b|SET NOT NULL/i.test(codigo), "migration escreve/remove/restringe dados");
  });

  await fila;
  imprimir(`\n${falhou === 0 ? "✓" : "✗"} VENDAS-ML-FINANCEIRO — ${ok} passaram, ${falhou} falharam`);
  process.exit(falhou === 0 ? 0 : 1);
}
principal().catch((e) => { imprimir("ERRO FATAL", e?.message ?? e); process.exit(1); });
