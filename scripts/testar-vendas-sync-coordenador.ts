/**
 * SALES-SYNC-A1 — coordenador canonico: cobertura x frescor + fila serial (offline).
 *
 * Sem rede, sem banco real. O duplo de banco IMPOE o indice real
 * idx_sync_jobs_loja_ativo (UM job pendente|rodando por loja → 23505).
 *
 * Uso: npx tsx scripts/testar-vendas-sync-coordenador.ts
 */
import "./_server-only-inerte";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AvaliacaoLojaSync, JobExistenteSync, LojaAtivaSync, PoliticaSync } from "../lib/vendas/sync/tipos";

let passou = 0, falhou = 0;
let fila: Promise<void> = Promise.resolve();
function t(nome: string, fn: () => void | Promise<void>) {
  fila = fila.then(async () => {
    try { await fn(); passou++; console.log(`  PASS  ${nome}`); }
    catch (e: any) { falhou++; console.log(`  FALHA ${nome} -> ${e?.stack?.split("\n").slice(0, 2).join(" | ") ?? e}`); }
  });
}
function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const RAIZ = join(__dirname, "..");
const AGORA = Date.parse("2026-10-06T17:00:00Z"); // hoje em SP = 06/10
const UID = "dono-a", OUTRO = "dono-b";
const MLA = "11111111-1111-4111-8111-111111111111", MLB = "22222222-2222-4222-8222-222222222222";
const SPA = "33333333-3333-4333-8333-333333333333", SPB = "44444444-4444-4444-8444-444444444444", MLX = "55555555-5555-4555-8555-555555555555";
const H = 3600e3;
const SEM_SINAIS = { escrowPendentes: 0, naoObservadosAposPeriodo: 0 };

