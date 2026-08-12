#!/usr/bin/env node
/**
 * Backfill histórico de dashboard_resumos_diarios (aprovado 2026-07-10,
 * Parte 7). NÃO chama nenhuma API de marketplace — só lê `pedidos` já
 * existente no Supabase e preenche os resumos, dia a dia, via
 * /api/admin/backfill-resumos-diarios (que faz a leitura/gravação real).
 *
 * Idempotente: cada dia é sempre recalculado do zero — pode ser
 * interrompido a qualquer momento e retomado rodando de novo com as
 * mesmas datas (ou um range que sobreponha), sem duplicar nem corromper
 * nada.
 *
 * Uso:
 *   CDS_SESSION=<valor_do_cookie_cds_session> node scripts/backfill-resumos-diarios.mjs \
 *     --date-from 2026-07-01 --date-to 2026-07-10 [--marketplace Shopee] [--conta NomeDaLoja]
 *
 * Opções:
 *   --base-url     default: http://127.0.0.1:3000
 *   --date-from    obrigatório, YYYY-MM-DD
 *   --date-to      obrigatório, YYYY-MM-DD
 *   --marketplace  opcional — sem isso, recalcula todas as combinações encontradas em cada dia
 *   --conta        opcional
 *
 * Recomendação de teste (aprovado 2026-07-10, Parte 7):
 *   1. 1 dia conhecido primeiro (--date-from X --date-to X), comparar
 *      contra SQL direto na tabela pedidos.
 *   2. Últimos 7 dias.
 *   3. Um mês.
 *   4. Só depois disso, o histórico inteiro.
 */
import http from "node:http";

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    baseUrl:     "http://127.0.0.1:3000",
    dateFrom:    null,
    dateTo:      null,
    marketplace: null,
    conta:       null,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--base-url")    opts.baseUrl     = args[++i];
    else if (a === "--date-from")  opts.dateFrom    = args[++i];
    else if (a === "--date-to")    opts.dateTo      = args[++i];
    else if (a === "--marketplace") opts.marketplace = args[++i];
    else if (a === "--conta")       opts.conta       = args[++i];
  }
  return opts;
}

/** Soma 1 dia a uma data YYYY-MM-DD, sem depender de timezone do ambiente. */
function proximoDia(iso) {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().split("T")[0];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Mesma tecnica de reconciliar-lotes.mjs: http nativo do Node, nao fetch(),
// porque o fetch() global (undici) tem timeout padrao de 5min esperando
// headers — nao deveria ser um problema aqui (1 dia processa rapido, so
// le/agrega/grava no Supabase, sem chamar Shopee/ML), mas mantemos o mesmo
// padrao ja validado por consistencia.
function httpGetJson(url, cookie) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers: { cookie: `cds_session=${cookie}` }, timeout: 5 * 60 * 1000 }, (res) => {
      let raw = "";
      res.on("data", chunk => { raw += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, raw }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("Timeout apos 5min sem resposta")));
    req.on("error", reject);
  });
}

