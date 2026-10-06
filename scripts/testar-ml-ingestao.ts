/**
 * ML-CORPUS-D1 — motor de ingestao do corpus Mercado Livre (offline).
 *
 * Sem rede real, sem banco. Dois transportes:
 *  - REAL (`criarTransporteML`) sobre a varredura homologada, com `fetch`
 *    falso que imita /orders/search (paginas de 51, paging.total, filtro
 *    por order.date_closed que VAZA o dia seguinte na borda);
 *  - roteirizado, para retry / dia incompleto / erro / resume.
 *
 * A fixture de 02/10/2026 (257 crus, 4 pack_splitted, 253 / 266 /
 * 8063.87) e SINTETICA e estrutural: valida o motor, NAO substitui a prova
 * live (o numero real ja foi homologado no ML-CORPUS-C3).
 *
 * Uso: npx tsx scripts/testar-ml-ingestao.ts
 */
import "./_server-only-inerte";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { DiaFechadoML, JobML, LinhaPedidoML, PatchJobML, RepositorioML, TransporteML, CheckpointML, ProgressoML } from "../lib/mercado-livre/ingestao/tipos";

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
const UID = "dono-a", OUTRO = "dono-b";
const LA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", LB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", LX = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const AGORA = Date.parse("2026-10-06T17:00:00Z");

// ── order no formato da API (offset -03:00, como o ML devolve no BR) ──
function order(id: number, fechadoUtcMs: number, centavos: number, unidades: number, cancel?: string) {
  const local = new Date(fechadoUtcMs - 3 * 3600e3).toISOString().replace("Z", "-03:00");
  const itens = unidades === 2
    ? [{ quantity: 1, unit_price: Math.floor(centavos / 2) / 100 }, { quantity: 1, unit_price: (centavos - Math.floor(centavos / 2)) / 100 }]
    : [{ quantity: 1, unit_price: centavos / 100 }];
  return { id, date_closed: local, date_created: local, last_updated: local, total_amount: centavos / 100, status: cancel ? "cancelled" : "paid",
    order_items: itens, ...(cancel ? { cancel_detail: { code: cancel } } : {}) };
}
const INI02 = Date.parse("2026-10-02T03:00:00Z");
/** Fixture SINTETICA 02/10: 253 validos (8063.87, 266 un.) + 4 pack_splitted = 257 crus; + 5 da borda (03/10). */
function fixture0210() {
  const out: any[] = [];
  for (let i = 0; i < 253; i++) out.push(order(2000000000 + i, INI02 + 600_000 + i * 300_000, 3187 + (i < 76 ? 1 : 0), i < 13 ? 2 : 1));
  for (let i = 0; i < 4; i++) out.push(order(2100000000 + i, INI02 + 3600e3 + i * 1000, 2000 + i, 1, "pack_splitted"));
  const borda = Array.from({ length: 5 }, (_, i) => order(2200000000 + i, Date.parse("2026-10-03T03:00:00Z") + i * 60_000, 5000, 1));
  return { dia: out, borda };
}

