/**
 * SALES-SYNC-C6 — contrato DETALHADO de auth Shopee + worker canonico
 * fail-closed (offline).
 *
 * Roda o codigo REAL (resolverCredencialShopee → renovarShopeeComLease →
 * renovarShopeeComCas; portasShopeeCanonicas; executarWorkerCanonico) contra
 * um duplo de banco (lojas + sync_jobs + RPCs do lease com a semantica da
 * migration C4) e um provider falso. Esperas sao injetadas e limitadas.
 *
 * Uso: npx tsx scripts/testar-shopee-auth-transient.ts
 */
import "./_server-only-inerte";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

const T0 = Date.parse("2026-10-07T12:00:00Z");
const DONO = "dono-a", OUTRO = "dono-b";
const SP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ML = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const VENCIDO = new Date(T0 - 60_000).toISOString();
const VALIDO = new Date(T0 + 3 * 3600_000).toISOString();
type Linha = Record<string, any>;

function lojasBase(o: Linha = {}): Linha[] {
  return [
    { id: SP, user_id: DONO, marketplace: "Shopee", ativo: true, nickname: "n", shop_id: "419", partner_id: "p1", partner_key: "pk-segredo",
      access_token: "A0", refresh_token: "R0", token_expires_at: VENCIDO, created_at: "2026-01-01T00:00:00Z", ...o },
    { id: ML, user_id: DONO, marketplace: "ML", ativo: true, nickname: "ml", shop_id: null, partner_id: null, partner_key: null,
      access_token: "MLA", refresh_token: "MLR", token_expires_at: VALIDO, created_at: "2026-01-01T00:00:00Z" },
  ];
}

