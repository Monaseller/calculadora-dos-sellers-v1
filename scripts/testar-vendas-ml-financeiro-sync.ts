/**
 * CDS V2 — Vendas A3.2-C: o financeiro REAL do Mercado Livre é coletado NO PRÓPRIO sync (todo caminho passa
 * por syncMLForUserV2) e, se ficou incompleto por erro transitório, a tela de Vendas pede UMA nova tentativa
 * server-side ao recarregar — só dos pendentes, da mesma loja, sem reconsultar o que já é ACTUAL.
 *
 * Código REAL (sync, GET /api/ml/vendas, POST /api/ml/vendas/financeiro, POST /api/sync/manual), Supabase em
 * memória e Mercado Livre FALSO (nenhuma rede). Venda golden sanitizada: pack 2000015516685373 → order
 * 2000018971279352, item MLB3710315405, shipment 48253763834 — 41,24 − 4,19 − 6,95 = 30,10.
 *
 * Uso: npx tsx scripts/testar-vendas-ml-financeiro-sync.ts
 */
import "./_server-only-inerte";
import Module from "node:module";
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
const c = (v: unknown) => (v == null ? null : Math.round(Number(v) * 100));

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://placeholder-de-teste.invalid";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "chave-de-teste-invalida";
process.env.SUPABASE_SERVICE_ROLE_KEY = "chave-de-teste-invalida";
process.env.SESSION_SECRET = "segredo-de-teste-com-mais-de-32-bytes-000000";
process.env.ML_CLIENT_ID = "ficticio";
process.env.ML_CLIENT_SECRET = "ficticio";

const U = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ML_A = "50165b6f-5185-4da7-991a-07c0c6bc8f39", ML_B = "22222222-2222-4222-8222-222222222222";
const TOKEN_A = "<TOKEN_A>", TOKEN_B = "<TOKEN_B>";
const FUTURO = () => new Date(Date.now() + 3600_000).toISOString();
const PASSADO = () => new Date(Date.now() - 3600_000).toISOString();
const DIA = "2026-10-14";
const PACK = "2000015516685373", ORDER = "2000018971279352", ITEM = "MLB3710315405", SHIP = "48253763834";

// ── Supabase em memória (upsert respeita onConflict de várias colunas) ─────────
type Linha = Record<string, any>;
let db: Record<string, Linha[]> = {};
let escritas: { tabela: string; op: string; payload: any[] }[] = [];
let falharGravacao: string | null = null;
function clienteFalso() {
  return {
    rpc: async () => ({ data: null, error: { message: "rpc_indisponivel_no_teste" } }),
    from(tabela: string) {
      const st: any = { op: "select", payload: null, conflito: "id", filtros: [] as [string, string, any][], ini: 0, fim: Infinity, unico: false, ordens: [] as [string, boolean][] };
      const casa = (r: Linha) => st.filtros.every(([k, col, v]: [string, string, any]) =>
        k === "eq" ? String(r[col]) === String(v) : k === "in" ? (v as any[]).map(String).includes(String(r[col]))
          : k === "is" ? (r[col] ?? null) === v : k === "gte" ? String(r[col] ?? "") >= String(v) : k === "lte" ? String(r[col] ?? "") <= String(v)
          : k === "gt" ? String(r[col] ?? "") > String(v) : k === "lt" ? String(r[col] ?? "") < String(v) : true);
      const exec = () => {
        const ls = (db[tabela] ??= []);
        if (st.op === "upsert" || st.op === "insert") {
          if (falharGravacao === tabela) return { data: null, error: { message: `falha simulada em ${tabela}` } };
          const novos = Array.isArray(st.payload) ? st.payload : [st.payload];
          escritas.push({ tabela, op: st.op, payload: novos });
          const cols = String(st.conflito).split(",").map((x: string) => x.trim());
          for (const n of novos) {
            const i = ls.findIndex((r) => cols.every((k) => String(r[k]) === String(n[k])));
            if (i >= 0) ls[i] = { ...ls[i], ...n }; else ls.push({ ...n });
          }
          return { data: novos, error: null };
        }
        if (st.op === "update") { for (const r of ls.filter(casa)) Object.assign(r, st.payload); return { data: [], error: null }; }
        let out = ls.filter(casa).map((r) => ({ ...r }));
        for (const [col, asc] of [...st.ordens].reverse()) out.sort((a, b) => (asc ? 1 : -1) * (String(a[col] ?? "") < String(b[col] ?? "") ? -1 : String(a[col] ?? "") > String(b[col] ?? "") ? 1 : 0));
        out = out.slice(st.ini, Math.min(out.length, st.fim));
        return st.unico ? { data: out[0] ?? null, error: null } : { data: out, error: null, count: out.length };
      };
      const b: any = new Proxy({}, { get(_a, p: string) {
        if (p === "then") return (res: any, rej: any) => Promise.resolve().then(exec).then(res, rej);
        if (p === "maybeSingle" || p === "single") return async () => { st.unico = true; return exec(); };
        return (...a: any[]) => {
          if (p === "upsert" || p === "insert" || p === "update") { st.op = p; st.payload = a[0]; if (a[1]?.onConflict) st.conflito = a[1].onConflict; }
          else if (["eq", "in", "is", "gte", "lte", "gt", "lt"].includes(p)) st.filtros.push([p, a[0], a[1]]);
          else if (p === "order") st.ordens.push([a[0], a[1]?.ascending !== false]);
          else if (p === "range") { st.ini = a[0]; st.fim = a[1] + 1; }
          else if (p === "limit") st.fim = st.ini + a[0];
          return b;
        };
      } });
      return b;
    },
  };
}
const requireOriginal = (Module as any).prototype.require;
(Module as any).prototype.require = function (id: string) {
  if (id === "@supabase/supabase-js") return { createClient: () => clienteFalso() };
  return requireOriginal.apply(this, arguments as any);
};