async function main() {
  const opts = parseArgs();
  const cookie = process.env.CDS_SESSION;

  if (!cookie) {
    console.error("ERRO: defina CDS_SESSION com o valor do cookie 'cds_session'.");
    process.exit(1);
  }
  if (!opts.dateFrom || !opts.dateTo) {
    console.error("ERRO: --date-from e --date-to sao obrigatorios (YYYY-MM-DD).");
    process.exit(1);
  }
  if (opts.dateTo < opts.dateFrom) {
    console.error("ERRO: --date-to nao pode ser anterior a --date-from.");
    process.exit(1);
  }

  console.log("=== Backfill dashboard_resumos_diarios ===");
  console.log(`date_from=${opts.dateFrom} date_to=${opts.dateTo} marketplace=${opts.marketplace ?? "(todas)"} conta=${opts.conta ?? "(todas)"}`);
  console.log("");

  let diasProcessados = 0;
  let diasComErro = 0;
  let combosTotal = 0;
  const errosDetalhe = [];
  // Registro por dia (Fase 3 — teste de carga funcional, 2026-07-29):
  // data, tempo total da chamada, lojas encontradas, falhou sim/não.
  // "Número de pedidos processados" e "resumos recalculados" não vêm
  // desta chamada (a rota não devolve isso) — são obtidos depois via SQL
  // direto em dashboard_resumos_diarios, contra o dado realmente gravado
  // (mais confiável que confiar num contador em trânsito).
  const registroPorDia = [];

  for (let dia = opts.dateFrom; dia <= opts.dateTo; dia = proximoDia(dia)) {
    const params = new URLSearchParams({ data: dia });
    if (opts.marketplace) params.set("marketplace", opts.marketplace);
    if (opts.conta) params.set("conta", opts.conta);
    const url = `${opts.baseUrl}/api/admin/backfill-resumos-diarios?${params.toString()}`;

    const inicioMs = Date.now();
    let resp;
    try {
      resp = await httpGetJson(url, cookie);
    } catch (err) {
      const tempoMs = Date.now() - inicioMs;
      console.error(`[${dia}] ERRO DE REDE (${tempoMs}ms): ${err.message}`);
      diasComErro++;
      errosDetalhe.push({ dia, erro: err.message });
      registroPorDia.push({ dia, tempoMs, lojasEncontradas: 0, falhou: "SIM" });
      continue; // dia seguinte — cada dia e independente e idempotente
    }
    const tempoMs = Date.now() - inicioMs;

    if (resp.status !== 200) {
      console.error(`[${dia}] ERRO HTTP ${resp.status} (${tempoMs}ms): ${resp.raw.slice(0, 200)}`);
      diasComErro++;
      errosDetalhe.push({ dia, erro: `HTTP ${resp.status}` });
      registroPorDia.push({ dia, tempoMs, lojasEncontradas: 0, falhou: "SIM" });
      continue;
    }

    let json;
    try {
      json = JSON.parse(resp.raw);
    } catch (err) {
      console.error(`[${dia}] ERRO ao ler JSON (${tempoMs}ms): ${err.message}`);
      diasComErro++;
      errosDetalhe.push({ dia, erro: "JSON invalido" });
      registroPorDia.push({ dia, tempoMs, lojasEncontradas: 0, falhou: "SIM" });
      continue;
    }

    if (json.ok !== true) {
      console.error(`[${dia}] resposta ok=false (${tempoMs}ms): ${json.erro ?? JSON.stringify(json)}`);
      diasComErro++;
      errosDetalhe.push({ dia, erro: json.erro ?? "ok=false" });
      registroPorDia.push({ dia, tempoMs, lojasEncontradas: 0, falhou: "SIM" });
      continue;
    }

    // Campo renomeado na Fase 1 (2026-07-24): combinacoes_encontradas -> lojas_encontradas
    // (agrupamento passou a ser por loja_id, não mais marketplace+conta).
    const falhasCombo = (json.resultado ?? []).filter(r => !r.ok);
    combosTotal += json.lojas_encontradas ?? 0;
    if (falhasCombo.length > 0) {
      console.error(`[${dia}] ${json.lojas_encontradas} loja(s) (${tempoMs}ms), ${falhasCombo.length} com erro:`);
      for (const f of falhasCombo) console.error(`   - ${f.lojaId} (${f.marketplace}/${f.conta}): ${f.erro}`);
      diasComErro++;
      errosDetalhe.push({ dia, erro: `${falhasCombo.length} loja(s) com erro` });
      registroPorDia.push({ dia, tempoMs, lojasEncontradas: json.lojas_encontradas ?? 0, falhou: "SIM" });
    } else {
      console.log(`[${dia}] ok — ${json.lojas_encontradas} loja(s) recalculada(s) (${tempoMs}ms)`);
      diasProcessados++;
      registroPorDia.push({ dia, tempoMs, lojasEncontradas: json.lojas_encontradas ?? 0, falhou: "NÃO" });
    }

    // Pausa entre dias (2026-07-28): investigação em andamento — rodar os 29
    // dias em sequência sem pausa produziu "ok" para todo dia mas só gravou
    // dado real para 1 deles; suspeita de throttling do Supabase (banner
    // "EXCEDER OS LIMITES DE UTILIZAÇÃO", nunca investigado até agora) ou
    // projeto acordando de estado pausado no meio da rajada. Esta pausa não
    // resolve a causa raiz se for throttling — só reduz a chance de disparar
    // o limite de novo enquanto isso não é confirmado.
    await sleep(800);
  }

  console.log("");
  console.log("=== Resumo do backfill ===");
  console.log(`Dias processados sem erro: ${diasProcessados}`);
  console.log(`Dias com erro: ${diasComErro}`);
  console.log(`Lojas recalculadas no total (soma por dia): ${combosTotal}`);
  if (errosDetalhe.length > 0) {
    console.log("Detalhe dos erros:");
    for (const e of errosDetalhe) console.log(`   - ${e.dia}: ${e.erro}`);
  }

  console.log("");
  console.log("=== Registro por dia (Data | Tempo(ms) | Lojas encontradas | Falhou) ===");
  for (const r of registroPorDia) {
    console.log(`${r.dia} | ${r.tempoMs}ms | ${r.lojasEncontradas} | ${r.falhou}`);
  }
}

main().catch(err => {
  console.error("ERRO INESPERADO:", err);
  process.exit(1);
});
