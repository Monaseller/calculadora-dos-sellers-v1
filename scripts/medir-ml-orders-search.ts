/**
 * MEDICAO — o que `/orders/search` do Mercado Livre aceita filtrar.
 *
 * ── A pergunta que decide o F7b.4.8 Parte D ─────────────────────────
 *
 * A CDS tem uma regra inegociavel: toda metrica financeira usa a DATA DE
 * PAGAMENTO, e data de criacao e auditoria — nunca referencia financeira
 * (`docs/BUSINESS_RULES.md`). O sync atual (`sync-ml.ts`) busca por
 * `order.date_created`, o que serve para VARRER, e nao para responder
 * "quanto vendi esta semana".
 *
 * Entao: a API oficial aceita filtrar por data de pagamento? Se nao
 * aceitar, a janela tem de ser buscada por criacao e o recorte financeiro
 * feito aqui, sobre `payments[].date_approved`.
 *
 * ── O CONTROLE que este script existe para nao dispensar ────────────
 *
 * Muitas APIs IGNORAM parametro desconhecido e devolvem 200. Um filtro
 * inventado pareceria "funcionar": mesma contagem, status 200, nenhum
 * erro. Por isso toda sonda de filtro vem com um controle que manda um
 * parametro impossivel — se a contagem nao mudar, o parametro nao filtra
 * nada, e "aceito" seria leitura errada de um 200.
 *
 * ── Seguranca ───────────────────────────────────────────────────────
 *
 * READ-ONLY: so GET. Nenhuma escrita, nenhuma alteracao.
 *
 * NAO imprime: token, `user_id`, `seller_id`, valor financeiro, dado de
 * comprador nem conteudo de pedido. Imprime endpoint, status, periodo e
 * CONTAGEM — o que o §24 pede como evidencia sanitizada.
 *
 * Roda com: npx tsx scripts/medir-ml-orders-search.ts
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

/** A loja MONAMOR com token no prazo — conexao que o dono ja autorizou. */
const LOJA = "50165b6f-5185-4da7-991a-07c0c6bc8f39";

const BASE = "https://api.mercadolibre.com/orders/search";

