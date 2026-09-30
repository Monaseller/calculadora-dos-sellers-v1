/**
 * MEDICAO — o que "Faturamento (pagos)" inclui de verdade — §10.
 *
 * O gate manda auditar caso por caso: pago, estornado em parte, estornado
 * inteiro, cancelado depois de pago, mais de um pagamento, chargeback,
 * pagamento duplicado/reprocessado, pedido com valor alterado. O que nao
 * se conseguir provar sai como ABERTO — nao como suposicao.
 *
 * READ-ONLY. Nao imprime token, seller, comprador nem id de pedido.
 *
 * Roda com: npx tsx scripts/medir-ml-semantica-pagamento.ts
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

/** Agosto: velho o bastante para estorno e cancelamento ja terem acontecido. */
const MES_DE = "2026-08-01";
const MES_ATE = "2026-08-31";
/** A semana em que se abre cada pedido — amostra profunda. */
const SEMANA = ["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04",
  "2026-08-05", "2026-08-06", "2026-08-07"];

type Pagamento = {
  status?: unknown; status_detail?: unknown; date_approved?: unknown;
  transaction_amount?: unknown; total_paid_amount?: unknown;
  transaction_amount_refunded?: unknown; id?: unknown;
};
type Pedido = {
  id?: unknown; status?: unknown; paid_amount?: unknown; total_amount?: unknown;
  payments?: unknown; date_created?: unknown; date_closed?: unknown;
  order_items?: unknown;
};

