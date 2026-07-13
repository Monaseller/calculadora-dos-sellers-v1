#!/usr/bin/env node
/**
 * Worker de sincronização — processa a fila sync_jobs.
 *
 * Contexto (docs/DECISIONS.md, 2026-07-11): substitui o sync disparado
 * inline dentro da rota HTTP de leitura (bug do botão "Sincronizar" que
 * derrubava o faturamento em timeout parcial). Este processo roda
 * SEPARADO de qualquer request HTTP — fica em loop, reclama jobs
 * pendentes da tabela sync_jobs e executa o sync de verdade chamando
 * app/api/internal/sync/executar.
 *
 * NÃO importa nenhum .ts (lib/sync-shopee.ts, lib/sync-ml.ts) diretamente
 * — não há tsx/ts-node neste projeto, e não foi adicionado só para isto.
 * Em vez disso, chama a rota interna do Next (que já compila .ts
 * normalmente), do mesmo jeito que scripts/reconciliar-lotes.mjs já
 * chama rotas do Next via http.request (não fetch — undici tem timeout
 * de 5min nos headers, curto demais para sync longo).
 *
 * Requer estar rodando (`npm run dev` ou `next start`) apontando para
 * SYNC_WORKER_BASE_URL (default http://127.0.0.1:3000).
 *
 * Uso:
 *   node scripts/sync-worker.mjs
 *
 * Variáveis de ambiente necessárias (lidas de .env.local se presentes,
 * ou exportadas manualmente antes do comando):
 *   NEXT_PUBLIC_SUPABASE_URL       (já existe em .env.local)
 *   SUPABASE_SERVICE_ROLE_KEY      (NOVA — Supabase > Settings > API > service_role.
 *                                   Nunca commitar, nunca usar em código de rota pública/frontend.)
 *   SYNC_WORKER_INTERNAL_SECRET    (NOVA — string aleatória qualquer, só
 *                                   precisa bater com a mesma variável usada
 *                                   por app/api/internal/sync/executar/route.ts)
 *   SYNC_JOB_STALE_MINUTES         (opcional, default 10)
 *   SYNC_WORKER_BASE_URL           (opcional, default http://127.0.0.1:3000)
 *
 * Esta é uma solução LOCAL de validação (fase atual, sem deploy). Antes
 * de ir para produção será necessário decidir o processador permanente
 * (ex: processo persistente num servidor, não um script manual no
 * terminal do desenvolvedor) — ver docs/ROADMAP.md.
 */
import { createClient } from "@supabase/supabase-js";
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ── Carrega .env.local manualmente (script roda fora do Next, que faz
// isso sozinho só para si mesmo) ──────────────────────────────────────────
function carregarEnvLocal() {
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const envPath = path.join(__dirname, "..", ".env.local");
    const raw = fs.readFileSync(envPath, "utf-8");
    for (const linha of raw.split("\n")) {
      const l = linha.trim();
      if (!l || l.startsWith("#")) continue;
      const idx = l.indexOf("=");
      if (idx === -1) continue;
      const chave = l.slice(0, idx).trim();
      let valor = l.slice(idx + 1).trim();
      if ((valor.startsWith('"') && valor.endsWith('"')) || (valor.startsWith("'") && valor.endsWith("'"))) {
        valor = valor.slice(1, -1);
      }
      if (!(chave in process.env)) process.env[chave] = valor;
    }
  } catch {
    // .env.local ausente/ilegível — segue só com o que já estiver em process.env
  }
}
carregarEnvLocal();

const SUPABASE_URL      = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const INTERNAL_SECRET   = process.env.SYNC_WORKER_INTERNAL_SECRET;
const BASE_URL          = process.env.SYNC_WORKER_BASE_URL || "http://127.0.0.1:3000";
const STALE_MINUTES     = Number(process.env.SYNC_JOB_STALE_MINUTES || "10");

for (const [nome, valor] of [
  ["NEXT_PUBLIC_SUPABASE_URL", SUPABASE_URL],
  ["SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY],
  ["SYNC_WORKER_INTERNAL_SECRET", INTERNAL_SECRET],
]) {
  if (!valor) {
    console.error(`ERRO: variável de ambiente ${nome} ausente. Defina em .env.local ou exporte antes de rodar.`);
    process.exit(1);
  }
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const HEARTBEAT_INTERVAL_MS = 30_000;   // aprovado 2026-07-11
const POLL_IDLE_MS          = 5_000;    // sem job pendente: espera antes de checar de novo
const EXEC_TIMEOUT_MS       = 20 * 60 * 1000; // mesmo timeout generoso de reconciliar-lotes.mjs

function httpPostJson(urlStr, bodyObj, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const lib = url.protocol === "https:" ? https : http;
    const payload = JSON.stringify(bodyObj);
    const req = lib.request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        ...headers,
      },
      timeout: timeoutMs,
    }, (res) => {
      let raw = "";
      res.on("data", chunk => { raw += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, raw }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`Sem resposta após ${timeoutMs}ms`)));
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ── Recupera jobs travados (heartbeat expirado) ─────────────────────────────
// Não usa FOR UPDATE SKIP LOCKED aqui — é aceitável um worker único rodando
// nesta fase local. Guarda mínima: o .eq("status","rodando") no UPDATE evita
// reaplicar em um job que outra iteração já tirou de "rodando" nesse meio-tempo.
async function reclamarJobsTravados() {
  const limite = new Date(Date.now() - STALE_MINUTES * 60 * 1000).toISOString();
  const { data: travados, error } = await supabase
    .from("sync_jobs")
    .select("id, tentativas, max_tentativas")
    .eq("status", "rodando")
    .lt("heartbeat_em", limite);

  if (error) {
    console.error("[worker] erro ao buscar jobs travados:", error.message);
    return;
  }

  for (const job of travados ?? []) {
    const novasTentativas = job.tentativas + 1;
    const esgotou = novasTentativas >= job.max_tentativas;
    await supabase.from("sync_jobs").update({
      status:        esgotou ? "erro" : "pendente",
      tentativas:    novasTentativas,
      erro_mensagem: esgotou
        ? "heartbeat expirado — máximo de tentativas atingido"
        : "heartbeat expirado — reenfileirado",
      heartbeat_em: null,
    }).eq("id", job.id).eq("status", "rodando");

    console.log(`[worker] job ${job.id} travado (heartbeat > ${STALE_MINUTES}min) — ${esgotou ? "marcado como erro" : "reenfileirado"} (tentativa ${novasTentativas}/${job.max_tentativas})`);
  }
}

