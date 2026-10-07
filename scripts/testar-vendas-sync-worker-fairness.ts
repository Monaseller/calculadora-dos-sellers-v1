/**
 * SALES-SYNC-D2 — ordem de claim JUSTA entre lojas no worker canonico (offline).
 *
 * Sem rede, sem banco real. Roda o executarWorkerCanonico REAL contra um
 * duplo de banco que aplica ORDER BY multiplo com NULLS FIRST/LAST e limit
 * como o PostgREST; os motores sao dubles que PAUSAM (fatia consumida),
 * CONCLUEM ou cuja auth Shopee e TRANSITORIA (ADIADO). Cada invocacao avanca
 * o relogio em 1 minuto (cadencia do worker).
 *
 * Uso: npx tsx scripts/testar-vendas-sync-worker-fairness.ts
 */
import "./_server-only-inerte";
import { execFileSync } from "node:child_process";
// SALES-CANONICAL-D13B: excecao EXATA — so os arquivos NOVOS do D13 em lib/vendas/canonico (D13_NEW_CANONICAL_FILES, inexistentes na base)
import { filtrarNovosCanonicosD13 } from "./_excecao-d13-vendas-canonicas";
// SALES-CANONICAL-D14B: excecao EXATA do patch D14 nos leitores (ATUAL − patch aprovado = bytes de 1c4fe29)
import { filtrarExcecaoD14 } from "./_excecao-d14-vendas-canonicas";
// SALES-SYNC-D15C2: excecao EXATA do motor intraday ML (worker.ts − hunks D15C = b260583; intraday.ts por sha256)
import { filtrarExcecaoD15C } from "./_excecao-d15c-ml-intraday";
// SALES-SYNC-D15B2: excecao EXATA do patch D15B nos arquivos de sync (ATUAL − patch aprovado = bytes de d631748)
import { filtrarExcecaoD15B } from "./_excecao-d15b-intraday";
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
const BASE = "bee5501";
const AGORA = Date.parse("2026-10-07T12:00:00Z");
const MIN = 60e3;
const iso = (ms: number) => new Date(ms).toISOString();
type Linha = Record<string, any>;

const valor = (l: Linha, c: string) => (c === "checkpoint->>modo" ? l.checkpoint?.modo ?? null : l[c]);

