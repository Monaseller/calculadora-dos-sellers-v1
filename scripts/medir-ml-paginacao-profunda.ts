/**
 * MEDICAO — ate onde a paginacao do Mercado Livre vai — F7b.4.8.3 §5/§6.
 *
 * ── A pergunta ──────────────────────────────────────────────────────
 *
 * "Semana passada" voltou `truncado: true` com 1694 pedidos no recorte
 * financeiro. O cap interno e `MAX_PAGINAS = 60` x 51 = 3060 pedidos, e a
 * janela BUSCADA e maior que a financeira: 5 dias de margem para boleto,
 * entao 7 dias pedidos viram 12 dias lidos.
 *
 * Este script mede, contra a API real e READ-ONLY:
 *
 *   1. quantos pedidos existem na janela de CRIACAO de cada caso
 *   2. se `offset` avanca de verdade (pagina 1 != pagina 2)
 *   3. onde a paginacao por offset PARA de funcionar
 *   4. se subdividir por dia mantem os totais
 *
 * ── §6: nao confiar em HTTP 200 ─────────────────────────────────────
 *
 * Ja foi medido que o ML devolve 200 ignorando parametro que nao conhece.
 * Entao nada aqui e inferido de status: paginacao se prova por ids
 * DIFERENTES entre paginas, e cobertura se prova por contagem.
 *
 * NAO imprime token, seller_id, valor financeiro nem dado de comprador.
 *
 * Roda com: npx tsx scripts/medir-ml-paginacao-profunda.ts
 */
import "./_server-only-inerte";

import { readFileSync } from "node:fs";
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
const BASE = "https://api.mercadolibre.com/orders/search";

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const chave = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !chave) { console.error("ERRO: env do Supabase."); process.exit(1); }
  const db = createClient(url, chave);

  const { data } = await db.from("lojas").select("user_id").eq("id", LOJA).maybeSingle();
  const dono = String((data as { user_id?: string } | null)?.user_id ?? "");
  if (dono === "") { console.error("ERRO: loja ausente."); process.exit(1); }

  const { getMLLojaById } = await import("../lib/ml-auth");
  const loja = await getMLLojaById(LOJA, dono);
  if (loja === null) { console.error("ERRO: credencial."); process.exit(1); }
  console.log("credencial resolvida server-side: sim (nada impresso)");

  const buscar = async (params: Record<string, string>) => {
    const q = new URLSearchParams({
      seller: loja.sellerId, "order.status": "paid", ...params,
    });
    const r = await fetch(`${BASE}?${q.toString()}`, {
      headers: { Authorization: `Bearer ${loja.accessToken}` },
    });
    const corpo = await r.json() as {
      paging?: { total?: number; limit?: number; offset?: number };
      results?: { id?: unknown }[];
      message?: string;
    };
    return {
      status: r.status,
      total: corpo.paging?.total ?? null,
      devolvidos: (corpo.results ?? []).length,
      ids: (corpo.results ?? []).map((o) => String(o.id ?? "")),
      msg: String(corpo.message ?? ""),
    };
  };

  const janela = (de: string, ate: string) => ({
    "order.date_created.from": `${de}T00:00:00.000-03:00`,
    "order.date_created.to": `${ate}T23:59:59.999-03:00`,
  });

  // ── 1. O tamanho REAL de cada janela de criacao ───────────────────
  console.log("\n1. Pedidos na janela de CRIACAO (o que a busca precisa varrer)");
  const casos: readonly { readonly rotulo: string; readonly de: string; readonly ate: string }[] = [
    // Financeiro 28/09..04/10 -> criacao 23/09..04/10
    { rotulo: "esta semana      (fin 28/09-04/10)", de: "2026-09-23", ate: "2026-10-04" },
    // Financeiro 21/09..27/09 -> criacao 16/09..27/09  <- o truncado
    { rotulo: "semana passada   (fin 21/09-27/09)", de: "2026-09-16", ate: "2026-09-27" },
    // Ultimos 7 dias 24/09..30/09 -> criacao 19/09..30/09
    { rotulo: "ultimos 7 dias   (fin 24/09-30/09)", de: "2026-09-19", ate: "2026-09-30" },
    // Agosto inteiro -> criacao 27/07..31/08
    { rotulo: "agosto/2026      (fin 01/08-31/08)", de: "2026-07-27", ate: "2026-08-31" },
    { rotulo: "dia 15/08        (fin 15/08-15/08)", de: "2026-08-10", ate: "2026-08-15" },
  ];
  const CAP_ATUAL = 60 * 51;
  for (const c of casos) {
    const r = await buscar({ ...janela(c.de, c.ate), limit: "1", offset: "0" });
    const estoura = (r.total ?? 0) > CAP_ATUAL;
    console.log(`  ${c.rotulo}  criacao ${c.de}..${c.ate}`);
    console.log(`     total=${String(r.total)}  cap atual=${CAP_ATUAL}  ` +
      `ESTOURA=${estoura ? "SIM" : "nao"}`);
  }

  // ── 2. A paginacao AVANCA de verdade? ─────────────────────────────
  console.log("\n2. A paginacao avanca (ids diferentes) — §6");
  {
    const j = janela("2026-09-16", "2026-09-27");
    const p1 = await buscar({ ...j, limit: "51", offset: "0", sort: "date_asc" });
    const p2 = await buscar({ ...j, limit: "51", offset: "51", sort: "date_asc" });
    const comuns = p1.ids.filter((i) => p2.ids.includes(i));
    console.log(`  pagina 1: ${p1.devolvidos} ids   pagina 2: ${p2.devolvidos} ids`);
    console.log(`  ids em COMUM entre as duas: ${comuns.length} (esperado 0)`);
    console.log(`  primeiro id da p1 == primeiro da p2? ${p1.ids[0] === p2.ids[0]}`);
  }

  // ── 3. Onde a paginacao por offset PARA ───────────────────────────
  console.log("\n3. Ate onde o offset funciona");
  {
    const j = janela("2026-09-16", "2026-09-27");
    for (const off of ["0", "3000", "4000", "5000", "9000", "10000", "10050"]) {
      const r = await buscar({ ...j, limit: "51", offset: off, sort: "date_asc" });
      console.log(`  offset=${off.padStart(5)}  HTTP ${r.status}  devolvidos=${r.devolvidos}` +
        `  total=${String(r.total)}${r.msg ? `  msg="${r.msg.slice(0, 60)}"` : ""}`);
    }
  }

  // ── 4. Subdividir por DIA preserva o total? ───────────────────────
  console.log("\n4. Subdividir por dia — a soma bate com a janela inteira?");
  {
    const inteira = await buscar({
      ...janela("2026-09-16", "2026-09-27"), limit: "1", offset: "0",
    });
    let soma = 0;
    const porDia: string[] = [];
    for (let d = 16; d <= 27; d += 1) {
      const dia = `2026-09-${String(d).padStart(2, "0")}`;
      const r = await buscar({ ...janela(dia, dia), limit: "1", offset: "0" });
      soma += r.total ?? 0;
      porDia.push(`${dia.slice(8)}=${String(r.total)}`);
    }
    console.log(`  janela inteira: ${String(inteira.total)}`);
    console.log(`  soma dos dias:  ${soma}`);
    console.log(`  por dia: ${porDia.join(" ")}`);
    console.log(`  BATEM? ${inteira.total === soma ? "SIM" : "NAO"}`);
    const maiorDia = Math.max(...porDia.map((p) => Number(p.split("=")[1])));
    console.log(`  maior dia isolado: ${maiorDia}  (cabe em ${Math.ceil(maiorDia / 51)} paginas)`);
  }
}

void main();
