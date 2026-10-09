/**
 * Suite do OAuth Shopee MULTI-APP + estado obrigatorio (Shopee multi-app V2).
 *
 * Executa as rotas REAIS (/api/auth/shopee, /api/auth/shopee/callback,
 * /api/auth/shopee/apps) com:
 *   - sessao real (emitirTokenSessao) e estado real (lib/shopee-oauth-estado);
 *   - Supabase trocado por uma tabela `lojas` em memoria que reproduz os
 *     filtros da capability registrarLojaShopeeOAuth;
 *   - fetch falso da Shopee que CONFERE a assinatura com a chave do app
 *     esperado (qualquer URL nao prevista lanca).
 * Nenhum segredo real: chaves de teste ficticias.
 *
 *   npx tsx scripts/testar-shopee-multi-app.ts
 */
import "./_server-only-inerte";
import Module from "node:module";
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// CDS GUARD V2 (Fase 0B): invariantes estruturais + zonas protegidas no lugar da cerca "arquivo nao mudou desde a base"
import { invariantesV2 } from "./_guard-v2";

const RAIZ = join(__dirname, "..");
const BASE = "eca183a";
let passou = 0, falhou = 0;
let fila: Promise<void> = Promise.resolve();
function t(nome: string, fn: () => void | Promise<void>) {
  fila = fila.then(async () => {
    try { await fn(); passou++; console.log(`  PASS  ${nome}`); }
    catch (e: any) { falhou++; console.log(`  FALHA ${nome} -> ${e?.message ?? e}`); }
  });
}
function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://placeholder-de-teste.invalid";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "chave-de-teste-invalida";
process.env.SUPABASE_SERVICE_ROLE_KEY = "chave-de-teste-invalida";
process.env.SESSION_SECRET = "segredo-de-teste-com-mais-de-32-bytes-000000";
process.env.SHOPEE_BASE_URL = "https://shopee.teste.invalid";
process.env.SHOPEE_REDIRECT_URI = "https://www.calculadoradossellers.com.br/api/auth/shopee/callback";
const APP = {
  default: { id: "1000001", key: "chave-ficticia-DEFAULT-0123456789abcdef" },
  rd: { id: "2000002", key: "chave-ficticia-RD-fedcba9876543210" },
};
const configurarApps = (rd: boolean) => {
  process.env.SHOPEE_PARTNER_ID = APP.default.id; process.env.SHOPEE_PARTNER_KEY = APP.default.key;
  if (rd) { process.env.SHOPEE_RD_PARTNER_ID = APP.rd.id; process.env.SHOPEE_RD_PARTNER_KEY = APP.rd.key; }
  else { delete process.env.SHOPEE_RD_PARTNER_ID; delete process.env.SHOPEE_RD_PARTNER_KEY; }
};
configurarApps(true);

const UID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SHOP_X = "880001";

// ── lojas em memoria (filtros da capability) ─────────────────────────
type Loja = Record<string, any>;
let lojas: Loja[] = [];
let seq = 0;
function clienteFalso() {
  return { from(tabela: string) {
    if (tabela !== "lojas") throw new Error(`tabela inesperada: ${tabela}`);
    const st: any = { op: "select", payload: null, filtros: [] as [string, any][] };
    const casa = (l: Loja) => st.filtros.every(([c, v]: [string, any]) => String(l[c]) === String(v));
    const exec = () => {
      if (st.op === "insert") { const nova = { id: `loja-${++seq}`, ...st.payload }; lojas.push(nova); return { data: [{ id: nova.id }], error: null }; }
      if (st.op === "update") { const alvo = lojas.filter(casa); for (const l of alvo) Object.assign(l, st.payload); return { data: alvo.map((l) => ({ id: l.id })), error: null }; }
      return { data: lojas.filter(casa).map((l) => ({ id: l.id })), error: null };
    };
    const b: any = {
      select: () => b, insert: (p: any) => { st.op = "insert"; st.payload = p; return b; }, update: (p: any) => { st.op = "update"; st.payload = p; return b; },
      eq: (c: string, v: any) => { st.filtros.push([c, v]); return b; },
      then: (ok: any, err: any) => Promise.resolve().then(exec).then(ok, err),
    };
    return b;
  } };
}
const requireOriginal = (Module as any).prototype.require;
(Module as any).prototype.require = function (id: string) {
  if (id === "@supabase/supabase-js") return { createClient: () => clienteFalso() };
  return requireOriginal.apply(this, arguments as any);
};