/** Duplo: lojas + sync_jobs (filtros que o worker e as credenciais usam) + RPCs do lease. */
function bancoFalso(lojas: Linha[], o: { rpc?: "ok" | "inexistente" | "erro" | "fk"; jobs?: Linha[] } = {}) {
  const tabelas: Record<string, Linha[]> = { lojas, sync_jobs: o.jobs ?? [] };
  const leases: Linha[] = []; const rpcs: { nome: string; resultado: unknown }[] = []; let escritasLojas = 0;
  const relogio = { agora: T0 };
  const valor = (l: Linha, c: string) => (c === "checkpoint->>modo" ? l.checkpoint?.modo ?? null : l[c]);
  const cliente: any = {
    from(tabela: string) {
      const filtros: [string, string, unknown][] = []; let patch: Linha | null = null; let devolver = false; let unico: "single" | "maybe" | null = null;
      let ordem: [string, boolean] | null = null; let lim = Infinity;
      const casa = (l: Linha) => filtros.every(([op, c, v]) => op === "eq" ? String(valor(l, c)) === String(v)
        : op === "in" ? (v as unknown[]).map(String).includes(String(valor(l, c))) : op === "is" ? (valor(l, c) ?? null) === v : true);
      const q: any = {
        select() { if (patch) devolver = true; return q; }, update(p: Linha) { patch = p; return q; },
        eq(c: string, v: unknown) { filtros.push(["eq", c, v]); return q; }, in(c: string, v: unknown[]) { filtros.push(["in", c, v]); return q; },
        is(c: string, v: unknown) { filtros.push(["is", c, v]); return q; },
        order(c: string, op?: { ascending?: boolean }) { ordem = [c, op?.ascending !== false]; return q; }, limit(n: number) { lim = n; return q; },
        single() { unico = "single"; return q; }, maybeSingle() { unico = "maybe"; return q; },
        then(ok: any, ko: any) {
          return Promise.resolve().then(() => {
            const tab = tabelas[tabela] ?? [];
            if (patch) { const alvo = tab.filter(casa); for (const l of alvo) Object.assign(l, structuredClone(patch)); if (tabela === "lojas" && alvo.length) escritasLojas++;
              return { data: devolver ? alvo.map((l) => ({ id: l.id })) : null, error: null }; }
            let d: Linha[] = tab.filter(casa).map((l) => ({ ...l, modo: l.checkpoint?.modo ?? null }));
            if (ordem) { const [c, asc] = ordem; d.sort((a, b) => (String(a[c] ?? "") < String(b[c] ?? "") ? -1 : 1) * (asc ? 1 : -1)); }
            d = d.slice(0, lim);
            if (unico === "single") return d.length === 1 ? { data: d[0], error: null } : { data: null, error: { message: "nao_unico" } };
            if (unico === "maybe") return { data: d[0] ?? null, error: null };
            return { data: d, error: null };
          }).then(ok, ko);
        },
      };
      return q;
    },
    async rpc(nome: string, a: Linha) {
      await Promise.resolve();
      const modo = o.rpc ?? "ok";
      if (modo === "inexistente") return { data: null, error: { code: "PGRST202", message: `Could not find the function public.${nome}` } };
      if (modo === "erro") return { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
      if (modo === "fk" && nome.startsWith("adquirir")) return { data: null, error: { code: "23503", message: "insert or update violates foreign key constraint" } };
      const agora = relogio.agora; let resultado: unknown;
      if (nome === "adquirir_lease_refresh_credencial") {
        const atual = leases.find((l) => l.loja_id === a.p_loja_id && l.marketplace === a.p_marketplace);
        const novo = { user_id: a.p_user_id, loja_id: a.p_loja_id, marketplace: a.p_marketplace, portador: a.p_portador, expira_em: agora + a.p_ttl_segundos * 1000, liberada_em: null };
        if (!atual) { if (!lojas.some((l) => l.id === a.p_loja_id && l.user_id === a.p_user_id)) return { data: null, error: { code: "23503", message: "fk" } }; leases.push(novo); resultado = true; }
        else if (atual.expira_em <= agora && atual.user_id === a.p_user_id) { Object.assign(atual, novo); resultado = true; } else resultado = false;
      } else {
        const atual = leases.find((l) => l.loja_id === a.p_loja_id && l.user_id === a.p_user_id && l.portador === a.p_portador && l.liberada_em === null);
        if (atual) { atual.expira_em = agora; atual.liberada_em = agora; } resultado = !!atual;
      }
      rpcs.push({ nome, resultado }); return { data: resultado, error: null };
    },
  };
  return { cliente, lojas, leases, rpcs, relogio, tabelas, escritasLojas: () => escritasLojas };
}

async function aguardar(cond: () => boolean, rotulo: string) {
  for (let i = 0; i < 5000; i++) { if (cond()) return; await new Promise((r) => setImmediate(r)); }
  throw new Error(`condicao nunca ocorreu: ${rotulo}`);
}
function porta() { let abrir!: () => void; const p = new Promise<void>((r) => (abrir = r)); return { p, abrir }; }
const silencio = async <T,>(fn: () => Promise<T>) => { const log = console.log, err = console.error; const saida: string[] = [];
  console.log = (...a: unknown[]) => { saida.push(a.join(" ")); }; console.error = (...a: unknown[]) => { saida.push(a.join(" ")); };
  try { return { r: await fn(), saida }; } finally { console.log = log; console.error = err; } };
const SEGREDOS = /A0|R0|A1|R1|pk-segredo/;

async function principal() {
  const SA = await import("../lib/shopee-auth");
  const WD = await import("../lib/vendas/sync/worker-deps");
  const W = await import("../lib/vendas/sync/worker");
  const P = await import("../lib/vendas/sync/planejamento");

  /** Um "processo": provider proprio, so o banco e compartilhado. */
  function processo(db: ReturnType<typeof bancoFalso>, provider: (rt: string) => Promise<any>, o: { esperar?: () => Promise<void> } = {}) {
    let chamadas = 0;
    const inj = { cliente: db.cliente, renovar: async (rt: string) => { chamadas++; return provider(rt); }, esperar: o.esperar ?? (async () => {}), agoraMs: () => db.relogio.agora };
    return { inj, provider: () => chamadas };
  }
  const nuncaProvider = async () => { throw new Error("provider chamado"); };
  const vencedor = (db: ReturnType<typeof bancoFalso>) => Object.assign(db.lojas[0], { access_token: "A1", refresh_token: "R1", token_expires_at: VALIDO });

  console.log("\n[contrato detalhado]");
  t("A. token VALIDO → OK; 0 lease, 0 provider, 0 escritas", async () => {
    const db = bancoFalso(lojasBase({ token_expires_at: VALIDO })); const p = processo(db, nuncaProvider);
    const { r } = await silencio(() => SA.resolverCredencialShopee(DONO, SP, "canonico", p.inj));
    assert(r.status === "OK" && r.credencial.accessToken === "A0" && db.rpcs.length === 0 && p.provider() === 0 && db.escritasLojas() === 0, JSON.stringify({ s: r.status, rpcs: db.rpcs.length }));
  });
  t("B. lease OCUPADO + vencedor aparece durante a releitura limitada → OK, provider 0", async () => {
    const db = bancoFalso(lojasBase());
    await db.cliente.rpc("adquirir_lease_refresh_credencial", { p_user_id: DONO, p_loja_id: SP, p_marketplace: "Shopee", p_portador: "outro", p_ttl_segundos: 30 });
    const p = processo(db, nuncaProvider, { esperar: async () => { vencedor(db); } });
    const { r } = await silencio(() => SA.resolverCredencialShopee(DONO, SP, "canonico", p.inj));
    assert(r.status === "OK" && r.credencial.accessToken === "A1" && p.provider() === 0, JSON.stringify({ s: r.status }));
  });
  t("C. lease OCUPADO sem vencedor → REFRESH_EM_ANDAMENTO (retryAfter = TTL), provider 0 — nunca CREDENCIAL_INDISPONIVEL", async () => {
    const db = bancoFalso(lojasBase());
    await db.cliente.rpc("adquirir_lease_refresh_credencial", { p_user_id: DONO, p_loja_id: SP, p_marketplace: "Shopee", p_portador: "outro", p_ttl_segundos: 30 });
    const p = processo(db, nuncaProvider);
    for (const modo of ["canonico", "compativel"] as const) {
      const { r, saida } = await silencio(() => SA.resolverCredencialShopee(DONO, SP, modo, p.inj));
      assert(r.status === "REFRESH_EM_ANDAMENTO" && r.retryAfterMs === 30_000 && p.provider() === 0, `${modo}: ${JSON.stringify(r)}`);
      assert(saida.some((s) => s.includes("SHOPEE_REFRESH_IN_PROGRESS")) && !saida.some((s) => /reconecte/i.test(s)), saida.join("|"));
    }
  });
  t("D. CANONICO + RPC do lease ausente (ou erro do banco) → LEASE_INDISPONIVEL; provider 0; CAS-only 0", async () => {
    for (const rpc of ["inexistente", "erro"] as const) {
      const db = bancoFalso(lojasBase(), { rpc }); const p = processo(db, nuncaProvider);
      const { r, saida } = await silencio(() => SA.resolverCredencialShopee(DONO, SP, "canonico", p.inj));
      assert(r.status === "LEASE_INDISPONIVEL" && p.provider() === 0 && db.escritasLojas() === 0 && db.lojas[0].refresh_token === "R0", `${rpc}: ${JSON.stringify(r)}`);
      assert(saida.some((s) => s.includes("SHOPEE_LEASE_UNAVAILABLE")) && !saida.some((s) => /reconecte/i.test(s)), saida.join("|"));
    }
  });
  t("E. COMPATIVEL (callers legados): RPC ausente → fallback C3 CAS-only preservado; erro do banco → tratado como ocupado (C4)", async () => {
    const db = bancoFalso(lojasBase(), { rpc: "inexistente" }); const p = processo(db, async () => ({ access_token: "A1", refresh_token: "R1", expire_in: 14400 }));
    const { r, saida } = await silencio(() => SA.resolverCredencialShopee(DONO, SP, "compativel", p.inj));
    assert(r.status === "OK" && r.credencial.accessToken === "A1" && p.provider() === 1 && db.lojas[0].refresh_token === "R1" && saida.some((s) => s.includes("LEASE_UNAVAILABLE_FALLBACK_CAS")), JSON.stringify(r));
    const db2 = bancoFalso(lojasBase(), { rpc: "erro" }); const p2 = processo(db2, nuncaProvider);
    const { r: r2 } = await silencio(() => SA.resolverCredencialShopee(DONO, SP, "compativel", p2.inj));
    assert(r2.status === "REFRESH_EM_ANDAMENTO" && p2.provider() === 0, JSON.stringify(r2));
    const src = readFileSync(join(RAIZ, "lib/shopee-auth.ts"), "utf8");
    assert(/resolverCredencialShopee\(userId, null, "compativel"\)/.test(src) && /resolverCredencialShopee\(userId, lojaId, "compativel"\)/.test(src), "getters publicos nao estao no modo compativel");
  });
  t("F. falha REAL: lease adquirido, provider falha, ninguem renovou → CREDENCIAL_INDISPONIVEL (refresh_falhou)", async () => {
    const db = bancoFalso(lojasBase()); const p = processo(db, async () => null);
    const { r, saida } = await silencio(() => SA.resolverCredencialShopee(DONO, SP, "canonico", p.inj));
    assert(r.status === "CREDENCIAL_INDISPONIVEL" && r.motivo === "refresh_falhou" && p.provider() === 1 && db.leases[0].liberada_em !== null, JSON.stringify(r));
    assert(saida.some((s) => s.includes("refresh FALHOU")) && saida.some((s) => s.includes("SHOPEE_CREDENTIAL_UNAVAILABLE")), saida.join("|"));
  });
  t("G. provider falha MAS outro processo ja renovou → OK com o vencedor (C3 preservado)", async () => {
    const db = bancoFalso(lojasBase()); const p = processo(db, async () => { vencedor(db); return null; });
    const { r } = await silencio(() => SA.resolverCredencialShopee(DONO, SP, "canonico", p.inj));
    assert(r.status === "OK" && r.credencial.accessToken === "A1", JSON.stringify(r));
  });

  console.log("\n[worker canonico]");
  const jobSP = (o: Linha = {}): Linha => ({ id: "job-sp", user_id: DONO, loja_id: SP, marketplace: "Shopee", tipo: "backfill", date_from: "2026-10-01", date_to: "2026-10-01",
    status: "pendente", campo_tempo: "create_time", janela_inicio: "2026-10-01T03:00:00.000Z", janela_fim: "2026-10-02T03:00:00.000Z", listagem_completa: false,
    checkpoint: { versao: 1, fase: "DETAIL", cursor: null, paginasLidas: 3, listagemTerminou: true, pendentesDetalhe: ["x"] }, progresso: { paginas: 3 },
    tentativas: 0, max_tentativas: 3, erro_mensagem: null, erro_tipo: null, criado_em: new Date(T0 - 3600_000).toISOString(), iniciado_em: null, heartbeat_em: null, concluido_em: null, ...o });
  const depsWorker = (db: ReturnType<typeof bancoFalso>, inj: any) => ({
    cliente: db.cliente, relogio: { agoraMs: () => db.relogio.agora },
    portasML: async () => { throw new Error("ML"); },
    portasShopee: (job: any) => WD.portasShopeeCanonicas(job, db.cliente, inj),
    motores: { ml: (async () => { throw new Error("motor ML"); }) as any, shopee: (async () => { throw new Error("motor nao devia rodar"); }) as any, catchup: (async () => { throw new Error("catchup"); }) as any },
  });
  t("H. auth TRANSITORIA no worker → ADIADO: rodando → pendente; checkpoint/progresso/tentativas intactos; sem erro", async () => {
    const job = jobSP(); const antes = structuredClone(job);
    const db = bancoFalso(lojasBase(), { jobs: [job] });
    await db.cliente.rpc("adquirir_lease_refresh_credencial", { p_user_id: DONO, p_loja_id: SP, p_marketplace: "Shopee", p_portador: "outro", p_ttl_segundos: 30 });
    const p = processo(db, nuncaProvider);
    const { r } = await silencio(() => W.executarWorkerCanonico(depsWorker(db, p.inj) as any, { orcamentoMs: 45_000, habilitado: true }));
    assert(r.resultado === "ADIADO" && r.motivo === "auth_transitoria:refresh_em_andamento" && r.status_posterior === "pendente", JSON.stringify(r));
    assert(job.status === "pendente" && JSON.stringify(job.checkpoint) === JSON.stringify(antes.checkpoint) && JSON.stringify(job.progresso) === JSON.stringify(antes.progresso)
      && job.tentativas === 0 && job.erro_mensagem === null && job.erro_tipo === null && job.concluido_em === null && job.listagem_completa === false && p.provider() === 0, JSON.stringify(job));
    const db2 = bancoFalso(lojasBase(), { jobs: [jobSP()], rpc: "inexistente" });
    const { r: r2 } = await silencio(() => W.executarWorkerCanonico(depsWorker(db2, processo(db2, nuncaProvider).inj) as any, { orcamentoMs: 45_000, habilitado: true }));
    assert(r2.resultado === "ADIADO" && r2.motivo === "auth_transitoria:lease_indisponivel" && db2.tabelas.sync_jobs[0].status === "pendente", JSON.stringify(r2));
  });
  t("I. contencao REPETIDA (5 ticks) → nunca FAILED/WAIT_RETRY; o MESMO job e retomado; nenhum job novo", async () => {
    const job = jobSP(); const db = bancoFalso(lojasBase(), { jobs: [job] });
    await db.cliente.rpc("adquirir_lease_refresh_credencial", { p_user_id: DONO, p_loja_id: SP, p_marketplace: "Shopee", p_portador: "outro", p_ttl_segundos: 30 });
    const p = processo(db, nuncaProvider);
    for (let k = 0; k < 5; k++) { const { r } = await silencio(() => W.executarWorkerCanonico(depsWorker(db, p.inj) as any, { orcamentoMs: 45_000, habilitado: true })); assert(r.resultado === "ADIADO" && r.job_id === "job-sp", JSON.stringify(r)); }
    assert(db.tabelas.sync_jobs.length === 1 && job.status === "pendente" && job.tentativas === 0 && !db.tabelas.sync_jobs.some((j) => j.status === "erro"), "erro/tentativa acumulada");
    const jobs = db.tabelas.sync_jobs.map((j) => ({ id: j.id, lojaId: j.loja_id, marketplace: j.marketplace, campoTempo: j.campo_tempo, janelaInicio: j.janela_inicio, janelaFim: j.janela_fim,
      status: j.status, listagemCompleta: j.listagem_completa, concluidoEm: j.concluido_em, criadoEm: j.criado_em }));
    const av = P.avaliarLoja({ loja: { id: SP, marketplace: "Shopee" }, de: "2026-10-01", ate: "2026-10-01", agoraMs: T0, jobs, sinaisShopee: { escrowPendentes: 0, naoObservadosAposPeriodo: 0 }, politica: P.POLITICA_SYNC_PROPOSTA, origem: "usuario" });
    assert(av.proximaAcao.acao === "WAIT_ACTIVE_JOB" && (av.proximaAcao as any).jobId === "job-sp" && av.cobertura !== "FAILED", JSON.stringify(av.proximaAcao));
  });
  t("H2. credencial REALMENTE indisponivel no worker → erro de auth (comportamento existente)", async () => {
    const db = bancoFalso(lojasBase(), { jobs: [jobSP()] });
    const { r } = await silencio(() => W.executarWorkerCanonico(depsWorker(db, processo(db, async () => null).inj) as any, { orcamentoMs: 45_000, habilitado: true }));
    assert(r.resultado === "RECUSADO" && r.motivo === "credencial_indisponivel" && db.tabelas.sync_jobs[0].status === "erro" && db.tabelas.sync_jobs[0].erro_tipo === "auth", JSON.stringify(r));
  });

  console.log("\n[concorrencia, classificacao, sigilo]");
  t("J. dois processos canonicos: A renova, B ocupado espera o vencedor → provider chamado UMA vez, ambos OK", async () => {
    const db = bancoFalso(lojasBase()); const liberarProvider = porta(); const aTerminou = porta();
    const pa = processo(db, async () => { await liberarProvider.p; return { access_token: "A1", refresh_token: "R1", expire_in: 14400 }; });
    const pb = processo(db, nuncaProvider, { esperar: async () => { await aTerminou.p; } });
    const execA = SA.resolverCredencialShopee(DONO, SP, "canonico", pa.inj).then((r) => { aTerminou.abrir(); return r; });
    await aguardar(() => db.rpcs.some((x) => x.resultado === true), "A detem o lease");
    const execB = SA.resolverCredencialShopee(DONO, SP, "canonico", pb.inj);
    await aguardar(() => db.rpcs.filter((x) => x.nome.startsWith("adquirir")).length >= 2, "B tentou o lease");
    liberarProvider.abrir();
    const { r } = await silencio(() => Promise.all([execA, execB]));
    assert(r[0].status === "OK" && r[1].status === "OK" && pa.provider() + pb.provider() === 1, JSON.stringify({ a: r[0].status, b: r[1].status, n: pa.provider() + pb.provider() }));
  });
  t("K. loja/dono invalido: FK do lease → CREDENCIAL_INDISPONIVEL (loja_ou_dono_invalido), nunca REFRESH_EM_ANDAMENTO; loja ML nunca chega ao lease", async () => {
    const db = bancoFalso(lojasBase(), { rpc: "fk" }); const p = processo(db, nuncaProvider);
    const { r } = await silencio(() => SA.resolverCredencialShopee(DONO, SP, "canonico", p.inj));
    assert(r.status === "CREDENCIAL_INDISPONIVEL" && r.motivo === "loja_ou_dono_invalido" && p.provider() === 0, JSON.stringify(r));
    const db2 = bancoFalso(lojasBase()); const p2 = processo(db2, nuncaProvider);
    const { r: rml } = await silencio(() => SA.resolverCredencialShopee(DONO, ML, "canonico", p2.inj));
    const { r: rown } = await silencio(() => SA.resolverCredencialShopee(OUTRO, SP, "canonico", p2.inj));
    assert(rml.status === "CREDENCIAL_INDISPONIVEL" && rml.motivo === "loja_nao_encontrada" && rown.status === "CREDENCIAL_INDISPONIVEL" && db2.rpcs.length === 0, JSON.stringify({ rml, rown }));
  });
  t("L. nenhum segredo em resultado nao-OK nem em log (token, refresh_token, partner_key)", async () => {
    const casos: [Parameters<typeof bancoFalso>[1], (rt: string) => Promise<any>][] = [[{}, async () => null], [{ rpc: "inexistente" }, nuncaProvider], [{ rpc: "fk" }, nuncaProvider]];
    for (const [o, prov] of casos) {
      const db = bancoFalso(lojasBase(), o); const { r, saida } = await silencio(() => SA.resolverCredencialShopee(DONO, SP, "canonico", processo(db, prov).inj));
      assert(r.status !== "OK" && !SEGREDOS.test(JSON.stringify(r)) && !SEGREDOS.test(saida.join(" ")), `${JSON.stringify(o)}: vazou`);
    }
    const db = bancoFalso(lojasBase()); const { saida } = await silencio(() => SA.resolverCredencialShopee(DONO, SP, "canonico", processo(db, async () => ({ access_token: "A1", refresh_token: "R1", expire_in: 14400 })).inj));
    assert(!SEGREDOS.test(saida.join(" ")) && saida.some((s) => s.includes("SHOPEE_AUTH_OK")), "log do caminho OK vazou");
  });
  t("M. guardas: worker-deps usa o contrato DETALHADO em modo canonico; tipos discriminados (sem parsing de mensagem)", () => {
    const wd = readFileSync(join(RAIZ, "lib/vendas/sync/worker-deps.ts"), "utf8").replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "");
    assert(/resolverCredencialShopee\(job\.userId, job\.lojaId, "canonico"/.test(wd) && !/getShopeeLojaById|getShopeeLojaAtiva/.test(wd), "worker fora do contrato detalhado");
    const w = readFileSync(join(RAIZ, "lib/vendas/sync/worker.ts"), "utf8").replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "");
    assert(/if \("transitorio" in p\)/.test(w) && !/message\.includes|\.message\s*\.\s*match/.test(w), "worker classifica por mensagem");
    const sa = readFileSync(join(RAIZ, "lib/shopee-auth.ts"), "utf8");
    assert(/status: "REFRESH_EM_ANDAMENTO"/.test(sa) && /status: "LEASE_INDISPONIVEL"/.test(sa) && /status: "CREDENCIAL_INDISPONIVEL"/.test(sa) && /status: "OK"/.test(sa), "contrato incompleto");
  });

  await fila;
  console.log(`\n${falhou === 0 ? "✓" : "✗"} SHOPEE-AUTH-TRANSIENT — ${passou} passaram, ${falhou} falharam`);
  process.exit(falhou === 0 ? 0 : 1);
}
principal().catch((e) => { console.error("ERRO FATAL", e); process.exit(1); });
