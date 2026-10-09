/**
 * CDS V2 — Fase 1A: identidade de loja + metadata da conta.
 *
 * Prova (offline — duplo de banco, Shopee/ML falsos, sessão de teste) que:
 *   • o nome real vem do provider pelo parser canônico (shop_name no topo OU em response);
 *   • fallback técnico "<Marketplace> <id>" só em loja NOVA sem nome real;
 *   • reconexão/refresh sem nome NUNCA rebaixa nome real para fallback;
 *   • metadata nunca cruza loja, dono, marketplace nem id externo;
 *   • conectar NÃO troca a loja Shopee em uso (sem cookie shopee_loja_id);
 *   • o resolvedor exige loja explícita (nada de "mais recente"/"primeira ativa");
 *   • nada é específico de uma loja (terceira loja Shopee funciona sem código novo).
 *
 * Uso: npx tsx scripts/testar-lojas-identidade.ts
 */
import "./_server-only-inerte";
import Module from "node:module";
import { identidadeDeLojaNaoExplicita, invariantesV2 } from "./_guard-v2";

let ok = 0, falhou = 0;
let fila: Promise<void> = Promise.resolve();
const imprimir = console.log.bind(console);
function t(nome: string, fn: () => void | Promise<void>) {
  fila = fila.then(async () => {
    try { await fn(); ok++; imprimir(`  PASS  ${nome}`); }
    catch (e: any) { falhou++; imprimir(`  FALHA ${nome} -> ${e?.message ?? e}`); }
  });
}
function secao(s: string) { fila = fila.then(() => { imprimir(s); }); }
function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://placeholder-de-teste.invalid";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "chave-de-teste-invalida";
process.env.SUPABASE_SERVICE_ROLE_KEY = "chave-de-teste-invalida";
process.env.SESSION_SECRET = "segredo-de-teste-com-mais-de-32-bytes-000000";
process.env.SHOPEE_BASE_URL = "https://shopee.teste.invalid";
process.env.SHOPEE_REDIRECT_URI = "https://www.calculadoradossellers.com.br/api/auth/shopee/callback";
process.env.SHOPEE_PARTNER_ID = "1000001";
process.env.SHOPEE_PARTNER_KEY = "chave-ficticia-DEFAULT-0123456789abcdef";

const UID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LOJA_A1 = "11111111-1111-4111-8111-111111111111";
const LOJA_A2 = "22222222-2222-4222-8222-222222222222";
const LOJA_A_ML = "33333333-3333-4333-8333-333333333333";
const LOJA_B1 = "44444444-4444-4444-8444-444444444444";
const SHOP_1 = "710000001", SHOP_2 = "710000002", SHOP_B = "710000009";
const SELLER_ML = "990000001";

