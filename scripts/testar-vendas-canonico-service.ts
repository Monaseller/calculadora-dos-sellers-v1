/**
 * SALES-CANONICAL-D13 — consulta canonica compartilhada de vendas (offline).
 *
 * Sem rede, sem banco: um duplo do Supabase responde as MESMAS consultas que
 * os leitores oficiais (lerVendasML / lerVendasShopee), a capability de
 * lojas e o avaliador de frescor fazem. Os valores passam pelos leitores
 * REAIS — o servico nao tem formula.
 *
 *  1. periodo/presets em America/Sao_Paulo (bissexto, virada de ano, horario de verao historico)
 *  2. regressao 04/10 (fixtures SINTETICAS construidas para reproduzir os
 *     numeros homologados live: ML 211/217/7220.62; Shopee 707/7/783/16480.02/16126.58)
 *  3. owner-scoped e R.D. multi-owner (mesmo seller_id em donos diferentes)
 *  4. filtro de marketplace (o leitor nao selecionado nao e chamado)
 *  5. cobertura x frescor (COMPLETE_FRESH/COMPLETE_STALE/PARTIAL/INCOMPLETE; zero x sem cobertura)
 *  6. read-only
 *  7. fonte unica (guarda)
 *
 * Uso: npx tsx scripts/testar-vendas-canonico-service.ts
 */
import "./_server-only-inerte";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const RAIZ = join(__dirname, "..");
let passou = 0, falhou = 0;
let fila: Promise<void> = Promise.resolve();
function t(nome: string, fn: () => void | Promise<void>) {
  fila = fila.then(async () => {
    try { await fn(); passou++; console.log(`  PASS  ${nome}`); }
    catch (e: any) { falhou++; console.log(`  FALHA ${nome} -> ${e?.message ?? e}`); }
  });
}
function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const fonte = (rel: string) => readFileSync(join(RAIZ, rel), "utf8");
const semComentarios = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");

// ── rede proibida: qualquer fetch e falha ──
let fetches = 0;
(globalThis as any).fetch = async () => { fetches++; throw new Error("REDE_PROIBIDA"); };

