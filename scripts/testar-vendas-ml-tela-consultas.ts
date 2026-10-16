/**
 * CDS V2 — Vendas A3.4 (P1-1..P1-4): consultas do Mercado Livre na tela de Vendas.
 *
 *   P1-1  resposta de consulta substituída (loja/período/visão/"Carregar mais") nunca é aplicada
 *   P1-2  dono sem conta ML: a seção ML some (não é erro de provider); erro verdadeiro de conta conectada continua
 *   P1-3  o ML (tabela + financeiro live) não segura o loading da página nem a Shopee
 *   P1-4  troca de data lê UMA vez; filtro local (status/cadastro/SKU) não reconsulta o ML
 *
 * Controle puro (app/(app)/vendas/ml-consultas.ts) exercitado em cenários de corrida; rotas REAIS com Supabase em
 * memória (sem rede); a ligação na página conferida no fonte (o padrão das suítes de tela deste repositório).
 *
 * Uso: npx tsx scripts/testar-vendas-ml-tela-consultas.ts
 */
import "./_server-only-inerte";
import Module from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let ok = 0, falhou = 0;
let fila: Promise<void> = Promise.resolve();
const imprimir = console.log.bind(console);
setTimeout(() => { imprimir("ERRO FATAL: suíte excedeu 3 min"); process.exit(1); }, 3 * 60_000).unref();
function t(nome: string, fn: () => void | Promise<void>) {
  fila = fila.then(async () => {
    try { await fn(); ok++; imprimir(`  PASS  ${nome}`); }
    catch (e: any) { console.log = imprimir; falhou++; imprimir(`  FALHA ${nome} -> ${e?.message ?? e}`); }
  });
}
function secao(s: string) { fila = fila.then(() => { imprimir(s); }); }
function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://placeholder-de-teste.invalid";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "chave-de-teste-invalida";
process.env.SUPABASE_SERVICE_ROLE_KEY = "chave-de-teste-invalida";
process.env.SESSION_SECRET = "segredo-de-teste-com-mais-de-32-bytes-000000";
process.env.ML_CLIENT_ID = "ficticio";
process.env.ML_CLIENT_SECRET = "ficticio";
delete process.env.ENABLE_CANONICAL_SALES_SYNC;

const U = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SHOPEE = "33333333-3333-4333-8333-333333333333";

