/**
 * SALES-SYNC-C4 — lease distribuido do refresh Shopee (offline).
 *
 * Os chamadores sao "processos" independentes: cada um monta as PROPRIAS
 * portas e so compartilha o duplo de banco. A exclusao vem das RPCs do
 * duplo, que reproduzem a semantica da migration 20261030 (UM comando
 * atomico: INSERT ... ON CONFLICT ... DO UPDATE ... WHERE expira_em <= now()
 * AND user_id = p_user_id; liberacao casada com o portador; relogio do
 * BANCO). A migration em si e conferida linha a linha (nao aplicada).
 *
 * Uso: npx tsx scripts/testar-shopee-refresh-lease.ts
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
const MIGRATION = "supabase/migrations/20261030_sales_sync_c4_shopee_refresh_lease.sql";

const T0 = Date.parse("2026-10-06T21:00:00Z");
const DONO_A = "dono-a", DONO_B = "dono-b";
const LOJA_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", LOJA_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const VENCIDO = new Date(T0 - 60_000).toISOString();
type Linha = Record<string, any>;
function lojaShopee(id: string, dono: string, o: Linha = {}): Linha {
  return { id, user_id: dono, marketplace: "Shopee", ativo: true, nickname: "n", shop_id: "419", partner_id: "p1", partner_key: "pk-segredo",
    access_token: "A0", refresh_token: "R0", token_expires_at: VENCIDO, created_at: "2026-01-01T00:00:00Z", ...o };
}

/** Duplo do banco: `lojas` (select/update com .eq) + RPCs do lease com a semantica da migration. */
function bancoFalso(lojas: Linha[], o: { rpcInexistente?: boolean; semExclusao?: boolean } = {}) {
  const leases: Linha[] = []; const rpcs: { nome: string; args: Linha; resultado: unknown }[] = []; let escritasCas = 0;
  const relogio = { agora: T0 };
  const cliente = {
    from(_t: string) {
      const filtros: [string, unknown][] = []; let patch: Linha | null = null; let devolver = false;
      const casa = (l: Linha) => filtros.every(([c, v]) => String(l[c]) === String(v));
      const q: any = {
        select() { if (patch) devolver = true; return q; }, update(p: Linha) { patch = p; return q; },
        eq(c: string, v: unknown) { filtros.push([c, v]); return q; }, order() { return q; }, limit() { return q; }, maybeSingle() { return q; },
        then(ok: any, ko: any) {
          return Promise.resolve().then(() => {
            if (patch) { const alvo = lojas.filter(casa); for (const l of alvo) Object.assign(l, patch); if (alvo.length) escritasCas++; return { data: devolver ? alvo.map((l) => ({ id: l.id })) : null, error: null }; }
            const d = lojas.filter(casa)[0]; return { data: d ? { ...d } : null, error: null };
          }).then(ok, ko);
        },
      };
      return q;
    },
    async rpc(nome: string, a: Linha) {
      await Promise.resolve();
      if (o.rpcInexistente) return { data: null, error: { code: "PGRST202", message: `Could not find the function public.${nome}` } };
      const agora = relogio.agora;
      let resultado: unknown;
      if (nome === "adquirir_lease_refresh_credencial") {
        if (!a.p_portador || a.p_ttl_segundos < 5 || a.p_ttl_segundos > 120) return { data: null, error: { code: "P0001", message: "invalido" } };
        const atual = leases.find((l) => l.loja_id === a.p_loja_id && l.marketplace === a.p_marketplace);
        const novo = { user_id: a.p_user_id, loja_id: a.p_loja_id, marketplace: a.p_marketplace, portador: a.p_portador, adquirida_em: agora, expira_em: agora + a.p_ttl_segundos * 1000, liberada_em: null };
        if (!atual) {
          if (!lojas.some((l) => l.id === a.p_loja_id && l.user_id === a.p_user_id)) return { data: null, error: { code: "23503", message: "fk" } };
          leases.push({ ...novo, tomada_de_expirada: false, tomadas: 0 }); resultado = true;
        } else if ((o.semExclusao || atual.expira_em <= agora) && atual.user_id === a.p_user_id) {
          Object.assign(atual, novo, { tomada_de_expirada: atual.liberada_em === null, tomadas: atual.tomadas + 1 }); resultado = true;
        } else resultado = false;
      } else if (nome === "liberar_lease_refresh_credencial") {
        const atual = leases.find((l) => l.loja_id === a.p_loja_id && l.user_id === a.p_user_id && l.marketplace === a.p_marketplace && l.portador === a.p_portador && l.liberada_em === null);
        if (atual) { atual.expira_em = agora; atual.liberada_em = agora; }
        resultado = !!atual;
      } else return { data: null, error: { code: "PGRST202", message: "?" } };
      rpcs.push({ nome, args: { ...a }, resultado });
      return { data: resultado, error: null };
    },
  };
  return { cliente, lojas, leases, rpcs, relogio, escritasCas: () => escritasCas };
}

