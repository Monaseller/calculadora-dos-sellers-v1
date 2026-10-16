/**
 * CDS V2 — Vendas A3.4 (Parte C): financeiro LIVE das linhas ML VISÍVEIS (tarifa real, frete do vendedor real, frete do
 * comprador só referência, líquido ML) e só então lucro / margem / MC — sem gravar nada; e a tela sem o GET legado.
 *
 * Código REAL (tabela do provider, motor financeiro A3.2 em memória, rotas, guard), Supabase em memória e Mercado Livre
 * FALSO (nenhuma rede). Golden: pack 2000015516685373 → order 2000018971279352 — 41,24 − 4,19 − 6,95 = 30,10.
 *
 * Uso: npx tsx scripts/testar-vendas-ml-financeiro-visivel.ts
 */
import "./_server-only-inerte";
import Module from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let ok = 0, falhou = 0;
let fila: Promise<void> = Promise.resolve();
const imprimir = console.log.bind(console);
setTimeout(() => { imprimir("ERRO FATAL: suíte excedeu 5 min"); process.exit(1); }, 5 * 60_000).unref();
function t(nome: string, fn: () => void | Promise<void>) {
  fila = fila.then(async () => {
    try { await fn(); ok++; imprimir(`  PASS  ${nome}`); }
    catch (e: any) { console.log = imprimir; falhou++; imprimir(`  FALHA ${nome} -> ${e?.message ?? e}`); }
  });
}
function secao(s: string) { fila = fila.then(() => { imprimir(s); }); }
function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const c = (v: number | null | undefined) => (v == null ? null : Math.round(v * 100));

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://placeholder-de-teste.invalid";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "chave-de-teste-invalida";
process.env.SUPABASE_SERVICE_ROLE_KEY = "chave-de-teste-invalida";
process.env.SESSION_SECRET = "segredo-de-teste-com-mais-de-32-bytes-000000";
process.env.ML_CLIENT_ID = "ficticio";
process.env.ML_CLIENT_SECRET = "ficticio";
delete process.env.ENABLE_CANONICAL_SALES_SYNC;

const U = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ML_A = "50165b6f-5185-4da7-991a-07c0c6bc8f39";
const TOKEN_A = "<TOKEN_A>";
const PACK = "2000015516685373", ORDER = "2000018971279352", ITEM = "MLB3710315405", SHIP = "48253763834";
const AGORA = Date.parse("2026-10-15T15:00:00.000Z");

