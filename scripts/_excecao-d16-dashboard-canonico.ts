/**
 * SALES-CANONICAL-D16B — excecao EXATA dos guards de escopo para o cutover
 * dos 4 cards principais do Dashboard (Faturamento, Pedidos, Unidades,
 * Ticket) para a camada canonica.
 *
 * Arquivos NOVOS aceitos SO com o conteudo EXATO aprovado (sha256, forma LF)
 * e SO se nao existiam na base do guard:
 *   lib/vendas/canonico/dashboard-resumo.ts
 *   app/api/vendas/resumo-canonico/route.ts
 *   scripts/_excecao-d16-dashboard-canonico.ts (este helper; auto-pin: sha256
 *     do proprio texto com o literal do hash trocado por zeros)
 *
 * app/(app)/dashboard/page.tsx so passa se, revertendo EXATAMENTE os hunks
 * D16 aprovados abaixo (gerados do diff contra 1d6e573), o resultado for
 * BYTE-IDENTICO ao blob de 1d6e573 — e se o arquivo na base do guard for o
 * mesmo de 1d6e573 (nada mais mudou desde la). Qualquer outra linha → falha.
 *
 * Vendas, lucro/margem/ROI/comissoes e qualquer outra mudanca futura no
 * Dashboard NAO sao liberados. As excecoes D13/D14/D15B/D15C/D15D/D15F2
 * seguem independentes.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const BASE_D16 = "1d6e573";
export const ARQUIVO_DASHBOARD_D16 = "app/(app)/dashboard/page.tsx";
export const ROTA_D16 = "app/api/vendas/resumo-canonico/route.ts";
export const HELPER_D16 = "scripts/_excecao-d16-dashboard-canonico.ts";

/** sha256 (LF) do conteudo aprovado dos arquivos novos. */
const SHA256_NOVOS_D16: Record<string, string> = {
  "lib/vendas/canonico/dashboard-resumo.ts": "dcb8cf5ce7b1861240ca235a377cf55419802a518c485e2dc1d2ff8144235b49",
  "app/api/vendas/resumo-canonico/route.ts": "f49ffa6e3e2c166033a4d34eef017be6a073ec80de0a2a2affd4a22775834b42",
};
const SHA256_HELPER_D16 = "9bdac65cf343479adc40803e2e845f62e6e71903856c9d4e75910a9dd4587b58";

