/**
 * SALES-SYNC-A1 — coordenador canonico: cobertura x frescor + fila serial (offline).
 *
 * Sem rede, sem banco real. O duplo de banco IMPOE o indice real
 * idx_sync_jobs_loja_ativo (UM job pendente|rodando por loja → 23505).
 *
 * Uso: npx tsx scripts/testar-vendas-sync-coordenador.ts
 */
import "./_server-only-inerte";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
// SALES-SYNC-D15B2: excecao EXATA do patch D15B — A2-ML so tolera o hunk de exclusao de intraday (HUNK_A2_ML)
import { planejarMLSemD15B, reconstruirBaseD15B } from "./_excecao-d15b-intraday";
// P1 sync_jobs: excecao EXATA das correcoes A e B (atual − P1 = 8978451, que reconstroi d631748 pela D15B)
import { PATCH_P1, reconstruirBaseP1, reverterP1 } from "./_excecao-p1-sync-jobs";
// E2.1: excecao EXATA do tamanho dos jobs Shopee (atual − E21 = 5e135e6, que reconstroi 8978451 pela P1)
import { PATCH_E21, reconstruirBaseE21, reverterE21 } from "./_excecao-e21-tamanho-jobs";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
  // P1: teto = max-rows do PostgREST (corta TODA resposta, sem erro); falharPagina = N-esima leitura de sync_jobs da 57014;
  // aoLerPagina = gancho apos a N-esima pagina de sync_jobs (insercao concorrente)
  // falharPedidos = toda leitura de shopee_pedidos da erro (timeout) — nunca pode virar "zero pendentes"
  // falharLinhasPedidos = so as leituras de LINHAS de shopee_pedidos falham (as contagens HEAD passam)
  type OpcBanco = { teto?: number; falharPagina?: number; aoLerPagina?: (n: number, db: Record<string, any[]>) => void; falharPedidos?: boolean; falharLinhasPedidos?: boolean };
  // a arvore logica do PostgREST (or/and com col.op."valor"), como a consulta de candidatos e o cursor keyset a enviam
  const dividir = (s: string) => { const out: string[] = []; let prof = 0, aspas = false, ini = 0;
    for (let i = 0; i < s.length; i++) { const ch = s[i]; if (ch === '"') aspas = !aspas; else if (!aspas && ch === "(") prof++; else if (!aspas && ch === ")") prof--;
      else if (!aspas && prof === 0 && ch === ",") { out.push(s.slice(ini, i)); ini = i + 1; } }
    out.push(s.slice(ini)); return out; };
  const termo = (l: any, t: string): boolean => {
    const g = t.match(/^(and|or)\(([\s\S]*)\)$/); if (g) return g[1] === "and" ? dividir(g[2]).every((x) => termo(l, x)) : dividir(g[2]).some((x) => termo(l, x));
    const k = t.match(/^([a-z_]+)\.(is|gte|lt|gt|eq)\.([\s\S]*)$/); if (!k) throw new Error(`termo PostgREST invalido: ${t}`);
    const [, c, op, bruto] = k; const v = bruto.replace(/^"([\s\S]*)"$/, "$1");
    if (op === "is") return (l[c] ?? null) === (v === "null" ? null : v);
    if (l[c] === null || l[c] === undefined) return false;
    const x = String(l[c]); return op === "gte" ? x >= v : op === "lt" ? x < v : op === "gt" ? x > v : x === v;
  };
  function bancoFalso(lojas: { id: string; user_id: string; marketplace: string; ativo: boolean }[], jobs: Record<string, any>[] = [], opc: OpcBanco = {}) {
    const regs: Reg[] = []; const db: Record<string, any[]> = { lojas, sync_jobs: jobs, shopee_pedidos: [] };
    let paginasSJ = 0;
    const cliente: any = { from(tabela: string) {
      const r: Reg = { tabela, op: "select", filtros: [] }; regs.push(r); let head = false; let inserir: any = null;
      // P1: ORDER BY + LIMIT + gt como o PostgREST (lerJobsDasLojas pagina por id)
      let ordem: string | null = null; let limite: number | null = null; const ordens: string[] = [];
      const casa = (l: any) => r.filtros.every(([op, c, v]: any) => op === "eq" ? String(l[c]) === String(v) : op === "in" ? v.map(String).includes(String(l[c]))
        : op === "is" ? (l[c] ?? null) === v : op === "gte" ? l[c] >= v : op === "lt" ? l[c] < v : op === "gt" ? String(l[c]) > String(v)
        : op === "or" ? dividir(String(v)).some((x) => termo(l, x)) : true);
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
          const leituraSJ = tabela === "sync_jobs" && !head ? ++paginasSJ : 0;
          if (leituraSJ && opc.falharPagina === leituraSJ) return ok({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } });
          if (tabela === "shopee_pedidos" && (opc.falharPedidos || (opc.falharLinhasPedidos && !head))) return ok({ data: null, count: null, error: { code: "57014", message: "canceling statement due to statement timeout" } });
          (r as any).head = head;
          // E2.1: e "listados:progresso->>listados, escrows:progresso->>escrow_necessarios" (->> devolve TEXTO)
          const txt = (v: unknown) => (v === undefined || v === null ? null : String(v));
          let d = (db[tabela] ?? []).filter(casa).map((l: any) => (tabela === "sync_jobs"
            ? { ...l, modo: l.checkpoint?.modo ?? null, listados: txt(l.progresso?.listados), escrows: txt(l.progresso?.escrow_necessarios) } : l));
          if (ordens.length) d = [...d].sort((x: any, y: any) => { for (const k of ordens) { const a = String(x[k]), b = String(y[k]); if (a !== b) return a < b ? -1 : 1; } return 0; });
          if (limite !== null) d = d.slice(0, limite);
          if (opc.teto !== undefined && !head) d = d.slice(0, opc.teto);
          if (leituraSJ) opc.aoLerPagina?.(leituraSJ, db);
          return ok(head ? { data: null, count: d.length, error: null } : { data: d, error: null });
        };
        if (p === "select") return (_c: string, o?: any) => { if (o?.head) head = true; return q; };
        if (p === "insert") return (linha: any) => { r.op = "insert"; inserir = { ...linha }; r.filtros.push(["insert_user", "user_id", linha.user_id]); return q; };
        if (p === "single") return () => q;
        if (p === "order") return (c: string) => { ordem = c; ordens.push(c); return q; };
        if (p === "limit") return (n: number) => { limite = n; return q; };
        if (p === "or") return (e: string) => { r.filtros.push(["or", "", e]); return q; };
        return (...a: any[]) => { if (["eq", "in", "is", "gte", "lt", "gt"].includes(p)) r.filtros.push([p, a[0], a[1]]); return q; };
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
    // E2.1: o ALVO de cobertura e o mesmo (desde 06/09 − prazo); a necessidade e so o PROXIMO pedaço (o mais recente) —
    // loja nova, nenhuma densidade medida → a sonda de 6 h; o resto vem depois que ele concluir (CE21)
    assert(s30.faltando.length === 1 && s30.faltando[0].inicio === new Date(Date.parse("2026-09-06T03:00:00Z") - CS.LIMITE_POLITICA_PAGAMENTO_MS).toISOString()
      && s30.faltando[0].fim === "2026-10-06T03:00:00.000Z", JSON.stringify(s30.faltando));
    assert(js.length === 1 && Date.parse(js[0].fim!) - Date.parse(js[0].inicio!) === P.TAMANHO_JOB_SHOPEE.sondaMs, JSON.stringify(js.map((x) => [x.inicio, x.fim])));
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

  // ── SALES-SYNC-A2: frescor Shopee por segmento ──
  // periodo 01→03/10: janela necessaria W = [A, D] = [21/09 03Z, 04/10 03Z]; faixa 6h (fim ha < 7 dias)
  console.log("\n[A2. frescor Shopee por segmento]");
  const A = "2026-09-21T03:00:00.000Z", B = "2026-09-25T03:00:00.000Z", M = "2026-09-27T03:00:00.000Z", Cc = "2026-09-30T03:00:00.000Z", D = "2026-10-04T03:00:00.000Z";
  const ha = (horas: number) => new Date(AGORA - horas * H).toISOString();
  const sj = (ini: string, fim: string, horas: number, o: Partial<JobExistenteSync> = {}) => jobSP(SPA, ini, fim, { concluidoEm: ha(horas), criadoEm: ha(horas + 1), ...o });
  const erroSP = (ini: string, fim: string, horas: number) => sj(ini, fim, horas, { status: "erro", listagemCompleta: false });
  const avW = (jobs: JobExistenteSync[]) => av(sp(SPA), "2026-10-01", "2026-10-03", jobs, { sinaisShopee: SEM_SINAIS });
  const resumoW = (a: AvaliacaoLojaSync) => ({ cobertura: a.cobertura, frescor: a.frescor, definitivo: a.definitivo, acao: a.proximaAcao.acao,
    desat: a.desatualizado.map((x) => [x.inicio, x.fim]), refresh: a.necessidades.filter((n) => n.tipo === "refresh").map((n) => [n.job.inicio, n.job.fim]) });
  const VELHO = () => sj(A, D, 20);
  t("A2-1. refresh NOVO cobrindo a janela inteira substitui o job velho → FRESH, definitivo, NOOP", () => {
    const r = resumoW(avW([VELHO(), sj(A, D, 1)]));
    assert(r.cobertura === "COMPLETE" && r.frescor === "FRESH" && r.definitivo && r.acao === "NOOP", JSON.stringify(r));
    const so = resumoW(avW([VELHO()]));
    assert(so.frescor === "STALE" && so.acao === "CREATE_REFRESH_JOB", "controle: so o velho deveria estar STALE");
  });
  t("A2-2. refresh PARCIAL → STALE; a metade nao refrescada continua velha e e SO ela que vai para refresh", () => {
    const r = resumoW(avW([VELHO(), sj(A, M, 1)]));
    assert(r.cobertura === "COMPLETE" && r.frescor === "STALE" && !r.definitivo && r.acao === "CREATE_REFRESH_JOB", JSON.stringify(r));
    assert(JSON.stringify(r.desat) === JSON.stringify([[M, D]]) && JSON.stringify(r.refresh) === JSON.stringify([[M, D]]), JSON.stringify(r));
  });
  t("A2-3. dois refreshes COMPLEMENTARES (borda compartilhada em M) → FRESH, NOOP", () => {
    const r = resumoW(avW([VELHO(), sj(A, M, 1), sj(M, D, 2)]));
    assert(r.frescor === "FRESH" && r.definitivo && r.acao === "NOOP", JSON.stringify(r));
  });
  t("A2-4. sobreposicoes [A,C] e [B,D] (nenhum identico a [A,D]) → FRESH", () => {
    const r = resumoW(avW([VELHO(), sj(A, Cc, 1), sj(B, D, 2)]));
    assert(r.frescor === "FRESH" && r.acao === "NOOP", JSON.stringify(r));
  });
  t("A2-5. GAP real de reobservacao [B,C] → usa a observacao anterior (velha) → STALE so em [B,C]", () => {
    const r = resumoW(avW([VELHO(), sj(A, B, 1), sj(Cc, D, 1)]));
    assert(r.frescor === "STALE" && JSON.stringify(r.desat) === JSON.stringify([[B, Cc]]) && JSON.stringify(r.refresh) === JSON.stringify([[B, Cc]]), JSON.stringify(r));
    const semNada = av(sp(SPA), "2026-10-01", "2026-10-03", [sj(A, B, 1), sj(Cc, D, 1)], { sinaisShopee: SEM_SINAIS });
    assert(semNada.cobertura === "PARTIAL" && semNada.necessidades.some((n) => n.tipo === "discovery") && semNada.frescor === "FRESH", "trecho sem nenhuma observacao tem de ser COBERTURA, nao frescor");
  });
  t("A2-6. ordem/UUID/criacao dos jobs NAO mudam o resultado (6 permutacoes, 2 cenarios)", () => {
    const perm = <T,>(xs: T[]): T[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perm([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])));
    for (const base of [[VELHO(), sj(A, Cc, 1), sj(B, D, 2)], [VELHO(), sj(A, B, 1), sj(Cc, D, 1)]]) {
      const ref = JSON.stringify(resumoW(avW(base)));
      for (const p of perm(base)) {
        const reid = p.map((j, k) => ({ ...j, id: `z${p.length - k}-${j.id}`, criadoEm: ha(100 - k) }));
        assert(JSON.stringify(resumoW(avW(reid))) === ref, `depende da ordem: ${JSON.stringify(resumoW(avW(reid)))}`);
      }
    }
  });
  t("A2-7. jobs INVALIDOS nao entram no envelope: erro, rodando, listagem incompleta, update_time, catch-up", () => {
    const novos: [string, Partial<JobExistenteSync>][] = [
      ["erro", { status: "erro", listagemCompleta: false }], ["rodando", { status: "rodando", listagemCompleta: false, concluidoEm: null }],
      ["listagem_incompleta", { listagemCompleta: false }], ["update_time", { campoTempo: ["update", "time"].join("_") }],
      ["catchup", { campoTempo: null, janelaInicio: null, janelaFim: null, catchup: true, listagemCompleta: null }],
    ];
    for (const [nome, o] of novos) { const r = avW([VELHO(), sj(A, D, 1, o)]); assert(r.frescor === "STALE" && !r.definitivo, `${nome} contou como observacao: ${JSON.stringify(resumoW(r))}`); }
  });
  t("A2-8. helper puro: borda compartilhada [A,B]+[B,D] sem buraco; MAX por segmento; MIN entre segmentos", () => {
    const segs = P.observacaoPorSegmento([sj(A, B, 3), sj(B, D, 1), sj(A, D, 20)], [Date.parse(A), Date.parse(D)]);
    assert(segs.length === 2 && segs.every((s) => s.ultimaMs !== null) && segs[0].ultimaMs === Date.parse(ha(3)) && segs[1].ultimaMs === Date.parse(ha(1)), JSON.stringify(segs));
    assert(P.observacaoEfetivaDaJanela([sj(A, B, 3), sj(B, D, 1), sj(A, D, 20)], [Date.parse(A), Date.parse(D)]) === Date.parse(ha(3)), "efetiva = min dos max");
    assert(P.observacaoEfetivaDaJanela([sj(A, B, 3), sj(Cc, D, 1)], [Date.parse(A), Date.parse(D)]) === null, "trecho sem observacao virou observado");
    // o helper filtra SOZINHO os invalidos (nao depende do chamador pre-filtrar)
    const W2: [number, number] = [Date.parse(A), Date.parse(D)];
    for (const o of [{ status: "erro", listagemCompleta: false }, { status: "rodando", listagemCompleta: false }, { listagemCompleta: false }, { campoTempo: ["update", "time"].join("_") }] as Partial<JobExistenteSync>[])
      assert(P.observacaoEfetivaDaJanela([sj(A, D, 20), sj(A, D, 1, o)], W2) === Date.parse(ha(20)), `invalido entrou no helper: ${JSON.stringify(o)}`);
    // job parcial NUNCA vale para a janela inteira
    assert(P.observacaoEfetivaDaJanela([sj(A, D, 20), sj(A, M, 1)], W2) === Date.parse(ha(20)) && P.observacaoEfetivaDaJanela([sj(A, M, 1)], W2) === null, "parcial tratado como full");
  });
  t("A2-F-A. velho → falha → sucesso NOVO completo: a falha antiga nao conta (FRESH, NOOP)", () => {
    const r = resumoW(avW([VELHO(), erroSP(A, D, 10), erroSP(A, D, 9), erroSP(A, D, 8), sj(A, D, 1)]));
    assert(r.frescor === "FRESH" && r.acao === "NOOP", JSON.stringify(r));
  });
  t("A2-F-B. sucesso novo so em [A,M]; falhas na metade NAO resolvida [M,D] continuam contando (3 → FAILED; 1 recente → WAIT_RETRY)", () => {
    const tres = avW([VELHO(), sj(A, M, 1), erroSP(M, D, 5), erroSP(M, D, 4), erroSP(M, D, 3)]);
    assert(tres.proximaAcao.acao === "FAILED" && tres.cobertura === "COMPLETE" && tres.frescor === "STALE", JSON.stringify(resumoW(tres)));
    const um = avW([VELHO(), sj(A, M, 1), erroSP(M, D, 0.1)]);
    assert(um.proximaAcao.acao === "WAIT_RETRY", JSON.stringify(resumoW(um)));
  });
  t("A2-F-B2. falhas que so tocavam a metade JA resolvida [A,M] nao contam contra [M,D] (refresh de [M,D], nao FAILED)", () => {
    const r = resumoW(avW([VELHO(), erroSP(A, M, 5), erroSP(A, M, 4), erroSP(A, M, 3), sj(A, M, 1)]));
    assert(r.acao === "CREATE_REFRESH_JOB" && JSON.stringify(r.refresh) === JSON.stringify([[M, D]]), JSON.stringify(r));
  });
  t("A2-F-C. duas metades resolvidas por sucessos diferentes depois das falhas → sem FAILED (FRESH, NOOP)", () => {
    const r = resumoW(avW([VELHO(), erroSP(A, D, 5), erroSP(A, D, 4), erroSP(A, D, 3), sj(A, M, 1), sj(M, D, 2)]));
    assert(r.frescor === "FRESH" && r.acao === "NOOP", JSON.stringify(r));
  });
  t("A2-B5. cenario REAL do B5: be316ebf-like + 4d537317-like → STALE; + refresh [24/09,05/10] concluido agora → FRESH, definitivo, NOOP", () => {
    const agora = Date.parse("2026-10-06T19:27:19Z");
    const real = (id: string, ini: string, fim: string, concl: string): JobExistenteSync => ({ id, lojaId: SPA, marketplace: "Shopee", campoTempo: "create_time", janelaInicio: ini, janelaFim: fim,
      status: "concluido", listagemCompleta: true, concluidoEm: concl, criadoEm: concl });
    const jobs = [real("be316ebf-like", "2026-09-21T03:00:00+00:00", "2026-10-04T03:00:00+00:00", "2026-10-05T23:07:31.163+00:00"),
      real("4d537317-like", "2026-10-04T03:00:00+00:00", "2026-10-05T03:00:00+00:00", "2026-10-06T19:02:48.013+00:00")];
    const avB5 = (js: JobExistenteSync[]) => P.avaliarLoja({ loja: sp(SPA), de: "2026-10-04", ate: "2026-10-04", agoraMs: agora, jobs: js, sinaisShopee: SEM_SINAIS, politica: POL, origem: "usuario" });
    const antes = avB5(jobs); const j = jobDa(antes)!;
    // por segmento: o trecho do 4d537317 (concluido ha 25 min) esta FRESCO → refresh so do trecho velho
    assert(antes.cobertura === "COMPLETE" && antes.frescor === "STALE" && j.proposito === "refresh" && j.inicio === "2026-09-24T03:00:00.000Z" && j.fim === "2026-10-04T03:00:00.000Z", JSON.stringify(resumoW(antes)));
    for (const [ini, fim] of [["2026-09-24T03:00:00.000Z", "2026-10-05T03:00:00.000Z"], [j.inicio!, j.fim!]]) {
      const depois = avB5([...jobs, real("refresh-like", ini, fim, new Date(agora).toISOString())]);
      assert(depois.cobertura === "COMPLETE" && depois.frescor === "FRESH" && depois.definitivo && depois.proximaAcao.acao === "NOOP", `${ini}..${fim}: ${JSON.stringify(resumoW(depois))}`);
    }
  });
  t("A2-ML. planejarML INTOCADO (texto identico ao base 6c9b56e) e semantica MAX por dia preservada", () => {
    const fn = (s: string) => { const i = s.indexOf("function planejarML("); const f = s.indexOf("\n// ── Shopee ──", i); return s.slice(i, f); };
    const base = execFileSync("git", ["show", "6c9b56e:lib/vendas/sync/planejamento.ts"], { cwd: RAIZ, encoding: "utf8" });
    const atual = readFileSync(join(RAIZ, "lib/vendas/sync/planejamento.ts"), "utf8");
    // D15B2: identico ao base OU identico apos reverter SO o hunk aprovado (exclusao de intraday da cobertura fechada)
    const baseTxt = fn(base).replace(/\r/g, ""), atualTxt = fn(atual).replace(/\r/g, "");
    assert(baseTxt.length > 500 && (baseTxt === atualTxt || baseTxt === planejarMLSemD15B(atualTxt)), "planejarML mudou");
    const velho = jobML(MLA, "2026-10-05", "2026-10-05", { concluidoEm: new Date(AGORA - 20 * H).toISOString() });
    const novo = jobML(MLA, "2026-10-05", "2026-10-05", { concluidoEm: new Date(AGORA - H).toISOString() });
    const a = av(ml(MLA), "2026-10-05", "2026-10-05", [velho, novo]); const b = av(ml(MLA), "2026-10-05", "2026-10-05", [novo, velho]);
    assert(a.frescor === "FRESH" && b.frescor === "FRESH" && a.proximaAcao.acao === "NOOP", JSON.stringify([a.frescor, b.frescor]));
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

  // ── P1: lerJobsDasLojas paginado — o PostgREST corta toda resposta em 1000 linhas SEM erro ──
  console.log("\n[CP. P1 coordenador: leitura de TODOS os jobs (teto de 1000 por resposta)]");
  const pad = (i: number) => String(i).padStart(5, "0");
  // jobs COMPLETOS de 2025 (nao tocam o periodo avaliado): so empurram a janela util para fora da 1a pagina
  const lixoML = (n: number, lojaId: string, dono = UID) => Array.from({ length: n }, (_, i) => linhaML(lojaId, "2025-01-01", "2025-01-01", {
    id: `sj-${lojaId.slice(0, 2)}-${pad(i)}`, user_id: dono, janela_inicio: new Date(Date.parse("2025-01-01T03:00:00Z") + i * 3600e3).toISOString(), janela_fim: new Date(Date.parse("2025-01-01T03:00:00Z") + (i + 1) * 3600e3).toISOString() }));
  const linhaSP = (lojaId: string, ini: string, fim: string, o: Record<string, any> = {}) => ({ id: `r${++seq}`, user_id: UID, loja_id: lojaId, marketplace: "Shopee", campo_tempo: "create_time",
    janela_inicio: ini, janela_fim: fim, status: "concluido", listagem_completa: true, concluido_em: new Date(AGORA - H).toISOString(), criado_em: new Date(AGORA - 2 * H).toISOString(), checkpoint: null, tipo: "backfill", ...o });
  const lixoSP = (n: number, lojaId: string) => Array.from({ length: n }, (_, i) => linhaSP(lojaId, new Date(Date.parse("2025-01-01T03:00:00Z") + i * 3600e3).toISOString(),
    new Date(Date.parse("2025-01-01T03:00:00Z") + (i + 1) * 3600e3).toISOString(), { id: `sj-${lojaId.slice(0, 2)}-${pad(i)}` }));
  const embaralhar = <X,>(xs: X[]) => xs.map((x, i) => [(i * 7919) % 104729, x] as const).sort((a, b) => a[0] - b[0]).map(([, x]) => x);
  // o que o coordenador decidia ANTES (leitura unica cortada): as 1000 primeiras por id, na MESMA conversao de lerJobsDasLojas
  const comoJob = (r: any): JobExistenteSync => ({ id: r.id, lojaId: r.loja_id, marketplace: r.marketplace, campoTempo: r.campo_tempo ?? null, janelaInicio: r.janela_inicio ?? null,
    janelaFim: r.janela_fim ?? null, status: r.status, listagemCompleta: r.listagem_completa ?? null, concluidoEm: r.concluido_em ?? null, criadoEm: r.criado_em,
    catchup: r.campo_tempo == null && r.janela_inicio == null && r.checkpoint?.modo === "escrow_catchup", tipo: r.tipo ?? null, dateFrom: r.date_from ?? null, dateTo: r.date_to ?? null } as JobExistenteSync);
  const cortado = (rows: any[], lojaId: string) => rows.filter((r) => r.user_id === UID && r.loja_id === lojaId).sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, 1000).map(comoJob);
  const paginasSJ = (b: ReturnType<typeof bancoFalso>) => b.regs.filter((r) => r.tabela === "sync_jobs" && r.op === "select");
  const resumo = (l: AvaliacaoLojaSync) => `${l.cobertura}/${l.frescor}/${l.proximaAcao.acao}${jobDa(l) ? ` ${jobDa(l)!.proposito} ${jobDa(l)!.inicio}→${jobDa(l)!.fim}` : ""}`;

  t("CP-1. ML com 1.501 jobs, janela util com o MAIOR id, teto 1000 → COMPLETE/FRESH/NOOP (antes: descoberta indevida); 3 paginas por id", async () => {
    const util = linhaML(MLA, "2026-10-01", "2026-10-05", { id: "sj-zz-zzzzz" });
    const rows = [...lixoML(1500, MLA), util];
    const b = bancoFalso(lojasBase(), rows, { teto: 1000 });
    const a = (await avaliarDB(b, { marketplace: "ML", lojaId: MLA, de: "2026-10-01", ate: "2026-10-05" })).lojas[0];
    const antes = av(ml(MLA), "2026-10-01", "2026-10-05", cortado(rows, MLA));
    assert(resumo(a) === "COMPLETE/FRESH/NOOP", resumo(a));
    assert(antes.cobertura === "PARTIAL" && antes.proximaAcao.acao === "CREATE_DISCOVERY_JOB", `pré-condição (corte) ${resumo(antes)}`);
    const pags = paginasSJ(b);
    assert(pags.length === 3 && !pags[0].filtros.some(([op]) => op === "gt") && pags.slice(1).every((p) => p.filtros.some(([op, c]) => op === "gt" && c === "id")), `${pags.length} paginas`);
  });
  t("CP-2. Shopee (Monamor) com 1.202 jobs, cadeia create_time com os MAIORES ids → COMPLETE/NOOP (antes: descoberta da janela inteira)", async () => {
    const util = [linhaSP(SPA, "2026-09-21T03:00:00.000Z", "2026-10-01T03:00:00.000Z", { id: "sj-zz-zzzz1" }), linhaSP(SPA, "2026-10-01T03:00:00.000Z", "2026-10-04T03:00:00.000Z", { id: "sj-zz-zzzz2" })];
    const rows = embaralhar([...lixoSP(1200, SPA), ...util]);
    const b = bancoFalso(lojasBase(), rows, { teto: 1000 });
    const a = (await avaliarDB(b, { marketplace: "Shopee", lojaId: SPA, de: "2026-10-01", ate: "2026-10-03" })).lojas[0];
    const antes = av(sp(SPA), "2026-10-01", "2026-10-03", cortado(rows, SPA), { sinaisShopee: SEM_SINAIS });
    assert(resumo(a) === "COMPLETE/FRESH/NOOP", resumo(a));
    assert(antes.proximaAcao.acao === "CREATE_DISCOVERY_JOB", `pré-condição (corte) ${resumo(antes)}`);
  });
  t("CP-3. Shopee (R.D.): só a janela ANTIGA da cadeia cai fora da 1a página → antes DESCOBERTA de datas antigas já provadas; agora a ação do conjunto completo", async () => {
    // espelha o caso real: R.D. pedia DESCOBERTA 25/07→28/07 porque a janela mais antiga da cadeia estava cortada
    const antiga = linhaSP(SPB, "2026-09-21T03:00:00.000Z", "2026-10-01T03:00:00.000Z", { id: "sj-zz-zzzzz" });
    const recente = linhaSP(SPB, "2026-10-01T03:00:00.000Z", "2026-10-04T03:00:00.000Z", { id: "sj-00-00000" });
    const rows = [...lixoSP(1100, SPB), antiga, recente];
    const b = bancoFalso(lojasBase(), rows, { teto: 1000 });
    const agora = (await avaliarDB(b, { marketplace: "Shopee", lojaId: SPB, de: "2026-10-01", ate: "2026-10-03" })).lojas[0];
    const completo = av(sp(SPB), "2026-10-01", "2026-10-03", rows.map(comoJob), { sinaisShopee: SEM_SINAIS });
    const antes = av(sp(SPB), "2026-10-01", "2026-10-03", cortado(rows, SPB), { sinaisShopee: SEM_SINAIS });
    assert(resumo(agora) === resumo(completo) && resumo(agora) === "COMPLETE/FRESH/NOOP", `${resumo(agora)} ≠ ${resumo(completo)}`);
    assert(antes.proximaAcao.acao === "CREATE_DISCOVERY_JOB" && (jobDa(antes)!.inicio ?? "") < "2026-10-01", `pré-condição: o corte pedia descoberta antiga — ${resumo(antes)}`);
  });
  t("CP-4. várias lojas na MESMA leitura (in loja_id) com outro dono intercalado: todas as páginas levam dono+lojas; nada de outro dono/loja; decisões = conjunto completo", async () => {
    const rows = [...lixoML(700, MLA), linhaML(MLA, "2026-10-01", "2026-10-05", { id: "sj-zz-zzzz9" }), ...lixoSP(700, SPA),
      linhaSP(SPA, "2026-09-21T03:00:00.000Z", "2026-10-01T03:00:00.000Z", { id: "sj-zz-zzzz7" }), linhaSP(SPA, "2026-10-01T03:00:00.000Z", "2026-10-04T03:00:00.000Z", { id: "sj-zz-zzzz8" }),
      ...lixoML(900, MLX, OUTRO).map((r) => ({ ...r, id: `sj-${r.id.slice(3)}x` }))];
    const b = bancoFalso(lojasBase(), embaralhar(rows), { teto: 1000 });
    const lidos = await C.lerJobsDasLojas(b.cliente, UID, [MLA, SPA]);
    assert(lidos.length === 1403 && new Set(lidos.map((j) => j.id)).size === 1403 && lidos.every((j) => j.lojaId === MLA || j.lojaId === SPA), `${lidos.length}`);
    assert(paginasSJ(b).every((p) => p.filtros.some(([op, c, v]) => op === "eq" && c === "user_id" && v === UID) && p.filtros.some(([op, c]) => op === "in" && c === "loja_id")), "página sem dono/lojas");
    const avs = await avaliarDB(b, { marketplace: "TODOS", de: "2026-10-01", ate: "2026-10-03" });
    const porLoja = Object.fromEntries(avs.lojas.map((l) => [l.lojaId, resumo(l)]));
    assert(porLoja[MLA] === "COMPLETE/FRESH/NOOP" && porLoja[SPA] === "COMPLETE/FRESH/NOOP" && !(MLX in porLoja), JSON.stringify(porLoja));
  });
  t("CP-5/6/9. falha em página INTERMEDIÁRIA → avaliação e garantirProximaAcao lançam leitura_falhou; NENHUM job criado, nenhum insert tentado", async () => {
    const rows = [...lixoML(1500, MLA), linhaML(MLA, "2026-10-01", "2026-10-05", { id: "sj-zz-zzzzz" })];
    const b1 = bancoFalso(lojasBase(), rows, { teto: 1000, falharPagina: 2 });
    let e1 = ""; try { await avaliarDB(b1, { marketplace: "ML", lojaId: MLA, de: "2026-10-01", ate: "2026-10-05" }); } catch (e: any) { e1 = e.message; }
    // avaliação feita com um conjunto que pede job (sem a janela útil) + a leitura do garantir falhando na 2a página
    const aval = await avaliarDB(bancoFalso(lojasBase(), lixoML(10, MLA)), { marketplace: "ML", lojaId: MLA, de: "2026-10-01", ate: "2026-10-05" });
    assert(aval.lojas[0].proximaAcao.acao === "CREATE_DISCOVERY_JOB", "pré-condição: a avaliação pede job");
    const b2 = bancoFalso(lojasBase(), rows.map((r) => ({ ...r })), { teto: 1000, falharPagina: 2 });
    const antes = b2.db.sync_jobs.length;
    const erros: string[] = []; const ce = console.error; console.error = (...a: any[]) => { erros.push(a.join(" ")); };
    let e2 = ""; try { await C.garantirProximaAcao(b2.cliente, UID, [aval], { habilitado: true }); } catch (e: any) { e2 = e.message; } finally { console.error = ce; }
    assert(e1 === "leitura_falhou" && e2 === "leitura_falhou", `${e1} / ${e2}`);
    assert(b2.db.sync_jobs.length === antes && !b2.regs.some((r) => r.op === "insert"), "job criado com leitura parcial");
    assert(erros.length === 1 && erros[0] === "[vendas-canonico] leitura falhou etapa=coordenador_jobs codigo=57014", JSON.stringify(erros));
  });
  t("CP-7. mudança na ORDEM de inserção das janelas → mesmo conjunto e mesmas decisões", async () => {
    const rows = [...lixoML(1300, MLA), linhaML(MLA, "2026-10-01", "2026-10-05", { id: "sj-zz-zzzzz" })];
    const r1 = (await avaliarDB(bancoFalso(lojasBase(), rows, { teto: 1000 }), { marketplace: "ML", lojaId: MLA, de: "2026-09-28", ate: "2026-10-05" })).lojas[0];
    const r2 = (await avaliarDB(bancoFalso(lojasBase(), embaralhar(rows), { teto: 1000 }), { marketplace: "ML", lojaId: MLA, de: "2026-09-28", ate: "2026-10-05" })).lojas[0];
    const r3 = (await avaliarDB(bancoFalso(lojasBase(), [...rows].reverse(), { teto: 1000 }), { marketplace: "ML", lojaId: MLA, de: "2026-09-28", ate: "2026-10-05" })).lojas[0];
    assert(resumo(r1) === resumo(r2) && resumo(r2) === resumo(r3) && r1.proximaAcao.acao === "CREATE_DISCOVERY_JOB", `${resumo(r1)} | ${resumo(r2)} | ${resumo(r3)}`);
  });
  t("CP-8. inserção CONCORRENTE entre páginas: cada job que já existia aparece 1x; o novo acima do cursor pode entrar, o abaixo não; nunca duplicata", async () => {
    const rows = [...lixoML(1500, MLA), linhaML(MLA, "2026-10-01", "2026-10-05", { id: "sj-zz-zzzzz" })];
    const novos = { baixo: linhaML(MLA, "2026-09-01", "2026-09-01", { id: "sj-11-00000a" }), alto: linhaML(MLA, "2026-09-02", "2026-09-02", { id: "sj-zz-zzzzzz" }) };
    const b = bancoFalso(lojasBase(), [...rows], { teto: 1000, aoLerPagina: (n, db) => { if (n === 1) db.sync_jobs.push(novos.baixo, novos.alto); } });
    const lidos = await C.lerJobsDasLojas(b.cliente, UID, [MLA]);
    const ids = lidos.map((j) => j.id);
    assert(new Set(ids).size === ids.length && rows.every((r) => ids.filter((x) => x === r.id).length === 1), "job existente perdido/duplicado");
    assert(ids.includes(novos.alto.id) && !ids.includes(novos.baixo.id) && ids.length === rows.length + 1, `${ids.length}`);
    // a decisão continua legítima: a janela útil foi lida
    assert(P.avaliarLoja({ loja: ml(MLA), de: "2026-10-01", ate: "2026-10-05", agoraMs: AGORA, jobs: lidos, politica: POL, origem: "usuario" }).proximaAcao.acao === "NOOP", "decisão");
  });
  // ── P1-B: sinal de nao pagos do coordenador + refresh mirando a pendencia + frescor por idade (planejador REAL, offline) ──
  console.log("\n[CB. P1-B laço de refresh Shopee: sinal por prazo, alvo = pendência, frescor por idade]");
  const DIA = 24 * H, d = (n: number) => new Date(AGORA - n * DIA).toISOString();
  const MAN = { marketplace: "Shopee", lojaId: SPA, de: "2026-07-08", ate: "2026-10-05" };   // manutencao: [hoje − 90, ontem]
  const pedidoSP = (lojaId: string, sn: string, criado: string, obs: string | null, o: Record<string, any> = {}) =>
    ({ user_id: UID, loja_id: lojaId, order_sn: sn, order_status: "CANCELLED", create_time: criado, pay_time: null, detail_fetched_at: obs, escrow_pendente: false, ...o });
  // casos (AGORA = 06/10 17:00Z): C1 visto DEPOIS do prazo; C2 visto ANTES; C3 UNPAID no prazo; C4 pago tarde ainda nao visto;
  // C5 mudanca hipotetica (visto antes do prazo); C6 nunca detalhado; C7 visto depois do prazo (mudanca posterior hipotetica)
  const CASOS = () => [
    pedidoSP(SPA, "C1", d(60), d(40)), pedidoSP(SPA, "C2", d(30), d(28)), pedidoSP(SPA, "C3", d(2), d(1), { order_status: "UNPAID" }),
    pedidoSP(SPA, "C4", d(8), d(7), { order_status: "UNPAID" }), pedidoSP(SPA, "C5", d(40), d(35)), pedidoSP(SPA, "C6", d(20), null), pedidoSP(SPA, "C7", d(45), d(20))];
  // E2.1: a cobertura traz a densidade MEDIDA (3.000 pedidos em 108 dias, 1% com escrow) — o refresh de uma faixa de
  // poucos dias cabe em UM job, como antes; o caso SEM medida (sonda de 6 h) e o de densidade alta estao nos CE21
  const coberturaSP = (lojaId: string, concl = AGORA - H) => [linhaSP(lojaId, "2026-06-20T03:00:00.000Z", "2026-10-06T03:00:00.000Z", { id: `cov-${lojaId.slice(0, 2)}`, concluido_em: new Date(concl).toISOString(), criado_em: new Date(concl - H).toISOString(),
    progresso: { listados: 3000, escrow_necessarios: 30 } })];
  const bancoCasos = (pedidos = CASOS()) => { const b = bancoFalso(lojasBase(), coberturaSP(SPA)); b.db.shopee_pedidos.push(...pedidos); return b; };
  const avDB = async (b: ReturnType<typeof bancoFalso>, origem: "background" | "usuario" = "background", args: any = MAN) => (await avaliarDB(b, { ...args, origem })).lojas[0];
  // planejador com origem usuario: pede a listagem EXPLICITAMENTE (o Dashboard nao pede)
  const avDBListar = async (b: ReturnType<typeof bancoFalso>, args: any = MAN) =>
    (await C.avaliarNecessidadeDeSync(b.cliente, { userId: UID, ...args, origem: "usuario" }, { agoraMs: AGORA, politica: POL, listarPendentes: true })).lojas[0];
  const leiturasPedidos = (b: ReturnType<typeof bancoFalso>) => { const rs = b.regs.filter((r) => r.tabela === "shopee_pedidos");
    return { total: rs.length, linhas: rs.filter((r) => !(r as any).head).length }; };
  const diasAlvo = (l: AvaliacaoLojaSync) => l.necessidades.filter((n) => n.job.proposito === "refresh").map((n) => `${n.job.de}→${n.job.ate}`);

  t("CB-1. C1–C7 (background): pendentes = C2,C3,C4,C5,C6 (nunca detalhado conta); C1/C7 vistos depois do prazo NÃO motivam o sinal; alvo = os DIAS de criação deles", async () => {
    const l = await avDB(bancoCasos());
    assert(l.motivos.includes("nao_pagos_sem_observacao_pos_periodo:5"), l.motivos.join());
    const alvos = diasAlvo(l).sort();
    // C5 (27/08), C2 (06/09), C6 (16/09), C4 (28/09), C3 (04/10) — cada um no proprio dia civil de SP
    assert(JSON.stringify(alvos) === JSON.stringify(["2026-08-27→2026-08-27", "2026-09-06→2026-09-06", "2026-09-16→2026-09-16", "2026-09-28→2026-09-28", "2026-10-04→2026-10-04"]), JSON.stringify(alvos));
    assert(jobDa(l)!.de === "2026-10-04" && l.frescor === "STALE", resumo(l));
  });
  t("CB-2. USUÁRIO: definição canônica (C1 e C7 também). Frescor do Dashboard = SÓ a contagem (nenhuma linha lida); planejador do usuário que pede a listagem mira as 7 faixas", async () => {
    const b = bancoCasos(); const l = await avDB(b, "usuario");
    assert(l.motivos.includes("nao_pagos_sem_observacao_pos_periodo:7") && l.frescor === "STALE", `${l.motivos}`);
    const lp = leiturasPedidos(b);
    assert(lp.linhas === 0 && lp.total === 3, `Dashboard leu linhas: ${JSON.stringify(lp)}`);   // 2 contagens HEAD + escrow, como antes da B
    const pl = await avDBListar(bancoCasos());
    assert(pl.motivos.includes("nao_pagos_sem_observacao_pos_periodo:7") && diasAlvo(pl).length === 7, `${pl.motivos} ${diasAlvo(pl)}`);
  });
  t("CB-3. o laço ACABA: cada job relê a sua faixa e some do sinal; 5 jobs distintos, nenhum repetido; C4 sai porque foi PAGO (não por prazo)", async () => {
    const b = bancoCasos(); const feitos: string[] = [];
    for (let i = 0; i < 12; i++) {
      const l = await avDB(b); const j = jobDa(l);
      if (!j || l.proximaAcao.acao !== "CREATE_REFRESH_JOB") break;
      const chave = `${j.inicio}|${j.fim}`; assert(!feitos.includes(chave), `job repetido ${chave}`); feitos.push(chave);
      // o job roda: reobserva os pedidos criados na janela dele (C4 aparece PAGO)
      for (const p of b.db.shopee_pedidos) if (p.create_time >= j.inicio! && p.create_time < j.fim!) { p.detail_fetched_at = new Date(AGORA - 60_000).toISOString(); if (p.order_sn === "C4") p.pay_time = d(2); }
      b.db.sync_jobs.push(linhaSP(SPA, j.inicio!, j.fim!, { criado_em: new Date(AGORA - 120_000).toISOString(), concluido_em: new Date(AGORA - 30_000).toISOString() }));
    }
    const fim = await avDB(b);
    assert(feitos.length === 5 && !fim.motivos.some((m) => m.startsWith("nao_pagos_sem_observacao")) && fim.proximaAcao.acao === "NOOP", `${feitos.length} ${resumo(fim)} ${fim.motivos}`);
  });
  t("CB-4. falha no DETALHE (job conclui e o pedido continua sem observação): espera, depois esgota VISÍVEL — nunca resolvido em silêncio, nunca laço", async () => {
    const b = bancoCasos([pedidoSP(SPA, "C3", d(2), d(1), { order_status: "UNPAID" })]);
    const janela = (await avDB(b)).necessidades[0].job;
    const tentativa = (minAtras: number) => b.db.sync_jobs.push(linhaSP(SPA, janela.inicio!, janela.fim!, { criado_em: new Date(AGORA - (minAtras + 2) * 60_000).toISOString(), concluido_em: new Date(AGORA - minAtras * 60_000).toISOString() }));
    tentativa(5);
    const l1 = await avDB(b);
    assert(l1.proximaAcao.acao === "WAIT_RETRY" && l1.motivos.includes("nao_pagos_sem_observacao_pos_periodo:1"), `${resumo(l1)} ${l1.motivos}`);
    tentativa(200); tentativa(400);
    const l2 = await avDB(b);
    assert(l2.proximaAcao.acao === "FAILED" && l2.motivos.includes("pendencia_nao_pagos_sem_efeito") && l2.frescor === "STALE" && l2.motivos.includes("nao_pagos_sem_observacao_pos_periodo:1"), `${resumo(l2)} ${l2.motivos}`);
  });
  t("CB-5. um job que REALMENTE observou (criado ANTES da observação) não conta como tentativa sem efeito (C3 no prazo volta no dia seguinte, legítimo)", async () => {
    const b = bancoCasos([pedidoSP(SPA, "C3", d(2), d(1), { order_status: "UNPAID" })]);
    const janela = (await avDB(b)).necessidades[0].job;
    // tres jobs criados ANTES da observacao d(1) (foram eles que observaram): nao sao tentativas sem efeito — nada esgota
    for (const concl of [0.999, 0.995, 0.991]) b.db.sync_jobs.push(linhaSP(SPA, janela.inicio!, janela.fim!, { criado_em: d(1.01), concluido_em: d(concl) }));
    const l = await avDB(b);
    assert(l.proximaAcao.acao === "CREATE_REFRESH_JOB" && jobDa(l)!.de === "2026-10-04", resumo(l));
  });
  t("CB-6. frescor POR IDADE: ≤7 dias → 6 h; 8–30 → 24 h; 31–90 → 7 dias; >90 nunca em background (segmentos cortados nas fronteiras)", () => {
    const cobre = (ini: string, fim: string, conclH: number) => jobSP(SPA, ini, fim, { concluidoEm: new Date(AGORA - conclH * H).toISOString(), criadoEm: new Date(AGORA - conclH * H - H).toISOString() });
    // uma janela UNICA cobrindo tudo, observada ha 8 h: so a faixa ≤7 dias fica velha
    const a = av(sp(SPA), "2026-07-08", "2026-10-05", [cobre("2026-06-20T03:00:00.000Z", "2026-10-06T03:00:00.000Z", 8)], { sinaisShopee: SEM_SINAIS, origem: "background" });
    const desat = a.desatualizado.map((x) => `${x.inicio}→${x.fim}`);
    assert(desat.length === 1 && desat[0] === `${d(7)}→2026-10-06T03:00:00.000Z`, JSON.stringify(desat));
    // observada ha 30 h: velhas ≤7 e 8–30 (contiguas = um trecho), frescas 31–90
    const b30 = av(sp(SPA), "2026-07-08", "2026-10-05", [cobre("2026-06-20T03:00:00.000Z", "2026-10-06T03:00:00.000Z", 30)], { sinaisShopee: SEM_SINAIS, origem: "background" });
    assert(b30.desatualizado.length === 1 && b30.desatualizado[0].inicio === d(30), JSON.stringify(b30.desatualizado));
    // observada ha 8 dias: tudo ate 90 dias velho, o resto (>90) nao
    const b8 = av(sp(SPA), "2026-07-08", "2026-10-05", [cobre("2026-06-20T03:00:00.000Z", "2026-10-06T03:00:00.000Z", 8 * 24)], { sinaisShopee: SEM_SINAIS, origem: "background" });
    assert(b8.desatualizado.length === 1 && b8.desatualizado[0].inicio === d(90), JSON.stringify(b8.desatualizado));
    // antes desta correcao a janela inteira (~100 dias) virava velha com 6 h
    assert(!a.desatualizado.some((x) => x.inicio < d(8)), "6 h aplicado a janela inteira");
  });
  t("CB-7. virada de DIA e de MÊS: criado 23:59 SP de 30/09 conta em 30/09; 30/09 e 01/10 viram UMA faixa contígua", async () => {
    const b = bancoCasos([pedidoSP(SPA, "V1", "2026-10-01T02:59:00.000Z", null), pedidoSP(SPA, "V2", "2026-10-01T03:00:00.000Z", null)]);
    const l = await avDB(b);
    assert(JSON.stringify(diasAlvo(l)) === JSON.stringify(["2026-09-30→2026-10-01"]) && l.motivos.includes("nao_pagos_sem_observacao_pos_periodo:2"), `${diasAlvo(l)} ${l.motivos}`);
  });
  t("CB-8. três lojas: cada loja só vê os SEUS pedidos e jobs (dono + loja em toda leitura); ML intocado", async () => {
    const b = bancoFalso(lojasBase(), [...coberturaSP(SPA), ...coberturaSP(SPB), linhaML(MLA, "2026-10-01", "2026-10-05")]);
    b.db.shopee_pedidos.push(pedidoSP(SPA, "A1", d(30), d(28)), pedidoSP(SPB, "B1", d(20), null), pedidoSP(SPB, "B2", d(20), null, { user_id: OUTRO }));
    const avs = await avaliarDB(b, { marketplace: "TODOS", de: "2026-07-08", ate: "2026-10-05", origem: "background" });
    const por = Object.fromEntries(avs.lojas.map((l) => [l.lojaId, l]));
    assert(por[SPA].motivos.includes("nao_pagos_sem_observacao_pos_periodo:1") && JSON.stringify(diasAlvo(por[SPA])) === JSON.stringify(["2026-09-06→2026-09-06"]), `${por[SPA].motivos}`);
    assert(por[SPB].motivos.includes("nao_pagos_sem_observacao_pos_periodo:1") && JSON.stringify(diasAlvo(por[SPB])) === JSON.stringify(["2026-09-16→2026-09-16"]), `${por[SPB].motivos}`);
    const leituras = b.regs.filter((r) => r.tabela === "shopee_pedidos");
    assert(leituras.length > 0 && leituras.every((r) => r.filtros.some(([op, c, v]) => op === "eq" && c === "user_id" && v === UID) && r.filtros.some(([op, c]) => op === "eq" && c === "loja_id")), "leitura sem dono/loja");
  });
  t("CB-9. mais de 100 dias: pedido pendente criado antes de hoje − 100 fica FORA da manutenção (limite explícito); pedido do usuário para o período o alcança", async () => {
    const velho = pedidoSP(SPA, "V100", d(120), null);
    const l = await avDB(bancoCasos([velho]));
    assert(!l.motivos.some((m) => m.startsWith("nao_pagos")) && diasAlvo(l).length === 0, l.motivos.join());
    const b = bancoFalso(lojasBase(), [linhaSP(SPA, "2026-05-20T03:00:00.000Z", "2026-06-20T03:00:00.000Z", { id: "cov-v" })]);
    b.db.shopee_pedidos.push(velho);
    const u = await avDBListar(b, { marketplace: "Shopee", lojaId: SPA, de: "2026-06-08", ate: "2026-06-12" });
    assert(u.motivos.includes("nao_pagos_sem_observacao_pos_periodo:1") && diasAlvo(u).includes("2026-06-08→2026-06-08"), `${u.motivos} ${diasAlvo(u)}`);
  });
  t("CB-10. a LISTAGEM canônica é a MESMA população da contagem canônica (sem pendente perdido); sem pendentes → nenhuma listagem", async () => {
    const CS2 = await import("../lib/vendas/canonico/shopee");
    const b = bancoCasos();
    const args = { userId: UID, lojaId: SPA, desdeIso: "2026-06-28T03:00:00.000Z", fimIso: "2026-10-06T03:00:00.000Z" };
    const n = await CS2.contarNaoPagosSemObservacaoShopee(b.cliente, args), lista = await CS2.listarNaoPagosSemObservacaoShopee(b.cliente, args);
    assert(n === 7 && lista.length === 7 && new Set(lista.map((x) => x.orderSn)).size === 7, `${n} ${lista.length}`);
    // background: UMA consulta de candidatos (sem as 2 contagens HEAD) + escrow, com ou sem pendente
    const vazio = bancoCasos([]); await avDB(vazio);
    const cheio = bancoCasos(); await avDB(cheio);
    assert(JSON.stringify(leiturasPedidos(vazio)) === JSON.stringify({ total: 2, linhas: 1 }) && JSON.stringify(leiturasPedidos(cheio)) === JSON.stringify({ total: 2, linhas: 1 }),
      `${JSON.stringify(leiturasPedidos(vazio))} / ${JSON.stringify(leiturasPedidos(cheio))}`);
  });
  t("CB-13. candidatos = superconjunto EXATO: os mesmos pendentes que a listagem completa (C1–C7 e 400 aleatórios); a árvore or/and filtra no servidor", async () => {
    const CS2 = await import("../lib/vendas/canonico/shopee");
    const args = { userId: UID, lojaId: SPA, desdeIso: "2026-06-28T03:00:00.000Z", fimIso: "2026-10-06T03:00:00.000Z" };
    let x = 7; const rnd = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
    const aleatorios = Array.from({ length: 400 }, (_, i) => { const c = AGORA - rnd() * 100 * DIA; const o = rnd() < 0.1 ? null : c + rnd() * 30 * DIA;
      return pedidoSP(SPA, `R${i}`, new Date(c).toISOString(), o === null ? null : new Date(Math.min(o, AGORA)).toISOString()); });
    const b = bancoCasos([...CASOS(), ...aleatorios]);
    const fim = Date.parse(args.fimIso), P = CS2.LIMITE_POLITICA_PAGAMENTO_MS;
    const pend = (rs: any[]) => rs.filter((r) => r.detailFetchedAt === null || Date.parse(r.detailFetchedAt) < Math.min(fim, Date.parse(r.createTime) + P)).map((r) => r.orderSn).sort().join();
    const completa = await CS2.listarNaoPagosSemObservacaoShopee(b.cliente, args), cand = await CS2.listarCandidatosNaoPagosPorPrazoShopee(b.cliente, { ...args, prazoMs: P });
    assert(pend(completa) === pend(cand) && pend(cand).length > 0 && cand.length < completa.length, `${cand.length} de ${completa.length}`);
  });
  t("CB-14. resposta CHEIA de candidatos (teto 1000) → a listagem completa paginada: 1.205 nunca detalhados, todos contados, nenhum omitido", async () => {
    const muitos = Array.from({ length: 1205 }, (_, i) => pedidoSP(SPA, `N${String(i).padStart(5, "0")}`, new Date(AGORA - (10 + (i % 60)) * DIA).toISOString(), null));
    const b = bancoFalso(lojasBase(), coberturaSP(SPA), { teto: 1000 }); b.db.shopee_pedidos.push(...muitos);
    const l = await avDB(b);
    assert(l.motivos.includes("nao_pagos_sem_observacao_pos_periodo:1205"), l.motivos.join());
    assert(leiturasPedidos(b).linhas >= 3, JSON.stringify(leiturasPedidos(b)));   // candidatos (cheia) + paginas da listagem completa
  });
  t("CB-16. C8: visto DEPOIS de criação + 10 dias, mas dentro da margem da faixa (está nos candidatos): background NÃO o conta (prazo exato em memória); usuário conta", async () => {
    // faixa semanal comeca em desde (28/06 03:00Z) + 7 semanas = 16/08 03:00Z; criado 1 h depois, visto 12 dias depois
    const c8 = pedidoSP(SPA, "C8", "2026-08-16T04:00:00.000Z", "2026-08-28T04:00:00.000Z");
    const CS2 = await import("../lib/vendas/canonico/shopee");
    const b = bancoCasos([c8]);
    const cand = await CS2.listarCandidatosNaoPagosPorPrazoShopee(b.cliente, { userId: UID, lojaId: SPA, desdeIso: "2026-06-28T03:00:00.000Z", fimIso: "2026-10-06T03:00:00.000Z", prazoMs: CS2.LIMITE_POLITICA_PAGAMENTO_MS });
    assert(cand.length === 1, `pré-condição: C8 deveria estar nos candidatos (${cand.length})`);
    const l = await avDB(b);
    assert(!l.motivos.some((m) => m.startsWith("nao_pagos")) && diasAlvo(l).length === 0, l.motivos.join());
    const u = await avDB(bancoCasos([c8]), "usuario");
    assert(u.motivos.includes("nao_pagos_sem_observacao_pos_periodo:1"), u.motivos.join());
  });
  t("CB-17. SÓ a leitura de linhas falha (contagens HEAD ok) → leitura_falhou: o sinal nunca vira 'zero pendentes'", async () => {
    const b = bancoFalso(lojasBase(), coberturaSP(SPA), { falharLinhasPedidos: true }); b.db.shopee_pedidos.push(...CASOS());
    const ce = console.error; console.error = () => {};
    let e = ""; try { await avDB(b); } catch (x: any) { e = x.message; } finally { console.error = ce; }
    assert(e === "leitura_falhou", e || "nao lancou");
  });
  t("CB-15. erro/timeout na leitura de pedidos → leitura_falhou (background e Dashboard): nunca 'zero pendentes', nunca FRESH", async () => {
    for (const origem of ["background", "usuario"] as const) {
      const b = bancoFalso(lojasBase(), coberturaSP(SPA), { falharPedidos: true }); b.db.shopee_pedidos.push(...CASOS());
      const erros: string[] = []; const ce = console.error; console.error = (...a: any[]) => { erros.push(a.join(" ")); };
      let e = ""; try { await avDB(b, origem); } catch (x: any) { e = x.message; } finally { console.error = ce; }
      assert(e === "leitura_falhou", `${origem}: ${e || "nao lancou"}`);
    }
  });
  t("CB-11. as regras canônicas seguem intocadas: contarNaoPagosSemObservacaoShopee igual a 6d3dad0; prazo NÃO duplicado no coordenador", () => {
    const base = execFileSync("git", ["show", "6d3dad0:lib/vendas/canonico/shopee.ts"], { cwd: RAIZ, encoding: "utf8" }).replace(/\r\n/g, "\n");
    const atual = readFileSync(join(RAIZ, "lib/vendas/canonico/shopee.ts"), "utf8").replace(/\r\n/g, "\n");
    const fn = (s: string) => s.slice(s.indexOf("export async function contarNaoPagosSemObservacaoShopee("), s.indexOf("/** Dimensao C (contagem)"));
    const semNova = (s: string) => s.replace(/\n\/\*\*\n \* P1-B \(agendamento[\s\S]*?\n}\n/g, "");
    assert(fn(base) === semNova(fn(atual)) && fn(base).length > 200, "contagem canonica alterada");
    const coord = readFileSync(join(RAIZ, "lib/vendas/sync/coordenador.ts"), "utf8");
    assert(!/10 \* 24 \* 3600/.test(coord) && /LIMITE_POLITICA_PAGAMENTO_MS/.test(coord), "prazo duplicado no coordenador");
  });

  t("CB-12. C7 (visto depois do prazo, mudança posterior hipotética) NÃO motiva o sinal, mas o frescor por IDADE relê a faixa dele", async () => {
    const c7 = pedidoSP(SPA, "C7", d(45), d(20));
    const b = bancoFalso(lojasBase(), coberturaSP(SPA, AGORA - 8 * 24 * H));   // cobertura observada ha 8 dias: a faixa 31–90 vence (7 dias)
    b.db.shopee_pedidos.push(c7);
    const l = await avDB(b);
    assert(!l.motivos.some((m) => m.startsWith("nao_pagos")) && l.motivos.includes("observacao_velha"), l.motivos.join());
    assert(l.desatualizado.some((x) => x.inicio <= c7.create_time && x.fim > c7.create_time), JSON.stringify(l.desatualizado));
  });

  // ── E2.1: jobs Shopee de manutencao/bootstrap com trabalho estimado LIMITADO (o intraday entra entre eles) ──
  console.log("\n[CE21. tamanho dos jobs Shopee de manutencao/bootstrap]");
  const TAM = P.TAMANHO_JOB_SHOPEE;
  const FIM_HIST = Date.parse("2026-06-30T03:00:00.000Z"), INI_ANO = Date.parse("2026-01-01T03:00:00.000Z") - CS.LIMITE_POLITICA_PAGAMENTO_MS, FIM_COB = Date.parse("2026-10-06T03:00:00.000Z");
  const isoE = (ms: number) => new Date(ms).toISOString();
  // cobertura MEDIDA de 30/06 a 06/10 em blocos de 14 dias (1.000 pedidos/dia, sem escrow pendente), observada ha 1 h
  const cobMedida = (lojaId = SPA, porDia = 1000, o: Partial<JobExistenteSync> = {}) => { const js: JobExistenteSync[] = [];
    for (let a = FIM_HIST; a < FIM_COB; a += 14 * DIA) { const b = Math.min(a + 14 * DIA, FIM_COB);
      js.push(jobSP(lojaId, isoE(a), isoE(b), { listados: Math.round(porDia * (b - a) / DIA), escrowsNecessarios: 0, criadoEm: isoE(AGORA - 3 * H), ...o })); }
    return js; };
  const bootAno = (jobs: JobExistenteSync[], agoraMs = AGORA, pol: PoliticaSync = POL) => P.avaliarBootstrap({ loja: sp(SPA), agoraMs, jobs, politica: pol, horizonte: "ANO_CORRENTE" });
  const custo = (fracao: number) => 1 / TAM.pedidosPorFatia.listar + 1 / TAM.pedidosPorFatia.detalhe + fracao / TAM.pedidosPorFatia.escrow;
  const dur = (j: { inicio: string | null; fim: string | null }) => Date.parse(j.fim!) - Date.parse(j.inicio!);
  const intra = (lojaId: string, ini: number, fim: number, o: Partial<JobExistenteSync> = {}) => { const dia = new Date(ini - 3 * H).toISOString().slice(0, 10);
    return jobSP(lojaId, isoE(ini), isoE(fim), { tipo: "incremental", dateFrom: dia, dateTo: dia, concluidoEm: isoE(fim + 5 * 60e3), criadoEm: isoE(fim), ...o }); };

  t("CE21-1. histórico ausente do banco: o 1o job é SÓ o pedaço mais recente, do tamanho do trabalho-alvo pela densidade MEDIDA do vizinho (escrow de todos)", () => {
    const l = bootAno(cobMedida());
    const j = jobDa(l)!;
    // 1.000/dia × 1,5 de margem; descoberta sem intraday → fracao 1 → L = alvo / (densidade × custo)
    const L = TAM.alvoFatias / ((1000 * TAM.fatorSeguranca / DIA) * custo(1));
    assert(j.proposito === "descoberta" && j.fim === isoE(FIM_HIST) && l.proximaAcao.acao === "CREATE_DISCOVERY_JOB" && l.proximaAcao.prioridade === 5, resumo(l));
    assert(j.inicio === isoE(Math.floor((FIM_HIST - L) / H) * H) && dur(j) < DIA && dur(j) >= L, `${j.inicio} L=${(L / H).toFixed(2)}h`);
    assert(l.necessidades.length === 1 && l.faltando.length === 1 && l.faltando[0].inicio === isoE(INI_ANO) && l.faltando[0].fim === isoE(FIM_HIST), JSON.stringify(l.faltando));
  });
  t("CE21-2. sem densidade medida → sonda de 6 h; depois cresce no máximo 2× por passo (nunca salta para 7 dias de uma vez)", () => {
    const k = (jobs: JobExistenteSync[]) => jobDa(P.avaliarBootstrap({ loja: sp(SPB), agoraMs: AGORA, jobs, politica: POL, horizonte: "ULTIMOS_7_DIAS" }))!;
    const j1 = k([]); assert(dur(j1) === TAM.sondaMs && j1.fim === isoE(FIM_COB), `${j1.inicio}→${j1.fim}`);
    const feitos: JobExistenteSync[] = [jobSP(SPB, j1.inicio!, j1.fim!, { listados: 0, escrowsNecessarios: 0 })];
    const j2 = k(feitos); assert(dur(j2) === 2 * TAM.sondaMs && j2.fim === j1.inicio, `${j2.inicio}→${j2.fim}`);
    feitos.push(jobSP(SPB, j2.inicio!, j2.fim!, { listados: 0, escrowsNecessarios: 0 }));
    const j3 = k(feitos); assert(dur(j3) === 4 * TAM.sondaMs && j3.fim === j2.inicio, `${j3.inicio}→${j3.fim}`);
  });
  t("CE21-3. histórico inteiro drenado pedaço a pedaço (dias de campanha 5×, perfil horário): união = lacuna EXATA, bordas compartilhadas, sem sobreposição, sem chave repetida, termina", () => {
    const perfil = (ms: number) => { const h = new Date(ms - 3 * H).getUTCHours(); return h < 7 ? 0.3 : h < 10 ? 1 : 1.45; };
    const campanha = (ms: number) => { const d = new Date(ms - 3 * H); return d.getUTCDate() === d.getUTCMonth() + 1 ? 5 : 1; };
    const pedidos = (a: number, b: number) => { let n = 0; for (let x = a; x < b; x += 15 * 60e3) n += (1000 / 96) * perfil(x) * campanha(x) * Math.min(1, (b - x) / (15 * 60e3)); return Math.round(n); };
    const jobs = cobMedida(); const feitos: JobExistenteSync[] = []; const chaves = new Set<string>(); let passos = 0, acimaDoAlvo = 0, acimaFora = 0;
    for (;;) {
      const l = bootAno([...jobs, ...feitos]); const j = jobDa(l);
      if (!j || j.proposito !== "descoberta") break;
      assert(++passos < 2000, "nao termina");
      assert(!chaves.has(j.chave), `chave repetida ${j.chave}`); chaves.add(j.chave);
      assert(dur(j) <= TAM.maximoMs && dur(j) >= TAM.minimoMs - H && Date.parse(j.inicio!) % H === 0 || Date.parse(j.inicio!) === INI_ANO, `${j.inicio}→${j.fim}`);
      const n = pedidos(Date.parse(j.inicio!), Date.parse(j.fim!));
      const fatias = n * custo(0.9);
      if (fatias > TAM.alvoFatias) { acimaDoAlvo++; let c = false; for (let x = Date.parse(j.inicio!); x < Date.parse(j.fim!); x += H) if (campanha(x) > 1) c = true; if (!c) acimaFora++; }
      feitos.push(jobSP(SPA, j.inicio!, j.fim!, { listados: n, escrowsNecessarios: Math.round(n * 0.9), criadoEm: isoE(AGORA - 2 * H) }));
    }
    const ord = [...feitos].sort((a, b) => Date.parse(a.janelaInicio!) - Date.parse(b.janelaInicio!));
    assert(ord[0].janelaInicio === isoE(INI_ANO) && ord[ord.length - 1].janelaFim === isoE(FIM_HIST), `${ord[0].janelaInicio} ${ord[ord.length - 1].janelaFim}`);
    for (let i = 1; i < ord.length; i++) assert(ord[i].janelaInicio === ord[i - 1].janelaFim, `borda ${ord[i - 1].janelaFim} / ${ord[i].janelaInicio}`);
    const fim = bootAno([...jobs, ...feitos]);
    assert(fim.cobertura === "COMPLETE" && !fim.faltando.length, resumo(fim));
    // pedaço acima do alvo SO quando contem dia de campanha (densidade 5× que o vizinho nao mostrava) — limite conhecido
    assert(acimaFora === 0, `${acimaFora} pedaços acima do alvo sem campanha`);
    console.log(`        (${passos} pedaços; ${acimaDoAlvo} acima do alvo, todos com dia de campanha)`);
  });
  t("CE21-4. fila serial: intraday vencido passa À FRENTE do histórico; dentro da cadência o histórico anda; com job ativo NADA novo (nunca dois)", () => {
    const base = cobMedida();
    const ultimo = (fim: number) => intra(SPA, Date.parse("2026-10-06T03:00:00.000Z"), fim);
    const escolha = (jobs: JobExistenteSync[]) => {
      const i = P.avaliarIntradayLoja({ loja: sp(SPA), agoraMs: AGORA, jobs, politica: POL });
      return P.proximaAcaoCombinada([bootAno(jobs), i.avaliacao], jobs);
    };
    const vencido = escolha([...base, ultimo(AGORA - 30 * 60e3)]);
    assert(vencido.acao === "CREATE_REFRESH_JOB" && vencido.job.proposito === "intraday", JSON.stringify(vencido));
    const cadencia = escolha([...base, ultimo(AGORA - 15 * 60e3)]);
    assert(cadencia.acao === "CREATE_DISCOVERY_JOB" && cadencia.job.fim === isoE(FIM_HIST), JSON.stringify(cadencia));
    const ativo = jobSP(SPA, cadencia.job.inicio!, cadencia.job.fim!, { status: "rodando", listagemCompleta: false, concluidoEm: null });
    const espera = escolha([...base, ultimo(AGORA - 30 * 60e3), ativo]);
    assert(espera.acao === "WAIT_ACTIVE_JOB", JSON.stringify(espera));
  });
  t("CE21-5. pedido do USUÁRIO inalterado: blocos de 14 dias (revalidação explícita), todas as janelas listadas", () => {
    const u = av(sp(SPA), "2026-08-01", "2026-09-30", cobMedida(SPA).map((j) => ({ ...j, concluidoEm: isoE(AGORA - 40 * DIA) })), { sinaisShopee: SEM_SINAIS, origem: "usuario" });
    const js = u.necessidades.map((n) => n.job);
    const l = JM.limitesDaJanela("2026-08-01", "2026-09-30")!;
    assert(js.length > 1 && js.every((j) => dur(j) <= 14 * DIA) && js.some((j) => dur(j) === 14 * DIA), JSON.stringify(js.map((j) => [j.inicio, j.fim])));
    assert(js.some((j) => j.fim === l.fim.toISOString()), "fim do periodo");
  });
  t("CE21-6. pendência de não pagos em VÁRIOS pedaços: a rodada avança (nunca repete o pedaço), espera 30 min ao fechar, esgota VISÍVEL na 3a — nunca laço", () => {
    // densidade alta medida (1M em 108 dias, metade com escrow): o refresh de UM dia vira varios pedaços
    const cob = jobSP(SPA, "2026-06-20T03:00:00.000Z", isoE(FIM_COB), { listados: 1_000_000, escrowsNecessarios: 500_000, criadoEm: d(2.1), concluidoEm: d(2) });
    const faixa = { inicio: "2026-10-04T03:00:00.000Z", fim: "2026-10-05T03:00:00.000Z", ultimaObservacao: d(1.5) };
    const sinais = { escrowPendentes: 0, naoObservadosAposPeriodo: 1, faixasPendentes: [faixa] };
    let agora = AGORA; const feitos: JobExistenteSync[] = [];
    const avaliar = () => P.avaliarLoja({ loja: sp(SPA), de: "2026-07-08", ate: "2026-10-05", agoraMs: agora, jobs: [cob, ...feitos], politica: { ...POL, faixas: [{ idadeMaxDias: 7, intervaloMs: 400 * H }, { idadeMaxDias: 90, intervaloMs: 400 * H }] }, origem: "background", sinaisShopee: sinais });
    const rodada = () => { const vistos = new Set<string>(); let n = 0;
      for (;;) { const l = avaliar(); const j = jobDa(l);
        if (!j) return { n, fim: l };
        assert(j.proposito === "refresh" && Date.parse(j.inicio!) >= Date.parse(faixa.inicio) && Date.parse(j.fim!) <= Date.parse(faixa.fim), `fora da faixa ${j.inicio}→${j.fim}`);
        assert(!vistos.has(j.chave), `pedaço repetido na rodada: ${j.inicio}→${j.fim}`); vistos.add(j.chave); n++;
        // roda e conclui, mas o pedido continua sem observacao (falha no detalhe)
        // a mesma densidade da cobertura (o pedaço mede o que ela media): o proximo pedaço continua pequeno
        const qtd = Math.round(1_000_000 * dur(j) / (108 * DIA));
        feitos.push(jobSP(SPA, j.inicio!, j.fim!, { criadoEm: isoE(agora), concluidoEm: isoE(agora + 60e3), listados: qtd, escrowsNecessarios: Math.round(qtd / 2) })); agora += 2 * 60e3; } };
    const r1 = rodada();
    assert(r1.n > 1 && r1.fim.proximaAcao.acao === "WAIT_RETRY", `${r1.n} ${resumo(r1.fim)}`);
    agora += 31 * 60e3; const r2 = rodada(); assert(r2.n === r1.n && r2.fim.proximaAcao.acao === "WAIT_RETRY", `${r2.n} ${resumo(r2.fim)}`);
    agora += 31 * 60e3; const r3 = rodada();
    assert(r3.fim.proximaAcao.acao === "FAILED" && r3.fim.motivos.includes("pendencia_nao_pagos_sem_efeito") && r3.fim.frescor === "STALE", `${r3.n} ${resumo(r3.fim)} ${r3.fim.motivos}`);
    agora += 31 * 60e3; const r4 = avaliar(); assert(r4.proximaAcao.acao === "FAILED" && !jobDa(r4), resumo(r4));
  });
  t("CE21-7. refresh: a fração de escrow MEDIDA pelo último job do trecho manda no tamanho (muito escrow → pedaço menor)", () => {
    // periodo de manutencao inteiro COBERTO (de 15/07: necessario desde 05/07) e observado ha 8 h → so o frescor ≤7 dias vence
    const comF = (f: number) => { const l = av(sp(SPA), "2026-07-15", "2026-10-05",
      cobMedida(SPA, 1000, { escrowsNecessarios: 0 }).map((j) => ({ ...j, escrowsNecessarios: Math.round(j.listados! * f), concluidoEm: isoE(AGORA - 8 * H), criadoEm: isoE(AGORA - 9 * H) })),
      { sinaisShopee: SEM_SINAIS, origem: "background" }); return jobDa(l)!; };
    const muito = comF(0.9), pouco = comF(0.01);
    assert(muito.proposito === "refresh" && pouco.proposito === "refresh" && muito.fim === pouco.fim && dur(muito) < dur(pouco), `${dur(muito) / H} h vs ${dur(pouco) / H} h`);
    // 1% medido fica no PISO (5%): o pedaço e o do piso, nunca o de 1%
    const L = (f: number) => TAM.alvoFatias / ((1000 * TAM.fatorSeguranca / DIA) * custo(f));
    const ini = (f: number) => isoE(Math.floor((Date.parse(pouco.fim!) - L(f)) / H) * H);
    assert(pouco.inicio === ini(TAM.pisoFracaoEscrow) && muito.inicio === ini(0.9), `${pouco.inicio} ${muito.inicio}`);
  });
  t("CE21-12. refresh pesa CADA pedaço pela medida do job que o contém: trecho calmo atravessa inteiro, o de campanha limita; trecho sem medida usa a vizinhança (nunca zero)", () => {
    // cobertura de 1.000/dia observada ha 9 h; os dois jobs mais NOVOS (7 h) medem 100/dia e 10.000/dia nos trechos deles
    const velho = { concluidoEm: isoE(AGORA - 9 * H), criadoEm: isoE(AGORA - 10 * H) }, novo = { concluidoEm: isoE(AGORA - 7 * H), criadoEm: isoE(AGORA - 8 * H) };
    const calmo = (o: Partial<JobExistenteSync> = {}) => jobSP(SPA, "2026-10-03T03:00:00.000Z", isoE(FIM_COB), { listados: 300, escrowsNecessarios: 0, ...novo, ...o });
    const pico = jobSP(SPA, "2026-09-29T03:00:00.000Z", "2026-10-03T03:00:00.000Z", { listados: 40_000, escrowsNecessarios: 0, ...novo });
    // semMedida: o trecho calmo so tem jobs SEM contador (o ultimo bloco da cobertura tambem) → densidade da vizinhanca
    const rodar = (js: JobExistenteSync[], semContador = false) => jobDa(av(sp(SPA), "2026-07-15", "2026-10-05",
      [...cobMedida(SPA).map((j) => ({ ...j, ...velho, ...(semContador && j.janelaFim === isoE(FIM_COB) ? { listados: null, escrowsNecessarios: null } : {}) })), ...js],
      { sinaisShopee: SEM_SINAIS, origem: "background" }))!;
    const medido = rodar([calmo(), pico]);
    assert(medido.proposito === "refresh" && medido.fim === isoE(FIM_COB) && Date.parse(medido.inicio!) < Date.parse("2026-10-03T03:00:00.000Z")
      && Date.parse(medido.inicio!) > Date.parse("2026-10-02T03:00:00.000Z"), `${medido.inicio}`);
    const semMedida = rodar([calmo({ listados: null, escrowsNecessarios: null }), pico], true);
    assert(semMedida.fim === isoE(FIM_COB) && Date.parse(semMedida.inicio!) > Date.parse("2026-10-03T03:00:00.000Z"), `${semMedida.inicio}`);
  });
  t("CE21-8. fechamento do dia anterior que o INTRADAY já viu usa a fração medida (pedaço maior); trecho nunca visto assume escrow de todos", () => {
    const ontem0 = Date.parse("2026-10-05T03:00:00.000Z");
    const cob = cobMedida(SPA).filter((j) => Date.parse(j.janelaFim!) <= ontem0).concat(jobSP(SPA, isoE(Date.parse("2026-09-29T03:00:00.000Z")), isoE(ontem0), { listados: 6000, escrowsNecessarios: 60, criadoEm: isoE(AGORA - 3 * H) }));
    const viu: JobExistenteSync[] = []; for (let a = ontem0; a < FIM_COB - 15 * 60e3; a += 30 * 60e3) viu.push(intra(SPA, a, Math.min(a + 30 * 60e3, FIM_COB - 15 * 60e3)));
    const semIntra = jobDa(av(sp(SPA), "2026-07-08", "2026-10-05", cob, { sinaisShopee: SEM_SINAIS, origem: "background" }))!;
    const comIntra = jobDa(av(sp(SPA), "2026-07-08", "2026-10-05", [...cob, ...viu], { sinaisShopee: SEM_SINAIS, origem: "background" }))!;
    assert(semIntra.proposito === "descoberta" && comIntra.proposito === "descoberta" && semIntra.fim === isoE(FIM_COB) && comIntra.fim === isoE(FIM_COB) && dur(comIntra) > dur(semIntra),
      `${dur(semIntra) / H} h vs ${dur(comIntra) / H} h`);
    // FECHAMENTO (D15B): o dia que o intraday ja viu (ate 23:45) e UM job do dia inteiro; visto pela metade, nao
    // (densidade vizinha alta, 10.000/dia: o dia visto continua inteiro; o visto pela metade e dimensionado)
    const denso = cob.map((j) => (j.janelaFim === isoE(ontem0) ? { ...j, listados: 60_000 } : j));
    const cheio = jobDa(av(sp(SPA), "2026-07-08", "2026-10-05", [...denso, ...viu], { sinaisShopee: SEM_SINAIS, origem: "background" }))!;
    assert(comIntra.inicio === isoE(ontem0) && cheio.inicio === isoE(ontem0) && dur(cheio) === DIA, `${comIntra.inicio} ${cheio.inicio}`);
    const metade = jobDa(av(sp(SPA), "2026-07-08", "2026-10-05", [...denso, ...viu.filter((j) => Date.parse(j.janelaFim!) <= ontem0 + 12 * H)], { sinaisShopee: SEM_SINAIS, origem: "background" }))!;
    assert(metade.fim === isoE(FIM_COB) && dur(metade) < DIA, `${metade.inicio}`);
    // o intraday NAO e referencia de densidade (janela de 30 min re-detalha candidatos; listados dele nao medem a janela)
    const viuMuito = viu.map((j) => ({ ...j, listados: 50_000, escrowsNecessarios: 50_000 }));
    const comIntraMuito = jobDa(av(sp(SPA), "2026-07-08", "2026-10-05", [...cob, ...viuMuito], { sinaisShopee: SEM_SINAIS, origem: "background" }))!;
    assert(comIntraMuito.chave === comIntra.chave, `${comIntraMuito.inicio} vs ${comIntra.inicio}`);
  });
  t("CE21-9. isolamento: densidade/escrow/intraday de OUTRA loja (e do ML) não mudam o pedaço desta", () => {
    const so = jobDa(bootAno(cobMedida()))!;
    const outra = [...cobMedida(SPB, 50_000).map((j) => ({ ...j, escrowsNecessarios: j.listados })), jobML(MLA, "2026-06-25", "2026-06-29", { listados: 900_000 } as any),
      jobSP(SPB, "2026-06-29T03:00:00.000Z", isoE(FIM_HIST), { listados: 999_999 }), intra(SPB, FIM_HIST - 12 * H, FIM_HIST - 11 * H, { listados: 5 })];
    const com = jobDa(bootAno([...cobMedida(), ...outra]))!;
    assert(so.chave === com.chave, `${so.inicio} vs ${com.inicio}`);
    // intraday da PROPRIA loja perto do historico nao e referencia de densidade (30 min re-detalhando candidatos)
    const comIntraProprio = jobDa(bootAno([...cobMedida(), intra(SPA, FIM_HIST + 2 * H, FIM_HIST + 3 * H, { listados: 50_000, escrowsNecessarios: 50_000 })]))!;
    assert(so.chave === comIntraProprio.chave, `${so.inicio} vs ${comIntraProprio.inicio}`);
  });
  t("CE21-10. lerJobsDasLojas: listados/escrows vêm de progresso (texto do ->>); inválido ou ausente = null (desconhecido, nunca 0)", async () => {
    const rows = [["50", 5], ["abc", null], [-1, null], [1.5, null], [undefined, undefined]].map(([l, e], i) =>
      linhaSP(SPA, isoE(FIM_HIST + i * H), isoE(FIM_HIST + (i + 1) * H), { id: `ce10-${i}`, progresso: l === undefined ? null : { listados: l, escrow_necessarios: e } }));
    const lidos = await C.lerJobsDasLojas(bancoFalso(lojasBase(), rows).cliente, UID, [SPA]);
    const por = Object.fromEntries(lidos.map((j) => [j.id, [j.listados, j.escrowsNecessarios]]));
    assert(JSON.stringify(por) === JSON.stringify({ "ce10-0": [50, 5], "ce10-1": [null, null], "ce10-2": [null, null], "ce10-3": [null, null], "ce10-4": [null, null] }), JSON.stringify(por));
  });
  t("CE21-11. determinístico/idempotente: mesmo estado em ticks diferentes → MESMA chave; a chave muda só quando um pedaço conclui", () => {
    const a1 = jobDa(bootAno(cobMedida(), AGORA))!, a2 = jobDa(bootAno(cobMedida(), AGORA + 10 * 60e3))!, a3 = jobDa(bootAno(cobMedida(), AGORA + 3 * H))!;
    assert(a1.chave === a2.chave && a2.chave === a3.chave, `${a1.chave} / ${a2.chave} / ${a3.chave}`);
  });
  t("CB-D15B. cadeia de exceções EXATA: atual − E21 = 5e135e6, − P1 = 8978451 e − D15B = d631748 (byte a byte), nos 3 arquivos de sync tocados", () => {
    const tmp = mkdtempSync(join(RAIZ, ".tmp-excecao-p1-")), tmpE = mkdtempSync(join(RAIZ, ".tmp-excecao-e21-"));
    try {
      const TRES = JSON.stringify(["lib/vendas/sync/coordenador.ts", "lib/vendas/sync/planejamento.ts", "lib/vendas/sync/tipos.ts"]);
      assert(JSON.stringify(Object.keys(PATCH_E21).sort()) === TRES, "excecao E21 cobre arquivo a mais/a menos");
      for (const f of Object.keys(PATCH_P1)) {
        // E2.1: atual − E21 = 5e135e6 (byte a byte) e SO esse resultado entra na cadeia P1 → D15B
        const e21 = reconstruirBaseE21(RAIZ, f);
        assert(e21.valido, `${f}: ${e21.motivo}`);
        mkdirSync(join(tmpE, f, ".."), { recursive: true });
        writeFileSync(join(tmpE, f), reverterE21(RAIZ, f)!, "utf8");
        const p1 = reconstruirBaseP1(tmpE, f);
        assert(p1.valido, `${f}: cadeia P1 ${p1.motivo}`);
        mkdirSync(join(tmp, f, ".."), { recursive: true });
        writeFileSync(join(tmp, f), reverterP1(tmpE, f)!, "utf8");
        const d15b = reconstruirBaseD15B(tmp, f);
        assert(d15b.valido, `${f}: cadeia D15B ${d15b.motivo}`);
      }
      assert(JSON.stringify(Object.keys(PATCH_P1).sort()) === TRES, "excecao P1 cobre arquivo a mais/a menos");
      assert(reconstruirBaseD15B(RAIZ, "lib/vendas/sync/coordenador-tick.ts").valido, "coordenador-tick.ts saiu da D15B");
    } finally { rmSync(tmp, { recursive: true, force: true }); rmSync(tmpE, { recursive: true, force: true }); }
  });

  t("CP-10. o coordenador só LÊ sync_jobs por lerJanelasSyncJobs (as outras referências são escrita: insert); nenhum select solto", () => {
    const src = readFileSync(join(RAIZ, "lib/vendas/sync/coordenador.ts"), "utf8").replace(/\r\n/g, "\n");
    const usos = [...src.matchAll(/\.from\("sync_jobs"\)/g)].map((m) => ({ antes: src.slice(Math.max(0, m.index! - 120), m.index!), depois: src.slice(m.index!, m.index! + 30) }));
    assert(usos.length >= 2, `${usos.length}`);
    for (const u of usos) assert(/\.insert\(/.test(u.depois) || /lerJanelasSyncJobs<Record<string, any>>\("coordenador_jobs", \(apos, limite\) => \{\s*let q = cliente$/.test(u.antes), `leitura solta: ${u.depois}`);
  });

  await fila;
  console.log(`\n${falhou === 0 ? "✓" : "✗"} VENDAS-SYNC-COORDENADOR — ${passou} passaram, ${falhou} falharam`);
  process.exit(falhou === 0 ? 0 : 1);
}
principal().catch((e) => { console.error("ERRO FATAL", e); process.exit(1); });
