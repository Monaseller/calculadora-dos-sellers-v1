/**
 * MEDICAO — em que fuso o Mercado Livre pensa — F7b.4.8.4 §13/§18.
 *
 * ── Por que isto importa ────────────────────────────────────────────
 *
 * MEDIDO: as 18.019 datas de `date_created` da coleta vem TODAS com
 * offset `-04:00`, e nao `-03:00`. A CDS converte o instante para o dia
 * civil de Sao Paulo (-03:00) porque e essa a regra da casa. Na virada do
 * mes as duas convencoes discordam: um pedido feito 30/09 as 23h30 em
 * -04:00 e 01/10 as 00h30 em -03:00.
 *
 * Com a data COMO ESCRITA, setembro fechou nos dois precos medios do
 * painel ao mesmo tempo — 36,14 e 34,67, exatos. Entao o fuso nao e
 * detalhe: ele e parte da divergencia.
 *
 * Este script responde duas perguntas que so a API responde:
 *
 *   1. o filtro `order.date_created.from/to` respeita o offset enviado?
 *   2. a coleta perdeu pedido? (o buraco de 4 pedidos / R$ 81,00)
 *
 * READ-ONLY. Nao imprime token nem seller.
 *
 * Roda com: npx tsx scripts/medir-ml-fuso-da-janela.ts
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
  const auth = { Authorization: `Bearer ${loja.accessToken}` };

  const consultar = async (de: string, ate: string) => {
    const q = new URLSearchParams({
      seller: loja.sellerId,
      "order.date_created.from": de, "order.date_created.to": ate,
      sort: "date_asc", limit: "51", offset: "0",
    });
    const r = await fetch(`${BASE}?${q.toString()}`, { headers: auth });
    if (!r.ok) return { http: r.status, total: null as number | null, datas: [] as string[] };
    const corpo = await r.json() as {
      paging?: { total?: unknown }; results?: { date_created?: unknown }[];
    };
    const t = corpo.paging?.total;
    return {
      http: r.status,
      total: typeof t === "number" ? t : null,
      datas: (corpo.results ?? [])
        .map((o) => typeof o.date_created === "string" ? o.date_created : "")
        .filter((d) => d !== ""),
    };
  };

  console.log("══ F7b.4.8.4 — o fuso da janela ══\n");

  // ── 1. O filtro respeita o offset enviado? ───────────────────────
  //
  // Um dia pedido em -04:00 tem de devolver pedidos cuja data ESCRITA e
  // daquele dia. Se o provedor ignorasse o offset, apareceria data de
  // outro dia na borda.

  console.log("1. Um dia pedido em -04:00 (a convencao do proprio provedor)");
  const em04 = await consultar("2026-09-15T00:00:00.000-04:00", "2026-09-15T23:59:59.999-04:00");
  const escritas04 = new Set(em04.datas.map((d) => d.slice(0, 10)));
  console.log(`   total=${em04.total}  datas escritas na 1a pagina: ${[...escritas04].join(", ")}`);

  console.log("\n2. O MESMO dia pedido em -03:00 (a convencao da CDS)");
  const em03 = await consultar("2026-09-15T00:00:00.000-03:00", "2026-09-15T23:59:59.999-03:00");
  const escritas03 = new Set(em03.datas.map((d) => d.slice(0, 10)));
  console.log(`   total=${em03.total}  datas escritas na 1a pagina: ${[...escritas03].join(", ")}`);
  console.log(`   diferenca de total: ${(em04.total ?? 0) - (em03.total ?? 0)}`);

  // ── 3. Setembro inteiro, nas duas convencoes ─────────────────────
  //
  // `paging.total` de janela larga foi MEDIDO como nao confiavel na
  // F7b.4.8.3 (3572 contra 3642 somando os dias). Serve aqui para
  // dimensionar um buraco de 4 pedidos, nao para fechar conta.

  console.log("\n3. Setembro inteiro — `paging.total` de janela larga");
  const mes04 = await consultar("2026-09-01T00:00:00.000-04:00", "2026-09-30T23:59:59.999-04:00");
  const mes03 = await consultar("2026-09-01T00:00:00.000-03:00", "2026-09-30T23:59:59.999-03:00");
  console.log(`   em -04:00: ${mes04.total}`);
  console.log(`   em -03:00: ${mes03.total}`);
  console.log(`   a coleta, por data ESCRITA, achou 11028 pedidos em setembro`);
  console.log(`   a coleta, por dia BRT,       achou 11026 pedidos em setembro`);
  console.log(`   LEMBRETE: total de janela larga nao fecha com a soma dos dias (medido)`);

  // ── 4. A borda, pedido por pedido ────────────────────────────────
  //
  // O que existe entre 23:00 e 00:00 de -04:00 no ultimo dia do mes e
  // exatamente o que muda de competencia entre as duas convencoes.

  console.log("\n4. A borda do fim de setembro (30/09 23:00–24:00 em -04:00)");
  const borda = await consultar("2026-09-30T23:00:00.000-04:00", "2026-09-30T23:59:59.999-04:00");
  console.log(`   total=${borda.total}  (a coleta viu 6 pedidos nessa faixa)`);
  for (const d of borda.datas) console.log(`     ${d}`);

  console.log("\n5. A borda do fim de agosto (31/08 23:00–24:00 em -04:00)");
  const borda2 = await consultar("2026-08-31T23:00:00.000-04:00", "2026-08-31T23:59:59.999-04:00");
  console.log(`   total=${borda2.total}`);
  for (const d of borda2.datas) console.log(`     ${d}`);
}

void main();
