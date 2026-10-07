/**
 * SALES-SYNC-D15E — intraday ponta a ponta + revisao de CAPACIDADE (offline).
 *
 * Usa o codigo REAL: tick do coordenador (planner D15B), worker (dispatch
 * D15C/D15D), motores intraday ML/Shopee, motores normais, repositorios reais
 * e o servico D14 — sobre um banco em memoria indexado, provedores falsos e
 * um relogio falso. Nenhum segundo algoritmo de planner. Nada de runtime muda.
 *
 * Duas medidas SEPARADAS (nenhuma latencia real e conhecida):
 *   carga de CHAMADAS  — list/detail/escrow (Shopee), paginas (ML);
 *   carga de FATIAS    — oportunidades do worker (1/min, orcamento 45 s).
 * Latencia por chamada e um PARAMETRO DE SENSIBILIDADE (0 / 250 / 1000 ms),
 * nunca um fato; concorrencia interna do motor nao e modelada (cada chamada
 * soma a latencia inteira → limite superior).
 *
 * Uso:  npx tsx scripts/testar-intraday-e2e-capacidade.ts            (correcao + matriz curta)
 *       SIM_COMPLETO=1 npx tsx scripts/testar-intraday-e2e-capacidade.ts   (matriz completa do relatorio)
 */
import "./_server-only-inerte";

let passou = 0, falhou = 0;
// Cada teste roda ATE O FIM antes do proximo codigo: as simulacoes compartilham UM relogio falso.
let fila: Promise<void> = Promise.resolve();
async function t(nome: string, fn: () => void | Promise<void>) {
  try { await fn(); passou++; console.log(`  PASS  ${nome}`); }
  catch (e: any) { falhou++; console.log(`  FALHA ${nome} -> ${e?.message ?? e}`); }
}
function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
let fetches = 0;
(globalThis as any).fetch = async () => { fetches++; throw new Error("REDE_PROIBIDA"); };
const COMPLETO = process.env.SIM_COMPLETO === "1";

// ═════════════════════ banco em memoria INDEXADO ═════════════════════
type Linha = Record<string, any>;
let seq = 0;
class Banco {
  tabs = new Map<string, Linha[]>();
  porLoja = new Map<string, Map<string, Linha[]>>();
  porChave = new Map<string, Map<string, Linha>>();
  tab(t: string) { let a = this.tabs.get(t); if (!a) { a = []; this.tabs.set(t, a); } return a; }
  add(t: string, r: Linha) {
    this.tab(t).push(r);
    if (r.loja_id !== undefined) { let m = this.porLoja.get(t); if (!m) { m = new Map(); this.porLoja.set(t, m); } const k = String(r.loja_id); (m.get(k) ?? m.set(k, []).get(k)!).push(r); }
    for (const [ch, mapa] of this.porChave) { const [tt, cols] = ch.split("§"); if (tt === t) mapa.set(cols.split(",").map((c) => String(r[c])).join("|"), r); }
  }
  chave(t: string, cols: string[]) {
    const ch = `${t}§${cols.join(",")}`; let m = this.porChave.get(ch);
    if (!m) { m = new Map(); for (const r of this.tab(t)) m.set(cols.map((c) => String(r[c])).join("|"), r); this.porChave.set(ch, m); }
    return m;
  }
  cliente(): any {
    const db = this;
    const cmp = (x: any, v: any, f: (a: any, b: any) => boolean) => x !== null && x !== undefined && f(x, v);
    const valor = (l: Linha, col: string) => (col.includes("->>") ? l[col.split("->>")[0]]?.[col.split("->>")[1]] : l[col]);
    return {
      from(tabela: string) {
        const filtros: [string, string, any][] = []; let op: "select" | "update" | "insert" | "upsert" = "select"; let carga: any = null; let conflito: string[] = [];
        let head = false, limite = Infinity, unico: "single" | "maybe" | null = null; const ordens: { col: string; asc: boolean; nf: boolean }[] = [];
        const casa = (l: Linha) => filtros.every(([o, c, v]) => {
          const x = valor(l, c);
          if (o === "eq") return String(x) === String(v);
          if (o === "in") return (v as Set<string>).has(String(x));
          if (o === "gte") return cmp(x, v, (a, b) => a >= b);
          if (o === "gt") return cmp(x, v, (a, b) => a > b);
          if (o === "lt") return cmp(x, v, (a, b) => a < b);
          if (o === "is") return (x ?? null) === v;
          if (o === "not") { const [oo, vv] = v; if (oo === "is") return (x ?? null) !== vv; if (oo === "in") return !String(vv).replace(/[()]/g, "").split(",").includes(String(x)); return true; }
          return true;
        });
        const base = () => { const fl = filtros.find(([o, c]) => o === "eq" && c === "loja_id"); return fl ? (db.porLoja.get(tabela)?.get(String(fl[2])) ?? []) : db.tab(tabela); };
        const executar = (): any => {
          if (op === "insert") {
            const r = { ...carga };
            if (tabela === "sync_jobs" && ["pendente", "rodando"].includes(r.status) && (db.porLoja.get("sync_jobs")?.get(r.loja_id) ?? []).some((j) => ["pendente", "rodando"].includes(j.status))) return { data: null, error: { code: "23505", message: "idx_sync_jobs_loja_ativo" } };
            r.id = r.id ?? `job-${++seq}`; r.criado_em = r.criado_em ?? new Date(relogioGlobal.t).toISOString(); r.tentativas ??= 0; r.max_tentativas ??= 3;
            db.add(tabela, r); return { data: unico ? { id: r.id } : [{ id: r.id }], error: null };
          }
          if (op === "upsert") {
            const m = db.chave(tabela, conflito);
            for (const r of carga as Linha[]) { const k = conflito.map((c) => String(r[c])).join("|"); const ex = m.get(k); if (ex) Object.assign(ex, r); else db.add(tabela, { ...r }); }
            return { data: null, error: null };
          }
          let linhas = base().filter(casa);
          if (op === "update") { for (const l of linhas) Object.assign(l, carga); return { data: linhas.map((l) => ({ id: l.id })), error: null }; }
          if (head) return { data: null, count: linhas.length, error: null };
          if (ordens.length) linhas = [...linhas].sort((a, b) => { for (const o of ordens) { const x = a[o.col] ?? null, y = b[o.col] ?? null; if (x === y) continue; if (x === null) return o.nf ? -1 : 1; if (y === null) return o.nf ? 1 : -1; const c = String(x) < String(y) ? -1 : 1; return o.asc ? c : -c; } return 0; });
          const vis = linhas.slice(0, limite).map((l) => (tabela === "sync_jobs" ? { ...l, modo: l.checkpoint?.modo } : l));
          if (unico === "single") return vis.length === 1 ? { data: vis[0], error: null } : { data: null, error: { message: "nao_unico" } };
          if (unico === "maybe") return { data: vis[0] ?? null, error: null };
          return { data: vis, error: null };
        };
        const c: any = new Proxy({}, { get(_a, p: string) {
          if (p === "then") return (ok: any, ko: any) => Promise.resolve(executar()).then(ok, ko);
          if (p === "range") return (a: number, b: number) => { const r = executar(); return Promise.resolve({ ...r, data: (r.data ?? []).slice(a, b + 1) }); };
          if (p === "select") return (_c?: string, o?: { head?: boolean }) => { if (o?.head) head = true; return c; };
          if (p === "insert") return (r: Linha) => { op = "insert"; carga = r; return c; };
          if (p === "update") return (r: Linha) => { op = "update"; carga = r; return c; };
          if (p === "upsert") return (r: Linha[], o?: { onConflict?: string }) => { op = "upsert"; carga = r; conflito = (o?.onConflict ?? "id").split(","); return c; };
          if (p === "single") return () => { unico = "single"; return c; };
          if (p === "maybeSingle") return () => { unico = "maybe"; return c; };
          if (p === "limit") return (n: number) => { limite = n; return c; };
          if (p === "order") return (col: string, o?: { ascending?: boolean; nullsFirst?: boolean }) => { ordens.push({ col, asc: o?.ascending !== false, nf: o?.nullsFirst === true }); return c; };
          if (p === "not") return (col: string, o: string, v: any) => { filtros.push(["not", col, [o, v]]); return c; };
          if (p === "in") return (col: string, v: any[]) => { filtros.push(["in", col, new Set(v.map(String))]); return c; };
          if (["eq", "gte", "gt", "lt", "is"].includes(p)) return (col: string, v: any) => { filtros.push([p, col, v]); return c; };
          return () => c;
        } });
        return c;
      },
    };
  }
}

