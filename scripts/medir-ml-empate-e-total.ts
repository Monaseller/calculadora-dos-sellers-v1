/**
 * MEDICAO — a pagina curta prova completude? E `paging.total` por dia?
 *
 * ── A duvida que sobrou ─────────────────────────────────────────────
 *
 * A janela 10/09..20/09 deu 3305 no oraculo, 3304 no agente e 3305 outra
 * vez agora, com soma identica nas duas leituras de 3305 — logo o mesmo
 * conjunto. Nenhum caminho de erro pode ter causado isso: todos devolvem
 * `completa: false`, e dai nao sai total nenhum.
 *
 * Sobra o empate. `sort=date_asc` ordena por `date_created`; pedidos com
 * o MESMO instante nao tem ordem definida entre si, e a ordem relativa
 * pode mudar de uma chamada para a outra. Numa fronteira de pagina isso
 * devolve uma linha duas vezes e outra nenhuma. A pagina final continua
 * curta, o dedupe engole a repetida, e a contagem fica um a menos.
 *
 * Se for isso, a assinatura e: DUPLICADA dentro do MESMO dia, e contagem
 * unica MENOR que o `paging.total` daquele dia.
 *
 * Mede tambem o que autoriza a correcao: `paging.total` por DIA e exato?
 * (na janela larga ele nao e — 3572 contra 3642 somando os dias.)
 *
 * READ-ONLY. Nao imprime token, seller, comprador nem id de pedido.
 *
 * Roda com: npx tsx scripts/medir-ml-empate-e-total.ts
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
const DIAS = (process.env.DIAS ?? "").trim() !== ""
  ? (process.env.DIAS as string).split(",").map((d) => d.trim())
  : ["2026-09-10", "2026-09-12", "2026-09-15", "2026-09-18",
    "2026-09-20", "2026-08-12", "2026-08-20", "2026-09-29"];
/** Quantas vezes cada dia e relido — a instabilidade e intermitente. */
const REPETICOES = Number(process.env.REPETICOES ?? "3") || 3;
/** `so=sem` mede apenas o caminho sem filtro; vazio mede os dois. */
const SO = (process.env.SO ?? "").trim();

type Pedido = { id?: unknown; date_created?: unknown };

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

  /** Varre um dia e devolve a ASSINATURA da varredura, nao so os ids. */
  const varrer = async (dia: string, comFiltro: boolean) => {
    const unicos = new Set<string>();
    let lidos = 0;
    let duplicados = 0;
    let paginas = 0;
    const totais = new Set<number>();
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
      if (!r.ok) return { erro: r.status, unicos, lidos, duplicados, paginas, totais };
      const corpo = await r.json() as { paging?: { total?: number }; results?: Pedido[] };
      paginas += 1;
      if (typeof corpo.paging?.total === "number") totais.add(corpo.paging.total);
      const lote = corpo.results ?? [];
      for (const o of lote) {
        const id = String(o.id ?? "");
        if (id === "") continue;
        lidos += 1;
        if (unicos.has(id)) duplicados += 1;
        else unicos.add(id);
      }
      if (lote.length < 51) break;
    }
    return { erro: 0, unicos, lidos, duplicados, paginas, totais };
  };

  // ── Em ONDAS, como a producao faz ─────────────────────────────────
  //
  // A leitura sequencial bateu em 32/32. A producao le 6 subjanelas ao
  // mesmo tempo, e foi sob concorrencia que a perda apareceu — entao a
  // concorrencia precisa entrar na medicao, e nao ficar de fora dela.
  const CONCORRENCIA = Number(process.env.CONCORRENCIA ?? "0") || 0;
  if (CONCORRENCIA > 0) {
    console.log(`\n══ ONDAS de ${CONCORRENCIA}, sem filtro de status ══`);
    for (let rep = 1; rep <= REPETICOES; rep += 1) {
      const linhas: string[] = [];
      let curtos = 0;
      for (let i = 0; i < DIAS.length; i += CONCORRENCIA) {
        const onda = DIAS.slice(i, i + CONCORRENCIA);
        const lidas = await Promise.all(onda.map(async (dia) => ({
          dia, v: await varrer(dia, false),
        })));
        for (const { dia, v } of lidas) {
          const menor = v.totais.size === 0 ? null : Math.min(...v.totais);
          const curto = menor !== null && v.unicos.size < menor;
          if (curto) curtos += 1;
          if (curto || v.totais.size > 1 || v.erro !== 0) {
            linhas.push(`   ${dia}  unicos=${v.unicos.size}` +
              `  totais=[${[...v.totais].join(",")}]  paginas=${v.paginas}` +
              `  dups=${v.duplicados}  http=${v.erro}`);
          }
        }
      }
      console.log(`   rep ${rep}: ${curtos} dia(s) com contagem menor que o total`);
      for (const l of linhas) console.log(l);
    }
    return;
  }

  const caminhos = SO === "sem" ? [false] : SO === "com" ? [true] : [true, false];
  for (const comFiltro of caminhos) {
    console.log(`\n══ ${comFiltro ? "COM" : "SEM"} order.status=paid ══`);
    console.log("   dia         rep  paginas  lidos  unicos  dups  paging.total  unicos==total");
    let batem = 0;
    let naoBatem = 0;
    let comDup = 0;
    for (const dia of DIAS) {
      const assinaturas: string[] = [];
      for (let rep = 1; rep <= REPETICOES; rep += 1) {
        const v = await varrer(dia, comFiltro);
        const total = v.totais.size === 1 ? [...v.totais][0] : null;
        const igual = total !== null && v.unicos.size === total;
        if (igual) batem += 1; else naoBatem += 1;
        if (v.duplicados > 0) comDup += 1;
        console.log(`   ${dia}  ${rep}    ${String(v.paginas).padStart(5)}` +
          `  ${String(v.lidos).padStart(5)}  ${String(v.unicos.size).padStart(6)}` +
          `  ${String(v.duplicados).padStart(4)}` +
          `  ${(total === null ? `variou:${[...v.totais].join("/")}` : String(total)).padStart(12)}` +
          `  ${igual ? "sim" : "NAO"}`);
        assinaturas.push([...v.unicos].sort().join(","));
      }
      const estavel = new Set(assinaturas).size === 1;
      if (!estavel) console.log(`     ^ o conjunto de ids MUDOU entre as ${REPETICOES} leituras`);
    }
    console.log(`   resumo: unicos==paging.total em ${batem} de ${batem + naoBatem}` +
      ` leituras; com duplicada interna: ${comDup}`);
  }
}

void main();
