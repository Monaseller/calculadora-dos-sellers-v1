/**
 * Suite da UX "Gerenciar contas Shopee" (Shopee UX V4).
 *
 * Shopee e UM marketplace: um card unico abre um painel; toda nova conexao
 * Shopee comeca por ele. default / rd sao so apps OAuth internos.
 *
 *   - decisao (pura) em lib/shopee-conexao-ui.ts: 1 app → OAuth direto,
 *     2+ → escolher, falha/0 → mensagem controlada; so chave/rotulo/configurado;
 *   - estrutura da tela (inspecao de fonte): um card Shopee, nenhum card por
 *     app, painel com contas conectadas + "Adicionar nova loja", cancelar
 *     nao navega, Mercado Livre e "Minhas contas" intactos;
 *   - escopo: OAuth core, pipeline, Vendas, Dashboard e Meus Produtos
 *     byte-identicos a cdeb7af.
 *
 * Offline: sem rede, sem banco, sem OAuth real.
 *
 *   npx tsx scripts/testar-shopee-ux.ts
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decidirConexaoShopee, lerAppsShopee, MENSAGEM_APPS_INDISPONIVEIS, MENSAGEM_NENHUM_APP, urlConexaoShopee } from "../lib/shopee-conexao-ui";
// CDS GUARD V2 (Fase 0B): invariantes estruturais + zonas protegidas no lugar da cerca "arquivo nao mudou desde a base"
import { invariantesV2 } from "./_guard-v2";

const RAIZ = join(__dirname, "..");
const BASE = "cdeb7af";
let passou = 0, falhou = 0;
function t(nome: string, fn: () => void) {
  try { fn(); passou++; console.log(`  PASS  ${nome}`); }
  catch (e: any) { falhou++; console.log(`  FALHA ${nome} -> ${e?.message ?? e}`); }
}
function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const fonte = (rel: string) => readFileSync(join(RAIZ, rel), "utf8").replace(/\r\n/g, "\n");
/** Fonte sem comentarios — asserção de AUSÊNCIA nao pode casar com prosa. */
const codigo = (rel: string) => fonte(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const PAGINA = "app/(app)/configuracoes/page.tsx";
const pg = codigo(PAGINA);
const apps = (...a: [string, string, boolean][]) => ({ apps: a.map(([chave, rotulo, configurado]) => ({ chave, rotulo, configurado })) });

console.log("\n[A-C. um card Shopee, nenhum card por app, painel]");
t("A. exatamente UM card Shopee principal em 'Adicionar conta' (e o de ML continua)", () => {
  const secao = pg.slice(pg.indexOf("Adicionar conta</h2>"));
  assert((secao.match(/>Shopee<\/div>/g) ?? []).length === 1, "card Shopee duplicado ou ausente");
  assert((secao.match(/Adicionar conta Shopee/g) ?? []).length === 1 && (secao.match(/Adicionar conta ML/g) ?? []).length === 1, "botoes dos cards");
});
t("B. nenhum card separado por app (sem 'Shopee — R.D.' na tela, sem map de apps em cards, sem fetch na carga)", () => {
  assert(!/R\.D\./.test(pg) && !/appsShopeeExtras/.test(pg), "card/estado do app R.D. ainda na tela");
  assert(!/href=\{`\/api\/auth\/shopee\?app=/.test(pg) && !/href="\/api\/auth\/shopee/.test(pg), "link direto para OAuth Shopee fora do painel");
  assert(!/useEffect\(\(\) => \{\s*fetch\("\/api\/auth\/shopee\/apps"/.test(pg), "apps buscados ao carregar a pagina");
});
t("C. clicar no card Shopee abre o painel 'Gerenciar contas Shopee' (teclado incluso)", () => {
  assert(/onClick=\{abrirPainelShopee\}/.test(pg) && /e\.key === "Enter" \|\| e\.key === " "/.test(pg), "card nao abre o painel");
  assert(/\{painelShopee && \(/.test(pg) && /role="dialog"/.test(pg) && /Gerenciar contas Shopee/.test(pg), "painel ausente");
  assert(/\+ Adicionar nova loja Shopee/.test(pg) && /onClick=\{adicionarLojaShopee\}/.test(pg), "acao de adicionar ausente");
});

console.log("\n[D-J. decisao de conexao]");
t("D. 1 app configurado → OAuth DIRETO, sem seletor (default ou rd, o que estiver configurado)", () => {
  const d1 = decidirConexaoShopee(apps(["default", "Shopee", true], ["rd", "Shopee — R.D.", false]));
  assert(d1.tipo === "direto" && d1.url === "/api/auth/shopee?app=default", JSON.stringify(d1));
  const d2 = decidirConexaoShopee(apps(["default", "Shopee", false], ["rd", "Shopee — R.D.", true]));
  assert(d2.tipo === "direto" && d2.url === "/api/auth/shopee?app=rd", JSON.stringify(d2));
  assert(/if \(d\.tipo === "direto"\) \{ window\.location\.href = d\.url; return; \}/.test(pg), "tela nao segue o OAuth direto");
});
t("E. 2+ apps configurados → seletor 'Escolha como conectar esta loja Shopee' na ordem do servidor", () => {
  const d = decidirConexaoShopee(apps(["default", "Shopee", true], ["rd", "Shopee — R.D.", true]));
  assert(d.tipo === "escolher" && d.opcoes.map((o) => o.rotulo).join("|") === "Shopee|Shopee — R.D.", JSON.stringify(d));
  assert(/Escolha como conectar esta loja Shopee/.test(pg) && /etapaShopee\.opcoes\.map/.test(pg), "seletor ausente na tela");
});
t("F. default → /api/auth/shopee?app=default", () => {
  const d = decidirConexaoShopee(apps(["default", "Shopee", true], ["rd", "Shopee — R.D.", true]));
  assert(d.tipo === "escolher" && d.opcoes.find((o) => o.chave === "default")!.url === "/api/auth/shopee?app=default", JSON.stringify(d));
});
t("G. R.D. → EXATAMENTE /api/auth/shopee?app=rd (nunca default)", () => {
  const d = decidirConexaoShopee(apps(["default", "Shopee", true], ["rd", "Shopee — R.D.", true]));
  assert(d.tipo === "escolher" && d.opcoes.find((o) => o.chave === "rd")!.url === "/api/auth/shopee?app=rd", JSON.stringify(d));
  assert(/onClick=\{\(\) => \{ window\.location\.href = o\.url; \}\}/.test(pg), "botao do app nao usa a URL da opcao");
});
t("H. cancelar/fechar → nenhum OAuth (so fecha e volta ao inicio)", () => {
  assert(/const fecharPainelShopee = \(\) => \{ setPainelShopee\(false\); setEtapaShopee\(\{ tipo: "inicio" \}\); \};/.test(pg), "fechar faz mais que fechar");
  assert(/onClick=\{fecharPainelShopee\}[\s\S]{0,400}Cancelar/.test(pg), "botao Cancelar ausente");
  assert(/onClick=\{e => e\.stopPropagation\(\)\}/.test(pg), "clique dentro do painel fecharia o painel");
  const navegacoes = pg.match(/window\.location\.href = [^;]+;/g) ?? [];
  assert(navegacoes.sort().join("|") === ['window.location.href = "/api/auth/mercadolivre";', "window.location.href = d.url;", "window.location.href = o.url;"].sort().join("|"), navegacoes.join(" | "));
});
t("I. falha do endpoint (HTTP/rede/corpo invalido) ou 0 apps → mensagem controlada, nunca OAuth adivinhado", () => {
  for (const ruim of [null, undefined, {}, { apps: "x" }, "lixo", 42]) {
    const d = decidirConexaoShopee(ruim);
    assert(d.tipo === "erro" && d.mensagem === MENSAGEM_APPS_INDISPONIVEIS, JSON.stringify(ruim));
  }
  const zero = decidirConexaoShopee(apps(["default", "Shopee", false], ["rd", "Shopee — R.D.", false]));
  assert(zero.tipo === "erro" && zero.mensagem === MENSAGEM_NENHUM_APP, JSON.stringify(zero));
  assert(/r\.ok \? await r\.json\(\) : null/.test(pg) && /catch \{\s*setEtapaShopee\(\{ tipo: "erro", mensagem: MENSAGEM_APPS_INDISPONIVEIS \}\);/.test(pg), "tela nao trata falha");
  assert(/role="alert"/.test(pg), "mensagem de erro nao exibida");
});
t("J. so chave/rotulo/configurado sao usados; credencial na resposta e descartada e nunca vai a URL", () => {
  const vazado = { apps: [{ chave: "rd", rotulo: "Shopee — R.D.", configurado: true, partner_id: "2000002", partner_key: "segredo-ficticio", partnerKey: "segredo-ficticio" }] };
  const lidos = lerAppsShopee(vazado)!;
  assert(lidos.length === 1 && Object.keys(lidos[0]).sort().join() === "chave,configurado,rotulo", JSON.stringify(lidos));
  const d = decidirConexaoShopee(vazado);
  assert(d.tipo === "direto" && !JSON.stringify(d).includes("segredo") && !JSON.stringify(d).includes("2000002"), JSON.stringify(d));
  assert(lerAppsShopee({ apps: [{ chave: "../x", rotulo: "a", configurado: true }, { chave: "RD", rotulo: "a", configurado: true }] })!.length === 0, "chave fora do formato aceita");
  assert(urlConexaoShopee("rd") === "/api/auth/shopee?app=rd", "url");
  const ui = codigo("lib/shopee-conexao-ui.ts");
  assert(!/partner_?[iI]d|partner_?[kK]ey/.test(ui) && !/partner_?[iI]d|partner_?[kK]ey/.test(pg), "credencial referenciada na UI");
});

console.log("\n[K-M. o resto intacto]");
t("K. 'Minhas contas' intacta: cada loja continua listada (LojaCard), sem marcador de app", () => {
  const base = execFileSync("git", ["show", `${BASE}:${PAGINA}`], { cwd: RAIZ, encoding: "utf8" }).replace(/\r\n/g, "\n");
  const trecho = (s: string) => s.slice(s.indexOf("{/* ── Minhas contas ── */}"), s.indexOf("{/* ── Adicionar conta ── */}"));
  assert(trecho(base).length > 500 && trecho(base) === trecho(fonte(PAGINA)), "secao Minhas contas mudou");
  assert(/\{lojas\.filter\(l => l\.marketplace === "Shopee"\)\.map\(l => \(/.test(pg) && /\{l\.nickname \|\| l\.nome\}/.test(pg), "painel nao lista as contas Shopee existentes");
});
t("L. Mercado Livre intacto (card, conectarML e retorno OAuth ML)", () => {
  const base = execFileSync("git", ["show", `${BASE}:${PAGINA}`], { cwd: RAIZ, encoding: "utf8" }).replace(/\r\n/g, "\n");
  const ml = (s: string) => s.slice(s.indexOf("{/* Mercado Livre */}") >= 0 ? s.indexOf("{/* Mercado Livre */}") : s.indexOf('href="/api/auth/mercadolivre"\n            style'), s.indexOf("Adicionar conta ML"));
  assert(ml(base).length > 100 && ml(base) === ml(fonte(PAGINA)), "card ML mudou");
  assert(/interpretarRetornoOAuthML/.test(pg) && /const conectarML = \(\) => \{ window\.location\.href = "\/api\/auth\/mercadolivre"; \};/.test(pg), "fluxo ML mudou");
});
t("M. V2: OAuth/pipeline cobertos pelas suites de comportamento; Vendas/Dashboard em zonas protegidas; sem selecao implicita nova (I3)", () => {
  const errosV2 = invariantesV2(RAIZ);
  assert(errosV2.length === 0, `M: ${errosV2.join(" | ")}`);
});

console.log(`\n${falhou === 0 ? "✓" : "✗"} SHOPEE-UX — ${passou} passaram, ${falhou} falharam`);
process.exit(falhou === 0 ? 0 : 1);