// ═════════════════════ relogio e provedores falsos ═════════════════════
const relogioGlobal = { t: 0 };
const DIA_MS = 24 * 3600 * 1000;
const H = (hhmm: string, dia = "2026-10-07") => { const [h, m] = hhmm.split(":").map(Number); return Date.parse(`${dia}T03:00:00.000Z`) + (h * 60 + m) * 60000; };
const ISO = (ms: number) => new Date(ms).toISOString();
const DIA0 = H("00:00");

interface Cont { list: number; detail: number; escrow: number; paginasML: number }
interface PedML { id: string; closed: number; total: number; qtd: number; cancel: string | null; indexadoEm: number }
interface PedSH { sn: string; create: number; update: number; pay: number | null; status: string; preco: number; vV: number; indexadoEm: number }
interface Loja { id: string; dono: string; mp: "ML" | "Shopee"; ml: PedML[]; sh: Map<string, PedSH>; cont: Cont }

class Mundo {
  db = new Banco(); lojas: Loja[] = []; latenciaMs = 0;
  falhas = { shDetalhe: new Set<string>(), shEscrow: new Set<string>(), shRateLimit: 0, mlIncompleto: new Set<string>(), authTransitorio: new Set<string>() };
  loja(id: string, dono: string, mp: "ML" | "Shopee") {
    const l: Loja = { id, dono, mp, ml: [], sh: new Map(), cont: { list: 0, detail: 0, escrow: 0, paginasML: 0 } };
    this.lojas.push(l);
    this.db.add("lojas", { id, user_id: dono, marketplace: mp, ativo: true, seller_id: "777", partner_id: mp === "Shopee" ? 9 : null, partner_key: mp === "Shopee" ? "pk" : null,
      access_token: "tk", refresh_token: "rt", token_expires_at: "2030-01-01T00:00:00Z", nickname: null, nome: null, created_at: "2026-01-01T00:00:00Z" });
    // cobertura FECHADA ate hoje 00:00 (fechamentos anteriores ja concluidos)
    this.db.add("sync_jobs", { id: `seed-${id}`, user_id: dono, loja_id: id, marketplace: mp, tipo: "backfill", status: "concluido", listagem_completa: true,
      campo_tempo: mp === "ML" ? "date_closed" : "create_time", janela_inicio: "2025-12-01T03:00:00.000Z", janela_fim: ISO(DIA0),
      date_from: "2025-12-01", date_to: "2026-10-06", concluido_em: ISO(DIA0), criado_em: ISO(DIA0), checkpoint: null, iniciado_em: ISO(DIA0) });
    return l;
  }
  private passo(l: Loja, n = 1) { relogioGlobal.t += n * this.latenciaMs; }
  transporteML(diaEmSP: (iso: string) => string | null) {
    return {
      listarDiaFechado: async ({ lojaId, dia }: { userId: string; lojaId: string; dia: string }) => {
        const l = this.lojas.find((x) => x.id === lojaId)!; const agora = relogioGlobal.t;
        const vis = l.ml.filter((o) => o.indexadoEm <= agora && diaEmSP(ISO(o.closed)) === dia);
        // MESMA matematica do motor real: 51 por pagina, teto de 60 paginas por dia (lib/mercado-livre-vendas.ts)
        const paginas = Math.max(1, Math.ceil(vis.length / 51)); const efetivas = Math.min(paginas, 60);
        l.cont.paginasML += efetivas; this.passo(l, efetivas);
        if (paginas > 60) return { brutos: [], paginas: 60, completa: false, erro: null };
        if (this.falhas.mlIncompleto.has(lojaId)) return { brutos: [], paginas: efetivas, completa: false, erro: null };
        return { brutos: vis.map((o) => ({ id: o.id, date_closed: ISO(o.closed), total_amount: o.total, order_items: [{ quantity: o.qtd, unit_price: o.total / o.qtd }], status: "paid", cancel_detail: o.cancel ? { code: o.cancel } : null })),
          paginas: efetivas, completa: true, erro: null };
      },
    };
  }
  apiShopee(lojaId: string, ErroShopee: any) {
    const l = this.lojas.find((x) => x.id === lojaId)!;
    return {
      listarPagina: async ({ de, ate, cursor, tamanhoPagina }: any) => {
        l.cont.list++; this.passo(l);
        if (this.falhas.shRateLimit > 0) { this.falhas.shRateLimit--; throw new ErroShopee("rate_limit", "too_many_requests"); }
        const agora = relogioGlobal.t;
        const todos = [...l.sh.values()].filter((p) => p.indexadoEm <= agora && p.create >= de && p.create <= ate).map((p) => p.sn).sort();
        const ini = cursor ? Number(cursor) : 0; const pag = todos.slice(ini, ini + tamanhoPagina); const mais = ini + tamanhoPagina < todos.length;
        return { pedidos: pag.map((orderSn) => ({ orderSn })), mais, proximoCursor: mais ? String(ini + tamanhoPagina) : null };
      },
      detalhes: async (sns: string[]) => {
        l.cont.detail++; this.passo(l);
        return sns.map((sn) => l.sh.get(sn)).filter((p): p is PedSH => !!p && !this.falhas.shDetalhe.has(p.sn)).map((p) => ({
          orderSn: p.sn, status: p.status, createTime: p.create / 1000, updateTime: p.update / 1000, payTime: p.pay === null ? null : p.pay / 1000,
          cancelBy: null, cancelReason: null, totalAmount: p.preco, itens: [{ itemId: `i-${p.sn}`, modelId: null, nome: null, sku: null, precoDescontado: p.preco, precoOriginal: p.preco, quantidade: 1 }] }));
      },
      escrow: async (sn: string) => {
        l.cont.escrow++; this.passo(l);
        if (this.falhas.shEscrow.has(sn)) throw new ErroShopee("permanente", "escrow_indisponivel");
        const p = l.sh.get(sn)!;
        return { orderSn: sn, originalShopeeDiscount: 0, pixDiscount: 0, itens: [{ itemId: `i-${sn}`, modelId: null, voucherVendedor: p.vV, voucherShopee: 0, moedas: 0 }] };
      },
    };
  }
}

