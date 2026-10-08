/**
 * SHOPEE UX V4/V4B — excecao EXATA dos guards para o painel unico
 * "Gerenciar contas Shopee" (um card Shopee; default/rd so como apps OAuth).
 *
 * Camada SOBRE a excecao multi-app (scripts/_excecao-shopee-multi-app.ts):
 *   app/(app)/configuracoes/page.tsx so passa se, revertendo EXATAMENTE os
 *   hunks UX aprovados abaixo (gerados do diff contra cdeb7af), o resultado
 *   for BYTE-IDENTICO ao blob de cdeb7af — que ja contem a camada multi-app
 *   aprovada — e se o arquivo na base do guard for um blob ja aprovado
 *   (pinado abaixo: o de cdeb7af e os aceitos pela excecao multi-app).
 *
 * NOVOS, so com o conteudo EXATO (sha256, forma LF) e so se nao existiam na
 * base do guard: lib/shopee-conexao-ui.ts, scripts/testar-shopee-ux.ts e este
 * helper (auto-pin).
 *
 * SEC-3-B1 J2: Configuracoes e lib/shopee-conexao-ui.ts saem da lista SO por
 * esta excecao exata — BROWSER_PENDENTE e qualquer lista generica nao mudam.
 * OAuth core (rotas start/callback/apps, shopee-apps, shopee-oauth-estado),
 * pipeline Shopee, Vendas, Dashboard e Meus Produtos seguem travados.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const BASE_SHOPEE_UX = "cdeb7af";
export const HELPER_SHOPEE_UX = "scripts/_excecao-shopee-ux.ts";

const SHA256_NOVOS: Record<string, string> = {
  "lib/shopee-conexao-ui.ts": "667007ad9f9cb9665ae03ce16fe65d39e4ff99bc2c179e4fa7a27129c48ca7e2",
  "scripts/testar-shopee-ux.ts": "dcc31440e7f0bc4691f653bee85046b20e33acedb2f59c89b436412d8dd07e82"
};
const SHA256_HELPER_SHOPEE_UX = "171576c68066acaf3d302e16eaeda1b8e9605373e65a5efae0fa45e25940d678";
const BLOBS_BASE_APROVADOS: Record<string, string[]> = {
  "app/(app)/configuracoes/page.tsx": [
    "1915e4374e6a8dba34a2542f4f3186abc40309c6",
    "b03ea2fa10bb7551f587370d2f8c9eb346d5f4c5"
  ]
};
const PATCH: Record<string, { base: string; novo: string }[]> = {
  "app/(app)/configuracoes/page.tsx": [
    {
      "base": "import { useRouter } from \"next/navigation\";\nimport { interpretarRetornoOAuthML } from \"@/lib/conexao-ml-cliente\";\n\ntype Loja = {",
      "novo": "import { useRouter } from \"next/navigation\";\nimport { interpretarRetornoOAuthML } from \"@/lib/conexao-ml-cliente\";\nimport { decidirConexaoShopee, MENSAGEM_APPS_INDISPONIVEIS, type OpcaoAppShopee } from \"@/lib/shopee-conexao-ui\";\n\ntype Loja = {"
    },
    {
      "base": "  const [lojaAtiva,    setLojaAtiva]    = useState<string | null>(null);\n  const [shopeeAtiva,  setShopeeAtiva]  = useState<string | null>(null);\n  // Apps Shopee alem do padrao, so os CONFIGURADOS no servidor (sem credencial no navegador)\n  const [appsShopeeExtras, setAppsShopeeExtras] = useState<{ chave: string; rotulo: string }[]>([]);\n  const [loading,   setLoading]   = useState(true);\n  const [msg,       setMsg]       = useState<{ ok: boolean; texto: string } | null>(null);",
      "novo": "  const [lojaAtiva,    setLojaAtiva]    = useState<string | null>(null);\n  const [shopeeAtiva,  setShopeeAtiva]  = useState<string | null>(null);\n  // Painel unico \"Gerenciar contas Shopee\": toda nova conexao Shopee comeca por ele (Shopee UX V4)\n  const [painelShopee, setPainelShopee] = useState(false);\n  const [etapaShopee, setEtapaShopee] = useState<\n    { tipo: \"inicio\" } | { tipo: \"carregando\" } | { tipo: \"escolher\"; opcoes: readonly OpcaoAppShopee[] } | { tipo: \"erro\"; mensagem: string }\n  >({ tipo: \"inicio\" });\n  const [loading,   setLoading]   = useState(true);\n  const [msg,       setMsg]       = useState<{ ok: boolean; texto: string } | null>(null);"
    },
    {
      "base": "\n  useEffect(() => { carregarLojas(); carregarPerfil(); }, []);\n  useEffect(() => {\n    fetch(\"/api/auth/shopee/apps\").then((r) => (r.ok ? r.json() : null)).then((d) => {\n      const apps = Array.isArray(d?.apps) ? d.apps : [];\n      setAppsShopeeExtras(apps.filter((a: { chave: string; configurado: boolean }) => a.chave !== \"default\" && a.configurado === true)\n        .map((a: { chave: string; rotulo: string }) => ({ chave: String(a.chave), rotulo: String(a.rotulo) })));\n    }).catch(() => setAppsShopeeExtras([]));\n  }, []);\n\n  /**",
      "novo": "\n  useEffect(() => { carregarLojas(); carregarPerfil(); }, []);\n\n  /**"
    },
    {
      "base": "  const conectarML = () => { window.location.href = \"/api/auth/mercadolivre\"; };\n\n  return (\n    <div style={{ padding: \"32px\", maxWidth: \"860px\", margin: \"0 auto\" }}>",
      "novo": "  const conectarML = () => { window.location.href = \"/api/auth/mercadolivre\"; };\n\n  // ── Shopee: um card, um painel. default/rd sao so apps OAuth internos ──\n  const abrirPainelShopee = () => { setEtapaShopee({ tipo: \"inicio\" }); setPainelShopee(true); };\n  const fecharPainelShopee = () => { setPainelShopee(false); setEtapaShopee({ tipo: \"inicio\" }); };\n  async function adicionarLojaShopee() {\n    setEtapaShopee({ tipo: \"carregando\" });\n    try {\n      const r = await fetch(\"/api/auth/shopee/apps\", { cache: \"no-store\" });\n      const d = decidirConexaoShopee(r.ok ? await r.json() : null);\n      if (d.tipo === \"direto\") { window.location.href = d.url; return; }\n      setEtapaShopee(d.tipo === \"escolher\" ? { tipo: \"escolher\", opcoes: d.opcoes } : { tipo: \"erro\", mensagem: d.mensagem });\n    } catch {\n      setEtapaShopee({ tipo: \"erro\", mensagem: MENSAGEM_APPS_INDISPONIVEIS });\n    }\n  }\n\n  return (\n    <div style={{ padding: \"32px\", maxWidth: \"860px\", margin: \"0 auto\" }}>"
    },
    {
      "base": "          </a>\n\n          {/* Shopee */}\n          <a\n            href=\"/api/auth/shopee\"\n            style={{\n              display: \"block\", textDecoration: \"none\",",
      "novo": "          </a>\n\n          {/* Shopee — UM card; abre o painel unico de contas Shopee */}\n          <div\n            role=\"button\"\n            tabIndex={0}\n            onClick={abrirPainelShopee}\n            onKeyDown={e => { if (e.key === \"Enter\" || e.key === \" \") { e.preventDefault(); abrirPainelShopee(); } }}\n            style={{\n              display: \"block\", textDecoration: \"none\","
    },
    {
      "base": "              Adicionar conta Shopee\n            </div>\n          </a>\n\n          {/* Shopee — outros apps configurados no servidor (ex.: R.D.) */}\n          {appsShopeeExtras.map((app) => (\n            <a key={app.chave} href={`/api/auth/shopee?app=${encodeURIComponent(app.chave)}`}\n              style={{ display: \"block\", textDecoration: \"none\", background: \"rgba(238,77,45,0.05)\", border: \"1px solid rgba(238,77,45,0.18)\", borderRadius: \"14px\", padding: \"24px\", cursor: \"pointer\" }}>\n              <div style={{ fontWeight: 800, fontSize: \"15px\", color: \"#EE4D2D\", marginBottom: \"6px\" }}>{app.rotulo}</div>\n              <div style={{ fontSize: \"13px\", color: \"#EE4D2D\", fontWeight: 700 }}>Conectar {app.rotulo}</div>\n            </a>\n          ))}\n\n        </div>\n      </section>\n\n    </div>\n  );",
      "novo": "              Adicionar conta Shopee\n            </div>\n          </div>\n\n        </div>\n      </section>\n\n      {/* ── Painel \"Gerenciar contas Shopee\" ── */}\n      {painelShopee && (\n        <div role=\"dialog\" aria-modal=\"true\" aria-label=\"Gerenciar contas Shopee\" onClick={fecharPainelShopee}\n          style={{ position: \"fixed\", inset: 0, background: \"rgba(0,0,0,0.6)\", display: \"flex\", alignItems: \"center\", justifyContent: \"center\", zIndex: 50, padding: \"16px\" }}>\n          <div onClick={e => e.stopPropagation()}\n            style={{ background: \"#14161c\", border: \"1px solid rgba(238,77,45,0.25)\", borderRadius: \"14px\", padding: \"24px\", width: \"100%\", maxWidth: \"420px\" }}>\n            <div style={{ fontWeight: 800, fontSize: \"16px\", color: \"#fff\", marginBottom: \"14px\" }}>Gerenciar contas Shopee</div>\n\n            <div style={{ fontSize: \"12px\", color: \"#9099aa\", marginBottom: \"8px\" }}>Contas Shopee conectadas</div>\n            {lojas.filter(l => l.marketplace === \"Shopee\").length === 0 ? (\n              <div style={{ fontSize: \"13px\", color: \"#9099aa\", marginBottom: \"16px\" }}>Nenhuma conta Shopee conectada.</div>\n            ) : (\n              <div style={{ display: \"flex\", flexDirection: \"column\", gap: \"6px\", marginBottom: \"16px\" }}>\n                {lojas.filter(l => l.marketplace === \"Shopee\").map(l => (\n                  <div key={l.id} style={{ fontSize: \"13px\", color: \"#fff\" }}>🛍️ {l.nickname || l.nome}</div>\n                ))}\n              </div>\n            )}\n\n            {etapaShopee.tipo === \"escolher\" ? (\n              <div>\n                <div style={{ fontSize: \"13px\", color: \"#fff\", fontWeight: 700, marginBottom: \"10px\" }}>Escolha como conectar esta loja Shopee</div>\n                <div style={{ display: \"flex\", flexDirection: \"column\", gap: \"8px\", marginBottom: \"16px\" }}>\n                  {etapaShopee.opcoes.map(o => (\n                    <button key={o.chave} type=\"button\" onClick={() => { window.location.href = o.url; }}\n                      style={{ textAlign: \"left\", background: \"rgba(238,77,45,0.10)\", border: \"1px solid rgba(238,77,45,0.3)\", borderRadius: \"8px\", padding: \"10px 14px\", color: \"#EE4D2D\", fontWeight: 700, fontSize: \"13px\", cursor: \"pointer\" }}>\n                      {o.rotulo}\n                    </button>\n                  ))}\n                </div>\n              </div>\n            ) : (\n              <button type=\"button\" onClick={adicionarLojaShopee} disabled={etapaShopee.tipo === \"carregando\"}\n                style={{ background: \"rgba(238,77,45,0.15)\", border: \"1px solid rgba(238,77,45,0.3)\", borderRadius: \"8px\", padding: \"10px 14px\", color: \"#EE4D2D\", fontWeight: 700, fontSize: \"13px\", cursor: \"pointer\", marginBottom: \"12px\" }}>\n                {etapaShopee.tipo === \"carregando\" ? \"Carregando...\" : \"+ Adicionar nova loja Shopee\"}\n              </button>\n            )}\n            {etapaShopee.tipo === \"erro\" && (\n              <div role=\"alert\" style={{ fontSize: \"12px\", color: \"#ff8a80\", marginBottom: \"12px\" }}>{etapaShopee.mensagem}</div>\n            )}\n\n            <div style={{ display: \"flex\", justifyContent: \"flex-end\" }}>\n              <button type=\"button\" onClick={fecharPainelShopee}\n                style={{ background: \"transparent\", border: \"1px solid rgba(255,255,255,0.15)\", borderRadius: \"8px\", padding: \"8px 14px\", color: \"#9099aa\", fontSize: \"13px\", cursor: \"pointer\" }}>\n                Cancelar\n              </button>\n            </div>\n          </div>\n        </div>\n      )}\n\n    </div>\n  );"
    }
  ]
};

