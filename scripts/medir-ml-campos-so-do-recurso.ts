/**
 * MEDICAO — os campos que a BUSCA nao mostra — F7b.4.8.4 §12/§17/§46.
 *
 * MEDIDO em `medir-ml-forma-do-payload.ts`: `/orders/{id}` tem dois campos
 * monetarios que `/orders/search` nao tem —
 *
 *   order_items[].discounts
 *   payments[].marketplace_fee
 *
 * Toda a reconciliacao foi feita sobre a BUSCA. Se `discounts` carregasse
 * valor material, a auditoria estaria cega para parte do dinheiro, e a
 * hipotese do Rodrigo ("talvez a coluna errada") ganharia uma frente nova.
 *
 * ── Amostra, e nao censo ────────────────────────────────────────────
 *
 * Abrir os 11 mil pedidos de setembro custaria ~11 mil chamadas. A amostra
 * e ESTRATIFICADA pelos casos onde o desconto teria onde se esconder:
 * cupom > 0, gross_price != total_amount, estorno, e um bloco aleatorio
 * como controle. Se nem nesses o campo tiver valor, ele nao explica R$ 10
 * mil no mes.
 *
 * READ-ONLY. Nao imprime token, seller nem comprador.
 *
 * Roda com: npx tsx scripts/medir-ml-campos-so-do-recurso.ts
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
const BASE = "https://api.mercadolibre.com";
const ORIGEM = join("C:", "Users", "USER", "AppData", "Local", "Temp", "claude",
  "c--Users-USER-Desktop-calculadora-dos-sellers-v1",
  "c9e0b194-ce1f-484c-80df-7b403c7a8702", "scratchpad", "ml-setembro");
/** Por estrato. Quatro estratos = ~200 chamadas. */
const POR_ESTRATO = 50;

