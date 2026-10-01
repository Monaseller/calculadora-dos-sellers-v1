/**
 * COLETA — o dataset de setembro/2026, cru e completo — F7b.4.8.4 §8.
 *
 * Le UMA vez e grava em disco. Toda analise depois roda sobre o arquivo,
 * sem tocar a API de novo: perícia exige reler os mesmos dados dezenas de
 * vezes, e refazer a varredura a cada pergunta mediria a loja mudando em
 * vez de medir a regra.
 *
 * ── A janela e maior que setembro, de proposito ─────────────────────
 *
 * O §18 manda testar atribuicao por `date_created`, por `date_closed` e
 * por `payments[].date_approved`. Essas tres recortam populacoes
 * diferentes: um pedido fechado em setembro pode ter nascido em agosto, e
 * um pago em setembro tambem. Buscar so setembro de criacao responderia
 * uma pergunta e cegaria as outras duas.
 *
 * ── O que NAO e gravado ─────────────────────────────────────────────
 *
 * Comprador, vendedor, apelido, nome, endereco, telefone, documento,
 * titulo de anuncio, SKU e `payments[].reason`. A pericia e sobre
 * dinheiro, data e status; dado pessoal de terceiro nao entra em planilha
 * de diagnostico. `order_id` fica, porque e por ele que o Rodrigo precisa
 * achar o mesmo pedido nos tres arquivos (§40).
 *
 * READ-ONLY. Nenhuma mutacao, nenhum token impresso.
 *
 * Roda com: npx tsx scripts/medir-ml-coletar-setembro.ts
 */
import "./_server-only-inerte";

import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
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
const DESTINO = process.env.DESTINO ??
  join("C:", "Users", "USER", "AppData", "Local", "Temp", "claude",
    "c--Users-USER-Desktop-calculadora-dos-sellers-v1",
    "c9e0b194-ce1f-484c-80df-7b403c7a8702", "scratchpad", "ml-setembro");

/** Janela de CRIACAO coletada. Larga para servir as tres atribuicoes. */
const CRIACAO_DE = "2026-08-10";
const CRIACAO_ATE = "2026-10-06";

const LIMITE = 51;
const CONCORRENCIA = 3;
const MAX_PAGINAS_DIA = 60;
const TENTATIVAS_DIA = 3;
const TENTATIVAS_429 = 4;

