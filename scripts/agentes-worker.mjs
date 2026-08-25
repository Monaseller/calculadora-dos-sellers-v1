#!/usr/bin/env node
/**
 * Worker de AGENTES — AGENTES-FASE1C.
 *
 * Uso:  node scripts/agentes-worker.mjs      (exige `npm run dev` rodando)
 *
 * ── TOTALMENTE SEPARADO do worker do Estudio ────────────────────────
 * Nao compartilha arquivo, nao compartilha segredo, nao compartilha
 * rota, nao compartilha RPC. O motivo e concreto: o worker do Estudio
 * carrega a service_role e conversa com uma rota que valida ~15
 * coerencias entre job, pipeline e catalogo. Um `if` no topo decidindo
 * o dominio faria com que um bug no caminho de agentes pudesse derrubar
 * um job do Estudio no meio do pipeline — que e justamente o cenario
 * caro de recuperar la.
 *
 * ── EXECUCAO UNICA POR INVOCACAO ────────────────────────────────────
 * Sem loop. Sem cron. Sem retry interno. Reivindica UMA tarefa, manda
 * executar, imprime o desfecho e encerra. Cada ciclo exige uma nova
 * chamada manual — mesma regra do worker do Estudio, e pelo mesmo
 * motivo: um processo que se auto-realimenta sem supervisao e a forma
 * mais facil de consumir uma fila inteira com um handler quebrado.
 *
 * Retry NAO e decisao deste script: e do banco, via
 * `tentativas`/`max_tentativas` no claim.
 *
 * ── NUNCA importa `.ts` ─────────────────────────────────────────────
 * Fala com a aplicacao SO por HTTP. A unica excecao e o claim, que e
 * uma RPC chamada direto no Supabase com service_role — igual ao worker
 * do Estudio.
 *
 * ── AT-LEAST-ONCE ───────────────────────────────────────────────────
 * Se este processo morrer com a tarefa em `rodando`, o claim de outra
 * invocacao a ressuscita depois de 5 minutos sem heartbeat. Isso pode
 * significar execucao DUPLA. Ver `20260917_agentes_execucao.sql`,
 * secao 4: todo handler precisa ser idempotente.
 */
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function carregarEnvLocal() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, "..", ".env.local"), "utf-8");
    for (const linha of raw.split("\n")) {
      const l = linha.trim();
      if (!l || l.startsWith("#")) continue;
      const i = l.indexOf("=");
      if (i === -1) continue;
      const chave = l.slice(0, i).trim();
      let valor = l.slice(i + 1).trim();
      if ((valor.startsWith('"') && valor.endsWith('"')) || (valor.startsWith("'") && valor.endsWith("'"))) {
        valor = valor.slice(1, -1);
      }
      if (!(chave in process.env)) process.env[chave] = valor;
    }
  } catch {
    // .env.local ausente/ilegivel — segue com o que ja estiver no ambiente
  }
}
carregarEnvLocal();

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const INTERNAL_SECRET = process.env.AGENTES_WORKER_INTERNAL_SECRET;
const BASE_URL = process.env.AGENTES_WORKER_BASE_URL || "http://localhost:3000";

/** Padrao e teto do timeout HTTP. O teto existe para que um valor
 *  absurdo nao transforme o worker num processo que nunca desiste. */
const TIMEOUT_HTTP_PADRAO_MS = 60000;
const TIMEOUT_HTTP_TETO_MS = 600000;

/**
 * Le e VALIDA `AGENTES_WORKER_HTTP_TIMEOUT_MS`.
 *
 * Ausente -> padrao. Presente mas invalido (nao-numerico, NaN,
 * Infinity, <= 0, ou acima do teto) -> padrao COM AVISO. Nunca um
 * `NaN` silencioso: `Number("abc")` e NaN, e `AbortController` com
 * `setTimeout(NaN)` dispara IMEDIATAMENTE — o worker abortaria toda
 * chamada no ato e reportaria falha de rede que nao existiu.
 */
function lerTimeoutHttp() {
  const bruto = process.env.AGENTES_WORKER_HTTP_TIMEOUT_MS;
  if (bruto === undefined || bruto === null || String(bruto).trim() === "") {
    return TIMEOUT_HTTP_PADRAO_MS;
  }
  const valor = Number(bruto);
  if (!Number.isFinite(valor) || valor <= 0 || valor > TIMEOUT_HTTP_TETO_MS) {
    // Imprime o NOME da variavel e o teto, nunca conteudo sensivel.
    console.warn(
      `[agentes-worker] AGENTES_WORKER_HTTP_TIMEOUT_MS invalido (esperado inteiro > 0 e <= ${TIMEOUT_HTTP_TETO_MS}). Usando o padrao ${TIMEOUT_HTTP_PADRAO_MS}ms.`
    );
    return TIMEOUT_HTTP_PADRAO_MS;
  }
  return Math.trunc(valor);
}

