/**
 * MEDICAO — a janela 10/09..20/09 discordou de si mesma. Quem saiu?
 *
 * ── O que ja se sabe ────────────────────────────────────────────────
 *
 *   oraculo, 21:0x   3305 pedidos   125845.26
 *   agente,  ~4min depois   3304 pedidos   125802.36
 *   diferenca:  1 pedido,  42.90
 *
 * A hipotese de deriva de paginacao foi REFUTADA: `medir-ml-deriva-
 * paginacao` mostrou o dia recente estavel em varredura rapida, em
 * varredura lenta com 2s entre paginas, com filtro e sem filtro.
 *
 * ── A hipotese que sobra ────────────────────────────────────────────
 *
 * O conjunto nao derivou; o DADO mudou. Um pedido pago dentro da janela
 * foi estornado ou cancelado no intervalo, e o pagamento dele deixou de
 * ser `approved` — entao a regra financeira, corretamente, parou de
 * conta-lo.
 *
 * Isso nao e defeito de varredura. E uma propriedade do numero, e ela
 * precisa de nome: faturamento de periodo passado NAO e imutavel.
 *
 * Como se refuta: se a janela agora estiver estavel em duas leituras
 * consecutivas e existir, no conjunto SEM filtro, um pedido de 42.90 com
 * pagamento nao-aprovado e `date_approved` dentro da janela, a hipotese
 * esta demonstrada. Se nao existir, ela cai.
 *
 * READ-ONLY. Nao imprime token, seller, comprador nem id de pedido.
 *
 * Roda com: npx tsx scripts/medir-ml-janela-divergente.ts
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
/** A janela financeira que discordou. */
const DE = "2026-09-10";
const ATE = "2026-09-20";
/** A mesma margem de criacao que a producao usa. */
const MARGEM_DIAS = 5;
/** O valor exato do pedido que sumiu. */
const VALOR_PROCURADO = 42.90;

type Pagamento = {
  status?: unknown; status_detail?: unknown; date_approved?: unknown;
  transaction_amount_refunded?: unknown;
};
type Pedido = {
  id?: unknown; status?: unknown; paid_amount?: unknown; payments?: unknown;
};