/** Duplo de banco: ORDER BY multiplo com NULLS FIRST/LAST (como o PostgREST), limit, update condicional. */
function bancoFalso(inicial: { lojas: Linha[]; sync_jobs: Linha[] }) {
  const db: Record<string, Linha[]> = { lojas: inicial.lojas, sync_jobs: inicial.sync_jobs };
  const ganchos: { antesDeClaim?: (id: string) => void } = {};
  const cliente: any = { from(tabela: string) {
    const filtros: [string, string, unknown][] = []; let op = "select"; let patch: Linha | null = null; let colunas = "*"; let devolver = false;
    let unico: "single" | "maybe" | null = null; const ordens: { c: string; asc: boolean; nf: boolean }[] = []; let lim = Infinity;
    const casa = (l: Linha) => filtros.every(([o, c, v]) => o === "eq" ? String(valor(l, c)) === String(v) : o === "in" ? (v as unknown[]).map(String).includes(String(valor(l, c)))
      : o === "is" ? (valor(l, c) ?? null) === v : o === "lt" ? valor(l, c) < (v as any) : true);
    const executar = () => {
      const tab = (db[tabela] ??= []);
      if (op === "update") {
        if (tabela === "sync_jobs" && patch!.status === "rodando") { const id = filtros.find(([o, c]) => o === "eq" && c === "id")?.[2]; if (id) ganchos.antesDeClaim?.(String(id)); }
        const alvo = tab.filter(casa); for (const l of alvo) Object.assign(l, structuredClone(patch));
        return { data: devolver ? alvo.map((l) => ({ id: l.id })) : null, error: null };
      }
      let d: Linha[] = tab.filter(casa).map((l) => (colunas.includes("modo:checkpoint->>modo") ? { ...l, modo: l.checkpoint?.modo ?? null } : { ...l }));
      d.sort((a, b) => {
        for (const { c, asc, nf } of ordens) {
          const x = a[c] ?? null, y = b[c] ?? null;
          if (x === y) continue;
          if (x === null) return nf ? -1 : 1;
          if (y === null) return nf ? 1 : -1;
          const r = String(x) < String(y) ? -1 : 1;
          return asc ? r : -r;
        }
        return 0;
      });
      d = d.slice(0, lim);
      if (unico === "single") return d.length === 1 ? { data: structuredClone(d[0]), error: null } : { data: null, error: { message: "nao_unico" } };
      if (unico === "maybe") return { data: d[0] ? structuredClone(d[0]) : null, error: null };
      return { data: structuredClone(d), error: null };
    };
    const q: any = {
      select(c = "*") { if (op === "update") devolver = true; else colunas = c; return q; },
      update(p: Linha) { op = "update"; patch = p; return q; },
      eq(c: string, v: unknown) { filtros.push(["eq", c, v]); return q; },
      in(c: string, v: unknown[]) { filtros.push(["in", c, v]); return q; },
      is(c: string, v: unknown) { filtros.push(["is", c, v]); return q; },
      lt(c: string, v: unknown) { filtros.push(["lt", c, v]); return q; },
      // PostgREST: ascending default true; nullsFirst default = !ascending (NULLS LAST em ASC)
      order(c: string, o: { ascending?: boolean; nullsFirst?: boolean } = {}) { const asc = o.ascending !== false; ordens.push({ c, asc, nf: o.nullsFirst ?? !asc }); return q; },
      limit(n: number) { lim = n; return q; },
      single() { unico = "single"; return q; },
      maybeSingle() { unico = "maybe"; return q; },
      then(ok: any, ko: any) { return Promise.resolve().then(executar).then(ok, ko); },
    };
    return q;
  } };
  return { cliente, db, ganchos };
}

