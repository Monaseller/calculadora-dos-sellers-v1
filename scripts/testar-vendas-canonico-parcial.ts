/**
 * SALES-CANONICAL-D14 — metricas PARCIAIS do periodo aberto (offline).
 *
 * Periodo com hoje = parte FECHADA [de, ontem] (semantica normal dos
 * leitores) + parte ATUAL [hoje 00:00, observadoAte), onde observadoAte vem
 * SO do alcance da cadeia de janelas de descoberta completas (sync_jobs) —
 * nunca do relogio, nunca da existencia de linhas.
 *
 * Em PRODUCAO nenhuma janela cobre hoje (o planejador fecha ate ontem): o
 * resultado real hoje e PARTIAL_SEM_OBSERVACAO_ATUAL. As fixtures abaixo
 * simulam a janela de hoje para provar o contrato.
 *
 * Uso: npx tsx scripts/testar-vendas-canonico-parcial.ts
 */
import "./_server-only-inerte";

let passou = 0, falhou = 0;
let fila: Promise<void> = Promise.resolve();
function t(nome: string, fn: () => void | Promise<void>) {
  fila = fila.then(async () => {
    try { await fn(); passou++; console.log(`  PASS  ${nome}`); }
    catch (e: any) { falhou++; console.log(`  FALHA ${nome} -> ${e?.message ?? e}`); }
  });
}
function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }

let fetches = 0;
(globalThis as any).fetch = async () => { fetches++; throw new Error("REDE_PROIBIDA"); };

// ── duplo do Supabase (mesmo do servico D13) ──
type Reg = { tabela: string; filtros: [string, string, unknown][]; head?: boolean };
const ESCRITAS = ["insert", "update", "upsert", "delete"];
const escritas: string[] = [];
function clienteFalso(dados: Record<string, any[]>, regs: Reg[] = []) {
  const cmp = (x: any, v: any, f: (a: any, b: any) => boolean) => x !== null && x !== undefined && f(x, v);
  return {
    rpc(nome: string) { escritas.push(`rpc:${nome}`); return Promise.resolve({ data: null, error: { message: "proibido" } }); },
    from(tabela: string) {
      const r: Reg = { tabela, filtros: [] }; regs.push(r);
      const casa = (l: any) => r.filtros.every(([op, col, v]: any) => {
        if (op === "eq") return String(l[col]) === String(v);
        if (op === "in") return (v as any[]).map(String).includes(String(l[col]));
        if (op === "gte") return cmp(l[col], v, (a, b) => a >= b);
        if (op === "gt") return cmp(l[col], v, (a, b) => a > b);
        if (op === "lt") return cmp(l[col], v, (a, b) => a < b);
        if (op === "is") return (l[col] ?? null) === v;
        if (op === "not") { const [o, val] = v as [string, any];
          if (o === "is") return (l[col] ?? null) !== val;
          if (o === "in") return !String(val).replace(/[()]/g, "").split(",").includes(String(l[col]));
          return true; }
        return true;
      });
      const linhas = () => (dados[tabela] ?? []).filter(casa);
      const c: any = new Proxy({}, { get(_a, p: string) {
        if (p === "then") return (ok: any, ko: any) => Promise.resolve(r.head ? { data: null, count: linhas().length, error: null } : { data: linhas(), error: null }).then(ok, ko);
        if (p === "range") return (a: number, b: number) => Promise.resolve({ data: linhas().slice(a, b + 1), error: null });
        if (p === "select") return (_c: string, o?: { head?: boolean }) => { if (o?.head) r.head = true; return c; };
        if (ESCRITAS.includes(p)) return () => { escritas.push(`${p}:${tabela}`); return c; };
        return (...args: any[]) => {
          if (["eq", "in", "gte", "lt", "gt", "is"].includes(p)) r.filtros.push([p, args[0], args[1]]);
          if (p === "not") r.filtros.push(["not", args[0], [args[1], args[2]]]);
          return c;
        };
      } });
      return c;
    },
  } as any;
}

