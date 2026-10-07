/**
 * SALES-SYNC-D15D — motor INTRADAY Shopee (offline, ponta a ponta).
 *
 * API Shopee FALSA → job intraday → worker REAL → executarFatiaShopeeIntraday
 * (motor Shopee existente por baixo) → repositorio Shopee REAL sobre banco em
 * memoria → consultarVendasCanonicas (D14). Data de negocio = pay_time;
 * create_time e so descoberta. Intraday segue DESLIGADO em producao: aqui
 * ligado so pela opcao `intraday: true` do worker.
 *
 * Uso: npx tsx scripts/testar-shopee-intraday.ts
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

// ── banco em memoria (select/insert/update/upsert, filtros, 1 ativo por loja) ──
type Linha = Record<string, any>;
let seq = 0;
function banco(dados: Record<string, Linha[]>) {
  const valor = (l: Linha, col: string) => (col.includes("->>") ? l[col.split("->>")[0]]?.[col.split("->>")[1]] : l[col]);
  const cmp = (x: any, v: any, f: (a: any, b: any) => boolean) => x !== null && x !== undefined && f(x, v);
  return {
    from(tabela: string) {
      const filtros: [string, string, any][] = []; let op: "select" | "update" | "insert" | "upsert" = "select"; let carga: any = null; let conflito: string[] = [];
      let head = false, limite = Infinity, unico: "single" | "maybe" | null = null; let ordem: string | null = null;
      const casa = (l: Linha) => filtros.every(([o, c, v]) => {
        const x = valor(l, c);
        if (o === "eq") return String(x) === String(v);
        if (o === "in") return (v as any[]).map(String).includes(String(x));
        if (o === "gte") return cmp(x, v, (a, b) => a >= b);
        if (o === "gt") return cmp(x, v, (a, b) => a > b);
        if (o === "lt") return cmp(x, v, (a, b) => a < b);
        if (o === "is") return (x ?? null) === v;
        if (o === "not") { const [oo, vv] = v; if (oo === "is") return (x ?? null) !== vv; if (oo === "in") return !String(vv).replace(/[()]/g, "").split(",").includes(String(x)); return true; }
        return true;
      });
      const executar = (): any => {
        const tab = (dados[tabela] ??= []);
        if (op === "insert") {
          const r = { ...carga };
          if (tabela === "sync_jobs" && ["pendente", "rodando"].includes(r.status) && tab.some((j) => j.loja_id === r.loja_id && ["pendente", "rodando"].includes(j.status))) return { data: null, error: { code: "23505", message: "idx" } };
          r.id = r.id ?? `job-${++seq}`; tab.push(r); return { data: unico ? { id: r.id } : [{ id: r.id }], error: null };
        }
        if (op === "upsert") {
          for (const r of carga as Linha[]) { const i = tab.findIndex((x) => conflito.every((k) => String(x[k]) === String(r[k]))); if (i >= 0) tab[i] = { ...tab[i], ...r }; else tab.push({ ...r }); }
          return { data: null, error: null };
        }
        let linhas = tab.filter(casa);
        if (op === "update") { for (const l of linhas) Object.assign(l, carga); return { data: linhas.map((l) => ({ id: l.id })), error: null }; }
        if (head) return { data: null, count: linhas.length, error: null };
        if (ordem) linhas = [...linhas].sort((a, b) => String(a[ordem!]).localeCompare(String(b[ordem!])));
        const vis = linhas.slice(0, limite).map((l) => ({ ...l, modo: l.checkpoint?.modo }));
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
        if (p === "order") return (col: string) => { ordem = col; return c; };
        if (p === "not") return (col: string, o: string, v: any) => { filtros.push(["not", col, [o, v]]); return c; };
        if (["eq", "in", "gte", "gt", "lt", "is"].includes(p)) return (col: string, v: any) => { filtros.push([p, col, v]); return c; };
        return () => c;
      } });
      return c;
    },
  } as any;
}

// ── API Shopee falsa (por loja), com contadores e falhas injetaveis ──
interface ItemF { itemId: string; preco: number; qtd: number; vV?: number; vS?: number }
interface PedF { sn: string; loja: string; create: number; update: number; pay: number | null; status: string; itens: ItemF[]; sub?: number; pix?: number; indexado: boolean; escrowItens?: ItemF[] }
interface Prov { pedidos: Map<string, PedF>; cont: { list: number; detail: number; escrow: number }; listArgs: { loja: string; de: number; ate: number }[]; detalhados: string[];
  falhaDetalhe: Set<string>; falhaEscrow: Set<string>; relogio: { t: number }; passo: number }
const prov = (agora: number): Prov => ({ pedidos: new Map(), cont: { list: 0, detail: 0, escrow: 0 }, listArgs: [], detalhados: [], falhaDetalhe: new Set(), falhaEscrow: new Set(), relogio: { t: agora }, passo: 0 });
const add = (pv: Prov, p: Omit<PedF, "indexado" | "update"> & { indexado?: boolean; update?: number }) => pv.pedidos.set(p.sn, { indexado: true, update: p.update ?? p.pay ?? p.create, ...p });

async function principal() {
  const W = await import("../lib/vendas/sync/worker");
  const RS = await import("../lib/shopee/ingestao/persistencia");
  const V = await import("../lib/vendas/canonico/service");
  const P = await import("../lib/vendas/sync/planejamento");
  const { ErroShopee } = await import("../lib/shopee/ingestao/tipos");

  const api = (pv: Prov, lojaId: string) => ({
    async listarPagina({ de, ate, cursor, tamanhoPagina }: any) {
      pv.cont.list++; pv.relogio.t += pv.passo; pv.listArgs.push({ loja: lojaId, de, ate });
      const todos = [...pv.pedidos.values()].filter((p) => p.loja === lojaId && p.indexado && p.create >= de && p.create <= ate).map((p) => p.sn).sort();
      const ini = cursor ? Number(cursor) : 0; const pag = todos.slice(ini, ini + tamanhoPagina); const mais = ini + tamanhoPagina < todos.length;
      return { pedidos: pag.map((orderSn) => ({ orderSn })), mais, proximoCursor: mais ? String(ini + tamanhoPagina) : null };
    },
    async detalhes(sns: string[]) {
      pv.cont.detail++; pv.relogio.t += pv.passo; pv.detalhados.push(...sns);
      return sns.map((sn) => pv.pedidos.get(sn)).filter((p): p is PedF => !!p && p.loja === lojaId && !pv.falhaDetalhe.has(p.sn)).map((p) => ({
        orderSn: p.sn, status: p.status, createTime: p.create / 1000, updateTime: p.update / 1000, payTime: p.pay === null ? null : p.pay / 1000,
        cancelBy: null, cancelReason: null, totalAmount: p.itens.reduce((s, i) => s + i.preco * i.qtd, 0),
        itens: p.itens.map((i) => ({ itemId: i.itemId, modelId: null, nome: null, sku: null, precoDescontado: i.preco, precoOriginal: i.preco, quantidade: i.qtd })) }));
    },
    async escrow(sn: string) {
      pv.cont.escrow++; pv.relogio.t += pv.passo;
      if (pv.falhaEscrow.has(sn)) throw new ErroShopee("permanente", "escrow_indisponivel");
      const p = pv.pedidos.get(sn)!;
      return { orderSn: sn, originalShopeeDiscount: p.sub ?? 0, pixDiscount: p.pix ?? 0,
        itens: (p.escrowItens ?? p.itens).map((i) => ({ itemId: i.itemId, modelId: null, voucherVendedor: i.vV ?? 0, voucherShopee: i.vS ?? 0, moedas: 0 })) };
    },
  });

  // ── mundo: hoje 07/10/2026 (SP) ──
  const H = (hhmm: string, dia = "2026-10-07") => { const [h, m] = hhmm.split(":").map(Number); return Date.parse(`${dia}T03:00:00.000Z`) + (h * 60 + m) * 60000; };
  const ISO = (ms: number) => new Date(ms).toISOString();
  const DIA0 = H("00:00"); const DIA = 24 * 3600 * 1000;
  const L = { SH1: "aaaaaaaa-0000-4000-8000-000000000101", SH2: "aaaaaaaa-0000-4000-8000-000000000102", SHX: "bbbbbbbb-0000-4000-8000-000000000101", ML1: "aaaaaaaa-0000-4000-8000-000000000201" };
  const cred = { access_token: "tk", refresh_token: "rt", token_expires_at: "2030-01-01T00:00:00Z" };
  const loja = (id: string, user_id: string, marketplace: "ML" | "Shopee") => ({ id, user_id, marketplace, ativo: true, seller_id: "777", partner_id: marketplace === "Shopee" ? 9 : null, partner_key: marketplace === "Shopee" ? "pk" : null, ...cred });
  const fechado = (lojaId: string, user: string, fimMs = DIA0, conclMs = H("06:00")) => ({ id: `fech-${lojaId}-${fimMs}`, user_id: user, loja_id: lojaId, marketplace: "Shopee", tipo: "backfill", status: "concluido",
    listagem_completa: true, campo_tempo: "create_time", janela_inicio: ISO(fimMs - 20 * DIA), janela_fim: ISO(fimMs), date_from: "2026-09-01", date_to: "2026-10-06", concluido_em: ISO(conclMs), criado_em: ISO(conclMs) });
  const jobIntra = (lojaId: string, user: string, iniMs: number, alvoMs: number, dia = "2026-10-07", extra: Linha = {}) => ({ id: `intra-${lojaId}-${alvoMs}-${++seq}`, user_id: user, loja_id: lojaId, marketplace: "Shopee",
    tipo: "incremental", status: "pendente", date_from: dia, date_to: dia, campo_tempo: "create_time", janela_inicio: ISO(iniMs), janela_fim: ISO(alvoMs), listagem_completa: false,
    checkpoint: null, progresso: null, iniciado_em: null, heartbeat_em: null, criado_em: ISO(alvoMs), tentativas: 0, max_tentativas: 3, ...extra });
  const mundo = (): Record<string, Linha[]> => ({ lojas: [loja(L.SH1, "dono-a", "Shopee"), loja(L.SH2, "dono-a", "Shopee"), loja(L.SHX, "dono-b", "Shopee"), loja(L.ML1, "dono-a", "ML")],
    sync_jobs: [fechado(L.SH1, "dono-a"), fechado(L.SH2, "dono-a"), fechado(L.SHX, "dono-b")], shopee_pedidos: [], pedidos: [], ml_pedidos: [] });
  /** linha de corpus "como se" ja ingerida antes (fechamento/refresh) */
  const corpusUnpaid = (d: Record<string, Linha[]>, lojaId: string, user: string, sn: string, createMs: number, detailMs: number) =>
    d.shopee_pedidos.push({ user_id: user, loja_id: lojaId, order_sn: sn, order_status: "UNPAID", create_time: ISO(createMs), update_time: ISO(createMs), pay_time: null,
      detail_fetched_at: ISO(detailMs), escrow_fetched_at: null, escrow_update_time: null, original_shopee_discount: null, pix_discount: null, total_amount: 0 });

  const worker = (d: Record<string, Linha[]>, pv: Prov, op: { intraday?: boolean; orcamentoMs?: number; auth?: "transitorio" | null } = { intraday: true }) => {
    const cliente = banco(d);
    return W.executarWorkerCanonico({ cliente, relogio: { agoraMs: () => pv.relogio.t }, portasML: async () => { throw new Error("ml_nao_esperado"); },
      portasShopee: async (job: any) => (op.auth === "transitorio" ? { transitorio: "refresh_em_andamento" as const } : { api: api(pv, job.lojaId) as any, repo: RS.criarRepositorioSupabase(cliente) }) },
      { orcamentoMs: op.orcamentoMs ?? 45_000, habilitado: true, ...(op.intraday === undefined ? {} : { intraday: op.intraday }) });
  };
  const ate = async (d: Record<string, Linha[]>, pv: Prov, max = 30, op: any = { intraday: true }) => { const out: string[] = []; for (let i = 0; i < max; i++) { const r = await worker(d, pv, op); out.push(String(r.fatia ?? r.resultado)); if (r.resultado === "NO_JOB" || r.fatia === "concluido" || r.fatia === "falhou" || r.resultado === "RECUSADO") break; } return out; };
  const consulta = (d: Record<string, Linha[]>, agoraMs: number, preset = "HOJE", marketplace = "shopee", userId = "dono-a", lojaId?: string) =>
    V.consultarVendasCanonicas({ userId, marketplace: marketplace as any, preset: preset as any, ...(lojaId ? { lojaId } : {}) }, { cliente: banco(d), agoraMs });
  const job = (d: Record<string, Linha[]>, id?: string) => (id ? d.sync_jobs.find((j) => j.id === id)! : d.sync_jobs[d.sync_jobs.length - 1]);

  console.log("\n[A–C. caminho feliz, zero, pedido novo]");
  t("A/C/Z. happy path: descoberta do dia + re-detail + escrow → concluido; D14 HOJE PARTIAL_FRESH ate T (so pay_time < T conta)", async () => {
    const d = mundo(); const pv = prov(H("10:40"));
    add(pv, { sn: "a", loja: L.SH1, create: H("08:00"), pay: H("08:05"), status: "READY_TO_SHIP", itens: [{ itemId: "i1", preco: 100, qtd: 1 }] });
    add(pv, { sn: "b", loja: L.SH1, create: H("09:00"), pay: H("09:10"), status: "READY_TO_SHIP", itens: [{ itemId: "i2", preco: 25, qtd: 2 }] });
    add(pv, { sn: "c", loja: L.SH1, create: H("10:20"), pay: H("10:35"), status: "READY_TO_SHIP", itens: [{ itemId: "i3", preco: 999, qtd: 1 }] });
    d.sync_jobs.push(jobIntra(L.SH1, "dono-a", DIA0, H("10:30")));
    const s = await ate(d, pv);
    assert(s[s.length - 1] === "concluido" && job(d).status === "concluido" && job(d).listagem_completa === true, s.join());
    assert(pv.listArgs[0].de === DIA0 && pv.listArgs[0].ate === H("10:30"), JSON.stringify(pv.listArgs[0]));
    const v = await consulta(d, H("10:41"), "HOJE", "shopee", "dono-a", L.SH1);
    assert(v.estado === "PARTIAL_FRESH" && v.observadoAte === ISO(H("10:30")) && v.metricas.shopee!.vendas === 150 && v.metricas.shopee!.pedidos === 2, `${v.estado} ${v.observadoAte} ${JSON.stringify(v.metricas.shopee)}`);
  });
  t("B/AA. ZERO vendas: listagem e candidatos processados, nenhum pago → concluido; D14 metricas zero, semVendas=true", async () => {
    const d = mundo(); const pv = prov(H("10:40"));
    d.sync_jobs.push(jobIntra(L.SH1, "dono-a", DIA0, H("10:30")));
    const s = await ate(d, pv);
    const v = await consulta(d, H("10:41"), "HOJE", "shopee", "dono-a", L.SH1);
    assert(s.pop() === "concluido" && v.estado === "PARTIAL_FRESH" && v.metricas.shopee!.vendas === 0 && v.metricas.semVendas === true, `${v.estado} ${JSON.stringify(v.metricas)}`);
  });

  console.log("\n[D–G. indexacao atrasada, pagamento tardio, politica]");
  t("D. pedido INDEXADO ATRASADO (criado 10:05; ausente em T1=10:30; presente em T2=11:00) → recuperado (descoberta do dia inteiro)", async () => {
    const d = mundo(); const pv = prov(H("10:40"));
    add(pv, { sn: "a", loja: L.SH1, create: H("08:00"), pay: H("08:05"), status: "READY_TO_SHIP", itens: [{ itemId: "i1", preco: 100, qtd: 1 }] });
    add(pv, { sn: "X", loja: L.SH1, create: H("10:05"), pay: H("10:06"), status: "READY_TO_SHIP", itens: [{ itemId: "ix", preco: 7, qtd: 1 }], indexado: false });
    d.sync_jobs.push(jobIntra(L.SH1, "dono-a", DIA0, H("10:30"))); await ate(d, pv);
    const v1 = await consulta(d, H("10:41"), "HOJE", "shopee", "dono-a", L.SH1);
    pv.pedidos.get("X")!.indexado = true; pv.relogio.t = H("11:05");
    d.sync_jobs.push(jobIntra(L.SH1, "dono-a", H("10:30"), H("11:00"))); await ate(d, pv);   // janela do planner: [ultimo T, T]
    const v2 = await consulta(d, H("11:06"), "HOJE", "shopee", "dono-a", L.SH1);
    assert(v1.metricas.shopee!.vendas === 100 && v2.metricas.shopee!.vendas === 107 && v2.observadoAte === ISO(H("11:00")), `${JSON.stringify(v1.metricas.shopee)} ${JSON.stringify(v2.metricas.shopee)}`);
    assert(pv.listArgs[1].de === DIA0, `descoberta da 2a observacao comecou em ${ISO(pv.listArgs[1].de)}`);
  });
  t("E. criado ONTEM 23:00 (nao pago no corpus) e pago HOJE 10:00 → re-detail o traz para Hoje", async () => {
    const d = mundo(); const pv = prov(H("10:40"));
    corpusUnpaid(d, L.SH1, "dono-a", "Y", H("23:00", "2026-10-06"), H("23:30", "2026-10-06"));
    add(pv, { sn: "Y", loja: L.SH1, create: H("23:00", "2026-10-06"), pay: H("10:00"), status: "READY_TO_SHIP", itens: [{ itemId: "iy", preco: 40, qtd: 1 }] });
    d.sync_jobs.push(jobIntra(L.SH1, "dono-a", DIA0, H("10:30"))); await ate(d, pv);
    const v = await consulta(d, H("10:41"), "HOJE", "shopee", "dono-a", L.SH1);
    assert(pv.detalhados.includes("Y") && v.estado === "PARTIAL_FRESH" && v.metricas.shopee!.vendas === 40, `${v.estado} ${JSON.stringify(v.metricas.shopee)}`);
  });
  t("F. criado HA 3 DIAS (nao pago) e pago hoje 09:00 → re-detail detecta; D14 inclui", async () => {
    const d = mundo(); const pv = prov(H("10:40"));
    corpusUnpaid(d, L.SH1, "dono-a", "Z", H("12:00", "2026-10-04"), H("12:10", "2026-10-04"));
    add(pv, { sn: "Z", loja: L.SH1, create: H("12:00", "2026-10-04"), pay: H("09:00"), status: "READY_TO_SHIP", itens: [{ itemId: "iz", preco: 60, qtd: 1 }] });
    d.sync_jobs.push(jobIntra(L.SH1, "dono-a", DIA0, H("10:30"))); await ate(d, pv);
    const v = await consulta(d, H("10:41"), "HOJE", "shopee", "dono-a", L.SH1);
    assert(v.metricas.shopee!.vendas === 60, `${v.estado} ${JSON.stringify(v.metricas.shopee)}`);
  });
  t("G/28. pagamento ALEM da politica (criado ha 12 dias, pago hoje) → sentinela do leitor: sem metricas (fail closed); nao pago de 11 dias nem entra no re-detail", async () => {
    const d = mundo(); const pv = prov(H("10:40"));
    d.shopee_pedidos.push({ user_id: "dono-a", loja_id: L.SH1, order_sn: "VELHO", order_status: "READY_TO_SHIP", create_time: ISO(H("09:00") - 12 * DIA), update_time: ISO(H("09:00")), pay_time: ISO(H("09:00")),
      detail_fetched_at: ISO(H("09:05")), escrow_fetched_at: null, escrow_update_time: null, original_shopee_discount: null, pix_discount: null, total_amount: 0 });
    add(pv, { sn: "VELHO", loja: L.SH1, create: H("09:00") - 12 * DIA, pay: H("09:00"), status: "READY_TO_SHIP", itens: [{ itemId: "iv", preco: 500, qtd: 1 }] });
    corpusUnpaid(d, L.SH1, "dono-a", "ONZE", H("12:00") - 11 * DIA, H("12:00") - 11 * DIA);
    add(pv, { sn: "ONZE", loja: L.SH1, create: H("12:00") - 11 * DIA, pay: null, status: "UNPAID", itens: [{ itemId: "io", preco: 1, qtd: 1 }] });
    d.sync_jobs.push(jobIntra(L.SH1, "dono-a", DIA0, H("10:30"))); await ate(d, pv);
    const v = await consulta(d, H("10:41"), "HOJE", "shopee", "dono-a", L.SH1);
    assert(v.metricas.shopee === null && v.metricas.combinadas === null && !pv.detalhados.includes("ONZE"), `${v.estado} ${JSON.stringify(v.metricas)} ${pv.detalhados}`);
  });

  console.log("\n[H–K. re-detail, cancelamento, escrow]");
  const duasObservacoes = async (mutar: (pv: Prov, d: Record<string, Linha[]>) => void) => {
    const d = mundo(); const pv = prov(H("10:40"));
    add(pv, { sn: "a", loja: L.SH1, create: H("08:00"), pay: H("08:05"), status: "READY_TO_SHIP", itens: [{ itemId: "i1", preco: 100, qtd: 1 }] });
    add(pv, { sn: "b", loja: L.SH1, create: H("09:00"), pay: H("09:10"), status: "READY_TO_SHIP", itens: [{ itemId: "i2", preco: 50, qtd: 1 }] });
    d.sync_jobs.push(jobIntra(L.SH1, "dono-a", DIA0, H("10:30"))); await ate(d, pv);
    const v1 = await consulta(d, H("10:41"), "HOJE", "shopee", "dono-a", L.SH1);
    const esc1 = pv.cont.escrow; const fA1 = d.shopee_pedidos.find((p) => p.order_sn === "a")!.detail_fetched_at;
    mutar(pv, d); pv.relogio.t = H("11:05");
    d.sync_jobs.push(jobIntra(L.SH1, "dono-a", H("10:30"), H("11:00"))); const s2 = await ate(d, pv);
    const v2 = await consulta(d, H("11:06"), "HOJE", "shopee", "dono-a", L.SH1);
    return { d, pv, v1, v2, esc1, esc2: pv.cont.escrow - esc1, fA1, s2 };
  };
  t("H. pedido JA pago hoje e re-detalhado em TODA observacao (detail_fetched_at avanca para >= T2)", async () => {
    const r = await duasObservacoes(() => {});
    const fA2 = r.d.shopee_pedidos.find((p) => p.order_sn === "a")!.detail_fetched_at;
    assert(r.fA1 < fA2 && Date.parse(fA2) >= H("11:00") && r.v2.estado === "PARTIAL_FRESH", `${r.fA1} ${fA2} ${r.v2.estado}`);
  });
  t("H2. criado ONTEM e pago hoje: na 2a observacao (ja pago, fora da listagem do dia) continua re-detalhado via 'pagos hoje' → T2 PARTIAL_FRESH com ele", async () => {
    const d = mundo(); const pv = prov(H("10:40"));
    corpusUnpaid(d, L.SH1, "dono-a", "Y", H("23:00", "2026-10-06"), H("23:30", "2026-10-06"));
    add(pv, { sn: "Y", loja: L.SH1, create: H("23:00", "2026-10-06"), pay: H("10:00"), status: "READY_TO_SHIP", itens: [{ itemId: "iy", preco: 40, qtd: 1 }] });
    d.sync_jobs.push(jobIntra(L.SH1, "dono-a", DIA0, H("10:30"))); await ate(d, pv);
    pv.relogio.t = H("11:05"); pv.detalhados.length = 0;
    d.sync_jobs.push(jobIntra(L.SH1, "dono-a", H("10:30"), H("11:00"))); await ate(d, pv);
    const v = await consulta(d, H("11:06"), "HOJE", "shopee", "dono-a", L.SH1);
    assert(pv.detalhados.includes("Y") && v.estado === "PARTIAL_FRESH" && v.observadoAte === ISO(H("11:00")) && v.metricas.shopee!.vendas === 40, `${pv.detalhados} ${v.estado} ${JSON.stringify(v.metricas.shopee)}`);
  });
  t("I. cancelado DEPOIS do pagamento: vendas/pedidos ficam (regra canonica), cancelados passa a 1", async () => {
    const r = await duasObservacoes((pv) => { const a = pv.pedidos.get("a")!; a.status = "CANCELLED"; a.update = H("10:50"); });
    assert(r.v1.metricas.shopee!.cancelados === 0 && r.v2.metricas.shopee!.cancelados === 1 && r.v2.metricas.shopee!.vendas === 150 && r.v2.metricas.shopee!.pedidos === 2,
      `${JSON.stringify(r.v1.metricas.shopee)} ${JSON.stringify(r.v2.metricas.shopee)}`);
  });
  t("J. escrow MUDOU (update_time novo) → novo escrow gravado antes de concluir T2 (voucher do vendedor 5 → vendas 145)", async () => {
    const r = await duasObservacoes((pv) => { const b = pv.pedidos.get("b")!; b.update = H("10:55"); b.itens = [{ itemId: "i2", preco: 50, qtd: 1, vV: 5 }]; });
    assert(r.esc2 === 1 && r.v2.metricas.shopee!.vendas === 145, `escrow=${r.esc2} ${JSON.stringify(r.v2.metricas.shopee)}`);
  });
  t("K. escrow REUTILIZADO com seguranca: nada mudou (update_time igual) → 0 chamadas de escrow em T2", async () => {
    const r = await duasObservacoes(() => {});
    assert(r.esc1 === 2 && r.esc2 === 0, `esc1=${r.esc1} esc2=${r.esc2}`);
  });
  // O pedido do PROPRIO prefixo T1 mudou (update_time novo) e o escrow nao pode ser relido: o leitor (dimensao C)
  // recusa reusar o valor velho — sem metricas, nunca um numero com a linha de item velha.
  t("K2. item REMOVIDO num detail posterior (linha velha nunca apagada) → escrow 1:1 falha → alvo NAO conclui; D14 nunca mostra numero com o item velho (fail closed)", async () => {
    const d = mundo(); const pv = prov(H("10:40"));
    add(pv, { sn: "a", loja: L.SH1, create: H("08:00"), pay: H("08:05"), status: "READY_TO_SHIP", itens: [{ itemId: "i1", preco: 100, qtd: 1 }, { itemId: "i9", preco: 30, qtd: 1 }] });
    d.sync_jobs.push(jobIntra(L.SH1, "dono-a", DIA0, H("10:30"))); await ate(d, pv);
    const v1 = await consulta(d, H("10:41"), "HOJE", "shopee", "dono-a", L.SH1);
    // o detail posterior so traz i1 (i9 "removido"); a linha de i9 continua no corpus; o escrow so tem i1
    const a = pv.pedidos.get("a")!; a.update = H("10:50"); a.itens = [{ itemId: "i1", preco: 100, qtd: 1 }]; pv.relogio.t = H("11:05");
    d.sync_jobs.push(jobIntra(L.SH1, "dono-a", H("10:30"), H("11:00"))); const s2 = await ate(d, pv);
    const v2 = await consulta(d, H("11:06"), "HOJE", "shopee", "dono-a", L.SH1);
    assert(v1.metricas.shopee!.vendas === 130 && d.pedidos.length === 2, `T1 ${JSON.stringify(v1.metricas.shopee)}`);
    assert(s2.pop() === "falhou" && job(d).status === "erro" && v2.metricas.shopee === null && v2.metricas.combinadas === null, `${job(d).status} ${v2.estado} ${JSON.stringify(v2.metricas.shopee)}`);
  });

  console.log("\n[L–P. paginacao e pausa/retomada por fase]");
  t("L/M/27. paginacao: 250 pedidos do dia → 3 paginas de listagem, 5 lotes de detail (50), 250 escrows (1 por pedido)", async () => {
    const d = mundo(); const pv = prov(H("10:40"));
    for (let i = 0; i < 250; i++) add(pv, { sn: `p${String(i).padStart(3, "0")}`, loja: L.SH1, create: H("08:00") + i * 1000, pay: H("08:01") + i * 1000, status: "READY_TO_SHIP", itens: [{ itemId: `i${i}`, preco: 1, qtd: 1 }] });
    d.sync_jobs.push(jobIntra(L.SH1, "dono-a", DIA0, H("10:30"))); const s = await ate(d, pv, 50);
    const v = await consulta(d, H("10:41"), "HOJE", "shopee", "dono-a", L.SH1);
    console.log(`        modelo de chamadas (250 pedidos): list=${pv.cont.list} detail=${pv.cont.detail} escrow=${pv.cont.escrow} fatias=${s.length}`);
    assert(pv.cont.list === 3 && pv.cont.detail === 5 && pv.cont.escrow === 250 && v.metricas.shopee!.pedidos === 250, `${pv.cont.list} ${pv.cont.detail} ${pv.cont.escrow} ${JSON.stringify(v.metricas.shopee)}`);
  });
  t("N/O/P. orcamento curto: pausa em LIST, DETAIL e ESCROW e retoma do checkpoint (nenhuma pagina relida, nada reiniciado)", async () => {
    const d = mundo(); const pv = prov(H("10:40")); pv.passo = 10_000;   // cada chamada ao provedor custa 10s
    for (let i = 0; i < 450; i++) add(pv, { sn: `q${String(i).padStart(3, "0")}`, loja: L.SH1, create: H("08:00") + i * 1000, pay: H("08:01") + i * 1000, status: "READY_TO_SHIP", itens: [{ itemId: `i${i}`, preco: 1, qtd: 1 }] });
    d.sync_jobs.push(jobIntra(L.SH1, "dono-a", DIA0, H("10:30")));
    const fases: string[] = [];
    for (let i = 0; i < 200; i++) { const r = await worker(d, pv); fases.push(job(d).checkpoint?.fase ?? "-"); if (r.fatia === "concluido" || r.fatia === "falhou") break; }
    assert(fases.includes("LIST") && fases.includes("DETAIL") && fases.includes("ESCROW") && job(d).status === "concluido", fases.join(","));
    assert(pv.cont.list === 5 && pv.cont.detail === 9 && pv.cont.escrow === 450, `list=${pv.cont.list} detail=${pv.cont.detail} escrow=${pv.cont.escrow}`);
  });
  t("31. refresh de token em andamento no meio do job → ADIADO, checkpoint intacto; a proxima fatia continua (nao reinicia)", async () => {
    const d = mundo(); const pv = prov(H("10:40")); pv.passo = 10_000;
    for (let i = 0; i < 150; i++) add(pv, { sn: `r${String(i).padStart(3, "0")}`, loja: L.SH1, create: H("08:00") + i * 1000, pay: H("08:01") + i * 1000, status: "READY_TO_SHIP", itens: [{ itemId: `i${i}`, preco: 1, qtd: 1 }] });
    d.sync_jobs.push(jobIntra(L.SH1, "dono-a", DIA0, H("10:30")));
    await worker(d, pv); const ck1 = JSON.stringify(job(d).checkpoint);
    const adiado = await worker(d, pv, { intraday: true, auth: "transitorio" });
    assert(adiado.resultado === "ADIADO" && JSON.stringify(job(d).checkpoint) === ck1 && job(d).status === "pendente", `${adiado.resultado}`);
    const s = await ate(d, pv, 100);
    assert(s.pop() === "concluido" && pv.cont.list === 2, `list=${pv.cont.list}`);
  });

  console.log("\n[Q–T. falha, D14.1, replay, meia-noite]");
  t("Q. detail que nunca materializa → alvo NAO conclui (erro); sem observacao anterior: D14 sem metricas", async () => {
    const d = mundo(); const pv = prov(H("10:40"));
    add(pv, { sn: "a", loja: L.SH1, create: H("08:00"), pay: H("08:05"), status: "READY_TO_SHIP", itens: [{ itemId: "i1", preco: 100, qtd: 1 }] });
    pv.falhaDetalhe.add("a");
    d.sync_jobs.push(jobIntra(L.SH1, "dono-a", DIA0, H("10:30"))); const s = await ate(d, pv);
    const v = await consulta(d, H("10:41"), "HOJE", "shopee", "dono-a", L.SH1);
    assert(s.pop() === "falhou" && job(d).status === "erro" && v.metricas.shopee === null && v.observadoAte === null, `${s} ${v.estado}`);
  });
  t("R/37. T1 ok → T2 falha (escrow obrigatorio indisponivel) → Hoje segue ate T1; T3 ok → avanca", async () => {
    const d = mundo(); const pv = prov(H("10:40"));
    add(pv, { sn: "a", loja: L.SH1, create: H("08:00"), pay: H("08:05"), status: "READY_TO_SHIP", itens: [{ itemId: "i1", preco: 100, qtd: 1 }] });
    d.sync_jobs.push(jobIntra(L.SH1, "dono-a", DIA0, H("10:30"))); await ate(d, pv);
    add(pv, { sn: "n", loja: L.SH1, create: H("10:40"), pay: H("10:45"), status: "READY_TO_SHIP", itens: [{ itemId: "in", preco: 10, qtd: 1 }] });
    pv.falhaEscrow.add("n"); pv.relogio.t = H("11:05");
    d.sync_jobs.push(jobIntra(L.SH1, "dono-a", H("10:30"), H("11:00"))); const s2 = await ate(d, pv);
    const v2 = await consulta(d, H("11:06"), "HOJE", "shopee", "dono-a", L.SH1);
    assert(s2.pop() === "falhou" && v2.estado === "PARTIAL_FRESH" && v2.observadoAte === ISO(H("10:30")) && v2.metricas.shopee!.vendas === 100, `${v2.estado} ${v2.observadoAte}`);
    pv.falhaEscrow.clear(); pv.relogio.t = H("11:35");
    d.sync_jobs.push(jobIntra(L.SH1, "dono-a", H("10:30"), H("11:30"))); await ate(d, pv);
    const v3 = await consulta(d, H("11:36"), "HOJE", "shopee", "dono-a", L.SH1);
    assert(v3.estado === "PARTIAL_FRESH" && v3.observadoAte === ISO(H("11:30")) && v3.metricas.shopee!.vendas === 110, `${v3.estado} ${v3.observadoAte} ${JSON.stringify(v3.metricas.shopee)}`);
  });
  t("S. replay do MESMO T: nenhum pedido/item duplicado, metricas iguais", async () => {
    const d = mundo(); const pv = prov(H("10:40"));
    add(pv, { sn: "a", loja: L.SH1, create: H("08:00"), pay: H("08:05"), status: "READY_TO_SHIP", itens: [{ itemId: "i1", preco: 100, qtd: 1 }, { itemId: "i9", preco: 3, qtd: 2 }] });
    d.sync_jobs.push(jobIntra(L.SH1, "dono-a", DIA0, H("10:30"))); await ate(d, pv);
    const n1 = [d.shopee_pedidos.length, d.pedidos.length]; const v1 = await consulta(d, H("10:41"), "HOJE", "shopee", "dono-a", L.SH1);
    d.sync_jobs.push(jobIntra(L.SH1, "dono-a", DIA0, H("10:30"))); await ate(d, pv);
    const v2 = await consulta(d, H("10:42"), "HOJE", "shopee", "dono-a", L.SH1);
    assert(n1.join() === "1,2" && [d.shopee_pedidos.length, d.pedidos.length].join() === "1,2" && v1.metricas.shopee!.vendas === 106 && v2.metricas.shopee!.vendas === 106, `${n1} ${d.pedidos.length} ${v2.metricas.shopee?.vendas}`);
  });
  t("T/39. job de 06/10 (T 23:45) pausado 23:58 e retomado 07/10 00:02 → continua 06/10 e o MESMO T", async () => {
    const d = mundo(); const pv = prov(H("23:58", "2026-10-06")); pv.passo = 10_000;
    for (let i = 0; i < 300; i++) add(pv, { sn: `m${String(i).padStart(3, "0")}`, loja: L.SH1, create: H("20:00", "2026-10-06") + i * 1000, pay: H("20:01", "2026-10-06") + i * 1000, status: "READY_TO_SHIP", itens: [{ itemId: `i${i}`, preco: 1, qtd: 1 }] });
    d.sync_jobs.push(jobIntra(L.SH1, "dono-a", H("00:00", "2026-10-06"), H("23:45", "2026-10-06"), "2026-10-06"));
    await worker(d, pv); pv.relogio.t = H("00:02", "2026-10-07");
    const s = await ate(d, pv, 100);
    assert(s.pop() === "concluido" && pv.listArgs.every((a) => a.de === H("00:00", "2026-10-06") && a.ate === H("23:45", "2026-10-06")) && job(d).janela_fim === ISO(H("23:45", "2026-10-06")), JSON.stringify(pv.listArgs[pv.listArgs.length - 1]));
  });

  console.log("\n[U–Y. isolamento, caminho normal, travas, cobertura fechada]");
  t("U. dono/loja isolados: candidatos e re-detail so da loja do job (mesmo shop em outro dono nunca e tocado)", async () => {
    const d = mundo(); const pv = prov(H("10:40"));
    corpusUnpaid(d, L.SHX, "dono-b", "W", H("08:00"), H("08:00"));
    add(pv, { sn: "W", loja: L.SHX, create: H("08:00"), pay: H("08:30"), status: "READY_TO_SHIP", itens: [{ itemId: "iw", preco: 9000, qtd: 1 }] });
    add(pv, { sn: "a", loja: L.SH1, create: H("08:00"), pay: H("08:05"), status: "READY_TO_SHIP", itens: [{ itemId: "i1", preco: 100, qtd: 1 }] });
    d.sync_jobs.push(jobIntra(L.SH1, "dono-a", DIA0, H("10:30"))); await ate(d, pv);
    const v = await consulta(d, H("10:41"), "HOJE", "shopee", "dono-a", L.SH1);
    const w = d.shopee_pedidos.find((p) => p.order_sn === "W")!;
    assert(!pv.detalhados.includes("W") && w.pay_time === null && w.user_id === "dono-b" && v.metricas.shopee!.vendas === 100, `${pv.detalhados} ${JSON.stringify(w)}`);
  });
  t("U2. duas lojas do MESMO dono: o nao pago recente da SH2 nunca entra nos candidatos da SH1 (escopo por loja, nao so por dono)", async () => {
    const d = mundo(); const pv = prov(H("10:40"));
    corpusUnpaid(d, L.SH2, "dono-a", "S2X", H("08:00"), H("08:00"));
    add(pv, { sn: "S2X", loja: L.SH2, create: H("08:00"), pay: H("09:00"), status: "READY_TO_SHIP", itens: [{ itemId: "is", preco: 70, qtd: 1 }] });
    add(pv, { sn: "a", loja: L.SH1, create: H("08:00"), pay: H("08:05"), status: "READY_TO_SHIP", itens: [{ itemId: "i1", preco: 100, qtd: 1 }] });
    d.sync_jobs.push(jobIntra(L.SH1, "dono-a", DIA0, H("10:30"))); const s = await ate(d, pv);
    assert(s.pop() === "concluido" && !pv.detalhados.includes("S2X") && d.shopee_pedidos.find((p) => p.order_sn === "S2X")!.pay_time === null, `${s} ${pv.detalhados}`);
  });
  t("V. job Shopee NORMAL (backfill create_time) segue o motor antigo: sem semear candidatos; escrow desistido ainda conclui (semantica antiga)", async () => {
    const d = mundo(); const pv = prov(H("10:40"));
    corpusUnpaid(d, L.SH1, "dono-a", "Y", H("23:00", "2026-10-06"), H("23:30", "2026-10-06"));
    add(pv, { sn: "a", loja: L.SH1, create: H("08:00", "2026-10-06"), pay: H("08:05", "2026-10-06"), status: "READY_TO_SHIP", itens: [{ itemId: "i1", preco: 100, qtd: 1 }] });
    pv.falhaEscrow.add("a");
    d.sync_jobs.push({ ...jobIntra(L.SH1, "dono-a", H("00:00", "2026-10-06"), H("00:00", "2026-10-07"), "2026-10-06"), tipo: "backfill" });
    for (const intraday of [true, false]) {
      const s = await ate(d, pv, 10, { intraday });
      assert(s.pop() === "concluido" && !pv.detalhados.includes("Y") && job(d).status === "concluido", `intraday=${intraday} ${s}`);
      d.sync_jobs.push({ ...jobIntra(L.SH1, "dono-a", H("00:00", "2026-10-06"), H("00:00", "2026-10-07"), "2026-10-06"), tipo: "backfill" });
    }
  });
  t("W. intraday DESLIGADO (padrao de producao): worker recusa ANTES do provedor", async () => {
    const d = mundo(); const pv = prov(H("10:40"));
    add(pv, { sn: "a", loja: L.SH1, create: H("08:00"), pay: H("08:05"), status: "READY_TO_SHIP", itens: [{ itemId: "i1", preco: 100, qtd: 1 }] });
    d.sync_jobs.push(jobIntra(L.SH1, "dono-a", DIA0, H("10:30")));
    const r = await worker(d, pv, {});
    assert(r.resultado === "RECUSADO" && (r as any).motivo === "intraday_sem_motor" && pv.cont.list + pv.cont.detail + pv.cont.escrow === 0, JSON.stringify(r));
  });
  t("Y. intraday Shopee concluido (dia inteiro) NAO e cobertura fechada: 06/10 ainda pede o fechamento normal desde 00:00", async () => {
    const d = mundo(); const pv = prov(H("00:05"));
    d.sync_jobs = [{ ...fechado(L.SH1, "dono-a", H("00:00", "2026-10-06")), concluido_em: ISO(H("00:05")) }];
    d.sync_jobs.push(jobIntra(L.SH1, "dono-a", H("00:00", "2026-10-06"), H("00:00", "2026-10-07"), "2026-10-06")); await ate(d, pv);
    const j = job(d);
    const jobs = d.sync_jobs.map((x) => ({ id: x.id, lojaId: x.loja_id, marketplace: x.marketplace, campoTempo: x.campo_tempo, janelaInicio: x.janela_inicio, janelaFim: x.janela_fim, status: x.status,
      listagemCompleta: x.listagem_completa, concluidoEm: x.concluido_em, criadoEm: x.criado_em, tipo: x.tipo, dateFrom: x.date_from, dateTo: x.date_to }));
    const a = P.avaliarLoja({ loja: { id: L.SH1, marketplace: "Shopee" }, de: "2026-10-06", ate: "2026-10-06", agoraMs: H("00:10"), jobs, politica: P.POLITICA_SYNC_PROPOSTA, origem: "background",
      sinaisShopee: { escrowPendentes: 0, naoObservadosAposPeriodo: 0 } });
    const desc = a.necessidades.filter((n) => n.tipo === "discovery").map((n) => n.job);
    assert(j.status === "concluido" && a.cobertura === "PARTIAL" && desc.length > 0 && desc[0].inicio === ISO(H("00:00", "2026-10-06")), `${j.status} ${a.cobertura} ${JSON.stringify(desc.map((x) => x.inicio))}`);
  });

  console.log("\n[AB–AD. este mes, todos, fuso]");
  t("AB/36. ESTE_MES: parte fechada COMPLETA (03/10 = 300) + hoje observado (150) → PARTIAL_FRESH 450", async () => {
    const d = mundo(); const pv = prov(H("10:40"));
    d.shopee_pedidos.push({ user_id: "dono-a", loja_id: L.SH1, order_sn: "C1", order_status: "COMPLETED", create_time: ISO(H("10:00", "2026-10-03")), update_time: ISO(H("10:05", "2026-10-03")),
      pay_time: ISO(H("10:05", "2026-10-03")), detail_fetched_at: ISO(H("05:00")), escrow_fetched_at: ISO(H("05:00")), escrow_update_time: ISO(H("10:05", "2026-10-03")), original_shopee_discount: 0, pix_discount: 0, total_amount: 300 });
    d.pedidos.push({ id: "dono-a_SHOPEE_C1_ic_nv", user_id: "dono-a", marketplace: "Shopee", loja_id: L.SH1, order_id: "C1", ml_item_id: "ic", variation_id: null, qtd: 1, valor_unit: 300, escrow_voucher_seller: 0, escrow_voucher_shopee: 0, escrow_coin: 0 });
    add(pv, { sn: "a", loja: L.SH1, create: H("08:00"), pay: H("08:05"), status: "READY_TO_SHIP", itens: [{ itemId: "i1", preco: 100, qtd: 1 }] });
    add(pv, { sn: "b", loja: L.SH1, create: H("09:00"), pay: H("09:10"), status: "READY_TO_SHIP", itens: [{ itemId: "i2", preco: 50, qtd: 1 }] });
    d.sync_jobs.push(jobIntra(L.SH1, "dono-a", DIA0, H("10:30"))); await ate(d, pv);
    const v = await consulta(d, H("10:41"), "ESTE_MES", "shopee", "dono-a", L.SH1);
    assert(v.estado === "PARTIAL_FRESH" && v.metricas.shopee!.vendas === 450 && v.partes.fechada!.ate === "2026-10-06", `${v.estado} ${JSON.stringify(v.metricas.shopee)} ${JSON.stringify(v.cobertura.lojas[0].motivos)}`);
  });
  t("AC/38. 'todos' ML (observado ate 10:00) + Shopee (ate 10:30) → observadoAte = o MENOR (10:00), metricas somadas", async () => {
    const d = mundo(); const pv = prov(H("10:40"));
    d.lojas = d.lojas.filter((l) => l.id !== L.SH2);
    d.sync_jobs.push({ id: "ml-intra", user_id: "dono-a", loja_id: L.ML1, marketplace: "ML", tipo: "incremental", status: "concluido", listagem_completa: true, campo_tempo: "date_closed",
      janela_inicio: ISO(DIA0), janela_fim: ISO(H("10:00")), date_from: "2026-10-07", date_to: "2026-10-07", concluido_em: ISO(H("10:05")), criado_em: ISO(H("10:00")) });
    d.ml_pedidos.push({ user_id: "dono-a", loja_id: L.ML1, order_id: "m1", date_closed: ISO(H("09:00")), cancel_detail_code: null, total_amount: 20, unidades: 1, fetched_at: ISO(H("10:05")) });
    add(pv, { sn: "a", loja: L.SH1, create: H("08:00"), pay: H("08:05"), status: "READY_TO_SHIP", itens: [{ itemId: "i1", preco: 100, qtd: 1 }] });
    d.sync_jobs.push(jobIntra(L.SH1, "dono-a", DIA0, H("10:30"))); await ate(d, pv);
    const v = await consulta(d, H("10:41"), "HOJE", "todos");
    assert(v.estado === "PARTIAL_FRESH" && v.observadoAte === ISO(H("10:00")) && v.metricas.combinadas!.vendas === 120, `${v.estado} ${v.observadoAte} ${JSON.stringify(v.metricas.combinadas)}`);
  });
  t("AD. dia civil pelo offset REAL (15/01/2019, horario de verao): listagem comeca 02:00Z", async () => {
    const d = mundo(); const pv = prov(Date.parse("2019-01-15T13:10:00.000Z"));
    d.sync_jobs = [{ ...fechado(L.SH1, "dono-a", Date.parse("2019-01-15T02:00:00.000Z")), concluido_em: "2019-01-15T05:00:00.000Z" }];
    add(pv, { sn: "dst", loja: L.SH1, create: Date.parse("2019-01-15T02:30:00.000Z"), pay: Date.parse("2019-01-15T02:40:00.000Z"), status: "READY_TO_SHIP", itens: [{ itemId: "id", preco: 5, qtd: 1 }] });
    d.sync_jobs.push(jobIntra(L.SH1, "dono-a", Date.parse("2019-01-15T02:00:00.000Z"), Date.parse("2019-01-15T13:00:00.000Z"), "2019-01-15"));
    const s = await ate(d, pv);
    assert(s.pop() === "concluido" && pv.listArgs[0].de === Date.parse("2019-01-15T02:00:00.000Z") && d.shopee_pedidos.some((p) => p.order_sn === "dst"), JSON.stringify(pv.listArgs[0]));
  });
  t("RO. nenhuma rede", () => assert(fetches === 0, `fetch=${fetches}`));

  await fila;
  console.log(`\n${falhou === 0 ? "✓" : "✗"} SHOPEE-INTRADAY — ${passou} passaram, ${falhou} falharam`);
  process.exit(falhou === 0 ? 0 : 1);
}
principal().catch((e) => { console.error("ERRO FATAL", e); process.exit(1); });
