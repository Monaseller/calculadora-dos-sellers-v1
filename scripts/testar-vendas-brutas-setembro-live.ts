/**
 * AGENT-FACTORY-F7b.4.8.5 §12 — setembro/2026 contra a API REAL.
 *
 * Suite LIVE, somente LEITURA: a loja autorizada do dono, a API oficial do
 * Mercado Livre, a camada de dados de producao, sem fixture e sem banco
 * como fonte.
 *
 * ── A ancora ────────────────────────────────────────────────────────
 *
 * O relatorio DETALHADO que o dono baixou do proprio Mercado Livre, lido
 * do arquivo — e nao digitado aqui. O headline do painel (R$ 393.839, sem
 * centavos) NAO e a ancora: `PANEL_HEADLINE_RECONCILIATION` segue PARCIAL.
 *
 * Roda com: npx tsx scripts/testar-vendas-brutas-setembro-live.ts
 */
import "./_server-only-inerte";

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";

function carregarEnvLocal(): void {
  for (const caminho of [
    join(__dirname, "..", ".env.local"),
    join("C:", "Users", "USER", "Desktop", "calculadora-dos-sellers-v1", ".env.local"),
  ]) {
    try {
      for (const linha of readFileSync(caminho, "utf-8").split("\n")) {
        const l = linha.trim();
        if (!l || l.startsWith("#")) continue;
        const i = l.indexOf("=");
        if (i <= 0) continue;
        const k = l.slice(0, i).trim();
        if (!process.env[k]) process.env[k] = l.slice(i + 1).trim().replace(/^["']|["']$/g, "");
      }
      return;
    } catch { /* proximo */ }
  }
}
carregarEnvLocal();

const LOJA = "50165b6f-5185-4da7-991a-07c0c6bc8f39";
const OFICIAL = process.env.OFICIAL ??
  join("C:", "Users", "USER", "Desktop", "boleto e comprovante",
    "20261001_Vendas_BR_Mercado_Libre_y_Mercado_Shops_2026-10-01_08-21hs_744240004.xlsx");

/**
 * O headline do painel, como o dono o viu. Leitura de TELA, sem centavos.
 * Nao e alvo: `PANEL_HEADLINE_RECONCILIATION = PARTIAL`.
 */
const PAINEL_EXIBIDO = 393_839;

let pass = 0;
let fail = 0;
function ok(nome: string, cond: boolean, detalhe = ""): void {
  if (cond) { pass += 1; console.log(`  PASS  ${nome}`); }
  else { fail += 1; console.log(`  FAIL  ${nome}${detalhe ? `  — ${detalhe}` : ""}`); }
}
function secao(t: string): void { console.log(`\n${t}`); }
const brl = (v: number) =>
  v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const chave = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !chave) { console.error("ERRO: env do Supabase."); process.exit(1); }
  const db = createClient(url, chave);
  const { data } = await db.from("lojas").select("user_id").eq("id", LOJA).maybeSingle();
  const dono = String((data as { user_id?: string } | null)?.user_id ?? "");
  if (dono === "") { console.error("ERRO: loja ausente."); process.exit(1); }

  const { criarLeiturasDeVendasML } = await import("../lib/agentes/dados/vendas-ml");
  const { CAMPO_DE_FECHAMENTO } = await import("../lib/mercado-livre-vendas");
  const { lerXlsx } = await import("../lib/agentes/planilhas/leitura");

  console.log("══ F7b.4.8.5 §12 — setembro/2026, API real ══");

  // ═══ A. A ancora, derivada do relatorio oficial ═══════════════════

  secao("A. A ancora sai do arquivo oficial, nao de constante");
  let oficialValor = 0;
  let oficialVendas = 0;
  let oficialUnidades = 0;
  if (!existsSync(OFICIAL)) {
    ok("A1  o relatorio oficial esta no disco", false, OFICIAL);
  } else {
    const aba = lerXlsx(new Uint8Array(readFileSync(OFICIAL))).abas[0];
    const texto = (c: { bruto: string | number | null } | undefined) =>
      c === undefined || c.bruto === null ? "" : String(c.bruto);
    const numero = (c: { bruto: string | number | null } | undefined) => {
      if (c === undefined || c.bruto === null) return null;
      // NUMERO primeiro. A primeira versao desta sonda transformava a
      // celula em texto e tirava o ponto como separador de milhar — e
      // `26.9` virava 269, o que inflou a ancora para R$ 18 milhoes.
      if (typeof c.bruto === "number") return c.bruto;
      const t = c.bruto.trim();
      if (t === "") return null;
      const n = Number(t.replace(/[R$\s.]/g, "").replace(",", "."));
      return Number.isFinite(n) ? n : null;
    };
    let iCab = -1;
    for (let i = 0; i < Math.min(15, aba.linhas.length); i += 1) {
      const l = aba.linhas[i].map(texto).join("|").toLowerCase();
      if (l.includes("venda") && l.includes("unidades")) { iCab = i; break; }
    }
    const cab = aba.linhas[iCab].map(texto);
    const cUnid = cab.findIndex((c) => /^unidades$/i.test(c));
    const cPreco = cab.findIndex((c) => /pre.o unit.rio de venda/i.test(c));
    const vendas = aba.linhas.slice(iCab + 1)
      .filter((l) => l.some((c) => texto(c) !== ""))
      .filter((l) => numero(l[cUnid]) !== null);
    oficialVendas = vendas.length;
    oficialUnidades = vendas.reduce((a, l) => a + (numero(l[cUnid]) ?? 0), 0);
    oficialValor = Math.round(vendas.reduce(
      (a, l) => a + (numero(l[cUnid]) ?? 0) * (numero(l[cPreco]) ?? 0), 0) * 100) / 100;
    ok("A1  o relatorio oficial abre e tem as colunas", cUnid >= 0 && cPreco >= 0);
    console.log(`       oficial: R$ ${brl(oficialValor)}  ${oficialVendas} vendas  ` +
      `${oficialUnidades} unidades`);
  }

  // ═══ B. A consulta real, pelo caminho de producao ═════════════════

  secao("B. A consulta de producao contra a API oficial");
  const destinos: string[] = [];
  const espiao: typeof fetch = (entrada, init) => {
    destinos.push(String(entrada));
    return fetch(entrada as RequestInfo, init);
  };
  const t0 = Date.now();
  const ler = criarLeiturasDeVendasML(
    dono, LOJA, Date.UTC(2026, 9, 1, 15), undefined, { buscar: espiao });
  const r = await ler({ periodo: "setembro de 2026" });
  const ms = Date.now() - t0;

  ok("B1  sem erro", r.erro === null, String(r.erro));
  ok("B2  o periodo que a CDS resolveu e setembro inteiro",
    r.periodo.de === "2026-09-01" && r.periodo.ate === "2026-09-30",
    `${r.periodo.de}..${r.periodo.ate}`);
  ok("B3  no fuso de Sao Paulo", r.periodo.fuso === "America/Sao_Paulo", r.periodo.fuso);
  ok("B4  a varredura COMPLETOU", r.completo === true && r.vendasBrutas !== null,
    `completo=${String(r.completo)} parcial=${JSON.stringify(r.parcial)}`);
  ok("B5  a fonte e a API oficial", r.fonte === "mercadolivre_api");
  ok("B6  TODA chamada foi para api.mercadolibre.com",
    destinos.length > 0 &&
    destinos.every((d) => d.startsWith("https://api.mercadolibre.com/orders/search")),
    destinos.map((d) => d.split("?")[0]).join(" | "));
  ok("B7  NENHUMA para o Supabase — sem fallback CDS",
    !destinos.some((d) => d.includes("supabase")));
  ok("B8  o recorte foi por `order.date_closed`",
    r.diagnostico.campoDeData === CAMPO_DE_FECHAMENTO &&
    destinos.every((d) => d.includes("order.date_closed.from")),
    r.diagnostico.campoDeData);
  ok("B9  e NENHUMA chamada mandou `order.status`",
    !destinos.some((d) => d.includes("order.status")));

  const v = r.vendasBrutas;
  console.log(`       medido: R$ ${brl(v?.valor ?? 0)}  ${v?.vendas} vendas  ` +
    `${v?.unidades} unidades  |  ${destinos.length} chamadas em ${(ms / 1000).toFixed(1)}s`);
  console.log(`       diagnostico: ${JSON.stringify(r.diagnostico)}`);

  // ═══ C. Os tres numeros, contra o oficial ═════════════════════════

  secao("C. Os tres numeros batem com o relatorio oficial");
  ok("C1  valor", Math.abs((v?.valor ?? 0) - oficialValor) < 0.005,
    `${brl(v?.valor ?? 0)} vs ${brl(oficialValor)}`);
  ok("C2  vendas", v?.vendas === oficialVendas, `${v?.vendas} vs ${oficialVendas}`);
  ok("C3  unidades", v?.unidades === oficialUnidades,
    `${v?.unidades} vs ${oficialUnidades}`);
  ok("C4  unidades sao MAIS que vendas — nao e a mesma contagem",
    (v?.unidades ?? 0) > (v?.vendas ?? 0), `${v?.unidades} > ${v?.vendas}`);
  ok("C5  o ticket medio e derivado",
    Math.abs((v?.ticketMedio ?? 0) - (v?.valor ?? 0) / (v?.vendas ?? 1)) < 0.02);
  ok("C6  a quebra por dia soma o total",
    Math.abs(r.porDia.reduce((s, d) => s + d.valor, 0) - (v?.valor ?? 0)) < 0.5,
    `${r.porDia.reduce((s, d) => s + d.valor, 0).toFixed(2)}`);
  ok("C7  e a quebra por dia soma as vendas",
    r.porDia.reduce((s, d) => s + d.vendas, 0) === v?.vendas);
  ok("C8  e as unidades", r.porDia.reduce((s, d) => s + d.unidades, 0) === v?.unidades);
  ok("C9  todo dia esta DENTRO de setembro",
    r.porDia.every((d) => d.dia >= "2026-09-01" && d.dia <= "2026-09-30"),
    r.porDia.map((d) => d.dia).filter((d) => d < "2026-09-01" || d > "2026-09-30").join(","));
  ok("C10 os 30 dias de setembro aparecem", r.porDia.length === 30,
    String(r.porDia.length));

  // ═══ D. O que a regra ANTIGA daria — o contraste ══════════════════

  secao("D. A regra antiga, para contraste (§3: ela continua existindo)");
  {
    const { buscarVendasPagasML } = await import("../lib/mercado-livre-vendas");
    const antiga = await buscarVendasPagasML(
      { userId: dono, lojaId: LOJA, de: "2026-09-01", ate: "2026-09-30" });
    const valorAntigo = antiga.pedidos.reduce((a, p) => a + p.valorPago, 0);
    ok("D1  a leitura de PAGAMENTO continua funcionando",
      antiga.erro === null && antiga.completo === true, String(antiga.erro));
    ok("D2  e ela da MENOS que o oficial — era o defeito",
      valorAntigo < oficialValor,
      `R$ ${brl(valorAntigo)} vs R$ ${brl(oficialValor)}`);
    ok("D3  e MENOS vendas", antiga.pedidos.length < oficialVendas,
      `${antiga.pedidos.length} vs ${oficialVendas}`);
    console.log(`       regra de pagamento: R$ ${brl(valorAntigo)}  ` +
      `${antiga.pedidos.length} pedidos`);
    console.log(`       diferenca que o gate corrigiu: R$ ${brl(oficialValor - valorAntigo)}  ` +
      `e ${oficialVendas - antiga.pedidos.length} vendas`);
  }

  // ═══ E. O painel segue PARCIAL ════════════════════════════════════

  secao("E. O headline do painel (§9 do R2)");
  console.log(`       OFFICIAL_DETAILED_EXPORT = R$ ${brl(oficialValor)}`);
  console.log(`       PANEL_HEADLINE           = R$ ${brl(PAINEL_EXIBIDO)}  (sem centavos)`);
  console.log(`       DELTA                    = R$ ${brl(oficialValor - PAINEL_EXIBIDO)}`);
  ok("E1  o delta contra o painel segue existindo, e nao foi 'arredondado'",
    Math.abs(oficialValor - PAINEL_EXIBIDO) > 0,
    brl(oficialValor - PAINEL_EXIBIDO));
  ok("E2  e a regra nao foi ajustada para fechar o headline",
    Math.abs((v?.valor ?? 0) - oficialValor) < 0.005 &&
    Math.abs((v?.valor ?? 0) - PAINEL_EXIBIDO) > 0);

  console.log(`\nPASS ${pass}   FAIL ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