// ── mundo: hoje = 07/10/2026 (SP), agora = 12:00 SP ──
const AGORA = Date.parse("2026-10-07T15:00:00.000Z");
const HOJE0 = "2026-10-07T03:00:00.000Z";                     // 07/10 00:00 SP
const DONO = "dono-a", OUTRO = "dono-b";
const ML1 = "aaaaaaaa-0000-4000-8000-000000000001", SH1 = "aaaaaaaa-0000-4000-8000-000000000002", SH2 = "aaaaaaaa-0000-4000-8000-000000000003";
const ML_X = "bbbbbbbb-0000-4000-8000-000000000001", SH_X = "bbbbbbbb-0000-4000-8000-000000000002";
const mais = (iso: string, min: number) => new Date(Date.parse(iso) + min * 60000).toISOString();
const cred = { access_token: "tk", refresh_token: "rt", token_expires_at: "2030-01-01T00:00:00Z" };
const loja = (id: string, user_id: string, marketplace: "ML" | "Shopee", seller_id: string) =>
  ({ id, user_id, marketplace, ativo: true, seller_id, partner_id: marketplace === "Shopee" ? 9 : null, partner_key: marketplace === "Shopee" ? "pk" : null, ...cred });
const job = (lojaId: string, user_id: string, marketplace: "ML" | "Shopee", inicio: string, fim: string, concl: string, extra: Record<string, unknown> = {}) =>
  ({ id: `job-${lojaId}-${inicio}`, user_id, loja_id: lojaId, marketplace, campo_tempo: marketplace === "ML" ? "date_closed" : "create_time",
    janela_inicio: inicio, janela_fim: fim, listagem_completa: true, status: "concluido", concluido_em: concl, criado_em: concl, ...extra });
const pedML = (lojaId: string, user_id: string, id: string, closed: string, total: number, unidades: number, fetched: string) =>
  ({ user_id, loja_id: lojaId, order_id: id, date_closed: closed, cancel_detail_code: null, total_amount: total, unidades, fetched_at: fetched });
const pedSH = (lojaId: string, user_id: string, sn: string, pay: string, valor: number, fetched: string) => ({
  sp: { user_id, loja_id: lojaId, order_sn: sn, order_status: "COMPLETED", create_time: mais(pay, -30), pay_time: pay, update_time: pay,
    detail_fetched_at: fetched, escrow_fetched_at: fetched, escrow_update_time: pay, original_shopee_discount: 0, pix_discount: 0, escrow_pendente: false },
  item: { user_id, marketplace: "Shopee", loja_id: lojaId, order_id: sn, qtd: 1, valor_unit: valor, escrow_voucher_seller: 0, escrow_voucher_shopee: 0, escrow_coin: 0 },
});

