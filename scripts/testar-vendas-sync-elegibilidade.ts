/**
 * SALES-SYNC-D4 — elegibilidade de loja para o sync canonico (credencial irrecuperavel) — offline.
 *
 * Sem rede, sem banco real. A capability classifica pela credencial GUARDADA
 * (espelho das regras de getMLLojaById/varrerDias e resolverCredencialShopee);
 * o tick ignora a loja irrecuperavel ANTES de planejar. `fetch` global e uma
 * armadilha e toda chamada .rpc() e contada.
 *
 * Uso: npx tsx scripts/testar-vendas-sync-elegibilidade.ts
 */
import "./_server-only-inerte";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// SALES-CANONICAL-D13B: excecao EXATA — so os arquivos NOVOS do D13 em lib/vendas/canonico (D13_NEW_CANONICAL_FILES, inexistentes na base)
import { filtrarNovosCanonicosD13 } from "./_excecao-d13-vendas-canonicas";
// SALES-CANONICAL-D14B: excecao EXATA do patch D14 nos leitores (ATUAL − patch aprovado = bytes de 1c4fe29)
import { filtrarExcecaoD14 } from "./_excecao-d14-vendas-canonicas";
// SALES-SYNC-D15C2: excecao EXATA do motor intraday ML (worker.ts − hunks D15C = b260583; intraday.ts por sha256)
import { filtrarExcecaoD15C } from "./_excecao-d15c-ml-intraday";
// SALES-SYNC-D15D2: excecao EXATA do motor intraday Shopee (worker.ts − hunks D15D = e90557e; intraday.ts por sha256)
import { filtrarExcecaoD15D } from "./_excecao-d15d-shopee-intraday";
// SALES-SYNC-D15B2: excecao EXATA do patch D15B nos arquivos de sync (ATUAL − patch aprovado = bytes de d631748)
import { filtrarExcecaoD15B } from "./_excecao-d15b-intraday";
// SALES-CANONICAL-D16B: excecao EXATA do cutover dos 4 cards do Dashboard (dashboard − hunks D16 = 1d6e573; novos por sha256)
import { filtrarExcecaoD16 } from "./_excecao-d16-dashboard-canonico";
// SHOPEE MULTI-APP: excecao EXATA do OAuth multi-app (rotas/Configuracoes/.env.example − hunks = eca183a; novos por sha256)
import { filtrarExcecaoShopeeMultiApp } from "./_excecao-shopee-multi-app";

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
const AGORA = Date.parse("2026-10-07T12:00:00Z");
const MIN = 60e3, H = 3600e3, DIA = 24 * H;
const iso = (ms: number) => new Date(ms).toISOString();
const SEG = "tok-D4-NAO-PODE-VAZAR-91fa";
const L = ["aaaaaaaa-0000-4000-8000-000000000001", "aaaaaaaa-0000-4000-8000-000000000002", "aaaaaaaa-0000-4000-8000-000000000003",
  "aaaaaaaa-0000-4000-8000-000000000004", "aaaaaaaa-0000-4000-8000-000000000005", "aaaaaaaa-0000-4000-8000-000000000006"];

let chamadasFetch = 0;
(globalThis as any).fetch = async () => { chamadasFetch++; throw new Error("rede proibida"); };

