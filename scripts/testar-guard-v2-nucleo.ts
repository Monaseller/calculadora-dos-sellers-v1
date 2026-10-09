/**
 * GUARD V2 — primeiro núcleo de INVARIANTES (CDS V2, Fase 0).
 *
 * Protege o que a Fase 0 corrigiu, pelo comportamento — não pela forma do código:
 *   A. leitura de `anuncios` com >1000 linhas é COMPLETA (999/1000/1001/2500, max-rows
 *      do servidor menor que a página, erro no meio, teto de páginas);
 *   B. Shopee nunca cruza loja (mapa de custo e importação, 2 lojas do mesmo dono + outro dono);
 *   C. o mapa de custo do ML nunca lê Shopee (mesmo dono com ML + Shopee misturados, >1000);
 *   D. o cliente anon não ganha acesso novo (chave anon só em lib/supabase.ts; ninguém importa o
 *      cliente anon como VALOR; createClient só nos arquivos já conhecidos);
 *   E. guard não se auto-enfraquece sem aparecer (manifesto sha256 do runner).
 *
 * O banco falso emula o PostgREST: cada resposta é cortada em MAX_ROWS (1000) sem erro — exatamente
 * a armadilha que a Fase 0 fecha. Offline: sem rede, sem banco real.
 *
 *   npx tsx scripts/testar-guard-v2-nucleo.ts
 */
import "./_server-only-inerte";
import Module from "node:module";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const RAIZ = join(__dirname, "..");
let passou = 0, falhou = 0;
let fila: Promise<void> = Promise.resolve();
function t(nome: string, fn: () => void | Promise<void>) {
  fila = fila.then(async () => {
    try { await fn(); passou++; console.log(`  PASS  ${nome}`); }
    catch (e: any) { falhou++; console.log(`  FALHA ${nome} -> ${e?.message ?? e}`); }
  });
}
function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const fonte = (rel: string) => readFileSync(join(RAIZ, rel), "utf8").replace(/\r\n/g, "\n");

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://placeholder-de-teste.invalid";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "chave-de-teste-invalida";
process.env.SUPABASE_SERVICE_ROLE_KEY = "chave-de-teste-invalida";
process.env.SESSION_SECRET = "segredo-de-teste-com-mais-de-32-bytes-000000";
process.env.SHOPEE_BASE_URL = "https://shopee.teste.invalid";

// ── PostgREST falso: corta TODA resposta em MAX_ROWS, sem erro ─────────
let MAX_ROWS = 1000;
type Linha = Record<string, any>;
let db: Record<string, Linha[]> = {};
let consultas: { tabela: string; filtros: any[]; faixa: [number, number] | null }[] = [];
let escritas: { op: string; tabela: string; payload: any; filtros: any[] }[] = [];
let falharLeituraNaPagina: number | null = null;
function clienteFalso() {
  return {
    rpc: async () => ({ data: null, error: { message: "rpc_indisponivel" } }),
    from(tabela: string) {
      const st: any = { op: "select", payload: null, filtros: [] as any[], faixa: null as [number, number] | null, ordem: null as string | null, unico: false };
      const casa = (r: Linha) => st.filtros.every(([k, c, v]: any) =>
        k === "eq" ? String(r[c]) === String(v) : k === "notnull" ? r[c] != null : k === "is" ? (r[c] ?? null) === v : true);
      const exec = () => {
        const ls = (db[tabela] ??= []);
        if (st.op !== "select") {
          escritas.push({ op: st.op, tabela, payload: st.payload, filtros: [...st.filtros] });
          if (st.op === "insert") { for (const n of [].concat(st.payload)) ls.push({ id: `novo-${ls.length}`, ...(n as any) }); return { data: null, error: null }; }
          if (st.op === "update") { for (const r of ls.filter(casa)) Object.assign(r, st.payload); return { data: null, error: null }; }
        }
        consultas.push({ tabela, filtros: [...st.filtros], faixa: st.faixa });
        if (falharLeituraNaPagina !== null && st.faixa && st.faixa[0] >= falharLeituraNaPagina * 1000) return { data: null, error: { message: "falha simulada" } };
        let out = ls.filter(casa);
        if (st.ordem) out = [...out].sort((a, b) => String(a[st.ordem]).localeCompare(String(b[st.ordem])));
        const [de, ate] = st.faixa ?? [0, Infinity];
        out = out.slice(de, Math.min(ate + 1, de + MAX_ROWS));            // ← o corte silencioso do PostgREST
        return st.unico ? { data: out[0] ?? null, error: null } : { data: out.map((r) => ({ ...r })), error: null, count: out.length };
      };
      const b: any = new Proxy({}, { get(_a, p: string) {
        if (p === "then") return (ok: any, err: any) => Promise.resolve().then(exec).then(ok, err);
        if (p === "maybeSingle" || p === "single") return async () => { st.unico = true; return exec(); };
        return (...a: any[]) => {
          if (p === "insert" || p === "update" || p === "upsert") { st.op = p; st.payload = a[0]; }
          else if (p === "eq" || p === "is") st.filtros.push([p, a[0], a[1]]);
          else if (p === "not" && a[1] === "is" && a[2] === null) st.filtros.push(["notnull", a[0]]);
          else if (p === "order") st.ordem = a[0];
          else if (p === "range") st.faixa = [a[0], a[1]];
          return b;
        };
      } });
      return b;
    },
  };
}
const requireOriginal = (Module as any).prototype.require;
(Module as any).prototype.require = function (id: string) {
  if (id === "@supabase/supabase-js") return { createClient: () => clienteFalso() };
  return requireOriginal.apply(this, arguments as any);
};