function diaBRT(iso: unknown): string | null {
  if (typeof iso !== "string" || iso === "") return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return new Date(t - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
function valor(o: Pedido): number {
  return typeof o.paid_amount === "number" && Number.isFinite(o.paid_amount)
    ? o.paid_amount : 0;
}
/** A regra de hoje: primeiro pagamento aprovado ou estornado em parte. */
function pagoEm(o: Pedido): string | null {
  const ps = o.payments;
  if (!Array.isArray(ps)) return null;
  for (const p of ps as Pagamento[]) {
    if (p === null || typeof p !== "object") continue;
    if (p.status !== "approved" && p.status !== "partially_refunded") continue;
    const d = diaBRT(p.date_approved);
    if (d !== null) return d;
  }
  return null;
}
/** QUALQUER pagamento com data dentro da janela, aprovado ou nao. */
function temPagamentoNaJanela(o: Pedido): Pagamento | null {
  const ps = o.payments;
  if (!Array.isArray(ps)) return null;
  for (const p of ps as Pagamento[]) {
    if (p === null || typeof p !== "object") continue;
    const d = diaBRT(p.date_approved);
    if (d !== null && d >= DE && d <= ATE) return p;
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

  const criacaoDe = new Date(new Date(`${DE}T12:00:00Z`).getTime()
    - MARGEM_DIAS * 86400000).toISOString().slice(0, 10);
  const dias: string[] = [];
  for (let d = new Date(`${criacaoDe}T12:00:00Z`).getTime();
    d <= new Date(`${ATE}T12:00:00Z`).getTime(); d += 86400000) {
    dias.push(new Date(d).toISOString().slice(0, 10));
  }

  const varrer = async (comFiltro: boolean) => {
    const porId = new Map<string, Pedido>();
    let paginas = 0;
    for (const dia of dias) {
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
        if (!r.ok) { console.log(`   HTTP ${r.status}`); break; }
        const corpo = await r.json() as { results?: Pedido[] };
        paginas += 1;
        const lote = corpo.results ?? [];
        for (const o of lote) {
          const id = String(o.id ?? "");
          if (id !== "" && !porId.has(id)) porId.set(id, o);
        }
        if (lote.length < 51) break;
      }
    }
    return { porId, paginas };
  };

  /** O que a regra financeira conta na janela. */
  const contar = (porId: Map<string, Pedido>) => {
    const ids = new Set<string>();
    let soma = 0;
    for (const [id, o] of porId) {
      const d = pagoEm(o);
      if (d === null || d < DE || d > ATE) continue;
      ids.add(id);
      soma += valor(o);
    }
    return { ids, soma };
  };

  console.log("══ a janela que discordou de si mesma ══");
  console.log(`   financeira ${DE}..${ATE}, criacao desde ${criacaoDe} (${dias.length} dias)\n`);

  console.log("1. Duas varreduras consecutivas, como a producao faz");
  const v1 = await varrer(true);
  const c1 = contar(v1.porId);
  const v2 = await varrer(true);
  const c2 = contar(v2.porId);
  console.log(`   1a: ${c1.ids.size} pedidos, ${c1.soma.toFixed(2)}  (${v1.paginas} paginas)`);
  console.log(`   1b: ${c2.ids.size} pedidos, ${c2.soma.toFixed(2)}  (${v2.paginas} paginas)`);
  const soA = [...c1.ids].filter((i) => !c2.ids.has(i));
  const soB = [...c2.ids].filter((i) => !c1.ids.has(i));
  console.log(`   so na 1a: ${soA.length}   so na 1b: ${soB.length}`);
  console.log(`   ORACULO de ontem: 3305 / 125845.26`);
  console.log(`   AGENTE  de ontem: 3304 / 125802.36`);

  console.log("\n2. Sem filtro de status — quem tem pagamento na janela e NAO conta");
  const v3 = await varrer(false);
  const c3 = contar(v3.porId);
  console.log(`   sem filtro: ${v3.porId.size} pedidos lidos, ${c3.ids.size} contados, ${c3.soma.toFixed(2)}`);

  const naoContados: { status: string; pagStatus: string; detalhe: string; valor: number }[] = [];
  for (const [id, o] of v3.porId) {
    if (c3.ids.has(id)) continue;
    const p = temPagamentoNaJanela(o);
    if (p === null) continue;
    naoContados.push({
      status: String(o.status ?? "?"),
      pagStatus: String(p.status ?? "?"),
      detalhe: String(p.status_detail ?? "?"),
      valor: valor(o),
    });
  }
  console.log(`   pedidos com pagamento DATADO na janela que nao contam: ${naoContados.length}`);
  const porCombinacao = new Map<string, { n: number; soma: number }>();
  for (const x of naoContados) {
    const k = `pedido=${x.status} pagamento=${x.pagStatus}/${x.detalhe}`;
    const atual = porCombinacao.get(k) ?? { n: 0, soma: 0 };
    porCombinacao.set(k, { n: atual.n + 1, soma: atual.soma + x.valor });
  }
  for (const [k, v] of [...porCombinacao.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`     ${String(v.n).padStart(5)}  ${v.soma.toFixed(2).padStart(12)}  ${k}`);
  }

  // ── O que o filtro de status ESCONDE, e nao o que ele remove ──────
  //
  // Estes contam pela regra financeira (pagamento aprovado, datado na
  // janela) e mesmo assim nao aparecem na varredura filtrada. E dinheiro
  // que a resposta do agente nao esta somando.
  console.log("\n2b. Contam pela regra, mas o filtro `order.status=paid` remove");
  const escondidos = [...c3.ids].filter((i) => !c1.ids.has(i));
  console.log(`   quantidade: ${escondidos.length}`);
  const porStatus = new Map<string, { n: number; soma: number }>();
  for (const id of escondidos) {
    const o = v3.porId.get(id);
    if (o === undefined) continue;
    const ps = Array.isArray(o.payments) ? (o.payments as Pagamento[]) : [];
    const aprovado = ps.find((p) =>
      p?.status === "approved" || p?.status === "partially_refunded");
    const k = `pedido=${String(o.status ?? "?")} pagamento=` +
      `${String(aprovado?.status ?? "?")}/${String(aprovado?.status_detail ?? "?")}`;
    const atual = porStatus.get(k) ?? { n: 0, soma: 0 };
    porStatus.set(k, { n: atual.n + 1, soma: atual.soma + valor(o) });
  }
  for (const [k, v] of [...porStatus.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`     ${String(v.n).padStart(5)}  ${v.soma.toFixed(2).padStart(12)}  ${k}`);
  }
  console.log(`   custo da varredura sem filtro: ${v3.paginas} paginas vs ${v1.paginas} com filtro`);

  console.log(`\n3. Algum deles vale exatamente ${VALOR_PROCURADO.toFixed(2)}?`);
  const candidatos = naoContados.filter((x) =>
    Math.abs(x.valor - VALOR_PROCURADO) < 0.005);
  console.log(`   candidatos: ${candidatos.length}`);
  for (const x of candidatos) {
    console.log(`     pedido=${x.status}  pagamento=${x.pagStatus}/${x.detalhe}  ${x.valor.toFixed(2)}`);
  }
}

void main();