// ── Mercado Livre FALSO ─────────────────────────────────────────────────────
type Resp = { status: number; corpo?: unknown; erro?: "timeout" };
let chamadas: { caminho: string; token: string | null; metodo: string }[] = [];
let pedidosML: Record<string, any> = {};           // order_id → payload
let roteiro: Record<string, Resp[]> = {};          // prefixo do caminho → respostas em sequência (depois 200 normal)
const orderGolden = (extra: Record<string, unknown> = {}) => ({
  id: Number(ORDER), status: "paid", pack_id: Number(PACK), shipping: { id: Number(SHIP) }, total_amount: 41.24, paid_amount: 41.24,
  date_created: `${DIA}T07:07:00.000-03:00`, date_closed: `${DIA}T07:07:10.000-03:00`, last_updated: `${DIA}T07:10:00.000-03:00`,
  order_items: [{ item: { id: ITEM, title: "Ink Training Pele Artificial", variation_id: null }, quantity: 1, unit_price: 41.24, sale_fee: 4.19 }],
  payments: [{ status: "approved", date_approved: `${DIA}T10:07:30.000Z`, transaction_amount: 41.24, shipping_cost: 0, marketplace_fee: 0 }],
  ...extra,
});
const DESCONTOS = { details: [{ type: "discount", items: [{ id: ITEM, amounts: { seller: 0.52, total: 1.28 } }], supplier: { funding_mode: "sale_fee" } }] };
const CUSTOS = { gross_amount: 16.92, receiver: { cost: 6.99, compensation: 0 }, senders: [{ cost: 6.95, compensation: 0, discounts: [{ type: "mandatory", promoted_amount: 2.98 }] }] };
const billingDe = (ids: string[]) => ({ results: [{ details: ids.flatMap((o) => {
  const fee = pedidosML[o]?.order_items?.reduce((a: number, i: any) => a + (i.sale_fee ?? 0) * i.quantity, 0) ?? 0;
  return [
    { charge_info: { detail_type: "CHARGE", detail_sub_type: "CVVML", detail_amount: Math.round((fee - 0.03) * 100) / 100 }, sales_info: [{ order_id: Number(o) }] },
    { charge_info: { detail_type: "CHARGE", detail_sub_type: "CVVPRC", detail_amount: 0.03 }, sales_info: [{ order_id: Number(o) }] },
  ];
}) }] });
function respostaPadrao(u: URL): Resp {
  const p = u.pathname;
  if (p === "/orders/search") {
    const st = u.searchParams.get("order.status");
    const de = u.searchParams.get("order.date_created.from") ?? "";
    const r = Object.values(pedidosML).filter((o: any) => o.status === st && String(o.date_created).slice(0, 10) === de.slice(0, 10));
    return { status: 200, corpo: { results: r, paging: { total: r.length } } };
  }
  let m: RegExpExecArray | null;
  if ((m = /^\/orders\/(\d+)$/.exec(p))) return pedidosML[m[1]] ? { status: 200, corpo: pedidosML[m[1]] } : { status: 404, corpo: { message: "not_found" } };
  if (/^\/orders\/\d+\/discounts$/.test(p)) return { status: 200, corpo: DESCONTOS };
  if ((m = /^\/packs\/(\d+)$/.exec(p))) return { status: 200, corpo: { id: Number(m[1]), orders: Object.values(pedidosML).filter((o: any) => String(o.pack_id) === m![1]).map((o: any) => ({ id: o.id })) } };
  if (/^\/shipments\/\d+\/costs$/.test(p)) return { status: 200, corpo: CUSTOS };
  if (p.startsWith("/billing/")) return { status: 200, corpo: billingDe((u.searchParams.get("order_ids") ?? "").split(",")) };
  if (p.startsWith("/items")) return { status: 200, corpo: [] };
  return { status: 404, corpo: {} };
}
globalThis.fetch = (async (url: any, init?: any) => {
  const u = new URL(String(url));
  if (!/mercadoli(b|v)re\.com/.test(u.hostname)) throw new Error(`teste tentou acessar a rede: ${u.hostname}`);
  const h = init?.headers ?? {};
  const auth = typeof h.get === "function" ? h.get("Authorization") : (h.Authorization ?? h.authorization ?? null);
  const caminho = u.pathname + u.search;
  chamadas.push({ caminho, token: auth ? String(auth).replace(/^Bearer\s+/i, "") : null, metodo: init?.method ?? "GET" });
  const chave = Object.keys(roteiro).find((k) => caminho.startsWith(k) && roteiro[k].length > 0);
  const r = chave ? roteiro[chave].shift()! : respostaPadrao(u);
  if (r.erro === "timeout") throw Object.assign(new Error("aborted"), { name: "AbortError" });
  return { ok: r.status === 200, status: r.status, json: async () => r.corpo ?? {}, text: async () => JSON.stringify(r.corpo ?? {}) } as any;
}) as any;

const lojaML = (id: string, token: string) => ({ id, user_id: U, marketplace: "ML", ativo: true, nickname: "MONAMOR", nome: "MONAMOR", seller_id: "744240004", access_token: token, refresh_token: "<R>", token_expires_at: FUTURO(), created_at: "2026-01-01" });
const semear = () => {
  db = { lojas: [lojaML(ML_A, TOKEN_A), lojaML(ML_B, TOKEN_B)], anuncios: [], pedidos: [], ml_financeiro_pedidos: [], ml_financeiro_envios: [], sync_jobs: [] };
  escritas = []; chamadas = []; roteiro = {}; falharGravacao = null;
  pedidosML = { [ORDER]: orderGolden() };
};
const finDe = (o: string) => db.ml_financeiro_pedidos.find((r) => r.order_id === o);
const envioDe = (s: string) => db.ml_financeiro_envios.filter((r) => r.shipment_id === s);