// ── Aquisição atômica (RPC com FOR UPDATE SKIP LOCKED no banco) ─────────────
async function claimJob() {
  const { data, error } = await supabase.rpc("claim_next_sync_job");
  if (error) {
    console.error("[worker] erro ao chamar claim_next_sync_job:", error.message);
    return null;
  }
  // claim_next_sync_job() retorna RETURNS sync_jobs (linha única). Quando
  // não há job pendente, o PostgREST NÃO serializa isso como `data === null`
  // — serializa como um objeto com todos os campos internos null (linha
  // composta NULL expandida). `id` é NOT NULL na tabela, então checar
  // data.id é o sinal confiável de "job de verdade" vs. "linha vazia".
  if (!data || data.id == null) return null;
  return data;
}

async function finalizarComErro(job, mensagem, permanente) {
  const mensagemCurta = String(mensagem).slice(0, 300);

  if (permanente) {
    // LojaIdIntegrityError (credencial/loja não resolvida) — retry não
    // resolveria nada. Marca erro direto, sem consumir tentativa.
    await supabase.from("sync_jobs").update({
      status:        "erro",
      erro_mensagem: mensagemCurta,
      heartbeat_em:  null,
    }).eq("id", job.id);
    console.error(`[worker] job ${job.id} erro PERMANENTE (sem retry): ${mensagemCurta}`);
    return;
  }

  const novasTentativas = job.tentativas + 1;
  const esgotou = novasTentativas >= job.max_tentativas;
  await supabase.from("sync_jobs").update({
    status:        esgotou ? "erro" : "pendente",
    tentativas:    novasTentativas,
    erro_mensagem: mensagemCurta,
    heartbeat_em:  null,
  }).eq("id", job.id);

  console.error(`[worker] job ${job.id} erro transitório (tentativa ${novasTentativas}/${job.max_tentativas}): ${mensagemCurta} — ${esgotou ? "esgotado, marcado como erro" : "reenfileirado"}`);
}

async function processarJob(job) {
  console.log(`[worker] job ${job.id} claimed — loja=${job.loja_id} marketplace=${job.marketplace} tipo=${job.tipo} periodo=${job.date_from}..${job.date_to}`);

  let heartbeatAtivo = true;
  const heartbeatTimer = setInterval(async () => {
    if (!heartbeatAtivo) return;
    const { error } = await supabase
      .from("sync_jobs")
      .update({ heartbeat_em: new Date().toISOString() })
      .eq("id", job.id)
      .eq("status", "rodando");
    if (error) console.error(`[worker] falha ao atualizar heartbeat do job ${job.id}:`, error.message);
  }, HEARTBEAT_INTERVAL_MS);

  try {
    const resp = await httpPostJson(
      `${BASE_URL}/api/internal/sync/executar`,
      {
        user_id:     job.user_id,
        loja_id:     job.loja_id,
        marketplace: job.marketplace,
        date_from:   job.date_from,
        date_to:     job.date_to,
        tipo:        job.tipo,
      },
      { "x-worker-secret": INTERNAL_SECRET },
      EXEC_TIMEOUT_MS
    );

    let corpo = {};
    try { corpo = JSON.parse(resp.raw); } catch { corpo = { ok: false, erro: `HTTP ${resp.status} — resposta ilegível` }; }

    if (resp.status === 200 && corpo.ok) {
      await supabase.from("sync_jobs").update({
        status:        "concluido",
        concluido_em:  new Date().toISOString(),
        erro_mensagem: null,
      }).eq("id", job.id);
      console.log(`[worker] job ${job.id} concluído — ${corpo.pedidosProcessados ?? 0} pedidos processados.`);
    } else {
      await finalizarComErro(job, corpo.erro ?? `HTTP ${resp.status}`, !!corpo.permanente);
    }
  } catch (err) {
    // Falha de rede/timeout na própria chamada HTTP — sempre transitório.
    await finalizarComErro(job, err?.message ?? "Falha de rede ao chamar rota interna", false);
  } finally {
    heartbeatAtivo = false;
    clearInterval(heartbeatTimer);
  }
}

let encerrando = false;
process.on("SIGINT",  () => { console.log("\n[worker] encerrando após o ciclo atual..."); encerrando = true; });
process.on("SIGTERM", () => { encerrando = true; });

async function main() {
  console.log(`[worker] iniciado. base=${BASE_URL} stale=${STALE_MINUTES}min heartbeat=${HEARTBEAT_INTERVAL_MS / 1000}s`);
  while (!encerrando) {
    await reclamarJobsTravados();
    const job = await claimJob();
    if (!job) {
      await new Promise(r => setTimeout(r, POLL_IDLE_MS));
      continue;
    }
    await processarJob(job);
  }
  console.log("[worker] encerrado.");
}

main().catch(err => {
  console.error("[worker] erro fatal:", err);
  process.exit(1);
});