/** Distribuicao SINTETICA declarada (nao e fato): pedidos uniformes entre 08:00 e 23:00, pagos 5 min depois. */
function gerarDia(l: Loja, n: number, semente: number, dia = "2026-10-07", indexacao = 0) {
  let x = semente; const rnd = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
  for (let i = 0; i < n; i++) {
    const t0 = H("08:00", dia) + Math.floor(rnd() * 15 * 3600) * 1000;
    if (l.mp === "ML") l.ml.push({ id: `${l.id.slice(-4)}-${dia}-${i}`, closed: t0, total: 10 + (i % 7), qtd: 1, cancel: null, indexadoEm: t0 + indexacao });
    else { const sn = `${l.id.slice(-4)}${dia.slice(5).replace("-", "")}${String(i).padStart(5, "0")}`; l.sh.set(sn, { sn, create: t0, update: t0 + 300_000, pay: t0 + 300_000, status: "READY_TO_SHIP", preco: 10 + (i % 7), vV: 0, indexadoEm: t0 + indexacao }); }
  }
}
/** Pool de NAO PAGOS na janela de 10 dias — parametro de sensibilidade, nao realidade. */
function poolNaoPagos(m: Mundo, l: Loja, u: number) {
  for (let i = 0; i < u; i++) {
    const c = DIA0 - (1 + (i % 9)) * DIA_MS + (i % 1000) * 1000; const sn = `U${l.id.slice(-4)}${String(i).padStart(6, "0")}`;
    l.sh.set(sn, { sn, create: c, update: c, pay: null, status: "UNPAID", preco: 1, vV: 0, indexadoEm: c });
    m.db.add("shopee_pedidos", { user_id: l.dono, loja_id: l.id, order_sn: sn, order_status: "UNPAID", create_time: ISO(c), update_time: ISO(c), pay_time: null,
      detail_fetched_at: ISO(c), escrow_fetched_at: null, escrow_update_time: null, original_shopee_discount: null, pix_discount: null, total_amount: 1 });
  }
}