async function principal() {
  const P = await import("../lib/vendas/sync/planejamento");
  const C = await import("../lib/vendas/sync/coordenador");
  const W = await import("../lib/vendas/sync/worker-contrato");
  const JM = await import("../lib/mercado-livre/ingestao/janelas");
  const CS = await import("../lib/vendas/canonico/shopee");
  const MS = await import("../lib/shopee/ingestao/motor");
  const POL: PoliticaSync = P.POLITICA_SYNC_PROPOSTA;
  let seq = 0;
  const ml = (id: string): LojaAtivaSync => ({ id, marketplace: "ML" });
  const sp = (id: string): LojaAtivaSync => ({ id, marketplace: "Shopee" });
  const jobML = (lojaId: string, de: string, ate: string, o: Partial<JobExistenteSync> = {}): JobExistenteSync => { const l = JM.limitesDaJanela(de, ate)!;
    return { id: `j${++seq}`, lojaId, marketplace: "ML", campoTempo: "date_closed", janelaInicio: l.inicio.toISOString(), janelaFim: l.fim.toISOString(),
      status: "concluido", listagemCompleta: true, concluidoEm: new Date(AGORA - H).toISOString(), criadoEm: new Date(AGORA - 2 * H).toISOString(), ...o }; };
  const jobSP = (lojaId: string, ini: string, fim: string, o: Partial<JobExistenteSync> = {}): JobExistenteSync => ({ id: `j${++seq}`, lojaId, marketplace: "Shopee",
    campoTempo: "create_time", janelaInicio: ini, janelaFim: fim, status: "concluido", listagemCompleta: true, concluidoEm: new Date(AGORA - H).toISOString(),
    criadoEm: new Date(AGORA - 2 * H).toISOString(), ...o });
  const av = (loja: LojaAtivaSync, de: string, ate: string, jobs: JobExistenteSync[], extra: { sinaisShopee?: any; origem?: "usuario" | "background" | "bootstrap" } = {}) =>
    P.avaliarLoja({ loja, de, ate, agoraMs: AGORA, jobs, politica: POL, origem: extra.origem ?? "usuario", sinaisShopee: extra.sinaisShopee });
  // cobertura Shopee completa para 01→03/10: create_time de 21/09 03:00Z a 04/10 03:00Z (borda compartilhada)
  const cadeiaSP = (lojaId: string, o: Partial<JobExistenteSync> = {}) => [jobSP(lojaId, "2026-09-21T03:00:00.000Z", "2026-10-01T03:00:00.000Z", o), jobSP(lojaId, "2026-10-01T03:00:00.000Z", "2026-10-04T03:00:00.000Z", o)];
  const acao = (a: AvaliacaoLojaSync) => a.proximaAcao.acao;
  const jobDa = (a: AvaliacaoLojaSync) => (a.proximaAcao.acao === "CREATE_DISCOVERY_JOB" || a.proximaAcao.acao === "CREATE_REFRESH_JOB" ? a.proximaAcao.job : null);

  // ── duplo de banco (lojas, sync_jobs, shopee_pedidos) que impoe o indice unico real ──
  type Reg = { tabela: string; op: string; filtros: [string, string, unknown][] };
  function bancoFalso(lojas: { id: string; user_id: string; marketplace: string; ativo: boolean }[], jobs: Record<string, any>[] = []) {
    const regs: Reg[] = []; const db: Record<string, any[]> = { lojas, sync_jobs: jobs, shopee_pedidos: [] };
    const cliente: any = { from(tabela: string) {
      const r: Reg = { tabela, op: "select", filtros: [] }; regs.push(r); let head = false; let inserir: any = null;
      const casa = (l: any) => r.filtros.every(([op, c, v]: any) => op === "eq" ? String(l[c]) === String(v) : op === "in" ? v.map(String).includes(String(l[c]))
        : op === "is" ? (l[c] ?? null) === v : op === "gte" ? l[c] >= v : op === "lt" ? l[c] < v : true);
      const q: any = new Proxy({}, { get(_a, p: string) {
        if (p === "then") return (ok: any) => {
          if (inserir) {
            const ativo = db.sync_jobs.some((j) => j.loja_id === inserir.loja_id && ["pendente", "rodando"].includes(j.status)) && ["pendente", "rodando"].includes(inserir.status);
            if (ativo) return ok({ data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "idx_sync_jobs_loja_ativo"' } });
            const novo = { id: `db${++seq}`, criado_em: new Date(AGORA).toISOString(), concluido_em: null, campo_tempo: null, janela_inicio: null, janela_fim: null, checkpoint: null, ...inserir };
            db.sync_jobs.push(novo);
            return ok({ data: { id: novo.id }, error: null });
          }
          // a projecao "modo:checkpoint->>modo" do PostgREST
          const d = (db[tabela] ?? []).filter(casa).map((l: any) => (tabela === "sync_jobs" ? { ...l, modo: l.checkpoint?.modo ?? null } : l));
          return ok(head ? { data: null, count: d.length, error: null } : { data: d, error: null });
        };
        if (p === "select") return (_c: string, o?: any) => { if (o?.head) head = true; return q; };
        if (p === "insert") return (linha: any) => { r.op = "insert"; inserir = { ...linha }; r.filtros.push(["insert_user", "user_id", linha.user_id]); return q; };
        if (p === "single") return () => q;
        return (...a: any[]) => { if (["eq", "in", "is", "gte", "lt"].includes(p)) r.filtros.push([p, a[0], a[1]]); return q; };
      } });
      return q;
    } };
    return { cliente, regs, db };
  }
  const lojasBase = () => [{ id: MLA, user_id: UID, marketplace: "ML", ativo: true }, { id: MLB, user_id: UID, marketplace: "ML", ativo: true },
    { id: SPA, user_id: UID, marketplace: "Shopee", ativo: true }, { id: SPB, user_id: UID, marketplace: "Shopee", ativo: true },
    { id: MLX, user_id: OUTRO, marketplace: "ML", ativo: true }];
  const linhaML = (lojaId: string, de: string, ate: string, o: Record<string, any> = {}) => { const l = JM.limitesDaJanela(de, ate)!;
    return { id: `r${++seq}`, user_id: UID, loja_id: lojaId, marketplace: "ML", campo_tempo: "date_closed", janela_inicio: l.inicio.toISOString(), janela_fim: l.fim.toISOString(),
      status: "concluido", listagem_completa: true, concluido_em: new Date(AGORA - H).toISOString(), criado_em: new Date(AGORA - 2 * H).toISOString(), checkpoint: null, ...o }; };
  const avaliarDB = (b: ReturnType<typeof bancoFalso>, args: any) => C.avaliarNecessidadeDeSync(b.cliente, { userId: UID, origem: "usuario", ...args }, { agoraMs: AGORA, politica: POL });

  console.log("\n[A-D. cobertura x frescor]");
  t("A. COMPLETE + FRESH → definitivo, NOOP (ML e Shopee)", () => {
    const a = av(ml(MLA), "2026-10-01", "2026-10-03", [jobML(MLA, "2026-10-01", "2026-10-03")]);
    const b = av(sp(SPA), "2026-10-01", "2026-10-03", cadeiaSP(SPA), { sinaisShopee: SEM_SINAIS });
    for (const x of [a, b]) assert(x.cobertura === "COMPLETE" && x.frescor === "FRESH" && x.definitivo && acao(x) === "NOOP" && x.sincronizacao === "IDLE", JSON.stringify(x));
  });
  t("B. COMPLETE + STALE → NAO definitivo, cobertura continua COMPLETE, refresh garantido", () => {
    const velho = jobML(MLA, "2026-10-05", "2026-10-05", { concluidoEm: new Date(AGORA - 10 * H).toISOString() }); // <=7d, intervalo 6h
    const a = av(ml(MLA), "2026-10-05", "2026-10-05", [velho]);
    assert(a.cobertura === "COMPLETE" && a.frescor === "STALE" && !a.definitivo && acao(a) === "CREATE_REFRESH_JOB" && a.motivos.some((m) => m.startsWith("observacao_velha")), JSON.stringify(a));
  });
  t("B2. faixas da politica: 6h (<=7d), 24h (<=30d), 7d (<=90d), alem → so sob demanda do usuario", () => {
    const caso = (dia: string, idadeObsH: number, origem: "usuario" | "background") => av(ml(MLA), dia, dia, [jobML(MLA, dia, dia, { concluidoEm: new Date(AGORA - idadeObsH * H).toISOString() })], { origem }).frescor;
    assert(caso("2026-10-03", 5, "background") === "FRESH" && caso("2026-10-03", 7, "background") === "STALE", "faixa 7d/6h");
    assert(caso("2026-09-20", 23, "background") === "FRESH" && caso("2026-09-20", 25, "background") === "STALE", "faixa 30d/24h");
    assert(caso("2026-08-01", 6 * 24, "background") === "FRESH" && caso("2026-08-01", 8 * 24, "background") === "STALE", "faixa 90d/7d");
    assert(caso("2026-05-05", 100 * 24, "background") === "FRESH", "antigo sem pedido explicito nao exige refresh");
    const pedido = av(ml(MLA), "2026-05-05", "2026-05-05", [jobML(MLA, "2026-05-05", "2026-05-05", { concluidoEm: "2026-05-10T00:00:00.000Z" })], { origem: "usuario" });
    assert(pedido.frescor === "STALE" && acao(pedido) === "CREATE_REFRESH_JOB" && jobDa(pedido)!.proposito === "refresh", "pedido explicito de periodo antigo nao gerou refresh sob demanda");
  });
  t("C. PARTIAL: lacuna → descoberta SO da lacuna (ML: so 03/10; Shopee: so o trecho sem create_time)", () => {
    const a = av(ml(MLA), "2026-10-01", "2026-10-05", [jobML(MLA, "2026-10-01", "2026-10-02"), jobML(MLA, "2026-10-04", "2026-10-05")]);
    const j = jobDa(a)!;
    assert(a.cobertura === "PARTIAL" && !a.definitivo && acao(a) === "CREATE_DISCOVERY_JOB" && a.necessidades.length === 1 && j.de === "2026-10-03" && j.ate === "2026-10-03", JSON.stringify(a.necessidades));
    const b = av(sp(SPA), "2026-10-01", "2026-10-03", [jobSP(SPA, "2026-09-21T03:00:00.000Z", "2026-09-28T00:00:00.000Z"), jobSP(SPA, "2026-09-30T00:00:00.000Z", "2026-10-04T03:00:00.000Z")], { sinaisShopee: SEM_SINAIS });
    const k = jobDa(b)!;
    assert(b.cobertura === "PARTIAL" && b.necessidades.length === 1 && k.inicio === "2026-09-28T00:00:00.000Z" && k.fim === "2026-09-30T00:00:00.000Z" && k.campoTempo === "create_time", JSON.stringify(b.necessidades));
  });
  t("D. ML stale → refresh = reler a MESMA janela date_closed (nunca last_updated)", () => {
    const a = av(ml(MLA), "2026-10-04", "2026-10-05", [jobML(MLA, "2026-10-04", "2026-10-05", { concluidoEm: new Date(AGORA - 10 * H).toISOString() })]);
    const j = jobDa(a)!;
    assert(j.campoTempo === "date_closed" && j.proposito === "refresh" && j.de === "2026-10-04" && j.ate === "2026-10-05", JSON.stringify(j));
    assert(j.inicio === JM.limitesDaJanela("2026-10-04", "2026-10-05")!.inicio.toISOString(), "janela diferente da do motor");
  });

  console.log("\n[E. Shopee frescor]");
  t("E. escrow pendente → STALE + catch-up (cobertura segue COMPLETE); catch-up ativo → espera sem duplicar", () => {
    const a = av(sp(SPA), "2026-10-01", "2026-10-03", cadeiaSP(SPA), { sinaisShopee: { escrowPendentes: 3, naoObservadosAposPeriodo: 0 } });
    const j = jobDa(a)!;
    assert(a.cobertura === "COMPLETE" && a.frescor === "STALE" && !a.definitivo && j.proposito === "catchup_escrow" && j.campoTempo === null && acao(a) === "CREATE_REFRESH_JOB", JSON.stringify(a));
    const cu: JobExistenteSync = { id: "cu", lojaId: SPA, marketplace: "Shopee", campoTempo: null, janelaInicio: null, janelaFim: null, status: "rodando", listagemCompleta: null, concluidoEm: null, criadoEm: new Date(AGORA).toISOString(), catchup: true };
    const b = av(sp(SPA), "2026-10-01", "2026-10-03", [...cadeiaSP(SPA), cu], { sinaisShopee: { escrowPendentes: 3, naoObservadosAposPeriodo: 0 } });
    assert(b.sincronizacao === "SYNCING" && acao(b) === "WAIT_ACTIVE_JOB" && !b.necessidades.some((n) => n.job.proposito === "catchup_escrow"), JSON.stringify(b));
  });
  t("E2. nao pago sem observacao apos o periodo → STALE + refresh create_time da janela; idade velha tambem", () => {
    const a = av(sp(SPA), "2026-10-01", "2026-10-03", cadeiaSP(SPA), { sinaisShopee: { escrowPendentes: 0, naoObservadosAposPeriodo: 2 } });
    assert(a.frescor === "STALE" && a.cobertura === "COMPLETE" && a.necessidades.length > 0 && a.necessidades.every((n) => n.tipo === "refresh" && n.job.campoTempo === "create_time"), JSON.stringify(a));
    const v = av(sp(SPA), "2026-10-01", "2026-10-03", cadeiaSP(SPA, { concluidoEm: new Date(AGORA - 30 * H).toISOString() }), { sinaisShopee: SEM_SINAIS });
    assert(v.frescor === "STALE" && v.motivos.includes("observacao_velha") && acao(v) === "CREATE_REFRESH_JOB", JSON.stringify(v));
  });
  t("E3. sem corpus → descoberta create_time de inicio − prazo publicado; update_time 'completo' NAO conta", () => {
    const upd: JobExistenteSync = { ...jobSP(SPA, "2026-09-01T00:00:00.000Z", "2026-10-05T00:00:00.000Z"), campoTempo: ["update", "time"].join("_") };
    const a = av(sp(SPA), "2026-10-02", "2026-10-02", [upd], { sinaisShopee: SEM_SINAIS });
    const ord = a.necessidades.map((n) => n.job).sort((x, y) => Date.parse(x.inicio!) - Date.parse(y.inicio!));
    assert(a.cobertura === "PARTIAL" && ord.every((j) => j.campoTempo === "create_time") && ord[0].inicio === "2026-09-22T03:00:00.000Z" && ord[ord.length - 1].fim === "2026-10-03T03:00:00.000Z", JSON.stringify(ord.map((j) => [j.inicio, j.fim])));
    for (let i = 1; i < ord.length; i++) assert(ord[i].inicio === ord[i - 1].fim, "borda nao compartilhada");
  });

  console.log("\n[F-H. agregado e dia corrente]");
  t("F. TODOS com UMA loja stale → NAO definitivo (motivo prefixado pelo marketplace)", () => {
    const ok = av(ml(MLA), "2026-10-01", "2026-10-03", [jobML(MLA, "2026-10-01", "2026-10-03")]);
    const sOk = av(sp(SPA), "2026-10-01", "2026-10-03", cadeiaSP(SPA), { sinaisShopee: SEM_SINAIS });
    const sVelha = av(sp(SPA), "2026-10-01", "2026-10-03", cadeiaSP(SPA), { sinaisShopee: { escrowPendentes: 1, naoObservadosAposPeriodo: 0 } });
    assert(P.agregar([ok, sOk]).definitivo, "todas frescas nao deu definitivo");
    const r = P.agregar([ok, sVelha]);
    assert(!r.definitivo && r.cobertura === "COMPLETE" && r.frescor === "STALE" && r.motivos.some((m) => m.startsWith("Shopee:escrow_pendente")), JSON.stringify(r));
    assert(!P.agregar([]).definitivo && P.agregar([]).cobertura === "PARTIAL", "sem loja virou definitivo");
  });
  t("G. loja ESPECIFICA fresca → definitivo mesmo com outra loja (nao selecionada) stale", async () => {
    const b = bancoFalso(lojasBase(), [linhaML(MLA, "2026-10-04", "2026-10-05"), linhaML(MLB, "2026-10-04", "2026-10-05", { concluido_em: new Date(AGORA - 20 * H).toISOString() })]);
    const so = await avaliarDB(b, { marketplace: "ML", lojaId: MLA, de: "2026-10-04", ate: "2026-10-05" });
    assert(so.definitivo && so.lojas.length === 1, JSON.stringify(so));
    const todas = await avaliarDB(b, { marketplace: "ML", de: "2026-10-04", ate: "2026-10-05" });
    assert(!todas.definitivo && todas.frescor === "STALE", JSON.stringify(todas));
  });
  t("H. dia corrente → IN_PROGRESS, nunca definitivo, nenhum job passa de hoje 00:00 SP", () => {
    const so = av(ml(MLA), "2026-10-06", "2026-10-06", []);
    assert(so.frescor === "IN_PROGRESS" && !so.definitivo && acao(so) === "NOOP", JSON.stringify(so));
    const ate = av(ml(MLA), "2026-10-04", "2026-10-06", [jobML(MLA, "2026-10-04", "2026-10-05")]);
    assert(ate.frescor === "IN_PROGRESS" && ate.cobertura === "COMPLETE" && !ate.definitivo && acao(ate) === "NOOP" && ate.motivos.includes("periodo_inclui_hoje"), JSON.stringify(ate));
    const falta = av(sp(SPA), "2026-10-01", "2026-10-06", [], { sinaisShopee: SEM_SINAIS });
    assert(falta.necessidades.every((n) => !n.job.fim || Date.parse(n.job.fim) <= Date.parse("2026-10-06T03:00:00Z")), "job em janela aberta");
    assert(P.agregar([ate, av(ml(MLB), "2026-10-04", "2026-10-05", [jobML(MLB, "2026-10-04", "2026-10-05")])]).frescor === "IN_PROGRESS", "agregado perdeu IN_PROGRESS");
  });

  console.log("\n[I-L. fila serial]");
  t("I. 5 pedidos concorrentes do mesmo periodo → UM job; depois SYNCING/WAIT_ACTIVE_JOB", async () => {
    const b = bancoFalso(lojasBase());
    const avs = await Promise.all(Array.from({ length: 5 }, () => avaliarDB(b, { marketplace: "ML", lojaId: MLA, de: "2026-10-02", ate: "2026-10-02" })));
    const rs = await Promise.all(avs.map((a) => C.garantirProximaAcao(b.cliente, UID, [a], { habilitado: true })));
    const criados = rs.reduce((n, r) => n + r.criados.length, 0), esperando = rs.reduce((n, r) => n + r.aguardando.length, 0);
    const final = await avaliarDB(b, { marketplace: "ML", lojaId: MLA, de: "2026-10-02", ate: "2026-10-02" });
    assert(criados === 1 && esperando === 4 && b.db.sync_jobs.length === 1 && final.sincronizacao === "SYNCING" && final.lojas[0].proximaAcao.acao === "WAIT_ACTIVE_JOB", `${criados}/${esperando} ${JSON.stringify(final)}`);
  });
  t("J. 23505 → aguardando (WAIT_ACTIVE_JOB), nunca falha; job legado ativo na loja tambem bloqueia", async () => {
    const legado = { id: "legado", user_id: UID, loja_id: MLA, marketplace: "ML", status: "rodando", campo_tempo: null, janela_inicio: null, janela_fim: null, listagem_completa: null, concluido_em: null, criado_em: new Date(AGORA).toISOString(), checkpoint: null };
    const b = bancoFalso(lojasBase());
    const a = await avaliarDB(b, { marketplace: "ML", lojaId: MLA, de: "2026-10-02", ate: "2026-10-02" });
    b.db.sync_jobs.push(legado); // outro processo ganhou entre a avaliacao e o insert
    const r = await C.garantirProximaAcao(b.cliente, UID, [a], { habilitado: true });
    assert(r.criados.length === 0 && r.aguardando[0]?.acao === "WAIT_ACTIVE_JOB" && b.db.sync_jobs.length === 1, JSON.stringify(r));
    const a2 = await avaliarDB(b, { marketplace: "ML", lojaId: MLA, de: "2026-10-02", ate: "2026-10-02" });
    assert(a2.lojas[0].proximaAcao.acao === "WAIT_ACTIVE_JOB" && a2.lojas[0].proximaAcao.jobId === "legado", JSON.stringify(a2.lojas[0].proximaAcao));
  });
  t("K. backfill rodando + pedido do usuario → job ativo NAO e cancelado; ao terminar, o do usuario e o proximo", () => {
    const rodando = jobML(MLA, "2026-06-01", "2026-06-07", { status: "rodando", listagemCompleta: false, concluidoEm: null });
    const bg = av(ml(MLA), "2026-05-01", "2026-06-30", [rodando], { origem: "background" });
    const us = av(ml(MLA), "2026-09-29", "2026-10-05", [rodando], { origem: "usuario" });
    const durante = P.proximaAcaoCombinada([bg, us], [rodando]);
    assert(durante.acao === "WAIT_ACTIVE_JOB" && durante.jobId === rodando.id && rodando.status === "rodando", JSON.stringify(durante));
    const feito = { ...rodando, status: "concluido", listagemCompleta: true, concluidoEm: new Date(AGORA).toISOString() };
    const bg2 = av(ml(MLA), "2026-05-01", "2026-06-30", [feito], { origem: "background" });
    const us2 = av(ml(MLA), "2026-09-29", "2026-10-05", [feito], { origem: "usuario" });
    const depois = P.proximaAcaoCombinada([bg2, us2], [feito]);
    assert(depois.acao === "CREATE_DISCOVERY_JOB" && depois.prioridade === 1 && depois.job.de === "2026-09-29", JSON.stringify(depois));
    assert(bg2.necessidades.every((n) => n.prioridade > 1), "backfill com prioridade de usuario");
    const bgPrimeiro = jobDa(bg2); // dentro da mesma prioridade: o mais RECENTE primeiro
    assert(bgPrimeiro && bgPrimeiro.ate === "2026-06-30", `ordem do backfill: ${JSON.stringify(bgPrimeiro)}`);
  });
  t("K2. prioridade: usuario descoberta < usuario refresh < cobertura recente < frescor recente < bootstrap recente < historico", () => {
    const p = P.prioridadeDe;
    const ordem = [p("usuario", "discovery", false), p("usuario", "refresh", false), p("background", "discovery", true), p("background", "refresh", true), p("bootstrap", "discovery", true), p("background", "discovery", false)];
    for (let i = 1; i < ordem.length; i++) assert(ordem[i] > ordem[i - 1], JSON.stringify(ordem));
  });
  t("L. job concluido + frescor expirado → novo refresh permitido (o concluido nao bloqueia)", async () => {
    const b = bancoFalso(lojasBase(), [linhaML(MLA, "2026-10-05", "2026-10-05", { concluido_em: new Date(AGORA - 10 * H).toISOString() })]);
    const a = await avaliarDB(b, { marketplace: "ML", lojaId: MLA, de: "2026-10-05", ate: "2026-10-05" });
    const r = await C.garantirProximaAcao(b.cliente, UID, [a], { habilitado: true });
    assert(r.criados.length === 1 && r.criados[0].acao === "CREATE_REFRESH_JOB" && b.db.sync_jobs.length === 2, JSON.stringify(r));
  });

  console.log("\n[M-N. falhas]");
  const erro = (h: number, o: Partial<JobExistenteSync> = {}) => jobML(MLA, "2026-10-02", "2026-10-02", { status: "erro", listagemCompleta: false, concluidoEm: new Date(AGORA - h * H).toISOString(), ...o });
  t("M. cooldown: falha ha 6 min → WAIT_RETRY (ate falha+30min); falha ha 2h → nova tentativa", () => {
    const espera = av(ml(MLA), "2026-10-02", "2026-10-02", [erro(0.1)]);
    assert(espera.proximaAcao.acao === "WAIT_RETRY" && espera.proximaAcao.ate === new Date(AGORA - 0.1 * H + 30 * 60e3).toISOString() && espera.sincronizacao === "WAITING_RETRY" && espera.cobertura === "PARTIAL", JSON.stringify(espera));
    const retry = av(ml(MLA), "2026-10-02", "2026-10-02", [erro(2)]);
    assert(acao(retry) === "CREATE_DISCOVERY_JOB", JSON.stringify(retry));
  });
  t("N. 3 falhas (UUIDs diferentes) da MESMA necessidade → FAILED; UUID novo nao zera; fora da janela de contagem volta (limite finito)", () => {
    const fs3 = [erro(5), erro(4), erro(3)];
    assert(new Set(fs3.map((j) => j.id)).size === 3, "ids iguais");
    const tres = av(ml(MLA), "2026-10-02", "2026-10-02", fs3);
    assert(tres.cobertura === "FAILED" && tres.proximaAcao.acao === "FAILED" && !tres.definitivo, JSON.stringify(tres));
    // janelas diferentes que cobrem o dia contam como a MESMA necessidade
    const larga = (de: string, ate: string, h: number) => jobML(MLA, de, ate, { status: "erro", listagemCompleta: false, concluidoEm: new Date(AGORA - h * H).toISOString() });
    const sobre = av(ml(MLA), "2026-10-02", "2026-10-02", [erro(5), larga("2026-10-01", "2026-10-03", 4), larga("2026-10-02", "2026-10-04", 3)]);
    assert(sobre.proximaAcao.acao === "FAILED", JSON.stringify(sobre.proximaAcao));
    const velhas = av(ml(MLA), "2026-10-02", "2026-10-02", [erro(30), erro(29), erro(28)]);
    assert(acao(velhas) === "CREATE_DISCOVERY_JOB", "falhas fora da janela de contagem ainda bloqueiam");
    // refresh: falhas DEPOIS do ultimo sucesso contam; antes dele nao
    const ok = jobML(MLA, "2026-10-05", "2026-10-05", { concluidoEm: new Date(AGORA - 10 * H).toISOString() });
    const ef = (h: number) => jobML(MLA, "2026-10-05", "2026-10-05", { status: "erro", listagemCompleta: false, concluidoEm: new Date(AGORA - h * H).toISOString() });
    const r = av(ml(MLA), "2026-10-05", "2026-10-05", [ok, ef(3), ef(2), ef(1)]);
    assert(r.proximaAcao.acao === "FAILED" && r.cobertura === "COMPLETE" && r.frescor === "STALE", JSON.stringify(r));
    const r2 = av(ml(MLA), "2026-10-05", "2026-10-05", [ef(13), ef(12), ef(11), ok]);
    assert(acao(r2) === "CREATE_REFRESH_JOB", "falhas anteriores ao sucesso contaram");
    // catch-up (sem janela) tambem tem limite; erro de job LEGADO nao conta como catch-up
    const cuErro = (h: number, catchup = true): JobExistenteSync => ({ id: `cu${++seq}`, lojaId: SPA, marketplace: "Shopee", campoTempo: null, janelaInicio: null, janelaFim: null, status: "erro", listagemCompleta: null, concluidoEm: new Date(AGORA - h * H).toISOString(), criadoEm: new Date(AGORA - h * H).toISOString(), catchup });
    const escrow = { sinaisShopee: { escrowPendentes: 2, naoObservadosAposPeriodo: 0 } };
    const cu = av(sp(SPA), "2026-10-01", "2026-10-03", [...cadeiaSP(SPA), cuErro(3), cuErro(2), cuErro(1)], escrow);
    assert(cu.proximaAcao.acao === "FAILED" && cu.motivos.includes("catchup_falhas_repetidas"), JSON.stringify(cu.proximaAcao));
    const cu2 = av(sp(SPA), "2026-10-01", "2026-10-03", [...cadeiaSP(SPA), cuErro(3, false), cuErro(2, false), cuErro(1, false)], escrow);
    assert(acao(cu2) === "CREATE_REFRESH_JOB", "erro de job LEGADO contou como falha de catch-up");
  });

  console.log("\n[O. loja nova]");
  t("O. bootstrap: loja nova → o 1o job e o mais RECENTE, origem bootstrap, prioridade abaixo do usuario", () => {
    const k7 = P.avaliarBootstrap({ loja: ml(MLB), agoraMs: AGORA, jobs: [], politica: POL, horizonte: "ULTIMOS_7_DIAS" });
    const j = jobDa(k7)!;
    assert(k7.cobertura === "PARTIAL" && j.de === "2026-09-29" && j.ate === "2026-10-05" && k7.proximaAcao.acao === "CREATE_DISCOVERY_JOB" && k7.proximaAcao.prioridade === 5, JSON.stringify(k7.proximaAcao));
    const ano = P.avaliarBootstrap({ loja: ml(MLB), agoraMs: AGORA, jobs: [], politica: POL, horizonte: "ANO_CORRENTE" });
    assert(jobDa(ano)!.ate === "2026-10-05" && ano.necessidades.some((n) => n.job.de === "2026-01-01") && ano.necessidades.every((n) => n.job.campoTempo === "date_closed"), "ano corrente");
    const s30 = P.avaliarBootstrap({ loja: sp(SPB), agoraMs: AGORA, jobs: [], politica: POL, horizonte: "ULTIMOS_30_DIAS" });
    const js = s30.necessidades.map((n) => n.job);
    assert(js.every((x) => x.campoTempo === "create_time" && Date.parse(x.fim!) - Date.parse(x.inicio!) <= 14 * 24 * H) && jobDa(s30)!.fim === "2026-10-06T03:00:00.000Z", JSON.stringify(js.map((x) => [x.inicio, x.fim])));
    const ord = [...js].sort((a, b) => Date.parse(a.inicio!) - Date.parse(b.inicio!));
    assert(ord[0].inicio === new Date(Date.parse("2026-09-06T03:00:00Z") - CS.LIMITE_POLITICA_PAGAMENTO_MS).toISOString(), `inicio ${ord[0].inicio}`);
  });

  console.log("\n[dono, flag, catch-up, worker]");
  t("isolamento: TODA leitura leva o dono; loja de outro dono → loja_invalida; 1 job por loja com o dono do chamador", async () => {
    const b = bancoFalso(lojasBase());
    const a = await avaliarDB(b, { marketplace: "TODOS", de: "2026-10-02", ate: "2026-10-02" });
    await C.garantirProximaAcao(b.cliente, UID, [a], { habilitado: true });
    assert(b.regs.every((g) => g.filtros.some(([op, c, v]) => (op === "eq" || op === "insert_user") && c === "user_id" && v === UID)), "consulta sem dono");
    assert(!a.lojas.some((l) => l.lojaId === MLX) && b.db.sync_jobs.every((j) => j.user_id === UID), "loja de outro dono");
    assert(new Set(b.db.sync_jobs.map((j) => j.loja_id)).size === b.db.sync_jobs.length && b.db.sync_jobs.length === 4, "mais de um job por loja / loja faltando");
    let e = ""; try { await avaliarDB(b, { marketplace: "ML", lojaId: MLX, de: "2026-10-02", ate: "2026-10-02" }); } catch (x: any) { e = x.message; }
    assert(e === "loja_invalida", e || "nao lancou");
  });
  t("flag desligada → so avalia: 0 jobs criados", async () => {
    const b = bancoFalso(lojasBase());
    const a = await avaliarDB(b, { marketplace: "TODOS", de: "2026-10-02", ate: "2026-10-02" });
    const r = await C.garantirProximaAcao(b.cliente, UID, [a]);
    assert(r.desabilitado && r.criados.length === 0 && b.db.sync_jobs.length === 0, JSON.stringify(r));
  });
  t("catch-up nasce com o checkpoint do motor (modo escrow_catchup) e e relido como catch-up; legado nao", async () => {
    const b = bancoFalso(lojasBase(), [{ id: "leg", user_id: UID, loja_id: SPA, marketplace: "Shopee", campo_tempo: null, janela_inicio: null, janela_fim: null, status: "concluido", listagem_completa: null, concluido_em: new Date(AGORA - 5 * H).toISOString(), criado_em: new Date(AGORA - 6 * H).toISOString(), checkpoint: null }]);
    const aval = P.agregar([av(sp(SPA), "2026-10-01", "2026-10-03", cadeiaSP(SPA), { sinaisShopee: { escrowPendentes: 2, naoObservadosAposPeriodo: 0 } })]);
    const r = await C.garantirProximaAcao(b.cliente, UID, [aval], { habilitado: true });
    const novo = b.db.sync_jobs.find((j) => j.id === r.criados[0]?.jobId)!;
    assert(novo && JSON.stringify(novo.checkpoint) === JSON.stringify(MS.checkpointCatchUpInicial()) && novo.campo_tempo === null && novo.janela_inicio === null, JSON.stringify(novo));
    const jobs = await C.lerJobsDasLojas(b.cliente, UID, [SPA]);
    assert(jobs.find((j) => j.id === novo.id)!.catchup === true && jobs.find((j) => j.id === "leg")!.catchup === false, JSON.stringify(jobs));
    assert(W.classificarJobParaWorker(novo) === "SHOPEE_ESCROW_CATCHUP" && W.classificarJobParaWorker(b.db.sync_jobs.find((j) => j.id === "leg")) === "NAO_CANONICO", "worker");
  });
  t("worker: classifica ML date_closed, Shopee create_time, catch-up; legado e update_time → NAO_CANONICO", () => {
    const c = W.classificarJobParaWorker;
    assert(c({ marketplace: "ML", campo_tempo: "date_closed", janela_inicio: "a", janela_fim: "b", checkpoint: null }) === "ML_DATE_CLOSED", "ml");
    assert(c({ marketplace: "Shopee", campo_tempo: "create_time", janela_inicio: "a", janela_fim: "b", checkpoint: null }) === "SHOPEE_CREATE_TIME", "sp");
    assert(c({ marketplace: "Shopee", campo_tempo: null, janela_inicio: null, janela_fim: null, checkpoint: MS.checkpointCatchUpInicial() }) === "SHOPEE_ESCROW_CATCHUP", "cu");
    assert(c({ marketplace: "Shopee", campo_tempo: null, janela_inicio: null, janela_fim: null, checkpoint: null }) === "NAO_CANONICO", "legado shopee");
    assert(c({ marketplace: "ML", campo_tempo: null, janela_inicio: null, janela_fim: null, checkpoint: null }) === "NAO_CANONICO", "legado ml");
    assert(c({ marketplace: "Shopee", campo_tempo: ["update", "time"].join("_"), janela_inicio: "a", janela_fim: "b", checkpoint: null }) === "NAO_CANONICO", "upd");
    assert(c({ marketplace: "ML", campo_tempo: "create_time", janela_inicio: "a", janela_fim: "b", checkpoint: null }) === "NAO_CANONICO", "ml create_time");
  });

  console.log("\n[P. guardas de arquitetura]");
  const fontes = readdirSync(join(RAIZ, "lib/vendas/sync")).map((f) => [f, readFileSync(join(RAIZ, "lib/vendas/sync", f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")] as const);
  t("P. o coordenador nao contem formula financeira (pack_splitted, voucher, pix, coin, total_amount, desconto)", () => {
    for (const [f, s] of fontes) assert(!/pack_splitted|voucher|pix_discount|pixDiscount|coin|total_amount|totalAmount|original_shopee_discount|calcularMetricas/i.test(s), `${f} tem formula`);
  });
  t("P2. update_time nunca e cobertura; nada de loja/conta fixa; reusa as janelas dos motores, o limite e as contagens do canonico", () => {
    for (const [f, s] of fontes) {
      assert(!/["'`]update_time["'`]/.test(s), `${f} usa update_time`);
      assert(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|MONAMOR|419809235/i.test(s), `${f} conhece loja`);
    }
    const plan = fontes.find(([f]) => f === "planejamento.ts")![1];
    assert(/mercado-livre\/ingestao\/janelas/.test(plan) && /shopee\/ingestao\/janelas/.test(plan) && /LIMITE_POLITICA_PAGAMENTO_MS/.test(plan), "nao reusa motores/canonico");
    assert(!/10 \* 24 \* 3600/.test(plan), "prazo de pagamento duplicado");
    const coord = fontes.find(([f]) => f === "coordenador.ts")![1];
    assert(!/from\("shopee_pedidos"\)|from\("ml_pedidos"\)/.test(coord) && /contarEscrowPendenteShopee/.test(coord) && /contarNaoPagosSemObservacaoShopee/.test(coord), "coordenador consulta pedidos fora do canonico");
    assert(/checkpointCatchUpInicial/.test(coord), "catch-up sem checkpoint do motor");
  });
  t("P3. politica num UNICO lugar; definitivo = COMPLETE && FRESH; formulas canonicas intocadas", () => {
    const plan = fontes.find(([f]) => f === "planejamento.ts")![1];
    assert((plan.match(/idadeMaxDias:\s*\d/g) ?? []).length === 3 && /definitivo: p\.cobertura === "COMPLETE" && frescor === "FRESH"/.test(plan), "politica/definitivo");
    for (const [f, s] of fontes) if (f !== "planejamento.ts") assert(!/idadeMaxDias:\s*\d/.test(s), `${f} duplica politica`);
    const canon = readFileSync(join(RAIZ, "lib/vendas/canonico/shopee.ts"), "utf8");
    assert(/export const LIMITE_POLITICA_PAGAMENTO_MS = 10 \* 24 \* 3600 \* 1000;/.test(canon), "limite mudou");
  });

  await fila;
  console.log(`\n${falhou === 0 ? "✓" : "✗"} VENDAS-SYNC-COORDENADOR — ${passou} passaram, ${falhou} falharam`);
  process.exit(falhou === 0 ? 0 : 1);
}
principal().catch((e) => { console.error("ERRO FATAL", e); process.exit(1); });
