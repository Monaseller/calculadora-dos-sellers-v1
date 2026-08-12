#!/usr/bin/env node
/**
 * Orquestracao local de multiplos lotes de reconciliacao financeira Shopee.
 *
 * NAO contem nenhuma regra financeira, nenhuma logica de Dashboard/Vendas.
 * Este script SO faz chamadas HTTP repetidas para o endpoint que ja existe
 * (/api/admin/shopee/reconciliar-financeiro), lote apos lote, e imprime
 * progresso no terminal. Toda a logica de calculo/gravacao continua 100%
 * dentro da rota original, sem duplicacao.
 *
 * NAO e' cron. Roda uma vez, do inicio ao fim (ate max_batches ou ate parar
 * por erro), e termina. Disparo sempre manual, no terminal.
 *
 * Uso:
 *   CDS_SESSION=<valor_do_cookie_cds_session> node scripts/reconciliar-lotes.mjs [opcoes]
 *
 * Como pegar o CDS_SESSION: no navegador, com o CDS aberto e logado,
 * DevTools > Application (ou Storage) > Cookies > localhost:3000 > copiar
 * o valor do cookie "cds_session".
 *
 * Opcoes (todas opcionais, com default = configuracao aprovada em 2026-07-08):
 *   --base-url     default: http://localhost:3000
 *   --batch-size   default: 500   (mapeia para o parametro "limit" do endpoint)
 *   --max-batches  default: 5
 *   --dry-run      default: 0     (0 = grava de verdade, 1 = so simula)
 *   --force        default: 0     (1 = reprocessa has_income_data=true — usar com cuidado)
 *
 * Parada imediata (stop_on_error): o script para no primeiro lote em que
 * ocorrer qualquer um destes casos, sem continuar silenciosamente:
 *   - erro de rede/timeout na chamada ao endpoint;
 *   - HTTP status diferente de 200;
 *   - resposta JSON com ok != true;
 *   - qualquer item dentro de "detalhes" com sucesso=false;
 *   - qualquer item com status_gravacao comecando com "erro_gravacao".
 *
 * Idempotencia: garantida pelo proprio endpoint (has_income_data=true bloqueia
 * reprocessamento sem --force=1). Este script nao decide nem verifica isso,
 * so repassa o parametro.
 */

import http from "node:http";

// Fase L (2026-07-09): usa o modulo http nativo em vez de fetch().
// Motivo: o fetch() global do Node (undici por baixo) tem um timeout padrao
// de 5 minutos esperando os headers de resposta (UND_ERR_HEADERS_TIMEOUT) —
// e nossos lotes de 500 pedidos ja levam 5-10min. http.request nao tem esse
// limite por padrao; usamos um timeout bem mais generoso e explicito (20min)
// so como rede de seguranca, nao como limite normal de operacao.
const TIMEOUT_REQUISICAO_MS = 20 * 60 * 1000;

function httpGetJson(url, cookie) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers: { cookie: `cds_session=${cookie}` }, timeout: TIMEOUT_REQUISICAO_MS }, (res) => {
      let raw = "";
      res.on("data", chunk => { raw += chunk; });
      res.on("end", () => {
        resolve({ status: res.statusCode, raw });
      });
      res.on("error", reject);
    });
    req.on("timeout", () => {
      req.destroy(new Error(`Sem resposta apos ${TIMEOUT_REQUISICAO_MS}ms`));
    });
    req.on("error", reject);
  });
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    // 127.0.0.1 em vez de "localhost" — no Windows, "localhost" pode resolver
    // para ::1 (IPv6) e o Next so escuta em IPv4, causando "fetch failed"
    // mesmo com o servidor rodando.
    baseUrl:    "http://127.0.0.1:3000",
    batchSize:  500,
    maxBatches: 5,
    dryRun:     "0",
    force:      "0",
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--base-url")    opts.baseUrl    = args[++i];
    else if (a === "--batch-size")  opts.batchSize  = Number(args[++i]);
    else if (a === "--max-batches") opts.maxBatches = Number(args[++i]);
    else if (a === "--dry-run")     opts.dryRun     = args[++i];
    else if (a === "--force")       opts.force      = args[++i];
  }
  return opts;
}

function fmtSeg(ms) {
  return (ms / 1000).toFixed(1) + "s";
}

