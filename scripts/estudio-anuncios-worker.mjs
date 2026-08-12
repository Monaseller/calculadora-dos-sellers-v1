#!/usr/bin/env node
/**
 * Worker do Estúdio de Anúncios. Roda 1 única vez, reivindica no
 * máximo 1 job, e encerra. Sem loop infinito, sem heartbeat, sem retry
 * interno — retry continua sendo decisão do banco/aplicação via um
 * novo claim posterior (nova execução deste script), nunca deste
 * processo.
 *
 * AJUSTE (2026-08-06 — integração funcional): deixou de ser restrito à
 * etapa "ping" — agora processa qualquer etapa que a rota interna
 * aceitar (as 7 etapas reais do fluxo obrigatório da Fase 1 + "ping").
 * O worker continua SEM saber disso — só reivindica, chama a rota, e
 * reporta o resultado. Quem decide se a etapa é suportada é a rota/
 * executor, nunca este script.
 *
 * Mesma técnica de scripts/sync-worker.mjs: claim atômico via RPC
 * (FOR UPDATE SKIP LOCKED + incremento de tentativas dentro da própria
 * função claim_next_estudio_anuncios_job()), depois chama a rota
 * interna via HTTP puro (nunca importa .ts diretamente — não há
 * tsx/ts-node neste projeto).
 *
 * Variáveis de ambiente necessárias:
 *   NEXT_PUBLIC_SUPABASE_URL                 (já existe em .env.local)
 *   SUPABASE_SERVICE_ROLE_KEY                (já existe em .env.local)
 *   ESTUDIO_ANUNCIOS_WORKER_INTERNAL_SECRET  (já documentada em
 *     .env.example desde 2026-08-04. Defina o valor real em .env.local
 *     com qualquer string aleatória, IDÊNTICA à usada por
 *     app/api/internal/estudio-anuncios/executar/route.ts — que lê a
 *     mesma variável.)
 *   ESTUDIO_ANUNCIOS_WORKER_BASE_URL         (opcional, default
 *     http://127.0.0.1:3000)
 *   ESTUDIO_ANUNCIOS_WORKER_HTTP_TIMEOUT_MS  (opcional, default 120000
 *     — ver lerTimeoutHttpWorker() abaixo. Substitui o antigo timeout
 *     fixo de 30000ms, que causava falso-negativo: a rota interna
 *     terminava de processar o job com sucesso DEPOIS que o worker já
 *     tinha desistido de esperar e reportado falha. O worker nunca
 *     decide se o job falhou por esse timeout — só para de esperar e
 *     encerra com código de erro; a rota continua sendo a única
 *     autoridade sobre o status real do job no banco.)
 *
 * Uso: node scripts/estudio-anuncios-worker.mjs
 * (requer `npm run dev` ou `next start` já rodando)
 */
import { createClient } from "@supabase/supabase-js";
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

const SUPABASE_URL     = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const INTERNAL_SECRET  = process.env.ESTUDIO_ANUNCIOS_WORKER_INTERNAL_SECRET;
const BASE_URL         = process.env.ESTUDIO_ANUNCIOS_WORKER_BASE_URL || "http://127.0.0.1:3000";