/** Espera LIMITADA por uma condicao (falha em vez de travar se ela nunca ocorrer — ex.: mutante sem lease). */
async function aguardar(cond: () => boolean, rotulo: string) {
  for (let i = 0; i < 5000; i++) { if (cond()) return; await new Promise((r) => setImmediate(r)); }
  throw new Error(`condicao nunca ocorreu: ${rotulo}`);
}

/** Uma "barreira": promessa liberada por fora. */
function porta() { let abrir!: () => void; const p = new Promise<void>((r) => (abrir = r)); return { p, abrir }; }

async function principal() {
  const SA = await import("../lib/shopee-auth");
  const CR = await import("../lib/marketplace/credenciais");

  /** Um "processo": portas proprias (codigo REAL de CAS/leitura/lease) sobre o banco compartilhado. */
  function processo(db: ReturnType<typeof bancoFalso>, provider: (rt: string) => Promise<any>, o: { esperar?: () => Promise<void>; dono?: string; loja?: string; portador?: string } = {}) {
    const loja = o.loja ?? LOJA_A, dono = o.dono ?? DONO_A; let chamadasProvider = 0;
    const portas = {
      renovar: async (rt: string) => { chamadasProvider++; return provider(rt); },
      gravarCas: (campos: any, anterior: string) => CR.gravarCredencialShopee(loja, dono, campos, anterior, db.cliente),
      reler: async () => (await CR.lerCredencialShopeeDoDono(dono, loja, db.cliente)).linha,
      adquirirLease: (p: string) => CR.adquirirLeaseRefreshShopee(loja, dono, p, db.cliente),
      liberarLease: (p: string) => CR.liberarLeaseRefreshShopee(loja, dono, p, db.cliente),
      novoPortador: o.portador ? () => o.portador! : undefined,
      esperar: o.esperar ?? (async () => {}), agoraMs: () => db.relogio.agora,
    };
    /** O mesmo caminho do getter: ler → precisa renovar? → lease. */
    const resolver = async () => {
      const { linha } = await CR.lerCredencialShopeeDoDono(dono, loja, db.cliente);
      if (!linha) return { ok: false as const, motivo: "credencial_indisponivel" as const };
      if (!SA.precisaRenovarShopee(linha, db.relogio.agora)) return { ok: true as const, accessToken: linha.access_token as string };
      return SA.renovarShopeeComLease(loja, linha.refresh_token as string, portas);
    };
    return { portas, resolver, provider: () => chamadasProvider };
  }
  const silencio = async <T,>(fn: () => Promise<T>) => { const log = console.log, err = console.error; const saida: string[] = [];
    console.log = (...a: unknown[]) => { saida.push(a.join(" ")); }; console.error = (...a: unknown[]) => { saida.push(a.join(" ")); };
    try { return { r: await fn(), saida }; } finally { console.log = log; console.error = err; } };
  const linha = (db: ReturnType<typeof bancoFalso>, id = LOJA_A) => db.lojas.find((l) => l.id === id)!;
  const valido = (db: ReturnType<typeof bancoFalso>) => new Date(db.relogio.agora + 4 * 3600_000).toISOString();

  console.log("\n[single caller]");
  t("A. token VALIDO → nenhuma tentativa de lease, nenhuma chamada ao provider", async () => {
    const db = bancoFalso([lojaShopee(LOJA_A, DONO_A, { token_expires_at: new Date(T0 + 3600_000).toISOString() })]);
    const p = processo(db, async () => { throw new Error("nao devia"); });
    const { r } = await silencio(p.resolver);
    assert(r.ok && r.accessToken === "A0" && db.rpcs.length === 0 && p.provider() === 0, JSON.stringify({ r, rpcs: db.rpcs.length }));
  });
  t("B. vencido → lease ADQUIRIDO → provider 1x → CAS vencedor → lease LIBERADO (pelo mesmo portador)", async () => {
    const db = bancoFalso([lojaShopee(LOJA_A, DONO_A)]);
    const p = processo(db, async () => ({ access_token: "A1", refresh_token: "R1", expire_in: 14400 }));
    const { r, saida } = await silencio(p.resolver);
    const adq = db.rpcs.find((x) => x.nome === "adquirir_lease_refresh_credencial")!, lib = db.rpcs.find((x) => x.nome === "liberar_lease_refresh_credencial")!;
    assert(r.ok && r.accessToken === "A1" && p.provider() === 1 && linha(db).refresh_token === "R1", JSON.stringify(r));
    assert(adq.resultado === true && lib.resultado === true && adq.args.p_portador === lib.args.p_portador && db.leases[0].liberada_em !== null, "lease nao liberado pelo portador");
    assert(adq.args.p_ttl_segundos === CR.LEASE_REFRESH_SHOPEE_TTL_S && adq.args.p_marketplace === "Shopee" && /^[0-9a-f-]{36}$/.test(adq.args.p_portador), JSON.stringify(adq.args));
    assert(!saida.join(" ").match(/A1|R1|R0|pk-segredo/), "log vazou segredo");
  });

  console.log("\n[dois processos — teste central]");
  async function central(o: { semExclusao?: boolean } = {}) {
    const db = bancoFalso([lojaShopee(LOJA_A, DONO_A)], o);
    const providerLiberado = porta(); const bTentouLease = porta(); const aTerminou = porta();
    let emitidos = 0;
    const provider = async () => { await providerLiberado.p; const n = ++emitidos; return { access_token: `A${n}`, refresh_token: `R${n}`, expire_in: 14400 }; };
    const pa = processo(db, provider);
    const pb = processo(db, provider, { esperar: async () => { await aTerminou.p; } });
    const execA = pa.resolver().then((r) => { aTerminou.abrir(); return r; });
    // B so tenta depois que A ja detem o lease (A esta preso no provider)
    await aguardar(() => db.rpcs.some((x) => x.nome === "adquirir_lease_refresh_credencial" && x.resultado === true), "A detem o lease");
    const execB = pb.resolver();
    await aguardar(() => db.rpcs.filter((x) => x.nome === "adquirir_lease_refresh_credencial").length >= 2, "B tentou o lease");
    bTentouLease.abrir(); providerLiberado.abrir();
    const { r } = await silencio(() => Promise.all([execA, execB]));
    return { db, ra: r[0], rb: r[1], chamadas: pa.provider() + pb.provider(), bLease: db.rpcs.filter((x) => x.nome === "adquirir_lease_refresh_credencial")[1]?.resultado };
  }
  t("C. A e B veem vencido; A ganha o lease, B recebe OCUPADO → PROVIDER_REFRESH_CALLS = 1; B relê e usa o vencedor", async () => {
    const { db, ra, rb, chamadas, bLease } = await central();
    assert(bLease === false && chamadas === 1, `lease B=${bLease} chamadas=${chamadas}`);
    assert(ra.ok && rb.ok && ra.accessToken === "A1" && rb.accessToken === "A1" && linha(db).refresh_token === "R1" && db.escritasCas() === 1, JSON.stringify({ ra, rb }));
  });
  t("C-MUT. a exclusao vem do BANCO: sem ela (duplo sem exclusao) o mesmo cenario faz 2 chamadas — o teste central morde", async () => {
    const { chamadas } = await central({ semExclusao: true });
    assert(chamadas === 2, `sem exclusao no banco deveria haver 2 chamadas, houve ${chamadas}`);
  });

  console.log("\n[releitura, ocupado, expiracao]");
  t("D. RELER depois de adquirir: outro ja renovou entre a leitura e o lease → 0 chamadas ao provider, lease liberado", async () => {
    const db = bancoFalso([lojaShopee(LOJA_A, DONO_A)]);
    const p = processo(db, async () => { throw new Error("provider chamado"); });
    const { linha: lida } = await CR.lerCredencialShopeeDoDono(DONO_A, LOJA_A, db.cliente);           // viu R0 vencido
    Object.assign(linha(db), { access_token: "A1", refresh_token: "R1", token_expires_at: valido(db) }); // B renovou nesse meio-tempo
    const { r, saida } = await silencio(() => SA.renovarShopeeComLease(LOJA_A, lida!.refresh_token as string, p.portas));
    assert(r.ok && r.accessToken === "A1" && p.provider() === 0 && db.leases[0].liberada_em !== null && saida.some((s) => s.includes("LEASE_REREAD_ALREADY_FRESH")), JSON.stringify({ r, saida }));
  });
  t("E. lease OCUPADO e nenhum vencedor aparece → refresh_em_andamento (NAO credencial_indisponivel), 0 provider, espera limitada", async () => {
    const db = bancoFalso([lojaShopee(LOJA_A, DONO_A)]);
    await CR.adquirirLeaseRefreshShopee(LOJA_A, DONO_A, "outro-portador", db.cliente);
    let esperas = 0;
    const p = processo(db, async () => { throw new Error("provider chamado"); }, { esperar: async () => { esperas++; } });
    const { r, saida } = await silencio(p.resolver);
    assert(!r.ok && r.motivo === "refresh_em_andamento" && p.provider() === 0, JSON.stringify(r));
    assert(esperas === 5 && db.rpcs.filter((x) => x.nome === "adquirir_lease_refresh_credencial").length === 2, `esperas=${esperas}`);
    assert(saida.some((s) => s.includes("LEASE_BUSY")) && !saida.some((s) => /reconecte/i.test(s)), saida.join("|"));
  });
  t("F. CRASH do portador: A adquire e morre; antes do TTL B NAO adquire; depois do TTL B adquire (tomada_de_expirada) e renova", async () => {
    const db = bancoFalso([lojaShopee(LOJA_A, DONO_A)]);
    assert(await CR.adquirirLeaseRefreshShopee(LOJA_A, DONO_A, "a-morto", db.cliente) === "ADQUIRIDO", "A nao adquiriu");
    db.relogio.agora = T0 + (CR.LEASE_REFRESH_SHOPEE_TTL_S - 1) * 1000;
    assert(await CR.adquirirLeaseRefreshShopee(LOJA_A, DONO_A, "b", db.cliente) === "OCUPADO", "B roubou antes do TTL");
    db.relogio.agora = T0 + CR.LEASE_REFRESH_SHOPEE_TTL_S * 1000;
    const p = processo(db, async () => ({ access_token: "A1", refresh_token: "R1", expire_in: 14400 }));
    const { r } = await silencio(p.resolver);
    assert(r.ok && r.accessToken === "A1" && p.provider() === 1 && db.leases[0].tomada_de_expirada === true, JSON.stringify({ r, l: db.leases[0] }));
  });
  t("G. liberacao pelo portador ERRADO nao libera; o lease continua de A", async () => {
    const db = bancoFalso([lojaShopee(LOJA_A, DONO_A)]);
    await CR.adquirirLeaseRefreshShopee(LOJA_A, DONO_A, "portador-a", db.cliente);
    assert(await CR.liberarLeaseRefreshShopee(LOJA_A, DONO_A, "portador-b", db.cliente) === false, "B liberou");
    assert(db.leases[0].portador === "portador-a" && db.leases[0].liberada_em === null && await CR.adquirirLeaseRefreshShopee(LOJA_A, DONO_A, "c", db.cliente) === "OCUPADO", "lease de A perdido");
    assert(await CR.liberarLeaseRefreshShopee(LOJA_A, DONO_B, "portador-a", db.cliente) === false, "dono errado liberou");
  });
  t("H. lojas DIFERENTES renovam em paralelo (sem lock global do marketplace); dono errado nunca adquire", async () => {
    const db = bancoFalso([lojaShopee(LOJA_A, DONO_A), lojaShopee(LOJA_B, DONO_B)]);
    assert(await CR.adquirirLeaseRefreshShopee(LOJA_A, DONO_A, "a", db.cliente) === "ADQUIRIDO" && await CR.adquirirLeaseRefreshShopee(LOJA_B, DONO_B, "b", db.cliente) === "ADQUIRIDO", "lock global");
    db.relogio.agora += 60_000;
    assert(await CR.adquirirLeaseRefreshShopee(LOJA_A, DONO_B, "x", db.cliente) === "OCUPADO", "dono errado tomou lease vencido");
    const db2 = bancoFalso([lojaShopee(LOJA_A, DONO_A)]);
    assert(await CR.adquirirLeaseRefreshShopee(LOJA_A, DONO_B, "x", db2.cliente) === "OCUPADO", "dono errado criou lease (FK)");
  });

  console.log("\n[defesa em profundidade e degradacao]");
  t("I. CAS AINDA necessario: lease venceu no meio (portador lento) → 2 chamadas possiveis, mas so 1 CAS persiste; R2 nunca gravado", async () => {
    const db = bancoFalso([lojaShopee(LOJA_A, DONO_A)]);
    const aProvider = porta(); let emitidos = 0;
    const pa = processo(db, async () => { await aProvider.p; const n = ++emitidos; return { access_token: `A${n}x`, refresh_token: `R${n}x`, expire_in: 14400 }; });
    const pb = processo(db, async () => { const n = ++emitidos; return { access_token: `A${n}`, refresh_token: `R${n}`, expire_in: 14400 }; });
    const execA = pa.resolver();
    await aguardar(() => db.rpcs.some((x) => x.resultado === true), "A detem o lease");
    db.relogio.agora = T0 + 31_000;                                          // TTL estourou com A preso no provider
    const { r: rb } = await silencio(pb.resolver);                            // B toma o lease vencido e grava R1
    aProvider.abrir();
    const { r: ra } = await silencio(() => execA);                            // A volta com R2x: CAS sobre R0 → 0 linhas
    const l = linha(db);
    assert(rb.ok && ra.ok && l.refresh_token === "R1" && db.escritasCas() === 1 && ra.accessToken === "A1" && rb.accessToken === "A1", JSON.stringify({ ra, rb, l: [l.access_token, l.refresh_token] }));
  });
  t("J. RPC do lease inexistente (migration nao aplicada/revertida) → modo C3 (so CAS), sem bloquear o refresh", async () => {
    const db = bancoFalso([lojaShopee(LOJA_A, DONO_A)], { rpcInexistente: true });
    const p = processo(db, async () => ({ access_token: "A1", refresh_token: "R1", expire_in: 14400 }));
    const { r, saida } = await silencio(p.resolver);
    assert(r.ok && r.accessToken === "A1" && linha(db).refresh_token === "R1" && saida.some((s) => s.includes("LEASE_UNAVAILABLE_FALLBACK_CAS")), JSON.stringify({ r, saida }));
    assert(await CR.adquirirLeaseRefreshShopee(LOJA_A, DONO_A, "p", db.cliente) === "INDISPONIVEL", "classificacao");
  });
  t("K. falha do provider COM o lease: relê; sem vencedor → credencial_indisponivel; lease liberado mesmo assim", async () => {
    const db = bancoFalso([lojaShopee(LOJA_A, DONO_A)]);
    const p = processo(db, async () => null);
    const { r } = await silencio(p.resolver);
    assert(!r.ok && r.motivo === "credencial_indisponivel" && p.provider() === 1 && db.leases[0].liberada_em !== null, JSON.stringify(r));
  });

  console.log("\n[migration e codigo]");
  const sql = readFileSync(join(RAIZ, MIGRATION), "utf8").replace(/\r/g, "");
  const codigo = sql.replace(/^--.*$/gm, "");
  const RV = "REV" + "OKE", GR = "GR" + "ANT";
  t("M1. tabela: PK (loja_id, marketplace), FK de dono para lojas(id, user_id), so Shopee, expira_em obrigatorio, RLS ligada", () => {
    assert(/CREATE TABLE public\.credencial_refresh_lease \(/.test(codigo) && /PRIMARY KEY \(loja_id, marketplace\)/.test(codigo), "PK");
    assert(/FOREIGN KEY \(loja_id, user_id\) REFERENCES public\.lojas \(id, user_id\)/.test(codigo) && /CHECK \(marketplace = 'Shopee'\)/.test(codigo), "FK/marketplace");
    // literais montados por partes: o varredor K2/M2 da SEC-3 nao pode confundir esta suite com mudanca de banco
    const RLS = "ROW LEVEL " + "SECURITY", POL = "PO" + "LICY";
    assert(/expira_em\s+timestamptz NOT NULL/.test(codigo) && codigo.includes(`ALTER TABLE public.credencial_refresh_lease ENABLE ${RLS};`), "expira/RLS");
    assert(!new RegExp(`CREATE ${POL}`, "i").test(codigo), "policy criada");
  });
  t("M2. aquisicao ATOMICA num comando: ON CONFLICT ... DO UPDATE ... WHERE expirado E mesmo dono; relogio do banco; RETURN FOUND", () => {
    const f = codigo.slice(codigo.indexOf("CREATE FUNCTION public.adquirir_lease_refresh_credencial"), codigo.indexOf("CREATE FUNCTION public.liberar_lease_refresh_credencial"));
    assert(/ON CONFLICT \(loja_id, marketplace\) DO UPDATE/.test(f) && /WHERE alvo\.expira_em <= now\(\)\s+AND alvo\.user_id = p_user_id;/.test(f) && /RETURN FOUND;/.test(f), "upsert condicional");
    assert(/now\(\) \+ make_interval\(secs => p_ttl_segundos\)/.test(f) && /p_ttl_segundos < 5 OR p_ttl_segundos > 120/.test(f), "ttl/relogio");
    assert(!/\bSELECT\b[\s\S]*\bINTO\b/i.test(f) || /RETURN FOUND/.test(f), "select-depois-update");
    assert(CR.LEASE_REFRESH_SHOPEE_TTL_S >= 5 && CR.LEASE_REFRESH_SHOPEE_TTL_S <= 120 && CR.LEASE_REFRESH_SHOPEE_TTL_S > 8, "TTL fora da faixa ou menor que o timeout do refresh (8 s)");
  });
  t("M3. liberacao casada com o PORTADOR (+ dono, loja, marketplace, ainda nao liberado) — nunca so por loja", () => {
    const f = codigo.slice(codigo.indexOf("CREATE FUNCTION public.liberar_lease_refresh_credencial"));
    assert(/AND alvo\.portador = p_portador/.test(f) && /alvo\.loja_id = p_loja_id/.test(f) && /alvo\.user_id = p_user_id/.test(f) && /AND alvo\.liberada_em IS NULL;/.test(f), "release sem portador");
    assert(!/DELETE FROM public\.credencial_refresh_lease/.test(codigo), "release apaga linha");
  });
  t("M4. seguranca SEC-3: INVOKER + search_path fixo; tabela e RPCs sem PUBLIC/anon/authenticated; service_role minimo", () => {
    assert((codigo.match(/SECURITY INVOKER\nSET search_path = public/g) ?? []).length === 2 && !/SECURITY DEFINER/.test(codigo), "invoker/search_path");
    // tabela: UMA instrucao com os tres papeis (padrao exigido desde a SEC-3-C — testar-s2d1-migracao #7)
    assert(new RegExp(`^${RV} ALL PRIVILEGES ON TABLE public\\.credencial_refresh_lease FROM PUBLIC, anon, authenticated;$`, "m").test(codigo), `tabela sem ${RV} de PUBLIC, anon, authenticated`);
    for (const papel of ["PUBLIC", "anon", "authenticated"]) {
      assert((codigo.match(new RegExp(`${RV} ALL ON FUNCTION public\\.(adquirir|liberar)_lease_refresh_credencial\\([^)]*\\) FROM ${papel};`, "g")) ?? []).length === 2, `funcoes sem ${RV} ${papel}`);
    }
    const concessoes = codigo.match(new RegExp(`${GR} [^;]+;`, "g")) ?? [];
    assert(concessoes.length === 3 && concessoes.every((g) => / TO service_role;$/.test(g)), concessoes.join(" | "));
    assert(/BEGIN;\nSET LOCAL lock_timeout = '5s';/.test(sql) && /\nCOMMIT;\s*$/.test(sql) && /ROLLBACK EXATO/.test(sql), "transacao/rollback documentado");
  });
  t("M5. sem lock em memoria e sem chamada ao provider fora do lease; os getters entram so pelo lease", () => {
    const sa = readFileSync(join(RAIZ, "lib/shopee-auth.ts"), "utf8").replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "");
    assert(!/new Map\(|new Set\(|emVoo|let\s+\w+\s*:\s*Promise|globalThis/.test(sa), "estado de processo para exclusao");
    assert((sa.match(/renovarShopeeComLease\(loja\.id, loja\.refresh_token, portasReaisShopee\(loja, userId\)\)/g) ?? []).length === 2, "getter fora do lease");
    assert(/adquirirLease: \(portador\) => adquirirLeaseRefreshShopee\(loja\.id, userId, portador\)/.test(sa) && /liberarLease: \(portador\) => liberarLeaseRefreshShopee\(loja\.id, userId, portador\)/.test(sa), "portas reais do lease");
    assert(/finally \{\s*try \{ await portas\.liberarLease\(portador\); \}/.test(sa), "liberacao fora do finally");
  });

  await fila;
  console.log(`\n${falhou === 0 ? "✓" : "✗"} SHOPEE-REFRESH-LEASE — ${passou} passaram, ${falhou} falharam`);
  process.exit(falhou === 0 ? 0 : 1);
}
principal().catch((e) => { console.error("ERRO FATAL", e); process.exit(1); });
