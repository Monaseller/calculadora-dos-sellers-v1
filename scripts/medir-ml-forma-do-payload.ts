/**
 * MEDICAO — que campos a API oficial REALMENTE devolve — F7b.4.8.4 §10.
 *
 * O gate proibe inventar campo a partir de documentacao. Entao o primeiro
 * passo e olhar o payload de verdade: todos os caminhos JSON, o tipo de
 * cada um, quantas vezes aparece e quantas vem nulo.
 *
 * Compara tambem `/orders/search` com `/orders/{id}`: se a busca devolver
 * menos campos que o recurso, uma auditoria feita so na busca estaria
 * cega para parte do dinheiro.
 *
 * ── O que NAO sai daqui ─────────────────────────────────────────────
 *
 * Nenhum VALOR de campo pessoal. Comprador, vendedor, endereco e
 * telefone aparecem como CAMINHO e tipo, nunca como conteudo. Valor
 * literal so e impresso para campo monetario, de data e de status, e
 * ainda assim em amostra curta.
 *
 * READ-ONLY. Nao imprime token, seller id nem credencial.
 *
 * Roda com: npx tsx scripts/medir-ml-forma-do-payload.ts
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
/** Dias de setembro amostrados para a forma. Nao e o dataset do gate. */
const DIAS = ["2026-09-03", "2026-09-17", "2026-09-28"];

/** Chaves cujo CONTEUDO nunca e impresso — so o caminho e o tipo. */
const PESSOAL = /buyer|seller|receiver|payer|address|phone|email|nick|name|doc|taxpayer|street|zip|city|neighborhood|comment|title|reason/i;
/** Chaves cujo valor literal interessa a pericia. */
const INTERESSA = /amount|cost|price|fee|tax|discount|coupon|total|paid|refund|install|currency|date|status|quantity|units|mode|type|group|code/i;

interface Perfil {
  tipos: Map<string, number>;
  vistos: number;
  nulos: number;
  min: number | null;
  max: number | null;
  soma: number;
  exemplos: string[];
}

const perfis = new Map<string, Perfil>();

function perfilDe(caminho: string): Perfil {
  let p = perfis.get(caminho);
  if (p === undefined) {
    p = { tipos: new Map(), vistos: 0, nulos: 0, min: null, max: null, soma: 0, exemplos: [] };
    perfis.set(caminho, p);
  }
  return p;
}

