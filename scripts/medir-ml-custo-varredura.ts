/**
 * MEDICAO — quanto custa varrer de verdade — F7b.4.8.3 §5/§7.
 *
 * Decide o desenho da subdivisao: latencia por chamada, ganho real de
 * concorrencia, e se `paging.total` serve como criterio de completude.
 *
 * READ-ONLY. Nao imprime token, seller, valor nem comprador.
 *
 * Roda com: npx tsx scripts/medir-ml-custo-varredura.ts
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
  if (!url || !chave) { console.error("ERRO: env."); process.exit(1); }
  const db = createClient(url, chave);
  const { data } = await db.from("lojas").select("user_id").eq("id", LOJA).maybeSingle();
  const dono = String((data as { user_id?: string } | null)?.user_id ?? "");
  const { getMLLojaById } = await import("../lib/ml-auth");
  const loja = await getMLLojaById(LOJA, dono);
  if (loja === null) { console.error("ERRO: credencial."); process.exit(1); }

  const pagina = async (de: string, ate: string, offset: number) => {
    const q = new URLSearchParams({
      seller: loja.sellerId, "order.status": "paid",
      "order.date_created.from": `${de}T00:00:00.000-03:00`,
      "order.date_created.to": `${ate}T23:59:59.999-03:00`,
      sort: "date_asc", limit: "51", offset: String(offset),
    });
    const t0 = Date.now();
    const r = await fetch(`${BASE}?${q.toString()}`, {
      headers: { Authorization: `Bearer ${loja.accessToken}` },
    });
    const corpo = await r.json() as {
      paging?: { total?: number }; results?: { id?: unknown }[];
    };
    return {
      ms: Date.now() - t0,
      status: r.status,
      total: corpo.paging?.total ?? null,
      ids: (corpo.results ?? []).map((o) => String(o.id ?? "")),
    };
  };

  // ── 1. Latencia por chamada ───────────────────────────────────────
  console.log("1. Latencia de UMA pagina");
  const amostras: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    const r = await pagina("2026-09-22", "2026-09-22", i * 51);
    amostras.push(r.ms);
  }
  amostras.sort((a, b) => a - b);
  console.log(`   amostras(ms)=${amostras.join(",")}  mediana=${amostras[2]}`);

  // ── 2. Varrer UM dia inteiro, sequencial, ate esgotar ────────────
  console.log("\n2. Um dia inteiro, sequencial, ate a pagina curta");
  {
    const t0 = Date.now();
    const ids = new Set<string>();
    let paginas = 0;
    for (let off = 0; ; off += 51) {
      const r = await pagina("2026-09-22", "2026-09-22", off);
      paginas += 1;
      for (const i of r.ids) ids.add(i);
      if (r.ids.length < 51) break;
      if (paginas > 40) break;
    }
    console.log(`   paginas=${paginas}  ids unicos=${ids.size}  ${Date.now() - t0}ms`);
  }

  // ── 3. Quatro dias em PARALELO vs sequencial ─────────────────────
  console.log("\n3. Concorrencia: 4 dias ao mesmo tempo");
  const dias = ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24"];
  {
    const t0 = Date.now();
    for (const d of dias) await pagina(d, d, 0);
    console.log(`   sequencial (4 chamadas): ${Date.now() - t0}ms`);
  }
  {
    const t0 = Date.now();
    const rs = await Promise.all(dias.map((d) => pagina(d, d, 0)));
    const erros = rs.filter((r) => r.status !== 200).length;
    console.log(`   paralelo   (4 chamadas): ${Date.now() - t0}ms  erros=${erros}`);
  }
  {
    // Oito ao mesmo tempo — procurando 429.
    const oito = [...dias, "2026-09-25", "2026-09-26", "2026-09-27", "2026-09-20"];
    const t0 = Date.now();
    const rs = await Promise.all(oito.map((d) => pagina(d, d, 0)));
    const status = rs.map((r) => r.status);
    console.log(`   paralelo   (8 chamadas): ${Date.now() - t0}ms  status=${status.join(",")}`);
  }

  // ── 4. `paging.total` e estavel? ─────────────────────────────────
  console.log("\n4. `paging.total` repete o mesmo numero?");
  {
    const j = ["2026-09-16", "2026-09-27"] as const;
    const t: (number | null)[] = [];
    for (let i = 0; i < 3; i += 1) t.push((await pagina(j[0], j[1], 0)).total);
    console.log(`   totais em 3 leituras: ${t.join(", ")}`);

    // E a contagem REAL, paginando um dia e contando ids unicos.
    const r1 = await pagina("2026-09-22", "2026-09-22", 0);
    const ids = new Set<string>();
    let off = 0;
    for (;;) {
      const p = await pagina("2026-09-22", "2026-09-22", off);
      for (const i of p.ids) ids.add(i);
      if (p.ids.length < 51) break;
      off += 51;
      if (off > 51 * 40) break;
    }
    console.log(`   dia 22/09: paging.total=${String(r1.total)}  ids unicos contados=${ids.size}`);
  }
}

void main();