async function principal() {
  const W = await import("../lib/vendas/sync/worker");
  const JM = await import("../lib/mercado-livre/ingestao/janelas");
  const P = await import("../lib/vendas/sync/planejamento");
  let seq = 0;
  const loja = (id: string, marketplace: "ML" | "Shopee") => ({ id, user_id: `dono-${id}`, marketplace, ativo: true });
  /** Job canonico pendente. ML = date_closed (janela coerente); Shopee = create_time. */
  const job = (lojaId: string, marketplace: "ML" | "Shopee", o: Linha = {}): Linha => {
    const l = JM.limitesDaJanela("2026-10-01", "2026-10-05")!;
    return { id: `j${String(++seq).padStart(3, "0")}`, user_id: `dono-${lojaId}`, loja_id: lojaId, marketplace, tipo: "backfill", date_from: "2026-10-01", date_to: "2026-10-05",
      status: "pendente", campo_tempo: marketplace === "ML" ? "date_closed" : "create_time", janela_inicio: l.inicio.toISOString(), janela_fim: l.fim.toISOString(),
      listagem_completa: false, checkpoint: null, progresso: null, tentativas: 0, max_tentativas: 3, erro_mensagem: null,
      criado_em: iso(AGORA - 600 * MIN + seq), iniciado_em: null, heartbeat_em: null, concluido_em: null, ...o };
  };

  /**
   * Simula N invocacoes do worker (1/min). `fatias[jobId]` = quantas fatias ate concluir
   * (padrao: infinito = backfill grande que sempre pausa). `transitorio` = lojas cuja auth Shopee e transitoria.
   */
  async function simular(b: ReturnType<typeof bancoFalso>, n: number, o: { fatias?: Record<string, number>; transitorio?: Set<string>; inicioMs?: number } = {}) {
    let agora = o.inicioMs ?? AGORA; const servidos: string[] = []; const resultados: string[] = []; const contagem: Record<string, number> = {};
    const motor = async (entrada: { id: string; lojaId: string }) => {
      contagem[entrada.id] = (contagem[entrada.id] ?? 0) + 1;
      if (contagem[entrada.id] >= (o.fatias?.[entrada.id] ?? Infinity)) {
        const l = b.db.sync_jobs.find((x) => x.id === entrada.id)!; Object.assign(l, { status: "concluido", listagem_completa: true, concluido_em: iso(agora + 40e3) });
        return { estado: "concluido" };
      }
      return { estado: "pausado" };   // fatia inteira consumida (orcamento)
    };
    for (let i = 0; i < n; i++) {
      const relogio = { agoraMs: () => agora };
      const r = await W.executarWorkerCanonico({
        cliente: b.cliente, relogio,
        portasML: async () => ({ transporte: {} as any, repo: {} as any }),
        portasShopee: async (j) => (o.transitorio?.has(j.lojaId) ? { transitorio: "refresh_em_andamento" as const } : { api: {} as any, repo: {} as any }),
        motores: { ml: motor as any, shopee: motor as any, catchup: motor as any },
      }, { orcamentoMs: 45_000, habilitado: true });
      resultados.push(r.resultado);
      if (r.loja_id) servidos.push(r.loja_id);
      agora += MIN;
    }
    return { servidos, resultados };
  }
  const maxSeguidos = (s: string[]) => s.reduce((m, x, i) => { let k = 1; while (i + k < s.length && s[i + k] === x) k++; return Math.max(m, k); }, 0);

  console.log("\n[rotacao]");
  t("20. 2 lojas nunca servidas: A → B → A → B (pausa manda para o fim)", async () => {
    const b = bancoFalso({ lojas: [loja("A", "ML"), loja("B", "Shopee")], sync_jobs: [job("A", "ML"), job("B", "Shopee")] });
    const { servidos } = await simular(b, 4);
    assert(servidos.join(",") === "A,B,A,B", servidos.join(","));
  });
  t("21. 6 lojas: as 6 primeiras fatias sao 6 lojas distintas; a 7a volta a primeira; nunca 2 seguidas", async () => {
    const ids = ["A", "B", "C", "D", "E", "F"];
    const b = bancoFalso({ lojas: ids.map((x, i) => loja(x, i % 2 ? "Shopee" : "ML")), sync_jobs: ids.map((x, i) => job(x, i % 2 ? "Shopee" : "ML")) });
    const { servidos } = await simular(b, 18);
    assert(new Set(servidos.slice(0, 6)).size === 6 && servidos.slice(6, 12).join() === servidos.slice(0, 6).join() && maxSeguidos(servidos) === 1, servidos.join(","));
    for (const x of ids) assert(servidos.filter((y) => y === x).length === 3, `distribuicao desigual: ${servidos.join(",")}`);
  });
  t("11. REGRESSAO: A criado ha muito e servido agora ha pouco; B criado depois, nunca servido → B", async () => {
    const a = job("A", "Shopee", { criado_em: iso(AGORA - 5 * 24 * 60 * MIN), iniciado_em: iso(AGORA - 2 * MIN), heartbeat_em: iso(AGORA - 1 * MIN) });
    const bj = job("B", "ML", { criado_em: iso(AGORA - 10 * MIN) });
    const b = bancoFalso({ lojas: [loja("A", "Shopee"), loja("B", "ML")], sync_jobs: [a, bj] });
    const { servidos } = await simular(b, 1);
    assert(servidos[0] === "B", servidos.join(","));
  });
  t("10. nunca servido vence recem-pausado; entre servidos, o ha MAIS tempo sem fatia vence", async () => {
    const b = bancoFalso({ lojas: [loja("A", "ML"), loja("B", "ML"), loja("C", "ML")], sync_jobs: [
      job("A", "ML", { iniciado_em: iso(AGORA - 3 * MIN) }), job("B", "ML", { iniciado_em: iso(AGORA - 30 * MIN) }), job("C", "ML")] });
    const { servidos } = await simular(b, 3);
    assert(servidos.join(",") === "C,B,A", servidos.join(","));
  });
  t("23. novo job durante backfill longo: A sozinha por 10 fatias; B, C entram → servidas nas 2 proximas (NEW_STORE_MAX_WAIT = lojas nunca servidas a frente)", async () => {
    const b = bancoFalso({ lojas: [loja("A", "Shopee"), loja("B", "ML"), loja("C", "Shopee")], sync_jobs: [job("A", "Shopee", { criado_em: iso(AGORA - 3 * 24 * 60 * MIN) })] });
    const s1 = await simular(b, 10);
    assert(s1.servidos.every((x) => x === "A"), "sozinha deveria ser servida (sem concorrencia)");
    b.db.sync_jobs.push(job("B", "ML", { criado_em: iso(AGORA + 10 * MIN) }), job("C", "Shopee", { criado_em: iso(AGORA + 10 * MIN + 1) }));
    const s2 = await simular(b, 6, { inicioMs: AGORA + 11 * MIN });
    assert(s2.servidos.join(",") === "B,C,A,B,C,A", s2.servidos.join(","));
  });
  t("22. loja concluida sai da rotacao; B/C continuam alternando", async () => {
    const ja = job("A", "ML"), jb = job("B", "Shopee"), jc = job("C", "ML");
    const b = bancoFalso({ lojas: [loja("A", "ML"), loja("B", "Shopee"), loja("C", "ML")], sync_jobs: [ja, jb, jc] });
    const { servidos } = await simular(b, 7, { fatias: { [ja.id]: 1 } });
    assert(servidos.join(",") === "A,B,C,B,C,B,C" && ja.status === "concluido", servidos.join(","));
  });
  t("12. auth transitoria (ADIADO) → volta a pendente no FIM da rotacao; tentativas/erro intocados", async () => {
    const ja = job("A", "Shopee"), jb = job("B", "ML");
    const b = bancoFalso({ lojas: [loja("A", "Shopee"), loja("B", "ML")], sync_jobs: [ja, jb] });
    const { servidos, resultados } = await simular(b, 4, { transitorio: new Set(["A"]) });
    assert(servidos.join(",") === "A,B,A,B" && resultados[0] === "ADIADO" && resultados[1] === "EXECUTADO", `${servidos} ${resultados}`);
    assert(ja.status === "pendente" && ja.tentativas === 0 && ja.erro_mensagem === null && ja.iniciado_em !== null, JSON.stringify(ja));
  });
  t("13. pausa por orcamento grava atendimento (iniciado_em = claim) e vai para tras", async () => {
    const ja = job("A", "ML"), jb = job("B", "ML");
    const b = bancoFalso({ lojas: [loja("A", "ML"), loja("B", "ML")], sync_jobs: [ja, jb] });
    await simular(b, 1);
    assert(ja.status === "pendente" && ja.iniciado_em === iso(AGORA) && jb.iniciado_em === null, JSON.stringify(ja));
    assert(W.compararClaimJusto(jb, ja) < 0, "nunca servido nao ficou a frente do recem-pausado");
  });

  console.log("\n[prioridade x justica]");
  t("24. prioridade decide QUAL job a loja tem (coordenador); a justica decide QUAL loja recebe a fatia: ninguem monopoliza", async () => {
    // efeito da prioridade: dentro da loja, a necessidade de prioridade menor (pedido do usuario) vira o job
    const nec = (chave: string, prioridade: number, tipo: "discovery" | "refresh") => ({ tipo, prioridade, job: { chave, marketplace: "ML" as const, lojaId: "A", campoTempo: "date_closed" as const,
      inicio: "2026-10-01T03:00:00.000Z", fim: "2026-10-02T03:00:00.000Z", de: "2026-10-01", ate: "2026-10-01", proposito: "descoberta" as const } });
    const acao = P.escolherProximaAcao({ necessidades: [nec("backfill", 6, "discovery"), nec("usuario", 1, "discovery"), nec("fresco", 4, "refresh")], jobAtivoDaLoja: null, esperaAte: null, esgotado: [] });
    assert(acao.acao === "CREATE_DISCOVERY_JOB" && acao.job.chave === "usuario", JSON.stringify(acao));
    // ...e mesmo esse job (de A, date_closed) nao monopoliza o worker contra o backfill create_time de B
    const b = bancoFalso({ lojas: [loja("A", "ML"), loja("B", "Shopee")], sync_jobs: [job("B", "Shopee", { iniciado_em: iso(AGORA - 50 * MIN) }), job("A", "ML", { iniciado_em: iso(AGORA - 40 * MIN) })] });
    const { servidos } = await simular(b, 6);
    assert(servidos.join(",") === "B,A,B,A,B,A", servidos.join(","));
    // o worker NAO ordena por atributo da necessidade (tipo/campo/proposito/datas) — so pela justica
    assert(W.ORDEM_CLAIM_JUSTA[0].coluna === "iniciado_em" && W.ORDEM_CLAIM_JUSTA[0].nullsFirst === true && W.ORDEM_CLAIM_JUSTA.every((o) => ["iniciado_em", "criado_em", "id"].includes(o.coluna)), "ordem");
  });

  console.log("\n[determinismo / concorrencia / estado]");
  t("25. empate total → criado_em, depois id; mesma fixture = mesma sequencia", async () => {
    const mesmo = { criado_em: iso(AGORA - 60 * MIN), iniciado_em: null };
    const fx = () => [job("C", "ML", { ...mesmo, id: "j-c" }), job("A", "ML", { ...mesmo, id: "j-a" }), job("B", "ML", { ...mesmo, id: "j-b" })];
    const lojasF = [loja("A", "ML"), loja("B", "ML"), loja("C", "ML")];
    const s1 = await simular(bancoFalso({ lojas: lojasF, sync_jobs: fx() }), 6);
    const s2 = await simular(bancoFalso({ lojas: lojasF, sync_jobs: fx().reverse() }), 6);
    assert(s1.servidos.join(",") === "A,B,C,A,B,C" && s2.servidos.join(",") === s1.servidos.join(","), `${s1.servidos} | ${s2.servidos}`);
    const emb = [{ id: "z", criado_em: "2026-01-01T00:00:00.000Z", iniciado_em: null }, { id: "a", criado_em: "2026-01-01T00:00:00.000Z", iniciado_em: null }, { id: "m", criado_em: "2025-12-31T00:00:00.000Z", iniciado_em: null }];
    assert([...emb].sort(W.compararClaimJusto).map((x) => x.id).join("") === "maz" && [...emb].reverse().sort(W.compararClaimJusto).map((x) => x.id).join("") === "maz", "comparador instavel");
  });
  t("16. claim concorrente: 2 workers juntos → jobs DIFERENTES, cada um servido 1x; 1 job so → 1 ganha", async () => {
    const b = bancoFalso({ lojas: [loja("A", "ML"), loja("B", "ML")], sync_jobs: [job("A", "ML"), job("B", "ML")] });
    let chamadas: string[] = [];
    const deps = () => ({ cliente: b.cliente, relogio: { agoraMs: () => AGORA }, portasML: async () => ({ transporte: {} as any, repo: {} as any }), portasShopee: async () => null,
      motores: { ml: (async (e: any) => { chamadas.push(e.lojaId); return { estado: "pausado" }; }) as any, shopee: null as any, catchup: null as any } });
    const [r1, r2] = await Promise.all([W.executarWorkerCanonico(deps(), { orcamentoMs: 45_000, habilitado: true }), W.executarWorkerCanonico(deps(), { orcamentoMs: 45_000, habilitado: true })]);
    assert(chamadas.sort().join(",") === "A,B" && r1.loja_id !== r2.loja_id, `${chamadas} ${r1.resultado} ${r2.resultado}`);
    const b2 = bancoFalso({ lojas: [loja("A", "ML")], sync_jobs: [job("A", "ML")] }); chamadas = [];
    const deps2 = () => ({ ...deps(), cliente: b2.cliente });
    const rs = await Promise.all([W.executarWorkerCanonico(deps2(), { orcamentoMs: 45_000, habilitado: true }), W.executarWorkerCanonico(deps2(), { orcamentoMs: 45_000, habilitado: true })]);
    assert(chamadas.length === 1 && rs.filter((r) => r.resultado === "EXECUTADO").length === 1 && rs.some((r) => r.resultado === "CLAIM_PERDIDO"), `${chamadas} ${rs.map((r) => r.resultado)}`);
  });
  t("16b. visao velha: o 1o candidato foi servido (e pausado) entre a leitura e o claim → claim falha pela condicao de iniciado_em e o worker pega o PROXIMO", async () => {
    const ja = job("A", "ML"), jb = job("B", "ML");
    const b = bancoFalso({ lojas: [loja("A", "ML"), loja("B", "ML")], sync_jobs: [ja, jb] });
    let uma = true;
    b.ganchos.antesDeClaim = (id) => { if (uma && id === ja.id) { uma = false; Object.assign(ja, { iniciado_em: iso(AGORA - 5e3), heartbeat_em: iso(AGORA - 1e3), status: "pendente" }); } };
    const { servidos } = await simular(b, 1);
    assert(servidos[0] === "B" && ja.status === "pendente", servidos.join(","));
  });
  t("14/15. job em erro (cooldown/FAILED) e job rodando nunca sao candidatos; legado intocado", async () => {
    const erro = job("A", "ML", { status: "erro", iniciado_em: iso(AGORA - 900 * MIN), concluido_em: iso(AGORA - 1 * MIN), erro_mensagem: "x" });
    const rodando = job("B", "ML", { status: "rodando", iniciado_em: iso(AGORA - 2 * MIN), heartbeat_em: iso(AGORA - 1 * MIN) });
    const legado: Linha = { ...job("C", "ML"), campo_tempo: null, janela_inicio: null, janela_fim: null };
    const b = bancoFalso({ lojas: [loja("A", "ML"), loja("B", "ML"), loja("C", "ML")], sync_jobs: [erro, rodando, legado] });
    const { resultados } = await simular(b, 1);
    assert(resultados[0] === "NO_JOB" && erro.status === "erro" && erro.tentativas === 0 && rodando.status === "rodando" && legado.status === "pendente" && legado.iniciado_em === null, `${resultados} ${JSON.stringify(erro)}`);
  });
  t("26. recuperacao de preso INALTERADA: preso volta pendente (tentativas+1, iniciado_em antigo preservado) e entra na rotacao pela idade da ultima fatia", async () => {
    const preso = job("A", "ML", { status: "rodando", iniciado_em: iso(AGORA - 30 * MIN), heartbeat_em: iso(AGORA - 20 * MIN) });
    const recente = job("B", "ML", { iniciado_em: iso(AGORA - 2 * MIN) });
    const b = bancoFalso({ lojas: [loja("A", "ML"), loja("B", "ML")], sync_jobs: [preso, recente] });
    const { servidos } = await simular(b, 2);
    assert(servidos.join(",") === "A,B" && preso.tentativas === 1, `${servidos} ${JSON.stringify(preso)}`);
    const fonte = (rev: string | null) => { const s = rev ? execFileSync("git", ["show", `${rev}:lib/vendas/sync/worker.ts`], { cwd: RAIZ, encoding: "utf8" }) : readFileSync(join(RAIZ, "lib/vendas/sync/worker.ts"), "utf8");
      const n = s.replace(/\r/g, ""); const i = n.indexOf("export async function recuperarJobsPresos"); return i < 0 ? "" : n.slice(i, n.indexOf("\n}\n", i)); };
    assert(fonte(null) !== "" && fonte(null) === fonte(BASE) && /export const LEASE_MS = 10 \* 60 \* 1000;/.test(readFileSync(join(RAIZ, "lib/vendas/sync/worker.ts"), "utf8")), "recuperacao/limiar mudou");
  });

  console.log("\n[guardas]");
  const semComentarios = (f: string) => readFileSync(join(RAIZ, f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  t("17. justica vem do banco: worker sem estado de processo (let/Map/Set de modulo, indice round-robin)", () => {
    const s = semComentarios("lib/vendas/sync/worker.ts");
    assert(!/^(let|var) /m.test(s) && !/new (Map|Set|WeakMap)\(/.test(s) && !/roundRobin|indiceRotacao|ultimaLoja/i.test(s), "estado em memoria");
    assert(/ordenarJusto\(cliente\.from\("sync_jobs"\)/.test(s) && (s.match(/ordenarJusto\(/g) ?? []).length === 2, "candidatos sem a ordem justa");
    assert(!/order\("criado_em"/.test(s), "ainda ordena so por criado_em em algum ponto");
    assert(/q\.is\("iniciado_em", null\) : q\.eq\("iniciado_em", c\.iniciadoEm\)/.test(s), "claim sem condicao de iniciado_em");
  });
  t("18/19. claim legado, coordenador, planner, tick, motores, canonicos, migrations, vercel.json e env INTOCADOS desde a base", () => {
    const d = execFileSync("git", ["diff", "--name-only", BASE, "--", "supabase", "lib/vendas/sync/coordenador.ts", "lib/vendas/sync/coordenador-tick.ts", "lib/vendas/sync/planejamento.ts",
      "lib/vendas/sync/tipos.ts", "lib/vendas/sync/worker-contrato.ts", "lib/vendas/sync/worker-deps.ts", "app/api", "lib/vendas/canonico", "lib/mercado-livre", "lib/shopee", "lib/shopee-auth.ts",
      "lib/marketplace", /* SALES-SYNC-D10: vercel.json agora agenda os crons canonicos — guard proprio: testar-vendas-sync-cron */ "scripts/sync-worker.mjs", ".env.example", "lib/feature-flags.ts", "lib/middleware-rotas.ts"], { cwd: RAIZ, encoding: "utf8" }).trim()
      // SALES-SYNC-D4 muda DE PROPOSITO a elegibilidade (capability + tick) — guard proprio: testar-vendas-sync-elegibilidade
      // SALES-SYNC-D6: flag server-only nas duas rotas e no .env.example (guard proprio: testar-vendas-sync-feature-flag)
      .split(/\r?\n/).filter((f) => f && f !== "lib/marketplace/credenciais.ts" && f !== "lib/vendas/sync/coordenador-tick.ts" && f !== ".env.example"
        && f !== "app/api/internal/vendas-sync/coordenador/route.ts" && f !== "app/api/internal/vendas-sync/worker/route.ts");
    // SALES-CANONICAL-D13B: so os arquivos NOVOS do D13 em lib/vendas/canonico; ml.ts/shopee.ts/tipos.ts seguem travados
    const fora = filtrarExcecaoD15C(RAIZ, BASE, filtrarExcecaoD15B(RAIZ, BASE, filtrarExcecaoD14(RAIZ, BASE, filtrarNovosCanonicosD13(RAIZ, BASE, d)))).join(",");
    const novos = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--", "supabase"], { cwd: RAIZ, encoding: "utf8" }).trim();
    assert(fora === "" && novos === "", `alterados: ${fora} ${novos}`);
  });

  await fila;
  console.log(`\n${falhou === 0 ? "✓" : "✗"} VENDAS-SYNC-WORKER-FAIRNESS — ${passou} passaram, ${falhou} falharam`);
  process.exit(falhou === 0 ? 0 : 1);
}
principal().catch((e) => { console.error(e); process.exit(1); });
