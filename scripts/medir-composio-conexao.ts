/**
 * MEDICAO do fluxo de conta conectada do Composio — F7b.4.2 §14/§15.
 *
 * Nao e suite: e instrumento. Ele descobre a forma real das respostas
 * antes de existir codigo que dependa delas.
 *
 * ── O que ele NAO faz, e por que ────────────────────────────────────
 *
 * §15: NAO conclui o OAuth. Ele gera o link e para ali. Concluir exigiria
 * um Google real, e o gate proibe usar o do Rodrigo.
 *
 * A identidade usada e SINTETICA e derivada no servidor. Nunca o
 * `user_id` da CDS cru — mesma regra da memoria (§17 do F7b.4).
 *
 * Nada de valor de credencial e impresso. Chave, token e segredo aparecem
 * apenas como presenca/ausencia.
 *
 * Roda com: npx tsx scripts/medir-composio-conexao.ts
 */
import "./_server-only-inerte";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Mesma leitura das outras suites live: nao ha dotenv em node_modules. */
function carregarEnvLocal(): boolean {
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
      return true;
    } catch { /* proximo */ }
  }
  return false;
}

const BASE = "https://backend.composio.dev/api/v3";
const TOOLKIT = "googlesheets";

function chave(): string | null {
  const v = process.env.COMPOSIO_API_KEY;
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/**
 * Uma frase sem nada que pareca credencial.
 *
 * Deliberadamente agressivo: qualquer valor longo de aparencia opaca sai.
 * Perder detalhe de diagnostico e melhor que imprimir segredo.
 */
function limpar(texto: string): string {
  return texto
    .replace(/[A-Za-z0-9_\-]{24,}/g, "[REDIGIDO]")
    .replace(/(access|refresh|client_secret|api_?key|token|secret)[^,}\]]{0,80}/gi,
      "$1=[REDIGIDO]");
}

