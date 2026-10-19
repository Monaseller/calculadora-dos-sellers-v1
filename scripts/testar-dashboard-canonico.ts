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

  t("L4. MULTI-LOJA: loja_ids=a,b → lista (dedup); vazio, item malformado ou junto com loja_id → null (400, nunca 'todas')", () => {
    const p = (q: string) => R.lerFiltroResumoDashboard(new URLSearchParams(q));
    const A = "aaaaaaaa-0000-4000-8000-00000000000a", B = "aaaaaaaa-0000-4000-8000-0000000001aa";
    const f = p(`marketplace=todos&de=2026-10-04&ate=2026-10-04&loja_ids=${A},${B},${A}`);
    assert(f && JSON.stringify(f.lojaIds) === JSON.stringify([A, B]) && f.lojaId === null, JSON.stringify(f));
    for (const q of ["loja_ids=", `loja_ids=${A},`, "loja_ids=nao-e-uuid", `loja_ids=${A}&loja_id=${B}`]) assert(p(`marketplace=todos&de=2026-10-04&ate=2026-10-04&${q}`) === null, `${q} aceito`);
    assert(p("marketplace=todos&de=2026-10-04&ate=2026-10-04")?.lojaIds === null, "sem loja_ids mudou");
  });
  t("L5. Dashboard envia EXATAMENTE a seleção: todas → sem filtro; 1 → loja_id; 2+ → loja_ids; clique alterna só aquela loja (nunca vazio)", () => {
    const pg = readFileSync(join(RAIZ, "app/(app)/dashboard/page.tsx"), "utf8").replace(/\r\n/g, "\n");
    assert(/\.\.\.\(todasSelecionadas \? \{\} : idsSelecionados\.length === 1 \? \{ loja_id: idsSelecionados\[0\] \} : \{ loja_ids: idsSelecionados\.join\(","\) \}\),/.test(pg), "query canônica fora da seleção");
    assert(/const marketplaceCanonico = todasSelecionadas \|\| mktsSelecionados\.size !== 1 \? "todos" : mktsSelecionados\.has\("Shopee"\) \? "shopee" : "mercado_livre";/.test(pg), "marketplace da seleção");
    assert(/if \(atual\.has\(id\)\) \{ if \(atual\.size === 1\) return; atual\.delete\(id\); \}\s*else atual\.add\(id\);/.test(pg) && !/onChange\(new Set\(\[id\]\)\); \/\/ seleciona exclusivamente/.test(pg), "dropdown ainda exclusivo / permite seleção vazia");
    assert(!/const lojaUnica = !todasSelecionadas && selecionadasArr\.length === 1/.test(pg), "regra antiga (2 de 3 → todos sem filtro) ainda presente");
  });

  t("L6. ETAPA 2A: resumo traz a série diária (soma = cards) e a separação por marketplace da MESMA consulta", () => {
    const base: any = { estado: "COMPLETE_FRESH", completo: true, parcial: false, observadoAte: null, periodo: { de: "2026-10-03", ate: "2026-10-04" },
      metricas: { combinadas: { pedidos: 3, unidades: 4, vendas: 30.5 }, mercadoLivre: { pedidos: 1, unidades: 1, vendas: 10 }, shopee: { pedidos: 2, unidades: 3, vendas: 20.5, cancelados: 0, vendasSemDescontosPlataforma: 20 } },
      serieDiaria: [{ dia: "2026-10-03", pedidos: 1, unidades: 1, vendas: 10 }, { dia: "2026-10-04", pedidos: 2, unidades: 3, vendas: 20.5 }] };
    const r = R.resumoParaDashboard(base);
    assert(JSON.stringify(r.serie) === JSON.stringify([{ dia: "2026-10-03", estado: "CONFIRMADO", faturamento: 10, pedidos: 1, unidades: 1, observadoAte: null }, { dia: "2026-10-04", estado: "CONFIRMADO", faturamento: 20.5, pedidos: 2, unidades: 3, observadoAte: null }]), JSON.stringify(r.serie));
    assert(r.situacao === "CONFIRMADO", `situacao ${r.situacao}`);
    assert(r.porMarketplace?.mercadoLivre?.faturamento === 10 && r.porMarketplace?.shopee?.pedidos === 2, JSON.stringify(r.porMarketplace));
    const sem = R.resumoParaDashboard({ ...base, metricas: { ...base.metricas, combinadas: null }, serieDiaria: null });
    assert(sem.serie === null && sem.porMarketplace === null && sem.metricas === null, "sem métricas mostrou série/separação");
  });
  t("L7. ETAPA 2A: Dashboard — gráfico e sparkline da série canônica (sem lucro legado), 'duas plataformas' pela separação canônica, UMA leitura por clique, indicadores legados rotulados", () => {
    const pg = readFileSync(join(RAIZ, "app/(app)/dashboard/page.tsx"), "utf8").replace(/\r\n/g, "\n");
    assert(/<AreaChartSection dias=\{diasCanonicos\} mostrarLucro=\{false\} semDados=\{graficoSemDados\} \/>/.test(pg) && /spark=\{diasCanonicos\.filter\(d => d\.estado !== "SEM_DADOS"\)\.map\(d => d\.faturamento\)\}/.test(pg), "gráfico/sparkline fora da série canônica");
    assert(/setShowBothMkt\(!!\(r\.dados\?\.porMarketplace\?\.mercadoLivre\?\.pedidos && r\.dados\?\.porMarketplace\?\.shopee\?\.pedidos\)\);/.test(pg) && !/setShowBothMkt\(mlRows\.length > 0/.test(pg), "duas plataformas pelas linhas legadas");
    assert(!/setLojasSelecionadas\(ids\);\s*carregar\(dateFrom, dateTo, ids\);/.test(pg), "clique ainda lê duas vezes");
    assert((pg.match(/pendente · nao reconciliado/g) ?? []).length === 4 && /Balancete" subtitle="Composicao do resultado · legado, nao reconciliado"/.test(pg), "indicadores legados sem rótulo");
    assert(/R\.consultarResumoVendasDashboard|serieDiaria: true/.test(readFileSync(join(RAIZ, "lib/vendas/canonico/dashboard-resumo.ts"), "utf8")), "resumo não pede a série");
  });

  t("L8. ETAPA 3: com `observado`, cards, gráfico e separação saem DELE (mesmos números); INCOMPLETO lista os dias; SEM_DADOS = null", () => {
    const dias = [{ dia: "2026-10-03", estado: "CONFIRMADO", pedidos: 1, unidades: 1, vendas: 10, observadoAte: null },
      { dia: "2026-10-04", estado: "PROVISORIO", pedidos: 2, unidades: 3, vendas: 20.5, observadoAte: null },
      { dia: "2026-10-05", estado: "SEM_DADOS", pedidos: null, unidades: null, vendas: null, observadoAte: null }];
    const r = R.resumoParaDashboard({ estado: "INCOMPLETE", completo: false, parcial: false, observadoAte: null, periodo: { de: "2026-10-03", ate: "2026-10-05" },
      metricas: { combinadas: null, mercadoLivre: null, shopee: null },
      observado: { situacao: "INCOMPLETO", dias, total: { pedidos: 3, unidades: 4, vendas: 30.5 }, confirmado: { pedidos: 1, unidades: 1, vendas: 10 }, provisorio: { pedidos: 2, unidades: 3, vendas: 20.5 },
        porMarketplace: { mercadoLivre: { pedidos: 3, unidades: 4, vendas: 30.5 }, shopee: null }, diasConfirmados: 1, diasProvisorios: 1, diasSemDados: ["2026-10-05"] } } as any);
    assert(r.metricas!.faturamento === 30.5 && r.metricas!.pedidos === 3 && r.metricas!.unidades === 4 && r.metricas!.ticket === 30.5 / 3, JSON.stringify(r.metricas));
    assert(r.situacao === "INCOMPLETO" && JSON.stringify(r.dias) === JSON.stringify({ confirmados: 1, provisorios: 1, semDados: ["2026-10-05"] }) && r.provisorio!.faturamento === 20.5, JSON.stringify(r));
    const comValor = r.serie!.filter((d) => d.estado !== "SEM_DADOS");
    assert(comValor.reduce((a, d) => a + d.pedidos!, 0) === r.metricas!.pedidos && Math.round(comValor.reduce((a, d) => a + d.faturamento! * 100, 0)) === Math.round(r.metricas!.faturamento * 100), "soma do gráfico ≠ cards");
    assert(r.serie![2].faturamento === null && r.porMarketplace!.mercadoLivre!.pedidos === 3 && r.porMarketplace!.shopee === null, JSON.stringify(r.serie![2]));
    const nada = R.resumoParaDashboard({ estado: "INCOMPLETE", completo: false, parcial: false, observadoAte: null, periodo: { de: "2026-10-05", ate: "2026-10-05" },
      metricas: { combinadas: null, mercadoLivre: null, shopee: null },
      observado: { situacao: "SEM_DADOS", dias: [dias[2]], total: null, confirmado: { pedidos: 0, unidades: 0, vendas: 0 }, provisorio: { pedidos: 0, unidades: 0, vendas: 0 }, porMarketplace: { mercadoLivre: null, shopee: null }, diasConfirmados: 0, diasProvisorios: 0, diasSemDados: ["2026-10-05"] } } as any);
    assert(nada.metricas === null && nada.serie === null && nada.situacao === "SEM_DADOS", "SEM_DADOS virou número");
  });
  t("L9. ETAPA 3: Dashboard pede `observado`; página rotula provisório/incompleto, lacuna no gráfico, e legado indisponível não bloqueia os cards canônicos", () => {
    const pg = readFileSync(join(RAIZ, "app/(app)/dashboard/page.tsx"), "utf8").replace(/\r\n/g, "\n");
    assert(/serieDiaria: true, observado: true/.test(readFileSync(join(RAIZ, "lib/vendas/canonico/dashboard-resumo.ts"), "utf8")), "resumo não pede observado");
    assert(/NAO sao o total do periodo/.test(pg) && /Valores provisorios/.test(pg) && /incompleto · faltam/.test(pg), "rótulos de situação ausentes");
    assert(/const temValor = \(i: number\) => dias\[i\]\?\.estado !== "SEM_DADOS"/.test(pg) && /data-estado-dia/.test(pg), "gráfico sem lacuna/estado por dia");
    // P1: o legado saiu do carregamento — nada dele pode esconder os cards canônicos; os indicadores legados ficam "—"
    assert(!/setErro\(/.test(pg) && !/mlOk|shopeeOk/.test(pg), "legado ainda decide erro da tela");
    assert((pg.match(/value="—"/g) ?? []).length === 4, "indicador legado com valor");
  });

  t("L10. CORREÇÃO 57014: 5xx da rota registra código + etapa tipados (sem dono, loja, filtro ou valor); 4xx não polui o log", () => {
    const rota = readFileSync(join(RAIZ, "app/api/vendas/resumo-canonico/route.ts"), "utf8").replace(/\r\n/g, "\n");
    assert(rota.includes('if (status >= 500) console.error(`[GET /api/vendas/resumo-canonico] ${e.codigo} ${e.detalhe ?? ""}`.trim());'), "5xx sem log tipado");
    assert(!/console\.error\([^)]*(userId|filtro|lojaId|request\.url)/.test(rota), "log com dado do pedido");
  });

  t("L11. P1: o Dashboard consulta SÓ a rota canônica (sem /api/ml/vendas, /api/shopee/vendas, thumbnails); fila com debounce; 'Conecte sua conta' só sem loja", () => {
    const pg = readFileSync(join(RAIZ, "app/(app)/dashboard/page.tsx"), "utf8").replace(/\r\n/g, "\n");
    const codigo = pg.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    assert(!/fetch\(`?\/api\/(ml|shopee)\/vendas/.test(codigo) && !/item-thumbnails/.test(codigo), "Dashboard ainda chama rota legada de vendas");
    assert((codigo.match(/fetch\(/g) ?? []).length === 4 && /fetch\(`\/api\/vendas\/resumo-canonico\?\$\{chave\}`\)/.test(codigo), "fetches inesperados");   // me, anuncios, lojas, canonico
    assert(/const DEBOUNCE_FILTROS_MS = 400;/.test(pg) && /criarFilaConsulta<ResumoCanonicoDashboard>\(\{\s*debounceMs: DEBOUNCE_FILTROS_MS/.test(pg), "sem fila/debounce");
    assert(/\{estadoLojas === "vazio" && \(/.test(pg) && (codigo.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").match(/Conecte sua conta/g) ?? []).length === 1, "'Conecte sua conta' fora do caso sem loja");
    assert(/Nao foi possivel carregar os dados agora\./.test(pg) && /Tentar novamente/.test(pg) && /filaRef\.current\?\.tentarDeNovo\(\)/.test(pg), "falha temporária sem mensagem/retentativa");
    assert(/\{!loading && estadoLojas === "ok" && \(/.test(pg), "a tela some por falha");
    assert(/const LEGADO_FINANCEIRO_NO_DASHBOARD = false;/.test(pg) && /data-legado-pendente/.test(pg), "bloco legado sem pendência");
    assert(/\{mc && mc\.pedidos === 0 && \(/.test(pg), "'Nenhuma venda' pelo legado");
    // revisao: as 4 areas mantem a estrutura, com valores pendentes; nenhuma faz requisicao (o total de fetch segue 4)
    for (const area of ["top-produtos", "saude", "inteligencia"]) assert(pg.includes(`data-legado-pendente="${area}"`), `area ${area} sem estrutura`);
    assert(/title="🔔 Alertas"/.test(pg) && /title="🩺 Saude Financeira"/.test(pg) && /title="🏆 Top Produtos"/.test(pg) && /Centro de Inteligencia CDS/.test(pg), "titulos das areas ausentes");
    assert(/const PENDENTE = "Pendente de reconciliacao";/.test(pg) && !/function AvisoPendente[\s\S]{0,400}fetch\(/.test(pg), "pendencia sem texto ou com requisicao");
  });

  // ── P1: fila de consultas do Dashboard (pura) — relógio e servidor simulados, corridas determinísticas ──
  const FQ = await import("../app/(app)/dashboard/consulta-canonica");
  const montarFila = () => {
    let agora = 0; const timers: { fn: () => void; em: number; vivo: boolean }[] = [];
    const pedidas: string[] = []; const aplicadas: [string, boolean][] = []; const ocupado: boolean[] = [];
    const pendentes = new Map<string, ((ok: boolean) => void)[]>();
    const fila = FQ.criarFilaConsulta<string>({
      debounceMs: 400,
      executar: (chave) => { pedidas.push(chave); return new Promise((ok) => { (pendentes.get(chave) ?? pendentes.set(chave, []).get(chave)!).push((sucesso) => ok({ ok: sucesso, dados: sucesso ? `dados:${chave}` : null })); }); },
      aplicar: (chave, r) => { aplicadas.push([chave, r.ok]); },
      ocupado: (c) => ocupado.push(c),
      agendar: (fn, ms) => { const t = { fn, em: agora + ms, vivo: true }; timers.push(t); return t; },
      cancelar: (h) => { (h as { vivo: boolean }).vivo = false; },
    });
    const avancar = async (ms: number) => { agora += ms; for (const t of timers) if (t.vivo && t.em <= agora) { t.vivo = false; t.fn(); } await new Promise((r) => setTimeout(r, 0)); };
    const responder = async (chave: string, sucesso = true) => { const l = pendentes.get(chave); assert(l && l.length, `nenhuma consulta pendente de ${chave}`); l.shift()!(sucesso); await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };
    return { fila, avancar, responder, pedidas, aplicadas, ocupado };
  };
  t("L12. P1 debounce: 5 trocas em 300 ms → UMA consulta, com a ÚLTIMA seleção; nada antes de 400 ms de silêncio", async () => {
    const f = montarFila();
    for (const k of ["a", "b", "c", "d", "e"]) { f.fila.pedir(k); await f.avancar(60); }
    assert(f.pedidas.length === 0, `consultou antes do debounce: ${f.pedidas}`);
    await f.avancar(400);
    assert(JSON.stringify(f.pedidas) === JSON.stringify(["e"]), JSON.stringify(f.pedidas));
    await f.responder("e");
    assert(JSON.stringify(f.aplicadas) === JSON.stringify([["e", true]]), JSON.stringify(f.aplicadas));
  });
  t("L13. P1 um em voo: seleção nova durante uma consulta NÃO abre outra em paralelo; ao terminar, consulta a ÚLTIMA (intermediárias puladas); a antiga não é aplicada", async () => {
    const f = montarFila();
    f.fila.pedir("a"); await f.avancar(400);
    f.fila.pedir("b"); await f.avancar(400); f.fila.pedir("c"); await f.avancar(400);
    assert(JSON.stringify(f.pedidas) === JSON.stringify(["a"]), `paralelo: ${f.pedidas}`);
    await f.responder("a");                                   // resposta de "a" chega com "c" desejada
    assert(f.aplicadas.length === 0, `antiga aplicada: ${JSON.stringify(f.aplicadas)}`);
    assert(JSON.stringify(f.pedidas) === JSON.stringify(["a", "c"]), `não consultou a última: ${f.pedidas}`);
    await f.responder("c");
    assert(JSON.stringify(f.aplicadas) === JSON.stringify([["c", true]]), JSON.stringify(f.aplicadas));
  });
  t("L14. P1 dedupe: a mesma seleção já exibida ou já em voo não reconsulta; volta a uma seleção anterior reconsulta (é outra chave)", async () => {
    const f = montarFila();
    f.fila.pedir("a"); await f.avancar(400); f.fila.pedir("a"); await f.avancar(400);
    assert(f.pedidas.length === 1, `duplicou em voo: ${f.pedidas}`);
    await f.responder("a"); f.fila.pedir("a"); await f.avancar(400);
    assert(f.pedidas.length === 1, `reconsultou a exibida: ${f.pedidas}`);
    f.fila.pedir("b"); await f.avancar(400); await f.responder("b"); f.fila.pedir("a"); await f.avancar(400);
    assert(JSON.stringify(f.pedidas) === JSON.stringify(["a", "b", "a"]), JSON.stringify(f.pedidas));
  });
  t("L15. P1 falha: 503/timeout chega como ok=false (aplicado, sem exceção); 'Tentar novamente' reconsulta a MESMA seleção na hora", async () => {
    const f = montarFila();
    f.fila.pedir("a"); await f.avancar(400); await f.responder("a", false);
    assert(JSON.stringify(f.aplicadas) === JSON.stringify([["a", false]]), JSON.stringify(f.aplicadas));
    f.fila.tentarDeNovo();
    assert(JSON.stringify(f.pedidas) === JSON.stringify(["a", "a"]), `retry não reconsultou: ${f.pedidas}`);
    await f.responder("a", true);
    assert(JSON.stringify(f.aplicadas[1]) === JSON.stringify(["a", true]), JSON.stringify(f.aplicadas));
  });
  t("L16. P1 executar que REJEITA (rede caiu) vira ok=false — a fila não trava e a próxima seleção é consultada", async () => {
    let n = 0; const aplicadas: [string, boolean][] = [];
    const fila = FQ.criarFilaConsulta<string>({ debounceMs: 0, executar: async (c) => { n++; if (c === "x") throw new Error("rede"); return { ok: true, dados: c }; },
      aplicar: (c, r) => aplicadas.push([c, r.ok]), agendar: (fn) => { fn(); return null; }, cancelar: () => {} });
    fila.pedir("x"); await new Promise((r) => setTimeout(r, 5)); fila.pedir("y"); await new Promise((r) => setTimeout(r, 5));
    assert(n === 2 && JSON.stringify(aplicadas) === JSON.stringify([["x", false], ["y", true]]), JSON.stringify(aplicadas));
  });
  t("L17. P1 'carregando' fica ligado enquanto a seleção desejada não chegou (inclusive esperando a anterior) e desliga só com ela", async () => {
    const f = montarFila();
    f.fila.pedir("a"); await f.avancar(400); f.fila.pedir("b"); await f.avancar(400);
    await f.responder("a");
    assert(f.ocupado[f.ocupado.length - 1] === true, `desligou com a resposta antiga: ${f.ocupado}`);
    await f.responder("b");
    assert(f.ocupado[f.ocupado.length - 1] === false, `não desligou: ${f.ocupado}`);
  });
  t("L18. P1 página desmontada: nenhuma resposta é aplicada e nada novo é consultado", async () => {
    const f = montarFila();
    f.fila.pedir("a"); await f.avancar(400); f.fila.encerrar();          // a seleção ATUAL está em voo quando a página sai
    await f.responder("a");
    assert(f.aplicadas.length === 0, `aplicou depois de desmontar: ${JSON.stringify(f.aplicadas)}`);
    f.fila.pedir("b"); await f.avancar(400); f.fila.tentarDeNovo();
    assert(JSON.stringify(f.pedidas) === JSON.stringify(["a"]), `consultou depois de desmontar: ${f.pedidas}`);
  });

  await fila;
  console.log(`\n${falhou === 0 ? "✓" : "✗"} DASHBOARD-CANONICO — ${passou} passaram, ${falhou} falharam`);
  process.exit(falhou === 0 ? 0 : 1);
}
principal().catch((e) => { console.error("ERRO FATAL", e); process.exit(1); });