async function principal() {
  const T = await import("../lib/vendas/sync/coordenador-tick");
  const W = await import("../lib/vendas/sync/worker");
  const RML = await import("../lib/mercado-livre/ingestao/persistencia");
  const RSH = await import("../lib/shopee/ingestao/persistencia");
  const V = await import("../lib/vendas/canonico/service");
  const I = await import("../lib/vendas/sync/intraday");
  const { diaEmSaoPaulo } = await import("../lib/fuso-sao-paulo");
  const { ErroShopee } = await import("../lib/shopee/ingestao/tipos");
  const { RETRY_PADRAO } = await import("../lib/shopee/ingestao/retry");
  (RETRY_PADRAO as any).dormir = async () => {};   // o relogio e falso: o backoff nao espera de verdade (o motor e o mesmo)
  // Os repositorios carimbam concluido_em/heartbeat_em com o relogio do SISTEMA (new Date()), nao com o
  // relogio injetado — em producao os dois sao o mesmo. No simulador o Date global segue o relogio falso.
  const DataReal = Date;
  class DataSimulada extends DataReal {
    constructor(...a: any[]) { if (a.length === 0) super(relogioGlobal.t); else super(...(a as [any])); }
    static now() { return relogioGlobal.t; }
  }
  (globalThis as any).Date = DataSimulada;

  interface Slice { min: number; job?: string; loja?: string; resultado: string; fatia?: string; motivo?: string; intraday: boolean; cont: Cont }
  /** Roda o pipeline REAL minuto a minuto: tick a cada 15 min, worker a cada 1 min. */
  async function rodar(m: Mundo, de: number, ate: number, o: { intradayDesde?: number | null; aoMinuto?: (min: number) => Promise<void> | void } = {}) {
    const slices: Slice[] = []; const cliente = m.db.cliente();
    const ligado = (t: number) => o.intradayDesde !== null && t >= (o.intradayDesde ?? de);
    const relogio = { agoraMs: () => relogioGlobal.t };
    for (let min = de; min < ate; min += 60_000) {
      relogioGlobal.t = min;
      if (o.aoMinuto) await o.aoMinuto(min);
      if (((min - DIA0) / 60_000) % 15 === 0) {
        relogioGlobal.t = min;
        await T.executarTickCoordenador(() => ({ cliente, relogio, log: () => {}, intraday: ligado(min) }), { orcamentoMs: 60_000, habilitado: true });
      }
      relogioGlobal.t = min;
      const antes = new Map(m.lojas.map((l) => [l.id, { ...l.cont }]));
      const r = await W.executarWorkerCanonico({ cliente, relogio,
        portasML: async () => ({ transporte: m.transporteML((iso) => diaEmSaoPaulo(iso)) as any, repo: RML.criarRepositorioML(cliente) }),
        portasShopee: async (job: any) => (m.falhas.authTransitorio.delete(job.lojaId) ? { transitorio: "refresh_em_andamento" as const } : { api: m.apiShopee(job.lojaId, ErroShopee) as any, repo: RSH.criarRepositorioSupabase(cliente) }) },
        { orcamentoMs: 45_000, habilitado: true, intraday: ligado(min) });
      if (r.resultado === "NO_JOB") continue;
      const j = r.job_id ? m.db.tab("sync_jobs").find((x) => x.id === r.job_id) : undefined;
      const l = m.lojas.find((x) => x.id === r.loja_id);
      const d = l ? antes.get(l.id)! : { list: 0, detail: 0, escrow: 0, paginasML: 0 };
      slices.push({ min, job: r.job_id, loja: r.loja_id, resultado: r.resultado, fatia: r.fatia, motivo: r.motivo, intraday: j ? I.ehJobIntraday({ tipo: j.tipo, campoTempo: j.campo_tempo, janelaInicio: j.janela_inicio, janelaFim: j.janela_fim, dateFrom: j.date_from, dateTo: j.date_to }) : false,
        cont: l ? { list: l.cont.list - d.list, detail: l.cont.detail - d.detail, escrow: l.cont.escrow - d.escrow, paginasML: l.cont.paginasML - d.paginasML } : d });
    }
    return slices;
  }
  const intradayJobs = (m: Mundo, lojaId?: string) => m.db.tab("sync_jobs").filter((j) => j.tipo === "incremental" && j.janela_inicio && (!lojaId || j.loja_id === lojaId));
  /** Watermark de uma loja = maior T de intraday CONCLUIDO do dia (a cadeia que o D14 le). */
  const watermark = (m: Mundo, lojaId: string, dia = "2026-10-07") => Math.max(-Infinity, ...intradayJobs(m, lojaId).filter((j) => j.status === "concluido" && j.date_from === dia).map((j) => Date.parse(j.janela_fim)));
  const hoje = (m: Mundo, dono: string, agoraMs: number, marketplace = "todos", lojaId?: string, preset = "HOJE") =>
    V.consultarVendasCanonicas({ userId: dono, marketplace: marketplace as any, preset: preset as any, ...(lojaId ? { lojaId } : {}) }, { cliente: m.db.cliente(), agoraMs });
  /** Oraculo de teste (NAO e a formula de producao): o que o provedor expunha ate T. */
  const oraculoSH = (l: Loja, alvo: number, vistoAte: number) => { let vendas = 0, pedidos = 0, cancelados = 0;
    for (const p of l.sh.values()) if (p.pay !== null && p.pay < alvo && p.indexadoEm <= vistoAte) { pedidos++; vendas += p.preco - p.vV; if (p.status === "CANCELLED") cancelados++; }
    return { pedidos, vendas: Math.round(vendas * 100) / 100, cancelados }; };
  const oraculoML = (l: Loja, alvo: number, vistoAte: number) => { let vendas = 0, pedidos = 0;
    for (const o of l.ml) if (o.closed >= DIA0 && o.closed < alvo && o.indexadoEm <= vistoAte && o.cancel !== "pack_splitted") { pedidos++; vendas += o.total; }
    return { pedidos, vendas: Math.round(vendas * 100) / 100 }; };

  // ═════════════════════ 1. CORRECAO PONTA A PONTA ═════════════════════
  console.log("\n[1. correcao ponta a ponta — dia inteiro, pipeline real]");
  const LJ = { ML1: "aaaaaaaa-0000-4000-8000-0000000e0001", SH1: "aaaaaaaa-0000-4000-8000-0000000e0002", SH2: "aaaaaaaa-0000-4000-8000-0000000e0003", SHB: "bbbbbbbb-0000-4000-8000-0000000e0002" };
  const e2e = new Mundo();
  const ml1 = e2e.loja(LJ.ML1, "dono-a", "ML"), sh1 = e2e.loja(LJ.SH1, "dono-a", "Shopee"), sh2 = e2e.loja(LJ.SH2, "dono-a", "Shopee"), shb = e2e.loja(LJ.SHB, "dono-b", "Shopee");
  gerarDia(ml1, 120, 11); gerarDia(sh1, 150, 22); gerarDia(sh2, 60, 33); gerarDia(shb, 80, 44);
  // eventos do dia (deterministicos)
  ml1.ml.push({ id: "ML-ATRASADO", closed: H("10:05"), total: 77, qtd: 1, cancel: null, indexadoEm: H("11:20") });                   // ML indexado atrasado
  sh1.sh.set("SH-ATRASADO", { sn: "SH-ATRASADO", create: H("10:05"), update: H("10:10"), pay: H("10:10"), status: "READY_TO_SHIP", preco: 55, vV: 0, indexadoEm: H("11:20") });
  sh1.sh.set("ONTEM-PAGO-HOJE", { sn: "ONTEM-PAGO-HOJE", create: H("23:00", "2026-10-06"), update: H("23:00", "2026-10-06"), pay: null, status: "UNPAID", preco: 40, vV: 0, indexadoEm: H("23:00", "2026-10-06") });
  e2e.db.add("shopee_pedidos", { user_id: "dono-a", loja_id: LJ.SH1, order_sn: "ONTEM-PAGO-HOJE", order_status: "UNPAID", create_time: ISO(H("23:00", "2026-10-06")), update_time: ISO(H("23:00", "2026-10-06")),
    pay_time: null, detail_fetched_at: ISO(H("23:30", "2026-10-06")), escrow_fetched_at: null, escrow_update_time: null, original_shopee_discount: null, pix_discount: null, total_amount: 40 });
  const checagens: { min: number; loja: string; ok: boolean; msg: string }[] = []; const vistos = new Set<string>();
  let e5: { observadoAte: string | null; wms: number[]; lojas: string[] } | null = null;
  const e2eSlices = await rodar(e2e, DIA0, H("02:00", "2026-10-08"), { aoMinuto: async (min) => {
    if (min === H("10:00")) { const p = sh1.sh.get("ONTEM-PAGO-HOJE")!; p.pay = H("10:00"); p.update = H("10:00"); p.status = "READY_TO_SHIP"; }     // nao pago → pago hoje
    if (min === H("12:00")) { const p = [...sh1.sh.values()].find((x) => x.pay !== null && x.pay < H("11:00") && x.sn !== "SH-ATRASADO")!; p.status = "CANCELLED"; p.update = H("12:00"); } // cancelado apos pagamento
    if (min === H("13:00")) { const p = [...sh1.sh.values()].filter((x) => x.pay !== null && x.pay < H("12:00") && x.status !== "CANCELLED")[0]; p.vV = 3; p.update = H("13:00"); }   // escrow mudou
    if (min === H("14:00")) e2e.falhas.shDetalhe.add([...sh1.sh.values()].filter((x) => x.pay !== null && x.pay < H("13:30"))[1].sn);           // observacao falha (detail)
    if (min === H("15:30")) e2e.falhas.shDetalhe.clear();                                                                                        // recuperacao
    if (min === H("16:00")) e2e.falhas.mlIncompleto.add(LJ.ML1);                                                                                   // ML incompleto (3x → erro)
    if (min === H("17:30")) e2e.falhas.mlIncompleto.clear();
    if (min === H("18:00")) { e2e.falhas.shRateLimit = 1; e2e.falhas.authTransitorio.add(LJ.SH2); }                                              // 429 + auth em renovacao (ADIADO)
    if (min === H("19:05")) { const v = await hoje(e2e, "dono-a", min, "todos"); e5 = { observadoAte: v.observadoAte, wms: [LJ.ML1, LJ.SH1, LJ.SH2].map((id) => watermark(e2e, id)), lojas: v.cobertura.lojas.map((l) => l.lojaId) }; }
    // depois de cada intraday concluido, o D14 HOJE da loja precisa refletir EXATAMENTE o ultimo prefixo comprovado
    for (const j of intradayJobs(e2e)) {
      if (j.status !== "concluido" || vistos.has(j.id) || j.date_from !== "2026-10-07") continue;
      vistos.add(j.id); const l = e2e.lojas.find((x) => x.id === j.loja_id)!;
      const wm = watermark(e2e, l.id); if (Date.parse(j.janela_fim) !== wm) continue;
      const v = await hoje(e2e, l.dono, min, l.mp === "ML" ? "mercado_livre" : "shopee", l.id);
      const vistoAte = Date.parse(j.concluido_em);
      const esp = l.mp === "ML" ? oraculoML(l, wm, vistoAte) : oraculoSH(l, wm, vistoAte);
      const got = l.mp === "ML" ? v.metricas.mercadoLivre : v.metricas.shopee;
      const ok = v.observadoAte === ISO(wm) && !!got && got.pedidos === esp.pedidos && got.vendas === esp.vendas && (l.mp === "ML" || (got as any).cancelados === (esp as any).cancelados);
      checagens.push({ min, loja: l.id, ok, msg: `${l.mp} T=${ISO(wm).slice(11, 16)} ${v.estado} obs=${v.observadoAte?.slice(11, 16)} got=${JSON.stringify(got)} esp=${JSON.stringify(esp)}` });
    }
  } });
  await t("E1. a cada intraday concluido, D14 HOJE = oraculo do prefixo comprovado (ML e Shopee, o dia todo)", () => {
    const ruins = checagens.filter((c) => !c.ok);
    assert(checagens.length >= 40 && ruins.length === 0, `${checagens.length} checagens; ruins: ${ruins.slice(0, 3).map((c) => c.msg).join(" | ")}`);
  });
  await t("E2. indexacao atrasada recuperada (ML e Shopee) sem lookback arbitrario", async () => {
    const v = await hoje(e2e, "dono-a", H("23:59"), "todos");
    assert(e2e.db.tab("ml_pedidos").some((p) => p.order_id === "ML-ATRASADO") && e2e.db.tab("shopee_pedidos").some((p) => p.order_sn === "SH-ATRASADO" && p.pay_time), "atrasado perdido");
    assert(v.metricas.combinadas !== null, v.estado);
  });
  await t("E3. criado ontem e pago hoje entra em Hoje; cancelado apos pagamento fica nas vendas e conta em cancelados", async () => {
    const v = await hoje(e2e, "dono-a", H("23:59"), "shopee", LJ.SH1);
    const p = e2e.db.tab("shopee_pedidos").find((x) => x.order_sn === "ONTEM-PAGO-HOJE")!;
    assert(p.pay_time === ISO(H("10:00")) && v.metricas.shopee!.cancelados >= 1, `${p.pay_time} ${JSON.stringify(v.metricas.shopee)}`);
  });
  await t("E4. falhas (detail, ML incompleto) nunca avancam o watermark; 429 e ADIADO nao perdem checkpoint nem duplicam job", () => {
    const erros = intradayJobs(e2e).filter((j) => j.status === "erro");
    assert(erros.length >= 2 && erros.every((j) => j.listagem_completa !== true || j.marketplace === "Shopee"), `erros=${erros.length}`);
    for (const j of erros) assert(watermark(e2e, j.loja_id) !== Date.parse(j.janela_fim) || intradayJobs(e2e, j.loja_id).some((k) => k.status === "concluido" && k.janela_fim === j.janela_fim), `watermark avancou num job em erro ${j.id}`);
    assert(e2eSlices.some((s) => s.resultado === "ADIADO"), "sem ADIADO");
    const porLoja = new Map<string, number>(); for (const j of e2e.db.tab("sync_jobs")) if (["pendente", "rodando"].includes(j.status)) porLoja.set(j.loja_id, (porLoja.get(j.loja_id) ?? 0) + 1);
    assert([...porLoja.values()].every((n) => n <= 1), "mais de um job ativo por loja");
  });
  await t("E5. 'todos' do dono A = menor watermark comum (ML vs Shopee); dono B nunca entra", async () => {
    assert(e5 !== null && e5.wms.every(Number.isFinite), "captura das 19:05 ausente");
    assert(e5!.observadoAte === ISO(Math.min(...e5!.wms)), `${e5!.observadoAte} vs ${ISO(Math.min(...e5!.wms))} (${e5!.wms.map((w) => ISO(w).slice(11, 16))})`);
    assert(e5!.lojas.every((id) => id !== LJ.SHB), "dono B no agregado");
  });
  await t("E6. meia-noite: o fechamento normal de 07/10 roda depois de 00:00 e o dia vira COMPLETE (intraday nao fecha dia)", async () => {
    const fech = e2e.db.tab("sync_jobs").filter((j) => j.tipo === "backfill" && j.status === "concluido" && Date.parse(j.criado_em) >= H("00:00", "2026-10-08"));
    const v = await hoje(e2e, "dono-a", H("02:00", "2026-10-08"), "todos", undefined, "ONTEM");
    assert(fech.length >= 3, `fechamentos pos-meia-noite: ${fech.length}`);
    console.log(`        fechamento de 07/10: ${fech.map((j) => `${j.marketplace}@${String(j.concluido_em).slice(11, 16)}`).join(" ")}; ONTEM = ${v.estado}`);
  });
  await t("E7. zero vendas observado ≠ nao observado (loja sem pedidos)", async () => {
    const z = new Mundo(); const lz = z.loja("cccccccc-0000-4000-8000-0000000e0009", "dono-z", "Shopee");
    await rodar(z, DIA0, H("01:00"));
    const v = await hoje(z, "dono-z", H("01:00"), "shopee", lz.id);
    const z2 = new Mundo(); const lz2 = z2.loja("cccccccc-0000-4000-8000-0000000e0010", "dono-z", "Shopee");
    const n = await hoje(z2, "dono-z", H("01:00"), "shopee", lz2.id);
    assert(v.metricas.shopee?.vendas === 0 && v.metricas.semVendas === true && n.metricas.shopee === null && n.metricas.semVendas === null, `${v.estado} / ${n.estado}`);
  });

  // ═════════════════════ 2. CAPACIDADE ═════════════════════
  console.log("\n[2. capacidade — modelo de chamadas e de fatias (latencia real DESCONHECIDA)]");
  interface Cenario { nome: string; ml: number[]; sh: { n: number; u: number }[]; latenciaMs: number; churn?: number; desde?: number; backlogDias?: number; ate?: number }
  async function capacidade(c: Cenario) {
    const m = new Mundo(); m.latenciaMs = c.latenciaMs;
    c.ml.forEach((n, i) => gerarDia(m.loja(`ml000000-0000-4000-8000-${String(i).padStart(12, "0")}`, `dono-${i % 3}`, "ML"), n, 100 + i));
    c.sh.forEach((s, i) => { const l = m.loja(`sh000000-0000-4000-8000-${String(i).padStart(12, "0")}`, `dono-${i % 3}`, "Shopee"); gerarDia(l, s.n, 200 + i); poolNaoPagos(m, l, s.u); });
    if (c.backlogDias) { const seed = m.db.tab("sync_jobs").find((j) => j.id === `seed-${m.lojas[0].id}`)!; seed.janela_inicio = ISO(DIA0 - c.backlogDias * DIA_MS); seed.date_from = ISO(DIA0 - c.backlogDias * DIA_MS).slice(0, 10); }
    let rnd = 7; const churn = (min: number) => { if (!c.churn || ((min - DIA0) / 60_000) % 30 !== 0) return;
      for (const l of m.lojas) for (const p of l.sh.values()) { rnd = (rnd * 1103515245 + 12345) % 2147483648; if (p.pay !== null && p.pay < min && rnd / 2147483648 < c.churn) p.update = min; } };
    const fim = c.ate ?? H("00:00", "2026-10-08");
    const sl = await rodar(m, DIA0, fim, { intradayDesde: c.desde ?? DIA0, aoMinuto: churn });
    // metricas
    const horas = (fim - DIA0) / 3_600_000;
    const ij = intradayJobs(m).filter((j) => j.date_from === "2026-10-07");
    const conc = ij.filter((j) => j.status === "concluido");
    const sliceDe = (id: string) => sl.filter((s) => s.job === id);
    const custos = conc.map((j) => ({ j, s: sliceDe(j.id), cont: sliceDe(j.id).reduce((a, s) => ({ list: a.list + s.cont.list, detail: a.detail + s.cont.detail, escrow: a.escrow + s.cont.escrow, paginasML: a.paginasML + s.cont.paginasML }), { list: 0, detail: 0, escrow: 0, paginasML: 0 }) }));
    let maxIdade = 0, maxFila = 0; const primeiro = new Map<string, number>();
    for (let min = (c.desde ?? DIA0) + 60_000; min < fim; min += 60_000) {
      const ativos = m.db.tab("sync_jobs").filter((j) => Date.parse(j.criado_em) <= min && (j.status !== "concluido" && j.status !== "erro" || Date.parse(j.concluido_em ?? ISO(fim)) > min) && Date.parse(j.criado_em) <= min);
      maxFila = Math.max(maxFila, new Set(ativos.map((j) => j.loja_id)).size);
      for (const l of m.lojas) {
        const wms = conc.filter((j) => j.loja_id === l.id && Date.parse(j.concluido_em) <= min).map((j) => Date.parse(j.janela_fim));
        if (!wms.length) continue; if (!primeiro.has(l.id)) primeiro.set(l.id, min);
        maxIdade = Math.max(maxIdade, min - Math.max(...wms));
      }
    }
    const executadas = sl.length, intradaySl = sl.filter((s) => s.intraday).length, fundoSl = executadas - intradaySl;
    const fundoConc = m.db.tab("sync_jobs").filter((j) => j.tipo === "backfill" && !j.id.startsWith("seed-") && j.status === "concluido").length;
    const primeiraSH = custos.filter((x) => m.lojas.find((l) => l.id === x.j.loja_id)!.mp === "Shopee").sort((a, b) => Date.parse(a.j.janela_fim) - Date.parse(b.j.janela_fim));
    const shFirst = primeiraSH.find((x) => x.cont.escrow > 0) ?? primeiraSH[0];
    const shSteady = primeiraSH.slice(Math.max(1, primeiraSH.length - 8));
    const media = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
    const r = {
      cenario: c.nome, lojas: `${c.ml.length}ML+${c.sh.length}SH`, latencia: `${c.latenciaMs}ms`,
      slicesH: +(executadas / horas).toFixed(1), utiliz: `${Math.round((executadas / (horas * 60)) * 100)}%`, intradaySl, fundoSl, fundoConc,
      intradayConc: conc.length, intradayErro: ij.filter((j) => j.status === "erro").length, maxSlicesJob: Math.max(0, ...custos.map((x) => x.s.length)),
      maxIdadeMin: Math.round(maxIdade / 60_000), primeiroWmMin: Math.round((Math.max(...[...primeiro.values()], c.desde ?? DIA0) - (c.desde ?? DIA0)) / 60_000), maxFila,
      shPrimeira: shFirst ? `${shFirst.cont.list}/${shFirst.cont.detail}/${shFirst.cont.escrow}` : "-",
      shSteady: shSteady.length ? `${media(shSteady.map((x) => x.cont.list))}/${media(shSteady.map((x) => x.cont.detail))}/${media(shSteady.map((x) => x.cont.escrow))}` : "-",
      mlPagObs: media(custos.filter((x) => m.lojas.find((l) => l.id === x.j.loja_id)!.mp === "ML").map((x) => x.cont.paginasML)),
      chamadasDia: m.lojas.reduce((a, l) => a + l.cont.list + l.cont.detail + l.cont.escrow + l.cont.paginasML, 0),
      ativosMax: Math.max(...m.lojas.map((l) => m.db.tab("sync_jobs").filter((j) => j.loja_id === l.id && ["pendente", "rodando"].includes(j.status)).length)),
    };
    return { r, m, sl, conc };
  }
  const linha = (r: any) => console.log(`        ${r.cenario.padEnd(30)} ${r.lojas.padEnd(9)} lat=${r.latencia.padEnd(6)} slices/h=${String(r.slicesH).padEnd(5)} util=${r.utiliz.padEnd(4)} intraday=${String(r.intradayConc).padEnd(4)}(erro ${r.intradayErro}) fundo=${String(r.fundoConc).padEnd(3)} maxFatias/job=${String(r.maxSlicesJob).padEnd(3)} idadeMax=${String(r.maxIdadeMin).padEnd(4)}min 1oWM=${String(r.primeiroWmMin).padEnd(3)}min fila=${r.maxFila} SH 1a(l/d/e)=${String(r.shPrimeira).padEnd(10)} steady=${String(r.shSteady).padEnd(8)} MLpag/obs=${r.mlPagObs}`);
  const resultados: any[] = [];
  const cenario = async (c: Cenario) => { const x = await capacidade(c); linha(x.r); resultados.push(x.r); return x; };

  const atual = await cenario({ nome: "ATUAL 3ML+1SH (250/dia)", ml: [250, 250, 250], sh: [{ n: 250, u: 50 }], latenciaMs: 0 });
  await t("C1. ATUAL: watermark de toda loja sempre <= 45 min de idade; nenhum job concorrente por loja; fundo continua progredindo", () => {
    assert(atual.r.maxIdadeMin <= 45 && atual.r.ativosMax <= 1 && atual.r.fundoConc > 0, JSON.stringify(atual.r));
  });
  await t("C2. alvo perdido nao vira fila historica: com latencia alta o proximo alvo pula para a grade ATUAL (sem 2 jobs da mesma loja)", async () => {
    const x = await cenario({ nome: "COLD 18:00 SH 1000 lat2000", ml: [], sh: [{ n: 1000, u: 200 }], latenciaMs: 2000, desde: H("18:00"), ate: H("21:00") });
    const ts = x.conc.map((j) => Date.parse(j.janela_fim)).sort((a, b) => a - b);
    const saltos = ts.slice(1).map((v, i) => (v - ts[i]) / 60_000);
    console.log(`        alvos concluidos (cold start 18:00, lat 2000ms, horario SP): ${ts.map((v) => ISO(v - 3 * 3600_000).slice(11, 16)).join(" ")}; maior salto ${Math.max(0, ...saltos)} min; fatias do 1o job ${x.r.maxSlicesJob}`);
    assert(x.r.maxSlicesJob > 15 && x.r.ativosMax <= 1 && saltos.length > 0 && saltos.every((s) => s >= 30 && s % 15 === 0) && Math.max(...saltos) > 30, `saltos ${saltos} fatias ${x.r.maxSlicesJob}`);
  });
  if (COMPLETO) {
    console.log("\n        — escala de lojas (lat 0) —");
    for (const [nome, ml, sh] of [["FUTURO 3ML+2SH", 3, 2], ["8 lojas 4ML+4SH", 4, 4], ["10 lojas 5ML+5SH", 5, 5], ["12 lojas 6ML+6SH", 6, 6]] as const)
      await cenario({ nome, ml: Array(ml).fill(250), sh: Array(sh).fill({ n: 250, u: 50 }), latenciaMs: 0 });
    console.log("\n        — volume Shopee x pool de nao pagos (lat 0, sensibilidade) —");
    for (const n of [250, 500, 1000]) for (const u of [50, 500, 2000]) await cenario({ nome: `SH ${n}/dia pool ${u}`, ml: [], sh: [{ n, u }], latenciaMs: 0 });
    console.log("\n        — churn de escrow entre observacoes (sensibilidade) —");
    for (const ch of [0, 0.05, 0.3]) await cenario({ nome: `SH 500/dia churn ${ch * 100}%`, ml: [], sh: [{ n: 500, u: 200 }], latenciaMs: 0, churn: ch });
    console.log("\n        — volume ML (paginas por observacao; teto 60 x 51) —");
    for (const n of [250, 500, 1000, 2000, 3000, 3100]) await cenario({ nome: `ML ${n}/dia`, ml: [n], sh: [], latenciaMs: 0 });
    console.log("\n        — cold start (intraday ligado tarde) —");
    for (const h of ["09:00", "12:00", "15:00", "18:00"]) await cenario({ nome: `COLD ${h} SH 1000 lat250`, ml: [], sh: [{ n: 1000, u: 200 }], latenciaMs: 250, desde: H(h) });
    console.log("\n        — latencia por chamada (sensibilidade; NAO e medida) —");
    for (const lat of [250, 1000]) {
      await cenario({ nome: `ATUAL lat ${lat}`, ml: [250, 250, 250], sh: [{ n: 250, u: 50 }], latenciaMs: lat });
      await cenario({ nome: `12 lojas 50%SH 500 lat ${lat}`, ml: Array(6).fill(500), sh: Array(6).fill({ n: 500, u: 200 }), latenciaMs: lat });
    }
    console.log("\n        — backlog historico + intraday (interleave) —");
    await cenario({ nome: "BACKLOG 120d loja ML + intraday", ml: [250, 250, 250], sh: [{ n: 250, u: 50 }], latenciaMs: 0, backlogDias: 120 });
  }
  await t("RO. nenhuma rede", () => assert(fetches === 0, `fetch=${fetches}`));

  await fila;
  if (COMPLETO) console.log(`\nRESULTADOS_JSON ${JSON.stringify(resultados)}`);
  console.log(`\n${falhou === 0 ? "✓" : "✗"} INTRADAY-E2E-CAPACIDADE — ${passou} passaram, ${falhou} falharam`);
  process.exit(falhou === 0 ? 0 : 1);
}
principal().catch((e) => { console.error("ERRO FATAL", e); process.exit(1); });