type Bruto = Record<string, unknown>;

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function txt(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/**
 * A projecao que vai para disco.
 *
 * Lista EXPLICITA. Uma projecao por exclusao ("tudo menos comprador")
 * passaria a gravar qualquer campo pessoal que o provedor acrescentasse
 * depois — e o default de uma planilha de diagnostico tem de ser NAO
 * gravar.
 */
function projetar(o: Bruto): Record<string, unknown> {
  const itens = Array.isArray(o.order_items) ? o.order_items as Bruto[] : [];
  const pagamentos = Array.isArray(o.payments) ? o.payments as Bruto[] : [];
  const cancel = (o.cancel_detail ?? null) as Bruto | null;
  const cupom = (o.coupon ?? null) as Bruto | null;
  const impostos = (o.taxes ?? null) as Bruto | null;
  return {
    id: String(o.id ?? ""),
    status: txt(o.status),
    status_detail: txt(o.status_detail),
    date_created: txt(o.date_created),
    date_closed: txt(o.date_closed),
    last_updated: txt(o.last_updated),
    expiration_date: txt(o.expiration_date),
    currency_id: txt(o.currency_id),
    total_amount: num(o.total_amount),
    paid_amount: num(o.paid_amount),
    shipping_cost_pedido: num(o.shipping_cost),
    coupon_amount: cupom === null ? null : num(cupom.amount),
    taxes_amount: impostos === null ? null : num(impostos.amount),
    cancel_group: cancel === null ? null : txt(cancel.group),
    cancel_code: cancel === null ? null : txt(cancel.code),
    cancel_date: cancel === null ? null : txt(cancel.date),
    mediacoes: Array.isArray(o.mediations) ? (o.mediations as unknown[]).length : 0,
    pack_id: o.pack_id === null || o.pack_id === undefined ? null : String(o.pack_id),
    fulfilled: typeof o.fulfilled === "boolean" ? o.fulfilled : null,
    // `tags` descreve o ESTADO do pedido ("paid", "delivered"); nao ha
    // dado de pessoa nelas, e elas explicam exclusao.
    tags: Array.isArray(o.tags) ? (o.tags as unknown[]).map(String) : [],
    itens: itens.map((it) => {
      const item = (it.item ?? null) as Bruto | null;
      return {
        quantity: num(it.quantity),
        unit_price: num(it.unit_price),
        gross_price: num(it.gross_price),
        sale_fee: num(it.sale_fee),
        listing_type_id: txt(it.listing_type_id),
        item_id: item === null ? null : txt(item.id),
        category_id: item === null ? null : txt(item.category_id),
      };
    }),
    pagamentos: pagamentos.map((p) => ({
      id: String(p.id ?? ""),
      status: txt(p.status),
      status_detail: txt(p.status_detail),
      date_approved: txt(p.date_approved),
      date_created: txt(p.date_created),
      date_last_modified: txt(p.date_last_modified),
      transaction_amount: num(p.transaction_amount),
      total_paid_amount: num(p.total_paid_amount),
      shipping_cost: num(p.shipping_cost),
      taxes_amount: num(p.taxes_amount),
      coupon_amount: num(p.coupon_amount),
      overpaid_amount: num(p.overpaid_amount),
      transaction_amount_refunded: num(p.transaction_amount_refunded),
      installments: num(p.installments),
      installment_amount: num(p.installment_amount),
      payment_type: txt(p.payment_type),
      operation_type: txt(p.operation_type),
      payment_method_id: txt(p.payment_method_id),
    })),
  };
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

  mkdirSync(DESTINO, { recursive: true });
  const arquivoPedidos = join(DESTINO, "pedidos.jsonl");
  writeFileSync(arquivoPedidos, "", "utf8");

  const dias: string[] = [];
  for (let t = new Date(`${CRIACAO_DE}T12:00:00Z`).getTime();
    t <= new Date(`${CRIACAO_ATE}T12:00:00Z`).getTime(); t += 86400000) {
    dias.push(new Date(t).toISOString().slice(0, 10));
  }

  console.log("══ F7b.4.8.4 — coleta de setembro/2026 ══");
  console.log(`   janela de criacao: ${CRIACAO_DE}..${CRIACAO_ATE} (${dias.length} dias)`);
  console.log(`   destino: ${DESTINO}\n`);

  interface Dia {
    readonly dia: string;
    readonly unicos: number;
    readonly total: number | null;
    readonly paginas: number;
    readonly completo: boolean;
    readonly passadas: number;
  }
  const relatorioDias: Dia[] = [];
  let gravados = 0;
  const t0 = Date.now();

  /** Um dia, com a mesma disciplina da producao. */
  const lerDia = async (dia: string): Promise<{ dia: Dia; linhas: string[] }> => {
    const vistos = new Set<string>();
    const linhas: string[] = [];
    let paginas = 0;
    let totalRelatado: number | null = null;
    let passadas = 0;

    for (let passada = 1; passada <= TENTATIVAS_DIA; passada += 1) {
      passadas = passada;
      let offset = 0;
      let esperas = 0;
      for (;;) {
        if (paginas >= MAX_PAGINAS_DIA) break;
        const q = new URLSearchParams({
          seller: loja.sellerId,
          "order.date_created.from": `${dia}T00:00:00.000-03:00`,
          "order.date_created.to": `${dia}T23:59:59.999-03:00`,
          sort: "date_asc", limit: String(LIMITE), offset: String(offset),
        });
        const r = await fetch(`${BASE}/orders/search?${q.toString()}`, { headers: auth });
        if (r.status === 429 && esperas < TENTATIVAS_429) {
          esperas += 1;
          await new Promise((res) => setTimeout(res, 500 * Math.pow(3, esperas - 1)));
          continue;
        }
        if (!r.ok) break;
        esperas = 0;
        const corpo = await r.json() as { paging?: { total?: unknown }; results?: Bruto[] };
        paginas += 1;
        const t = num(corpo.paging?.total);
        if (t !== null) totalRelatado = totalRelatado === null ? t : Math.min(totalRelatado, t);
        const lote = corpo.results ?? [];
        for (const o of lote) {
          const id = String(o.id ?? "");
          if (id === "" || vistos.has(id)) continue;
          vistos.add(id);
          linhas.push(JSON.stringify(projetar(o)));
        }
        if (lote.length === 0) break;
        offset += lote.length;
        if (totalRelatado !== null && vistos.size >= totalRelatado) break;
      }
      if (totalRelatado !== null && vistos.size >= totalRelatado) break;
    }

    return {
      dia: {
        dia, unicos: vistos.size, total: totalRelatado, paginas, passadas,
        completo: totalRelatado !== null && vistos.size >= totalRelatado,
      },
      linhas,
    };
  };

  for (let i = 0; i < dias.length; i += CONCORRENCIA) {
    const onda = dias.slice(i, i + CONCORRENCIA);
    const lidas = await Promise.all(onda.map(lerDia));
    for (const { dia, linhas } of lidas) {
      relatorioDias.push(dia);
      if (linhas.length > 0) appendFileSync(arquivoPedidos, linhas.join("\n") + "\n", "utf8");
      gravados += linhas.length;
      const marca = dia.completo ? "ok " : "INC";
      console.log(`   ${dia.dia}  ${marca}  ${String(dia.unicos).padStart(5)} de ` +
        `${String(dia.total).padStart(5)}  ${String(dia.paginas).padStart(3)} pag  ` +
        `${dia.passadas} passada(s)`);
    }
  }

  const incompletos = relatorioDias.filter((d) => !d.completo);
  writeFileSync(join(DESTINO, "coleta.json"), JSON.stringify({
    coletadoEm: new Date().toISOString(),
    criacaoDe: CRIACAO_DE, criacaoAte: CRIACAO_ATE,
    dias: relatorioDias,
    pedidosGravados: gravados,
    diasIncompletos: incompletos.map((d) => d.dia),
    completo: incompletos.length === 0,
    duracaoMs: Date.now() - t0,
  }, null, 2), "utf8");

  console.log(`\n   pedidos gravados: ${gravados}`);
  console.log(`   dias incompletos: ${incompletos.length}` +
    (incompletos.length > 0 ? ` (${incompletos.map((d) => d.dia).join(", ")})` : ""));
  console.log(`   DATASET_COMPLETE = ${incompletos.length === 0 ? "PROVEN" : "FAILED"}`);
  console.log(`   ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

void main();