const TIMEOUT_HTTP_MS = lerTimeoutHttp();

// Fail-closed. Imprime o NOME da variavel ausente, jamais o valor de
// qualquer uma delas.
for (const [nome, valor] of [
  ["NEXT_PUBLIC_SUPABASE_URL", SUPABASE_URL],
  ["SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY],
  ["AGENTES_WORKER_INTERNAL_SECRET", INTERNAL_SECRET],
]) {
  if (!valor) {
    console.error(`[agentes-worker] ERRO: ${nome} ausente (defina em .env.local).`);
    process.exit(1);
  }
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

async function httpPostJson(url, corpo, headers, timeoutMs) {
  const controlador = new AbortController();
  const timer = setTimeout(() => controlador.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(corpo),
      signal: controlador.signal,
    });
    return { status: resp.status, raw: await resp.text() };
  } finally {
    clearTimeout(timer);
  }
}

async function reivindicarTarefa() {
  const { data, error } = await supabase.rpc("claim_next_agente_tarefa");
  if (error) {
    console.error("[agentes-worker] erro ao chamar claim_next_agente_tarefa:", error.message);
    return null;
  }
  // A RPC devolve `RETURNS public.agente_tarefas`: objeto ou array de 1,
  // conforme a versao do PostgREST.
  const linha = Array.isArray(data) ? data[0] : data;
  return linha && linha.id ? linha : null;
}

async function main() {
  const tarefa = await reivindicarTarefa();

  if (!tarefa) {
    console.log("[agentes-worker] nenhuma tarefa elegivel na fila. Encerrado.");
    // process.exitCode, nao process.exit(): a chamada RPC acima ja
    // aconteceu e o cliente pode ter trabalho pendente de finalizar.
    process.exitCode = 0;
    return;
  }

  // Nunca registrar `entrada`, `resultado`, segredo ou payload — so o
  // minimo para acompanhar a execucao.
  console.log(
    `[agentes-worker] tarefa ${tarefa.id} reivindicada — tipo=${tarefa.tipo} tentativa=${tarefa.tentativas}/${tarefa.max_tentativas}`
  );

  let resp;
  try {
    resp = await httpPostJson(
      `${BASE_URL}/api/internal/agentes/executar`,
      { tarefa_id: tarefa.id },
      { "x-worker-secret": INTERNAL_SECRET },
      TIMEOUT_HTTP_MS
    );
  } catch (err) {
    // Falha de rede OU timeout ANTES de a rota responder. Sem retry
    // oculto, sem criar tarefa nova, sem alterar o estado a mao: a rota
    // e a unica autoridade sobre o desfecho real, e ela pode ter
    // concluido com sucesso depois deste ponto. Se de fato ficou
    // orfa, o claim a devolve a fila em 5 minutos.
    console.error(
      `[agentes-worker] falha ao chamar a rota interna (timeout=${TIMEOUT_HTTP_MS}ms):`,
      err?.message ?? "erro desconhecido"
    );
    process.exitCode = 1;
    return;
  }

  let corpo = {};
  try {
    corpo = JSON.parse(resp.raw);
  } catch {
    corpo = { ok: false, erro: `HTTP ${resp.status} — resposta ilegivel` };
  }

  if (resp.status === 200 && corpo.ok === true) {
    console.log(
      `[agentes-worker] tarefa ${tarefa.id} CONCLUIDA — status=${corpo.status} tempoMs=${corpo.tempoMs}`
    );
    console.log("[agentes-worker] encerrado (execucao unica, sem loop).");
    process.exitCode = 0;
    return;
  }

  if (resp.status === 200 && corpo.ok === false) {
    // O handler falhou, mas o banco REGISTROU a falha. Distinguir isto
    // de "nao consegui nem registrar" e o motivo de a rota devolver 200
    // com ok:false neste caso.
    console.error(
      `[agentes-worker] tarefa ${tarefa.id} FALHOU — status=${corpo.status} erroTipo=${corpo.erroTipo}`
    );
    console.error(
      corpo.status === "pendente"
        ? "[agentes-worker] devolvida a fila (ainda ha tentativas)."
        : "[agentes-worker] encerrada em erro (tentativas esgotadas)."
    );
    process.exitCode = 1;
    return;
  }

  console.error(
    `[agentes-worker] tarefa ${tarefa.id} NAO processada — HTTP ${resp.status}:`,
    corpo.erro ?? "(sem mensagem)"
  );
  process.exitCode = 1;
}

main().catch((err) => {
  // Nunca imprimir o objeto inteiro: ele carrega URL e headers.
  console.error("[agentes-worker] erro nao tratado:", err?.message ?? "desconhecido");
  process.exitCode = 1;
});
