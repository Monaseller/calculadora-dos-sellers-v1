/**
 * SALES-SYNC-D15C — motor INTRADAY Mercado Livre (offline, ponta a ponta).
 *
 * provedor ML FALSO → job intraday → worker REAL → executarFatiaMLIntraday →
 * repositorio ML REAL sobre um banco em memoria → consultarVendasCanonicas
 * (D14). Sem rede, sem banco real. D15F2: o intraday e LIGADO por padrao em
 * producao (L); `intraday: false` explicito continua recusando (L2).
 *
 * Uso: npx tsx scripts/testar-ml-intraday.ts
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

// ── banco em memoria: select/insert/update/upsert, filtros, 23505 de 1 ativo por loja ──
type Linha = Record<string, any>;
let seq = 0;
function banco(dados: Record<string, Linha[]>, relogio: () => number) {
  const valor = (l: Linha, col: string) => (col.includes("->>") ? l[col.split("->>")[0]]?.[col.split("->>")[1]] : l[col]);
  const cmp = (x: any, v: any, f: (a: any, b: any) => boolean) => x !== null && x !== undefined && f(x, v);
  return {
    from(tabela: string) {
      const filtros: [string, string, any][] = []; let op: "select" | "update" | "insert" | "upsert" = "select"; let carga: any = null; let conflito: string[] = [];
      let head = false, limite = Infinity, unico: "single" | "maybe" | null = null;
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
          if (tabela === "sync_jobs" && ["pendente", "rodando"].includes(r.status) && tab.some((j) => j.loja_id === r.loja_id && ["pendente", "rodando"].includes(j.status))) {
            return { data: null, error: { code: "23505", message: "idx_sync_jobs_loja_ativo" } };
          }
          r.id = r.id ?? `job-${++seq}`; tab.push(r);
          return { data: unico ? { id: r.id } : [{ id: r.id }], error: null };
        }
        if (op === "upsert") {
          for (const r of carga as Linha[]) {
            const i = tab.findIndex((x) => conflito.every((k) => String(x[k]) === String(r[k])));
            if (i >= 0) tab[i] = { ...tab[i], ...r }; else tab.push({ ...r });
          }
          return { data: null, error: null };
        }
        const linhas = tab.filter(casa);
        if (op === "update") { for (const l of linhas) Object.assign(l, carga); return { data: linhas.map((l) => ({ id: l.id })), error: null }; }
        if (head) return { data: null, count: linhas.length, error: null };
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
        if (p === "not") return (col: string, o: string, v: any) => { filtros.push(["not", col, [o, v]]); return c; };
        if (["eq", "in", "gte", "gt", "lt", "is"].includes(p)) return (col: string, v: any) => { filtros.push([p, col, v]); return c; };
        return () => c;
      } });
      return c;
    },
  } as any;
}

// ── provedor ML falso: o dia INTEIRO por date_closed; `escondidos` = ainda nao indexados ──
interface Provedor { pedidos: Linha[]; escondidos: Set<string>; completa: boolean; paginas: number; erro: string | null; chamadas: { lojaId: string; dia: string }[] }
const provedor = (pedidos: Linha[] = []): Provedor => ({ pedidos, escondidos: new Set(), completa: true, paginas: 1, erro: null, chamadas: [] });
const ordem = (id: string, closedIso: string, total: number, qtd = 1, cancel: string | null = null, lojaId = "ML1") =>
  ({ id, date_closed: closedIso, total_amount: total, order_items: [{ quantity: qtd, unit_price: total / qtd }], status: "paid", cancel_detail: cancel ? { code: cancel } : null, _loja: lojaId });

const H = (hhmm: string, dia = "2026-10-07") => { const [h, m] = hhmm.split(":").map(Number); return Date.parse(`${dia}T03:00:00.000Z`) + (h * 60 + m) * 60000; };
const ISO = (ms: number) => new Date(ms).toISOString();
const cred = { access_token: "tk", refresh_token: "rt", token_expires_at: "2030-01-01T00:00:00Z" };
const LOJA = { ML1: "aaaaaaaa-0000-4000-8000-000000000001", ML2: "bbbbbbbb-0000-4000-8000-000000000001", SH1: "aaaaaaaa-0000-4000-8000-000000000002" };
const lojaRow = (id: string, user_id: string, marketplace: "ML" | "Shopee") =>
  ({ id, user_id, marketplace, ativo: true, seller_id: "999", partner_id: marketplace === "Shopee" ? 9 : null, partner_key: marketplace === "Shopee" ? "pk" : null, ...cred });
const jobIntraday = (lojaId: string, userId: string, dia: string, inicioIso: string, alvoIso: string, extra: Linha = {}) => ({
  id: `intra-${lojaId}-${alvoIso}`, user_id: userId, loja_id: lojaId, marketplace: "ML", tipo: "incremental", status: "pendente",
  date_from: dia, date_to: dia, campo_tempo: "date_closed", janela_inicio: inicioIso, janela_fim: alvoIso, listagem_completa: false,
  checkpoint: null, progresso: null, iniciado_em: null, heartbeat_em: null, criado_em: inicioIso, tentativas: 0, max_tentativas: 3, ...extra,
});
const mundo = (): Record<string, Linha[]> => ({ lojas: [lojaRow(LOJA.ML1, "dono-a", "ML"), lojaRow(LOJA.ML2, "dono-b", "ML"), lojaRow(LOJA.SH1, "dono-a", "Shopee")], sync_jobs: [], ml_pedidos: [] });

async function principal() {
  const W = await import("../lib/vendas/sync/worker");
  const R = await import("../lib/mercado-livre/ingestao/persistencia");
  const V = await import("../lib/vendas/canonico/service");
  const P = await import("../lib/vendas/sync/planejamento");
  const { diaEmSaoPaulo } = await import("../lib/fuso-sao-paulo");

  const transporte = (pv: Provedor, lojaMap: Record<string, string>) => ({
    async listarDiaFechado({ lojaId, dia }: { userId: string; lojaId: string; dia: string }) {
      pv.chamadas.push({ lojaId, dia });
      if (pv.erro) return { brutos: [], paginas: 0, completa: false, erro: pv.erro as any };
      const brutos = pv.pedidos.filter((o) => lojaMap[o._loja] === lojaId && !pv.escondidos.has(o.id) && diaEmSaoPaulo(o.date_closed) === dia)
        .map(({ _loja, ...o }) => o);
      return { brutos, paginas: pv.paginas, completa: pv.completa, erro: null };
    },
  });
  const MAPA = { ML1: LOJA.ML1, ML2: LOJA.ML2 };
  const worker = (d: Record<string, Linha[]>, pv: Provedor, agoraMs: number, op: { intraday?: boolean; orcamentoMs?: number } = { intraday: true }) => {
    const cliente = banco(d, () => agoraMs);
    return W.executarWorkerCanonico({ cliente, relogio: { agoraMs: () => agoraMs },
      portasML: async () => ({ transporte: transporte(pv, MAPA), repo: R.criarRepositorioML(cliente) }), portasShopee: async () => null },
      { orcamentoMs: op.orcamentoMs ?? 45_000, habilitado: true, ...(op.intraday === undefined ? {} : { intraday: op.intraday }) });
  };
  const hoje = (d: Record<string, Linha[]>, agoraMs: number, userId = "dono-a") =>
    V.consultarVendasCanonicas({ userId, marketplace: "mercado_livre", preset: "HOJE" }, { cliente: banco(d, () => agoraMs), agoraMs });
  const DIA0 = ISO(H("00:00"));

  console.log("\n[A–C. caminho feliz, zero, paginacao]");
  t("A/O. intraday ML ponta a ponta: so [inicio, T) e gravado; D14 HOJE = PARTIAL_FRESH, observadoAte = T, metricas do prefixo", async () => {
    const d = mundo(); const T = ISO(H("10:30"));
    const pv = provedor([ordem("1", ISO(H("08:00")), 100.1), ordem("2", ISO(H("09:30")), 50.2, 2), ordem("3", ISO(H("10:35")), 999)]);
    d.sync_jobs.push(jobIntraday(LOJA.ML1, "dono-a", "2026-10-07", DIA0, T));
    const r = await worker(d, pv, H("10:40"));
    const j = d.sync_jobs[0];
    assert(r.resultado === "EXECUTADO" && r.fatia === "concluido" && j.status === "concluido" && j.listagem_completa === true, `${JSON.stringify(r)} ${j.status}`);
    assert(d.ml_pedidos.map((p) => p.order_id).sort().join() === "1,2", d.ml_pedidos.map((p) => p.order_id).join());
    assert(pv.chamadas.length === 1 && pv.chamadas[0].dia === "2026-10-07", JSON.stringify(pv.chamadas));
    const v = await hoje(d, H("10:40"));
    assert(v.estado === "PARTIAL_FRESH" && v.parcial && v.observadoAte === T && v.metricas.mercadoLivre!.vendas === 150.3 && v.metricas.mercadoLivre!.unidades === 3, `${v.estado} ${v.observadoAte} ${JSON.stringify(v.metricas.mercadoLivre)}`);
  });
  t("B/P. ZERO vendas observado: job concluido sem linha; D14 = metricas zero, semVendas=true (nunca null)", async () => {
    const d = mundo(); const T = ISO(H("10:30"));
    d.sync_jobs.push(jobIntraday(LOJA.ML1, "dono-a", "2026-10-07", DIA0, T));
    const r = await worker(d, provedor([]), H("10:40"));
    assert(r.fatia === "concluido" && d.sync_jobs[0].listagem_completa === true && d.ml_pedidos.length === 0, JSON.stringify(r));
    const v = await hoje(d, H("10:40"));
    assert(v.estado === "PARTIAL_FRESH" && v.metricas.combinadas!.vendas === 0 && v.metricas.combinadas!.pedidos === 0 && v.metricas.semVendas === true, `${v.estado} ${JSON.stringify(v.metricas)}`);
  });
  t("C. paginacao completa (3 paginas conferidas) → concluido, paginas no progresso", async () => {
    const d = mundo(); d.sync_jobs.push(jobIntraday(LOJA.ML1, "dono-a", "2026-10-07", DIA0, ISO(H("10:30"))));
    const pv = provedor([ordem("1", ISO(H("08:00")), 10)]); pv.paginas = 3;
    const r = await worker(d, pv, H("10:40"));
    assert(r.fatia === "concluido" && d.sync_jobs[0].progresso.paginas === 3, JSON.stringify(d.sync_jobs[0].progresso));
  });

  console.log("\n[D–F. incompleto/teto, pausa, meia-noite]");
  t("D/Q. listagem INCOMPLETA (teto de paginas / total nao conferido): pausa, 3 tentativas → erro; NUNCA concluido; D14 sem observacao", async () => {
    const d = mundo(); d.sync_jobs.push(jobIntraday(LOJA.ML1, "dono-a", "2026-10-07", DIA0, ISO(H("10:30"))));
    const pv = provedor([ordem("1", ISO(H("08:00")), 10)]); pv.completa = false; pv.paginas = 60;
    const estados: string[] = [];
    for (let i = 0; i < 3; i++) { const r = await worker(d, pv, H("10:40") + i * 60000); estados.push(`${r.fatia}:${d.sync_jobs[0].status}`); }
    const j = d.sync_jobs[0];
    assert(estados.join() === "pausado:pendente,pausado:pendente,falhou:erro" && j.listagem_completa === false && d.ml_pedidos.length === 0, estados.join());
    const v = await hoje(d, H("10:45"));
    assert(v.estado === "PARTIAL_SEM_OBSERVACAO_ATUAL" && v.metricas.combinadas === null && v.observadoAte === null, v.estado);
  });
  t("Q2. (D14.1 integrado) T1 ok → T2 falha 3x (erro) → Hoje segue PARTIAL ate T1; T3 ok → avanca para T3", async () => {
    const d = mundo(); const pv = provedor([ordem("1", ISO(H("08:00")), 10)]);
    d.sync_jobs.push(jobIntraday(LOJA.ML1, "dono-a", "2026-10-07", DIA0, ISO(H("10:00"))));
    await worker(d, pv, H("10:05"));
    const v1 = await hoje(d, H("10:06"));
    assert(v1.estado === "PARTIAL_FRESH" && v1.observadoAte === ISO(H("10:00")), `T1 ${v1.estado}`);
    d.sync_jobs.push(jobIntraday(LOJA.ML1, "dono-a", "2026-10-07", DIA0, ISO(H("10:30"))));
    pv.completa = false;
    for (let i = 0; i < 3; i++) await worker(d, pv, H("10:35") + i * 60000);
    assert(d.sync_jobs[1].status === "erro" && d.sync_jobs[1].listagem_completa === false, "T2 deveria terminar em erro");
    const v2 = await hoje(d, H("10:40"));
    assert(v2.estado === "PARTIAL_FRESH" && v2.observadoAte === ISO(H("10:00")) && v2.metricas.mercadoLivre!.vendas === 10, `T2 ${v2.estado} ${v2.observadoAte}`);
    pv.completa = true;
    d.sync_jobs.push(jobIntraday(LOJA.ML1, "dono-a", "2026-10-07", DIA0, ISO(H("11:00"))));
    await worker(d, pv, H("11:05"));
    const v3 = await hoje(d, H("11:06"));
    assert(v3.estado === "PARTIAL_FRESH" && v3.observadoAte === ISO(H("11:00")), `T3 ${v3.estado} ${v3.observadoAte}`);
  });
  t("E. pausa por orcamento: sem tempo → pausado/pendente, sem observacao; proxima fatia conclui", async () => {
    const d = mundo(); d.sync_jobs.push(jobIntraday(LOJA.ML1, "dono-a", "2026-10-07", DIA0, ISO(H("10:30"))));
    const pv = provedor([ordem("1", ISO(H("08:00")), 10)]);
    const r1 = await worker(d, pv, H("10:40"), { intraday: true, orcamentoMs: 5_000 });
    assert(r1.fatia === "pausado" && d.sync_jobs[0].status === "pendente" && d.sync_jobs[0].listagem_completa === false && pv.chamadas.length === 0, `${r1.fatia}`);
    const v1 = await hoje(d, H("10:41"));
    assert(v1.observadoAte === null && v1.metricas.combinadas === null, "observacao de job pausado");
    const r2 = await worker(d, pv, H("10:42"));
    assert(r2.fatia === "concluido" && d.sync_jobs[0].listagem_completa === true, `${r2.fatia}`);
  });
  t("F. retomada DEPOIS da meia-noite: job de 06/10 (T 23:45) pausado 23:58, retomado 07/10 00:02 → relista 06/10 e corta no MESMO T", async () => {
    const d = mundo(); const T = ISO(H("23:45", "2026-10-06"));
    d.sync_jobs.push(jobIntraday(LOJA.ML1, "dono-a", "2026-10-06", ISO(H("00:00", "2026-10-06")), T));
    const pv = provedor([ordem("1", ISO(H("23:00", "2026-10-06")), 10), ordem("2", ISO(H("23:50", "2026-10-06")), 20), ordem("3", ISO(H("00:01", "2026-10-07")), 30)]);
    const r1 = await worker(d, pv, H("23:58", "2026-10-06"), { intraday: true, orcamentoMs: 5_000 });
    assert(r1.fatia === "pausado", `${r1.fatia}`);
    const r2 = await worker(d, pv, H("00:02", "2026-10-07"));
    assert(r2.fatia === "concluido" && pv.chamadas.every((c) => c.dia === "2026-10-06") && d.sync_jobs[0].janela_fim === T, JSON.stringify(pv.chamadas));
    assert(d.ml_pedidos.map((p) => p.order_id).join() === "1", d.ml_pedidos.map((p) => p.order_id).join());
  });

  console.log("\n[G–J. fronteira, replay, indexacao atrasada, reobservacao]");
  t("G. fronteira T: T−1ms entra; T e T+1ms ficam fora ([inicio, T) exclusivo)", async () => {
    const d = mundo(); const Tm = H("10:30"); d.sync_jobs.push(jobIntraday(LOJA.ML1, "dono-a", "2026-10-07", DIA0, ISO(Tm)));
    await worker(d, provedor([ordem("a", ISO(Tm - 1), 1), ordem("b", ISO(Tm), 2), ordem("c", ISO(Tm + 1), 3)]), H("10:40"));
    assert(d.ml_pedidos.map((p) => p.order_id).join() === "a", d.ml_pedidos.map((p) => p.order_id).join());
  });
  t("H. replay do MESMO T: nenhuma duplicata, metricas iguais (uma vez por pedido)", async () => {
    const d = mundo(); const T = ISO(H("10:30"));
    const pv = provedor([ordem("1", ISO(H("08:00")), 100.1), ordem("2", ISO(H("09:30")), 50.2)]);
    d.sync_jobs.push(jobIntraday(LOJA.ML1, "dono-a", "2026-10-07", DIA0, T));
    await worker(d, pv, H("10:40"));
    const v1 = await hoje(d, H("10:41"));
    d.sync_jobs.push(jobIntraday(LOJA.ML1, "dono-a", "2026-10-07", DIA0, T, { id: "replay" }));
    await worker(d, pv, H("10:42"));
    const v2 = await hoje(d, H("10:43"));
    assert(d.ml_pedidos.length === 2 && v1.metricas.mercadoLivre!.vendas === 150.3 && v2.metricas.mercadoLivre!.vendas === 150.3 && v2.metricas.mercadoLivre!.pedidos === 2, `${d.ml_pedidos.length} ${JSON.stringify(v2.metricas.mercadoLivre)}`);
  });
  t("I. pedido INDEXADO ATRASADO (fechado 10:05; ausente em T=10:15; presente em T=10:45) → recuperado, sem lookback arbitrario", async () => {
    const d = mundo();
    const pv = provedor([ordem("1", ISO(H("08:00")), 10), ordem("X", ISO(H("10:05")), 5)]); pv.escondidos.add("X");
    d.sync_jobs.push(jobIntraday(LOJA.ML1, "dono-a", "2026-10-07", DIA0, ISO(H("10:15"))));
    await worker(d, pv, H("10:20"));
    const v1 = await hoje(d, H("10:21"));
    assert(v1.metricas.mercadoLivre!.vendas === 10 && v1.observadoAte === ISO(H("10:15")), JSON.stringify(v1.metricas.mercadoLivre));
    pv.escondidos.clear();
    d.sync_jobs.push(jobIntraday(LOJA.ML1, "dono-a", "2026-10-07", DIA0, ISO(H("10:45"))));
    await worker(d, pv, H("10:50"));
    const v2 = await hoje(d, H("10:51"));
    assert(v2.estado === "PARTIAL_FRESH" && v2.metricas.mercadoLivre!.vendas === 15 && v2.observadoAte === ISO(H("10:45")), `${v2.estado} ${JSON.stringify(v2.metricas.mercadoLivre)}`);
  });
  t("J. pedido antigo do dia e REOBSERVADO: fetched_at avanca para a nova observacao (check B do D14 em T2)", async () => {
    const d = mundo(); const pv = provedor([ordem("1", ISO(H("08:00")), 10)]);
    d.sync_jobs.push(jobIntraday(LOJA.ML1, "dono-a", "2026-10-07", DIA0, ISO(H("10:00"))));
    await worker(d, pv, H("10:05"));
    const f1 = d.ml_pedidos[0].fetched_at;
    d.sync_jobs.push(jobIntraday(LOJA.ML1, "dono-a", "2026-10-07", DIA0, ISO(H("10:30"))));
    await worker(d, pv, H("10:35"));
    const f2 = d.ml_pedidos[0].fetched_at;
    assert(f1 === ISO(H("10:05")) && f2 === ISO(H("10:35")) && Date.parse(f2) >= H("10:30"), `${f1} ${f2}`);
    const v = await hoje(d, H("10:36"));
    assert(v.estado === "PARTIAL_FRESH" && v.observadoAte === ISO(H("10:30")), v.estado);
  });

  console.log("\n[K–N. caminho normal, travas, cobertura fechada]");
  t("K. job NORMAL de fechamento (dia inteiro, backfill) segue o motor antigo: dia todo gravado, sem corte", async () => {
    for (const intraday of [false, true]) {
      const d = mundo(); const pv = provedor([ordem("1", ISO(H("08:00", "2026-10-06")), 10), ordem("2", ISO(H("23:59", "2026-10-06")), 20)]);
      d.sync_jobs.push({ ...jobIntraday(LOJA.ML1, "dono-a", "2026-10-06", ISO(H("00:00", "2026-10-06")), ISO(H("00:00", "2026-10-07"))), id: "fech", tipo: "backfill" });
      const r = await worker(d, pv, H("01:00"), { intraday });
      assert(r.fatia === "concluido" && d.ml_pedidos.length === 2 && d.sync_jobs[0].listagem_completa === true, `intraday=${intraday} ${JSON.stringify(r)}`);
    }
  });
  t("L. intraday LIGADO (padrao de producao, sem opcao): worker despacha ao motor ML intraday (corte local date_closed < T)", async () => {
    const d = mundo(); const pv = provedor([ordem("1", ISO(H("08:00")), 10), ordem("2", ISO(H("10:35")), 20)]);
    d.sync_jobs.push(jobIntraday(LOJA.ML1, "dono-a", "2026-10-07", DIA0, ISO(H("10:30"))));
    const r = await worker(d, pv, H("10:40"), {});
    // so o motor intraday corta em T: o motor normal gravaria o dia inteiro (2 pedidos)
    assert(r.fatia === "concluido" && pv.chamadas.length > 0 && d.ml_pedidos.length === 1 && d.ml_pedidos[0].order_id === "1" && d.sync_jobs[0].listagem_completa === true, JSON.stringify(r));
  });
  t("L2. intraday DESLIGADO explicito (intraday:false): worker recusa ANTES do provedor", async () => {
    const d = mundo(); const pv = provedor([ordem("1", ISO(H("08:00")), 10)]);
    d.sync_jobs.push(jobIntraday(LOJA.ML1, "dono-a", "2026-10-07", DIA0, ISO(H("10:30"))));
    const r = await worker(d, pv, H("10:40"), { intraday: false });
    assert(r.resultado === "RECUSADO" && (r as any).motivo === "intraday_sem_motor" && pv.chamadas.length === 0 && d.ml_pedidos.length === 0, JSON.stringify(r));
  });
  // D15D: Shopee intraday passou a ter motor proprio — o invariante e que ele NUNCA cai no motor/provedor ML
  t("M. Shopee intraday nunca cai no motor ML (vai ao caminho Shopee; sem credencial Shopee → recusa de auth)", async () => {
    const d = mundo(); const pv = provedor([ordem("1", ISO(H("08:00")), 10)]);
    d.sync_jobs.push({ ...jobIntraday(LOJA.SH1, "dono-a", "2026-10-07", DIA0, ISO(H("10:30"))), marketplace: "Shopee", campo_tempo: "create_time" });
    const r = await worker(d, pv, H("10:40"));
    assert(r.resultado === "RECUSADO" && (r as any).motivo === "credencial_indisponivel" && pv.chamadas.length === 0 && d.ml_pedidos.length === 0, JSON.stringify(r));
  });
  t("N. intraday concluido (mesmo cobrindo o dia inteiro) NAO e cobertura fechada do planner", async () => {
    const d = mundo(); const pv = provedor([ordem("1", ISO(H("08:00", "2026-10-06")), 10)]);
    d.sync_jobs.push(jobIntraday(LOJA.ML1, "dono-a", "2026-10-06", ISO(H("00:00", "2026-10-06")), ISO(H("00:00", "2026-10-07"))));
    const r = await worker(d, pv, H("00:05"));
    assert(r.fatia === "concluido", JSON.stringify(r));
    const j = d.sync_jobs[0];
    const a = P.avaliarLoja({ loja: { id: LOJA.ML1, marketplace: "ML" }, de: "2026-10-06", ate: "2026-10-06", agoraMs: H("00:10"), politica: P.POLITICA_SYNC_PROPOSTA, origem: "background",
      jobs: [{ id: j.id, lojaId: j.loja_id, marketplace: j.marketplace, campoTempo: j.campo_tempo, janelaInicio: j.janela_inicio, janelaFim: j.janela_fim, status: j.status,
        listagemCompleta: j.listagem_completa, concluidoEm: j.concluido_em, criadoEm: j.criado_em, tipo: j.tipo, dateFrom: j.date_from, dateTo: j.date_to }] });
    assert(a.cobertura === "PARTIAL" && a.necessidades.some((n) => n.tipo === "discovery"), a.cobertura);
  });

  console.log("\n[R–S. dono, fuso]");
  t("R. dono/loja isolados: mesmo seller em outro dono → linhas e D14 independentes", async () => {
    const d = mundo(); const T = ISO(H("10:30"));
    const pv = provedor([ordem("1", ISO(H("08:00")), 10, 1, null, "ML1"), ordem("1", ISO(H("08:00")), 7000, 1, null, "ML2")]);
    d.sync_jobs.push(jobIntraday(LOJA.ML1, "dono-a", "2026-10-07", DIA0, T));
    await worker(d, pv, H("10:40"));
    d.sync_jobs.push(jobIntraday(LOJA.ML2, "dono-b", "2026-10-07", DIA0, T));
    await worker(d, pv, H("10:41"));
    assert(d.ml_pedidos.length === 2 && d.ml_pedidos.every((p) => (p.loja_id === LOJA.ML1 ? p.user_id === "dono-a" : p.user_id === "dono-b")), JSON.stringify(d.ml_pedidos.map((p) => [p.loja_id, p.user_id])));
    const a = await hoje(d, H("10:42"), "dono-a"), b = await hoje(d, H("10:42"), "dono-b");
    assert(a.metricas.mercadoLivre!.vendas === 10 && b.metricas.mercadoLivre!.vendas === 7000, `${JSON.stringify(a.metricas.mercadoLivre)} ${JSON.stringify(b.metricas.mercadoLivre)}`);
  });
  t("S. dia civil pelo offset REAL (15/01/2019, horario de verao): 00:30 local (02:30Z) entra; 23:59 do dia anterior (01:59Z) fica fora", async () => {
    const d = mundo();
    d.sync_jobs.push(jobIntraday(LOJA.ML1, "dono-a", "2019-01-15", "2019-01-15T02:00:00.000Z", "2019-01-15T13:00:00.000Z"));
    const pv = provedor([ordem("dentro", "2019-01-15T02:30:00.000Z", 10), ordem("vespera", "2019-01-15T01:59:00.000Z", 20)]);
    const r = await worker(d, pv, Date.parse("2019-01-15T13:10:00.000Z"));
    assert(r.fatia === "concluido" && d.ml_pedidos.map((p) => p.order_id).join() === "dentro" && pv.chamadas[0].dia === "2019-01-15", `${JSON.stringify(r)} ${d.ml_pedidos.map((p) => p.order_id)}`);
  });
  t("S2. alvo no FUTURO (relogio antes de T) falha fechado — observar o futuro nao prova nada", async () => {
    const d = mundo(); d.sync_jobs.push(jobIntraday(LOJA.ML1, "dono-a", "2026-10-07", DIA0, ISO(H("10:30"))));
    const pv = provedor([ordem("1", ISO(H("08:00")), 10)]);
    const r = await worker(d, pv, H("10:20"));
    assert(r.fatia === "falhou" && d.sync_jobs[0].status === "erro" && pv.chamadas.length === 0, JSON.stringify(r));
  });

  console.log("\n[regra canonica preservada]");
  t("PS. pack_splitted e gravado no corpus mas NAO conta (regra do leitor, intocada)", async () => {
    const d = mundo(); d.sync_jobs.push(jobIntraday(LOJA.ML1, "dono-a", "2026-10-07", DIA0, ISO(H("10:30"))));
    await worker(d, provedor([ordem("1", ISO(H("08:00")), 10), ordem("2", ISO(H("09:00")), 777.77, 1, "pack_splitted")]), H("10:40"));
    const v = await hoje(d, H("10:41"));
    assert(d.ml_pedidos.length === 2 && v.metricas.mercadoLivre!.vendas === 10 && v.metricas.mercadoLivre!.pedidos === 1, JSON.stringify(v.metricas.mercadoLivre));
  });
  t("RO. nenhuma rede", () => assert(fetches === 0, `fetch=${fetches}`));

  await fila;
  console.log(`\n${falhou === 0 ? "✓" : "✗"} ML-INTRADAY — ${passou} passaram, ${falhou} falharam`);
  process.exit(falhou === 0 ? 0 : 1);
}
principal().catch((e) => { console.error("ERRO FATAL", e); process.exit(1); });