/** Hunks APROVADOS (contexto de 1 linha): `d16` no arquivo atual ↔ `base` em 1d6e573. */
const PATCH_D16: { base: string; d16: string }[] = [
  {
    "base": "};\ntype DiaData = {",
    "d16": "};\n/** D16: GET /api/vendas/resumo-canonico — so os campos que os 4 cards principais usam. */\ntype ResumoCanonicoDashboard = {\n  estado: string; parcial: boolean; observadoAte: string | null;\n  metricas: { faturamento: number; pedidos: number; unidades: number; ticket: number } | null;\n};\ntype DiaData = {"
  },
  {
    "base": "  });\n  const [dias,     setDias]     = useState<DiaData[]>([]);",
    "d16": "  });\n  // D16: Faturamento, Pedidos, Unidades e Ticket vem da camada canonica (null = indisponivel)\n  const [resumoCanonico, setResumoCanonico] = useState<ResumoCanonicoDashboard | null>(null);\n  // Sem metrica canonica (periodo incompleto / sem observacao) o card mostra \"—\", nunca 0 nem o legado.\n  const mc = resumoCanonico?.metricas ?? null;\n  const ateCanonico = resumoCanonico?.parcial && resumoCanonico.observadoAte\n    ? new Date(resumoCanonico.observadoAte).toLocaleTimeString(\"pt-BR\", { hour: \"2-digit\", minute: \"2-digit\", timeZone: \"America/Sao_Paulo\" })\n    : null;\n  const subSemCanonico = resumoCanonico ? \"sincronizando\" : \"indisponivel\";\n  const [dias,     setDias]     = useState<DiaData[]>([]);"
  },
  {
    "base": "\n    try {\n      // Fase D (2026-07-06): date_field propagado às duas APIs (Fase C já suporta o parâmetro)\n      const [mlData, shopeeData] = await Promise.all([\n        buscarML     ? fetch(`/api/ml/vendas?date_from=${from}&date_to=${to}&date_field=${dateField}&_reqid=${reqId}`, { signal: controller.signal }).then(r => r.json()).catch(err => { if (err?.name === \"AbortError\") throw err; return null; })     : Promise.resolve(null),\n        buscarShopee ? fetch(`/api/shopee/vendas?date_from=${from}&date_to=${to}&date_field=${dateField}&_reqid=${reqId}`, { signal: controller.signal }).then(r => r.json()).catch(err => { if (err?.name === \"AbortError\") throw err; return null; }) : Promise.resolve(null),\n      ]);",
    "d16": "\n    // D16: filtro canonico dos 4 cards principais — a mesma selecao do dropdown\n    // (uma loja → o marketplace dela + loja_id; todas → \"todos\"). O dono e a sessao no servidor.\n    const todasSelecionadas = lojasArr.length === 0 || sel.size === 0 || sel.size === lojasArr.length;\n    const lojaUnica = !todasSelecionadas && selecionadasArr.length === 1 ? selecionadasArr[0] : null;\n    const qCanonico = new URLSearchParams({\n      marketplace: lojaUnica ? (lojaUnica.marketplace === \"Shopee\" ? \"shopee\" : \"mercado_livre\") : \"todos\",\n      de: from, ate: to, ...(lojaUnica ? { loja_id: lojaUnica.id } : {}),\n    });\n\n    try {\n      // Fase D (2026-07-06): date_field propagado às duas APIs (Fase C já suporta o parâmetro)\n      const [mlData, shopeeData, canonData] = await Promise.all([\n        buscarML     ? fetch(`/api/ml/vendas?date_from=${from}&date_to=${to}&date_field=${dateField}&_reqid=${reqId}`, { signal: controller.signal }).then(r => r.json()).catch(err => { if (err?.name === \"AbortError\") throw err; return null; })     : Promise.resolve(null),\n        buscarShopee ? fetch(`/api/shopee/vendas?date_from=${from}&date_to=${to}&date_field=${dateField}&_reqid=${reqId}`, { signal: controller.signal }).then(r => r.json()).catch(err => { if (err?.name === \"AbortError\") throw err; return null; }) : Promise.resolve(null),\n        fetch(`/api/vendas/resumo-canonico?${qCanonico}`, { signal: controller.signal }).then(r => (r.ok ? r.json() : null)).catch(err => { if (err?.name === \"AbortError\") throw err; return null; }) as Promise<ResumoCanonicoDashboard | null>,\n      ]);"
  },
  {
    "base": "\n      const mlOk     = mlData     && !mlData.erro;",
    "d16": "\n      setResumoCanonico(canonData);\n\n      const mlOk     = mlData     && !mlData.erro;"
  },
  {
    "base": "          }}>\n            <KpiCard icon=\"💰\" label=\"Faturamento\"   value={fmtBRL(kpis.faturamento, true)} sub={`${kpis.unidades} unid.`} color=\"#FF7A00\" spark={sparkFat} />\n            <KpiCard icon=\"✨\" label=\"Lucro Liquido\" value={fmtBRL(kpis.lucro, true)}        color={kpis.lucro >= 0 ? \"#22C55E\" : \"#EF4444\"} spark={sparkLuc} sub=\"apos custos\" />\n            <KpiCard icon=\"📊\" label=\"Margem Media\"  value={`${kpis.margem.toFixed(1)}%`}    color={kpis.margem >= 20 ? \"#22C55E\" : kpis.margem >= 10 ? \"#FFB000\" : \"#EF4444\"} sub=\"contribuicao\" />\n            <KpiCard icon=\"📦\" label=\"Pedidos\"       value={String(kpis.pedidos)}             color=\"#6366F1\" sub=\"pagos\" />\n            <KpiCard icon=\"🎯\" label=\"Ticket Medio\"  value={fmtBRL(kpis.ticket, true)}       color=\"#FFB000\" sub=\"por pedido\" />\n            <KpiCard icon=\"🔄\" label=\"ROI\"           value={`${kpis.roi.toFixed(0)}%`}       color={kpis.roi >= 50 ? \"#22C55E\" : \"#FFB000\"} sub=\"retorno s/ custo\" />\n            <KpiCard icon=\"🏷️\" label=\"Comissoes\"    value={fmtBRL(kpis.comissoes, true)}     color=\"#EF4444\" sub=\"taxas marketplace\" />\n            <KpiCard icon=\"📈\" label=\"Unidades\"      value={String(kpis.unidades)}            color=\"#06B6D4\" sub=\"vendidas\" />\n          </div>",
    "d16": "          }}>\n            <KpiCard icon=\"💰\" label=\"Faturamento\"   value={mc ? fmtBRL(mc.faturamento) : \"—\"} sub={mc ? `${mc.unidades} unid.${ateCanonico ? ` · até ${ateCanonico}` : \"\"}` : subSemCanonico} color=\"#FF7A00\" spark={sparkFat} />\n            <KpiCard icon=\"✨\" label=\"Lucro Liquido\" value={fmtBRL(kpis.lucro, true)}        color={kpis.lucro >= 0 ? \"#22C55E\" : \"#EF4444\"} spark={sparkLuc} sub=\"apos custos\" />\n            <KpiCard icon=\"📊\" label=\"Margem Media\"  value={`${kpis.margem.toFixed(1)}%`}    color={kpis.margem >= 20 ? \"#22C55E\" : kpis.margem >= 10 ? \"#FFB000\" : \"#EF4444\"} sub=\"contribuicao\" />\n            <KpiCard icon=\"📦\" label=\"Pedidos\"       value={mc ? String(mc.pedidos) : \"—\"}    color=\"#6366F1\" sub={mc ? \"pagos\" : subSemCanonico} />\n            <KpiCard icon=\"🎯\" label=\"Ticket Medio\"  value={mc ? fmtBRL(mc.ticket) : \"—\"} color=\"#FFB000\" sub={mc ? \"por pedido\" : subSemCanonico} />\n            <KpiCard icon=\"🔄\" label=\"ROI\"           value={`${kpis.roi.toFixed(0)}%`}       color={kpis.roi >= 50 ? \"#22C55E\" : \"#FFB000\"} sub=\"retorno s/ custo\" />\n            <KpiCard icon=\"🏷️\" label=\"Comissoes\"    value={fmtBRL(kpis.comissoes, true)}     color=\"#EF4444\" sub=\"taxas marketplace\" />\n            <KpiCard icon=\"📈\" label=\"Unidades\"      value={mc ? String(mc.unidades) : \"—\"}   color=\"#06B6D4\" sub={mc ? \"vendidas\" : subSemCanonico} />\n          </div>"
  }
];

