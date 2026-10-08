/**
 * D16 (Dashboard first) — os 4 cards principais do Dashboard (Faturamento,
 * Pedidos, Unidades, Ticket) pela camada canonica, via
 * lib/vendas/canonico/dashboard-resumo.ts → consultarVendasCanonicas.
 *
 * Sem rede, sem banco: um duplo do Supabase (o mesmo dos testes D13/D14)
 * responde as consultas dos leitores oficiais. Fixtures SINTETICAS que
 * reproduzem os numeros homologados de 04/10 (ML 211/217/7220.62; Shopee
 * 707/783/16480.02) e um HOJE observado ate 11:00 SP.
 *
 * Uso: npx tsx scripts/testar-dashboard-canonico.ts
 */
import "./_server-only-inerte";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const RAIZ = join(__dirname, "..");
let passou = 0, falhou = 0;
let fila: Promise<void> = Promise.resolve();
function t(nome: string, fn: () => void | Promise<void>) {
  fila = fila.then(async () => {
    try { await fn(); passou++; console.log(`  PASS  ${nome}`); }
    catch (e) { falhou++; console.log(`  FALHA ${nome} -> ${e instanceof Error ? e.message : String(e)}`); }
  });
}
function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const fonte = (rel: string) => readFileSync(join(RAIZ, rel), "utf8");
const semComentarios = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