// ── lojas em memória (projeção completa; filtros eq) ─────────────────
type Loja = Record<string, any>;
let lojas: Loja[] = [];
let seq = 0;
let escritas: { op: string; payload: any; filtros: [string, any][] }[] = [];
function clienteFalso() {
  return { from(tabela: string) {
    if (tabela !== "lojas") throw new Error(`tabela inesperada: ${tabela}`);
    const st: any = { op: "select", payload: null, filtros: [] as [string, any][] };
    const casa = (l: Loja) => st.filtros.every(([c, v]: [string, any]) => String(l[c]) === String(v));
    const exec = () => {
      if (st.op === "insert") {
        escritas.push({ op: "insert", payload: st.payload, filtros: [] });
        const nova = { id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`, ativo: true, ...st.payload };
        lojas.push(nova); return { data: [{ id: nova.id }], error: null };
      }
      if (st.op === "update") {
        escritas.push({ op: "update", payload: st.payload, filtros: [...st.filtros] });
        const alvo = lojas.filter(casa); for (const l of alvo) Object.assign(l, st.payload);
        return { data: alvo.map((l) => ({ id: l.id })), error: null };
      }
      return { data: lojas.filter(casa).map((l) => ({ ...l })), error: null };
    };
    const b: any = {
      select: () => b, order: () => b, not: () => b, limit: () => b,
      insert: (p: any) => { st.op = "insert"; st.payload = p; return b; },
      update: (p: any) => { st.op = "update"; st.payload = p; return b; },
      eq: (c: string, v: any) => { st.filtros.push([c, v]); return b; },
      then: (res: any, rej: any) => Promise.resolve().then(exec).then(res, rej),
    };
    return b;
  } };
}
const requireOriginal = (Module as any).prototype.require;
(Module as any).prototype.require = function (id: string) {
  if (id === "@supabase/supabase-js") return { createClient: () => clienteFalso() };
  return requireOriginal.apply(this, arguments as any);
};

// ── Shopee falsa: get_shop_info configurável ─────────────────────────
let respostaShopInfo: unknown | "LANCA" = {};
globalThis.fetch = (async (url: any) => {
  const u = new URL(String(url));
  if (u.pathname === "/api/v2/auth/token/get") return { ok: true, status: 200, json: async () => ({ access_token: "<access-teste>", refresh_token: "<refresh-teste>", expire_in: 14400 }) } as any;
  if (u.pathname === "/api/v2/shop/get_shop_info") {
    if (respostaShopInfo === "LANCA") throw new Error("falha simulada");
    const corpo = respostaShopInfo;
    return { ok: true, status: 200, json: async () => corpo } as any;
  }
  throw new Error(`teste tentou acessar a rede: ${u.pathname}`);
}) as any;

const lojaShopee = (id: string, user_id: string, shop: string, nome: string, extra: Loja = {}): Loja =>
  ({ id, user_id, marketplace: "Shopee", seller_id: shop, shop_id: shop, nome, nickname: nome, ativo: true, created_at: "2026-01-01", ...extra });
const lojaML = (id: string, user_id: string, seller: string, nome: string, extra: Loja = {}): Loja =>
  ({ id, user_id, marketplace: "ML", seller_id: seller, shop_id: null, nome, nickname: nome, ativo: true, created_at: "2026-01-02", ...extra });

async function principal() {
  console.log = () => {}; console.error = () => {}; console.warn = () => {};
  const ID = await import("../lib/lojas/identidade");
  const RES = await import("../lib/lojas/resolver");
  const CAP = await import("../lib/marketplace/credenciais");
  const auth = await import("../lib/autenticacao");
  const est = await import("../lib/shopee-oauth-estado");
  const inicio = await import("../app/api/auth/shopee/route");
  const callback = await import("../app/api/auth/shopee/callback/route");
  const sessaoA = (await auth.emitirTokenSessao(UID_A)).token;
  const req = (caminho: string, cookies: Record<string, string>) =>
    new Request(`https://www.calculadoradossellers.com.br${caminho}`, { headers: { cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ") } });
  const conectar = async (shop: string, shopInfo: unknown | "LANCA") => {
    respostaShopInfo = shopInfo;
    const r1: any = await inicio.GET(req("/api/auth/shopee", { cds_session: sessaoA }));
    const estado = r1.cookies?.get?.(est.NOME_COOKIE_ESTADO_SHOPEE)?.value;
    assert(estado, "inicio sem estado");
    return callback.GET(req(`/api/auth/shopee/callback?code=CODE-1&shop_id=${shop}`, { cds_session: sessaoA, [est.NOME_COOKIE_ESTADO_SHOPEE]: estado })) as Promise<any>;
  };
  const destino = (r: any) => new URL(r.headers.get("location") ?? "", "https://x.invalid");
  const reiniciar = (linhas: Loja[] = []) => { lojas = linhas.map((l) => ({ ...l })); escritas = []; seq = 0; respostaShopInfo = {}; };
  const daLoja = (shop: string, uid = UID_A) => lojas.find((l) => l.marketplace === "Shopee" && l.shop_id === shop && l.user_id === uid)!;

  secao("\n[I/J. parser canônico de get_shop_info]");
  t("I. shop_name no TOPO da resposta → nome real", () => {
    assert(ID.extrairNomeLojaShopee({ shop_name: "Loja Topo", region: "BR", error: "", request_id: "r" }) === "Loja Topo", "topo");
    assert(ID.extrairNomeLojaShopee({ shop_name: "  Loja   Topo  " }) === "Loja Topo", "normalização");
    assert(ID.extrairNomeLojaShopee({ shop_name: "Topo", response: { shop_name: "Aninhado" } }) === "Topo", "topo tem precedência determinística");
  });
  t("J. response.shop_name (formato do código/fixture anteriores) → nome real; inválidos → null", () => {
    assert(ID.extrairNomeLojaShopee({ response: { shop_name: "Loja Aninhada" } }) === "Loja Aninhada", "aninhado");
    assert(ID.extrairNomeLojaShopee({ shop_name: "", response: { shop_name: "Aninhado" } }) === "Aninhado", "topo vazio cai para aninhado");
    for (const ruim of [null, undefined, "x", 1, {}, { shop_name: "   " }, { shop_name: 42 }, { response: null }, { shop_name: "x".repeat(ID.TAMANHO_MAX_NOME_LOJA + 1) }])
      assert(ID.extrairNomeLojaShopee(ruim) === null, `aceitou ${JSON.stringify(ruim)?.slice(0, 30)}`);
  });

  secao("\n[A-D/H. conexão Shopee: nome real × fallback técnico]");
  t("A. loja NOVA + nome real → grava o nome real (nome e nickname)", async () => {
    reiniciar();
    const r = await conectar(SHOP_1, { shop_name: "Loja Real Um" });
    assert(destino(r).searchParams.get("ok") === "shopee", destino(r).href);
    const l = daLoja(SHOP_1);
    assert(l.nome === "Loja Real Um" && l.nickname === "Loja Real Um", JSON.stringify(l));
  });
  t("B. loja NOVA sem nome real → fallback técnico temporário, calculado do id externo", async () => {
    reiniciar();
    await conectar(SHOP_1, { error: "", message: "" });
    const l = daLoja(SHOP_1);
    assert(l.nome === ID.fallbackTecnicoDaLoja("Shopee", SHOP_1) && l.nome === `Shopee ${SHOP_1}`, l.nome);
    assert(!ID.ehNomeReal(l.nome, l) && ID.nomeExibicaoDaLoja(l) === `Shopee ${SHOP_1}`, "fallback tratado como nome real");
  });
  t("C. loja com nome real + reconexão SEM nome → nome real preservado (nenhum campo de nome escrito)", async () => {
    reiniciar([lojaShopee(LOJA_A1, UID_A, SHOP_1, "Loja Real Um")]);
    await conectar(SHOP_1, {});
    const l = daLoja(SHOP_1);
    assert(l.nome === "Loja Real Um" && l.nickname === "Loja Real Um", JSON.stringify(l));
    assert(escritas.every((w) => !("nome" in w.payload) && !("nickname" in w.payload)), JSON.stringify(escritas.map((w) => Object.keys(w.payload))));
  });
  t("D. loja com fallback + reconexão COM nome real → promovida a nome real", async () => {
    reiniciar([lojaShopee(LOJA_A1, UID_A, SHOP_1, `Shopee ${SHOP_1}`)]);
    await conectar(SHOP_1, { shop_name: "Loja Promovida" });
    const l = daLoja(SHOP_1);
    assert(l.nome === "Loja Promovida" && l.nickname === "Loja Promovida" && l.id === LOJA_A1, JSON.stringify(l));
  });
  t("H. reconexão com get_shop_info falhando → nome real NÃO vira fallback", async () => {
    reiniciar([lojaShopee(LOJA_A1, UID_A, SHOP_1, "Loja Real Um")]);
    const r = await conectar(SHOP_1, "LANCA");
    assert(destino(r).searchParams.get("ok") === "shopee", destino(r).href);
    assert(daLoja(SHOP_1).nome === "Loja Real Um", daLoja(SHOP_1).nome);
  });
  t("CB. conectar NÃO troca a loja em uso: sem cookie shopee_loja_id; a loja vem identificada no retorno", async () => {
    reiniciar([lojaShopee(LOJA_A1, UID_A, SHOP_1, "Loja Real Um")]);
    const r = await conectar(SHOP_2, { shop_name: "Loja Dois" });
    assert(!r.cookies?.get?.("shopee_loja_id") && !/shopee_loja_id=/.test(r.headers.get("set-cookie") ?? ""), "callback gravou shopee_loja_id");
    assert(!r.cookies?.get?.("loja_ativa_id"), "callback gravou loja_ativa_id");
    assert(destino(r).searchParams.get("loja") === daLoja(SHOP_2).id, destino(r).href);
  });

  t("CB2. CONECTAR != SELECIONAR: nenhum runtime lê ?loja= e a troca de loja na UI só nasce de ação do usuário (handler on*)", () => {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const { join } = require("node:path") as typeof import("node:path");
    const raiz = join(__dirname, "..");
    const arquivos = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "app", "components", "lib"], { cwd: raiz, encoding: "utf8" })
      .split(/\r?\n/).filter((f) => /\.(ts|tsx)$/.test(f));
    for (const f of arquivos) {
      const src = readFileSync(join(raiz, f), "utf8").replace(/\r\n/g, "\n");
      assert(!/\.get\(\s*["']loja["']\s*\)/.test(src), `${f} lê o parâmetro ?loja= (poderia trocar contexto)`);
      if (!f.startsWith("app/api/") && /\/api\/lojas\/ativar/.test(src)) {
        const funcoes = [...src.matchAll(/async function (\w+)\([^)]*\)\s*\{/g)]
          .filter((m) => { const corpo = src.slice(m.index!, src.indexOf("\n  }\n", m.index!)); return /\/api\/lojas\/ativar/.test(corpo); }).map((m) => m[1]);
        assert(funcoes.length > 0, `${f}: chamada a /api/lojas/ativar fora de função nomeada`);
        for (const nome of funcoes) for (const uso of src.matchAll(new RegExp(`\\b${nome}\\(`, "g"))) {
          const antes = src.slice(Math.max(0, uso.index! - 60), uso.index!);
          assert(/async function $/.test(antes) || /\bon[A-Z]\w*=\{\s*\(\)\s*=>\s*$/.test(antes), `${f}: ${nome}() chamado fora de ação do usuário`);
        }
      }
    }
  });

  secao("\n[E-G. metadata nunca cruza loja, dono, marketplace, id externo]");
  const base = () => [lojaShopee(LOJA_A1, UID_A, SHOP_1, "Loja Real Um"), lojaShopee(LOJA_A2, UID_A, SHOP_2, `Shopee ${SHOP_2}`),
    lojaML(LOJA_A_ML, UID_A, SELLER_ML, "ml_apelido"), lojaShopee(LOJA_B1, UID_B, SHOP_B, "Loja do B")];
  t("E. metadata da loja A2 só altera A2 (A1 do mesmo dono intacta)", async () => {
    reiniciar(base());
    const antesA1 = JSON.stringify(lojas.find((l) => l.id === LOJA_A1));
    const r = await CAP.atualizarMetadataDaLoja(UID_A, LOJA_A2, "Shopee", { idExterno: SHOP_2, nomeReal: "Loja Dois" });
    assert(r.ok && r.atualizado, JSON.stringify(r));
    assert(lojas.find((l) => l.id === LOJA_A2)!.nome === "Loja Dois", "A2 não atualizada");
    assert(JSON.stringify(lojas.find((l) => l.id === LOJA_A1)) === antesA1, "A1 alterada");
    const w = escritas.filter((x) => x.op === "update");
    assert(w.length === 1 && w[0].filtros.some(([c, v]) => c === "id" && v === LOJA_A2) && w[0].filtros.some(([c, v]) => c === "user_id" && v === UID_A)
      && w[0].filtros.some(([c, v]) => c === "marketplace" && v === "Shopee"), JSON.stringify(w));
  });
  t("F. dono A nunca altera loja do dono B (mesmo com id e id externo corretos)", async () => {
    reiniciar(base());
    const r = await CAP.atualizarMetadataDaLoja(UID_A, LOJA_B1, "Shopee", { idExterno: SHOP_B, nomeReal: "Invasor" });
    assert(!r.ok && r.motivo === "loja_nao_encontrada", JSON.stringify(r));
    assert(lojas.find((l) => l.id === LOJA_B1)!.nome === "Loja do B" && escritas.length === 0, "loja de B alterada");
  });
  t("G. id externo estável: divergente → recusa; marketplace trocado → recusa; reconexão não reescreve seller_id/shop_id", async () => {
    reiniciar(base());
    const r1 = await CAP.atualizarMetadataDaLoja(UID_A, LOJA_A1, "Shopee", { idExterno: SHOP_2, nomeReal: "Outro" });
    assert(!r1.ok && r1.motivo === "id_externo_divergente", JSON.stringify(r1));
    const r2 = await CAP.atualizarMetadataDaLoja(UID_A, LOJA_A_ML, "Shopee", { idExterno: SELLER_ML, nomeReal: "Cruzado" });
    assert(!r2.ok && r2.motivo === "marketplace_divergente", JSON.stringify(r2));
    assert(escritas.length === 0, "escreveu em recusa");
    await conectar(SHOP_1, { shop_name: "Renomeada" });
    const l = lojas.find((x) => x.id === LOJA_A1)!;
    assert(l.shop_id === SHOP_1 && l.seller_id === SHOP_1 && l.nome === "Renomeada", JSON.stringify(l));
    assert(escritas.every((w) => !("seller_id" in w.payload) && !("shop_id" in w.payload) || w.op === "insert"), "UPDATE reescreveu id externo");
  });
  t("G2. refresh sem nome real → ok, nada escrito (nunca rebaixa nome real)", async () => {
    reiniciar(base());
    const r = await CAP.atualizarMetadataDaLoja(UID_A, LOJA_A1, "Shopee", { idExterno: SHOP_1, nomeReal: null });
    assert(r.ok && !r.atualizado && escritas.length === 0 && lojas.find((l) => l.id === LOJA_A1)!.nome === "Loja Real Um", JSON.stringify(r));
    const r2 = await CAP.atualizarMetadataDaLoja(UID_A, LOJA_A1, "Shopee", { idExterno: SHOP_1, nomeReal: `Shopee ${SHOP_1}` });
    assert(r2.ok && !r2.atualizado && lojas.find((l) => l.id === LOJA_A1)!.nome === "Loja Real Um", "fallback gravado por cima de nome real");
  });

  secao("\n[ML — caminho canônico de metadata (/users/me)]");
  t("ML1. extrairMetadataContaML: id + nickname real + status; nunca first_name", () => {
    const m = ID.extrairMetadataContaML({ id: 123, nickname: "APELIDO", first_name: "Pessoa", status: { site_status: "active" } });
    assert(m?.idExterno === "123" && m.nomeReal === "APELIDO" && m.status === "active", JSON.stringify(m));
    const s = ID.extrairMetadataContaML({ id: 123, first_name: "Pessoa" });
    assert(s?.nomeReal === null, "usou first_name como nome de loja");
    assert(ID.extrairMetadataContaML({ nickname: "x" }) === null, "aceitou sem id");
  });
  t("ML2. reconexão ML sem nickname preserva nome real; loja ML nova sem nickname recebe fallback técnico", async () => {
    reiniciar(base());
    const r = await CAP.registrarCredencialMLOAuth(UID_A, { lojaId: LOJA_A_ML, sellerId: SELLER_ML, nickname: null, accessToken: "<a>", refreshToken: null, expiraEm: "2027-01-01" });
    assert(r.lojaId === LOJA_A_ML && lojas.find((l) => l.id === LOJA_A_ML)!.nome === "ml_apelido", JSON.stringify(r));
    const n = await CAP.registrarCredencialMLOAuth(UID_A, { sellerId: "990000002", nickname: null, accessToken: "<a>", refreshToken: null, expiraEm: "2027-01-01" });
    assert(lojas.find((l) => l.id === n.lojaId)!.nome === "Mercado Livre 990000002", "fallback ML");
    await CAP.registrarCredencialMLOAuth(UID_A, { lojaId: n.lojaId, sellerId: "990000002", nickname: "novo_apelido", accessToken: "<a>", refreshToken: null, expiraEm: "2027-01-01" });
    assert(lojas.find((l) => l.id === n.lojaId)!.nome === "novo_apelido", "fallback ML não promovido");
  });

  secao("\n[UI — fonte única do nome]");
  t("U. nomeExibicaoDaLoja: nome real → nickname real → fallback técnico ('Minha Loja' e '<Mkt> <id>' não são nome real)", () => {
    assert(ID.nomeExibicaoDaLoja({ nome: "Real", nickname: "Nick", marketplace: "Shopee", seller_id: "5" }) === "Real", "nome real");
    assert(ID.nomeExibicaoDaLoja({ nome: "Shopee 5", nickname: "Nick", marketplace: "Shopee", seller_id: "5" }) === "Nick", "nickname real");
    assert(ID.nomeExibicaoDaLoja({ nome: "Minha Loja", nickname: null, marketplace: "ML", seller_id: "7" }) === "Mercado Livre 7", "default não é nome real");
    assert(ID.nomeExibicaoDaLoja({ nome: "Shopee 5", nickname: "Shopee 5", marketplace: "Shopee", shop_id: 5 }) === "Shopee 5", "fallback");
  });

  secao("\n[K-M. resolvedor explícito]");
  t("K. loja explícita correta → resolvida (marketplace, id externo, nome de exibição)", async () => {
    reiniciar(base());
    const r = await RES.resolverLoja({ userId: UID_A, marketplace: "Shopee", lojaId: LOJA_A1 });
    assert(r.ok && r.loja.id === LOJA_A1 && r.loja.idExterno === SHOP_1 && r.loja.nomeExibicao === "Loja Real Um" && r.origem === "explicita", JSON.stringify(r));
  });
  t("L. loja de outro dono (ou de outro marketplace) → LOJA_INVALIDA, nunca cai para outra", async () => {
    reiniciar(base());
    const r = await RES.resolverLoja({ userId: UID_A, marketplace: "Shopee", lojaId: LOJA_B1 });
    assert(!r.ok && r.motivo === "LOJA_INVALIDA", JSON.stringify(r));
    const r2 = await RES.resolverLoja({ userId: UID_A, marketplace: "Shopee", lojaId: LOJA_A_ML });
    assert(!r2.ok && r2.motivo === "LOJA_INVALIDA", JSON.stringify(r2));
  });
  t("M. sem loja e com várias → STORE_SELECTION_REQUIRED; sem opt-in nem a única é escolhida", async () => {
    reiniciar(base());
    const r = await RES.resolverLoja({ userId: UID_A, marketplace: "Shopee" });
    assert(!r.ok && r.motivo === "STORE_SELECTION_REQUIRED", JSON.stringify(r));
    const r2 = await RES.resolverLoja({ userId: UID_A, marketplace: "Shopee", permitirUnica: true });
    assert(!r2.ok && r2.motivo === "STORE_SELECTION_REQUIRED", "permitirUnica escolheu entre várias");
    const r3 = await RES.resolverLoja({ userId: UID_A, marketplace: "ML" });
    assert(!r3.ok && r3.motivo === "STORE_SELECTION_REQUIRED", "única sem opt-in foi escolhida");
    const r4 = await RES.resolverLoja({ userId: UID_A, marketplace: "ML", permitirUnica: true });
    assert(r4.ok && r4.loja.id === LOJA_A_ML && r4.origem === "unica", JSON.stringify(r4));
  });

  secao("\n[N/O. nada específico de loja]");
  t("N. terceira loja Shopee (id nunca visto) conecta, nomeia e resolve sem nenhum código novo", async () => {
    reiniciar(base());
    const SHOP_3 = "730000123";
    await conectar(SHOP_3, { shop_name: "Terceira Loja" });
    const l = daLoja(SHOP_3);
    assert(l && l.nome === "Terceira Loja" && l.user_id === UID_A, JSON.stringify(l));
    const r = await RES.resolverLoja({ userId: UID_A, marketplace: "Shopee", lojaId: l.id });
    assert(r.ok && r.loja.nomeExibicao === "Terceira Loja", JSON.stringify(r));
    assert(lojas.filter((x) => x.marketplace === "Shopee" && x.user_id === UID_A).length === 3, "não criou a terceira");
  });
  t("O. Guard V2 I6 limpo: nenhum nome/id de loja embutido, fallback só no helper, nome só via capability", () => {
    const i6 = identidadeDeLojaNaoExplicita();
    assert(i6.length === 0, i6.join(" | "));
    const v2 = invariantesV2();
    assert(v2.length === 0, v2.join(" | "));
  });

  await fila;
  imprimir(`\n${falhou === 0 ? "✓" : "✗"} LOJAS-IDENTIDADE — ${ok} passaram, ${falhou} falharam`);
  process.exit(falhou === 0 ? 0 : 1);
}
principal().catch((e) => { imprimir("ERRO", e?.stack ?? e); process.exit(1); });
