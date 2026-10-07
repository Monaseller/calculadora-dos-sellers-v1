/**
 * SALES-SYNC-D1 — tick do coordenador canonico (offline).
 *
 * Sem rede, sem banco real. O duplo de banco IMPOE o indice real
 * idx_sync_jobs_loja_ativo (UM job pendente|rodando por loja → 23505);
 * `fetch` global e trocado por uma armadilha (nenhuma chamada a marketplace
 * pode acontecer) e toda chamada .rpc() do cliente e contada.
 *
 * Uso: npx tsx scripts/testar-vendas-sync-coordenador-tick.ts
 */
import "./_server-only-inerte";
import { execFileSync } from "node:child_process";
// SALES-CANONICAL-D13A: excecao minima e exata (capability owner-scoped + arquivos novos do D13)
import { blocoD13Credenciais, filtrarExcecaoD13 } from "./_excecao-d13-vendas-canonicas";
// SALES-CANONICAL-D14B: excecao EXATA do patch D14 nos leitores (ATUAL − patch aprovado = bytes de 1c4fe29)
import { filtrarExcecaoD14 } from "./_excecao-d14-vendas-canonicas";
// SALES-SYNC-D15B2: excecao EXATA do patch D15B nos arquivos de sync (ATUAL − patch aprovado = bytes de d631748)
import { filtrarExcecaoD15B } from "./_excecao-d15b-intraday";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
const BASE = "76cf613";
const AGORA = Date.parse("2026-10-06T17:00:00Z"); // hoje em SP = 06/10
const HOJE_INICIO = "2026-10-06T03:00:00.000Z";
const H = 3600e3;
const SEGREDO_FALSO = "tok-NAO-PODE-VAZAR-7c1e";
/** Projecao interna da capability (D4): credencial lida SO para classificar elegibilidade. */
const PROJECAO_CAPABILITY = "id, user_id, marketplace, access_token, refresh_token, token_expires_at, seller_id, partner_id, partner_key";
const DA = "dono-a", DB = "dono-b", DC = "dono-c";
const MLA = "11111111-1111-4111-8111-111111111111", MLB = "22222222-2222-4222-8222-222222222222";
const SPA = "33333333-3333-4333-8333-333333333333", SPB = "44444444-4444-4444-8444-444444444444";
const MLC = "55555555-5555-4555-8555-555555555555", SPC = "66666666-6666-4666-8666-666666666666";

// ── armadilha de rede: o tick nunca pode chamar marketplace ──
let chamadasFetch = 0;
(globalThis as any).fetch = async () => { chamadasFetch++; throw new Error("rede proibida no tick"); };