async function pedir(metodo: string, caminho: string, corpo?: unknown) {
  const k = chave();
  if (k === null) return { status: 0, json: null as unknown, texto: "sem chave" };
  const r = await fetch(`${BASE}${caminho}`, {
    method: metodo,
    headers: {
      "x-api-key": k,
      Accept: "application/json",
      ...(corpo === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
  });
  const texto = await r.text();
  let json: unknown = null;
  try { json = JSON.parse(texto); } catch { /* fica null */ }
  return { status: r.status, json, texto };
}

/** As chaves de um objeto, sem valor nenhum. E a forma que interessa. */
function forma(v: unknown, prefixo = ""): string[] {
  if (typeof v !== "object" || v === null) return [];
  const linhas: string[] = [];
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const tipo = val === null ? "null" : Array.isArray(val) ? "array" : typeof val;
    linhas.push(`${prefixo}${k}: ${tipo}`);
  }
  return linhas;
}

async function main() {
  console.log(`env carregado: ${carregarEnvLocal() ? "sim" : "NAO"}`);
  if (chave() === null) {
    console.log("COMPOSIO_API_KEY ausente. Nada a medir.");
    return;
  }
  console.log("COMPOSIO_API_KEY: presente\n");

  // ── 1. O toolkit oferece auth gerenciada? ─────────────────────────
  const tk = await pedir("GET", `/toolkits/${TOOLKIT}`);
  console.log(`[1] GET /toolkits/${TOOLKIT} -> ${tk.status}`);
  const gerenciada = (tk.json as { composio_managed_auth_schemes?: unknown })
    ?.composio_managed_auth_schemes;
  console.log(`    composio_managed_auth_schemes: ${JSON.stringify(gerenciada)}`);

  // ── 2. Ja existe auth config para este toolkit? ───────────────────
  const acs = await pedir("GET", `/auth_configs?toolkit_slug=${TOOLKIT}`);
  console.log(`\n[2] GET /auth_configs -> ${acs.status}`);
  const itens = (acs.json as { items?: unknown[] })?.items ?? [];
  console.log(`    itens: ${itens.length}`);
  for (const it of itens.slice(0, 3)) {
    const o = it as Record<string, unknown>;
    console.log(`    - id=${String(o.id).slice(0, 8)}… toolkit=${String(
      (o.toolkit as Record<string, unknown> | undefined)?.slug ?? o.toolkit
    )} auth_scheme=${String(o.auth_scheme)} is_composio_managed=${String(o.is_composio_managed)}`);
  }

  // ── 3. Criar auth config GERENCIADA ───────────────────────────────
  //
  // `use_composio_managed_auth` e o ponto: sem ele, seria preciso um app
  // OAuth do Rodrigo no Google Cloud. Com ele, o app e do Composio.
  let authConfigId: string | null = itens.length > 0
    ? String((itens[0] as Record<string, unknown>).id)
    : null;

  if (authConfigId === null) {
    const criar = await pedir("POST", "/auth_configs", {
      toolkit: { slug: TOOLKIT },
      auth_config: { type: "use_composio_managed_auth" },
    });
    console.log(`\n[3] POST /auth_configs -> ${criar.status}`);
    if (criar.status >= 400) {
      console.log(`    corpo: ${limpar(criar.texto).slice(0, 400)}`);
    } else {
      const ac = (criar.json as { auth_config?: Record<string, unknown> })?.auth_config;
      console.log(`    forma:\n      ${forma(criar.json).join("\n      ")}`);
      if (ac !== undefined) console.log(`    auth_config:\n      ${forma(ac).join("\n      ")}`);
      authConfigId = ac === undefined ? null : String(ac.id);
    }
  } else {
    console.log(`\n[3] auth config JA EXISTE — nao cria outra.`);
  }
  if (authConfigId === null) { console.log("\nSem auth config. Para aqui."); return; }
  console.log(`    auth_config_id: ${authConfigId.slice(0, 8)}… (truncado)`);

  // ── 4. A identidade SINTETICA, derivada no servidor ───────────────
  //
  // Mesma forma da memoria: comprimento-prefixado antes do hash, para que
  // dois pares diferentes nao possam produzir a mesma entrada.
  const userIdFalso = "medicao-f742";
  const agenteIdFalso = "agente-de-medicao";
  const canonica = `${userIdFalso.length}:${userIdFalso}|${agenteIdFalso.length}:${agenteIdFalso}`;
  const principal = `cds-conta-v1:${createHash("sha256").update(canonica).digest("hex")}`;
  console.log(`\n[4] identidade sintetica derivada: ${principal.slice(0, 28)}…`);
  console.log(`    NAO e o user_id da CDS, e nao e reversivel.`);

  // ── 5. Criar conta conectada -> o LINK ────────────────────────────
  // MEDIDO: `POST /connected_accounts` responde 400 code 600 para auth
  // config gerenciada pelo Composio, e o proprio corpo indica o caminho:
  // "Use POST /api/v3/connected_accounts/link instead". E o endpoint de
  // LINK que existe justamente para o caso em que o app OAuth e do
  // Composio — exatamente o que o §14 pede.
  const conta = await pedir("POST", "/connected_accounts/link", {
    auth_config_id: authConfigId,
    user_id: principal,
  });
  console.log(`\n[5] POST /connected_accounts/link -> ${conta.status}`);
  if (conta.status >= 400) {
    console.log(`    corpo: ${limpar(conta.texto).slice(0, 500)}`);
    return;
  }
  console.log(`    forma:\n      ${forma(conta.json).join("\n      ")}`);
  const c = conta.json as Record<string, unknown>;
  // MEDIDO: o endpoint de link devolve `connected_account_id`, e nao `id`.
  const contaId = typeof c.connected_account_id === "string"
    ? c.connected_account_id
    : typeof c.id === "string" ? c.id : null;
  const redirect = typeof c.redirect_url === "string" ? c.redirect_url
    : typeof (c.connectionData as Record<string, unknown>)?.redirect_url === "string"
      ? String((c.connectionData as Record<string, unknown>).redirect_url) : null;
  console.log(`    status: ${String(c.status)}`);
  console.log(`    tem redirect_url: ${redirect !== null}`);
  if (redirect !== null) {
    // SO o host. A URL inteira carrega state, e state e material de sessao.
    try { console.log(`    host do link: ${new URL(redirect).host}`); } catch { /* ignora */ }
  }

  // ── 6. O estado da conta, sem concluir o OAuth (§15) ──────────────
  if (contaId !== null) {
    const ler = await pedir("GET", `/connected_accounts/${contaId}`);
    console.log(`\n[6] GET /connected_accounts/{id} -> ${ler.status}`);
    const o = ler.json as Record<string, unknown>;
    console.log(`    status: ${String(o?.status)}`);
    console.log(`    forma:\n      ${forma(ler.json).join("\n      ")}`);
    // A pergunta do §14: o corpo devolve segredo?
    const cru = JSON.stringify(ler.json ?? {});
    const suspeito = /access_token|refresh_token|client_secret|"token"/i.test(cru);
    console.log(`\n    O CORPO CONTEM CAMPO DE TOKEN? ${suspeito ? "SIM" : "nao"}`);
    console.log(`    (se SIM, o servidor NUNCA repassa este corpo ao browser)`);

    console.log(`\n[7] LIMPEZA: apagando a conta de medicao`);
    const del = await pedir("DELETE", `/connected_accounts/${contaId}`);
    console.log(`    DELETE -> ${del.status}`);
  }
}

void main();
