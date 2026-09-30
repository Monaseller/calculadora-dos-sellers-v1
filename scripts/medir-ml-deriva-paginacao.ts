/**
 * MEDICAO — duas varreduras completas discordaram. Por que?
 *
 * ── O achado ────────────────────────────────────────────────────────
 *
 * Na suite do §39, a janela 10/09..20/09 foi lida duas vezes, minutos de
 * diferenca, e as duas se declararam COMPLETAS:
 *
 *   oraculo   3305 pedidos   125845.26
 *   agente    3304 pedidos   125802.36
 *
 * Um pedido, 42.90. Agosto, no mesmo par de leituras, reproduziu exato
 * (8841 / 324936.03) — e agosto e velho.
 *
 * ── A hipotese, e como ela se refuta ────────────────────────────────
 *
 * A varredura pagina por OFFSET dentro de um conjunto filtrado por
 * `order.status=paid`. Esse conjunto MUDA: um pedido criado em 12/09 que
 * era `payment_required` e virou `paid` agora ENTRA no meio da ordenacao
 * por `date_created`, empurra os seguintes, e a pagina ja lida perde a
 * linha da fronteira. A pagina final curta continua parecendo completa.
 *
 * Se for isso:
 *   - duas leituras imediatas do MESMO dia recente podem diferir;
 *   - a leitura SEM o filtro de status e estavel, porque `date_created`
 *     de um dia passado nao muda e pedido nao e apagado.
 *
 * Se nao for isso, este script falha em mostrar a diferenca — e a causa
 * e outra.
 *
 * READ-ONLY. Nao imprime token, seller, comprador nem id de pedido.
 *
 * Roda com: npx tsx scripts/medir-ml-deriva-paginacao.ts
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
/** Recente o bastante para ainda haver pedido mudando de status. */
const DIA_RECENTE = "2026-09-26";
/** Velho: agosto reproduziu exato, e a hipotese diz que por isso. */
const DIA_VELHO = "2026-08-12";

type Pagamento = { status?: unknown; date_approved?: unknown };
type Pedido = { id?: unknown; status?: unknown; paid_amount?: unknown; payments?: unknown };