interface OpcoesMundo { asOf?: Record<string, string | null>; semVendasHoje?: boolean; buracoML?: boolean }
const ASOF = "2026-10-07T14:00:00.000Z";                     // 11:00 SP — 1h antes de agora (FRESH)
function mundo(o: OpcoesMundo = {}) {
  const asOf = (id: string) => (o.asOf && id in o.asOf ? o.asOf[id] : ASOF);
  const d: Record<string, any[]> = { lojas: [loja(ML1, DONO, "ML", "111"), loja(SH1, DONO, "Shopee", "333"), loja(SH2, DONO, "Shopee", "444"),
    loja(ML_X, OUTRO, "ML", "111"), loja(SH_X, OUTRO, "Shopee", "333")], ml_pedidos: [], shopee_pedidos: [], pedidos: [], sync_jobs: [] };
  const fetchedDe = (id: string) => mais(asOf(id) ?? ASOF, 10);
  // ML: parte fechada 01–06/10 (com ou sem buraco em 03/10) + janela de HOJE ate asOf
  for (const [id, dono, k] of [[ML1, DONO, 1], [ML_X, OUTRO, 100]] as const) {
    const f = fetchedDe(id);
    if (o.buracoML && id === ML1) d.sync_jobs.push(job(id, dono, "ML", "2026-10-01T03:00:00.000Z", "2026-10-03T03:00:00.000Z", f), job(id, dono, "ML", "2026-10-04T03:00:00.000Z", HOJE0, f));
    else d.sync_jobs.push(job(id, dono, "ML", "2026-10-01T03:00:00.000Z", HOJE0, f));
    if (asOf(id)) d.sync_jobs.push(job(id, dono, "ML", HOJE0, asOf(id)!, f));
    d.ml_pedidos.push(pedML(id, dono, "1", "2026-10-02T15:00:00.000Z", 499.95 * k, 1, f), pedML(id, dono, "2", "2026-10-05T15:00:00.000Z", 500.05 * k, 2, f));
    if (!o.semVendasHoje) d.ml_pedidos.push(pedML(id, dono, "3", "2026-10-07T03:30:00.000Z", 120.1 * k, 1, f), pedML(id, dono, "4", "2026-10-07T04:00:00.000Z", 79.9 * k, 1, f));
    // linha DEPOIS do observado (asOf): nunca entra no prefixo
    d.ml_pedidos.push(pedML(id, dono, "5", "2026-10-07T14:30:00.000Z", 999, 1, f));
  }
  // Shopee: parte fechada (create_time desde 20/09) + janela de HOJE ate asOf
  const hojeSH: Record<string, number[]> = { [SH1]: [60, 40], [SH2]: [50], [SH_X]: [7000] };
  for (const [id, dono] of [[SH1, DONO], [SH2, DONO], [SH_X, OUTRO]] as const) {
    const f = fetchedDe(id);
    d.sync_jobs.push(job(id, dono, "Shopee", "2026-09-20T03:00:00.000Z", HOJE0, f));
    if (asOf(id)) d.sync_jobs.push(job(id, dono, "Shopee", HOJE0, asOf(id)!, f));
    const ps = [
      ...(id === SH1 ? [pedSH(id, dono, "C1", "2026-10-03T15:00:00.000Z", 600, f), pedSH(id, dono, "C2", "2026-10-06T15:00:00.000Z", 400, f)] : []),
      ...(o.semVendasHoje ? [] : hojeSH[id].map((v, i) => pedSH(id, dono, `H${i}`, mais(HOJE0, 40 + i * 20), v, f))),
      pedSH(id, dono, "DEPOIS", "2026-10-07T14:30:00.000Z", 999, f),
    ];
    for (const p of ps) { d.shopee_pedidos.push(p.sp); d.pedidos.push(p.item); }
  }
  return d;
}

