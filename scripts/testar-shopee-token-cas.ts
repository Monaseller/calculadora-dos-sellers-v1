/**
 * SALES-SYNC-C3 — refresh de token Shopee concorrente-seguro (offline).
 *
 * Roda o código REAL (renovarShopeeComCas + gravarCredencialShopee +
 * lerCredencialShopeeDoDono) contra um duplo da tabela `lojas` que aplica
 * UPDATE ... WHERE de verdade (atômico por instrução, como o Postgres) e um
 * endpoint Shopee falso que controla a rotação do refresh_token. Corridas
 * com barreiras determinísticas — nada de sleep.
 *
 * Uso: npx tsx scripts/testar-shopee-token-cas.ts
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

const AGORA = Date.parse("2026-10-06T21:00:00Z");
const DONO_A = "dono-a", DONO_B = "dono-b";
const LOJA_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", LOJA_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const VENCIDO = new Date(AGORA - 60_000).toISOString();
const VALIDO = new Date(AGORA + 3 * 3600_000).toISOString();

type Linha = Record<string, any>;
function lojaShopee(id: string, dono: string, o: Linha = {}): Linha {
  return { id, user_id: dono, marketplace: "Shopee", ativo: true, nome: `Loja ${id.slice(0, 4)}`, nickname: "nick", shop_id: "419", partner_id: "p1",
    partner_key: "pk-segredo", access_token: "A0", refresh_token: "R0", token_expires_at: VENCIDO, created_at: "2026-01-01T00:00:00Z", ...o };
}

/** Duplo de `lojas`: select/update com .eq(), maybeSingle e select("id") pós-update. Cada builder executa ATOMICAMENTE. */
function bancoFalso(linhas: Linha[]) {
  const escritas: { id: string; patch: Linha }[] = [];
  const cliente = { from(_t: string) {
    const filtros: [string, unknown][] = []; let patch: Linha | null = null; let unico = false; let devolver = false;
    const casa = (l: Linha) => filtros.every(([c, v]) => String(l[c]) === String(v));
    const q: any = {
      select() { if (patch) devolver = true; return q; },
      update(p: Linha) { patch = p; return q; },
      eq(c: string, v: unknown) { filtros.push([c, v]); return q; },
      order() { return q; }, limit() { return q; },
      maybeSingle() { unico = true; return q; },
      then(ok: any, ko: any) {
        return Promise.resolve().then(() => {
          if (patch) {
            const alvo = linhas.filter(casa);
            for (const l of alvo) { Object.assign(l, patch); escritas.push({ id: l.id, patch: { ...patch } }); }
            return { data: devolver ? alvo.map((l) => ({ id: l.id })) : null, error: null };
          }
          const d = linhas.filter(casa).map((l) => ({ ...l }));
          return unico ? { data: d[0] ?? null, error: null } : { data: d, error: null };
        }).then(ok, ko);
      },
    };
    return q;
  } };
  return { cliente, linhas, escritas };
}

/** Barreira determinística: libera todos quando `n` chegaram. */
function barreira(n: number) {
  let chegou = 0; let soltar!: () => void; const p = new Promise<void>((r) => (soltar = r));
  return async () => { if (++chegou >= n) soltar(); await p; };
}