async function principal() {
  const T = await import("../lib/vendas/sync/coordenador-tick");
  const JM = await import("../lib/mercado-livre/ingestao/janelas");
  const CS = await import("../lib/vendas/canonico/shopee");
  const MW = await import("../lib/middleware-rotas");
  let seq = 0;

  // ── duplo de banco (lojas, sync_jobs, shopee_pedidos) que impoe o indice unico real ──
  type Reg = { tabela: string; op: string; colunas: string; filtros: [string, string, unknown][] };
  type Opcoes = { falhar?: (tabela: string, filtros: [string, string, unknown][]) => boolean; forcar23505?: boolean };
  function bancoFalso(lojas: Record<string, any>[], jobs: Record<string, any>[] = [], o: Opcoes = {}) {
    const regs: Reg[] = []; let rpcs = 0; const db: Record<string, any[]> = { lojas, sync_jobs: jobs, shopee_pedidos: [] };
    const cliente: any = {
      rpc: async () => { rpcs++; return { data: null, error: { code: "PROIBIDO" } }; },
      from(tabela: string) {
        const r: Reg = { tabela, op: "select", colunas: "", filtros: [] }; regs.push(r); let head = false; let inserir: any = null;
        let ordem: string | null = null; let faixa: [number, number] | null = null;
        const casa = (l: any) => r.filtros.every(([op, c, v]: any) => op === "eq" ? String(l[c]) === String(v) : op === "in" ? v.map(String).includes(String(l[c]))
          : op === "is" ? (l[c] ?? null) === v : op === "notnull" ? (l[c] ?? null) !== null : op === "gte" ? l[c] >= v : op === "lt" ? l[c] < v : true);
        const q: any = new Proxy({}, { get(_a, p: string) {
          if (p === "then") return (ok: any) => {
            if (o.falhar?.(tabela, r.filtros)) return ok({ data: null, error: { code: "XX000", message: `falha interna ${SEGREDO_FALSO}` } });
            if (inserir) {
              const ativo = o.forcar23505 || (db.sync_jobs.some((j) => j.loja_id === inserir.loja_id && ["pendente", "rodando"].includes(j.status)) && ["pendente", "rodando"].includes(inserir.status));
              if (ativo) return ok({ data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "idx_sync_jobs_loja_ativo"' } });
              const novo = { id: `db${++seq}`, criado_em: new Date(AGORA).toISOString(), concluido_em: null, campo_tempo: null, janela_inicio: null, janela_fim: null, checkpoint: null, ...inserir };
              db.sync_jobs.push(novo);
              return ok({ data: { id: novo.id }, error: null });
            }
            let d = (db[tabela] ?? []).filter(casa).map((l: any) => (tabela === "sync_jobs" ? { ...l, modo: l.checkpoint?.modo ?? null } : l));
            if (ordem) d = [...d].sort((x: any, y: any) => String(x[ordem!]).localeCompare(String(y[ordem!])));
            if (faixa) d = d.slice(faixa[0], faixa[1] + 1);
            return ok(head ? { data: null, count: d.length, error: null } : { data: d, error: null });
          };
          if (p === "select") return (c: string, op?: any) => { r.colunas = c; if (op?.head) head = true; return q; };
          if (p === "insert") return (linha: any) => { r.op = "insert"; inserir = { ...linha }; return q; };
          if (p === "single") return () => q;
          if (p === "order") return (c: string) => { ordem = c; return q; };
          if (p === "range") return (a: number, z: number) => { faixa = [a, z]; return q; };
          if (p === "not") return (c: string, o: string, v: unknown) => { if (o === "is" && v === null) r.filtros.push(["notnull", c, null]); return q; };
          return (...a: any[]) => { if (["eq", "in", "is", "gte", "lt"].includes(p)) r.filtros.push([p, a[0], a[1]]); return q; };
        } });
        return q;
      },
    };
    return { cliente, regs, db, rpcs: () => rpcs };
  }
  const loja = (id: string, user_id: string, marketplace: string, o: Record<string, any> = {}) =>
    ({ id, user_id, marketplace, ativo: true, access_token: SEGREDO_FALSO, refresh_token: SEGREDO_FALSO, partner_key: SEGREDO_FALSO,
      seller_id: "seller-fixture", partner_id: 1, token_expires_at: null, ...o });
  const linhaML = (lojaId: string, userId: string, de: string, ate: string, o: Record<string, any> = {}) => { const l = JM.limitesDaJanela(de, ate)!;
    return { id: `r${++seq}`, user_id: userId, loja_id: lojaId, marketplace: "ML", campo_tempo: "date_closed", janela_inicio: l.inicio.toISOString(), janela_fim: l.fim.toISOString(),
      status: "concluido", listagem_completa: true, concluido_em: new Date(AGORA - H).toISOString(), criado_em: new Date(AGORA - 2 * H).toISOString(), checkpoint: null, ...o }; };
  /** create_time cobrindo [de − prazo de pagamento, fim de `ate`] — cobertura Shopee de [de, ate]. */
  const linhaSP = (lojaId: string, userId: string, de: string, ate: string, o: Record<string, any> = {}) => { const l = JM.limitesDaJanela(de, ate)!;
    return { id: `r${++seq}`, user_id: userId, loja_id: lojaId, marketplace: "Shopee", campo_tempo: "create_time",
      janela_inicio: new Date(l.inicio.getTime() - CS.LIMITE_POLITICA_PAGAMENTO_MS).toISOString(), janela_fim: l.fim.toISOString(),
      status: "concluido", listagem_completa: true, concluido_em: new Date(AGORA - H).toISOString(), criado_em: new Date(AGORA - 2 * H).toISOString(), checkpoint: null, ...o }; };
  const rodar = async (b: ReturnType<typeof bancoFalso>, o: { agoraMs?: number; orcamentoMs?: number; logs?: Record<string, unknown>[] } = {}) =>
    T.executarTickCoordenador(() => ({ cliente: b.cliente, relogio: { agoraMs: () => o.agoraMs ?? AGORA }, log: (e) => o.logs?.push(e) }), { orcamentoMs: o.orcamentoMs ?? 45_000, habilitado: true });
  const criados = (b: ReturnType<typeof bancoFalso>) => b.db.sync_jobs.filter((j) => j.status === "pendente" && String(j.id).startsWith("db"));
  const de = (r: Awaited<ReturnType<typeof rodar>>, id: string) => r.resultados.find((x) => x.lojaId === id)!;
  const ativosPorLoja = (b: ReturnType<typeof bancoFalso>) => { const m = new Map<string, number>();
    for (const j of b.db.sync_jobs) if (["pendente", "rodando"].includes(j.status)) m.set(j.loja_id, (m.get(j.loja_id) ?? 0) + 1); return m; };
  const semHoje = (j: Record<string, any>) => j.janela_fim <= HOJE_INICIO && j.date_to < "2026-10-06";
  const toques = (b: ReturnType<typeof bancoFalso>) => {
    assert(b.rpcs() === 0, "rpc chamada (lease/credencial)");
    assert(b.regs.every((r) => ["lojas", "sync_jobs", "shopee_pedidos"].includes(r.tabela)), `tabela fora do escopo: ${[...new Set(b.regs.map((r) => r.tabela))]}`);
    // D4: a capability le credencial INTERNAMENTE so para classificar — projecao fixa, nunca "*"; o que SAI e checado nos testes de saida
    // (a outra leitura de lojas e a do coordenador reutilizado, inalterado: so "id, marketplace")
    assert(b.regs.filter((r) => r.tabela === "lojas").every((r) => r.colunas === PROJECAO_CAPABILITY || r.colunas === "id, marketplace"), "lojas lida fora das projecoes conhecidas");
    assert(b.regs.filter((r) => r.op === "insert").every((r) => r.tabela === "sync_jobs"), "insert fora de sync_jobs");
  };

  console.log("\n[25-27. lojas]");
  t("25. zero lojas elegiveis → OK, 0 avaliadas, 0 jobs (inativa e marketplace nao suportado ficam fora)", async () => {
    const b = bancoFalso([loja(MLA, DA, "ML", { ativo: false }), loja(SPA, DA, "Amazon")]);
    const r = await rodar(b);
    assert(r.resultado === "OK" && r.lojasAvaliadas === 0 && r.jobsCriados === 0 && r.resultados.length === 0 && criados(b).length === 0, JSON.stringify(r));
    toques(b);
  });
  t("26. ML nova sem corpus → bootstrap 7 dias, EXATAMENTE 1 job date_closed, o bloco mais recente, nunca sobre hoje", async () => {
    const b = bancoFalso([loja(MLA, DA, "ML")]);
    const r = await rodar(b); const j = criados(b);
    assert(r.jobsCriados === 1 && j.length === 1 && de(r, MLA).acao === "JOB_CREATED" && de(r, MLA).faseBootstrap === "ULTIMOS_7_DIAS", JSON.stringify(r));
    assert(j[0].campo_tempo === "date_closed" && j[0].marketplace === "ML" && j[0].user_id === DA && j[0].date_to === "2026-10-05" && j[0].date_from >= "2026-09-29" && semHoje(j[0]), JSON.stringify(j[0]));
    toques(b);
  });
  t("27. Shopee nova sem corpus → 1 job create_time recente, sem auth/API", async () => {
    const b = bancoFalso([loja(SPA, DA, "Shopee")]); const f0 = chamadasFetch;
    const r = await rodar(b); const j = criados(b);
    assert(r.jobsCriados === 1 && j.length === 1 && j[0].campo_tempo === "create_time" && j[0].janela_fim === HOJE_INICIO && j[0].user_id === DA && semHoje(j[0]), JSON.stringify(j));
    assert(chamadasFetch === f0, "fetch chamado"); toques(b);
  });

  console.log("\n[28. multi-loja / dono]");
  t("28. ML A, ML B, Shopee A, Shopee B (donos diferentes) → avaliadas independentes, 1 job por loja, dono = o da linha", async () => {
    const b = bancoFalso([loja(MLA, DA, "ML"), loja(MLB, DB, "ML"), loja(SPA, DA, "Shopee"), loja(SPB, DC, "Shopee")]);
    const r = await rodar(b); const j = criados(b);
    assert(r.lojasAvaliadas === 4 && r.jobsCriados === 4 && j.length === 4, JSON.stringify(r));
    const dono: Record<string, string> = { [MLA]: DA, [MLB]: DB, [SPA]: DA, [SPB]: DC };
    for (const x of j) assert(x.user_id === dono[x.loja_id] && x.marketplace === (x.loja_id === MLA || x.loja_id === MLB ? "ML" : "Shopee"), `cross-owner: ${JSON.stringify(x)}`);
    // toda leitura de sync_jobs/shopee_pedidos foi filtrada pelo dono da loja lida
    for (const reg of b.regs.filter((x) => x.tabela !== "lojas" && x.op === "select")) assert(reg.filtros.some(([op, c]) => op === "eq" && c === "user_id"), `leitura sem dono: ${reg.tabela}`);
    toques(b);
  });
  t("28b. cross-owner: job completo de OUTRO dono na mesma loja nao conta como cobertura nem bloqueia", async () => {
    const forjado = linhaML(MLA, DB, "2026-01-01", "2026-10-05");
    const ativoAlheio = { ...linhaML(MLA, DB, "2026-10-05", "2026-10-05"), status: "rodando" };
    const b = bancoFalso([loja(MLA, DA, "ML")], [forjado]);
    const r = await rodar(b);
    assert(de(r, MLA).acao === "JOB_CREATED" && de(r, MLA).faseBootstrap === "ULTIMOS_7_DIAS" && criados(b)[0].user_id === DA, JSON.stringify(r));
    // linha ativa de outro dono: o planner nao a ve; o indice real (por loja) e quem decide → 23505 → WAIT, nunca erro
    const b2 = bancoFalso([loja(MLA, DA, "ML")], [ativoAlheio]);
    const r2 = await rodar(b2);
    assert(de(r2, MLA).acao === "WAIT_ACTIVE_JOB" && r2.falhas === 0 && criados(b2).length === 0, JSON.stringify(r2));
  });
  t("28c. lojas descobertas dinamicamente: nova conta entra no proximo tick sem codigo", async () => {
    const b = bancoFalso([loja(MLA, DA, "ML")]);
    await rodar(b);
    b.db.lojas.push(loja(SPC, DC, "Shopee"));
    const r = await rodar(b);
    assert(r.lojasAvaliadas === 2 && de(r, SPC).acao === "JOB_CREATED" && de(r, MLA).acao === "WAIT_ACTIVE_JOB", JSON.stringify(r));
  });

  console.log("\n[29-30. job ativo / concorrencia]");
  t("29. loja A com job ativo → WAIT; loja B precisa → CREATE; A nao bloqueia B", async () => {
    const b = bancoFalso([loja(MLA, DA, "ML"), loja(MLB, DA, "ML")], [{ ...linhaML(MLA, DA, "2026-10-05", "2026-10-05"), status: "pendente", concluido_em: null }]);
    const r = await rodar(b);
    assert(de(r, MLA).acao === "WAIT_ACTIVE_JOB" && de(r, MLB).acao === "JOB_CREATED" && r.jobsCriados === 1 && r.aguardando === 1, JSON.stringify(r));
    assert(ativosPorLoja(b).get(MLA) === 1 && ativosPorLoja(b).get(MLB) === 1, "mais de um ativo");
  });
  t("30. dois ticks simultaneos → no maximo 1 job ativo por loja; perdedor = WAIT, nunca falha", async () => {
    const b = bancoFalso([loja(MLA, DA, "ML"), loja(MLB, DB, "ML"), loja(SPA, DA, "Shopee"), loja(SPB, DC, "Shopee")]);
    const [r1, r2] = await Promise.all([rodar(b), rodar(b)]);
    for (const [, n] of ativosPorLoja(b)) assert(n === 1, "duplicou job ativo");
    assert(criados(b).length === 4 && r1.jobsCriados + r2.jobsCriados === 4 && r1.falhas + r2.falhas === 0, `${JSON.stringify(r1)} ${JSON.stringify(r2)}`);
    assert(r1.resultados.concat(r2.resultados).every((x) => x.acao === "JOB_CREATED" || x.acao === "WAIT_ACTIVE_JOB"), "acao inesperada");
  });
  t("30b. 23505 no insert (corrida perdida) → WAIT_ACTIVE_JOB, falhas 0, resultado OK", async () => {
    const b = bancoFalso([loja(MLA, DA, "ML"), loja(SPA, DA, "Shopee")], [], { forcar23505: true });
    const r = await rodar(b);
    assert(r.resultado === "OK" && r.falhas === 0 && r.jobsCriados === 0 && r.resultados.every((x) => x.acao === "WAIT_ACTIVE_JOB"), JSON.stringify(r));
  });

  console.log("\n[31-33. NOOP / STALE / FAILED]");
  t("31. COMPLETE + FRESH (ML e Shopee, ano inteiro) → NOOP, 0 job, fase COMPLETO, definitivo", async () => {
    const b = bancoFalso([loja(MLA, DA, "ML"), loja(SPA, DA, "Shopee")], [linhaML(MLA, DA, "2026-01-01", "2026-10-05"), linhaSP(SPA, DA, "2026-01-01", "2026-10-05")]);
    const r = await rodar(b);
    for (const id of [MLA, SPA]) { const x = de(r, id); assert(x.acao === "NOOP" && x.faseBootstrap === "COMPLETO" && x.estado?.definitivo === true, JSON.stringify(x)); }
    assert(r.noop === 2 && r.jobsCriados === 0 && criados(b).length === 0, JSON.stringify(r));
  });
  t("32. COMPLETE + STALE → o coordenador decide refresh; a rota cria no maximo 1", async () => {
    const velho = { concluido_em: new Date(AGORA - 10 * H).toISOString() }; // faixa <=7d exige 6h
    const b = bancoFalso([loja(MLA, DA, "ML"), loja(SPA, DA, "Shopee")], [linhaML(MLA, DA, "2026-01-01", "2026-10-05", velho), linhaSP(SPA, DA, "2026-01-01", "2026-10-05", velho)]);
    const r = await rodar(b); const j = criados(b);
    assert(r.jobsCriados === 2 && j.length === 2 && r.resultados.every((x) => x.tipoJob === "CREATE_REFRESH_JOB" && x.estado?.frescor === "STALE" && x.estado.cobertura === "COMPLETE"), JSON.stringify(r));
    assert(j.every(semHoje), "refresh sobre hoje");
    const r2 = await rodar(b);
    assert(r2.jobsCriados === 0 && r2.resultados.every((x) => x.acao === "WAIT_ACTIVE_JOB"), "segundo tick criou outro");
  });
  t("33. necessidade no limite de falhas → FAILED, 0 job (e continua 0 nos ticks seguintes)", async () => {
    const erro = (h: number) => ({ ...linhaML(MLA, DA, "2026-10-05", "2026-10-05"), status: "erro", listagem_completa: false, concluido_em: new Date(AGORA - h * H).toISOString(), criado_em: new Date(AGORA - h * H).toISOString() });
    const b = bancoFalso([loja(MLA, DA, "ML")], [linhaML(MLA, DA, "2026-01-01", "2026-10-04"), erro(3), erro(2), erro(1)]);
    const r = await rodar(b); const r2 = await rodar(b);
    assert(de(r, MLA).acao === "FAILED" && r.esgotadas === 1 && r.falhas === 0 && criados(b).length === 0 && de(r2, MLA).acao === "FAILED", JSON.stringify(r));
  });
  t("33b. uma falha recente → WAIT_RETRY (cooldown do planner), 0 job", async () => {
    const e = { ...linhaML(MLA, DA, "2026-10-05", "2026-10-05"), status: "erro", listagem_completa: false, concluido_em: new Date(AGORA - 0.1 * H).toISOString() };
    const b = bancoFalso([loja(MLA, DA, "ML")], [linhaML(MLA, DA, "2026-01-01", "2026-10-04"), e]);
    const r = await rodar(b);
    assert(de(r, MLA).acao === "WAIT_RETRY" && criados(b).length === 0, JSON.stringify(r));
  });

  console.log("\n[8/19-20. bootstrap progressivo / virada do ano]");
  t("19. fase derivada do corpus: 7d completo → ULTIMOS_30_DIAS; 30d completo → ANO_CORRENTE; sempre o mais recente que falta", async () => {
    const b = bancoFalso([loja(MLA, DA, "ML")], [linhaML(MLA, DA, "2026-09-29", "2026-10-05")]);
    const r = await rodar(b); const j = criados(b)[0];
    assert(de(r, MLA).faseBootstrap === "ULTIMOS_30_DIAS" && j.date_to === "2026-09-28", JSON.stringify({ r: de(r, MLA), j }));
    const b2 = bancoFalso([loja(MLA, DA, "ML")], [linhaML(MLA, DA, "2026-09-06", "2026-10-05")]);
    const r2 = await rodar(b2); const j2 = criados(b2)[0];
    assert(de(r2, MLA).faseBootstrap === "ANO_CORRENTE" && j2.date_to === "2026-09-05" && r2.jobsCriados === 1, JSON.stringify({ r: de(r2, MLA), j2 }));
  });
  t("19b. bootstrap NAO cria varios jobs: N ticks com o job anterior pendente → sempre 1 ativo", async () => {
    const b = bancoFalso([loja(MLA, DA, "ML"), loja(SPA, DA, "Shopee")]);
    for (let i = 0; i < 4; i++) await rodar(b);
    assert(criados(b).length === 2 && [...ativosPorLoja(b).values()].every((n) => n === 1), JSON.stringify(criados(b).length));
  });
  t("19c. avanco: job concluido → proximo tick cria o bloco anterior (mais recente primeiro), ML em blocos <= politica", async () => {
    const b = bancoFalso([loja(MLA, DA, "ML")]);
    const vistos: string[] = [];
    for (let i = 0; i < 3; i++) {
      await rodar(b);
      const p = b.db.sync_jobs.find((j) => j.status === "pendente")!;
      vistos.push(`${p.date_from}..${p.date_to}`);
      Object.assign(p, { status: "concluido", listagem_completa: true, concluido_em: new Date(AGORA - 0.5 * H).toISOString() });
    }
    // os blocos sao do planner (cortados a partir do inicio da janela, <= maxDiasPorJobML): aqui so a ordem e a contiguidade
    const dias = (a: string, z: string) => Math.round((Date.parse(z) - Date.parse(a)) / 864e5) + 1;
    const iv = vistos.map((v) => v.split(".."));
    assert(iv[0][1] === "2026-10-05" && iv.every(([a, z]) => dias(a, z) >= 1 && dias(a, z) <= 7), vistos.join(" | "));
    assert(iv.slice(1).every(([, z], i) => dias(z, iv[i][0]) === 2), `nao contiguo/decrescente: ${vistos.join(" | ")}`);
  });
  t("19d. janela de manutencao (90d) completa e fresca, ano incompleto → so o BOOTSTRAP pede trabalho: dia anterior a janela, mais recente primeiro", async () => {
    const b = bancoFalso([loja(MLA, DA, "ML"), loja(SPA, DA, "Shopee")], [linhaML(MLA, DA, "2026-07-08", "2026-10-05"), linhaSP(SPA, DA, "2026-07-08", "2026-10-05")]);
    const r = await rodar(b);
    const jm = criados(b).find((j) => j.loja_id === MLA)!, js = criados(b).find((j) => j.loja_id === SPA)!;
    assert(de(r, MLA).faseBootstrap === "ANO_CORRENTE" && de(r, MLA).estado?.definitivo === true && jm?.date_to === "2026-07-07", JSON.stringify({ r: de(r, MLA), jm }));
    assert(de(r, SPA).faseBootstrap === "ANO_CORRENTE" && js?.campo_tempo === "create_time" && js.janela_fim <= linhaSP(SPA, DA, "2026-07-08", "2026-07-08").janela_inicio, JSON.stringify({ r: de(r, SPA), js }));
  });
  t("20. virada do ano automatica: 01/01 nao quebra (ano sem dia fechado) e 05/01 ja pede o ano novo", async () => {
    const jan1 = Date.parse("2027-01-01T15:00:00Z"), jan5 = Date.parse("2027-01-05T15:00:00Z");
    const b = bancoFalso([loja(MLA, DA, "ML")]);
    const r = await rodar(b, { agoraMs: jan1 });
    assert(de(r, MLA).acao === "JOB_CREATED" && criados(b)[0].date_to === "2026-12-31", JSON.stringify(r));
    const ano = { concluido_em: new Date(jan1 - H).toISOString() };
    const c = bancoFalso([loja(MLA, DA, "ML")], [linhaML(MLA, DA, "2026-01-01", "2026-12-31", ano)]);
    const rc = await rodar(c, { agoraMs: jan1 });
    assert(de(rc, MLA).acao === "NOOP" && de(rc, MLA).faseBootstrap === "COMPLETO", JSON.stringify(rc));
    const d = bancoFalso([loja(MLA, DA, "ML")], [linhaML(MLA, DA, "2026-01-01", "2026-12-31", { concluido_em: new Date(jan5 - H).toISOString() })]);
    const rd = await rodar(d, { agoraMs: jan5 }); const jd = criados(d)[0];
    assert(de(rd, MLA).acao === "JOB_CREATED" && jd.date_from === "2027-01-01" && jd.date_to === "2027-01-04", JSON.stringify({ rd, jd }));
  });

  console.log("\n[17. isolamento por loja / infra]");
  t("17. Shopee A com erro de planejamento → STORE_FAILED (motivo sanitizado); ML A segue e cria", async () => {
    const b = bancoFalso([loja(MLA, DA, "ML"), loja(SPA, DA, "Shopee")], [], { falhar: (tab, f) => tab === "shopee_pedidos" && f.some(([, c, v]) => c === "loja_id" && v === SPA) });
    const logs: Record<string, unknown>[] = [];
    const r = await rodar(b, { logs });
    assert(de(r, SPA).acao === "STORE_FAILED" && de(r, MLA).acao === "JOB_CREATED" && r.falhas === 1 && r.resultado === "OK", JSON.stringify(r));
    assert(!JSON.stringify(r).includes(SEGREDO_FALSO) && !JSON.stringify(logs).includes(SEGREDO_FALSO) && /^[a-z_]+$/.test(de(r, SPA).motivo ?? ""), "erro cru vazou");
    assert(logs.some((e) => e.evento === "STORE_FAILED" && e.loja_id === SPA), "sem log STORE_FAILED");
  });
  t("17b. todas as lojas falham → resultado ERRO (nao mascara infra); listar lojas falha → excecao (rota 500)", async () => {
    const b = bancoFalso([loja(MLA, DA, "ML"), loja(SPA, DA, "Shopee")], [], { falhar: (tab) => tab === "sync_jobs" });
    const r = await rodar(b);
    assert(r.resultado === "ERRO" && r.falhas === 2, JSON.stringify(r));
    const c = bancoFalso([loja(MLA, DA, "ML")], [], { falhar: (tab) => tab === "lojas" });
    let lancou = false; try { await rodar(c); } catch { lancou = true; }
    assert(lancou, "falha global engolida");
  });
  t("16. orcamento: loja que nao cabe → NAO_AVALIADA_ORCAMENTO, sem leitura nem job", async () => {
    const b = bancoFalso([loja(MLA, DA, "ML"), loja(SPA, DA, "Shopee")]);
    const r = await rodar(b, { orcamentoMs: -1 });
    assert(r.naoAvaliadas === 2 && r.lojasAvaliadas === 0 && criados(b).length === 0 && b.regs.every((x) => x.tabela === "lojas"), JSON.stringify(r));
  });
  t("15. 6 lojas elegiveis sem job → 6 jobs (1 por loja, nao 1 global)", async () => {
    const b = bancoFalso([loja(MLA, DA, "ML"), loja(MLB, DB, "ML"), loja(MLC, DC, "ML"), loja(SPA, DA, "Shopee"), loja(SPB, DB, "Shopee"), loja(SPC, DC, "Shopee")]);
    const r = await rodar(b);
    assert(r.jobsCriados === 6 && new Set(criados(b).map((j) => j.loja_id)).size === 6, JSON.stringify(r));
  });

  console.log("\n[4/24. flag / logs]");
  t("4. flag OFF → DESABILITADO sem construir cliente, sem listar lojas", async () => {
    let construiu = false;
    const r = await T.executarTickCoordenador(() => { construiu = true; throw new Error("nao devia"); }, { orcamentoMs: 45_000 });
    assert(r.resultado === "DESABILITADO" && !construiu && r.lojasAvaliadas === 0, JSON.stringify(r));
  });
  t("24. logs: START, STORE_EVALUATED, JOB_CREATED, WAIT_ACTIVE_JOB, NOOP, DONE — sem segredo nem dono", async () => {
    const b = bancoFalso([loja(MLA, DA, "ML"), loja(MLB, DA, "ML"), loja(SPA, DA, "Shopee")],
      [{ ...linhaML(MLB, DA, "2026-10-05", "2026-10-05"), status: "rodando" }, linhaSP(SPA, DA, "2026-01-01", "2026-10-05")]);
    const logs: Record<string, unknown>[] = [];
    await rodar(b, { logs });
    const ev = logs.map((e) => e.evento);
    for (const x of ["COORDINATOR_TICK_START", "STORE_EVALUATED", "JOB_CREATED", "WAIT_ACTIVE_JOB", "NOOP", "COORDINATOR_TICK_DONE"]) assert(ev.includes(x), `falta ${x}: ${ev}`);
    const s = JSON.stringify(logs);
    assert(!s.includes(SEGREDO_FALSO) && !s.includes(DA) && !/token|partner/i.test(s), "log com segredo/dono");
  });
  t("18. relatorio sanitizado: sem token, partner_key, dono ou dados de comprador", async () => {
    const b = bancoFalso([loja(MLA, DA, "ML"), loja(SPA, DB, "Shopee")]);
    const s = JSON.stringify(await rodar(b));
    assert(!s.includes(SEGREDO_FALSO) && !s.includes(DA) && !s.includes(DB) && !/token|partner|buyer|comprador/i.test(s), s);
  });

  console.log("\n[34-35. guardas: auth e motor nao sao tocados]");
  const semComentarios = (f: string) => readFileSync(join(RAIZ, f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  const ARQS = ["lib/vendas/sync/coordenador-tick.ts", "app/api/internal/vendas-sync/coordenador/route.ts"];
  t("34. tick/rota nao resolvem credencial nem renovam token (texto) e nenhum fetch/rpc ocorreu (runtime)", () => {
    for (const f of ARQS) {
      const s = semComentarios(f);
      assert(!/resolverCredencialShopee|getShopeeLojaById|getShopeeLojaAtiva|getMLLojaById|getMLLojaAtiva|getMLToken|refreshMLToken|refreshShopeeToken|renovar|lease|access_token|refresh_token|partner_key/i.test(s), `${f}: auth`);
      assert(!/shopee-auth|ml-auth|transporte|\bfetch\(|\.rpc\(/.test(s), `${f}: import/rede`);
      // da capability de lojas, SO a listagem sem credencial (D1.1): nada de ler/gravar/lease de credencial
      const imps = [...s.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*"@\/lib\/marketplace\/credenciais"/g)];
      const nomes = imps.flatMap((m) => m[1].split(",").map((x) => x.trim()).filter(Boolean));
      assert((s.match(/marketplace\/credenciais/g) ?? []).length === imps.length && nomes.every((x) => x === "listarLojasAtivasParaSyncCanonico" || x === "type ElegibilidadeSyncCanonico"), `${f}: importa da capability alem da listagem: ${nomes}`);
    }
    assert(chamadasFetch === 0, `fetch chamado ${chamadasFetch}x`);
  });
  t("35. tick/rota nao executam motor nem worker; coordenador reutilizado tambem nao", () => {
    for (const f of [...ARQS, "lib/vendas/sync/coordenador.ts", "lib/vendas/sync/planejamento.ts"]) {
      const s = semComentarios(f);
      assert(!/executarFatiaML|executarFatiaShopee|executarFatiaCatchUpEscrow|executarWorkerCanonico|vendas\/sync\/worker|worker-deps/.test(s), `${f}: motor/worker`);
    }
    const tick = semComentarios(ARQS[0]);
    assert(/avaliarNecessidadeDeSync/.test(tick) && /garantirProximaAcao/.test(tick) && /avaliarBootstrap/.test(tick), "nao reutiliza o coordenador");
    assert(!/prioridadeDe|escolherProximaAcao|intervaloDeFrescor|maxFalhasPorNecessidade|esperaAposFalhaMs|planejarJanelasCriacao|insert\(/.test(tick), "tick recria regra do planner / insere direto");
    assert(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|MONAMOR|shop_id|seller_id/i.test(tick + semComentarios(ARQS[1])), "loja fixa");
  });

  console.log("\n[D1.1 descoberta pela capability]");
  const CAP = "lib/marketplace/credenciais.ts";
  const corpoCap = () => { const c = semComentarios(CAP); const i = c.indexOf("export async function listarLojasAtivasParaSyncCanonico"); const j = c.indexOf("\nexport ", i + 1); return i < 0 ? "" : c.slice(i, j < 0 ? undefined : j); };
  t("D1.1-a. o tick NAO acessa `lojas` direto: so pela capability listarLojasAtivasParaSyncCanonico", () => {
    const s = semComentarios(ARQS[0]);
    assert(!/\.from\(\s*["'`]lojas["'`]\s*\)/.test(s) && !/["'`]lojas["'`]/.test(s), "acesso direto a lojas no tick");
    assert(/listarLojasAtivasParaSyncCanonico\(/.test(s) && /from "@\/lib\/marketplace\/credenciais"/.test(s), "tick nao usa a capability");
    assert(!/["'`]lojas["'`]/.test(semComentarios(ARQS[1])), "rota acessa lojas");
  });
  t("D1.1-b. capability: projecao minima (id, user_id, marketplace), ativo, ML/Shopee, com dono, ordem por id, pagina 500, erro estavel, sem credencial", () => {
    const c = corpoCap(); const sel = (c.match(/\.select\([^)]*\)/g) ?? []).join(" ");
    assert(c !== "" && sel === `.select("${PROJECAO_CAPABILITY}")`, `projecao: ${sel}`);
    // D4: o que SAI e so (id, user_id, marketplace, elegibilidade) — um unico push, com esses 4 campos
    assert((c.match(/linhas\.push\(/g) ?? []).length === 1
      && /linhas\.push\(\{ id: l\.id, user_id: l\.user_id, marketplace: l\.marketplace, elegibilidade: classificarElegibilidadeSyncCanonico\(l, agoraMs\) \}\)/.test(c), "retorno alem dos 4 campos");
    assert(/\.eq\("ativo", true\)/.test(c) && /\.in\("marketplace", \[MARKETPLACE_ML, MARKETPLACE_SHOPEE\]\)/.test(c) && /\.not\("user_id", "is", null\)/.test(c), "filtros");
    assert(/\.order\("id", \{ ascending: true \}\)/.test(c) && /PAGINA_LOJAS_SYNC_CANONICO = 500/.test(semComentarios(CAP)) && /\.range\(/.test(c), "ordem/paginacao");
    assert(/erro: "erro_consulta_loja"/.test(c) && !/error\.message/.test(c), "erro");
    assert(!/getShopeeLojaById|getMLLojaById|resolverCredencial|gravarCredencial|adquirirLease|renovar|refreshMLToken|refreshShopeeToken|fetch\(|\.update\(|\.insert\(|\.rpc\(/.test(c), "auth/escrita");
  });
  t("D1.1-c. capability em runtime: so ativas ML/Shopee com dono, sem credencial no retorno; 1201 lojas paginadas sem perda nem duplicata; erro estavel", async () => {
    const CR = await import("../lib/marketplace/credenciais");
    const b = bancoFalso([loja(MLB, DA, "ML"), loja(MLA, DB, "Shopee"), loja(SPA, null as any, "ML"), loja(SPB, DA, "Amazon"), loja(MLC, DA, "ML", { ativo: false })]);
    const r = await CR.listarLojasAtivasParaSyncCanonico(b.cliente);
    assert(r.erro === null && JSON.stringify(r.linhas) === JSON.stringify([{ id: MLA, user_id: DB, marketplace: "Shopee", elegibilidade: { estado: "ELEGIVEL" } }, { id: MLB, user_id: DA, marketplace: "ML", elegibilidade: { estado: "ELEGIVEL" } }]), JSON.stringify(r));
    assert(!JSON.stringify(r).includes(SEGREDO_FALSO) && r.linhas.every((l) => Object.keys(l).sort().join() === "elegibilidade,id,marketplace,user_id"), "devolveu credencial");
    const muitas = Array.from({ length: 1201 }, (_, i) => loja(`l${String(i).padStart(5, "0")}`, `d${i % 7}`, i % 2 ? "ML" : "Shopee"));
    const b2 = bancoFalso([...muitas].reverse());
    const r2 = await CR.listarLojasAtivasParaSyncCanonico(b2.cliente);
    assert(r2.linhas.length === 1201 && new Set(r2.linhas.map((l) => l.id)).size === 1201 && r2.linhas.every((l, i) => l.id === `l${String(i).padStart(5, "0")}` && l.user_id === `d${i % 7}`), `${r2.linhas.length}`);
    assert(b2.regs.filter((x) => x.tabela === "lojas").length === 3, "paginas != 3");
    const ruim = await CR.listarLojasAtivasParaSyncCanonico(bancoFalso([loja(MLA, DA, "ML")], [], { falhar: (tab) => tab === "lojas" }).cliente);
    assert(ruim.erro === "erro_consulta_loja" && ruim.linhas.length === 0 && !JSON.stringify(ruim).includes(SEGREDO_FALSO), JSON.stringify(ruim));
  });

  console.log("\n[3. auth da rota]");
  t("3. sem secret → 401; errado → 401; sem CRON_SECRET → 401; correto → DESABILITADO; segredo nunca aparece", async () => {
    const R = await import("../app/api/internal/vendas-sync/coordenador/route");
    const SEG = "segredo-de-teste-d1-4b2a";
    const saidas: string[] = []; const log = console.log, err = console.error;
    console.log = (...a: unknown[]) => { saidas.push(a.map(String).join(" ")); }; console.error = (...a: unknown[]) => { saidas.push(a.map(String).join(" ")); };
    try {
      process.env.CRON_SECRET = SEG;
      const req = (h?: string) => new Request("http://x/api/internal/vendas-sync/coordenador", { headers: h ? { authorization: h } : {} });
      const u = await R.GET(req()); const v = await R.GET(req("Bearer errado")); const v2 = await R.GET(req(SEG));
      const w = await R.GET(req(`Bearer ${SEG}`)); const corpoW = await w.json();
      delete process.env.CRON_SECRET; const sem = await R.GET(req(`Bearer ${SEG}`)); const semVazio = await R.GET(req("Bearer "));
      assert(u.status === 401 && v.status === 401 && v2.status === 401 && sem.status === 401 && semVazio.status === 401, `${u.status} ${v.status} ${v2.status} ${sem.status}`);
      assert(w.status === 200 && corpoW.resultado === "DESABILITADO" && corpoW.lojasAvaliadas === 0, JSON.stringify(corpoW));
      assert(!(saidas.join("\n") + JSON.stringify(corpoW) + JSON.stringify(await u.json())).includes(SEG), "segredo vazou");
    } finally { console.log = log; console.error = err; }
    const fonte = semComentarios(ARQS[1]);
    // SALES-SYNC-D8.2: comparacao via helper (CRON_SECRET OU segredo manual) — guard proprio: testar-vendas-sync-auth-interna
    assert(/if \(!segredo \|\| !auth \|\| auth !== cabecalhoEsperadoSalesSync\(auth, segredo\)\)/.test(fonte) && !/console\.\w+\([^)]*segredo/.test(fonte) && !/export async function POST/.test(fonte), "auth da rota");
    const max = Number(/export const maxDuration = (\d+);/.exec(fonte)![1]); const orc = Number(/const ORCAMENTO_MS = ([\d_]+);/.exec(fonte)![1].replace(/_/g, ""));
    assert(max <= 60 && orc <= 0.8 * max * 1000, `${max} ${orc}`);
  });
  t("3b. middleware deixa so GET chegar a rota (a autorizacao e da rota)", () => {
    assert(MW.decidirAcesso("/api/internal/vendas-sync/coordenador", "GET", false) === "liberar", "GET bloqueado");
    assert(MW.decidirAcesso("/api/internal/vendas-sync/coordenador", "POST", false) !== "liberar", "POST liberado");
  });

  console.log("\n[escopo]");
  t("sem cron, sem flag, sem migration; coordenador/planner/worker/legado/sync-on-read INTOCADOS desde a base", () => {
    const d = execFileSync("git", ["diff", "--name-only", BASE, "--", "lib/vendas/sync/coordenador.ts", "lib/vendas/sync/planejamento.ts", "lib/vendas/sync/tipos.ts",
      "lib/vendas/sync/worker.ts", "lib/vendas/sync/worker-deps.ts", "lib/vendas/sync/worker-contrato.ts", "app/api/internal/vendas-sync/worker", "app/api/sync", "app/api/internal/sync",
      "app/api/ml/vendas", "app/api/shopee/vendas", "lib/vendas/canonico", "lib/mercado-livre/ingestao", "lib/shopee/ingestao", "lib/shopee-auth.ts", "lib/ml-auth.ts",
      /* SALES-SYNC-D10: vercel.json agora agenda os crons canonicos — guard proprio: testar-vendas-sync-cron */ "lib/marketplace", "supabase", ".env.example", "lib/feature-flags.ts", "scripts/sync-worker.mjs"], { cwd: RAIZ, encoding: "utf8" }).trim()
      // SALES-SYNC-D2 muda DE PROPOSITO so a ordem de claim do worker (guard proprio: testar-vendas-sync-worker-fairness)
      // SALES-SYNC-D6: flag server-only na rota do worker e no .env.example (guard proprio: testar-vendas-sync-feature-flag)
      .split(/\r?\n/).filter((f) => f && f !== CAP && f !== "lib/vendas/sync/worker.ts" && f !== ".env.example" && f !== "app/api/internal/vendas-sync/worker/route.ts");
    // SALES-CANONICAL-D13A: SO os arquivos NOVOS do D13 em lib/vendas/canonico (leitores existentes continuam travados)
    const dForaD13 = filtrarExcecaoD15B(RAIZ, BASE, filtrarExcecaoD14(RAIZ, BASE, filtrarExcecaoD13(RAIZ, BASE, d, false))).join(",");
    const novos = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--", "supabase"], { cwd: RAIZ, encoding: "utf8" }).trim();
    assert(dForaD13 === "" && novos === "", `alterados: ${dForaD13} ${novos}`);
    // SALES-SYNC-D1.1: a capability so GANHA a listagem do tick — nenhuma linha existente removida/alterada
    // SALES-CANONICAL-D13A: o bloco D13 (validado por blocoD13Credenciais) sai ANTES desta regra; todo o resto continua sob ela
    const d13 = blocoD13Credenciais(RAIZ);
    assert(d13.valido, `bloco D13 de credenciais.ts invalido: ${d13.motivo}`);
    const tmp = mkdtempSync(join(tmpdir(), "d13a-"));
    writeFileSync(join(tmp, "base.ts"), execFileSync("git", ["show", `${BASE}:${CAP}`], { cwd: RAIZ, encoding: "utf8" }).replace(/\r\n/g, "\n"));
    writeFileSync(join(tmp, "atual.ts"), d13.semBloco);
    let saidaDiff = "";
    try { saidaDiff = execFileSync("git", ["diff", "--no-index", "-U0", join(tmp, "base.ts"), join(tmp, "atual.ts")], { encoding: "utf8" }); } catch (e: any) { saidaDiff = String(e.stdout ?? ""); }
    rmSync(tmp, { recursive: true, force: true });
    const dc = saidaDiff.split(/\r?\n/);
    const removidas = dc.filter((l) => l.startsWith("-") && !l.startsWith("---"));
    const adicionadas = dc.filter((l) => l.startsWith("+") && !l.startsWith("+++") && !/^\+\s*(\*|\/\*\*|\/\/)/.test(l)).join("\n");
    assert(removidas.length === 0, `capability alterada: ${removidas.slice(0, 3).join(" | ")}`);
    assert(adicionadas === "" || ((adicionadas.match(/export (async function|interface|const) \w+/g) ?? []).every((x) => /LinhaLojaParaSyncCanonico|listarLojasAtivasParaSyncCanonico|MotivoCredencialIrrecuperavel|ElegibilidadeSyncCanonico|classificarElegibilidadeSyncCanonico/.test(x))
      && !/\.update\(|\.insert\(|\.upsert\(|\.delete\(|\.rpc\(|fetch\(/.test(adicionadas)), "capability ganhou algo alem da listagem/elegibilidade do tick");
    assert(JSON.stringify(JSON.parse(readFileSync(join(RAIZ, "vercel.json"), "utf8")).crons.filter((c: { path: string }) => /vendas-sync/.test(c.path))) === JSON.stringify([{ path: "/api/internal/vendas-sync/coordenador", schedule: "*/15 * * * *" }, { path: "/api/internal/vendas-sync/worker", schedule: "* * * * *" }]), "crons canonicos diferentes do aprovado (D10)");
  });

  await fila;
  console.log(`\n${falhou === 0 ? "✓" : "✗"} VENDAS-SYNC-COORDENADOR-TICK — ${passou} passaram, ${falhou} falharam`);
  process.exit(falhou === 0 ? 0 : 1);
}
principal().catch((e) => { console.error(e); process.exit(1); });