// ── Shopee falsa: confere a assinatura com a chave do app esperado ───
let appEsperado: keyof typeof APP = "default";
let chamadas: { path: string; partnerId: string; assinaturaOk: boolean }[] = [];
const sign = (key: string, base: string) => createHmac("sha256", key).update(base).digest("hex");
globalThis.fetch = (async (url: any, init?: any) => {
  const u = new URL(String(url));
  const pid = u.searchParams.get("partner_id") ?? "";
  const ts = u.searchParams.get("timestamp") ?? "";
  const k = APP[appEsperado].key;
  if (u.pathname === "/api/v2/auth/token/get") {
    const corpo = JSON.parse(String(init?.body ?? "{}"));
    chamadas.push({ path: u.pathname, partnerId: pid, assinaturaOk: u.searchParams.get("sign") === sign(k, `${pid}${u.pathname}${ts}`) && String(corpo.partner_id) === pid });
    return { ok: true, status: 200, json: async () => ({ access_token: "<access-teste>", refresh_token: "<refresh-teste>", expire_in: 14400 }) } as any;
  }
  if (u.pathname === "/api/v2/shop/get_shop_info") {
    const base = `${pid}${u.pathname}${ts}${u.searchParams.get("access_token")}${u.searchParams.get("shop_id")}`;
    chamadas.push({ path: u.pathname, partnerId: pid, assinaturaOk: u.searchParams.get("sign") === sign(k, base) });
    return { ok: true, status: 200, json: async () => ({ response: { shop_name: "LOJA-TESTE" } }) } as any;
  }
  if (u.pathname === "/api/v2/auth/access_token/get") {
    chamadas.push({ path: u.pathname, partnerId: pid, assinaturaOk: u.searchParams.get("sign") === sign(k, `${pid}${u.pathname}${ts}`) });
    return { ok: true, status: 200, json: async () => ({ access_token: "<access-renovado>", refresh_token: "<refresh-renovado>", expire_in: 14400 }) } as any;
  }
  throw new Error(`teste tentou acessar a rede: ${u.pathname}`);
}) as any;

let logs: string[] = [];
const logOriginal = { log: console.log, error: console.error, warn: console.warn };
function capturar() { logs = []; for (const k of ["error", "warn"] as const) (console as any)[k] = (...a: any[]) => { logs.push(a.map(String).join(" ")); }; }
function soltar() { console.error = logOriginal.error; console.warn = logOriginal.warn; }

