/**
 * MEDICAO — `order.date_closed` serve como filtro? — F7b.4.8.5 §5/§9.
 *
 * ── Por que a pergunta importa ──────────────────────────────────────
 *
 * A regra nova de VENDAS BRUTAS recorta por `date_closed` em Sao Paulo. A
 * varredura de hoje busca por `date_created` e alarga a janela em 5 dias,
 * margem herdada do boleto.
 *
 * MEDIDO no dataset de setembro: o atraso entre criacao e fechamento tem
 * p50 de 17 SEGUNDOS, mas o maximo e de 14 DIAS, e 6 pedidos passam de 5
 * dias, somando R$ 212,02. Buscar por criacao com margem de 5 dias
 * perderia esses seis — dinheiro real, nao arredondamento.
 *
 * Uma medicao anterior (F7b.4.8.3) viu `order.date_closed.from/to` FILTRAR
 * de verdade. Se ele pagina e conta como `date_created`, a regra nova
 * busca direto por ele e a margem deixa de existir.
 *
 * READ-ONLY. Nao imprime token nem seller.
 *
 * Roda com: npx tsx scripts/medir-ml-filtro-fechamento.ts
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
const DIAS = ["2026-09-03", "2026-09-15", "2026-09-30"];

type Pedido = { id?: unknown; date_closed?: unknown; date_created?: unknown };

/** O dia civil de Sao Paulo, por Intl — nao por -3h fixo. */
const FORMATO = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Sao_Paulo",
  year: "numeric", month: "2-digit", day: "2-digit",
});
function diaSP(iso: unknown): string | null {
  if (typeof iso !== "string" || iso === "") return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return FORMATO.format(new Date(t));
}

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
  const auth = { Authorization: `Bearer ${loja.accessToken}` };

  /** Varre um dia por um campo de data, como a producao pagina. */
  const varrer = async (campo: string, dia: string) => {
    const unicos = new Set<string>();
    const dentro = new Set<string>();
    const fora: string[] = [];
    let paginas = 0;
    const totais = new Set<number>();
    let offset = 0;
    for (;;) {
      const q = new URLSearchParams({
        seller: loja.sellerId,
        [`${campo}.from`]: `${dia}T00:00:00.000-03:00`,
        [`${campo}.to`]: `${dia}T23:59:59.999-03:00`,
        sort: "date_asc", limit: "51", offset: String(offset),
      });
      const r = await fetch(`${BASE}?${q.toString()}`, { headers: auth });
      if (!r.ok) return { http: r.status, unicos, dentro, fora, paginas, totais };
      const corpo = await r.json() as { paging?: { total?: unknown }; results?: Pedido[] };
      paginas += 1;
      if (typeof corpo.paging?.total === "number") totais.add(corpo.paging.total);
      const lote = corpo.results ?? [];
      for (const o of lote) {
        const id = String(o.id ?? "");
        if (id === "" || unicos.has(id)) continue;
        unicos.add(id);
        const d = diaSP(campo === "order.date_closed" ? o.date_closed : o.date_created);
        if (d === dia) dentro.add(id);
        else if (fora.length < 4) fora.push(`${d}`);
      }
      if (lote.length === 0) break;
      offset += lote.length;
      const menor = totais.size === 0 ? null : Math.min(...totais);
      if (menor !== null && unicos.size >= menor) break;
      if (paginas > 60) break;
    }
    return { http: 200, unicos, dentro, fora, paginas, totais };
  };

  console.log("══ F7b.4.8.5 — `order.date_closed` como filtro ══\n");
  console.log("1. Um dia, pelos dois campos");
  for (const dia of DIAS) {
    for (const campo of ["order.date_created", "order.date_closed"]) {
      const v = await varrer(campo, dia);
      const total = v.totais.size === 0 ? null : Math.min(...v.totais);
      console.log(`   ${dia}  ${campo.padEnd(20)} http=${v.http}  unicos=${String(v.unicos.size).padStart(5)}` +
        `  paging.total=${String(total).padStart(5)}  bate=${total !== null && v.unicos.size >= total ? "sim" : "NAO"}` +
        `  paginas=${v.paginas}`);
      console.log(`        desses, com o campo NO dia pedido (SP): ${v.dentro.size}` +
        (v.fora.length > 0 ? `   fora: ${v.fora.join(", ")}` : ""));
    }
  }

  // ── 2. O mes inteiro por date_closed, dia a dia ─────────────────
  //
  // O dataset ja coletado tem 11.032 pedidos com `date_closed` em
  // setembro (SP). Se a busca por `date_closed` chegar ao mesmo conjunto,
  // a regra nova pode consultar direto e dispensar a margem de criacao.

  console.log("\n2. Setembro inteiro por `order.date_closed`, dia a dia");
  const dias: string[] = [];
  for (let t = Date.UTC(2026, 8, 1, 12); t <= Date.UTC(2026, 8, 30, 12); t += 86400000) {
    dias.push(new Date(t).toISOString().slice(0, 10));
  }
  const todos = new Set<string>();
  const noDiaCerto = new Set<string>();
  let chamadas = 0;
  let incompletos = 0;
  const t0 = Date.now();
  for (let i = 0; i < dias.length; i += 3) {
    const onda = dias.slice(i, i + 3);
    const lidas = await Promise.all(onda.map((d) => varrer("order.date_closed", d)));
    for (let k = 0; k < onda.length; k += 1) {
      const v = lidas[k];
      chamadas += v.paginas;
      const total = v.totais.size === 0 ? null : Math.min(...v.totais);
      if (total === null || v.unicos.size < total) incompletos += 1;
      for (const id of v.unicos) todos.add(id);
      for (const id of v.dentro) noDiaCerto.add(id);
    }
  }
  console.log(`   dias lidos: ${dias.length}   chamadas: ${chamadas}   ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`   dias incompletos: ${incompletos}`);
  console.log(`   pedidos unicos devolvidos: ${todos.size}`);
  console.log(`   desses, com date_closed EM setembro (SP): ${noDiaCerto.size}`);
  console.log(`   o dataset coletado por CRIACAO tinha 11032 com date_closed em setembro (SP)`);
  console.log(`   diferenca: ${11032 - noDiaCerto.size}`);
}

void main();
