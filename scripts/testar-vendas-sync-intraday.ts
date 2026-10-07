/**
 * SALES-SYNC-D15B — planejamento INTRADAY do dia corrente (offline).
 *
 * Sem rede, sem banco: planner puro + tick/coordenador/worker contra um duplo
 * em memoria de `sync_jobs`/`lojas` (com o indice de 1 job ativo por loja).
 * Nenhum motor e executado: o worker RECUSA intraday ate D15C/D15D.
 *
 * Uso: npx tsx scripts/testar-vendas-sync-intraday.ts
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

// ── duplo em memoria (select/insert/update com filtros; 23505 no indice de 1 ativo por loja) ──
type Linha = Record<string, any>;
let seq = 0; // ids unicos entre ticks (cada tick monta um cliente novo sobre os MESMOS dados)
function banco(dados: Record<string, Linha[]>, relogio: () => number) {
  const valor = (l: Linha, col: string) => (col.includes("->>") ? l[col.split("->>")[0]]?.[col.split("->>")[1]] : l[col]);
  const cmp = (x: any, v: any, f: (a: any, b: any) => boolean) => x !== null && x !== undefined && f(x, v);
  const cliente: any = {
    from(tabela: string) {
      const filtros: [string, string, any][] = []; let op: "select" | "update" | "insert" = "select"; let patch: Linha | null = null; let novo: Linha | null = null;
      let head = false, limite = Infinity, unico: "single" | "maybe" | null = null;
      const casa = (l: Linha) => filtros.every(([o, c, v]) => {
        const x = valor(l, c);
        if (o === "eq") return String(x) === String(v);
        if (o === "in") return (v as any[]).map(String).includes(String(x));
        if (o === "gte") return cmp(x, v, (a, b) => a >= b);
        if (o === "gt") return cmp(x, v, (a, b) => a > b);
        if (o === "lt") return cmp(x, v, (a, b) => a < b);
        if (o === "is") return (x ?? null) === v;
        if (o === "not") return (x ?? null) !== v[1];
        return true;
      });
      const executar = (): { data: any; error: any; count?: number } => {
        const tab = (dados[tabela] ??= []);
        if (op === "insert") {
          const r = { ...novo! };
          if (tabela === "sync_jobs" && ["pendente", "rodando"].includes(r.status) && tab.some((j) => j.loja_id === r.loja_id && ["pendente", "rodando"].includes(j.status))) {
            return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint \"idx_sync_jobs_loja_ativo\"" } };
          }
          r.id = r.id ?? `job-${++seq}`; r.criado_em = r.criado_em ?? new Date(relogio()).toISOString(); r.tentativas = r.tentativas ?? 0; r.max_tentativas = r.max_tentativas ?? 3;
          tab.push(r);
          return { data: unico ? { id: r.id } : [{ id: r.id }], error: null };
        }
        const linhas = tab.filter(casa);
        if (op === "update") { for (const l of linhas) Object.assign(l, patch); return { data: linhas.map((l) => ({ id: l.id })), error: null }; }
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
        if (p === "insert") return (r: Linha) => { op = "insert"; novo = r; return c; };
        if (p === "update") return (r: Linha) => { op = "update"; patch = r; return c; };
        if (p === "single") return () => { unico = "single"; return c; };
        if (p === "maybeSingle") return () => { unico = "maybe"; return c; };
        if (p === "limit") return (n: number) => { limite = n; return c; };
        if (p === "not") return (col: string, o: string, v: any) => { filtros.push(["not", col, [o, v]]); return c; };
        if (["eq", "in", "gte", "gt", "lt", "is"].includes(p)) return (col: string, v: any) => { filtros.push([p, col, v]); return c; };
        return () => c; // order, etc.
      } });
      return c;
    },
  };
  return cliente;
}

// ── mundo: hoje 07/10/2026 (SP) ──
const H = (hhmm: string, dia = "2026-10-07") => { const [h, m] = hhmm.split(":").map(Number); return Date.parse(`${dia}T03:00:00.000Z`) + (h * 60 + m) * 60000; };
const ISO = (ms: number) => new Date(ms).toISOString();
const DIA0 = "2026-10-07T03:00:00.000Z";
const cred = { access_token: "tk", refresh_token: "rt", token_expires_at: "2030-01-01T00:00:00Z" };
const lojaRow = (id: string, user_id: string, marketplace: "ML" | "Shopee", seller_id = "111", extra: Linha = {}) =>
  ({ id, user_id, marketplace, ativo: true, seller_id, partner_id: marketplace === "Shopee" ? 9 : null, partner_key: marketplace === "Shopee" ? "pk" : null, ...cred, ...extra });
/** Cobertura FECHADA completa e fresca desde 01/12/2025 (manutencao e bootstrap sem necessidade). */
const fechadoCompleto = (loja_id: string, user_id: string, marketplace: "ML" | "Shopee", concl: string) => ({
  id: `fechado-${loja_id}`, user_id, loja_id, marketplace, tipo: "backfill", status: "concluido", listagem_completa: true, concluido_em: concl, criado_em: concl,
  campo_tempo: marketplace === "ML" ? "date_closed" : "create_time", janela_inicio: "2025-12-01T03:00:00.000Z", janela_fim: DIA0,
  date_from: "2025-12-01", date_to: "2026-10-06",
});
const intradayRow = (loja_id: string, user_id: string, marketplace: "ML" | "Shopee", inicio: string, fim: string, status = "concluido", extra: Linha = {}) => ({
  id: `intra-${loja_id}-${fim}`, user_id, loja_id, marketplace, tipo: "incremental", status, listagem_completa: status === "concluido",
  concluido_em: status === "pendente" ? null : fim, criado_em: inicio, campo_tempo: marketplace === "ML" ? "date_closed" : "create_time",
  janela_inicio: inicio, janela_fim: fim, date_from: "2026-10-07", date_to: "2026-10-07", ...extra,
});
const L = { ML_A: "11111111-0000-4000-8000-000000000001", SH_A: "11111111-0000-4000-8000-000000000002", ML_B: "22222222-0000-4000-8000-000000000001", SH_B: "22222222-0000-4000-8000-000000000002" };