async function principal() {
  const silenciar = () => { console.log = () => {}; console.error = () => {}; console.warn = () => {}; };
  const restaurar = () => { console.log = imprimir; };
  silenciar();
  const auth = await import("../lib/autenticacao");
  const SY = await import("../lib/sync-ml");
  const F = await import("../lib/vendas/ml-financeiro");
  const K = await import("../lib/vendas/ml-financeiro-coleta");
  const vendas = await import("../app/api/ml/vendas/route");
  const retry = await import("../app/api/ml/vendas/financeiro/route");
  const manual = await import("../app/api/sync/manual/route");
  const G2 = await import("./_guard-v2");
  const sessao = (await auth.emitirTokenSessao(U)).token;
  const cab = { cookie: `cds_session=${sessao}` };
  const contaA = { lojaId: ML_A, accessToken: TOKEN_A, sellerId: "744240004", nickname: "MONAMOR" };
  const sync = async (conta = contaA) => { silenciar(); try { return await SY.syncMLForUserV2(U, DIA, DIA, undefined, true, conta); } finally { restaurar(); } };
  const getVendas = async (q: string) => { silenciar(); try { const r = await vendas.GET(new Request(`https://x.test/api/ml/vendas?${q}`, { headers: cab })); return { status: r.status, corpo: await r.json() as any }; } finally { restaurar(); } };
  const postRetry = async (corpo: unknown) => { silenciar(); try { const r = await retry.POST(new Request("https://x.test/api/ml/vendas/financeiro", { method: "POST", headers: { ...cab, "content-type": "application/json" }, body: JSON.stringify(corpo) })); return { status: r.status, corpo: await r.json() as any }; } finally { restaurar(); } };
  const fonte = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");
  const logs: string[] = [];
  const depsFalsos = () => ({
    fetch: globalThis.fetch, esperar: async (ms: number) => { esperas.push(ms); },
    gravarEnvios: async (l: any[]) => { for (const e of l) { const i = db.ml_financeiro_envios.findIndex((r) => r.loja_id === e.loja_id && r.shipment_id === e.shipment_id); if (i >= 0) db.ml_financeiro_envios[i] = e; else db.ml_financeiro_envios.push(e); } },
    gravarPedidos: async (l: any[]) => { for (const p of l) { const i = db.ml_financeiro_pedidos.findIndex((r) => r.loja_id === p.loja_id && r.order_id === p.order_id); if (i >= 0) db.ml_financeiro_pedidos[i] = p; else db.ml_financeiro_pedidos.push(p); } },
    log: (l: string) => { logs.push(l); },
  });
  let esperas: number[] = [];
  restaurar();

  secao("\n[1. financeiro NO sync — todo caminho passa pelo core]");
  t("SYNCFIN-1. sync de venda nova coleta o financeiro: pedido (pack/shipment/tarifa/billing) + envio gravados", async () => {
    semear(); await sync();
    const f = finDe(ORDER), e = envioDe(SHIP);
    assert(f && f.pack_id === PACK && f.shipment_id === SHIP && c(f.tarifa_venda) === 419 && f.tarifa_origem === "PROVIDER" && f.billing_status === "CONFERIDO" && f.loja_id === ML_A, JSON.stringify(f));
    assert(e.length === 1 && c(e[0].frete_vendedor) === 695 && JSON.stringify(e[0].pedidos) === JSON.stringify([ORDER]), JSON.stringify(e));
  });
  t("SYNCFIN-2. o enriquecimento é do CORE (syncMLForUserV2) — todo caller real passa por ele", async () => {
    const callers: Record<string, RegExp> = {
      "app/api/ml/vendas/route.ts": /syncMLForUser\(userId, /, "app/api/sync/manual/route.ts": /syncMLForUser\(userId, /,
      "app/api/sync/route.ts": /syncMLForUser\(userId, /, "app/api/internal/sync/executar/route.ts": /syncMLForUserV2\(user_id, /,
    };
    for (const [f, re] of Object.entries(callers)) assert(re.test(fonte(f)), `${f} não chama o core do sync`);
    assert(/const result = await syncMLForUserV2\(/.test(fonte("lib/sync-ml.ts")), "syncMLForUser não delega ao V2");
    assert(G2.financeiroMLNaoReal().length === 0, G2.financeiroMLNaoReal().join(" | "));
  });
  t("SYNCFIN-3. sync MANUAL (POST /api/sync/manual, loja_id_ml) coleta o financeiro", async () => {
    semear(); silenciar();
    try { await manual.POST(new Request("https://x.test/api/sync/manual", { method: "POST", headers: { ...cab, "content-type": "application/json" }, body: JSON.stringify({ dateFrom: DIA, dateTo: DIA, marketplace: "ML", loja_id_ml: ML_A, noBuffer: true }) })); } finally { restaurar(); }
    assert(finDe(ORDER)?.billing_status === "CONFERIDO" && envioDe(SHIP).length === 1, JSON.stringify(db.ml_financeiro_pedidos));
  });
  t("SYNCFIN-4. cron (/api/sync) e executor interno chamam o core — o financeiro vem junto (ver SYNCFIN-1/2)", async () => {
    assert(/syncMLForUser\(userId, ontem, hoje, undefined, false, loja\)/.test(fonte("app/api/sync/route.ts")), "cron fora do core");
    assert(/syncMLForUserV2\(user_id, date_from, date_to, undefined, noBuffer, loja\)/.test(fonte("app/api/internal/sync/executar/route.ts")), "executor fora do core");
  });
  t("SYNCFIN-5. auto-sync de Vendas (GET sync=1, loja_id) coleta e a MESMA resposta seguinte já mostra pack + líquido ACTUAL 30,10", async () => {
    semear();
    await getVendas(`date_from=${DIA}&date_to=${DIA}&loja_id=${ML_A}&sync=1`);
    assert(finDe(ORDER)?.billing_status === "CONFERIDO", "auto-sync não coletou");
    const r = await getVendas(`date_from=${DIA}&date_to=${DIA}&loja_id=${ML_A}`);
    const row = (r.corpo.rows ?? []).find((x: any) => x.orderId === ORDER);
    assert(row && row.packId === PACK && row.financeiro?.qualidadeFinanceira === "ACTUAL" && c(row.financeiro?.liquidoMarketplace) === 3010, JSON.stringify(row?.financeiro ?? r.corpo).slice(0, 300));
    assert(r.corpo.financeiroPendente === 0, `pendentes: ${r.corpo.financeiroPendente}`);
  });
  t("SYNCFIN-6. sale_fee real → pedidos.tarifa_origem = PROVIDER", async () => {
    semear(); await sync();
    const p = db.pedidos.find((r) => r.order_id === ORDER);
    assert(p?.tarifa_origem === "PROVIDER" && c(p.tarifa_venda) === 419, JSON.stringify(p));
  });
  t("SYNCFIN-7. sem sale_fee → ESTIMATE, POR UNIDADE (qtd 2 não dobra); financeiro do pedido fica pendente de tarifa", async () => {
    semear();
    pedidosML = { [ORDER]: orderGolden({ order_items: [{ item: { id: ITEM, variation_id: null }, quantity: 2, unit_price: 20, sale_fee: undefined }] }) };
    await sync();
    const p = db.pedidos.find((r) => r.order_id === ORDER);
    assert(p?.tarifa_origem === "ESTIMATE" && c(p.tarifa_venda) === c(20 * 0.13) && c(p.faturamento) === 4000, JSON.stringify(p));
    assert(finDe(ORDER)?.tarifa_origem === "AUSENTE" && F.financeiroPendenteElegivel(finDe(ORDER) as any, envioDe(SHIP)[0] as any) === "tarifa", "pedido sem tarifa não ficou pendente");
  });
  t("SYNCFIN-8..13. golden via sync: 30,10 ACTUAL; rebate 0,76 e desconto 0,52 só registrados; frete = senders.cost; receiver e gross só referência", async () => {
    semear(); await sync();
    const f = finDe(ORDER)!, e = envioDe(SHIP)[0];
    const l = F.liquidoPedidoML(f as any, e as any);
    assert(c(l.liquido) === 3010 && l.qualidade === "ACTUAL", JSON.stringify(l));                       // 8
    assert(c(f.desconto_meli) === 76 && c(l.liquido) !== 3086, "rebate somado");                         // 9
    assert(c(f.desconto_vendedor) === 52 && c(l.liquido) !== 2958, "desconto do vendedor subtraído");    // 10
    assert(c(e.frete_vendedor) === 695, "frete fora de senders.cost");                                  // 11
    assert(c(e.frete_comprador) === 699 && c(l.liquido) !== 2311, "receiver.cost subtraído");             // 12
    assert(c(e.frete_bruto_referencia) === 1692 && c(l.liquido) !== 2013, "gross_amount usado");          // 13
  });
  t("SYNCFIN-14. sync NÃO reconsulta pedido já completo; cancelado não é enriquecido", async () => {
    semear(); await sync();
    chamadas = [];
    const NOVO = "2000018971279400", CANC = "2000018971279500";
    pedidosML[NOVO] = orderGolden({ id: Number(NOVO), pack_id: null, shipping: { id: 1 } });
    pedidosML[CANC] = orderGolden({ id: Number(CANC), status: "cancelled", pack_id: null, shipping: { id: 2 } });
    await sync();
    assert(!chamadas.some((x) => x.caminho.includes(`/orders/${ORDER}/discounts`) || x.caminho.includes(`/shipments/${SHIP}`)), "pedido completo reconsultado");
    assert(chamadas.some((x) => x.caminho.includes(`/orders/${NOVO}/discounts`)), "pedido novo não consultado");
    assert(db.pedidos.some((x) => x.order_id === CANC) && !chamadas.some((x) => x.caminho.includes(CANC) && !x.caminho.startsWith("/orders/search")) && !finDe(CANC), "cancelado enriquecido");
  });
  t("SYNCFIN-15. falha ao gravar o financeiro NÃO derruba o sync (pedidos gravados) e é LOGADA", async () => {
    semear(); falharGravacao = "ml_financeiro_pedidos";
    const erros: string[] = []; silenciar(); console.error = (...a: any[]) => { erros.push(a.join(" ")); };
    let r: any; try { r = await SY.syncMLForUserV2(U, DIA, DIA, undefined, true, contaA); } finally { restaurar(); }
    assert(r.inserted === 1 && db.pedidos.some((x) => x.order_id === ORDER), "sync derrubado");
    assert(erros.some((x) => /\[ml-financeiro\] ERRO enriquecimento loja=/.test(x)), "falha silenciosa");
  });
  t("SYNCFIN-16. prazo já esgotado: o pedido é gravado PENDENTE pelo payload, sem chamadas", async () => {
    semear(); esperas = []; logs.length = 0;
    const r = await K.coletarFinanceiroML({ userId: U, lojaId: ML_A, accessToken: TOKEN_A }, { pedidos: [orderGolden()] }, depsFalsos(), { ate: 0 });
    const f = finDe(ORDER)!;
    assert(r.adiados === 1 && f.billing_status === "PENDENTE" && f.pack_id === PACK && c(f.tarifa_venda) === 419 && chamadas.length === 0, `${JSON.stringify(r)} chamadas=${chamadas.length}`);
    assert(F.financeiroPendenteElegivel(f as any, null) !== null, "adiado não ficou elegível ao retry");
  });

  secao("\n[2. erros — transitório repete, integração é logada]");
  t("RETRYFIN-1. billing 429 → retry com backoff 1 s, 2 s → CONFERIDO", async () => {
    semear(); esperas = []; logs.length = 0;
    roteiro["/billing/"] = [{ status: 429 }, { status: 429 }];
    await K.coletarFinanceiroML({ userId: U, lojaId: ML_A, accessToken: TOKEN_A }, { pedidos: [orderGolden()] }, depsFalsos());
    assert(JSON.stringify(esperas) === "[1000,2000]" && finDe(ORDER)?.billing_status === "CONFERIDO", `esperas ${esperas} ${finDe(ORDER)?.billing_status}`);
  });
  t("RETRYFIN-2. timeout/rede → retry (transitório)", async () => {
    semear(); esperas = []; logs.length = 0;
    roteiro[`/shipments/${SHIP}/costs`] = [{ status: 0, erro: "timeout" }];
    await K.coletarFinanceiroML({ userId: U, lojaId: ML_A, accessToken: TOKEN_A }, { pedidos: [orderGolden()] }, depsFalsos());
    assert(esperas.length === 1 && c(envioDe(SHIP)[0]?.frete_vendedor) === 695, `esperas ${esperas}`);
    assert(F.classificarHttpML(0) === "TRANSIENT_ERROR" && F.classificarHttpML(429) === "TRANSIENT_ERROR" && F.classificarHttpML(503) === "TRANSIENT_ERROR", "classificação transitória");
  });
  t("RETRYFIN-3. 404 em /orders/{id} NÃO é transitório: 1 chamada, INTEGRATION_ERROR logado; pack nunca vai para /orders", async () => {
    semear(); esperas = []; logs.length = 0;
    const r = await K.coletarFinanceiroML({ userId: U, lojaId: ML_A, accessToken: TOKEN_A }, ["2000000000000001"], depsFalsos());
    assert(chamadas.filter((x) => x.caminho.startsWith("/orders/2000000000000001")).length === 1 && esperas.length === 0, "404 repetido");
    assert(r.integracao === 1 && logs.some((l) => /INTEGRATION_ERROR .*order=2000000000000001 .*etapa=order http=404/.test(l)), logs.join(" | "));
    assert(F.classificarHttpML(404) === "INTEGRATION_ERROR" && F.classificarHttpML(500) === "INTEGRATION_ERROR" && F.classificarHttpML(403) === "INTEGRATION_ERROR", "classificação de integração");
    semear(); await sync();
    assert(!chamadas.some((x) => x.caminho.startsWith(`/orders/${PACK}`)), "pack_id usado como order");
    assert(chamadas.some((x) => x.caminho.startsWith(`/packs/${PACK}`)), "pack não consultado pelo endpoint de pack");
  });
  t("RETRYFIN-4. estrutura inesperada (costs sem senders) → INTEGRATION_ERROR logado, sem token/comprador no log", async () => {
    semear(); esperas = []; logs.length = 0;
    roteiro[`/shipments/${SHIP}/costs`] = [{ status: 200, corpo: { gross_amount: 16.92 } }];
    await K.coletarFinanceiroML({ userId: U, lojaId: ML_A, accessToken: TOKEN_A }, { pedidos: [orderGolden()] }, depsFalsos());
    assert(logs.some((l) => /INTEGRATION_ERROR .*shipment=48253763834 etapa=shipment_costs_estrutura http=200/.test(l)), logs.join(" | "));
    assert(!logs.some((l) => l.includes(TOKEN_A) || /buyer|nickname|receiver/i.test(l)), "log com segredo/comprador");
  });

  secao("\n[3. refresh de Vendas — recuperação escolhida no SERVIDOR (janela + loja), uma rodada]");
  const janela = (extra: Record<string, unknown> = {}) => ({ loja_id: ML_A, date_from: DIA, date_to: DIA, date_field: "pagamento", ...extra });
  const linhaPedido = (order: string, extra: Record<string, unknown> = {}) => ({
    id: `${U}_ML_${ML_A}_${order}_${ITEM}_nv`, user_id: U, marketplace: "ML", loja_id: ML_A, order_id: order, ml_item_id: ITEM, variation_id: null,
    data: DIA, data_pagamento: DIA, data_criacao: DIA, synced_at: new Date().toISOString(), status: "paid", qtd: 1, faturamento: 41.24, tarifa_venda: 4.19, conta: "MONAMOR", ...extra,
  });
  const comBillingPendente = async () => { semear(); roteiro["/billing/"] = [{ status: 429 }, { status: 429 }, { status: 429 }]; await sync(); };
  t("RETRYFIN-5. pendente conta na leitura (financeiroPendente = número) e a venda continua visível", async () => {
    await comBillingPendente();
    assert(finDe(ORDER)?.billing_status === "PENDENTE", "billing não ficou pendente");
    const r = await getVendas(`date_from=${DIA}&date_to=${DIA}&loja_id=${ML_A}`);
    assert(r.corpo.financeiroPendente === 1 && (r.corpo.rows ?? []).some((x: any) => x.orderId === ORDER), JSON.stringify(r.corpo.financeiroPendente));
  });
  t("RETRYFIN-6. a tela dispara a recuperação ao carregar (POST único com loja + janela, sem lista) e relê", async () => {
    const pg = fonte("app/(app)/vendas/page.tsx");
    assert((pg.match(/\/api\/ml\/vendas\/financeiro/g) ?? []).length === 1 && /loja_id: finPendente\.lojaId/.test(pg) && /date_from: finPendente\.de, date_to: finPendente\.ate, date_field: finPendente\.campo/.test(pg) && !/order_ids/.test(pg) && /\.then\(\(\) => lerMarketplace\("ML", /.test(pg), "tela sem recuperação/releitura");
  });
  t("RETRYFIN-7/8. recuperação tenta SÓ o que precisa: ACTUAL da janela não é consultado", async () => {
    await comBillingPendente();
    const ACT = "2000000000000777";
    db.pedidos.push(linhaPedido(ACT));
    db.ml_financeiro_pedidos.push({ ...finDe(ORDER)!, order_id: ACT, billing_status: "CONFERIDO", billing_tarifa: 4.19, shipment_id: SHIP, pack_id: null });
    db.ml_financeiro_envios[0] = { ...db.ml_financeiro_envios[0], pedidos: [ACT] };
    chamadas = [];
    const r = await postRetry(janela());
    assert(r.corpo.candidatos === 1, JSON.stringify(r.corpo));
    assert(!chamadas.some((x) => x.caminho.includes(ACT)), "ACTUAL consultado");
  });
  t("RETRYFIN-9. recuperação respeita a loja: janela pedida com loja_id=B → nada da loja A; com A → só TOKEN_A", async () => {
    await comBillingPendente(); chamadas = [];
    const b = await postRetry(janela({ loja_id: ML_B }));
    assert(b.corpo.tentados === 0 && chamadas.length === 0, JSON.stringify(b.corpo));
    await postRetry(janela());
    assert(chamadas.length > 0 && chamadas.every((x) => x.token === TOKEN_A && x.metodo === "GET"), `tokens ${[...new Set(chamadas.map((x) => x.token))]}`);
  });
  t("RETRYFIN-10. sem loop: uma rodada por carga (trava nunca é rearmada; a releitura não dispara outra)", async () => {
    const pg = fonte("app/(app)/vendas/page.tsx");
    assert(/if \(!falhou && !retryFinanceiroRef\.current && typeof data\.financeiroPendente === "number" && data\.financeiroPendente > 0\)/.test(pg) && /retryFinanceiroRef\.current = true;/.test(pg) && !/retryFinanceiroRef\.current = false/.test(pg), "trava ausente");
    assert(/useEffect\(\(\) => \{\s*if \(!finPendente\) return;[\s\S]{0,900}?\}, \[finPendente\]\);/.test(pg), "recuperação fora de efeito único");
  });
  t("RETRYFIN-11. recuperação com sucesso → a releitura mostra ACTUAL 30,10 e nenhum pendente", async () => {
    await comBillingPendente();
    const r = await postRetry(janela());
    assert(r.corpo.ok && r.corpo.actual === 1, JSON.stringify(r.corpo));
    const g = await getVendas(`date_from=${DIA}&date_to=${DIA}&loja_id=${ML_A}`);
    const row = (g.corpo.rows ?? []).find((x: any) => x.orderId === ORDER);
    assert(row?.financeiro?.qualidadeFinanceira === "ACTUAL" && c(row.financeiro.liquidoMarketplace) === 3010 && g.corpo.financeiroPendente === 0, JSON.stringify(row?.financeiro));
  });
  t("RETRYFIN-12. falha de novo (429) → venda visível, ESTIMATED (nunca ACTUAL), ainda pendente para o próximo refresh", async () => {
    await comBillingPendente();
    roteiro["/billing/"] = [{ status: 429 }, { status: 429 }, { status: 429 }];
    const r = await postRetry(janela());
    assert(r.corpo.pendentes === 1 && r.corpo.actual === 0, JSON.stringify(r.corpo));
    const g = await getVendas(`date_from=${DIA}&date_to=${DIA}&loja_id=${ML_A}`);
    const row = (g.corpo.rows ?? []).find((x: any) => x.orderId === ORDER);
    assert(row && row.financeiro?.qualidadeFinanceira === "ESTIMATED" && g.corpo.financeiroPendente === 1, JSON.stringify(row?.financeiro));
  });

  secao("\n[4. histórico SEM linha financeira — recuperação sob demanda (A3.2-C.2)]");
  const historico = (pedidos: Array<[string, Record<string, unknown>?]>) => {
    semear(); pedidosML = {};
    for (const [o, extra] of pedidos) {
      db.pedidos.push(linhaPedido(o, extra ?? {}));
      pedidosML[o] = orderGolden({ id: Number(o), pack_id: o === ORDER ? Number(PACK) : null, shipping: { id: o === ORDER ? Number(SHIP) : Number(o.slice(-7)) } });
    }
  };
  t("HISTFIN-1/2. venda PAGA sem linha financeira é elegível — inclusive a golden (GET conta, sem precisar de sync)", async () => {
    historico([[ORDER]]);
    assert(db.ml_financeiro_pedidos.length === 0, "fixture com linha financeira");
    const g = await getVendas(`date_from=${DIA}&date_to=${DIA}&loja_id=${ML_A}`);
    assert(g.corpo.financeiroPendente === 1, `contagem ${g.corpo.financeiroPendente}`);
    assert(JSON.stringify(F.candidatosRecuperacaoFinanceiraML([{ order_id: ORDER, status: "paid", data: DIA, data_pagamento: DIA, data_criacao: DIA }], new Map(), { de: DIA, ate: DIA, campo: "pagamento" })) === JSON.stringify([ORDER]), "golden não elegível");
  });
  t("HISTFIN-3. ACTUAL não é elegível", async () => {
    semear(); await sync();
    const g = await getVendas(`date_from=${DIA}&date_to=${DIA}&loja_id=${ML_A}`);
    assert(g.corpo.financeiroPendente === 0, `contagem ${g.corpo.financeiroPendente}`);
  });
  t("HISTFIN-4/5/6. outra loja, outro dono e Shopee NÃO são selecionados pelo servidor", async () => {
    historico([[ORDER]]);
    db.pedidos.push(linhaPedido("2000000000000101", { loja_id: ML_B }));
    db.pedidos.push(linhaPedido("2000000000000102", { user_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }));
    db.pedidos.push(linhaPedido("2000000000000103", { marketplace: "Shopee" }));
    db.pedidos.push(linhaPedido("2000000000000104", { status: "cancelled" }));
    chamadas = [];
    const r = await postRetry(janela());
    assert(r.corpo.candidatos === 1, JSON.stringify(r.corpo));
    assert(!chamadas.some((x) => /200000000000010[1-4]/.test(x.caminho)), "fora do escopo consultado");
  });
  t("HISTFIN-7. venda fora da janela não é selecionada", async () => {
    historico([[ORDER], ["2000000000000201", { data: "2026-09-01", data_pagamento: "2026-09-01", data_criacao: "2026-09-01" }]]);
    chamadas = [];
    const r = await postRetry(janela());
    assert(r.corpo.candidatos === 1 && !chamadas.some((x) => x.caminho.includes("2000000000000201")), JSON.stringify(r.corpo));
  });
  t("HISTFIN-8/9. servidor seleciona sozinho; 2.500 candidatos históricos não exigem corpo grande nem quebram", async () => {
    historico(Array.from({ length: 2500 }, (_, i) => [String(2000020000000000 + i)] as [string]));
    let r: any;
    silenciar(); try { const x = await retry.POST(new Request("https://x.test/api/ml/vendas/financeiro", { method: "POST", headers: { ...cab, "content-type": "application/json" }, body: JSON.stringify(janela()) })); r = { status: x.status, corpo: await x.json() }; } finally { restaurar(); }
    assert(r.status === 200 && r.corpo.candidatos === 2500, JSON.stringify(r.corpo));
    assert(JSON.stringify(janela()).length < 200, "corpo grande");
    const rr = fonte("app/api/ml/vendas/financeiro/route.ts");
    assert(!/order_ids/.test(rr) && !/MAX_IDS|LIMITE_/.test(rr), "rota aceita lista do cliente ou tem teto");
  });
  t("HISTFIN-10. mais recentes primeiro (data efetiva da janela, depois order_id)", () => {
    const vendas = [
      { order_id: "1", status: "paid", data: "2026-10-01", data_pagamento: "2026-10-01", data_criacao: "2026-10-01" },
      { order_id: "3", status: "paid", data: "2026-10-14", data_pagamento: "2026-10-14", data_criacao: "2026-10-14" },
      { order_id: "2", status: "paid", data: "2026-10-07", data_pagamento: "2026-10-07", data_criacao: "2026-10-07" },
    ];
    assert(JSON.stringify(F.candidatosRecuperacaoFinanceiraML(vendas, new Map(), { de: "2026-10-01", ate: "2026-10-31", campo: "pagamento" })) === JSON.stringify(["3", "2", "1"]), "ordem");
  });
  t("HISTFIN-11. prazo esgotado: os restantes continuam elegíveis no próximo refresh (sem linha = elegível)", async () => {
    historico([[ORDER], ["2000000000000301"]]);
    const r = await K.coletarFinanceiroML({ userId: U, lojaId: ML_A, accessToken: TOKEN_A }, [ORDER, "2000000000000301"], depsFalsos(), { ate: 0 });
    assert(r.adiados === 2 && db.ml_financeiro_pedidos.length === 0, JSON.stringify(r));
    const g = await getVendas(`date_from=${DIA}&date_to=${DIA}&loja_id=${ML_A}`);
    assert(g.corpo.financeiroPendente === 2, `contagem ${g.corpo.financeiroPendente}`);
  });
  t("HISTFIN-12. uma carga da página → no máximo UMA rodada automática", async () => {
    const pg = fonte("app/(app)/vendas/page.tsx");
    assert(/retryFinanceiroRef\.current = true;/.test(pg) && !/retryFinanceiroRef\.current = false/.test(pg) && (pg.match(/\/api\/ml\/vendas\/financeiro/g) ?? []).length === 1, "loop possível");
  });
  t("HISTFIN-13. GET de Vendas: ZERO chamadas ao provider (com histórico sem financeiro)", async () => {
    historico([[ORDER]]); chamadas = [];
    await getVendas(`date_from=${DIA}&date_to=${DIA}&loja_id=${ML_A}`);
    assert(chamadas.length === 0, `chamadas no GET: ${chamadas.map((x) => x.caminho)}`);
  });
  t("HISTFIN-14. golden histórica recuperada pelo refresh: 41,24 − 4,19 − 6,95 = 30,10 ACTUAL; código = pack", async () => {
    historico([[ORDER]]);
    const r = await postRetry(janela());
    assert(r.corpo.actual === 1, JSON.stringify(r.corpo));
    const f = finDe(ORDER)!, e = envioDe(SHIP)[0];
    assert(f.pack_id === PACK && f.shipment_id === SHIP && c(f.receita_produto) === 4124 && c(f.tarifa_venda) === 419 && f.tarifa_origem === "PROVIDER" && f.billing_status === "CONFERIDO", JSON.stringify(f));
    assert(c(e.frete_comprador) === 699 && c(e.frete_vendedor) === 695, JSON.stringify(e));
    const g = await getVendas(`date_from=${DIA}&date_to=${DIA}&loja_id=${ML_A}`);
    const row = (g.corpo.rows ?? []).find((x: any) => x.orderId === ORDER);
    assert(row?.packId === PACK && row?.financeiro?.qualidadeFinanceira === "ACTUAL" && c(row.financeiro.liquidoMarketplace) === 3010 && g.corpo.financeiroPendente === 0, JSON.stringify(row?.financeiro));
  });
  t("HISTFIN-15. sem linha financeira NÃO é INTEGRATION_ERROR (nenhum log/contagem de erro só por não ter linha)", async () => {
    historico([[ORDER]]); logs.length = 0;
    const r = await K.coletarFinanceiroML({ userId: U, lojaId: ML_A, accessToken: TOKEN_A }, [ORDER], depsFalsos());
    assert(r.integracao === 0 && r.transitorios === 0 && !logs.some((l) => /INTEGRATION_ERROR|TRANSIENT_ERROR/.test(l)) && r.actual === 1, `${JSON.stringify(r)} ${logs.join(" | ")}`);
  });

  secao("\n[5. prazo de execução — sem teto por quantidade (A3.2-C.1)]");
  const lote = (n: number, base = 2000019000000000) => Array.from({ length: n }, (_, i) => orderGolden({ id: base + i, pack_id: null, shipping: { id: 9000000 + i } }));
  const semearLote = (n: number) => { semear(); pedidosML = Object.fromEntries(lote(n).map((o) => [String(o.id), o])); };
  t("BUDGET-1. lote de 130 pedidos com API saudável: TODOS tentados na mesma execução (nenhum adiado, sem teto 100)", async () => {
    semearLote(130); esperas = []; logs.length = 0;
    const r = await K.coletarFinanceiroML({ userId: U, lojaId: ML_A, accessToken: TOKEN_A }, { pedidos: Object.values(pedidosML) }, depsFalsos());
    const descontos = chamadas.filter((x) => /\/orders\/\d+\/discounts$/.test(x.caminho)).length;
    assert(descontos === 130 && r.adiados === 0 && r.actual === 130 && db.ml_financeiro_pedidos.length === 130, `descontos=${descontos} ${JSON.stringify({ ...r, falhas: r.falhas.length })}`);
    assert(chamadas.filter((x) => /\/shipments\/\d+\/costs$/.test(x.caminho)).length === 130, "envio fora de 1×/shipment");
  });
  t("BUDGET-2. prazo atingido (relógio): o restante fica DEFERRED, gravado pelo payload; nenhuma venda perdida; nada chamado após o prazo", async () => {
    semearLote(30); esperas = []; logs.length = 0;
    let agora = 0; const prazo = 20;
    const deps = { ...depsFalsos(), relogio: () => agora, fetch: (async (...a: any[]) => { agora += 1; return (globalThis.fetch as any)(...a); }) as any };
    const r = await K.coletarFinanceiroML({ userId: U, lojaId: ML_A, accessToken: TOKEN_A }, { pedidos: Object.values(pedidosML) }, deps, { ate: prazo });
    assert(r.adiados > 0 && db.ml_financeiro_pedidos.length === 30, `adiados=${r.adiados} gravados=${db.ml_financeiro_pedidos.length}`);
    assert(chamadas.length <= prazo, `chamadas depois do prazo: ${chamadas.length}`);
    const adiados = db.ml_financeiro_pedidos.filter((p) => p.billing_status === "PENDENTE");
    assert(adiados.length >= r.adiados && adiados.every((p) => c(p.tarifa_venda) === 419 && p.tarifa_origem === "PROVIDER"), "venda adiada sem dados do payload");
  });
  t("BUDGET-3. venda adiada pelo prazo é ELEGÍVEL ao retry do refresh (conta em financeiroPendente)", async () => {
    semear(); logs.length = 0;
    await K.coletarFinanceiroML({ userId: U, lojaId: ML_A, accessToken: TOKEN_A }, { pedidos: [orderGolden()] }, depsFalsos(), { ate: 0 });
    db.pedidos.push(linhaPedido(ORDER));
    assert(F.financeiroPendenteElegivel(finDe(ORDER) as any, null) !== null, "adiado não elegível");
    const g = await getVendas(`date_from=${DIA}&date_to=${DIA}&loja_id=${ML_A}`);
    assert(g.corpo.financeiroPendente === 1, JSON.stringify(g.corpo.financeiroPendente));
  });
  t("BUDGET-4/5. adiado NÃO é TRANSIENT_ERROR nem INTEGRATION_ERROR (log próprio DEFERRED_BY_RUNTIME_BUDGET)", async () => {
    semear(); logs.length = 0;
    const r = await K.coletarFinanceiroML({ userId: U, lojaId: ML_A, accessToken: TOKEN_A }, { pedidos: [orderGolden()] }, depsFalsos(), { ate: 0 });
    assert(r.adiados === 1 && r.transitorios === 0 && r.integracao === 0 && r.falhas.length === 0 && chamadas.length === 0, JSON.stringify(r));
    assert(logs.some((l) => /DEFERRED_BY_RUNTIME_BUDGET loja=.* order=2000018971279352 /.test(l)) && !logs.some((l) => /TRANSIENT_ERROR|INTEGRATION_ERROR/.test(l)), logs.join(" | "));
    assert(logs.some((l) => /resumo .* transient=0 integracao=0 deferred_by_runtime_budget=1/.test(l)), "resumo não distingue");
  });
  t("BUDGET-6. ACTUAL não é reconsultado (sync e recuperação)", async () => {
    semear(); await sync(); chamadas = [];
    await sync();
    assert(!chamadas.some((x) => /discounts|shipments|packs|billing/.test(x.caminho)), "ACTUAL reconsultado no sync");
    const r = await postRetry(janela());
    assert(r.corpo.tentados === 0, "ACTUAL reconsultado na recuperação");
  });
  t("BUDGET-7. nenhuma Promise.all sem limite no caminho financeiro (só o pool de concorrência 2)", async () => {
    const k = fonte("lib/vendas/ml-financeiro-coleta.ts").replace(/\/\*[\s\S]*?\*\//g, "");
    const usos = k.match(/Promise\.all\(/g) ?? [];
    assert(usos.length === 1 && /Promise\.all\(Array\.from\(\{ length: Math\.min\(limite, itens\.length\) \}/.test(k) && K.CONCORRENCIA_ML === 2, `Promise.all: ${usos.length}`);
    assert(!/Promise\.all/.test(fonte("app/api/ml/vendas/financeiro/route.ts")) && !/LIMITE_RETRY|ORCAMENTO_/.test(k), "Promise.all/teto no retry");
    assert(K.TENTATIVAS_ML === 3 && K.BACKOFF_BASE_MS === 1000 && K.TIMEOUT_REQUISICAO_MS === 10_000 && K.JANELA_PROVIDER_MS === 40_000, "parâmetros alterados");
  });
  t("BUDGET-8. página: no máximo UMA rodada automática por carga (sem loop)", async () => {
    const pg = fonte("app/(app)/vendas/page.tsx");
    assert(/retryFinanceiroRef\.current = true;/.test(pg) && !/retryFinanceiroRef\.current = false/.test(pg) && (pg.match(/\/api\/ml\/vendas\/financeiro/g) ?? []).length === 1, "loop possível");
  });
  t("BUDGET-9. sem teto 40: 70 vendas históricas sem financeiro com API saudável → as 70 na mesma requisição", async () => {
    historico(Array.from({ length: 70 }, (_, i) => [String(2000021000000000 + i)] as [string]));
    chamadas = [];
    const r = await postRetry(janela());
    assert(r.corpo.candidatos === 70 && r.corpo.tentados === 70 && r.corpo.actual === 70 && r.corpo.adiados === 0, JSON.stringify(r.corpo));
  });

  secao("\n[4. guard]");
  t("I17 (A3.2-C) limpo e invariantes V2 limpos", () => {
    const v = [...G2.financeiroMLNaoReal(), ...G2.invariantesV2(undefined, { zonas: false })];
    assert(v.length === 0, v.join(" | "));
  });

  await fila;
  imprimir(`\n${falhou === 0 ? "✓" : "✗"} VENDAS-ML-FINANCEIRO-SYNC — ${ok} passaram, ${falhou} falharam`);
  process.exit(falhou === 0 ? 0 : 1);
}
principal().catch((e) => { imprimir("ERRO FATAL", e?.stack ?? e?.message ?? e); process.exit(1); });