// ── Shopee falsa (catálogo) — registra shop_id de cada chamada ─────────
let catalogo: Record<string, string[]> = {};           // shop_id → item_ids (sem variação)
let chamadasShopee: string[] = [];
globalThis.fetch = (async (url: any) => {
  const u = new URL(String(url));
  if (u.hostname !== "shopee.teste.invalid") throw new Error(`rede real: ${u.hostname}`);
  const shop = u.searchParams.get("shop_id") ?? ""; chamadasShopee.push(shop);
  const ids = catalogo[shop] ?? [];
  let corpo: any = { response: {} };
  if (u.pathname.endsWith("get_item_list")) {
    const off = Number(u.searchParams.get("offset") ?? 0), tam = Number(u.searchParams.get("page_size") ?? 100);
    corpo = { response: { item: ids.slice(off, off + tam).map((i) => ({ item_id: Number(i) })), has_next_page: off + tam < ids.length, next_offset: off + tam } };
  } else if (u.pathname.endsWith("get_item_base_info")) {
    const pedidos = String(u.searchParams.get("item_id_list") ?? "").split(",").filter(Boolean);
    corpo = { response: { item_list: pedidos.map((i) => ({ item_id: Number(i), item_name: `Item ${i}`, has_model: false, price_info: [{ current_price: 10 }], sku: `S${i}` })) } };
  }
  return { ok: true, status: 200, json: async () => corpo, text: async () => JSON.stringify(corpo) } as any;
}) as any;

const DONO_X = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", DONO_Y = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LOJA_A = "11111111-1111-4111-8111-111111111111", LOJA_B = "22222222-2222-4222-8222-222222222222", LOJA_C = "33333333-3333-4333-8333-333333333333";
const pad = (n: number) => String(n).padStart(6, "0");
const anuncio = (id: string, dono: string, mkt: "Shopee" | "ML", loja: string | null, item: string) => ({
  id, user_id: dono, marketplace: mkt, loja_id: loja, ml_item_id: item, variation_id: null, ativo: true,
  nome: `Item ${item}`, preco_anuncio: 10, thumbnail: null, sku: `S${item}`, custo_produto: 1, insumos: 0, custo_frete: 0, imposto: 0,
});