async function principal() {
  const SA = await import("../lib/shopee-auth");
  const CR = await import("../lib/marketplace/credenciais");

  /** Portas com o código REAL de gravação/leitura sobre o duplo; só o endpoint é falso. */
  const portas = (db: ReturnType<typeof bancoFalso>, renovar: (rt: string) => Promise<any>, o: { antesDoCas?: () => Promise<void>; dono?: string; loja?: string } = {}) => ({
    renovar,
    gravarCas: async (campos: any, anterior: string) => { await o.antesDoCas?.(); return CR.gravarCredencialShopee(o.loja ?? LOJA_A, o.dono ?? DONO_A, campos, anterior, db.cliente); },
    reler: async () => (await CR.lerCredencialShopeeDoDono(o.dono ?? DONO_A, o.loja ?? LOJA_A, db.cliente)).linha,
    esperar: async () => {}, agoraMs: () => AGORA,
  });
  const linha = (db: ReturnType<typeof bancoFalso>, id = LOJA_A) => db.linhas.find((l) => l.id === id)!;
  const silencio = async <T,>(fn: () => Promise<T>) => { const log = console.log, err = console.error; const saida: string[] = [];
    console.log = (...a: unknown[]) => { saida.push(a.join(" ")); }; console.error = (...a: unknown[]) => { saida.push(a.join(" ")); };
    try { return { r: await fn(), saida }; } finally { console.log = log; console.error = err; } };

  console.log("\n[decisao de renovar — semantica preservada]");
  t("A. token VALIDO → nao renova (e o getter so chama o CAS quando precisa)", () => {
    assert(!SA.precisaRenovarShopee({ access_token: "A0", token_expires_at: VALIDO }, AGORA), "valido renovaria");
    assert(SA.precisaRenovarShopee({ access_token: "A0", token_expires_at: VENCIDO }, AGORA), "vencido nao renovaria");
    assert(SA.precisaRenovarShopee({ access_token: "A0", token_expires_at: new Date(AGORA + 4 * 60_000).toISOString() }, AGORA), "margem de 5 min perdida");
    assert(SA.precisaRenovarShopee({ access_token: null, token_expires_at: VALIDO }, AGORA), "sem access nao renovaria");
    assert(!SA.precisaRenovarShopee({ access_token: "A0", token_expires_at: null }, AGORA), "semantica antiga: expira ausente + access = nao renovar");
    const src = readFileSync(join(RAIZ, "lib/shopee-auth.ts"), "utf8");
    // C4: os getters entram pelo lease, que envolve o CAS (renovarShopeeComLease → renovarShopeeComCas).
    // C6: os dois getters sao invólucros do resolvedor detalhado, que entra UMA vez no lease (que envolve o CAS).
    const usos = src.match(/if \(expiredOrMissing && loja\.refresh_token\) \{[\s\S]*?renovarShopeeComLease\(loja\.id, loja\.refresh_token, portasReaisShopee\(loja, userId, inj\), \{ modo \}\)/g) ?? [];
    assert(usos.length === 1, `resolvedor sem o lease+CAS sob a guarda (${usos.length})`);
    assert(/resolverCredencialShopee\(userId, null, "compativel"\)/.test(src) && /resolverCredencialShopee\(userId, lojaId, "compativel"\)/.test(src), "getters fora do resolvedor");
    assert((src.match(/return comoResultado\(await renovarShopeeComCas\(/g) ?? []).length === 2, "o lease nao delega ao CAS do C3");
  });

  console.log("\n[CAS]");
  t("B. vencido → refresh + CAS VENCEDOR: grava o par novo (so campos auth) e devolve o access novo", async () => {
    const db = bancoFalso([lojaShopee(LOJA_A, DONO_A)]); let chamadas = 0;
    const { r, saida } = await silencio(() => SA.renovarShopeeComCas(LOJA_A, "R0", portas(db, async () => { chamadas++; return { access_token: "A1", refresh_token: "R1", expire_in: 14400 }; })));
    const l = linha(db);
    assert(r?.accessToken === "A1" && chamadas === 1 && l.access_token === "A1" && l.refresh_token === "R1" && l.token_expires_at === new Date(AGORA + 14400_000).toISOString(), JSON.stringify({ r, l }));
    assert(db.escritas.length === 1 && saida.some((s) => s.includes("CAS_WON")), saida.join("|"));
    assert(!saida.join(" ").match(/A1|R1|R0|pk-segredo/), "log vazou token/segredo");
  });
  t("C. CAS PERDEDOR: DB ja foi de R0→R1 por outro; meu refresh devolveu R2 → R2 NUNCA gravado, relê e usa R1", async () => {
    const db = bancoFalso([lojaShopee(LOJA_A, DONO_A, { access_token: "A1", refresh_token: "R1", token_expires_at: VALIDO })]);
    const { r, saida } = await silencio(() => SA.renovarShopeeComCas(LOJA_A, "R0", portas(db, async () => ({ access_token: "A2", refresh_token: "R2", expire_in: 14400 }))));
    const l = linha(db);
    assert(r?.accessToken === "A1" && l.refresh_token === "R1" && l.access_token === "A1" && db.escritas.length === 0, JSON.stringify({ r, l, w: db.escritas.length }));
    assert(saida.some((s) => s.includes("CAS_LOST")), saida.join("|"));
  });
  t("D. refresh FALHOU (R0 ja consumido) + outro venceu → relê e usa R1 (nao credencial_indisponivel)", async () => {
    const db = bancoFalso([lojaShopee(LOJA_A, DONO_A, { access_token: "A1", refresh_token: "R1", token_expires_at: VALIDO })]);
    const { r, saida } = await silencio(() => SA.renovarShopeeComCas(LOJA_A, "R0", portas(db, async () => null)));
    assert(r?.accessToken === "A1" && db.escritas.length === 0 && saida.some((s) => s.includes("REFRESH_FAILED_REUSED_WINNER")), JSON.stringify({ r, saida }));
  });
  t("E. refresh FALHOU e ninguem venceu (DB ainda R0) → null (falha real); vencedora VENCIDA tambem nao serve", async () => {
    const db = bancoFalso([lojaShopee(LOJA_A, DONO_A)]);
    const { r } = await silencio(() => SA.renovarShopeeComCas(LOJA_A, "R0", portas(db, async () => null)));
    assert(r === null && db.escritas.length === 0 && linha(db).refresh_token === "R0", JSON.stringify(r));
    const db2 = bancoFalso([lojaShopee(LOJA_A, DONO_A, { access_token: "A1", refresh_token: "R1", token_expires_at: VENCIDO })]);
    const { r: r2 } = await silencio(() => SA.renovarShopeeComCas(LOJA_A, "R0", portas(db2, async () => null)));
    assert(r2 === null, "aceitou vencedora vencida");
    const db3 = bancoFalso([lojaShopee(LOJA_A, DONO_A, { access_token: "A1", refresh_token: "R0", token_expires_at: VALIDO })]);
    const { r: r3 } = await silencio(() => SA.renovarShopeeComCas(LOJA_A, "R0", portas(db3, async () => null)));
    assert(r3 === null, "aceitou linha sem rotacao como vencedora (conservador como o ML)");
  });

  console.log("\n[isolamento e campos]");
  t("F. dono ERRADO → 0 linhas, nada muda (mesmo com refresh_token igual)", async () => {
    const db = bancoFalso([lojaShopee(LOJA_A, DONO_A)]);
    const ok = await CR.gravarCredencialShopee(LOJA_A, DONO_B, { access_token: "X", refresh_token: "Y", token_expires_at: VALIDO }, "R0", db.cliente);
    assert(ok === false && db.escritas.length === 0 && linha(db).access_token === "A0", "dono errado gravou");
  });
  t("G. loja ERRADA → nao grava; o CAS de A nao toca B (mesmo B com o mesmo refresh_token R0)", async () => {
    const db = bancoFalso([lojaShopee(LOJA_A, DONO_A), lojaShopee(LOJA_B, DONO_B)]);
    const errado = await CR.gravarCredencialShopee(LOJA_B, DONO_A, { access_token: "X", refresh_token: "Y", token_expires_at: VALIDO }, "R0", db.cliente);
    assert(errado === false && db.escritas.length === 0, "loja alheia gravada");
    const certo = await CR.gravarCredencialShopee(LOJA_A, DONO_A, { access_token: "A1", refresh_token: "R1", token_expires_at: VALIDO }, "R0", db.cliente);
    assert(certo === true && linha(db, LOJA_B).refresh_token === "R0" && linha(db, LOJA_B).access_token === "A0" && db.escritas.every((w) => w.id === LOJA_A), "CAS cruzou loja");
    const marketplaceErrado = bancoFalso([lojaShopee(LOJA_A, DONO_A, { marketplace: "ML" })]);
    assert(await CR.gravarCredencialShopee(LOJA_A, DONO_A, { access_token: "A1", refresh_token: "R1" }, "R0", marketplaceErrado.cliente) === false, "gravou em loja nao-Shopee");
  });
  t("H. so access_token / refresh_token / token_expires_at mudam, mesmo se o chamador mandar mais", async () => {
    const db = bancoFalso([lojaShopee(LOJA_A, DONO_A)]); const antes = { ...linha(db) };
    const ok = await CR.gravarCredencialShopee(LOJA_A, DONO_A, { access_token: "A1", refresh_token: "R1", token_expires_at: VALIDO, shop_id: "999", partner_key: "x", nickname: "hack", ativo: false, user_id: DONO_B, marketplace: "ML" } as any, "R0", db.cliente);
    const depois = linha(db); const mudou = Object.keys(depois).filter((k) => depois[k] !== antes[k]).sort();
    assert(ok && JSON.stringify(mudou) === JSON.stringify(["access_token", "refresh_token", "token_expires_at"]), mudou.join(","));
    assert(JSON.stringify(Object.keys(db.escritas[0].patch).sort()) === JSON.stringify(["access_token", "refresh_token", "token_expires_at"]), "patch com campo alheio");
    assert(await CR.gravarCredencialShopee(LOJA_A, DONO_A, { access_token: "A2" }, "R1", db.cliente) === false, "gravou par incompleto (sem refresh_token)");
    assert(await CR.gravarCredencialShopee(LOJA_A, DONO_A, { access_token: "A2", refresh_token: "R2" }, "", db.cliente) === false, "gravou sem refreshAnterior (cego)");
  });

  console.log("\n[duas execucoes concorrentes — barreiras deterministicas]");
  async function corrida(modo: "provider_invalida_R0" | "provider_aceita_duas") {
    const db = bancoFalso([lojaShopee(LOJA_A, DONO_A)]);
    const validos = new Set(["R0"]); let emitidos = 0;
    const leram = barreira(2);
    // A grava primeiro; B so tenta o CAS depois que A terminou o dele
    let liberarB!: () => void; const vezDeB = new Promise<void>((r) => (liberarB = r));
    const provider = async (rt: string) => {
      await leram();                                   // ambos leram R0 e chamaram o endpoint
      if (!validos.has(rt)) return null;
      const n = ++emitidos; const novo = `R${n}`;
      if (modo === "provider_invalida_R0") validos.delete(rt);
      validos.add(novo);
      return { access_token: `A${n}`, refresh_token: novo, expire_in: 14400 };
    };
    const pa = portas(db, provider, { antesDoCas: async () => {} });
    const pb = portas(db, provider, { antesDoCas: async () => { await vezDeB; } });
    const execA = SA.renovarShopeeComCas(LOJA_A, "R0", pa).then((r) => { liberarB(); return r; });
    const execB = SA.renovarShopeeComCas(LOJA_A, "R0", pb);
    const { r } = await silencio(() => Promise.all([execA, execB]));
    return { db, ra: r[0], rb: r[1], emitidos };
  }
  t("I1. dois chamadores; provider INVALIDA R0 no 1o uso → 1 CAS, o outro relê; ambos com R1; nada cego", async () => {
    const { db, ra, rb, emitidos } = await corrida("provider_invalida_R0");
    const l = linha(db);
    assert(emitidos === 1 && db.escritas.length === 1 && l.refresh_token === "R1" && ra?.accessToken === "A1" && rb?.accessToken === "A1", JSON.stringify({ ra, rb, l: [l.access_token, l.refresh_token], w: db.escritas.length }));
  });
  t("I2. dois chamadores; provider ACEITA os dois (R1 e R2 emitidos) → so o 1o CAS persiste; R2 nunca gravado; ambos com o persistido", async () => {
    const { db, ra, rb, emitidos } = await corrida("provider_aceita_duas");
    const l = linha(db);
    assert(emitidos === 2 && db.escritas.length === 1 && l.refresh_token === "R1" && l.access_token === "A1", JSON.stringify({ l: [l.access_token, l.refresh_token], w: db.escritas.length }));
    assert(ra?.accessToken === "A1" && rb?.accessToken === "A1", JSON.stringify({ ra, rb }));
    assert(l.refresh_token && l.partner_key === "pk-segredo" && l.shop_id === "419", "loja ficou sem refresh_token ou campo alheio mudou");
  });

  console.log("\n[guardas de codigo]");
  t("J/K. sem gravacao CEGA: a unica gravacao Shopee e o CAS (refresh_token no filtro + select(id) + 1 linha)", () => {
    const cred = readFileSync(join(RAIZ, "lib/marketplace/credenciais.ts"), "utf8");
    const fn = cred.slice(cred.indexOf("export async function gravarCredencialShopee"), cred.indexOf("\n}\n", cred.indexOf("export async function gravarCredencialShopee")));
    assert(/filtrosCasShopee\(lojaId, userId, refreshAnterior\)/.test(fn) && /\.select\("id"\)/.test(fn) && /data\.length === 1/.test(fn) && !/filtrosGravacaoPorLojaEDono/.test(fn), "gravacao sem CAS");
    const filtro = CR.filtrosCasShopee(LOJA_A, DONO_A, "R0");
    assert(JSON.stringify(filtro) === JSON.stringify({ id: LOJA_A, user_id: DONO_A, marketplace: "Shopee", refresh_token: "R0" }), JSON.stringify(filtro));
  });
  t("callers: TODO caminho de refresh Shopee passa pelo CAS (getShopeeLojaById e getShopeeLojaAtiva); nenhuma outra gravacao; sem mutex em memoria", () => {
    const sa = readFileSync(join(RAIZ, "lib/shopee-auth.ts"), "utf8").replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "");
    assert((sa.match(/gravarCredencialShopee\(/g) ?? []).length === 1 && /gravarCas: \(campos, anterior\) => gravarCredencialShopee\(loja\.id, userId, campos, anterior, inj\.cliente\)/.test(sa), "gravacao fora das portas reais");
    assert((sa.match(/refreshShopeeToken\(/g) ?? []).length === 2, "refresh chamado fora do CAS"); // definicao + porta
    assert(!/new Map\(|emVoo|mutex|Mutex|singleton/.test(sa), "mutex/coalescencia em memoria");
    // nenhum outro modulo grava credencial Shopee
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    const quem = execFileSync("git", ["grep", "-l", "gravarCredencialShopee(", "--", "app", "lib"], { cwd: RAIZ, encoding: "utf8" }).trim().split(/\r?\n/).sort();
    assert(JSON.stringify(quem) === JSON.stringify(["lib/marketplace/credenciais.ts", "lib/shopee-auth.ts"]), quem.join(","));
  });

  t("harness SEC-3: os helpers git das suites B1/B2 tem maxBuffer >= 8 MiB (regressao do ENOBUFS)", () => {
    for (const f of ["scripts/testar-sec3-b1-service-role.ts", "scripts/testar-sec3-b2-browser.ts"]) {
      const s = readFileSync(join(RAIZ, f), "utf8");
      const m = s.match(/const GIT_MAX_BUFFER = (\d+) \* 1024 \* 1024;/);
      assert(m && Number(m[1]) >= 8 && /execFileSync\("git", args, \{[^}]*maxBuffer: GIT_MAX_BUFFER \}\)/.test(s), `${f} sem maxBuffer suficiente`);
    }
  });

  await fila;
  console.log(`\n${falhou === 0 ? "✓" : "✗"} SHOPEE-TOKEN-CAS — ${passou} passaram, ${falhou} falharam`);
  process.exit(falhou === 0 ? 0 : 1);
}
principal().catch((e) => { console.error("ERRO FATAL", e); process.exit(1); });