async function principal() {
  const I = await import("../lib/vendas/sync/intraday");
  const P = await import("../lib/vendas/sync/planejamento");
  const T = await import("../lib/vendas/sync/coordenador-tick");
  const W = await import("../lib/vendas/sync/worker");
  const ML = await import("../lib/vendas/canonico/ml");
  const SH = await import("../lib/vendas/canonico/shopee");
  const pol = P.POLITICA_SYNC_PROPOSTA;
  const jobEx = (r: Linha) => ({ id: r.id, lojaId: r.loja_id, marketplace: r.marketplace, campoTempo: r.campo_tempo ?? null, janelaInicio: r.janela_inicio ?? null,
    janelaFim: r.janela_fim ?? null, status: r.status, listagemCompleta: r.listagem_completa ?? null, concluidoEm: r.concluido_em ?? null, criadoEm: r.criado_em,
    catchup: r.campo_tempo == null && r.janela_inicio == null && r.checkpoint?.modo === "escrow_catchup", tipo: r.tipo ?? null, dateFrom: r.date_from ?? null, dateTo: r.date_to ?? null });
  const intra = (loja: { id: string; marketplace: "ML" | "Shopee" }, agoraMs: number, linhas: Linha[]) => P.avaliarIntradayLoja({ loja, agoraMs, jobs: linhas.map(jobEx), politica: pol });
  const tick = async (dados: Record<string, Linha[]>, agoraMs: number, intraday?: boolean) => {
    const cliente = banco(dados, () => agoraMs);
    return T.executarTickCoordenador(() => ({ cliente, relogio: { agoraMs: () => agoraMs }, log: () => {}, ...(intraday === undefined ? {} : { intraday }) }), { orcamentoMs: 60_000, habilitado: true });
  };
  const mundo = (lojas: Linha[]): Record<string, Linha[]> => ({ lojas, sync_jobs: lojas.map((l) => fechadoCompleto(l.id, l.user_id, l.marketplace, ISO(H("09:00")))), shopee_pedidos: [] });
  const intradayCriados = (d: Record<string, Linha[]>) => d.sync_jobs.filter((j) => j.tipo === "incremental" && j.janela_inicio);

  console.log("\n[classificador e modelo]");
  t("J. 'incremental' SEM janela (catch-up de escrow) NAO e intraday; backfill do mesmo dia tambem nao; janela de 2 dias tambem nao", () => {
    const catchup = { tipo: "incremental", campoTempo: null, janelaInicio: null, janelaFim: null, dateFrom: "2026-10-07", dateTo: "2026-10-07" };
    assert(!I.ehJobIntraday(catchup), "catch-up");
    assert(I.ehJobIntraday({ tipo: "incremental", campoTempo: "date_closed", janelaInicio: DIA0, janelaFim: ISO(H("10:00")), dateFrom: "2026-10-07", dateTo: "2026-10-07" }), "intraday");
    assert(!I.ehJobIntraday({ tipo: "backfill", campoTempo: "date_closed", janelaInicio: DIA0, janelaFim: ISO(H("10:00")), dateFrom: "2026-10-07", dateTo: "2026-10-07" }), "backfill");
    assert(!I.ehJobIntraday({ tipo: "incremental", campoTempo: "create_time", janelaInicio: ISO(H("23:00", "2026-10-06")), janelaFim: ISO(H("10:00")), dateFrom: "2026-10-07", dateTo: "2026-10-07" }), "comeca no dia anterior");
    assert(!I.ehJobIntraday({ tipo: "incremental", campoTempo: "update_time", janelaInicio: DIA0, janelaFim: ISO(H("10:00")), dateFrom: "2026-10-07", dateTo: "2026-10-07" }), "update_time");
  });
  t("S. dia civil pelo offset REAL (sem -3h fixo): 15/01/2019 (horario de verao) comeca 02:00Z", () => {
    const d = I.limitesDoDiaMs("2019-01-15")!;
    assert(ISO(d.inicio) === "2019-01-15T02:00:00.000Z" && ISO(d.fim) === "2019-01-16T02:00:00.000Z", `${ISO(d.inicio)}`);
    assert(I.ehJobIntraday({ tipo: "incremental", campoTempo: "date_closed", janelaInicio: "2019-01-15T02:00:00.000Z", janelaFim: "2019-01-15T13:00:00.000Z", dateFrom: "2019-01-15", dateTo: "2019-01-15" }), "dia DST");
    assert(!I.ehJobIntraday({ tipo: "incremental", campoTempo: "date_closed", janelaInicio: "2019-01-15T01:30:00.000Z", janelaFim: "2019-01-15T13:00:00.000Z", dateFrom: "2019-01-15", dateTo: "2019-01-15" }), "antes do dia");
  });
  t("H. ML intraday: date_closed, [inicio do dia, T], de = ate = hoje, proposito intraday", () => {
    const r = intra({ id: L.ML_A, marketplace: "ML" }, H("10:07"), []);
    const j = r.avaliacao.necessidades[0].job;
    assert(r.estado === "NEED_INTRADAY" && j.campoTempo === "date_closed" && j.inicio === DIA0 && j.fim === ISO(H("10:00")) && j.de === "2026-10-07" && j.ate === "2026-10-07" && j.proposito === "intraday", JSON.stringify(j));
  });
  t("I. Shopee intraday: create_time incremental [ultimo T concluido, T] (pay_time continua a data de negocio — REDETAIL no D15D)", () => {
    const r0 = intra({ id: L.SH_A, marketplace: "Shopee" }, H("10:07"), []);
    assert(r0.avaliacao.necessidades[0].job.campoTempo === "create_time" && r0.avaliacao.necessidades[0].job.inicio === DIA0, "primeira do dia");
    const r = intra({ id: L.SH_A, marketplace: "Shopee" }, H("10:31"), [intradayRow(L.SH_A, "a", "Shopee", DIA0, ISO(H("10:00")))]);
    const j = r.avaliacao.necessidades[0].job;
    assert(j.campoTempo === "create_time" && j.inicio === ISO(H("10:00")) && j.fim === ISO(H("10:30")), JSON.stringify(j));
  });
  t("R. identidade deterministica na grade de 15 min: 10:31 e 10:44 → o MESMO T 10:30 e a MESMA chave", () => {
    const a = intra({ id: L.ML_A, marketplace: "ML" }, H("10:31"), []).avaliacao.necessidades[0].job;
    const b = intra({ id: L.ML_A, marketplace: "ML" }, H("10:44"), []).avaliacao.necessidades[0].job;
    assert(a.chave === b.chave && a.fim === ISO(H("10:30")), `${a.chave} / ${b.chave}`);
    assert(a.chave === `ML|${L.ML_A}|date_closed|${DIA0}|${ISO(H("10:30"))}|intraday`, a.chave);
  });

  console.log("\n[cadencia, dedup, fila]");
  t("A. 10:00 concluido → tick de 10:15 = WAIT_INTRADAY_CADENCE (nenhuma necessidade)", () => {
    const r = intra({ id: L.ML_A, marketplace: "ML" }, H("10:15"), [intradayRow(L.ML_A, "a", "ML", DIA0, ISO(H("10:00")))]);
    assert(r.estado === "WAIT_INTRADAY_CADENCE" && r.avaliacao.necessidades.length === 0 && r.avaliacao.proximaAcao.acao === "NOOP", r.estado);
  });
  t("B. 10:00 concluido → tick de 10:30 = NEED_INTRADAY ate 10:30", () => {
    const r = intra({ id: L.ML_A, marketplace: "ML" }, H("10:30"), [intradayRow(L.ML_A, "a", "ML", DIA0, ISO(H("10:00")))]);
    assert(r.estado === "NEED_INTRADAY" && r.avaliacao.proximaAcao.acao === "CREATE_REFRESH_JOB" && r.avaliacao.necessidades[0].job.fim === ISO(H("10:30")), r.estado);
  });
  t("C. mesmo T ja concluido → INTRADAY_ALREADY_AT_TARGET (NOOP)", () => {
    const r = intra({ id: L.ML_A, marketplace: "ML" }, H("10:05"), [intradayRow(L.ML_A, "a", "ML", DIA0, ISO(H("10:00")))]);
    assert(r.estado === "INTRADAY_ALREADY_AT_TARGET" && r.avaliacao.proximaAcao.acao === "NOOP", r.estado);
  });
  t("D. job ativo da loja (backfill) → WAIT_ACTIVE_JOB, sem preempcao", () => {
    const ativo = { ...fechadoCompleto(L.ML_A, "a", "ML", ISO(H("09:00"))), id: "ativo", status: "rodando" };
    const r = intra({ id: L.ML_A, marketplace: "ML" }, H("10:30"), [ativo]);
    assert(r.estado === "WAIT_ACTIVE_JOB" && r.avaliacao.proximaAcao.acao === "WAIT_ACTIVE_JOB", `${r.estado} ${r.avaliacao.proximaAcao.acao}`);
  });
  t("M. observacao com ZERO linhas tambem conta: so o job concluido importa (cadencia respeitada sem nenhum pedido)", async () => {
    const d = mundo([lojaRow(L.ML_A, "a", "ML")]);
    d.sync_jobs.push(intradayRow(L.ML_A, "a", "ML", DIA0, ISO(H("10:00"))));
    const r = await tick(d, H("10:15"), true);
    assert(r.resultados[0].intraday === "WAIT_INTRADAY_CADENCE" && intradayCriados(d).length === 1 && !("ml_pedidos" in d), JSON.stringify(r.resultados[0]));
  });
  t("N. falha: 1 erro 10:20 → WAIT_RETRY ate 10:50 (sem spam); 3 erros/24h → FAILED", () => {
    const e1 = intradayRow(L.ML_A, "a", "ML", DIA0, ISO(H("10:15")), "erro", { concluido_em: ISO(H("10:20")) });
    const r = intra({ id: L.ML_A, marketplace: "ML" }, H("10:30"), [e1]);
    assert(r.estado === "WAIT_RETRY" && r.avaliacao.proximaAcao.acao === "WAIT_RETRY" && (r.avaliacao.proximaAcao as any).ate === ISO(H("10:50")), `${r.estado} ${JSON.stringify(r.avaliacao.proximaAcao)}`);
    const tres = ["08:00", "09:00", "10:00"].map((h) => intradayRow(L.ML_A, "a", "ML", DIA0, ISO(H(h)), "erro", { id: `e-${h}`, concluido_em: ISO(H(h)) }));
    const f = intra({ id: L.ML_A, marketplace: "ML" }, H("10:45"), tres);
    assert(f.estado === "FAILED" && f.avaliacao.proximaAcao.acao === "FAILED", f.estado);
  });
  t("S2. 00:00–00:14 → INTRADAY_SEM_ALVO (janela vazia nunca vira job)", () => {
    const r = intra({ id: L.ML_A, marketplace: "ML" }, H("00:10"), []);
    assert(r.estado === "INTRADAY_SEM_ALVO" && r.avaliacao.necessidades.length === 0, r.estado);
  });

  console.log("\n[cobertura fechada x intraday; meia-noite]");
  t("K. intraday concluido NAO e cobertura fechada: avaliar 06/10 so com intraday de 06/10 → PARTIAL (ML e Shopee)", () => {
    const agora = H("00:20"); // 07/10 00:20
    const ml = intradayRow(L.ML_A, "a", "ML", "2026-10-06T03:00:00.000Z", ISO(H("23:45", "2026-10-06")), "concluido", { date_from: "2026-10-06", date_to: "2026-10-06" });
    const a = P.avaliarLoja({ loja: { id: L.ML_A, marketplace: "ML" }, de: "2026-10-06", ate: "2026-10-06", agoraMs: agora, jobs: [ml].map(jobEx), politica: pol, origem: "background" });
    assert(a.cobertura === "PARTIAL" && a.necessidades.some((n) => n.tipo === "discovery"), `${a.cobertura} ${JSON.stringify(a.motivos)}`);
  });
  t("K2. ML: mesmo um intraday que alcanca 00:00 do dia seguinte (dia inteiro) NAO vira cobertura fechada", () => {
    const cheio = intradayRow(L.ML_A, "a", "ML", "2026-10-06T03:00:00.000Z", DIA0, "concluido", { date_from: "2026-10-06", date_to: "2026-10-06", concluido_em: ISO(H("23:59", "2026-10-06")) });
    assert(I.ehJobIntraday(jobEx(cheio)), "classificador");
    const a = P.avaliarLoja({ loja: { id: L.ML_A, marketplace: "ML" }, de: "2026-10-06", ate: "2026-10-06", agoraMs: H("00:20"), jobs: [cheio].map(jobEx), politica: pol, origem: "background" });
    assert(a.cobertura === "PARTIAL" && a.necessidades.some((n) => n.tipo === "discovery"), a.cobertura);
  });
  t("L. meia-noite: fechado ate 06/10 00:00 + intraday 06/10 ate 23:45 → em 07/10 o fechamento de 06/10 relista o DIA INTEIRO; depois dele, COMPLETE", () => {
    const agora = H("00:20");
    const base = { ...fechadoCompleto(L.SH_A, "a", "Shopee", ISO(H("23:00", "2026-10-05"))), janela_fim: "2026-10-06T03:00:00.000Z", date_to: "2026-10-05" };
    const intr = intradayRow(L.SH_A, "a", "Shopee", "2026-10-06T03:00:00.000Z", ISO(H("23:45", "2026-10-06")), "concluido", { date_from: "2026-10-06", date_to: "2026-10-06" });
    const av = P.avaliarLoja({ loja: { id: L.SH_A, marketplace: "Shopee" }, de: "2026-10-06", ate: "2026-10-06", agoraMs: agora, jobs: [base, intr].map(jobEx), politica: pol, origem: "background",
      sinaisShopee: { escrowPendentes: 0, naoObservadosAposPeriodo: 0 } });
    const desc = av.necessidades.filter((n) => n.tipo === "discovery").map((n) => n.job);
    assert(av.cobertura === "PARTIAL" && desc.length && desc[0].inicio === "2026-10-06T03:00:00.000Z" && desc[desc.length - 1].fim === DIA0, JSON.stringify(desc.map((j) => [j.inicio, j.fim])));
    const fechamento = { ...base, id: "fech-06", janela_inicio: "2026-10-06T03:00:00.000Z", janela_fim: DIA0, concluido_em: ISO(H("00:15")), date_from: "2026-10-06", date_to: "2026-10-06" };
    const depois = P.avaliarLoja({ loja: { id: L.SH_A, marketplace: "Shopee" }, de: "2026-10-06", ate: "2026-10-06", agoraMs: agora, jobs: [base, intr, fechamento].map(jobEx), politica: pol, origem: "background",
      sinaisShopee: { escrowPendentes: 0, naoObservadosAposPeriodo: 0 } });
    assert(depois.cobertura === "COMPLETE", `${depois.cobertura} ${JSON.stringify(depois.motivos)}`);
  });
  t("T. compatibilidade D14: intraday concluido alcanca T na cadeia dos LEITORES (ML [dia, T]; Shopee fechado + intraday)", () => {
    const fim = ISO(H("10:30"));
    const alcML = ML.alcanceFechamentoML([{ campoTempo: "date_closed", inicio: DIA0, fim, listagemCompleta: true, status: "concluido" }], Date.parse(DIA0));
    assert(alcML === Date.parse(fim), `ML ${alcML}`);
    const janelasSH = [{ lojaId: L.SH_A, campoTempo: "create_time" as const, inicio: "2025-12-01T03:00:00.000Z", fim: DIA0, listagemCompleta: true, status: "concluido" },
      { lojaId: L.SH_A, campoTempo: "create_time" as const, inicio: DIA0, fim, listagemCompleta: true, status: "concluido" }];
    const alcSH = SH.alcanceDescobertaCriacao(janelasSH, Date.parse(DIA0) - SH.LIMITE_POLITICA_PAGAMENTO_MS);
    assert(alcSH === Date.parse(fim), `Shopee ${alcSH}`);
  });

  console.log("\n[tick: elegibilidade, donos, taxa, interleave, producao]");
  t("P. PRODUCAO (sem opcao): intraday DESLIGADO — nenhum job intraday, nenhum estado intraday", async () => {
    assert(I.INTRADAY_CANONICO_HABILITADO === false, "constante ligada");
    const d = mundo([lojaRow(L.ML_A, "a", "ML"), lojaRow(L.SH_A, "a", "Shopee")]);
    const r = await tick(d, H("10:30"));
    assert(intradayCriados(d).length === 0 && r.resultados.every((x) => x.intraday === undefined), JSON.stringify(r.resultados));
  });
  t("E. loja inelegivel (credencial morta) → SKIP, nenhum intraday", async () => {
    const d = mundo([lojaRow(L.ML_A, "a", "ML", "111", { refresh_token: null, token_expires_at: "2026-01-01T00:00:00Z" })]);
    const r = await tick(d, H("10:30"), true);
    assert(r.resultados[0].acao === "SKIP_CREDENTIAL_UNUSABLE" && intradayCriados(d).length === 0, JSON.stringify(r.resultados[0]));
  });
  t("F. dois donos com o MESMO seller_id: jobs independentes, cada um com o proprio dono; a observacao de um nao vale para o outro", async () => {
    const d = mundo([lojaRow(L.ML_A, "dono-a", "ML", "999"), lojaRow(L.ML_B, "dono-b", "ML", "999")]);
    d.sync_jobs.push(intradayRow(L.ML_A, "dono-a", "ML", DIA0, ISO(H("10:00"))));
    const r = await tick(d, H("10:15"), true);
    const porLoja = Object.fromEntries(r.resultados.map((x) => [x.lojaId, x.intraday]));
    assert(porLoja[L.ML_A] === "WAIT_INTRADAY_CADENCE" && porLoja[L.ML_B] === "NEED_INTRADAY", JSON.stringify(porLoja));
    const novo = intradayCriados(d).find((j) => j.loja_id === L.ML_B)!;
    assert(novo && novo.user_id === "dono-b" && novo.tipo === "incremental" && novo.campo_tempo === "date_closed" && novo.date_from === "2026-10-07", JSON.stringify(novo));
  });
  t("F2. planner: a observacao intraday de OUTRA loja (outro dono, mesmo seller) nunca satisfaz a cadencia desta", () => {
    const outra = intradayRow(L.ML_A, "dono-a", "ML", DIA0, ISO(H("10:00")));
    const r = intra({ id: L.ML_B, marketplace: "ML" }, H("10:15"), [outra]);
    assert(r.estado === "NEED_INTRADAY" && r.avaliacao.necessidades[0].job.lojaId === L.ML_B, r.estado);
  });
  t("G. 4 lojas elegiveis, ticks a cada 15 min por 1h, jobs concluindo na hora → no maximo 8 intraday criados/hora", async () => {
    const d = mundo([lojaRow(L.ML_A, "a", "ML"), lojaRow(L.SH_A, "a", "Shopee"), lojaRow(L.ML_B, "b", "ML", "222"), lojaRow(L.SH_B, "b", "Shopee", "333")]);
    for (const h of ["10:00", "10:15", "10:30", "10:45"]) {
      await tick(d, H(h), true);
      for (const j of d.sync_jobs) if (j.status === "pendente") Object.assign(j, { status: "concluido", listagem_completa: true, concluido_em: ISO(H(h) + 60000) });
    }
    const n = intradayCriados(d).length;
    assert(n === 8, `criados=${n}`);
  });
  t("O. interleave: intraday vencido sai ANTES do historico; no tick de cadencia o historico (backfill) recebe a vez", async () => {
    const d = mundo([lojaRow(L.ML_A, "a", "ML")]);
    Object.assign(d.sync_jobs[0], { janela_inicio: "2026-09-01T03:00:00.000Z", date_from: "2026-09-01" }); // ano corrente incompleto → bootstrap
    const r1 = await tick(d, H("10:00"), true);
    const j1 = d.sync_jobs.find((j) => j.id === r1.resultados[0].jobId)!;
    assert(j1 && j1.tipo === "incremental", `1o job: ${JSON.stringify(j1)}`);
    Object.assign(j1, { status: "concluido", listagem_completa: true, concluido_em: ISO(H("10:02")) });
    const r2 = await tick(d, H("10:15"), true);
    const j2 = d.sync_jobs.find((j) => j.id === r2.resultados[0].jobId)!;
    assert(r2.resultados[0].intraday === "WAIT_INTRADAY_CADENCE" && j2 && j2.tipo === "backfill" && j2.campo_tempo === "date_closed" && j2.date_to < "2026-09-01", `2o job: ${JSON.stringify(j2)}`);
  });

  console.log("\n[worker: fail-closed antes dos motores]");
  t("Q. o worker RECUSA job intraday (erro intraday_sem_motor) sem chamar motor nenhum", async () => {
    const dados: Record<string, Linha[]> = { lojas: [lojaRow(L.ML_A, "a", "ML")], sync_jobs: [intradayRow(L.ML_A, "a", "ML", DIA0, ISO(H("10:00")), "pendente", { concluido_em: null, listagem_completa: false, iniciado_em: null })] };
    let motor = 0;
    const cliente = banco(dados, () => H("10:05"));
    const nunca = async () => { motor++; throw new Error("motor_chamado"); };
    const r = await W.executarWorkerCanonico({ cliente, relogio: { agoraMs: () => H("10:05") }, portasML: nunca as any, portasShopee: nunca as any,
      motores: { ml: nunca, shopee: nunca, catchup: nunca } as any }, { orcamentoMs: 45_000, habilitado: true });
    const j = dados.sync_jobs[0];
    assert(r.resultado === "RECUSADO" && (r as any).motivo === "intraday_sem_motor" && j.status === "erro" && motor === 0, `${JSON.stringify(r)} ${j.status} motor=${motor}`);
  });

  console.log("\n[read-only]");
  t("RO. nenhuma rede", () => assert(fetches === 0, `fetch=${fetches}`));

  await fila;
  console.log(`\n${falhou === 0 ? "✓" : "✗"} VENDAS-SYNC-INTRADAY — ${passou} passaram, ${falhou} falharam`);
  process.exit(falhou === 0 ? 0 : 1);
}
principal().catch((e) => { console.error("ERRO FATAL", e); process.exit(1); });