// ── duplo do Supabase ──
type Reg = { tabela: string; filtros: [string, string, unknown][]; head?: boolean };
const ESCRITAS = ["insert", "update", "upsert", "delete"];
function clienteFalso(dados: Record<string, any[]>, regs: Reg[], escritas: string[]) {
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

// ── mundo ficticio (R.D. e outro dono com o MESMO seller_id/shop_id) ──
const AGORA = Date.parse("2026-10-07T15:00:00.000Z");   // 12:00 em Sao Paulo
const OBS = "2026-10-07T12:00:00.000Z";                  // observacao 3h antes de agora (fresca)
const RD = "dono-rd", OUTRO = "dono-outro";
const ML_A = "aaaaaaaa-0000-4000-8000-00000000000a", ML_B = "aaaaaaaa-0000-4000-8000-00000000000b";
const SH_A = "aaaaaaaa-0000-4000-8000-0000000001aa";
const ML_X = "bbbbbbbb-0000-4000-8000-00000000000a", SH_X = "bbbbbbbb-0000-4000-8000-0000000001aa";
const cred = { access_token: "tk-fake", refresh_token: "rt-fake", token_expires_at: "2030-01-01T00:00:00Z" };
const loja = (id: string, user_id: string, marketplace: "ML" | "Shopee", seller_id: string, extra: Record<string, unknown> = {}) =>
  ({ id, user_id, marketplace, ativo: true, nickname: "MESMO_NICK", seller_id, partner_id: marketplace === "Shopee" ? 9 : null, partner_key: marketplace === "Shopee" ? "pk-fake" : null, ...cred, ...extra });

// ML 04/10 — 211 pedidos contados / 217 unidades / R$ 7.220,62 (+ pack_splitted e bordas fora do dia)
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
// Shopee 04/10 — 707 pedidos / 7 cancelados / 783 unidades / 16.480,02 / 16.126,58
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
const jobML = (lojaId: string, user_id: string, extra: Record<string, unknown> = {}) => ({ id: `job-${lojaId}`, user_id, loja_id: lojaId, marketplace: "ML", campo_tempo: "date_closed",
  janela_inicio: "2026-10-01T03:00:00.000Z", janela_fim: "2026-10-06T03:00:00.000Z", listagem_completa: true, status: "concluido", concluido_em: OBS, criado_em: OBS, ...extra });
const jobShopee = (lojaId: string, user_id: string, extra: Record<string, unknown> = {}) => ({ id: `job-${lojaId}`, user_id, loja_id: lojaId, marketplace: "Shopee", campo_tempo: "create_time",
  janela_inicio: "2026-09-20T03:00:00.000Z", janela_fim: "2026-10-06T03:00:00.000Z", listagem_completa: true, status: "concluido", concluido_em: OBS, criado_em: OBS, ...extra });

function mundo() {
  const shA = pedidosShopee(SH_A, RD), shX = pedidosShopee(SH_X, OUTRO);
  return {
    lojas: [loja(ML_A, RD, "ML", "111"), loja(ML_B, RD, "ML", "222"), loja(SH_A, RD, "Shopee", "333"),
      loja(ML_X, OUTRO, "ML", "111"), loja(SH_X, OUTRO, "Shopee", "333")],
    ml_pedidos: [...pedidosML(ML_A, RD),
      { user_id: RD, loja_id: ML_B, order_id: "20001", date_closed: "2026-10-04T12:00:00.000Z", cancel_detail_code: null, total_amount: 0.1, unidades: 1, fetched_at: OBS },
      { user_id: RD, loja_id: ML_B, order_id: "20002", date_closed: "2026-10-04T13:00:00.000Z", cancel_detail_code: null, total_amount: 0.2, unidades: 1, fetched_at: OBS },
      ...pedidosML(ML_X, OUTRO, 10)],
    shopee_pedidos: [...shA.sp, ...shX.sp],
    pedidos: [...shA.itens, ...shX.itens],
    sync_jobs: [jobML(ML_A, RD), jobML(ML_B, RD), jobShopee(SH_A, RD), jobML(ML_X, OUTRO), jobShopee(SH_X, OUTRO)],
  } as Record<string, any[]>;
}

async function principal() {
  const P = await import("../lib/vendas/canonico/periodo");
  const S = await import("../lib/vendas/canonico/shopee");
  const V = await import("../lib/vendas/canonico/service");
  const C = await import("../lib/marketplace/credenciais");

  const escritas: string[] = [];
  const consultar = async (args: any, dados = mundo(), regs: Reg[] = [], agoraMs = AGORA) =>
    V.consultarVendasCanonicas(args, { cliente: clienteFalso(dados, regs, escritas), agoraMs });
  const erroDe = async (f: () => Promise<unknown>) => { try { await f(); return "NAO_LANCOU"; } catch (e: any) { return e instanceof V.ErroVendasCanonicas ? e.codigo : `OUTRO:${e?.message}`; } };
  const D04 = { preset: "CUSTOM" as const, de: "2026-10-04", ate: "2026-10-04" };

  console.log("\n[1. periodo e presets — America/Sao_Paulo, [inicio, fim)]");
  const r = (preset: string, agora: number | string = AGORA, de?: string, ate?: string) =>
    P.resolverPeriodoVendas({ preset, de, ate }, typeof agora === "string" ? Date.parse(agora) : agora);
  t("1a. HOJE = 07/10 parcial; [07/10 03:00Z, 08/10 03:00Z)", () => {
    const p = r("HOJE");
    assert(p.de === "2026-10-07" && p.ate === "2026-10-07" && p.parcial && p.dias === 1, JSON.stringify(p));
    assert(p.inicioInclusivo === "2026-10-07T03:00:00.000Z" && p.fimExclusivo === "2026-10-08T03:00:00.000Z" && p.fuso === "America/Sao_Paulo", JSON.stringify(p));
  });
  t("1b. 'hoje' e o dia civil de SP, nao o de UTC (23:30 SP = 02:30Z do dia seguinte)", () => {
    assert(r("HOJE", "2026-10-08T02:30:00.000Z").de === "2026-10-07", "23:30 SP");
    assert(r("HOJE", "2026-10-08T03:00:00.000Z").de === "2026-10-08", "00:00 SP");
  });
  t("1c. ONTEM = 06/10, completo (nao parcial)", () => { const p = r("ONTEM"); assert(p.de === "2026-10-06" && p.ate === "2026-10-06" && !p.parcial, JSON.stringify(p)); });
  t("1d. ULTIMOS_7/30/60_DIAS = N dias COMPLETOS terminando ONTEM (hoje fora)", () => {
    const a = r("ULTIMOS_7_DIAS"), b = r("ULTIMOS_30_DIAS"), c = r("ULTIMOS_60_DIAS");
    assert(a.de === "2026-09-30" && a.ate === "2026-10-06" && a.dias === 7 && !a.parcial, JSON.stringify(a));
    assert(b.de === "2026-09-07" && b.ate === "2026-10-06" && b.dias === 30 && !b.parcial, JSON.stringify(b));
    assert(c.de === "2026-08-08" && c.ate === "2026-10-06" && c.dias === 60 && !c.parcial, JSON.stringify(c));
  });
  t("1e. MES_PASSADO = 01–30/09; ESTE_MES = 01–07/10 parcial; ESTE_ANO = 01/01–07/10 parcial", () => {
    const m = r("MES_PASSADO"), e = r("ESTE_MES"), y = r("ESTE_ANO");
    assert(m.de === "2026-09-01" && m.ate === "2026-09-30" && !m.parcial && m.dias === 30, JSON.stringify(m));
    assert(e.de === "2026-10-01" && e.ate === "2026-10-07" && e.parcial, JSON.stringify(e));
    assert(y.de === "2026-01-01" && y.ate === "2026-10-07" && y.parcial && y.dias === 280, JSON.stringify(y));
  });
  t("1f. virada de ano: 01/01/2027 → ONTEM 31/12, MES_PASSADO dez/2026, ULTIMOS_7 25–31/12, ESTE_ANO 01/01/2027", () => {
    const ag = "2027-01-01T12:00:00.000Z";
    assert(r("ONTEM", ag).de === "2026-12-31", "ontem");
    const m = r("MES_PASSADO", ag); assert(m.de === "2026-12-01" && m.ate === "2026-12-31", JSON.stringify(m));
    const s = r("ULTIMOS_7_DIAS", ag); assert(s.de === "2026-12-25" && s.ate === "2026-12-31", JSON.stringify(s));
    const y = r("ESTE_ANO", ag); assert(y.de === "2027-01-01" && y.ate === "2027-01-01" && y.dias === 1, JSON.stringify(y));
    // 31/12 23:00 em SP ja e 01/01 em UTC: o ano ainda e 2026
    const y2 = r("ESTE_ANO", "2027-01-01T02:00:00.000Z"); assert(y2.de === "2026-01-01" && y2.ate === "2026-12-31", JSON.stringify(y2));
  });
  t("1g. bissexto: mar/2028 → MES_PASSADO 01–29/02 e ONTEM 29/02; mar/2027 → 28/02; 29/02/2026 invalido", () => {
    const m = r("MES_PASSADO", "2028-03-01T12:00:00.000Z"); assert(m.de === "2028-02-01" && m.ate === "2028-02-29" && m.dias === 29, JSON.stringify(m));
    assert(r("ONTEM", "2028-03-01T12:00:00.000Z").de === "2028-02-29", "ontem bissexto");
    assert(r("MES_PASSADO", "2027-03-01T12:00:00.000Z").ate === "2027-02-28", "nao bissexto");
    assert(r("CUSTOM", "2028-03-05T12:00:00.000Z", "2028-02-29", "2028-02-29").dias === 1, "29/02/2028 valido");
    let e = ""; try { r("CUSTOM", AGORA, "2026-02-29", "2026-03-01"); } catch (x: any) { e = x.detalhe; }
    assert(e === "data_invalida", e);
  });
  t("1h. offset REAL do dia (sem -3h fixo): 15/01/2019 em horario de verao → inicio 02:00Z", () => {
    const p = r("CUSTOM", AGORA, "2019-01-15", "2019-01-15");
    assert(p.inicioInclusivo === "2019-01-15T02:00:00.000Z" && p.fimExclusivo === "2019-01-16T02:00:00.000Z", JSON.stringify(p));
  });
  t("1i. CUSTOM invalido: fim < inicio, futuro, formato, mes 13, preset com datas, preset desconhecido", () => {
    const det = (f: () => unknown) => { try { f(); return "NAO_LANCOU"; } catch (x: any) { return x instanceof P.ErroPeriodoVendas ? x.detalhe : "OUTRO"; } };
    assert(det(() => r("CUSTOM", AGORA, "2026-10-05", "2026-10-04")) === "fim_antes_do_inicio", "fim<inicio");
    assert(det(() => r("CUSTOM", AGORA, "2026-10-07", "2026-10-08")) === "periodo_no_futuro", "futuro");
    assert(det(() => r("CUSTOM", AGORA, "04/10/2026", "2026-10-04")) === "data_invalida", "formato");
    assert(det(() => r("CUSTOM", AGORA, "2026-13-01", "2026-13-01")) === "data_invalida", "mes 13");
    assert(det(() => r("CUSTOM", AGORA)) === "data_invalida", "sem datas");
    assert(det(() => r("HOJE", AGORA, "2026-10-01", "2026-10-02")) === "preset_com_datas", "preset+datas");
    assert(det(() => r("ULTIMOS_90_DIAS")) === "preset_desconhecido", "preset");
  });
  t("1j. CUSTOM terminando hoje e parcial; o intervalo tecnico e IDENTICO ao intervaloSaoPaulo dos leitores", () => {
    assert(r("CUSTOM", AGORA, "2026-10-01", "2026-10-07").parcial, "parcial");
    for (const [de, ate] of [["2026-10-04", "2026-10-04"], ["2026-01-01", "2026-12-31"], ["2028-02-28", "2028-03-01"], ["2018-11-03", "2018-11-05"], ["2019-02-16", "2019-02-17"]]) {
      const p = r("CUSTOM", "2030-01-01T12:00:00.000Z", de, ate), iv = S.intervaloSaoPaulo(de, ate);
      assert(p.inicioInclusivo === iv.inicio.toISOString() && p.fimExclusivo === iv.fim.toISOString(), `${de}..${ate}`);
    }
  });
  t("1k. resolvedor nao reusa o legado (date-range-utils: UTC-3 fixo) e nao tem offset fixo", () => {
    const s = semComentarios(fonte("lib/vendas/canonico/periodo.ts"));
    assert(!/date-range-utils|hojeISOBrasilia|calcularUltimos30Dias/.test(s), "legado reusado");
    assert(!/3\s*\*\s*60\s*\*\s*60|-03:00|10800|UTC-3/.test(s), "offset fixo");
    assert(/fuso-sao-paulo/.test(s) && !/react|"use client"/i.test(s), "fuso/React");
  });

  console.log("\n[2. regressao 04/10 pelos leitores oficiais (fixtures SINTETICAS)]");
  t("2a. ML 04/10 (loja A) = 211 / 217 / 7220.62 — COMPLETE_FRESH; Shopee nem consultada", async () => {
    const regs: Reg[] = [];
    const res = await consultar({ userId: RD, marketplace: "mercado_livre", lojaId: ML_A, ...D04 }, mundo(), regs);
    const m = res.metricas.mercadoLivre!;
    assert(m.pedidos === 211 && m.unidades === 217 && m.vendas === 7220.62, JSON.stringify(m));
    assert(res.metricas.combinadas!.vendas === 7220.62 && res.metricas.shopee === null && res.estado === "COMPLETE_FRESH", JSON.stringify(res.metricas));
    assert(!regs.some((g) => g.tabela === "shopee_pedidos" || g.tabela === "pedidos"), "Shopee consultada");
  });
  t("2b. Shopee 04/10 = 707 / 7 cancelados / 783 / 16480.02 / 16126.58 — COMPLETE_FRESH; ML nem consultado", async () => {
    const regs: Reg[] = [];
    const res = await consultar({ userId: RD, marketplace: "shopee", ...D04 }, mundo(), regs);
    const m = res.metricas.shopee!;
    assert(m.pedidos === 707 && m.cancelados === 7 && m.unidades === 783 && m.vendas === 16480.02 && m.vendasSemDescontosPlataforma === 16126.58, JSON.stringify(m));
    assert(res.estado === "COMPLETE_FRESH" && res.metricas.mercadoLivre === null && res.cobertura.lojas[0].componentes !== null, JSON.stringify(res.cobertura));
    assert(!regs.some((g) => g.tabela === "ml_pedidos"), "ML consultado");
  });
  t("2c. 'todos' R.D. = ML (A+B) + Shopee, centavo exato (0.10 + 0.20 e 7220.62 + 16480.02)", async () => {
    const res = await consultar({ userId: RD, marketplace: "todos", ...D04 });
    assert(res.metricas.mercadoLivre!.vendas === 7220.92 && res.metricas.mercadoLivre!.pedidos === 213, JSON.stringify(res.metricas.mercadoLivre));
    const c = res.metricas.combinadas!;
    assert(c.pedidos === 920 && c.unidades === 1002 && c.vendas === 23700.94, JSON.stringify(c));
    assert(res.estado === "COMPLETE_FRESH" && res.metricas.semVendas === false, res.estado);
  });
  t("2d. 'todos': cancelados / vendasSemDescontosPlataforma / componentes NAO somados e documentados", async () => {
    const res = await consultar({ userId: RD, marketplace: "todos", ...D04 });
    assert(Object.keys(res.metricas.combinadas!).sort().join() === "pedidos,unidades,vendas", Object.keys(res.metricas.combinadas!).join());
    const inc = res.metricas.incompatibilidades.join(" | ");
    assert(/cancelados/.test(inc) && /vendasSemDescontosPlataforma/.test(inc) && /componentes/.test(inc), inc);
    const so = await consultar({ userId: RD, marketplace: "shopee", ...D04 });
    assert(so.metricas.incompatibilidades.length === 0, "incompatibilidade sem 'todos'");
  });

  console.log("\n[3. owner-scoped e R.D. multi-owner]");
  t("3a. loja de OUTRO dono → LOJA_FORA_DO_OWNER, sem ler pedido nenhum", async () => {
    const regs: Reg[] = [];
    assert(await erroDe(() => consultar({ userId: RD, marketplace: "mercado_livre", lojaId: ML_X, ...D04 }, mundo(), regs)) === "LOJA_FORA_DO_OWNER", "codigo");
    assert(!regs.some((g) => ["ml_pedidos", "shopee_pedidos", "pedidos", "sync_jobs"].includes(g.tabela)), regs.map((g) => g.tabela).join());
  });
  t("3b. loja inexistente → o MESMO erro (nao vaza existencia); owner ausente → OWNER_AUSENTE", async () => {
    assert(await erroDe(() => consultar({ userId: RD, marketplace: "todos", lojaId: "nao-existe", ...D04 })) === "LOJA_FORA_DO_OWNER", "inexistente");
    assert(await erroDe(() => consultar({ userId: "", marketplace: "todos", ...D04 })) === "OWNER_AUSENTE", "owner");
  });
  t("3c. R.D.: so lojas do dono; a loja de outro dono com o MESMO seller_id/shop_id/nickname nunca entra", async () => {
    const regs: Reg[] = [];
    const res = await consultar({ userId: RD, marketplace: "todos", ...D04 }, mundo(), regs);
    assert(res.cobertura.lojas.map((l) => l.lojaId).sort().join() === [ML_A, ML_B, SH_A].sort().join(), res.cobertura.lojas.map((l) => l.lojaId).join());
    for (const g of regs) assert(g.filtros.some(([op, c, v]) => op === "eq" && c === "user_id" && v === RD), `${g.tabela} sem dono`);
  });
  t("3d. mesmo seller_id sob dois donos = dois resultados independentes, sem dedup e nunca somados", async () => {
    const rd = await consultar({ userId: RD, marketplace: "mercado_livre", ...D04 });
    const ou = await consultar({ userId: OUTRO, marketplace: "mercado_livre", ...D04 });
    assert(ou.cobertura.lojas.length === 1 && ou.cobertura.lojas[0].lojaId === ML_X, JSON.stringify(ou.cobertura.lojas));
    assert(ou.metricas.mercadoLivre!.vendas === 72206.2 && ou.metricas.mercadoLivre!.pedidos === 211, JSON.stringify(ou.metricas.mercadoLivre));
    assert(rd.metricas.mercadoLivre!.vendas === 7220.92 && rd.metricas.mercadoLivre!.pedidos === 213, JSON.stringify(rd.metricas.mercadoLivre));
  });
  t("3e. multi-loja generica: R.D. sem lojaId agrega TODAS as lojas ML do dono (nenhum nome fixo)", async () => {
    const d = mundo(); const extra = "aaaaaaaa-0000-4000-8000-00000000000c";
    d.lojas.push(loja(extra, RD, "ML", "444")); d.sync_jobs.push(jobML(extra, RD));
    d.ml_pedidos.push({ user_id: RD, loja_id: extra, order_id: "1", date_closed: "2026-10-04T20:00:00.000Z", cancel_detail_code: null, total_amount: 1.05, unidades: 3, fetched_at: OBS });
    const res = await consultar({ userId: RD, marketplace: "mercado_livre", ...D04 }, d);
    assert(res.cobertura.lojas.length === 3 && res.metricas.mercadoLivre!.vendas === 7221.97 && res.metricas.mercadoLivre!.unidades === 222, JSON.stringify(res.metricas.mercadoLivre));
  });
  t("3f. capability de lojas: owner-scoped e devolve SO {id, marketplace, ativo, elegibilidade} (nenhuma credencial)", async () => {
    const regs: Reg[] = [];
    const { linhas, erro } = await C.listarLojasDoDonoParaVendasCanonicas(RD, clienteFalso(mundo(), regs, escritas), AGORA);
    assert(!erro && linhas.length === 3, JSON.stringify(linhas));
    for (const l of linhas) assert(Object.keys(l).sort().join() === "ativo,elegibilidade,id,marketplace", Object.keys(l).join());
    assert(!JSON.stringify(linhas).includes("tk-fake") && !JSON.stringify(linhas).includes("pk-fake"), "credencial vazou");
    assert(regs[0].filtros.some(([op, c, v]) => op === "eq" && c === "user_id" && v === RD), "sem dono");
  });

  console.log("\n[4. filtro de marketplace]");
  t("4a. 'mercado_livre': nenhuma leitura Shopee (shopee_pedidos, pedidos, sync_jobs Shopee)", async () => {
    const regs: Reg[] = [];
    await consultar({ userId: RD, marketplace: "mercado_livre", ...D04 }, mundo(), regs);
    assert(!regs.some((g) => g.tabela === "shopee_pedidos" || g.tabela === "pedidos"), "pedidos Shopee");
    assert(!regs.some((g) => g.filtros.some(([op, c, v]) => op === "eq" && c === "marketplace" && v === "Shopee")), "filtro Shopee");
  });
  t("4b. 'shopee': nenhuma leitura ML (ml_pedidos, sync_jobs ML)", async () => {
    const regs: Reg[] = [];
    await consultar({ userId: RD, marketplace: "shopee", ...D04 }, mundo(), regs);
    assert(!regs.some((g) => g.tabela === "ml_pedidos"), "ml_pedidos");
    assert(!regs.some((g) => g.filtros.some(([op, c, v]) => op === "eq" && c === "marketplace" && v === "ML")), "filtro ML");
  });
  t("4c. 'todos': ML e Shopee leem EXATAMENTE o mesmo intervalo resolvido", async () => {
    const regs: Reg[] = [];
    const res = await consultar({ userId: RD, marketplace: "todos", preset: "ULTIMOS_7_DIAS" }, mundo(), regs);
    const lim = (tab: string, col: string) => regs.filter((g) => g.tabela === tab && !g.head).map((g) =>
      `${g.filtros.find(([op, c]) => op === "gte" && c === col)?.[2]}|${g.filtros.find(([op, c]) => op === "lt" && c === col)?.[2]}`);
    const esperado = `${res.periodo.inicioInclusivo}|${res.periodo.fimExclusivo}`;
    const ml = lim("ml_pedidos", "date_closed"), sh = lim("shopee_pedidos", "pay_time");
    assert(ml.length >= 1 && sh.length >= 1 && [...ml, ...sh].every((x) => x === esperado), `${esperado} ml=${ml} sh=${sh}`);
  });
  t("4d. marketplace invalido e loja de outro marketplace → MARKETPLACE_INVALIDO", async () => {
    assert(await erroDe(() => consultar({ userId: RD, marketplace: "ML", ...D04 })) === "MARKETPLACE_INVALIDO", "ML");
    assert(await erroDe(() => consultar({ userId: RD, marketplace: "amazon", ...D04 })) === "MARKETPLACE_INVALIDO", "amazon");
    assert(await erroDe(() => consultar({ userId: RD, marketplace: "mercado_livre", lojaId: SH_A, ...D04 })) === "MARKETPLACE_INVALIDO", "loja shopee");
  });
  t("4e. 'todos' com dono so-ML: Shopee nao e lida, marketplacesSemLoja=[shopee], segue COMPLETE", async () => {
    const d = mundo(); d.lojas = d.lojas.filter((l) => !(l.user_id === RD && l.marketplace === "Shopee"));
    const regs: Reg[] = [];
    const res = await consultar({ userId: RD, marketplace: "todos", ...D04 }, d, regs);
    assert(res.cobertura.marketplacesSemLoja.join() === "shopee" && res.estado === "COMPLETE_FRESH", JSON.stringify(res.cobertura));
    assert(!regs.some((g) => g.tabela === "shopee_pedidos"), "Shopee lida");
  });
  t("4f. 'shopee' para dono sem loja Shopee → PERIODO_SEM_COBERTURA (nunca zero)", async () => {
    const d = mundo(); d.lojas = d.lojas.filter((l) => l.marketplace !== "Shopee");
    assert(await erroDe(() => consultar({ userId: RD, marketplace: "shopee", ...D04 }, d)) === "PERIODO_SEM_COBERTURA", "codigo");
  });
  t("4g. lojaId + 'todos': so o marketplace da loja e lido", async () => {
    const regs: Reg[] = [];
    const res = await consultar({ userId: RD, marketplace: "todos", lojaId: SH_A, ...D04 }, mundo(), regs);
    assert(!regs.some((g) => g.tabela === "ml_pedidos") && res.cobertura.marketplacesConsultados.join() === "shopee", "ML lido");
  });
  t("4h. periodo invalido → PERIODO_INVALIDO (antes de qualquer leitura)", async () => {
    const regs: Reg[] = [];
    assert(await erroDe(() => consultar({ userId: RD, marketplace: "todos", preset: "CUSTOM", de: "2026-10-09", ate: "2026-10-09" }, mundo(), regs)) === "PERIODO_INVALIDO", "futuro");
    assert(regs.length === 0, "leu antes de validar");
  });

  console.log("\n[5. cobertura x frescor]");
  t("5a. uma loja sem cobertura → agregado INCOMPLETE e metricas NULAS; a loja completa segue completa", async () => {
    const d = mundo(); d.sync_jobs = d.sync_jobs.filter((j) => j.loja_id !== ML_B);
    const res = await consultar({ userId: RD, marketplace: "todos", ...D04 }, d);
    const b = res.cobertura.lojas.find((l) => l.lojaId === ML_B)!, a = res.cobertura.lojas.find((l) => l.lojaId === ML_A)!;
    assert(res.estado === "INCOMPLETE" && res.cobertura.estado === "INCOMPLETE" && res.metricas.combinadas === null && res.metricas.semVendas === null, res.estado);
    assert(res.metricas.mercadoLivre === null && res.metricas.shopee === null, "parcial vazou");
    assert(b.cobertura === "INCOMPLETE" && b.metricas === null && b.motivos.includes("COBERTURA_DO_PERIODO_FECHADO_INCOMPLETA"), JSON.stringify(b));
    assert(a.cobertura === "COMPLETE" && (a.metricas as any).vendas === 7220.62, JSON.stringify(a));
  });
  t("5b. loja INATIVA: aparece com motivo LOJA_INATIVA e o agregado nao e COMPLETE (nunca excluida em silencio)", async () => {
    const d = mundo(); d.lojas.find((l) => l.id === ML_B)!.ativo = false;
    const res = await consultar({ userId: RD, marketplace: "mercado_livre", ...D04 }, d);
    const b = res.cobertura.lojas.find((l) => l.lojaId === ML_B)!;
    assert(b && b.motivos.includes("LOJA_INATIVA") && b.cobertura === "INCOMPLETE" && res.estado === "INCOMPLETE", JSON.stringify(b));
    assert(b.frescor === "DESCONHECIDO", b.frescor);
  });
  t("5c. credencial inutilizavel (expirada sem refresh): motivo estruturado e agregado INCOMPLETE", async () => {
    const d = mundo(); Object.assign(d.lojas.find((l) => l.id === SH_A)!, { refresh_token: null, token_expires_at: "2026-01-01T00:00:00Z" });
    const res = await consultar({ userId: RD, marketplace: "todos", ...D04 }, d);
    const s = res.cobertura.lojas.find((l) => l.lojaId === SH_A)!;
    assert(s.elegibilidade === "INRECUPERAVEL_SEM_CREDENCIAL" && s.motivos.includes("CREDENCIAL_INUTILIZAVEL:expirado_sem_refresh") && res.estado === "INCOMPLETE", JSON.stringify(s));
  });
  t("5d. COMPLETO e SEM VENDA (05/10) ≠ SEM COBERTURA (06/10)", async () => {
    // a fixture ML tem um pedido de borda em 05/10 00:00 SP (que PERTENCE a 05/10): fora deste cenario de dia sem venda
    const semBorda = mundo(); semBorda.ml_pedidos = semBorda.ml_pedidos.filter((p) => p.order_id !== "2997");
    const zero = await consultar({ userId: RD, marketplace: "todos", preset: "CUSTOM", de: "2026-10-05", ate: "2026-10-05" }, semBorda);
    assert(zero.cobertura.estado === "COMPLETE" && zero.metricas.semVendas === true && zero.metricas.combinadas!.pedidos === 0 && zero.metricas.combinadas!.vendas === 0, JSON.stringify(zero.metricas));
    const sem = await consultar({ userId: RD, marketplace: "todos", preset: "ONTEM" });
    assert(sem.periodo.de === "2026-10-06" && sem.estado === "INCOMPLETE" && sem.metricas.combinadas === null && sem.metricas.semVendas === null, JSON.stringify(sem.metricas));
  });
  // SALES-CANONICAL-D14: contrato parcial — sem janela de hoje (como em producao) a parte atual NAO e observada;
  // e um buraco na parte ja fechada (06/10 sem janela neste mundo) e INCOMPLETE, nao PARTIAL.
  t("5e. HOJE sem janela de hoje → PARTIAL_SEM_OBSERVACAO_ATUAL (metricas nulas); ESTE_MES/ESTE_ANO com 06/10 descoberto → INCOMPLETE", async () => {
    const h = await consultar({ userId: RD, marketplace: "todos", preset: "HOJE" });
    assert(h.estado === "PARTIAL_SEM_OBSERVACAO_ATUAL" && h.cobertura.estado === "PARTIAL" && h.parcial && !h.completo && h.metricas.combinadas === null && h.fresco === null, `HOJE ${h.estado}`);
    assert(h.cobertura.lojas.every((l) => l.cobertura === "PARTIAL" && l.motivos.includes("PERIODO_INCLUI_HOJE") && l.parteAtual?.estado === "NAO_OBSERVADA"), "HOJE lojas");
    for (const preset of ["ESTE_MES", "ESTE_ANO"]) {
      const res = await consultar({ userId: RD, marketplace: "todos", preset });
      assert(res.estado === "INCOMPLETE" && res.parcial && res.metricas.combinadas === null, `${preset} ${res.estado}`);
    }
  });
  t("5f. COMPLETE_STALE: cobertura completa com observacao velha → metricas presentes, frescor STALE (dimensoes separadas)", async () => {
    const d = mundo(); for (const j of d.sync_jobs) j.concluido_em = "2026-10-05T04:00:00.000Z";
    const res = await consultar({ userId: RD, marketplace: "mercado_livre", lojaId: ML_A, ...D04 }, d);
    assert(res.estado === "COMPLETE_STALE" && res.cobertura.estado === "COMPLETE" && res.frescor.estado === "STALE" && res.metricas.mercadoLivre!.vendas === 7220.62, JSON.stringify({ e: res.estado, f: res.frescor }));
  });
  t("5g. janela em erro → leitor FAILED → loja INCOMPLETE com LEITURA_FAILED", async () => {
    const d = mundo(); Object.assign(d.sync_jobs.find((j) => j.loja_id === ML_B)!, { status: "erro", listagem_completa: null });
    const res = await consultar({ userId: RD, marketplace: "mercado_livre", ...D04 }, d);
    const b = res.cobertura.lojas.find((l) => l.lojaId === ML_B)!;
    assert(b.completudeLeitor === "FAILED" && b.motivos.includes("LEITURA_FAILED") && res.estado === "INCOMPLETE", JSON.stringify(b));
  });
  t("5h. erro de leitura do banco → LEITURA_FALHOU tipado (sem mensagem crua)", async () => {
    const quebrado = { from() { const c: any = new Proxy({}, { get(_a, p: string) {
      if (p === "then") return (ok: any) => ok({ data: null, error: { message: "x" } });
      if (p === "range") return () => Promise.resolve({ data: null, error: { message: "x" } });
      return () => c; } }); return c; } };
    let codigo = ""; try { await V.consultarVendasCanonicas({ userId: RD, marketplace: "todos", ...D04 }, { cliente: quebrado, agoraMs: AGORA }); } catch (e: any) { codigo = e.codigo; }
    assert(codigo === "LEITURA_FALHOU", codigo);
  });

  console.log("\n[6. read-only]");
  t("6a. nenhuma escrita (insert/update/upsert/delete/rpc) e nenhuma rede em TODOS os cenarios acima", () => {
    assert(escritas.length === 0, escritas.join());
    assert(fetches === 0, `fetch=${fetches}`);
  });
  const SERVICO = ["lib/vendas/canonico/service/consultar-vendas-canonicas.ts", "lib/vendas/canonico/service/tipos.ts", "lib/vendas/canonico/service/index.ts", "lib/vendas/canonico/periodo.ts"];
  t("6b. servico: sem sync-on-read, sem provider, sem token, sem job, sem React/Next/fetch", () => {
    for (const f of SERVICO) {
      const s = semComentarios(fonte(f));
      assert(!/\.(insert|update|upsert|delete|rpc)\(/.test(s), `${f}: escrita`);
      assert(!/garantirProximaAcao|criarJob|worker|motor|executar|renovar|refresh|provider|ml-auth|shopee-auth|fetch\(/i.test(s), `${f}: efeito`);
      assert(!/from\s+["'](react|next)|"use client"|\.tsx["']/.test(s), `${f}: UI`);
    }
  });

  console.log("\n[7. fonte unica (guarda)]");
  const arquivos = (dir: string): string[] => {
    if (!existsSync(join(RAIZ, dir))) return [];
    const out: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { if (f === "node_modules" || f.startsWith(".")) continue; const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(f)) out.push(p.slice(RAIZ.length + 1).replace(/\\/g, "/")); } };
    walk(join(RAIZ, dir)); return out;
  };
  const codigoApp = [...arquivos("app"), ...arquivos("components"), ...arquivos("lib"), ...arquivos("hooks")];
  t("7a. lerVendasML/lerVendasShopee so sao chamados pelo servico (e pelos proprios leitores)", () => {
    const permitidos = new Set(["lib/vendas/canonico/ml.ts", "lib/vendas/canonico/shopee.ts", "lib/vendas/canonico/service/consultar-vendas-canonicas.ts"]);
    const fora = codigoApp.filter((f) => !permitidos.has(f) && /\blerVendas(ML|Shopee)\b/.test(semComentarios(fonte(f))));
    assert(fora.length === 0, fora.join(", "));
  });
  t("7b. o servico nao tem formula (centavos, escrow, total_amount, pack_splitted, Math.round)", () => {
    for (const f of SERVICO) {
      const s = semComentarios(fonte(f));
      assert(!/centavos\(|Math\.round|\*\s*100|total_amount|escrow_|pack_splitted|valor_unit|original_shopee_discount/.test(s), f);
    }
  });
  t("7c. o servico nao monta query: lojas pela capability, valores pelos leitores, frescor pelo coordenador", () => {
    const s = semComentarios(fonte(SERVICO[0]));
    assert(!/\.from\(/.test(s), ".from no servico");
    assert(/listarLojasDoDonoParaVendasCanonicas/.test(s) && /lerVendasML/.test(s) && /lerVendasShopee/.test(s) && /avaliarNecessidadeDeSync/.test(s) && /POLITICA_SYNC_PROPOSTA/.test(s), "fonte oficial ausente");
  });
  t("7d. sem loja/conta fixa e sem dedup por seller_id/shop_id/nickname no servico", () => {
    for (const f of SERVICO) {
      const s = semComentarios(fonte(f));
      assert(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(s), `${f}: uuid fixo`);
      assert(!/seller_id|shop_id|nickname|sellerId|shopId/.test(s), `${f}: chave de dedup`);
    }
  });
  // SALES-CANONICAL-D16B: o UNICO importador autorizado e a rota do resumo canonico dos 4 cards do Dashboard.
  // Vendas, Dashboard (direto) e qualquer outra rota/pagina/componente seguem proibidos.
  t("7e. so a rota /api/vendas/resumo-canonico importa o servico canonico (Vendas/Dashboard/outras telas nao)", () => {
    const ligados = [...arquivos("app"), ...arquivos("components")].filter((f) => /vendas\/canonico\/(service|periodo|dashboard-resumo)/.test(fonte(f)));
    assert(ligados.join(",") === "app/api/vendas/resumo-canonico/route.ts", ligados.join(", "));
  });
  t("7f. o resolvedor de periodo e unico: nenhum outro modulo de lib/vendas define presets canonicos", () => {
    // planejamento.ts: OPCOES_BACKFILL_INICIAL usa "ULTIMOS_7_DIAS" como id de HORIZONTE de bootstrap do sync — nao e periodo de exibicao
    const permitidos = new Set(["lib/vendas/canonico/periodo.ts", "lib/vendas/sync/planejamento.ts"]);
    const outros = codigoApp.filter((f) => !permitidos.has(f) && /ULTIMOS_(7|30|60)_DIAS|MES_PASSADO|ESTE_MES|ESTE_ANO/.test(semComentarios(fonte(f))));
    assert(outros.length === 0, outros.join(", "));
  });

  console.log("\n[8. capability owner-scoped (D13A)]");
  const X = await import("./_excecao-d13-vendas-canonicas");
  const mundoCap = () => {
    const d = mundo();
    Object.assign(d.lojas.find((l) => l.id === ML_B)!, { refresh_token: null, token_expires_at: "2026-01-01T00:00:00Z" }); // ativa, irrecuperavel
    d.lojas.find((l) => l.id === SH_A)!.ativo = false;                                                                  // inativa
    return d;
  };
  const listar = async (regs: Reg[] = []) => (await C.listarLojasDoDonoParaVendasCanonicas(RD, clienteFalso(mundoCap(), regs, escritas), AGORA)).linhas;
  t("8A. a query leva SO o user_id pedido (eq no datasource), nenhum outro dono", async () => {
    const regs: Reg[] = []; await listar(regs);
    assert(regs.length === 1 && regs[0].tabela === "lojas", regs.map((g) => g.tabela).join());
    const donos = regs[0].filtros.filter(([, c]) => c === "user_id");
    assert(donos.length === 1 && donos[0][0] === "eq" && donos[0][2] === RD, JSON.stringify(regs[0].filtros));
  });
  t("8B. inclui loja ATIVA ELEGIVEL", async () => {
    const a = (await listar()).find((l) => l.id === ML_A)!;
    assert(a && a.ativo === true && a.elegibilidade.estado === "ELEGIVEL", JSON.stringify(a));
  });
  t("8C. inclui loja ATIVA IRRECUPERAVEL (com motivo)", async () => {
    const b = (await listar()).find((l) => l.id === ML_B)!;
    assert(b && b.ativo === true && b.elegibilidade.estado === "INRECUPERAVEL_SEM_CREDENCIAL" && (b.elegibilidade as any).motivo === "expirado_sem_refresh", JSON.stringify(b));
  });
  t("8D. inclui loja INATIVA", async () => {
    const s = (await listar()).find((l) => l.id === SH_A)!;
    assert(s && s.ativo === false && s.marketplace === "Shopee", JSON.stringify(s));
  });
  t("8E. nenhum campo de credencial no retorno", async () => {
    const ls = await listar(); const txt = JSON.stringify(ls);
    for (const l of ls) assert(Object.keys(l).sort().join() === "ativo,elegibilidade,id,marketplace", Object.keys(l).join());
    assert(!/tk-fake|rt-fake|pk-fake|access_token|refresh_token|partner_key|token_expires_at|seller_id|partner_id/.test(txt), txt);
  });
  t("8F. outro dono (mesmo seller_id/shop_id) nunca aparece no resultado", async () => {
    const ids = (await listar()).map((l) => l.id).sort().join();
    assert(ids === [ML_A, ML_B, SH_A].sort().join(), ids);
  });
  t("8G. elegibilidade = classificador OFICIAL (mesma saida, linha a linha)", async () => {
    const linhas = mundoCap().lojas.filter((l) => l.user_id === RD);
    for (const l of await listar()) {
      const esperado = C.classificarElegibilidadeSyncCanonico(linhas.find((x) => x.id === l.id) as any, AGORA);
      assert(JSON.stringify(l.elegibilidade) === JSON.stringify(esperado), `${l.id}: ${JSON.stringify(l.elegibilidade)} != ${JSON.stringify(esperado)}`);
    }
  });
  t("8H. guarda de minimizacao: filtro user_id NO BANCO (nao 'listar tudo e filtrar em memoria'); bloco D13 valido", () => {
    const b = X.blocoD13Credenciais(RAIZ);
    assert(b.presente && b.valido, b.motivo);
    const corpo = semComentarios(fonte("lib/marketplace/credenciais.ts")).split("export async function listarLojasDoDonoParaVendasCanonicas(")[1].split("\n}\n")[0];
    assert(/\.from\("lojas"\)\s*\.select\([^)]*\)\s*\.eq\("user_id", String\(userId\)\)/.test(corpo), "sem .eq(user_id) no datasource");
    assert(!/\.filter\(|l\.user_id|\.range\(/.test(corpo), "filtro em memoria / listagem global");
  });

  await fila;
  console.log(`\n${falhou === 0 ? "✓" : "✗"} VENDAS-CANONICO-SERVICE — ${passou} passaram, ${falhou} falharam`);
  process.exit(falhou === 0 ? 0 : 1);
}
principal().catch((e) => { console.error("ERRO FATAL", e); process.exit(1); });
