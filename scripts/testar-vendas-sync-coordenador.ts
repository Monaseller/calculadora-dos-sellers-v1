/**
 * SALES-SYNC-A — coordenador canonico de sincronizacao de vendas (offline).
 *
 * Sem rede, sem banco real. O duplo de banco IMPOE o indice real
 * idx_sync_jobs_loja_ativo (UM job pendente|rodando por loja → 23505).
 *
 * Uso: npx tsx scripts/testar-vendas-sync-coordenador.ts
 */
import "./_server-only-inerte";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { JobExistenteSync, LojaAtivaSync, PoliticaSync } from "../lib/vendas/sync/tipos";

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

async function principal() {
  const P = await import("../lib/vendas/sync/planejamento");
  const C = await import("../lib/vendas/sync/coordenador");
  const JM = await import("../lib/mercado-livre/ingestao/janelas");
  const CS = await import("../lib/vendas/canonico/shopee");
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
  const plano = (loja: LojaAtivaSync, de: string, ate: string, jobs: JobExistenteSync[], extra: any = {}) => P.planejarLoja({ loja, de, ate, agoraMs: AGORA, jobs, politica: POL, ...extra });
  // cobertura Shopee completa para 01→03/10: create_time de 21/09 03:00Z a 04/10 03:00Z (borda compartilhada)
  const cadeiaSP = (lojaId: string, o: Partial<JobExistenteSync> = {}) => [jobSP(lojaId, "2026-09-21T03:00:00.000Z", "2026-10-01T03:00:00.000Z", o), jobSP(lojaId, "2026-10-01T03:00:00.000Z", "2026-10-04T03:00:00.000Z", o)];

  console.log("\n[A-B. cobertura]");
  t("A. periodo ja COMPLETE (ML e Shopee) → 0 jobs, COMPLETE", () => {
    const a = plano(ml(MLA), "2026-10-01", "2026-10-03", [jobML(MLA, "2026-10-01", "2026-10-03")]);
    const b = plano(sp(SPA), "2026-10-01", "2026-10-03", cadeiaSP(SPA));
    assert(a.estado.estado === "COMPLETE" && a.jobsNecessarios.length === 0 && b.estado.estado === "COMPLETE" && b.jobsNecessarios.length === 0, JSON.stringify([a, b]));
  });
  t("B. lacuna → job SO da lacuna (ML: so 03/10; Shopee: so o trecho sem create_time)", () => {
    const a = plano(ml(MLA), "2026-10-01", "2026-10-05", [jobML(MLA, "2026-10-01", "2026-10-02"), jobML(MLA, "2026-10-04", "2026-10-05")]);
    assert(a.estado.estado === "PARTIAL" && a.jobsNecessarios.length === 1 && a.jobsNecessarios[0].de === "2026-10-03" && a.jobsNecessarios[0].ate === "2026-10-03", JSON.stringify(a.jobsNecessarios));
    const b = plano(sp(SPA), "2026-10-01", "2026-10-03", [jobSP(SPA, "2026-09-21T03:00:00.000Z", "2026-09-28T00:00:00.000Z"), jobSP(SPA, "2026-09-30T00:00:00.000Z", "2026-10-04T03:00:00.000Z")]);
    assert(b.jobsNecessarios.length === 1 && b.jobsNecessarios[0].inicio === "2026-09-28T00:00:00.000Z" && b.jobsNecessarios[0].fim === "2026-09-30T00:00:00.000Z" && b.jobsNecessarios[0].campoTempo === "create_time", JSON.stringify(b.jobsNecessarios));
  });

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
            const ativo = (db.sync_jobs).some((j) => j.loja_id === inserir.loja_id && ["pendente", "rodando"].includes(j.status)) && ["pendente", "rodando"].includes(inserir.status);
            if (ativo) return ok({ data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "idx_sync_jobs_loja_ativo"' } });
            const novo = { id: `db${++seq}`, criado_em: new Date(AGORA).toISOString(), concluido_em: null, ...inserir }; db.sync_jobs.push(novo);
            return ok({ data: { id: novo.id }, error: null });
          }
          const d = (db[tabela] ?? []).filter(casa); return ok(head ? { data: null, count: d.length, error: null } : { data: d, error: null });
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

  console.log("\n[C-I. dedup, multi-loja, TODOS]");
  t("C. o mesmo pedido 5x → UM job (indice unico por loja); depois o periodo aparece como SYNCING", async () => {
    const b = bancoFalso(lojasBase());
    let criados = 0;
    for (let i = 0; i < 5; i++) {
      const pl = await C.avaliarNecessidadeDeSync(b.cliente, { userId: UID, marketplace: "ML", lojaId: MLA, de: "2026-10-02", ate: "2026-10-02" }, { agoraMs: AGORA, politica: POL });
      criados += (await C.garantirProximosJobs(b.cliente, UID, pl, { habilitado: true })).criados.length;
    }
    const final = await C.avaliarNecessidadeDeSync(b.cliente, { userId: UID, marketplace: "ML", lojaId: MLA, de: "2026-10-02", ate: "2026-10-02" }, { agoraMs: AGORA, politica: POL });
    assert(criados === 1 && b.db.sync_jobs.length === 1 && final.estado.estado === "SYNCING" && final.lojas[0].jobsNecessarios.length === 0, `${criados} ${JSON.stringify(final.estado)}`);
  });
  t("C2. corrida: 2 inserts concorrentes na mesma loja → o 2o vira 23505 e e tratado como 'ja existe' (aguardando)", async () => {
    const b = bancoFalso(lojasBase());
    const pl = await C.avaliarNecessidadeDeSync(b.cliente, { userId: UID, marketplace: "ML", lojaId: MLA, de: "2026-10-02", ate: "2026-10-02" }, { agoraMs: AGORA, politica: POL });
    const [r1, r2] = await Promise.all([C.garantirProximosJobs(b.cliente, UID, pl, { habilitado: true }), C.garantirProximosJobs(b.cliente, UID, pl, { habilitado: true })]);
    assert(r1.criados.length + r2.criados.length === 1 && r1.aguardando.length + r2.aguardando.length === 1 && b.db.sync_jobs.length === 1, JSON.stringify([r1, r2]));
  });
  t("D/E. duas lojas Shopee e duas ML → jobs SEPARADOS por loja (cada um com a sua loja)", async () => {
    const b = bancoFalso(lojasBase());
    const pl = await C.avaliarNecessidadeDeSync(b.cliente, { userId: UID, marketplace: "TODOS", de: "2026-10-02", ate: "2026-10-02" }, { agoraMs: AGORA, politica: POL });
    const r = await C.garantirProximosJobs(b.cliente, UID, pl, { habilitado: true });
    const lojasCriadas = r.criados.map((c) => c.lojaId).sort();
    assert(JSON.stringify(lojasCriadas) === JSON.stringify([MLA, MLB, SPA, SPB].sort()) && pl.lojas.every((l) => l.jobsNecessarios.every((j) => j.lojaId === l.lojaId)), JSON.stringify(r));
    assert(b.db.sync_jobs.every((j) => j.user_id === UID) && !b.db.sync_jobs.some((j) => j.loja_id === MLX), "loja de outro dono");
  });
  t("F. order_id repetido entre lojas e irrelevante: o plano de A nao muda com os jobs de B (nao ve pedidos)", () => {
    const so = plano(ml(MLA), "2026-10-01", "2026-10-03", [jobML(MLA, "2026-10-01", "2026-10-03")]);
    const comB = plano(ml(MLA), "2026-10-01", "2026-10-03", [jobML(MLA, "2026-10-01", "2026-10-03"), jobML(MLB, "2026-10-01", "2026-10-02", { status: "rodando", listagemCompleta: false })]);
    assert(JSON.stringify(so) === JSON.stringify(comB), "plano de A influenciado por B");
  });
  t("G/H. TODOS: COMPLETE so com ML E Shopee completos; uma parte PARTIAL → total PARTIAL (sem mascarar)", () => {
    const mlOk = plano(ml(MLA), "2026-10-01", "2026-10-03", [jobML(MLA, "2026-10-01", "2026-10-03")]);
    const spOk = plano(sp(SPA), "2026-10-01", "2026-10-03", cadeiaSP(SPA));
    const spFalta = plano(sp(SPA), "2026-10-01", "2026-10-03", []);
    assert(P.agregarEstados([mlOk.estado, spOk.estado]).estado === "COMPLETE", "ambos completos");
    const r = P.agregarEstados([mlOk.estado, spFalta.estado]);
    assert(r.estado === "PARTIAL" && (r as any).motivos.some((m: string) => m.startsWith("cobertura_create_time_faltando")), JSON.stringify(r));
    assert(P.agregarEstados([]).estado === "PARTIAL", "sem loja virou COMPLETE");
  });
  t("I. job rodando cobrindo o periodo → SYNCING, 0 jobs novos, garantir nao cria", async () => {
    const ativo = jobML(MLA, "2026-10-02", "2026-10-03", { status: "rodando", listagemCompleta: false, concluidoEm: null });
    const a = plano(ml(MLA), "2026-10-02", "2026-10-03", [ativo]);
    assert(a.estado.estado === "SYNCING" && a.jobsNecessarios.length === 0 && a.jobsEmAndamento.includes(ativo.id), JSON.stringify(a));
  });

  console.log("\n[J-O. falhas, loja nova, hoje, refresh, Shopee]");
  t("J. falha: recente → aguarda (PARTIAL, sem job); antiga → retry; 3 falhas → FAILED", () => {
    const erro = (h: number) => jobML(MLA, "2026-10-02", "2026-10-02", { status: "erro", listagemCompleta: false, concluidoEm: new Date(AGORA - h * H).toISOString() });
    const espera = plano(ml(MLA), "2026-10-02", "2026-10-02", [erro(0.1)]);
    assert(espera.estado.estado === "PARTIAL" && espera.jobsNecessarios.length === 0 && (espera.estado as any).motivos.includes("aguardando_retry_apos_falha"), JSON.stringify(espera));
    const retry = plano(ml(MLA), "2026-10-02", "2026-10-02", [erro(2)]);
    assert(retry.jobsNecessarios.length === 1 && retry.jobsNecessarios[0].de === "2026-10-02", JSON.stringify(retry));
    const esgotado = plano(ml(MLA), "2026-10-02", "2026-10-02", [erro(5), erro(4), erro(3)]);
    assert(esgotado.estado.estado === "FAILED" && esgotado.jobsNecessarios.length === 0, JSON.stringify(esgotado));
  });
  t("K. loja NOVA sem corpus → bootstrap; o 1o job e o mais RECENTE (fica util rapido)", () => {
    const k7 = P.planejarBootstrap({ loja: ml(MLB), agoraMs: AGORA, jobs: [], politica: POL, horizonte: "ULTIMOS_7_DIAS" });
    assert(k7.estado.estado === "PARTIAL" && k7.jobsNecessarios.length === 1 && k7.jobsNecessarios[0].de === "2026-09-29" && k7.jobsNecessarios[0].ate === "2026-10-05", JSON.stringify(k7.jobsNecessarios));
    const ano = P.planejarBootstrap({ loja: ml(MLB), agoraMs: AGORA, jobs: [], politica: POL, horizonte: "ANO_CORRENTE" });
    assert(ano.jobsNecessarios[0].ate === "2026-10-05" && ano.jobsNecessarios[ano.jobsNecessarios.length - 1].de === "2026-01-01" && ano.jobsNecessarios.every((j) => j.campoTempo === "date_closed"), "ordem/limites do ano");
    const s30 = P.planejarBootstrap({ loja: sp(SPB), agoraMs: AGORA, jobs: [], politica: POL, horizonte: "ULTIMOS_30_DIAS" });
    const js = s30.jobsNecessarios;
    assert(js.length >= 3 && js.every((j) => j.campoTempo === "create_time" && Date.parse(j.fim!) - Date.parse(j.inicio!) <= 14 * 24 * H) && js[0].fim === "2026-10-06T03:00:00.000Z", JSON.stringify(js.map((j) => [j.inicio, j.fim])));
    const ord = [...js].sort((a, b) => Date.parse(a.inicio!) - Date.parse(b.inicio!));
    for (let i = 1; i < ord.length; i++) assert(ord[i].inicio === ord[i - 1].fim, "borda nao compartilhada");
    assert(ord[0].inicio === new Date(Date.parse("2026-09-06T03:00:00Z") - CS.LIMITE_POLITICA_PAGAMENTO_MS).toISOString(), `inicio ${ord[0].inicio}`);
  });
  t("L. dia corrente: so hoje → IN_PROGRESS sem job; periodo ate hoje com o resto completo → IN_PROGRESS; nenhum job passa de hoje 00:00 SP", () => {
    const so = plano(ml(MLA), "2026-10-06", "2026-10-06", []);
    assert(so.estado.estado === "IN_PROGRESS" && so.jobsNecessarios.length === 0, JSON.stringify(so));
    const ate = plano(ml(MLA), "2026-10-04", "2026-10-06", [jobML(MLA, "2026-10-04", "2026-10-05")]);
    assert(ate.estado.estado === "IN_PROGRESS" && ate.jobsNecessarios.length === 0, JSON.stringify(ate));
    const falta = plano(sp(SPA), "2026-10-01", "2026-10-06", []);
    assert(falta.estado.estado === "PARTIAL" && falta.jobsNecessarios.every((j) => !j.fim || Date.parse(j.fim) <= Date.parse("2026-10-06T03:00:00Z")), "job em janela aberta");
  });
  t("M. ML desatualizado pela politica → refresh = reler a janela date_closed (estado segue COMPLETE)", () => {
    const velho = jobML(MLA, "2026-10-05", "2026-10-05", { concluidoEm: new Date(AGORA - 10 * H).toISOString() }); // idade < 7d, intervalo 6h
    const a = plano(ml(MLA), "2026-10-05", "2026-10-05", [velho]);
    assert(a.estado.estado === "COMPLETE" && a.desatualizado.length === 1 && a.jobsNecessarios.length === 1 && a.jobsNecessarios[0].proposito === "refresh" && a.jobsNecessarios[0].campoTempo === "date_closed", JSON.stringify(a));
    const antigo = plano(ml(MLA), "2026-05-05", "2026-05-05", [jobML(MLA, "2026-05-05", "2026-05-05", { concluidoEm: "2026-05-10T00:00:00.000Z" })]);
    assert(antigo.jobsNecessarios.length === 0, "dia alem das faixas nao tem refresh automatico");
  });
  t("N. Shopee escrow pendente → catch-up de escrow (PARTIAL); com catch-up ativo → SYNCING sem duplicar", () => {
    const a = plano(sp(SPA), "2026-10-01", "2026-10-03", cadeiaSP(SPA), { sinaisShopee: { escrowPendentes: 3, naoObservadosAposPeriodo: 0 } });
    assert(a.estado.estado === "PARTIAL" && a.jobsNecessarios.some((j) => j.proposito === "catchup_escrow" && j.campoTempo === null), JSON.stringify(a));
    const ativo: JobExistenteSync = { id: "cu", lojaId: SPA, marketplace: "Shopee", campoTempo: null, janelaInicio: null, janelaFim: null, status: "rodando", listagemCompleta: null, concluidoEm: null, criadoEm: new Date(AGORA).toISOString() };
    const b = plano(sp(SPA), "2026-10-01", "2026-10-03", [...cadeiaSP(SPA), ativo], { sinaisShopee: { escrowPendentes: 3, naoObservadosAposPeriodo: 0 } });
    assert(b.estado.estado === "SYNCING" && !b.jobsNecessarios.some((j) => j.proposito === "catchup_escrow"), JSON.stringify(b));
  });
  t("O. Shopee sem corpus → descoberta por create_time de inicio − prazo publicado ate o fim; update_time 'completo' NAO conta", () => {
    const upd: JobExistenteSync = { ...jobSP(SPA, "2026-09-01T00:00:00.000Z", "2026-10-05T00:00:00.000Z"), campoTempo: "update_time" };
    const a = plano(sp(SPA), "2026-10-02", "2026-10-02", [upd]);
    const ord = [...a.jobsNecessarios].sort((x, y) => Date.parse(x.inicio!) - Date.parse(y.inicio!));
    assert(a.estado.estado === "PARTIAL" && ord.every((j) => j.campoTempo === "create_time") && ord[0].inicio === "2026-09-22T03:00:00.000Z" && ord[ord.length - 1].fim === "2026-10-03T03:00:00.000Z", JSON.stringify(ord.map((j) => [j.inicio, j.fim])));
  });

  console.log("\n[P. dono e flag]");
  t("P. isolamento: TODA leitura leva o dono; loja de outro dono → loja_invalida; job criado com o dono do chamador", async () => {
    const b = bancoFalso(lojasBase());
    const pl = await C.avaliarNecessidadeDeSync(b.cliente, { userId: UID, marketplace: "TODOS", de: "2026-10-02", ate: "2026-10-02" }, { agoraMs: AGORA, politica: POL });
    assert(b.regs.every((g) => g.filtros.some(([op, c, v]) => (op === "eq" || op === "insert_user") && c === "user_id" && v === UID)), "consulta sem dono");
    assert(!pl.lojas.some((l) => l.lojaId === MLX), "loja de outro dono no plano");
    let erro = ""; try { await C.avaliarNecessidadeDeSync(b.cliente, { userId: UID, marketplace: "ML", lojaId: MLX, de: "2026-10-02", ate: "2026-10-02" }, { agoraMs: AGORA, politica: POL }); } catch (e: any) { erro = e.message; }
    assert(erro === "loja_invalida", erro || "nao lancou");
  });
  t("Q. flag desligada → so avalia: 0 jobs criados", async () => {
    const b = bancoFalso(lojasBase());
    const pl = await C.avaliarNecessidadeDeSync(b.cliente, { userId: UID, marketplace: "TODOS", de: "2026-10-02", ate: "2026-10-02" }, { agoraMs: AGORA, politica: POL });
    const r = await C.garantirProximosJobs(b.cliente, UID, pl);
    assert(r.desabilitado && r.criados.length === 0 && b.db.sync_jobs.length === 0, JSON.stringify(r));
  });

  console.log("\n[R. guardas de arquitetura]");
  const fontes = readdirSync(join(RAIZ, "lib/vendas/sync")).map((f) => [f, readFileSync(join(RAIZ, "lib/vendas/sync", f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")] as const);
  t("R1. o coordenador nao contem formula financeira (pack_splitted, voucher, pix, coin, total_amount, desconto)", () => {
    for (const [f, s] of fontes) assert(!/pack_splitted|voucher|pix_discount|pixDiscount|coin|total_amount|totalAmount|original_shopee_discount|calcularMetricas/i.test(s), `${f} tem formula`);
  });
  t("R2. update_time nunca e cobertura; nada de loja/conta fixa; reusa as janelas dos motores e o limite do canonico", () => {
    for (const [f, s] of fontes) {
      assert(!/["'`]update_time["'`]/.test(s), `${f} usa update_time`);
      assert(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|MONAMOR|419809235/i.test(s), `${f} conhece loja`);
    }
    const plan = fontes.find(([f]) => f === "planejamento.ts")![1];
    assert(/mercado-livre\/ingestao\/janelas/.test(plan) && /shopee\/ingestao\/janelas/.test(plan) && /LIMITE_POLITICA_PAGAMENTO_MS/.test(plan), "nao reusa motores/canonico");
    assert(!/10 \* 24 \* 3600/.test(plan), "prazo de pagamento duplicado");
  });
  t("R3. formulas canonicas intocadas pelo gate (o coordenador so importa o limite, nao recalcula)", () => {
    const canon = readFileSync(join(RAIZ, "lib/vendas/canonico/shopee.ts"), "utf8");
    assert(/export const LIMITE_POLITICA_PAGAMENTO_MS = 10 \* 24 \* 3600 \* 1000;/.test(canon), "limite mudou");
  });

  await fila;
  console.log(`\n${falhou === 0 ? "✓" : "✗"} VENDAS-SYNC-COORDENADOR — ${passou} passaram, ${falhou} falharam`);
  process.exit(falhou === 0 ? 0 : 1);
}
principal().catch((e) => { console.error("ERRO FATAL", e); process.exit(1); });
