/**
 * CDS V2 — Vendas A3.4 (Partes A/B): Mercado Livre HÍBRIDO na tela de Vendas.
 *
 *   A  métricas Vendas / Unidades / Vendas brutas SÓ do serviço canônico (corpus `ml_pedidos`, `order.date_closed`
 *      BRT, sem `pack_splitted`); COMPLETE / PARTIAL / FAILED; refresh pelo coordenador existente; nunca o legado.
 *   B  tabela do PROVIDER paginada (cursor dia:offset, ≤ 50 por busca); provider vence o banco; visão paga por
 *      candidatos `date_closed` ±1 dia + aprovação elegível MAIS ANTIGA; custo de Meus Produtos.
 *
 * Código REAL (serviço canônico, coordenador, rotas, leitor do provider), Supabase em memória e Mercado Livre FALSO
 * (nenhuma rede). Setembro/2026 por fixture sanitizada (sem order_id/comprador): 10896 / 11358 / 393745,59.
 *
 * Uso: npx tsx scripts/testar-vendas-ml-hibrido.ts
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
const AGORA = Date.parse("2026-10-15T15:00:00.000Z");   // 12:00 em Sao Paulo
const OBS = "2026-10-05T12:00:00.000Z";
const FUTURO = () => new Date(Date.now() + 3600_000).toISOString();

// ── Supabase em memória (registra cada tabela lida) ─────────────────────────
type Linha = Record<string, any>;
let db: Record<string, Linha[]> = {};
let lidas: string[] = [];
let falharTabela: string | null = null;
let seq = 0;
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
        if (falharTabela === tabela) return { data: null, error: { message: `falha simulada em ${tabela}` } };
        const ls = (db[tabela] ??= []);
        if (st.op === "insert") {
          const novos = (Array.isArray(st.payload) ? st.payload : [st.payload]).map((n: Linha) => ({ id: `job-${++seq}`, criado_em: new Date(AGORA).toISOString(), ...n }));
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
          else if (p === "update" || p === "upsert" || p === "delete") throw new Error(`escrita proibida neste teste: ${p} ${tabela}`);
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

// ── Mercado Livre FALSO: /orders/search por order.date_closed (devolve ~1 h além do fim, como o real) ─────
let pedidosML: Record<string, any> = {};
let buscas: URL[] = [];
let falharBusca = 0;
globalThis.fetch = (async (url: any, init?: any) => {
  const u = new URL(String(url));
  if (!/mercadoli(b|v)re\.com/.test(u.hostname)) throw new Error(`teste tentou acessar a rede: ${u.hostname}`);
  if ((init?.method ?? "GET") !== "GET") throw new Error("escrita no provider");
  if (u.pathname !== "/orders/search") return { ok: false, status: 404, json: async () => ({}) } as any;
  buscas.push(u);
  if (falharBusca > 0) { falharBusca--; return { ok: false, status: 500, json: async () => ({}) } as any; }
  const de = Date.parse(u.searchParams.get("order.date_closed.from") ?? ""), ate = Date.parse(u.searchParams.get("order.date_closed.to") ?? "");
  const desc = u.searchParams.get("sort") === "date_desc";
  const todos = Object.values(pedidosML).filter((o: any) => { const x = Date.parse(o.date_closed); return x >= de && x <= ate + 3600_000; })
    .sort((a: any, b: any) => (desc ? -1 : 1) * (Date.parse(a.date_closed) - Date.parse(b.date_closed)));
  const off = Number(u.searchParams.get("offset") ?? 0), lim = Number(u.searchParams.get("limit") ?? 50);
  return { ok: true, status: 200, json: async () => ({ results: todos.slice(off, off + lim), paging: { total: todos.length, offset: off, limit: lim } }) } as any;
}) as any;

const brt = (dia: string, hora: string) => new Date(Date.parse(`${dia}T${hora}.000-03:00`)).toISOString();
const pagto = (status: string, quando: string | null) => ({ status, date_approved: quando, transaction_amount: 10 });
let nId = 2000019000000000;
function pedido(extra: Record<string, any> = {}): any {
  const id = String(++nId);
  const fechado = extra.date_closed ?? brt("2026-09-10", "12:00:00");
  return { id: Number(id), status: "paid", pack_id: null, shipping: { id: 46000000000 + (nId % 1000) }, total_amount: 20, paid_amount: 20,
    date_created: fechado, date_closed: fechado, last_updated: fechado,
    order_items: [{ item: { id: "MLB111", title: "Produto Teste", variation_id: null, seller_sku: "SKU-1" }, quantity: 1, unit_price: 20, sale_fee: 2.6 }],
    payments: [pagto("approved", fechado)], buyer: { id: 999, nickname: "COMPRADOR_NAO_PODE_VAZAR" }, ...extra };
}
const add = (...ps: any[]) => { for (const p of ps) pedidosML[String(p.id)] = p; return ps.map((p) => String(p.id)); };

const lojaML = () => ({ id: ML_A, user_id: U, marketplace: "ML", ativo: true, nickname: "MONAMOR", nome: "MONAMOR", seller_id: "744240004", access_token: TOKEN_A, refresh_token: "<R>", token_expires_at: FUTURO(), created_at: "2026-01-01", partner_id: null, partner_key: null });
const jobFechamento = (ini: string, fim: string, extra: Record<string, unknown> = {}) => ({ id: `job-${++seq}`, user_id: U, loja_id: ML_A, marketplace: "ML", tipo: "backfill",
  campo_tempo: "date_closed", janela_inicio: ini, janela_fim: fim, listagem_completa: true, status: "concluido", concluido_em: OBS, criado_em: OBS, date_from: null, date_to: null, ...extra });

// Setembro/2026 (fixture sanitizada): população do painel por date_closed + 134 pack_splitted sintéticos (que NÃO contam)
const FX = JSON.parse(readFileSync(join(process.cwd(), "scripts/fixtures/ml-setembro-2026-fechamento.json"), "utf8"));
function corpusSetembro(): Linha[] {
  const out: Linha[] = [];
  for (const [dia, lista] of Object.entries(FX.dias as Record<string, string>)) {
    lista.split(",").forEach((x, i) => { const [u, cents] = x.split(":"); out.push({ user_id: U, loja_id: ML_A, order_id: `${dia}#${i}`,
      date_closed: `${dia}T15:00:00.000Z`, cancel_detail_code: null, total_amount: Number(cents) / 100, unidades: Number(u), fetched_at: OBS }); });
  }
  for (let i = 0; i < 134; i++) out.push({ user_id: U, loja_id: ML_A, order_id: `ps#${i}`, date_closed: `2026-09-${String(1 + (i % 30)).padStart(2, "0")}T16:00:00.000Z`,
    cancel_detail_code: "pack_splitted", total_amount: 99.99, unidades: 3, fetched_at: OBS });
  return out;
}
const SET_INI = "2026-09-01T03:00:00.000Z", SET_FIM = "2026-10-01T03:00:00.000Z";
const semear = (jobs: Linha[] = [jobFechamento(SET_INI, SET_FIM)]) => {
  db = { lojas: [lojaML()], ml_pedidos: corpusSetembro(), sync_jobs: jobs, anuncios: [],
    // LEGADO com status/data velhos: nunca pode aparecer na métrica nem na tabela
    pedidos: [{ id: "leg-1", user_id: U, marketplace: "ML", loja_id: ML_A, order_id: "LEGADO", status: "paid", data: "2026-09-03", data_criacao: "2026-09-03", data_pagamento: "2026-09-03", qtd: 999, faturamento: 99999 }] };
  lidas = []; buscas = []; pedidosML = {}; falharTabela = null; falharBusca = 0;
};
const c = (v: number) => Math.round(v * 100);

async function principal() {
  const silenciar = () => { console.log = () => {}; console.error = () => {}; console.warn = () => {}; };
  const restaurar = () => { console.log = imprimir; };
  const auth = await import("../lib/autenticacao");
  const MH = await import("../lib/vendas/ml-metricas-hibridas");
  const TB = await import("../lib/vendas/ml-tabela-provider");
  const MV = await import("../lib/vendas/metricas-ml");
  const HP = await import("../app/(app)/vendas/ml-provider");
  const rotaMetricas = await import("../app/api/ml/vendas/metricas/route");
  const rotaPedidos = await import("../app/api/ml/vendas/pedidos/route");
  const G2 = await import("./_guard-v2");
  const cab = { cookie: `cds_session=${(await auth.emitirTokenSessao(U)).token}` };
  const fonte = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");
  const cliente = () => clienteFalso() as any;
  let revalidacoes: any[] = [];
  const revalidarFalso = async (a: any) => { revalidacoes.push(a); return "JOB_CRIADO" as const; };
  const metricas = async (de: string, ate: string, extra: Record<string, unknown> = {}) => {
    silenciar(); try { return await MH.metricasHibridasML({ userId: U, lojaId: ML_A, de, ate }, { cliente: cliente(), agoraMs: AGORA, revalidar: revalidarFalso, ...extra }); } finally { restaurar(); }
  };
  const pagina = async (de: string, ate: string, visao: "fechamento" | "pago", cursor: { dia: string; offset: number } | null = null) => {
    silenciar(); try { return await TB.lerPaginaTabelaML({ userId: U, lojaId: ML_A, de, ate, visao, cursor }, { cliente: cliente() }); } finally { restaurar(); }
  };
  const tudo = async (de: string, ate: string, visao: "fechamento" | "pago") => {
    const linhas: any[] = []; let cur: any = null, n = 0;
    do { const p = await pagina(de, ate, visao, cur); assert(p.erro === null, `erro ${p.erro}`); linhas.push(...p.linhas); cur = p.proximoCursor; } while (cur && ++n < 200);
    return linhas;
  };
  const getRota = async (mod: any, q: string) => { silenciar(); try { const r = await mod.GET(new Request(`https://x.test/api?${q}`, { headers: cab })); return { status: r.status, corpo: await r.json() as any, texto: "" }; } finally { restaurar(); } };

  secao("\n[A. métricas ML — serviço canônico]");
  t("HYB-1/6. COMPLETE usa o serviço canônico: setembro = 10896 / 11358 / 393745,59 (fonte CANONICO, sem 'ao vivo')", async () => {
    semear(); revalidacoes = [];
    const m = await metricas("2026-09-01", "2026-09-30");
    assert(m.estado === "COMPLETE" && m.fonte === "CANONICO" && m.metricas !== null, JSON.stringify({ e: m.estado, c: m.estadoCanonico }));
    assert(m.metricas.vendas === 10896 && m.metricas.unidades === 11358 && c(m.metricas.vendasBrutas) === 39374559, JSON.stringify(m.metricas));
    assert(m.metricas.vendas === FX.canonico.vendas && Math.round(m.metricas.vendasBrutas) === FX.painel_ml.vendas_brutas_painel, "fixture/painel");
    assert(lidas.includes("ml_pedidos") && m.dias.confirmados === 30 && m.dias.total === 30 && typeof m.estadoEm === "string" && m.observadoAte === null, JSON.stringify(m.dias));
    assert(HP.rotuloMetricasML(m as any) === "Mercado Livre · dados confirmados", HP.rotuloMetricasML(m as any));
  });
  t("HYB-2. COMPLETE não consulta o legado `pedidos` nem o provider (função e rota GET /api/ml/vendas/metricas)", async () => {
    semear();
    await metricas("2026-09-01", "2026-09-30");
    assert(!lidas.includes("pedidos") && buscas.length === 0, `lidas=${[...new Set(lidas)]} buscas=${buscas.length}`);
    lidas = [];
    const r = await getRota(rotaMetricas, `loja_id=${ML_A}&de=2026-09-01&ate=2026-09-30`);
    assert(r.status === 200 && r.corpo.estado === "COMPLETE" && r.corpo.metricas.vendas === 10896 && r.corpo.lojaId === ML_A, JSON.stringify(r.corpo).slice(0, 200));
    assert(!lidas.includes("pedidos") && buscas.length === 0 && !JSON.stringify(r.corpo).includes(TOKEN_A), `lidas=${[...new Set(lidas)]}`);
    const leg = fonte("app/api/ml/vendas/route.ts");
    assert(!/metricasML|metricasBrutasML|linhasCriacao/.test(leg), "rota legada ainda calcula métrica ML sobre pedidos");
  });
  t("HYB-3. PARTIAL não é final: sem número, 'Carregando… X/Y dias' e revalidação pelo coordenador", async () => {
    semear([jobFechamento(SET_INI, "2026-09-11T03:00:00.000Z")]); revalidacoes = [];
    const m = await metricas("2026-09-01", "2026-09-30");
    assert(m.estado === "PARTIAL" && m.metricas === null && m.dias.confirmados === 10 && m.dias.total === 30, JSON.stringify({ e: m.estado, d: m.dias }));
    assert(HP.rotuloMetricasML(m as any) === "Carregando dados do Mercado Livre — 10/30 dias" && HP.cardsMetricasML(m as any).length === 0, HP.rotuloMetricasML(m as any));
    assert(revalidacoes.length === 1 && revalidacoes[0].de === "2026-09-01" && revalidacoes[0].ate === "2026-09-30" && m.revalidacao === "JOB_CRIADO", JSON.stringify(revalidacoes));
  });
  t("HYB-3b. refresh = MECANISMO EXISTENTE: coordenador real cria UM sync_job date_closed (flag canônica ligada); desligada só avalia", async () => {
    semear([jobFechamento(SET_INI, "2026-09-11T03:00:00.000Z")]);
    silenciar(); let m: any;
    try { m = await MH.metricasHibridasML({ userId: U, lojaId: ML_A, de: "2026-09-01", ate: "2026-09-30" }, { cliente: cliente(), agoraMs: AGORA, habilitado: false }); } finally { restaurar(); }
    assert(m.revalidacao === "DESABILITADO" && db.sync_jobs.length === 1, `${m.revalidacao} jobs=${db.sync_jobs.length}`);
    silenciar();
    try { m = await MH.metricasHibridasML({ userId: U, lojaId: ML_A, de: "2026-09-01", ate: "2026-09-30" }, { cliente: cliente(), agoraMs: AGORA, habilitado: true }); } finally { restaurar(); }
    const novos = db.sync_jobs.filter((j) => j.status === "pendente");
    assert(m.revalidacao === "JOB_CRIADO" && novos.length === 1 && novos[0].campo_tempo === "date_closed" && novos[0].loja_id === ML_A && novos[0].marketplace === "ML", `${m.revalidacao} ${JSON.stringify(novos)}`);
    assert(!lidas.includes("pedidos") && buscas.length === 0, "refresh tocou legado/provider direto");
  });
  t("HYB-4. FAILED → indisponível: janela de ingestão com erro, ou leitura do corpus falhando — sem número, sem exceção", async () => {
    semear([jobFechamento(SET_INI, "2026-09-11T03:00:00.000Z"), jobFechamento("2026-09-11T03:00:00.000Z", SET_FIM, { status: "erro", listagem_completa: false })]);
    const m = await metricas("2026-09-01", "2026-09-30");
    assert(m.estado === "FAILED" && m.metricas === null && HP.rotuloMetricasML(m as any) === "Dados do Mercado Livre indisponíveis", JSON.stringify({ e: m.estado, c: m.estadoCanonico }));
    semear(); falharTabela = "ml_pedidos";
    const f = await metricas("2026-09-01", "2026-09-30");
    assert(f.estado === "FAILED" && f.metricas === null && f.estadoCanonico === "ERRO", JSON.stringify({ e: f.estado, c: f.estadoCanonico }));
    assert(HP.rotuloMetricasML(HP.METRICAS_ML_INDISPONIVEIS) === "Dados do Mercado Livre indisponíveis", "rótulo de falha");
  });
  t("HYB-4b. período com HOJE: número confirmado só até o observado ('até HH:MM'); sem prova do dia → PARTIAL", async () => {
    semear([jobFechamento("2026-10-01T03:00:00.000Z", "2026-10-15T03:00:00.000Z"), jobFechamento("2026-10-15T03:00:00.000Z", "2026-10-15T14:00:00.000Z")]);
    db.ml_pedidos = [{ user_id: U, loja_id: ML_A, order_id: "h1", date_closed: "2026-10-15T12:00:00.000Z", cancel_detail_code: null, total_amount: 10, unidades: 1, fetched_at: "2026-10-15T14:30:00.000Z" }];
    const m = await metricas("2026-10-15", "2026-10-15");
    assert(m.estado === "COMPLETE" && m.observadoAte === "2026-10-15T14:00:00.000Z" && m.metricas?.vendas === 1, JSON.stringify({ e: m.estado, o: m.observadoAte, c: m.estadoCanonico }));
    assert(HP.rotuloMetricasML(m as any).startsWith("Mercado Livre · dados confirmados até "), HP.rotuloMetricasML(m as any));
    db.sync_jobs = [jobFechamento("2026-10-01T03:00:00.000Z", "2026-10-15T03:00:00.000Z")];
    const p = await metricas("2026-10-15", "2026-10-15");
    assert(p.estado === "PARTIAL" && p.metricas === null, JSON.stringify({ e: p.estado, c: p.estadoCanonico }));
  });
  t("HYB-8. sem card de canceladas: os cards do ML são SÓ Vendas / Unidades / Vendas brutas", async () => {
    semear();
    const m = await metricas("2026-09-01", "2026-09-30");
    assert(JSON.stringify(HP.cardsMetricasML(m as any).map((x) => x.label)) === JSON.stringify(["Vendas", "Unidades", "Vendas brutas"]), "cards");
    const pg = fonte("app/(app)/vendas/page.tsx");
    assert(!/Canceladas ML/.test(pg) && !/canceladas/i.test(JSON.stringify(m)), "card/dado de canceladas do ML exposto");
  });

  secao("\n[B. tabela ML — provider]");
  t("HYB-5. base date_closed BRT: busca por order.date_closed; pedido CRIADO em agosto e FECHADO em 01/09 entra em 01/09; borda +1 h não duplica", async () => {
    semear();
    const [criadoAntes] = add(pedido({ date_created: brt("2026-08-31", "23:50:00"), date_closed: brt("2026-09-01", "00:10:00") }));
    const [fimDoDia] = add(pedido({ date_closed: brt("2026-09-01", "23:59:00") }));
    const [diaSeguinte] = add(pedido({ date_closed: brt("2026-09-02", "00:30:00") }));   // o ML devolve na busca de 01/09 também
    const l = await tudo("2026-09-01", "2026-09-02", "fechamento");
    const por = (id: string) => l.filter((x) => x.orderId === id);
    assert(por(criadoAntes).length === 1 && por(criadoAntes)[0].dataFechamento === "2026-09-01", JSON.stringify(por(criadoAntes)));
    assert(por(fimDoDia)[0]?.dataFechamento === "2026-09-01" && por(diaSeguinte).length === 1 && por(diaSeguinte)[0].dataFechamento === "2026-09-02", "borda");
    assert(buscas.every((u) => u.searchParams.has("order.date_closed.from") && !u.searchParams.has("order.date_created.from") && !u.searchParams.has("order.status")), "busca fora de date_closed");
  });
  t("HYB-7. pack_splitted fora da tabela (regra canônica); cancelamento comercial fica (status do provider)", async () => {
    semear();
    const [ps, canc] = add(pedido({ status: "cancelled", cancel_detail: { group: "internal", code: "pack_splitted" }, payments: [pagto("refunded", null)] }),
      pedido({ status: "cancelled", cancel_detail: { group: "buyer", code: "buyer_cancel_express" }, payments: [pagto("refunded", null)] }));
    const l = await tudo("2026-09-10", "2026-09-10", "fechamento");
    assert(!l.some((x) => x.orderId === ps) && l.find((x) => x.orderId === canc)?.status === "devolucao", JSON.stringify(l.map((x) => [x.orderId, x.status])));
  });
  t("HYB-9. a tabela ignora status/data VELHOS do legado: o provider vence (e `pedidos` nem é lido)", async () => {
    semear();
    const [o] = add(pedido({ status: "cancelled", date_closed: brt("2026-09-05", "10:00:00"), cancel_detail: { group: "buyer", code: "buyer_cancel_express" }, payments: [pagto("refunded", null)] }));
    db.pedidos.push({ id: "leg-2", user_id: U, marketplace: "ML", loja_id: ML_A, order_id: o, status: "paid", data: "2026-09-03", data_criacao: "2026-09-03", data_pagamento: "2026-09-03", qtd: 1, faturamento: 20 });
    lidas = [];
    const l = await tudo("2026-09-01", "2026-09-30", "fechamento");
    const r = l.filter((x) => x.orderId === o);
    assert(r.length === 1 && r[0].status === "devolucao" && r[0].dataFechamento === "2026-09-05" && r[0].origem === "PROVIDER", JSON.stringify(r));
    assert(!lidas.includes("pedidos") && !l.some((x) => x.orderId === "LEGADO"), `lidas=${[...new Set(lidas)]}`);
    const pago = await tudo("2026-09-03", "2026-09-03", "pago");
    assert(!pago.some((x) => x.orderId === o), "pago velho do banco venceu o provider");
    const row = HP.linhaProviderParaVendaRow(r[0], "fechamento");
    assert(row?.status === "devolucao" && row.data === "2026-09-05" && row.frete === null, JSON.stringify(row));
  });
  t("HYB-10. visão paga: candidatos por date_closed no período ±1 dia BRT; entra só se a aprovação (BRT) cai no período", async () => {
    semear();
    const [antes, dentro, depoisAprov] = add(
      pedido({ date_closed: brt("2026-09-09", "23:59:00"), payments: [pagto("approved", brt("2026-09-10", "00:01:00"))] }),
      pedido({ date_closed: brt("2026-09-10", "15:00:00"), payments: [pagto("approved", brt("2026-09-10", "15:00:01"))] }),
      pedido({ date_closed: brt("2026-09-10", "23:58:00"), payments: [pagto("approved", brt("2026-09-11", "00:05:00"))] }));
    const [longe] = add(pedido({ date_closed: brt("2026-09-07", "12:00:00"), payments: [pagto("approved", brt("2026-09-10", "12:00:00"))] }));
    const l = await tudo("2026-09-10", "2026-09-10", "pago");
    const ids = new Set(l.map((x) => x.orderId));
    assert(ids.has(antes) && ids.has(dentro) && !ids.has(depoisAprov) && !ids.has(longe), JSON.stringify([...ids]));
    assert(l.every((x) => x.dataPagamento === "2026-09-10"), "data de pagamento fora do período");
    const dias = buscas.map((u) => (u.searchParams.get("order.date_closed.from") ?? "").slice(0, 10));
    assert(JSON.stringify([...new Set(dias)]) === JSON.stringify(["2026-09-11", "2026-09-10", "2026-09-09"]), `dias=${dias}`);
  });
  t("HYB-11. in_mediation com date_approved válido é aprovação elegível (visão paga)", async () => {
    semear();
    const [o] = add(pedido({ payments: [pagto("in_mediation", brt("2026-09-10", "12:00:01"))] }));
    const [semData] = add(pedido({ payments: [pagto("in_mediation", null)] }));
    const l = await tudo("2026-09-10", "2026-09-10", "pago");
    assert(l.some((x) => x.orderId === o) && !l.some((x) => x.orderId === semData), JSON.stringify(l.map((x) => x.orderId)));
  });
  t("HYB-12. partially_refunded (pedido e pagamento) → paid na visão paga (status fix c03c47d preservado)", async () => {
    semear();
    const [o] = add(pedido({ status: "partially_refunded", payments: [pagto("partially_refunded", brt("2026-09-10", "12:00:01"))] }));
    const l = await tudo("2026-09-10", "2026-09-10", "pago");
    assert(l.find((x) => x.orderId === o)?.status === "paid", JSON.stringify(l));
    assert(MV.statusPedidoML("partially_refunded", {}) === "paid" && /fetchOrdersRange\(\s*sellerId, token!,[\s\S]{0,120}?\)\.catch/.test(fonte("lib/sync-ml.ts")) && !/STATUSES\.map/.test(fonte("lib/sync-ml.ts")), "status fix do sync");
  });
  t("HYB-13. vários pagamentos: vale a aprovação elegível MAIS ANTIGA (por instante, não pela ordem do array nem pelo offset)", async () => {
    semear();
    const [o] = add(pedido({ date_closed: brt("2026-09-10", "23:00:00"), payments: [pagto("approved", brt("2026-09-11", "10:00:00")), pagto("rejected", brt("2026-09-09", "10:00:00")), pagto("approved", "2026-09-10T22:00:00.000-04:00")] }));
    assert(MV.aprovacaoElegivelMaisAntigaML(pedidosML[o].payments) === "2026-09-11T02:00:00.000Z", String(MV.aprovacaoElegivelMaisAntigaML(pedidosML[o].payments)));
    const l10 = await tudo("2026-09-10", "2026-09-10", "pago"), l11 = await tudo("2026-09-11", "2026-09-11", "pago");
    assert(l10.find((x) => x.orderId === o)?.dataPagamento === "2026-09-10" && !l11.some((x) => x.orderId === o), "mais antiga não decidiu o dia");
    assert(MV.aprovacaoElegivelMaisAntigaML([pagto("approved", "lixo"), pagto("pending", "2026-09-01T00:00:00Z")]) === null && MV.aprovacaoElegivelMaisAntigaML(undefined) === null, "inelegível virou data");
  });
  t("HYB-14. status desconhecido → fail-closed: nunca pago; na tela não vira linha", async () => {
    semear();
    const [inv, nada] = add(pedido({ status: "invalid" }), pedido({ status: "status_novo_do_ml" }));
    const pago = await tudo("2026-09-10", "2026-09-10", "pago");
    assert(!pago.some((x) => x.orderId === inv || x.orderId === nada), "desconhecido virou pago");
    const f = await tudo("2026-09-10", "2026-09-10", "fechamento");
    const l = f.find((x) => x.orderId === inv);
    assert(l && l.status === null && HP.linhaProviderParaVendaRow(l, "fechamento") === null, JSON.stringify(l));
  });
  t("HYB-15. custo de Meus Produtos (custo + insumos por unidade, imposto %); custo DESCONHECIDO nunca é zero", async () => {
    semear();
    db.anuncios = [{ id: "an-1", user_id: U, marketplace: "ML", loja_id: ML_A, ml_item_id: "MLB111", variation_id: null, custo_produto: 8, insumos: 1, imposto: 10 }];
    const [comCusto] = add(pedido({ order_items: [{ item: { id: "MLB111", title: "A", variation_id: null }, quantity: 2, unit_price: 20, sale_fee: 2.6 }] }));
    const [semCusto] = add(pedido({ order_items: [{ item: { id: "MLB999", title: "B", variation_id: null }, quantity: 1, unit_price: 20, sale_fee: 2.6 }] }));
    const l = await tudo("2026-09-10", "2026-09-10", "fechamento");
    const a = l.find((x) => x.orderId === comCusto)!.financeiro, b = l.find((x) => x.orderId === semCusto)!.financeiro;
    assert(a && c(a.custoProduto) === 1800 && c(a.imposto) === 400 && c(a.tarifa) === 520 && c(a.lucro) === 4000 - 520 - 1800 - 400, JSON.stringify(a));
    assert(b && b.custoProduto === null && b.lucro === null && b.custoStatus === "PRODUCT_NOT_FOUND" && b.pendencias.includes("custo"), JSON.stringify(b));
    assert(lidas.includes("anuncios"), "Meus Produtos não lido");
  });
  t("HYB-16. UMA regra canônica: guard I18 limpo; pack_splitted/calcularMetricasML só na camada canônica; sem fórmula paralela", async () => {
    const v = G2.mlVendasForaDoCanonico();
    assert(v.length === 0, v.join(" | "));
    assert((MV as any).metricasBrutasML === undefined, "metricasBrutasML ainda exportada");
    const mh = fonte("lib/vendas/ml-metricas-hibridas.ts").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    assert(!/total_amount|\.reduce\(|\+= /.test(mh) && /consultarVendasCanonicas\(/.test(mh), "fórmula própria nas métricas híbridas");
  });
  t("HYB-17. paginação no servidor: ≤ 50 por busca, cursor dia:offset sem perder/duplicar; sale_fee → FEE_PROVIDER_CONFIRMED, sem → FINANCIAL_PENDING (sem tarifa estimada)", async () => {
    semear();
    const ids = add(...Array.from({ length: 120 }, (_, i) => pedido({ date_closed: new Date(Date.parse(brt("2026-09-10", "08:00:00")) + i * 60_000).toISOString() })));
    const [semFee] = add(pedido({ order_items: [{ item: { id: "MLB111", title: "X", variation_id: null }, quantity: 1, unit_price: 20 }] }));
    const p1 = await pagina("2026-09-10", "2026-09-10", "fechamento");
    assert(p1.linhas.length === 50 && p1.proximoCursor?.dia === "2026-09-10" && p1.proximoCursor.offset === 50 && buscas.every((u) => Number(u.searchParams.get("limit")) <= 50), JSON.stringify(p1.proximoCursor));
    const l = await tudo("2026-09-10", "2026-09-10", "fechamento");
    const vistos = l.map((x) => x.orderId);
    assert(vistos.length === 121 && new Set(vistos).size === 121 && ids.every((i) => vistos.includes(i)), `${vistos.length}/${new Set(vistos).size}`);
    const pend = l.find((x) => x.orderId === semFee)!;
    assert(pend.estadoFinanceiro === "FINANCIAL_PENDING" && pend.saleFeeUnitario === null && pend.financeiro?.lucro === null && pend.financeiro?.tarifa === 0 && pend.financeiro?.pendencias.includes("financeiro"), JSON.stringify(pend.financeiro));
    assert(l.filter((x) => x.orderId !== semFee).every((x) => x.estadoFinanceiro === "FEE_PROVIDER_CONFIRMED" && x.saleFeeUnitario === 2.6 && x.financeiro?.tarifaOrigem === "real"), "fee do provider");
    assert(TB.lerCursorTabelaML("2026-09-10:50")?.toString() !== "INVALIDO" && TB.lerCursorTabelaML("x") === "INVALIDO" && TB.lerCursorTabelaML("2026-09-10:10000") === "INVALIDO", "cursor");
  });
  t("HYB-17b. falha do provider: o cursor fica onde estava (nada pulado) e a linha do banco NÃO entra no lugar", async () => {
    semear(); add(pedido());
    falharBusca = 3;
    const p = await pagina("2026-09-10", "2026-09-10", "fechamento");
    assert(p.erro !== null && p.linhas.length === 0 && p.proximoCursor?.dia === "2026-09-10" && p.proximoCursor.offset === 0, JSON.stringify({ e: p.erro, c: p.proximoCursor }));
  });
  t("HYB-ROTA. GET /api/ml/vendas/pedidos: origem PROVIDER, cursor em texto, sem token nem comprador; parâmetros inválidos → 400", async () => {
    semear(); add(pedido(), pedido());
    const r = await getRota(rotaPedidos, `loja_id=${ML_A}&de=2026-09-10&ate=2026-09-10&visao=fechamento`);
    const txt = JSON.stringify(r.corpo);
    assert(r.status === 200 && r.corpo.origem === "PROVIDER" && r.corpo.linhas.length === 2 && r.corpo.proximoCursor === null, txt.slice(0, 200));
    assert(!txt.includes(TOKEN_A) && !txt.includes("COMPRADOR_NAO_PODE_VAZAR") && !/buyer|nickname/.test(txt), "vazou token/comprador");
    assert((await getRota(rotaPedidos, `loja_id=${ML_A}&de=2026-09-10&ate=2026-09-10&cursor=lixo`)).status === 400, "cursor inválido aceito");
    assert((await getRota(rotaPedidos, `loja_id=${ML_A}&de=2026-09-11&ate=2026-09-10`)).status === 400, "período invertido aceito");
  });

  await fila;
  imprimir(`\n${falhou === 0 ? "✓" : "✗"} VENDAS-ML-HIBRIDO — ${ok} passaram, ${falhou} falharam`);
  process.exit(falhou === 0 ? 0 : 1);
}
principal().catch((e) => { console.log = imprimir; imprimir(`ERRO FATAL: ${e?.stack ?? e}`); process.exit(1); });
