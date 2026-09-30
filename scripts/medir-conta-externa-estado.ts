/**
 * MEDICAO — o que distingue "conexao que quebrou" de "link abandonado".
 *
 * ── Por que este script existe ──────────────────────────────────────
 *
 * O §10 pede distinguir "conecte sua conta" de "sua conexao expirou". A
 * primeira regra escrita foi: existe conta em `com_problema` -> expirou.
 * A suite live reprovou (F9) com `reconectar: true` para um dono que
 * NUNCA concluiu conexao nenhuma — so houve um link emitido e
 * abandonado, que o provedor depois marcou como EXPIRED.
 *
 * Confundir os dois faria a tela dizer "sua conexao expirou" a quem
 * nunca conectou. Antes de escolher outra regra, e preciso ver quais
 * campos o provedor publica.
 *
 * NAO imprime chave, token, `link_token` nem valor de credencial: so os
 * NOMES dos campos e os valores dos campos de ESTADO.
 *
 * Roda com: npx tsx scripts/medir-conta-externa-estado.ts
 */
import "./_server-only-inerte";

import { readFileSync } from "node:fs";
import { join } from "node:path";

function carregarEnvLocal(): void {
  for (const caminho of [
    join(__dirname, "..", ".env.local"),
    join("C:", "Users", "USER", "Desktop", "calculadora-dos-sellers-v1", ".env.local"),
  ]) {
    let texto: string;
    try { texto = readFileSync(caminho, "utf8"); } catch { continue; }
    for (const linha of texto.split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(linha);
      if (m === null) continue;
      const valor = m[2].replace(/^["']|["']$/g, "");
      if (process.env[m[1]] === undefined) process.env[m[1]] = valor;
    }
    return;
  }
}

/** Os campos que NAO podem ser impressos, por prefixo de nome. */
const SEGREDO = /token|secret|key|credential|password|auth_config|params|value/i;

async function main(): Promise<void> {
  carregarEnvLocal();
  const chave = process.env.COMPOSIO_API_KEY;
  if (!chave) { console.error("ERRO: COMPOSIO_API_KEY ausente."); process.exit(1); }

  const { principalDeConexao } = await import("../lib/agentes/composio/conexao");
  // O MESMO dono fixture da suite live — nao e conta real de ninguem.
  const DONO = "c7b00000-f747-4000-8000-0000000000d0";
  const principal = principalDeConexao(DONO);

  const r = await fetch(
    `https://backend.composio.dev/api/v3/connected_accounts?user_ids=${encodeURIComponent(principal)}`,
    { headers: { "x-api-key": chave } }
  );
  console.log(`HTTP ${r.status}`);
  const corpo = await r.json() as { items?: Record<string, unknown>[] };
  const itens = corpo.items ?? [];
  console.log(`contas do principal fixture: ${itens.length}`);

  for (const it of itens) {
    console.log("\n── conta ──");
    for (const [k, v] of Object.entries(it)) {
      if (SEGREDO.test(k)) { console.log(`  ${k}: <omitido>`); continue; }
      const texto = typeof v === "object" && v !== null
        ? JSON.stringify(v).slice(0, 140)
        : String(v);
      console.log(`  ${k}: ${texto}`);
    }
  }
}

void main();