// ── Supabase em memória (só leitura; escrita é falha) ───────────────────────
let db: Record<string, Record<string, any>[]> = {};
function clienteFalso() {
  return {
    rpc: async () => ({ data: null, error: { message: "rpc_indisponivel_no_teste" } }),
    from(tabela: string) {
      const st: any = { filtros: [] as [string, string, any][], unico: false, ini: 0, fim: Infinity };
      const casa = (r: any) => st.filtros.every(([k, col, v]: [string, string, any]) =>
        k === "eq" ? String(r[col]) === String(v) : k === "in" ? (v as any[]).map(String).includes(String(r[col])) : k === "is" ? (r[col] ?? null) === v : true);
      const exec = () => { const out = (db[tabela] ?? []).filter(casa).slice(st.ini, st.fim); return st.unico ? { data: out[0] ?? null, error: null } : { data: out, error: null }; };
      const b: any = new Proxy({}, { get(_a, p: string) {
        if (p === "then") return (res: any, rej: any) => Promise.resolve().then(exec).then(res, rej);
        if (p === "maybeSingle" || p === "single") return async () => { st.unico = true; return exec(); };
        return (...a: any[]) => {
          if (["insert", "update", "upsert", "delete"].includes(p)) throw new Error(`escrita proibida: ${p} ${tabela}`);
          if (["eq", "in", "is"].includes(p)) st.filtros.push([p, a[0], a[1]]);
          if (p === "range") { st.ini = a[0]; st.fim = a[1] + 1; }
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
let chamadasProvider = 0;
globalThis.fetch = (async (url: any) => { chamadasProvider++; throw new Error(`rede proibida: ${String(url).slice(0, 60)}`); }) as any;

async function principal() {
  const C = await import("../app/(app)/vendas/ml-consultas");
  const auth = await import("../lib/autenticacao");
  const rotaMetricas = await import("../app/api/ml/vendas/metricas/route");
  const rotaPedidos = await import("../app/api/ml/vendas/pedidos/route");
  const G2 = await import("./_guard-v2");
  const cab = { cookie: `cds_session=${(await auth.emitirTokenSessao(U)).token}` };
  const pg = readFileSync(join(process.cwd(), "app/(app)/vendas/page.tsx"), "utf8").replace(/\r\n/g, "\n");
  const semComent = pg.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const corpo = (nome: string) => { const i = semComent.indexOf(`const ${nome} = useCallback(`); assert(i >= 0, `${nome} ausente`); return semComent.slice(i, semComent.indexOf("}, [", i)); };
  const tab = corpo("lerTabelaML"), met = corpo("lerMetricasML");
  const kTab = (loja: string, de: string, ate: string, v: "fechamento" | "pago" = "pago") => C.chaveTabelaML(loja, de, ate, v);

  secao("\n[P1-1. corrida: resposta de consulta substituída nunca é aplicada]");
  t("1. troca rápida de PERÍODO com a 1ª consulta pendente: a resposta antiga é descartada; só a nova vale", () => {
    const ctl = C.criarControleConsultasML();
    const a = ctl.iniciar(kTab("L1", "2026-10-01", "2026-10-07"))!;
    const b = ctl.iniciar(kTab("L1", "2026-09-01", "2026-09-30"))!;
    assert(a && b && !ctl.vigente(a) && ctl.vigente(b) && b.novaChave, JSON.stringify({ a, b }));
  });
  t("1b. troca de LOJA e de VISÃO também abrem consulta nova (resposta da anterior descartada)", () => {
    const ctl = C.criarControleConsultasML();
    const a = ctl.iniciar(kTab("L1", "2026-10-01", "2026-10-07"))!;
    const b = ctl.iniciar(kTab("L2", "2026-10-01", "2026-10-07"))!;
    const c = ctl.iniciar(kTab("L2", "2026-10-01", "2026-10-07", "fechamento"))!;
    assert(b && c && !ctl.vigente(a) && !ctl.vigente(b) && ctl.vigente(c), "loja/visão não isolam a consulta");
    ctl.invalidar();
    assert(!ctl.vigente(c) && ctl.iniciar(kTab("L2", "2026-10-01", "2026-10-07", "fechamento")) !== null, "invalidar (troca/recusa de loja) não derruba o pendente");
  });
  t("1c. ida e volta (A → B → A) com A antigo pendente: a resposta do PRIMEIRO A não vale para o segundo A", () => {
    const ctl = C.criarControleConsultasML();
    const a1 = ctl.iniciar(kTab("L1", "2026-10-01", "2026-10-07"))!;
    ctl.iniciar(kTab("L1", "2026-09-01", "2026-09-30"));
    const a2 = ctl.iniciar(kTab("L1", "2026-10-01", "2026-10-07"))!;
    assert(!ctl.vigente(a1) && ctl.vigente(a2), "mesma chave, geração antiga aplicada");
  });
  t("1d. página: a checagem de consulta vigente vem ANTES de qualquer mudança de estado (linhas, loading, erro, métricas)", () => {
    const iVig = tab.indexOf('if (!ctlTabelaML.vigente(bilhete)) return "IGNORADA";'), iFetch = tab.indexOf("await fetch(");
    const depois = tab.slice(iVig);
    assert(iVig > iFetch && /setMlCarregando\(false\)/.test(depois) && !/setMlCarregando\(false\)/.test(tab.slice(iFetch, iVig)) && !/setMlProvider\(/.test(tab.slice(iFetch, iVig)), "tabela aplica estado antes de conferir a consulta");
    const iVigM = met.indexOf("if (!ctlMetricasML.vigente(bilhete)) return;"), iFetchM = met.indexOf("await fetch(");
    assert(iVigM > iFetchM && !/setMlMetricas\(/.test(met.slice(iFetchM, iVigM)) && /setMlMetricas\(r === "OK"/.test(met.slice(iVigM)), "métricas aplicadas antes de conferir a consulta");
    assert(/if \(bilhete\.novaChave\) setMlProvider\(null\);/.test(tab) && /if \(bilhete\.novaChave\) setMlMetricas\(null\);/.test(met), "dados de outro período continuam exibidos sob o filtro novo");
  });
  t("2. 'Carregar mais' pendente durante troca de filtro: a página extra é descartada (não se mistura ao período novo)", () => {
    const ctl = C.criarControleConsultasML();
    ctl.iniciar(kTab("L1", "2026-10-01", "2026-10-07"));
    const mais = ctl.vigenteAgora();                       // "Carregar mais" da consulta vigente
    assert(ctl.vigente(mais), "continuação da consulta vigente rejeitada");
    const nova = ctl.iniciar(kTab("L1", "2026-09-01", "2026-09-30"))!;
    assert(!ctl.vigente(mais) && nova.novaChave, "página extra da consulta antiga aplicada no período novo");
    assert(/const bilhete = cursor \? ctlTabelaML\.vigenteAgora\(\) : ctlTabelaML\.iniciar\(chaveTabelaML\(loja, from, to, visao\), forcar\);/.test(tab), "'Carregar mais' sem o bilhete da consulta vigente");
  });

  secao("\n[P1-2. dono sem conta ML; erro verdadeiro continua visível]");
  t("3. só Shopee (Todos): as rotas ML respondem semConexao → SEM_CONTA → a seção ML some (sem 'indisponível' nem 'Tentar de novo')", async () => {
    db = { lojas: [{ id: SHOPEE, user_id: U, marketplace: "Shopee", ativo: true, nickname: "SP", shop_id: "1", access_token: "<S>", refresh_token: "<R>", token_expires_at: new Date(Date.now() + 3600_000).toISOString() }] };
    const silenciar = () => { console.log = () => {}; console.error = () => {}; };
    silenciar();
    let m: any, p: any;
    try {
      const rm = await rotaMetricas.GET(new Request("https://x.test/api/ml/vendas/metricas?de=2026-10-01&ate=2026-10-07", { headers: cab }));
      const rp = await rotaPedidos.GET(new Request("https://x.test/api/ml/vendas/pedidos?de=2026-10-01&ate=2026-10-07&visao=pago", { headers: cab }));
      m = { ok: rm.ok, corpo: await rm.json() }; p = { ok: rp.ok, corpo: await rp.json() };
    } finally { console.log = imprimir; }
    assert(m.corpo.semConexao === true && p.corpo.semConexao === true && chamadasProvider === 0, JSON.stringify({ m: m.corpo, p: p.corpo }));
    assert(C.classificarRespostaML(m.ok, m.corpo, (c) => !!c.estado) === "SEM_CONTA" && C.classificarRespostaML(p.ok, p.corpo, (c) => Array.isArray(c.linhas)) === "SEM_CONTA", "semConexao classificado como falha");
    assert(/setMlMetricas\(r === "OK" \? \(d as MetricasMLTela\) : r === "SEM_CONTA" \? null : METRICAS_ML_INDISPONIVEIS\);/.test(met), "métricas: SEM_CONTA não esconde a seção");
    assert(/if \(r === "SEM_CONTA"\) \{ setMlProvider\(null\); return "SEM_CONTA"; \}/.test(tab), "tabela: SEM_CONTA vira erro de provider");
    assert(/\{!loading && mlMetricas && lojaAtiva !== "Shopee" && \(/.test(pg) && /lojaAtiva !== "Shopee" && mlProvider && \(mlProvider\.cursor \|\| mlProvider\.erro\)/.test(pg), "seção ML renderizada sem estado");
  });
  t("4. ML conectado com falha VERDADEIRA continua visível: FALHA → 'indisponíveis' / aviso + 'Tentar de novo' (forçado)", () => {
    assert(C.classificarRespostaML(false, { erro: "indisponivel", linhas: [] }, (c) => Array.isArray(c.linhas)) === "FALHA", "502 do provider escondido");
    assert(C.classificarRespostaML(false, { erro: "Não foi possível carregar as métricas do Mercado Livre." }, (c) => !!c.estado) === "FALHA", "500 das métricas escondido");
    assert(C.classificarRespostaML(true, null, (c) => !!c) === "FALHA" && C.classificarRespostaML(true, { linhas: [] }, (c) => Array.isArray(c.linhas)) === "OK", "classificação");
    assert(C.classificarRespostaML(false, { codigo: "ML_STORE_SELECTION_REQUIRED" }, () => true) === "RECUSA_LOJA" && C.classificarRespostaML(false, { codigo: "LOJA_ML_INVALIDA" }, () => true) === "RECUSA_LOJA", "recusa de loja");
    assert(/: METRICAS_ML_INDISPONIVEIS\);/.test(met) && /\{ linhas: \[\], cursor: null, carregandoMais: false, erro: true \}/.test(tab), "falha real não chega à tela");
    assert(/mlProvider\.cursor \? lerTabelaML\(dateFrom, dateTo, mlProvider\.cursor\) : lerTabelaML\(dateFrom, dateTo, null, true\)/.test(pg), "'Tentar de novo' não força uma consulta nova");
  });

  secao("\n[P1-3. loading independente]");
  t("5. o ML corre por fora do loading global: a Shopee e a página não esperam a tabela + financeiro do ML", () => {
    const i = semComent.indexOf("const refetchTudo = useCallback(");
    const r = semComent.slice(i, semComent.indexOf("}, [lerMarketplace,", i));
    const iML = r.indexOf('const pML = lerML ? lerMarketplace("ML", from, to, tags, filtros) : Promise.resolve(null);');
    const iShopee = r.indexOf('await lerMarketplace("Shopee", from, to, tags, filtros)');
    const iLoad = r.indexOf("setLoading(false);"), iAwaitML = r.indexOf("await pML");
    assert(iML >= 0 && iShopee > iML && iLoad > iShopee && iAwaitML > iLoad, `ordem: ml=${iML} shopee=${iShopee} loading=${iLoad} awaitML=${iAwaitML}`);
    assert(!/Promise\.all\(\[\s*lerML/.test(r), "o loading global ainda espera o ML");
    assert(/\{!loading && mlCarregando && lojaAtiva !== "Shopee" && \(/.test(pg) && /filteredRows\.length === 0 && !\(mlCarregando && lojaAtiva !== "Shopee"\) &&/.test(pg), "ML carregando sem aviso próprio (ou 'nenhuma venda' enquanto carrega)");
    assert(/else \{ if \(bilhete\.novaChave\) setMlProvider\(null\); setMlCarregando\(true\); \}/.test(tab), "loading do ML não ligado na 1ª página");
  });

  secao("\n[P1-4. sem leitura duplicada; filtro local não reconsulta]");
  t("6. troca de data: o seletor só muda o estado (a leitura vem do efeito de período UMA vez); a mesma consulta repetida não reconsulta", () => {
    assert(/onChange=\{\(f, t\) => \{ setDateFrom\(f\); setDateTo\(t\); \}\}/.test(semComent), "seletor de data ainda chama refetchTudo além do efeito");
    assert(/\}, \[dateFrom, dateTo, lojaAtiva, dateField, lojasMLCarregadas, lojaMLSel\]\);/.test(semComent), "efeito de período mudou");
    const ctl = C.criarControleConsultasML();
    assert(ctl.iniciar(kTab("L1", "2026-10-01", "2026-10-07")) !== null && ctl.iniciar(kTab("L1", "2026-10-01", "2026-10-07")) === null, "a mesma consulta é refeita");
    assert(/if \(!force && shopeeEmVoo\.current\?\.url === url\) return shopeeEmVoo\.current\.promessa;/.test(semComent), "leitura idêntica da Shopee em voo repetida");
  });
  t("7. filtros locais (status, cadastro, SKU) não reconsultam o ML: a chave é só loja + período (+ visão) e o fetch vem DEPOIS do bilhete", () => {
    assert(C.chaveTabelaML("L1", "2026-10-01", "2026-10-07", "pago") === "L1|2026-10-01|2026-10-07|pago" && C.chaveMetricasML("L1", "2026-10-01", "2026-10-07") === "L1|2026-10-01|2026-10-07", "chave inclui algo além de loja/período/visão");
    const ctl = C.criarControleConsultasML();
    const k = kTab("L1", "2026-10-01", "2026-10-07");
    ctl.iniciar(k);
    for (let i = 0; i < 5; i++) assert(ctl.iniciar(k) === null, "clique de filtro reconsultou");
    assert(ctl.iniciar(k, true) !== null, "Sincronizar/Tentar de novo (forçar) não abriu consulta nova");
    assert(tab.indexOf('if (!bilhete) return "IGNORADA";') < tab.indexOf("await fetch(") && met.indexOf("if (!bilhete) return;") < met.indexOf("await fetch("), "o provider é chamado antes do dedupe");
    assert(/const \[, t\] = await Promise\.all\(\[lerMetricasML\(from, to, force\), lerTabelaML\(from, to, null, force\)\]\);/.test(semComent), "Sincronizar não força a consulta do ML");
    assert(/if \(mkt === "ML"\) \{ lerMetricasML\(dateFrom, dateTo, false, true\); lerTabelaML\(dateFrom, dateTo, null, true\); \}/.test(semComent), "job concluído não relê o ML (dedupe bloqueou a releitura)");
  });
  t("8. guards V2 (loja explícita, canônico/provider, financeiro) seguem limpos", () => {
    const v = [...G2.lojaMLVendasNaoExplicita(), ...G2.mlVendasForaDoCanonico(), ...G2.financeiroMLNaoReal()];
    assert(v.length === 0, v.join(" | "));
  });

  await fila;
  imprimir(`\n${falhou === 0 ? "✓" : "✗"} VENDAS-ML-TELA-CONSULTAS — ${ok} passaram, ${falhou} falharam`);
  process.exit(falhou === 0 ? 0 : 1);
}
principal().catch((e) => { console.log = imprimir; imprimir(`ERRO FATAL: ${e?.stack ?? e}`); process.exit(1); });