interface Sonda {
  readonly nome: string;
  readonly params: Readonly<Record<string, string>>;
}

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const chave = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !chave) { console.error("ERRO: env do Supabase ausente."); process.exit(1); }
  const db = createClient(url, chave);

  // O dono sai do BANCO, e nunca de argumento: e ele que restringe a
  // consulta de credencial. Nao e impresso em lugar nenhum.
  const { data, error } = await db
    .from("lojas").select("user_id").eq("id", LOJA).maybeSingle();
  if (error || !data?.user_id) {
    console.error("ERRO: loja nao encontrada."); process.exit(1);
  }
  const dono = String(data.user_id);

  const { getMLLojaById } = await import("../lib/ml-auth");
  const loja = await getMLLojaById(LOJA, dono);
  if (loja === null) { console.error("ERRO: credencial indisponivel."); process.exit(1); }
  console.log(`loja resolvida server-side: sim`);
  console.log(`seller resolvido: ${loja.sellerId === "" ? "NAO" : "sim (nao impresso)"}`);
  console.log(`token obtido do banco/refresh: ${loja.accessToken === "" ? "NAO" : "sim (nao impresso)"}`);

  // Uma janela curta e ANTIGA o suficiente para estar estavel: medir
  // contagem contra um periodo ainda em movimento faria duas sondas
  // diferirem por venda nova, e nao por filtro.
  const DE = "2026-09-01T00:00:00.000-03:00";
  const ATE = "2026-09-08T00:00:00.000-03:00";
  console.log(`\nperiodo medido: ${DE} -> ${ATE}`);

  const sondas: readonly Sonda[] = ([
    // A. O formato que o sync ja usa. E a referencia de tudo.
    { nome: "A. date_created (o que o sync usa)", params: {
      "order.date_created.from": DE, "order.date_created.to": ATE } },
    // B. CONTROLE: janela impossivel. Se A e B derem o MESMO numero, o
    //    parametro de data nao esta filtrando e A nao prova nada.
    { nome: "B. CONTROLE date_created janela vazia", params: {
      "order.date_created.from": "1999-01-01T00:00:00.000-03:00",
      "order.date_created.to": "1999-01-02T00:00:00.000-03:00" } },
    // C. Existe filtro por data de PAGAMENTO?
    { nome: "C. payment.date_approved", params: {
      "payment.date_approved.from": DE, "payment.date_approved.to": ATE } },
    { nome: "D. order.date_closed", params: {
      "order.date_closed.from": DE, "order.date_closed.to": ATE } },
    // E. CONTROLE DE IGNORAR: parametro que NAO existe, com valor que
    //    excluiria tudo se fosse respeitado. Se a contagem for igual a
    //    de A, a API ignora o que nao conhece — e entao um 200 em C ou D
    //    nao significa "aceito".
    { nome: "E. CONTROLE parametro inexistente", params: {
      "order.date_created.from": DE, "order.date_created.to": ATE,
      "order.parametro_que_nao_existe.from": "1999-01-01T00:00:00.000-03:00" } },
  ] as Sonda[]);

  for (const s of sondas) {
    const q = new URLSearchParams({
      seller: loja.sellerId, "order.status": "paid", limit: "1", offset: "0", ...s.params,
    });
    const r = await fetch(`${BASE}?${q.toString()}`, {
      headers: { Authorization: `Bearer ${loja.accessToken}` },
    });
    let total: unknown = "—";
    let erro = "";
    try {
      const corpo = await r.json() as Record<string, unknown>;
      const paging = corpo.paging as Record<string, unknown> | undefined;
      total = paging?.total ?? "sem paging";
      if (r.status >= 400) {
        // Mensagem do provedor, truncada: ela diz QUAL parametro recusou.
        erro = String(corpo.message ?? corpo.error ?? "").slice(0, 120);
      }
    } catch { erro = "corpo nao e JSON"; }
    console.log(`  ${s.nome}`);
    console.log(`    HTTP ${r.status}  total=${String(total)}${erro ? `  erro="${erro}"` : ""}`);
  }

  // G. Qual o LIMITE por pagina? 3000 pedidos numa semana a 50 por
  //    pagina sao 60 chamadas; o teto real muda o desenho da paginacao.
  console.log("\nG. limite por pagina aceito");
  for (const limite of ["50", "51", "100", "200"]) {
    const qq = new URLSearchParams({
      seller: loja.sellerId, "order.status": "paid",
      "order.date_created.from": DE, "order.date_created.to": ATE,
      limit: limite, offset: "0",
    });
    const rr = await fetch(`${BASE}?${qq.toString()}`, {
      headers: { Authorization: `Bearer ${loja.accessToken}` },
    });
    const cc = await rr.json() as Record<string, unknown>;
    const res = cc.results as unknown[] | undefined;
    const pag = cc.paging as Record<string, unknown> | undefined;
    console.log(`    limit=${limite} -> HTTP ${rr.status} devolveu=${Array.isArray(res) ? res.length : "—"} paging.limit=${String(pag?.limit ?? "—")}`);
  }

  // H. Ate onde o OFFSET vai? O sync antigo travava em 1000.
  console.log("\nH. teto de offset");
  for (const off of ["1000", "5000"]) {
    const qq = new URLSearchParams({
      seller: loja.sellerId, "order.status": "paid",
      "order.date_created.from": DE, "order.date_created.to": ATE,
      limit: "1", offset: off,
    });
    const rr = await fetch(`${BASE}?${qq.toString()}`, {
      headers: { Authorization: `Bearer ${loja.accessToken}` },
    });
    const cc = await rr.json() as Record<string, unknown>;
    const res = cc.results as unknown[] | undefined;
    console.log(`    offset=${off} -> HTTP ${rr.status} devolveu=${Array.isArray(res) ? res.length : "—"} msg="${String(cc.message ?? "").slice(0, 70)}"`);
  }

  // F. O recorte financeiro precisa de `payments[].date_approved` no
  //    corpo do pedido. Ele vem na resposta de busca, ou so no detalhe?
  const q = new URLSearchParams({
    seller: loja.sellerId, "order.status": "paid",
    "order.date_created.from": DE, "order.date_created.to": ATE,
    limit: "1", offset: "0",
  });
  const r = await fetch(`${BASE}?${q.toString()}`, {
    headers: { Authorization: `Bearer ${loja.accessToken}` },
  });
  const corpo = await r.json() as { results?: Record<string, unknown>[] };
  const primeiro = (corpo.results ?? [])[0];
  console.log("\nF. o corpo da BUSCA traz o que o recorte financeiro precisa?");
  if (primeiro === undefined) {
    console.log("    sem resultado na janela — inconclusivo");
  } else {
    const pagamentos = primeiro.payments as Record<string, unknown>[] | undefined;
    console.log(`    campos de topo: ${Object.keys(primeiro).sort().join(", ")}`);
    console.log(`    payments presente: ${Array.isArray(pagamentos) ? "sim" : "NAO"}`);
    if (Array.isArray(pagamentos) && pagamentos[0] !== undefined) {
      console.log(`    campos de payments[0]: ${Object.keys(pagamentos[0]).sort().join(", ")}`);
      console.log(`    date_approved presente: ${pagamentos[0].date_approved !== undefined ? "sim" : "NAO"}`);
    }
  }
}

void main();