async function principal() {
  const auth = await import("../lib/autenticacao");
  const est = await import("../lib/shopee-oauth-estado");
  const reg = await import("../lib/shopee-apps");
  const inicio = await import("../app/api/auth/shopee/route");
  const callback = await import("../app/api/auth/shopee/callback/route");
  const apps = await import("../app/api/auth/shopee/apps/route");
  const sessaoA = (await auth.emitirTokenSessao(UID_A)).token;
  const sessaoB = (await auth.emitirTokenSessao(UID_B)).token;
  const req = (caminho: string, cookies: Record<string, string>) =>
    new Request(`https://www.calculadoradossellers.com.br${caminho}`, { headers: { cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ") } });
  const local = (r: Response) => r.headers.get("location") ?? "";
  const cookieEstado = (r: any) => r.cookies?.get?.(est.NOME_COOKIE_ESTADO_SHOPEE);
  const erroCfg = (r: Response) => new URL(local(r), "https://x.invalid").searchParams.get("erro");
  /** Inicio real → estado do cookie emitido. */
  const iniciar = async (sessao: string, query = "") => inicio.GET(req(`/api/auth/shopee${query}`, { cds_session: sessao }));
  const fluxo = async (sessao: string, app: keyof typeof APP, shop = SHOP_X, extraQuery = "") => {
    const r1: any = await iniciar(sessao, app === "default" ? "" : `?app=${app}`);
    const estado = cookieEstado(r1)?.value;
    assert(estado, `inicio ${app} sem estado (${r1.status})`);
    appEsperado = app;
    return callback.GET(req(`/api/auth/shopee/callback?code=CODE-1&shop_id=${shop}${extraQuery}`, { cds_session: sessao, [est.NOME_COOKIE_ESTADO_SHOPEE]: estado }));
  };
  const reiniciar = () => { lojas = []; chamadas = []; configurarApps(true); };

  console.log("\n[A-D. inicio: app pela allowlist, sem fallback]");
  t("A. sem ?app → default: auth_partner assinado com a chave DEFAULT; estado app=default", async () => {
    reiniciar();
    const r: any = await iniciar(sessaoA);
    const u = new URL(local(r));
    assert(r.status === 307 || r.status === 302, `status ${r.status}`);
    assert(u.searchParams.get("partner_id") === APP.default.id && u.searchParams.get("sign") === sign(APP.default.key, `${APP.default.id}${u.pathname}${u.searchParams.get("timestamp")}`), "assinatura default");
    const e = await est.verificarEstadoShopee(cookieEstado(r)?.value, { segredo: process.env.SESSION_SECRET!, agoraSegundos: auth.agoraEmSegundos() });
    assert(e?.app === "default" && e.uid === UID_A, JSON.stringify(e));
    const c = cookieEstado(r);
    assert(c.httpOnly === true && c.sameSite === "lax" && c.path === "/api/auth/shopee" && c.maxAge === 600, JSON.stringify(c));
  });
  t("B. ?app=rd → assinado com a chave RD; estado app=rd; redirect = o MESMO callback", async () => {
    reiniciar();
    const r: any = await iniciar(sessaoA, "?app=rd");
    const u = new URL(local(r));
    assert(u.searchParams.get("partner_id") === APP.rd.id && u.searchParams.get("sign") === sign(APP.rd.key, `${APP.rd.id}${u.pathname}${u.searchParams.get("timestamp")}`), "assinatura rd");
    assert(u.searchParams.get("redirect") === "https://www.calculadoradossellers.com.br/api/auth/shopee/callback", u.searchParams.get("redirect")!);
    const e = await est.verificarEstadoShopee(cookieEstado(r)?.value, { segredo: process.env.SESSION_SECRET!, agoraSegundos: auth.agoraEmSegundos() });
    assert(e?.app === "rd", JSON.stringify(e));
  });
  t("C. app invalido → 400 (nenhum estado, nenhum redirect)", async () => {
    for (const q of ["?app=outro", "?app=DEFAULT", "?app=", "?app=rd%20", "?app=__proto__", "?app=constructor"]) {
      const r: any = await iniciar(sessaoA, q);
      assert(r.status === 400 && !cookieEstado(r)?.value, `${q} → ${r.status}`);
    }
  });
  t("D. rd NAO configurado → erro controlado (503), NUNCA cai no default", async () => {
    reiniciar(); configurarApps(false);
    const r: any = await iniciar(sessaoA, "?app=rd");
    assert(r.status === 503 && !cookieEstado(r)?.value && !local(r).includes(APP.default.id), `${r.status} ${local(r)}`);
    process.env.SHOPEE_RD_PARTNER_ID = "abc"; process.env.SHOPEE_RD_PARTNER_KEY = APP.rd.key;
    const r2: any = await iniciar(sessaoA, "?app=rd");
    assert(r2.status === 503, `partner_id nao numerico aceito: ${r2.status}`);
    configurarApps(true);
  });
  t("D2. sem sessao → login (inicio deixou de ser efetivamente publico)", async () => {
    const r: any = await inicio.GET(new Request("https://www.calculadoradossellers.com.br/api/auth/shopee?app=rd"));
    assert(local(r).includes("/login") && !cookieEstado(r)?.value, local(r));
  });

  console.log("\n[E-J. callback: estado obrigatorio, app so do estado]");
  t("E. callback SEM estado → rejeitado, nenhuma troca de token, nada gravado", async () => {
    reiniciar();
    const r = await callback.GET(req(`/api/auth/shopee/callback?code=C&shop_id=${SHOP_X}`, { cds_session: sessaoA }));
    assert(erroCfg(r) === "shopee_estado" && chamadas.length === 0 && lojas.length === 0, `${local(r)} ${chamadas.length}`);
  });
  t("F. estado adulterado (payload ou assinatura) → rejeitado", async () => {
    reiniciar();
    const r1: any = await iniciar(sessaoA, "?app=rd");
    const v: string = cookieEstado(r1).value;
    const [p, s] = v.split(".");
    const forjado = JSON.parse(Buffer.from(p.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString()); forjado.app = "default";
    const p2 = Buffer.from(JSON.stringify(forjado)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    for (const ruim of [`${p2}.${s}`, `${p}.${s.slice(0, -2)}AA`, `${p}`, `x.y.z`, "lixo"]) {
      const r = await callback.GET(req(`/api/auth/shopee/callback?code=C&shop_id=${SHOP_X}`, { cds_session: sessaoA, [est.NOME_COOKIE_ESTADO_SHOPEE]: ruim }));
      assert(erroCfg(r) === "shopee_estado", `aceitou ${ruim.slice(0, 20)}`);
    }
    assert(chamadas.length === 0 && lojas.length === 0, "trocou token com estado ruim");
  });
  t("G. estado expirado → rejeitado; TTL acima do teto nunca e emitido/aceito", async () => {
    reiniciar();
    const velho = await est.emitirEstadoShopee(UID_A, "default", { segredo: process.env.SESSION_SECRET!, agoraSegundos: auth.agoraEmSegundos() - 700 });
    const r = await callback.GET(req(`/api/auth/shopee/callback?code=C&shop_id=${SHOP_X}`, { cds_session: sessaoA, [est.NOME_COOKIE_ESTADO_SHOPEE]: velho }));
    assert(erroCfg(r) === "shopee_estado" && chamadas.length === 0, local(r));
    let lancou = false; try { await est.emitirEstadoShopee(UID_A, "default", { segredo: process.env.SESSION_SECRET!, agoraSegundos: 1_800_000_000, ttlSegundos: 3600 }); } catch { lancou = true; }
    assert(lancou, "emitiu estado com TTL > 600");
  });
  t("H. uid do estado ≠ sessao → rejeitado (estado de A apresentado na sessao de B)", async () => {
    reiniciar();
    const r1: any = await iniciar(sessaoA, "?app=rd");
    const r = await callback.GET(req(`/api/auth/shopee/callback?code=C&shop_id=${SHOP_X}`, { cds_session: sessaoB, [est.NOME_COOKIE_ESTADO_SHOPEE]: cookieEstado(r1).value }));
    assert(erroCfg(r) === "shopee_estado" && chamadas.length === 0 && lojas.length === 0, local(r));
  });
  t("I. STATE_CLEARED_ON_CALLBACK: o callback LIMPA o estado em qualquer desfecho; sem ele, a reapresentacao e rejeitada", async () => {
    reiniciar();
    const ok: any = await fluxo(sessaoA, "rd");
    assert(local(ok).includes("ok=shopee"), local(ok));
    const limpo = cookieEstado(ok);
    assert(limpo && limpo.value === "" && limpo.maxAge === 0 && limpo.path === "/api/auth/shopee", JSON.stringify(limpo));
    const recusa: any = await callback.GET(req(`/api/auth/shopee/callback?code=C&shop_id=${SHOP_X}`, { cds_session: sessaoA }));
    assert(cookieEstado(recusa)?.maxAge === 0 && erroCfg(recusa) === "shopee_estado", "recusa nao limpou / replay aceito");
  });
  t("J. ?app=default (ou partner_* na query) no callback NAO muda o app: vale o do estado (rd)", async () => {
    reiniciar();
    const r = await fluxo(sessaoA, "rd", SHOP_X, `&app=default&partner_id=${APP.default.id}&partner_key=x`);
    assert(local(r).includes("ok=shopee") && chamadas.length === 2 && chamadas.every((c) => c.partnerId === APP.rd.id && c.assinaturaOk), JSON.stringify(chamadas));
    assert(lojas[0].partner_id === APP.rd.id && lojas[0].partner_key === APP.rd.key, "loja gravada com app errado");
  });
  t("J2. estado rd mas rd desconfigurado no callback → erro, nenhuma troca, nenhum fallback", async () => {
    reiniciar();
    const r1: any = await iniciar(sessaoA, "?app=rd");
    configurarApps(false);
    const r = await callback.GET(req(`/api/auth/shopee/callback?code=C&shop_id=${SHOP_X}`, { cds_session: sessaoA, [est.NOME_COOKIE_ESTADO_SHOPEE]: cookieEstado(r1).value }));
    assert(erroCfg(r) === "shopee_sem_credenciais" && chamadas.length === 0 && lojas.length === 0, local(r));
    configurarApps(true);
  });

  console.log("\n[K-O. segredos e parametros]");
  t("K/L. partner_key nunca na resposta, na URL de redirect nem no cookie (inicio, callback, apps)", async () => {
    reiniciar();
    const r1: any = await iniciar(sessaoA, "?app=rd");
    const r2: any = await fluxo(sessaoA, "rd");
    const r3 = await apps.GET(req("/api/auth/shopee/apps", { cds_session: sessaoA }));
    const corpo3 = await r3.text();
    const tudo = [local(r1), local(r2), JSON.stringify(r1.headers.get("set-cookie")), JSON.stringify(r2.headers.get("set-cookie")), cookieEstado(r1)?.value ?? "", corpo3].join("\n");
    for (const k of [APP.default.key, APP.rd.key]) assert(!tudo.includes(k), "partner_key exposta");
  });
  t("M. partner_key / tokens nunca em log (sucesso e falhas)", async () => {
    reiniciar(); capturar();
    try {
      await fluxo(sessaoA, "rd");
      await callback.GET(req(`/api/auth/shopee/callback?code=C&shop_id=${SHOP_X}`, { cds_session: sessaoA, [est.NOME_COOKIE_ESTADO_SHOPEE]: "lixo" }));
      configurarApps(false); await iniciar(sessaoA, "?app=rd"); configurarApps(true);
    } finally { soltar(); }
    const tudo = logs.join("\n");
    for (const s of [APP.default.key, APP.rd.key, "<access-teste>", "<refresh-teste>", process.env.SESSION_SECRET!]) assert(!tudo.includes(s), `segredo em log`);
  });
  t("M2. o estado (cookie) DECODIFICADO so tem {v, uid, app, nonce, iat, exp} — nenhum partner_id/partner_key/token", async () => {
    for (const app of ["", "?app=rd"]) {
      const r: any = await iniciar(sessaoA, app);
      const [payload] = String(cookieEstado(r).value).split(".");
      const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
      const obj = JSON.parse(json);
      assert(Object.keys(obj).sort().join() === "app,exp,iat,nonce,uid,v", json);
      for (const s of [APP.default.key, APP.rd.key, APP.default.id, APP.rd.id]) assert(!json.includes(s), "credencial no estado");
    }
  });
  t("N/O. partner_id / partner_key arbitrarios na query do inicio → 400 (nunca usados)", async () => {
    for (const q of [`?partner_id=999`, `?partner_key=abc`, `?app=rd&partner_id=999`, `?partnerKey=abc`]) {
      const r: any = await iniciar(sessaoA, q);
      assert(r.status === 400 && !cookieEstado(r)?.value, `${q} → ${r.status}`);
    }
  });
  t("apps: exige sessao; devolve SO {chave, rotulo, configurado}; rd some quando nao configurado", async () => {
    const anon = await apps.GET(new Request("https://www.calculadoradossellers.com.br/api/auth/shopee/apps"));
    assert(anon.status === 401, `${anon.status}`);
    const r = await apps.GET(req("/api/auth/shopee/apps", { cds_session: sessaoA }));
    const d = await r.json();
    assert(d.apps.length === 2 && d.apps.every((a: any) => Object.keys(a).sort().join() === "chave,configurado,rotulo"), JSON.stringify(d));
    assert(d.apps.find((a: any) => a.chave === "rd").configurado === true && !JSON.stringify(d).includes(APP.rd.id), "partner_id exposto");
    // o proprio registro publico tambem nao carrega credencial (defesa em profundidade alem da rota)
    assert(reg.listarAppsShopeePublicos().every((a) => Object.keys(a).sort().join() === "chave,configurado,rotulo"), "registro publico com campo extra");
    configurarApps(false);
    const d2 = await (await apps.GET(req("/api/auth/shopee/apps", { cds_session: sessaoA }))).json();
    assert(d2.apps.find((a: any) => a.chave === "rd").configurado === false, "rd configurado sem env");
    configurarApps(true);
  });

  console.log("\n[P. dono e reconexao]");
  t("P. A autoriza X → grava so em A; B autoriza X → linha propria de B, a de A INTACTA; nunca transfere dono", async () => {
    reiniciar();
    await fluxo(sessaoA, "default");
    const antesA = JSON.stringify(lojas[0]);
    await fluxo(sessaoB, "rd");
    const a = lojas.filter((l) => l.user_id === UID_A), b = lojas.filter((l) => l.user_id === UID_B);
    assert(a.length === 1 && b.length === 1 && JSON.stringify(a[0]) === antesA, JSON.stringify(lojas));
    assert(a[0].partner_id === APP.default.id && b[0].partner_id === APP.rd.id, "credencial cruzada entre donos");
  });
  t("P2. reconexao: mesmo dono + mesma shop por OUTRO app → a MESMA linha passa a guardar o app novo (sem duplicata)", async () => {
    reiniciar();
    await fluxo(sessaoA, "default");
    const id = lojas[0].id;
    await fluxo(sessaoA, "rd");
    assert(lojas.length === 1 && lojas[0].id === id && lojas[0].partner_id === APP.rd.id && lojas[0].partner_key === APP.rd.key && lojas[0].access_token === "<access-teste>", JSON.stringify(lojas));
  });

  console.log("\n[Q. depois do OAuth: tudo pela credencial DA LOJA]");
  t("Q. refresh assina com o partner da LOJA (rd), nao com a env global; resolverCredencialShopee passa loja.partner_*", async () => {
    reiniciar();
    const sa = await import("../lib/shopee-auth");
    appEsperado = "rd";
    const r = await sa.refreshShopeeToken(APP.rd.id, APP.rd.key, Number(SHOP_X), "<refresh-teste>");
    assert(r && chamadas.length === 1 && chamadas[0].partnerId === APP.rd.id && chamadas[0].assinaturaOk, JSON.stringify(chamadas));
    const src = readFileSync(join(RAIZ, "lib/shopee-auth.ts"), "utf8");
    assert(/refreshShopeeToken\(loja\.partner_id as string, loja\.partner_key as string/.test(src) && !/process\.env\.SHOPEE_PARTNER_(ID|KEY)/.test(src), "refresh deixou de usar a credencial da loja");
  });
  t("Q2. V2: pipeline Shopee sem selecao implicita (I3) e sem partner key no browser; credencial por loja provada por Q/Q3 e pelas suites multi-loja", () => {
    const errosV2 = invariantesV2(RAIZ);
    assert(errosV2.length === 0, `Q2: ${errosV2.join(" | ")}`);
    let noBrowser = "";
    try { noBrowser = execFileSync("git", ["grep", "-lE", "partner_key|SHOPEE_(RD_)?PARTNER_KEY|lib/shopee-apps[\"']", "--", "app/(app)", "components"], { cwd: RAIZ, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); }
    catch (e: any) { if (e.status !== 1) throw e; }
    assert(noBrowser.trim() === "", `partner key/registro de apps alcancando o browser: ${noBrowser}`);
  });
  t("Q3. env global so no registro: nenhuma rota/lib fora de lib/shopee-apps.ts le SHOPEE_PARTNER_*", () => {
    // git grep sai com 1 quando NAO ha ocorrencia — que e o esperado aqui
    let saida = "";
    try { saida = execFileSync("git", ["grep", "-l", "-E", "process\\.env\\.SHOPEE_(RD_)?PARTNER_(ID|KEY)", "--", "app", "lib", "components"], { cwd: RAIZ, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); }
    catch (e: any) { if (e.status !== 1) throw e; }
    const usos = saida.trim().split(/\r?\n/).filter(Boolean);
    const reg2 = readFileSync(join(RAIZ, "lib/shopee-apps.ts"), "utf8");
    assert(usos.length === 0 && /SHOPEE_RD_PARTNER_ID/.test(reg2) && /SHOPEE_PARTNER_KEY/.test(reg2), usos.join(", "));
    assert(reg.CHAVES_APP_SHOPEE.join() === "default,rd", "allowlist");
  });

  await fila;
  console.log(`\n${falhou === 0 ? "✓" : "✗"} SHOPEE-MULTI-APP — ${passou} passaram, ${falhou} falharam`);
  process.exit(falhou === 0 ? 0 : 1);
}
principal().catch((e) => { console.error("ERRO FATAL", e?.message ?? e); process.exit(1); });