async function main() {
  const opts = parseArgs();
  const cookie = process.env.CDS_SESSION;

  if (!cookie) {
    console.error("ERRO: defina a variavel de ambiente CDS_SESSION com o valor do cookie 'cds_session'.");
    console.error("Exemplo: CDS_SESSION=xxxxxxxx node scripts/reconciliar-lotes.mjs");
    process.exit(1);
  }

  console.log("=== Reconciliacao financeira Shopee — orquestracao em lotes ===");
  console.log(
    `base_url=${opts.baseUrl} batch_size=${opts.batchSize} max_batches=${opts.maxBatches} ` +
    `dry_run=${opts.dryRun} force=${opts.force}`
  );
  console.log("");

  const acumulado = {
    lotesExecutados:        0,
    selecionados:           0,
    consultados:            0,
    comIncome:              0,
    semIncome:              0,
    gravados:               0,
    ignoradosIdempotencia:  0,
    erros:                  0,
    tempoTotalServidorMs:   0,
  };

  const inicioExecucao = Date.now();

  for (let lote = 1; lote <= opts.maxBatches; lote++) {
    const url =
      `${opts.baseUrl}/api/admin/shopee/reconciliar-financeiro` +
      `?limit=${opts.batchSize}&dry_run=${opts.dryRun}` +
      (opts.force === "1" ? "&force=1" : "");

    console.log(`--- Lote ${lote}/${opts.maxBatches} ---`);
    const inicioLoteScript = Date.now();

    let resp;
    try {
      resp = await httpGetJson(url, cookie);
    } catch (err) {
      console.error(`ERRO DE REDE no lote ${lote}: ${err.message}`);
      console.error("PARANDO (stop_on_error=true). Nenhum lote seguinte foi executado.");
      process.exit(1);
    }

    if (resp.status !== 200) {
      console.error(`ERRO HTTP ${resp.status} no lote ${lote}.`);
      console.error("PARANDO (stop_on_error=true).");
      process.exit(1);
    }

    let json;
    try {
      json = JSON.parse(resp.raw);
    } catch (err) {
      console.error(`ERRO ao ler JSON do lote ${lote}: ${err.message}`);
      console.error("PARANDO (stop_on_error=true).");
      process.exit(1);
    }

    if (json.ok !== true) {
      console.error(`Resposta com ok=false no lote ${lote}: ${json.erro ?? json.mensagem ?? JSON.stringify(json)}`);
      console.error("PARANDO (stop_on_error=true).");
      process.exit(1);
    }

    const detalhes       = json.detalhes ?? [];
    const falhasConsulta  = detalhes.filter(d => d.sucesso === false);
    const errosGravacao   = detalhes.filter(
      d => typeof d.status_gravacao === "string" && d.status_gravacao.startsWith("erro_gravacao")
    );
    const tempoLoteScriptMs = Date.now() - inicioLoteScript;

    console.log(
      `  selecionados=${json.selecionados} consultados=${json.consultados} ` +
      `com_income=${json.com_income} sem_income=${json.sem_income} gravados=${json.gravados} ` +
      `ignorados_idempotencia=${json.ignorados_idempotencia}`
    );
    console.log(
      `  falhas_consulta=${falhasConsulta.length} erros_gravacao=${errosGravacao.length} ` +
      `tempo_lote_ms(servidor)=${json.tempo_lote_ms} tempo_lote_ms(script)=${tempoLoteScriptMs}`
    );

    acumulado.lotesExecutados++;
    acumulado.selecionados          += json.selecionados ?? 0;
    acumulado.consultados           += json.consultados ?? 0;
    acumulado.comIncome             += json.com_income ?? 0;
    acumulado.semIncome             += json.sem_income ?? 0;
    acumulado.gravados              += json.gravados ?? 0;
    acumulado.ignoradosIdempotencia += json.ignorados_idempotencia ?? 0;
    acumulado.erros                 += falhasConsulta.length + errosGravacao.length;
    acumulado.tempoTotalServidorMs  += json.tempo_lote_ms ?? tempoLoteScriptMs;

    console.log(
      `  acumulado ate agora: gravados=${acumulado.gravados} com_income=${acumulado.comIncome} ` +
      `sem_income=${acumulado.semIncome} erros=${acumulado.erros}`
    );
    console.log("");

    if (falhasConsulta.length > 0 || errosGravacao.length > 0) {
      console.error(
        `ERRO detectado dentro do lote ${lote} ` +
        `(falhas_consulta=${falhasConsulta.length}, erros_gravacao=${errosGravacao.length}).`
      );
      console.error("PARANDO (stop_on_error=true). Detalhe das falhas:");
      for (const f of falhasConsulta.slice(0, 10)) console.error(`   - ${f.order_id}: ${f.motivo}`);
      for (const e of errosGravacao.slice(0, 10)) console.error(`   - ${e.order_id}: ${e.status_gravacao}`);
      break;
    }

    if ((json.selecionados ?? 0) === 0) {
      console.log("Nenhum pedido pendente encontrado — reconciliacao completa ou nada a fazer. Encerrando.");
      break;
    }
  }

  const tempoExecucaoMs = Date.now() - inicioExecucao;

  console.log("=== Resumo geral da execucao ===");
  console.log(`Lotes executados: ${acumulado.lotesExecutados}/${opts.maxBatches}`);
  console.log(`Selecionados: ${acumulado.selecionados}`);
  console.log(`Consultados: ${acumulado.consultados}`);
  console.log(`Com income: ${acumulado.comIncome}`);
  console.log(`Sem income: ${acumulado.semIncome}`);
  console.log(`Gravados: ${acumulado.gravados}`);
  console.log(`Ignorados por idempotencia: ${acumulado.ignoradosIdempotencia}`);
  console.log(`Erros: ${acumulado.erros}`);
  console.log(`Tempo total somado dos lotes (servidor): ${fmtSeg(acumulado.tempoTotalServidorMs)}`);
  console.log(`Tempo total da execucao (script, inclui rede/overhead): ${fmtSeg(tempoExecucaoMs)}`);
}

main().catch(err => {
  console.error("ERRO INESPERADO:", err);
  process.exit(1);
});