function n(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
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

  interface Coletado {
    id: string; date_created: string | null; total_amount: number | null;
    paid_amount: number | null; coupon_amount: number | null;
    itens: { quantity: number | null; unit_price: number | null; gross_price: number | null }[];
    pagamentos: { transaction_amount_refunded: number | null }[];
  }
  const linhas = readFileSync(join(ORIGEM, "pedidos.jsonl"), "utf8").trim().split("\n");
  const porId = new Map<string, Coletado>();
  for (const l of linhas) {
    const o = JSON.parse(l) as Coletado;
    if (!porId.has(o.id)) porId.set(o.id, o);
  }
  const setembro = [...porId.values()].filter((o) =>
    (o.date_created ?? "").slice(0, 10) >= "2026-09-01" &&
    (o.date_created ?? "").slice(0, 10) <= "2026-09-30");

  const grossDaLinha = (o: Coletado) => o.itens.reduce((a, it) => a + n(it.gross_price), 0);
  const estratos: { nome: string; ids: string[] }[] = [
    {
      nome: "cupom > 0",
      ids: setembro.filter((o) => n(o.coupon_amount) > 0).map((o) => o.id),
    },
    {
      nome: "gross != total",
      ids: setembro.filter((o) =>
        Math.abs(grossDaLinha(o) - n(o.total_amount)) > 0.005).map((o) => o.id),
    },
    {
      nome: "com estorno",
      ids: setembro.filter((o) =>
        o.pagamentos.some((p) => n(p.transaction_amount_refunded) > 0)).map((o) => o.id),
    },
    {
      nome: "CONTROLE aleatorio",
      ids: setembro.map((o) => o.id),
    },
  ];

  console.log("══ F7b.4.8.4 §12/§46 — os campos que so o recurso mostra ══\n");

  for (const e of estratos) {
    // Amostra espalhada, e nao os primeiros: os primeiros sao do comeco do
    // mes e poderiam compartilhar uma promocao especifica.
    const passo = Math.max(1, Math.floor(e.ids.length / POR_ESTRATO));
    const amostra = e.ids.filter((_, i) => i % passo === 0).slice(0, POR_ESTRATO);

    let abertos = 0;
    let comDiscounts = 0;
    let somaDiscounts = 0;
    let somaMarketplaceFee = 0;
    let comMarketplaceFee = 0;
    let somaTotal = 0;
    const formas = new Map<string, number>();

    for (const id of amostra) {
      const r = await fetch(`${BASE}/orders/${id}`, { headers: auth });
      if (!r.ok) continue;
      const o = await r.json() as Record<string, unknown>;
      abertos += 1;
      somaTotal += n(o.total_amount);

      const itens = Array.isArray(o.order_items) ? o.order_items as Record<string, unknown>[] : [];
      for (const it of itens) {
        const d = it.discounts;
        if (d === null || d === undefined) { formas.set("null", (formas.get("null") ?? 0) + 1); continue; }
        if (Array.isArray(d)) {
          formas.set(`array(${d.length})`, (formas.get(`array(${d.length})`) ?? 0) + 1);
          if (d.length > 0) comDiscounts += 1;
          for (const x of d) {
            if (typeof x === "object" && x !== null) {
              for (const v of Object.values(x as Record<string, unknown>)) {
                if (typeof v === "number" && Number.isFinite(v)) somaDiscounts += v;
              }
            }
          }
          continue;
        }
        if (typeof d === "object") {
          formas.set("object", (formas.get("object") ?? 0) + 1);
          comDiscounts += 1;
          for (const v of Object.values(d as Record<string, unknown>)) {
            if (typeof v === "number" && Number.isFinite(v)) somaDiscounts += v;
          }
          continue;
        }
        formas.set(typeof d, (formas.get(typeof d) ?? 0) + 1);
      }

      const pags = Array.isArray(o.payments) ? o.payments as Record<string, unknown>[] : [];
      for (const p of pags) {
        const f = p.marketplace_fee;
        if (typeof f === "number" && Number.isFinite(f)) {
          comMarketplaceFee += 1;
          somaMarketplaceFee += f;
        }
      }
    }

    console.log(`${e.nome}  (populacao ${e.ids.length}, amostra ${abertos})`);
    console.log(`   formas de order_items[].discounts: ` +
      ([...formas.entries()].map(([k, v]) => `${k}=${v}`).join(", ") || "(nenhuma)"));
    console.log(`   itens com desconto preenchido ... ${comDiscounts}`);
    console.log(`   soma dos numeros em discounts ... ${somaDiscounts.toFixed(2)}`);
    console.log(`   pagamentos com marketplace_fee . ${comMarketplaceFee}`);
    console.log(`   soma de marketplace_fee ........ ${somaMarketplaceFee.toFixed(2)}`);
    console.log(`   soma de total_amount na amostra  ${somaTotal.toFixed(2)}`);
    console.log(`   desconto como % do total ....... ` +
      `${somaTotal === 0 ? "-" : (somaDiscounts / somaTotal * 100).toFixed(2)}%\n`);
  }

  // ── §34: existe relatorio oficial pela API? ──────────────────────
  //
  // `/users/{id}/invoices` respondeu 405 (GET nao suportado), o que diz
  // que a rota existe. Vale medir as vizinhas antes de concluir.

  console.log("§34 — candidatos a relatorio/faturamento oficial (so o status)");
  const candidatos = [
    "/billing/integration/periods",
    "/billing/integration/group/MP/periods",
    `/users/${loja.sellerId}/invoices/period`,
    "/orders/search/pending",
    `/sites/MLB/search?seller_id=${loja.sellerId}&limit=1`,
    "/users/me",
  ];
  for (const caminho of candidatos) {
    try {
      const r = await fetch(`${BASE}${caminho}`, { headers: auth });
      const corpo = await r.text();
      console.log(`   ${String(r.status).padStart(3)}  ${caminho.replace(loja.sellerId, "<seller>")}` +
        `  ${corpo.slice(0, 60).replace(/\s+/g, " ")}`);
    } catch (e) {
      console.log(`   ERR  ${caminho.replace(loja.sellerId, "<seller>")}`);
    }
  }
}

void main();
