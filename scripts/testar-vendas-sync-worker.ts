/**
 * SALES-SYNC-B1 — worker canonico de vendas (offline).
 *
 * Sem rede, sem banco real. O duplo de banco executa cada builder de forma
 * atomica (como uma instrucao SQL) e e compartilhado pelo worker e pelos
 * repositorios REAIS dos motores (criarRepositorioML / salvarJob Shopee),
 * entao status, checkpoint e heartbeat que o worker ve sao os que os
 * motores gravaram.
 *
 * Uso: npx tsx scripts/testar-vendas-sync-worker.ts
 */
import "./_server-only-inerte";
import { execFileSync } from "node:child_process";
// SALES-CANONICAL-D13B: excecao EXATA — so os arquivos NOVOS do D13 em lib/vendas/canonico (D13_NEW_CANONICAL_FILES, inexistentes na base)
import { filtrarNovosCanonicosD13 } from "./_excecao-d13-vendas-canonicas";
// SALES-CANONICAL-D14B: excecao EXATA do patch D14 nos leitores (ATUAL − patch aprovado = bytes de 1c4fe29)
import { filtrarExcecaoD14 } from "./_excecao-d14-vendas-canonicas";
// SALES-SYNC-D15C2: excecao EXATA do motor intraday ML (worker.ts − hunks D15C = b260583; intraday.ts por sha256)
import { filtrarExcecaoD15C } from "./_excecao-d15c-ml-intraday";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RelogioFake, RepoFake, ShopeeFake, type PedidoFake } from "./fakes/shopee-ingestao-fake";
import type { TransporteML } from "../lib/mercado-livre/ingestao/tipos";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://127.0.0.1:9";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "anon-de-teste";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "service-de-teste";

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
const BASE = "dc6612d";
const AGORA = Date.parse("2026-10-06T17:00:00Z");
const UID = "dono-a", OUTRO = "dono-b";
const MLA = "11111111-1111-4111-8111-111111111111", SPA = "33333333-3333-4333-8333-333333333333", MLX = "55555555-5555-4555-8555-555555555555";
const MIN = 60_000;

// ── duplo de banco: select/update/upsert/insert atomicos por builder ──
type Linha = Record<string, any>;
function valor(l: Linha, c: string) { if (c === "checkpoint->>modo") return l.checkpoint?.modo ?? null; return l[c]; }
function bancoFalso(inicial: { lojas?: Linha[]; sync_jobs?: Linha[] } = {}) {
  const db: Record<string, Linha[]> = { lojas: inicial.lojas ?? [], sync_jobs: inicial.sync_jobs ?? [], ml_pedidos: [] };
  const log: { tabela: string; op: string; filtros: [string, string, unknown][]; patch?: Linha }[] = [];
  const ganchos: { antesDeUpdate?: (tabela: string, filtros: [string, string, unknown][], patch: Linha) => void } = {};
  const cliente: any = { from(tabela: string) {
    const filtros: [string, string, unknown][] = []; let op = "select"; let patch: Linha | null = null; let linhas: Linha[] | null = null;
    let colunas = "*"; let devolver = false; let unico: "single" | "maybe" | null = null; let ordem: [string, boolean] | null = null; let lim = Infinity; let conflito: string[] = [];
    const casa = (l: Linha) => filtros.every(([o, c, v]) => o === "eq" ? String(valor(l, c)) === String(v) : o === "in" ? (v as unknown[]).map(String).includes(String(valor(l, c)))
      : o === "is" ? (valor(l, c) ?? null) === v : o === "lt" ? valor(l, c) < (v as any) : true);
    const projetar = (l: Linha): Linha => { if (colunas.includes("modo:checkpoint->>modo")) return { ...l, modo: l.checkpoint?.modo ?? null }; return { ...l }; };
    const executar = () => {
      const tab = (db[tabela] ??= []);
      if (op === "insert") { for (const l of linhas!) tab.push({ ...l }); return { data: null, error: null }; }
      if (op === "upsert") {
        for (const l of linhas!) { const i = tab.findIndex((x) => conflito.every((c) => x[c] === l[c])); if (i >= 0) tab[i] = { ...tab[i], ...l }; else tab.push({ ...l }); }
        return { data: null, error: null };
      }
      if (op === "update") {
        ganchos.antesDeUpdate?.(tabela, filtros, patch!);
        const alvo = tab.filter(casa); for (const l of alvo) Object.assign(l, structuredClone(patch));
        return { data: devolver ? alvo.map((l) => ({ id: l.id })) : null, error: null };
      }
      let d = tab.filter(casa).map(projetar);
      if (ordem) { const [c, asc] = ordem; d.sort((a, b) => (String(a[c] ?? "") < String(b[c] ?? "") ? -1 : String(a[c] ?? "") > String(b[c] ?? "") ? 1 : 0) * (asc ? 1 : -1)); }
      d = d.slice(0, lim);
      if (unico === "single") return d.length === 1 ? { data: structuredClone(d[0]), error: null } : { data: null, error: { message: "nao_unico" } };
      if (unico === "maybe") return { data: d[0] ? structuredClone(d[0]) : null, error: null };
      return { data: structuredClone(d), error: null };
    };
    const q: any = {
      select(c = "*") { if (op === "update") devolver = true; else colunas = c; return q; },
      insert(l: Linha | Linha[]) { op = "insert"; linhas = Array.isArray(l) ? l : [l]; return q; },
      upsert(l: Linha[], o: { onConflict: string }) { op = "upsert"; linhas = l; conflito = o.onConflict.split(","); return q; },
      update(p: Linha) { op = "update"; patch = p; return q; },
      eq(c: string, v: unknown) { filtros.push(["eq", c, v]); return q; },
      in(c: string, v: unknown[]) { filtros.push(["in", c, v]); return q; },
      is(c: string, v: unknown) { filtros.push(["is", c, v]); return q; },
      lt(c: string, v: unknown) { filtros.push(["lt", c, v]); return q; },
      order(c: string, o?: { ascending?: boolean }) { ordem = [c, o?.ascending !== false]; return q; },
      limit(n: number) { lim = n; return q; },
      single() { unico = "single"; return q; },
      maybeSingle() { unico = "maybe"; return q; },
      then(ok: any, ko: any) {
        log.push({ tabela, op, filtros: [...filtros], ...(patch ? { patch } : {}) });
        return Promise.resolve().then(executar).then(ok, ko);
      },
    };
    return q;
  } };
  return { cliente, db, log, ganchos };
}