// ── duplo do Supabase (somente leitura; qualquer escrita e registrada) ──
type Reg = { tabela: string; filtros: [string, string, unknown][]; head?: boolean };
const ESCRITAS = ["insert", "update", "upsert", "delete"];
function clienteFalso(dados: Record<string, any[]>, escritas: string[], regs: Reg[] = []) {
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

// ── mundo 04/10 (mesmas fixtures do D13; outro dono com o MESMO seller e valores x10) ──
const AGORA = Date.parse("2026-10-07T15:00:00.000Z");   // 12:00 em Sao Paulo
const OBS = "2026-10-07T12:00:00.000Z";
const RD = "dono-rd", OUTRO = "dono-outro";
const ML_A = "aaaaaaaa-0000-4000-8000-00000000000a", ML_B = "aaaaaaaa-0000-4000-8000-00000000000b";
const SH_A = "aaaaaaaa-0000-4000-8000-0000000001aa";
const ML_X = "bbbbbbbb-0000-4000-8000-00000000000a", SH_X = "bbbbbbbb-0000-4000-8000-0000000001aa";
const cred = { access_token: "tk-fake", refresh_token: "rt-fake", token_expires_at: "2030-01-01T00:00:00Z" };
const loja = (id: string, user_id: string, marketplace: "ML" | "Shopee", seller_id: string) =>
  ({ id, user_id, marketplace, ativo: true, nickname: "MESMO_NICK", seller_id, partner_id: marketplace === "Shopee" ? 9 : null, partner_key: marketplace === "Shopee" ? "pk-fake" : null, ...cred });
function pedidosML(lojaId: string, user_id: string, escala = 1) {
  const out: any[] = [];
  const base = Date.parse("2026-10-04T03:00:00.000Z");
  for (let i = 0; i < 211; i++) out.push({ user_id, loja_id: lojaId, order_id: `20000${i}`, date_closed: new Date(base + i * 6 * 60000).toISOString(),
    cancel_detail_code: null, total_amount: (i < 210 ? 34.21 : 36.52) * escala, unidades: i < 6 ? 2 : 1, fetched_at: OBS });
  out.push({ user_id, loja_id: lojaId, order_id: "2999", date_closed: "2026-10-04T15:00:00.000Z", cancel_detail_code: "pack_splitted", total_amount: 999.99, unidades: 9, fetched_at: OBS });
  out.push({ user_id, loja_id: lojaId, order_id: "2998", date_closed: "2026-10-04T02:59:59.000Z", cancel_detail_code: null, total_amount: 500, unidades: 5, fetched_at: OBS });
  out.push({ user_id, loja_id: lojaId, order_id: "2997", date_closed: "2026-10-05T03:00:00.000Z", cancel_detail_code: null, total_amount: 400, unidades: 4, fetched_at: OBS });
  return out;
}
function pedidosShopee(lojaId: string, user_id: string) {
  const sp: any[] = [], itens: any[] = [];
  const base = Date.parse("2026-10-04T03:00:00.000Z");
  for (let i = 0; i < 707; i++) {
    const pay = new Date(base + i * 2 * 60000).toISOString();
    const sn = `SN${String(i).padStart(4, "0")}`;
    sp.push({ user_id, loja_id: lojaId, order_sn: sn, order_status: i >= 700 ? "CANCELLED" : "COMPLETED",
      create_time: new Date(Date.parse(pay) - 30 * 60000).toISOString(), pay_time: pay, update_time: pay, detail_fetched_at: OBS,
      escrow_fetched_at: OBS, escrow_update_time: pay, original_shopee_discount: i === 0 ? 100 : 0, pix_discount: 0, escrow_pendente: false });
    itens.push({ user_id, marketplace: "Shopee", loja_id: lojaId, order_id: sn, qtd: i < 76 ? 2 : 1, valor_unit: i === 706 ? 740.02 : 20,
      escrow_voucher_seller: 0, escrow_voucher_shopee: i === 1 ? 253.44 : 0, escrow_coin: 0 });
  }
  return { sp, itens };
}
const jobML = (lojaId: string, user_id: string) => ({ id: `job-${lojaId}`, user_id, loja_id: lojaId, marketplace: "ML", campo_tempo: "date_closed",
  janela_inicio: "2026-10-01T03:00:00.000Z", janela_fim: "2026-10-06T03:00:00.000Z", listagem_completa: true, status: "concluido", concluido_em: OBS, criado_em: OBS });
const jobShopee = (lojaId: string, user_id: string) => ({ id: `job-${lojaId}`, user_id, loja_id: lojaId, marketplace: "Shopee", campo_tempo: "create_time",
  janela_inicio: "2026-09-20T03:00:00.000Z", janela_fim: "2026-10-06T03:00:00.000Z", listagem_completa: true, status: "concluido", concluido_em: OBS, criado_em: OBS });
/** comMlB=false: o dono R.D. tem exatamente 1 loja ML + 1 Shopee (cenario "Todos" 23700.64). */
function mundo04(comMlB = true) {
  const shA = pedidosShopee(SH_A, RD), shX = pedidosShopee(SH_X, OUTRO);
  return {
    lojas: [loja(ML_A, RD, "ML", "111"), ...(comMlB ? [loja(ML_B, RD, "ML", "222")] : []), loja(SH_A, RD, "Shopee", "333"),
      loja(ML_X, OUTRO, "ML", "111"), loja(SH_X, OUTRO, "Shopee", "333")],
    ml_pedidos: [...pedidosML(ML_A, RD),
      ...(comMlB ? [
        { user_id: RD, loja_id: ML_B, order_id: "20001", date_closed: "2026-10-04T12:00:00.000Z", cancel_detail_code: null, total_amount: 0.1, unidades: 1, fetched_at: OBS },
        { user_id: RD, loja_id: ML_B, order_id: "20002", date_closed: "2026-10-04T13:00:00.000Z", cancel_detail_code: null, total_amount: 0.2, unidades: 1, fetched_at: OBS }] : []),
      ...pedidosML(ML_X, OUTRO, 10)],
    shopee_pedidos: [...shA.sp, ...shX.sp],
    pedidos: [...shA.itens, ...shX.itens],
    sync_jobs: [jobML(ML_A, RD), ...(comMlB ? [jobML(ML_B, RD)] : []), jobShopee(SH_A, RD), jobML(ML_X, OUTRO), jobShopee(SH_X, OUTRO)],
  } as Record<string, any[]>;
}

// ── mundo HOJE (07/10; mesmas fixtures do D14): observado ate 11:00 SP ──
const HOJE0 = "2026-10-07T03:00:00.000Z";
const ASOF = "2026-10-07T14:00:00.000Z";                     // 11:00 SP (fresco)
const mais = (iso: string, min: number) => new Date(Date.parse(iso) + min * 60000).toISOString();
const jobH = (lojaId: string, user_id: string, marketplace: "ML" | "Shopee", inicio: string, fim: string, concl: string) =>
  ({ id: `job-${lojaId}-${inicio}`, user_id, loja_id: lojaId, marketplace, campo_tempo: marketplace === "ML" ? "date_closed" : "create_time",
    janela_inicio: inicio, janela_fim: fim, listagem_completa: true, status: "concluido", concluido_em: concl, criado_em: concl });
const pedMLH = (lojaId: string, user_id: string, id: string, closed: string, total: number, unidades: number, fetched: string) =>
  ({ user_id, loja_id: lojaId, order_id: id, date_closed: closed, cancel_detail_code: null, total_amount: total, unidades, fetched_at: fetched });
function mundoHoje(o: { asOf?: string | null; semVendasHoje?: boolean } = {}) {
  const asOf = o.asOf === undefined ? ASOF : o.asOf;
  const f = mais(asOf ?? ASOF, 10);
  const d: Record<string, any[]> = { lojas: [loja(ML_A, RD, "ML", "111"), loja(ML_X, OUTRO, "ML", "111")], ml_pedidos: [], shopee_pedidos: [], pedidos: [], sync_jobs: [] };
  for (const [id, dono, k] of [[ML_A, RD, 1], [ML_X, OUTRO, 100]] as const) {
    d.sync_jobs.push(jobH(id, dono, "ML", "2026-10-01T03:00:00.000Z", HOJE0, f));
    if (asOf) d.sync_jobs.push(jobH(id, dono, "ML", HOJE0, asOf, f));
    if (!o.semVendasHoje) d.ml_pedidos.push(pedMLH(id, dono, "3", "2026-10-07T03:30:00.000Z", 120.1 * k, 1, f), pedMLH(id, dono, "4", "2026-10-07T04:00:00.000Z", 79.9 * k, 1, f));
    d.ml_pedidos.push(pedMLH(id, dono, "5", "2026-10-07T14:30:00.000Z", 999, 1, f)); // depois do observado: nunca entra
  }
  return d;
}

async function principal() {
  const R = await import("../lib/vendas/canonico/dashboard-resumo");
  const V = await import("../lib/vendas/canonico/service");
  const escritas: string[] = [];
  const resumo = (userId: string, f: { marketplace: string; lojaId?: string | null; de: string; ate: string }, d: Record<string, any[]> = mundo04(), agoraMs = AGORA, regs: Reg[] = []) =>
    R.consultarResumoVendasDashboard(userId, { marketplace: f.marketplace as any, lojaId: f.lojaId ?? null, de: f.de, ate: f.ate }, { cliente: clienteFalso(d, escritas, regs), agoraMs });
  const D04 = { de: "2026-10-04", ate: "2026-10-04" };
  const erroDe = async (f: () => Promise<unknown>) => { try { await f(); return "NAO_LANCOU"; } catch (e: any) { return e instanceof V.ErroVendasCanonicas ? e.codigo : `OUTRO:${e?.message}`; } };

  console.log("\n[A–C. regressoes 04/10 (fixtures sinteticas com os numeros homologados)]");
  t("A. Shopee 04/10 = 16480.02 / 707 / 783; ticket = faturamento/pedidos", async () => {
    const r = await resumo(RD, { marketplace: "shopee", ...D04 });
    const m = r.metricas!;
    assert(m.faturamento === 16480.02 && m.pedidos === 707 && m.unidades === 783 && m.ticket === 16480.02 / 707 && r.estado === "COMPLETE_FRESH", JSON.stringify(r));
  });
  t("B. ML 04/10 (loja A) = 7220.62 / 211 / 217", async () => {
    const r = await resumo(RD, { marketplace: "mercado_livre", lojaId: ML_A, ...D04 });
    const m = r.metricas!;
    assert(m.faturamento === 7220.62 && m.pedidos === 211 && m.unidades === 217 && m.ticket === 7220.62 / 211 && r.completo, JSON.stringify(r));
  });
  t("C. Todos 04/10 (dono com 1 ML + 1 Shopee) = 23700.64 / 918 / 1000", async () => {
    const r = await resumo(RD, { marketplace: "todos", ...D04 }, mundo04(false));
    const m = r.metricas!;
    assert(m.faturamento === 23700.64 && m.pedidos === 918 && m.unidades === 1000 && m.ticket === 23700.64 / 918, JSON.stringify(m));
  });

  console.log("\n[D–F. loja, todas as lojas, dono]");
  t("D. loja especifica: ML loja A = 7220.62; ML sem loja (A+B) = 7220.92 — o filtro de loja e respeitado", async () => {
    const a = await resumo(RD, { marketplace: "mercado_livre", lojaId: ML_A, ...D04 });
    const ab = await resumo(RD, { marketplace: "mercado_livre", ...D04 });
    assert(a.metricas!.faturamento === 7220.62 && ab.metricas!.faturamento === 7220.92 && ab.metricas!.pedidos === 213, `${a.metricas!.faturamento} ${ab.metricas!.faturamento}`);
  });
  t("E. todas as lojas do dono (Todos): ML A + ML B + Shopee = 23700.94 / 920 / 1002", async () => {
    const r = await resumo(RD, { marketplace: "todos", ...D04 });
    assert(r.metricas!.faturamento === 23700.94 && r.metricas!.pedidos === 920 && r.metricas!.unidades === 1002, JSON.stringify(r.metricas));
  });
  t("F. isolamento de dono: outro dono com o MESMO seller (x10) nunca entra; loja de outro dono → 404 sem ler pedido", async () => {
    const meu = await resumo(RD, { marketplace: "mercado_livre", lojaId: ML_A, ...D04 });
    const dele = await resumo(OUTRO, { marketplace: "mercado_livre", ...D04 });
    assert(meu.metricas!.faturamento === 7220.62 && dele.metricas!.faturamento !== meu.metricas!.faturamento, `${meu.metricas!.faturamento} ${dele.metricas!.faturamento}`);
    const regs: Reg[] = [];
    const cod = await erroDe(() => resumo(RD, { marketplace: "mercado_livre", lojaId: ML_X, ...D04 }, mundo04(), AGORA, regs));
    assert(cod === "LOJA_FORA_DO_OWNER" && R.statusDoErroResumo(new V.ErroVendasCanonicas("LOJA_FORA_DO_OWNER")) === 404, cod);
    assert(!regs.some((g) => ["ml_pedidos", "shopee_pedidos", "pedidos", "sync_jobs"].includes(g.tabela)), regs.map((g) => g.tabela).join());
  });

  console.log("\n[G–H. periodo personalizado]");
  t("G. custom de UM dia (04/10) = o dia civil de Sao Paulo (bordas 03/10 23:59:59 e 05/10 00:00 fora)", async () => {
    const r = await resumo(RD, { marketplace: "mercado_livre", lojaId: ML_A, de: "2026-10-04", ate: "2026-10-04" });
    assert(r.periodo.de === "2026-10-04" && r.periodo.ate === "2026-10-04" && r.metricas!.pedidos === 211, JSON.stringify(r.periodo));
  });
  t("H. custom de VARIOS dias (01–05/10) inclui as bordas de 03/10 e 05/10: 8120.62 / 213 / 226", async () => {
    const r = await resumo(RD, { marketplace: "mercado_livre", lojaId: ML_A, de: "2026-10-01", ate: "2026-10-05" });
    assert(r.metricas!.faturamento === 8120.62 && r.metricas!.pedidos === 213 && r.metricas!.unidades === 226 && r.completo, JSON.stringify(r));
  });

  console.log("\n[I–K, O–P. hoje, incompleto, ticket, zero]");
  t("I. HOJE observado e fresco → PARTIAL_FRESH, metricas ate observadoAte (200.00), parcial", async () => {
    const r = await resumo(RD, { marketplace: "mercado_livre", de: "2026-10-07", ate: "2026-10-07" }, mundoHoje());
    assert(r.estado === "PARTIAL_FRESH" && r.parcial && r.observadoAte === ASOF && r.metricas!.faturamento === 200 && r.metricas!.pedidos === 2, JSON.stringify(r));
  });
  t("I2. HOJE observado mas velho (asOf 02:00 SP) → PARTIAL_STALE com as metricas validas ate la", async () => {
    const velho = "2026-10-07T05:00:00.000Z";
    const r = await resumo(RD, { marketplace: "mercado_livre", de: "2026-10-07", ate: "2026-10-07" }, mundoHoje({ asOf: velho }));
    assert(r.estado === "PARTIAL_STALE" && r.observadoAte === velho && r.metricas !== null, JSON.stringify(r));
  });
  t("J. HOJE nao observado → metricas null (nunca 0, nunca legado)", async () => {
    const r = await resumo(RD, { marketplace: "mercado_livre", de: "2026-10-07", ate: "2026-10-07" }, mundoHoje({ asOf: null }));
    assert(r.estado === "PARTIAL_SEM_OBSERVACAO_ATUAL" && r.metricas === null && r.observadoAte === null, JSON.stringify(r));
  });
  t("J2. periodo historico INCOMPLETE (sem cobertura) → metricas null, nunca zero falso", async () => {
    const d = mundo04(); d.sync_jobs = d.sync_jobs.filter((j) => j.loja_id !== ML_A);
    const r = await resumo(RD, { marketplace: "mercado_livre", lojaId: ML_A, ...D04 }, d);
    assert(r.estado === "INCOMPLETE" && r.metricas === null, JSON.stringify(r));
  });
  t("K. Ticket = faturamento / pedidos (servidor); zero pedidos → ticket 0 sem divisao por zero", async () => {
    const r = await resumo(RD, { marketplace: "todos", ...D04 });
    assert(r.metricas!.ticket === r.metricas!.faturamento / r.metricas!.pedidos, String(r.metricas!.ticket));
    const z = await resumo(RD, { marketplace: "mercado_livre", de: "2026-10-07", ate: "2026-10-07" }, mundoHoje({ semVendasHoje: true }));
    assert(z.metricas!.pedidos === 0 && z.metricas!.ticket === 0, JSON.stringify(z.metricas));
  });
  t("O. zero vendas OBSERVADO → R$ 0 valido (metricas zero, PARTIAL_FRESH)", async () => {
    const r = await resumo(RD, { marketplace: "mercado_livre", de: "2026-10-07", ate: "2026-10-07" }, mundoHoje({ semVendasHoje: true }));
    assert(r.estado === "PARTIAL_FRESH" && r.metricas!.faturamento === 0 && r.metricas!.pedidos === 0, JSON.stringify(r));
  });
  t("P. dono sem loja no marketplace pedido → estado neutro SEM_LOJA_NO_ESCOPO, metricas null (nao R$ 0)", async () => {
    const r = await resumo(RD, { marketplace: "shopee", de: "2026-10-07", ate: "2026-10-07" }, mundoHoje());
    assert(r.estado === "SEM_LOJA_NO_ESCOPO" && r.metricas === null, JSON.stringify(r));
  });

  console.log("\n[L. so leitura: sem job, sem provider, sem legado]");
  t("L. nenhuma escrita/RPC no banco em toda a suite; o resumo nunca le o legado como fato de venda ML", async () => {
    const regs: Reg[] = [];
    await resumo(RD, { marketplace: "todos", ...D04 }, mundo04(), AGORA, regs);
    assert(escritas.length === 0, escritas.join());
    assert(regs.length > 0, "nenhuma leitura registrada (teste vazio)");
  });
  t("L2. rota e helper: sem sync/worker/coordenador/provider/fetch; Dashboard busca os 4 cards SO em /api/vendas/resumo-canonico", () => {
    for (const f of ["lib/vendas/canonico/dashboard-resumo.ts", "app/api/vendas/resumo-canonico/route.ts"]) {
      const s = semComentarios(fonte(f));
      assert(!/sync-ml|sync-shopee|vendas\/sync|mercado-livre-vendas|shopee\/ingestao|mercado-livre\/ingestao|shopee-auth|ml-auth|\bfetch\(|sync_jobs|insert\(|upsert\(|update\(/.test(s), `${f}: caminho de escrita/sync/provider`);
    }
    const rota = semComentarios(fonte("app/api/vendas/resumo-canonico/route.ts"));
    assert(/autenticarRequisicao/.test(rota) && /export async function GET/.test(rota) && !/export async function (POST|PUT|PATCH|DELETE)/.test(rota), "rota: auth + so GET");
    const dash = semComentarios(fonte("app/(app)/dashboard/page.tsx"));
    assert(/\/api\/vendas\/resumo-canonico\?/.test(dash), "Dashboard nao chama o resumo canonico");
    for (const [card, campo] of [["Faturamento", "faturamento"], ["Pedidos", "pedidos"], ["Ticket Medio", "ticket"], ["Unidades", "unidades"]]) {
      const linha = dash.split("\n").find((l) => l.includes(`label="${card}"`)) ?? "";
      assert(linha.includes(`mc.${campo}`) && !linha.includes(`kpis.${campo}`), `card ${card} nao usa o canonico: ${linha.trim()}`);
    }
    // D16B: valor EXATO nos cards canonicos (validacao manual): sem compactar em "k"
    for (const campo of ["faturamento", "ticket"]) assert(dash.includes(`fmtBRL(mc.${campo})`) && !dash.includes(`fmtBRL(mc.${campo}, true)`), `${campo} compactado`);
    const brl = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }).replace(/ /g, " ");
    assert(brl(16480.02) === "R$ 16.480,02" && brl(16480.02 / 707) === "R$ 23,31" && brl(23700.64) === "R$ 23.700,64", `${brl(16480.02)} ${brl(16480.02 / 707)}`);
  });
  t("L3. parametros: marketplace/data invalidos → null (400); loja vazia → null", () => {
    const p = (q: string) => R.lerFiltroResumoDashboard(new URLSearchParams(q));
    assert(p("marketplace=shopee&de=2026-10-04&ate=2026-10-04")?.marketplace === "shopee", "valido");
    assert(p("marketplace=amazon&de=2026-10-04&ate=2026-10-04") === null && p("marketplace=todos&de=04/10/2026&ate=2026-10-04") === null && p("marketplace=todos&de=2026-10-04&ate=2026-10-04&loja_id=") === null, "invalidos");
  });

  await fila;
  console.log(`\n${falhou === 0 ? "✓" : "✗"} DASHBOARD-CANONICO — ${passou} passaram, ${falhou} falharam`);
  process.exit(falhou === 0 ? 0 : 1);
}
principal().catch((e) => { console.error("ERRO FATAL", e); process.exit(1); });