type Linha = Record<string, any>;
function bancoFalso(lojas: Linha[], jobs: Linha[] = []) {
  let seq = 0, rpcs = 0; const regs: { tabela: string; op: string; colunas: string; filtros: [string, string, unknown][] }[] = [];
  const db: Record<string, Linha[]> = { lojas, sync_jobs: jobs, shopee_pedidos: [] };
  const cliente: any = {
    rpc: async () => { rpcs++; return { data: null, error: { code: "PROIBIDO" } }; },
    from(tabela: string) {
      const r = { tabela, op: "select", colunas: "", filtros: [] as [string, string, unknown][] }; regs.push(r);
      let head = false, inserir: Linha | null = null, ordem: string | null = null, faixa: [number, number] | null = null;
      const casa = (l: Linha) => r.filtros.every(([op, c, v]: any) => op === "eq" ? String(l[c]) === String(v) : op === "in" ? v.map(String).includes(String(l[c]))
        : op === "is" ? (l[c] ?? null) === v : op === "notnull" ? (l[c] ?? null) !== null : op === "gte" ? l[c] >= v : op === "lt" ? l[c] < v : true);
      const q: any = new Proxy({}, { get(_a, p: string) {
        if (p === "then") return (ok: any) => {
          if (inserir) {
            const ativo = db.sync_jobs.some((j) => j.loja_id === inserir!.loja_id && ["pendente", "rodando"].includes(j.status));
            if (ativo) return ok({ data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "idx_sync_jobs_loja_ativo"' } });
            const novo = { id: `novo${++seq}`, criado_em: iso(AGORA), concluido_em: null, campo_tempo: null, janela_inicio: null, janela_fim: null, checkpoint: null, ...inserir };
            db.sync_jobs.push(novo); return ok({ data: { id: novo.id }, error: null });
          }
          let d: Linha[] = (db[tabela] ?? []).filter(casa).map((l) => (tabela === "sync_jobs" ? { ...l, modo: l.checkpoint?.modo ?? null } : { ...l }));
          if (ordem) d = [...d].sort((x, y) => String(x[ordem!]).localeCompare(String(y[ordem!])));
          if (faixa) d = d.slice(faixa[0], faixa[1] + 1);
          return ok(head ? { data: null, count: d.length, error: null } : { data: d, error: null });
        };
        if (p === "select") return (c: string, o?: any) => { r.colunas = c; if (o?.head) head = true; return q; };
        if (p === "insert") return (linha: Linha) => { r.op = "insert"; inserir = { ...linha }; return q; };
        if (p === "single") return () => q;
        if (p === "order") return (c: string) => { ordem = c; return q; };
        if (p === "range") return (a: number, z: number) => { faixa = [a, z]; return q; };
        if (p === "not") return (c: string, o: string, v: unknown) => { if (o === "is" && v === null) r.filtros.push(["notnull", c, null]); return q; };
        return (...a: any[]) => { if (["eq", "in", "is", "gte", "lt"].includes(p)) r.filtros.push([p, a[0], a[1]]); return q; };
      } });
      return q;
    },
  };
  return { cliente, db, regs, rpcs: () => rpcs };
}

/** Lojas com credencial guardada (valores falsos; so presenca/validade importam). */
const ml = (id: string, dono: string, o: Linha = {}) => ({ id, user_id: dono, marketplace: "ML", ativo: true, seller_id: "s1", access_token: SEG, refresh_token: SEG,
  token_expires_at: iso(AGORA + 5 * H), partner_id: null, partner_key: null, ...o });
const sp = (id: string, dono: string, o: Linha = {}) => ({ id, user_id: dono, marketplace: "Shopee", ativo: true, seller_id: null, shop_id: 1, partner_id: 123, partner_key: SEG,
  access_token: SEG, refresh_token: SEG, token_expires_at: iso(AGORA + 3 * H), ...o });
const VENCIDO = iso(AGORA - 3 * H), MESES = iso(AGORA - 100 * DIA);

async function principal() {
  const CR = await import("../lib/marketplace/credenciais");
  const T = await import("../lib/vendas/sync/coordenador-tick");
  const SA = await import("../lib/shopee-auth");
  const JM = await import("../lib/mercado-livre/ingestao/janelas");
  const classe = (l: Linha, agora = AGORA) => CR.classificarElegibilidadeSyncCanonico(l as any, agora);
  const rodar = (b: ReturnType<typeof bancoFalso>, logs?: Linha[]) =>
    T.executarTickCoordenador(() => ({ cliente: b.cliente, relogio: { agoraMs: () => AGORA }, log: (e) => logs?.push(e) }), { orcamentoMs: 45_000, habilitado: true });
  const novos = (b: ReturnType<typeof bancoFalso>) => b.db.sync_jobs.filter((j) => String(j.id).startsWith("novo"));
  const de = (r: Awaited<ReturnType<typeof rodar>>, id: string) => r.resultados.find((x) => x.lojaId === id)!;

  console.log("\n[A-C. classificacao = regras reais dos resolvers]");
  t("A. credencial valida → ELEGIVEL (ML e Shopee)", () => {
    assert(classe(ml(L[0], "d")).estado === "ELEGIVEL" && classe(sp(L[1], "d")).estado === "ELEGIVEL", "valida");
  });
  t("B. access EXPIRADO + refresh_token → ELEGIVEL (o resolver renova: ML renovarComCas, Shopee lease→CAS)", () => {
    assert(classe(ml(L[0], "d", { token_expires_at: VENCIDO })).estado === "ELEGIVEL", "ML vencido + refresh");
    assert(classe(sp(L[1], "d", { token_expires_at: VENCIDO })).estado === "ELEGIVEL", "Shopee vencido + refresh");
    assert(classe(sp(L[1], "d", { access_token: null, token_expires_at: null })).estado === "ELEGIVEL", "Shopee sem access + refresh (resolver renova)");
  });
  t("C. expirado SEM refresh → INRECUPERAVEL expirado_sem_refresh; e os outros becos reais dos resolvers", () => {
    const c = (l: Linha) => { const e = classe(l); return e.estado === "ELEGIVEL" ? "ELEGIVEL" : e.motivo; };
    assert(c(ml(L[0], "d", { token_expires_at: MESES, refresh_token: null })) === "expirado_sem_refresh", "ML caso D3");
    assert(c(sp(L[1], "d", { token_expires_at: VENCIDO, refresh_token: null })) === "expirado_sem_refresh", "Shopee vencido sem refresh");
    assert(c(ml(L[0], "d", { access_token: null })) === "sem_access_token", "ML sem access: getMLLojaById devolve null MESMO com refresh");
    assert(c(ml(L[0], "d", { seller_id: null })) === "sem_seller_id", "ML sem seller: varrerDias → credencial_ausente");
    assert(c(sp(L[1], "d", { partner_key: null })) === "sem_partner" && c(sp(L[1], "d", { partner_id: null })) === "sem_partner", "Shopee sem partner");
    assert(c(sp(L[1], "d", { access_token: null, refresh_token: null })) === "sem_access_token", "Shopee sem access e sem refresh");
  });
  t("VALID_ACCESS_WITHOUT_REFRESH: access valido sem refresh → ELEGIVEL ate (expira − 5 min); expiracao NULL → ELEGIVEL (os resolvers USAM o token)", () => {
    for (const f of [ml, sp]) {
      assert(classe(f(L[0], "d", { refresh_token: null, token_expires_at: iso(AGORA + 6 * MIN) })).estado === "ELEGIVEL", "6 min antes");
      assert(classe(f(L[0], "d", { refresh_token: null, token_expires_at: iso(AGORA + 4 * MIN) })).estado !== "ELEGIVEL", "dentro da margem de 5 min");
      assert(classe(f(L[0], "d", { refresh_token: null, token_expires_at: null })).estado === "ELEGIVEL", "expiracao desconhecida");
    }
  });
  t("C2. Shopee: o 'expirado' da classificacao E o precisaRenovarShopee real (matriz de horarios)", () => {
    for (const dt of [-DIA, -H, -6 * MIN, -5 * MIN, -4 * MIN, 0, 4 * MIN, 5 * MIN + 1, 6 * MIN, H]) {
      const l = sp(L[1], "d", { refresh_token: null, token_expires_at: iso(AGORA + dt) });
      const real = SA.precisaRenovarShopee(l as any, AGORA);
      assert((classe(l).estado !== "ELEGIVEL") === real, `dt=${dt}: classificacao diverge do resolver real`);
    }
  });
  t("C3. ancoras: as linhas dos resolvers que a classificacao espelha continuam as mesmas (mudou o resolver → reauditar)", () => {
    const sem = (f: string) => readFileSync(join(RAIZ, f), "utf8").replace(/\r/g, "");
    const mla = sem("lib/ml-auth.ts"), mlv = sem("lib/mercado-livre-vendas.ts"), spa = sem("lib/shopee-auth.ts");
    assert(mla.includes("if (!loja || !loja.access_token) return null;") && mla.includes("new Date(loja.token_expires_at).getTime() - 5 * 60 * 1000 < Date.now()")
      && mla.includes("if (expired && loja.refresh_token) {"), "getMLLojaById mudou");
    assert(mlv.includes("if (credencial === null || !credencial.accessToken || !credencial.sellerId) {"), "varrerDias mudou");
    assert(spa.includes("if (!loja.partner_id || !loja.partner_key) {") && spa.includes("if (expiredOrMissing && loja.refresh_token) {")
      && spa.includes("if (!accessToken) {") && spa.includes("const MARGEM_SHOPEE_MS = 5 * 60 * 1000;"), "resolverCredencialShopee mudou");
  });

  console.log("\n[D-K. tick]");
  // equivalente ao D3 real: 5 ML + 1 Shopee; 2 ML vencidas COM refresh, 2 ML vencidas ha meses SEM refresh
  const cenarioD3 = () => [
    ml(L[0], "dono-1"),                                                       // valida
    ml(L[1], "dono-2", { token_expires_at: VENCIDO }),                        // vencida + refresh
    ml(L[2], "dono-3", { token_expires_at: MESES, refresh_token: null }),     // irrecuperavel
    sp(L[3], "dono-1"),                                                       // Shopee valida
    ml(L[4], "dono-4", { token_expires_at: VENCIDO }),                        // vencida + refresh
    ml(L[5], "dono-5", { token_expires_at: MESES, refresh_token: null }),     // irrecuperavel
  ];
  t("E. 6 ativas / 4 elegiveis / 2 ignoradas → no maximo 4 jobs (nao 6)", async () => {
    const b = bancoFalso(cenarioD3());
    const r = await rodar(b);
    assert(r.lojasAvaliadas === 6 && r.lojasElegiveis === 4 && r.lojasIgnoradasCredencial === 2 && r.jobsCriados === 4 && novos(b).length === 4, JSON.stringify({ ...r, resultados: undefined }));
    assert(de(r, L[2]).acao === "SKIP_CREDENTIAL_UNUSABLE" && de(r, L[5]).acao === "SKIP_CREDENTIAL_UNUSABLE" && de(r, L[2]).motivo === "expirado_sem_refresh", JSON.stringify(de(r, L[2])));
    assert([L[0], L[1], L[3], L[4]].every((id) => de(r, id).acao === "JOB_CREATED" && de(r, id).elegibilidade === "ELEGIVEL"), "elegivel nao criou");
  });
  t("F. loja ignorada: 0 job, 0 planejamento (nenhuma leitura de shopee_pedidos/avaliacao, nenhum insert)", async () => {
    const b = bancoFalso([sp(L[3], "dono-1", { token_expires_at: VENCIDO, refresh_token: null })]);
    const r = await rodar(b);
    assert(r.jobsCriados === 0 && novos(b).length === 0 && de(r, L[3]).acao === "SKIP_CREDENTIAL_UNUSABLE", JSON.stringify(r));
    assert(!b.regs.some((x) => x.tabela === "shopee_pedidos" || x.op === "insert") && b.regs.filter((x) => x.tabela === "lojas").length === 1, b.regs.map((x) => `${x.tabela}:${x.op}`).join(","));
  });
  t("G. ignorada NAO e falha: falhas 0, esgotadas 0, aguardando 0, resultado OK — mesmo se TODAS forem ignoradas", async () => {
    const b = bancoFalso([ml(L[2], "dono-3", { token_expires_at: MESES, refresh_token: null }), ml(L[5], "dono-5", { access_token: null })]);
    const r = await rodar(b);
    assert(r.resultado === "OK" && r.falhas === 0 && r.esgotadas === 0 && r.aguardando === 0 && r.noop === 0 && r.lojasIgnoradasCredencial === 2 && r.lojasElegiveis === 0, JSON.stringify(r));
  });
  t("D. reparada (novo refresh_token gravado pela reconexao) → no PROXIMO tick entra sozinha e cria job; sem codigo, sem `ativo`, sem flag", async () => {
    const b = bancoFalso([ml(L[2], "dono-3", { token_expires_at: MESES, refresh_token: null })]);
    const r1 = await rodar(b);
    assert(de(r1, L[2]).acao === "SKIP_CREDENTIAL_UNUSABLE" && novos(b).length === 0, "tick 1");
    Object.assign(b.db.lojas[0], { access_token: "novo-access", refresh_token: "novo-refresh", token_expires_at: iso(AGORA + 6 * H) });
    const r2 = await rodar(b);
    assert(de(r2, L[2]).acao === "JOB_CREATED" && novos(b).length === 1 && b.db.lojas[0].ativo === true, JSON.stringify(de(r2, L[2])));
  });
  t("H. multi-dono: elegibilidade e dono vem da MESMA linha; job criado so com o dono da loja elegivel", async () => {
    const b = bancoFalso([ml(L[0], "dono-A", { token_expires_at: MESES, refresh_token: null }), ml(L[1], "dono-B")]);
    const r = await rodar(b);
    assert(de(r, L[0]).acao === "SKIP_CREDENTIAL_UNUSABLE" && de(r, L[1]).acao === "JOB_CREATED", JSON.stringify(r.resultados));
    assert(novos(b).length === 1 && novos(b)[0].loja_id === L[1] && novos(b)[0].user_id === "dono-B", JSON.stringify(novos(b)));
    const lista = await CR.listarLojasAtivasParaSyncCanonico(b.cliente, AGORA);
    assert(lista.linhas.find((l) => l.id === L[0])!.user_id === "dono-A" && lista.linhas.find((l) => l.id === L[0])!.elegibilidade.estado !== "ELEGIVEL", "classificacao trocada entre linhas");
  });
  t("I. nada de segredo: capability devolve SO {id,user_id,marketplace,elegibilidade}; relatorio e logs sem token/partner_key", async () => {
    const b = bancoFalso(cenarioD3()); const logs: Linha[] = [];
    const lista = await CR.listarLojasAtivasParaSyncCanonico(b.cliente, AGORA);
    assert(lista.linhas.length === 6 && lista.linhas.every((l) => Object.keys(l).sort().join() === "elegibilidade,id,marketplace,user_id"), JSON.stringify(lista.linhas[0]));
    assert(lista.linhas.every((l) => Object.keys(l.elegibilidade).every((k) => k === "estado" || k === "motivo")), "elegibilidade com campo extra");
    const r = await rodar(b, logs);
    const tudo = JSON.stringify(lista) + JSON.stringify(r) + JSON.stringify(logs);
    assert(!tudo.includes(SEG) && !/access_token|refresh_token|partner_key/.test(tudo), "vazou credencial");
    // o dono so sai da capability (o tick precisa dele); relatorio e logs nao o expoem
    assert(!/dono-/.test(JSON.stringify(r) + JSON.stringify(logs)), "relatorio/log expoe dono");
    const ev = logs.map((e) => e.evento);
    assert(ev.filter((e) => e === "STORE_SYNC_SKIPPED_CREDENTIAL").length === 2 && ev.filter((e) => e === "STORE_SYNC_ELIGIBLE").length === 4, ev.join(","));
  });
  t("J. zero auth/provider: nenhum fetch, nenhuma rpc; tick so importa a listagem e o TIPO da capability", async () => {
    const b = bancoFalso(cenarioD3());
    await rodar(b);
    assert(chamadasFetch === 0 && b.rpcs() === 0, `fetch ${chamadasFetch} rpc ${b.rpcs()}`);
    const tick = readFileSync(join(RAIZ, "lib/vendas/sync/coordenador-tick.ts"), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    assert(!/getMLLojaById|getShopeeLoja|resolverCredencialShopee|refreshMLToken|refreshShopeeToken|renovar|shopee-auth|ml-auth|\bfetch\(|\.rpc\(|["'`]lojas["'`]/.test(tick), "tick toca auth/lojas");
  });
  t("K. job ATIVO + credencial ficou irrecuperavel → SKIP, job reportado e INTOCADO, nenhum job novo", async () => {
    const l = JM.limitesDaJanela("2026-10-05", "2026-10-05")!;
    const ativo = { id: "job-vivo", user_id: "dono-3", loja_id: L[2], marketplace: "ML", status: "pendente", campo_tempo: "date_closed", janela_inicio: l.inicio.toISOString(),
      janela_fim: l.fim.toISOString(), listagem_completa: false, concluido_em: null, criado_em: iso(AGORA - H), checkpoint: null, iniciado_em: iso(AGORA - 30 * MIN) };
    const antes = JSON.stringify(ativo);
    const b = bancoFalso([ml(L[2], "dono-3", { token_expires_at: MESES, refresh_token: null })], [ativo]);
    const r = await rodar(b);
    assert(de(r, L[2]).acao === "SKIP_CREDENTIAL_UNUSABLE" && de(r, L[2]).jobAtivoId === "job-vivo" && novos(b).length === 0 && JSON.stringify(ativo) === antes, JSON.stringify(de(r, L[2])));
  });
  t("19. historico de falhas velho (>24h) + irrecuperavel → NAO volta a criar job", async () => {
    const l = JM.limitesDaJanela("2026-10-01", "2026-10-01")!;
    const erro = (h: number) => ({ id: `e${h}`, user_id: "dono-3", loja_id: L[2], marketplace: "ML", status: "erro", campo_tempo: "date_closed", janela_inicio: l.inicio.toISOString(),
      janela_fim: l.fim.toISOString(), listagem_completa: false, concluido_em: iso(AGORA - h * H), criado_em: iso(AGORA - h * H), checkpoint: null });
    const b = bancoFalso([ml(L[2], "dono-3", { token_expires_at: MESES, refresh_token: null })], [erro(30), erro(29), erro(28)]);
    const r = await rodar(b);
    assert(de(r, L[2]).acao === "SKIP_CREDENTIAL_UNUSABLE" && novos(b).length === 0 && r.falhas === 0, JSON.stringify(r));
  });
  t("15/F. sem loja/marketplace fixo: nenhuma UUID nem nome de loja na classificacao/tick; Shopee nao e 'sempre elegivel'", () => {
    const cap = readFileSync(join(RAIZ, "lib/marketplace/credenciais.ts"), "utf8");
    const bloco = cap.slice(cap.indexOf("export type MotivoCredencialIrrecuperavel"), cap.indexOf("export interface LinhaLojaParaJob"));
    const tick = readFileSync(join(RAIZ, "lib/vendas/sync/coordenador-tick.ts"), "utf8");
    assert(bloco.length > 100 && !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|MONAMOR|51956661|fc5228dc|3598561e|81b3ca39/i.test(bloco + tick), "loja fixa");
    assert(classe(sp(L[3], "d", { partner_key: null })).estado !== "ELEGIVEL" && classe(ml(L[0], "d", { seller_id: null })).estado !== "ELEGIVEL", "marketplace fixo como elegivel");
  });
  t("26/27. auth, worker e fairness INTOCADOS desde a base (D4 so classifica)", () => {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    const d = execFileSync("git", ["diff", "--name-only", "2d2beb4", "--", "lib/shopee-auth.ts", "lib/ml-auth.ts", "lib/mercado-livre-vendas.ts", "lib/vendas/sync/worker.ts",
      "lib/vendas/sync/worker-deps.ts", "lib/vendas/sync/coordenador.ts", "lib/vendas/sync/planejamento.ts", "lib/vendas/canonico", "lib/mercado-livre/ingestao", "lib/shopee/ingestao",
      /* SALES-SYNC-D10: vercel.json agora agenda os crons canonicos — guard proprio: testar-vendas-sync-cron */ "supabase", "app", "lib/feature-flags.ts"], { cwd: RAIZ, encoding: "utf8" }).trim()
      // SALES-SYNC-D6: as duas rotas passam a ler a flag server-only (guard proprio: testar-vendas-sync-feature-flag)
      .split(/\r?\n/).filter((f) => f && f !== "app/api/internal/vendas-sync/coordenador/route.ts" && f !== "app/api/internal/vendas-sync/worker/route.ts");
    // SALES-CANONICAL-D13B: so os arquivos NOVOS do D13 em lib/vendas/canonico; ml.ts/shopee.ts/tipos.ts seguem travados
    const fora = filtrarExcecaoShopeeMultiApp(RAIZ, "2d2beb4", filtrarExcecaoD16(RAIZ, "2d2beb4", filtrarExcecaoD15D(RAIZ, "2d2beb4", filtrarExcecaoD15C(RAIZ, "2d2beb4", filtrarExcecaoD15B(RAIZ, "2d2beb4", filtrarExcecaoD14(RAIZ, "2d2beb4", filtrarNovosCanonicosD13(RAIZ, "2d2beb4", d))))))).join(",");
    assert(fora === "", `alterados: ${fora}`);
  });

  await fila;
  console.log(`\n${falhou === 0 ? "✓" : "✗"} VENDAS-SYNC-ELEGIBILIDADE — ${passou} passaram, ${falhou} falharam`);
  process.exit(falhou === 0 ? 0 : 1);
}
principal().catch((e) => { console.error(e); process.exit(1); });
