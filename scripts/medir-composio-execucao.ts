/**
 * MEDICAO da superficie de EXECUCAO do Composio — F7b.4.3 §2/§8.
 *
 * Instrumento, nao suite. Ele descobre a forma real antes de existir
 * codigo que dependa dela.
 *
 * ── O que ele procura, e por que ────────────────────────────────────
 *
 *   1. O endpoint v3 de executar UMA action. Nunca v1 (410), nunca SDK,
 *      nunca meta-tool universal.
 *   2. Uma action REAL com `no_auth = true` e NAO DESTRUTIVA, para provar
 *      o runtime de ponta a ponta sem conectar o Google do Rodrigo (§8).
 *   3. A forma do resultado e a forma do erro — inclusive o erro de
 *      "falta conexao", que e o que sustenta CONNECTION_REQUIRED (§7).
 *
 * Nenhum valor de credencial e impresso.
 *
 * Roda com: npx tsx scripts/medir-composio-execucao.ts
 */
import "./_server-only-inerte";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
carregarEnvLocal();

const BASE = "https://backend.composio.dev/api/v3";

function chave(): string {
  return String(process.env.COMPOSIO_API_KEY ?? "");
}

function limpar(t: string): string {
  return t
    .replace(new RegExp(chave().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "[CHAVE]")
    .replace(/(access|refresh|client_secret|api_?key|bearer)[^,}\]]{0,60}/gi, "$1=[REDIGIDO]");
}

async function pedir(metodo: string, caminho: string, corpo?: unknown) {
  const r = await fetch(`${BASE}${caminho}`, {
    method: metodo,
    headers: {
      "x-api-key": chave(),
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

function chaves(v: unknown): string {
  if (typeof v !== "object" || v === null) return String(typeof v);
  return Object.entries(v as Record<string, unknown>)
    .map(([k, val]) => `${k}:${val === null ? "null" : Array.isArray(val) ? "array" : typeof val}`)
    .join(", ");
}

async function main() {
  if (chave() === "") { console.log("COMPOSIO_API_KEY ausente."); return; }
  console.log("COMPOSIO_API_KEY: presente\n");

  // ── 1. Quais toolkits NAO exigem autenticacao ─────────────────────
  //
  // `no_auth = true` e o campo que `cliente.ts` ja le. Aqui a pergunta e
  // qual deles tem action de LEITURA util para provar o runtime.
  console.log("[1] Toolkits com no_auth = true");
  const semAuth = await pedir("GET", "/toolkits?limit=100");
  const itens = ((semAuth.json as { items?: Record<string, unknown>[] })?.items ?? [])
    .filter((t) => t.no_auth === true);
  console.log(`    status ${semAuth.status} — ${itens.length} sem auth nesta pagina`);
  for (const t of itens.slice(0, 25)) {
    console.log(`    - ${String(t.slug)}  (${String(t.name)})`);
  }

  // ── 2. As actions de alguns candidatos ────────────────────────────
  //
  // Procuramos algo deterministico e nao destrutivo: matematica, texto,
  // hash, tempo. Nada que escreva em lugar nenhum.
  const CANDIDATOS = itens.map((t) => String(t.slug)).slice(0, 12);
  console.log(`\n[2] Actions dos candidatos`);
  for (const slug of CANDIDATOS) {
    const r = await pedir("GET", `/tools?toolkit_slug=${encodeURIComponent(slug)}&limit=20`);
    const acts = (r.json as { items?: Record<string, unknown>[] })?.items ?? [];
    console.log(`    ${slug}: ${acts.length} action(s)`);
    for (const a of acts.slice(0, 8)) {
      console.log(`      · ${String(a.slug)} — ${String(a.name).slice(0, 60)}`);
    }
  }
}

if (!process.argv.includes("exec")) void main();

/**
 * SEGUNDA MEDICAO — o endpoint de execucao.
 *
 * Roda com: npx tsx scripts/medir-composio-execucao.ts exec
 */
async function medirExecucao() {
  const ACAO = "HACKERNEWS_GET_ITEM_WITH_ID";

  console.log(`\n[3] O schema de ${ACAO}`);
  const det = await pedir("GET", `/tools/${ACAO}`);
  console.log(`    status ${det.status}`);
  const d = det.json as Record<string, unknown>;
  console.log(`    chaves: ${chaves(d)}`);
  console.log(`    input_parameters: ${JSON.stringify(d?.input_parameters).slice(0, 400)}`);

  console.log(`\n[4] POST /tools/execute/${ACAO}`);
  const exec = await pedir("POST", `/tools/execute/${ACAO}`, {
    arguments: { item_id: "1" },
    user_id: "cds-medicao-f743",
  });
  console.log(`    status ${exec.status}`);
  console.log(`    chaves: ${chaves(exec.json)}`);
  console.log(`    corpo: ${limpar(exec.texto).slice(0, 700)}`);

  console.log(`\n[5] CONTROLE: acao que EXIGE conexao, sem conexao`);
  const semConexao = await pedir("POST", "/tools/execute/GOOGLESHEETS_GET_SPREADSHEET_INFO", {
    arguments: { spreadsheet_id: "nao-existe" },
    user_id: "cds-medicao-f743-sem-conexao",
  });
  console.log(`    status ${semConexao.status}`);
  console.log(`    chaves: ${chaves(semConexao.json)}`);
  console.log(`    corpo: ${limpar(semConexao.texto).slice(0, 600)}`);
}

if (process.argv.includes("exec")) void medirExecucao();