const lojas = (): Linha[] => [
  { id: MLA, user_id: UID, marketplace: "ML", ativo: true },
  { id: SPA, user_id: UID, marketplace: "Shopee", ativo: true },
  { id: MLX, user_id: OUTRO, marketplace: "ML", ativo: true },
];
let seq = 0;
const iso = (ms: number) => new Date(ms).toISOString();

async function principal() {
  const W = await import("../lib/vendas/sync/worker");
  const JM = await import("../lib/mercado-livre/ingestao/janelas");
  const PML = await import("../lib/mercado-livre/ingestao/persistencia");
  const PSP = await import("../lib/shopee/ingestao/persistencia");
  const MS = await import("../lib/shopee/ingestao/motor");
  const MW = await import("../lib/middleware-rotas");

  const jobML = (de: string, ate: string, o: Linha = {}): Linha => { const l = JM.limitesDaJanela(de, ate)!;
    return { id: `ml-${++seq}`, user_id: UID, loja_id: MLA, marketplace: "ML", tipo: "backfill", date_from: de, date_to: ate, status: "pendente",
      campo_tempo: "date_closed", janela_inicio: l.inicio.toISOString(), janela_fim: l.fim.toISOString(), listagem_completa: false,
      checkpoint: null, progresso: null, tentativas: 0, max_tentativas: 3, criado_em: iso(AGORA - 60 * MIN + seq), iniciado_em: null, heartbeat_em: null, concluido_em: null, ...o }; };
  const jobSP = (o: Linha = {}): Linha => ({ id: `sp-${++seq}`, user_id: UID, loja_id: SPA, marketplace: "Shopee", tipo: "backfill", date_from: "2026-10-01", date_to: "2026-10-01",
    status: "pendente", campo_tempo: "create_time", janela_inicio: "2026-10-01T03:00:00.000Z", janela_fim: "2026-10-02T03:00:00.000Z", listagem_completa: false,
    checkpoint: null, progresso: null, tentativas: 0, max_tentativas: 3, criado_em: iso(AGORA - 50 * MIN + seq), iniciado_em: null, heartbeat_em: null, concluido_em: null, ...o });
  const jobCU = (o: Linha = {}): Linha => jobSP({ id: `cu-${++seq}`, tipo: "incremental", campo_tempo: null, janela_inicio: null, janela_fim: null, listagem_completa: null,
    checkpoint: MS.checkpointCatchUpInicial(), ...o });
  const legado = (o: Linha = {}): Linha => ({ id: `leg-${++seq}`, user_id: UID, loja_id: SPA, marketplace: "Shopee", tipo: "incremental", date_from: "2026-10-05", date_to: "2026-10-06",
    status: "pendente", campo_tempo: null, janela_inicio: null, janela_fim: null, listagem_completa: null, checkpoint: null, progresso: null,
    tentativas: 0, max_tentativas: 3, criado_em: iso(AGORA - 90 * MIN), iniciado_em: null, heartbeat_em: null, concluido_em: null, ...o });

  /** motores-espiao: registram a chamada e PAUSAM (como o motor real: deixam `rodando`). */
  function espioes(comportamento: "pausar" | "lancar" = "pausar") {
    const chamadas: { motor: string; job: any; prazoMs: number }[] = [];
    const fazer = (motor: string) => async (job: any, _deps: any, op: any) => {
      chamadas.push({ motor, job: structuredClone(job), prazoMs: op.prazoMs });
      if (comportamento === "lancar") throw new Error("persistencia_ml:ml_pedidos:connection reset access_token=abcdefabcdefabcdefabcdefabcdefabcdef 12345678901234");
      return { estado: "pausado", motivo: "prazo", checkpoint: job.checkpoint, progresso: { paginas: 1, ultimo_erro: "2410ABCDEF: x" } };
    };
    return { chamadas, motores: { ml: fazer("ml") as any, shopee: fazer("shopee") as any, catchup: fazer("catchup") as any } };
  }
  const deps = (b: ReturnType<typeof bancoFalso>, extra: Partial<import("../lib/vendas/sync/worker").DepsWorker> = {}, relogio: { agoraMs(): number } = { agoraMs: () => AGORA }) => ({
    cliente: b.cliente, relogio,
    portasML: async () => ({ transporte: { listarDiaFechado: async () => { throw new Error("transporte nao esperado"); } } as TransporteML, repo: PML.criarRepositorioML(b.cliente) }),
    portasShopee: async () => ({ api: new ShopeeFake(new RelogioFake(AGORA)), repo: new RepoFake() }),
    ...extra,
  });
  const rodar = (b: ReturnType<typeof bancoFalso>, extra: any = {}, o: Partial<import("../lib/vendas/sync/worker").OpcoesWorker> = {}, relogio?: { agoraMs(): number }) =>
    W.executarWorkerCanonico(deps(b, extra, relogio), { orcamentoMs: 45_000, habilitado: true, ...o });
  const job = (b: ReturnType<typeof bancoFalso>, id: string) => b.db.sync_jobs.find((j) => j.id === id)!;

  console.log("\n[A-H. claim]");
  t("A. nenhum job → NO_JOB (nada escrito)", async () => {
    const b = bancoFalso({ lojas: lojas() }); const e = espioes();
    const r = await rodar(b, { motores: e.motores });
    assert(r.resultado === "NO_JOB" && e.chamadas.length === 0 && !b.log.some((g) => g.op !== "select"), JSON.stringify(r));
  });
  t("B. job LEGADO pendente (campo/janela/checkpoint NULL) → nao e reivindicado nem alterado", async () => {
    const l = legado(); const b = bancoFalso({ lojas: lojas(), sync_jobs: [l] }); const e = espioes(); const antes = JSON.stringify(l);
    const r = await rodar(b, { motores: e.motores });
    assert(r.resultado === "NO_JOB" && e.chamadas.length === 0 && JSON.stringify(job(b, l.id)) === antes, JSON.stringify(r));
  });
  t("C. job update_time → nao e reivindicado", async () => {
    const u = jobSP({ campo_tempo: ["update", "time"].join("_") }); const b = bancoFalso({ lojas: lojas(), sync_jobs: [u] }); const e = espioes();
    const r = await rodar(b, { motores: e.motores });
    assert(r.resultado === "NO_JOB" && job(b, u.id).status === "pendente" && e.chamadas.length === 0, JSON.stringify(r));
  });
  t("D. ML date_closed → claim (pendente→rodando, iniciado_em/heartbeat) e motor ML", async () => {
    const m = jobML("2026-10-02", "2026-10-02"); const b = bancoFalso({ lojas: lojas(), sync_jobs: [m] }); const e = espioes();
    const r = await rodar(b, { motores: e.motores });
    const claim = b.log.find((g) => g.op === "update" && g.patch?.status === "rodando")!;
    assert(r.resultado === "EXECUTADO" && r.tipo === "ML_DATE_CLOSED" && e.chamadas.map((c) => c.motor).join() === "ml" && claim.filtros.some(([o, c, v]) => o === "eq" && c === "status" && v === "pendente") && job(b, m.id).iniciado_em, JSON.stringify(r));
  });
  t("E. Shopee create_time → claim e motor Shopee", async () => {
    const s = jobSP(); const b = bancoFalso({ lojas: lojas(), sync_jobs: [s] }); const e = espioes();
    const r = await rodar(b, { motores: e.motores });
    assert(r.resultado === "EXECUTADO" && r.tipo === "SHOPEE_CREATE_TIME" && e.chamadas.map((c) => c.motor).join() === "shopee", JSON.stringify(r));
  });
  t("F. Shopee catch-up (checkpoint.modo) → claim e catch-up", async () => {
    const c = jobCU(); const b = bancoFalso({ lojas: lojas(), sync_jobs: [legado({ loja_id: MLX }), c] }); const e = espioes();
    const r = await rodar(b, { motores: e.motores });
    assert(r.resultado === "EXECUTADO" && r.tipo === "SHOPEE_ESCROW_CATCHUP" && r.job_id === c.id && e.chamadas.map((x) => x.motor).join() === "catchup", JSON.stringify(r));
  });
  t("G. 2 workers no MESMO job → 1 ganha, o outro perde o claim; UMA execucao", async () => {
    const m = jobML("2026-10-02", "2026-10-02"); const b = bancoFalso({ lojas: lojas(), sync_jobs: [m] }); const e = espioes();
    const rs = await Promise.all([rodar(b, { motores: e.motores }), rodar(b, { motores: e.motores })]);
    const res = rs.map((r) => r.resultado).sort();
    assert(e.chamadas.length === 1 && res.filter((x) => x === "EXECUTADO").length === 1 && rs.some((r) => r.resultado === "CLAIM_PERDIDO" || r.resultado === "NO_JOB"), JSON.stringify(res));
    const claims = b.log.filter((g) => g.op === "update" && g.patch?.status === "rodando");
    assert(claims.length === 2 && claims.every((g) => g.filtros.some(([o, c, v]) => o === "eq" && c === "status" && v === "pendente")), "claim nao condicional");
  });
  t("H. job ja RODANDO (batimento recente) → nao reivindica de novo", async () => {
    const m = jobML("2026-10-02", "2026-10-02", { status: "rodando", heartbeat_em: iso(AGORA - 2 * MIN), iniciado_em: iso(AGORA - 3 * MIN) });
    const b = bancoFalso({ lojas: lojas(), sync_jobs: [m] }); const e = espioes();
    const r = await rodar(b, { motores: e.motores });
    assert(r.resultado === "NO_JOB" && e.chamadas.length === 0 && job(b, m.id).status === "rodando" && job(b, m.id).heartbeat_em === iso(AGORA - 2 * MIN), JSON.stringify(r));
  });

  console.log("\n[I-P. execucao]");
  // ── ML real: transporte falso no formato da API, repositorio REAL sobre o duplo ──
  function order(id: number, fechadoUtcMs: number, centavos: number) {
    const local = new Date(fechadoUtcMs - 3 * 3600e3).toISOString().replace("Z", "-03:00");
    return { id, date_closed: local, date_created: local, last_updated: local, total_amount: centavos / 100, status: "paid", order_items: [{ quantity: 1, unit_price: centavos / 100 }] };
  }
  const DIAS = ["2026-10-01", "2026-10-02", "2026-10-03"];
  const porDia: Record<string, any[]> = Object.fromEntries(DIAS.map((d, k) => [d, Array.from({ length: 20 }, (_, i) => order(3000000000 + k * 100 + i, Date.parse(`${d}T03:00:00Z`) + (i + 1) * 3600e3, 1000 + i))]));
  function transporteML(relogio: { andar(ms: number): void }, chamadas: Record<string, number>, passoMs = 10_000, falhar?: string): TransporteML {
    return { async listarDiaFechado({ dia }) {
      relogio.andar(passoMs); chamadas[dia] = (chamadas[dia] ?? 0) + 1;
      if (falhar) return { brutos: [], paginas: 0, completa: false, erro: falhar as any };
      // a borda do dia seguinte vem junto (como a API): o motor recorta
      const prox = DIAS[DIAS.indexOf(dia) + 1];
      return { brutos: [...porDia[dia], ...(prox ? porDia[prox].slice(0, 2) : [])], paginas: 1, completa: true, erro: null };
    } };
  }
  t("I. ML → motor OFICIAL ML com janela/dono da linha; L. termina → concluido + listagem_completa", async () => {
    const m = jobML("2026-10-01", "2026-10-03"); const b = bancoFalso({ lojas: lojas(), sync_jobs: [m] });
    const rel = new RelogioFake(AGORA); const ch: Record<string, number> = {};
    const r = await rodar(b, { portasML: async () => ({ transporte: transporteML(rel, ch), repo: PML.criarRepositorioML(b.cliente) }) }, {}, rel);
    const j = job(b, m.id);
    assert(r.resultado === "EXECUTADO" && r.fatia === "concluido" && r.status_posterior === "concluido" && j.status === "concluido" && j.listagem_completa === true && j.concluido_em, JSON.stringify(r));
    assert(b.db.ml_pedidos.length === 60 && b.db.ml_pedidos.every((p) => p.user_id === UID && p.loja_id === MLA), `ml_pedidos=${b.db.ml_pedidos.length}`);
    assert(JSON.stringify(j.checkpoint.diasConcluidos) === JSON.stringify(DIAS) && r.progresso?.diasConcluidos === 3, JSON.stringify(j.checkpoint));
  });
  t("J. Shopee create_time → motor OFICIAL Shopee (descoberta create_time, nunca update_time)", async () => {
    const s = jobSP(); const b = bancoFalso({ lojas: lojas(), sync_jobs: [s] });
    const rel = new RelogioFake(AGORA); const api = new ShopeeFake(rel, pedidosSP(30)); const repo = repoSP(b);
    const campos: string[] = []; const orig = api.listarPagina.bind(api); api.listarPagina = async (a) => { campos.push(a.campoTempo); return orig(a); };
    const r = await rodar(b, { portasShopee: async () => ({ api, repo }) }, { orcamentoMs: 10_000_000 }, rel);
    assert(r.resultado === "EXECUTADO" && r.fatia === "concluido" && job(b, s.id).status === "concluido" && job(b, s.id).listagem_completa === true && campos.every((c) => c === "create_time") && campos.length > 0, JSON.stringify(r));
    assert(repo.pedidos.size === 30, `pedidos ${repo.pedidos.size}`);
  });
  t("K. catch-up → executarFatiaCatchUpEscrow (sem relistar: 0 chamadas de listagem)", async () => {
    const c = jobCU(); const b = bancoFalso({ lojas: lojas(), sync_jobs: [c] });
    const rel = new RelogioFake(AGORA); const api = new ShopeeFake(rel, pedidosSP(5)); const repo = repoSP(b);
    for (const p of pedidosSP(5)) repo.pedidos.set(`${SPA}|${p.orderSn}`, { user_id: UID, loja_id: SPA, order_sn: p.orderSn, pay_time: iso(p.payTime! * 1000), update_time: iso(p.updateTime * 1000), escrow_fetched_at: null, escrow_update_time: null });
    const r = await rodar(b, { portasShopee: async () => ({ api, repo }) }, { orcamentoMs: 10_000_000 }, rel);
    assert(r.tipo === "SHOPEE_ESCROW_CATCHUP" && r.fatia === "concluido" && api.chamadas.listar === 0 && api.chamadas.escrow === 5 && job(b, c.id).status === "concluido" && job(b, c.id).checkpoint.modo === "escrow_catchup", JSON.stringify({ r, ch: api.chamadas }));
  });
  t("M. motor deixa checkpoint (pausa) → rodando→pendente, retomavel, listagem_completa=false (nunca COMPLETE falso)", async () => {
    const m = jobML("2026-10-01", "2026-10-03"); const b = bancoFalso({ lojas: lojas(), sync_jobs: [m] });
    const rel = new RelogioFake(AGORA); const ch: Record<string, number> = {};
    const r = await rodar(b, { portasML: async () => ({ transporte: transporteML(rel, ch), repo: PML.criarRepositorioML(b.cliente) }) }, { orcamentoMs: 25_000 }, rel);
    const j = job(b, m.id);
    assert(r.fatia === "pausado" && r.status_posterior === "pendente" && j.status === "pendente" && j.listagem_completa === false && j.concluido_em === null && j.checkpoint.diasConcluidos.length === 2, JSON.stringify({ r, j }));
    const transicao = b.log.filter((g) => g.op === "update" && g.patch?.status === "pendente").pop()!;
    assert(!("checkpoint" in transicao.patch!) && !("progresso" in transicao.patch!) && transicao.filtros.some(([o, c, v]) => o === "eq" && c === "status" && v === "rodando"), "transicao toca checkpoint ou nao e condicional");
  });
  t("N. motor LANCA → job erro consistente (concluido_em, mensagem sanitizada), checkpoint intacto, nunca rodando", async () => {
    const ck = { versao: 1, diasConcluidos: ["2026-10-01"], tentativas: {}, iniciadoEm: iso(AGORA - MIN) };
    const m = jobML("2026-10-01", "2026-10-03", { checkpoint: ck }); const b = bancoFalso({ lojas: lojas(), sync_jobs: [m] }); const e = espioes("lancar");
    const r = await rodar(b, { motores: e.motores });
    const j = job(b, m.id);
    assert(r.resultado === "ERRO" && j.status === "erro" && j.concluido_em && JSON.stringify(j.checkpoint) === JSON.stringify(ck), JSON.stringify(r));
    assert(!/abcdefabcdef|12345678901234|access_token/.test(j.erro_mensagem + JSON.stringify(r)) && /connection reset/.test(j.erro_mensagem), j.erro_mensagem);
  });
  t("N2. motor FALHA por conta (permanente) → o PROPRIO motor grava erro; worker nao reverte", async () => {
    const m = jobML("2026-10-02", "2026-10-02"); const b = bancoFalso({ lojas: lojas(), sync_jobs: [m] });
    const rel = new RelogioFake(AGORA);
    const r = await rodar(b, { portasML: async () => ({ transporte: transporteML(rel, {}, 1000, "nao_autorizado"), repo: PML.criarRepositorioML(b.cliente) }) }, {}, rel);
    assert(r.fatia === "falhou" && job(b, m.id).status === "erro" && job(b, m.id).listagem_completa === false && r.status_posterior === "erro", JSON.stringify(r));
  });
  t("O. cross-owner (job de A apontando loja de B) → recusa fechada, motor nunca chamado, job erro (loja nao fica presa)", async () => {
    const m = jobML("2026-10-02", "2026-10-02", { loja_id: MLX }); const b = bancoFalso({ lojas: lojas(), sync_jobs: [m] }); const e = espioes();
    const r = await rodar(b, { motores: e.motores });
    assert(r.resultado === "RECUSADO" && r.motivo === "loja_invalida" && e.chamadas.length === 0 && job(b, m.id).status === "erro", JSON.stringify(r));
  });
  t("P. loja errada (marketplace divergente / inativa / janela ou checkpoint incoerentes) → recusa", async () => {
    const casos: [Linha, string][] = [
      [jobML("2026-10-02", "2026-10-02", { loja_id: SPA }), "marketplace_divergente"],
      [jobSP({ checkpoint: { versao: 1, diasConcluidos: [] } }), "checkpoint_incompativel"],
      [jobML("2026-10-02", "2026-10-02", { date_to: "2026-10-04" }), "janela_inconsistente"],
      [jobML("2026-10-02", "2026-10-02", { checkpoint: MS.checkpointCatchUpInicial() }), "checkpoint_incompativel"],
    ];
    for (const [j, motivo] of casos) {
      const b = bancoFalso({ lojas: lojas(), sync_jobs: [j] }); const e = espioes();
      const r = await rodar(b, { motores: e.motores });
      assert(r.resultado === "RECUSADO" && r.motivo === motivo && e.chamadas.length === 0 && job(b, j.id).status === "erro", `${motivo}: ${JSON.stringify(r)}`);
    }
    const inativa = lojas().map((l) => (l.id === MLA ? { ...l, ativo: false } : l));
    const m = jobML("2026-10-02", "2026-10-02"); const b = bancoFalso({ lojas: inativa, sync_jobs: [m] }); const e = espioes();
    const r = await rodar(b, { motores: e.motores });
    assert(r.motivo === "loja_inativa" && e.chamadas.length === 0, JSON.stringify(r));
    const s = jobSP(); const b2 = bancoFalso({ lojas: lojas(), sync_jobs: [s] });
    const r2 = await rodar(b2, { portasShopee: async () => null });
    assert(r2.resultado === "RECUSADO" && r2.motivo === "credencial_indisponivel" && job(b2, s.id).status === "erro" && job(b2, s.id).erro_tipo === "auth", JSON.stringify(r2));
  });

  console.log("\n[Q-T. orcamento e fatia]");
  t("Q-T. orcamento: suficiente conclui; perto do limite para limpo; 2a invocacao continua do checkpoint; nada duplicado", async () => {
    const m = jobML("2026-10-01", "2026-10-03"); const b = bancoFalso({ lojas: lojas(), sync_jobs: [m] });
    const rel = new RelogioFake(AGORA); const ch: Record<string, number> = {};
    const portas = { portasML: async () => ({ transporte: transporteML(rel, ch), repo: PML.criarRepositorioML(b.cliente) }) };
    const r1 = await rodar(b, portas, { orcamentoMs: 25_000 }, rel);            // R
    const nPedidos = () => b.db.ml_pedidos.length;
    assert(r1.fatia === "pausado" && job(b, m.id).checkpoint.diasConcluidos.length === 2 && nPedidos() === 40, JSON.stringify(r1));
    const r2 = await rodar(b, portas, { orcamentoMs: 25_000 }, rel);            // S
    assert(r2.job_id === m.id && r2.fatia === "concluido" && job(b, m.id).status === "concluido" && job(b, m.id).listagem_completa === true, JSON.stringify(r2));
    assert(JSON.stringify(ch) === JSON.stringify({ "2026-10-01": 1, "2026-10-02": 1, "2026-10-03": 1 }), `dia relido: ${JSON.stringify(ch)}`);   // T
    assert(nPedidos() === 60 && new Set(b.db.ml_pedidos.map((p) => p.order_id)).size === 60, "pedido duplicado");
    const r3 = await rodar(b, portas, {}, rel);
    assert(r3.resultado === "NO_JOB", "job concluido reivindicado de novo");
  });
  t("R/S Shopee: pausa no meio da LISTAGEM → pendente, cursor salvo, listagem_completa=false; retoma sem duplicar", async () => {
    const s = jobSP(); const b = bancoFalso({ lojas: lojas(), sync_jobs: [s] });
    const rel = new RelogioFake(AGORA); const api = new ShopeeFake(rel, pedidosSP(250)); const repo = repoSP(b);
    const portas = { portasShopee: async () => ({ api, repo }) };
    const r1 = await rodar(b, portas, { orcamentoMs: 9_000 }, rel);
    const j1 = structuredClone(job(b, s.id));
    assert(r1.fatia === "pausado" && j1.status === "pendente" && j1.listagem_completa === false && j1.checkpoint.fase === "LIST" && j1.checkpoint.cursor && j1.checkpoint.paginasLidas === 2, JSON.stringify(j1.checkpoint).slice(0, 300));
    let k = 0; let r: any;
    do { r = await rodar(b, portas, { orcamentoMs: 10_000_000 }, rel); k++; } while (r.fatia === "pausado" && k < 10);
    const j = job(b, s.id);
    assert(r.fatia === "concluido" && j.status === "concluido" && j.listagem_completa === true && repo.pedidos.size === 250 && j.checkpoint.paginasLidas === 3, JSON.stringify({ r, p: repo.pedidos.size, pg: j.checkpoint.paginasLidas }));
  });

  console.log("\n[lease / job preso]");
  t("STUCK. canonico rodando com batimento VENCIDO → volta a fila (checkpoint intacto, tentativas+1) e e retomado", async () => {
    const ck = { versao: 1, diasConcluidos: ["2026-10-01"], tentativas: {}, iniciadoEm: iso(AGORA - 30 * MIN) };
    const m = jobML("2026-10-01", "2026-10-03", { status: "rodando", heartbeat_em: iso(AGORA - 11 * MIN), iniciado_em: iso(AGORA - 30 * MIN), checkpoint: ck });
    const b = bancoFalso({ lojas: lojas(), sync_jobs: [m] }); const e = espioes();
    const r = await rodar(b, { motores: e.motores });
    assert(r.recuperados === 1 && r.job_id === m.id && e.chamadas.length === 1 && JSON.stringify(e.chamadas[0].job.checkpoint) === JSON.stringify(ck) && job(b, m.id).tentativas === 1, JSON.stringify(r));
  });
  t("STUCK2. batimento RECENTE → nao rouba; legado preso → intocado; tentativas esgotadas → erro (sem executar)", async () => {
    const vivo = jobML("2026-10-02", "2026-10-02", { status: "rodando", heartbeat_em: iso(AGORA - 9 * MIN) });
    const leg = legado({ status: "rodando", heartbeat_em: iso(AGORA - 60 * MIN), loja_id: MLX });
    const esgotado = jobSP({ status: "rodando", heartbeat_em: iso(AGORA - 20 * MIN), tentativas: 2 });
    const b = bancoFalso({ lojas: lojas(), sync_jobs: [vivo, leg, esgotado] }); const e = espioes(); const legAntes = JSON.stringify(leg);
    const r = await rodar(b, { motores: e.motores });
    assert(job(b, vivo.id).status === "rodando" && JSON.stringify(job(b, leg.id)) === legAntes && job(b, esgotado.id).status === "erro" && job(b, esgotado.id).tentativas === 3, JSON.stringify(b.db.sync_jobs.map((j) => [j.id, j.status])));
    assert(r.resultado === "NO_JOB" && e.chamadas.length === 0 && r.recuperados === 1, JSON.stringify(r));
  });
  t("STUCK3. dono vivo bate ENTRE a leitura e o UPDATE da recuperacao → 0 linhas, nada roubado", async () => {
    const m = jobML("2026-10-02", "2026-10-02", { status: "rodando", heartbeat_em: iso(AGORA - 11 * MIN) });
    const b = bancoFalso({ lojas: lojas(), sync_jobs: [m] }); const e = espioes();
    b.ganchos.antesDeUpdate = (tab, filtros, patch) => { if (tab === "sync_jobs" && patch.status === "pendente" && filtros.some(([, c]) => c === "heartbeat_em")) job(b, m.id).heartbeat_em = iso(AGORA); };
    const r = await rodar(b, { motores: e.motores });
    assert(r.recuperados === 0 && job(b, m.id).status === "rodando" && e.chamadas.length === 0, JSON.stringify(r));
  });
  t("lease muito maior que qualquer maxDuration do worker", () => {
    const rota = readFileSync(join(RAIZ, "app/api/internal/vendas-sync/worker/route.ts"), "utf8");
    const max = Number(/export const maxDuration = (\d+);/.exec(rota)![1]); const orc = Number(/const ORCAMENTO_MS = ([\d_]+);/.exec(rota)![1].replace(/_/g, ""));
    assert(W.LEASE_MS >= 2 * 300_000 && orc < max * 1000 && orc <= 0.8 * max * 1000, `${W.LEASE_MS} ${max} ${orc}`);
  });

  console.log("\n[flag]");
  t("flag OFF (padrao) → DESABILITADO sem construir cliente, sem claim", async () => {
    let construiu = false;
    const r = await W.executarWorkerCanonico(() => { construiu = true; throw new Error("nao devia"); }, { orcamentoMs: 45_000 });
    assert(r.resultado === "DESABILITADO" && !construiu, JSON.stringify(r));
  });

  console.log("\n[U-W. auth da rota]");
  t("U/V/W. sem secret → 401; secret errado → 401; sem CRON_SECRET no ambiente → 401; correto → fluxo (DESABILITADO); segredo nunca aparece", async () => {
    const R = await import("../app/api/internal/vendas-sync/worker/route");
    const SEG = "segredo-de-teste-9f3c";
    const saidas: string[] = []; const log = console.log, err = console.error;
    console.log = (...a: unknown[]) => { saidas.push(a.map(String).join(" ")); }; console.error = (...a: unknown[]) => { saidas.push(a.map(String).join(" ")); };
    try {
      process.env.CRON_SECRET = SEG;
      const req = (h?: string) => new Request("http://x/api/internal/vendas-sync/worker", { headers: h ? { authorization: h } : {} });
      const u = await R.GET(req()); const v = await R.GET(req("Bearer errado")); const v2 = await R.GET(req(SEG));
      const w = await R.GET(req(`Bearer ${SEG}`)); const corpoW = await w.json();
      delete process.env.CRON_SECRET; const sem = await R.GET(req(`Bearer ${SEG}`)); const semVazio = await R.GET(req("Bearer "));
      assert(u.status === 401 && v.status === 401 && v2.status === 401 && sem.status === 401 && semVazio.status === 401, `${u.status} ${v.status} ${v2.status} ${sem.status}`);
      assert(w.status === 200 && corpoW.resultado === "DESABILITADO", JSON.stringify(corpoW));
      const tudo = saidas.join("\n") + JSON.stringify(corpoW) + JSON.stringify(await u.json());
      assert(!tudo.includes(SEG), "segredo vazou");
    } finally { console.log = log; console.error = err; }
    const fonte = readFileSync(join(RAIZ, "app/api/internal/vendas-sync/worker/route.ts"), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    // SALES-SYNC-D8.2: comparacao via helper (CRON_SECRET OU segredo manual) — guard proprio: testar-vendas-sync-auth-interna
    assert(/if \(!segredo \|\| !auth \|\| auth !== cabecalhoEsperadoSalesSync\(auth, segredo\)\)/.test(fonte) && /process\.env\.CRON_SECRET/.test(fonte) && !/console\.\w+\([^)]*segredo/.test(fonte) && !/export async function POST/.test(fonte), "auth da rota");
  });
  t("middleware deixa so GET chegar a rota (a autorizacao e da rota)", () => {
    assert(MW.decidirAcesso("/api/internal/vendas-sync/worker", "GET", false) === "liberar", "GET bloqueado no middleware");
    assert(MW.decidirAcesso("/api/internal/vendas-sync/worker", "POST", false) !== "liberar", "POST liberado");
  });

  console.log("\n[guardas]");
  const semComentarios = (f: string) => readFileSync(join(RAIZ, f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  const ARQS = ["lib/vendas/sync/worker.ts", "lib/vendas/sync/worker-deps.ts", "app/api/internal/vendas-sync/worker/route.ts"];
  t("worker sem formula financeira, sem coordenador, sem claim legado, sem laco de jobs, sem update_time", () => {
    for (const f of ARQS) {
      const s = semComentarios(f);
      assert(!/pack_splitted|voucher|pix_discount|pixDiscount|coin|total_amount|totalAmount|original_shopee_discount|calcularMetricas|reduce\(/i.test(s), `${f}: formula`);
      assert(!/planejamento|coordenador|avaliarLoja|garantirProximaAcao|criarJob/.test(s), `${f}: decide trabalho`);
      assert(!/claim_next_sync_job|\.rpc\(|sync-worker|internal\/sync\/executar|syncShopeeForUserV2|syncMLForUserV2/.test(s), `${f}: caminho legado`);
      assert(!/while\s*\(|for\s*\(;;\)/.test(s), `${f}: laco`);
      assert(!/["'`]update_time["'`]/.test(s), `${f}: update_time`);
      assert(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|MONAMOR/i.test(s), `${f}: loja fixa`);
    }
    const w = semComentarios("lib/vendas/sync/worker.ts");
    assert((w.match(/await reivindicar\(/g) ?? []).length === 1 && /TENTATIVAS_CLAIM = 3/.test(w), "mais de um ponto de claim");
    assert(/executarFatiaML/.test(w) && /executarFatiaShopee/.test(w) && /executarFatiaCatchUpEscrow/.test(w) && /classificarJobParaWorker/.test(w), "roteamento");
  });
  t("legado, canonicos, migrations, vercel.json e env INTOCADOS desde a base", () => {
    // SALES-SYNC-C1 muda DE PROPOSITO so o fence legado: scripts/sync-worker.mjs (recuperacao)
    // e a migration do claim — os dois validados linha a linha por scripts/testar-sync-legacy-fence.ts.
    const FENCE_C1 = ["scripts/sync-worker.mjs", "supabase/migrations/20261029_sales_sync_c1_legacy_claim_fence.sql",
      // SALES-SYNC-C4: lease do refresh Shopee — guard proprio: testar-shopee-refresh-lease
      "supabase/migrations/20261030_sales_sync_c4_shopee_refresh_lease.sql",
      // SALES-SYNC-C8: SELECT do service_role no lease — guard proprio: testar-shopee-refresh-lease M6
      "supabase/migrations/20261031_sales_sync_c8_shopee_refresh_lease_select.sql"];
    const d = execFileSync("git", ["diff", "--name-only", BASE, "--", "scripts/sync-worker.mjs", "app/api/internal/sync", "app/api/sync", "lib/sync-ml.ts", "lib/sync-shopee.ts",
      "lib/vendas/canonico", "lib/mercado-livre/ingestao", "lib/shopee/ingestao", /* SALES-SYNC-D10: vercel.json agora agenda os crons canonicos — guard proprio: testar-vendas-sync-cron */ "supabase", ".env.example", "lib/feature-flags.ts"], { cwd: RAIZ, encoding: "utf8" })
      // SALES-SYNC-D6 acrescenta a flag server-only ao .env.example (guard proprio: testar-vendas-sync-feature-flag)
      .trim().split(/\r?\n/).filter((f) => f && !FENCE_C1.includes(f) && f !== ".env.example");
    // SALES-CANONICAL-D13B: so os arquivos NOVOS do D13 em lib/vendas/canonico; ml.ts/shopee.ts/tipos.ts seguem travados
    const fora = filtrarExcecaoD15C(RAIZ, BASE, filtrarExcecaoD14(RAIZ, BASE, filtrarNovosCanonicosD13(RAIZ, BASE, d))).join(",");
    const novos = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--", "supabase"], { cwd: RAIZ, encoding: "utf8" })
      .trim().split(/\r?\n/).filter((f) => f && !FENCE_C1.includes(f)).join(",");
    assert(fora === "" && novos === "", `alterados: ${fora} ${novos}`);
    assert(JSON.stringify(JSON.parse(readFileSync(join(RAIZ, "vercel.json"), "utf8")).crons.filter((c: { path: string }) => /vendas-sync/.test(c.path))) === JSON.stringify([{ path: "/api/internal/vendas-sync/coordenador", schedule: "*/15 * * * *" }, { path: "/api/internal/vendas-sync/worker", schedule: "* * * * *" }]), "crons canonicos diferentes do aprovado (D10)");
  });
  t("sanitizarErro remove token, segredo e identificadores longos", () => {
    const s = W.sanitizarErro(new Error("falhou access_token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA partner_key:zz pedido 2410021234567890 Bearer xyz"));
    assert(!/AAAAAAAA|zz|2410021234567890|xyz/.test(s) && s.length <= 200, s);
  });

  await fila;
  console.log(`\n${falhou === 0 ? "✓" : "✗"} VENDAS-SYNC-WORKER — ${passou} passaram, ${falhou} falharam`);
  process.exit(falhou === 0 ? 0 : 1);

  // ── Shopee: pedidos falsos pagos na janela e repo (dados em memoria + job no duplo) ──
  function pedidosSP(n: number): PedidoFake[] {
    const ini = Date.parse("2026-10-01T03:00:00Z") / 1000;
    return Array.from({ length: n }, (_, i) => ({ orderSn: `SN${String(i).padStart(6, "0")}`, createTime: ini + 60 + i * 300, updateTime: ini + 120 + i * 300, payTime: ini + 90 + i * 300,
      status: "COMPLETED", totalAmount: 50, osd: 0, pix: 0, itens: [{ itemId: `I${i}`, modelId: null, preco: 50, qtd: 1, vs: 0, vsh: 0, coin: 0 }] }));
  }
  function repoSP(b: ReturnType<typeof bancoFalso>) {
    const real = PSP.criarRepositorioSupabase(b.cliente); const r = new RepoFake();
    r.lojaDoDono = real.lojaDoDono; r.salvarJob = real.salvarJob as any;
    return r;
  }
}
principal().catch((e) => { console.error("ERRO FATAL", e); process.exit(1); });