async function principal() {
  const V = await import("../lib/vendas/canonico/service");
  const P = await import("../lib/vendas/canonico/periodo");
  const M = await import("../lib/vendas/canonico/ml");
  const S = await import("../lib/vendas/canonico/shopee");
  const q = (args: any, d = mundo(), agoraMs = AGORA, regs: Reg[] = []) => V.consultarVendasCanonicas(args, { cliente: clienteFalso(d, regs), agoraMs });
  const erroDe = async (f: () => Promise<unknown>) => { try { await f(); return "NAO_LANCOU"; } catch (e: any) { return e?.codigo ?? e?.message; } };

  console.log("\n[0. fronteiras do observado (prefixoObservado)]");
  t("0a. alcance null / < inicio / == inicio → SEM_OBSERVACAO; entre → OBSERVADO_ATE; == fim / > fim → DIA_FECHADO", () => {
    const i = new Date(HOJE0), f = new Date("2026-10-08T03:00:00.000Z");
    assert(P.prefixoObservado(null, i, f).estado === "SEM_OBSERVACAO", "null");
    assert(P.prefixoObservado(i.getTime() - 1, i, f).estado === "SEM_OBSERVACAO", "< inicio");
    assert(P.prefixoObservado(i.getTime(), i, f).estado === "SEM_OBSERVACAO", "== inicio (nunca zero inferido)");
    const o = P.prefixoObservado(Date.parse(ASOF), i, f);
    assert(o.estado === "OBSERVADO_ATE" && (o as any).ate.toISOString() === ASOF, JSON.stringify(o));
    assert(P.prefixoObservado(f.getTime(), i, f).estado === "DIA_FECHADO" && P.prefixoObservado(f.getTime() + 1, i, f).estado === "DIA_FECHADO", "fim");
  });

  console.log("\n[A–D. HOJE]");
  t("A. HOJE observado e fresco com vendas → PARTIAL_FRESH, ML 200.00 (linha depois do observado fica fora)", async () => {
    const r = await q({ userId: DONO, marketplace: "mercado_livre", preset: "HOJE" });
    assert(r.estado === "PARTIAL_FRESH" && r.parcial && !r.completo && r.fresco === true && r.observadoAte === ASOF, `${r.estado} ${r.observadoAte}`);
    const m = r.metricas.mercadoLivre!;
    assert(m.vendas === 200 && m.pedidos === 2 && m.unidades === 2 && r.metricas.semVendas === false, JSON.stringify(m));
    assert(r.partes.fechada === null && r.partes.atual!.dia === "2026-10-07" && r.partes.atual!.inicioInclusivo === HOJE0, JSON.stringify(r.partes));
  });
  t("B. HOJE observado com ZERO vendas → metricas zero, semVendas=true, PARTIAL_FRESH", async () => {
    const r = await q({ userId: DONO, marketplace: "todos", preset: "HOJE" }, mundo({ semVendasHoje: true }));
    const c = r.metricas.combinadas!;
    assert(r.estado === "PARTIAL_FRESH" && c.pedidos === 0 && c.vendas === 0 && r.metricas.semVendas === true, JSON.stringify(r.metricas));
  });
  t("C. HOJE NAO observado (linhas existem, janela nao) → PARTIAL_SEM_OBSERVACAO_ATUAL, metricas null (nunca zero)", async () => {
    const r = await q({ userId: DONO, marketplace: "mercado_livre", preset: "HOJE" }, mundo({ asOf: { [ML1]: null } }));
    assert(r.estado === "PARTIAL_SEM_OBSERVACAO_ATUAL" && r.metricas.combinadas === null && r.metricas.semVendas === null && r.fresco === null && r.observadoAte === null, r.estado);
    const l = r.cobertura.lojas[0];
    assert(l.parteAtual!.estado === "NAO_OBSERVADA" && l.parteAtual!.motivos.includes("PARTE_ATUAL_NAO_OBSERVADA") && l.metricas === null, JSON.stringify(l.parteAtual));
  });
  t("C2. janela de hoje existe, mas o prefixo NAO e COMPLETE (estado visto antes do observadoAte) → sem metricas, nunca zero fabricado", async () => {
    const d = mundo(); d.ml_pedidos.find((p) => p.loja_id === ML1 && p.order_id === "3")!.fetched_at = mais(HOJE0, 40);
    const r = await q({ userId: DONO, marketplace: "mercado_livre", preset: "HOJE" }, d);
    assert(r.estado === "PARTIAL_SEM_OBSERVACAO_ATUAL" && r.metricas.combinadas === null && r.metricas.mercadoLivre === null && r.metricas.semVendas === null, `${r.estado} ${JSON.stringify(r.metricas)}`);
    const pa = r.cobertura.lojas[0].parteAtual!;
    assert(pa.estado === "NAO_OBSERVADA" && pa.motivos.includes("PARTE_ATUAL_OBSERVADA_SEM_PROVA_COMPLETA") && pa.motivos.some((m) => m.startsWith("leitor:estado_observado_antes_do_fim_do_periodo")), JSON.stringify(pa));
  });
  t("D. HOJE observado mas VELHO (asOf 02:00 SP, agora 12:00) → PARTIAL_STALE com metricas, fresco=false, motivo estruturado", async () => {
    const velho = "2026-10-07T05:00:00.000Z";
    const r = await q({ userId: DONO, marketplace: "mercado_livre", preset: "HOJE" }, mundo({ asOf: { [ML1]: velho } }));
    assert(r.estado === "PARTIAL_STALE" && r.fresco === false && r.metricas.mercadoLivre!.vendas === 200 && r.observadoAte === velho, `${r.estado} ${JSON.stringify(r.metricas.mercadoLivre)}`);
    assert(r.cobertura.lojas[0].parteAtual!.motivos.includes("PARTE_ATUAL_OBSERVACAO_VELHA"), "motivo");
  });

  console.log("\n[E–J. ESTE_MES / ESTE_ANO / CUSTOM]");
  t("E. ESTE_MES: fechada 1000.00 COMPLETE + hoje 200.00 observado → 1200.00 PARTIAL_FRESH (ML e Shopee)", async () => {
    const ml = await q({ userId: DONO, marketplace: "mercado_livre", preset: "ESTE_MES" });
    assert(ml.estado === "PARTIAL_FRESH" && ml.metricas.mercadoLivre!.vendas === 1200 && ml.metricas.mercadoLivre!.pedidos === 4 && ml.metricas.mercadoLivre!.unidades === 5, `${ml.estado} ${JSON.stringify(ml.metricas.mercadoLivre)}`);
    assert(ml.partes.fechada!.de === "2026-10-01" && ml.partes.fechada!.ate === "2026-10-06", JSON.stringify(ml.partes));
    const sh = await q({ userId: DONO, marketplace: "shopee", lojaId: SH1, preset: "ESTE_MES" });
    assert(sh.estado === "PARTIAL_FRESH" && sh.metricas.shopee!.vendas === 1100 && sh.metricas.shopee!.pedidos === 4, JSON.stringify(sh.metricas.shopee));
  });
  t("E2. ESTE_MES com hoje VELHO → mesmo 1200.00, PARTIAL_STALE", async () => {
    const r = await q({ userId: DONO, marketplace: "mercado_livre", preset: "ESTE_MES" }, mundo({ asOf: { [ML1]: "2026-10-07T05:00:00.000Z" } }));
    assert(r.estado === "PARTIAL_STALE" && r.metricas.mercadoLivre!.vendas === 1200 && r.fresco === false, r.estado);
  });
  t("F. ESTE_MES: fechada COMPLETE + hoje NAO observado → PARTIAL_SEM_OBSERVACAO_ATUAL, metricas null", async () => {
    const r = await q({ userId: DONO, marketplace: "mercado_livre", preset: "ESTE_MES" }, mundo({ asOf: { [ML1]: null } }));
    assert(r.estado === "PARTIAL_SEM_OBSERVACAO_ATUAL" && r.metricas.mercadoLivre === null && r.metricas.combinadas === null, r.estado);
  });
  t("G. ESTE_MES com BURACO em 03/10 + hoje observado (200) → INCOMPLETE, metricas null (nunca 200)", async () => {
    const r = await q({ userId: DONO, marketplace: "mercado_livre", preset: "ESTE_MES" }, mundo({ buracoML: true }));
    assert(r.estado === "INCOMPLETE" && r.cobertura.estado === "INCOMPLETE" && r.metricas.combinadas === null && r.metricas.mercadoLivre === null, r.estado);
    assert(r.cobertura.lojas[0].metricas === null && r.cobertura.lojas[0].motivos.includes("COBERTURA_DO_PERIODO_FECHADO_INCOMPLETA"), JSON.stringify(r.cobertura.lojas[0].motivos));
  });
  t("H. ESTE_ANO: hoje observado NAO prova o ano — fechada desde 01/01 sem janelas → INCOMPLETE (limitacao de longo prazo)", async () => {
    const r = await q({ userId: DONO, marketplace: "todos", preset: "ESTE_ANO" });
    assert(r.estado === "INCOMPLETE" && r.metricas.combinadas === null && r.partes.fechada!.de === "2026-01-01", r.estado);
  });
  t("I. CUSTOM 05–07/10 (inclui hoje) → 500.05 + 200.00 = 700.05; CUSTOM 07–07 = HOJE", async () => {
    const r = await q({ userId: DONO, marketplace: "mercado_livre", preset: "CUSTOM", de: "2026-10-05", ate: "2026-10-07" });
    assert(r.estado === "PARTIAL_FRESH" && r.metricas.mercadoLivre!.vendas === 700.05, `${r.estado} ${JSON.stringify(r.metricas.mercadoLivre)}`);
    const h = await q({ userId: DONO, marketplace: "mercado_livre", preset: "CUSTOM", de: "2026-10-07", ate: "2026-10-07" });
    assert(h.estado === "PARTIAL_FRESH" && h.metricas.mercadoLivre!.vendas === 200 && h.partes.fechada === null, h.estado);
  });
  t("J. CUSTOM terminando ONTEM → semantica D13 (COMPLETE_FRESH 1000.00, sem parte atual, nao parcial)", async () => {
    const r = await q({ userId: DONO, marketplace: "mercado_livre", preset: "CUSTOM", de: "2026-10-01", ate: "2026-10-06" });
    assert(r.estado === "COMPLETE_FRESH" && r.completo && !r.parcial && r.metricas.mercadoLivre!.vendas === 1000 && r.partes.atual === null && r.observadoAte === null, `${r.estado}`);
    assert(r.cobertura.lojas[0].parteAtual === null, "parte atual");
  });
  t("J2. ULTIMOS_7/30/60_DIAS continuam SEM hoje", async () => {
    for (const preset of ["ULTIMOS_7_DIAS", "ULTIMOS_30_DIAS", "ULTIMOS_60_DIAS"]) {
      const r = await q({ userId: DONO, marketplace: "mercado_livre", preset });
      assert(!r.parcial && r.partes.atual === null && r.periodo.ate === "2026-10-06", preset);
    }
  });

  console.log("\n[K–O. multi-loja, multi-marketplace, dono]");
  t("K. duas lojas Shopee do MESMO dono, ambas observadas (100 + 50) → Shopee = 150.00 PARTIAL", async () => {
    const r = await q({ userId: DONO, marketplace: "shopee", preset: "HOJE" });
    assert(r.estado === "PARTIAL_FRESH" && r.metricas.shopee!.vendas === 150 && r.metricas.shopee!.pedidos === 3 && r.cobertura.lojas.length === 2, JSON.stringify(r.metricas.shopee));
  });
  t("L. uma das duas lojas NAO observada → agregado null (nunca 100 como total)", async () => {
    const r = await q({ userId: DONO, marketplace: "shopee", preset: "HOJE" }, mundo({ asOf: { [SH2]: null } }));
    assert(r.estado === "PARTIAL_SEM_OBSERVACAO_ATUAL" && r.metricas.shopee === null && r.metricas.combinadas === null, `${r.estado} ${JSON.stringify(r.metricas)}`);
    assert(r.cobertura.motivos.some((m) => m.includes(`${SH2}:PARTE_ATUAL_NAO_OBSERVADA`)), r.cobertura.motivos.join());
  });
  t("M. 'todos' ML + Shopee observados → 200 + 150 = 350.00; observadoAte = o MENOR entre as lojas", async () => {
    const r = await q({ userId: DONO, marketplace: "todos", preset: "HOJE" });
    assert(r.estado === "PARTIAL_FRESH" && r.metricas.combinadas!.vendas === 350 && r.metricas.combinadas!.pedidos === 5, JSON.stringify(r.metricas.combinadas));
    const cedo = "2026-10-07T12:00:00.000Z";
    const r2 = await q({ userId: DONO, marketplace: "todos", preset: "HOJE" }, mundo({ asOf: { [SH2]: cedo } }));
    assert(r2.observadoAte === cedo && r2.metricas.combinadas!.vendas === 350, `${r2.observadoAte}`);
  });
  t("N. um marketplace NAO observado (Shopee) → agregado 'todos' null; ML sozinho nunca vira total", async () => {
    const r = await q({ userId: DONO, marketplace: "todos", preset: "HOJE" }, mundo({ asOf: { [SH1]: null, [SH2]: null } }));
    assert(r.estado === "PARTIAL_SEM_OBSERVACAO_ATUAL" && r.metricas.combinadas === null && r.metricas.mercadoLivre === null && r.metricas.shopee === null, r.estado);
  });
  t("N2. ML e Shopee leem a MESMA parte fechada e o MESMO dia civil", async () => {
    const regs: Reg[] = [];
    await q({ userId: DONO, marketplace: "todos", preset: "ESTE_MES" }, mundo(), AGORA, regs);
    const lim = (tab: string, col: string) => [...new Set(regs.filter((g) => g.tabela === tab && !g.head).map((g) =>
      `${g.filtros.find(([op, c]) => op === "gte" && c === col)?.[2]}|${g.filtros.find(([op, c]) => op === "lt" && c === col)?.[2]}`))].sort();
    const esperado = ["2026-10-01T03:00:00.000Z|2026-10-07T03:00:00.000Z", "2026-10-07T03:00:00.000Z|2026-10-08T03:00:00.000Z"];
    assert(JSON.stringify(lim("ml_pedidos", "date_closed")) === JSON.stringify(esperado) && JSON.stringify(lim("shopee_pedidos", "pay_time")) === JSON.stringify(esperado),
      `${lim("ml_pedidos", "date_closed")} ${lim("shopee_pedidos", "pay_time")}`);
  });
  t("O. dono isolado no modo parcial: loja de outro dono → LOJA_FORA_DO_OWNER; a do outro (mesmo seller_id) nunca entra", async () => {
    assert(await erroDe(() => q({ userId: DONO, marketplace: "mercado_livre", lojaId: ML_X, preset: "HOJE" })) === "LOJA_FORA_DO_OWNER", "loja alheia");
    const regs: Reg[] = [];
    const r = await q({ userId: DONO, marketplace: "todos", preset: "ESTE_MES" }, mundo(), AGORA, regs);
    assert(r.cobertura.lojas.every((l) => [ML1, SH1, SH2].includes(l.lojaId)) && r.metricas.combinadas!.vendas === 1200 + 1150, JSON.stringify(r.metricas.combinadas));
    for (const g of regs) assert(g.filtros.some(([op, c, v]) => op === "eq" && c === "user_id" && v === DONO), `${g.tabela} sem dono`);
    const o = await q({ userId: OUTRO, marketplace: "mercado_livre", preset: "HOJE" });
    assert(o.metricas.mercadoLivre!.vendas === 20000 && o.cobertura.lojas.length === 1, JSON.stringify(o.metricas.mercadoLivre));
  });
  t("O2. loja inativa ou credencial morta no parcial → INCOMPLETE (nunca subtotal menor como total)", async () => {
    const d = mundo(); d.lojas.find((l) => l.id === SH2)!.ativo = false;
    const r = await q({ userId: DONO, marketplace: "shopee", preset: "HOJE" }, d);
    assert(r.estado === "INCOMPLETE" && r.metricas.shopee === null, r.estado);
    const d2 = mundo(); Object.assign(d2.lojas.find((l) => l.id === SH2)!, { refresh_token: null, token_expires_at: "2026-01-01T00:00:00Z" });
    const r2 = await q({ userId: DONO, marketplace: "shopee", preset: "HOJE" }, d2);
    assert(r2.estado === "INCOMPLETE" && r2.metricas.shopee === null, r2.estado);
  });

  console.log("\n[meia-noite e fuso]");
  t("MN. 23:59:59.999 SP ainda e 07/10 (parte atual 07/10); 00:00:00.000 SP vira 08/10 e 07/10 passa a ser parte FECHADA", async () => {
    const antes = await q({ userId: DONO, marketplace: "mercado_livre", preset: "ESTE_MES" }, mundo(), Date.parse("2026-10-08T02:59:59.999Z"));
    assert(antes.partes.atual!.dia === "2026-10-07" && antes.partes.fechada!.ate === "2026-10-06", JSON.stringify(antes.partes));
    const depois = await q({ userId: DONO, marketplace: "mercado_livre", preset: "ESTE_MES" }, mundo(), Date.parse("2026-10-08T03:00:00.000Z"));
    assert(depois.partes.atual!.dia === "2026-10-08" && depois.partes.fechada!.ate === "2026-10-07" && depois.partes.atual!.inicioInclusivo === "2026-10-08T03:00:00.000Z", JSON.stringify(depois.partes));
  });
  t("DST. a parte atual usa o offset REAL do dia (15/01/2019, horario de verao → 02:00Z)", async () => {
    const r = await q({ userId: DONO, marketplace: "mercado_livre", preset: "HOJE" }, mundo(), Date.parse("2019-01-15T15:00:00.000Z"));
    assert(r.partes.atual!.inicioInclusivo === "2019-01-15T02:00:00.000Z" && r.partes.atual!.fimExclusivo === "2019-01-16T02:00:00.000Z", JSON.stringify(r.partes.atual));
  });

  console.log("\n[leitores: retrocompatibilidade e mesma formula]");
  t("R1. leitor SEM a opcao: nenhum campo 'parcial' e resultado identico a chamar com parcial:false", async () => {
    for (const ler of [(c: any, a: any) => M.lerVendasML(c, a), (c: any, a: any) => S.lerVendasShopee(c, a)]) {
      const sem = await ler(clienteFalso(mundo()), { userId: DONO, de: "2026-10-07", ate: "2026-10-07" });
      const falso = await ler(clienteFalso(mundo()), { userId: DONO, de: "2026-10-07", ate: "2026-10-07", parcial: false });
      assert(sem.lojas.every((l: any) => !("parcial" in l)), "campo parcial sem opcao");
      assert(JSON.stringify(sem) === JSON.stringify(falso), "parcial:false difere");
      assert(sem.completude !== "COMPLETE" && sem.total === null && sem.lojas.every((l: any) => l.metricas === null), "hoje virou COMPLETE");
    }
  });
  t("R2. leitor COM a opcao: mesmo resultado normal + 'parcial' com observadoAte = alcance da cadeia", async () => {
    const sem = await M.lerVendasML(clienteFalso(mundo()), { userId: DONO, de: "2026-10-07", ate: "2026-10-07" });
    const com = await M.lerVendasML(clienteFalso(mundo()), { userId: DONO, de: "2026-10-07", ate: "2026-10-07", parcial: true });
    const tirar = (r: any) => JSON.stringify({ ...r, lojas: r.lojas.map(({ parcial, ...x }: any) => x) });
    assert(tirar(sem) === tirar(com), "resultado normal mudou com a opcao");
    const p = com.lojas[0].parcial!;
    assert(p.estado === "OBSERVADO_ATE" && p.observadoAte === ASOF && p.completude === "COMPLETE" && p.metricas!.vendas === 200, JSON.stringify(p));
  });
  t("R3. parcial usa a MESMA formula: prefixo ML = calcularMetricasML(filtrarFechadosNoIntervalo(...)); Shopee idem", async () => {
    const d = mundo();
    const linhas = d.ml_pedidos.filter((p) => p.loja_id === ML1).map((r) => ({ lojaId: r.loja_id, orderId: r.order_id, dateClosed: r.date_closed, cancelCode: r.cancel_detail_code,
      totalAmount: r.total_amount, unidades: r.unidades, fetchedAt: r.fetched_at }));
    const direto = M.calcularMetricasML(M.filtrarFechadosNoIntervalo(linhas, new Date(HOJE0), new Date(ASOF)));
    const com = await M.lerVendasML(clienteFalso(d), { userId: DONO, de: "2026-10-07", ate: "2026-10-07", parcial: true });
    assert(JSON.stringify(com.lojas.find((l) => l.lojaId === ML1)!.parcial!.metricas) === JSON.stringify(direto), "ML diverge");
    const sh = await S.lerVendasShopee(clienteFalso(d), { userId: DONO, de: "2026-10-07", ate: "2026-10-07", lojaIds: [SH1], parcial: true });
    assert(sh.lojas[0].parcial!.metricas!.vendas === 100 && sh.lojas[0].parcial!.metricas!.pedidos === 2, JSON.stringify(sh.lojas[0].parcial));
  });

  console.log("\n[read-only]");
  t("RO. nenhuma escrita, nenhuma rede em todos os cenarios", () => {
    assert(escritas.length === 0, escritas.join());
    assert(fetches === 0, `fetch=${fetches}`);
  });

  await fila;
  console.log(`\n${falhou === 0 ? "✓" : "✗"} VENDAS-CANONICO-PARCIAL — ${passou} passaram, ${falhou} falharam`);
  process.exit(falhou === 0 ? 0 : 1);
}
principal().catch((e) => { console.error("ERRO FATAL", e); process.exit(1); });