for (const [nome, valor] of [
  ["NEXT_PUBLIC_SUPABASE_URL", SUPABASE_URL],
  ["SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY],
  ["ESTUDIO_ANUNCIOS_WORKER_INTERNAL_SECRET", INTERNAL_SECRET],
]) {
  if (!valor) {
    console.error(`ERRO: variável de ambiente ${nome} ausente. Defina em .env.local ou exporte antes de rodar.`);
    process.exit(1);
  }
}

// Ambas as constantes abaixo são independentes do resto do arquivo —
// nunca dependem de nenhum handle assíncrono já aberto (rodam antes de
// createClient() e de qualquer request HTTP), então process.exit(1)
// aqui é seguro (sem risco do aviso de libuv no Windows que motivou a
// troca para process.exitCode nos outros pontos deste arquivo — ver
// comentário mais abaixo).
const TIMEOUT_HTTP_WORKER_MS_PADRAO = 120_000;
const TIMEOUT_HTTP_WORKER_MS_TETO   = 600_000;

/**
 * Lê e valida ESTUDIO_ANUNCIOS_WORKER_HTTP_TIMEOUT_MS. Nunca cai
 * silenciosamente para o padrão quando o valor está PRESENTE mas é
 * inválido — só usa o padrão quando a variável está genuinamente
 * ausente/vazia. Mensagens de erro citam só o nome da variável e o
 * valor recebido, nunca nenhum outro segredo do processo.
 */
function lerTimeoutHttpWorker() {
  const bruto = process.env.ESTUDIO_ANUNCIOS_WORKER_HTTP_TIMEOUT_MS;
  if (bruto === undefined || bruto.trim() === "") {
    return TIMEOUT_HTTP_WORKER_MS_PADRAO;
  }
  const valor = bruto.trim();
  if (!/^\d+$/.test(valor)) {
    throw new Error(
      `ESTUDIO_ANUNCIOS_WORKER_HTTP_TIMEOUT_MS inválido ("${valor}") — precisa ser um número inteiro positivo em milissegundos.`
    );
  }
  const n = Number(valor);
  if (n <= 0) {
    throw new Error(`ESTUDIO_ANUNCIOS_WORKER_HTTP_TIMEOUT_MS inválido (${n}) — precisa ser maior que zero.`);
  }
  if (n > TIMEOUT_HTTP_WORKER_MS_TETO) {
    throw new Error(
      `ESTUDIO_ANUNCIOS_WORKER_HTTP_TIMEOUT_MS inválido (${n}) — acima do teto máximo seguro de ${TIMEOUT_HTTP_WORKER_MS_TETO}ms.`
    );
  }
  return n;
}

let TIMEOUT_HTTP_WORKER_MS;
try {
  TIMEOUT_HTTP_WORKER_MS = lerTimeoutHttpWorker();
} catch (err) {
  console.error(`ERRO: ${err.message}`);
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

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

// Aquisição atômica — a própria função no banco incrementa `tentativas`
// e marca status='rodando' dentro da mesma transação (ver migration).
async function claimJob() {
  const { data, error } = await supabase.rpc("claim_next_estudio_anuncios_job");
  if (error) {
    console.error("[estudio-anuncios-worker] erro ao chamar claim_next_estudio_anuncios_job:", error.message);
    return null;
  }
  // Mesmo cuidado de scripts/sync-worker.mjs: quando não há job pendente,
  // o PostgREST serializa como linha composta NULL expandida, não
  // literalmente `null` — checar `data.id` é o sinal confiável.
  if (!data || data.id == null) return null;
  return data;
}

async function main() {
  console.log(`[estudio-anuncios-worker] iniciado (execução única). base=${BASE_URL}`);

  const job = await claimJob();
  if (!job) {
    console.log("[estudio-anuncios-worker] nenhum job pendente encontrado. Encerrando.");
    // process.exitCode (não process.exit()): claimJob() já fez uma
    // chamada real via supabase.rpc() antes deste ponto, então pode
    // haver handles de rede abertos/fechando em segundo plano. Deixar
    // o processo terminar sozinho evita o encerramento abrupto que
    // gerava o aviso "Assertion failed: !(handle->flags &
    // UV_HANDLE_CLOSING)" no Windows. Isso NUNCA reagenda trabalho —
    // process.exitCode só define o código de saída eventual, não tem
    // nenhum efeito sobre o que o script ainda vai executar.
    process.exitCode = 0;
    return;
  }

  // Nunca registrar prompt/segredo/payload — só o mínimo para
  // acompanhar a execução.
  console.log(`[estudio-anuncios-worker] job ${job.id} reivindicado — etapa=${job.etapa} tentativa=${job.tentativas}/${job.max_tentativas}`);

  let resp;
  try {
    resp = await httpPostJson(
      `${BASE_URL}/api/internal/estudio-anuncios/executar`,
      { job_id: job.id },
      { "x-worker-secret": INTERNAL_SECRET },
      TIMEOUT_HTTP_WORKER_MS
    );
  } catch (err) {
    // Falha de rede OU timeout de espera pela rota interna (ver
    // TIMEOUT_HTTP_WORKER_MS acima) ANTES de a rota terminar de
    // processar o job — sem retry oculto, sem criar job novo, sem
    // alterar o job manualmente (ele pode continuar "rodando" no banco
    // mesmo que a rota já tenha terminado com sucesso depois deste
    // ponto; a rota é a única autoridade sobre o status real do job —
    // este script NUNCA classifica isso como falha definitiva, só para
    // de esperar e encerra com código de erro). Próxima ação sobre o
    // job é decisão manual/de reconciliação, não deste script.
    console.error(
      `[estudio-anuncios-worker] falha ao chamar rota interna (timeout configurado=${TIMEOUT_HTTP_WORKER_MS}ms):`,
      err?.message ?? "erro desconhecido"
    );
    process.exitCode = 1;
    return;
  }

  let corpo = {};
  try { corpo = JSON.parse(resp.raw); } catch { corpo = { ok: false, erro: `HTTP ${resp.status} — resposta ilegível` }; }

  if (resp.status === 200 && corpo.ok) {
    console.log(
      `[estudio-anuncios-worker] job ${job.id} concluído — etapa=${corpo.job?.etapa} provedor=${corpo.provedor} modelo=${corpo.modelo} tempoMs=${corpo.tempoMs} pipeline.status=${corpo.pipeline?.status} pipeline.concluido=${corpo.pipeline?.concluido}`
    );
    console.log("[estudio-anuncios-worker] encerrado (execução única, sem loop).");
    process.exitCode = 0;
    return;
  }

  console.error(`[estudio-anuncios-worker] job ${job.id} NÃO concluído com sucesso — HTTP ${resp.status}:`, corpo.erro ?? "(sem mensagem)");
  console.log("[estudio-anuncios-worker] encerrado (execução única, sem loop).");
  process.exitCode = 1;
}

// process.exitCode (não process.exit()) nos 5 pontos de saída dentro/
// depois de main(): todos ocorrem depois que a chamada a
// supabase.rpc() e/ou a requisição HTTP a httpPostJson() já rodaram, ou
// seja, com handles de rede potencialmente ainda fechando em segundo
// plano — usar process.exit() ali força o encerramento imediato do
// processo antes desses handles fecharem sozinhos, o que é a causa mais
// provável do aviso "Assertion failed: !(handle->flags &
// UV_HANDLE_CLOSING)" já observado no Windows. process.exitCode apenas
// define o código de saída que o processo usará quando o event loop
// esvaziar naturalmente — não agenda nem impede nenhum trabalho, então
// não há risco do script "continuar processando jobs"; ele só demora,
// na pior hipótese, alguns milissegundos a mais para encerrar sozinho
// (validado no teste funcional). Os 2 usos de process.exit(1) que
// permanecem no arquivo (checagem de env vars no topo, antes de
// createClient() e antes de qualquer handle existir) foram
// deliberadamente mantidos como estão — não há benefício em trocá-los.
main().catch(err => {
  console.error("[estudio-anuncios-worker] erro fatal:", err);
  process.exitCode = 1;
});