async function principal() {
  const PAG = await import("../lib/anuncios/leitura-paginada");
  const SS = await import("../lib/sync-shopee");
  const SML = await import("../lib/sync-ml");
  const MOT = await import("../lib/anuncios/importacao-shopee");
  const RUN = await import("./rodar-bateria-offline");

  const consultaDe = (linhas: Linha[]) => () => {
    const st: any = { ordem: null, faixa: null };
    const q: any = {
      order: (c: string) => { st.ordem = c; return q; },
      range: (de: number, ate: number) => { st.faixa = [de, ate];
        consultas.push({ tabela: "x", filtros: [], faixa: st.faixa });
        if (falharLeituraNaPagina !== null && de >= falharLeituraNaPagina * 1000) return Promise.resolve({ data: null, error: { message: "x" } });
        const ord = [...linhas].sort((a, b) => String(a.id).localeCompare(String(b.id)));
        return Promise.resolve({ data: ord.slice(de, Math.min(ate + 1, de + MAX_ROWS)), error: null }); },
    };
    return q;
  };
  const gerar = (n: number) => Array.from({ length: n }, (_, i) => ({ id: pad(i) }));

  console.log("\n[A. leitura completa — o corte de 1000 do PostgREST nunca vira 'conjunto inteiro']");
  t("A. 999 / 1000 / 1001 / 2500 linhas → todas, sem repetir, em ordem estável", async () => {
    for (const n of [999, 1000, 1001, 2500]) {
      MAX_ROWS = 1000; consultas = []; falharLeituraNaPagina = null;
      const r = await PAG.lerTodasAsPaginas(consultaDe(gerar(n)));
      assert(r.ok && r.linhas.length === n && new Set(r.linhas.map((l: any) => l.id)).size === n, `${n}: ${r.ok ? r.linhas.length : r.motivo}`);
    }
  });
  t("A2. max-rows do servidor MENOR que a página (700) → ainda completa (não confia em 'página curta')", async () => {
    MAX_ROWS = 700; falharLeituraNaPagina = null;
    const r = await PAG.lerTodasAsPaginas(consultaDe(gerar(2500)));
    MAX_ROWS = 1000;
    assert(r.ok && r.linhas.length === 2500 && new Set(r.linhas.map((l: any) => l.id)).size === 2500, `${r.ok ? r.linhas.length : r.motivo}`);
  });
  t("A3. erro numa página do meio → falha inteira (nunca devolve o pedaço lido)", async () => {
    falharLeituraNaPagina = 1;
    const r = await PAG.lerTodasAsPaginas(consultaDe(gerar(2500)));
    falharLeituraNaPagina = null;
    assert(!r.ok && r.motivo === "ERRO_LEITURA", JSON.stringify(r).slice(0, 80));
  });
  t("A4. além do teto de páginas → LIMITE_DE_PAGINAS explícito (nunca corte silencioso)", async () => {
    const r = await PAG.lerTodasAsPaginas(consultaDe(gerar(PAG.MAX_PAGINAS_ANUNCIOS + 5)), 1);
    assert(!r.ok && r.motivo === "LIMITE_DE_PAGINAS", JSON.stringify(r).slice(0, 80));
  });
  t("A5. todo leitor operacional de anuncios usa a leitura paginada (Shopee existentes/custo, ML custo/existentes/precos/skus)", () => {
    for (const [arq, n] of [["lib/anuncios/importacao-shopee.ts", 1], ["lib/sync-shopee.ts", 1], ["lib/sync-ml.ts", 1],
      ["app/api/ml/importar-anuncios/route.ts", 1], ["app/api/ml/sync-precos/route.ts", 1], ["app/api/ml/sync-skus/route.ts", 1]] as const) {
      const s = fonte(arq);
      const usos = (s.match(/lerTodasAsPaginas<\w+>\(\(\) => \w+\(?\)?\s*\.from\("anuncios"\)/g) ?? []).length;
      const cruas = (s.match(/=\s*await\s+\w+\(?\)?\s*\.from\("anuncios"\)\s*\.select\(/g) ?? []).length;
      assert(usos === n && cruas === 0, `${arq}: paginadas=${usos} cruas=${cruas}`);
    }
  });

  console.log("\n[A/B. Shopee: mapas completos e presos à loja]");
  const montarShopee = () => {
    const linhas: Linha[] = [];
    for (let i = 0; i < 2500; i++) linhas.push(anuncio(`a${pad(i)}`, DONO_X, "Shopee", LOJA_A, String(100000 + i)));
    for (let i = 0; i < 1500; i++) linhas.push(anuncio(`b${pad(i)}`, DONO_X, "Shopee", LOJA_B, String(100000 + i)));   // MESMOS item_ids
    for (let i = 0; i < 1200; i++) linhas.push(anuncio(`c${pad(i)}`, DONO_Y, "Shopee", LOJA_C, String(100000 + i)));
    return linhas;
  };
  t("A/B. carregarMapaAnuncios(loja A, 2500 linhas) → 2500 itens, todos da loja A, nunca de B (mesmos item_ids) nem do outro dono", async () => {
    MAX_ROWS = 1000; db = { anuncios: montarShopee() }; consultas = [];
    const mapa = await SS.carregarMapaAnuncios(DONO_X, LOJA_A);
    const ids = new Set([...mapa.values()].map((a: any) => a.id));
    assert(ids.size === 2500 && [...ids].every((id) => String(id).startsWith("a")), `itens=${ids.size}`);
    const doAnuncios = consultas.filter((c) => c.tabela === "anuncios");
    assert(doAnuncios.length >= 3 && doAnuncios.every((c) => c.filtros.some(([k, col, v]: any) => k === "eq" && col === "loja_id" && v === LOJA_A)), "consulta sem loja");
  });
  t("A/B. Import V2 com 1001 existentes na loja (>1000) → 0 inserções, 1001 ignorados, nada na loja B", async () => {
    const linhas: Linha[] = [];
    const ids: string[] = [];
    for (let i = 0; i < 1001; i++) { ids.push(String(200000 + i)); linhas.push({ ...anuncio(`a${pad(i)}`, DONO_X, "Shopee", LOJA_A, String(200000 + i)), nome: `Item ${200000 + i}`, preco_anuncio: 10, sku: `S${200000 + i}` }); }
    for (let i = 0; i < 50; i++) linhas.push(anuncio(`b${pad(i)}`, DONO_X, "Shopee", LOJA_B, String(200000 + i)));
    MAX_ROWS = 1000; db = { anuncios: linhas }; escritas = []; chamadasShopee = [];
    catalogo = { "419809235": ids };
    const r = await MOT.importarFatiaShopee({
      banco: clienteFalso() as any, userId: DONO_X, lojaId: LOJA_A, ultimoItem: null, inicioMs: Date.now(), orcamentoMs: 10 * 60_000,
      cred: { partnerId: "1", partnerKey: "k", accessToken: "t", shopId: "419809235" },
    });
    assert(r.parcial === false && r.importados === 0 && r.ignorados === 1001 && r.atualizados === 0, JSON.stringify(r));
    assert(escritas.length === 0, `escritas: ${escritas.length}`);
    assert(chamadasShopee.every((s) => s === "419809235"), "chamou outra loja");
  });

  console.log("\n[C. ML: mapa de custo nunca lê Shopee]");
  t("C. mesmo dono com 1200 Shopee + 1100 ML ativos → mapa ML tem os 1100 ML e nenhum Shopee", async () => {
    const linhas: Linha[] = [];
    for (let i = 0; i < 1200; i++) linhas.push(anuncio(`s${pad(i)}`, DONO_X, "Shopee", LOJA_A, String(300000 + i)));
    for (let i = 0; i < 1100; i++) linhas.push(anuncio(`m${pad(i)}`, DONO_X, "ML", null, `MLB${400000 + i}`));
    for (let i = 0; i < 30; i++) linhas.push(anuncio(`y${pad(i)}`, DONO_Y, "ML", null, `MLB${500000 + i}`));
    MAX_ROWS = 1000; db = { anuncios: linhas }; consultas = [];
    const mapa = await SML.carregarMapaAnunciosML(DONO_X);
    const ids = [...mapa.values()].map((a: any) => a.id);
    assert(mapa.size === 1100 && ids.every((id) => String(id).startsWith("m")), `ml=${mapa.size} amostra=${ids.slice(0, 3)}`);
    assert(consultas.filter((c) => c.tabela === "anuncios").every((c) => c.filtros.some(([k, col, v]: any) => k === "eq" && col === "marketplace" && v === "ML")), "consulta sem marketplace ML");
    assert(/const mapaAnuncios = await carregarMapaAnunciosML\(userId\);/.test(fonte("lib/sync-ml.ts")), "sync ML nao usa o mapa filtrado");
  });

  console.log("\n[D. cliente anon não ganha acesso novo]");
  t("D. chave anon só em lib/supabase.ts; ninguém importa o cliente anon como valor; createClient só nos arquivos conhecidos", () => {
    const git = (...a: string[]) => { try { return execFileSync("git", a, { cwd: RAIZ, encoding: "utf8" }); } catch (e: any) { if (e.status === 1) return ""; throw e; } };
    const comChaveAnon = git("grep", "-l", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "--", "app", "lib", "components", "middleware.ts").trim().split(/\r?\n/).filter(Boolean);
    assert(JSON.stringify(comChaveAnon) === JSON.stringify(["lib/supabase.ts"]), `chave anon em: ${comChaveAnon}`);
    const importsValor = git("grep", "-nE", "import\\s*\\{[^}]*\\bsupabase\\b[^}]*\\}\\s*from\\s*['\"][^'\"]*lib/supabase['\"]", "--", "app", "lib", "components").trim();
    assert(importsValor === "", `cliente anon importado como valor: ${importsValor}`);
    const comCreate = git("grep", "-l", "createClient(", "--", "app", "lib", "components", "middleware.ts").trim().split(/\r?\n/).filter(Boolean).sort();
    const conhecidos = ["app/api/admin/shopee/status/route.ts", "app/api/internal/estudio-anuncios/executar/route.ts",
      "app/api/internal/estudio-anuncios/worker/route.ts", "lib/estudio-anuncios/supabase-servidor.ts", "lib/supabase.ts"];
    assert(JSON.stringify(comCreate) === JSON.stringify(conhecidos), `createClient em: ${comCreate}`);
  });

  console.log("\n[E. guard não se auto-enfraquece sem aparecer]");
  t("E. manifesto cobre todo guard/exceção/runner e detecta alteração, criação e remoção", () => {
    const atual = RUN.calcularManifesto();
    const gravado = RUN.lerManifestoGravado();
    assert(gravado !== null, "manifesto ausente");
    assert(RUN.verificarManifesto(gravado, atual).length === 0, `manifesto divergente: ${RUN.verificarManifesto(gravado, atual).join(" | ")}`);
    for (const f of ["scripts/testar-guard-v2-nucleo.ts", "scripts/rodar-bateria-offline.ts", "scripts/testar-vendas-sync-cron.ts", "scripts/_excecao-shopee-import-v2.ts"]) assert(f in atual, `${f} fora do manifesto`);
    const alterado = { ...atual, "scripts/testar-vendas-sync-cron.ts": "0".repeat(64) };
    const semUm = { ...atual }; delete (semUm as any)["scripts/testar-middleware.ts"];
    const comExtra = { ...atual, "scripts/testar-intruso.ts": "f".repeat(64) };
    assert(RUN.verificarManifesto(alterado, atual).some((d) => /ALTERADO.*vendas-sync-cron/.test(d)), "alteracao nao detectada");
    assert(RUN.verificarManifesto(semUm, atual).some((d) => /NOVO.*testar-middleware/.test(d)), "criacao nao detectada");
    assert(RUN.verificarManifesto(comExtra, atual).some((d) => /APAGADO.*testar-intruso/.test(d)), "remocao nao detectada");
  });
  t("E2. runner: só lista explícita, nunca live/banco; falha nova nunca vira baseline", () => {
    assert(RUN.SUITES_OFFLINE.every((s) => !RUN.PROIBIDO.test(s)), "suite real na bateria");
    assert(["agentes-f9-1-producao", "x-live", "y-banco"].every((s) => RUN.PROIBIDO.test(s)), "padrao proibido nao barra");
    assert(RUN.classificar("middleware", 1, "  FALHA 28. assets").classe === "KNOWN_FAIL", "baseline auditada");
    assert(RUN.classificar("middleware", 1, "  FALHA 28. a\n  FALHA 29. b").classe === "FAIL_NOVO", "falha nova absorvida");
    assert(RUN.classificar("vendas-sync-cron", 1, "  FALHA 23. escopo").classe === "FAIL_NOVO", "suite sem baseline absorveu falha");
    assert(RUN.classificar("vendas-sync-cron", 1, "erro qualquer sem id").classe === "FAIL_NOVO", "falha sem ID absorvida");
    const g10x5 = ["G9", ...Array(5).fill("G10")].map((i) => `  x ${i}  algo`).join("\n");
    assert(RUN.classificar("agentes-analise-vendas", 1, g10x5).classe === "FAIL_NOVO", "multiconjunto: 5o G10 absorvido");
    assert(RUN.classificar("credenciais-marketplace", 1, "  ✗ 92. lojas\n  ✗ 56. getMLLojaById").classe === "FAIL_NOVO", "#56 corrigido nao pode voltar");
  });

  await fila;
  console.log(`\n${falhou === 0 ? "✓" : "✗"} GUARD-V2-NUCLEO — ${passou} passaram, ${falhou} falharam`);
  process.exit(falhou === 0 ? 0 : 1);
}
principal().catch((e) => { console.error("ERRO FATAL", e?.message ?? e); process.exit(1); });