const lf = (s: string) => s.replace(/\r\n/g, "\n");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
function blob(raiz: string, rev: string, arquivo: string): string | null {
  try { return lf(execFileSync("git", ["show", `${rev}:${arquivo}`], { cwd: raiz, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })); }
  catch { return null; }
}
function idBlob(raiz: string, rev: string, arquivo: string): string | null {
  try { return execFileSync("git", ["rev-parse", `${rev}:${arquivo}`], { cwd: raiz, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return null; }
}
function ler(raiz: string, arquivo: string): string | null {
  try { return lf(readFileSync(join(raiz, arquivo), "utf8")); } catch { return null; }
}

/** Arquivo atual − hunks UX aprovados = cdeb7af, byte a byte (cada hunk exatamente uma vez). */
export function arquivoExatoShopeeUX(raiz: string, arquivo: string): boolean {
  const hunks = PATCH[arquivo];
  let s = hunks ? ler(raiz, arquivo) : null;
  if (s === null) return false;
  for (const h of hunks) {
    if (s.split(h.novo).length !== 2) return false;
    s = s.replace(h.novo, () => h.base);
  }
  const base = blob(raiz, BASE_SHOPEE_UX, arquivo);
  return base !== null && s === base;
}

export function novoExatoShopeeUX(raiz: string, arquivo: string): boolean {
  if (arquivo === HELPER_SHOPEE_UX) {
    const s = ler(raiz, HELPER_SHOPEE_UX);
    return s !== null && sha(s.replace(/const SHA256_HELPER_SHOPEE_UX = "[0-9a-f]{64}";/, `const SHA256_HELPER_SHOPEE_UX = "${"0".repeat(64)}";`)) === SHA256_HELPER_SHOPEE_UX;
  }
  const esperado = SHA256_NOVOS[arquivo];
  const s = esperado ? ler(raiz, arquivo) : null;
  return s !== null && sha(s) === esperado;
}

const ehNovo = (f: string) => f in SHA256_NOVOS || f === HELPER_SHOPEE_UX;

/** Remove da lista SO o que esta excecao cobre (Configuracoes exata com base aprovada; novos exatos ausentes na base). */
export function filtrarExcecaoShopeeUX(raiz: string, base: string, alterados: string[]): string[] {
  return alterados.filter((f) => {
    if (f in PATCH) { const b = idBlob(raiz, base, f); return !(b !== null && BLOBS_BASE_APROVADOS[f].includes(b) && arquivoExatoShopeeUX(raiz, f)); }
    if (ehNovo(f) && blob(raiz, base, f) === null) return !novoExatoShopeeUX(raiz, f);
    return true;
  });
}