function diaBRT(iso: unknown): string | null {
  if (typeof iso !== "string" || iso === "") return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return new Date(t - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
/** A regra financeira de hoje, copiada para medir. */
function pagoEm(pedido: Pedido): string | null {
  const ps = pedido.payments;
  if (!Array.isArray(ps)) return null;
  for (const p of ps as Pagamento[]) {
    if (p === null || typeof p !== "object") continue;
    if (p.status !== "approved" && p.status !== "partially_refunded") continue;
    const d = diaBRT(p.date_approved);
    if (d !== null) return d;
  }
  return null;
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

  /** Varre UM dia inteiro por offset, como a producao faz. */
  const varrerDia = async (dia: string, comFiltro: boolean) => {
    const ids = new Set<string>();
    const pedidos: Pedido[] = [];
    let paginas = 0;
    let totalRelatado: number | null = null;
    for (let offset = 0; offset < 10000; offset += 51) {
      const q = new URLSearchParams({
        seller: loja.sellerId,
        "order.date_created.from": `${dia}T00:00:00.000-03:00`,
        "order.date_created.to": `${dia}T23:59:59.999-03:00`,
        sort: "date_asc", limit: "51", offset: String(offset),
      });
      if (comFiltro) q.set("order.status", "paid");
      const r = await fetch(`${BASE}?${q.toString()}`, {
        headers: { Authorization: `Bearer ${loja.accessToken}` },
      });
      if (!r.ok) { console.log(`   HTTP ${r.status} em offset ${offset}`); break; }
      const corpo = await r.json() as { paging?: { total?: number }; results?: Pedido[] };
      paginas += 1;
      if (totalRelatado === null && typeof corpo.paging?.total === "number") {
        totalRelatado = corpo.paging.total;
      }
      const lote = corpo.results ?? [];
      for (const o of lote) {
        const id = String(o.id ?? "");
        if (id !== "" && !ids.has(id)) { ids.add(id); pedidos.push(o); }
      }
      if (lote.length < 51) break;
    }
    return { ids, pedidos, paginas, totalRelatado };
  };

  /** So o que a regra financeira conta para aquele dia. */
  const financeiro = (pedidos: Pedido[], dia: string) => {
    const contados = new Set<string>();
    let soma = 0;
    for (const o of pedidos) {
      if (pagoEm(o) !== dia) continue;
      const id = String(o.id ?? "");
      if (id === "" || contados.has(id)) continue;
      contados.add(id);
      soma += typeof o.paid_amount === "number" && Number.isFinite(o.paid_amount)
        ? o.paid_amount : 0;
    }
    return { contados, soma };
  };

  console.log("══ deriva de paginacao sobre conjunto mutavel ══\n");

  // ── 1. O mesmo dia recente, duas vezes, COM o filtro ─────────────

  console.log(`1. ${DIA_RECENTE} — duas varreduras COM order.status=paid`);
  const a1 = await varrerDia(DIA_RECENTE, true);
  const a2 = await varrerDia(DIA_RECENTE, true);
  const soA = [...a1.ids].filter((i) => !a2.ids.has(i)).length;
  const soB = [...a2.ids].filter((i) => !a1.ids.has(i)).length;
  console.log(`   1a: ${a1.ids.size} ids, ${a1.paginas} paginas, paging.total=${a1.totalRelatado}`);
  console.log(`   1b: ${a2.ids.size} ids, ${a2.paginas} paginas, paging.total=${a2.totalRelatado}`);
  console.log(`   so na 1a: ${soA}   so na 1b: ${soB}`);

  // ── 2. O mesmo dia, SEM o filtro, duas vezes ─────────────────────

  console.log(`\n2. ${DIA_RECENTE} — duas varreduras SEM filtro de status`);
  const b1 = await varrerDia(DIA_RECENTE, false);
  const b2 = await varrerDia(DIA_RECENTE, false);
  const soC = [...b1.ids].filter((i) => !b2.ids.has(i)).length;
  const soD = [...b2.ids].filter((i) => !b1.ids.has(i)).length;
  console.log(`   2a: ${b1.ids.size} ids, ${b1.paginas} paginas, paging.total=${b1.totalRelatado}`);
  console.log(`   2b: ${b2.ids.size} ids, ${b2.paginas} paginas, paging.total=${b2.totalRelatado}`);
  console.log(`   so na 2a: ${soC}   so na 2b: ${soD}`);
  console.log(`   custo: ${b1.paginas} paginas sem filtro vs ${a1.paginas} com filtro`);

  // ── 3. O filtro esconde faturamento? ─────────────────────────────

  console.log(`\n3. ${DIA_RECENTE} — o conjunto financeiro de cada caminho`);
  const fComF = financeiro(a1.pedidos, DIA_RECENTE);
  const fSemF = financeiro(b1.pedidos, DIA_RECENTE);
  console.log(`   com filtro: ${fComF.contados.size} pedidos, ${fComF.soma.toFixed(2)}`);
  console.log(`   sem filtro: ${fSemF.contados.size} pedidos, ${fSemF.soma.toFixed(2)}`);
  const perdidos = [...fSemF.contados].filter((i) => !fComF.contados.has(i));
  console.log(`   pagos que o FILTRO deixa de fora: ${perdidos.length}`);
  const statusDosPerdidos = new Map<string, number>();
  for (const o of b1.pedidos) {
    const id = String(o.id ?? "");
    if (!perdidos.includes(id)) continue;
    const st = String(o.status ?? "?");
    statusDosPerdidos.set(st, (statusDosPerdidos.get(st) ?? 0) + 1);
  }
  for (const [k, v] of statusDosPerdidos) console.log(`     ${v}  status=${k}`);

  // ── 4. O dia VELHO, o controle da hipotese ───────────────────────

  console.log(`\n4. ${DIA_VELHO} — CONTROLE: dia velho, com filtro, duas vezes`);
  const c1 = await varrerDia(DIA_VELHO, true);
  const c2 = await varrerDia(DIA_VELHO, true);
  const soE = [...c1.ids].filter((i) => !c2.ids.has(i)).length;
  const soF = [...c2.ids].filter((i) => !c1.ids.has(i)).length;
  console.log(`   4a: ${c1.ids.size} ids, ${c1.paginas} paginas`);
  console.log(`   4b: ${c2.ids.size} ids, ${c2.paginas} paginas`);
  console.log(`   so na 4a: ${soE}   so na 4b: ${soF}`);

  // ── 5. A deriva, provocada de proposito ──────────────────────────
  //
  // Se o conjunto muda no meio da paginacao, uma linha da fronteira se
  // perde. Aqui a paginacao e feita com uma PAUSA entre paginas, para
  // dar tempo de o conjunto mudar — e comparada com a varredura rapida.

  console.log(`\n5. ${DIA_RECENTE} — paginacao LENTA com filtro (2s entre paginas)`);
  const lenta = new Set<string>();
  let pagLenta = 0;
  for (let offset = 0; offset < 10000; offset += 51) {
    const q = new URLSearchParams({
      seller: loja.sellerId, "order.status": "paid",
      "order.date_created.from": `${DIA_RECENTE}T00:00:00.000-03:00`,
      "order.date_created.to": `${DIA_RECENTE}T23:59:59.999-03:00`,
      sort: "date_asc", limit: "51", offset: String(offset),
    });
    const r = await fetch(`${BASE}?${q.toString()}`, {
      headers: { Authorization: `Bearer ${loja.accessToken}` },
    });
    if (!r.ok) break;
    const corpo = await r.json() as { results?: Pedido[] };
    pagLenta += 1;
    const lote = corpo.results ?? [];
    for (const o of lote) {
      const id = String(o.id ?? "");
      if (id !== "") lenta.add(id);
    }
    if (lote.length < 51) break;
    await new Promise((res) => setTimeout(res, 2000));
  }
  const soRapida = [...a1.ids].filter((i) => !lenta.has(i)).length;
  const soLenta = [...lenta].filter((i) => !a1.ids.has(i)).length;
  console.log(`   lenta: ${lenta.size} ids em ${pagLenta} paginas`);
  console.log(`   so na rapida: ${soRapida}   so na lenta: ${soLenta}`);
}

void main();