const lf = (s: string) => s.replace(/\r\n/g, "\n");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
function blob(raiz: string, rev: string, arquivo: string): string | null {
  try { return lf(execFileSync("git", ["show", `${rev}:${arquivo}`], { cwd: raiz, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })); }
  catch { return null; }
}
function ler(raiz: string, arquivo: string): string | null {
  try { return lf(readFileSync(join(raiz, arquivo), "utf8")); } catch { return null; }
}

/** Dashboard atual − hunks D16 = 1d6e573, byte a byte (cada hunk exatamente uma vez). */
export function dashboardExatoD16(raiz: string): { valido: boolean; motivo: string } {
  let s = ler(raiz, ARQUIVO_DASHBOARD_D16);
  if (s === null) return { valido: false, motivo: "arquivo_ausente" };
  for (const h of PATCH_D16) {
    if (s.split(h.d16).length !== 2) return { valido: false, motivo: "hunk_nao_encontrado_ou_repetido" };
    s = s.replace(h.d16, () => h.base);
  }
  const base = blob(raiz, BASE_D16, ARQUIVO_DASHBOARD_D16);
  return base !== null && s === base ? { valido: true, motivo: "" } : { valido: false, motivo: "reconstrucao_difere_de_1d6e573" };
}

/** Arquivo novo com o conteudo EXATO aprovado. */
export function novoExatoD16(raiz: string, arquivo: string): boolean {
  if (arquivo === HELPER_D16) {
    const s = ler(raiz, HELPER_D16);
    return s !== null && sha(s.replace(/const SHA256_HELPER_D16 = "[0-9a-f]{64}";/, `const SHA256_HELPER_D16 = "${"0".repeat(64)}";`)) === SHA256_HELPER_D16;
  }
  const esperado = SHA256_NOVOS_D16[arquivo];
  const s = esperado ? ler(raiz, arquivo) : null;
  return s !== null && sha(s) === esperado;
}

/**
 * Remove da lista de alterados SO o que a excecao D16 cobre:
 *   - o Dashboard, quando dashboardExatoD16 E o arquivo na base do guard e o de 1d6e573;
 *   - os arquivos novos (resumo, rota, este helper) com conteudo exato, se nao existiam na base.
 */
export function filtrarExcecaoD16(raiz: string, base: string, alterados: string[]): string[] {
  return alterados.filter((f) => {
    if (f === ARQUIVO_DASHBOARD_D16) return !(dashboardExatoD16(raiz).valido && blob(raiz, base, f) === blob(raiz, BASE_D16, f));
    if ((f in SHA256_NOVOS_D16 || f === HELPER_D16) && blob(raiz, base, f) === null) return !novoExatoD16(raiz, f);
    return true;
  });
}

/** Guard 7e: o UNICO importador autorizado do servico canonico fora de lib/. */
export const IMPORTADORES_AUTORIZADOS_D16: readonly string[] = [ROTA_D16];