/** Caminha o objeto inteiro. Array vira `[]` no caminho, sem indice. */
function caminhar(valor: unknown, caminho: string): void {
  const p = perfilDe(caminho);
  p.vistos += 1;

  if (valor === null) { p.nulos += 1; p.tipos.set("null", (p.tipos.get("null") ?? 0) + 1); return; }
  if (Array.isArray(valor)) {
    p.tipos.set("array", (p.tipos.get("array") ?? 0) + 1);
    for (const item of valor) caminhar(item, `${caminho}[]`);
    return;
  }
  const t = typeof valor;
  p.tipos.set(t, (p.tipos.get(t) ?? 0) + 1);

  if (t === "object") {
    for (const [k, v] of Object.entries(valor as Record<string, unknown>)) {
      caminhar(v, caminho === "" ? k : `${caminho}.${k}`);
    }
    return;
  }

  if (t === "number" && Number.isFinite(valor)) {
    const n = valor as number;
    p.min = p.min === null ? n : Math.min(p.min, n);
    p.max = p.max === null ? n : Math.max(p.max, n);
    p.soma += n;
  }
  // Exemplo literal: so para o que a pericia precisa ler, e nunca para
  // campo pessoal. Tres por caminho bastam para entender o formato.
  const folha = caminho.split(".").pop() ?? "";
  if (p.exemplos.length < 3 && !PESSOAL.test(caminho) && INTERESSA.test(folha)) {
    const texto = String(valor);
    if (!p.exemplos.includes(texto)) p.exemplos.push(texto.slice(0, 40));
  }
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

  console.log("══ F7b.4.8.4 §10 — a forma real do payload ══\n");

  // ── 1. A busca, em tres dias de setembro ──────────────────────────

  let pedidos = 0;
  const idsAmostra: string[] = [];
  for (const dia of DIAS) {
    const q = new URLSearchParams({
      seller: loja.sellerId,
      "order.date_created.from": `${dia}T00:00:00.000-03:00`,
      "order.date_created.to": `${dia}T23:59:59.999-03:00`,
      sort: "date_asc", limit: "51", offset: "0",
    });
    const r = await fetch(`${BASE}/orders/search?${q.toString()}`, { headers: auth });
    if (!r.ok) { console.log(`   HTTP ${r.status} em ${dia}`); continue; }
    const corpo = await r.json() as { results?: Record<string, unknown>[] };
    for (const o of corpo.results ?? []) {
      caminhar(o, "");
      pedidos += 1;
      if (idsAmostra.length < 6) idsAmostra.push(String(o.id ?? ""));
    }
  }
  console.log(`1. ${pedidos} pedidos de /orders/search perfilados\n`);

  const ordenados = [...perfis.entries()]
    .filter(([c]) => c !== "")
    .sort((a, b) => a[0].localeCompare(b[0]));

  console.log("   CAMINHO                                              TIPOS            VISTOS  NULOS  EXEMPLOS");
  for (const [caminho, p] of ordenados) {
    const tipos = [...p.tipos.entries()].map(([t, n]) => `${t}:${n}`).join(",");
    const ex = p.exemplos.length > 0 ? p.exemplos.join(" | ") : "";
    const sensivel = PESSOAL.test(caminho) ? "  [pessoal: valor omitido]" : "";
    console.log(`   ${caminho.padEnd(52)} ${tipos.padEnd(16)} ${String(p.vistos).padStart(6)} ` +
      `${String(p.nulos).padStart(6)}  ${ex}${sensivel}`);
  }

  // ── 2. Soma por caminho numerico — candidatos monetarios ──────────

  console.log("\n2. Caminhos NUMERICOS, com soma na amostra");
  for (const [caminho, p] of ordenados) {
    if (p.soma === 0 && p.min === null) continue;
    if (!p.tipos.has("number")) continue;
    console.log(`   ${caminho.padEnd(52)} n=${String(p.tipos.get("number")).padStart(5)} ` +
      `min=${String(p.min).padStart(10)} max=${String(p.max).padStart(12)} soma=${p.soma.toFixed(2)}`);
  }

  // ── 3. `/orders/{id}` tem campo que a busca nao tem? ─────────────
  //
  // Se tiver, uma auditoria feita so na busca estaria cega para parte do
  // dinheiro — e essa e a hipotese do §46.

  console.log("\n3. `/orders/{id}` contra `/orders/search`");
  const daBusca = new Set(perfis.keys());
  const doRecurso = new Map<string, Perfil>();
  const guardados = perfis.size;
  perfis.clear();
  let abertos = 0;
  for (const id of idsAmostra) {
    if (id === "") continue;
    const r = await fetch(`${BASE}/orders/${id}`, { headers: auth });
    if (!r.ok) { console.log(`   HTTP ${r.status} ao abrir um pedido`); continue; }
    caminhar(await r.json(), "");
    abertos += 1;
  }
  for (const [k, v] of perfis) doRecurso.set(k, v);
  console.log(`   ${abertos} pedidos abertos individualmente`);
  const soNoRecurso = [...doRecurso.keys()].filter((k) => k !== "" && !daBusca.has(k)).sort();
  const soNaBusca = [...daBusca].filter((k) => k !== "" && !doRecurso.has(k)).sort();
  console.log(`   caminhos da busca: ${guardados - 1}   do recurso: ${doRecurso.size - 1}`);
  console.log(`   SO no recurso (${soNoRecurso.length}):`);
  for (const k of soNoRecurso) console.log(`     + ${k}`);
  console.log(`   SO na busca (${soNaBusca.length}):`);
  for (const k of soNaBusca) console.log(`     - ${k}`);

  // ── 4. Existe endpoint de METRICA? — §34 ─────────────────────────
  //
  // O painel mostra "Vendas brutas". Se houver endpoint publico que
  // entregue isso, ele e a ancora certa. Aqui so se mede QUEM responde:
  // nao se finge conhecer a implementacao interna do Mercado Livre.

  console.log("\n4. Candidatos a endpoint de metrica (so o status)");
  const candidatos = [
    `/users/${loja.sellerId}`,
    `/users/${loja.sellerId}/order_metrics`,
    `/users/${loja.sellerId}/metrics`,
    `/metrics/sales`,
    `/sites/MLB/sales_metrics`,
    `/orders/search/recent?seller=${loja.sellerId}`,
    `/users/${loja.sellerId}/invoices`,
    `/billing/integration/monthly_periods`,
  ];
  for (const caminho of candidatos) {
    try {
      const r = await fetch(`${BASE}${caminho}`, { headers: auth });
      const corpo = await r.text();
      const dica = r.ok
        ? Object.keys(JSON.parse(corpo) as Record<string, unknown>).slice(0, 8).join(",")
        : corpo.slice(0, 70).replace(/\s+/g, " ");
      console.log(`   ${String(r.status).padStart(3)}  ${caminho.replace(loja.sellerId, "<seller>")}`);
      console.log(`        ${dica}`);
    } catch (e) {
      console.log(`   ERR  ${caminho.replace(loja.sellerId, "<seller>")}  ${String(e).slice(0, 60)}`);
    }
  }
}

void main();