// ── fetch falso de /orders/search por order.date_closed ──
function provedor(porDia: Record<string, any[]>, chamadas: Record<string, number> = {}) {
  const buscar: typeof fetch = async (entrada) => {
    const url = new URL(String(entrada));
    const dia = String(url.searchParams.get("order.date_closed.from") ?? "").slice(0, 10);
    const offset = Number(url.searchParams.get("offset") ?? "0"), limite = Number(url.searchParams.get("limit") ?? "51");
    chamadas[dia] = (chamadas[dia] ?? 0) + 1;
    const todos = porDia[dia] ?? [];
    return new Response(JSON.stringify({ paging: { total: todos.length }, results: todos.slice(offset, offset + limite) }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return { buscar, chamadas, resolverCredencial: async (lojaId: string) => ({ lojaId, accessToken: "x", sellerId: "1", nickname: "n" }) };
}

// ── repositorio em memoria com a semantica do banco (PK loja+order, FK dono) ──
class RepoFake implements RepositorioML {
  lojas: { id: string; user_id: string; marketplace: string; ativo: boolean }[] = [
    { id: LA, user_id: UID, marketplace: "ML", ativo: true }, { id: LB, user_id: UID, marketplace: "ML", ativo: true }, { id: LX, user_id: OUTRO, marketplace: "ML", ativo: true }];
  pedidos = new Map<string, LinhaPedidoML>();
  jobs = new Map<string, { patches: PatchJobML[]; status: string; listagem: boolean; erro: string | null; checkpoint: CheckpointML | null; progresso: ProgressoML | null }>();
  async lojaDoDono(userId: string, lojaId: string) { return this.lojas.some((l) => l.id === lojaId && l.user_id === userId && l.marketplace === "ML" && l.ativo); }
  async gravarPedidos(userId: string, lojaId: string, linhas: LinhaPedidoML[]) {
    let novas = 0;
    for (const l of linhas) {
      if (l.user_id !== userId || l.loja_id !== lojaId) throw new Error("isolamento");
      if (!this.lojas.some((x) => x.id === l.loja_id && x.user_id === l.user_id)) throw new Error("FK ml_pedidos_loja_do_mesmo_dono");
      const k = `${l.loja_id}|${l.order_id}`;
      if (!this.pedidos.has(k)) novas++;
      this.pedidos.set(k, structuredClone(l));
    }
    return { novas };
  }
  async salvarJob(job: { id: string }, patch: PatchJobML) {
    const j = this.jobs.get(job.id) ?? { patches: [], status: "pendente", listagem: false, erro: null, checkpoint: null, progresso: null };
    j.patches.push(structuredClone(patch)); j.checkpoint = structuredClone(patch.checkpoint); j.progresso = structuredClone(patch.progresso);
    if (patch.status) j.status = patch.status; if (patch.listagemCompleta !== undefined) j.listagem = patch.listagemCompleta; if (patch.erroMensagem !== undefined) j.erro = patch.erroMensagem;
    this.jobs.set(job.id, j);
  }
}
let seq = 0;

async function principal() {
  const M = await import("../lib/mercado-livre/ingestao/motor");
  const T = await import("../lib/mercado-livre/ingestao/transporte");
  const P = await import("../lib/mercado-livre/ingestao/persistencia");
  const J = await import("../lib/mercado-livre/ingestao/janelas");
  const C = await import("../lib/vendas/canonico/ml");
  const relogio = (t0 = AGORA, passo = 0) => { let t = t0; return { agoraMs: () => (t += passo) }; };

  /** Roda fatias ate concluir/falhar (como um worker faria), relendo o checkpoint salvo. */
  async function rodar(repo: RepoFake, transporte: TransporteML, j: { userId?: string; lojaId?: string; de: string; ate: string },
    o: { prazoPorFatia?: number; passo?: number; maxFatias?: number; relogio?: { agoraMs(): number } } = {}) {
    const id = `job-${++seq}`; const userId = j.userId ?? UID, lojaId = j.lojaId ?? LA;
    let res: Awaited<ReturnType<typeof M.executarFatiaML>> | null = null; const estados: string[] = [];
    const rel = o.relogio ?? relogio(AGORA, o.passo ?? 0);
    for (let k = 0; k < (o.maxFatias ?? 50); k++) {
      const salvo = repo.jobs.get(id);
      const job: JobML = { id, userId, lojaId, de: j.de, ate: j.ate, checkpoint: salvo?.checkpoint ?? null, progresso: salvo?.progresso ?? null };
      res = await M.executarFatiaML(job, { transporte, repo, relogio: rel }, { prazoMs: rel.agoraMs() + (o.prazoPorFatia ?? 1e12), margemMs: 0, habilitado: true });
      estados.push(res.estado);
      if (res.estado !== "pausado") break;
    }
    return { id, res: res!, estados, job: repo.jobs.get(id) };
  }
  const corpus = (repo: RepoFake, lojaId = LA) => [...repo.pedidos.values()].filter((l) => l.loja_id === lojaId);
  const comoCanon = (ls: LinhaPedidoML[]) => ls.map((l) => ({ lojaId: l.loja_id, orderId: l.order_id, dateClosed: l.date_closed, cancelCode: l.cancel_detail_code, totalAmount: l.total_amount, unidades: l.unidades, fetchedAt: l.fetched_at }));

  console.log("\n[A-G. transporte REAL (varredura homologada) + fixture 02/10]");
  const fx = fixture0210();
  t("A. um dia de uma pagina: 30 pedidos → 30 linhas, listagem completa, job concluido", async () => {
    const repo = new RepoFake(); const dia = Array.from({ length: 30 }, (_, i) => order(3000 + i, INI02 + i * 60_000, 1000, 1));
    const p = provedor({ "2026-10-02": dia });
    const r = await rodar(repo, T.criarTransporteML(p), { de: "2026-10-02", ate: "2026-10-02" });
    assert(r.res.estado === "concluido" && corpus(repo).length === 30 && r.job!.listagem && r.job!.status === "concluido" && r.job!.progresso!.paginas === 1, JSON.stringify(r.job?.progresso));
  });
  t("B. varias paginas (262 = 257 do dia + 5 da borda): 6 paginas, 257 linhas cruas", async () => {
    const repo = new RepoFake(); const p = provedor({ "2026-10-02": [...fx.dia, ...fx.borda] });
    const r = await rodar(repo, T.criarTransporteML(p), { de: "2026-10-02", ate: "2026-10-02" });
    assert(r.res.estado === "concluido" && r.job!.progresso!.paginas === 6 && corpus(repo).length === 257, `${r.job!.progresso!.paginas} ${corpus(repo).length}`);
  });
  t("C. vazamento de borda: pedidos de 03/10 que o filtro devolve NAO entram no corpus de 02/10", async () => {
    const repo = new RepoFake(); await rodar(repo, T.criarTransporteML(provedor({ "2026-10-02": [...fx.dia, ...fx.borda] })), { de: "2026-10-02", ate: "2026-10-02" });
    assert(fx.borda.every((o) => !repo.pedidos.has(`${LA}|${o.id}`)) && corpus(repo).every((l) => l.date_closed! >= "2026-10-02T03:00:00.000Z" && l.date_closed! < "2026-10-03T03:00:00.000Z"), "borda entrou");
  });
  t("E/F/G. pack_splitted PERSISTIDO (4); canonico = 253 pedidos / 266 unidades / 8063.87 (fixture sintetica)", async () => {
    const repo = new RepoFake(); await rodar(repo, T.criarTransporteML(provedor({ "2026-10-02": [...fx.dia, ...fx.borda] })), { de: "2026-10-02", ate: "2026-10-02" });
    const ls = corpus(repo);
    assert(ls.filter((l) => l.cancel_detail_code === "pack_splitted").length === 4, "pack nao persistido");
    const m = C.calcularMetricasML(comoCanon(ls));
    assert(m.pedidos === 253 && m.unidades === 266 && m.vendas === 8063.87, JSON.stringify(m));
    assert(ls.every((l) => typeof l.total_amount === "number" && l.unidades >= 1 && l.fetched_at && l.last_updated && l.date_created), "campos");
  });

  console.log("\n[D/H/I. dedup, multi-loja, dono]");
  const roteiro = (dias: Record<string, DiaFechadoML | (() => DiaFechadoML)>, chamadas: Record<string, number> = {}): TransporteML => ({
    async listarDiaFechado({ dia }) { chamadas[dia] = (chamadas[dia] ?? 0) + 1; const r = dias[dia]; return typeof r === "function" ? r() : (r ?? { brutos: [], paginas: 1, completa: true, erro: null }); },
  });
  t("D. mesmo order_id duas vezes na leitura do dia → UMA linha", async () => {
    const repo = new RepoFake(); const o = order(77, INI02 + 1000, 500, 1);
    await rodar(repo, roteiro({ "2026-10-02": { brutos: [o, o, { ...o }], paginas: 2, completa: true, erro: null } }), { de: "2026-10-02", ate: "2026-10-02" });
    assert(corpus(repo).length === 1, String(corpus(repo).length));
  });
  t("H. mesmo order_id em Loja A e Loja B (mesmo dono) → duas linhas distintas; cada job so grava a sua loja", async () => {
    const repo = new RepoFake(); const o = order(999, INI02 + 1000, 1000, 1);
    await rodar(repo, roteiro({ "2026-10-02": { brutos: [o], paginas: 1, completa: true, erro: null } }), { lojaId: LA, de: "2026-10-02", ate: "2026-10-02" });
    await rodar(repo, roteiro({ "2026-10-02": { brutos: [{ ...o, total_amount: 40 }], paginas: 1, completa: true, erro: null } }), { lojaId: LB, de: "2026-10-02", ate: "2026-10-02" });
    assert(repo.pedidos.size === 2 && repo.pedidos.get(`${LA}|999`)!.total_amount === 10 && repo.pedidos.get(`${LB}|999`)!.total_amount === 40, "colisao entre lojas");
  });
  t("I. loja de OUTRO dono → loja_invalida, nada gravado; adaptador real recusa linha de outro dono/loja antes de qualquer chamada", async () => {
    const repo = new RepoFake();
    const r = await rodar(repo, roteiro({ "2026-10-02": { brutos: [order(1, INI02 + 1, 1, 1)], paginas: 1, completa: true, erro: null } }), { lojaId: LX, de: "2026-10-02", ate: "2026-10-02" });
    assert(r.res.estado === "falhou" && (r.res as any).motivo === "loja_invalida" && repo.pedidos.size === 0, JSON.stringify(r.res));
    let chamou = false; const cliente: any = { from: () => { chamou = true; throw new Error("nao devia chamar"); } };
    const real = P.criarRepositorioML(cliente);
    const linha = { user_id: OUTRO, loja_id: LA, order_id: "1", date_created: null, date_closed: null, last_updated: null, status: null, cancel_detail_code: null, total_amount: 1, unidades: 1, fetched_at: "z" };
    let erro = ""; try { await real.gravarPedidos(UID, LA, [linha]); } catch (e: any) { erro = e.message; }
    assert(erro.startsWith("linha_de_outro_dono_ou_loja") && !chamou, erro);
  });

  console.log("\n[J-N. retry, incompleto, resume, idempotencia, checkpoint]");
  t("J. erro transitorio (limite_excedido) pausa; a fatia seguinte rele o dia e conclui", async () => {
    const repo = new RepoFake(); let n = 0;
    const tr = roteiro({ "2026-10-02": () => (++n === 1 ? { brutos: [], paginas: 0, completa: false, erro: "limite_excedido" } : { brutos: [order(5, INI02 + 1, 100, 1)], paginas: 1, completa: true, erro: null }) });
    const r = await rodar(repo, tr, { de: "2026-10-02", ate: "2026-10-02" });
    assert(r.estados.join() === "pausado,concluido" && corpus(repo).length === 1 && r.job!.status === "concluido", r.estados.join());
  });
  t("K. dia INCOMPLETO nunca vira fim: pausa com listagem_completa=false e status rodando", async () => {
    const repo = new RepoFake();
    const r = await rodar(repo, roteiro({ "2026-10-02": { brutos: [order(5, INI02 + 1, 100, 1)], paginas: 3, completa: false, erro: null } }), { de: "2026-10-02", ate: "2026-10-02" }, { maxFatias: 1 });
    assert(r.res.estado === "pausado" && r.job!.listagem === false && r.job!.status === "rodando" && corpus(repo).length === 0, JSON.stringify(r.job));
  });
  t("L. RESUME: prazo corta depois do 1o dia; a fatia seguinte NAO rele o dia concluido e termina COMPLETE", async () => {
    const repo = new RepoFake(); const chamadas: Record<string, number> = {};
    const dias = { "2026-10-01": { brutos: [order(11, Date.parse("2026-10-01T12:00:00Z"), 100, 1)], paginas: 1, completa: true, erro: null },
      "2026-10-02": { brutos: [order(12, INI02 + 5000, 200, 1)], paginas: 1, completa: true, erro: null },
      "2026-10-03": { brutos: [order(13, Date.parse("2026-10-03T12:00:00Z"), 300, 1)], paginas: 1, completa: true, erro: null } };
    // ler um dia "custa" 1h; a fatia tem 90 min de prazo → cabe 1 dia por fatia
    const clock = { t: AGORA, agoraMs() { return this.t; } };
    const base = roteiro(dias, chamadas);
    const lento: TransporteML = { async listarDiaFechado(a) { clock.t += 3600e3; return base.listarDiaFechado(a); } };
    const r = await rodar(repo, lento, { de: "2026-10-01", ate: "2026-10-03" }, { prazoPorFatia: 1.5 * 3600e3, relogio: clock });
    assert(r.estados.filter((e) => e === "pausado").length >= 1 && r.res.estado === "concluido", r.estados.join());
    assert(Object.values(chamadas).every((n) => n === 1) && corpus(repo).length === 3 && r.job!.checkpoint!.diasConcluidos.length === 3, JSON.stringify(chamadas));
  });
  t("M. IDEMPOTENCIA: o mesmo snapshot duas vezes → 2a vez 0 linhas novas, mesmo corpus, mesmas metricas", async () => {
    const repo = new RepoFake(); const p = () => T.criarTransporteML(provedor({ "2026-10-02": [...fx.dia, ...fx.borda] }));
    const r1 = await rodar(repo, p(), { de: "2026-10-02", ate: "2026-10-02" });
    const antes = JSON.stringify([...repo.pedidos.values()].map(({ fetched_at, ...x }) => x)); const m1 = C.calcularMetricasML(comoCanon(corpus(repo)));
    const r2 = await rodar(repo, p(), { de: "2026-10-02", ate: "2026-10-02" });
    const depois = JSON.stringify([...repo.pedidos.values()].map(({ fetched_at, ...x }) => x)); const m2 = C.calcularMetricasML(comoCanon(corpus(repo)));
    assert(r1.job!.progresso!.gravados === 257 && r2.job!.progresso!.gravados === 0 && repo.pedidos.size === 257 && antes === depois && JSON.stringify(m1) === JSON.stringify(m2), `${r1.job!.progresso!.gravados} ${r2.job!.progresso!.gravados}`);
  });
  t("N. checkpoint/progresso: dias concluidos, paginas, recebidos (com borda), listados, pack_splitted; sem segredo", async () => {
    const repo = new RepoFake(); const r = await rodar(repo, T.criarTransporteML(provedor({ "2026-10-02": [...fx.dia, ...fx.borda] })), { de: "2026-10-02", ate: "2026-10-02" });
    const pr = r.job!.progresso!;
    assert(r.job!.checkpoint!.diasConcluidos.join() === "2026-10-02" && pr.recebidos === 262 && pr.listados === 257 && pr.pack_splitted === 4 && pr.dias === 1 && pr.diasConcluidos === 1, JSON.stringify(pr));
    assert(!/token|secret|access/i.test(JSON.stringify({ ...r.job!.checkpoint, ...pr })), "segredo no checkpoint");
  });

  console.log("\n[O/P. completude a partir do que o motor produziu]");
  const janelaDoJob = (job: any, de: string, ate: string) => { const l = J.limitesDaJanela(de, ate)!; return { campoTempo: "date_closed", inicio: l.inicio.toISOString(), fim: l.fim.toISOString(), listagemCompleta: job.listagem, status: job.status }; };
  t("O. job concluido + fetched_at depois do fim → avaliarCompletudeML = COMPLETE com 253/266/8063.87", async () => {
    const repo = new RepoFake(); const r = await rodar(repo, T.criarTransporteML(provedor({ "2026-10-02": [...fx.dia, ...fx.borda] })), { de: "2026-10-02", ate: "2026-10-02" });
    const lim = J.limitesDaJanela("2026-10-02", "2026-10-02")!;
    const pedidos = C.filtrarFechadosNoIntervalo(comoCanon(corpus(repo)), lim.inicio, lim.fim);
    const av = C.avaliarCompletudeML({ ...lim, janelas: [janelaDoJob(r.job, "2026-10-02", "2026-10-02")], pedidos });
    assert(av.completude === "COMPLETE" && JSON.stringify(C.calcularMetricasML(pedidos)) === JSON.stringify({ pedidos: 253, unidades: 266, vendas: 8063.87 }), JSON.stringify(av));
  });
  t("P. erro PERMANENTE (nao_autorizado) → job erro, listagem false → FAILED; incompleto repetido ate o teto → erro", async () => {
    const repo = new RepoFake();
    const r = await rodar(repo, roteiro({ "2026-10-02": { brutos: [], paginas: 0, completa: false, erro: "nao_autorizado" } }), { de: "2026-10-02", ate: "2026-10-02" });
    assert(r.res.estado === "falhou" && r.job!.status === "erro" && !r.job!.listagem, JSON.stringify(r.job));
    const lim = J.limitesDaJanela("2026-10-02", "2026-10-02")!;
    assert(C.avaliarCompletudeML({ ...lim, janelas: [janelaDoJob(r.job, "2026-10-02", "2026-10-02")], pedidos: [] }).completude === "FAILED", "nao FAILED");
    const r2 = await rodar(new RepoFake(), roteiro({ "2026-10-02": { brutos: [], paginas: 2, completa: false, erro: null } }), { de: "2026-10-02", ate: "2026-10-02" });
    assert(r2.estados.join() === "pausado,pausado,falhou" && r2.job!.status === "erro", r2.estados.join());
  });

  console.log("\n[Q. guardas]");
  t("Q1. janela ABERTA (fim depois de agora) → recusada; flag desligada → desabilitado", async () => {
    const r = await rodar(new RepoFake(), roteiro({}), { de: "2026-10-06", ate: "2026-10-06" });
    assert(r.res.estado === "falhou" && (r.res as any).motivo === "janela_nao_fechada", JSON.stringify(r.res));
    const d = await M.executarFatiaML({ id: "x", userId: UID, lojaId: LA, de: "2026-10-02", ate: "2026-10-02", checkpoint: null, progresso: null },
      { transporte: roteiro({}), repo: new RepoFake(), relogio: relogio() }, { prazoMs: AGORA + 1e9 });
    assert(d.estado === "desabilitado", d.estado);
  });
  t("Q2. regra UNICA: o motor usa normalizarPedidoML; nenhum calculo proprio de pack_splitted/total/unidades; nunca toca `pedidos`", () => {
    const dir = join(RAIZ, "lib/mercado-livre/ingestao");
    const fontes = readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")] as const);
    for (const [f, s] of fontes) {
      assert(!/["'`]pack_splitted["'`]|cancel_detail(?!_code)|order_items|\.quantity|unit_price/.test(s), `${f} recalcula a regra`);
      assert(!/from\(\s*["'`]pedidos["'`]/.test(s), `${f} toca pedidos legado`);
      assert(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|MONAMOR/i.test(s), `${f} conhece loja/conta`);
    }
    assert(/normalizarPedidoML\(/.test(fontes.find(([f]) => f === "normalizar.ts")![1]), "nao usa o normalizador canonico");
    assert(/varrerFechamentosDoDiaML\(/.test(fontes.find(([f]) => f === "transporte.ts")![1]), "transporte nao usa a varredura homologada");
  });
  t("Q3. descoberta ≠ refresh: o motor nao filtra por last_updated (nao provado live)", () => {
    const s = readFileSync(join(RAIZ, "lib/mercado-livre/ingestao/motor.ts"), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    assert(!/last_updated\.(from|to)|date_last_updated/.test(s), "refresh por last_updated sem prova");
  });

  await fila;
  console.log(`\n${falhou === 0 ? "✓" : "✗"} ML-INGESTAO — ${passou} passaram, ${falhou} falharam`);
  process.exit(falhou === 0 ? 0 : 1);
}
principal().catch((e) => { console.error("ERRO FATAL", e); process.exit(1); });