function n(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
function conta(m: Map<string, number>, chave: string): void {
  m.set(chave, (m.get(chave) ?? 0) + 1);
}
function tabela(titulo: string, m: Map<string, number>): void {
  console.log(`  ${titulo}`);
  const linhas = [...m.entries()].sort((a, b) => b[1] - a[1]);
  if (linhas.length === 0) { console.log("    (nenhum)"); return; }
  for (const [k, v] of linhas) console.log(`    ${v.toString().padStart(6)}  ${k}`);
}

/** A regra de hoje, copiada de `mercado-livre-vendas.ts` para comparar. */
function pagamentoQueContaHoje(pedido: Pedido): Pagamento | null {
  const ps = pedido.payments;
  if (!Array.isArray(ps)) return null;
  for (const p of ps as Pagamento[]) {
    if (p === null || typeof p !== "object") continue;
    if (p.status !== "approved" && p.status !== "partially_refunded") continue;
    if (typeof p.date_approved !== "string" || p.date_approved === "") continue;
    return p;
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

  /** Uma pagina. `status` vazio = SEM o filtro de status do pedido. */
  const pagina = async (de: string, ate: string, offset: number, status: string | null) => {
    const q = new URLSearchParams({
      seller: loja.sellerId,
      "order.date_created.from": `${de}T00:00:00.000-03:00`,
      "order.date_created.to": `${ate}T23:59:59.999-03:00`,
      sort: "date_asc", limit: "51", offset: String(offset),
    });
    if (status !== null) q.set("order.status", status);
    const r = await fetch(`${BASE}?${q.toString()}`, {
      headers: { Authorization: `Bearer ${loja.accessToken}` },
    });
    if (!r.ok) return { http: r.status, total: null as number | null, pedidos: [] as Pedido[] };
    const corpo = await r.json() as { paging?: { total?: number }; results?: Pedido[] };
    return {
      http: r.status,
      total: typeof corpo.paging?.total === "number" ? corpo.paging.total : null,
      pedidos: corpo.results ?? [],
    };
  };

  console.log("══ §10 — o que entra no Faturamento (pagos) ══");
  console.log(`   janela do censo: ${MES_DE}..${MES_ATE}`);
  console.log(`   amostra profunda: ${SEMANA[0]}..${SEMANA[SEMANA.length - 1]}\n`);

  // ── 1. Quem o filtro `order.status=paid` deixa de fora ────────────
  //
  // A consulta da CDS filtra `order.status=paid` na ORIGEM. Entao o
  // primeiro fato a medir e o tamanho do que esse filtro remove.

  console.log("1. O filtro `order.status=paid`, por dia de criacao");
  let totalComFiltro = 0;
  let totalSemFiltro = 0;
  for (const dia of SEMANA) {
    const comF = await pagina(dia, dia, 0, "paid");
    const semF = await pagina(dia, dia, 0, null);
    totalComFiltro += comF.total ?? 0;
    totalSemFiltro += semF.total ?? 0;
  }
  console.log(`   paid=${totalComFiltro}   sem filtro=${totalSemFiltro}` +
    `   fora=${totalSemFiltro - totalComFiltro}`);

  // ── 2. Cada pedido da semana, aberto ─────────────────────────────

  console.log("\n2. Abrindo cada pedido da semana (sem filtro de status)");
  const statusDoPedido = new Map<string, number>();
  const statusDoPagamento = new Map<string, number>();
  const detalheDoPagamento = new Map<string, number>();
  const qtdDePagamentos = new Map<string, number>();

  let pedidosVistos = 0;
  /** Pedido com mais de um pagamento APROVADO. */
  let maisDeUmAprovado = 0;
  /** Nesses, a regra de hoje pega o PRIMEIRO; seria outro dia se pegasse o menor? */
  let primeiroDifereDoMaisAntigo = 0;
  /** Pedido nao-`paid` que TEM pagamento aprovado — o que o filtro remove. */
  let naoPaidComAprovado = 0;
  const statusDosRemovidos = new Map<string, number>();
  /** `paid_amount` diferente da soma dos pagamentos que contam. */
  let paidDifereDaSoma = 0;
  let somaPaidAmount = 0;
  let somaTransacoes = 0;
  /** Estorno registrado no pagamento. */
  let comEstornoParcial = 0;
  let somaEstornada = 0;
  /** `paid_amount` ausente ou zero num pedido que conta. */
  let contaSemValor = 0;
  /** `total_amount` != `paid_amount` — valor alterado / frete. */
  let paidDifereDeTotal = 0;

  for (const dia of SEMANA) {
    for (let offset = 0; offset < 10000; offset += 51) {
      const p = await pagina(dia, dia, offset, null);
      if (p.pedidos.length === 0) break;
      for (const o of p.pedidos) {
        pedidosVistos += 1;
        const st = String(o.status ?? "?");
        conta(statusDoPedido, st);

        const ps = Array.isArray(o.payments) ? (o.payments as Pagamento[]) : [];
        conta(qtdDePagamentos, `${ps.length} pagamento(s)`);
        for (const pg of ps) {
          conta(statusDoPagamento, String(pg?.status ?? "?"));
          conta(detalheDoPagamento, `${String(pg?.status ?? "?")} / ${String(pg?.status_detail ?? "?")}`);
          const estornado = n(pg?.transaction_amount_refunded);
          if (estornado > 0) { comEstornoParcial += 1; somaEstornada += estornado; }
        }

        const aprovados = ps.filter((pg) =>
          pg?.status === "approved" || pg?.status === "partially_refunded");
        if (aprovados.length > 1) {
          maisDeUmAprovado += 1;
          const datas = aprovados
            .map((pg) => typeof pg.date_approved === "string" ? pg.date_approved : "")
            .filter((d) => d !== "").sort();
          const escolhido = pagamentoQueContaHoje(o);
          const escolhida = typeof escolhido?.date_approved === "string"
            ? escolhido.date_approved : "";
          if (datas.length > 1 && escolhida !== datas[0]) primeiroDifereDoMaisAntigo += 1;
        }

        const contaHoje = pagamentoQueContaHoje(o) !== null;
        if (contaHoje && st !== "paid") {
          naoPaidComAprovado += 1;
          conta(statusDosRemovidos, st);
        }

        if (contaHoje && st === "paid") {
          const pago = n(o.paid_amount);
          const soma = aprovados.reduce((acc, pg) => acc + n(pg.transaction_amount), 0);
          somaPaidAmount += pago;
          somaTransacoes += soma;
          if (Math.abs(pago - soma) > 0.01) paidDifereDaSoma += 1;
          if (pago <= 0) contaSemValor += 1;
          if (Math.abs(pago - n(o.total_amount)) > 0.01) paidDifereDeTotal += 1;
        }
      }
      if (p.pedidos.length < 51) break;
    }
  }

  console.log(`   pedidos abertos: ${pedidosVistos}`);
  tabela("status do PEDIDO:", statusDoPedido);
  tabela("status do PAGAMENTO:", statusDoPagamento);
  tabela("quantidade de pagamentos por pedido:", qtdDePagamentos);

  console.log("\n3. Os casos que o §10 pede, um por um");
  console.log(`   a) pedido com >1 pagamento APROVADO ............ ${maisDeUmAprovado}`);
  console.log(`      deles, em que a regra de hoje NAO pega o mais antigo: ${primeiroDifereDoMaisAntigo}`);
  console.log(`   b) pedido NAO-paid com pagamento aprovado ..... ${naoPaidComAprovado}`);
  tabela("     status desses removidos:", statusDosRemovidos);
  console.log(`   c) pagamento com estorno registrado ........... ${comEstornoParcial}`);
  console.log(`      soma estornada nesses pagamentos ........... ${somaEstornada.toFixed(2)}`);
  console.log(`   d) paid_amount != soma dos pagamentos que contam: ${paidDifereDaSoma}`);
  console.log(`      soma paid_amount ${somaPaidAmount.toFixed(2)} vs transacoes ${somaTransacoes.toFixed(2)}`);
  console.log(`   e) pedido que conta com paid_amount <= 0 ....... ${contaSemValor}`);
  console.log(`   f) paid_amount != total_amount ................ ${paidDifereDeTotal}`);

  console.log("\n4. Detalhe de status de pagamento (chargeback aparece aqui?)");
  tabela("status / status_detail:", detalheDoPagamento);

  // ── 5. O censo do mes, por contagem ──────────────────────────────
  //
  // Barato: `paging.total` por dia, com e sem o filtro. Nao serve como
  // criterio de completude (medido no §7), mas serve para dimensionar.

  console.log("\n5. O mes inteiro, so em contagem");
  let mesPaid = 0;
  let mesTudo = 0;
  const diasDoMes: string[] = [];
  for (let d = new Date(`${MES_DE}T12:00:00Z`).getTime();
    d <= new Date(`${MES_ATE}T12:00:00Z`).getTime(); d += 86400000) {
    diasDoMes.push(new Date(d).toISOString().slice(0, 10));
  }
  for (const dia of diasDoMes) {
    const a = await pagina(dia, dia, 0, "paid");
    const b = await pagina(dia, dia, 0, null);
    mesPaid += a.total ?? 0;
    mesTudo += b.total ?? 0;
  }
  console.log(`   ${MES_DE}..${MES_ATE}: paid=${mesPaid} tudo=${mesTudo} fora=${mesTudo - mesPaid}`);
}

void main();