// ── Supabase em memória: escrita é FALHA (a Parte C é read-only) ─────────────
type Linha = Record<string, any>;
let db: Record<string, Linha[]> = {};
let escritas: string[] = [];
let lidas: string[] = [];
function clienteFalso() {
  return {
    rpc: async () => ({ data: null, error: { message: "rpc_indisponivel_no_teste" } }),
    from(tabela: string) {
      lidas.push(tabela);
      const st: any = { op: "select", payload: null, filtros: [] as [string, string, any][], ini: 0, fim: Infinity, unico: false, ordens: [] as [string, boolean][], head: false };
      const cmp = (x: any, v: any, f: (a: string, b: string) => boolean) => x !== null && x !== undefined && f(String(x), String(v));
      const casa = (r: Linha) => st.filtros.every(([k, col, v]: [string, string, any]) =>
        k === "eq" ? String(r[col]) === String(v) : k === "in" ? (v as any[]).map(String).includes(String(r[col]))
          : k === "is" ? (r[col] ?? null) === v : k === "gte" ? cmp(r[col], v, (a, b) => a >= b) : k === "lte" ? cmp(r[col], v, (a, b) => a <= b)
          : k === "gt" ? cmp(r[col], v, (a, b) => a > b) : k === "lt" ? cmp(r[col], v, (a, b) => a < b)
          : k === "not" ? ((v as [string, any])[0] === "is" ? (r[col] ?? null) !== (v as [string, any])[1] : true) : true);
      const exec = () => {
        const ls = (db[tabela] ??= []);
        if (st.op === "insert") {
          escritas.push(`insert:${tabela}`);
          const novos = (Array.isArray(st.payload) ? st.payload : [st.payload]).map((n: Linha) => ({ id: `job-${ls.length + 1}`, criado_em: new Date(AGORA).toISOString(), ...n }));
          ls.push(...novos);
          return st.unico ? { data: novos[0], error: null } : { data: novos, error: null };
        }
        let out = ls.filter(casa).map((r) => ({ ...r }));
        for (const [col, asc] of [...st.ordens].reverse()) out.sort((a, b) => (asc ? 1 : -1) * (String(a[col] ?? "") < String(b[col] ?? "") ? -1 : String(a[col] ?? "") > String(b[col] ?? "") ? 1 : 0));
        if (st.head) return { data: null, error: null, count: out.length };
        out = out.slice(st.ini, Math.min(out.length, st.fim));
        return st.unico ? { data: out[0] ?? null, error: null } : { data: out, error: null, count: out.length };
      };
      const b: any = new Proxy({}, { get(_a, p: string) {
        if (p === "then") return (res: any, rej: any) => Promise.resolve().then(exec).then(res, rej);
        if (p === "maybeSingle" || p === "single") return async () => { st.unico = true; return exec(); };
        return (...a: any[]) => {
          if (p === "insert") { st.op = "insert"; st.payload = a[0]; }
          else if (p === "update" || p === "upsert" || p === "delete") { escritas.push(`${p}:${tabela}`); throw new Error(`escrita proibida: ${p} ${tabela}`); }
          else if (p === "select") { if (a[1]?.head) st.head = true; }
          else if (["eq", "in", "is", "gte", "lte", "gt", "lt"].includes(p)) st.filtros.push([p, a[0], a[1]]);
          else if (p === "not") st.filtros.push(["not", a[0], [a[1], a[2]]]);
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
let pedidosML: Record<string, any> = {};
let custos: Record<string, any> = {};                    // shipment → corpo de /costs (ausente = 404)
let billingNet: Record<string, number | null> = {};      // order → sale_fee.net forçado (null = sem net: só linhas CVV/CFFE)
let roteiro: Record<string, Resp[]> = {};                // prefixo do caminho → respostas em sequência
let chamadas: string[] = [];
let relogio = 0, passoRelogio = 0;
const feeDe = (o: any) => Math.round(o.order_items.reduce((a: number, i: any) => a + (i.sale_fee ?? 0) * i.quantity, 0) * 100) / 100;
function respostaPadrao(u: URL): Resp {
  const p = u.pathname;
  if (p === "/orders/search") {
    const de = Date.parse(u.searchParams.get("order.date_closed.from") ?? ""), ate = Date.parse(u.searchParams.get("order.date_closed.to") ?? "");
    const todos = Object.values(pedidosML).filter((o: any) => { const x = Date.parse(o.date_closed); return x >= de && x <= ate + 3600_000; })
      .sort((a: any, b: any) => Date.parse(b.date_closed) - Date.parse(a.date_closed));
    const off = Number(u.searchParams.get("offset") ?? 0), lim = Number(u.searchParams.get("limit") ?? 50);
    return { status: 200, corpo: { results: todos.slice(off, off + lim), paging: { total: todos.length } } };
  }
  let m: RegExpExecArray | null;
  if ((m = /^\/shipments\/(\d+)\/costs$/.exec(p))) return custos[m[1]] ? { status: 200, corpo: custos[m[1]] } : { status: 404, corpo: { message: "not_found" } };
  if ((m = /^\/packs\/(\d+)$/.exec(p))) return { status: 200, corpo: { id: Number(m[1]), orders: Object.values(pedidosML).filter((o: any) => String(o.pack_id) === m![1]).map((o: any) => ({ id: o.id })) } };
  if (p.startsWith("/billing/")) {
    const ids = (u.searchParams.get("order_ids") ?? "").split(",");
    return { status: 200, corpo: { results: ids.map((id) => {
      const o = pedidosML[id]; const fee = o ? feeDe(o) : 0;
      const net = id in billingNet ? billingNet[id] : fee;
      return { order_id: Number(id), ...(net === null ? {} : { sale_fee: { gross: net, net, rebate: 0 } }), details: [
        { charge_info: { detail_type: "CHARGE", detail_sub_type: "CVVML", detail_amount: Math.round((fee - 0.03) * 100) / 100 }, sales_info: [{ order_id: Number(id) }] },
        { charge_info: { detail_type: "CHARGE", detail_sub_type: "CVVPRC", detail_amount: 0.03 }, sales_info: [{ order_id: Number(id) }] },
        { charge_info: { detail_type: "CHARGE", detail_sub_type: "CFFE", detail_amount: 13.94 }, sales_info: [{ order_id: Number(id) }] },
      ] };
    }) } };
  }
  return { status: 404, corpo: {} };
}
globalThis.fetch = (async (url: any, init?: any) => {
  const u = new URL(String(url));
  if (!/mercadoli(b|v)re\.com/.test(u.hostname)) throw new Error(`teste tentou acessar a rede: ${u.hostname}`);
  if ((init?.method ?? "GET") !== "GET") throw new Error("escrita no provider");
  const caminho = u.pathname + u.search;
  chamadas.push(caminho);
  relogio += passoRelogio;
  const chave = Object.keys(roteiro).find((k) => caminho.startsWith(k) && roteiro[k].length > 0);
  const r = chave ? roteiro[chave].shift()! : respostaPadrao(u);
  if (r.erro === "timeout") throw Object.assign(new Error("aborted"), { name: "AbortError" });
  return { ok: r.status === 200, status: r.status, headers: { get: () => null }, json: async () => r.corpo ?? {} } as any;
}) as any;

const brt = (dia: string, hora: string) => new Date(Date.parse(`${dia}T${hora}.000-03:00`)).toISOString();
let nId = 2000019100000000, nShip = 47000000000;
function pedido(extra: Record<string, any> = {}): any {
  const id = String(++nId);
  const fechado = brt("2026-09-10", "12:00:00");
  return { id: Number(id), status: "paid", pack_id: null, shipping: { id: ++nShip }, total_amount: 20, paid_amount: 20,
    date_created: fechado, date_closed: fechado, last_updated: fechado,
    order_items: [{ item: { id: "MLB111", title: "Produto", variation_id: null }, quantity: 1, unit_price: 20, sale_fee: 2.6 }],
    payments: [{ status: "approved", date_approved: fechado }], buyer: { id: 1, nickname: "COMPRADOR_NAO_PODE_VAZAR" }, ...extra };
}
const golden = () => ({ id: Number(ORDER), status: "paid", pack_id: Number(PACK), shipping: { id: Number(SHIP) }, total_amount: 41.24, paid_amount: 41.24,
  date_created: brt("2026-09-10", "07:07:00"), date_closed: brt("2026-09-10", "07:07:10"), last_updated: brt("2026-09-10", "07:10:00"),
  order_items: [{ item: { id: ITEM, title: "Ink Training Pele Artificial", variation_id: null }, quantity: 1, unit_price: 41.24, sale_fee: 4.19 }],
  payments: [{ status: "approved", date_approved: brt("2026-09-10", "07:07:30") }] });
const CUSTOS_GOLDEN = { gross_amount: 16.92, receiver: { cost: 6.99, compensation: 0 }, senders: [{ cost: 6.95, compensation: 0, discounts: [{ type: "mandatory", promoted_amount: 2.98 }] }] };
const add = (...ps: any[]) => { for (const p of ps) pedidosML[String(p.id)] = p; return ps.map((p) => String(p.id)); };
const comFrete = (ids: string[], vendedor = 5, comprador = 9.9) => { for (const id of ids) custos[String(pedidosML[id].shipping.id)] = { gross_amount: 20, receiver: { cost: comprador }, senders: [{ cost: vendedor }] }; };

const lojaML = () => ({ id: ML_A, user_id: U, marketplace: "ML", ativo: true, nickname: "MONAMOR", nome: "MONAMOR", seller_id: "744240004", access_token: TOKEN_A, refresh_token: "<R>", token_expires_at: new Date(Date.now() + 3600_000).toISOString(), created_at: "2026-01-01", partner_id: null, partner_key: null });
const semear = () => {
  db = { lojas: [lojaML()], anuncios: [
    { id: "an-g", user_id: U, marketplace: "ML", loja_id: ML_A, ml_item_id: ITEM, variation_id: null, custo_produto: 10, insumos: 1, imposto: 10 },
    { id: "an-1", user_id: U, marketplace: "ML", loja_id: ML_A, ml_item_id: "MLB111", variation_id: null, custo_produto: 8, insumos: 0, imposto: 0 },
  ], sync_jobs: [], ml_pedidos: [], pedidos: [] };
  escritas = []; lidas = []; chamadas = []; pedidosML = {}; custos = {}; billingNet = {}; roteiro = {}; relogio = 0; passoRelogio = 0;
};

async function principal() {
  const silenciar = () => { console.log = () => {}; console.error = () => {}; console.warn = () => {}; };
  const restaurar = () => { console.log = imprimir; };
  const TB = await import("../lib/vendas/ml-tabela-provider");
  const FL = await import("../lib/vendas/ml-financeiro-live");
  const MH = await import("../lib/vendas/ml-metricas-hibridas");
  const HP = await import("../app/(app)/vendas/ml-provider");
  const G2 = await import("./_guard-v2");
  const fonte = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");
  let esperas: number[] = [], logs: string[] = [];
  const pagina = async (de = "2026-09-10", ate = "2026-09-10", opcoes: { cursor?: any; inicioMs?: number; relogio?: boolean } = {}) => {
    silenciar(); logs = [];
    try {
      return await TB.lerPaginaTabelaML({ userId: U, lojaId: ML_A, de, ate, visao: "fechamento", cursor: opcoes.cursor ?? null },
        { cliente: clienteFalso() as any, inicioMs: opcoes.inicioMs, financeiro: { esperar: async (ms) => { esperas.push(ms); }, log: (l) => logs.push(l), ...(opcoes.relogio ? { relogio: () => relogio } : {}) } });
    } finally { restaurar(); }
  };
  const linha = (p: any, id: string) => p.linhas.find((x: any) => x.orderId === id)!;
  const sem = (prefixo: string) => chamadas.filter((x) => x.startsWith(prefixo));

  secao("\n[1. tarifa — sale_fee do pedido é REAL; billing só reconcilia]");
  t("C-1. sale_fee da busca → tarifa real PROVIDER_ORDER (Σ sale_fee × qtd), mesmo sem billing", async () => {
    semear();
    const [o] = add(pedido({ order_items: [{ item: { id: "MLB111", title: "P", variation_id: null }, quantity: 3, unit_price: 20, sale_fee: 2.6 }] })); comFrete([o]);
    billingNet[o] = null; roteiro["/billing/"] = [{ status: 200, corpo: { results: [] } }];   // billing ainda sem lançamento
    const l = linha(await pagina(), o);
    assert(l.financeiroML.fee.status === "CONFIRMED" && l.financeiroML.fee.source === "PROVIDER_ORDER" && c(l.financeiroML.fee.value) === 780 && l.financeiro.tarifaOrigem === "real", JSON.stringify(l.financeiroML.fee));
  });
  t("C-2. sem sale_fee → tarifa PENDING (nenhuma estimativa), líquido e lucro pendentes", async () => {
    semear();
    const [o] = add(pedido({ order_items: [{ item: { id: "MLB111", title: "P", variation_id: null }, quantity: 1, unit_price: 20 }] })); comFrete([o]);
    const l = linha(await pagina(), o);
    assert(l.financeiroML.fee.status === "PENDING" && l.financeiroML.fee.value === null && l.financeiroML.mlNet.status === "PENDING" && l.financeiro.lucro === null && l.financeiro.margemPct === null, JSON.stringify(l.financeiroML));
    assert(HP.textoComponenteML(l.financeiroML.fee.status) === "Pendente", "rótulo");
  });
  t("C-3. billing sale_fee.net confirma a tarifa da busca → PROVIDER_BILLING", async () => {
    semear(); pedidosML[ORDER] = golden(); custos[SHIP] = CUSTOS_GOLDEN;
    const l = linha(await pagina(), ORDER);
    assert(l.financeiroML.fee.status === "CONFIRMED" && l.financeiroML.fee.source === "PROVIDER_BILLING" && c(l.financeiroML.fee.billingValue) === 419, JSON.stringify(l.financeiroML.fee));
  });
  t("C-4. billing diverge (> 0,01) → DIVERGENT: os dois valores no detalhe; lucro/MC pendentes", async () => {
    semear(); pedidosML[ORDER] = golden(); custos[SHIP] = CUSTOS_GOLDEN; billingNet[ORDER] = 5.0;
    const l = linha(await pagina(), ORDER);
    assert(l.financeiroML.fee.status === "DIVERGENT" && c(l.financeiroML.fee.value) === 419 && c(l.financeiroML.fee.billingValue) === 500, JSON.stringify(l.financeiroML.fee));
    assert(l.financeiroML.mlNet.status === "DIVERGENT" && l.financeiro.lucro === null && l.financeiro.margemPct === null, JSON.stringify({ n: l.financeiroML.mlNet, lucro: l.financeiro.lucro }));
  });
  t("C-5. sem sale_fee.net o fallback é Σ CVV* — o frete CFFE (13,94) nunca entra na tarifa", async () => {
    semear(); pedidosML[ORDER] = golden(); custos[SHIP] = CUSTOS_GOLDEN; billingNet[ORDER] = null;
    const l = linha(await pagina(), ORDER);
    assert(l.financeiroML.fee.source === "PROVIDER_BILLING" && c(l.financeiroML.fee.billingValue) === 419 && c(l.financeiroML.mlNet.value) === 3010, JSON.stringify(l.financeiroML));
  });

  secao("\n[2. frete — senders é do vendedor; receiver é do comprador; zero real ≠ ausente]");
  t("C-6/C-7. frete do vendedor = Σ senders[].cost; receiver.cost só referência (não subtraído)", async () => {
    semear();
    const [o] = add(pedido()); custos[String(pedidosML[o].shipping.id)] = { gross_amount: 30, receiver: { cost: 12.5 }, senders: [{ cost: 3 }, { cost: 1.5 }] };
    const l = linha(await pagina(), o);
    assert(c(l.financeiroML.sellerShipping.value) === 450 && l.financeiroML.sellerShipping.status === "CONFIRMED" && c(l.financeiroML.buyerShipping.value) === 1250, JSON.stringify(l.financeiroML));
    assert(c(l.financeiroML.mlNet.value) === 2000 - 260 - 450, `líquido ${l.financeiroML.mlNet.value} (receiver/gross subtraído?)`);
  });
  t("C-8. senders[].cost = 0 explícito do provider → R$ 0,00 REAL (confirmado; líquido = receita − tarifa)", async () => {
    semear();
    const [o] = add(pedido()); custos[String(pedidosML[o].shipping.id)] = { gross_amount: 0, receiver: { cost: 0 }, senders: [{ cost: 0 }] };
    const l = linha(await pagina(), o);
    assert(l.financeiroML.sellerShipping.status === "CONFIRMED" && l.financeiroML.sellerShipping.value === 0 && c(l.financeiroML.mlNet.value) === 1740 && l.financeiroML.mlNet.status === "CONFIRMED", JSON.stringify(l.financeiroML));
  });
  t("C-9. frete ausente (senders vazio, 404, timeout) → PENDING, nunca zero; o líquido não sai", async () => {
    semear();
    const [a, b, d] = add(pedido(), pedido(), pedido());
    custos[String(pedidosML[a].shipping.id)] = { gross_amount: 5, receiver: { cost: 1 }, senders: [] };      // shape incompleto
    roteiro[`/shipments/${pedidosML[d].shipping.id}/costs`] = [{ status: 0, erro: "timeout" }, { status: 0, erro: "timeout" }, { status: 0, erro: "timeout" }];
    const p = await pagina();
    for (const id of [a, b, d]) {
      const f = linha(p, id).financeiroML;
      assert(f.sellerShipping.value === null && f.sellerShipping.status === "PENDING" && f.mlNet.value === null && f.mlNet.status === "PENDING", `${id}: ${JSON.stringify(f)}`);
    }
    assert(JSON.stringify(esperas.slice(-2)) === "[1000,2000]", `retry do timeout fora do contrato: ${esperas}`);
    assert(HP.textoComponenteML("PENDING") === "Pendente" && !/não incluído|R\$/.test(HP.textoComponenteML("PENDING") + HP.textoComponenteML("PROVIDER_NOT_READY")), "rótulo parece zero");
  });
  t("C-10. o mesmo shipment é consultado UMA vez", async () => {
    semear();
    const [a] = add(pedido({ order_items: [{ item: { id: "MLB111", title: "A", variation_id: null }, quantity: 1, unit_price: 20, sale_fee: 2 }, { item: { id: "MLB222", title: "B", variation_id: null }, quantity: 1, unit_price: 10, sale_fee: 1 }] }));
    comFrete([a]);
    const p = await pagina();
    assert(p.linhas.filter((x: any) => x.orderId === a).length === 2 && sem("/shipments/").length === 1, `costs=${sem("/shipments/").length}`);
  });
  t("C-11/C-12. envio COMPARTILHADO (pack com 2 pedidos) → SHARED_SHIPMENT_PENDING: sem rateio, frete não descontado 2×, sem líquido individual", async () => {
    semear();
    const [a, b] = add(pedido({ pack_id: 2000015599999999, shipping: { id: 46999 } }), pedido({ pack_id: 2000015599999999, shipping: { id: 46999 } }));
    custos["46999"] = { gross_amount: 20, receiver: { cost: 9 }, senders: [{ cost: 8 }] };
    const p = await pagina();
    for (const id of [a, b]) {
      const f = linha(p, id).financeiroML;
      assert(f.sellerShipping.status === "SHARED_SHIPMENT_PENDING" && f.sellerShipping.value === null && f.mlNet.value === null && f.mlNet.status === "SHARED_SHIPMENT_PENDING" && f.fee.status === "CONFIRMED", `${id}: ${JSON.stringify(f)}`);
      assert(linha(p, id).financeiro.lucro === null, "lucro com frete compartilhado");
    }
    assert(sem("/shipments/46999").length === 1 && sem("/packs/").length === 1, `costs=${sem("/shipments/46999").length} packs=${sem("/packs/").length}`);
    assert(HP.textoComponenteML("SHARED_SHIPMENT_PENDING") === "Pendente (envio compartilhado)", "rótulo");
  });
  t("C-12b. pack de 2 pedidos com SÓ um visível na página → ainda compartilhado (o provider diz quem divide o envio)", async () => {
    semear();
    const [a] = add(pedido({ pack_id: 2000015588888888, shipping: { id: 46888 } }));
    add(pedido({ pack_id: 2000015588888888, shipping: { id: 46888 }, date_closed: brt("2026-09-20", "10:00:00") }));   // fora da página
    custos["46888"] = { gross_amount: 20, receiver: { cost: 9 }, senders: [{ cost: 8 }] };
    const f = linha(await pagina(), a).financeiroML;
    assert(f.sellerShipping.status === "SHARED_SHIPMENT_PENDING" && f.mlNet.value === null, JSON.stringify(f));
  });

  secao("\n[3. líquido e golden]");
  t("C-13. GOLDEN: 41,24 − 4,19 − 6,95 = 30,10 (frete do comprador 6,99 fora); lucro = 30,10 − custo − imposto", async () => {
    semear(); pedidosML[ORDER] = golden(); custos[SHIP] = CUSTOS_GOLDEN;
    const l = linha(await pagina(), ORDER);
    const f = l.financeiroML;
    assert(c(l.faturamento) === 4124 && c(f.fee.value) === 419 && c(f.sellerShipping.value) === 695 && c(f.buyerShipping.value) === 699 && c(f.mlNet.value) === 3010 && f.mlNet.status === "CONFIRMED" && f.financialStatus === "CONFIRMED", JSON.stringify(f));
    assert(l.packId === PACK && c(l.financeiro.liquidoMarketplace) === 3010 && c(l.financeiro.custoProduto) === 1100 && c(l.financeiro.imposto) === 412 && c(l.financeiro.lucro) === 3010 - 1100 - 412 && l.financeiro.qualidadeFinanceira === "ACTUAL", JSON.stringify(l.financeiro));
  });
  t("C-14/C-15. rebate e desconto do vendedor não entram de novo: /discounts nunca é chamado e o líquido segue 30,10", async () => {
    semear(); pedidosML[ORDER] = golden(); custos[SHIP] = CUSTOS_GOLDEN;
    const l = linha(await pagina(), ORDER);
    assert(sem("/orders/").filter((x) => x.includes("/discounts")).length === 0 && c(l.financeiroML.mlNet.value) === 3010 && c(l.financeiroML.mlNet.value) !== 3086 && c(l.financeiroML.mlNet.value) !== 2958, `${chamadas.filter((x) => x.includes("discounts"))}`);
    assert(!sem("/orders/").some((x) => /^\/orders\/\d+$/.test(x.split("?")[0])), "GET /orders/{id} desnecessário (o payload da busca já basta)");
  });

  secao("\n[4. orçamento — só a página visível, billing ≤ 20, disjuntor, prazo]");
  t("C-16/C-17. só os pedidos da página visível recebem chamadas financeiras; billing em lotes de no máximo 20", async () => {
    semear();
    const ids = add(...Array.from({ length: 120 }, (_, i) => pedido({ date_closed: new Date(Date.parse(brt("2026-09-10", "08:00:00")) + i * 60_000).toISOString() })));
    comFrete(ids);
    const p = await pagina();
    const visiveis = new Set(p.linhas.map((x: any) => x.orderId));
    const shipsVisiveis = new Set(p.linhas.map((x: any) => x.shippingId));
    const shipsChamados = sem("/shipments/").map((x) => x.split("/")[2]);
    const billingIds = sem("/billing/").flatMap((x) => decodeURIComponent(new URL("https://x" + x).searchParams.get("order_ids") ?? "").split(","));
    assert(visiveis.size === 50 && shipsChamados.length === 50 && shipsChamados.every((s) => shipsVisiveis.has(s)) && billingIds.every((id) => visiveis.has(id)), `vis=${visiveis.size} costs=${shipsChamados.length}`);
    assert(sem("/billing/").length === 3 && sem("/billing/").every((x) => decodeURIComponent(x).split("order_ids=")[1].split(",").length <= 20), `billing=${sem("/billing/").map((x) => decodeURIComponent(x).split("order_ids=")[1].split(",").length)}`);
  });
  t("C-18. billing com 429 nas 3 tentativas → disjuntor: nenhum lote seguinte; a tarifa do pedido segue REAL (não apagada)", async () => {
    semear();
    const ids = add(...Array.from({ length: 45 }, (_, i) => pedido({ date_closed: new Date(Date.parse(brt("2026-09-10", "08:00:00")) + i * 60_000).toISOString() })));
    comFrete(ids);
    roteiro["/billing/"] = Array.from({ length: 30 }, () => ({ status: 429 }));
    const p = await pagina();
    assert(sem("/billing/").length === 3, `chamadas de billing ${sem("/billing/").length} (esperado 1 lote × 3 tentativas)`);
    assert(p.linhas.every((x: any) => x.financeiroML.fee.status === "CONFIRMED" && x.financeiroML.fee.source === "PROVIDER_ORDER" && c(x.financeiroML.fee.value) === 260), "tarifa real apagada pelo 429");
    assert(p.linhas.every((x: any) => x.financeiroML.mlNet.status === "CONFIRMED"), "líquido caiu sem billing (billing não é pré-requisito)");
    assert(logs.some((l) => /billing_rate_limited/.test(l)) && logs.some((l) => /resumo .* modo=live /.test(l)) && !logs.some((l) => l.includes(TOKEN_A) || /COMPRADOR|nickname/.test(l)), logs.join(" | "));
  });
  t("C-19. prazo: chamada nova só até 40 s do início da requisição; as linhas que não couberam ficam PENDING", async () => {
    semear();
    const ids = add(...Array.from({ length: 30 }, (_, i) => pedido({ date_closed: new Date(Date.parse(brt("2026-09-10", "08:00:00")) + i * 60_000).toISOString() })));
    comFrete(ids);
    passoRelogio = 3000;   // cada chamada ao provider "leva" 3 s
    const p = await pagina("2026-09-10", "2026-09-10", { inicioMs: 0, relogio: true });
    const conf = p.linhas.filter((x: any) => x.financeiroML.mlNet.status === "CONFIRMED").length, pend = p.linhas.filter((x: any) => x.financeiroML.mlNet.status === "PENDING").length;
    assert(conf > 0 && pend > 0 && conf + pend === 30, `confirmadas=${conf} pendentes=${pend}`);
    assert(p.linhas.filter((x: any) => x.financeiroML.mlNet.status === "PENDING").every((x: any) => x.financeiroML.mlNet.value === null && x.financeiro.lucro === null), "pendente com número");
    assert(logs.some((l) => /deferred_by_runtime_budget=[1-9]/.test(l)), logs.filter((l) => /resumo/.test(l)).join(" | "));
  });

  secao("\n[5. lucro / margem / MC — só com tudo confirmado]");
  t("C-20. frete ausente → lucro, margem e MC PENDENTES (nunca 'receita − tarifa − custo')", async () => {
    semear();
    const [o] = add(pedido());   // sem /costs → 404
    const l = linha(await pagina(), o);
    assert(l.financeiro.custoProduto !== null && l.financeiro.lucro === null && l.financeiro.margemPct === null && l.financeiro.roi === null && l.financeiro.pendencias.includes("financeiro") && l.financeiro.qualidadeFinanceira === "PENDING", JSON.stringify(l.financeiro));
  });
  t("C-21. custo DESCONHECIDO em Meus Produtos → lucro/margem/MC pendentes, com o financeiro do ML confirmado", async () => {
    semear();
    const [o] = add(pedido({ order_items: [{ item: { id: "MLB999", title: "Sem cadastro", variation_id: null }, quantity: 1, unit_price: 20, sale_fee: 2.6 }] })); comFrete([o]);
    const l = linha(await pagina(), o);
    assert(l.financeiroML.mlNet.status === "CONFIRMED" && l.financeiro.custoProduto === null && l.financeiro.lucro === null && l.financeiro.margemPct === null && l.financeiro.pendencias.includes("custo"), JSON.stringify(l.financeiro));
  });
  t("C-21b. nada é gravado: nenhuma escrita no banco nem leitura do financeiro persistido", async () => {
    semear(); pedidosML[ORDER] = golden(); custos[SHIP] = CUSTOS_GOLDEN;
    await pagina();
    assert(escritas.length === 0 && !lidas.includes("ml_financeiro_pedidos") && !lidas.includes("ml_financeiro_envios") && !lidas.includes("pedidos"), `escritas=${escritas} lidas=${[...new Set(lidas)]}`);
  });

  secao("\n[6. tela — sem GET legado; refresh canônico; Todos sem total parcial]");
  t("C-22. a tela ML NÃO chama o GET legado /api/ml/vendas (nem a recuperação persistida); o endpoint legado continua existindo", () => {
    const pg = fonte("app/(app)/vendas/page.tsx");
    assert((pg.match(/\/api\/ml\/vendas[?`"]/g) ?? []).length === 0 && !/\/api\/ml\/vendas\/financeiro|deveRecuperarFinanceiroML|finPendente/.test(pg), "tela chama o legado");
    assert(/\/api\/ml\/vendas\/metricas/.test(pg) && /\/api\/ml\/vendas\/pedidos/.test(pg), "tela sem as rotas A3.4");
    assert(/export async function GET\(/.test(fonte("app/api/ml/vendas/route.ts")) && /export async function POST\(/.test(fonte("app/api/ml/vendas/financeiro/route.ts")), "endpoint legado apagado");
    const v = [...G2.lojaMLVendasNaoExplicita(), ...G2.mlVendasForaDoCanonico(), ...G2.financeiroMLNaoReal()];
    assert(v.length === 0, v.join(" | "));
  });
  t("C-23. o refresh canônico segue pelo coordenador (Sincronizar → POST de métricas com revalidar), sem depender do GET legado", async () => {
    const pg = fonte("app/(app)/vendas/page.tsx").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    assert(/if \(mkt === "ML"\) \{\s*const \[, t\] = await Promise\.all\(\[lerMetricasML\(from, to, force\), lerTabelaML\(from, to, null, force\)\]\);/.test(pg), "Sincronizar do ML fora da revalidação canônica");
    semear();
    db.sync_jobs = [{ id: "j0", user_id: U, loja_id: ML_A, marketplace: "ML", tipo: "backfill", campo_tempo: "date_closed", janela_inicio: "2026-09-01T03:00:00.000Z", janela_fim: "2026-09-05T03:00:00.000Z", listagem_completa: true, status: "concluido", concluido_em: "2026-10-05T12:00:00.000Z", criado_em: "2026-10-05T12:00:00.000Z" }];
    silenciar(); let m: any;
    try { m = await MH.metricasHibridasML({ userId: U, lojaId: ML_A, de: "2026-09-01", ate: "2026-09-30", revalidar: true }, { cliente: clienteFalso() as any, agoraMs: AGORA, habilitado: true }); } finally { restaurar(); }
    assert(m.revalidacao === "JOB_CRIADO" && db.sync_jobs.some((j) => j.status === "pendente" && j.campo_tempo === "date_closed") && !chamadas.some((x) => x.startsWith("/orders/search")), `${m.revalidacao}`);
  });
  t("C-24. Todos: os cards pagos são SÓ da Shopee (rotulados) e o ML fica na seção canônica — nenhuma soma ML parcial + Shopee", () => {
    const pg = fonte("app/(app)/vendas/page.tsx");
    assert(/const cardsRows = filteredRows\.filter\(r => r\.marketplace !== "ML" && r\.status === "paid"\);/.test(pg) && /\{lojaAtiva === "todos" && <div[^>]*>Shopee<\/div>\}/.test(pg), "cards pagos misturam a página parcial do ML");
    assert(/!loading && lojaAtiva !== "ML" && cardsRows\.length > 0/.test(pg) && /\{rotuloMetricasML\(mlMetricas\)\}/.test(pg), "seção ML canônica ausente");
    assert(/carregadas \(há mais vendas do ML\)/.test(pg), "rodapé da tabela não avisa que a página do ML é parcial");
  });

  await fila;
  imprimir(`\n${falhou === 0 ? "✓" : "✗"} VENDAS-ML-FINANCEIRO-VISIVEL — ${ok} passaram, ${falhou} falharam`);
  process.exit(falhou === 0 ? 0 : 1);
}
principal().catch((e) => { console.log = imprimir; imprimir(`ERRO FATAL: ${e?.stack ?? e}`); process.exit(1); });
